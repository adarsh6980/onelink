#!/usr/bin/env bash
# Hardening tests against a seeded demo (run demo.sh first). Server must be up on 8123.
# Fixture requests created here are deleted at the end so demo data stays clean.
set -u; B=http://localhost:8123; PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
PICK=$(python3 - <<'PY'
import json, os
best, n = None, -1
for f in os.listdir('data'):
    if f.endswith('.json'):
        d = json.load(open('data/'+f))
        if len(d['uploads']) > n: best, n = d, len(d['uploads'])
print(best['token'], best['slug'], best['id'])
PY
)
read TOKEN SLUG REQID <<< "$PICK"

# --- fixture request for destructive/injection tests ---
FX=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture","due":"2026-11-10","clients":["x"]}')
FSLUG=$(echo "$FX" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
FTOKEN=$(echo "$FX" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")

# 1. due date beyond default expiry -> expiry extended past due, note present
R=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-far-due","due":"2026-11-30","clients":["a@b.co"]}')
FARID=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print('') " 2>/dev/null; echo "$R" | python3 -c "import sys,json;print('skip')" 2>/dev/null)
echo "$R" | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
assert datetime.date.fromisoformat(d['expiresAt'][:10]) >= datetime.date(2026,12,1), 'expiry '+d['expiresAt']
assert d.get('expiryNote'), 'missing expiryNote'
" && ok "expiry extended past due date with warning note" || bad "expiry extension: $R"

# 2. content validation, not just extension
printf 'MZ fake exe bytes' > /tmp/fake.png
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/upload/$FSLUG?filename=fake.png&uploader=mallory" --data-binary @/tmp/fake.png)
[ "$CODE" = 415 ] && ok "MZ-content named .png rejected (415)" || bad "fake png got $CODE"
cp scripts/samples/r01_harbour_cafe.png /tmp/renamed.jpg
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/upload/$FSLUG?filename=renamed.jpg&uploader=tester" --data-binary @/tmp/renamed.jpg)
[ "$CODE" = 200 ] && ok "real PNG misnamed .jpg accepted via content check" || bad "valid content got $CODE"

# 3. review blocked while extraction in progress
UPID=$(curl -s $B/api/owner/$FTOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
ST=$(curl -s $B/api/owner/$FTOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])")
if [ "$ST" = "processing" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/review/$FTOKEN/$UPID -H 'Content-Type: application/json' -d '{"vendor":"v","date":"","total":null,"vat":null,"reviewed":true}')
  [ "$CODE" = 409 ] && ok "review blocked (409) while extraction in progress" || bad "review during processing got $CODE"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/export/$FTOKEN)
  [ "$CODE" = 409 ] && ok "export blocked (409) while extraction in progress" || bad "export during processing got $CODE"
else
  bad "fixture extraction already done before processing-gate test (status=$ST) - rerun"
fi
# wait for extraction to finish
for i in $(seq 1 40); do
  sleep 2
  ST=$(curl -s $B/api/owner/$FTOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['status'])")
  [ "$ST" != "processing" ] && break
done

# 4. formula injection escaped in CSV (dedicated fixture - demo data stays clean)
curl -s -X POST $B/api/review/$FTOKEN/$UPID -H 'Content-Type: application/json' -d '{"vendor":"=HYPERLINK(\"http://evil\",\"x\")","date":"2026-10-02","total":7,"vat":0.95,"reviewed":true}' >/dev/null
curl -s $B/api/export/$FTOKEN > /tmp/fx.csv
grep -q '\"'"'"'=HYPERLINK' /tmp/fx.csv && ok "formula-injecting vendor escaped with leading quote" || { bad "formula escaping"; cat /tmp/fx.csv; }

# 5. access denied immediately after expiry, independent of the sweeper (no restart)
python3 - <<'PY'
import json, os
for f in os.listdir('data'):
    if f.endswith('.json'):
        d = json.load(open('data/'+f))
        if d['title'] == 'fixture':
            d['expiresAt'] = '2026-11-01T00:00:00.000Z'
            json.dump(d, open('data/'+f, 'w'))
            print('backdated fixture', d['id'])
PY
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/upload/$FSLUG?filename=x.png&uploader=t" --data-binary @/tmp/renamed.jpg)
[ "$CODE" = 410 ] && ok "upload denied (410) immediately after expiry" || bad "upload after expiry got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/request/$FSLUG)
[ "$CODE" = 410 ] && ok "public request API denied (410) after expiry" || bad "request API after expiry got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/owner/$FTOKEN)
[ "$CODE" = 410 ] && ok "owner API denied (410) after expiry" || bad "owner API after expiry got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/file/$FTOKEN/$UPID)
[ "$CODE" = 410 ] && ok "file bytes denied (410) after expiry" || bad "file after expiry got $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/export/$FTOKEN)
[ "$CODE" = 410 ] && ok "export denied (410) after expiry" || bad "export after expiry got $CODE"

# 6. CSV review gate on a dedicated 2-upload fixture: 409 with one unreviewed, 200 after both reviewed
GX=$(curl -s -X POST $B/api/requests -H 'Content-Type: application/json' -d '{"title":"fixture-gate","due":"2026-11-10","clients":["x"]}')
GSLUG=$(echo "$GX" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
GTOKEN=$(echo "$GX" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
curl -s -X POST "$B/api/upload/$GSLUG?filename=g1.png&uploader=a" --data-binary @scripts/samples/r01_harbour_cafe.png >/dev/null
curl -s -X POST "$B/api/upload/$GSLUG?filename=g2.png&uploader=b" --data-binary @scripts/samples/r02_athlone_office.png >/dev/null
for i in $(seq 1 40); do
  sleep 2
  NPROC=$(curl -s $B/api/owner/$GTOKEN | python3 -c "import sys,json;print(sum(1 for u in json.load(sys.stdin)['uploads'] if u['status']=='processing'))")
  [ "$NPROC" = "0" ] && break
done
G1=$(curl -s $B/api/owner/$GTOKEN | python3 -c "import sys,json;print(json.load(sys.stdin)['uploads'][0]['id'])")
curl -s $B/api/owner/$GTOKEN | python3 -c "
import sys, json
u = [x for x in json.load(sys.stdin)['uploads'] if x['id']=='$G1'][0]
o = u.get('ocr') or {}
print(json.dumps({'vendor': o.get('vendor') or '', 'date': o.get('date') or '', 'total': o.get('total'), 'vat': o.get('vat'), 'reviewed': True}))
" > /tmp/g1body.json
curl -s -X POST $B/api/review/$GTOKEN/$G1 -H 'Content-Type: application/json' -d @/tmp/g1body.json >/dev/null
CODE=$(curl -s -o /tmp/gate.json -w '%{http_code}' $B/api/export/$GTOKEN)
[ "$CODE" = 409 ] && ok "export blocked (409) with one of two uploads unreviewed" || bad "export gate missing ($CODE)"
for UPID in $(curl -s $B/api/owner/$GTOKEN | python3 -c "import sys,json;print(' '.join(u['id'] for u in json.load(sys.stdin)['uploads'] if not (u.get('review') or {}).get('reviewed')))"); do
  BODY=$(curl -s $B/api/owner/$GTOKEN | python3 -c "
import sys, json
u = [x for x in json.load(sys.stdin)['uploads'] if x['id']=='$UPID'][0]
o = u.get('ocr') or {}
print(json.dumps({'vendor': o.get('vendor') or '', 'date': o.get('date') or '', 'total': o.get('total'), 'vat': o.get('vat'), 'reviewed': True}))
")
  curl -s -X POST $B/api/review/$GTOKEN/$UPID -H 'Content-Type: application/json' -d "$BODY" >/dev/null
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/export/$GTOKEN)
[ "$CODE" = 200 ] && ok "export succeeds once all uploads reviewed" || bad "export still blocked ($CODE)"
CODE=$(curl -s -o /tmp/export3.csv -w '%{http_code}' $B/api/export/$TOKEN)
[ "$CODE" = 200 ] && ok "seeded demo export works (demo reviews all)" || bad "seeded demo export got $CODE"
! grep -q 'HYPERLINK' /tmp/export3.csv && ok "demo CSV clean of injection fixture" || bad "demo CSV polluted"
grep -q 'owner-reviewed' /tmp/export3.csv && ok "CSV rows all owner-reviewed" || bad "CSV source column"

# 7. VAT states: 'not found' vs 'unreadable' distinguished
curl -s $B/api/owner/$TOKEN > /tmp/owner.json
python3 -c "
import json
d = json.load(open('/tmp/owner.json'))
vat = {u['name']: (u.get('ocr') or {}).get('vat_conf') for u in d['uploads']}
nf = sum(1 for v in vat.values() if v == 'not found')
ur = sum(1 for v in vat.values() if v == 'unreadable')
assert nf >= 1 and ur >= 1, vat
print('VAT split ok: not-on-receipt x%d, unreadable x%d' % (nf, ur))
" >/tmp/vat.txt 2>&1 && ok "$(cat /tmp/vat.txt)" || bad "VAT states: $(cat /tmp/vat.txt)"

# 8. owner token leak checks
curl -s $B/r/$SLUG | grep -q "$TOKEN" && bad "owner token in upload page HTML" || ok "no owner token in upload page"
curl -s $B/api/request/$SLUG | grep -q "$TOKEN" && bad "owner token in public request API" || ok "no owner token in public request API"
grep -q "$TOKEN" public/upload.html && bad "token handling in upload.html source" || ok "upload.html has no token handling"
grep -q "$TOKEN" server.log && bad "token in server.log" || ok "token absent from server.log"

# cleanup fixtures so demo data stays clean
python3 - <<'PY'
import json, os, shutil
for f in list(os.listdir('data')):
    if f.endswith('.json'):
        d = json.load(open('data/'+f))
        if d['title'].startswith('fixture'):
            shutil.rmtree(os.path.join('data','files',d['id']), ignore_errors=True)
            os.remove('data/'+f)
            print('removed fixture', d['id'], d['title'])
PY

echo "== hardening: $PASS passed, $FAIL failed =="
