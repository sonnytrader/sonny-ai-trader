// server.js (V6 - Trend Radar - UI Fix + WS Fix)
// Grafik kaydırma korunur + Bitget v2 ping protokolü
// (2025)

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

const REST = 'https://api.bitget.com';
const BITGET_WS = 'wss://ws.bitget.com/v2/ws/public';
const PRODUCT = 'usdt-futures';

// ============================================================
// AYARLAR
// ============================================================

const CFG = {
  MIN_24H_VOLUME_USDT: 5000000,
  PRESCAN_INTERVAL_MS: 15 * 60 * 1000,
  MAX_COINS: 400,

  TREND_LOOKBACK: 50,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MIN_PIVOTS: 3,
  MIN_R2: 0.70,

  WATCH_DISTANCE_PCT: 2.00,
  NEAR_DISTANCE_PCT: 1.20,
  IGNITION_DISTANCE_PCT: 0.55,
  ENTRY_DISTANCE_PCT: 0.18,

  SCAN_INTERVAL_MS: 30 * 1000,
  WS_BATCH: 20,
  WS_PING_MS: 25 * 1000,

  BTC_EMA_PERIOD: 200,
  MIN_RR_RATIO: 1.2,
  STOP_BUFFER_PCT: 0.30,

  CHART_CANDLES: 60
};

// ============================================================
// RWA BLACKLIST
// ============================================================

const RWA_BLACKLIST = new Set([
  'AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','NFLX','AMD','INTC',
  'MU','SNDK','WDC','AVGO','QCOM','TXN','ORCL','CRM','ADBE','PYPL',
  'SQ','SHOP','UBER','LYFT','ABNB','COIN','HOOD','PLTR','SNOW','DDOG',
  'CRWD','ZS','NET','MDB','OKTA','TWLO',
  'SPY','QQQ','SPXC','IWM','DIA','VOO','VTI','ARKK','SOXX',
  'XLK','XLF','XLE','XLV','XLI','XLP','XLU','XLB','XLRE',
  'US500','US30','US100','NAS100','SPX500','DJI30','UK100',
  'GER40','JP225','HK50',
  'XAU','XAG','GOLD','SILVER','PLATINUM','PALLADIUM',
  'XPT','XPD','XAUT','PAXG',
  'EUR','USD','GBP','JPY','CHF','AUD','NZD','CAD',
  'WTI','BRENT','NATGAS','COPPER','CORN','WHEAT','SOYBEAN'
]);

function isRwaOrInvalid(baseCoin) {
  if (!baseCoin) return true;
  const b = String(baseCoin).toUpperCase();
  if (b.length < 2 || b.length > 7) return true;
  if (RWA_BLACKLIST.has(b)) return true;
  return false;
}

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: Date.now(),
  symbols: new Map(),
  validSymbols: new Set(),
  targetList: [],
  trends: new Map(),
  signals: new Map(),
  wsBitget: null,
  wsConnected: false,
  wsSubscriptions: [],
  pingTimer: null,
  market: {
    trend: 'UNKNOWN',
    btcPrice: 0,
    btcEma: 0,
    btcChange4h: 0,
    updatedAt: 0
  },
  stats: {
    totalCoins: 0,
    rwaCount: 0,
    filteredCoins: 0,
    scans: 0,
    signals: 0,
    lastScan: null,
    wsTickerMsgs: 0
  }
};

let reconnectAttempts = 0;

// ============================================================
// HELPERS
// ============================================================

function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function pct(a, b) { if (!b) return 0; return ((a - b) / b) * 100; }
function absPct(a, b) { return Math.abs(pct(a, b)); }
function now() { return Date.now(); }
function normalizeSym(s) { return String(s || '').replace(/[^A-Z0-9]/g, ''); }

function getSym(symbol) {
  if (!state.symbols.has(symbol)) {
    state.symbols.set(symbol, {
      symbol,
      price: 0, bid: 0, ask: 0, bidSize: 0, askSize: 0,
      turnover24h: 0, volume24h: 0,
      oi: 0, prevOi: 0, oiUpdatedAt: 0,
      h1: [], h2: [],
      priceHistory: [], flowHistory: []
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
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== '00000') throw new Error(j.code + ' ' + (j.msg || ''));
  return j;
}

// ============================================================
// BTC PİYASA YÖNÜ
// ============================================================

async function updateMarketTrend() {
  try {
    const json = await rest('/api/v3/market/candles', {
      category: 'USDT-FUTURES',
      symbol: 'BTCUSDT',
      interval: '1H',
      limit: 250
    });

    const rows = Array.isArray(json.data) ? json.data : [];
    const closes = rows.map(r => num(r[4])).filter(c => c > 0);

    if (closes.length < CFG.BTC_EMA_PERIOD + 10) {
      state.market.trend = 'UNKNOWN';
      return;
    }

    const ema = calculateEMA(closes, CFG.BTC_EMA_PERIOD);
    const btcPrice = closes[closes.length - 1];
    const idx4h = Math.max(0, closes.length - 5);
    const price4hAgo = closes[idx4h];
    const change4h = price4hAgo > 0 ? ((btcPrice - price4hAgo) / price4hAgo) * 100 : 0;

    let trend = 'SIDEWAYS';
    const priceAboveEma = btcPrice > ema;
    const emaDistancePct = Math.abs(pct(btcPrice, ema));

    if (priceAboveEma && change4h > 0.5) trend = 'UP';
    else if (!priceAboveEma && change4h < -0.5) trend = 'DOWN';
    else if (priceAboveEma && change4h < -1.0) trend = 'SIDEWAYS';
    else if (!priceAboveEma && change4h > 1.0) trend = 'SIDEWAYS';
    else if (emaDistancePct < 0.5) trend = 'SIDEWAYS';

    state.market = { trend, btcPrice, btcEma: ema, btcChange4h: change4h, updatedAt: now() };

    const trendText = trend === 'UP' ? 'YÜKSELİŞ' : trend === 'DOWN' ? 'DÜŞÜŞ' : 'YATAY';
    console.log('📊 Piyasa: ' + trendText + ' (BTC ' + btcPrice.toFixed(0) + ', 4h ' + change4h.toFixed(2) + '%)');
  } catch (e) {
    console.error('Market trend error:', e.message);
  }
}

function calculateEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * k + ema;
  }
  return ema;
}

// ============================================================
// MARKET YÜKLE
// ============================================================

async function loadMarkets() {
  try {
    const json = await rest('/api/v2/mix/market/contracts', { productType: PRODUCT });
    const contracts = Array.isArray(json.data) ? json.data : [];
    let count = 0;
    let rwaCount = 0;

    state.validSymbols = new Set();

    for (const c of contracts) {
      const s = normalizeSym(c.symbol);
      if (!s) continue;
      if (c.symbolType === 'delivery') continue;
      if (String(c.quoteCoin).toUpperCase() !== 'USDT') continue;

      const base = String(c.baseCoin || '').toUpperCase();
      if (isRwaOrInvalid(base)) { rwaCount++; continue; }

      state.validSymbols.add(s);
      getSym(s);
      count++;
    }

    state.stats.totalCoins = count;
    state.stats.rwaCount = rwaCount;
    console.log('Kripto perpetual: ' + count + ' coin (RWA elenen: ' + rwaCount + ')');
  } catch (e) {
    console.error('Market load error:', e.message);
  }
}

