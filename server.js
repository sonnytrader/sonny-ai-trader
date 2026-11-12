'use strict';
/* ============================================================================
   AlphaSon LT v91.0 — SİMETRİK ÜÇGEN (SYMMETRICAL TRIANGLE) SİNYAL MOTORU
   ----------------------------------------------------------------------------
   Tek strateji: simetrik üçgen.
     • Üst çizgi: en az iki ALÇALAN tepe (lower highs)
     • Alt çizgi: en az iki YÜKSELEN dip (higher lows)
     • İki çizgi sağda APEX noktasında birleşir
     • Kırılım yönü ÖNCEDEN TAHMİN EDİLMEZ; hangi çizgi kapanışla kırılırsa yön odur
     • Kırılımda gövde + hacim teyidi; sadece fitil = sahte kırılım
     • Hedef: üçgenin en geniş yüksekliği, kırılım noktasına eklenir
     • Stop: kırılan çizginin hemen dışı veya son swing dibi/tepesinin ötesi
   Sadece sinyal üretir. Canlı emir, paper cüzdan, çoklu strateji YOKTUR.
============================================================================ */

let express = null, ccxt = null;
try { express = require('express'); } catch (e) { express = null; }
try { ccxt = require('ccxt'); } catch (e) { ccxt = null; }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'v91.6';
const PORT = Number(process.env.PORT) || 3000;
const TEST = process.env.ALPHASON_TEST === '1';

const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1;
const H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '2h': H2, '4h': H4, '1d': D1 };
const LT_TFS = ['15m', '1h', '2h', '4h'];
const LT_BARS = 900;
const EPS = 1e-9;

/* ── Veri klasörü ─────────────────────────────────────────────────────────── */
const DATA_DIR = (() => {
  const want = process.env.ALPHASON_DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(process.env.TEMP || process.env.TMP || __dirname, 'alphason-lt-data');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (_) {}
    return alt;
  }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEC_FILE = path.join(DATA_DIR, 'decisions.jsonl');

/* ── Borsa anahtarları (yalnızca public veri gerekir; özel işlem yok) ─────── */
const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);
const API_TOKEN = String(process.env.ALPHASON_API_TOKEN || '').trim();

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
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const fmtPct = v => (Number(v) >= 0 ? '+' : '') + num(v, 2).toFixed(2) + '%';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));

/* ── Ayarlar ──────────────────────────────────────────────────────────────── */
const DEF_SET = {
  aiEnabled: false,
  haLines: true,
  touchSignals: true,        // son kapanan mumun fitili çizgiye değince de sinyal (manuel kontrol)
  lineStyle: 'tangent',      // 'tangent': en uç fitil → en son değdiği fitil | 'endpoint': en uç fitil → bir önceki mumun fitili
  lineModeOld: 'endpoint',      // 'endpoint': en uç fitilden SON KAPANAN mumun fitil ucuna | 'tangent': fitilleri kesmeyen teğet
  allowFlat: true,           // alçalan / yükselen üçgen (yatay destek veya direnç)
  retestEnabled: true,       // kırılan çizgiye geri test sinyali
  mtfConfirm: true,          // küçük zaman diliminde teyit (4h→1h, 1h/2h→15m)
  minConfirm: 2,             // doğrulayıcı işaret sayısı (hacim, güçlü mum, küçük grafik, ana yön)             // çizgiler Heikin Ashi fitillerine göre (TradingView HA ile aynı)
  aiGate: true,              // AI açıksa sinyal AI onayından geçer
  ltTfs: ['1h', '2h'],
  topN: 90,
  minQuoteVol: 5e5,
  maxSpreadPct: 0.10,
  includeStocks: false,
  minScore: 55,
  minTouches: 2,
  minSpanBars: 14,
  maxApexBars: 180,
  minMaturity: 0.42,
  maxWidthAtr: 16,
  cooldownMin: 90,
  signalExpiryMin: 120,
  maxSignalsPerSymDay: 3,
  scanSec: 240,
  tickSec: 10,
  minBreakAtr: 0.25,
  minBodyRatio: 0.45,
  minBodyAtr: 0.30,
  minVolRatio: 1.10,
  maxExtAtr: 2.0,
  minStopPct: 0.15,
  maxStopPct: 3.5,
  tp1Frac: 0.55,
  tp2Frac: 1.00,
  minRR1: 0.80,
  aiMinConf: 55,
  aiPerHour: 30,
  aiPerDay: 300
};

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.aiEnabled = s.aiEnabled === true;
  s.aiGate = s.aiGate !== false;
  s.haLines = s.haLines !== false;
  s.touchSignals = s.touchSignals !== false;
  s.lineStyle = s.lineStyle === 'endpoint' ? 'endpoint' : 'tangent';
  s.allowFlat = s.allowFlat !== false;
  s.retestEnabled = s.retestEnabled !== false;
  s.mtfConfirm = s.mtfConfirm !== false;
  s.minConfirm = clamp(Math.round(num(s.minConfirm, DEF_SET.minConfirm)), 0, 4);
  s.includeStocks = s.includeStocks === true;
  s.ltTfs = Array.isArray(s.ltTfs) ? s.ltTfs.filter(t => LT_TFS.includes(t)) : DEF_SET.ltTfs.slice();
  if (!s.ltTfs.length) s.ltTfs = DEF_SET.ltTfs.slice();
  s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 10, 300);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 5e4, 1e9);
  s.maxSpreadPct = clamp(num(s.maxSpreadPct, DEF_SET.maxSpreadPct), 0.01, 1);
  s.minScore = clamp(Math.round(num(s.minScore, DEF_SET.minScore)), 0, 100);
  s.minTouches = clamp(Math.round(num(s.minTouches, DEF_SET.minTouches)), 2, 6);
  s.minSpanBars = clamp(Math.round(num(s.minSpanBars, DEF_SET.minSpanBars)), 6, 80);
  s.maxApexBars = clamp(Math.round(num(s.maxApexBars, DEF_SET.maxApexBars)), 20, 400);
  s.minMaturity = clamp(num(s.minMaturity, DEF_SET.minMaturity), 0.1, 0.95);
  s.maxWidthAtr = clamp(num(s.maxWidthAtr, DEF_SET.maxWidthAtr), 2, 60);
  s.cooldownMin = clamp(Math.round(num(s.cooldownMin, DEF_SET.cooldownMin)), 5, 1440);
  s.signalExpiryMin = clamp(Math.round(num(s.signalExpiryMin, DEF_SET.signalExpiryMin)), 15, 1440);
  s.maxSignalsPerSymDay = clamp(Math.round(num(s.maxSignalsPerSymDay, DEF_SET.maxSignalsPerSymDay)), 1, 20);
  s.scanSec = clamp(Math.round(num(s.scanSec, DEF_SET.scanSec)), 60, 1800);
  s.tickSec = clamp(Math.round(num(s.tickSec, DEF_SET.tickSec)), 5, 120);
  s.minBreakAtr = clamp(num(s.minBreakAtr, DEF_SET.minBreakAtr), 0.05, 2);
  s.minBodyRatio = clamp(num(s.minBodyRatio, DEF_SET.minBodyRatio), 0.05, 0.95);
  s.minBodyAtr = clamp(num(s.minBodyAtr, DEF_SET.minBodyAtr), 0.05, 2);
  s.minVolRatio = clamp(num(s.minVolRatio, DEF_SET.minVolRatio), 0.5, 4);
  s.maxExtAtr = clamp(num(s.maxExtAtr, DEF_SET.maxExtAtr), 0.3, 6);
  s.minStopPct = clamp(num(s.minStopPct, DEF_SET.minStopPct), 0.05, 1);
  s.maxStopPct = clamp(num(s.maxStopPct, DEF_SET.maxStopPct), 0.5, 10);
  s.tp1Frac = clamp(num(s.tp1Frac, DEF_SET.tp1Frac), 0.2, 0.95);
  s.tp2Frac = clamp(num(s.tp2Frac, DEF_SET.tp2Frac), 0.5, 2.5);
  s.minRR1 = clamp(num(s.minRR1, DEF_SET.minRR1), 0.2, 3);
  s.aiMinConf = clamp(Math.round(num(s.aiMinConf, DEF_SET.aiMinConf)), 0, 100);
  s.aiPerHour = clamp(Math.round(num(s.aiPerHour, DEF_SET.aiPerHour)), 1, 200);
  s.aiPerDay = clamp(Math.round(num(s.aiPerDay, DEF_SET.aiPerDay)), 10, 5000);
  return s;
}

/* ── Çalışma durumu ───────────────────────────────────────────────────────── */
let settings = sanitizeSettings({});
let signals = [];
let WATCH = [];
let SCAN_META = { at: 0, tookMs: 0, scanned: 0, triangles: 0, errors: 0, running: false };
let READY = false;
let dirty = false;
let seq = 0;
const FIRED = new Map();      // symbol|tf|dir -> ts
const DAYCOUNT = new Map();   // symbol|day -> count
const LAST_TICK = new Map();

let market = {
  dir: 'NOTR', score: 50, btc: null, eth: null, breadth: 0.5,
  why: 'veri bekleniyor', at: 0, source: 'Matematik'
};
let aiMarketBrief = null;

/* ── AI sağlayıcıları ─────────────────────────────────────────────────────── */
const envLimit = (id, d) => { const n = Number(process.env['AI_LIMIT_' + id]); return Number.isFinite(n) && n > 0 ? n : d; };
const mkProv = o => Object.assign({
  ok: 0, fail: 0, invalid: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {},
  discoverAt: 0, dayKey: '', dayCount: 0, lat: [], nextAt: 0
}, o);

const AI_PROV = [
  mkProv({
    id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    nativeBase: 'https://generativelanguage.googleapis.com/v1beta',
    key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
    models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
    prefer: 1, dayLimit: envLimit('GEMINI', 420)
  }),
  mkProv({
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com',
    key: process.env.DEEPSEEK_API_KEY || '',
    models: ['deepseek-chat'], prefer: 2, dayLimit: envLimit('DEEPSEEK', 3000)
  }),
  mkProv({
    id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_API_KEY || '',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    prefer: 3, dayLimit: envLimit('GROQ', 900)
  }),
  mkProv({
    id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1',
    key: process.env.OPENAI_API_KEY || '',
    models: ['gpt-4o-mini', 'gpt-4.1-mini'],
    prefer: 5, dayLimit: envLimit('OPENAI', 2000)
  })
];

const AI_CFG = { timeoutMs: 45000, gapMs: 900, modules: ['LT'] };
const AI_HIST = [];
const AI_STATE = { busy: false, lastAt: 0, lastError: null };
const AI_DISCOVER = { running: false, at: 0, results: {}, error: null };
const AI_USAGE = {
  dayKey: dayKey(), dayCount: 0,
  hourKey: Math.floor(Date.now() / H1), hourCount: 0,
  lastAt: 0, lastError: null
};

/* ── Loglar ───────────────────────────────────────────────────────────────── */
const LOGS = [];
const LOG_ONCE = new Map();
function log(msg) {
  const row = { t: Date.now(), m: String(msg) };
  LOGS.push(row);
  if (LOGS.length > 400) LOGS.splice(0, LOGS.length - 400);
  try { console.log('[' + new Date(row.t).toISOString().slice(11, 19) + '] ' + row.m); } catch (e) {}
}
function logOnce(key, msg, ms) {
  const now = Date.now();
  const last = LOG_ONCE.get(key) || 0;
  if (now - last < (ms || 5 * M1)) return;
  LOG_ONCE.set(key, now);
  log(msg);
}
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/(AIza[0-9A-Za-z_-]{6})[0-9A-Za-z_-]+/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .slice(0, 400);
}
function appendDecision(o) {
  try { fs.appendFileSync(DEC_FILE, JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n'); } catch (e) {}
}

/* ── Kalıcılık ────────────────────────────────────────────────────────────── */
function safeSignals(a) {
  if (!Array.isArray(a)) return [];
  return a.filter(s => s && typeof s === 'object' && s.id && s.symbol && s.tf)
    .slice(-300)
    .map(s => {
      s.tracking = s.tracking || { maxPct: 0, minPct: 0, lastPx: s.entry || 0, lastAt: 0 };
      return s;
    });
}
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    if (j.settings) settings = sanitizeSettings(j.settings);
    if (Array.isArray(j.signals)) signals = safeSignals(j.signals);
    if (j.aiUsage && j.aiUsage.dayKey === dayKey()) {
      AI_USAGE.dayKey = j.aiUsage.dayKey;
      AI_USAGE.dayCount = num(j.aiUsage.dayCount, 0);
      AI_USAGE.hourKey = num(j.aiUsage.hourKey, Math.floor(Date.now() / H1));
      AI_USAGE.hourCount = num(j.aiUsage.hourCount, 0);
    }
    if (Array.isArray(j.aiHist)) AI_HIST.push.apply(AI_HIST, j.aiHist.slice(-80));
    if (j.marketBrief && typeof j.marketBrief === 'object') aiMarketBrief = j.marketBrief;
    log('Durum yüklendi: ' + signals.length + ' sinyal, ' + signals.filter(s => s.status === 'AKTIF').length + ' açık');
  } catch (e) {
    log('Durum yüklenemedi: ' + redact(e.message));
  }
}
function saveState(force) {
  if (!force && !dirty) return;
  dirty = false;
  try {
    const tmp = STATE_FILE + '.tmp';
    const body = {
      version: VERSION, at: Date.now(), settings, signals: signals.slice(-300),
      aiUsage: { dayKey: AI_USAGE.dayKey, dayCount: AI_USAGE.dayCount, hourKey: AI_USAGE.hourKey, hourCount: AI_USAGE.hourCount },
      aiHist: AI_HIST.slice(-80), marketBrief: aiMarketBrief
    };
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    logOnce('savefail', 'Durum kaydedilemedi: ' + redact(e.message), 10 * M1);
  }
}

