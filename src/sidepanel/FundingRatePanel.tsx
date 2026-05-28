import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCandles,
  fetchCurrentFundingApr,
  fetchFundingHistoryRange,
  type Candle,
  type FundingHistoryEntry,
} from "../lib/hyperliquid";
import { type CoinIndex } from "../lib/coinMap";

// How often to refresh the live "now" funding APR readout.
const LIVE_REFRESH_MS = 10_000;

const TIMEFRAMES: { label: string; hours: number }[] = [
  { label: "1D", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
];

// Trailing windows for the average-APR readout / reference line.
const AVG_WINDOWS: { label: string; hours: number }[] = [
  { label: "1D", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
];

// Always pull this much funding history regardless of the selected window, so
// every trailing average is computable even on the 1D view.
const AVG_LOOKBACK_HOURS = 24 * 30;

// Hyperliquid charges funding hourly, so the annualized rate is the hourly
// rate × 24 × 365.
const HOURS_PER_YEAR = 24 * 365;

// Mean APR over the last `windowHours` of funding, anchored at `anchorT`.
// Returns null when no samples fall in the window.
function trailingAvg(
  points: { t: number; apr: number }[],
  windowHours: number,
  anchorT: number,
): number | null {
  const cutoff = anchorT - windowHours * 60 * 60 * 1000;
  let sum = 0;
  let n = 0;
  for (const p of points) {
    if (p.t >= cutoff) {
      sum += p.apr;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 170;
const PAD_LEFT = 30; // funding %-axis gutter
const PAD_RIGHT = 42; // price-axis gutter
const PAD_TOP = 10;
const PLOT_H = 120;
const X_AXIS_H = 14;

function fmtAprAxis(n: number): string {
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0) + "%";
  if (a >= 10) return n.toFixed(0) + "%";
  return n.toFixed(1) + "%";
}

function fmtApr(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
}

function fmtPriceAxis(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const range = max - min;
  const roughStep = range / Math.max(1, target - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / magnitude;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.0001; v += step) {
    ticks.push(parseFloat(v.toFixed(10)));
  }
  return ticks;
}

function dateTicks(tMin: number, tMax: number, count = 4): number[] {
  if (!(tMax > tMin)) return [tMin];
  const step = (tMax - tMin) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(tMin + step * i);
  return out;
}

function fmtDateTick(ms: number, hours: number): string {
  const d = new Date(ms);
  if (hours <= 24) {
    return d.getHours().toString().padStart(2, "0") + ":00";
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtFullDate(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:00`;
}

type Props = { coin: string; coinIndex: CoinIndex | null; refreshKey: number };

export default function FundingRatePanel({ coin, coinIndex, refreshKey }: Props) {
  const [hours, setHours] = useState(24 * 7);
  const [funding, setFunding] = useState<FundingHistoryEntry[] | null>(null);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [fundingLoading, setFundingLoading] = useState(false);
  const [candleLoading, setCandleLoading] = useState(false);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [candleError, setCandleError] = useState<string | null>(null);
  const loading = fundingLoading || candleLoading;
  const error = fundingError ?? candleError;
  const [visibleSeries, setVisibleSeries] = useState({
    apr: true,
    price: true,
    avg: true,
  });
  const toggleSeries = (k: keyof typeof visibleSeries) =>
    setVisibleSeries((s) => ({ ...s, [k]: !s[k] }));
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Live current funding APR, refreshed every 10s — drives the "now" readout so
  // it tracks the rate accruing right now rather than the last settled hour.
  const [liveApr, setLiveApr] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const hasPerp = coinIndex
    ? coinIndex.perpAssetIdByCoin[coin] !== undefined
    : true;

  // Funding history: always pull the full 30D lookback so the 1D/7D/30D
  // trailing averages are computable on any timeframe. Independent of `hours`,
  // so toggling the window doesn't refetch funding (keeps API load low).
  useEffect(() => {
    if (!hasPerp) return;
    let cancelled = false;
    setFundingLoading(true);
    setFundingError(null);
    setHoverIdx(null);
    const endTime = Date.now();
    const startTime = endTime - AVG_LOOKBACK_HOURS * 60 * 60 * 1000;
    fetchFundingHistoryRange(coin, startTime, endTime)
      .then((f) => {
        if (!cancelled) setFunding(f);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.warn("funding fetch failed", e);
        setFundingError(e instanceof Error ? e.message : String(e));
        setFunding(null);
      })
      .finally(() => {
        if (!cancelled) setFundingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coin, refreshKey, hasPerp]);

  // Price candles: scoped to the selected window only.
  useEffect(() => {
    if (!hasPerp) return;
    let cancelled = false;
    setCandleLoading(true);
    setCandleError(null);
    const endTime = Date.now();
    const startTime = endTime - hours * 60 * 60 * 1000;
    fetchCandles(coin, "1h", startTime, endTime)
      .then((c) => {
        if (!cancelled) setCandles(c);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.warn("candles fetch failed", e);
        setCandleError(e instanceof Error ? e.message : String(e));
        setCandles(null);
      })
      .finally(() => {
        if (!cancelled) setCandleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coin, hours, refreshKey, hasPerp]);

  // Real-time "now" funding APR: poll the live current rate every 10s. Silent
  // (no loading state), holds the last good value on a hiccup, and skips while
  // the panel isn't visible.
  useEffect(() => {
    if (!hasPerp) {
      setLiveApr(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      fetchCurrentFundingApr(coin)
        .then((apr) => {
          if (!cancelled && apr !== null) setLiveApr(apr);
        })
        .catch((e: unknown) => {
          console.warn("live funding fetch failed", e);
        });
    };
    setLiveApr(null);
    tick();
    const id = setInterval(() => {
      if (!document.hidden) tick();
    }, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, hasPerp]);

  const view = useMemo(() => {
    if (!funding || funding.length === 0) return null;
    const frAll = funding
      .map((f) => ({
        t: f.time,
        apr: parseFloat(f.fundingRate) * HOURS_PER_YEAR * 100,
      }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.apr))
      .sort((a, b) => a.t - b.t);
    if (frAll.length === 0) return null;

    // Trailing 1D/7D/30D averages from the full lookback, anchored at the
    // latest funding sample — the funding a trader would carry over each
    // horizon. `avgs` keeps window order (for the readout strip).
    const anchorT = frAll[frAll.length - 1].t;
    const avgs = AVG_WINDOWS.map((w) => ({
      label: w.label,
      hours: w.hours,
      apr: trailingAvg(frAll, w.hours, anchorT),
    })).filter(
      (a): a is { label: string; hours: number; apr: number } => a.apr !== null,
    );

    // Displayed funding line is sliced to the selected window.
    const windowStart = anchorT - hours * 60 * 60 * 1000;
    const frWin = frAll.filter((p) => p.t >= windowStart);
    const fr = frWin.length > 0 ? frWin : frAll;

    const px = (candles ?? [])
      .map((c) => ({ t: c.t, price: parseFloat(c.c) }))
      .filter((p) => Number.isFinite(p.t) && p.price > 0)
      .sort((a, b) => a.t - b.t);

    const tMin = Math.min(fr[0].t, px[0]?.t ?? fr[0].t);
    const tMax = Math.max(
      fr[fr.length - 1].t,
      px[px.length - 1]?.t ?? fr[fr.length - 1].t,
    );
    const tSpan = Math.max(1, tMax - tMin);

    // Funding axis always includes 0 so the sign reads clearly. Only the
    // selected window's average is drawn on the chart, and that value is the
    // mean of the displayed points, so it's already within range — no extra
    // padding needed for the other (chart-hidden) horizons.
    const aprVals = fr.map((p) => p.apr);
    const aLo = Math.min(0, ...aprVals);
    const aHi = Math.max(0, ...aprVals);
    const aPad = (aHi - aLo) * 0.12 || 1;
    const aprTicks = niceTicks(aLo - aPad, aHi + aPad, 4);
    const aprMin = Math.min(aLo - aPad, aprTicks[0] ?? aLo);
    const aprMax = Math.max(aHi + aPad, aprTicks[aprTicks.length - 1] ?? aHi);
    const aprSpan = Math.max(1e-6, aprMax - aprMin);

    let priceTicks: number[] = [];
    let pMin = 0;
    let pMax = 1;
    if (px.length > 0) {
      const prices = px.map((p) => p.price);
      const pLo = Math.min(...prices);
      const pHi = Math.max(...prices);
      const pPad = (pHi - pLo) * 0.1 || pLo * 0.05 || 1;
      priceTicks = niceTicks(Math.max(0, pLo - pPad), pHi + pPad, 4);
      pMin = priceTicks.length ? Math.min(priceTicks[0], pLo - pPad) : pLo;
      pMax = priceTicks.length ? Math.max(priceTicks[priceTicks.length - 1], pHi + pPad) : pHi;
    }
    const pSpan = Math.max(1e-6, pMax - pMin);

    const chartLeft = PAD_LEFT;
    const chartRight = CHART_WIDTH - PAD_RIGHT;
    const chartW = chartRight - chartLeft;
    const plotTop = PAD_TOP;
    const plotBottom = plotTop + PLOT_H;
    const xAxisY = plotBottom + X_AXIS_H - 4;

    const xFor = (t: number) => chartLeft + ((t - tMin) / tSpan) * chartW;
    const aprY = (apr: number) =>
      plotTop + (1 - (apr - aprMin) / aprSpan) * PLOT_H;
    const priceY = (p: number) =>
      plotTop + (1 - (p - pMin) / pSpan) * PLOT_H;

    // Step-after: a funding rate is locked in at each funding event and held
    // until the next, so the line should jump vertically at sample boundaries,
    // not slope diagonally between them. The final value is extended flat to
    // the chart's right edge to reflect "still in effect".
    let aprPath = "";
    if (fr.length > 0) {
      aprPath = `M${xFor(fr[0].t).toFixed(2)},${aprY(fr[0].apr).toFixed(2)}`;
      for (let i = 1; i < fr.length; i++) {
        const x = xFor(fr[i].t).toFixed(2);
        aprPath += ` L${x},${aprY(fr[i - 1].apr).toFixed(2)}`;
        aprPath += ` L${x},${aprY(fr[i].apr).toFixed(2)}`;
      }
      const lastApr = aprY(fr[fr.length - 1].apr).toFixed(2);
      aprPath += ` L${chartRight.toFixed(2)},${lastApr}`;
    }
    const pricePath =
      px.length > 1
        ? px
            .map(
              (p, i) =>
                `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(2)},${priceY(p.price).toFixed(2)}`,
            )
            .join(" ")
        : "";

    const zeroY = aprMin < 0 && aprMax > 0 ? aprY(0) : null;

    // Resolve each window's reference-line y; the chart draws only the
    // selected one (as a line + right-axis tag).
    const avgLines = avgs.map((a) => ({ ...a, y: aprY(a.apr) }));

    const meanApr = aprVals.reduce((a, b) => a + b, 0) / aprVals.length;
    const lastApr = fr[fr.length - 1].apr;
    const lastPrice = px.length ? px[px.length - 1].price : 0;
    const firstPrice = px.length ? px[0].price : 0;
    const priceChangePct =
      firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

    return {
      frPoints: fr,
      pxPoints: px,
      aprPath,
      pricePath,
      zeroY,
      aprTicks,
      priceTicks,
      hasPrice: px.length > 0,
      chartLeft,
      chartRight,
      plotTop,
      plotBottom,
      xAxisY,
      aprY,
      priceY,
      xFor,
      tMin,
      tMax,
      lastApr,
      meanApr,
      avgs,
      avgLines,
      lastPrice,
      priceChangePct,
    };
  }, [funding, candles, hours]);

  if (!coinIndex) {
    return (
      <section className="fr">
        <div className="fr-head">
          <span className="fr-head-label">Funding Rate</span>
        </div>
        <div className="fr-status">Loading…</div>
      </section>
    );
  }
  if (!hasPerp) {
    return (
      <section className="fr">
        <div className="fr-head">
          <span className="fr-head-label">Funding Rate</span>
        </div>
        <div className="fr-status">No perpetual market for {coin}</div>
      </section>
    );
  }

  const xTicks = view ? dateTicks(view.tMin, view.tMax, 4) : [];

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!view || view.frPoints.length === 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const chartW = view.chartRight - view.chartLeft;
    if (chartW <= 0) return;
    const t = view.tMin + ((vbX - view.chartLeft) / chartW) * (view.tMax - view.tMin);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < view.frPoints.length; i++) {
      const d = Math.abs(view.frPoints[i].t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };
  const handleLeave = () => setHoverIdx(null);

  // Snap the hovered cursor to the nearest funding point and find the
  // matching price for the readout tooltip.
  const hover =
    view && hoverIdx !== null && hoverIdx < view.frPoints.length
      ? (() => {
          const fp = view.frPoints[hoverIdx];
          const hx = view.xFor(fp.t);
          let price: number | null = null;
          if (view.pxPoints.length) {
            let best = 0;
            let bestD = Infinity;
            for (let i = 0; i < view.pxPoints.length; i++) {
              const d = Math.abs(view.pxPoints[i].t - fp.t);
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
            price = view.pxPoints[best].price;
          }
          const frac = hx / CHART_WIDTH;
          const anchor = frac < 0.3 ? "left" : frac > 0.7 ? "right" : "center";
          return { t: fp.t, apr: fp.apr, price, hx, leftPct: frac * 100, anchor };
        })()
      : null;

  return (
    <section className="fr">
      <div className="fr-head">
        <span className="fr-head-label">Funding Rate · APR</span>
        <div className="nft-tf" role="tablist">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.hours}
              type="button"
              role="tab"
              aria-selected={hours === t.hours}
              className={`nft-tf-btn ${hours === t.hours ? "active" : ""}`}
              onClick={() => setHours(t.hours)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !view && <div className="fr-status">Loading…</div>}
      {error && !view && <div className="fr-status fr-error">Failed to load</div>}
      {!loading && !error && !view && (
        <div className="fr-status">No funding data</div>
      )}

      {view && (
        <>
          <div className="fr-stats">
            <div className="fr-stat">
              <div className="fr-stat-label">Funding APR</div>
              <div
                className={`fr-stat-value ${(liveApr ?? view.lastApr) >= 0 ? "up" : "down"}`}
              >
                {fmtApr(liveApr ?? view.lastApr)}
              </div>
              <div className="fr-stat-sub">now</div>
            </div>
            <div className="fr-stat">
              <div className="fr-stat-label">Avg APR</div>
              <div
                className={`fr-stat-value ${view.meanApr >= 0 ? "up" : "down"}`}
              >
                {fmtApr(view.meanApr)}
              </div>
              <div className="fr-stat-sub">period</div>
            </div>
            <div className="fr-stat">
              <div className="fr-stat-label">Price</div>
              <div className="fr-stat-value">${fmtPrice(view.lastPrice)}</div>
              <div
                className={`fr-stat-sub ${view.priceChangePct >= 0 ? "up" : "down"}`}
              >
                {view.priceChangePct >= 0 ? "+" : ""}
                {view.priceChangePct.toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="fr-legend" role="group" aria-label="Toggle chart series">
            {(
              [
                { key: "apr", label: "Funding APR", swatch: "apr" },
                { key: "price", label: "Price", swatch: "price" },
                { key: "avg", label: "Avg", swatch: "avg" },
              ] as const
            ).map((item) => {
              const on = visibleSeries[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`fr-legend-item ${item.swatch}${on ? "" : " off"}`}
                  onClick={() => toggleSeries(item.key)}
                  aria-pressed={on}
                >
                  <span className="fr-legend-swatch" aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </div>

          {/* Trailing average APR over each horizon — at a glance, the funding
              a trader can expect to carry while holding. The selected window is
              highlighted to tie it to the line drawn on the chart. */}
          {view.avgs.length > 0 && (
            <div
              className="fr-avg-strip"
              role="group"
              aria-label="Average funding APR by horizon"
            >
              <span className="fr-avg-strip-label">Avg APR</span>
              {view.avgs.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className={`fr-avg-pill${a.hours === hours ? " active" : ""}`}
                  onClick={() => setHours(a.hours)}
                  aria-pressed={a.hours === hours}
                  title={`Show ${a.label} average on chart`}
                >
                  <span className="fr-avg-pill-win">{a.label}</span>
                  <span
                    className={`fr-avg-pill-val ${a.apr >= 0 ? "up" : "down"}`}
                  >
                    {fmtApr(a.apr)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            className="fr-chart-wrap"
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
          >
          <svg
            ref={svgRef}
            className="fr-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`${coin} funding rate (APR) and price`}
          >
            {/* Funding gridlines + left axis (%) */}
            {view.aprTicks.map((tk, i) => {
              const y = view.aprY(tk);
              if (y < view.plotTop - 0.5 || y > view.plotBottom + 0.5) return null;
              return (
                <g key={`a${i}`}>
                  <line
                    x1={view.chartLeft}
                    x2={view.chartRight}
                    y1={y}
                    y2={y}
                    className="fr-grid-line"
                  />
                  {visibleSeries.apr && (
                    <text
                      x={view.chartLeft - 4}
                      y={y}
                      className="fr-axis-label fr-axis-apr"
                      textAnchor="end"
                      dominantBaseline="middle"
                    >
                      {fmtAprAxis(tk)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Right axis (price) — intentionally hidden. Only the price line's
                shape matters here (its relationship to funding); exact levels
                live on the main site. The right gutter now hosts the avg tag.
            {view.hasPrice &&
              visibleSeries.price &&
              view.priceTicks.map((tk, i) => {
                const y = view.priceY(tk);
                if (y < view.plotTop - 0.5 || y > view.plotBottom + 0.5) return null;
                return (
                  <text
                    key={`p${i}`}
                    x={view.chartRight + 4}
                    y={y}
                    className="fr-axis-label fr-axis-price"
                    textAnchor="start"
                    dominantBaseline="middle"
                  >
                    {fmtPriceAxis(tk)}
                  </text>
                );
              })} */}

            {/* Zero funding baseline */}
            {visibleSeries.apr && view.zeroY !== null && (
              <line
                x1={view.chartLeft}
                x2={view.chartRight}
                y1={view.zeroY}
                y2={view.zeroY}
                className="fr-zero-line"
              />
            )}

            {/* Price line (muted, behind) */}
            {visibleSeries.price && view.pricePath && (
              <path d={view.pricePath} className="fr-price-line" />
            )}
            {/* Funding APR line (primary) */}
            {visibleSeries.apr && view.aprPath && (
              <path d={view.aprPath} className="fr-apr-line" />
            )}

            {/* Trailing 1D/7D/30D average APR reference lines — the funding a
                trader can expect to carry over each horizon. Replaces the old
                single selected-window average line.
            {visibleSeries.apr && (
              <>
                <line
                  x1={view.chartLeft}
                  x2={view.chartRight}
                  y1={view.aprY(view.meanApr)}
                  y2={view.aprY(view.meanApr)}
                  className="fr-avg-line"
                />
                <text
                  x={view.chartRight - 2}
                  y={view.aprY(view.meanApr) - 3}
                  className="fr-avg-label"
                  textAnchor="end"
                >
                  avg {fmtApr(view.meanApr)}
                </text>
              </>
            )} */}
            {/* On the chart, only the selected window's average line is drawn
                (keeps it readable); the strip still lists every horizon. The
                value rides a tag pinned to the right axis, like a price marker
                — so the avg APR reads at a glance. */}
            {visibleSeries.avg &&
              view.avgLines
                .filter((a) => a.hours === hours)
                .map((a) => (
                  <g key={a.label}>
                    <line
                      x1={view.chartLeft}
                      x2={view.chartRight}
                      y1={a.y}
                      y2={a.y}
                      className="fr-avg-line"
                    />
                    <rect
                      x={view.chartRight + 1}
                      y={a.y - 6.5}
                      width={CHART_WIDTH - view.chartRight - 2}
                      height={13}
                      rx={2}
                      className="fr-avg-tag-bg"
                    />
                    <text
                      x={view.chartRight + 1 + (CHART_WIDTH - view.chartRight - 2) / 2}
                      y={a.y + 0.5}
                      className="fr-avg-tag-text"
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {fmtApr(a.apr)}
                    </text>
                  </g>
                ))}

            {/* X-axis date labels */}
            {xTicks.map((tt, i) => {
              const x = view.xFor(tt);
              const anchor =
                i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle";
              return (
                <text
                  key={`x${i}`}
                  x={x}
                  y={view.xAxisY}
                  className="fr-axis-label fr-axis-x"
                  textAnchor={anchor}
                  dominantBaseline="hanging"
                >
                  {fmtDateTick(tt, hours)}
                </text>
              );
            })}

            {/* Hover crosshair + dots */}
            {hover && (
              <g pointerEvents="none">
                <line
                  x1={hover.hx}
                  x2={hover.hx}
                  y1={view.plotTop}
                  y2={view.plotBottom}
                  className="fr-crosshair"
                />
                {visibleSeries.apr && (
                  <circle
                    cx={hover.hx}
                    cy={view.aprY(hover.apr)}
                    r={2.2}
                    className="fr-dot-apr"
                  />
                )}
                {visibleSeries.price && hover.price !== null && (
                  <circle
                    cx={hover.hx}
                    cy={view.priceY(hover.price)}
                    r={2.2}
                    className="fr-dot-price"
                  />
                )}
              </g>
            )}
          </svg>

          {hover && (
            <div
              className={`fr-tooltip ${hover.anchor}`}
              style={{ left: `${hover.leftPct}%` }}
            >
              <div className="fr-tooltip-date">{fmtFullDate(hover.t)}</div>
              {visibleSeries.apr && (
                <div className="fr-tooltip-row">
                  <span className="fr-tooltip-key apr" aria-hidden="true" />
                  <span className="fr-tooltip-name">APR</span>
                  <span
                    className={`fr-tooltip-val ${hover.apr >= 0 ? "up" : "down"}`}
                  >
                    {fmtApr(hover.apr)}
                  </span>
                </div>
              )}
              {visibleSeries.price && hover.price !== null && (
                <div className="fr-tooltip-row">
                  <span className="fr-tooltip-key price" aria-hidden="true" />
                  <span className="fr-tooltip-name">Price</span>
                  <span className="fr-tooltip-val">${fmtPrice(hover.price)}</span>
                </div>
              )}
            </div>
          )}
          </div>
        </>
      )}
    </section>
  );
}