// ============================================================
// PRESCAN
// ============================================================

async function runPreScan() {
  console.log('\n--- ÖN TARAMA BAŞLADI ---');
  try {
    const json = await rest('/api/v2/mix/market/tickers', { productType: PRODUCT });
    const rows = Array.isArray(json.data) ? json.data : [];

    const filtered = [];
    let rwaSkipped = 0;
    let volumeSkipped = 0;

    for (const r of rows) {
      const s = normalizeSym(r.symbol);
      if (!s) continue;
      if (!state.validSymbols || !state.validSymbols.has(s)) { rwaSkipped++; continue; }

      const turn = num(r.quoteVolume || r.usdtVolume);
      const price = num(r.lastPr || r.lastPrice);

      if (!price || price <= 0) { volumeSkipped++; continue; }
      if (turn < CFG.MIN_24H_VOLUME_USDT) { volumeSkipped++; continue; }

      const sym = getSym(s);
      sym.price = price;
      sym.turnover24h = turn;
      filtered.push({ symbol: s, turnover: turn });
    }

    filtered.sort((a, b) => b.turnover - a.turnover);
    const list = filtered.slice(0, CFG.MAX_COINS).map(x => x.symbol);

    state.targetList = list;
    state.stats.filteredCoins = list.length;

    console.log('Ön tarama: ' + filtered.length + ' coin geçti (' +
      rwaSkipped + ' RWA, ' + volumeSkipped + ' düşük hacim), ' +
      list.length + ' takipte.');

    await loadHistoricalCandles();
    subscribeWS();
  } catch (e) {
    console.error('PreScan error:', e.message);
  }
}

// ============================================================
// 2H MUM VERİSİ
// ============================================================

async function loadHistoricalCandles() {
  console.log('2H mum verisi çekiliyor...');
  let count = 0;

  for (const symbol of state.targetList) {
    try {
      const json = await rest('/api/v3/market/candles', {
        category: 'USDT-FUTURES',
        symbol,
        interval: '1H',
        limit: 150
      });
      const rows = Array.isArray(json.data) ? json.data : [];
      const candles = rows.map(r => ({
        ts: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]),
        close: num(r[4]), volume: num(r[5]), turnover: num(r[6])
      })).filter(c => c.close > 0).sort((a, b) => a.ts - b.ts);

      const sym = getSym(symbol);
      sym.h1 = candles;
      aggregate2H(symbol);
      count++;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 40));
  }

  console.log('Mum verisi hazır: ' + count + '/' + state.targetList.length);

  for (const symbol of state.targetList) {
    try { detectTrends(symbol); } catch (e) {}
  }
}

