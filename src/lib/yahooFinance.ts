// Yahoo Finance client — fundamentals + earnings via the public web API the
// finance.yahoo.com site itself uses. There's no documented programmatic API
// since the v7/v10 endpoints were locked in 2023, but the same crumb dance
// the web client performs still works from any origin with cookies enabled.
//
// Flow:
//   1) GET fc.yahoo.com/ once — Yahoo's edge sets the A1/A3 consent cookies.
//   2) GET /v1/test/getcrumb — returns a session-bound anti-CSRF token.
//   3) Use ?crumb=<token> on every quoteSummary call; on Unauthorized refresh
//      the crumb (cookie may have rotated) and retry once.
//
// The /v8/finance/chart endpoint is open and needs no crumb — we use it for
// price/range/volume/exchange meta. The crumb is only needed for fundamentals
// (market cap, P/E, EPS, dividend, earnings calendar/history).

const Y1 = "https://query1.finance.yahoo.com";

// Bare HL ticker → Yahoo Finance symbol. Most HL stock listings use the same
// ticker as the primary US exchange (AAPL, NVDA, GOOGL, …) and need no entry.
// Only non-US primary listings get a suffix (Korea .KS, Tokyo .T). Add a row
// when an HL stock has a non-default exchange suffix at its home market.
const HL_TO_YAHOO: Record<string, string> = {
  HYUNDAI: "005380.KS", // Hyundai Motor Co (KRX)
  SMSN: "005930.KS", // Samsung Electronics (KRX)
  SKHX: "000660.KS", // SK Hynix (KRX)
  KIOXIA: "285A.T", // Kioxia Holdings (TSE)
  SOFTBANK: "9984.T", // SoftBank Group (TSE)
};

// Strip HL's "<dex>:" prefix and map to Yahoo's symbol space.
export function coinToYahooSymbol(coin: string): string {
  const colon = coin.indexOf(":");
  const base = colon >= 0 ? coin.slice(colon + 1) : coin;
  return HL_TO_YAHOO[base] ?? base;
}

let crumbPromise: Promise<string> | null = null;
async function getCrumb(): Promise<string> {
  if (crumbPromise) return crumbPromise;
  crumbPromise = (async () => {
    // Cookie seed. The response body doesn't matter — we just need the
    // Set-Cookie to land in the browser jar so getcrumb sees a session.
    await fetch("https://fc.yahoo.com/", {
      credentials: "include",
      cache: "no-store",
    }).catch(() => {
      // fc.yahoo.com sometimes returns non-2xx, but the cookie is still set.
    });
    const res = await fetch(`${Y1}/v1/test/getcrumb`, {
      credentials: "include",
      cache: "no-store",
    });
    const text = (await res.text()).trim();
    if (!text || text.includes("Unauthorized") || text.length > 32) {
      throw new Error(`Yahoo crumb fetch failed: ${text.slice(0, 80)}`);
    }
    return text;
  })().catch((e) => {
    crumbPromise = null; // allow a retry on the next call
    throw e;
  });
  return crumbPromise;
}

export type YahooChartMeta = {
  symbol: string;
  currency: string;
  exchangeName: string;
  fullExchangeName: string;
  regularMarketPrice: number;
  chartPreviousClose: number;
  regularMarketDayHigh: number;
  regularMarketDayLow: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  regularMarketVolume: number;
  regularMarketTime: number;
  longName?: string;
  shortName?: string;
};

export type YahooChartPoint = { t: number; close: number };

export type YahooChart = {
  meta: YahooChartMeta;
  points: YahooChartPoint[];
};

