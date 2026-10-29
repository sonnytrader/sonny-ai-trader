'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v91.0 — sade sürüm
   Modüller:
   1) OtoTrade  : 1m + ticker ivmesiyle PUMP/DUMP ilk ateşini yakalar, ivme
                  bitince anında kapatır. AI girişi geciktirmez; girişten
                  sonra 2-3 sn içinde "gerçek mi / fake mi" kontrolü yapar.
   2) Trend Scalp: 5m EMA21/55 + 15m yön + geri çekilme/geri kırılım.
                  AI kapısı YOK; sinyal üretimi matematikle anında olur.
   3) LT Üçgen  : 2h simetrik üçgen. Otomatik tarama + kullanıcının grafikten
                  4 nokta ile çizdiği manuel üçgen. Çizgiye temas = sinyal.
   Kaldırıldı: Momentum Hunter, Piyasa Radarı, Fırsatlar, Outcome Ölçüm,
               Strateji Rehberi, Backtest, AI onay kuyruğu.
   ══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const ccxt = require('ccxt');

(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (e) { /* sessiz */ }
})();

const VERSION = 'v91.0';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M5 = 5 * M1, M15 = 15 * M1, H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '5m': M5, '15m': M15, '1h': H1, '2h': H2, '4h': H4 };
const TTL = { '1m': 6e3, '5m': 45e3, '15m': 90e3, '1h': 4 * M1, '2h': 10 * M1, '4h': 15 * M1 };
const EPS = 1e-9;

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(os.tmpdir(), 'alphason-v91');
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

// Paper: komisyon + slipaj toplamı (tur). Canlı: gerçekleşen fill slipajı içerdiği
// için yalnızca komisyon düşülür.
const EX = { COST: 0.24, H: 0.20, MAX_RISK: 4.0, MIN_RISK: 0.15 };

const DEF_SET = {
  autoTrade: false, tradeMode: 'paper', aiEnabled: false, aiAutoVeto: true, aiMinConfidence: 60,
  margin: 100, leverage: 3, riskPct: 0.35, maxOpen: 2, dailyLossPct: 2,
  paperEquity: 1000, topN: 100, minQuoteVol: 5e6, maxSpreadPct: 0.08, includeStocks: false,
  // OtoTrade — 1m ivme
  impulseMinPct: 0.55, impulseVolMult: 2.0, impulseMaxHoldSec: 180,
  impulseNoMoveSec: 45, impulseTp1R: 1.0, impulseTp2R: 1.8, impulseTp1Fraction: 0.5,
  // Trend Scalp — 5m
  trendEnabled: true, trendTp1R: 1.4, trendTp2R: 2.4,
  // LT Üçgen — 2h
  ltEnabled: true, ltTouchAtr: 0.35
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rp = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1000) return +n.toFixed(2);
  if (n >= 1) return +n.toFixed(4);
  if (n >= 0.01) return +n.toFixed(6);
  return +n.toFixed(8);
};
const avg = a => {
  const x = (a || []).map(Number).filter(Number.isFinite);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;
};
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const utcDayStart = ts => Math.floor((ts || Date.now()) / D1) * D1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtPct = v => (Number(v) >= 0 ? '+' : '') + num(v, 2).toFixed(2) + '%';
const moreProtective = (a, b, d) => {
  const x = num(a, 0), y = num(b, 0);
  if (!(x > 0)) return y;
  if (!(y > 0)) return x;
  return d === 1 ? Math.max(x, y) : Math.min(x, y);
};
const capArr = (a, n) => { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; };

const TOKENIZED_STOCKS = new Set([
  'INTC', 'MSTR', 'KORU', 'SNXX', 'TSLA', 'NVDA', 'AAPL', 'COIN', 'HOOD', 'CRCL', 'AMZN', 'GOOGL', 'MSFT',
  'META', 'SPY', 'QQQ', 'PLTR', 'AMD', 'NFLX', 'BABA', 'MARA', 'RIOT', 'CBRS', 'TQQQ', 'BE', 'CRWV', 'XAG'
]);
const isStock = sym => TOKENIZED_STOCKS.has(baseOf(sym));

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.autoTrade = s.autoTrade === true;
  s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.aiEnabled = s.aiEnabled === true;
  s.aiAutoVeto = s.aiAutoVeto !== false;
  s.aiMinConfidence = clamp(Math.round(num(s.aiMinConfidence, 60)), 0, 100);
  s.margin = clamp(num(s.margin, 100), 10, 100000);
  s.leverage = clamp(Math.round(num(s.leverage, 3)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, 0.35), 0.05, 3);
  s.maxOpen = clamp(Math.round(num(s.maxOpen, 2)), 1, 10);
  s.dailyLossPct = clamp(num(s.dailyLossPct, 2), 0.5, 50);
  s.paperEquity = clamp(num(s.paperEquity, 1000), 10, 1e9);
  s.topN = clamp(Math.round(num(s.topN, 100)), 10, 150);
  s.minQuoteVol = clamp(num(s.minQuoteVol, 5e6), 1e5, 1e9);
  s.maxSpreadPct = clamp(num(s.maxSpreadPct, 0.08), 0.01, 1);
  s.includeStocks = s.includeStocks === true;
  s.impulseMinPct = clamp(num(s.impulseMinPct, 0.55), 0.15, 5);
  s.impulseVolMult = clamp(num(s.impulseVolMult, 2.0), 1.0, 10);
  s.impulseMaxHoldSec = clamp(Math.round(num(s.impulseMaxHoldSec, 180)), 30, 1800);
  s.impulseNoMoveSec = clamp(Math.round(num(s.impulseNoMoveSec, 45)), 15, 600);
  s.impulseTp1R = clamp(num(s.impulseTp1R, 1.0), 0.5, 3);
  s.impulseTp2R = clamp(num(s.impulseTp2R, 1.8), 1.0, 5);
  s.impulseTp1Fraction = clamp(num(s.impulseTp1Fraction, 0.5), 0.1, 1);
  s.trendEnabled = s.trendEnabled !== false;
  s.trendTp1R = clamp(num(s.trendTp1R, 1.4), 0.8, 4);
  s.trendTp2R = clamp(num(s.trendTp2R, 2.4), 1.2, 6);
  s.ltEnabled = s.ltEnabled !== false;
  s.ltTouchAtr = clamp(num(s.ltTouchAtr, 0.35), 0.10, 1.5);
  return s;
}

let settings = sanitizeSettings({});
let signals = [];
let paper = {
  open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity,
  dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity
};
let LIVE = {
  open: [], closed: [], balance: null, positions: null, dayStart: 0, dayKey: dayKey(),
  lastError: null, lastSync: 0, busy: false, ipHint: null
};
let ltManual = [];
let aiHist = [];
let LOGS = [];
let REJ = [];
let AUTO_WATCH = [], TREND_WATCH = [], LT_WATCH = [];
const LT_TRI = new Map();
const AUTO_LAST = new Map();
const LT_FIRED = new Map();
const CACHE = new Map();
const INFLIGHT = new Map();
const TICK = new Map();
const TICKHIST = new Map();
const ATR_CACHE = new Map();
let UNIVERSE = [];
let READY = false;
let dirty = false;
let saveTimer = null;
let scan = { autoAt: 0, trendAt: 0, ltAt: 0, tickAt: 0, universe: 0 };

function log(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + String(msg || '');
  LOGS.push(line);
  capArr(LOGS, 300);
  console.log(line);
}
function logOnce(key, msg, ms) {
  const k = 'once:' + key;
  const now = Date.now();
  if (!logOnce._m) logOnce._m = new Map();
  const last = logOnce._m.get(k) || 0;
  if (now - last < (ms || 60e3)) return;
  logOnce._m.set(k, now);
  log(msg);
}
function redact(s) { return String(s || '').replace(/(key|secret|passphrase|token|authorization)([=:]\s*)[^\s,;]+/gi, '$1$2***').slice(0, 400); }


/* ───────────────────────────── göstergeler ───────────────────────────── */
function emaArr(vals, len) {
  const out = [];
  if (!Array.isArray(vals) || !vals.length) return out;
  const k = 2 / (len + 1);
  let e = Number(vals[0]);
  for (let i = 0; i < vals.length; i++) {
    const v = Number(vals[i]);
    if (!Number.isFinite(v)) { out.push(e); continue; }
    e = i === 0 ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
const emaLast = (vals, len) => { const a = emaArr(vals, len); return a.length ? a[a.length - 1] : null; };

function rsiLast(closes, len = 14) {
  if (!closes || closes.length < len + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / len, al = loss / len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + Math.max(0, d)) / len;
    al = (al * (len - 1) + Math.max(0, -d)) / len;
  }
  if (al <= 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

function atrArr(cs, len = 14) {
  const out = [];
  if (!cs || cs.length < 2) return out;
  let prev = null;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    prev = prev == null ? tr : (prev * (len - 1) + tr) / len;
    out.push(prev);
  }
  return out;
}
const atrLast = (cs, len = 14) => { const a = atrArr(cs, len); return a.length ? a[a.length - 1] : null; };

function bodyRatio(c) { const r = c.h - c.l; return r > 0 ? Math.abs(c.c - c.o) / r : 0; }
function closesOf(cs) { return (cs || []).map(c => c.c); }
function toC(a) { return { t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0 }; }
function closed(cs, tfMs) {
  if (!cs || !cs.length) return [];
  const last = cs[cs.length - 1];
  return last.t + tfMs <= Date.now() ? cs.slice() : cs.slice(0, -1);
}
// 1h → 2h gibi toplamalarda UTC sınırına hizalar. Eski kodun kaydırma hatasını önler.
function aggTF(cs, factor, srcTfMs) {
  const size = srcTfMs * factor;
  const map = new Map();
  for (const c of cs || []) {
    const k = Math.floor(c.t / size) * size;
    let b = map.get(k);
    if (!b) { b = { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: 0 }; map.set(k, b); }
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; }
    b.v += c.v;
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}
function fmtCandles(cs, n) {
  return (cs || []).slice(-n).map(c => {
    const p = c.c >= 1 ? 4 : 6;
    return new Date(c.t).toISOString().slice(5, 16).replace('T', ' ') +
      ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v);
  }).join('\n');
}
function pivots(cs, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < cs.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) hi = false;
      if (cs[j].l <= cs[i].l) lo = false;
    }
    if (hi) out.push({ i, type: 'H', p: cs[i].h, t: cs[i].t });
    if (lo) out.push({ i, type: 'L', p: cs[i].l, t: cs[i].t });
  }
  return out;
}

/* ───────────────────────────── borsa katmanı ───────────────────────────── */
const ex = new ccxt.bitget({
  apiKey: API_KEY || undefined,
  secret: API_SECRET || undefined,
  password: API_PASS || undefined,
  enableRateLimit: true,
  timeout: 20000,
  options: { defaultType: 'swap', defaultSubType: 'linear' }
});

const FALLBACK = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT',
  'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT',
  'TON/USDT:USDT', 'DOT/USDT:USDT', 'LTC/USDT:USDT', 'BCH/USDT:USDT', 'NEAR/USDT:USDT',
  'APT/USDT:USDT', 'ARB/USDT:USDT', 'OP/USDT:USDT', 'INJ/USDT:USDT', 'TIA/USDT:USDT'
];
const EXCLUDE = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'EUR', 'GBP', 'BUSD',
  'BTC3L', 'BTC3S', 'ETH3L', 'ETH3S', 'SOL3L', 'SOL3S', 'XRP3L', 'XRP3S']);

async function pool(items, n, fn) {
  const list = (items || []).slice();
  let idx = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx++;
      try { await fn(list[i], i); } catch (e) { /* tek hata taramayı durdurmaz */ }
    }
  });
  await Promise.all(workers);
}

function scanSyms(n) {
  const l = UNIVERSE.filter(s => settings.includeStocks || !isStock(s));
  return l.slice(0, n || settings.topN);
}

function tick(sym) { return TICK.get(sym) || null; }
function priceOf(sym, maxAgeMs) {
  const t = tick(sym);
  const maxAge = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 20e3;
  return t && t.last > 0 && t.ts > 0 && Date.now() - t.ts <= maxAge ? t.last : 0;
}
function spreadPct(sym) {
  const t = tick(sym);
  if (!t || !(t.bid > 0) || !(t.ask > 0) || !(t.ts > 0) || Date.now() - t.ts > 20e3) return 99;
  return (t.ask - t.bid) / t.bid * 100;
}
async function freshPrice(sym, maxAgeMs) {
  const cached = priceOf(sym, maxAgeMs || 5000);
  if (cached > 0) return { price: cached, priceAt: tick(sym).ts, source: 'cache' };
  try {
    const t = await ex.fetchTicker(sym);
    const price = num(t && (t.last || t.close));
    if (!(price > 0)) return { price: 0, priceAt: 0, error: 'fiyat yok' };
    TICK.set(sym, { last: price, bid: num(t.bid), ask: num(t.ask), qv: num(t.quoteVolume), chg: num(t.percentage), ts: Date.now() });
    return { price, priceAt: Date.now(), source: 'exchange' };
  } catch (e) {
    return { price: 0, priceAt: 0, error: 'fiyat alınamadı: ' + redact(e.message) };
  }
}

async function refreshUniverse() {
  try {
    const all = await ex.fetchTickers();
    const rows = [];
    for (const sym of Object.keys(all)) {
      if (!sym.endsWith('/USDT:USDT')) continue;
      const b = baseOf(sym);
      if (EXCLUDE.has(b)) continue;
      const t = all[sym] || {};
      const last = num(t.last), qv = num(t.quoteVolume), bid = num(t.bid), ask = num(t.ask);
      if (!(last > 0) || qv < settings.minQuoteVol) continue;
      const sp = bid > 0 && ask > 0 ? (ask - bid) / bid * 100 : 99;
      if (sp > settings.maxSpreadPct) continue;
      TICK.set(sym, { last, bid, ask, qv, chg: num(t.percentage), ts: Date.now() });
      rows.push({ sym, qv });
    }
    rows.sort((a, b) => b.qv - a.qv);
    const next = rows.slice(0, settings.topN).map(r => r.sym);
    if (next.length) { UNIVERSE = next; log('Evren: ' + UNIVERSE.length + ' coin'); }
  } catch (e) {
    log('Evren alınamadı: ' + redact(e.message));
    if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice();
  }
  if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice();
  scan.universe = UNIVERSE.length;
}

