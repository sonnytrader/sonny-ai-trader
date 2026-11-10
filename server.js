'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v1.2 — sade sinyal + AI kapısı + OtoTrade sunucusu
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

const VERSION = 'v1.2';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1, H1 = 60 * M1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '30m': 30 * M1, '1h': H1, '2h': 2 * H1, '4h': H4, '1d': D1 };
const TF_GRAN = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D' };
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
  ACIK: 'DEVAM EDİYOR', TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', AI_RED: 'AI RED',
  TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL KAPATILDI'
};


const STOCK_RE = /^(INTC|MSTR|KORU|SNXX|TSLA|NVDA|AAPL|COIN|HOOD|CRCL|AMZN|GOOGL|MSFT|META|SPY|QQQ|PLTR|AMD|NFLX|BABA|MARA|RIOT|CBRS|TQQQ|BE|CRWV|XAG|XAU|XPT|XPD|BZ|CL|WTI|BRENT|NATGAS|COPPER|SKHYNIX|SKHY|SAMSUNG|NBIS|AAOI|OPENAI|ANTHROPIC|SPACEX|SKUU|GGLL|IREN|MVLL|NVDL|TSLL|CONL|AAPU|AMZU|SOXS|SOXL|SQQQ|SPXL|SPXS|UPRO|UVXY|TECL|TECS|FNGU|FNGD|LABU|LABD|QID|SDS|TSLQ|TSDD|NVDD|NVDX)$/;
const DEF_SET = {
  autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 3, riskPct: 0.5,
  autoMaxOpen: 2, dailyLossPct: 3, minQuoteVol: 1e6, topN: 120,
  aiEnabled: true, aiMode: 'gate', aiMinConf: 55,
  tvExchange: 'BITGET', ltMarketFilter: true, exclude: '',
  ltTfs: ['2h'], paperEquity: 1000
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const baseOf = sym => String(sym || '').split('/')[0].replace(/USDT$/, '').toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let EXCL = new Set();
const isStock = sym => STOCK_RE.test(baseOf(sym)) || EXCL.has(baseOf(sym));

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
  s.aiEnabled = s.aiEnabled !== false;
  s.aiMode = s.aiMode === 'comment' ? 'comment' : 'gate';
  s.aiMinConf = clamp(Math.round(num(s.aiMinConf, 55)), 0, 100);
  s.tvExchange = String(s.tvExchange || 'BITGET').toUpperCase() === 'BINANCE' ? 'BINANCE' : 'BITGET';
  s.ltMarketFilter = s.ltMarketFilter !== false;
  s.exclude = String(s.exclude || '').toUpperCase().replace(/[^A-Z0-9,]/g, '').slice(0, 400);
  EXCL = new Set(s.exclude.split(',').filter(Boolean));
  s.ltTfs = Array.isArray(s.ltTfs) ? s.ltTfs.filter(t => ['1h', '2h', '4h'].includes(t)) : ['2h'];
  if (!s.ltTfs.length) s.ltTfs = ['2h'];
  s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9);
  return s;
}

let settings = sanitizeSettings({});
let signals = [];
let paper = { open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity, dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity };
let seq = 0, pseq = 0;
let market = { dir: 'NOTR', score: 50, raw: 0, breadth: 0.5, alt: { dir: 'NOTR', score: 50, breadth: 0.5, avg: 0, why: 'veri yok' }, why: 'veri bekleniyor', btc: null, eth: null, at: 0 };
let UNIVERSE = { all: [], top: [], movers: [], breadth: 0.5, altBreadth: 0.5, altAvg: 0, at: 0 };
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
    if (j.version !== VERSION) settings.ltTfs = ['2h'];   // v1.2: LT yalnız 2h
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
        if (s.verdict == null || s.verdict === 'BEKLIYOR') s.verdict = 'YOK';
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
      if (!r.ok) { let b = ''; try { b = (await r.text()).replace(/\s+/g, ' ').slice(0, 220); } catch (e2) { /* yok */ } throw new Error('HTTP ' + r.status + (b ? ' ' + b : '')); }
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
const CANDLE_TTL = { '1m': 8e3, '3m': 20e3, '5m': 30e3, '15m': 60e3, '30m': 2 * M1, '1h': 3 * M1, '2h': 5 * M1, '4h': 10 * M1, '1d': 30 * M1 };

async function fetchRawPage(sym, gran, limit, endTime) {
  const url = 'https://api.bitget.com/api/v2/mix/market/candles?symbol=' + encodeURIComponent(sym) +
    '&productType=USDT-FUTURES&granularity=' + gran + '&limit=' + limit + (endTime ? '&endTime=' + endTime : '');
  const j = await bitgetJson(url, { timeout: 15000, retries: 2 });
  if (j && j.code && String(j.code) !== '00000') throw new Error('Bitget ' + j.code + ' ' + (j.msg || ''));
  return (j && Array.isArray(j.data) ? j.data : []).map(a => ({
    t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0, qv: Number(a[6]) || 0
  })).filter(x => x.t > 0 && Number.isFinite(x.c) && x.c > 0).sort((x, y) => x.t - y.t);
}
// 1000'den fazla mum gerekirse geriye doğru sayfalanır (büyük üçgenler için).
async function fetchRawCandles(sym, gran, limit) {
  let all = [], end = null, need = limit;
  for (let page = 0; page < 4 && need > 0; page++) {
    const lim = Math.min(1000, need);
    let arr;
    try { arr = await fetchRawPage(sym, gran, lim, end); } catch (e) { if (page === 0) throw e; break; }
    if (!arr.length) break;
    all = arr.concat(all); need -= arr.length; end = arr[0].t - 1;
    if (arr.length < lim) break;
  }
  const out = [];
  all.sort((x, y) => x.t - y.t);
  for (const x of all) if (!out.length || out[out.length - 1].t !== x.t) out.push(x);
  return out;
}

// Bitget 2H mumu sunmaz (400 hatası): 1H mumlardan 2H üretilir.
function aggCandles(cs, ms) {
  const per = ms / H1, out = [];
  let cur = null, cnt = 0;
  const flush = () => { if (cur) { cur._n = cnt; out.push(cur); } };
  for (const c of cs) {
    const b = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== b) { flush(); cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, qv: c.qv || 0 }; cnt = 1; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; cur.qv += c.qv || 0; cnt++; }
  }
  flush();
  if (out.length > 1 && out[0]._n < per) out.shift();
  for (const c of out) delete c._n;
  return out;
}

