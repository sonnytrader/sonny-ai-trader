'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v85.5 — AI Tek Yetkili + Kademeli Kâr Kilidi
   PARÇA 1/3: Çekirdek, Ayarlar, İndikatörler, Piyasa, LT Üçgen, Scalp
   ══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const ccxt = require('ccxt');

/* ---- .env yükle ---- */
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
  } catch (e) { }
})();

/* ---- Sabitler ---- */
const VERSION = 'v85.5';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1;
const H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '2h': H2, '4h': H4, '1d': D1 };
const TTL = { '1m': 8e3, '3m': 30e3, '5m': 45e3, '15m': 90e3, '1h': 5 * M1, '2h': 10 * M1, '4h': 15 * M1, '1d': 30 * M1 };
const LT_BARS = 1200;

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(os.tmpdir(), 'alphason-v85');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) { }
    return alt;
  }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEC_FILE = path.join(DATA_DIR, 'decisions.jsonl');

/* ---- API Anahtarları ---- */
const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);

/* ---- AI Sağlayıcıları ---- */
const envLimit = (id, d) => { const n = Number(process.env['AI_LIMIT_' + id]); return Number.isFinite(n) && n > 0 ? n : d; };
const mkProv = o => Object.assign({ ok: 0, fail: 0, invalid: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, discoverAt: 0, dayKey: '', dayCount: 0, lat: [], nextAt: 0 }, o);

const AI_PROV = [
  mkProv({ id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', nativeBase: 'https://generativelanguage.googleapis.com/v1beta', key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'], prefer: 1, dayLimit: envLimit('GEMINI', 420) }),
  mkProv({ id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '', models: ['deepseek-chat'], prefer: 2, dayLimit: envLimit('DEEPSEEK', 3000) }),
  mkProv({ id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], prefer: 3, dayLimit: envLimit('GROQ', 900) }),
  mkProv({ id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY || '', models: ['google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct'], prefer: 4, dayLimit: envLimit('OPENROUTER', 300) }),
  mkProv({ id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '', models: ['gpt-4o-mini', 'gpt-4.1-mini'], prefer: 5, dayLimit: envLimit('OPENAI', 2000) })
];

const AI_USAGE = { dayKey: new Date().toISOString().slice(0, 10), dayCount: 0, hourKey: Math.floor(Date.now() / H1), hourCount: 0, briefDay: new Date().toISOString().slice(0, 10), briefCount: 0 };
const AI_QUEUE = [];
let AI_HIST = [];
const AI_STATE = { busy: false, lastAt: 0, lastError: null };
const AI_DISCOVER = { running: false, at: 0, results: {}, error: null };
const SHADOW = [];
const CHECK_STAT = {};
const AUTO_AI = { hk: 0, count: 0 };

const EX = { FEE: 0.0006, SLIP: 0.0004, H: 0.20, MIN_RR1: 1.00, MIN_RR2: 1.60, MAX_RISK_PCT: 3.5, MIN_RISK_PCT: 0.45 };

/* ---- Modüller ---- */
const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade (Pump/Dump)', tf: '1m', chartTf: '1m', enabled: true, tradeable: true, maxPerDaySym: 10, cooldown: 10 * M1, maxAge: 45 * M1, auto: true },
  PUMP: { key: 'PUMP', label: 'Günlük Hızlı Scalp', tf: '5m', chartTf: '5m', enabled: true, tradeable: true, maxPerDaySym: 4, cooldown: 45 * M1, maxAge: 2 * H1 },
  LT: { key: 'LT', label: 'LT Üçgen', tf: '2h', chartTf: '2h', enabled: true, tradeable: false, maxPerDaySym: 2, cooldown: 3 * H1, maxAge: 18 * H1 }
};
const ACTIVE_MODULES = ['AUTO', 'PUMP', 'LT'];

const SKIP_RESULTS = new Set(['DOLMADI', 'AI_RED', 'AI_ERROR', 'AI_TIMEOUT', 'AI_STALE', 'APPROVAL_EXPIRED', 'SKIP', 'MATH_ONLY']);
const TRADE_RESULTS = new Set(['TP1', 'TP2', 'SL', 'BE', 'TIME', 'MANUEL', 'MOMENTUM', 'FADE', 'ZAYIF_IVME', 'AI_EXIT', 'EXCHANGE']);

const RES = {
  TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL',
  MOMENTUM: 'İVME BİTTİ', FADE: 'KÂR GERİ VERİLDİ', ZAYIF_IVME: 'İVME ZAYIFLADI', DOLMADI: 'DOLMADI', AI_RED: 'AI GİRİLMEZ',
  AI_ERROR: 'AI YANITI YOK', AI_TIMEOUT: 'AI ZAMAN AŞIMI', AI_STALE: 'FİYAT KAÇTI',
  APPROVAL_EXPIRED: 'ONAY VERİLMEDİ', SKIP: 'ATLANDI', MATH_ONLY: 'MATEMATİK KARARI',
  AI_EXIT: 'AI ÇIKIŞ', EXCHANGE: 'BORSADA KAPANDI'
};

const TOKENIZED_STOCKS = new Set(['INTC', 'MSTR', 'KORU', 'SNXX', 'TSLA', 'NVDA', 'AAPL', 'COIN', 'HOOD', 'CRCL', 'AMZN', 'GOOGL', 'MSFT', 'META', 'SPY', 'QQQ', 'PLTR', 'AMD', 'NFLX', 'BABA', 'MARA', 'RIOT']);

const DEF_SET = {
  auto: false, autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 5, riskPct: 0.5,
  maxOpen: 3, autoMaxOpen: 3, dailyLossPct: 3, minConf: 55, aiEnabled: false, aiWatchAuto: false,
  costPct: EX.H, paperEquity: 1000, maxSpreadPct: 0.10, minQuoteVol: 5e6, topN: 60,
  includeStocks: false, autoAiPerHour: 40
};

/* ---- Yardımcılar ---- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rp = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n >= 1000) return +n.toFixed(2); if (n >= 1) return +n.toFixed(4); if (n >= 0.01) return +n.toFixed(6); return +n.toFixed(8); };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const utcDayStart = ts => Math.floor((ts || Date.now()) / D1) * D1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isStock = sym => TOKENIZED_STOCKS.has(baseOf(sym));

/* ---- Ayarları temizle ---- */
function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.auto = s.auto === true; s.autoTrade = s.autoTrade === true; s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.margin = clamp(num(s.margin, DEF_SET.margin), 10, 100000); s.leverage = clamp(Math.round(num(s.leverage, DEF_SET.leverage)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, DEF_SET.riskPct), 0.05, 5); s.maxOpen = clamp(Math.round(num(s.maxOpen, DEF_SET.maxOpen)), 1, 20);
  s.autoMaxOpen = clamp(Math.round(num(s.autoMaxOpen, DEF_SET.autoMaxOpen)), 1, 5); s.dailyLossPct = clamp(num(s.dailyLossPct, DEF_SET.dailyLossPct), 0.5, 50);
  s.minConf = clamp(Math.round(num(s.minConf, DEF_SET.minConf)), 30, 95); s.aiEnabled = s.aiEnabled === true; s.aiWatchAuto = s.aiWatchAuto === true;
  s.costPct = EX.H; s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9); s.maxSpreadPct = clamp(num(s.maxSpreadPct, DEF_SET.maxSpreadPct), 0.01, 1);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 1e5, 1e9); s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 10, 150);
  s.includeStocks = s.includeStocks === true; s.autoAiPerHour = clamp(Math.round(num(s.autoAiPerHour, DEF_SET.autoAiPerHour)), 5, 200);
  return s;
}

/* ---- Global Durum ---- */
let settings = sanitizeSettings({});
let signals = [];
let paper = { open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity, dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity };
let REJ = [];
let OUT = [];
let OPP = new Map();
let WATCH = { auto: [], lt: [], scalp: [] };
let WATCH_META = { auto: null, lt: null, scalp: null };
let SCALP_WATCH = [];
let LT_CACHE = new Map();
let FIRED = new Map();
let REJ_STAT = {};
let seq = 0;
let lastScan = { auto: 0, scalp: 0, lt: 0, tick: 0 };
let dirty = false;
let READY = false;
let market = { dir: 'NOTR', score: 0.5, breadth: 0.5, why: 'veri bekleniyor', btc: null, eth: null, at: 0 };
let marketBrief = null;
let marketAI = { dir: 'NOTR', score: 50, reason: 'AI yönü bekleniyor', at: 0, provider: null, model: null, hist: [] };
let AUTO_WATCH = [];
let AUTO_FIRED = new Map();
let LIVE = { open: [], closed: [], balance: null, positions: null, lastSync: 0, lastError: null, busy: false, needsSync: false, ipHint: null };

function capArr(a, n) { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; }
function capMap(m, n) { while (m.size > n) { const k = m.keys().next().value; m.delete(k); } }

/* ---- Durum yükle / kaydet ---- */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (settings.tradeMode === 'live' && !HAS_KEYS) { settings.tradeMode = 'paper'; log('Canlı mod için Bitget anahtarı yok → paper moda dönüldü'); }
    if (j && Array.isArray(j.signals)) signals = j.signals.filter(s => s && ACTIVE_MODULES.includes(s.module)).slice(-500);
    if (j && j.paper) {
      paper = Object.assign(paper, j.paper);
      paper.open = Array.isArray(paper.open) ? paper.open.filter(p => p && (p.module === 'PUMP' || p.module === 'AUTO')).slice(0, 50) : [];
      paper.closed = Array.isArray(paper.closed) ? paper.closed.filter(p => p && (p.module === 'PUMP' || p.module === 'AUTO')).slice(-300) : [];
      paper.equity = num(paper.equity, DEF_SET.paperEquity); paper.start = num(paper.start, DEF_SET.paperEquity); paper.peak = num(paper.peak, paper.equity);
    }
    if (j && j.live && typeof j.live === 'object') {
      LIVE.open = Array.isArray(j.live.open) ? j.live.open.filter(p => p && p.isLive) : [];
      LIVE.closed = Array.isArray(j.live.closed) ? j.live.closed.slice(-200) : [];
      LIVE.balance = j.live.balance || null; LIVE.needsSync = true;
    }
    if (j && j.marketAI) marketAI = Object.assign(marketAI, j.marketAI);
    if (j && j.version === VERSION && j.aiModels && typeof j.aiModels === 'object') for (const p of AI_PROV) { const arr = j.aiModels[p.id]; if (Array.isArray(arr) && arr.length) p.models = arr.slice(0, 12); }
    if (j && Array.isArray(j.rej)) REJ = j.rej.slice(-200);
    if (j && Array.isArray(j.out)) OUT = j.out.slice(-300);
    if (j && j.rejStat) REJ_STAT = j.rejStat;
    if (j && Number.isFinite(Number(j.seq))) seq = Number(j.seq);
    if (j && j.aiUsage) Object.assign(AI_USAGE, j.aiUsage);
    if (j && j.marketBrief) marketBrief = j.marketBrief;
    if (j && Array.isArray(j.aiHist)) AI_HIST = j.aiHist.slice(-300);
    if (j && Array.isArray(j.shadow)) for (const s of j.shadow.slice(-100)) if (s && !s.done) SHADOW.push(s);
    log('Durum yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık paper işlem');
  } catch (e) { log('Durum yüklenemedi: ' + e.message); }
}

function saveState(force) {
  if (!dirty && !force) return;
  try {
    const j = {
      version: VERSION, at: Date.now(), settings, signals: signals.slice(-500),
      paper, rej: REJ.slice(-200), out: OUT.slice(-300), rejStat: REJ_STAT, seq, aiUsage: AI_USAGE, marketBrief, marketAI,
      live: { open: LIVE.open.slice(-30), closed: LIVE.closed.slice(-200), balance: LIVE.balance },
      aiModels: Object.fromEntries(AI_PROV.map(p => [p.id, (p.models || []).slice(0, 12)])),
      aiHist: AI_HIST.slice(-300).map(r => Object.assign({}, r, { rec: undefined })),
      shadow: SHADOW.filter(s => !s.done).slice(-100).map(s => Object.assign({}, s, { rec: undefined }))
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { log('Durum kaydedilemedi: ' + e.message); }
}

/* ---- Log ---- */
const LOGS = [];
const LOG_ONCE = new Map();
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  LOGS.push({ t: Date.now(), msg: String(msg).slice(0, 500) });
  if (LOGS.length > 400) LOGS.splice(0, LOGS.length - 400);
}
function logOnce(key, msg, ms) {
  const now = Date.now();
  if ((LOG_ONCE.get(key) || 0) > now) return;
  LOG_ONCE.set(key, now + (ms || 5 * M1));
  log(msg);
}
function redact(s) {
  let x = String(s == null ? '' : s);
  for (const p of AI_PROV) if (p.key) x = x.split(p.key).join('[KEY]');
  if (API_KEY) x = x.split(API_KEY).join('[KEY]');
  if (API_SECRET) x = x.split(API_SECRET).join('[KEY]');
  if (API_PASS) x = x.split(API_PASS).join('[KEY]');
  return x.slice(0, 600);
}

/* ---- Karar günlüğü ---- */
function appendDecision(o) {
  try {
    try { if (fs.statSync(DEC_FILE).size > 5 * 1024 * 1024) fs.renameSync(DEC_FILE, DEC_FILE + '.1'); } catch (e) { }
    fs.appendFileSync(DEC_FILE, JSON.stringify(Object.assign({ t: Date.now(), market: market.dir }, o)) + '\n');
  } catch (e) { }
}
function readDecisions(n) {
  try {
    const lines = fs.readFileSync(DEC_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════════
   İNDİKATÖRLER
   ══════════════════════════════════════════════════════════════════════════════ */

function emaArr(vals, len) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = Number(vals[i]);
    if (!Number.isFinite(v)) { out[i] = prev; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function emaLast(vals, len) { const a = emaArr(vals, len); return a.length ? a[a.length - 1] : null; }

function rsiLast(closes, len = 14) {
  if (!closes || closes.length < len + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain / len, al = loss / len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atrArr(cs, len = 14) {
  const out = new Array(cs.length).fill(null);
  if (cs.length < len + 1) return out;
  const tr = cs.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)));
  let a = avg(tr.slice(1, len + 1));
  out[len] = a;
  for (let i = len + 1; i < cs.length; i++) { a = (a * (len - 1) + tr[i]) / len; out[i] = a; }
  return out;
}
function atrLast(cs, len = 14) { const a = atrArr(cs, len); return a.length ? a[a.length - 1] : null; }

function adxLast(cs, len = 14) {
  if (!cs || cs.length < len * 2 + 2) return null;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < cs.length; i++) {
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  let trS = avg(tr.slice(0, len)), pS = avg(pdm.slice(0, len)), nS = avg(ndm.slice(0, len));
  const dx = [];
  let pDI = 0, nDI = 0;
  for (let i = len; i < tr.length; i++) {
    trS = (trS * (len - 1) + tr[i]) / len;
    pS = (pS * (len - 1) + pdm[i]) / len;
    nS = (nS * (len - 1) + ndm[i]) / len;
    pDI = trS > 0 ? 100 * pS / trS : 0;
    nDI = trS > 0 ? 100 * nS / trS : 0;
    const s = pDI + nDI;
    dx.push(s > 0 ? 100 * Math.abs(pDI - nDI) / s : 0);
  }
  if (dx.length < len) return null;
  return { adx: avg(dx.slice(-len)), plusDI: pDI, minusDI: nDI };
}

function vwapOf(cs, sinceMs) {
  if (!cs || !cs.length) return { vwap: null, sd: null, n: 0 };
  let use = cs.filter(c => c.t >= sinceMs);
  if (use.length < 6) use = cs.slice(-100);
  let pv = 0, vv = 0;
  for (const c of use) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; vv += c.v; }
  if (!(vv > 0)) return { vwap: null, sd: null, n: use.length };
  const vwap = pv / vv;
  let varSum = 0;
  for (const c of use) { const tp = (c.h + c.l + c.c) / 3; varSum += c.v * (tp - vwap) * (tp - vwap); }
  return { vwap, sd: Math.sqrt(varSum / vv), n: use.length };
}

function pivots(cs, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < cs.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[j].h > cs[i].h + 1e-12) isH = false;
      if (cs[j].l < cs[i].l - 1e-12) isL = false;
    }
    if (isH) highs.push({ i, t: cs[i].t, p: cs[i].h });
    if (isL) lows.push({ i, t: cs[i].t, p: cs[i].l });
  }
  return { highs, lows };
}

