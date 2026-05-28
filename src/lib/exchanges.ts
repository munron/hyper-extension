// Cross-exchange funding-rate aggregation, normalized to a common annualized
// basis (APR) so venues on different funding intervals are comparable.
//
// The trap: Hyperliquid charges funding hourly (1h), most CEXs every 8h, and
// some venues 4h or 1h. Comparing raw per-interval rates is meaningless — a
// "0.01%" 8h rate annualizes very differently from a "0.01%" 1h rate. We always
// read each venue's true interval (live, never assumed where the API gives it)
// and annualize: APR = rate * (8760 / intervalHours) * 100.

import {
  fetchPredictedFundings,
  fetchFundingHistoryRange,
  type PredictedFundingEntry,
  type PredictedVenueFunding,
} from "./hyperliquid";

export type VenueKind = "CEX" | "DEX";

export type VenueFunding = {
  venue: string;
  kind: VenueKind;
  aprPct: number;
  intervalHours: number;
  nextFundingMs: number | null;
  available: true;
};
export type VenueUnavailable = {
  venue: string;
  kind: VenueKind;
  available: false;
  reason: string;
};
export type VenueResult = VenueFunding | VenueUnavailable;

export const HL_VENUE = "Hyperliquid";

// Canonical display order. Hyperliquid is the anchor; everything is compared
// against it.
const VENUE_ORDER: { venue: string; kind: VenueKind }[] = [
  { venue: HL_VENUE, kind: "DEX" },
  { venue: "Binance", kind: "CEX" },
  { venue: "OKX", kind: "CEX" },
  { venue: "Bybit", kind: "CEX" },
  { venue: "Aster", kind: "DEX" },
  { venue: "edgeX", kind: "DEX" },
  { venue: "Lighter", kind: "DEX" },
  { venue: "Grvt", kind: "DEX" },
  { venue: "Variational", kind: "DEX" },
  { venue: "Pacifica", kind: "DEX" },
  { venue: "Extended", kind: "DEX" },
];

const NOT_WIRED = new Set<string>([]);

// Deep link to each venue's trading page for a given coin. Symbol conventions
// differ per venue (USDT vs USD vs bare coin, dash vs none, case), so each is
// spelled out. Returns null for venues we don't know how to link.
export function venueTradeUrl(venue: string, coin: string): string | null {
  const c = coin.toUpperCase();
  switch (venue) {
    case HL_VENUE:
      return `https://app.hyperliquid.xyz/trade/${c}`;
    case "Binance":
      return `https://www.binance.com/en/futures/${c}USDT`;
    case "Bybit":
      return `https://www.bybit.com/trade/usdt/${c}USDT`;
    case "OKX":
      return `https://www.okx.com/trade-swap/${c.toLowerCase()}-usdt-swap`;
    case "Aster":
      return `https://www.asterdex.com/en/futures/v1/${c}USDT`;
    case "edgeX":
      return `https://pro.edgex.exchange/trade/${c}USD`;
    case "Lighter":
      return `https://app.lighter.xyz/trade/${c}`;
    case "Grvt":
      return `https://grvt.io/exchange/perpetual/${c}-USDT`;
    case "Variational":
      return `https://omni.variational.io/perpetual/${c}`;
    case "Pacifica":
      return `https://app.pacifica.fi/trade/${c}`;
    case "Extended":
      return `https://app.extended.exchange/perp/${c}-USD`;
    default:
      return null;
  }
}

const HOURS_PER_YEAR = 24 * 365;

function toApr(perIntervalRate: number, intervalHours: number): number {
  if (!Number.isFinite(perIntervalRate) || !(intervalHours > 0)) return NaN;
  return perIntervalRate * (HOURS_PER_YEAR / intervalHours) * 100;
}

// Venues that settle on the clock (hourly) but don't return a timestamp.
function nextTopOfHour(): number {
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
}

