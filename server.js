// server.js (V6 - Trend Yaklaşma Radarı + Lightweight Charts)
// 2H eğimli trend çizgisi otomatik tespit
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
  // Filtre
  MIN_24H_VOLUME_USDT: 5000000,      // 5M USDT
  PRESCAN_INTERVAL_MS: 15 * 60 * 1000, // 15 dk'da bir hacim listesi yenile
  MAX_COINS: 400,                     // güvenlik üst sınır

  // Trend çizgisi
  TREND_LOOKBACK: 50,                 // 2H mum sayısı (50 * 2h ≈ 4 gün)
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MIN_PIVOTS: 3,
  MIN_R2: 0.70,

  // Yaklaşma seviyeleri
  WATCH_DISTANCE_PCT: 2.00,           // İZLE
  NEAR_DISTANCE_PCT: 1.20,            // YAKLAŞIYOR
  IGNITION_DISTANCE_PCT: 0.55,        // HAREKET BAŞLADI
  ENTRY_DISTANCE_PCT: 0.18,           // GİRİŞ FIRSATI

  // Tarama
  SCAN_INTERVAL_MS: 30 * 1000,        // 30 saniye
  LIVE_INTERVAL_MS: 2 * 1000,         // 2 saniye fiyat güncelleme

  SIGNAL_TTL_MS: 15 * 60 * 1000,      // 15 dk
  WS_BATCH: 20
};

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: Date.now(),

  // Tüm coin verisi
  symbols: new Map(),   // symbol -> { price, bid, ask, volume24h, oi, h1: [], h2: [] }

  // Hacim filtresini geçen coin listesi
  targetList: [],

  // Trend çizgileri
  trends: new Map(),    // symbol -> { up: {...}, down: {...} }

  // Sinyaller
  signals: new Map(),   // symbol+type -> signal

  // WebSocket bağlantı durumu
  wsBitget: null,
  wsConnected: false,
  wsSubscriptions: [],

  // Stats
  stats: {
    totalCoins: 0,
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
// MARKET YÜKLE (tüm coinler)
// ============================================================

async function loadMarkets() {
  try {
    const json = await rest('/api/v2/mix/market/contracts', { productType: PRODUCT });
    const contracts = Array.isArray(json.data) ? json.data : [];
    let count = 0;
    for (const c of contracts) {
      const s = normalizeSym(c.symbol);
      if (!s) continue;
      if (c.symbolType === 'delivery') continue;
      if (String(c.quoteCoin).toUpperCase() !== 'USDT') continue;
      getSym(s);
      count++;
    }
    state.stats.totalCoins = count;
    console.log('Marketler yüklendi: ' + count + ' coin');
  } catch (e) {
    console.error('Market load error:', e.message);
  }
}

// ============================================================
// PRESCAN - Hacim filtresi
// ============================================================

async function runPreScan() {
  console.log('\n--- ÖN TARAMA BAŞLADI ---');
  try {
    // Tüm ticker'ları çek
    const json = await rest('/api/v2/mix/market/tickers', { productType: PRODUCT });
    const rows = Array.isArray(json.data) ? json.data : [];

    const filtered = [];
    for (const r of rows) {
      const s = normalizeSym(r.symbol);
      if (!s) continue;

      const turn = num(r.quoteVolume || r.usdtVolume);
      const price = num(r.lastPr || r.lastPrice);

      if (price > 0 && turn >= CFG.MIN_24H_VOLUME_USDT) {
        const sym = getSym(s);
        sym.price = price;
        sym.turnover24h = turn;
        filtered.push({ symbol: s, turnover: turn });
      }
    }

    // Hacme göre sırala
    filtered.sort((a, b) => b.turnover - a.turnover);

    // Üst sınır
    const list = filtered.slice(0, CFG.MAX_COINS).map(x => x.symbol);

    // Önceki listeyi güncelle
    state.targetList = list;
    state.stats.filteredCoins = list.length;

    console.log('Ön tarama tamamlandı. ' + filtered.length + ' coin filtreden geçti, ' + list.length + ' coin takibe alındı.');

    // Bu coinler için 2H mum verisi çek
    await loadHistoricalCandles();

    // WS aboneliklerini yenile
    subscribeWS();
  } catch (e) {
    console.error('PreScan error:', e.message);
  }
}

// ============================================================
// 2H MUM VERİSİ ÇEK (1H'den agrege)
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

      const sym = getSym(symbol);
      sym.h1 = candles;

      // 2H'ye agrege
      aggregate2H(symbol);

      count++;
    } catch (e) {
      // Sessizce geç
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 40));
  }

  console.log('Mum verisi hazır: ' + count + '/' + state.targetList.length + ' coin');

  // İlk trend çizgisi tespiti
  for (const symbol of state.targetList) {
    try { detectTrends(symbol); } catch (e) {}
  }
}

