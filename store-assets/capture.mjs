// Capture clean side-panel screenshots for the store assets.
// Loads the built unpacked extension in a headed Chromium, opens the side-panel
// page directly (chrome-extension://<id>/src/sidepanel/index.html) with the
// ?coin&tab capture override, waits for live data, and screenshots full-page.
//
// Run: node store-assets/capture.mjs   (needs `npm i -D playwright` + chromium)

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const OUT = resolve(__dirname, "raw2");
mkdirSync(OUT, { recursive: true });

// Panel render width (≈ a real Chrome side panel) × DPR for crisp captures.
const PANEL_W = 440;
const DPR = 3;
// How long to let each tab's live fetches + charts settle before the shot.
const SETTLE_MS = 5000;

// (name, coin, tab) — a couple of coins per data-heavy tab so compose can pick
// the best-looking one.
const SHOTS = [
  ["twap-btc", "BTC", "twaps"],
  ["twap-hype", "HYPE", "twaps"],
  ["fr-hype", "HYPE", "funding"],
  ["fr-btc", "BTC", "funding"],
  ["liq-btc", "BTC", "liquidation"],
  ["liq-eth", "ETH", "liquidation"],
  ["stops-btc", "BTC", "stops"],
  ["arb-btc", "BTC", "arb"],
  ["arb-hype", "HYPE", "arb"],
  ["news-hype", "HYPE", "news"],
  ["news-btc", "BTC", "news"],
  ["revenue-hype", "HYPE", "revenue"],
  ["etf-hype", "HYPE", "etf"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: PANEL_W, height: 1600 },
  deviceScaleFactor: DPR,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

// Discover the extension id from its MV3 service worker.
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log("extension id:", extId);

const base = `chrome-extension://${extId}/src/sidepanel/index.html`;
const page = await context.newPage();

for (const [name, coin, tab] of SHOTS) {
  const url = `${base}?coin=${encodeURIComponent(coin)}&tab=${tab}`;
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    // networkidle can time out on panels that keep polling — that's fine.
  }
  await sleep(SETTLE_MS);
  const out = resolve(OUT, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log("saved", out);
}

await context.close();
console.log("done");
