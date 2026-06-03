import { useEffect, useMemo, useRef, useState } from "react";
import {
  binByTime,
  fetchUnstakingQueue,
  summarize,
  topUpcoming,
  type UnstakeBin,
  type UnstakeEntry,
} from "../lib/hypeUnstaking";
import { getPerpPrice } from "../lib/prices";
import type { CoinIndex } from "../lib/coinMap";

const REFRESH_MS = 30_000;
const BIN_HOURS = 6;
const BIN_MS = BIN_HOURS * 3_600_000;
const HORIZON_DAYS = 7;
const TOP_N = 10;

type Props = { refreshKey: number; coinIndex: CoinIndex | null };

export default function HypeUnstakingPanel({ refreshKey, coinIndex }: Props) {
  const [entries, setEntries] = useState<UnstakeEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Two clocks: a fast one for the countdown display, and a slow one that
  // gates the heavy bin/summary recomputation. Without the split, every
  // 1s tick re-binned thousands of entries and re-rendered the whole chart.
  const [nowFast, setNowFast] = useState(() => Date.now());
  const [nowSlow, setNowSlow] = useState(() => Date.now());
  const [hypeUsd, setHypeUsd] = useState<number | null>(null);

  const hypePerpId = coinIndex?.perpAssetIdByCoin["HYPE"] ?? null;
  useEffect(() => {
    if (hypePerpId == null) return;
    let cancelled = false;
    const run = async () => {
      try {
        const px = await getPerpPrice(hypePerpId);
        if (!cancelled && px > 0) setHypeUsd(px);
      } catch {
        // keep last known price
      }
    };
    void run();
    const id = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hypePerpId, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchUnstakingQueue();
        if (cancelled) return;
        setEntries(next);
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

  // Tick countdowns every second — the hero card lives off this.
  useEffect(() => {
    const id = setInterval(() => setNowFast(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Slow clock for heavy data work. With 6h bins, recomputing every minute
  // (let alone every second) is overkill — the bin boundary shifts maybe
  // every hour. 60s is a good middle ground.
  useEffect(() => {
    const id = setInterval(() => setNowSlow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const data = useMemo(() => {
    if (!entries) return null;
    const summary = summarize(entries, nowSlow);
    const horizonEnd = nowSlow + HORIZON_DAYS * 86_400_000;
    const bins = binByTime(entries, nowSlow, horizonEnd, BIN_MS);
    const top = topUpcoming(entries, nowSlow, TOP_N);
    const whales = entries.filter(
      (e) => e.time >= nowSlow && e.hype >= summary.whaleThreshold,
    );
    return { summary, bins, top, whales, horizonEnd };
  }, [entries, nowSlow]);

  if (loading && !entries) {
    return (
      <section className="us">
        <Header />
        <div className="fr-status">Loading unstaking queue…</div>
      </section>
    );
  }
  if (error && !entries) {
    return (
      <section className="us">
        <Header />
        <div className="fr-status fr-error">Failed to load: {error}</div>
      </section>
    );
  }
  if (!data) return null;
  const { summary, bins, top, whales, horizonEnd } = data;

  return (
    <section className="us">
      <Header />

      <Hero summary={summary} now={nowFast} hypeUsd={hypeUsd} />

      <Stats summary={summary} hypeUsd={hypeUsd} />

      <Timeline
        bins={bins}
        whales={whales}
        now={nowSlow}
        horizonEnd={horizonEnd}
      />

      <div className="us-section-label">Largest queued unlocks</div>
      <ol className="us-list">
        {top.map((e) => (
          <li key={`${e.user}-${e.time}`} className="us-list-row">
            <span className="us-list-amt">
              {fmtHype(e.hype)}
              {hypeUsd != null && (
                <span className="us-list-usd">{fmtUsd(e.hype * hypeUsd)}</span>
              )}
            </span>
            <span className="us-list-when">
              <span className="us-list-cd">{fmtCountdown(e.time - nowFast)}</span>
              <span className="us-list-dt">{fmtShortDate(e.time)}</span>
            </span>
            <a
              className="us-list-user"
              href={`https://hypurrscan.io/address/${e.user}`}
              target="_blank"
              rel="noreferrer"
              title={e.user}
            >
              {shortAddr(e.user)}
              <span className="us-list-launch" aria-hidden="true">↗</span>
            </a>
          </li>
        ))}
      </ol>

      <div className="us-foot">
        Queue from hypurrscan · {summary.totalCount.toLocaleString()} entries ·
        bin = {BIN_HOURS}h · whale ≥ {fmtHype(summary.whaleThreshold)}
      </div>
    </section>
  );
}

function Header() {
  return (
    <div className="us-head">
      <span className="us-head-label">HYPE Unstaking Queue</span>
    </div>
  );
}

// --- Hero: "next big unlock" -----------------------------------------------

function Hero({
  summary,
  now,
  hypeUsd,
}: {
  summary: ReturnType<typeof summarize>;
  now: number;
  hypeUsd: number | null;
}) {
  const target = summary.nextBigEntry ?? summary.biggestEntry;
  if (!target) {
    return (
      <div className="us-hero empty">
        <span className="us-hero-label">Next unlock</span>
        <span className="us-hero-empty">queue clear</span>
      </div>
    );
  }
  const isNear = target.time - now < 48 * 3_600_000;
  // % of the queue's 7-day unlock that this single entry represents —
  // contextualizes "is this a single whale or a drop in the bucket?"
  const sharePct =
    summary.next7dHype > 0 ? (target.hype / summary.next7dHype) * 100 : null;
  return (
    <div className={`us-hero${isNear ? " near" : ""}`}>
      <div className="us-hero-top">
        <span className="us-hero-label">
          {isNear ? "Next big unlock" : "Biggest queued unlock"}
        </span>
        <span className="us-hero-cd">{fmtCountdown(target.time - now)}</span>
      </div>
      <div className="us-hero-amt">
        {fmtHype(target.hype)}
        {hypeUsd != null && (
          <span className="us-hero-usd">{fmtUsd(target.hype * hypeUsd)}</span>
        )}
      </div>
      <div className="us-hero-meta">
        <span className="us-hero-dt">{fmtFullDate(target.time)}</span>
        {sharePct != null && (
          <span className="us-hero-share">
            {sharePct.toFixed(1)}% of next 7d
          </span>
        )}
        <a
          className="us-hero-user"
          href={`https://hypurrscan.io/address/${target.user}`}
          target="_blank"
          rel="noreferrer"
          title={target.user}
        >
          {shortAddr(target.user)} ↗
        </a>
      </div>
    </div>
  );
}

// --- Stats strip -----------------------------------------------------------

function Stats({
  summary,
  hypeUsd,
}: {
  summary: ReturnType<typeof summarize>;
  hypeUsd: number | null;
}) {
  const usdSub = (hype: number) =>
    hypeUsd != null ? fmtUsd(hype * hypeUsd) : undefined;
  return (
    <div className="us-stats">
      <Stat
        label="Next 24h"
        value={fmtHype(summary.next24hHype)}
        sub={usdSub(summary.next24hHype)}
      />
      <Stat
        label="Next 7d"
        value={fmtHype(summary.next7dHype)}
        sub={usdSub(summary.next7dHype)}
      />
      <Stat
        label="Total queued"
        value={fmtHype(summary.totalHype)}
        sub={
          hypeUsd != null
            ? `${fmtUsd(summary.totalHype * hypeUsd)} · ${summary.totalCount.toLocaleString()} entries`
            : `${summary.totalCount.toLocaleString()} entries`
        }
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="us-stat">
      <span className="us-stat-label">{label}</span>
      <span className="us-stat-val">{value}</span>
      {sub && <span className="us-stat-sub">{sub}</span>}
    </div>
  );
}

// --- Timeline histogram ----------------------------------------------------

const CHART_W = 340;
const CHART_PAD_L = 30;
const CHART_PAD_R = 6;
const CHART_PAD_T = 8;
const CHART_PLOT_H = 90;
const CHART_X_AXIS_H = 16;
const CHART_H = CHART_PAD_T + CHART_PLOT_H + CHART_X_AXIS_H;

function Timeline({
  bins,
  whales,
  now,
  horizonEnd,
}: {
  bins: UnstakeBin[];
  whales: UnstakeEntry[];
  now: number;
  horizonEnd: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;

  const maxBin = Math.max(1, ...bins.map((b) => b.hype));
  const xFor = (t: number) =>
    plotLeft + ((t - now) / (horizonEnd - now)) * plotW;
  const yFor = (h: number) =>
    CHART_PAD_T + (1 - h / maxBin) * CHART_PLOT_H;

  // Bar width: tight gap (1px) between bars for legibility.
  const barW = Math.max(2, plotW / bins.length - 1);

  // Day grid + labels at every other day to avoid crowding.
  const dayTicks: { t: number; label: string }[] = [];
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const t = now + i * 86_400_000;
    dayTicks.push({
      t,
      label: i === 0 ? "now" : `+${i}d`,
    });
  }

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    if (vbX < plotLeft - 2 || vbX > plotRight + 2) {
      setHoverIdx(null);
      return;
    }
    const frac = (vbX - plotLeft) / plotW;
    const idx = Math.max(0, Math.min(bins.length - 1, Math.floor(frac * bins.length)));
    setHoverIdx(idx);
  };
  const handleLeave = () => setHoverIdx(null);

  const hover = hoverIdx != null ? bins[hoverIdx] : null;
  const hoverWhales = hover
    ? whales.filter(
        (w) => w.time >= hover.start && w.time < hover.start + BIN_MS,
      )
    : [];

  // Soft y-axis ticks at 0 / 50 / 100% of max.
  const yTicks = [maxBin, maxBin / 2, 0];

  return (
    <div className="us-chart">
      <div
        className="fr-chart-wrap"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <svg
          ref={svgRef}
          className="us-chart-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Upcoming HYPE unlock schedule"
        >
          {yTicks.map((v, i) => {
            const y = yFor(v);
            return (
              <g key={`y${i}`}>
                <line
                  x1={plotLeft}
                  x2={plotRight}
                  y1={y}
                  y2={y}
                  className="us-chart-grid"
                />
                <text
                  x={plotLeft - 3}
                  y={y}
                  className="us-chart-axis"
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {fmtHypeAxis(v)}
                </text>
              </g>
            );
          })}

          {bins.map((b, i) => {
            if (b.hype === 0) return null;
            const x = xFor(b.start);
            const y = yFor(b.hype);
            const h = plotBottom - y;
            // Color: light at floor → bright at peak. Easy visual peak read.
            const intensity = b.hype / maxBin;
            return (
              <rect
                key={`bar${i}`}
                x={x}
                y={y}
                width={barW}
                height={h}
                className={`us-chart-bar${hoverIdx === i ? " hover" : ""}`}
                opacity={0.45 + intensity * 0.55}
              />
            );
          })}

          {/* Whale markers — disabled for now; meaning was unclear in UI.
          {whales.map((w) => {
            const x = xFor(w.time);
            if (x < plotLeft - 2 || x > plotRight + 2) return null;
            const maxWhale = Math.max(...whales.map((x) => x.hype), 1);
            const r = 2 + (w.hype / maxWhale) * 4;
            return (
              <circle
                key={`w${w.user}-${w.time}`}
                cx={x}
                cy={plotBottom - 2}
                r={r}
                className="us-chart-whale"
              >
                <title>{`${fmtHype(w.hype)} · ${fmtFullDate(w.time)} · ${shortAddr(w.user)}`}</title>
              </circle>
            );
          })}
          */}

          {dayTicks.map((d, i) => {
            const x = xFor(d.t);
            const show = true;
            return (
              <g key={`d${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={CHART_PAD_T}
                  y2={plotBottom}
                  className={i === 0 ? "us-chart-now" : "us-chart-dayline"}
                />
                {show && (
                  <text
                    x={x}
                    y={plotBottom + CHART_X_AXIS_H - 3}
                    className="us-chart-axis us-chart-xaxis"
                    textAnchor={i === 0 ? "start" : "middle"}
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}

          {hoverIdx != null && hover && (
            <line
              x1={xFor(hover.start) + barW / 2}
              x2={xFor(hover.start) + barW / 2}
              y1={CHART_PAD_T}
              y2={plotBottom}
              className="fr-crosshair"
              pointerEvents="none"
            />
          )}
        </svg>

        {hover && (
          <div
            className="fr-tooltip center"
            style={{
              left: `${((xFor(hover.start) + barW / 2) / CHART_W) * 100}%`,
            }}
          >
            <div className="fr-tooltip-date">
              {fmtShortDate(hover.start)} – {fmtShortDate(hover.start + BIN_MS)}
            </div>
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-name">Released</span>
              <span className="fr-tooltip-val">{fmtHype(hover.hype)}</span>
            </div>
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-name">Entries</span>
              <span className="fr-tooltip-val">{hover.count}</span>
            </div>
            {hoverWhales.length > 0 && (
              <div className="fr-tooltip-row">
                <span className="fr-tooltip-name">Whales</span>
                <span className="fr-tooltip-val">
                  {hoverWhales.length} (max{" "}
                  {fmtHype(Math.max(...hoverWhales.map((w) => w.hype)))})
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- formatters ------------------------------------------------------------

function fmtHype(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M HYPE`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k HYPE`;
  return `${n.toFixed(0)} HYPE`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtHypeAxis(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toFixed(0);
}

function fmtCountdown(dtMs: number): string {
  if (dtMs <= 0) return "now";
  const totalMin = Math.floor(dtMs / 60_000);
  if (totalMin < 60) {
    const s = Math.floor((dtMs % 60_000) / 1000);
    return `${totalMin}m ${s.toString().padStart(2, "0")}s`;
  }
  const h = Math.floor(totalMin / 60);
  if (h < 48) {
    const m = totalMin - h * 60;
    return `${h}h ${m}m`;
  }
  const d = Math.floor(h / 24);
  const remH = h - d * 24;
  return `${d}d ${remH}h`;
}

function fmtFullDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtShortDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