async function getCandles(sym, tf, limit) {
  const lim = Math.max(60, Math.min(1600, Number(limit) || 300));
  const key = sym + ':' + tf + ':' + lim;
  const cached = CANDLE_CACHE.get(key);
  const ttl = CANDLE_TTL[tf] || 60e3;
  if (cached && Date.now() - cached.at < ttl) return cached.cs;
  if (CANDLE_INFLIGHT.has(key)) return CANDLE_INFLIGHT.get(key);
  const p = (async () => {
    try {
      let out;
      if (tf === '2h') out = aggCandles(await fetchRawCandles(sym, '1H', Math.min(3300, lim * 2 + 4)), 2 * H1).slice(-lim);
      else out = await fetchRawCandles(sym, TF_GRAN[tf] || '5m', lim);
      if (out.length) CANDLE_CACHE.set(key, { at: Date.now(), cs: out });
      if (CANDLE_CACHE.size > 1500) { const k = CANDLE_CACHE.keys().next().value; CANDLE_CACHE.delete(k); }
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
const TICKHIST = new Map();
function recordHist(next) {
  const now = Date.now();
  for (const [sym, t] of next) {
    let a = TICKHIST.get(sym);
    if (!a) { a = []; TICKHIST.set(sym, a); }
    if (!a.length || now - a[a.length - 1].t >= 30000) { a.push({ t: now, p: t.last }); if (a.length > 170) a.shift(); }
  }
}
// Kısa vadeli getiri (%): 15dk / 1sa. Geçmiş yeterli değilse null.
function retPct(sym, ms) {
  const a = TICKHIST.get(sym), t = TICK.get(sym);
  if (!a || a.length < 3 || !t) return null;
  const now = Date.now();
  if (now - a[0].t < ms * 0.8) return null;
  let ref = null;
  for (let i = a.length - 1; i >= 0; i--) if (a[i].t <= now - ms) { ref = a[i]; break; }
  if (!ref) ref = a[0];
  return ref.p > 0 ? (t.last - ref.p) / ref.p * 100 : null;
}

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
      next.set(sym, { sym, last, bid: num(r.bidPr), ask: num(r.askPr), chg24: num(r.change24h) * 100, vol, high: num(r.high24h), low: num(r.low24h), ts: num(r.ts, Date.now()) });
    }
    if (next.size) { TICK = next; tickersAt = Date.now(); recordHist(next); refreshUniverse(); }
  } catch (e) { logOnce('tickers', 'Ticker alınamadı: ' + e.message, 30000); }
}

function shortRet(t) {
  let r = retPct(t.sym, H1);
  if (r != null) return { r, short: true };
  r = retPct(t.sym, 15 * M1);
  if (r != null) return { r: r * 2, short: true };
  return { r: t.chg24 / 6, short: false };
}

function refreshUniverse() {
  const all = [...TICK.values()].filter(t => t.vol >= settings.minQuoteVol && t.last > 0);
  all.sort((a, b) => b.vol - a.vol);
  const top = all.slice(0, Math.max(10, settings.topN));
  const pool = all.slice(0, Math.min(all.length, Math.max(60, settings.topN)));
  pool.sort((a, b) => Math.abs(b.chg24) - Math.abs(a.chg24));
  const movers = pool.slice(0, 60);
  const calc = list => {
    let up = 0, sum = 0, sh = 0;
    for (const t of list) { const x = shortRet(t); if (x.r > 0) up++; sum += x.r; if (x.short) sh++; }
    return { breadth: list.length ? up / list.length : 0.5, avg: list.length ? sum / list.length : 0, shortShare: list.length ? sh / list.length : 0 };
  };
  const b = calc(all.slice(0, 50));
  const alts = calc(all.filter(t => t.sym !== 'BTCUSDT' && t.sym !== 'ETHUSDT').slice(0, 80));
  UNIVERSE = { all, top, movers, breadth: b.breadth, altBreadth: alts.breadth, altAvg: alts.avg, shortShare: alts.shortShare, at: Date.now() };
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

/* ── piyasa yönü (yalnız matematik; kısa vadeli, hızlı tepki verir) ───────── */
function assetScore(sym, cs15, cs1h) {
  const t = TICK.get(sym);
  const empty = { score: 0, dir: 'NOTR', why: 'veri yok', price: t ? t.last : 0, chg1h: 0, chg4h: 0, chg24: t ? t.chg24 : 0, metrics: {} };
  if (!cs15 || cs15.length < 120 || !cs1h || cs1h.length < 55) return empty;
  const cl = cs15.map(c => c.c), i = cl.length - 1;
  const e9 = emaArr(cl, 9), e21 = emaArr(cl, 21), e50 = emaArr(cl, 50);
  const a = atrArr(cs15, 14), d = adxArr(cs15, 14);
  const atr = a[i] || cl[i] * 0.004, atrPct = atr / cl[i] * 100;
  const cl1 = cs1h.map(c => c.c), h20 = emaArr(cl1, 20), h50 = emaArr(cl1, 50), j = cl1.length - 1;
  const chg1h = (cl[i] - cl[i - 4]) / cl[i - 4] * 100;
  const chg4h = (cl[i] - cl[i - 16]) / cl[i - 16] * 100;
  const adx = d.adx[i] || 0, pdi = d.pdi[i] || 0, mdi = d.mdi[i] || 0;
  let s = 0, w = 0;
  const add = (v, ww) => { s += v * ww; w += ww; };
  add(e9[i] > e21[i] ? 1 : -1, 1.0);
  add(cl[i] > e50[i] ? 1 : -1, 0.8);
  add(clamp((e21[i] - e21[i - 8]) / Math.max(atr, EPS) / 0.5, -1, 1), 1.0);
  add(adx >= 15 ? (pdi > mdi ? 1 : -1) * clamp(adx / 30, 0.4, 1) : 0, 0.8);
  add(cl1[j] > h20[j] ? 1 : -1, 0.7);
  add(h20[j] > h50[j] ? 1 : -1, 0.5);
  add(clamp(chg1h / Math.max(atrPct * 2.5, 0.05), -1, 1), 1.3);   // son 1 saatlik hareket
  add(clamp(chg4h / Math.max(atrPct * 5, 0.1), -1, 1), 0.6);      // son 4 saatlik hareket
  const score = clamp(w ? s / w : 0, -1, 1);
  return {
    score, dir: score > 0.15 ? 'LONG' : score < -0.15 ? 'SHORT' : 'NOTR', price: cl[i],
    chg1h: +chg1h.toFixed(2), chg4h: +chg4h.toFixed(2), chg24: t ? t.chg24 : 0,
    why: (e9[i] > e21[i] ? 'EMA9>21' : 'EMA9<21') + ', 1s ' + (chg1h >= 0 ? '+' : '') + chg1h.toFixed(2) + '%, ADX ' + adx.toFixed(0) + (adx >= 15 ? (pdi > mdi ? ' +DI' : ' −DI') : ' zayıf') + ', 1h ' + (cl1[j] > h20[j] ? 'üst' : 'alt'),
    metrics: { price: cl[i], ema9: e9[i], ema21: e21[i], ema50: e50[i], adx, pdi, mdi, chg1h, chg4h }
  };
}

async function updateMarket() {
  const [b15, e15, b1h, e1h] = await Promise.all([
    getCandles('BTCUSDT', '15m', 200), getCandles('ETHUSDT', '15m', 200),
    getCandles('BTCUSDT', '1h', 120), getCandles('ETHUSDT', '1h', 120)
  ]);
  const btc = assetScore('BTCUSDT', b15, b1h), eth = assetScore('ETHUSDT', e15, e1h);
  const altBreadth = UNIVERSE.altBreadth == null ? 0.5 : UNIVERSE.altBreadth;
  const altAvg = num(UNIVERSE.altAvg, 0);
  const shortOk = num(UNIVERSE.shortShare, 0) >= 0.5;
  const breadthScore = clamp((altBreadth - 0.5) * 2.2, -1, 1);
  const altMom = clamp(altAvg / (shortOk ? 1.0 : 1.2), -1, 1);
  const altScore = clamp(breadthScore * 0.6 + altMom * 0.4, -1, 1);
  const alt = {
    dir: altScore > 0.15 ? 'LONG' : altScore < -0.15 ? 'SHORT' : 'NOTR', score: Math.round(50 + altScore * 50),
    breadth: +altBreadth.toFixed(3), avg: +altAvg.toFixed(2), shortTerm: shortOk,
    why: 'Alt coinlerin %' + Math.round(altBreadth * 100) + ' kadarı ' + (shortOk ? 'son 1 saatte' : '24s') + ' pozitif, ortalama ' + (altAvg >= 0 ? '+' : '') + altAvg.toFixed(2) + '%'
  };
  const raw = clamp(0.30 * btc.score + 0.25 * eth.score + 0.25 * breadthScore + 0.20 * altMom, -1, 1);
  let dir = market.dir;
  const enter = 0.20, hold = 0.06;
  if (raw >= enter) dir = 'LONG';
  else if (raw <= -enter) dir = 'SHORT';
  else if (dir === 'LONG' && raw < hold) dir = 'NOTR';
  else if (dir === 'SHORT' && raw > -hold) dir = 'NOTR';
  else if (dir !== 'LONG' && dir !== 'SHORT') dir = 'NOTR';
  const why = 'BTC: ' + btc.why + ' | ETH: ' + eth.why + ' | ' + alt.why;
  const prev = market.dir;
  market = { dir, score: Math.round(50 + raw * 50), raw: +raw.toFixed(3), breadth: altBreadth, alt, why, btc, eth, at: Date.now() };
  if (prev !== dir) log('PİYASA YÖNÜ: ' + prev + ' → ' + dir + ' (skor ' + market.score + ')');
  dirty = true;
}


/* ── TREND TAKİP: 15m rejim + 1h teyit + 5m geri çekilme/kırılım ───────────── */
function trendRegime(cs15, cs1h) {
  const no = why => ({ dir: 'NOTR', ok: false, h1Ok: false, why, adx: 0, pdi: 0, mdi: 0, atr: 0, slope: 0 });
  if (!cs15 || cs15.length < 210 || !cs1h || cs1h.length < 55) return no('veri yok');
  const cl = cs15.map(c => c.c), i = cl.length - 1;
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200);
  const a = atrArr(cs15, 14), d = adxArr(cs15, 14);
  const atr = a[i] || cl[i] * 0.005;
  const slope = (e20[i] - e20[i - 12]) / Math.max(atr, EPS);
  const cl1 = cs1h.map(c => c.c), h20 = emaArr(cl1, 20), h50 = emaArr(cl1, 50), j = cl1.length - 1;
  const adx = d.adx[i] || 0, pdi = d.pdi[i] || 0, mdi = d.mdi[i] || 0;
  const long = e20[i] > e50[i] && cl[i] > e200[i] && adx >= 20 && pdi > mdi && slope > 0.05;
  const short = e20[i] < e50[i] && cl[i] < e200[i] && adx >= 20 && mdi > pdi && slope < -0.05;
  const dir = long ? 'LONG' : short ? 'SHORT' : 'NOTR';
  const h1Ok = dir === 'LONG' ? (cl1[j] > h50[j] && h20[j] >= h50[j]) : dir === 'SHORT' ? (cl1[j] < h50[j] && h20[j] <= h50[j]) : false;
  return { dir, ok: dir !== 'NOTR', h1Ok, why: dir === 'NOTR' ? '15m rejim net değil' : (dir === 'LONG' ? '15m yükseliş rejimi' : '15m düşüş rejimi'), adx, pdi, mdi, atr, slope, price: cl[i] };
}

function trendAnalyze(sym, cs5, cs15, cs1h) {
  if (market.dir === 'NOTR') return null;                 // nötr piyasada sinyal yok
  const reg = trendRegime(cs15, cs1h);
  if (!reg.ok || reg.dir !== market.dir) return null;     // piyasaya ters sinyal yok
  if (!cs5 || cs5.length < 80) return null;
  const n = cs5.length, i = n - 1, L = reg.dir === 'LONG', d = L ? 1 : -1;
  const cl5 = cs5.map(c => c.c), e20 = emaArr(cl5, 20), e50 = emaArr(cl5, 50), atrA = atrArr(cs5, 14), rsiA = rsiArr(cl5, 14);
  const c = cs5[i - 1], p = cs5[i - 2];
  const atr = atrA[i - 1] || cl5[i] * 0.004, e20c = e20[i - 1], e50c = e50[i - 1];
  if (!c || !p || e20c == null || e50c == null || e20[i - 4] == null) return null;
  const px = priceOf(sym) || cs5[i].c;
  const dist = d * (px - e20c) / Math.max(atr, EPS);
  const volSma = avg(cs5.slice(Math.max(0, i - 21), i - 1).map(x => x.v));
  const volRatio = volSma > 0 ? c.v / volSma : 0;
  const body = bodyRatio(c), closePos = (c.c - c.l) / Math.max(c.h - c.l, EPS), rsiNow = rsiA[i - 1] || 50;
  const aligned = L ? (e20c > e50c && e20c > e20[i - 4]) : (e20c < e50c && e20c < e20[i - 4]);
  const st = Math.max(0, i - 11);
  const pulled = cs5.slice(st, i).some((x, k) => { const ee = e20[st + k]; return ee != null && (L ? x.l <= ee + 0.25 * atr : x.h >= ee - 0.25 * atr); });
  const brk = L ? c.c > p.h : c.c < p.l;
  const candleOk = d * (c.c - c.o) > 0 && body >= 0.45 && (L ? closePos >= 0.6 : closePos <= 0.4) && volRatio >= 1.0;
  const rsiOk = L ? (rsiNow >= 45 && rsiNow <= 75) : (rsiNow <= 55 && rsiNow >= 25);
  const fresh = d * (px - c.c) >= -0.3 * atr && d * (px - c.c) <= 0.7 * atr;
  const base = { sym, base: baseOf(sym), tf: '5m', dir: reg.dir, px, dist: +dist.toFixed(2), score: Math.round(clamp(55 + (reg.adx - 18) * 0.8 + (reg.h1Ok ? 8 : 0), 50, 90)), at: Date.now(), reasons: [reg.why + ' (ADX ' + reg.adx.toFixed(0) + ')'] };
  const W = status => ({ watch: Object.assign(base, { status }) });
  if (!reg.h1Ok) return W('1H TEYİT BEKLİYOR');
  if (!aligned) return W('5M EMA YÖNÜ UYUMSUZ');
  if (!pulled) return W('GERİ ÇEKİLME BEKLİYOR');
  if (!(brk && candleOk)) return W('TETİK BEKLİYOR');
  if (!rsiOk) return W('RSI UYGUN DEĞİL');
  if (dist > 1.4) return W('EMA20’DEN UZAK');
  if (!fresh) return W('FİYAT KAÇTI');
  const sw = L ? Math.min(...cs5.slice(Math.max(0, i - 10), i).map(x => x.l)) : Math.max(...cs5.slice(Math.max(0, i - 10), i).map(x => x.h));
  let sl = L ? sw - 0.25 * atr : sw + 0.25 * atr;
  let riskPct = Math.abs(px - sl) / px * 100;
  if (riskPct < 0.3) { const dd = Math.max(0.5 * atr, px * 0.003); sl = px - d * dd; riskPct = Math.abs(px - sl) / px * 100; }
  if (riskPct > 2.5) return W('STOP ÇOK GENİŞ');
  if (!(L ? sl < px : sl > px)) return null;
  const R = Math.abs(px - sl), tp1 = px + d * 1.5 * R, tp2 = px + d * 3 * R;
  const score = Math.round(clamp(55 + (reg.adx - 18) * 0.8 + 8 + (volRatio > 1.5 ? 5 : 0) + (body > 0.6 ? 4 : 0), 50, 96));
  const reasons = [reg.why + ' (ADX ' + reg.adx.toFixed(0) + ')', L ? '1h fiyat EMA50 üstünde' : '1h fiyat EMA50 altında', 'EMA20 geri çekilmesi sonrası önceki mum ' + (L ? 'tepesi' : 'dibi') + ' kırıldı', 'Hacim x' + volRatio.toFixed(1), 'Piyasa ' + market.dir + ' ile uyumlu'];
  const risks = [];
  if (rsiNow > 70 || rsiNow < 30) risks.push('5m RSI uçta');
  if (dist > 1.0) risks.push('EMA20’den uzak');
  if (riskPct > 1.5) risks.push('Stop geniş');
  return {
    signal: { sym, base: baseOf(sym), tf: '5m', dir: reg.dir, entry: px, sl, tp1, tp2, score, setup: 'EMA20 GERİ ÇEKİLME + KIRILIM', reasons, risks, trigger: 'ÖNCEKİ MUM KIRILIMI', market: market.dir, marketAlign: 'UYUMLU',
      meta: { atr, riskPct: +riskPct.toFixed(3), adx: +reg.adx.toFixed(1), volRatio: +volRatio.toFixed(2), rsi: +rsiNow.toFixed(1), distAtr: +dist.toFixed(2), h1Ok: true } },
    watch: Object.assign(base, { status: 'SİNYAL', score })
  };
}

let trendScanning = false;
async function trendScan() {
  if (trendScanning) return;
  trendScanning = true;
  try {
    const syms = UNIVERSE.top.slice(0, Math.min(60, settings.topN)).map(x => x.sym);
    const rows = [], cands = [];
    if (market.dir !== 'NOTR') {
      await pool(syms, 4, async sym => {
        const [cs15, cs1h, cs5] = await Promise.all([getCandles(sym, '15m', 260), getCandles(sym, '1h', 160), getCandles(sym, '5m', 220)]);
        const r = trendAnalyze(sym, cs5, cs15, cs1h);
        if (!r) return;
        if (r.watch) rows.push(r.watch);
        if (r.signal) cands.push(r.signal);
      });
    }
    rows.sort((a, b) => b.score - a.score);
    TREND_WATCH = rows.slice(0, 30);
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 4)) addSignal(Object.assign({ module: 'TREND' }, c));
    lastScan.trend = Date.now();
    log('Trend tarama: piyasa ' + market.dir + ', ' + syms.length + ' parite, ' + rows.length + ' aday, ' + cands.length + ' tetik');
  } finally { trendScanning = false; }
}