function aggregate2H(symbol) {
  const sym = getSym(symbol);
  const h1 = sym.h1;
  if (h1.length < 10) { sym.h2 = []; return; }

  const buckets = new Map();
  for (const c of h1) {
    const b = Math.floor(c.ts / (2 * 60 * 60 * 1000));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(c);
  }

  const out = [];
  for (const [b, rows] of buckets) {
    rows.sort((a, c) => a.ts - c.ts);
    if (!rows.length) continue;
    out.push({
      ts: b * 2 * 60 * 60 * 1000,
      open: rows[0].open,
      high: Math.max.apply(null, rows.map(x => x.high)),
      low: Math.min.apply(null, rows.map(x => x.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((a, x) => a + x.volume, 0),
      turnover: rows.reduce((a, x) => a + x.turnover, 0)
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  sym.h2 = out;
}

// ============================================================
// PIVOT + REGRESYON
// ============================================================

function findPivotHighs(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let ok = true;
    for (let x = 1; x <= left; x++) {
      if (!candles[i - x] || candles[i - x].high >= c.high) { ok = false; break; }
    }
    if (ok) for (let x = 1; x <= right; x++) {
      if (!candles[i + x] || candles[i + x].high > c.high) { ok = false; break; }
    }
    if (ok) pivots.push({ index: i, price: c.high });
  }
  return pivots;
}

function findPivotLows(candles, left, right) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let ok = true;
    for (let x = 1; x <= left; x++) {
      if (!candles[i - x] || candles[i - x].low <= c.low) { ok = false; break; }
    }
    if (ok) for (let x = 1; x <= right; x++) {
      if (!candles[i + x] || candles[i + x].low < c.low) { ok = false; break; }
    }
    if (ok) pivots.push({ index: i, price: c.low });
  }
  return pivots;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x; }
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return null;
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  const my = sy / n;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const py = a * p.x + b;
    ssRes += Math.pow(p.y - py, 2);
    ssTot += Math.pow(p.y - my, 2);
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { a, b, r2, n };
}

// ============================================================
// TREND ÇİZGİSİ
// ============================================================

function detectTrends(symbol) {
  const sym = getSym(symbol);
  const candles = sym.h2;
  if (!candles || candles.length < CFG.TREND_LOOKBACK) {
    state.trends.set(symbol, { up: null, down: null });
    return;
  }

  const recent = candles.slice(-CFG.TREND_LOOKBACK);
  const lastIdx = recent.length - 1;

  const highs = findPivotHighs(recent, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT);
  let down = null;
  if (highs.length >= CFG.MIN_PIVOTS) {
    const latest = highs.slice(-Math.min(highs.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.MIN_R2 && reg.a < 0) {
      down = {
        slope: reg.a, intercept: reg.b, r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * lastIdx + reg.b,
        pivots: latest,
        linePoints: recent.map((c, i) => ({ time: c.ts, value: reg.a * i + reg.b }))
      };
    }
  }

  const lows = findPivotLows(recent, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT);
  let up = null;
  if (lows.length >= CFG.MIN_PIVOTS) {
    const latest = lows.slice(-Math.min(lows.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.MIN_R2 && reg.a > 0) {
      up = {
        slope: reg.a, intercept: reg.b, r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * lastIdx + reg.b,
        pivots: latest,
        linePoints: recent.map((c, i) => ({ time: c.ts, value: reg.a * i + reg.b }))
      };
    }
  }

  state.trends.set(symbol, { up, down });
}

// ============================================================
// YAKLAŞMA
// ============================================================

function checkApproach(symbol) {
  const sym = getSym(symbol);
  const tr = state.trends.get(symbol);
  if (!tr || !sym.price || !sym.h2.length) return null;

  const price = sym.price;
  const candidates = [];

  if (tr.down) {
    const line = tr.down.currentValue;
    const dist = absPct(price, line);
    if (dist <= CFG.WATCH_DISTANCE_PCT) {
      candidates.push({
        direction: 'LONG', trendType: 'DOWN',
        lineValue: line, distancePct: dist,
        r2: tr.down.r2, pivotCount: tr.down.pivotCount,
        pivots: tr.down.pivots, broken: price > line,
        linePoints: tr.down.linePoints
      });
    }
  }

  if (tr.up) {
    const line = tr.up.currentValue;
    const dist = absPct(price, line);
    if (dist <= CFG.WATCH_DISTANCE_PCT) {
      candidates.push({
        direction: 'SHORT', trendType: 'UP',
        lineValue: line, distancePct: dist,
        r2: tr.up.r2, pivotCount: tr.up.pivotCount,
        pivots: tr.up.pivots, broken: price < line,
        linePoints: tr.up.linePoints
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distancePct - b.distancePct);
  return candidates[0];
}

// ============================================================
// TP / SL
// ============================================================

function calcTradeLevels(symbol, info) {
  const sym = getSym(symbol);
  const candles = sym.h2;
  if (!candles || candles.length < 20) return null;

  const price = sym.price;
  const dir = info.direction;
  const buffer = CFG.STOP_BUFFER_PCT / 100;

  const wider = candles.slice(-60);
  const allHighs = findPivotHighs(wider, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT).map(p => p.price).sort((a, b) => b - a);
  const allLows = findPivotLows(wider, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT).map(p => p.price).sort((a, b) => a - b);

  let entry, stop, tp1, tp2;

  if (dir === 'LONG') {
    entry = info.lineValue * (1 + 0.0005);
    const lowsBelow = allLows.filter(l => l < price);
    const nearestSupport = lowsBelow.length ? lowsBelow[lowsBelow.length - 1] : price * 0.98;
    stop = nearestSupport * (1 - buffer);

    const highsAbove = allHighs.filter(h => h > entry).sort((a, b) => a - b);
    if (highsAbove.length >= 1) tp1 = highsAbove[0];
    else tp1 = entry + (entry - stop) * 1.5;
    if (highsAbove.length >= 2) tp2 = highsAbove[1];
    else tp2 = entry + (entry - stop) * 2.5;
  } else {
    entry = info.lineValue * (1 - 0.0005);
    const highsAbove = allHighs.filter(h => h > price).sort((a, b) => a - b);
    const nearestResistance = highsAbove.length ? highsAbove[0] : price * 1.02;
    stop = nearestResistance * (1 + buffer);

    const lowsBelow = allLows.filter(l => l < entry).sort((a, b) => b - a);
    if (lowsBelow.length >= 1) tp1 = lowsBelow[0];
    else tp1 = entry - (stop - entry) * 1.5;
    if (lowsBelow.length >= 2) tp2 = lowsBelow[1];
    else tp2 = entry - (stop - entry) * 2.5;
  }

  const risk = Math.abs(entry - stop);
  const reward1 = Math.abs(tp1 - entry);
  const reward2 = Math.abs(tp2 - entry);
  const rr1 = risk > 0 ? reward1 / risk : 0;
  const rr2 = risk > 0 ? reward2 / risk : 0;

  if (rr1 < CFG.MIN_RR_RATIO) return null;

  return {
    entry, stop, tp1, tp2,
    rr1: Number(rr1.toFixed(2)),
    rr2: Number(rr2.toFixed(2)),
    entryPct: Number(absPct(entry, price).toFixed(2)),
    stopPct: Number(absPct(stop, price).toFixed(2)),
    tp1Pct: Number(absPct(tp1, price).toFixed(2)),
    tp2Pct: Number(absPct(tp2, price).toFixed(2))
  };
}

// ============================================================
// METRİKLER
// ============================================================

function calcVolumeRatio(symbol) {
  const sym = getSym(symbol);
  const c = sym.h2;
  if (!c || c.length < 21) return 1;
  const last = c[c.length - 1];
  const prev = c.slice(-21, -1);
  const avg = prev.reduce((s, x) => s + x.turnover, 0) / prev.length;
  if (!avg) return 1;
  return last.turnover / avg;
}

function priceMomentum(symbol) {
  const sym = getSym(symbol);
  const h = sym.priceHistory;
  if (h.length < 10) return 0;
  const cur = h[h.length - 1];
  const old = h.find(x => cur.ts - x.ts >= 60 * 1000) || h[0];
  if (!old.price) return 0;
  return pct(cur.price, old.price);
}

function oiChange(symbol) {
  const sym = getSym(symbol);
  if (!sym.prevOi || !sym.oi) return 0;
  return pct(sym.oi, sym.prevOi);
}

function orderbookFlow(symbol) {
  const sym = getSym(symbol);
  if (!sym.bidSize && !sym.askSize) return 0.5;
  const t = sym.bidSize + sym.askSize;
  if (!t) return 0.5;
  return sym.bidSize / t;
}

function flowScore(symbol) {
  const sym = getSym(symbol);
  const direct = orderbookFlow(symbol);
  if (!sym.flowHistory.length) return direct;
  const recent = sym.flowHistory.slice(-20);
  const avg = recent.reduce((a, x) => a + x.flow, 0) / recent.length;
  return clamp(avg * 0.65 + direct * 0.35, 0, 1);
}

// ============================================================
// SKOR + DURUM
// ============================================================

function calcScore(symbol, info) {
  const vr = calcVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);
  const dir = info.direction;

  let score = 0;

  if (info.r2 >= 0.85) score += 25;
  else if (info.r2 >= 0.75) score += 18;
  else if (info.r2 >= 0.70) score += 12;

  if (info.pivotCount >= 5) score += 10;
  else if (info.pivotCount >= 4) score += 6;
  else if (info.pivotCount >= 3) score += 3;

  if (info.distancePct <= CFG.ENTRY_DISTANCE_PCT) score += 30;
  else if (info.distancePct <= CFG.IGNITION_DISTANCE_PCT) score += 22;
  else if (info.distancePct <= CFG.NEAR_DISTANCE_PCT) score += 14;
  else if (info.distancePct <= CFG.WATCH_DISTANCE_PCT) score += 8;

  if (vr >= 1.9) score += 15;
  else if (vr >= 1.5) score += 12;
  else if (vr >= 1.2) score += 8;

  if (oi >= 0.15) score += 10;
  else if (oi >= 0.08) score += 7;
  else if (oi >= 0.03) score += 4;

  const flowDir = dir === 'LONG' ? flow : 1 - flow;
  if (flowDir >= 0.63) score += 5;
  else if (flowDir >= 0.54) score += 3;

  const momDir = (dir === 'LONG' && mom > 0) || (dir === 'SHORT' && mom < 0);
  if (momDir && Math.abs(mom) >= 0.15) score += 5;

  if (info.broken) score += 5;

  const marketTrend = state.market.trend;
  const aligned = (dir === 'LONG' && marketTrend === 'UP') || (dir === 'SHORT' && marketTrend === 'DOWN');
  const against = (dir === 'LONG' && marketTrend === 'DOWN') || (dir === 'SHORT' && marketTrend === 'UP');

  if (aligned) score += 10;
  else if (against) score -= 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function determineState(info, score) {
  if (info.broken) return 'KIRILDI';
  if (score >= 80 || info.distancePct <= CFG.ENTRY_DISTANCE_PCT) return 'GİRİŞ FIRSATI';
  if (score >= 65 || info.distancePct <= CFG.IGNITION_DISTANCE_PCT) return 'HAREKET BAŞLADI';
  if (score >= 50 || info.distancePct <= CFG.NEAR_DISTANCE_PCT) return 'YAKLAŞIYOR';
  return 'İZLE';
}

// ============================================================
// HİKAYE
// ============================================================

function buildStory(symbol, info, score) {
  const sym = getSym(symbol);
  const stateName = determineState(info, score);
  const vr = calcVolumeRatio(symbol);
  const flow = flowScore(symbol);

  const coinName = symbol.replace('USDT', '');
  const lineText = info.trendType === 'DOWN' ? 'düşen bir çizgiye' : 'yükselen bir çizgiye';
  const marketTrend = state.market.trend;

  let marketWarning = '';
  const aligned = (info.direction === 'LONG' && marketTrend === 'UP') || (info.direction === 'SHORT' && marketTrend === 'DOWN');
  const against = (info.direction === 'LONG' && marketTrend === 'DOWN') || (info.direction === 'SHORT' && marketTrend === 'UP');

  if (aligned) marketWarning = ' Piyasa yönü bu sinyalle uyumlu — güvenli.';
  else if (against) marketWarning = ' ⚠️ Piyasa ters yönde — dikkatli ol.';

  let durum = '';
  if (stateName === 'KIRILDI') durum = coinName + ' ' + lineText + ' yaklaştı ve kırdı.';
  else if (stateName === 'GİRİŞ FIRSATI') durum = coinName + ' ' + lineText + ' çok yakın. Kırılım an meselesi.';
  else if (stateName === 'HAREKET BAŞLADI') durum = coinName + ' ' + lineText + ' yaklaşıyor. Hareket başlamak üzere.';
  else if (stateName === 'YAKLAŞIYOR') durum = coinName + ' ' + lineText + ' yaklaşıyor. Fiyat %' + info.distancePct.toFixed(2) + ' mesafede.';
  else durum = coinName + ' ' + lineText + ' doğru ilerliyor.';

  let trendKalite = '';
  if (info.r2 >= 0.85 && info.pivotCount >= 5) trendKalite = 'Çizgi çok güçlü — ' + info.pivotCount + ' kez test edilmiş.';
  else if (info.r2 >= 0.75) trendKalite = 'Çizgi güvenilir — ' + info.pivotCount + ' kez test edilmiş.';
  else trendKalite = 'Çizgi orta güçte — ' + info.pivotCount + ' kez test edilmiş.';

  let hacimYorum = '';
  if (vr >= 1.9) hacimYorum = 'Hacim ' + vr.toFixed(1) + 'x — büyük alıcılar içeride.';
  else if (vr >= 1.5) hacimYorum = 'Hacim ' + vr.toFixed(1) + 'x — hareket destekleniyor.';
  else if (vr >= 1.2) hacimYorum = 'Hacim normal (' + vr.toFixed(1) + 'x).';
  else hacimYorum = 'Hacim düşük (' + vr.toFixed(1) + 'x) — yalancı kırılım olabilir.';

  let dengeYorum = '';
  const relevantFlow = info.direction === 'LONG' ? flow : 1 - flow;
  if (relevantFlow >= 0.65) dengeYorum = 'Orderbook\'ta ' + (info.direction === 'LONG' ? 'alıcılar' : 'satıcılar') + ' çok baskın (%' + (relevantFlow * 100).toFixed(0) + ').';
  else if (relevantFlow >= 0.55) dengeYorum = 'Orderbook\'ta ' + (info.direction === 'LONG' ? 'alıcılar' : 'satıcılar') + ' hafif baskın (%' + (relevantFlow * 100).toFixed(0) + ').';
  else dengeYorum = 'Orderbook dengeli (%' + (relevantFlow * 100).toFixed(0) + ').';

  let sonuc = '';
  if (stateName === 'KIRILDI') sonuc = '🎯 Kırılım gerçekleşti.';
  else if (stateName === 'GİRİŞ FIRSATI') sonuc = '🚨 Kırılım çok yakın. Hazır ol.';
  else if (stateName === 'HAREKET BAŞLADI') sonuc = '⚡ Yakından takip et.';
  else if (stateName === 'YAKLAŞIYOR') sonuc = '👀 Radara aldık.';
  else sonuc = '⏳ Henüz erken.';

  return { story: durum + marketWarning + ' ' + trendKalite + ' ' + hacimYorum + ' ' + dengeYorum, summary: sonuc };
}

// ============================================================
// SİNYAL ÜRET
// ============================================================

function buildSignal(symbol, info) {
  const sym = getSym(symbol);
  const score = calcScore(symbol, info);
  const stateName = determineState(info, score);

  const levels = calcTradeLevels(symbol, info);
  if (!levels) return null;

  const { story, summary } = buildStory(symbol, info, score);

  return {
    symbol, direction: info.direction, state: stateName, score,
    price: sym.price, lineValue: info.lineValue, distancePct: info.distancePct,
    entry: levels.entry, stop: levels.stop, tp1: levels.tp1, tp2: levels.tp2,
    rr1: levels.rr1, rr2: levels.rr2,
    entryPct: levels.entryPct, stopPct: levels.stopPct,
    tp1Pct: levels.tp1Pct, tp2Pct: levels.tp2Pct,
    story, summary,
    marketAligned: (info.direction === 'LONG' && state.market.trend === 'UP') || (info.direction === 'SHORT' && state.market.trend === 'DOWN'),
    marketAgainst: (info.direction === 'LONG' && state.market.trend === 'DOWN') || (info.direction === 'SHORT' && state.market.trend === 'UP'),
    timestamp: now(),
    timeStr: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  };
}

// ============================================================
// SCAN
// ============================================================

function runScan() {
  if (!state.targetList.length) return;
  state.stats.scans++;
  state.stats.lastScan = now();

  const newSignals = [];
  for (const symbol of state.targetList) {
    try {
      const info = checkApproach(symbol);
      if (!info) continue;
      const sig = buildSignal(symbol, info);
      if (!sig) continue;
      newSignals.push(sig);
    } catch (e) {}
  }

  const order = { 'KIRILDI': 5, 'GİRİŞ FIRSATI': 4, 'HAREKET BAŞLADI': 3, 'YAKLAŞIYOR': 2, 'İZLE': 1 };
  newSignals.sort((a, b) => {
    const oa = order[a.state] || 0;
    const ob = order[b.state] || 0;
    if (oa !== ob) return ob - oa;
    return a.distancePct - b.distancePct;
  });

  state.signals.clear();
  for (const s of newSignals) state.signals.set(s.symbol + '-' + s.direction, s);
  state.stats.signals = state.signals.size;
  broadcast();
}

// ============================================================
// BITGET WEBSOCKET (v2 protokol)
// ============================================================

function connectBitgetWS() {
  if (state.wsBitget) { try { state.wsBitget.close(); } catch (e) {} }
  if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }

  const ws = new WebSocket(BITGET_WS);
  state.wsBitget = ws;

  ws.on('open', () => {
    console.log('Bitget WebSocket bağlandı.');
    state.wsConnected = true;
    reconnectAttempts = 0;
    subscribeWS();

    // v2 protokolü: JSON ping
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ op: 'ping' })); } catch (e) {}
      }
    }, CFG.WS_PING_MS);
  });

  ws.on('message', raw => {
    try {
      const txt = raw.toString();

      // Düz metin pong
      if (txt === 'pong' || txt === 'ping') return;

      const msg = JSON.parse(txt);

      // v2 protokolü: pong yanıtı
      if (msg.op === 'pong' || msg.event === 'pong') return;
      if (msg.event === 'subscribe') return;
      if (msg.event === 'error') {
        console.warn('Bitget WS error msg:', msg);
        return;
      }

      if (!msg.data || !msg.arg) return;
      if (msg.arg.channel === 'ticker') processTicker(msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Bitget WebSocket kapandı.');
    state.wsConnected = false;
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 60000);
    reconnectAttempts++;
    setTimeout(connectBitgetWS, delay);
  });

  ws.on('error', err => console.error('WS error:', err.message));
}