/* ── Matematik / indikatörler ─────────────────────────────────────────────── */
function emaArr(vals, len) {
  const out = [];
  if (!vals || !vals.length || len <= 0) return out;
  const k = 2 / (len + 1);
  let e = Number(vals[0]);
  out.push(e);
  for (let i = 1; i < vals.length; i++) {
    e = Number(vals[i]) * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function emaLast(vals, len) { const a = emaArr(vals, len); return a.length ? a[a.length - 1] : null; }
function rsiLast(closes, len) {
  if (!closes || closes.length <= len) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - len; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / len) / (loss / len);
  return 100 - 100 / (1 + rs);
}
function atrArr(cs, len) {
  const out = [];
  if (!cs || cs.length < 2) return out;
  const L = Math.max(2, len || 14);
  let prev = null;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    prev = prev == null ? tr : (prev * (L - 1) + tr) / L;
    out.push(prev);
  }
  return out;
}
function atrLast(cs, len) { const a = atrArr(cs, len); return a.length ? a[a.length - 1] : 0; }
function bodyRatio(c) { const r = c.h - c.l; return r > 0 ? Math.abs(c.c - c.o) / r : 0; }
function bodyAtr(c, atr) { return atr > 0 ? Math.abs(c.c - c.o) / atr : 0; }
function closesOf(cs) { return (cs || []).map(c => c.c); }
function toC(a) {
  return { t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0 };
}
/* Kapanmış mumlar: son mumun kapanış zamanı geçmişse onu da al. */
function closedCandles(cs, tfMs) {
  const now = Date.now();
  const out = [];
  for (const c of cs || []) {
    if (c.t + tfMs <= now + 1000) out.push(c);
  }
  return out;
}
function aggTF(cs, factor) {
  const out = [];
  for (let i = 0; i < cs.length; i += factor) {
    const g = cs.slice(i, i + factor);
    if (!g.length) continue;
    out.push({
      t: g[0].t, o: g[0].o,
      h: Math.max.apply(null, g.map(c => c.h)),
      l: Math.min.apply(null, g.map(c => c.l)),
      c: g[g.length - 1].c,
      v: sum(g.map(c => c.v))
    });
  }
  return out;
}
function htfDir(cs) {
  if (!cs || cs.length < 30) return 'YATAY';
  const cl = closesOf(cs);
  const e20 = emaLast(cl, 20), e50 = emaLast(cl, 50), px = cl[cl.length - 1];
  if (e20 == null || e50 == null) return 'YATAY';
  if (px > e20 && e20 > e50) return 'YUKARI';
  if (px < e20 && e20 < e50) return 'AŞAĞI';
  return 'YATAY';
}
function fmtCandles(cs, n) {
  const rows = (cs || []).slice(-n);
  return rows.map(c => {
    const d = new Date(c.t).toISOString().slice(5, 16).replace('T', ' ');
    return d + ' O' + rp(c.o) + ' H' + rp(c.h) + ' L' + rp(c.l) + ' C' + rp(c.c) + ' V' + Math.round(c.v);
  }).join('\n');
}
function quantile(arr, q) {
  const a = (arr || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const p = clamp(q, 0, 1) * (a.length - 1);
  const lo = Math.floor(p), hi = Math.ceil(p);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (p - lo);
}



/* ============================================================================
   BÖLÜM 2 — BORSA, EVREN, TICKER, MUM VERİSİ, PİYASA BAĞLAMI
============================================================================ */

let ex = null;
if (ccxt) {
  try {
    ex = new ccxt.bitget({
      enableRateLimit: true,
      timeout: 25000,
      options: { defaultType: 'swap', adjustForTimeDifference: true }
    });
    if (HAS_KEYS) { ex.apiKey = API_KEY; ex.secret = API_SECRET; ex.password = API_PASS; }
  } catch (e) {
    ex = null;
    log('Borsa başlatılamadı: ' + redact(e.message));
  }
}

const CACHE = new Map();       // sym|tf -> { at, cs }
const INFLIGHT = new Map();    // sym|tf -> Promise
const TICK = new Map();        // sym -> { last, bid, ask, pct, quoteVol, baseVol, at }
const TICK_META = { at: 0, count: 0, error: null, running: false };

const TTL = { '1m': 20e3, '3m': 40e3, '5m': 60e3, '15m': 90e3, '1h': 180e3, '2h': 300e3, '4h': 600e3, '1d': 900e3 };
const ONE_REQ = 300; // tek istekte istenen mum sayısı (Bitget sınırına güvenli mesafe)

const STOCK_BASES = new Set([
  'INTC','MSTR','KORU','SNXX','TSLA','NVDA','AAPL','COIN','HOOD','CRCL','AMZN','GOOGL','MSFT',
  'META','SPY','QQQ','PLTR','AMD','NFLX','BABA','MARA','RIOT','CBRS','TQQQ','BE','CRWV','XAG',
  'SKHYNIX','SKUU','GGLL','IREN','MVLL','NVDL','TSLL','CONL','AAPU','AMZU','SOXL','SOXS',
  'SQQQ','SPXL','SPXS','UPRO','UVXY','TECL','TECS','FNGU','FNGD','LABU','LABD','QID','SDS','TSLQ'
]);
const EXCLUDE_BASES = new Set([
  'USDC','USDT','DAI','FDUSD','TUSD','USDD','PYUSD','EUR','GBP','BUSD',
  'BTC3L','BTC3S','ETH3L','ETH3S','SOL3L','SOL3S','XRP3L','XRP3S'
]);

const FALLBACK = [
  'BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','XRP/USDT:USDT','BNB/USDT:USDT',
  'DOGE/USDT:USDT','ADA/USDT:USDT','AVAX/USDT:USDT','LINK/USDT:USDT','TON/USDT:USDT',
  'SUI/USDT:USDT','APT/USDT:USDT','NEAR/USDT:USDT','ARB/USDT:USDT','OP/USDT:USDT',
  'INJ/USDT:USDT','SEI/USDT:USDT','TIA/USDT:USDT','LTC/USDT:USDT','BCH/USDT:USDT',
  'DOT/USDT:USDT','TRX/USDT:USDT','ATOM/USDT:USDT','FIL/USDT:USDT','ETC/USDT:USDT'
];

let UNIVERSE = FALLBACK.slice();
let UNIVERSE_AT = 0;
let UNIVERSE_ERR = null;

function baseAllowed(m, sym) {
  const b = baseOf(sym);
  if (!b || EXCLUDE_BASES.has(b)) return false;
  if (!settings.includeStocks && STOCK_BASES.has(b)) return false;
  if (m && m.info) {
    const rwa = String(m.info.isRwa || '').toLowerCase();
    if (rwa === 'yes' || rwa === 'true' || rwa === '1') return false;
  }
  return true;
}

async function pool(items, n, fn) {
  const list = (items || []).slice();
  const out = new Array(list.length);
  let idx = 0;
  const workers = new Array(Math.max(1, Math.min(n, list.length))).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      try { out[i] = await fn(list[i], i); }
      catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadMarkets(force) {
  if (!ex) return false;
  try {
    if (!ex.markets || force) await ex.loadMarkets();
    return true;
  } catch (e) {
    logOnce('markets', 'Market listesi alınamadı: ' + redact(e.message), 5 * M1);
    return false;
  }
}

function pickQuoteVol(m) {
  const info = (m && m.info) || {};
  const cands = [
    info.quoteVolume, info.quoteVol, info.usdtVolume, info.turnover24h,
    info.volume24h, info.quoteVolume24h, m && m.quoteVolume
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const baseVol = Number((info.baseVolume != null ? info.baseVolume : (m && m.baseVolume)) || 0);
  const last = Number((m && m.last) || (info.lastPr || info.last) || 0);
  return baseVol > 0 && last > 0 ? baseVol * last : 0;
}

async function refreshUniverse(force) {
  if (!ex) return UNIVERSE;
  if (!force && Date.now() - UNIVERSE_AT < 20 * M1 && UNIVERSE.length > 10) return UNIVERSE;
  const ok = await loadMarkets(force);
  if (!ok) return UNIVERSE;
  let markets = [];
  try { markets = Object.values(ex.markets || {}); } catch (e) { markets = []; }
  const list = markets.filter(m => m && m.swap && m.linear !== false && String(m.quote || '').toUpperCase() === 'USDT' &&
    m.active !== false && m.symbol && baseAllowed(m, m.symbol));
  if (!list.length) return UNIVERSE;
  const scored = list.map(m => ({ sym: m.symbol, vol: pickQuoteVol(m) }))
    .filter(x => x.vol >= settings.minQuoteVol || x.vol === 0)
    .sort((a, b) => b.vol - a.vol);
  const chosen = scored.slice(0, settings.topN).map(x => x.sym);
  if (chosen.length >= 5) {
    UNIVERSE = chosen;
    UNIVERSE_AT = Date.now();
    UNIVERSE_ERR = null;
    log('Evren güncellendi: ' + UNIVERSE.length + ' parite (USDT-M)');
  }
  return UNIVERSE;
}

async function refreshTickers(force) {
  if (!ex || TICK_META.running) return false;
  if (!force && Date.now() - TICK_META.at < 20e3) return true;
  TICK_META.running = true;
  try {
    let t = null;
    try { t = await ex.fetchTickers(); } catch (e) { t = null; }
    if (!t || !Object.keys(t).length) {
      // Yedek: market bilgisindeki son fiyat alanları
      const ms = ex.markets ? Object.values(ex.markets) : [];
      for (const m of ms) {
        if (!m || !m.symbol || !m.swap) continue;
        const last = num(m.last || (m.info && (m.info.lastPr || m.info.last)), 0);
        if (last > 0) {
          TICK.set(m.symbol, {
            last, bid: num(m.bid, last), ask: num(m.ask, last),
            pct: num(m.percentage, 0), quoteVol: pickQuoteVol(m), baseVol: num(m.baseVolume, 0), at: Date.now()
          });
        }
      }
      TICK_META.at = Date.now();
      TICK_META.count = TICK.size;
      TICK_META.error = null;
      return TICK.size > 0;
    }
    for (const sym of Object.keys(t)) {
      const q = t[sym];
      if (!q) continue;
      const last = num(q.last, 0);
      if (!(last > 0)) continue;
      TICK.set(sym, {
        last,
        bid: num(q.bid, last),
        ask: num(q.ask, last),
        pct: num(q.percentage, 0),
        quoteVol: num(q.quoteVolume, 0) || pickQuoteVol({ info: {} }),
        baseVol: num(q.baseVolume, 0),
        at: Date.now()
      });
    }
    TICK_META.at = Date.now();
    TICK_META.count = TICK.size;
    TICK_META.error = null;
    return true;
  } catch (e) {
    TICK_META.error = redact(e.message);
    logOnce('tickers', 'Ticker alınamadı: ' + TICK_META.error, 2 * M1);
    return false;
  } finally {
    TICK_META.running = false;
  }
}

function tickOf(sym) { return TICK.get(sym) || null; }
function priceOf(sym) {
  const t = TICK.get(sym);
  if (t && t.last > 0) return t.last;
  const key = sym + '|1h';
  const c = CACHE.get(key);
  if (c && c.cs && c.cs.length) return c.cs[c.cs.length - 1].c;
  for (const k of CACHE.keys()) {
    if (k.startsWith(sym + '|')) {
      const cc = CACHE.get(k);
      if (cc && cc.cs && cc.cs.length) return cc.cs[cc.cs.length - 1].c;
    }
  }
  return 0;
}
function spreadPct(sym) {
  const t = TICK.get(sym);
  if (!t || !(t.bid > 0) || !(t.ask > 0)) return null;
  return ((t.ask - t.bid) / ((t.ask + t.bid) / 2)) * 100;
}

async function rawOHLCV(sym, tf, limit) {
  if (!ex) throw new Error('borsa bağlantısı yok (ccxt kurulu değil)');
  const want = clamp(Math.round(limit || LT_BARS), 50, 1000);
  let all = [];
  let since = undefined;
  const loops = want > ONE_REQ ? Math.ceil(want / ONE_REQ) : 1;
  for (let i = 0; i < loops; i++) {
    const batchLimit = loops === 1 ? want : ONE_REQ;
    const rows = await ex.fetchOHLCV(sym, tf, since, batchLimit);
    if (!rows || !rows.length) break;
    const cs = rows.map(toC).filter(c => c.t > 0 && c.c > 0);
    if (!cs.length) break;
    if (loops === 1) { all = cs; break; }
    // Geriye doğru toplama: en eski batch'i başa ekle
    all = cs.concat(all);
    since = cs[0].t - batchLimit * (TF_MS[tf] || H1);
    if (cs.length < batchLimit) break;
    await sleep(220);
  }
  if (!all.length) return [];
  const map = new Map();
  for (const c of all) map.set(c.t, c);
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const hit = CACHE.get(key);
  const ttl = TTL[tf] || 60e3;
  if (hit && now - hit.at < ttl && (!limit || hit.cs.length >= Math.min(limit, 200))) return hit.cs;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    try {
      let cs = await rawOHLCV(sym, tf, limit || LT_BARS);
      if (cs.length < 40) {
        await sleep(350);
        cs = await rawOHLCV(sym, tf, limit || LT_BARS);
      }
      if (cs.length) CACHE.set(key, { at: Date.now(), cs });
      return cs;
    } catch (e) {
      if (hit && hit.cs && hit.cs.length) return hit.cs;
      logOnce('ohlcv:' + key, 'Mum alınamadı ' + key + ': ' + redact(e.message), 3 * M1);
      return [];
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, p);
  return p;
}

async function getCandles(sym, tf, limit, closedOnly) {
  const tfMs = TF_MS[tf] || H1;
  const cs = await fetchOHLCV(sym, tf, limit || LT_BARS);
  if (!cs || !cs.length) return [];
  return closedOnly === false ? cs : closedCandles(cs, tfMs);
}

async function getCandlesFor(sym, tf, bars) {
  const want = Math.max(160, bars || LT_BARS);
  const cs = await getCandles(sym, tf, want, true);
  return cs;
}

/* ── Piyasa bağlamı (yalnızca bilgi; yön tahmini değil) ───────────────────── */
async function updateMarket(force) {
  if (!force && Date.now() - market.at < 3 * M1 && market.at) return market;
  try {
    const btc = await getCandles('BTC/USDT:USDT', '1h', 220, true);
    const eth = await getCandles('ETH/USDT:USDT', '1h', 220, true);
    const mk = cs => {
      if (!cs || cs.length < 60) return null;
      const cl = closesOf(cs);
      const e20 = emaLast(cl, 20), e50 = emaLast(cl, 50);
      const px = cl[cl.length - 1];
      const rsi = rsiLast(cl, 14);
      const d1 = cs.length > 25 ? (px / cs[cs.length - 25].c - 1) * 100 : 0;
      return { px: rp(px), e20: rp(e20), e50: rp(e50), rsi: rsi == null ? null : +rsi.toFixed(1), chg24: +d1.toFixed(2), dir: htfDir(cs) };
    };
    market.btc = mk(btc);
    market.eth = mk(eth);
    const top = UNIVERSE.slice(0, 40).map(s => TICK.get(s)).filter(Boolean);
    const pos = top.filter(t => t.pct > 0).length;
    market.breadth = top.length ? +(pos / top.length).toFixed(2) : 0.5;
    let score = 50;
    const b = market.btc, e = market.eth;
    if (b) {
      score += b.dir === 'YUKARI' ? 18 : b.dir === 'AŞAĞI' ? -18 : 0;
      score += b.chg24 > 1 ? 6 : b.chg24 < -1 ? -6 : 0;
    }
    if (e) {
      score += e.dir === 'YUKARI' ? 10 : e.dir === 'AŞAĞI' ? -10 : 0;
      score += e.chg24 > 1.5 ? 4 : e.chg24 < -1.5 ? -4 : 0;
    }
    score += (market.breadth - 0.5) * 24;
    market.score = clamp(Math.round(score), 0, 100);
    market.dir = market.score >= 58 ? 'YUKARI' : market.score <= 42 ? 'AŞAĞI' : 'NOTR';
    const parts = [];
    if (b) parts.push('BTC ' + b.dir + ' (%' + fmtPct(b.chg24) + ', RSI ' + (b.rsi == null ? '?' : b.rsi) + ')');
    if (e) parts.push('ETH ' + e.dir + ' (%' + fmtPct(e.chg24) + ')');
    parts.push('genişlik %' + Math.round(market.breadth * 100) + ' pozitif');
    market.why = parts.join(' Â· ');
    market.at = Date.now();
    market.source = 'Matematik';
  } catch (e) {
    market.why = 'piyasa verisi bekleniyor';
  }
  return market;
}

function marketLine() {
  return 'Piyasa: ' + market.dir + ' (skor ' + market.score + '/100) — ' + market.why;
}

/* ============================================================================
   BÖLÜM 3 — SİMETRİK ÜÇGEN MOTORU
   ----------------------------------------------------------------------------
   Üçgen, pencere içindeki GERÇEK pivotlardan kurulur:
     üst çizgi = iki (veya daha fazla) ALÇALAN tepe
     alt çizgi = iki (veya daha fazla) YÜKSELEN dip
   Global en yüksek/en düşük mum KULLANILMAZ. Çizgiler pivotlara oturur,
   sağa doğru daralır ve APEX'te birleşir.
============================================================================ */

const TRI_WIN = 360;        // analiz penceresi (mum)
const TRI_MAX_LINES = 24;   // her taraftan değerlendirilecek çizgi adayı

function findPivots(cs, left, right) {
  const L = left == null ? 3 : left;
  const R = right == null ? 3 : right;
  const highs = [], lows = [];
  const n = cs ? cs.length : 0;
  if (n < L + R + 5) return { highs, lows };
  for (let i = L; i < n - R; i++) {
    const c = cs[i];
    let isH = true, isL = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      const q = cs[j];
      if (q.h >= c.h - EPS) isH = false;
      if (q.l <= c.l + EPS) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ i, t: c.t, p: c.h, k: 'H' });
    if (isL) lows.push({ i, t: c.t, p: c.l, k: 'L' });
  }
  return { highs, lows };
}

/* Mumların kapanışlarına göre daha az gürültülü zigzag pivotları. */
function zigzagPivots(cs, atr, mult) {
  const n = cs ? cs.length : 0;
  const thr = Math.max((atr || 0) * (mult || 1.2), 1e-9);
  const out = [];
  if (n < 10 || !(thr > 0)) return out;
  let trend = 0, hi = cs[0].h, hiI = 0, lo = cs[0].l, loI = 0;
  for (let i = 1; i < n; i++) {
    const c = cs[i];
    if (trend === 0) {
      if (c.h > hi) { hi = c.h; hiI = i; }
      if (c.l < lo) { lo = c.l; loI = i; }
      if (c.h - lo >= thr && loI < i) { out.push({ i: loI, t: cs[loI].t, p: lo, k: 'L' }); trend = 1; hi = c.h; hiI = i; }
      else if (hi - c.l >= thr && hiI < i) { out.push({ i: hiI, t: cs[hiI].t, p: hi, k: 'H' }); trend = -1; lo = c.l; loI = i; }
    } else if (trend === 1) {
      if (c.h > hi) { hi = c.h; hiI = i; }
      else if (hi - c.l >= thr) { out.push({ i: hiI, t: cs[hiI].t, p: hi, k: 'H' }); trend = -1; lo = c.l; loI = i; }
    } else {
      if (c.l < lo) { lo = c.l; loI = i; }
      else if (c.h - lo >= thr) { out.push({ i: loI, t: cs[loI].t, p: lo, k: 'L' }); trend = 1; hi = c.h; hiI = i; }
    }
  }
  return out;
}

function lineOf(A, B) {
  const m = (B.p - A.p) / Math.max(1, B.i - A.i);
  return { m, b: A.p - m * A.i, a: A, b2: B };
}
function lineAt(L, i) { return L.m * i + L.b; }

/* Aynı türden iki pivotla çizgi adayı üret. */
function collectLines(cs, pts, isHigh, atr, opt) {
  const n = cs.length;
  const lastIdx = n - 1;
  const minPairSpan = Math.max(7, Math.round((opt.minSpanBars || 14) * 0.5));
  const touchTol = (isHigh ? 0.30 : 0.35) * atr;
  const maxSlope = 0.65 * atr;
  const minSlope = 0.010 * atr;
  const out = [];
  const use = (pts || []).filter(p => p.i <= lastIdx - 2 && p.i >= lastIdx - TRI_WIN);
  const maxP = use.length ? Math.max.apply(null, use.map(p => p.p)) : 0;
  const minP = use.length ? Math.min.apply(null, use.map(p => p.p)) : 0;
  const rangeP = Math.max(maxP - minP, atr);
  for (let a = 0; a < use.length - 1; a++) {
    const A = use[a];
    for (let b = a + 1; b < use.length; b++) {
      const B = use[b];
      if (B.i - A.i < minPairSpan) continue;
      const delta = B.p - A.p;
      // Üst çizgi alçalmalı, alt çizgi yükselmeli.
      if (isHigh) { if (delta > -0.05 * atr) continue; }
      else { if (delta < 0.05 * atr) continue; }
      const L = lineOf(A, B);
      const absM = Math.abs(L.m);
      if (absM < minSlope || absM > maxSlope) continue;

      // Çizgi, çapa noktaları arasında ve sonrasında fiyatı sınırlamalı.
      let violClose = 0, violWick = 0, bad = false;
      for (let k = A.i + 1; k <= lastIdx - 2; k++) {
        const v = lineAt(L, k);
        const c = cs[k];
        if (isHigh) {
          if (c.c > v + 0.22 * atr) { violClose++; if (violClose > 1) { bad = true; break; } }
          if (c.h > v + 0.80 * atr) { violWick++; if (violWick > 2) { bad = true; break; } }
        } else {
          if (c.c < v - 0.22 * atr) { violClose++; if (violClose > 1) { bad = true; break; } }
          if (c.l < v - 0.80 * atr) { violWick++; if (violWick > 2) { bad = true; break; } }
        }
      }
      if (bad) continue;

      // Dokunma sayısı: çizgiye oturan aynı tür pivotlar.
      const touches = [];
      for (const p of use) {
        if (p.i < A.i || p.i > lastIdx - 1) continue;
        const d = Math.abs(p.p - lineAt(L, p.i));
        if (d <= touchTol) touches.push(p);
      }
      if (touches.length < 2) continue;
      if (!touches.some(p => p.i === A.i) || !touches.some(p => p.i === B.i)) continue;

      const span = lastIdx - A.i;
      const lastTouch = Math.max.apply(null, touches.map(p => p.i));
      if (lastIdx - lastTouch > Math.max(45, span * 0.62)) continue;

      const prom = (isHigh ? (A.p - minP) : (maxP - A.p)) / rangeP; // 0..1, ana salınım
      const score = touches.length * 10 + Math.min(span, 220) / 10 +
        (B.i / Math.max(1, n)) * 4 + clamp(prom, 0, 1) * 20 - violClose * 10 - violWick * 4;
      out.push({ side: isHigh ? 'H' : 'L', m: L.m, b: L.b, a: A, b2: B, touches, span, violClose, violWick, score });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, TRI_MAX_LINES);
}

/* ── Heikin Ashi (TradingView formülü) ─────────────────────────────────── */
function heikinAshi(cs) {
  const out = [];
  let pO = null, pC = null;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const hc = (c.o + c.h + c.l + c.c) / 4;
    const ho = pO == null ? (c.o + c.c) / 2 : (pO + pC) / 2;
    out.push({ t: c.t, o: ho, c: hc, h: Math.max(c.h, ho, hc), l: Math.min(c.l, ho, hc), v: c.v });
    pO = ho; pC = hc;
  }
  return out;
}

/* ── TradingView tarzı çizgiler ─────────────────────────────────────────────
   Üst çizgi: penceredeki EN YÜKSEK fitilden başlar, sonraki tüm tepelere teğet
   (hiçbir fitili kesmeden) alçalarak gider. Alt çizgi: EN DÜŞÜK fitilden başlar,
   sonraki tüm diplere teğet yükselir; son kapanan mumun fitiline kadar uzanır. */
const TRI_ANCHOR_WINS = [360, 240, 160, 100];

function majorAnchors(hs, isHigh, endIdx) {
  const n = hs.length, out = [];
  for (const w of TRI_ANCHOR_WINS) {
    const from = Math.max(0, n - w);
    let bi = -1, bp = 0;
    for (let k = from; k <= endIdx - 5; k++) {
      const p = isHigh ? hs[k].h : hs[k].l;
      if (bi < 0 || (isHigh ? p > bp : p < bp)) { bi = k; bp = p; }
    }
    if (bi >= 0 && !out.some(a => a.i === bi)) out.push({ i: bi, t: hs[bi].t, p: bp, k: isHigh ? 'H' : 'L' });
  }
  return out;
}

function extremeAfter(hs, isHigh, from, to) {
  let bi = -1, bp = 0;
  for (let k = Math.max(0, from); k <= to; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    if (bi < 0 || (isHigh ? p > bp : p < bp)) { bi = k; bp = p; }
  }
  return bi >= 0 ? { i: bi, t: hs[bi].t, p: bp, k: isHigh ? 'H' : 'L' } : null;
}

function tangentLine(hs, A, endIdx, isHigh, atr, opt) {
  const minGap = Math.max(5, Math.round((opt.minSpanBars || 14) * 0.35));
  if (endIdx - A.i < minGap) return null;
  let ext = isHigh ? -Infinity : Infinity;
  for (let k = A.i + minGap; k <= endIdx; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    const sl = (p - A.p) / (k - A.i);
    if (isHigh ? sl > ext : sl < ext) ext = sl;
  }
  if (!Number.isFinite(ext)) return null;
  const tol = 0.12 * atr;
  let P = null;
  for (let k = endIdx; k >= A.i + minGap; k--) {
    const p = isHigh ? hs[k].h : hs[k].l;
    const ln = A.p + ext * (k - A.i);
    if (isHigh ? p >= ln - tol : p <= ln + tol) { P = { i: k, t: hs[k].t, p, k: A.k }; break; }
  }
  if (!P) return null;
  const m = (P.p - A.p) / (P.i - A.i);
  if (isHigh ? !(m < 0) : !(m > 0)) return null;
  const absM = Math.abs(m);
  if (absM < 0.010 * atr || absM > 0.65 * atr) return null;
  const b = A.p - m * A.i;

  const touchTol = 0.25 * atr;
  const touches = [{ i: A.i, t: A.t, p: A.p, k: A.k }];
  for (let k = A.i + 3; k <= endIdx; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    if (Math.abs(p - (m * k + b)) > touchTol) continue;
    let ok = true;
    for (let j = k - 2; j <= k + 2; j++) {
      if (j === k || j < 0 || j > endIdx) continue;
      const q = isHigh ? hs[j].h : hs[j].l;
      if (isHigh ? q > p : q < p) { ok = false; break; }
    }
    if (!ok) continue;
    const last = touches[touches.length - 1];
    if (k - last.i < 3) {
      if (last.i !== A.i && (isHigh ? p > last.p : p < last.p)) touches[touches.length - 1] = { i: k, t: hs[k].t, p, k: A.k };
      continue;
    }
    touches.push({ i: k, t: hs[k].t, p, k: A.k });
  }
  if (!touches.some(x => Math.abs(x.i - P.i) <= 2)) touches.push(P);
  touches.sort((x, y) => x.i - y.i);
  if (touches.length < 2) return null;
  return { side: isHigh ? 'H' : 'L', m, b, a: A, b2: P, touches, span: endIdx - A.i, violClose: 0, violWick: 0, score: touches.length * 10 };
}

/* Kullanıcı çizimi: en uç fitil ucundan SON KAPANAN mumun fitil ucuna (üstte high, altta low). */
function endpointLine(hs, A, endIdx, isHigh, atr, opt) {
  const minGap = Math.max(5, Math.round((opt.minSpanBars || 14) * 0.35));
  const R = endIdx;
  if (R - A.i < minGap) return null;
  const rpz = isHigh ? hs[R].h : hs[R].l;
  const m = (rpz - A.p) / (R - A.i);
  if (isHigh ? !(m < 0) : !(m > 0)) return null;
  const absM = Math.abs(m);
  if (absM < 0.010 * atr || absM > 0.65 * atr) return null;
  const b = A.p - m * A.i;
  // Çok sayıda mumu delip geçen çizgi kabul edilmez.
  let vc = 0, vw = 0;
  for (let k = A.i + 1; k < R; k++) {
    const v = m * k + b, c = hs[k];
    if (isHigh) { if (c.c > v + 0.22 * atr) vc++; if (c.h > v + 0.80 * atr) vw++; }
    else { if (c.c < v - 0.22 * atr) vc++; if (c.l < v - 0.80 * atr) vw++; }
    if (vc > 2 || vw > 3) return null;
  }
  const touchTol = 0.25 * atr;
  const touches = [{ i: A.i, t: A.t, p: A.p, k: A.k }];
  for (let k = A.i + 3; k < R; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    if (Math.abs(p - (m * k + b)) > touchTol) continue;
    let ok = true;
    for (let j = k - 2; j <= k + 2; j++) {
      if (j === k || j < 0 || j > R) continue;
      const q = isHigh ? hs[j].h : hs[j].l;
      if (isHigh ? q > p : q < p) { ok = false; break; }
    }
    if (!ok) continue;
    const last = touches[touches.length - 1];
    if (k - last.i < 3) continue;
    touches.push({ i: k, t: hs[k].t, p, k: A.k });
  }
  const P = { i: R, t: hs[R].t, p: rpz, k: A.k };
  if (R - touches[touches.length - 1].i < 3) touches[touches.length - 1] = P; else touches.push(P);
  if (touches.length < 2) return null;
  return { side: isHigh ? 'H' : 'L', m, b, a: A, b2: P, touches, span: R - A.i, violClose: vc, violWick: vw, score: touches.length * 10 - vc * 4 - vw * 2, endpoint: true };
}

/* Yatay destek/direnç çizgisi (alçalan / yükselen üçgen): en uç fitilden, en az 3 dokunuşla. */
function flatLine(hs, A, endIdx, isHigh, atr, opt) {
  const minGap = Math.max(5, Math.round((opt.minSpanBars || 14) * 0.35));
  if (endIdx - A.i < minGap) return null;
  const tol = 0.30 * atr;
  const isExt = (k, p) => {
    for (let j = k - 2; j <= k + 2; j++) {
      if (j === k || j < 0 || j > endIdx) continue;
      const q = isHigh ? hs[j].h : hs[j].l;
      if (isHigh ? q > p : q < p) return false;
    }
    return true;
  };
  // Seviye en uç fitil (A.p); çizgi, o seviyeye dokunan ilk yerel uçtan başlar.
  let A0 = { i: A.i, t: A.t, p: A.p, k: A.k };
  for (let k = 0; k < A.i; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    if (Math.abs(p - A.p) <= tol && isExt(k, p)) { A0 = { i: k, t: hs[k].t, p, k: A.k }; break; }
  }
  const touches = [A0];
  for (let k = A0.i + 3; k <= endIdx; k++) {
    const p = isHigh ? hs[k].h : hs[k].l;
    if (Math.abs(p - A.p) > tol || !isExt(k, p)) continue;
    const last = touches[touches.length - 1];
    if (k - last.i < 3) {
      if (last.i !== A0.i && (isHigh ? p > last.p : p < last.p)) touches[touches.length - 1] = { i: k, t: hs[k].t, p, k: A.k };
      continue;
    }
    touches.push({ i: k, t: hs[k].t, p, k: A.k });
  }
  if (touches.length < 3) return null;
  let viol = 0;
  for (let k = A0.i + 1; k <= endIdx; k++) {
    const c = hs[k].c;
    if (isHigh ? c > A.p + 0.25 * atr : c < A.p - 0.25 * atr) { viol++; if (viol > 1) return null; }
  }
  const P = touches[touches.length - 1];
  return { side: isHigh ? 'H' : 'L', m: 0, b: A.p, a: A0, b2: P, touches, span: endIdx - A0.i, violClose: viol, violWick: 0, score: touches.length * 10, flat: true };
}

/* Üst ve alt çizgiyi birleştirip simetrik üçgen doğrula. */
function combineTriangle(cs, tf, atr, U, Lo, opt) {
  const n = cs.length, lastIdx = n - 1;
  if (!U || !Lo) return null;
  // Şekil: simetrik (iki çizgi eğimli), alçalan (alt çizgi yatay destek), yükselen (üst çizgi yatay direnç).
  let shape = null;
  if (U.m < 0 && Lo.m > 0 && !U.flat && !Lo.flat) shape = 'SİMETRİK';
  else if (U.m < 0 && !U.flat && Lo.flat) shape = 'ALÇALAN';
  else if (U.flat && Lo.m > 0 && !Lo.flat) shape = 'YÜKSELEN';
  if (!shape) return null;
  const firstIdx = Math.min(U.a.i, Lo.a.i);
  const measureFrom = Math.max(U.a.i, Lo.a.i);
  const spanBars = lastIdx - firstIdx;
  if (spanBars < (opt.minSpanBars || 14)) return null;
  if (Math.abs(U.a.i - Lo.a.i) > Math.max(80, spanBars * 0.95)) return null;

  const apexX = (Lo.b - U.b) / (U.m - Lo.m);
  // Üçgen tamamlanmış olabilir: apex son muma çok yakın (en fazla 2 mum önce) olabilir.
  if (!(apexX > lastIdx - 2)) return null;
  const apexBars = apexX - lastIdx;
  if (apexBars > (opt.maxApexBars || 180)) return null;

  // Çizgiler apex'e kadar kesişmemeli; genişlik ölçümünü kesişmeden önceki mumda bitir.
  const endW = Math.min(lastIdx, Math.max(measureFrom + 1, Math.floor(apexX) - 1));
  let minW = Infinity, maxW = -Infinity, maxWIdx = endW;
  for (let k = measureFrom; k <= endW; k++) {
    const w = lineAt(U, k) - lineAt(Lo, k);
    if (w < minW) minW = w;
    if (w > maxW) { maxW = w; maxWIdx = k; }
  }
  if (!(minW > 0)) return null;

  const widthNow = lineAt(U, endW) - lineAt(Lo, endW);
  if (!(widthNow > 0.02 * atr)) return null;
  const widthStart = lineAt(U, measureFrom) - lineAt(Lo, measureFrom);
  if (!(widthStart > 1.0 * atr)) return null;               // çok yassı üçgen değil
  if (maxW > Math.max(opt.maxWidthAtr || 16, 30) * atr) return null;    // dev kama değil
  const compression = 1 - widthNow / widthStart;
  if (compression < 0.20) return null;

  const maturity = clamp((lastIdx - firstIdx) / Math.max(1, apexX - firstIdx), 0, 1);
  if (maturity < (opt.minMaturity || 0.42)) return null;

  // Simetri: iki çizginin ATR cinsinden eğim büyüklükleri yakın olmalı.
  const uAng = Math.abs(U.m) / atr;
  const lAng = Math.abs(Lo.m) / atr;
  const symmetry = Math.min(uAng, lAng) / Math.max(uAng, lAng);
  if (shape === 'SİMETRİK' && symmetry < 0.30) return null;

  const upperNow = lineAt(U, lastIdx);
  const lowerNow = lineAt(Lo, lastIdx);
  const apexPrice = lineAt(U, apexX);

  // Apex fiyatı, pencerenin fiyat aralığında olmalı.
  let loP = Infinity, hiP = -Infinity;
  for (let k = firstIdx; k <= lastIdx; k++) {
    if (cs[k].l < loP) loP = cs[k].l;
    if (cs[k].h > hiP) hiP = cs[k].h;
  }
  if (!(apexPrice > loP - 3 * atr && apexPrice < hiP + 3 * atr)) return null;

  // Üçgenin içinde kalma ihlalleri (skor için).
  let outH = 0, outL = 0;
  const outEnd = opt.forceBreak ? Math.min(endW - 1, opt.forceBreak.idx - 1) : endW - 1;
  for (let k = measureFrom + 1; k <= outEnd; k++) {
    if (cs[k].h > lineAt(U, k) + 0.85 * atr) outH++;
    if (cs[k].l < lineAt(Lo, k) - 0.85 * atr) outL++;
  }
  if (outH > 2 || outL > 2) return null;

  const last = cs[lastIdx], prev = cs[lastIdx - 1];
  const tH = U.touches.length, tL = Lo.touches.length;
  const touchScore = clamp(tH, 2, 5) + clamp(tL, 2, 5);

  // Kırılım: son 3 kapanmış mum içinde çizgi dışına taşan ilk kapanış.
  let dir = null, brkIdx = -1, brkLine = 0, fakeout = false;
  let upB = false, loB = false;
  const fb = opt.forceBreak || null;   // geri test modu: kırılım mumu dışarıdan verilir
  if (fb) { dir = fb.dir; brkIdx = fb.idx; brkLine = lineAt(fb.dir === 'LONG' ? U : Lo, fb.idx); }
  for (let k = Math.max(lastIdx - 2, firstIdx + 1); !fb && k <= lastIdx; k++) {
    const u = lineAt(U, k), l = lineAt(Lo, k);
    if (cs[k].c > u + (opt.minBreakAtr || 0.25) * atr) { upB = true; dir = 'LONG'; brkIdx = k; brkLine = u; break; }
    if (cs[k].c < l - (opt.minBreakAtr || 0.25) * atr) { loB = true; dir = 'SHORT'; brkIdx = k; brkLine = l; break; }
  }
  let d = dir === 'LONG' ? 1 : dir === 'SHORT' ? -1 : 0;

  // Kırılım kapanışı sonrası üçgenin içine dönüş = sahte kırılım.
  // Fikir, çizginin çizildiği grafikteki KAPANIŞLA biter: kapanış çizginin içine dönerse sahte kırılım.
  let retest = null, retestOk = false;
  if (!fb) {
    if (d === 1 && last.c < upperNow - 0.45 * atr) fakeout = true;
    if (d === -1 && last.c > lowerNow + 0.45 * atr) fakeout = true;
  } else {
    for (let k = brkIdx + 1; k <= lastIdx; k++) {
      const ln = lineAt(d === 1 ? U : Lo, k);
      if ((cs[k].c - ln) * d < -0.10 * atr) fakeout = true;
    }
    // Geri test: fiyat kırılan çizgiye geri gelir, FİTİLLE reddedilir, kapanış çizginin doğru tarafında kalır.
    const lnL = d === 1 ? upperNow : lowerNow;
    const rg = last.h - last.l;
    const wickToLine = rg > 0 ? (d === 1 ? (Math.min(last.o, last.c) - last.l) : (last.h - Math.max(last.o, last.c))) / rg : 0;
    const touched = d === 1 ? last.l <= lnL + 0.30 * atr : last.h >= lnL - 0.30 * atr;
    const closedBeyond = (last.c - lnL) * d > 0;
    let away = 0;
    for (let k = brkIdx; k <= lastIdx - 1; k++) {
      const ln = lineAt(d === 1 ? U : Lo, k);
      const ex = d === 1 ? cs[k].h - ln : ln - cs[k].l;
      if (ex > away) away = ex;
    }
    const awayAtr = away / atr;
    retestOk = lastIdx - brkIdx >= 1 && touched && closedBeyond && wickToLine >= 0.40 && awayAtr >= 0.6;
    retest = { wickToLine: +wickToLine.toFixed(2), touched, closedBeyond, awayAtr: +awayAtr.toFixed(2), barsAfter: lastIdx - brkIdx };
  }

  let brkC = brkIdx >= 0 ? cs[brkIdx] : null;
  let bodyR = brkC ? bodyRatio(brkC) : 0;
  let bodyA = brkC ? bodyAtr(brkC, atr) : 0;
  const vEnd = brkIdx >= 0 ? brkIdx : lastIdx;
  const v20 = avg(cs.slice(Math.max(0, vEnd - 20), vEnd).map(c => c.v));
  let volR = brkC && v20 > 0 ? brkC.v / v20 : 0;
  const rng = brkC ? (brkC.h - brkC.l) : 0;
  let wickAgainst = brkC && rng > 0
    ? (d === 1 ? (brkC.h - Math.max(brkC.o, brkC.c)) / rng : (Math.min(brkC.o, brkC.c) - brkC.l) / rng)
    : 1;
  let extAtr = d ? ((last.c - (fb ? (d === 1 ? upperNow : lowerNow) : brkLine)) * d) / atr : 0;
  let breakoutAgo = brkIdx >= 0 ? lastIdx - brkIdx : 99;

  let breakOk = false, reject = null;
  if (!d) reject = 'KIRILIM YOK';
  else if (fakeout) reject = 'ÜÇGEN İÇİNE DÖNDÜ';
  else if (!fb && breakoutAgo > 2) reject = 'KIRILIM ESKİ';
  else if (bodyR < (opt.minBodyRatio || 0.45)) reject = 'GÖVDE ZAYIF';
  else if (bodyA < (opt.minBodyAtr || 0.30)) reject = 'GÖVDE/ATR ZAYIF';
  else if (volR < (opt.minVolRatio || 1.10)) reject = 'HACİM YOK';
  else if (extAtr < (fb ? 0 : (opt.minBreakAtr || 0.25))) reject = 'ÇİZGİ DIŞINDA DEĞİL';
  else if (extAtr > (opt.maxExtAtr || 2.0)) reject = 'FİYAT KAÇTI';
  else if (!fb && wickAgainst > 0.55) reject = 'FİTİL BASKIN';
  else if (fb && !retestOk) reject = 'GERİ TEST YOK';
  else breakOk = true;
  // DOKUNUŞ: son kapanan mumun fitil ucu çizgiye değdi (kapanış kırılımı olmasa da) → manuel kontrol için sinyal.
  let touchMode = false;
  if (!breakOk && !fb && !fakeout && opt.touchSignals !== false && spanBars >= Math.max(30, opt.minSpanBars || 14)) {
    const tip = opt.lastTip || last;
    const uLn = lineAt(U, lastIdx), lLn = lineAt(Lo, lastIdx), tolT = 0.10 * atr;
    const tU = tip.h >= uLn - tolT, tLo = tip.l <= lLn + tolT;
    if (tU !== tLo && !(d !== 0 && (d === 1) !== tU)) {
      touchMode = true;
      dir = tU ? 'LONG' : 'SHORT'; d = tU ? 1 : -1;
      brkIdx = lastIdx; brkLine = tU ? uLn : lLn;
      breakOk = true; reject = null;
      brkC = last; bodyR = bodyRatio(last); bodyA = bodyAtr(last, atr);
      const v20t = avg(cs.slice(Math.max(0, lastIdx - 20), lastIdx).map(c => c.v));
      volR = v20t > 0 ? last.v / v20t : 0;
      const rg2 = last.h - last.l;
      wickAgainst = rg2 > 0 ? (d === 1 ? (last.h - Math.max(last.o, last.c)) / rg2 : (Math.min(last.o, last.c) - last.l) / rg2) : 1;
      extAtr = ((last.c - brkLine) * d) / atr;
      breakoutAgo = 0;
    }
  }
  if (fb) brkLine = d === 1 ? upperNow : lowerNow;   // hedef/stop çizginin güncel değerinden ölçülür

  // Dik çizgi (Murphy): çok dik çizgi hızı sürdüremez, çabuk kırılır → skor düşer.
  const steep = Math.max(uAng, lAng) > 0.30;
  const strongCandle = fb ? !!(retest && retest.wickToLine >= 0.55) : (bodyR >= 0.65 && wickAgainst <= 0.20);

  const px = Number(opt.px) > 0 ? Number(opt.px) : last.c;
  const entry = d ? px : last.c;
  const state = breakOk ? 'KIRILIM' : (d ? 'ZAYIF' : (widthNow < 1.2 * atr ? 'APEX' : 'YAKIN'));
  if (!d && widthNow < 1.2 * atr) reject = 'APEX BEKLİYOR';

  // Stop ve hedefler yalnızca geçerli kırılımda hesaplanır.
  let stop = 0, tp1 = 0, tp2 = 0, riskPct = 0, rr1 = 0, rr2 = 0, stopMode = '';
  if (d) {
    const lineNow = d === 1 ? upperNow : lowerNow;
    const from = Math.max(firstIdx, brkIdx - 45);
    let swing = d === 1 ? Infinity : -Infinity;
    for (let k = from; k <= lastIdx; k++) {
      if (d === 1) swing = Math.min(swing, cs[k].l);
      else swing = Math.max(swing, cs[k].h);
    }
    if (!Number.isFinite(swing)) swing = lineNow;
    const swingStop = d === 1 ? swing - 0.15 * atr : swing + 0.15 * atr;
    const lineStop = d === 1 ? lineNow - 0.30 * atr : lineNow + 0.30 * atr;
    const riskSwingPct = Math.abs(entry - swingStop) / Math.max(entry, 1e-9) * 100;
    const swingValid = (entry - swingStop) * d > 0 && riskSwingPct <= (opt.maxStopPct || 3.5) && Math.abs(entry - swingStop) <= 3.6 * atr;
    stop = swingValid ? swingStop : lineStop;
    stopMode = swingValid ? 'SWING' : 'ÇİZGİ';
    if ((entry - stop) * d <= 0) stop = entry - d * Math.max(0.45 * atr, entry * (opt.minStopPct || 0.15) / 100);
    riskPct = Math.abs(entry - stop) / Math.max(entry, 1e-9) * 100;
    if (riskPct < (opt.minStopPct || 0.15)) {
      stop = entry - d * entry * (opt.minStopPct || 0.15) / 100;
      riskPct = Math.abs(entry - stop) / Math.max(entry, 1e-9) * 100;
    }
    const H = maxW;
    tp1 = brkLine + d * (opt.tp1Frac || 0.55) * H;
    tp2 = brkLine + d * (opt.tp2Frac || 1.0) * H;
    const risk = Math.abs(entry - stop);
    if (risk > 0) {
      // Kırılım noktasından ölçülen hedef, girişin gerisinde kalıyorsa girişten ölç.
      if ((tp1 - entry) * d < 0.9 * risk) tp1 = entry + d * Math.max(0.55 * H, 1.1 * risk);
      if ((tp2 - tp1) * d < 0.5 * risk) tp2 = tp1 + d * Math.max(0.45 * H, 0.9 * risk);
      rr1 = Math.abs(tp1 - entry) / risk;
      rr2 = Math.abs(tp2 - entry) / risk;
    }
  }

  const score = clamp(Math.round(
    24 + (Math.min(tH, 4) + Math.min(tL, 4)) * 3.5 + compression * 10 + maturity * 8 +
    (shape === 'SİMETRİK' ? symmetry : 0.5) * 7 + clamp(spanBars / 100, 0, 1) * 5 + clamp(volR, 0, 2) * 3 -
    (outH + outL) * 4 + (breakOk ? 4 : 0) - (steep ? 6 : 0) + (retest && breakOk ? 3 : 0)
  ), 0, 100);

  return {
    ok: true, tf, atr, n, lastIdx, px, last,
    firstIdx, measureFrom, firstT: cs[firstIdx].t, spanBars,
    upper: { m: U.m, b: U.b, a: U.a, b2: U.b2, flat: !!U.flat },
    lower: { m: Lo.m, b: Lo.b, a: Lo.a, b2: Lo.b2, flat: !!Lo.flat },
    upperNow, lowerNow, apexX, apexIdx: apexX, apexAt: cs[lastIdx].t + Math.round(apexBars) * (TF_MS[tf] || H1),
    apexPrice, apexBars,
    widthStart, widthNow, height: maxW, heightIdx: maxWIdx,
    heightPct: +(maxW / Math.max(entry || last.c, 1e-9) * 100).toFixed(2),
    compression: +compression.toFixed(3), maturity: +maturity.toFixed(3), symmetry: +symmetry.toFixed(3),
    touchesH: tH, touchesL: tL, highPivots: U.touches, lowPivots: Lo.touches,
    outH, outL, shape, score,
    state, dir, brkIdx, brkTime: brkIdx >= 0 ? cs[brkIdx].t : 0, brkLine,
    breakoutAgo, bodyRatio: +bodyR.toFixed(3), bodyAtr: +bodyA.toFixed(3),
    volRatio: +volR.toFixed(2), extAtr: +extAtr.toFixed(2), wickAgainst: +wickAgainst.toFixed(2),
    entry, stop, tp1, tp2, riskPct: +riskPct.toFixed(2), rr1: +rr1.toFixed(2), rr2: +rr2.toFixed(2), stopMode,
    breakOk, reject, fakeout,
    mode: fb ? 'GERİ TEST' : (touchMode ? 'DOKUNUŞ' : 'KIRILIM'), retest, steep, strongCandle,
    upperSlopeAtr: +uAng.toFixed(4), lowerSlopeAtr: +lAng.toFixed(4)
  };
}

/* Bir mum serisinden en iyi simetrik üçgeni bul (TradingView tarzı teğet çizgiler). */
function analyseSymTriangle(cs, tf, opt) {
  opt = Object.assign({}, settings, opt || {});
  if (!cs || cs.length < 100) return null;
  const n = cs.length;
  const win = Math.min(n, TRI_WIN);
  const seg = cs.slice(n - win);
  const hs = (opt.haLines !== false ? heikinAshi(cs) : cs).slice(n - win);
  const atr = atrLast(seg, 14);
  if (!(atr > 0)) return null;
  const lastIdx = seg.length - 1;

  const ctxFrom = Math.max(0, seg.length - 120);
  let hiRef = -Infinity, loRef = Infinity;
  for (let k = ctxFrom; k < seg.length; k++) {
    if (hs[k].h > hiRef) hiRef = hs[k].h;
    if (hs[k].l < loRef) loRef = hs[k].l;
  }

  // cut = çizgi oluşturmada dışarıda bırakılan ilk mum. lastIdx+1: tüm mumlar (kırılım yok).
  // Kırılım varsa çizgi, kırılım mumundan ÖNCEKİ mumlarla çizilir (TradingView'de elle çizilen gibi).
  const cuts = opt.breakOnly ? [lastIdx] : [lastIdx + 1, lastIdx, lastIdx - 1, lastIdx - 2];
  let best = null;
  for (const cut of cuts) {
    const endIdx = cut - 1;
    if (endIdx < 40) continue;
    const aU = majorAnchors(hs, true, endIdx), aL = majorAnchors(hs, false, endIdx);
    for (const a of aU.slice()) {
      const e = extremeAfter(hs, false, a.i + 3, endIdx - 5);
      if (e && !aL.some(x => x.i === e.i)) aL.push(e);
    }
    for (const a of aL.slice()) {
      const e = extremeAfter(hs, true, a.i + 3, endIdx - 5);
      if (e && !aU.some(x => x.i === e.i)) aU.push(e);
    }
    const mk = opt.lineStyle === 'endpoint' ? endpointLine : tangentLine;
    const U = aU.map(a => mk(hs, a, endIdx, true, atr, opt)).filter(Boolean);
    const Lo = aL.map(a => mk(hs, a, endIdx, false, atr, opt)).filter(Boolean);
    if (opt.allowFlat !== false) {
      for (const a of aU) { const f = flatLine(hs, a, endIdx, true, atr, opt); if (f) U.push(f); }
      for (const a of aL) { const f = flatLine(hs, a, endIdx, false, atr, opt); if (f) Lo.push(f); }
    }
    // Dokunuş: son mumun fitili çizgiye değdiyse o çizgi son mumun fitil ucuna kadar çekilir.
    const optT = Object.assign({}, opt, { lastTip: hs[lastIdx] });
    if (cut === lastIdx && opt.touchSignals !== false && !opt.breakOnly) {
      const tolT = 0.10 * atr, lt = hs[lastIdx];
      for (const u of U.slice()) {
        if (u.flat) continue;
        if (lt.h >= lineAt(u, lastIdx) - tolT) { const u2 = endpointLine(hs, u.a, lastIdx, true, atr, opt); if (u2) { u2.tip = true; U.push(u2); } }
      }
      for (const l of Lo.slice()) {
        if (l.flat) continue;
        if (lt.l <= lineAt(l, lastIdx) + tolT) { const l2 = endpointLine(hs, l.a, lastIdx, false, atr, opt); if (l2) { l2.tip = true; Lo.push(l2); } }
      }
    }
    for (const u of U) {
      for (const l of Lo) {
        const t = combineTriangle(seg, tf, atr, u, l, optT);
        if (!t) continue;
        if (opt.breakOnly && !t.breakOk) continue;
        if (cut <= lastIdx) { if (t.brkIdx !== cut) continue; }
        else if (t.dir) continue;
        const bonus = (t.breakOk ? (t.mode === 'DOKUNUŞ' ? 18 : 26) : t.dir ? 6 : (t.state === 'APEX' ? 10 : 0)) + ((u.tip || l.tip) && t.mode === 'DOKUNUŞ' ? 14 : 0);
        const uTop = Math.max.apply(null, u.touches.map(p => p.p));
        const lBot = Math.min.apply(null, l.touches.map(p => p.p));
        const promU = clamp((uTop - (hiRef - 1.5 * atr)) / (1.5 * atr), 0, 1);
        const promL = clamp(((loRef + 1.5 * atr) - lBot) / (1.5 * atr), 0, 1);
        const total = t.score + bonus + (promU + promL) * 12;
        if (!best || total > best.total) { t.total = total; best = t; }
      }
    }
  }
  if ((!best || !best.breakOk) && opt.retestEnabled !== false && !opt.noRetest) {
    const rt = findRetest(cs, tf, opt);
    if (rt) return rt;
  }
  return best;
}

/* Geri test: birkaç mum önce kapanışla kırılmış çizgiye fiyat geri gelip fitille reddedildiyse. */
function findRetest(cs, tf, opt) {
  const n = cs.length;
  const fullWin = Math.min(n, TRI_WIN);
  const seg = cs.slice(n - fullWin);
  const atr = atrLast(seg, 14);
  if (!(atr > 0)) return null;
  for (let j = 1; j <= 24; j++) {
    const subN = n - j;
    if (subN < 100) break;
    const t0 = analyseSymTriangle(cs.slice(0, subN), tf, Object.assign({}, opt, { noRetest: true, breakOnly: true, touchSignals: false }));
    if (!t0 || !t0.breakOk || !t0.dir) continue;
    // alt serinin pencere indekslerini tam serinin penceresine çevir
    const off = (subN - Math.min(subN, TRI_WIN)) - (n - fullWin);
    const sh = L => ({
      m: L.m, b: L.b - L.m * off, flat: !!L.flat,
      a: Object.assign({}, L.a, { i: L.a.i + off }), b2: Object.assign({}, L.b2, { i: L.b2.i + off }),
      touches: L.touches.map(p => Object.assign({}, p, { i: p.i + off }))
    });
    const U2 = sh(Object.assign({}, t0.upper, { touches: t0.highPivots })), L2 = sh(Object.assign({}, t0.lower, { touches: t0.lowPivots }));
    const t = combineTriangle(seg, tf, atr, U2, L2, Object.assign({}, opt, { forceBreak: { idx: t0.brkIdx + off, dir: t0.dir } }));
    if (t && t.breakOk) return t;
  }
  return null;
}

/* Grafik için çizgi noktaları: her çizgi kendi ilk pivotundan APEX'e kadar. */
function triLinePoints(tri, cs, tf) {
  if (!tri || !cs || !cs.length) return { upper: [], lower: [], apex: null };
  const tfMs = TF_MS[tf] || H1;
  const n = cs.length;
  const lastFull = n - 1;
  // analyseSymTriangle indeksleri kendi penceresine (tri.n) göredir; tam seriye kaydır.
  const off = (num(tri.n) > 0 && tri.n <= n) ? n - tri.n : 0;
  const apexI = Math.floor(tri.apexIdx);
  const fullAt = i => cs[Math.min(lastFull, Math.max(0, (i + off)))];
  const timeAt = i => (i <= tri.lastIdx ? fullAt(i).t : cs[lastFull].t + (i - tri.lastIdx) * tfMs);
  const out = { upper: [], lower: [] };
  const uFrom = Math.max(0, Math.round(tri.upper.a.i));
  const lFrom = Math.max(0, Math.round(tri.lower.a.i));
  for (let i = uFrom; i <= apexI; i++) {
    out.upper.push({ time: Math.floor(timeAt(i) / 1000), value: +lineAt(tri.upper, i).toFixed(10) });
  }
  for (let i = lFrom; i <= apexI; i++) {
    out.lower.push({ time: Math.floor(timeAt(i) / 1000), value: +lineAt(tri.lower, i).toFixed(10) });
  }
  const apexMs = tri.apexAt || timeAt(tri.apexIdx);
  const apexTime = Math.floor(apexMs / 1000);
  const apexValue = +tri.apexPrice.toFixed(10);
  const addApex = arr => {
    const p = arr[arr.length - 1];
    if (!p) { arr.push({ time: apexTime, value: apexValue }); return; }
    if (apexTime <= p.time) p.value = apexValue;
    else arr.push({ time: apexTime, value: apexValue });
  };
  addApex(out.upper);
  addApex(out.lower);
  out.apex = { time: apexTime, value: apexValue };
  return out;
}

/* Küçük grafik teyidi: büyük grafikte çizilen çizgiye göre küçük grafik kapanışları kırılım tarafında mı? */
const MTF_MAP = { '15m': '5m', '1h': '15m', '2h': '15m', '4h': '1h' };
async function mtfConfirm(sym, tri) {
  const ltf = MTF_MAP[tri.tf];
  if (!ltf) return { ok: null, tf: null, note: 'küçük grafik yok' };
  const cs = await getCandles(sym, ltf, 80, true);
  if (!cs || cs.length < 20) return { ok: null, tf: ltf, note: 'küçük grafik verisi yok' };
  const d = tri.dir === 'LONG' ? 1 : -1;
  const L = d === 1 ? tri.upper : tri.lower;
  const tfMs = TF_MS[tri.tf] || H1;
  const from = tri.last.t + tfMs;                       // kırılım/geri test mumunun kapanışından sonrası
  const after = cs.filter(c => c.t >= from);
  if (!after.length) return { ok: null, tf: ltf, note: 'henüz kapanmış küçük mum yok' };
  let inside = 0;
  for (const c of after) {
    const ln = lineAt(L, tri.lastIdx + (c.t - tri.last.t) / tfMs);
    if ((c.c - ln) * d < 0) inside++;
  }
  const lastC = after[after.length - 1];
  const lnLast = lineAt(L, tri.lastIdx + (lastC.t - tri.last.t) / tfMs);
  const ok = inside === 0 && (lastC.c - lnLast) * d > 0;
  return { ok, tf: ltf, n: after.length, inside, note: ok ? ltf + ' kapanışları çizginin dışında' : ltf + ' kapanışı çizginin içine döndü' };
}

/* Üçgen özeti (radar / AI için). */
function triSummary(t, sym) {
  return {
    symbol: sym, base: baseOf(sym), tf: t.tf, shape: t.shape, mode: t.mode || 'KIRILIM', score: t.score, state: t.state,
    dir: t.dir || null, upper: rp(t.upperNow), lower: rp(t.lowerNow),
    upperStart: rp(lineAt(t.upper, t.upper.a.i)), lowerStart: rp(lineAt(t.lower, t.lower.a.i)),
    apex: rp(t.apexPrice), apexBars: Math.max(0, Math.round(t.apexBars)), apexAt: t.apexAt,
    widthPct: +((t.upperNow - t.lowerNow) / Math.max(t.px, 1e-9) * 100).toFixed(2),
    heightPct: t.heightPct, touchesH: t.touchesH, touchesL: t.touchesL,
    compression: t.compression, maturity: t.maturity, symmetry: t.symmetry,
    spanBars: t.spanBars, score: t.score, breakOk: t.breakOk, reject: t.reject,
    entry: t.breakOk ? rp(t.entry) : null, stop: t.breakOk ? rp(t.stop) : null,
    tp1: t.breakOk ? rp(t.tp1) : null, tp2: t.breakOk ? rp(t.tp2) : null,
    riskPct: t.breakOk ? t.riskPct : null, rr1: t.breakOk ? t.rr1 : null, rr2: t.breakOk ? t.rr2 : null,
    bodyRatio: t.bodyRatio, bodyAtr: t.bodyAtr, volRatio: t.volRatio, extAtr: t.extAtr,
    upperPivots: t.highPivots.map(p => ({ t: p.t, p: rp(p.p) })),
    lowerPivots: t.lowPivots.map(p => ({ t: p.t, p: rp(p.p) })),
    updatedAt: Date.now()
  };
}

/* ============================================================================
   BÖLÜM 4 — SİNYAL MOTORU, TARAMA, SANAL TAKİP, GRAFİK VERİSİ
============================================================================ */

const AI_Q = [];
let AI_QRUN = false;

function isOpenSignal(s) { return !!s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR'); }
function activeSignals() { return signals.filter(isOpenSignal); }
function symDayKey(sym) { return sym + '|' + dayKey(); }

function canFire(sym, tf, dir) {
  const now = Date.now();
  const key = sym + '|' + tf + '|' + dir;
  const last = FIRED.get(key) || 0;
  if (now - last < settings.cooldownMin * M1) return false;
  // Yeniden başlatmada da soğuma korunur: açık/kapalı sinyallerden türet.
  if (signals.some(s => s.symbol === sym && s.tf === tf && s.dir === dir && now - (s.createdAt || 0) < settings.cooldownMin * M1)) return false;
  if ((DAYCOUNT.get(symDayKey(sym)) || 0) >= settings.maxSignalsPerSymDay) return false;
  const today = dayKey();
  const todayCount = signals.filter(s => s.symbol === sym && dayKey(s.createdAt) === today).length;
  if (todayCount >= settings.maxSignalsPerSymDay) return false;
  if (activeSignals().some(s => s.symbol === sym && s.tf === tf && s.dir === dir)) return false;
  return true;
}
function noteFire(sym, tf, dir) {
  FIRED.set(sym + '|' + tf + '|' + dir, Date.now());
  const k = symDayKey(sym);
  DAYCOUNT.set(k, (DAYCOUNT.get(k) || 0) + 1);
}

const ptsOf = L => ({ a: { t: L.a.t, p: L.m * L.a.i + L.b }, b: { t: L.b2.t, p: L.m * L.b2.i + L.b } });
function triInfo(tri, htf) {
  return {
    upperPts: ptsOf(tri.upper), lowerPts: ptsOf(tri.lower),
    shape: tri.shape,
    upperSlope: tri.upperSlopeAtr, lowerSlope: tri.lowerSlopeAtr,
    upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow),
    widthPct: +((tri.upperNow - tri.lowerNow) / Math.max(tri.px, 1e-9) * 100).toFixed(2),
    height: rp(tri.height), heightPct: tri.heightPct,
    touchesH: tri.touchesH, touchesL: tri.touchesL,
    compression: tri.compression, maturity: tri.maturity, symmetry: tri.symmetry,
    spanBars: tri.spanBars, score: tri.score,
    upperPivots: tri.highPivots.map(p => ({ t: p.t, p: rp(p.p) })),
    lowerPivots: tri.lowPivots.map(p => ({ t: p.t, p: rp(p.p) })),
    upperLine: { t: tri.last.t, p: tri.upperNow },
    lowerLine: { t: tri.last.t, p: tri.lowerNow },
    apexPrice: tri.apexPrice, apexAt: tri.apexAt, apexBars: Math.max(0, tri.apexBars),
    brkTime: tri.brkTime, breakLine: rp(tri.brkLine), breakoutAgo: tri.breakoutAgo,
    bodyRatio: tri.bodyRatio, bodyAtr: tri.bodyAtr, volRatio: tri.volRatio,
    extAtr: tri.extAtr, wickAgainst: tri.wickAgainst, stopMode: tri.stopMode,
    htf: htf || 'YATAY', marketDir: market.dir, marketScore: market.score,
    tf: tri.tf, atr: rp(tri.atr),
    mode: tri.mode || 'KIRILIM', confirms: tri.confirms || [], mtf: tri.mtf || null,
    steep: !!tri.steep, retest: tri.retest || null
  };
}

function makeSignal(sym, tri, htf) {
  const now = Date.now();
  const s = {
    id: 'lt_' + now.toString(36) + '_' + (seq++).toString(36),
    module: 'LT',
    symbol: sym, base: baseOf(sym), tf: tri.tf, dir: tri.dir,
    status: 'AKTIF',
    createdAt: now,
    candleTime: tri.last.t,
    entry: rp(tri.entry), stop: rp(tri.stop), tp1: rp(tri.tp1), tp2: rp(tri.tp2),
    riskPct: tri.riskPct, rr1: tri.rr1, rr2: tri.rr2,
    score: tri.score,
    info: triInfo(tri, htf),
    ai: { state: 'MATEMATIK', note: settings.aiEnabled ? 'AI anahtarı yok / kapalı' : 'AI kapalı — matematik sinyali' },
    tracking: { maxPct: 0, minPct: 0, lastPx: tri.entry, lastAt: now, tp1Hit: false, tp1At: 0 },
    result: null, exit: null, pct: null, closedAt: null, note: null
  };
  if (settings.aiEnabled && settings.aiGate && aiReady() && tri.mode !== 'DOKUNUŞ') {
    s.status = 'AI_BEKLIYOR';
    s.ai = { state: 'BEKLIYOR', note: 'AI üçgen kontrolü sırada' };
  }
  return s;
}

function addSignal(sym, tri, htf) {
  if (!tri || !tri.breakOk || !tri.dir) return null;
  if (!(tri.entry > 0) || !(tri.stop > 0) || !(tri.tp1 > 0) || !(tri.tp2 > 0)) return null;
  if (tri.rr1 < settings.minRR1) return null;
  if (tri.riskPct < settings.minStopPct || tri.riskPct > settings.maxStopPct) return null;
  const d = tri.dir === 'LONG' ? 1 : -1;
  const atr = num(tri.atr, 0);
  // Güncel fiyat hâlâ doğru tarafta ve çok kaçmamış olmalı.
  if (tri.mode === 'KIRILIM' && (tri.entry - tri.brkLine) * d < settings.minBreakAtr * atr) return null;
  if (atr > 0 && Math.abs(tri.entry - tri.brkLine) / atr > settings.maxExtAtr) return null;
  const risk = Math.abs(tri.entry - tri.stop);
  if (!(risk > 0)) return null;
  if ((tri.tp1 - tri.entry) * d <= 0) return null;
  if ((tri.tp2 - tri.entry) * d <= 0) return null;
  if (!canFire(sym, tri.tf, tri.dir)) return null;

  // Ters yönde açık sinyal varsa kapat (kırılım yön değiştirdi).
  for (const old of activeSignals()) {
    if (old.symbol === sym && old.tf === tri.tf && old.dir !== tri.dir) {
      const px = priceOf(sym) || tri.entry;
      closeSignal(old, 'TERS KIRILIM', px, 'Aynı paritede ters yönde yeni kırılım');
    }
  }

  const s = makeSignal(sym, tri, htf);
  signals.push(s);
  if (signals.length > 300) signals.splice(0, signals.length - 300);
  noteFire(sym, tri.tf, tri.dir);
  dirty = true;
  saveState(true);
  log('SİNYAL ' + s.dir + ' ' + sym + ' ' + s.tf + ' | giriş ' + s.entry + ' stop ' + s.stop +
    ' TP1 ' + s.tp1 + ' TP2 ' + s.tp2 + ' | skor ' + s.score + ' | ' + s.ai.state);
  appendDecision({ kind: 'signal', id: s.id, sym, tf: s.tf, dir: s.dir, entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2, score: s.score });
  if (s.status === 'AI_BEKLIYOR') queueAiReview(s);
  return s;
}

function queueAiReview(s) {
  if (!s || s.status !== 'AI_BEKLIYOR') return;
  if (!AI_Q.includes(s.id)) AI_Q.push(s.id);
  runAiQueue();
}
async function runAiQueue() {
  if (AI_QRUN) return;
  AI_QRUN = true;
  try {
    while (AI_Q.length) {
      const id = AI_Q.shift();
      const s = signals.find(x => x.id === id);
      if (!s || s.status !== 'AI_BEKLIYOR') continue;
      try { await reviewSignalAI(s); }
      catch (e) {
        s.ai = { state: 'MATH_ONLY', note: 'AI hatası — matematik sinyali geçerli: ' + redact(e.message), decidedAt: Date.now() };
        s.status = 'AKTIF';
        dirty = true;
        log('AI HATA ' + s.symbol + ': ' + redact(e.message));
      }
      await sleep(600);
    }
  } finally {
    AI_QRUN = false;
  }
}

function closeSignal(s, result, px, note) {
  if (!s || s.status === 'KAPALI') return s;
  const p = Number(px) > 0 ? Number(px) : s.entry;
  const d = s.dir === 'LONG' ? 1 : -1;
  s.status = 'KAPALI';
  s.closedAt = Date.now();
  s.exit = rp(p);
  s.result = result || 'KAPALI';
  s.pct = +(((p - s.entry) / Math.max(s.entry, 1e-9)) * 100 * d).toFixed(2);
  s.note = note || null;
  s.tracking = s.tracking || {};
  s.tracking.lastPx = rp(p);
  s.tracking.lastAt = Date.now();
  dirty = true;
  saveState(true);
  log('KAPANIŞ ' + s.symbol + ' ' + s.dir + ' → ' + s.result + ' | ' + fmtPct(s.pct) + ' | ' + (note || ''));
  appendDecision({ kind: 'close', id: s.id, sym: s.symbol, dir: s.dir, result: s.result, pct: s.pct, entry: s.entry, exit: rp(p) });
  return s;
}

function viewSignal(s) {
  const t = s.tracking || {};
  const px = priceOf(s.symbol) || t.lastPx || s.entry;
  const d = s.dir === 'LONG' ? 1 : -1;
  const nowPct = s.status === 'KAPALI' && s.pct != null ? s.pct : +(((px - s.entry) / Math.max(s.entry, 1e-9)) * 100 * d).toFixed(2);
  return Object.assign({}, s, {
    px: rp(px), nowPct,
    ageMin: Math.max(0, Math.round((Date.now() - s.createdAt) / M1)),
    tracking: Object.assign({}, t, { lastPx: rp(t.lastPx || px), maxPct: +(t.maxPct || 0).toFixed(2), minPct: +(t.minPct || 0).toFixed(2) })
  });
}

/* ── Tarama ───────────────────────────────────────────────────────────────── */
async function ltScan(opts) {
  opts = opts || {};
  if (SCAN_META.running) return { ok: false, busy: true };
  SCAN_META.running = true;
  const t0 = Date.now();
  let triangles = 0, errors = 0, scanned = 0;
  try {
    if (!ex) {
      SCAN_META.at = Date.now();
      SCAN_META.tookMs = Date.now() - t0;
      SCAN_META.errors = 1;
      SCAN_META.running = false;
      return { ok: false, error: 'ccxt/borsa yok — sunucu bağımlılıkları kurulmalı (npm install)' };
    }
    await refreshUniverse();
    await refreshTickers(true);
    await updateMarket();
    const syms = UNIVERSE.slice(0, settings.topN);
    const tfs = settings.ltTfs.slice();
    const jobs = [];
    for (const sym of syms) for (const tf of tfs) jobs.push({ sym, tf });

    const got = await pool(jobs, 6, async job => {
      scanned++;
      try {
        if (!opts.ignoreSpread) {
          const sp = spreadPct(job.sym);
          if (sp != null && sp > settings.maxSpreadPct) return null;
        }
        const cs = await getCandlesFor(job.sym, job.tf, LT_BARS);
        if (!cs || cs.length < 140) return null;
        const px = priceOf(job.sym) || cs[cs.length - 1].c;
        const tri = analyseSymTriangle(cs, job.tf, Object.assign({}, settings, { px }));
        if (!tri) return null;
        triangles++;
        const htf = job.tf === '4h' ? 'YATAY' : htfDir(aggTF(cs, 2));
        return { sym: job.sym, tf: job.tf, tri, htf, px };
      } catch (e) {
        errors++;
        return null;
      }
    });

    const watch = [];
    for (const r of got) {
      if (!r || !r.tri) continue;
      const { sym, tf, tri, htf } = r;
      // Doğrulayıcı işaretler (tek işarete bakılmaz): hacim, güçlü mum, küçük grafik, ana yön.
      if (tri.breakOk && tri.mode === 'DOKUNUŞ') tri.confirms = ['DOKUNUŞ'];
      if (tri.breakOk && tri.mode !== 'DOKUNUŞ' && tri.score >= settings.minScore) {
        const d = tri.dir === 'LONG' ? 1 : -1;
        const conf = [];
        if (tri.volRatio >= 1.5) conf.push('HACİM');
        if (tri.strongCandle) conf.push(tri.mode === 'GERİ TEST' ? 'FİTİL RED' : 'GÜÇLÜ MUM');
        let mtf = { ok: null };
        if (settings.mtfConfirm !== false) {
          try { mtf = await mtfConfirm(sym, tri); } catch (e) { mtf = { ok: null, note: 'hata' }; }
        }
        tri.mtf = mtf;
        if (mtf.ok === true) conf.push('KÜÇÜK GRAFİK');
        if (htf === (d === 1 ? 'YUKARI' : 'AŞAĞI')) conf.push('ANA YÖN');
        tri.confirms = conf;
        if (mtf.ok === false) { tri.breakOk = false; tri.state = 'ZAYIF'; tri.reject = 'KÜÇÜK GRAFİK TERS'; }
        else if (conf.length < settings.minConfirm) { tri.breakOk = false; tri.state = 'ZAYIF'; tri.reject = 'TEYİT YETERSİZ (' + conf.length + '/' + settings.minConfirm + ')'; }
      }
      if (tri.score < Math.max(0, settings.minScore - 15)) continue;
      // Sinyal: yalnızca geçerli kırılım + skor eşiği
      if (tri.breakOk && tri.score >= settings.minScore && tri.mode !== 'DOKUNUŞ') addSignal(sym, tri, htf);
      if (tri.state !== 'KIRILIM' || tri.mode === 'DOKUNUŞ') {
        const w = triSummary(tri, sym);
        const t = TICK.get(sym);
        w.px = rp(r.px);
        w.chg24 = t ? +num(t.pct, 0).toFixed(2) : null;
        w.htf = htf;
        w.marketDir = market.dir;
        watch.push(w);
      }
    }
    watch.sort((a, b) => ((b.mode === 'DOKUNUŞ' ? 1000 : 0) + (b.score || 0)) - ((a.mode === 'DOKUNUŞ' ? 1000 : 0) + (a.score || 0)));
    WATCH = watch.slice(0, 120);

    SCAN_META.at = Date.now();
    SCAN_META.tookMs = Date.now() - t0;
    SCAN_META.scanned = scanned;
    SCAN_META.triangles = triangles;
    SCAN_META.errors = errors;
    log('Tarama bitti: ' + scanned + ' seri, ' + triangles + ' üçgen, radar ' + WATCH.length +
      ', süre ' + (SCAN_META.tookMs / 1000).toFixed(1) + ' sn' + (errors ? ', hata ' + errors : ''));
    return { ok: true, scanned, triangles, watch: WATCH.length, tookMs: SCAN_META.tookMs, errors };
  } catch (e) {
    errors++;
    log('Tarama hatası: ' + redact(e.message));
    return { ok: false, error: redact(e.message) };
  } finally {
    SCAN_META.running = false;
    SCAN_META.errors = errors;
  }
}

/* ── Sanal takip (tick) ───────────────────────────────────────────────────── */
let TICK_RUN = false;
async function ltTick() {
  if (TICK_RUN) return;
  TICK_RUN = true;
  try {
    await refreshTickers();
    const open = activeSignals();
    if (!open.length) return;
    const now = Date.now();
    for (const s of open) {
      const px = priceOf(s.symbol);
      if (!(px > 0)) continue;
      const d = s.dir === 'LONG' ? 1 : -1;
      const pct = ((px - s.entry) / Math.max(s.entry, 1e-9)) * 100 * d;
      s.tracking = s.tracking || { maxPct: 0, minPct: 0, lastPx: px, lastAt: now, tp1Hit: false, tp1At: 0 };
      s.tracking.lastPx = rp(px);
      s.tracking.lastAt = now;
      if (pct > (s.tracking.maxPct || 0)) s.tracking.maxPct = +pct.toFixed(2);
      if (pct < (s.tracking.minPct || 0)) s.tracking.minPct = +pct.toFixed(2);
      dirty = true;

      if (s.status === 'AI_BEKLIYOR') {
        // AI yanıtı gecikirse sinyal matematikle devam eder.
        if (now - s.createdAt > 12 * M1) {
          s.ai = Object.assign({}, s.ai || {}, { state: 'MATH_ONLY', note: 'AI zaman aşımı — matematik sinyali geçerli', decidedAt: now });
          s.status = 'AKTIF';
        }
        continue;
      }
      if (s.status !== 'AKTIF') continue;

      // Fikir, çizginin çizildiği grafikteki KAPANIŞLA biter. Fitil çizgiyi delebilir; kapanış içeri dönerse SAHTE.
      const brk = num(s.info && s.info.breakLine, 0);
      const atr = num(s.info && s.info.atr, 0);
      if (brk > 0 && atr > 0 && !(s.info && s.info.mode === 'DOKUNUŞ')) {
        // acil durum: çizginin 1 ATR ötesine derin dönüş
        if (d === 1 && px < brk - 1.0 * atr) { closeSignal(s, 'SAHTE', px, 'Fiyat kırılan üst çizginin çok altına döndü'); continue; }
        if (d === -1 && px > brk + 1.0 * atr) { closeSignal(s, 'SAHTE', px, 'Fiyat kırılan alt çizginin çok üstüne döndü'); continue; }
        const info = s.info || {};
        const tfMs = TF_MS[s.tf] || H1;
        const base = num(info.chkT, 0) || num(s.candleTime, 0);
        const slopeAtr = d === 1 ? num(info.upperSlope, 0) : num(info.lowerSlope, 0);
        const lineNow0 = d === 1 ? num(info.upperNow, 0) : num(info.lowerNow, 0);
        if (base > 0 && lineNow0 > 0 && now >= base + 2 * tfMs + 5000) {
          let ccs = [];
          try { ccs = await getCandles(s.symbol, s.tf, 12, true); } catch (e) { ccs = []; }
          let closedInside = null;
          for (const c of ccs) {
            if (c.t <= base) continue;
            const ln = lineNow0 + (d === 1 ? -1 : 1) * slopeAtr * atr * ((c.t - num(s.candleTime, 0)) / tfMs);
            info.chkT = c.t;
            if ((c.c - ln) * d < -0.10 * atr) { closedInside = c; break; }
          }
          dirty = true;
          if (closedInside) { closeSignal(s, 'SAHTE', px, 'Kapanış kırılan çizginin içine döndü (' + s.tf + ')'); continue; }
        }
      }

      // Hedefler / stop
      if (d === 1) {
        if (px <= s.stop) { closeSignal(s, s.tracking.tp1Hit ? 'BE' : 'SL', px, 'Stop seviyesi'); continue; }
        if (px >= s.tp2) { closeSignal(s, 'TP2', px, 'Ölçülü hareket hedefi (TP2)'); continue; }
        if (!s.tracking.tp1Hit && px >= s.tp1) {
          s.tracking.tp1Hit = true;
          s.tracking.tp1At = now;
          s.stop = rp(s.entry);
          log('TP1 ' + s.symbol + ' ' + s.dir + ' — stop başabaşa çekildi');
        }
      } else {
        if (px >= s.stop) { closeSignal(s, s.tracking.tp1Hit ? 'BE' : 'SL', px, 'Stop seviyesi'); continue; }
        if (px <= s.tp2) { closeSignal(s, 'TP2', px, 'Ölçülü hareket hedefi (TP2)'); continue; }
        if (!s.tracking.tp1Hit && px <= s.tp1) {
          s.tracking.tp1Hit = true;
          s.tracking.tp1At = now;
          s.stop = rp(s.entry);
          log('TP1 ' + s.symbol + ' ' + s.dir + ' — stop başabaşa çekildi');
        }
      }

      // Süre dolumu
      if (now - s.createdAt > settings.signalExpiryMin * M1) {
        closeSignal(s, 'SÜRE', px, settings.signalExpiryMin + ' dk içinde hedefe ulaşmadı');
      }
    }
  } finally {
    TICK_RUN = false;
  }
}

/* ── İstatistik ───────────────────────────────────────────────────────────── */
function computeStats() {
  const closed = signals.filter(s => s.status === 'KAPALI');
  const open = activeSignals();
  const wins = closed.filter(s => s.result === 'TP2' || s.result === 'TP1' || (s.result === 'BE' && s.tracking && s.tracking.tp1Hit));
  const losses = closed.filter(s => s.result === 'SL');
  const be = closed.filter(s => s.result === 'BE');
  const fake = closed.filter(s => s.result === 'SAHTE');
  const time = closed.filter(s => s.result === 'SÜRE');
  const net = closed.reduce((a, s) => a + num(s.pct, 0), 0);
  const byTf = {};
  for (const s of closed) {
    const k = s.tf || '?';
    byTf[k] = byTf[k] || { n: 0, win: 0, sum: 0 };
    byTf[k].n++;
    byTf[k].sum += num(s.pct, 0);
    if (s.result === 'TP1' || s.result === 'TP2' || (s.result === 'BE' && s.tracking && s.tracking.tp1Hit)) byTf[k].win++;
  }
  for (const k of Object.keys(byTf)) {
    byTf[k].avg = +(byTf[k].sum / Math.max(1, byTf[k].n)).toFixed(2);
    byTf[k].winRate = Math.round(byTf[k].win / Math.max(1, byTf[k].n) * 100);
    byTf[k].sum = +byTf[k].sum.toFixed(2);
  }
  const d1 = Date.now() - D1;
  const last24 = closed.filter(s => (s.closedAt || 0) >= d1);
  return {
    total: signals.length,
    open: open.length,
    closed: closed.length,
    wins: wins.length, losses: losses.length, be: be.length, fake: fake.length, time: time.length,
    winRate: closed.length ? Math.round(wins.length / closed.length * 100) : 0,
    netPct: +net.toFixed(2),
    avgPct: closed.length ? +(net / closed.length).toFixed(2) : 0,
    last24: { n: last24.length, netPct: +last24.reduce((a, s) => a + num(s.pct, 0), 0).toFixed(2) },
    byTf,
    best: closed.slice().sort((a, b) => num(b.pct) - num(a.pct)).slice(0, 5).map(s => ({ symbol: s.symbol, tf: s.tf, dir: s.dir, result: s.result, pct: s.pct }))
  };
}

/* ── Grafik verisi ────────────────────────────────────────────────────────── */
async function chartPayload(req) {
  const sym = String(req.symbol || '').toUpperCase();
  const tf = LT_TFS.includes(req.tf) ? req.tf : '2h';
  if (!sym) return { error: 'symbol gerekli' };
  const all = await getCandles(sym, tf, LT_BARS, false);
  if (!all || all.length < 60) return { error: 'mum verisi yok' };
  const tfMs = TF_MS[tf] || H2;
  const cs = all;
  const closedCs = closedCandles(cs, tfMs);
  let sig = null;
  if (req.id) sig = signals.find(s => s.id === req.id) || null;

  let tri = null, lines = null;
  if (sig && sig.info && sig.info.upperPivots && sig.info.lowerPivots && sig.info.upperPivots.length >= 2 && sig.info.lowerPivots.length >= 2) {
    const i = sig.info;
    const lastIdx = closedCs.length - 1;
    const lastT = closedCs[lastIdx].t;
    let apexAtMs = num(i.apexAt, 0);
    let apexPrice = num(i.apexPrice, 0);
    const havePts = !!(i.upperPts && i.lowerPts && i.upperPts.a && i.upperPts.b && i.lowerPts.a && i.lowerPts.b);
    const uNow0 = num(i.upperNow, 0), lNow0 = num(i.lowerNow, 0);
    const apexBars0 = num(i.apexBars, 0);
    const t0 = num(sig.candleTime, 0) || lastT;
    if (havePts || (apexAtMs > 0 && apexPrice > 0 && uNow0 > 0 && lNow0 > 0 && apexBars0 > 0)) {
      // Taranan çizgiyi birebir yeniden kur. Öncelik: sinyalde saklanan çizgi çapaları.
      const idxF = t => (num(t, lastT) - closedCs[0].t) / tfMs;
      let apexIdx = idxF(apexAtMs);
      const uL = i.upperLine, lL = i.lowerLine;
      const uAnchor = (uL && num(uL.p) > 0 && num(uL.t) > 0) ? { i: idxF(uL.t), p: num(uL.p) } : { i: idxF(t0), p: uNow0 };
      const lAnchor = (lL && num(lL.p) > 0 && num(lL.t) > 0) ? { i: idxF(lL.t), p: num(lL.p) } : { i: idxF(t0), p: lNow0 };
      let mU = (apexPrice - uAnchor.p) / Math.max(1e-9, apexIdx - uAnchor.i);
      let mL = (apexPrice - lAnchor.p) / Math.max(1e-9, apexIdx - lAnchor.i);
      let bU = uAnchor.p - mU * uAnchor.i;
      let bL = lAnchor.p - mL * lAnchor.i;
      if (havePts) {
        // Çizgiler, sinyal anında saklanan kesin iki noktadan (en uç fitil + son mum fitil ucu) yeniden kurulur.
        const pu = i.upperPts, pl = i.lowerPts;
        const ia = idxF(pu.a.t), ib = idxF(pu.b.t), ja = idxF(pl.a.t), jb = idxF(pl.b.t);
        const m1 = Math.abs(ib - ia) > 1e-6 ? (num(pu.b.p) - num(pu.a.p)) / (ib - ia) : 0;
        const m2 = Math.abs(jb - ja) > 1e-6 ? (num(pl.b.p) - num(pl.a.p)) / (jb - ja) : 0;
        if (Math.abs(m1 - m2) > 1e-12) {
          mU = m1; bU = num(pu.a.p) - m1 * ia; mL = m2; bL = num(pl.a.p) - m2 * ja;
          apexIdx = (bL - bU) / (mU - mL); apexPrice = mU * apexIdx + bU; apexAtMs = closedCs[0].t + apexIdx * tfMs;
        }
      }
      const uNow = mU * lastIdx + bU;
      const lNow = mL * lastIdx + bL;
      const idxOf = t => clamp(Math.round(idxF(t)), 0, lastIdx);
      const uA = idxOf(i.upperPivots[0].t);
      const lA = idxOf(i.lowerPivots[0].t);
      const uB = idxOf(i.upperPivots[i.upperPivots.length - 1].t);
      const lB = idxOf(i.lowerPivots[i.lowerPivots.length - 1].t);
      tri = {
        upper: { m: mU, b: bU, a: { i: uA, t: closedCs[uA].t, p: mU * uA + bU }, b2: { i: uB, t: closedCs[uB].t, p: mU * uB + bU } },
        lower: { m: mL, b: bL, a: { i: lA, t: closedCs[lA].t, p: mL * lA + bL }, b2: { i: lB, t: closedCs[lB].t, p: mL * lB + bL } },
        n: closedCs.length,
        firstIdx: Math.min(uA, lA), lastIdx, apexIdx,
        apexAt: apexAtMs, apexPrice,
        apexBars: apexIdx - lastIdx,
        upperNow: uNow, lowerNow: lNow,
        upperSlopeAtr: num(i.upperSlope, 0), lowerSlopeAtr: num(i.lowerSlope, 0),
        highPivots: i.upperPivots.map(p => ({ t: p.t, p: p.p })),
        lowPivots: i.lowerPivots.map(p => ({ t: p.t, p: p.p })),
        shape: (i && i.shape) || 'SİMETRİK', mode: (i && i.mode) || 'KIRILIM',
        score: num(sig.score, 0), state: 'KIRILIM', dir: sig.dir,
        touchesH: num(i.touchesH, 2), touchesL: num(i.touchesL, 2),
        compression: num(i.compression, 0), maturity: num(i.maturity, 0), symmetry: num(i.symmetry, 1),
        px: priceOf(sym) || closedCs[lastIdx].c
      };
    }
  }
  if (!tri) tri = analyseSymTriangle(closedCs, tf, Object.assign({}, settings, { px: priceOf(sym) || closedCs[closedCs.length - 1].c }));
  if (tri) {
    lines = triLinePoints(tri, closedCs, tf);
  }

  // Çizgiler Heikin Ashi fitillerine göre kurulduğu için mumlar da aynı uzayda gösterilir (TradingView HA ile aynı görünüm).
  const useHA = settings.haLines !== false;
  const view = useHA ? heikinAshi(all) : all;
  const candles = view.map(c => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c }));
  const volume = all.map(c => ({ time: Math.floor(c.t / 1000), value: c.v, color: c.c >= c.o ? 'rgba(14,203,129,.45)' : 'rgba(246,70,93,.45)' }));

  const levels = [];
  if (sig) {
    levels.push({ price: sig.entry, title: 'Giriş', color: '#fcd535' });
    levels.push({ price: sig.stop, title: 'Stop', color: '#f6465d' });
    levels.push({ price: sig.tp1, title: 'TP1', color: '#0ecb81' });
    levels.push({ price: sig.tp2, title: 'TP2', color: '#16e394' });
  }

  return {
    ok: true, symbol: sym, tf, at: Date.now(), ha: useHA,
    candles, volume,
    triangle: tri ? {
      shape: tri.shape || 'SİMETRİK', mode: tri.mode || 'KIRILIM',
      upper: lines ? lines.upper : [], lower: lines ? lines.lower : [],
      apex: lines ? lines.apex : null,
      upperPivots: (tri.highPivots || []).map(p => ({ time: Math.floor(p.t / 1000), value: p.p, price: rp(p.p) })),
      lowerPivots: (tri.lowPivots || []).map(p => ({ time: Math.floor(p.t / 1000), value: p.p, price: rp(p.p) })),
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow),
      apexPrice: rp(tri.apexPrice), apexAt: tri.apexAt,
      score: tri.score, state: tri.state, dir: tri.dir || null,
      widthPct: +((tri.upperNow - tri.lowerNow) / Math.max(tri.px || 1, 1e-9) * 100).toFixed(2),
      touchesH: tri.touchesH, touchesL: tri.touchesL,
      compression: tri.compression, maturity: tri.maturity, symmetry: tri.symmetry
    } : null,
    signal: sig ? viewSignal(sig) : null,
    levels
  };
}

