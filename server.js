'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v89.0 — tek dosya sunucu
   · PUMP modülü artık "Trend Takip": 1h rejim + 15m geri çekilme/kırılım
   · LT Üçgen: sadece taze kapanan 2h mumunda kırılım, sahte kırılım/stall/trailing
   · AI kotası: OtoTrade kapalıyken AUTO hiç AI çağırmaz, diğer modüller açık
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

const VERSION = 'v89.0';
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
    const alt = path.join(os.tmpdir(), 'alphason-v89');
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
const API_TOKEN = String(process.env.ALPHASON_API_TOKEN || '').trim();

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
    key: process.env.DEEPSEEK_API_KEY || '',
    models: ['deepseek-chat'], prefer: 2, dayLimit: envLimit('DEEPSEEK', 3000)
  }),
  mkProv({
    id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], prefer: 3, dayLimit: envLimit('GROQ', 900)
  }),
  mkProv({
    id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1',
    key: process.env.OPENAI_API_KEY || '',
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
  FEE: 0.0006, SLIP: 0.0004, H: 0.20, COST: 0.24,
  MIN_RR1: 1.00, MIN_RR2: 1.75,
  MAX_RISK_PCT: 3.5, MIN_RISK_PCT: 0.50
};

// Net R hesaplarında komisyon ve slippage birlikte kullanılır. Canlı işlemde
// gerçekleşen fill fiyatı slippage'ı zaten içerdiğinden yalnızca komisyon yazılır.
const STRAT = {
  AUTO: { minRiskPct: 0.50, maxRiskPct: 2.50, tp1GrossR: 1.00, tp2GrossR: 2.25, tp1NetR: 0.75, tp2NetR: 1.75 },
  // TREND TAKİP: geniş hedefli trend işlemi. Stop yapının altında/üstünde,
  // hedefler net R korunarak hesaplanır (maliyet + slipaj dahil).
  PUMP: { minRiskPct: 0.45, maxRiskPct: 2.20, tp1GrossR: 1.60, tp2GrossR: 3.20, tp1NetR: 1.20, tp2NetR: 2.60 },
  LT:   { minRiskPct: 0.60, maxRiskPct: 3.50, tp1GrossR: 1.50, tp2GrossR: 2.50, tp1NetR: 0.85, tp2NetR: 1.75 }
};

const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade (Pump/Dump)', tf: '1m', chartTf: '1m', enabled: true, tradeable: true, maxPerDaySym: 10, cooldown: 10 * M1, maxAge: 45 * M1, auto: true },
  PUMP: { key: 'PUMP', label: 'Trend Takip', tf: '1h', chartTf: '1h', enabled: true, tradeable: false, maxPerDaySym: 3, cooldown: 2 * H1, maxAge: 12 * H1 },
  LT:   { key: 'LT',   label: 'LT Üçgen',   tf: '2h', chartTf: '2h', enabled: true, tradeable: false, maxPerDaySym: 2, cooldown: 3 * H1, maxAge: 10 * H1 }
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
  costPct: EX.COST, paperEquity: 1000, maxSpreadPct: 0.10, minQuoteVol: 5e5, topN: 150,
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
  s.costPct = EX.COST;
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
let LIVE = { open: [], closed: [], balance: null, positions: null, lastSync: 0, lastError: null, busy: false, needsSync: false, ipHint: null, dayKey: dayKey(), dayStart: 0 };

function capArr(a, n) { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (settings.minQuoteVol > 5e5) settings.minQuoteVol = 5e5;
    if (settings.topN > 150) settings.topN = 150;
    if (settings.tradeMode === 'live' && (!HAS_KEYS || !API_TOKEN)) { settings.tradeMode = 'paper'; log('Canlı mod için Bitget anahtarı ve ALPHASON_API_TOKEN gerekli → paper moda dönüldü'); }
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
      LIVE.dayKey = j.live.dayKey || dayKey();
      LIVE.dayStart = num(j.live.dayStart, LIVE.balance ? num(LIVE.balance.total, 0) : 0);
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
      live: { open: LIVE.open.slice(-30), closed: LIVE.closed.slice(-200), balance: LIVE.balance, dayKey: LIVE.dayKey, dayStart: LIVE.dayStart },
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
const INFLIGHT = new Map();
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
function quickPrice(sym, maxAgeMs) {
  const t = TICK.get(sym);
  if (t && t.last > 0 && Date.now() - t.ts < (maxAgeMs || 5000)) return t.last;
  return 0;
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
  const pending = INFLIGHT.get(key);
  if (pending && pending.limit >= limit) {
    try { const d = await pending.promise; return d ? d.slice(-limit) : null; } catch (e) { return null; }
  }
  const p = (async () => {
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
      const cur = CACHE.get(key);
      return cur && cur.data && cur.data.length ? cur.data : null;
    }
    const cur = CACHE.get(key);
    if (!data || !data.length) return cur && cur.data ? cur.data : null;
    CACHE.set(key, { t: Date.now(), data, lim: limit });
    if (CACHE.size > 400) { const cutoff = Date.now() - 30 * M1; for (const [k, v] of CACHE) if (v.t < cutoff) CACHE.delete(k); }
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

async function getLong2h(sym, bars) {
  const need = bars * 2 + 6;
  const now = Date.now();
  let ent = LONG1H.get(sym);
  const fresh = ent && now - ent.at < 3 * M1;   // LT kırılım tazeliği için kısa önbellek
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

    let aiDir = market.aiDir || null;
    let aiScore = market.aiScore != null ? market.aiScore : null;
    let aiWhy = null;
    let aiProvider = (market.source && market.source !== 'Matematik') ? market.source : null;
    let finalDir = mathDir;
    let finalWhy = mathWhy;
    if (!market.aiAt || Date.now() - market.aiAt > AI_CFG.marketMaxAgeMs) {
      aiDir = null; aiScore = null; aiProvider = null;
    }

    const marketAiDue = !market.aiAt || Date.now() - market.aiAt > AI_CFG.marketEveryMs;
    // Piyasa AI yalnızca OtoTrade açıkken çağrılır: kapalıyken kota harcanmaz,
    // diğer modüller matematik yönünü kullanır.
    if (aiReady() && settings.autoTrade === true && marketAiDue && aiQuota().leftHour > 3) {
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

          finalWhy = aiWhy;
        }
      } catch (err) { 
          log('Piyasa AI hatası (Matematik yönüne dönüldü): ' + err.message); 
      }
    }

    const cachedAiFresh = !!(aiProvider && aiDir && (aiWhy || (market.aiAt && Date.now() - market.aiAt <= AI_CFG.marketMaxAgeMs)));
    if (cachedAiFresh) {
      finalDir = mathDir !== 'NOTR' && mathDir === aiDir ? mathDir : 'NOTR';
      finalWhy = aiWhy || ('AI (' + aiProvider + '): güncel yön teyidi');
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
      aiAt: aiWhy ? Date.now() : (cachedAiFresh ? market.aiAt : null), 
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
  if (!tri || !tri.ok || !cs || cs.length < 4) return null;
  opt = opt || {};
  const tfMs = TF_MS[tf] || H2;
  const n = cs.length, last = cs[n - 1];
  const now = Number(opt.now) > 0 ? Number(opt.now) : Date.now();
  const px = Number(opt.price) > 0 ? Number(opt.price) : (priceOf(sym) || last.c);
  const atr = tri.atr;
  const up = triUpperAt(tri, n - 1), dn = triLowerAt(tri, n - 1);

  // ── TAZELİK ────────────────────────────────────────────────────────────────
  // Sinyal yalnızca AZ ÖNCE kapanan mumun kırılımıyla üretilir. 5-6 saatlik
  // eski kırılımlar listeye geri dönmez; kırılımın üzerinden hareket geçtiyse susar.
  const closedAge = now - (last.t + tfMs);
  const maxClosedAge = Number(opt.maxClosedAgeMs) > 0 ? Number(opt.maxClosedAgeMs) : 30 * M1;
  if (closedAge > maxClosedAge) return null;

  // Kırılım bu mumda mı başladı? Önceki kapanmış mum da çizginin dışındaysa
  // bu eski bir kırılımdır (geç kalınmış giriş) → sinyal yok.
  const prev = cs[n - 2];
  const upPrev = triUpperAt(tri, n - 2), dnPrev = triLowerAt(tri, n - 2);
  if (prev.c > upPrev + 0.10 * atr || prev.c < dnPrev - 0.10 * atr) return null;

  const vol20 = avg(cs.slice(-20).map(c => c.v));
  const vr = vol20 > 0 ? last.v / vol20 : 1;

  // Kapanış çizginin gerçekten dışında olmalı (fitil yeterli değil).
  const upClosed = last.c >= up + 0.05 * atr && last.c > last.o;
  const dnClosed = last.c <= dn - 0.05 * atr && last.c < last.o;
  if (!upClosed && !dnClosed) return null;

  // Sahte kırılım filtresi: gövde ve hacim teyidi.
  const br = bodyRatio(last), ba = bodyAtr(last, atr);
  if (br < 0.40 || ba < 0.35) return null;
  if (vr < 1.10) return null;

  const dir = (upClosed && (!dnClosed || (last.c - up) >= (dn - last.c))) ? 'LONG' : 'SHORT';
  if (tri.maturity < 0.45 || tri.widthNow < 0.20 * atr) return null;

  const d = dir === 'LONG' ? 1 : -1;
  const line = dir === 'LONG' ? up : dn;
  // Çizgiden çok uzaklaşmışsa (hareket kaçmışsa) kovalamaca yok.
  const ext = d * (px - line) / atr;
  if (ext < -0.25 || ext > 0.85) return null;
  // Üçgenin ters tarafına sarkmışsa kırılım geçersiz.
  if (dir === 'LONG' ? px < up - 0.35 * atr : px > dn + 0.35 * atr) return null;

  const entry = rp(px);
  const sw = cs.slice(-6);
  const swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.35 * atr;
  let risk = Math.abs(entry - sl);
  if (risk < 0.55 * atr) { sl = entry - d * 0.55 * atr; risk = Math.abs(entry - sl); }
  const riskPct = risk / entry * 100;
  if (!moduleRiskOk('LT', riskPct)) return null;

  // Ölçülü hareket: üçgen yüksekliği kadar ilk hedef, iki katı ikinci hedef.
  const height = Math.max(Math.min(tri.widthStart, 5 * atr), 1.15 * risk);
  const tp1 = entry + d * Math.max(0.60 * height, STRAT.LT.tp1GrossR * risk);
  const tp2 = entry + d * Math.max(1.00 * height, STRAT.LT.tp2GrossR * risk);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net + 1e-6 < STRAT.LT.tp1NetR || q2.net + 1e-6 < STRAT.LT.tp2NetR) return null;

  const htfUp = (() => {
    if (cs.length < 130) return null;
    const agg = aggTF(cs.slice(-120), 2, H2);
    if (agg.length < 30) return null;
    const e = emaArr(closesOf(agg), 20);
    return e[e.length - 1] > e[e.length - 6];
  })();
  const aligned = htfUp == null ? false : (dir === 'LONG' ? htfUp : !htfUp);
  const conf = clamp(Math.round(52 + tri.maturity * 15 + tri.compression * 18 + (tri.touchesH + tri.touchesL) * 2 + clamp(vr - 1, 0, 1) * 4 + (aligned ? 4 : 0) + (q1.net >= 1.4 ? 3 : 0)), 45, 95);

  const plan = { entry, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) };
  return {
    module: 'LT', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
    single: false, conf, retest: false, holdSec: 0, maxAgeMs: 8 * H1,
    info: {
      tf, source: 'math', plan, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2),
      atr: rp(atr), atrPct: +(atr / entry * 100).toFixed(2), upper: rp(up), lower: rp(dn),
      level: rp(line), barAgeMin: Math.max(0, Math.round(closedAge / M1)), firstBreak: true,
      upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct,
      maturity: tri.maturity, compression: tri.compression, touches: tri.touchesH + tri.touchesL,
      apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1), score: tri.score, shape: tri.shape, spanBars: tri.spanBars,
      volRatio: +vr.toFixed(2), bodyRatio: +br.toFixed(2), bodyAtr: +ba.toFixed(2),
      aligned4h: aligned, breakoutUp: dir === 'LONG', breakoutDn: dir === 'SHORT',
      pivots: tri.highs.map(q => ({ t: q.t, p: rp(q.p), side: 'H' })).concat(tri.lows.map(q => ({ t: q.t, p: rp(q.p), side: 'L' })))
    },
    setupKey: 'LT|' + sym + '|' + tri.firstT + '|' + last.t + '|' + dir
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
  WATCH_META.lt = { scannedAt: lastScan.lt || Date.now(), count: WATCH.lt.length, universe: LT_UNIVERSE.last || UNIVERSE.length };
}