function bodyRatio(c) { const r = c.h - c.l; return r > 0 ? Math.abs(c.c - c.o) / r : 0; }
function bodyAtr(c, atr) { return atr > 0 ? Math.abs(c.c - c.o) / atr : 0; }
function closesOf(cs) { return cs.map(c => c.c); }
function toC(a) { return { t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0 }; }
function closed(cs, tfMs) {
  if (!cs || !cs.length) return [];
  const last = cs[cs.length - 1];
  return last.t + tfMs > Date.now() + 5000 ? cs.slice(0, -1) : cs;
}
function aggTF(cs, factor, srcTfMs) {
  const out = [];
  const bucketMs = (srcTfMs || M1) * factor;
  let cur = null, bucket = null;
  for (const c of cs) {
    const b = Math.floor(c.t / bucketMs);
    if (bucket !== b) {
      if (cur) out.push(cur);
      bucket = b;
      cur = { t: b * bucketMs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  if (cur) out.push(cur);
  return out;
}
function htfTrend(cs) {
  if (!cs || cs.length < 30) return 'YATAY';
  const e = emaArr(closesOf(cs), 20);
  const a = e[e.length - 1], b = e[e.length - 6];
  const atr = atrLast(cs, 14) || 0;
  if (a - b > 0.15 * atr) return 'YUKARI';
  if (b - a > 0.15 * atr) return 'AŞAĞI';
  return 'YATAY';
}
function fmtCandles(cs, n) {
  return (cs || []).slice(-n).map(c => {
    const p = c.c >= 1 ? 4 : 6;
    return new Date(c.t).toISOString().slice(5, 16).replace('T', ' ') + ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v);
  }).join('\n');
}

/* ══════════════════════════════════════════════════════════════════════════════
   BORSA / EVREN / FİYAT
   ══════════════════════════════════════════════════════════════════════════════ */

const ex = new ccxt.bitget({
  apiKey: API_KEY || undefined, secret: API_SECRET || undefined, password: API_PASS || undefined,
  enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap', defaultSubType: 'linear' }
});

const CACHE = new Map();
const TICK = new Map();
const LONG1H = new Map();
let UNIVERSE = [];
const FALLBACK = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT', 'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT', 'TON/USDT:USDT', 'DOT/USDT:USDT', 'LTC/USDT:USDT', 'BCH/USDT:USDT', 'NEAR/USDT:USDT'];
const EXCLUDE = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'EUR', 'GBP', 'BUSD']);

async function pool(items, n, fn) {
  const list = items.slice();
  let idx = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx++;
      try { await fn(list[i], i); } catch (e) { }
    }
  });
  await Promise.all(workers);
}

function scanSyms(kind, n) {
  const l = UNIVERSE.filter(s => kind === 'LT' || settings.includeStocks || !isStock(s));
  return l.slice(0, n);
}

function tick(sym) { return TICK.get(sym) || null; }
function priceOf(sym) {
  const t = tick(sym);
  if (t && t.last > 0) return t.last;
  const c = CACHE.get(sym + '|1m');
  if (c && c.data && c.data.length) return c.data[c.data.length - 1].c;
  return 0;
}
function spreadPct(sym) {
  const t = tick(sym);
  if (!t || !(t.bid > 0) || !(t.ask > 0)) return 99;
  return (t.ask - t.bid) / t.bid * 100;
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
    if (next.length) { UNIVERSE = next; log('Evren güncellendi: ' + UNIVERSE.length + ' coin'); }
  } catch (e) {
    log('Evren alınamadı: ' + redact(e.message));
    if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice();
  }
  if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice();
}

async function refreshTickers() {
  try {
    const all = await ex.fetchTickers();
    for (const sym of Object.keys(all)) {
      if (!sym.endsWith('/USDT:USDT')) continue;
      if (UNIVERSE.length && !UNIVERSE.includes(sym) && !FALLBACK.includes(sym)) continue;
      const t = all[sym] || {};
      const last = num(t.last), bid = num(t.bid), ask = num(t.ask);
      if (!(last > 0)) continue;
      TICK.set(sym, { last, bid, ask, qv: num(t.quoteVolume), chg: num(t.percentage), ts: Date.now() });
    }
  } catch (e) { }
}

async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const ent = CACHE.get(key);
  if (ent && now - ent.t < (TTL[tf] || 60e3) && ent.data.length >= Math.min(limit, 50)) return ent.data.slice(-limit);
  let data = null;
  try {
    if (tf === '2h') {
      const raw = await ex.fetchOHLCV(sym, '1h', undefined, Math.min(1000, limit * 2 + 4));
      if (raw && raw.length) data = aggTF(raw.map(toC), 2, H1).slice(-limit);
    } else {
      const raw = await ex.fetchOHLCV(sym, tf, undefined, limit);
      if (raw && raw.length) data = raw.map(toC);
    }
  } catch (e) {
    if (ent && ent.data && ent.data.length) return ent.data.slice(-limit);
    return null;
  }
  if (!data || !data.length) return ent && ent.data ? ent.data.slice(-limit) : null;
  CACHE.set(key, { t: now, data });
  if (CACHE.size > 400) { const cutoff = now - 30 * M1; for (const [k, v] of CACHE) if (v.t < cutoff) CACHE.delete(k); }
  return data.slice(-limit);
}

async function getCandles(sym, tf, limit, closedOnly) {
  const data = await fetchOHLCV(sym, tf, limit);
  if (!data) return null;
  return closedOnly === false ? data : closed(data, TF_MS[tf] || M5);
}

async function getLong2h(sym, bars) {
  const need = bars * 2 + 6;
  const now = Date.now();
  let ent = LONG1H.get(sym);
  const fresh = ent && now - ent.at < 20 * M1;
  if (!fresh) {
    const map = new Map();
    if (ent) for (const c of ent.data) map.set(c.t, c);
    let since = ent && ent.data.length ? ent.data[ent.data.length - 1].t - 2 * H1 : now - need * H1;
    let got = false;
    for (let g = 0; g < 18; g++) {
      let raw;
      try { raw = await ex.fetchOHLCV(sym, '1h', since, 1000); } catch (e) { break; }
      if (!raw || !raw.length) break;
      got = true;
      let lastT = 0;
      for (const r of raw) { const c = toC(r); map.set(c.t, c); lastT = c.t; }
      if (lastT <= since || lastT >= now - H1) break;
      since = lastT + 1;
    }
    if (!got && !ent) return null;
    const data = Array.from(map.values()).sort((a, b) => a.t - b.t).slice(-need);
    ent = { data, at: got ? now : (ent ? ent.at : now) };
    LONG1H.set(sym, ent);
  }
  const agg = aggTF(ent.data, 2, H1);
  return closed(agg, H2).slice(-bars);
}

/* ---- Piyasa yönü: SADECE AI ---- */
async function updateMarket() {
  try {
    const btc = await getCandles('BTC/USDT:USDT', '1h', 120);
    const eth = await getCandles('ETH/USDT:USDT', '1h', 120);
    const one = (cs) => {
      if (!cs || cs.length < 60) return null;
      const cl = closesOf(cs), e20 = emaLast(cl, 20), e50 = emaLast(cl, 50);
      const rsi = rsiLast(cl, 14), atr = atrLast(cs, 14), last = cl[cl.length - 1];
      return { price: rp(last), e20: rp(e20), e50: rp(e50), rsi: rsi != null ? +rsi.toFixed(0) : null, atrPct: atr ? +(atr / last * 100).toFixed(2) : null, chg: num(tick('BTC/USDT:USDT') && tick('BTC/USDT:USDT').chg) };
    };
    const b = one(btc), e = one(eth);
    let green = 0, total = 0;
    for (const sym of UNIVERSE) { const t = tick(sym); if (!t) continue; total++; if (t.chg > 0) green++; }
    const breadth = total ? green / total : 0.5;

    const useAI = settings.aiEnabled === true && aiReady() && marketAI.at > 0;
    const dir = useAI ? marketAI.dir : 'NOTR';
    const score = useAI ? clamp(marketAI.score / 100, 0, 1) : 0.5;
    const why = useAI ? ('AI 15m yönü: ' + (marketAI.reason || marketAI.dir)) : 'AI yönü bekleniyor...';

    market = { dir, score: +score.toFixed(2), breadth: +breadth.toFixed(3), why, btc: b, eth: e, at: Date.now(), source: useAI ? 'AI' : 'NONE' };
  } catch (e) { log('Piyasa rejimi hatası: ' + redact(e.message)); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   LT ÜÇGEN
   ══════════════════════════════════════════════════════════════════════════════ */

function triUpperAt(tri, i) { return tri.hi.intercept + tri.hi.slope * (i - tri.refIdx); }
function triLowerAt(tri, i) { return tri.lo.intercept + tri.lo.slope * (i - tri.refIdx); }

function zigzag(cs, thr) {
  const n = cs.length, piv = [];
  if (n < 20 || !(thr > 0)) return piv;
  let trend = 0, hi = cs[0].h, hiI = 0, lo = cs[0].l, loI = 0;
  for (let i = 1; i < n; i++) {
    const c = cs[i];
    if (trend === 0) {
      if (c.h > hi) { hi = c.h; hiI = i; }
      if (c.l < lo) { lo = c.l; loI = i; }
      if (c.h - lo >= thr && loI < i) { piv.push({ i: loI, t: cs[loI].t, p: lo, k: 'L' }); trend = 1; hi = c.h; hiI = i; }
      else if (hi - c.l >= thr && hiI < i) { piv.push({ i: hiI, t: cs[hiI].t, p: hi, k: 'H' }); trend = -1; lo = c.l; loI = i; }
    } else if (trend === 1) {
      if (c.h > hi) { hi = c.h; hiI = i; }
      else if (hi - c.l >= thr) { piv.push({ i: hiI, t: cs[hiI].t, p: hi, k: 'H' }); trend = -1; lo = c.l; loI = i; }
    } else {
      if (c.l < lo) { lo = c.l; loI = i; }
      else if (c.h - lo >= thr) { piv.push({ i: loI, t: cs[loI].t, p: lo, k: 'L' }); trend = 1; hi = c.h; hiI = i; }
    }
  }
  return piv;
}

function findLines(cs, piv, side, atr) {
  const n = cs.length;
  const use = piv.filter(q => q.k === side).slice(-9);
  const cand = [];
  for (let a = 0; a < use.length - 1; a++) {
    for (let b = a + 1; b < use.length; b++) {
      const A = use[a], B = use[b];
      if (B.i - A.i < 12) continue;
      if (B.i < n - 1 - 420) continue;
      const slope = (B.p - A.p) / (B.i - A.i);
      const at = i => B.p + slope * (i - B.i);
      let bad = false;
      for (let k = A.i + 1; k <= n - 3; k++) {
        const c = cs[k], v = at(k);
        if (side === 'H') { if (c.c > v + 0.15 * atr || c.h > v + 0.6 * atr) { bad = true; break; } }
        else if (c.c < v - 0.15 * atr || c.l < v - 0.6 * atr) { bad = true; break; }
      }
      if (bad) continue;
      const touches = [];
      let lastK = -99;
      for (let k = A.i; k <= n - 1; k++) {
        const c = cs[k], v = at(k);
        const d = side === 'H' ? Math.abs(c.h - v) : Math.abs(c.l - v);
        if (d <= 0.35 * atr && k - lastK >= 6) { touches.push({ i: k, t: c.t, p: side === 'H' ? c.h : c.l }); lastK = k; }
      }
      if (touches.length < 2) continue;
      const span = n - 1 - A.i;
      cand.push({ side, slope, a: A, b: B, at, touches, span, score: touches.length * 12 + Math.min(span, 500) / 25 + (B.i / n) * 6 });
    }
  }
  cand.sort((x, y) => y.score - x.score);
  return cand.slice(0, 3);
}

function triShape(hiSlope, loSlope, atr) {
  const flat = s => Math.abs(s * 60) < 0.25 * atr;
  if (flat(loSlope) && hiSlope < 0) return 'ALÇALAN';
  if (flat(hiSlope) && loSlope > 0) return 'YÜKSELEN';
  if (hiSlope < 0 && loSlope > 0) return 'SİMETRİK';
  return 'KAMA';
}

function analyzeTriangle(cs, tf) {
  if (!cs || cs.length < 120) return null;
  const n = cs.length;
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const px = cs[n - 1].c;
  const tfMs = TF_MS[tf] || H2;
  let piv = zigzag(cs, 3 * atr);
  const cnt = k => piv.filter(q => q.k === k).length;
  if (cnt('H') < 2 || cnt('L') < 2) piv = zigzag(cs, 2 * atr);
  if (cnt('H') < 2 || cnt('L') < 2) return null;
  const U = findLines(cs, piv, 'H', atr), L = findLines(cs, piv, 'L', atr);
  if (!U.length || !L.length) return null;

  const refIdx = n - 1;
  const vol20 = avg(cs.slice(-20).map(c => c.v));
  const volPrev = avg(cs.slice(-50, -20).map(c => c.v));
  const volContraction = volPrev > 0 ? clamp(1 - vol20 / volPrev, -1, 1) : 0;
  let best = null;
  for (const u of U) {
    for (const l of L) {
      const hi = { slope: u.slope, intercept: u.at(refIdx) };
      const lo = { slope: l.slope, intercept: l.at(refIdx) };
      const upperNow = hi.intercept, lowerNow = lo.intercept;
      const widthNow = upperNow - lowerNow;
      if (!(widthNow > 0.15 * atr) || widthNow > 25 * atr) continue;
      const conv = hi.slope - lo.slope;
      if (!(conv < -0.0015 * atr)) continue;
      const apexX = (lo.intercept - hi.intercept) / (hi.slope - lo.slope);
      if (!(apexX > 0) || apexX > 500) continue;
      const firstIdx = Math.min(u.a.i, l.a.i);
      const apexIdx = refIdx + apexX;
      const maturity = clamp((refIdx - firstIdx) / Math.max(1, apexIdx - firstIdx), 0, 1);
      if (maturity < 0.22) continue;
      const wAt = i => (hi.intercept + hi.slope * (i - refIdx)) - (lo.intercept + lo.slope * (i - refIdx));
      const widthStart = wAt(firstIdx);
      if (!(widthStart > 0)) continue;
      const compression = clamp(1 - widthNow / widthStart, 0, 1);
      if (compression < 0.07) continue;
      const tH = u.touches.length, tL = l.touches.length;
      if (tH < 2 || tL < 2 || tH + tL < 4) continue;
      const outside = px > upperNow + 0.9 * atr || px < lowerNow - 0.9 * atr;
      const score = clamp(Math.round(38 + tH * 4 + tL * 4 + compression * 26 + maturity * 18 + clamp(volContraction, 0, 1) * 8 + (outside ? -12 : 0)), 0, 100);
      const total = score + (u.score + l.score) / 10;
      if (!best || total > best.total) {
        best = {
          total, ok: true, tf, n, refIdx, atr, px, hi, lo, upperNow, lowerNow, widthNow,
          widthPct: +(widthNow / px * 100).toFixed(2), widthStart,
          compression: +compression.toFixed(3), maturity: +maturity.toFixed(3),
          apexX, apexIdx, apexAt: cs[refIdx].t + Math.round(apexX) * tfMs,
          firstIdx, firstT: cs[firstIdx].t, lastT: cs[refIdx].t,
          touchesH: tH, touchesL: tL, resH: 0, resL: 0,
          volContraction: +volContraction.toFixed(2), outside, score,
          highs: u.touches, lows: l.touches, shape: triShape(hi.slope, lo.slope, atr),
          spanBars: refIdx - firstIdx
        };
      }
    }
  }
  return best;
}

function srLevels(cs, atr, px) {
  if (!cs || cs.length < 40 || !(atr > 0) || !(px > 0)) return [];
  const pv = pivots(cs.slice(-600), 6, 6);
  const raw = [];
  for (const q of pv.highs) raw.push({ p: q.p, kind: 'R' });
  for (const q of pv.lows) raw.push({ p: q.p, kind: 'S' });
  const clusters = [];
  for (const r of raw) {
    let c = clusters.find(x => Math.abs(x.p - r.p) <= 0.5 * atr);
    if (!c) { c = { p: r.p, n: 0, kind: r.kind }; clusters.push(c); }
    c.p = (c.p * c.n + r.p) / (c.n + 1);
    c.n++;
    if (r.kind === 'R') c.kind = 'R';
  }
  const above = clusters.filter(c => c.p > px * 1.001).sort((a, b) => a.p - b.p).slice(0, 3);
  const below = clusters.filter(c => c.p < px * 0.999).sort((a, b) => b.p - a.p).slice(0, 3);
  return above.map(c => ({ v: rp(c.p), col: '#f6465d', l: 'DİRENÇ', kind: 'R', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) }))
    .concat(below.map(c => ({ v: rp(c.p), col: '#0ecb81', l: 'DESTEK', kind: 'S', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) })));
}

