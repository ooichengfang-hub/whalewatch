# Whale Watch

A single-file web app that watches for **whales**: large taker orders on Binance for the coins you choose, live, all day.

**Live:** https://ooichengfang-hub.github.io/whalewatch/ (open on a PC and leave the tab open; on iPhone: Safari → Share → Add to Home Screen)

## What it shows
- **Whale trade tape**: every taker order worth at least your threshold (defaults: BTC $500K, ETH $250K, others $100K; edit per coin). BUY (green) = the aggressor bought from the order book; SELL (red) = the aggressor sold into it. Orders ≥ 5× threshold are bigger and bolder. Filters for side, coin, market, size.
- **Whale flow**: whale buy $ vs sell $, net and counts for each coin and all coins over 5m / 15m / 1h / 24h, with a buy-pressure bar. The 24h column counts only since the page was opened.
- **Coins**: live price (flashes), 1h % and 24h %, 24h range and volume, funding rate with countdown, 24h sparkline. Add/remove (validated against Binance), reorder by drag or ↑↓, sort; saved in your browser.
- **Alerts** (sound, browser notification, toast, log with UTC+8 times): whale order ≥ $X (buys-only/sells-only filter), net whale flow ≥ $Y in N minutes, price above/below, % move within N minutes. One-shot or repeating with cooldown. Big-liquidation alert optional.
- **Chart** (own canvas code): candles for any watched coin at 1m/5m/15m/1h/4h (REST history + live kline stream), pan/zoom (drag, wheel, pinch), crosshair, price label with candle countdown. Click a coin or a tape row to open it. Whale buys/sells are drawn as green/red circles at their exact time and price (size = USDT value) and actual liquidations as diamonds (orange = long liquidated, cyan = short liquidated), with tooltips. Markers are kept in your browser for 7 days (max 2000 per coin each); when you open a coin, whale orders from its latest ~10,000 futures trades are back-filled. Binance has no public liquidation history, so liquidations only exist from when the app was open. Toggles: WHALES, LIQ, TINT (candles with strong whale net flow), min marker size, and **EST LEVELS** - a *model estimate* of where 10x/25x/50x/100x positions opened at whale prices would be liquidated (not real positions).
- **Liquidations** feed for your coins (Binance futures public stream).
- **BTC on-chain**: new unconfirmed Bitcoin transactions with total outputs ≥ 100 BTC from mempool.space, with a link to each tx. Off by default on phones (it uses about 1 MB of data per minute).

## Honest limits
- Exchange trades are anonymous. Nobody can see *who* a whale is; this shows the size and direction of big orders.
- An order is rebuilt by merging consecutive aggTrades of the same coin, market and side printed within 100 ms of the first fill. Two traders hitting the same side within that window can be merged.
- On-chain totals include change returned to the sender, and wallet owners are unknown (often exchanges moving their own coins).
- It only watches while the page is open and the computer is awake. On Windows: Settings → System → Power → Screen and sleep → sleep "Never" when plugged in. For alerts while the PC is off you'd need something running on a server.

## 24/7 robustness
WebSocket auto-reconnect with exponential backoff (1 s → 30 s), stale-stream detection, REST polling fallback while a stream is down, refill of missed trades after a reconnect (by aggTrade id), duplicate protection, alerts checked as data arrives so they work in a background tab, Wake Lock button, capped memory (whale events 24 h / 20k, tape 250 rows, log 300, feeds 150, price samples 1 h).

## Data and privacy
Public Binance USDT-M futures and spot market data and the public mempool.space API. No account, no API keys, nothing sent anywhere. Settings stay in your browser's localStorage. Not financial advice.

## Files
`index.html` (whole app, logic in `<script id="wwcore">`), `manifest.webmanifest`, `sw.js` (caches the app shell only), icons. Tests: `node --test tests/*.test.js`.
