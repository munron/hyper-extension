#!/usr/bin/env python3
"""Render the five Chrome Web Store launch images from real UI captures."""

from pathlib import Path
from dataclasses import dataclass
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "store-assets" / "raw2"
BG = ROOT / "store-assets" / "bg"
OUT = ROOT / "store-assets" / "final5"
LOGO = ROOT / "public" / "icon128.png"

W, H, SS = 1280, 800, 3
CW, CH = W * SS, H * SS
MINT = (80, 210, 193)
BRIGHT = (95, 227, 194)
WHITE = (244, 249, 248)
SOFT = (180, 199, 196)
MUTED = (126, 151, 147)
FONT = "/System/Library/Fonts/SFNS.ttf"

# Every crop ends on a complete visual section or list row.
CROP_BOTTOM = {
    "fr-hype": 2440,
    "arb-btc": 2670,
    "liq-btc": 2310,
    "twap-btc": 2790,
    "etf-hype": 2050,
    "news-hype": 2670,
    "stops-btc": 2310,
}


@dataclass(frozen=True)
class Panel:
    name: str
    x: int
    y: int
    width: int = 350
    angle: float = 0
    brightness: float = 1
    opacity: int = 255
    glow: int = 70


def sf(size, weight="Regular"):
    f = ImageFont.truetype(FONT, size * SS)
    try:
        f.set_variation_by_name(weight)
    except OSError:
        pass
    return f


def cover(path):
    im = Image.open(path).convert("RGB")
    scale = max(CW / im.width, CH / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
    left = (im.width - CW) // 2
    top = (im.height - CH) // 2
    return im.crop((left, top, left + CW, top + CH)).convert("RGBA")


def scrim(canvas, strength=218, reach=700):
    mask = Image.new("L", (CW, CH), 0)
    draw = ImageDraw.Draw(mask)
    for x in range(reach * SS):
        t = x / (reach * SS)
        alpha = int(strength * (1 - t) ** 1.7)
        draw.line((x, 0, x, CH), fill=alpha)
    layer = Image.new("RGBA", canvas.size, (1, 8, 9, 0))
    layer.putalpha(mask)
    canvas.alpha_composite(layer)


def panel_image(spec):
    src = Image.open(RAW / f"{spec.name}.png").convert("RGB")
    src = src.crop((0, 0, src.width, CROP_BOTTOM[spec.name]))
    target_w = spec.width * SS
    target_h = round(src.height * target_w / src.width)
    src = src.resize((target_w, target_h), Image.Resampling.LANCZOS)

    inset = 3 * SS
    radius = 17 * SS
    framed = Image.new("RGBA", (target_w + inset * 2, target_h + inset * 2), (4, 16, 17, 255))
    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, src.width - 1, src.height - 1), radius=radius, fill=255)
    src.putalpha(mask)
    framed.alpha_composite(src, (inset, inset))
    fd = ImageDraw.Draw(framed)
    fd.rounded_rectangle(
        (1, 1, framed.width - 2, framed.height - 2),
        radius=radius + inset,
        outline=(113, 225, 204, 145),
        width=2 * SS,
    )

    if spec.brightness != 1:
        alpha = framed.getchannel("A")
        rgb = ImageEnhance.Brightness(framed.convert("RGB")).enhance(spec.brightness)
        framed = rgb.convert("RGBA")
        framed.putalpha(alpha)
    if spec.opacity != 255:
        framed.putalpha(framed.getchannel("A").point(lambda a: a * spec.opacity // 255))
    if spec.angle:
        framed = framed.rotate(
            spec.angle,
            expand=True,
            resample=Image.Resampling.BICUBIC,
            fillcolor=(0, 0, 0, 0),
        )
    return framed


def place_panel(canvas, spec):
    panel = panel_image(spec)
    x = spec.x * SS - panel.width // 2
    y = spec.y * SS - panel.height // 2

    if spec.glow:
        glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        pad_x, pad_y = 55 * SS, 28 * SS
        gd.rounded_rectangle(
            (x - pad_x, y - pad_y, x + panel.width + pad_x, y + panel.height + pad_y),
            radius=65 * SS,
            fill=(*MINT, spec.glow),
        )
        canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(65 * SS)))

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (x + 9 * SS, y + 20 * SS, x + panel.width + 9 * SS, y + panel.height + 25 * SS),
        radius=24 * SS,
        fill=(0, 0, 0, 185),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(25 * SS)))
    canvas.alpha_composite(panel, (x, y))


def tracking(draw, xy, text, font, fill, spacing):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing * SS