// Price + 52w/day range + volume + exchange meta + intraday/daily series.
// `range` follows Yahoo conventions (1d/5d/1mo/3mo/6mo/1y/2y/5y/10y/ytd/max).
export async function fetchYahooChart(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<YahooChart | null> {
  const url = `${Y1}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    chart?: {
      result?: {
        meta: YahooChartMeta;
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
      error?: { code: string; description: string } | null;
    };
  };
  const r = j.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const points: YahooChartPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    points.push({ t: ts[i] * 1000, close: c });
  }
  return { meta: r.meta, points };
}

// Yahoo wraps every numeric field as { raw, fmt, longFmt? } so we shape the
// caller-friendly types here.
type YNum = { raw: number; fmt: string } | undefined;
type YDate = { raw: number; fmt: string } | undefined;

// Where the market is in its trading day. Yahoo's marketState values:
//   REGULAR  — main session is live
//   PRE      — pre-market (~04:00–09:30 ET)
//   POST     — post-market / after-hours (~16:00–20:00 ET)
//   PREPRE   — overnight gap (~20:00 ET previous day to ~04:00 ET)
//                NOTE: Yahoo's web UI shows Blue Ocean ATS overnight prices
//                here but the public JSON API does NOT expose them. We only
//                know we're IN this window via marketState.
//   POSTPOST — post-post-market (rare, between sessions)
//   CLOSED   — weekend / holiday
export type MarketState =
  | "REGULAR"
  | "PRE"
  | "PREPRE"
  | "POST"
  | "POSTPOST"
  | "CLOSED";

export type YahooFundamentals = {
  marketState: MarketState | null;
  // The actual previous trading day's close (for day-change calc). The chart
  // endpoint's `chartPreviousClose` is the close just before the chart's
  // range, not yesterday, so when we ask for range=1y it returns a year ago.
  // Always prefer this value over chart meta for "% change today".
  previousClose: number | null;
  // Yahoo-computed regular-session change. We could derive these from price -
  // previousClose, but Yahoo handles splits/dividends so trust the source.
  regularMarketChange: number | null;
  regularMarketChangePercent: number | null;
  // Extended-hours trading. Pre-market is active before US open (~04:00-09:30
  // ET), post-market (after-hours) after close (~16:00-20:00 ET). Yahoo only
  // populates these when there's actual extended-hours activity, so a null
  // value means "no trade outside the session" — hide the row in that case.
  postMarketPrice: number | null;
  postMarketChange: number | null;
  postMarketChangePercent: number | null;
  postMarketTime: number | null;
  preMarketPrice: number | null;
  preMarketChange: number | null;
  preMarketChangePercent: number | null;
  preMarketTime: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  dividendYield: number | null; // decimal (0.005 = 0.5%)
  beta: number | null;
  fiftyTwoWeekChangePct: number | null;
  sharesOutstanding: number | null;
  // Calendar
  nextEarningsDate: number | null; // ms; first entry if Yahoo returns a range
  earningsDateRange: [number, number] | null;
  exDividendDate: number | null;
  dividendDate: number | null;
};

export type YahooEarningsRow = {
  quarter: string; // "1Q2026" style, from Yahoo's fmt
  date: number; // quarter-end ms
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePercent: number | null; // already in percent (e.g. 33.2 for a 33.2% beat)
};

// EPS dot-chart: last 4 reported quarters + the next quarter's consensus
// estimate (no actual yet). Yahoo's `earnings.earningsChart` gives us this
// shape directly.
export type EpsQuarter = {
  label: string; // "Q3 FY25" style (fiscal-quarter for the company)
  estimate: number | null;
  actual: number | null; // null for the upcoming quarter
  reportDate?: number | null; // expected report date for upcoming quarter (ms)
};

// Revenue + Net Income paired bars, available at annual and quarterly cadence.
export type FinancialsBar = {
  label: string; // "FY 2025" / "Q3 FY25"
  revenue: number | null;
  earnings: number | null; // net income; can be negative
};

export type FinancialsChart = {
  annual: FinancialsBar[];
  quarterly: FinancialsBar[];
  currency: string; // ISO code from financialCurrency
};

export type YahooSummary = {
  fundamentals: YahooFundamentals;
  earningsHistory: YahooEarningsRow[]; // oldest → newest
  epsTrend: EpsQuarter[]; // 4 past + 1 future, oldest → newest
  financials: FinancialsChart | null;
};

const SUMMARY_MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "calendarEvents",
  "earningsHistory",
  // `earnings` gives the dot-chart data (4 past Qs + next Q estimate) plus
  // annual & quarterly revenue / net-income bars Yahoo's UI uses.
  "earnings",
] as const;

async function quoteSummaryRaw(symbol: string): Promise<any | null> {
  const modules = SUMMARY_MODULES.join(",");
  const call = async (crumb: string) => {
    const url = `${Y1}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    return (await res.json()) as {
      quoteSummary?: {
        result?: unknown[] | null;
        error?: { code?: string; description?: string } | null;
      };
    };
  };
  let crumb = await getCrumb();
  let j = await call(crumb);
  // Stale crumb → cookie rotated. Refresh once.
  if (
    j.quoteSummary?.error &&
    (j.quoteSummary.error.code === "Unauthorized" ||
      /Invalid (Crumb|Cookie)/i.test(j.quoteSummary.error.description ?? ""))
  ) {
    crumbPromise = null;
    crumb = await getCrumb();
    j = await call(crumb);
  }
  const r = j.quoteSummary?.result;
  return Array.isArray(r) && r.length > 0 ? r[0] : null;
}

const num = (v: YNum): number | null =>
  v && typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw : null;
const dt = (v: YDate): number | null =>
  v && typeof v.raw === "number" && Number.isFinite(v.raw) ? v.raw * 1000 : null;

