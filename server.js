'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v85.0 — tek dosya sunucu
   Modüller: 1) OtoTrade (Pump/Dump, 1m)  2) LT Üçgen (2h, TradingView tarzı trend çizgileri)
             3) Günlük Hızlı Scalp (5m: ORB / VWAP pullback / VWAP 2σ dönüş)
   v85: kurulum bazlı AI kontrol listeleri, bozuk AI yanıtı doğrulaması, sağlayıcı günlük kota takibi,
        büyük pivotlardan geçen trend çizgileri, Bitget IP hatası teşhisi, gölge sonuç ölçümü,
        tokenize hisse filtresi (LT hariç), mum içi OtoTrade adayları.
   ══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const ccxt = require('ccxt');

/* ───────── .env ───────── */
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

/* ───────── sabitler ───────── */
const VERSION = 'v85.0';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1;
const H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '2h': H2, '4h': H4, '1d': D1 };
const TTL = { '1m': 8e3, '3m': 30e3, '5m': 45e3, '15m': 90e3, '1h': 5 * M1, '2h': 10 * M1, '4h': 15 * M1, '1d': 30 * M1 };
const EPS = 1e-9;
const LT_BARS = 1200;

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(os.tmpdir(), 'alphason-v85');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) { /* yok */ }
    return alt;
  }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEC_FILE = path.join(DATA_DIR, 'decisions.jsonl');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);

/* ───────── AI sağlayıcıları ───────── */
const envLimit = (id, d) => { const n = Number(process.env['AI_LIMIT_' + id]); return Number.isFinite(n) && n > 0 ? n : d; };
const mkProv = o => Object.assign({
  ok: 0, fail: 0, invalid: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, discoverAt: 0,
  dayKey: '', dayCount: 0, lat: [], nextAt: 0
}, o);
const AI_PROV = [
  mkProv({
    id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    nativeBase: 'https://generativelanguage.googleapis.com/v1beta',
    key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'], prefer: 1, dayLimit: envLimit('GEMINI', 420)
  }),
  mkProv({
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '',
    models: ['deepseek-chat'], prefer: 2, dayLimit: envLimit('DEEPSEEK', 3000)
  }),
  mkProv({
    id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], prefer: 3, dayLimit: envLimit('GROQ', 900)
  }),
  mkProv({
    id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY || '',
    models: ['google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct'], prefer: 4, dayLimit: envLimit('OPENROUTER', 300)
  }),
  mkProv({
    id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '',
    models: ['gpt-4o-mini', 'gpt-4.1-mini'], prefer: 5, dayLimit: envLimit('OPENAI', 2000)
  })
];
const AI_USAGE = { dayKey: new Date().toISOString().slice(0, 10), dayCount: 0, hourKey: Math.floor(Date.now() / H1), hourCount: 0, briefDay: new Date().toISOString().slice(0, 10), briefCount: 0 };
const AI_QUEUE = [];
let AI_HIST = [];
const AI_STATE = { busy: false, lastAt: 0, lastError: null };
const AI_DISCOVER = { running: false, at: 0, results: {}, error: null };
const SHADOW = [];
const CHECK_STAT = {};
const AUTO_AI = { hk: 0, count: 0 };

/* Maliyet modeli: taker %0.06×2 + kayma %0.04×2 = %0.20 tur. Net R:R = (kazanç − H) / (risk + H). */
const EX = { FEE: 0.0006, SLIP: 0.0004, H: 0.20, MIN_RR1: 1.00, MIN_RR2: 1.60, MAX_RISK_PCT: 3.5, MIN_RISK_PCT: 0.45 };

/* ───────── modüller ───────── */
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

const TOKENIZED_STOCKS = new Set([
  'INTC', 'MSTR', 'KORU', 'SNXX', 'TSLA', 'NVDA', 'AAPL', 'COIN', 'HOOD', 'CRCL', 'AMZN', 'GOOGL', 'MSFT',
  'META', 'SPY', 'QQQ', 'PLTR', 'AMD', 'NFLX', 'BABA', 'MARA', 'RIOT'
]);

/* ───────── ayarlar ───────── */
const DEF_SET = {
  auto: false, autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 5, riskPct: 0.5,
  maxOpen: 3, autoMaxOpen: 3, dailyLossPct: 3, minConf: 55, aiEnabled: false, aiWatchAuto: false,
  costPct: EX.H, paperEquity: 1000, maxSpreadPct: 0.10, minQuoteVol: 5e6, topN: 60,
  includeStocks: false, autoAiPerHour: 40
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rp = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n >= 1000) return +n.toFixed(2); if (n >= 1) return +n.toFixed(4); if (n >= 0.01) return +n.toFixed(6); return +n.toFixed(8); };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const utcDayStart = ts => Math.floor((ts || Date.now()) / D1) * D1;
const fmtPct = v => (Number(v) >= 0 ? '+' : '') + num(v, 2).toFixed(2) + '%';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isStock = sym => TOKENIZED_STOCKS.has(baseOf(sym));

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.auto = s.auto === true;
  s.autoTrade = s.autoTrade === true;
  s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.margin = clamp(num(s.margin, DEF_SET.margin), 10, 100000);
  s.leverage = clamp(Math.round(num(s.leverage, DEF_SET.leverage)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, DEF_SET.riskPct), 0.05, 5);
  s.maxOpen = clamp(Math.round(num(s.maxOpen, DEF_SET.maxOpen)), 1, 20);
  s.autoMaxOpen = clamp(Math.round(num(s.autoMaxOpen, DEF_SET.autoMaxOpen)), 1, 5);
  s.dailyLossPct = clamp(num(s.dailyLossPct, DEF_SET.dailyLossPct), 0.5, 50);
  s.minConf = clamp(Math.round(num(s.minConf, DEF_SET.minConf)), 30, 95);
  s.aiEnabled = s.aiEnabled === true;
  s.aiWatchAuto = s.aiWatchAuto === true;
  s.costPct = EX.H;
  s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9);
  s.maxSpreadPct = clamp(num(s.maxSpreadPct, DEF_SET.maxSpreadPct), 0.01, 1);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 1e5, 1e9);
  s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 10, 150);
  s.includeStocks = s.includeStocks === true;
  s.autoAiPerHour = clamp(Math.round(num(s.autoAiPerHour, DEF_SET.autoAiPerHour)), 5, 200);
  return s;
}

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

/* ───────── durum yükle/kaydet ───────── */
function capArr(a, n) { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; }
function capMap(m, n) { while (m.size > n) { const k = m.keys().next().value; m.delete(k); } }

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
      paper.equity = num(paper.equity, DEF_SET.paperEquity);
      paper.start = num(paper.start, DEF_SET.paperEquity);
      paper.peak = num(paper.peak, paper.equity);
    }
    if (j && j.live && typeof j.live === 'object') {
      LIVE.open = Array.isArray(j.live.open) ? j.live.open.filter(p => p && p.isLive) : [];
      LIVE.closed = Array.isArray(j.live.closed) ? j.live.closed.slice(-200) : [];
      LIVE.balance = j.live.balance || null;
      LIVE.needsSync = true;
    }
    if (j && j.marketAI) marketAI = Object.assign(marketAI, j.marketAI);
    if (j && j.version === VERSION && j.aiModels && typeof j.aiModels === 'object') {
      for (const p of AI_PROV) { const arr = j.aiModels[p.id]; if (Array.isArray(arr) && arr.length) p.models = arr.slice(0, 12); }
    }
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
      paper, rej: REJ.slice(-200), out: OUT.slice(-300), rejStat: REJ_STAT,
      seq, aiUsage: AI_USAGE, marketBrief, marketAI,
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

/* ───────── log ───────── */
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

function appendDecision(o) {
  try {
    try { if (fs.statSync(DEC_FILE).size > 5 * 1024 * 1024) fs.renameSync(DEC_FILE, DEC_FILE + '.1'); } catch (e) { /* dosya yok */ }
    fs.appendFileSync(DEC_FILE, JSON.stringify(Object.assign({ t: Date.now(), market: market.dir }, o)) + '\n');
  } catch (e) { /* sessiz */ }
}
function readDecisions(n) {
  try {
    const lines = fs.readFileSync(DEC_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* ───────── indikatörler ───────── */
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
  if (b - a > 0.15 * atr) return 'ASAGI';
  return 'YATAY';
}
function fmtCandles(cs, n) {
  return (cs || []).slice(-n).map(c => {
    const p = c.c >= 1 ? 4 : 6;
    return new Date(c.t).toISOString().slice(5, 16).replace('T', ' ') + ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v);
  }).join('\n');
}

/* ───────── borsa ───────── */
const ex = new ccxt.bitget({
  apiKey: API_KEY || undefined, secret: API_SECRET || undefined, password: API_PASS || undefined,
  enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap', defaultSubType: 'linear' }
});
const CACHE = new Map();
const TICK = new Map();
const LONG1H = new Map();
let UNIVERSE = [];
const FALLBACK = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT', 'DOGE/USDT:USDT',
  'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'SUI/USDT:USDT',
  'TON/USDT:USDT', 'DOT/USDT:USDT', 'LTC/USDT:USDT', 'BCH/USDT:USDT', 'NEAR/USDT:USDT',
  'APT/USDT:USDT', 'ARB/USDT:USDT', 'OP/USDT:USDT', 'INJ/USDT:USDT', 'TIA/USDT:USDT'
];
const EXCLUDE = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'EUR', 'GBP', 'BUSD', 'BTC3L', 'BTC3S', 'ETH3L', 'ETH3S', 'SOL3L', 'SOL3S', 'XRP3L', 'XRP3S']);

async function pool(items, n, fn) {
  const list = items.slice();
  let idx = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx++;
      try { await fn(list[i], i); } catch (e) { /* sessiz */ }
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
  } catch (e) { /* sessiz */ }
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

/* Uzun geçmiş: 1h mumlar since ile sayfalanır, 2h'e toplanır */
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

/* ───────── piyasa rejimi ───────── */
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
    const btcUp = b && b.e20 > b.e50, ethUp = e && e.e20 > e.e50;
    let mathDir = 'NOTR', mathScore = 0.5;
    if (btcUp && ethUp && breadth >= 0.55) { mathDir = 'LONG'; mathScore = 0.5 + Math.min(0.3, (breadth - 0.5) * 0.6); }
    else if (!btcUp && !ethUp && breadth <= 0.45) { mathDir = 'SHORT'; mathScore = 0.5 + Math.min(0.3, (0.5 - breadth) * 0.6); }
    else if (btcUp && breadth >= 0.5) { mathDir = 'LONG'; mathScore = 0.55; }
    else if (!btcUp && breadth < 0.5) { mathDir = 'SHORT'; mathScore = 0.55; }
    const aiFresh = marketAI.at > 0 && Date.now() - marketAI.at < 40 * M1;
    const useAI = settings.aiEnabled === true && aiReady() && aiFresh;
    let dir = useAI ? marketAI.dir : 'NOTR';
    let score = useAI ? clamp(marketAI.score / 100, 0, 1) : 0.5;
    let why = useAI ? 'AI 15m yönü: ' + (marketAI.reason || marketAI.dir)
      : (settings.aiEnabled ? 'AI 15m yönü bekleniyor — ters filtre yok' : 'AI kapalı — piyasa yönü filtresi yok');
    if (useAI && mathDir !== 'NOTR' && marketAI.dir !== 'NOTR' && mathDir !== marketAI.dir) {
      dir = 'NOTR'; score = 0.5; why = 'AI (' + marketAI.dir + ') ile matematik (' + mathDir + ') çelişti → yön belirsiz';
    }
    market = {
      dir, score: +score.toFixed(2), breadth: +breadth.toFixed(3), why, btc: b, eth: e, at: Date.now(),
      mathDir, mathScore: +mathScore.toFixed(2), aiAt: marketAI.at || 0, source: useAI ? 'AI' : 'NONE'
    };
  } catch (e) { log('Piyasa rejimi hatası: ' + redact(e.message)); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   LT ÜÇGEN — çoklu trend çizgisi adayları (TradingView tarzı)
   ══════════════════════════════════════════════════════════════════════════════ */
function triUpperAt(tri, i) { return tri.hi.intercept + tri.hi.slope * (i - tri.refIdx); }
function triLowerAt(tri, i) { return tri.lo.intercept + tri.lo.slope * (i - tri.refIdx); }

function triLineCands(cs, kind, atr, opt) {
  const n = cs.length;
  const px = cs[n - 1].c;
  const pv = pivots(cs, opt.order, opt.order);
  const pvTouch = pivots(cs, 3, 3);
  const anchors = kind === 'H' ? pv.highs : pv.lows;
  const touchPts = kind === 'H' ? pvTouch.highs : pvTouch.lows;
  const tol = opt.tol * atr;
  const out = [];
  let maxHigh = -Infinity, minLow = Infinity;
  for (const c of cs) { if (c.h > maxHigh) maxHigh = c.h; if (c.l < minLow) minLow = c.l; }
  for (let x = 0; x < anchors.length; x++) {
    for (let y = x + 1; y < anchors.length; y++) {
      const a = anchors[x], b = anchors[y];
      const span = b.i - a.i;
      if (span < opt.minSpan) continue;
      const slope = (b.p - a.p) / span;
      if (kind === 'H' && slope > opt.maxRise * atr) continue;
      if (kind === 'L' && slope < -opt.maxRise * atr) continue;
      const intercept = a.p - slope * a.i;
      const at = (i) => intercept + slope * i;
      let touch = 0, viol = 0, inside = 0, total = 0;
      const used = [];
      for (const q of touchPts) {
        if (q.i < a.i - 1) continue;
        if (Math.abs(q.p - at(q.i)) <= tol) { touch++; used.push(q); }
      }
      for (let i = a.i; i < n; i++) {
        total++;
        const e2 = kind === 'H' ? cs[i].c - at(i) : at(i) - cs[i].c;
        if (e2 > 0.30 * atr) viol++; else inside++;
      }
      const cont = inside / Math.max(1, total);
      const nowV = at(n - 1);
      const dist = kind === 'H' ? (nowV - px) / atr : (px - nowV) / atr;
      const extreme = kind === 'H' ? (a.p >= maxHigh - 0.8 * atr) : (a.p <= minLow + 0.8 * atr);
      const score = (span / n) * 32 + Math.min(6, touch) * 6 + cont * 22 - viol * 4.5
        + (dist >= 0.2 && dist <= 5 ? 10 : (dist > 5 ? Math.max(-12, 10 - (dist - 5) * 2.5) : 2))
        + (extreme ? 6 : 0);
      out.push({ kind, slope, intercept, a, b, span, touch, viol, cont, nowV, dist, used, score });
    }
  }
  out.sort((p, q) => q.score - p.score);
  return out;
}

function analyzeTriangle(cs, tf) {
  if (!cs || cs.length < 90) return null;
  const n = cs.length;
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const px = cs[n - 1].c;
  const tfMs = TF_MS[tf] || H2;
  const refIdx = n - 1;
  const opt = { order: n >= 300 ? 5 : 3, minSpan: Math.max(24, Math.round(n * 0.16)), tol: 0.55, maxRise: 0.00045 };
  const U = triLineCands(cs, 'H', atr, opt).slice(0, 50);
  const L = triLineCands(cs, 'L', atr, opt).slice(0, 50);
  if (!U.length || !L.length) return null;
  let best = null;
  for (const u of U) {
    for (const l of L) {
      if (!(u.slope < l.slope)) continue;
      const apexIdx = (l.intercept - u.intercept) / (u.slope - l.slope);
      const apexX = apexIdx - refIdx;
      if (!(apexX > 1) || apexX > 160) continue;
      const upNow = u.intercept + u.slope * refIdx;
      const loNow = l.intercept + l.slope * refIdx;
      if (!(upNow > loNow)) continue;
      const widthNow = upNow - loNow;
      if (widthNow < 0.55 * atr || widthNow > 14 * atr) continue;
      if (px > upNow + 2.0 * atr || px < loNow - 2.0 * atr) continue;
      const firstIdx = Math.min(u.a.i, l.a.i);
      const widthStart = (u.intercept + u.slope * firstIdx) - (l.intercept + l.slope * firstIdx);
      if (!(widthStart > 0)) continue;
      const compression = clamp(1 - widthNow / widthStart, 0, 1);
      const maturity = clamp((refIdx - firstIdx) / Math.max(1, apexIdx - firstIdx), 0, 1);
      if (maturity < 0.22) continue;
      const total = u.score + l.score + compression * 14 + (apexX < 90 ? 9 : 2) + (u.touch + l.touch) * 1.5;
      if (!best || total > best.total) best = { u, l, apexIdx, apexX, widthNow, widthStart, compression, maturity, firstIdx, total };
    }
  }
  if (!best) return null;
  const { u, l, apexIdx, apexX, widthNow, widthStart, compression, maturity, firstIdx } = best;
  const upperNow = u.intercept + u.slope * refIdx;
  const lowerNow = l.intercept + l.slope * refIdx;
  const hi = { slope: u.slope, intercept: upperNow };
  const lo = { slope: l.slope, intercept: lowerNow };
  const tri = { hi, lo, refIdx };
  const tolT = 0.60 * atr;
  const highs = u.used.filter(q => Math.abs(q.p - triUpperAt(tri, q.i)) <= tolT);
  const lows = l.used.filter(q => Math.abs(q.p - triLowerAt(tri, q.i)) <= tolT);
  const touchesH = Math.max(2, highs.length);
  const touchesL = Math.max(2, lows.length);
  const outside = px > upperNow + 0.9 * atr || px < lowerNow - 0.9 * atr;
  const vol20 = avg(cs.slice(-20).map(c => c.v));
  const volPrev = avg(cs.slice(-50, -20).map(c => c.v));
  const volContraction = volPrev > 0 ? clamp(1 - vol20 / volPrev, -1, 1) : 0;
  const widthPct = +(widthNow / px * 100).toFixed(2);
  const score = clamp(Math.round(
    36 + touchesH * 3.5 + touchesL * 3.5 + compression * 22 + maturity * 18 +
    clamp(volContraction, 0, 1) * 6 + (outside ? -10 : 0) + (widthPct >= 2 && widthPct <= 25 ? 6 : 0)
  ), 0, 100);
  return {
    ok: true, tf, n, refIdx, atr, px, hi, lo,
    upperNow, lowerNow, widthNow, widthPct, widthStart,
    compression: +compression.toFixed(3), maturity: +maturity.toFixed(3),
    apexX, apexIdx, apexAt: cs[refIdx].t + Math.round(apexX) * tfMs,
    firstIdx, firstT: cs[firstIdx].t, lastT: cs[refIdx].t,
    hiStart: u.a.i, loStart: l.a.i,
    touchesH, touchesL,
    resH: +(avg(highs.map(q => Math.abs(q.p - triUpperAt(tri, q.i)))) / atr).toFixed(3),
    resL: +(avg(lows.map(q => Math.abs(q.p - triLowerAt(tri, q.i)))) / atr).toFixed(3),
    volContraction: +volContraction.toFixed(2), outside, score, highs, lows
  };
}

function srLevels(cs, atr, px) {
  if (!cs || cs.length < 40 || !(atr > 0) || !(px > 0)) return [];
  const pv = pivots(cs.slice(-220), 5, 5);
  const raw = [];
  for (const q of pv.highs) raw.push({ p: q.p, kind: 'R' });
  for (const q of pv.lows) raw.push({ p: q.p, kind: 'S' });
  const clusters = [];
  for (const r of raw) {
    let c = clusters.find(x => Math.abs(x.p - r.p) <= 0.5 * atr);
    if (!c) { c = { p: r.p, n: 0, kind: r.kind }; clusters.push(c); }
    c.p = (c.p * c.n + r.p) / (c.n + 1); c.n++;
    if (r.kind === 'R') c.kind = 'R';
  }
  const above = clusters.filter(c => c.p > px * 1.001).sort((a, b) => a.p - b.p).slice(0, 3);
  const below = clusters.filter(c => c.p < px * 0.999).sort((a, b) => b.p - a.p).slice(0, 3);
  return above.map(c => ({ v: rp(c.p), col: '#f6465d', l: 'DİRENÇ', kind: 'R', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) }))
    .concat(below.map(c => ({ v: rp(c.p), col: '#0ecb81', l: 'DESTEK', kind: 'S', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) })));
}

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
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
  if (dir === 'LONG') {
    if (tri.maturity < 0.40 || tri.widthNow < 0.50 * atr) return null;
    if ((px - up) / atr > 0.85) return null;
    if (px < up - 0.35 * atr) return null;
  } else {
    if (tri.maturity < 0.40 || tri.widthNow < 0.50 * atr) return null;
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
  let swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.35 * atr;
  let risk = Math.abs(entry - sl);
  if (risk < 0.55 * atr) { sl = entry - d * 0.55 * atr; risk = Math.abs(entry - sl); }
  const riskPct = risk / entry * 100;
  if (riskPct < 0.45 || riskPct > EX.MAX_RISK_PCT) return null;
  const height = Math.max(tri.widthNow, 1.15 * risk);
  let tp1 = entry + d * Math.max(0.55 * height, 1.25 * risk);
  let tp2 = entry + d * Math.max(0.95 * height, 2.00 * risk);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net < 1.00 || q2.net < 1.60) return null;
  const d1Up = (() => {
    if (cs.length < 130) return null;
    const agg = aggTF(cs.slice(-120), 2, H2);
    if (agg.length < 60) return null;
    const cl = closesOf(agg), e = emaArr(cl, 20);
    return e[e.length - 1] > e[e.length - 6];
  })();
  const aligned = d1Up == null ? false : (dir === 'LONG' ? d1Up : !d1Up);
  const conf = clamp(Math.round(52 + tri.maturity * 15 + tri.compression * 18 + (tri.touchesH + tri.touchesL) * 2 + clamp(vr - 1, 0, 1) * 4 + (aligned ? 4 : 0) + (q1.net >= 1.1 ? 3 : 0)), 45, 95);
  const plan = { entry, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) };
  return {
    module: 'LT', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
    single: false, conf, retest: false, holdSec: 0,
    info: {
      tf, source: 'math', plan, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2),
      atr: rp(atr), atrPct: +(atr / entry * 100).toFixed(2), upper: rp(up), lower: rp(dn),
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct,
      maturity: tri.maturity, compression: tri.compression, touches: tri.touchesH + tri.touchesL,
      apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1), score: tri.score,
      volRatio: +vr.toFixed(2), bodyRatio: +br.toFixed(2), bodyAtr: +ba.toFixed(2),
      aligned4h: aligned, breakoutUp: dir === 'LONG', breakoutDn: dir === 'SHORT',
      pivots: tri.highs.concat(tri.lows).map(q => ({ t: q.t, p: rp(q.p), side: tri.highs.includes(q) ? 'H' : 'L' }))
    },
    setupKey: 'LT|' + sym + '|' + tri.firstT + '|' + Math.round(tri.apexAt) + '|' + dir
  };
}

