'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v86.2 — tek dosya sunucu (PARÇA 1/3 — başlangıç + AI çekirdek)
   ══════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
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

const VERSION = 'v86.2';
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
    const alt = path.join(os.tmpdir(), 'alphason-v86');
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
    models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], prefer: 1, dayLimit: envLimit('GEMINI', 420)
  }),
  mkProv({
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com',
    key: '',
    models: ['deepseek-chat'], prefer: 2, dayLimit: envLimit('DEEPSEEK', 3000)
  }),
  mkProv({
    id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], prefer: 3, dayLimit: envLimit('GROQ', 900)
  }),
  mkProv({
    id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1',
    key: '',
    models: ['gpt-4o-mini', 'gpt-4.1-mini'], prefer: 5, dayLimit: envLimit('OPENAI', 2000)
  })
];

const AI_USAGE = {
  dayKey: new Date().toISOString().slice(0, 10), dayCount: 0,
  hourKey: Math.floor(Date.now() / H1), hourCount: 0,
  briefDay: new Date().toISOString().slice(0, 10), briefCount: 0,
  moduleDay: { AUTO: 0, PUMP: 0, LT: 0 }
};
const AI_QUEUE = [];
let AI_HIST = [];
const AI_STATE = { busy: false, lastAt: 0, lastError: null };
const AI_DISCOVER = { running: false, at: 0, results: {}, error: null };
const SHADOW = [];
const CHECK_STAT = {};
const AUTO_AI = { hk: 0, count: 0 };
const AI_COMMENT = { hk: 0, count: 0 };
const SCALP_BEKLE = new Map();

const EX = {
  FEE: 0.0006, SLIP: 0.0004, H: 0.20,
  MIN_RR1: 0.50, MIN_RR2: 0.80,
  MAX_RISK_PCT: 3.5, MIN_RISK_PCT: 0.35
};

const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade (Pump/Dump)', tf: '1m', chartTf: '1m', enabled: true, tradeable: true, maxPerDaySym: 10, cooldown: 10 * M1, maxAge: 45 * M1, auto: true },
    PUMP: { key: 'PUMP', label: 'Günlük Hızlı Scalp', tf: '15m', chartTf: '15m', enabled: true, tradeable: false, maxPerDaySym: 5, cooldown: 1 * H1, maxAge: 8 * H1 },
  LT:   { key: 'LT',   label: 'LT Üçgen',          tf: '2h',  chartTf: '2h',  enabled: true, tradeable: false, maxPerDaySym: 2, cooldown: 3 * H1, maxAge: 18 * H1 }
};
const ACTIVE_MODULES = ['AUTO', 'PUMP', 'LT'];

const SKIP_RESULTS = new Set(['DOLMADI','AI_RED','AI_ERROR','AI_TIMEOUT','AI_STALE','APPROVAL_EXPIRED','SKIP','MATH_ONLY']);
const TRADE_RESULTS = new Set(['TP1','TP2','SL','BE','TIME','MANUEL','MOMENTUM','REVERSAL','FADE','ZAYIF_IVME','STALL','LOCK','AI_EXIT','EXCHANGE']);
const RES = {
  TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL',
  MOMENTUM: 'İVME BİTTİ', REVERSAL: 'TERS DÖNÜŞ', FADE: 'KÂR GERİ VERİLDİ', ZAYIF_IVME: 'İVME ZAYIFLADI',
  STALL: 'HAREKETSİZ', LOCK: 'KÂR KİLİDİ', DOLMADI: 'DOLMADI', AI_RED: 'AI GİRİLMEZ',
  AI_ERROR: 'AI YANITI YOK', AI_TIMEOUT: 'AI ZAMAN AŞIMI', AI_STALE: 'FİYAT KAÇTI',
  APPROVAL_EXPIRED: 'ONAY VERİLMEDİ', SKIP: 'ATLANDI', MATH_ONLY: 'MATEMATİK KARARI',
  AI_EXIT: 'AI ÇIKIŞ', EXCHANGE: 'BORSADA KAPANDI'
};

const TOKENIZED_STOCKS = new Set([
  'INTC','MSTR','KORU','SNXX','TSLA','NVDA','AAPL','COIN','HOOD','CRCL','AMZN','GOOGL','MSFT',
  'META','SPY','QQQ','PLTR','AMD','NFLX','BABA','MARA','RIOT',
  'CBRS','TQQQ','BE','CRWV','XAG'
]);

const DEF_SET = {
  auto: false, autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 5, riskPct: 0.5,
  maxOpen: 3, autoMaxOpen: 3, dailyLossPct: 3, minConf: 55, aiEnabled: false, aiWatchAuto: false,
  costPct: EX.H, paperEquity: 1000, maxSpreadPct: 0.10, minQuoteVol: 5e5, topN: 150,
  includeStocks: false, autoAiPerHour: 40, stallSec: 240, aiCommentPerHour: 20, scalpRev: false
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
  s.stallSec = clamp(Math.round(num(s.stallSec, DEF_SET.stallSec)), 60, 900);
  s.aiCommentPerHour = clamp(Math.round(num(s.aiCommentPerHour, DEF_SET.aiCommentPerHour)), 0, 100);
  s.scalpRev = s.scalpRev === true;
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

function capArr(a, n) { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (settings.minQuoteVol > 5e5) settings.minQuoteVol = 5e5;
    if (settings.topN > 150) settings.topN = 150;
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
    if (j && j.version === VERSION && j.aiMeta) for (const p of AI_PROV) if (j.aiMeta[p.id]) p.discoverAt = Number(j.aiMeta[p.id]) || 0;
    if (j && Array.isArray(j.rej)) REJ = j.rej.slice(-200);
    if (j && Array.isArray(j.out)) OUT = j.out.slice(-300);
    if (j && j.rejStat) REJ_STAT = j.rejStat;
    if (j && Number.isFinite(Number(j.seq))) seq = Number(j.seq);
    if (j && j.aiUsage) {
      Object.assign(AI_USAGE, j.aiUsage);
      if (!AI_USAGE.moduleDay) AI_USAGE.moduleDay = { AUTO: 0, PUMP: 0, LT: 0 };
    }
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
      aiMeta: Object.fromEntries(AI_PROV.map(p => [p.id, p.discoverAt || 0])),
      aiHist: AI_HIST.slice(-300).map(r => Object.assign({}, r, { rec: undefined })),
      shadow: SHADOW.filter(s => !s.done).slice(-100).map(s => Object.assign({}, s, { rec: undefined }))
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { log('Durum kaydedilemedi: ' + e.message); }
}

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

const ex = new ccxt.bitget({
  apiKey: API_KEY || undefined, secret: API_SECRET || undefined, password: API_PASS || undefined,
  enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap', defaultSubType: 'linear' }
});

const CACHE = new Map();
const TICK = new Map();
const TICKHIST = new Map();
const LONG1H = new Map();
let UNIVERSE = [];
const FALLBACK = [
  'BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','XRP/USDT:USDT','DOGE/USDT:USDT',
  'BNB/USDT:USDT','ADA/USDT:USDT','AVAX/USDT:USDT','LINK/USDT:USDT','SUI/USDT:USDT',
  'TON/USDT:USDT','DOT/USDT:USDT','LTC/USDT:USDT','BCH/USDT:USDT','NEAR/USDT:USDT',
  'APT/USDT:USDT','ARB/USDT:USDT','OP/USDT:USDT','INJ/USDT:USDT','TIA/USDT:USDT'
];
const EXCLUDE = new Set(['USDC','USDT','DAI','FDUSD','TUSD','USDD','PYUSD','EUR','GBP','BUSD','BTC3L','BTC3S','ETH3L','ETH3S','SOL3L','SOL3S','XRP3L','XRP3S']);

async function pool(items, n, fn) {
  const list = items.slice();
  let idx = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) {
      const i = idx++;
      try { await fn(list[i], i); } catch (e) { /* worker hatası diğerlerini durdurmasın */ }
    }
  });
  await Promise.all(workers);
}

function scanSyms(kind, n) {
  const l = UNIVERSE.filter(s => kind === 'LT' || settings.includeStocks || !isStock(s));
  return l.slice(0, n);
}

function hotSyms(kind, n) {
  const base = UNIVERSE.filter(s => kind === 'LT' || settings.includeStocks || !isStock(s));
  const now = Date.now(), mv = [];
  for (const s of base) {
    const h = TICKHIST.get(s);
    if (!h || h.length < 3) continue;
    const last = h[h.length - 1].p;
    let old = h[0].p;
    for (let i = h.length - 1; i >= 0; i--) { if (now - h[i].t >= 150e3) { old = h[i].p; break; } }
    mv.push({ s, m: Math.abs(last / old - 1) });
  }
  mv.sort((a, b) => b.m - a.m);
  const out = base.slice(0, 10);
  for (const x of mv) { if (out.length >= n) break; if (x.m < 0.002) break; if (!out.includes(x.s)) out.push(x.s); }
  return out;
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
      let hh = TICKHIST.get(sym); if (!hh) { hh = []; TICKHIST.set(sym, hh); }
      hh.push({ t: Date.now(), p: last }); if (hh.length > 75) hh.splice(0, hh.length - 75);
    }
  } catch (e) { /* ticker hatası taramayı durdurmasın */ }
}

async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const ent = CACHE.get(key);
  if (ent && now - ent.t < (TTL[tf] || 60e3) && (ent.lim || 0) >= limit) return ent.data.slice(-limit);
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
  CACHE.set(key, { t: now, data, lim: limit });
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

async function updateMarket() {
  try {
    const btc = await getCandles('BTC/USDT:USDT', '15m', 120, true);
    const eth = await getCandles('ETH/USDT:USDT', '15m', 120, true);
    const one = (cs, sym) => {
      if (!cs || cs.length < 60) return null;
      const cl = closesOf(cs), e20a = emaArr(cl, 20);
      const e20 = e20a[e20a.length - 1], e20p = e20a[e20a.length - 7], e50 = emaLast(cl, 50);
      const rsi = rsiLast(cl, 14), atr = atrLast(cs, 14), last = cl[cl.length - 1];
      return { price: rp(last), e20: rp(e20), e50: rp(e50), rsi: rsi != null ? +rsi.toFixed(0) : null, atrPct: atr ? +(atr / last * 100).toFixed(2) : null, chg: num(tick(sym) && tick(sym).chg), up: e20 > e50, slopeUp: e20 > e20p, above: last > e20 };
    };
    const b = one(btc, 'BTC/USDT:USDT'), e = one(eth, 'ETH/USDT:USDT');
    let green = 0, total = 0;
    for (const sym of UNIVERSE) { const t = tick(sym); if (!t) continue; total++; if (t.chg > 0) green++; }
    const breadth = total ? green / total : 0.5;
    let sc = 0;
    const parts = [];
    if (b) { sc += (b.up ? 1 : -1) + (b.slopeUp ? 1 : -1) + (b.above ? 1 : -1); parts.push('BTC ' + (b.up ? 'EMA20>EMA50' : 'EMA20<EMA50') + (b.slopeUp ? ', eğim ↑' : ', eğim ↓') + (b.above ? ', fiyat EMA20 üstünde' : ', fiyat EMA20 altında')); }
    if (e) { sc += (e.up ? 1 : -1) + (e.slopeUp ? 1 : -1); parts.push('ETH ' + (e.up ? 'yukarı' : 'aşağı')); }
    if (breadth >= 0.55) sc += 1; else if (breadth <= 0.45) sc -= 1;
    parts.push('genişlik %' + Math.round(breadth * 100) + ' yeşil');

    const mathDir = sc >= 3 ? 'LONG' : sc <= -3 ? 'SHORT' : 'NOTR';
    const mathScore = clamp(0.5 + sc * 0.05, 0.1, 0.9);
    const mathWhy = 'Matematik 15m (' + sc + '/6): ' + parts.join(' · ');

    let aiDir = null;
    let aiScore = null;
    let aiWhy = null;
    let aiProvider = null;
    let finalDir = mathDir;
    let finalWhy = mathWhy;

    if (aiReady()) {
      try {
        const prompt = 'Piyasa verisi: ' + mathWhy + '\nBu veriye göre yönü onaylıyor musun? Yanıtı JSON ver: {"verdict": "LONG", "SHORT" veya "NOTR", "score": 0-100 arası sayı, "reason": "kısa özet"}';
        
        const validateMarketAI = (text) => {
            const j = extractJSON(text);
            if (!j) return false;
            const v = String(j.verdict || '').toUpperCase();
            const s = Number(j.score);
            if (!['LONG', 'SHORT', 'NOTR'].includes(v)) return false;
            if (!Number.isFinite(s) || s < 0 || s > 100) return false;
            return true;
        };

        const ai = await callAI(
            [{ role: 'system', content: AI_SYS_WATCH }, { role: 'user', content: prompt }], 
            { prefer: 'groq', module: null, validate: validateMarketAI }
        );
        
        const j = extractJSON(ai.text);
        if (j && j.verdict) {
          const v = String(j.verdict).toUpperCase();
          aiDir = ['LONG','SHORT','NOTR'].includes(v) ? v : null;
          aiScore = Number(j.score);
          aiWhy = 'AI (' + ai.providerName + '): ' + String(j.reason || '');
          aiProvider = ai.providerName;

          if (mathDir === 'NOTR') {
              finalDir = 'NOTR';
          } else if (mathDir === aiDir) {
              finalDir = mathDir;
          } else {
              finalDir = 'NOTR'; 
          }
          
          finalWhy = aiWhy;
        }
      } catch (err) { 
          log('Piyasa AI hatası (Matematik yönüne dönüldü): ' + err.message); 
      }
    }

    market = { 
      dir: finalDir, 
      score: +mathScore.toFixed(2), 
      breadth: +breadth.toFixed(3), 
      why: finalWhy, 
      btc: b, eth: e, at: Date.now(), 
      mathDir: mathDir, 
      mathScore: +mathScore.toFixed(2), 
      aiDir: aiDir, 
      aiScore: aiScore, 
      aiAt: aiProvider ? Date.now() : null, 
      source: aiProvider || 'Matematik' 
    };
    
    marketAI = Object.assign({}, marketAI, { 
      dir: finalDir, 
      score: aiScore !== null ? Math.round(aiScore) : Math.round(mathScore * 100), 
      reason: finalWhy, 
      at: Date.now(), 
      provider: aiProvider || 'Matematik', 
      model: null 
    });
  } catch (e) { log('Piyasa rejimi hatası: ' + redact(e.message)); }
}

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
      const earlyWatchEligible = (apexX >= 3 && apexX <= 200);

      const firstIdx = Math.min(u.a.i, l.a.i);
      const apexIdx = refIdx + apexX;
      const maturity = clamp((refIdx - firstIdx) / Math.max(1, apexIdx - firstIdx), 0, 1);
      if (maturity < 0.15) continue;
      const wAt = i => (hi.intercept + hi.slope * (i - refIdx)) - (lo.intercept + lo.slope * (i - refIdx));
      const widthStart = wAt(firstIdx);
      if (!(widthStart > 0)) continue;
      const compression = clamp(1 - widthNow / widthStart, 0, 1);
      if (compression < 0.05) continue;
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
          spanBars: refIdx - firstIdx,
          earlyWatchEligible
        };
      }
    }
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v86.2 — PARÇA 2/3 (Aşağıdaki mesajda)
   ══════════════════════════════════════════════════════════════════════════════ */
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

  const upTouch = last.h >= up - 0.10 * atr;
  const dnTouch = last.l <= dn + 0.10 * atr;
  const upClosed = last.c >= up - 0.03 * atr && last.c > last.o;
  const dnClosed = last.c <= dn + 0.03 * atr && last.c < last.o;

  let upLive = false, dnLive = false, liveBody = 0;
  if (opt && Number(opt.liveOpen) > 0 && Number(opt.livePrice) > 0) {
    const lo = Number(opt.liveOpen);
    const lh = Number(opt.liveHigh) || Math.max(lo, px);
    const ll = Number(opt.liveLow) || Math.min(lo, px);
    const liveCandle = { o: lo, h: lh, l: ll, c: px };
    liveBody = bodyRatio(liveCandle);
    upLive = px >= up && lo < up;
    dnLive = px <= dn && lo > dn;
  }

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
  if (liveOnly && liveBody > 0) { br = Math.max(br, liveBody); ba = Math.max(ba, liveBody); }
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

function ltWatchStatus(sym, e) {
  const { tri, cs } = e;
  const liveTick = TICK.get(sym);
  const px = (liveTick && liveTick.last > 0) ? liveTick.last : cs[cs.length - 1].c;
  const up = triUpperAt(tri, cs.length - 1), dn = triLowerAt(tri, cs.length - 1);
  const isBroken = px > up + 0.25 * tri.atr || px < dn - 0.25 * tri.atr;

  if (!tri.earlyWatchEligible && !isBroken) return null;

  const distU = (up - px) / tri.atr;
  const distD = (px - dn) / tri.atr;
  const nearAtr = Math.min(Math.abs(distU), Math.abs(distD));
  let status = 'SIKISMA';
  let dirHint = null;

  if (isBroken) {
    status = 'KIRILIM_TEYITLI';
    dirHint = px > up ? 'LONG' : 'SHORT';
  } else if (nearAtr <= 1.0) {
    status = 'KIRILIM_YAKIN';
    const width = up - dn;
    if (width > 0) {
      const konum = (px - dn) / width;
      const cl = cs.slice(-3).map(c => c.c);
      const up2 = cl.length >= 3 && cl[1] > cl[0] && cl[2] > cl[1];
      const dn2 = cl.length >= 3 && cl[1] < cl[0] && cl[2] < cl[1];
      if (konum > 0.5 && up2 && Math.abs(distU) <= 0.6) { status = 'YUKARI_ADAY'; dirHint = 'LONG'; }
      else if (konum < 0.5 && dn2 && Math.abs(distD) <= 0.6) { status = 'ASAGI_ADAY'; dirHint = 'SHORT'; }
    }
  }
  return { status, dirHint, px, up, dn, distU, distD, konum: (up - dn) > 0 ? (px - dn) / (up - dn) : null };
}

function buildLtWatch() {
  const rows = [];
  for (const [sym, e] of LT_CACHE) {
    const s = ltWatchStatus(sym, e);
    if (!s) continue;
    const { tri, tf } = e;
    rows.push({
      symbol: sym, base: baseOf(sym), tf, price: rp(s.px), upper: rp(s.up), lower: rp(s.dn),
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct,
      distUpperPct: +((s.up / s.px - 1) * 100).toFixed(2), distLowerPct: +((s.px / s.dn - 1) * 100).toFixed(2),
      distUpper: +((s.up / s.px - 1) * 100).toFixed(2), distLower: +((s.px / s.dn - 1) * 100).toFixed(2),
      nearPct: +Math.min(Math.abs(s.distU), Math.abs(s.distD)).toFixed(2),
      nearSide: Math.abs(s.distU) <= Math.abs(s.distD) ? 'ÜST' : 'ALT',
      status: s.status, dirHint: s.dirHint,
      shape: tri.shape, maturity: tri.maturity, compression: tri.compression, score: tri.score,
      touches: tri.touchesH + tri.touchesL, apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1),
      earlyWatchEligible: tri.earlyWatchEligible === true,
      breakoutUp: s.px > s.up + 0.25 * tri.atr, breakoutDn: s.px < s.dn - 0.25 * tri.atr,
      ai: (e.ai || null)
    });
  }
  rows.sort((a, b) => a.nearPct - b.nearPct || b.score - a.score);
  WATCH.lt = rows.slice(0, 40);
  WATCH_META.lt = { scannedAt: lastScan.lt || Date.now(), count: WATCH.lt.length, universe: Math.min(40, UNIVERSE.length) };
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
  } catch (e) { /* sessiz */ }
  finally { ltTicking = false; }
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

const SESSIONS = [0, 7 * H1, 13 * H1 + 30 * M1];
function currentSession(now) {
  const day = utcDayStart(now);
  let best = null;
  for (const off of SESSIONS) { const start = day + off; if (start <= now && now - start <= 5 * H1) best = { start, off }; }
  return best || { start: day, off: 0 };
}
function openingRange(cs, start) {
  const bars = cs.filter(c => c.t >= start && c.t < start + 30 * M1);
  if (bars.length < 2) return null;
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
  const volSma = avg(cs.slice(-21, -1).map(c => c.v));
  const volRatio = volSma > 0 ? last.v / volSma : 0;
  const session = currentSession(now);
  const vw = vwapOf(cs, session.start);
  const or = openingRange(cs, session.start);
  const spread = (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym);
  const atrPct = atr / px * 100;
  const e50Slope = e50[n - 7] ? (e50[n - 1] - e50[n - 7]) / e50[n - 7] * 100 : 0;
  const htf = (opt && opt.htf) || htfTrend(closed(aggTF(cs.slice(-300), 12, M5), H1));
  return {
    sym, cs, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi, htf,
    adx: adxObj ? adxObj.adx : null, plusDI: adxObj ? adxObj.plusDI : null, minusDI: adxObj ? adxObj.minusDI : null,
    volSma, volRatio, vwap: vw.vwap, vwapSd: vw.sd, session, or, spread, e50Slope,
    body: bodyRatio(last), ba: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr
  };
}

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}

function computeScalpStop(cs, dir, entry, atr) {
  const sw = cs.slice(-4);
  if (sw.length < 4 || !(atr > 0)) return null;
  const d = dir === 'LONG' ? 1 : -1;
  const structural = dir === 'LONG'
    ? Math.min.apply(null, sw.map(c => c.l)) - 0.15 * atr
    : Math.max.apply(null, sw.map(c => c.h)) + 0.15 * atr;
  let sl = structural;
  let riskPct = Math.abs(entry - sl) / entry * 100;

  if (riskPct < 0.35) {
    const minSl = entry - d * (entry * 0.35 / 100);
    if (dir === 'LONG' ? minSl < sl : minSl > sl) sl = minSl;
    riskPct = Math.abs(entry - sl) / entry * 100;
  }
  if (riskPct > 1.50) return null;
  return { sl: rp(sl), riskPct: +riskPct.toFixed(3) };
}

function computeScalpTps(entry, sl, dir) {
  const d = dir === 'LONG' ? 1 : -1;
  const riskPct = Math.abs(entry - sl) / entry * 100;
  if (!(riskPct > 0)) return null;
  const minTp1Pct = EX.H + 0.50 * (riskPct + EX.H);
  const minTp2Pct = EX.H + 0.80 * (riskPct + EX.H);
  const risk1Px = entry * riskPct / 100;
  const tp1Dist = Math.max(0.75 * risk1Px, entry * minTp1Pct / 100, entry * 0.25 / 100);
  const tp2Dist = Math.max(1.25 * risk1Px, entry * minTp2Pct / 100, entry * 0.40 / 100);
  const tp1 = rp(entry + d * tp1Dist);
  const tp2 = rp(entry + d * tp2Dist);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net + 1e-6 < EX.MIN_RR1 || q2.net + 1e-6 < EX.MIN_RR2) return null;
  return { tp1, tp2, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(3), tp1DistPx: tp1Dist, tp2DistPx: tp2Dist };
}