/* ============================================================================
   BÖLÜM 5 — AI KATMANI (yalnızca SİMETRİK ÜÇGEN soruları)
============================================================================ */

function aiKeys() { return AI_PROV.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled === true && aiKeys().length > 0); }

function provDay(p) {
  const k = dayKey();
  if (p.dayKey !== k) { p.dayKey = k; p.dayCount = 0; }
  return p;
}
function aiQuota() {
  const k = dayKey();
  const hk = Math.floor(Date.now() / H1);
  if (AI_USAGE.dayKey !== k) { AI_USAGE.dayKey = k; AI_USAGE.dayCount = 0; }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  return {
    ok: AI_USAGE.dayCount < settings.aiPerDay && AI_USAGE.hourCount < settings.aiPerHour,
    dayCount: AI_USAGE.dayCount, dayLimit: settings.aiPerDay,
    hourCount: AI_USAGE.hourCount, hourLimit: settings.aiPerHour
  };
}
function aiReserveBudget() {
  const q = aiQuota();
  if (!q.ok) {
    const er = new Error('AI kotası doldu (saatlik ' + q.hourCount + '/' + q.hourLimit + ', günlük ' + q.dayCount + '/' + q.dayLimit + ')');
    er.status = 402; er.budgetExhausted = true; throw er;
  }
  AI_USAGE.dayCount++;
  AI_USAGE.hourCount++;
  AI_USAGE.lastAt = Date.now();
  return true;
}

