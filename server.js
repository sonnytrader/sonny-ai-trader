// server.js (V6 + Trend Çizgisi Tespiti)
// Eğimli trend çizgisi kırılım sinyalleri + V45 tablo arayüzü
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

  // Trend çizgisi ayarları
  TREND_LOOKBACK: 40,           // Kaç mum geriye bakılacak
  TREND_PIVOT_LEFT: 2,          // Pivot sol
  TREND_PIVOT_RIGHT: 2,         // Pivot sağ
  TREND_MIN_PIVOTS: 3,          // En az kaç pivot nokta gerekli
  TREND_MIN_R2: 0.70,           // Minimum R² (uyum kalitesi)
  TREND_BREAK_BUFFER_PCT: 0.15, // Kırılım için buffer (%)
  TREND_NEAR_DISTANCE_PCT: 1.50,// Çizgiye yakınlık (%)

  // Skor ayarları
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
      trendUp: null,    // Yükselen destek çizgisi
      trendDown: null,  // Düşen direnç çizgisi
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
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.code && j.code !== '00000') throw new Error(`${j.code} ${j.msg || ''}`);
  return j;
}

// ============================================================
// LOAD SYMBOLS
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

// ============================================================
// 2H CANDLES (1H'den agrege)
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

  // Trend çizgilerini hesapla
  detectTrendLines(symbol);
}

// ============================================================
// PIVOT TESPİTİ
// ============================================================

function findPivotHighs(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isPivot = true;
    for (let x = 1; x <= left; x++) {
      if (!candles[i - x] || candles[i - x].high >= c.high) { isPivot = false; break; }
    }
    if (isPivot) {
      for (let x = 1; x <= right; x++) {
        if (!candles[i + x] || candles[i + x].high > c.high) { isPivot = false; break; }
      }
    }
    if (isPivot) pivots.push({ index: i, price: c.high, ts: c.ts });
  }
  return pivots;
}

function findPivotLows(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isPivot = true;
    for (let x = 1; x <= left; x++) {
      if (!candles[i - x] || candles[i - x].low <= c.low) { isPivot = false; break; }
    }
    if (isPivot) {
      for (let x = 1; x <= right; x++) {
        if (!candles[i + x] || candles[i + x].low < c.low) { isPivot = false; break; }
      }
    }
    if (isPivot) pivots.push({ index: i, price: c.low, ts: c.ts });
  }
  return pivots;
}

// ============================================================
// LINEER REGRESYON (y = a*x + b)
// ============================================================