function makeScalpCandidate(ctx, setup, dir, entry, sl, tp1Ignored, tp2Ignored, holdMs, score, reasons, risks, trigger, distPct, triggered) {
  entry = rp(entry);
  const stop = computeScalpStop(ctx.cs, dir, entry, ctx.atr);
  if (!stop) return null;
  sl = stop.sl;
  const tps = computeScalpTps(entry, sl, dir);
  if (!tps) return null;
  const riskPct = stop.riskPct;
  if (riskPct < 0.35 || riskPct > 1.50) return null;
  return {
    setup, dir, entry, sl: rp(sl), tp1: tps.tp1, tp2: tps.tp2, holdMs,
    score: clamp(Math.round(score), 0, 100),
    riskPct: +riskPct.toFixed(2), netRR: tps.netRR, netRR2: tps.netRR2,
    reasons: reasons.filter(Boolean).slice(0, 6), risks: risks.filter(Boolean).slice(0, 4),
    trigger: rp(trigger || entry), distPct: +num(distPct, 0).toFixed(2), triggered: !!triggered
  };
}

/* PUMP — Sıfırdan Trend Takip. Piyasa NÖTR ise sinyal yok. LONG ise sadece LONG, SHORT ise sadece SHORT. */
function scalpCandidates(ctx) {
  const out = [];
  const { last, px, atr, cs, n } = ctx;

  if (market.dir === 'NOTR') return out;

  if (market.dir === 'LONG') {
    const trendUp = ctx.e20[n - 1] > ctx.e50[n - 1] && last.c > ctx.e20[n - 1];
    const volOk = ctx.volRatio >= 1.2;
    const bodyOk = last.c > last.o;

    if (trendUp && volOk && bodyOk) {
      const cand = makeScalpCandidate(ctx, 'TREND', 'LONG', px, 0, 0, 0, 4 * H1,
        60 + clamp(ctx.volRatio - 1.2, 0, 1) * 15 + clamp(ctx.ba - 0.3, 0, 1) * 10,
        ['Güçlü yukarı trend (EMA20>EMA50)', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x'],
        [], ctx.e20[n - 1], 0, true);
      if (cand) out.push(cand);
    }
  }

  if (market.dir === 'SHORT') {
    const trendDn = ctx.e20[n - 1] < ctx.e50[n - 1] && last.c < ctx.e20[n - 1];
    const volOk = ctx.volRatio >= 1.2;
    const bodyOk = last.c < last.o;

    if (trendDn && volOk && bodyOk) {
      const cand = makeScalpCandidate(ctx, 'TREND', 'SHORT', px, 0, 0, 0, 4 * H1,
        60 + clamp(ctx.volRatio - 1.2, 0, 1) * 15 + clamp(ctx.ba - 0.3, 0, 1) * 10,
        ['Güçlü aşağı trend (EMA20<EMA50)', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x'],
        [], ctx.e20[n - 1], 0, true);
      if (cand) out.push(cand);
    }
  }

  return out;
}

function scalpAnalyze(sym, cs, opt) {
  const ctx = scalpContext(sym, cs, opt);
  if (!ctx) return null;
  if (ctx.atrPct < 0.25 || ctx.atrPct > 4.0) return null;
  if (ctx.spread > settings.maxSpreadPct) return null;
  const cands = scalpCandidates(ctx).filter(Boolean);
  if (!cands.length) return null;
  const confirmed = cands.filter(c => !c.watch);
  const watches = cands.filter(c => c.watch);
  if (confirmed.length) {
    confirmed.sort((a, b) => b.score - a.score);
    const best = confirmed[0];
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
        sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), htf: ctx.htf,
        trigger: best.trigger, distPct: best.distPct, score: best.score, reasons: best.reasons, risks: best.risks
      },
      maxAgeMs: best.holdMs + 30 * M1,
      setupKey: 'SCALP|' + sym + '|' + best.setup + '|' + best.dir + '|' + Math.floor(ctx.last.t / M5)
    };
    const row = {
      symbol: sym, base: baseOf(sym), tf: '5m', price: rp(ctx.px), setup: best.setup, dir: best.dir,
      score: best.score, status: 'TETİK', state: 'ADAY SİNYAL',
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
  if (watches.length) {
    watches.sort((a, b) => b.score - a.score);
    const w = watches[0];
    return {
      raw: null,
      row: {
        symbol: sym, base: baseOf(sym), tf: '5m', price: rp(ctx.px), setup: w.setup, dir: w.dir,
        score: +w.score.toFixed(0), status: 'BEKLİYOR', state: w.state,
        trigger: w.trigger, distPct: w.distPct, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
        mom1: +(((ctx.last.c / ctx.cs[ctx.n - 2].c - 1) * 100)).toFixed(2),
        mom3: +(((ctx.last.c / ctx.cs[Math.max(0, ctx.n - 4)].c - 1) * 100)).toFixed(2),
        rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
        vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]),
        orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null,
        sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), reason: w.reasons[0] || '', ai: null
      }
    };
  }
  return null;
}

let scalpScanning = false;
async function scalpScan() {
  if (scalpScanning) return;
  scalpScanning = true;
  try {
    const list = scanSyms('PUMP', 80);
    const rows = [], raws = [];
    await pool(list, 5, async (sym) => {
    const cs = await getCandles(sym, '15m', 300, true);
      if (!cs || cs.length < 120) return;
      const a = scalpAnalyze(sym, cs);
      if (!a) return;
      if (a.row) rows.push(a.row);
      if (a.raw) raws.push(a.raw);
    });
    const old = new Map(SCALP_WATCH.map(r => [r.symbol + '|' + r.setup, r.ai]));
    for (const r of rows) { const prev = old.get(r.symbol + '|' + r.setup); if (prev) r.ai = prev; }
    rows.sort((a, b) => (a.status === 'TETİK' ? -1 : 0) - (b.status === 'TETİK' ? -1 : 0) || Math.abs(a.distPct) - Math.abs(b.distPct) || b.score - a.score);
    SCALP_WATCH = rows.slice(0, 25);
    WATCH.scalp = SCALP_WATCH;
    WATCH_META.scalp = { scannedAt: Date.now(), count: SCALP_WATCH.length, universe: list.length };
    raws.sort((a, b) => b.conf - a.conf);
    let emitted = 0;
    for (const raw of raws) {
      if (emitted >= 3) break;
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 30 * M1) continue;
      if (SCALP_BEKLE.has(raw.setupKey)) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; log('SCALP SİNYAL (' + raw.info.setup + '): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net R:R ' + raw.info.netRR); }
    }
    lastScan.scalp = Date.now();
  } catch (e) { log('Scalp tarama hatası: ' + redact(e.message)); }
  finally { scalpScanning = false; }
}

function isOpenSignal(s) {
  return !!s && s.status !== 'KAPALI' && s.status !== 'BEKLE';
}
function dayPnl() { return +(paper.equity - paper.dayStart).toFixed(4); }
function dailyLossHit() { return dayPnl() <= -Math.abs(paper.dayStart * settings.dailyLossPct / 100); }
function autoOpenCount() { return paper.open.filter(p => p.module === 'AUTO').length + LIVE.open.filter(p => p.module === 'AUTO').length; }
function canAutoOpen(module) {
  if (module === 'AUTO') return settings.autoTrade === true && autoOpenCount() < settings.autoMaxOpen && !dailyLossHit();
  return false;
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
  if (q.net >= 1.0) { score += 5; reasons.push('Net R:R ' + q.net.toFixed(2) + ' (maliyet dahil)'); }
  else if (q.net < 0.6) { score -= 8; risks.push('Net R:R zayıf (' + q.net.toFixed(2) + ')'); }
  const riskPct = Math.abs(sig.entry - sig.sl) / sig.entry * 100;
  if (riskPct > 2.2) { score -= 5; risks.push('Stop geniş (%' + riskPct.toFixed(2) + ')'); }
  if (market.dir !== 'NOTR' && market.dir !== sig.dir) { score -= 6; risks.push('Piyasa yönüne ters'); }
  else if (market.dir === sig.dir) { score += 3; reasons.push('Piyasa yönü uyumlu'); }
  else { score -= 4; risks.push('Piyasa yönü belirsiz'); }
  score = clamp(score, 0, 100);
  const skipped = sig.status === 'KAPALI' && SKIP_RESULTS.has(sig.result);
  const verdict = skipped ? 'GİRİLMEZ' : (score >= settings.minConf ? 'GİRİLİR' : 'BEKLE');
  return {
    verdict, verdictLabel: verdict, score, netRR: q.net, riskPct: +riskPct.toFixed(2),
    reasons: Array.from(new Set(reasons)).slice(0, 8), risks: Array.from(new Set(risks)).slice(0, 6)
  };
}

function capMap(m, n) { while (m.size > n) { const k = m.keys().next().value; m.delete(k); } }

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
  if (q1.net < (raw.module === 'AUTO' ? 0.20 : 0.50)) return false;

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
    if (f && now - f < ttl) return false;
  }

  const counter = market.dir !== 'NOTR' && market.dir !== raw.dir;
  if (counter && raw.module !== 'AUTO') { logRej(raw.module, raw.symbol, 'piyasa yönüne ters (AI)', raw.entry); return false; }

  const id = 'S' + (++seq).toString(36) + '-' + now.toString(36);
  const aiOn = aiReady();
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
  if (raw.module === 'AUTO') {
    sig.status = 'AI_BEKLIYOR';
    sig.aiGate = { state: 'QUEUED', queuedAt: now, note: 'OtoTrade giriş zamanlaması AI kararında' };
  } else if (raw.module === 'PUMP') {
    if (aiOn) {
      sig.status = 'AI_BEKLIYOR';
      sig.aiGate = { state: 'QUEUED', queuedAt: now, note: 'AI kararı bekleniyor (GIR/GIRME)' };
    } else {
      sig.status = 'AKTIF'; sig.startedAt = now;
      sig.aiGate = { state: 'MATH_ONLY', queuedAt: now, note: 'AI kapalı — matematik kararı', decidedAt: now };
    }
  } else {
    sig.status = 'AKTIF'; sig.startedAt = now;
    sig.aiGate = { state: aiOn ? 'QUEUED' : 'MATH_ONLY', queuedAt: now, note: aiOn ? 'AI yorumu bekleniyor' : 'AI kapalı — matematik kararı' };
  }

  signals.push(sig);
  capArr(signals, 500);
  sig.analysis = analyzeSignal(sig);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + sig.analysis.verdictLabel + ' ' + sig.analysis.score + ' | ' + (sig.info.setup || sig.info.shape || sig.info.tf || ''));
  onSignalAdded(sig);

  if (aiOn && sig.module !== 'LT') queueAI(sig);
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
  sig.status = 'KAPALI';
  sig.result = code;
  sig.netR = null; sig.grossR = null;
  sig.closedAt = Date.now();
  sig.skipNote = note || '';
  const gateState = (sig.aiGate && sig.aiGate.state === 'AI_RED') ? 'AI_RED' : 'SKIPPED';
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: gateState, note: note || RES[code] || code, decidedAt: Date.now() });
  dirty = true;
  log('ATLANDI: ' + MODS[sig.module].label + ' ' + sig.base + ' ' + sig.dir + ' → ' + (RES[code] || code) + (note ? ' (' + String(note).slice(0, 160) + ')' : ''));
}

async function approveSignal(sig) {
  if (!sig) return { error: 'sinyal yok' };
  if (sig.status !== 'ONAY_BEKLIYOR') return { error: 'sinyal onay beklemiyor' };
  if (sig.approvalExpiresAt && Date.now() > sig.approvalExpiresAt) { skipSignal(sig, 'APPROVAL_EXPIRED', 'onay süresi doldu'); return { error: 'onay süresi doldu' }; }
  return openTrade(sig);
}

function reconcilePending() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'ONAY_BEKLIYOR') {
      if (sig.approvalExpiresAt && now > sig.approvalExpiresAt) skipSignal(sig, 'APPROVAL_EXPIRED', 'onay süresi doldu');
      continue;
    }
    if (sig.status === 'BEKLE') {
      const decidedAt = (sig.aiGate && sig.aiGate.decidedAt) || sig.createdAt;
      if (now - decidedAt > 30 * M1) skipSignal(sig, 'DOLMADI', 'BEKLE süresi doldu — teyit gelmedi');
      continue;
    }
    if (sig.status !== 'AI_BEKLIYOR') continue;
    const queued = AI_QUEUE.some(x => x.id === sig.id);
    if (!aiReady()) {
      if (sig.module === 'AUTO') { skipSignal(sig, 'AI_ERROR', 'OtoTrade için AI kapalı'); continue; }
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'MATH_ONLY', note: 'AI kapalı — matematik kararı', decidedAt: now });
      sig.status = 'AKTIF';
      dirty = true;
      continue;
    }
    if (now - sig.createdAt > 20 * M1) {
      if (sig.module === 'AUTO') { skipSignal(sig, 'AI_TIMEOUT', 'OtoTrade giriş zamanı kaçtı'); continue; }
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'AI yanıtı gecikti — matematik kararı', decidedAt: now });
      sig.status = 'AKTIF';
      dirty = true;
      continue;
    }
    if (!queued && !AI_STATE.busy) queueAI(sig);
  }
}

function openPaper(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (sig.status === 'BEKLE') return { error: 'sinyal bekleme durumunda — açılamaz' };
  if (paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin açık' };
  if (sig.module === 'AUTO') { if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks ' + settings.autoMaxOpen + ' işlem' }; }
  else if (paper.open.length >= settings.maxOpen) return { error: 'maks açık işlem' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const px = priceOf(sig.symbol);
  if (!(px > 0)) return { error: 'fiyat yok' };
  const atrPct = num(sig.info && sig.info.atrPct, 0.5);
  const maxDrift = Math.max(0.22, Math.min(0.65, atrPct * 0.35));
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > maxDrift) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const entry = rp(px);
  const riskPerUnit = Math.abs(entry - sig.sl);
  if (!(riskPerUnit > 0)) return { error: 'stop geçersiz' };
  const riskAmt = paper.equity * settings.riskPct / 100;
  let qty = riskAmt / riskPerUnit;
  const maxNotional = settings.margin * settings.leverage;
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  if (!(qty > 0)) return { error: 'miktar 0' };
  const pos = {
    id: 'P' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +qty.toFixed(8), initialQty: +qty.toFixed(8), remainingQty: +qty.toFixed(8),
    notional: +(qty * entry).toFixed(4), margin: +((qty * entry) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(qty * riskPerUnit).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxR: 0,
    stallMs: (sig.noMoveSec ? sig.noMoveSec : settings.stallSec) * 1000,
    peakPx: entry, wickFrom: Math.ceil(Date.now() / 60000) * 60000, lockStage: 0,
    maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 2 * H1)), setup: (sig.info && sig.info.setup) || null,
    isLive: false, scalp: sig.module === 'PUMP', quickTpPct: null
  };
  sig.entry = entry;
  sig.status = 'AKTIF';
  sig.startedAt = pos.openedAt;
  sig.operatorApprovedAt = pos.openedAt;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'paper açıldı', decidedAt: Date.now() });
  paper.open.push(pos);
  dirty = true;
  log('PAPER AÇILDI: ' + sig.base + ' ' + sig.dir + ' | giriş ' + entry + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | risk %' + settings.riskPct);
  return { pos };
}

async function openTrade(sig) {
  if (settings.tradeMode === 'live') return await liveOpen(sig);
  return openPaper(sig);
}

function closePortion(pos, qty, price) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const gross = (price - pos.entry) * d * qty;
  const cost = qty * pos.entry * EX.H / 100;
  pos.grossRealized += gross;
  pos.costPaid += cost;
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
  if (sig) {
    sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(price); sig.closedAt = Date.now();
    sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.analysis = analyzeSignal(sig);
  }
  paper.open = paper.open.filter(p => p.id !== pos.id);
  const rec = Object.assign({}, pos, { exit: rp(price), result: reason, pnl: net, netR, grossR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt });
  delete rec.remainingQty;
  paper.closed.push(rec);
  capArr(paper.closed, 300);
  OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, conf: sig ? sig.conf : null, createdAt: sig ? sig.createdAt : pos.openedAt });
  capArr(OUT, 300);
  appendDecision({ type: 'sonuc', sigId: pos.sigId, module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, mode: 'paper' });
  dirty = true;
  log('PAPER KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R (' + net + ' USDT) | bakiye ' + paper.equity);
}

function autoExitTrigger(pos, px, d) {
  if (pos.module !== 'AUTO') return null;
  const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
  const rNow = (px - pos.entry) * d / rRisk;
  const maxR = pos.maxR || 0;
  const cs1 = (CACHE.get(pos.symbol + '|1m') || {}).data;

  if (cs1 && cs1.length >= 8 && (pos.ageMs || 0) > 20e3) {
    const cl = cs1.slice(-4).map(c => c.c);
    const cc = closed(cs1, M1);
    const lc = cc[cc.length - 1];
    const lcPrev = cc[cc.length - 2];
    const atr = atrLast(cs1, 14) || 0;

    const against3 = d === 1
      ? (cl[3] < cl[2] && cl[2] < cl[1] && cl[1] < cl[0])
      : (cl[3] > cl[2] && cl[2] > cl[1] && cl[1] > cl[0]);
    const strongAgainst = !!lc && atr > 0 && (d === 1 ? lc.c < lc.o : lc.c > lc.o)
      && Math.abs(lc.c - lc.o) / atr >= 0.9;
    if (strongAgainst && rNow < 0.3 && rNow < maxR - 0.2) return 'REVERSAL';
    if (against3 && rNow <= -0.3) return 'REVERSAL';

    const givebackR = maxR - rNow;
    const threshold = Math.max(0.20, 0.30 * maxR);
    if (maxR >= 0.35 && givebackR >= threshold) {
      const strongAgainstBody = !!lc && atr > 0
        && (d === 1 ? lc.c < lc.o : lc.c > lc.o)
        && Math.abs(lc.c - lc.o) / atr >= 0.50;
      const twoAgainst = !!lc && !!lcPrev
        && (d === 1 ? (lc.c < lc.o && lcPrev.c < lcPrev.o)
                    : (lc.c > lc.o && lcPrev.c > lcPrev.o));
      if (strongAgainstBody || twoAgainst) return 'MOMENTUM';
    }
  }
  const stallMs = pos.stallMs || settings.stallSec * 1000;
  if (!pos.tp1Hit && (pos.ageMs || 0) > stallMs && maxR < 0.3 && Math.abs(rNow) < 0.3) return 'STALL';
  return null;
}

function lockStopTarget(pos, d) {
  const riskPct = Math.abs(pos.entry - pos.sl) / pos.entry * 100;
  if (!(riskPct > 0)) return null;
  const costR = EX.H / riskPct;
  const minimumNetLockR = costR + 0.05;
  const safetyMargin = 0.05;
  const rRisk = Math.abs(pos.entry - pos.sl);
  const m = pos.maxR || 0;
  if (!(rRisk > 0)) return null;
  if (!(m > minimumNetLockR + safetyMargin)) return null;

  let desiredLockR = null;
  if (pos.tp1Hit)    desiredLockR = Math.max(0, m - 0.4);
  else if (m >= 0.6) desiredLockR = 0.3;
  else if (m >= 0.3) desiredLockR = 0.05;
  if (desiredLockR == null) return null;

  let lockR = Math.max(desiredLockR, minimumNetLockR);
  const cap = m - safetyMargin;
  if (lockR > cap) lockR = cap;
  if (lockR <= 0) return null;
  if (lockR + 1e-9 < minimumNetLockR) return null;

  const ns = rp(pos.entry + d * lockR * rRisk);
  return (d === 1 ? ns > pos.curSl : ns < pos.curSl) ? ns : null;
}

function stopResult(pos, d) {
  const diff = (pos.curSl - pos.entry) * d / Math.max(1e-9, pos.entry);
  if (diff > 0.0003) return 'LOCK';
  return (pos.tp1Hit || Math.abs(diff) <= 0.0003) ? 'BE' : 'SL';
}

function mechanicalExit(pos, trigger, px) {
  const result = trigger === 'STALL' ? 'STALL' : trigger === 'REVERSAL' ? 'REVERSAL' : 'MOMENTUM';
  if (pos.isLive) {
    if (!LIVE.open.includes(pos)) return;
    liveClose(pos, px, result).catch(e => log('MEKANİK ÇIKIŞ HATASI: ' + pos.base + ' → ' + redact(e.message)));
  } else if (paper.open.includes(pos)) {
    closePaper(pos, px, result);
  }
  log('MEKANİK ÇIKIŞ: ' + pos.base + ' (' + trigger + ') → ' + (RES[result] || result));
}