function orderedProviders(prefer) {
  return AI_PROV.filter(p => p.key && p.models && p.models.length)
    .sort((a, b) => {
      const pa = prefer && prefer === a.id ? -10 : a.prefer || 9;
      const pb = prefer && prefer === b.id ? -10 : b.prefer || 9;
      return pa - pb;
    });
}

function aiProviderView(p) {
  provDay(p);
  return {
    id: p.id, name: p.name,
    hasKey: !!p.key,
    keyHint: p.key ? (String(p.key).slice(0, 4) + '…' + String(p.key).slice(-3)) : '',
    models: (p.models || []).slice(),
    modelCount: (p.models || []).length,
    ok: p.ok || 0, fail: p.fail || 0, invalid: p.invalid || 0,
    lastError: p.lastError || null,
    cooldownUntil: p.cooldownUntil || 0,
    dayCount: p.dayCount || 0, dayLimit: p.dayLimit || 0,
    lat: p.lat && p.lat.length ? Math.round(avg(p.lat)) : null,
    discoverAt: p.discoverAt || 0
  };
}

function aiStatus() {
  const q = aiQuota();
  return {
    enabled: settings.aiEnabled === true,
    gate: settings.aiGate !== false,
    ready: aiReady(),
    keys: aiKeys().length,
    quota: q,
    busy: AI_STATE.busy,
    lastAt: AI_USAGE.lastAt || 0,
    lastError: AI_USAGE.lastError || null,
    providers: AI_PROV.map(aiProviderView),
    discover: { running: AI_DISCOVER.running, at: AI_DISCOVER.at, error: AI_DISCOVER.error, results: AI_DISCOVER.results }
  };
}

