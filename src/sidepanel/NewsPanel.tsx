import { useEffect, useState } from "react";
import { fetchCoinNews, type NewsItem } from "../lib/news";

const REFRESH_MS = 5 * 60_000;

type Props = {
  coin: string;
  displayName: string;
  category: string | null;
  refreshKey: number;
};

export default function NewsPanel({
  coin,
  displayName,
  category,
  refreshKey,
}: Props) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const next = await fetchCoinNews(coin, displayName, category);
        if (cancelled) return;
        setItems(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (!silent) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    };
    void run(false);
    const id = setInterval(() => {
      if (!document.hidden) void run(true);
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin, displayName, category, refreshKey]);

  return (
    <section className="news">
      <div className="news-head">
        <span className="news-head-label">News &amp; Buzz</span>
        <span className="news-head-src">Google News · ranked</span>
      </div>

      {loading && !items && <div className="fr-status">Loading news…</div>}
      {error && !items && (
        <div className="fr-status fr-error">Failed to load: {error}</div>
      )}
      {items && items.length === 0 && (
        <div className="fr-status">No recent news for {displayName}.</div>
      )}

      {items && items.length > 0 && (
        <ol className="news-list">
          {items.slice(0, 25).map((it, i) => (
            <li key={it.url} className="news-item">
              <a
                className="news-link"
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {i < 3 && <span className="news-rank">{i + 1}</span>}
                <span className="news-body">
                  <span className="news-title">{it.title}</span>
                  <span className="news-meta">
                    <span className="news-source">{it.source}</span>
                    <span className="news-dot">·</span>
                    <span className="news-age">{fmtAgo(it.publishedAt)}</span>
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