/* LT tarama: getLong2h ile 1200 bar (TradingView kalitesi) */
let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const list = scanSyms('LT', 40);
    const found = [];
    await pool(list, 3, async (sym) => {
      const cs = await getLong2h(sym, LT_BARS);
      if (!cs || cs.length < 90) return;
      const tri = analyzeTriangle(cs, '2h');
      if (!tri) { LT_CACHE.delete(sym); return; }
      LT_CACHE.set(sym, { sym, tf: '2h', cs, tri, at: Date.now() });
      const raw = ltSignalFrom(sym, cs, tri.tf, tri);
      if (raw) found.push(raw);
    });
    found.sort((a, b) => b.conf - a.conf);
    for (const raw of found.slice(0, 4)) {
      const key = raw.setupKey;
      const prev = FIRED.get(key);
      if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(key, Date.now()); log('LT KIRILIM: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net ' + sig.info.netRR); }
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
      if (Date.now() - e.at > 20 * M1) continue;
      const raw = ltSignalFrom(sym, e.cs, e.tri.tf, e.tri);
      if (!raw) continue;
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); log('LT CANLI KIRILIM: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf); }
    }
    buildLtWatch();
    lastScan.tick = Date.now();
  } catch (e) { /* sessiz */ }
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
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow),
      widthPct: tri.widthPct, distUpperPct: +distU.toFixed(2), distLowerPct: +distL.toFixed(2),
      distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2),
      nearPct: +nearPct.toFixed(2), nearSide, status, dirHint: nearSide === 'ÜST' ? 'LONG' : 'SHORT',
      maturity: tri.maturity, compression: tri.compression, score: tri.score,
      touches: tri.touchesH + tri.touchesL, apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1),
      breakoutUp: tri.outside && px > up, breakoutDn: tri.outside && px < dn,
      ai: (e.ai || null)
    });
  }
  rows.sort((a, b) => a.nearPct - b.nearPct || b.score - a.score);
  WATCH.lt = rows.slice(0, 40);
  WATCH_META.lt = { scannedAt: lastScan.lt || Date.now(), count: WATCH.lt.length, universe: Math.min(40, UNIVERSE.length) };
}

function triangleChart(tri, cs, tf) {
  if (!tri || !tri.ok) return null;
  const tfMs = TF_MS[tf] || H2;
  const n = cs.length;
  const hiStart = Math.max(0, Math.min(n - 1, tri.hiStart != null ? tri.hiStart : tri.firstIdx) - 1);
  const loStart = Math.max(0, Math.min(n - 1, tri.loStart != null ? tri.loStart : tri.firstIdx) - 1);
  const apexX = Math.max(6, Math.min(160, Math.round(num(tri.apexX, 30))));
  const future = clamp(Math.round(apexX * 0.9), 10, 42);
  const at = (i) => i < n ? cs[i].t : cs[n - 1].t + (i - n + 1) * tfMs;
  const upper = [], lower = [];
  for (let i = hiStart; i < n + future; i++) upper.push([at(i), rp(triUpperAt(tri, i))]);
  for (let i = loStart; i < n + future; i++) lower.push([at(i), rp(triLowerAt(tri, i))]);
  return {
    upper, lower,
    upperNow: rp(triUpperAt(tri, n - 1)), lowerNow: rp(triLowerAt(tri, n - 1)),
    apexAt: tri.apexAt, apexPrice: rp(triUpperAt(tri, n - 1) + tri.hi.slope * tri.apexX),
    apexBars: apexX, futureBars: future, hiStart, loStart,
    pivots: (tri.highs || []).map(q => ({ t: q.t, p: rp(q.p), side: 'H' }))
      .concat((tri.lows || []).map(q => ({ t: q.t, p: rp(q.p), side: 'L' }))),
    maturity: tri.maturity, compression: tri.compression, score: tri.score, widthPct: tri.widthPct
  };
}

/* ───────── PARÇA 1 SONU ───────── */
/* ══════════════════════════════════════════════════════════════════════════════
   GÜNLÜK HIZLI SCALP — 5m (ORB / VWAP pullback / VWAP 2σ dönüş)
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
  return { sym, cs, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi,
    adx: adxObj ? adxObj.adx : null, volSma, volRatio, vwap: vw.vwap, vwapSd: vw.sd, session, or, spread, e50Slope,
    body: bodyRatio(last), ba: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr };
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
  return { setup, dir, entry, sl, tp1, tp2, holdMs, score: clamp(Math.round(score), 0, 100),
    riskPct: +riskPct.toFixed(2), netRR: q1.net, netRR2: q2.net,
    reasons: reasons.filter(Boolean).slice(0, 6), risks: risks.filter(Boolean).slice(0, 4),
    trigger: rp(trigger || entry), distPct: +num(distPct, 0).toFixed(2), triggered: !!triggered };
}
function scalpCandidates(ctx) {
  const out = [];
  const { last, px, atr, cs, n } = ctx;
  const prev = cs[n - 2];
  /* ORB */
  if (ctx.or && ctx.now >= ctx.or.end + M5 && ctx.now <= ctx.session.start + 4 * H1) {
    const or = ctx.or;
    const long = last.c > or.high && last.o <= or.high * 1.0008 && px >= or.high * 0.999;
    const short = last.c < or.low && last.o >= or.low * 0.9992 && px <= or.low * 1.001;
    const trendUp = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015;
    const trendDn = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015;
    const volOk = ctx.volRatio >= 1.45;
    const bodyOk = ctx.body >= 0.30 && ctx.ba >= 0.38;
    if (long && trendUp && volOk && bodyOk && (px - or.high) / atr <= 0.85 && (!ctx.vwap || px > ctx.vwap)) {
      const sl = Math.min(or.mid, last.c - 0.85 * atr);
      out.push(makeScalpCandidate(ctx, 'ORB', 'LONG', px, sl, 0, 0, 90 * M1,
        64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0),
        ['ORB yukarı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP üstünde'],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.high, (or.high / px - 1) * 100, true));
    }
    if (short && trendDn && volOk && bodyOk && (or.low - px) / atr <= 0.85 && (!ctx.vwap || px < ctx.vwap)) {
      const sl = Math.max(or.mid, last.c + 0.85 * atr);
      out.push(makeScalpCandidate(ctx, 'ORB', 'SHORT', px, sl, 0, 0, 90 * M1,
        64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0),
        ['ORB aşağı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP altında'],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.low, (1 - or.low / px) * 100, true));
    }
  }
  /* VWAP pullback */
  if (ctx.vwap) {
    const longTrend = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015 && last.c > ctx.vwap;
    const shortTrend = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015 && last.c < ctx.vwap;
    const pullLong = cs.slice(-7, -1).some(c => c.l <= ctx.e20[n - 2] + 0.28 * atr) || cs.slice(-7, -1).some(c => c.l <= ctx.vwap + 0.30 * atr);
    const pullShort = cs.slice(-7, -1).some(c => c.h >= ctx.e20[n - 2] - 0.28 * atr) || cs.slice(-7, -1).some(c => c.h >= ctx.vwap - 0.30 * atr);
    const trigL = last.c > last.o && last.c > prev.h && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 42 && ctx.rsi <= 74 && (last.c - ctx.e20[n - 1]) / atr <= 1.35;
    const trigS = last.c < last.o && last.c < prev.l && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 26 && ctx.rsi <= 58 && (ctx.e20[n - 1] - last.c) / atr <= 1.35;
    if (longTrend && pullLong && trigL) {
      const sl = Math.min.apply(null, cs.slice(-4).map(c => c.l)) - 0.30 * atr;
      out.push(makeScalpCandidate(ctx, 'VWAP', 'LONG', px, sl, 0, 0, 45 * M1,
        58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0),
        ['VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (ctx.e20[n - 1] / px - 1) * 100, true));
    }
    if (shortTrend && pullShort && trigS) {
      const sl = Math.max.apply(null, cs.slice(-4).map(c => c.h)) + 0.30 * atr;
      out.push(makeScalpCandidate(ctx, 'VWAP', 'SHORT', px, sl, 0, 0, 45 * M1,
        58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0),
        ['VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)],
        [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (1 - ctx.e20[n - 1] / px) * 100, true));
    }
    /* REV 2σ */
    if (ctx.vwapSd > 0 && ctx.adx != null && ctx.adx < 21) {
      const lower2 = ctx.vwap - 2 * ctx.vwapSd, upper2 = ctx.vwap + 2 * ctx.vwapSd;
      const wickLow = last.h > last.l ? (Math.min(last.o, last.c) - last.l) / (last.h - last.l) : 0;
      const wickHigh = last.h > last.l ? (last.h - Math.max(last.o, last.c)) / (last.h - last.l) : 0;
      const longRev = last.l <= lower2 && last.c > lower2 && ctx.rsi != null && ctx.rsi < 32 && wickLow >= 0.32;
      const shortRev = last.h >= upper2 && last.c < upper2 && ctx.rsi != null && ctx.rsi > 68 && wickHigh >= 0.32;
      if (longRev) {
        const sl = last.l - 0.35 * atr;
        const cand = makeScalpCandidate(ctx, 'REV', 'LONG', px, sl, 0, 0, 30 * M1,
          56 + clamp(32 - ctx.rsi, 0, 12) * 1.2 + clamp(wickLow - 0.32, 0, 0.4) * 20,
          ['VWAP alt 2σ fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx)],
          ['Trend scalp değil'], lower2, (lower2 / px - 1) * 100, true);
        if (cand) {
          const risk = Math.abs(cand.entry - cand.sl);
          const tp1v = rp(ctx.vwap), tp2v = rp(ctx.vwap + (ctx.vwapSd || risk));
          const q1 = rrNet(cand.entry, cand.sl, tp1v), q2 = rrNet(cand.entry, cand.sl, tp2v);
          if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) { cand.tp1 = tp1v; cand.tp2 = tp2v; cand.netRR = q1.net; cand.netRR2 = q2.net; out.push(cand); }
        }
      }
      if (shortRev) {
        const sl = last.h + 0.35 * atr;
        const cand = makeScalpCandidate(ctx, 'REV', 'SHORT', px, sl, 0, 0, 30 * M1,
          56 + clamp(ctx.rsi - 68, 0, 12) * 1.2 + clamp(wickHigh - 0.32, 0, 0.4) * 20,
          ['VWAP üst 2σ fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx)],
          ['Trend scalp değil'], upper2, (1 - upper2 / px) * 100, true);
        if (cand) {
          const risk = Math.abs(cand.entry - cand.sl);
          const tp1v = rp(ctx.vwap), tp2v = rp(ctx.vwap - (ctx.vwapSd || risk));
          const q1 = rrNet(cand.entry, cand.sl, tp1v), q2 = rrNet(cand.entry, cand.sl, tp2v);
          if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) { cand.tp1 = tp1v; cand.tp2 = tp2v; cand.netRR = q1.net; cand.netRR2 = q2.net; out.push(cand); }
        }
      }
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
  const raw = { module: 'PUMP', symbol: sym, base: baseOf(sym), dir: best.dir,
    entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2,
    single: false, conf: clamp(best.score, 45, 95), retest: false,
    holdSec: Math.round(best.holdMs / 1000), noMoveSec: Math.round(Math.min(180, best.holdMs / 1000 * 0.35)),
    info: { tf: '5m', source: 'math', setup: best.setup, plan: { entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2 },
      netRR: best.netRR, netRR2: best.netRR2, riskPct: best.riskPct, atrPct: +ctx.atrPct.toFixed(2),
      volRatio: +ctx.volRatio.toFixed(2), bodyAtr: +ctx.ba.toFixed(2), bodyRatio: +ctx.body.toFixed(2),
      rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
      vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]),
      orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null,
      sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3),
      trigger: best.trigger, distPct: best.distPct, score: best.score, reasons: best.reasons, risks: best.risks },
    maxAgeMs: best.holdMs + 10 * M1,
    setupKey: 'SCALP|' + sym + '|' + best.setup + '|' + best.dir + '|' + Math.floor(ctx.last.t / M5) };
  const row = { symbol: sym, base: baseOf(sym), tf: '5m', price: rp(ctx.px), setup: best.setup, dir: best.dir,
    score: best.score, status: best.triggered ? 'TETİK' : 'BEKLİYOR',
    state: best.triggered ? 'ADAY SİNYAL' : (best.distPct != null && Math.abs(best.distPct) <= 0.35 ? 'KIRILIM YAKLAŞIYOR' : 'TEYİT BEKLENİYOR'),
    trigger: best.trigger, distPct: best.distPct, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
    mom1: +(((ctx.last.c / ctx.cs[ctx.n - 2].c - 1) * 100)).toFixed(2),
    mom3: +(((ctx.last.c / ctx.cs[Math.max(0, ctx.n - 4)].c - 1) * 100)).toFixed(2),
    rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
    vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]),
    orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null,
    sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), reason: best.reasons[0] || '', ai: null };
  return { raw, row };
}
let scalpScanning = false;
async function scalpScan() {
  if (scalpScanning) return;
  scalpScanning = true;
  try {
    const list = scanSyms('SCALP', 50);
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
      if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; log('SCALP (' + raw.info.setup + '): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net ' + raw.info.netRR); }
    }
    lastScan.scalp = Date.now();
  } catch (e) { log('Scalp hatası: ' + redact(e.message)); }
  finally { scalpScanning = false; }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SİNYAL YAŞAM DÖNGÜSÜ + PAPER
   ══════════════════════════════════════════════════════════════════════════════ */
