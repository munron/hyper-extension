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
import HypurrNftChart from "./HypurrNftChart";

const DEFAULT_RAW_COIN = "HYPE";

type TabId = "twaps" | "funding" | "liquidation" | "stops" | "nft";

type TabDef = {
  id: TabId;
  label: string;
  isAvailable: (ctx: {
    coin: string;
    hasPerp: boolean;
    hasMainPerp: boolean;
  }) => boolean;
};

// FR works for any HL perp (incl. sub-DEX commodities/stocks/FX), but
// Liquidation/Stops rely on main-DEX-only data (Hyperdash bands), so those
// tabs stay gated on the strict main-DEX flag.
const TABS: TabDef[] = [
  { id: "twaps", label: "TWAPs", isAvailable: () => true },
  { id: "funding", label: "FR", isAvailable: (c) => c.hasPerp },
  { id: "liquidation", label: "Liquidation", isAvailable: (c) => c.hasMainPerp },
  { id: "stops", label: "Stops", isAvailable: (c) => c.hasMainPerp },
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
              className="coin-icon"
              src={`https://app.hyperliquid.xyz/coins/${encodeURIComponent(resolvedCoinId)}.svg`}
              alt=""
              aria-hidden="true"
            />
            <h1>{displayName}</h1>
            {annotation?.category && <span className="badge">{annotation.category}</span>}
          </div>
          <img
            className="brand-icon"
            src={chrome.runtime.getURL("icon.png")}
            alt="Hypurr Extension"
            title="Hypurr Extension"
          />
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
        <>
          <FundingRatePanel coin={resolvedCoinId} coinIndex={coinIndex} refreshKey={refreshKey} />
          <FundingComparePanel coin={resolvedCoinId} refreshKey={refreshKey} />
        </>
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
      {activeTab === "nft" && (
        <HypurrNftChart coin={resolvedCoinId} refreshKey={refreshKey} />
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
  const visible = TABS.filter((t) =>
    t.isAvailable({ coin, hasPerp, hasMainPerp }),
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
