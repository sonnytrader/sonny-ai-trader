// server.js (V6 - Trend Yaklaşma Radarı - Temiz Tasarım)
// Sade, okunaklı dashboard. 8 sütun, detay toggle, kritik üstte.
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

  TREND_LOOKBACK: 40,
  TREND_PIVOT_LEFT: 2,
  TREND_PIVOT_RIGHT: 2,
  TREND_MIN_PIVOTS: 3,
  TREND_MIN_R2: 0.70,

  WATCH_DISTANCE_PCT: 2.00,
  NEAR_DISTANCE_PCT: 1.20,
  IGNITION_DISTANCE_PCT: 0.55,
  ENTRY_DISTANCE_PCT: 0.18,

  WATCH_SCORE: 50,
  IGNITION_SCORE: 65,
  ENTRY_SCORE: 80,

  SIGNAL_TTL_MS: 8 * 60 * 1000,
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
  trendSignals: [],
  cooldowns: {},
  ws: null,
  wsConnected: false,
  stats: { symbols: 0, scans: 0, signals: 0, lastScan: null }
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
      priceHistory: [], flowHistory: [],
      h1Candles: [], twoHCandles: [],
      trendUp: null, trendDown: null, signal: null
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

// ============================================================
// CANDLES
// ============================================================

async function load1HCandles(symbol) {
  try {
    const json = await rest('/api/v3/market/candles', {
      category: 'USDT-FUTURES', symbol, interval: '1H', limit: 200
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
  s.twoHCandles = result;
  detectTrendLines(symbol);
}

// ============================================================
// PIVOT + REGRESYON
// ============================================================

function findPivotHighs(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let ok = true;
    for (let x = 1; x <= left; x++) if (!candles[i - x] || candles[i - x].high >= c.high) { ok = false; break; }
    if (ok) for (let x = 1; x <= right; x++) if (!candles[i + x] || candles[i + x].high > c.high) { ok = false; break; }
    if (ok) pivots.push({ index: i, price: c.high, ts: c.ts });
  }
  return pivots;
}
function findPivotLows(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let ok = true;
    for (let x = 1; x <= left; x++) if (!candles[i - x] || candles[i - x].low <= c.low) { ok = false; break; }
    if (ok) for (let x = 1; x <= right; x++) if (!candles[i + x] || candles[i + x].low < c.low) { ok = false; break; }
    if (ok) pivots.push({ index: i, price: c.low, ts: c.ts });
  }
  return pivots;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const predY = a * p.x + b;
    ssRes += Math.pow(p.y - predY, 2);
    ssTot += Math.pow(p.y - meanY, 2);
  }
  const r2 = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);
  return { a, b, r2, n };
}

