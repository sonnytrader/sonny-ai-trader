// server.js (ANA PROJE - V6 + V14.9 Dashboard)
// V6 native Bitget WebSocket + V14.9 dashboard tasarımı
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
// SONNY AI TRADER V6 + V14.9 DASHBOARD
// 2H PRE-BREAKOUT RADAR
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

  watchlist: {},

  cooldowns: {},

  ws: null,
  wsConnected: false,
  wsSubscriptions: [],

  stats: {
    tickerMessages: 0,
    candleMessages: 0,
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function absPct(a, b) {
  return Math.abs(pct(a, b));
}

function now() {
  return Date.now();
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace(/[^A-Z0-9]/g, '');
}

function getSymbol(symbol) {
  if (!state.symbols.has(symbol)) {
    state.symbols.set(symbol, {
      symbol,
      price: 0,
      bid: 0,
      ask: 0,
      bidSize: 0,
      askSize: 0,
      turnover24h: 0,
      volume24h: 0,
      oi: 0,
      prevOi: 0,
      oiUpdatedAt: 0,
      priceHistory: [],
      flowHistory: [],
      minuteCandles: [],
      h1Candles: [],
      twoHCandles: [],
      level: null,
      signal: null
    });
  }
  return state.symbols.get(symbol);
}

// ============================================================
// REST
// ============================================================

async function rest(path, params = {}) {
  const url = new URL(REST + path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.code && json.code !== '00000') {
    throw new Error(`${json.code} ${json.msg || ''}`);
  }
  return json;
}

// ============================================================
// LOAD SYMBOLS
// ============================================================

async function loadSymbols() {
  const json = await rest('/api/v2/mix/market/contracts', { productType: PRODUCT });
  const contracts = Array.isArray(json.data) ? json.data : [];
  const valid = contracts
    .filter(x => {
      const symbol = normalizeSymbol(x.symbol);
      return symbol && x.symbolType !== 'delivery' && String(x.quoteCoin).toUpperCase() === 'USDT';
    })
    .map(x => normalizeSymbol(x.symbol));
  console.log(`Bitget marketleri: ${valid.length}`);
  for (const symbol of valid) getSymbol(symbol);
  state.stats.symbols = valid.length;
}

// ============================================================
// HISTORICAL 1H CANDLES
// ============================================================

async function load1HCandles(symbol) {
  try {
    const json = await rest('/api/v3/market/candles', {
      category: 'USDT-FUTURES',
      symbol,
      interval: '1H',
      limit: 120
    });
    const rows = Array.isArray(json.data) ? json.data : [];
    const candles = rows
      .map(r => ({
        ts: num(r[0]),
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5]),
        turnover: num(r[6])
      }))
      .filter(c => c.close > 0)
      .sort((a, b) => a.ts - b.ts);
    getSymbol(symbol).h1Candles = candles;
    build2HCandles(symbol);
  } catch (err) {
    console.error(`[${symbol}] 1H candle error: ${err.message}`);
  }
}

// ============================================================
// 1H -> 2H AGGREGATION
// ============================================================

