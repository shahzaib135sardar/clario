"""Generates the PWA icons into public/icons. Run: python3 scripts/make-icons.py"""
import os
from PIL import Image, ImageDraw, ImageFont

INK = (23, 24, 22)
PAPER = (247, 247, 245)
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT, exist_ok=True)

def font(size):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()

def draw(size, safe_fraction, rounded):
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), INK + (255,))
    if rounded:  # transparent rounded-square corners for the "any" icons
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, s, s), radius=int(s * 0.22), fill=255)
        img.putalpha(mask)
    d = ImageDraw.Draw(img)
    f = font(int(s * safe_fraction))
    box = d.textbbox((0, 0), "c", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1]), "c", font=f, fill=PAPER)
    return img.resize((size, size), Image.LANCZOS)

draw(192, 0.62, True).save(os.path.join(OUT, "icon-192.png"))
draw(512, 0.62, True).save(os.path.join(OUT, "icon-512.png"))
draw(512, 0.46, False).save(os.path.join(OUT, "icon-maskable-512.png"))  # content inside the 80% safe zone
draw(180, 0.58, False).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
print("icons written to", os.path.abspath(OUT))
