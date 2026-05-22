import { useEffect, useState } from "react";
import { fetchActiveTwaps, type TwapEntry } from "../lib/hypurrscan";
import { getAssetIdsForCoin, type CoinIndex } from "../lib/coinMap";

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

type Props = { coin: string; coinIndex: CoinIndex | null; refreshKey: number };

const COLLAPSED_COUNT = 5;

export default function TwapPanel({ coin, coinIndex, refreshKey }: Props) {
  const [entries, setEntries] = useState<TwapEntry[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!coinIndex) return;
    let cancelled = false;
    const { perpAssetId, spotAssetIds } = getAssetIdsForCoin(coinIndex, coin);
    fetchActiveTwaps(perpAssetId, spotAssetIds)
      .then((es) => {
        if (!cancelled) {
          setEntries(es);
          setExpanded(false);
        }
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

  if (!entries || entries.length === 0) return null;

  const buys = entries.filter((e) => e.isBuy);
  const sells = entries.filter((e) => !e.isBuy);
  const buyUsd = buys.reduce((a, e) => a + e.remainingUsd, 0);
  const sellUsd = sells.reduce((a, e) => a + e.remainingUsd, 0);
  const totalUsd = buyUsd + sellUsd;
  const buyPct = totalUsd === 0 ? 50 : (buyUsd / totalUsd) * 100;
  const sellPct = 100 - buyPct;

  const sorted = [...entries].sort((a, b) => b.remainingUsd - a.remainingUsd);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sorted.length - visible.length;

  return (
    <section className="twap">
      <div className="twap-head">
        <span className="twap-head-label">Active TWAPs</span>
        <span className="twap-head-count">{entries.length}</span>
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
        {visible.map((e) => (
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

      {sorted.length > COLLAPSED_COUNT && (
        <button
          type="button"
          className="twap-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less ▲" : `Show ${hiddenCount} more ▼`}
        </button>
      )}
    </section>
  );
}