const LT_UNIVERSE = { last: 0 };
let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const list = scanSyms('LT', 36);
    LT_UNIVERSE.last = list.length;
    const found = [];
    await pool(list, 3, async (sym) => {
      const cs = await getLong2h(sym, LT_BARS);
      if (!cs || cs.length < 150) return;
      const tri = analyzeTriangle(cs, '2h');
      if (!tri) { LT_CACHE.delete(sym); return; }
      const old = LT_CACHE.get(sym);
      LT_CACHE.set(sym, { sym, tf: '2h', cs, tri, at: Date.now(), barAt: Date.now(), ai: old ? old.ai : null });
      const raw = ltSignalFrom(sym, cs, tri.tf, tri);
      if (raw) found.push(raw);
    });
    found.sort((a, b) => b.conf - a.conf);
    for (const raw of found.slice(0, 4)) {
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 3 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); log('LT KIRILIM: ' + sig.base + ' ' + sig.dir + ' | ' + (raw.info.shape || '') + ' | güven ' + sig.conf + ' | net R:R ' + sig.info.netRR); }
    }
    buildLtWatch();
    lastScan.lt = Date.now();
  } catch (e) { log('LT tarama hatası: ' + redact(e.message)); }
  finally { ltScanning = false; }
}

// ltTick artık BAYAT mumla sinyal üretmez. Sadece çizgiye yakın üçgenlerin
// mumlarını tazeler ve "az önce kapanan mum" kırılımını yakalar.
let ltTicking = false;
async function ltTick() {
  if (ltTicking || ltScanning) return;
  ltTicking = true;
  try {
    const now = Date.now();
    const near = [];
    for (const [sym, e] of LT_CACHE) {
      if (!e || !e.tri || !e.cs || !e.cs.length) continue;
      const t = TICK.get(sym);
      const px = t && t.last > 0 ? t.last : e.cs[e.cs.length - 1].c;
      const atr = e.tri.atr || 0;
      if (!(atr > 0)) continue;
      const up = triUpperAt(e.tri, e.cs.length - 1), dn = triLowerAt(e.tri, e.cs.length - 1);
      const dist = Math.min(Math.abs(up - px), Math.abs(px - dn));
      if (dist > 1.25 * atr) continue;
      near.push({ sym, e, dist });
    }
    near.sort((a, b) => a.dist - b.dist);
    let budget = 8;
    for (const item of near) {
      const stale = now - (item.e.barAt || 0) > 75e3;
      if (stale && budget > 0) {
        budget--;
        try {
          const cs = await getLong2h(item.sym, LT_BARS);
          if (cs && cs.length >= 150) { item.e.cs = cs; item.e.barAt = now; }
        } catch (err) { /* tek coin hatası taramayı durdurmaz */ }
      }
      const raw = ltSignalFrom(item.sym, item.e.cs, item.e.tri.tf, item.e.tri);
      if (!raw) continue;
      const prev = FIRED.get(raw.setupKey);
      if (prev && now - prev < 3 * H1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, now); log('LT KIRILIM (taze mum): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf); }
    }
    buildLtWatch();
    lastScan.tick = now;
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
/* ── TREND TAKİP (PUMP modülü) ────────────────────────────────────────────────
   1 saatlik rejim: EMA21 > EMA55 > EMA200 + ADX/DI + EMA21 eğimi.
   Giriş 15 dakikada: trend yönünde geri çekilme + son kapanmış mumun yapı
   kırılımı. Yalnızca trend yönünde sinyal üretir; yatay/kararsız piyasada susar.
   Eski "Pullback 5R" mantığı tamamen kaldırıldı: geri çekilmenin dibine körlemesine
   girmek yerine trendin devamını teyit eden kırılım beklenir. */

function trendRegime(h1) {
  if (!h1 || h1.length < 210) return null;
  const cl = closesOf(h1), i = cl.length - 1;
  const atr = atrLast(h1, 14);
  if (!atr || atr <= 0) return null;
  const e21 = emaArr(cl, 21), e55 = emaArr(cl, 55), e200 = emaArr(cl, 200);
  const adxObj = adxLast(h1, 14);
  const slopeAtr = (e21[i] - e21[i - 8]) / atr;
  const px = cl[i];
  const up = e21[i] > e55[i] && e55[i] > e200[i] && px > e55[i] && slopeAtr > 0.08;
  const dn = e21[i] < e55[i] && e55[i] < e200[i] && px < e55[i] && slopeAtr < -0.08;
  let dir = up ? 'LONG' : dn ? 'SHORT' : null;
  if (dir) {
    if (!adxObj) dir = null;
    else if (adxObj.adx < 17) dir = null;
    else if (dir === 'LONG' && adxObj.plusDI <= adxObj.minusDI) dir = null;
    else if (dir === 'SHORT' && adxObj.minusDI <= adxObj.plusDI) dir = null;
  }
  return {
    dir, atr, px, slopeAtr: +slopeAtr.toFixed(2),
    e21: e21[i], e55: e55[i], e200: e200[i], atrPct: +(atr / px * 100).toFixed(2),
    adx: adxObj ? +adxObj.adx.toFixed(1) : null,
    plusDI: adxObj ? +adxObj.plusDI.toFixed(1) : null,
    minusDI: adxObj ? +adxObj.minusDI.toFixed(1) : null
  };
}

function scalpContext(sym, cs, opt) {
  if (!cs || cs.length < 80) return null;
  opt = opt || {};
  const n = cs.length, last = cs[n - 1];
  const now = Number(opt.now) > 0 ? Number(opt.now) : Date.now();
  const px = Number(opt.price) > 0 ? Number(opt.price) : (priceOf(sym) || last.c);
  if (!(px > 0)) return null;

  // 1h mumları: mümkünse hazır veri, yoksa 15m mumlardan türetilir.
  const h1 = (opt.h1 && opt.h1.length >= 210) ? opt.h1 : closed(aggTF(cs.slice(-960), 4, M15), H1);
  const reg = trendRegime(h1);
  if (!reg) return null;

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
  const spread = Number(opt.spread) >= 0 ? Number(opt.spread) : spreadPct(sym);
  const atrPct = atr / px * 100;
  const e50Slope = e50[n - 7] ? (e50[n - 1] - e50[n - 7]) / e50[n - 7] * 100 : 0;
  return {
    sym, cs, h1, reg, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi,
    marketDir: ['LONG', 'SHORT', 'NOTR'].includes(opt.marketDir) ? opt.marketDir : market.dir,
    adx: adxObj ? adxObj.adx : null, plusDI: adxObj ? adxObj.plusDI : null, minusDI: adxObj ? adxObj.minusDI : null,
    volSma, volRatio, vwap: vw.vwap, vwapSd: vw.sd, session, spread, e50Slope,
    body: bodyRatio(last), ba: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr,
    htf: reg.dir === 'LONG' ? 'YUKARI' : reg.dir === 'SHORT' ? 'ASAGI' : 'YATAY'
  };
}


function rrNet(entry, sl, tp, costPct) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const cost = Number.isFinite(Number(costPct)) ? Number(costPct) : EX.COST;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - cost) / (risk + cost) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}
function targetDistanceForNetR(entry, riskPct, netR) {
  return entry * (EX.COST + netR * (riskPct + EX.COST)) / 100;
}
function moduleRiskOk(module, riskPct, tolerance) {
  const c = STRAT[module] || STRAT.PUMP;
  const pad = num(tolerance, 0);
  return riskPct + 1e-9 >= c.minRiskPct - pad && riskPct - 1e-9 <= c.maxRiskPct + pad;
}

function computeScalpStop(cs, dir, entry, atr, bars) {
  const k = Math.max(3, Math.round(num(bars, 8)));
  const sw = cs.slice(-k);
  if (sw.length < 3 || !(atr > 0)) return null;
  const d = dir === 'LONG' ? 1 : -1;
  // Trend işleminde stop, son yapının hemen dışında: fitil avına karşı 0.30 ATR pay.
  const structural = dir === 'LONG'
    ? Math.min.apply(null, sw.map(c => c.l)) - 0.30 * atr
    : Math.max.apply(null, sw.map(c => c.h)) + 0.30 * atr;
  let sl = structural;
  let riskPct = Math.abs(entry - sl) / entry * 100;

  if (riskPct < STRAT.PUMP.minRiskPct) {
    const minSl = entry - d * (entry * STRAT.PUMP.minRiskPct / 100);
    if (dir === 'LONG' ? minSl < sl : minSl > sl) sl = minSl;
    riskPct = Math.abs(entry - sl) / entry * 100;
  }
  if (!moduleRiskOk('PUMP', riskPct)) return null;
  return { sl: rp(sl), riskPct: +riskPct.toFixed(3) };
}

function computeScalpTps(entry, sl, dir) {
  const d = dir === 'LONG' ? 1 : -1;
  const riskPct = Math.abs(entry - sl) / entry * 100;
  if (!(riskPct > 0)) return null;
  const risk1Px = entry * riskPct / 100;
  const tp1Dist = Math.max(STRAT.PUMP.tp1GrossR * risk1Px, targetDistanceForNetR(entry, riskPct, STRAT.PUMP.tp1NetR));
  const tp2Dist = Math.max(STRAT.PUMP.tp2GrossR * risk1Px, targetDistanceForNetR(entry, riskPct, STRAT.PUMP.tp2NetR));
  const tp1 = rp(entry + d * tp1Dist);
  const tp2 = rp(entry + d * tp2Dist);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net + 1e-6 < STRAT.PUMP.tp1NetR || q2.net + 1e-6 < STRAT.PUMP.tp2NetR) return null;
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
  if (!moduleRiskOk('PUMP', riskPct)) return null;
  return {
    setup, dir, entry, sl: rp(sl), tp1: tps.tp1, tp2: tps.tp2, holdMs,
    score: clamp(Math.round(score), 0, 100),
    riskPct: +riskPct.toFixed(2), netRR: tps.netRR, netRR2: tps.netRR2,
    reasons: reasons.filter(Boolean).slice(0, 6), risks: risks.filter(Boolean).slice(0, 4),
    trigger: rp(trigger || entry), distPct: +num(distPct, 0).toFixed(2), triggered: !!triggered
  };
}

