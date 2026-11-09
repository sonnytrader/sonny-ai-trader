'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v1.0 — sade sinyal + OtoTrade sunucusu
   · Modüller: AUTO (OtoTrade), TREND (Trend Takip), LT (LT Üçgen)
   · Trend Takip ve LT Üçgen yalnızca sinyal üretir; otomatik emir açmaz.
   · OtoTrade tek otomatik işlem modülüdür (paper varsayılan, canlı opsiyonel).
   · Sinyal sonucu (TP1/TP2/STOP/BE/SÜRE) tiklerle izlenir ve arayüzde gösterilir.
   · Maliyet/R hesabı sinyal kartlarında yoktur; yalnızca fiyat ve % hareket vardır.
   ══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

/* ── .env ─────────────────────────────────────────────────────────────────── */
(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (e) { /* sessiz */ }
})();

const VERSION = 'v1.0';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1, H1 = 60 * M1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '30m': 30 * M1, '1h': H1, '2h': 2 * H1, '4h': H4, '1d': D1 };
const TF_GRAN = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D' };
const EPS = 1e-9;
const LT_BARS = 600;

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(os.tmpdir(), 'alphason-v1');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) { /* yok */ }
    return alt;
  }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);
const API_TOKEN = String(process.env.ALPHASON_API_TOKEN || '').trim();

const MODULES = {
  AUTO: { key: 'AUTO', label: 'OtoTrade', tf: '1m', chartTf: '1m', tradeable: true, auto: true },
  TREND: { key: 'TREND', label: 'Trend Takip', tf: '5m', chartTf: '5m', tradeable: false, auto: false },
  LT: { key: 'LT', label: 'LT Üçgen', tf: '2h', chartTf: '2h', tradeable: false, auto: false }
};
const ACTIVE_MODULES = ['AUTO', 'TREND', 'LT'];

const COOLDOWN = { AUTO: 10 * M1, TREND: 75 * M1, LT: 4 * H1 };
const MAX_DAY_SYM = { AUTO: 8, TREND: 3, LT: 2 };
const MAX_HOLD = { AUTO: 4 * H1, TREND: 10 * H1, LT: 36 * H1 };

const RES = {
  ACIK: 'DEVAM EDİYOR', TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ',
  TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL KAPATILDI'
};

const STOCK_RE = /^(INTC|MSTR|KORU|SNXX|TSLA|NVDA|AAPL|COIN|HOOD|CRCL|AMZN|GOOGL|MSFT|META|SPY|QQQ|PLTR|AMD|NFLX|BABA|MARA|RIOT|CBRS|TQQQ|BE|CRWV|XAG|SKHYNIX|SKUU|GGLL|IREN|MVLL|NVDL|TSLL|CONL|AAPU|AMZU|SOXS|SOXL|SQQQ|SPXL|SPXS|UPRO|UVXY|TECL|TECS|FNGU|FNGD|LABU|LABD|QID|SDS|TSLQ|TSDD|NVDD|NVDX)$/;

const DEF_SET = {
  autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 3, riskPct: 0.5,
  autoMaxOpen: 2, dailyLossPct: 3, minQuoteVol: 1e6, topN: 120,
  aiEnabled: false, ltTfs: ['2h', '1h'], paperEquity: 1000
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const baseOf = sym => String(sym || '').split('/')[0].replace(/USDT$/, '').toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isStock = sym => STOCK_RE.test(baseOf(sym));

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.autoTrade = s.autoTrade === true;
  s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.margin = clamp(num(s.margin, DEF_SET.margin), 10, 100000);
  s.leverage = clamp(Math.round(num(s.leverage, DEF_SET.leverage)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, DEF_SET.riskPct), 0.1, 5);
  s.autoMaxOpen = clamp(Math.round(num(s.autoMaxOpen, DEF_SET.autoMaxOpen)), 1, 10);
  s.dailyLossPct = clamp(num(s.dailyLossPct, DEF_SET.dailyLossPct), 0.5, 50);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 1e5, 1e9);
  s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 20, 300);
  s.aiEnabled = s.aiEnabled === true;
  s.ltTfs = Array.isArray(s.ltTfs) ? s.ltTfs.filter(t => ['1h', '2h', '4h'].includes(t)) : ['2h', '1h'];
  if (!s.ltTfs.length) s.ltTfs = ['2h'];
  s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9);
  return s;
}

let settings = sanitizeSettings({});
let signals = [];
let paper = { open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity, dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity };
let seq = 0, pseq = 0;
let market = { dir: 'NOTR', score: 50, raw: 0, breadth: 0.5, why: 'veri bekleniyor', btc: null, eth: null, at: 0 };
let UNIVERSE = { all: [], top: [], movers: [], breadth: 0.5, at: 0 };
let TICK = new Map();
let AUTO_WATCH = [], TREND_WATCH = [], LT_WATCH = [];
let lastScan = { auto: 0, trend: 0, lt: 0, tick: 0 };
let READY = false;
let dirty = false;

const LIVE = { open: [], closed: [], balance: null, positions: null, lastSync: 0, lastError: null, busy: false };

/* ── günlük ───────────────────────────────────────────────────────────────── */
const LOGS = [];
const LOG_ONCE = new Map();
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  LOGS.push({ t: Date.now(), msg: String(msg).slice(0, 500) });
  if (LOGS.length > 300) LOGS.splice(0, LOGS.length - 300);
}
function logOnce(key, msg, ms) {
  const now = Date.now();
  if ((LOG_ONCE.get(key) || 0) > now - (ms || 60000)) return;
  LOG_ONCE.set(key, now);
  log(msg);
}

/* ── kalıcı durum ─────────────────────────────────────────────────────────── */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j.settings) settings = sanitizeSettings(j.settings);
    if (Array.isArray(j.signals)) {
      signals = j.signals.filter(s => s && ACTIVE_MODULES.includes(s.module)).slice(-400);
      for (const s of signals) {
        if (s.sl0 == null) s.sl0 = s.sl;
        if (s.closed == null) s.closed = s.status !== 'ACIK' && s.status !== 'TP1';
        if (s.tp1Hit == null) s.tp1Hit = false;
        if (s.maxPct == null) s.maxPct = 0;
        if (s.minPct == null) s.minPct = 0;
        if (s.maxR == null) s.maxR = 0;
        if (s.minR == null) s.minR = 0;
      }
    }
    if (j.paper && typeof j.paper === 'object') {
      paper = Object.assign(paper, j.paper);
      paper.open = Array.isArray(paper.open) ? paper.open.filter(p => p && !p.closed) : [];
      for (const p of paper.open) { if (p.tp1Done == null) p.tp1Done = false; if (p.curPct == null) p.curPct = 0; if (p.pnl == null) p.pnl = 0; }
      paper.closed = Array.isArray(paper.closed) ? paper.closed.slice(-200) : [];
      paper.equity = num(paper.equity, DEF_SET.paperEquity);
      paper.start = num(paper.start, DEF_SET.paperEquity);
      paper.dayStart = num(paper.dayStart, paper.equity);
      paper.peak = num(paper.peak, paper.equity);
    }
    if (j.market && typeof j.market === 'object') {
      market = Object.assign(market, j.market);
      if (!['LONG', 'SHORT', 'NOTR'].includes(market.dir)) market.dir = 'NOTR';
    }
    if (j.live && typeof j.live === 'object') {
      LIVE.open = Array.isArray(j.live.open) ? j.live.open.slice(-20) : [];
      LIVE.closed = Array.isArray(j.live.closed) ? j.live.closed.slice(-100) : [];
      LIVE.balance = j.live.balance || null;
    }
    seq = num(j.seq, 0); pseq = num(j.pseq, 0);
    log('Durum yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık paper işlem');
  } catch (e) { log('Durum yüklenemedi: ' + e.message); }
}

function saveState(force) {
  if (!dirty && !force) return;
  try {
    const j = {
      version: VERSION, at: Date.now(), settings, signals: signals.slice(-400), paper, seq, pseq, market, lastScan,
      live: { open: LIVE.open.slice(-20), closed: LIVE.closed.slice(-100), balance: LIVE.balance }
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { log('Durum kaydedilemedi: ' + e.message); }
}

/* ── HTTP / mum verisi ────────────────────────────────────────────────────── */
async function fetchJson(url, opt = {}) {
  let last;
  const tries = opt.retries == null ? 2 : opt.retries;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), opt.timeout || 15000);
      const r = await fetch(url, {
        method: opt.method || 'GET',
        headers: Object.assign({ 'User-Agent': 'AlphaSon/1.0' }, opt.headers || {}),
        body: opt.body,
        signal: ctl.signal
      });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(350 * (i + 1));
    }
  }
  throw last || new Error('istek hatası');
}

let RATE_UNTIL = 0, RATE_LAST = 0;
async function rateGate() {
  const now = Date.now();
  const wait = Math.max(RATE_UNTIL - now, RATE_LAST + 140 - now);
  if (wait > 0) await sleep(wait);
  RATE_LAST = Date.now();
}
async function bitgetJson(url, opt) {
  const o = Object.assign({}, opt || {});
  const tries = Math.max(1, (o.retries == null ? 2 : o.retries) + 1);
  o.retries = 1;
  let last;
  for (let i = 0; i < tries; i++) {
    await rateGate();
    try { return await fetchJson(url, o); }
    catch (e) {
      last = e;
      if (/HTTP 429/.test(String(e && e.message))) {
        RATE_UNTIL = Math.max(RATE_UNTIL, Date.now() + 5000);
        if (i < tries - 1) await sleep(2500 * (i + 1));
      } else if (i < tries - 1) {
        await sleep(400 * (i + 1));
      }
    }
  }
  throw last || new Error('istek hatası');
}

const CANDLE_CACHE = new Map();
const CANDLE_INFLIGHT = new Map();
const CANDLE_TTL = { '1m': 8e3, '3m': 20e3, '5m': 30e3, '15m': 60e3, '30m': 2 * M1, '1h': 3 * M1, '2h': 6 * M1, '4h': 10 * M1, '1d': 30 * M1 };

