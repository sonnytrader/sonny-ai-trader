// server.js (ANA PROJE - V6 + V14.2 Dashboard)
// V6 native Bitget WebSocket altyapısı + V14.2 sekmeli dashboard
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
// SONNY AI TRADER V6 + V14.2 DASHBOARD
// 2H PRE-BREAKOUT RADAR + SEKMELİ DÜZEN
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
  WATCHLIST_SCAN_MS: 30 * 1000,

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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

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
  const json = await rest('/api/v2/mix/market/contracts', {
    productType: PRODUCT
  });

  const contracts = Array.isArray(json.data)
    ? json.data
    : [];

  const valid = contracts
    .filter(x => {
      const symbol = normalizeSymbol(x.symbol);

      return (
        symbol &&
        x.symbolType !== 'delivery' &&
        String(x.quoteCoin).toUpperCase() === 'USDT'
      );
    })
    .map(x => normalizeSymbol(x.symbol));

  console.log(`Bitget marketleri: ${valid.length}`);

  for (const symbol of valid) {
    getSymbol(symbol);
  }

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

    const rows = Array.isArray(json.data)
      ? json.data
      : [];

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
    console.error(
      `[${symbol}] 1H candle error: ${err.message}`
    );
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
    const bucket =
      Math.floor(
        c.ts / (2 * 60 * 60 * 1000)
      );

    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
    }

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

  const nearestResistance =
    resistance.filter(x => x > price).sort((a, b) => a - b)[0] || null;

  const nearestSupport =
    support.filter(x => x < price).sort((a, b) => b - a)[0] || null;

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
// TACTICAL ANALYSIS (V14.2'den uyarlama)
// ============================================================

function generateTacticalAnalysis(data) {
  const { signal, distance, volumeRatio, oi, flow, momentum } = data;
  let analysis = "";
  let confidenceLevel = 50;

  // Seviye yakınlığı
  if (distance <= CFG.ENTRY_DISTANCE_PCT) {
    analysis += `🎯 **Seviyeye Çok Yakın:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. Kırılım çok yakın olabilir. `;
    confidenceLevel += 20;
  } else if (distance <= CFG.IGNITION_DISTANCE_PCT) {
    analysis += `⚡ **Hareket Başlıyor:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. İzlemeye değer. `;
    confidenceLevel += 10;
  } else {
    analysis += `👀 **İzleme Modu:** Fiyat seviyeye %${distance.toFixed(2)} mesafede. Henüz erken. `;
  }

  // Hacim
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

  // OI
  const oiText = oi.toFixed(2);
  if (oi >= CFG.OI_ENTRY_PCT) {
    analysis += `📈 **OI Patlaması:** Açık pozisyon %${oiText} arttı. Yeni para giriyor. `;
    confidenceLevel += 20;
  } else if (oi >= CFG.OI_IGNITION_PCT) {
    analysis += `📊 **OI Artıyor:** Açık pozisyon %${oiText}. İlgi artıyor. `;
    confidenceLevel += 10;
  }

  // Flow
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

  // Momentum
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

  return {
    text: analysis,
    confidence: finalConfidence.toFixed(0)
  };
}

// ============================================================
// SCORE
// ============================================================

function calculateScore(symbol, direction) {
  const s = getSymbol(symbol);
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

  // LONG
  if (s.level.resistance && s.price < s.level.resistance) {
    const score = calculateScore(symbol, 'LONG');
    const signal = classifySignal(symbol, 'LONG', score);
    if (signal) candidates.push(signal);
  }

  // SHORT
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

  // Cooldown kontrolü
  const cooldownKey = `${symbol}-${best.direction}`;
  const cooldown = state.cooldowns[cooldownKey];

  if (cooldown && cooldown.timestamp > now() - CFG.SIGNAL_COOLDOWN_MS) {
    // Cooldown'da, ama state güncelle
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

    // Sinyali listeye ekle (Kırılım sekmesi)
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
    if (s.signal && s.signal.expiresAt < t) {
      s.signal = null;
    }
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
    mode: '2H PRE-BREAKOUT RADAR + V14.2 DASHBOARD',
    wsConnected: state.wsConnected,
    symbols: state.symbols.size,
    signals: state.stats.signals,
    scans: state.stats.scans,
    lastScan: state.stats.lastScan,
    uptime: now() - state.startedAt
  });
});

// ============================================================
// API SIGNALS (Kırılım + Momentum)
// ============================================================

app.get('/api/signals', (req, res) => {
  const kirilim = state.kirilimSignals.slice(0, 50);
  const momentum = state.momentumSignals.slice(0, 50);

  res.json({
    ok: true,
    serverTime: now(),
    kirilimSignals: kirilim,
    momentumSignals: momentum,
    signals: kirilim
  });
});