function subscribeWS() {
  if (!state.wsBitget || state.wsBitget.readyState !== WebSocket.OPEN) return;
  if (!state.targetList.length) return;

  // Eski abonelikleri iptal et (sadece gerçekten varsa)
  if (state.wsSubscriptions.length > 0) {
    try {
      const flat = [];
      for (const b of state.wsSubscriptions) for (const a of b) flat.push(a);
      if (flat.length) state.wsBitget.send(JSON.stringify({ op: 'unsubscribe', args: flat }));
    } catch (e) {}
  }

  const args = state.targetList.map(s => ({ instType: 'USDT-FUTURES', channel: 'ticker', instId: s }));
  const batches = [];
  for (let i = 0; i < args.length; i += CFG.WS_BATCH) {
    batches.push(args.slice(i, i + CFG.WS_BATCH));
  }

  state.wsSubscriptions = batches;
  for (const batch of batches) {
    try { state.wsBitget.send(JSON.stringify({ op: 'subscribe', args: batch })); } catch (e) {}
  }

  console.log('WS abonelikleri: ' + args.length + ' kanal / ' + batches.length + ' paket');
}

function processTicker(msg) {
  const rows = Array.isArray(msg.data) ? msg.data : [];
  state.stats.wsTickerMsgs += rows.length;

  for (const row of rows) {
    const symbol = normalizeSym(row.instId || row.symbol);
    if (!symbol) continue;
    const sym = state.symbols.get(symbol);
    if (!sym) continue;

    const price = num(row.lastPr || row.lastPrice);
    if (!price) continue;

    sym.price = price;
    sym.bid = num(row.bidPr || row.bid1Price);
    sym.ask = num(row.askPr || row.ask1Price);
    sym.bidSize = num(row.bidSz || row.bid1Size);
    sym.askSize = num(row.askSz || row.ask1Size);
    sym.turnover24h = num(row.quoteVolume || row.turnover24h);

    const newOI = num(row.holdingAmount || row.openInterest);
    if (newOI > 0) {
      if (sym.oi > 0) sym.prevOi = sym.oi;
      sym.oi = newOI;
      sym.oiUpdatedAt = now();
    }

    sym.priceHistory.push({ ts: now(), price });
    const cut = now() - 10 * 60 * 1000;
    sym.priceHistory = sym.priceHistory.filter(x => x.ts >= cut);

    const flow = orderbookFlow(symbol);
    sym.flowHistory.push({ ts: now(), flow });
    sym.flowHistory = sym.flowHistory.filter(x => x.ts >= cut);
  }
}

