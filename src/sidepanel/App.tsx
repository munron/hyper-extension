import { useCallback, useEffect, useRef, useState } from "react";
import {
  // fetchMeta,
  // fetchPerpAnnotation,
  // type Meta,
  // type MetaUniverseAsset,
  type PerpAnnotation,
} from "../lib/hyperliquid";
import {
  buildCoinIndex,
  getCoinIndex,
  resolveCoinId,
  type CoinIndex,
} from "../lib/coinMap";
import { extractCoinFromUrl } from "../lib/symbol";
import TwapPanel from "./TwapPanel";
import LiquidationMap from "./LiquidationMap";
import StopOrderMap from "./StopOrderMap";
import FundingRatePanel from "./FundingRatePanel";
import FundingComparePanel from "./FundingComparePanel";
import StocksPanel from "./StocksPanel";
import HypurrNftChart from "./HypurrNftChart";
import EventsPanel from "./EventsPanel";
import HypeUnstakingPanel from "./HypeUnstakingPanel";
import HypeStatsPanel from "./HypeStatsPanel";
import MstrPanel from "./MstrPanel";
import PredictPanel from "./PredictPanel";
import NewsPanel from "./NewsPanel";
import { isCryptoCoin } from "../lib/polymarket";
import {
  fetchReferralState,
  readStoredAddress,
  subscribeStoredAddress,
  type ReferralState,
} from "../lib/hlReferral";

const DEFAULT_RAW_COIN = "HYPE";

type TabId =
  | "twaps"
  | "funding"
  | "arb"
  | "news"
  | "predict"
  | "events"
  | "unstake"
  | "stats"
  | "liquidation"
  | "stops"
  | "stocks"
  | "mstr"
  | "nft";

type TabDef = {
  id: TabId;
  label: string;
  isAvailable: (ctx: {
    coin: string;
    hasPerp: boolean;
    hasMainPerp: boolean;
    category: string | null;
  }) => boolean;
};

// FR works for any HL perp (incl. sub-DEX commodities/stocks/FX), but
// Liquidation/Stops rely on main-DEX-only data (Hyperdash bands), so those
// tabs stay gated on the strict main-DEX flag. Stocks appears when HL's own
// annotation tags the coin as a stock (Yahoo Finance backs the data).
// Ordered for a trader's read on a fresh coin:
//   1. Live flow & positioning signals you act on first
//      (order flow → funding → liquidation/stop levels)
//   2. Cross-venue edge (Arb basis)
//   3. Research / context (News, Events, Stocks fundamentals)
//   4. HYPE-only deep dives (Stats, Unstake, NFT) last
// TWAPs stays leftmost: it's always-available (good default) and order flow is
// the first thing to scan.
const TABS: TabDef[] = [
  { id: "twaps", label: "TWAPs", isAvailable: () => true },
  { id: "funding", label: "FR", isAvailable: (c) => c.hasPerp },
  // Liquidation/Stops rely on main-DEX-only data (Hyperdash bands), so they're
  // gated on the strict main-DEX flag.
  { id: "liquidation", label: "Liquidation", isAvailable: (c) => c.hasMainPerp },
  { id: "stops", label: "Stops", isAvailable: (c) => c.hasMainPerp },
  { id: "arb", label: "Arb", isAvailable: (c) => c.hasPerp },
  // News/buzz works for any symbol — keyless Google News search.
  { id: "news", label: "News", isAvailable: () => true },
  // Prediction-market sentiment (Polymarket): short-term up/down odds for the
  // majors, related event markets for other crypto. Crypto-only.
  { id: "predict", label: "Predict", isAvailable: (c) => isCryptoCoin(c.category) },
  // Events only matter for HL's real-world-asset perps — equities, indices,
  // commodities, FX, pre-IPO. Pure crypto tickers carry no macro calendar
  // hooks worth showing, so hide the tab there.
  {
    id: "events",
    label: "Events",
    isAvailable: (c) =>
      c.category != null &&
      ["stocks", "indices", "commodities", "fx", "preipo"].includes(
        c.category.toLowerCase(),
      ),
  },
  { id: "stocks", label: "Stocks", isAvailable: (c) => c.category === "stocks" },
  // Strategy (MSTR) is the largest corporate BTC holder; its accumulation &
  // mNAV are BTC-demand signals, so this deep-dive is BTC-only.
  { id: "mstr", label: "MSTR", isAvailable: (c) => c.coin === "BTC" },
  // Protocol-level stats (fees, AF buybacks, burn) — HYPE only.
  { id: "stats", label: "Stats", isAvailable: (c) => c.coin === "HYPE" },
  // HYPE has its own unstaking queue (Hyperliquid native staking) that
  // traders watch for incoming sell pressure. Tab is HYPE-only.
  { id: "unstake", label: "Unstake", isAvailable: (c) => c.coin === "HYPE" },
  { id: "nft", label: "NFT", isAvailable: (c) => c.coin === "HYPE" },
];

