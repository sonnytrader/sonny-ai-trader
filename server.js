// server.js (V6 + V45.0 Tablo Arayüzü)
// Native Bitget WebSocket + V45.0 tablo düzeni, watchlist kaldırıldı
// (2025)

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const REST = 'https://api.bitget.com';
const WS_URL = 'wss://ws.bitget.com/v2/ws/public';
const PRODUCT = 'usdt-futures';

// ============================================================
// AYARLAR
// ============================================================

const CFG = {
  MIN_24H_TURNOVER: 3000000,
  MAX_SYMBOLS: 30,
  LEVEL_LOOKBACK: 36,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,

  WATCH_DISTANCE_PCT: 1.20,
  IGNITION_DISTANCE_PCT: 0.55,
  ENTRY_DISTANCE_PCT: 0.18,

  VOLUME_LOOKBACK: 20,
  WATCH_VOLUME_RATIO: 1.20,
  IGNITION_VOLUME_RATIO: 1.50,
  ENTRY_VOLUME_RATIO: 1.90,

  OI_WATCH_PCT: 0.03,
  OI_IGNITION_PCT: 0.08,
  OI_ENTRY_PCT: 0.15,

  FLOW_WATCH: 0.54,
  FLOW_IGNITION: 0.58,
  FLOW_ENTRY: 0.63,

  MOMENTUM_WATCH: 0.03,
  MOMENTUM_IGNITION: 0.08,
  MOMENTUM_ENTRY: 0.15,

  WATCH_SCORE: 50,
  IGNITION_SCORE: 65,
  ENTRY_SCORE: 80,

  SIGNAL_TTL_MS: 4 * 60 * 1000,
  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

  SCAN_INTERVAL_MS: 30 * 1000,
  WS_BATCH_SIZE: 20,
  WS_PING_MS: 25 * 1000
};

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: Date.now(),
  symbols: new Map(),
  kirilimSignals: [],
  momentumSignals: [],
  cooldowns: {},
  ws: null,
  wsConnected: false,
  stats: {
    symbols: 0,
    scans: 0,
    signals: 0,
    lastScan: null
  }
};

let reconnectAttempts = 0;

// ============================================================
// HELPERS
// ============================================================

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function pct(a, b) { if (!b) return 0; return ((a - b) / b) * 100; }
function absPct(a, b) { return Math.abs(pct(a, b)); }
function now() { return Date.now(); }
function normalizeSymbol(s) { return String(s || '').replace(/[^A-Z0-9]/g, ''); }

function getSymbol(symbol) {
  if (!state.symbols.has(symbol)) {
    state.symbols.set(symbol, {
      symbol, price: 0, bid: 0, ask: 0, bidSize: 0, askSize: 0,
      turnover24h: 0, volume24h: 0, oi: 0, prevOi: 0, oiUpdatedAt: 0,
      priceHistory: [], flowHistory: [], minuteCandles: [], h1Candles: [], twoHCandles: [],
      level: null, signal: null
    });
  }
  return state.symbols.get(symbol);
}

// ============================================================
// REST
// ============================================================

async function rest(path, params = {}) {
  const url = new URL(REST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.code && j.code !== '00000') throw new Error(`${j.code} ${j.msg || ''}`);
  return j;
}

// ============================================================
// SYMBOLS
// ============================================================

async function loadSymbols() {
  const json = await rest('/api/v2/mix/market/contracts', { productType: PRODUCT });
  const contracts = Array.isArray(json.data) ? json.data : [];
  const valid = contracts
    .filter(x => {
      const s = normalizeSymbol(x.symbol);
      return s && x.symbolType !== 'delivery' && String(x.quoteCoin).toUpperCase() === 'USDT';
    })
    .map(x => normalizeSymbol(x.symbol));
  console.log(`Bitget marketleri: ${valid.length}`);
  for (const s of valid) getSymbol(s);
  state.stats.symbols = valid.length;
}

async function load1HCandles(symbol) {
  try {
    const json = await rest('/api/v3/market/candles', {
      category: 'USDT-FUTURES', symbol, interval: '1H', limit: 120
    });
    const rows = Array.isArray(json.data) ? json.data : [];
    const candles = rows.map(r => ({
      ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]),
      close: num(r[4]), volume: num(r[5]), turnover: num(r[6])
    })).filter(c => c.close > 0).sort((a, b) => a.ts - b.ts);
    getSymbol(symbol).h1Candles = candles;
    build2HCandles(symbol);
  } catch (err) {
    console.error(`[${symbol}] 1H candle error: ${err.message}`);
  }
}