function isOpenSignal(s) { return !!s && s.status !== 'KAPALI'; }
function dayPnl() { return +(paper.equity - paper.dayStart).toFixed(4); }
function dailyLossHit() { return dayPnl() <= -Math.abs(paper.dayStart * settings.dailyLossPct / 100); }
function autoOpenCount() { return paper.open.filter(p => p.module === 'AUTO').length + LIVE.open.length; }
function canAutoOpen(module) {
  if (module === 'AUTO') return settings.autoTrade === true && autoOpenCount() < settings.autoMaxOpen && !dailyLossHit();
  return settings.auto === true && paper.open.length < settings.maxOpen && !dailyLossHit();
}
function logRej(module, sym, reason, price) {
  const base = baseOf(sym);
  const now = Date.now();
  const last = REJ.find(r => r.symbol === sym && r.reason === reason && now - r.t < 10 * M1);
  if (last) { last.n = (last.n || 1) + 1; last.t = now; }
  else { REJ.push({ t: now, module, symbol: sym, base, reason, price: rp(price || priceOf(sym)), n: 1 }); capArr(REJ, 200); }
  const k = module + '|' + reason;
  REJ_STAT[k] = (REJ_STAT[k] || 0) + 1;
}
function analyzeSignal(sig) {
  const info = sig.info || {};
  const reasons = Array.isArray(info.reasons) ? info.reasons.slice() : [];
  const risks = Array.isArray(info.risks) ? info.risks.slice() : [];
  let score = clamp(Math.round(num(sig.conf, 50)), 0, 100);
  const q = rrNet(sig.entry, sig.sl, sig.tp1);
  if (q.net >= 1.0) { score += 5; reasons.push('Net R:R ' + q.net.toFixed(2)); }
  else if (q.net < 0.6) { score -= 8; risks.push('Net R:R zayıf'); }
  const riskPct = Math.abs(sig.entry - sig.sl) / sig.entry * 100;
  if (riskPct > 2.2) { score -= 5; risks.push('Stop geniş'); }
  if (market.dir !== 'NOTR' && market.dir !== sig.dir) { score -= 6; risks.push('Piyasa yönüne ters'); }
  else if (market.dir === sig.dir) { score += 3; reasons.push('Piyasa uyumlu'); }
  else if (market.dir === 'NOTR') { score -= 4; risks.push('Piyasa yönü belirsiz'); }
  if (info.setup === 'REV') { score -= 2; reasons.push('Range dönüşü'); }
  score = clamp(score, 0, 100);
  const skipped = sig.status === 'KAPALI' && SKIP_RESULTS.has(sig.result);
  const verdict = skipped ? 'GİRİLMEZ' : (score >= settings.minConf ? 'GİRİLİR' : 'BEKLE');
  return { verdict, verdictLabel: verdict === 'GİRİLİR' ? 'GİRİLİR' : verdict === 'GİRİLMEZ' ? 'GİRİLMEZ' : 'BEKLE',
    score, netRR: q.net, riskPct: +riskPct.toFixed(2),
    reasons: Array.from(new Set(reasons)).slice(0, 8), risks: Array.from(new Set(risks)).slice(0, 6) };
}
function addSignal(raw) {
  if (!raw || !MODS[raw.module] || !MODS[raw.module].enabled) return false;
  const M = MODS[raw.module], now = Date.now();
  if (!['LONG', 'SHORT'].includes(raw.dir)) return false;
  if (!(raw.entry > 0) || !(raw.sl > 0) || !(raw.tp1 > 0)) return false;
  const d = raw.dir === 'LONG' ? 1 : -1;
  if ((raw.tp1 - raw.entry) * d <= 0) return false;
  if ((raw.sl - raw.entry) * d >= 0) return false;
  const riskPct = Math.abs(raw.entry - raw.sl) / raw.entry * 100;
  if (riskPct < 0.35 || riskPct > EX.MAX_RISK_PCT) return false;
  const q1 = rrNet(raw.entry, raw.sl, raw.tp1);
  if (q1.net < 1.00) return false;
  if (raw.module === 'AUTO' && settings.autoTrade !== true) { logRej(raw.module, raw.symbol, 'OtoTrade kapalı', raw.entry); return false; }
  if (raw.module === 'AUTO' && !aiReady()) { logRej(raw.module, raw.symbol, 'AI kapalı', raw.entry); return false; }
  const same = signals.filter(s => s.module === raw.module && s.symbol === raw.symbol);
  if (same.some(isOpenSignal)) { logRej(raw.module, raw.symbol, 'aynı coin açık', raw.entry); return false; }
  const last = same.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - (last.closedAt || last.createdAt) < M.cooldown) { logRej(raw.module, raw.symbol, 'soğuma', raw.entry); return false; }
  const dayStart = utcDayStart(now);
  if (same.filter(s => s.createdAt >= dayStart).length >= M.maxPerDaySym) { logRej(raw.module, raw.symbol, 'günlük limit', raw.entry); return false; }
  if (raw.setupKey) {
    const f = FIRED.get(raw.setupKey);
    const ttl = raw.module === 'LT' ? 6 * H1 : raw.module === 'AUTO' ? 6 * M1 : 30 * M1;
    if (f && now - f < ttl) return false;
  }
  const counter = market.dir !== 'NOTR' && market.dir !== raw.dir;
  if (counter) { logRej(raw.module, raw.symbol, 'piyasa yönüne ters', raw.entry); return false; }
  const id = 'S' + (++seq).toString(36) + '-' + now.toString(36);
  const sig = {
    id, module: raw.module, symbol: raw.symbol, base: raw.base || baseOf(raw.symbol),
    dir: raw.dir, entry: rp(raw.entry), sl: rp(raw.sl), curSl: rp(raw.sl),
    tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null, single: false, tp1Hit: false,
    conf: clamp(Math.round(num(raw.conf, 55)), 30, 99), baseConf: clamp(Math.round(num(raw.conf, 55)), 30, 99),
    counter, marketAlign: market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU'),
    info: Object.assign({}, raw.info || {}, { plan: (raw.info && raw.info.plan) || { entry: rp(raw.entry), sl: rp(raw.sl), tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null } }),
    status: 'AKTIF', result: null, aiGate: null, ai: null,
    createdAt: now, updatedAt: now, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0,
    holdSec: raw.holdSec, noMoveSec: raw.noMoveSec, setupKey: raw.setupKey || null,
    tradeable: M.tradeable, virtual: !M.tradeable, startedAt: now, approvalExpiresAt: null, isLive: false
  };
  const aiOn = aiReady();
  sig.aiGate = { state: aiOn ? 'QUEUED' : 'MATH_ONLY', queuedAt: now, note: aiOn ? 'AI kararı bekleniyor' : 'AI kapalı — matematik kararı' };
  if (raw.module === 'AUTO') { sig.status = 'AI_BEKLIYOR'; sig.aiGate = { state: 'QUEUED', queuedAt: now, note: 'OtoTrade AI kararında' }; }
  else if (raw.module === 'PUMP') { sig.status = aiOn ? 'AI_BEKLIYOR' : 'ONAY_BEKLIYOR'; if (!aiOn) sig.approvalExpiresAt = now + 10 * M1; }
  else { sig.status = 'AKTIF'; sig.startedAt = now; }
  signals.push(sig);
  capArr(signals, 500);
  sig.analysis = analyzeSignal(sig);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + sig.analysis.verdictLabel + ' | ' + (sig.info.setup || sig.info.tf || ''));
  onSignalAdded(sig);
  if (aiOn) queueAI(sig);
  else if (raw.module === 'PUMP' && canAutoOpen('PUMP')) {
    const r = openPaper(sig);
    if (!r || r.error) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + 10 * M1; sig.aiGate = Object.assign({}, sig.aiGate, { note: 'Oto açılamadı' }); }
  }
  return sig;
}
function onSignalAdded(sig) {
  if (sig.module === 'LT') {
    OPP.set('LT|' + sig.symbol, {
      id: 'LT|' + sig.symbol, mod: 'LT', sym: sig.symbol, base: sig.base, dir: sig.dir,
      state: 'CONFIRMED', firstAt: sig.createdAt, updatedAt: Date.now(), price: sig.entry,
      hist: [{ t: Date.now(), from: null, to: 'CONFIRMED', price: sig.entry, reason: 'üçgen kırılımı' }], ai: null
    });
    capMap(OPP, 100);
  }
}
function skipSignal(sig, code, note) {
  if (!sig || sig.status === 'KAPALI') return;
  sig.status = 'KAPALI'; sig.result = code; sig.netR = null; sig.grossR = null;
  sig.closedAt = Date.now(); sig.skipNote = note || '';
  const gateState = (sig.aiGate && sig.aiGate.state === 'AI_RED') ? 'AI_RED' : 'SKIPPED';
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: gateState, note: note || RES[code] || code, decidedAt: Date.now() });
  dirty = true;
  log('ATLANDI: ' + MODS[sig.module].label + ' ' + sig.base + ' ' + sig.dir + ' → ' + (RES[code] || code));
}
async function approveSignal(sig) {
  if (!sig) return { error: 'sinyal yok' };
  if (sig.status !== 'ONAY_BEKLIYOR') return { error: 'onay beklemiyor' };
  if (sig.approvalExpiresAt && Date.now() > sig.approvalExpiresAt) { skipSignal(sig, 'APPROVAL_EXPIRED', 'süre doldu'); return { error: 'süre doldu' }; }
  return openTrade(sig);
}
function reconcilePending() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'ONAY_BEKLIYOR') { if (sig.approvalExpiresAt && now > sig.approvalExpiresAt) skipSignal(sig, 'APPROVAL_EXPIRED', 'süre doldu'); continue; }
    if (sig.status !== 'AI_BEKLIYOR') continue;
    const queued = AI_QUEUE.some(x => x.id === sig.id);
    if (!aiReady()) {
      if (sig.module === 'AUTO') { skipSignal(sig, 'AI_ERROR', 'AI kapalı'); continue; }
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'MATH_ONLY', note: 'AI kapalı', decidedAt: now });
      if (sig.module === 'PUMP') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; } else { sig.status = 'AKTIF'; }
      dirty = true;
      continue;
    }
    if (now - sig.createdAt > 20 * M1) {
      if (sig.module === 'AUTO') { skipSignal(sig, 'AI_TIMEOUT', 'zaman aşımı'); continue; }
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'AI gecikti', decidedAt: now });
      if (sig.module === 'PUMP') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; } else { sig.status = 'AKTIF'; }
      dirty = true;
      continue;
    }
    if (!queued && !AI_STATE.busy) queueAI(sig);
  }
}
function openPaper(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin açık' };
  if (sig.module === 'AUTO') { if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks ' + settings.autoMaxOpen }; }
  else if (paper.open.length >= settings.maxOpen) return { error: 'maks açık' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const px = priceOf(sig.symbol);
  if (!(px > 0)) return { error: 'fiyat yok' };
  const atrPct = num(sig.info && sig.info.atrPct, 0.5);
  const maxDrift = Math.max(0.22, Math.min(0.65, atrPct * 0.35));
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > maxDrift) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = rp(px);
  const riskPerUnit = Math.abs(entry - sig.sl);
  if (!(riskPerUnit > 0)) return { error: 'stop geçersiz' };
  const equity = paper.equity;
  const riskAmt = equity * settings.riskPct / 100;
  let qty = riskAmt / riskPerUnit;
  const maxNotional = settings.margin * settings.leverage;
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  if (!(qty > 0)) return { error: 'miktar 0' };
  const pos = { id: 'P' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +qty.toFixed(8), initialQty: +qty.toFixed(8), remainingQty: +qty.toFixed(8),
    notional: +(qty * entry).toFixed(4), margin: +((qty * entry) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(qty * riskPerUnit).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxR: 0,
    maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 2 * H1)), setup: (sig.info && sig.info.setup) || null,
    isLive: false, scalp: sig.module === 'PUMP', quickTpPct: null };
  sig.entry = entry; sig.status = 'AKTIF'; sig.startedAt = pos.openedAt; sig.operatorApprovedAt = pos.openedAt;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'paper açıldı', decidedAt: Date.now() });
  paper.open.push(pos); dirty = true;
  log('PAPER AÇILDI: ' + sig.base + ' ' + sig.dir + ' | ' + entry + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1);
  return { pos };
}
async function openTrade(sig) {
  if (settings.tradeMode === 'live') return await liveOpen(sig);
  return openPaper(sig);
}
function closePortion(pos, qty, price) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const portionNotional = qty * pos.entry;
  const gross = (price - pos.entry) * d * qty;
  const cost = portionNotional * EX.H / 100;
  pos.grossRealized += gross; pos.costPaid += cost;
  pos.realized = pos.grossRealized - pos.costPaid;
  pos.remainingQty = +(pos.remainingQty - qty).toFixed(8);
  return { gross, cost };
}
function closePaper(pos, price, reason) {
  if (!pos || pos.isLive) return;
  const qty = pos.remainingQty;
  if (qty > 0) closePortion(pos, qty, price);
  const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const grossR = +(pos.grossRealized / Math.max(0.0001, pos.riskAmt)).toFixed(3);
  const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
  paper.equity = +(paper.equity + net).toFixed(4);
  paper.peak = Math.max(paper.peak, paper.equity);
  const sig = signals.find(s => s.id === pos.sigId);
  if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(price); sig.closedAt = Date.now(); sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.analysis = analyzeSignal(sig); }
  paper.open = paper.open.filter(p => p.id !== pos.id);
  const rec = Object.assign({}, pos, { exit: rp(price), result: reason, pnl: net, netR, grossR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt });
  delete rec.remainingQty;
  paper.closed.push(rec); capArr(paper.closed, 300);
  OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, conf: sig ? sig.conf : null, createdAt: sig ? sig.createdAt : pos.openedAt });
  capArr(OUT, 300);
  appendDecision({ type: 'sonuc', sigId: pos.sigId, module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net });
  dirty = true;
  log('PAPER KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R | bakiye ' + paper.equity);
}
function autoFadeCheck(pos, px, d) {
  if (pos.module !== 'AUTO' || pos.ageMs <= 90e3) return null;
  const cs1 = (CACHE.get(pos.symbol + '|1m') || {}).data;
  if (!cs1 || cs1.length < 5) return null;
  const cl = cs1.slice(-4).map(c => c.c);
  const against = d === 1 ? (cl[3] < cl[2] && cl[2] < cl[1] && cl[1] < cl[0]) : (cl[3] > cl[2] && cl[2] > cl[1] && cl[1] > cl[0]);
  if (!against) return null;
  const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
  const rNow = (px - pos.entry) * d / rRisk;
  if ((pos.maxR || 0) >= 0.3 && rNow <= 0.0) return 'FADE';
  if ((pos.maxR || 0) < 0.3 && rNow <= -0.75) return 'ZAYIF_IVME';
  return null;
}
function monitorPaper() {
  const now = Date.now();
  for (const pos of paper.open.slice()) {
    const px = priceOf(pos.symbol);
    if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px); pos.ageMs = now - pos.openedAt;
    pos.livePnl = +((pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
    pos.livePnlPct = +(pos.livePnl / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    const rNow0 = (px - pos.entry) * d / rRisk;
    pos.maxR = Math.max(pos.maxR || 0, rNow0);
    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { closePaper(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL'); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { closePaper(pos, pos.tp2, 'TP2'); continue; }
    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const q = +(pos.initialQty * 0.5).toFixed(8);
      closePortion(pos, q, pos.tp1);
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
    if (pos.tp1Hit) {
      const tf = pos.module === 'AUTO' ? '1m' : '5m';
      const cs = (CACHE.get(pos.symbol + '|' + tf) || {}).data;
      if (cs && cs.length > 25) {
        const cl = closesOf(cs), e20 = emaArr(cl, 20);
        const l = cl[cl.length - 1], p1 = cl[cl.length - 2], em = e20[e20.length - 1];
        if (em && ((d === 1 && l < em && p1 < em) || (d === -1 && l > em && p1 > em))) closePaper(pos, px, 'MOMENTUM');
      }
    }
  }
}
function paperSummary() {
  const closed = paper.closed;
  const wins = closed.filter(x => x.pnl > 0).length;
  const losses = closed.filter(x => x.pnl <= 0).length;
  const sumPnl = +closed.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of paper.open) { const px = priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  const eq = paper.equity;
  const peak = Math.max(paper.peak || eq, eq);
  return { equity: +eq.toFixed(2), balance: +eq.toFixed(2), start: paper.start, dayStart: +paper.dayStart.toFixed(2), dayPnl: dayPnl(),
    open: paper.open.length, closed: closed.length, wins, losses,
    winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : 0,
    sumPnl, avgPnl: closed.length ? +(sumPnl / closed.length).toFixed(2) : 0,
    unrealized: +unrealized.toFixed(2), peak: +peak.toFixed(2),
    drawdownPct: peak > 0 ? +((peak - eq) / peak * 100).toFixed(2) : 0,
    mode: settings.tradeMode, autoTrade: settings.autoTrade };
}
function paperSettingsView() {
  return { auto: settings.auto, autoTrade: settings.autoTrade, tradeMode: settings.tradeMode,
    margin: settings.margin, leverage: settings.leverage, riskPct: settings.riskPct,
    maxOpen: settings.maxOpen, autoMaxOpen: settings.autoMaxOpen, dailyLossPct: settings.dailyLossPct, liveKeys: HAS_KEYS };
}
function viewPaper(p) {
  const px = priceOf(p.symbol) || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +((p.grossRealized - p.costPaid) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(0.0001, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt, durationMs: Date.now() - p.openedAt });
}
function viewSignal(s) {
  const plan = (s.info && s.info.plan) || { entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2 };
  return Object.assign({}, s, { ageMs: Date.now() - s.createdAt,
    approvalRemainingMs: s.approvalExpiresAt ? Math.max(0, s.approvalExpiresAt - Date.now()) : 0,
    riskPct: +(Math.abs(s.entry - s.sl) / s.entry * 100).toFixed(2), plan, analysis: s.analysis || analyzeSignal(s) });
}
function isFilledTrade(s) { return !!s && s.status === 'KAPALI' && TRADE_RESULTS.has(s.result) && s.netR != null && s.tradeable !== false; }
function isVirtual(s) { return !!s && s.tradeable === false && s.status === 'KAPALI' && TRADE_RESULTS.has(s.result) && s.netR != null; }
function statsByModule() {
  const rows = [];
  for (const m of ACTIVE_MODULES) {
    const list = signals.filter(s => s.module === m);
    const filled = list.filter(isFilledTrade);
    const virt = list.filter(isVirtual);
    const skipped = list.filter(s => SKIP_RESULTS.has(s.result));
    const open = list.filter(s => s.status !== 'KAPALI');
    const wins = filled.filter(s => s.netR > 0);
    const losses = filled.filter(s => s.netR <= 0);
    const vWins = virt.filter(s => s.netR > 0);
    const reasons = {}, skipReasons = {};
    for (const s of filled) reasons[s.result] = (reasons[s.result] || 0) + 1;
    for (const s of skipped) skipReasons[s.result] = (skipReasons[s.result] || 0) + 1;
    const netR = +filled.reduce((a, s) => a + num(s.netR), 0).toFixed(3);
    const grossR = +filled.reduce((a, s) => a + num(s.grossR), 0).toFixed(3);
    rows.push({ module: m, label: MODS[m].label, total: list.length, open: open.length,
      filled: filled.length, skipped: skipped.length,
      unfilled: list.filter(s => s.status === 'KAPALI' && !TRADE_RESULTS.has(s.result) && !SKIP_RESULTS.has(s.result)).length,
      wins: wins.length, losses: losses.length,
      winRate: filled.length ? +(wins.length / filled.length * 100).toFixed(1) : 0,
      grossR, netR, avgR: filled.length ? +(netR / filled.length).toFixed(3) : null,
      virtual: virt.length, virtualWins: vWins.length,
      hitRate: virt.length ? +(vWins.length / virt.length * 100).toFixed(1) : 0,
      reasons, skipReasons });
  }
  const tot = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, filled: 0, skipped: 0, unfilled: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, avgR: null, virtual: 0, virtualWins: 0, hitRate: 0, reasons: {}, skipReasons: {} };
  for (const r of rows) {
    for (const k of ['total', 'open', 'filled', 'skipped', 'unfilled', 'wins', 'losses', 'virtual', 'virtualWins']) tot[k] += r[k];
    tot.grossR += r.grossR; tot.netR += r.netR;
    for (const k of Object.keys(r.reasons)) tot.reasons[k] = (tot.reasons[k] || 0) + r.reasons[k];
    for (const k of Object.keys(r.skipReasons)) tot.skipReasons[k] = (tot.skipReasons[k] || 0) + r.skipReasons[k];
  }
  tot.grossR = +tot.grossR.toFixed(3); tot.netR = +tot.netR.toFixed(3);
  tot.winRate = tot.filled ? +(tot.wins / tot.filled * 100).toFixed(1) : 0;
  tot.avgR = tot.filled ? +(tot.netR / tot.filled).toFixed(3) : null;
  tot.hitRate = tot.virtual ? +(tot.virtualWins / tot.virtual * 100).toFixed(1) : 0;
  rows.push(tot);
  return rows;
}

/* ───────── BACKTEST ───────── */
const BT_JOBS = new Map();
function btStats(arr) {
  const a = arr.filter(v => Number.isFinite(v));
  const wins = a.filter(v => v > 0);
  const losses = a.filter(v => v <= 0);
  const sumR = +a.reduce((s, v) => s + v, 0).toFixed(3);
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  let peak = 0, eq = 0, maxDD = 0;
  for (const v of a) { eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  return { n: a.length, sumR, avgR: a.length ? +(sumR / a.length).toFixed(3) : 0,
    winRate: a.length ? +(wins.length / a.length * 100).toFixed(1) : 0,
    pf: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99 : 0), maxDD: +maxDD.toFixed(2) };
}
function btStart(body) {
  const id = 'B' + Date.now().toString(36);
  const job = { id, status: 'çalışıyor', progress: 0, result: null, error: null, at: Date.now() };
  BT_JOBS.set(id, job);
  runBacktest(job, body || {}).catch(e => { job.status = 'hata'; job.error = redact(e.message); log('BT hatası: ' + e.message); });
  if (BT_JOBS.size > 20) { const k = BT_JOBS.keys().next().value; BT_JOBS.delete(k); }
  return id;
}
async function runBacktest(job, body) {
  const mod = body.module === 'LT' ? 'LT' : 'PUMP';
  const tf = mod === 'LT' ? (body.tf === '4h' ? '4h' : '2h') : '5m';
  const coins = clamp(num(body.coins, 8), 1, 20);
  const list = UNIVERSE.slice(0, coins);
  const trades = [];
  for (let ci = 0; ci < list.length; ci++) {
    const sym = list[ci];
    const cs = await getCandles(sym, tf, mod === 'LT' ? 700 : 1500, true);
    if (!cs || cs.length < 160) { job.progress = (ci + 1) / list.length; continue; }
    let lastAt = 0;
    const step = mod === 'LT' ? 1 : 2;
    for (let i = 140; i < cs.length - 12; i += step) {
      const win = cs.slice(Math.max(0, i - (mod === 'LT' ? 220 : 180)), i + 1);
      const lastC = win[win.length - 1];
      let raw = null;
      if (mod === 'LT') { const tri = analyzeTriangle(win, tf); if (tri) raw = ltSignalFrom(sym, win, tf, tri, { price: lastC.c }); }
      else { const a = scalpAnalyze(sym, win, { price: lastC.c, spread: 0.02, now: lastC.t }); if (a && a.raw) raw = a.raw; }
      if (!raw) continue;
      if (lastAt && lastC.t - lastAt < (mod === 'LT' ? 6 * H1 : 45 * M1)) continue;
      lastAt = lastC.t;
      const d = raw.dir === 'LONG' ? 1 : -1;
      const entry = raw.entry, sl = raw.sl, tp1 = raw.tp1, tp2 = raw.tp2;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      let out = null, tp1Hit = false, curSl = sl;
      const maxBars = mod === 'LT' ? 80 : 30;
      for (let j = i + 1; j < Math.min(cs.length, i + 1 + maxBars); j++) {
        const c = cs[j];
        if (d === 1) {
          if (c.l <= curSl) { out = { px: curSl, res: tp1Hit ? 'BE' : 'SL' }; break; }
          if (!tp1Hit && c.h >= tp1) { tp1Hit = true; curSl = entry + entry * EX.H / 100; }
          if (tp1Hit && c.h >= tp2) { out = { px: tp2, res: 'TP2' }; break; }
        } else {
          if (c.h >= curSl) { out = { px: curSl, res: tp1Hit ? 'BE' : 'SL' }; break; }
          if (!tp1Hit && c.l <= tp1) { tp1Hit = true; curSl = entry - entry * EX.H / 100; }
          if (tp1Hit && c.l <= tp2) { out = { px: tp2, res: 'TP2' }; break; }
        }
      }
      if (!out) { const c = cs[Math.min(cs.length - 1, i + maxBars)]; out = { px: c.c, res: 'TIME' }; }
      let grossR;
      if (tp1Hit) grossR = 0.5 * Math.abs(tp1 - entry) / risk + 0.5 * (out.res === 'BE' ? 0 : (out.px - entry) * d / risk);
      else grossR = (out.px - entry) * d / risk;
      const netR = +(grossR - EX.H / (risk / entry * 100)).toFixed(3);
      trades.push({ sym, dir: raw.dir, setup: raw.info.setup || 'LT', res: out.res, grossR: +grossR.toFixed(3), netR, at: cs[i].t });
    }
    job.progress = (ci + 1) / list.length;
    await new Promise(r => setTimeout(r, 5));
  }
  job.result = { module: mod, label: MODS[mod].label, tf, coins: list.length, trades: trades.length,
    all: btStats(trades.map(t => t.netR)),
    bySetup: Object.fromEntries(Array.from(new Set(trades.map(t => t.setup))).map(k => [k, btStats(trades.filter(t => t.setup === k).map(t => t.netR))])),
    reasons: trades.reduce((a, t) => { a[t.res] = (a[t.res] || 0) + 1; return a; }, {}),
    note: VERSION + ': Backtest matematik sinyallerini kapanmış mumlarda simüle eder. Net R maliyet %' + EX.H + ' düşülerek hesaplanır.' };
  job.status = 'bitti';
}
/* ══════════════════════════════════════════════════════════════════════════════
   CANLI BITGET MOTORU
   ══════════════════════════════════════════════════════════════════════════════ */
function liveBalanceView() {
  const b = LIVE.balance;
  if (!b) return { total: 0, free: 0, used: 0, at: 0, error: LIVE.lastError || null };
  return { total: +num(b.total).toFixed(2), free: +num(b.free).toFixed(2), used: +num(b.used).toFixed(2), at: b.at || 0, error: LIVE.lastError || null };
}
async function fetchLiveBalance(force) {
  if (!HAS_KEYS) return { total: 0, free: 0, used: 0, at: Date.now(), error: 'anahtar yok' };
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
      if (row) { total = num(row.equity || row.accountEquity || row.available || row.crossedMaxAvailable, total); free = num(row.available || row.crossedMaxAvailable || row.maxTransferOut, free); used = Math.max(0, total - free); }
    }
    LIVE.balance = { total, free, used: used || Math.max(0, total - free), at: Date.now() };
    LIVE.lastError = null;
    LIVE.ipHint = null;
    return LIVE.balance;
  } catch (e) {
    LIVE.lastError = redact(e.message);
    if (/IP|whitelist|ip address/i.test(String(e.message || ''))) { LIVE.ipHint = 'Bitget IP kısıtlaması olabilir. API anahtarının IP whitelist ayarını kontrol et.'; }
    log('CANLI BAKİYE HATASI: ' + LIVE.lastError);
    return LIVE.balance || { total: 0, free: 0, used: 0, at: Date.now(), error: LIVE.lastError };
  }
}
async function fetchLivePositions() {
  if (!HAS_KEYS) return null;
  const symbols = Array.from(new Set(LIVE.open.map(p => p.symbol)));
  try {
    const list = symbols.length ? await ex.fetchPositions(symbols, { type: 'swap' }) : await ex.fetchPositions(undefined, { type: 'swap' });
    LIVE.positions = Array.isArray(list) ? list : [];
    return LIVE.positions;
  } catch (e) { LIVE.lastError = redact(e.message); return null; }
}
function findExchangePosition(sym, dir) {
  const list = LIVE.positions || [];
  return list.find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0 && String(p.side || '').toLowerCase() === (dir === 'LONG' ? 'long' : 'short'))
    || list.find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0) || null;
}
async function fastLivePrice(sym, fallback) {
  try { const t = await ex.fetchTicker(sym); const p = num(t && (t.last || t.close)); if (p > 0) return p; } catch (e) { /* sessiz */ }
  return priceOf(sym) || fallback || 0;
}
async function placeLiveProtection(sig, pos, d, amount) {
  const closeSide = d === 1 ? 'sell' : 'buy';
  let stopOk = false;
  try {
    const so = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { stopLossPrice: sig.sl, reduceOnly: true });
    pos.stopOrderId = so && so.id;
    stopOk = !!(so && so.id);
  } catch (e) { log('CANLI STOP KURULAMADI: ' + sig.base + ' → ' + redact(e.message)); }
  if (!stopOk) {
    try {
      await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { reduceOnly: true });
      log('KORUMASIZ POZİSYON KAPATILDI: ' + sig.base);
    } catch (e2) { log('!!! ACİL: ' + sig.base + ' stopsuz açık kalmış olabilir → ' + redact(e2.message)); }
    return false;
  }
  if (sig.tp2) {
    try {
      const to = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { takeProfitPrice: sig.tp2, reduceOnly: true });
      pos.tpOrderId = to && to.id;
    } catch (e) { log('CANLI TP KURULAMADI: ' + sig.base + ' → ' + redact(e.message)); }
  }
  return true;
}
async function liveOpen(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (!HAS_KEYS) return { error: 'Bitget anahtarı yok' };
  if (settings.tradeMode !== 'live') return openPaper(sig);
  if (!['AUTO', 'PUMP'].includes(sig.module)) return { error: 'bu modül canlı olamaz' };
  if (LIVE.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin canlı açık' };
  if (paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin paper açık' };
  if (sig.module === 'AUTO') { if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks ' + settings.autoMaxOpen }; }
  else if (LIVE.open.length + paper.open.length >= settings.maxOpen) return { error: 'maks açık' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const px = await fastLivePrice(sig.symbol, sig.entry);
  if (!(px > 0)) return { error: 'fiyat yok' };
  const drift = Math.abs(px / sig.entry - 1) * 100;
  const maxDrift = sig.module === 'AUTO' ? 1.2 : Math.max(0.22, Math.min(0.65, num(sig.info && sig.info.atrPct, 0.5) * 0.35));
  if (drift > maxDrift) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const bal = await fetchLiveBalance(true);
  if (!(bal.total > 0)) return { error: 'bakiye yok' };
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = rp(px);
  const riskPerUnit = Math.abs(entry - sig.sl);
  if (!(riskPerUnit > 0)) return { error: 'stop geçersiz' };
  const riskAmt = Math.max(1, bal.total * settings.riskPct / 100);
  let qty = riskAmt / riskPerUnit;
  const maxNotional = Math.min(bal.total * settings.leverage * 0.95, settings.margin * settings.leverage);
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  let amount;
  try { amount = ex.amountToPrecision(sig.symbol, qty); } catch (e) { amount = qty; }
  if (!(Number(amount) > 0)) return { error: 'miktar 0' };
  if (Number(amount) * entry < 5) return { error: 'emir çok küçük (min 5 USDT)' };
  try { await ex.setLeverage(settings.leverage, sig.symbol); } catch (e) { log('KALDIRAÇ AYARLANAMADI: ' + sig.base); }
  let order;
  try {
    order = await ex.createOrder(sig.symbol, 'market', d === 1 ? 'buy' : 'sell', amount, undefined, {});
  } catch (e) {
    LIVE.lastError = redact(e.message);
    if (/IP|whitelist|ip address/i.test(String(e.message || ''))) { LIVE.ipHint = 'Bitget IP kısıtlaması olabilir. API anahtarının IP whitelist ayarını kontrol et.'; }
    log('CANLI GİRİŞ: ' + sig.base + ' → ' + LIVE.lastError);
    return { error: LIVE.lastError };
  }
  const fill = rp(num(order && (order.average || order.price), entry));
  const pos = { id: 'L' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry: fill, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +Number(amount).toFixed(8), initialQty: +Number(amount).toFixed(8), remainingQty: +Number(amount).toFixed(8),
    notional: +(Number(amount) * fill).toFixed(4), margin: +((Number(amount) * fill) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(Number(amount) * Math.abs(fill - sig.sl)).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxR: 0,
    maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 20 * M1)),
    setup: (sig.info && sig.info.setup) || null, isLive: true, scalp: sig.module === 'PUMP', quickTpPct: null,
    orderId: order && order.id, stopOrderId: null, tpOrderId: null,
    exchangeQty: +Number(amount).toFixed(8), closing: false, aiExitAt: 0 };
  const prot = await placeLiveProtection(sig, pos, d, amount);
  if (!prot) { skipSignal(sig, 'SKIP', 'stop kurulamadı, pozisyon kapatıldı'); return { error: 'stop kurulamadı, pozisyon kapatıldı' }; }
  sig.entry = fill; sig.status = 'AKTIF'; sig.startedAt = pos.openedAt; sig.isLive = true; sig.operatorApprovedAt = pos.openedAt;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'canlı emir açıldı', decidedAt: Date.now() });
  LIVE.open.push(pos); LIVE.needsSync = true; dirty = true; saveState(false);
  log('CANLI AÇILDI: ' + sig.base + ' ' + sig.dir + ' | ' + fill + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | ' + amount);
  fetchLiveBalance(true).catch(() => {});
  return { pos };
}
async function liveClose(pos, price, reason, portion) {
  if (!pos || !pos.isLive) return { error: 'canlı değil' };
  if (pos.closing) return { error: 'kapanıyor' };
  pos.closing = true;
  try {
    const qty = portion && portion > 0 ? Math.min(portion, pos.remainingQty) : pos.remainingQty;
    if (!(qty > 0)) return { error: 'miktar 0' };
    let amount;
    try { amount = ex.amountToPrecision(pos.symbol, qty); } catch (e) { amount = qty; }
    const d = pos.dir === 'LONG' ? 1 : -1;
    let fill = price;
    try {
      const order = await ex.createOrder(pos.symbol, 'market', d === 1 ? 'sell' : 'buy', amount, undefined, { reduceOnly: true });
      fill = num(order && (order.average || order.price), price);
    } catch (e) { LIVE.lastError = redact(e.message); log('CANLI KAPATMA: ' + pos.base + ' → ' + LIVE.lastError); return { error: LIVE.lastError }; }
    if (!(fill > 0)) fill = priceOf(pos.symbol) || pos.entry;
    const partQty = Number(amount);
    const gross = (fill - pos.entry) * d * partQty;
    const cost = partQty * pos.entry * EX.H / 100;
    pos.grossRealized += gross; pos.costPaid += cost;
    pos.realized = pos.grossRealized - pos.costPaid;
    pos.remainingQty = +(pos.remainingQty - partQty).toFixed(8);
    const dust = Math.max(1e-9, pos.initialQty * 0.01);
    if (pos.remainingQty > dust) {
      dirty = true;
      log('CANLI KISMİ: ' + pos.base + ' ' + partQty + ' → ' + rp(fill) + ' | kalan ' + pos.remainingQty);
      fetchLiveBalance(true).catch(() => {});
      return { partial: true, exit: rp(fill), remaining: pos.remainingQty };
    }
    const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
    const grossR = +(pos.grossRealized / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    const sig = signals.find(s => s.id === pos.sigId);
    if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(fill); sig.closedAt = Date.now(); sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.isLive = true; sig.analysis = analyzeSignal(sig); }
    LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
    const rec = Object.assign({}, pos, { exit: rp(fill), result: reason, pnl: net, netR, grossR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt, closing: false });
    delete rec.remainingQty;
    LIVE.closed.push(rec); capArr(LIVE.closed, 200);
    OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, conf: sig ? sig.conf : null, createdAt: sig ? sig.createdAt : pos.openedAt });
    capArr(OUT, 300);
    appendDecision({ type: 'sonuc', sigId: pos.sigId, module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, isLive: true });
    LIVE.needsSync = true; dirty = true; saveState(false);
    log('CANLI KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R');
    if (pos.stopOrderId) ex.cancelOrder(pos.stopOrderId, pos.symbol).catch(() => {});
    if (pos.tpOrderId) ex.cancelOrder(pos.tpOrderId, pos.symbol).catch(() => {});
    fetchLiveBalance(true).catch(() => {});
    return { exit: rp(fill), netR, pnl: net };
  } finally { pos.closing = false; }
}
function finalizeLive(pos, price, reason) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const qty = pos.remainingQty || 0;
  if (qty > 0) { pos.grossRealized += (price - pos.entry) * d * qty; pos.costPaid += qty * pos.entry * EX.H / 100; }
  const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
  const sig = signals.find(s => s.id === pos.sigId);
  if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(price); sig.closedAt = Date.now(); sig.netR = netR; sig.pnlUsdt = net; sig.isLive = true; }
  LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
  LIVE.closed.push(Object.assign({}, pos, { exit: rp(price), result: reason, pnl: net, netR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt }));
  capArr(LIVE.closed, 200);
  OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, createdAt: sig ? sig.createdAt : pos.openedAt });
  capArr(OUT, 300);
  dirty = true;
  log('CANLI BORSADA KAPANDI: ' + pos.base + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R');
}
async function syncLive() {
  if (!HAS_KEYS || !LIVE.open.length || LIVE.busy) return;
  LIVE.busy = true;
  try {
    const list = await fetchLivePositions();
    if (!list) return;
    for (const pos of LIVE.open.slice()) {
      const ep = findExchangePosition(pos.symbol, pos.dir);
      if (ep) { pos.exchangeQty = num(ep.contracts, pos.exchangeQty); pos.markPrice = num(ep.markPrice, pos.markPrice); pos.unrealizedPnl = num(ep.unrealizedPnl, pos.unrealizedPnl); }
      else if (Date.now() - pos.openedAt > 20e3) { const px = await fastLivePrice(pos.symbol, pos.markPrice || pos.entry); finalizeLive(pos, px, 'EXCHANGE'); }
    }
    LIVE.lastSync = Date.now();
  } finally { LIVE.busy = false; }
}
async function monitorLive() {
  if (!HAS_KEYS || !LIVE.open.length) return;
  for (const pos of LIVE.open.slice()) {
    if (pos.closing) continue;
    const px = await fastLivePrice(pos.symbol, pos.markPrice || pos.entry);
    if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px);
    pos.ageMs = Date.now() - pos.openedAt;
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    const rNow0 = (px - pos.entry) * d / rRisk;
    pos.maxR = Math.max(pos.maxR || 0, rNow0);
    const unreal = (pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty;
    pos.livePnl = +unreal.toFixed(4);
    pos.livePnlPct = +(unreal / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { await liveClose(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL'); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { await liveClose(pos, pos.tp2, 'TP2'); continue; }
    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const q = +(pos.initialQty * 0.5).toFixed(8);
      const r = await liveClose(pos, pos.tp1, 'TP1', q);
      if (r && !r.error) { pos.tp1Hit = true; pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100); const sig = signals.find(s => s.id === pos.sigId); if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; } dirty = true; log('CANLI TP1: ' + pos.base + ' yarısı alındı'); }
      continue;
    }
    if (pos.ageMs >= pos.maxHoldMs) { await liveClose(pos, px, 'TIME'); continue; }
    const fr = autoFadeCheck(pos, px, d);
    if (fr) { await liveClose(pos, px, fr); continue; }
    if (pos.tp1Hit) { const trail = rp(px - d * Math.max(pos.entry * 0.0025, Math.abs(pos.entry - pos.sl) * 0.35)); if (d === 1 ? trail > pos.curSl : trail < pos.curSl) pos.curSl = trail; }
  }
  LIVE.lastSync = Date.now();
}
function liveSummary() {
  const b = liveBalanceView();
  const closed = LIVE.closed;
  const wins = closed.filter(x => num(x.pnl) > 0).length;
  const losses = closed.filter(x => num(x.pnl) <= 0).length;
  const sumPnl = +closed.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of LIVE.open) { const px = p.livePrice || p.markPrice || priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  return { equity: b.total, balance: b.total, free: b.free, used: b.used, start: b.total, dayStart: b.total, dayPnl: sumPnl,
    open: LIVE.open.length, closed: closed.length, wins, losses,
    winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : 0,
    sumPnl, avgPnl: closed.length ? +(sumPnl / closed.length).toFixed(2) : 0,
    unrealized: +unrealized.toFixed(2), peak: b.total, drawdownPct: 0,
    mode: 'live', autoTrade: settings.autoTrade, balanceError: b.error || null, ipHint: LIVE.ipHint || null };
}
function viewLivePos(p) {
  const px = p.livePrice || p.markPrice || priceOf(p.symbol) || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +(((p.grossRealized || 0) - (p.costPaid || 0)) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(0.0001, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt, durationMs: Date.now() - p.openedAt });
}
async function checkOrphans() {
  if (!HAS_KEYS) return;
  const list = await fetchLivePositions();
  if (!list) return;
  const real = list.filter(p => p && Math.abs(num(p.contracts)) > 0);
  const known = new Set(LIVE.open.map(p => p.symbol));
  const orphans = real.filter(p => !known.has(p.symbol));
  if (orphans.length) {
    log('UYARI: Borsada AlphaSon\'un bilmediği ' + orphans.length + ' açık pozisyon var: ' +
      orphans.map(p => baseOf(p.symbol) + ' ' + p.side).join(', ') +
      ' (state.json kaybolmuş olabilir. SL/TP\'yi borsada elle kontrol et.)');
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   OTOTRADE — mum içi aday, AI kontrol listesi
   ══════════════════════════════════════════════════════════════════════════════ */
function autoContext(sym, cs, opt) {
  if (!cs || cs.length < 60) return null;
  const n = cs.length, last = cs[n - 1], prev = cs[n - 2];
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const now = (opt && Number(opt.now) > 0) ? Number(opt.now) : Date.now();
  const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  if (!(px > 0)) return null;
  const cl = closesOf(cs);
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  const volSma = avg(cs.slice(-30, -1).map(c => c.v));
  const vwapObj = vwapOf(cs, utcDayStart(now));
  const hi20 = Math.max.apply(null, cs.slice(-20).map(c => c.h));
  const lo20 = Math.min.apply(null, cs.slice(-20).map(c => c.l));
  const age = Math.max(15, Math.min(60, (now - last.t) / 1000));
  const forming = (now - last.t) < 60e3;
  const expVol = volSma * (forming ? age / 60 : 1);
  return { sym, cs, n, last, prev, px, now, atr, atrPct: atr / px * 100,
    cl, e20, e50, rsi: rsiLast(cl, 14), adx: (adxLast(cs, 14) || {}).adx || null,
    volRatio: expVol > 0 ? last.v / expVol : 0,
    chg1: (last.c / prev.c - 1) * 100,
    chg3: (last.c / cs[n - 4].c - 1) * 100,
    chg5: (last.c / cs[n - 6].c - 1) * 100,
    body: bodyRatio(last), bodyAtr: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr,
    vwap: vwapObj.vwap, vwapSd: vwapObj.sd, hi20, lo20,
    breakUp: last.c > hi20 * 1.0004, breakDn: last.c < lo20 * 0.9996,
    spread: (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym),
    forming, candleAge: Math.round(age) };
}
function makeAutoCandidate(ctx, dir, score, reasons, risks, setup) {
  const d = dir === 'LONG' ? 1 : -1;
  const px = rp(ctx.px);
  const riskPct = clamp(Math.max(0.90, ctx.atrPct * 1.05), 0.90, 2.20);
  const risk = px * riskPct / 100;
  let sl = px - d * risk;
  const swing = d === 1 ? Math.min.apply(null, ctx.cs.slice(-6).map(c => c.l)) : Math.max.apply(null, ctx.cs.slice(-6).map(c => c.h));
  if (d === 1 ? swing < sl : swing > sl) sl = swing - d * 0.10 * ctx.atr;
  const entry = px;
  const riskFinal = Math.abs(entry - sl);
  if (!(riskFinal > 0)) return null;
  const tp1 = rp(entry + d * Math.max(riskFinal * 1.50, entry * 0.008));
  const tp2 = rp(entry + d * Math.max(riskFinal * 2.50, entry * 0.014));
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net < 0.90 || q2.net < 1.50) return null;
  const finalRiskPct = riskFinal / entry * 100;
  if (finalRiskPct < 0.70 || finalRiskPct > 2.50) return null;
  return { module: 'AUTO', symbol: ctx.sym, base: baseOf(ctx.sym), dir,
    entry, sl: rp(sl), tp1, tp2, single: false, conf: clamp(Math.round(score), 45, 95), retest: false,
    holdSec: 20 * 60, noMoveSec: 120,
    info: { tf: '1m', source: 'math', setup: setup || 'PUMP', plan: { entry, sl: rp(sl), tp1, tp2 },
      netRR: q1.net, netRR2: q2.net, riskPct: +finalRiskPct.toFixed(2),
      atrPct: +ctx.atrPct.toFixed(2), volRatio: +ctx.volRatio.toFixed(2),
      bodyRatio: +ctx.body.toFixed(2), bodyAtr: +ctx.bodyAtr.toFixed(2),
      chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2), chg5: +ctx.chg5.toFixed(2),
      rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
      vwap: rp(ctx.vwap), hi20: rp(ctx.hi20), lo20: rp(ctx.lo20),
      spreadPct: +ctx.spread.toFixed(3), reasons, risks },
    maxAgeMs: 6 * M1,
    setupKey: 'AUTO|' + ctx.sym + '|' + dir + '|' + Math.floor(ctx.last.t / M1) };
}
function autoCandidatesRaw(ctx) {
  const out = [];
  if (!ctx) return out;
  const pump = ctx.chg1 >= 0.65 || ctx.chg3 >= 1.10 || ctx.chg5 >= 1.70;
  const dump = ctx.chg1 <= -0.65 || ctx.chg3 <= -1.10 || ctx.chg5 <= -1.70;
  const volOk = ctx.volRatio >= 1.8;
  const bodyOk = ctx.body >= 0.42 && ctx.bodyAtr >= 0.45;
  const notExhausted = Math.abs(ctx.chg5) <= 7.5;
  if (pump && volOk && bodyOk && notExhausted && (ctx.breakUp || ctx.last.c > (ctx.e20[ctx.n - 1] || ctx.px)) && (!ctx.vwap || ctx.px >= ctx.vwap * 0.999)) {
    const score = 58 + clamp(ctx.volRatio - 1.8, 0, 2) * 8 + clamp(Math.abs(ctx.chg3), 0, 3) * 5 + (ctx.breakUp ? 8 : 0) + (ctx.body >= 0.6 ? 5 : 0);
    const c = makeAutoCandidate(ctx, 'LONG', score,
      ['Pump 1m %' + ctx.chg1.toFixed(2), 'Hacim ' + ctx.volRatio.toFixed(1) + 'x'],
      [ctx.chg5 > 4 ? 'Uzamış' : '', ctx.rsi != null && ctx.rsi > 78 ? 'RSI aşırı' : ''], 'PUMP');
    if (c) out.push(c);
  }
  if (dump && volOk && bodyOk && notExhausted && (ctx.breakDn || ctx.last.c < (ctx.e20[ctx.n - 1] || ctx.px)) && (!ctx.vwap || ctx.px <= ctx.vwap * 1.001)) {
    const score = 58 + clamp(ctx.volRatio - 1.8, 0, 2) * 8 + clamp(Math.abs(ctx.chg3), 0, 3) * 5 + (ctx.breakDn ? 8 : 0) + (ctx.body >= 0.6 ? 5 : 0);
    const c = makeAutoCandidate(ctx, 'SHORT', score,
      ['Dump 1m %' + ctx.chg1.toFixed(2), 'Hacim ' + ctx.volRatio.toFixed(1) + 'x'],
      [ctx.chg5 < -4 ? 'Uzamış' : '', ctx.rsi != null && ctx.rsi < 22 ? 'RSI aşırı' : ''], 'DUMP');
    if (c) out.push(c);
  }
  return out;
}
function autoCandidates(ctx) {
  if (!ctx) return [];
  if (ctx.forming && ctx.candleAge < 20) return [];
  const list = autoCandidatesRaw(ctx);
  const out = [];
  for (const c of list) {
    const d = c.dir === 'LONG' ? 1 : -1;
    const recent = ctx.cs.slice(-11, -1).map(x => x.c);
    const start = d === 1 ? Math.min.apply(null, recent) : Math.max.apply(null, recent);
    const prog = ((ctx.px - start) * d) / ctx.atr;
    if (prog > 2.5) continue;
    c.info.atrProgress = +prog.toFixed(2);
    c.info.forming = !!ctx.forming;
    c.info.candleAgeSec = ctx.candleAge || 60;
    out.push(c);
  }
  return out;
}
let autoScanning = false;
async function autoScan(fast) {
  if (autoScanning) return;
  autoScanning = true;
  try {
    const list = scanSyms('AUTO', fast ? 25 : 50);
    const rows = [], raws = [];
    await pool(list, 6, async (sym) => {
      const cs = await getCandles(sym, '1m', 120, false);
      if (!cs || cs.length < 60) return;
      const ctx = autoContext(sym, cs);
      if (!ctx) return;
      if (ctx.spread > settings.maxSpreadPct) return;
      if (ctx.atrPct < 0.10 || ctx.atrPct > 3.5) return;
      const cands = autoCandidates(ctx);
      if (!cands.length) return;
      cands.sort((a, b) => b.conf - a.conf);
      const best = cands[0];
      rows.push({ symbol: sym, base: baseOf(sym), tf: '1m', price: rp(ctx.px), dir: best.dir,
        setup: best.info.setup, state: 'ADAY', score: best.conf,
        chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2), chg5: +ctx.chg5.toFixed(2),
        volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
        bodyRatio: +ctx.body.toFixed(2), bodyAtr: +ctx.bodyAtr.toFixed(2),
        rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
        vwap: rp(ctx.vwap), hi20: rp(ctx.hi20), lo20: rp(ctx.lo20),
        spreadPct: +ctx.spread.toFixed(3), trigger: best.entry,
        sl: best.sl, tp1: best.tp1, tp2: best.tp2, netRR: best.info.netRR,
        atrProgress: best.info.atrProgress, reason: best.info.reasons[0] || '', ai: null });
      raws.push(best);
    });
    rows.sort((a, b) => b.score - a.score || Math.abs(b.chg3) - Math.abs(a.chg3));
    AUTO_WATCH = rows.slice(0, 20);
    WATCH.auto = AUTO_WATCH;
    WATCH_META.auto = { scannedAt: Date.now(), count: AUTO_WATCH.length, universe: list.length };
    lastScan.auto = Date.now();
    if (settings.autoTrade === true && aiReady() && autoOpenCount() < settings.autoMaxOpen) {
      raws.sort((a, b) => b.conf - a.conf);
      let emitted = 0;
      for (const raw of raws) {
        if (emitted >= 2) break;
        const prev = AUTO_FIRED.get(raw.symbol);
        if (prev && Date.now() - prev < 10 * M1) continue;
        const sig = addSignal(raw);
        if (sig) { AUTO_FIRED.set(raw.symbol, Date.now()); emitted++; log('OTOTRADE ADAY: ' + sig.base + ' ' + sig.dir); }
      }
    }
  } catch (e) { log('OtoTrade tarama hatası: ' + redact(e.message)); }
  finally { autoScanning = false; }
}

