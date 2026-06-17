// Pendle Boros — the funding-rate interest-rate-swap (IRS) market. Boros lets a
// trader who holds a perp lock the venue's *floating* funding into a *fixed*
// rate until a maturity, i.e. hedge funding-cost risk (or speculate on the
// rate). For our FR tab we surface, for the same HL coin, the Boros fixed rate
// you could lock today vs the live floating funding — the prototypical "should
// I hedge my funding?" readout.
//
// All endpoints are public (no auth, no browser-UA gate). Three pieces:
//   - /v1/markets          → live snapshot: implied (fixed) APR + floating APR
//   - /v1/indicators       → udma:30, the 30d trailing average of the floating
//                            funding (matches Boros UI's "30d average")
//   - /v1/markets/ohlcv    → implied-APR candles = the fixed-rate history line
//
// Scaling traps confirmed against the live HYPE market: markets.data.midApr and
// floatingApr are FRACTIONS (0.0759 = 7.59%), ohlcv close `c` is the implied
// APR as a fraction too, and indicators `udma` is a fraction. We normalize
// everything to PERCENT here so the panel (which works in percent) can render
// directly.

const BOROS_BASE = "https://api-boros.pendle.finance/apis/v1";

// Per-market deep link. The trailing path segment is the Boros marketId — the
// same id the API returns (verified: /markets/140 = the Hyperliquid HYPE
// market, /markets/141 = the Bybit one). Linking by id keeps the deep link
// pointed at exactly the market we display, and it follows maturity rolls
// automatically since each new contract gets a fresh marketId.
const BOROS_MARKETS_BASE = "https://boros.pendle.finance/markets";
export function borosMarketUrl(marketId: number): string {
  return `${BOROS_MARKETS_BASE}/${marketId}`;
}

// Boros only lists a handful of underlyings. We match on the HL coin id
// directly (HYPE/BTC/ETH/… line up 1:1); anything else simply has no market and
// the panel renders nothing.
const BOROS_PLATFORM = "Hyperliquid";

export type BorosMarket = {
  marketId: number;
  symbol: string; // e.g. "HYPERLIQUID-HYPE-26JUN2026"
  platform: string; // "Hyperliquid"
  underlying: string; // "HYPE"
  maturityMs: number;
  daysToMaturity: number;
  // Fixed rate you lock in today (implied APR), in percent.
  impliedAprPct: number;
  // Live floating funding (annualized) the perp is paying now, in percent.
  floatingAprPct: number;
  // 30d trailing average of the floating funding, in percent. null if the
  // indicators call failed (the card just hides the "vs 30d avg" line).
  avg30dAprPct: number | null;
  vol24hUsd: number;
  oiUsd: number;
  maxLeverage: number;
  // Deep link to this exact market on the Boros app.
  url: string;
};

// One point of the fixed-rate (implied APR) history line, percent units.
export type BorosImpliedPoint = { t: number; aprPct: number };

type MarketsResponse = {
  results: Array<{
    marketId: number;
    imData?: { symbol?: string; maturity?: number };
    config?: { status?: number };
    metadata?: { underlyingSymbol?: string; maxLeverage?: number };
    platform?: { name?: string };
    data?: {
      midApr?: number;
      markApr?: number;
      floatingApr?: number;
      timeToMaturity?: number;
      volume24h?: number;
      notionalOI?: number;
    };
  }>;
};

type IndicatorsResponse = {
  results: Array<{ ts: number; udma?: Record<string, number> }>;
};

type OhlcvResponse = {
  results: Array<{ ts: number; c: number }>;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`boros ${res.status} ${url}`);
  return (await res.json()) as T;
}

// status 2 = active/tradeable market. Older expired contracts linger in the
// list with timeToMaturity 0, so we also require a live maturity.
function isLive(m: MarketsResponse["results"][number]): boolean {
  return (m.config?.status ?? 0) === 2 && (m.data?.timeToMaturity ?? 0) > 0;
}

// The Boros funding-hedge snapshot for an HL coin, or null when Boros has no
// live market for it. Picks the *front* (nearest-maturity) live Hyperliquid
// market — the same one Boros surfaces first as "available opportunity".
export async function fetchBorosMarket(
  coin: string,
): Promise<BorosMarket | null> {
  const want = coin.toUpperCase();
  const { results } = await getJson<MarketsResponse>(
    `${BOROS_BASE}/markets?limit=200`,
  );

  const live = results.filter(
    (m) =>
      isLive(m) &&
      (m.platform?.name ?? "") === BOROS_PLATFORM &&
      (m.metadata?.underlyingSymbol ?? "").toUpperCase() === want,
  );
  if (live.length === 0) return null;

  // Front contract = soonest maturity among the live markets.
  live.sort(
    (a, b) => (a.imData?.maturity ?? Infinity) - (b.imData?.maturity ?? Infinity),
  );
  const m = live[0];
  const d = m.data ?? {};
  const maturitySec = m.imData?.maturity ?? 0;

  const avg30dAprPct = await fetchAvg30dPct(m.marketId).catch(() => null);

  return {
    marketId: m.marketId,
    symbol: m.imData?.symbol ?? `${BOROS_PLATFORM}-${want}`,
    platform: m.platform?.name ?? BOROS_PLATFORM,
    underlying: m.metadata?.underlyingSymbol ?? want,
    maturityMs: maturitySec * 1000,
    daysToMaturity: (d.timeToMaturity ?? 0) / 86_400,
    impliedAprPct: (d.midApr ?? d.markApr ?? 0) * 100,
    floatingAprPct: (d.floatingApr ?? 0) * 100,
    avg30dAprPct,
    vol24hUsd: d.volume24h ?? 0,
    oiUsd: d.notionalOI ?? 0,
    maxLeverage: m.metadata?.maxLeverage ?? 0,
    url: borosMarketUrl(m.marketId),
  };
}

// Latest 30d trailing average of the floating funding (udma:30), percent units.
async function fetchAvg30dPct(marketId: number): Promise<number | null> {
  const url =
    `${BOROS_BASE}/indicators?marketId=${marketId}` +
    `&timeFrame=1d&select=${encodeURIComponent("udma:30")}`;
  const { results } = await getJson<IndicatorsResponse>(url);
  for (let i = results.length - 1; i >= 0; i--) {
    const v = results[i].udma?.["30"];
    if (typeof v === "number" && Number.isFinite(v)) return v * 100;
  }
  return null;
}

// Fixed-rate (implied APR) history line for the market's sparkline. Daily
// candles; we drop the leading zero-fill rows the API emits before the market
// started trading. Percent units.
export async function fetchBorosImpliedHistory(
  marketId: number,
): Promise<BorosImpliedPoint[]> {
  const url = `${BOROS_BASE}/markets/ohlcv?marketId=${marketId}&timeFrame=1d`;
  const { results } = await getJson<OhlcvResponse>(url);
  return results
    .filter((r) => Number.isFinite(r.c) && r.c !== 0)
    .map((r) => ({ t: r.ts * 1000, aprPct: r.c * 100 }));
}
