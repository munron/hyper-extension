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
  fetchMetaAndAssetCtxs,
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
  // Mark/index price in USD, when the venue's response exposes it. null when
  // the venue's funding endpoint doesn't include a price and we haven't wired
  // a separate quote fetch. UI shows "—" for null.
  markPx: number | null;
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
// Symbol translation across venues. Crypto coins almost always share a
// ticker, but commodities / FX / regional stocks diverge by venue convention.
// Keys are the bare HL ticker (after stripping the "<dex>:" prefix). Only
// add a row where the venue's symbol *differs* from HL's bare ticker —
// anything that matches natively (AAPL, NVDA, BRENTOIL on Lighter, etc.)
// needs no entry. Most fetchers append a suffix themselves (Binance ".USDT",
// OKX "-USDT-SWAP", Grvt "_USDT_Perp", edgeX "USD", Extended "-USD"), so
// values here are the venue's *base* symbol, not the full pair.
//
// Sources verified by enumerating each venue's instrument list (Binance
// /fapi/v1/exchangeInfo, Bybit /v5/market/instruments-info, OKX
// /public/instruments, Aster, Pacifica /api/v1/info, Extended
// /api/v1/info/markets, edgeX getMetaData, Grvt /full/v1/instruments,
// Variational /metadata/stats, Lighter /orderBooks).
const VENUE_ALIASES: Record<string, Partial<Record<string, string>>> = {
  // WTI crude — HL's futures ticker "CL" (displayName "WTIOIL"). Most venues
  // also use "CL"; Lighter / Extended rename to "WTI".
  CL: {
    Lighter: "WTI",
    Extended: "WTI",
  },
  // Brent crude — HL uses commodity name "BRENTOIL"; CEX + Grvt use the
  // futures ticker "BZ". Lighter keeps "BRENTOIL". Extended uses the IPE
  // futures code "XBR". Other DEXs don't list it.
  BRENTOIL: {
    Binance: "BZ",
    Aster: "BZ",
    Bybit: "BZ",
    OKX: "BZ",
    Grvt: "BZ",
    Extended: "XBR",
  },
  // Copper — Binance / Grvt / Variational keep "COPPER" but the rest use the
  // ISO base-metal code "XCU".
  COPPER: {
    OKX: "XCU",
    Aster: "XCU",
    Lighter: "XCU",
    Extended: "XCU",
  },
  // Platinum — universally the ISO code "XPT" off HL's "PLATINUM" ticker.
  PLATINUM: {
    Binance: "XPT",
    OKX: "XPT",
    Aster: "XPT",
    Grvt: "XPT",
    Variational: "XPT",
    Lighter: "XPT",
    Extended: "XPT",
  },
  // Palladium — ISO code "XPD". Bybit / Aster / Extended don't list it.
  PALLADIUM: {
    Binance: "XPD",
    OKX: "XPD",
    Grvt: "XPD",
    Variational: "XPD",
    Lighter: "XPD",
  },
  // Gold — HL uses "GOLD"; virtually everyone else uses the ISO bullion
  // code "XAU". (edgeX has no spot gold — only XAUT/Tether Gold token.)
  GOLD: {
    Lighter: "XAU",
    Binance: "XAU",
    Aster: "XAU",
    Bybit: "XAU",
    OKX: "XAU",
    Pacifica: "XAU",
    Grvt: "XAU",
    Variational: "XAU",
    Extended: "XAU",
  },
  // Silver — same pattern as gold, with ISO code "XAG". edgeX is the odd
  // one out (keeps "SILVER"), so no edgeX entry needed.
  SILVER: {
    Lighter: "XAG",
    Binance: "XAG",
    Aster: "XAG",
    Bybit: "XAG",
    OKX: "XAG",
    Pacifica: "XAG",
    Grvt: "XAG",
    Variational: "XAG",
    Extended: "XAG",
  },
  // Natural gas — OKX uses futures ticker "NG"; Extended uses "XNG". All
  // other venues match HL's "NATGAS".
  NATGAS: {
    OKX: "NG",
    Extended: "XNG",
  },
  // FX — HL stores the foreign currency; Lighter / Pacifica quote a pair.
  // edgeX auto-appends "USD" via its lookup, so bare HL ticker already
  // matches (e.g. "EUR" → "EURUSD"). Extended markets are dash-separated
  // ("EUR-USD"), so the bare HL ticker also works there for EUR/GBP.
  EUR: {
    Lighter: "EURUSD",
    Pacifica: "EURUSD",
  },
  GBP: {
    Lighter: "GBPUSD",
  },
  JPY: {
    Lighter: "USDJPY",
    Pacifica: "USDJPY",
    Extended: "USDJPY",
  },
  KRW: {
    Lighter: "USDKRW",
  },
  // US stocks on Extended carry a "_24_5" suffix (24h × 5 days/wk schedule).
  // Other venues use the bare ticker, matching HL natively.
  AAPL: { Extended: "AAPL_24_5" },
  AMD: { Extended: "AMD_24_5" },
  AMZN: { Extended: "AMZN_24_5" },
  BABA: { Extended: "BABA_24_5" },
  COIN: { Extended: "COIN_24_5" },
  CRCL: { Extended: "CRCL_24_5" },
  EWY: { Extended: "EWY_24_5" },
  GOOG: { Extended: "GOOG_24_5" },
  HOOD: { Extended: "HOOD_24_5" },
  INTC: { Extended: "INTC_24_5" },
  META: { Extended: "META_24_5" },
  MSFT: { Extended: "MSFT_24_5" },
  MSTR: { Extended: "MSTR_24_5" },
  MU: { Extended: "MU_24_5" },
  NVDA: { Extended: "NVDA_24_5" },
  ORCL: { Extended: "ORCL_24_5" },
  PLTR: { Extended: "PLTR_24_5" },
  SNDK: { Extended: "SNDK_24_5" },
  TSLA: { Extended: "TSLA_24_5" },
  // Regional stocks renamed on Lighter ("<NAME>USD" suffix for non-US).
  HYUNDAI: { Lighter: "HYUNDAIUSD" },
  SMSN: { Lighter: "SAMSUNGUSD" },
  SKHX: { Lighter: "SKHYNIXUSD" },
};

