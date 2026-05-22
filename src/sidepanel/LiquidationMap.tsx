import { useEffect, useMemo, useState } from "react";
import { fetchLiquidationLevels, type LiquidationLevels } from "../lib/hyperdash";
import { type CoinIndex } from "../lib/coinMap";
import { getPerpPrice } from "../lib/prices";

const TIME_WINDOW_SECONDS = 3 * 24 * 60 * 60; // 3 days
const PRICE_RANGE_PCT = 0.2;

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

type Props = { coin: string; coinIndex: CoinIndex | null; refreshKey: number };

export default function LiquidationMap({ coin, coinIndex, refreshKey }: Props) {
  const [data, setData] = useState<LiquidationLevels | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const minPrice = price * (1 - PRICE_RANGE_PCT);
      const maxPrice = price * (1 + PRICE_RANGE_PCT);
      const endTime = Math.floor(Date.now() / 1000);
      const startTime = endTime - TIME_WINDOW_SECONDS;
      try {
        const levels = await fetchLiquidationLevels({
          coin,
          minPrice,
          maxPrice,
          startTime,
          endTime,
        });
        if (!cancelled) setData(levels);
      } catch (e) {
        if (!cancelled) {
          console.warn("fetchLiquidationLevels failed", e);
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
    if (!data || data.bands.length === 0) return null;
    const cur = data.currentPrice;
    const lo = data.minPrice;
    const hi = data.maxPrice;
    if (!(hi > lo)) return null;

    // Per-band totals in USD (size × band mid price)
    type Bar = {
      mid: number;
      usd: number;
      side: "long" | "short";
      x: number;
      w: number;
    };
    const bars: Bar[] = [];
    let maxUsd = 0;
    for (const b of data.bands) {
      const mid = (b.minPrice + b.maxPrice) / 2;
      const signedSize = b.historicalData.reduce((a, h) => a + h.totalAmount, 0);
      const size = Math.abs(signedSize);
      const usd = size * mid;
      if (usd === 0) continue;
      if (usd > maxUsd) maxUsd = usd;
      const x = ((b.minPrice - lo) / (hi - lo)) * (CHART_WIDTH - 2 * CHART_PADDING_X) + CHART_PADDING_X;
      const w = ((b.maxPrice - b.minPrice) / (hi - lo)) * (CHART_WIDTH - 2 * CHART_PADDING_X);
      bars.push({
        mid,
        usd,
        side: mid < cur ? "long" : "short",
        x,
        w,
      });
    }
    const curX =
      ((cur - lo) / (hi - lo)) * (CHART_WIDTH - 2 * CHART_PADDING_X) + CHART_PADDING_X;

    const totalLongUsd = data.totalLongLiquidations.size * cur;
    const totalShortUsd = data.totalShortLiquidations.size * cur;

    return {
      bars,
      maxUsd,
      curX,
      lo,
      hi,
      cur,
      totalLongUsd,
      totalShortUsd,
    };
  }, [data]);

  if (!coinIndex) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Liquidation Map</span>
        </div>
        <div className="liq-status">Loading…</div>
      </section>
    );
  }
  if (coinIndex.perpAssetIdByCoin[coin] === undefined) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Liquidation Map</span>
        </div>
        <div className="liq-status">No perpetual market for {coin}</div>
      </section>
    );
  }
  if (loading && !data) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Liquidation Map</span>
          <span className="liq-head-window">3d</span>
        </div>
        <div className="liq-status">Loading…</div>
      </section>
    );
  }
  if (error || !data || !view) {
    return (
      <section className="liq">
        <div className="liq-head">
          <span className="liq-head-label">Liquidation Map</span>
        </div>
        <div className={`liq-status ${error ? "liq-error" : ""}`}>
          {error ? "Failed to load" : "No liquidation data"}
        </div>
      </section>
    );
  }

  const topLong = data.topLongLiquidations.slice(0, 3);
  const topShort = data.topShortLiquidations.slice(0, 3);

  return (
    <section className="liq">
      <div className="liq-head">
        <span className="liq-head-label">Liquidation Map</span>
        <span className="liq-head-window">3d · ±20%</span>
      </div>

      <div className="liq-totals">
        <div className="liq-total long">
          <div className="liq-total-top">
            <span className="liq-total-tag">▼ LONG LIQ</span>
            <span className="liq-total-count">
              {fmtCount(data.totalLongLiquidations.count)}
            </span>
          </div>
          <div className="liq-total-value">{fmtUsd(view.totalLongUsd)}</div>
        </div>
        <div className="liq-total short">
          <div className="liq-total-top">
            <span className="liq-total-tag">▲ SHORT LIQ</span>
            <span className="liq-total-count">
              {fmtCount(data.totalShortLiquidations.count)}
            </span>
          </div>
          <div className="liq-total-value">{fmtUsd(view.totalShortUsd)}</div>
        </div>
      </div>

      <div className="liq-chart-wrap">
        <svg
          className="liq-chart"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Liquidation map for ${coin}`}
        >
          {/* Bars */}
          {view.bars.map((b, i) => {
            const h =
              view.maxUsd > 0
                ? (b.usd / view.maxUsd) * (CHART_HEIGHT - 2 * CHART_PADDING_Y)
                : 0;
            const y = CHART_HEIGHT - CHART_PADDING_Y - h;
            return (
              <rect
                key={i}
                x={b.x}
                y={y}
                width={Math.max(0.6, b.w - 0.4)}
                height={h}
                className={b.side === "long" ? "liq-bar-long" : "liq-bar-short"}
              />
            );
          })}
          {/* Current price line */}
          <line
            x1={view.curX}
            y1={0}
            x2={view.curX}
            y2={CHART_HEIGHT}
            className="liq-cur-line"
          />
        </svg>
        <div className="liq-axis">
          <span>{fmtUsd(view.lo)}</span>
          <span className="liq-axis-cur">{fmtUsd(view.cur)}</span>
          <span>{fmtUsd(view.hi)}</span>
        </div>
      </div>

      {(topLong.length > 0 || topShort.length > 0) && (
        <div className="liq-top">
          {topLong.length > 0 && (
            <ul className="liq-top-list">
              {topLong.map((t) => (
                <li key={`L${t.address}-${t.price}`} className="long">
                  <a
                    className="liq-top-link"
                    href={`https://hypurrscan.io/address/${t.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t.address}
                  >
                    <span className="liq-top-side">▼</span>
                    <span className="liq-top-addr">{shortAddr(t.address)}</span>
                    <span className="liq-top-price">@{fmtPrice(t.price)}</span>
                    <span className="liq-top-size">{fmtUsd(t.size * t.price)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {topShort.length > 0 && (
            <ul className="liq-top-list">
              {topShort.map((t) => (
                <li key={`S${t.address}-${t.price}`} className="short">
                  <a
                    className="liq-top-link"
                    href={`https://hypurrscan.io/address/${t.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t.address}
                  >
                    <span className="liq-top-side">▲</span>
                    <span className="liq-top-addr">{shortAddr(t.address)}</span>
                    <span className="liq-top-price">@{fmtPrice(t.price)}</span>
                    <span className="liq-top-size">{fmtUsd(t.size * t.price)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