export async function fetchYahooSummary(symbol: string): Promise<YahooSummary | null> {
  const r = await quoteSummaryRaw(symbol);
  if (!r) return null;
  const price = r.price ?? {};
  const det = r.summaryDetail ?? {};
  const ks = r.defaultKeyStatistics ?? {};
  const cal = r.calendarEvents?.earnings ?? {};
  const histRows: any[] = r.earningsHistory?.history ?? [];

  // earningsDate can be one timestamp (estimated date) or two (date range).
  const earningsDates: number[] = Array.isArray(cal.earningsDate)
    ? cal.earningsDate
        .map((d: YDate) => dt(d))
        .filter((x: number | null): x is number => x != null)
    : [];

  // Yahoo stores postMarketChangePercent as a fraction (0.0091 = 0.91%) like
  // surprisePercent. Normalize to a percent number so display can just append
  // "%". Same for regular- and pre-market.
  const pct = (v: YNum): number | null => {
    const r = num(v);
    return r != null ? r * 100 : null;
  };

  const ms = typeof price.marketState === "string" ? price.marketState : null;
  const fundamentals: YahooFundamentals = {
    marketState: (ms as MarketState) ?? null,
    previousClose:
      num(price.regularMarketPreviousClose) ?? num(det.previousClose),
    regularMarketChange: num(price.regularMarketChange),
    regularMarketChangePercent: pct(price.regularMarketChangePercent),
    postMarketPrice: num(price.postMarketPrice),
    postMarketChange: num(price.postMarketChange),
    postMarketChangePercent: pct(price.postMarketChangePercent),
    postMarketTime: dt(price.postMarketTime),
    preMarketPrice: num(price.preMarketPrice),
    preMarketChange: num(price.preMarketChange),
    preMarketChangePercent: pct(price.preMarketChangePercent),
    preMarketTime: dt(price.preMarketTime),
    marketCap: num(price.marketCap) ?? num(det.marketCap),
    trailingPE: num(det.trailingPE) ?? num(ks.trailingPE),
    forwardPE: num(det.forwardPE) ?? num(ks.forwardPE),
    trailingEps: num(ks.trailingEps),
    forwardEps: num(ks.forwardEps),
    dividendYield: num(det.dividendYield) ?? num(det.trailingAnnualDividendYield),
    beta: num(det.beta) ?? num(ks.beta),
    fiftyTwoWeekChangePct: num(ks["52WeekChange"]) ?? num(ks.fiftyTwoWeekChange),
    sharesOutstanding: num(ks.sharesOutstanding),
    nextEarningsDate: earningsDates[0] ?? null,
    earningsDateRange:
      earningsDates.length >= 2 ? [earningsDates[0], earningsDates[1]] : null,
    exDividendDate: dt(det.exDividendDate),
    dividendDate: dt(det.dividendDate),
  };

  // Yahoo returns earnings history newest-first; flip so the bar chart reads
  // left → right chronologically.
  const earningsHistory: YahooEarningsRow[] = histRows
    .map((h) => {
      // Yahoo's surprisePercent is a fraction (0.332 = 33.2%); normalize to
      // a percent number so display code can just append "%".
      const surFrac = num(h.surprisePercent);
      return {
        quarter: h.quarter?.fmt ?? "",
        date: dt(h.quarter) ?? 0,
        epsEstimate: num(h.epsEstimate),
        epsActual: num(h.epsActual),
        surprisePercent: surFrac != null ? surFrac * 100 : null,
      };
    })
    .filter((row) => row.epsActual != null || row.epsEstimate != null)
    .sort((a, b) => a.date - b.date);

  // EPS dot-chart: 4 past quarters (already-flipped to chronological) plus
  // the upcoming quarter's consensus estimate. Yahoo stores fiscal-quarter
  // labels like "2Q2025"; remap to "Q2 FY25" which trader UIs use more.
  const ecRaw = r.earnings?.earningsChart ?? null;
  const epsTrend: EpsQuarter[] = [];
  if (ecRaw) {
    for (const q of ecRaw.quarterly ?? []) {
      epsTrend.push({
        label: fiscalLabel(q.date),
        estimate: num(q.estimate),
        actual: num(q.actual),
        reportDate: null,
      });
    }
    const upcomingEst = num(ecRaw.currentQuarterEstimate);
    const upcomingQ = ecRaw.currentQuarterEstimateDate as string | undefined; // "2Q"
    const upcomingY = ecRaw.currentQuarterEstimateYear as number | undefined;
    const upcomingDate = Array.isArray(ecRaw.earningsDate)
      ? dt(ecRaw.earningsDate[0])
      : null;
    if (upcomingEst != null && upcomingQ && upcomingY != null) {
      epsTrend.push({
        label: fiscalLabel(`${upcomingQ}${upcomingY}`),
        estimate: upcomingEst,
        actual: null,
        reportDate: upcomingDate,
      });
    }
  }

  // Annual + quarterly revenue / earnings bars. Earnings can be negative.
  const fcRaw = r.earnings?.financialsChart ?? null;
  const financials: FinancialsChart | null = fcRaw
    ? {
        annual: (fcRaw.yearly ?? []).map((y: any) => ({
          label: `FY ${y.date}`,
          revenue: num(y.revenue),
          earnings: num(y.earnings),
        })),
        quarterly: (fcRaw.quarterly ?? []).map((q: any) => ({
          label: fiscalLabel(q.date),
          revenue: num(q.revenue),
          earnings: num(q.earnings),
        })),
        currency:
          typeof r.earnings?.financialCurrency === "string"
            ? r.earnings.financialCurrency
            : "USD",
      }
    : null;

  return { fundamentals, earningsHistory, epsTrend, financials };
}

// Yahoo formats fiscal quarters as "1Q2026" / "2Q2025". Reshape to "Q1 FY26"
// for compact trader-style labels.
function fiscalLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const m = raw.match(/^(\d)Q(\d{4})$/);
  if (!m) return raw;
  return `Q${m[1]} FY${m[2].slice(2)}`;
}