/* ══════════════════════════════════════════════════════════════════════════════
   AI KATMANI — kontrol listesi + günlük kota takibi
   ══════════════════════════════════════════════════════════════════════════════ */
const AI_CFG = {
  modules: ['AUTO', 'PUMP', 'LT'], maxPerDay: 600, maxPerHour: 120, briefPerDay: 6,
  timeoutMs: 25000, approvalWindowMs: 10 * M1, cacheMs: 5 * M1, gapMs: 1400,
  discoverEveryMs: 6 * H1, discoverModelsPerProvider: 12, discoverMaxWorking: 4,
  marketEveryMs: 5 * M1, marketMaxAgeMs: 40 * M1
};
function aiKeys() { return AI_PROV.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled === true && aiKeys().length > 0); }
function provDayReset(p) {
  const dk = dayKey();
  if (p.dayKey !== dk) { p.dayKey = dk; p.dayCount = 0; }
}
function aiQuota() {
  const now = Date.now();
  const dk = dayKey(now), hk = Math.floor(now / H1);
  if (AI_USAGE.dayKey !== dk) { AI_USAGE.dayKey = dk; AI_USAGE.dayCount = 0; }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  if (AI_USAGE.briefDay !== dk) { AI_USAGE.briefDay = dk; AI_USAGE.briefCount = 0; }
  return { ok: AI_USAGE.dayCount < AI_CFG.maxPerDay && AI_USAGE.hourCount < AI_CFG.maxPerHour, day: dk, hour: hk, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount };
}
function provOk(p) {
  provDayReset(p);
  if (!(p.key && p.models && p.models.length)) return false;
  if (p.dayLimit && p.dayCount >= p.dayLimit) return false;
  return true;
}
function orderedProviders(prefer) {
  const now = Date.now();
  return aiKeys().slice().sort((a, b) => {
    const ca = (a.cooldownUntil || 0) > now ? 1 : 0;
    const cb = (b.cooldownUntil || 0) > now ? 1 : 0;
    if (ca !== cb) return ca - cb;
    if (prefer) { if (a.id === prefer) return -1; if (b.id === prefer) return 1; }
    return (a.prefer || 9) - (b.prefer || 9);
  });
}
function aiProviderView(p) {
  const now = Date.now();
  const lat = (p.lat || []).filter(v => Number.isFinite(v));
  provDayReset(p);
  return { id: p.id, name: p.name, hasKey: !!p.key, models: p.models.slice(),
    ok: p.ok || 0, fail: p.fail || 0, invalid: p.invalid || 0,
    dayCount: p.dayCount, dayLimit: p.dayLimit,
    avgMs: lat.length ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : 0,
    cooldownSec: Math.max(0, Math.ceil(((p.cooldownUntil || 0) - now) / 1000)),
    lastError: p.lastError || null, modelCooldowns: Object.assign({}, p.modelCooldowns || {}),
    prefer: p.prefer || 9, discoverAt: p.discoverAt || 0 };
}
function modelLooksChat(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  if (/embed|embedding|whisper|tts|audio|speech|transcribe|moderation|dall-e|gpt-image|image-generation|imagen|veo|realtime|rerank|guard|safety|aqa|clip|sora|stable-diffusion|flux|midjourney/.test(s)) return false;
  return true;
}
function modelRank(id) {
  const s = String(id || '').toLowerCase();
  let r = 50;
  if (/flash/.test(s)) r -= 14;
  if (/lite|mini|8b|instant|small|nano/.test(s)) r += 4;
  if (/2\.5|2\.0|latest/.test(s)) r -= 4;
  if (/:free$/.test(s)) r -= 10;
  if (/70b|405b|large|pro|sonnet|opus/.test(s)) r += 3;
  if (/preview|exp|experimental|alpha|beta/.test(s)) r += 8;
  if (/deepseek-chat|deepseek-v3|llama-3\.3|gpt-4o-mini|gpt-4\.1-mini|gpt-oss-120b/.test(s)) r -= 6;
  return r;
}
async function listProviderModels(p) {
  if (!p.key) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    if (p.id === 'gemini' && p.nativeBase) {
      const res = await fetch(p.nativeBase + '/models?pageSize=200&key=' + encodeURIComponent(p.key), { signal: ctl.signal });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
      if (!res.ok) { const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 240) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = /api key not valid|api_key_invalid|permission/i.test(String(msg)) ? 401 : res.status; throw er; }
      const arr = (j && j.models) || [];
      return arr.filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(m => m && modelLooksChat(m) && !/embedding|aqa|imagen|veo/.test(m));
    }
    const res = await fetch(p.base + '/models', { signal: ctl.signal, headers: { Authorization: 'Bearer ' + p.key } });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const msg = (j && j.error && (j.error.message || j.error.code)) || txt.slice(0, 240) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = res.status; throw er; }
    let arr = (j && (j.data || j.models)) || j || [];
    if (!Array.isArray(arr)) arr = [];
    return arr.map(x => String((x && (x.id || x.name)) || '').replace(/^models\//, '')).filter(m => m && modelLooksChat(m));
  } finally { clearTimeout(timer); }
}
async function discoverProviderModels(p, opts) {
  opts = opts || {};
  const maxTest = clamp(Math.round(num(opts.maxTest, AI_CFG.discoverModelsPerProvider)), 1, 40);
  const maxWorking = clamp(Math.round(num(opts.maxWorking, AI_CFG.discoverMaxWorking)), 1, 10);
  const row = { id: p.id, name: p.name, hasKey: !!p.key, listed: 0, tested: [], working: [], failed: [], at: Date.now(), error: null };
  if (!p.key) { row.error = 'anahtar yok'; return row; }
  let listed = [];
  try { listed = await listProviderModels(p); } catch (e) { row.error = 'model listesi: ' + redact(e.message); listed = (p.models || []).slice(); }
  row.listed = listed.length;
  const old = (p.models || []).slice();
  const cand = [];
  const push = m => { if (m && !cand.includes(m)) cand.push(m); };
  old.forEach(push); listed.forEach(push);
  cand.sort((a, b) => modelRank(a) - modelRank(b));
  const toTest = cand.slice(0, maxTest);
  const working = [];
  for (const model of toTest) {
    try {
      const r = await callProviderModel(p, [{ role: 'system', content: 'Yalnızca JSON döndür.' }, { role: 'user', content: '{"ok":true} biçiminde yanıt ver.' }], model, { timeoutMs: num(opts.timeoutMs, 15000) });
      working.push(model);
      row.tested.push({ model, ok: true, sample: String(r.text).slice(0, 60) });
      if (working.length >= maxWorking) break;
    } catch (e) { row.tested.push({ model, ok: false, error: redact(e.message).slice(0, 160) }); row.failed.push(model); }
  }
  row.working = working;
  if (working.length) {
    const rest = old.filter(m => !working.includes(m) && !row.failed.includes(m));
    p.models = working.concat(rest).slice(0, 10);
    p.modelCooldowns = {}; p.cooldownUntil = 0; p.nextAt = 0; p.lastError = null; p.discoverAt = Date.now(); dirty = true;
  } else { p.discoverAt = Date.now(); row.error = row.error || 'çalışan model bulunamadı'; }
  return row;
}
async function discoverAll(opts) {
  opts = opts || {};
  if (AI_DISCOVER.running) return { ok: false, error: 'keşif çalışıyor', at: AI_DISCOVER.at, results: AI_DISCOVER.results };
  AI_DISCOVER.running = true; AI_DISCOVER.error = null;
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  try {
    for (const p of AI_PROV) {
      if (!p.key) continue;
      if (only && !only.has(p.id)) continue;
      let row;
      try { row = await discoverProviderModels(p, opts); } catch (e) { row = { id: p.id, name: p.name, hasKey: true, working: [], tested: [], error: redact(e.message) }; }
      AI_DISCOVER.results[p.id] = row;
      log('AI KEŞİF: ' + p.name + ' → ' + (row.working && row.working.length ? row.working.join(', ') : 'yok') + (row.error ? ' | ' + row.error : ''));
    }
    AI_DISCOVER.at = Date.now(); dirty = true; saveState(false);
    return { ok: true, at: AI_DISCOVER.at, results: AI_DISCOVER.results, providers: AI_PROV.map(aiProviderView) };
  } catch (e) { AI_DISCOVER.error = redact(e.message); return { ok: false, error: AI_DISCOVER.error, results: AI_DISCOVER.results }; }
  finally { AI_DISCOVER.running = false; }
}
async function maybeDiscover() {
  if (AI_DISCOVER.running) return;
  const now = Date.now();
  const stale = AI_PROV.filter(p => p.key && (!p.discoverAt || now - p.discoverAt > AI_CFG.discoverEveryMs));
  if (!stale.length) return;
  await discoverAll({ only: stale.map(p => p.id), maxTest: AI_CFG.discoverModelsPerProvider });
}
function aiStatus() {
  const q = aiQuota();
  return { enabled: aiReady(), settingsEnabled: settings.aiEnabled === true, watchAuto: settings.aiWatchAuto === true,
    keys: aiKeys().length, providers: AI_PROV.map(aiProviderView),
    usage: { dayKey: q.day, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount, briefCount: AI_USAGE.briefCount, lastAt: AI_USAGE.lastAt || 0, lastError: AI_USAGE.lastError || null },
    limits: { maxPerDay: AI_CFG.maxPerDay, maxPerHour: AI_CFG.maxPerHour, briefPerDay: AI_CFG.briefPerDay },
    queue: AI_QUEUE.length, busy: AI_STATE.busy === true, lastAt: AI_STATE.lastAt || 0, lastError: AI_STATE.lastError || null,
    brief: marketBrief || null,
    discover: { running: AI_DISCOVER.running === true, at: AI_DISCOVER.at || 0, error: AI_DISCOVER.error || null, results: AI_DISCOVER.results || {} },
    models: Object.fromEntries(AI_PROV.map(p => [p.id, (p.models || []).slice()])), market: marketAI };
}
function normTR(s) {
  return String(s == null ? '' : s).replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g').replace(/Ü/g, 'U').replace(/ü/g, 'u').replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c').toUpperCase().replace(/\s+/g, ' ').trim();
}
function parseAIJSON(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { verdict: 'RED', score: 0, trust: 'DÜŞÜK', reason: 'AI yanıtı okunamadı', summary: raw.slice(0, 300), risks: ['JSON değil'], parseError: true };
  const v = normTR(j.verdict || j.decision || j.karar || j.entryDecision || '');
  const no = /GIRILMEZ|GIRME|RED|REJECT|HAYIR|NO$/.test(v);
  const yes = !no && /GIRILIR|GIREBILIR|AL$|BUY|LONG|APPROVE|ONAY|UYGUN|EVET/.test(v);
  const verdict = yes ? 'ONY' : 'RED';
  let trust = normTR(j.trust || j.confidence || j.guven || '');
  if (/YUKSEK|HIGH/.test(trust)) trust = 'YÜKSEK'; else if (/DUSUK|LOW/.test(trust)) trust = 'DÜŞÜK'; else trust = 'ORTA';
  let score = Number(j.score != null ? j.score : j.puan);
  if (!Number.isFinite(score)) score = trust === 'YÜKSEK' ? 80 : trust === 'ORTA' ? 60 : 40;
  score = clamp(Math.round(score), 0, 100);
  const arr = x => { if (Array.isArray(x)) return x.map(v2 => String(v2)).filter(Boolean).slice(0, 4); if (typeof x === 'string' && x.trim()) return x.split(/[\n;\u2022]/).map(v2 => v2.trim()).filter(Boolean).slice(0, 4); return []; };
  return { verdict, score, trust, reason: String(j.reason || j.neden || '').slice(0, 300), summary: String(j.summary || j.ozet || j.reason || j.neden || '').slice(0, 500), risks: arr(j.risks || j.riskler), parseError: false };
}
function isModelError(e) { const s = String((e && e.message) || '').toLowerCase(); return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer/.test(s); }
function isQuotaExhausted(e) { const s = String((e && e.message) || '').toLowerCase(); return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|credit balance|exceeded.*quota|resource_exhausted/.test(s); }
function isTransientAIError(e) { const status = Number(e && e.status) || 0; return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e); }
function providerFail(p, e) {
  const status = Number(e && e.status) || 0;
  p.fail = (p.fail || 0) + 1;
  p.lastError = redact((e && e.message) || 'bilinmeyen hata');
  let ms = M1;
  if (isQuotaExhausted(e)) ms = 6 * H1;
  else if (status === 402) ms = 6 * H1;
  else if (status === 429) ms = 2 * M1;
  else if (status === 401 || status === 403) ms = 60 * M1;
  else if (status >= 500) ms = 2 * M1;
  else if (isModelError(e)) ms = 10 * M1;
  p.cooldownUntil = Date.now() + ms;
  AI_USAGE.lastError = p.name + ': ' + p.lastError; AI_USAGE.lastAt = Date.now();
  AI_STATE.lastError = AI_USAGE.lastError;
  dirty = true;
  log('AI HATA: ' + p.name + ' → ' + p.lastError);
}
async function callGeminiNative(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  const t0 = Date.now();
  try {
    const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
    const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
    const body = { contents, generationConfig: { temperature: 0.15, maxOutputTokens: 700, responseMimeType: 'application/json' } };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    const url = p.nativeBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(p.key);
    const res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 300) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = /api key not valid|api_key_invalid|permission|unauthenticated/i.test(String(msg)) ? 401 : /not found|not supported|does not exist|no access/i.test(String(msg)) ? 404 : res.status; throw er; }
    if (j && j.error) { const er = new Error(redact(j.error.message || j.error.status || 'Gemini hatası')); er.status = Number(j.error.code) || 502; throw er; }
    const cand = j && j.candidates && j.candidates[0];
    let c = cand && cand.content && cand.content.parts ? cand.content.parts.map(x => (x && x.text) || '').join('\n') : '';
    if (!c || !String(c).trim()) { const block = cand && cand.finishReason ? String(cand.finishReason) : 'boş'; const er = new Error('boş yanıt (Gemini: ' + block + ')'); er.emptyResp = true; throw er; }
    p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
    return { text: String(c), model: model };
  } catch (e) { if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı'); er.status = 0; throw er; } throw e; }
  finally { clearTimeout(timer); }
}
async function callProviderModel(p, messages, model, opts) {
  if (p.id === 'gemini' && p.nativeBase) return callGeminiNative(p, messages, model, opts);
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  const t0 = Date.now();
  try {
    const res = await fetch(p.base + '/chat/completions', { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({ model, messages, temperature: 0.15, max_tokens: 450, stream: false }) });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || txt.slice(0, 300) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = res.status; const ra = res.headers.get('retry-after'); if (ra) { const n = Number(ra); er.retryAfterMs = Number.isFinite(n) ? n * 1000 : 60000; } throw er; }
    if (!j) throw new Error('geçersiz JSON yanıtı');
    if (j.error && !j.choices) { const er = new Error(redact(j.error.message || j.error.code || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
    let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
    if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
    if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.emptyResp = true; throw er; }
    p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
    return { text: String(c), model: (j.model || model) };
  } catch (e) { if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı'); er.status = 0; throw er; } throw e; }
  finally { clearTimeout(timer); }
}
async function callProvider(p, messages, opts) {
  const now = Date.now();
  const usable = (p.models || []).filter(m => !((p.modelCooldowns && p.modelCooldowns[m]) > now));
  if (!usable.length) { const er = new Error('tüm modeller soğumada'); er.status = 404; er.allModelsCooldown = true; throw er; }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const gap = (opts && opts.fast) ? 400 : AI_CFG.gapMs;
        const at = Math.max(Date.now(), p.nextAt || 0);
        p.nextAt = at + gap;
        if (at > Date.now()) await sleep(Math.min(at - Date.now(), 8000));
        return await callProviderModel(p, messages, model, opts);
      } catch (e) {
        lastErr = e;
        if (isModelError(e)) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + 10 * M1; log('AI MODEL YOK: ' + p.name + '/' + model); break; }
        if (e && e.emptyResp) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + 5 * M1; break; }
        if (isQuotaExhausted(e)) throw e;
        if (Number(e && e.status) === 429) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + clamp(e.retryAfterMs || 5 * M1, 30000, 6 * H1); break; }
        if (!isTransientAIError(e) || attempt === 1) throw e;
        await sleep(Math.min(4000, 500 * Math.pow(2, attempt) + Math.round(Math.random() * 250)));
      }
    }
  }
  throw lastErr || new Error('sağlayıcı yanıt vermedi');
}
async function callAI(messages, opts) {
  opts = opts || {};
  let lastErr = null;
  for (const p of orderedProviders(opts.prefer)) {
    if ((p.cooldownUntil || 0) > Date.now()) continue;
    if (!provOk(p)) continue;
    const q = aiQuota();
    if (!q.ok) throw new Error('AI kotası doldu');
    try {
      const t0 = Date.now();
      const r = await callProvider(p, messages, opts);
      const parsed = parseAIJSON(r.text);
      p.ok = (p.ok || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
      p.dayCount = (p.dayCount || 0) + 1;
      AI_USAGE.dayCount++; AI_USAGE.hourCount++; AI_USAGE.lastAt = Date.now(); AI_USAGE.lastError = null;
      AI_STATE.lastAt = Date.now(); AI_STATE.lastError = null;
      dirty = true;
      return Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai', text: String(r.text || '') });
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  throw lastErr || new Error('AI sağlayıcısı yok');
}

/* ── Prompt metinleri ── */
const AI_SYS = 'Sen AlphaSon adlı kripto sinyal kontrolcüsüsün. Sana bir strateji kontrol listesi ve mum verisi verilir. Maddeleri verideki mumlara bakarak tek tek true/false cevapla. R:R, risk yüzdesi, ATR aralığı, spread ve maliyet KOD TARAFINDAN DOĞRULANDI; bunları değerlendirme, yorumlama, gerekçe yapma. Veride olmayan sayı uydurma. Basit günlük Türkçe kullan. Yalnızca JSON döndür.';
const AI_SYS_WATCH = 'Sen AlphaSon adlı kripto sinyal süzgecisin. Sinyali önce matematik üretti. Sen yalnızca şu soruya cevap verirsin: "Girişe engel açık bir sorun var mı?" Kararın SADECE "GİRİLİR" veya "GİRİLMEZ" olur. Açık bir sorun yoksa GİRİLİR de. Çok basit günlük Türkçe kullan. Veride olmayan sayı uydurma. Yalnızca JSON döndür.';
const CODE_NOTE = 'NOT: R:R, risk yüzdesi, ATR aralığı, spread ve maliyet kodla doğrulandı. Bunları değerlendirme. Aşağıdaki maddeleri verideki mumlara bakarak cevapla.\n';
function planLine(sig) { return 'Plan: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | hedef1 ' + sig.tp1 + (sig.tp2 ? ' | hedef2 ' + sig.tp2 : '') + '\n'; }
function promptORB(sig, f) {
  const i = sig.info;
  return 'GÜNLÜK HIZLI SCALP — ORB — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
    'Açılış aralığı: alt ' + i.orLow + ' / üst ' + i.orHigh + '\n' +
    'Kod: aralık dışı ' + f.beyondAtr + ' ATR | kırılımdan ' + f.barsSinceBreak + ' mum | geri kapanış ' + (f.closeBackInside ? 'VAR' : 'yok') +
    ' | kırılım gövde/ATR ' + f.breakBodyAtr + ' | kırılım hacim/önceki3 ' + f.breakVolVsPrev3 + 'x | son hacim ' + f.volRatio + 'x | 15m trend ' + f.htf15 + ' | TP1 ' + f.tp1AtrDist + ' ATR | direnç ' + (f.nearestLevel || '-') + ' (' + (f.nearestLevelAtr != null ? f.nearestLevelAtr + ' ATR' : '-') + ')\n' +
    'Son mumlar:\n' + fmtCandles(f.cs, 40) + '\n\n' +
    'Maddeler:\n- close_outside_range: kırılım gövdeyle aralık dışında mı?\n- fakeout_return: kırılım sonrası aralığa geri döndü mü?\n- volume_surge: kırılım hacmi belirgin yüksek mi?\n- room_to_target: direnç TP1\'e yetecek kadar uzakta mı?\n- late: hareket uzadı mı?\n' +
    'JSON: {"close_outside_range":true,"fakeout_return":false,"volume_surge":true,"room_to_target":true,"late":false,"decision":"GIR|ZAYIF|GIRME","reason":"tek kısa cümle"}';
}
function promptVWAP(sig, f) {
  const i = sig.info;
  return 'GÜNLÜK HIZLI SCALP — VWAP pullback — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
    'VWAP ' + i.vwap + ' | EMA20 ' + i.ema20 + ' | EMA50 ' + i.ema50 + '\n' +
    'Kod: pb hacim ' + f.pbVolRatio + 'x | EMA20 uzak ' + f.distEma20Atr + ' ATR | tetik hacim/önceki ' + f.triggerVolVsPrev + 'x | önceki ucu aştı ' + (f.brokePrevExtreme ? 'evet' : 'hayır') + ' | 15m trend ' + f.htf15 + ' | TP1 ' + f.tp1AtrDist + ' ATR\n' +
    'Son mumlar:\n' + fmtCandles(f.cs, 40) + '\n\n' +
    'Maddeler:\n- pullback_low_volume: geri çekilme düşen hacimle mi?\n- held_support: EMA20/VWAP\'ta tutundu mu?\n- trigger_volume: dönüş mumu önceki ucu hacimle mi geçti?\n- htf_aligned: 15m trend uyumlu mu?\n- late: hareket uzadı mı?\n' +
    'JSON: {"pullback_low_volume":true,"held_support":true,"trigger_volume":true,"htf_aligned":true,"late":false,"decision":"GIR|ZAYIF|GIRME","reason":"tek kısa cümle"}';
}
function promptREV(sig, f) {
  const i = sig.info;
  return 'GÜNLÜK HIZLI SCALP — REV — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
    'VWAP ' + (f.vwap || i.vwap) + ' | RSI ' + i.rsi + ' | ADX ' + i.adx + '\n' +
    'Kod: son 20 mumda bant dokunma ' + f.bandTouches20 + ' (3+ = risk) | VWAP uzak ' + f.vwapDistAtr + ' ATR | 15m trend ' + f.htf15 + '\n' +
    'Son mumlar:\n' + fmtCandles(f.cs, 40) + '\n\n' +
    'Maddeler:\n- real_rejection: son mum bandın dışından içeri kapandı, hacim var mı?\n- trend_day: bugün güçlü tek yönlü trend günü mü?\n- room_to_vwap: VWAP TP1 için yeterli mi?\n' +
    'JSON: {"real_rejection":true,"trend_day":false,"room_to_vwap":true,"decision":"GIR|ZAYIF|GIRME","reason":"tek kısa cümle"}';
}
function promptLT(sig, f) {
  const i = sig.info;
  return 'LT ÜÇGEN — 2h kırılım — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
    'Üçgen: üst ' + (i.upperNow || i.upper) + ' | alt ' + (i.lowerNow || i.lower) + ' | genişlik %' + i.widthPct + ' | olgunluk ' + i.maturity + ' | sıkışma ' + i.compression + ' | dokunma ' + i.touches + '\n' +
    'Kod: son mum ' + (f.closeBeyond ? 'DIŞINDA' : 'içinde') + ' | çizgiden ' + f.beyondAtr + ' ATR | ters fitil ' + f.wickAgainst + ' | sıkışma hacim/önceki ' + f.squeezeVolRatio + 'x | kırılım hacim ' + f.breakVolRatio + 'x | 4s trend ' + f.htf4h + '\n' +
    'Son 40 mum (2h):\n' + fmtCandles(f.cs, 40) + '\n\n' +
    'Maddeler:\n- close_beyond_line: kırılım çizginin dışında kapandı mı?\n- volume_pattern: sıkışmada azaldı, kırılımda arttı mı?\n- htf_aligned: 4s trend uyumlu mu?\n- fakeout_signs: uzun ters fitil veya hemen geri dönüş var mı?\n' +
    'JSON: {"close_beyond_line":true,"volume_pattern":true,"htf_aligned":true,"fakeout_signs":false,"decision":"GIR|ZAYIF|GIRME","reason":"tek kısa cümle"}';
}
function promptAutoEntry(sig, ctx, f, cs) {
  return 'OTOTRADE GİRİŞ — ' + sig.base + ' ' + sig.dir + ' (pump/dump)\n' + CODE_NOTE + planLine(sig) +
    'Kod: başlangıçtan ' + f.atrProgress + ' ATR | son mum ' + (f.forming ? 'OLUŞUYOR (' + f.candleAgeSec + ' sn)' : 'kapandı') +
    ' | son 5 gövde/ATR: ' + f.bodyAtrSeq + ' | son 4 hacim: ' + f.volSeq + ' | hacim oranı ' + ctx.volRatio.toFixed(1) + 'x | 1m %' + ctx.chg1.toFixed(2) + ' 3m %' + ctx.chg3.toFixed(2) + ' | RSI ' + (ctx.rsi != null ? Math.round(ctx.rsi) : '?') + ' | VWAP ' + (ctx.vwap ? rp(ctx.vwap) : '?') + ' | 20 tepe ' + rp(ctx.hi20) + ' dip ' + rp(ctx.lo20) + '\n' +
    'Piyasa: ' + market.dir + '\n' +
    'Son 1m mumlar:\n' + fmtCandles(cs, 20) + '\n\n' +
    'Maddeler:\n- wave_stage: BASLANGIC / ORTA / GEC?\n- volume_fading: son 2 mumda hacim sönüyor mu?\n- reversal_candle: ters sert mum var mı?\n' +
    'Karar: GIR/BEKLE/GIRME. wave_stage GEC veya reversal_candle true ise GIR deme.\n' +
    'JSON: {"wave_stage":"BASLANGIC|ORTA|GEC","volume_fading":false,"reversal_candle":false,"decision":"GIR|BEKLE|GIRME","reason":"tek kısa cümle"}';
}

async function scalpFacts(sig) {
  const i = sig.info || {};
  const cs = await getCandles(sig.symbol, '5m', 80, false);
  const cs15 = await getCandles(sig.symbol, '15m', 60, true);
  if (!cs || cs.length < 40) return null;
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14) || 1e-9;
  const px = priceOf(sig.symbol) || last.c;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const v20 = avg(cs.slice(-21, -1).map(c => c.v));
  const f = { cs, px, atr, d, volRatio: +(last.v / (v20 || 1)).toFixed(2), volTrend3: cs.slice(-3).map(c => Math.round(c.v)).join(' → '), htf15: htfTrend(cs15), tp1AtrDist: +(Math.abs(sig.tp1 - px) / atr).toFixed(2) };
  const lv = srLevels(cs, atr, px).filter(l => d === 1 ? l.kind === 'R' : l.kind === 'S');
  f.nearestLevelAtr = lv.length ? +(Math.abs(lv[0].v - px) / atr).toFixed(2) : null;
  f.nearestLevel = lv.length ? lv[0].v : null;
  if (i.setup === 'ORB' && i.orHigh && i.orLow) {
    const edge = d === 1 ? i.orHigh : i.orLow;
    f.beyondAtr = +(((px - edge) * d) / atr).toFixed(2);
    let firstBreak = -1;
    for (let k = n - 1; k >= 0 && k > n - 25; k--) { const out = d === 1 ? cs[k].c > i.orHigh : cs[k].c < i.orLow; if (out) firstBreak = k; else if (firstBreak >= 0) break; }
    f.barsSinceBreak = firstBreak >= 0 ? n - 1 - firstBreak : null;
    f.closeBackInside = firstBreak >= 0 && cs.slice(firstBreak + 1).some(c => d === 1 ? c.c <= i.orHigh : c.c >= i.orLow);
    f.breakBodyAtr = firstBreak >= 0 ? +bodyAtr(cs[firstBreak], atr).toFixed(2) : null;
    f.breakVolVsPrev3 = firstBreak >= 3 ? +(cs[firstBreak].v / (avg(cs.slice(firstBreak - 3, firstBreak).map(c => c.v)) || 1)).toFixed(2) : null;
  }
  if (i.setup === 'VWAP') {
    const e20 = emaArr(closesOf(cs), 20);
    f.pbVolRatio = +(avg(cs.slice(-7, -1).map(c => c.v)) / (v20 || 1)).toFixed(2);
    f.distEma20Atr = +(((last.c - e20[n - 1]) * d) / atr).toFixed(2);
    f.triggerVolVsPrev = +(last.v / (cs[n - 2].v || 1)).toFixed(2);
    f.brokePrevExtreme = d === 1 ? last.c > cs[n - 2].h : last.c < cs[n - 2].l;
  }
  if (i.setup === 'REV') {
    const vw = vwapOf(cs, i.sessionStart || utcDayStart(Date.now()));
    if (vw.vwap && vw.sd > 0) {
      const up2 = vw.vwap + 2 * vw.sd, lo2 = vw.vwap - 2 * vw.sd;
      f.bandTouches20 = cs.slice(-20).filter(c => d === 1 ? c.l <= lo2 : c.h >= up2).length;
      f.vwapDistAtr = +(Math.abs(vw.vwap - px) / atr).toFixed(2);
      f.vwap = rp(vw.vwap);
    }
    f.adx = i.adx;
  }
  return f;
}
async function ltFacts(sig) {
  const i = sig.info || {};
  const cs = await getCandles(sig.symbol, '2h', 120, false);
  if (!cs || cs.length < 60) return null;
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14) || 1e-9;
  const px = priceOf(sig.symbol) || last.c;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const line = d === 1 ? (i.upperNow || i.upper) : (i.lowerNow || i.lower);
  const rng = last.h - last.l || 1e-9;
  const wickAgainst = d === 1 ? (last.h - Math.max(last.o, last.c)) / rng : (Math.min(last.o, last.c) - last.l) / rng;
  const early = avg(cs.slice(-40, -20).map(c => c.v)), late = avg(cs.slice(-20, -2).map(c => c.v));
  const v20 = avg(cs.slice(-21, -1).map(c => c.v));
  return { cs, px, atr, d, line,
    closeBeyond: d === 1 ? last.c > line : last.c < line,
    beyondAtr: +(((px - line) * d) / atr).toFixed(2),
    wickAgainst: +wickAgainst.toFixed(2),
    squeezeVolRatio: +(late / (early || 1)).toFixed(2),
    breakVolRatio: +(last.v / (v20 || 1)).toFixed(2),
    htf4h: htfTrend(aggTF(cs, 2, H2)) };
}
function autoFacts(sig, cs, ctx) {
  const d = sig.dir === 'LONG' ? 1 : -1;
  const recent = cs.slice(-11, -1).map(c => c.c);
  const start = d === 1 ? Math.min.apply(null, recent) : Math.max.apply(null, recent);
  const age = Math.round((Date.now() - ctx.last.t) / 1000);
  return { atrProgress: +(((ctx.px - start) * d) / ctx.atr).toFixed(2),
    forming: age < 60, candleAgeSec: Math.min(age, 60),
    bodyAtrSeq: cs.slice(-5).map(c => +bodyAtr(c, ctx.atr).toFixed(2)).join(', '),
    volSeq: cs.slice(-4).map(c => Math.round(c.v)).join(' → '), start: rp(start) };
}
async function buildSetupPrompt(sig) {
  if (sig.module === 'LT') {
    const f = await ltFacts(sig);
    return f ? { setup: 'LT', prompt: promptLT(sig, f), facts: f } : null;
  }
  const f = await scalpFacts(sig);
  if (!f) return null;
  const s = (sig.info && sig.info.setup) || 'VWAP';
  if (s === 'ORB') return { setup: 'ORB', prompt: promptORB(sig, f), facts: f };
  if (s === 'REV') return { setup: 'REV', prompt: promptREV(sig, f), facts: f };
  return { setup: 'VWAP', prompt: promptVWAP(sig, f), facts: f };
}

const RANK = { GIR: 0, ZAYIF: 1, BEKLE: 1, GIRME: 2 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);
function parseChecksJSON(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { decision: 'GIRME', checks: {}, reason: 'AI yanıtı okunamadı', parseError: true };
  const dec = normTR(j.decision || j.karar || '');
  const decision = ['GIR', 'ZAYIF', 'BEKLE', 'GIRME'].includes(dec) ? dec : 'GIRME';
  const checks = {};
  for (const k of Object.keys(j)) {
    if (k === 'decision' || k === 'karar' || k === 'reason' || k === 'neden') continue;
    checks[k] = typeof j[k] === 'string' && k === 'wave_stage' ? normTR(j[k]) : j[k];
  }
  return { decision, checks, reason: String(j.reason || j.neden || '').slice(0, 300), parseError: false };
}
function enforceChecks(setup, c, facts) {
  let r = 'GIR';
  const T = v => v === true, F = v => v === false;
  if (setup === 'ORB') {
    if (F(c.close_outside_range) || T(c.fakeout_return) || T(c.late) || F(c.room_to_target)) r = 'GIRME';
    else if (F(c.volume_surge)) r = 'ZAYIF';
  } else if (setup === 'VWAP') {
    if (F(c.held_support) || T(c.late)) r = 'GIRME';
    else if (F(c.htf_aligned) || F(c.pullback_low_volume) || F(c.trigger_volume)) r = 'ZAYIF';
  } else if (setup === 'REV') {
    const touches = facts && facts.bandTouches20 != null ? facts.bandTouches20 : 0;
    if (T(c.trend_day) || F(c.real_rejection)) r = 'GIRME';
    else if (touches >= 3 || F(c.room_to_vwap)) r = 'ZAYIF';
  } else if (setup === 'LT') {
    if (F(c.close_beyond_line) || T(c.fakeout_signs)) r = 'GIRME';
    else if (F(c.htf_aligned) || F(c.volume_pattern)) r = 'ZAYIF';
  } else if (setup === 'AUTO') {
    if (c.wave_stage === 'GEC' || T(c.reversal_candle)) r = 'GIRME';
    else if (T(c.volume_fading)) r = 'ZAYIF';
  }
  return r;
}
function legacyFields(dec) {
  return { verdict: dec === 'GIR' ? 'ONY' : 'RED', score: dec === 'GIR' ? 80 : dec === 'GIRME' ? 20 : 50, trust: dec === 'GIR' ? 'YÜKSEK' : 'ORTA' };
}

function addShadow(sig, decision, rec) {
  const maxMs = sig.module === 'LT' ? 18 * H1 : sig.module === 'AUTO' ? 20 * M1 : 60 * M1;
  SHADOW.push({ id: sig.id, symbol: sig.symbol, base: sig.base, module: sig.module, dir: sig.dir,
    entry: sig.entry, sl: sig.sl, tp1: sig.tp1, at: Date.now(), maxMs, decision, rec, done: false });
  capArr(SHADOW, 400);
}
function monitorShadow() {
  const now = Date.now();
  for (const s of SHADOW) {
    if (s.done) continue;
    const px = priceOf(s.symbol);
    if (!(px > 0)) continue;
    const d = s.dir === 'LONG' ? 1 : -1;
    let res = null, R = null;
    if ((px - s.sl) * d <= 0) { res = 'SL'; R = -1; }
    else if ((px - s.tp1) * d >= 0) { res = 'TP1'; R = rrNet(s.entry, s.sl, s.tp1).net; }
    else if (now - s.at > s.maxMs) {
      const risk = Math.abs(s.entry - s.sl);
      R = +(((px - s.entry) * d / risk) - EX.H / (risk / s.entry * 100)).toFixed(2);
      res = 'TIME';
    }
    if (!res) continue;
    s.done = true;
    if (s.rec) s.rec.shadowResult = { res, R, at: now };
    appendDecision({ type: 'shadow', sigId: s.id, module: s.module, base: s.base, dir: s.dir, decision: s.decision, res, R });
    dirty = true;
  }
}
function aiAccuracy() {
  const groups = {};
  for (const r of AI_HIST) {
    if (!r.shadowResult || !r.decisionV85) continue;
    const g = groups[r.decisionV85] = groups[r.decisionV85] || { n: 0, sumR: 0, tp1: 0, win: 0 };
    g.n++; g.sumR += r.shadowResult.R; if (r.shadowResult.res === 'TP1') g.tp1++; if (r.shadowResult.R > 0) g.win++;
  }
  const out = {};
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    out[k] = { n: g.n, avgR: +(g.sumR / g.n).toFixed(3), tp1Rate: +(g.tp1 / g.n * 100).toFixed(1), winRate: +(g.win / g.n * 100).toFixed(1) };
  }
  return { byDecision: out, note: 'GIR dediklerinin ortalama R değeri GIRME dediklerinden belirgin yüksek değilse AI değer katmıyor demektir. Örnek sayısı < 30 ise sonuç güvenilir değil.' };
}
const BAD_IF_TRUE = new Set(['fakeout_return', 'late', 'trend_day', 'fakeout_signs', 'volume_fading', 'reversal_candle']);
function countCheckStats(setup, checks, decision) {
  if (decision === 'GIR') return;
  for (const k of Object.keys(checks || {})) {
    const v = checks[k];
    if (typeof v !== 'boolean') continue;
    const bad = BAD_IF_TRUE.has(k) ? v === true : v === false;
    if (bad) CHECK_STAT[setup + '.' + k] = (CHECK_STAT[setup + '.' + k] || 0) + 1;
  }
}