let paperMon = false;
async function monitorPaper() {
  if (paperMon) return;
  paperMon = true;
  try {
    for (const pos of paper.open.slice()) {
      if (!paper.open.includes(pos)) continue;
      const now = Date.now();
      const d = pos.dir === 'LONG' ? 1 : -1;
      let px = pos.module === 'AUTO' ? await fastLivePrice(pos.symbol, priceOf(pos.symbol) || pos.entry) : priceOf(pos.symbol);
      if (!(px > 0)) continue;
      const tk = TICK.get(pos.symbol); if (tk) { tk.last = px; tk.ts = now; }
      let hi = px, lo = px;
      try {
        const cs = await getCandles(pos.symbol, '1m', 8, false);
        if (cs) for (const c of cs) if (c.t >= (pos.wickFrom || 0)) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
      } catch (e) { /* ticker'a düş */ }
      if (!paper.open.includes(pos)) continue;
      const fav = d === 1 ? hi : lo, adv = d === 1 ? lo : hi;
      pos.livePrice = rp(px);
      pos.ageMs = now - pos.openedAt;
      pos.livePnl = +((pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
      pos.livePnlPct = +(pos.livePnl / Math.max(0.0001, pos.margin) * 100).toFixed(2);
      const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
      pos.peakPx = d === 1 ? Math.max(pos.peakPx || pos.entry, fav) : Math.min(pos.peakPx || pos.entry, fav);
      pos.maxR = Math.max(pos.maxR || 0, (pos.peakPx - pos.entry) * d / rRisk);

      if (d === 1 ? adv <= pos.curSl : adv >= pos.curSl) { closePaper(pos, pos.curSl, stopResult(pos, d)); continue; }
      if (!pos.tp1Hit && (d === 1 ? fav >= pos.tp1 : fav <= pos.tp1)) {
        closePortion(pos, +(pos.initialQty * 0.5).toFixed(8), pos.tp1);
        pos.tp1Hit = true;
        pos.curSl = rp(pos.entry);
        pos.wickFrom = Math.ceil(Date.now() / 60000) * 60000;
        const sig = signals.find(s => s.id === pos.sigId);
        if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
        dirty = true;
        log('TP1: ' + pos.base + ' yarısı alındı, stop girişe çekildi (' + pos.curSl + '), TP2 bekleniyor');
      }
      if (pos.tp2 && (d === 1 ? fav >= pos.tp2 : fav <= pos.tp2)) { closePaper(pos, pos.tp2, 'TP2'); continue; }
      const ns = lockStopTarget(pos, d);
      if (ns != null) {
        pos.curSl = ns; pos.lockStage = (pos.lockStage || 0) + 1;
        pos.wickFrom = Math.ceil(Date.now() / 60000) * 60000;
        const sig = signals.find(s => s.id === pos.sigId);
        if (sig) sig.curSl = ns;
        dirty = true;
        if (!pos.tp1Hit) log('KÂR KİLİDİ: ' + pos.base + ' zirve ' + pos.maxR.toFixed(2) + 'R → stop ' + ns);
      }
      if (now - pos.openedAt >= pos.maxHoldMs) { closePaper(pos, px, 'TIME'); continue; }
      const tr = autoExitTrigger(pos, px, d);
      if (tr) mechanicalExit(pos, tr, px);
    }
  } finally { paperMon = false; }
}

function paperSummary() {
  const cl = paper.closed;
  const wins = cl.filter(x => x.pnl > 0).length;
  const losses = cl.filter(x => x.pnl <= 0).length;
  const sumPnl = +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of paper.open) { const px = priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  const eq = paper.equity;
  const peak = Math.max(paper.peak || eq, eq);
  return {
    equity: +eq.toFixed(2), balance: +eq.toFixed(2), start: paper.start,
    dayStart: +paper.dayStart.toFixed(2), dayPnl: dayPnl(),
    open: paper.open.length, closed: cl.length, wins, losses,
    winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0,
    sumPnl, avgPnl: cl.length ? +(sumPnl / cl.length).toFixed(2) : 0,
    unrealized: +unrealized.toFixed(2), peak: +peak.toFixed(2),
    drawdownPct: peak > 0 ? +((peak - eq) / peak * 100).toFixed(2) : 0,
    mode: settings.tradeMode, autoTrade: settings.autoTrade
  };
}

function paperSettingsView() {
  return {
    auto: settings.auto, autoTrade: settings.autoTrade, tradeMode: settings.tradeMode,
    margin: settings.margin, leverage: settings.leverage, riskPct: settings.riskPct,
    maxOpen: settings.maxOpen, autoMaxOpen: settings.autoMaxOpen, dailyLossPct: settings.dailyLossPct, liveKeys: HAS_KEYS
  };
}

function viewPaper(p) {
  const px = priceOf(p.symbol) || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +((p.grossRealized - p.costPaid) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(0.0001, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt, durationMs: Date.now() - p.openedAt });
}

function sigPL(s) {
  const d = s.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(s.entry - s.sl);
  const riskAmt = paper.equity * settings.riskPct / 100;
  const pos = paper.open.find(p => p.sigId === s.id) || LIVE.open.find(p => p.sigId === s.id);
  if (s.status === 'KAPALI') {
    if (s.netR == null) return null;
    return { price: s.exit || null, pricePct: s.exit ? +(((s.exit - s.entry) * d / s.entry) * 100).toFixed(2) : null, netR: s.netR, usdt: s.pnlUsdt != null ? s.pnlUsdt : +(s.netR * riskAmt).toFixed(2), maxR: +(s.maxR || 0).toFixed(2), closed: true, virtual: s.tradeable === false };
  }
  const px = priceOf(s.symbol);
  if (!(px > 0) || !(risk > 0)) return null;
  if (pos) { const r = pos.livePnl != null ? pos.livePnl : 0; return { price: rp(px), pricePct: +(((px - s.entry) * d / s.entry) * 100).toFixed(2), netR: +(r / Math.max(0.0001, pos.riskAmt)).toFixed(2), usdt: +r.toFixed(2), maxR: +(pos.maxR || 0).toFixed(2), closed: false, virtual: false }; }
  const gross = (px - s.entry) * d;
  const costR = EX.H / (risk / s.entry * 100);
  const netR = s.tp1Hit ? 0.5 * Math.abs(s.tp1 - s.entry) / risk + 0.5 * gross / risk - costR : gross / risk - costR;
  return { price: rp(px), pricePct: +((gross / s.entry) * 100).toFixed(2), netR: +netR.toFixed(2), usdt: +(netR * riskAmt).toFixed(2), maxR: +(s.maxR || 0).toFixed(2), closed: false, virtual: true };
}

function viewSignal(s) {
  const plan = (s.info && s.info.plan) || { entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2 };
  return Object.assign({}, s, {
    pl: sigPL(s),
    ageMs: Date.now() - s.createdAt,
    approvalRemainingMs: s.approvalExpiresAt ? Math.max(0, s.approvalExpiresAt - Date.now()) : 0,
    riskPct: +(Math.abs(s.entry - s.sl) / s.entry * 100).toFixed(2), plan, analysis: s.analysis || analyzeSignal(s)
  });
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
    const open = list.filter(s => isOpenSignal(s));
    const bekleyen = list.filter(s => s.status === 'BEKLE');
    const wins = filled.filter(s => s.netR > 0), losses = filled.filter(s => s.netR <= 0);
    const vWins = virt.filter(s => s.netR > 0);
    const reasons = {}, skipReasons = {};
    for (const s of filled) reasons[s.result] = (reasons[s.result] || 0) + 1;
    for (const s of skipped) skipReasons[s.result] = (skipReasons[s.result] || 0) + 1;
    const netR = +filled.reduce((a, s) => a + num(s.netR), 0).toFixed(3);
    const grossR = +filled.reduce((a, s) => a + num(s.grossR), 0).toFixed(3);
    rows.push({
      module: m, label: MODS[m].label, total: list.length, open: open.length, bekleyen: bekleyen.length,
      filled: filled.length, skipped: skipped.length, unfilled: list.filter(s => s.status === 'KAPALI' && !TRADE_RESULTS.has(s.result) && !SKIP_RESULTS.has(s.result)).length,
      wins: wins.length, losses: losses.length, winRate: filled.length ? +(wins.length / filled.length * 100).toFixed(1) : 0,
      grossR, netR, avgR: filled.length ? +(netR / filled.length).toFixed(3) : null,
      virtual: virt.length, virtualWins: vWins.length, hitRate: virt.length ? +(vWins.length / virt.length * 100).toFixed(1) : 0,
      reasons, skipReasons
    });
  }
  const tot = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, bekleyen: 0, filled: 0, skipped: 0, unfilled: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, avgR: null, virtual: 0, virtualWins: 0, hitRate: 0, reasons: {}, skipReasons: {} };
  for (const r of rows) {
    for (const k of ['total', 'open', 'bekleyen', 'filled', 'skipped', 'unfilled', 'wins', 'losses', 'virtual', 'virtualWins']) tot[k] += r[k];
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

function addShadow(sig, decision, rec) {
  const maxMs = sig.module === 'LT' ? 18 * H1 : sig.module === 'AUTO' ? 20 * M1 : 4 * H1;
  SHADOW.push({ id: sig.id, symbol: sig.symbol, base: sig.base, module: sig.module, dir: sig.dir, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, at: Date.now(), maxMs, decision, rec, histAt: rec && rec.at, done: false });
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
    let rec = s.rec;
    if (!rec && s.histAt) rec = AI_HIST.find(r => r.at === s.histAt && r.base === s.base);
    if (rec) rec.shadowResult = { res, R, at: now };
    appendDecision({ type: 'shadow', sigId: s.id, module: s.module, base: s.base, dir: s.dir, decision: s.decision, res, R });
    dirty = true;
  }
  if (SHADOW.length > 300) { const keep = SHADOW.filter(s => !s.done).concat(SHADOW.filter(s => s.done).slice(-100)); SHADOW.length = 0; keep.forEach(s => SHADOW.push(s)); }
}
function aiAccuracy() {
  const groups = {};
  for (const r of AI_HIST) {
    if (!r.shadowResult || !r.decisionV85) continue;
    const g = groups[r.decisionV85] = groups[r.decisionV85] || { n: 0, sumR: 0, tp1: 0, win: 0 };
    g.n++; g.sumR += r.shadowResult.R; if (r.shadowResult.res === 'TP1') g.tp1++; if (r.shadowResult.R > 0) g.win++;
  }
  const out = {};
  for (const k of Object.keys(groups)) { const g = groups[k]; out[k] = { n: g.n, avgR: +(g.sumR / g.n).toFixed(3), tp1Rate: +(g.tp1 / g.n * 100).toFixed(1), winRate: +(g.win / g.n * 100).toFixed(1) }; }
  return { byDecision: out, note: 'GIR dediklerinin ortalama R değeri GIRME/ZAYIF dediklerinden belirgin yüksek değilse AI değer katmıyor demektir. Örnek sayısı < 30 ise güvenilir değil.' };
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

const BT_JOBS = new Map();
function btStats(arr) {
  const a = arr.filter(v => Number.isFinite(v));
  const wins = a.filter(v => v > 0), losses = a.filter(v => v <= 0);
  const sumR = +a.reduce((s, v) => s + v, 0).toFixed(3);
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  let peak = 0, eq = 0, maxDD = 0;
  for (const v of a) { eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  return {
    n: a.length, sumR, avgR: a.length ? +(sumR / a.length).toFixed(3) : 0,
    winRate: a.length ? +(wins.length / a.length * 100).toFixed(1) : 0,
    pf: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99 : 0), maxDD: +maxDD.toFixed(2)
  };
}
function btStart(body) {
  const id = 'B' + Date.now().toString(36);
  const job = { id, status: 'çalışıyor', progress: 0, result: null, error: null, at: Date.now() };
  BT_JOBS.set(id, job);
  runBacktest(job, body || {}).catch(e => { job.status = 'hata'; job.error = redact(e.message); log('Backtest hatası: ' + e.message); });
  if (BT_JOBS.size > 20) { const k = BT_JOBS.keys().next().value; BT_JOBS.delete(k); }
  return id;
}
async function runBacktest(job, body) {
  const mod = body.module === 'LT' ? 'LT' : 'PUMP';
  const tf = mod === 'LT' ? '2h' : '5m';
  const coins = clamp(num(body.coins, 8), 1, 20);
  const list = scanSyms(mod === 'LT' ? 'LT' : 'PUMP', coins);
  const trades = [];
  for (let ci = 0; ci < list.length; ci++) {
    const sym = list[ci];
    const cs = mod === 'LT' ? await getLong2h(sym, LT_BARS) : await getCandles(sym, tf, 1500, true);
    if (!cs || cs.length < 160) { job.progress = (ci + 1) / list.length; continue; }
    let lastAt = 0;
    const step = mod === 'LT' ? 3 : 2;
    const winLen = mod === 'LT' ? 600 : 180;
    for (let i = (mod === 'LT' ? 200 : 140); i < cs.length - 12; i += step) {
      const win = cs.slice(Math.max(0, i - winLen), i + 1);
      const lastC = win[win.length - 1];
      let raw = null;
      if (mod === 'LT') {
        const tri = analyzeTriangle(win, tf);
        if (tri) raw = ltSignalFrom(sym, win, tf, tri, { price: lastC.c });
      } else {
        const a = scalpAnalyze(sym, win, { price: lastC.c, spread: 0.02, now: lastC.t });
        if (a && a.raw) raw = a.raw;
      }
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
      trades.push({ sym, dir: raw.dir, setup: raw.info.setup || raw.info.shape || 'LT', res: out.res, grossR: +grossR.toFixed(3), netR, at: cs[i].t });
    }
    job.progress = (ci + 1) / list.length;
    await sleep(5);
  }
  job.result = {
    module: mod, label: MODS[mod].label, tf, coins: list.length, trades: trades.length,
    all: btStats(trades.map(t => t.netR)),
    bySetup: Object.fromEntries(Array.from(new Set(trades.map(t => t.setup))).map(k => [k, btStats(trades.filter(t => t.setup === k).map(t => t.netR))])),
    reasons: trades.reduce((a, t) => { a[t.res] = (a[t.res] || 0) + 1; return a; }, {}),
    note: VERSION + ': Backtest matematik sinyallerini kapanmış mumlarda simüle eder; AI ve canlı yürütme yoktur. Net R, tur maliyeti %' + EX.H + ' düşülerek hesaplanır. Kısmi TP1 %50 varsayımı vardır.'
  };
  job.status = 'bitti';
}

/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v86.2 — PARÇA 3/3 (Aşağıdaki mesajda)
   ══════════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v86.2 — PARÇA 3/3
   ══════════════════════════════════════════════════════════════════════════════ */

function liveReady() { return HAS_KEYS && settings.tradeMode === 'live'; }

function friendlyBitgetError(msg) {
  const s = String(msg || '');
  if (/40018|Invalid IP/i.test(s)) {
    const m = s.match(/Current request IP\s*:?\s*([0-9a-fA-F:.]+)/i);
    if (m) LIVE.ipHint = m[1];
    return 'Bitget API anahtarı IP kısıtlamalı. Sunucunun çıkış IP\'si ' + (m ? m[1] : '?') + ' — Bitget → API Yönetimi → anahtar → IP beyaz listesine ekle. ' +
      'Render çıkış IP\'leri bölge bazlı bir aralıktır: Render paneli → servis → Connect → Outbound listesindeki tüm IP\'leri ekle. (/api/myip güncel IP\'yi gösterir)';
  }
  if (/40012|40006|40009|Invalid ApiKey|apikey|ACCESS_KEY|signature/i.test(s)) return 'Bitget API key / secret / passphrase hatalı veya eşleşmiyor: ' + s.slice(0, 160);
  if (/40014|permission/i.test(s)) return 'API anahtarında yetki eksik: Futures okuma + işlem yetkisi gerekli (çekim yetkisi VERME): ' + s.slice(0, 160);
  return s;
}

function liveBalanceView() {
  const b = LIVE.balance;
  if (!b) return { total: 0, free: 0, used: 0, at: 0, error: LIVE.lastError || null, ipHint: LIVE.ipHint };
  return { total: +num(b.total).toFixed(2), free: +num(b.free).toFixed(2), used: +num(b.used).toFixed(2), at: b.at || 0, error: LIVE.lastError || null, ipHint: LIVE.ipHint };
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
  const symbols = Array.from(new Set(LIVE.open.map(p => p.symbol)));
  try {
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
  const list = LIVE.positions || [];
  return list.find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0 && String(p.side || '').toLowerCase() === (dir === 'LONG' ? 'long' : 'short'))
    || list.find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0) || null;
}

async function fastLivePrice(sym, fallback) {
  try { const t = await ex.fetchTicker(sym); const p = num(t && (t.last || t.close)); if (p > 0) return p; } catch (e) { /* tick map */ }
  return priceOf(sym) || fallback || 0;
}

async function placeLiveProtection(sig, pos, d, amount) {
  const closeSide = d === 1 ? 'sell' : 'buy';
  let stopOk = false;
  try {
    const so = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { stopLossPrice: sig.sl, reduceOnly: true });
    pos.stopOrderId = so && so.id;
    stopOk = !!(so && so.id);
  } catch (e) { log('CANLI STOP EMRİ KURULAMADI: ' + sig.base + ' → ' + redact(e.message)); }
  if (!stopOk) {
    try {
      await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { reduceOnly: true });
      log('KORUMASIZ POZİSYON KAPATILDI: ' + sig.base + ' (stop kurulamadı)');
    } catch (e2) { log('!!! ACİL: ' + sig.base + ' stopsuz açık kalmış olabilir, borsadan elle kapat → ' + redact(e2.message)); }
    return false;
  }
  if (sig.tp2) {
    try {
      const to = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { takeProfitPrice: sig.tp2, reduceOnly: true });
      pos.tpOrderId = to && to.id;
    } catch (e) { log('CANLI TP EMRİ KURULAMADI: ' + sig.base + ' → ' + redact(e.message)); }
  }
  return true;
}

async function liveOpen(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (!HAS_KEYS) return { error: 'Bitget API anahtarı yok (.env: BITGET_API_KEY / SECRET / PASSPHRASE)' };
  if (settings.tradeMode !== 'live') return openPaper(sig);
  if (sig.module !== 'AUTO') return { error: 'bu modül işlem açmaz (yalnızca OtoTrade)' };
  if (LIVE.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin canlı açık' };
  if (paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin paper açık' };
  if (sig.module === 'AUTO') { if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks ' + settings.autoMaxOpen + ' işlem' }; }
  else if (LIVE.open.length + paper.open.length >= settings.maxOpen) return { error: 'maks açık işlem' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };

  const px = await fastLivePrice(sig.symbol, sig.entry);
  if (!(px > 0)) return { error: 'canlı fiyat yok' };
  const drift = Math.abs(px / sig.entry - 1) * 100;
  const maxDrift = sig.module === 'AUTO' ? 1.2 : Math.max(0.22, Math.min(0.65, num(sig.info && sig.info.atrPct, 0.5) * 0.35));
  if (drift > maxDrift) { skipSignal(sig, 'AI_STALE', 'canlı fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }

  const bal = await fetchLiveBalance(true);
  if (!(bal.total > 0)) return { error: bal.error || 'Bitget USDT-M bakiyesi 0 veya okunamadı' };
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

  try { await ex.setLeverage(settings.leverage, sig.symbol); }
  catch (e) { log('KALDIRAÇ AYARLANAMADI: ' + sig.base + ' → ' + redact(e.message)); }

  let order;
  try { order = await ex.createOrder(sig.symbol, 'market', d === 1 ? 'buy' : 'sell', amount, undefined, {}); }
  catch (e) {
    LIVE.lastError = friendlyBitgetError(redact(e.message));
    log('CANLI GİRİŞ HATASI: ' + sig.base + ' → ' + LIVE.lastError);
    return { error: LIVE.lastError };
  }
  const fill = rp(num(order && (order.average || order.price), entry));
  const pos = {
    id: 'L' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry: fill, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +Number(amount).toFixed(8), initialQty: +Number(amount).toFixed(8), remainingQty: +Number(amount).toFixed(8),
    notional: +(Number(amount) * fill).toFixed(4), margin: +((Number(amount) * fill) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(Number(amount) * Math.abs(fill - sig.sl)).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxR: 0,
    stallMs: (sig.noMoveSec ? sig.noMoveSec : settings.stallSec) * 1000,
    peakPx: fill, lockStage: 0,
    maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 20 * M1)), setup: (sig.info && sig.info.setup) || null,
    isLive: true, scalp: sig.module === 'PUMP', quickTpPct: null,
    orderId: order && order.id, stopOrderId: null, tpOrderId: null,
    exchangeQty: +Number(amount).toFixed(8), closing: false, aiExitAt: 0
  };

  const prot = await placeLiveProtection(sig, pos, d, amount);
  if (!prot) { skipSignal(sig, 'SKIP', 'stop kurulamadı, pozisyon kapatıldı'); return { error: 'stop kurulamadı, pozisyon kapatıldı' }; }

  sig.entry = fill;
  sig.status = 'AKTIF';
  sig.startedAt = pos.openedAt;
  sig.isLive = true;
  sig.operatorApprovedAt = pos.openedAt;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'canlı emir açıldı', decidedAt: Date.now() });
  LIVE.open.push(pos);
  LIVE.needsSync = true;
  dirty = true;
  saveState(false);
  log('CANLI AÇILDI: ' + sig.base + ' ' + sig.dir + ' | giriş ' + fill + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | miktar ' + amount + ' | risk %' + settings.riskPct);
  fetchLiveBalance(true).catch(() => {});
  return { pos };
}

async function liveClose(pos, price, reason, portion) {
  if (!pos || !pos.isLive) return { error: 'canlı pozisyon değil' };
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
    } catch (e) {
      LIVE.lastError = friendlyBitgetError(redact(e.message));
      log('CANLI KAPATMA HATASI: ' + pos.base + ' → ' + LIVE.lastError);
      return { error: LIVE.lastError };
    }
    if (!(fill > 0)) fill = priceOf(pos.symbol) || pos.entry;
    const partQty = Number(amount);
    pos.grossRealized += (fill - pos.entry) * d * partQty;
    pos.costPaid += partQty * pos.entry * EX.H / 100;
    pos.realized = pos.grossRealized - pos.costPaid;
    pos.remainingQty = +(pos.remainingQty - partQty).toFixed(8);
    const dust = Math.max(1e-9, pos.initialQty * 0.01);
    if (pos.remainingQty > dust) {
      dirty = true;
      log('CANLI KISMİ KAPATMA: ' + pos.base + ' ' + partQty + ' → ' + rp(fill) + ' | kalan ' + pos.remainingQty);
      fetchLiveBalance(true).catch(() => {});
      return { partial: true, exit: rp(fill), remaining: pos.remainingQty };
    }
    const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
    const grossR = +(pos.grossRealized / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    const sig = signals.find(s => s.id === pos.sigId);
    if (sig) {
      sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(fill); sig.closedAt = Date.now();
      sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.isLive = true; sig.analysis = analyzeSignal(sig);
    }
    LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
    const rec = Object.assign({}, pos, { exit: rp(fill), result: reason, pnl: net, netR, grossR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt, closing: false });
    delete rec.remainingQty;
    LIVE.closed.push(rec);
    capArr(LIVE.closed, 200);
    OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, conf: sig ? sig.conf : null, createdAt: sig ? sig.createdAt : pos.openedAt });
    capArr(OUT, 300);
    appendDecision({ type: 'sonuc', sigId: pos.sigId, module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, mode: 'live' });
    LIVE.needsSync = true;
    dirty = true;
    saveState(false);
    log('CANLI KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R (' + net + ' USDT)');
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
  appendDecision({ type: 'sonuc', sigId: pos.sigId, module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, mode: 'live' });
  dirty = true;
  log('CANLI POZİSYON BORSADA KAPANMIŞ: ' + pos.base + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R');
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
        const px = await fastLivePrice(pos.symbol, pos.markPrice || pos.entry);
        finalizeLive(pos, px, 'EXCHANGE');
      }
    }
    LIVE.lastSync = Date.now();
  } finally { LIVE.busy = false; }
}

