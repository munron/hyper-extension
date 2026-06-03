// Polymarket prediction-market signal for the open crypto coin ("Predict" tab).
//
// Design intent (trader-first): surface information a trader does NOT already
// get from the chart/orderbook, and lead with what is MOVING. So instead of the
// near-50/50 5-min up/down noise, we show:
//
//   1. PRICE LADDER — the crowd-implied probability that the coin trades at
//      each price level by a horizon (the `what-price-will-<coin>-hit-*` events,
//      e.g. BTC's monthly ladder at ~$3.7M volume). This is the market's
//      probability distribution over price, with each strike's 24h shift, which
//      directly informs targets / sizing and actually changes on news.
//   2. MOVERS — related event/catalyst markets sorted by 24h probability move,
//      so a jump flags "something happened" for this coin/ecosystem.
//
// All keyless Gamma API; CORS is bypassed by the extension host_permissions.

const GAMMA = "https://gamma-api.polymarket.com";

// Full names search better than tickers on Polymarket's fuzzy search.
const COIN_FULL_NAME: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
  DOGE: "Dogecoin",
  HYPE: "Hyperliquid",
  BNB: "BNB",
  ADA: "Cardano",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  LTC: "Litecoin",
  SUI: "Sui",
};

/** Crypto coins get the Predict tab; real-world-asset perps don't. */
export function isCryptoCoin(category: string | null): boolean {
  const c = (category ?? "").toLowerCase();
  return !["stocks", "commodities", "fx", "indices", "preipo"].includes(c);
}

function searchName(coin: string, displayName: string): string {
  return COIN_FULL_NAME[coin.toUpperCase()] ?? displayName ?? coin;
}

export type LadderRung = {
  label: string; // e.g. "≥ $90,000"
  strike: number; // 90000 (for sorting)
  yesPct: number; // 0..100
  change24hPts: number | null; // probability points moved in 24h
  volumeUsd: number;
};

export type PriceLadder = {
  title: string;
  url: string;
  volumeUsd: number;
  rungs: LadderRung[];
};

export type Catalyst = {
  slug: string;
  question: string;
  yesPct: number | null;
  change24hPts: number | null;
  volumeUsd: number;
  url: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function parseStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

type GammaMarket = {
  question?: string;
  groupItemTitle?: string;
  outcomes?: string;
  outcomePrices?: string;
  oneDayPriceChange?: number | string | null;
  volume?: number | string;
};

type GammaEvent = {
  slug: string;
  title: string;
  active?: boolean;
  closed?: boolean;
  volume?: number | string;
  markets?: GammaMarket[];
};
type SearchResp = { events?: GammaEvent[] };

function yesPctOf(m: GammaMarket): number | null {
  const outs = parseStrArray(m.outcomes);
  const prices = parseStrArray(m.outcomePrices);
  const yesIdx = outs.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIdx < 0 || prices[yesIdx] == null) return null;
  return num(prices[yesIdx]) * 100;
}

function change24hPtsOf(m: GammaMarket): number | null {
  if (m.oneDayPriceChange == null) return null;
  const v = num(m.oneDayPriceChange);
  return v * 100; // probability fraction → percentage points
}

// "↑ 90,000" / "↓ 57,500" / "$120k" → { strike, label }
function parseStrike(title: string): { strike: number; label: string } | null {
  const cleaned = title.replace(/,/g, "");
  const km = cleaned.match(/\$?\s*([\d.]+)\s*([kKmM])/);
  let strike: number;
  if (km) {
    strike = parseFloat(km[1]) * (/[mM]/.test(km[2]) ? 1_000_000 : 1_000);
  } else {
    const m = cleaned.match(/([\d.]+)/);
    if (!m) return null;
    strike = parseFloat(m[1]);
  }
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const up = title.includes("↑") || /above|reach|hit|\bover\b/i.test(title);
  const arrow = title.includes("↓") ? "≤" : up ? "≥" : "";
  // Sub-dollar coins (DOGE, XRP) need decimals or every strike collapses to $0/$1.
  const digits = strike >= 1000 ? 0 : strike >= 1 ? 2 : 4;
  const money = strike.toLocaleString("en-US", { maximumFractionDigits: digits });
  return { strike, label: `${arrow} $${money}`.trim() };
}

function looksLikeLadder(e: GammaEvent): boolean {
  const slug = e.slug.toLowerCase();
  if (!/price|hit|reach/.test(slug)) return false;
  const mk = e.markets ?? [];
  // A real ladder has several strike-titled sub-markets.
  return mk.filter((m) => m.groupItemTitle && parseStrike(m.groupItemTitle)).length >= 3;
}

const MONTHS =
  /(january|february|march|april|may|june|july|august|september|october|november|december)/;