function build2HCandles(symbol) {
  const s = getSymbol(symbol);
  const h1 = s.h1Candles;
  if (h1.length < 10) return;
  const buckets = new Map();
  for (const c of h1) {
    const b = Math.floor(c.ts / (2 * 60 * 60 * 1000));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(c);
  }
  const result = [];
  for (const [b, rows] of buckets) {
    rows.sort((a, b) => a.ts - b.ts);
    if (!rows.length) continue;
    result.push({
      ts: b * 2 * 60 * 60 * 1000,
      open: rows[0].open,
      high: Math.max(...rows.map(x => x.high)),
      low: Math.min(...rows.map(x => x.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((a, x) => a + x.volume, 0),
      turnover: rows.reduce((a, x) => a + x.turnover, 0)
    });
  }
  result.sort((a, b) => a.ts - b.ts);
  s.twoHCandles = result.slice(-CFG.LEVEL_LOOKBACK);
  detectLevels(symbol);
}

function isPivotHigh(c, i) {
  const x = c[i];
  for (let k = 1; k <= CFG.PIVOT_LEFT; k++) if (!c[i - k] || c[i - k].high >= x.high) return false;
  for (let k = 1; k <= CFG.PIVOT_RIGHT; k++) if (!c[i + k] || c[i + k].high > x.high) return false;
  return true;
}
function isPivotLow(c, i) {
  const x = c[i];
  for (let k = 1; k <= CFG.PIVOT_LEFT; k++) if (!c[i - k] || c[i - k].low <= x.low) return false;
  for (let k = 1; k <= CFG.PIVOT_RIGHT; k++) if (!c[i + k] || c[i + k].low < x.low) return false;
  return true;
}

function detectLevels(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;
  if (candles.length < 12 || !s.price) return;
  const price = s.price;
  const resistance = [];
  const support = [];
  for (let i = CFG.PIVOT_LEFT; i < candles.length - CFG.PIVOT_RIGHT; i++) {
    if (isPivotHigh(candles, i)) resistance.push(candles[i].high);
    if (isPivotLow(candles, i)) support.push(candles[i].low);
  }
  const nr = resistance.filter(x => x > price).sort((a, b) => a - b)[0] || null;
  const ns = support.filter(x => x < price).sort((a, b) => b - a)[0] || null;
  s.level = { resistance: nr, support: ns, updatedAt: now() };
}

function calculateVolumeRatio(symbol) {
  const s = getSymbol(symbol);
  const c = s.twoHCandles;
  if (c.length < CFG.VOLUME_LOOKBACK + 1) return 1;
  const last = c[c.length - 1];
  const prev = c.slice(-CFG.VOLUME_LOOKBACK - 1, -1);
  const avg = prev.reduce((sum, x) => sum + x.turnover, 0) / prev.length;
  if (!avg) return 1;
  return last.turnover / avg;
}

function priceMomentum(symbol) {
  const s = getSymbol(symbol);
  const h = s.priceHistory;
  if (h.length < 10) return 0;
  const cur = h[h.length - 1];
  const old = h.find(x => cur.ts - x.ts >= 60 * 1000) || h[0];
  if (!old.price) return 0;
  return pct(cur.price, old.price);
}

function oiChange(symbol) {
  const s = getSymbol(symbol);
  if (!s.prevOi || !s.oi) return 0;
  return pct(s.oi, s.prevOi);
}

function orderbookFlow(symbol) {
  const s = getSymbol(symbol);
  if (!s.bidSize && !s.askSize) return 0.5;
  const t = s.bidSize + s.askSize;
  if (!t) return 0.5;
  return s.bidSize / t;
}

function flowScore(symbol) {
  const s = getSymbol(symbol);
  const direct = orderbookFlow(symbol);
  if (!s.flowHistory.length) return direct;
  const recent = s.flowHistory.slice(-20);
  const avg = recent.reduce((a, x) => a + x.flow, 0) / recent.length;
  return clamp(avg * 0.65 + direct * 0.35, 0, 1);
}

function levelDistance(symbol, direction) {
  const s = getSymbol(symbol);
  if (!s.level || !s.price) return Infinity;
  const level = direction === 'LONG' ? s.level.resistance : s.level.support;
  if (!level) return Infinity;
  return absPct(s.price, level);
}

// ============================================================
// TACTICAL ANALYSIS
// ============================================================

function generateTacticalAnalysis(data) {
  const { signal, distance, volumeRatio, oi, flow, momentum } = data;
  let a = '';
  let c = 50;

  if (distance <= CFG.ENTRY_DISTANCE_PCT) { a += `🎯 **Seviyeye Çok Yakın:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. `; c += 20; }
  else if (distance <= CFG.IGNITION_DISTANCE_PCT) { a += `⚡ **Hareket Başlıyor:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. `; c += 10; }
  else { a += `👀 **İzleme Modu:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. `; }

  const vt = volumeRatio.toFixed(2);
  if (volumeRatio >= CFG.ENTRY_VOLUME_RATIO) { a += `🐋 **'Balina Teyitli':** Hacim ${vt}x. `; c += 25; }
  else if (volumeRatio >= CFG.IGNITION_VOLUME_RATIO) { a += `👍 **Hacim Teyitli:** Hacim ${vt}x. `; c += 15; }
  else if (volumeRatio >= CFG.WATCH_VOLUME_RATIO) { a += `ℹ️ **Hacim Normal:** Hacim ${vt}x. `; c += 5; }
  else { a += `👎 **Zayıf Hacim:** Hacim ${vt}x. `; c -= 10; }

  const ot = oi.toFixed(2);
  if (oi >= CFG.OI_ENTRY_PCT) { a += `📈 **OI Patlaması:** %${ot}. `; c += 20; }
  else if (oi >= CFG.OI_IGNITION_PCT) { a += `📊 **OI Artıyor:** %${ot}. `; c += 10; }

  if (signal === 'LONG') {
    if (flow >= CFG.FLOW_ENTRY) { a += `🟢 **Alım Baskısı:** %${(flow * 100).toFixed(0)} alıcıda. `; c += 15; }
    else if (flow >= CFG.FLOW_WATCH) { a += `🟡 **Alım Eğilimi:** %${(flow * 100).toFixed(0)} alıcıda. `; }
    else { a += `🔴 **Satım Baskısı:** %${(flow * 100).toFixed(0)} alıcıda. `; c -= 10; }
  } else {
    const sf = 1 - flow;
    if (sf >= CFG.FLOW_ENTRY) { a += `🔴 **Satım Baskısı:** %${(sf * 100).toFixed(0)} satıcıda. `; c += 15; }
    else if (sf >= CFG.FLOW_WATCH) { a += `🟠 **Satım Eğilimi:** %${(sf * 100).toFixed(0)} satıcıda. `; }
    else { a += `🟢 **Alım Baskısı:** %${((1 - sf) * 100).toFixed(0)} alıcıda. `; c -= 10; }
  }

  const mt = momentum.toFixed(2);
  if (Math.abs(momentum) >= CFG.MOMENTUM_ENTRY) {
    if ((signal === 'LONG' && momentum > 0) || (signal === 'SHORT' && momentum < 0)) { a += `🚀 **Momentum Güçlü:** %${mt}. `; c += 15; }
    else { a += `⚠️ **Ters Momentum:** %${mt}. `; c -= 15; }
  }

  return { text: a, confidence: Math.min(Math.max(c, 0), 99).toFixed(0) };
}

// ============================================================
// SCORE
// ============================================================

function calculateScore(symbol, direction) {
  const distance = levelDistance(symbol, direction);
  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);
  let score = 0;

  if (distance <= CFG.ENTRY_DISTANCE_PCT) score += 20;
  else if (distance <= CFG.IGNITION_DISTANCE_PCT) score += 16;
  else if (distance <= CFG.WATCH_DISTANCE_PCT) score += 10;

  if (vr >= CFG.ENTRY_VOLUME_RATIO) score += 20;
  else if (vr >= CFG.IGNITION_VOLUME_RATIO) score += 16;
  else if (vr >= CFG.WATCH_VOLUME_RATIO) score += 10;

  if (oi >= CFG.OI_ENTRY_PCT) score += 20;
  else if (oi >= CFG.OI_IGNITION_PCT) score += 16;
  else if (oi >= CFG.OI_WATCH_PCT) score += 10;

  if (direction === 'LONG') {
    if (flow >= CFG.FLOW_ENTRY) score += 20;
    else if (flow >= CFG.FLOW_IGNITION) score += 16;
    else if (flow >= CFG.FLOW_WATCH) score += 10;
  } else {
    const sf = 1 - flow;
    if (sf >= CFG.FLOW_ENTRY) score += 20;
    else if (sf >= CFG.FLOW_IGNITION) score += 16;
    else if (sf >= CFG.FLOW_WATCH) score += 10;
  }

  const am = Math.abs(mom);
  if ((direction === 'LONG' && mom > 0) || (direction === 'SHORT' && mom < 0)) {
    if (am >= CFG.MOMENTUM_ENTRY) score += 10;
    else if (am >= CFG.MOMENTUM_IGNITION) score += 8;
    else if (am >= CFG.MOMENTUM_WATCH) score += 5;
  }
  if (direction === 'LONG' && mom > 0) score += 10;
  if (direction === 'SHORT' && mom < 0) score += 10;

  return Math.min(100, Math.round(score));
}

// ============================================================
// CLASSIFY
// ============================================================

function classifySignal(symbol, direction, score) {
  const s = getSymbol(symbol);
  const distance = levelDistance(symbol, direction);
  if (distance < 0.001 || distance > CFG.WATCH_DISTANCE_PCT) return null;

  let stateName = null;
  if (score >= CFG.ENTRY_SCORE) stateName = 'GİRİŞ FIRSATI';
  else if (score >= CFG.IGNITION_SCORE) stateName = 'HAREKET BAŞLADI';
  else if (score >= CFG.WATCH_SCORE) stateName = 'İZLE';
  if (!stateName) return null;

  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);
  const level = direction === 'LONG' ? s.level?.resistance : s.level?.support;
  const tactical = generateTacticalAnalysis({ signal: direction, distance, volumeRatio: vr, oi, flow, momentum: mom });

  return {
    id: `${symbol}-${direction}-${Date.now()}`,
    symbol, direction, state: stateName, signal: direction,
    score, confidence: tactical.confidence, tacticalAnalysis: tactical.text,
    reason: `${direction} sinyali: ${stateName} (Skor: ${score})`,
    price: s.price, level,
    entryPrice: s.price.toFixed(6),
    TP: '---', SL: '---', RR: 'N/A',
    distancePct: distance, volumeRatio: vr, oiChangePct: oi, flow, momentum: mom,
    strategyType: 'BRK2H', isFiltered: false,
    createdAt: now(), timestamp: now(),
    time: new Date().toLocaleTimeString(),
    expiresAt: now() + CFG.SIGNAL_TTL_MS
  };
}

