import { useEffect, useMemo, useState } from "react";
import { upcomingEvents, type CalendarEvent } from "../lib/events";
import { fetchYahooSummary } from "../lib/yahooFinance";

const COUNT = 12;

type Props = {
  coin: string;
  // HL annotation category — scopes which events appear (commodities sees
  // EIA/WASDE in addition to macro; stocks adds its earnings; etc.).
  category: string | null;
  refreshKey: number;
};

export default function EventsPanel({ coin, category, refreshKey }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Stock earnings come from Yahoo per-coin; recurring/static events are
  // synthesized client-side from rules. Earnings is null while loading or for
  // non-stocks; we still render the recurring list so the panel never feels
  // blocked on Yahoo.
  const [earnings, setEarnings] = useState<CalendarEvent | null>(null);

  // Tick once a minute — countdown granularity (h/m) doesn't need a 1s timer.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (category !== "stocks") {
      setEarnings(null);
      return;
    }
    fetchYahooSummary(coin.includes(":") ? coin.split(":")[1] : coin)
      .then((s) => {
        if (cancelled || !s?.fundamentals.nextEarningsDate) return;
        // Yahoo stores earningsDate in seconds, like its chart timestamps.
        const t = s.fundamentals.nextEarningsDate * 1000;
        setEarnings({
          id: `earnings-${coin}-${t}`,
          title: `${coin} earnings`,
          source: "Yahoo",
          timeMs: t,
          impact: "high",
          affects: ["stocks"],
          description: s.fundamentals.earningsDateRange
            ? "Estimated date (Yahoo) — confirmed when company announces."
            : "Next earnings release.",
        });
      })
      .catch(() => {
        if (!cancelled) setEarnings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [coin, category, refreshKey]);

  const events = useMemo(() => {
    const list = upcomingEvents(category, now, COUNT);
    return earnings && earnings.timeMs >= now
      ? [...list, earnings].sort((a, b) => a.timeMs - b.timeMs).slice(0, COUNT)
      : list;
  }, [category, now, earnings]);

  return (
    <section className="ev">
      <div className="ev-head">
        <span className="ev-head-label">Upcoming events</span>
        <span className="ev-head-scope">
          {category ?? "macro"} · ET schedule
        </span>
      </div>
      {events.length === 0 ? (
        <div className="fr-status">No upcoming events</div>
      ) : (
        <ol className="ev-list">
          {events.map((e) => (
            <EventRow key={e.id} event={e} now={now} />
          ))}
        </ol>
      )}
      <div className="ev-foot">
        Recurring events computed live · FOMC dates from Fed calendar · times
        shown in your local zone
      </div>
    </section>
  );
}

function EventRow({ event, now }: { event: CalendarEvent; now: number }) {
  const dtMs = event.timeMs - now;
  const isImminent = dtMs >= 0 && dtMs < 24 * 3_600_000;
  const isPast = dtMs < 0;
  return (
    <li
      className={`ev-row impact-${event.impact}${
        isImminent ? " imminent" : ""
      }${isPast ? " past" : ""}`}
    >
      <div className="ev-row-time">
        <span className="ev-countdown">{fmtCountdown(dtMs)}</span>
        <span className="ev-when">{fmtLocal(event.timeMs)}</span>
        <span className="ev-when-et">{fmtEt(event.timeMs)}</span>
      </div>
      <div className="ev-row-body">
        <div className="ev-row-title">
          {event.url ? (
            <a
              className="ev-row-title-link"
              href={event.url}
              target="_blank"
              rel="noreferrer"
            >
              {event.title}
            </a>
          ) : (
            event.title
          )}
          <span className={`ev-impact ev-impact-${event.impact}`}>
            {event.impact}
          </span>
        </div>
        <div className="ev-row-meta">
          <span className="ev-source">{event.source}</span>
          {event.description && (
            <span className="ev-desc">{event.description}</span>
          )}
        </div>
      </div>
    </li>
  );
}

// "in 2h 15m" / "in 3d 4h" / "in 14m" — quick visual scan of how soon.
function fmtCountdown(dtMs: number): string {
  if (dtMs < 0) return "passed";
  if (dtMs < 60_000) return "now";
  const totalMin = Math.round(dtMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const m = totalMin - totalHr * 60;
    return m > 0 ? `in ${totalHr}h ${m}m` : `in ${totalHr}h`;
  }
  const d = Math.floor(totalHr / 24);
  const h = totalHr - d * 24;
  return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`;
}

function fmtLocal(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtEt(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " ET";
}