function ltSignalFrom(sym, cs, tf, tri, opt) {
  if (!tri || !tri.ok) return null;
  const n = cs.length, last = cs[n - 1];
  const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  const atr = tri.atr;
  const up = triUpperAt(tri, n - 1), dn = triLowerAt(tri, n - 1);
  const vol20 = avg(cs.slice(-20).map(c => c.v));
  const vr = vol20 > 0 ? last.v / vol20 : 1;

  const upTouch = last.h >= up - 0.10 * atr || px >= up - 0.05 * atr;
  const dnTouch = last.l <= dn + 0.10 * atr || px <= dn + 0.05 * atr;
  const upClosed = last.c >= up - 0.03 * atr && last.c > last.o;
  const dnClosed = last.c <= dn + 0.03 * atr && last.c < last.o;
  const upLive = px >= up && last.o < up;
  const dnLive = px <= dn && last.o > dn;
  const upConfirm = upClosed || upLive;
  const dnConfirm = dnClosed || dnLive;
  if (!(upTouch && upConfirm) && !(dnTouch && dnConfirm)) return null;

  const dir = (upTouch && upConfirm && (!dnTouch || (px - up) >= (dn - px))) ? 'LONG' : 'SHORT';
  if (tri.maturity < 0.40 || tri.widthNow < 0.20 * atr) return null;
  if (dir === 'LONG') {
    if ((px - up) / atr > 0.85) return null;
    if (px < up - 0.35 * atr) return null;
  } else {
    if ((dn - px) / atr > 0.85) return null;
    if (px > dn + 0.35 * atr) return null;
  }

  const liveOnly = dir === 'LONG' ? !upClosed : !dnClosed;
  let br = bodyRatio(last), ba = bodyAtr(last, atr);
  if (liveOnly) {
    const eff = { o: last.o, h: dir === 'LONG' ? Math.max(last.h, px) : last.h, l: dir === 'SHORT' ? Math.min(last.l, px) : last.l, c: px };
    br = Math.max(br, bodyRatio(eff));
    ba = Math.max(ba, bodyAtr(eff, atr));
  }
  if (br < 0.26 || ba < 0.22) return null;
  if (vr < (liveOnly ? 0.85 : 1.00)) return null;

  const d = dir === 'LONG' ? 1 : -1;
  const entry = rp(px);
  const sw = cs.slice(-6);
  const swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.35 * atr;
  let risk = Math.abs(entry - sl);
  if (risk < 0.55 * atr) { sl = entry - d * 0.55 * atr; risk = Math.abs(entry - sl); }
  const riskPct = risk / entry * 100;
  if (riskPct < 0.45 || riskPct > EX.MAX_RISK_PCT) return null;

  const height = Math.max(Math.min(tri.widthStart, 5 * atr), 1.15 * risk);
  const tp1 = entry + d * Math.max(0.55 * height, 1.25 * risk);
  const tp2 = entry + d * Math.max(0.95 * height, 2.00 * risk);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net < 1.00 || q2.net < 1.60) return null;

  const h4Up = (() => {
    if (cs.length < 130) return null;
    const agg = aggTF(cs.slice(-120), 2, H2);
    if (agg.length < 30) return null;
    const e = emaArr(closesOf(agg), 20);
    return e[e.length - 1] > e[e.length - 6];
  })();
  const aligned = h4Up == null ? false : (dir === 'LONG' ? h4Up : !h4Up);
  const conf = clamp(Math.round(52 + tri.maturity * 15 + tri.compression * 18 + (tri.touchesH + tri.touchesL) * 2 + clamp(vr - 1, 0, 1) * 4 + (aligned ? 4 : 0) + (q1.net >= 1.4 ? 3 : 0)), 45, 95);

  const plan = { entry, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) };
  return {
    module: 'LT', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
    single: false, conf, retest: false, holdSec: 0,
    info: {
      tf, source: 'math', plan, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2),
      atr: rp(atr), atrPct: +(atr / entry * 100).toFixed(2), upper: rp(up), lower: rp(dn),
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct,
      maturity: tri.maturity, compression: tri.compression, touches: tri.touchesH + tri.touchesL,
      apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1), score: tri.score, shape: tri.shape, spanBars: tri.spanBars,
      volRatio: +vr.toFixed(2), bodyRatio: +br.toFixed(2), bodyAtr: +ba.toFixed(2),
      aligned4h: aligned, breakoutUp: dir === 'LONG', breakoutDn: dir === 'SHORT',
      pivots: tri.highs.map(q => ({ t: q.t, p: rp(q.p), side: 'H' })).concat(tri.lows.map(q => ({ t: q.t, p: rp(q.p), side: 'L' })))
    },
    setupKey: 'LT|' + sym + '|' + tri.firstT + '|' + Math.round(tri.apexAt / H4) + '|' + dir
  };
}

let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const list = scanSyms('LT', 40);
    const found = [];
    await pool(list, 3, async (sym) => {
      const cs = await getLong2h(sym, LT_BARS);
      if (!cs || cs.length < 150) return;
      const tri = analyzeTriangle(cs, '2h');
      if (!tri) { LT_CACHE.delete(sym); return; }
      const old = LT_CACHE.get(sym);
      LT_CACHE.set(sym, { sym, tf: '2h', cs, tri, at: Date.now(), ai: old ? old.ai : null });
      const raw = ltSignalFrom(sym, cs, tri.tf, tri);
      if (raw) found.push(raw);
    });
    found.sort((a, b) => b.conf - a.conf);
    for (const raw of found.slice(0, 4)) {
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); log('LT KIRILIM: ' + sig.base + ' ' + sig.dir + ' | ' + (raw.info.shape || '') + ' | güven ' + sig.conf + ' | net R:R ' + sig.info.netRR); }
    }
    buildLtWatch();
    lastScan.lt = Date.now();
  } catch (e) { log('LT tarama hatası: ' + redact(e.message)); }
  finally { ltScanning = false; }
}

let ltTicking = false;
function ltTick() {
  if (ltTicking) return;
  ltTicking = true;
  try {
    for (const [sym, e] of LT_CACHE) {
      if (Date.now() - e.at > 25 * M1) continue;
      const raw = ltSignalFrom(sym, e.cs, e.tri.tf, e.tri);
      if (!raw) continue;
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); log('LT CANLI KIRILIM: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf); }
    }
    buildLtWatch();
    lastScan.tick = Date.now();
  } catch (e) { }
  finally { ltTicking = false; }
}

function buildLtWatch() {
  const rows = [];
  for (const [sym, e] of LT_CACHE) {
    const { tri, cs, tf } = e;
    const last = cs[cs.length - 1];
    const px = priceOf(sym) || last.c;
    const up = triUpperAt(tri, cs.length - 1), dn = triLowerAt(tri, cs.length - 1);
    const distU = (up / px - 1) * 100, distL = (px / dn - 1) * 100;
    const nearPct = Math.min(Math.abs(distU), Math.abs(distL));
    const nearSide = Math.abs(distU) <= Math.abs(distL) ? 'ÜST' : 'ALT';
    const outside = px > up + 0.25 * tri.atr || px < dn - 0.25 * tri.atr;
    let status = 'SIKIŞMA';
    if (outside) status = 'KIRILDI';
    else if (nearPct < 0.60) status = 'KIRILIM YAKIN';
    else if (tri.maturity > 0.75) status = 'OLGUN';
    rows.push({
      symbol: sym, base: baseOf(sym), tf, price: rp(px), upper: rp(up), lower: rp(dn),
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct,
      distUpperPct: +distU.toFixed(2), distLowerPct: +distL.toFixed(2), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2),
      nearPct: +nearPct.toFixed(2), nearSide, status, dirHint: nearSide === 'ÜST' ? 'LONG' : 'SHORT', shape: tri.shape,
      maturity: tri.maturity, compression: tri.compression, score: tri.score,
      touches: tri.touchesH + tri.touchesL, apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1),
      breakoutUp: tri.outside && px > up, breakoutDn: tri.outside && px < dn, ai: (e.ai || null)
    });
  }
  rows.sort((a, b) => a.nearPct - b.nearPct || b.score - a.score);
  WATCH.lt = rows.slice(0, 40);
  WATCH_META.lt = { scannedAt: lastScan.lt || Date.now(), count: WATCH.lt.length, universe: Math.min(40, UNIVERSE.length) };
}

