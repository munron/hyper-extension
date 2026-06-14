const Y1 = "https://query1.finance.yahoo.com";

const ETF_TICKERS = ["BHYP", "THYP", "HYPG"] as const;

export type EtfVolumeDay = {
  date: string; // YYYY-MM-DD
  perTicker: Record<string, number>; // ticker -> USD volume (shares × close)
};

export type EtfVolumeResult = {
  days: EtfVolumeDay[];
  tickers: string[];
};

type ChartResponse = {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: {
        quote?: { volume?: (number | null)[]; close?: (number | null)[] }[];
      };
    }[];
  };
};

async function fetchTickerVolume(
  ticker: string,
): Promise<{ date: string; usdVolume: number }[]> {
  const url = `${Y1}/v8/finance/chart/${ticker}?range=3mo&interval=1d&includePrePost=false`;
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as ChartResponse;
  const r = j.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp ?? [];
  const volumes = r.indicators?.quote?.[0]?.volume ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const out: { date: string; usdVolume: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const v = volumes[i];
    const c = closes[i];
    if (v == null || c == null) continue;
    const d = new Date(ts[i] * 1000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ date: iso, usdVolume: v * c });
  }
  return out;
}

export async function fetchEtfVolume(): Promise<EtfVolumeResult> {
  const results = await Promise.all(
    ETF_TICKERS.map(async (t) => ({ ticker: t, data: await fetchTickerVolume(t) })),
  );

  const dayMap = new Map<string, Record<string, number>>();
  for (const { ticker, data } of results) {
    for (const { date, usdVolume } of data) {
      let rec = dayMap.get(date);
      if (!rec) {
        rec = {};
        dayMap.set(date, rec);
      }
      rec[ticker] = usdVolume;
    }
  }

  const days: EtfVolumeDay[] = [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, perTicker]) => ({ date, perTicker }));

  const tickers = results
    .filter((r) => r.data.length > 0)
    .map((r) => r.ticker);

  return { days, tickers };
}