function build2HCandles(symbol) {
  const s = getSymbol(symbol);
  const h1 = s.h1Candles;
  if (h1.length < 10) return;

  const buckets = new Map();
  for (const c of h1) {
    const bucket = Math.floor(c.ts / (2 * 60 * 60 * 1000));
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(c);
  }

  const result = [];
  for (const [bucket, rows] of buckets) {
    rows.sort((a, b) => a.ts - b.ts);
    if (!rows.length) continue;
    result.push({
      ts: bucket * 2 * 60 * 60 * 1000,
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

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function isPivotHigh(candles, i) {
  const c = candles[i];
  for (let x = 1; x <= CFG.PIVOT_LEFT; x++) {
    if (!candles[i - x] || candles[i - x].high >= c.high) return false;
  }
  for (let x = 1; x <= CFG.PIVOT_RIGHT; x++) {
    if (!candles[i + x] || candles[i + x].high > c.high) return false;
  }
  return true;
}

function isPivotLow(candles, i) {
  const c = candles[i];
  for (let x = 1; x <= CFG.PIVOT_LEFT; x++) {
    if (!candles[i - x] || candles[i - x].low <= c.low) return false;
  }
  for (let x = 1; x <= CFG.PIVOT_RIGHT; x++) {
    if (!candles[i + x] || candles[i + x].low < c.low) return false;
  }
  return true;
}

function detectLevels(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;
  if (candles.length < 12) return;
  const price = s.price;
  if (!price) return;

  const resistance = [];
  const support = [];
  for (let i = CFG.PIVOT_LEFT; i < candles.length - CFG.PIVOT_RIGHT; i++) {
    if (isPivotHigh(candles, i)) resistance.push(candles[i].high);
    if (isPivotLow(candles, i)) support.push(candles[i].low);
  }

  const nearestResistance = resistance.filter(x => x > price).sort((a, b) => a - b)[0] || null;
  const nearestSupport = support.filter(x => x < price).sort((a, b) => b - a)[0] || null;

  s.level = {
    resistance: nearestResistance,
    support: nearestSupport,
    updatedAt: now()
  };
}

// ============================================================
// VOLUME
// ============================================================

function calculateVolumeRatio(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;
  if (candles.length < CFG.VOLUME_LOOKBACK + 1) return 1;
  const last = candles[candles.length - 1];
  const previous = candles.slice(-CFG.VOLUME_LOOKBACK - 1, -1);
  const avg = previous.reduce((sum, c) => sum + c.turnover, 0) / previous.length;
  if (!avg) return 1;
  return last.turnover / avg;
}

// ============================================================
// LIVE PRICE MOMENTUM
// ============================================================

function priceMomentum(symbol) {
  const s = getSymbol(symbol);
  const h = s.priceHistory;
  if (h.length < 10) return 0;
  const current = h[h.length - 1];
  const old = h.find(x => current.ts - x.ts >= 60 * 1000) || h[0];
  if (!old.price) return 0;
  return pct(current.price, old.price);
}

// ============================================================
// OI
// ============================================================

function oiChange(symbol) {
  const s = getSymbol(symbol);
  if (!s.prevOi || !s.oi) return 0;
  return pct(s.oi, s.prevOi);
}

// ============================================================
// ORDERBOOK FLOW
// ============================================================

function orderbookFlow(symbol) {
  const s = getSymbol(symbol);
  if (!s.bidSize && !s.askSize) return 0.5;
  const total = s.bidSize + s.askSize;
  if (!total) return 0.5;
  return s.bidSize / total;
}

// ============================================================
// FLOW SCORE
// ============================================================

function flowScore(symbol) {
  const s = getSymbol(symbol);
  const direct = orderbookFlow(symbol);
  if (!s.flowHistory.length) return direct;
  const recent = s.flowHistory.slice(-20);
  const avg = recent.reduce((a, x) => a + x.flow, 0) / recent.length;
  return clamp(avg * 0.65 + direct * 0.35, 0, 1);
}

// ============================================================
// LEVEL DISTANCE
// ============================================================

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
  let analysis = "";
  let confidenceLevel = 50;

  if (distance <= CFG.ENTRY_DISTANCE_PCT) {
    analysis += `🎯 **Seviyeye Çok Yakın:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. Kırılım çok yakın olabilir. `;
    confidenceLevel += 20;
  } else if (distance <= CFG.IGNITION_DISTANCE_PCT) {
    analysis += `⚡ **Hareket Başlıyor:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. İzlemeye değer. `;
    confidenceLevel += 10;
  } else {
    analysis += `👀 **İzleme Modu:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. Henüz erken. `;
  }

  const volText = volumeRatio.toFixed(2);
  if (volumeRatio >= CFG.ENTRY_VOLUME_RATIO) {
    analysis += `🐋 **'Balina Teyitli':** Hacim ortalamanın ${volText}x katı. Büyük oyuncular içeride. `;
    confidenceLevel += 25;
  } else if (volumeRatio >= CFG.IGNITION_VOLUME_RATIO) {
    analysis += `👍 **Hacim Teyitli:** Hacim ${volText}x. Hareket destekleniyor. `;
    confidenceLevel += 15;
  } else if (volumeRatio >= CFG.WATCH_VOLUME_RATIO) {
    analysis += `ℹ️ **Hacim Normal:** Hacim ${volText}x. Belirgin bir baskı yok. `;
    confidenceLevel += 5;
  } else {
    analysis += `👎 **Zayıf Hacim:** Hacim ${volText}x. Fakeout riski var. `;
    confidenceLevel -= 10;
  }

  const oiText = oi.toFixed(2);
  if (oi >= CFG.OI_ENTRY_PCT) {
    analysis += `📈 **OI Patlaması:** Açık pozisyon %${oiText} arttı. Yeni para giriyor. `;
    confidenceLevel += 20;
  } else if (oi >= CFG.OI_IGNITION_PCT) {
    analysis += `📊 **OI Artıyor:** Açık pozisyon %${oiText}. İlgi artıyor. `;
    confidenceLevel += 10;
  }

  if (signal === 'LONG') {
    if (flow >= CFG.FLOW_ENTRY) {
      analysis += `🟢 **Alım Baskısı:** Orderbook %${(flow * 100).toFixed(0)} alıcıda. Güçlü alım. `;
      confidenceLevel += 15;
    } else if (flow >= CFG.FLOW_WATCH) {
      analysis += `🟡 **Alım Eğilimi:** Orderbook %${(flow * 100).toFixed(0)} alıcıda. `;
    } else {
      analysis += `🔴 **Satım Baskısı:** Orderbook %${(flow * 100).toFixed(0)} alıcıda. Dikkat. `;
      confidenceLevel -= 10;
    }
  } else {
    const sellFlow = 1 - flow;
    if (sellFlow >= CFG.FLOW_ENTRY) {
      analysis += `🔴 **Satım Baskısı:** Orderbook %${(sellFlow * 100).toFixed(0)} satıcıda. Güçlü satım. `;
      confidenceLevel += 15;
    } else if (sellFlow >= CFG.FLOW_WATCH) {
      analysis += `🟠 **Satım Eğilimi:** Orderbook %${(sellFlow * 100).toFixed(0)} satıcıda. `;
    } else {
      analysis += `🟢 **Alım Baskısı:** Orderbook %${((1 - sellFlow) * 100).toFixed(0)} alıcıda. Dikkat. `;
      confidenceLevel -= 10;
    }
  }

  const momText = momentum.toFixed(2);
  if (Math.abs(momentum) >= CFG.MOMENTUM_ENTRY) {
    if ((signal === 'LONG' && momentum > 0) || (signal === 'SHORT' && momentum < 0)) {
      analysis += `🚀 **Momentum Güçlü:** Son 1 dk'da fiyat %${momText} hareket etti. Yön doğru. `;
      confidenceLevel += 15;
    } else {
      analysis += `⚠️ **Ters Momentum:** Fiyat %${momText} ters yönde. Dikkat. `;
      confidenceLevel -= 15;
    }
  }

  const finalConfidence = Math.min(Math.max(confidenceLevel, 0), 99);
  return { text: analysis, confidence: finalConfidence.toFixed(0) };
}

// ============================================================
// SCORE
// ============================================================

function calculateScore(symbol, direction) {
  const distance = levelDistance(symbol, direction);
  const volumeRatio = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const momentum = priceMomentum(symbol);

  let score = 0;

  if (distance <= CFG.ENTRY_DISTANCE_PCT) score += 20;
  else if (distance <= CFG.IGNITION_DISTANCE_PCT) score += 16;
  else if (distance <= CFG.WATCH_DISTANCE_PCT) score += 10;

  if (volumeRatio >= CFG.ENTRY_VOLUME_RATIO) score += 20;
  else if (volumeRatio >= CFG.IGNITION_VOLUME_RATIO) score += 16;
  else if (volumeRatio >= CFG.WATCH_VOLUME_RATIO) score += 10;

  if (oi >= CFG.OI_ENTRY_PCT) score += 20;
  else if (oi >= CFG.OI_IGNITION_PCT) score += 16;
  else if (oi >= CFG.OI_WATCH_PCT) score += 10;

  if (direction === 'LONG') {
    if (flow >= CFG.FLOW_ENTRY) score += 20;
    else if (flow >= CFG.FLOW_IGNITION) score += 16;
    else if (flow >= CFG.FLOW_WATCH) score += 10;
  } else {
    const sellFlow = 1 - flow;
    if (sellFlow >= CFG.FLOW_ENTRY) score += 20;
    else if (sellFlow >= CFG.FLOW_IGNITION) score += 16;
    else if (sellFlow >= CFG.FLOW_WATCH) score += 10;
  }

  const absMomentum = Math.abs(momentum);
  if ((direction === 'LONG' && momentum > 0) || (direction === 'SHORT' && momentum < 0)) {
    if (absMomentum >= CFG.MOMENTUM_ENTRY) score += 10;
    else if (absMomentum >= CFG.MOMENTUM_IGNITION) score += 8;
    else if (absMomentum >= CFG.MOMENTUM_WATCH) score += 5;
  }

  if (direction === 'LONG' && momentum > 0) score += 10;
  if (direction === 'SHORT' && momentum < 0) score += 10;

  return Math.min(100, Math.round(score));
}

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================

function classifySignal(symbol, direction, score) {
  const s = getSymbol(symbol);
  const distance = levelDistance(symbol, direction);

  if (distance < 0.001) return null;
  if (distance > CFG.WATCH_DISTANCE_PCT) return null;

  let stateName = null;
  if (score >= CFG.ENTRY_SCORE) stateName = 'GİRİŞ FIRSATI';
  else if (score >= CFG.IGNITION_SCORE) stateName = 'HAREKET BAŞLADI';
  else if (score >= CFG.WATCH_SCORE) stateName = 'İZLE';

  if (!stateName) return null;

  const volumeRatio = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const momentum = priceMomentum(symbol);

  const level = direction === 'LONG' ? s.level?.resistance : s.level?.support;

  const tactical = generateTacticalAnalysis({
    signal: direction,
    distance,
    volumeRatio,
    oi,
    flow,
    momentum
  });

  return {
    id: `${symbol}-${direction}-${Date.now()}`,
    symbol,
    direction,
    state: stateName,
    signal: direction,

    score,
    confidence: tactical.confidence,
    tacticalAnalysis: tactical.text,
    reason: `${direction} sinyali: ${stateName} (Skor: ${score})`,

    price: s.price,
    level,

    entryPrice: s.price.toFixed(6),
    TP: '---',
    SL: '---',
    RR: 'N/A',

    distancePct: distance,
    volumeRatio,
    oiChangePct: oi,
    flow,
    momentum,

    strategyType: 'BRK2H',
    isFiltered: false,

    createdAt: now(),
    timestamp: now(),
    time: new Date().toLocaleTimeString(),

    expiresAt: now() + CFG.SIGNAL_TTL_MS
  };
}

// ============================================================
// EVALUATE SYMBOL
// ============================================================

function evaluateSymbol(symbol) {
  const s = getSymbol(symbol);
  if (!s.price) return;
  if (s.turnover24h < CFG.MIN_24H_TURNOVER) return;
  if (!s.level) detectLevels(symbol);
  if (!s.level) return;

  const candidates = [];

  if (s.level.resistance && s.price < s.level.resistance) {
    const score = calculateScore(symbol, 'LONG');
    const signal = classifySignal(symbol, 'LONG', score);
    if (signal) candidates.push(signal);
  }

  if (s.level.support && s.price > s.level.support) {
    const score = calculateScore(symbol, 'SHORT');
    const signal = classifySignal(symbol, 'SHORT', score);
    if (signal) candidates.push(signal);
  }

  if (!candidates.length) {
    s.signal = null;
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const previous = s.signal;

  const cooldownKey = `${symbol}-${best.direction}`;
  const cooldown = state.cooldowns[cooldownKey];

  if (cooldown && cooldown.timestamp > now() - CFG.SIGNAL_COOLDOWN_MS) {
    s.signal = best;
    return;
  }

  if (
    !previous ||
    previous.state !== best.state ||
    previous.direction !== best.direction ||
    Math.abs(previous.score - best.score) >= 5
  ) {
    s.signal = best;
    state.cooldowns[cooldownKey] = { timestamp: now() };
    state.stats.signals++;

    state.kirilimSignals.unshift(best);
    if (state.kirilimSignals.length > 100) state.kirilimSignals.pop();

    console.log(
      `[${best.state}] ${best.direction} ${best.symbol} ` +
      `score=${best.score} conf=${best.confidence}% ` +
      `distance=${best.distancePct.toFixed(2)}% ` +
      `VOL=${best.volumeRatio.toFixed(2)}x ` +
      `OI=${best.oiChangePct.toFixed(2)}% ` +
      `FLOW=${best.flow.toFixed(2)}`
    );
  } else {
    s.signal = {
      ...previous,
      price: best.price,
      level: best.level,
      distancePct: best.distancePct,
      volumeRatio: best.volumeRatio,
      oiChangePct: best.oiChangePct,
      flow: best.flow,
      momentum: best.momentum,
      score: best.score,
      confidence: best.confidence,
      tacticalAnalysis: best.tacticalAnalysis
    };
  }
}

// ============================================================
// SCAN
// ============================================================

function scan() {
  state.stats.scans++;
  state.stats.lastScan = now();
  for (const symbol of state.symbols.keys()) {
    evaluateSymbol(symbol);
  }
  cleanupSignals();
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupSignals() {
  const t = now();
  for (const s of state.symbols.values()) {
    if (s.signal && s.signal.expiresAt < t) s.signal = null;
  }
  state.kirilimSignals = state.kirilimSignals.filter(s => s.expiresAt > t);
  state.momentumSignals = state.momentumSignals.filter(s => s.expiresAt > t);
}

// ============================================================
// WEBSOCKET
// ============================================================

function connectWS() {
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
  }

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
      const channel = msg.arg.channel;
      if (channel === 'ticker') processTicker(msg);
      if (channel === 'candle1m' || channel === 'candle1H') processCandle(msg);
    } catch (err) {
      // JSON olmayan mesajları sessizce yok say
    }
  });

  ws.on('close', () => {
    console.log('Bitget WebSocket kapandı.');
    state.wsConnected = false;
    const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(connectWS, delay);
  });

  ws.on('error', err => {
    console.error('WS error:', err.message);
  });
}

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function subscribeTickerAndCandles() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const symbols = Array.from(state.symbols.keys());
  const selected = symbols.slice(0, CFG.MAX_SYMBOLS);
  const args = [];

  for (const symbol of selected) {
    args.push({ instType: 'USDT-FUTURES', channel: 'ticker', instId: symbol });
  }
  for (const symbol of selected) {
    args.push({ instType: 'USDT-FUTURES', channel: 'candle1H', instId: symbol });
  }
  for (const symbol of selected) {
    args.push({ instType: 'USDT-FUTURES', channel: 'candle1m', instId: symbol });
  }

  const batches = [];
  for (let i = 0; i < args.length; i += CFG.WS_BATCH_SIZE) {
    batches.push(args.slice(i, i + CFG.WS_BATCH_SIZE));
  }

  state.wsSubscriptions = batches;
  for (const batch of batches) {
    state.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
  }

  console.log(`WS abonelikleri: ${args.length} kanal / ${batches.length} paket`);
}