// ============================================================
// EVALUATE / SCAN
// ============================================================

function evaluateSymbol(symbol) {
  const s = getSymbol(symbol);
  if (!s.price || s.turnover24h < CFG.MIN_24H_TURNOVER) return;
  if (!s.level) detectLevels(symbol);
  if (!s.level) return;

  const cands = [];
  if (s.level.resistance && s.price < s.level.resistance) {
    const sc = calculateScore(symbol, 'LONG');
    const sig = classifySignal(symbol, 'LONG', sc);
    if (sig) cands.push(sig);
  }
  if (s.level.support && s.price > s.level.support) {
    const sc = calculateScore(symbol, 'SHORT');
    const sig = classifySignal(symbol, 'SHORT', sc);
    if (sig) cands.push(sig);
  }

  if (!cands.length) { s.signal = null; return; }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const prev = s.signal;
  const ck = `${symbol}-${best.direction}`;
  const cd = state.cooldowns[ck];

  if (cd && cd.timestamp > now() - CFG.SIGNAL_COOLDOWN_MS) { s.signal = best; return; }

  if (!prev || prev.state !== best.state || prev.direction !== best.direction || Math.abs(prev.score - best.score) >= 5) {
    s.signal = best;
    state.cooldowns[ck] = { timestamp: now() };
    state.stats.signals++;
    state.kirilimSignals.unshift(best);
    if (state.kirilimSignals.length > 100) state.kirilimSignals.pop();
    console.log(`[${best.state}] ${best.direction} ${best.symbol} score=${best.score} conf=${best.confidence}%`);
  } else {
    s.signal = { ...prev, ...best };
  }
}

