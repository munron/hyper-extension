// Per-coin news/social feed for the currently-open symbol.
//
// Source: Google News RSS search (keyless, CORS-open via host_permissions).
// It returns up to ~100 recent items per query with title, link, pubDate, and
// a <source> outlet name — enough to rank by recency + outlet weight without
// any API key or backend. We deliberately avoid X/Twitter (no free,
// ToS-clean, engagement-ranked search exists) and key-gated aggregators.
//
// Ranking = recency decay × source weight, so a fresh item from a reputable
// crypto/finance outlet floats to the top while old or low-signal blog spam
// sinks.

const GNEWS_BASE = "https://news.google.com/rss/search";

export type NewsItem = {
  title: string;
  url: string;
  source: string; // outlet name, e.g. "CoinDesk"
  publishedAt: number; // ms epoch
  score: number; // computed rank score (higher = show first)
};

// Outlets we trust more for crypto/markets coverage. Matched case-insensitively
// as a substring of the RSS <source> name. Anything not listed gets weight 1.
const SOURCE_WEIGHTS: { match: string; weight: number }[] = [
  { match: "coindesk", weight: 3.0 },
  { match: "cointelegraph", weight: 2.6 },
  { match: "the block", weight: 2.8 },
  { match: "theblock", weight: 2.8 },
  { match: "decrypt", weight: 2.4 },
  { match: "bloomberg", weight: 3.0 },
  { match: "reuters", weight: 3.0 },
  { match: "financial times", weight: 2.8 },
  { match: "cnbc", weight: 2.4 },
  { match: "forbes", weight: 1.8 },
  { match: "blockworks", weight: 2.4 },
  { match: "dlnews", weight: 2.2 },
  { match: "the defiant", weight: 2.0 },
  { match: "bankless", weight: 1.8 },
  { match: "messari", weight: 2.2 },
  { match: "yahoo", weight: 1.6 },
  { match: "benzinga", weight: 1.4 },
  { match: "cryptoslate", weight: 1.6 },
  { match: "beincrypto", weight: 1.4 },
  { match: "u.today", weight: 1.2 },
  { match: "crypto.news", weight: 1.4 },
  { match: "coingape", weight: 1.2 },
];

function sourceWeight(source: string): number {
  const s = source.toLowerCase();
  for (const { match, weight } of SOURCE_WEIGHTS) {
    if (s.includes(match)) return weight;
  }
  return 1;
}

// Build a focused search query for the coin. The bare ticker is too noisy
// (e.g. "HYPE" = the English word), so we lead with the human display name and
// scope to crypto. Stocks/RWA perps search the company name + the ticker.
function buildQuery(
  coin: string,
  displayName: string,
  category: string | null,
): string {
  // Strip any sub-DEX prefix like "xyz:BRENTOIL" → "BRENTOIL".
  const bareCoin = coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin;
  const name = displayName && displayName !== coin ? displayName : bareCoin;
  const cat = (category ?? "").toLowerCase();
  if (["stocks", "indices", "commodities", "fx", "preipo"].includes(cat)) {
    // RWA perps: the name alone (e.g. "Brent Oil", "Tesla") is the signal.
    return `"${name}"`;
  }
  if (coin === "HYPE") return "Hyperliquid HYPE crypto";
  // Generic crypto: name + ticker, scoped to crypto to cut false positives.
  return `${name} ${bareCoin} crypto`;
}

const TITLE_RE = /<title>([\s\S]*?)<\/title>/;
const LINK_RE = /<link>([\s\S]*?)<\/link>/;
const DATE_RE = /<pubDate>([\s\S]*?)<\/pubDate>/;
const SOURCE_RE = /<source[^>]*>([\s\S]*?)<\/source>/;

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .trim();
}

// Google News titles arrive as "Headline text - Outlet Name". When the RSS
// <source> tag is missing we fall back to splitting on the trailing " - ".
function splitTitleSource(rawTitle: string): { title: string; source: string } {
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx > 0 && idx > rawTitle.length - 60) {
    return {
      title: rawTitle.slice(0, idx).trim(),
      source: rawTitle.slice(idx + 3).trim(),
    };
  }
  return { title: rawTitle, source: "" };
}

export async function fetchCoinNews(
  coin: string,
  displayName: string,
  category: string | null = null,
): Promise<NewsItem[]> {
  const q = buildQuery(coin, displayName, category);
  const url = `${GNEWS_BASE}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { Accept: "text/xml" } });
  if (!res.ok) throw new Error(`news: HTTP ${res.status}`);
  const xml = await res.text();
  return parseGoogleNews(xml);
}

// Exported for offline testing.
export function parseGoogleNews(xml: string): NewsItem[] {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const now = Date.now();
  const items: NewsItem[] = [];
  for (const b of blocks) {
    const rawTitle = decodeEntities((b.match(TITLE_RE)?.[1] ?? ""));
    const link = decodeEntities((b.match(LINK_RE)?.[1] ?? ""));
    const dateStr = (b.match(DATE_RE)?.[1] ?? "").trim();
    const sourceTag = decodeEntities((b.match(SOURCE_RE)?.[1] ?? ""));
    if (!rawTitle || !link) continue;

    const t = Date.parse(dateStr);
    const publishedAt = Number.isFinite(t) ? t : now;

    // Prefer the explicit <source>; otherwise peel "… - Outlet" off the title.
    const split = splitTitleSource(rawTitle);
    const source = sourceTag || split.source || "News";
    const title = sourceTag ? rawTitle : split.title;

    items.push({ title, url: link, source, publishedAt, score: 0 });
  }

  // Score = source weight × recency decay (half-life ~18h). Recent + reputable
  // wins; week-old items are heavily discounted but still ordered sanely.
  const HALF_LIFE_MS = 18 * 60 * 60 * 1000;
  for (const it of items) {
    const ageMs = Math.max(0, now - it.publishedAt);
    const recency = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    it.score = sourceWeight(it.source) * recency;
  }

  // De-dupe by title (Google often repeats the same story across editions).
  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    const k = it.title.toLowerCase().slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}
