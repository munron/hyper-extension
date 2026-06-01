import { useEffect, useMemo, useState } from "react";
import {
  coinToYahooSymbol,
  fetchYahooChart,
  fetchYahooSummary,
  type EpsQuarter,
  type FinancialsBar,
  type FinancialsChart,
  type YahooChart,
  type YahooFundamentals,
} from "../lib/yahooFinance";
import {
  MARKET_HOURS,
  openYahooStreamer,
  type PricingTick,
} from "../lib/yahooStreamer";

type Props = { coin: string; companyName?: string | null; refreshKey: number };

type Loaded = {
  symbol: string;
  chart: YahooChart | null;
  fundamentals: YahooFundamentals | null;
  epsTrend: EpsQuarter[];
  financials: FinancialsChart | null;
};

export default function StocksPanel({ coin, companyName, refreshKey }: Props) {
  const symbol = coinToYahooSymbol(coin);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Live extended-session tick from Yahoo's streamer (any marketHours value
  // other than REGULAR). The streamer is the single best source for these:
  //   - REST quoteSummary.preMarketPrice is empty during the Blue Ocean
  //     overnight window (Yahoo only fills it close to the 4 AM ET open).
  //   - The streamer flips its marketHours flag dynamically (0=Pre, 2=Post,
  //     3=Extended, 4=Overnight) so a single subscription covers all of them.
  // When this is set it takes precedence over the static REST extended card.
  const [liveTick, setLiveTick] = useState<PricingTick | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    (async () => {
      try {
        const [chart, summary] = await Promise.all([
          fetchYahooChart(symbol, "1y", "1d").catch(() => null),
          fetchYahooSummary(symbol).catch(() => null),
        ]);
        if (cancelled) return;
        if (!chart && !summary) {
          setError(`No data on Yahoo Finance for ${symbol}`);
        } else {
          setData({
            symbol,
            chart,
            fundamentals: summary?.fundamentals ?? null,
            epsTrend: summary?.epsTrend ?? [],
            financials: summary?.financials ?? null,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, refreshKey]);

  // Live tick subscription — capture every extended-session print (Pre,
  // Post, Extended, Overnight). Regular-session ticks are ignored since the
  // static REST snapshot already shows the regular-session price in the
  // hero. The marketHours value on each tick drives the displayed label.
  useEffect(() => {
    setLiveTick(null);
    const handle = openYahooStreamer(symbol, (tick) => {
      if (tick.marketHours !== MARKET_HOURS.REGULAR) {
        setLiveTick(tick);
      }
    });
    return () => handle.close();
  }, [symbol]);

  if (loading) {
    return (
      <section className="stocks">
        <Header symbol={symbol} companyName={companyName ?? null} />
        <div className="stocks-status">Loading…</div>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="stocks">
        <Header symbol={symbol} companyName={companyName ?? null} />
        <div className="stocks-status stocks-error">{error ?? "No data"}</div>
      </section>
    );
  }

  const m = data.chart?.meta ?? null;
  const f = data.fundamentals;
  const price = m?.regularMarketPrice ?? null;
  // chartPreviousClose is the close just *before the chart's range* (a year
  // ago for range=1y), not yesterday. Pull the real previous trading day's
  // close from summaryDetail / price; only fall back to chart meta when the
  // summary failed entirely.
  const prev = f?.previousClose ?? m?.chartPreviousClose ?? null;
  const changePct =
    f?.regularMarketChangePercent ??
    (price != null && prev != null && prev !== 0
      ? ((price - prev) / prev) * 100
      : null);
  const change =
    f?.regularMarketChange ??
    (price != null && prev != null ? price - prev : null);
  const currency = m?.currency ?? "USD";
  const displayName = m?.longName ?? m?.shortName ?? companyName ?? null;
  const exchange = m?.fullExchangeName ?? null;

  // Pick exactly one extended-hours readout to show. Post-market wins when
  // both happen to be populated (Yahoo sometimes carries the previous post
  // session's number into the next pre window).
  const extended = pickExtendedSession(f);

  return (
    <section className="stocks">
      <Header symbol={data.symbol} companyName={displayName} exchange={exchange} />

      <div className="stocks-hero">
        <div className="stocks-price">
          <span className="stocks-price-val">
            {price != null ? fmtPrice(price, currency) : "—"}
          </span>
          {changePct != null && change != null && (
            <span className={`stocks-price-chg ${changePct >= 0 ? "up" : "down"}`}>
              {changePct >= 0 ? "▲" : "▼"} {fmtSignedPct(changePct)}{" "}
              <span className="stocks-price-chg-raw">
                ({fmtSignedNum(change, 2)})
              </span>
            </span>
          )}
        </div>

        {/* Extended-session readout. Prefer the live streamer tick (covers
            Overnight which REST hides, and updates in real time); fall back
            to the REST snapshot during the brief moment before the first
            websocket tick arrives. */}
        {(() => {
          if (liveTick) {
            const pct = liveTick.changePercent;
            const chg = liveTick.change;
            const label = liveSessionLabel(liveTick.marketHours);
            return (
              <div
                className={`stocks-ext stocks-ext-overnight ${(pct ?? 0) >= 0 ? "up" : "down"}`}
              >
                <span className="stocks-ext-tag stocks-ext-tag-overnight">
                  <span className="stocks-ext-icon" aria-hidden="true">
                    {liveTick.marketHours === MARKET_HOURS.OVERNIGHT ? "🌙" : "⏱"}
                  </span>
                  {label}
                  <span
                    className="stocks-ext-live"
                    title="live tick"
                    aria-hidden="true"
                  />
                </span>
                <span className="stocks-ext-price">
                  {fmtPrice(liveTick.price, currency)}
                </span>
                {pct != null && chg != null && (
                  <span className="stocks-ext-chg">
                    {(pct >= 0 ? "▲" : "▼") + " "}
                    {fmtSignedPct(pct)}{" "}
                    <span className="stocks-ext-chg-raw">
                      ({fmtSignedNum(chg, 2)})
                    </span>
                  </span>
                )}
                {liveTick.time != null && (
                  <span className="stocks-ext-time">
                    {fmtClockNoSec(liveTick.time)}
                  </span>
                )}
              </div>
            );
          }
          if (extended) {
            return (
              <div
                className={`stocks-ext ${(extended.changePct ?? 0) >= 0 ? "up" : "down"}`}
              >
                <span className="stocks-ext-tag">{extended.label}</span>
                <span className="stocks-ext-price">
                  {fmtPrice(extended.price, currency)}
                </span>
                {extended.changePct != null && extended.change != null && (
                  <span className="stocks-ext-chg">
                    {(extended.changePct >= 0 ? "▲" : "▼") + " "}
                    {fmtSignedPct(extended.changePct)}{" "}
                    <span className="stocks-ext-chg-raw">
                      ({fmtSignedNum(extended.change, 2)})
                    </span>
                  </span>
                )}
                {extended.time != null && (
                  <span className="stocks-ext-time">
                    {fmtClockNoSec(extended.time)}
                  </span>
                )}
              </div>
            );
          }
          return null;
        })()}

      </div>

      <div className="stocks-tiles">
        <Tile label="Market cap" value={f?.marketCap != null ? fmtCompact(f.marketCap, currency) : "—"} />
        <Tile
          label="P/E (TTM)"
          value={f?.trailingPE != null ? f.trailingPE.toFixed(1) : "—"}
          sub={f?.forwardPE != null ? `fwd ${f.forwardPE.toFixed(1)}` : null}
        />
        <Tile
          label="EPS (TTM)"
          value={f?.trailingEps != null ? fmtPrice(f.trailingEps, currency) : "—"}
          sub={f?.forwardEps != null ? `fwd ${fmtPrice(f.forwardEps, currency)}` : null}
        />
        <Tile
          label="Div yield"
          value={f?.dividendYield != null ? fmtPct(f.dividendYield * 100, 2) : "—"}
        />
        <Tile
          label="Day range"
          value={
            m?.regularMarketDayLow != null && m?.regularMarketDayHigh != null
              ? `${fmtPrice(m.regularMarketDayLow, currency)} – ${fmtPrice(m.regularMarketDayHigh, currency)}`
              : "—"
          }
        />
        <Tile
          label="Volume"
          value={m?.regularMarketVolume != null ? fmtCompact(m.regularMarketVolume, "") : "—"}
        />
      </div>

      {f?.nextEarningsDate != null && (
        <div className="stocks-earnings-next">
          <span className="stocks-earnings-next-label">Next earnings</span>
          <span className="stocks-earnings-next-date">
            {fmtDate(f.nextEarningsDate)}
          </span>
          <span className="stocks-earnings-next-rel">
            {fmtRelativeDays(f.nextEarningsDate)}
          </span>
        </div>
      )}

      {data.epsTrend.length > 0 && (
        <EpsTrendChart rows={data.epsTrend} currency={currency} />
      )}

      {data.financials &&
        (data.financials.annual.length > 0 ||
          data.financials.quarterly.length > 0) && (
          <RevenueEarningsChart financials={data.financials} />
        )}

      <div className="stocks-foot">
        Data: Yahoo Finance · click ↗ to open the full page.{" "}
        <a
          className="stocks-link"
          href={`https://finance.yahoo.com/quote/${encodeURIComponent(data.symbol)}`}
          target="_blank"
          rel="noreferrer"
        >
          ↗
        </a>
      </div>
    </section>
  );
}

function Header({
  symbol,
  companyName,
  exchange,
}: {
  symbol: string;
  companyName: string | null;
  exchange?: string | null;
}) {
  return (
    <div className="stocks-head">
      <span className="stocks-head-label">Stocks · {symbol}</span>
      {(companyName || exchange) && (
        <span className="stocks-head-sub">
          {companyName ?? ""}
          {companyName && exchange ? " · " : ""}
          {exchange ?? ""}
        </span>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className="stocks-tile">
      <span className="stocks-tile-label">{label}</span>
      <span className="stocks-tile-val">{value}</span>
      {sub && <span className="stocks-tile-sub">{sub}</span>}
    </div>
  );
}

type ExtendedSession = {
  label: "Pre-market" | "After-hours";
  price: number;
  change: number | null;
  changePct: number | null;
  time: number | null;
};

// Display label per Yahoo marketHours value (REGULAR=1 is omitted; we only
// label non-regular sessions).
function liveSessionLabel(mh: number | undefined): string {
  switch (mh) {
    case MARKET_HOURS.PRE_MARKET:
      return "Pre-market";
    case MARKET_HOURS.POST_MARKET:
      return "After-hours";
    case MARKET_HOURS.OVERNIGHT:
      return "Overnight";
    case MARKET_HOURS.EXTENDED_HOURS:
      return "Extended-hours";
    default:
      return "Off-hours";
  }
}

// Decide which extended-hours session is "current" and worth surfacing. We
// prefer the one whose timestamp is newer (within the last ~16h to avoid
// showing stale yesterday-after-hours data once today's regular session
// already moved).
function pickExtendedSession(
  f: YahooFundamentals | null,
): ExtendedSession | null {
  if (!f) return null;
  const FRESH_MS = 16 * 3_600_000;
  const now = Date.now();
  const post =
    f.postMarketPrice != null &&
    f.postMarketTime != null &&
    now - f.postMarketTime <= FRESH_MS
      ? {
          label: "After-hours" as const,
          price: f.postMarketPrice,
          change: f.postMarketChange,
          changePct: f.postMarketChangePercent,
          time: f.postMarketTime,
        }
      : null;
  const pre =
    f.preMarketPrice != null &&
    f.preMarketTime != null &&
    now - f.preMarketTime <= FRESH_MS
      ? {
          label: "Pre-market" as const,
          price: f.preMarketPrice,
          change: f.preMarketChange,
          changePct: f.preMarketChangePercent,
          time: f.preMarketTime,
        }
      : null;
  if (post && pre) return (post.time ?? 0) >= (pre.time ?? 0) ? post : pre;
  return post ?? pre;
}

// EPS dot chart inspired by Yahoo's "Earnings Trends" panel: hollow ring =
// analyst estimate, filled dot = actual reported. Past quarters get a
// Beat/Miss caption with the absolute $ delta; the rightmost slot is the
// upcoming quarter's consensus estimate (no actual yet) with its expected
// report date. A vertical dashed line separates reported from upcoming.
function EpsTrendChart({
  rows,
  currency,
}: {
  rows: EpsQuarter[];
  currency: string;
}) {
  const recent = rows.slice(-5);
  // The headline reads the most recent reported quarter so the legend
  // numbers always reflect a fact, not a forecast.
  const lastPast = [...recent].reverse().find((r) => r.actual != null) ?? null;

  const vals: number[] = [];
  for (const r of recent) {
    if (r.estimate != null) vals.push(r.estimate);
    if (r.actual != null) vals.push(r.actual);
  }
  if (vals.length === 0) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.18 || Math.max(0.5, Math.abs(hi) * 0.1);
  const ticks = niceTicks(lo - pad, hi + pad, 5);
  const yMin = Math.min(lo - pad, ticks[0] ?? lo);
  const yMax = Math.max(hi + pad, ticks[ticks.length - 1] ?? hi);

  const W = 280;
  const H = 140;
  const PAD_L = 32;
  const PAD_R = 6;
  const PAD_T = 8;
  const PAD_B = 32; // x-axis label + Beat/Miss caption
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slotW = plotW / Math.max(1, recent.length);
  const xFor = (i: number) => PAD_L + slotW * (i + 0.5);
  const yFor = (v: number) =>
    PAD_T + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;

  // Divider between reported and upcoming quarters.
  const futureIdx = recent.findIndex((r) => r.actual == null);

  return (
    <div className="stocks-trends">
      <div className="stocks-trends-head">
        <span className="stocks-trends-section">Earnings per share</span>
      </div>
      {lastPast && (
        <div className="stocks-trends-legend">
          <span className="stocks-trends-q">{lastPast.label}</span>
          <span className="stocks-trends-key">
            <span className="stocks-trends-dot estimate" aria-hidden="true" />
            Est <b>{fmtPrice(lastPast.estimate, currency)}</b>
          </span>
          <span className="stocks-trends-key">
            <span
              className={`stocks-trends-dot actual ${(lastPast.actual ?? 0) >= (lastPast.estimate ?? 0) ? "beat" : "miss"}`}
              aria-hidden="true"
            />
            Act{" "}
            <b
              className={
                (lastPast.actual ?? 0) >= (lastPast.estimate ?? 0)
                  ? "beat"
                  : "miss"
              }
            >
              {fmtPrice(lastPast.actual, currency)}
            </b>
          </span>
        </div>
      )}
      <svg
        className="stocks-trends-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Quarterly EPS estimate vs actual"
      >
        {ticks.map((tk, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(tk)}
              y2={yFor(tk)}
              className="stocks-trends-grid"
            />
            <text
              x={PAD_L - 4}
              y={yFor(tk)}
              className="stocks-trends-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {fmtAxisNum(tk)}
            </text>
          </g>
        ))}

        {futureIdx > 0 && futureIdx < recent.length && (
          <line
            x1={xFor(futureIdx) - slotW / 2}
            x2={xFor(futureIdx) - slotW / 2}
            y1={PAD_T}
            y2={PAD_T + plotH}
            className="stocks-trends-divider"
          />
        )}

        {recent.map((r, i) => {
          const cx = xFor(i);
          const isFuture = r.actual == null;
          const beat =
            r.actual != null && r.estimate != null && r.actual >= r.estimate;
          return (
            <g key={i}>
              {r.estimate != null && (
                <circle
                  cx={cx}
                  cy={yFor(r.estimate)}
                  r={4}
                  className="stocks-trends-dot-estimate"
                >
                  <title>
                    {r.label} estimate {fmtPrice(r.estimate, currency)}
                  </title>
                </circle>
              )}
              {r.actual != null && (
                <circle
                  cx={cx}
                  cy={yFor(r.actual)}
                  r={4}
                  className={`stocks-trends-dot-actual ${beat ? "beat" : "miss"}`}
                >
                  <title>
                    {r.label} actual {fmtPrice(r.actual, currency)} (vs est{" "}
                    {fmtPrice(r.estimate, currency)})
                  </title>
                </circle>
              )}
              <text
                x={cx}
                y={PAD_T + plotH + 12}
                className="stocks-trends-xaxis"
                textAnchor="middle"
              >
                {r.label}
              </text>
              {!isFuture && r.actual != null && r.estimate != null ? (
                <>
                  <text
                    x={cx}
                    y={PAD_T + plotH + 22}
                    className={`stocks-trends-sub ${beat ? "beat" : "miss"}`}
                    textAnchor="middle"
                  >
                    {beat ? "Beat" : "Miss"}
                  </text>
                  <text
                    x={cx}
                    y={PAD_T + plotH + 30}
                    className={`stocks-trends-sub-delta ${beat ? "beat" : "miss"}`}
                    textAnchor="middle"
                  >
                    {fmtSignedNum(r.actual - r.estimate, 2)}
                  </text>
                </>
              ) : isFuture && r.reportDate ? (
                <text
                  x={cx}
                  y={PAD_T + plotH + 24}
                  className="stocks-trends-sub upcoming"
                  textAnchor="middle"
                >
                  {fmtShortDate(r.reportDate)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Revenue (mint) vs Net Income (warn) side-by-side bars at annual or
// quarterly cadence. Yahoo's UI puts these next to the EPS dot chart; we
// stack vertically since the sidepanel is narrow.
function RevenueEarningsChart({ financials }: { financials: FinancialsChart }) {
  const [mode, setMode] = useState<"annual" | "quarterly">("quarterly");
  const bars = useMemo(() => {
    const src = mode === "annual" ? financials.annual : financials.quarterly;
    // Keep the chart readable on a narrow panel — show at most 4 periods.
    return src.slice(-4);
  }, [mode, financials]);
  const latest = bars[bars.length - 1] ?? null;

  let lo = 0;
  let hi = 0;
  for (const b of bars) {
    if (b.revenue != null) hi = Math.max(hi, b.revenue);
    if (b.earnings != null) {
      hi = Math.max(hi, b.earnings);
      lo = Math.min(lo, b.earnings);
    }
  }
  const pad = (hi - lo) * 0.08 || 1;
  const ticks = niceTicks(lo, hi + pad, 4);
  const yMin = Math.min(lo, ticks[0] ?? lo);
  const yMax = Math.max(hi + pad, ticks[ticks.length - 1] ?? hi);

  const W = 280;
  const H = 130;
  const PAD_L = 34;
  const PAD_R = 6;
  const PAD_T = 8;
  const PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slotW = plotW / Math.max(1, bars.length);
  const barW = Math.max(6, Math.min(20, slotW * 0.3));
  const barGap = barW * 0.25;
  const yFor = (v: number) =>
    PAD_T + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;
  const zeroY = yFor(0);

  return (
    <div className="stocks-trends">
      <div className="stocks-trends-head">
        <span className="stocks-trends-section">Revenue vs Earnings</span>
        <div className="stocks-trends-toggle" role="group" aria-label="Period">
          <button
            type="button"
            className={mode === "annual" ? "active" : ""}
            onClick={() => setMode("annual")}
          >
            Annual
          </button>
          <button
            type="button"
            className={mode === "quarterly" ? "active" : ""}
            onClick={() => setMode("quarterly")}
          >
            Quarterly
          </button>
        </div>
      </div>
      {latest && (
        <div className="stocks-trends-legend">
          <span className="stocks-trends-q">{latest.label}</span>
          <span className="stocks-trends-key">
            <span className="stocks-trends-swatch revenue" aria-hidden="true" />
            Rev <b>{fmtCompactShort(latest.revenue)}</b>
          </span>
          <span className="stocks-trends-key">
            <span className="stocks-trends-swatch earnings" aria-hidden="true" />
            Earn{" "}
            <b className={(latest.earnings ?? 0) < 0 ? "miss" : ""}>
              {fmtCompactShort(latest.earnings)}
            </b>
          </span>
        </div>
      )}
      <svg
        className="stocks-trends-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Revenue and earnings comparison"
      >
        {ticks.map((tk, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(tk)}
              y2={yFor(tk)}
              className="stocks-trends-grid"
            />
            <text
              x={PAD_L - 4}
              y={yFor(tk)}
              className="stocks-trends-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {fmtCompactShort(tk)}
            </text>
          </g>
        ))}
        {yMin < 0 && yMax > 0 && (
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={zeroY}
            y2={zeroY}
            className="stocks-trends-zero"
          />
        )}

        {bars.map((b, i) => {
          const cx = PAD_L + slotW * (i + 0.5);
          const rev = b.revenue ?? 0;
          const earn = b.earnings ?? 0;
          const revY = yFor(rev);
          const earnY = yFor(earn);
          const revH = Math.abs(revY - zeroY);
          const earnH = Math.abs(earnY - zeroY);
          const revX = cx - barW - barGap / 2;
          const earnX = cx + barGap / 2;
          return (
            <g key={i}>
              <rect
                x={revX}
                y={Math.min(revY, zeroY)}
                width={barW}
                height={Math.max(0.5, revH)}
                rx={1.5}
                className="stocks-trends-bar revenue"
              >
                <title>
                  {b.label} Revenue {fmtCompactShort(rev)}
                </title>
              </rect>
              <rect
                x={earnX}
                y={Math.min(earnY, zeroY)}
                width={barW}
                height={Math.max(0.5, earnH)}
                rx={1.5}
                className={`stocks-trends-bar earnings ${earn < 0 ? "neg" : ""}`}
              >
                <title>
                  {b.label} Earnings {fmtCompactShort(earn)}
                </title>
              </rect>
              <text
                x={cx}
                y={H - 4}
                className="stocks-trends-xaxis"
                textAnchor="middle"
              >
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Nicely rounded tick values covering [min, max], picking step sizes from
// {1,2,5}×10^n. Same shape used elsewhere in the panel.
function niceTicks(min: number, max: number, target = 5): number[] {
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

// --- formatters --------------------------------------------------------------

function fmtPrice(n: number | null, currency: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sym = currency === "USD" ? "$" : "";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  return `${sym}${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function fmtNum(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtSignedNum(n: number, digits = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}
function fmtPct(n: number, digits = 2): string {
  return n.toFixed(digits) + "%";
}
function fmtSignedPct(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}
// Y-axis tick format for the EPS dot chart — leans on the magnitude so
// fractional EPS still reads correctly without dragging long decimals.
function fmtAxisNum(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(digits);
}
// Compact unit form ("37.4B", "1.5M", "-4.9B") with no currency prefix —
// used by the bar chart axis where each tick label needs to be tiny.
function fmtCompactShort(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}
// "Jun 24" — used under the future-quarter slot of the EPS chart.
function fmtShortDate(ms: number): string {
  const d = new Date(ms);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
function fmtCompact(n: number, currency: string): string {
  const sym = currency === "USD" ? "$" : currency ? "" : "";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sym}${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sym}${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sym}${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sym}${(n / 1e3).toFixed(1)}K`;
  return `${sym}${n.toFixed(0)}`;
}
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}
function fmtClockNoSec(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
function fmtRelativeDays(ms: number): string {
  const days = Math.round((ms - Date.now()) / (24 * 3_600_000));
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}