function trendEntry(ctx, dir) {
  const { cs, n, atr, px } = ctx;
  const d = dir === 'LONG' ? 1 : -1;
  const last = cs[n - 1];
  if (!last || n < 40) return null;
  const e21 = ctx.e20[n - 1], e55 = ctx.e50[n - 1];

  // 1) Geri çekilme oldu mu? Son 14 mum içinde fiyat EMA20/EMA50 bölgesine değdi mi?
  const look = cs.slice(-15, -1);
  if (look.length < 10) return null;
  const zoneHi = Math.max(e21, e55) + 0.50 * atr;
  const zoneLo = Math.min(e21, e55) - 0.50 * atr;
  if (!look.some(c => c.l <= zoneHi && c.h >= zoneLo)) return null;

  // 2) Yapı kırılımı: son KAPANMIŞ 15m mum, 8 mumluk yapıyı trend yönünde kırdı mı?
  const prior = cs.slice(-9, -1);
  const level = dir === 'LONG' ? Math.max.apply(null, prior.map(c => c.h)) : Math.min.apply(null, prior.map(c => c.l));
  if (!(d * (last.c - level) > 0)) return null;

  // 3) Mum kalitesi ve hacim teyidi
  if (d * (last.c - last.o) <= 0) return null;
  const br = bodyRatio(last), ba = bodyAtr(last, atr);
  if (br < 0.35 || ba < 0.28) return null;
  if (!(ctx.volRatio >= 1.10)) return null;

  // 4) Aşırı uzamış trendde kovalamaca yok
  const extAtr = d * (px - e21) / atr;
  if (extAtr < -0.20 || extAtr > 2.60) return null;

  // 5) RSI aşırı bölgede değil
  if (ctx.rsi != null) {
    if (dir === 'LONG' && ctx.rsi > 78) return null;
    if (dir === 'SHORT' && ctx.rsi < 22) return null;
  }

  // 6) Son 15 mumda yeterli sarsıntı var mı? (donmuş piyasada trend işlemi açılmaz)
  const win = cs.slice(-15);
  const swing = (Math.max.apply(null, win.map(c => c.h)) - Math.min.apply(null, win.map(c => c.l))) / atr;
  if (swing < 0.80) return null;

  return {
    level: rp(level), extAtr: +extAtr.toFixed(2), body: +br.toFixed(2), bodyAtr: +ba.toFixed(2),
    volRatio: +ctx.volRatio.toFixed(2), swingAtr: +swing.toFixed(2)
  };
}

