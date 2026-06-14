import { useEffect, useMemo, useRef, useState } from "react";
import { fetchHypeStats, type DailyPoint, type HypeStats } from "../lib/hypeStats";
// ETF flows: coinglass capi switched to an unrecovered cipher (ev=3), so we
// now scrape farside.co.uk/hyp/ instead. The old coinglass module is kept in
// the tree for reference.
import { fetchHypeEtfFlow, type EtfFlowDay } from "../lib/farsideEtf";
import { fetchEtfVolume, type EtfVolumeDay } from "../lib/yahooEtfVolume";

const REFRESH_MS = 60_000;
const CHART_DAYS = 90;

type Props = { refreshKey: number; subTab: "revenue" | "etf" };

export default function HypeStatsPanel({ refreshKey, subTab }: Props) {
  const [stats, setStats] = useState<HypeStats | null>(null);
  const [etf, setEtf] = useState<EtfFlowDay[] | null>(null);
  const [etfError, setEtfError] = useState<string | null>(null);
  const [etfVolume, setEtfVolume] = useState<{ days: EtfVolumeDay[]; tickers: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchHypeStats();
        if (cancelled) return;
        setStats(next);
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

  // ETF flows refresh once a day's worth of cadence is plenty; we still
  // re-fetch on refreshKey changes.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const next = await fetchHypeEtfFlow();
        if (cancelled) return;
        setEtf(next);
        setEtfError(null);
      } catch (e) {
        if (cancelled) return;
        setEtfError(e instanceof Error ? e.message : String(e));
      }
    };
    const runVolume = async () => {
      try {
        const v = await fetchEtfVolume();
        if (cancelled) return;
        setEtfVolume(v);
      } catch {
        // volume is supplementary; don't block on failure
      }
    };
    void run();
    void runVolume();
    const id = setInterval(() => {
      if (!document.hidden) {
        void run();
        void runVolume();
      }
    }, REFRESH_MS * 5);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  const chartData: DailyPoint[] = useMemo(
    () => (stats ? stats.dailyRevenue.slice(-CHART_DAYS) : []),
    [stats],
  );

  if (loading && !stats) {
    return (
      <section className="hs">
        <Header />
        <div className="fr-status">Loading protocol stats…</div>
      </section>
    );
  }
  if (error && !stats) {
    return (
      <section className="hs">
        <Header />
        <div className="fr-status fr-error">Failed to load: {error}</div>
      </section>
    );
  }
  if (!stats) return null;

  const peak = chartData.reduce((m, p) => Math.max(m, p.value), 0);

  return (
    <section className="hs">
      {subTab === "revenue" && (
        <>
          <Header />
          <div className="hs-card">
            <div className="hs-hero">
              <div className="hs-hero-label">Hyperliquid · Revenue 24h</div>
              <div className="hs-hero-value">{fmtUsd(stats.revenue24h)}</div>
              <div className="hs-hero-hint">
                ≒ Funds the AF uses to buy back & burn HYPE
              </div>
            </div>

            <div className="hs-grid">
              <Stat label="All-time revenue" value={fmtUsd(stats.revenueAllTime)} />
              <Stat label="All-time burnt" value={`${fmtHype(stats.burnAllTime)} HYPE`} />
              <Stat
                label="% of supply burnt"
                value={`${stats.percentBurnAllTime.toFixed(2)}%`}
              />
            </div>

            <div className="hs-divider" />

            <div className="hs-chart-head">
              <div className="hs-chart-label">
                Daily revenue · last {CHART_DAYS} days
              </div>
              <div className="hs-chart-peak">peak · {fmtUsd(peak)}</div>
            </div>

            <Chart data={chartData} peak={peak} />
          </div>
        </>
      )}

      {subTab === "etf" && <EtfCard etf={etf} error={etfError} volume={etfVolume} />}
    </section>
  );
}

// --- ETF section -----------------------------------------------------------