// ============================================================
// API RADAR
// ============================================================

app.get('/api/radar', (req, res) => {
  const rows = [];

  for (const s of state.symbols.values()) {
    if (!s.price || !s.level) continue;

    const candidates = [];

    if (s.level.resistance && s.price < s.level.resistance) {
      const distance = absPct(s.price, s.level.resistance);
      if (distance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'LONG', level: s.level.resistance, distance });
      }
    }

    if (s.level.support && s.price > s.level.support) {
      const distance = absPct(s.price, s.level.support);
      if (distance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'SHORT', level: s.level.support, distance });
      }
    }

    for (const c of candidates) {
      rows.push({
        symbol: s.symbol,
        direction: c.direction,
        price: s.price,
        level: c.level,
        distancePct: c.distance,
        volumeRatio: calculateVolumeRatio(s.symbol),
        oiChangePct: oiChange(s.symbol),
        flow: flowScore(s.symbol),
        momentum: priceMomentum(s.symbol)
      });
    }
  }

  rows.sort((a, b) => a.distancePct - b.distancePct);

  res.json({ ok: true, radar: rows.slice(0, 50) });
});

// ============================================================
// API WATCHLIST
// ============================================================

app.get('/api/watchlist', (req, res) => {
  res.json({ ok: true, watchlist: state.watchlist });
});

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

    // Kırılım analizi
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
// MAIN PAGE (V14.2 sekmeli düzen)
// ============================================================