function scalpCandidates(ctx) {
  const out = [];
  const dir = ctx.reg && ctx.reg.dir;
  if (!dir) return out;
  // Piyasa yönü belirginse trende karşı işlem aranmaz.
  if (ctx.marketDir !== 'NOTR' && ctx.marketDir !== dir) return out;

  const e = trendEntry(ctx, dir);
  if (!e) return out;

  const score = 58
    + clamp((ctx.reg.adx || 0) - 17, 0, 20) * 0.60
    + clamp(ctx.reg.slopeAtr, 0, 3) * 3
    + clamp(e.volRatio - 1, 0, 1) * 8
    + clamp(e.bodyAtr - 0.28, 0, 1) * 10
    + clamp(1 - Math.max(0, e.extAtr) / 2.6, 0, 1) * 6;
  const reasons = [
    '1h trend ' + (dir === 'LONG' ? 'yukarı' : 'aşağı') + ' (EMA21/55/200 dizili)',
    'ADX ' + (ctx.reg.adx != null ? ctx.reg.adx : '-') + ' · ' + (dir === 'LONG' ? '+DI' : '-DI') + ' baskın',
    '15m geri çekilme + yapı kırılımı (' + e.level + ')',
    'Hacim ' + e.volRatio + 'x · gövde ' + e.bodyAtr + ' ATR'
  ];
  const risks = [];
  if (e.extAtr > 1.8) risks.push('EMA20\'den uzak (' + e.extAtr + ' ATR)');
  if (ctx.rsi != null && ((dir === 'LONG' && ctx.rsi > 70) || (dir === 'SHORT' && ctx.rsi < 30))) risks.push('RSI aşırı bölgede (' + Math.round(ctx.rsi) + ')');

  const distPct = +(((ctx.px - e.level) * (dir === 'LONG' ? 1 : -1) / ctx.px) * 100).toFixed(2);
  const cand = makeScalpCandidate(ctx, 'TREND', dir, ctx.px, 0, 0, 0, 8 * H1, score, reasons, risks, e.level, distPct, true);
  if (!cand) return out;
  cand.info = e;
  out.push(cand);
  return out;
}

