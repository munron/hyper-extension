// HYPE spot-ETF daily net flows, scraped from farside.co.uk/hyp/.
//
// farside.co.uk is the de-facto public source for ETF flow tables. The HYPE
// page renders a `<table class="etf">` (one row per trading day, one column
// per issuer, plus a trailing "Total" column) followed by summary rows
// (Total / Average / Maximum / Minimum). All figures are in MILLIONS of USD;
// a daily outflow shows as (parentheses), and "-" / "0.0" mean no flow.
//
// Table quirks (verified against the live HYPE page, 2026-05):
//   * The page has OTHER tables first (class="thead" nav, class="tfooter"),
//     so we must target class="etf" specifically — not "the first table".
//   * There is NO "Date" header cell. The first column header is blank; the
//     issuer tickers (e.g. BHYP, THYP) live in the SECOND <thead> row, while
//     the first row only has issuer logos. So we locate the ticker row by
//     pattern, and detect data rows by "first cell parses as a date".
//
// NOTE on Cloudflare: farside sits behind a Cloudflare challenge. A plain
// server-side fetch gets 403, but this runs inside the user's real Chrome via
// the extension (real TLS fingerprint + any cf_clearance cookie, sent because
// manifest host_permissions allow credentialed fetch), which passes in
// practice. If the user has never opened farside in this browser we may still
// hit the interstitial; that case is surfaced as a clear, actionable error.

const FARSIDE_URL = "https://farside.co.uk/hyp/";

export type EtfFlowDay = {
  date: string; // YYYY-MM-DD
  netFlowUsd: number; // daily total net flow in USD (negative = outflow)
  perTicker: Record<string, number>; // issuer ticker -> USD net flow that day
};

const MILLION = 1_000_000;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// farside dates look like "12 May 2026"; anything else (header / footer
// summary rows such as Fee / Total / Average) returns "" and is skipped.
function parseDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return "";
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return "";
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

// figures are $millions: "" / "-" -> 0; "(12.3)" -> -12.3; "1,234.5" -> 1234.5.
function parseMillions(raw: string): number {
  const t = raw.replace(/,/g, "").replace(/−/g, "-").trim();
  if (t === "" || t === "-") return 0;
  const paren = t.match(/^\(([\d.]+)\)$/);
  if (paren) return -parseFloat(paren[1]);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function cellsOf(row: string): string[] {
  return (row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(stripTags);
}

export async function fetchHypeEtfFlow(): Promise<EtfFlowDay[]> {
  const res = await fetch(FARSIDE_URL, {
    credentials: "include",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) throw new Error(`farside: HTTP ${res.status}`);
  const html = await res.text();
  if (
    !/<table[^>]*class="[^"]*\betf\b/i.test(html) &&
    /just a moment|challenge-platform|cf[_-]chl/i.test(html)
  ) {
    throw new Error(
      "farside: Cloudflare challenge — open https://farside.co.uk/hyp/ once in this browser, then retry",
    );
  }
  return parseFarside(html);
}

// Exported for offline testing; parses the `<table class="etf">` flow table.
export function parseFarside(html: string): EtfFlowDay[] {
  const tableMatch = html.match(
    /<table\b[^>]*class="[^"]*\betf\b[^"]*"[^>]*>[\s\S]*?<\/table>/i,
  );
  if (!tableMatch) throw new Error("farside: no etf table found");
  const table = tableMatch[0];

  const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(cellsOf);
  if (!rows.length) throw new Error("farside: no table rows");

  const ncols = rows.reduce((m, c) => Math.max(m, c.length), 0);

  // "Total" column index from a header row (the cell labelled "Total", which
  // is never in column 0 — that's where the summary-row "Total" label sits).
  let totalIdx = -1;
  for (const cells of rows) {
    if (parseDate(cells[0] || "")) continue;
    const i = cells.findIndex((c, idx) => idx > 0 && /^total$/i.test(c));
    if (i >= 0) {
      totalIdx = i;
      break;
    }
  }
  if (totalIdx < 0) totalIdx = ncols - 1;

  // Issuer tickers live in the header row whose middle cells look most like
  // ticker symbols (e.g. BHYP, THYP) — not the logo row or the Fee/Staking
  // rows. Score each non-data header row and take the best.
  const isTicker = (c: string) => /^[A-Z][A-Z0-9]{1,5}$/.test(c);
  let tickers: string[] = [];
  let bestScore = 0;
  for (const cells of rows) {
    if (parseDate(cells[0] || "")) continue;
    const mid = cells.slice(1, totalIdx);
    const score = mid.filter(isTicker).length;
    if (score > bestScore) {
      bestScore = score;
      tickers = mid;
    }
  }
  // Fall back to positional names if farside ever drops the ticker row.
  if (!tickers.length) {
    tickers = Array.from({ length: Math.max(0, totalIdx - 1) }, (_v, i) => `ETF${i + 1}`);
  }

  const days: EtfFlowDay[] = [];
  for (const cells of rows) {
    const date = parseDate(cells[0] || "");
    if (!date) continue; // skip header / footer summary rows

    const perTicker: Record<string, number> = {};
    tickers.forEach((t, i) => {
      if (!t) return;
      const v = parseMillions(cells[i + 1] || "");
      if (v !== 0) perTicker[t] = v * MILLION;
    });

    const totalM = parseMillions(cells[totalIdx] || "");
    days.push({ date, netFlowUsd: totalM * MILLION, perTicker });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}
