// HYPE protocol stats: revenue (DefiLlama) and HYPE "effectively burnt"
// supply (Hyperliquid native /info tokenDetails). hl.eco's 45.75M "All-time
// burnt" is computed from on-chain balances — there's no aggregated API for
// it. We replicate the same calc:
//
//   effectively_burnt = (maxSupply − totalSupply)          // outgoing burns
//                     + balance(0xfefefefefefe…fefe)        // AF holdings
//                     + balance(0x0000…0000)                // null sink
//                     + balance(0x0000…dead)                // dead sink
//
// The AF wallet (0xfefe…) is counted as burnt because the AF only ever
// buys HYPE with protocol revenue and never resells — those tokens are
// removed from circulation by definition.

const DEFILLAMA_REVENUE =
  "https://api.llama.fi/summary/fees/hyperliquid?dataType=dailyRevenue";
const HL_INFO = "https://api.hyperliquid.xyz/info";
const HYPE_TOKEN_ID = "0x0d01dc56dcaaca66ad901c959b4011ec";

const BURN_ADDRESSES = new Set([
  "0xfefefefefefefefefefefefefefefefefefefefe", // Assistance Fund
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

export type DailyPoint = { date: string; value: number };

export type HypeStats = {
  // Revenue (USD, from DefiLlama) — protocol's take of trading fees,
  // which the Assistance Fund spends on HYPE buybacks.
  revenue24h: number;
  revenueAllTime: number;
  dailyRevenue: DailyPoint[];

  // Burn (HYPE units, computed from tokenDetails).
  burnAllTime: number;
  percentBurnAllTime: number; // 4.57 (percent units, not fraction)
};

type LlamaFees = {
  total24h?: number;
  totalAllTime?: number;
  totalDataChart?: [number, number][]; // [unixSec, usd]
};

type TokenDetails = {
  maxSupply?: string;
  totalSupply?: string;
  nonCirculatingUserBalances?: [string, string][];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function computeBurn(d: TokenDetails): {
  burnAllTime: number;
  percentBurnAllTime: number;
} {
  const max = parseFloat(d.maxSupply ?? "0");
  const total = parseFloat(d.totalSupply ?? "0");
  const outgoing = Math.max(0, max - total);
  let sinkHeld = 0;
  for (const [addr, bal] of d.nonCirculatingUserBalances ?? []) {
    if (BURN_ADDRESSES.has(addr.toLowerCase())) {
      sinkHeld += parseFloat(bal) || 0;
    }
  }
  const burnAllTime = outgoing + sinkHeld;
  const percentBurnAllTime = max > 0 ? (burnAllTime / max) * 100 : 0;
  return { burnAllTime, percentBurnAllTime };
}

export async function fetchHypeStats(): Promise<HypeStats> {
  const [rev, token] = await Promise.all([
    getJson<LlamaFees>(DEFILLAMA_REVENUE),
    postJson<TokenDetails>(HL_INFO, {
      type: "tokenDetails",
      tokenId: HYPE_TOKEN_ID,
    }),
  ]);

  const dailyRevenue: DailyPoint[] = (rev.totalDataChart ?? []).map(
    ([sec, v]) => ({ date: isoDay(sec * 1000), value: Number(v) || 0 }),
  );

  const { burnAllTime, percentBurnAllTime } = computeBurn(token);

  return {
    revenue24h: rev.total24h ?? 0,
    revenueAllTime: rev.totalAllTime ?? 0,
    dailyRevenue,
    burnAllTime,
    percentBurnAllTime,
  };
}