function sampleLine(tri, upper, from, to, cs, tfMs) {
  const n = cs.length, out = [];
  const steps = Math.min(80, Math.max(2, to - from));
  for (let s = 0; s <= steps; s++) {
    const i = Math.round(from + (to - from) * s / steps);
    const t = i < n ? cs[Math.max(0, i)].t : cs[n - 1].t + (i - n + 1) * tfMs;
    const v = upper ? triUpperAt(tri, i) : triLowerAt(tri, i);
    if (v > 0) out.push([t, rp(v)]);
  }
  return out;
}
function triangleChart(tri, cs, tf) {
  if (!tri || !tri.ok) return null;
  const tfMs = TF_MS[tf] || H2;
  const n = cs.length;
  const future = clamp(Math.ceil(tri.apexX) + 10, 12, 90);
  const start = Math.max(0, tri.firstIdx);
  return {
    upper: sampleLine(tri, true, start, n - 1 + future, cs, tfMs),
    lower: sampleLine(tri, false, start, n - 1 + future, cs, tfMs),
    upperFull: sampleLine(tri, true, 0, n - 1 + future, cs, tfMs),
    lowerFull: sampleLine(tri, false, 0, n - 1 + future, cs, tfMs),
    upperNow: rp(triUpperAt(tri, n - 1)), lowerNow: rp(triLowerAt(tri, n - 1)),
    apexAt: tri.apexAt, apexPrice: rp(tri.hi.intercept + tri.hi.slope * tri.apexX),
    pivots: tri.highs.map(q => ({ t: q.t, p: rp(q.p), side: 'H' })).concat(tri.lows.map(q => ({ t: q.t, p: rp(q.p), side: 'L' }))),
    maturity: tri.maturity, compression: tri.compression, score: tri.score, widthPct: tri.widthPct, shape: tri.shape
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   GÜNLÜK HIZLI SCALP (PUMP)
   ══════════════════════════════════════════════════════════════════════════════ */

const SESSIONS = [0, 7 * H1, 13 * H1 + 30 * M1];
function currentSession(now) {
  const day = utcDayStart(now);
  let best = null;
  for (const off of SESSIONS) { const start = day + off; if (start <= now && now - start <= 5 * H1) best = { start, off }; }
  return best || { start: day, off: 0 };
}
function openingRange(cs, start) {
  const bars = cs.filter(c => c.t >= start && c.t < start + 30 * M1);
  if (bars.length < 5) return null;
  const high = Math.max.apply(null, bars.map(c => c.h));
  const low = Math.min.apply(null, bars.map(c => c.l));
  return { high, low, mid: (high + low) / 2, n: bars.length, start, end: start + 30 * M1 };
}

function scalpContext(sym, cs, opt) {
  if (!cs || cs.length < 120) return null;
  const n = cs.length, last = cs[n - 1];
  const now = (opt && Number(opt.now) > 0) ? Number(opt.now) : Date.now();
  const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  if (!(px > 0)) return null;
  const cl = closesOf(cs);
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const e9 = emaArr(cl, 9), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  const rsi = rsiLast(cl, 14);
  const adxObj = adxLast(cs, 14);
  const volSma = avg(cs.slice(-20).map(c => c.v));
  const volRatio = volSma > 0 ? last.v / volSma : 0;
  const session = currentSession(now);
  const vw = vwapOf(cs, session.start);
  const or = openingRange(cs, session.start);
  const spread = (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym);
  const atrPct = atr / px * 100;
  const e50Slope = e50[n - 7] ? (e50[n - 1] - e50[n - 7]) / e50[n - 7] * 100 : 0;
  return {
    sym, cs, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi,
    adx: adxObj ? adxObj.adx : null, plusDI: adxObj ? adxObj.plusDI : null, minusDI: adxObj ? adxObj.minusDI : null,
    volSma, volRatio, vwap: vw.vwap, vwapSd: vw.sd, session, or, spread, e50Slope,
    body: bodyRatio(last), ba: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr
  };
}

function clampRisk(entry, sl, dir, loPct, hiPct) {
  const d = dir === 'LONG' ? 1 : -1;
  let risk = Math.abs(entry - sl);
  const lo = entry * loPct / 100, hi = entry * hiPct / 100;
  if (!(risk > 0)) risk = lo;
  risk = clamp(risk, lo, hi);
  return entry - d * risk;
}

function makeScalpCandidate(ctx, setup, dir, entry, sl, tp1, tp2, holdMs, score, reasons, risks, trigger, distPct, triggered) {
  const d = dir === 'LONG' ? 1 : -1;
  entry = rp(entry);
  sl = rp(clampRisk(entry, sl, dir, 0.70, 1.20));
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  tp1 = rp(entry + d * Math.max(risk * 1.80, entry * 0.005));
  tp2 = rp(entry + d * Math.max(risk * 2.80, entry * 0.008));
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net < EX.MIN_RR1 || q2.net < EX.MIN_RR2) return null;
  const riskPct = risk / entry * 100;
  if (riskPct < 0.40 || riskPct > EX.MAX_RISK_PCT) return null;
  return {
    setup, dir, entry, sl, tp1, tp2, holdMs, score: clamp(Math.round(score), 0, 100),
    riskPct: +riskPct.toFixed(2), netRR: q1.net, netRR2: q2.net,
    reasons: reasons.filter(Boolean).slice(0, 6), risks: risks.filter(Boolean).slice(0, 4),
    trigger: rp(trigger || entry), distPct: +num(distPct, 0).toFixed(2), triggered: !!triggered
  };
}

function scalpCandidates(ctx) {
  const out = [];
  const { last, px, atr, cs, n } = ctx;
  const prev = cs[n - 2];

  // ORB (açılış aralığı kırılımı)
  if (ctx.or && ctx.now >= ctx.or.end + M5 && ctx.now <= ctx.session.start + 4 * H1) {
    const or = ctx.or;
    const long = last.c > or.high && last.o <= or.high * 1.0008 && px >= or.high * 0.999;
    const short = last.c < or.low && last.o >= or.low * 0.9992 && px <= or.low * 1.001;
    const trendUp = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015;
    const trendDn = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015;
    const volOk = ctx.volRatio >= 1.45;
    const bodyOk = ctx.body >= 0.30 && ctx.ba >= 0.38;
    const sess = new Date(ctx.session.start).toISOString().slice(11, 16);
    if (long && trendUp && volOk && bodyOk && (px - or.high) / atr <= 0.85 && (!ctx.vwap || px > ctx.vwap)) {
      const sl = Math.min(or.mid, last.c - 0.85 * atr);
      out.push(makeScalpCandidate(ctx, 'ORB', 'LONG', px, sl, 0, 0, 90 * M1,
        64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0),
        ['Seans açılış aralığı (' + sess + ' UTC) yukarı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP üstünde'],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.high, (or.high / px - 1) * 100, true));
    }
    if (short && trendDn && volOk && bodyOk && (or.low - px) / atr <= 0.85 && (!ctx.vwap || px < ctx.vwap)) {
      const sl = Math.max(or.mid, last.c + 0.85 * atr);
      out.push(makeScalpCandidate(ctx, 'ORB', 'SHORT', px, sl, 0, 0, 90 * M1,
        64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0),
        ['Seans açılış aralığı (' + sess + ' UTC) aşağı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP altında'],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.low, (1 - or.low / px) * 100, true));
    }
  }

  // VWAP / EMA20 geri çekilme
  if (ctx.vwap) {
    const longTrend = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015 && last.c > ctx.vwap;
    const shortTrend = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015 && last.c < ctx.vwap;
    const pullLong = cs.slice(-7, -1).some(c => c.l <= ctx.e20[n - 2] + 0.28 * atr) || cs.slice(-7, -1).some(c => c.l <= ctx.vwap + 0.30 * atr);
    const pullShort = cs.slice(-7, -1).some(c => c.h >= ctx.e20[n - 2] - 0.28 * atr) || cs.slice(-7, -1).some(c => c.h >= ctx.vwap - 0.30 * atr);
    const triggerLong = last.c > last.o && last.c > prev.h && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 42 && ctx.rsi <= 74 && (last.c - ctx.e20[n - 1]) / atr <= 1.35;
    const triggerShort = last.c < last.o && last.c < prev.l && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 26 && ctx.rsi <= 58 && (ctx.e20[n - 1] - last.c) / atr <= 1.35;
    if (longTrend && pullLong && triggerLong) {
      const sl = Math.min.apply(null, cs.slice(-4).map(c => c.l)) - 0.30 * atr;
      out.push(makeScalpCandidate(ctx, 'VWAP', 'LONG', px, sl, 0, 0, 45 * M1,
        58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0),
        ['EMA20/VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (ctx.e20[n - 1] / px - 1) * 100, true));
    }
    if (shortTrend && pullShort && triggerShort) {
      const sl = Math.max.apply(null, cs.slice(-4).map(c => c.h)) + 0.30 * atr;
      out.push(makeScalpCandidate(ctx, 'VWAP', 'SHORT', px, sl, 0, 0, 45 * M1,
        58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0),
        ['EMA20/VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (1 - ctx.e20[n - 1] / px) * 100, true));
    }

    // VWAP 2σ mean reversion (range)
    if (ctx.vwapSd > 0 && ctx.adx != null && ctx.adx < 21) {
      const lower2 = ctx.vwap - 2 * ctx.vwapSd, upper2 = ctx.vwap + 2 * ctx.vwapSd;
      const rng = last.h - last.l;
      const wickLow = rng > 0 ? (Math.min(last.o, last.c) - last.l) / rng : 0;
      const wickHigh = rng > 0 ? (last.h - Math.max(last.o, last.c)) / rng : 0;
      const longRev = last.l <= lower2 && last.c > lower2 && ctx.rsi != null && ctx.rsi < 32 && wickLow >= 0.32;
      const shortRev = last.h >= upper2 && last.c < upper2 && ctx.rsi != null && ctx.rsi > 68 && wickHigh >= 0.32;
      const revPlan = (dirStr, sl, score, reasons, trig, dist) => {
        const cand = makeScalpCandidate(ctx, 'REV', dirStr, px, sl, 0, 0, 30 * M1, score, reasons, ['Trend scalp değil, range dönüşü'], trig, dist, true);
        if (!cand) return;
        const sgn = dirStr === 'LONG' ? 1 : -1;
        const tp1v = rp(ctx.vwap), tp2v = rp(ctx.vwap + sgn * (ctx.vwapSd || Math.abs(cand.entry - cand.sl)));
        if ((tp1v - cand.entry) * sgn <= 0) return;
        const q1 = rrNet(cand.entry, cand.sl, tp1v), q2 = rrNet(cand.entry, cand.sl, tp2v);
        if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) { cand.tp1 = tp1v; cand.tp2 = tp2v; cand.netRR = q1.net; cand.netRR2 = q2.net; out.push(cand); }
      };
      if (longRev) revPlan('LONG', last.l - 0.35 * atr, 56 + clamp(32 - ctx.rsi, 0, 12) * 1.2 + clamp(wickLow - 0.32, 0, 0.4) * 20,
        ['VWAP alt 2σ bandından fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx) + ' (range)'], lower2, (lower2 / px - 1) * 100);
      if (shortRev) revPlan('SHORT', last.h + 0.35 * atr, 56 + clamp(ctx.rsi - 68, 0, 12) * 1.2 + clamp(wickHigh - 0.32, 0, 0.4) * 20,
        ['VWAP üst 2σ bandından fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx) + ' (range)'], upper2, (1 - upper2 / px) * 100);
    }
  }
  return out;
}

function scalpAnalyze(sym, cs, opt) {
  const ctx = scalpContext(sym, cs, opt);
  if (!ctx) return null;
  if (ctx.atrPct < 0.12 || ctx.atrPct > 2.2) return null;
  if (ctx.spread > settings.maxSpreadPct) return null;
  const cands = scalpCandidates(ctx).filter(Boolean);
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const raw = {
    module: 'PUMP', symbol: sym, base: baseOf(sym), dir: best.dir,
    entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2,
    single: false, conf: clamp(best.score, 45, 95), retest: false,
    holdSec: Math.round(best.holdMs / 1000), noMoveSec: Math.round(Math.min(180, best.holdMs / 1000 * 0.35)),
    info: {
      tf: '5m', source: 'math', setup: best.setup, plan: { entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2 },
      netRR: best.netRR, netRR2: best.netRR2, riskPct: best.riskPct, atrPct: +ctx.atrPct.toFixed(2),
      volRatio: +ctx.volRatio.toFixed(2), bodyAtr: +ctx.ba.toFixed(2), bodyRatio: +ctx.body.toFixed(2),
      rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
      vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]),
      orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null,
      sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3),
      trigger: best.trigger, distPct: best.distPct, score: best.score, reasons: best.reasons, risks: best.risks
    },
    maxAgeMs: best.holdMs + 10 * M1,
    setupKey: 'SCALP|' + sym + '|' + best.setup + '|' + best.dir + '|' + Math.floor(ctx.last.t / M5)
  };
  const row = {
    symbol: sym, base: baseOf(sym), tf: '5m', price: rp(ctx.px), setup: best.setup, dir: best.dir,
    score: best.score, status: best.triggered ? 'TETİK' : 'BEKLİYOR',
    state: best.triggered ? 'ADAY SİNYAL' : (best.distPct != null && Math.abs(best.distPct) <= 0.35 ? 'KIRILIM YAKLAŞIYOR' : 'TEYİT BEKLENİYOR'),
    trigger: best.trigger, distPct: best.distPct, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
    mom1: +(((ctx.last.c / ctx.cs[ctx.n - 2].c - 1) * 100)).toFixed(2),
    mom3: +(((ctx.last.c / ctx.cs[Math.max(0, ctx.n - 4)].c - 1) * 100)).toFixed(2),
    rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
    vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]),
    orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null,
    sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), reason: best.reasons[0] || '', ai: null
  };
  return { raw, row };
}

let scalpScanning = false;
async function scalpScan() {
  if (scalpScanning) return;
  scalpScanning = true;
  try {
    const list = scanSyms('PUMP', 50);
    const rows = [], raws = [];
    await pool(list, 5, async (sym) => {
      const cs = await getCandles(sym, '5m', 180, true);
      if (!cs || cs.length < 120) return;
      const a = scalpAnalyze(sym, cs);
      if (!a) return;
      if (a.row) rows.push(a.row);
      if (a.raw) raws.push(a.raw);
    });
    const old = new Map(SCALP_WATCH.map(r => [r.symbol, r.ai]));
    for (const r of rows) if (old.get(r.symbol)) r.ai = old.get(r.symbol);
    rows.sort((a, b) => (a.status === 'TETİK' ? -1 : 0) - (b.status === 'TETİK' ? -1 : 0) || a.distPct - b.distPct || b.score - a.score);
    SCALP_WATCH = rows.slice(0, 25);
    WATCH.scalp = SCALP_WATCH;
    WATCH_META.scalp = { scannedAt: Date.now(), count: SCALP_WATCH.length, universe: list.length };
    raws.sort((a, b) => b.conf - a.conf);
    let emitted = 0;
    for (const raw of raws) {
      if (emitted >= 2) break;
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 30 * M1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; log('SCALP SİNYAL (' + raw.info.setup + '): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net R:R ' + raw.info.netRR); }
    }
    lastScan.scalp = Date.now();
  } catch (e) { log('Scalp tarama hatası: ' + redact(e.message)); }
  finally { scalpScanning = false; }
}
/* ══════════════════════════════════════════════════════════════════════════════
   SİNYAL YAŞAM DÖNGÜSÜ + R:R
   ══════════════════════════════════════════════════════════════════════════════ */

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl), rew = Math.abs(tp - entry);
  if (!(risk > 0)) return { gross: 0, net: 0 };
  const gross = rew / risk;
  const fees = EX.FEE * 2 + EX.SLIP * 2;
  const net = (rew - entry * fees) / (risk + entry * fees);
  return { gross: +gross.toFixed(3), net: +net.toFixed(3) };
}

function isOpenSignal(s) {
  return s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR' || s.status === 'ONAY_BEKLIYOR');
}

function sigOpen(s) {
  if (!s) return false;
  return s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR' || s.status === 'ONAY_BEKLIYOR';
}

function logRej(module, symbol, reason, price) {
  const key = module + '|' + reason;
  REJ_STAT[key] = (REJ_STAT[key] || 0) + 1;
  REJ.push({ t: Date.now(), module, symbol, reason, price: rp(price) });
  capArr(REJ, 200);
  appendDecision({ kind: 'REJ', module, symbol, reason, price });
}

