import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCollectionSalesChart,
  type CollectionSalesChart,
  type Timeframe,
} from "../lib/opensea";

const COLLECTION_SLUG = "hypurr-hyperevm";
const COLLECTION_URL = "https://opensea.io/collection/hypurr-hyperevm";

const TIMEFRAMES: { label: string; value: Timeframe }[] = [
  { label: "1D", value: "ONE_DAY" },
  { label: "7D", value: "SEVEN_DAYS" },
  { label: "30D", value: "THIRTY_DAYS" },
  { label: "ALL", value: "ALL_TIME" },
];

const CHART_WIDTH = 340;
const CHART_HEIGHT = 188;
const PAD_LEFT = 34; // y-axis label gutter
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PRICE_AREA_H = 104;
const GAP = 6;
const VOLUME_AREA_H = 46;
const X_AXIS_H = 14;

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function fmtHype(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtAxisHype(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
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

function fmtDateTick(ms: number, tf: Timeframe): string {
  const d = new Date(ms);
  if (tf === "ONE_DAY") {
    return d.getHours().toString().padStart(2, "0") + ":00";
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtTooltipDate(ms: number, tf: Timeframe): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (tf === "ONE_DAY" || tf === "SEVEN_DAYS") {
    const time = d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${date} · ${time}`;
  }
  return date;
}

function dateTicks(tMin: number, tMax: number, count = 4): number[] {
  if (!(tMax > tMin)) return [tMin];
  const step = (tMax - tMin) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(tMin + step * i);
  return out;
}

function bucketMs(tf: Timeframe): number {
  switch (tf) {
    case "ONE_DAY":
      return 60 * 60 * 1000; // 1h
    case "SEVEN_DAYS":
      return 6 * 60 * 60 * 1000; // 6h
    case "THIRTY_DAYS":
      return 24 * 60 * 60 * 1000; // 1d
    case "ALL_TIME":
      return 7 * 24 * 60 * 60 * 1000; // 1w
  }
}

type Pt = { x: number; y: number };

// Catmull-Rom → cubic bézier, so the floor line reads as a smooth curve
// instead of jagged segments. Falls back to a straight move for <2 points.
function smoothLine(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  const t = 0.5; // tension
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * t * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * t * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * t * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * t * 2;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

type Props = { coin: string; refreshKey: number };

export default function HypurrNftChart({ coin, refreshKey }: Props) {
  const [tf, setTf] = useState<Timeframe>("SEVEN_DAYS");
  const [data, setData] = useState<CollectionSalesChart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (coin !== "HYPE") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHoverIdx(null);
    fetchCollectionSalesChart(COLLECTION_SLUG, tf)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn("fetchCollectionSalesChart failed", e);
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coin, tf, refreshKey]);

  const view = useMemo(() => {
    if (!data) return null;
    const sales = data.sales
      .map((s) => ({ t: Date.parse(s.time), price: s.native.unit, usd: s.usd }))
      .filter((s) => Number.isFinite(s.t) && s.price > 0)
      .sort((a, b) => a.t - b.t);
    if (sales.length === 0) return null;

    // Bucket sales by timeframe and take the floor (min) per bucket. NFT
    // sales can include high-priced rare items; the floor is the
    // representative price for the period.
    const bm = bucketMs(tf);
    type Bucket = {
      key: number; // bucket start
      midT: number; // bucket midpoint (for plot x)
      floor: number;
      floorT: number; // timestamp of the floor sale (for line plot)
      volumeUsd: number;
      volumeHype: number;
      count: number;
    };
    const bMap = new Map<number, Bucket>();
    for (const s of sales) {
      const key = Math.floor(s.t / bm) * bm;
      const ex = bMap.get(key);
      if (!ex) {
        bMap.set(key, {
          key,
          midT: key + bm / 2,
          floor: s.price,
          floorT: s.t,
          volumeUsd: s.usd,
          volumeHype: s.price,
          count: 1,
        });
      } else {
        if (s.price < ex.floor) {
          ex.floor = s.price;
          ex.floorT = s.t;
        }
        ex.volumeUsd += s.usd;
        ex.volumeHype += s.price;
        ex.count += 1;
      }
    }
    const buckets = [...bMap.values()].sort((a, b) => a.key - b.key);

    const tMin = Math.min(sales[0].t, buckets[0].key);
    const tMax = Math.max(sales[sales.length - 1].t, buckets[buckets.length - 1].key + bm);
    const tSpan = Math.max(1, tMax - tMin);

    const floors = buckets.map((b) => b.floor);
    const pLo = Math.min(...floors);
    const pHi = Math.max(...floors);
    const yPad = (pHi - pLo) * 0.1 || pLo * 0.05 || 1;
    const yTicks = niceTicks(Math.max(0, pLo - yPad), pHi + yPad, 4);
    const pMin = yTicks.length ? Math.min(yTicks[0], pLo - yPad) : pLo;
    const pMax = yTicks.length ? Math.max(yTicks[yTicks.length - 1], pHi + yPad) : pHi;
    const pSpan = Math.max(1e-6, pMax - pMin);

    const vMax = Math.max(...buckets.map((b) => b.volumeUsd));

    const chartLeft = PAD_LEFT;
    const chartRight = CHART_WIDTH - PAD_RIGHT;
    const chartW = chartRight - chartLeft;

    const priceTop = PAD_TOP;
    const priceBottom = priceTop + PRICE_AREA_H;
    const volTop = priceBottom + GAP;
    const volBottom = volTop + VOLUME_AREA_H;
    const xAxisY = volBottom + X_AXIS_H - 4;

    const xFor = (t: number) => chartLeft + ((t - tMin) / tSpan) * chartW;
    const priceY = (p: number) => {
      const norm = (p - pMin) / pSpan; // 0..1
      return priceTop + (1 - norm) * PRICE_AREA_H;
    };

    const pts: {
      x: number;
      y: number;
      price: number;
      t: number;
      volumeUsd: number;
      count: number;
      barX: number;
      barH: number;
    }[] = [];

    const barWidth =
      buckets.length > 1
        ? Math.max(1.5, (chartW / Math.max(1, (tMax - tMin) / bm)) * 0.78)
        : Math.max(3, chartW * 0.05);

    for (const b of buckets) {
      const h = vMax > 0 ? (b.volumeUsd / vMax) * VOLUME_AREA_H : 0;
      pts.push({
        x: xFor(b.floorT),
        y: priceY(b.floor),
        price: b.floor,
        t: b.floorT,
        volumeUsd: b.volumeUsd,
        count: b.count,
        barX: xFor(b.midT) - barWidth / 2,
        barH: h,
      });
    }

    const linePts = pts.map((p) => ({ x: p.x, y: p.y }));
    const linePath = smoothLine(linePts);
    // Area = the smoothed line, then down to the volume-section top and back.
    const areaPath =
      linePts.length > 1
        ? `${linePath} L${linePts[linePts.length - 1].x.toFixed(2)},${priceBottom} L${linePts[0].x.toFixed(2)},${priceBottom} Z`
        : "";

    const xTickTimes = dateTicks(tMin, tMax, 4);

    const totalHype = sales.reduce((a, s) => a + s.price, 0);
    const totalUsd = sales.reduce((a, s) => a + s.usd, 0);
    const overallFloor = pLo;
    const lastBucket = buckets[buckets.length - 1];
    const firstBucket = buckets[0];
    const floorChangePct =
      firstBucket && lastBucket && firstBucket.floor > 0
        ? ((lastBucket.floor - firstBucket.floor) / firstBucket.floor) * 100
        : 0;

    return {
      pts,
      linePath,
      areaPath,
      barWidth,
      tMin,
      tMax,
      pMin,
      pMax,
      vMax,
      priceTop,
      priceBottom,
      volTop,
      volBottom,
      chartLeft,
      chartRight,
      xAxisY,
      yTicks,
      xTickTimes,
      priceYFor: priceY,
      xFor,
      salesCount: sales.length,
      bucketCount: buckets.length,
      totalHype,
      totalUsd,
      overallFloor,
      currentFloor: lastBucket.floor,
      floorChangePct,
    };
  }, [data, tf]);

  if (coin !== "HYPE") return null;

  const hover =
    view && hoverIdx != null && hoverIdx >= 0 && hoverIdx < view.pts.length
      ? view.pts[hoverIdx]
      : null;

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg || !view || view.pts.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH;
    // nearest point by x
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < view.pts.length; i++) {
      const d = Math.abs(view.pts[i].x - vbX);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };

  return (
    <section className="nft">
      <div className="nft-head">
        <div className="nft-head-left">
          <a
            className="nft-head-label"
            href={COLLECTION_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on OpenSea"
          >
            Hypurr NFT ↗
          </a>
        </div>
        <div className="nft-tf" role="tablist">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tf === t.value}
              className={`nft-tf-btn ${tf === t.value ? "active" : ""}`}
              onClick={() => setTf(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !view && <div className="nft-status">Loading…</div>}
      {error && !view && <div className="nft-status nft-error">Failed to load</div>}

      {view && (
        <>
          <div className="nft-stats">
            <div className="nft-stat">
              <div className="nft-stat-label">Volume</div>
              <div className="nft-stat-value">{fmtUsd(view.totalUsd)}</div>
              <div className="nft-stat-sub">{fmtHype(view.totalHype)} HYPE</div>
            </div>
            <div className="nft-stat">
              <div className="nft-stat-label">Sales</div>
              <div className="nft-stat-value">{view.salesCount}</div>
              <div className="nft-stat-sub">period floor {fmtHype(view.overallFloor)}</div>
            </div>
            <div className="nft-stat">
              <div className="nft-stat-label">Floor</div>
              <div className="nft-stat-value">{fmtHype(view.currentFloor)}</div>
              <div
                className={`nft-stat-sub ${
                  view.floorChangePct >= 0 ? "up" : "down"
                }`}
              >
                {view.floorChangePct >= 0 ? "+" : ""}
                {view.floorChangePct.toFixed(1)}%
              </div>
            </div>
          </div>

          <div
            className="fr-chart-wrap"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <svg
              ref={svgRef}
              className="nft-chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Hypurr NFT sales chart"
            >
              <defs>
                <linearGradient id="nftAreaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className="nft-area-top" />
                  <stop offset="100%" className="nft-area-bottom" />
                </linearGradient>
              </defs>

              {/* Horizontal gridlines + Y-axis labels */}
              {view.yTicks.map((tk, i) => {
                const y = view.priceYFor(tk);
                if (y < view.priceTop - 0.5 || y > view.priceBottom + 0.5) return null;
                return (
                  <g key={`y${i}`}>
                    <line
                      x1={view.chartLeft}
                      x2={view.chartRight}
                      y1={y}
                      y2={y}
                      className="nft-grid-line"
                    />
                    <text
                      x={view.chartLeft - 5}
                      y={y}
                      className="nft-axis-label nft-axis-y"
                      textAnchor="end"
                      dominantBaseline="middle"
                    >
                      {fmtAxisHype(tk)}
                    </text>
                  </g>
                );
              })}

              {/* Volume bars */}
              {view.pts.map((p, i) => {
                if (p.barH <= 0) return null;
                return (
                  <rect
                    key={`v${i}`}
                    x={p.barX}
                    y={view.volBottom - p.barH}
                    width={view.barWidth}
                    height={p.barH}
                    rx={Math.min(1.2, view.barWidth / 2)}
                    className={`nft-volume-bar${hoverIdx === i ? " active" : ""}`}
                  />
                );
              })}
              {/* Volume baseline */}
              <line
                x1={view.chartLeft}
                x2={view.chartRight}
                y1={view.volBottom + 0.5}
                y2={view.volBottom + 0.5}
                className="nft-axis-line"
              />

              {/* Price area fill + line */}
              {view.areaPath && (
                <path d={view.areaPath} className="nft-price-area" />
              )}
              {view.linePath && (
                <path d={view.linePath} className="nft-price-line" />
              )}

              {/* Last-point marker */}
              {view.pts.length > 0 && hover == null && (
                <circle
                  cx={view.pts[view.pts.length - 1].x}
                  cy={view.pts[view.pts.length - 1].y}
                  r={2.8}
                  className="nft-price-last"
                />
              )}

              {/* Hover crosshair + active marker */}
              {hover && (
                <>
                  <line
                    x1={hover.x}
                    x2={hover.x}
                    y1={view.priceTop}
                    y2={view.volBottom}
                    className="fr-crosshair"
                    pointerEvents="none"
                  />
                  <circle
                    cx={hover.x}
                    cy={hover.y}
                    r={3.2}
                    className="nft-price-active"
                    pointerEvents="none"
                  />
                </>
              )}

              {/* X-axis date labels */}
              {view.xTickTimes.map((tt, i) => {
                const x = view.xFor(tt);
                const anchor =
                  i === 0 ? "start" : i === view.xTickTimes.length - 1 ? "end" : "middle";
                return (
                  <text
                    key={`x${i}`}
                    x={x}
                    y={view.xAxisY}
                    className="nft-axis-label nft-axis-x"
                    textAnchor={anchor}
                    dominantBaseline="hanging"
                  >
                    {fmtDateTick(tt, tf)}
                  </text>
                );
              })}
            </svg>

            {hover && (
              <div
                className="fr-tooltip center"
                style={{ left: `${(hover.x / CHART_WIDTH) * 100}%` }}
              >
                <div className="fr-tooltip-date">{fmtTooltipDate(hover.t, tf)}</div>
                <div className="fr-tooltip-row">
                  <span className="fr-tooltip-name">Floor</span>
                  <span className="fr-tooltip-val">{fmtHype(hover.price)} HYPE</span>
                </div>
                <div className="fr-tooltip-row">
                  <span className="fr-tooltip-name">Volume</span>
                  <span className="fr-tooltip-val">{fmtUsd(hover.volumeUsd)}</span>
                </div>
                <div className="fr-tooltip-row">
                  <span className="fr-tooltip-name">Sales</span>
                  <span className="fr-tooltip-val">{hover.count}</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
