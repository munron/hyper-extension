import { useEffect, useState } from "react";
import { fetchActiveTwaps, type Market, type TwapEntry } from "../lib/hypurrscan";
import { getAssetIdsForCoin, type CoinIndex } from "../lib/coinMap";

type MarketFilter = "all" | Market;

const FILTERS: { id: MarketFilter; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "perp", label: "PERP" },
  { id: "spot", label: "SPOT" },
];

function fmtSize(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(0);
  return n.toFixed(2);
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function fmtEta(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

// Full grouped USD ("968,272"), no $ — the caller appends sign + "$".
function fmtFullUsd(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Net buy notional (USD) projected to execute within the next `windowMs`.
// A TWAP fills its total notional ~linearly over its duration (slices every
// ~30s), so the portion landing inside the window is
//   (totalUsd / durationMs) * min(windowMs, remainingMs).
// Buys add, sells subtract — the sum is the net buy pressure for that window.
function windowNetUsd(
  entries: TwapEntry[],
  windowMs: number,
  now: number,
): number {
  let net = 0;
  for (const e of entries) {
    if (e.durationMs <= 0) continue;
    const remainingMs = Math.max(0, e.endsAt - now);
    const inWindow = Math.min(windowMs, remainingMs);
    if (inWindow <= 0) continue;
    const notional = (e.totalUsd / e.durationMs) * inWindow;
    net += e.isBuy ? notional : -notional;
  }
  return net;
}

type Props = { coin: string; coinIndex: CoinIndex | null; refreshKey: number };

export default function TwapPanel({ coin, coinIndex, refreshKey }: Props) {
  const [entries, setEntries] = useState<TwapEntry[] | null>(null);
  const [filter, setFilter] = useState<MarketFilter>("all");

  useEffect(() => {
    if (!coinIndex) return;
    let cancelled = false;
    const { perpAssetId, spotAssetIds } = getAssetIdsForCoin(coinIndex, coin);
    fetchActiveTwaps(perpAssetId, spotAssetIds)
      .then((es) => {
        if (!cancelled) setEntries(es);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn("fetchActiveTwaps failed", e);
          setEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [coin, coinIndex, refreshKey]);

  const FilterTabs = (
    <div className="twap-filter" role="tablist">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="tab"
          aria-selected={filter === f.id}
          className={`twap-filter-btn ${filter === f.id ? "active" : ""}`}
          onClick={() => setFilter(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  if (!entries) {
    return (
      <section className="twap">
        <div className="twap-head">
          <span className="twap-head-label">Active TWAPs</span>
          {FilterTabs}
        </div>
        <div className="twap-empty">Loading…</div>
      </section>
    );
  }

  const filtered =
    filter === "all" ? entries : entries.filter((e) => e.market === filter);

  if (entries.length === 0 || filtered.length === 0) {
    return (
      <section className="twap">
        <div className="twap-head">
          <span className="twap-head-label">Active TWAPs</span>
          {FilterTabs}
        </div>
        <div className="twap-empty">
          {entries.length === 0
            ? `No active TWAPs for ${coin}`
            : `No active ${filter.toUpperCase()} TWAPs for ${coin}`}
        </div>
      </section>
    );
  }

  const buys = filtered.filter((e) => e.isBuy);
  const sells = filtered.filter((e) => !e.isBuy);
  const buyUsd = buys.reduce((a, e) => a + e.remainingUsd, 0);
  const sellUsd = sells.reduce((a, e) => a + e.remainingUsd, 0);
  const totalUsd = buyUsd + sellUsd;
  const buyPct = totalUsd === 0 ? 50 : (buyUsd / totalUsd) * 100;
  const sellPct = 100 - buyPct;

  const sorted = [...filtered].sort((a, b) => b.remainingUsd - a.remainingUsd);

  const now = Date.now();
  const next1h = windowNetUsd(filtered, HOUR_MS, now);
  const next24h = windowNetUsd(filtered, DAY_MS, now);

  return (
    <section className="twap">
      <div className="twap-head">
        <span className="twap-head-label">Active TWAPs</span>
        <span className="twap-head-count">{filtered.length}</span>
        {FilterTabs}
      </div>

      <div className="twap-pressure">
        <div className="twap-pressure-title">TWAPs {coin} Buy Pressure</div>
        <PressureRow label="Next 1h" value={next1h} />
        <PressureRow label="Next 24h" value={next24h} />
      </div>

      <div className="twap-totals">
        <div className="twap-total buy">
          <div className="twap-total-top">
            <span className="twap-total-tag">▲ BUY</span>
            <span className="twap-total-count">{buys.length}</span>
          </div>
          <div className="twap-total-value">{fmtUsd(buyUsd)}</div>
          <div className="twap-total-pct">{buyPct.toFixed(0)}%</div>
        </div>
        <div className="twap-total sell">
          <div className="twap-total-top">
            <span className="twap-total-tag">▼ SELL</span>
            <span className="twap-total-count">{sells.length}</span>
          </div>
          <div className="twap-total-value">{fmtUsd(sellUsd)}</div>
          <div className="twap-total-pct">{sellPct.toFixed(0)}%</div>
        </div>
      </div>

      <div className="twap-bar">
        <div className="twap-bar-buy" style={{ width: `${buyPct}%` }} />
        <div className="twap-bar-sell" style={{ width: `${sellPct}%` }} />
      </div>

      <ul className="twap-list">
        {sorted.map((e) => (
          <li key={e.hash} className={e.isBuy ? "buy" : "sell"}>
            <a
              className="twap-row-link"
              href={`https://hypurrscan.io/address/${e.user}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`${e.user} — open in hypurrscan`}
            >
              <span className="twap-row-side">{e.isBuy ? "▲" : "▼"}</span>
              <span className={`market-tag ${e.market}`}>{e.market.toUpperCase()}</span>
              <div className="twap-row-amount">
                <span className="twap-row-usd">{fmtUsd(e.remainingUsd)}</span>
                <span className="twap-row-size">{fmtSize(e.remainingSize)}</span>
              </div>
              <div className="twap-progress">
                <div className="twap-progress-fill" style={{ width: `${e.progress * 100}%` }} />
              </div>
              <span className="twap-row-eta">{fmtEta(e.endsAt - Date.now())}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PressureRow({ label, value }: { label: string; value: number }) {
  const pos = value >= 0;
  return (
    <div className="twap-pressure-row">
      <span className="twap-pressure-label">{label}:</span>
      <span className={`twap-pressure-val ${pos ? "pos" : "neg"}`}>
        {pos ? "+" : "−"}
        {fmtFullUsd(Math.abs(value))}$
      </span>
    </div>
  );
}