function scan() {
  state.stats.scans++;
  state.stats.lastScan = now();
  for (const s of state.symbols.keys()) evaluateSymbol(s);
  cleanupSignals();
}

function cleanupSignals() {
  const t = now();
  for (const s of state.symbols.values()) if (s.signal && s.signal.expiresAt < t) s.signal = null;
  state.kirilimSignals = state.kirilimSignals.filter(s => s.expiresAt > t);
  state.momentumSignals = state.momentumSignals.filter(s => s.expiresAt > t);
}

// ============================================================
// WEBSOCKET
// ============================================================

function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch (e) {} }
  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.on('open', () => {
    console.log('Bitget WebSocket bağlandı.');
    state.wsConnected = true;
    reconnectAttempts = 0;
    subscribeTickerAndCandles();
  });

  ws.on('message', raw => {
    try {
      const text = raw.toString();
      if (text === 'pong' || text === 'ping') return;
      const msg = JSON.parse(text);
      if (msg.event === 'subscribe') return;
      if (!msg.data || !msg.arg) return;
      const ch = msg.arg.channel;
      if (ch === 'ticker') processTicker(msg);
      if (ch === 'candle1m' || ch === 'candle1H') processCandle(msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Bitget WebSocket kapandı.');
    state.wsConnected = false;
    const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(connectWS, delay);
  });

  ws.on('error', err => console.error('WS error:', err.message));
}

function subscribeTickerAndCandles() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const selected = Array.from(state.symbols.keys()).slice(0, CFG.MAX_SYMBOLS);
  const args = [];
  for (const s of selected) args.push({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s });
  for (const s of selected) args.push({ instType: 'USDT-FUTURES', channel: 'candle1H', instId: s });
  for (const s of selected) args.push({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: s });

  const batches = [];
  for (let i = 0; i < args.length; i += CFG.WS_BATCH_SIZE) batches.push(args.slice(i, i + CFG.WS_BATCH_SIZE));
  for (const batch of batches) state.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
  console.log(`WS abonelikleri: ${args.length} kanal / ${batches.length} paket`);
}

function processTicker(msg) {
  const rows = Array.isArray(msg.data) ? msg.data : [];
  for (const row of rows) {
    const symbol = normalizeSymbol(row.instId || row.symbol);
    if (!symbol) continue;
    const s = getSymbol(symbol);
    const price = num(row.lastPr ?? row.lastPrice);
    if (!price) continue;
    s.price = price;
    s.bid = num(row.bidPr ?? row.bid1Price);
    s.ask = num(row.askPr ?? row.ask1Price);
    s.bidSize = num(row.bidSz ?? row.bid1Size);
    s.askSize = num(row.askSz ?? row.ask1Size);
    s.turnover24h = num(row.quoteVolume ?? row.turnover24h);
    s.volume24h = num(row.baseVolume ?? row.volume24h);
    const newOI = num(row.holdingAmount ?? row.openInterest);
    if (newOI > 0) { if (s.oi > 0) s.prevOi = s.oi; s.oi = newOI; s.oiUpdatedAt = now(); }
    s.priceHistory.push({ ts: now(), price });
    const cut = now() - 10 * 60 * 1000;
    s.priceHistory = s.priceHistory.filter(x => x.ts >= cut);
    const flow = orderbookFlow(symbol);
    s.flowHistory.push({ ts: now(), flow });
    s.flowHistory = s.flowHistory.filter(x => x.ts >= cut);
    detectLevels(symbol);
  }
}

function processCandle(msg) {
  const symbol = normalizeSymbol(msg.arg?.instId);
  if (!symbol) return;
  const s = getSymbol(symbol);
  const rows = Array.isArray(msg.data) ? msg.data : [];
  for (const r of rows) {
    const candle = { ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]), turnover: num(r[6]) };
    if (!candle.close) continue;
    if (msg.arg.channel === 'candle1H') { upsertCandle(s.h1Candles, candle, 120); build2HCandles(symbol); }
    if (msg.arg.channel === 'candle1m') { upsertCandle(s.minuteCandles, candle, 120); }
  }
}

function upsertCandle(arr, c, max) {
  const i = arr.findIndex(x => x.ts === c.ts);
  if (i >= 0) arr[i] = c; else arr.push(c);
  arr.sort((a, b) => a.ts - b.ts);
  while (arr.length > max) arr.shift();
}

setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send('ping'); } catch (e) {}
  }
}, CFG.WS_PING_MS);

// ============================================================
// API
// ============================================================

app.get('/api/status', (req, res) => {
  res.json({
    ok: true, system: 'SONNY AI TRADER V6', mode: 'V45 TABLO',
    wsConnected: state.wsConnected, symbols: state.symbols.size,
    signals: state.stats.signals, scans: state.stats.scans,
    lastScan: state.stats.lastScan, uptime: now() - state.startedAt
  });
});

app.get('/api/signals', (req, res) => {
  const enrich = (sig) => {
    const s = state.symbols.get(sig.symbol);
    if (!s) return sig;
    return {
      ...sig,
      price: s.price,
      bid: s.bid, ask: s.ask, oi: s.oi, turnover24h: s.turnover24h,
      level: s.level ? (sig.direction === 'LONG' ? s.level.resistance : s.level.support) : sig.level,
      distancePct: s.level ? (sig.direction === 'LONG'
        ? absPct(s.price, s.level.resistance)
        : absPct(s.price, s.level.support)) : sig.distancePct,
      volumeRatio: calculateVolumeRatio(sig.symbol),
      oiChangePct: oiChange(sig.symbol),
      flow: flowScore(sig.symbol),
      momentum: priceMomentum(sig.symbol)
    };
  };
  res.json({
    ok: true, serverTime: now(),
    kirilimSignals: state.kirilimSignals.slice(0, 100).map(enrich),
    momentumSignals: state.momentumSignals.slice(0, 50).map(enrich),
    scanStatus: {
      message: state.stats.lastScan ? `Tarama Tamamlandı. ${state.kirilimSignals.length} sinyal aktif.` : 'Tarama bekleniyor...',
      isScanning: false
    }
  });
});

