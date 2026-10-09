"""Génère les icônes PWA (PNG) de ShopFlow RDC. Usage : python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)
TEAL = (15, 118, 110)
WHITE = (255, 255, 255)
LIGHT = (204, 251, 241)

def font(size):
    for path in [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
    ]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()

def draw_icon(size, maskable=False, rounded=True):
    img = Image.new('RGBA', (size, size), TEAL + (255,))
    d = ImageDraw.Draw(img)
    # Zone de sécurité pour les icônes « maskable » : contenu dans 80 %.
    pad = int(size * (0.2 if maskable else 0.12))
    radius = int(size * 0.22)
    if rounded and not maskable:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
        img.putalpha(mask)
    inner = [pad, pad, size - pad, size - pad]
    d.rounded_rectangle(inner, radius=int(size * 0.16), fill=WHITE)
    # Lettres « SF » en teal
    f = font(int(size * 0.34))
    text = 'SF'
    bbox = d.textbbox((0, 0), text, font=f)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1] - size * 0.06), text, font=f, fill=TEAL)
    # Petite barre d'accent
    bar_w = int(size * 0.34)
    bar_h = max(2, int(size * 0.035))
    d.rounded_rectangle([(size - bar_w) / 2, size - pad - int(size * 0.14), (size + bar_w) / 2, size - pad - int(size * 0.14) + bar_h], radius=bar_h, fill=LIGHT)
    return img

draw_icon(192).save(os.path.join(OUT, 'icon-192.png'))
draw_icon(512).save(os.path.join(OUT, 'icon-512.png'))
draw_icon(512, maskable=True, rounded=False).convert('RGB').save(os.path.join(OUT, 'icon-maskable-512.png'))
# iOS : pas de transparence, coins gérés par iOS.
draw_icon(180, rounded=False).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
print('Icônes générées dans', os.path.abspath(OUT))