function queueAI(sig, opts) {
  if (!sig || !AI_CFG.modules.includes(sig.module) || !aiReady()) return;
  if (AI_QUEUE.some(x => x.id === sig.id)) return;
  AI_QUEUE.push({ id: sig.id, force: !!(opts && opts.force), at: Date.now(), priority: sig.module === 'AUTO' ? 0 : 1 });
  AI_QUEUE.sort((a, b) => a.priority - b.priority || a.at - b.at);
  if (AI_QUEUE.length > 40) AI_QUEUE.splice(40);
  runAIQueue();
}
async function runAIQueue() {
  if (AI_STATE.busy) return;
  AI_STATE.busy = true;
  try {
    while (AI_QUEUE.length) {
      const job = AI_QUEUE.shift();
      const sig = signals.find(s => s.id === job.id);
      if (!sig) continue;
      try { await aiReview(sig, { force: job.force }); } catch (e) { log('AI KUYRUK: ' + redact(e.message)); }
    }
  } finally { AI_STATE.busy = false; }
}
function aiFallback(sig, state, note) {
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state, note, decidedAt: Date.now() });
  if (sig.module === 'PUMP' && sig.status === 'AI_BEKLIYOR') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; }
  dirty = true;
  return null;
}
async function aiReview(sig, opts) {
  opts = opts || {};
  if (!sig || !AI_CFG.modules.includes(sig.module)) return null;
  if (sig.status === 'KAPALI') return sig.ai || null;
  if (sig.module === 'AUTO') return autoEntryReview(sig);
  if (!aiReady()) return aiFallback(sig, 'MATH_ONLY', settings.aiEnabled === false ? 'AI kapalı — matematik kararı' : 'AI anahtarı yok — matematik kararı');
  const q = aiQuota();
  if (!q.ok) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'kota doldu', at: Date.now() }); return aiFallback(sig, 'OFFLINE', 'kota doldu'); }
  let built;
  try { built = await buildSetupPrompt(sig); } catch (e) { built = null; }
  if (!built) return aiFallback(sig, 'OFFLINE', 'veri alınamadı');
  let ai;
  try { ai = await callAI([{ role: 'system', content: AI_SYS }, { role: 'user', content: built.prompt }], { prefer: 'gemini', timeoutMs: AI_CFG.timeoutMs }); }
  catch (e) {
    sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI yanıt vermedi: ' + redact(e.message), at: Date.now() });
    AI_STATE.lastError = redact(e.message);
    log('AI YANIT YOK: ' + MODS[sig.module].label + ' ' + sig.base);
    return aiFallback(sig, 'OFFLINE', 'AI yanıtı yok');
  }
  const p = parseChecksJSON(ai.text);
  const forced = enforceChecks(built.setup, p.checks, built.facts);
  const decision = p.parseError ? 'GIRME' : worse(p.decision === 'BEKLE' ? 'ZAYIF' : p.decision, forced);
  const view = Object.assign({}, ai, legacyFields(decision), { decisionV85: decision, aiSaid: p.decision, forced, checks: p.checks, reason: p.reason, summary: p.reason, setupPrompt: built.setup });
  sig.ai = view;
  const rec = { at: ai.at, kind: 'Sinyal', module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir, setup: built.setup,
    provider: ai.providerName, model: ai.model, decision: decision === 'GIR' ? 'CANDIDATE' : 'REJECT', decisionV85: decision,
    phase: 'SİNYAL', score: view.score, dataQuality: 'TAM', disagree: p.decision !== decision,
    verdict: view.verdict, trust: view.trust, reason: p.reason, checks: p.checks, latencyMs: ai.latencyMs };
  AI_HIST.push(rec); capArr(AI_HIST, 600);
  countCheckStats(built.setup, p.checks, decision);
  addShadow(sig, decision, rec);
  appendDecision({ type: 'karar', sigId: sig.id, module: sig.module, base: sig.base, dir: sig.dir, setup: built.setup, conf: sig.conf, checks: p.checks, aiSaid: p.decision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });
  if (decision !== 'GIR') {
    const note = 'AI: ' + (decision === 'ZAYIF' ? 'ZAYIF' : 'GİRME') + (p.reason ? ' — ' + p.reason : '');
    sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'AI_RED', note, decidedAt: Date.now(), provider: ai.provider });
    skipSignal(sig, 'AI_RED', note);
    logRej(sig.module, sig.symbol, 'AI ' + decision + ' (' + built.setup + ')', sig.entry);
    return view;
  }
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'AI: GİR' + (p.reason ? ' — ' + p.reason : ''), decidedAt: Date.now(), provider: ai.provider });
  if (sig.module === 'PUMP') {
    if (sig.status === 'AI_BEKLIYOR' || sig.status === 'ONAY_BEKLIYOR') {
      if (canAutoOpen()) {
        const r = await openTrade(sig);
        if (r && r.error) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; sig.aiGate = Object.assign({}, sig.aiGate, { note: 'AI GİR ama açılamadı: ' + r.error }); }
      } else { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; }
    }
  } else if (sig.status !== 'KAPALI') sig.status = 'AKTIF';
  sig.analysis = analyzeSignal(sig);
  dirty = true;
  log('AI: ' + MODS[sig.module].label + ' ' + sig.base + ' (' + built.setup + ') → GİR');
  return view;
}
async function autoEntryReview(sig) {
  if (!sig || sig.status === 'KAPALI') return null;
  if (!aiReady()) { skipSignal(sig, 'AI_ERROR', 'AI kapalı'); return null; }
  if (settings.autoTrade !== true) { skipSignal(sig, 'SKIP', 'OtoTrade kapalı'); return null; }
  if (autoOpenCount() >= settings.autoMaxOpen) { skipSignal(sig, 'SKIP', 'maks dolu'); return null; }
  /* saatlik AUTO AI kotası */
  const hk = Math.floor(Date.now() / H1);
  if (AUTO_AI.hk !== hk) { AUTO_AI.hk = hk; AUTO_AI.count = 0; }
  if (AUTO_AI.count >= settings.autoAiPerHour) { skipSignal(sig, 'SKIP', 'saatlik AUTO AI limiti'); return null; }
  let ctx = null, cs = null;
  try { cs = await getCandles(sig.symbol, '1m', 60, false); ctx = autoContext(sig.symbol, cs, { price: priceOf(sig.symbol) || sig.entry }); }
  catch (e) { /* sessiz */ }
  if (!ctx) { skipSignal(sig, 'AI_ERROR', 'veri yok'); return null; }
  const f = autoFacts(sig, cs, ctx);
  if (f.atrProgress > 2.5) { skipSignal(sig, 'SKIP', 'hareket uzamış (' + f.atrProgress + ' ATR)'); return null; }
  AUTO_AI.count++;
  let ai;
  try { ai = await callAI([{ role: 'system', content: AI_SYS }, { role: 'user', content: promptAutoEntry(sig, ctx, f, cs) }], { prefer: 'gemini', timeoutMs: 15000, fast: true }); }
  catch (e) { skipSignal(sig, 'AI_ERROR', 'AI yanıt yok'); log('OTOTRADE AI: ' + sig.base + ' → ' + redact(e.message)); return null; }
  const p = parseChecksJSON(ai.text);
  const forced = enforceChecks('AUTO', p.checks, f);
  const decision = p.parseError ? 'GIRME' : worse(p.decision, forced);
  const aiView = Object.assign({}, ai, legacyFields(decision === 'GIR' ? 'GIR' : 'GIRME'), { decisionV85: decision, aiSaid: p.decision, forced, checks: Object.assign({ atr_progress: f.atrProgress }, p.checks), reason: p.reason, summary: p.reason });
  sig.ai = aiView;
  const rec = { at: Date.now(), kind: 'OtoTrade Giriş', module: 'AUTO', symbol: sig.symbol, base: sig.base, dir: sig.dir, setup: 'AUTO',
    provider: ai.providerName, model: ai.model, decision: decision === 'GIR' ? 'CANDIDATE' : 'REJECT', decisionV85: decision,
    phase: 'GİRİŞ', score: aiView.score, dataQuality: 'TAM', disagree: p.decision !== decision, verdict: aiView.verdict, trust: aiView.trust, reason: p.reason, checks: aiView.checks, latencyMs: ai.latencyMs };
  AI_HIST.push(rec); capArr(AI_HIST, 600);
  countCheckStats('AUTO', p.checks, decision);
  addShadow(sig, decision, rec);
  appendDecision({ type: 'karar', sigId: sig.id, module: 'AUTO', base: sig.base, dir: sig.dir, setup: sig.info && sig.info.setup, conf: sig.conf, checks: aiView.checks, aiSaid: p.decision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });
  if (decision !== 'GIR') {
    skipSignal(sig, 'SKIP', 'AI ' + decision + (p.reason ? ': ' + p.reason : ''));
    log('OTOTRADE AI ' + decision + ': ' + sig.base + ' ' + sig.dir);
    return aiView;
  }
  const px = rp(ctx.px);
  const d = sig.dir === 'LONG' ? 1 : -1;
  let sl = sig.sl;
  let riskPct = Math.abs(px - sl) / px * 100;
  if (!(riskPct >= 0.70 && riskPct <= 2.50)) { skipSignal(sig, 'SKIP', 'stop geçersiz'); return aiView; }
  const risk = Math.abs(px - sl);
  const tp1 = px + d * Math.max(risk * 1.50, px * 0.008);
  const tp2 = px + d * Math.max(risk * 2.50, px * 0.014);
  const q1 = rrNet(px, sl, tp1), q2 = rrNet(px, sl, tp2);
  if (q1.net < 0.90 || q2.net < 1.50) { skipSignal(sig, 'SKIP', 'net R:R yetersiz'); return aiView; }
  sig.entry = px; sig.sl = rp(sl); sig.curSl = rp(sl); sig.tp1 = rp(tp1); sig.tp2 = rp(tp2);
  sig.info = Object.assign({}, sig.info, { plan: { entry: px, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) }, aiEntry: true, aiReason: p.reason, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2), atrProgress: f.atrProgress, forming: f.forming, candleAgeSec: f.candleAgeSec });
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'AI GİR: ' + p.reason, decidedAt: Date.now(), provider: ai.provider });
  sig.status = 'AKTIF'; sig.startedAt = Date.now(); dirty = true;
  const r = await openTrade(sig);
  if (!r || r.error) { sig.status = 'AI_BEKLIYOR'; skipSignal(sig, 'SKIP', 'açılamadı: ' + ((r && r.error) || 'bilinmeyen')); return aiView; }
  sig.status = 'AKTIF';
  log('OTOTRADE GİRİŞ: ' + sig.base + ' ' + sig.dir + ' | ' + f.atrProgress + ' ATR | ' + px + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | ' + (settings.tradeMode === 'live' ? 'CANLI' : 'PAPER'));
  return aiView;
}
async function autoManageReview(pos) {
  if (!pos || !aiReady()) return null;
  if (pos.closing) return null;
  const sig = signals.find(s => s.id === pos.sigId);
  const cs = await getCandles(pos.symbol, '1m', 40, false);
  if (!cs || cs.length < 20) return null;
  const ctx = autoContext(pos.symbol, cs, { price: pos.livePrice || priceOf(pos.symbol) || pos.entry });
  if (!ctx) return null;
  const d = pos.dir === 'LONG' ? 1 : -1;
  const px = ctx.px;
  const risk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
  const rNow = (px - pos.entry) * d / risk;
  const lines = cs.slice(-12).map(c => new Date(c.t).toISOString().slice(11, 16) + ' C' + c.c.toFixed(c.c >= 1 ? 4 : 6) + ' V' + Math.round(c.v)).join('\n');
  const prompt = 'OTOTRADE ÇIKIŞ — ' + pos.base + ' ' + pos.dir + ' (' + (pos.isLive ? 'CANLI' : 'PAPER') + ')\n' +
    'Giriş ' + pos.entry + ' | Şu an ' + rp(px) + ' | K/Z ' + rNow.toFixed(2) + 'R | Süre ' + Math.round((Date.now() - pos.openedAt) / 60000) + ' dk\n' +
    'SL ' + pos.curSl + ' | TP1 ' + pos.tp1 + ' | TP2 ' + (pos.tp2 || '-') + ' | TP1: ' + (pos.tp1Hit ? 'EVET' : 'HAYIR') + '\n' +
    '1m %' + ctx.chg1.toFixed(2) + ' | 3m %' + ctx.chg3.toFixed(2) + ' | Hacim ' + ctx.volRatio.toFixed(1) + 'x | RSI ' + (ctx.rsi != null ? Math.round(ctx.rsi) : '?') + '\n' +
    'Son 1m mumlar:\n' + lines + '\n\n' +
    'Karar: TUT / YARISINI_AL / KAPAT.\n' +
    'JSON: {"action":"TUT|YARISINI_AL|KAPAT","reason":"tek kısa cümle"}';
  let ai;
  try { ai = await callAI([{ role: 'system', content: 'Sen hızlı scalper çıkış yöneticisisin. Kısa Türkçe. Sadece JSON.' }, { role: 'user', content: prompt }], { prefer: 'gemini', timeoutMs: 12000 }); }
  catch (e) { pos.aiExitAt = Date.now(); return null; }
  const dec = (function (text) {
    let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    let j = null; if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
    if (!j || typeof j !== 'object') return { action: 'HOLD', reason: 'AI okunamadı', parseError: true };
    const act = normTR(j.action || j.karar || j.verdict || '');
    let action = 'HOLD';
    if (/KAPAT|CLOSE|EXIT|CIK|SAT|RED/.test(act)) action = 'CLOSE';
    else if (/YARI|PARTIAL|HALF|50/.test(act)) action = 'PARTIAL';
    return { action, reason: String(j.reason || j.neden || j.summary || '').slice(0, 300), parseError: false };
  })(ai.text);
  pos.aiExitAt = Date.now(); pos.aiExit = dec.action; pos.aiExitReason = dec.reason;
  if (sig) { sig.aiExit = dec.action; sig.aiExitReason = dec.reason; }
  AI_HIST.push({ at: Date.now(), kind: 'OtoTrade Çıkış', module: 'AUTO', symbol: pos.symbol, base: pos.base, dir: pos.dir, provider: ai.providerName, model: ai.model, decision: dec.action === 'CLOSE' ? 'REJECT' : 'CANDIDATE', phase: 'ÇIKIŞ', score: null, dataQuality: 'TAM', disagree: false, verdict: dec.action === 'CLOSE' ? 'RED' : 'ONY', trust: 'ORTA', reason: dec.reason, latencyMs: ai.latencyMs });
  capArr(AI_HIST, 600);
  if (dec.action === 'CLOSE') {
    const r = pos.isLive ? await liveClose(pos, px, 'AI_EXIT') : (closePaper(pos, px, 'AI_EXIT'), { ok: true });
    log('OTOTRADE AI ÇIKIŞ: ' + pos.base + ' → ' + (r && r.error ? r.error : 'kapatıldı'));
  } else if (dec.action === 'PARTIAL' && !pos.tp1Hit) {
    const q = +(pos.initialQty * 0.5).toFixed(8);
    if (pos.isLive) { const r = await liveClose(pos, px, 'TP1', q); if (r && !r.error) { pos.tp1Hit = true; pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100); if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; } } }
    else { closePortion(pos, q, px); pos.tp1Hit = true; pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100); if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; } }
    dirty = true;
    log('OTOTRADE AI YARIM: ' + pos.base + ' %50 alındı');
  }
  return dec;
}
let autoManaging = false;
async function maybeAutoAI() {
  if (!aiReady() || settings.autoTrade !== true || autoManaging) return;
  autoManaging = true;
  try {
    const all = paper.open.filter(p => p.module === 'AUTO').concat(LIVE.open.filter(p => p.module === 'AUTO'));
    for (const pos of all) {
      if (pos.closing) continue;
      if (Date.now() - pos.openedAt < 10e3) continue;
      if (Date.now() - (pos.aiExitAt || 0) < 20e3) continue;
      await autoManageReview(pos);
      break;
    }
  } finally { autoManaging = false; }
}
function aiWatchPrompt(kind, row) {
  if (kind === 'lt') {
    return 'LT izleme: ' + row.base + ' | fiyat ' + row.price + ' | üst ' + row.upper + ' | alt ' + row.lower + ' | üst mesafe %' + row.distUpperPct + ' | alt mesafe %' + row.distLowerPct + ' | genişlik %' + row.widthPct + ' | olgunluk ' + row.maturity + ' | sıkışma ' + row.compression + ' | durum ' + row.status + '\nKırılıma yaklaşıyor mu? JSON: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"reason":"tek cümle"}';
  }
  return 'Scalp izleme: ' + row.base + ' | kurulum ' + row.setup + ' | yön ' + row.dir + ' | fiyat ' + row.price + ' | hacim ' + row.volRatio + 'x | RSI ' + row.rsi + ' | ADX ' + row.adx + ' | durum ' + row.status + '\nGirişe uygun mu? JSON: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"reason":"tek cümle"}';
}
async function watchAI(kind, base, opts) {
  if (!aiReady()) return { error: 'AI kapalı' };
  const rows = kind === 'lt' ? WATCH.lt : SCALP_WATCH;
  const row = rows.find(r => String(r.base).toUpperCase() === String(base).toUpperCase());
  if (!row) return { error: 'coin listede yok' };
  if (row.ai && row.ai.at && Date.now() - row.ai.at < 30 * M1 && !(opts && opts.force)) return { ok: true, ai: row.ai, cached: true };
  try {
    const ai = await callAI([{ role: 'system', content: AI_SYS_WATCH }, { role: 'user', content: aiWatchPrompt(kind, row) }], { timeoutMs: AI_CFG.timeoutMs });
    const view = { verdict: ai.verdict, label: ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ', verdictLabel: ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ',
      score: ai.score, trust: ai.trust, reason: ai.reason || ai.summary, summary: ai.summary, risks: ai.risks,
      provider: ai.providerName, model: ai.model, at: ai.at,
      ev: { decision: ai.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: 'WATCH', score: ai.score, confidence: ai.trust === 'YÜKSEK' ? 'HIGH' : ai.trust === 'DÜŞÜK' ? 'LOW' : 'MEDIUM', summary: ai.summary || ai.reason || '', dataQuality: 'GOOD' } };
    row.ai = view;
    if (kind === 'lt') { const e = LT_CACHE.get(row.symbol); if (e) e.ai = view; }
    AI_HIST.push({ at: ai.at, kind: kind === 'lt' ? 'LT İzleme' : 'Scalp İzleme', module: kind === 'lt' ? 'LT' : 'PUMP', symbol: row.symbol, base: row.base, dir: row.dir || row.dirHint, provider: ai.providerName, model: ai.model, decision: ai.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: row.status || 'İZLEME', score: ai.score, dataQuality: 'TAM', disagree: false, verdict: ai.verdict, trust: ai.trust, reason: ai.reason || ai.summary, latencyMs: ai.latencyMs });
    capArr(AI_HIST, 600);
    dirty = true;
    log('İZLEME AI: ' + (kind === 'lt' ? 'LT' : 'SCALP') + ' ' + row.base + ' → ' + view.label);
    return { ok: true, ai: view };
  } catch (e) { log('İZLEME AI: ' + row.base + ' → ' + redact(e.message)); return { error: redact(e.message) }; }
}
async function maybeWatchAI() {
  if (!aiReady() || settings.aiWatchAuto !== true) return;
  if (AI_STATE.busy) return;
  const lt = WATCH.lt.find(r => !r.ai);
  if (lt) await watchAI('lt', lt.base);
  const sc = SCALP_WATCH.find(r => !r.ai);
  if (sc) await watchAI('scalp', sc.base);
}
async function aiMarketBrief(force) {
  if (!aiReady()) return { error: 'AI kapalı' };
  const q = aiQuota();
  if (!q.ok) return { error: 'kota doldu' };
  if (AI_USAGE.briefCount >= AI_CFG.briefPerDay && !force) return marketBrief || { error: 'brifing limiti' };
  let ctx = '';
  try {
    const btc1 = await getCandles('BTC/USDT:USDT', '1h', 48, true);
    const eth1 = await getCandles('ETH/USDT:USDT', '1h', 48, true);
    const fmt = cs => (cs || []).slice(-12).map(c => new Date(c.t).toISOString().slice(11, 16) + ' C' + c.c).join('\n');
    const movers = UNIVERSE.slice(0, 40).map(s => ({ base: baseOf(s), chg: tick(s) ? tick(s).chg : null })).filter(x => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8);
    ctx = JSON.stringify({ market, btc1h: fmt(btc1), eth1h: fmt(eth1), movers }, null, 1);
  } catch (e) { return { error: 'veri: ' + redact(e.message) }; }
  try {
    const ai = await callAI([{ role: 'system', content: AI_SYS_WATCH }, { role: 'user', content: ctx + '\n\nKısa brifing. JSON: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"summary":"2 cümle","risks":["risk"]}' }], { timeoutMs: AI_CFG.timeoutMs });
    AI_USAGE.briefCount++; marketBrief = ai; dirty = true;
    log('AI BRİFİNG: ' + (ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ') + ' ' + ai.score);
    return ai;
  } catch (e) { return { error: redact(e.message) }; }
}
async function maybeMarketBrief() {
  if (!aiReady() || AI_CFG.briefPerDay <= 0) return;
  const q = aiQuota(); if (!q.ok) return;
  if (AI_USAGE.briefDay !== q.day) { AI_USAGE.briefDay = q.day; AI_USAGE.briefCount = 0; }
  if (AI_USAGE.briefCount >= AI_CFG.briefPerDay) return;
  if (marketBrief && marketBrief.at && Date.now() - marketBrief.at < 3 * H1) return;
  await aiMarketBrief(false);
}
function parseMarketAIJSON(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  if (!j || typeof j !== 'object') return { dir: 'NOTR', score: 50, reason: 'AI okunamadı', parseError: true };
  const dr = normTR(j.dir || j.direction || j.yon || j.trend || j.market || '');
  let dir = 'NOTR';
  if (/SHORT|DUS|SAT|BEAR|DOWN|ASAGI/.test(dr)) dir = 'SHORT';
  else if (/LONG|YUKSEL|AL|BULL|UP|YUKARI/.test(dr)) dir = 'LONG';
  let score = Number(j.score != null ? j.score : j.confidence != null ? j.confidence : j.puan);
  if (!Number.isFinite(score)) score = dir === 'NOTR' ? 50 : 65;
  return { dir, score: clamp(Math.round(score), 0, 100), reason: String(j.reason || j.neden || j.summary || '').slice(0, 300), parseError: false };
}
async function updateMarketAI(force) {
  if (!aiReady()) return marketAI;
  if (!force && marketAI.at && Date.now() - marketAI.at < AI_CFG.marketEveryMs) return marketAI;
  const q = aiQuota();
  if (!q.ok) return marketAI;
  let btc, eth;
  try { btc = await getCandles('BTC/USDT:USDT', '15m', 60, true); eth = await getCandles('ETH/USDT:USDT', '15m', 60, true); } catch (e) { return marketAI; }
  if (!btc || btc.length < 20) return marketAI;
  const fmt = (cs, n) => (cs || []).slice(-n).map(c => { const t = new Date(c.t).toISOString().slice(11, 16); const p = c.c >= 1 ? 4 : 6; return t + ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v); }).join('\n');
  const cl = closesOf(btc);
  const e20 = emaLast(cl, 20), e50 = emaLast(cl, 50);
  const rsi = rsiLast(cl, 14), atr = atrLast(btc, 14);
  const last = btc[btc.length - 1];
  const chg15 = btc.length > 1 ? (last.c / btc[btc.length - 2].c - 1) * 100 : 0;
  const chg1h = btc.length > 4 ? (last.c / btc[btc.length - 5].c - 1) * 100 : 0;
  const chg4h = btc.length > 16 ? (last.c / btc[btc.length - 17].c - 1) * 100 : 0;
  const movers = UNIVERSE.slice(0, 40).map(s => ({ b: baseOf(s), c: tick(s) ? tick(s).chg : null })).filter(x => x.c != null).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10);
  const prompt = 'PİYASA YÖNÜ — 15m\nBTC: ' + rp(last.c) + ' | 15m %' + chg15.toFixed(2) + ' | 1s %' + chg1h.toFixed(2) + ' | 4s %' + chg4h.toFixed(2) + ' | EMA20 ' + rp(e20) + ' | EMA50 ' + rp(e50) + ' | RSI ' + (rsi != null ? Math.round(rsi) : '?') + ' | ATR ' + rp(atr) + '\n' + fmt(btc, 16) + '\n' + (eth && eth.length ? 'ETH: ' + eth.slice(-10).map(c => rp(c.c)).join(' → ') + '\n' : '') + 'Genişlik: %' + Math.round((market.breadth || 0.5) * 100) + ' yeşil\nHareketli: ' + movers.map(x => x.b + ' %' + Number(x.c).toFixed(1)).join(', ') + '\n\nYön: LONG/SHORT/NOTR. JSON: {"dir":"LONG|SHORT|NOTR","score":0,"reason":"tek cümle"}';
  try {
    const ai = await callAI([{ role: 'system', content: 'Kripto piyasa analistisin. 15m veriye göre yön belirle. Kısa Türkçe JSON.' }, { role: 'user', content: prompt }], { prefer: 'gemini', timeoutMs: 20000 });
    const dec = parseMarketAIJSON(ai.text || JSON.stringify(ai));
    const prevHist = (marketAI.hist || []);
    marketAI = { dir: dec.dir, score: dec.score, reason: dec.reason, at: Date.now(), provider: ai.providerName || ai.provider || null, model: ai.model || null,
      hist: prevHist.concat(dec.dir + '|' + dec.score).slice(-3) };
    dirty = true;
    try { await updateMarket(); } catch (e) { /* sessiz */ }
    log('PİYASA YÖNÜ (AI): ' + marketAI.dir + ' | ' + marketAI.score + ' | ' + marketAI.reason);
    if (marketAI.hist.length === 3 && new Set(marketAI.hist).size === 1)
      logOnce('mktai-same', 'UYARI: AI piyasa yönü son 3 çağrıda aynı (' + marketAI.hist[0] + ')', 30 * M1);
    return marketAI;
  } catch (e) { AI_STATE.lastError = redact(e.message); log('PİYASA YÖNÜ AI HATASI: ' + redact(e.message)); return marketAI; }
}
function closeVirtual(sig, exitPx, result) {
  const d = sig.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0)) return;
  const riskPct = risk / sig.entry * 100;
  let grossR;
  if (sig.tp1Hit) grossR = 0.5 * Math.abs(sig.tp1 - sig.entry) / risk + 0.5 * ((exitPx - sig.entry) * d / risk);
  else grossR = (exitPx - sig.entry) * d / risk;
  const netR = +(grossR - EX.H / riskPct).toFixed(3);
  sig.status = 'KAPALI'; sig.result = result; sig.exit = rp(exitPx); sig.closedAt = Date.now();
  sig.grossR = +grossR.toFixed(3); sig.netR = netR; sig.pnlUsdt = null;
  sig.analysis = analyzeSignal(sig);
  OUT.push({ t: Date.now(), module: sig.module, base: sig.base, dir: sig.dir, result, netR, pnl: null, setup: 'LT', conf: sig.conf, createdAt: sig.createdAt });
  capArr(OUT, 300); dirty = true;
  log('LT SANAL KAPANDI: ' + sig.base + ' ' + sig.dir + ' → ' + (RES[result] || result) + ' | net ' + netR + 'R');
}
function monitorVirtual() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'KAPALI' || sig.tradeable !== false) continue;
    const px = priceOf(sig.symbol);
    if (!(px > 0)) continue;
    const d = sig.dir === 'LONG' ? 1 : -1;
    if (now - sig.createdAt > (sig.maxAgeMs || MODS.LT.maxAge)) { closeVirtual(sig, px, 'TIME'); continue; }
    if (sig.tp2 && (d === 1 ? px >= sig.tp2 : px <= sig.tp2)) { closeVirtual(sig, sig.tp2, 'TP2'); continue; }
    if (d === 1 ? px <= sig.curSl : px >= sig.curSl) { closeVirtual(sig, sig.curSl, sig.tp1Hit ? 'BE' : 'SL'); continue; }
    if (!sig.tp1Hit && (d === 1 ? px >= sig.tp1 : px <= sig.tp1)) { sig.tp1Hit = true; sig.curSl = rp(sig.entry + d * sig.entry * EX.H / 100); dirty = true; log('LT TP1 (sanal): ' + sig.base); }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP API
   ══════════════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const h = fn => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch(e => {
    log('API HATASI: ' + req.method + ' ' + req.path + ' → ' + redact(e.message));
    if (!res.headersSent) res.status(500).json({ error: redact(e.message) });
  });
};
function tvUrl(sym) { return 'https://www.tradingview.com/chart/?symbol=BITGET:' + encodeURIComponent(baseOf(sym)) + 'USDT.P'; }
function chartPayload(sym, tf, cs, sig, extra) {
  const cl = closesOf(cs);
  const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  const out = { symbol: sym, base: baseOf(sym), tf,
    candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]),
    ema20: e20.map(v => v == null ? null : rp(v)),
    ema50: e50.map(v => v == null ? null : rp(v)),
    tradingview: tvUrl(sym),
    signal: sig ? viewSignal(sig) : { base: baseOf(sym), dir: (extra && extra.dir) || null, entry: num(extra && extra.entry), sl: num(extra && extra.sl), tp1: num(extra && extra.tp1), tp2: num(extra && extra.tp2) },
    levels: [], triangle: null, supportResistance: [] };
  if (sig && sig.module === 'LT') {
    let tri = analyzeTriangle(cs, tf);
    let tc = null;
    if (tri) tc = triangleChart(tri, cs, tf);
    else { const cached = LT_CACHE.get(sym); if (cached && cached.tri) { tri = cached.tri; tc = triangleChart(cached.tri, cached.cs, cached.tri.tf); } }
    if (tc) { out.triangle = tc; out.levels = [{ v: tc.upperNow, col: '#f6465d', l: 'ÜST ÇİZGİ' }, { v: tc.lowerNow, col: '#0ecb81', l: 'ALT ÇİZGİ' }]; out.supportResistance = srLevels(cs, tri ? tri.atr : 0, priceOf(sym) || cl[cl.length - 1]); }
  } else if (extra && (Number(extra.upper) > 0 || Number(extra.lower) > 0)) {
    let tc = null, tri = null;
    if (tf === '2h' || tf === '4h') { tri = analyzeTriangle(cs, tf); if (tri) tc = triangleChart(tri, cs, tf); }
    if (tc) { out.triangle = tc; out.levels = [{ v: tc.upperNow, col: '#f6465d', l: 'ÜST ÇİZGİ' }, { v: tc.lowerNow, col: '#0ecb81', l: 'ALT ÇİZGİ' }]; out.supportResistance = srLevels(cs, tri ? tri.atr : 0, priceOf(sym) || cl[cl.length - 1]); }
    else { if (Number(extra.upper) > 0) out.levels.push({ v: Number(extra.upper), col: '#f6465d', l: 'ÜST' }); if (Number(extra.lower) > 0) out.levels.push({ v: Number(extra.lower), col: '#0ecb81', l: 'ALT' }); }
  }
  return out;
}