function viewSignal(s) {
  const now = Date.now();
  const px = priceOf(s.symbol);
  const d = s.dir === 'LONG' ? 1 : -1;
  const risk = Math.max(1e-9, Math.abs(s.entry - s.sl));
  const rNow = px > 0 ? (px - s.entry) * d / risk : 0;
  const pnlPct = px > 0 ? ((px - s.entry) / s.entry * 100 * d) : 0;
  const livePos = paper.open.find(p => p.sigId === s.id);
  return Object.assign({}, s, {
    livePrice: rp(px), rNow: +rNow.toFixed(2), livePnlPct: +pnlPct.toFixed(2),
    livePnl: livePos ? livePos.livePnl : null, pnlUsdt: livePos ? livePos.livePnl : null
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   addSignal — AI TEK YETKİLİ (ters yön filtresi YOK)
   ══════════════════════════════════════════════════════════════════════════════ */

function addSignal(raw) {
  if (!raw || !MODS[raw.module] || !MODS[raw.module].enabled) return false;
  const M = MODS[raw.module], now = Date.now();
  if (!['LONG', 'SHORT'].includes(raw.dir)) return false;
  if (!(raw.entry > 0) || !(raw.sl > 0) || !(raw.tp1 > 0)) return false;
  const d = raw.dir === 'LONG' ? 1 : -1;
  if ((raw.tp1 - raw.entry) * d <= 0) return false;
  if ((raw.sl - raw.entry) * d >= 0) return false;

  const riskPct = Math.abs(raw.entry - raw.sl) / raw.entry * 100;
  if (riskPct < 0.35 || riskPct > EX.MAX_RISK_PCT) { logRej(raw.module, raw.symbol, 'risk% ' + riskPct.toFixed(2), raw.entry); return false; }

  const q1 = rrNet(raw.entry, raw.sl, raw.tp1);
  if (q1.net < (raw.module === 'AUTO' ? 0.85 : 1.00)) { logRej(raw.module, raw.symbol, 'net RR ' + q1.net, raw.entry); return false; }

  if (raw.module === 'AUTO' && settings.autoTrade !== true) { logRej(raw.module, raw.symbol, 'OtoTrade kapalı', raw.entry); return false; }
  if (raw.module === 'AUTO' && !aiReady()) { logRej(raw.module, raw.symbol, 'AI kapalı — OtoTrade girişi yok', raw.entry); return false; }

  const same = signals.filter(s => s.module === raw.module && s.symbol === raw.symbol);
  if (same.some(isOpenSignal)) { logRej(raw.module, raw.symbol, 'aynı coin açık sinyal', raw.entry); return false; }
  const last = same.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - (last.closedAt || last.createdAt) < M.cooldown) { logRej(raw.module, raw.symbol, 'soğuma', raw.entry); return false; }
  if (same.filter(s => s.createdAt >= utcDayStart(now)).length >= M.maxPerDaySym) { logRej(raw.module, raw.symbol, 'günlük limit', raw.entry); return false; }

  if (raw.setupKey) {
    const f = FIRED.get(raw.setupKey);
    const ttl = raw.module === 'LT' ? 6 * H1 : raw.module === 'AUTO' ? 6 * M1 : 30 * M1;
    if (f && now - f < ttl) { logRej(raw.module, raw.symbol, 'setup tekrar', raw.entry); return false; }
  }

  // v85.5: Piyasa yönü ters kontrolü TAMAMEN KALDIRILDI. Yönü sadece AI belirler.
  const counter = market.dir !== 'NOTR' && market.dir !== raw.dir;

  const id = 'S' + (++seq).toString(36) + '-' + now.toString(36);
  const sig = {
    id, module: raw.module, symbol: raw.symbol, base: raw.base || baseOf(raw.symbol),
    dir: raw.dir, entry: rp(raw.entry), sl: rp(raw.sl), curSl: rp(raw.sl),
    tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null, single: false, tp1Hit: false,
    conf: clamp(Math.round(num(raw.conf, 55)), 30, 99),
    baseConf: clamp(Math.round(num(raw.conf, 55)), 30, 99),
    counter, marketAlign: market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU'),
    info: Object.assign({}, raw.info || {}, {
      plan: (raw.info && raw.info.plan) || { entry: rp(raw.entry), sl: rp(raw.sl), tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null }
    }),
    status: 'AKTIF', result: null, aiGate: null, ai: null,
    createdAt: now, updatedAt: now, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0,
    holdSec: raw.holdSec, noMoveSec: raw.noMoveSec, setupKey: raw.setupKey || null,
    tradeable: M.tradeable, virtual: !M.tradeable, startedAt: now, approvalExpiresAt: null, isLive: false
  };

  const aiOn = aiReady();
  sig.aiGate = { state: aiOn ? 'QUEUED' : 'MATH_ONLY', queuedAt: now, note: aiOn ? 'AI kararı bekleniyor' : 'AI kapalı — matematik kararı' };

  if (raw.module === 'AUTO') {
    sig.status = 'AI_BEKLIYOR';
    sig.aiGate = { state: 'QUEUED', queuedAt: now, note: 'OtoTrade giriş zamanlaması AI kararında' };
  } else if (raw.module === 'PUMP') {
    sig.status = aiOn ? 'AI_BEKLIYOR' : 'ONAY_BEKLIYOR';
    if (!aiOn) sig.approvalExpiresAt = now + 10 * M1;
  } else {
    sig.status = aiOn ? 'AI_BEKLIYOR' : 'AKTIF';
    sig.startedAt = now;
  }

  signals.push(sig);
  capArr(signals, 500);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + (sig.info.setup || sig.info.shape || sig.info.tf || ''));
  onSignalAdded(sig);

  if (aiOn) queueAI(sig);
  else if (raw.module === 'PUMP' && canAutoOpen('PUMP')) {
    openTrade(sig).then(r => {
      if (!r || r.error) {
        sig.status = 'ONAY_BEKLIYOR';
        sig.approvalExpiresAt = Date.now() + 10 * M1;
        sig.aiGate = Object.assign({}, sig.aiGate, { note: 'Oto açılamadı: ' + ((r && r.error) || 'bilinmeyen') });
      }
    }).catch(() => {});
  }
  return sig;
}

function onSignalAdded(sig) {
  try { appendDecision({ kind: 'SIG', id: sig.id, module: sig.module, symbol: sig.symbol, dir: sig.dir, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, conf: sig.conf, setup: sig.info.setup || sig.info.shape || sig.info.tf }); } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════════════════════
   AI HAZIRLIK + KUYRUK (Worker → Parça 3)
   ══════════════════════════════════════════════════════════════════════════════ */

function aiReady() {
  if (settings.aiEnabled !== true) return false;
  for (const p of AI_PROV) {
    if (p.key && Date.now() >= (p.cooldownUntil || 0)) return true;
  }
  return false;
}

function queueAI(sig) {
  if (!sig) return;
  if (sig.aiGate && sig.aiGate.state === 'QUEUED') return;
  sig.aiGate = { state: 'QUEUED', queuedAt: Date.now(), note: 'AI sırasında' };
  AI_QUEUE.push(sig.id);
  capArr(AI_QUEUE, 100);
  dirty = true;
}

function canAutoOpen(module) {
  const opening = paper.open.filter(p => p.module === module).length + LIVE.open.filter(p => p.module === module).length;
  const limit = module === 'AUTO' ? settings.autoMaxOpen : settings.maxOpen;
  if (opening >= limit) return false;
  if (module === 'AUTO') {
    const hk = Math.floor(Date.now() / H1);
    if (AUTO_AI.hk !== hk) { AUTO_AI.hk = hk; AUTO_AI.count = 0; }
    if (AUTO_AI.count >= settings.autoAiPerHour) return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PAPER TRADING
   ══════════════════════════════════════════════════════════════════════════════ */

function paperMargin() { return Math.max(10, num(settings.margin, 100)); }

function openPaper(sig) {
  if (!sig) return { error: 'sinyal yok' };
  if (sig.status === 'KAPANDI' || sig.status === 'IPTAL') return { error: 'sinyal kapalı' };

  const opening = paper.open.length;
  if (opening >= settings.maxOpen + settings.autoMaxOpen) return { error: 'max açık işlem' };

  const d = sig.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0)) return { error: 'geçersiz SL' };

  const margin = paperMargin();
  const lev = Math.max(1, settings.leverage);
  const notional = margin * lev;
  const riskAmount = margin * (num(settings.riskPct, 0.5) / 100);
  const qtyByRisk = riskAmount / risk;
  const qtyByNotional = notional / sig.entry;
  const qty = Math.max(1e-8, Math.min(qtyByRisk, qtyByNotional));

  if (paper.equity < margin * 0.5) return { error: 'bakiye düşük' };

  const costPaid = sig.entry * qty * EX.FEE * 2;
  const pos = {
    id: 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry: sig.entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    tp1Hit: false, single: !!sig.single,
    initialQty: qty, remainingQty: qty, qty,
    grossRealized: 0, costPaid,
    margin, leverage: lev,
    openedAt: Date.now(),
    maxHoldMs: sig.holdSec ? sig.holdSec * 1000 : Math.min(sig.maxAgeMs || H4, 6 * H1),
    maxR: 0, livePrice: sig.entry, livePnl: -costPaid, livePnlPct: -costPaid / margin * 100, ageMs: 0
  };

  paper.open.push(pos);
  const s = signals.find(x => x.id === sig.id);
  if (s) { s.status = 'AKTIF'; s.isLive = false; s.startedAt = pos.openedAt; }

  log('PAPER AÇILDI: ' + sig.base + ' ' + sig.dir + ' | entry ' + sig.entry + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | qty ' + qty.toFixed(4) + ' | marj ' + margin);
  dirty = true;
  return { ok: true, pos };
}

function closePortion(pos, qty, px) {
  if (!(qty > 0) || qty > pos.remainingQty) return;
  const d = pos.dir === 'LONG' ? 1 : -1;
  const realized = (px - pos.entry) * d * qty;
  const fee = px * qty * EX.FEE;
  pos.grossRealized += realized;
  pos.costPaid += fee;
  pos.remainingQty = +(pos.remainingQty - qty).toFixed(8);
  dirty = true;
}

function closePaper(pos, px, reason) {
  const idx = paper.open.indexOf(pos);
  if (idx < 0) return null;
  const d = pos.dir === 'LONG' ? 1 : -1;

  if (pos.remainingQty > 0) {
    const realized = (px - pos.entry) * d * pos.remainingQty;
    const fee = px * pos.remainingQty * EX.FEE;
    pos.grossRealized += realized;
    pos.costPaid += fee;
    pos.remainingQty = 0;
  }

  const pnl = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const netR = +((px - pos.entry) * d / Math.max(1e-9, Math.abs(pos.entry - pos.sl))).toFixed(2);

  paper.open.splice(idx, 1);
  paper.equity = +(paper.equity + pnl).toFixed(4);
  paper.peak = Math.max(paper.peak, paper.equity);

  const rec = Object.assign({}, pos, {
    closedAt: Date.now(), exit: rp(px), reason, pnl, netR,
    pnlPct: +(pnl / Math.max(0.01, pos.margin) * 100).toFixed(2),
    pnlUsdt: pnl
  });
  paper.closed.push(rec);
  capArr(paper.closed, 300);

  const s = signals.find(x => x.id === pos.sigId);
  if (s) {
    s.status = 'KAPANDI';
    s.result = reason;
    s.closedAt = Date.now();
    s.exit = rp(px);
    s.pnl = pnl;
    s.pnlUsdt = pnl;
    s.netR = netR;
  }
  log('PAPER KAPANDI: ' + pos.base + ' ' + pos.dir + ' | ' + reason + ' | ' + pnl + ' USDT (netR ' + netR + ')');
  dirty = true;
  return rec;
}

/* ══════════════════════════════════════════════════════════════════════════════
   autoFadeCheck — Kâr geri verilmesini engelle
   ══════════════════════════════════════════════════════════════════════════════ */

function autoFadeCheck(pos, px, d) {
  const rNow = (px - pos.entry) * d / Math.max(1e-9, Math.abs(pos.entry - pos.sl));
  const maxR = pos.maxR || 0;
  if (maxR >= 1.0 && rNow < maxR * 0.55) return 'FADE';
  if (maxR >= 1.5 && rNow < 0.75) return 'FADE';
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   monitorPaper — KADEMELİ KÂR KİLİDİ + MOMENTUM
   ══════════════════════════════════════════════════════════════════════════════ */

function monitorPaper() {
  const now = Date.now();
  for (const pos of paper.open.slice()) {
    const px = priceOf(pos.symbol);
    if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px);
    pos.ageMs = now - pos.openedAt;
    pos.livePnl = +((pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
    pos.livePnlPct = +(pos.livePnl / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    pos.maxR = Math.max(pos.maxR || 0, (px - pos.entry) * d / rRisk);

    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { closePaper(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL'); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { closePaper(pos, pos.tp2, 'TP2'); continue; }

    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      closePortion(pos, +(pos.initialQty * 0.5).toFixed(8), pos.tp1);
      pos.tp1Hit = true;
      pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100);
      const sig = signals.find(s => s.id === pos.sigId);
      if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
      dirty = true;
      log('TP1: ' + pos.base + ' yarısı alındı, stop ' + pos.curSl);
    }

    if (now - pos.openedAt >= pos.maxHoldMs) { closePaper(pos, px, 'TIME'); continue; }
    const fr = autoFadeCheck(pos, px, d);
    if (fr) { closePaper(pos, px, fr); continue; }

    // ═══════ KADEMELİ KÂR KİLİDİ ═══════
    if (pos.tp1Hit) {
      const rNow = (px - pos.entry) * d / rRisk;

      if (rNow >= 3.0) {
        const newSl = rp(pos.entry + d * Math.abs(pos.entry - pos.sl) * 2.0);
        if (d === 1 ? newSl > pos.curSl : newSl < pos.curSl) {
          pos.curSl = newSl;
          const sg = signals.find(s => s.id === pos.sigId); if (sg) sg.curSl = newSl;
        }
      } else if (rNow >= 2.0) {
        const newSl = rp(pos.entry + d * Math.abs(pos.entry - pos.sl) * 1.0);
        if (d === 1 ? newSl > pos.curSl : newSl < pos.curSl) {
          pos.curSl = newSl;
          const sg = signals.find(s => s.id === pos.sigId); if (sg) sg.curSl = newSl;
        }
      } else {
        const trail = rp(px - d * Math.max(pos.entry * 0.0015, Math.abs(pos.entry - pos.sl) * 0.25));
        if (d === 1 ? trail > pos.curSl : trail < pos.curSl) {
          pos.curSl = trail;
          const sg = signals.find(s => s.id === pos.sigId); if (sg) sg.curSl = trail;
        }
      }

      // Momentum: sadece kâr 1R altındaysa
      if (rNow < 1.0) {
        const tf = pos.module === 'AUTO' ? '1m' : '5m';
        const cs = (CACHE.get(pos.symbol + '|' + tf) || {}).data;
        if (cs && cs.length > 25) {
          const cl = closesOf(cs), e20 = emaArr(cl, 20);
          const l = cl[cl.length - 1], p1 = cl[cl.length - 2], em = e20[e20.length - 1];
          if (em && ((d === 1 && l < em && p1 < em) || (d === -1 && l > em && p1 > em))) {
            closePaper(pos, px, 'MOMENTUM');
            continue;
          }
        }
      }
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   CANLI İŞLEM (Bitget) — KADEMELİ KÂR KİLİDİ
   ══════════════════════════════════════════════════════════════════════════════ */

async function fastLivePrice(sym, fallback) {
  const t = tick(sym);
  if (t && t.last > 0) return t.last;
  try {
    const tk = await ex.fetchTicker(sym);
    if (tk && num(tk.last) > 0) { TICK.set(sym, { last: num(tk.last), bid: num(tk.bid), ask: num(tk.ask), qv: num(tk.quoteVolume), chg: num(tk.percentage), ts: Date.now() }); return num(tk.last); }
  } catch (e) {}
  return fallback || 0;
}

async function openLive(sig) {
  if (!HAS_KEYS) return { error: 'API anahtarı yok' };
  if (!sig) return { error: 'sinyal yok' };
  if (LIVE.busy) return { error: 'canlı işlem meşgul' };

  LIVE.busy = true;
  try {
    const d = sig.dir === 'LONG' ? 1 : -1;
    const risk = Math.abs(sig.entry - sig.sl);
    if (!(risk > 0)) return { error: 'geçersiz SL' };

    const margin = paperMargin();
    const lev = Math.max(1, settings.leverage);
    const riskAmount = margin * (num(settings.riskPct, 0.5) / 100);
    const qtyByRisk = riskAmount / risk;
    const qtyByNotional = margin * lev / sig.entry;
    const qty = Math.max(1e-8, Math.min(qtyByRisk, qtyByNotional));

    const side = sig.dir === 'LONG' ? 'buy' : 'sell';
    const order = await ex.createOrder(sig.symbol, 'market', side, qty);
    if (!order || !order.id) return { error: 'emir oluşturulamadı' };

    const fillPx = num(order.average || order.price, sig.entry);

    let stopOrderId = null;
    try {
      const stopSide = sig.dir === 'LONG' ? 'sell' : 'buy';
      const stopOrd = await ex.createOrder(sig.symbol, 'stop_market', stopSide, qty, undefined, { triggerPrice: sig.sl, reduceOnly: true });
      stopOrderId = stopOrd && stopOrd.id ? stopOrd.id : null;
    } catch (e) { log('Stop emri oluşturulamadı: ' + redact(e.message)); }

    const pos = {
      id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
      entry: rp(fillPx), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
      tp1Hit: false, single: !!sig.single,
      initialQty: qty, remainingQty: qty, qty,
      grossRealized: 0, costPaid: fillPx * qty * EX.FEE * 2,
      margin, leverage: lev,
      openedAt: Date.now(), maxHoldMs: sig.holdSec ? sig.holdSec * 1000 : Math.min(sig.maxAgeMs || H4, 6 * H1),
      maxR: 0, livePrice: rp(fillPx), livePnl: 0, livePnlPct: 0, ageMs: 0,
      isLive: true, orderId: order.id, stopOrderId, markPrice: rp(fillPx)
    };

    LIVE.open.push(pos);
    const s = signals.find(x => x.id === sig.id);
    if (s) { s.status = 'AKTIF'; s.isLive = true; s.startedAt = pos.openedAt; }

    log('CANLI AÇILDI: ' + sig.base + ' ' + sig.dir + ' | fill ' + pos.entry + ' | qty ' + qty.toFixed(4) + ' | stopId ' + stopOrderId);
    dirty = true;
    return { ok: true, pos };
  } catch (e) {
    log('Canlı açılış hatası: ' + redact(e.message));
    return { error: redact(e.message) };
  } finally {
    LIVE.busy = false;
  }
}

async function liveClose(pos, px, reason, qty) {
  if (!HAS_KEYS) return { error: 'API anahtarı yok' };
  if (!pos) return { error: 'pozisyon yok' };
  if (pos.closing) return { error: 'zaten kapatılıyor' };

  const d = pos.dir === 'LONG' ? 1 : -1;
  const closeQty = qty && qty > 0 ? qty : pos.remainingQty;

  pos.closing = true;
  try {
    const side = pos.dir === 'LONG' ? 'sell' : 'buy';
    const order = await ex.createOrder(pos.symbol, 'market', side, closeQty, undefined, { reduceOnly: true });
    const fillPx = num(order && order.average, px || priceOf(pos.symbol));
    const realized = (fillPx - pos.entry) * d * closeQty;
    const fee = fillPx * closeQty * EX.FEE;
    pos.grossRealized += realized;
    pos.costPaid += fee;
    pos.remainingQty = +(pos.remainingQty - closeQty).toFixed(8);

    if (pos.remainingQty <= 1e-8) {
      const idx = LIVE.open.indexOf(pos);
      if (idx >= 0) LIVE.open.splice(idx, 1);
      const pnl = +(pos.grossRealized - pos.costPaid).toFixed(4);
      const rec = Object.assign({}, pos, {
        closedAt: Date.now(), exit: rp(fillPx), reason, pnl, pnlUsdt: pnl,
        pnlPct: +(pnl / Math.max(0.01, pos.margin) * 100).toFixed(2),
        netR: +((fillPx - pos.entry) * d / Math.max(1e-9, Math.abs(pos.entry - pos.sl))).toFixed(2)
      });
      LIVE.closed.push(rec);
      capArr(LIVE.closed, 200);
      const s = signals.find(x => x.id === pos.sigId);
      if (s) { s.status = 'KAPANDI'; s.result = reason; s.closedAt = Date.now(); s.exit = rp(fillPx); s.pnl = pnl; s.pnlUsdt = pnl; }
      log('CANLI KAPANDI: ' + pos.base + ' ' + reason + ' | ' + pnl + ' USDT');
    }
    dirty = true;
    return { ok: true, fillPx, closeQty };
  } catch (e) {
    log('Canlı kapatma hatası: ' + redact(e.message));
    return { error: redact(e.message) };
  } finally {
    pos.closing = false;
  }
}

async function monitorLive() {
  if (!HAS_KEYS || !LIVE.open.length) return;
  for (const pos of LIVE.open.slice()) {
    if (pos.closing) continue;
    const px = await fastLivePrice(pos.symbol, pos.markPrice || pos.entry);
    if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px);
    pos.markPrice = rp(px);
    pos.ageMs = Date.now() - pos.openedAt;
    const unreal = (pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty;
    pos.livePnl = +unreal.toFixed(4);
    pos.livePnlPct = +(unreal / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    pos.maxR = Math.max(pos.maxR || 0, (px - pos.entry) * d / rRisk);

    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { await liveClose(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL'); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { await liveClose(pos, pos.tp2, 'TP2'); continue; }

    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const r = await liveClose(pos, pos.tp1, 'TP1', +(pos.initialQty * 0.5).toFixed(8));
      if (r && !r.error) {
        pos.tp1Hit = true;
        pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100);
        const sg = signals.find(s => s.id === pos.sigId);
        if (sg) { sg.tp1Hit = true; sg.curSl = pos.curSl; }
        dirty = true;
        log('CANLI TP1: ' + pos.base + ' yarısı alındı, stop ' + pos.curSl);
      }
      continue;
    }

    if (pos.ageMs >= pos.maxHoldMs) { await liveClose(pos, px, 'TIME'); continue; }
    const fr = autoFadeCheck(pos, px, d);
    if (fr) { await liveClose(pos, px, fr); continue; }

    // ═══════ KADEMELİ KÂR KİLİDİ (CANLI) ═══════
    if (pos.tp1Hit) {
      const rNow = (px - pos.entry) * d / rRisk;
      let newSl = pos.curSl;

      if (rNow >= 3.0) {
        newSl = rp(pos.entry + d * Math.abs(pos.entry - pos.sl) * 2.0);
      } else if (rNow >= 2.0) {
        newSl = rp(pos.entry + d * Math.abs(pos.entry - pos.sl) * 1.0);
      } else {
        newSl = rp(px - d * Math.max(pos.entry * 0.0015, Math.abs(pos.entry - pos.sl) * 0.25));
      }

      if (d === 1 ? newSl > pos.curSl : newSl < pos.curSl) {
        pos.curSl = newSl;
        const sg = signals.find(s => s.id === pos.sigId); if (sg) sg.curSl = newSl;
        // Borsa stop emrini güncelle
        try {
          if (pos.stopOrderId) { try { await ex.cancelOrder(pos.stopOrderId, pos.symbol); } catch (e) {} }
          const stopSide = pos.dir === 'LONG' ? 'sell' : 'buy';
          const stopOrd = await ex.createOrder(pos.symbol, 'stop_market', stopSide, pos.remainingQty, undefined, { triggerPrice: newSl, reduceOnly: true });
          pos.stopOrderId = stopOrd && stopOrd.id ? stopOrd.id : null;
          log('CANLI STOP GÜNCELLENDİ: ' + pos.base + ' → ' + newSl);
        } catch (e) { log('Stop güncelleme hatası: ' + redact(e.message)); }
      }
    }
  }
  LIVE.lastSync = Date.now();
}

/* ══════════════════════════════════════════════════════════════════════════════
   openTrade — mod yönlendirici
   ══════════════════════════════════════════════════════════════════════════════ */

async function openTrade(sig) {
  if (!sig) return { error: 'sinyal yok' };
  if (sig.status === 'KAPANDI' || sig.status === 'IPTAL') return { error: 'sinyal kapalı' };
  if (!canAutoOpen(sig.module)) return { error: 'max açık işlem (' + sig.module + ')' };

  if (settings.tradeMode === 'live' && HAS_KEYS) {
    return await openLive(sig);
  }
  return openPaper(sig);
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTO (Pump/Dump) TARAMA — 1m ani hareket
   ══════════════════════════════════════════════════════════════════════════════ */

function autoCandidates(sym, cs1m) {
  if (!cs1m || cs1m.length < 30) return null;
  const n = cs1m.length;
  const last = cs1m[n - 1];
  const prev = cs1m[n - 2];
  if (!last || !prev) return null;
  const atr = atrLast(cs1m, 14);
  if (!atr || atr <= 0) return null;

  const vol20 = avg(cs1m.slice(-20, -1).map(c => c.v));
  const volRatio = vol20 > 0 ? last.v / vol20 : 0;
  const bodyPct = (last.c - last.o) / last.o * 100;
  const rangePct = (last.h - last.l) / last.o * 100;

  if (volRatio < 2.5 || rangePct < 0.6) return null;

  let dir = null;
  if (bodyPct > 0.4 && last.c > prev.h) dir = 'LONG';
  else if (bodyPct < -0.4 && last.c < prev.l) dir = 'SHORT';
  if (!dir) return null;

  const d = dir === 'LONG' ? 1 : -1;
  const entry = last.c;
  const sl = d === 1 ? Math.min(last.l, prev.l) - 0.3 * atr : Math.max(last.h, prev.h) + 0.3 * atr;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const riskPct = risk / entry * 100;
  if (riskPct < 0.30 || riskPct > EX.MAX_RISK_PCT) return null;

  const tp1 = entry + d * risk * 1.5;
  const tp2 = entry + d * risk * 2.5;
  const q1 = rrNet(entry, sl, tp1);
  const q2 = rrNet(entry, sl, tp2);
  if (q1.net < 0.85) return null;

  const conf = clamp(Math.round(50 + Math.min(volRatio, 6) * 7 + Math.min(Math.abs(bodyPct), 3) * 5), 40, 95);

  return {
    module: 'AUTO', symbol: sym, base: baseOf(sym), dir,
    entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2),
    single: false, conf, holdSec: 15 * 60, noMoveSec: 5 * 60,
    info: {
      tf: '1m', source: 'math', setup: 'PumpDump',
      plan: { entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) },
      netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2),
      volRatio: +volRatio.toFixed(2), bodyPct: +bodyPct.toFixed(2), rangePct: +rangePct.toFixed(2),
      atrPct: +(atr / entry * 100).toFixed(2)
    },
    maxAgeMs: 30 * M1,
    setupKey: 'AUTO|' + sym + '|' + Math.floor(last.t / M1) + '|' + dir
  };
}

let autoScanning = false;
async function autoScan() {
  if (autoScanning) return;
  autoScanning = true;
  try {
    const list = scanSyms('AUTO', 30);
    const found = [];
    await pool(list, 6, async (sym) => {
      const cs = await getCandles(sym, '1m', 120, true);
      if (!cs || cs.length < 30) return;
      const raw = autoCandidates(sym, cs);
      if (raw) found.push(raw);
    });
    found.sort((a, b) => b.conf - a.conf);
    let emitted = 0;
    for (const raw of found) {
      if (emitted >= 3) break;
      const prev = AUTO_FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 10 * M1) continue;
      const sig = addSignal(raw);
      if (sig) {
        AUTO_FIRED.set(raw.setupKey, Date.now());
        AUTO_AI.count = (AUTO_AI.count || 0) + 1;
        emitted++;
        log('AUTO SİNYAL: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | vol ' + raw.info.volRatio + 'x');
      }
    }
    buildAutoWatch();
    lastScan.auto = Date.now();
  } catch (e) { log('AUTO tarama hatası: ' + redact(e.message)); }
  finally { autoScanning = false; }
}

function buildAutoWatch() {
  const rows = [];
  for (const sym of UNIVERSE.slice(0, 30)) {
    const cs = (CACHE.get(sym + '|1m') || {}).data;
    if (!cs || cs.length < 20) continue;
    const last = cs[cs.length - 1];
    const vol20 = avg(cs.slice(-20, -1).map(c => c.v));
    const volRatio = vol20 > 0 ? last.v / vol20 : 0;
    const bodyPct = (last.c - last.o) / last.o * 100;
    if (volRatio >= 1.5 && Math.abs(bodyPct) >= 0.2) {
      rows.push({
        symbol: sym, base: baseOf(sym), price: rp(last.c),
        volRatio: +volRatio.toFixed(2), bodyPct: +bodyPct.toFixed(2),
        dirHint: bodyPct > 0 ? 'LONG' : 'SHORT',
        status: volRatio >= 2.5 && Math.abs(bodyPct) >= 0.4 ? 'TETİK' : 'İZLE',
        ai: null
      });
    }
  }
  rows.sort((a, b) => b.volRatio - a.volRatio);
  AUTO_WATCH = rows.slice(0, 20);
  WATCH.auto = AUTO_WATCH;
  WATCH_META.auto = { scannedAt: Date.now(), count: AUTO_WATCH.length };
}
/* ══════════════════════════════════════════════════════════════════════════════
   AI WORKER — Gemini/DeepSeek/Groq/OpenRouter/OpenAI sırayla dener
   ══════════════════════════════════════════════════════════════════════════════ */

async function httpJSON(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 25000);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (e) {}
    return { ok: res.ok, status: res.status, json, txt };
  } catch (e) {
    return { ok: false, status: 0, json: null, txt: e.message };
  } finally { clearTimeout(timer); }
}

function pickProvider(skipIds) {
  const now = Date.now();
  const hourKey = Math.floor(now / H1);
  if (AI_USAGE.hourKey !== hourKey) { AI_USAGE.hourKey = hourKey; AI_USAGE.hourCount = 0; }
  if (AI_USAGE.dayKey !== dayKey()) { AI_USAGE.dayKey = dayKey(); AI_USAGE.dayCount = 0; }

  const skip = skipIds || new Set();
  const list = AI_PROV
    .filter(p => p.key && !skip.has(p.id) && now >= (p.cooldownUntil || 0))
    .filter(p => (p.dayKey !== dayKey()) || (p.dayCount < p.dayLimit))
    .sort((a, b) => (a.prefer || 99) - (b.prefer || 99));
  return list[0] || null;
}

async function callAI(messages, opts) {
  const skip = new Set();
  const maxTries = AI_PROV.length;
  let lastErr = null;

  for (let i = 0; i < maxTries; i++) {
    const p = pickProvider(skip);
    if (!p) break;
    skip.add(p.id);

    const models = (p.models || []).slice(0, 3);
    for (const model of models) {
      if ((p.modelCooldowns || {})[model] && Date.now() < p.modelCooldowns[model]) continue;

      const url = p.base.replace(/\/+$/, '') + '/chat/completions';
      const t0 = Date.now();
      const r = await httpJSON(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + p.key
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: num(opts && opts.temperature, 0.15),
          max_tokens: num(opts && opts.maxTokens, 500),
          response_format: opts && opts.json ? { type: 'json_object' } : undefined
        })
      }, opts && opts.timeout || 28000);

      const lat = Date.now() - t0;
      p.lat.push(lat); if (p.lat.length > 20) p.lat.shift();

      if (r.ok && r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message) {
        const content = r.json.choices[0].message.content || '';
        p.ok++;
        if (p.dayKey !== dayKey()) { p.dayKey = dayKey(); p.dayCount = 0; }
        p.dayCount++;
        AI_USAGE.dayCount++;
        AI_USAGE.hourCount++;
        AI_STATE.lastAt = Date.now();
        AI_STATE.lastError = null;
        return { ok: true, provider: p.id, providerName: p.name, model, content, lat };
      }

      // Hata kaydet
      const errTxt = r.txt || '';
      p.fail++;
      p.lastError = errTxt.slice(0, 300);
      AI_STATE.lastError = errTxt.slice(0, 300);

      // Rate limit / kota hatası → provider cooldown
      if (r.status === 429 || /quota|rate.?limit|exceeded/i.test(errTxt)) {
        p.cooldownUntil = Date.now() + 10 * M1;
        break;
      }
      // 404 model → model cooldown
      if (r.status === 404 || /model.*not.*found|invalid.*model/i.test(errTxt)) {
        p.modelCooldowns = p.modelCooldowns || {};
        p.modelCooldowns[model] = Date.now() + 30 * M1;
        continue;
      }
      // 401/403 → provider cooldown uzun
      if (r.status === 401 || r.status === 403) {
        p.cooldownUntil = Date.now() + 60 * M1;
        break;
      }
      // Diğer hatalar → sonraki model
      lastErr = r.status + ' ' + errTxt.slice(0, 120);
    }
  }

  return { ok: false, error: lastErr || 'hiçbir AI sağlayıcı yanıt vermedi' };
}

/* ---- AI Prompt ---- */

function buildAIPrompt(sig, extra) {
  const px = priceOf(sig.symbol) || sig.entry;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  const rNow = risk > 0 ? (px - sig.entry) * d / risk : 0;

  const systemMsg = 'Sen deneyimli bir kripto vadeli işlem traderısın. Sana bir sinyal adayı veriyorum. Görevin: bu sinyalin GİRİLİP girilmeyeceğine karar vermek. SADECE JSON döndür.';

  const userMsg = `SİNYAL ADAYI:
Modül: ${sig.module}
Coin: ${sig.base} (${sig.symbol})
Yön: ${sig.dir}
Giriş: ${sig.entry}
Stop: ${sig.sl}
TP1: ${sig.tp1}
${sig.tp2 ? 'TP2: ' + sig.tp2 + '\n' : ''}Güven (matematik): ${sig.conf}
Net R:R: ${sig.info && sig.info.netRR ? sig.info.netRR : '?'}
Risk %: ${sig.info && sig.info.riskPct ? sig.info.riskPct : '?'}
Setup: ${sig.info && (sig.info.setup || sig.info.shape) || '?'}
Anlık fiyat: ${px}
Anlık R: ${rNow.toFixed(2)}R
Piyasa yönü (AI): ${market.dir}
${extra || ''}

GÖREV: Bu sinyale girilir mi? 
- Fiyat çok kaçmışsa (R > 0.5) GİRME.
- Piyasa yönü ters VE sinyal karşıtı ise dikkatli ol; ama anlık fırsat (Pump/Dump) ise piyasa yönünü yok say.
- Momentum, hacim ve plan mantıklıysa GİR.

SADECE ŞU JSON'u döndür (başka hiçbir şey yazma):
{"karar":"GIR" veya "GIRME", "guven":0-100, "neden":"kısa Türkçe açıklama (max 150 karakter)"}`;

  return [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];
}

function parseAIDecision(content, sig) {
  if (!content) return { decision: 'GIRME', conf: 50, reason: 'AI boş yanıt' };
  let txt = content.trim();
  // ```json ... ``` bloğunu çıkar
  const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) txt = m[1].trim();
  // İlk { ... } bloğunu al
  const braceM = txt.match(/\{[\s\S]*\}/);
  if (braceM) txt = braceM[0];

  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) {
    // Anahtar kelimelerden tahmin
    const upper = txt.toUpperCase();
    if (/GIRME|GİRME|HAYIR|YOK|RISKY|NO/.test(upper) && !/GIR[^M]|GİR[^M]|YES|OK/.test(upper)) {
      return { decision: 'GIRME', conf: 55, reason: 'AI olumsuz yanıt (parse edilemedi)' };
    }
    if (/GIR|GİR|YES|OK|ENTER/.test(upper)) {
      return { decision: 'GIR', conf: 60, reason: 'AI olumlu yanıt (parse edilemedi)' };
    }
    return { decision: 'GIRME', conf: 45, reason: 'AI yanıtı ayrıştırılamadı' };
  }

  const karar = String(obj.karar || obj.decision || obj.verdict || '').trim().toUpperCase();
  let decision = 'GIRME';
  if (/^(GIR|GİR|YES|OK|ENTER|LONG|SHORT|AL)$/.test(karar)) decision = 'GIR';
  else if (/^(GIRME|GİRME|NO|SKIP|AVOID|BEKLE)$/.test(karar)) decision = 'GIRME';
  else if (karar.includes('GIRME') || karar.includes('GİRME')) decision = 'GIRME';
  else if (karar.includes('GIR') || karar.includes('GİR')) decision = 'GIR';

  const conf = clamp(Math.round(num(obj.guven != null ? obj.guven : obj.confidence, 55)), 0, 100);
  const reason = String(obj.neden || obj.reason || obj.explanation || '').slice(0, 200);

  return { decision, conf, reason };
}

