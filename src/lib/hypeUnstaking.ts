// HYPE unstaking queue client + analytics.
//
// Hyperliquid's staking module enforces a delayed unstake — once a user starts
// an unstake, the tokens become spendable only after the queue's release time.
// Hypurrscan publishes the full queue (~thousands of pending entries) at
// /unstakingQueue. The shape is a flat list of {time, user, wei}; we layer
// binning + ranking on top so the panel can show "when does the next big
// unlock land?" without re-deriving stats on every render.

const ENDPOINT = "https://api.hypurrscan.io/unstakingQueue";

// HL stores HYPE in 8-decimal "wei" units (1 HYPE = 1e8 wei). Same convention
// as BTC's satoshi or USD-as-cents — keeps server payloads as integers.
const HYPE_PER_WEI = 1e8;

export type RawUnstakeEntry = {
  time: number; // ms epoch — the moment funds unlock
  user: string;
  wei: number;
};

export type UnstakeEntry = {
  time: number;
  user: string;
  hype: number; // wei normalized to HYPE units
};

export async function fetchUnstakingQueue(): Promise<UnstakeEntry[]> {
  const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`hypurrscan unstakingQueue ${res.status}`);
  const j = (await res.json()) as RawUnstakeEntry[];
  return j
    .map((e) => ({ time: e.time, user: e.user, hype: e.wei / HYPE_PER_WEI }))
    .sort((a, b) => a.time - b.time);
}

// --- aggregate analytics ---------------------------------------------------

export type UnstakeBin = {
  // Bin's start in ms epoch; bin spans [start, start + binMs).
  start: number;
  hype: number;
  count: number;
};

// Bucket entries into fixed-width time bins covering [fromMs, toMs). Empty
// bins are emitted as zeros so the histogram has a continuous x-axis.
export function binByTime(
  entries: UnstakeEntry[],
  fromMs: number,
  toMs: number,
  binMs: number,
): UnstakeBin[] {
  const n = Math.max(1, Math.ceil((toMs - fromMs) / binMs));
  const bins: UnstakeBin[] = [];
  for (let i = 0; i < n; i++) {
    bins.push({ start: fromMs + i * binMs, hype: 0, count: 0 });
  }
  for (const e of entries) {
    if (e.time < fromMs || e.time >= toMs) continue;
    const idx = Math.min(n - 1, Math.floor((e.time - fromMs) / binMs));
    bins[idx].hype += e.hype;
    bins[idx].count += 1;
  }
  return bins;
}

export type UnstakeSummary = {
  totalHype: number;
  totalCount: number;
  windowStart: number; // earliest entry time
  windowEnd: number; // latest entry time
  next24hHype: number;
  next7dHype: number;
  // Largest individual unlock anywhere in the (future) queue.
  biggestEntry: UnstakeEntry | null;
  // Largest individual unlock landing within the next 48h. This is the trader's
  // "is something scary about to hit?" signal — anchored on a short horizon so
  // it doesn't get drowned out by a giant 13-day-out unlock.
  nextBigEntry: UnstakeEntry | null;
  // Threshold used by the panel's "whale" markers (top-3% by size, lower
  // bounded so dust queues don't all light up).
  whaleThreshold: number;
};

const NEAR_BIG_HORIZON_MS = 48 * 3_600_000;
const MIN_WHALE_HYPE = 50_000; // below this we don't bother marking

export function summarize(
  entries: UnstakeEntry[],
  nowMs: number,
): UnstakeSummary {
  const future = entries.filter((e) => e.time >= nowMs);
  const totalHype = entries.reduce((s, e) => s + e.hype, 0);
  const next24h = future
    .filter((e) => e.time < nowMs + 24 * 3_600_000)
    .reduce((s, e) => s + e.hype, 0);
  const next7d = future
    .filter((e) => e.time < nowMs + 7 * 86_400_000)
    .reduce((s, e) => s + e.hype, 0);

  // Whale threshold = 97th percentile of remaining-queue sizes, floored at the
  // hard minimum so a small queue doesn't make every entry a "whale".
  const sizes = future.map((e) => e.hype).sort((a, b) => a - b);
  const p97 =
    sizes.length > 0
      ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.97))]
      : 0;
  const whaleThreshold = Math.max(MIN_WHALE_HYPE, p97);

  const biggest =
    future.length > 0
      ? future.reduce((a, b) => (b.hype > a.hype ? b : a))
      : null;

  const nearWindow = future.filter(
    (e) => e.time < nowMs + NEAR_BIG_HORIZON_MS,
  );
  const nextBig =
    nearWindow.length > 0
      ? nearWindow.reduce((a, b) => (b.hype > a.hype ? b : a))
      : null;

  return {
    totalHype,
    totalCount: entries.length,
    windowStart: entries.length > 0 ? entries[0].time : nowMs,
    windowEnd:
      entries.length > 0 ? entries[entries.length - 1].time : nowMs,
    next24hHype: next24h,
    next7dHype: next7d,
    biggestEntry: biggest,
    nextBigEntry: nextBig,
    whaleThreshold,
  };
}

// Top-N upcoming entries by size — used for the "biggest queued" list.
export function topUpcoming(
  entries: UnstakeEntry[],
  nowMs: number,
  n: number,
): UnstakeEntry[] {
  return entries
    .filter((e) => e.time >= nowMs)
    .sort((a, b) => b.hype - a.hype)
    .slice(0, n);
}