/* ── Hata sınıflandırma ───────────────────────────────────────────────────── */
function isModelError(e) {
  const m = String((e && e.message) || '');
  const st = Number(e && e.status);
  return (st === 404 || st === 400) && /model|not found|does not exist|not supported|no access|unsupported|invalid model/i.test(m);
}
function isQuotaExhausted(e) {
  return /quota|exceeded your current|billing|insufficient|credit|rate limit/i.test(String((e && e.message) || ''));
}
function quotaWaitMs() { return 6 * H1; }
function isTransientAIError(e) {
  const st = Number(e && e.status);
  return !st || st >= 500 || st === 429 || st === 408 || st === 409;
}

/* ── Sağlayıcı çağrıları ──────────────────────────────────────────────────── */
async function callGeminiNative(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const t0 = Date.now();
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
  const contents = messages.filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const url = p.nativeBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(p.key);
  let res = null, txt = '', j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    aiReserveBudget();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), tmo);
    const gc = { temperature: 0.1, maxOutputTokens: 900, responseMimeType: 'application/json' };
    const body = { contents, generationConfig: gc };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    try {
      res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      txt = await res.text();
    } catch (e) {
      if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; }
      throw e;
    } finally { clearTimeout(timer); }
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (res.ok || res.status !== 400 || attempt === 1 || !/thinking/i.test(txt)) break;
  }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 300) || ('HTTP ' + res.status);
    const er = new Error(redact(msg));
    er.status = /api key not valid|api_key_invalid|permission|unauthenticated/i.test(String(msg)) ? 401
      : /not found|not supported|does not exist|no access/i.test(String(msg)) ? 404 : res.status;
    throw er;
  }
  if (j && j.error) { const er = new Error(redact(j.error.message || j.error.status || 'Gemini hatası')); er.status = Number(j.error.code) || 502; throw er; }
  const cand = j && j.candidates && j.candidates[0];
  const c = cand && cand.content && cand.content.parts ? cand.content.parts.map(x => (x && x.text) || '').join('\n') : '';
  if (!c || !String(c).trim()) { const er = new Error('boş yanıt (Gemini: ' + (cand && cand.finishReason ? cand.finishReason : 'boş') + ')'); er.emptyResp = true; throw er; }
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
  if (p.id === 'groq' && /qwen3/.test(model)) extras.reasoning_effort = 'none';
  const oaiReasoning = p.id === 'openai' && /^(o\d|gpt-5)/i.test(model);
  if (oaiReasoning) extras.reasoning_effort = 'low';
  const baseBody = { model, messages, stream: false };
  if (!oaiReasoning) baseBody.temperature = 0.1;
  baseBody[p.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = oaiReasoning ? 2200 : 900;
  let res = null, txt = '', j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    aiReserveBudget();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), tmo);
    try {
      res = await fetch(p.base + '/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
        body: JSON.stringify(Object.assign({}, baseBody, attempt === 0 ? extras : {}))
      });
      txt = await res.text();
    } catch (e) {
      if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; }
      throw e;
    } finally { clearTimeout(timer); }
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (res.ok || res.status !== 400 || attempt === 1 || !Object.keys(extras).length) break;
  }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || txt.slice(0, 300) || ('HTTP ' + res.status);
    const er = new Error(redact(msg)); er.status = res.status;
    const ra = res.headers.get('retry-after');
    if (ra) { const n = Number(ra); er.retryAfterMs = Number.isFinite(n) ? n * 1000 : 60000; }
    throw er;
  }
  if (!j) throw new Error('geçersiz JSON yanıtı');
  if (j.error && !j.choices) { const er = new Error(redact(j.error.message || j.error.code || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
  let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
  if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
  c = c == null ? '' : String(c).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!c) { const er = new Error('boş yanıt (model: ' + model + ')'); er.emptyResp = true; throw er; }
  p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
  return { text: c, model: (j.model || model) };
}

async function callProvider(p, messages, opts) {
  const now = Date.now();
  p.modelCooldowns = p.modelCooldowns || {};
  const usable = (p.models || []).filter(m => !((p.modelCooldowns[m] || 0) > now));
  if (!usable.length) { const er = new Error('tüm modeller soğumada'); er.status = 404; er.allModelsCooldown = true; throw er; }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const at = Math.max(Date.now(), p.nextAt || 0);
        p.nextAt = at + ((opts && opts.fast) ? 400 : AI_CFG.gapMs);
        if (at > Date.now()) await sleep(Math.min(at - Date.now(), 8000));
        const r = await callProviderModel(p, messages, model, opts);
        if (opts && opts.validate && !opts.validate(r.text)) {
          p.invalid = (p.invalid || 0) + 1;
          p.modelCooldowns[model] = Date.now() + 10 * M1;
          lastErr = new Error('geçersiz yanıt (' + p.name + '/' + model + ')'); lastErr.invalid = true;
          logOnce('invalid:' + p.id + model, 'AI GEÇERSİZ YANIT: ' + p.name + '/' + model + ' → şablon/eksik alan', 5 * M1);
          break;
        }
        if (!r.model) r.model = model;
        return r;
      } catch (e) {
        lastErr = e;
        if (e && (e.status === 402 || e.budgetExhausted)) throw e;
        if (isModelError(e)) {
          if ((p.models || []).length > 1) p.models = p.models.filter(m => m !== model);
          else p.modelCooldowns[model] = Date.now() + 30 * M1;
          dirty = true;
          log('AI MODEL YOK: ' + p.name + '/' + model + ' → listeden çıkarıldı | ' + redact(e.message).slice(0, 100));
          break;
        }
        if (e && e.emptyResp) { p.modelCooldowns[model] = Date.now() + 5 * M1; break; }
        if (isQuotaExhausted(e)) { p.modelCooldowns[model] = Date.now() + quotaWaitMs(); break; }
        if (Number(e && e.status) === 429) { p.modelCooldowns[model] = Date.now() + clamp(e.retryAfterMs || 5 * M1, 30000, 6 * H1); break; }
        if (!isTransientAIError(e) || attempt === 1) throw e;
        await sleep(Math.min(4000, 500 * Math.pow(2, attempt) + Math.round(Math.random() * 250)));
      }
    }
  }
  throw lastErr || new Error('sağlayıcı yanıt vermedi');
}