/* ── LT ÜÇGEN: kullanıcı tarzı simetrik üçgen ─────────────────────────────────
   Üst çizgi: penceredeki en yüksek tepelerden birinden başlar ve fiyatın üstünü
   sıyırarak (teğet) aşağı iner. Alt çizgi: en düşük diplerden birinden başlar ve
   fiyatın altını sıyırarak yukarı çıkar. İki çizgi sağda birleşir (apex).
   Sinyal: canlı fiyat çizgiye DEĞDİĞİ anda (mum kapanışı beklenmez). */
function pivotsOf(cs, k) {
  const out = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) h = false;
      if (cs[j].l <= cs[i].l) l = false;
      if (!h && !l) break;
    }
    if (h) out.push({ i, p: cs[i].h, type: 'H' });
    if (l) out.push({ i, p: cs[i].l, type: 'L' });
  }
  return out;
}
function countTouches(cs, from, lineAt, side, atr) {
  let cnt = 0, last = -99;
  for (let j = from; j < cs.length; j++) {
    const dd = side === 'H' ? Math.abs(cs[j].h - lineAt(j)) : Math.abs(cs[j].l - lineAt(j));
    if (dd <= 0.30 * atr && j - last >= 4) { cnt++; last = j; }
  }
  return cnt;
}
function buildSide(cc, A, side, atr) {
  const tol = 0.10 * atr, m = cc.length;
  let s = side === 'H' ? -Infinity : Infinity, bi = -1;
  for (let j = A.i + 1; j < m; j++) {
    if (side === 'H') { const r = (cc[j].h - tol - A.p) / (j - A.i); if (r >= s) { s = r; bi = j; } }
    else { const r = (cc[j].l + tol - A.p) / (j - A.i); if (r <= s) { s = r; bi = j; } }
  }
  if (bi < 0 || bi - A.i < 8) return null;
  if (side === 'H' ? !(s < 0) : !(s > 0)) return null;
  if (Math.abs(s) * (m - A.i) < 0.6 * atr || Math.abs(s) > 0.4 * atr) return null;
  const at = j => A.p + s * (j - A.i);
  const touches = countTouches(cc, A.i, at, side, atr);
  if (touches < 2) return null;
  return { i: A.i, p: A.p, s, bi, touches };
}

