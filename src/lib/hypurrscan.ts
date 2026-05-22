import { getAssetCtxs, priceForAssetId } from "./prices";

const BASE = "https://api.hypurrscan.io";

type RawTwap = {
  time: number;
  user: string;
  action: {
    type: "twapOrder";
    twap: { a: number; b: boolean; s: string; r: boolean; m: number; t: boolean };
  };
  hash: string;
  error: string | null;
  ended?: string;
};

export type Market = "spot" | "perp";

export type TwapEntry = {
  market: Market;
  isBuy: boolean;
  totalSize: number;
  durationMs: number;
  startedAt: number;
  endsAt: number;
  progress: number; // 0..1
  remainingSize: number;
  remainingUsd: number;
  totalUsd: number;
  price: number; // 0 if unknown
  reduceOnly: boolean;
  randomize: boolean;
  user: string;
  hash: string;
  assetId: number;
};

const TWAP_CACHE_TTL_MS = 30_000;

let twapCache: { fetchedAt: number; raw: RawTwap[] } | null = null;
let twapInflight: Promise<RawTwap[]> | null = null;

async function fetchAllRawTwaps(): Promise<RawTwap[]> {
  if (twapCache && Date.now() - twapCache.fetchedAt < TWAP_CACHE_TTL_MS) {
    return twapCache.raw;
  }
  if (twapInflight) return twapInflight;
  twapInflight = (async () => {
    try {
      const res = await fetch(`${BASE}/twap/*`);
      if (!res.ok) {
        throw new Error(`hypurrscan /twap/* ${res.status} ${res.statusText}`);
      }
      const raw = (await res.json()) as RawTwap[];
      twapCache = { fetchedAt: Date.now(), raw };
      return raw;
    } finally {
      twapInflight = null;
    }
  })();
  return twapInflight;
}

export function invalidateTwapCache(): void {
  twapCache = null;
}

export async function fetchActiveTwaps(
  perpAssetId: number | null,
  spotAssetIds: number[],
  now: number = Date.now(),
): Promise<TwapEntry[]> {
  if (perpAssetId === null && spotAssetIds.length === 0) return [];
  const [raw, ctxs] = await Promise.all([fetchAllRawTwaps(), getAssetCtxs()]);
  const spotSet = new Set(spotAssetIds);
  const entries: TwapEntry[] = [];
  for (const r of raw) {
    if (r.ended) continue;
    const t = r.action.twap;
    const isSpotMatch = spotSet.has(t.a);
    const isPerpMatch = perpAssetId !== null && t.a === perpAssetId;
    if (!isSpotMatch && !isPerpMatch) continue;
    const totalSize = parseFloat(t.s);
    if (!Number.isFinite(totalSize) || totalSize <= 0) continue;
    const durationMs = t.m * 60_000;
    const endsAt = r.time + durationMs;
    const progress = Math.max(0, Math.min(1, (now - r.time) / durationMs));
    if (progress >= 1) continue;
    const remainingSize = totalSize * (1 - progress);
    const price = priceForAssetId(ctxs, t.a);
    entries.push({
      market: isSpotMatch ? "spot" : "perp",
      isBuy: t.b,
      totalSize,
      durationMs,
      startedAt: r.time,
      endsAt,
      progress,
      remainingSize,
      remainingUsd: remainingSize * price,
      totalUsd: totalSize * price,
      price,
      reduceOnly: t.r,
      randomize: t.t,
      user: r.user,
      hash: r.hash,
      assetId: t.a,
    });
  }
  return entries;
}