app.get('/', (req, res) => { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) res.sendFile(p); else res.type('text/plain').send('AlphaSon ' + VERSION + ' çalışıyor.'); });
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, ready: READY, live: HAS_KEYS && settings.tradeMode === 'live', ai: aiReady(), market: marketAI.dir, modules: ACTIVE_MODULES }));

app.get('/api/state', h((req, res) => {
  const active = signals.filter(isOpenSignal);
  const byModule = {};
  for (const m of ACTIVE_MODULES) byModule[m] = active.filter(s => s.module === m).length;
  const modules = {};
  for (const m of ACTIVE_MODULES) modules[m] = { enabled: MODS[m].enabled, label: MODS[m].label, tf: MODS[m].tf, tradeable: MODS[m].tradeable };
  res.json({ version: VERSION, at: Date.now(), ready: READY, settings, activeModules: ACTIVE_MODULES, modules, market, marketAI,
    paper: paperSummary(),
    live: { keys: HAS_KEYS, mode: settings.tradeMode, balance: liveBalanceView(), summary: liveSummary(), open: LIVE.open.map(viewLivePos), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null, needsSync: LIVE.needsSync === true, ipHint: LIVE.ipHint || null },
    counts: { active: active.length, byModule, pendingApproval: active.filter(s => s.status === 'ONAY_BEKLIYOR').length, aiPending: active.filter(s => s.status === 'AI_BEKLIYOR').length, openPump: paper.open.length + LIVE.open.length, paperOpen: paper.open.length, liveOpen: LIVE.open.length, autoOpen: autoOpenCount(), autoMaxOpen: settings.autoMaxOpen, totalSignals: signals.length, closed: signals.filter(s => s.status === 'KAPALI').length },
    scan: { universe: UNIVERSE.length, autoAt: lastScan.auto || 0, scalpAt: lastScan.scalp || 0, ltAt: lastScan.lt || 0, tickAt: lastScan.tick || 0, autoWatch: AUTO_WATCH.length, ltWatch: WATCH.lt.length, scalpWatch: SCALP_WATCH.length },
    ai: aiStatus(), costPct: EX.H, liveEnabled: HAS_KEYS && settings.tradeMode === 'live', includeStocks: settings.includeStocks });
}));

