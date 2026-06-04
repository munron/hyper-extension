#!/usr/bin/env python3
"""Compose a 1280x800 Chrome Web Store screenshot:
branded dark-teal/mint background + real side-panel capture + headline copy."""
import sys, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800
# palette (LP)
BG1 = (6, 21, 21)
BG2 = (4, 16, 15)
MINT = (80, 210, 193)
MINT_DK = (62, 193, 173)
WHITE = (240, 248, 246)
DIM = (150, 172, 169)
MUTE = (110, 132, 130)

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
    # vertical gradient
    base = Image.new("RGB", (W, H), BG2)
    px = base.load()
    for y in range(H):
        t = y / H
        col = lerp(BG1, BG2, t)
        for x in range(W):
            px[x, y] = col
    # radial mint glow top-right + bottom-left
    glow = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(glow)
    def radial(cx, cy, r, peak):
        for rr in range(r, 0, -6):
            a = int(peak * (1 - rr / r) ** 2)
            gd.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=a)
    radial(int(W*0.80), int(H*-0.05), 620, 90)
    radial(int(W*0.08), int(H*0.95), 520, 55)
    radial(int(W*0.70), int(H*0.52), 520, 60)
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    mint_layer = Image.new("RGB", (W, H), MINT)
    base = Image.composite(mint_layer, base, glow.point(lambda v: int(v*0.5)))
    # faint grid
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    step = 46
    for x in range(0, W, step):
        g.line([(x, 0), (x, H)], fill=(255, 255, 255, 7))
    for y in range(0, H, step):
        g.line([(0, y), (W, y)], fill=(255, 255, 255, 7))
    base = Image.alpha_composite(base.convert("RGBA"), grid)
    return base.convert("RGB")

def rounded(img, rad):
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, img.size[0], img.size[1]], radius=rad, fill=255)
    img.putalpha(mask)
    return img

def trim_bottom(im, pad=30):
    """Remove empty rows at the bottom of the panel crop. Samples only the
    central columns (skips the faint card border at the edges) and counts
    reasonably-bright pixels so a stray border pixel can't block the trim."""
    g = im.convert("L")
    px = g.load()
    w, h = g.size
    x0, x1 = int(w * 0.12), int(w * 0.88)
    last = h - 1
    for y in range(h - 1, -1, -1):
        bright = sum(1 for x in range(x0, x1, 5) if px[x, y] > 60)
        if bright >= 3:        # found a row of real content
            last = min(h - 1, y + pad)
            break
    return im.crop((0, 0, w, last + 1))