// ============================================================
// CLIENT WEBSOCKET
// ============================================================

function getSnapshot() {
  const signals = Array.from(state.signals.values());
  return {
    signals,
    market: state.market,
    stats: {
      total: signals.length,
      kirildi: signals.filter(s => s.state === 'KIRILDI').length,
      giris: signals.filter(s => s.state === 'GİRİŞ FIRSATI').length,
      hareket: signals.filter(s => s.state === 'HAREKET BAŞLADI').length,
      yaklasiyor: signals.filter(s => s.state === 'YAKLAŞIYOR').length,
      totalCoins: state.stats.totalCoins,
      filteredCoins: state.stats.filteredCoins,
      scans: state.stats.scans,
      wsConnected: state.wsConnected
    },
    updatedAt: now()
  };
}

function broadcast() {
  const payload = JSON.stringify({ type: 'snapshot', data: getSnapshot() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(payload); } catch (e) {}
    }
  });
}

wss.on('connection', ws => {
  ws.on('error', err => console.warn('WSS client error:', err.message));
  try { ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() })); } catch (e) {}
});

// ============================================================
// API
// ============================================================

app.get('/api/chart', async (req, res) => {
  try {
    const symbol = normalizeSym(req.query.symbol);
    if (!symbol) return res.json({ ok: false, error: 'symbol required' });

    const sym = state.symbols.get(symbol);
    if (!sym || !sym.h2.length) return res.json({ ok: false, error: 'no candle data' });

    const tr = state.trends.get(symbol) || { up: null, down: null };
    const sig = Array.from(state.signals.values()).find(s => s.symbol === symbol) || null;

    const candles = sym.h2.slice(-CFG.CHART_CANDLES).map(c => ({
      time: Math.floor(c.ts / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close
    }));

    const firstTs = sym.h2.slice(-CFG.CHART_CANDLES)[0]?.ts || 0;
    const lineUp = tr.up ? tr.up.linePoints.filter(p => p.time >= firstTs).map(p => ({
      time: Math.floor(p.time / 1000), value: p.value
    })) : [];
    const lineDown = tr.down ? tr.down.linePoints.filter(p => p.time >= firstTs).map(p => ({
      time: Math.floor(p.time / 1000), value: p.value
    })) : [];

    res.json({
      ok: true, symbol, price: sym.price, candles,
      trendUp: lineUp, trendDown: lineDown, signal: sig
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true, uptime: now() - state.startedAt,
    wsConnected: state.wsConnected,
    market: state.market,
    totalCoins: state.stats.totalCoins,
    filteredCoins: state.stats.filteredCoins,
    scans: state.stats.scans,
    signals: state.stats.signals
  });
});

// ============================================================
// HTML
// ============================================================

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sonny AI Trend Radar</title>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0b0e13;color:#dbe4ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:13px}
.app{display:grid;grid-template-columns:320px 1fr;height:100vh}

.market-banner{padding:10px 16px;font-size:13px;font-weight:800;letter-spacing:0.5px;text-align:center;border-bottom:2px solid transparent;flex-shrink:0}
.market-up{background:linear-gradient(90deg,#052e16 0%,#0a4d24 50%,#052e16 100%);color:#13dba0;border-bottom-color:#13dba0}
.market-down{background:linear-gradient(90deg,#450a0a 0%,#7f1d1d 50%,#450a0a 100%);color:#f87171;border-bottom-color:#f87171}
.market-sideways{background:linear-gradient(90deg,#1e293b 0%,#334155 50%,#1e293b 100%);color:#fbbf24;border-bottom-color:#fbbf24}
.market-unknown{background:#1e293b;color:#94a3b8}
.market-banner .sub{font-size:10px;font-weight:600;opacity:0.8;margin-top:2px}

.panel{background:#0f141b;border-right:1px solid #1c2530;display:flex;flex-direction:column;overflow:hidden}
.hdr{padding:12px 16px;border-bottom:1px solid #1c2530;flex-shrink:0}
.hdr h1{font-size:13px;font-weight:800;color:#13dba0}
.hdr .sub{font-size:9px;color:#5a6b7d;margin-top:3px}
.stats{display:flex;gap:5px;padding:8px 12px;border-bottom:1px solid #1c2530;flex-shrink:0}
.stat{flex:1;background:#131a24;border-radius:5px;padding:5px 4px;text-align:center}
.stat .n{display:block;font-size:14px;font-weight:800;color:#13dba0;line-height:1.1}
.stat .l{font-size:7.5px;color:#5a6b7d;text-transform:uppercase;letter-spacing:0.5px}
.stat.fire .n{color:#fbbf24}
.stat.entry .n{color:#f87171}
.filters{display:flex;gap:4px;padding:7px 12px;border-bottom:1px solid #1c2530;flex-shrink:0;flex-wrap:wrap}
.fbtn{padding:3px 8px;background:#131a24;border:1px solid #1c2530;border-radius:4px;color:#6b7c8f;font-size:8.5px;font-weight:600;cursor:pointer;text-transform:uppercase}
.fbtn:hover{background:#1a2432;color:#dbe4ee}
.fbtn.active{background:#13dba0;color:#0b0e13;border-color:#13dba0}
.list{flex:1;overflow-y:auto;padding:6px}
.list::-webkit-scrollbar{width:5px}
.list::-webkit-scrollbar-thumb{background:#1c2530;border-radius:3px}
.card{background:#131a24;border:1px solid #1c2530;border-left:3px solid #1c2530;border-radius:5px;padding:8px 10px;margin-bottom:4px;cursor:pointer;transition:all .12s}
.card:hover{background:#1a2432}
.card.selected{border-color:#13dba0;background:#152029;box-shadow:0 0 0 1px #13dba0 inset}
.card.long{border-left-color:#13dba0}
.card.short{border-left-color:#f87171}
.card.against{opacity:0.6}
.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.sym{font-size:12px;font-weight:800;color:#e5eaf0}
.dir{font-size:8.5px;font-weight:800;padding:2px 6px;border-radius:3px}
.dir.long{background:#0d3d2a;color:#13dba0}
.dir.short{background:#421d28;color:#f87171}
.row2{display:flex;gap:5px;align-items:center;font-size:10px;color:#7a8b9e;flex-wrap:wrap}
.badge{font-size:8px;font-weight:800;padding:2px 6px;border-radius:3px}
.b-kirildi{background:#22c55e;color:#052e16}
.b-giris{background:#f87171;color:#450a0a}
.b-hareket{background:#fb923c;color:#431407}
.b-yaklasiyor{background:#fbbf24;color:#451a03}
.b-izle{background:#3b82f6;color:#082f49}
.warn{color:#fbbf24;font-weight:700;font-size:9px}
.empty{padding:40px 20px;text-align:center;color:#4a5a6b;font-size:11px}
.main{display:flex;flex-direction:column;background:#0b0e13;overflow:hidden}
.main-hdr{padding:10px 16px;border-bottom:1px solid #1c2530;flex-shrink:0;background:#0f141b}
.main-hdr h2{font-size:14px;font-weight:800;color:#e5eaf0}
.main-hdr .sub{font-size:10px;color:#5a6b7d;margin-top:2px}
.chart-wrap{flex:1;position:relative;min-height:0}
#chart{position:absolute;inset:0}
.trade-panel{background:#0f141b;border-top:1px solid #1c2530;padding:12px 16px;flex-shrink:0}
.trade-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:10px}
.trade-cell{background:#131a24;border-radius:5px;padding:7px 9px;text-align:center}
.trade-cell .k{font-size:8.5px;color:#5a6b7d;text-transform:uppercase;margin-bottom:3px}
.trade-cell .v{font-size:13px;font-weight:800;font-family:monospace}
.trade-cell .pct{font-size:9px;color:#5a6b7d;margin-top:2px}
.v-entry{color:#60a5fa}
.v-stop{color:#f87171}
.v-tp1{color:#13dba0}
.v-tp2{color:#13dba0}
.v-rr{color:#fbbf24}
.story-text{font-size:12px;color:#c9d4e0;line-height:1.6;max-width:1100px}
.story-summary{font-size:13px;font-weight:700;color:#fbbf24;margin-top:6px}
.conn{position:fixed;top:8px;right:12px;padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;z-index:100}
.conn.on{background:#0d3d2a;color:#13dba0}
.conn.off{background:#421d28;color:#f87171}
</style>
</head>
<body>
<div class="conn off" id="conn">● BAĞLANIYOR</div>

<div class="market-banner market-unknown" id="marketBanner">
  📊 PİYASA DURUMU YÜKLENİYOR...
  <div class="sub" id="marketSub">BTC verisi bekleniyor</div>
</div>

<div class="app" style="height:calc(100vh - 44px)">
  <div class="panel">
    <div class="hdr">
      <h1>📐 TREND YAKLAŞMA RADARI</h1>
      <div class="sub">2H eğimli trend çizgisi · BTC piyasa filtresi</div>
    </div>
    <div class="stats">
      <div class="stat fire"><span class="n" id="s-kirildi">0</span><span class="l">Kırıldı</span></div>
      <div class="stat entry"><span class="n" id="s-giris">0</span><span class="l">Giriş</span></div>
      <div class="stat"><span class="n" id="s-hareket">0</span><span class="l">Hareket</span></div>
      <div class="stat"><span class="n" id="s-yaklasiyor">0</span><span class="l">Yaklaşan</span></div>
    </div>
    <div class="filters">
      <div class="fbtn active" data-f="all">Tümü</div>
      <div class="fbtn" data-f="KIRILDI">Kırıldı</div>
      <div class="fbtn" data-f="GİRİŞ FIRSATI">Giriş</div>
      <div class="fbtn" data-f="HAREKET BAŞLADI">Hareket</div>
      <div class="fbtn" data-f="LONG">LONG</div>
      <div class="fbtn" data-f="SHORT">SHORT</div>
    </div>
    <div class="list" id="list"><div class="empty">Taranıyor...</div></div>
  </div>
  <div class="main">
    <div class="main-hdr">
      <h2 id="title">Sinyal seçin</h2>
      <div class="sub" id="subtitle">Soldan bir sinyale tıklayın</div>
    </div>
    <div class="chart-wrap"><div id="chart"></div></div>
    <div class="trade-panel">
      <div class="trade-grid">
        <div class="trade-cell"><div class="k">Giriş</div><div class="v v-entry" id="v-entry">-</div><div class="pct" id="v-entry-pct"></div></div>
        <div class="trade-cell"><div class="k">Stop Loss</div><div class="v v-stop" id="v-stop">-</div><div class="pct" id="v-stop-pct"></div></div>
        <div class="trade-cell"><div class="k">TP1</div><div class="v v-tp1" id="v-tp1">-</div><div class="pct" id="v-tp1-pct"></div></div>
        <div class="trade-cell"><div class="k">TP2</div><div class="v v-tp2" id="v-tp2">-</div><div class="pct" id="v-tp2-pct"></div></div>
        <div class="trade-cell"><div class="k">R/R (TP1)</div><div class="v v-rr" id="v-rr1">-</div></div>
        <div class="trade-cell"><div class="k">R/R (TP2)</div><div class="v v-rr" id="v-rr2">-</div></div>
      </div>
      <div class="story-text" id="storyText">Bir sinyal seçtiğinizde burada sade bir açıklama görünecek.</div>
      <div class="story-summary" id="storySummary"></div>
    </div>
  </div>
</div>
<script>
var signals = [];
var selected = null;
var filter = 'all';
var chart = null;
var candleSeries = null;
var trendUpSeries = null;
var trendDownSeries = null;
var currentSymbol = null;
var refreshChartTimer = null;
var initialFitDone = false;
var userScrolled = false;
var lastVisibleRange = null;

function fmtPrice(v) {
  var x = Number(v);
  if (!Number.isFinite(x)) return '-';
  if (x >= 1000) return x.toFixed(2);
  if (x >= 100) return x.toFixed(3);
  if (x >= 1) return x.toFixed(5);
  return x.toFixed(8);
}

function stateClass(st) {
  if (st === 'KIRILDI') return 'kirildi';
  if (st === 'GİRİŞ FIRSATI') return 'giris';
  if (st === 'HAREKET BAŞLADI') return 'hareket';
  if (st === 'YAKLAŞIYOR') return 'yaklasiyor';
  return 'izle';
}
function stateBadge(st) {
  if (st === 'KIRILDI') return 'b-kirildi';
  if (st === 'GİRİŞ FIRSATI') return 'b-giris';
  if (st === 'HAREKET BAŞLADI') return 'b-hareket';
  if (st === 'YAKLAŞIYOR') return 'b-yaklasiyor';
  return 'b-izle';
}
function shortState(st) {
  if (st === 'KIRILDI') return 'KIRILDI';
  if (st === 'GİRİŞ FIRSATI') return 'GİRİŞ';
  if (st === 'HAREKET BAŞLADI') return 'HAREKET';
  if (st === 'YAKLAŞIYOR') return 'YAKLAŞIYOR';
  return 'İZLE';
}

function renderMarket(market) {
  var banner = document.getElementById('marketBanner');
  var trend = market.trend || 'UNKNOWN';

  if (trend === 'UP') banner.className = 'market-banner market-up';
  else if (trend === 'DOWN') banner.className = 'market-banner market-down';
  else if (trend === 'SIDEWAYS') banner.className = 'market-banner market-sideways';
  else banner.className = 'market-banner market-unknown';

  var trendText = trend === 'UP' ? 'PİYASA: YÜKSELİŞ' : trend === 'DOWN' ? 'PİYASA: DÜŞÜŞ' : trend === 'SIDEWAYS' ? 'PİYASA: YATAY' : 'PİYASA: BİLİNMİYOR';
  var subText = trend === 'UP' ? 'LONG sinyalleri güvenli' : trend === 'DOWN' ? 'SHORT sinyalleri güvenli' : trend === 'SIDEWAYS' ? 'Her iki yön de riskli' : 'BTC verisi bekleniyor';

  banner.innerHTML = '📊 ' + trendText + '<br><span style="font-size:11px;font-weight:600;">' + subText + '</span><div class="sub">BTC: $' + Number(market.btcPrice || 0).toFixed(0) + ' · 4s değişim: ' + (market.btcChange4h >= 0 ? '+' : '') + Number(market.btcChange4h || 0).toFixed(2) + '%</div>';
}

function render() {
  var el = document.getElementById('list');
  var filtered = signals.filter(function(s) {
    if (filter === 'all') return true;
    if (filter === 'LONG') return s.direction === 'LONG';
    if (filter === 'SHORT') return s.direction === 'SHORT';
    return s.state === filter;
  });

  if (!filtered.length) { el.innerHTML = '<div class="empty">Filtreye uygun sinyal yok.</div>'; return; }

  el.innerHTML = filtered.map(function(s) {
    var sc = stateClass(s.state);
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';
    var againstCls = s.marketAgainst ? ' against' : '';
    var sel = (selected && selected.symbol === s.symbol && selected.direction === s.direction) ? ' selected' : '';
    var warnHtml = s.marketAgainst ? '<span class="warn">⚠️ Ters</span>' : '';
    return '<div class="card ' + sc + ' ' + dirCls + againstCls + sel + '" data-sym="' + s.symbol + '" data-dir="' + s.direction + '">' +
      '<div class="card-top"><span class="sym">' + s.symbol.replace('USDT', '') + '</span><span class="dir ' + dirCls + '">' + s.direction + '</span></div>' +
      '<div class="row2"><span class="badge ' + stateBadge(s.state) + '">' + shortState(s.state) + '</span><span>%' + s.distancePct.toFixed(2) + ' · ' + s.timeStr + '</span>' + warnHtml + '</div>' +
    '</div>';
  }).join('');

  el.querySelectorAll('.card').forEach(function(c) {
    c.addEventListener('click', function() { selectSignal(c.getAttribute('data-sym'), c.getAttribute('data-dir')); });
  });
}

function selectSignal(symbol, direction) {
  selected = signals.find(function(s) { return s.symbol === symbol && s.direction === direction; });
  if (!selected) return;
  currentSymbol = symbol;
  initialFitDone = false;  // yeni coin seçildiğinde yeniden fit
  userScrolled = false;

  document.getElementById('title').textContent = symbol.replace('USDT', '') + ' / USDT';
  document.getElementById('subtitle').textContent = selected.direction + ' · ' + shortState(selected.state);
  updateTradePanel(selected);
  render();
  loadChart(symbol, true);
  startChartRefresh();
}

function updateTradePanel(s) {
  document.getElementById('v-entry').textContent = fmtPrice(s.entry);
  document.getElementById('v-entry-pct').textContent = '%' + s.entryPct.toFixed(2);
  document.getElementById('v-stop').textContent = fmtPrice(s.stop);
  document.getElementById('v-stop-pct').textContent = '-%' + s.stopPct.toFixed(2);
  document.getElementById('v-tp1').textContent = fmtPrice(s.tp1);
  document.getElementById('v-tp1-pct').textContent = '+%' + s.tp1Pct.toFixed(2);
  document.getElementById('v-tp2').textContent = fmtPrice(s.tp2);
  document.getElementById('v-tp2-pct').textContent = '+%' + s.tp2Pct.toFixed(2);
  document.getElementById('v-rr1').textContent = '1:' + s.rr1;
  document.getElementById('v-rr2').textContent = '1:' + s.rr2;
  document.getElementById('storyText').innerHTML = s.story;
  document.getElementById('storySummary').innerHTML = s.summary;
}

async function loadChart(symbol, forceFit) {
  try {
    var r = await fetch('/api/chart?symbol=' + encodeURIComponent(symbol));
    var d = await r.json();
    if (!d.ok) return;

    if (!chart) {
      var el = document.getElementById('chart');
      chart = LightweightCharts.createChart(el, {
        width: el.clientWidth,
        height: el.clientHeight,
        layout: { background: { color: '#0b0e13' }, textColor: '#7a8b9e' },
        grid: { vertLines: { color: '#141b24' }, horzLines: { color: '#141b24' } },
        timeScale: {
          borderColor: '#1c2530',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 10
        },
        rightPriceScale: { borderColor: '#1c2530' },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
      });

      candleSeries = chart.addCandlestickSeries({
        upColor: '#13dba0', downColor: '#f87171',
        borderUpColor: '#13dba0', borderDownColor: '#f87171',
        wickUpColor: '#13dba0', wickDownColor: '#f87171'
      });

      trendUpSeries = chart.addLineSeries({
        color: '#13dba0', lineWidth: 3, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false
      });

      trendDownSeries = chart.addLineSeries({
        color: '#f87171', lineWidth: 3, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false
      });

      // Kullanıcı grafiği kaydırdı mı takip et
      chart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
        if (!range) return;
        // Kullanıcı sağa kaydırdıysa (sona yakınsa) takip et
        var dataRange = chart.timeScale().getVisibleLogicalRange();
        if (dataRange && candleSeries) {
          var lastIdx = d.candles.length - 1;
          // Son 5 mum görünüyorsa otomatik takip
          userScrolled = dataRange.to < lastIdx - 3;
        }
      });

      window.addEventListener('resize', function() {
        if (chart) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      });
    }

    // Candles güncelle
    if (forceFit || !initialFitDone) {
      candleSeries.setData(d.candles);
      initialFitDone = true;
    } else {
      // Sadece son mumu güncelle (setData değil, update)
      var lastCandle = d.candles[d.candles.length - 1];
      if (lastCandle) candleSeries.update(lastCandle);
    }

    // Trend çizgileri
    if (d.trendUp.length) trendUpSeries.setData(d.trendUp);
    else trendUpSeries.setData([]);
    if (d.trendDown.length) trendDownSeries.setData(d.trendDown);
    else trendDownSeries.setData([]);

    // Price lines temizle
    if (candleSeries._priceLines) {
      candleSeries._priceLines.forEach(function(pl) {
        try { candleSeries.removePriceLine(pl); } catch (e) {}
      });
    }
    candleSeries._priceLines = [];

    // Sadece Giriş ve Stop göster
    if (d.signal) {
      var pl1 = candleSeries.createPriceLine({
        price: d.signal.entry, color: '#60a5fa', lineWidth: 2,
        lineStyle: 0, axisLabelVisible: true, title: 'GİRİŞ'
      });
      var pl2 = candleSeries.createPriceLine({
        price: d.signal.stop, color: '#f87171', lineWidth: 2,
        lineStyle: 0, axisLabelVisible: true, title: 'STOP'
      });
      candleSeries._priceLines.push(pl1, pl2);
    }

    // Sadece ilk yüklemede fit yap
    if ((forceFit || !initialFitDone) && !userScrolled) {
      chart.timeScale().fitContent();
    }
  } catch (e) {
    console.error('chart error:', e);
  }
}

function startChartRefresh() {
  if (refreshChartTimer) clearInterval(refreshChartTimer);
  refreshChartTimer = setInterval(function() {
    if (currentSymbol) loadChart(currentSymbol, false);
  }, 10000);
}

function connect() {
  var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var ws = new WebSocket(proto + location.host);

  ws.onopen = function() {
    document.getElementById('conn').className = 'conn on';
    document.getElementById('conn').textContent = '● CANLI';
  };

  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'snapshot') renderSnapshot(msg.data);
    } catch (e) {}
  };

  ws.onclose = function() {
    document.getElementById('conn').className = 'conn off';
    document.getElementById('conn').textContent = '● KAPALI';
    setTimeout(connect, 3000);
  };

  ws.onerror = function() {
    document.getElementById('conn').className = 'conn off';
    document.getElementById('conn').textContent = '● HATA';
  };
}

function renderSnapshot(data) {
  signals = data.signals || [];
  var st = data.stats || {};
  document.getElementById('s-kirildi').textContent = st.kirildi || 0;
  document.getElementById('s-giris').textContent = st.giris || 0;
  document.getElementById('s-hareket').textContent = st.hareket || 0;
  document.getElementById('s-yaklasiyor').textContent = st.yaklasiyor || 0;

  if (data.market) renderMarket(data.market);

  if (selected) {
    var updated = signals.find(function(s) { return s.symbol === selected.symbol && s.direction === selected.direction; });
    if (updated) {
      selected = updated;
      document.getElementById('title').textContent = updated.symbol.replace('USDT', '') + ' / USDT';
      document.getElementById('subtitle').textContent = updated.direction + ' · ' + shortState(updated.state);
      updateTradePanel(updated);
    }
  }

  render();
}

document.querySelectorAll('.fbtn').forEach(function(b) {
  b.addEventListener('click', function() {
    document.querySelectorAll('.fbtn').forEach(function(x) { x.classList.remove('active'); });
    b.classList.add('active');
    filter = b.getAttribute('data-f');
    render();
  });
});

connect();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(HTML);
});

// ============================================================
// BAŞLAT
// ============================================================

async function boot() {
  console.log('');
  console.log('==========================================');
  console.log(' SONNY AI TREND RADAR + PİYASA FİLTRESİ');
  console.log('==========================================');
  console.log('');

  try {
    await updateMarketTrend();
    await loadMarkets();
    connectBitgetWS();
    await runPreScan();
    runScan();

    setInterval(runScan, CFG.SCAN_INTERVAL_MS);
    setInterval(runPreScan, CFG.PRESCAN_INTERVAL_MS);
    setInterval(updateMarketTrend, 5 * 60 * 1000);

    console.log('Sistem hazır.');
  } catch (err) {
    console.error('BOOT ERROR:', err);
    process.exit(1);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on ' + PORT);
  boot();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