async function refreshTickers() {
  try {
    const all = await ex.fetchTickers();
    const now = Date.now();
    for (const sym of Object.keys(all)) {
      if (!sym.endsWith('/USDT:USDT')) continue;
      if (UNIVERSE.length && !UNIVERSE.includes(sym)) continue;
      const t = all[sym] || {};
      const last = num(t.last), bid = num(t.bid), ask = num(t.ask);
      if (!(last > 0)) continue;
      TICK.set(sym, { last, bid, ask, qv: num(t.quoteVolume), chg: num(t.percentage), ts: now });
      let hh = TICKHIST.get(sym);
      if (!hh) { hh = []; TICKHIST.set(sym, hh); }
      hh.push({ t: now, p: last });
      if (hh.length > 140) hh.splice(0, hh.length - 140);
    }
    scan.tickAt = now;
  } catch (e) { /* sessiz */ }
}

// Son X saniyedeki yüzde değişim (ticker geçmişinden). Yeterli aralık yoksa null.
function retPct(sym, sec) {
  const h = TICKHIST.get(sym);
  if (!h || h.length < 2) return null;
  const last = h[h.length - 1];
  const target = last.t - sec * 1000;
  let old = null;
  for (let i = h.length - 1; i >= 0; i--) { if (h[i].t <= target) { old = h[i]; break; } }
  if (!old) old = h[0];
  const dt = (last.t - old.t) / 1000;
  if (dt < Math.max(8, sec * 0.35)) return null;
  if (!(old.p > 0)) return null;
  return (last.p / old.p - 1) * 100;
}

async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const ent = CACHE.get(key);
  if (ent && now - ent.t < (TTL[tf] || 60e3) && (ent.lim || 0) >= limit) return ent.data.slice(-limit);
  const pending = INFLIGHT.get(key);
  if (pending && pending.limit >= limit) {
    try { const d = await pending.promise; return d ? d.slice(-limit) : null; } catch (e) { return null; }
  }
  const p = (async () => {
    let data = null;
    try {
      const raw = await ex.fetchOHLCV(sym, tf, undefined, limit);
      if (raw && raw.length) data = raw.map(toC);
    } catch (e) {
      const cur = CACHE.get(key);
      return cur && cur.data && cur.data.length ? cur.data : null;
    }
    const cur = CACHE.get(key);
    if (!data || !data.length) return cur && cur.data ? cur.data : null;
    CACHE.set(key, { t: Date.now(), data, lim: limit });
    if (CACHE.size > 500) {
      const cutoff = Date.now() - 30 * M1;
      for (const [k, v] of CACHE) if (v.t < cutoff) CACHE.delete(k);
    }
    return data;
  })();
  INFLIGHT.set(key, { promise: p, limit });
  try { const data = await p; return data ? data.slice(-limit) : null; }
  finally { const cur = INFLIGHT.get(key); if (cur && cur.promise === p) INFLIGHT.delete(key); }
}

async function getCandles(sym, tf, limit, closedOnly) {
  const data = await fetchOHLCV(sym, tf, limit);
  if (!data) return null;
  return closedOnly === false ? data : closed(data, TF_MS[tf] || M5);
}

// 2h mumlar 1h verisinden UTC hizalı toplanır; 1000 saat ≈ 41 gün yeterli.
async function getLong2h(sym, bars) {
  const need = Math.min(1000, Math.max(120, bars * 2 + 8));
  const raw = await fetchOHLCV(sym, '1h', need);
  if (!raw || !raw.length) return null;
  return closed(aggTF(raw, 2, H1), H2).slice(-bars);
}


/* ───────────────────────────── AI istemcisi ───────────────────────────── */
const mkProv = o => Object.assign({
  ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {},
  dayKey: '', dayCount: 0, lat: [], nextAt: 0
}, o);
const AI_PROV = [
  mkProv({
    id: 'gemini', name: 'Gemini', prefer: 1,
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    nativeBase: 'https://generativelanguage.googleapis.com/v1beta',
    key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
    models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    dayLimit: 400
  }),
  mkProv({
    id: 'deepseek', name: 'DeepSeek', prefer: 2, base: 'https://api.deepseek.com',
    key: process.env.DEEPSEEK_API_KEY || '', models: ['deepseek-chat'], dayLimit: 3000
  }),
  mkProv({
    id: 'groq', name: 'Groq', prefer: 3, base: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_API_KEY || '', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], dayLimit: 900
  }),
  mkProv({
    id: 'openai', name: 'OpenAI', prefer: 5, base: 'https://api.openai.com/v1',
    key: process.env.OPENAI_API_KEY || '', models: ['gpt-4o-mini', 'gpt-4.1-mini'], dayLimit: 1500
  })
];
const AI_CFG = { maxPerDay: 2000, maxPerHour: 80, timeoutMs: 20000, gapMs: 600 };
const AI_USAGE = {
  dayKey: dayKey(), dayCount: 0, hourKey: Math.floor(Date.now() / H1), hourCount: 0,
  lastAt: 0, lastError: null
};

function aiKeys() { return AI_PROV.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled === true && aiKeys().length > 0); }
function provDay(p) {
  const dk = dayKey();
  if (p.dayKey !== dk) { p.dayKey = dk; p.dayCount = 0; }
  return p;
}
function aiQuota() {
  const now = Date.now(), dk = dayKey(now), hk = Math.floor(now / H1);
  if (AI_USAGE.dayKey !== dk) { AI_USAGE.dayKey = dk; AI_USAGE.dayCount = 0; }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  const ok = AI_USAGE.dayCount < AI_CFG.maxPerDay && AI_USAGE.hourCount < AI_CFG.maxPerHour;
  return {
    ok, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount,
    leftDay: Math.max(0, AI_CFG.maxPerDay - AI_USAGE.dayCount),
    leftHour: Math.max(0, AI_CFG.maxPerHour - AI_USAGE.hourCount)
  };
}
function aiStatus() {
  return {
    enabled: settings.aiEnabled, ready: aiReady(), keys: aiKeys().length,
    autoVeto: settings.aiAutoVeto, minConfidence: settings.aiMinConfidence,
    quota: aiQuota(), lastError: AI_USAGE.lastError,
    providers: AI_PROV.map(p => {
      provDay(p);
      const lat = (p.lat || []).filter(Number.isFinite);
      return {
        id: p.id, name: p.name, hasKey: !!p.key, models: p.models.slice(),
        ok: p.ok || 0, fail: p.fail || 0, dayCount: p.dayCount || 0, dayLimit: p.dayLimit || 0,
        avgMs: lat.length ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : 0,
        cooldownSec: Math.max(0, Math.ceil(((p.cooldownUntil || 0) - Date.now()) / 1000)),
        lastError: p.lastError || null
      };
    })
  };
}
function orderedProviders(prefer) {
  const now = Date.now();
  return aiKeys().filter(p => provDay(p).dayCount < (p.dayLimit || 1e9)).sort((a, b) => {
    const ca = (a.cooldownUntil || 0) > now ? 1 : 0, cb = (b.cooldownUntil || 0) > now ? 1 : 0;
    if (ca !== cb) return ca - cb;
    if (prefer) { if (a.id === prefer) return -1; if (b.id === prefer) return 1; }
    return (a.prefer || 9) - (b.prefer || 9);
  });
}
function normTR(s) {
  return String(s == null ? '' : s)
    .replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's')
    .replace(/Ğ/g, 'G').replace(/ğ/g, 'g').replace(/Ü/g, 'U').replace(/ü/g, 'u')
    .replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