function detectTriangle(cs, tf) {
  const n = cs.length;
  if (n < 90) return null;
  const cc = cs.slice(0, n - 1), m = cc.length;       // yalnız kapanmış mumlar
  const W = tf === '4h' ? 300 : tf === '2h' ? 720 : 400;
  const from = Math.max(0, m - W);
  const atr = atrArr(cc, 14)[m - 1];
  if (!atr) return null;
  const piv = pivotsOf(cc, 3).filter(p => p.i >= from && p.i <= m - 20);
  // Çizgiler "pencere" içinden değil, insan gibi farklı başlangıçlardan denenir:
  // tüm pencere, son %65 ve son %40 içindeki en yüksek tepeler / en düşük dipler.
  const pick = (type, cmp) => {
    const seen = new Set(), out = [];
    for (const fr of [1, 0.65, 0.4]) {
      const lo = m - Math.round(W * fr);
      piv.filter(p => p.type === type && p.i >= lo).sort(cmp).slice(0, 3).forEach(p => { if (!seen.has(p.i)) { seen.add(p.i); out.push(p); } });
    }
    return out;
  };
  const hs = pick('H', (a, b) => b.p - a.p), ls = pick('L', (a, b) => a.p - b.p);
  const Us = hs.map(a => buildSide(cc, a, 'H', atr)).filter(Boolean);
  const Ls = ls.map(a => buildSide(cc, a, 'L', atr)).filter(Boolean);
  if (!Us.length || !Ls.length) return null;
  const ref = n - 1, tfMs = TF_MS[tf] || H1;
  let best = null;
  for (const U of Us) for (const Lo of Ls) {
    const uAt = j => U.p + U.s * (j - U.i), lAt = j => Lo.p + Lo.s * (j - Lo.i);
    const s0 = Math.max(U.i, Lo.i), start = Math.min(U.i, Lo.i);
    const wS = uAt(s0) - lAt(s0), wNow = uAt(ref) - lAt(ref);
    if (!(wS > 0) || wNow < 0.12 * atr || wNow > 0.75 * wS) continue;
    if (ref - start < 30) continue;
    const apex = (Lo.p - U.p + U.s * U.i - Lo.s * Lo.i) / (U.s - Lo.s);
    if (!Number.isFinite(apex) || apex <= ref || apex > ref + 1.2 * (ref - start)) continue;
    const ratio = Math.abs(U.s) / Lo.s;
    if (ratio < 0.25 || ratio > 4) continue;
    const lastC = cc[m - 1].c;
    if (lastC > uAt(m - 1) + 0.1 * atr || lastC < lAt(m - 1) - 0.1 * atr) continue;
    const comp = clamp(1 - wNow / wS, 0, 1);
    const rank = 40 + Math.min(U.touches + Lo.touches, 14) * 3 + comp * 25 + Math.min(ref - start, 600) * 0.1 + (1 - Math.min(1, Math.abs(Math.log(ratio)) / 1.4)) * 8;
    const score = clamp(Math.round(rank), 50, 98);
    if (!best || rank > best.rank) best = { U, L: Lo, apex, start, wS, wNow, comp, score, rank, uAt, lAt };
  }
  if (!best) return null;
  const timeAt = i => Math.floor((i < n ? cs[i].t : cs[n - 1].t + (i - (n - 1)) * tfMs) / 1000);
  const endIdx = Math.min(Math.floor(best.apex), ref + Math.max(10, Math.round((ref - best.start) * 0.35)));
  const rp = v => +Number(v).toFixed(v >= 1 ? 6 : 10);
  return {
    tf, atr, ref, refT: cs[n - 1].t, tfMs, U: best.U, L: best.L, apex: best.apex, start: best.start,
    wS: best.wS, wNow: best.wNow, comp: +best.comp.toFixed(2), score: best.score,
    touchesHi: best.U.touches, touchesLo: best.L.touches,
    upperNow: best.uAt(ref), lowerNow: best.lAt(ref),
    apexT: timeAt(Math.floor(best.apex)),
    lines: {
      upper: [{ time: timeAt(best.U.i), value: rp(best.U.p) }, { time: timeAt(endIdx), value: rp(best.uAt(endIdx)) }],
      lower: [{ time: timeAt(best.L.i), value: rp(best.L.p) }, { time: timeAt(endIdx), value: rp(best.lAt(endIdx)) }]
    }
  };
}

const LT_FIRED = new Map();
function ltLines(w, now) {
  const idx = w.refIdx + Math.max(0, Math.floor((now - w.refT) / w.tfMs));
  return { idx, upper: w.U.p + w.U.s * (idx - w.U.i), lower: w.L.p + w.L.s * (idx - w.L.i) };
}

function ltAnalyze(sym, tf, cs) {
  const tri = detectTriangle(cs, tf);
  if (!tri) return null;
  const px = priceOf(sym) || cs[cs.length - 1].c;
  const key = sym + '|' + tf + '|' + tri.U.i + '|' + tri.L.i;
  const w = {
    key, sym, base: baseOf(sym), tf, px, atr: tri.atr, tfMs: tri.tfMs, refIdx: tri.ref, refT: tri.refT, U: tri.U, L: tri.L, apex: tri.apex,
    wS: tri.wS, touchesHi: tri.touchesHi, touchesLo: tri.touchesLo, score: tri.score, apexT: tri.apexT, comp: tri.comp, lines: tri.lines,
    upper: tri.upperNow, lower: tri.lowerNow, width: tri.upperNow - tri.lowerNow, at: Date.now(), fired: false,
    armedUp: px <= tri.upperNow - 0.12 * tri.atr, armedDn: px >= tri.lowerNow + 0.12 * tri.atr
  };
  return w;
}

function ltStatus(w) {
  const a = w.atr;
  if (w.px >= w.upper - 0.4 * a) return 'ÜST ÇİZGİYE YAKIN';
  if (w.px <= w.lower + 0.4 * a) return 'ALT ÇİZGİYE YAKIN';
  return 'ÜÇGEN İÇİNDE';
}