/* ══════════════════════════════════════════════════════════════════════════════
   enforceChecks — AI KARARI UYGULANIR (matematik karar VERMEZ)
   ══════════════════════════════════════════════════════════════════════════════ */

async function processAIQueue() {
  if (AI_STATE.busy) return;
  if (!AI_QUEUE.length) return;
  if (!aiReady()) return;

  AI_STATE.busy = true;
  try {
    while (AI_QUEUE.length) {
      const id = AI_QUEUE.shift();
      const sig = signals.find(s => s.id === id);
      if (!sig) continue;
      if (sig.status !== 'AI_BEKLIYOR') continue;
      if (!AI_QUEUE.length && Date.now() - AI_STATE.lastAt < 1500) { AI_QUEUE.unshift(id); break; }

      // Fiyat kaçtı mı kontrol
      const px = priceOf(sig.symbol);
      const d = sig.dir === 'LONG' ? 1 : -1;
      const risk = Math.max(1e-9, Math.abs(sig.entry - sig.sl));
      const rNow = px > 0 ? (px - sig.entry) * d / risk : 0;
      if (rNow > 0.85) {
        sig.status = 'KAPANDI';
        sig.result = 'AI_STALE';
        sig.closedAt = Date.now();
        sig.aiGate = { state: 'REJECTED', reason: 'fiyat kaçtı (' + rNow.toFixed(2) + 'R)', at: Date.now() };
        dirty = true;
        log('AI: ' + sig.base + ' fiyat kaçtı → GİRİLMEDİ (R=' + rNow.toFixed(2) + ')');
        continue;
      }
      if (rNow < -1.2) {
        sig.status = 'KAPANDI';
        sig.result = 'AI_STALE';
        sig.closedAt = Date.now();
        sig.aiGate = { state: 'REJECTED', reason: 'ters yön fazla (-' + Math.abs(rNow).toFixed(2) + 'R)', at: Date.now() };
        dirty = true;
        continue;
      }

      const messages = buildAIPrompt(sig);
      const res = await callAI(messages, { temperature: 0.15, maxTokens: 400, json: true, timeout: 25000 });

      if (!res.ok) {
        sig.aiGate = { state: 'ERROR', reason: res.error, at: Date.now() };
        sig.ai = { provider: null, model: null, error: res.error };
        dirty = true;
        // AI hatası → matematik kararı (fallback)
        if (sig.module === 'PUMP' && canAutoOpen('PUMP')) {
          sig.status = 'ONAY_BEKLIYOR';
          sig.approvalExpiresAt = Date.now() + 10 * M1;
        }
        log('AI HATASI (' + sig.base + '): ' + res.error);
        continue;
      }

      const p = parseAIDecision(res.content, sig);
      sig.ai = { provider: res.provider, providerName: res.providerName, model: res.model, decision: p.decision, conf: p.conf, reason: p.reason, at: Date.now(), lat: res.lat };

      if (p.decision === 'GIR') {
        sig.conf = Math.round((sig.baseConf + p.conf) / 2);
        sig.aiGate = { state: 'APPROVED', reason: p.reason, at: Date.now() };
        sig.status = 'AKTIF';
        sig.startedAt = Date.now();
        dirty = true;
        log('AI ONAY: ' + sig.base + ' ' + sig.dir + ' | ' + res.providerName + '/' + res.model + ' | ' + p.conf + ' | ' + p.reason);

        const r = await openTrade(sig);
        if (!r || r.error) {
          sig.status = 'KAPANDI';
          sig.result = 'DOLMADI';
          sig.closedAt = Date.now();
          sig.aiGate = Object.assign({}, sig.aiGate, { note: 'Açılamadı: ' + ((r && r.error) || '?') });
          dirty = true;
        }
      } else {
        sig.status = 'KAPANDI';
        sig.result = 'AI_RED';
        sig.closedAt = Date.now();
        sig.aiGate = { state: 'REJECTED', reason: p.reason, at: Date.now() };
        dirty = true;
        log('AI RED: ' + sig.base + ' ' + sig.dir + ' | ' + p.reason);
      }

      // AI istekleri arası bekleme (rate limit)
      await sleep(1200);
    }
  } catch (e) {
    log('AI worker hatası: ' + redact(e.message));
  } finally {
    AI_STATE.busy = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   MARKET AI (BTC yönü)
   ══════════════════════════════════════════════════════════════════════════════ */

async function updateMarketAI() {
  if (settings.aiEnabled !== true || !aiReady()) return;
  if (!market.btc) return;

  const b = market.btc;
  const e = market.eth || {};
  const prompt = `BTC 1h: fiyat ${b.price} | EMA20 ${b.e20} | EMA50 ${b.e50} | RSI ${b.rsi} | ATR% ${b.atrPct} | 24s değişim ${b.chg}%
ETH 1h: fiyat ${e.price} | RSI ${e.rsi} | 24s değişim ${e.chg}%
Piyasa genişliği: ${(market.breadth * 100).toFixed(0)}% yeşil

GÖREV: Önümüzdeki 15-30 dakikada kripto piyasasının yönü ne? Sadece şu JSON'u döndür:
{"yon":"YUKARI" veya "ASAGI" veya "NOTR", "skor":0-100, "neden":"kısa açıklama"}`;

  const res = await callAI([
    { role: 'system', content: 'Sen kripto piyasa analistisin. Sadece JSON döndür.' },
    { role: 'user', content: prompt }
  ], { temperature: 0.2, maxTokens: 200, json: true, timeout: 20000 });

  if (!res.ok) { logOnce('mkt-ai-fail', 'Market AI hatası: ' + res.error, 10 * M1); return; }

  let txt = res.content.trim();
  const braceM = txt.match(/\{[\s\S]*\}/);
  if (braceM) txt = braceM[0];
  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) { return; }

  const yon = String(obj.yon || obj.direction || '').toUpperCase();
  let dir = 'NOTR';
  if (/YUKARI|UP|BULL|LONG/.test(yon)) dir = 'LONG';
  else if (/ASAGI|AŞAĞI|DOWN|BEAR|SHORT/.test(yon)) dir = 'SHORT';
  const score = clamp(Math.round(num(obj.skor != null ? obj.skor : obj.score, 50)), 0, 100);
  const reason = String(obj.neden || obj.reason || '').slice(0, 180);

  marketAI = { dir, score, reason, at: Date.now(), provider: res.provider, model: res.model, hist: (marketAI.hist || []).slice(-20) };
  marketAI.hist.push({ at: Date.now(), dir, score, reason });
  dirty = true;
  log('MARKET AI: ' + dir + ' (' + score + ') | ' + reason);
}

/* ══════════════════════════════════════════════════════════════════════════════
   EXPREES HTTP API
   ══════════════════════════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function authCheck(req, res) {
  const token = process.env.API_TOKEN;
  if (!token) return true;
  const sent = req.headers['authorization'] || req.query.token || '';
  if (sent.replace(/^Bearer\s+/i, '') === token) return true;
  res.status(401).json({ error: 'yetkisiz' });
  return false;
}

/* ---- Durum ---- */
app.get('/api/health', (req, res) => res.json({
  ok: true, version: VERSION, pid: process.pid, uptime: process.uptime(),
  aiReady: aiReady(), hasKeys: HAS_KEYS, market: market.dir, queue: AI_QUEUE.length
}));

app.get('/api/state', (req, res) => {
  if (!authCheck(req, res)) return;
  const aiOn = aiReady();
  res.json({
    ok: true, version: VERSION, at: Date.now(),
    ready: READY, aiReady: aiOn, hasKeys: HAS_KEYS, tradeMode: settings.tradeMode,
    settings,
    market: { dir: market.dir, score: market.score, breadth: market.breadth, why: market.why, btc: market.btc, eth: market.eth, source: market.source, at: market.at },
    marketAI,
    counts: {
      signals: signals.length, openSignals: signals.filter(isOpenSignal).length,
      paperOpen: paper.open.length, paperClosed: paper.closed.length,
      liveOpen: LIVE.open.length, liveClosed: LIVE.closed.length,
      aiQueue: AI_QUEUE.length
    },
    paper: {
      equity: +paper.equity.toFixed(2), start: +paper.start.toFixed(2),
      pnl: +(paper.equity - paper.start).toFixed(2),
      pnlPct: +((paper.equity / paper.start - 1) * 100).toFixed(2),
      peak: +paper.peak.toFixed(2), dayStart: +paper.dayStart.toFixed(2),
      open: paper.open.length, closed: paper.closed.length
    },
    live: {
      balance: LIVE.balance, open: LIVE.open.length, closed: LIVE.closed.length,
      lastSync: LIVE.lastSync, lastError: LIVE.lastError
    },
    ai: {
      state: AI_STATE, usage: AI_USAGE,
      providers: AI_PROV.map(p => ({
        id: p.id, name: p.name, hasKey: !!p.key, ok: p.ok, fail: p.fail,
        lastError: p.lastError, cooldown: Math.max(0, (p.cooldownUntil || 0) - Date.now()),
        models: (p.models || []).slice(0, 4), dayCount: p.dayCount, dayLimit: p.dayLimit
      }))
    },
    lastScan,
    watch: { auto: AUTO_WATCH.length, scalp: SCALP_WATCH.length, lt: WATCH.lt.length }
  });
});

app.get('/api/logs', (req, res) => {
  if (!authCheck(req, res)) return;
  const n = clamp(Math.round(num(req.query.n, 100)), 10, 400);
  res.json({ ok: true, logs: LOGS.slice(-n) });
});

app.get('/api/rejections', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({ ok: true, rej: REJ.slice(-100), stat: REJ_STAT });
});

