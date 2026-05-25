const HYPERDASH_ENDPOINT = "https://api.hyperdash.com/graphql";

const LIQUIDATION_LEVELS_QUERY = `query GetLiquidationLevelsV2($coin: String!, $minPrice: Float!, $maxPrice: Float!, $startTime: Float!, $endTime: Float) {
  analytics {
    liquidationLevels: liquidationLevelsV2(
      coin: $coin
      minPrice: $minPrice
      maxPrice: $maxPrice
      startTime: $startTime
      endTime: $endTime
    ) {
      coin
      currentPrice
      bandSize
      minPrice
      maxPrice
      bands {
        minPrice
        maxPrice
        historicalData { timestamp totalAmount }
      }
      totalLongLiquidations { size count }
      totalShortLiquidations { size count }
      topLongLiquidations { address price size }
      topShortLiquidations { address price size }
      timestamp
    }
  }
}`;

export type LiquidationBand = {
  minPrice: number;
  maxPrice: number;
  // Hyperdash returns timestamp as an ISO-like string ("YYYY-MM-DD HH:MM:SS"),
  // not a unix-seconds number. Each entry is a snapshot of the at-risk
  // size at that band at that moment — NOT a delta, NOT a cumulative
  // sum. To get the current at-risk size, use the latest entry.
  historicalData: { timestamp: string; totalAmount: number }[];
};

export type LiquidationAddress = {
  address: string;
  price: number;
  size: number;
};

export type RankedPosition = {
  address: string;
  price: number;
  size: number;
  usd: number;
  distPct: number; // signed % distance of price from currentPrice
};

// The API's top{Long,Short} / top{Buy,Sell} lists hold up to ~5 of the
// largest positions per side, sorted by size. But the single biggest
// position is often far from price and not actionable. What a trader
// actually watches is a *sizeable* position sitting *close* to the
// current price — a likely magnet / cascade trigger. So re-rank by
// proximity, preferring entries above a notable-size floor (~$0.5M), and
// fall back to the raw (size-sorted) set if nothing clears the floor so
// the section is never needlessly empty.
export function rankNearestPositions(
  arr: { address: string; price: number; size: number }[],
  currentPrice: number,
  opts: { minUsd?: number; limit?: number } = {},
): RankedPosition[] {
  const minUsd = opts.minUsd ?? 0.5e6;
  const limit = opts.limit ?? 3;
  const enriched: RankedPosition[] = arr.map((t) => ({
    address: t.address,
    price: t.price,
    size: t.size,
    usd: Math.abs(t.size) * t.price,
    distPct:
      currentPrice > 0 ? ((t.price - currentPrice) / currentPrice) * 100 : 0,
  }));
  const notable = enriched.filter((t) => t.usd >= minUsd);
  const pool = notable.length > 0 ? notable : enriched;
  return [...pool]
    .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct))
    .slice(0, limit);
}

export type LiquidationLevels = {
  coin: string;
  currentPrice: number;
  bandSize: number;
  minPrice: number;
  maxPrice: number;
  bands: LiquidationBand[];
  totalLongLiquidations: { size: number; count: number };
  totalShortLiquidations: { size: number; count: number };
  topLongLiquidations: LiquidationAddress[];
  topShortLiquidations: LiquidationAddress[];
  timestamp: number;
};

const BAND_DETAILS_QUERY = `query GetCurrentLiquidationBandDetailsV2($coin: String!, $minPrice: Float!, $maxPrice: Float!) {
  analytics {
    historicalLiquidationLevel: currentLiquidationBandDetailsV2(
      coin: $coin
      minPrice: $minPrice
      maxPrice: $maxPrice
    ) {
      coin
      minPrice
      maxPrice
      liquidations { address amount price }
      totalAmount
      totalCount
      longCount
      shortCount
      snapshotTimestamp
      timestamp
    }
  }
}`;

export type LiquidationPosition = {
  address: string;
  amount: number;
  price: number;
};

export type LiquidationBandDetails = {
  coin: string;
  minPrice: number;
  maxPrice: number;
  liquidations: LiquidationPosition[];
  totalAmount: number;
  totalCount: number;
  longCount: number;
  shortCount: number;
  snapshotTimestamp: string;
  timestamp: string;
};

export async function fetchLiquidationBandDetails(params: {
  coin: string;
  minPrice: number;
  maxPrice: number;
}): Promise<LiquidationBandDetails> {
  const body = {
    operationName: "GetCurrentLiquidationBandDetailsV2",
    variables: params,
    query: BAND_DETAILS_QUERY,
  };
  const res = await fetch(HYPERDASH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hyperdash ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    data?: { analytics?: { historicalLiquidationLevel?: LiquidationBandDetails } };
    errors?: unknown;
    error?: string;
    message?: string;
  };
  if (json.error || json.errors) {
    throw new Error(
      `hyperdash error: ${json.message ?? json.error ?? JSON.stringify(json.errors)}`,
    );
  }
  const out = json.data?.analytics?.historicalLiquidationLevel;
  if (!out) throw new Error("hyperdash: missing historicalLiquidationLevel");
  return out;
}

