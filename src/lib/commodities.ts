// Commodity perp ↔ underlying CME/ICE/COMEX futures bridge.
//
// HL lists a bunch of commodity perps (xyz:GOLD, xyz:BRENTOIL, xyz:CL …) whose
// oracle is anchored to a real-world futures contract. Knowing the live
// underlying lets a trader judge whether HL's perp price is at a premium /
// discount to the actual benchmark — the second basis edge beyond cross-venue
// perp-to-perp basis. Free public source: Yahoo Finance's continuous-front
// futures symbols (XX=F). We already speak Yahoo via yahooFinance.ts.

import { fetchYahooChart } from "./yahooFinance";

// Bare HL ticker → Yahoo continuous-front futures symbol. Keys are HL's name
// (xyz: prefix stripped). Each Yahoo symbol rolls to the active front month, so
// the returned shortName carries the contract (e.g. "Crude Oil Jul 26").
//
// Verified by curl that every symbol below returns a regularMarketPrice.
const COMMODITY_TO_YAHOO: Record<string, string> = {
  // Energy
  CL: "CL=F", // WTI crude, NYMEX
  BRENTOIL: "BZ=F", // Brent crude, ICE (financial settlement)
  NATGAS: "NG=F", // Henry Hub natural gas, NYMEX
  // Precious metals
  GOLD: "GC=F", // COMEX gold
  SILVER: "SI=F", // COMEX silver
  PLATINUM: "PL=F", // NYMEX platinum
  PALLADIUM: "PA=F", // NYMEX palladium
  // Base metals
  COPPER: "HG=F", // COMEX copper
  ALUMINIUM: "ALI=F", // COMEX aluminum
  // Ags
  CORN: "ZC=F", // CBOT corn
  WHEAT: "ZW=F", // CBOT SRW wheat
};

// Strip HL's "<dex>:" prefix the same way the rest of the codebase does.
function bareTicker(coin: string): string {
  const colon = coin.indexOf(":");
  return colon >= 0 ? coin.slice(colon + 1) : coin;
}

export function commodityYahooSymbol(coin: string): string | null {
  return COMMODITY_TO_YAHOO[bareTicker(coin)] ?? null;
}

export type CommodityUnderlying = {
  // Yahoo symbol we fetched (e.g. "BZ=F").
  symbol: string;
  // Front-month contract description, e.g. "Brent Crude Oil Last Day Financ…".
  contractName: string;
  // "NYM" / "CMX" / "ICE" — venue of the underlying futures.
  exchange: string;
  // Most-recent traded price in USD.
  price: number;
  // Yahoo's regularMarketTime, ms epoch.
  asOfMs: number;
};

// Live front-month price for an HL commodity coin. Returns null when the coin
// isn't a commodity we've mapped, or when Yahoo doesn't answer.
export async function fetchCommodityUnderlying(
  coin: string,
): Promise<CommodityUnderlying | null> {
  const symbol = commodityYahooSymbol(coin);
  if (!symbol) return null;
  // 1d/1d is the lightest possible response: we only need meta. We don't draw
  // a chart here; that's a future expansion.
  const chart = await fetchYahooChart(symbol, "1d", "1d").catch(() => null);
  const m = chart?.meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) return null;
  return {
    symbol,
    contractName:
      m.longName ?? m.shortName ?? symbol.replace("=F", " futures"),
    exchange: m.exchangeName || m.fullExchangeName || "",
    price: m.regularMarketPrice,
    asOfMs: (m.regularMarketTime || 0) * 1000,
  };
}
