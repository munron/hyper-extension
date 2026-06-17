#!/usr/bin/env python3
"""Render the X launch hero from generated backdrop plus real captures."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "store-assets" / "raw2"
OUT = ROOT / "marketing" / "launch-hero.png"
LOGO = ROOT / "public" / "icon128.png"
FONT = "/System/Library/Fonts/SFNS.ttf"

W, H, SS = 1600, 900, 3
CW, CH = W * SS, H * SS

MINT = (80, 210, 193)
BRIGHT = (95, 227, 194)
WHITE = (244, 250, 248)
SOFT = (182, 203, 199)
MUTED = (116, 149, 143)

CROP_BOTTOM = {
    "fr-hype": 2440,
    "arb-btc": 2670,
    "liq-btc": 2310,
}


@dataclass(frozen=True)
class Panel:
    name: str
    x: int
    y: int
    width: int
    angle: float = 0
    brightness: float = 1
    opacity: int = 255
    glow: int = 60


def sf(size: int, weight: str = "Regular") -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(FONT, size * SS)
    try:
        font.set_variation_by_name(weight)
    except OSError:
        pass
    return font


def cover(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGB")
    scale = max(CW / im.width, CH / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.Resampling.LANCZOS)
    left = (im.width - CW) // 2
    top = (im.height - CH) // 2
    return im.crop((left, top, left + CW, top + CH)).convert("RGBA")


def add_launch_grade(canvas: Image.Image) -> None:
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    # A soft left scrim preserves readable text while keeping the abstract light.
    for x in range(760 * SS):
        t = x / (760 * SS)
        alpha = int(188 * (1 - t) ** 1.9)
        d.line((x, 0, x, CH), fill=(1, 8, 9, alpha))

    # Gentle top/bottom vignette for an announcement-image crop.
    vignette = Image.new("L", canvas.size, 0)
    vd = ImageDraw.Draw(vignette)
    for y in range(CH):
        edge = min(y / CH, 1 - y / CH)
        alpha = int(115 * max(0, 1 - edge / 0.32) ** 1.8)
        vd.line((0, y, CW, y), fill=alpha)
    vlayer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    vlayer.putalpha(vignette)
    canvas.alpha_composite(vlayer)
    canvas.alpha_composite(overlay)


def panel_image(spec: Panel) -> Image.Image:
    src = Image.open(RAW / f"{spec.name}.png").convert("RGB")
    src = src.crop((0, 0, src.width, CROP_BOTTOM[spec.name]))
    target_w = spec.width * SS
    target_h = round(src.height * target_w / src.width)
    src = src.resize((target_w, target_h), Image.Resampling.LANCZOS)

    inset = 4 * SS
    radius = 20 * SS
    framed = Image.new("RGBA", (target_w + inset * 2, target_h + inset * 2), (4, 16, 17, 255))

    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, src.width - 1, src.height - 1), radius=radius, fill=255)
    src.putalpha(mask)
    framed.alpha_composite(src, (inset, inset))

    fd = ImageDraw.Draw(framed)
    fd.rounded_rectangle(
        (1, 1, framed.width - 2, framed.height - 2),
        radius=radius + inset,
        outline=(117, 236, 211, 142),
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
        framed = framed.rotate(spec.angle, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0, 0))
    return framed


def place_panel(canvas: Image.Image, spec: Panel) -> None:
    panel = panel_image(spec)
    x = spec.x * SS - panel.width // 2
    y = spec.y * SS - panel.height // 2

    if spec.glow:
        glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        pad_x, pad_y = 58 * SS, 30 * SS
        gd.rounded_rectangle(
            (x - pad_x, y - pad_y, x + panel.width + pad_x, y + panel.height + pad_y),
            radius=70 * SS,
            fill=(*MINT, spec.glow),
        )
        canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(76 * SS)))

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (x + 14 * SS, y + 25 * SS, x + panel.width + 14 * SS, y + panel.height + 32 * SS),
        radius=30 * SS,
        fill=(0, 0, 0, 175),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(31 * SS)))
    canvas.alpha_composite(panel, (x, y))


def tracking(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font: ImageFont.FreeTypeFont, fill, spacing: float) -> None:
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing * SS


def draw_text(canvas: Image.Image) -> None:
    d = ImageDraw.Draw(canvas)

    logo = Image.open(LOGO).convert("RGBA").resize((42 * SS, 42 * SS), Image.Resampling.LANCZOS)
    canvas.alpha_composite(logo, (96 * SS, 78 * SS))
    tracking(d, (154 * SS, 88 * SS), "HYPURR EXTENSION", sf(18, "Bold"), WHITE, 1.55)

    x = 96 * SS
    y = 276 * SS
    headline = ["Every edge for", "the coin you're", "trading."]
    head_font = sf(74, "Heavy")
    line_h = 78 * SS
    for line in headline:
        d.text((x, y), line, font=head_font, fill=WHITE, stroke_width=1 * SS, stroke_fill=(4, 15, 15))
        y += line_h

    y += 24 * SS
    d.text(
        (x, y),
        "A live Hyperliquid side panel - free & open-source.",
        font=sf(25, "Regular"),
        fill=SOFT,
    )

    d.line((96 * SS, 646 * SS, 188 * SS, 646 * SS), fill=(*BRIGHT, 210), width=3 * SS)
    d.text((96 * SS, 806 * SS), "@hypurrext", font=sf(23, "Semibold"), fill=(*MUTED, 255))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: compose_launch_hero.py <generated-backdrop.png>")

    canvas = cover(Path(sys.argv[1]))
    add_launch_grade(canvas)

    panels = [
        Panel("liq-btc", 1282, 492, 382, -6.0, 0.50, 218, 20),
        Panel("arb-btc", 1062, 518, 374, 7.0, 0.55, 226, 24),
        Panel("fr-hype", 1218, 460, 452, -1.0, 1.0, 255, 78),
    ]
    for panel in panels:
        place_panel(canvas, panel)

    draw_text(canvas)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    final = canvas.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    final.save(OUT, quality=96)
    print(OUT)


if __name__ == "__main__":
    main()