def paste_panel(canvas, panel_path, crop, panel_w, right_margin):
    im = Image.open(panel_path).convert("RGB")
    if crop:
        im = im.crop(crop)
    im = trim_bottom(im)
    scale = panel_w / im.size[0]
    target_h = min(764, int(im.size[1] * scale))
    scale = target_h / im.size[1]
    new = im.resize((int(im.size[0]*scale), target_h), Image.LANCZOS)
    new = rounded(new, 26)
    pw, ph = new.size
    x = W - right_margin - pw
    y = (H - ph)//2
    # soft shadow
    sh = Image.new("RGBA", canvas.size, (0,0,0,0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle([x-6, y+14, x+pw+6, y+ph+22], radius=30, fill=(0,0,0,150))
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    canvas.alpha_composite(sh)
    # mint border halo
    bd = Image.new("RGBA", canvas.size, (0,0,0,0))
    bdd = ImageDraw.Draw(bd)
    bdd.rounded_rectangle([x-2, y-2, x+pw+2, y+ph+2], radius=28, outline=(80,210,193,120), width=3)
    canvas.alpha_composite(bd)
    canvas.alpha_composite(new.convert("RGBA"), (x, y))
    return x  # left edge of panel

def draw_text_block(canvas, x, headline, sub, bullets, logo_path):
    d = ImageDraw.Draw(canvas)
    y = 150
    # brand row
    try:
        logo = Image.open(logo_path).convert("RGBA").resize((40, 40), Image.LANCZOS)
        canvas.alpha_composite(logo, (x, y))
    except Exception:
        pass
    d.text((x+52, y+6), "Hypurr", font=font(26, "Bold"), fill=WHITE)
    # pill
    pill = "LIVE · for the coin you're viewing"
    pf = font(16, "Semibold")
    pw = d.textlength(pill, font=pf)
    d.rounded_rectangle([x, y+60, x+pw+44, y+96], radius=18, fill=(12, 34, 31, 235), outline=(80,210,193,150), width=1)
    d.ellipse([x+16, y+73, x+26, y+83], fill=MINT)
    d.text((x+36, y+69), pill, font=pf, fill=(150, 240, 224))
    y += 130
    # headline (wrap)
    hf = font(58, "Heavy")
    for line in headline:
        d.text((x, y), line, font=hf, fill=WHITE)
        y += 66
    y += 18
    # subtitle (wrap provided as list)
    sf = font(23, "Regular")
    for line in sub:
        d.text((x, y), line, font=sf, fill=DIM)
        y += 33
    y += 22
    # bullets
    bf = font(21, "Medium")
    for b in bullets:
        d.ellipse([x+2, y+9, x+12, y+19], fill=MINT)
        d.text((x+26, y), b, font=bf, fill=(206, 224, 221))
        y += 38

def compose(cfg):
    canvas = make_bg().convert("RGBA")
    paste_panel(canvas, cfg["panel"], cfg.get("crop"), cfg.get("panel_w", 300), cfg.get("right_margin", 80))
    draw_text_block(canvas, cfg.get("text_x", 84),
                    cfg["headline"], cfg["sub"], cfg["bullets"], cfg["logo"])
    out = cfg["out"]
    canvas.convert("RGB").save(out, quality=95)
    print("saved", out)

LOGO = "public/icon128.png"
PANEL_X = 2630  # left edge of the side panel in the full-window captures

CONFIGS = {
    "01": {
        "panel": "store-assets/raw/01-twap.png", "crop": (PANEL_X, 0, 3360, 1858),
        "headline": ["Incoming buy", "pressure —", "before the tape."],
        "sub": ["Active TWAPs, buy/sell split, and projected",
                "1h & 24h flow for the coin you're trading."],
        "bullets": ["Live TWAP order flow, perp & spot",
                    "BUY vs SELL split at a glance",
                    "Biggest queued orders, ranked"],
        "out": "store-assets/final/01-twap.png",
    },
    "02": {
        "panel": "store-assets/raw/02-fr.png", "crop": (PANEL_X, 0, 3360, 1866),
        "headline": ["Read the carry", "at a glance."],
        "sub": ["Annualized funding history with a price overlay,",
                "so you see who's paying whom — live."],
        "bullets": ["1D / 7D / 30D windows + trailing averages",
                    "\"Now\" APR that ticks every 10 seconds",
                    "Spot funding / price divergences fast"],
        "out": "store-assets/final/02-fr.png",
    },
    "03": {
        "panel": "store-assets/raw/03-liq.png", "crop": (PANEL_X, 0, 3360, 1854),
        "headline": ["See where", "it breaks."],
        "sub": ["Liquidation levels banded around price —",
                "the magnets and the cascade triggers."],
        "bullets": ["Long vs short at-risk notional",
                    "Cumulative curves + current price line",
                    "Nearest sizeable positions, ranked"],
        "out": "store-assets/final/03-liq.png",
    },
    "04": {
        "panel": "store-assets/raw/04-arb.png", "crop": (PANEL_X, 0, 3360, 1886),
        "headline": ["Funding & basis,", "10+ venues."],
        "sub": ["Compare carry and price gap vs Binance,",
                "Bybit, OKX and seven more — in one list."],
        "bullets": ["Best long/short leg, auto-picked",
                    "72h FR-spread & basis chart",
                    "CEX + DEX, live every minute"],
        "out": "store-assets/final/04-arb.png",
    },
    "05": {
        "panel": "store-assets/raw/05-news.png", "crop": (PANEL_X, 0, 3360, 1868),
        "headline": ["The story", "behind the move."],
        "sub": ["When a coin rips, know why — fast.",
                "Per-coin headlines, ranked by what matters."],
        "bullets": ["Smart per-coin query, de-duplicated",
                    "Ranked by recency × source weight",
                    "Free & keyless — no account needed"],
        "out": "store-assets/final/05-news.png",
    },
}

if __name__ == "__main__":
    keys = sys.argv[1:] or list(CONFIGS.keys())
    for k in keys:
        compose({**CONFIGS[k], "logo": LOGO, "panel_w": 300, "right_margin": 80, "text_x": 84})