async function checkOrphans() {
  if (!HAS_KEYS) return;
  const list = await fetchLivePositions();
  if (!list) return;
  const real = list.filter(p => p && Math.abs(num(p.contracts)) > 0);
  const known = new Set(LIVE.open.map(p => p.symbol));
  const orphans = real.filter(p => !known.has(p.symbol));
  if (orphans.length) log('UYARI: Borsada AlphaSon\'un bilmediği ' + orphans.length + ' açık pozisyon var: ' + orphans.map(p => baseOf(p.symbol) + ' ' + p.side).join(', ') + ' (state.json kaybolmuş olabilir; Render\'da kalıcı disk yoksa DATA_DIR her deploy\'da silinir). SL/TP\'yi borsada elle kontrol et.');
}

async function liveMoveStop(pos) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const closeSide = d === 1 ? 'sell' : 'buy';
  let amount;
  try { amount = ex.amountToPrecision(pos.symbol, pos.remainingQty); } catch (e) { amount = pos.remainingQty; }
  if (pos.stopOrderId) { try { await ex.cancelOrder(pos.stopOrderId, pos.symbol, { stop: true }); } catch (e) { /* sessiz */ } }
  if (pos.tpOrderId) { try { await ex.cancelOrder(pos.tpOrderId, pos.symbol, { stop: true }); } catch (e) { /* sessiz */ } }
  pos.stopOrderId = null; pos.tpOrderId = null;
  try {
    const so = await ex.createOrder(pos.symbol, 'market', closeSide, amount, undefined, { stopLossPrice: pos.curSl, reduceOnly: true });
    pos.stopOrderId = so && so.id;
  } catch (e) { log('CANLI STOP TAŞINAMADI: ' + pos.base + ' → ' + redact(e.message) + ' | yazılımsal stop devrede'); }
  if (pos.tp2) {
    try {
      const to = await ex.createOrder(pos.symbol, 'market', closeSide, amount, undefined, { takeProfitPrice: pos.tp2, reduceOnly: true });
      pos.tpOrderId = to && to.id;
    } catch (e) { log('CANLI TP2 YENİDEN KURULAMADI: ' + pos.base + ' → ' + redact(e.message)); }
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
    pos.ageMs = Date.now() - pos.openedAt;
    const unreal = (pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty;
    pos.livePnl = +unreal.toFixed(4);
    pos.livePnlPct = +(unreal / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    pos.peakPx = d === 1 ? Math.max(pos.peakPx || pos.entry, px) : Math.min(pos.peakPx || pos.entry, px);
    pos.maxR = Math.max(pos.maxR || 0, (pos.peakPx - pos.entry) * d / rRisk);

    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { await liveClose(pos, pos.curSl, stopResult(pos, d)); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { await liveClose(pos, pos.tp2, 'TP2'); continue; }
    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const r = await liveClose(pos, pos.tp1, 'TP1', +(pos.initialQty * 0.5).toFixed(8));
      if (r && !r.error) {
        pos.tp1Hit = true;
        pos.curSl = rp(pos.entry);
        const sig = signals.find(s => s.id === pos.sigId);
        if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
        dirty = true;
        log('CANLI TP1: ' + pos.base + ' yarısı alındı, stop girişe çekildi (' + pos.curSl + ')');
        liveMoveStop(pos).catch(() => {});
      }
      continue;
    }
    const ns = lockStopTarget(pos, d);
    if (ns != null) {
      pos.curSl = ns; pos.lockStage = (pos.lockStage || 0) + 1;
      const sig = signals.find(s => s.id === pos.sigId);
      if (sig) sig.curSl = ns;
      dirty = true;
      if (!pos.tp1Hit) { log('CANLI KÂR KİLİDİ: ' + pos.base + ' zirve ' + pos.maxR.toFixed(2) + 'R → stop ' + ns); if (Date.now() - (pos.moveStopAt || 0) > 20e3) { pos.moveStopAt = Date.now(); liveMoveStop(pos).catch(() => {}); } }
    }
    if (pos.ageMs >= pos.maxHoldMs) { await liveClose(pos, px, 'TIME'); continue; }
    const tr = autoExitTrigger(pos, px, d);
    if (tr) mechanicalExit(pos, tr, px);
  }
  LIVE.lastSync = Date.now();
}

function liveSummary() {
  const b = liveBalanceView();
  const cl = LIVE.closed;
  const wins = cl.filter(x => num(x.pnl) > 0).length;
  const losses = cl.filter(x => num(x.pnl) <= 0).length;
  const sumPnl = +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of LIVE.open) { const px = p.livePrice || p.markPrice || priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  return {
    equity: b.total, balance: b.total, free: b.free, used: b.used, start: b.total, dayStart: b.total, dayPnl: sumPnl,
    open: LIVE.open.length, closed: cl.length, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0,
    sumPnl, avgPnl: cl.length ? +(sumPnl / cl.length).toFixed(2) : 0, unrealized: +unrealized.toFixed(2),
    peak: b.total, drawdownPct: 0, mode: 'live', autoTrade: settings.autoTrade, balanceError: b.error || null
  };
}

function viewLivePos(p) {
  const px = p.livePrice || p.markPrice || priceOf(p.symbol) || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +(((p.grossRealized || 0) - (p.costPaid || 0)) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(0.0001, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt, durationMs: Date.now() - p.openedAt });
}

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
  const ageMs = now - last.t;
  const forming = ageMs >= 0 && ageMs < 60e3;
  const candleAge = forming ? Math.max(15, Math.min(60, Math.round(ageMs / 1000))) : 60;
  const expVol = volSma * (forming ? candleAge / 60 : 1);
  return {
    sym, cs, n, last, prev, px, now, atr, atrPct: atr / px * 100, cl, e20, e50,
    rsi: rsiLast(cl, 14), adx: (adxLast(cs, 14) || {}).adx || null,
    volRatio: expVol > 0 ? last.v / expVol : 0, forming, candleAge,
    chg1: (last.c / prev.c - 1) * 100, chg3: (last.c / cs[n - 4].c - 1) * 100, chg5: (last.c / cs[n - 6].c - 1) * 100,
    body: bodyRatio(last), bodyAtr: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr,
    vwap: vwapObj.vwap, vwapSd: vwapObj.sd, hi20, lo20,
    breakUp: last.c > hi20 * 1.0004, breakDn: last.c < lo20 * 0.9996,
    spread: (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym)
  };
}

function makeAutoCandidate(ctx, dir, score, reasons, risks, setup) {
  const d = dir === 'LONG' ? 1 : -1;
  const px = rp(ctx.px);
  const minRiskPct = Math.max(0.35, 1.5 * EX.H + 2 * ctx.spread);
  const riskPct = clamp(Math.max(minRiskPct, ctx.atrPct * 1.05), minRiskPct, 2.20);
  const risk = px * riskPct / 100;
  let sl = px - d * risk;
  const swing = d === 1 ? Math.min.apply(null, ctx.cs.slice(-6).map(c => c.l)) : Math.max.apply(null, ctx.cs.slice(-6).map(c => c.h));
  if (d === 1 ? swing < sl : swing > sl) sl = swing - d * 0.10 * ctx.atr;
  const entry = px;
  const riskFinal = Math.abs(entry - sl);
  if (!(riskFinal > 0)) return null;
  const finalRiskPct = riskFinal / entry * 100;
  if (finalRiskPct < minRiskPct || finalRiskPct > 2.50) return null;

  const minTp1Pct = EX.H + 0.35 * (finalRiskPct + EX.H);
  const minTp2Pct = EX.H + 0.80 * (finalRiskPct + EX.H);
  const tp1Dist = Math.max(0.50 * riskFinal, entry * minTp1Pct / 100, entry * 0.15 / 100);
  const tp2Dist = Math.max(1.25 * riskFinal, entry * minTp2Pct / 100, entry * 0.40 / 100);
  const tp1 = rp(entry + d * tp1Dist);
  const tp2 = rp(entry + d * tp2Dist);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net + 1e-6 < 0.20 || q2.net + 1e-6 < 0.80) return null;

  return {
    module: 'AUTO', symbol: ctx.sym, base: baseOf(ctx.sym), dir, entry, sl: rp(sl), tp1, tp2, single: false,
    conf: clamp(Math.round(score), 45, 95), retest: false, holdSec: 20 * 60, noMoveSec: settings.stallSec,
    info: {
      tf: '1m', source: 'math', setup: setup || 'PUMP', plan: { entry, sl: rp(sl), tp1, tp2 },
      netRR: q1.net, netRR2: q2.net, riskPct: +finalRiskPct.toFixed(2), atrPct: +ctx.atrPct.toFixed(2), volRatio: +ctx.volRatio.toFixed(2),
      bodyRatio: +ctx.body.toFixed(2), bodyAtr: +ctx.bodyAtr.toFixed(2), chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2), chg5: +ctx.chg5.toFixed(2),
      rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
      vwap: rp(ctx.vwap), hi20: rp(ctx.hi20), lo20: rp(ctx.lo20), spreadPct: +ctx.spread.toFixed(3), reasons, risks
    },
    maxAgeMs: 6 * M1, setupKey: 'AUTO|' + ctx.sym + '|' + dir + '|' + Math.floor(ctx.last.t / M1)
  };
}

function autoCandidatesRaw(ctx) {
  const out = [];
  const pump = ctx.chg1 >= 0.65 || ctx.chg3 >= 1.10 || ctx.chg5 >= 1.70;
  const dump = ctx.chg1 <= -0.65 || ctx.chg3 <= -1.10 || ctx.chg5 <= -1.70;
  const volOk = ctx.volRatio >= 1.8;
  const bodyOk = ctx.body >= 0.42 && ctx.bodyAtr >= 0.45;
  const notExhausted = Math.abs(ctx.chg5) <= 7.5;
  if (pump && volOk && bodyOk && notExhausted && (ctx.breakUp || ctx.last.c > (ctx.e20[ctx.n - 1] || ctx.px)) && (!ctx.vwap || ctx.px >= ctx.vwap * 0.999)) {
    const score = 58 + clamp(ctx.volRatio - 1.8, 0, 2) * 8 + clamp(Math.abs(ctx.chg3), 0, 3) * 5 + (ctx.breakUp ? 8 : 0) + (ctx.body >= 0.6 ? 5 : 0);
    const c = makeAutoCandidate(ctx, 'LONG', score,
      ['Pump ivmesi: 1m %' + ctx.chg1.toFixed(2) + ' / 3m %' + ctx.chg3.toFixed(2), 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', ctx.breakUp ? '20 mum tepesi kırıldı' : 'EMA20 üstünde'],
      [ctx.chg5 > 4 ? 'Hareket uzamış' : '', ctx.rsi != null && ctx.rsi > 78 ? 'RSI aşırı' : ''], 'PUMP');
    if (c) out.push(c);
  }
  if (dump && volOk && bodyOk && notExhausted && (ctx.breakDn || ctx.last.c < (ctx.e20[ctx.n - 1] || ctx.px)) && (!ctx.vwap || ctx.px <= ctx.vwap * 1.001)) {
    const score = 58 + clamp(ctx.volRatio - 1.8, 0, 2) * 8 + clamp(Math.abs(ctx.chg3), 0, 3) * 5 + (ctx.breakDn ? 8 : 0) + (ctx.body >= 0.6 ? 5 : 0);
    const c = makeAutoCandidate(ctx, 'SHORT', score,
      ['Dump ivmesi: 1m %' + ctx.chg1.toFixed(2) + ' / 3m %' + ctx.chg3.toFixed(2), 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', ctx.breakDn ? '20 mum dibi kırıldı' : 'EMA20 altında'],
      [ctx.chg5 < -4 ? 'Hareket uzamış' : '', ctx.rsi != null && ctx.rsi < 22 ? 'RSI aşırı' : ''], 'DUMP');
    if (c) out.push(c);
  }
  return out;
}

function moveProgressAtr(ctx, dir) {
  const d = dir === 'LONG' ? 1 : -1;
  const recent = ctx.cs.slice(-11, -1).map(x => x.c);
  const start = d === 1 ? Math.min.apply(null, recent) : Math.max.apply(null, recent);
  return { start, atr: ((ctx.px - start) * d) / ctx.atr };
}

function autoCandidates(ctx) {
  if (!ctx) return [];
  if (ctx.forming && ctx.candleAge < 20) return [];
  const out = [];
  for (const c of autoCandidatesRaw(ctx)) {
    const mp = moveProgressAtr(ctx, c.dir);
    const ap = mp.atr;
    if (ap > 4.0) continue;
    if (ap >= 3.0) {
      const strongVol = ctx.volRatio >= 3.0;
      const strongBody = ctx.bodyAtr >= 0.8 && ctx.body >= 0.55;
      if (!(strongVol && strongBody)) continue;
    } else if (ap >= 2.0) {
      const okVol = ctx.volRatio >= 1.8;
      const okBody = ctx.body >= 0.42 && ctx.bodyAtr >= 0.45;
      if (!(okVol || okBody)) continue;
    }
    c.info.atrProgress = +ap.toFixed(2);
    c.info.forming = !!ctx.forming;
    c.info.candleAgeSec = ctx.candleAge;
    out.push(c);
  }
  return out;
}

function autoAiBudgetOk() {
  const hk = Math.floor(Date.now() / H1);
  if (AUTO_AI.hk !== hk) { AUTO_AI.hk = hk; AUTO_AI.count = 0; }
  return AUTO_AI.count < settings.autoAiPerHour;
}

let autoScanning = false;
async function autoScan(fast) {
  if (autoScanning) return;
  autoScanning = true;
  try {
    const list = fast ? hotSyms('AUTO', 35) : scanSyms('AUTO', 70);
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
      rows.push({
        symbol: sym, base: baseOf(sym), tf: '1m', price: rp(ctx.px), dir: best.dir, setup: best.info.setup,
        state: ctx.forming ? 'MUM İÇİ ADAY' : 'ADAY SİNYAL', score: best.conf,
        chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2), chg5: +ctx.chg5.toFixed(2),
        volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2), bodyRatio: +ctx.body.toFixed(2), bodyAtr: +ctx.bodyAtr.toFixed(2),
        rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null,
        vwap: rp(ctx.vwap), hi20: rp(ctx.hi20), lo20: rp(ctx.lo20), spreadPct: +ctx.spread.toFixed(3), trigger: best.entry,
        sl: best.sl, tp1: best.tp1, tp2: best.tp2, netRR: best.info.netRR, atrProgress: best.info.atrProgress,
        reason: best.info.reasons[0] || '', ai: null
      });
      raws.push(best);
    });
    rows.sort((a, b) => b.score - a.score || Math.abs(b.chg3) - Math.abs(a.chg3));
    if (!fast || rows.length) { AUTO_WATCH = rows.slice(0, 20); WATCH.auto = AUTO_WATCH; }
    WATCH_META.auto = { scannedAt: Date.now(), count: AUTO_WATCH.length, universe: list.length };
    lastScan.auto = Date.now();

    if (settings.autoTrade === true && aiReady() && autoOpenCount() < settings.autoMaxOpen) {
      raws.sort((a, b) => b.conf - a.conf);
      let emitted = 0;
      for (const raw of raws) {
        if (emitted >= 2 || !autoAiBudgetOk()) break;
        const prev = AUTO_FIRED.get(raw.symbol);
        if (prev && Date.now() - prev < 10 * M1) continue;
        const sig = addSignal(raw);
        if (sig) { AUTO_FIRED.set(raw.symbol, Date.now()); AUTO_AI.count++; emitted++; log('OTOTRADE ADAY: ' + sig.base + ' ' + sig.dir + ' | AI giriş kararı bekleniyor'); }
      }
    }
  } catch (e) { log('OtoTrade tarama hatası: ' + redact(e.message)); }
  finally { autoScanning = false; }
}

const AI_CFG = {
  modules: ['AUTO', 'PUMP', 'LT'],
  maxPerDay: 9999, maxPerHour: 9999, briefPerDay: 20,
  moduleDailyLimits: { AUTO: 500, PUMP: 500, LT: 200 },
  timeoutMs: 25000, approvalWindowMs: 10 * M1, gapMs: 1400,
  discoverEveryMs: 24 * H1, discoverModelsPerProvider: 2, discoverMaxWorking: 2,
  marketEveryMs: 15 * M1, marketMaxAgeMs: 40 * M1
};

function aiKeys() { return AI_PROV.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled === true && aiKeys().length > 0); }

function provDay(p) {
  const dk = dayKey();
  if (p.dayKey !== dk) { p.dayKey = dk; p.dayCount = 0; }
  return p;
}

function aiQuota() {
  const now = Date.now();
  const dk = dayKey(now), hk = Math.floor(now / H1);
  if (AI_USAGE.dayKey !== dk) {
    AI_USAGE.dayKey = dk;
    AI_USAGE.dayCount = 0;
    AI_USAGE.moduleDay = { AUTO: 0, PUMP: 0, LT: 0 };
  }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  if (AI_USAGE.briefDay !== dk) { AI_USAGE.briefDay = dk; AI_USAGE.briefCount = 0; }
  if (!AI_USAGE.moduleDay) AI_USAGE.moduleDay = { AUTO: 0, PUMP: 0, LT: 0 };
  const ok = AI_USAGE.dayCount < AI_CFG.maxPerDay && AI_USAGE.hourCount < AI_CFG.maxPerHour;
  return {
    ok, day: dk, hour: hk,
    dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount,
    moduleDay: { ...AI_USAGE.moduleDay },
    leftDay: Math.max(0, AI_CFG.maxPerDay - AI_USAGE.dayCount),
    leftHour: Math.max(0, AI_CFG.maxPerHour - AI_USAGE.hourCount)
  };
}

function aiReserveBudget(module) {
  const q = aiQuota();
  if (!q.ok) {
    const reason = (q.hourCount >= AI_CFG.maxPerHour)
      ? ('saatlik ' + q.hourCount + '/' + AI_CFG.maxPerHour)
      : ('günlük ' + q.dayCount + '/' + AI_CFG.maxPerDay);
    return { ok: false, reason: 'AI bütçesi doldu (' + reason + ')' };
  }
  const isModuleScoped = !!module && AI_CFG.moduleDailyLimits[module] !== undefined;
  if (isModuleScoped && (AI_USAGE.moduleDay[module] || 0) >= AI_CFG.moduleDailyLimits[module]) {
    return { ok: false, reason: module + ' günlük payı doldu (' + AI_USAGE.moduleDay[module] + '/' + AI_CFG.moduleDailyLimits[module] + ')' };
  }
  AI_USAGE.dayCount++;
  AI_USAGE.hourCount++;
  if (isModuleScoped) AI_USAGE.moduleDay[module] = (AI_USAGE.moduleDay[module] || 0) + 1;
  dirty = true;
  saveState(true);
  return { ok: true };
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

function aiProviderView(p) {
  const now = Date.now();
  const lat = (p.lat || []).filter(v => Number.isFinite(v));
  provDay(p);
  return {
    id: p.id, name: p.name, hasKey: !!p.key, models: p.models.slice(), ok: p.ok || 0, fail: p.fail || 0, invalid: p.invalid || 0,
    avgMs: lat.length ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : 0,
    cooldownSec: Math.max(0, Math.ceil(((p.cooldownUntil || 0) - now) / 1000)),
    lastError: p.lastError || null, modelCooldowns: Object.assign({}, p.modelCooldowns || {}),
    prefer: p.prefer || 9, discoverAt: p.discoverAt || 0, dayCount: p.dayCount || 0, dayLimit: p.dayLimit || 0
  };
}

function normTR(s) {
  return String(s == null ? '' : s)
    .replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/Ü/g, 'U').replace(/ü/g, 'u').replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
function extractJSON(text) {
  let raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(raw.slice(a, b + 1)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { return null; }
}
function badReason(r) {
  const s = String(r == null ? '' : r).trim();
  if (s.length < 8 || s.length > 280) return true;
  return /tek kısa cümle|gerçek gerekçe|kendi gözlemin|hareketin ilk ivmesi kaçtıysa|uygun ve hâlâ erken|anahtar açıklama|en fazla \d+ kelime/i.test(s);
}
const toBool = v => (v === true || v === false) ? v : (typeof v === 'string' ? (/^(true|evet|yes)$/i.test(v.trim()) ? true : /^(false|hayir|hayır|no)$/i.test(v.trim()) ? false : null) : null);

const CHECK_SPEC = {
  TREND: { bools: ['trend_intact', 'volume_confirmation', 'reversal_signs'], dec: ['GIR', 'GIRME'] },
  LT:    { bools: ['close_beyond_line', 'volume_pattern', 'htf_aligned', 'fakeout_signs'], dec: ['GIR', 'GIRME'] },
  AUTO:  { bools: ['volume_fading', 'reversal_candle'], wave: true, dec: ['GIR', 'GIRME'] }
};

function parseChecksJSON(text, setup) {
  const spec = CHECK_SPEC[setup];
  const j = extractJSON(text);
  if (!spec || !j) return { parseError: true, decision: 'GIRME', checks: {}, reason: 'AI yanıtı okunamadı' };
  const checks = {};
  for (const k of spec.bools) { const b = toBool(j[k]); if (b === null) return { parseError: true, decision: 'GIRME', checks: {}, reason: 'eksik alan: ' + k }; checks[k] = b; }
  if (spec.wave) {
    const w = normTR(j.wave_stage);
    if (!['BASLANGIC', 'ORTA', 'GEC'].includes(w)) return { parseError: true, decision: 'GIRME', checks: {}, reason: 'wave_stage geçersiz' };
    checks.wave_stage = w;
  }
  let dec = normTR(j.decision || j.karar);
  if (dec === 'GIRILIR') dec = 'GIR';
  if (dec === 'ZAYIF') dec = 'GIRME';
  if (!spec.dec.includes(dec)) return { parseError: true, decision: 'GIRME', checks: {}, reason: 'decision geçersiz: ' + dec };
  const reason = String(j.reason || j.neden || '').trim();
  if (badReason(reason)) return { parseError: true, decision: 'GIRME', checks: {}, reason: 'gerekçe geçersiz (şablon/boş)' };
  return { parseError: false, decision: dec, checks, reason: reason.slice(0, 240) };
}
const checksValidator = setup => text => !parseChecksJSON(text, setup).parseError;

function legacyFields(dec) {
  return {
    verdict: dec === 'GIR' ? 'ONY' : dec === 'BEKLE' ? 'BEKLE' : 'RED',
    score: dec === 'GIR' ? 80 : dec === 'BEKLE' ? 50 : 20,
    trust: dec === 'GIR' ? 'YÜKSEK' : 'ORTA'
  };
}

function parseWatchJSON(text) {
  const j = extractJSON(text);
  if (!j) return null;
  let v = normTR(j.verdict || j.decision || j.karar);
  if (v === 'GIRILIR' || v === 'GIR') v = 'ONY'; else if (v === 'GIRILMEZ' || v === 'GIRME') v = 'RED'; else return null;
  const score = Number(j.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (v === 'ONY' && score < 40) return null;
  const reason = String(j.reason || j.summary || '').trim();
  if (badReason(reason)) return null;
  let trust = normTR(j.trust || '');
  trust = /YUKSEK|HIGH/.test(trust) ? 'YÜKSEK' : /DUSUK|LOW/.test(trust) ? 'DÜŞÜK' : 'ORTA';
  const risks = Array.isArray(j.risks) ? j.risks.map(String).filter(Boolean).slice(0, 3) : [];
  return { verdict: v, score: Math.round(score), trust, reason: reason.slice(0, 240), summary: String(j.summary || reason).slice(0, 400), risks };
}
const watchValidator = text => !!parseWatchJSON(text);

function modelLooksChat(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;
  return !/embed|embedding|whisper|tts|audio|speech|transcribe|moderation|dall-e|gpt-image|image-generation|imagen|veo|realtime|rerank|guard|safety|aqa|clip|sora|stable-diffusion|flux|midjourney|vision-preview|orpheus/.test(s);
}
function modelRank(id) {
  const s = String(id || '').toLowerCase();
  let r = 50;
  if (/gpt-oss-120b|llama-3\.3-70b|70b|120b|deepseek-chat|deepseek-v3|gpt-4o|gpt-4\.1|gemini-(2\.5|3)/.test(s)) r -= 12;
  if (/flash/.test(s)) r -= 6;
  if (/lite|nano|instant|small|allam|gemma|20b|(^|[^0-9])(1|2|3|7|8|9)b\b/.test(s)) r -= 5;
  if (/preview|exp|experimental|alpha|beta/.test(s)) r += 8;
  if (/qwen/.test(s)) r += 3;
  if (/:free$/.test(s)) r += 2;
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
      if (!res.ok) { const er = new Error(redact((j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 240) || ('HTTP ' + res.status))); er.status = res.status; throw er; }
      return ((j && j.models) || [])
        .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, '')).filter(m => m && modelLooksChat(m) && !/embedding|aqa|imagen|veo/.test(m));
    }
    const res = await fetch(p.base + '/models', { signal: ctl.signal, headers: { Authorization: 'Bearer ' + p.key } });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const er = new Error(redact((j && j.error && (j.error.message || j.error.code)) || txt.slice(0, 240) || ('HTTP ' + res.status))); er.status = res.status; throw er; }
    let arr = (j && (j.data || j.models)) || j || [];
    if (!Array.isArray(arr)) arr = [];
    return arr.map(x => String((x && (x.id || x.name)) || '').replace(/^models\//, '')).filter(m => m && modelLooksChat(m));
  } finally { clearTimeout(timer); }
}

