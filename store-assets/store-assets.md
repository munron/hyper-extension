
## 1. 概要文 / Short description（132文字以内）
English (124 chars):

A side panel for Hyperliquid: TWAP flow, funding history, cross-venue basis, liquidation & stop maps, and per-coin news.


## 2. 詳細説明 / Detailed description（English・推奨）

Hypurr is a trader's side panel that rides along on app.hyperliquid.xyz.
It reads the coin from your active Hyperliquid tab and surfaces the context
you'd otherwise dig for across a dozen tabs and spreadsheets — live, and for
the exact coin in front of you. Switch coins and the panel follows.

ELEVEN TOOLS, ONE PANEL
• TWAP Order Flow — active TWAPs, buy/sell split, and projected buy pressure
  for the next 1h & 24h.
• Funding Rate — annualized funding history (1d / 7d / 30d) with trailing
  averages and a price-overlay sparkline.
• Liquidation Map — liquidation levels banded around price so you can see
  where cascades are stacked.
• Stop-Order Map — stop distribution by price band, buy vs sell.
• Cross-Venue Arb — funding & price basis vs Binance, Bybit, OKX and 7 more,
  with a 72h spread chart.
• News & Buzz — per-coin headlines ranked by recency and source quality.
• Economic Events — macro/commodity/equity catalysts scoped to the coin.
• Protocol Stats — Hyperliquid revenue, buybacks & burn, and HYPE ETF flows.
• Unstaking Queue — the 7-day HYPE unstaking queue and biggest queued unlocks.
• …and more, all in one panel.

HOW IT WORKS
Open app.hyperliquid.xyz, click the Hypurr icon to open the side panel, and
pick a coin. Every tool updates live from public APIs. No accounts, no API
keys, no setup.

PRIVACY
Hypurr reads only the coin/context from your Hyperliquid tab to fetch public
market data. It does not collect, store, or transmit your personal data,
wallet keys, or trades to any server we control.

Not affiliated with Hyperliquid. Independent, open-source browser tool.
Nothing here is financial advice — markets are risky and you can lose money.
Data comes from public APIs (Hyperliquid, Hyperdash, Hypurrscan, Yahoo
Finance, OpenSea, Google News, farside.co.uk) and may be delayed or inaccurate.


## 3. 単一目的の宣言 / Single purpose（審査フォーム）
Display real-time trading context (order flow, funding rates, liquidation and stop-order maps, cross-venue basis, and news) for the coin a user is viewing on app.hyperliquid.xyz, in a browser side panel.

## 4. 権限の正当化 / Permission justifications（審査フォーム）
権限	記入する説明
sidePanel	The extension's entire UI is rendered in Chrome's side panel.
tabs	To detect which coin the user is viewing on the active app.hyperliquid.xyz tab and keep the panel in sync as they switch markets.
storage	To remember the user's last-used tab, selected coin, and display preferences locally.
host_permissions（各API）	To fetch public market data for the selected coin: Hyperliquid (market/funding), Hyperdash & Hypurrscan (liquidations/protocol stats), exchange APIs (Binance, Bybit, OKX, Aster, Lighter, Pacifica, Extended, edgeX, Grvt, Variational) for cross-venue funding/price basis, Yahoo Finance (equities), and Google News / farside.co.uk for news and ETF-flow data. All endpoints are read-only and return public data.
content script（app.hyperliquid.xyz）	Reads only the coin/context from the page to keep the panel in sync; does not read wallet keys or submit orders.