// ============================================================
// HTML
// ============================================================

app.get('/', (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Sonny AI Trader V6 (V45 Arayüzü)</title>',
    '<style>',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #e0e0e0; margin: 0; padding: 0; font-size: 0.85rem; }',
    '.container-fluid { padding: 1.5rem; max-width: 1800px; margin: 0 auto; }',
    'header { padding: 20px; background-color: #2a2a2a; border-bottom: 1px solid #333; text-align: center; margin-bottom: 1.5rem; border-radius: 8px; }',
    'header h1 { color: #4CAF50; margin: 0; font-size: 1.6em; }',
    '#scan-status { font-size: 0.9em; color: #bbb; margin-top: 8px; display: flex; align-items: center; justify-content: center; }',
    '#scan-spinner { width: 16px; height: 16px; border: 2px solid #555; border-top-color: #4CAF50; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 10px; display: none; }',
    '@keyframes spin { to { transform: rotate(360deg); } }',
    '@keyframes highlight { from { background-color: rgba(76, 175, 80, 0.5); } to { background-color: inherit; } }',
    '.new-signal-row { animation: highlight 1.5s ease-out; }',
    '.manual-analysis { padding: 15px 20px; background-color: #252525; display: flex; gap: 10px; flex-direction: column; border-bottom: 1px solid #333; margin-bottom: 1rem; border-radius: 6px; }',
    '.manual-input-row { display: flex; gap: 10px; }',
    '.manual-analysis input[type="text"] { flex-grow: 1; padding: 8px; background-color: #333; border: 1px solid #444; border-radius: 4px; color: #fff; font-size: 0.9em; }',
    '.manual-analysis button { padding: 8px 15px; background-color: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }',
    '.manual-analysis button:hover:not(:disabled) { background-color: #45a049; }',
    '.manual-analysis button:disabled { background-color: #555; cursor: not-allowed; }',
    '.bg-long, .signal-long { background-color: #1a7a3a !important; color: white !important; }',
    '.bg-short, .signal-short { background-color: #9d3131 !important; color: white !important; }',
    '.bg-wait, .signal-wait { background-color: #6c757d !important; color: white !important; }',
    '.signal-pending-long { background-color: #d1e7dd; color: #0f5132; border: 1px dashed #0f5132; font-weight: bold; }',
    '.signal-pending-short { background-color: #f8d7da; color: #842029; border: 1px dashed #842029; font-weight: bold; }',
    '.compact-signal { padding: 4px 6px; font-size: 0.9em; }',
    '.strategy-brk1h { font-size: 0.8em; color: #90caf9; font-weight: bold; }',
    '.strategy-brk2h { font-size: 0.8em; color: #64b5f6; font-weight: bold; }',
    '.strategy-brk4h { font-size: 0.8em; color: #42a5f5; font-weight: bold; }',
    '.strategy-momentum1h { font-size: 0.8em; color: #ffc107; font-weight: bold; }',
    '.table-wrapper { overflow-x: auto; padding: 15px 20px; background-color: #1e1e1e; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); margin-bottom: 1.5rem; }',
    'table { width: 100%; border-collapse: collapse; table-layout: fixed; background-color: #1e1e1e; }',
    'th, td { padding: 9px 11px; text-align: left; border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }',
    'th { background-color: #2a2a2a; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 10; }',
    'th:hover { background-color: #333; }',
    'tbody tr:hover { background-color: #303030; }',
    '.main-signal-table th:nth-child(1), .main-signal-table td:nth-child(1) { width: 80px; }',
    '.main-signal-table th:nth-child(2), .main-signal-table td:nth-child(2) { width: 200px; }',
    '.main-signal-table th:nth-child(3), .main-signal-table td:nth-child(3) { width: 140px; text-align: center; }',
    '.main-signal-table th:nth-child(4), .main-signal-table td:nth-child(4) { width: 80px; text-align: right; }',
    '.main-signal-table th:nth-child(5), .main-signal-table td:nth-child(5) { width: 120px; text-align: right; }',
    '.main-signal-table th:nth-child(6), .main-signal-table td:nth-child(6) { width: 130px; text-align: right; }',
    '.main-signal-table th:nth-child(7), .main-signal-table td:nth-child(7) { width: 80px; text-align: right; }',
    '.main-signal-table th:nth-child(8), .main-signal-table td:nth-child(8) { width: 120px; }',
    '.main-signal-table th:nth-child(9), .main-signal-table td:nth-child(9) { width: auto; white-space: normal !important; min-width: 300px; }',
    '.momentum-table th:nth-child(1), .momentum-table td:nth-child(1) { width: 80px; }',
    '.momentum-table th:nth-child(2), .momentum-table td:nth-child(2) { width: 150px; }',
    '.momentum-table th:nth-child(3), .momentum-table td:nth-child(3) { width: 100px; text-align: center; }',
    '.momentum-table th:nth-child(4), .momentum-table td:nth-child(4) { width: 120px; text-align: right; }',
    '.momentum-table th:nth-child(5), .momentum-table td:nth-child(5) { width: auto; white-space: normal !important; min-width: 250px; }',
    '.link-text { color: #64b5f6; text-decoration: none; } .link-text:hover { text-decoration: underline; }',
    '.filter-section { padding: 10px 20px; background-color: #252525; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-radius: 6px; margin-bottom: 1rem; }',
    '.filter-section label { font-weight: bold; font-size: 0.9em; } .filter-section input[type="number"] { width: 60px; padding: 5px; background-color: #333; border: 1px solid #444; border-radius: 4px; color: #fff; font-size: 0.9em; }',
    '.filter-section button { padding: 5px 12px; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }',
    '#apply-filter-button { background-color: #4CAF50; } #show-all-button { background-color: #6c757d; }',
    '.btn-filter { background-color: #444; color: #ccc; border: 1px solid #666; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 0.8em; }',
    '.btn-filter.active { background-color: #4CAF50; color: white; border-color: #4CAF50; } .btn-filter:hover { background-color: #555; }',
    'h2 { font-size: 1.1rem; color: #adb5bd; margin: 1.5rem 0 0.75rem 0; padding: 0 20px; border-bottom: 1px solid #444; padding-bottom: 0.5rem; }',
    '.scrollable-table { max-height: 600px; overflow-y: auto; }',
    '.teyit-uyumlu { color: #198754; font-weight: bold; } .teyit-zayif { color: #ffc107; font-weight: bold; } .teyit-ters { color: #dc3545; font-weight: bold; }',
    '.status-onay { color: #198754; font-weight: bold; }',
    '.price-up { color: #1a7a3a; font-weight: bold; } .price-down { color: #9d3131; font-weight: bold; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="container-fluid">',
    '<header>',
    '<h1>Sonny AI Trader (V6 - V45 Arayüzü)</h1>',
    '<div id="scan-status"><div id="scan-spinner"></div><span id="scan-status-text">Sunucuya bağlanılıyor...</span></div>',
    '</header>',

    '<div class="manual-analysis">',
    '<div class="manual-input-row">',
    '<input type="text" id="symbol-input" placeholder="Manuel Analiz (örn: BTC)">',
    '<button id="analyze-button">Analiz Et</button>',
    '</div>',
    '</div>',

    '<div class="table-container">',
    '<h2>⚡ Anlık Sinyaller (1H Momentum)</h2>',
    '<div id="momentum-table-container" class="table-wrapper scrollable-table">',
    '<table class="momentum-table">',
    '<thead><tr><th>Zaman</th><th>Sembol</th><th>Sinyal</th><th>Giriş</th><th>Açıklama (Hacim/Fiyat)</th></tr></thead>',
    '<tbody id="momentum-table-body"><tr><td colspan="5" style="text-align:center;color:#666;padding:15px;">Henüz momentum sinyali yok.</td></tr></tbody>',
    '</table>',
    '</div>',
    '</div>',

    '<div class="table-container">',
    '<h2>📈 Bekleyen Kurulumlar (Kırılım)</h2>',
    '<div class="filter-section">',
    '<label for="confidence-threshold">Min. Güven:</label>',
    '<input type="number" id="confidence-threshold" value="0" min="0" max="100">',
    '<button id="apply-filter-button">Filtrele</button>',
    '<button id="show-all-button">Tümünü Göster</button>',
    '<div style="margin-left: auto;">',
    '<button class="btn-filter active" data-strategy="ALL">TÜMÜ</button>',
    '<button class="btn-filter" data-strategy="BRK1H">KIRILIM 1H</button>',
    '<button class="btn-filter" data-strategy="BRK2H">KIRILIM 2H</button>',
    '<button class="btn-filter" data-strategy="BRK4H">KIRILIM 4H</button>',
    '<button class="btn-filter" data-strategy="MOMENTUM1H">MOMENTUM 1H</button>',
    '</div>',
    '</div>',
    '<div id="signal-table-container" class="table-wrapper scrollable-table">',
    '<table class="main-signal-table">',
    '<thead><tr>',
    '<th data-sort="timestamp">Zaman ▼</th>',
    '<th data-sort="symbol">Sembol (Strateji)</th>',
    '<th data-sort="signal">Yön</th>',
    '<th data-sort="confidence">Güven %</th>',
    '<th>Giriş Fiyatı</th>',
    '<th>TP / SL</th>',
    '<th data-sort="RR">R/R</th>',
    '<th>Hacim</th>',
    '<th>Açıklama / Strateji</th>',
    '</tr></thead>',
    '<tbody id="signal-table-body"><tr><td colspan="9" style="text-align:center;color:#666;padding:15px;">Henüz kurulum sinyali yok.</td></tr></tbody>',
    '</table>',
    '</div>',
    '</div>',

    '</div>',
    '<script src="/app.js"></script>',
    '</body>',
    '</html>'
  ].join('\n');
  res.type('html').send(html);
});