const QUALITY_MSGS = [
  { role: 'system', content: 'Yalnızca JSON nesnesi döndür.' },
  { role: 'user', content: 'Şu anahtarlarla bir JSON nesnesi ver: a (true), b (false), c (içinde 7 yazan bir sayı), d ("evet" kelimesi). Başka hiçbir şey yazma.' }
];
function qualityOk(text) { const j = extractJSON(text); return !!(j && j.a === true && j.b === false && Number(j.c) === 7 && String(j.d).toLowerCase() === 'evet'); }

async function discoverProviderModels(p, opts) {
  opts = opts || {};
  if (p.discoverAt && Date.now() - p.discoverAt < AI_CFG.discoverEveryMs && (p.models || []).length) {
    return { id: p.id, name: p.name, hasKey: !!p.key, listed: p.models.length, tested: [], working: p.models.slice(), failed: [], at: Date.now(), error: null, cached: true };
  }
  const maxTest = clamp(Math.round(num(opts.maxTest, AI_CFG.discoverModelsPerProvider)), 1, 40);
  const maxWorking = clamp(Math.round(num(opts.maxWorking, AI_CFG.discoverMaxWorking)), 1, 10);
  const row = { id: p.id, name: p.name, hasKey: !!p.key, listed: 0, tested: [], working: [], failed: [], at: Date.now(), error: null };
  if (!p.key) { row.error = 'anahtar yok'; return row; }

  const avail = aiQuota().leftHour;
  if (avail < 2) { row.error = 'Saatlik AI bütçesi düşük (' + avail + ' slot) — keşif ertelendi'; return row; }
  const effectiveMaxTest = Math.max(1, Math.min(maxTest, avail - 1));

  let listed = [];
  try { listed = await listProviderModels(p); }
  catch (e) { row.error = 'model listesi alınamadı: ' + redact(e.message); listed = (p.models || []).slice(); }
  row.listed = listed.length;
  const old = (p.models || []).slice();
  const cand = [];
  const push = m => { if (m && !cand.includes(m)) cand.push(m); };
  old.forEach(push); listed.forEach(push);
  cand.sort((a, b) => modelRank(a) - modelRank(b));
  const working = [];
  for (const model of cand.slice(0, effectiveMaxTest)) {
    try {
      const r = await callProviderModel(p, QUALITY_MSGS, model, { timeoutMs: num(opts.timeoutMs, 20000), module: null });
      if (!qualityOk(r.text)) { row.tested.push({ model, ok: false, error: 'kalite sınamasını geçemedi' }); row.failed.push(model); continue; }
      working.push(model);
      row.tested.push({ model, ok: true, sample: String(r.text).slice(0, 60) });
      if (working.length >= maxWorking) break;
    } catch (e) {
      row.tested.push({ model, ok: false, error: redact(e.message).slice(0, 160) });
      row.failed.push(model);
      if (e && (e.status === 402 || e.budgetExhausted)) { row.error = 'AI bütçesi doldu — keşif durduruldu (' + e.message + ')'; break; }
    }
  }
  row.working = working;
  if (working.length) {
    p.models = working.concat(old.filter(m => !working.includes(m) && !row.failed.includes(m))).slice(0, 10);
    p.modelCooldowns = {}; p.cooldownUntil = 0; p.nextAt = 0; p.lastError = null; p.discoverAt = Date.now();
    dirty = true;
  } else { p.discoverAt = Date.now(); row.error = row.error || 'çalışan model bulunamadı'; }
  return row;
}

async function discoverAll(opts) {
  opts = opts || {};
  if (AI_DISCOVER.running) return { ok: false, error: 'keşif zaten çalışıyor', at: AI_DISCOVER.at, results: AI_DISCOVER.results };

  const q = aiQuota();
  if (q.leftHour < 2) {
    AI_DISCOVER.error = 'Saatlik AI bütçesi düşük (' + q.hourCount + '/' + AI_CFG.maxPerHour + '). Keşif en az 2 slot ister. Saat başında tekrar deneyin.';
    return { ok: false, error: AI_DISCOVER.error, at: Date.now(), quota: { day: q.dayCount, hour: q.hourCount } };
  }
  if (AI_DISCOVER.at && Date.now() - AI_DISCOVER.at < 5 * M1) {
    AI_DISCOVER.error = 'Keşif 5 dk önce çalıştı. Lütfen bekleyin.';
    return { ok: false, error: AI_DISCOVER.error, at: AI_DISCOVER.at, results: AI_DISCOVER.results };
  }

  AI_DISCOVER.running = true; AI_DISCOVER.error = null;
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  try {
    for (const p of AI_PROV) {
      if (!p.key || (only && !only.has(p.id))) continue;
      if (aiQuota().leftHour < 1) {
        AI_DISCOVER.results[p.id] = { id: p.id, name: p.name, working: [], tested: [], error: 'saatlik bütçe tükendi, keşif atlandı' };
        continue;
      }
      let row;
      try { row = await discoverProviderModels(p, opts); }
      catch (e) { row = { id: p.id, name: p.name, hasKey: true, working: [], tested: [], error: redact(e.message) }; }
      AI_DISCOVER.results[p.id] = row;
      log('AI KEŞİF: ' + p.name + ' → ' + (row.cached ? '(önbellek) ' : '') + (row.working && row.working.length ? row.working.join(', ') : 'çalışan model yok') + (row.error ? ' | ' + row.error : ''));
    }
    AI_DISCOVER.at = Date.now();
    dirty = true; saveState(false);
    return { ok: true, at: AI_DISCOVER.at, results: AI_DISCOVER.results, providers: AI_PROV.map(aiProviderView) };
  } catch (e) {
    AI_DISCOVER.error = redact(e.message);
    return { ok: false, error: AI_DISCOVER.error, results: AI_DISCOVER.results };
  } finally { AI_DISCOVER.running = false; }
}

async function maybeDiscover() {
  return;
}

function aiStatus() {
  const q = aiQuota();
  return {
    enabled: aiReady(), settingsEnabled: settings.aiEnabled === true, watchAuto: settings.aiWatchAuto === true,
    keys: aiKeys().length, providers: AI_PROV.map(aiProviderView),
    usage: {
      dayKey: q.day, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount,
      moduleDay: q.moduleDay, briefCount: AI_USAGE.briefCount,
      lastAt: AI_USAGE.lastAt || 0, lastError: AI_USAGE.lastError || null
    },
    limits: {
      maxPerDay: AI_CFG.maxPerDay, maxPerHour: AI_CFG.maxPerHour, briefPerDay: AI_CFG.briefPerDay,
      moduleDailyLimits: AI_CFG.moduleDailyLimits,
      pumpMinScore: 0, ltMinScore: 0, autoMinScore: 0, autoAiPerHour: settings.autoAiPerHour
    },
    queue: AI_QUEUE.length, busy: AI_STATE.busy === true, lastAt: AI_STATE.lastAt || 0, lastError: AI_STATE.lastError || null,
    brief: marketBrief || null,
    discover: { running: AI_DISCOVER.running === true, at: AI_DISCOVER.at || 0, error: AI_DISCOVER.error || null, results: AI_DISCOVER.results || {} },
    models: Object.fromEntries(AI_PROV.map(p => [p.id, (p.models || []).slice()])), market: marketAI
  };
}

function isModelError(e) {
  const s = String((e && e.message) || '').toLowerCase();
  return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer/.test(s);
}
function isQuotaExhausted(e) {
  const s = String((e && e.message) || '').toLowerCase();
  return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|insufficient balance|credit balance|exceeded.*quota|resource_exhausted/.test(s) || Number(e && e.status) === 402;
}
function isTransientAIError(e) {
  const status = Number(e && e.status) || 0;
  return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e);
}
function quotaWaitMs(e) {
  const m = String((e && e.message) || '').match(/retry in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  let ms = 3 * H1;
  if (m && (m[1] || m[2] || m[3])) ms = ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000;
  if (/insufficient balance/i.test(String((e && e.message) || ''))) ms = 6 * H1;
  return clamp(ms, 10 * M1, 12 * H1);
}
function providerFail(p, e) {
  const status = Number(e && e.status) || 0;
  p.fail = (p.fail || 0) + 1;
  p.lastError = redact((e && e.message) || 'bilinmeyen hata');
  let ms = M1;
  if (e && e.invalid) ms = 30e3;
  else if (isQuotaExhausted(e)) {
    const soon = Math.min.apply(null, (p.models || []).map(m => (p.modelCooldowns && p.modelCooldowns[m]) || 0));
    ms = clamp(soon - Date.now(), 5 * M1, 6 * H1);
  } else if (status === 429) ms = 2 * M1;
  else if (status === 401 || status === 403) ms = 60 * M1;
  else if (status >= 500) ms = 2 * M1;
  else if (isModelError(e)) ms = 10 * M1;
  p.cooldownUntil = Date.now() + ms;
  AI_USAGE.lastError = p.name + ': ' + p.lastError;
  AI_USAGE.lastAt = Date.now();
  AI_STATE.lastError = AI_USAGE.lastError;
  dirty = true;
  logOnce('aierr:' + p.id + ':' + p.lastError.slice(0, 40), 'AI HATA: ' + p.name + ' → ' + p.lastError.slice(0, 220) + ' | ' + Math.ceil(ms / 1000) + ' sn bekleme', 5 * M1);
}

async function callGeminiNative(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs;
  const t0 = Date.now();
  const mod = (opts && opts.module) || null;
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const url = p.nativeBase + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(p.key);
  let res = null, txt = '', j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rsv = aiReserveBudget(mod);
    if (!rsv.ok) { const er = new Error(rsv.reason); er.status = 402; er.budgetExhausted = true; throw er; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), tmo);
    const gc = { temperature: 0.1, maxOutputTokens: 600, responseMimeType: 'application/json' };

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
    er.status = /api key not valid|api_key_invalid|permission|unauthenticated/i.test(String(msg)) ? 401 : /not found|not supported|does not exist|no access/i.test(String(msg)) ? 404 : res.status;
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
  const mod = (opts && opts.module) || null;
  const extras = {};
  if (['groq', 'deepseek', 'openai'].includes(p.id)) extras.response_format = { type: 'json_object' };
  if (p.id === 'groq' && /gpt-oss/.test(model)) extras.reasoning_effort = 'low';
  if (p.id === 'groq' && /qwen3/.test(model)) extras.reasoning_effort = 'none';
  let res = null, txt = '', j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rsv = aiReserveBudget(mod);
    if (!rsv.ok) { const er = new Error(rsv.reason); er.status = 402; er.budgetExhausted = true; throw er; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), tmo);
    try {
      res = await fetch(p.base + '/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
        body: JSON.stringify(Object.assign({ model, messages, temperature: 0.1, max_tokens: 600, stream: false }, attempt === 0 ? extras : {}))
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
          logOnce('invalid:' + p.id + model, 'AI GEÇERSİZ YANIT: ' + p.name + '/' + model + ' → şablon/eksik alan, sonraki model deneniyor', 5 * M1);
          break;
        }
        if (!r.model) r.model = model;
        return r;
      } catch (e) {
        lastErr = e;
        if (e && (e.status === 402 || e.budgetExhausted)) throw e;
        if (isModelError(e)) { if ((p.models || []).length > 1) p.models = p.models.filter(m => m !== model); else p.modelCooldowns[model] = Date.now() + 30 * M1; dirty = true; log('AI MODEL YOK: ' + p.name + '/' + model + ' → listeden çıkarıldı | ' + redact(e.message).slice(0, 100)); break; }
        if (e && e.emptyResp) { p.modelCooldowns[model] = Date.now() + 5 * M1; break; }
        if (isQuotaExhausted(e)) { p.modelCooldowns[model] = Date.now() + quotaWaitMs(e); break; }
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
  let lastErr = null;
  const q0 = aiQuota();
  if (!q0.ok) {
    const reason = (q0.hourCount >= AI_CFG.maxPerHour)
      ? ('saatlik ' + q0.hourCount + '/' + AI_CFG.maxPerHour)
      : ('günlük ' + q0.dayCount + '/' + AI_CFG.maxPerDay);
    throw new Error('AI kotası doldu (' + reason + ')');
  }
  const moduleArg = Object.prototype.hasOwnProperty.call(opts, 'module') ? opts.module : null;
  for (const p of orderedProviders(opts.prefer)) {
    if ((p.cooldownUntil || 0) > Date.now()) continue;
    try {
      const t0 = Date.now();
      const r = await callProvider(p, messages, Object.assign({}, opts, { module: moduleArg }));
      p.ok = (p.ok || 0) + 1;
      provDay(p).dayCount++;
      p.lastAt = Date.now(); p.lastError = null;
      AI_USAGE.lastAt = Date.now(); AI_USAGE.lastError = null;
      AI_STATE.lastAt = Date.now(); AI_STATE.lastError = null;
      dirty = true;
      return { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai', text: String(r.text || '') };
    } catch (e) {
      lastErr = e;
      if (e && (e.status === 402 || e.budgetExhausted)) throw e;
      providerFail(p, e);
    }
  }
  throw lastErr || new Error('AI sağlayıcısı yok (anahtar yok veya hepsi beklemede)');
}

const AI_SYS = 'Sen AlphaSon adlı kripto sinyal kontrolcüsüsün. Sana bir strateji kontrol listesi ve mum verisi verilir. Maddeleri verideki mumlara bakarak tek tek değerlendir. R:R, risk yüzdesi, ATR aralığı, spread ve maliyet KOD TARAFINDAN DOĞRULANDI; bunları değerlendirme, yorumlama, gerekçe yapma. Veride olmayan sayı uydurma. Basit günlük Türkçe kullan. Yalnızca tek bir JSON nesnesi döndür; talimat metnini tekrar etme.';
const AI_SYS_WATCH = 'Sen AlphaSon adlı kripto izleme yardımcısısın. Verilen satıra bakıp kısa görüş verirsin. İşlem emri vermezsin. Veride olmayan sayı uydurma. Basit Türkçe kullan. Yalnızca tek bir JSON nesnesi döndür; talimat metnini tekrar etme.';
const CODE_NOTE = 'NOT: R:R, risk yüzdesi, ATR aralığı, spread ve maliyet kodla doğrulandı. Bunları değerlendirme. Aşağıdaki maddeleri verideki mumlara bakarak cevapla.\n';

function schemaText(setup) {
  const spec = CHECK_SPEC[setup];
  return 'Yanıtı tek bir JSON nesnesi olarak ver. Anahtarlar: ' + spec.bools.map(b => b + ' (true veya false)').join(', ') +
    (spec.wave ? ', wave_stage (BASLANGIC, ORTA veya GEC)' : '') +
    ', decision (yalnızca ' + spec.dec.join(', ') + ' kelimelerinden biri), reason (veriye bakarak kendi gözlemini anlatan en fazla 15 kelimelik Türkçe cümle). Gerçek değerleri yaz, bu açıklamayı tekrar etme.';
}
function planLine(sig) { return 'Plan: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | hedef1 ' + sig.tp1 + (sig.tp2 ? ' | hedef2 ' + sig.tp2 : '') + '\n'; }

/* DEĞİŞEN: scalpFacts — A (closedOnly=true + sig.info'dan geçirme) + B (yeni hesaplamalar) + debug log */
async function scalpFacts(sig) {
const cs = await getCandles(sig.symbol, '15m', 80, true);
  if (!cs || cs.length < 40) return null;
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14) || 1e-9;
  const px = priceOf(sig.symbol) || last.c;
  const d = sig.dir === 'LONG' ? 1 : -1;
  const v20 = avg(cs.slice(-21, -1).map(c => c.v));
  const e20 = emaArr(closesOf(cs), 20);
  const volRatio = (sig.info && Number.isFinite(+sig.info.volRatio)) ? +sig.info.volRatio : +(last.v / (v20 || 1)).toFixed(2);
  const bodyAtrV = (sig.info && Number.isFinite(+sig.info.bodyAtr)) ? +sig.info.bodyAtr : +bodyAtr(last, atr).toFixed(2);
  const recent8 = cs.slice(-8);
  const startE20 = Math.max(0, n - 8);
  let ema20Ustu = 0;
  for (let i = 0; i < recent8.length; i++) {
    const idx = startE20 + i;
    const e = e20[idx];
    if (e == null) continue;
    if ((d === 1 && recent8[i].c > e) || (d === -1 && recent8[i].c < e)) ema20Ustu++;
  }
  let yonVol = 0, tersVol = 0;
  for (const c of recent8) {
    const up = c.c >= c.o;
    if ((d === 1 && up) || (d === -1 && !up)) yonVol += c.v;
    else tersVol += c.v;
  }
  const yonHacimOrani = tersVol > 0 ? +(yonVol / tersVol).toFixed(2) : (yonVol > 0 ? 99 : 0);
  let maxPullback = 0;
  if (d === 1) {
    let peak = recent8[0].c;
    for (const c of recent8) {
      if (c.c > peak) peak = c.c;
      const pb = (peak - c.c) / atr;
      if (pb > maxPullback) maxPullback = pb;
    }
  } else {
    let trough = recent8[0].c;
    for (const c of recent8) {
      if (c.c < trough) trough = c.c;
      const pb = (c.c - trough) / atr;
      if (pb > maxPullback) maxPullback = pb;
    }
  }
  log('SCALP FACTS: ' + sig.base + ' | info.volRatio=' + (sig.info && sig.info.volRatio) + ' | facts.volRatio=' + volRatio + ' | info.bodyAtr=' + (sig.info && sig.info.bodyAtr) + ' | facts.bodyAtr=' + bodyAtrV);
  return {
    cs, px, atr, d,
    volRatio,
    distEma20Atr: +(((px - e20[n - 1]) * d) / atr).toFixed(2),
    trendStrength: +(((e20[n - 1] - e20[n - 5]) * d) / atr).toFixed(2),
    bodyAtr: bodyAtrV,
    bodyRatio: +bodyRatio(last).toFixed(2),
    ema20Ustu,
    yonHacimOrani,
    pullbackAtr: +maxPullback.toFixed(2)
  };
}

/* DEĞİŞEN: promptTrend — Claude'un yeni metni */
function promptTrend(sig, f) {
  return 'TREND TAKİP — ' + sig.base + ' ' + sig.dir + '\n' +
    'Plan: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | hedef1 ' + sig.tp1 + ' | hedef2 ' + sig.tp2 + '\n\n' +
    'NOT: R:R, risk yüzdesi, ATR aralığı, spread ve maliyet kodla doğrulandı. Bunları değerlendirme.\n' +
    'Matematik sinyali bu 5 dakikalık KAPANMIŞ mumda tetiklendi: hacim ' + f.volRatio + 'x, gövde/ATR ' + f.bodyAtr + '.\n' +
    'Fiyat şu an EMA20\'ye ' + f.distEma20Atr + ' ATR uzaklıkta. EMA20 eğimi (son 5 mum) ' + f.trendStrength + ' ATR.\n' +
    'Son 8 mumda EMA20\'nin trend yönündeki tarafında kapanan: ' + f.ema20Ustu + '/8.\n' +
    'Son 8 mumda trend yönlü / ters yönlü hacim oranı: ' + f.yonHacimOrani + '.\n' +
    'Son 8 mumdaki en derin geri çekilme: ' + f.pullbackAtr + ' ATR.\n\n' +
    'Son 8 KAPANMIŞ 5 dakikalık mum (en yeni sonda):\n' + fmtCandles(f.cs, 8) + '\n\n' +
    'Bu bir trend takip girişidir. Geri çekilme sırasında hacmin düşmesi normaldir ve sağlıklıdır; tek başına olumsuz sayma. Küçük fitil ve tek mumluk dalgalanmaları görmezden gel. Yalnızca trendin yapısını bozan belirgin işaretleri say.\n\n' +
    'Maddeler (hepsi evet/hayır):\n' +
    '- trend_intact: Son 8 mumdan en az 5\'i EMA20\'nin trend yönündeki tarafında kapandı ve son kapanış EMA20\'yi trendin tersine geçmedi mi?\n' +
    '- volume_confirmation: Son 8 mumda trend yönündeki mumların toplam hacmi, ters yöndekilerin toplam hacminden büyük mü?\n' +
    '- reversal_signs: Son 3 mumda ters yönde ≥1.0 ATR gövdeli mum, VEYA ortalamanın 1.5 katı hacimle oluşmuş ve aralığın %60\'ından uzun ters fitil, VEYA EMA20\'nin trend tersine kapanış var mı?\n\n' +
    'Karar kuralı:\n' +
    '- GIR: trend_intact true VE reversal_signs false.\n' +
    '- GIRME: trend_intact false veya reversal_signs true.\n' +
    '- volume_confirmation tek başına GIRME sebebi değildir; yalnızca gerekçede kullan.\n\n' +
    'Yanıtı tek bir JSON nesnesi olarak ver. Anahtarlar: trend_intact (true veya false), volume_confirmation (true veya false), reversal_signs (true veya false), decision (yalnızca GIR veya GIRME), reason (veriye bakarak kendi gözlemini anlatan en fazla 15 kelimelik Türkçe cümle). Bu açıklamayı tekrar etme.';
}