const STOP_ORDER_LEVELS_QUERY = `query GetCurrentStopOrderDistributionV2($coin: String!, $minPrice: Float, $maxPrice: Float) {
  analytics {
    currentStopOrderLevel: currentStopOrderDistributionV2(
      coin: $coin
      minPrice: $minPrice
      maxPrice: $maxPrice
    ) {
      coin
      currentPrice
      bandSize
      minPrice
      maxPrice
      bands { minPrice maxPrice buySize sellSize buyCount sellCount }
      totalBuyStops { size count }
      totalSellStops { size count }
      topBuyStops { address price size }
      topSellStops { address price size }
      snapshotTimestamp
      timestamp
    }
  }
}`;

export type StopOrderBand = {
  minPrice: number;
  maxPrice: number;
  buySize: number;
  sellSize: number;
  buyCount: number;
  sellCount: number;
};

export type StopOrderAddress = {
  address: string;
  price: number;
  size: number;
};

export type StopOrderLevels = {
  coin: string;
  currentPrice: number;
  bandSize: number;
  minPrice: number;
  maxPrice: number;
  bands: StopOrderBand[];
  totalBuyStops: { size: number; count: number };
  totalSellStops: { size: number; count: number };
  topBuyStops: StopOrderAddress[];
  topSellStops: StopOrderAddress[];
  snapshotTimestamp: string;
  timestamp: string;
};

const STOP_ORDER_BAND_DETAILS_QUERY = `query GetCurrentStopOrderBandDetailsV2($coin: String!, $minPrice: Float!, $maxPrice: Float!) {
  analytics {
    stopOrderLevel: currentStopOrderBandDetailsV2(
      coin: $coin
      minPrice: $minPrice
      maxPrice: $maxPrice
    ) {
      coin
      minPrice
      maxPrice
      stops { address size price }
      totalSize
      totalCount
      buyCount
      sellCount
      snapshotTimestamp
      timestamp
    }
  }
}`;

// stops[].size is signed: positive = buy stop, negative = sell stop.
// totalSize == sum of abs(size) across stops in this band.
export type StopOrderPosition = {
  address: string;
  size: number;
  price: number;
};

export type StopOrderBandDetails = {
  coin: string;
  minPrice: number;
  maxPrice: number;
  stops: StopOrderPosition[];
  totalSize: number;
  totalCount: number;
  buyCount: number;
  sellCount: number;
  snapshotTimestamp: string;
  timestamp: string;
};

export async function fetchStopOrderLevels(params: {
  coin: string;
  minPrice: number;
  maxPrice: number;
}): Promise<StopOrderLevels> {
  const body = {
    operationName: "GetCurrentStopOrderDistributionV2",
    variables: params,
    query: STOP_ORDER_LEVELS_QUERY,
  };
  const res = await fetch(HYPERDASH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperdash ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    data?: { analytics?: { currentStopOrderLevel?: StopOrderLevels } };
    errors?: unknown;
    error?: string;
    message?: string;
  };
  if (json.error || json.errors) {
    throw new Error(
      `hyperdash error: ${json.message ?? json.error ?? JSON.stringify(json.errors)}`,
    );
  }
  const out = json.data?.analytics?.currentStopOrderLevel;
  if (!out) throw new Error("hyperdash: missing currentStopOrderLevel");
  return out;
}

export async function fetchStopOrderBandDetails(params: {
  coin: string;
  minPrice: number;
  maxPrice: number;
}): Promise<StopOrderBandDetails> {
  const body = {
    operationName: "GetCurrentStopOrderBandDetailsV2",
    variables: params,
    query: STOP_ORDER_BAND_DETAILS_QUERY,
  };
  const res = await fetch(HYPERDASH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperdash ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    data?: { analytics?: { stopOrderLevel?: StopOrderBandDetails } };
    errors?: unknown;
    error?: string;
    message?: string;
  };
  if (json.error || json.errors) {
    throw new Error(
      `hyperdash error: ${json.message ?? json.error ?? JSON.stringify(json.errors)}`,
    );
  }
  const out = json.data?.analytics?.stopOrderLevel;
  if (!out) throw new Error("hyperdash: missing stopOrderLevel");
  return out;
}

export async function fetchLiquidationLevels(params: {
  coin: string;
  minPrice: number;
  maxPrice: number;
  startTime: number;
  endTime: number;
}): Promise<LiquidationLevels> {
  const body = {
    operationName: "GetLiquidationLevelsV2",
    variables: params,
    query: LIQUIDATION_LEVELS_QUERY,
  };
  const res = await fetch(HYPERDASH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hyperdash ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    data?: { analytics?: { liquidationLevels?: LiquidationLevels } };
    errors?: unknown;
    error?: string;
    message?: string;
  };
  if (json.error || json.errors) {
    throw new Error(
      `hyperdash error: ${json.message ?? json.error ?? JSON.stringify(json.errors)}`,
    );
  }
  const levels = json.data?.analytics?.liquidationLevels;
  if (!levels) throw new Error("hyperdash: missing liquidationLevels");
  return levels;
}