/* ---- Sinyaller ---- */
app.get('/api/signals', (req, res) => {
  if (!authCheck(req, res)) return;
  const module = String(req.query.module || '').toUpperCase();
  const openOnly = req.query.open === '1';
  let list = signals.slice();
  if (ACTIVE_MODULES.includes(module)) list = list.filter(s => s.module === module);
  if (openOnly) list = list.filter(isOpenSignal);
  list.sort((a, b) => b.createdAt - a.createdAt);
  const n = clamp(Math.round(num(req.query.n, 50)), 1, 500);
  res.json({ ok: true, signals: list.slice(0, n).map(viewSignal) });
});

app.get('/api/signal/:id', (req, res) => {
  if (!authCheck(req, res)) return;
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'bulunamadı' });
  res.json({ ok: true, signal: viewSignal(s) });
});

app.post('/api/signal/:id/approve', async (req, res) => {
  if (!authCheck(req, res)) return;
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'bulunamadı' });
  if (!isOpenSignal(s)) return res.json({ error: 'sinyal açık değil' });
  s.status = 'AKTIF';
  s.startedAt = Date.now();
  s.aiGate = { state: 'MANUAL', reason: 'kullanıcı onayı', at: Date.now() };
  const r = await openTrade(s);
  dirty = true;
  res.json({ ok: !!r && !r.error, result: r });
});

