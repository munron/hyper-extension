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

export async function fetchSpotMetaAndAssetCtxs(): Promise<[SpotMeta, SpotAssetCtx[]]> {
  return postInfo<[SpotMeta, SpotAssetCtx[]]>({ type: "spotMetaAndAssetCtxs" });
}

export async function fetchPerpDexs(): Promise<(PerpDex | null)[]> {
  return postInfo<(PerpDex | null)[]>({ type: "perpDexs" });
}
