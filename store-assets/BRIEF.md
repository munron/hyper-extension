# Brief — Chrome Web Store screenshots for "Hypurr Extension"

Produce **5 polished promo images, exactly 1280×800 px PNG**, into `store-assets/final5/`
named `01.png … 05.png`. Aesthetic target: a high-end fintech product-launch page
(think TradingView's landing hero) — cinematic, premium, cohesive, exciting.

You have full latitude to make these look genuinely great. Write whatever code you
need and **iterate: open your own output, judge it, and fix problems before finishing.**

## Hard quality requirements (these are why the last attempt looked bad)
- **No jagged / aliased edges.** When scaling or rotating panels, supersample:
  composite at 2–3× then downscale with LANCZOS. Rounded corners and any border
  must be smooth.
- **Consistent device framing.** Put every panel screenshot in a uniform rounded
  "window" frame: same corner radius, same thin border, same soft drop shadow.
  Keep panel sizes harmonious — do NOT mix wildly different scales in one image.
- **Clean crops.** Trim each panel's empty bottom area. Crop to a consistent,
  pleasing height so panels in the same image match. Never show a half-cut row at
  the bottom edge of a frame.
- **The UI must stay pixel-accurate.** You may crop, scale, frame, tilt, shadow,
  glow, dim. You must NOT redraw, repaint, or hallucinate the UI — these are real
  product screenshots and the store requires that. Do not use image-generation to
  recreate the panels; only composite the real PNGs with code.
- Text must be crisp and legible (add a subtle dark scrim behind headlines over
  busy backgrounds).

## Materials (all under store-assets/)
- Real side-panel captures: `raw2/*.png` (~1320 px wide, tall, dark UI). Inventory:
  - `fr-hype.png`     — Funding Rate chart + Boros hedge card (the hero panel)
  - `twap-btc.png`    — TWAP order-flow, buy/sell pressure, ranked list
  - `liq-btc.png`     — Liquidation map (histogram + cumulative curves)
  - `stops-btc.png`   — Stop-order map
  - `arb-btc.png`     — Cross-venue funding/basis vs 10+ venues
  - `news-hype.png`   — Per-coin ranked news
  - `etf-hype.png`    — HYPE spot-ETF net flow + volume charts
  - `revenue-hype.png`— Protocol revenue / buybacks
  (Each capture includes the panel header: coin name + tab strip. You may keep the
  header for context or crop it off — your call, but be consistent within an image.)
- Cinematic backdrops (already AI-generated, abstract, no text): `bg/01.png … 05.png`
  (1536×1024). Use these as backgrounds (cover-fit/crop to 1280×800). You may also
  generate new backdrops with your image tool if you want — abstract only, NO text,
  NO UI, dark teal #061515 + mint #50d2c1 glow.
- Brand: logo `public/icon128.png`; product name **"Hypurr Extension"**; accent mint
  `#50d2c1` / bright `#5fe3c2`; X handle **@hypurrext**.

## Slides (copy is a starting point — refine wording if you can make it punchier)
1. **Hero.** Headline: "Every edge for the coin you're trading." Sub: "Eleven live
   tools in one Hyperliquid side panel." Brand lockup (logo + HYPURR EXTENSION)
   top-left. Panels: `fr-hype` as the front hero, `arb-btc` + `liq-btc` behind.
2. **Breadth.** Headline: "An entire trading desk — in one panel." A confident fan
   of 4–5 panels (e.g. twap-btc, fr-hype, liq-btc, arb-btc, etf-hype) with depth.
3. **Follows your coin.** Headline: "Built for the coin on your screen." Sub:
   "Switch markets — the panel follows, instantly." Panels: news-hype, etf-hype,
   stops-btc.
4. **Edge.** Headline: "See what other traders don't." Sub: "Cross-venue basis,
   liquidation maps, funding hedges." Panels: arb-btc front, liq-btc + fr-hype.
5. **CTA.** Headline: "Add it to Chrome. Free." Sub: "No accounts. No API keys.
   Open-source." A mint "Add to Chrome" button + "@hypurrext". Panels: fr-hype hero
   + 1–2 behind.

## Layout system (keep it consistent across all 5)
- Left column for text (headline + sub), with generous margin (~84 px) and a soft
  left-to-right dark scrim for legibility. Panels cluster on the right / center with
  depth (front panel brightest & largest; back panels smaller, dimmer, gently tilted
  ±6–9°). Consistent shadow + mint glow language.
- Use system font SF (`/System/Library/Fonts/SFNS.ttf`); Heavy for headlines.

## Tooling
- Pillow is available at `/tmp/storeimg-venv/bin/python` (Pillow 12). `sips` and
  any system tools are fine too. Put scratch code in `store-assets/`.
- When done, the only required output is `store-assets/final5/01.png … 05.png`,
  each exactly 1280×800.