// Returns the coin for the active tab's Hyperliquid trade page, or null
// when the active tab isn't such a page. Null means "no coin context" —
// callers keep whatever coin was last shown rather than snapping back to
// the default.
async function readActiveCoin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return extractCoinFromUrl(tab?.url);
}

// function findUniverseAsset(meta: Meta | null, coinId: string): MetaUniverseAsset | null {
//   if (!meta) return null;
//   return meta.universe.find((a) => a.name === coinId) ?? null;
// }

export default function App() {
  const [rawCoin, setRawCoin] = useState(DEFAULT_RAW_COIN);
  const [coinIndex, setCoinIndex] = useState<CoinIndex | null>(null);
  const [indexBuilding, setIndexBuilding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("twaps");
  // const [annotation, setAnnotation] = useState<PerpAnnotation | null>(null);
  // const [detailLoading, setDetailLoading] = useState(false);
  // const [meta, setMeta] = useState<Meta | null>(null);
  // const [error, setError] = useState<string | null>(null);
  const rebuildTriedRef = useRef(false);
  const [referral, setReferral] = useState<ReferralState>({ kind: "unknown" });

  // The content script on app.hyperliquid.xyz pushes the connected wallet
  // into chrome.storage; we hydrate from it, watch for live changes, and
  // re-check referral state whenever the address rotates.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (addr: string | null) => {
      if (!addr) {
        if (!cancelled) setReferral({ kind: "unknown" });
        return;
      }
      try {
        const next = await fetchReferralState(addr);
        if (!cancelled) setReferral(next);
      } catch {
        // Soft-fail: keep showing the invite pill if we can't tell.
        if (!cancelled) setReferral({ kind: "unknown" });
      }
    };
    void readStoredAddress().then(refresh);
    const unsub = subscribeStoredAddress(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Heartbeat so the content script on app.hyperliquid.xyz only redirects to
  // /join/HYPURREXT when the sidepanel is actually open. Avoids hijacking the
  // tab when the user isn't even looking at the extension.
  useEffect(() => {
    const beat = () => {
      void chrome.storage.local.set({ hlSidepanelHeartbeat: Date.now() });
    };
    beat();
    const id = setInterval(beat, 3000);
    const clearBeat = () => {
      void chrome.storage.local.set({ hlSidepanelHeartbeat: 0 });
    };
    window.addEventListener("pagehide", clearBeat);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", clearBeat);
      clearBeat();
    };
  }, []);

  // Resolves to true when the active tab is a Hyperliquid trade page (so
  // the coin was updated to follow it), false when it isn't (coin left
  // untouched). Lets callers refresh only when there's a live coin page.
  const syncFromActiveTab = useCallback(async (): Promise<boolean> => {
    const next = await readActiveCoin();
    if (next === null) return false;
    setRawCoin((prev) => (prev === next ? prev : next));
    return true;
  }, []);

  useEffect(() => {
    void syncFromActiveTab();

    const bump = () => setRefreshKey((k) => k + 1);
    // Only refresh when we're actually on a coin page. Off-page tab/focus
    // changes leave the panel — and any interactive state like clicked
    // liquidation bands — frozen on the last coin.
    const syncAndMaybeBump = () => {
      void syncFromActiveTab().then((onCoinPage) => {
        if (onCoinPage) bump();
      });
    };
    const onActivated = () => syncAndMaybeBump();
    const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (_id, changeInfo) => {
      if (changeInfo.url) syncAndMaybeBump();
    };
    const onFocusChanged = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) syncAndMaybeBump();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    };
  }, [syncFromActiveTab]);

  // Load coin index (cache or fetch perpConciseAnnotations) on mount.
  useEffect(() => {
    let cancelled = false;
    setIndexBuilding(true);
    getCoinIndex()
      .then((next) => {
        if (!cancelled) setCoinIndex(next);
      })
      .catch((e: unknown) => console.error("Failed to load coin index", e))
      .finally(() => {
        if (!cancelled) setIndexBuilding(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // // Load perp meta universe once.
  // useEffect(() => {
  //   let cancelled = false;
  //   fetchMeta()
  //     .then((m) => {
  //       if (!cancelled) setMeta(m);
  //     })
  //     .catch((e: unknown) => {
  //       if (!cancelled) console.error("Failed to fetch meta", e);
  //     });
  //   return () => {
  //     cancelled = true;
  //   };
  // }, []);

  const resolvedCoinId = resolveCoinId(coinIndex, rawCoin);

  // // Show concise annotation immediately, then fetch detail (description) in background.
  // useEffect(() => {
  //   let cancelled = false;
  //   setError(null);
  //
  //   const concise = coinIndex?.annotations[resolvedCoinId] ?? null;
  //   setAnnotation(concise);
  //
  //   setDetailLoading(true);
  //   fetchPerpAnnotation(resolvedCoinId)
  //     .then((detail) => {
  //       if (cancelled) return;
  //       if (!detail) return; // keep concise (or null)
  //       setAnnotation((prev) => ({ ...(prev ?? {}), ...detail }));
  //     })
  //     .catch((e: unknown) => {
  //       if (!cancelled) setError(e instanceof Error ? e.message : String(e));
  //     })
  //     .finally(() => {
  //       if (!cancelled) setDetailLoading(false);
  //     });
  //   return () => {
  //     cancelled = true;
  //   };
  // }, [resolvedCoinId, coinIndex]);

  // If we still can't resolve a DEX-style URL symbol, refresh the index once (cache may be stale).
  useEffect(() => {
    if (!coinIndex || indexBuilding) return;
    if (rebuildTriedRef.current) return;
    if (!rawCoin.includes(":")) return;
    if (coinIndex.annotations[rawCoin]) return;
    if (resolveCoinId(coinIndex, rawCoin) !== rawCoin) return;
    rebuildTriedRef.current = true;
    setIndexBuilding(true);
    buildCoinIndex()
      .then((next) => setCoinIndex(next))
      .catch((e: unknown) => console.error("Failed to rebuild coin index", e))
      .finally(() => setIndexBuilding(false));
  }, [coinIndex, rawCoin, indexBuilding]);

  const annotation: PerpAnnotation | null = coinIndex?.annotations[resolvedCoinId] ?? null;
  // const universeAsset = findUniverseAsset(meta, resolvedCoinId);
  const displayName = annotation?.displayName ?? resolvedCoinId;
  // const hasAnnotation =
  //   annotation && (annotation.description || annotation.category || (annotation.keywords?.length ?? 0) > 0);

  return (
    <div className="container">
      <header className="header">
        <div className="header-top">
          <div className="title-row">
            <img
              key={resolvedCoinId}
              className="coin-icon"
              src={`https://app.hyperliquid.xyz/coins/${encodeURIComponent(resolvedCoinId)}.svg`}
              alt=""
              aria-hidden="true"
              onError={(e) => {
                // The remote coin SVG occasionally fails to load, which would
                // otherwise render as a bright "broken image" disc on the dark
                // header. Fall back to the bundled brand icon once.
                const img = e.currentTarget;
                if (img.dataset.fallback) return;
                img.dataset.fallback = "1";
                img.classList.add("fallback");
                img.src = chrome.runtime.getURL("icon.png");
              }}
            />
            <h1>
              <a
                className="coin-title-link"
                href={`https://app.hyperliquid.xyz/trade/${encodeURIComponent(resolvedCoinId)}`}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${resolvedCoinId} on Hyperliquid`}
              >
                {displayName}
              </a>
            </h1>
            {annotation?.category && <span className="badge">{annotation.category}</span>}
          </div>
          {referral.kind === "referred" ? (
            <div className="header-right" title="Referral code applied">
              <img
                className="brand-icon"
                src={chrome.runtime.getURL("icon.png")}
                alt="Hypurr Extension"
              />
            </div>
          ) : (
            <a
              className="invite-pill"
              href="https://app.hyperliquid.xyz/join/HYPURREXT"
              target="_blank"
              rel="noreferrer"
              title="Trade on Hyperliquid with 4% off fees via our referral"
            >
              <img
                className="invite-pill-icon"
                src={chrome.runtime.getURL("icon.png")}
                alt=""
                aria-hidden="true"
              />
              <span className="invite-pill-text">
                Trade <span className="invite-pill-dot">·</span> Save{" "}
                <span className="invite-pill-amt">4%</span>
              </span>
            </a>
          )}
        </div>

        {/*
        <div className="coin-id">
          {resolvedCoinId}
          {resolvedCoinId !== rawCoin && <span className="raw"> ← {rawCoin}</span>}
        </div>
        */}
      </header>

      <TabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        coin={resolvedCoinId}
        coinIndex={coinIndex}
      />

      {activeTab === "twaps" && (
        <TwapPanel coin={resolvedCoinId} coinIndex={coinIndex} refreshKey={refreshKey} />
      )}
      {activeTab === "funding" && (
        <FundingRatePanel coin={resolvedCoinId} coinIndex={coinIndex} refreshKey={refreshKey} />
      )}
      {activeTab === "arb" && (
        <FundingComparePanel
          coin={resolvedCoinId}
          category={annotation?.category ?? null}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "news" && (
        <NewsPanel
          coin={resolvedCoinId}
          displayName={displayName}
          category={annotation?.category ?? null}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "predict" && (
        <PredictPanel
          coin={resolvedCoinId}
          displayName={displayName}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "events" && (
        <EventsPanel
          coin={resolvedCoinId}
          category={annotation?.category ?? null}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "liquidation" && (
        <LiquidationMap
          coin={resolvedCoinId}
          coinIndex={coinIndex}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "stops" && (
        <StopOrderMap
          coin={resolvedCoinId}
          coinIndex={coinIndex}
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "stocks" && (
        <StocksPanel
          coin={resolvedCoinId}
          companyName={
            coinIndex?.annotations[resolvedCoinId]?.displayName ?? null
          }
          refreshKey={refreshKey}
        />
      )}
      {activeTab === "nft" && (
        <HypurrNftChart coin={resolvedCoinId} refreshKey={refreshKey} />
      )}
      {activeTab === "unstake" && (
        <HypeUnstakingPanel refreshKey={refreshKey} coinIndex={coinIndex} />
      )}
      {activeTab === "stats" && (
        <HypeStatsPanel refreshKey={refreshKey} />
      )}
      {activeTab === "mstr" && (
        <MstrPanel refreshKey={refreshKey} />
      )}

      {/*
      {indexBuilding && !coinIndex && (
        <div className="status">Loading symbol index…</div>
      )}

      {detailLoading && !hasAnnotation && !indexBuilding && (
        <div className="status">Loading…</div>
      )}

      {error && (
        <div className="status error">
          <strong>Failed to load annotation.</strong>
          <div>{error}</div>
        </div>
      )}

      {hasAnnotation && (
        <>
          {annotation?.description && <p className="description">{annotation.description}</p>}

          {annotation?.keywords && annotation.keywords.length > 0 && (
            <div className="keywords">
              {annotation.keywords.map((k) => (
                <span key={k} className="keyword">
                  {k}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {!hasAnnotation && universeAsset && !detailLoading && (
        <dl className="kv">
          <dt>Symbol</dt>
          <dd>{universeAsset.name}</dd>
          <dt>Max leverage</dt>
          <dd>{universeAsset.maxLeverage}x</dd>
          <dt>Size decimals</dt>
          <dd>{universeAsset.szDecimals}</dd>
          {universeAsset.onlyIsolated && (
            <>
              <dt>Margin</dt>
              <dd>Isolated only</dd>
            </>
          )}
        </dl>
      )}

      {!hasAnnotation && !universeAsset && !detailLoading && !indexBuilding && (
        <div className="status">No info available for {resolvedCoinId}.</div>
      )}
      */}
    </div>
  );
}

type TabBarProps = {
  activeTab: TabId;
  onChange: (id: TabId) => void;
  coin: string;
  coinIndex: CoinIndex | null;
};

function TabBar({ activeTab, onChange, coin, coinIndex }: TabBarProps) {
  const hasPerp = coinIndex
    ? coinIndex.perpAssetIdByCoin[coin] !== undefined
    : true;
  // Sub-DEX (xyz, flx, …) coins are namespaced like "xyz:BRENTOIL"; only
  // bare names belong to the main DEX where Hyperdash-backed liq/stop bands
  // exist.
  const hasMainPerp = hasPerp && !coin.includes(":");
  const category = coinIndex?.annotations[coin]?.category ?? null;
  const visible = TABS.filter((t) =>
    t.isAvailable({ coin, hasPerp, hasMainPerp, category }),
  );

  useEffect(() => {
    if (!visible.some((t) => t.id === activeTab)) {
      onChange(visible[0]?.id ?? "twaps");
    }
  }, [activeTab, visible, onChange]);

  return (
    <nav className="tabs" role="tablist">
      {visible.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={activeTab === t.id}
          className={`tab ${activeTab === t.id ? "active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
