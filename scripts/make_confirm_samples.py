#!/usr/bin/env python3
"""Synthetic receipts for confirmation-gate tests. Invented data, generated locally."""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(OUT, exist_ok=True)
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
FONT_B = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
FONT_S = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)

def render(fname, lines):
    W, H = 620, 400
    img = Image.new("RGB", (W, H), "#fbfaf7")
    d = ImageDraw.Draw(img)
    y = 30
    for text, right, bold in lines:
        f = FONT_B if bold else FONT
        d.text((40, y), text, font=f, fill="#111")
        if right: d.text((W-40, y), right, font=f, fill="#111", anchor="ra")
        y += 40
    img.save(os.path.join(OUT, fname))

# Trap receipt: one item and a TOTAL SAVINGS line with the same amount, no real TOTAL line.
render("s03_savings.png", [
    ("Testmart", None, True), ("Date: 06/11/2026", None, False),
    ("Croissants Hazelnut Filling", "1.79", False),
    ("TOTAL SAVINGS", "1.79", False),
])
# No TOTAL line at all: OCR must not produce a confident total.
render("s04_nototal.png", [
    ("Noshop", None, True), ("Date: 06/11/2026", None, False),
    ("Milk", "1.00", False),
    ("Bread", "2.00", False),
])
print("wrote s03_savings.png, s04_nototal.png")