function linearRegression(points) {
  // points: [{ x, y }, ...]
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const a = (n * sumXY - sumX * sumY) / denom;  // eğim
  const b = (sumY - a * sumX) / n;              // kesişim

  // R² hesapla
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

// ============================================================
// TREND ÇİZGİSİ TESPİTİ
// ============================================================

function detectTrendLines(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;
  if (!candles || candles.length < CFG.TREND_LOOKBACK) return;

  const recent = candles.slice(-CFG.TREND_LOOKBACK);
  const lastIndex = candles.length - 1;
  const baseIndex = candles.length - CFG.TREND_LOOKBACK;

  // ---- DÜŞEN DİRENÇ ÇİZGİSİ ----
  const pivotHighs = findPivotHighs(recent, CFG.TREND_PIVOT_LEFT, CFG.TREND_PIVOT_RIGHT);
  if (pivotHighs.length >= CFG.TREND_MIN_PIVOTS) {
    // En son N pivotu al
    const latest = pivotHighs.slice(-Math.min(pivotHighs.length, 6));
    const points = latest.map(p => ({ x: p.index, y: p.price }));
    const reg = linearRegression(points);

    if (reg && reg.r2 >= CFG.TREND_MIN_R2 && reg.a < 0) {  // düşen olmalı
      // Bugünkü değer
      const currentX = recent.length - 1;
      const currentValue = reg.a * currentX + reg.b;

      s.trendDown = {
        slope: reg.a,
        intercept: reg.b,
        r2: reg.r2,
        pivotCount: latest.length,
        currentValue,     // Bugünkü çizgi değeri
        candleIndex: baseIndex + currentX,
        updatedAt: now()
      };
    } else {
      s.trendDown = null;
    }
  } else {
    s.trendDown = null;
  }

  // ---- YÜKSELEN DESTEK ÇİZGİSİ ----
  const pivotLows = findPivotLows(recent, CFG.TREND_PIVOT_LEFT, CFG.TREND_PIVOT_RIGHT);
  if (pivotLows.length >= CFG.TREND_MIN_PIVOTS) {
    const latest = pivotLows.slice(-Math.min(pivotLows.length, 6));
    const points = latest.map(p => ({ x: p.index, y: p.price }));
    const reg = linearRegression(points);

    if (reg && reg.r2 >= CFG.TREND_MIN_R2 && reg.a > 0) {  // yükselen olmalı
      const currentX = recent.length - 1;
      const currentValue = reg.a * currentX + reg.b;

      s.trendUp = {
        slope: reg.a,
        intercept: reg.b,
        r2: reg.r2,
        pivotCount: latest.length,
        currentValue,
        candleIndex: baseIndex + currentX,
        updatedAt: now()
      };
    } else {
      s.trendUp = null;
    }
  } else {
    s.trendUp = null;
  }
}

// ============================================================
// KIRILIM KONTROLÜ
// ============================================================

function checkTrendBreak(symbol) {
  const s = getSymbol(symbol);
  if (!s.price || !s.twoHCandles || s.twoHCandles.length < 10) return null;

  const candles = s.twoHCandles;
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const price = s.price;

  // ---- LONG: Düşen direnç çizgisi yukarı kırıldı mı? ----
  if (s.trendDown) {
    const lineValue = s.trendDown.currentValue;
    const buffer = lineValue * (CFG.TREND_BREAK_BUFFER_PCT / 100);

    // Fiyat çizginin üstünde mi?
    const broken = price > lineValue + buffer;

    // Önceki mum çizginin altında mıydı? (yeni kırılım tespiti)
    const prevBelow = prevCandle.close <= lineValue;

    // Çizgiye yakınlık
    const distance = absPct(price, lineValue);

    if (broken && distance <= CFG.TREND_NEAR_DISTANCE_PCT * 3) {
      return {
        direction: 'LONG',
        trendType: 'DOWN_RESISTANCE_BREAK',
        lineValue,
        distance,
        isNewBreak: prevBelow,
        r2: s.trendDown.r2,
        pivotCount: s.trendDown.pivotCount
      };
    }
  }

  // ---- SHORT: Yükselen destek çizgisi aşağı kırıldı mı? ----
  if (s.trendUp) {
    const lineValue = s.trendUp.currentValue;
    const buffer = lineValue * (CFG.TREND_BREAK_BUFFER_PCT / 100);

    const broken = price < lineValue - buffer;
    const prevAbove = prevCandle.close >= lineValue;
    const distance = absPct(price, lineValue);

    if (broken && distance <= CFG.TREND_NEAR_DISTANCE_PCT * 3) {
      return {
        direction: 'SHORT',
        trendType: 'UP_SUPPORT_BREAK',
        lineValue,
        distance,
        isNewBreak: prevAbove,
        r2: s.trendUp.r2,
        pivotCount: s.trendUp.pivotCount
      };
    }
  }

  return null;
}

// ============================================================
// HACİM / FLOW / MOMENTUM
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
// TACTICAL ANALYSIS
// ============================================================

function generateTacticalAnalysis(data) {
  const { direction, distance, volumeRatio, oi, flow, momentum, r2, pivotCount, trendType } = data;
  let a = '';
  let c = 50;

  // Trend kalitesi
  if (r2 >= 0.85) { a += `📐 **Mükemmel Trend Çizgisi:** R²=${r2.toFixed(2)}, ${pivotCount} pivot noktası. Çok güvenilir. `; c += 20; }
  else if (r2 >= 0.75) { a += `📏 **İyi Trend Çizgisi:** R²=${r2.toFixed(2)}, ${pivotCount} pivot. Güvenilir. `; c += 15; }
  else { a += `📊 **Orta Trend Çizgisi:** R²=${r2.toFixed(2)}, ${pivotCount} pivot. `; c += 5; }

  // Kırılım tipi
  if (trendType === 'DOWN_RESISTANCE_BREAK') {
    a += `🔺 **Düşen Direnç Kırıldı:** Fiyat düşen trend çizgisinin üstüne çıktı (çizgi: ${data.lineValue.toFixed(6)}). Yükseliş sinyali. `;
  } else if (trendType === 'UP_SUPPORT_BREAK') {
    a += `🔻 **Yükselen Destek Kırıldı:** Fiyat yükselen trend çizgisinin altına indi (çizgi: ${data.lineValue.toFixed(6)}). Düşüş sinyali. `;
  }

  // Mesafe
  if (distance <= 0.5) { a += `🎯 **Kırılım Yeni:** Fiyat çizgiye çok yakın (%${distance.toFixed(2)}). `; c += 20; }
  else if (distance <= 1.5) { a += `⚡ **Kırılım Taze:** Fiyat çizgiden %${distance.toFixed(2)} uzakta. `; c += 10; }
  else { a += `👀 **Kırılım Eski:** Fiyat çizgiden %${distance.toFixed(2)} uzakta. `; c -= 10; }

  // Hacim
  const vt = volumeRatio.toFixed(2);
  if (volumeRatio >= 1.9) { a += `🐋 **Balina Hacmi:** ${vt}x. `; c += 20; }
  else if (volumeRatio >= 1.5) { a += `👍 **Hacim Teyitli:** ${vt}x. `; c += 15; }
  else if (volumeRatio >= 1.2) { a += `ℹ️ **Hacim Normal:** ${vt}x. `; c += 5; }
  else { a += `👎 **Zayıf Hacim:** ${vt}x. Fakeout riski. `; c -= 15; }

  // OI
  const ot = oi.toFixed(2);
  if (oi >= 0.15) { a += `📈 **OI Patlaması:** %${ot}. `; c += 15; }
  else if (oi >= 0.08) { a += `📊 **OI Artıyor:** %${ot}. `; c += 10; }

  // Flow
  if (direction === 'LONG') {
    if (flow >= 0.63) { a += `🟢 **Alım Baskısı:** %${(flow * 100).toFixed(0)}. `; c += 15; }
    else if (flow >= 0.54) { a += `🟡 **Alım Eğilimi:** %${(flow * 100).toFixed(0)}. `; }
    else { a += `🔴 **Satım Baskısı:** %${(flow * 100).toFixed(0)}. `; c -= 10; }
  } else {
    const sf = 1 - flow;
    if (sf >= 0.63) { a += `🔴 **Satım Baskısı:** %${(sf * 100).toFixed(0)}. `; c += 15; }
    else if (sf >= 0.54) { a += `🟠 **Satım Eğilimi:** %${(sf * 100).toFixed(0)}. `; }
    else { a += `🟢 **Alım Baskısı:** %${((1 - sf) * 100).toFixed(0)}. `; c -= 10; }
  }

  // Momentum
  const mt = momentum.toFixed(2);
  if (Math.abs(momentum) >= 0.15) {
    if ((direction === 'LONG' && momentum > 0) || (direction === 'SHORT' && momentum < 0)) {
      a += `🚀 **Momentum Güçlü:** %${mt}. `; c += 10;
    } else {
      a += `⚠️ **Ters Momentum:** %${mt}. `; c -= 15;
    }
  }

  return { text: a, confidence: Math.min(Math.max(c, 0), 99).toFixed(0) };
}

// ============================================================
// SKOR
// ============================================================

function calculateScore(symbol, breakInfo) {
  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);
  const direction = breakInfo.direction;

  let score = 0;

  // Trend kalitesi (R²) - 25 puan
  if (breakInfo.r2 >= 0.85) score += 25;
  else if (breakInfo.r2 >= 0.75) score += 18;
  else if (breakInfo.r2 >= 0.70) score += 12;

  // Pivot sayısı - 10 puan
  if (breakInfo.pivotCount >= 5) score += 10;
  else if (breakInfo.pivotCount >= 4) score += 6;
  else if (breakInfo.pivotCount >= 3) score += 3;

  // Kırılım tazeliği - 20 puan
  if (breakInfo.isNewBreak) score += 15;
  if (breakInfo.distance <= 0.5) score += 5;
  else if (breakInfo.distance <= 1.5) score += 3;

  // Hacim - 20 puan
  if (vr >= 1.9) score += 20;
  else if (vr >= 1.5) score += 16;
  else if (vr >= 1.2) score += 10;

  // OI - 15 puan
  if (oi >= 0.15) score += 15;
  else if (oi >= 0.08) score += 10;
  else if (oi >= 0.03) score += 5;

  // Flow - 10 puan
  const flowDir = direction === 'LONG' ? flow : (1 - flow);
  if (flowDir >= 0.63) score += 10;
  else if (flowDir >= 0.54) score += 6;

  // Momentum - 10 puan
  const momDir = (direction === 'LONG' && mom > 0) || (direction === 'SHORT' && mom < 0);
  if (momDir && Math.abs(mom) >= 0.15) score += 10;
  else if (momDir && Math.abs(mom) >= 0.08) score += 6;

  return Math.min(100, Math.round(score));
}

