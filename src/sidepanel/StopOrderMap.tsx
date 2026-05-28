import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStopOrderBandDetails,
  rankNearestPositions,
} from "../lib/hyperdash";
import { type CoinIndex } from "../lib/coinMap";
import { getPerpPrice } from "../lib/prices";

// Aligned with the Liquidation map's ±20% window so the two panels are
// directly comparable and the near-price zone (where the actionable stop
// clusters sit) reads clearly. Far-out stops are dropped intentionally.
const PRICE_RANGE_PCT = 0.2;
// Target number of price bins across the window. bandSize is derived from
// this so the chart looks consistent across coins of any price.
const TARGET_BANDS = 250;

const CHART_WIDTH = 320;
const CHART_HEIGHT = 140;
const CHART_PADDING_X = 4;
const CHART_PADDING_Y = 6;

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

// Axis labels can be exactly $0 for the stop chart's left edge; the
// general fmtUsd uses "—" for non-positive which would read wrong there.
function fmtAxis(n: number): string {
  if (n === 0) return "$0";
  return fmtUsd(n);
}

function fmtCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toString();
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// Playful panic gauge: the nearest stop line gets the most frightened cat.
// rankIndex 0 → level 3 (terrified), then 2, then 1.
const PANIC_FACES = ["😺", "😿", "🙀"] as const; // [calm, worried, terrified]
const PANIC_LABELS = ["plenty of room", "getting close", "very close!"] as const;
function panic(rankIndex: number): { face: string; label: string; level: number } {
  const level = Math.min(3, Math.max(1, 3 - rankIndex));
  return { face: PANIC_FACES[level - 1], label: PANIC_LABELS[level - 1], level };
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * pow;
}

// size is signed: positive = buy stop, negative = sell stop.
type Stop = { address: string; price: number; size: number };

type StopData = {
  cur: number;
  lo: number;
  hi: number;
  bandSize: number;
  stops: Stop[];
  buyCount: number;
  sellCount: number;
};

type Props = { coin: string; coinIndex: CoinIndex | null; refreshKey: number };

