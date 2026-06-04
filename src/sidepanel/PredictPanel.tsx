import { useEffect, useState } from "react";
import {
  fetchPriceLadder,
  fetchCatalysts,
  type PriceLadder,
  type LadderRung,
  type Catalyst,
} from "../lib/polymarket";

// These markets move on real news, not by the second — poll calmly.
const REFRESH_MS = 30_000;

type Props = {
  coin: string;
  displayName: string;
  refreshKey: number;
};

export default function PredictPanel({ coin, displayName, refreshKey }: Props) {
  const [ladder, setLadder] = useState<PriceLadder | null>(null);
  const [catalysts, setCatalysts] = useState<Catalyst[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const l = await fetchPriceLadder(coin, displayName);
        if (cancelled) return;
        setLadder(l);
        const c = await fetchCatalysts(coin, displayName, l ? slugOf(l.url) : null);
        if (cancelled) return;
        setCatalysts(c);
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
  }, [coin, displayName, refreshKey]);

  const empty =
    !ladder && (!catalysts || catalysts.length === 0);

  return (
    <section className="hs">
      <div className="hs-head">
        <span className="hs-head-label">Predict · {displayName}</span>
        <span className="hs-head-src">Polymarket</span>
      </div>

      {loading && !ladder && !catalysts && (
        <div className="fr-status">Loading prediction markets…</div>
      )}
      {error && !ladder && !catalysts && (
        <div className="fr-status fr-error">Failed to load: {error}</div>
      )}
      {!loading && empty && (
        <div className="fr-status">
          No active Polymarket markets for {displayName}.
        </div>
      )}

      {ladder && <LadderCard ladder={ladder} />}
      {catalysts && catalysts.length > 0 && <CatalystCard items={catalysts} />}
    </section>
  );
}

function slugOf(url: string): string {
  return url.split("/").pop() ?? "";
}

// --- Price ladder ----------------------------------------------------------

function LadderCard({ ladder }: { ladder: PriceLadder }) {
  return (
    <a
      className="hs-card pm-card"
      href={ladder.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on Polymarket"
    >
      <div className="pm-card-head">
        <span className="pm-card-title">{ladder.title}</span>
        <span className="pm-ext" aria-hidden="true">↗</span>
      </div>
      <div className="pm-hint">
        Crowd-implied probability of reaching each level, and the 24h shift.
      </div>
      <div className="pm-ladder">
        {ladder.rungs.map((r) => (
          <Rung key={r.label} r={r} />
        ))}
      </div>
      <div className="pm-meta">
        <span>Event vol {fmtUsd(ladder.volumeUsd)}</span>
      </div>
    </a>
  );
}

function Rung({ r }: { r: LadderRung }) {
  return (
    <div className="pm-rung">
      <span className="pm-rung-label">{r.label}</span>
      <span className="pm-rung-bar">
        <span className="pm-rung-fill" style={{ width: `${r.yesPct}%` }} />
      </span>
      <span className="pm-rung-pct">{r.yesPct.toFixed(0)}%</span>
      <Change pts={r.change24hPts} />
    </div>
  );
}

// --- Catalysts / movers ----------------------------------------------------

function CatalystCard({ items }: { items: Catalyst[] }) {
  return (
    <>
      <div className="pm-section">Movers · biggest 24h shifts</div>
      <div className="hs-card pm-related">
        {items.map((it) => (
          <a
            key={it.slug}
            className="pm-rel"
            href={it.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on Polymarket"
          >
            <div className="pm-rel-top">
              <span className="pm-rel-q">{it.question}</span>
              {it.yesPct != null && (
                <span className="pm-rel-yes">{it.yesPct.toFixed(0)}%</span>
              )}
            </div>
            <div className="pm-rel-meta">
              <Change pts={it.change24hPts} />
              <span>Vol {fmtUsd(it.volumeUsd)}</span>
              <span className="pm-ext" aria-hidden="true">↗</span>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

// --- shared ----------------------------------------------------------------

function Change({ pts }: { pts: number | null }) {
  if (pts == null || Math.abs(pts) < 0.5) {
    return <span className="pm-chg flat">±0</span>;
  }
  const up = pts > 0;
  return (
    <span className={`pm-chg ${up ? "up" : "down"}`}>
      {up ? "▲" : "▼"} {Math.abs(pts).toFixed(0)}pt
    </span>
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