// ============================================================
// TICKER
// ============================================================

function processTicker(msg) {
  const rows = Array.isArray(msg.data) ? msg.data : [];
  state.stats.tickerMessages += rows.length;

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
    if (newOI > 0) {
      if (s.oi > 0) s.prevOi = s.oi;
      s.oi = newOI;
      s.oiUpdatedAt = now();
    }

    s.priceHistory.push({ ts: now(), price });
    const cutoff = now() - 10 * 60 * 1000;
    s.priceHistory = s.priceHistory.filter(x => x.ts >= cutoff);

    const flow = orderbookFlow(symbol);
    s.flowHistory.push({ ts: now(), flow });
    s.flowHistory = s.flowHistory.filter(x => x.ts >= cutoff);

    detectLevels(symbol);
  }
}

// ============================================================
// CANDLE
// ============================================================

function processCandle(msg) {
  const symbol = normalizeSymbol(msg.arg?.instId);
  if (!symbol) return;

  const s = getSymbol(symbol);
  const rows = Array.isArray(msg.data) ? msg.data : [];
  state.stats.candleMessages += rows.length;

  for (const r of rows) {
    const candle = {
      ts: num(r[0]),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      volume: num(r[5]),
      turnover: num(r[6])
    };

    if (!candle.close) continue;

    if (msg.arg.channel === 'candle1H') {
      upsertCandle(s.h1Candles, candle, 120);
      build2HCandles(symbol);
    }

    if (msg.arg.channel === 'candle1m') {
      upsertCandle(s.minuteCandles, candle, 120);
    }
  }
}