async function getCandles(sym, tf, limit) {
  const lim = Math.max(60, Math.min(1000, Number(limit) || 300));
  const key = sym + ':' + tf + ':' + lim;
  const cached = CANDLE_CACHE.get(key);
  const ttl = CANDLE_TTL[tf] || 60e3;
  if (cached && Date.now() - cached.at < ttl) return cached.cs;
  if (CANDLE_INFLIGHT.has(key)) return CANDLE_INFLIGHT.get(key);
  const p = (async () => {
    try {
      const url = 'https://api.bitget.com/api/v2/mix/market/candles?symbol=' + encodeURIComponent(sym) +
        '&productType=USDT-FUTURES&granularity=' + (TF_GRAN[tf] || '5m') + '&limit=' + lim;
      const j = await bitgetJson(url, { timeout: 15000, retries: 2 });
      const arr = (j && Array.isArray(j.data) ? j.data : []).map(a => ({
        t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0, qv: Number(a[6]) || 0
      })).filter(x => x.t > 0 && Number.isFinite(x.c) && x.c > 0);
      arr.sort((a, b) => a.t - b.t);
      const out = [];
      for (const x of arr) if (!out.length || out[out.length - 1].t !== x.t) out.push(x);
      if (out.length) CANDLE_CACHE.set(key, { at: Date.now(), cs: out });
      return out.length ? out : (cached ? cached.cs : []);
    } catch (e) {
      logOnce('candle:' + key, 'Mum alınamadı ' + sym + ' ' + tf + ': ' + e.message, 60000);
      return cached ? cached.cs : [];
    } finally { CANDLE_INFLIGHT.delete(key); }
  })();
  CANDLE_INFLIGHT.set(key, p);
  return p;
}

let tickersAt = 0;
async function refreshTickers(force) {
  if (!force && Date.now() - tickersAt < 3500) return;
  try {
    const j = await bitgetJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { timeout: 15000 });
    const rows = j && Array.isArray(j.data) ? j.data : [];
    const next = new Map();
    for (const r of rows) {
      const sym = String(r.symbol || '').toUpperCase();
      if (!sym.endsWith('USDT') || isStock(sym)) continue;
      const last = num(r.lastPr), vol = num(r.usdtVolume != null ? r.usdtVolume : r.quoteVolume);
      if (!(last > 0) || !(vol > 0)) continue;
      next.set(sym, {
        sym, last, bid: num(r.bidPr), ask: num(r.askPr), chg24: num(r.change24h) * 100,
        vol, high: num(r.high24h), low: num(r.low24h), ts: num(r.ts, Date.now())
      });
    }
    if (next.size) { TICK = next; tickersAt = Date.now(); refreshUniverse(); }
  } catch (e) { logOnce('tickers', 'Ticker alınamadı: ' + e.message, 30000); }
}

function refreshUniverse() {
  const all = [...TICK.values()].filter(t => t.vol >= settings.minQuoteVol && t.last > 0);
  all.sort((a, b) => b.vol - a.vol);
  const top = all.slice(0, Math.max(10, settings.topN));
  const pool = all.slice(0, Math.min(all.length, Math.max(60, settings.topN)));
  pool.sort((a, b) => Math.abs(b.chg24) - Math.abs(a.chg24));
  const movers = pool.slice(0, 60);
  const b = all.slice(0, 50);
  const breadth = b.length ? b.filter(t => t.chg24 > 0).length / b.length : 0.5;
  UNIVERSE = { all, top, movers, breadth, at: Date.now() };
}

function priceOf(sym) { const t = TICK.get(sym); return t ? t.last : 0; }

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ── göstergeler ──────────────────────────────────────────────────────────── */
function emaArr(vals, len) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += Number(vals[i]) || 0;
  let e = sum / len;
  out[len - 1] = e;
  const k = 2 / (len + 1);
  for (let i = len; i < vals.length; i++) { e = (Number(vals[i]) || 0) * k + e * (1 - k); out[i] = e; }
  return out;
}

