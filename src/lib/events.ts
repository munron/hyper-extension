// Economic event calendar — upcoming macro / commodity / equity catalysts that
// tend to move HL perp markets. Two flavors live here:
//
//   1. Recurring events with crisp rules (NFP = first Friday, EIA petroleum =
//      every Wednesday, etc.) are computed live so they never go stale.
//   2. Discrete one-off events with published schedules (FOMC decisions) are
//      embedded as a small static list keyed by year — easy to update once a
//      year against the Fed / ECB / BoJ published calendars.
//
// Stock earnings dates aren't here: they come from Yahoo per-coin and are
// merged into the panel at render time.

// HL coin annotation categories we filter by. "*" matches any. `indices` /
// `preipo` don't get any asset-specific events of their own yet — only the
// "*" macro releases pass the filter for them, which is the correct behavior.
type Category =
  | "macro"
  | "commodities"
  | "stocks"
  | "crypto"
  | "fx"
  | "indices"
  | "preipo"
  | "*";

export type EventImpact = "high" | "medium" | "low";

export type CalendarEvent = {
  id: string;
  title: string;
  // Source / category label shown as a small pill on the row.
  source: string;
  // Pre-computed UTC ms when the event releases.
  timeMs: number;
  impact: EventImpact;
  // Coin categories this event tends to move. "*" applies to every coin.
  // A coin row shows an event when its own category appears here.
  affects: Category[];
  // Free-text context: usually the contract / data series being released.
  description?: string;
  // Optional canonical info URL.
  url?: string;
};

// --- ET timezone helpers ---------------------------------------------------
//
// All US economic releases reference Eastern Time. Browsers don't expose an
// "ET-aware Date" so we use Intl.DateTimeFormat to translate ET wall-clock
// times to true UTC instants, correctly absorbing DST.

// Returns the UTC ms representing the given calendar moment interpreted in
// America/New_York. Works across EST/EDT by measuring the offset empirically.
function etInstant(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    })
      .formatToParts(new Date(naiveUtc))
      .map((p) => [p.type, p.value]),
  );
  // Some Intl outputs use hour "24" for midnight; normalize to 0.
  const h = Number(parts.hour) % 24;
  const etUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    h,
    Number(parts.minute),
  );
  return naiveUtc + (naiveUtc - etUtc);
}

// --- recurring rule helpers -----------------------------------------------

// Next occurrence (≥ from) of a given ET weekday and ET wall-clock time.
// weekday: 0 = Sun … 6 = Sat. Used for the EIA weekly releases.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function etWeekdayOf(utcMs: number): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "weekday")?.value as keyof typeof WEEKDAYS;
  return WEEKDAYS[name] ?? -1;
}

function nextEtWeekday(
  weekday: number,
  hourEt: number,
  minuteEt: number,
  from: number,
): number {
  // Probe day-by-day. Hitting the target weekday isn't enough — same-day
  // probes must still happen *after* `from`, hence the explicit time compare
  // at the end.
  for (let i = 0; i < 14; i++) {
    const probeUtc = from + i * 86_400_000;
    if (etWeekdayOf(probeUtc) !== weekday) continue;
    const ymd = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(probeUtc));
    const y = Number(ymd.find((p) => p.type === "year")?.value);
    const m = Number(ymd.find((p) => p.type === "month")?.value);
    const d = Number(ymd.find((p) => p.type === "day")?.value);
    const instant = etInstant(y, m, d, hourEt, minuteEt);
    if (instant >= from) return instant;
  }
  return from + 7 * 86_400_000;
}

// First Friday (or any weekday) of a calendar month, interpreted in ET.
function nthEtWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): { y: number; m: number; d: number } {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const probeUtc = etInstant(year, month, day, 12, 0); // noon ET avoids DST edge cases
    if (etWeekdayOf(probeUtc) === weekday) {
      count++;
      if (count === n) return { y: year, m: month, d: day };
    }
  }
  // Shouldn't happen for any valid (month, weekday, n=1..4).
  return { y: year, m: month, d: 1 };
}

// --- builders --------------------------------------------------------------