// ============================================================
// 1H -> 2H AGREGASYON
// ============================================================

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
// PIVOT TESPİTİ
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

// ============================================================
// LİNEER REGRESYON
// ============================================================

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
// TREND ÇİZGİSİ TESPİTİ
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

  // Düşen direnç (LONG için)
  const highs = findPivotHighs(recent, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT);
  let down = null;
  if (highs.length >= CFG.MIN_PIVOTS) {
    const latest = highs.slice(-Math.min(highs.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.MIN_R2 && reg.a < 0) {
      down = {
        slope: reg.a,
        intercept: reg.b,
        r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * lastIdx + reg.b,
        // Grafiği çizmek için son 50 mumun karşılık gelen değerleri
        linePoints: recent.map((c, i) => ({ time: c.ts, value: reg.a * i + reg.b }))
      };
    }
  }

  // Yükselen destek (SHORT için)
  const lows = findPivotLows(recent, CFG.PIVOT_LEFT, CFG.PIVOT_RIGHT);
  let up = null;
  if (lows.length >= CFG.MIN_PIVOTS) {
    const latest = lows.slice(-Math.min(lows.length, 6));
    const reg = linearRegression(latest.map(p => ({ x: p.index, y: p.price })));
    if (reg && reg.r2 >= CFG.MIN_R2 && reg.a > 0) {
      up = {
        slope: reg.a,
        intercept: reg.b,
        r2: reg.r2,
        pivotCount: latest.length,
        currentValue: reg.a * lastIdx + reg.b,
        linePoints: recent.map((c, i) => ({ time: c.ts, value: reg.a * i + reg.b }))
      };
    }
  }

  state.trends.set(symbol, { up, down });
}