function atrArr(cs, len = 14) {
  const n = cs.length;
  const out = new Array(n).fill(null);
  if (n <= len) return out;
  const tr = [];
  for (let i = 0; i < n; i++) {
    tr.push(i === 0 ? cs[0].h - cs[0].l : Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  let a = avg(tr.slice(0, len));
  out[len - 1] = a;
  for (let i = len; i < n; i++) { a = (a * (len - 1) + tr[i]) / len; out[i] = a; }
  return out;
}

function adxArr(cs, len = 14) {
  const n = cs.length;
  const out = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
  if (n < len * 2 + 2) return out;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < n; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  let trS = 0, pS = 0, nS = 0;
  for (let i = 0; i < len; i++) { trS += tr[i]; pS += pdm[i]; nS += ndm[i]; }
  const dx = [];
  for (let i = len; i < tr.length; i++) {
    if (i > len) {
      trS = trS - trS / len + tr[i];
      pS = pS - pS / len + pdm[i];
      nS = nS - nS / len + ndm[i];
    }
    const pdi = trS > 0 ? 100 * pS / trS : 0;
    const mdi = trS > 0 ? 100 * nS / trS : 0;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0);
    const idx = i + 1;
    out.pdi[idx] = pdi; out.mdi[idx] = mdi;
    if (dx.length >= len) out.adx[idx] = avg(dx.slice(-len));
  }
  return out;
}

function rsiArr(closes, len = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= len) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (len - 1) + Math.max(d, 0)) / len;
    l = (l * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function bodyRatio(c) { const r = c.h - c.l; return r > 0 ? Math.abs(c.c - c.o) / r : 0; }

/* ── piyasa yönü ──────────────────────────────────────────────────────────── */
function assetScore(sym, cs15, cs1h) {
  if (!cs15 || cs15.length < 210 || !cs1h || cs1h.length < 55) {
    return { score: 0, dir: 'NOTR', why: 'veri yok', price: 0, metrics: {} };
  }
  const cl = cs15.map(c => c.c);
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
  const a = atrArr(cs15, 14), d = adxArr(cs15, 14);
  const i = cl.length - 1;
  const atr = a[i] || cl[i] * 0.005;
  const slope = (e20[i] - e20[i - 12]) / Math.max(atr, EPS);
  const cl1 = cs1h.map(c => c.c), h20 = emaArr(cl1, 20), h50 = emaArr(cl1, 50);
  const j = cl1.length - 1;
  let s = 0, w = 0;
  const add = (v, ww) => { s += v * ww; w += ww; };
  add(e20[i] > e50[i] ? 1 : -1, 1.2);
  add(cl[i] > e200[i] ? 1 : -1, 0.8);
  add(clamp(slope / 0.25, -1, 1), 1.0);
  const adx = d.adx[i] || 0, pdi = d.pdi[i] || 0, mdi = d.mdi[i] || 0;
  add(adx >= 18 ? (pdi > mdi ? 1 : -1) : 0, 1.0);
  add(cl1[j] > h50[j] ? 1 : -1, 0.8);
  add(h20[j] > h50[j] ? 1 : -1, 0.6);
  const score = clamp(w ? s / w : 0, -1, 1);
  const why = [
    e20[i] > e50[i] ? 'EMA20>EMA50' : 'EMA20<EMA50',
    'ADX ' + adx.toFixed(0),
    adx >= 18 ? (pdi > mdi ? '+DI' : '−DI') : 'yön zayıf',
    cl1[j] > h50[j] ? '1h üst' : '1h alt'
  ].join(', ');
  const t = TICK.get(sym);
  return {
    score, dir: score > 0.15 ? 'LONG' : score < -0.15 ? 'SHORT' : 'NOTR', why,
    price: cl[i], chg24: t ? t.chg24 : 0,
    metrics: {
      price: cl[i], ema20: e20[i], ema50: e50[i], ema200: e200[i], adx, pdi, mdi,
      slope: +slope.toFixed(2), h1: cl1[j], h1ema50: h50[j]
    }
  };
}

async function updateMarket() {
  const [b15, e15, b1h, e1h] = await Promise.all([
    getCandles('BTCUSDT', '15m', 260), getCandles('ETHUSDT', '15m', 260),
    getCandles('BTCUSDT', '1h', 160), getCandles('ETHUSDT', '1h', 160)
  ]);
  const btc = assetScore('BTCUSDT', b15, b1h);
  const eth = assetScore('ETHUSDT', e15, e1h);
  const breadth = UNIVERSE.breadth == null ? 0.5 : UNIVERSE.breadth;
  const raw = clamp(0.40 * btc.score + 0.35 * eth.score + 0.25 * (breadth * 2 - 1), -1, 1);
  let dir = market.dir;
  const enter = 0.22, hold = 0.08;
  if (raw >= enter) dir = 'LONG';
  else if (raw <= -enter) dir = 'SHORT';
  else if (dir === 'LONG' && raw < hold) dir = 'NOTR';
  else if (dir === 'SHORT' && raw > -hold) dir = 'NOTR';
  const why = 'BTC: ' + btc.why + ' | ETH: ' + eth.why + ' | Genişlik: %' + Math.round(breadth * 100) + ' pozitif';
  market = { dir, score: Math.round(50 + raw * 50), raw: +raw.toFixed(3), breadth, why, btc, eth, at: Date.now() };
  dirty = true;
}

/* ── TREND TAKİP: 15m rejim + 1h teyit + 5m tetik ─────────────────────────── */
function trendRegime(cs15, cs1h) {
  if (!cs15 || cs15.length < 210 || !cs1h || cs1h.length < 55) {
    return { dir: 'NOTR', ok: false, h1Ok: false, why: 'veri yok', adx: 0, pdi: 0, mdi: 0, atr: 0, slope: 0 };
  }
  const cl = cs15.map(c => c.c);
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
  const a = atrArr(cs15, 14), d = adxArr(cs15, 14);
  const i = cl.length - 1;
  const atr = a[i] || cl[i] * 0.005;
  const slope = (e20[i] - e20[i - 12]) / Math.max(atr, EPS);
  const cl1 = cs1h.map(c => c.c), h20 = emaArr(cl1, 20), h50 = emaArr(cl1, 50);
  const j = cl1.length - 1;
  const h1Long = cl1[j] > h50[j] && h20[j] >= h50[j];
  const h1Short = cl1[j] < h50[j] && h20[j] <= h50[j];
  const adx = d.adx[i] || 0, pdi = d.pdi[i] || 0, mdi = d.mdi[i] || 0;
  const long = e20[i] > e50[i] && cl[i] > e200[i] && adx >= 20 && pdi > mdi && slope > 0.05;
  const short = e20[i] < e50[i] && cl[i] < e200[i] && adx >= 20 && mdi > pdi && slope < -0.05;
  const dir = long ? 'LONG' : short ? 'SHORT' : 'NOTR';
  return {
    dir, ok: dir !== 'NOTR', h1Ok: dir === 'LONG' ? h1Long : dir === 'SHORT' ? h1Short : false,
    why: dir === 'NOTR' ? '15m rejim net değil' : (dir === 'LONG' ? '15m yükseliş rejimi' : '15m düşüş rejimi'),
    adx, pdi, mdi, atr, slope, e20: e20[i], e50: e50[i], e200: e200[i], price: cl[i]
  };
}

function trendAnalyze(sym, cs5, cs15, cs1h) {
  const reg = trendRegime(cs15, cs1h);
  if (!reg.ok) return null;
  if (market.dir !== reg.dir) return null;
  if (!cs5 || cs5.length < 60) return null;

  const cl5 = cs5.map(c => c.c);
  const e20 = emaArr(cl5, 20), e50 = emaArr(cl5, 50);
  const a = atrArr(cs5, 14), rsi = rsiArr(cl5, 14);
  const i = cl5.length - 1;
  const c = cs5[i - 1], prev = cs5[i - 2];
  if (!c || !prev) return null;
  const atr = a[i] || cl5[i] * 0.004;
  const px = priceOf(sym) || cs5[i].c;
  const dist = (px - e20[i]) / Math.max(atr, EPS);
  const volSma = avg(cs5.slice(Math.max(0, i - 21), i - 1).map(x => x.v));
  const volRatio = volSma > 0 ? c.v / volSma : 0;
  const body = bodyRatio(c), bodyA = Math.abs(c.c - c.o) / Math.max(atr, EPS);
  const recentHigh = Math.max(...cs5.slice(Math.max(0, i - 22), i - 1).map(x => x.h));
  const recentLow = Math.min(...cs5.slice(Math.max(0, i - 22), i - 1).map(x => x.l));
  const rsiNow = rsi[i] || 50;

  const base = {
    sym, base: baseOf(sym), tf: '5m', dir: reg.dir, px, ema20: e20[i], dist: +dist.toFixed(2),
    score: Math.round(clamp(55 + (reg.adx - 18) * 0.8 + (reg.h1Ok ? 8 : 0), 50, 90)),
    at: Date.now(), reasons: [reg.why]
  };

  if (!reg.h1Ok) {
    return { watch: Object.assign(base, { status: '1H TEYİT BEKLİYOR', trigger: null }) };
  }

  let trigger = null;
  if (reg.dir === 'LONG') {
    const pull = c.l <= e20[i] + 0.25 * atr && c.c > e20[i] && c.c > c.o;
    const brk = c.c > recentHigh && volRatio >= 1.2 && body >= 0.45 && bodyA >= 0.30;
    if (pull) trigger = 'EMA20 GERİ ÇEKİLME';
    else if (brk) trigger = '20 MUM KIRILIMI';
  } else {
    const pull = c.h >= e20[i] - 0.25 * atr && c.c < e20[i] && c.c < c.o;
    const brk = c.c < recentLow && volRatio >= 1.2 && body >= 0.45 && bodyA >= 0.30;
    if (pull) trigger = 'EMA20 GERİ ÇEKİLME';
    else if (brk) trigger = '20 MUM KIRILIMI';
  }

  if (!trigger) {
    return { watch: Object.assign(base, { status: 'TETİK BEKLİYOR', trigger: null }) };
  }
  if (dist > 1.6) {
    return { watch: Object.assign(base, { status: 'EMA20’DEN UZAK', trigger }) };
  }
  if (reg.dir === 'LONG' && rsiNow > 85) {
    return { watch: Object.assign(base, { status: 'RSI AŞIRI ALIM', trigger }) };
  }
  if (reg.dir === 'SHORT' && rsiNow < 15) {
    return { watch: Object.assign(base, { status: 'RSI AŞIRI SATIM', trigger }) };
  }
  if (Math.abs(px - c.c) > 0.75 * atr) {
    return { watch: Object.assign(base, { status: 'FİYAT KAÇTI', trigger }) };
  }

  const swing = reg.dir === 'LONG'
    ? Math.min(c.l, ...cs5.slice(Math.max(0, i - 9), i).map(x => x.l))
    : Math.max(c.h, ...cs5.slice(Math.max(0, i - 9), i).map(x => x.h));
  let sl = reg.dir === 'LONG' ? swing - 0.25 * atr : swing + 0.25 * atr;
  let riskPct = Math.abs(px - sl) / px * 100;
  if (riskPct < 0.30) {
    const dd = Math.max(0.5 * atr, px * 0.003);
    sl = reg.dir === 'LONG' ? px - dd : px + dd;
    riskPct = Math.abs(px - sl) / px * 100;
  }
  if (riskPct > 2.5) {
    return { watch: Object.assign(base, { status: 'STOP ÇOK GENİŞ', trigger }) };
  }
  if (!(reg.dir === 'LONG' ? sl < px : sl > px)) return null;

  const R = Math.abs(px - sl);
  const tp1 = reg.dir === 'LONG' ? px + 1.5 * R : px - 1.5 * R;
  const tp2 = reg.dir === 'LONG' ? px + 3.0 * R : px - 3.0 * R;

  let score = 55 + (reg.adx - 18) * 0.8 + (reg.h1Ok ? 8 : 0) + (volRatio > 1.2 ? 5 : 0) + (trigger === '20 MUM KIRILIMI' ? 5 : 0);
  score = Math.round(clamp(score, 50, 96));

  const reasons = [
    reg.why + ' (ADX ' + reg.adx.toFixed(0) + ')',
    reg.dir === 'LONG' ? '1h: fiyat EMA50 üzerinde' : '1h: fiyat EMA50 altında',
    trigger,
    'Hacim x' + volRatio.toFixed(1),
    'Piyasa yönü ' + market.dir
  ];
  const risks = [];
  if (rsiNow > 75) risks.push('5m RSI yüksek');
  if (dist > 1.0) risks.push('EMA20’den uzak');
  if (riskPct > 1.5) risks.push('Stop geniş');

  return {
    signal: {
      sym, base: baseOf(sym), tf: '5m', dir: reg.dir, entry: px, sl, tp1, tp2, score,
      setup: trigger, reasons, risks, trigger, market: market.dir,
      meta: { atr, riskPct: +riskPct.toFixed(3), adx: reg.adx, h1Ok: reg.h1Ok, dist: +dist.toFixed(2), volRatio: +volRatio.toFixed(2), rsi: +rsiNow.toFixed(1), regime: reg.dir }
    },
    watch: Object.assign(base, { status: 'SİNYAL', trigger, dir: reg.dir, score })
  };
}

let trendScanning = false;
async function trendScan() {
  if (trendScanning) return;
  trendScanning = true;
  try {
    const syms = UNIVERSE.top.slice(0, Math.min(60, settings.topN)).map(x => x.sym);
    const rows = [], cands = [];
    await pool(syms, 4, async sym => {
      const [cs15, cs1h, cs5] = await Promise.all([
        getCandles(sym, '15m', 260), getCandles(sym, '1h', 160), getCandles(sym, '5m', 220)
      ]);
      const r = trendAnalyze(sym, cs5, cs15, cs1h);
      if (!r) return;
      if (r.watch) rows.push(r.watch);
      if (r.signal) cands.push(r.signal);
    });
    rows.sort((a, b) => b.score - a.score);
    TREND_WATCH = rows.slice(0, 30);
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 4)) {
      const s = addSignal(Object.assign({ module: 'TREND' }, c));
      if (s) {
        const w = TREND_WATCH.find(x => x.sym === c.sym);
        if (w) w.status = 'SİNYAL';
      }
    }
    lastScan.trend = Date.now();
    log('Trend tarama: ' + syms.length + ' parite, ' + TREND_WATCH.length + ' aday, ' + cands.length + ' tetik');
  } finally { trendScanning = false; }
}

/* ── LT ÜÇGEN: simetrik üçgen + çizgi dokunuşu ────────────────────────────── */
function findPivots(cs, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < cs.length - right; i++) {
    let h = true, l = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) h = false;
      if (cs[j].l <= cs[i].l) l = false;
      if (!h && !l) break;
    }
    if (h) out.push({ i, p: cs[i].h, type: 'H', t: cs[i].t });
    if (l) out.push({ i, p: cs[i].l, type: 'L', t: cs[i].t });
  }
  return out;
}

function fitBestLine(points, cs, side, atr, n) {
  let best = null;
  const pts = points.filter(p => p.i >= n - 150);
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const p1 = pts[a], p2 = pts[b];
      if (p2.i - p1.i < 6) continue;
      if (p2.i < n - 80) continue;
      const slope = (p2.p - p1.p) / (p2.i - p1.i);
      if (side === 'H' && slope >= -0.002 * atr) continue;
      if (side === 'L' && slope <= 0.002 * atr) continue;
      const icpt = p1.p - slope * p1.i;
      const start = p1.i, end = n - 1;
      if (end - start < 12) continue;
      let inside = 0, touch = 0, viol = 0;
      for (let i = start; i <= end; i++) {
        const v = icpt + slope * i;
        if (side === 'H') {
          if (cs[i].c <= v + 0.15 * atr) inside++;
          if (Math.abs(cs[i].h - v) <= 0.30 * atr) touch++;
          if (cs[i].c > v + 0.45 * atr) viol++;
        } else {
          if (cs[i].c >= v - 0.15 * atr) inside++;
          if (Math.abs(cs[i].l - v) <= 0.30 * atr) touch++;
          if (cs[i].c < v - 0.45 * atr) viol++;
        }
      }
      const span = end - start + 1;
      const insideRatio = inside / span;
      if (insideRatio < 0.70 || touch < 2 || viol > 2) continue;
      const score = insideRatio * 50 + Math.min(touch, 7) * 7 + Math.min(span, 100) * 0.25 - viol * 7;
      if (!best || score > best.score) best = { p1, p2, slope, icpt, start, end, touch, viol, insideRatio, score };
    }
  }
  return best;
}