async function ltFacts(sig) {
  const i = sig.info || {};
  const cs = await getLong2h(sig.symbol, 160);
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
  return {
    cs, px, atr, d, line, closeBeyond: d === 1 ? last.c > line : last.c < line, beyondAtr: +(((px - line) * d) / atr).toFixed(2),
    wickAgainst: +wickAgainst.toFixed(2), squeezeVolRatio: +(late / (early || 1)).toFixed(2), breakVolRatio: +(last.v / (v20 || 1)).toFixed(2),
    htf4h: htfTrend(aggTF(cs, 2, H2))
  };
}

function autoFacts(sig, cs, ctx) {
  const mp = moveProgressAtr(ctx, sig.dir);
  const age = Math.round((Date.now() - ctx.last.t) / 1000);
  return {
    atrProgress: +mp.atr.toFixed(2), forming: age < 60, candleAgeSec: Math.min(age, 60),
    bodyAtrSeq: cs.slice(-5).map(c => +bodyAtr(c, ctx.atr).toFixed(2)).join(', '),
    volSeq: cs.slice(-4).map(c => Math.round(c.v)).join(' → '), start: rp(mp.start)
  };
}

function promptLT(sig, f) {
  const i = sig.info;
  return 'LT ÜÇGEN — 2 saatlik ' + (i.shape || '') + ' üçgen kırılımı — ' + sig.base + ' ' + sig.dir + '\n' + CODE_NOTE + planLine(sig) +
    'Üçgen: üst çizgi ' + (i.upperNow || i.upper) + ' | alt çizgi ' + (i.lowerNow || i.lower) + ' | genişlik %' + i.widthPct + ' | olgunluk ' + i.maturity + ' | sıkışma ' + i.compression + ' | dokunma ' + i.touches + '\n' +
    'Kod hesapları: son mum kırılım çizgisinin ' + (f.closeBeyond ? 'DIŞINDA kapandı/duruyor' : 'içinde') + ' | çizgiden uzaklık ' + f.beyondAtr + ' ATR | ters yönde fitil oranı ' + f.wickAgainst +
    ' | sıkışma hacmi / önceki dönem ' + f.squeezeVolRatio + 'x | kırılım mumu hacmi ' + f.breakVolRatio + 'x | 4s trend ' + f.htf4h + '\n' +
    'Son 8 kapanmış 2 saatlik mum:\n' + fmtCandles(f.cs, 8) + '\n\n' +
    'Maddeler:\n- close_beyond_line: kırılım mumu çizginin dışında kapandı mı (canlıysa gövde çizgiyi geçti mi)?\n- volume_pattern: hacim sıkışmada azaldı, kırılımda arttı mı?\n- htf_aligned: 4s trend kırılım yönüyle uyumlu mu?\n- fakeout_signs: uzun ters fitil veya hemen geri dönüş var mı?\n' + schemaText('LT');
}
function promptAutoEntry(sig, ctx, f, cs) {
  return 'OTOTRADE GİRİŞ KARARI — ' + sig.base + ' ' + sig.dir + ' (pump/dump hızlı scalp)\n' + CODE_NOTE + planLine(sig) +
    'Kod hesapları: hareketin başından beri ' + f.atrProgress + ' ATR ilerledi (başlangıç ' + f.start + ') | son mum ' + (f.forming ? 'HENÜZ KAPANMADI, yaşı ' + f.candleAgeSec + ' sn' : 'kapandı') +
    ' | son 5 mum gövde/ATR: ' + f.bodyAtrSeq + ' | son 4 mum hacim: ' + f.volSeq + ' | hacim oranı ' + ctx.volRatio.toFixed(1) + 'x | 1m %' + ctx.chg1.toFixed(2) + ' 3m %' + ctx.chg3.toFixed(2) + ' 5m %' + ctx.chg5.toFixed(2) +
    ' | RSI ' + (ctx.rsi != null ? Math.round(ctx.rsi) : '?') + ' | VWAP ' + (ctx.vwap ? rp(ctx.vwap) : '?') + ' | 20 mum tepe ' + rp(ctx.hi20) + ' dip ' + rp(ctx.lo20) + '\n' +
    'Piyasa yönü (matematik, 15m): ' + market.dir + '\n' +
    'Son 1 dakikalık mumlar (en yeni sonda):\n' + fmtCandles(cs, 14) + '\n\n' +
    'Maddeler:\n- wave_stage: hareket BASLANGIC (1. dalga) mı, ORTA mı, GEC (2-3. dalga / uzamış) mı?\n- volume_fading: son 2 mumda hacim sönüyor mu?\n- reversal_candle: ters yönde sert mum veya uzun ters fitil var mı?\n' +
    'Karar tamamen senin: giriş zamanlaması uygunsa GIR, ilk ivme kaçtıysa / hareket uzadıysa / hacim söndüyse / fiyat ters döndüyse GIRME de. Piyasa yönü yalnızca bilgidir; ters yönde de girebilirsin ama gerekçeni veriyle ver.\n' + schemaText('AUTO');
}

async function buildSetupPrompt(sig) {
  if (sig.module === 'LT') { const f = await ltFacts(sig); return f ? { setup: 'LT', prompt: promptLT(sig, f), facts: f } : null; }
  const f = await scalpFacts(sig);
  if (!f) return null;
  return { setup: 'TREND', prompt: promptTrend(sig, f), facts: f };
}

function aiFallback(sig, state, note) {
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state, note, decidedAt: Date.now() });
  if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
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
  if (!q.ok) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI kotası doldu', at: Date.now() }); return aiFallback(sig, 'OFFLINE', 'AI kotası doldu — matematik kararı'); }

  let built = null;
  try { built = await buildSetupPrompt(sig); } catch (e) { built = null; }
  if (!built) return aiFallback(sig, 'OFFLINE', 'Veri alınamadı — matematik kararı');

  let ai;
  try {
    ai = await callAI([{ role: 'system', content: AI_SYS }, { role: 'user', content: built.prompt }],
      { prefer: 'gemini', timeoutMs: AI_CFG.timeoutMs, validate: checksValidator(built.setup), module: sig.module });
  } catch (e) {
    sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI yanıt vermedi: ' + redact(e.message), at: Date.now() });
    AI_STATE.lastError = redact(e.message);
    log('AI YANIT YOK: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + redact(e.message).slice(0, 160) + ' | matematik kararı');
    return aiFallback(sig, 'OFFLINE', 'AI yanıtı yok — matematik kararı');
  }

  const p = parseChecksJSON(ai.text, built.setup);
  const decision = p.decision;
  const view = Object.assign({}, ai, legacyFields(decision), { decisionV85: decision, aiSaid: p.decision, checks: p.checks, reason: p.reason, summary: p.reason, setupPrompt: built.setup });
  sig.ai = view;
  const rec = {
    at: ai.at, kind: 'Sinyal', module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir, setup: built.setup,
    provider: ai.providerName, model: ai.model, decision: decision === 'GIR' ? 'CANDIDATE' : decision === 'BEKLE' ? 'WAIT' : 'REJECT',
    decisionV85: decision, phase: 'SİNYAL', score: view.score, dataQuality: 'TAM', disagree: false, verdict: view.verdict, trust: view.trust,
    reason: p.reason, checks: p.checks, latencyMs: ai.latencyMs
  };
  AI_HIST.push(rec); capArr(AI_HIST, 600);
  countCheckStats(built.setup, p.checks, decision);
  addShadow(sig, decision, rec);
  appendDecision({ type: 'karar', sigId: sig.id, module: sig.module, base: sig.base, dir: sig.dir, setup: built.setup, conf: sig.conf, checks: p.checks, aiSaid: p.decision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });

  if (sig.module === 'PUMP') {
    if (decision === 'GIR') {
      sig.aiGate = { state: 'APPROVED', note: 'AI GİR — ' + (p.reason || ''), decidedAt: Date.now(), provider: ai.provider };
      sig.status = 'AKTIF';
      sig.startedAt = Date.now();
      log('AI GİR: PUMP ' + sig.base + ' ' + sig.dir + ' (' + built.setup + ') → AKTİF');
    } else {
      sig.aiGate = { state: 'AI_RED', note: 'AI GİRME — ' + (p.reason || ''), decidedAt: Date.now(), provider: ai.provider };
      sig.status = 'KAPALI';
      sig.result = 'AI_RED';
      sig.closedAt = Date.now();
      log('AI GİRME: PUMP ' + sig.base + ' ' + sig.dir + ' (' + built.setup + ') → REDDEDİLDİ');
    }
    sig.analysis = analyzeSignal(sig);
    dirty = true;
    return view;
  }

  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'COMMENT', note: 'AI yorumu: ' + (decision === 'GIR' ? 'GİR' : 'GİRME') + (p.reason ? ' — ' + p.reason : ''), decidedAt: Date.now(), provider: ai.provider });
  sig.analysis = analyzeSignal(sig);
  dirty = true;
  log('AI YORUM: ' + MODS[sig.module].label + ' ' + sig.base + ' (' + built.setup + ') → ' + decision + ' (' + ai.providerName + '/' + ai.model + ', ' + ai.latencyMs + 'ms)');
  return view;
}

function aiCommentBudgetOk(consume) {
  const hk = Math.floor(Date.now() / H1);
  if (AI_COMMENT.hk !== hk) { AI_COMMENT.hk = hk; AI_COMMENT.count = 0; }
  if (AI_COMMENT.count >= settings.aiCommentPerHour) return false;
  if (consume) AI_COMMENT.count++;
  return true;
}

/* DEĞİŞEN: queueAI — D-2 limbo fix (bütçe dolunca status AKTIF'e çekilir) */
function queueAI(sig, opts) {
  if (!sig || !AI_CFG.modules.includes(sig.module) || !aiReady()) return;
  if (sig.module === 'AUTO' && settings.autoTrade !== true) return;
  if (AI_QUEUE.some(x => x.id === sig.id)) return;
  const q = aiQuota();
  if (!q.ok) {
    sig.aiGate = Object.assign({}, sig.aiGate || {}, {
      state: 'OFFLINE',
      note: 'AI kotası doldu (gün ' + q.dayCount + '/' + AI_CFG.maxPerDay + ', saat ' + q.hourCount + '/' + AI_CFG.maxPerHour + ') — yorumsuz',
      decidedAt: Date.now()
    });
    if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
    dirty = true;
    return;
  }
  if (sig.module !== 'AUTO' && !(opts && opts.force) && !aiCommentBudgetOk(true)) {
    sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'MATH_ONLY', note: 'AI yorum bütçesi (saatlik) doldu — yorumsuz', decidedAt: Date.now() });
    if (sig.status === 'AI_BEKLIYOR') sig.status = 'AKTIF';
    dirty = true;
    return;
  }
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
      try { await aiReview(sig, { force: job.force }); } catch (e) { log('AI KUYRUK HATASI: ' + redact(e.message)); }
    }
  } finally { AI_STATE.busy = false; }
}

async function autoEntryReview(sig) {
  if (!sig || sig.status === 'KAPALI') return null;
  if (!aiReady()) { skipSignal(sig, 'AI_ERROR', 'OtoTrade için AI kapalı'); return null; }
  if (settings.autoTrade !== true) { skipSignal(sig, 'SKIP', 'OtoTrade kapalı'); return null; }
  if (autoOpenCount() >= settings.autoMaxOpen) { skipSignal(sig, 'SKIP', 'OtoTrade maks işlem dolu'); return null; }

  let ctx = null, cs = null;
  try { cs = await getCandles(sig.symbol, '1m', 60, false); ctx = autoContext(sig.symbol, cs, { price: priceOf(sig.symbol) || sig.entry }); } catch (e) { /* veri yok */ }
  if (!ctx) { skipSignal(sig, 'AI_ERROR', 'OtoTrade verisi yok'); return null; }
  const f = autoFacts(sig, cs, ctx);
  if (f.atrProgress > 4.0) { skipSignal(sig, 'SKIP', 'hareket aşırı uzamış (' + f.atrProgress + ' ATR) — AI\'ya sorulmadı'); return null; }

  let ai;
  try {
    ai = await callAI([{ role: 'system', content: AI_SYS }, { role: 'user', content: promptAutoEntry(sig, ctx, f, cs) }],
      { prefer: 'gemini', timeoutMs: 15000, fast: true, validate: checksValidator('AUTO'), module: 'AUTO' });
  } catch (e) {
    skipSignal(sig, 'AI_ERROR', 'OtoTrade AI yanıtı yok');
    log('OTOTRADE AI HATASI: ' + sig.base + ' → ' + redact(e.message).slice(0, 160));
    return null;
  }
  const p = parseChecksJSON(ai.text, 'AUTO');
  const decision = p.decision;
  const aiView = Object.assign({}, ai, legacyFields(decision === 'GIR' ? 'GIR' : 'GIRME'), { decisionV85: decision, aiSaid: p.decision, checks: Object.assign({ atr_progress: f.atrProgress }, p.checks), reason: p.reason, summary: p.reason });
  sig.ai = aiView;
  const rec = {
    at: Date.now(), kind: 'OtoTrade Giriş', module: 'AUTO', symbol: sig.symbol, base: sig.base, dir: sig.dir, setup: 'AUTO',
    provider: ai.providerName, model: ai.model, decision: decision === 'GIR' ? 'CANDIDATE' : 'REJECT', decisionV85: decision,
    phase: 'GİRİŞ', score: aiView.score, dataQuality: 'TAM', disagree: false, verdict: aiView.verdict, trust: aiView.trust,
    reason: p.reason, checks: aiView.checks, latencyMs: ai.latencyMs
  };
  AI_HIST.push(rec); capArr(AI_HIST, 600);
  countCheckStats('AUTO', p.checks, decision);
  addShadow(sig, decision, rec);
  appendDecision({ type: 'karar', sigId: sig.id, module: 'AUTO', base: sig.base, dir: sig.dir, setup: sig.info && sig.info.setup, conf: sig.conf, checks: aiView.checks, aiSaid: p.decision, decision, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, reason: p.reason });

  if (decision !== 'GIR') {
    skipSignal(sig, 'SKIP', 'AI ' + decision + (p.reason ? ': ' + p.reason : ''));
    log('OTOTRADE AI ' + decision + ': ' + sig.base + ' ' + sig.dir + ' | ' + (p.reason || ''));
    return aiView;
  }
  const px = rp(ctx.px);
  const d = sig.dir === 'LONG' ? 1 : -1;
  const sl = sig.sl;
  const riskPct = Math.abs(px - sl) / px * 100;
  const minRiskPct = Math.max(0.35, 1.5 * EX.H + 2 * ctx.spread);
  if (!(riskPct >= minRiskPct && riskPct <= 2.50)) { skipSignal(sig, 'SKIP', 'stop planı geçersiz (risk %' + riskPct.toFixed(2) + ')'); return aiView; }
  const risk = Math.abs(px - sl);
  const minTp1Pct = EX.H + 0.35 * (riskPct + EX.H);
  const minTp2Pct = EX.H + 0.80 * (riskPct + EX.H);
  const tp1Dist = Math.max(0.50 * risk, px * minTp1Pct / 100, px * 0.15 / 100);
  const tp2Dist = Math.max(1.25 * risk, px * minTp2Pct / 100, px * 0.40 / 100);
  const tp1 = px + d * tp1Dist;
  const tp2 = px + d * tp2Dist;
  const q1 = rrNet(px, sl, tp1), q2 = rrNet(px, sl, tp2);
  if (q1.net + 1e-6 < 0.20 || q2.net + 1e-6 < 0.80) { skipSignal(sig, 'SKIP', 'net R:R yetersiz (' + q1.net + ')'); return aiView; }
  sig.entry = px; sig.sl = rp(sl); sig.curSl = rp(sl); sig.tp1 = rp(tp1); sig.tp2 = rp(tp2);
  sig.info = Object.assign({}, sig.info, {
    plan: { entry: px, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) }, aiEntry: true, aiReason: p.reason,
    netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2), atrProgress: f.atrProgress, forming: f.forming, candleAgeSec: f.candleAgeSec
  });
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'AI GİR: ' + p.reason, decidedAt: Date.now(), provider: ai.provider });
  sig.status = 'AKTIF'; sig.startedAt = Date.now(); dirty = true;

  const r = await openTrade(sig);
  if (!r || r.error) {
    sig.status = 'AI_BEKLIYOR';
    skipSignal(sig, 'SKIP', 'OtoTrade açılamadı: ' + ((r && r.error) || 'bilinmeyen'));
    return aiView;
  }
  sig.status = 'AKTIF';
  log('OTOTRADE GİRİŞ: ' + sig.base + ' ' + sig.dir + ' | ' + f.atrProgress + ' ATR | giriş ' + px + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | ' + (settings.tradeMode === 'live' ? 'CANLI' : 'PAPER'));
  return aiView;
}

function parseAutoExit(text) {
  const j = extractJSON(text);
  if (!j) return null;
  const a = normTR(j.action || j.karar);
  const action = /^(TUT|HOLD)$/.test(a) ? 'HOLD' : /^(KAPAT|CLOSE)$/.test(a) ? 'CLOSE' : null;
  const reason = String(j.reason || '').trim();
  if (!action || badReason(reason)) return null;
  return { action, reason: reason.slice(0, 240) };
}

async function askAutoExit(pos, trigger, px) {
  const cs = await getCandles(pos.symbol, '1m', 30, false);
  const d = pos.dir === 'LONG' ? 1 : -1;
  const rNow = (px - pos.entry) * d / Math.max(1e-9, Math.abs(pos.entry - pos.sl));
  const prompt = 'OTOTRADE ÇIKIŞ KONTROLÜ — ' + pos.base + ' ' + pos.dir + ' (' + (pos.isLive ? 'CANLI' : 'PAPER') + ')\n' +
    'Tetikleyici: ' + trigger + '\n' +
    'Giriş ' + pos.entry + ' | Şu an ' + rp(px) + ' | K/Z ' + rNow.toFixed(2) + 'R | zirve ' + (pos.maxR || 0).toFixed(2) + 'R | SL ' + pos.curSl + ' | TP1 ' + pos.tp1 + ' | TP2 ' + (pos.tp2 || '-') + ' | TP1 alındı: ' + (pos.tp1Hit ? 'EVET (stop girişte)' : 'HAYIR') + '\n' +
    'Son 1 dakikalık mumlar (en yeni sonda):\n' + fmtCandles(cs, 12) + '\n\n' +
    'Soru: pozisyonda beklemenin anlamı var mı? İvme bittiyse veya ters döndüyse KAPAT, yön hâlâ lehineyse ve geri çekilme sağlıklıysa TUT.\n' +
    'Yanıtı tek bir JSON nesnesi olarak ver. Anahtarlar: action (yalnızca TUT veya KAPAT kelimelerinden biri), reason (veriye bakarak kendi gözlemini anlatan en fazla 15 kelimelik Türkçe cümle). Bu açıklamayı tekrar etme.';
  const ai = await callAI([{ role: 'system', content: AI_SYS }, { role: 'user', content: prompt }], { prefer: 'gemini', timeoutMs: 6000, fast: true, validate: t => !!parseAutoExit(t), module: 'AUTO' });
  const dec = parseAutoExit(ai.text);
  if (dec) AI_HIST.push({ at: Date.now(), kind: 'OtoTrade Çıkış', module: 'AUTO', symbol: pos.symbol, base: pos.base, dir: pos.dir, provider: ai.providerName, model: ai.model, decision: dec.action === 'CLOSE' ? 'REJECT' : 'CANDIDATE', phase: 'ÇIKIŞ (' + trigger + ')', score: null, dataQuality: 'TAM', disagree: false, verdict: dec.action === 'CLOSE' ? 'RED' : 'ONY', trust: 'ORTA', reason: dec.reason, latencyMs: ai.latencyMs });
  capArr(AI_HIST, 600);
  return dec;
}

async function requestAutoExit(pos, trigger, px) {
  if (pos.exitBusy || pos.closing) return;
  if (Date.now() - (pos.aiExitAt || 0) < 30e3) return;
  pos.exitBusy = true;
  try {
    const mechanical = new Set(['MOMENTUM', 'REVERSAL', 'STALL', 'MOMENTUM_FADE']);
    let dec = null;
    if (!mechanical.has(trigger) && aiReady()) {
      try { dec = await askAutoExit(pos, trigger, px); } catch (e) { dec = null; }
    }
    pos.aiExitAt = Date.now();
    if (dec && dec.action === 'HOLD' && !mechanical.has(trigger)) {
      pos.aiExit = 'HOLD'; pos.aiExitReason = dec.reason;
      log('OTOTRADE AI TUT: ' + pos.base + ' (' + trigger + ') | ' + dec.reason);
      return;
    }
    const result = trigger === 'STALL' ? 'STALL' : trigger === 'REVERSAL' ? 'REVERSAL' : (trigger === 'MOMENTUM' || trigger === 'MOMENTUM_FADE') ? 'MOMENTUM' : 'AI_EXIT';
    const cur = pos.isLive ? (pos.livePrice || px) : (priceOf(pos.symbol) || px);
    if (pos.isLive) { if (LIVE.open.includes(pos)) await liveClose(pos, cur, result); }
    else if (paper.open.includes(pos)) closePaper(pos, cur, result);
    log('OTOTRADE ÇIKIŞ (' + trigger + '): ' + pos.base + ' → ' + (RES[result] || result) + (dec ? ' | AI: ' + dec.reason : ' | AI yanıtsız, kod kapattı'));
  } finally { pos.exitBusy = false; }
}