function EtfCard({
  etf,
  error,
  volume,
}: {
  etf: EtfFlowDay[] | null;
  error: string | null;
  volume: { days: EtfVolumeDay[]; tickers: string[] } | null;
}) {
  const [hiddenTickers, setHiddenTickers] = useState<Set<string>>(new Set());

  const tickerTotals = useMemo(() => {
    if (!etf) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const d of etf) {
      for (const [t, v] of Object.entries(d.perTicker)) {
        m.set(t, (m.get(t) ?? 0) + Math.abs(v));
      }
    }
    return m;
  }, [etf]);

  const tickers = useMemo(
    () => [...tickerTotals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    [tickerTotals],
  );

  const toggleTicker = (t: string) => {
    setHiddenTickers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const visibleTickers = tickers.filter((t) => !hiddenTickers.has(t));

  if (error && !etf) {
    return (
      <div className="hs-card">
        <div className="hs-hero-label">HYPE Spot ETF</div>
        <div className="fr-status fr-error">ETF flow load failed: {error}</div>
      </div>
    );
  }
  if (!etf) {
    return (
      <div className="hs-card">
        <div className="hs-hero-label">HYPE Spot ETF</div>
        <div className="fr-status">Loading ETF flows…</div>
      </div>
    );
  }
  if (etf.length === 0) {
    return (
      <div className="hs-card">
        <div className="hs-hero-label">HYPE Spot ETF</div>
        <div className="fr-status">No ETF data yet.</div>
      </div>
    );
  }

  const cumulative = etf.reduce((s, d) => {
    let dayTotal = 0;
    for (const t of visibleTickers) dayTotal += d.perTicker[t] ?? 0;
    return s + dayTotal;
  }, 0);
  const days = etf.length;

  return (
    <div className="hs-card">
      <div className="hs-etf-hero">
        <div className="hs-hero-label">HYPE Spot ETF · Cumulative Net Flow</div>
        <div className="hs-etf-value">
          {cumulative >= 0 ? "+" : ""}
          {fmtUsd(cumulative)}
        </div>
        <div className="hs-hero-hint">
          {days}d listed · Net inflow since launch
        </div>
      </div>

      <div className="hs-chart-head">
        <div className="hs-chart-label">By Fund</div>
        <Legend tickers={tickers} hiddenTickers={hiddenTickers} onToggle={toggleTicker} />
      </div>
      <EtfStackedChart etf={etf} tickers={visibleTickers} allTickers={tickers} />

      {volume && volume.days.length > 0 && (
        <>
          <div className="hs-divider" />
          <EtfVolumeSection volume={volume} hiddenTickers={hiddenTickers} onToggle={toggleTicker} />
        </>
      )}
    </div>
  );
}

// 4 mint-leaning hues; cycle if more issuers ship later. Order kept stable
// across renders so a ticker keeps the same color.
const TICKER_COLORS = ["#5fe3c2", "#d4b25a", "#7dadff", "#e88a7d"];

function colorFor(idx: number): string {
  return TICKER_COLORS[idx % TICKER_COLORS.length];
}

function Legend({
  tickers,
  hiddenTickers,
  onToggle,
}: {
  tickers: string[];
  hiddenTickers: Set<string>;
  onToggle: (t: string) => void;
}) {
  return (
    <div className="hs-legend">
      {tickers.map((t, i) => {
        const hidden = hiddenTickers.has(t);
        return (
          <span
            key={t}
            className={`hs-legend-item clickable${hidden ? " dimmed" : ""}`}
            onClick={() => onToggle(t)}
          >
            <span
              className="hs-legend-swatch"
              style={{ background: hidden ? "transparent" : colorFor(i), borderColor: colorFor(i) }}
            />
            {t}
          </span>
        );
      })}
    </div>
  );
}


function EtfStackedChart({
  etf,
  tickers,
  allTickers,
}: {
  etf: EtfFlowDay[];
  tickers: string[];
  allTickers: string[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;

  // For the stacked view we use absolute USD flow per ticker; a negative day
  // gets stacked downward from zero with the same color order. Inflow-only
  // days dominate so the chart is mostly above zero.
  const sums = etf.map((d) => {
    let pos = 0;
    let neg = 0;
    for (const t of tickers) {
      const v = d.perTicker[t] ?? 0;
      if (v >= 0) pos += v;
      else neg += v;
    }
    return { pos, neg };
  });
  const absMax = Math.max(
    1,
    ...sums.map((s) => Math.max(s.pos, Math.abs(s.neg))),
  );
  const hasNeg = sums.some((s) => s.neg < 0);
  const zeroY = hasNeg
    ? CHART_PAD_T + CHART_PLOT_H / 2
    : CHART_PAD_T + CHART_PLOT_H;
  const halfH = hasNeg ? CHART_PLOT_H / 2 : CHART_PLOT_H;
  const barW = Math.max(2, plotW / Math.max(1, etf.length) - 2);

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
    const idx = Math.max(
      0,
      Math.min(etf.length - 1, Math.floor(((vbX - plotLeft) / plotW) * etf.length)),
    );
    setHoverIdx(idx);
  };

  const hover = hoverIdx != null ? etf[hoverIdx] : null;

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
        >
          {hasNeg && (
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={zeroY}
              y2={zeroY}
              className="us-chart-grid"
            />
          )}
          {etf.map((d, i) => {
            const x = plotLeft + (i / etf.length) * plotW;
            let yPos = zeroY;
            let yNeg = zeroY;
            return (
              <g key={d.date}>
                {tickers.map((t) => {
                  const v = d.perTicker[t] ?? 0;
                  if (v === 0) return null;
                  const ci = allTickers.indexOf(t);
                  const h = (Math.abs(v) / absMax) * halfH;
                  let y: number;
                  if (v >= 0) {
                    yPos -= h;
                    y = yPos;
                  } else {
                    y = yNeg;
                    yNeg += h;
                  }
                  return (
                    <rect
                      key={t}
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                      fill={colorFor(ci)}
                      opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
                    />
                  );
                })}
              </g>
            );
          })}
          {hoverIdx != null && (
            <line
              x1={plotLeft + (hoverIdx / etf.length) * plotW + barW / 2}
              x2={plotLeft + (hoverIdx / etf.length) * plotW + barW / 2}
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
              left: `${((plotLeft + (hoverIdx! / etf.length) * plotW + barW / 2) / CHART_W) * 100}%`,
            }}
          >
            <div className="fr-tooltip-date">{fmtShortDate(hover.date)}</div>
            {tickers.map((t) => {
              const v = hover.perTicker[t] ?? 0;
              if (v === 0) return null;
              return (
                <div key={t} className="fr-tooltip-row">
                  <span className="fr-tooltip-name">{t}</span>
                  <span className="fr-tooltip-val">
                    {v >= 0 ? "+" : ""}
                    {fmtUsd(v)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EtfVolumeSection({
  volume,
  hiddenTickers,
  onToggle,
}: {
  volume: { days: EtfVolumeDay[]; tickers: string[] };
  hiddenTickers: Set<string>;
  onToggle: (t: string) => void;
}) {
  const visibleTickers = volume.tickers.filter((t) => !hiddenTickers.has(t));

  const latestDay = volume.days[volume.days.length - 1];
  const todayVolume = latestDay
    ? visibleTickers.reduce((s, t) => s + (latestDay.perTicker[t] ?? 0), 0)
    : 0;

  return (
    <>
      <div className="hs-etf-hero">
        <div className="hs-hero-label">HYPE Spot ETF · Daily Volume</div>
        <div className="hs-etf-value">{fmtUsd(todayVolume)}</div>
        <div className="hs-hero-hint">
          {volume.days.length}d traded
        </div>
      </div>

      <div className="hs-chart-head">
        <div className="hs-chart-label">Daily $-Volume · Stacked Per Fund</div>
        <Legend tickers={volume.tickers} hiddenTickers={hiddenTickers} onToggle={onToggle} />
      </div>
      <EtfVolumeChart volume={volume} tickers={visibleTickers} allTickers={volume.tickers} />
    </>
  );
}

function EtfVolumeChart({
  volume,
  tickers,
  allTickers,
}: {
  volume: { days: EtfVolumeDay[]; tickers: string[] };
  tickers: string[];
  allTickers: string[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const days = volume.days;
  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;

  const sums = days.map((d) => {
    let total = 0;
    for (const t of tickers) total += d.perTicker[t] ?? 0;
    return total;
  });
  const maxSum = Math.max(1, ...sums);
  const barW = Math.max(2, plotW / Math.max(1, days.length) - 2);

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
    const idx = Math.max(
      0,
      Math.min(days.length - 1, Math.floor(((vbX - plotLeft) / plotW) * days.length)),
    );
    setHoverIdx(idx);
  };

  const hover = hoverIdx != null ? days[hoverIdx] : null;

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
        >
          {days.map((d, i) => {
            const x = plotLeft + (i / days.length) * plotW;
            let yPos = plotBottom;
            return (
              <g key={d.date}>
                {tickers.map((t) => {
                  const v = d.perTicker[t] ?? 0;
                  if (v <= 0) return null;
                  const ci = allTickers.indexOf(t);
                  const h = (v / maxSum) * CHART_PLOT_H;
                  yPos -= h;
                  return (
                    <rect
                      key={t}
                      x={x}
                      y={yPos}
                      width={barW}
                      height={h}
                      fill={colorFor(ci)}
                      opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55}
                    />
                  );
                })}
              </g>
            );
          })}
          {hoverIdx != null && (
            <line
              x1={plotLeft + (hoverIdx / days.length) * plotW + barW / 2}
              x2={plotLeft + (hoverIdx / days.length) * plotW + barW / 2}
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
              left: `${((plotLeft + (hoverIdx! / days.length) * plotW + barW / 2) / CHART_W) * 100}%`,
            }}
          >
            <div className="fr-tooltip-date">{fmtShortDate(hover.date)}</div>
            {tickers.map((t) => {
              const v = hover.perTicker[t] ?? 0;
              if (v <= 0) return null;
              return (
                <div key={t} className="fr-tooltip-row">
                  <span className="fr-tooltip-name">{t}</span>
                  <span className="fr-tooltip-val">{fmtUsd(v)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="hs-head">
      <span className="hs-head-label">HYPE Protocol Stats</span>
      <span className="hs-head-src">DefiLlama · ASXN</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hs-stat">
      <span className="hs-stat-label">{label}</span>
      <span className="hs-stat-val">{value}</span>
    </div>
  );
}

// --- Chart -----------------------------------------------------------------

const CHART_W = 340;
const CHART_PAD_L = 8;
const CHART_PAD_R = 6;
const CHART_PAD_T = 6;
const CHART_PLOT_H = 90;
const CHART_X_AXIS_H = 14;
const CHART_H = CHART_PAD_T + CHART_PLOT_H + CHART_X_AXIS_H;

function Chart({ data, peak }: { data: DailyPoint[]; peak: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;
  const max = Math.max(1, peak);
  const barW = Math.max(1.5, plotW / Math.max(1, data.length) - 1);

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
    const idx = Math.max(
      0,
      Math.min(data.length - 1, Math.floor(frac * data.length)),
    );
    setHoverIdx(idx);
  };
  const handleLeave = () => setHoverIdx(null);

  const hover = hoverIdx != null ? data[hoverIdx] : null;
  const first = data[0];
  const last = data[data.length - 1];

  return (
    <div className="hs-chart">
      <div
        className="fr-chart-wrap"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <svg
          ref={svgRef}
          className="hs-chart-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily revenue ${CHART_DAYS}-day history`}
        >
          {data.map((p, i) => {
            if (p.value <= 0) return null;
            const x = plotLeft + (i / data.length) * plotW;
            const h = (p.value / max) * CHART_PLOT_H;
            const y = plotBottom - h;
            return (
              <rect
                key={p.date}
                x={x}
                y={y}
                width={barW}
                height={h}
                className={`hs-chart-bar${hoverIdx === i ? " hover" : ""}`}
              />
            );
          })}
          {hoverIdx != null && hover && (
            <line
              x1={plotLeft + (hoverIdx / data.length) * plotW + barW / 2}
              x2={plotLeft + (hoverIdx / data.length) * plotW + barW / 2}
              y1={CHART_PAD_T}
              y2={plotBottom}
              className="fr-crosshair"
              pointerEvents="none"
            />
          )}
          {first && (
            <text
              x={plotLeft}
              y={plotBottom + CHART_X_AXIS_H - 2}
              className="hs-chart-axis"
              textAnchor="start"
            >
              {fmtShortDate(first.date)}
            </text>
          )}
          {last && (
            <text
              x={plotRight}
              y={plotBottom + CHART_X_AXIS_H - 2}
              className="hs-chart-axis"
              textAnchor="end"
            >
              {fmtShortDate(last.date)}
            </text>
          )}
        </svg>
        {hover && (
          <div
            className="fr-tooltip center"
            style={{
              left: `${((plotLeft + (hoverIdx! / data.length) * plotW + barW / 2) / CHART_W) * 100}%`,
            }}
          >
            <div className="fr-tooltip-date">{fmtShortDate(hover.date)}</div>
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-name">Revenue</span>
              <span className="fr-tooltip-val">{fmtUsd(hover.value)}</span>
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
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtHype(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toFixed(0);
}

function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