function buildLtSignal(w, dir, px, line) {
  const atr = w.atr, h = Math.min(w.wS, 8 * atr), d = dir === 'LONG' ? 1 : -1;
  let sl = line - d * 0.6 * atr;
  if (d * (px - sl) < 0.8 * atr) sl = px - d * 0.8 * atr;
  const risk = Math.abs(px - sl), riskPct = risk / px * 100;
  if (!(risk > 0) || riskPct > 3.5) return null;
  const tp1 = px + d * Math.max(1.5 * risk, 0.4 * h), tp2 = px + d * Math.max(3 * risk, 0.8 * h);
  const altDir = market.alt ? market.alt.dir : 'NOTR';
  const align = dir === market.dir ? 'UYUMLU' : dir === altDir ? 'ALT UYUMLU' : (market.dir === 'NOTR' ? 'NÖTR' : 'TERS');
  const reasons = ['Simetrik üçgen (' + w.touchesHi + ' üst / ' + w.touchesLo + ' alt temas)', dir === 'LONG' ? 'Fiyat üst çizgiye değdi' : 'Fiyat alt çizgiye değdi', 'Piyasa ' + market.dir + ' · ' + align];
  const risks = [];
  if (align === 'TERS') risks.push('BTC/ETH yönüne ters');
  if (riskPct > 2.5) risks.push('Stop geniş');
  return {
    sym: w.sym, base: w.base, tf: w.tf, dir, entry: px, sl, tp1, tp2, score: Math.min(98, w.score + 4), setup: 'SİMETRİK ÜÇGEN DOKUNUŞ',
    reasons, risks, trigger: dir === 'LONG' ? 'ÜST ÇİZGİ DOKUNUŞU' : 'ALT ÇİZGİ DOKUNUŞU', market: market.dir, marketAlign: align, altDir,
    meta: { atr, riskPct: +riskPct.toFixed(3), upper: line && dir === 'LONG' ? line : w.upper, lower: dir === 'SHORT' ? line : w.lower, touchesHi: w.touchesHi, touchesLo: w.touchesLo, compression: w.comp, lines: w.lines, apexT: w.apexT }
  };
}

let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const syms = UNIVERSE.top.slice(0, Math.min(50, settings.topN)).map(x => x.sym);
    const tfs = settings.ltTfs.length ? settings.ltTfs : ['2h'];
    const prev = new Map(LT_WATCH.map(w => [w.key, w]));
    const rows = [];
    await pool(syms, 4, async sym => {
      for (const tf of tfs) {
        const cs = await getCandles(sym, tf, tf === '2h' ? 760 : 400);
        if (cs.length < 90) continue;
        const w = ltAnalyze(sym, tf, cs);
        if (!w || LT_FIRED.has(w.key)) continue;
        const o = prev.get(w.key);
        if (o) { w.armedUp = w.armedUp || o.armedUp; w.armedDn = w.armedDn || o.armedDn; }
        w.status = ltStatus(w);
        rows.push(w);
      }
    });
    rows.sort((a, b) => b.score - a.score);
    LT_WATCH = rows.slice(0, 60);
    lastScan.lt = Date.now();
    log('LT tarama: ' + syms.length + ' parite, ' + LT_WATCH.length + ' simetrik üçgen izleniyor');
  } finally { ltScanning = false; }
}

async function ltTick() {
  if (!LT_WATCH.length) return;
  const now = Date.now();
  for (const w of LT_WATCH) {
    if (w.fired) continue;
    const px = priceOf(w.sym);
    if (!px) continue;
    const ln = ltLines(w, now);
    if (ln.idx >= w.apex) { w.fired = true; continue; }             // üçgen süresi doldu
    w.px = px; w.upper = ln.upper; w.lower = ln.lower; w.width = ln.upper - ln.lower; w.status = ltStatus(w);
    const a = w.atr;
    if (px <= ln.upper - 0.12 * a) w.armedUp = true;
    if (px >= ln.lower + 0.12 * a) w.armedDn = true;
    let dir = null, line = 0;
    if (w.armedUp && px >= ln.upper - 0.04 * a) { if (px <= ln.upper + 0.9 * a) { dir = 'LONG'; line = ln.upper; } else { w.fired = true; continue; } }
    else if (w.armedDn && px <= ln.lower + 0.04 * a) { if (px >= ln.lower - 0.9 * a) { dir = 'SHORT'; line = ln.lower; } else { w.fired = true; continue; } }
    if (!dir) continue;
    w.fired = true; LT_FIRED.set(w.key, now);
    if (!canAdd('LT', w.sym)) continue;
    const sig = buildLtSignal(w, dir, px, line);
    if (!sig) continue;
    if (settings.ltMarketFilter && sig.marketAlign === 'TERS') { log('LT ' + w.sym + ' ' + dir + ' çizgiye değdi ama piyasa ' + market.dir + ' → sinyal verilmedi'); continue; }
    if (addSignal(Object.assign({ module: 'LT' }, sig))) log('LT çizgi dokunuşu: ' + w.sym + ' ' + w.tf + ' ' + dir);
  }
  LT_WATCH = LT_WATCH.filter(w => !w.fired && now - w.at < 6 * H1);
  for (const [k, t] of LT_FIRED) if (now - t > 12 * H1) LT_FIRED.delete(k);
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
  const last = signals.filter(s => s.module === module && s.sym === sym && s.status !== 'AI_RED').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - last.createdAt < COOLDOWN[module]) return false;
  const today = dayKey(now);
  return signals.filter(s => s.module === module && s.sym === sym && dayKey(s.createdAt) === today).length < MAX_DAY_SYM[module];
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
  const gate = aiGateOn();
  const sig = {
    id: 'S' + (++seq), module: mod, sym: raw.sym, base: raw.base || baseOf(raw.sym), dir,
    tf: raw.tf || MODULES[mod].tf, setup: raw.setup || '', entry, sl, sl0: sl, tp1, tp2,
    score: clamp(Math.round(num(raw.score, 60)), 0, 100),
    reasons: Array.isArray(raw.reasons) ? raw.reasons.slice(0, 6) : [], risks: Array.isArray(raw.risks) ? raw.risks.slice(0, 4) : [],
    trigger: raw.trigger || '', market: raw.market || market.dir, meta: raw.meta || {},
    marketAlign: raw.marketAlign || (dir === market.dir ? 'UYUMLU' : (market.alt && dir === market.alt.dir ? 'ALT UYUMLU' : 'TERS')),
    altDir: raw.altDir || (market.alt ? market.alt.dir : 'NOTR'),
    status: 'ACIK', closed: false, createdAt: Date.now(), closedAt: null, exit: null, finalPct: 0,
    curPct: 0, maxPct: null, minPct: null, maxR: null, minR: null, tp1Hit: false,
    ai: null, verdict: gate ? 'BEKLIYOR' : 'YOK', tradeable: mod === 'AUTO'
  };
  signals.push(sig);
  if (signals.length > 400) signals.splice(0, signals.length - 400);
  dirty = true;
  log('SİNYAL ' + MODULES[mod].label + ' ' + sig.sym + ' ' + dir + ' giriş ' + entry + ' stop ' + sl + ' tp1 ' + tp1 + ' tp2 ' + tp2 + ' (' + sig.score + ')' + (gate ? ' → AI inceliyor' : ''));
  if (gate) aiEnqueue(sig.id);
  else { if (aiReady()) aiEnqueue(sig.id); afterApprove(sig); }
  return sig;
}

// AI kapısı geçildi (ONAY) veya AI devre dışı/cevapsız: sinyal yayında kalır.
function afterApprove(sig) {
  if (sig && sig.module === 'AUTO' && settings.autoTrade && !sig.closed && !sig.traded) { sig.traded = true; maybeAutoTrade(sig); }
}

function maybeAutoTrade(sig) {
  if (!sig || sig.module !== 'AUTO' || !settings.autoTrade || sig.closed) return;
  if (settings.tradeMode === 'live' && liveReady()) liveOpen(sig).catch(e => log('Canlı açılış: ' + e.message));
  else openPaper(sig);
}