// Strip HL's sub-DEX prefix and apply per-venue rename. HL itself keeps the
// full prefixed name since its endpoints require it; everyone else sees the
// translated bare symbol (or the original symbol when no alias is defined).
export function venueSymbol(venue: string, coin: string): string {
  if (venue === HL_VENUE) return coin;
  const colon = coin.indexOf(":");
  const base = colon >= 0 ? coin.slice(colon + 1) : coin;
  return VENUE_ALIASES[base]?.[venue] ?? base;
}

export function venueTradeUrl(venue: string, coin: string): string | null {
  const c = venueSymbol(venue, coin).toUpperCase();
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
    case "edgeX": {
      // v2 (USDC perp) markets live under /perpetuals/<sym>USDC; v1 (USD) ones
      // under /trade/<sym>USD. Prefer the cached map's verdict if available so
      // newly-listed equity perps (MU, etc.) point at the right page.
      const found = edgexMapSync ? lookupEdgexContract(edgexMapSync, c) : null;
      if (found?.contract.version === "v2") {
        return `https://pro.edgex.exchange/perpetuals/${found.name}`;
      }
      return `https://pro.edgex.exchange/trade/${c}USD`;
    }
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

// Best-effort price parse from venue payloads (fields are typed as
// `string | number | undefined` across venues). Returns null on garbage.
function parseOptionalNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
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

// Direct HL funding read for coins absent from predictedFundings (sub-DEX
// commodities/stocks/FX live in their own per-dex universes). HL settles
// hourly, so the rate from assetCtxs is per-1h decimal; nextFundingTime
// is the top of the next hour.
async function fetchHyperliquidDirect(coin: string): Promise<VenueResult> {
  const venue = HL_VENUE;
  const kind: VenueKind = "DEX";
  try {
    const colon = coin.indexOf(":");
    const dex = colon > 0 ? coin.slice(0, colon) : undefined;
    const [meta, ctxs] = await fetchMetaAndAssetCtxs(dex);
    const i = meta.universe.findIndex((u) => u.name === coin);
    if (i < 0) return unavailable(venue, kind, "not listed");
    const f = ctxs[i]?.funding;
    if (f == null) return unavailable(venue, kind, "no data");
    const intervalHours = 1;
    const apr = toApr(parseFloat(f), intervalHours);
    if (!Number.isFinite(apr)) return unavailable(venue, kind, "no data");
    const markPx = parseOptionalNumber(ctxs[i]?.markPx);
    return {
      venue,
      kind,
      aprPct: apr,
      intervalHours,
      nextFundingMs: nextTopOfHour(),
      markPx,
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

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
    // predictedFundings doesn't expose a mark price; UI shows "—".
    markPx: null,
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
        markPrice?: string;
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
      markPx: parseOptionalNumber(pi.markPrice),
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
        result?: { list?: { fundingRate?: string; nextFundingTime?: string; markPrice?: string }[] };
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
      markPx: parseOptionalNumber(t.markPrice),
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
    const instId = `${coin}-USDT-SWAP`;
    const [funding, mark] = await Promise.all([
      getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`) as Promise<{
        data?: Record<string, string>[];
      }>,
      // OKX's funding endpoint omits price; mark-price is one extra call.
      getJson(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${instId}`).catch(
        () => null,
      ) as Promise<{ data?: { markPx?: string }[] } | null>,
    ]);
    const d = funding.data?.[0];
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
      markPx: parseOptionalNumber(mark?.data?.[0]?.markPx),
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
        markPrice?: string;
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
      markPx: parseOptionalNumber(j.markPrice),
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
    // funding-rates carries the rate; exchangeStats carries per-market
    // last_trade_price. /orderBooks looks promising at first glance but only
    // ships market *metadata* (decimals, fees) — no price field. Fetched in
    // parallel so the panel sees one round-trip.
    const [j, stats] = await Promise.all([
      getJson("https://mainnet.zklighter.elliot.ai/api/v1/funding-rates") as Promise<{
        funding_rates?: { symbol: string; exchange: string; rate: number }[];
      }>,
      getJson("https://mainnet.zklighter.elliot.ai/api/v1/exchangeStats").catch(
        () => null,
      ) as Promise<{
        order_book_stats?: { symbol?: string; last_trade_price?: number | string }[];
      } | null>,
    ]);
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
    const statRow = stats?.order_book_stats?.find((s) => s.symbol === coin);
    return {
      venue,
      kind,
      aprPct: toApr(Number(row.rate), intervalHours),
      intervalHours,
      nextFundingMs: null,
      markPx: parseOptionalNumber(statRow?.last_trade_price),
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
      data?: {
        symbol: string;
        funding_rate?: string;
        next_funding_rate?: string;
        mark_price?: string;
        mark?: string;
        mid_price?: string;
        mid?: string;
      }[];
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
      markPx: parseOptionalNumber(
        row?.mark_price ?? row?.mark ?? row?.mid_price ?? row?.mid,
      ),
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
        marketStats?: {
          fundingRate?: string;
          nextFundingRate?: number;
          markPrice?: string;
          indexPrice?: string;
          lastPrice?: string;
        };
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
      markPx: parseOptionalNumber(ms.markPrice ?? ms.indexPrice ?? ms.lastPrice),
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- edgeX (interval read live; often 4h) ------------------------------------

// edgeX runs two parallel exchanges: the v1 "USD" markets (BTCUSD, NVDAUSD)
// and a newer v2 "USDC" book (BTCUSDC, MUUSDC) hosted on edgex-prod-v2 with a
// different API prefix. New listings — especially equity perps that don't yet
// have a v1 counterpart — only show up on v2, so we have to consult both.
type EdgexContract = {
  contractId: string;
  // Which API surface to query for funding/quote. v1 endpoints don't accept v2
  // contract IDs and vice versa.
  version: "v1" | "v2";
};

let edgexMapPromise: Promise<Map<string, EdgexContract>> | null = null;
// Synchronous mirror of the resolved map, populated as a side effect once the
// promise settles. Lets the synchronous `venueTradeUrl` route v2-only coins
// (USDC perp markets like MUUSDC) to the right deep-link path — by the time a
// user clicks the launch arrow, the venues panel has already loaded so the
// map is reliably populated. Returns null before first resolution.
let edgexMapSync: Map<string, EdgexContract> | null = null;
function getEdgexContractMap(): Promise<Map<string, EdgexContract>> {
  if (!edgexMapPromise) {
    edgexMapPromise = (async () => {
      const [v1, v2] = await Promise.all([
        getJson("https://pro.edgex.exchange/api/v1/public/meta/getMetaData") as Promise<{
          data?: { contractList?: { contractName?: string; contractId?: string }[] };
        }>,
        getJson(
          "https://edgex-prod-v2.edgex.exchange/api/v2/public/meta/getMetaData",
        ).catch(() => null) as Promise<{
          data?: { contractList?: { contractName?: string; contractId?: string }[] };
        } | null>,
      ]);
      const map = new Map<string, EdgexContract>();
      for (const c of v1.data?.contractList ?? []) {
        if (c.contractName && c.contractId) {
          map.set(c.contractName, { contractId: c.contractId, version: "v1" });
        }
      }
      // v2 second so a duplicate name (shouldn't happen — different suffixes)
      // would resolve to v2. Practical effect is just adding the USDC-quoted
      // markets alongside the existing USD ones.
      for (const c of v2?.data?.contractList ?? []) {
        if (c.contractName && c.contractId) {
          map.set(c.contractName, { contractId: c.contractId, version: "v2" });
        }
      }
      edgexMapSync = map;
      return map;
    })().catch((e) => {
      edgexMapPromise = null; // allow a retry on the next load
      throw e;
    });
  }
  return edgexMapPromise;
}

// Resolve coin → contract by trying the v1 "USD" name first, then the v2 "USDC"
// name. Many crypto coins exist on both; stocks like MU live only on v2.
function lookupEdgexContract(
  map: Map<string, EdgexContract>,
  coin: string,
): { name: string; contract: EdgexContract } | null {
  const v1 = map.get(`${coin}USD`);
  if (v1) return { name: `${coin}USD`, contract: v1 };
  const v2 = map.get(`${coin}USDC`);
  if (v2) return { name: `${coin}USDC`, contract: v2 };
  return null;
}

// Per-version API roots. v2 funding responses already carry markPrice, so we
// skip the separate ticker fetch for v2 contracts.
const EDGEX_API_ROOT: Record<EdgexContract["version"], string> = {
  v1: "https://pro.edgex.exchange/api/v1",
  v2: "https://edgex-prod-v2.edgex.exchange/api/v2",
};

async function fetchEdgex(coin: string): Promise<VenueResult> {
  const venue = "edgeX";
  const kind: VenueKind = "DEX";
  try {
    const found = lookupEdgexContract(await getEdgexContractMap(), coin);
    if (!found) return unavailable(venue, kind, "not listed");
    const { contract } = found;
    const root = EDGEX_API_ROOT[contract.version];
    const [j, quote] = await Promise.all([
      getJson(
        `${root}/public/funding/getLatestFundingRate?contractId=${contract.contractId}`,
      ) as Promise<{
        data?: {
          fundingRate?: string;
          forecastFundingRate?: string;
          fundingTime?: string;
          fundingRateIntervalMin?: string;
          markPrice?: string;
          oraclePrice?: string;
          indexPrice?: string;
        }[];
      }>,
      // v1 funding response omits price → fall back to the 24h ticker.
      // v2 funding already includes markPrice, so this side fetch is unused.
      contract.version === "v1"
        ? (getJson(
            `${root}/public/quote/getTicker24HourQuote?contractId=${contract.contractId}`,
          ).catch(() => null) as Promise<{
            data?: { lastPrice?: string; markPrice?: string; indexPrice?: string }[];
          } | null>)
        : Promise.resolve(null),
    ]);
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
      markPx: parseOptionalNumber(
        // v2 path: read directly from the funding response.
        d?.markPrice ??
          d?.oraclePrice ??
          d?.indexPrice ??
          // v1 path: ticker fallback.
          quote?.data?.[0]?.markPrice ??
          quote?.data?.[0]?.indexPrice ??
          quote?.data?.[0]?.lastPrice,
      ),
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
      result?: {
        funding_rate?: string;
        next_funding_time?: string;
        mark_price?: string;
        index_price?: string;
        last_price?: string;
      };
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
      markPx: parseOptionalNumber(
        j.result?.mark_price ?? j.result?.index_price ?? j.result?.last_price,
      ),
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
      listings?: {
        ticker: string;
        funding_rate?: string;
        funding_interval_s?: number;
        mark_price?: string;
        index_price?: string;
        last_price?: string;
      }[];
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
      markPx: parseOptionalNumber(
        row.mark_price ?? row.index_price ?? row.last_price,
      ),
      available: true,
    };
  } catch {
    return unavailable(venue, kind, "n/a");
  }
}

// --- aggregate ---------------------------------------------------------------

export async function fetchVenueFundings(coin: string): Promise<VenueResult[]> {
  const [predicted, hlDirect, binance, bybit, okx, aster, lighter, pacifica, extended, edgex, grvt, variational] =
    await Promise.all([
      fetchPredictedFundings().catch(() => null as PredictedFundingEntry[] | null),
      // Direct read gives us HL's markPx (predicted only carries FR), so we
      // always call it — predicted is now only a fallback if direct fails.
      fetchHyperliquidDirect(coin),
      fetchBinance(venueSymbol("Binance", coin)),
      fetchBybit(venueSymbol("Bybit", coin)),
      fetchOkx(venueSymbol("OKX", coin)),
      fetchAster(venueSymbol("Aster", coin)),
      fetchLighter(venueSymbol("Lighter", coin)),
      fetchPacifica(venueSymbol("Pacifica", coin)),
      fetchExtended(venueSymbol("Extended", coin)),
      fetchEdgex(venueSymbol("edgeX", coin)),
      fetchGrvt(venueSymbol("Grvt", coin)),
      fetchVariational(venueSymbol("Variational", coin)),
    ]);

  const pairs = predicted?.find(([c]) => c === coin)?.[1];
  const byName = new Map<string, VenueResult>();
  // Prefer the direct read (carries markPx); fall back to predicted (FR-only)
  // if direct fails for some reason. Sub-DEX coins (xyz:BRENTOIL, flx:…) only
  // resolve via direct anyway.
  byName.set(HL_VENUE, preferAvailable(hlDirect, fromPredicted(pairs, "HlPerp", HL_VENUE, "DEX")));
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
  const found = lookupEdgexContract(await getEdgexContractMap(), coin);
  if (!found) return [];
  const root = EDGEX_API_ROOT[found.contract.version];
  // Without filterSettlementFundingRate the page returns a minute-by-minute
  // forecast snapshot (all sharing one period boundary); the filter collapses it
  // to one SETTLED rate per period (clean 4h spacing).
  const j = (await getJson(
    `${root}/public/funding/getFundingRatePage?contractId=${found.contract.contractId}&size=100&filterSettlementFundingRate=true`,
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
    // Translate the symbol once at entry: HL stays prefixed (e.g. "xyz:CL")
    // since its API requires it; other venues see their own bare symbol
    // (e.g. Lighter "WTI") via the alias table.
    const c = venueSymbol(venue, coin);
    let raw: RawPoint[];
    switch (venue) {
      case HL_VENUE:
        raw = await histHyperliquid(c, sinceMs);
        break;
      case "Binance":
        raw = await histBinanceLike("https://fapi.binance.com", c, sinceMs);
        break;
      case "Aster":
        raw = await histBinanceLike("https://fapi.asterdex.com", c, sinceMs);
        break;
      case "Bybit":
        raw = await histBybit(c, sinceMs);
        break;
      case "OKX":
        raw = await histOkx(c);
        break;
      case "edgeX":
        raw = await histEdgex(c);
        break;
      case "Grvt":
        raw = await histGrvt(c);
        break;
      case "Pacifica":
        raw = await histPacifica(c);
        break;
      case "Extended":
        raw = await histExtended(c, sinceMs);
        break;
      case "Lighter":
        raw = await histLighter(c, sinceMs);
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
