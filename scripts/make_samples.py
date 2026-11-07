#!/usr/bin/env python3
"""Generate 8 synthetic sample receipts with ground truth manifest.
All data is invented; images are generated locally for demo purposes only."""
import json, math, os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(OUT, exist_ok=True)
random.seed(42)

try:
    FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
    FONT_B = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
    FONT_S = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
except Exception:
    FONT = FONT_B = FONT_S = ImageFont.load_default()

RECEIPTS = [
    dict(file="r01_harbour_cafe.png", client="Harbour Cafe", vendor="Harbour Cafe", date="12/10/2026",
         items=[("Flat white", 3.80), ("Scone", 3.20)], vat_rate=0.135, degrade=0),
    dict(file="r02_athlone_office.png", client="Harbour Cafe", vendor="Athlone Office Supplies", date="14/10/2026",
         items=[("A4 paper x5", 24.95), ("Ink cartridge", 31.40)], vat_rate=0.23, degrade=0),
    dict(file="r03_greenway_taxi.png", client="Meadow Studio", vendor="Greenway Taxis", date="15/10/2026",
         items=[("Airport run", 46.00)], vat_rate=0.135, degrade=1),
    dict(file="r04_printbarn.png", client="Meadow Studio", vendor="PrintBarn", date="18/10/2026",
         items=[("Flyers x500", 89.00), ("Lamination", 12.50)], vat_rate=0.23, degrade=0),
    dict(file="r05_lough_rea.png", client="Meadow Studio", vendor="Lough Rea Fuels", date="20/10/2026",
         items=[("Diesel 38.2L", 62.44)], vat_rate=0.135, degrade=2),
    dict(file="r06_cloudnine_hosting.png", client="Oranmore Physio", vendor="CloudNine Hosting", date="21/10/2026",
         items=[("Annual hosting", 143.88)], vat_rate=0.23, degrade=0),
    dict(file="r07_bru_hardware.png", client="Oranmore Physio", vendor="Bru Hardware", date="24/10/2026",
         items=[("Paint 10L", 54.99), ("Brushes", 18.75)], vat_rate=0.23, degrade=1),
    dict(file="r08_centra.png", client="Oranmore Physio", vendor="Centra Oranmore", date="27/10/2026",
         items=[("Milk, fruit, coffee", 21.36)], vat_rate=None, degrade=0),  # no VAT line -> must be flagged
]

def render(r):
    W, H = 620, 780
    img = Image.new("RGB", (W, H), "#fbfaf7")
    d = ImageDraw.Draw(img)
    y = 30
    d.text((W//2, y), r["vendor"], font=FONT_B, fill="#111", anchor="ma"); y += 44
    d.text((W//2, y), "Unit 4, Main Street", font=FONT_S, fill="#333", anchor="ma"); y += 30
    d.text((W//2, y), "Date: " + r["date"], font=FONT_S, fill="#333", anchor="ma"); y += 36
    d.line([(30, y), (W-30, y)], fill="#999", width=1); y += 16
    total = 0.0
    for name, price in r["items"]:
        d.text((40, y), name, font=FONT, fill="#111")
        d.text((W-40, y), f"{price:.2f}", font=FONT, fill="#111", anchor="ra")
        total += price; y += 34
    y += 8
    d.line([(30, y), (W-30, y)], fill="#999", width=1); y += 16
    vat = round(total * r["vat_rate"], 2) if r["vat_rate"] else None
    d.text((40, y), "TOTAL EUR", font=FONT_B, fill="#111")
    d.text((W-40, y), f"{total:.2f}", font=FONT_B, fill="#111", anchor="ra"); y += 40
    if vat is not None:
        d.text((40, y), f"VAT ({int(r['vat_rate']*1000)/10:g}%)", font=FONT_S, fill="#333")
        d.text((W-40, y), f"{vat:.2f}", font=FONT_S, fill="#333", anchor="ra"); y += 30
    d.text((W//2, y+20), "Thank you", font=FONT_S, fill="#555", anchor="ma")
    gt = {"file": r["file"], "client": r["client"], "vendor": r["vendor"],
          "date": r["date"], "total": round(total, 2), "vat": vat}
    if r["degrade"] == 1:
        img = img.rotate(random.uniform(-2.5, 2.5), expand=False, fillcolor="#fbfaf7")
        img = img.filter(ImageFilter.GaussianBlur(0.8))
    elif r["degrade"] == 2:
        img = img.rotate(random.uniform(-4, 4), expand=False, fillcolor="#fbfaf7")
        img = img.filter(ImageFilter.GaussianBlur(1.4))
        px = img.load()
        for _ in range(4000):
            x, yy = random.randrange(W), random.randrange(H)
            v = random.randrange(180, 256)
            px[x, yy] = (v, v, v)
    img.save(os.path.join(OUT, r["file"]))
    return gt

manifest = [render(r) for r in RECEIPTS]
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump({"note": "Generated sample receipts for demo only. Not real documents.",
               "ground_truth": manifest}, f, indent=2)
print("wrote", len(manifest), "samples to", OUT)