function trendWatchRow(ctx) {
  const dir = ctx.reg && ctx.reg.dir;
  if (!dir) return null;
  if (ctx.marketDir !== 'NOTR' && ctx.marketDir !== dir) return null;
  const d = dir === 'LONG' ? 1 : -1;
  const n = ctx.n;
  const e21 = ctx.e20[n - 1], e55 = ctx.e50[n - 1];
  const distAtr = d * (ctx.px - e21) / ctx.atr;
  // Sadece EMA bölgesine yakın (geri çekilme adayı) coinler izlemeye alınır.
  if (distAtr < -0.80 || distAtr > 1.80) return null;
  const prior = ctx.cs.slice(-9, -1);
  if (prior.length < 4) return null;
  const level = dir === 'LONG' ? Math.max.apply(null, prior.map(c => c.h)) : Math.min.apply(null, prior.map(c => c.l));
  const score = clamp(Math.round(52 + (ctx.reg.adx || 0) * 0.40 + clamp(ctx.reg.slopeAtr, 0, 3) * 3), 0, 90);
  return {
    symbol: ctx.sym, base: baseOf(ctx.sym), tf: '1h', price: rp(ctx.px), setup: 'TREND', dir,
    score, status: 'BEKLİYOR', state: 'TREND İZLEME',
    trigger: rp(level), distPct: +(((level - ctx.px) * d / ctx.px) * 100).toFixed(2),
    volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
    mom1: +(((ctx.last.c / ctx.cs[n - 2].c - 1) * 100)).toFixed(2),
    mom3: +(((ctx.last.c / ctx.cs[Math.max(0, n - 4)].c - 1) * 100)).toFixed(2),
    rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.reg.adx != null ? Math.round(ctx.reg.adx) : null,
    vwap: rp(ctx.vwap), ema20: rp(e21), ema50: rp(e55), ema200: rp(ctx.reg.e200),
    spreadPct: +ctx.spread.toFixed(3),
    reason: '1h trend ' + (dir === 'LONG' ? 'yukarı' : 'aşağı') + ' · EMA bölgesinde tetik bekleniyor',
    ai: null
  };
}