function aiWatchPrompt(kind, row) {
  const tail = '\nYanıtı tek bir JSON nesnesi olarak ver. Anahtarlar: verdict (yalnızca GIRILIR veya GIRILMEZ), score (0-100 arası tam sayı; GIRILIR ise en az 50), trust (YUKSEK, ORTA veya DUSUK), reason (veriye bakarak kendi gözlemini anlatan en fazla 15 kelimelik Türkçe cümle). Bu açıklamayı tekrar etme.';
  if (kind === 'lt') {
    return 'LT Üçgen izleme satırı: ' + row.base + ' (' + (row.shape || '') + ') | fiyat ' + row.price + ' | üst çizgi ' + row.upper + ' | alt çizgi ' + row.lower +
      ' | üst mesafe %' + row.distUpperPct + ' | alt mesafe %' + row.distLowerPct + ' | genişlik %' + row.widthPct +
      ' | olgunluk ' + row.maturity + ' | sıkışma ' + row.compression + ' | dokunma ' + row.touches + ' | durum ' + row.status + '\n' +
      'Soru: kırılım yakın mı ve kırılım yönü/zamanlaması anlamlı mı?' + tail;
  }
  return 'Günlük Hızlı Scalp — TREND TAKİP izleme satırı: ' + row.base + ' | yön ' + row.dir + ' | fiyat ' + row.price +
    ' | hacim ' + row.volRatio + 'x | ATR% ' + row.atrPct + ' | RSI ' + row.rsi + ' | ADX ' + row.adx + ' | VWAP ' + row.vwap + ' | durum ' + row.status + '\nSoru: trend devam ediyor mu, dönüş sinyali var mı?' + tail;
}

async function watchAI(kind, base, force) {
  if (!aiReady()) return { error: settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok' };
  const q = aiQuota();
  if (!q.ok) {
    const reason = (q.hourCount >= AI_CFG.maxPerHour)
      ? ('saatlik ' + q.hourCount + '/' + AI_CFG.maxPerHour)
      : ('günlük ' + q.dayCount + '/' + AI_CFG.maxPerDay);
    return { error: 'AI kotası doldu (' + reason + ')' };
  }
  const rows = kind === 'lt' ? WATCH.lt : SCALP_WATCH;
  const row = rows.find(r => String(r.base).toUpperCase() === String(base).toUpperCase());
  if (!row) return { error: 'coin izleme listesinde yok' };
  if (!force && row.ai && row.ai.at && Date.now() - row.ai.at < 30 * M1) return { ok: true, ai: row.ai, cached: true };
  try {
    const r = await callAI([{ role: 'system', content: AI_SYS_WATCH }, { role: 'user', content: aiWatchPrompt(kind, row) }],
      { prefer: kind === 'lt' ? 'groq' : undefined, timeoutMs: AI_CFG.timeoutMs, validate: watchValidator, module: kind === 'lt' ? 'LT' : 'PUMP' });
    const w = parseWatchJSON(r.text);
    const view = {
      verdict: w.verdict, label: w.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ', verdictLabel: w.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ',
      score: w.score, trust: w.trust, reason: w.reason, summary: w.summary, risks: w.risks, provider: r.providerName, model: r.model, at: r.at,
      ev: { decision: w.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: 'WATCH', score: w.score, confidence: w.trust === 'YÜKSEK' ? 'HIGH' : w.trust === 'DÜŞÜK' ? 'LOW' : 'MEDIUM', summary: w.summary || w.reason || '', dataQuality: 'GOOD' }
    };
    row.ai = view;
    if (kind === 'lt') { const e = LT_CACHE.get(row.symbol); if (e) e.ai = view; }
    AI_HIST.push({ at: r.at, kind: kind === 'lt' ? 'LT İzleme' : 'Scalp İzleme', module: kind === 'lt' ? 'LT' : 'PUMP', symbol: row.symbol, base: row.base, dir: row.dir || row.dirHint, provider: r.providerName, model: r.model, decision: w.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: row.status || 'İZLEME', score: w.score, dataQuality: 'TAM', disagree: false, verdict: w.verdict, trust: w.trust, reason: w.reason, latencyMs: r.latencyMs });
    capArr(AI_HIST, 600);
    dirty = true;
    log('İZLEME AI: ' + (kind === 'lt' ? 'LT' : 'SCALP') + ' ' + row.base + ' → ' + view.label + ' (' + w.score + ')');
    return { ok: true, ai: view };
  } catch (e) {
    log('İZLEME AI HATASI: ' + row.base + ' → ' + redact(e.message).slice(0, 160));
    return { error: redact(e.message) };
  }
}

async function maybeWatchAI() {
  if (!aiReady() || settings.aiWatchAuto !== true || AI_STATE.busy) return;
  const q = aiQuota();
  if (!q.ok || q.leftHour < 1) return;
  const lt = WATCH.lt.find(r => !r.ai && r.nearPct < 1.5);
  if (lt) await watchAI('lt', lt.base);
  const sc = SCALP_WATCH.find(r => !r.ai && r.status === 'TETİK');
  if (sc) await watchAI('scalp', sc.base);
}

async function aiMarketBrief(force) {
  if (!aiReady()) return { error: 'AI kapalı' };
  if (!aiQuota().ok) return { error: 'AI kotası doldu' };
  if (AI_USAGE.briefCount >= AI_CFG.briefPerDay && !force) return marketBrief || { error: 'günlük brifing limiti doldu' };
  let ctx = '';
  try {
    const btc1 = await getCandles('BTC/USDT:USDT', '1h', 48, true);
    const eth1 = await getCandles('ETH/USDT:USDT', '1h', 48, true);
    const fmt = cs => (cs || []).slice(-12).map(c => new Date(c.t).toISOString().slice(11, 16) + ' C' + c.c).join('\n');
    const movers = UNIVERSE.slice(0, 40).map(s => ({ base: baseOf(s), chg: tick(s) ? tick(s).chg : null })).filter(x => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8);
    ctx = JSON.stringify({ market, btc1h: fmt(btc1), eth1h: fmt(eth1), movers }, null, 1);
  } catch (e) { return { error: 'veri alınamadı: ' + redact(e.message) }; }
  try {
    const r = await callAI([{ role: 'system', content: AI_SYS_WATCH }, { role: 'user', content: ctx + '\n\nGenel piyasa için kısa brifing ver.\nYanıtı tek bir JSON nesnesi olarak ver. Anahtarlar: verdict (yalnızca GIRILIR veya GIRILMEZ), score (0-100 arası tam sayı), reason (en fazla 20 kelimelik Türkçe özet), risks (en fazla 2 kısa risk içeren liste). Bu açıklamayı tekrar etme.' }],
      { prefer: 'groq', timeoutMs: AI_CFG.timeoutMs, validate: watchValidator, module: null });
    const w = parseWatchJSON(r.text);
    AI_USAGE.briefCount++;
    marketBrief = Object.assign({}, w, { provider: r.provider, providerName: r.providerName, model: r.model, at: r.at });
    dirty = true;
    log('AI BRİFİNG: ' + (w.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ') + ' ' + w.score + '/100 (' + r.providerName + ')');
    return marketBrief;
  } catch (e) { return { error: redact(e.message) }; }
}

async function updateMarketAI() { return marketAI; }

function closeVirtual(sig, exitPx, result) {
  const d = sig.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0)) return;
  const riskPct = risk / sig.entry * 100;
  const grossR = sig.tp1Hit ? 0.5 * Math.abs(sig.tp1 - sig.entry) / risk + 0.5 * ((exitPx - sig.entry) * d / risk) : (exitPx - sig.entry) * d / risk;
  const netR = +(grossR - EX.H / riskPct).toFixed(3);
  sig.status = 'KAPALI'; sig.result = result; sig.exit = rp(exitPx); sig.closedAt = Date.now();
  sig.grossR = +grossR.toFixed(3); sig.netR = netR;
  sig.pnlUsdt = +(netR * paper.equity * settings.riskPct / 100).toFixed(2);
  sig.analysis = analyzeSignal(sig);
  OUT.push({ t: Date.now(), module: sig.module, base: sig.base, dir: sig.dir, result, netR, pnl: sig.pnlUsdt, setup: (sig.info && (sig.info.setup || sig.info.shape)) || sig.module, conf: sig.conf, createdAt: sig.createdAt });
  capArr(OUT, 300);
  appendDecision({ type: 'sonuc', sigId: sig.id, module: sig.module, base: sig.base, dir: sig.dir, result, netR, pnl: sig.pnlUsdt, mode: 'sanal' });
  dirty = true;
  log(MODS[sig.module].label + ' SANAL KAPANDI: ' + sig.base + ' ' + sig.dir + ' → ' + (RES[result] || result) + ' | net ' + netR + 'R (~' + sig.pnlUsdt + ' USDT)');
}

function monitorVirtual() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status !== 'AKTIF' || sig.tradeable !== false) continue;
    const px = priceOf(sig.symbol);
    if (!(px > 0)) continue;
    const d = sig.dir === 'LONG' ? 1 : -1;
    const risk = Math.max(1e-9, Math.abs(sig.entry - sig.sl));
    sig.maxR = Math.max(sig.maxR || 0, (px - sig.entry) * d / risk);
    if (now - sig.createdAt > (sig.maxAgeMs || MODS[sig.module].maxAge)) { closeVirtual(sig, px, 'TIME'); continue; }
    if (sig.tp2 && (d === 1 ? px >= sig.tp2 : px <= sig.tp2)) { closeVirtual(sig, sig.tp2, 'TP2'); continue; }
    if (d === 1 ? px <= sig.curSl : px >= sig.curSl) { closeVirtual(sig, sig.curSl, sig.tp1Hit ? 'BE' : 'SL'); continue; }
    if (!sig.tp1Hit && (d === 1 ? px >= sig.tp1 : px <= sig.tp1)) {
      sig.tp1Hit = true;
      sig.curSl = rp(sig.entry);
      dirty = true;
      log(MODS[sig.module].label + ' TP1 (sanal): ' + sig.base + ' yarısı alındı, stop girişe çekildi');
    }
  }
}

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
  const out = {
    symbol: sym, base: baseOf(sym), tf,
    candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]),
    ema20: e20.map(v => v == null ? null : rp(v)), ema50: e50.map(v => v == null ? null : rp(v)),
    tradingview: tvUrl(sym),
    signal: sig ? viewSignal(sig) : { base: baseOf(sym), dir: (extra && extra.dir) || null, entry: num(extra && extra.entry), sl: num(extra && extra.sl), tp1: num(extra && extra.tp1), tp2: num(extra && extra.tp2) },
    levels: [], triangle: null, supportResistance: []
  };
  const wantTri = (sig && sig.module === 'LT') || (extra && (Number(extra.upper) > 0 || Number(extra.lower) > 0) && (tf === '2h' || tf === '4h'));
  if (wantTri) {
    const base = closed(cs, TF_MS[tf] || H2);
    let tri = analyzeTriangle(base, tf), src = base;
    if (!tri) { const cached = LT_CACHE.get(sym); if (cached && cached.tri) { tri = cached.tri; src = cached.cs; } }
    if (tri) {
      const tc = triangleChart(tri, src, tf);
      out.triangle = tc;
      out.levels = [{ v: tc.upperNow, col: '#f6465d', l: 'ÜST ÇİZGİ' }, { v: tc.lowerNow, col: '#0ecb81', l: 'ALT ÇİZGİ' }];
      out.supportResistance = srLevels(src, tri.atr, priceOf(sym) || cl[cl.length - 1]);
    } else if (extra) {
      if (Number(extra.upper) > 0) out.levels.push({ v: Number(extra.upper), col: '#f6465d', l: 'ÜST' });
      if (Number(extra.lower) > 0) out.levels.push({ v: Number(extra.lower), col: '#0ecb81', l: 'ALT' });
    }
  }
  return out;
}

app.get('/', (req, res) => {
  const p = path.join(__dirname, 'index.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.type('text/plain').send('AlphaSon ' + VERSION + ' çalışıyor. Arayüz için index.html koyun.');
});

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, ready: READY, live: HAS_KEYS && settings.tradeMode === 'live', ai: aiReady(), market: marketAI.dir, modules: ACTIVE_MODULES }));

app.get('/api/state', h((req, res) => {
  const active = signals.filter(isOpenSignal);
  const byModule = {};
  for (const m of ACTIVE_MODULES) byModule[m] = active.filter(s => s.module === m).length;
  const modules = {};
  for (const m of ACTIVE_MODULES) modules[m] = { enabled: MODS[m].enabled, label: MODS[m].label, tf: MODS[m].tf, tradeable: MODS[m].tradeable };
  res.json({
    version: VERSION, at: Date.now(), ready: READY, settings, activeModules: ACTIVE_MODULES, modules, market, marketAI,
    paper: paperSummary(),
    live: { keys: HAS_KEYS, mode: settings.tradeMode, balance: liveBalanceView(), summary: liveSummary(), open: LIVE.open.map(viewLivePos), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null, needsSync: LIVE.needsSync === true, ipHint: LIVE.ipHint },
    counts: {
      active: active.length, byModule, pendingApproval: active.filter(s => s.status === 'ONAY_BEKLIYOR').length, aiPending: active.filter(s => s.status === 'AI_BEKLIYOR').length,
      bekleyen: signals.filter(s => s.status === 'BEKLE').length,
      openPump: paper.open.length + LIVE.open.length, paperOpen: paper.open.length, liveOpen: LIVE.open.length,
      autoOpen: autoOpenCount(), autoMaxOpen: settings.autoMaxOpen, totalSignals: signals.length, closed: signals.filter(s => s.status === 'KAPALI').length
    },
    scan: { universe: UNIVERSE.length, autoAt: lastScan.auto || 0, scalpAt: lastScan.scalp || 0, ltAt: lastScan.lt || 0, tickAt: lastScan.tick || 0, autoWatch: AUTO_WATCH.length, ltWatch: WATCH.lt.length, scalpWatch: SCALP_WATCH.length },
    ai: aiStatus(), costPct: EX.H, liveEnabled: HAS_KEYS && settings.tradeMode === 'live'
  });
}));

app.get('/api/signals', h((req, res) => {
  const mod = String(req.query.module || '').toUpperCase();
  let list = signals.slice();
  if (mod) {
    if (!MODS[mod]) return res.json({ module: mod, active: [], closed: [], removed: true });
    list = list.filter(s => s.module === mod);
  }
  const active = list.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt).map(viewSignal);
  const bekleyen = list.filter(s => s.status === 'BEKLE').sort((a, b) => b.createdAt - a.createdAt).map(viewSignal);
  const cl = list.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 100).map(viewSignal);
  res.json({ module: mod || null, active, bekleyen, closed: cl, all: active.concat(cl) });
}));

app.get('/api/paper', h((req, res) => res.json({
  settings: paperSettingsView(), summary: paperSummary(), open: paper.open.map(viewPaper), closed: paper.closed.slice(-50).reverse(),
  live: { keys: HAS_KEYS, mode: settings.tradeMode, balance: liveBalanceView(), summary: liveSummary(), open: LIVE.open.map(viewLivePos), closed: LIVE.closed.slice(-50).reverse(), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null },
  limits: { maxOpen: settings.maxOpen, autoMaxOpen: settings.autoMaxOpen, dailyLossPct: settings.dailyLossPct, costPct: EX.H, live: HAS_KEYS && settings.tradeMode === 'live' }
})));

app.post('/api/paper/settings', h((req, res) => {
  const body = Object.assign({}, req.body || {});
  if (body.tradeMode === 'live' && !HAS_KEYS) return res.status(400).json({ error: 'Canlı işlem için BITGET_API_KEY / BITGET_SECRET / BITGET_PASSPHRASE gerekli.' });
  settings = sanitizeSettings(Object.assign({}, settings, body));
  if (settings.tradeMode === 'live' && !HAS_KEYS) settings.tradeMode = 'paper';
  dirty = true; saveState(true);
  res.json({ ok: true, settings });
}));

app.post('/api/paper/toggle', h((req, res) => {
  const b = req.body || {};
  if (typeof b.auto === 'boolean') settings.auto = b.auto;
  else if (typeof b.enabled === 'boolean') settings.auto = b.enabled;
  else settings.auto = !settings.auto;
  dirty = true; saveState(true);
  res.json({ ok: true, auto: settings.auto });
}));

app.post('/api/paper/reset', h((req, res) => {
  const eq = settings.paperEquity;
  paper = { open: [], closed: [], equity: eq, start: eq, dayStart: eq, dayKey: dayKey(), peak: eq };
  dirty = true; saveState(true);
  log('Paper sıfırlandı: ' + eq + ' USDT');
  res.json({ ok: true, summary: paperSummary() });
}));

app.post('/api/paper/:id/close', h(async (req, res) => {
  const pos = paper.open.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'pozisyon yok' });
  const px = priceOf(pos.symbol) || pos.entry;
  closePaper(pos, px, 'MANUEL');
  res.json({ ok: true, exit: rp(px) });
}));

app.post('/api/trade/mode', h(async (req, res) => {
  const want = String((req.body || {}).mode || (req.body || {}).tradeMode || '').toLowerCase();
  if (want === 'live') {
    if (!HAS_KEYS) return res.status(400).json({ error: 'Bitget anahtarı yok: BITGET_API_KEY / BITGET_SECRET / BITGET_PASSPHRASE' });
    settings.tradeMode = 'live';
    dirty = true; saveState(true);
    await fetchLiveBalance(true);
    const bal = liveBalanceView();
    return res.json({ ok: true, mode: 'live', balance: bal, warning: bal.error || null, note: bal.error ? 'Canlı mod açıldı ama bakiye okunamadı: ' + bal.error : 'Canlı işlem açık. Emirler Bitget USDT-M hesabına gider.' });
  }
  if (want === 'paper') {
    settings.tradeMode = 'paper';
    dirty = true; saveState(true);
    return res.json({ ok: true, mode: 'paper', note: 'Paper trading aktif. Emirler sanal cüzdana gider.' });
  }
  res.json({ ok: true, mode: settings.tradeMode, keys: HAS_KEYS, balance: liveBalanceView() });
}));

app.get('/api/auto/status', h((req, res) => res.json({
  ok: true, enabled: settings.autoTrade === true, aiReady: aiReady(), mode: settings.tradeMode, maxOpen: settings.autoMaxOpen, open: autoOpenCount(),
  paperOpen: paper.open.filter(p => p.module === 'AUTO').length, liveOpen: LIVE.open.filter(p => p.module === 'AUTO').length,
  lastScan: lastScan.auto || 0, watch: AUTO_WATCH, meta: WATCH_META.auto, ai: { market: marketAI, enabled: aiReady() },
  note: settings.autoTrade && !aiReady() ? 'OtoTrade açık ama AI kapalı: giriş yapılmaz.' : null
})));

app.post('/api/auto/toggle', h(async (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') settings.autoTrade = b.enabled;
  else if (typeof b.autoTrade === 'boolean') settings.autoTrade = b.autoTrade;
  else settings.autoTrade = !settings.autoTrade;
  dirty = true; saveState(true);
  if (settings.autoTrade && !aiReady()) return res.json({ ok: true, enabled: true, aiReady: false, note: 'OtoTrade açıldı ancak AI kapalı/anahtarsız. Giriş için AI açılmalı ve çalışan model bulunmalı.' });
  if (settings.autoTrade) autoScan(true).catch(() => {});
  res.json({ ok: true, enabled: settings.autoTrade, aiReady: aiReady(), maxOpen: settings.autoMaxOpen });
}));

app.get('/api/auto/watch', h((req, res) => res.json({ items: AUTO_WATCH, meta: WATCH_META.auto })));
app.post('/api/auto/scan', h(async (req, res) => { await autoScan(true); res.json({ ok: true, items: AUTO_WATCH, meta: WATCH_META.auto }); }));

app.get('/api/live/balance', h(async (req, res) => {
  const bal = await fetchLiveBalance(true);
  res.json({ ok: !!bal && !bal.error, keys: HAS_KEYS, mode: settings.tradeMode, balance: liveBalanceView(), error: LIVE.lastError || null, ipHint: LIVE.ipHint });
}));
app.get('/api/live/positions', h(async (req, res) => {
  const raw = await fetchLivePositions();
  res.json({
    ok: !!raw, keys: HAS_KEYS, mode: settings.tradeMode, open: LIVE.open.map(viewLivePos),
    positions: Array.isArray(raw) ? raw.filter(p => Math.abs(num(p.contracts)) > 0).map(p => ({ symbol: p.symbol, side: p.side, contracts: num(p.contracts), entryPrice: num(p.entryPrice), markPrice: num(p.markPrice), unrealizedPnl: num(p.unrealizedPnl), leverage: num(p.leverage) })) : [],
    balance: liveBalanceView(), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null
  });
}));
app.post('/api/live/sync', h(async (req, res) => { await syncLive(); await fetchLiveBalance(true); res.json({ ok: true, open: LIVE.open.map(viewLivePos), balance: liveBalanceView(), lastSync: LIVE.lastSync || 0 }); }));
app.post('/api/live/:id/close', h(async (req, res) => {
  const pos = LIVE.open.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'canlı pozisyon yok' });
  const px = await fastLivePrice(pos.symbol, pos.markPrice || pos.entry);
  const r = await liveClose(pos, px, 'MANUEL');
  if (r && r.error) return res.status(400).json(r);
  res.json(Object.assign({ ok: true }, r));
}));

app.get('/api/myip', h(async (req, res) => {
  let ip = null, err = null;
  try { const r = await fetch('https://api.ipify.org?format=json'); const j = await r.json(); ip = j.ip; } catch (e) { err = redact(e.message); }
  res.json({ ip, error: err, bitgetSawIp: LIVE.ipHint, note: 'Bitget → API Yönetimi → anahtar → IP beyaz listesine bu IP\'yi (ve Render paneli → Connect → Outbound listesindeki IP\'leri) ekle.' });
}));
app.get('/api/live/diag', h(async (req, res) => {
  const out = { keys: HAS_KEYS, hasKey: !!API_KEY, hasSecret: !!API_SECRET, hasPassphrase: !!API_PASS, mode: settings.tradeMode, ipHint: LIVE.ipHint };
  if (HAS_KEYS) { const b = await fetchLiveBalance(true); out.balance = liveBalanceView(); out.ok = !b.error; out.error = LIVE.lastError || null; }
  else out.error = 'BITGET_API_KEY / BITGET_SECRET / BITGET_PASSPHRASE ortam değişkenlerinden biri eksik';
  res.json(out);
}));

app.get('/api/watch/:kind', h((req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  if (kind === 'auto' || kind === 'ototrade') return res.json({ items: AUTO_WATCH, meta: WATCH_META.auto });
  if (kind === 'lt') return res.json({ items: WATCH.lt, meta: WATCH_META.lt });
  if (kind === 'scalp' || kind === 'pump') return res.json({ items: SCALP_WATCH, meta: WATCH_META.scalp });
  res.json({ items: [], meta: null, note: 'Bilinmeyen izleme türü.' });
}));
app.post('/api/watch/lt/:base/ai', h(async (req, res) => { const r = await watchAI('lt', req.params.base, true); if (r.error) return res.status(400).json(r); res.json(r); }));
app.post('/api/watch/scalp/:base/ai', h(async (req, res) => { const r = await watchAI('scalp', req.params.base, true); if (r.error) return res.status(400).json(r); res.json(r); }));
app.post('/api/watch/trend/:base/ai', h((req, res) => res.status(410).json({ error: 'Trend modülü kaldırıldı' })));