app.get('/api/signals', h((req, res) => {
  const mod = String(req.query.module || '').toUpperCase();
  let list = signals.slice();
  if (mod) { if (!MODS[mod]) return res.json({ module: mod, active: [], closed: [], removed: true }); list = list.filter(s => s.module === mod); }
  const active = list.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt).map(viewSignal);
  const closed = list.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 100).map(viewSignal);
  res.json({ module: mod || null, active, closed, all: active.concat(closed) });
}));

app.get('/api/paper', h((req, res) => res.json({ settings: paperSettingsView(), summary: paperSummary(), open: paper.open.map(viewPaper), closed: paper.closed.slice(-50).reverse(),
  live: { keys: HAS_KEYS, mode: settings.tradeMode, balance: liveBalanceView(), summary: liveSummary(), open: LIVE.open.map(viewLivePos), closed: LIVE.closed.slice(-50).reverse(), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null, ipHint: LIVE.ipHint || null },
  limits: { maxOpen: settings.maxOpen, autoMaxOpen: settings.autoMaxOpen, dailyLossPct: settings.dailyLossPct, costPct: EX.H, live: HAS_KEYS && settings.tradeMode === 'live' } })));

app.post('/api/paper/settings', h((req, res) => {
  const body = Object.assign({}, req.body || {});
  if (body.tradeMode === 'live' && !HAS_KEYS) return res.status(400).json({ error: 'Bitget anahtarı gerekli' });
  settings = sanitizeSettings(Object.assign({}, settings, body));
  if (settings.tradeMode === 'live' && !HAS_KEYS) settings.tradeMode = 'paper';
  dirty = true; saveState(true);
  res.json({ ok: true, settings });
}));