function detectTriangle(cs, tf) {
  const n = cs.length;
  if (n < 80) return null;
  const atr = atrArr(cs, 14)[n - 1] || cs[n - 1].c * 0.01;
  const piv = findPivots(cs, 3, 3);
  const highs = piv.filter(p => p.type === 'H');
  const lows = piv.filter(p => p.type === 'L');
  if (highs.length < 2 || lows.length < 2) return null;
  const hi = fitBestLine(highs, cs, 'H', atr, n);
  const lo = fitBestLine(lows, cs, 'L', atr, n);
  if (!hi || !lo) return null;
  const start = Math.max(hi.start, lo.start), end = n - 1;
  if (end - start < 12) return null;
  const hiAt = i => hi.icpt + hi.slope * i;
  const loAt = i => lo.icpt + lo.slope * i;
  const w0 = hiAt(start) - loAt(start), wNow = hiAt(end) - loAt(end);
  if (w0 < 1.0 * atr || wNow < 0.06 * atr || wNow > 0.88 * w0) return null;
  const apex = (lo.icpt - hi.icpt) / (hi.slope - lo.slope);
  if (!Number.isFinite(apex) || apex < end - 1 || apex > end + 60) return null;
  const ratio = Math.abs(hi.slope) / Math.max(Math.abs(lo.slope), EPS);
  if (ratio < 0.25 || ratio > 4) return null;
  if (Math.abs(hi.slope) < 0.002 * atr || Math.abs(lo.slope) < 0.002 * atr) return null;

  let inside = 0, span = 0;
  for (let i = start; i <= end; i++) {
    const u = hiAt(i), l = loAt(i);
    if (cs[i].c <= u + 0.20 * atr && cs[i].c >= l - 0.20 * atr) inside++;
    span++;
  }
  const containment = span ? inside / span : 0;
  if (containment < 0.68) return null;

  const touchesHi = hi.touch, touchesLo = lo.touch;
  const score = clamp(Math.round(45 + Math.min(touchesHi + touchesLo, 10) * 3 + containment * 20 + Math.min(end - start, 80) * 0.2), 50, 98);

  const from = Math.max(0, start - 5);
  const to = Math.min(end + 30, Math.floor(apex) + 2);
  const upper = [], lower = [];
  const lastT = cs[n - 1].t;
  const tfMs = TF_MS[tf] || M5;
  for (let i = from; i <= to; i += (i < end ? 1 : 2)) {
    const t = i < n ? cs[i].t : lastT + (i - (n - 1)) * tfMs;
    upper.push({ time: Math.floor(t / 1000), value: +hiAt(i).toFixed(8) });
    lower.push({ time: Math.floor(t / 1000), value: +loAt(i).toFixed(8) });
  }

  return {
    tf, atr, start, end, apex,
    apexT: Math.floor((lastT + (apex - (n - 1)) * tfMs) / 1000),
    hiSlope: hi.slope, hiIcpt: hi.icpt, loSlope: lo.slope, loIcpt: lo.icpt,
    upperNow: hiAt(end), lowerNow: loAt(end), w0, wNow,
    touchesHi, touchesLo, containment: +containment.toFixed(3), score,
    refIdx: end, refT: lastT, upper, lower
  };
}

function ltAnalyze(sym, tf, cs) {
  const tri = detectTriangle(cs, tf);
  if (!tri) return null;
  const n = cs.length, atr = tri.atr;
  const c = cs[n - 2], px = priceOf(sym) || cs[n - 1].c;
  if (!c) return null;
  const iC = n - 2;
  const upperC = tri.hiIcpt + tri.hiSlope * iC;
  const lowerC = tri.loIcpt + tri.loSlope * iC;
  const bodyA = Math.abs(c.c - c.o) / Math.max(atr, EPS);
  const volSma = avg(cs.slice(Math.max(0, n - 22), n - 2).map(x => x.v));
  const volRatio = volSma > 0 ? c.v / volSma : 0;
  const side = c.c > upperC + 0.05 * atr ? 'ABOVE' : c.c < lowerC - 0.05 * atr ? 'BELOW' : 'IN';
  const nearUpper = Math.abs(px - upperC) <= 0.18 * atr;
  const nearLower = Math.abs(px - lowerC) <= 0.18 * atr;

  let dir = null, status = 'KIRILIM BEKLENİYOR';
  if (side === 'ABOVE' && c.c - upperC <= 0.9 * atr && bodyA >= 0.20 && volRatio >= 0.7) { dir = 'LONG'; status = 'ÜST ÇİZGİ KIRILDI'; }
  if (side === 'BELOW' && lowerC - c.c <= 0.9 * atr && bodyA >= 0.20 && volRatio >= 0.7) { dir = 'SHORT'; status = 'ALT ÇİZGİ KIRILDI'; }
  if (!dir && side === 'IN') status = (nearUpper || nearLower) ? 'ÇİZGİYE DEĞDİ' : 'KIRILIM BEKLENİYOR';

  const watch = {
    sym, base: baseOf(sym), tf, dir: dir || (side === 'ABOVE' ? 'LONG' : side === 'BELOW' ? 'SHORT' : 'NOTR'),
    status, px, upper: +upperC.toFixed(8), lower: +lowerC.toFixed(8), width: +(upperC - lowerC).toFixed(8),
    touchesHi: tri.touchesHi, touchesLo: tri.touchesLo, score: tri.score, apexT: tri.apexT,
    side, nearUpper, nearLower, at: Date.now(), triangle: tri,
    refIdx: tri.refIdx, refT: tri.refT, hiSlope: tri.hiSlope, hiIcpt: tri.hiIcpt,
    loSlope: tri.loSlope, loIcpt: tri.loIcpt, atr
  };
  if (!dir) return { watch };

  const upperNow = tri.hiIcpt + tri.hiSlope * (n - 1);
  const lowerNow = tri.loIcpt + tri.loSlope * (n - 1);
  const h = tri.w0;
  let entry = px, sl, tp1, tp2;
  if (dir === 'LONG') {
    sl = upperNow - 0.55 * atr;
    if (sl >= entry - 0.2 * atr) sl = entry - 0.8 * atr;
    const risk = entry - sl;
    if (risk <= 0) return { watch };
    tp1 = entry + Math.max(0.6 * h, 1.2 * risk);
    tp2 = entry + Math.max(1.2 * h, 2.4 * risk);
  } else {
    sl = lowerNow + 0.55 * atr;
    if (sl <= entry + 0.2 * atr) sl = entry + 0.8 * atr;
    const risk = sl - entry;
    if (risk <= 0) return { watch };
    tp1 = entry - Math.max(0.6 * h, 1.2 * risk);
    tp2 = entry - Math.max(1.2 * h, 2.4 * risk);
  }
  const riskPct = Math.abs(entry - sl) / entry * 100;
  if (riskPct > 3.5) return { watch };

  const reasons = [
    'Simetrik üçgen (' + tri.touchesHi + ' üst / ' + tri.touchesLo + ' alt temas)',
    dir === 'LONG' ? 'Üst çizgi kırıldı' : 'Alt çizgi kırıldı',
    'Ölçülü hareket hedefi'
  ];
  const risks = [];
  if (volRatio < 1) risks.push('Hacim zayıf');
  if (bodyA < 0.35) risks.push('Mum gövdesi zayıf');
  if (riskPct > 2.5) risks.push('Stop geniş');

  return {
    signal: {
      sym, base: baseOf(sym), tf, dir, entry, sl, tp1, tp2, score: Math.min(98, tri.score + 8),
      setup: 'SİMETRİK ÜÇGEN', reasons, risks, trigger: dir === 'LONG' ? 'ÜST ÇİZGİ' : 'ALT ÇİZGİ',
      market: market.dir,
      meta: { atr, riskPct: +riskPct.toFixed(3), volRatio: +volRatio.toFixed(2), bodyA: +bodyA.toFixed(2), triangle: { upper: tri.upper, lower: tri.lower, apexT: tri.apexT, touchesHi: tri.touchesHi, touchesLo: tri.touchesLo } }
    },
    watch: Object.assign(watch, { dir, status })
  };
}

function buildLtSignal(w, dir, px) {
  const atr = w.atr, h = w.width > 0 ? w.width : Math.abs(w.upper - w.lower);
  let entry = px, sl, tp1, tp2;
  if (dir === 'LONG') {
    sl = w.upper - 0.55 * atr;
    if (sl >= entry - 0.2 * atr) sl = entry - 0.8 * atr;
    const risk = entry - sl;
    if (risk <= 0) return null;
    tp1 = entry + Math.max(0.6 * h, 1.2 * risk);
    tp2 = entry + Math.max(1.2 * h, 2.4 * risk);
  } else {
    sl = w.lower + 0.55 * atr;
    if (sl <= entry + 0.2 * atr) sl = entry + 0.8 * atr;
    const risk = sl - entry;
    if (risk <= 0) return null;
    tp1 = entry - Math.max(0.6 * h, 1.2 * risk);
    tp2 = entry - Math.max(1.2 * h, 2.4 * risk);
  }
  const riskPct = Math.abs(entry - sl) / entry * 100;
  if (riskPct > 3.5) return null;
  return {
    sym: w.sym, base: w.base, tf: w.tf, dir, entry, sl, tp1, tp2, score: Math.min(98, w.score + 10),
    setup: 'SİMETRİK ÜÇGEN DOKUNUŞ',
    reasons: ['Simetrik üçgen', dir === 'LONG' ? 'Üst çizgiye dokunuş/kırılım' : 'Alt çizgiye dokunuş/kırılım', 'Ölçülü hareket hedefi'],
    risks: riskPct > 2.5 ? ['Stop geniş'] : [],
    trigger: dir === 'LONG' ? 'ÜST ÇİZGİ DOKUNUŞU' : 'ALT ÇİZGİ DOKUNUŞU', market: market.dir,
    meta: { atr, riskPct: +riskPct.toFixed(3), triangle: { upper: w.triangle.upper, lower: w.triangle.lower, apexT: w.triangle.apexT, touchesHi: w.touchesHi, touchesLo: w.touchesLo } }
  };
}

let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const syms = UNIVERSE.top.slice(0, Math.min(50, settings.topN)).map(x => x.sym);
    const tfs = settings.ltTfs.length ? settings.ltTfs : ['2h'];
    const rows = [], cands = [];
    await pool(syms, 4, async sym => {
      for (const tf of tfs) {
        const limit = tf === '2h' ? LT_BARS : tf === '1h' ? 400 : 300;
        const cs = await getCandles(sym, tf, limit);
        if (cs.length < 80) continue;
        const r = ltAnalyze(sym, tf, cs);
        if (!r) continue;
        if (r.watch) rows.push(r.watch);
        if (r.signal) cands.push(r.signal);
      }
    });
    rows.sort((a, b) => b.score - a.score);
    LT_WATCH = rows.slice(0, 40);
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 3)) {
      const s = addSignal(Object.assign({ module: 'LT' }, c));
      if (s) {
        const w = LT_WATCH.find(x => x.sym === c.sym && x.tf === c.tf);
        if (w) w.fired = true;
      }
    }
    lastScan.lt = Date.now();
    log('LT tarama: ' + syms.length + ' parite, ' + LT_WATCH.length + ' üçgen, ' + cands.length + ' kırılım');
  } finally { ltScanning = false; }
}

