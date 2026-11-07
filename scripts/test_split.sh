#!/usr/bin/env bash
# Split feature tests. Server must be up on 8123. Cleans up its fixture request.
set -u; B=http://localhost:8123; PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

R=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split","due":"2026-11-10","clients":["x"]}')
SLUG=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
TOKEN=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$SLUG?filename=s01_lidl.png&uploader=t" --data-binary @scripts/samples/s01_lidl.png >/dev/null
for i in $(seq 1 40); do
  sleep 2
  ST=$(curl -s $B/api/owner/$TOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])")
  [ "$ST" != "processing" ] && break
done
UPID=$(curl -s $B/api/owner/$TOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")

# 1. item extraction vs ground truth
curl -s $B/api/split/$TOKEN/$UPID > /tmp/split.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/split.json'))
gt = json.load(open('scripts/samples/split_manifest.json'))['ground_truth'][0]
got = {i['name']: (i['qty'], i['cents']) for i in d['items']}
want = {i['name']: (i['qty'], i['cents']) for i in gt['items']}
assert d['receiptCents'] == gt['total_cents'], (d['receiptCents'], gt['total_cents'])
assert got == want, {'got': got, 'want': want}
assert d['sumMatchesReceipt'] is True
print('items ok:', len(got), 'items, total cents', d['receiptCents'])
PY
[ $? = 0 ] && ok "item extraction matches ground truth incl. negative discount" || bad "item extraction"

curl -s $B/api/owner/$TOKEN | python3 -c "
import sys,json; o=json.load(sys.stdin)['uploads'][0]['ocr']
assert o['total_conf']=='high', o" && ok "dedicated TOTAL line stays high confidence" || bad "strict total regression"

# 2. mixed assignment: milk->Niamh, pizza->Alex+Niamh shared, rest unassigned
IID=$(python3 -c "
import json; d=json.load(open('/tmp/split.json'))
m={i['name']:i['id'] for i in d['items']}
print(json.dumps({'milk':m['Whole milk 2L'],'pizza':m['Pizza Margherita']}))")
MILK=$(echo "$IID" | python3 -c "import sys,json;print(json.load(sys.stdin)['milk'])")
PIZZA=$(echo "$IID" | python3 -c "import sys,json;print(json.load(sys.stdin)['pizza'])")
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d "{
  \"names\":[\"Alex\",\"Niamh\",\"Sean\"],\"payer\":\"Alex\",
  \"assignments\":{\"$MILK\":[\"Niamh\"],\"$PIZZA\":[\"Alex\",\"Niamh\"]}}" > /tmp/split2.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/split2.json'))['computed']
per = d['perPerson']
# pizza 249c over [Alex, Niamh]: remainder cent to first assignee -> Alex 125, Niamh 124
assert per['Niamh'] == 310 + 124, per
assert per['Alex'] == 125, per
assert per['Sean'] == 0, per
assert d['unassignedCents'] == 189 + 129 + 89 - 60, d  # bread+bananas+choc+discount = 347
print('mixed ok:', per, 'unassigned cents', d['unassignedCents'])
PY
[ $? = 0 ] && ok "mixed solo+shared assignment correct to the cent, remainder deterministic" || bad "mixed assignment"

# 3. export blocked while items unassigned
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 409 ] && ok "split CSV blocked (409) with unassigned items" || bad "split CSV gate ($CODE)"

# 3b. discount assigned alone to one person -> save rejected with reallocation guidance
DISC=$(python3 -c "import json;print([i['id'] for i in json.load(open('/tmp/split.json'))['items'] if i['cents']<0][0])")
python3 -c "
import json
json.dump({'names':['Alex','Niamh','Sean'],'assignments':{'$DISC':['Sean']}}, open('/tmp/neg-body.json','w'))
"
CODE=$(curl -s -o /tmp/neg.json -w '%{http_code}' -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d @/tmp/neg-body.json)
[ "$CODE" = 400 ] && grep -q 'Reassign' /tmp/neg.json && ok "discount-only assignment rejected, reallocation guidance given" || bad "negative-share rejection ($CODE)"
# state must be unchanged after rejection (previous mixed assignment intact)
curl -s $B/api/split/$TOKEN/$UPID | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['split']['assignments'].get('$DISC') is None or 'Sean' not in d['split']['assignments'].get('$DISC', []), d['split']
print('state intact')" >/dev/null && ok "rejected save did not persist" || bad "rejected save persisted"

# 3c. edited line price breaks receipt match -> export blocked; restore -> exports
python3 -c "
import json
json.dump({'names':['Alex','Niamh','Sean'],'payer':'Alex','equalAll':True,'items':[{'id':'$MILK','cents':250}]}, open('/tmp/edit-body.json','w'))
"
CODE=$(curl -s -o /tmp/edit.json -w '%{http_code}' -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d @/tmp/edit-body.json)
[ "$CODE" = 200 ] || bad "price edit save failed ($CODE)"
python3 -c "
import json; d=json.load(open('/tmp/edit.json'))
assert d['sumMatchesReceipt'] is False, d['sumMatchesReceipt']
assert d['computed']['perPerson'] == {'Alex': 282, 'Niamh': 282, 'Sean': 282}, d['computed']" && ok "edited line total recomputes (846c/3=282 each), mismatch flagged" || bad "price edit recompute"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 409 ] && ok "split CSV blocked (409) while items mismatch receipt total" || bad "mismatch export gate ($CODE)"
python3 -c "
import json
json.dump({'names':['Alex','Niamh','Sean'],'payer':'Alex','equalAll':True,'items':[{'id':'$MILK','cents':310}]}, open('/tmp/restore-body.json','w'))
"
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d @/tmp/restore-body.json >/dev/null

# 4. equal split of whole bill: 906c over 3 people = 302 each, reconciles to receipt
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d '{"names":["Alex","Niamh","Sean"],"payer":"Niamh","assignments":{},"equalAll":true}' > /tmp/split3.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/split3.json'))
c = d['computed']
assert sum(c['perPerson'].values()) == 906 == c['totalCents'], c
assert c['perPerson'] == {'Alex': 302, 'Niamh': 302, 'Sean': 302}, c
assert c['payer'] == 'Niamh'
assert d['sumMatchesReceipt'] is True
print('equal ok:', c['perPerson'])
PY
[ $? = 0 ] && ok "equal split reconciles exactly to receipt total (302/302/302)" || bad "equal split"
CODE=$(curl -s -o /tmp/presplit.csv -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 409 ] && grep -q 'not confirmed' /tmp/presplit.csv && ok "export blocked (409) before total/completeness confirmation" || bad "pre-confirmation export gate ($CODE)"
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d '{"names":["Alex","Niamh","Sean"],"payer":"Niamh","assignments":{},"equalAll":true,"confirm":true}' > /tmp/split3c.json
python3 -c "
import json; d=json.load(open('/tmp/split3c.json'))
assert d['confirmed'] is True and d['staleConfirmation'] is False, d" && ok "confirmation accepted, state confirmed" || bad "confirmation save"
CODE=$(curl -s -o /tmp/split.csv -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 200 ] && ok "split CSV exports once fully assigned AND confirmed" || bad "split CSV export ($CODE)"
grep -q 'matches receipt total' /tmp/split.csv && ok "CSV carries reconciliation status" || bad "CSV reconciliation row"

# 4b. edit after confirmation (rename, same cents): sums still match but export blocked until re-confirmed
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d "{\"names\":[\"Alex\",\"Niamh\",\"Sean\"],\"payer\":\"Niamh\",\"equalAll\":true,\"items\":[{\"id\":\"$MILK\",\"name\":\"Whole milk 2L (renamed)\"}]}" > /tmp/edit2.json
python3 -c "
import json; d=json.load(open('/tmp/edit2.json'))
assert d['confirmed'] is False and d['staleConfirmation'] is True, d
assert d['sumMatchesReceipt'] is True, d['sumMatchesReceipt']" && ok "post-confirmation edit: sums still match but confirmation stale" || bad "stale-after-edit"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 409 ] && ok "export blocked (409) after post-confirmation edit" || bad "post-edit export gate ($CODE)"
curl -s -X POST $B/api/split/$TOKEN/$UPID -H 'Content-Type: application/json' -d '{"names":["Alex","Niamh","Sean"],"payer":"Niamh","equalAll":true,"confirm":true}' > /tmp/reconf.json
python3 -c "import json; d=json.load(open('/tmp/reconf.json')); assert d['confirmed'] is True, d" && ok "re-confirmation restores exportability" || bad "re-confirmation"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$TOKEN/$UPID)
[ "$CODE" = 200 ] && ok "export works after re-confirmation" || bad "export after re-confirmation ($CODE)"

