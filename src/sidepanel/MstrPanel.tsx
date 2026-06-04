import { useEffect, useRef, useState } from "react";
import {
  fetchMstrSnapshot,
  fetchMstrHistory,
  type MstrSnapshot,
  type MstrHistory,
  type MstrTrade,
} from "../lib/mstrTreasury";

const REFRESH_MS = 60_000;

type Props = { refreshKey: number };

export default function MstrPanel({ refreshKey }: Props) {
  const [snap, setSnap] = useState<MstrSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Accumulation history comes from the full-history file (~16MB raw, but
  // brotli on the wire + immutable cache, so it's cheap after the first hit).
  // Loaded automatically on open.
  const [history, setHistory] = useState<MstrHistory | null>(null);
  const [histError, setHistError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchMstrSnapshot();
        if (cancelled) return;
        setSnap(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (!silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };
    void run(false);
    const id = setInterval(() => {
      if (!document.hidden) void run(true);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchMstrHistory();
        if (!cancelled) {
          setHistory(next);
          setHistError(null);
        }
      } catch (e) {
        if (!cancelled) setHistError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (loading && !snap) {
    return (
      <section className="hs">
        <Header />
        <div className="fr-status">Loading Strategy treasury…</div>
      </section>
    );
  }
  if (error && !snap) {
    return (
      <section className="hs">
        <Header />
        <div className="fr-status fr-error">Failed to load: {error}</div>
      </section>
    );
  }
  if (!snap) return null;

  const pnlPos = snap.unrealizedPnl >= 0;
  const mnavPremium = snap.mnav >= 1;

  return (
    <section className="hs">
      <Header />

      <div className="hs-card">
        <div className="hs-hero">
          <div className="hs-hero-label">Strategy (MSTR) · Bitcoin Holdings</div>
          <div className="hs-hero-value">{fmtBtc(snap.holdings)} BTC</div>
          <div className="hs-hero-hint">
            ≈ {fmtUsd(snap.btcNav)}
            {snap.pctOfBtcSupply > 0 &&
              ` · ${snap.pctOfBtcSupply.toFixed(2)}% of all bitcoin`}
          </div>
        </div>

        <div className="hs-grid">
          <Stat label="Avg cost / BTC" value={fmtUsd0(snap.avgCost)} />
          <Stat label="Cost basis" value={fmtUsd(snap.costBasis)} />
          <Stat
            label="Unrealized P/L"
            value={`${pnlPos ? "+" : "−"}${fmtUsd(Math.abs(snap.unrealizedPnl))}`}
            sub={`${pnlPos ? "+" : ""}${snap.unrealizedPnlPct.toFixed(1)}%`}
            tone={pnlPos ? "pos" : "neg"}
          />
          <Stat
            label="mNAV"
            value={`${snap.mnav.toFixed(2)}×`}
            sub={mnavPremium ? "premium" : "discount"}
            tone={mnavPremium ? "pos" : "neg"}
          />
          <Stat
            label="MSTR stock"
            value={fmtUsd0(snap.stockPrice)}
            sub={
              snap.stockChangePct == null
                ? undefined
                : `${snap.stockChangePct >= 0 ? "+" : ""}${snap.stockChangePct.toFixed(1)}%`
            }
            tone={
              snap.stockChangePct == null
                ? undefined
                : snap.stockChangePct >= 0
                  ? "pos"
                  : "neg"
            }
          />
          <Stat
            label="BTC yield YTD"
            value={`${snap.btcYieldYtd >= 0 ? "+" : ""}${snap.btcYieldYtd.toFixed(1)}%`}
            tone={snap.btcYieldYtd >= 0 ? "pos" : undefined}
          />
        </div>

        <div className="hs-hero-hint mstr-asof">
          mNAV = market cap ÷ BTC value. &lt;1× means the stock trades below the
          bitcoin it holds.
        </div>
      </div>

      <div className="hs-card">
        <div className="hs-chart-head">
          <div className="hs-chart-label">Accumulation history</div>
          {history && (
            <div className="hs-chart-peak">
              {history.trades.length
                ? `latest · ${fmtShortDate(history.trades[0].date)}`
                : ""}
            </div>
          )}
        </div>

        {!history && !histError && (
          <div className="fr-status">Loading accumulation history…</div>
        )}
        {histError && !history && (
          <div className="fr-status fr-error">
            History load failed: {histError}
          </div>
        )}

        {history && (
          <>
            <HoldingsChart data={history.holdings} />
            <div className="hs-divider" />
            <div className="hs-chart-head">
              <div className="hs-chart-label">Recent activity</div>
            </div>
            <TradeList trades={history.trades} />
          </>
        )}
      </div>
    </section>
  );
}

function Header() {
  return (
    <div className="hs-head">
      <span className="hs-head-label">MSTR · Bitcoin Treasury</span>
      <span className="hs-head-src">StrategyTracker · CoinGecko</span>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="hs-stat">
      <span className="hs-stat-label">{label}</span>
      <span className={`hs-stat-val${tone ? ` mstr-${tone}` : ""}`}>
        {value}
      </span>
      {sub && <span className={`mstr-stat-sub${tone ? ` mstr-${tone}` : ""}`}>{sub}</span>}
    </div>
  );
}

function TradeList({ trades }: { trades: MstrTrade[] }) {
  if (!trades.length) {
    return <div className="fr-status">No activity found.</div>;
  }
  return (
    <div className="mstr-buys">
      {trades.map((t) => {
        const sell = t.side === "sell";
        return (
          <a
            key={`${t.date}-${t.side}`}
            className="mstr-buy"
            href={edgarUrl(t.date)}
            target="_blank"
            rel="noopener noreferrer"
            title={`${sell ? "Sale" : "Purchase"} disclosed around ${fmtShortDate(
              t.date,
            )} — open SEC 8-K filings`}
          >
            <span className="mstr-buy-date">{fmtShortDate(t.date)}</span>
            <span className={`mstr-buy-btc${sell ? " mstr-neg" : ""}`}>
              {sell ? "−" : "+"}
              {fmtBtc(t.btc)} BTC
            </span>
            <span className="mstr-buy-cost">
              {fmtUsd(t.estUsd)}
              <span className="mstr-buy-px"> @ {fmtUsd0(t.btcPrice)}</span>
              <span className="mstr-buy-ext" aria-hidden="true"> ↗</span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

// Strategy (CIK 0001050446) discloses each BTC purchase/sale in an 8-K. Land
// the user on the company's 8-K list dated just after the move so the relevant
// filing is near the top.
const MSTR_CIK = "1050446";

function edgarUrl(date: string): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 10);
  const dateb = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${MSTR_CIK}&type=8-K&dateb=${dateb}&owner=include&count=10`;
}

// --- Holdings chart --------------------------------------------------------

const CHART_W = 340;
const CHART_PAD_L = 8;
const CHART_PAD_R = 6;
const CHART_PAD_T = 6;
const CHART_PLOT_H = 90;
const CHART_X_AXIS_H = 14;
const CHART_H = CHART_PAD_T + CHART_PLOT_H + CHART_X_AXIS_H;

function HoldingsChart({ data }: { data: { date: string; btc: number }[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length < 2) return null;

  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;
  const max = Math.max(...data.map((d) => d.btc));

  const xAt = (i: number) => plotLeft + (i / (data.length - 1)) * plotW;
  const yAt = (btc: number) => plotBottom - (btc / max) * CHART_PLOT_H;

  const line = data.map((d, i) => `${xAt(i)},${yAt(d.btc)}`).join(" ");
  const area = `${plotLeft},${plotBottom} ${line} ${plotRight},${plotBottom}`;

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    if (vbX < plotLeft || vbX > plotRight) {
      setHoverIdx(null);
      return;
    }
    const frac = (vbX - plotLeft) / plotW;
    setHoverIdx(
      Math.max(0, Math.min(data.length - 1, Math.round(frac * (data.length - 1)))),
    );
  };

  const hover = hoverIdx != null ? data[hoverIdx] : null;

  return (
    <div className="hs-chart">
      <div
        className="fr-chart-wrap"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          ref={svgRef}
          className="hs-chart-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Strategy BTC holdings over time"
        >
          <polyline points={area} className="mstr-area" />
          <polyline points={line} className="mstr-line" />
          {hover && (
            <>
              <line
                x1={xAt(hoverIdx!)}
                x2={xAt(hoverIdx!)}
                y1={CHART_PAD_T}
                y2={plotBottom}
                className="fr-crosshair"
                pointerEvents="none"
              />
              <circle cx={xAt(hoverIdx!)} cy={yAt(hover.btc)} r={2.5} className="mstr-dot" />
            </>
          )}
          <text
            x={plotLeft}
            y={plotBottom + CHART_X_AXIS_H - 2}
            className="hs-chart-axis"
            textAnchor="start"
          >
            {fmtShortDate(data[0].date)}
          </text>
          <text
            x={plotRight}
            y={plotBottom + CHART_X_AXIS_H - 2}
            className="hs-chart-axis"
            textAnchor="end"
          >
            {fmtShortDate(data[data.length - 1].date)}
          </text>
        </svg>
        {hover && (
          <div
            className="fr-tooltip center"
            style={{ left: `${(xAt(hoverIdx!) / CHART_W) * 100}%` }}
          >
            <div className="fr-tooltip-date">{fmtShortDate(hover.date)}</div>
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-name">Holdings</span>
              <span className="fr-tooltip-val">{fmtBtc(hover.btc)} BTC</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- formatters ------------------------------------------------------------

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtUsd0(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtBtc(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}
