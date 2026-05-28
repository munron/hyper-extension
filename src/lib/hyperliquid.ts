const INFO_ENDPOINT = "https://api-ui.hyperliquid.xyz/info";

export type PerpAnnotation = {
  category?: string;
  description?: string;
  displayName?: string;
  keywords?: string[];
};

export type MetaUniverseAsset = {
  szDecimals: number;
  name: string;
  maxLeverage: number;
  marginTableId?: number;
  isDelisted?: boolean;
  onlyIsolated?: boolean;
  marginMode?: string;
  growthMode?: string;
};

export type Meta = { universe: MetaUniverseAsset[] };

export type SpotToken = {
  name: string;
  index: number;
  szDecimals?: number;
  weiDecimals?: number;
  isCanonical?: boolean;
};

export type SpotUniverseAsset = {
  name: string;
  index: number;
  tokens: [number, number];
  isCanonical?: boolean;
};

export type SpotMeta = {
  universe: SpotUniverseAsset[];
  tokens: SpotToken[];
};

export type PerpAssetCtx = {
  funding?: string;
  openInterest?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  premium?: string | null;
  oraclePx?: string;
  markPx?: string;
  midPx?: string;
};

export type SpotAssetCtx = {
  prevDayPx?: string;
  dayNtlVlm?: string;
  markPx?: string;
  midPx?: string;
  coin?: string;
  circulatingSupply?: string;
  totalSupply?: string;
  dayBaseVlm?: string;
};

export type PerpDex = {
  name: string;
  fullName: string;
  deployer?: string;
  oracleUpdater?: string | null;
  feeRecipient?: string;
  assetToStreamingOiCap?: [string, string][];
};

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(INFO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid info API ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchPerpAnnotation(coin: string): Promise<PerpAnnotation | null> {
  return postInfo<PerpAnnotation | null>({ coin, type: "perpAnnotation" });
}

export type PerpConciseAnnotationEntry = [string, PerpAnnotation];

export async function fetchPerpConciseAnnotations(): Promise<PerpConciseAnnotationEntry[]> {
  return postInfo<PerpConciseAnnotationEntry[]>({ type: "perpConciseAnnotations" });
}

export async function fetchMeta(dex?: string): Promise<Meta> {
  return postInfo<Meta>(dex ? { type: "meta", dex } : { type: "meta" });
}

export async function fetchSpotMeta(): Promise<SpotMeta> {
  return postInfo<SpotMeta>({ type: "spotMeta" });
}

export async function fetchMetaAndAssetCtxs(): Promise<[Meta, PerpAssetCtx[]]> {
  return postInfo<[Meta, PerpAssetCtx[]]>({ type: "metaAndAssetCtxs" });
}

// Live (current) funding rate for a coin, annualized to APR %. Unlike funding
// *history* (settled hourly samples), this is the rate accruing right now from
// metaAndAssetCtxs, so it moves continuously — suitable for a real-time "now"
// readout. Returns null if the coin isn't found or has no funding.
export async function fetchCurrentFundingApr(coin: string): Promise<number | null> {
  const [meta, ctxs] = await fetchMetaAndAssetCtxs();
  const i = meta.universe.findIndex((u) => u.name === coin);
  if (i < 0) return null;
  const f = ctxs[i]?.funding;
  if (f == null) return null;
  const apr = parseFloat(f) * 24 * 365 * 100; // HL funding is hourly
  return Number.isFinite(apr) ? apr : null;
}

export async function fetchSpotMetaAndAssetCtxs(): Promise<[SpotMeta, SpotAssetCtx[]]> {
  return postInfo<[SpotMeta, SpotAssetCtx[]]>({ type: "spotMetaAndAssetCtxs" });
}

export async function fetchPerpDexs(): Promise<(PerpDex | null)[]> {
  return postInfo<(PerpDex | null)[]>({ type: "perpDexs" });
}

// Predicted funding across venues, straight from Hyperliquid. Each coin maps to
// a list of [venueCode, info] pairs where venueCode is e.g. "HlPerp", "BinPerp",
// "BybitPerp". `fundingRate` is the per-interval rate (a decimal string) and
// `fundingIntervalHours` says how often it's charged — so we can annualize each
// venue correctly despite HL being hourly and the CEXs being 8h.
export type PredictedVenueFunding = {
  fundingRate: string;
  nextFundingTime: number; // ms
  fundingIntervalHours: number;
};
export type PredictedFundingEntry = [
  string,
  [string, PredictedVenueFunding | null][],
];

export async function fetchPredictedFundings(): Promise<PredictedFundingEntry[]> {
  return postInfo<PredictedFundingEntry[]>({ type: "predictedFundings" });
}

export type FundingHistoryEntry = {
  coin: string;
  // Hourly funding rate as a decimal string (e.g. "0.0000125"). Hyperliquid
  // charges funding every hour, so APR = rate * 24 * 365.
  fundingRate: string;
  premium: string;
  time: number; // ms
};

export async function fetchFundingHistory(
  coin: string,
  startTime: number,
  endTime: number,
): Promise<FundingHistoryEntry[]> {
  return postInfo<FundingHistoryEntry[]>({
    type: "fundingHistory",
    coin,
    startTime,
    endTime,
  });
}

// fundingHistory caps at 500 entries and returns the OLDEST 500 from
// startTime, so a >500h (>~21d) request silently drops the most recent
// data. Page forward from the last timestamp until we reach endTime.
const FUNDING_PAGE_CAP = 500;

export async function fetchFundingHistoryRange(
  coin: string,
  startTime: number,
  endTime: number,
): Promise<FundingHistoryEntry[]> {
  const all: FundingHistoryEntry[] = [];
  let cursor = startTime;
  for (let i = 0; i < 12; i++) {
    const chunk = await fetchFundingHistory(coin, cursor, endTime);
    if (chunk.length === 0) break;
    let appended = 0;
    for (const e of chunk) {
      if (all.length === 0 || e.time > all[all.length - 1].time) {
        all.push(e);
        appended++;
      }
    }
    // Fewer than a full page → we've reached the end. No new rows → stop
    // (guards against a non-advancing cursor).
    if (chunk.length < FUNDING_PAGE_CAP || appended === 0) break;
    cursor = chunk[chunk.length - 1].time + 1;
  }
  return all;
}

export type Candle = {
  t: number; // open time (ms)
  T: number; // close time (ms)
  s: string; // coin
  i: string; // interval
  o: string;
  c: string; // close
  h: string;
  l: string;
  v: string;
  n: number;
};

export async function fetchCandles(
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
): Promise<Candle[]> {
  return postInfo<Candle[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });
}