app.get('/api/watch', h((req, res) => res.json({
  auto: AUTO_WATCH, lt: WATCH.lt, scalp: SCALP_WATCH,
  meta: { auto: WATCH_META.auto, lt: WATCH_META.lt, scalp: WATCH_META.scalp },
  lastScan: lastScan
})));

app.get('/api/lt', h((req, res) => res.json({ watch: WATCH.lt, meta: WATCH_META.lt, universe: UNIVERSE.slice(0, 40), cached: Array.from(LT_CACHE.keys()).length })));

app.get('/api/chart', h(async (req, res) => {
  const sym = String(req.query.symbol || 'BTC/USDT:USDT').toUpperCase();
  const tf = TF_MS[req.query.tf] ? String(req.query.tf) : '5m';
  const limit = clamp(Math.round(num(req.query.limit, 180)), 60, 1200);
  const cs = await getCandles(sym, tf, limit, false);
  if (!cs || !cs.length) return res.status(404).json({ error: 'veri yok' });
  const sigId = String(req.query.sigId || '');
  const sig = sigId ? signals.find(s => s.id === sigId) : null;
  const extra = { upper: req.query.upper, lower: req.query.lower, dir: req.query.dir, entry: req.query.entry, sl: req.query.sl, tp1: req.query.tp1, tp2: req.query.tp2 };
  res.json(chartPayload(sym, tf, cs, sig, extra));
}));

app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), outcome: OUT.slice(-100).reverse(), rejections: REJ.slice(-50).reverse(), rejStat: REJ_STAT,
  ai: { accuracy: aiAccuracy(), checkStats: CHECK_STAT, hist: AI_HIST.slice(-100).reverse() } })));

app.post('/api/backtest', h((req, res) => { const id = btStart(req.body || {}); res.json({ ok: true, id }); }));
app.get('/api/backtest/:id', h((req, res) => { const j = BT_JOBS.get(req.params.id); if (!j) return res.status(404).json({ error: 'yok' }); res.json(j); }));

app.post('/api/signal/:id/approve', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  const r = await approveSignal(sig);
  res.json(r && r.error ? { ok: false, error: r.error } : { ok: true, pos: r.pos });
}));
app.post('/api/signal/:id/skip', h((req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  skipSignal(sig, 'MANUEL', String(req.body && req.body.note || 'kullanıcı atladı'));
  res.json({ ok: true });
}));
app.post('/api/signal/:id/ai', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  const v = await aiReview(sig, { force: true });
  res.json({ ok: true, ai: v });
}));

app.get('/api/live/balance', h(async (req, res) => { const b = await fetchLiveBalance(true); res.json(b); }));
app.get('/api/live/positions', h(async (req, res) => { const p = await fetchLivePositions(); res.json({ positions: p || [], sync: LIVE.lastSync || 0, ipHint: LIVE.ipHint || null }); }));
app.post('/api/live/sync', h(async (req, res) => { await syncLive(); await fetchLiveBalance(true); res.json({ ok: true, balance: liveBalanceView(), open: LIVE.open.map(viewLivePos), lastSync: LIVE.lastSync }); }));
app.post('/api/live/close/:id', h(async (req, res) => {
  const pos = LIVE.open.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'pozisyon yok' });
  const px = await fastLivePrice(pos.symbol, pos.livePrice || pos.entry);
  const r = await liveClose(pos, px, 'MANUEL');
  res.json(r && r.error ? { ok: false, error: r.error } : { ok: true });
}));
app.post('/api/live/close-paper/:id', h(async (req, res) => {
  const pos = paper.open.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'pozisyon yok' });
  const px = priceOf(pos.symbol) || pos.entry;
  closePaper(pos, px, 'MANUEL');
  res.json({ ok: true });
}));

app.get('/api/ai/status', h((req, res) => res.json(aiStatus())));
app.post('/api/ai/discover', h(async (req, res) => { const r = await discoverAll(req.body || {}); res.json(r); }));
app.post('/api/ai/market', h(async (req, res) => { const r = await updateMarketAI(true); res.json({ ok: true, marketAI: r }); }));
app.post('/api/ai/brief', h(async (req, res) => { const r = await aiMarketBrief(true); res.json({ ok: !r.error, brief: r }); }));
app.post('/api/ai/watch', h(async (req, res) => {
  const kind = String(req.body && req.body.kind || '').toLowerCase() === 'lt' ? 'lt' : 'scalp';
  const base = String(req.body && req.body.base || '');
  if (!base) return res.status(400).json({ error: 'base gerekli' });
  const r = await watchAI(kind, base, { force: !!(req.body && req.body.force) });
  res.json(r);
}));

app.get('/api/decisions', h((req, res) => res.json({ rows: readDecisions(clamp(Math.round(num(req.query.n, 100)), 10, 500)) })));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-200).reverse() })));

app.post('/api/settings', h((req, res) => {
  if (req.body && req.body.tradeMode === 'live' && !HAS_KEYS) return res.status(400).json({ error: 'Bitget anahtarı gerekli' });
  settings = sanitizeSettings(Object.assign({}, settings, req.body || {}));
  if (settings.tradeMode === 'live' && !HAS_KEYS) settings.tradeMode = 'paper';
  dirty = true; saveState(true);
  refreshUniverse().catch(() => {});
  res.json({ ok: true, settings });
}));

/* ══════════════════════════════════════════════════════════════════════════════
   DÖNGÜLER + BAŞLANGIÇ
   ══════════════════════════════════════════════════════════════════════════════ */
async function every(ms, name, fn) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { logOnce(name + ':err', 'DÖNGÜ HATA ' + name + ': ' + redact(e.message), 5 * M1); }
    finally { busy = false; }
  }, ms);
  setTimeout(async () => { try { await fn(); } catch (e) { /* sessiz */ } }, 1500);
}

function dayRollover() {
  const today = dayKey();
  if (paper.dayKey !== today) {
    paper.dayKey = today;
    paper.dayStart = paper.equity;
    REJ = []; REJ_STAT = {}; CHECK_STAT = {};
    for (const p of AI_PROV) { p.dayKey = today; p.dayCount = 0; }
    AI_USAGE.dayKey = today; AI_USAGE.dayCount = 0; AI_USAGE.briefDay = today; AI_USAGE.briefCount = 0;
    dirty = true;
    log('Gün başı: paper başlangıç ' + paper.equity);
  }
}

function startLoops() {
  every(30e3, 'universe', async () => { await refreshUniverse(); await refreshTickers(); });
  every(20e3, 'market', async () => { await updateMarket(); await updateMarketAI(false); });
  every(25e3, 'autoScan', async () => { await autoScan(false); });
  every(10e3, 'ticker', async () => { await refreshTickers(); });
  every(45e3, 'scalpScan', async () => { await scalpScan(); });
  every(60e3, 'ltScan', async () => { await ltScan(); });
  every(8e3, 'monitorPaper', () => { monitorPaper(); });
  every(10e3, 'monitorLive', async () => { if (settings.tradeMode === 'live') { await monitorLive(); await syncLive(); } });
  every(12e3, 'monitorVirtual', () => { monitorVirtual(); });
  every(15e3, 'monitorShadow', () => { monitorShadow(); });
  every(6e3, 'ltTick', () => { ltTick(); });
  every(20e3, 'reconcile', () => { reconcilePending(); });
  every(8e3, 'autoAI', async () => { await maybeAutoAI(); });
  every(30e3, 'watchAI', async () => { await maybeWatchAI(); });
  every(60e3, 'brief', async () => { await maybeMarketBrief(); });
  every(30 * M1, 'discover', async () => { await maybeDiscover(); });
  every(5 * M1, 'orphans', async () => { if (settings.tradeMode === 'live') await checkOrphans(); });
  every(2 * H1, 'save', () => { saveState(false); });
  every(60e3, 'rollover', () => { dayRollover(); });
}

async function init() {
  log('AlphaSon ' + VERSION + ' başlıyor...');
  loadState();
  try { await refreshUniverse(); } catch (e) { /* sessiz */ }
  await refreshTickers();
  await updateMarket();
  setTimeout(async () => { await maybeDiscover(); }, 5000);
  setTimeout(async () => { await updateMarketAI(false); }, 10000);
  READY = true;
  log('Hazır. Modüller: ' + ACTIVE_MODULES.join(', ') + ' | Evren: ' + UNIVERSE.length + ' | AI: ' + (aiReady() ? 'aktif' : 'kapalı') + ' | Canlı: ' + (HAS_KEYS && settings.tradeMode === 'live' ? 'EVET' : 'hayır (paper)'));
}

function shutdown(sig) {
  log('Kapatılıyor (' + sig + ')...');
  try { saveState(true); } catch (e) { /* sessiz */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => log('UNCAUGHT: ' + redact(e && e.message)));
process.on('unhandledRejection', e => log('UNHANDLED: ' + redact(e && (e.message || String(e)))));

function start() {
  const server = app.listen(PORT, () => {
    log('HTTP: http://0.0.0.0:' + PORT + ' | ' + VERSION);
    init().catch(e => log('BAŞLATMA HATASI: ' + redact(e.message)));
    startLoops();
  });
  server.on('error', e => log('SUNUCU HATASI: ' + redact(e.message)));
  return server;
}

if (require.main === module) start();

module.exports = {
  VERSION, app, start, init,
  getState: () => ({ signals, paper, LIVE, settings, market, marketAI, UNIVERSE, AI_PROV, AI_USAGE, AI_HIST, SHADOW }),
  _test: { emaArr, rsiLast, atrLast, adxLast, vwapOf, pivots, aggTF, htfTrend, bodyRatio, bodyAtr, rrNet, analyzeTriangle, triLineCands, srLevels, triangleChart, ltSignalFrom, scalpContext, scalpAnalyze, autoContext, autoCandidates, autoCandidatesRaw, sanitizeSettings, parseAIJSON, parseChecksJSON, enforceChecks, normTR, addSignal, openPaper, closePaper, monitorPaper, paperSummary, statsByModule, btStats, dayKey, utcDayStart, clamp, num, rp, avg, sum, baseOf, isStock, scanSyms, getLong2h }
};