def brand(canvas, x=74, y=64):
    logo = Image.open(LOGO).convert("RGBA").resize((34 * SS, 34 * SS), Image.Resampling.LANCZOS)
    canvas.alpha_composite(logo, (x * SS, y * SS))
    d = ImageDraw.Draw(canvas)
    tracking(d, ((x + 48) * SS, (y + 7) * SS), "HYPURR EXTENSION", sf(16, "Bold"), WHITE, 1.4)


def copy(canvas, headline, sub=None, y=245, size=58):
    d = ImageDraw.Draw(canvas)
    x = 74 * SS
    yy = y * SS
    f = sf(size, "Heavy")
    line_h = int(size * 1.08) * SS
    for line in headline:
        d.text((x, yy), line, font=f, fill=WHITE, stroke_width=1 * SS, stroke_fill=(7, 18, 18))
        yy += line_h
    if sub:
        yy += 18 * SS
        d.text((x, yy), sub, font=sf(20, "Regular"), fill=SOFT)
    return yy // SS


def button(canvas, x, y):
    d = ImageDraw.Draw(canvas)
    label = "Add to Chrome"
    f = sf(20, "Bold")
    w = int(d.textlength(label, font=f) / SS) + 58
    d.rounded_rectangle(
        (x * SS, y * SS, (x + w) * SS, (y + 52) * SS),
        radius=26 * SS,
        fill=BRIGHT,
    )
    d.text(((x + 29) * SS, (y + 13) * SS), label, font=f, fill=(3, 27, 23))


SLIDES = {
    1: {
        "panels": [
            Panel("liq-btc", 856, 444, 330, 6, .55, 235, 25),
            Panel("arb-btc", 1082, 430, 338, -6, .70, 245, 40),
            Panel("fr-hype", 858, 442, 374, -1.2, 1, 255, 78),
        ],
        "headline": ["Every edge for", "the coin you're", "trading."],
        "sub": "Eleven live tools in one Hyperliquid side panel.",
        "y": 244,
        "size": 58,
        "brand": True,
    },
    2: {
        "panels": [
            Panel("etf-hype", 684, 472, 302, 8, .52, 225, 20),
            Panel("twap-btc", 1120, 470, 300, -8, .52, 225, 20),
            Panel("liq-btc", 810, 458, 326, 4.5, .72, 245, 35),
            Panel("fr-hype", 1035, 450, 330, -4.5, .78, 248, 42),
            Panel("arb-btc", 918, 425, 355, 0, 1, 255, 75),
        ],
        "headline": ["An entire trading", "desk. One panel."],
        "sub": "Eleven live tools. Zero tab switching.",
        "y": 132,
        "size": 48,
        "brand": True,
    },
    3: {
        "panels": [
            Panel("stops-btc", 802, 450, 336, 6, .58, 238, 28),
            Panel("etf-hype", 1080, 438, 346, -6, .74, 248, 45),
            Panel("news-hype", 900, 424, 350, -1, 1, 255, 72),
        ],
        "headline": ["Built for the coin", "on your screen."],
        "sub": "Switch markets. The panel follows instantly.",
        "y": 266,
        "size": 55,
        "brand": False,
    },
    4: {
        "panels": [
            Panel("fr-hype", 786, 452, 338, 6, .58, 238, 28),
            Panel("liq-btc", 1085, 442, 346, -6, .76, 248, 44),
            Panel("arb-btc", 902, 416, 360, -1, 1, 255, 78),
        ],
        "headline": ["See what other", "traders don't."],
        "sub": "Basis, liquidation maps, and funding hedges.",
        "y": 270,
        "size": 57,
        "brand": False,
    },
    5: {
        "panels": [
            Panel("arb-btc", 1080, 448, 338, -6, .62, 240, 32),
            Panel("fr-hype", 866, 430, 386, -1, 1, 255, 82),
        ],
        "headline": ["Add it to Chrome.", "Free."],
        "sub": "No accounts. No API keys. Open-source.",
        "y": 246,
        "size": 61,
        "brand": True,
    },
}


def render(number):
    cfg = SLIDES[number]
    canvas = cover(BG / f"{number:02d}.png")
    for spec in cfg["panels"]:
        place_panel(canvas, spec)
    scrim(canvas)
    if cfg["brand"]:
        brand(canvas)
    bottom = copy(canvas, cfg["headline"], cfg["sub"], cfg["y"], cfg["size"])
    if number == 5:
        button(canvas, 74, bottom + 62)
        ImageDraw.Draw(canvas).text((74 * SS, (bottom + 132) * SS), "@hypurrext", font=sf(17, "Semibold"), fill=MUTED)
    final = canvas.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    final.save(OUT / f"{number:02d}.png", optimize=True)


if __name__ == "__main__":
    for n in range(1, 6):
        render(n)
        print(f"rendered {OUT / f'{n:02d}.png'}")
