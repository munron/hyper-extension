import {
  fetchMeta,
  fetchPerpConciseAnnotations,
  fetchPerpDexs,
  fetchSpotMeta,
  type PerpAnnotation,
} from "./hyperliquid";

export type CoinIndex = {
  builtAt: number;
  // matching key (lowercased) -> coinId
  displayNameToCoinId: Record<string, string>;
  // coinId -> concise annotation (no description)
  annotations: Record<string, PerpAnnotation>;
  // perp coin name (e.g. "HYPE", "xyz:BRENTOIL") -> perp asset id within its
  // dex's universe. For sub-DEX coins this id is NOT a global asset id and
  // shouldn't be used as one — only the presence/absence of the key matters
  // for hasPerp gating; main-DEX-only consumers (Liquidation, Stops) should
  // also check that the coin name has no "<dex>:" prefix.
  perpAssetIdByCoin: Record<string, number>;
  // spot token name (e.g. "HYPE") -> spot asset ids (10000 + spot universe index)
  spotAssetIdsByToken: Record<string, number[]>;
};

// v2: now includes sub-DEX (e.g. xyz, flx) perps in perpAssetIdByCoin so the
// FR tab surfaces commodities/stocks/FX. Bump invalidates older caches.
const CACHE_KEY = "hyperliquid:coinIndex:v2";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

async function loadCachedIndex(): Promise<CoinIndex | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const value = stored[CACHE_KEY] as CoinIndex | undefined;
    if (!value) return null;
    if (Date.now() - value.builtAt > CACHE_TTL_MS) return null;
    // Backfill check: older cached entries may lack the new asset-id maps.
    if (!value.perpAssetIdByCoin || !value.spotAssetIdsByToken) return null;
    return value;
  } catch {
    return null;
  }
}

async function saveCachedIndex(index: CoinIndex): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: index });
  } catch {
    // ignore
  }
}

export async function buildCoinIndex(): Promise<CoinIndex> {
  const [entries, meta, spotMeta, perpDexs] = await Promise.all([
    fetchPerpConciseAnnotations(),
    fetchMeta(),
    fetchSpotMeta(),
    fetchPerpDexs().catch(() => [] as Awaited<ReturnType<typeof fetchPerpDexs>>),
  ]);
  // Sub-DEX universes (xyz, flx, …) host commodities/stocks/FX whose names
  // are already namespaced like "xyz:BRENTOIL". Merge them in so the FR tab
  // becomes available; individual fetchers in hyperliquid.ts route the right
  // `dex` parameter from the coin's prefix. The first slot in perpDexs is null
  // (the main DEX, already fetched above).
  const subDexNames = perpDexs
    .filter((d): d is NonNullable<typeof d> => d != null)
    .map((d) => d.name);
  const subMetas = await Promise.all(
    subDexNames.map((name) => fetchMeta(name).catch(() => null)),
  );

  const annotations: Record<string, PerpAnnotation> = {};
  const displayNameToCoinId: Record<string, string> = {};

  for (const [coinId, ann] of entries) {
    annotations[coinId] = ann;
    if (!ann.displayName) continue;
    const colon = coinId.indexOf(":");
    const dexPrefix = colon >= 0 ? coinId.slice(0, colon + 1) : "";
    const keys = [
      ann.displayName.toLowerCase(),
      (dexPrefix + ann.displayName).toLowerCase(),
    ];
    for (const key of keys) {
      if (!displayNameToCoinId[key]) displayNameToCoinId[key] = coinId;
    }
  }

  const perpAssetIdByCoin: Record<string, number> = {};
  meta.universe.forEach((asset, idx) => {
    if (asset?.name) perpAssetIdByCoin[asset.name] = idx;
  });
  for (const sub of subMetas) {
    if (!sub) continue;
    sub.universe.forEach((asset, idx) => {
      if (asset?.name && !(asset.name in perpAssetIdByCoin)) {
        perpAssetIdByCoin[asset.name] = idx;
      }
    });
  }

  const tokensByIndex = new Map<number, string>();
  for (const tok of spotMeta.tokens) {
    if (tok?.name && typeof tok.index === "number") {
      tokensByIndex.set(tok.index, tok.name);
    }
  }
  const spotAssetIdsByToken: Record<string, number[]> = {};
  for (const pair of spotMeta.universe) {
    if (typeof pair?.index !== "number" || !Array.isArray(pair.tokens)) continue;
    const baseName = tokensByIndex.get(pair.tokens[0]);
    if (!baseName) continue;
    const assetId = 10000 + pair.index;
    const list = spotAssetIdsByToken[baseName] ?? [];
    list.push(assetId);
    spotAssetIdsByToken[baseName] = list;
  }

  const index: CoinIndex = {
    builtAt: Date.now(),
    displayNameToCoinId,
    annotations,
    perpAssetIdByCoin,
    spotAssetIdsByToken,
  };
  await saveCachedIndex(index);
  return index;
}

export async function getCoinIndex(forceRefresh = false): Promise<CoinIndex> {
  if (!forceRefresh) {
    const cached = await loadCachedIndex();
    if (cached) return cached;
  }
  return buildCoinIndex();
}

export function resolveCoinId(index: CoinIndex | null, raw: string): string {
  if (!index) return raw;
  if (index.annotations[raw]) return raw;
  const direct = index.displayNameToCoinId[raw.toLowerCase()];
  if (direct) return direct;
  return raw;
}

export function getAssetIdsForCoin(
  index: CoinIndex | null,
  coin: string,
): { perpAssetId: number | null; spotAssetIds: number[] } {
  if (!index) return { perpAssetId: null, spotAssetIds: [] };
  const perpAssetId =
    coin in index.perpAssetIdByCoin ? index.perpAssetIdByCoin[coin] : null;
  const spotAssetIds = index.spotAssetIdsByToken[coin] ?? [];
  return { perpAssetId, spotAssetIds };
}