// ============================================================
// UPSERT CANDLE
// ============================================================

function upsertCandle(arr, candle, max) {
  const existing = arr.findIndex(x => x.ts === candle.ts);
  if (existing >= 0) arr[existing] = candle;
  else arr.push(candle);
  arr.sort((a, b) => a.ts - b.ts);
  while (arr.length > max) arr.shift();
}

// ============================================================
// KEEPALIVE
// ============================================================

setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.send('ping'); } catch (e) {}
  }
}, CFG.WS_PING_MS);

// ============================================================
// API STATUS
// ============================================================

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    system: 'SONNY AI TRADER V6',
    mode: '2H PRE-BREAKOUT RADAR + V14.9 DASHBOARD',
    wsConnected: state.wsConnected,
    symbols: state.symbols.size,
    signals: state.stats.signals,
    scans: state.stats.scans,
    lastScan: state.stats.lastScan,
    uptime: now() - state.startedAt
  });
});

// ============================================================
// API SIGNALS
// ============================================================

app.get('/api/signals', (req, res) => {
  res.json({
    ok: true,
    serverTime: now(),
    kirilimSignals: state.kirilimSignals.slice(0, 50),
    momentumSignals: state.momentumSignals.slice(0, 50),
    watchlist: state.watchlist,
    scanStatus: {
      message: state.stats.lastScan
        ? `Tarama Tamamlandı. ${state.kirilimSignals.length} sinyal aktif.`
        : 'Tarama bekleniyor...',
      isScanning: false
    }
  });
});

