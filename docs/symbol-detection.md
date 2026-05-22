# Symbol Detection

How the extension determines which Hyperliquid symbol the user is currently
viewing, and how the URL-facing identifier is resolved to the internal coin id
used by the Hyperliquid `info` API.

## Source of truth: the active tab URL

The side panel runs in an extension context and inspects the active tab via
`chrome.tabs`:

```ts
const [tab] = await chrome.tabs.query({
  active: true,
  lastFocusedWindow: true,
});
```

The URL is matched against `https://app.hyperliquid.xyz/trade/{symbol}`. The
captured `{symbol}` is the **URL-form identifier** — what Hyperliquid displays
in the address bar — not necessarily the identifier the `info` API expects.

Two URL shapes occur:

| URL form              | Example                | Meaning                       |
| --------------------- | ---------------------- | ----------------------------- |
| Plain ticker          | `/trade/HYPE`          | A standard perp on the main DEX |
| `{dex}:{displayName}` | `/trade/xyz:WTIOIL`    | A HIP-3 builder-deployed perp |

When the active tab is not a Hyperliquid trade page, the side panel falls back
to `HYPE` as a default.

## Reactive updates

Three Chrome events drive a re-read of the active tab:

| Event                              | When it fires                                  |
| ---------------------------------- | ---------------------------------------------- |
| `chrome.tabs.onActivated`          | User switches to a different tab               |
| `chrome.tabs.onUpdated` (with `changeInfo.url`) | URL changes inside the current tab |
| `chrome.windows.onFocusChanged`    | User switches Chrome window                    |

Hyperliquid is a SPA, so for plain ticker pages the URL **does** change on
symbol switch (path segment is rewritten). There are still UI flows where the
internal state changes without a URL change; those are not covered today (see
[Known limitations](#known-limitations)).

## The URL identifier ≠ API coin id problem

For HIP-3 DEX coins, the URL uses the **display name** while the `info` API
expects the **internal coin id**:

```
URL path:        xyz:WTIOIL                  ← human-readable display name
info API body:   { "coin": "xyz:CL", ... }   ← internal coin id
```

The extension therefore maintains a reverse map keyed by display name.

## Building the reverse map: `perpConciseAnnotations`

A single request to the info endpoint returns annotation tuples for every
DEX-deployed coin across all HIP-3 perp DEXs:

```http
POST https://api-ui.hyperliquid.xyz/info
Content-Type: application/json

{ "type": "perpConciseAnnotations" }
```

```json
[
  ["km:USTECH", { "category": "indices",     "displayName": "USTECH100" }],
  ["para:BTCD", { "category": "crypto",      "displayName": "BTC.D",
                  "keywords": ["dominance", "index"] }],
  ["xyz:CL",    { "category": "commodities", "displayName": "WTIOIL",
                  "keywords": ["crude", "CL"] }],
  ...
]
```

For each entry, two lookup keys are inserted into the reverse map, both
lowercased so lookups are case-insensitive:

1. **Bare display name** — `wtioil → xyz:CL`
2. **Dex-prefixed display name** — `xyz:wtioil → xyz:CL`

Form (2) is what we actually need to resolve the URL form `xyz:WTIOIL`, but
form (1) is kept as a convenience so unprefixed lookups still work.

Standard perps (`BTC`, `HYPE`, …) are not in this response — they do not have
annotations.

### Caching

The built index is serialised to `chrome.storage.local` under
`hyperliquid:coinIndex` with a 6-hour TTL. Subsequent side-panel mounts read
from the cache and skip the network call. The cache is rebuilt on its own when
expired.

A one-time **re-fetch** is also triggered if the URL contains a `:` but the
current index cannot resolve it — this catches the case where a freshly
deployed HIP-3 coin appears before the cache TTL has elapsed.

### Why not query `perpAnnotation` per coin?

An earlier iteration walked the universe of every DEX and called
`perpAnnotation` once per coin. That issued hundreds of requests during a cold
start and triggered Hyperliquid's UI-level rate-limit warning. The
`perpConciseAnnotations` endpoint replaces that whole fan-out with a single
request. On-demand `perpAnnotation` calls are still made, but only **once per
viewed symbol** — to fetch the long-form `description`, which `concise` omits.

## Resolution flow

```
URL pathname /trade/{X}
       │
       ▼
 extractCoinFromUrl(url)  →  raw = X       (or null → fall back to "HYPE")
       │
       ▼
 resolveCoinId(coinIndex, raw):
       │
       ├── 1. raw is a known coin id?                  → return raw
       ├── 2. raw (lowercased) hits the reverse map?   → return that coin id
       └── 3. otherwise                                → return raw unchanged
       │
       ▼
 coinId  ──► fetchPerpAnnotation(coinId) for description
         └─► coinIndex.annotations[coinId] for concise fields (category, keywords)
         └─► fetchMeta() universe lookup as a fallback for standard perps
```

If `resolveCoinId` returned the input unchanged because no map entry matched,
and the input looks like a DEX symbol (`contains ":"`), the index is rebuilt
once in the background and the resolution is retried on the next render.

## Known limitations

- **URL is the only signal**. If Hyperliquid changes the active symbol via
  internal SPA state without rewriting the path, the side panel will not see
  it. Mitigation would be a content script injected into
  `app.hyperliquid.xyz` that observes the in-page state.
- **Standard perps have no annotation**. For `HYPE`, `BTC`, … the API returns
  `null` for `perpAnnotation` and there is no entry in
  `perpConciseAnnotations`. The side panel falls back to displaying the
  universe entry from `meta` (max leverage, size decimals).
- **Display-name collisions across DEXs** are resolved on a first-write-wins
  basis for the bare-name key. The dex-prefixed key (`xyz:wtioil`) is always
  unambiguous and is what URL-driven lookups actually use.

## Relevant files

- [`src/lib/symbol.ts`](../src/lib/symbol.ts) — URL parsing
- [`src/lib/hyperliquid.ts`](../src/lib/hyperliquid.ts) — `info` API clients
- [`src/lib/coinMap.ts`](../src/lib/coinMap.ts) — reverse map build + cache + resolver
- [`src/sidepanel/App.tsx`](../src/sidepanel/App.tsx) — tab listeners, resolution glue, rendering
