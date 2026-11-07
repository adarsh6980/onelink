#!/usr/bin/env python3
"""Generate 2 synthetic itemized supermarket receipts with item-level ground truth.
All data is invented; images are generated locally for demo purposes only."""
import json, os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(OUT, exist_ok=True)
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
FONT_B = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
FONT_S = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)

RECEIPTS = [
    dict(file="s01_lidl.png", vendor="Lidl Oranmore", date="05/11/2026",
         items=[("Whole milk 2L", 2, 3.10), ("Sourdough bread", 1, 1.89), ("Pizza Margherita", 1, 2.49),
                ("Bananas 1kg", 1, 1.29), ("Chocolate bar", 1, 0.89), ("Multibuy discount", 1, -0.60)]),
    dict(file="s02_dunnes.png", vendor="Dunnes Stores", date="04/11/2026",
         items=[("Chicken fillets 500g", 1, 5.49), ("Basmati rice 1kg", 1, 2.75), ("Coke 2L", 2, 4.50),
                ("Crisps multipack", 1, 3.20), ("Apples 6pk", 1, 2.10)]),
]

def render(r):
    W, H = 620, 780
    img = Image.new("RGB", (W, H), "#fbfaf7")
    d = ImageDraw.Draw(img)
    y = 30
    d.text((W//2, y), r["vendor"], font=FONT_B, fill="#111", anchor="ma"); y += 44
    d.text((W//2, y), "Date: " + r["date"], font=FONT_S, fill="#333", anchor="ma"); y += 36
    d.line([(30, y), (W-30, y)], fill="#999", width=1); y += 16
    total = 0.0
    gt_items = []
    for name, qty, price in r["items"]:
        label = f"{name} x{qty}" if qty > 1 else name
        d.text((40, y), label, font=FONT, fill="#111")
        d.text((W-40, y), f"{price:.2f}", font=FONT, fill="#111", anchor="ra")
        total += price; y += 34
        gt_items.append({"name": name, "qty": qty, "cents": round(price * 100)})
    y += 8
    d.line([(30, y), (W-30, y)], fill="#999", width=1); y += 16
    d.text((40, y), "TOTAL EUR", font=FONT_B, fill="#111")
    d.text((W-40, y), f"{total:.2f}", font=FONT_B, fill="#111", anchor="ra")
    img.save(os.path.join(OUT, r["file"]))
    return {"file": r["file"], "vendor": r["vendor"], "date": r["date"],
            "total_cents": round(total * 100), "items": gt_items}

manifest = [render(r) for r in RECEIPTS]
with open(os.path.join(OUT, "split_manifest.json"), "w") as f:
    json.dump({"note": "Generated sample receipts for demo only. Not real documents.",
               "ground_truth": manifest}, f, indent=2)
print("wrote", len(manifest), "split samples")
