import {
  fetchMetaAndAssetCtxs,
  fetchSpotMetaAndAssetCtxs,
  type PerpAssetCtx,
  type SpotAssetCtx,
} from "./hyperliquid";

const CTX_CACHE_TTL_MS = 15_000;

export type AssetCtxs = {
  fetchedAt: number;
  perp: PerpAssetCtx[];
  spot: SpotAssetCtx[];
};

let ctxCache: AssetCtxs | null = null;
let ctxInflight: Promise<AssetCtxs> | null = null;

export async function getAssetCtxs(): Promise<AssetCtxs> {
  if (ctxCache && Date.now() - ctxCache.fetchedAt < CTX_CACHE_TTL_MS) {
    return ctxCache;
  }
  if (ctxInflight) return ctxInflight;
  ctxInflight = (async () => {
    try {
      const [[, perp], [, spot]] = await Promise.all([
        fetchMetaAndAssetCtxs(),
        fetchSpotMetaAndAssetCtxs(),
      ]);
      const next: AssetCtxs = { fetchedAt: Date.now(), perp, spot };
      ctxCache = next;
      return next;
    } finally {
      ctxInflight = null;
    }
  })();
  return ctxInflight;
}

export function priceForAssetId(ctxs: AssetCtxs, assetId: number): number {
  if (assetId >= 10000) {
    const ctx = ctxs.spot[assetId - 10000];
    const px = parseFloat(ctx?.markPx ?? ctx?.midPx ?? "0");
    return Number.isFinite(px) ? px : 0;
  }
  const ctx = ctxs.perp[assetId];
  const px = parseFloat(ctx?.markPx ?? ctx?.midPx ?? ctx?.oraclePx ?? "0");
  return Number.isFinite(px) ? px : 0;
}

export async function getPerpPrice(perpAssetId: number): Promise<number> {
  const ctxs = await getAssetCtxs();
  return priceForAssetId(ctxs, perpAssetId);
}