function scalpAnalyze(sym, cs, opt) {
  const ctx = scalpContext(sym, cs, opt);
  if (!ctx) return null;
  if (ctx.atrPct < 0.20 || ctx.atrPct > 4.0) return null;
  if (ctx.spread > settings.maxSpreadPct) return null;
  if (!ctx.reg.dir) return null;
  const n = ctx.n;
  const cands = scalpCandidates(ctx).filter(Boolean);
  if (cands.length) {
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    const row = {
      symbol: sym, base: baseOf(sym), tf: '1h', price: rp(ctx.px), setup: 'TREND', dir: best.dir,
      score: best.score, status: 'TETİK', state: 'ADAY SİNYAL',
      trigger: best.trigger, distPct: best.distPct, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2),
      mom1: +(((ctx.last.c / ctx.cs[n - 2].c - 1) * 100)).toFixed(2),
      mom3: +(((ctx.last.c / ctx.cs[Math.max(0, n - 4)].c - 1) * 100)).toFixed(2),
      rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.reg.adx != null ? Math.round(ctx.reg.adx) : null,
      vwap: rp(ctx.vwap), ema20: rp(ctx.e20[n - 1]), ema50: rp(ctx.e50[n - 1]), ema200: rp(ctx.reg.e200),
      spreadPct: +ctx.spread.toFixed(3), reason: best.reasons[0] || '', ai: null
    };
    const raw = {
      module: 'PUMP', symbol: sym, base: baseOf(sym), dir: best.dir,
      entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2,
      single: false, conf: clamp(best.score, 45, 95), retest: false,
      holdSec: Math.round(best.holdMs / 1000), noMoveSec: 30 * 60,
      info: {
        tf: '1h', source: 'math', setup: 'TREND',
        plan: { entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2 },