// ============================================================
// SINYAL ÜRET
// ============================================================

function classifySignal(symbol, breakInfo) {
  const s = getSymbol(symbol);
  const score = calculateScore(symbol, breakInfo);

  let stateName = null;
  if (score >= CFG.ENTRY_SCORE) stateName = 'GİRİŞ FIRSATI';
  else if (score >= CFG.IGNITION_SCORE) stateName = 'HAREKET BAŞLADI';
  else if (score >= CFG.WATCH_SCORE) stateName = 'İZLE';
  if (!stateName) return null;

  const vr = calculateVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);

  const tactical = generateTacticalAnalysis({
    direction: breakInfo.direction,
    distance: breakInfo.distance,
    volumeRatio: vr, oi, flow, momentum: mom,
    r2: breakInfo.r2, pivotCount: breakInfo.pivotCount,
    trendType: breakInfo.trendType,
    lineValue: breakInfo.lineValue
  });

  return {
    id: `${symbol}-${breakInfo.direction}-${Date.now()}`,
    symbol,
    direction: breakInfo.direction,
    signal: breakInfo.direction,
    state: stateName,
    score,
    confidence: tactical.confidence,
    tacticalAnalysis: tactical.text,
    reason: `${breakInfo.trendType} | R²=${breakInfo.r2.toFixed(2)} | Skor=${score}`,

    price: s.price,
    lineValue: breakInfo.lineValue,
    distancePct: breakInfo.distance,

    entryPrice: s.price.toFixed(6),
    TP: '---', SL: '---', RR: 'N/A',

    volumeRatio: vr,
    oiChangePct: oi,
    flow,
    momentum: mom,

    trendR2: breakInfo.r2,
    trendPivots: breakInfo.pivotCount,
    trendSlope: breakInfo.trendType === 'DOWN_RESISTANCE_BREAK'
      ? s.trendDown?.slope : s.trendUp?.slope,

    strategyType: 'TREND',
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

  // Trend çizgilerini yeniden hesapla
  detectTrendLines(symbol);

  const breakInfo = checkTrendBreak(symbol);
  if (!breakInfo) { s.signal = null; return; }

  const sig = classifySignal(symbol, breakInfo);
  if (!sig) { s.signal = null; return; }

  const ck = `${symbol}-${sig.direction}`;
  const cd = state.cooldowns[ck];
  if (cd && cd.timestamp > now() - CFG.SIGNAL_COOLDOWN_MS) { s.signal = sig; return; }

  const prev = s.signal;
  if (!prev || prev.state !== sig.state || Math.abs(prev.score - sig.score) >= 5) {
    s.signal = sig;
    state.cooldowns[ck] = { timestamp: now() };
    state.stats.signals++;
    state.trendSignals.unshift(sig);
    if (state.trendSignals.length > 100) state.trendSignals.pop();
    console.log(`[${sig.state}] ${sig.direction} ${sig.symbol} score=${sig.score} conf=${sig.confidence}% R²=${breakInfo.r2.toFixed(2)}`);
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
    ok: true, system: 'SONNY AI TRADER V6', mode: 'TREND ÇİZGİSİ',
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
      // Trend çizgisi değeri yeniden hesaplanır (canlı)
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
      message: state.stats.lastScan ? `Tarama Tamamlandı. ${state.trendSignals.length} trend sinyali aktif.` : 'Tarama bekleniyor...',
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
    '<title>Sonny AI Trader V6 - Trend Çizgisi</title>',
    '<style>',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #e0e0e0; margin: 0; padding: 0; font-size: 0.85rem; }',
    '.container-fluid { padding: 1.5rem; max-width: 1800px; margin: 0 auto; }',
    'header { padding: 20px; background-color: #2a2a2a; border-bottom: 1px solid #333; text-align: center; margin-bottom: 1.5rem; border-radius: 8px; }',
    'header h1 { color: #4CAF50; margin: 0; font-size: 1.6em; }',
    'header p { color: #888; margin: 5px 0 0 0; font-size: 0.9em; }',
    '#scan-status { font-size: 0.9em; color: #bbb; margin-top: 8px; display: flex; align-items: center; justify-content: center; }',
    '.table-wrapper { overflow-x: auto; padding: 15px 20px; background-color: #1e1e1e; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); margin-bottom: 1.5rem; }',
    'table { width: 100%; border-collapse: collapse; table-layout: fixed; }',
    'th, td { padding: 9px 11px; text-align: left; border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }',
    'th { background-color: #2a2a2a; cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 10; }',
    'tbody tr:hover { background-color: #303030; }',
    '.signal-pending-long { background-color: #d1e7dd; color: #0f5132; border: 1px dashed #0f5132; font-weight: bold; }',
    '.signal-pending-short { background-color: #f8d7da; color: #842029; border: 1px dashed #842029; font-weight: bold; }',
    '.compact-signal { padding: 4px 8px; font-size: 0.9em; border-radius: 4px; }',
    '.link-text { color: #64b5f6; text-decoration: none; } .link-text:hover { text-decoration: underline; }',
    '.entry-price { font-weight: bold; color: #ffc107; }',
    '.line-value { font-weight: bold; color: #ff9800; }',
    '.r2-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.75em; font-weight: bold; }',
    '.r2-high { background: #1a7a3a; color: white; }',
    '.r2-mid { background: #665c00; color: #ffc107; }',
    '.r2-low { background: #4a4a4a; color: #ccc; }',
    '.strategy-trend { font-size: 0.8em; color: #64b5f6; font-weight: bold; }',
    'h2 { font-size: 1.1rem; color: #adb5bd; margin: 1.5rem 0 0.75rem 0; padding: 0 20px; border-bottom: 1px solid #444; padding-bottom: 0.5rem; }',
    '.scrollable-table { max-height: 700px; overflow-y: auto; }',
    '.filter-section { padding: 10px 20px; background-color: #252525; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-radius: 6px; margin-bottom: 1rem; }',
    '.filter-section label { font-weight: bold; font-size: 0.9em; } .filter-section input[type="number"] { width: 70px; padding: 5px; background-color: #333; border: 1px solid #444; border-radius: 4px; color: #fff; font-size: 0.9em; }',
    '.filter-section button { padding: 5px 12px; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }',
    '#apply-filter-button { background-color: #4CAF50; } #show-all-button { background-color: #6c757d; }',
    '.stats { display: flex; gap: 20px; padding: 10px 20px; background-color: #252525; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9em; }',
    '.stat-item { color: #adb5bd; } .stat-item b { color: #4CAF50; font-size: 1.1em; }',
    '</style>',
    '</head>',
    '<body>',
    '<div class="container-fluid">',
    '<header>',
    '<h1>📐 Sonny AI Trader V6 - Trend Çizgisi Kırılım</h1>',
    '<p>2H zaman diliminde eğimli trend çizgisi kırılım tespiti (R² ≥ 0.70)</p>',
    '<div id="scan-status"><span id="scan-status-text">Sunucuya bağlanılıyor...</span></div>',
    '</header>',

    '<div class="stats">',
    '<div class="stat-item">Aktif Sinyal: <b id="stat-signals">0</b></div>',
    '<div class="stat-item">Taranan Coin: <b id="stat-symbols">0</b></div>',
    '<div class="stat-item">Tarama Sayısı: <b id="stat-scans">0</b></div>',
    '</div>',

    '<div class="filter-section">',
    '<label for="confidence-threshold">Min. Güven:</label>',
    '<input type="number" id="confidence-threshold" value="0" min="0" max="100">',
    '<button id="apply-filter-button">Filtrele</button>',
    '<button id="show-all-button">Tümünü Göster</button>',
    '<span style="margin-left: auto; color: #888; font-size: 0.85em;">Trend kırılım sinyalleri (2H)</span>',
    '</div>',

    '<div class="table-container">',
    '<h2>📈 Trend Çizgisi Kırılım Sinyalleri</h2>',
    '<div class="table-wrapper scrollable-table">',
    '<table class="trend-table">',
    '<thead><tr>',
    '<th>Zaman</th>',
    '<th>Sembol</th>',
    '<th>Yön</th>',
    '<th>Durum</th>',
    '<th>Güven %</th>',
    '<th>Giriş Fiyatı</th>',
    '<th>Trend Çizgisi</th>',
    '<th>Uzaklık %</th>',
    '<th>R²</th>',
    '<th>Hacim</th>',
    '<th>Açıklama</th>',
    '</tr></thead>',
    '<tbody id="trend-table-body"><tr><td colspan="11" style="text-align:center;color:#666;padding:15px;">Henüz trend kırılım sinyali yok.</td></tr></tbody>',
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
    'var trendTableBody = document.getElementById("trend-table-body");',
    'var confidenceThresholdInput = document.getElementById("confidence-threshold");',
    'var applyFilterButton = document.getElementById("apply-filter-button");',
    'var showAllButton = document.getElementById("show-all-button");',
    'var scanStatusText = document.getElementById("scan-status-text");',
    'var statSignals = document.getElementById("stat-signals");',
    'var statSymbols = document.getElementById("stat-symbols");',
    'var statScans = document.getElementById("stat-scans");',
    '',
    'var allSignals = [];',
    'var currentThreshold = 0;',
    '',
    'function formatTimestamp(ts) {',
    '  if (!ts) return "---";',
    '  try { return new Date(ts).toLocaleTimeString("tr-TR"); }',
    '  catch (e) { return "---"; }',
    '}',
    '',
    'function r2Class(r2) {',
    '  if (r2 >= 0.85) return "r2-badge r2-high";',
    '  if (r2 >= 0.75) return "r2-badge r2-mid";',
    '  return "r2-badge r2-low";',
    '}',
    '',
    'function formatReasonText(r) {',
    '  if (!r) return "---";',
    '  try {',
    '    return r.replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");',
    '  } catch (e) { return r; }',
    '}',
    '',
    'function createRow(sig) {',
    '  var row = document.createElement("tr");',
    '  var cls = sig.direction === "LONG" ? "signal-pending-long compact-signal" : "signal-pending-short compact-signal";',
    '  var tvSymbol = (sig.symbol || "").replace("USDT", "");',
    '  var tvLink = "https://www.tradingview.com/chart/?symbol=BITGET:" + tvSymbol + "USDT.P&interval=120";',
    '  var r2 = parseFloat(sig.trendR2) || 0;',
    '  var r2Badge = \'<span class="\' + r2Class(r2) + \'">R²=\' + r2.toFixed(2) + "</span>";',
    '  var reason = formatReasonText(sig.tacticalAnalysis || sig.reason);',
    '  var vol = sig.volumeRatio ? sig.volumeRatio.toFixed(2) + "x" : "---";',
    '  var lineVal = sig.lineValue ? sig.lineValue.toFixed(6) : "---";',
    '  var distPct = sig.distancePct ? sig.distancePct.toFixed(2) : "---";',
    '  var trendType = sig.strategyType === "TREND"',
    '    ? (sig.direction === "LONG" ? "Düşen Direnç Kırılımı" : "Yükselen Destek Kırılımı")',
    '    : sig.strategyType;',
    '',
    '  row.innerHTML =',
    '    "<td>" + formatTimestamp(sig.timestamp) + "</td>" +',
    '    \'<td><a href="\' + tvLink + \'" target="_blank" class="link-text">\' + (sig.symbol || "N/A") + \'</a> <span class="strategy-trend">(2H Trend)</span></td>\' +',
    '    \'<td class="\' + cls + \'">\' + (sig.direction || "?") + "</td>" +',
    '    "<td>" + (sig.state || "---") + "</td>" +',
    '    \'<td style="text-align: right;">\' + (sig.confidence ? sig.confidence + "%" : "---") + "</td>" +',
    '    \'<td class="entry-price" style="text-align: right;">\' + (sig.entryPrice || "---") + "</td>" +',
    '    \'<td class="line-value" style="text-align: right;">\' + lineVal + "</td>" +',
    '    \'<td style="text-align: right;">%\' + distPct + "</td>" +',
    '    "<td>" + r2Badge + "</td>" +',
    '    "<td>" + vol + "</td>" +',
    '    \'<td style="white-space: normal;">\' + reason + "</td>";',
    '  return row;',
    '}',
    '',
    'function render() {',
    '  trendTableBody.innerHTML = "";',
    '  var filtered = allSignals.filter(function(s) {',
    '    return parseInt(s.confidence) >= currentThreshold;',
    '  });',
    '  if (!filtered.length) {',
    '    trendTableBody.innerHTML = \'<tr><td colspan="11" style="text-align:center;color:#666;padding:15px;">Filtreye uygun sinyal yok.</td></tr>\';',
    '    return;',
    '  }',
    '  filtered.forEach(function(s) { trendTableBody.appendChild(createRow(s)); });',
    '}',
    '',
    'async function refreshData() {',
    '  try {',
    '    var res = await fetch("/api/signals");',
    '    var data = await res.json();',
    '    if (scanStatusText) scanStatusText.textContent = data.scanStatus ? data.scanStatus.message : "Tarama...";',
    '    allSignals = data.trendSignals || [];',
    '    if (statSignals) statSignals.textContent = allSignals.length;',
    '    try {',
    '      var sres = await fetch("/api/status");',
    '      var sdata = await sres.json();',
    '      if (statSymbols) statSymbols.textContent = sdata.symbols || 0;',
    '      if (statScans) statScans.textContent = sdata.scans || 0;',
    '    } catch (e) {}',
    '    render();',
    '  } catch (e) {',
    '    if (scanStatusText) scanStatusText.textContent = "Sunucu hatası: " + e.message;',
    '  }',
    '}',
    '',
    'applyFilterButton.addEventListener("click", function() {',
    '  currentThreshold = parseInt(confidenceThresholdInput.value) || 0;',
    '  render();',
    '});',
    '',
    'showAllButton.addEventListener("click", function() {',
    '  currentThreshold = 0;',
    '  confidenceThresholdInput.value = 0;',
    '  render();',
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
  console.log(' SONNY AI TRADER V6 - TREND ÇİZGİSİ');
  console.log(' 2H Eğimli Trend Çizgisi Kırılım Tespiti');
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
    console.log('Historical veriler ve trend çizgileri hazır.');
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