function extractJSON(text) {
  let raw = String(text || '').replace(/```(?:json)?/gi, '').replace(/<\/?think>/gi, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { return null; }
}
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 220);
}
function badReason(r) {
  const s = normTR(r);
  if (!s || s.length < 4) return true;
  return /^(YOK|NONE|BILINMIYOR|UNKNOWN|N A|NA|TEST|ORNEK|ACIKLAMA)$/.test(s);
}
function providerFail(p, e) {
  const status = Number(e && e.status) || 0;
  p.fail = (p.fail || 0) + 1;
  p.lastError = redact((e && e.message) || 'bilinmeyen hata');
  let ms = 60e3;
  if (status === 429) ms = 2 * M1;
  else if (status === 401 || status === 403) ms = 60 * M1;
  else if (status >= 500) ms = 2 * M1;
  else if (/model|not found|not supported/i.test(p.lastError)) ms = 10 * M1;
  p.cooldownUntil = Date.now() + ms;
  AI_USAGE.lastError = p.name + ': ' + p.lastError;
  AI_USAGE.lastAt = Date.now();
  logOnce('ai:' + p.id, 'AI HATA: ' + p.name + ' → ' + p.lastError.slice(0, 200) + ' | ' + Math.ceil(ms / 1000) + ' sn bekleme', 5 * M1);
}

async function callGeminiNative(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const t0 = Date.now();
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
  const contents = messages.filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const url = p.nativeBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(p.key);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  let res = null, txt = '', j = null;
  try {
    const body = { contents, generationConfig: { temperature: 0.1, maxOutputTokens: 700, responseMimeType: 'application/json' } };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    txt = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; }
    throw e;
  } finally { clearTimeout(timer); }
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 300) || ('HTTP ' + res.status);
    const er = new Error(redact(msg));
    er.status = /api key not valid|api_key_invalid|permission|unauthenticated/i.test(String(msg)) ? 401 : res.status;
    throw er;
  }
  if (j && j.error) { const er = new Error(redact(j.error.message || 'Gemini hatası')); er.status = Number(j.error.code) || 502; throw er; }
  const cand = j && j.candidates && j.candidates[0];
  const c = cand && cand.content && cand.content.parts ? cand.content.parts.map(x => (x && x.text) || '').join('\n') : '';
  if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.emptyResp = true; throw er; }
  p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
  return { text: String(c), model };
}

async function callProviderModel(p, messages, model, opts) {
  if (p.id === 'gemini' && p.nativeBase) return callGeminiNative(p, messages, model, opts);
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const t0 = Date.now();
  const extras = {};
  if (['groq', 'deepseek', 'openai'].includes(p.id)) extras.response_format = { type: 'json_object' };
  if (p.id === 'groq' && /gpt-oss/.test(model)) extras.reasoning_effort = 'low';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  let res = null, txt = '', j = null;
  try {
    res = await fetch(p.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify(Object.assign({ model, messages, temperature: 0.1, max_tokens: 700, stream: false }, extras))
    });
    txt = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; }
    throw e;
  } finally { clearTimeout(timer); }
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || txt.slice(0, 300) || ('HTTP ' + res.status);
    const er = new Error(redact(msg)); er.status = res.status; throw er;
  }
  if (!j) throw new Error('geçersiz JSON yanıtı');
  if (j.error && !j.choices) { const er = new Error(redact(j.error.message || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
  let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
  if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
  c = c == null ? '' : String(c).replace(/<\/?think>/gi, '').trim();
  if (!c) { const er = new Error('boş yanıt'); er.emptyResp = true; throw er; }
  p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
  return { text: c, model: (j.model || model) };
}

async function callAI(messages, opts) {
  opts = opts || {};
  const q = aiQuota();
  if (!q.ok) throw new Error('AI kotası doldu');
  const tmo = clamp(num(opts.timeoutMs, 8000), 2500, 30000);
  let lastErr = null;
  for (const p of orderedProviders(opts.prefer)) {
    if ((p.cooldownUntil || 0) > Date.now()) continue;
    for (const model of (p.models || [])) {
      if ((p.modelCooldowns[model] || 0) > Date.now()) continue;
      const at = Math.max(Date.now(), p.nextAt || 0);
      p.nextAt = at + (opts.fast ? 300 : AI_CFG.gapMs);
      if (at > Date.now()) await sleep(Math.min(at - Date.now(), 4000));
      try {
        const t0 = Date.now();
        const r = await callProviderModel(p, messages, model, { timeoutMs: tmo });
        if (opts.validate && !opts.validate(r.text)) throw new Error('geçersiz yanıt biçimi');
        p.ok = (p.ok || 0) + 1;
        p.lastError = null;
        provDay(p).dayCount++;
        AI_USAGE.dayCount++; AI_USAGE.hourCount++; AI_USAGE.lastAt = Date.now(); AI_USAGE.lastError = null;
        dirty = true; saveStateSoon();
        return { text: String(r.text || ''), provider: p.id, providerName: p.name, model: r.model || model, latencyMs: Date.now() - t0 };
      } catch (e) {
        lastErr = e;
        if (e && e.status === 402) throw e;
        providerFail(p, e);
      }
    }
  }
  throw lastErr || new Error('AI sağlayıcısı yok (anahtar yok veya hepsi beklemede)');
}

function aiHistoryAdd(rec) {
  aiHist.push(Object.assign({ at: Date.now() }, rec));
  capArr(aiHist, 120);
  dirty = true;
  saveStateSoon();
}


/* ───────────────────────────── durum kaydı ───────────────────────────── */
function saveState() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const payload = {
      version: VERSION,
      at: Date.now(),
      settings,
      signals: signals.slice(-400),
      paper: { open: paper.open, closed: paper.closed.slice(-250), equity: paper.equity, start: paper.start, dayStart: paper.dayStart, dayKey: paper.dayKey, peak: paper.peak },
      live: { open: LIVE.open, closed: LIVE.closed.slice(-150), dayStart: LIVE.dayStart, dayKey: LIVE.dayKey },
      ltManual: ltManual.slice(-50),
      aiHist: aiHist.slice(-80)
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log('Durum yazılamadı: ' + redact(e.message)); }
}
function saveStateSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 1200);
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (settings.tradeMode === 'live' && (!HAS_KEYS || !API_TOKEN)) {
      settings.tradeMode = 'paper';
      log('Canlı mod için anahtar + ALPHASON_API_TOKEN gerekli → paper moda dönüldü');
    }
    if (j && Array.isArray(j.signals)) {
      signals = j.signals.filter(s => s && ['AUTO', 'TREND', 'LT'].includes(s.module)).slice(-400);
      for (const s of signals) {
        if (!Number.isFinite(Number(s.curSl)) || !(s.curSl > 0)) s.curSl = s.sl;
        if (!s.info) s.info = {};
        if (!s.lastBarT) s.lastBarT = Math.floor(num(s.startedAt, s.createdAt) / M1) * M1;
      }
    }
    if (j && j.paper) {
      const p = j.paper;
      paper.open = Array.isArray(p.open) ? p.open.filter(x => x && x.remainingQty > 0) : [];
      paper.closed = Array.isArray(p.closed) ? p.closed.slice(-250) : [];
      paper.equity = num(p.equity, DEF_SET.paperEquity);
      paper.start = num(p.start, DEF_SET.paperEquity);
      paper.peak = Math.max(num(p.peak, paper.equity), paper.equity);
      paper.dayKey = p.dayKey || dayKey();
      paper.dayStart = num(p.dayStart, paper.equity);
      if (paper.dayKey !== dayKey()) { paper.dayKey = dayKey(); paper.dayStart = paper.equity; }
    }
    if (j && j.live) {
      const l = j.live;
      LIVE.open = Array.isArray(l.open) ? l.open.filter(x => x && x.remainingQty > 0) : [];
      LIVE.closed = Array.isArray(l.closed) ? l.closed.slice(-150) : [];
      LIVE.dayKey = l.dayKey || dayKey();
      LIVE.dayStart = num(l.dayStart, 0);
      if (LIVE.dayKey !== dayKey()) { LIVE.dayKey = dayKey(); LIVE.dayStart = 0; }
    }
    if (j && Array.isArray(j.ltManual)) {
      ltManual = j.ltManual.filter(t => t && t.id && t.symbol && t.upper && t.lower).slice(-50);
    }
    if (j && Array.isArray(j.aiHist)) aiHist = j.aiHist.slice(-80);
  } catch (e) { log('Durum okunamadı: ' + redact(e.message)); }
}

/* ───────────────────────────── sinyal çekirdeği ───────────────────────────── */
const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade', tf: '1m', tradeable: true, cooldown: 8 * M1 },
  TREND: { key: 'TREND', label: 'Trend Scalp', tf: '5m', tradeable: false, cooldown: 45 * M1 },
  LT: { key: 'LT', label: 'LT Üçgen', tf: '2h', tradeable: false, cooldown: 4 * H1 }
};
const RES = {
  TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', TIME: 'SÜRE DOLDU',
  MOMENTUM: 'İVME BİTTİ', FADE: 'KÂR GERİ VERİLDİ', STALL: 'HAREKETSİZ',
  AI_EXIT: 'AI ÇIKIŞ', MANUEL: 'MANUEL', EXCHANGE: 'BORSADA KAPANDI', REVERSAL: 'TERS DÖNÜŞ'
};
function isOpenSignal(s) { return !!s && s.status === 'AKTIF'; }

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return 0;
  const gross = Math.abs(tp - entry) / risk;
  const cost = (EX.COST / 100) * ((entry + tp) / 2) / risk;
  return +(gross - cost).toFixed(3);
}
function breakEven(pos) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  return rp(pos.entry + d * pos.entry * (pos.isLive ? EX.H : EX.COST) / 100);
}
function sizeQty(equity, entry, sl) {
  const riskPerUnit = Math.abs(entry - sl);
  if (!(riskPerUnit > 0) || !(equity > 0)) return { qty: 0, riskAmt: 0, notional: 0 };
  const riskAmt = equity * settings.riskPct / 100;
  let qty = riskAmt / riskPerUnit;
  const maxNotional = Math.min(equity * settings.leverage * 0.95, settings.margin * settings.leverage);
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  return { qty: +qty.toFixed(10), riskAmt: +(qty * riskPerUnit).toFixed(4), notional: +(qty * entry).toFixed(4) };
}

function trimSignals() {
  if (signals.length <= 400) return;
  const open = signals.filter(isOpenSignal);
  const closed = signals.filter(s => !isOpenSignal(s)).slice(-300);
  signals = open.concat(closed);
}

function addSignal(raw) {
  if (!raw || !MODS[raw.module]) return null;
  if (!['LONG', 'SHORT'].includes(raw.dir)) return null;
  const d = raw.dir === 'LONG' ? 1 : -1;
  const entry = num(raw.entry), sl = num(raw.sl), tp1 = num(raw.tp1), tp2 = num(raw.tp2);
  if (!(entry > 0) || !(sl > 0) || !(tp1 > 0)) return null;
  if ((tp1 - entry) * d <= 0 || (sl - entry) * d >= 0) return null;
  const riskPct = Math.abs(entry - sl) / entry * 100;
  if (riskPct < EX.MIN_RISK || riskPct > EX.MAX_RISK) return null;
  if (signals.some(s => isOpenSignal(s) && s.symbol === raw.symbol)) return null;
  const now = Date.now();
  const M = MODS[raw.module];
  const same = signals.filter(s => s.symbol === raw.symbol && s.module === raw.module);
  const last = same.sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt))[0];
  if (last && now - (last.closedAt || last.createdAt) < M.cooldown) return null;

  const sig = {
    id: 'S' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    module: raw.module, symbol: raw.symbol, base: raw.base || baseOf(raw.symbol),
    dir: raw.dir, entry: rp(entry), sl: rp(sl), curSl: rp(sl), tp1: rp(tp1), tp2: tp2 > 0 ? rp(tp2) : null,
    conf: clamp(Math.round(num(raw.conf, 60)), 20, 99),
    info: Object.assign({}, raw.info || {}),
    status: 'AKTIF', result: null, exit: null, netR: null, pnlUsdt: null,
    maxR: 0, minR: 0, tp1Hit: false, tradeable: raw.module === 'AUTO',
    isLive: false, posId: null, ai: null, aiNote: null,
    createdAt: now, startedAt: now, lastBarT: Math.floor(now / M1) * M1, closedAt: null
  };
  signals.push(sig);
  trimSignals();
  dirty = true; saveStateSoon();
  log('SİNYAL ' + M.label + ' | ' + sig.base + ' ' + sig.dir + ' | ' + rp(entry) +
    ' | SL ' + rp(sl) + ' | TP1 ' + rp(tp1) + ' | güven ' + sig.conf +
    (raw.info && raw.info.reason ? ' | ' + String(raw.info.reason).slice(0, 90) : ''));
  return sig;
}

function finalizeSignal(sig, reason, exit, netR, pnl) {
  if (!sig) return;
  sig.status = 'KAPALI';
  sig.result = reason;
  sig.exit = exit > 0 ? rp(exit) : null;
  sig.closedAt = Date.now();
  sig.netR = Number.isFinite(Number(netR)) ? +Number(netR).toFixed(3) : null;
  sig.pnlUsdt = Number.isFinite(Number(pnl)) ? +Number(pnl).toFixed(4) : null;
  sig.posId = null;
  sig.ai = sig.ai || null;
  dirty = true; saveStateSoon();
  log('KAPANDI ' + MODS[sig.module].label + ' | ' + sig.base + ' ' + sig.dir + ' → ' +
    (RES[reason] || reason) + (sig.netR != null ? ' | net ' + sig.netR + 'R' : '') +
    (sig.pnlUsdt != null ? ' | ' + sig.pnlUsdt + ' USDT' : ''));
}

// Pozisyonu olmayan (TREND / LT / kapasite nedeniyle açılamayan AUTO) sinyaller.
function closeVirtualSignal(sig, exit, reason) {
  if (!sig || sig.status !== 'AKTIF') return;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0) || !(exit > 0)) return;
  const costR = (EX.COST / 100) * ((sig.entry + exit) / 2) / risk;
  const fullR = (exit - sig.entry) * d / risk - costR;
  let netR = fullR;
  if (sig.tp1Hit && sig.tp1) {
    const r1 = rrNet(sig.entry, sig.sl, sig.tp1);
    netR = 0.5 * r1 + 0.5 * fullR;
  }
  sig.maxR = Math.max(num(sig.maxR, 0), (exit - sig.entry) * d / risk);
  finalizeSignal(sig, reason, exit, netR, null);
}

function logRej(module, sym, reason, price) {
  const now = Date.now();
  const base = baseOf(sym);
  const last = REJ.find(r => r.symbol === sym && r.reason === reason && now - r.t < 10 * M1);
  if (last) { last.n = (last.n || 1) + 1; last.t = now; }
  else { REJ.push({ t: now, module, symbol: sym, base, reason, price: rp(price || priceOf(sym)), n: 1 }); capArr(REJ, 200); }
}

/* ───────────────────────────── görünümler ───────────────────────────── */
function paperMarkEquity() {
  let eq = paper.equity;
  for (const p of paper.open) {
    const px = priceOf(p.symbol, 30000) || p.livePrice || p.entry;
    eq += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty;
  }
  return eq;
}
function dailyLossHit() {
  if (settings.tradeMode === 'live' && HAS_KEYS) {
    const eq = num(LIVE.balance && LIVE.balance.total, 0);
    const start = num(LIVE.dayStart, 0);
    if (eq > 0 && start > 0) return eq - start <= -Math.abs(start * settings.dailyLossPct / 100);
  }
  const eq = paperMarkEquity();
  return eq - paper.dayStart <= -Math.abs(paper.dayStart * settings.dailyLossPct / 100);
}
function openCount() { return paper.open.length + LIVE.open.length; }
function canOpenAuto() {
  return settings.autoTrade === true && openCount() < settings.maxOpen && !dailyLossHit();
}
function positionPnl(pos, px) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  return +(((pos.grossRealized || 0) - (pos.costPaid || 0)) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
}
function viewPosition(p) {
  const px = priceOf(p.symbol, 30000) || p.livePrice || p.markPrice || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const pnl = positionPnl(p, px);
  const risk = Math.max(1e-9, p.riskAmt);
  return {
    id: p.id, sigId: p.sigId, module: p.module, symbol: p.symbol, base: p.base, dir: p.dir,
    entry: p.entry, sl: p.sl, curSl: p.curSl, tp1: p.tp1, tp2: p.tp2,
    qty: p.qty, remainingQty: p.remainingQty, notional: p.notional, margin: p.margin,
    leverage: p.leverage, riskAmt: p.riskAmt, openedAt: p.openedAt, tp1Hit: p.tp1Hit,
    isLive: !!p.isLive, ai: p.ai || null, atrPct: p.atrPct,
    livePrice: rp(px), livePnl: pnl, liveR: +(pnl / risk).toFixed(2),
    livePnlPct: +(pnl / Math.max(0.0001, p.margin) * 100).toFixed(2),
    maxR: +(p.maxR || 0).toFixed(2), ageMs: Date.now() - p.openedAt
  };
}
function viewSignal(s) {
  const d = s.dir === 'LONG' ? 1 : -1;
  const risk = Math.max(1e-9, Math.abs(s.entry - s.sl));
  const px = s.status === 'KAPALI' ? (s.exit || s.entry) : (priceOf(s.symbol, 30000) || s.entry);
  const grossR = s.status === 'KAPALI' ? num(s.netR, 0) : (px - s.entry) * d / risk;
  return {
    id: s.id, module: s.module, symbol: s.symbol, base: s.base, dir: s.dir,
    entry: s.entry, sl: s.sl, curSl: s.curSl, tp1: s.tp1, tp2: s.tp2, conf: s.conf,
    status: s.status, result: s.result, exit: s.exit, netR: s.netR, pnlUsdt: s.pnlUsdt,
    maxR: +(s.maxR || 0).toFixed(2), createdAt: s.createdAt, closedAt: s.closedAt,
    tp1Hit: s.tp1Hit, isLive: !!s.isLive, posId: s.posId, tradeable: s.tradeable,
    info: s.info || {}, ai: s.ai || null, aiNote: s.aiNote || null,
    price: rp(px), grossR: +grossR.toFixed(2), open: s.status === 'AKTIF',
    ageMs: Date.now() - s.createdAt, durationMs: s.closedAt ? s.closedAt - s.createdAt : Date.now() - s.createdAt
  };
}
function paperSummary() {
  const cl = paper.closed;
  const wins = cl.filter(x => num(x.pnl) > 0).length;
  const losses = cl.filter(x => num(x.pnl) <= 0).length;
  const sumPnl = +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of paper.open) {
    const px = priceOf(p.symbol, 30000) || p.livePrice || p.entry;
    unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty;
  }
  return {
    equity: +paper.equity.toFixed(2), markEquity: +paperMarkEquity().toFixed(2),
    start: paper.start, dayStart: +paper.dayStart.toFixed(2),
    dayPnl: +(paperMarkEquity() - paper.dayStart).toFixed(2),
    open: paper.open.length, closed: cl.length, wins, losses,
    winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0,
    sumPnl, unrealized: +unrealized.toFixed(2)
  };
}
function liveSummary() {
  const b = LIVE.balance;
  const cl = LIVE.closed;
  const wins = cl.filter(x => num(x.pnl) > 0).length;
  const losses = cl.filter(x => num(x.pnl) <= 0).length;
  const sumPnl = +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  return {
    equity: b ? +num(b.total).toFixed(2) : 0, free: b ? +num(b.free).toFixed(2) : 0,
    used: b ? +num(b.used).toFixed(2) : 0, open: LIVE.open.length, closed: cl.length,
    wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, sumPnl,
    dayStart: num(LIVE.dayStart, 0), dayPnl: b ? +(num(b.total) - num(LIVE.dayStart, 0)).toFixed(2) : 0,
    error: LIVE.lastError || null, lastSync: LIVE.lastSync || 0
  };
}
function statsView() {
  const closed = signals.filter(s => s.status === 'KAPALI' && s.netR != null);
  const wins = closed.filter(s => num(s.netR) > 0).length;
  const losses = closed.filter(s => num(s.netR) <= 0).length;
  const netR = +closed.reduce((s, x) => s + num(x.netR), 0).toFixed(2);
  const byModule = {};
  for (const k of ['AUTO', 'TREND', 'LT']) byModule[k] = { total: 0, wins: 0, losses: 0, netR: 0 };
  for (const s of closed) {
    const b = byModule[s.module] || (byModule[s.module] = { total: 0, wins: 0, losses: 0, netR: 0 });
    b.total++;
    if (num(s.netR) > 0) b.wins++; else b.losses++;
    b.netR = +(b.netR + num(s.netR)).toFixed(2);
  }
  const ds = utcDayStart(Date.now());
  const today = closed.filter(s => num(s.closedAt, 0) >= ds);
  const tWins = today.filter(s => num(s.netR) > 0).length;
  return {
    total: closed.length, wins, losses,
    winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : 0,
    netR, avgR: closed.length ? +(netR / closed.length).toFixed(2) : 0,
    today: {
      total: today.length, wins: tWins, losses: today.length - tWins,
      netR: +today.reduce((s, x) => s + num(x.netR), 0).toFixed(2)
    },
    byModule
  };
}


/* ───────────────────────────── pozisyon motoru ───────────────────────────── */
async function paperOpen(sig, entry) {
  const { qty, riskAmt, notional } = sizeQty(paper.equity, entry, sig.sl);
  if (!(qty > 0) || !(notional > 0)) return { error: 'miktar 0' };
  const lev = settings.leverage;
  const pos = {
    id: 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty, initialQty: qty, remainingQty: qty, notional, margin: +(notional / lev).toFixed(4),
    leverage: lev, riskAmt, openedAt: Date.now(), tp1Hit: false,
    grossRealized: 0, costPaid: 0, realized: 0, maxR: 0, minR: 0,
    peakPx: entry, wickFrom: Math.ceil(Date.now() / M1) * M1,
    isLive: false, atrPct: num(sig.info && sig.info.atrPct, 0.4),
    aiChecked: false, ai: null, closing: false
  };
  paper.open.push(pos);
  sig.posId = pos.id; sig.tradeable = true; sig.isLive = false;
  dirty = true; saveStateSoon();
  log('PAPER AÇILDI ' + sig.base + ' ' + sig.dir + ' | giriş ' + entry + ' | SL ' + sig.sl +
    ' | TP1 ' + sig.tp1 + ' | risk %' + settings.riskPct + ' | kaldıraç ' + lev + 'x');
  setTimeout(() => { aiCheckPosition(pos).catch(() => {}); }, 2500);
  return { pos };
}

async function openPosition(sig) {
  if (!sig || sig.status !== 'AKTIF' || sig.module !== 'AUTO') return { error: 'bu sinyal emir açamaz' };
  if (sig.posId) return { error: 'zaten açık' };
  if (!canOpenAuto()) return { error: 'kapasite / günlük zarar kilidi' };
  if (paper.open.some(p => p.sigId === sig.id) || LIVE.open.some(p => p.sigId === sig.id)) return { error: 'zaten açık' };
  const quote = await freshPrice(sig.symbol, 4000);
  const px = quote.price;
  if (!(px > 0)) return { error: quote.error || 'fiyat yok' };
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > 0.30) { sig.info.skipNote = 'fiyat kaçtı %' + drift.toFixed(2); return { error: 'fiyat kaçtı' }; }
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = rp(px);
  if ((sig.sl - entry) * d >= 0 || (sig.tp1 - entry) * d <= 0) return { error: 'plan bozuldu' };
  if (settings.tradeMode === 'live') return liveOpen(sig, entry);
  return paperOpen(sig, entry);
}

async function closePosition(pos, price, reason, fraction) {
  if (!pos || pos.closing) return { error: 'kapanıyor' };
  const list = pos.isLive ? LIVE.open : paper.open;
  if (!list.includes(pos)) return { error: 'pozisyon kapalı' };
  const d = pos.dir === 'LONG' ? 1 : -1;
  const frac = fraction > 0 ? Math.min(1, fraction) : 1;
  const qty = Math.min(pos.remainingQty, pos.remainingQty * frac);
  if (!(qty > 0)) return { error: 'miktar 0' };
  let fill = price;
  if (pos.isLive) {
    pos.closing = true;
    try {
      let amount;
      try { amount = ex.amountToPrecision(pos.symbol, qty); } catch (e) { amount = qty; }
      if (!(Number(amount) > 0)) throw new Error('miktar 0');
      const order = await ex.createOrder(pos.symbol, 'market', d === 1 ? 'sell' : 'buy', amount, undefined, { reduceOnly: true });
      fill = num(order && (order.average || order.price), price);
      if (!(fill > 0)) fill = priceOf(pos.symbol) || pos.entry;
      pos.exchangeQty = Math.max(0, num(pos.exchangeQty, pos.remainingQty) - Number(amount));
    } catch (e) {
      pos.closing = false;
      LIVE.lastError = redact(e.message);
      log('CANLI KAPATMA HATASI ' + pos.base + ': ' + LIVE.lastError);
      return { error: LIVE.lastError };
    }
  }
  const gross = (fill - pos.entry) * d * qty;
  const cost = qty * (pos.entry + fill) / 2 * (pos.isLive ? EX.H : EX.COST) / 100;
  pos.grossRealized += gross;
  pos.costPaid += cost;
  pos.realized = +(pos.grossRealized - pos.costPaid).toFixed(4);
  pos.remainingQty = +Math.max(0, pos.remainingQty - qty).toFixed(10);
  const dust = Math.max(1e-9, pos.initialQty * 0.01);
  if (pos.remainingQty > dust) {
    pos.closing = false;
    if (pos.isLive) liveMoveStop(pos).catch(() => {});
    dirty = true; saveStateSoon();
    log((pos.isLive ? 'CANLI' : 'PAPER') + ' KISMİ KAPATMA ' + pos.base + ' | ' + rp(fill) + ' | kalan ' + pos.remainingQty);
    return { partial: true, exit: rp(fill), remaining: pos.remainingQty };
  }

  const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
  const sig = signals.find(s => s.id === pos.sigId);
  if (sig) { sig.maxR = Math.max(num(sig.maxR, 0), num(pos.maxR, 0)); finalizeSignal(sig, reason, fill, netR, net); }
  const rec = Object.assign({}, pos, {
    exit: rp(fill), result: reason, pnl: net, netR,
    closedAt: Date.now(), durationMs: Date.now() - pos.openedAt
  });
  delete rec.remainingQty; delete rec.closing;
  if (pos.isLive) {
    LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
    LIVE.closed.push(rec); capArr(LIVE.closed, 150);
    if (pos.stopOrderId) ex.cancelOrder(pos.stopOrderId, pos.symbol).catch(() => {});
    if (pos.tpOrderId) ex.cancelOrder(pos.tpOrderId, pos.symbol).catch(() => {});
    LIVE.lastSync = Date.now();
    fetchLiveBalance(true).catch(() => {});
    log('CANLI KAPANDI ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R (' + net + ' USDT)');
  } else {
    paper.equity = +(paper.equity + net).toFixed(4);
    paper.peak = Math.max(num(paper.peak, paper.equity), paper.equity);
    paper.open = paper.open.filter(p => p.id !== pos.id);
    paper.closed.push(rec); capArr(paper.closed, 250);
    log('PAPER KAPANDI ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R (' + net + ' USDT) | bakiye ' + paper.equity);
  }
  dirty = true; saveStateSoon();
  return { exit: rp(fill), netR, pnl: net };
}

let monBusy = false;
async function monitorPositions() {
  if (monBusy) return;
  monBusy = true;
  try {
    for (const pos of paper.open.concat(LIVE.open)) {
      if (pos.closing) continue;
      const list = pos.isLive ? LIVE.open : paper.open;
      if (!list.includes(pos)) continue;
      let px = priceOf(pos.symbol, 8000);
      if (!(px > 0)) { const q = await freshPrice(pos.symbol, 4000); px = q.price; }
      if (!(px > 0)) continue;
      const d = pos.dir === 'LONG' ? 1 : -1;
      const risk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
      let hi = px, lo = px;
      try {
        const cs = await getCandles(pos.symbol, '1m', 6, false);
        if (cs) for (const c of cs) if (c.t >= (pos.wickFrom || 0)) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); }
      } catch (e) { /* ticker yeterli */ }
      pos.livePrice = rp(px);
      pos.ageMs = Date.now() - pos.openedAt;
      const fav = d === 1 ? hi : lo;
      pos.maxR = Math.max(num(pos.maxR, 0), (fav - pos.entry) * d / risk);
      pos.peakPx = d === 1 ? Math.max(num(pos.peakPx, pos.entry), fav) : Math.min(num(pos.peakPx, pos.entry), fav);

      // 1) stop her zaman önce
      if (d === 1 ? lo <= pos.curSl : hi >= pos.curSl) {
        await closePosition(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL');
        continue;
      }
      // 2) TP2
      if (pos.tp2 && (d === 1 ? hi >= pos.tp2 : lo <= pos.tp2)) {
        await closePosition(pos, pos.tp2, 'TP2');
        continue;
      }
      // 3) TP1 — kısmi kâr + stop girişe
      if (!pos.tp1Hit && (d === 1 ? hi >= pos.tp1 : lo <= pos.tp1)) {
        const r = await closePosition(pos, pos.tp1, 'TP1', settings.impulseTp1Fraction);
        if (!r.error && (pos.isLive ? LIVE.open : paper.open).includes(pos)) {
          pos.tp1Hit = true;
          pos.curSl = rp(moreProtective(pos.curSl, breakEven(pos), d));
          pos.wickFrom = Math.ceil(Date.now() / M1) * M1;
          const sig = signals.find(s => s.id === pos.sigId);
          if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
          dirty = true; saveStateSoon();
        }
        continue;
      }
      // 4) kâr kilidi / iz süren stop
      if (pos.maxR >= 0.9) {
        const lock = pos.entry + d * Math.max(0.35, pos.maxR - 0.45) * risk;
        const ns = rp(moreProtective(pos.curSl, lock, d));
        if (ns !== pos.curSl) {
          pos.curSl = ns;
          const sig = signals.find(s => s.id === pos.sigId);
          if (sig) sig.curSl = ns;
          if (pos.isLive) liveMoveStop(pos).catch(() => {});
          dirty = true; saveStateSoon();
        }
      }
      // 5) OtoTrade: ivme bitti mi?
      const age = (Date.now() - pos.openedAt) / 1000;
      const rNow = (px - pos.entry) * d / risk;
      const r20 = retPct(pos.symbol, 20);
      const atrPct = num(pos.atrPct, 0.4);
      if (age >= 4 && r20 != null && (-r20 * d) >= Math.max(0.10, atrPct * 0.55) && rNow < 0.8) {
        await closePosition(pos, px, 'MOMENTUM');
        continue;
      }
      if (pos.maxR >= 0.45 && (pos.maxR - rNow) >= Math.max(0.18, 0.35 * pos.maxR)) {
        await closePosition(pos, px, 'FADE');
        continue;
      }
      if (age >= settings.impulseNoMoveSec && pos.maxR < 0.30 && r20 != null && Math.abs(r20) < Math.max(0.05, atrPct * 0.22)) {
        await closePosition(pos, px, 'STALL');
        continue;
      }
      if (age >= settings.impulseMaxHoldSec) {
        await closePosition(pos, px, 'TIME');
        continue;
      }
    }
  } finally { monBusy = false; }
}

async function aiCheckPosition(pos) {
  if (!pos || !pos.isLive && !paper.open.includes(pos)) return;
  if (pos.isLive && !LIVE.open.includes(pos)) return;
  if (pos.aiChecked) return;
  if (!aiReady() || !settings.aiAutoVeto) return;
  pos.aiChecked = true;
  try {
    const cs = await getCandles(pos.symbol, '1m', 20, false);
    const px = priceOf(pos.symbol, 15000) || pos.entry;
    const d = pos.dir === 'LONG' ? 1 : -1;
    const rNow = (px - pos.entry) * d / Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    const prompt = 'OTOTRADE İVME KONTROLÜ — giriş yapıldı, şimdi "gerçek ivme mi, fake/tükeniş mi" kontrol ediliyor.\n' +
      pos.base + ' ' + pos.dir + ' (' + (pos.isLive ? 'CANLI' : 'PAPER') + ')\n' +
      'Giriş ' + pos.entry + ' | Şu an ' + rp(px) + ' | K/Z ' + rNow.toFixed(2) + 'R | SL ' + pos.curSl + '\n' +
      'Son 1m mumlar (en yeni sonda):\n' + fmtCandles(cs, 12) + '\n\n' +
      'Soru: Bu hareket yeni başlayan bir pump/dump ivmesi mi, yoksa tükeniş/fake mi?\n' +
      'Yalnızca JSON: {"verdict":"GERCEK|SAHTE|BELIRSIZ","confidence":0-100,"reason":"en fazla 15 kelime"}';
    const ai = await callAI([
      { role: 'system', content: 'Sen kısa vadeli kripto ivme kontrolcüsüsün. Verilen 1m mumlara bakarak hareketin yeni mi yoksa tükeniş mi olduğunu değerlendir. Sayı uydurma, yalnızca JSON döndür.' },
      { role: 'user', content: prompt }
    ], {
      prefer: 'gemini', timeoutMs: 6000, fast: true,
      validate: t => { const j = extractJSON(t); return !!(j && j.verdict); }
    });
    const j = extractJSON(ai.text) || {};
    const verdict = normTR(j.verdict || j.karar);
    const confidence = clamp(Math.round(num(j.confidence, 0)), 0, 100);
    const reason = cleanText(j.reason || j.neden, 180);
    const rec = { verdict, confidence, reason, provider: ai.providerName, model: ai.model, at: Date.now(), latencyMs: ai.latencyMs };
    pos.ai = rec;
    const sig = signals.find(s => s.id === pos.sigId);
    if (sig) sig.ai = rec;
    aiHistoryAdd({ kind: 'OtoTrade giriş kontrolü', module: 'AUTO', base: pos.base, dir: pos.dir, decision: verdict, confidence, reason, provider: ai.providerName });
    log('AI KONTROL ' + pos.base + ' ' + pos.dir + ' → ' + verdict + ' (' + confidence + ') ' + reason);
    if (verdict === 'SAHTE' && confidence >= settings.aiMinConfidence) {
      if (rNow < 0.35) {
        const q = await freshPrice(pos.symbol, 4000);
        if (q.price > 0) await closePosition(pos, q.price, 'AI_EXIT');
      } else {
        const d2 = pos.dir === 'LONG' ? 1 : -1;
        pos.curSl = rp(moreProtective(pos.curSl, breakEven(pos), d2));
        if (pos.isLive) liveMoveStop(pos).catch(() => {});
        dirty = true; saveStateSoon();
      }
    }
  } catch (e) {
    AI_USAGE.lastError = redact(e.message);
    logOnce('ai-entry', 'AI giriş kontrolü yapılamadı: ' + redact(e.message), 5 * M1);
  }
}

/* ───────────────────────────── canlı işlem ───────────────────────────── */
function liveConfigError() {
  if (!HAS_KEYS) return 'Canlı işlem için BITGET_API_KEY / BITGET_SECRET / BITGET_PASSPHRASE gerekli.';
  if (!API_TOKEN) return 'Canlı işlem için ALPHASON_API_TOKEN zorunludur.';
  return null;
}
function friendlyBitgetError(msg) {
  const s = String(msg || '');
  if (/40018|Invalid IP/i.test(s)) {
    const m = s.match(/Current request IP\s*:?\s*([0-9a-fA-F:.]+)/i);
    if (m) LIVE.ipHint = m[1];
    return 'Bitget API anahtarı IP kısıtlı. Sunucu IP: ' + (m ? m[1] : '?') + ' — Bitget API Yönetimi → IP beyaz listesine ekle.';
  }
  if (/40012|40006|40009|Invalid ApiKey|apikey|signature/i.test(s)) return 'Bitget API key/secret/passphrase hatalı: ' + s.slice(0, 160);
  if (/40014|permission/i.test(s)) return 'API anahtarında futures okuma + işlem yetkisi gerekli (çekim yetkisi verme): ' + s.slice(0, 160);
  return s;
}
async function fetchLiveBalance(force) {
  if (!HAS_KEYS) return { total: 0, free: 0, used: 0, at: Date.now(), error: 'Bitget anahtarı yok' };
  if (!force && LIVE.balance && Date.now() - LIVE.balance.at < 10e3) return LIVE.balance;
  try {
    const raw = await ex.fetchBalance({ type: 'swap' });
    const u = (raw && (raw.USDT || raw.usdt)) || {};
    let total = num(u.total, num(raw && raw.total && raw.total.USDT, 0));
    let free = num(u.free, num(raw && raw.free && raw.free.USDT, 0));
    let used = num(u.used, num(raw && raw.used && raw.used.USDT, 0));
    if (!(total > 0) && raw && raw.info) {
      const info = raw.info;
      const arr = Array.isArray(info) ? info : (Array.isArray(info.data) ? info.data : []);
      const row = arr.find(x => String(x.marginCoin || x.coin || '').toUpperCase() === 'USDT');
      if (row) {
        total = num(row.equity || row.accountEquity || row.available || row.crossedMaxAvailable, total);
        free = num(row.available || row.crossedMaxAvailable || row.maxTransferOut, free);
        used = Math.max(0, total - free);
      }
    }
    LIVE.balance = { total, free, used: used || Math.max(0, total - free), at: Date.now() };
    if (LIVE.dayKey !== dayKey() || !(LIVE.dayStart > 0)) { LIVE.dayKey = dayKey(); LIVE.dayStart = total; }
    LIVE.lastError = null;
    return LIVE.balance;
  } catch (e) {
    LIVE.lastError = friendlyBitgetError(redact(e.message));
    logOnce('livebal', 'CANLI BAKİYE HATASI: ' + LIVE.lastError, 10 * M1);
    return LIVE.balance || { total: 0, free: 0, used: 0, at: Date.now(), error: LIVE.lastError };
  }
}
async function fetchLivePositions() {
  if (!HAS_KEYS) return null;
  try {
    const symbols = Array.from(new Set(LIVE.open.map(p => p.symbol)));
    const list = symbols.length ? await ex.fetchPositions(symbols, { type: 'swap' }) : await ex.fetchPositions(undefined, { type: 'swap' });
    LIVE.positions = Array.isArray(list) ? list : [];
    return LIVE.positions;
  } catch (e) {
    LIVE.lastError = friendlyBitgetError(redact(e.message));
    logOnce('livepos', 'CANLI POZİSYON HATASI: ' + LIVE.lastError, 10 * M1);
    return null;
  }
}
function findExchangePosition(sym, dir) {
  return (LIVE.positions || []).find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0 &&
    String(p.side || '').toLowerCase() === (dir === 'LONG' ? 'long' : 'short')) || null;
}
async function fastLivePrice(sym, fallback) {
  try { const t = await ex.fetchTicker(sym); const p = num(t && (t.last || t.close)); if (p > 0) return p; } catch (e) { /* cache */ }
  return priceOf(sym) || fallback || 0;
}
function priceForExchange(sym, value) {
  try { return Number(ex.priceToPrecision(sym, value)); } catch (e) { return value; }
}
async function placeLiveProtection(sig, pos, d, amount) {
  const closeSide = d === 1 ? 'sell' : 'buy';
  let stopOk = false;
  try {
    const so = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, {
      stopLossPrice: priceForExchange(sig.symbol, sig.sl), reduceOnly: true
    });
    pos.stopOrderId = so && so.id;
    pos.protectedQty = Number(amount);
    stopOk = !!(so && so.id);
  } catch (e) { log('CANLI STOP KURULAMADI ' + sig.base + ': ' + redact(e.message)); }
  if (!stopOk) {
    try { await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { reduceOnly: true }); }
    catch (e2) { log('!!! ACİL: ' + sig.base + ' stopsuz kalmış olabilir, borsadan elle kapat → ' + redact(e2.message)); }
    return false;
  }
  if (sig.tp2) {
    try {
      const to = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, {
        takeProfitPrice: priceForExchange(sig.symbol, sig.tp2), reduceOnly: true
      });
      pos.tpOrderId = to && to.id;
    } catch (e) { log('CANLI TP2 KURULAMADI ' + sig.base + ': ' + redact(e.message)); }
  }
  return true;
}
async function liveOpen(sig, entry) {
  const configError = liveConfigError();
  if (configError) return { error: configError };
  if (LIVE.open.some(p => p.sigId === sig.id)) return { error: 'zaten açık' };
  const bal = await fetchLiveBalance(true);
  if (LIVE.lastError) return { error: LIVE.lastError };
  if (!(bal.total > 0)) return { error: 'Bitget USDT-M bakiyesi 0 veya okunamadı' };
  const d = sig.dir === 'LONG' ? 1 : -1;
  const { qty, riskAmt, notional } = sizeQty(bal.total, entry, sig.sl);
  if (!(qty > 0)) return { error: 'miktar 0' };
  let amount;
  try { amount = ex.amountToPrecision(sig.symbol, qty); } catch (e) { amount = qty; }
  if (!(Number(amount) > 0)) return { error: 'miktar 0' };
  if (Number(amount) * entry < 5) return { error: 'emir çok küçük (min 5 USDT)' };
  try { await ex.setMarginMode('isolated', sig.symbol, { leverage: settings.leverage }); }
  catch (e) { log('İZOLE MARJİN NOTU: ' + sig.base + ' → ' + friendlyBitgetError(redact(e.message)).slice(0, 160)); }
  try { await ex.setLeverage(settings.leverage, sig.symbol); }
  catch (e) { return { error: friendlyBitgetError(redact(e.message)) }; }
  let order;
  try { order = await ex.createOrder(sig.symbol, 'market', d === 1 ? 'buy' : 'sell', amount, undefined, {}); }
  catch (e) {
    LIVE.lastError = friendlyBitgetError(redact(e.message));
    log('CANLI GİRİŞ HATASI ' + sig.base + ': ' + LIVE.lastError);
    return { error: LIVE.lastError };
  }
  const fill = rp(num(order && (order.average || order.price), entry));
  if ((sig.sl - fill) * d >= 0) {
    try { await ex.createOrder(sig.symbol, 'market', d === 1 ? 'sell' : 'buy', amount, undefined, { reduceOnly: true }); } catch (e) { /* acil */ }
    return { error: 'fill stopun ters tarafında, pozisyon kapatıldı' };
  }
  const pos = {
    id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry: fill, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +Number(amount).toFixed(8), initialQty: +Number(amount).toFixed(8), remainingQty: +Number(amount).toFixed(8),
    notional: +(Number(amount) * fill).toFixed(4), margin: +((Number(amount) * fill) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(Number(amount) * Math.abs(fill - sig.sl)).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxR: 0, minR: 0,
    peakPx: fill, wickFrom: Math.ceil(Date.now() / M1) * M1,
    isLive: true, atrPct: num(sig.info && sig.info.atrPct, 0.4),
    aiChecked: false, ai: null, closing: false,
    orderId: order && order.id, stopOrderId: null, tpOrderId: null, exchangeQty: +Number(amount).toFixed(8)
  };
  const prot = await placeLiveProtection(sig, pos, d, amount);
  if (!prot) return { error: 'stop kurulamadı, pozisyon kapatıldı' };
  LIVE.open.push(pos);
  sig.posId = pos.id; sig.tradeable = true; sig.isLive = true;
  LIVE.lastSync = Date.now();
  dirty = true; saveState(true);
  log('CANLI AÇILDI ' + sig.base + ' ' + sig.dir + ' | giriş ' + fill + ' | SL ' + sig.sl +
    ' | TP1 ' + sig.tp1 + ' | miktar ' + amount + ' | risk %' + settings.riskPct + ' | kaldıraç ' + settings.leverage + 'x');
  setTimeout(() => { aiCheckPosition(pos).catch(() => {}); }, 2500);
  return { pos };
}
async function liveMoveStop(pos) {
  if (!pos || pos.protectionBusy || !LIVE.open.includes(pos)) return false;
  pos.protectionBusy = true;
  const d = pos.dir === 'LONG' ? 1 : -1, closeSide = d === 1 ? 'sell' : 'buy';
  let amount;
  try { amount = ex.amountToPrecision(pos.symbol, pos.remainingQty); } catch (e) { amount = pos.remainingQty; }
  const oldStop = pos.stopOrderId;
  try {
    const so = await ex.createOrder(pos.symbol, 'market', closeSide, amount, undefined, {
      stopLossPrice: priceForExchange(pos.symbol, pos.curSl), reduceOnly: true
    });
    if (!so || !so.id) throw new Error('stop emri kimliği yok');
    pos.stopOrderId = so.id;
    if (oldStop && oldStop !== so.id) { try { await ex.cancelOrder(oldStop, pos.symbol, { stop: true }); } catch (e) { /* dolmuş olabilir */ } }
    pos.protectedQty = Number(amount);
    return true;
  } catch (e) {
    pos.stopOrderId = oldStop || null;
    log('CANLI STOP TAŞINAMADI ' + pos.base + ': ' + redact(e.message) + ' | eski stop korunuyor');
    return false;
  } finally { pos.protectionBusy = false; }
}
function finalizeExchangeClosed(pos, price, reason) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const qty = pos.remainingQty || 0;
  if (qty > 0) {
    pos.grossRealized += (price - pos.entry) * d * qty;
    pos.costPaid += qty * (pos.entry + price) / 2 * EX.H / 100;
  }
  pos.remainingQty = 0;
  const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
  const sig = signals.find(s => s.id === pos.sigId);
  if (sig) { sig.maxR = Math.max(num(sig.maxR, 0), num(pos.maxR, 0)); finalizeSignal(sig, reason, price, netR, net); }
  LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
  LIVE.closed.push(Object.assign({}, pos, { exit: rp(price), result: reason, pnl: net, netR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt }));
  capArr(LIVE.closed, 150);
  if (pos.stopOrderId) ex.cancelOrder(pos.stopOrderId, pos.symbol).catch(() => {});
  if (pos.tpOrderId) ex.cancelOrder(pos.tpOrderId, pos.symbol).catch(() => {});
  dirty = true; saveStateSoon();
  log('CANLI POZİSYON BORSADA KAPANMIŞ ' + pos.base + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R');
}
async function syncLive() {
  if (!HAS_KEYS || !LIVE.open.length || LIVE.busy) return;
  LIVE.busy = true;
  try {
    const list = await fetchLivePositions();
    if (!list) return;
    for (const pos of LIVE.open.slice()) {
      const ep = findExchangePosition(pos.symbol, pos.dir);
      if (ep) {
        pos.exchangeQty = num(ep.contracts, pos.exchangeQty);
        pos.markPrice = num(ep.markPrice, pos.markPrice);
        pos.unrealizedPnl = num(ep.unrealizedPnl, pos.unrealizedPnl);
      } else if (Date.now() - pos.openedAt > 20e3) {
        const quote = await freshPrice(pos.symbol, 5000);
        if (quote.price > 0) finalizeExchangeClosed(pos, quote.price, 'EXCHANGE');
      }
    }
    LIVE.lastSync = Date.now();
  } finally { LIVE.busy = false; }
}

/* ───────────── sanal sinyal izleme (TREND / LT — pozisyon açmaz) ───────────── */
const VIRT_MAX_MS = { TREND: 8 * H1, LT: 48 * H1 };

async function monitorVirtual() {
  for (const sig of signals) {
    if (!isOpenSignal(sig) || sig.tradeable) continue;
    const px = priceOf(sig.symbol, 30000);
    if (!(px > 0)) continue;
    const d = sig.dir === 'LONG' ? 1 : -1;
    const risk = Math.abs(sig.entry - sig.sl);
    if (!(risk > 0)) continue;
    let hi = px, lo = px;
    try {
      const cs = await getCandles(sig.symbol, '1m', 6, false);
      if (cs) for (const c of cs) if (c.t >= (sig.lastBarT || 0)) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); }
    } catch (e) { /* ticker yeterli */ }
    const fav = d === 1 ? hi : lo;
    const adv = d === 1 ? lo : hi;
    sig.maxR = Math.max(num(sig.maxR, 0), (fav - sig.entry) * d / risk);

    if (d === 1 ? adv <= sig.curSl : adv >= sig.curSl) {
      closeVirtualSignal(sig, sig.curSl, sig.tp1Hit ? 'BE' : 'SL');
      continue;
    }
    if (sig.tp2 && (d === 1 ? fav >= sig.tp2 : fav <= sig.tp2)) {
      closeVirtualSignal(sig, sig.tp2, 'TP2');
      continue;
    }
    if (!sig.tp1Hit && (d === 1 ? fav >= sig.tp1 : fav <= sig.tp1)) {
      sig.tp1Hit = true;
      sig.curSl = rp(sig.entry + d * sig.entry * EX.COST / 100);
      sig.lastBarT = Math.ceil(Date.now() / M1) * M1;
      dirty = true; saveStateSoon();
      log('SANAL TP1 ' + sig.base + ' ' + sig.dir + ' | stop girişe çekildi');
      continue;
    }
    const maxMs = VIRT_MAX_MS[sig.module] || 8 * H1;
    if (Date.now() - sig.createdAt >= maxMs) closeVirtualSignal(sig, px, 'TIME');
  }
}



/* ───────────────────────────── 1) OtoTrade — ivme ilk ateş ───────────────────────────── */
function autoMomentumReason(st, px, rNow) {
  const d = st.dir === 'LONG' ? 1 : -1;
  const age = (Date.now() - num(st.openedAt, Date.now())) / 1000;
  const r20 = retPct(st.symbol, 20);
  const atrPct = num(st.atrPct, 0.4);
  if (age >= 4 && r20 != null && (-r20 * d) >= Math.max(0.10, atrPct * 0.55) && rNow < 0.8) return 'MOMENTUM';
  if (num(st.maxR, 0) >= 0.45 && (num(st.maxR, 0) - rNow) >= Math.max(0.18, 0.35 * num(st.maxR, 0))) return 'FADE';
  if (age >= num(st.noMoveSec, settings.impulseNoMoveSec) && num(st.maxR, 0) < 0.30 && r20 != null &&
      Math.abs(r20) < Math.max(0.05, atrPct * 0.22)) return 'STALL';
  if (age >= settings.impulseMaxHoldSec) return 'TIME';
  return null;
}

function evaluateImpulse(sym, r30, r60, cs) {
  if (!cs || cs.length < 30) return null;
  const live = cs[cs.length - 1];
  const prev = cs.slice(0, -1);
  const price = priceOf(sym, 20000) || live.c;
  if (!(price > 0)) return null;
  const atr = atrLast(prev, 14) || atrLast(cs, 14) || price * 0.002;
  const atrPct = Math.max(0.02, atr / price * 100);
  const elapsed = clamp((Date.now() - live.t) / 1000, 5, 60);
  const vRate = live.v * 60 / elapsed;
  const avgVol = avg(prev.slice(-20).map(c => c.v)) || 1;
  const volMult = vRate / avgVol;
  const rangeExp = (live.h - live.l) / Math.max(EPS, atr);
  const body = bodyRatio(live);
  const dir = r30 >= 0 ? 'LONG' : 'SHORT';
  const d = dir === 'LONG' ? 1 : -1;
  const agree = d === 1 ? live.c > live.o : live.c < live.o;
  const ref15 = prev[Math.max(0, prev.length - 15)];
  const move15 = ref15 ? (price / ref15.c - 1) * 100 : 0;
  const lateLimit = Math.max(0.8, atrPct * 4.0);
  const late = Math.abs(move15) > lateLimit && Math.sign(move15) === Math.sign(r30);
  const minMove = Math.max(settings.impulseMinPct, atrPct * 0.85);
  const accel = Math.abs(r30) >= Math.abs(r60) * 0.55 && Math.sign(r30) === Math.sign(r60);
  const spread = spreadPct(sym);
  const fired = Math.abs(r30) >= minMove && Math.abs(r60) >= minMove * 0.85 && accel &&
    volMult >= settings.impulseVolMult && rangeExp >= 1.0 && body >= 0.45 && agree &&
    !late && spread <= settings.maxSpreadPct;

  let state = 'IZLEME';
  if (late) state = 'GEC';
  else if (fired) state = 'ATES';
  let reason = 'tetik bekleniyor';
  if (late) reason = 'hareket uzamış (15m ' + fmtPct(move15) + ' > ' + lateLimit.toFixed(2) + '%)';
  else if (!accel) reason = 'ivme yavaşlıyor (30s ' + fmtPct(r30) + ' / 60s ' + fmtPct(r60) + ')';
  else if (volMult < settings.impulseVolMult) reason = 'hacim yetersiz (' + volMult.toFixed(1) + 'x)';
  else if (rangeExp < 1.0) reason = 'mum aralığı zayıf (' + rangeExp.toFixed(2) + ' ATR)';
  else if (body < 0.45) reason = 'gövde zayıf (' + Math.round(body * 100) + '%)';
  else if (!agree) reason = 'mum yönü uyumsuz';
  else if (spread > settings.maxSpreadPct) reason = 'spread yüksek';
  else if (fired) reason = 'İLK ATEŞ · 30s ' + fmtPct(r30) + ' · hacim ' + volMult.toFixed(1) + 'x';

  const swing = d === 1 ? Math.min.apply(null, prev.slice(-3).map(c => c.l)) : Math.max.apply(null, prev.slice(-3).map(c => c.h));
  const rawRisk = Math.abs(price - swing) + atr * 0.15;
  const risk = clamp(rawRisk, price * 0.0022, price * 0.009);
  const sl = rp(price - d * risk);
  const tp1 = rp(price + d * risk * settings.impulseTp1R);
  const tp2 = rp(price + d * risk * settings.impulseTp2R);
  const score = clamp(Math.round(40 +
    Math.min(25, Math.abs(r30) / Math.max(0.05, atrPct) * 10) +
    Math.min(15, (volMult - 1) * 8) +
    body * 10 + Math.min(10, rangeExp * 4)), 20, 99);

  return {
    module: 'AUTO', symbol: sym, base: baseOf(sym), dir, price: rp(price),
    r30: +num(r30).toFixed(2), r60: +num(r60).toFixed(2), volMult: +volMult.toFixed(2),
    atrPct: +atrPct.toFixed(2), body: +body.toFixed(2), rangeExp: +rangeExp.toFixed(2),
    move15: +move15.toFixed(2), score, state, reason,
    plan: { entry: rp(price), sl, tp1, tp2, riskPct: +(risk / price * 100).toFixed(2) },
    at: Date.now()
  };
}

function openPosFor(sym) {
  return paper.open.concat(LIVE.open).find(p => p.symbol === sym) || null;
}

async function fireAuto(row) {
  if (!row || row.state !== 'ATES') return;
  if (!canOpenAuto()) return;
  const sym = row.symbol;
  const now = Date.now();
  const last = AUTO_LAST.get(sym) || 0;
  if (now - last < 8 * M1) return;
  if (openPosFor(sym)) return;
  AUTO_LAST.set(sym, now);
  const p = row.plan;
  const sig = addSignal({
    module: 'AUTO', symbol: sym, base: row.base, dir: row.dir,
    entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, conf: row.score,
    info: {
      setup: 'IMPULSE_IGNITION', tf: '1m', atrPct: row.atrPct,
      r30: row.r30, r60: row.r60, volMult: row.volMult, body: row.body,
      rangeExp: row.rangeExp, move15: row.move15, score: row.score,
      reason: row.reason, aiCheck: 'Girişten 2-3 sn sonra AI fake kontrolü'
    }
  });
  if (!sig) return;
  const r = await openPosition(sig);
  if (r.error) {
    sig.info.openError = r.error;
    logRej('AUTO', sym, r.error, row.price);
    log('OTOTRADE AÇILAMADI ' + row.base + ': ' + r.error + ' (sinyal sanal izleniyor)');
  }
}

async function autoScan(force) {
  if (!settings.autoTrade) {
    AUTO_WATCH = [];
    scan.autoAt = Date.now();
    return;
  }
  const now = Date.now();
  const rows = [];
  const thr = settings.impulseMinPct * 0.55;
  for (const sym of scanSyms(settings.topN)) {
    const t = tick(sym);
    if (!t || now - t.ts > 30e3) continue;
    if (spreadPct(sym) > settings.maxSpreadPct) continue;
    const r30 = retPct(sym, 30);
    const r60 = retPct(sym, 60);
    if (r30 == null || r60 == null) continue;
    const m = Math.max(Math.abs(r30), Math.abs(r60));
    if (m < thr) continue;
    rows.push({ sym, r30, r60, m });
  }
  rows.sort((a, b) => b.m - a.m);
  const top = rows.slice(0, 14);
  const watch = [];
  await pool(top, 4, async row => {
    let cs = null;
    try { cs = await getCandles(row.sym, '1m', 70, false); } catch (e) { return; }
    const ev = evaluateImpulse(row.sym, row.r30, row.r60, cs);
    if (!ev) return;
    const pos = openPosFor(row.sym);
    if (pos) { ev.state = 'ACIK'; ev.reason = 'pozisyon açık (' + pos.dir + ')'; }
    else if (signals.some(s => isOpenSignal(s) && s.symbol === row.sym)) { ev.state = 'ACIK'; ev.reason = 'sinyal açık'; }
    watch.push(ev);
  });
  watch.sort((a, b) => b.score - a.score);
  AUTO_WATCH = watch.slice(0, 12);
  scan.autoAt = now;
  for (const row of AUTO_WATCH) {
    if (row.state === 'ATES') { try { await fireAuto(row); } catch (e) { log('OtoTrade ateş hatası: ' + redact(e.message)); } }
  }
}


/* ───────────────────────────── 2) Trend Scalp — 5m ───────────────────────────── */
function evaluateTrend(sym, cs5, cs15) {
  if (!cs5 || cs5.length < 120 || !cs15 || cs15.length < 80) return null;
  const n = cs5.length;
  const cl = closesOf(cs5);
  const e21 = emaArr(cl, 21), e55 = emaArr(cl, 55), e200 = emaArr(cl, 200);
  const i = n - 1;
  const last = cs5[i], prev = cs5[i - 1];
  const price = priceOf(sym, 20000) || last.c;
  if (!(price > 0)) return null;
  const atr = atrLast(cs5, 14);
  if (!(atr > 0)) return null;
  const atrPct = atr / price * 100;
  const rsi = rsiLast(cl, 14);
  const volMult = last.v / (avg(cs5.slice(-21, -1).map(c => c.v)) || 1);
  const cl15 = closesOf(cs15);
  const e50_15 = emaLast(cl15, 50), e200_15 = emaLast(cl15, 200);
  const up = e21[i] > e55[i] && last.c > e200[i] && e50_15 > e200_15;
  const dn = e21[i] < e55[i] && last.c < e200[i] && e50_15 < e200_15;
  if (!up && !dn) return null;
  const dir = up ? 'LONG' : 'SHORT';
  const d = dir === 'LONG' ? 1 : -1;
  const pullback = up
    ? cs5.slice(-6, -1).some(c => c.l <= e21[i] * 1.003)
    : cs5.slice(-6, -1).some(c => c.h >= e21[i] * 0.997);
  const breakout = up
    ? last.c > Math.max.apply(null, cs5.slice(-10, -1).map(c => c.h))
    : last.c < Math.min.apply(null, cs5.slice(-10, -1).map(c => c.l));
  const trigger = up
    ? (last.c > last.o && last.c > prev.h)
    : (last.c < last.o && last.c < prev.l);
  const body = bodyRatio(last);
  const rsiOk = up ? (rsi != null && rsi >= 42 && rsi <= 75) : (rsi != null && rsi >= 25 && rsi <= 58);
  const setup = trigger && body >= 0.40 && volMult >= 1.05 && (pullback || breakout) && rsiOk;

  let reason = 'tetik bekleniyor';
  if (!trigger) reason = '5m tetik mumu yok';
  else if (!(pullback || breakout)) reason = 'EMA bölgesine değmedi / kırılım yok';
  else if (volMult < 1.05) reason = 'hacim yetersiz (' + volMult.toFixed(1) + 'x)';
  else if (!rsiOk) reason = 'RSI uygun değil (' + (rsi == null ? '-' : Math.round(rsi)) + ')';
  else if (body < 0.40) reason = 'gövde zayıf';
  else if (setup) reason = (breakout ? 'kırılım' : 'geri çekilme') + ' + 5m tetik · hacim ' + volMult.toFixed(1) + 'x';

  const swing = up ? Math.min.apply(null, cs5.slice(-8).map(c => c.l)) : Math.max.apply(null, cs5.slice(-8).map(c => c.h));
  let risk = Math.abs(price - swing) + atr * 0.20;
  risk = clamp(risk, price * 0.005, price * 0.020);
  const sl = rp(price - d * risk);
  const tp1 = rp(price + d * risk * settings.trendTp1R);
  const tp2 = rp(price + d * risk * settings.trendTp2R);
  const score = clamp(Math.round(52 +
    (breakout ? 10 : 6) + Math.min(12, (volMult - 1) * 8) + body * 10 +
    (rsiOk ? 6 : 0) + (Math.abs(e21[i] - e55[i]) / atr > 0.6 ? 6 : 0)), 30, 95);

  return {
    module: 'TREND', symbol: sym, base: baseOf(sym), dir, price: rp(price),
    trend: up ? 'YUKARI' : 'ASAGI', rsi: rsi == null ? null : Math.round(rsi),
    volMult: +volMult.toFixed(2), atrPct: +atrPct.toFixed(2), body: +body.toFixed(2),
    setup: breakout ? 'KIRILIM' : pullback ? 'PULLBACK' : null,
    score, state: setup ? 'SINYAL' : 'IZLEME', reason,
    plan: { entry: rp(price), sl, tp1, tp2, riskPct: +(risk / price * 100).toFixed(2) },
    at: Date.now()
  };
}

async function trendScan() {
  if (!settings.trendEnabled) { TREND_WATCH = []; scan.trendAt = Date.now(); return; }
  const syms = scanSyms(Math.min(settings.topN, 80));
  const watch = [];
  await pool(syms, 5, async sym => {
    if (openPosFor(sym)) return;
    let cs5 = null, cs15 = null;
    try {
      cs5 = await getCandles(sym, '5m', 240, true);
      cs15 = await getCandles(sym, '15m', 120, true);
    } catch (e) { return; }
    const ev = evaluateTrend(sym, cs5, cs15);
    if (ev) watch.push(ev);
  });
  watch.sort((a, b) => b.score - a.score);
  TREND_WATCH = watch.slice(0, 15);
  scan.trendAt = Date.now();
  for (const row of TREND_WATCH) {
    if (row.state !== 'SINYAL') continue;
    const sig = addSignal({
      module: 'TREND', symbol: row.symbol, base: row.base, dir: row.dir,
      entry: row.plan.entry, sl: row.plan.sl, tp1: row.plan.tp1, tp2: row.plan.tp2, conf: row.score,
      info: {
        setup: row.setup || 'TREND', tf: '5m', trend: row.trend, rsi: row.rsi,
        volMult: row.volMult, atrPct: row.atrPct, reason: row.reason, aiGate: false
      }
    });
    if (sig) log('TREND SİNYAL ' + row.base + ' ' + row.dir + ' | ' + row.reason);
  }
}


/* ───────────────────────────── 3) LT Üçgen — 2h ───────────────────────────── */
function barTime(cs, i) {
  const n = cs.length;
  if (i >= 0 && i < n) return cs[Math.floor(i)].t;
  if (i < 0) return cs[0].t + i * H2;
  return cs[n - 1].t + (i - (n - 1)) * H2;
}
function lineAt(line, t) {
  const dt = line.t2 - line.t1;
  if (!dt) return line.p1;
  return line.p1 + (line.p2 - line.p1) * (t - line.t1) / dt;
}
function triangleSnap(tri, px, now) {
  const atr = num(tri.atr, px * 0.005) || px * 0.005;
  const upperNow = lineAt(tri.upper, now);
  const lowerNow = lineAt(tri.lower, now);
  const width = upperNow - lowerNow;
  const dur = Math.max(1, tri.apexT - tri.startT);
  const progress = (now - tri.startT) / dur;
  return {
    upperNow: rp(upperNow), lowerNow: rp(lowerNow), width,
    widthAtr: width / Math.max(EPS, atr),
    distUpperAtr: Math.abs(px - upperNow) / Math.max(EPS, atr),
    distLowerAtr: Math.abs(px - lowerNow) / Math.max(EPS, atr),
    progress: +progress.toFixed(2), atr, upperNowRaw: upperNow, lowerNowRaw: lowerNow
  };
}

function findTriangle(cs) {
  if (!cs || cs.length < 60) return null;
  const n = cs.length;
  const atr = atrLast(cs, 14);
  if (!(atr > 0)) return null;
  const piv = pivots(cs, 3, 3);
  const startI = Math.max(0, n - 120);
  const highs = piv.filter(p => p.type === 'H' && p.i >= startI);
  const lows = piv.filter(p => p.type === 'L' && p.i >= startI);
  if (highs.length < 2 || lows.length < 2) return null;
  let best = null;

  for (let a = 0; a < highs.length - 1; a++) {
    for (let b = a + 1; b < highs.length; b++) {
      const h1 = highs[a], h2 = highs[b];
      if (h2.p >= h1.p || h2.i - h1.i < 8) continue;
      const su = (h2.p - h1.p) / (h2.i - h1.i);
      if (!(su < 0)) continue;
      for (let c = 0; c < lows.length - 1; c++) {
        for (let d = c + 1; d < lows.length; d++) {
          const l1 = lows[c], l2 = lows[d];
          if (l2.p <= l1.p || l2.i - l1.i < 8) continue;
          const sl = (l2.p - l1.p) / (l2.i - l1.i);
          if (!(sl > 0)) continue;
          const baseI = Math.max(h1.i, l1.i);
          const upAt = i => h1.p + su * (i - h1.i);
          const loAt = i => l1.p + sl * (i - l1.i);
          if (upAt(baseI) <= loAt(baseI)) continue;
          if (upAt(n - 1) <= loAt(n - 1)) continue;
          // apeks (bar indeksi)
          const x = (l1.p - h1.p + su * h1.i - sl * l1.i) / (su - sl);
          if (!(x > n - 1 && x < n + 150)) continue;
          const sI = Math.min(h1.i, l1.i);
          const dur = x - sI;
          if (dur < 12) continue;
          const progress = (n - 1 - sI) / dur;
          if (progress < 0.35 || progress > 1.02) continue;
          const width = upAt(n - 1) - loAt(n - 1);
          if (width < 0.45 * atr) continue;
          const sym = Math.min(Math.abs(su), Math.abs(sl)) / Math.max(Math.abs(su), Math.abs(sl));
          if (sym < 0.25) continue;
          let tu = 0, tl = 0;
          for (let i = sI; i < n; i++) {
            const u = upAt(i), l = loAt(i);
            if (u <= l) break;
            if (cs[i].h >= u - 0.30 * atr) tu++;
            if (cs[i].l <= l + 0.30 * atr) tl++;
          }
          if (tu < 2 || tl < 2) continue;
          const score = clamp(Math.round(42 + Math.min(24, tu * 4 + tl * 4) + sym * 22 + Math.min(12, progress * 12)), 35, 96);
          const tri = {
            manual: false,
            upper: { t1: barTime(cs, h1.i), p1: h1.p, t2: barTime(cs, h2.i), p2: h2.p },
            lower: { t1: barTime(cs, l1.i), p1: l1.p, t2: barTime(cs, l2.i), p2: l2.p },
            startT: barTime(cs, sI), apexT: barTime(cs, x), atr,
            touches: { upper: tu, lower: tl }, symmetry: +sym.toFixed(2),
            progress: +progress.toFixed(2), score
          };
          if (!best || score > best.score) best = tri;
        }
      }
    }
  }
  return best;
}

async function addLtSignal(symbol, dir, px, tri, side, manual) {
  const base = baseOf(symbol);
  const snap = triangleSnap(tri, px, Date.now());
  const key = (tri.id || 'M') + '|' + side;
  const now = Date.now();
  const last = LT_FIRED.get(key) || 0;
  if (now - last < 4 * H1) return null;
  const height = Math.max(snap.atr * 0.5, Math.abs(snap.width));
  const d = dir === 'LONG' ? 1 : -1;
  let risk = clamp(0.35 * height, px * 0.005, px * 0.025);
  const sl = rp(px - d * risk);
  const tp1 = rp(px + d * risk * 1.4);
  const tp2 = rp(px + d * risk * 2.4);
  const sig = addSignal({
    module: 'LT', symbol, base, dir,
    entry: rp(px), sl, tp1, tp2, conf: manual ? 78 : num(tri.score, 70),
    info: {
      setup: manual ? 'LT_MANUEL_TEMAS' : 'LT_OTO_TEMAS', tf: '2h',
      side: side === 'UST' ? 'ÜST ÇİZGİ' : 'ALT ÇİZGİ',
      upper: snap.upperNow, lower: snap.lowerNow, widthAtr: +snap.widthAtr.toFixed(2),
      distAtr: +(side === 'UST' ? snap.distUpperAtr : snap.distLowerAtr).toFixed(2),
      progress: snap.progress, touches: tri.touches || null, manual: !!manual,
      atrPct: +(snap.atr / px * 100).toFixed(2),
      reason: (side === 'UST' ? 'Üst çizgiye temas — yukarı kırılım adayı' : 'Alt çizgiye temas — aşağı kırılım adayı') +
        ' · teyidi sen kontrol et'
    }
  });
  if (sig) LT_FIRED.set(key, now);
  return sig;
}

async function ltScan() {
  if (!settings.ltEnabled) { LT_WATCH = []; scan.ltAt = Date.now(); return; }
  const syms = scanSyms(Math.min(settings.topN, 70));
  const rows = [];
  await pool(syms, 3, async sym => {
    let cs = null;
    try { cs = await getLong2h(sym, 160); } catch (e) { return; }
    if (!cs || cs.length < 60) return;
    const tri = findTriangle(cs);
    if (!tri) { LT_TRI.delete(sym); return; }
    tri.id = 'AUTO|' + sym;
    tri.symbol = sym;
    LT_TRI.set(sym, { tri, at: Date.now() });
    const px = priceOf(sym, 20000) || cs[cs.length - 1].c;
    const snap = triangleSnap(tri, px, Date.now());
    rows.push({
      module: 'LT', symbol: sym, base: baseOf(sym), dir: px >= (snap.upperNowRaw + snap.lowerNowRaw) / 2 ? 'LONG' : 'SHORT',
      price: rp(px), upper: snap.upperNow, lower: snap.lowerNow, widthAtr: +snap.widthAtr.toFixed(2),
      distAtr: +Math.min(snap.distUpperAtr, snap.distLowerAtr).toFixed(2),
      progress: snap.progress, touches: tri.touches, score: tri.score, manual: false,
      state: 'IZLEME', side: null, reason: 'üçgen izleniyor', at: Date.now()
    });
  });
  rows.sort((a, b) => (a.distAtr - b.distAtr) || (b.score - a.score));
  LT_WATCH = rows.slice(0, 15);
  scan.ltAt = Date.now();
  await ltTick();
}

async function ltTick() {
  if (!settings.ltEnabled) return;
  const now = Date.now();
  let firedThisPass = 0;
  for (const row of LT_WATCH) {
    const e = LT_TRI.get(row.symbol);
    if (!e || !e.tri) continue;
    const px = priceOf(row.symbol, 20000);
    if (!(px > 0)) continue;
    const tri = e.tri;
    const snap = triangleSnap(tri, px, now);
    row.price = rp(px);
    row.upper = snap.upperNow; row.lower = snap.lowerNow;
    row.widthAtr = +snap.widthAtr.toFixed(2);
    row.distAtr = +Math.min(snap.distUpperAtr, snap.distLowerAtr).toFixed(2);
    row.progress = snap.progress;
    row.dir = px >= (snap.upperNowRaw + snap.lowerNowRaw) / 2 ? 'LONG' : 'SHORT';
    if (snap.progress > 1.05 || snap.widthAtr < 0.25) {
      row.state = 'BITTI'; row.side = null; row.reason = 'üçgen sıkışması bitti';
    } else if (px > snap.upperNowRaw + 0.25 * snap.atr) {
      row.state = 'KIRDI_YUKARI'; row.side = 'UST'; row.reason = 'üst çizgi yukarı kırıldı (teyit sende)';
    } else if (px < snap.lowerNowRaw - 0.25 * snap.atr) {
      row.state = 'KIRDI_ASAGI'; row.side = 'ALT'; row.reason = 'alt çizgi aşağı kırıldı (teyit sende)';
    } else if (snap.distUpperAtr <= settings.ltTouchAtr) {
      row.state = 'TEMAS'; row.side = 'UST'; row.reason = 'üst çizgiye temas · yukarı kırılım adayı';
    } else if (snap.distLowerAtr <= settings.ltTouchAtr) {
      row.state = 'TEMAS'; row.side = 'ALT'; row.reason = 'alt çizgiye temas · aşağı kırılım adayı';
    } else if (row.distAtr <= settings.ltTouchAtr * 2.5) {
      row.state = 'YAKIN'; row.side = null; row.reason = 'çizgiye yaklaşıyor';
    } else {
      row.state = 'IZLEME'; row.side = null; row.reason = 'üçgen izleniyor';
    }
    if (row.state === 'TEMAS') {
      if (firedThisPass >= 3) continue;
      const dir = row.side === 'UST' ? 'LONG' : 'SHORT';
      const sig = await addLtSignal(row.symbol, dir, px, tri, row.side, false);
      if (sig) firedThisPass++;
    }
  }

  // Manuel üçgenler
  for (const tri of ltManual) {
    if (!tri || !tri.upper || !tri.lower) continue;
    const px = priceOf(tri.symbol, 20000);
    if (!(px > 0)) continue;
    const snap = triangleSnap(tri, px, now);
    if (snap.progress < 0.20 || snap.progress > 1.15) continue;
    if (!(snap.width > 0)) continue;
    if (snap.distUpperAtr <= settings.ltTouchAtr) {
      await addLtSignal(tri.symbol, 'LONG', px, tri, 'UST', true);
    } else if (snap.distLowerAtr <= settings.ltTouchAtr) {
      await addLtSignal(tri.symbol, 'SHORT', px, tri, 'ALT', true);
    }
  }
}

function buildManualTriangle(symbol, points, atr) {
  if (!Array.isArray(points) || points.length !== 4) return { error: '4 nokta gerekli (2 üst + 2 alt)' };
  const pts = points.map(p => ({
    t: Number(p.t) < 1e12 ? Number(p.t) * 1000 : Number(p.t),
    price: Number(p.price)
  })).filter(p => p.t > 0 && p.price > 0);
  if (pts.length !== 4) return { error: 'noktalar geçersiz' };
  const sorted = pts.slice().sort((a, b) => b.price - a.price);
  const up = sorted.slice(0, 2).sort((a, b) => a.t - b.t);
  const lo = sorted.slice(2, 4).sort((a, b) => a.t - b.t);
  if (up[1].t === up[0].t || lo[1].t === lo[0].t) return { error: 'aynı zamanlı noktalar' };
  if (!(up[1].price < up[0].price)) return { error: 'üst çizgi aşağı eğimli olmalı (2. tepe daha düşük)' };
  if (!(lo[1].price > lo[0].price)) return { error: 'alt çizgi yukarı eğimli olmalı (2. dip daha yüksek)' };
  const su = (up[1].price - up[0].price) / (up[1].t - up[0].t);
  const sl = (lo[1].price - lo[0].price) / (lo[1].t - lo[0].t);
  if (!(su < 0) || !(sl > 0)) return { error: 'çizgiler birbirine yaklaşmıyor' };
  const apexT = (lo[0].price - up[0].price + su * up[0].t - sl * lo[0].t) / (su - sl);
  const now = Date.now();
  if (!(apexT > now)) return { error: 'üçgen apeksi geçmiş; yeni üçgen çiz' };
  if (apexT > now + 60 * D1) return { error: 'apeks çok uzak' };
  const startT = Math.min(up[0].t, lo[0].t);
  const upperNow = lineAt({ t1: up[0].t, p1: up[0].price, t2: up[1].t, p2: up[1].price }, now);
  const lowerNow = lineAt({ t1: lo[0].t, p1: lo[0].price, t2: lo[1].t, p2: lo[1].price }, now);
  if (!(upperNow > lowerNow)) return { error: 'çizgiler şu an kesişmiş' };
  return {
    tri: {
      id: 'M' + Date.now().toString(36),
      manual: true, symbol, upper: { t1: up[0].t, p1: up[0].price, t2: up[1].t, p2: up[1].price },
      lower: { t1: lo[0].t, p1: lo[0].price, t2: lo[1].t, p2: lo[1].price },
      startT, apexT, atr: num(atr, upperNow * 0.005), score: 78, createdAt: now
    }
  };
}

function viewManual(t) {
  const px = priceOf(t.symbol, 30000) || 0;
  const snap = px > 0 ? triangleSnap(t, px, Date.now()) : null;
  return {
    id: t.id, symbol: t.symbol, base: baseOf(t.symbol), manual: true,
    upper: t.upper, lower: t.lower, startT: t.startT, apexT: t.apexT,
    createdAt: t.createdAt, score: t.score,
    upperNow: snap ? snap.upperNow : null, lowerNow: snap ? snap.lowerNow : null,
    progress: snap ? snap.progress : null, distAtr: snap ? +Math.min(snap.distUpperAtr, snap.distLowerAtr).toFixed(2) : null
  };
}

function chartTriangles(sym, cs) {
  const out = [];
  const list = [];
  const auto = LT_TRI.get(sym);
  if (auto && auto.tri) list.push(auto.tri);
  else {
    const tri = findTriangle(cs);
    if (tri) { tri.id = 'AUTO|' + sym; tri.symbol = sym; list.push(tri); }
  }
  for (const t of ltManual) if (t.symbol === sym) list.push(t);
  for (const tri of list) {
    const times = [];
    for (const c of cs) if (c.t >= tri.startT && c.t <= tri.apexT) times.push(c.t);
    const lastT = times.length ? times[times.length - 1] : tri.startT;
    if (tri.apexT > lastT) times.push(tri.apexT);
    if (!times.length) continue;
    out.push({
      id: tri.id, manual: !!tri.manual, label: tri.manual ? 'Manuel üçgen' : 'Otomatik üçgen',
      upper: times.map(t => [Math.round(t / 1000), +lineAt(tri.upper, t).toFixed(8)]),
      lower: times.map(t => [Math.round(t / 1000), +lineAt(tri.lower, t).toFixed(8)])
    });
  }
  return out;
}


/* ───────────────────────────── API görünümleri ───────────────────────────── */
const START_AT = Date.now();

function marketView() {
  return {
    ready: READY, universe: UNIVERSE.length, ticks: TICK.size,
    hasKeys: HAS_KEYS, tokenRequired: !!API_TOKEN,
    uptimeSec: Math.round((Date.now() - START_AT) / 1000),
    scan: {
      autoAt: scan.autoAt || 0, trendAt: scan.trendAt || 0, ltAt: scan.ltAt || 0,
      tickAt: scan.tickAt || 0, universeAt: scan.universe || 0
    }
  };
}

function autoView() {
  return {
    enabled: settings.autoTrade,
    watch: AUTO_WATCH,
    open: paper.open.concat(LIVE.open).filter(p => p.module === 'AUTO').map(viewPosition),
    today: signals.filter(s => s.module === 'AUTO' && num(s.createdAt) >= utcDayStart(Date.now())).length
  };
}
function trendView() {
  return {
    enabled: settings.trendEnabled,
    watch: TREND_WATCH,
    open: signals.filter(s => s.module === 'TREND' && isOpenSignal(s)).map(viewSignal)
  };
}
function ltView() {
  return {
    enabled: settings.ltEnabled,
    watch: LT_WATCH,
    manual: ltManual.map(viewManual),
    open: signals.filter(s => s.module === 'LT' && isOpenSignal(s)).map(viewSignal)
  };
}

function stateView() {
  return {
    ok: true, version: VERSION, now: Date.now(),
    mode: settings.tradeMode, settings,
    paper: paperSummary(), live: liveSummary(), stats: statsView(),
    ai: aiStatus(), market: marketView(),
    auto: autoView(), trend: trendView(), lt: ltView(),
    positions: paper.open.concat(LIVE.open).map(viewPosition),
    signals: signals.filter(isOpenSignal).map(viewSignal),
    recent: signals.slice(-40).reverse().map(viewSignal),
    logs: LOGS.slice(-60), rejects: REJ.slice(-25).reverse()
  };
}

/* ───────────────────────────── HTTP ───────────────────────────── */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

function tokenOf(req) {
  const h = req.get('x-api-token') || req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return String(m ? m[1] : h || req.query.token || '').trim();
}
function authorized(req) {
  if (!API_TOKEN) return true;
  const t = tokenOf(req);
  if (!t || t.length !== API_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(API_TOKEN)); } catch (e) { return false; }
}
app.use('/api', (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Yetkisiz: ALPHASON_API_TOKEN gerekli' });
  next();
});
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  log('API HATASI ' + req.method + ' ' + req.path + ': ' + redact(e.message));
  if (!res.headersSent) res.status(500).json({ ok: false, error: redact(e.message) });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true, version: VERSION, ready: READY, uptimeSec: Math.round((Date.now() - START_AT) / 1000),
    mode: settings.tradeMode, universe: UNIVERSE.length, ticks: TICK.size,
    auto: settings.autoTrade, trend: settings.trendEnabled, lt: settings.ltEnabled,
    ai: aiReady(), openPositions: openCount(), signals: signals.length
  });
});

app.get('/api/state', (req, res) => res.json(stateView()));

app.get('/api/signals', (req, res) => {
  const limit = clamp(Math.round(num(req.query.limit, 100)), 1, 400);
  const mod = String(req.query.module || '').toUpperCase();
  let list = signals.slice();
  if (MODS[mod]) list = list.filter(s => s.module === mod);
  if (req.query.status === 'open') list = list.filter(isOpenSignal);
  if (req.query.status === 'closed') list = list.filter(s => !isOpenSignal(s));
  res.json({ ok: true, count: list.length, signals: list.slice(-limit).reverse().map(viewSignal) });
});

app.get('/api/stats', (req, res) => res.json({ ok: true, stats: statsView(), paper: paperSummary(), live: liveSummary() }));

app.get('/api/logs', (req, res) => res.json({ ok: true, logs: LOGS.slice(-200), rejects: REJ.slice(-60).reverse() }));

app.get('/api/market', (req, res) => res.json({ ok: true, market: marketView(), universe: UNIVERSE.slice(0, 150) }));

/* ───────────────────────────── ayarlar ───────────────────────────── */
app.post('/api/settings', (req, res) => {
  const before = Object.assign({}, settings);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  settings = sanitizeSettings(Object.assign({}, settings, body));
  if (settings.tradeMode === 'live') {
    const err = liveConfigError();
    if (err) { settings.tradeMode = 'paper'; return res.status(400).json({ ok: false, error: err, settings }); }
  }
  const needUniverse = before.topN !== settings.topN || before.minQuoteVol !== settings.minQuoteVol ||
    before.maxSpreadPct !== settings.maxSpreadPct || before.includeStocks !== settings.includeStocks;
  dirty = true; saveStateSoon();
  log('AYARLAR GÜNCELLENDİ' + (needUniverse ? ' (evren yenileniyor)' : ''));
  if (needUniverse) refreshUniverse().catch(() => {});
  res.json({ ok: true, settings });
});

app.post('/api/trade/mode', (req, res) => {
  const want = String((req.body && req.body.mode) || '').toLowerCase() === 'live' ? 'live' : 'paper';
  if (want === 'live') {
    const err = liveConfigError();
    if (err) return res.status(400).json({ ok: false, error: err });
  }
  settings.tradeMode = want;
  dirty = true; saveStateSoon();
  log('İŞLEM MODU → ' + (want === 'live' ? 'CANLI' : 'PAPER'));
  res.json({ ok: true, mode: want, live: liveSummary(), paper: paperSummary() });
});

app.post('/api/paper/reset', (req, res) => {
  const eq = clamp(num(req.body && req.body.equity, settings.paperEquity), 10, 1e9);
  settings.paperEquity = eq;
  paper = { open: [], closed: [], equity: eq, start: eq, dayStart: eq, dayKey: dayKey(), peak: eq };
  signals = signals.filter(isOpenSignal);
  dirty = true; saveState();
  log('PAPER SIFIRLANDI → ' + eq + ' USDT');
  res.json({ ok: true, paper: paperSummary() });
});

app.post('/api/position/:id/close', wrap(async (req, res) => {
  const pos = paper.open.concat(LIVE.open).find(p => p.id === req.params.id || p.sigId === req.params.id);
  if (!pos) return res.status(404).json({ ok: false, error: 'pozisyon bulunamadı' });
  const q = await freshPrice(pos.symbol, 4000);
  if (!(q.price > 0)) return res.status(400).json({ ok: false, error: q.error || 'fiyat yok' });
  const r = await closePosition(pos, q.price, 'MANUEL');
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, result: r });
}));

/* ───────────────────────────── modül rotaları ───────────────────────────── */
app.post('/api/auto/toggle', (req, res) => {
  const on = req.body && typeof req.body.on === 'boolean' ? req.body.on : !settings.autoTrade;
  settings.autoTrade = on;
  if (!on) AUTO_WATCH = [];
  dirty = true; saveStateSoon();
  log('OTOTRADE ' + (on ? 'AÇIK' : 'KAPALI'));
  res.json({ ok: true, auto: autoView() });
});
app.post('/api/auto/scan', wrap(async (req, res) => { await autoScan(true); res.json({ ok: true, auto: autoView() }); }));

app.post('/api/trend/toggle', (req, res) => {
  const on = req.body && typeof req.body.on === 'boolean' ? req.body.on : !settings.trendEnabled;
  settings.trendEnabled = on;
  if (!on) TREND_WATCH = [];
  dirty = true; saveStateSoon();
  log('TREND SCALP ' + (on ? 'AÇIK' : 'KAPALI'));
  res.json({ ok: true, trend: trendView() });
});
app.post('/api/trend/scan', wrap(async (req, res) => { await trendScan(); res.json({ ok: true, trend: trendView() }); }));

app.post('/api/lt/toggle', (req, res) => {
  const on = req.body && typeof req.body.on === 'boolean' ? req.body.on : !settings.ltEnabled;
  settings.ltEnabled = on;
  if (!on) LT_WATCH = [];
  dirty = true; saveStateSoon();
  log('LT ÜÇGEN ' + (on ? 'AÇIK' : 'KAPALI'));
  res.json({ ok: true, lt: ltView() });
});
app.post('/api/lt/scan', wrap(async (req, res) => { await ltScan(); res.json({ ok: true, lt: ltView() }); }));

app.post('/api/lt/manual', wrap(async (req, res) => {
  const symbol = String((req.body && req.body.symbol) || '').trim();
  const points = req.body && req.body.points;
  if (!symbol.includes('/')) return res.status(400).json({ ok: false, error: 'sembol gerekli (örn. BTC/USDT:USDT)' });
  const cs = await getLong2h(symbol, 160);
  if (!cs || cs.length < 20) return res.status(400).json({ ok: false, error: '2h mum verisi yok' });
  const built = buildManualTriangle(symbol, points, atrLast(cs, 14));
  if (built.error) return res.status(400).json({ ok: false, error: built.error });
  ltManual.push(built.tri);
  capArr(ltManual, 50);
  dirty = true; saveState();
  log('MANUEL ÜÇGEN EKLENDİ ' + baseOf(symbol) + ' | apeks ' + new Date(built.tri.apexT).toISOString().slice(5, 16).replace('T', ' '));
  res.json({ ok: true, triangle: viewManual(built.tri), manual: ltManual.map(viewManual) });
}));

app.delete('/api/lt/manual/:id', (req, res) => {
  const before = ltManual.length;
  ltManual = ltManual.filter(t => t.id !== req.params.id);
  dirty = true; saveState();
  res.json({ ok: ltManual.length !== before, manual: ltManual.map(viewManual) });
});

app.get('/api/chart', wrap(async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  if (!symbol.includes('/')) return res.status(400).json({ ok: false, error: 'sembol gerekli' });
  const tf = TF_MS[req.query.tf] ? String(req.query.tf) : '2h';
  const limit = clamp(Math.round(num(req.query.limit, 200)), 30, 400);
  let cs;
  if (tf === '2h') cs = await getLong2h(symbol, limit);
  else cs = await getCandles(symbol, tf, limit, false);
  if (!cs || !cs.length) return res.status(400).json({ ok: false, error: 'mum verisi yok' });
  const tri = tf === '2h' ? chartTriangles(symbol, cs) : [];
  res.json({
    ok: true, symbol, tf, price: rp(priceOf(symbol, 60000) || cs[cs.length - 1].c),
    candles: cs.map(c => [c.t, rp(c.o), rp(c.h), rp(c.l), rp(c.c), Math.round(c.v)]),
    triangles: tri
  });
}));

/* ───────────────────────────── AI ───────────────────────────── */
app.get('/api/ai/status', (req, res) => res.json({ ok: true, ai: aiStatus(), history: aiHist.slice(-40).reverse() }));

app.post('/api/ai/chat', wrap(async (req, res) => {
  if (!aiReady()) return res.status(400).json({ ok: false, error: 'AI kapalı veya anahtar yok' });
  const msg = cleanText(req.body && req.body.message, 1200);
  if (!msg) return res.status(400).json({ ok: false, error: 'mesaj boş' });
  const sym = String((req.body && req.body.symbol) || '').trim();
  let ctx = 'Aktif modüller: OtoTrade (1m ivme), Trend Scalp (5m), LT Üçgen (2h).\n';
  const st = statsView();
  ctx += 'İstatistik: ' + st.total + ' işlem, ' + st.wins + ' kâr, ' + st.losses + ' zarar, net ' + st.netR + 'R.\n';
  const open = paper.open.concat(LIVE.open);
  if (open.length) ctx += 'Açık pozisyonlar: ' + open.map(p => p.base + ' ' + p.dir + ' @' + p.entry).join(', ') + '\n';
  if (sym) {
    const cs = await getCandles(sym, '15m', 80, true).catch(() => null);
    if (cs) ctx += sym + ' 15m mumlar:\n' + fmtCandles(cs, 16) + '\n';
  }
  const ai = await callAI([
    { role: 'system', content: 'Sen AlphaSon trading asistanısın. Kısa, net, Türkçe konuş. Yatırım tavsiyesi değil; riskleri söyle. En fazla 120 kelime.' },
    { role: 'user', content: ctx + '\nSoru: ' + msg }
  ], { prefer: 'gemini', timeoutMs: 15000 });
  const rec = { kind: 'Sohbet', module: 'AI', decision: 'YANIT', confidence: null, reason: cleanText(ai.text, 400), provider: ai.providerName, model: ai.model };
  aiHistoryAdd(rec);
  res.json({ ok: true, answer: ai.text, provider: ai.providerName, model: ai.model, latencyMs: ai.latencyMs });
}));

/* ───────────────────────────── canlı ───────────────────────────── */
app.get('/api/live/status', wrap(async (req, res) => {
  if (!HAS_KEYS) return res.json({ ok: true, configured: false, error: liveConfigError(), live: liveSummary() });
  const bal = await fetchLiveBalance(true);
  const pos = await fetchLivePositions();
  res.json({ ok: true, configured: true, balance: bal, positions: pos || [], live: liveSummary() });
}));
app.post('/api/live/sync', wrap(async (req, res) => {
  await fetchLiveBalance(true);
  await syncLive();
  res.json({ ok: true, live: liveSummary(), balance: LIVE.balance, positions: LIVE.positions || [] });
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'bilinmeyen uç' });
  res.sendFile(path.join(__dirname, 'index.html'));
});


/* ───────────────────────────── döngüler ───────────────────────────── */
const TIMERS = [];
let startAt = 0;
const busy = { tick: false, auto: false, trend: false, lt: false, mon: false, virt: false, live: false, uni: false };

function every(ms, name, fn) {
  const t = setInterval(() => {
    if (busy[name]) return;
    busy[name] = true;
    Promise.resolve().then(fn).catch(e => logOnce('loop:' + name, 'DÖNGÜ HATASI ' + name + ': ' + redact(e.message), 60e3))
      .finally(() => { busy[name] = false; });
  }, ms);
  TIMERS.push(t);
  return t;
}

async function start() {
  if (startAt) return;
  startAt = Date.now();
  loadState();
  log('AlphaSon ' + VERSION + ' başlıyor | mod ' + settings.tradeMode.toUpperCase() +
    ' | AI ' + (aiReady() ? 'açık' : 'kapalı') + ' | anahtar ' + (HAS_KEYS ? 'var' : 'yok'));

  try { await refreshUniverse(); } catch (e) { log('Evren başlangıç hatası: ' + redact(e.message)); }
  try { await refreshTickers(); } catch (e) { /* sessiz */ }
  READY = true;

  every(2000, 'tick', refreshTickers);
  every(10 * M1, 'uni', refreshUniverse);
  every(1500, 'mon', monitorPositions);
  every(5000, 'virt', monitorVirtual);
  every(2500, 'auto', () => (settings.autoTrade ? autoScan() : null));
  every(60e3, 'trend', () => (settings.trendEnabled ? trendScan() : null));
  every(5 * M1, 'lt', () => (settings.ltEnabled ? ltScan() : null));
  every(10e3, 'live', async () => {
    if (settings.tradeMode === 'live' && HAS_KEYS) { await fetchLiveBalance(); await syncLive(); }
  });
  setInterval(() => { if (settings.ltEnabled && LT_WATCH.length) ltTick().catch(() => {}); }, 10e3);
  setInterval(() => { if (settings.ltEnabled && ltManual.length) ltTick().catch(() => {}); }, 15e3);

  log('Hazır → http://localhost:' + PORT);
}

function stop() {
  for (const t of TIMERS) clearInterval(t);
  TIMERS.length = 0;
  saveState();
}

process.on('SIGINT', () => { log('Kapatılıyor…'); stop(); process.exit(0); });
process.on('SIGTERM', () => { log('Kapatılıyor…'); stop(); process.exit(0); });
process.on('unhandledRejection', e => logOnce('unhandled', 'YAKALANMAMIŞ: ' + redact(e && e.message ? e.message : e), 60e3));

if (require.main === module) {
  const server = app.listen(PORT, () => { start().catch(e => log('BAŞLATMA HATASI: ' + redact(e.message))); });
  server.on('error', e => { log('SUNUCU HATASI: ' + redact(e.message)); process.exit(1); });
}

module.exports = {
  app, start, stop, stateView, statsView, marketView,
  autoScan, trendScan, ltScan, ltTick, monitorPositions, monitorVirtual,
  evaluateImpulse, evaluateTrend, findTriangle, buildManualTriangle,
  addSignal, viewSignal, viewPosition, paperSummary, liveSummary, priceOf,
  get settings() { return settings; },
  get paper() { return paper; },
  get live() { return LIVE; },
  get signals() { return signals; },
  get universe() { return UNIVERSE; }
};
