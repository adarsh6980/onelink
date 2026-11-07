#!/usr/bin/env python3
"""Edge-case + degraded synthetic receipts for extraction-hardening tests. Invented data."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "samples")
os.makedirs(OUT, exist_ok=True)
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
FONT_B = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)
FONT_S = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)

def base(vendor, date):
    img = Image.new("RGB", (620, 900), "#fbfaf7")
    d = ImageDraw.Draw(img)
    d.text((310, 30), vendor, font=FONT_B, fill="#111", anchor="ma")
    d.text((310, 74), "Date: " + date, font=FONT_S, fill="#333", anchor="ma")
    return img, d, 120

# s05: comma decimals, VAT band letters, qty continuation line, negative discount
img, d, y = base("Edgecase Market", "06/11/2026")
rows = [("Coffee 250g", "1,85", False), ("Orange juice", "5,98", True),
        ("2 x 2,99", None, False), ("Multibuy discount", "-0,60", False),
        ("Yogurt 4pk", "1,2O", False),
        ("Bread 800g", "1,29 B", False)]
for text, right, band in rows:
    d.text((40, y), text, font=FONT, fill="#111")
    if right: d.text((580, y), right, font=FONT, fill="#111", anchor="ra")
    y += 34
d.text((40, y+10), "TOTAL EUR", font=FONT_B, fill="#111")
d.text((580, y+10), "9,72", font=FONT_B, fill="#111", anchor="ra")
img.save(os.path.join(OUT, "s05_edge.png"))

# degraded variants of s01-style content: rotation, noise, blur, low contrast (photo simulation)
img, d, y = base("Lidl Oranmore", "05/11/2026")
rows = [("Whole milk 2L x2", "3.10"), ("Sourdough bread", "1.89"), ("Pizza Margherita", "2.49"),
        ("Bananas 1kg", "1.29"), ("Chocolate bar", "0.89"), ("Multibuy discount", "-0.60")]
for text, right in rows:
    d.text((40, y), text, font=FONT, fill="#111")
    d.text((580, y), right, font=FONT, fill="#111", anchor="ra")
    y += 34
d.text((40, y+10), "TOTAL EUR", font=FONT_B, fill="#111")
d.text((580, y+10), "9.06", font=FONT_B, fill="#111", anchor="ra")
img = img.rotate(2.5, resample=Image.BICUBIC, fillcolor="#888")          # slight skew
arr = np.asarray(img).astype(np.int16)
arr = np.clip(arr * 0.55 + 60, 0, 255)                                    # low contrast / dim
arr = arr + np.random.default_rng(7).normal(0, 14, arr.shape)             # sensor noise
img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
img.save(os.path.join(OUT, "s06_degraded.png"))
print("wrote s05_edge.png, s06_degraded.png")