// "...-hit-in-2026" (no month, no day) is a year-long touch-anytime market —
// a noisy two-sided distribution far from spot. Deprioritize it in favor of
// near-term ladders (monthly / daily) that cluster around the current price.
function isYearlyLadder(e: GammaEvent): boolean {
  const s = e.slug.toLowerCase();
  return /20\d\d/.test(s) && !MONTHS.test(s) && !/-on-/.test(s);
}

/** The most-liquid active price-target ladder for the coin, or null. */
export async function fetchPriceLadder(
  coin: string,
  displayName: string,
): Promise<PriceLadder | null> {
  const q = `${searchName(coin, displayName)} price`;
  const data = await getJson<SearchResp>(
    `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=12&events_status=active`,
  );
  // Prefer the ladder that's most informative AROUND spot — most rungs in the
  // live transition band (15-85%) — over the one with the biggest headline
  // volume (often a far-dated ladder pinned at 1-2%). Skip near-dead events.
  const transitionCount = (e: GammaEvent): number =>
    (e.markets ?? []).filter((m) => {
      const y = yesPctOf(m);
      return y != null && y >= 15 && y <= 85 && m.groupItemTitle;
    }).length;
  const VOL_FLOOR = 10_000; // avoid thin dailies whose "moves" are just noise
  const all = (data.events ?? []).filter(
    (e) => e.active && !e.closed && looksLikeLadder(e),
  );
  const liquid = all.filter((e) => num(e.volume) >= VOL_FLOOR);
  // Near-term ladders first (year-long ones last), then the one with the most
  // live transition rungs, then volume.
  const candidates = (liquid.length ? liquid : all).sort(
    (a, b) =>
      Number(isYearlyLadder(a)) - Number(isYearlyLadder(b)) ||
      transitionCount(b) - transitionCount(a) ||
      num(b.volume) - num(a.volume),
  );
  const ev = candidates[0];
  if (!ev) return null;

  const rungs: LadderRung[] = [];
  for (const m of ev.markets ?? []) {
    const title = m.groupItemTitle ?? "";
    const parsed = parseStrike(title);
    const yes = yesPctOf(m);
    if (!parsed || yes == null) continue;
    rungs.push({
      label: parsed.label,
      strike: parsed.strike,
      yesPct: yes,
      change24hPts: change24hPtsOf(m),
      volumeUsd: num(m.volume),
    });
  }
  // Show the live band — strikes where the crowd is actually uncertain — not
  // the far-OTM tail pinned near 0/100%. With a near-term ladder these cluster
  // contiguously around spot. Highest strike first; cap for height.
  const MAX = 14;
  const sorted = rungs.slice().sort((a, b) => b.strike - a.strike);
  const live = sorted.filter((r) => r.yesPct >= 2 && r.yesPct <= 98);
  const shown = (live.length >= 3 ? live : sorted).slice(0, MAX);
  if (!shown.length) return null;

  return {
    title: ev.title,
    url: `https://polymarket.com/event/${ev.slug}`,
    volumeUsd: num(ev.volume),
    rungs: shown,
  };
}

/** Related catalyst markets, sorted by 24h move (biggest movers first). */
export async function fetchCatalysts(
  coin: string,
  displayName: string,
  excludeSlug: string | null = null,
  limit = 6,
): Promise<Catalyst[]> {
  const name = searchName(coin, displayName);
  const data = await getJson<SearchResp>(
    `${GAMMA}/public-search?q=${encodeURIComponent(name)}&limit_per_type=14&events_status=active`,
  );
  const events = (data.events ?? []).filter(
    (e) => e.active && !e.closed && e.slug !== excludeSlug,
  );

  const out: Catalyst[] = [];
  for (const e of events) {
    if (looksLikeLadder(e)) continue; // ladders are shown separately
    const mk = e.markets ?? [];
    // Representative sub-market: the biggest 24h mover, else most-traded.
    const top = mk
      .slice()
      .sort((a, b) => {
        const ca = Math.abs(change24hPtsOf(a) ?? 0);
        const cb = Math.abs(change24hPtsOf(b) ?? 0);
        return cb - ca || num(b.volume) - num(a.volume);
      })[0];
    if (!top) continue;
    out.push({
      slug: e.slug,
      question: top.question ?? e.title,
      yesPct: yesPctOf(top),
      change24hPts: change24hPtsOf(top),
      volumeUsd: num(e.volume),
      url: `https://polymarket.com/event/${e.slug}`,
    });
  }

  return out
    .sort(
      (a, b) =>
        Math.abs(b.change24hPts ?? 0) - Math.abs(a.change24hPts ?? 0) ||
        b.volumeUsd - a.volumeUsd,
    )
    .slice(0, limit);
}
