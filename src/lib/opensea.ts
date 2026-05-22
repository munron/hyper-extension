const OPENSEA_GRAPHQL_ENDPOINT = "https://gql.opensea.io/graphql";
const SALES_CHART_HASH =
  "0f2790056be69e71e4154b21dbc67835194dac73934e11a4827c0a75a3fd2d61";

export type Timeframe = "ONE_DAY" | "SEVEN_DAYS" | "THIRTY_DAYS" | "ALL_TIME";

export type TokenPrice = {
  unit: number;
  symbol: string;
};

export type ChartSale = {
  saleKey: string;
  collectionId: string;
  usd: number;
  native: TokenPrice;
  time: string; // ISO 8601
};

export type ChartVolume = {
  volume: { usd: number; native: TokenPrice };
  time: string; // bucket start
};

export type CollectionSalesChart = {
  sales: ChartSale[];
  volumes: ChartVolume[];
};

export async function fetchCollectionSalesChart(
  collectionSlug: string,
  timeframe: Timeframe,
): Promise<CollectionSalesChart> {
  const body = {
    extensions: {
      persistedQuery: { sha256Hash: SALES_CHART_HASH, version: 1 },
    },
    operationName: "SalesChartMainQuery",
    variables: { collectionSlug, timeframe },
  };
  const res = await fetch(OPENSEA_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opensea ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    data?: {
      collectionChartSalesBySlug?: ChartSale[];
      collectionChartVolumesBySlug?: ChartVolume[];
    };
    errors?: unknown;
  };
  if (json.errors) {
    throw new Error(`opensea GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return {
    sales: json.data?.collectionChartSalesBySlug ?? [],
    volumes: json.data?.collectionChartVolumesBySlug ?? [],
  };
}