// ============================================================
// API WATCHLIST
// ============================================================

app.post('/api/remove-watchlist', express.json(), (req, res) => {
  const symbol = req.body.symbol;
  if (typeof symbol !== 'string' || !symbol) {
    return res.status(400).json({ error: 'Geçersiz sembol formatı.' });
  }
  if (state.watchlist[symbol]) {
    delete state.watchlist[symbol];
    console.log(`${symbol} izleme listesinden kaldırıldı.`);
    res.json({ success: true, message: `${symbol} izleme listesinden kaldırıldı.` });
  } else {
    res.status(404).json({ error: 'Sembol izleme listesinde bulunamadı.' });
  }
});

app.post('/api/analyze-coin', express.json(), async (req, res) => {
  const userSymbolInput = req.body.symbol;
  if (!userSymbolInput || typeof userSymbolInput !== 'string') {
    return res.status(400).json({ error: 'Geçersiz sembol formatı.' });
  }

  const cleanBaseSymbol = userSymbolInput
    .toUpperCase()
    .replace('/USDT', '')
    .replace(':USDT', '')
    .replace('USDT', '')
    .replace('PERP', '')
    .trim();

  const fullSymbol = cleanBaseSymbol + 'USDT';

  try {
    const s = state.symbols.get(fullSymbol) || getSymbol(fullSymbol);

    if (!s.price) {
      return res.status(404).json({ error: `'${cleanBaseSymbol}' için canlı veri yok.` });
    }

    const candidates = [];

    if (s.level?.resistance && s.price < s.level.resistance) {
      const score = calculateScore(fullSymbol, 'LONG');
      const signal = classifySignal(fullSymbol, 'LONG', score);
      if (signal) candidates.push(signal);
    }

    if (s.level?.support && s.price > s.level.support) {
      const score = calculateScore(fullSymbol, 'SHORT');
      const signal = classifySignal(fullSymbol, 'SHORT', score);
      if (signal) candidates.push(signal);
    }

    candidates.sort((a, b) => b.score - a.score);

    let finalResult;

    if (candidates.length > 0) {
      finalResult = {
        ...candidates[0],
        statusClass: candidates[0].direction === 'LONG' ? 'bg-long' : 'bg-short'
      };
    } else {
      const distance = s.level?.resistance
        ? absPct(s.price, s.level.resistance)
        : absPct(s.price, s.level?.support || s.price);

      finalResult = {
        ccxtSymbol: fullSymbol,
        symbol: fullSymbol,
        signal: 'WAIT',
        direction: 'WAIT',
        state: 'İZLE',
        score: 0,
        confidence: '0',
        tacticalAnalysis: s.level
          ? `Fiyat seviyeye %${distance.toFixed(2)} mesafede. Aktif sinyal yok.`
          : 'Seviye verisi yetersiz.',
        reason: 'Aktif sinyal yok.',
        statusClass: 'bg-wait',
        timestamp: now(),
        time: new Date().toLocaleTimeString()
      };
    }

    state.watchlist[fullSymbol] = finalResult;
    res.json(finalResult);

  } catch (err) {
    console.error('Manuel analiz hatası:', err.message);
    res.status(500).json({ error: `Sunucu hatası: ${err.message}` });
  }
});

// ============================================================
// MAIN PAGE (V14.9 dashboard)
// ============================================================