app.get('/api/chart/:id', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  const tf = (sig.info && sig.info.tf) || MODS[sig.module].chartTf;
  const cs = (sig.module === 'LT' && tf === '2h') ? await getLong2h(sig.symbol, LT_BARS) : await getCandles(sig.symbol, tf, 220, false);
  if (!cs || !cs.length) return res.status(404).json({ error: 'mum verisi yok' });
  res.json(chartPayload(sig.symbol, tf, cs, sig, null));
}));

app.get('/api/chart', h(async (req, res) => {
  const sym = String(req.query.symbol || '');
  if (!sym.includes('/')) return res.status(400).json({ error: 'symbol gerekli' });
  const tf = TF_MS[req.query.tf] ? String(req.query.tf) : '15m';
  const cs = tf === '2h' ? await getLong2h(sym, LT_BARS) : await getCandles(sym, tf, 220, false);
  if (!cs || !cs.length) return res.status(404).json({ error: 'mum verisi yok' });
  const extra = { dir: String(req.query.dir || '').toUpperCase() || null, entry: num(req.query.entry), sl: num(req.query.sl), tp1: num(req.query.tp1), tp2: num(req.query.tp2), upper: num(req.query.upper), lower: num(req.query.lower) };
  res.json(chartPayload(sym, tf, cs, null, extra));
}));

app.post('/api/signal/:id/close', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  if (sig.status === 'KAPALI') return res.json({ ok: true, note: 'zaten kapalı' });
  const pos = paper.open.find(p => p.sigId === sig.id);
  const lpos = LIVE.open.find(p => p.sigId === sig.id);
  const px = lpos ? await fastLivePrice(lpos.symbol, lpos.markPrice || lpos.entry) : (priceOf(sig.symbol) || sig.entry);
  if (lpos) { const r = await liveClose(lpos, px, 'MANUEL'); if (r && r.error) return res.status(400).json(r); }
  else if (pos) closePaper(pos, px, 'MANUEL');
  else if (sig.tradeable === false) closeVirtual(sig, px, 'MANUEL');
  else skipSignal(sig, 'SKIP', 'manuel kapatıldı (işleme girmedi)');
  res.json({ ok: true, exit: rp(px) });
}));

app.post('/api/signal/:id/execute', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  const r = await approveSignal(sig);
  if (r && r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, position: r.pos ? (r.pos.isLive ? viewLivePos(r.pos) : viewPaper(r.pos)) : null });
}));

app.post('/api/signal/:id/ai', h(async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.status(404).json({ error: 'sinyal yok' });
  if (sig.status === 'KAPALI') return res.status(400).json({ error: 'sinyal kapanmış' });
  if (!aiReady()) return res.status(400).json({ error: settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok' });
  const ai = await aiReview(sig, { force: true });
  if (!ai) return res.status(502).json({ error: 'AI yanıt vermedi' });
  res.json({ ok: true, ai: sig.ai, signal: viewSignal(sig) });
}));

app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: EX.H, version: VERSION })));

app.get('/api/rejections', h((req, res) => {
  const items = REJ.slice(-150).reverse().map(r => ({ at: r.t, lastAt: r.t, mod: r.module, module: r.module, base: r.base, symbol: r.symbol, code: r.reason, label: r.reason, reason: r.reason, count: r.n || 1, kind: 'MATEMATİK', price: r.price }));
  const byCode = {};
  for (const r of REJ) byCode[r.reason] = (byCode[r.reason] || 0) + (r.n || 1);
  res.json({ items, byCode });
}));

app.get('/api/opportunities', h((req, res) => {
  const items = Array.from(OPP.values()).sort((a, b) => b.updatedAt - a.updatedAt).map(o => Object.assign({}, o, { ai: o.ai ? (o.ai.summary || o.ai.reason || '') : '' }));
  res.json({ items });
}));

app.get('/api/outcomes', h((req, res) => {
  const done = OUT.filter(o => Number.isFinite(o.netR));
  const stats = [];
  for (const m of ACTIVE_MODULES) {
    for (const dir of ['LONG', 'SHORT']) {
      const list = done.filter(o => o.module === m && o.dir === dir);
      if (!list.length) continue;
      const wins = list.filter(o => o.netR > 0);
      const sm = list.reduce((s, o) => s + o.netR, 0);
      const gw = wins.reduce((s, o) => s + o.netR, 0);
      const gl = Math.abs(list.filter(o => o.netR <= 0).reduce((s, o) => s + o.netR, 0));
      stats.push({ mod: m, kind: 'paper', dir, n: list.length, winRate: +(wins.length / list.length * 100).toFixed(1), avgNet15: +(sm / list.length).toFixed(3), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), avgMFE: 0, avgMAE: 0, sampleOk: list.length >= 30 });
    }
  }
  const recent = done.slice(-40).reverse().map(o => ({ base: o.base, mod: o.module, dir: o.dir, p0: null, net15: o.netR, mfe: 0, mae: 0, timing: '', at: o.t }));
  res.json({ open: signals.filter(s => s.tradeable === false && isOpenSignal(s)).length, done: done.length, stats, recent, note: VERSION + ': sonuç ölçümü kapanan sinyallerin net R değerinden hesaplanır. AI karar doğruluğu için /api/ai/accuracy.' });
}));

app.get('/api/radar', h(async (req, res) => {
  const rsiOf = async (sym, tf) => { try { const cs = await getCandles(sym, tf, 120, true); return cs && cs.length ? rsiLast(closesOf(cs), 14) : null; } catch (e) { return null; } };
  const [b1, b4, e1, e4] = await Promise.all([rsiOf('BTC/USDT:USDT', '1h'), rsiOf('BTC/USDT:USDT', '4h'), rsiOf('ETH/USDT:USDT', '1h'), rsiOf('ETH/USDT:USDT', '4h')]);
  const r0 = v => v == null ? null : Math.round(v);
  const avg1 = [b1, e1].filter(v => v != null), avg4 = [b4, e4].filter(v => v != null);
  res.json({
    radar: {
      updatedAt: Date.now(), fng: null,
      rsi: { btc1h: r0(b1), btc4h: r0(b4), eth1h: r0(e1), eth4h: r0(e4), avg1h: avg1.length ? Math.round(avg1.reduce((s, v) => s + v, 0) / avg1.length) : null, avg4h: avg4.length ? Math.round(avg4.reduce((s, v) => s + v, 0) / avg4.length) : null, text: 'RSI 14 · BTC/ETH 1s ve 4s' },
      ls: { long: 50, short: 50, text: 'Alış/satış oranı verisi yok.' }, extremes: { overbought: [], oversold: [] }
    },
    market, moneyFlow: []
  });
}));

app.get('/api/strategies', h((req, res) => res.json({
  version: VERSION,
  strategies: [
    { module: 'AUTO', name: 'OtoTrade (Pump/Dump)', active: true, tf: '1m', desc: 'Matematik 1 dakikalık pump/dump adaylarını bulur. Hareket 2 ATR altı normal, 2-3 ATR hacim/mum teyidi, 3+ ATR çok güçlü teyit ister. AI GİR/GİRME. Mekanik ivme kaybı çıkışı AI beklemeden kapatır.' },
    { module: 'PUMP', name: 'Günlük Hızlı Scalp', active: true, tf: '5m', desc: 'TREND TAKİP. Piyasa yönü LONG ise EMA20>EMA50 ve fiyat EMA20 üstündeyken LONG arar. SHORT ise tam tersi. NOTR ise sinyal üretmez. Yapısal stop ± 0.15 ATR, risk %0.35-1.50. TP1/TP2 EX.H net R:R 0.50/0.80. AI GİR/GİRME.' },
    { module: 'LT', name: 'LT Üçgen', active: true, tf: '2h', desc: 'Üçgen tespiti. Sıkışma tabanı %5, izleme olgunluk 0.15, gerçek sinyal olgunluk 0.40. Erken izleme 3-200 mum apeks; genel geçerlilik 0-500. AI yorum ekler, elemez.' }
  ],
  removed: ['TREND', 'DAILY', 'ZONE', 'SCALPER', 'RANGE'],
  limits: { AUTO: MODS.AUTO.maxPerDaySym, PUMP: MODS.PUMP.maxPerDaySym, LT: MODS.LT.maxPerDaySym }
})));

app.get('/api/ai/status', h((req, res) => {
  const recent = signals.filter(s => s.ai && !s.ai.error).sort((a, b) => (b.ai.at || 0) - (a.ai.at || 0)).slice(0, 12).map(s => ({ id: s.id, base: s.base, dir: s.dir, module: s.module, at: s.ai.at, verdict: s.ai.verdict, score: s.ai.score, trust: s.ai.trust, decision: s.ai.decisionV85 || null, checks: s.ai.checks || null, reason: s.ai.reason, summary: s.ai.summary, provider: s.ai.providerName || s.ai.provider }));
  res.json(Object.assign(aiStatus(), { recent }));
}));
app.get('/api/ai/history', h((req, res) => res.json({ items: AI_HIST.slice(-100).reverse(), providers: AI_PROV.map(aiProviderView) })));
app.get('/api/ai/reasons', h((req, res) => res.json({ items: Object.keys(CHECK_STAT).map(k => ({ check: k, count: CHECK_STAT[k] })).sort((a, b) => b.count - a.count), note: 'Hangi kontrol maddesi en çok ZAYIF/GIRME üretiyor (yeniden başlatmada sıfırlanır; kalıcı kayıt decisions.jsonl).' })));
app.get('/api/ai/accuracy', h((req, res) => res.json(aiAccuracy())));
app.get('/api/decisions', h((req, res) => res.json({ items: readDecisions(200).reverse() })));
app.get('/api/ai/brief', h((req, res) => res.json({ brief: marketBrief, status: aiStatus() })));
app.post('/api/ai/brief', h(async (req, res) => { const r = await aiMarketBrief(true); if (r && r.error) return res.status(400).json(r); res.json({ ok: true, brief: r }); }));

app.post('/api/ai/toggle', h((req, res) => {
  const b = req.body || {};
  const before = { enabled: settings.aiEnabled, watchAuto: settings.aiWatchAuto };
  if (typeof b.enabled === 'boolean') settings.aiEnabled = b.enabled;
  if (typeof b.watchAuto === 'boolean') settings.aiWatchAuto = b.watchAuto;
  if (settings.aiEnabled === false) AI_QUEUE.length = 0;
  dirty = true; saveState(true);
  log('AI AYAR: enabled ' + before.enabled + '→' + settings.aiEnabled + ', watchAuto ' + before.watchAuto + '→' + settings.aiWatchAuto);
  if (settings.aiEnabled && !aiKeys().length) return res.json({ ok: true, enabled: false, settingsEnabled: true, keys: 0, note: 'AI açıldı ama hiçbir sağlayıcı anahtarı yok. Ortam değişkenlerine anahtar ekleyin.' });
  if (settings.aiEnabled) {
    const q = aiQuota();
    return res.json({ ok: true, enabled: aiReady(), settingsEnabled: settings.aiEnabled, watchAuto: settings.aiWatchAuto, keys: aiKeys().length,
      quota: { day: q.dayCount, hour: q.hourCount, maxDay: AI_CFG.maxPerDay, maxHour: AI_CFG.maxPerHour },
      note: 'ÖNEMLİ: AI açıldı. Önce /api/ai/discover ile modelleri keşfetmeniz önerilir; strateji sinyalleri saatlik bütçeyi hızla tüketebilir.' });
  }
  res.json({ ok: true, enabled: aiReady(), settingsEnabled: settings.aiEnabled, watchAuto: settings.aiWatchAuto, keys: aiKeys().length });
}));

app.post('/api/ai/reset', h((req, res) => {
  for (const p of AI_PROV) { p.cooldownUntil = 0; p.modelCooldowns = {}; p.lastError = null; p.nextAt = 0; }
  AI_USAGE.dayCount = 0; AI_USAGE.hourCount = 0; AI_USAGE.briefCount = 0;
  AI_USAGE.moduleDay = { AUTO: 0, PUMP: 0, LT: 0 };
  AI_STATE.lastError = null;
  dirty = true; saveState(true);
  res.json({ ok: true, note: 'AI soğumaları ve sayaçlar sıfırlandı.' });
}));

app.get('/api/ai/test', h(async (req, res) => {
  const out = [];
  for (const p of AI_PROV) {
    const row = { id: p.id, name: p.name, hasKey: !!p.key, models: p.models.slice(), results: [] };
    if (!p.key) { out.push(row); continue; }
    for (const model of (p.models || []).slice(0, 2)) {
      try {
        const t0 = Date.now();
        const r = await callProviderModel(p, QUALITY_MSGS, model, { timeoutMs: 20000, module: null });
        row.results.push({ model, ok: qualityOk(r.text), quality: qualityOk(r.text), ms: Date.now() - t0, sample: String(r.text).slice(0, 80) });
      } catch (e) { row.results.push({ model, ok: false, error: redact(e.message) }); if (e && (e.status === 402 || e.budgetExhausted)) break; }
    }
    out.push(row);
  }
  res.json({ ok: out.some(p => p.results.some(r => r.ok)), providers: out });
}));

app.get('/api/ai/models', h((req, res) => res.json({ ok: true, providers: AI_PROV.map(p => Object.assign(aiProviderView(p), { base: p.base, native: !!p.nativeBase })), discover: { running: AI_DISCOVER.running, at: AI_DISCOVER.at, error: AI_DISCOVER.error, results: AI_DISCOVER.results } })));
app.get('/api/ai/discover', h((req, res) => res.json({ ok: true, at: AI_DISCOVER.at || 0, running: AI_DISCOVER.running === true, error: AI_DISCOVER.error || null, results: AI_DISCOVER.results || {}, providers: AI_PROV.map(aiProviderView), note: VERSION + ': model listesi çekilir, kalite sınamasını geçen modeller kaydedilir. Otomatik çalışmaz.' })));
app.post('/api/ai/discover', h(async (req, res) => {
  const b = req.body || {};
  const only = b.provider ? [String(b.provider).toLowerCase()] : null;
  log('AI KEŞİF İSTEĞİ: provider=' + (only ? only.join(',') : 'hepsi'));
  const r = await discoverAll({ only, maxTest: num(b.maxTest, AI_CFG.discoverModelsPerProvider), maxWorking: num(b.maxWorking, AI_CFG.discoverMaxWorking) });
  res.status(r.ok ? 200 : 409).json(r);
}));
app.post('/api/ai/market', h(async (req, res) => { await updateMarket(); res.json({ ok: true, marketAI, market, note: 'Piyasa yönü matematikle belirlenir (5 dk).' }); }));

app.get('/api/backtest/:id', h((req, res) => { const job = BT_JOBS.get(req.params.id); if (!job) return res.status(404).json({ error: 'iş yok' }); res.json(job); }));
app.post('/api/backtest', h((req, res) => res.json({ ok: true, id: btStart(req.body || {}) })));

app.get('/api/v81/overview', h((req, res) => {
  const active = signals.filter(isOpenSignal);
  res.json({
    counts: { opportunities: OPP.size, activeSignals: active.length, bekleyen: signals.filter(s => s.status === 'BEKLE').length, openPaper: paper.open.length, openLive: LIVE.open.length, autoWatch: AUTO_WATCH.length, ltWatch: WATCH.lt.length, scalpWatch: SCALP_WATCH.length, closed: signals.filter(s => s.status === 'KAPALI').length },
    costPct: EX.H, note: VERSION + ': OtoTrade, LT Üçgen ve Günlük Hızlı Scalp aktiftir.'
  });
}));

app.get('/api/diag', h((req, res) => res.json({
  version: VERSION, uptimeSec: Math.round(process.uptime()), ready: READY, universe: UNIVERSE.length, cache: CACHE.size, ltCache: LT_CACHE.size, long1h: LONG1H.size,
  signals: signals.length, openSignals: signals.filter(isOpenSignal).length, bekleyen: signals.filter(s => s.status === 'BEKLE').length,
  paperOpen: paper.open.length, paperClosed: paper.closed.length,
  auto: { enabled: settings.autoTrade, open: autoOpenCount(), max: settings.autoMaxOpen, watch: AUTO_WATCH.length, lastScan: lastScan.auto || 0, aiThisHour: AUTO_AI.count, aiPerHour: settings.autoAiPerHour },
  live: { keys: HAS_KEYS, mode: settings.tradeMode, open: LIVE.open.length, closed: LIVE.closed.length, balance: liveBalanceView(), lastSync: LIVE.lastSync || 0, lastError: LIVE.lastError || null, ipHint: LIVE.ipHint },
  ai: { ready: aiReady(), queue: AI_QUEUE.length, busy: AI_STATE.busy, usage: AI_USAGE, providers: AI_PROV.map(aiProviderView), models: Object.fromEntries(AI_PROV.map(p => [p.id, p.models])), discover: { running: AI_DISCOVER.running, at: AI_DISCOVER.at, error: AI_DISCOVER.error }, marketAI, shadowOpen: SHADOW.filter(s => !s.done).length },
  market, lastScan
})));

app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.get('/api/dataset', h((req, res) => res.json({ version: VERSION, at: Date.now(), signals: signals.slice(-200).map(viewSignal), closed: paper.closed.slice(-100), rejections: REJ.slice(-100) })));

app.use((req, res) => res.status(404).json({ error: 'yol yok', path: req.path, version: VERSION }));

function every(ms, fn, delay) {
  let stopped = false;
  const tickOnce = async () => {
    if (stopped) return;
    try { await fn(); } catch (e) { log('DÖNGÜ HATASI: ' + redact(e.message)); }
    if (!stopped) setTimeout(tickOnce, ms);
  };
  setTimeout(tickOnce, Math.max(1000, delay || ms));
  return () => { stopped = true; };
}

function dayRollover() {
  const dk = dayKey();
  if (paper.dayKey !== dk) {
    paper.dayKey = dk; paper.dayStart = paper.equity; dirty = true;
    log('Gün değişti: paper gün başı ' + paper.dayStart + ' USDT');
  }
  aiQuota();
}

let LOOP_STOPS = [];
function startLoops() {
  setInterval(() => { refreshTickers().catch(() => {}); }, 10e3);
  setInterval(ltTick, 10e3);
  setInterval(() => { monitorPaper().catch(() => {}); }, 3e3);
  setInterval(() => { monitorLive().catch(() => {}); }, 3e3);
  setInterval(monitorVirtual, 10e3);
  setInterval(monitorShadow, 10e3);
  setInterval(reconcilePending, 15e3);
  setInterval(() => { dayRollover(); saveState(false); }, 20e3);
  LOOP_STOPS.push(every(12e3, () => autoScan(true), 4e3));
  LOOP_STOPS.push(every(45e3, () => autoScan(false), 10e3));
  LOOP_STOPS.push(every(60e3, scalpScan, 15e3));
  LOOP_STOPS.push(every(10 * M1, ltScan, 30e3));
  LOOP_STOPS.push(every(5 * M1, updateMarket, 60e3));
  LOOP_STOPS.push(every(20e3, syncLive, 25e3));
  LOOP_STOPS.push(every(10 * M1, maybeWatchAI, 3 * M1));
}

async function init() {
  log('AlphaSon ' + VERSION + ' başlıyor — modüller: OtoTrade, LT Üçgen, Günlük Hızlı Scalp');
  loadState();
  log('İşlem modu: ' + (settings.tradeMode === 'live' ? 'CANLI (Bitget)' : 'PAPER') + ' | AI ' + (settings.aiEnabled ? 'AÇIK' : 'KAPALI') + ' | Bitget anahtarı ' + (HAS_KEYS ? 'var' : 'yok'));
  if (settings.tradeMode === 'live' && !HAS_KEYS) settings.tradeMode = 'paper';
  try { await refreshUniverse(); } catch (e) { log('Evren hatası: ' + redact(e.message)); }
  try { await refreshTickers(); } catch (e) { /* sessiz */ }
  try { await updateMarket(); } catch (e) { /* sessiz */ }
  READY = true;
  startLoops();
  reconcilePending();
  if (HAS_KEYS) { fetchLiveBalance(true).then(() => checkOrphans()).catch(() => {}); }
  setTimeout(() => { scalpScan().catch(() => {}); }, 3e3);
  setTimeout(() => { ltScan().catch(() => {}); }, 6e3);
  setTimeout(() => { autoScan(false).catch(() => {}); }, 9e3);
  log('Hazır. http://localhost:' + PORT + ' | evren ' + UNIVERSE.length + ' coin | mod ' + settings.tradeMode);
}

let server = null;
if (process.env.ALPHASON_TEST !== '1') {
  server = app.listen(PORT, () => { init().catch(e => log('BAŞLATMA HATASI: ' + e.message)); });
} else {
  log('TEST modu (ALPHASON_TEST=1): sunucu başlatılmadı, yalnızca export modu aktif.');
}

function shutdown(sig) {
  log(sig + ' alındı, kapatılıyor...');
  try { saveState(true); } catch (e) { /* sessiz */ }
  for (const stop of LOOP_STOPS) { try { stop(); } catch (e) { /* sessiz */ } }
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => log('YAKALANMAMIŞ PROMISE: ' + redact(e && e.message || e)));

if (process.env.ALPHASON_TEST === '1') {
  module.exports = {
    VERSION, app,
    rrNet, lockStopTarget, autoExitTrigger, stopResult,
    computeScalpStop, computeScalpTps, makeScalpCandidate,
    aiReserveBudget, aiQuota,
    isOpenSignal, mechanicalExit,
    analyzeTriangle, ltSignalFrom, triangleChart, srLevels,
    buildLtWatch, zigzag, findLines,
    scalpAnalyze, addSignal, parseChecksJSON, legacyFields,
    hotSyms, parseWatchJSON, extractJSON, badReason,
    qualityOk, modelRank, friendlyBitgetError, quotaWaitMs,
    autoContext, autoCandidates, aiAccuracy,
    sigPL, closeVirtual, monitorVirtual, monitorShadow, monitorPaper, updateMarket,
    tickMap: TICK, paperSnapshot: () => paper,
    get signals() { return signals; },
    get settings() { return settings; },
    get aiProviders() { return AI_PROV; },
    get AI_USAGE() { return AI_USAGE; },
    get AI_CFG() { return AI_CFG; },
    get SCALP_BEKLE() { return SCALP_BEKLE; },
    init
  };
}
