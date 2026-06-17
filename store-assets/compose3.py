#!/usr/bin/env python3
"""Showcase-style Chrome Web Store screenshots (1280x800), TradingView-vibe.

No per-feature tutorials — each slide is a bold headline over a dramatic cluster
of floating side-panel windows (perspective tilt, depth, mint glow) that conveys
"lots of advanced tools" at a glance.

  01 hero      — the promise + hero cluster
  02 desk      — "an entire trading desk in one panel" (big fan of panels)
  03 follows   — built for the coin on your screen
  04 edges     — see what other traders don't
  05 cta       — add to Chrome, free

Run: /tmp/storeimg-venv/bin/python store-assets/compose3.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

W, H = 1280, 800
BG0 = (3, 12, 12)
BG1 = (6, 21, 21)
MINT = (80, 210, 193)
MINT_BR = (95, 227, 194)
CYAN = (64, 196, 210)
WHITE = (244, 250, 248)
DIM = (164, 186, 183)
MUTE = (120, 142, 140)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "store-assets", "raw2")
OUT = os.path.join(ROOT, "store-assets", "final3")
os.makedirs(OUT, exist_ok=True)

FONT_PATH = "/System/Library/Fonts/SFNS.ttf"
FONT_HEL = "/System/Library/Fonts/HelveticaNeue.ttc"


def font(size, weight="Regular"):
    try:
        f = ImageFont.truetype(FONT_PATH, size)
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
        return f
    except Exception:
        return ImageFont.truetype(FONT_HEL, size)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_bg():
    base = Image.new("RGB", (W, H), BG0)
    px = base.load()
    cx, cy = W * 0.5, H * 0.46
    maxd = (W ** 2 + H ** 2) ** 0.5
    for y in range(H):
        for x in range(W):
            t = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / maxd
            px[x, y] = lerp(BG1, BG0, min(1, t * 1.5))
    # big mint glow center-right, cooler cyan glow left — depth + drama
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)

    def radial(col, cx, cy, r, peak):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        for rr in range(r, 0, -8):
            a = int(peak * (1 - rr / r) ** 2)
            ld.ellipse([cx - rr, cy - rr * 0.78, cx + rr, cy + rr * 0.78],
                       fill=(*col, a))
        return layer

    glow = Image.alpha_composite(glow, radial(MINT, int(W * 0.66), int(H * 0.40), 560, 70))
    glow = Image.alpha_composite(glow, radial(CYAN, int(W * 0.16), int(H * 0.74), 460, 42))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    base = Image.alpha_composite(base.convert("RGBA"), glow)
    # faint grid
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        g.line([(x, 0), (x, H)], fill=(255, 255, 255, 5))
    for y in range(0, H, 48):
        g.line([(0, y), (W, y)], fill=(255, 255, 255, 5))
    base = Image.alpha_composite(base, grid)
    # vignette
    vig = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.rectangle([0, 0, W, H], fill=0)
    vd.rounded_rectangle([-200, -160, W + 200, H + 160], radius=400, fill=120)
    vig = vig.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new("RGBA", (W, H), (0, 0, 0, 150))
    inv = Image.eval(vig, lambda v: 150 - int(v * 150 / 255))
    dark.putalpha(inv)
    base = Image.alpha_composite(base, dark)
    return base


def rounded(img, rad):
    img = img.convert("RGBA")
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0], img.size[1]],
                                           radius=rad, fill=255)
    img.putalpha(mask)
    return img


def trim_bottom(im, pad=22):
    g = im.convert("L")
    px = g.load()
    w, h = g.size
    x0, x1 = int(w * 0.12), int(w * 0.88)
    last = h - 1
    for y in range(h - 1, -1, -1):
        if sum(1 for x in range(x0, x1, 5) if px[x, y] > 60) >= 3:
            last = min(h - 1, y + pad)
            break
    return im.crop((0, 0, w, last + 1))


_cache = {}


def load_panel(name, crop_top=0, crop_h=None):
    key = (name, crop_top, crop_h)
    if key in _cache:
        return _cache[key]
    im = Image.open(os.path.join(RAW, f"{name}.png")).convert("RGB")
    if crop_top:
        im = im.crop((0, crop_top, im.width, im.height))
    im = trim_bottom(im)
    if crop_h:
        im = im.crop((0, 0, im.width, min(crop_h, im.height)))
    _cache[key] = im
    return im


def place(canvas, name, cx, cy, h, angle=0.0, dim=1.0,
          glow=70, glow_col=MINT, rad=20, crop_top=0, crop_h=None, border=True):
    """Place a floating panel window centered at (cx,cy)."""
    p = rounded(load_panel(name, crop_top, crop_h), rad)
    scale = h / p.height
    p = p.resize((max(1, int(p.width * scale)), int(h)), Image.LANCZOS)
    if border:
        bd = p.copy()
        ImageDraw.Draw(bd).rounded_rectangle([0, 0, p.width - 1, p.height - 1],
                                             radius=rad, outline=(120, 235, 215, 150), width=2)
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
        gw, gh = int(pw * 0.85), int(ph * 0.7)
        ImageDraw.Draw(gl).ellipse([cx - gw, cy - gh, cx + gw, cy + gh],
                                   fill=(*glow_col, glow))
        canvas.alpha_composite(gl.filter(ImageFilter.GaussianBlur(90)))
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x + 6, y + 26, x + pw + 6, y + ph + 34],
                                         radius=rad + 6, fill=(0, 0, 0, 165))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(34)))
    canvas.alpha_composite(p, (x, y))


def brand(d, canvas, x, y, size=24):
    try:
        logo = Image.open(os.path.join(ROOT, "public", "icon128.png")) \
            .convert("RGBA").resize((size + 6, size + 6), Image.LANCZOS)
        canvas.alpha_composite(logo, (x, y))
    except Exception:
        pass
    d.text((x + size + 14, y + 2), "Hypurr Extension", font=font(size, "Bold"), fill=WHITE)


def headline(d, x, y, lines, size=66, lh=72, fill=WHITE):
    f = font(size, "Heavy")
    for ln in lines:
        d.text((x, y), ln, font=f, fill=fill)
        y += lh
    return y


def sub(d, x, y, text, size=23, fill=DIM):
    d.text((x, y), text, font=font(size, "Regular"), fill=fill)
    return y + 34


def chrome_cta(d, x, y, label="Add to Chrome"):
    f = font(22, "Bold")
    tw = d.textlength(label, font=f)
    bw = tw + 56
    d.rounded_rectangle([x, y, x + bw, y + 50], radius=25, fill=MINT_BR)
    d.text((x + 28, y + 12), label, font=f, fill=(3, 30, 26))
    return bw


# ---------------------------------------------------------------- slides

def s01():
    c = make_bg()
    # hero cluster (back -> front)
    place(c, "liq-btc", W * 0.50, H * 0.60, 470, angle=8, dim=0.55, glow=40)
    place(c, "arb-btc", W * 0.86, H * 0.55, 540, angle=-8, dim=0.72, glow=55)
    place(c, "fr-hype", W * 0.70, H * 0.55, 660, angle=-2, dim=1.0, glow=95)
    d = ImageDraw.Draw(c)
    brand(d, c, 80, 84, 26)
    y = headline(d, 80, 250, ["Every edge for", "the coin you're", "trading."], 62, 70)
    sub(d, 80, y + 12, "Eleven live tools in one Hyperliquid side panel.")
    c.convert("RGB").save(os.path.join(OUT, "01-hero.png"), quality=95)
    print("01")


def s02():
    c = make_bg()
    # a fan of many windows = "so many tools"
    place(c, "news-hype", W * 0.30, H * 0.66, 430, angle=11, dim=0.5, glow=30)
    place(c, "etf-hype", W * 0.86, H * 0.64, 450, angle=-11, dim=0.55, glow=35)
    place(c, "twap-btc", W * 0.46, H * 0.58, 540, angle=6, dim=0.8, glow=55)
    place(c, "liq-btc", W * 0.72, H * 0.57, 560, angle=-6, dim=0.85, glow=60)
    place(c, "arb-btc", W * 0.59, H * 0.54, 620, angle=0, dim=1.0, glow=95)
    d = ImageDraw.Draw(c)
    brand(d, c, 80, 70, 24)
    headline(d, 80, 116, ["An entire trading", "desk — in one panel."], 52, 60)
    c.convert("RGB").save(os.path.join(OUT, "02-desk.png"), quality=95)
    print("02")


def s03():
    c = make_bg()
    place(c, "stops-btc", W * 0.52, H * 0.60, 480, angle=7, dim=0.6, glow=40)
    place(c, "etf-hype", W * 0.84, H * 0.56, 540, angle=-7, dim=0.72, glow=55)
    place(c, "news-hype", W * 0.68, H * 0.56, 640, angle=-2, dim=1.0, glow=90)
    d = ImageDraw.Draw(c)
    y = headline(d, 80, 250, ["Built for the", "coin on your", "screen."], 60, 68)
    sub(d, 80, y + 12, "Switch markets — the panel follows, instantly.")
    c.convert("RGB").save(os.path.join(OUT, "03-follows.png"), quality=95)
    print("03")


def s04():
    c = make_bg()
    place(c, "fr-hype", W * 0.50, H * 0.60, 480, angle=8, dim=0.6, glow=45)
    place(c, "liq-btc", W * 0.84, H * 0.55, 560, angle=-8, dim=0.78, glow=60)
    place(c, "arb-btc", W * 0.68, H * 0.55, 660, angle=-2, dim=1.0, glow=95)
    d = ImageDraw.Draw(c)
    y = headline(d, 80, 230, ["See what", "other traders", "don't."], 62, 70)
    sub(d, 80, y + 12, "Cross-venue basis, liquidation maps, funding hedges.")
    c.convert("RGB").save(os.path.join(OUT, "04-edges.png"), quality=95)
    print("04")


def s05():
    c = make_bg()
    place(c, "arb-btc", W * 0.78, H * 0.58, 470, angle=9, dim=0.55, glow=35)
    place(c, "twap-btc", W * 0.86, H * 0.5, 520, angle=-7, dim=0.7, glow=50)
    place(c, "fr-hype", W * 0.72, H * 0.54, 620, angle=-2, dim=1.0, glow=95)
    d = ImageDraw.Draw(c)
    brand(d, c, 80, 90, 26)
    y = headline(d, 80, 230, ["Add it to", "Chrome.", "Free."], 66, 74)
    y = sub(d, 80, y + 14, "No accounts. No API keys. Open-source.")
    bw = chrome_cta(d, 80, y + 18)
    d.text((80, y + 18 + 64), "@hypurrext", font=font(18, "Semibold"), fill=MUTE)
    c.convert("RGB").save(os.path.join(OUT, "05-cta.png"), quality=95)
    print("05")


SLIDES = {"01": s01, "02": s02, "03": s03, "04": s04, "05": s05}

if __name__ == "__main__":
    for k in (sys.argv[1:] or list(SLIDES.keys())):
        SLIDES[k]()