function closeSignal(s, result, exitPx) {
  if (!s || s.closed) return;
  s.closed = true; s.status = result; s.closedAt = Date.now(); s.exit = num(exitPx);
  const d = s.dir === 'LONG' ? 1 : -1;
  s.finalPct = result === 'AI_RED' ? 0 : +(((s.exit - s.entry) / s.entry * 100) * d).toFixed(4);
  s.curPct = s.finalPct;
  dirty = true;
  if (result !== 'AI_RED') log('KAPANDI ' + s.sym + ' ' + s.dir + ' ' + (RES[result] || result) + ' ' + s.finalPct + '%');
}

function monitorSignals() {
  const now = Date.now();
  for (const s of signals) {
    if (s.closed) continue;
    if (s.verdict === 'BEKLIYOR') {
      if (now - s.createdAt > 100000) { s.verdict = 'YOK'; s.ai = Object.assign({}, s.ai, { error: 'AI zamanında cevap vermedi; matematik sinyali olarak yayında' }); afterApprove(s); dirty = true; }
      continue;
    }
    const px = priceOf(s.sym);
    if (!px) continue;
    const d = s.dir === 'LONG' ? 1 : -1;
    const pct = (px - s.entry) / s.entry * 100 * d;
    s.curPct = +pct.toFixed(4);
    if (s.maxPct == null || pct > s.maxPct) s.maxPct = +pct.toFixed(4);
    if (s.minPct == null || pct < s.minPct) s.minPct = +pct.toFixed(4);
    const risk = Math.abs(s.entry - s.sl0);
    if (risk > 0) { const r = (px - s.entry) / risk * d; if (s.maxR == null || r > s.maxR) s.maxR = +r.toFixed(2); if (s.minR == null || r < s.minR) s.minR = +r.toFixed(2); }
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

/* ── AI: sinyal denetçisi (kapı) ──────────────────────────────────────────────
   Matematik motoru sinyal üretir; AI her sinyali bağımsız inceler ve ONAY / RED
   verir. RED olan sinyal yayından kalkar ve istatistiğe girmez. AI anahtarı yoksa
   ya da cevap vermezse sinyal "matematik" olarak yayında kalır (rozet gösterilir). */
const AI_PROVIDERS = [
  { id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', models: [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'] },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', models: [process.env.DEEPSEEK_MODEL, 'deepseek-chat'] },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', models: [process.env.GROQ_MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'] },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '', model: process.env.OPENAI_MODEL || 'gpt-4o-mini', models: [process.env.OPENAI_MODEL, 'gpt-4o-mini'] }
].map(p => Object.assign(p, { models: [...new Set(p.models.filter(Boolean))], ok: 0, fail: 0, lastError: null, cooldownUntil: 0 }));
const AI = { busy: false, lastError: null, hourKey: 0, hourCount: 0, brief: null, history: [], reviewed: 0, approved: 0, rejected: 0 };
const AI_Q = [];

function aiReady() { return settings.aiEnabled === true && AI_PROVIDERS.some(p => p.key); }
function aiGateOn() { return aiReady() && settings.aiMode === 'gate'; }

async function callAI(messages, maxTokens) {
  if (!aiReady()) return { error: settings.aiEnabled ? 'AI anahtarı yok (.env: GEMINI_API_KEY / DEEPSEEK_API_KEY / GROQ_API_KEY / OPENAI_API_KEY)' : 'AI kapalı' };
  const now = Date.now();
  if (AI.hourKey !== Math.floor(now / H1)) { AI.hourKey = Math.floor(now / H1); AI.hourCount = 0; }
  if (AI.hourCount >= 240) return { error: 'AI saatlik limiti doldu' };
  AI.hourCount++;
  for (const p of AI_PROVIDERS) {
    if (!p.key || p.cooldownUntil > Date.now()) continue;
    let lastErr = '';
    for (const model of p.models) {
      try {
        const body = { model, messages, temperature: 0.2, max_tokens: Math.max(maxTokens || 400, 1200) };
        if (p.id === 'gemini' && /2\.5/.test(model)) body.reasoning_effort = 'none';   // düşünme token'ı cevabı boşaltmasın
        const r = await fetchJson(p.base.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', timeout: 35000, retries: 1,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
          body: JSON.stringify(body)
        });
        const text = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
        if (!text || !String(text).trim()) throw new Error('boş yanıt (' + model + ')');
        p.model = model; p.ok++; AI.lastError = null; p.lastError = null;
        return { text: String(text).trim(), provider: p.name, model };
      } catch (e) {
        lastErr = model + ': ' + e.message;
        if (!/HTTP (400|404)|boş yanıt/.test(e.message)) break;   // yetki/limit hatasında diğer modeller denenmez
      }
    }
    p.fail++; p.lastError = lastErr; AI.lastError = p.name + ' → ' + lastErr;
    p.cooldownUntil = Date.now() + (/429|5\d\d/.test(lastErr) ? 90000 : 30000);
  }
  return { error: AI.lastError || 'AI yanıt vermedi' };
}

function parseAiJson(text) {
  try {
    const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  } catch (e) { /* yok */ }
  return null;
}

const AI_RULES = {
  TREND: 'Trend Takip: 15m rejim + 1h teyit + 5m EMA20 geri çekilme sonrası önceki mum kırılımı. Piyasa yönüne ters ya da nötr piyasada geçerli değildir. Giriş EMA20\'den uzaksa, hacim/gövde zayıfsa, RSI uçtaysa veya stop yapının içindeyse RED.',
  LT: 'LT Üçgen: simetrik üçgenin üst/alt çizgisine fiyat değdi. Çizgi kırılımı gerçek mi (mum gövdesi/hacim/yapı), sahte iğne mi değerlendir. Piyasa yönüne TERS ise güçlü kanıt yoksa RED.',
  AUTO: 'OtoTrade: 1 dakikalık pump/dump ivmesi. İvme çok geç/aşırı uzamışsa, hacim desteksizse, 5m trende ters ya da piyasa yönüne ters ise RED.'
};

async function aiReview(sig) {
  const cs = await getCandles(sig.sym, sig.tf, 120);
  const closed = cs.slice(0, -1).slice(-24);
  const rpv = v => v >= 1 ? +v.toFixed(4) : +v.toPrecision(5);
  const candles = closed.map(c => [rpv(c.o), rpv(c.h), rpv(c.l), rpv(c.c), Math.round(c.v)].join(' ')).join('\n');
  const m = sig.meta || {};
  const facts = [
    'MODÜL: ' + MODULES[sig.module].label + ' | ' + sig.setup,
    'KURAL: ' + AI_RULES[sig.module],
    'SİNYAL: ' + sig.dir + ' ' + sig.sym + ' [' + sig.tf + '] giriş ' + sig.entry + ' stop ' + sig.sl0 + ' TP1 ' + sig.tp1 + ' TP2 ' + sig.tp2 + ' | motor skoru ' + sig.score,
    'NEDENLER: ' + (sig.reasons.join('; ') || '-'),
    'RİSKLER: ' + (sig.risks.join('; ') || '-'),
    'GÖSTERGELER: ' + JSON.stringify({ atr: m.atr, riskPct: m.riskPct, adx: m.adx, rsi: m.rsi, hacimOrani: m.volRatio, emaUzaklikATR: m.distAtr, ivme3m: m.chg3, ustCizgi: m.upper, altCizgi: m.lower, temas: m.touchesHi != null ? m.touchesHi + '/' + m.touchesLo : undefined }),
    'PİYASA: ' + market.dir + ' (skor ' + market.score + '/100) | Alt coin yönü: ' + (market.alt ? market.alt.dir : '-') + ' | Sinyal-piyasa uyumu: ' + sig.marketAlign,
    'BTC: ' + (market.btc ? market.btc.why : '-') + ' | ETH: ' + (market.eth ? market.eth.why : '-'),
    'SON ' + closed.length + ' KAPANMIŞ MUM (o h l c hacim):\n' + candles
  ].join('\n');
  return callAI([
    { role: 'system', content: 'Sen deneyimli bir kripto vadeli işlem sinyal denetçisisin. Matematiksel motor bir sinyal üretti; görevin bunu BAĞIMSIZ doğrulamak ya da reddetmektir. Yatırım tavsiyesi vermezsin. Sayı uydurma, yalnızca verilen veriyi kullan. Emin değilsen RED ver. SADECE şu JSON\'u döndür: {"karar":"ONAY" veya "RED","guven":0-100,"yorum":"en çok 3 cümle Türkçe gerekçe","risk":"tek cümle ana risk","not":"giriş/stop için kısa pratik not"}' },
    { role: 'user', content: facts }
  ], 420);
}

function aiEnqueue(id) { if (!AI_Q.includes(id)) AI_Q.push(id); aiPump(); }

async function aiPump() {
  if (AI.busy) return;
  const id = AI_Q.shift();
  if (!id) return;
  AI.busy = true;
  const sig = signals.find(s => s.id === id);
  try {
    if (!sig || sig.closed && sig.status !== 'ACIK' && sig.status !== 'TP1' && sig.verdict !== 'BEKLIYOR') return;
    const r = await aiReview(sig);
    const gate = sig.verdict === 'BEKLIYOR';
    if (r.error) {
      sig.ai = { error: r.error, at: Date.now() };
      if (gate) { sig.verdict = 'YOK'; afterApprove(sig); }
    } else {
      const j = parseAiJson(r.text);
      const conf = j ? clamp(Math.round(num(j.guven, 50)), 0, 100) : 50;
      const ok = j && String(j.karar || '').toUpperCase().startsWith('ONAY') && conf >= settings.aiMinConf;
      sig.ai = { karar: ok ? 'ONAY' : 'RED', guven: conf, text: (j && (j.yorum || j.comment)) || r.text.slice(0, 400), risk: (j && j.risk) || '', note: (j && j.not) || '', provider: r.provider, model: r.model, at: Date.now() };
      AI.reviewed++; ok ? AI.approved++ : AI.rejected++;
      AI.history.unshift({ id: sig.id, sym: sig.sym, module: sig.module, dir: sig.dir, karar: sig.ai.karar, guven: conf, text: sig.ai.text, risk: sig.ai.risk, provider: r.provider, at: sig.ai.at });
      if (AI.history.length > 80) AI.history.splice(80);
      if (gate) {
        if (ok) { sig.verdict = 'ONAY'; afterApprove(sig); }
        else { sig.verdict = 'RED'; closeSignal(sig, 'AI_RED', sig.entry); log('AI RED: ' + sig.sym + ' ' + sig.dir + ' (' + conf + ') ' + sig.ai.text.slice(0, 120)); }
      } else sig.verdict = sig.verdict === 'YOK' ? 'YOK' : sig.verdict;
    }
    dirty = true;
  } catch (e) {
    if (sig && sig.verdict === 'BEKLIYOR') { sig.verdict = 'YOK'; sig.ai = { error: e.message, at: Date.now() }; afterApprove(sig); }
  } finally {
    AI.busy = false;
    setTimeout(aiPump, 1200);
  }
}

async function aiBrief(force) {
  if (!aiReady()) return { error: 'AI kapalı veya anahtar yok' };
  if (!force && AI.brief && Date.now() - AI.brief.at < 30 * M1) return AI.brief;
  const facts = ['Piyasa: ' + market.dir + ' (skor ' + market.score + '/100)', 'Neden: ' + market.why, 'Hareketliler: ' + UNIVERSE.movers.slice(0, 8).map(t => t.sym + ' ' + t.chg24.toFixed(1) + '%').join(', ')].join('\n');
  const r = await callAI([
    { role: 'system', content: 'Kripto piyasa asistanısın. Yatırım tavsiyesi vermezsin. Sadece JSON: {"yorum":"2-3 cümle Türkçe","risk":"tek cümle"}' },
    { role: 'user', content: facts }
  ], 300);
  if (r.error) return r;
  const j = parseAiJson(r.text);
  AI.brief = { text: (j && j.yorum) || r.text, risk: (j && j.risk) || '', provider: r.provider, dir: market.dir, at: Date.now() };
  dirty = true;
  return AI.brief;
}

function aiStatus() {
  return {
    enabled: settings.aiEnabled === true, mode: settings.aiMode, ready: aiReady(), gate: aiGateOn(), busy: AI.busy, queue: AI_Q.length, lastError: AI.lastError,
    reviewed: AI.reviewed, approved: AI.approved, rejected: AI.rejected, minConf: settings.aiMinConf,
    providers: AI_PROVIDERS.map(p => ({ id: p.id, name: p.name, key: !!p.key, model: p.model, ok: p.ok, fail: p.fail, lastError: p.lastError, cooldown: p.cooldownUntil > Date.now() })),
    brief: AI.brief, history: AI.history.slice(0, 30)
  };
}


/* ── görünüm / istatistik ─────────────────────────────────────────────────── */
const TV_INT = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D' };
function tvUrl(sym, tf) {
  return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(settings.tvExchange + ':' + sym + '.P') + '&interval=' + (TV_INT[tf] || '60');
}

function viewSignal(s) {
  return {
    id: s.id, module: s.module, sym: s.sym, base: s.base, dir: s.dir, tf: s.tf, setup: s.setup,
    entry: s.entry, sl: s.sl0, slNow: s.sl, tp1: s.tp1, tp2: s.tp2, score: s.score,
    reasons: s.reasons, risks: s.risks, trigger: s.trigger, market: s.market, marketAlign: s.marketAlign, altDir: s.altDir,
    status: s.status, statusLabel: RES[s.status] || s.status, closed: s.closed,
    createdAt: s.createdAt, closedAt: s.closedAt, exit: s.exit, finalPct: s.finalPct,
    curPct: s.curPct, maxPct: s.maxPct, minPct: s.minPct, maxR: s.maxR, minR: s.minR,
    tp1Hit: s.tp1Hit, tradeable: s.tradeable, verdict: s.verdict, ai: s.ai, tv: tvUrl(s.sym, s.tf),
    meta: Object.assign({}, s.meta, { lines: undefined })
  };
}

function calcStats() {
  const out = {};
  const real = signals.filter(s => s.status !== 'AI_RED');
  for (const m of ACTIVE_MODULES) {
    const arr = real.filter(s => s.module === m), final = arr.filter(s => s.closed);
    const count = st => final.filter(s => s.status === st).length;
    const tp1 = count('TP1'), tp2 = count('TP2'), sl = count('SL'), be = count('BE'), time = count('TIME'), man = count('MANUEL');
    const wins = tp1 + tp2 + arr.filter(s => !s.closed && s.tp1Hit).length;
    const losses = sl;
    out[m] = {
      total: arr.length, open: arr.filter(s => !s.closed).length, tp1, tp2, sl, be, time, manuel: man,
      aiRed: signals.filter(s => s.module === m && s.status === 'AI_RED').length,
      winRate: (wins + losses) > 0 ? +(wins / (wins + losses) * 100).toFixed(1) : 0,
      avgMaxPct: +avg(arr.map(s => s.maxPct)).toFixed(2), avgFinalPct: +avg(final.map(s => s.finalPct)).toFixed(2)
    };
  }
  const allFinal = real.filter(s => s.closed);
  const wins = real.filter(s => s.status === 'TP1' || s.status === 'TP2' || (!s.closed && s.tp1Hit) || (s.closed && s.tp1Hit && s.status === 'BE')).length;
  const losses = allFinal.filter(s => s.status === 'SL').length;
  return {
    byModule: out, total: real.length, open: real.filter(s => !s.closed).length, closed: allFinal.length, wins, losses,
    aiRed: signals.filter(s => s.status === 'AI_RED').length,
    winRate: (wins + losses) ? +(wins / (wins + losses) * 100).toFixed(1) : 0, updatedAt: Date.now()
  };
}

function viewWatchLt(w) {
  return {
    sym: w.sym, base: w.base, tf: w.tf, status: w.status, px: w.px, upper: w.upper, lower: w.lower, width: w.width,
    touchesHi: w.touchesHi, touchesLo: w.touchesLo, score: w.score, apexT: w.apexT, atr: w.atr,
    distUp: w.px > 0 ? +((w.upper - w.px) / w.px * 100).toFixed(2) : null, distDn: w.px > 0 ? +((w.px - w.lower) / w.px * 100).toFixed(2) : null,
    tv: tvUrl(w.sym, w.tf), at: w.at
  };
}
const withTv = (w, tf) => Object.assign({}, w, { tv: tvUrl(w.sym, tf || w.tf) });

/* ── grafik verisi ────────────────────────────────────────────────────────── */
function lineData(cs, arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] != null) out.push({ time: Math.floor(cs[i].t / 1000), value: +arr[i].toFixed(8) });
  return out;
}