// Next N first-Fridays-of-month NFP releases (08:30 ET = BLS publication time).
function nfpEvents(from: number, count: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  // Walk forward month-by-month from `from`'s month in ET.
  const startYmd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(from));
  let y = Number(startYmd.find((p) => p.type === "year")?.value);
  let m = Number(startYmd.find((p) => p.type === "month")?.value);
  while (out.length < count) {
    const { y: yy, m: mm, d } = nthEtWeekdayOfMonth(y, m, 5, 1);
    const t = etInstant(yy, mm, d, 8, 30);
    if (t >= from) {
      out.push({
        id: `nfp-${yy}-${mm}`,
        title: "US Nonfarm Payrolls",
        source: "BLS",
        timeMs: t,
        impact: "high",
        affects: ["*"],
        description: "Monthly jobs report — biggest scheduled USD move.",
        url: "https://www.bls.gov/schedule/news_release/empsit.htm",
      });
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// EIA Weekly Petroleum Status Report — Wednesdays at 10:30 AM ET.
function eiaCrudeEvents(from: number, count: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  let probe = from;
  while (out.length < count) {
    const t = nextEtWeekday(3, 10, 30, probe);
    out.push({
      id: `eia-crude-${t}`,
      title: "EIA Weekly Petroleum Status",
      source: "EIA",
      timeMs: t,
      impact: "high",
      affects: ["commodities"],
      description: "US crude & product inventories — moves WTI / Brent.",
      url: "https://www.eia.gov/petroleum/supply/weekly/",
    });
    probe = t + 60_000; // step past this one for the next iteration
  }
  return out;
}

// EIA Weekly Natural Gas Storage — Thursdays at 10:30 AM ET.
function eiaGasEvents(from: number, count: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  let probe = from;
  while (out.length < count) {
    const t = nextEtWeekday(4, 10, 30, probe);
    out.push({
      id: `eia-gas-${t}`,
      title: "EIA Weekly Natural Gas Storage",
      source: "EIA",
      timeMs: t,
      impact: "high",
      affects: ["commodities"],
      description: "Working gas in underground storage — moves NG / TTF.",
      url: "https://ir.eia.gov/ngs/ngs.html",
    });
    probe = t + 60_000;
  }
  return out;
}

// USDA WASDE — World Agricultural Supply & Demand Estimates. Released around
// the 10th-12th of each month at noon ET. Exact day shifts; we approximate
// with "10th of month or next business day-ish" — close enough for an
// upcoming-events list.
function wasdeEvents(from: number, count: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const startYmd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(from));
  let y = Number(startYmd.find((p) => p.type === "year")?.value);
  let m = Number(startYmd.find((p) => p.type === "month")?.value);
  while (out.length < count) {
    const t = etInstant(y, m, 10, 12, 0);
    if (t >= from) {
      out.push({
        id: `wasde-${y}-${m}`,
        title: "USDA WASDE",
        source: "USDA",
        timeMs: t,
        impact: "medium",
        affects: ["commodities"],
        description: "World Ag Supply & Demand — moves corn / wheat / soy.",
        url: "https://www.usda.gov/oce/commodity/wasde",
      });
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// --- static one-off list --------------------------------------------------

// FOMC 2026 statement dates (day 2 of each two-day meeting) at 14:00 ET.
// Source: Federal Reserve "2026 FOMC Meetings" calendar. Update annually.
// As of: 2026-05-28.
const FOMC_2026: { month: number; day: number; sep?: boolean }[] = [
  { month: 1, day: 28, sep: true }, // SEP = Summary of Economic Projections released
  { month: 3, day: 18, sep: true },
  { month: 4, day: 29 },
  { month: 6, day: 17, sep: true },
  { month: 7, day: 29 },
  { month: 9, day: 16, sep: true },
  { month: 10, day: 28 },
  { month: 12, day: 9, sep: true },
];

function fomcEvents(from: number): CalendarEvent[] {
  return FOMC_2026.map(({ month, day, sep }) => {
    const t = etInstant(2026, month, day, 14, 0);
    return {
      id: `fomc-2026-${month}-${day}`,
      title: sep ? "FOMC Decision + SEP" : "FOMC Decision",
      source: "Fed",
      timeMs: t,
      impact: "high" as EventImpact,
      affects: ["*"] as Category[],
      description: sep
        ? "Rate decision + Summary of Economic Projections + Powell presser."
        : "Rate decision + Powell presser at 2:30 PM ET.",
      url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    };
  }).filter((e) => e.timeMs >= from);
}

// --- aggregation -----------------------------------------------------------

// Combined, time-sorted upcoming events scoped to the given coin category.
// `category` is HL's annotation category (e.g. "commodities") or null for
// uncategorized (crypto / spot perps); in either case macro events affecting
// "*" are always included.
export function upcomingEvents(
  category: string | null,
  fromMs: number,
  count: number,
): CalendarEvent[] {
  // HL has at least one stray-cased value ("FX") alongside the canonical
  // lowercase ones; normalize so the filter doesn't miss it.
  const cat = (category ?? "crypto").toLowerCase() as Category;
  // Pull a few extra of each recurring kind so the merged list has enough to
  // fill the requested count after time-sort and category filter.
  const N = Math.max(count, 6);
  const all: CalendarEvent[] = [
    ...nfpEvents(fromMs, N),
    ...eiaCrudeEvents(fromMs, N),
    ...eiaGasEvents(fromMs, N),
    ...wasdeEvents(fromMs, N),
    ...fomcEvents(fromMs),
  ];
  return all
    .filter((e) => e.affects.includes("*") || e.affects.includes(cat))
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, count);
}