app.get('/', (req, res) => {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="tr">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Sonny AI Trader V6</title>',
    '<style>',
    '* { box-sizing: border-box; }',
    'body { margin: 0; background: #090d12; color: #e8edf3; font-family: Arial, sans-serif; }',
    'header { padding: 20px; border-bottom: 1px solid #1d2630; }',
    'h1 { margin: 0 0 6px; font-size: 24px; }',
    '.subtitle { color: #8995a3; font-size: 13px; }',
    '.status { margin-top: 10px; font-size: 13px; }',
    '.container { padding: 18px; max-width: 1400px; margin: auto; }',
    '.tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid #1d2630; padding-bottom: 10px; }',
    '.tab { padding: 10px 20px; background: #10161e; border: 1px solid #202a35; border-radius: 8px; cursor: pointer; color: #8995a3; font-size: 14px; font-weight: bold; }',
    '.tab.active { background: #19c37d; color: #090d12; border-color: #19c37d; }',
    '.tab:hover { color: #e8edf3; }',
    '.tab-content { display: none; }',
    '.tab-content.active { display: block; }',
    '.section { margin-bottom: 25px; }',
    '.section h2 { font-size: 16px; margin-bottom: 12px; }',
    '.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 12px; }',
    '.card { background: #10161e; border: 1px solid #202a35; border-radius: 12px; padding: 15px; }',
    '.card.long { border-left: 4px solid #19c37d; }',
    '.card.short { border-left: 4px solid #ff5964; }',
    '.symbol { font-size: 18px; font-weight: bold; }',
    '.direction { font-size: 12px; margin-left: 8px; padding: 4px 7px; border-radius: 5px; }',
    '.long .direction { background: #123d2e; color: #35e09a; }',
    '.short .direction { background: #441d23; color: #ff737d; }',
    '.state { margin-top: 12px; font-weight: bold; font-size: 15px; }',
    '.score { font-size: 28px; font-weight: bold; margin: 10px 0; }',
    '.confidence { font-size: 13px; color: #8995a3; margin-bottom: 8px; }',
    '.tactical { background: #0b1016; padding: 10px; border-radius: 6px; margin: 10px 0; font-size: 12px; line-height: 1.6; color: #aeb8c4; }',
    '.metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; color: #aeb8c4; font-size: 12px; }',
    '.metric { background: #0b1016; padding: 8px; border-radius: 6px; }',
    '.metric b { display: block; color: #f0f3f6; margin-top: 3px; }',
    '.empty { color: #687583; padding: 30px; text-align: center; }',
    '.watchlist-form { display: flex; gap: 8px; margin-bottom: 15px; }',
    '.watchlist-form input { flex: 1; padding: 10px; background: #0b1016; border: 1px solid #202a35; border-radius: 6px; color: #e8edf3; font-size: 14px; }',
    '.watchlist-form button { padding: 10px 20px; background: #19c37d; color: #090d12; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }',
    '.watchlist-form button:hover { background: #15a868; }',
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '<h1>SONNY AI TRADER V6</h1>',
    '<div class="subtitle">2H PRE-BREAKOUT RADAR + V14.2 DASHBOARD</div>',
    '<div class="status" id="status">Bağlanıyor...</div>',
    '</header>',
    '<div class="container">',
    '<div class="tabs">',
    '<div class="tab active" data-tab="kirilim">🔥 KIRILIM SİNYALLERİ</div>',
    '<div class="tab" data-tab="momentum">📡 MOMENTUM SİNYALLERİ</div>',
    '<div class="tab" data-tab="watchlist">👁️ İZLEME LİSTESİ</div>',
    '<div class="tab" data-tab="radar">📊 2H SEVİYE RADARI</div>',
    '</div>',
    '<div class="tab-content active" id="tab-kirilim">',
    '<div class="section">',
    '<h2>🔥 AKTİF KIRILIM SİNYALLERİ</h2>',
    '<div id="kirilim-signals" class="grid">',
    '<div class="empty">Sinyal aranıyor...</div>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="tab-content" id="tab-momentum">',
    '<div class="section">',
    '<h2>📡 MOMENTUM SİNYALLERİ</h2>',
    '<div id="momentum-signals" class="grid">',
    '<div class="empty">Momentum sinyali aranıyor...</div>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="tab-content" id="tab-watchlist">',
    '<div class="section">',
    '<h2>👁️ İZLEME LİSTESİ</h2>',
    '<div class="watchlist-form">',
    '<input type="text" id="watchlist-input" placeholder="Örn: BTC, ETH, SOL...">',
    '<button id="watchlist-add">+ Ekle</button>',
    '</div>',
    '<div id="watchlist-items" class="grid">',
    '<div class="empty">İzleme listesi boş.</div>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="tab-content" id="tab-radar">',
    '<div class="section">',
    '<h2>📊 2H SEVİYE RADARI</h2>',
    '<div id="radar-signals" class="grid">',
    '<div class="empty">Radar hazırlanıyor...</div>',
    '</div>',
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
    'function esc(v) {',
    '  return String(v == null ? "" : v)',
    '    .replace(/&/g, "&amp;")',
    '    .replace(/</g, "&lt;")',
    '    .replace(/>/g, "&gt;")',
    '    .replace(/"/g, "&quot;");',
    '}',
    'function n(v, d) {',
    '  if (d === undefined) d = 2;',
    '  var x = Number(v);',
    '  if (!Number.isFinite(x)) return "-";',
    '  return x.toFixed(d);',
    '}',
    // Tabs
    'document.querySelectorAll(".tab").forEach(function(tab) {',
    '  tab.addEventListener("click", function() {',
    '    document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });',
    '    document.querySelectorAll(".tab-content").forEach(function(c) { c.classList.remove("active"); });',
    '    tab.classList.add("active");',
    '    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");',
    '  });',
    '});',
    // Render signal card
    'function renderSignalCard(s) {',
    '  var cls = s.direction === "LONG" ? "long" : "short";',
    '  return \'<div class="card \' + cls + \'">\' +',
    '    \'<div><span class="symbol">\' + esc(s.symbol) + \'</span>\' +',
    '    \'<span class="direction">\' + esc(s.direction || s.signal) + \'</span></div>\' +',
    '    \'<div class="state">\' + esc(s.state || s.signal) + \'</div>\' +',
    '    \'<div class="score">\' + n(s.score, 0) + \'/100</div>\' +',
    '    \'<div class="confidence">Güven: %\' + esc(s.confidence || "0") + \'</div>\' +',
    '    \'<div class="tactical">\' + esc(s.tacticalAnalysis || "") + \'</div>\' +',
    '    \'<div class="metrics">\' +',
    '    \'<div class="metric">Fiyat<b>\' + n(s.price || s.entryPrice, 6) + \'</b></div>\' +',
    '    \'<div class="metric">Seviye<b>\' + n(s.level, 6) + \'</b></div>\' +',
    '    \'<div class="metric">Uzaklık<b>%\' + n(s.distancePct) + \'</b></div>\' +',
    '    \'<div class="metric">Hacim<b>\' + n(s.volumeRatio) + \'x</b></div>\' +',
    '    \'<div class="metric">OI<b>%\' + n(s.oiChangePct) + \'</b></div>\' +',
    '    \'<div class="metric">Flow<b>\' + n(s.flow * 100, 1) + \'%</b></div>\' +',
    '    \'<div class="metric">Momentum<b>%\' + n(s.momentum) + \'</b></div>\' +',
    '    \'<div class="metric">Zaman<b>\' + new Date(s.createdAt || s.timestamp || Date.now()).toLocaleTimeString("tr-TR") + \'</b></div>\' +',
    '    \'</div></div>\';',
    '}',
    // Render signals list
    'function renderSignals(containerId, rows) {',
    '  var el = document.getElementById(containerId);',
    '  if (!rows || !rows.length) {',
    '    el.innerHTML = \'<div class="empty">Şu anda sinyal yok.</div>\';',
    '    return;',
    '  }',
    '  el.innerHTML = rows.map(renderSignalCard).join("");',
    '}',
    // Render radar
    'function renderRadar(rows) {',
    '  var el = document.getElementById("radar-signals");',
    '  if (!rows || !rows.length) {',
    '    el.innerHTML = \'<div class="empty">2H seviyesine yaklaşan coin yok.</div>\';',
    '    return;',
    '  }',
    '  el.innerHTML = rows.map(function(s) {',
    '    var cls = s.direction === "LONG" ? "long" : "short";',
    '    return \'<div class="card \' + cls + \'">\' +',
    '      \'<div><span class="symbol">\' + esc(s.symbol) + \'</span>\' +',
    '      \'<span class="direction">\' + esc(s.direction) + \'</span></div>\' +',
    '      \'<div class="state">2H seviyesine yaklaşıyor</div>\' +',
    '      \'<div class="score">%\' + n(s.distancePct) + \'</div>\' +',
    '      \'<div class="metrics">\' +',
    '      \'<div class="metric">Fiyat<b>\' + n(s.price, 6) + \'</b></div>\' +',
    '      \'<div class="metric">Seviye<b>\' + n(s.level, 6) + \'</b></div>\' +',
    '      \'<div class="metric">Hacim<b>\' + n(s.volumeRatio) + \'x</b></div>\' +',
    '      \'<div class="metric">OI<b>%\' + n(s.oiChangePct) + \'</b></div>\' +',
    '      \'<div class="metric">Flow<b>\' + n(s.flow * 100, 1) + \'%</b></div>\' +',
    '      \'<div class="metric">Momentum<b>%\' + n(s.momentum) + \'</b></div>\' +',
    '      \'</div></div>\';',
    '  }).join("");',
    '}',
    // Render watchlist
    'function renderWatchlist(wl) {',
    '  var el = document.getElementById("watchlist-items");',
    '  var keys = Object.keys(wl || {});',
    '  if (!keys.length) {',
    '    el.innerHTML = \'<div class="empty">İzleme listesi boş.</div>\';',
    '    return;',
    '  }',
    '  el.innerHTML = keys.map(function(k) { return renderSignalCard(wl[k]); }).join("");',
    '}',
    // Load data
    'async function load() {',
    '  try {',
    '    var results = await Promise.all([',
    '      fetch("/api/status"),',
    '      fetch("/api/signals"),',
    '      fetch("/api/radar"),',
    '      fetch("/api/watchlist")',
    '    ]);',
    '    var status = await results[0].json();',
    '    var signalData = await results[1].json();',
    '    var radarData = await results[2].json();',
    '    var wlData = await results[3].json();',
    '    document.getElementById("status").innerHTML =',
    '      status.wsConnected',
    '        ? "🟢 LIVE · " + status.symbols + " market · " + (signalData.kirilimSignals || []).length + " kırılım sinyali"',
    '        : "🔴 WebSocket bağlantısı bekleniyor";',
    '    renderSignals("kirilim-signals", signalData.kirilimSignals || []);',
    '    renderSignals("momentum-signals", signalData.momentumSignals || []);',
    '    renderRadar(radarData.radar || []);',
    '    renderWatchlist(wlData.watchlist || {});',
    '  } catch (err) {',
    '    document.getElementById("status").innerHTML = "🔴 Sunucu bağlantı hatası: " + err.message;',
    '  }',
    '}',
    // Add to watchlist
    'async function addToWatchlist() {',
    '  var input = document.getElementById("watchlist-input");',
    '  var symbol = input.value.trim().toUpperCase();',
    '  if (!symbol) return;',
    '  try {',
    '    var res = await fetch("/api/analyze-coin", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ symbol: symbol })',
    '    });',
    '    var data = await res.json();',
    '    if (data.error) {',
    '      alert("Hata: " + data.error);',
    '    } else {',
    '      input.value = "";',
    '      load();',
    '    }',
    '  } catch (err) {',
    '    alert("Bağlantı hatası: " + err.message);',
    '  }',
    '}',
    'document.getElementById("watchlist-add").addEventListener("click", addToWatchlist);',
    'document.getElementById("watchlist-input").addEventListener("keypress", function(e) {',
    '  if (e.key === "Enter") addToWatchlist();',
    '});',
    'load();',
    'setInterval(load, 5000);'
  ].join('\n');

  res.type('application/javascript').send(js);
});

// ============================================================
// START
// ============================================================

async function boot() {
  console.log('');
  console.log('==========================================');
  console.log(' SONNY AI TRADER V6 + V14.2 DASHBOARD');
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