async function callAI(messages, opts) {
  opts = opts || {};
  const q0 = aiQuota();
  if (!q0.ok) throw new Error('AI kotası doldu (saatlik ' + q0.hourCount + '/' + q0.hourLimit + ', günlük ' + q0.dayCount + '/' + q0.dayLimit + ')');
  let lastErr = null;
  for (const p of orderedProviders(opts.prefer)) {
    if ((p.cooldownUntil || 0) > Date.now()) continue;
    if (provDay(p).dayCount >= (p.dayLimit || 1e9)) continue;
    try {
      const t0 = Date.now();
      const r = await callProvider(p, messages, opts);
      p.ok = (p.ok || 0) + 1;
      provDay(p).dayCount++;
      p.lastAt = Date.now(); p.lastError = null;
      AI_USAGE.lastAt = Date.now(); AI_USAGE.lastError = null;
      AI_STATE.lastAt = Date.now(); AI_STATE.lastError = null;
      return Object.assign({ provider: p.id, providerName: p.name, ms: Date.now() - t0 }, r);
    } catch (e) {
      lastErr = e;
      p.fail = (p.fail || 0) + 1;
      p.lastError = redact(e.message);
      AI_USAGE.lastError = redact(e.message);
      AI_STATE.lastError = redact(e.message);
      if (e && (e.status === 401 || e.status === 403)) {
        p.cooldownUntil = Date.now() + 30 * M1;
        logOnce('auth:' + p.id, 'AI ANAHTAR: ' + p.name + ' yetkisiz → 30 dk devre dışı', 30 * M1);
        continue;
      }
      if (e && (e.status === 402 || e.budgetExhausted)) break;
      if (isQuotaExhausted(e)) { p.cooldownUntil = Date.now() + quotaWaitMs(); continue; }
      if (!isTransientAIError(e)) { p.cooldownUntil = Date.now() + 3 * M1; continue; }
    }
  }
  throw lastErr || new Error('hiçbir AI sağlayıcısı yanıt vermedi');
}