app.post('/api/signal/:id/reject', (req, res) => {
  if (!authCheck(req, res)) return;
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'bulunamadı' });
  if (!isOpenSignal(s)) return res.json({ error: 'sinyal açık değil' });
  s.status = 'KAPANDI';
  s.result = 'MANUEL';
  s.closedAt = Date.now();
  dirty = true;
  res.json({ ok: true });
});

/* ---- Paper / Live ---- */
app.get('/api/paper', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({
    ok: true,
    equity: +paper.equity.toFixed(2), start: +paper.start.toFixed(2),
    pnl: +(paper.equity - paper.start).toFixed(2),
    pnlPct: +((paper.equity / paper.start - 1) * 100).toFixed(2),
    peak: +paper.peak.toFixed(2),
    open: paper.open,
    closed: paper.closed.slice(-100)
  });
});

app.get('/api/live', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({
    ok: true, hasKeys: HAS_KEYS, balance: LIVE.balance, open: LIVE.open,
    closed: LIVE.closed.slice(-100), lastSync: LIVE.lastSync, lastError: LIVE.lastError
  });
});

app.post('/api/paper/:id/close', (req, res) => {
  if (!authCheck(req, res)) return;
  const p = paper.open.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'pozisyon yok' });
  const px = priceOf(p.symbol);
  const rec = closePaper(p, px, 'MANUEL');
  res.json({ ok: true, closed: rec });
});

app.post('/api/live/:id/close', async (req, res) => {
  if (!authCheck(req, res)) return;
  const p = LIVE.open.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'pozisyon yok' });
  const px = await fastLivePrice(p.symbol, p.markPrice);
  const r = await liveClose(p, px, 'MANUEL');
  res.json({ ok: !r.error, result: r });
});

/* ---- Ayarlar ---- */
app.post('/api/settings', (req, res) => {
  if (!authCheck(req, res)) return;
  const old = JSON.parse(JSON.stringify(settings));
  settings = sanitizeSettings(Object.assign({}, settings, req.body || {}));
  if (settings.tradeMode === 'live' && !HAS_KEYS) {
    settings.tradeMode = 'paper';
    log('Canlı mod için API anahtarı yok → paper moda dönüldü');
  }
  dirty = true;
  saveState(true);
  log('AYARLAR GÜNCELLENDİ: tradeMode=' + settings.tradeMode + ', aiEnabled=' + settings.aiEnabled + ', autoTrade=' + settings.autoTrade);
  res.json({ ok: true, settings, previous: old });
});

/* ---- AI / Gözlem ---- */
app.get('/api/ai/history', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({ ok: true, hist: AI_HIST.slice(-100), state: AI_STATE, queue: AI_QUEUE.length });
});

app.get('/api/ai/test', async (req, res) => {
  if (!authCheck(req, res)) return;
  const r = await callAI([
    { role: 'system', content: 'Test.' },
    { role: 'user', content: 'Sadece OK yaz.' }
  ], { maxTokens: 20, timeout: 15000 });
  res.json({ ok: r.ok, result: r });
});

app.post('/api/ai/market-refresh', async (req, res) => {
  if (!authCheck(req, res)) return;
  try { await updateMarket(); await updateMarketAI(); res.json({ ok: true, market, marketAI }); }
  catch (e) { res.json({ error: redact(e.message) }); }
});

app.get('/api/ai/providers', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({
    ok: true,
    providers: AI_PROV.map(p => ({
      id: p.id, name: p.name, hasKey: !!p.key, ok: p.ok, fail: p.fail, invalid: p.invalid,
      lastError: p.lastError, cooldownUntil: p.cooldownUntil, models: p.models,
      dayCount: p.dayCount, dayLimit: p.dayLimit, lat: p.lat.slice(-5)
    })),
    usage: AI_USAGE
  });
});

/* ---- İzleme ---- */
app.get('/api/watch', (req, res) => {
  if (!authCheck(req, res)) return;
  res.json({ ok: true, watch: WATCH, meta: WATCH_META, auto: AUTO_WATCH, scalp: SCALP_WATCH, lt: WATCH.lt });
});

/* ---- Kararlar ---- */
app.get('/api/decisions', (req, res) => {
  if (!authCheck(req, res)) return;
  const n = clamp(Math.round(num(req.query.n, 100)), 1, 500);
  res.json({ ok: true, decisions: readDecisions(n) });
});

/* ---- Backtest (basit) ---- */
app.get('/api/backtest', (req, res) => {
  if (!authCheck(req, res)) return;
  const wins = paper.closed.filter(p => (p.pnl || 0) > 0);
  const losses = paper.closed.filter(p => (p.pnl || 0) < 0);
  const totalPnl = sum(paper.closed.map(p => p.pnl || 0));
  const totalWin = sum(wins.map(p => p.pnl || 0));
  const totalLoss = Math.abs(sum(losses.map(p => p.pnl || 0)));
  const pf = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
  res.json({
    ok: true,
    total: paper.closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: paper.closed.length ? +(wins.length / paper.closed.length * 100).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(2),
    profitFactor: +pf.toFixed(2),
    avgWin: wins.length ? +(totalWin / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(totalLoss / losses.length).toFixed(2) : 0,
    byModule: ['AUTO', 'PUMP', 'LT'].reduce((acc, m) => {
      const arr = paper.closed.filter(p => p.module === m);
      const w = arr.filter(p => (p.pnl || 0) > 0).length;
      acc[m] = { total: arr.length, wins: w, pnl: +sum(arr.map(p => p.pnl || 0)).toFixed(2) };
      return acc;
    }, {})
  });
});

app.post('/api/scan/:kind', async (req, res) => {
  if (!authCheck(req, res)) return;
  const kind = req.params.kind;
  try {
    if (kind === 'auto') await autoScan();
    else if (kind === 'scalp' || kind === 'pump') await scalpScan();
    else if (kind === 'lt') await ltScan();
    else return res.status(400).json({ error: 'geçersiz kind' });
    res.json({ ok: true, kind, lastScan });
  } catch (e) { res.json({ error: redact(e.message) }); }
});

app.get('/', (req, res) => res.redirect('/index.html'));

/* ══════════════════════════════════════════════════════════════════════════════
   DÖNGÜLER
   ══════════════════════════════════════════════════════════════════════════════ */

const loopTimers = [];
let loopRunning = false;

async function safeRun(name, fn) {
  try { await fn(); } catch (e) { logOnce('loop-' + name, 'Döngü hatası (' + name + '): ' + redact(e.message), 2 * M1); }
}

function startLoops() {
  if (loopRunning) return;
  loopRunning = true;

  // Evren güncelleme — 10 dk
  loopTimers.push(setInterval(() => safeRun('universe', async () => {
    await refreshUniverse();
  }), 10 * M1));

  // Ticker — 30 sn
  loopTimers.push(setInterval(() => safeRun('tickers', async () => {
    await refreshTickers();
  }), 30 * M1 ? 30 * 1000 : 30000));

  // Piyasa rejimi — 2 dk
  loopTimers.push(setInterval(() => safeRun('market', async () => {
    await updateMarket();
  }), 2 * M1));

  // Market AI — 5 dk
  loopTimers.push(setInterval(() => safeRun('marketAI', async () => {
    await updateMarketAI();
  }), 5 * M1));

  // AUTO tarama — 30 sn
  loopTimers.push(setInterval(() => safeRun('autoScan', async () => {
    if (settings.autoTrade === true) await autoScan();
  }), 30 * 1000));

  // Scalp tarama — 90 sn
  loopTimers.push(setInterval(() => safeRun('scalpScan', async () => {
    await scalpScan();
  }), 90 * 1000));

  // LT tarama — 5 dk
  loopTimers.push(setInterval(() => safeRun('ltScan', async () => {
    await ltScan();
  }), 5 * M1));

  // LT canlı tick — 20 sn
  loopTimers.push(setInterval(() => safeRun('ltTick', () => {
    ltTick();
  }), 20 * 1000));

  // Paper monitör — 5 sn
  loopTimers.push(setInterval(() => safeRun('monitorPaper', () => {
    monitorPaper();
  }), 5 * 1000));

  // Canlı monitör — 15 sn
  loopTimers.push(setInterval(() => safeRun('monitorLive', async () => {
    await monitorLive();
  }), 15 * 1000));

  // AI kuyruk — 4 sn
  loopTimers.push(setInterval(() => safeRun('aiQueue', async () => {
    await processAIQueue();
  }), 4 * 1000));

  // Durum kaydet — 30 sn
  loopTimers.push(setInterval(() => safeRun('save', () => {
    saveState(false);
  }), 30 * 1000));

  // Sinyal yaşlandırma + temizlik — 1 dk
  loopTimers.push(setInterval(() => safeRun('expire', () => {
    const now = Date.now();
    for (const s of signals) {
      if (s.status === 'AI_BEKLIYOR' && s.createdAt < now - 10 * M1) {
        s.status = 'KAPANDI';
        s.result = 'AI_TIMEOUT';
        s.closedAt = now;
        s.aiGate = Object.assign({}, s.aiGate || {}, { state: 'TIMEOUT', reason: 'AI 10 dk yanıt vermedi' });
        dirty = true;
      }
      if (s.status === 'ONAY_BEKLIYOR' && s.approvalExpiresAt && now > s.approvalExpiresAt) {
        s.status = 'KAPANDI';
        s.result = 'APPROVAL_EXPIRED';
        s.closedAt = now;
        dirty = true;
      }
      if (isOpenSignal(s) && now - s.createdAt > (s.maxAgeMs || H4) * 1.5) {
        s.status = 'KAPANDI';
        s.result = 'TIME';
        s.closedAt = now;
        dirty = true;
      }
    }
    capArr(signals, 500);
    capMap(FIRED, 500);
    capMap(AUTO_FIRED, 300);
  }), 60 * 1000));

  log('Döngüler başlatıldı (' + loopTimers.length + ' adet)');
}

/* ══════════════════════════════════════════════════════════════════════════════
   BAŞLANGIÇ
   ══════════════════════════════════════════════════════════════════════════════ */

process.on('unhandledRejection', e => log('unhandledRejection: ' + redact(e && e.message)));
process.on('uncaughtException', e => log('uncaughtException: ' + redact(e && e.message)));

async function init() {
  log('══════════════════════════════════════════');
  log('AlphaSon ' + VERSION + ' başlatılıyor...');
  log('Veri dizini: ' + DATA_DIR);
  log('API anahtarı: ' + (HAS_KEYS ? 'VAR' : 'YOK (paper mod)'));
  log('AI sağlayıcılar: ' + AI_PROV.filter(p => p.key).map(p => p.name).join(', ') || 'YOK');
  log('══════════════════════════════════════════');

  loadState();

  // İlk veri çekimi
  try {
    await refreshUniverse();
    await refreshTickers();
    log('Evren: ' + UNIVERSE.length + ' coin');
  } catch (e) { log('İlk veri hatası: ' + redact(e.message)); }

  await updateMarket();
  log('Piyasa: ' + market.dir + ' | ' + market.why);

  if (settings.aiEnabled) {
    await updateMarketAI();
    log('Market AI: ' + marketAI.dir + ' (' + marketAI.score + ')');
  }

  READY = true;
  dirty = true;
  saveState(true);

  startLoops();

  // İlk taramaları hemen başlat (gecikmeli)
  setTimeout(() => safeRun('initAuto', async () => { if (settings.autoTrade) await autoScan(); }), 5000);
  setTimeout(() => safeRun('initScalp', async () => { await scalpScan(); }), 8000);
  setTimeout(() => safeRun('initLt', async () => { await ltScan(); }), 12000);

  log('HAZIR. HTTP http://0.0.0.0:' + PORT + ' | AI ' + (aiReady() ? 'AÇIK' : 'KAPALI') + ' | Mod ' + settings.tradeMode);
}

app.listen(PORT, '0.0.0.0', () => {
  init().catch(e => {
    log('init hatası: ' + redact(e.message));
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  log('SIGINT — kapatılıyor...');
  try { saveState(true); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('SIGTERM — kapatılıyor...');
  try { saveState(true); } catch (e) {}
  process.exit(0);
});
