#!/usr/bin/env python3
"""Hybrid store screenshots (1280x800): Codex-generated cinematic backdrops
(store-assets/bg/*.png) + real side-panel captures composited on top, with a
refined layout to fix the off-balance feel.

Run: /tmp/storeimg-venv/bin/python store-assets/compose4.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

W, H = 1280, 800
MINT = (80, 210, 193)
MINT_BR = (102, 232, 200)
WHITE = (245, 251, 249)
DIM = (176, 198, 195)
MUTE = (126, 150, 148)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "store-assets", "raw2")
BG = os.path.join(ROOT, "store-assets", "bg")
OUT = os.path.join(ROOT, "store-assets", "final4")
os.makedirs(OUT, exist_ok=True)

FONT_PATH = "/System/Library/Fonts/SFNS.ttf"


def font(size, weight="Regular"):
    f = ImageFont.truetype(FONT_PATH, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def backdrop(name):
    im = Image.open(os.path.join(BG, name)).convert("RGB")
    # cover-fit to 1280x800
    s = max(W / im.width, H / im.height)
    im = im.resize((int(im.width * s) + 1, int(im.height * s) + 1), Image.LANCZOS)
    x = (im.width - W) // 2
    y = (im.height - H) // 2
    return im.crop((x, y, x + W, y + H)).convert("RGBA")


def left_scrim(canvas, to=0.62, strength=205):
    """Darken the left side with a horizontal gradient so text stays legible."""
    grad = Image.new("L", (W, 1), 0)
    px = grad.load()
    edge = int(W * to)
    for x in range(W):
        px[x, 0] = int(strength * max(0, 1 - x / edge)) if x < edge else 0
    grad = grad.resize((W, H))
    dark = Image.new("RGBA", (W, H), (2, 10, 10, 0))
    dark.putalpha(grad)
    canvas.alpha_composite(dark)


def rounded(img, rad):
    img = img.convert("RGBA")
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, img.size[0], img.size[1]], radius=rad, fill=255)
    img.putalpha(m)
    return img


def trim_bottom(im, pad=22):
    g = im.convert("L"); px = g.load(); w, h = g.size
    x0, x1 = int(w * 0.12), int(w * 0.88); last = h - 1
    for y in range(h - 1, -1, -1):
        if sum(1 for x in range(x0, x1, 5) if px[x, y] > 60) >= 3:
            last = min(h - 1, y + pad); break
    return im.crop((0, 0, w, last + 1))


_c = {}
def load_panel(name):
    if name in _c: return _c[name]
    im = trim_bottom(Image.open(os.path.join(RAW, f"{name}.png")).convert("RGB"))
    _c[name] = im
    return im


def place(canvas, name, cx, cy, h, angle=0.0, dim=1.0, glow=70, rad=20):
    p = rounded(load_panel(name), rad)
    s = h / p.height
    p = p.resize((max(1, int(p.width * s)), int(h)), Image.LANCZOS)
    bd = p.copy()
    ImageDraw.Draw(bd).rounded_rectangle([0, 0, p.width - 1, p.height - 1], radius=rad,
                                         outline=(130, 240, 220, 165), width=2)
    p = bd
    if dim != 1.0:
        rgb = ImageEnhance.Brightness(p.convert("RGB")).enhance(dim)
        p = Image.merge("RGBA", (*rgb.split(), p.split()[3]))
    if angle:
        p = p.rotate(angle, expand=True, resample=Image.BICUBIC)
    pw, ph = p.size
    x, y = int(cx - pw / 2), int(cy - ph / 2)
    if glow:
        gl = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        gw, gh = int(pw * 0.8), int(ph * 0.62)
        ImageDraw.Draw(gl).ellipse([cx - gw, cy - gh, cx + gw, cy + gh], fill=(*MINT, glow))
        canvas.alpha_composite(gl.filter(ImageFilter.GaussianBlur(95)))
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x + 6, y + 28, x + pw + 6, y + ph + 36],
                                         radius=rad + 6, fill=(0, 0, 0, 175))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(36)))
    canvas.alpha_composite(p, (x, y))


def tracked(d, x, y, text, f, fill, tracking=0.0):
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + tracking
    return x


def brand(d, canvas, x, y, size=22):
    try:
        logo = Image.open(os.path.join(ROOT, "public", "icon128.png")).convert("RGBA") \
            .resize((size + 6, size + 6), Image.LANCZOS)
        canvas.alpha_composite(logo, (x, y))
    except Exception:
        pass
    tracked(d, x + size + 14, y + 3, "HYPURR EXTENSION", font(size - 4, "Bold"), WHITE, 1.5)


def headline(d, x, y, lines, size=60, lh=66):
    f = font(size, "Heavy")
    for ln in lines:
        d.text((x, y), ln, font=f, fill=WHITE)
        y += lh
    return y


def sub(d, x, y, text, size=22, fill=DIM):
    d.text((x, y), text, font=font(size, "Regular"), fill=fill)
    return y + 34


def cta(d, x, y, label="Add to Chrome"):
    f = font(22, "Bold")
    bw = d.textlength(label, font=f) + 56
    d.rounded_rectangle([x, y, x + bw, y + 50], radius=25, fill=MINT_BR)
    d.text((x + 28, y + 12), label, font=f, fill=(3, 28, 24))
    return y + 50


# Panel clusters per slide — intentional, gently tilted, well spaced.
def cluster_hero(c):
    place(c, "liq-btc",  W * 0.55, H * 0.62, 470, angle=6, dim=0.5, glow=30)
    place(c, "arb-btc",  W * 0.88, H * 0.55, 540, angle=-7, dim=0.7, glow=45)
    place(c, "fr-hype",  W * 0.72, H * 0.55, 660, angle=-2, dim=1.0, glow=80)

def cluster_desk(c):
    place(c, "news-hype", W * 0.31, H * 0.67, 430, angle=10, dim=0.46, glow=22)
    place(c, "etf-hype",  W * 0.88, H * 0.64, 450, angle=-10, dim=0.52, glow=28)
    place(c, "twap-btc",  W * 0.47, H * 0.585, 540, angle=5, dim=0.78, glow=45)
    place(c, "liq-btc",   W * 0.73, H * 0.575, 560, angle=-5, dim=0.84, glow=50)
    place(c, "arb-btc",   W * 0.60, H * 0.55, 620, angle=0, dim=1.0, glow=85)

def cluster_follows(c):
    place(c, "stops-btc", W * 0.57, H * 0.62, 480, angle=6, dim=0.55, glow=30)
    place(c, "etf-hype",  W * 0.86, H * 0.56, 540, angle=-7, dim=0.72, glow=45)
    place(c, "news-hype", W * 0.71, H * 0.56, 640, angle=-2, dim=1.0, glow=80)

def cluster_edges(c):
    place(c, "fr-hype",   W * 0.55, H * 0.62, 480, angle=7, dim=0.55, glow=32)
    place(c, "liq-btc",   W * 0.87, H * 0.55, 560, angle=-8, dim=0.78, glow=48)
    place(c, "arb-btc",   W * 0.71, H * 0.55, 660, angle=-2, dim=1.0, glow=85)

def cluster_cta(c):
    place(c, "arb-btc",   W * 0.83, H * 0.6, 470, angle=8, dim=0.5, glow=28)
    place(c, "twap-btc",  W * 0.9, H * 0.5, 520, angle=-6, dim=0.66, glow=40)
    place(c, "fr-hype",   W * 0.75, H * 0.54, 620, angle=-2, dim=1.0, glow=82)


def slide(out, bg, cluster, draw_text):
    c = backdrop(bg)
    cluster(c)
    left_scrim(c)
    d = ImageDraw.Draw(c)
    draw_text(d, c)
    c.convert("RGB").save(os.path.join(OUT, out), quality=95)
    print("saved", out)


def t_hero(d, c):
    brand(d, c, 84, 90)
    y = headline(d, 84, 246, ["Every edge for", "the coin you're", "trading."], 60, 68)
    sub(d, 84, y + 14, "Eleven live tools in one Hyperliquid side panel.")

def t_desk(d, c):
    brand(d, c, 84, 74)
    headline(d, 84, 118, ["An entire trading", "desk — in one panel."], 50, 58)

def t_follows(d, c):
    y = headline(d, 84, 244, ["Built for the", "coin on your", "screen."], 58, 66)
    sub(d, 84, y + 14, "Switch markets — the panel follows, instantly.")

def t_edges(d, c):
    y = headline(d, 84, 226, ["See what", "other traders", "don't."], 60, 68)
    sub(d, 84, y + 14, "Cross-venue basis, liquidation maps, funding hedges.")

def t_cta(d, c):
    brand(d, c, 84, 96)
    y = headline(d, 84, 232, ["Add it to", "Chrome.", "Free."], 64, 72)
    y = sub(d, 84, y + 16, "No accounts. No API keys. Open-source.")
    y = cta(d, 84, y + 18)
    d.text((84, y + 16), "@hypurrext", font=font(18, "Semibold"), fill=MUTE)


SLIDES = {
    "01": ("01-hero.png", "01.png", cluster_hero, t_hero),
    "02": ("02-desk.png", "02.png", cluster_desk, t_desk),
    "03": ("03-follows.png", "03.png", cluster_follows, t_follows),
    "04": ("04-edges.png", "04.png", cluster_edges, t_edges),
    "05": ("05-cta.png", "05.png", cluster_cta, t_cta),
}

if __name__ == "__main__":
    for k in (sys.argv[1:] or list(SLIDES.keys())):
        out, bg, cl, tx = SLIDES[k]
        slide(out, bg, cl, tx)