/* ── Model keşfi ──────────────────────────────────────────────────────────── */
function looksChatModel(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (/embed|whisper|tts|dall-e|audio|realtime|moderation|image|video|transcribe|rerank/.test(s)) return false;
  if (/gemini/.test(s)) return /gemini/.test(s);
  return true;
}

async function discoverProviderModels(p, opts) {
  if (!p.key) throw new Error('anahtar yok');
  let ids = [];
  if (p.id === 'gemini' && p.nativeBase) {
    const r = await fetch(p.nativeBase + '/models?key=' + encodeURIComponent(p.key), { signal: AbortSignal.timeout(25000) });
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 160));
    const j = JSON.parse(txt);
    ids = (j.models || []).filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''));
  } else {
    const r = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + p.key }, signal: AbortSignal.timeout(25000) });
    const txt = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 160));
    const j = JSON.parse(txt);
    ids = (j.data || j.models || []).map(m => String((m && (m.id || m.name)) || '').replace(/^models\//, ''));
  }
  ids = Array.from(new Set(ids.filter(looksChatModel)));
  // Sıralama: flash/mini/haiku/chat/70b gibi hızlı modeller önce.
  ids.sort((a, b) => {
    const sc = x => (/flash|mini|haiku|instant|chat|70b|8b/i.test(x) ? 0 : /pro|reason|large|405b|120b/i.test(x) ? 2 : 1);
    return sc(a) - sc(b) || a.localeCompare(b);
  });
  if (!ids.length) throw new Error('uygun model bulunamadı');
  p.models = ids.slice(0, 8);
  p.discoverAt = Date.now();
  dirty = true;
  return { ok: true, provider: p.id, count: p.models.length, models: p.models };
}

async function discoverAll(opts) {
  if (AI_DISCOVER.running) return { ok: false, running: true };
  AI_DISCOVER.running = true;
  AI_DISCOVER.error = null;
  AI_DISCOVER.results = {};
  try {
    const list = AI_PROV.filter(p => p.key);
    for (const p of list) {
      try {
        const r = await discoverProviderModels(p, opts);
        AI_DISCOVER.results[p.id] = r;
      } catch (e) {
        AI_DISCOVER.results[p.id] = { ok: false, provider: p.id, error: redact(e.message) };
      }
    }
    AI_DISCOVER.at = Date.now();
    log('AI modelleri keşfedildi: ' + Object.keys(AI_DISCOVER.results).map(k => {
      const r = AI_DISCOVER.results[k];
      return k + (r.ok ? '(' + r.count + ')' : '(hata)');
    }).join(', '));
    return { ok: true, results: AI_DISCOVER.results };
  } finally {
    AI_DISCOVER.running = false;
  }
}

/* ── Simetrik üçgen AI istemi ─────────────────────────────────────────────── */
function promptLT(sig, f) {
  const i = sig.info || {};
  const up = sig.dir === 'LONG';
  const retest = i.mode === 'GERİ TEST';
  const rt = i.retest || {};
  const mtf = i.mtf || {};
  return [
    (i.shape || 'SİMETRİK') + ' ÜÇGEN ' + (retest ? 'GERİ TEST' : 'KIRILIM') + ' KONTROLÜ — ' + sig.base + ' ' + sig.tf + ' ' + sig.dir,
    '',
    'Bu sistem YALNIZCA simetrik üçgen / trend çizgisi kırılımı stratejisi kullanır. Başka strateji SORMA ve ÖNERME.',
    'KURALLAR (eğitim videosundan):',
    '- Çizgi FİTİL UÇLARINDAN çizilir (gövdeden değil); günün bütün fiyat aralığını kapsar, fitiller çizginin içinde kalır. Üst çizgi alçalan tepelerden, alt çizgi yükselen diplerden geçer, sağda APEX\'te birleşir.',
    '- Dokunuş: fiyat çizgiye yaklaşıp döndü ya da fitil çizgiyi biraz deldi ama KAPANIŞ doğru tarafta kaldı. İlk iki nokta da dokunuş sayılır.',
    '- Kırılım KAPANIŞLA sayılır. Fitille taşıp gövdesi içeride kalan mum kırılım değildir. Gövdesi tam, fitilsiz kırılım mumu güçlüdür.',
    '- Çizgi büyük grafikte çizilir; zamanlama küçük grafikte teyit edilir. Küçük grafik kapanışları kırılan çizginin içine dönüyorsa teyit yoktur.',
    '- Tek işarete bakılmaz; doğrulayıcı işaret aranır (hacim, güçlü mum, küçük grafik teyidi, ana yön).',
    '- Geri test: kırılan çizgiye fiyat geri gelir, uzun fitille reddedilir ve kapanış çizginin kırılım tarafında kalırsa güçlü işarettir.',
    '- Çok dik çizgi fiyatın o hızı sürdüremeyeceğini gösterir ve çabuk kırılır; dik çizgide dikkatli ol.',
    '- Fikir, çizginin çizildiği grafikteki kapanışla biter: kapanış çizginin içine dönerse sinyal sahte kabul edilir.',
    '- Şekil ' + (i.shape || 'SİMETRİK') + ': ALÇALAN üçgende alt çizgi yatay destektir, YÜKSELEN üçgende üst çizgi yatay dirençtir; yatay seviye en az 3 dokunuşla geçerlidir ve kapanışla kırılması gerekir.',
    '',
    'KODLA DOĞRULANDI (itiraz etme, yeniden hesaplama):',
    '- Mod: ' + (i.mode || 'KIRILIM') + (retest ? ' (kırılımdan ' + (rt.barsAfter || '?') + ' mum sonra, fitil oranı ' + rt.wickToLine + ', çizgiden uzaklaşma ' + rt.awayAtr + ' ATR)' : ''),
    '- Üst çizgi: ' + i.touchesH + ' dokunuş, eğim ' + i.upperSlope + ' ATR/mum, şu an ' + rp(i.upperNow),
    '- Alt çizgi: ' + i.touchesL + ' dokunuş, eğim ' + i.lowerSlope + ' ATR/mum, şu an ' + rp(i.lowerNow) + (i.steep ? ' | UYARI: çizgi dik' : ''),
    '- Sıkışma %' + Math.round((i.compression || 0) * 100) + ', olgunluk %' + Math.round((i.maturity || 0) * 100) + ', simetri ' + i.symmetry + ', yay ' + i.spanBars + ' mum',
    '- Apex ' + i.apexBars + ' mum sonra, apex fiyatı ' + rp(i.apexPrice) + ', üçgen yüksekliği %' + i.heightPct,
    '- Son kapanış ' + sig.entry + ', kırılan çizgi ' + rp(i.breakLine) + ', çizgi dışına ' + i.extAtr + ' ATR, kırılım yaşı ' + i.breakoutAgo + ' mum',
    '- Kırılım mumu gövde oranı ' + i.bodyRatio + ', gövde/ATR ' + i.bodyAtr + ', hacim oranı ' + i.volRatio + 'x, ters fitil oranı ' + i.wickAgainst,
    '- Doğrulayıcı işaretler: ' + ((i.confirms && i.confirms.length) ? i.confirms.join(', ') : 'yok') + ' | küçük grafik: ' + (mtf.tf ? mtf.tf + ' → ' + (mtf.ok === true ? 'teyitli' : mtf.ok === false ? 'TERS' : 'bekliyor') : 'yok'),
    '- Stop ' + sig.stop + ' (' + (i.stopMode || '?') + '), TP1 ' + sig.tp1 + ', TP2 ' + sig.tp2 + ', R:R ' + sig.rr1 + '/' + sig.rr2,
    '- Ana yön: ' + (i.htf || 'YATAY') + ' | ' + marketLine(),
    '- Sinyal yaşı: ' + Math.round((Date.now() - sig.createdAt) / M1) + ' dk',
    '',
    'Son 12 kapanmış ' + sig.tf + ' mum (en yeni sonda):',
    fmtCandles(f.cs, 12),
    '',
    'Anlık fiyat: ' + rp(f.px) + ' | kırılan çizgiye uzaklık: ' + f.beyondAtr + ' ATR (' + (f.stillBeyond ? 'çizgi dışında' : 'çizgiye döndü') + ')',
    '',
    'AŞAĞIDAKİ SORULARI tek tek yanıtla. Hepsi evet/hayır:',
    '1) symmetric_structure: Çizgiler fitil uçlarından geçen alçalan tepeler / yükselen diplerden mi oluşuyor ve sağda birleşiyor mu? (bariz bozukluk yoksa true)',
    '2) breakout_confirmed: ' + (retest ? 'Kırılım KAPANIŞLA mı oldu ve geri test mumu çizgiyi fitille reddedip çizginin doğru tarafında mı kapandı?' : 'Kırılım mumu çizginin DIŞINDA KAPANIŞLA mı bitti? Sadece fitille taşan / gövdesi içeride kalan kırılım false.'),
    '3) volume_confirmation: Kırılım mumunun hacmi önceki 20 mum ortalamasının belirgin üzerinde mi?',
    '4) fakeout_signs: Kırılım sonrası kapanış üçgenin içine döndü mü, kırılım yönünün tersine aralığın %60+ fitili var mı, ters yönde güçlü engulfing var mı?',
    '5) retest_risk: Fiyat kırılan çizgiden çok uzakta mı (kovalama riski)? ' + (up ? 'Üst çizgi' : 'Alt çizgi') + ' ' + rp(i.breakLine) + ', fiyat ' + rp(f.px) + '. 2 ATR üzeri = true.',
    '6) target_realistic: Ölçülü hareket hedefi (TP2 = kırılım + üçgen yüksekliği) yapıya göre makul mü?',
    '7) direction: Kırılım yönü ' + sig.dir + ' ile grafikte gördüğün kırılım aynı mı?',
    '8) mtf_ok: Küçük grafik (' + (mtf.tf || 'yok') + ') kapanışları kırılım yönünü destekliyor mu? Veri yoksa true yaz.',
    '',
    'KARAR KURALI:',
    '- GIR sadece şu durumda: symmetric_structure true, breakout_confirmed true, volume_confirmation true, fakeout_signs false, direction true, mtf_ok true.',
    '- retest_risk true ise bile fakeout yoksa GIR; ancak reason alanında "geç giriş" uyarısı yaz.',
    '- target_realistic false ise GIRME. Çizgi dik ve doğrulayıcı işaret azsa GIRME.',
    '- Şüphede GIRME. Genel piyasa yönü tek başına GIRME sebebi DEĞİLDİR.',
    '',
    'Yalnızca şu JSON şablonunu döndür (başka metin yok):',
    '{"symmetric_structure":true,"breakout_confirmed":true,"volume_confirmation":true,"fakeout_signs":false,"retest_risk":false,"target_realistic":true,"direction":true,"mtf_ok":true,"decision":"GIR","confidence":75,"reason":"kısa Türkçe gerekçe"}'
  ].join('\n');
}

function parseAiJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let j = null;
  try { j = JSON.parse(s); } catch (e) { j = null; }
  if (!j) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { j = null; } }
  }
  if (!j || typeof j !== 'object') return null;
  return j;
}

function boolish(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'evet', 'yes', '1', 'var'].includes(s)) return true;
    if (['false', 'hayır', 'hayir', 'no', '0', 'yok'].includes(s)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return null;
}

function aiDecision(j, sig) {
  const sym = boolish(j.symmetric_structure);
  const brk = boolish(j.breakout_confirmed);
  const vol = boolish(j.volume_confirmation);
  const fake = boolish(j.fakeout_signs);
  const tgt = boolish(j.target_realistic);
  const dirOk = boolish(j.direction);
  const conf = clamp(Math.round(num(j.confidence, 0)), 0, 100);
  const reasons = [];
  if ([sym, brk, vol, fake, tgt, dirOk].some(v => v == null)) reasons.push('AI yanıtı eksik/geçersiz');
  if (sym === false) reasons.push('üçgen yapısı simetrik değil');
  if (brk === false) reasons.push('kırılım gövdesel değil');
  if (vol === false) reasons.push('hacim teyidi yok');
  if (fake === true) reasons.push('sahte kırılım işareti');
  if (tgt === false) reasons.push('hedef gerçekçi değil');
  if (dirOk === false) reasons.push('yön çelişkisi');
  if (boolish(j.mtf_ok) === false) reasons.push('küçük grafik teyidi yok');
  if (conf <= 0) reasons.push('güven belirtilmedi');
  else if (conf < settings.aiMinConf) reasons.push('güven düşük (' + conf + ')');
  const blocked = reasons.length > 0;
  let decision = String(j.decision || '').toUpperCase();
  if (decision !== 'GIR' && decision !== 'GIRME') decision = blocked ? 'GIRME' : 'GIR';
  if (decision === 'GIR' && blocked) decision = 'GIRME';
  return { decision, conf, sym, brk, vol, fake, tgt, dirOk, reasons, j };
}