async function ltTick() {
  if (!LT_WATCH.length) return;
  const now = Date.now();
  for (const w of LT_WATCH) {
    if (w.fired) continue;
    const tfMs = TF_MS[w.tf] || 2 * H1;
    const idx = w.refIdx + Math.max(0, Math.floor((now - w.refT) / tfMs));
    const upper = w.hiIcpt + w.hiSlope * idx;
    const lower = w.loIcpt + w.loSlope * idx;
    const px = priceOf(w.sym);
    if (!px) continue;
    w.px = px; w.upper = upper; w.lower = lower;
    w.nearUpper = Math.abs(px - upper) <= 0.12 * w.atr;
    w.nearLower = Math.abs(px - lower) <= 0.12 * w.atr;
    let dir = null;
    if (px > upper + 0.03 * w.atr) {
      if (w.side !== 'ABOVE') dir = 'LONG';
      w.side = 'ABOVE';
    } else if (px < lower - 0.03 * w.atr) {
      if (w.side !== 'BELOW') dir = 'SHORT';
      w.side = 'BELOW';
    } else {
      w.side = 'IN';
    }
    if (!dir) continue;
    if (!canAdd('LT', w.sym)) { w.fired = true; continue; }
    const sig = buildLtSignal(w, dir, px);
    if (sig) {
      const added = addSignal(Object.assign({ module: 'LT' }, sig));
      if (added) { w.fired = true; log('LT dokunuş sinyali: ' + w.sym + ' ' + dir); }
    }
  }
  LT_WATCH = LT_WATCH.filter(w => !w.fired && now - w.at < 3 * H1);
}

/* ── OTOTRADE: 1m pump/dump ───────────────────────────────────────────────── */
function autoAnalyze(sym, cs1m, cs5) {
  const n = cs1m.length;
  if (n < 40 || !cs5 || cs5.length < 60) return null;
  const c = cs1m[n - 2], base = cs1m[n - 5];
  if (!c || !base) return null;
  const chg3 = (c.c - base.c) / base.c * 100;
  const atr1 = atrArr(cs1m, 14)[n - 2] || c.c * 0.003;
  const volSma = avg(cs1m.slice(Math.max(0, n - 22), n - 2).map(x => x.v));
  const volRatio = volSma > 0 ? c.v / volSma : 0;
  const body = bodyRatio(c), bodyA = Math.abs(c.c - c.o) / Math.max(atr1, EPS);
  const cl5 = cs5.map(x => x.c), e20 = emaArr(cl5, 20), e50 = emaArr(cl5, 50), atr5 = atrArr(cs5, 14);
  const i5 = cl5.length - 1, a5 = atr5[i5] || c.c * 0.005;
  const px = priceOf(sym) || cs1m[n - 1].c;
  const t = TICK.get(sym) || {};
  const chg24 = num(t.chg24, 0);
  const up = e20[i5] > e50[i5], dn = e20[i5] < e50[i5];
  const range = Math.max(c.h - c.l, EPS);
  const nearHigh = c.c >= c.h - 0.25 * range;
  const nearLow = c.c <= c.l + 0.25 * range;

  let dir = null, setup = null;
  if (chg3 >= 0.6 && volRatio >= 1.8 && body >= 0.45 && bodyA >= 0.35 && nearHigh && up && chg24 < 12 && chg24 > -8 && (c.c - e20[i5]) <= 2.0 * a5) { dir = 'LONG'; setup = 'PUMP'; }
  if (chg3 <= -0.6 && volRatio >= 1.8 && body >= 0.45 && bodyA >= 0.35 && nearLow && dn && chg24 > -12 && chg24 < 8 && (e20[i5] - c.c) <= 2.0 * a5) { dir = 'SHORT'; setup = 'DUMP'; }

  if (!dir) {
    if (Math.abs(chg3) >= 0.3 && volRatio >= 1.3) {
      return {
        watch: {
          sym, base: baseOf(sym), tf: '1m', dir: chg3 > 0 ? 'LONG' : 'SHORT', status: 'İVME İZLENİYOR',
          chg3: +chg3.toFixed(2), volRatio: +volRatio.toFixed(2), score: Math.min(90, Math.round(40 + Math.abs(chg3) * 10 + volRatio * 5)),
          px, at: Date.now()
        }
      };
    }
    return null;
  }
  if (market.dir !== dir) return null;

  const swing = dir === 'LONG'
    ? Math.min(...cs1m.slice(Math.max(0, n - 8), n - 1).map(x => x.l))
    : Math.max(...cs1m.slice(Math.max(0, n - 8), n - 1).map(x => x.h));
  let sl = dir === 'LONG' ? swing - 0.3 * atr1 : swing + 0.3 * atr1;
  let risk = Math.abs(px - sl);
  if (risk < 0.4 * atr1) { sl = dir === 'LONG' ? px - 0.5 * atr1 : px + 0.5 * atr1; risk = Math.abs(px - sl); }
  const riskPct = risk / px * 100;
  if (riskPct > 1.8) return null;
  if (!(dir === 'LONG' ? sl < px : sl > px)) return null;

  const tp1 = dir === 'LONG' ? px + 1.0 * risk : px - 1.0 * risk;
  const tp2 = dir === 'LONG' ? px + 2.0 * risk : px - 2.0 * risk;
  const score = Math.round(clamp(55 + Math.abs(chg3) * 8 + volRatio * 6 + body * 10, 55, 97));
  const reasons = [
    '1m ivme ' + chg3.toFixed(2) + '%',
    'Hacim x' + volRatio.toFixed(1),
    'Gövde %' + Math.round(body * 100),
    dir === 'LONG' ? '5m EMA20>EMA50' : '5m EMA20<EMA50'
  ];
  const risks = [];
  if (riskPct > 1.2) risks.push('Stop geniş');
  if (Math.abs(chg24) > 8) risks.push('24s hareket büyük');

  return {
    signal: {
      sym, base: baseOf(sym), tf: '1m', dir, entry: px, sl, tp1, tp2, score, setup, reasons, risks,
      trigger: setup, market: market.dir,
      meta: { atr: atr1, chg3: +chg3.toFixed(2), volRatio: +volRatio.toFixed(2), bodyA: +bodyA.toFixed(2), riskPct: +riskPct.toFixed(2), chg24: +chg24.toFixed(2) }
    },
    watch: { sym, base: baseOf(sym), tf: '1m', dir, status: 'SİNYAL', chg3: +chg3.toFixed(2), volRatio: +volRatio.toFixed(2), score, px, at: Date.now() }
  };
}

let autoScanning = false;
async function autoScan() {
  if (autoScanning) return;
  autoScanning = true;
  try {
    const syms = UNIVERSE.movers.slice(0, 40).map(x => x.sym);
    const rows = [], cands = [];
    await pool(syms, 5, async sym => {
      const [cs1, cs5] = await Promise.all([getCandles(sym, '1m', 140), getCandles(sym, '5m', 140)]);
      const r = autoAnalyze(sym, cs1, cs5);
      if (!r) return;
      if (r.watch) rows.push(r.watch);
      if (r.signal) cands.push(r.signal);
    });
    rows.sort((a, b) => b.score - a.score);
    AUTO_WATCH = rows.slice(0, 30);
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 3)) addSignal(Object.assign({ module: 'AUTO' }, c));
    lastScan.auto = Date.now();
  } finally { autoScanning = false; }
}

/* ── sinyal deposu ────────────────────────────────────────────────────────── */
function canAdd(module, sym) {
  const now = Date.now();
  if (signals.some(s => s.module === module && s.sym === sym && !s.closed)) return false;
  const last = signals.filter(s => s.module === module && s.sym === sym).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - last.createdAt < COOLDOWN[module]) return false;
  const today = dayKey(now);
  const count = signals.filter(s => s.module === module && s.sym === sym && dayKey(s.createdAt) === today).length;
  return count < MAX_DAY_SYM[module];
}

function addSignal(raw) {
  if (!raw || !ACTIVE_MODULES.includes(raw.module)) return null;
  const mod = raw.module;
  if (!canAdd(mod, raw.sym)) return null;
  const dir = raw.dir === 'LONG' ? 'LONG' : raw.dir === 'SHORT' ? 'SHORT' : null;
  if (!dir) return null;
  const entry = num(raw.entry), sl = num(raw.sl), tp1 = num(raw.tp1), tp2 = num(raw.tp2);
  if (!(entry > 0 && sl > 0 && tp1 > 0 && tp2 > 0)) return null;
  if (dir === 'LONG' && !(sl < entry && entry < tp1 && tp1 < tp2)) return null;
  if (dir === 'SHORT' && !(sl > entry && entry > tp1 && tp1 > tp2)) return null;
  const px = priceOf(raw.sym) || entry;
  const atr = num(raw.meta && raw.meta.atr) || entry * 0.005;
  if (Math.abs(px - entry) > Math.max(atr * 1.2, entry * 0.01)) return null;

  const sig = {
    id: 'S' + (++seq), module: mod, sym: raw.sym, base: raw.base || baseOf(raw.sym), dir,
    tf: raw.tf || MODULES[mod].tf, setup: raw.setup || '', entry, sl, sl0: sl, tp1, tp2,
    score: clamp(Math.round(num(raw.score, 60)), 0, 100),
    reasons: Array.isArray(raw.reasons) ? raw.reasons.slice(0, 6) : [],
    risks: Array.isArray(raw.risks) ? raw.risks.slice(0, 4) : [],
    trigger: raw.trigger || '', market: raw.market || market.dir, meta: raw.meta || {},
    status: 'ACIK', closed: false, createdAt: Date.now(), closedAt: null, exit: null, finalPct: 0,
    curPct: 0, maxPct: null, minPct: null, maxR: null, minR: null, tp1Hit: false, ai: null, tradeable: mod === 'AUTO'
  };
  signals.push(sig);
  if (signals.length > 400) signals.splice(0, signals.length - 400);
  dirty = true;
  log('SİNYAL ' + MODULES[mod].label + ' ' + sig.sym + ' ' + dir + ' giriş ' + entry + ' stop ' + sl + ' tp1 ' + tp1 + ' tp2 ' + tp2 + ' (' + sig.score + ')');
  if (mod === 'AUTO' && settings.autoTrade) {
    if (settings.tradeMode === 'live' && liveReady()) liveOpen(sig).catch(e => log('Canlı açılış: ' + e.message));
    else openPaper(sig);
  }
  if (settings.aiEnabled) setTimeout(() => aiComment(sig).catch(() => {}), 1500);
  return sig;
}

