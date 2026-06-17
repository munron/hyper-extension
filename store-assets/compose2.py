#!/usr/bin/env python3
"""Presentation-style Chrome Web Store screenshots (1280x800).

Five slides that tell a story instead of listing features:
  01 cover     — the promise
  02 onepanel  — problem -> solution (replaces a dozen tabs)
  03 flow      — proof #1: order-flow / incoming pressure
  04 funding   — proof #2: funding + Boros hedge (the differentiator)
  05 tools     — breadth + trust + call to action

Composites real side-panel captures (store-assets/raw2/*, see capture.mjs) on a
branded mint/teal background. Run with the Pillow venv:
  /tmp/storeimg-venv/bin/python store-assets/compose2.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800
BG1 = (6, 21, 21)
BG2 = (4, 16, 15)
MINT = (80, 210, 193)
MINT_BR = (95, 227, 194)
WHITE = (240, 248, 246)
DIM = (150, 172, 169)
MUTE = (110, 132, 130)
RED = (255, 101, 102)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "store-assets", "raw2")
OUT = os.path.join(ROOT, "store-assets", "final2")
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
    base = Image.new("RGB", (W, H), BG2)
    px = base.load()
    for y in range(H):
        col = lerp(BG1, BG2, y / H)
        for x in range(W):
            px[x, y] = col
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)

    def radial(cx, cy, r, peak):
        for rr in range(r, 0, -6):
            a = int(peak * (1 - rr / r) ** 2)
            gd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=a)

    radial(int(W * 0.82), int(H * -0.05), 640, 95)
    radial(int(W * 0.06), int(H * 0.98), 540, 55)
    radial(int(W * 0.62), int(H * 0.55), 520, 55)
    glow = glow.filter(ImageFilter.GaussianBlur(64))
    mint_layer = Image.new("RGB", (W, H), MINT)
    base = Image.composite(mint_layer, base, glow.point(lambda v: int(v * 0.5)))
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    step = 46
    for x in range(0, W, step):
        g.line([(x, 0), (x, H)], fill=(255, 255, 255, 6))
    for y in range(0, H, step):
        g.line([(0, y), (W, y)], fill=(255, 255, 255, 6))
    base = Image.alpha_composite(base.convert("RGBA"), grid)
    return base.convert("RGBA")


def rounded(img, rad):
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, img.size[0], img.size[1]], radius=rad, fill=255)
    img = img.convert("RGBA")
    img.putalpha(mask)
    return img


def trim_bottom(im, pad=24):
    g = im.convert("L")
    px = g.load()
    w, h = g.size
    x0, x1 = int(w * 0.12), int(w * 0.88)
    last = h - 1
    for y in range(h - 1, -1, -1):
        bright = sum(1 for x in range(x0, x1, 5) if px[x, y] > 60)
        if bright >= 3:
            last = min(h - 1, y + pad)
            break
    return im.crop((0, 0, w, last + 1))


def load_panel(name, crop_top=0):
    """Load a raw capture, optionally drop the top `crop_top` px (header+tabs),
    and trim the empty bottom."""
    im = Image.open(os.path.join(RAW, f"{name}.png")).convert("RGB")
    if crop_top:
        im = im.crop((0, crop_top, im.width, im.height))
    return trim_bottom(im)


def panel_scaled(im, target_h, rad=24):
    scale = target_h / im.height
    new = im.resize((max(1, int(im.width * scale)), target_h), Image.LANCZOS)
    return rounded(new, rad)


def paste_panel(canvas, panel, x, y, halo=True):
    pw, ph = panel.size
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [x - 6, y + 16, x + pw + 6, y + ph + 24], radius=30, fill=(0, 0, 0, 150)
    )
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(26)))
    if halo:
        bd = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(bd).rounded_rectangle(
            [x - 2, y - 2, x + pw + 2, y + ph + 2], radius=26,
            outline=(80, 210, 193, 120), width=3,
        )
        canvas.alpha_composite(bd)
    canvas.alpha_composite(panel, (x, y))


def brand_row(d, canvas, x, y, size=30):
    try:
        logo = Image.open(os.path.join(ROOT, "public", "icon128.png")) \
            .convert("RGBA").resize((size + 8, size + 8), Image.LANCZOS)
        canvas.alpha_composite(logo, (x, y))
    except Exception:
        pass
    d.text((x + size + 18, y + 4), "Hypurr", font=font(size, "Bold"), fill=WHITE)
    return y + size + 8


def pill(d, x, y, text, pad=16, fg=(150, 240, 224), dot=True):
    pf = font(16, "Semibold")
    tw = d.textlength(text, font=pf)
    h = 34
    x0 = x
    extra = 26 if dot else 0
    d.rounded_rectangle([x0, y, x0 + tw + pad * 2 + extra, y + h], radius=17,
                        fill=(12, 34, 31, 235), outline=(80, 210, 193, 150), width=1)
    tx = x0 + pad
    if dot:
        d.ellipse([x0 + pad, y + 12, x0 + pad + 10, y + 22], fill=MINT)
        tx = x0 + pad + 24
    d.text((tx, y + 8), text, font=pf, fill=fg)
    return y + h


def headline(d, x, y, lines, size=56, lh=64, fill=WHITE):
    hf = font(size, "Heavy")
    for ln in lines:
        d.text((x, y), ln, font=hf, fill=fill)
        y += lh
    return y


def sublines(d, x, y, lines, size=22, lh=31, fill=DIM):
    sf = font(size, "Regular")
    for ln in lines:
        d.text((x, y), ln, font=sf, fill=fill)
        y += lh
    return y


def metric_chip(d, x, y, text, w=None):
    cf = font(20, "Semibold")
    tw = d.textlength(text, font=cf)
    w = w or (tw + 40)
    h = 44
    d.rounded_rectangle([x, y, x + w, y + h], radius=12,
                        fill=(80, 210, 193, 30), outline=(80, 210, 193, 120), width=1)
    d.ellipse([x + 16, y + 18, x + 24, y + 26], fill=MINT_BR)
    d.text((x + 34, y + 11), text, font=cf, fill=(206, 236, 230))
    return y + h


def bullets(d, x, y, items, size=20, lh=36):
    bf = font(size, "Medium")
    for b in items:
        d.ellipse([x + 2, y + 8, x + 11, y + 17], fill=MINT)
        d.text((x + 24, y), b, font=bf, fill=(206, 224, 221))
        y += lh
    return y


# ---------------------------------------------------------------- slides

def slide_cover():
    c = make_bg()
    d = ImageDraw.Draw(c)
    panel = panel_scaled(load_panel("fr-hype"), 720)
    paste_panel(c, panel, W - 80 - panel.width, (H - panel.height) // 2)
    x = 84
    y = brand_row(d, c, x, 96, 32)
    y += 18
    y = pill(d, x, y, "LIVE · follows your Hyperliquid coin")
    y += 30
    y = headline(d, x, y, ["Every Hyperliquid", "edge — in one", "side panel."], 58, 66)
    y += 16
    sublines(d, x, y, ["Hypurr rides along on app.hyperliquid.xyz and",
                       "surfaces the context for the exact coin you're",
                       "viewing — live, no setup."])
    c.convert("RGB").save(os.path.join(OUT, "01-cover.png"), quality=95)
    print("saved 01-cover")


def slide_onepanel():
    c = make_bg()
    d = ImageDraw.Draw(c)
    panel = panel_scaled(load_panel("arb-btc"), 720)
    paste_panel(c, panel, W - 80 - panel.width, (H - panel.height) // 2)
    x = 84
    y = headline(d, x, 92, ["Stop juggling", "a dozen tabs."], 56, 64)
    y += 14
    y = sublines(d, x, y, ["One panel replaces the dashboards, funding",
                           "sites and spreadsheets you switch between."])
    y += 26
    rf = font(21, "Medium")
    for item in ["Funding & basis trackers", "Liquidation dashboards",
                 "Stop-level heatmaps", "Per-coin news hunts",
                 "Protocol-stat spreadsheets"]:
        d.text((x + 26, y), item, font=rf, fill=MUTE)
        tw = d.textlength(item, font=rf)
        d.line([(x + 22, y + 14), (x + 30 + tw, y + 14)], fill=RED, width=2)
        d.text((x, y - 1), "✕", font=font(18, "Bold"), fill=RED)
        y += 36
    y += 12
    metric_chip(d, x, y, "→  all of it, in one Hypurr panel", w=400)
    c.convert("RGB").save(os.path.join(OUT, "02-onepanel.png"), quality=95)
    print("saved 02-onepanel")


def slide_feature(out, panel_name, head, sub, chip, bull):
    c = make_bg()
    d = ImageDraw.Draw(c)
    panel = panel_scaled(load_panel(panel_name), 724)
    paste_panel(c, panel, W - 78 - panel.width, (H - panel.height) // 2)
    x = 84
    y = brand_row(d, c, x, 84, 26)
    y += 20
    y = headline(d, x, y, head, 52, 60)
    y += 14
    y = sublines(d, x, y, sub)
    y += 22
    y = metric_chip(d, x, y, chip)
    y += 22
    bullets(d, x, y, bull)
    c.convert("RGB").save(os.path.join(OUT, out), quality=95)
    print("saved", out)


def slide_tools():
    c = make_bg()
    d = ImageDraw.Draw(c)
    # headline
    y = headline(d, 84, 70, ["11 tools. One panel. Zero setup."], 46, 54)
    sublines(d, 84, y + 6,
             ["No accounts, no API keys — open the panel, pick a coin, done."],
             22, 30)
    # montage: three content tiles (header/tabs cropped off)
    tiles = [("liq-btc", "Liquidation map"),
             ("arb-btc", "Cross-venue arb"),
             ("etf-hype", "HYPE ETF flows")]
    th = 420
    gap = 28
    widths = []
    imgs = []
    for name, _ in tiles:
        im = panel_scaled(load_panel(name, crop_top=540), th, rad=18)
        imgs.append(im)
        widths.append(im.width)
    total = sum(widths) + gap * (len(imgs) - 1)
    x = (W - total) // 2
    ty = 196
    lf = font(18, "Semibold")
    for im, (_, label) in zip(imgs, tiles):
        paste_panel(c, im, x, ty, halo=True)
        lw = d.textlength(label, font=lf)
        d.text((x + (im.width - lw) // 2, ty + th + 14), label, font=lf, fill=DIM)
        x += im.width + gap
    # tool strip
    strip = ("TWAP flow · Funding · Boros hedge · Liquidations · Stops · "
             "Cross-venue arb · News · Events · Protocol stats · Unstaking · Predict")
    sf = font(16, "Medium")
    sw = d.textlength(strip, font=sf)
    d.text(((W - sw) // 2, 686), strip, font=sf, fill=MUTE)
    # CTA bar
    cta = "Add to Chrome — free"
    cf = font(22, "Bold")
    cw = d.textlength(cta, font=cf)
    bw = cw + 56
    bx = (W - bw) // 2
    by = 724
    d.rounded_rectangle([bx, by, bx + bw, by + 48], radius=24, fill=MINT_BR)
    d.text((bx + 28, by + 11), cta, font=cf, fill=(3, 32, 28))
    tf = font(17, "Semibold")
    tag = "Open-source · @hypurrext"
    tw = d.textlength(tag, font=tf)
    d.text((W - 84 - tw, by + 14), tag, font=tf, fill=DIM)
    c.convert("RGB").save(os.path.join(OUT, "05-tools.png"), quality=95)
    print("saved 05-tools")


SLIDES = {
    "01": slide_cover,
    "02": slide_onepanel,
    "03": lambda: slide_feature(
        "03-flow.png", "twap-btc",
        ["See incoming", "pressure — before", "the tape."],
        ["Active TWAPs, buy/sell split, and projected",
         "1h & 24h order flow for your coin."],
        "▲ +$323K projected buy flow · 24h",
        ["Perp & spot TWAPs, ranked by size",
         "BUY vs SELL imbalance at a glance"]),
    "04": lambda: slide_feature(
        "04-funding.png", "fr-hype",
        ["Know the carry.", "Then lock it."],
        ["Annualized funding history, cross-venue basis,",
         "and a one-tap Boros funding hedge."],
        "Lock funding at 7.5% fixed · vs 10.8% 30d",
        ["1D / 7D / 30D windows + live ‘now’ APR",
         "Hedge funding cost on Pendle Boros"]),
    "05": slide_tools,
}

if __name__ == "__main__":
    keys = sys.argv[1:] or list(SLIDES.keys())
    for k in keys:
        SLIDES[k]()