// ============================================================
// APP.JS
// ============================================================

app.get('/app.js', (req, res) => {
  const js = [
    'var signalTableBody = document.getElementById("signal-table-body");',
    'var momentumTableBody = document.getElementById("momentum-table-body");',
    'var symbolInput = document.getElementById("symbol-input");',
    'var analyzeButton = document.getElementById("analyze-button");',
    'var confidenceThresholdInput = document.getElementById("confidence-threshold");',
    'var applyFilterButton = document.getElementById("apply-filter-button");',
    'var showAllButton = document.getElementById("show-all-button");',
    'var scanStatusText = document.getElementById("scan-status-text");',
    'var scanSpinner = document.getElementById("scan-spinner");',
    '',
    'var allSignals = {};',
    'var momentumSignals = [];',
    'var mainSortState = { key: "timestamp", direction: "desc" };',
    'var currentThreshold = 0;',
    'var activeStrategyFilter = "ALL";',
    'var MAX_MOMENTUM_SIGNALS = 50;',
    '',
    'function formatTimestamp(ts) {',
    '  if (!ts) return "---";',
    '  try { return new Date(ts).toLocaleTimeString("tr-TR"); }',
    '  catch (e) { return "---"; }',
    '}',
    '',
    'function getStrategyTag(st) {',
    '  if (!st) return "";',
    '  if (st === "MOMENTUM1H") return \'<span class="strategy-momentum1h">(1H Momentum)</span>\';',
    '  if (st === "BRK1H") return \'<span class="strategy-brk1h">(1H Kırılım)</span>\';',
    '  if (st === "BRK2H") return \'<span class="strategy-brk2h">(2H Kırılım)</span>\';',
    '  if (st === "BRK4H") return \'<span class="strategy-brk4h">(4H Kırılım)</span>\';',
    '  return \'<span class="strategy-stochema">(\' + st + \')</span>\';',
    '}',
    '',
    'function formatReasonText(r) {',
    '  if (!r) return "---";',
    '  try {',
    '    r = r.replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");',
    '    r = r.replace(/FİLTRELENDİ/g, \'<span class="teyit-ters">FİLTRELENDİ</span>\');',
    '    r = r.replace(/\\[İZLE\\]/g, \'<span class="status-onay">İZLE</span>\');',
    '    return r;',
    '  } catch (e) { return r; }',
    '}',
    '',
    'function sortSignals(arr, key, dir) {',
    '  if (!arr) return;',
    '  arr.sort(function(a, b) {',
    '    var av = a[key], bv = b[key];',
    '    if (key === "timestamp" || key === "confidence" || key === "RR") {',
    '      av = parseFloat(av) || 0; bv = parseFloat(bv) || 0;',
    '      return dir === "asc" ? av - bv : bv - av;',
    '    }',
    '    av = (av || "").toString().toLowerCase(); bv = (bv || "").toString().toLowerCase();',
    '    if (av < bv) return dir === "asc" ? -1 : 1;',
    '    if (av > bv) return dir === "asc" ? 1 : -1;',
    '    return 0;',
    '  });',
    '}',
    '',
    'function createMainSignalRow(sig) {',
    '  var row = document.createElement("tr");',
    '  row.id = "signal-" + (sig.id || Math.random());',
    '  var cls = "bg-wait";',
    '  if (sig.signal === "LONG") cls = "signal-pending-long compact-signal";',
    '  else if (sig.signal === "SHORT") cls = "signal-pending-short compact-signal";',
    '  else if (sig.isFiltered) cls = "status-reddet compact-signal";',
    '',
    '  var tvSymbol = (sig.symbol || "").replace("USDT", "");',
    '  var tvLink = "https://www.tradingview.com/chart/?symbol=BITGET:" + tvSymbol + "USDT.P";',
    '  var strategyTag = getStrategyTag(sig.strategyType);',
    '  var conf = sig.confidence ? sig.confidence + "%" : "---";',
    '  var reason = formatReasonText(sig.tacticalAnalysis || sig.reason);',
    '  var rr = sig.RR && sig.RR !== "N/A" && parseFloat(sig.RR) > 0 ? sig.RR : "---";',
    '  var tpSl = (sig.TP && sig.TP !== "---") ? "TP: " + sig.TP + " / SL: " + sig.SL : "---";',
    '  var entryStyle = "font-weight:bold; color: #ffc107;";',
    '  var vol = sig.volumeRatio ? sig.volumeRatio.toFixed(2) + "x" : "---";',
    '',
    '  row.innerHTML =',
    '    "<td>" + formatTimestamp(sig.timestamp) + "</td>" +',
    '    \'<td><a href="\' + tvLink + \'" target="_blank" class="link-text">\' + (sig.symbol || "N/A") + \'</a> \' + strategyTag + "</td>" +',
    '    \'<td class="\' + cls + \'">\' + (sig.signal || "WAIT") + "</td>" +',
    '    \'<td style="text-align: right;">\' + conf + "</td>" +',
    '    \'<td style="text-align: right; \' + entryStyle + \'">\' + (sig.entryPrice || "---") + "</td>" +',
    '    "<td>" + tpSl + "</td>" +',
    '    \'<td style="text-align: right;">\' + rr + "</td>" +',
    '    "<td>" + vol + "</td>" +',
    '    \'<td style="white-space: normal;">\' + reason + "</td>";',
    '  return row;',
    '}',
    '',
    'function createMomentumSignalRow(sig) {',
    '  var row = document.createElement("tr");',
    '  row.id = "momentum-" + (sig.id || Math.random());',
    '  var cls = sig.signal === "PUMP" ? "bg-pump compact-signal" : "bg-dump compact-signal";',
    '  var tvSymbol = (sig.symbol || "").replace("USDT", "");',
    '  var tvLink = "https://www.tradingview.com/chart/?symbol=BITGET:" + tvSymbol + "USDT.P";',
    '  row.innerHTML =',
    '    "<td>" + formatTimestamp(sig.timestamp) + "</td>" +',
    '    \'<td><a href="\' + tvLink + \'" target="_blank" class="link-text">\' + (sig.symbol || "N/A") + "</a></td>" +',
    '    \'<td class="\' + cls + \'">\' + (sig.signal || "?") + "</td>" +',
    '    \'<td style="text-align: right;">\' + (sig.entryPrice || "---") + "</td>" +',
    '    \'<td style="white-space: normal;">\' + (sig.tacticalAnalysis || sig.reason || "---") + "</td>";',
    '  return row;',
    '}',
    '',
    'function renderMainSignals() {',
    '  var arr = Object.values(allSignals);',
    '  sortSignals(arr, mainSortState.key, mainSortState.direction);',
    '  signalTableBody.innerHTML = "";',
    '  var filtered = arr.filter(function(s) {',
    '    if (!s || typeof s.confidence === "undefined") return false;',
    '    var conf = parseInt(s.confidence);',
    '    if (conf < currentThreshold) return false;',
    '    if (activeStrategyFilter === "ALL") return true;',
    '    if (activeStrategyFilter === "MOMENTUM1H") return false;',
    '    return s.strategyType === activeStrategyFilter;',
    '  });',
    '  if (!filtered.length) {',
    '    signalTableBody.innerHTML = \'<tr><td colspan="9" style="text-align:center;color:#666;padding:15px;">Filtreye uygun sinyal yok.</td></tr>\';',
    '    return;',
    '  }',
    '  filtered.forEach(function(s) { signalTableBody.appendChild(createMainSignalRow(s)); });',
    '}',
    '',
    'function renderMomentumSignals() {',
    '  sortSignals(momentumSignals, "timestamp", "desc");',
    '  momentumTableBody.innerHTML = "";',
    '  if (!momentumSignals.length) {',
    '    momentumTableBody.innerHTML = \'<tr><td colspan="5" style="text-align:center;color:#666;padding:15px;">Henüz momentum sinyali yok.</td></tr>\';',
    '    return;',
    '  }',
    '  momentumSignals.slice(0, MAX_MOMENTUM_SIGNALS).forEach(function(s) { momentumTableBody.appendChild(createMomentumSignalRow(s)); });',
    '}',
    '',
    'async function refreshData() {',
    '  try {',
    '    var res = await fetch("/api/signals");',
    '    var data = await res.json();',
    '    if (scanStatusText) scanStatusText.textContent = data.scanStatus ? data.scanStatus.message : "Tarama...";',
    '',
    '    var allKirilim = data.kirilimSignals || [];',
    '    var priority = { "BRK4H": 3, "BRK2H": 2, "BRK1H": 1 };',
    '    allSignals = allKirilim.reduce(function(obj, item) {',
    '      var cp = priority[item.strategyType] || 0;',
    '      var ex = obj[item.symbol];',
    '      var ep = ex ? (priority[ex.strategyType] || 0) : 0;',
    '      if (cp >= ep) obj[item.symbol] = item;',
    '      return obj;',
    '    }, {});',
    '',
    '    momentumSignals = (data.momentumSignals || []).slice();',
    '    renderMainSignals();',
    '    renderMomentumSignals();',
    '  } catch (e) {',
    '    if (scanStatusText) scanStatusText.textContent = "Sunucu hatası: " + e.message;',
    '  }',
    '}',
    '',
    'document.querySelectorAll(".main-signal-table thead th[data-sort]").forEach(function(h) {',
    '  h.addEventListener("click", function() {',
    '    var k = h.getAttribute("data-sort");',
    '    var dir = mainSortState.key === k ? (mainSortState.direction === "asc" ? "desc" : "asc") : "desc";',
    '    mainSortState = { key: k, direction: dir };',
    '    renderMainSignals();',
    '  });',
    '});',
    '',
    'document.querySelectorAll(".btn-filter").forEach(function(b) {',
    '  b.addEventListener("click", function() {',
    '    document.querySelectorAll(".btn-filter").forEach(function(x) { x.classList.remove("active"); });',
    '    b.classList.add("active");',
    '    activeStrategyFilter = b.getAttribute("data-strategy");',
    '    renderMainSignals();',
    '  });',
    '});',
    '',
    'applyFilterButton.addEventListener("click", function() {',
    '  currentThreshold = parseInt(confidenceThresholdInput.value) || 0;',
    '  renderMainSignals();',
    '});',
    '',
    'showAllButton.addEventListener("click", function() {',
    '  currentThreshold = 0;',
    '  confidenceThresholdInput.value = 0;',
    '  renderMainSignals();',
    '});',
    '',
    'analyzeButton.addEventListener("click", async function() {',
    '  var symbol = symbolInput.value.trim().toUpperCase();',
    '  if (!symbol) return;',
    '  analyzeButton.disabled = true;',
    '  analyzeButton.textContent = "Analiz...";',
    '  try {',
    '    var r = await fetch("/api/analyze-coin", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ symbol: symbol })',
    '    });',
    '    var result = await r.json();',
    '    alert("Analiz: " + JSON.stringify(result).slice(0, 300));',
    '    symbolInput.value = "";',
    '  } catch (e) { alert("Hata: " + e.message); }',
    '  finally {',
    '    analyzeButton.disabled = false;',
    '    analyzeButton.textContent = "Analiz Et";',
    '  }',
    '});',
    '',
    'refreshData();',
    'setInterval(refreshData, 5000);'
  ].join('\n');

  res.type('application/javascript').send(js);
});

// ============================================================
// START
// ============================================================

async function boot() {
  console.log('');
  console.log('==========================================');
  console.log(' SONNY AI TRADER V6 + V45 TABLO ARAYÜZÜ');
  console.log('==========================================');
  console.log('');

  try {
    await loadSymbols();
    console.log('Historical candle yüklemesi başlıyor...');
    const symbols = Array.from(state.symbols.keys()).slice(0, CFG.MAX_SYMBOLS);
    for (let i = 0; i < symbols.length; i++) {
      await load1HCandles(symbols[i]);
      await new Promise(r => setTimeout(r, 80));
    }
    console.log('Historical seviyeler hazır.');
    connectWS();
    setInterval(scan, CFG.SCAN_INTERVAL_MS);
    scan();
  } catch (err) {
    console.error('BOOT ERROR:', err);
    process.exit(1);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
  boot();
});
