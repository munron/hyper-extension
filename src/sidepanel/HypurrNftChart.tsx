import { useEffect, useMemo, useState } from "react";
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

const CHART_WIDTH = 320;
const CHART_HEIGHT = 180;
const PAD_LEFT = 34; // y-axis label gutter
const PAD_RIGHT = 6;
const PAD_TOP = 6;
const PRICE_AREA_H = 100;
const GAP = 4;
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmtDateTick(ms: number, tf: Timeframe): string {
  const d = new Date(ms);
  if (tf === "ONE_DAY") {
    return d.getHours().toString().padStart(2, "0") + ":00";
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

type Props = { coin: string; refreshKey: number };

export default function HypurrNftChart({ coin, refreshKey }: Props) {
  const [tf, setTf] = useState<Timeframe>("SEVEN_DAYS");
  const [data, setData] = useState<CollectionSalesChart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (coin !== "HYPE") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
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

    const dots = buckets.map((b) => ({
      cx: xFor(b.floorT),
      cy: priceY(b.floor),
      price: b.floor,
    }));

    const linePath =
      buckets.length > 1
        ? buckets
            .map(
              (b, i) =>
                `${i === 0 ? "M" : "L"}${xFor(b.floorT).toFixed(2)},${priceY(b.floor).toFixed(2)}`,
            )
            .join(" ")
        : "";

    const barWidth =
      buckets.length > 1
        ? Math.max(1.5, (chartW / Math.max(1, (tMax - tMin) / bm)) * 0.8)
        : Math.max(3, chartW * 0.05);

    const bars = buckets.map((b) => {
      const h = vMax > 0 ? (b.volumeUsd / vMax) * VOLUME_AREA_H : 0;
      return {
        x: xFor(b.midT) - barWidth / 2,
        y: volBottom - h,
        w: barWidth,
        h,
        usd: b.volumeUsd,
      };
    });

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
      dots,
      linePath,
      bars,
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

          <svg
            className="nft-chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Hypurr NFT sales chart"
          >
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
                    x={view.chartLeft - 4}
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
            {view.bars.map((b, i) => (
              <rect
                key={`v${i}`}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                className="nft-volume-bar"
              />
            ))}
            {/* Volume baseline */}
            <line
              x1={view.chartLeft}
              x2={view.chartRight}
              y1={view.volBottom + 0.5}
              y2={view.volBottom + 0.5}
              className="nft-axis-line"
            />

            {/* Price line */}
            {view.linePath && (
              <path d={view.linePath} className="nft-price-line" />
            )}
            {/* Price dots */}
            {view.dots.map((d, i) => (
              <circle
                key={`d${i}`}
                cx={d.cx}
                cy={d.cy}
                r={1.2}
                className="nft-price-dot"
              />
            ))}

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

        </>
      )}
    </section>
  );
}
