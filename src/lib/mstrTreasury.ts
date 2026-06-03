// MSTR (Strategy Inc) Bitcoin treasury tracker — surfaced on the BTC tab.
// Strategy is the largest corporate BTC holder; its accumulation pace and the
// premium/discount of its stock to the underlying BTC (mNAV) are watched as
// BTC-demand signals, so traders eyeing BTC want it one click away.
//
// Data sources — both keyless, CORS-open (access-control-allow-origin: *),
// read-only public data:
//
//  • StrategyTracker public data bucket (data.strategytracker.com). latest.json
//    (~280B) points at the current *versioned* files, which are immutable +
//    brotli-compressed so the browser caches them hard:
//      - all-light.v<ver>.json (~140KB): per-company snapshot (holdings,
//        market cap, stock price, sats/share, BTC yield) + live BTC price.
//      - all.v<ver>.json (~16MB raw, brotli on the wire): full *daily* history
//        per company (btc_balance, btc_prices, …). We diff btc_balance to
//        reconstruct the purchase timeline. Heavy, so it loads lazily on a
//        user click rather than on tab open.
//      - prices-live.json (~11KB): intraday stock quote (day change %).
//  • CoinGecko public_treasury/bitcoin (~30KB): cost basis (entry value),
//    current value, and % of total BTC supply for the snapshot card.

const ST_BASE = "https://data.strategytracker.com";
const CG_TREASURY =
  "https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin";
const ST_TICKER = "MSTR";
const CG_SYMBOL = "MSTR.US";

export type MstrSnapshot = {
  holdings: number; // BTC
  btcPrice: number; // USD per BTC
  btcNav: number; // holdings * btcPrice
  costBasis: number; // total USD paid
  avgCost: number; // costBasis / holdings
  currentValue: number; // current USD value of the stack
  unrealizedPnl: number; // currentValue - costBasis
  unrealizedPnlPct: number;
  pctOfBtcSupply: number; // 4.018 (percent units)
  marketCap: number; // USD
  mnav: number; // marketCap / btcNav (>1 premium, <1 discount)
  stockPrice: number; // USD
  stockChangePct: number | null; // intraday %, null if quote missing
  satsPerShare: number;
  btcYieldYtd: number; // percent units
  asOf: string; // ISO timestamp of the snapshot
};

export type MstrTrade = {
  date: string; // YYYY-MM-DD
  side: "buy" | "sell";
  btc: number; // BTC moved that day (positive magnitude)
  btcPrice: number; // BTC price that day (USD)
  estUsd: number; // btc * btcPrice (cost for a buy, proceeds for a sell)
  totalAfter: number; // running BTC total after the move
};

export type MstrHistory = {
  // Daily cumulative holdings (date, BTC) for the chart.
  holdings: { date: string; btc: number }[];
  // Discrete treasury moves (buys AND the rare sells), newest first
  // (capped by the caller).
  trades: MstrTrade[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

type Manifest = { files: { full: string; light: string } };

function fetchManifest(): Promise<Manifest> {
  return getJson<Manifest>(`${ST_BASE}/latest.json`);
}

type LightCompany = {
  holdings: number;
  marketCap: number;
  stockPrice: number;
  satsPerShare: number;
  btcYieldYtd: number;
};
type LightFile = {
  timestamp: string;
  companies: Record<string, LightCompany>;
  bitcoin: { current_price: number };
};

type CgCompany = {
  symbol: string;
  total_holdings: number;
  total_entry_value_usd: number;
  total_current_value_usd: number;
  percentage_of_total_supply: number;
};
type CgResp = { companies: CgCompany[] };

type LiveFile = { prices: Record<string, { changePercent?: number }> };

export async function fetchMstrSnapshot(): Promise<MstrSnapshot> {
  const manifest = await fetchManifest();
  const [light, cg, live] = await Promise.all([
    getJson<LightFile>(`${ST_BASE}/${manifest.files.light}`),
    getJson<CgResp>(CG_TREASURY).catch(() => null),
    getJson<LiveFile>(`${ST_BASE}/prices-live.json`).catch(() => null),
  ]);

  const c = light.companies[ST_TICKER];
  if (!c) throw new Error("MSTR not found in StrategyTracker snapshot");
  const cgc = cg?.companies.find((x) => x.symbol === CG_SYMBOL) ?? null;

  const holdings = c.holdings;
  const btcPrice = light.bitcoin.current_price;
  const btcNav = holdings * btcPrice;

  // Cost basis & current value come from CoinGecko; if that call failed, fall
  // back to BTC NAV (zero unrealized P/L) so the card still renders.
  const costBasis = cgc?.total_entry_value_usd ?? 0;
  const currentValue = cgc?.total_current_value_usd ?? btcNav;
  const unrealizedPnl = costBasis > 0 ? currentValue - costBasis : 0;
  const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  return {
    holdings,
    btcPrice,
    btcNav,
    costBasis,
    avgCost: holdings > 0 ? costBasis / holdings : 0,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPct,
    pctOfBtcSupply: cgc?.percentage_of_total_supply ?? 0,
    marketCap: c.marketCap,
    mnav: btcNav > 0 ? c.marketCap / btcNav : 0,
    stockPrice: c.stockPrice,
    stockChangePct: live?.prices?.[ST_TICKER]?.changePercent ?? null,
    satsPerShare: c.satsPerShare,
    btcYieldYtd: c.btcYieldYtd,
    asOf: light.timestamp,
  };
}

type FullHistorical = {
  dates: string[];
  btc_balance: (number | null)[];
  btc_prices: (number | null)[];
};
type FullFile = {
  companies: Record<string, { historicalData: FullHistorical }>;
};

// Ignore sub-BTC wiggles (rounding / FX restatements); a real Strategy move is
// always many BTC. Applies to both directions so the rare sells are caught too.
const TRADE_MIN_BTC = 1;

export async function fetchMstrHistory(maxTrades = 12): Promise<MstrHistory> {
  const manifest = await fetchManifest();
  const full = await getJson<FullFile>(`${ST_BASE}/${manifest.files.full}`);
  const h = full.companies[ST_TICKER]?.historicalData;
  if (!h) throw new Error("MSTR history not found");

  const holdings: { date: string; btc: number }[] = [];
  const trades: MstrTrade[] = [];
  let prev: number | null = null;
  for (let i = 0; i < h.dates.length; i++) {
    const bal = h.btc_balance[i];
    if (bal == null) continue;
    holdings.push({ date: h.dates[i], btc: bal });
    if (prev != null && Math.abs(bal - prev) > TRADE_MIN_BTC) {
      const delta = bal - prev;
      const px = h.btc_prices[i] ?? 0;
      trades.push({
        date: h.dates[i],
        side: delta > 0 ? "buy" : "sell",
        btc: Math.abs(delta),
        btcPrice: px,
        estUsd: Math.abs(delta) * px,
        totalAfter: bal,
      });
    }
    prev = bal;
  }
  trades.reverse(); // newest first
  return { holdings, trades: trades.slice(0, maxTrades) };
}