function unavailable(
  venue: string,
  kind: VenueKind,
  reason: string,
): VenueUnavailable {
  return { venue, kind, available: false, reason };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// --- Hyperliquid / Binance / Bybit from HL's predictedFundings ----------------
//
// HL's predictedFundings bundles HL's own funding plus its read of Binance/Bybit
// in one call. Convenient, but its CEX coverage has gaps: for coins where HL
// isn't tracking the CEX counterpart (e.g. HYPE) it returns null for BinPerp /
// BybitPerp even though those venues do list the coin. So this is used directly
// for HL, but only as a *fallback* for Binance/Bybit behind their own APIs below.

function fromPredicted(
  pairs: [string, PredictedVenueFunding | null][] | undefined,
  venueCode: string,
  venue: string,
  kind: VenueKind,
): VenueResult {
  const info = pairs?.find(([code]) => code === venueCode)?.[1];
  if (!info || info.fundingRate == null) {
    return unavailable(venue, kind, "not listed");
  }
  const rate = parseFloat(info.fundingRate);
  const intervalHours = info.fundingIntervalHours || 1;
  const apr = toApr(rate, intervalHours);
  if (!Number.isFinite(apr)) return unavailable(venue, kind, "no data");
  return {
    venue,
    kind,
    aprPct: apr,
    intervalHours,
    nextFundingMs: info.nextFundingTime ?? null,
    available: true,
  };
}

// Prefer the direct read; fall back to predicted when direct is unavailable.
function preferAvailable(primary: VenueResult, fallback: VenueResult): VenueResult {
  if (primary.available) return primary;
  if (fallback.available) return fallback;
  return primary;
}

// --- Binance (direct fapi; interval default 8h, overrides via fundingInfo) ----

// Binance funding is 8h by default; some symbols run 4h/1h. The override list
// lives in one fundingInfo call — fetch once per session and cache.
let binanceIntervalPromise: Promise<Map<string, number>> | null = null;
function getBinanceIntervals(): Promise<Map<string, number>> {
  if (!binanceIntervalPromise) {
    binanceIntervalPromise = (async () => {
      const j = (await getJson("https://fapi.binance.com/fapi/v1/fundingInfo")) as {
        symbol?: string;
        fundingIntervalHours?: number;
      }[];
      const map = new Map<string, number>();
      for (const x of j ?? []) {
        if (x.symbol && x.fundingIntervalHours) map.set(x.symbol, x.fundingIntervalHours);
      }
      return map;
    })().catch((e) => {
      binanceIntervalPromise = null; // allow a retry on the next load
      throw e;
    });
  }
  return binanceIntervalPromise;
}

async function fetchBinance(coin: string): Promise<VenueResult> {
  const venue = "Binance";
  const kind: VenueKind = "CEX";
  try {
    const symbol = `${coin}USDT`;
    const [pi, intervals] = await Promise.all([
      getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`) as Promise<{
        lastFundingRate?: string;
        nextFundingTime?: number;
      }>,
      getBinanceIntervals().catch(() => new Map<string, number>()),
    ]);
    if (pi.lastFundingRate == null) return unavailable(venue, kind, "not listed");
    const intervalHours = intervals.get(symbol) || 8;
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(pi.lastFundingRate), intervalHours),
      intervalHours,
      nextFundingMs: Number(pi.nextFundingTime) || null,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Bybit (direct v5; interval read live from instruments-info) -------------

async function fetchBybit(coin: string): Promise<VenueResult> {
  const venue = "Bybit";
  const kind: VenueKind = "CEX";
  try {
    const symbol = `${coin}USDT`;
    const [tick, instr] = await Promise.all([
      getJson(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
      ) as Promise<{
        result?: { list?: { fundingRate?: string; nextFundingTime?: string }[] };
      }>,
      (getJson(
        `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`,
      ).catch(() => null)) as Promise<{
        result?: { list?: { fundingInterval?: number }[] };
      } | null>,
    ]);
    const t = tick.result?.list?.[0];
    if (!t || !t.fundingRate) return unavailable(venue, kind, "not listed");
    // fundingInterval is in MINUTES (e.g. 480 = 8h); default to 8h if absent.
    const minutes = instr?.result?.list?.[0]?.fundingInterval;
    const intervalHours = minutes ? Math.max(1, Math.round(minutes / 60)) : 8;
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(t.fundingRate), intervalHours),
      intervalHours,
      nextFundingMs: Number(t.nextFundingTime) || null,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- OKX ---------------------------------------------------------------------

async function fetchOkx(coin: string): Promise<VenueResult> {
  const venue = "OKX";
  const kind: VenueKind = "CEX";
  try {
    const j = (await getJson(
      `https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`,
    )) as { data?: Record<string, string>[] };
    const d = j.data?.[0];
    if (!d || !d.fundingRate) return unavailable(venue, kind, "not listed");
    const rate = parseFloat(d.fundingRate);
    const fundingTime = Number(d.fundingTime); // upcoming settlement
    const prev = Number(d.prevFundingTime);
    const intervalHours =
      prev && fundingTime
        ? Math.max(1, Math.round((fundingTime - prev) / 3_600_000))
        : 8;
    return {
      venue,
      kind,
      aprPct: toApr(rate, intervalHours),
      intervalHours,
      nextFundingMs: fundingTime || null,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Aster (Binance-compatible fapi) -----------------------------------------

// Aster funding intervals vary widely: majors are 8h, but most listings (~2/3)
// run 1h or 4h. Like Binance, the per-symbol interval lives in one fundingInfo
// call — fetch once per session and cache. Default 8h if a symbol is missing.
let asterIntervalPromise: Promise<Map<string, number>> | null = null;
function getAsterIntervals(): Promise<Map<string, number>> {
  if (!asterIntervalPromise) {
    asterIntervalPromise = (async () => {
      const j = (await getJson("https://fapi.asterdex.com/fapi/v1/fundingInfo")) as {
        symbol?: string;
        fundingIntervalHours?: number;
      }[];
      const map = new Map<string, number>();
      for (const x of j ?? []) {
        if (x.symbol && x.fundingIntervalHours) map.set(x.symbol, x.fundingIntervalHours);
      }
      return map;
    })().catch((e) => {
      asterIntervalPromise = null; // allow a retry on the next load
      throw e;
    });
  }
  return asterIntervalPromise;
}

async function fetchAster(coin: string): Promise<VenueResult> {
  const venue = "Aster";
  const kind: VenueKind = "DEX";
  try {
    const symbol = `${coin}USDT`;
    const [j, intervals] = await Promise.all([
      getJson(`https://fapi.asterdex.com/fapi/v1/premiumIndex?symbol=${symbol}`) as Promise<{
        lastFundingRate?: string;
        nextFundingTime?: number;
      }>,
      getAsterIntervals().catch(() => new Map<string, number>()),
    ]);
    if (j.lastFundingRate == null) return unavailable(venue, kind, "not listed");
    const intervalHours = intervals.get(symbol) || 8;
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(j.lastFundingRate), intervalHours),
      intervalHours,
      nextFundingMs: Number(j.nextFundingTime) || null,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Lighter (hourly) --------------------------------------------------------

async function fetchLighter(coin: string): Promise<VenueResult> {
  const venue = "Lighter";
  const kind: VenueKind = "DEX";
  try {
    const j = (await getJson(
      "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates",
    )) as { funding_rates?: { symbol: string; exchange: string; rate: number }[] };
    // This is a funding *comparison* feed: each market is listed against
    // several reference exchanges, all on a common 8h basis (the feed's own
    // "binance" row annualized at 8h matches Binance's real APR, which is how
    // we know the basis). The "lighter" row is Lighter's own funding on that
    // same 8h basis. The feed carries no settlement timestamp, so we can't show
    // a reliable countdown.
    const row = j.funding_rates?.find(
      (x) => x.symbol === coin && x.exchange === "lighter",
    );
    if (!row) return unavailable(venue, kind, "not listed");
    const intervalHours = 8;
    return {
      venue,
      kind,
      aprPct: toApr(Number(row.rate), intervalHours),
      intervalHours,
      nextFundingMs: null,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Pacifica (hourly) -------------------------------------------------------

async function fetchPacifica(coin: string): Promise<VenueResult> {
  const venue = "Pacifica";
  const kind: VenueKind = "DEX";
  try {
    const j = (await getJson("https://api.pacifica.fi/api/v1/info")) as {
      data?: { symbol: string; funding_rate?: string; next_funding_rate?: string }[];
    };
    const row = j.data?.find((x) => x.symbol === coin);
    const raw = row?.next_funding_rate ?? row?.funding_rate;
    if (raw == null) return unavailable(venue, kind, "not listed");
    const intervalHours = 1;
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(raw), intervalHours),
      intervalHours,
      nextFundingMs: nextTopOfHour(),
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Extended (hourly) -------------------------------------------------------

async function fetchExtended(coin: string): Promise<VenueResult> {
  const venue = "Extended";
  const kind: VenueKind = "DEX";
  try {
    const j = (await getJson(
      "https://api.starknet.extended.exchange/api/v1/info/markets",
    )) as {
      data?: {
        name: string;
        marketStats?: { fundingRate?: string; nextFundingRate?: number };
      }[];
    };
    const ms = j.data?.find((x) => x.name === `${coin}-USD`)?.marketStats;
    if (!ms || ms.fundingRate == null) return unavailable(venue, kind, "not listed");
    const intervalHours = 1;
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(ms.fundingRate), intervalHours),
      intervalHours,
      nextFundingMs: Number(ms.nextFundingRate) || nextTopOfHour(),
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- edgeX (interval read live; often 4h) ------------------------------------

// edgeX funding needs a contractId, and the symbol→contractId map only lives in
// a large (~750KB) metadata blob. Fetch it once per session and cache.
let edgexMapPromise: Promise<Map<string, string>> | null = null;
function getEdgexContractMap(): Promise<Map<string, string>> {
  if (!edgexMapPromise) {
    edgexMapPromise = (async () => {
      const j = (await getJson(
        "https://pro.edgex.exchange/api/v1/public/meta/getMetaData",
      )) as { data?: { contractList?: { contractName?: string; contractId?: string }[] } };
      const map = new Map<string, string>();
      for (const c of j.data?.contractList ?? []) {
        if (c.contractName && c.contractId) map.set(c.contractName, c.contractId);
      }
      return map;
    })().catch((e) => {
      edgexMapPromise = null; // allow a retry on the next load
      throw e;
    });
  }
  return edgexMapPromise;
}

async function fetchEdgex(coin: string): Promise<VenueResult> {
  const venue = "edgeX";
  const kind: VenueKind = "DEX";
  try {
    const contractId = (await getEdgexContractMap()).get(`${coin}USD`);
    if (!contractId) return unavailable(venue, kind, "not listed");
    const j = (await getJson(
      `https://pro.edgex.exchange/api/v1/public/funding/getLatestFundingRate?contractId=${contractId}`,
    )) as {
      data?: {
        fundingRate?: string;
        forecastFundingRate?: string;
        fundingTime?: string;
        fundingRateIntervalMin?: string;
      }[];
    };
    const d = j.data?.[0];
    // Trap: edgeX also returns `predictedFundingRate`, but that's just the
    // interest-rate baseline (~+0.00005 = +10.95% APR), not the expected
    // funding — using it makes every coin look like a flat +10.95%. The real
    // upcoming rate (the one shown next to the countdown) is
    // `forecastFundingRate`; fall back to the live `fundingRate`.
    const raw = d?.forecastFundingRate ?? d?.fundingRate;
    if (raw == null) return unavailable(venue, kind, "no data");
    const intervalHours = Math.max(1, Number(d?.fundingRateIntervalMin || 240) / 60);
    // fundingTime is the current period boundary; step forward to the next one.
    const step = intervalHours * 3_600_000;
    const boundary = Number(d?.fundingTime) || 0;
    let nextFundingMs: number | null = boundary || null;
    if (nextFundingMs) {
      const nowMs = Date.now();
      while (nextFundingMs <= nowMs) nextFundingMs += step;
    }
    return {
      venue,
      kind,
      aprPct: toApr(parseFloat(raw), intervalHours),
      intervalHours,
      nextFundingMs,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- GRVT (8h; funding quoted in percent) ------------------------------------

async function fetchGrvt(coin: string): Promise<VenueResult> {
  const venue = "Grvt";
  const kind: VenueKind = "DEX";
  try {
    const res = await fetch("https://market-data.grvt.io/full/v1/ticker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument: `${coin}_USDT_Perp` }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const j = (await res.json()) as {
      result?: { funding_rate?: string; next_funding_time?: string };
    };
    const raw = j.result?.funding_rate;
    if (raw == null) return unavailable(venue, kind, "not listed");
    // GRVT quotes funding in PERCENT (0.01 = 0.01%, the standard baseline), so
    // divide by 100 to get a fraction before annualizing.
    const rate = parseFloat(raw) / 100;
    const intervalHours = 8; // funding_rate_8h_*
    // next_funding_time is in nanoseconds.
    const ns = Number(j.result?.next_funding_time);
    const nextFundingMs = ns ? Math.round(ns / 1_000_000) : null;
    return {
      venue,
      kind,
      aprPct: toApr(rate, intervalHours),
      intervalHours,
      nextFundingMs,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- Variational (funding already annualized) --------------------------------

// Variational is unusual: its `funding_rate` is NOT a per-interval rate, it's
// already an ANNUALIZED decimal (×100 for percent). The tell is the baseline
// 0.1095 seen on coins with near-zero premium — that's exactly the docs' fixed
// interest rate of 0.00125%/h annualized (0.0000125 × 24 × 365 = 0.1095). So we
// skip toApr() and use the rate directly. `funding_interval_s` is the variable
// settlement window (1h–8h); we surface it as the interval but get no
// next-funding timestamp, so the countdown stays blank (like Lighter).
async function fetchVariational(coin: string): Promise<VenueResult> {
  const venue = "Variational";
  const kind: VenueKind = "DEX";
  try {
    const j = (await getJson(
      "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats",
    )) as {
      listings?: { ticker: string; funding_rate?: string; funding_interval_s?: number }[];
    };
    const row = j.listings?.find((x) => x.ticker === coin);
    if (!row || row.funding_rate == null) return unavailable(venue, kind, "not listed");
    const apr = parseFloat(row.funding_rate) * 100; // already annualized
    if (!Number.isFinite(apr)) return unavailable(venue, kind, "no data");
    const intervalHours = Math.max(1, Math.round((row.funding_interval_s || 28800) / 3600));
    return {
      venue,
      kind,
      aprPct: apr,
      intervalHours,
      nextFundingMs: null, // variable window, no timestamp in the feed
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- aggregate ---------------------------------------------------------------

export async function fetchVenueFundings(coin: string): Promise<VenueResult[]> {
  const [predicted, binance, bybit, okx, aster, lighter, pacifica, extended, edgex, grvt, variational] =
    await Promise.all([
      fetchPredictedFundings().catch(() => null as PredictedFundingEntry[] | null),
      fetchBinance(coin),
      fetchBybit(coin),
      fetchOkx(coin),
      fetchAster(coin),
      fetchLighter(coin),
      fetchPacifica(coin),
      fetchExtended(coin),
      fetchEdgex(coin),
      fetchGrvt(coin),
      fetchVariational(coin),
    ]);

  const pairs = predicted?.find(([c]) => c === coin)?.[1];
  const byName = new Map<string, VenueResult>();
  byName.set(HL_VENUE, fromPredicted(pairs, "HlPerp", HL_VENUE, "DEX"));
  byName.set(
    "Binance",
    preferAvailable(binance, fromPredicted(pairs, "BinPerp", "Binance", "CEX")),
  );
  byName.set(
    "Bybit",
    preferAvailable(bybit, fromPredicted(pairs, "BybitPerp", "Bybit", "CEX")),
  );
  byName.set("OKX", okx);
  byName.set("Aster", aster);
  byName.set("Lighter", lighter);
  byName.set("Pacifica", pacifica);
  byName.set("Extended", extended);
  byName.set("edgeX", edgex);
  byName.set("Grvt", grvt);
  byName.set("Variational", variational);

  return VENUE_ORDER.map(({ venue, kind }) => {
    const r = byName.get(venue);
    if (r) return r;
    return unavailable(venue, kind, NOT_WIRED.has(venue) ? "no api" : "n/a");
  });
}

// ============================================================================
// Funding-rate HISTORY (for the spread chart)
// ============================================================================

export type FundingPoint = { t: number; apr: number };

// Annualize a per-interval rate series to APR %. The interval for each point is
// the actual gap to its NEXT settlement (rounded to whole hours), so venues
// with dynamic intervals annualize correctly point-by-point — HL's 1h samples
// and Binance's 4h/8h samples each map to their own APR. The final point (no
// successor) reuses the prior gap, falling back to the venue's typical interval.
function annualizeSeries(
  raw: { t: number; rate: number }[],
  fallbackHours: number,
): FundingPoint[] {
  const s = raw
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.rate))
    .sort((a, b) => a.t - b.t);
  return s.map((p, i) => {
    let h =
      i + 1 < s.length
        ? Math.round((s[i + 1].t - p.t) / 3_600_000)
        : i > 0
          ? Math.round((p.t - s[i - 1].t) / 3_600_000)
          : fallbackHours;
    if (!(h >= 1)) h = fallbackHours;
    return { t: p.t, apr: p.rate * (HOURS_PER_YEAR / h) * 100 };
  });
}

type RawPoint = { t: number; rate: number };

// Each fetcher returns per-interval rate (decimal fraction) + settlement time.
async function histHyperliquid(coin: string, since: number): Promise<RawPoint[]> {
  const f = await fetchFundingHistoryRange(coin, since, Date.now());
  return f.map((e) => ({ t: e.time, rate: parseFloat(e.fundingRate) }));
}

// Binance and Aster share the Binance fapi shape.
async function histBinanceLike(base: string, coin: string, since: number): Promise<RawPoint[]> {
  const j = (await getJson(
    `${base}/fapi/v1/fundingRate?symbol=${coin}USDT&startTime=${since}&limit=1000`,
  )) as { fundingTime?: number; fundingRate?: string }[];
  return (j ?? []).map((x) => ({ t: Number(x.fundingTime), rate: parseFloat(x.fundingRate ?? "") }));
}

async function histBybit(coin: string, since: number): Promise<RawPoint[]> {
  const j = (await getJson(
    `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${coin}USDT&startTime=${since}&endTime=${Date.now()}&limit=200`,
  )) as { result?: { list?: { fundingRate?: string; fundingRateTimestamp?: string }[] } };
  return (j.result?.list ?? []).map((x) => ({
    t: Number(x.fundingRateTimestamp),
    rate: parseFloat(x.fundingRate ?? ""),
  }));
}

async function histOkx(coin: string): Promise<RawPoint[]> {
  const j = (await getJson(
    `https://www.okx.com/api/v5/public/funding-rate-history?instId=${coin}-USDT-SWAP&limit=100`,
  )) as { data?: { fundingRate?: string; fundingTime?: string }[] };
  return (j.data ?? []).map((x) => ({ t: Number(x.fundingTime), rate: parseFloat(x.fundingRate ?? "") }));
}

async function histEdgex(coin: string): Promise<RawPoint[]> {
  const contractId = (await getEdgexContractMap()).get(`${coin}USD`);
  if (!contractId) return [];
  // Without filterSettlementFundingRate the page returns a minute-by-minute
  // forecast snapshot (all sharing one period boundary); the filter collapses it
  // to one SETTLED rate per period (clean 4h spacing).
  const j = (await getJson(
    `https://pro.edgex.exchange/api/v1/public/funding/getFundingRatePage?contractId=${contractId}&size=100&filterSettlementFundingRate=true`,
  )) as { data?: { dataList?: { fundingTime?: string; fundingRate?: string }[] } };
  return (j.data?.dataList ?? []).map((x) => ({
    t: Number(x.fundingTime),
    rate: parseFloat(x.fundingRate ?? ""),
  }));
}

async function histGrvt(coin: string): Promise<RawPoint[]> {
  const res = await fetch("https://market-data.grvt.io/full/v1/funding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument: `${coin}_USDT_Perp`, limit: 100 }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const j = (await res.json()) as {
    result?: { funding_rate?: string; funding_time?: string }[];
  };
  // funding_time is nanoseconds; funding_rate is PERCENT (divide by 100).
  return (j.result ?? []).map((x) => ({
    t: Math.round(Number(x.funding_time) / 1_000_000),
    rate: parseFloat(x.funding_rate ?? "") / 100,
  }));
}

async function histPacifica(coin: string): Promise<RawPoint[]> {
  const j = (await getJson(
    `https://api.pacifica.fi/api/v1/funding_rate/history?symbol=${coin}`,
  )) as { data?: { funding_rate?: string; created_at?: number }[] };
  return (j.data ?? []).map((x) => ({ t: Number(x.created_at), rate: parseFloat(x.funding_rate ?? "") }));
}

async function histExtended(coin: string, since: number): Promise<RawPoint[]> {
  const j = (await getJson(
    `https://api.starknet.extended.exchange/api/v1/info/${coin}-USD/funding?startTime=${since}&endTime=${Date.now()}`,
  )) as { data?: { f?: string; T?: number }[] };
  return (j.data ?? []).map((x) => ({ t: Number(x.T), rate: parseFloat(x.f ?? "") }));
}

// Lighter funding history needs a numeric market_id; the symbol→id map lives
// in /orderBooks. Cache the lookup for the session.
let lighterMarketMapPromise: Promise<Map<string, number>> | null = null;
function getLighterMarketMap(): Promise<Map<string, number>> {
  if (!lighterMarketMapPromise) {
    lighterMarketMapPromise = (async () => {
      const j = (await getJson(
        "https://mainnet.zklighter.elliot.ai/api/v1/orderBooks",
      )) as { order_books?: { symbol?: string; market_id?: number }[] };
      const map = new Map<string, number>();
      for (const b of j.order_books ?? []) {
        if (b.symbol && Number.isFinite(b.market_id)) {
          map.set(b.symbol, b.market_id as number);
        }
      }
      return map;
    })().catch((e) => {
      lighterMarketMapPromise = null;
      throw e;
    });
  }
  return lighterMarketMapPromise;
}

async function histLighter(coin: string, since: number): Promise<RawPoint[]> {
  const marketId = (await getLighterMarketMap()).get(coin);
  if (marketId == null) return [];
  // The /fundings endpoint returns hourly samples with: `rate` as PERCENT per
  // hour (e.g. "0.0010" = 0.001% per hour, verified against the 8h-normalized
  // /funding-rates snapshot) and `direction` carrying the sign ("long" → longs
  // pay → positive in our convention; "short" → negative). `timestamp` is unix
  // seconds. `value` is the per-position USD charge and is not used here.
  const start = Math.floor(since / 1000);
  const end = Math.ceil(Date.now() / 1000);
  const url = `https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=${marketId}&resolution=1h&start_timestamp=${start}&end_timestamp=${end}&count_back=500`;
  const j = (await getJson(url)) as {
    fundings?: { timestamp?: number; rate?: string; direction?: string }[];
  };
  return (j.fundings ?? []).map((x) => {
    const sign = x.direction === "short" ? -1 : 1;
    const pct = parseFloat(x.rate ?? "");
    return { t: Number(x.timestamp) * 1000, rate: (sign * pct) / 100 };
  });
}

// Typical settlement interval per venue, used only to annualize a series' final
// point (every earlier point derives its interval from the gap to the next).
const FALLBACK_INTERVAL_H: Record<string, number> = {
  [HL_VENUE]: 1,
  Binance: 8,
  Bybit: 8,
  OKX: 8,
  Aster: 8,
  edgeX: 4,
  Grvt: 4,
  Pacifica: 1,
  Extended: 1,
  Lighter: 1,
};

// Funding history for a venue+coin since `sinceMs`, annualized to APR. Returns
// null for venues with no usable public history (Variational) or on error, so
// the chart can simply omit that leg.
export async function fetchVenueFundingHistory(
  venue: string,
  coin: string,
  sinceMs: number,
): Promise<FundingPoint[] | null> {
  try {
    let raw: RawPoint[];
    switch (venue) {
      case HL_VENUE:
        raw = await histHyperliquid(coin, sinceMs);
        break;
      case "Binance":
        raw = await histBinanceLike("https://fapi.binance.com", coin, sinceMs);
        break;
      case "Aster":
        raw = await histBinanceLike("https://fapi.asterdex.com", coin, sinceMs);
        break;
      case "Bybit":
        raw = await histBybit(coin, sinceMs);
        break;
      case "OKX":
        raw = await histOkx(coin);
        break;
      case "edgeX":
        raw = await histEdgex(coin);
        break;
      case "Grvt":
        raw = await histGrvt(coin);
        break;
      case "Pacifica":
        raw = await histPacifica(coin);
        break;
      case "Extended":
        raw = await histExtended(coin, sinceMs);
        break;
      case "Lighter":
        raw = await histLighter(coin, sinceMs);
        break;
      default:
        return null; // Variational: no public history endpoint
    }
    const fallbackH = FALLBACK_INTERVAL_H[venue] ?? 8;
    // Keep one point just before the window so a step-line has a left anchor.
    const pts = annualizeSeries(raw, fallbackH);
    const inWindow = pts.filter((p) => p.t >= sinceMs);
    const before = pts.filter((p) => p.t < sinceMs).slice(-1);
    return [...before, ...inWindow];
  } catch (e) {
    console.warn(`funding history failed for ${venue}`, e);
    return null;
  }
}