function closeSignal(s, result, exitPx) {
  if (!s || s.closed) return;
  s.closed = true; s.status = result; s.closedAt = Date.now(); s.exit = num(exitPx);
  const d = s.dir === 'LONG' ? 1 : -1;
  s.finalPct = +(((s.exit - s.entry) / s.entry * 100) * d).toFixed(4);
  s.curPct = s.finalPct;
  dirty = true;
  log('KAPANDI ' + s.sym + ' ' + s.dir + ' ' + (RES[result] || result) + ' ' + s.finalPct + '%');
}

function monitorSignals() {
  const now = Date.now();
  for (const s of signals) {
    if (s.closed) continue;
    const px = priceOf(s.sym);
    if (!px) continue;
    const d = s.dir === 'LONG' ? 1 : -1;
    const pct = (px - s.entry) / s.entry * 100 * d;
    s.curPct = +pct.toFixed(4);
    if (s.maxPct == null || pct > s.maxPct) s.maxPct = +pct.toFixed(4);
    if (s.minPct == null || pct < s.minPct) s.minPct = +pct.toFixed(4);
    const risk = Math.abs(s.entry - s.sl0);
    if (risk > 0) {
      const r = (px - s.entry) / risk * d;
      if (s.maxR == null || r > s.maxR) s.maxR = +r.toFixed(2);
      if (s.minR == null || r < s.minR) s.minR = +r.toFixed(2);
    }
    if (d === 1 ? px >= s.tp2 : px <= s.tp2) { closeSignal(s, 'TP2', s.tp2); continue; }
    if (d === 1 ? px <= s.sl : px >= s.sl) { closeSignal(s, s.tp1Hit ? 'BE' : 'SL', s.sl); continue; }
    if (!s.tp1Hit && (d === 1 ? px >= s.tp1 : px <= s.tp1)) {
      s.tp1Hit = true; s.status = 'TP1'; s.sl = s.entry; s.tp1At = now; dirty = true;
      log('HEDEF 1 ' + s.sym + ' ' + s.dir + ' +' + pct.toFixed(2) + '%');
      continue;
    }
    if (now - s.createdAt > (MAX_HOLD[s.module] || 12 * H1)) closeSignal(s, 'TIME', px);
  }
}

/* ── paper işlem (yalnız AUTO) ────────────────────────────────────────────── */
function openPaper(sig) {
  if (paper.open.length >= settings.autoMaxOpen) return null;
  if (paper.open.some(p => p.sigId === sig.id)) return null;
  const qty = (settings.margin * settings.leverage) / sig.entry;
  const pos = {
    id: 'P' + (++pseq), sigId: sig.id, sym: sig.sym, dir: sig.dir, entry: sig.entry, sl: sig.sl,
    tp1: sig.tp1, tp2: sig.tp2, qty, margin: settings.margin, leverage: settings.leverage,
    openedAt: Date.now(), status: 'ACIK', closed: false, tp1Done: false, pnl: 0, curPct: 0
  };
  paper.open.push(pos);
  dirty = true;
  log('PAPER AÇILDI ' + pos.sym + ' ' + pos.dir + ' ' + qty.toFixed(4) + ' @ ' + pos.entry);
  return pos;
}

function paperPart(pos, price, portion, result) {
  const qty = pos.qty * portion;
  const d = pos.dir === 'LONG' ? 1 : -1;
  const gross = (price - pos.entry) * qty * d;
  const fee = (pos.entry * qty + price * qty) * 0.0006;
  const pnl = gross - fee;
  paper.equity += pnl;
  pos.pnl += pnl;
  paper.closed.push({
    id: pos.id + '-' + result + '-' + Date.now(), sigId: pos.sigId, sym: pos.sym, dir: pos.dir,
    entry: pos.entry, exit: price, qty, result, pnl: +pnl.toFixed(4), closedAt: Date.now()
  });
  if (paper.closed.length > 200) paper.closed.splice(0, paper.closed.length - 200);
  dirty = true;
}

function paperTp1(pos, price) {
  paperPart(pos, price, 0.5, 'TP1');
  pos.qty *= 0.5;
  pos.tp1Done = true; pos.sl = pos.entry; pos.status = 'TP1';
  log('PAPER HEDEF 1 ' + pos.sym + ' ' + pos.dir);
}

function paperClose(pos, price, result) {
  paperPart(pos, price, 1, result);
  pos.closed = true; pos.status = result; pos.exit = price; pos.closedAt = Date.now();
  paper.open = paper.open.filter(p => p.id !== pos.id);
  log('PAPER KAPANDI ' + pos.sym + ' ' + pos.dir + ' ' + (RES[result] || result));
}

function paperRoll() {
  const k = dayKey();
  if (paper.dayKey !== k) { paper.dayKey = k; paper.dayStart = paper.equity; dirty = true; }
}

function monitorPaper() {
  paperRoll();
  for (const pos of [...paper.open]) {
    const px = priceOf(pos.sym);
    if (!px) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.curPct = +(((px - pos.entry) / pos.entry * 100) * d).toFixed(3);
    if (d === 1 ? px <= pos.sl : px >= pos.sl) { paperClose(pos, pos.sl, pos.tp1Done ? 'BE' : 'SL'); continue; }
    if (d === 1 ? px >= pos.tp2 : px <= pos.tp2) { paperClose(pos, pos.tp2, 'TP2'); continue; }
    if (!pos.tp1Done && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) { paperTp1(pos, pos.tp1); continue; }
    if (Date.now() - pos.openedAt > 4 * H1) paperClose(pos, px, 'TIME');
  }
}

function paperSummary() {
  const dayPnl = paper.equity - paper.dayStart;
  return {
    equity: +paper.equity.toFixed(2), start: +paper.start.toFixed(2), dayPnl: +dayPnl.toFixed(2),
    dayPct: paper.dayStart > 0 ? +(dayPnl / paper.dayStart * 100).toFixed(2) : 0,
    open: paper.open.map(p => Object.assign({}, p)), closed: paper.closed.slice(-40).reverse(),
    openCount: paper.open.length
  };
}

/* ── canlı işlem (Bitget / ccxt) ──────────────────────────────────────────── */
let _ex = null;
async function getExchange() {
  if (_ex) return _ex;
  if (!HAS_KEYS) throw new Error('Bitget anahtarı yok');
  const ccxt = require('ccxt');
  _ex = new ccxt.bitget({ apiKey: API_KEY, secret: API_SECRET, password: API_PASS, enableRateLimit: true, options: { defaultType: 'swap' } });
  await _ex.loadMarkets();
  return _ex;
}

function toCcxt(sym) { return baseOf(sym) + '/USDT:USDT'; }
function liveReady() { return HAS_KEYS && !!API_TOKEN && settings.tradeMode === 'live'; }

async function liveOpen(sig) {
  if (!liveReady()) return null;
  try {
    const ex = await getExchange();
    const symbol = toCcxt(sig.sym);
    await ex.setMarginMode('isolated', symbol);
    await ex.setLeverage(settings.leverage, symbol);
    const px = priceOf(sig.sym) || sig.entry;
    const amount = ex.amountToPrecision(symbol, (settings.margin * settings.leverage) / px);
    const side = sig.dir === 'LONG' ? 'buy' : 'sell';
    const params = { stopLossPrice: sig.sl, takeProfitPrice: sig.tp2, reduceOnly: false };
    const order = await ex.createOrder(symbol, 'market', side, amount, undefined, params);
    const pos = {
      id: 'L' + (++pseq), sigId: sig.id, sym: sig.sym, dir: sig.dir, entry: num(order.average, px),
      sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, contracts: num(order.amount, Number(amount)),
      margin: settings.margin, leverage: settings.leverage, openedAt: Date.now(), status: 'ACIK',
      orderId: order.id || null, curPct: 0
    };
    LIVE.open.push(pos);
    dirty = true;
    log('CANLI AÇILDI ' + pos.sym + ' ' + pos.dir + ' ' + pos.contracts + ' @ ' + pos.entry);
    return pos;
  } catch (e) {
    LIVE.lastError = e.message;
    log('Canlı giriş hatası: ' + e.message);
    return null;
  }
}

function finalizeLive(pos, px, result) {
  pos.closed = true; pos.status = result; pos.exit = px; pos.closedAt = Date.now();
  const d = pos.dir === 'LONG' ? 1 : -1;
  pos.pnlPct = +(((px - pos.entry) / pos.entry * 100) * d).toFixed(3);
  LIVE.closed.push(pos);
  if (LIVE.closed.length > 100) LIVE.closed.splice(0, LIVE.closed.length - 100);
  LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
  dirty = true;
  log('CANLI KAPANDI ' + pos.sym + ' ' + pos.dir + ' ' + (RES[result] || result) + ' ' + pos.pnlPct + '%');
}

async function fetchLiveBalance() {
  if (!HAS_KEYS) return null;
  try {
    const ex = await getExchange();
    const b = await ex.fetchBalance();
    const total = num(b.total && b.total.USDT), free = num(b.free && b.free.USDT), used = num(b.used && b.used.USDT);
    LIVE.balance = { total, free, used, at: Date.now() };
    return LIVE.balance;
  } catch (e) { LIVE.lastError = e.message; logOnce('live-bal', 'Bakiye: ' + e.message, 60000); return LIVE.balance; }
}

async function syncLive() {
  if (!HAS_KEYS) return { error: 'Bitget anahtarı yok' };
  if (LIVE.busy) return { error: 'senkron zaten çalışıyor' };
  LIVE.busy = true;
  try {
    const ex = await getExchange();
    const positions = await ex.fetchPositions();
    LIVE.positions = positions.filter(p => Math.abs(num(p.contracts)) > 0).map(p => ({
      symbol: p.symbol, side: p.side, contracts: num(p.contracts), entryPrice: num(p.entryPrice),
      markPrice: num(p.markPrice), unrealizedPnl: num(p.unrealizedPnl), leverage: num(p.leverage)
    }));
    for (const pos of [...LIVE.open]) {
      const p = positions.find(x => x.symbol === toCcxt(pos.sym) && Math.abs(num(x.contracts)) > 0);
      if (!p) {
        const px = priceOf(pos.sym) || pos.entry;
        const d = pos.dir === 'LONG' ? 1 : -1;
        const hitTp = (px - pos.tp2) * d >= 0, hitSl = (pos.sl - px) * d >= 0;
        finalizeLive(pos, px, hitTp ? 'TP2' : hitSl ? 'SL' : 'MANUEL');
      } else {
        pos.contracts = num(p.contracts); pos.entry = num(p.entryPrice, pos.entry);
        pos.curPct = +(((priceOf(pos.sym) || pos.entry) - pos.entry) / pos.entry * 100 * (pos.dir === 'LONG' ? 1 : -1)).toFixed(3);
      }
    }
    await fetchLiveBalance();
    LIVE.lastSync = Date.now();
    return { open: LIVE.open, positions: LIVE.positions, balance: LIVE.balance };
  } catch (e) {
    LIVE.lastError = e.message;
    return { error: e.message };
  } finally { LIVE.busy = false; }
}