async function ltFacts(sig) {
  const i = sig.info || {};
  const cs = await getCandles(sig.symbol, sig.tf, 140, true);
  if (!cs || cs.length < 30) return null;
  const last = cs[cs.length - 1];
  const atr = atrLast(cs, 14) || num(i.atr, 1e-9);
  const px = priceOf(sig.symbol) || last.c;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const v20 = avg(cs.slice(-21, -1).map(c => c.v));
  const rng = last.h - last.l || 1e-9;
  const wickAgainst = d === 1 ? (last.h - Math.max(last.o, last.c)) / rng : (Math.min(last.o, last.c) - last.l) / rng;
  const line = num(i.breakLine, 0);
  return {
    cs, px, atr, d, last,
    beyondAtr: +(((px - line) * d) / atr).toFixed(2),
    stillBeyond: d === 1 ? px > line : px < line,
    wickAgainst: +wickAgainst.toFixed(2),
    breakVolRatio: v20 > 0 ? +(last.v / v20).toFixed(2) : 0,
    htf: i.htf || htfDir(aggTF(cs, 2))
  };
}

async function reviewSignalAI(sig) {
  if (!sig || sig.status === 'KAPALI') return null;
  if (!aiReady()) {
    sig.ai = { state: 'MATH_ONLY', note: settings.aiEnabled ? 'AI anahtarı yok — matematik sinyali' : 'AI kapalı — matematik sinyali', decidedAt: Date.now() };
    if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
    dirty = true;
    return null;
  }
  const f = await ltFacts(sig);
  if (!f) {
    sig.ai = { state: 'MATH_ONLY', note: 'Mum verisi yok — matematik sinyali', decidedAt: Date.now() };
    if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
    dirty = true;
    return null;
  }
  const prompt = promptLT(sig, f);
  const sys = 'Sen yalnızca simetrik üçgen / trend çizgisi kırılımlarını değerlendiren disiplinli bir teknik analistsin. Çizgi fitilden çizilir, kırılım kapanışla sayılır, zamanlama küçük grafikte teyit edilir, tek işarete güvenilmez. ' +
    'Kodun doğruladığı verileri yeniden hesaplama. Sadece sana verilen soruları yanıtla ve geçerli JSON döndür. ' +
    'Şüphede kalırsan GIRME kuralını uygula. Türkçe kısa gerekçe yaz.';
  AI_STATE.busy = true;
  try {
    const r = await callAI([{ role: 'system', content: sys }, { role: 'user', content: prompt }], {
      module: 'LT', timeoutMs: 50000,
      validate: txt => {
        const j = parseAiJson(txt);
        if (!j) return false;
        const need = ['symmetric_structure', 'breakout_confirmed', 'volume_confirmation', 'fakeout_signs', 'target_realistic', 'direction', 'decision', 'confidence'];
        return need.every(k => j[k] != null);
      }
    });
    const j = parseAiJson(r.text);
    if (!j) throw new Error('AI JSON çözülemedi');
    const dec = aiDecision(j, sig);
    const note = String(j.reason || '').slice(0, 400);
    sig.ai = {
      state: dec.decision === 'GIR' ? 'ONAY' : 'RED',
      decision: dec.decision, confidence: dec.conf,
      checks: {
        symmetric_structure: dec.sym, breakout_confirmed: dec.brk, volume_confirmation: dec.vol,
        fakeout_signs: dec.fake, retest_risk: boolish(j.retest_risk), target_realistic: dec.tgt, direction: dec.dirOk, mtf_ok: boolish(j.mtf_ok)
      },
      reason: note, blockers: dec.reasons,
      provider: r.provider, providerName: r.providerName, model: r.model, ms: r.ms,
      decidedAt: Date.now(), raw: String(r.text).slice(0, 1400)
    };
    if (dec.decision === 'GIR') {
      sig.status = 'AKTIF';
      if (!(num(sig.stop) > 0)) sig.status = 'KAPALI';
      log('AI ONAY ' + sig.symbol + ' ' + sig.dir + ' | güven ' + dec.conf + ' | ' + (note || '').slice(0, 90));
    } else {
      sig.status = 'KAPALI';
      sig.closedAt = Date.now();
      sig.exit = sig.entry;
      sig.pct = 0;
      sig.result = 'AI_RED';
      sig.note = 'AI GİRME: ' + (dec.reasons.join(', ') || note || 'uygun değil');
      log('AI RED ' + sig.symbol + ' ' + sig.dir + ' | ' + sig.note.slice(0, 120));
    }
    AI_HIST.push({
      t: Date.now(), id: sig.id, symbol: sig.symbol, tf: sig.tf, dir: sig.dir,
      decision: dec.decision, confidence: dec.conf, reason: note,
      checks: sig.ai.checks, provider: r.providerName, model: r.model, ms: r.ms
    });
    if (AI_HIST.length > 100) AI_HIST.splice(0, AI_HIST.length - 100);
    appendDecision({ kind: 'ai', id: sig.id, sym: sig.symbol, dir: sig.dir, decision: dec.decision, confidence: dec.conf, reason: note, provider: r.provider, model: r.model });
    dirty = true;
    saveState(true);
    return sig.ai;
  } catch (e) {
    sig.ai = { state: 'MATH_ONLY', note: 'AI hatası — matematik sinyali geçerli: ' + redact(e.message), decidedAt: Date.now() };
    if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
    dirty = true;
    logOnce('aireview:' + sig.symbol, 'AI KONTROL HATASI ' + sig.symbol + ': ' + redact(e.message), 12 * M1);
    return sig.ai;
  } finally {
    AI_STATE.busy = false;
  }
}

/* ============================================================================
   BÖLÜM 6 — HTTP API, DÖNGÜLER, BAŞLATMA
============================================================================ */

function apiState() {
  const stats = computeStats();
  return {
    version: VERSION, at: Date.now(), ready: READY,
    settings,
    market,
    counts: {
      open: activeSignals().length,
      aiPending: signals.filter(s => s.status === 'AI_BEKLIYOR').length,
      watch: WATCH.length,
      signals: signals.length,
      closed: signals.filter(s => s.status === 'KAPALI').length
    },
    scan: Object.assign({}, SCAN_META),
    ai: aiStatus(),
    stats,
    universe: UNIVERSE.length,
    universeAt: UNIVERSE_AT,
    universeError: UNIVERSE_ERR,
    tickers: TICK_META,
    tfs: LT_TFS,
    dataDir: DATA_DIR,
    hasExchange: !!ex
  };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const h = fn => (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(e => {
        log('API HATA ' + req.method + ' ' + req.path + ': ' + redact(e.message));
        if (!res.headersSent) res.status(500).json({ ok: false, error: redact(e.message) });
      });
  };

  // Basit token koruması (yalnızca ALPHASON_API_TOKEN tanımlıysa).
  app.use('/api', (req, res, next) => {
    if (!API_TOKEN) return next();
    const t = String(req.get('x-api-token') || req.query.token || '');
    if (t && t === API_TOKEN) return next();
    res.status(401).json({ ok: false, error: 'yetkisiz' });
  });

  app.get('/api/health', h((req, res) => res.json({
    ok: true, version: VERSION, ready: READY, at: Date.now(), exchange: !!ex, ai: aiReady()
  })));

  app.get('/api/state', h((req, res) => res.json(apiState())));

  app.get('/api/signals', h((req, res) => {
    const status = String(req.query.status || '').toUpperCase();
    const tf = String(req.query.tf || '').toLowerCase();
    let list = signals.slice();
    if (tf && LT_TFS.includes(tf)) list = list.filter(s => s.tf === tf);
    let active = list.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt).map(viewSignal);
    let closed = list.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    if (status === 'OPEN') return res.json({ active, closed: [], stats: computeStats() });
    if (status === 'CLOSED') return res.json({ active: [], closed: closed.slice(0, 120).map(viewSignal), stats: computeStats() });
    res.json({ active, closed: closed.slice(0, 120).map(viewSignal), stats: computeStats() });
  }));

  app.get('/api/signals/:id', h((req, res) => {
    const s = signals.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'sinyal bulunamadı' });
    res.json({ ok: true, signal: viewSignal(s) });
  }));

  app.post('/api/signals/:id/close', h((req, res) => {
    const s = signals.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'sinyal bulunamadı' });
    if (s.status === 'KAPALI') return res.json({ ok: true, signal: viewSignal(s), note: 'zaten kapalı' });
    const px = priceOf(s.symbol) || s.entry;
    closeSignal(s, 'MANUEL', px, 'Kullanıcı kapattı');
    res.json({ ok: true, signal: viewSignal(s) });
  }));

  app.post('/api/signals/clear', h((req, res) => {
    const before = signals.length;
    signals = signals.filter(isOpenSignal);
    dirty = true; saveState(true);
    res.json({ ok: true, removed: before - signals.length, remaining: signals.length });
  }));

  app.get('/api/watch', h((req, res) => {
    const tf = String(req.query.tf || '').toLowerCase();
    let list = WATCH.slice();
    if (tf && LT_TFS.includes(tf)) list = list.filter(w => w.tf === tf);
    res.json({ ok: true, at: SCAN_META.at, count: list.length, watch: list, scan: SCAN_META, market });
  }));

  app.get('/api/chart', h(async (req, res) => {
    const p = await chartPayload({
      symbol: req.query.symbol,
      tf: req.query.tf,
      id: req.query.id
    });
    if (p.error) return res.status(400).json({ ok: false, error: p.error });
    res.json(p);
  }));

  app.get('/api/chart/:id', h(async (req, res) => {
    const s = signals.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'sinyal bulunamadı' });
    const p = await chartPayload({ symbol: s.symbol, tf: s.tf, id: s.id });
    if (p.error) return res.status(400).json({ ok: false, error: p.error });
    res.json(p);
  }));

  app.get('/api/stats', h((req, res) => res.json(Object.assign({ ok: true, at: Date.now() }, computeStats()))));

  app.get('/api/logs', h((req, res) => {
    const since = num(req.query.since, 0);
    const list = (since > 0 ? LOGS.filter(l => l.t > since) : LOGS).slice(-200);
    res.json({ ok: true, logs: list, at: Date.now() });
  }));

  app.get('/api/settings', h((req, res) => res.json({ ok: true, settings, tfs: LT_TFS, hasKeys: HAS_KEYS, aiReady: aiReady() })));

  app.post('/api/settings', h((req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const prevTfs = settings.ltTfs.join(',');
    const prevTop = settings.topN;
    settings = sanitizeSettings(Object.assign({}, settings, body));
    dirty = true; saveState(true);
    log('Ayarlar güncellendi');
    if (prevTfs !== settings.ltTfs.join(',') || prevTop !== settings.topN) {
      setTimeout(() => ltScan().catch(() => {}), 800);
    }
    // AI kapatıldıysa bekleyen sinyalleri matematik kararına geçir.
    if (!settings.aiEnabled) {
      for (const s of signals) {
        if (s.status === 'AI_BEKLIYOR') {
          s.status = 'AKTIF';
          s.ai = { state: 'MATH_ONLY', note: 'AI kapatıldı — matematik sinyali', decidedAt: Date.now() };
        }
      }
      dirty = true; saveState(true);
    }
    res.json({ ok: true, settings, ai: aiStatus() });
  }));

  app.post('/api/scan', h(async (req, res) => {
    if (SCAN_META.running) return res.json({ ok: true, running: true, note: 'tarama zaten çalışıyor' });
    const wait = String((req.query.wait || (req.body && req.body.wait) || '')) === '1';
    if (wait) {
      const r = await ltScan();
      return res.json(Object.assign({ ok: !!r.ok }, r, { state: apiState() }));
    }
    ltScan().catch(e => log('Manuel tarama hatası: ' + redact(e.message)));
    res.json({ ok: true, running: true, note: 'tarama başlatıldı; /api/state scan alanını izleyin' });
  }));

  /* ── AI uçları ──────────────────────────────────────────────────────────── */
  app.get('/api/ai/status', h((req, res) => res.json({ ok: true, ai: aiStatus() })));

  app.post('/api/ai/toggle', h((req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') settings.aiEnabled = b.enabled;
    else if (typeof b.aiEnabled === 'boolean') settings.aiEnabled = b.aiEnabled;
    else settings.aiEnabled = !settings.aiEnabled;
    if (typeof b.gate === 'boolean') settings.aiGate = b.gate;
    settings = sanitizeSettings(settings);
    if (!settings.aiEnabled) {
      for (const s of signals) {
        if (s.status === 'AI_BEKLIYOR') {
          s.status = 'AKTIF';
          s.ai = { state: 'MATH_ONLY', note: 'AI kapatıldı — matematik sinyali', decidedAt: Date.now() };
        }
      }
    }
    dirty = true; saveState(true);
    log('AI ' + (settings.aiEnabled ? 'açıldı' : 'kapatıldı'));
    res.json({ ok: true, enabled: settings.aiEnabled, gate: settings.aiGate, ready: aiReady(), ai: aiStatus() });
  }));

  app.get('/api/ai/models', h((req, res) => res.json({
    ok: true, providers: AI_PROV.map(aiProviderView),
    discover: { running: AI_DISCOVER.running, at: AI_DISCOVER.at, error: AI_DISCOVER.error, results: AI_DISCOVER.results }
  })));

  app.post('/api/ai/discover', h((req, res) => {
    if (AI_DISCOVER.running) return res.json({ ok: true, running: true, note: 'keşif zaten çalışıyor' });
    discoverAll().catch(e => {
      AI_DISCOVER.error = redact(e.message);
      log('AI keşif hatası: ' + AI_DISCOVER.error);
    });
    res.json({ ok: true, running: true, note: 'model keşfi başlatıldı; /api/ai/models discover alanını izleyin' });
  }));

  app.get('/api/ai/test', h(async (req, res) => {
    if (!aiKeys().length) return res.status(400).json({ ok: false, error: 'hiçbir sağlayıcıda anahtar yok' });
    try {
      const r = await callAI([
        { role: 'system', content: 'Yalnızca JSON döndür.' },
        { role: 'user', content: 'Sadece şu JSON ile yanıtla: {"ok":true}' }
      ], { timeoutMs: 22000, fast: true, validate: txt => /ok/i.test(String(txt)) });
      res.json({ ok: true, provider: r.providerName, model: r.model, ms: r.ms, text: String(r.text).slice(0, 160) });
    } catch (e) {
      res.status(400).json({ ok: false, error: redact(e.message), ai: aiStatus() });
    }
  }));

  app.get('/api/ai/history', h((req, res) => res.json({ ok: true, items: AI_HIST.slice(-80).reverse() })));

  app.post('/api/ai/reset', h((req, res) => {
    AI_USAGE.dayKey = dayKey(); AI_USAGE.dayCount = 0;
    AI_USAGE.hourKey = Math.floor(Date.now() / H1); AI_USAGE.hourCount = 0;
    AI_USAGE.lastError = null;
    AI_HIST.splice(0, AI_HIST.length);
    for (const p of AI_PROV) {
      p.cooldownUntil = 0; p.modelCooldowns = {}; p.fail = 0; p.invalid = 0; p.lastError = null;
      p.dayKey = dayKey(); p.dayCount = 0;
    }
    dirty = true; saveState(true);
    res.json({ ok: true, ai: aiStatus() });
  }));

  /* ── Statik dosya (yalnızca arayüz; sunucu kodu dışarı verilmez) ────────── */
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'uç yok' });
    res.status(404).send('Bulunamadı');
  });

  return app;
}

/* ── Döngüler ─────────────────────────────────────────────────────────────── */
let SCAN_TIMER = null, TICK_TIMER = null, SAVE_TIMER = null, MKT_TIMER = null;
function startLoops() {
  if (SCAN_TIMER || TICK_TIMER) return;
  SCAN_TIMER = setInterval(() => { ltScan().catch(e => log('Tarama döngü hatası: ' + redact(e.message))); }, settings.scanSec * 1000);
  TICK_TIMER = setInterval(() => { ltTick().catch(e => logOnce('tickerr', 'Tick hatası: ' + redact(e.message), 5 * M1)); }, settings.tickSec * 1000);
  SAVE_TIMER = setInterval(() => saveState(false), 15e3);
  MKT_TIMER = setInterval(() => { updateMarket(true).catch(() => {}); }, 5 * M1);
  for (const t of [SCAN_TIMER, TICK_TIMER, SAVE_TIMER, MKT_TIMER]) { try { t.unref && t.unref(); } catch (e) {} }
  setTimeout(() => { ltScan().catch(() => {}); }, 2500);
  setTimeout(() => { ltTick().catch(() => {}); }, 8000);
  log('Döngüler başladı: tarama ' + settings.scanSec + ' sn, tick ' + settings.tickSec + ' sn');
}
function stopLoops() {
  for (const t of [SCAN_TIMER, TICK_TIMER, SAVE_TIMER, MKT_TIMER]) { try { clearInterval(t); } catch (e) {} }
  SCAN_TIMER = TICK_TIMER = SAVE_TIMER = MKT_TIMER = null;
}

/* ── Başlatma ─────────────────────────────────────────────────────────────── */
function boot() {
  loadState();
  READY = true;
  const server = createApp().listen(PORT, () => {
    log('AlphaSon LT ' + VERSION + ' → http://localhost:' + PORT + ' | ' + settings.ltTfs.join('+') +
      ' | AI ' + (settings.aiEnabled ? (aiReady() ? 'açık' : 'anahtarsız') : 'kapalı'));
  });
  startLoops();
  const shutdown = () => {
    try { stopLoops(); saveState(true); } catch (e) {}
    try { server.close(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', e => logOnce('unhandled', 'Yakalanmayan hata: ' + redact(e && e.message ? e.message : e), 3 * M1));
  return server;
}

if (require.main === module && !TEST) {
  if (!express) {
    console.error('\n[AlphaSon LT] express bulunamadı. Klasörde şunu çalıştırın:\n  npm install\n');
    process.exitCode = 1;
  } else {
    boot();
  }
} else {
  // Test / modül kullanımı: ağ döngüsü başlatılmaz.
  try { loadState(); } catch (e) {}
}

module.exports = {
  VERSION, analyseSymTriangle, findPivots, zigzagPivots, lineOf, lineAt,
  collectLines, endpointLine, flatLine, findRetest, mtfConfirm, heikinAshi, tangentLine, combineTriangle, triLinePoints, triSummary,
  makeSignal, addSignal, closeSignal, computeStats, chartPayload,
  ltScan, ltTick, updateMarket, refreshUniverse, refreshTickers,
  aiStatus, aiReady, callAI, discoverAll, promptLT, aiDecision, parseAiJson,
  getSettings: () => settings, setSettings: o => { settings = sanitizeSettings(Object.assign({}, settings, o)); return settings; },
  getSignals: () => signals, getWatch: () => WATCH, getScan: () => SCAN_META
};
