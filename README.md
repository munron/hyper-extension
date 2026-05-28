# Hypurr Extension

A Chrome side-panel companion for [Hyperliquid](https://app.hyperliquid.xyz/) that surfaces the on-chart context perp traders actually look for — and pulls it from sources Hyperliquid itself doesn't show.

The panel activates against the active `app.hyperliquid.xyz/trade/<COIN>` tab and rebuilds itself for whichever asset you're looking at: BTC, HYPE, xyz:WTIOIL, xyz:NVDA, all of them.

---

## What it does

### Funding Rate (`FR` tab)

- **FR chart** — Hyperliquid funding history annualised to APR, step-after rendered (matches how funding actually accrues), with selectable 1D / 7D / 30D windows, hover crosshair, 1D/7D/30D trailing-average reference lines, and live current-funding readout.
- **Cross-venue arbitrage scanner** — Compares HL's funding against **10 other perp venues** in one panel and shows the best HL↔X dislocation as an actionable arb (long-leg / short-leg / annualised spread). Venues currently wired:

  | CEX | DEX |
  | --- | --- |
  | Binance, Bybit, OKX, Aster | Lighter, Pacifica, Extended, edgeX, Grvt, Variational |

- **72h spread history chart** — Step-after lines per leg, time-weighted average dashed line with right-edge value pill, click-to-toggle HL / counterparty / Avg / Spread chips, hover tooltip with date / HL / cp / Δ. Nested inside the arb summary card so "current spread + how stable it has been" reads as one story.
- **Sub-DEX coins supported** — Commodities, stocks, and FX listed on Hyperliquid's builder DEXs (`xyz:`, `flx:`) get FR / arb data too. The non-HL venues are queried with each venue's own symbol convention (e.g. HL `xyz:CL` → Lighter `WTI`, Binance `CL`, Extended `WTI`) via a small alias table in [`src/lib/exchanges.ts`](src/lib/exchanges.ts).

### Liquidation & Stops (`Liquidation` / `Stops` tabs)

- Heatmap of nearby liquidation bands and resting stop-loss clusters, sourced from Hyperdash's live band feed.
- Top-5 positions list per side (long / short), with addresses linking through to position pages.
- Gated on main-DEX coins — Hyperdash doesn't carry sub-DEX assets.

### TWAPs (`TWAPs` tab)

- Live in-flight TWAP order list for the current coin, with progress and remaining size.

### Stocks (`Stocks` tab)

When the active coin is annotated as a stock by HL (e.g. `xyz:AAPL`, `xyz:NVDA`, `xyz:MSFT`, `xyz:HYUNDAI`, ...), an additional tab unlocks with traditional-finance context that perp pricing alone doesn't give you:

- **Hero**: current price + day change + a single **live extended-session tick** (Pre-market / After-hours / Overnight) backed by Yahoo's WebSocket streamer — the only public source that exposes Blue Ocean ATS overnight prices.
- **Tiles**: market cap, trailing & forward P/E, trailing & forward EPS, dividend yield, day range, volume.
- **Next earnings callout** with a relative-days countdown.
- **Earnings Trends, Yahoo-style**:
  - EPS dot chart — last 4 reported quarters (estimate ring + actual dot, beat/miss caption) plus the next quarter's consensus estimate with its expected report date, separated by a dashed divider.
  - Revenue vs Earnings paired bars with an Annual / Quarterly toggle, mint for revenue, warn for net income (red for negative quarters).

Regional listings (Hyundai, Samsung Electronics, SK Hynix, Kioxia, SoftBank) are auto-mapped to their Yahoo tickers (`005380.KS`, `005930.KS`, `000660.KS`, `285A.T`, `9984.T`).

### NFT (`NFT` tab, HYPE only)

OpenSea-backed Hypurr collection chart — floor price + sales volume, multiple timeframes.

---

## Install

The extension isn't published to the Chrome Web Store yet. Load it unpacked:

```bash
git clone https://github.com/<your-fork>/hyper-extension.git
cd hyper-extension
npm install
npm run build           # writes the production extension to ./dist
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → pick the `dist/` directory
4. Pin the extension and click its icon while on any `app.hyperliquid.xyz/trade/...` page

For iterating, `npm run dev` runs Vite + the CRXJS HMR. Re-load the extension in `chrome://extensions/` after each meaningful manifest change.

---

## Architecture

```
src/
  background/        Service worker — keeps the side panel wired to the active tab
  sidepanel/         React UI (one file per tab + App.tsx tab router)
  lib/
    hyperliquid.ts   HL info-endpoint client (predicted funding, candles, meta, dex-aware)
    coinMap.ts       Builds the canonical coin index across main + sub-DEX universes
    exchanges.ts     10-venue funding aggregator + history fetchers + symbol alias table
    hyperdash.ts     Liquidation & stop band data
    opensea.ts       Hypurr collection chart data
    yahooFinance.ts  Yahoo quoteSummary client (with crumb-auth flow) + chart endpoint
    yahooStreamer.ts Yahoo WebSocket streamer + hand-rolled protobuf decoder
    symbol.ts        Active-tab URL → coin extraction
```

### Tech stack

- **Vite** + **React 19** + **TypeScript**
- **Chrome Manifest V3** via the **CRXJS Vite plugin**
- Zero runtime dependencies beyond React itself — every API client is hand-written against the upstream endpoint to keep the bundle small and the data path transparent

### Data sources

| Source | Used for | Auth |
| --- | --- | --- |
| Hyperliquid Info API | Funding, candles, meta, sub-DEX universes, predicted-fundings bundle | None |
| Hyperdash | Liquidation & stop band data | None |
| OpenSea GraphQL | Hypurr NFT collection chart | None |
| Yahoo Finance REST (`/v8/finance/chart`, `/v10/finance/quoteSummary`) | Stock price, fundamentals, earnings trends | Crumb cookie dance |
| Yahoo Finance WebSocket (`wss://streamer.finance.yahoo.com/`) | Live extended-session ticks (Pre / Post / Overnight) | None |
| Binance / Bybit / OKX / Aster / Lighter / Pacifica / Extended / edgeX / Grvt / Variational | Per-venue funding & funding history | None |

No API keys are embedded; everything runs against public endpoints. The Yahoo crumb flow is the same one Yahoo's own web client uses.

### Why a hand-rolled protobuf decoder

Yahoo's WebSocket pushes base64-encoded protobuf `PricingData` frames. We need exactly five fields out of it (`id`, `price`, `change`, `changePercent`, `marketHours`); adding `google-protobuf` would add ~80 KB to the extension bundle for that. [`src/lib/yahooStreamer.ts`](src/lib/yahooStreamer.ts) decodes the frame in ~40 lines with no dependency.

---

## Notable design notes

- **Funding-rate semantics**: every funding visualization in the extension is rendered **step-after**, because funding is a discrete event (charged hourly on HL, 8-hourly on most CEXs) that's held constant between settlements. Linear interpolation between samples — which most charting libraries do by default — implies a continuous drift that didn't actually happen.
- **Sub-DEX awareness**: HL splits its perp universe across a main DEX and named builder DEXs (`xyz`, `flx`, ...). The coin index pre-fetches every sub-universe so `xyz:WTIOIL` etc. route correctly. Tabs that depend on Hyperdash-backed data (Liquidation, Stops) gate themselves on `hasMainPerp`, while FR / Stocks gate on `hasPerp` (any DEX).
- **Symbol aliases instead of fuzzy matching**: cross-venue listings for the same underlying use different symbols (HL `CL` ↔ Lighter `WTI` ↔ Binance `BZ` for Brent). A small explicit table in `exchanges.ts` covers the ~15 actual divergences observed across venues; anything that matches natively (AAPL, NVDA, BRENTOIL, NATGAS) needs no entry. Maintenance is one-line-per-divergence.
- **Memory tracking**: the [`memory/`](memory/) directory in the Claude project notes records non-obvious API quirks (Lighter funding-rate units, edgeX `filterSettlementFundingRate`, Grvt nanoseconds, Hyperdash band semantics, etc.) so future iterations don't re-discover them.

---

## Roadmap / known limits

- Yahoo's REST endpoints stop publishing extended-hours data at the 8 PM ET post-market close; the live streamer takes over for the Overnight window. If Yahoo changes either protocol, the Stocks tab degrades to last-known REST data.
- Liquidation / Stops are main-DEX only (Hyperdash carries only those bands).
- The non-HL venue listings are surveyed at code-time. New commodity / stock listings on those venues may need a one-line `VENUE_ALIASES` entry.

---

## License

MIT.