async function closeLive(pos) {
  try {
    const ex = await getExchange();
    const symbol = toCcxt(pos.sym);
    const side = pos.dir === 'LONG' ? 'sell' : 'buy';
    const amount = ex.amountToPrecision(symbol, pos.contracts || 0);
    await ex.createOrder(symbol, 'market', side, amount, undefined, { reduceOnly: true });
    finalizeLive(pos, priceOf(pos.sym) || pos.entry, 'MANUEL');
    return { ok: true };
  } catch (e) { LIVE.lastError = e.message; return { error: e.message }; }
}

let liveBusy = false, liveLast = 0;
async function monitorLive() {
  if (!liveReady() || liveBusy || !LIVE.open.length || Date.now() - liveLast < 15000) return;
  liveBusy = true; liveLast = Date.now();
  try { await syncLive(); } catch (e) { /* syncLive yakalar */ }
  finally { liveBusy = false; }
}

function liveSummary() {
  return {
    ready: liveReady(), hasKeys: HAS_KEYS, token: !!API_TOKEN, mode: settings.tradeMode,
    open: LIVE.open, closed: LIVE.closed.slice(-30).reverse(), balance: LIVE.balance,
    positions: LIVE.positions, lastSync: LIVE.lastSync, lastError: LIVE.lastError
  };
}

/* ── AI (yalnız yorum; karar vermez) ──────────────────────────────────────── */
const AI_PROVIDERS = [
  { id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', model: 'gemini-2.5-flash-lite', ok: 0, fail: 0, lastError: null, cooldownUntil: 0 },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '', model: 'deepseek-chat', ok: 0, fail: 0, lastError: null, cooldownUntil: 0 },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '', model: 'llama-3.3-70b-versatile', ok: 0, fail: 0, lastError: null, cooldownUntil: 0 },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '', model: 'gpt-4o-mini', ok: 0, fail: 0, lastError: null, cooldownUntil: 0 }
];
const AI = { busy: false, lastAt: 0, lastError: null, hourKey: 0, hourCount: 0, brief: null, history: [] };

function aiReady() { return settings.aiEnabled === true && AI_PROVIDERS.some(p => p.key); }

async function callAI(messages, maxTokens) {
  if (!aiReady()) return { error: 'AI kapalı veya anahtar yok' };
  const now = Date.now();
  if (AI.busy) return { error: 'AI meşgul' };
  if (now - AI.lastAt < 12000) return { error: 'AI çok sık çağrıldı' };
  if (AI.hourKey !== Math.floor(now / H1)) { AI.hourKey = Math.floor(now / H1); AI.hourCount = 0; }
  if (AI.hourCount >= 40) return { error: 'AI saatlik limiti' };
  AI.hourCount++; AI.lastAt = now; AI.busy = true;
  try {
    for (const p of AI_PROVIDERS) {
      if (!p.key || p.cooldownUntil > now) continue;
      try {
        const r = await fetchJson(p.base.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', timeout: 25000, retries: 1,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
          body: JSON.stringify({ model: p.model, messages, temperature: 0.3, max_tokens: maxTokens || 320 })
        });
        const text = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
        if (!text || !String(text).trim()) throw new Error('boş yanıt');
        p.ok++; AI.lastError = null;
        return { text: String(text).trim(), provider: p.name, model: p.model };
      } catch (e) {
        p.fail++; p.lastError = e.message; p.cooldownUntil = now + 60000;
        AI.lastError = p.name + ': ' + e.message;
      }
    }
    return { error: AI.lastError || 'AI yanıt vermedi' };
  } finally { AI.busy = false; }
}

function parseAiJson(text) {
  try {
    const s = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  } catch (e) { /* yok */ }
  return null;
}

async function aiComment(sig) {
  if (!aiReady() || !sig || sig.closed || sig.ai) return;
  const facts = [
    'Sinyal: ' + MODULES[sig.module].label + ' ' + sig.dir + ' ' + sig.sym,
    'Giriş: ' + sig.entry + ' | Stop: ' + sig.sl0 + ' | TP1: ' + sig.tp1 + ' | TP2: ' + sig.tp2,
    'Skor: ' + sig.score,
    'Nedenler: ' + (sig.reasons.join('; ') || '-'),
    'Riskler: ' + (sig.risks.join('; ') || '-'),
    'Piyasa: ' + market.dir + ' (skor ' + market.score + ')',
    'Strateji: ' + sig.setup
  ].join('\n');
  const r = await callAI([
    { role: 'system', content: 'Sen AlphaSon adlı kripto sinyal asistanısın. Yatırım tavsiyesi vermezsin. Verilen sinyali 2-3 cümleyle sade Türkçe yorumlarsın. Sayı uydurmazsın. Sadece JSON döndür: {"yorum":"...","risk":"..."}' },
    { role: 'user', content: facts + '\nBu sinyali kısaca yorumla. Hedef/stop seviyelerini tekrar etme, karar verme.' }
  ], 300);
  if (r.error) { sig.ai = { error: r.error, at: Date.now() }; return; }
  const j = parseAiJson(r.text);
  sig.ai = {
    text: (j && (j.yorum || j.comment)) || r.text,
    risk: (j && j.risk) || '', provider: r.provider, model: r.model, at: Date.now()
  };
  AI.history.unshift({ id: sig.id, sym: sig.sym, module: sig.module, dir: sig.dir, text: sig.ai.text, risk: sig.ai.risk, provider: r.provider, at: sig.ai.at });
  if (AI.history.length > 80) AI.history.splice(80);
  dirty = true;
}

async function aiBrief(force) {
  if (!aiReady()) return { error: 'AI kapalı veya anahtar yok' };
  if (!force && AI.brief && Date.now() - AI.brief.at < 30 * M1) return AI.brief;
  const facts = [
    'Piyasa yönü: ' + market.dir + ' (skor ' + market.score + '/100)',
    'Neden: ' + market.why,
    'BTC: ' + JSON.stringify((market.btc && market.btc.metrics) || {}),
    'ETH: ' + JSON.stringify((market.eth && market.eth.metrics) || {}),
    'Genişlik: %' + Math.round((market.breadth || 0.5) * 100) + ' pozitif',
    'Hareketli: ' + UNIVERSE.movers.slice(0, 8).map(t => t.sym + ' ' + (t.chg24 >= 0 ? '+' : '') + t.chg24.toFixed(1) + '%').join(', ')
  ].join('\n');
  const r = await callAI([
    { role: 'system', content: 'Sen AlphaSon adlı kripto piyasa asistanısın. Yatırım tavsiyesi vermezsin. Veriyi sade Türkçe yorumlarsın. Sadece JSON döndür: {"yon":"LONG|SHORT|NOTR","yorum":"...","risk":"..."}' },
    { role: 'user', content: facts + '\nPiyasayı 2-3 cümleyle yorumla. Yönü verideki yönle aynı tut.' }
  ], 350);
  if (r.error) return r;
  const j = parseAiJson(r.text);
  AI.brief = {
    text: (j && (j.yorum || j.comment)) || r.text, dir: (j && j.yon) || market.dir,
    risk: (j && j.risk) || '', provider: r.provider, at: Date.now()
  };
  dirty = true;
  return AI.brief;
}

function aiStatus() {
  return {
    enabled: settings.aiEnabled === true, ready: aiReady(), busy: AI.busy, lastError: AI.lastError,
    providers: AI_PROVIDERS.map(p => ({ id: p.id, name: p.name, key: !!p.key, model: p.model, ok: p.ok, fail: p.fail, lastError: p.lastError, cooldown: p.cooldownUntil > Date.now() })),
    brief: AI.brief, history: AI.history.slice(0, 20)
  };
}

/* ── görünüm / istatistik ─────────────────────────────────────────────────── */
function viewSignal(s) {
  return {
    id: s.id, module: s.module, sym: s.sym, base: s.base, dir: s.dir, tf: s.tf, setup: s.setup,
    entry: s.entry, sl: s.sl0, slNow: s.sl, tp1: s.tp1, tp2: s.tp2, score: s.score,
    reasons: s.reasons, risks: s.risks, trigger: s.trigger, market: s.market,
    status: s.status, statusLabel: RES[s.status] || s.status, closed: s.closed,
    createdAt: s.createdAt, closedAt: s.closedAt, exit: s.exit, finalPct: s.finalPct,
    curPct: s.curPct, maxPct: s.maxPct, minPct: s.minPct, maxR: s.maxR, minR: s.minR,
    tp1Hit: s.tp1Hit, tradeable: s.tradeable, ai: s.ai
  };
}

function calcStats() {
  const out = {};
  for (const m of ACTIVE_MODULES) {
    const arr = signals.filter(s => s.module === m);
    const final = arr.filter(s => s.closed);
    const count = st => final.filter(s => s.status === st).length;
    const tp1 = count('TP1'), tp2 = count('TP2'), sl = count('SL'), be = count('BE'), time = count('TIME'), man = count('MANUEL');
    const wins = tp1 + tp2;
    const winRate = (wins + sl) > 0 ? +(wins / (wins + sl) * 100).toFixed(1) : 0;
    out[m] = {
      total: arr.length, open: arr.filter(s => !s.closed).length, tp1, tp2, sl, be, time, manuel: man,
      tp1Hits: arr.filter(s => s.tp1Hit).length, winRate,
      avgMaxPct: +avg(arr.map(s => s.maxPct)).toFixed(2),
      avgFinalPct: +avg(final.map(s => s.finalPct)).toFixed(2)
    };
  }
  const allFinal = signals.filter(s => s.closed);
  const wins = allFinal.filter(s => s.status === 'TP1' || s.status === 'TP2').length;
  const losses = allFinal.filter(s => s.status === 'SL').length;
  return {
    byModule: out, total: signals.length, open: signals.filter(s => !s.closed).length,
    closed: allFinal.length, wins, losses,
    winRate: (wins + losses) ? +(wins / (wins + losses) * 100).toFixed(1) : 0,
    updatedAt: Date.now()
  };
}