app.get('/', (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Sonny AI Trader V6 (V14.9 Dashboard)</title>',
    '<style>',
    ':root {',
    '  --bg-color: #0d1117; --card-bg: #161b22; --border-color: #30363d;',
    '  --text-color: #c9d1d9; --text-color-secondary: #8b949e;',
    '  --green: #28a745; --red: #dc3545; --grey: #484f58;',
    '  --green-bg: #1a3a24; --red-bg: #411c22; --grey-bg: #21262d; --blue: #1f6feb;',
    '  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '}',
    'html { height: 100%; box-sizing: border-box; }',
    '*, *:before, *:after { box-sizing: inherit; }',
    'body { font-family: var(--font-family); background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 15px; display: flex; flex-direction: column; height: 100vh; max-height: 100vh; overflow: hidden; }',
    'header { display: flex; flex-direction: column; gap: 15px; margin-bottom: 10px; background-color: var(--card-bg); padding: 15px; border-radius: 8px; border: 1px solid var(--border-color); flex-shrink: 0; }',
    '@media (min-width: 768px) { header { flex-direction: row; justify-content: space-between; align-items: center; } }',
    '#scanStatus { font-size: 1.1em; font-weight: 500; padding: 10px; border-radius: 6px; background-color: var(--bg-color); border: 1px solid var(--border-color); text-align: center; flex-grow: 1; min-width: 200px; }',
    '#analyzeForm { display: flex; gap: 10px; flex-grow: 1; }',
    '#symbolInput { flex-grow: 1; padding: 10px 12px; font-size: 1em; border: 1px solid var(--border-color); background-color: var(--bg-color); color: var(--text-color); border-radius: 6px; min-width: 150px; }',
    '#analyzeButton { padding: 10px 18px; font-size: 1em; font-weight: 600; background-color: var(--blue); color: white; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; }',
    '#analyzeButton:hover { background-color: #388bfd; }',
    '#analyzeButton:disabled { background-color: var(--grey); cursor: not-allowed; }',
    '.main-container { flex-grow: 1; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }',
    '#momentum-container { border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--card-bg); padding: 15px; display: flex; flex-direction: column; flex-shrink: 0; height: 200px; overflow-y: auto; }',
    '#momentum-container h2 { margin: -15px -15px 10px -15px; padding: 10px 15px; border-bottom: 1px solid var(--border-color); color: var(--text-color); position: sticky; top: 0; background-color: var(--card-bg); z-index: 10; font-size: 1.2em; }',
    '#momentum-container .signal-card { margin-bottom: 8px; }',
    '.breakout-section { flex-grow: 1; display: flex; flex-direction: column; gap: 10px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--card-bg); padding: 15px; }',
    '.filter-container { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; padding-bottom: 10px; border-bottom: 1px solid var(--border-color); }',
    '.filter-button { padding: 6px 12px; font-size: 0.9em; font-weight: 600; border: 1px solid var(--border-color); background-color: var(--bg-color); color: var(--text-color-secondary); border-radius: 6px; cursor: pointer; }',
    '.filter-button:hover { background-color: var(--grey); color: var(--text-color); }',
    '.filter-button.active { background-color: var(--blue); color: white; border-color: var(--blue); }',
    '#signal-container { flex-grow: 1; overflow-y: auto; padding-top: 5px; background-color: var(--card-bg); min-height: 0; }',
    '#signal-container h2 { display: none; }',
    '#watchlist-container { border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--card-bg); padding: 15px; display: flex; flex-direction: column; overflow-y: auto; height: 250px; flex-shrink: 0; margin-top: 10px; }',
    '#watchlist-container h2 { margin: -15px -15px 10px -15px; padding: 10px 15px; border-bottom: 1px solid var(--border-color); color: var(--text-color); position: sticky; top: 0; background-color: var(--card-bg); z-index: 10; font-size: 1.2em; }',
    '.signal-card { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background-color: var(--bg-color); box-shadow: 0 2px 8px rgba(0,0,0,0.3); margin-bottom: 12px; flex-shrink: 0; display: block; }',
    '.signal-flash { animation: flash 1.5s ease; }',
    '@keyframes flash { 0% { box-shadow: 0 0 12px #388bfd; border-color: #388bfd; } 100% { box-shadow: 0 2px 8px rgba(0,0,0,0.3); border-color: var(--border-color); } }',
    '.card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--border-color); }',
    '.signal-symbol-link { text-decoration: none; color: #fff; }',
    '.signal-symbol-link:hover { color: var(--blue); }',
    '.signal-symbol { font-size: 1.4em; font-weight: 700; }',
    '.signal-type { font-size: 1.2em; font-weight: 700; padding: 4px 10px; border-radius: 15px; color: white; }',
    '.signal-strategy { font-family: "Courier New", Courier, monospace; font-size: 0.9em; font-weight: 600; background-color: var(--grey); color: #fff; padding: 4px 8px; border-radius: 4px; margin-left: auto; }',
    '.signal-confidence { font-size: 1em; font-weight: 600; color: var(--text-color); background-color: var(--card-bg); border: 1px solid var(--border-color); padding: 4px 10px; border-radius: 6px; }',
    '.signal-tactic { padding: 12px 15px; background-color: var(--card-bg); border-bottom: 1px solid var(--border-color); }',
    '.tactic-toggle-btn { background: none; border: 1px solid var(--grey); color: var(--text-color-secondary); padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85em; font-weight: 600; margin-bottom: 8px; display: inline-block; }',
    '.tactic-toggle-btn:hover { background-color: var(--grey); color: var(--text-color); }',
    '.tactic-details { font-size: 1.0em; line-height: 1.5; color: var(--text-color-secondary); border-left: 3px solid var(--border-color); margin-top: 8px; display: none; background-color: var(--bg-color); padding: 10px; border-radius: 4px; }',
    '.tactic-details.visible { display: block; }',
    '.tactic-details strong, .tactic-details b { color: var(--text-color); font-weight: 600; }',
    '.signal-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; padding: 15px; font-size: 0.95em; }',
    '.signal-details span { background-color: var(--card-bg); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-color); }',
    '.card-footer { padding: 10px 15px; font-size: 0.9em; color: var(--text-color-secondary); background-color: var(--bg-color); display: flex; justify-content: space-between; align-items: center; }',
    '.bg-long { background-color: var(--green-bg); border-color: var(--green); } .bg-long .signal-type { background-color: var(--green); }',
    '.bg-short { background-color: var(--red-bg); border-color: var(--red); } .bg-short .signal-type { background-color: var(--red); }',
    '.bg-wait { background-color: var(--grey-bg); border-color: var(--grey); } .bg-wait .signal-type { background-color: var(--grey); color: var(--text-color); }',
    '.status-reddet { background-color: #33231f; border-color: #793722; } .status-reddet .signal-type { background-color: #793722; }',
    '.remove-btn { background: none; border: 1px solid var(--red); color: var(--red); font-weight: 700; border-radius: 50%; width: 28px; height: 28px; cursor: pointer; font-size: 1.1em; padding: 0; line-height: 26px; }',
    '.remove-btn:hover { background-color: var(--red); color: white; transform: scale(1.1); }',
    '::-webkit-scrollbar { width: 8px; height: 8px; }',
    '::-webkit-scrollbar-track { background: var(--card-bg); border-radius: 4px; }',
    '::-webkit-scrollbar-thumb { background: var(--grey); border-radius: 4px; }',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<div id="scanStatus">Sonny AI V6 Sunucuya bağlanıyor...</div>',
    '<form id="analyzeForm">',
    '<input type="text" id="symbolInput" placeholder="Örn: BTC (USDT PERP)" required>',
    '<button type="submit" id="analyzeButton">İzlemeye Al / Analiz Et</button>',
    '</form>',
    '</header>',
    '<div class="main-container">',
    '<div id="momentum-container"><h2>⚡ Momentum (1H Hacim)</h2></div>',
    '<div class="breakout-section">',
    '<div class="filter-container">',
    '<button class="filter-button active" data-filter="all">Tümü</button>',
    '<button class="filter-button" data-filter="BRK1H">BRK 1H</button>',
    '<button class="filter-button" data-filter="BRK2H">BRK 2H</button>',
    '<button class="filter-button" data-filter="BRK4H">BRK 4H</button>',
    '<button class="filter-button" data-filter="conf>85">Güven > 85%</button>',
    '<button class="filter-button" data-filter="conf>95">Güven > 95%</button>',
    '<button class="filter-button" data-filter="long">Sadece LONG</button>',
    '<button class="filter-button" data-filter="short">Sadece SHORT</button>',
    '</div>',
    '<div id="signal-container"></div>',
    '</div>',
    '<div id="watchlist-container"><h2>⭐ İzleme Listem (Akıllı Analiz)</h2></div>',
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
    'var momentumContainer = document.getElementById("momentum-container");',
    'var signalContainer = document.getElementById("signal-container");',
    'var watchlistContainer = document.getElementById("watchlist-container");',
    'var filterButtons = document.querySelectorAll(".filter-button");',
    'var scanStatusEl = document.getElementById("scanStatus");',
    'var analyzeForm = document.getElementById("analyzeForm");',
    'var symbolInput = document.getElementById("symbolInput");',
    'var analyzeButton = document.getElementById("analyzeButton");',
    '',
    'var currentFilter = "all";',
    '',
    'function createSignalCardHTML(signal, isWatchlist) {',
    '  if (!signal || !signal.symbol) return "";',
    '  var statusClass = "bg-wait";',
    '  var signalText = signal.signal || "WAIT";',
    '  if (signal.strategyType === "MOMENTUM1H") {',
    '    if (signal.signal === "PUMP") { signalText = "Momentum ↑"; statusClass = "bg-long"; }',
    '    else if (signal.signal === "DUMP") { signalText = "Momentum ↓"; statusClass = "bg-short"; }',
    '  } else {',
    '    if (signal.signal === "LONG") statusClass = "bg-long";',
    '    if (signal.signal === "SHORT") statusClass = "bg-short";',
    '  }',
    '  if (signal.isFiltered) statusClass = "status-reddet";',
    '  if (signalText === "WAIT" || signalText === "HATA/YOK") statusClass = "bg-wait";',
    '  var removeButtonHTML = isWatchlist ? \'<button class="remove-btn" onclick="removeWatchlist(\\\'\' + signal.symbol + \'\\\')">X</button>\' : "";',
    '  var confidence = parseInt(signal.confidence) || 0;',
    '  var confidenceHTML = signal.confidence ? \'<span class="signal-confidence">Güven: \' + confidence + \'%</span>\' : "";',
    '  var rawTacticalHTML = signal.tacticalAnalysis || "Taktiksel analiz yüklenemedi.";',
    '  var detailsHTML = (signal.strategyType !== "MOMENTUM1H" && signal.RR && signal.RR !== "N/A")',
    '    ? \'<div class="signal-details"><span>Giriş: \' + signal.entryPrice + \'</span><span>TP: \' + signal.TP + \'</span><span>SL: \' + signal.SL + \'</span><span>R/R: \' + signal.RR + \'</span></div>\'',
    '    : "";',
    '  var tradingViewLink = "https://www.tradingview.com/chart/?symbol=BITGET:" + signal.symbol + "PERP";',
    '  var cardId = isWatchlist ? "watchlist-" + signal.symbol : "signal-" + signal.symbol + "-" + signal.strategyType;',
    '  var tacticDetailsId = "tactic-" + cardId + "-" + (signal.timestamp || Date.now());',
    '',
    '  return \'<div class="signal-card \' + statusClass + \'" id="\' + cardId + \'" data-symbol="\' + signal.symbol + \'" data-strategytype="\' + (signal.strategyType || "N/A") + \'" data-confidence="\' + confidence + \'" data-signaltype="\' + (signal.signal || "WAIT") + \'">\' +',
    '    \'<div class="card-header"><a href="\' + tradingViewLink + \'" target="_blank" class="signal-symbol-link"><span class="signal-symbol">\' + signal.symbol + \'</span></a><span class="signal-type \' + statusClass + \'">\' + signalText + \'</span> \' + confidenceHTML + \' <span class="signal-strategy">\' + (signal.strategyType || "N/A") + \'</span></div>\' +',
    '    \'<div class="signal-tactic"><button class="tactic-toggle-btn" onclick="toggleTactic(\\\'\' + tacticDetailsId + \'\\\', this)">Analizi Göster +</button><div class="tactic-details" id="\' + tacticDetailsId + \'">\' + rawTacticalHTML + \'</div></div>\' +',
    '    detailsHTML +',
    '    \'<div class="card-footer"><span>\' + (signal.time || new Date().toLocaleTimeString()) + \'</span> \' + removeButtonHTML + \'</div>\' +',
    '    \'</div>\';',
    '}',
    '',
    'function toggleTactic(detailsId, buttonElement) {',
    '  var detailsDiv = document.getElementById(detailsId);',
    '  if (detailsDiv) {',
    '    detailsDiv.classList.toggle("visible");',
    '    buttonElement.textContent = detailsDiv.classList.contains("visible") ? "Analizi Gizle -" : "Analizi Göster +";',
    '  }',
    '}',
    '',
    'function filterSignals(filterType) {',
    '  currentFilter = filterType;',
    '  filterButtons.forEach(function(b) { b.classList.remove("active"); });',
    '  filterButtons.forEach(function(b) { if (b.dataset.filter === filterType) b.classList.add("active"); });',
    '  signalContainer.querySelectorAll(".signal-card").forEach(applyFilterToSingleCard);',
    '}',
    '',
    'function applyFilterToSingleCard(card) {',
    '  if (!card || !card.dataset || card.dataset.strategytype === "MOMENTUM1H") return;',
    '  var strategy = card.dataset.strategytype;',
    '  var confidence = parseInt(card.dataset.confidence);',
    '  var signalType = card.dataset.signaltype;',
    '  var show = false;',
    '  switch (currentFilter) {',
    '    case "all": show = true; break;',
    '    case "BRK1H": case "BRK2H": case "BRK4H": show = (strategy === currentFilter); break;',
    '    case "conf>85": show = (confidence > 85); break;',
    '    case "conf>95": show = (confidence > 95); break;',
    '    case "long": show = (signalType === "LONG"); break;',
    '    case "short": show = (signalType === "SHORT"); break;',
    '    default: show = true;',
    '  }',
    '  card.style.display = show ? "block" : "none";',
    '}',
    '',
    'async function refreshData() {',
    '  try {',
    '    var res = await fetch("/api/signals");',
    '    var data = await res.json();',
    '    scanStatusEl.textContent = data.scanStatus ? data.scanStatus.message : "Tarama...";',
    '',
    '    signalContainer.innerHTML = "";',
    '    (data.kirilimSignals || []).forEach(function(s) {',
    '      signalContainer.insertAdjacentHTML("beforeend", createSignalCardHTML(s, false));',
    '    });',
    '    filterSignals(currentFilter);',
    '',
    '    var momentumTitle = \'<h2>⚡ Momentum (1H Hacim)</h2>\';',
    '    momentumContainer.innerHTML = momentumTitle;',
    '    (data.momentumSignals || []).forEach(function(s) {',
    '      momentumContainer.insertAdjacentHTML("beforeend", createSignalCardHTML(s, false));',
    '    });',
    '',
    '    var wlTitle = \'<h2>⭐ İzleme Listem (Akıllı Analiz)</h2>\';',
    '    watchlistContainer.innerHTML = wlTitle;',
    '    var wl = data.watchlist || {};',
    '    Object.values(wl).sort(function(a, b) { return (a.symbol > b.symbol) ? 1 : -1; }).forEach(function(item) {',
    '      watchlistContainer.insertAdjacentHTML("beforeend", createSignalCardHTML(item, true));',
    '    });',
    '  } catch (e) {',
    '    scanStatusEl.textContent = "Sunucu bağlantı hatası: " + e.message;',
    '  }',
    '}',
    '',
    'window.removeWatchlist = async function(symbol) {',
    '  try {',
    '    var res = await fetch("/api/remove-watchlist", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ symbol: symbol })',
    '    });',
    '    refreshData();',
    '  } catch (e) { alert("Hata: " + e.message); }',
    '};',
    '',
    'filterButtons.forEach(function(btn) {',
    '  btn.addEventListener("click", function() { filterSignals(btn.dataset.filter); });',
    '});',
    '',
    'analyzeForm.addEventListener("submit", async function(e) {',
    '  e.preventDefault();',
    '  var symbol = symbolInput.value.trim().toUpperCase();',
    '  if (!symbol) return;',
    '  analyzeButton.disabled = true;',
    '  analyzeButton.textContent = "Analiz...";',
    '  try {',
    '    var res = await fetch("/api/analyze-coin", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ symbol: symbol })',
    '    });',
    '    var data = await res.json();',
    '    if (!res.ok) throw new Error(data.error || "Sunucu hatası");',
    '    symbolInput.value = "";',
    '    refreshData();',
    '  } catch (e) { alert("Hata: " + e.message); }',
    '  finally {',
    '    analyzeButton.disabled = false;',
    '    analyzeButton.textContent = "İzlemeye Al / Analiz Et";',
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
  console.log(' SONNY AI TRADER V6 + V14.9 DASHBOARD');
  console.log(' 2H PRE-BREAKOUT RADAR');
  console.log('==========================================');
  console.log('');

  try {
    await loadSymbols();
    console.log('İlk historical candle yüklemesi başlıyor...');

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

// ============================================================
// SERVER
// ============================================================

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
  boot();
});
