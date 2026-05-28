import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchVenueFundings,
  fetchVenueFundingHistory,
  venueTradeUrl,
  HL_VENUE,
  type FundingPoint,
  type VenueFunding,
  type VenueResult,
} from "../lib/exchanges";

// How often to silently re-fetch funding values in the background.
const REFRESH_MS = 10_000;

// How far back the spread-history chart looks.
const HISTORY_HOURS = 72;

const SHORT: Record<string, string> = { [HL_VENUE]: "HL" };
function shortName(name: string): string {
  return SHORT[name] ?? name;
}

function fmtApr(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

// Compact USD price for the venue rows. Small (<1) stays at 4 dp, mid-size
// (<100) at 2 dp, big numbers round to integer with thousands separators —
// matches how traders eyeball quotes on most venue UIs.
function fmtPx(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1) return n.toFixed(4);
  if (n < 100) return n.toFixed(2);
  if (n < 10_000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// Basis as a signed percent vs HL. Two decimals because cross-venue perp basis
// is usually well under 1%, and we want the sign + magnitude legible at a glance.
function fmtBasisPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// Time until the next funding charge, ticking down.
function fmtCountdown(next: number | null, now: number): string {
  if (!next) return "—";
  const d = next - now;
  if (d <= 0) return "now";
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  const s = Math.floor((d % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s.toString().padStart(2, "0")}s`;
}

function isUsable(v: VenueResult): v is VenueFunding {
  return v.available && Number.isFinite(v.aprPct);
}

type Props = { coin: string; refreshKey: number };

export default function FundingComparePanel({ coin, refreshKey }: Props) {
  const [results, setResults] = useState<VenueResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null = auto (biggest dislocation vs HL); otherwise a venue the user picked.
  const [selected, setSelected] = useState<string | null>(null);
  // false = the profit-capturing direction (long the lower, short the higher).
  const [flipped, setFlipped] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // 72h APR history for the selected pair's two legs (HL + counterparty).
  const [history, setHistory] = useState<{
    venue: string;
    hl: FundingPoint[];
    cp: FundingPoint[] | null;
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // silent = a background auto-refresh: don't flash the loading state, keep
    // the user's picked venue / flip direction, and hold the last good values
    // if the fetch hiccups. Non-silent = initial load or coin/refresh change.
    const run = async (silent: boolean) => {
      if (!silent) {
        setLoading(true);
        setError(null);
        setSelected(null);
        setFlipped(false);
      }
      try {
        const r = await fetchVenueFundings(coin);
        if (cancelled) return;
        setResults(r);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        console.warn("venue funding fetch failed", e);
        if (!silent) {
          setError(e instanceof Error ? e.message : String(e));
          setResults(null);
        }
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };

    void run(false);
    // Auto-refresh the funding values every REFRESH_MS. Skip while the panel
    // isn't visible — refocusing the window already triggers a full reload.
    const id = setInterval(() => {
      if (!document.hidden) void run(true);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, refreshKey]);

  // Tick the countdowns once a second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const model = useMemo(() => {
    if (!results) return null;
    const hlRes = results.find((v) => v.venue === HL_VENUE);
    if (!hlRes || !isUsable(hlRes)) return null;
    const hl = hlRes;

    const counterparties = results
      .filter((v): v is VenueFunding => v.venue !== HL_VENUE && isUsable(v))
      .sort((a, b) => b.aprPct - a.aprPct);
    const offline = results.filter(
      (v) => v.venue !== HL_VENUE && !isUsable(v),
    );

    const best =
      counterparties.length > 0
        ? counterparties.reduce((a, b) =>
            Math.abs(b.aprPct - hl.aprPct) > Math.abs(a.aprPct - hl.aprPct)
              ? b
              : a,
          )
        : null;

    const maxAbs = Math.max(
      1,
      Math.abs(hl.aprPct),
      ...counterparties.map((v) => Math.abs(v.aprPct)),
    );
    const hlX = 50 + (hl.aprPct / maxAbs) * 50;

    return { hl, counterparties, offline, best, maxAbs, hlX };
  }, [results]);

  // The counterparty whose history the chart shows: the user's pick, else the
  // biggest-dislocation "best". (Flipping only swaps long/short labels, not
  // which two venues are charted, so it isn't a dependency here.)
  const chartVenue = useMemo(
    () => (model ? (selected ?? model.best?.venue ?? null) : null),
    [model, selected],
  );

  // Fetch 72h of funding history for HL + the charted counterparty. Each leg is
  // annualized at its own native cadence inside fetchVenueFundingHistory.
  useEffect(() => {
    if (!chartVenue) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    const since = Date.now() - HISTORY_HOURS * 3_600_000;
    Promise.all([
      fetchVenueFundingHistory(HL_VENUE, coin, since),
      fetchVenueFundingHistory(chartVenue, coin, since),
    ])
      .then(([hl, cp]) => {
        if (!cancelled) setHistory({ venue: chartVenue, hl: hl ?? [], cp });
      })
      .catch(() => {
        if (!cancelled) setHistory({ venue: chartVenue, hl: [], cp: null });
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coin, chartVenue, refreshKey]);

  if (loading && !results) {
    return (
      <section className="fc">
        <Header />
        <div className="fr-status">Loading…</div>
      </section>
    );
  }
  if (error && !results) {
    return (
      <section className="fc">
        <Header />
        <div className="fr-status fr-error">Failed to load</div>
      </section>
    );
  }
  if (!model) {
    return (
      <section className="fc">
        <Header />
        <div className="fr-status">No Hyperliquid funding for {coin}</div>
      </section>
    );
  }

  const { hl, counterparties, offline, best, maxAbs, hlX } = model;
  const active =
    counterparties.find((c) => c.venue === (selected ?? best?.venue)) ?? best;

  const pick = (name: string) => {
    setSelected(name);
    setFlipped(false);
  };

  // Arb legs vs HL (only when there's at least one counterparty).
  let arb: null | {
    longLeg: VenueFunding;
    shortLeg: VenueFunding;
    displayApr: number;
    isBest: boolean;
  } = null;
  if (active) {
    const spread = active.aprPct - hl.aprPct;
    const higher = spread >= 0 ? active : hl;
    const lower = spread >= 0 ? hl : active;
    arb = {
      longLeg: flipped ? higher : lower,
      shortLeg: flipped ? lower : higher,
      displayApr: flipped ? -Math.abs(spread) : Math.abs(spread),
      isBest: active.venue === best?.venue,
    };
  }

  return (
    <section className="fc">
      <Header />

      {arb && active && (
        <div className="fc-arb">
          <div className="fc-arb-top">
            {/* The selected pair (e.g. HL ↔ edgeX) headlines the island — using
                the chart's HL-blue / CP-orange palette so the user can see at
                a glance which two legs the lines below correspond to. */}
            <span className="fc-arb-pair">
              <span className="fc-arb-pair-leg hl">HL</span>
              <span className="fc-arb-pair-sep" aria-hidden="true">↔</span>
              <span className="fc-arb-pair-leg cp">{shortName(active.venue)}</span>
              {arb.isBest && <span className="fc-best">best</span>}
            </span>
            <div className="fc-arb-spread">
              <span
                className={`fc-arb-spread-val ${arb.displayApr >= 0 ? "up" : "down"}`}
              >
                {fmtApr(arb.displayApr)}
              </span>
              <span className="fc-arb-spread-unit">APR</span>
            </div>
          </div>
          <div className="fc-arb-legs">
            <span className="fc-leg long">
              <span className="fc-leg-side">Long {shortName(arb.longLeg.venue)}</span>
              <b>{fmtApr(arb.longLeg.aprPct)}</b>
              <span className="fc-leg-px">@ {fmtPx(arb.longLeg.markPx)}</span>
            </span>
            <button
              type="button"
              className="fc-flip"
              onClick={() => setFlipped((f) => !f)}
              title="Swap which venue you long / short"
              aria-label="Swap long and short legs"
            >
              ⇄
            </button>
            <span className="fc-leg short">
              <span className="fc-leg-side">Short {shortName(arb.shortLeg.venue)}</span>
              <b>{fmtApr(arb.shortLeg.aprPct)}</b>
              <span className="fc-leg-px">@ {fmtPx(arb.shortLeg.markPx)}</span>
            </span>
          </div>

          {/* Basis = the instant edge from price convergence, separate from the
              ongoing FR carry. Both numbers matter to a trader: a small FR
              spread can be drowned out by a wide basis, and a tight basis with
              a juicy FR spread is the prototypical perp-carry setup. */}
          <ArbMetrics arb={arb} hlMark={hl.markPx} cpMark={active.markPx} />


          {/* The 72h history visualizes the same HL↔counterparty spread the
              summary describes, so it belongs inside this island rather than
              floating as a separate block. */}
          <SpreadHistoryChart
            cpName={active.venue}
            history={history && history.venue === active.venue ? history : null}
            loading={historyLoading}
            now={now}
          />
        </div>
      )}

      <div className="fc-venues">
        <VenueRow venue={hl} coin={coin} maxAbs={maxAbs} now={now} isAnchor hlMark={hl.markPx} />
        <div className="fc-venues-divider" aria-hidden="true" />
        {counterparties.map((c) => (
          <VenueRow
            key={c.venue}
            venue={c}
            coin={coin}
            maxAbs={maxAbs}
            now={now}
            hlApr={hl.aprPct}
            hlX={hlX}
            hlMark={hl.markPx}
            active={!!active && c.venue === active.venue}
            onPick={() => pick(c.venue)}
          />
        ))}
        {offline.map((v) => (
          <div key={v.venue} className="fc-venue-row">
            <div className="fc-venue off">
              <span className="fc-venue-name">{v.venue}</span>
              <span className={`fc-venue-kind ${v.kind}`}>{v.kind}</span>
              <span className="fc-venue-na">
                {v.available ? "—" : v.reason}
              </span>
            </div>
            <span className="fc-venue-launch empty" aria-hidden="true" />
          </div>
        ))}
      </div>

      <div className="fc-foot">
        APR = funding · Basis = price gap vs HL · ⇄ flips long/short · ↗ opens
        the venue
      </div>
    </section>
  );
}

// Cross-venue arb has TWO independent edges: funding rate (carry over time) and
// price basis (instantly capturable if/when the two perps reconverge). We show
// them side by side so a trader can judge whether the trade is worth it now
// (basis-heavy) or worth holding (FR-heavy).
type ArbState = {
  longLeg: VenueFunding;
  shortLeg: VenueFunding;
  displayApr: number;
  isBest: boolean;
};

function ArbMetrics({
  arb,
  hlMark,
  cpMark,
}: {
  arb: ArbState;
  hlMark: number | null;
  cpMark: number | null;
}) {
  // Basis% in the current long/short orientation: positive ⇒ short leg sits
  // above long leg, so convergence captures basis as profit. Flipping legs
  // flips the sign — same convention as displayApr.
  const longPx = arb.longLeg.markPx;
  const shortPx = arb.shortLeg.markPx;
  const basisPct =
    longPx != null && shortPx != null && longPx > 0
      ? ((shortPx - longPx) / longPx) * 100
      : null;

  // Daily carry from FR alone, as a fraction of notional. A 10% APR spread
  // earns ~0.027% per day if held — useful frame for how the basis number
  // compares against just waiting for FR.
  const dailyCarryPct = arb.displayApr / 365;

  return (
    <div className="fc-arb-metrics">
      <div className="fc-arb-metric">
        <span className="fc-arb-metric-label">FR spread</span>
        <span
          className={`fc-arb-metric-val ${arb.displayApr >= 0 ? "up" : "down"}`}
        >
          {fmtApr(arb.displayApr)}
        </span>
        <span className="fc-arb-metric-sub">
          ≈ {fmtApr(dailyCarryPct).replace("%", "")}%/day
        </span>
      </div>
      <div className="fc-arb-metric">
        <span className="fc-arb-metric-label">Basis</span>
        <span
          className={`fc-arb-metric-val ${
            basisPct == null ? "dim" : basisPct >= 0 ? "up" : "down"
          }`}
        >
          {fmtBasisPct(basisPct)}
        </span>
        <span className="fc-arb-metric-sub">
          {hlMark != null && cpMark != null
            ? `${fmtPx(hlMark)} ↔ ${fmtPx(cpMark)}`
            : "px n/a"}
        </span>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="fc-head">
      <span className="fc-head-label">Cross-venue Arb · vs Hyperliquid</span>
    </div>
  );
}

// --- Spread history chart ----------------------------------------------------

const CHART_W = 320;
const CHART_PAD_L = 28;
// Right pad is wide enough to host the avg-APR pill sitting just outside the plot.
const CHART_PAD_R = 36;
const CHART_PAD_T = 8;
const CHART_PLOT_H = 76;
const CHART_X_AXIS_H = 12;
const CHART_H = CHART_PAD_T + CHART_PLOT_H + CHART_X_AXIS_H;
const AVG_PILL_W = 30;
const AVG_PILL_H = 11;

function chartNiceTicks(min: number, max: number, target = 3): number[] {
  if (!(max > min)) return [min];
  const step0 = (max - min) / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const n = step0 / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-4; v += step) {
    out.push(parseFloat(v.toFixed(6)));
  }
  return out;
}

// Value of a step series at time t (held until the next sample).
function stepValAt(pts: FundingPoint[], t: number): number | null {
  if (pts.length === 0) return null;
  let v = pts[0].apr;
  for (const p of pts) {
    if (p.t <= t) v = p.apr;
    else break;
  }
  return v;
}

// Time-weighted mean APR over [from, to] for a step-after series. Matches what
// the chart draws (each sample's APR is held until the next), so traders can
// read "how stable is this spread?" off the dashed average line.
function timeWeightedMean(
  pts: FundingPoint[],
  from: number,
  to: number,
): number | null {
  if (pts.length === 0 || to <= from) return null;
  const breaks = Array.from(
    new Set([from, to, ...pts.map((p) => p.t).filter((t) => t > from && t < to)]),
  ).sort((a, b) => a - b);
  let sum = 0;
  let total = 0;
  for (let i = 0; i < breaks.length - 1; i++) {
    const v = stepValAt(pts, breaks[i]);
    if (v == null) continue;
    const dt = breaks[i + 1] - breaks[i];
    sum += v * dt;
    total += dt;
  }
  return total > 0 ? sum / total : null;
}

type ChartProps = {
  cpName: string;
  history: { venue: string; hl: FundingPoint[]; cp: FundingPoint[] | null } | null;
  loading: boolean;
  now: number;
};

function SpreadHistoryChart({ cpName, history, loading, now }: ChartProps) {
  // Mirror of the FR chart's legend toggles. `hl` / `cp` hide a leg's line and
  // its companion avg-line + right-edge pill (the avg of an invisible line is
  // confusing). `avg` hides both dashed mean lines + pills. `spread` hides the
  // shaded band between the two legs. Each is independent.
  const [visibleSeries, setVisibleSeries] = useState({
    hl: true,
    cp: true,
    avg: true,
    spread: true,
  });
  const toggleSeries = (k: keyof typeof visibleSeries) =>
    setVisibleSeries((s) => ({ ...s, [k]: !s[k] }));

  // Cursor → snapped time on the chart. Continuous (ms) rather than a series
  // index because the two legs sample at different cadences (HL hourly, CEX 8h).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const windowStart = now - HISTORY_HOURS * 3_600_000;
  const hl = (history?.hl ?? []).filter((p) => p.t >= windowStart);
  const cp = (history?.cp ?? []).filter((p) => p.t >= windowStart);
  const cpMissing = history != null && history.cp === null;
  const hasData = hl.length > 0 || cp.length > 0;

  if (loading && !history) {
    return <div className="fc-chart-status">Loading history…</div>;
  }
  if (!hasData) {
    return <div className="fc-chart-status">No funding history</div>;
  }

  const hlMean = timeWeightedMean(hl, windowStart, now);
  const cpMean = timeWeightedMean(cp, windowStart, now);

  // Y range over both legs, always including 0 so the sign reads clearly. Mean
  // lines are included too so they never clip off the top/bottom of the plot.
  const aprs = [...hl, ...cp].map((p) => p.apr);
  const extras = [hlMean, cpMean].filter((v): v is number => v != null);
  const lo = Math.min(0, ...aprs, ...extras);
  const hi = Math.max(0, ...aprs, ...extras);
  const pad = (hi - lo) * 0.12 || 1;
  const ticks = chartNiceTicks(lo - pad, hi + pad, 3);
  const yMin = Math.min(lo - pad, ticks[0]);
  const yMax = Math.max(hi + pad, ticks[ticks.length - 1]);
  const ySpan = Math.max(1e-6, yMax - yMin);

  const plotLeft = CHART_PAD_L;
  const plotRight = CHART_W - CHART_PAD_R;
  const plotW = plotRight - plotLeft;
  const plotBottom = CHART_PAD_T + CHART_PLOT_H;

  const xFor = (t: number) =>
    plotLeft + ((t - windowStart) / (now - windowStart)) * plotW;
  const yFor = (apr: number) =>
    CHART_PAD_T + (1 - (apr - yMin) / ySpan) * CHART_PLOT_H;
  const nowX = xFor(now);

  // Step-after path, extended flat to "now".
  const stepPath = (pts: FundingPoint[]): string => {
    if (pts.length === 0) return "";
    let d = `M${xFor(pts[0].t).toFixed(1)},${yFor(pts[0].apr).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const x = xFor(pts[i].t).toFixed(1);
      d += `L${x},${yFor(pts[i - 1].apr).toFixed(1)}`;
      d += `L${x},${yFor(pts[i].apr).toFixed(1)}`;
    }
    d += `L${nowX.toFixed(1)},${yFor(pts[pts.length - 1].apr).toFixed(1)}`;
    return d;
  };

  // Shaded band between the two legs = the spread (the trade condition's APR).
  let bandPath = "";
  if (hl.length > 0 && cp.length > 0) {
    const breaks = Array.from(
      new Set([windowStart, now, ...hl.map((p) => p.t), ...cp.map((p) => p.t)]),
    )
      .filter((t) => t >= windowStart && t <= now)
      .sort((a, b) => a - b);
    const topPts: [number, number][] = [];
    const botPts: [number, number][] = [];
    for (let i = 0; i < breaks.length - 1; i++) {
      const a = breaks[i];
      const b = breaks[i + 1];
      const c = stepValAt(cp, a);
      const h = stepValAt(hl, a);
      if (c == null || h == null) continue;
      topPts.push([xFor(a), yFor(c)], [xFor(b), yFor(c)]);
      botPts.push([xFor(a), yFor(h)], [xFor(b), yFor(h)]);
    }
    if (topPts.length > 0) {
      const pts = [...topPts, ...botPts.reverse()];
      bandPath =
        pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
          .join("") + "Z";
    }
  }

  const zeroY = yMin < 0 && yMax > 0 ? yFor(0) : null;
  const hourTicks = [72, 48, 24, 0];

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    if (vbX < plotLeft - 1 || vbX > plotRight + 1) {
      setHoverT(null);
      return;
    }
    const t = windowStart + ((vbX - plotLeft) / plotW) * (now - windowStart);
    setHoverT(Math.max(windowStart, Math.min(now, t)));
  };
  const handleLeave = () => setHoverT(null);

  // Snap-free hover read: both legs are step-after, so the value at the
  // hovered time is just the most recent sample ≤ t for each side.
  const hover =
    hoverT !== null
      ? (() => {
          const hx = xFor(hoverT);
          const hlVal = visibleSeries.hl ? stepValAt(hl, hoverT) : null;
          const cpVal = visibleSeries.cp ? stepValAt(cp, hoverT) : null;
          const frac = (hx - plotLeft) / plotW;
          const anchor = frac < 0.3 ? "left" : frac > 0.7 ? "right" : "center";
          const leftPct = (hx / CHART_W) * 100;
          return { t: hoverT, hx, hl: hlVal, cp: cpVal, leftPct, anchor };
        })()
      : null;

  return (
    <div className="fc-chart">
      <div
        className="fc-chart-legend"
        role="group"
        aria-label="Toggle chart series"
      >
        {(
          [
            { key: "hl", label: shortName(HL_VENUE), swatch: "hl" },
            {
              key: "cp",
              label: shortName(cpName) + (cpMissing ? " (no history)" : ""),
              swatch: "cp",
            },
            { key: "avg", label: "Avg", swatch: "avg" },
            { key: "spread", label: "Spread", swatch: "spread" },
          ] as const
        ).map((item) => {
          const on = visibleSeries[item.key];
          return (
            <button
              key={item.key}
              type="button"
              className={`fc-chart-key ${item.swatch}${on ? "" : " off"}`}
              onClick={() => toggleSeries(item.key)}
              aria-pressed={on}
            >
              <span className="fc-chart-swatch" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
        <span className="fc-chart-span">{HISTORY_HOURS}h · APR</span>
      </div>
      <div
        className="fr-chart-wrap"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
      <svg
        ref={svgRef}
        className="fc-chart-svg"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`HL vs ${cpName} funding APR, last ${HISTORY_HOURS}h`}
      >
        {ticks.map((tk, i) => {
          const y = yFor(tk);
          if (y < CHART_PAD_T - 0.5 || y > plotBottom + 0.5) return null;
          return (
            <g key={`y${i}`}>
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={y}
                y2={y}
                className="fc-chart-grid"
              />
              <text
                x={plotLeft - 3}
                y={y}
                className="fc-chart-axis"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {Math.abs(tk) >= 10 ? tk.toFixed(0) : tk.toFixed(1)}
              </text>
            </g>
          );
        })}

        {zeroY !== null && (
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={zeroY}
            y2={zeroY}
            className="fc-chart-zero"
          />
        )}

        {visibleSeries.spread && bandPath && (
          <path d={bandPath} className="fc-chart-band" />
        )}
        {visibleSeries.avg && visibleSeries.hl && hlMean !== null && (
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={yFor(hlMean)}
            y2={yFor(hlMean)}
            className="fc-chart-avg hl"
          />
        )}
        {visibleSeries.avg && visibleSeries.cp && cpMean !== null && (
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={yFor(cpMean)}
            y2={yFor(cpMean)}
            className="fc-chart-avg cp"
          />
        )}
        {visibleSeries.hl && hl.length > 0 && (
          <path d={stepPath(hl)} className="fc-chart-line hl" />
        )}
        {visibleSeries.cp && cp.length > 0 && (
          <path d={stepPath(cp)} className="fc-chart-line cp" />
        )}

        {(() => {
          // Right-edge pills that anchor each dashed avg line to a readable value.
          // When the two means are very close, nudge them apart so the labels
          // don't sit on top of each other.
          const pills: { kind: "hl" | "cp"; y: number; val: number }[] = [];
          // Pills track their parent line — hidden if that leg is off or if
          // averages are toggled off as a group.
          if (visibleSeries.avg && visibleSeries.hl && hlMean !== null)
            pills.push({ kind: "hl", y: yFor(hlMean), val: hlMean });
          if (visibleSeries.avg && visibleSeries.cp && cpMean !== null)
            pills.push({ kind: "cp", y: yFor(cpMean), val: cpMean });
          if (pills.length === 2 && Math.abs(pills[0].y - pills[1].y) < AVG_PILL_H + 1) {
            const mid = (pills[0].y + pills[1].y) / 2;
            const gap = (AVG_PILL_H + 1) / 2;
            if (pills[0].y <= pills[1].y) {
              pills[0].y = mid - gap;
              pills[1].y = mid + gap;
            } else {
              pills[0].y = mid + gap;
              pills[1].y = mid - gap;
            }
          }
          const pillX = plotRight + 2;
          const minY = CHART_PAD_T + AVG_PILL_H / 2;
          const maxY = plotBottom - AVG_PILL_H / 2;
          return pills.map((p) => {
            const cy = Math.max(minY, Math.min(maxY, p.y));
            return (
              <g key={p.kind} className={`fc-chart-avg-pill ${p.kind}`}>
                <rect
                  x={pillX}
                  y={cy - AVG_PILL_H / 2}
                  width={AVG_PILL_W}
                  height={AVG_PILL_H}
                  rx={3}
                />
                <text
                  x={pillX + AVG_PILL_W / 2}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {fmtApr(p.val)}
                </text>
              </g>
            );
          });
        })()}

        {hourTicks.map((h) => {
          const x = xFor(now - h * 3_600_000);
          return (
            <text
              key={`x${h}`}
              x={x}
              y={plotBottom + CHART_X_AXIS_H - 2}
              className="fc-chart-axis fc-chart-xaxis"
              textAnchor={h === 72 ? "start" : h === 0 ? "end" : "middle"}
            >
              {h === 0 ? "now" : `-${h}h`}
            </text>
          );
        })}

        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.hx}
              x2={hover.hx}
              y1={CHART_PAD_T}
              y2={plotBottom}
              className="fr-crosshair"
            />
            {hover.hl !== null && (
              <circle
                cx={hover.hx}
                cy={yFor(hover.hl)}
                r={2.2}
                className="fc-dot hl"
              />
            )}
            {hover.cp !== null && (
              <circle
                cx={hover.hx}
                cy={yFor(hover.cp)}
                r={2.2}
                className="fc-dot cp"
              />
            )}
          </g>
        )}
      </svg>

      {hover && (hover.hl !== null || hover.cp !== null) && (
        <div
          className={`fr-tooltip ${hover.anchor}`}
          style={{ left: `${hover.leftPct}%` }}
        >
          <div className="fr-tooltip-date">{fmtHoverDate(hover.t)}</div>
          {visibleSeries.hl && hover.hl !== null && (
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-key fc-hl" aria-hidden="true" />
              <span className="fr-tooltip-name">{shortName(HL_VENUE)}</span>
              <span
                className={`fr-tooltip-val ${hover.hl >= 0 ? "up" : "down"}`}
              >
                {fmtApr(hover.hl)}
              </span>
            </div>
          )}
          {visibleSeries.cp && hover.cp !== null && (
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-key fc-cp" aria-hidden="true" />
              <span className="fr-tooltip-name">{shortName(cpName)}</span>
              <span
                className={`fr-tooltip-val ${hover.cp >= 0 ? "up" : "down"}`}
              >
                {fmtApr(hover.cp)}
              </span>
            </div>
          )}
          {hover.hl !== null && hover.cp !== null && (
            <div className="fr-tooltip-row">
              <span className="fr-tooltip-key fc-spread" aria-hidden="true" />
              <span className="fr-tooltip-name">Δ</span>
              <span
                className={`fr-tooltip-val ${hover.cp - hover.hl >= 0 ? "up" : "down"}`}
              >
                {fmtApr(hover.cp - hover.hl)}
              </span>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// Hover readout date — month/day + HH:MM at the cursor's snapped time.
function fmtHoverDate(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// Diverging bar fill from the 0 center toward the venue's APR.
function VenueFill({ apr, maxAbs }: { apr: number; maxAbs: number }) {
  const half = (Math.abs(apr) / maxAbs) * 50;
  const left = apr >= 0 ? 50 : 50 - half;
  return (
    <span
      className={`fc-venue-fill ${apr >= 0 ? "up" : "down"}`}
      style={{ left: `${left}%`, width: `${half}%` }}
    />
  );
}

type RowProps = {
  venue: VenueFunding;
  coin: string;
  maxAbs: number;
  now: number;
  isAnchor?: boolean;
  hlApr?: number;
  hlX?: number;
  hlMark?: number | null;
  active?: boolean;
  onPick?: () => void;
};

function VenueRow({
  venue,
  coin,
  maxAbs,
  now,
  isAnchor,
  hlApr,
  hlX,
  hlMark,
  active,
  onPick,
}: RowProps) {
  // Per-venue basis vs HL as a signed %. Null when either leg is missing a
  // price. Anchor row shows "anchor" instead of a delta.
  const basisPct =
    !isAnchor && venue.markPx != null && hlMark != null && hlMark > 0
      ? ((venue.markPx - hlMark) / hlMark) * 100
      : null;

  const href = venueTradeUrl(venue.venue, coin);
  const launch = href ? (
    <a
      className="fc-venue-launch"
      href={href}
      target="_blank"
      rel="noreferrer"
      // Don't let the launch click bubble up to the row's pick handler.
      onClick={(e) => e.stopPropagation()}
      title={`Open ${coin} on ${venue.venue}`}
      aria-label={`Open ${coin} on ${venue.venue}`}
    >
      ↗
    </a>
  ) : (
    <span className="fc-venue-launch empty" aria-hidden="true" />
  );

  const inner = (
    <>
      <span className="fc-venue-name">{venue.venue}</span>
      <span className={`fc-venue-kind ${venue.kind}`}>{venue.kind}</span>
      <div className="fc-venue-track">
        <span className="fc-venue-center" aria-hidden="true" />
        {!isAnchor && hlX !== undefined && (
          <span
            className="fc-venue-hltick"
            style={{ left: `${hlX}%` }}
            aria-hidden="true"
          />
        )}
        <VenueFill apr={venue.aprPct} maxAbs={maxAbs} />
      </div>
      <div className="fc-venue-right">
        <span className={`fc-venue-apr ${venue.aprPct >= 0 ? "up" : "down"}`}>
          {fmtApr(venue.aprPct)}
        </span>
        {isAnchor ? (
          <span className="fc-venue-delta anchor">anchor</span>
        ) : (
          <span
            className={`fc-venue-delta ${venue.aprPct - (hlApr ?? 0) >= 0 ? "up" : "down"}`}
          >
            Δ {fmtApr(venue.aprPct - (hlApr ?? 0))}
          </span>
        )}
      </div>
      <div className="fc-venue-px">
        <span className="fc-venue-mark" title="Mark / index price">
          {fmtPx(venue.markPx)}
        </span>
        {isAnchor ? (
          <span className="fc-venue-basis anchor">anchor</span>
        ) : basisPct == null ? (
          <span className="fc-venue-basis dim">—</span>
        ) : (
          <span
            className={`fc-venue-basis ${basisPct >= 0 ? "up" : "down"}`}
            title="Price basis vs HL"
          >
            {fmtBasisPct(basisPct)}
          </span>
        )}
      </div>
      <div className="fc-venue-time">
        <span className="fc-cd">{fmtCountdown(venue.nextFundingMs, now)}</span>
        <span className="fc-iv">{venue.intervalHours}h</span>
      </div>
    </>
  );

  if (isAnchor) {
    return (
      <div className="fc-venue-row">
        <div className="fc-venue hl">{inner}</div>
        {launch}
      </div>
    );
  }
  return (
    <div className="fc-venue-row">
      <button
        type="button"
        className={`fc-venue${active ? " active" : ""}`}
        onClick={onPick}
        aria-pressed={active}
      >
        {inner}
      </button>
      {launch}
    </div>
  );
}