function viewWatchLt(w) {
  return {
    sym: w.sym, base: w.base, tf: w.tf, dir: w.dir, status: w.status, px: w.px,
    upper: w.upper, lower: w.lower, width: w.width, touchesHi: w.touchesHi, touchesLo: w.touchesLo,
    score: w.score, apexT: w.apexT, side: w.side, nearUpper: w.nearUpper, nearLower: w.nearLower, at: w.at
  };
}

/* ── grafik verisi ────────────────────────────────────────────────────────── */
function lineData(cs, arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    out.push({ time: Math.floor(cs[i].t / 1000), value: +arr[i].toFixed(8) });
  }
  return out;
}

async function chartPayload(sym, tf, module, signalId) {
  const limit = tf === '2h' ? LT_BARS : tf === '1h' ? 400 : 300;
  const cs = await getCandles(sym, tf, limit);
  const candles = cs.map(c => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c }));
  const cl = cs.map(c => c.c);
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
  let signal = signalId ? signals.find(s => s.id === signalId) : null;
  let triangle = null;
  if (signal && signal.meta && signal.meta.triangle) triangle = signal.meta.triangle;
  if (!triangle && module === 'LT') {
    const w = LT_WATCH.find(x => x.sym === sym && x.tf === tf);
    if (w && w.triangle) triangle = { upper: w.triangle.upper, lower: w.triangle.lower, apexT: w.triangle.apexT, touchesHi: w.touchesHi, touchesLo: w.touchesLo };
  }
  const markers = [];
  if (signal) {
    markers.push({
      time: Math.floor(signal.createdAt / 1000),
      position: signal.dir === 'LONG' ? 'belowBar' : 'aboveBar',
      color: signal.dir === 'LONG' ? '#22c55e' : '#ef4444',
      shape: signal.dir === 'LONG' ? 'arrowUp' : 'arrowDown',
      text: signal.dir
    });
  }
  return {
    sym, tf, module, candles,
    ema20: lineData(cs, e20), ema50: lineData(cs, e50), ema200: lineData(cs, e200),
    triangle, signal: signal ? viewSignal(signal) : null, markers
  };
}

/* ── Express ──────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '300kb' }));
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  const given = String(req.get('x-api-token') || req.query.token || '');
  if (given !== API_TOKEN) return res.status(401).json({ error: 'API token gerekli' });
  next();
});
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  log('API hatası ' + req.path + ': ' + e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, ready: READY, live: liveReady(), ai: aiReady(), market: market.dir, modules: ACTIVE_MODULES }));

app.get('/api/state', h((req, res) => {
  res.json({
    version: VERSION, ready: READY, now: Date.now(), settings, market,
    signals: signals.slice(-120).reverse().map(viewSignal),
    stats: calcStats(),
    modules: Object.fromEntries(ACTIVE_MODULES.map(k => [k, MODULES[k]])),
    watch: {
      auto: AUTO_WATCH.slice(0, 30),
      trend: TREND_WATCH.slice(0, 30),
      lt: LT_WATCH.filter(w => !w.fired).slice(0, 30).map(viewWatchLt)
    },
    paper: paperSummary(), live: liveSummary(), ai: aiStatus(),
    lastScan, universe: { count: UNIVERSE.all.length, top: UNIVERSE.top.length, movers: UNIVERSE.movers.length, at: UNIVERSE.at },
    env: { bitget: HAS_KEYS, token: !!API_TOKEN, ai: AI_PROVIDERS.filter(p => p.key).map(p => p.id) },
    logs: LOGS.slice(-60)
  });
}));

app.get('/api/signals', h((req, res) => {
  const module = String(req.query.module || '').toUpperCase();
  const limit = clamp(Math.round(num(req.query.limit, 100)), 1, 300);
  let arr = signals.slice().reverse();
  if (module) arr = arr.filter(s => s.module === module);
  res.json({ items: arr.slice(0, limit).map(viewSignal) });
}));

app.get('/api/stats', h((req, res) => res.json(calcStats())));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));

app.get('/api/chart/:id', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  res.json(await chartPayload(sig.sym, sig.tf, sig.module, sig.id));
}));

app.get('/api/chart', h(async (req, res) => {
  const signalId = String(req.query.signal || '');
  const sig = signalId ? signals.find(s => s.id === signalId) : null;
  const module = String(req.query.module || (sig ? sig.module : 'TREND')).toUpperCase();
  const sym = String(req.query.sym || (sig ? sig.sym : 'BTCUSDT')).toUpperCase();
  const tf = String(req.query.tf || (sig ? sig.tf : (MODULES[module] ? MODULES[module].chartTf : '5m')));
  res.json(await chartPayload(sym, tf, module, signalId));
}));

app.post('/api/scan/:module', h(async (req, res) => {
  const m = String(req.params.module || '').toUpperCase();
  if (m === 'AUTO') await autoScan();
  else if (m === 'TREND') await trendScan();
  else if (m === 'LT') await ltScan();
  else return res.status(400).json({ error: 'bilinmeyen modül' });
  res.json({ ok: true, watch: m === 'AUTO' ? AUTO_WATCH : m === 'TREND' ? TREND_WATCH : LT_WATCH.map(viewWatchLt), signals: signals.slice(-20).reverse().map(viewSignal) });
}));

app.post('/api/settings', h((req, res) => {
  settings = sanitizeSettings(Object.assign({}, settings, req.body || {}));
  if (settings.tradeMode === 'live' && !(HAS_KEYS && API_TOKEN)) settings.tradeMode = 'paper';
  dirty = true; saveState(true); refreshUniverse();
  res.json({ ok: true, settings });
}));

app.post('/api/auto/toggle', h((req, res) => {
  settings.autoTrade = !!(req.body && req.body.on === true);
  dirty = true; saveState(true);
  log('OtoTrade ' + (settings.autoTrade ? 'AÇIK' : 'KAPALI'));
  res.json({ ok: true, autoTrade: settings.autoTrade });
}));

app.post('/api/signal/:id/close', h((req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  closeSignal(sig, 'MANUEL', priceOf(sig.sym) || sig.entry);
  res.json({ ok: true, signal: viewSignal(sig) });
}));

app.get('/api/ai/status', h((req, res) => res.json(aiStatus())));
app.post('/api/ai/toggle', h((req, res) => {
  settings.aiEnabled = !!(req.body && req.body.on === true);
  dirty = true; saveState(true);
  res.json({ ok: true, enabled: settings.aiEnabled });
}));
app.get('/api/ai/brief', h((req, res) => res.json({ brief: AI.brief, status: aiStatus() })));
app.post('/api/ai/brief', h(async (req, res) => {
  const b = await aiBrief(true);
  if (b && b.error) return res.status(400).json(b);
  res.json({ ok: true, brief: b });
}));
app.post('/api/ai/test', h(async (req, res) => {
  const r = await callAI([{ role: 'user', content: 'Sadece OK yaz.' }], 10);
  res.json(r.error ? { ok: false, error: r.error } : { ok: true, provider: r.provider, text: r.text });
}));

app.get('/api/live/balance', h(async (req, res) => res.json({ balance: await fetchLiveBalance(), ready: liveReady(), hasKeys: HAS_KEYS })));
app.get('/api/live/positions', h(async (req, res) => res.json(liveSummary())));
app.post('/api/live/sync', h(async (req, res) => res.json(await syncLive())));
app.post('/api/live/:id/close', h(async (req, res) => {
  const pos = LIVE.open.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'pozisyon yok' });
  res.json(await closeLive(pos));
}));

app.get('/api/diag', h((req, res) => res.json({
  version: VERSION, ready: READY, uptime: process.uptime(), memory: process.memoryUsage().rss,
  universe: UNIVERSE.all.length, top: UNIVERSE.top.length, movers: UNIVERSE.movers.length,
  cache: CANDLE_CACHE.size, signals: signals.length, paperOpen: paper.open.length, liveOpen: LIVE.open.length,
  lastScan, market: { dir: market.dir, score: market.score }, ai: aiStatus()
})));

app.use((req, res) => res.status(404).json({ error: 'yol yok', path: req.path, version: VERSION }));

/* ── döngüler ─────────────────────────────────────────────────────────────── */
function every(ms, name, fn, immediate) {
  const run = () => Promise.resolve().then(fn).catch(e => logOnce('loop:' + name, name + ' döngü hatası: ' + e.message, 30000));
  if (immediate) setTimeout(run, 800);
  return setInterval(run, ms);
}

function startLoops() {
  every(4000, 'tick', async () => {
    await refreshTickers();
    monitorSignals();
    monitorPaper();
    await ltTick();
    await monitorLive();
    lastScan.tick = Date.now();
  }, true);
  every(60e3, 'market', updateMarket, true);
  every(30e3, 'auto', autoScan, false);
  every(70e3, 'trend', trendScan, false);
  every(4 * 60e3, 'lt', ltScan, false);
  setTimeout(() => autoScan().catch(e => log('auto ilk tarama: ' + e.message)), 4000);
  setTimeout(() => trendScan().catch(e => log('trend ilk tarama: ' + e.message)), 12000);
  setTimeout(() => ltScan().catch(e => log('lt ilk tarama: ' + e.message)), 25000);
  every(10e3, 'save', () => saveState(false), true);
  every(15 * 60e3, 'ai', () => { if (aiReady()) aiBrief(false); }, true);
}

async function init() {
  loadState();
  log('AlphaSon ' + VERSION + ' başlıyor...');
  await refreshTickers(true);
  await updateMarket();
  READY = true;
  saveState(true);
  startLoops();
  log('Hazır. ' + UNIVERSE.all.length + ' parite, piyasa ' + market.dir + ' (skor ' + market.score + ')');
}

process.on('unhandledRejection', e => log('Yakalanmayan hata: ' + (e && e.message ? e.message : e)));
process.on('uncaughtException', e => log('Kritik hata: ' + (e && e.message ? e.message : e)));

const server = app.listen(PORT, () => {
  log('Sunucu http://localhost:' + PORT);
  init().catch(e => log('Başlatma hatası: ' + e.message));
});

let shutting = false;
function shutdown(sig) {
  if (shutting) return;
  shutting = true;
  log('Kapatılıyor (' + sig + ')...');
  try { saveState(true); } catch (e) { /* yok */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
