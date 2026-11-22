// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="wwcore">([\s\S]*?)<\/script>/)[1];
const sb = { module: { exports: {} } };
vm.runInNewContext(src, sb);
const WW = sb.module.exports;

const T0 = Date.UTC(2026, 10, 18, 4, 0, 0); // 12:00:00 UTC+8
const tr = (o) => Object.assign({ sym: 'BTCUSDT', venue: 'F', side: 'buy', price: 100000, qty: 1, T: T0, id: 1 }, o);
function feed(trades, win) { let p = null; const out = []; for (const t of trades) { const r = WW.mergeStep(p, t, win); p = r.pending; if (r.done) out.push(r.done); } if (p) out.push(p); return out; }

test('parseAggTrade maps m=true to a taker SELL and m=false to a taker BUY', () => {
  const s = WW.parseAggTrade({ s: 'BTCUSDT', a: 7, p: '100000.5', q: '2', T: T0, m: true }, 'F');
  assert.strictEqual(s.side, 'sell'); assert.strictEqual(s.price, 100000.5); assert.strictEqual(s.qty, 2); assert.strictEqual(s.id, 7); assert.strictEqual(s.venue, 'F');
  assert.strictEqual(WW.parseAggTrade({ s: 'X', a: 1, p: '1', q: '1', T: 1, m: false }, 'S').side, 'buy');
});
test('merge: same side within window becomes one order with summed qty/usd', () => {
  const out = feed([tr({ qty: 3 }), tr({ T: T0 + 40, qty: 2, price: 100010 }), tr({ T: T0 + 90, qty: 1, price: 100020 })], 100);
  assert.strictEqual(out.length, 1); const o = out[0];
  assert.strictEqual(o.n, 3); assert.strictEqual(o.qty, 6); assert.strictEqual(o.usd, 300000 + 200020 + 100020);
  assert.strictEqual(o.pFirst, 100000); assert.strictEqual(o.pLast, 100020); assert.strictEqual(o.pMax, 100020); assert.strictEqual(o.t0, T0); assert.strictEqual(o.tLast, T0 + 90);
  assert.ok(Math.abs(WW.vwap(o) - o.usd / 6) < 1e-9);
});
test('merge: window is measured from the first fill, so a long chain does not merge forever', () => {
  const out = feed([tr({}), tr({ T: T0 + 60 }), tr({ T: T0 + 100 }), tr({ T: T0 + 160 }), tr({ T: T0 + 230 })], 100);
  assert.deepStrictEqual(out.map(o => o.n), [3, 2]);
});
test('merge: side change splits orders', () => {
  const out = feed([tr({}), tr({ T: T0 + 10, side: 'sell' }), tr({ T: T0 + 20, side: 'sell' })], 100);
  assert.strictEqual(out.length, 2); assert.strictEqual(out[0].side, 'buy'); assert.strictEqual(out[1].side, 'sell'); assert.strictEqual(out[1].n, 2);
});
test('merge: gap larger than window splits; window 0 merges only same-ms fills', () => {
  assert.strictEqual(feed([tr({}), tr({ T: T0 + 101 })], 100).length, 2);
  assert.strictEqual(feed([tr({}), tr({ T: T0 }), tr({ T: T0 + 1 })], 0).length, 2);
});
test('flushIdle releases a pending order only after the window has passed', () => {
  const p = WW.mergeStep(null, tr({}), 100).pending;
  assert.strictEqual(WW.flushIdle(p, T0 + 100, 100).done, null); // measured from first fill
  const r = WW.flushIdle(p, T0 + 101, 100); assert.strictEqual(r.done, p); assert.strictEqual(r.pending, null);
  assert.strictEqual(WW.flushIdle(null, T0, 100).done, null);
});
test('thresholds and whale tiers', () => {
  assert.strictEqual(WW.defaultThreshold('BTCUSDT'), 500000); assert.strictEqual(WW.defaultThreshold('ETHUSDT'), 250000); assert.strictEqual(WW.defaultThreshold('SOLUSDT'), 100000);
  assert.strictEqual(WW.whaleTier({ usd: 499999 }, 500000, 5), 0);
  assert.strictEqual(WW.whaleTier({ usd: 500000 }, 500000, 5), 1);
  assert.strictEqual(WW.whaleTier({ usd: 2499999 }, 500000, 5), 1);
  assert.strictEqual(WW.whaleTier({ usd: 2500000 }, 500000, 5), 2);
  assert.strictEqual(WW.whaleTier({ usd: 1000000 }, 500000, 2), 2);
  assert.strictEqual(WW.whaleTier(null, 1, 5), 0);
});
const ev = (t, side, usd, sym = 'BTCUSDT') => ({ t0: t, side, usd, sym });
test('flowSummary sums buys/sells inside each window, per coin and all', () => {
  const now = T0 + 3600e3;
  const events = [ev(now - 50 * 60e3, 'buy', 1e6), ev(now - 14 * 60e3, 'sell', 4e5), ev(now - 4 * 60e3, 'buy', 6e5, 'ETHUSDT'), ev(now - 60e3, 'sell', 2e5), ev(now - 1e3, 'buy', 3e5)];
  const f5 = WW.flowSummary(events, now, 5 * 60e3, null);
  assert.deepStrictEqual([f5.buyUsd, f5.sellUsd, f5.net, f5.nBuy, f5.nSell], [9e5, 2e5, 7e5, 2, 1]);
  const f15 = WW.flowSummary(events, now, 15 * 60e3, 'BTCUSDT');
  assert.deepStrictEqual([f15.buyUsd, f15.sellUsd, f15.net], [3e5, 6e5, -3e5]);
  assert.ok(Math.abs(f15.pressure - 1 / 3) < 1e-9);
  const f1h = WW.flowSummary(events, now, 3600e3, 'BTCUSDT');
  assert.deepStrictEqual([f1h.buyUsd, f1h.sellUsd, f1h.nBuy, f1h.nSell], [1.3e6, 6e5, 2, 2]);
  const empty = WW.flowSummary([], now, 3e5, null); assert.strictEqual(empty.pressure, 0.5); assert.strictEqual(empty.net, 0);
});
test('flowSummary ignores future events and stops at the window edge', () => {
  const now = T0; const events = [ev(now - 301e3, 'buy', 9e9), ev(now - 300e3, 'buy', 1), ev(now + 5e3, 'sell', 9e9)];
  const f = WW.flowSummary(events, now, 300e3, null); assert.strictEqual(f.buyUsd, 1); assert.strictEqual(f.sellUsd, 0);
});
test('pruneByTime enforces age and count caps', () => {
  const a = []; for (let i = 0; i < 100; i++) a.push({ t0: T0 + i * 1000 });
  WW.pruneByTime(a, T0 + 99e3, 50e3, 1000); assert.strictEqual(a.length, 51); assert.strictEqual(a[0].t0, T0 + 49e3);
  WW.pruneByTime(a, T0 + 99e3, 1e9, 10); assert.strictEqual(a.length, 10); assert.strictEqual(a[0].t0, T0 + 90e3);
  const b = [{ t: 1 }, { t: 5 }]; WW.pruneByTime(b, 10, 6, 10, 't'); assert.strictEqual(b.length, 1);
});
test('pushSample keeps one sample per second and caps the window', () => {
  const s = [];
  WW.pushSample(s, T0, 1, 60e3, 100); WW.pushSample(s, T0 + 300, 2, 60e3, 100); assert.strictEqual(s.length, 1); assert.strictEqual(s[0].p, 2);
  for (let i = 1; i <= 200; i++) WW.pushSample(s, T0 + i * 1000, i, 60e3, 100);
  assert.ok(s.length <= 61); assert.strictEqual(s[s.length - 1].p, 200);
  const c = []; for (let i = 0; i < 500; i++) WW.pushSample(c, T0 + i * 1000, i, 1e9, 100); assert.strictEqual(c.length, 100);
});
test('pctMove measures move from the window low/high to now', () => {
  const s = [{ t: T0, p: 100 }, { t: T0 + 60e3, p: 95 }, { t: T0 + 120e3, p: 98 }, { t: T0 + 240e3, p: 102 }];
  const m = WW.pctMove(s, T0 + 240e3, 300e3); assert.ok(Math.abs(m.up - (102 - 95) / 95 * 100) < 1e-9); assert.ok(Math.abs(m.down - 0) < 1e-9);
  const m2 = WW.pctMove(s, T0 + 240e3, 150e3); assert.ok(Math.abs(m2.up - (102 - 98) / 98 * 100) < 1e-9);
  assert.deepStrictEqual({ ...WW.pctMove([], 0, 1) }, { up: 0, down: 0 });
});
test('alert conditions: price above/below and % move', () => {
  assert.strictEqual(WW.alertCondition({ type: 'above', value: 100 }, { price: 100 }), true);
  assert.strictEqual(WW.alertCondition({ type: 'above', value: 100 }, { price: 99.9 }), false);
  assert.strictEqual(WW.alertCondition({ type: 'below', value: 100 }, { price: 99 }), true);
  assert.strictEqual(WW.alertCondition({ type: 'below', value: 100 }, { price: 0 }), false);
  const samples = [{ t: T0, p: 100 }, { t: T0 + 60e3, p: 103 }];
  assert.strictEqual(WW.alertCondition({ type: 'move', value: 2.5, win: 5, side: 'any' }, { samples, now: T0 + 60e3 }), true);
  assert.strictEqual(WW.alertCondition({ type: 'move', value: 2.5, win: 5, side: 'sell' }, { samples, now: T0 + 60e3 }), false);
  assert.strictEqual(WW.alertCondition({ type: 'move', value: 3.5, win: 5, side: 'any' }, { samples, now: T0 + 60e3 }), false);
  assert.strictEqual(WW.alertCondition({ type: 'move', value: 2.5, win: 0.5, side: 'any' }, { samples, now: T0 + 60e3 }), false); // 100 is outside 30 s window
});
test('alert conditions: whale size, coin and buys-only filter', () => {
  const o = { sym: 'ETHUSDT', side: 'buy', usd: 1.2e6 };
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: '*', value: 1e6, side: 'any' }, { order: o }), true);
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: 'ETHUSDT', value: 1e6, side: 'buy' }, { order: o }), true);
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: 'ETHUSDT', value: 1e6, side: 'sell' }, { order: o }), false);
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: 'BTCUSDT', value: 1e6, side: 'any' }, { order: o }), false);
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: '*', value: 2e6, side: 'any' }, { order: o }), false);
  assert.strictEqual(WW.alertCondition({ type: 'whale', sym: '*', value: 1, side: 'any' }, {}), false);
});
test('alert conditions: net whale flow in N minutes', () => {
  const now = T0 + 600e3; const events = [ev(now - 400e3, 'buy', 3e6), ev(now - 100e3, 'buy', 1e6), ev(now - 50e3, 'sell', 2.5e5)];
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: 'BTCUSDT', value: 7e5, win: 5, side: 'buy' }, { events, now }), true);
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: 'BTCUSDT', value: 8e5, win: 5, side: 'buy' }, { events, now }), false);
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: '*', value: 3e6, win: 10, side: 'buy' }, { events, now }), true);
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: '*', value: 1, win: 10, side: 'sell' }, { events, now }), false);
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: 'ETHUSDT', value: 1, win: 10, side: 'any' }, { events, now }), false);
  const sells = [ev(now - 10e3, 'sell', 5e6)];
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: '*', value: 4e6, win: 5, side: 'sell' }, { events: sells, now }), true);
  assert.strictEqual(WW.alertCondition({ type: 'net', sym: '*', value: 4e6, win: 5, side: 'any' }, { events: sells, now }), true);
});
test('gate: one-shot disables, repeat honours cooldown', () => {
  const once = { enabled: true, mode: 'once' };
  assert.strictEqual(WW.gate(once, true, T0), true); assert.strictEqual(once.enabled, false); assert.strictEqual(WW.gate(once, true, T0 + 1), false);
  const rep = { enabled: true, mode: 'repeat', cooldown: 2 };
  assert.strictEqual(WW.gate(rep, false, T0), false);
  assert.strictEqual(WW.gate(rep, true, T0), true);
  assert.strictEqual(WW.gate(rep, true, T0 + 119e3), false);
  assert.strictEqual(WW.gate(rep, true, T0 + 120e3), true);
  const r0 = { enabled: true, mode: 'repeat', cooldown: 0 };
  assert.strictEqual(WW.gate(r0, true, T0), true); assert.strictEqual(WW.gate(r0, true, T0), true);
  const a = { type: 'above', value: 1, enabled: true, mode: 'once' };
  assert.strictEqual(WW.evaluateAlert(a, { price: 2, now: T0 }), true); assert.strictEqual(a.lastFired, T0);
});
test('normalizeSymbol and baseOf', () => {
  assert.strictEqual(WW.normalizeSymbol('btc'), 'BTCUSDT'); assert.strictEqual(WW.normalizeSymbol(' ethusdt '), 'ETHUSDT');
  assert.strictEqual(WW.normalizeSymbol('1000pepe'), '1000PEPEUSDT'); assert.strictEqual(WW.normalizeSymbol('BTC/USDT'), 'BTCUSDT');
  assert.strictEqual(WW.normalizeSymbol(''), null); assert.strictEqual(WW.normalizeSymbol('x'), null); assert.strictEqual(WW.normalizeSymbol('A'.repeat(30)), null);
  assert.strictEqual(WW.baseOf('SOLUSDT'), 'SOL'); assert.strictEqual(WW.baseOf('ETHUSDC'), 'ETH');
});
test('formatting: USD, UTC+8 time, countdown, duration, qty, pct', () => {
  assert.strictEqual(WW.fmtUsd(1234567), '$1.23M'); assert.strictEqual(WW.fmtUsd(512000), '$512K'); assert.strictEqual(WW.fmtUsd(12345), '$12.3K');
  assert.strictEqual(WW.fmtUsd(950), '$950'); assert.strictEqual(WW.fmtUsd(999618), '$1.00M'); assert.strictEqual(WW.fmtUsd(999499), '$999K'); assert.strictEqual(WW.fmtUsd(2.5e9), '$2.50B'); assert.strictEqual(WW.fmtSignedUsd(-3e6), '-$3.00M'); assert.strictEqual(WW.fmtSignedUsd(4e5), '+$400K');
  assert.strictEqual(WW.fmtTime(T0), '12:00:00'); assert.strictEqual(WW.fmtTime(Date.UTC(2026, 0, 1, 16, 30, 5)), '00:30:05');
  assert.strictEqual(WW.fmtDateTime(Date.UTC(2026, 0, 1, 16, 30, 5)), '2026-01-02 00:30:05');
  assert.strictEqual(WW.fmtCountdown(3 * 3600e3 + 61e3), '03:01:01'); assert.strictEqual(WW.fmtCountdown(-5), '00:00:00');
  assert.strictEqual(WW.fmtDuration(90061e3), '1d 01:01:01');
  assert.strictEqual(WW.fmtQty(12.345), '12.3'); assert.strictEqual(WW.fmtQty(0.5), '0.5000'); assert.strictEqual(WW.fmtQty(1500000), '1.50M');
  assert.strictEqual(WW.fmtPct(1.234), '+1.23%'); assert.strictEqual(WW.fmtPct(NaN), '—');
  assert.strictEqual(WW.fmtPrice(98765.43), '98,765.4'); assert.strictEqual(WW.fmtPrice(0.123456), '0.12346'); assert.strictEqual(WW.fmtPrice(0), '—');
});
test('backoff doubles up to 30 s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 20].map(WW.backoff), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
test('parseForceOrder: SELL = long liquidated, uses avg price x filled qty', () => {
  const x = WW.parseForceOrder({ stream: '!forceOrder@arr', data: { e: 'forceOrder', E: 5, o: { s: 'BTCUSDT', S: 'SELL', p: '99000', q: '2', ap: '99500', z: '1.5', T: 10 } } });
  assert.strictEqual(x.side, 'long'); assert.strictEqual(x.usd, 99500 * 1.5); assert.strictEqual(x.T, 10);
  const y = WW.parseForceOrder({ e: 'forceOrder', E: 5, o: { s: 'ETHUSDT', S: 'BUY', p: '3000', q: '10', ap: '0', z: '0' } });
  assert.strictEqual(y.side, 'short'); assert.strictEqual(y.usd, 30000); assert.strictEqual(y.T, 5);
  assert.strictEqual(WW.parseForceOrder({}), null);
});
test('btcTxValue sums outputs in BTC; change1h uses last 4 x 15m klines', () => {
  assert.strictEqual(WW.btcTxValue({ vout: [{ value: 10000000000 }, { value: 5e8 }] }), 105);
  assert.strictEqual(WW.btcTxValue({}), 0);
  const kl = [{ o: 1, c: 1 }, { o: 90, c: 95 }, { o: 100, c: 101 }, { o: 101, c: 104 }, { o: 104, c: 105 }, { o: 105, c: 110 }];
  assert.ok(Math.abs(WW.change1h(kl) - 10) < 1e-9); assert.ok(isNaN(WW.change1h(kl.slice(0, 3))));
});

// ---------- chart: liquidation-level model and marker store ----------
test('liqPrice: long/short liquidation prices for 10x/25x/50x/100x with 0.4% mmr', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' vs ' + b);
  near(WW.liqPrice(100000, 10, 'long'), 100000 * (1 - 0.1 + 0.004));   // 90,400
  near(WW.liqPrice(100000, 10, 'short'), 100000 * (1 + 0.1 - 0.004));  // 109,600
  near(WW.liqPrice(100000, 100, 'long'), 99400); near(WW.liqPrice(100000, 100, 'short'), 100600);
  near(WW.liqPrice(2000, 25, 'long', 0), 1920); near(WW.liqPrice(2000, 50, 'short', 0.005), 2030);
  assert.ok(WW.liqPrice(1, 50, 'long') < 1 && WW.liqPrice(1, 50, 'short') > 1);
  assert.deepStrictEqual([...WW.LEVS], [10, 25, 50, 100]); assert.strictEqual(WW.MMR, 0.004);
});
test('liqLevels: buys -> long levels below, sells -> short levels above, value split across leverages', () => {
  const lv = WW.liqLevels([{ t: 0, p: 100, u: 4e6, s: 'b' }, { t: 0, p: 100, u: 2e6, s: 's' }, { t: 0, p: 100, u: 9e9, s: 'L' }]);
  assert.strictEqual(lv.length, 8);
  const longs = lv.filter(l => l.side === 'long'), shorts = lv.filter(l => l.side === 'short');
  assert.ok(longs.every(l => l.price < 100 && l.usd === 1e6)); assert.ok(shorts.every(l => l.price > 100 && l.usd === 5e5));
  assert.deepStrictEqual([...longs.map(l => l.lev)], [10, 25, 50, 100]);
});
test('liqLevels drops levels already traded through after the order', () => {
  const iv = 60e3, cs = [{ t: 0, h: 101, l: 99 }, { t: 60e3, h: 100.5, l: 98.5 }, { t: 120e3, h: 100.2, l: 99.8 }];
  // buy at 100 during candle 0: 100x long liq = 99.4 -> candle 1 low 98.5 hits it; 50x = 98.4 survives
  const lv = WW.liqLevels([{ t: 10e3, p: 100, u: 4e6, s: 'b' }], { candles: cs, ivMs: iv });
  assert.deepStrictEqual([...lv.map(l => l.lev)], [10, 25, 50]);
  // a sell during the last candle is not checked against anything (nothing after it)
  assert.strictEqual(WW.liqLevels([{ t: 130e3, p: 100, u: 4e6, s: 's' }], { candles: cs, ivMs: iv }).length, 4);
  // an order before the first candle is checked against all candles (short 100x liq = 100.6 < high 101)
  assert.deepStrictEqual([...WW.liqLevels([{ t: -5e3, p: 100, u: 4e6, s: 's' }], { candles: cs, ivMs: iv }).map(l => l.lev)], [10, 25, 50]);
});
test('heatBins aggregates level value into price bins', () => {
  const bins = WW.heatBins([{ price: 90.5, usd: 1, side: 'long' }, { price: 90.9, usd: 2, side: 'long' }, { price: 109, usd: 5, side: 'short' }, { price: 200, usd: 9, side: 'short' }], 90, 110, 20);
  assert.strictEqual(bins.length, 20); assert.strictEqual(bins[0].long, 3); assert.strictEqual(bins[19].short, 5);
  assert.strictEqual(bins.reduce((a, b) => a + b.long + b.short, 0), 8);
  assert.strictEqual(WW.heatBins([{ price: 1, usd: 1, side: 'long' }], 5, 5, 4).every(b => b.long === 0), true);
});
test('compact markers keep time, price, value, side and market', () => {
  const o = { sym: 'BTCUSDT', venue: 'F', side: 'sell', qty: 10, usd: 1000000.4, t0: T0 };
  assert.deepStrictEqual({ ...WW.compactWhale(o) }, { t: T0, p: 100000.04, u: 1000000, s: 's', v: 'F', q: 10 });
  assert.deepStrictEqual({ ...WW.compactLiq({ sym: 'ETHUSDT', T: T0, side: 'long', price: 2000, qty: 3, usd: 6000 }) }, { t: T0, p: 2000, u: 6000, s: 'L', q: 3 });
  assert.strictEqual(WW.compactLiq({ T: 1, side: 'short', price: 1, qty: 1, usd: 1 }).s, 'S');
});
test('marker store: kept time-ordered, capped per coin and to 7 days', () => {
  const now = T0, list = [];
  for (let i = 0; i < 2500; i++) WW.addMarker(list, { t: now - 2500e3 + i * 1000, p: 1, u: 1, s: 'b' }, now);
  assert.strictEqual(list.length, WW.MK_CAP); assert.strictEqual(list[list.length - 1].t, now - 1000);
  WW.addMarker(list, { t: now - 5e5 + 1, p: 1, u: 2, s: 's' }, now); // out-of-order insert
  assert.ok(list.every((m, i) => i === 0 || list[i - 1].t <= m.t)); assert.strictEqual(list.length, 2000);
  const old = [{ t: now - 8 * 864e5, p: 1, u: 1, s: 'b' }, { t: now - 6 * 864e5, p: 1, u: 1, s: 'b' }];
  WW.pruneMarkers(old, now); assert.strictEqual(old.length, 1);
  const small = []; for (let i = 0; i < 20; i++) WW.addMarker(small, { t: i, p: 1, u: 1, s: 'b' }, 20, 5); assert.strictEqual(small.length, 5); assert.strictEqual(small[0].t, 15);
});
test('parseMarkers restores from localStorage JSON, drops junk, sorts and applies caps', () => {
  const now = T0;
  const json = JSON.stringify([{ t: now - 1000, p: 2, u: 5, s: 's' }, { t: now - 2000, p: 1, u: 5, s: 'b' }, { t: 'x', p: 1, u: 1, s: 'b' }, null, { t: now - 9 * 864e5, p: 1, u: 1, s: 'b' }, { t: now, p: 0, u: 1, s: 'b' }]);
  const a = WW.parseMarkers(json, now); assert.deepStrictEqual([...a.map(m => m.t)], [now - 2000, now - 1000]);
  assert.deepStrictEqual([...WW.parseMarkers('not json', now)], []); assert.deepStrictEqual([...WW.parseMarkers('{"a":1}', now)], []);
  const many = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ t: now - i, p: 1, u: 1, s: 'L' })));
  assert.strictEqual(WW.parseMarkers(many, now).length, 2000);
  // round trip
  const rt = WW.parseMarkers(JSON.stringify(a), now); assert.deepStrictEqual(JSON.parse(JSON.stringify(rt)), JSON.parse(JSON.stringify(a)));
});
test('markerRadius, candleNet and niceStep', () => {
  assert.strictEqual(WW.markerRadius(1e5, 1e5), 7); assert.strictEqual(WW.markerRadius(0, 1e5), 3); assert.strictEqual(WW.markerRadius(1e12, 1), 18);
  assert.ok(WW.markerRadius(5e5, 1e5) > WW.markerRadius(2e5, 1e5));
  const cs = [{ t: 0 }, { t: 60e3 }, { t: 120e3 }];
  const net = WW.candleNet([{ t: 1, u: 5, s: 'b' }, { t: 59999, u: 2, s: 's' }, { t: 60e3, u: 4, s: 's' }, { t: 999e3, u: 9, s: 'b' }, { t: 130e3, u: 7, s: 'L' }], cs, 60e3);
  assert.deepStrictEqual([...net], [3, -4, 0]);
  assert.strictEqual(WW.niceStep(1000, 5), 200); assert.strictEqual(WW.niceStep(7, 6), 1); assert.strictEqual(WW.niceStep(0.03, 6), 0.005);
  assert.strictEqual(WW.IVMS['4h'], 144e5);
});