// ============================================================
// YAKLAŞMA KONTROLÜ
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
        direction: 'LONG',
        trendType: 'DOWN_RESISTANCE',
        lineValue: line,
        distancePct: dist,
        r2: tr.down.r2,
        pivotCount: tr.down.pivotCount,
        broken: price > line,
        linePoints: tr.down.linePoints
      });
    }
  }

  if (tr.up) {
    const line = tr.up.currentValue;
    const dist = absPct(price, line);
    if (dist <= CFG.WATCH_DISTANCE_PCT) {
      candidates.push({
        direction: 'SHORT',
        trendType: 'UP_SUPPORT',
        lineValue: line,
        distancePct: dist,
        r2: tr.up.r2,
        pivotCount: tr.up.pivotCount,
        broken: price < line,
        linePoints: tr.up.linePoints
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distancePct - b.distancePct);
  return candidates[0];
}

// ============================================================
// HACİM / FLOW / MOMENTUM / OI
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
// SKOR
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

  return Math.min(100, Math.round(score));
}

// ============================================================
// DURUM BELİRLE
// ============================================================

function determineState(info, score) {
  if (info.broken) return 'KIRILDI';
  if (score >= 80 || info.distancePct <= CFG.ENTRY_DISTANCE_PCT) return 'GİRİŞ FIRSATI';
  if (score >= 65 || info.distancePct <= CFG.IGNITION_DISTANCE_PCT) return 'HAREKET BAŞLADI';
  if (score >= 50 || info.distancePct <= CFG.NEAR_DISTANCE_PCT) return 'YAKLAŞIYOR';
  return 'İZLE';
}

// ============================================================
// SİNYAL ÜRET
// ============================================================

function buildSignal(symbol, info) {
  const sym = getSym(symbol);
  const score = calcScore(symbol, info);
  const stateName = determineState(info, score);

  const vr = calcVolumeRatio(symbol);
  const oi = oiChange(symbol);
  const flow = flowScore(symbol);
  const mom = priceMomentum(symbol);

  return {
    symbol,
    direction: info.direction,
    state: stateName,
    score,
    confidence: score,

    price: sym.price,
    lineValue: info.lineValue,
    distancePct: info.distancePct,
    broken: info.broken,

    volumeRatio: vr,
    oiChangePct: oi,
    flow,
    momentum: mom,

    trendR2: info.r2,
    trendPivots: info.pivotCount,
    trendType: info.trendType,
    linePoints: info.linePoints,

    timestamp: now(),
    timeStr: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

  // Sıralama: önem + mesafe
  const order = { 'KIRILDI': 5, 'GİRİŞ FIRSATI': 4, 'HAREKET BAŞLADI': 3, 'YAKLAŞIYOR': 2, 'İZLE': 1 };
  newSignals.sort((a, b) => {
    const oa = order[a.state] || 0;
    const ob = order[b.state] || 0;
    if (oa !== ob) return ob - oa;
    return a.distancePct - b.distancePct;
  });

  // Map'e yaz
  state.signals.clear();
  for (const s of newSignals) {
    state.signals.set(s.symbol + '-' + s.direction, s);
  }
  state.stats.signals = state.signals.size;

  // Client'lara gönder
  broadcast();
}

// ============================================================
// BITGET WEBSOCKET (canlı fiyat)
// ============================================================

function connectBitgetWS() {
  if (state.wsBitget) {
    try { state.wsBitget.close(); } catch (e) {}
  }

  const ws = new WebSocket(BITGET_WS);
  state.wsBitget = ws;

  ws.on('open', () => {
    console.log('Bitget WebSocket bağlandı.');
    state.wsConnected = true;
    reconnectAttempts = 0;
    subscribeWS();
  });

  ws.on('message', raw => {
    try {
      const txt = raw.toString();
      if (txt === 'pong' || txt === 'ping') return;
      const msg = JSON.parse(txt);
      if (msg.event === 'subscribe') return;
      if (!msg.data || !msg.arg) return;
      if (msg.arg.channel === 'ticker') processTicker(msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Bitget WebSocket kapandı.');
    state.wsConnected = false;
    const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(connectBitgetWS, delay);
  });

  ws.on('error', err => console.error('WS error:', err.message));
}

function subscribeWS() {
  if (!state.wsBitget || state.wsBitget.readyState !== WebSocket.OPEN) return;
  if (!state.targetList.length) return;

  // Önceki abonelikleri iptal et
  if (state.wsSubscriptions.length) {
    try {
      state.wsBitget.send(JSON.stringify({ op: 'unsubscribe', args: state.wsSubscriptions.flat() }));
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
// WEBSOCKET SERVER (client'a veri gönder)
// ============================================================

function getSnapshot() {
  const signals = Array.from(state.signals.values());
  return {
    signals,
    stats: {
      total: signals.length,
      kirildi: signals.filter(s => s.state === 'KIRILDI').length,
      giris: signals.filter(s => s.state === 'GİRİŞ FIRSATI').length,
      hareket: signals.filter(s => s.state === 'HAREKET BAŞLADI').length,
      yaklasiyor: signals.filter(s => s.state === 'YAKLAŞIYOR').length,
      izle: signals.filter(s => s.state === 'İZLE').length,
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
  try {
    ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() }));
  } catch (e) {}
});

// ============================================================
// API: Grafik verisi
// ============================================================

app.get('/api/chart', async (req, res) => {
  try {
    const symbol = normalizeSym(req.query.symbol);
    if (!symbol) return res.json({ ok: false, error: 'symbol required' });

    const sym = state.symbols.get(symbol);
    if (!sym || !sym.h2.length) {
      return res.json({ ok: false, error: 'no candle data for ' + symbol });
    }

    const tr = state.trends.get(symbol) || { up: null, down: null };
    const sig = Array.from(state.signals.values()).find(s => s.symbol === symbol) || null;

    // Son 80 2H mum
    const candles = sym.h2.slice(-80).map(c => ({
      time: Math.floor(c.ts / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));

    // Trend çizgileri sadece son 80 mum için
    const firstTs = sym.h2.slice(-80)[0]?.ts || 0;
    const lineUp = tr.up ? tr.up.linePoints.filter(p => p.time >= firstTs).map(p => ({
      time: Math.floor(p.time / 1000),
      value: p.value
    })) : [];
    const lineDown = tr.down ? tr.down.linePoints.filter(p => p.time >= firstTs).map(p => ({
      time: Math.floor(p.time / 1000),
      value: p.value
    })) : [];

    res.json({
      ok: true,
      symbol,
      price: sym.price,
      bid: sym.bid,
      ask: sym.ask,
      candles,
      trendUp: lineUp,
      trendDown: lineDown,
      trendUpInfo: tr.up ? { r2: tr.up.r2, slope: tr.up.slope, pivotCount: tr.up.pivotCount } : null,
      trendDownInfo: tr.down ? { r2: tr.down.r2, slope: tr.down.slope, pivotCount: tr.down.pivotCount } : null,
      signal: sig
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    uptime: now() - state.startedAt,
    wsConnected: state.wsConnected,
    totalCoins: state.stats.totalCoins,
    filteredCoins: state.stats.filteredCoins,
    scans: state.stats.scans,
    signals: state.stats.signals,
    lastScan: state.stats.lastScan,
    wsMsgs: state.stats.wsTickerMsgs
  });
});

// ============================================================
// HTML
// ============================================================

app.get('/', (req, res) => {
  res.type('html').send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sonny AI Trend Radar</title>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0b0e13;color:#dbe4ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:12px}
.app{display:grid;grid-template-columns:340px 1fr;height:100vh}
.panel{background:#0f141b;border-right:1px solid #1c2530;display:flex;flex-direction:column;overflow:hidden}
.hdr{padding:14px 16px;border-bottom:1px solid #1c2530;flex-shrink:0}
.hdr h1{font-size:15px;font-weight:800;color:#13dba0;margin-bottom:3px;letter-spacing:0.3px}
.hdr .sub{font-size:10px;color:#5a6b7d}
.stats{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #1c2530;flex-shrink:0}
.stat{flex:1;background:#131a24;border-radius:5px;padding:6px 4px;text-align:center}
.stat .n{display:block;font-size:16px;font-weight:800;color:#13dba0;line-height:1.1}
.stat .l{font-size:8px;color:#5a6b7d;text-transform:uppercase;letter-spacing:0.5px}
.stat.fire .n{color:#fbbf24}
.stat.entry .n{color:#f87171}
.stat.watch .n{color:#60a5fa}
.filters{display:flex;gap:5px;padding:8px 12px;border-bottom:1px solid #1c2530;flex-shrink:0;flex-wrap:wrap}
.fbtn{padding:3px 8px;background:#131a24;border:1px solid #1c2530;border-radius:4px;color:#6b7c8f;font-size:9px;font-weight:600;cursor:pointer;text-transform:uppercase;letter-spacing:0.3px}
.fbtn:hover{background:#1a2432;color:#dbe4ee}
.fbtn.active{background:#13dba0;color:#0b0e13;border-color:#13dba0}
.list{flex:1;overflow-y:auto;padding:6px}
.list::-webkit-scrollbar{width:6px}
.list::-webkit-scrollbar-track{background:#0f141b}
.list::-webkit-scrollbar-thumb{background:#1c2530;border-radius:3px}
.card{background:#131a24;border:1px solid #1c2530;border-left:3px solid #1c2530;border-radius:6px;padding:9px 10px;margin-bottom:5px;cursor:pointer;transition:all .15s}
.card:hover{background:#1a2432;border-color:#13dba0}
.card.selected{border-color:#13dba0;background:#152029;box-shadow:0 0 0 1px #13dba0 inset}
.card.long{border-left-color:#13dba0}
.card.short{border-left-color:#f87171}
.card.kirildi{background:linear-gradient(90deg,#0f2a1f 0%,#131a24 30%);border-left-color:#22c55e}
.card.giris{border-left-color:#f87171}
.card.hareket{border-left-color:#fb923c}
.card.yaklasiyor{border-left-color:#fbbf24}
.card.izle{border-left-color:#60a5fa}
.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.sym{font-size:13px;font-weight:800;color:#e5eaf0;letter-spacing:0.2px}
.dir{font-size:9px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:0.5px}
.dir.long{background:#0d3d2a;color:#13dba0}
.dir.short{background:#421d28;color:#f87171}
.row{display:flex;gap:5px;align-items:center;font-size:9.5px;color:#7a8b9e;margin-top:3px;flex-wrap:wrap}
.row b{color:#dbe4ee;font-weight:700}
.badge{font-size:8.5px;font-weight:800;padding:2px 6px;border-radius:3px;letter-spacing:0.3px}
.b-kirildi{background:#22c55e;color:#052e16}
.b-giris{background:#f87171;color:#450a0a}
.b-hareket{background:#fb923c;color:#431407}
.b-yaklasiyor{background:#fbbf24;color:#451a03}
.b-izle{background:#3b82f6;color:#082f49}
.time{font-size:8.5px;color:#4a5a6b;margin-top:4px;font-family:monospace}
.empty{padding:40px 20px;text-align:center;color:#4a5a6b;font-size:11px}
.main{display:flex;flex-direction:column;background:#0b0e13;overflow:hidden}
.main-hdr{padding:12px 16px;border-bottom:1px solid #1c2530;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#0f141b}
.main-hdr h2{font-size:14px;font-weight:800;color:#e5eaf0}
.main-hdr .sub{font-size:10px;color:#5a6b7d;margin-top:2px}
.chart-wrap{flex:1;position:relative;min-height:0}
#chart{position:absolute;inset:0}
.details{background:#0f141b;border-top:1px solid #1c2530;padding:10px 16px;flex-shrink:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:10px}
.det{background:#131a24;border-radius:5px;padding:7px 9px}
.det .k{color:#5a6b7d;font-size:9px;text-transform:uppercase;letter-spacing:0.4px}
.det .v{color:#dbe4ee;font-weight:700;font-size:12px;margin-top:2px;font-family:monospace}
.det .v.green{color:#13dba0}
.det .v.red{color:#f87171}
.det .v.orange{color:#fb923c}
.det .v.yellow{color:#fbbf24}
.conn{position:fixed;top:8px;right:12px;padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;z-index:100}
.conn.on{background:#0d3d2a;color:#13dba0}
.conn.off{background:#421d28;color:#f87171}
</style>
</head>
<body>
<div class="conn off" id="conn">● BAĞLANIYOR</div>
<div class="app">
  <div class="panel">
    <div class="hdr">
      <h1>📐 TREND YAKLAŞMA RADARI</h1>
      <div class="sub">2H eğimli trend çizgisi otomatik tespit</div>
    </div>
    <div class="stats">
      <div class="stat fire"><span class="n" id="s-kirildi">0</span><span class="l">Kırıldı</span></div>
      <div class="stat entry"><span class="n" id="s-giris">0</span><span class="l">Giriş</span></div>
      <div class="stat"><span class="n" id="s-hareket">0</span><span class="l">Hareket</span></div>
      <div class="stat watch"><span class="n" id="s-yaklasiyor">0</span><span class="l">Yaklaşan</span></div>
    </div>
    <div class="filters">
      <div class="fbtn active" data-f="all">Tümü</div>
      <div class="fbtn" data-f="KIRILDI">Kırıldı</div>
      <div class="fbtn" data-f="GİRİŞ FIRSATI">Giriş</div>
      <div class="fbtn" data-f="HAREKET BAŞLADI">Hareket</div>
      <div class="fbtn" data-f="YAKLAŞIYOR">Yaklaşan</div>
      <div class="fbtn" data-f="LONG">LONG</div>
      <div class="fbtn" data-f="SHORT">SHORT</div>
    </div>
    <div class="list" id="list"><div class="empty">Taranıyor...</div></div>
  </div>
  <div class="main">
    <div class="main-hdr">
      <div>
        <h2 id="title">Sinyal seçin</h2>
        <div class="sub" id="subtitle">Soldan bir sinyale tıklayın</div>
      </div>
      <div class="row" style="gap:10px">
        <span class="row"><b id="m-coin">0</b>/<span id="m-total">0</span> coin</span>
        <span class="row">Tarama: <b id="m-scans">0</b></span>
      </div>
    </div>
    <div class="chart-wrap"><div id="chart"></div></div>
    <div class="details" id="details">
      <div class="det"><div class="k">Fiyat</div><div class="v" id="d-price">-</div></div>
      <div class="det"><div class="k">Trend Çizgisi</div><div class="v orange" id="d-line">-</div></div>
      <div class="det"><div class="k">Uzaklık</div><div class="v yellow" id="d-dist">-</div></div>
      <div class="det"><div class="k">R²</div><div class="v green" id="d-r2">-</div></div>
      <div class="det"><div class="k">Hacim</div><div class="v" id="d-vol">-</div></div>
      <div class="det"><div class="k">OI</div><div class="v" id="d-oi">-</div></div>
      <div class="det"><div class="k">Flow</div><div class="v" id="d-flow">-</div></div>
      <div class="det"><div class="k">Momentum</div><div class="v" id="d-mom">-</div></div>
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
var priceLine = null;
var currentSymbol = null;
var lastCandleTs = 0;
var refreshChartTimer = null;

function fmt(v, d) {
  if (d === undefined) d = 6;
  var x = Number(v);
  if (!Number.isFinite(x)) return '-';
  return x.toFixed(d);
}

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

function render() {
  var el = document.getElementById('list');

  var filtered = signals.filter(function(s) {
    if (filter === 'all') return true;
    if (filter === 'LONG') return s.direction === 'LONG';
    if (filter === 'SHORT') return s.direction === 'SHORT';
    return s.state === filter;
  });

  if (!filtered.length) {
    el.innerHTML = '<div class="empty">Filtreye uygun sinyal yok.</div>';
    return;
  }

  el.innerHTML = filtered.map(function(s) {
    var sc = stateClass(s.state);
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';
    var sel = (selected && selected.symbol === s.symbol && selected.direction === s.direction) ? ' selected' : '';
    return '<div class="card ' + sc + ' ' + dirCls + sel + '" data-sym="' + s.symbol + '" data-dir="' + s.direction + '">' +
      '<div class="card-top">' +
        '<span class="sym">' + s.symbol.replace('USDT', '') + '</span>' +
        '<span class="dir ' + dirCls + '">' + s.direction + '</span>' +
      '</div>' +
      '<div class="row">' +
        '<span class="badge ' + stateBadge(s.state) + '">' + s.state + '</span>' +
        '<span>Skor: <b>' + s.score + '</b></span>' +
        '<span>R²: <b>' + s.trendR2.toFixed(2) + '</b></span>' +
      '</div>' +
      '<div class="row">' +
        '<span>Fiyat: <b>' + fmtPrice(s.price) + '</b></span>' +
        '<span>Çizgi: <b style="color:#fb923c">' + fmtPrice(s.lineValue) + '</b></span>' +
        '<span>Uzaklık: <b style="color:#fbbf24">%' + s.distancePct.toFixed(2) + '</b></span>' +
      '</div>' +
      '<div class="time">🕐 ' + s.timeStr + '</div>' +
    '</div>';
  }).join('');

  el.querySelectorAll('.card').forEach(function(c) {
    c.addEventListener('click', function() {
      var sym = c.getAttribute('data-sym');
      var dir = c.getAttribute('data-dir');
      selectSignal(sym, dir);
    });
  });
}

function selectSignal(symbol, direction) {
  selected = signals.find(function(s) { return s.symbol === symbol && s.direction === direction; });
  if (!selected) return;
  currentSymbol = symbol;
  document.getElementById('title').textContent = symbol.replace('USDT', '') + ' / USDT';
  document.getElementById('subtitle').textContent = '2H · ' + selected.trendType.replace('_', ' ') + ' · R²=' + selected.trendR2.toFixed(2) + ' · ' + selected.trendPivots + ' pivot';

  // Detaylar
  document.getElementById('d-price').textContent = fmtPrice(selected.price);
  document.getElementById('d-line').textContent = fmtPrice(selected.lineValue);
  document.getElementById('d-dist').textContent = '%' + selected.distancePct.toFixed(2);
  document.getElementById('d-r2').textContent = selected.trendR2.toFixed(2);
  document.getElementById('d-vol').textContent = selected.volumeRatio.toFixed(2) + 'x';
  document.getElementById('d-oi').textContent = '%' + selected.oiChangePct.toFixed(2);
  document.getElementById('d-flow').textContent = '%' + (selected.flow * 100).toFixed(0);
  document.getElementById('d-mom').textContent = '%' + selected.momentum.toFixed(2);

  render();
  loadChart(symbol);
  startChartRefresh();
}

async function loadChart(symbol) {
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
        timeScale: { borderColor: '#1c2530', timeVisible: true, secondsVisible: false },
        rightPriceScale: { borderColor: '#1c2530' },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
      });

      candleSeries = chart.addCandlestickSeries({
        upColor: '#13dba0',
        downColor: '#f87171',
        borderUpColor: '#13dba0',
        borderDownColor: '#f87171',
        wickUpColor: '#13dba0',
        wickDownColor: '#f87171'
      });

      trendUpSeries = chart.addLineSeries({
        color: '#13dba0',
        lineWidth: 2,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false
      });

      trendDownSeries = chart.addLineSeries({
        color: '#f87171',
        lineWidth: 2,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false
      });

      window.addEventListener('resize', function() {
        if (chart) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      });
    }

    candleSeries.setData(d.candles);
    if (d.trendUp.length) trendUpSeries.setData(d.trendUp);
    else trendUpSeries.setData([]);
    if (d.trendDown.length) trendDownSeries.setData(d.trendDown);
    else trendDownSeries.setData([]);

    if (d.candles.length) {
      lastCandleTs = d.candles[d.candles.length - 1].time;
    }

    chart.timeScale().fitContent();
  } catch (e) {
    console.error('chart load error:', e);
  }
}

function startChartRefresh() {
  if (refreshChartTimer) clearInterval(refreshChartTimer);
  refreshChartTimer = setInterval(function() {
    if (currentSymbol) loadChart(currentSymbol);
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
    document.getElementById('conn').textContent = '● BAĞLANTI KESİLDİ';
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
  document.getElementById('m-coin').textContent = st.filteredCoins || 0;
  document.getElementById('m-total').textContent = st.totalCoins || 0;
  document.getElementById('m-scans').textContent = st.scans || 0;

  // Seçili sinyal güncellendiyse detayları yenile
  if (selected) {
    var updated = signals.find(function(s) { return s.symbol === selected.symbol && s.direction === selected.direction; });
    if (updated) {
      selected = updated;
      document.getElementById('d-price').textContent = fmtPrice(updated.price);
      document.getElementById('d-line').textContent = fmtPrice(updated.lineValue);
      document.getElementById('d-dist').textContent = '%' + updated.distancePct.toFixed(2);
      document.getElementById('d-vol').textContent = updated.volumeRatio.toFixed(2) + 'x';
      document.getElementById('d-oi').textContent = '%' + updated.oiChangePct.toFixed(2);
      document.getElementById('d-flow').textContent = '%' + (updated.flow * 100).toFixed(0);
      document.getElementById('d-mom').textContent = '%' + updated.momentum.toFixed(2);
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

// ============================================================
// BAŞLAT
// ============================================================

async function boot() {
  console.log('');
  console.log('==========================================');
  console.log(' SONNY AI TREND RADAR');
  console.log(' 2H Eğimli Trend Çizgisi Yaklaşma');
  console.log('==========================================');
  console.log('');

  try {
    // 1. Marketleri yükle
    await loadMarkets();

    // 2. Bitget WS bağlan (henüz abonelik yok)
    connectBitgetWS();

    // 3. Ön tarama + hacim filtresi + mum verisi
    await runPreScan();

    // 4. İlk tarama
    runScan();

    // 5. Periyodik tarama
    setInterval(runScan, CFG.SCAN_INTERVAL_MS);

    // 6. Periyodik ön tarama (hacim listesi yenile)
    setInterval(runPreScan, CFG.PRESCAN_INTERVAL_MS);

    console.log('Sistem hazır. Tarama başlıyor...');
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