function detectTrendLines(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;
  if (!candles || candles.length < CFG.TREND_LOOKBACK) return;
  const recent = candles.slice(-CFG.TREND_LOOKBACK);

  // Düşen direnç
  const pivotHighs = findPivotHighs(recent, CFG.TREND_PIVOT_LEFT, CFG.TREND_PIVOT_RIGHT);
  if (pivotHighs.length >= CFG.TREND_MIN_PIVOTS) {
    const latest = pivotHighs.slice(-Math.min(pivotHighs.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.TREND_MIN_R2 && reg.a < 0) {
      const currentX = recent.length - 1;
      s.trendDown = {
        slope: reg.a, intercept: reg.b, r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * currentX + reg.b,
        updatedAt: now()
      };
    } else s.trendDown = null;
  } else s.trendDown = null;

  // Yükselen destek
  const pivotLows = findPivotLows(recent, CFG.TREND_PIVOT_LEFT, CFG.TREND_PIVOT_RIGHT);
  if (pivotLows.length >= CFG.TREND_MIN_PIVOTS) {
    const latest = pivotLows.slice(-Math.min(pivotLows.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.TREND_MIN_R2 && reg.a > 0) {
      const currentX = recent.length - 1;
      s.trendUp = {
        slope: reg.a, intercept: reg.b, r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * currentX + reg.b,
        updatedAt: now()
      };
    } else s.trendUp = null;
  } else s.trendUp = null;
}

// ============================================================
// YAKLAŞMA
// ============================================================

function checkTrendApproach(symbol) {
  const s = getSymbol(symbol);
  if (!s.price || !s.twoHCandles || s.twoHCandles.length < 10) return null;
  const price = s.price;
  const candidates = [];

  if (s.trendDown) {
    const lineValue = s.trendDown.currentValue;
    const distance = absPct(price, lineValue);
    if (distance <= CFG.WATCH_DISTANCE_PCT) {
      candidates.push({
        direction: 'LONG',
        trendType: 'DOWN_RESISTANCE',
        lineValue, distance,
        r2: s.trendDown.r2,
        pivotCount: s.trendDown.pivotCount,
        broken: price > lineValue
      });
    }
  }

  if (s.trendUp) {
    const lineValue = s.trendUp.currentValue;
    const distance = absPct(price, lineValue);
    if (distance <= CFG.WATCH_DISTANCE_PCT) {
      candidates.push({
        direction: 'SHORT',
        trendType: 'UP_SUPPORT',
        lineValue, distance,
        r2: s.trendUp.r2,
        pivotCount: s.trendUp.pivotCount,
        broken: price < lineValue
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0];
}

// ============================================================
// METRİKLER
// ============================================================

function calculateVolumeRatio(symbol) {
  const s = getSymbol(symbol);
  const c = s.twoHCandles;
  if (!c || c.length < 21) return 1;
  const last = c[c.length - 1];
  const prev = c.slice(-21, -1);
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

// ============================================================
// SKOR
// ============================================================

function calculateScore(symbol, info) {
  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);
  const direction = info.direction;

  let score = 0;

  if (info.r2 >= 0.85) score += 25;
  else if (info.r2 >= 0.75) score += 18;
  else if (info.r2 >= 0.70) score += 12;

  if (info.pivotCount >= 5) score += 10;
  else if (info.pivotCount >= 4) score += 6;
  else if (info.pivotCount >= 3) score += 3;

  if (info.distance <= CFG.ENTRY_DISTANCE_PCT) score += 30;
  else if (info.distance <= CFG.IGNITION_DISTANCE_PCT) score += 22;
  else if (info.distance <= CFG.NEAR_DISTANCE_PCT) score += 14;
  else if (info.distance <= CFG.WATCH_DISTANCE_PCT) score += 8;

  if (vr >= 1.9) score += 15;
  else if (vr >= 1.5) score += 12;
  else if (vr >= 1.2) score += 8;

  if (oi >= 0.15) score += 10;
  else if (oi >= 0.08) score += 7;
  else if (oi >= 0.03) score += 4;

  const flowDir = direction === 'LONG' ? flow : (1 - flow);
  if (flowDir >= 0.63) score += 5;
  else if (flowDir >= 0.54) score += 3;

  const momDir = (direction === 'LONG' && mom > 0) || (direction === 'SHORT' && mom < 0);
  if (momDir && Math.abs(mom) >= 0.15) score += 5;

  if (info.broken) score += 5;

  return Math.min(100, Math.round(score));
}

// ============================================================
// SINYAL
// ============================================================

function classifySignal(symbol, info) {
  const s = getSymbol(symbol);
  const score = calculateScore(symbol, info);

  let stateName = null;
  if (info.broken) {
    stateName = info.direction === 'LONG' ? 'KIRILDI' : 'KIRILDI';
  } else if (score >= CFG.ENTRY_SCORE || info.distance <= CFG.ENTRY_DISTANCE_PCT) {
    stateName = 'GİRİŞ FIRSATI';
  } else if (score >= CFG.IGNITION_SCORE || info.distance <= CFG.IGNITION_DISTANCE_PCT) {
    stateName = 'HAREKET BAŞLADI';
  } else if (score >= CFG.WATCH_SCORE || info.distance <= CFG.NEAR_DISTANCE_PCT) {
    stateName = 'YAKLAŞIYOR';
  } else {
    stateName = 'İZLE';
  }

  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);

  // KISA açıklama (detay için ayrı alan)
  const parts = [];
  if (vr >= 1.9) parts.push(`🐋 Hacim ${vr.toFixed(1)}x`);
  else if (vr >= 1.5) parts.push(`👍 Hacim ${vr.toFixed(1)}x`);
  else if (vr < 1.2) parts.push(`👎 Hacim ${vr.toFixed(1)}x`);

  if (oi >= 0.15) parts.push(`📈 OI %${oi.toFixed(2)}`);

  const flowDir = info.direction === 'LONG' ? flow : (1 - flow);
  if (flowDir >= 0.63) parts.push(`🟢 Flow %${(flowDir * 100).toFixed(0)}`);
  else if (flowDir < 0.45) parts.push(`🔴 Flow %${(flowDir * 100).toFixed(0)}`);

  if ((info.direction === 'LONG' && mom > 0.15) || (info.direction === 'SHORT' && mom < -0.15)) {
    parts.push(`🚀 Momentum %${mom.toFixed(2)}`);
  }

  const shortReason = parts.length ? parts.join(' · ') : 'Sadece trend yakınlığı';

  // UZUN analiz (detay paneli)
  let long = `📐 Trend: R²=${info.r2.toFixed(2)}, ${info.pivotCount} pivot. `;
  if (info.trendType === 'DOWN_RESISTANCE') long += `🔺 Düşen direnç çizgisi (${info.lineValue.toFixed(6)}). Yukarı kırılım = LONG. `;
  else long += `🔻 Yükselen destek çizgisi (${info.lineValue.toFixed(6)}). Aşağı kırılım = SHORT. `;

  if (info.broken) long += `⚠️ Çizgi kırıldı. `;
  else long += `⏳ Henüz kırılmadı, %${info.distance.toFixed(2)} mesafe. `;

  if (vr >= 1.9) long += `🐋 Balina hacmi ${vr.toFixed(2)}x. `;
  else if (vr < 1.2) long += `👎 Zayıf hacim ${vr.toFixed(2)}x. `;

  if (oi >= 0.08) long += `📊 OI artıyor %${oi.toFixed(2)}. `;

  if (info.direction === 'LONG') {
    if (flow >= 0.63) long += `🟢 Alım baskısı %${(flow * 100).toFixed(0)}. `;
    else if (flow < 0.45) long += `🔴 Satım baskısı %${(flow * 100).toFixed(0)}. `;
  } else {
    const sf = 1 - flow;
    if (sf >= 0.63) long += `🔴 Satım baskısı %${(sf * 100).toFixed(0)}. `;
    else if (sf < 0.45) long += `🟢 Alım baskısı %${((1 - sf) * 100).toFixed(0)}. `;
  }

  return {
    id: `${symbol}-${info.direction}-${Date.now()}`,
    symbol,
    direction: info.direction,
    signal: info.direction,
    state: stateName,
    score,
    confidence: score,
    shortReason,
    tacticalAnalysis: long,
    reason: shortReason,

    price: s.price,
    lineValue: info.lineValue,
    distancePct: info.distance,
    broken: info.broken,

    entryPrice: s.price.toFixed(6),
    TP: '---', SL: '---', RR: 'N/A',

    volumeRatio: vr,
    oiChangePct: oi,
    flow,
    momentum: mom,

    trendR2: info.r2,
    trendPivots: info.pivotCount,
    trendType: info.trendType,

    strategyType: 'TREND_APPROACH',
    isFiltered: false,

    createdAt: now(),
    timestamp: now(),
    time: new Date().toLocaleTimeString(),
    expiresAt: now() + CFG.SIGNAL_TTL_MS
  };
}

// ============================================================
// EVALUATE
// ============================================================

function evaluateSymbol(symbol) {
  const s = getSymbol(symbol);
  if (!s.price || s.turnover24h < CFG.MIN_24H_TURNOVER) return;

  detectTrendLines(symbol);
  const info = checkTrendApproach(symbol);
  if (!info) { s.signal = null; return; }

  const sig = classifySignal(symbol, info);
  if (!sig) { s.signal = null; return; }

  const ck = `${symbol}-${sig.direction}-${info.trendType}`;
  const cd = state.cooldowns[ck];
  if (cd && cd.timestamp > now() - CFG.SIGNAL_COOLDOWN_MS) { s.signal = sig; return; }

  const prev = s.signal;
  if (!prev || prev.state !== sig.state || Math.abs(prev.score - sig.score) >= 5) {
    s.signal = sig;
    state.cooldowns[ck] = { timestamp: now() };
    state.stats.signals++;
    state.trendSignals.unshift(sig);
    if (state.trendSignals.length > 100) state.trendSignals.pop();
    console.log(`[${sig.state}] ${sig.direction} ${sig.symbol} %${info.distance.toFixed(2)} R²=${info.r2.toFixed(2)}`);
  } else {
    s.signal = { ...prev, ...sig };
  }
}

function scan() {
  state.stats.scans++;
  state.stats.lastScan = now();
  for (const symbol of state.symbols.keys()) {
    try { evaluateSymbol(symbol); } catch (e) {}
  }
  cleanupSignals();
}

function cleanupSignals() {
  const t = now();
  for (const s of state.symbols.values()) if (s.signal && s.signal.expiresAt < t) s.signal = null;
  state.trendSignals = state.trendSignals.filter(s => s.expiresAt > t);
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
      if (ch === 'candle1H') processCandle(msg);
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
    upsertCandle(s.h1Candles, candle, 200);
    build2HCandles(symbol);
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
    ok: true, system: 'SONNY AI TRADER V6', mode: 'TREND YAKLAŞMA',
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
      lineValue: s.trendDown && sig.direction === 'LONG' ? s.trendDown.currentValue
               : s.trendUp && sig.direction === 'SHORT' ? s.trendUp.currentValue
               : sig.lineValue,
      distancePct: s.trendDown && sig.direction === 'LONG' ? absPct(s.price, s.trendDown.currentValue)
                 : s.trendUp && sig.direction === 'SHORT' ? absPct(s.price, s.trendUp.currentValue)
                 : sig.distancePct,
      volumeRatio: calculateVolumeRatio(sig.symbol),
      oiChangePct: oiChange(sig.symbol),
      flow: flowScore(sig.symbol),
      momentum: priceMomentum(sig.symbol)
    };
  };
  res.json({
    ok: true, serverTime: now(),
    trendSignals: state.trendSignals.slice(0, 100).map(enrich),
    scanStatus: {
      message: state.stats.lastScan ? `Tarama Tamamlandı. ${state.trendSignals.length} yaklaşma sinyali aktif.` : 'Tarama bekleniyor...',
      isScanning: false
    }
  });
});

// ============================================================
// HTML - SADE TASARIM
// ============================================================

app.get('/', (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Sonny AI Trader - Trend Yaklaşma Radarı</title>',
    '<style>',
    '* { box-sizing: border-box; }',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 12px; font-size: 13px; }',
    '.wrap { max-width: 1500px; margin: 0 auto; }',
    '',
    '/* HEADER */',
    '.hdr { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }',
    '.hdr h1 { margin: 0; font-size: 18px; color: #58a6ff; }',
    '.hdr .sub { color: #8b949e; font-size: 12px; margin-top: 4px; }',
    '.stats { display: flex; gap: 18px; font-size: 12px; }',
    '.stat { text-align: right; }',
    '.stat .num { font-size: 18px; font-weight: bold; color: #3fb950; display: block; }',
    '.stat .lbl { color: #8b949e; }',
    '',
    '/* FILTER BAR */',
    '.filterbar { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
    '.filterbar label { color: #8b949e; font-size: 12px; }',
    '.filterbar input { width: 60px; padding: 5px 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 5px; color: #c9d1d9; font-size: 12px; }',
    '.filterbar button { padding: 5px 12px; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 600; }',
    '.btn-apply { background: #238636; color: white; }',
    '.btn-apply:hover { background: #2ea043; }',
    '.btn-show { background: #21262d; color: #c9d1d9; }',
    '.btn-show:hover { background: #30363d; }',
    '',
    '/* LEGEND */',
    '.legend { margin-left: auto; font-size: 11px; color: #8b949e; }',
    '.legend b { color: #c9d1d9; }',
    '',
    '/* TABLE */',
    '.tablewrap { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }',
    'table { width: 100%; border-collapse: collapse; }',
    'thead th { background: #1c2128; color: #8b949e; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left; border-bottom: 1px solid #30363d; white-space: nowrap; }',
    'tbody td { padding: 10px 12px; border-bottom: 1px solid #21262d; font-size: 13px; vertical-align: middle; }',
    'tbody tr:hover { background: #1c2128; }',
    'tbody tr:last-child td { border-bottom: none; }',
    '',
    '/* COLUMN WIDTHS */',
    'th:nth-child(1), td:nth-child(1) { width: 70px; }',
    'th:nth-child(2), td:nth-child(2) { width: 150px; }',
    'th:nth-child(3), td:nth-child(3) { width: 90px; }',
    'th:nth-child(4), td:nth-child(4) { width: 130px; }',
    'th:nth-child(5), td:nth-child(5) { width: 70px; text-align: center; }',
    'th:nth-child(6), td:nth-child(6) { width: 130px; text-align: right; }',
    'th:nth-child(7), td:nth-child(7) { width: 110px; }',
    'th:nth-child(8), td:nth-child(8) { width: 60px; text-align: center; }',
    'th:nth-child(9), td:nth-child(9) { width: auto; }',
    '',
    '/* STATE BADGES */',
    '.badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.3px; }',
    '.b-broken { background: #238636; color: white; }',
    '.b-entry { background: #da3633; color: white; }',
    '.b-ignition { background: #d29922; color: black; }',
    '.b-near { background: #1f6feb; color: white; }',
    '.b-watch { background: #21262d; color: #8b949e; border: 1px solid #30363d; }',
    '',
    '.dir-long { color: #3fb950; font-weight: 700; }',
    '.dir-short { color: #f85149; font-weight: 700; }',
    '',
    /* R² bar */
    '.r2 { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; }',
    '.r2 .bar { width: 40px; height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; }',
    '.r2 .fill { height: 100%; background: #3fb950; }',
    '.r2 .fill.mid { background: #d29922; }',
    '.r2 .fill.low { background: #8b949e; }',
    '',
    /* Distance bar */
    '.dist { display: flex; flex-direction: column; gap: 3px; }',
    '.dist .bar { width: 100%; height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; position: relative; }',
    '.dist .fill { height: 100%; background: #3fb950; }',
    '.dist .fill.warn { background: #d29922; }',
    '.dist .fill.crit { background: #da3633; }',
    '.dist .txt { font-size: 11px; color: #8b949e; }',
    '',
    '.price { font-family: "SF Mono", Monaco, monospace; font-size: 12px; color: #c9d1d9; text-align: right; }',
    '.price b { color: #ffc107; }',
    '',
    '.reason { color: #8b949e; font-size: 12px; line-height: 1.5; }',
    '.reason b { color: #c9d1d9; font-weight: 600; }',
    '',
    '.btn-detail { background: none; border: 1px solid #30363d; color: #8b949e; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }',
    '.btn-detail:hover { background: #21262d; color: #c9d1d9; }',
    '',
    '.detail-row { display: none; background: #0d1117; }',
    '.detail-row.show { display: table-row; }',
    '.detail-row td { padding: 12px 20px; color: #8b949e; font-size: 12px; line-height: 1.7; border-bottom: 1px solid #21262d; }',
    '.detail-row b { color: #c9d1d9; }',
    '',
    '.empty { padding: 40px; text-align: center; color: #484f58; }',
    '.tv-link { color: #58a6ff; text-decoration: none; font-weight: 600; }',
    '.tv-link:hover { text-decoration: underline; }',
    '',
    '.sortable { cursor: pointer; user-select: none; }',
    '.sortable:hover { color: #c9d1d9; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',

    '<div class="hdr">',
    '<div>',
    '<h1>📐 Trend Yaklaşma Radarı</h1>',
    '<div class="sub">2H eğimli trend çizgisi yaklaşma uyarısı · <span id="scan-status">bağlanılıyor...</span></div>',
    '</div>',
    '<div class="stats">',
    '<div class="stat"><span class="num" id="stat-signals">0</span><span class="lbl">Aktif Sinyal</span></div>',
    '<div class="stat"><span class="num" id="stat-symbols">0</span><span class="lbl">Coin</span></div>',
    '<div class="stat"><span class="num" id="stat-scans">0</span><span class="lbl">Tarama</span></div>',
    '</div>',
    '</div>',

    '<div class="filterbar">',
    '<label>Min Güven:</label>',
    '<input type="number" id="conf-input" value="0" min="0" max="100">',
    '<button class="btn-apply" id="btn-apply">Uygula</button>',
    '<button class="btn-show" id="btn-show">Tümü</button>',
    '<div class="legend">',
    '<b>%2.00</b> İZLE · <b>%1.20</b> YAKLAŞIYOR · <b>%0.55</b> HAREKET · <b>%0.18</b> GİRİŞ',
    '</div>',
    '</div>',

    '<div class="tablewrap">',
    '<table>',
    '<thead><tr>',
    '<th>Zaman</th>',
    '<th>Sembol</th>',
    '<th>Yön</th>',
    '<th>Durum</th>',
    '<th>Güven</th>',
    '<th>Fiyat / Çizgi</th>',
    '<th>Uzaklık</th>',
    '<th>R²</th>',
    '<th>Özet</th>',
    '</tr></thead>',
    '<tbody id="tbody">',
    '<tr><td colspan="9" class="empty">Yükleniyor...</td></tr>',
    '</tbody>',
    '</table>',
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
    'var tbody = document.getElementById("tbody");',
    'var scanStatusEl = document.getElementById("scan-status");',
    'var statSignals = document.getElementById("stat-signals");',
    'var statSymbols = document.getElementById("stat-symbols");',
    'var statScans = document.getElementById("stat-scans");',
    'var confInput = document.getElementById("conf-input");',
    'var btnApply = document.getElementById("btn-apply");',
    'var btnShow = document.getElementById("btn-show");',
    '',
    'var allSignals = [];',
    'var currentThreshold = 0;',
    '',
    'var STATE_ORDER = { "KIRILDI": 5, "GİRİŞ FIRSATI": 4, "HAREKET BAŞLADI": 3, "YAKLAŞIYOR": 2, "İZLE": 1 };',
    '',
    'function timeStr(ts) {',
    '  if (!ts) return "---";',
    '  try { var d = new Date(ts); return d.toTimeString().slice(0, 5); } catch (e) { return "---"; }',
    '}',
    '',
    'function stateBadge(state) {',
    '  var cls = "b-watch";',
    '  if (state === "KIRILDI") cls = "b-broken";',
    '  else if (state === "GİRİŞ FIRSATI") cls = "b-entry";',
    '  else if (state === "HAREKET BAŞLADI") cls = "b-ignition";',
    '  else if (state === "YAKLAŞIYOR") cls = "b-near";',
    '  return \'<span class="badge \' + cls + \'">\' + state + "</span>";',
    '}',
    '',
    'function dirCls(dir) { return dir === "LONG" ? "dir-long" : "dir-short"; }',
    '',
    'function r2Bar(r2) {',
    '  var pct = Math.round(r2 * 100);',
    '  var fillCls = r2 >= 0.85 ? "" : (r2 >= 0.75 ? "mid" : "low");',
    '  return \'<div class="r2"><div class="bar"><div class="fill \' + fillCls + \'" style="width:\' + pct + \'%"></div></div>\' + pct + \'%</div>\';',
    '}',
    '',
    'function distBar(d) {',
    '  var pct = Math.min(100, (d / 2) * 100);',
    '  var cls = d <= 0.18 ? "crit" : (d <= 0.55 ? "warn" : "");',
    '  return \'<div class="dist"><div class="bar"><div class="fill \' + cls + \'" style="width:\' + pct + \'%"></div></div><div class="txt">%\' + d.toFixed(2) + \'</div></div>\';',
    '}',
    '',
    'function createRow(sig) {',
    '  var tr = document.createElement("tr");',
    '  var r2 = parseFloat(sig.trendR2) || 0;',
    '  var dist = parseFloat(sig.distancePct) || 0;',
    '  var tvSymbol = (sig.symbol || "").replace("USDT", "");',
    '  var tvLink = "https://www.tradingview.com/chart/?symbol=BITGET:" + tvSymbol + "USDT.P&interval=120";',
    '',
    '  tr.innerHTML =',
    '    \'<td>\' + timeStr(sig.timestamp) + \'</td>\' +',
    '    \'<td><a href="\' + tvLink + \'" target="_blank" class="tv-link">\' + (sig.symbol || "N/A") + \'</a></td>\' +',
    '    \'<td class="\' + dirCls(sig.direction) + \'">\' + sig.direction + \'</td>\' +',
    '    \'<td>\' + stateBadge(sig.state) + \'</td>\' +',
    '    \'<td style="text-align:center;font-weight:bold;">\' + (sig.confidence || "---") + \'%</td>\' +',
    '    \'<td class="price"><b>\' + (sig.entryPrice || "---") + \'</b><br><span style="color:#ff9800;font-size:11px;">\' + (sig.lineValue ? sig.lineValue.toFixed(6) : "---") + \'</span></td>\' +',
    '    \'<td>\' + distBar(dist) + \'</td>\' +',
    '    \'<td>\' + r2Bar(r2) + \'</td>\' +',
    '    \'<td class="reason">\' + (sig.shortReason || "---") + \' <button class="btn-detail" onclick="toggleDetail(this)">Detay</button></td>\';',
    '',
    '  // Detay satırı',
    '  var detailTr = document.createElement("tr");',
    '  detailTr.className = "detail-row";',
    '  detailTr.innerHTML = \'<td colspan="9">\' + (sig.tacticalAnalysis || "Detay yok.") + \'</td>\';',
    '  tr._detail = detailTr;',
    '',
    '  return tr;',
    '}',
    '',
    'function toggleDetail(btn) {',
    '  var tr = btn.closest("tr");',
    '  var detail = tr._detail;',
    '  if (!detail) return;',
    '  if (detail.classList.contains("show")) {',
    '    detail.classList.remove("show");',
    '    btn.textContent = "Detay";',
    '  } else {',
    '    detail.classList.add("show");',
    '    btn.textContent = "Gizle";',
    '  }',
    '}',
    'window.toggleDetail = toggleDetail;',
    '',
    'function render() {',
    '  tbody.innerHTML = "";',
    '',
    '  // Filtre',
    '  var filtered = allSignals.filter(function(s) {',
    '    return (parseInt(s.confidence) || 0) >= currentThreshold;',
    '  });',
    '',
    '  // Önem sırasına göre sırala',
    '  filtered.sort(function(a, b) {',
    '    var oa = STATE_ORDER[a.state] || 0;',
    '    var ob = STATE_ORDER[b.state] || 0;',
    '    if (oa !== ob) return ob - oa;',
    '    return (parseFloat(b.distancePct) || 0) - (parseFloat(a.distancePct) || 0);',
    '  });',
    '',
    '  if (!filtered.length) {',
    '    tbody.innerHTML = \'<tr><td colspan="9" class="empty">Filtreye uygun sinyal yok.</td></tr>\';',
    '    return;',
    '  }',
    '',
    '  filtered.forEach(function(sig) {',
    '    var tr = createRow(sig);',
    '    tbody.appendChild(tr);',
    '    if (tr._detail) tbody.appendChild(tr._detail);',
    '  });',
    '}',
    '',
    'async function refresh() {',
    '  try {',
    '    var [sres, sigres] = await Promise.all([fetch("/api/status"), fetch("/api/signals")]);',
    '    var sdata = await sres.json();',
    '    var sigdata = await sigres.json();',
    '',
    '    scanStatusEl.textContent = sigdata.scanStatus ? sigdata.scanStatus.message : "...";',
    '    statSignals.textContent = (sigdata.trendSignals || []).length;',
    '    statSymbols.textContent = sdata.symbols || 0;',
    '    statScans.textContent = sdata.scans || 0;',
    '',
    '    allSignals = sigdata.trendSignals || [];',
    '    render();',
    '  } catch (e) {',
    '    scanStatusEl.textContent = "Sunucu hatası: " + e.message;',
    '  }',
    '}',
    '',
    'btnApply.addEventListener("click", function() {',
    '  currentThreshold = parseInt(confInput.value) || 0;',
    '  render();',
    '});',
    'btnShow.addEventListener("click", function() {',
    '  currentThreshold = 0;',
    '  confInput.value = 0;',
    '  render();',
    '});',
    '',
    'refresh();',
    'setInterval(refresh, 5000);'
  ].join('\n');

  res.type('application/javascript').send(js);
});

// ============================================================
// START
// ============================================================

async function boot() {
  console.log('');
  console.log('==========================================');
  console.log(' SONNY AI TRADER V6 - TREND YAKLAŞMA RADARI');
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
    console.log('Historical veriler hazır.');
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