# 5. remainder distribution: 3-person share of 1.00 -> 34/33/33 in name order
R2=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split2","due":"2026-11-10","clients":["x"]}')
S2=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
T2=$(echo "$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$S2?filename=s02_dunnes.png&uploader=t" --data-binary @scripts/samples/s02_dunnes.png >/dev/null
for i in $(seq 1 40); do sleep 2; ST=$(curl -s $B/api/owner/$T2 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])"); [ "$ST" != "processing" ] && break; done
U2=$(curl -s $B/api/owner/$T2 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
CRISPS=$(curl -s $B/api/split/$T2/$U2 | python3 -c "import sys,json;print([i['id'] for i in json.load(sys.stdin)['items'] if i['name']=='Crisps multipack'][0])")
# crisps 320c over 3 -> 107/107/106
curl -s -X POST $B/api/split/$T2/$U2 -H 'Content-Type: application/json' -d "{\"names\":[\"A\",\"B\",\"C\"],\"assignments\":{\"$CRISPS\":[\"A\",\"B\",\"C\"]}}" > /tmp/split4.json
python3 - <<'PY'
import json
per = json.load(open('/tmp/split4.json'))['computed']['perPerson']
assert per == {'A': 107, 'B': 107, 'C': 106}, per
print('remainder ok:', per)
PY
[ $? = 0 ] && ok "cent remainder distributed deterministically (107/107/106)" || bad "remainder distribution"

# 6. false-match trap: one 1.79 item + TOTAL SAVINGS 1.79, no real TOTAL line.
# Sums match by accident; total must be low-confidence and export must wait for human confirmation.
R3=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split3","clients":["x"]}')
S3=$(echo "$R3" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
T3=$(echo "$R3" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$S3?filename=s03_savings.png&uploader=t" --data-binary @scripts/samples/s03_savings.png >/dev/null
for i in $(seq 1 40); do sleep 2; ST=$(curl -s $B/api/owner/$T3 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])"); [ "$ST" != "processing" ] && break; done
U3=$(curl -s $B/api/owner/$T3 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
curl -s $B/api/owner/$T3 | python3 -c "
import sys, json
o = json.load(sys.stdin)['uploads'][0]['ocr']
assert o['total'] == 1.79 and o['total_conf'] == 'low', o" && ok "TOTAL SAVINGS never becomes a confident total (1.79, low)" || bad "trap total confidence"
curl -s $B/api/split/$T3/$U3 > /tmp/trap.json
python3 -c "
import json; d=json.load(open('/tmp/trap.json'))
assert d['sumMatchesReceipt'] is True and d['confirmed'] is False, d" >/dev/null || bad "trap precondition"
CR=$(python3 -c "import json;print(json.load(open('/tmp/trap.json'))['items'][0]['id'])")
curl -s -X POST $B/api/split/$T3/$U3 -H 'Content-Type: application/json' -d "{\"names\":[\"A\"],\"payer\":\"A\",\"assignments\":{\"$CR\":[\"A\"]}}" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$T3/$U3)
[ "$CODE" = 409 ] && ok "false-match split: export blocked (409) despite matching sums" || bad "false-match export gate ($CODE)"
curl -s -X POST $B/api/split/$T3/$U3 -H 'Content-Type: application/json' -d "{\"names\":[\"A\"],\"payer\":\"A\",\"assignments\":{\"$CR\":[\"A\"]},\"confirm\":true}" > /tmp/trapc.json
python3 -c "import json; d=json.load(open('/tmp/trapc.json')); assert d['confirmed'] is True, d" >/dev/null \
 && CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$T3/$U3) && [ "$CODE" = 200 ] \
 && ok "human confirmation unblocks the matching-sums export" || bad "confirm then export"

# 7. no TOTAL line at all: no confident total; human enters it via review, then confirm.
R4=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split4","clients":["x"]}')
S4=$(echo "$R4" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
T4=$(echo "$R4" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$S4?filename=s04_nototal.png&uploader=t" --data-binary @scripts/samples/s04_nototal.png >/dev/null
for i in $(seq 1 40); do sleep 2; ST=$(curl -s $B/api/owner/$T4 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])"); [ "$ST" != "processing" ] && break; done
U4=$(curl -s $B/api/owner/$T4 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
curl -s $B/api/owner/$T4 | python3 -c "
import sys, json
o = json.load(sys.stdin)['uploads'][0]['ocr']
assert o['total_conf'] == 'low', o" && ok "no TOTAL line yields no confident total" || bad "no-total confidence"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$T4/$U4)
[ "$CODE" = 409 ] && ok "no-TOTAL receipt: export blocked (409) while fallback total mismatches" || bad "no-total mismatch gate ($CODE)"
curl -s -X POST $B/api/review/$T4/$U4 -H 'Content-Type: application/json' -d '{"total":3.00,"reviewed":true}' >/dev/null
curl -s $B/api/split/$T4/$U4 > /tmp/nt.json
python3 -c "
import json; d=json.load(open('/tmp/nt.json'))
assert d['sumMatchesReceipt'] is True and d['totalSource'] == 'entered by a person', d" && ok "human-entered total reconciles, source labeled" || bad "human total reconcile"
python3 -c "
import json
d = json.load(open('/tmp/nt.json'))
asg = {i['id']: ['A'] for i in d['items']}
json.dump({'names':['A'],'payer':'A','assignments':asg}, open('/tmp/nt-body.json','w'))"
curl -s -X POST $B/api/split/$T4/$U4 -H 'Content-Type: application/json' -d @/tmp/nt-body.json >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$T4/$U4)
[ "$CODE" = 409 ] && ok "reconciled via human total: export still blocked (409) until confirmed" || bad "no-total pre-confirm gate ($CODE)"
python3 -c "
import json
b = json.load(open('/tmp/nt-body.json')); b['confirm'] = True
json.dump(b, open('/tmp/nt-body.json','w'))"
curl -s -X POST $B/api/split/$T4/$U4 -H 'Content-Type: application/json' -d @/tmp/nt-body.json > /tmp/ntc.json
python3 -c "import json; d=json.load(open('/tmp/ntc.json')); assert d['confirmed'] is True, d" >/dev/null \
 && CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/split-csv/$T4/$U4) && [ "$CODE" = 200 ] \
 && ok "no-TOTAL receipt exports after human total + confirmation" || bad "no-total confirm export"

# 8. edge-case parsing: comma decimals, VAT band letters, qty continuation line, negative discount
R5=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split5","clients":["x"]}')
S5=$(echo "$R5" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
T5=$(echo "$R5" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$S5?filename=s05_edge.png&uploader=t" --data-binary @scripts/samples/s05_edge.png >/dev/null
for i in $(seq 1 40); do sleep 2; ST=$(curl -s $B/api/owner/$T5 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])"); [ "$ST" != "processing" ] && break; done
U5=$(curl -s $B/api/owner/$T5 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
curl -s $B/api/split/$T5/$U5 | python3 -c "
import sys, json
d = json.load(sys.stdin)
got = [(i['name'], i['qty'], i['cents']) for i in d['items']]
want = [('Coffee 250g', 1, 185), ('Orange juice', 2, 598), ('Multibuy discount', 1, -60), ('Yogurt 4pk', 1, 120), ('Bread 800g', 1, 129)]
assert got == want, {'got': got, 'want': want}
assert d['receiptCents'] == 972 and d['sumMatchesReceipt'] is True, d['receiptCents']
byname = {i['name']: i for i in d['items']}
assert not (byname['Bread 800g'].get('warn')), byname['Bread 800g']  # fused band letter is a clean read
assert not (byname['Coffee 250g'].get('warn')), byname['Coffee 250g']  # comma decimal is a clean read
" && ok "edge parsing: comma decimals, band letters, qty continuation, negative discount" || bad "edge-case parsing"

# 9. degraded photo (skew, noise, blur, low contrast): all items + total still recovered
R6=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-split6","clients":["x"]}')
S6=$(echo "$R6" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
T6=$(echo "$R6" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$S6?filename=s06_degraded.png&uploader=t" --data-binary @scripts/samples/s06_degraded.png >/dev/null
for i in $(seq 1 40); do sleep 2; ST=$(curl -s $B/api/owner/$T6 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])"); [ "$ST" != "processing" ] && break; done
U6=$(curl -s $B/api/owner/$T6 | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
curl -s $B/api/split/$T6/$U6 | python3 -c "
import sys, json
d = json.load(sys.stdin)
got = [(i['name'], i['qty'], i['cents']) for i in d['items']]
want = [('Whole milk 2L', 2, 310), ('Sourdough bread', 1, 189), ('Pizza Margherita', 1, 249),
        ('Bananas 1kg', 1, 129), ('Chocolate bar', 1, 89), ('Multibuy discount', 1, -60)]
assert got == want, {'got': got, 'want': want}
assert d['receiptCents'] == 906 and d['sumMatchesReceipt'] is True, d['receiptCents']
" && ok "degraded photo (skew/noise/blur/low-contrast): all items + total recovered" || bad "degraded-photo extraction"

# 10. unit: repaired/malformed amounts are flagged, never silently treated as certain
node - <<'NODE'
const { parseItems } = require('./server.js');
const items = parseItems(['Yogurt 4pk 1,2O','Cola Zero 1.996','Bread 800g 1,29B','Coffee 250g 1,85','Multibuy discount -0,60','Lidl Plus Offers 1.30'].join('\n'));
const by = Object.fromEntries(items.map(i => [i.name, i]));
const assert = require('assert');
assert.strictEqual(by['Yogurt 4pk'].cents, 120);
assert.ok(/partly unreadable/.test(by['Yogurt 4pk'].warn));
assert.strictEqual(by['Cola Zero'].cents, 199);
assert.ok(/partly unreadable/.test(by['Cola Zero'].warn));
assert.strictEqual(by['Bread 800g'].cents, 129);
assert.ok(!by['Bread 800g'].warn);
assert.strictEqual(by['Coffee 250g'].cents, 185);
assert.ok(!by['Coffee 250g'].warn);
assert.strictEqual(by['Multibuy discount'].cents, -60);
assert.ok(!by['Multibuy discount'].warn);
assert.ok(/discount/.test(by['Lidl Plus Offers'].warn));
console.log('unit ok');
NODE
[ $? = 0 ] && ok "malformed/ambiguous amounts flagged for review, not silently repaired" || bad "repair flagging unit"

# cleanup fixtures
python3 - <<'PY'
import json, os, shutil
for f in list(os.listdir('data')):
    if f.endswith('.json'):
        d = json.load(open('data/'+f))
        if d['title'].startswith('fixture-split'):
            shutil.rmtree(os.path.join('data','files',d['id']), ignore_errors=True)
            os.remove('data/'+f)
PY
echo "== split: $PASS passed, $FAIL failed =="
