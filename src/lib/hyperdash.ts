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
  historicalData: { timestamp: number; totalAmount: number }[];
};

export type LiquidationAddress = {
  address: string;
  price: number;
  size: number;
};

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