async function chartPayload(sym, tf, module, signalId) {
  const cs = await getCandles(sym, tf, tf === '2h' ? 760 : 400);
  if (!cs.length) throw new Error('Mum verisi alınamadı: ' + sym + ' ' + tf);
  const candles = cs.map(c => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c }));
  const cl = cs.map(c => c.c);
  const signal = signalId ? signals.find(s => s.id === signalId) : null;
  let triangle = null;
  if (signal && signal.meta && signal.meta.lines) triangle = signal.meta.lines;
  if (!triangle && (module === 'LT' || ['1h', '2h', '4h'].includes(tf))) {
    const w = LT_WATCH.find(x => x.sym === sym && x.tf === tf);
    if (w) triangle = w.lines;
    else if (module === 'LT') { const t = detectTriangle(cs, tf); if (t) triangle = t.lines; }
  }
  const markers = signal ? [{ time: Math.floor(signal.createdAt / 1000), position: signal.dir === 'LONG' ? 'belowBar' : 'aboveBar', color: signal.dir === 'LONG' ? '#22c55e' : '#ef4444', shape: signal.dir === 'LONG' ? 'arrowUp' : 'arrowDown', text: signal.dir }] : [];
  return { sym, tf, module, candles, ema20: lineData(cs, emaArr(cl, 20)), ema50: lineData(cs, emaArr(cl, 50)), triangle, signal: signal ? viewSignal(signal) : null, markers, tv: tvUrl(sym, tf) };
}