export default function StopOrderMap({ coin, coinIndex, refreshKey }: Props) {
  const [data, setData] = useState<StopData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [selectedBandKey, setSelectedBandKey] = useState<string | null>(null);
  const [showAllStops, setShowAllStops] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState({
    buyStops: true,
    sellStops: true,
    cumBuys: true,
    cumSells: true,
  });
  const toggleSeries = (k: keyof typeof visibleSeries) =>
    setVisibleSeries((s) => ({ ...s, [k]: !s[k] }));
  const chartRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    setHoverX(null);
    setSelectedBandKey(null);
    setShowAllStops(false);
  }, [coin, refreshKey]);

  useEffect(() => {
    setShowAllStops(false);
  }, [selectedBandKey]);

  // Single source of truth: one range-scoped currentStopOrderBandDetailsV2
  // call returns every resting stop in the 0..2×cur window (verified
  // uncapped). We bucket these client-side into the chart bars, the
  // cumulative curves, the totals, and the bottom list.
  useEffect(() => {
    if (!coinIndex) return;
    const perpAssetId = coinIndex.perpAssetIdByCoin[coin];
    if (perpAssetId === undefined) {
      setData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const price = await getPerpPrice(perpAssetId);
      if (!price || price <= 0) {
        if (!cancelled) {
          setData(null);
          setLoading(false);
        }
        return;
      }
      const lo = price * (1 - PRICE_RANGE_PCT);
      const hi = price * (1 + PRICE_RANGE_PCT);
      try {
        const d = await fetchStopOrderBandDetails({
          coin,
          minPrice: lo,
          maxPrice: hi,
        });
        if (cancelled) return;
        const stops: Stop[] = d.stops.map((s) => ({
          address: s.address,
          price: s.price,
          size: s.size,
        }));
        const bandSize = niceStep((hi - lo) / TARGET_BANDS);
        setData({
          cur: price,
          lo,
          hi,
          bandSize,
          stops,
          buyCount: d.buyCount,
          sellCount: d.sellCount,
        });
      } catch (e) {
        if (!cancelled) {
          console.warn("fetchStopOrderBandDetails failed", e);
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [coin, coinIndex, refreshKey]);

  const view = useMemo(() => {
    if (!data) return null;
    const { cur, lo, hi, bandSize, stops } = data;
    if (!(hi > lo) || !(bandSize > 0)) return null;

    type Bar = {
      mid: number;
      minPrice: number;
      maxPrice: number;
      buySize: number;
      sellSize: number;
      buyCount: number;
      sellCount: number;
      size: number;
      buyUsd: number;
      sellUsd: number;
      usd: number;
      side: "buy" | "sell";
      x: number;
      w: number;
    };

    // Bucket stops into fixed-width bins, splitting by sign.
    const agg = new Map<
      number,
      { buySize: number; sellSize: number; buyCount: number; sellCount: number }
    >();
    for (const s of stops) {
      const idx = Math.floor(s.price / bandSize);
      let cell = agg.get(idx);
      if (!cell) {
        cell = { buySize: 0, sellSize: 0, buyCount: 0, sellCount: 0 };
        agg.set(idx, cell);
      }
      if (s.size >= 0) {
        cell.buySize += s.size;
        cell.buyCount += 1;
      } else {
        cell.sellSize += -s.size;
        cell.sellCount += 1;
      }
    }

    const innerW = CHART_WIDTH - 2 * CHART_PADDING_X;
    const bars: Bar[] = [];
    let maxUsd = 0;
    for (const [idx, cell] of agg) {
      const minPrice = idx * bandSize;
      const maxPrice = minPrice + bandSize;
      if (maxPrice <= lo || minPrice >= hi) continue;
      const mid = minPrice + bandSize / 2;
      const buyUsd = cell.buySize * mid;
      const sellUsd = cell.sellSize * mid;
      const usd = buyUsd + sellUsd;
      if (usd === 0) continue;
      if (usd > maxUsd) maxUsd = usd;
      const x = ((minPrice - lo) / (hi - lo)) * innerW + CHART_PADDING_X;
      const w = (bandSize / (hi - lo)) * innerW;
      bars.push({
        mid,
        minPrice,
        maxPrice,
        buySize: cell.buySize,
        sellSize: cell.sellSize,
        buyCount: cell.buyCount,
        sellCount: cell.sellCount,
        size: cell.buySize + cell.sellSize,
        buyUsd,
        sellUsd,
        usd,
        side: cell.buySize >= cell.sellSize ? "buy" : "sell",
        x,
        w,
      });
    }
    bars.sort((a, b) => a.minPrice - b.minPrice);

    const curX = ((cur - lo) / (hi - lo)) * innerW + CHART_PADDING_X;

    // Cumulative curves: anchored at cur (0) and growing outward.
    let cumS = 0;
    const sellCumPts: { x: number; cum: number }[] = [];
    const bandsBelow = bars
      .filter((b) => b.mid < cur)
      .sort((a, b) => b.mid - a.mid); // descending mid
    for (const b of bandsBelow) {
      cumS += b.sellSize;
      sellCumPts.push({ x: b.x + b.w / 2, cum: cumS });
    }
    sellCumPts.reverse(); // ascending x
    sellCumPts.push({ x: curX, cum: 0 }); // anchor at cur (rightmost)

    let cumB = 0;
    const buyCumPts: { x: number; cum: number }[] = [{ x: curX, cum: 0 }];
    const bandsAbove = bars
      .filter((b) => b.mid >= cur)
      .sort((a, b) => a.mid - b.mid);
    for (const b of bandsAbove) {
      cumB += b.buySize;
      buyCumPts.push({ x: b.x + b.w / 2, cum: cumB });
    }

    const maxCum = Math.max(
      sellCumPts[0]?.cum ?? 0,
      buyCumPts[buyCumPts.length - 1]?.cum ?? 0,
      1,
    );

    const cumYTop = CHART_PADDING_Y;
    const cumYBottom = CHART_HEIGHT - CHART_PADDING_Y;
    const cumY = (cum: number) =>
      cumYBottom - (cum / maxCum) * (cumYBottom - cumYTop);
    const toPath = (pts: { x: number; cum: number }[]) =>
      pts.length === 0
        ? ""
        : pts
            .map(
              (p, i) =>
                `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${cumY(p.cum).toFixed(2)}`,
            )
            .join(" ");
    const sellCumPath = toPath(sellCumPts);
    const buyCumPath = toPath(buyCumPts);

    let totalBuyUsd = 0;
    let totalSellUsd = 0;
    for (const b of bars) {
      totalBuyUsd += b.buyUsd;
      totalSellUsd += b.sellUsd;
    }

    return {
      bars,
      maxUsd,
      curX,
      lo,
      hi,
      cur,
      totalBuyUsd,
      totalSellUsd,
      sellCumPath,
      buyCumPath,
      maxCum,
    };
  }, [data]);

  const hoveredBar = useMemo(() => {
    if (!view || hoverX === null || view.bars.length === 0) return null;
    let idx = view.bars.findIndex((b) => hoverX >= b.x && hoverX <= b.x + b.w);
    if (idx < 0) {
      let bestDist = Infinity;
      let best = -1;
      view.bars.forEach((b, i) => {
        const d = Math.abs(b.x + b.w / 2 - hoverX);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      idx = best;
    }
    return idx >= 0 ? view.bars[idx] : null;
  }, [hoverX, view]);

  const selectedBar = useMemo(() => {
    if (!view || !selectedBandKey) return null;
    return (
      view.bars.find(
        (b) =>
          `${b.minPrice.toFixed(8)}|${b.maxPrice.toFixed(8)}` === selectedBandKey,
      ) ?? null
    );
  }, [view, selectedBandKey]);

  if (!coinIndex) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Stop Order Map</span>
        </div>
        <div className="liq-status">Loading…</div>
      </section>
    );
  }
  if (coinIndex.perpAssetIdByCoin[coin] === undefined) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Stop Order Map</span>
        </div>
        <div className="liq-status">No perpetual market for {coin}</div>
      </section>
    );
  }
  if (loading && !data) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Stop Order Map</span>
          <span className="liq-head-window">live</span>
        </div>
        <div className="liq-status">Loading…</div>
      </section>
    );
  }
  if (error || !data || !view) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Stop Order Map</span>
        </div>
        <div className={`liq-status ${error ? "liq-error" : ""}`}>
          {error ? "Failed to load" : "No stop order data"}
        </div>
      </section>
    );
  }

  const inspectBar = selectedBar ?? hoveredBar;
  const hoveredBarIdx = hoveredBar ? view.bars.indexOf(hoveredBar) : -1;
  const selectedBarIdx = selectedBar ? view.bars.indexOf(selectedBar) : -1;
  const distPctFromCur = inspectBar
    ? ((inspectBar.mid - view.cur) / view.cur) * 100
    : 0;

  const sortedInBand = inspectBar
    ? data.stops
        .filter(
          (s) => s.price >= inspectBar.minPrice && s.price < inspectBar.maxPrice,
        )
        .sort((a, b) => Math.abs(b.size) * b.price - Math.abs(a.size) * a.price)
    : [];
  const COLLAPSED_STOP_COUNT = 3;
  const visibleInBand =
    selectedBar && showAllStops
      ? sortedInBand
      : sortedInBand.slice(0, COLLAPSED_STOP_COUNT);
  const hiddenStopCount = Math.max(0, sortedInBand.length - COLLAPSED_STOP_COUNT);

  // Bottom list: nearest sizeable stops per side from the full pool.
  const buyPool = data.stops.filter((s) => s.size >= 0);
  const sellPool = data.stops.filter((s) => s.size < 0);
  const topBuy = rankNearestPositions(buyPool, view.cur);
  const topSell = rankNearestPositions(sellPool, view.cur);

  const metaText = (() => {
    if (!inspectBar) return null;
    const buyCount = inspectBar.buyCount;
    const sellCount = inspectBar.sellCount;
    const totalCount = buyCount + sellCount;
    if (buyCount > 0 && sellCount > 0) {
      return `${totalCount} stops in this band (${buyCount} buy · ${sellCount} sell)`;
    }
    const word = totalCount === 1 ? "stop" : "stops";
    if (sellCount > 0) return `${sellCount} sell ${word} in this band`;
    return `${buyCount} buy ${word} in this band`;
  })();

  const handleContainerMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = chartRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    if (e.clientY < rect.top || e.clientY > rect.bottom) return;
    const x = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH;
    setHoverX(Math.max(0, Math.min(CHART_WIDTH, x)));
  };
  const handleContainerLeave = () => setHoverX(null);

  const handleChartClick = () => {
    if (!hoveredBar) return;
    const key = `${hoveredBar.minPrice.toFixed(8)}|${hoveredBar.maxPrice.toFixed(8)}`;
    setSelectedBandKey((prev) => (prev === key ? null : key));
  };
  const clearSelection = () => setSelectedBandKey(null);

  return (
    <section className="liq">
      <div className="liq-head">
        <span className="liq-head-label">Stop Order Map</span>
        <span className="liq-head-window">±20% · live</span>
      </div>

      <div className="liq-totals">
        <div className="liq-total long">
          <div className="liq-total-top">
            <span className="liq-total-tag">▼ SELL STOPS</span>
            <span className="liq-total-count">{fmtCount(data.sellCount)}</span>
          </div>
          <div className="liq-total-value">{fmtUsd(view.totalSellUsd)}</div>
        </div>
        <div className="liq-total short">
          <div className="liq-total-top">
            <span className="liq-total-tag">▲ BUY STOPS</span>
            <span className="liq-total-count">{fmtCount(data.buyCount)}</span>
          </div>
          <div className="liq-total-value">{fmtUsd(view.totalBuyUsd)}</div>
        </div>
      </div>

      <div
        className="liq-interactive"
        onMouseMove={handleContainerMove}
        onMouseLeave={handleContainerLeave}
      >
        <div className="liq-legend" role="group" aria-label="Toggle chart series">
          {(
            [
              { key: "sellStops", label: "Sell Stops", swatch: "sell" },
              { key: "buyStops", label: "Buy Stops", swatch: "buy" },
              { key: "cumSells", label: "Cum Sells", swatch: "cum-sell" },
              { key: "cumBuys", label: "Cum Buys", swatch: "cum-buy" },
            ] as const
          ).map((item) => {
            const on = visibleSeries[item.key];
            return (
              <button
                key={item.key}
                type="button"
                className={`liq-legend-item ${item.swatch}${on ? "" : " off"}`}
                onClick={() => toggleSeries(item.key)}
                aria-pressed={on}
              >
                <span className="liq-legend-swatch" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="liq-chart-wrap">
          <svg
            ref={chartRef}
            className={`liq-chart${hoveredBar ? " liq-chart-armed" : ""}`}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Stop order map for ${coin} — click a band to inspect individual stop orders`}
            onClick={handleChartClick}
          >
            {/* Stacked bars: sell on bottom, buy on top. */}
            {view.bars.map((b, i) => {
              const innerH = CHART_HEIGHT - 2 * CHART_PADDING_Y;
              const sellH =
                view.maxUsd > 0 ? (b.sellUsd / view.maxUsd) * innerH : 0;
              const buyH =
                view.maxUsd > 0 ? (b.buyUsd / view.maxUsd) * innerH : 0;
              const baseline = CHART_HEIGHT - CHART_PADDING_Y;
              const sellOn = visibleSeries.sellStops && b.sellUsd > 0;
              const buyOn = visibleSeries.buyStops && b.buyUsd > 0;
              const isHover = hoveredBarIdx === i;
              const isSelected = selectedBarIdx === i;
              const stateCls =
                (isHover && !isSelected ? " liq-bar-hover" : "") +
                (isSelected ? " liq-bar-selected" : "");
              const w = Math.max(0.6, b.w - 0.4);
              const buyBaseline = sellOn ? baseline - sellH : baseline;
              return (
                <g key={i}>
                  {sellOn && (
                    <rect
                      x={b.x}
                      y={baseline - sellH}
                      width={w}
                      height={sellH}
                      className={`liq-bar-long${stateCls}`}
                    />
                  )}
                  {buyOn && (
                    <rect
                      x={b.x}
                      y={buyBaseline - buyH}
                      width={w}
                      height={buyH}
                      className={`liq-bar-short${stateCls}`}
                    />
                  )}
                </g>
              );
            })}
            {visibleSeries.cumSells && view.sellCumPath && (
              <path d={view.sellCumPath} className="liq-cum-sell-line" />
            )}
            {visibleSeries.cumBuys && view.buyCumPath && (
              <path d={view.buyCumPath} className="liq-cum-buy-line" />
            )}
            <line
              x1={view.curX}
              y1={0}
              x2={view.curX}
              y2={CHART_HEIGHT}
              className="liq-cur-line"
            />
            {selectedBar && (
              <line
                x1={selectedBar.x + selectedBar.w / 2}
                y1={0}
                x2={selectedBar.x + selectedBar.w / 2}
                y2={CHART_HEIGHT}
                className="liq-sel-line"
              />
            )}
            {hoveredBar && !selectedBar && (
              <line
                x1={hoveredBar.x + hoveredBar.w / 2}
                y1={0}
                x2={hoveredBar.x + hoveredBar.w / 2}
                y2={CHART_HEIGHT}
                className="liq-hover-line"
              />
            )}
          </svg>
          <div className="liq-axis">
            <span>{fmtAxis(view.lo)}</span>
            <span className="liq-axis-cur">{fmtAxis(view.cur)}</span>
            <span>{fmtAxis(view.hi)}</span>
          </div>
        </div>

        <div
          className={`liq-inspector${selectedBar ? " liq-inspector-pinned" : ""}`}
          aria-live="polite"
        >
          {inspectBar ? (
            <>
              <div className="liq-inspector-head">
                <span className={`liq-inspector-tag ${inspectBar.side}`}>
                  {inspectBar.side === "sell" ? "▼ SELL" : "▲ BUY"}
                </span>
                <span className="liq-inspector-range">
                  {fmtUsd(inspectBar.minPrice)} – {fmtUsd(inspectBar.maxPrice)}
                </span>
                <span
                  className={`liq-inspector-dist ${
                    distPctFromCur < 0 ? "down" : "up"
                  }`}
                >
                  {distPctFromCur >= 0 ? "+" : ""}
                  {distPctFromCur.toFixed(1)}%
                </span>
                <span className="liq-inspector-spacer" />
                {selectedBar && (
                  <button
                    type="button"
                    className="liq-inspector-close"
                    onClick={clearSelection}
                    aria-label="Clear selection"
                    title="Clear selection"
                  >
                    ×
                  </button>
                )}
              </div>
              {metaText && (
                <div className="liq-inspector-meta">
                  <span>{metaText}</span>
                </div>
              )}
              {visibleInBand.length > 0 ? (
                <>
                  <ul
                    className={`liq-inspector-traders${selectedBar && showAllStops ? " liq-inspector-traders-scroll" : ""}`}
                  >
                    {visibleInBand.map((s) => {
                      const usd = Math.abs(s.size) * s.price;
                      const rowSide: "buy" | "sell" = s.size >= 0 ? "buy" : "sell";
                      return (
                        <li key={`${s.address}-${s.price}`}>
                          <a
                            className="liq-inspector-trader"
                            href={`https://hypurrscan.io/address/${s.address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`${s.address} — ${rowSide} stop @ $${fmtPrice(s.price)}`}
                          >
                            <span
                              className={`liq-inspector-trader-side ${rowSide}`}
                              aria-label={rowSide === "buy" ? "buy stop" : "sell stop"}
                            >
                              {rowSide === "buy" ? "▲" : "▼"}
                            </span>
                            <span className="liq-inspector-trader-price">
                              ${fmtPrice(s.price)}
                            </span>
                            <span className="liq-inspector-trader-size">
                              {fmtUsd(usd)}
                            </span>
                            <span className="liq-inspector-trader-addr">
                              {shortAddr(s.address)}
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                  {selectedBar && hiddenStopCount > 0 && (
                    <button
                      type="button"
                      className="liq-inspector-toggle"
                      onClick={() => setShowAllStops((v) => !v)}
                      aria-expanded={showAllStops}
                    >
                      {showAllStops
                        ? `▴ Show top ${COLLAPSED_STOP_COUNT}`
                        : `▾ Show all ${sortedInBand.length} stops (+${hiddenStopCount})`}
                    </button>
                  )}
                  {!selectedBar && hiddenStopCount > 0 && (
                    <div className="liq-inspector-more-hint">
                      +{hiddenStopCount} more · click to pin
                    </div>
                  )}
                </>
              ) : (
                <div className="liq-inspector-empty">
                  No stop orders in this band
                </div>
              )}
            </>
          ) : (
            <div className="liq-inspector-hint">
              <span className="liq-inspector-hint-icon" aria-hidden="true">
                ▸
              </span>
              Hover a band to see stop orders · click to pin
            </div>
          )}
        </div>
      </div>

      {(topSell.length > 0 || topBuy.length > 0) && (
        <div className="liq-top-section">
          <div className="liq-top-cap">Nearest sizeable stops · ≥$0.5M</div>
          <div className="liq-top">
            {topSell.length > 0 && (
              <ul className="liq-top-list">
                {topSell.map((t, i) => {
                  const p = panic(i);
                  return (
                    <li key={`S${t.address}-${t.price}`} className="long">
                      <a
                        className="liq-top-link"
                        href={`https://hypurrscan.io/address/${t.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${t.address} — sell stop @ $${fmtPrice(t.price)} (${t.distPct.toFixed(1)}%) · ${p.label}`}
                      >
                        <span
                          className={`liq-top-panic panic-${p.level}`}
                          aria-hidden="true"
                        >
                          {p.face}
                        </span>
                        <span className="liq-top-lvl">
                          <span className="liq-top-side">▼</span>
                          <span className="liq-top-price">${fmtPrice(t.price)}</span>
                          <span className="liq-top-dist">
                            {t.distPct >= 0 ? "+" : ""}
                            {t.distPct.toFixed(1)}%
                          </span>
                        </span>
                        <span className="liq-top-size">{fmtUsd(t.usd)}</span>
                        <span className="liq-top-addr">{shortAddr(t.address)}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            {topBuy.length > 0 && (
              <ul className="liq-top-list">
                {topBuy.map((t, i) => {
                  const p = panic(i);
                  return (
                    <li key={`B${t.address}-${t.price}`} className="short">
                      <a
                        className="liq-top-link"
                        href={`https://hypurrscan.io/address/${t.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${t.address} — buy stop @ $${fmtPrice(t.price)} (${t.distPct.toFixed(1)}%) · ${p.label}`}
                      >
                        <span
                          className={`liq-top-panic panic-${p.level}`}
                          aria-hidden="true"
                        >
                          {p.face}
                        </span>
                        <span className="liq-top-lvl">
                          <span className="liq-top-side">▲</span>
                          <span className="liq-top-price">${fmtPrice(t.price)}</span>
                          <span className="liq-top-dist">
                            {t.distPct >= 0 ? "+" : ""}
                            {t.distPct.toFixed(1)}%
                          </span>
                        </span>
                        <span className="liq-top-size">{fmtUsd(t.usd)}</span>
                        <span className="liq-top-addr">{shortAddr(t.address)}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
