#!/bin/bash
set -e
cd "$(dirname "$0")/.."
rm -rf data/files data/*.json 2>/dev/null || true
node server.js > server.log 2>&1 &
SRV=$!
sleep 1
B=http://127.0.0.1:8123
echo "=== 1. create request ==="
RESP=$(curl -s -X POST $B/api/requests -d '{"title":"October receipts and invoices","need":"A clear photo of each receipt: vendor, date, total and VAT visible.","clients":["Harbour Cafe","Meadow Studio","Oranmore Physio"],"due":"2026-11-30"}')
echo "$RESP"
SLUG=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadPath'].split('/')[-1])")
TOKEN=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['ownerPath'].split('/')[-1])")
echo "slug=$SLUG token=$TOKEN"
echo "=== 2. upload 8 sample receipts as 3 clients ==="
cd scripts/samples
for f in r01_harbour_cafe.png r02_athlone_office.png; do curl -s -X POST "$B/api/upload/$SLUG?filename=$f&uploader=Harbour%20Cafe" --data-binary "@$f"; echo; done
for f in r03_greenway_taxi.png r04_printbarn.png r05_lough_rea.png; do curl -s -X POST "$B/api/upload/$SLUG?filename=$f&uploader=Meadow%20Studio" --data-binary "@$f"; echo; done
for f in r06_cloudnine_hosting.png r07_bru_hardware.png r08_centra.png; do curl -s -X POST "$B/api/upload/$SLUG?filename=$f&uploader=Oranmore%20Physio" --data-binary "@$f"; echo; done
echo "=== 2b. abuse checks ==="
curl -s -X POST "$B/api/upload/$SLUG?filename=evil.exe&uploader=X" --data-binary "MZ" ; echo " <- wrong type rejected"
head -c 6000000 /dev/zero > /tmp/big.png 2>/dev/null; curl -s -X POST "$B/api/upload/$SLUG?filename=big.png&uploader=X" --data-binary "@/tmp/big.png" || true; echo " <- oversize rejected"
curl -s "$B/api/owner/WRONGTOKEN"; echo " <- wrong owner token rejected"
echo "=== 3. wait for OCR, owner dashboard JSON ==="
export B SLUG TOKEN
for i in $(seq 1 60); do
  curl -s "$B/api/owner/$TOKEN" > /tmp/owner.json
  PEND=$(python3 -c "import json;d=json.load(open('/tmp/owner.json'));print(sum(1 for u in d['uploads'] if u['status']=='processing'))")
  [ "$PEND" = "0" ] && break
  sleep 2
done
echo "pending after wait: $PEND"
python3 - <<'PY'
import json
d = json.load(open('/tmp/owner.json'))
print('checklist:', [(c['name'], c['received']) for c in d['clients']])
for u in d['uploads']:
    o = u['ocr'] or {}
    print(f"{u['name']:28s} {u['uploader']:16s} status={u['status']:10s} vendor={str(o.get('vendor'))[:22]:24s}({o.get('vendor_conf')}) date={o.get('date')}({o.get('date_conf')}) total={o.get('total')}({o.get('total_conf')}) vat={o.get('vat')}({o.get('vat_conf')})")
PY
echo "=== 4. accuracy vs ground truth ==="
python3 - <<'PY'
import json
gt = {m['file']: m for m in json.load(open('manifest.json'))['ground_truth']}
d = json.load(open('/tmp/owner.json'))
ok = bad = 0
for u in d['uploads']:
    g = gt.get(u['name'])
    o = u['ocr'] or {}
    if not g: continue
    checks = {'vendor': str(o.get('vendor','')).strip() == g['vendor'], 'date': o.get('date') == g['date'], 'total': o.get('total') == g['total'], 'vat': o.get('vat') == g['vat']}
    for k, v in checks.items():
        ok += v; bad += (not v)
        if not v: print(f"MISMATCH {u['name']} field={k}: ocr={o.get(k)} truth={g[k]} conf={o.get(k+'_conf')}")
print(f"field accuracy: {ok}/{ok+bad} correct")
PY
echo "=== 5. owner reviews: fix missing VAT on r05, mark all reviewed ==="
python3 - <<'PY'
import json, urllib.request
d = json.load(open('/tmp/owner.json'))
fix = {'r05_lough_rea.png': {'vat': '8.43'}, 'r08_centra.png': {'vat': ''}}
for u in d['uploads']:
    body = {'reviewed': True}
    o = u['ocr'] or {}
    body.update({'vendor': o.get('vendor') or '', 'date': o.get('date') or '', 'total': o.get('total'), 'vat': o.get('vat')})
    if u['name'] in fix: body.update(fix[u['name']])
    import os
    req = urllib.request.Request(f"http://127.0.0.1:8123/api/review/{os.environ['TOKEN']}/{u['id']}", data=json.dumps(body).encode(), method='POST')
    print(u['name'], json.load(urllib.request.urlopen(req)))
PY
echo "=== 6. CSV export ==="
curl -s "$B/api/export/$TOKEN" | tee /tmp/export.csv
echo "=== 7. screenshots ==="
CH="google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=390,1400 --virtual-time-budget=6000"
$CH --screenshot=/tmp/shot-create.png $B/ 2>/dev/null
$CH --screenshot=/tmp/shot-upload.png $B/r/$SLUG 2>/dev/null
$CH --screenshot=/tmp/shot-owner.png --window-size=390,3000 $B/o/$TOKEN 2>/dev/null
ls -la /tmp/shot-*.png
kill $SRV 2>/dev/null || true
echo DONE