/* ── Express ──────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '300kb' }));
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  if (String(req.get('x-api-token') || req.query.token || '') !== API_TOKEN) return res.status(401).json({ error: 'API token gerekli' });
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
    signals: signals.slice(-150).reverse().map(viewSignal), stats: calcStats(),
    modules: Object.fromEntries(ACTIVE_MODULES.map(k => [k, MODULES[k]])),
    watch: { auto: AUTO_WATCH.slice(0, 30).map(w => withTv(w, '1m')), trend: TREND_WATCH.slice(0, 30).map(w => withTv(w, '5m')), lt: LT_WATCH.filter(w => !w.fired).slice(0, 40).map(viewWatchLt) },
    paper: paperSummary(), live: liveSummary(), ai: aiStatus(), lastScan,
    universe: { count: UNIVERSE.all.length, top: UNIVERSE.top.length, movers: UNIVERSE.movers.length, at: UNIVERSE.at },
    env: { bitget: HAS_KEYS, token: !!API_TOKEN, ai: AI_PROVIDERS.filter(p => p.key).map(p => p.id) }, logs: LOGS.slice(-60)
  });
}));

app.get('/api/signals', h((req, res) => {
  const module = String(req.query.module || '').toUpperCase();
  const limit = clamp(Math.round(num(req.query.limit, 100)), 1, 300);
  let arr = signals.slice().reverse();
  if (module) arr = arr.filter(s => s.module === module);
  res.json({ items: arr.slice(0, limit).map(viewSignal) });
}));
app.get('/api/signal/:id', h((req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'sinyal yok' });
  res.json({ signal: viewSignal(s), price: priceOf(s.sym), market });
}));
app.post('/api/signal/:id/review', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'sinyal yok' });
  if (!aiReady()) return res.status(400).json({ error: 'AI kapalı veya anahtar yok' });
  const was = s.verdict;
  s.verdict = was === 'RED' ? 'RED' : was;      // yeniden inceleme yalnız yorum günceller
  const r = await aiReview(s);
  if (r.error) return res.status(400).json({ error: r.error });
  const j = parseAiJson(r.text);
  s.ai = { karar: j && String(j.karar || '').toUpperCase().startsWith('ONAY') ? 'ONAY' : 'RED', guven: j ? num(j.guven, 50) : 50, text: (j && j.yorum) || r.text.slice(0, 400), risk: (j && j.risk) || '', note: (j && j.not) || '', provider: r.provider, model: r.model, at: Date.now() };
  dirty = true;
  res.json({ ok: true, signal: viewSignal(s) });
}));
app.post('/api/signal/:id/close', h((req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'sinyal yok' });
  closeSignal(s, 'MANUEL', priceOf(s.sym) || s.entry);
  res.json({ ok: true, signal: viewSignal(s) });
}));

app.get('/api/stats', h((req, res) => res.json(calcStats())));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));

app.get('/api/chart', h(async (req, res) => {
  const signalId = String(req.query.signal || '');
  const sig = signalId ? signals.find(s => s.id === signalId) : null;
  const module = String(req.query.module || (sig ? sig.module : 'TREND')).toUpperCase();
  const sym = String(req.query.sym || (sig ? sig.sym : 'BTCUSDT')).toUpperCase();
  const tf = String(req.query.tf || (sig ? sig.tf : (MODULES[module] ? MODULES[module].chartTf : '5m')));
  if (!TF_MS[tf]) return res.status(400).json({ error: 'geçersiz zaman dilimi' });
  res.json(await chartPayload(sym, tf, module, signalId));
}));

app.post('/api/scan/:module', h(async (req, res) => {
  const m = String(req.params.module || '').toUpperCase();
  if (m === 'AUTO') await autoScan(); else if (m === 'TREND') await trendScan(); else if (m === 'LT') await ltScan();
  else return res.status(400).json({ error: 'bilinmeyen modül' });
  res.json({ ok: true });
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

app.get('/api/ai/status', h((req, res) => res.json(aiStatus())));
app.post('/api/ai/toggle', h((req, res) => { settings.aiEnabled = !!(req.body && req.body.on === true); dirty = true; saveState(true); res.json({ ok: true, enabled: settings.aiEnabled }); }));
app.post('/api/ai/brief', h(async (req, res) => { const b = await aiBrief(true); if (b && b.error) return res.status(400).json(b); res.json({ ok: true, brief: b }); }));
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
  version: VERSION, ready: READY, uptime: process.uptime(), universe: UNIVERSE.all.length, cache: CANDLE_CACHE.size, signals: signals.length,
  lastScan, market: { dir: market.dir, score: market.score, raw: market.raw }, ai: aiStatus(), tickHist: TICKHIST.size
})));
app.use((req, res) => res.status(404).json({ error: 'yol yok', path: req.path, version: VERSION }));

/* ── döngüler ─────────────────────────────────────────────────────────────── */
function every(ms, name, fn, immediate) {
  const run = () => Promise.resolve().then(fn).catch(e => logOnce('loop:' + name, name + ' döngü hatası: ' + e.message, 30000));
  if (immediate) setTimeout(run, 800);
  return setInterval(run, ms);
}
function startLoops() {
  every(4000, 'tick', async () => { await refreshTickers(); monitorSignals(); monitorPaper(); await ltTick(); await monitorLive(); lastScan.tick = Date.now(); }, true);
  every(45e3, 'market', updateMarket, false);
  every(30e3, 'auto', autoScan, false);
  every(70e3, 'trend', trendScan, false);
  every(3 * 60e3, 'lt', ltScan, false);
  setTimeout(() => autoScan().catch(e => log('auto ilk tarama: ' + e.message)), 4000);
  setTimeout(() => trendScan().catch(e => log('trend ilk tarama: ' + e.message)), 12000);
  setTimeout(() => ltScan().catch(e => log('lt ilk tarama: ' + e.message)), 20000);
  every(10e3, 'save', () => saveState(false), true);
  every(30 * 60e3, 'ai', () => { if (aiReady()) aiBrief(false); }, false);
}

async function init() {
  loadState();
  log('AlphaSon ' + VERSION + ' başlıyor...');
  await refreshTickers(true);
  await updateMarket();
  READY = true;
  saveState(true);
  startLoops();
  log('Hazır. ' + UNIVERSE.all.length + ' parite, piyasa ' + market.dir + ' (skor ' + market.score + ') | AI ' + (aiGateOn() ? 'KAPI modunda' : aiReady() ? 'yorum modunda' : 'kapalı/anahtar yok'));
}

process.on('unhandledRejection', e => log('Yakalanmayan hata: ' + (e && e.message ? e.message : e)));
process.on('uncaughtException', e => log('Kritik hata: ' + (e && e.message ? e.message : e)));

const server = app.listen(PORT, () => { log('Sunucu http://localhost:' + PORT); init().catch(e => log('Başlatma hatası: ' + e.message)); });
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
