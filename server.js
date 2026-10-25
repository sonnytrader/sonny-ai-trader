'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   AlphaSon v84.1 — 3 Modül + Canlı İşlem + AI Piyasa Yönü (Yamalı)
   AUTO (OtoTrade) · LT Üçgen · Günlük Hızlı Scalp
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
  } catch (e) { }
})();

const VERSION = 'v84.1';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60 * 1000, M3 = 3 * M1, M5 = 5 * M1, M15 = 15 * M1;
const H1 = 60 * M1, H2 = 2 * H1, H4 = 4 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '2h': H2, '4h': H4, '1d': D1 };
const TTL = { '1m': 15e3, '3m': 30e3, '5m': 45e3, '15m': 90e3, '1h': 5 * M1, '2h': 10 * M1, '4h': 15 * M1, '1d': 30 * M1 };
const EPS = 1e-9;

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) {
    const alt = path.join(os.tmpdir(), 'alphason-v84');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) { }
    return alt;
  }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);

/* v84.1 — Yamalı AI Sağlayıcı Listesi (badModels eklendi, pro/mixtral çıkarıldı) */
const AI_PROV = [
  { id: 'gemini', name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '', models: ['gemini-1.5-flash', 'gemini-2.0-flash'], prefer: 1, ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, badModels: {} },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '', models: ['deepseek-chat'], prefer: 2, ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, badModels: {} },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], prefer: 3, ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, badModels: {} },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY || '', models: ['deepseek/deepseek-chat-v3-0324:free', 'meta-llama/llama-3.3-70b-instruct:free'], prefer: 4, ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, badModels: {} },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '', models: ['gpt-4o-mini'], prefer: 5, ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, badModels: {} }
];

const AI_USAGE = { dayKey: new Date().toISOString().slice(0, 10), dayCount: 0, hourKey: Math.floor(Date.now() / H1), hourCount: 0, briefDay: new Date().toISOString().slice(0, 10), briefCount: 0 };
const AI_QUEUE = [];
const AI_HIST = [];
const AI_STATE = { busy: false, lastAt: 0, lastError: null };

const EX = { FEE: 0.0006, SLIP: 0.0004, H: 0.20, MIN_RR1: 0.70, MIN_RR2: 1.30, MAX_RISK_PCT: 3.5, MIN_RISK_PCT: 0.45 };

const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade', tf: '5m', chartTf: '5m', enabled: true, tradeable: true, maxPerDaySym: 4, cooldown: 30 * M1, maxAge: 2 * H1 },
  LT: { key: 'LT', label: 'LT Üçgen', tf: '2h', chartTf: '2h', enabled: true, tradeable: false, maxPerDaySym: 2, cooldown: 3 * H1, maxAge: 18 * H1 },
  SCALP: { key: 'SCALP', label: 'Günlük Hızlı Scalp', tf: '5m', chartTf: '5m', enabled: true, tradeable: true, maxPerDaySym: 4, cooldown: 45 * M1, maxAge: 2 * H1 }
};
const ACTIVE_MODULES = ['AUTO', 'LT', 'SCALP'];

const SKIP_RESULTS = new Set(['DOLMADI', 'AI_RED', 'AI_ERROR', 'AI_TIMEOUT', 'AI_STALE', 'APPROVAL_EXPIRED', 'SKIP', 'MATH_ONLY']);
const TRADE_RESULTS = new Set(['TP1', 'TP2', 'SL', 'BE', 'TIME', 'MANUEL', 'MOMENTUM', 'FADE']);
const RES = {
  TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL',
  MOMENTUM: 'İVME BİTTİ', FADE: 'KÂR GERİ VERİLDİ', DOLMADI: 'DOLMADI', AI_RED: 'AI GİRİLMEZ',
  AI_ERROR: 'AI YANITI YOK', AI_TIMEOUT: 'AI ZAMAN AŞIMI', AI_STALE: 'FİYAT KAÇTI',
  APPROVAL_EXPIRED: 'ONAY VERİLMEDİ', SKIP: 'ATLANDI', MATH_ONLY: 'MATEMATİK KARARI'
};

const DEF_SET = {
  auto: false, tradeMode: 'paper', margin: 100, leverage: 5, riskPct: 0.5, maxOpen: 3, dailyLossPct: 3, minConf: 55,
  aiEnabled: false, aiWatchAuto: false, costPct: EX.H, paperEquity: 1000, maxSpreadPct: 0.10, minQuoteVol: 5e6, topN: 60,
  liveMaxMargin: 50, liveMaxLeverage: 5
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rp = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n >= 1000) return +n.toFixed(2); if (n >= 1) return +n.toFixed(4); if (n >= 0.01) return +n.toFixed(6); return +n.toFixed(8); };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const utcDayStart = ts => Math.floor((ts || Date.now()) / D1) * D1;

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.auto = s.auto === true;
  s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.margin = clamp(num(s.margin, DEF_SET.margin), 10, 100000);
  s.leverage = clamp(Math.round(num(s.leverage, DEF_SET.leverage)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, DEF_SET.riskPct), 0.05, 5);
  s.maxOpen = clamp(Math.round(num(s.maxOpen, DEF_SET.maxOpen)), 1, 20);
  s.dailyLossPct = clamp(num(s.dailyLossPct, DEF_SET.dailyLossPct), 0.5, 50);
  s.minConf = clamp(Math.round(num(s.minConf, DEF_SET.minConf)), 30, 95);
  s.aiEnabled = s.aiEnabled === true;
  s.aiWatchAuto = s.aiWatchAuto === true;
  s.costPct = EX.H;
  s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9);
  s.maxSpreadPct = clamp(num(s.maxSpreadPct, DEF_SET.maxSpreadPct), 0.01, 1);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 1e5, 1e9);
  s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 10, 150);
  s.liveMaxMargin = clamp(num(s.liveMaxMargin, DEF_SET.liveMaxMargin), 5, 1000);
  s.liveMaxLeverage = clamp(Math.round(num(s.liveMaxLeverage, DEF_SET.liveMaxLeverage)), 1, 20);
  return s;
}

let settings = sanitizeSettings({});
let signals = [];
let paper = { open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity, dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity };
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };
let REJ = [];
let OUT = [];
let OPP = new Map();
let WATCH = { lt: [], scalp: [], auto: [] };
let WATCH_META = { lt: null, scalp: null, auto: null };
let LT_CACHE = new Map();
let AUTO_CACHE = new Map();
let FIRED = new Map();
let REJ_STAT = {};
let seq = 0;
let lastScan = { scalp: 0, lt: 0, auto: 0, tick: 0 };
let dirty = false;
let READY = false;
let market = { dir: 'NOTR', score: 0.5, breadth: 0.5, why: 'veri bekleniyor', btc: null, eth: null, at: 0 };
let marketBrief = null;
let lastMarketAI = 0;
let lastMarketAIDir = null;

function capArr(a, n) { if (Array.isArray(a) && a.length > n) a.splice(0, a.length - n); return a; }
function capMap(m, n) { while (m.size > n) { const k = m.keys().next().value; m.delete(k); } }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (j && Array.isArray(j.signals)) signals = j.signals.filter(s => s && ACTIVE_MODULES.includes(s.module)).slice(-500);
    if (j && j.paper) {
      paper = Object.assign(paper, j.paper);
      paper.open = Array.isArray(paper.open) ? paper.open.filter(p => p && ACTIVE_MODULES.includes(p.module)).slice(0, 50) : [];
      paper.closed = Array.isArray(paper.closed) ? paper.closed.filter(p => p && ACTIVE_MODULES.includes(p.module)).slice(-300) : [];
      paper.equity = num(paper.equity, DEF_SET.paperEquity);
      paper.start = num(paper.start, DEF_SET.paperEquity);
      paper.peak = num(paper.peak, paper.equity);
    }
    if (j && Array.isArray(j.rej)) REJ = j.rej.slice(-200);
    if (j && Array.isArray(j.out)) OUT = j.out.slice(-300);
    if (j && j.rejStat) REJ_STAT = j.rejStat;
    if (j && Number.isFinite(Number(j.seq))) seq = Number(j.seq);
    if (j && j.aiUsage) Object.assign(AI_USAGE, j.aiUsage);
    if (j && j.marketBrief) marketBrief = j.marketBrief;
    log('Durum yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık paper işlem');
  } catch (e) { log('Durum yüklenemedi: ' + e.message); }
}

function saveState(force) {
  if (!dirty && !force) return;
  try {
    const j = { version: VERSION, at: Date.now(), settings, signals: signals.slice(-500), paper, rej: REJ.slice(-200), out: OUT.slice(-300), rejStat: REJ_STAT, seq, aiUsage: AI_USAGE, marketBrief };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { log('Durum kaydedilemedi: ' + e.message); }
}

const LOGS = [];
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  LOGS.push({ t: Date.now(), msg: String(msg).slice(0, 500) });
  if (LOGS.length > 400) LOGS.splice(0, LOGS.length - 400);
}
function redact(s) {
  let x = String(s == null ? '' : s);
  for (const p of AI_PROV) if (p.key) x = x.split(p.key).join('[KEY]');
  if (API_KEY) x = x.split(API_KEY).join('[KEY]');
  if (API_SECRET) x = x.split(API_SECRET).join('[KEY]');
  return x.slice(0, 600);
}

function emaArr(vals, len) {
  const out = new Array(vals.length).fill(null); const k = 2 / (len + 1); let prev = null;
  for (let i = 0; i < vals.length; i++) { const v = Number(vals[i]); if (!Number.isFinite(v)) { out[i] = prev; continue; } prev = prev == null ? v : v * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function emaLast(vals, len) { const a = emaArr(vals, len); return a.length ? a[a.length - 1] : null; }
function rsiLast(closes, len = 14) {
  if (!closes || closes.length < len + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain / len, al = loss / len;
  for (let i = len + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (len - 1) + Math.max(d, 0)) / len; al = (al * (len - 1) + Math.max(-d, 0)) / len; }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atrArr(cs, len = 14) {
  const out = new Array(cs.length).fill(null); if (cs.length < len + 1) return out;
  const tr = cs.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)));
  let a = avg(tr.slice(1, len + 1)); out[len] = a;
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
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  let trS = avg(tr.slice(0, len)), pS = avg(pdm.slice(0, len)), nS = avg(ndm.slice(0, len));
  const dx = []; let pDI = 0, nDI = 0;
  for (let i = len; i < tr.length; i++) {
    trS = (trS * (len - 1) + tr[i]) / len; pS = (pS * (len - 1) + pdm[i]) / len; nS = (nS * (len - 1) + ndm[i]) / len;
    pDI = trS > 0 ? 100 * pS / trS : 0; nDI = trS > 0 ? 100 * nS / trS : 0;
    const s = pDI + nDI; dx.push(s > 0 ? 100 * Math.abs(pDI - nDI) / s : 0);
  }
  if (dx.length < len) return null;
  const adx = avg(dx.slice(-len));
  return { adx, plusDI: pDI, minusDI: nDI };
}
function vwapOf(cs, sinceMs) {
  if (!cs || !cs.length) return { vwap: null, sd: null, n: 0 };
  let use = cs.filter(c => c.t >= sinceMs); if (use.length < 6) use = cs.slice(-100);
  let pv = 0, vv = 0;
  for (const c of use) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; vv += c.v; }
  if (!(vv > 0)) return { vwap: null, sd: null, n: use.length };
  const vwap = pv / vv; let varSum = 0;
  for (const c of use) { const tp = (c.h + c.l + c.c) / 3; varSum += c.v * (tp - vwap) * (tp - vwap); }
  const sd = Math.sqrt(varSum / vv);
  return { vwap, sd, n: use.length };
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
function linreg(pts) {
  const n = pts.length; if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of pts) { sx += q.x; sy += q.y; sxx += q.x * q.x; sxy += q.x * q.y; }
  const den = n * sxx - sx * sx; if (Math.abs(den) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / den; const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
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
  const out = []; const bucketMs = (srcTfMs || M1) * factor; let cur = null, bucket = null;
  for (const c of cs) {
    const b = Math.floor(c.t / bucketMs);
    if (bucket !== b) { if (cur) out.push(cur); bucket = b; cur = { t: b * bucketMs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  if (cur) out.push(cur);
  return out;
}

const ex = new ccxt.bitget({ apiKey: API_KEY || undefined, secret: API_SECRET || undefined, password: API_PASS || undefined, enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap', defaultSubType: 'linear' } });
const CACHE = new Map();
const TICK = new Map();
let UNIVERSE = [];
const FALLBACK = ['BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','XRP/USDT:USDT','DOGE/USDT:USDT','BNB/USDT:USDT','ADA/USDT:USDT','AVAX/USDT:USDT','LINK/USDT:USDT','SUI/USDT:USDT','TON/USDT:USDT','DOT/USDT:USDT','LTC/USDT:USDT','BCH/USDT:USDT','NEAR/USDT:USDT','APT/USDT:USDT','ARB/USDT:USDT','OP/USDT:USDT','INJ/USDT:USDT','TIA/USDT:USDT'];
const EXCLUDE = new Set(['USDC','USDT','DAI','FDUSD','TUSD','USDD','PYUSD','EUR','GBP','BUSD','BTC3L','BTC3S','ETH3L','ETH3S','SOL3L','SOL3S','XRP3L','XRP3S']);

async function pool(items, n, fn) {
  const list = items.slice(); let idx = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) { const i = idx++; try { await fn(list[i], i); } catch (e) { } }
  });
  await Promise.all(workers);
}
function tick(sym) { return TICK.get(sym) || null; }
function priceOf(sym) {
  const t = tick(sym); if (t && t.last > 0) return t.last;
  const c = CACHE.get(sym + '|1m'); if (c && c.data && c.data.length) return c.data[c.data.length - 1].c;
  return 0;
}
function spreadPct(sym) {
  const t = tick(sym); if (!t || !(t.bid > 0) || !(t.ask > 0)) return 99;
  return (t.ask - t.bid) / t.bid * 100;
}

async function refreshUniverse() {
  try {
    const all = await ex.fetchTickers(); const rows = [];
    for (const sym of Object.keys(all)) {
      if (!sym.endsWith('/USDT:USDT')) continue;
      const b = baseOf(sym); if (EXCLUDE.has(b)) continue;
      const t = all[sym] || {}; const last = num(t.last), qv = num(t.quoteVolume), bid = num(t.bid), ask = num(t.ask);
      if (!(last > 0) || qv < settings.minQuoteVol) continue;
      const sp = bid > 0 && ask > 0 ? (ask - bid) / bid * 100 : 99;
      if (sp > settings.maxSpreadPct) continue;
      TICK.set(sym, { last, bid, ask, qv, chg: num(t.percentage), ts: Date.now() });
      rows.push({ sym, qv });
    }
    rows.sort((a, b) => b.qv - a.qv);
    const next = rows.slice(0, settings.topN).map(r => r.sym);
    if (next.length) { UNIVERSE = next; log('Evren güncellendi: ' + UNIVERSE.length + ' coin'); }
  } catch (e) { log('Evren alınamadı: ' + redact(e.message)); if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice(); }
  if (!UNIVERSE.length) UNIVERSE = FALLBACK.slice();
}

async function refreshTickers() {
  try {
    const all = await ex.fetchTickers();
    for (const sym of Object.keys(all)) {
      if (!sym.endsWith('/USDT:USDT')) continue;
      if (UNIVERSE.length && !UNIVERSE.includes(sym) && !FALLBACK.includes(sym)) continue;
      const t = all[sym] || {}; const last = num(t.last), bid = num(t.bid), ask = num(t.ask);
      if (!(last > 0)) continue;
      TICK.set(sym, { last, bid, ask, qv: num(t.quoteVolume), chg: num(t.percentage), ts: Date.now() });
    }
  } catch (e) { }
}

async function fetchRealBalance() {
  if (!HAS_KEYS) return;
  try {
    const bal = await ex.fetchBalance();
    const u = bal && bal['USDT'];
    if (u) realBal = { total: Number(u.total) || 0, free: Number(u.free) || 0, used: Number(u.used) || 0, updatedAt: Date.now(), error: null };
  } catch (e) { realBal.error = e.message; }
}

async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf; const now = Date.now(); const ent = CACHE.get(key);
  if (ent && now - ent.t < (TTL[tf] || 60e3) && ent.data.length >= Math.min(limit, 50)) return ent.data.slice(-limit);
  const tfMs = TF_MS[tf]; let data = null;
  try {
    if (tf === '2h') { const raw = await ex.fetchOHLCV(sym, '1h', undefined, Math.min(1000, limit * 2 + 4)); if (raw && raw.length) data = aggTF(raw.map(toC), 2, H1).slice(-limit); }
    else { const raw = await ex.fetchOHLCV(sym, tf, undefined, limit); if (raw && raw.length) data = raw.map(toC); }
  } catch (e) { if (ent && ent.data && ent.data.length) return ent.data.slice(-limit); return null; }
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
    let dir = 'NOTR', score = 0.5;
    if (btcUp && ethUp && breadth >= 0.55) { dir = 'LONG'; score = 0.5 + Math.min(0.3, (breadth - 0.5) * 0.6); }
    else if (!btcUp && !ethUp && breadth <= 0.45) { dir = 'SHORT'; score = 0.5 + Math.min(0.3, (0.5 - breadth) * 0.6); }
    else if (btcUp && breadth >= 0.5) { dir = 'LONG'; score = 0.55; }
    else if (!btcUp && breadth < 0.5) { dir = 'SHORT'; score = 0.55; }
    
    market = { dir, score: +score.toFixed(2), breadth: +breadth.toFixed(3), why: 'BTC ' + (btcUp ? 'yukarı' : 'aşağı') + ', ETH ' + (ethUp ? 'yukarı' : 'aşağı') + ', genişlik %' + Math.round(breadth * 100), btc: b, eth: e, at: Date.now() };

    if (aiReady()) {
      try {
        const aiDir = await aiMarketDirection();
        if (aiDir && (aiDir.dir === 'LONG' || aiDir.dir === 'SHORT' || aiDir.dir === 'NOTR')) {
          market.dir = aiDir.dir; market.score = aiDir.score;
          market.why = (market.why || '') + ' | AI: ' + aiDir.dir + ' (' + aiDir.reason + ')';
          market.aiAt = aiDir.at; market.aiProvider = aiDir.provider;
        }
      } catch (e) { }
    }
  } catch (e) { log('Piyasa rejimi hatası: ' + redact(e.message)); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   MODÜL 1: LT ÜÇGEN (Destek/Direnç + Sıkışma)
   ══════════════════════════════════════════════════════════════════════════════ */
function triUpperAt(tri, i) { return tri.hi.intercept + tri.hi.slope * (i - tri.refIdx); }
function triLowerAt(tri, i) { return tri.lo.intercept + tri.lo.slope * (i - tri.refIdx); }

function analyzeTriangle(cs, tf) {
  if (!cs || cs.length < 70) return null;
  const n = cs.length; const atr = atrLast(cs, 14); if (!atr || atr <= 0) return null;
  const px = cs[n - 1].c; const tfMs = TF_MS[tf] || H2;
  const pv = pivots(cs, 3, 3); const minIdx = Math.max(0, n - 130);
  let highs = pv.highs.filter(q => q.i >= minIdx).slice(-3); let lows = pv.lows.filter(q => q.i >= minIdx).slice(-3);
  if (highs.length < 2 || lows.length < 2) return null;
  if (highs.length >= 2 && highs[highs.length - 1].i - highs[highs.length - 2].i < 4) highs.pop();
  if (lows.length >= 2 && lows[lows.length - 1].i - lows[lows.length - 2].i < 4) lows.pop();
  if (highs.length < 2 || lows.length < 2) return null;
  const hi = linreg(highs.map(q => ({ x: q.i - (n - 1), y: q.p }))); const lo = linreg(lows.map(q => ({ x: q.i - (n - 1), y: q.p })));
  if (!hi || !lo) return null;
  const refIdx = n - 1; const upperNow = hi.intercept; const lowerNow = lo.intercept;
  if (!(upperNow > lowerNow)) return null;
  const widthNow = upperNow - lowerNow;
  if (widthNow < 0.55 * atr || widthNow > 14 * atr) return null;
  const conv = hi.slope - lo.slope; if (!(conv < -0.0015 * atr)) return null;
  const apexX = (lo.intercept - hi.intercept) / (hi.slope - lo.slope); if (!(apexX > 1.0) || apexX > 110) return null;
  const firstIdx = Math.min(highs[0].i, lows[0].i); const apexIdx = refIdx + apexX;
  const maturity = clamp((refIdx - firstIdx) / Math.max(1, apexIdx - firstIdx), 0, 1);
  if (maturity < 0.22) return null;
  const widthStart = triUpperAt({ hi, lo, refIdx }, firstIdx) - triLowerAt({ hi, lo, refIdx }, firstIdx);
  if (!(widthStart > 0)) return null;
  const compression = clamp(1 - widthNow / widthStart, 0, 1); if (compression < 0.07) return null;
  let touchesH = 0, touchesL = 0, resH = 0, resL = 0;
  for (const q of highs) { const d = Math.abs(q.p - triUpperAt({ hi, lo, refIdx }, q.i)); if (d <= 0.45 * atr) { touchesH++; resH += d; } }
  for (const q of lows) { const d = Math.abs(q.p - triLowerAt({ hi, lo, refIdx }, q.i)); if (d <= 0.45 * atr) { touchesL++; resL += d; } }
  if (touchesH < 2 || touchesL < 2) return null;
  const outside = px > upperNow + 0.9 * atr || px < lowerNow - 0.9 * atr;
  const vol20 = avg(cs.slice(-20).map(c => c.v)); const volPrev = avg(cs.slice(-50, -20).map(c => c.v));
  const volContraction = volPrev > 0 ? clamp(1 - vol20 / volPrev, -1, 1) : 0;
  const score = clamp(Math.round(38 + touchesH * 4 + touchesL * 4 + compression * 26 + maturity * 18 + clamp(volContraction, 0, 1) * 8 + (outside ? -12 : 0)), 0, 100);
  return { ok: true, tf, n, refIdx, atr, px, hi, lo, upperNow, lowerNow, widthNow, widthPct: +(widthNow / px * 100).toFixed(2), widthStart, compression: +compression.toFixed(3), maturity: +maturity.toFixed(3), apexX, apexIdx, apexAt: cs[refIdx].t + Math.round(apexX) * tfMs, firstIdx, firstT: cs[firstIdx].t, lastT: cs[refIdx].t, touchesH, touchesL, resH: +(resH / Math.max(1, touchesH) / atr).toFixed(3), resL: +(resL / Math.max(1, touchesL) / atr).toFixed(3), volContraction: +volContraction.toFixed(2), outside, score, highs, lows };
}

function srLevels(cs, atr, px) {
  if (!cs || cs.length < 40 || !(atr > 0) || !(px > 0)) return [];
  const pv = pivots(cs.slice(-220), 5, 5); const raw = [];
  for (const q of pv.highs) raw.push({ p: q.p, kind: 'R' });
  for (const q of pv.lows) raw.push({ p: q.p, kind: 'S' });
  const clusters = [];
  for (const r of raw) {
    let c = clusters.find(x => Math.abs(x.p - r.p) <= 0.5 * atr);
    if (!c) { c = { p: r.p, n: 0, kind: r.kind }; clusters.push(c); }
    c.p = (c.p * c.n + r.p) / (c.n + 1); c.n++; if (r.kind === 'R') c.kind = 'R';
  }
  const above = clusters.filter(c => c.p > px * 1.001).sort((a, b) => a.p - b.p).slice(0, 3);
  const below = clusters.filter(c => c.p < px * 0.999).sort((a, b) => b.p - a.p).slice(0, 3);
  return above.map(c => ({ v: rp(c.p), col: '#f6465d', l: 'DİRENÇ', kind: 'R', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) })).concat(below.map(c => ({ v: rp(c.p), col: '#0ecb81', l: 'DESTEK', kind: 'S', touches: c.n, distPct: +((c.p / px - 1) * 100).toFixed(2) })));
}

function ltSignalFrom(sym, cs, tf, tri, opt) {
  if (!tri || !tri.ok) return null;
  const n = cs.length, last = cs[n - 1];
  const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  const atr = tri.atr; const up = triUpperAt(tri, n - 1), dn = triLowerAt(tri, n - 1);
  const vol20 = avg(cs.slice(-20).map(c => c.v)); const vr = vol20 > 0 ? last.v / vol20 : 1;
  const upTouch = last.h >= up - 0.10 * atr || px >= up - 0.05 * atr; const dnTouch = last.l <= dn + 0.10 * atr || px <= dn + 0.05 * atr;
  const upClosed = last.c >= up - 0.03 * atr && last.c > last.o; const dnClosed = last.c <= dn + 0.03 * atr && last.c < last.o;
  const upLive = px >= up && last.o < up; const dnLive = px <= dn && last.o > dn;
  const upConfirm = upClosed || upLive; const dnConfirm = dnClosed || dnLive;
  if (!(upTouch && upConfirm) && !(dnTouch && dnConfirm)) return null;
  const dir = (upTouch && upConfirm && (!dnTouch || (px - up) >= (dn - px))) ? 'LONG' : 'SHORT';
  if (dir === 'LONG') { if (tri.maturity < 0.40 || tri.widthNow < 0.50 * atr) return null; if ((px - up) / atr > 0.85) return null; if (px < up - 0.35 * atr) return null; }
  else { if (tri.maturity < 0.40 || tri.widthNow < 0.50 * atr) return null; if ((dn - px) / atr > 0.85) return null; if (px > dn + 0.35 * atr) return null; }
  const liveOnly = dir === 'LONG' ? !upClosed : !dnClosed;
  let br = bodyRatio(last), ba = bodyAtr(last, atr);
  if (liveOnly) { const eff = { o: last.o, h: dir === 'LONG' ? Math.max(last.h, px) : last.h, l: dir === 'SHORT' ? Math.min(last.l, px) : last.l, c: px }; br = Math.max(br, bodyRatio(eff)); ba = Math.max(ba, bodyAtr(eff, atr)); }
  if (br < 0.26 || ba < 0.22) return null;
  if (vr < (liveOnly ? 0.85 : 1.00)) return null;
  const d = dir === 'LONG' ? 1 : -1; const entry = rp(px); const sw = cs.slice(-6);
  let swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.35 * atr; let risk = Math.abs(entry - sl);
  if (risk < 0.55 * atr) { sl = entry - d * 0.55 * atr; risk = Math.abs(entry - sl); }
  const riskPct = risk / entry * 100; if (riskPct < 0.45 || riskPct > EX.MAX_RISK_PCT) return null;
  const height = Math.max(tri.widthNow, 1.15 * risk);
  let tp1 = entry + d * Math.max(0.55 * height, 1.25 * risk); let tp2 = entry + d * Math.max(0.95 * height, 2.00 * risk);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2); if (q1.net < 0.75 || q2.net < 1.35) return null;
  const d1Up = (() => { if (cs.length < 130) return null; const agg = aggTF(cs.slice(-120), 2, H2); if (agg.length < 60) return null; const cl = closesOf(agg), e = emaArr(cl, 20); return e[e.length - 1] > e[e.length - 6]; })();
  const aligned = d1Up == null ? false : (dir === 'LONG' ? d1Up : !d1Up);
  const conf = clamp(Math.round(52 + tri.maturity * 15 + tri.compression * 18 + (tri.touchesH + tri.touchesL) * 2 + clamp(vr - 1, 0, 1) * 4 + (aligned ? 4 : 0) + (q1.net >= 1.1 ? 3 : 0)), 45, 95);
  const plan = { entry, sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2) };
  return { module: 'LT', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, single: false, conf, retest: false, holdSec: 0, info: { tf, source: 'math', plan, netRR: q1.net, netRR2: q2.net, riskPct: +riskPct.toFixed(2), atr: rp(atr), atrPct: +(atr / entry * 100).toFixed(2), upper: rp(up), lower: rp(dn), upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct, maturity: tri.maturity, compression: tri.compression, touches: tri.touchesH + tri.touchesL, apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1), score: tri.score, volRatio: +vr.toFixed(2), bodyRatio: +br.toFixed(2), bodyAtr: +ba.toFixed(2), aligned4h: aligned, breakoutUp: dir === 'LONG', breakoutDn: dir === 'SHORT', pivots: tri.highs.concat(tri.lows).map(q => ({ t: q.t, p: rp(q.p), side: tri.highs.includes(q) ? 'H' : 'L' })) }, setupKey: 'LT|' + sym + '|' + tri.firstT + '|' + Math.round(tri.apexAt) + '|' + dir };
}

let ltScanning = false;
async function ltScan() {
  if (ltScanning) return; ltScanning = true;
  try {
    const list = UNIVERSE.slice(0, 40); const found = [];
    await pool(list, 4, async (sym) => {
      const cs = await getCandles(sym, '2h', 200, true); if (!cs || cs.length < 90) return;
      const tri = analyzeTriangle(cs, '2h'); if (!tri) { LT_CACHE.delete(sym); return; }
      LT_CACHE.set(sym, { sym, tf: '2h', cs, tri, at: Date.now() });
      const raw = ltSignalFrom(sym, cs, tri.tf, tri); if (raw) found.push(raw);
    });
    found.sort((a, b) => b.conf - a.conf);
    for (const raw of found.slice(0, 4)) {
      const key = raw.setupKey; const prev = FIRED.get(key); if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw); if (sig) { FIRED.set(key, Date.now()); log('LT KIRILIM: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net R:R ' + sig.info.netRR); }
    }
    buildLtWatch(); lastScan.lt = Date.now();
  } catch (e) { log('LT tarama hatası: ' + redact(e.message)); } finally { ltScanning = false; }
}

let ltTicking = false;
function ltTick() {
  if (ltTicking) return; ltTicking = true;
  try {
    for (const [sym, e] of LT_CACHE) {
      if (Date.now() - e.at > 20 * M1) continue;
      const raw = ltSignalFrom(sym, e.cs, e.tri.tf, e.tri); if (!raw) continue;
      const prev = FIRED.get(raw.setupKey); if (prev && Date.now() - prev < 6 * H1) continue;
      const sig = addSignal(raw); if (sig) { FIRED.set(raw.setupKey, Date.now()); log('LT CANLI KIRILIM: ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf); }
    }
    buildLtWatch(); lastScan.tick = Date.now();
  } catch (e) { } finally { ltTicking = false; }
}

function buildLtWatch() {
  const rows = [];
  for (const [sym, e] of LT_CACHE) {
    const { tri, cs, tf } = e; const last = cs[cs.length - 1]; const px = priceOf(sym) || last.c;
    const up = triUpperAt(tri, cs.length - 1), dn = triLowerAt(tri, cs.length - 1);
    const distU = (up / px - 1) * 100, distL = (px / dn - 1) * 100; const nearPct = Math.min(Math.abs(distU), Math.abs(distL));
    const nearSide = Math.abs(distU) <= Math.abs(distL) ? 'ÜST' : 'ALT';
    const outside = px > up + 0.25 * tri.atr || px < dn - 0.25 * tri.atr;
    let status = 'SIKIŞMA'; if (outside) status = 'KIRILDI'; else if (nearPct < 0.60) status = 'KIRILIM YAKIN'; else if (tri.maturity > 0.75) status = 'OLGUN';
    rows.push({ symbol: sym, base: baseOf(sym), tf, price: rp(px), upper: rp(up), lower: rp(dn), upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), widthPct: tri.widthPct, distUpperPct: +distU.toFixed(2), distLowerPct: +distL.toFixed(2), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2), nearPct: +nearPct.toFixed(2), nearSide, status, dirHint: nearSide === 'ÜST' ? 'LONG' : 'SHORT', maturity: tri.maturity, compression: tri.compression, score: tri.score, touches: tri.touchesH + tri.touchesL, apexAt: tri.apexAt, apexX: +tri.apexX.toFixed(1), breakoutUp: tri.outside && px > up, breakoutDn: tri.outside && px < dn, ai: e.ai || null });
  }
  rows.sort((a, b) => a.nearPct - b.nearPct || b.score - a.score);
  WATCH.lt = rows.slice(0, 40);
  WATCH_META.lt = { scannedAt: lastScan.lt || Date.now(), count: WATCH.lt.length, universe: Math.min(40, UNIVERSE.length) };
}

function triangleChart(tri, cs, tf) {
  if (!tri || !tri.ok) return null; const tfMs = TF_MS[tf] || H2; const n = cs.length; const start = Math.max(0, tri.firstIdx - 2); const future = 12;
  const upper = [], lower = [];
  for (let i = start; i < n + future; i++) { const t = i < n ? cs[i].t : cs[n - 1].t + (i - n + 1) * tfMs; upper.push([t, rp(triUpperAt(tri, i))]); lower.push([t, rp(triLowerAt(tri, i))]); }
  return { upper, lower, upperNow: rp(triUpperAt(tri, n - 1)), lowerNow: rp(triLowerAt(tri, n - 1)), apexAt: tri.apexAt, apexPrice: rp(tri.hi.intercept + tri.hi.slope * (tri.apexIdx - tri.refIdx)), pivots: tri.highs.map(q => ({ t: q.t, p: rp(q.p), side: 'H' })).concat(tri.lows.map(q => ({ t: q.t, p: rp(q.p), side: 'L' }))), maturity: tri.maturity, compression: tri.compression, score: tri.score, widthPct: tri.widthPct };
}

/* ══════════════════════════════════════════════════════════════════════════════
   MODÜL 2: GÜNLÜK HIZLI SCALP (5m)
   ══════════════════════════════════════════════════════════════════════════════ */
const SESSIONS = [0, 7 * H1, 13 * H1 + 30 * M1];
function currentSession(now) { const day = utcDayStart(now); let best = null; for (const off of SESSIONS) { const start = day + off; if (start <= now && now - start <= 5 * H1) best = { start, off }; } return best || { start: day, off: 0 }; }
function openingRange(cs, start) { const bars = cs.filter(c => c.t >= start && c.t < start + 30 * M1); if (bars.length < 5) return null; const high = Math.max.apply(null, bars.map(c => c.h)); const low = Math.min.apply(null, bars.map(c => c.l)); return { high, low, mid: (high + low) / 2, n: bars.length, start, end: start + 30 * M1 }; }

function scalpContext(sym, cs, opt) {
  if (!cs || cs.length < 120) return null; const n = cs.length, last = cs[n - 1];
  const now = (opt && Number(opt.now) > 0) ? Number(opt.now) : Date.now(); const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  if (!(px > 0)) return null;
  const cl = closesOf(cs); const atr = atrLast(cs, 14); if (!atr || atr <= 0) return null;
  const e9 = emaArr(cl, 9), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50); const rsi = rsiLast(cl, 14); const adxObj = adxLast(cs, 14);
  const volSma = avg(cs.slice(-20).map(c => c.v)); const volRatio = volSma > 0 ? last.v / volSma : 0;
  const session = currentSession(now); const vw = vwapOf(cs, session.start); const or = openingRange(cs, session.start);
  const spread = (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym);
  const atrPct = atr / px * 100; const e50Slope = e50[n - 7] ? (e50[n - 1] - e50[n - 7]) / e50[n - 7] * 100 : 0;
  return { sym, cs, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi, adx: adxObj ? adxObj.adx : null, plusDI: adxObj ? adxObj.plusDI : null, minusDI: adxObj ? adxObj.minusDI : null, volSma, volRatio, vwap: vw.vwap, vwapSd: vw.sd, session, or, spread, e50Slope, body: bodyRatio(last), ba: bodyAtr(last, atr), rangeAtr: (last.h - last.l) / atr };
}

function clampRisk(entry, sl, dir, loPct, hiPct) {
  const d = dir === 'LONG' ? 1 : -1; let risk = Math.abs(entry - sl);
  const lo = entry * loPct / 100, hi = entry * hiPct / 100;
  if (!(risk > 0)) risk = lo;
  risk = clamp(risk, lo, hi);
  return entry - d * risk;
}

function makeScalpCandidate(ctx, setup, dir, entry, sl, tp1, tp2, holdMs, score, reasons, risks, trigger, distPct, triggered) {
  const d = dir === 'LONG' ? 1 : -1; entry = rp(entry); sl = rp(clampRisk(entry, sl, dir, 0.50, 1.20)); const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  tp1 = rp(entry + d * Math.max(risk * 1.50, entry * 0.004)); tp2 = rp(entry + d * Math.max(risk * 2.50, entry * 0.007));
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2); if (q1.net < EX.MIN_RR1 || q2.net < EX.MIN_RR2) return null;
  const riskPct = risk / entry * 100; if (riskPct < 0.40 || riskPct > EX.MAX_RISK_PCT) return null;
  return { setup, dir, entry, sl, tp1, tp2, holdMs, score: clamp(Math.round(score), 0, 100), riskPct: +riskPct.toFixed(2), netRR: q1.net, netRR2: q2.net, reasons: reasons.filter(Boolean).slice(0, 6), risks: risks.filter(Boolean).slice(0, 4), trigger: rp(trigger || entry), distPct: +num(distPct, 0).toFixed(2), triggered: !!triggered };
}

function scalpCandidates(ctx) {
  const out = []; const { last, px, atr, cs, n } = ctx; const prev = cs[n - 2];
  if (ctx.or && ctx.now >= ctx.or.end + M5 && ctx.now <= ctx.session.start + 4 * H1) {
    const or = ctx.or; const long = last.c > or.high && last.o <= or.high * 1.0008 && px >= or.high * 0.999; const short = last.c < or.low && last.o >= or.low * 0.9992 && px <= or.low * 1.001;
    const trendUp = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015; const trendDn = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015;
    const volOk = ctx.volRatio >= 1.45; const bodyOk = ctx.body >= 0.30 && ctx.ba >= 0.38;
    if (long && trendUp && volOk && bodyOk && (px - or.high) / atr <= 0.85 && (!ctx.vwap || px > ctx.vwap)) { const sl = Math.min(or.mid, last.c - 0.85 * atr); out.push(makeScalpCandidate(ctx, 'ORB', 'LONG', px, sl, 0, 0, 90 * M1, 64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0), ['Seans açılış aralığı (' + new Date(ctx.session.start).toISOString().slice(11, 16) + ' UTC) yukarı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP üstünde'], [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.high, (or.high / px - 1) * 100, true)); }
    if (short && trendDn && volOk && bodyOk && (or.low - px) / atr <= 0.85 && (!ctx.vwap || px < ctx.vwap)) { const sl = Math.max(or.mid, last.c + 0.85 * atr); out.push(makeScalpCandidate(ctx, 'ORB', 'SHORT', px, sl, 0, 0, 90 * M1, 64 + clamp(ctx.volRatio - 1.45, 0, 1) * 12 + clamp(ctx.ba - 0.38, 0, 1) * 10 + (ctx.adx && ctx.adx > 20 ? 4 : 0), ['Seans açılış aralığı (' + new Date(ctx.session.start).toISOString().slice(11, 16) + ' UTC) aşağı kırıldı', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'VWAP altında'], [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], or.low, (1 - or.low / px) * 100, true)); }
  }
  if (ctx.vwap) {
    const longTrend = ctx.e20[n - 1] > ctx.e50[n - 1] && ctx.e50Slope > 0.015 && last.c > ctx.vwap; const shortTrend = ctx.e20[n - 1] < ctx.e50[n - 1] && ctx.e50Slope < -0.015 && last.c < ctx.vwap;
    const pullLong = cs.slice(-7, -1).some(c => c.l <= ctx.e20[n - 2] + 0.28 * atr) || cs.slice(-7, -1).some(c => c.l <= ctx.vwap + 0.30 * atr); const pullShort = cs.slice(-7, -1).some(c => c.h >= ctx.e20[n - 2] - 0.28 * atr) || cs.slice(-7, -1).some(c => c.h >= ctx.vwap - 0.30 * atr);
    const triggerLong = last.c > last.o && last.c > prev.h && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 42 && ctx.rsi <= 74 && (last.c - ctx.e20[n - 1]) / atr <= 1.35;
    const triggerShort = last.c < last.o && last.c < prev.l && ctx.ba >= 0.30 && ctx.volRatio >= 1.12 && ctx.rsi != null && ctx.rsi >= 26 && ctx.rsi <= 58 && (ctx.e20[n - 1] - last.c) / atr <= 1.35;
    if (longTrend && pullLong && triggerLong) { const sl = Math.min.apply(null, cs.slice(-4).map(c => c.l)) - 0.30 * atr; out.push(makeScalpCandidate(ctx, 'VWAP', 'LONG', px, sl, 0, 0, 45 * M1, 58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0), ['EMA20/VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)], [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (ctx.e20[n - 1] / px - 1) * 100, true)); }
    if (shortTrend && pullShort && triggerShort) { const sl = Math.max.apply(null, cs.slice(-4).map(c => c.h)) + 0.30 * atr; out.push(makeScalpCandidate(ctx, 'VWAP', 'SHORT', px, sl, 0, 0, 45 * M1, 58 + clamp(ctx.volRatio - 1.12, 0, 1) * 12 + clamp(ctx.ba - 0.30, 0, 1) * 12 + (ctx.adx && ctx.adx >= 20 ? 6 : 0), ['EMA20/VWAP geri çekilmesinden dönüş', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'RSI ' + Math.round(ctx.rsi)], [(ctx.adx || 0) < 18 ? 'ADX zayıf' : ''], ctx.e20[n - 1], (1 - ctx.e20[n - 1] / px) * 100, true)); }
    if (ctx.vwapSd > 0 && ctx.adx != null && ctx.adx < 21) {
      const lower2 = ctx.vwap - 2 * ctx.vwapSd, upper2 = ctx.vwap + 2 * ctx.vwapSd; const wickLow = last.h > last.l ? (Math.min(last.o, last.c) - last.l) / (last.h - last.l) : 0; const wickHigh = last.h > last.l ? (last.h - Math.max(last.o, last.c)) / (last.h - last.l) : 0;
      const longRev = last.l <= lower2 && last.c > lower2 && ctx.rsi != null && ctx.rsi < 32 && wickLow >= 0.32; const shortRev = last.h >= upper2 && last.c < upper2 && ctx.rsi != null && ctx.rsi > 68 && wickHigh >= 0.32;
      if (longRev) { const sl = last.l - 0.35 * atr; const cand = makeScalpCandidate(ctx, 'REV', 'LONG', px, sl, 0, 0, 30 * M1, 56 + clamp(32 - ctx.rsi, 0, 12) * 1.2 + clamp(wickLow - 0.32, 0, 0.4) * 20, ['VWAP alt 2σ bandından fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx) + ' (range)'], ['Trend scalp değil, range dönüşü'], lower2, (lower2 / px - 1) * 100, true); if (cand) { const risk = Math.abs(cand.entry - cand.sl); const tp1v = rp(ctx.vwap), tp2v = rp(ctx.vwap + (ctx.vwapSd || risk)); const q1 = rrNet(cand.entry, cand.sl, tp1v), q2 = rrNet(cand.entry, cand.sl, tp2v); if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) { cand.tp1 = tp1v; cand.tp2 = tp2v; cand.netRR = q1.net; cand.netRR2 = q2.net; out.push(cand); } } }
      if (shortRev) { const sl = last.h + 0.35 * atr; const cand = makeScalpCandidate(ctx, 'REV', 'SHORT', px, sl, 0, 0, 30 * M1, 56 + clamp(ctx.rsi - 68, 0, 12) * 1.2 + clamp(wickHigh - 0.32, 0, 0.4) * 20, ['VWAP üst 2σ bandından fitilli dönüş', 'RSI ' + Math.round(ctx.rsi), 'ADX ' + Math.round(ctx.adx) + ' (range)'], ['Trend scalp değil, range dönüşü'], upper2, (1 - upper2 / px) * 100, true); if (cand) { const risk = Math.abs(cand.entry - cand.sl); const tp1v = rp(ctx.vwap), tp2v = rp(ctx.vwap - (ctx.vwapSd || risk)); const q1 = rrNet(cand.entry, cand.sl, tp1v), q2 = rrNet(cand.entry, cand.sl, tp2v); if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) { cand.tp1 = tp1v; cand.tp2 = tp2v; cand.netRR = q1.net; cand.netRR2 = q2.net; out.push(cand); } } }
    }
  }
  return out;
}

function scalpAnalyze(sym, cs, opt) {
  const ctx = scalpContext(sym, cs, opt); if (!ctx) return null;
  if (ctx.atrPct < 0.12 || ctx.atrPct > 2.2) return null; if (ctx.spread > settings.maxSpreadPct) return null;
  const cands = scalpCandidates(ctx).filter(Boolean); if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score); const best = cands[0];
  const raw = { module: 'SCALP', symbol: sym, base: baseOf(sym), dir: best.dir, entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2, single: false, conf: clamp(best.score, 45, 95), retest: false, holdSec: Math.round(best.holdMs / 1000), noMoveSec: Math.round(Math.min(180, best.holdMs / 1000 * 0.35)), info: { tf: '5m', source: 'math', setup: best.setup, plan: { entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2 }, netRR: best.netRR, netRR2: best.netRR2, riskPct: best.riskPct, atrPct: +ctx.atrPct.toFixed(2), volRatio: +ctx.volRatio.toFixed(2), bodyAtr: +ctx.ba.toFixed(2), bodyRatio: +ctx.body.toFixed(2), rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null, vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]), orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null, sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), trigger: best.trigger, distPct: best.distPct, score: best.score, reasons: best.reasons, risks: best.risks }, maxAgeMs: best.holdMs + 10 * M1, setupKey: 'SCALP|' + sym + '|' + best.setup + '|' + best.dir + '|' + Math.floor(ctx.last.t / M5) };
  const row = { symbol: sym, base: baseOf(sym), tf: '5m', price: rp(ctx.px), setup: best.setup, dir: best.dir, score: best.score, status: best.triggered ? 'TETİK' : 'BEKLİYOR', state: best.triggered ? 'ADAY SİNYAL' : (best.distPct != null && Math.abs(best.distPct) <= 0.35 ? 'KIRILIM YAKLAŞIYOR' : 'TEYİT BEKLENİYOR'), trigger: best.trigger, distPct: best.distPct, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2), mom1: +(((ctx.last.c / ctx.cs[ctx.n - 2].c - 1) * 100)).toFixed(2), mom3: +(((ctx.last.c / ctx.cs[Math.max(0, ctx.n - 4)].c - 1) * 100)).toFixed(2), rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null, vwap: rp(ctx.vwap), ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]), orHigh: ctx.or ? rp(ctx.or.high) : null, orLow: ctx.or ? rp(ctx.or.low) : null, sessionStart: ctx.session.start, spreadPct: +ctx.spread.toFixed(3), reason: best.reasons[0] || '', ai: null };
  return { raw, row };
}

let scalpScanning = false;
async function scalpScan() {
  if (scalpScanning) return; scalpScanning = true;
  try {
    const list = UNIVERSE.slice(0, 50); const rows = [], raws = [];
    await pool(list, 5, async (sym) => { const cs = await getCandles(sym, '5m', 180, true); if (!cs || cs.length < 120) return; const a = scalpAnalyze(sym, cs); if (!a) return; if (a.row) rows.push(a.row); if (a.raw) raws.push(a.raw); });
    const old = new Map(WATCH.scalp.map(r => [r.symbol, r.ai])); for (const r of rows) if (old.get(r.symbol)) r.ai = old.get(r.symbol);
    rows.sort((a, b) => (a.status === 'TETİK' ? -1 : 0) - (b.status === 'TETİK' ? -1 : 0) || a.distPct - b.distPct || b.score - a.score);
    WATCH.scalp = rows.slice(0, 25); WATCH_META.scalp = { scannedAt: Date.now(), count: WATCH.scalp.length, universe: list.length };
    raws.sort((a, b) => b.conf - a.conf); let emitted = 0;
    for (const raw of raws) { if (emitted >= 2) break; const prev = FIRED.get(raw.setupKey); if (prev && Date.now() - prev < 30 * M1) continue; const sig = addSignal(raw); if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; log('SCALP SİNYAL (' + raw.info.setup + '): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net R:R ' + raw.info.netRR); } }
    lastScan.scalp = Date.now();
  } catch (e) { log('Scalp tarama hatası: ' + redact(e.message)); } finally { scalpScanning = false; }
}

/* ══════════════════════════════════════════════════════════════════════════════
   MODÜL 3: AUTOTRADE (Pump/Dump + AI Giriş/Çıkış)
   ══════════════════════════════════════════════════════════════════════════════ */
function autoContext(sym, cs, opt) {
  if (!cs || cs.length < 100) return null;
  const n = cs.length, last = cs[n - 1];
  const now = (opt && Number(opt.now) > 0) ? Number(opt.now) : Date.now();
  const px = (opt && Number(opt.price) > 0) ? Number(opt.price) : (priceOf(sym) || last.c);
  if (!(px > 0)) return null;
  const cl = closesOf(cs); const atr = atrLast(cs, 14); if (!atr || atr <= 0) return null;
  const e9 = emaArr(cl, 9), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  const rsi = rsiLast(cl, 14); const adxObj = adxLast(cs, 14);
  const volSma = avg(cs.slice(-20).map(c => c.v)); const volRatio = volSma > 0 ? last.v / volSma : 0;
  const spread = (opt && Number(opt.spread) >= 0) ? Number(opt.spread) : spreadPct(sym);
  const atrPct = atr / px * 100;
  const body = bodyRatio(last); const ba = bodyAtr(last, atr);
  const chg1 = n >= 2 ? (last.c / cs[n - 2].c - 1) * 100 : 0;
  const chg3 = n >= 4 ? (last.c / cs[n - 4].c - 1) * 100 : 0;
  const chg6 = n >= 7 ? (last.c / cs[n - 7].c - 1) * 100 : 0;
  const rangeAtr = (last.h - last.l) / atr;
  return { sym, cs, n, last, px, now, atr, atrPct, cl, e9, e20, e50, rsi, adx: adxObj ? adxObj.adx : null, volSma, volRatio, spread, body, ba, chg1, chg3, chg6, rangeAtr };
}

function pumpDumpCandidates(ctx) {
  const out = []; const { last, px, atr, cs, n } = ctx;
  const upChg1 = ctx.chg1 > 0.5, upChg3 = ctx.chg3 > 1.0, upVol = ctx.volRatio >= 1.6;
  const upBody = ctx.body >= 0.35 && ctx.ba >= 0.45, upCloseHigh = (last.h - last.c) / Math.max(last.h - last.l, 1e-12) < 0.35;
  const aboveEma = last.c > ctx.e20[n - 1];
  if (upChg1 && upChg3 && upVol && upBody && upCloseHigh && aboveEma) {
    const slPct = clamp(ctx.atrPct * 1.8, 1.00, 2.00); // Wide SL for pump
    const sl = px * (1 - slPct / 100);
    const tp1 = px * (1 + slPct * 1.5 / 100);
    const tp2 = px * (1 + slPct * 3.0 / 100);
    const q1 = rrNet(px, sl, tp1), q2 = rrNet(px, sl, tp2);
    if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) {
      out.push(makeScalpCandidate(ctx, 'PUMP', 'LONG', px, sl, 0, 0, 60 * M1, 60 + clamp(ctx.volRatio - 1.6, 0, 1) * 15 + clamp(ctx.chg3 - 1.0, 0, 2) * 5, ['Sert yukarı hareket (Pump)', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'EMA20 üstünde'], ['Ani geri dönüş riski'], last.c, 0, true));
    }
  }
  const dnChg1 = ctx.chg1 < -0.5, dnChg3 = ctx.chg3 < -1.0, dnVol = ctx.volRatio >= 1.6;
  const dnBody = ctx.body >= 0.35 && ctx.ba >= 0.45, dnCloseLow = (last.c - last.l) / Math.max(last.h - last.l, 1e-12) < 0.35;
  const belowEma = last.c < ctx.e20[n - 1];
  if (dnChg1 && dnChg3 && dnVol && dnBody && dnCloseLow && belowEma) {
    const slPct = clamp(ctx.atrPct * 1.8, 1.00, 2.00);
    const sl = px * (1 + slPct / 100);
    const tp1 = px * (1 - slPct * 1.5 / 100);
    const tp2 = px * (1 - slPct * 3.0 / 100);
    const q1 = rrNet(px, sl, tp1), q2 = rrNet(px, sl, tp2);
    if (q1.net >= EX.MIN_RR1 && q2.net >= EX.MIN_RR2) {
      out.push(makeScalpCandidate(ctx, 'DUMP', 'SHORT', px, sl, 0, 0, 60 * M1, 60 + clamp(ctx.volRatio - 1.6, 0, 1) * 15 + clamp(Math.abs(ctx.chg3) - 1.0, 0, 2) * 5, ['Sert aşağı hareket (Dump)', 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'EMA20 altında'], ['Ani geri dönüş riski'], last.c, 0, true));
    }
  }
  return out;
}

function autoAnalyze(sym, cs, opt) {
  const ctx = autoContext(sym, cs, opt); if (!ctx) return null;
  if (ctx.atrPct < 0.25 || ctx.atrPct > 5.0) return null;
  if (ctx.spread > settings.maxSpreadPct) return null;
  const cands = pumpDumpCandidates(ctx).filter(Boolean); if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score); const best = cands[0];
  const raw = { module: 'AUTO', symbol: sym, base: baseOf(sym), dir: best.dir, entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2, single: false, conf: clamp(best.score, 45, 95), retest: false, holdSec: Math.round(best.holdMs / 1000), noMoveSec: 180, info: { tf: '5m', source: 'math', setup: best.setup, plan: { entry: best.entry, sl: best.sl, tp1: best.tp1, tp2: best.tp2 }, netRR: best.netRR, netRR2: best.netRR2, riskPct: best.riskPct, atrPct: +ctx.atrPct.toFixed(2), volRatio: +ctx.volRatio.toFixed(2), bodyAtr: +ctx.ba.toFixed(2), bodyRatio: +ctx.body.toFixed(2), rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null, ema20: rp(ctx.e20[ctx.n - 1]), ema50: rp(ctx.e50[ctx.n - 1]), chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2), spreadPct: +ctx.spread.toFixed(3), trigger: best.trigger, distPct: best.distPct, score: best.score, reasons: best.reasons, risks: best.risks }, maxAgeMs: best.holdMs + 10 * M1, setupKey: 'AUTO|' + sym + '|' + best.setup + '|' + Math.floor(ctx.last.t / M5) };
  const row = { symbol: sym, base: baseOf(sym), tf: '5m', setup: best.setup, price: rp(ctx.px), dir: best.dir, score: best.score, status: 'TETİK', state: 'ADAY SİNYAL', trigger: best.trigger, distPct: 0, volRatio: +ctx.volRatio.toFixed(2), atrPct: +ctx.atrPct.toFixed(2), mom1: +ctx.chg1.toFixed(2), mom3: +ctx.chg3.toFixed(2), rsi: ctx.rsi != null ? +ctx.rsi.toFixed(0) : null, adx: ctx.adx != null ? +ctx.adx.toFixed(0) : null, reason: best.reasons[0] || '', ai: null };
  return { raw, row };
}

let autoScanning = false;
async function autoScan() {
  if (autoScanning) return; autoScanning = true;
  try {
    const list = UNIVERSE.slice(0, 60); const rows = [], raws = [];
    await pool(list, 5, async (sym) => { const cs = await getCandles(sym, '5m', 100, true); if (!cs || cs.length < 60) return; const a = autoAnalyze(sym, cs); if (!a) return; if (a.row) rows.push(a.row); if (a.raw) raws.push(a.raw); });
    const old = new Map(WATCH.auto.map(r => [r.symbol, r.ai])); for (const r of rows) if (old.get(r.symbol)) r.ai = old.get(r.symbol);
    rows.sort((a, b) => b.score - a.score);
    WATCH.auto = rows.slice(0, 15); WATCH_META.auto = { scannedAt: Date.now(), count: WATCH.auto.length };
    raws.sort((a, b) => b.conf - a.conf); let emitted = 0;
    for (const raw of raws) { if (emitted >= 3) break; const prev = FIRED.get(raw.setupKey); if (prev && Date.now() - prev < 15 * M1) continue; const sig = addSignal(raw); if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; log('AUTOTRADE SİNYAL (' + raw.info.setup + '): ' + sig.base + ' ' + sig.dir + ' | güven ' + sig.conf + ' | net R:R ' + raw.info.netRR); } }
    lastScan.auto = Date.now();
  } catch (e) { log('AutoTrade tarama hatası: ' + redact(e.message)); } finally { autoScanning = false; }
}

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100; const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0; const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}

function isOpenSignal(s) { return !!s && s.status !== 'KAPALI'; }
function openCount() { return paper.open.length; }
function dayPnl() { return +(paper.equity - paper.dayStart).toFixed(4); }
function dailyLossHit() { return dayPnl() <= -Math.abs(paper.dayStart * settings.dailyLossPct / 100); }
function canAutoOpen() { return settings.auto === true && paper.open.length < settings.maxOpen && !dailyLossHit(); }

function logRej(module, sym, reason, price) {
  const base = baseOf(sym); const now = Date.now(); const last = REJ.find(r => r.symbol === sym && r.reason === reason && now - r.t < 10 * M1);
  if (last) { last.n = (last.n || 1) + 1; last.t = now; }
  else { REJ.push({ t: now, module, symbol: sym, base, reason, price: rp(price || priceOf(sym)), n: 1 }); capArr(REJ, 200); }
  const k = module + '|' + reason; REJ_STAT[k] = (REJ_STAT[k] || 0) + 1;
}

function analyzeSignal(sig) {
  const info = sig.info || {}; const reasons = Array.isArray(info.reasons) ? info.reasons.slice() : []; const risks = Array.isArray(info.risks) ? info.risks.slice() : [];
  let score = clamp(Math.round(num(sig.conf, 50)), 0, 100); const q = rrNet(sig.entry, sig.sl, sig.tp1);
  if (q.net >= 1.0) { score += 5; reasons.push('Net R:R ' + q.net.toFixed(2) + ' (maliyet dahil)'); } else if (q.net < 0.6) { score -= 8; risks.push('Net R:R zayıf (' + q.net.toFixed(2) + ')'); }
  const riskPct = Math.abs(sig.entry - sig.sl) / sig.entry * 100; if (riskPct > 2.2) { score -= 5; risks.push('Stop geniş (%' + riskPct.toFixed(2) + ')'); }
  if (market.dir !== 'NOTR' && market.dir !== sig.dir) { score -= 6; risks.push('Piyasa yönüne ters'); } else if (market.dir === sig.dir) { score += 3; reasons.push('Piyasa yönü uyumlu'); }
  if (info.setup === 'REV' || info.setup === 'DUMP') { score -= 2; reasons.push('Dönüş/ters kurulum'); }
  score = clamp(score, 0, 100);
  const skipped = sig.status === 'KAPALI' && SKIP_RESULTS.has(sig.result);
  const verdict = skipped ? 'GİRİLMEZ' : (score >= settings.minConf ? 'GİRİLİR' : 'BEKLE');
  return { verdict, verdictLabel: verdict === 'GİRİLİR' ? 'GİRİLİR' : verdict === 'GİRİLMEZ' ? 'GİRİLMEZ' : 'BEKLE', score, netRR: q.net, riskPct: +riskPct.toFixed(2), reasons: Array.from(new Set(reasons)).slice(0, 8), risks: Array.from(new Set(risks)).slice(0, 6) };
}

function addSignal(raw) {
  if (!raw || !MODS[raw.module] || !MODS[raw.module].enabled) return false;
  const M = MODS[raw.module], now = Date.now();
  if (!['LONG', 'SHORT'].includes(raw.dir)) return false;
  if (!(raw.entry > 0) || !(raw.sl > 0) || !(raw.tp1 > 0)) return false;
  const d = raw.dir === 'LONG' ? 1 : -1; if ((raw.tp1 - raw.entry) * d <= 0) return false; if ((raw.sl - raw.entry) * d >= 0) return false;
  const riskPct = Math.abs(raw.entry - raw.sl) / raw.entry * 100; if (riskPct < 0.35 || riskPct > EX.MAX_RISK_PCT) return false;
  const q1 = rrNet(raw.entry, raw.sl, raw.tp1); if (q1.net < (raw.module === 'AUTO' || raw.module === 'SCALP' ? 0.55 : 0.70)) return false;
  const same = signals.filter(s => s.module === raw.module && s.symbol === raw.symbol);
  if (same.some(isOpenSignal)) { logRej(raw.module, raw.symbol, 'aynı coin açık sinyal', raw.entry); return false; }
  const last = same.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - (last.closedAt || last.createdAt) < M.cooldown) { logRej(raw.module, raw.symbol, 'soğuma', raw.entry); return false; }
  const dayStart = utcDayStart(now); if (same.filter(s => s.createdAt >= dayStart).length >= M.maxPerDaySym) { logRej(raw.module, raw.symbol, 'günlük limit', raw.entry); return false; }
  if (raw.setupKey) { const f = FIRED.get(raw.setupKey); const ttl = raw.module === 'LT' ? 6 * H1 : 30 * M1; if (f && now - f < ttl) return false; }
  const counter = market.dir !== 'NOTR' && market.dir !== raw.dir;
  if ((raw.module === 'AUTO' || raw.module === 'SCALP') && counter && raw.conf < 72) { logRej(raw.module, raw.symbol, 'piyasa yönüne ters', raw.entry); return false; }
  const id = 'S' + (++seq).toString(36) + '-' + now.toString(36);
  const sig = { id, module: raw.module, symbol: raw.symbol, base: raw.base || baseOf(raw.symbol), dir: raw.dir, entry: rp(raw.entry), sl: rp(raw.sl), curSl: rp(raw.sl), tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null, single: false, tp1Hit: false, conf: clamp(Math.round(num(raw.conf, 55)), 30, 99), baseConf: clamp(Math.round(num(raw.conf, 55)), 30, 99), counter, marketAlign: market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU'), info: Object.assign({}, raw.info || {}, { plan: (raw.info && raw.info.plan) || { entry: rp(raw.entry), sl: rp(raw.sl), tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null } }), status: 'AKTIF', result: null, aiGate: null, ai: null, createdAt: now, updatedAt: now, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0, holdSec: raw.holdSec, noMoveSec: raw.noMoveSec, setupKey: raw.setupKey || null, tradeable: M.tradeable, virtual: !M.tradeable, startedAt: now, approvalExpiresAt: null };
  const aiOn = aiReady(); sig.aiGate = { state: aiOn ? 'QUEUED' : 'MATH_ONLY', queuedAt: now, note: aiOn ? 'AI kararı bekleniyor' : 'AI kapalı — matematik kararı' };
  if (raw.module === 'AUTO') {
    if (aiOn) { sig.status = 'AI_BEKLIYOR'; }
    else if (canAutoOpen()) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; }
    else { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; }
  } else if (raw.module === 'SCALP') {
    sig.status = 'AKTIF'; sig.startedAt = now;
  } else { sig.status = 'AKTIF'; sig.startedAt = now; }
  signals.push(sig); capArr(signals, 500); sig.analysis = analyzeSignal(sig); dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + sig.analysis.verdictLabel + ' ' + sig.analysis.score + ' | ' + (sig.info.setup || sig.info.tf || ''));
  onSignalAdded(sig);
  if (aiOn) queueAI(sig);
  else if (raw.module === 'AUTO' && canAutoOpen()) { const r = openPaper(sig); if (!r || r.error) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + 10 * M1; sig.aiGate = Object.assign({}, sig.aiGate, { note: 'Oto açılamadı: ' + ((r && r.error) || 'bilinmeyen') }); } }
  return sig;
}
// ===== PART 1 SONU =====
/* ══════════════════════════════════════════════════════════════════════════════
   SİNYAL YAŞAM DÖNGÜSÜ + PAPER/LIVE TRADING + İSTATİSTİK
   ══════════════════════════════════════════════════════════════════════════════ */

function onSignalAdded(sig) {
  if (sig.module === 'LT') {
    OPP.set('LT|' + sig.symbol, { id: 'LT|' + sig.symbol, mod: 'LT', sym: sig.symbol, base: sig.base, dir: sig.dir, state: 'CONFIRMED', firstAt: sig.createdAt, updatedAt: Date.now(), price: sig.entry, hist: [{ t: Date.now(), from: null, to: 'CONFIRMED', price: sig.entry, reason: 'üçgen kırılımı' }], ai: null });
    capMap(OPP, 100);
  }
}

function skipSignal(sig, code, note) {
  if (!sig || sig.status === 'KAPALI') return;
  sig.status = 'KAPALI'; sig.result = code; sig.netR = null; sig.grossR = null; sig.closedAt = Date.now(); sig.skipNote = note || '';
  const gateState = (sig.aiGate && sig.aiGate.state === 'AI_RED') ? 'AI_RED' : 'SKIPPED';
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: gateState, note: note || RES[code] || code, decidedAt: Date.now() });
  dirty = true;
  log('ATLANDI: ' + MODS[sig.module].label + ' ' + sig.base + ' ' + sig.dir + ' → ' + (RES[code] || code) + (note ? ' (' + note + ')' : ''));
}

function approveSignal(sig) {
  if (!sig) return { error: 'sinyal yok' };
  if (sig.status !== 'ONAY_BEKLIYOR' && sig.status !== 'AI_BEKLIYOR') return { error: 'sinyal onay beklemiyor' };
  if (sig.approvalExpiresAt && Date.now() > sig.approvalExpiresAt) { skipSignal(sig, 'APPROVAL_EXPIRED', 'onay süresi doldu'); return { error: 'onay süresi doldu' }; }
  return openPaper(sig);
}

function reconcilePending() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'ONAY_BEKLIYOR' && sig.approvalExpiresAt && now > sig.approvalExpiresAt) {
      skipSignal(sig, 'APPROVAL_EXPIRED', 'onay süresi doldu'); continue;
    }
    if (sig.status !== 'AI_BEKLIYOR') continue;
    const queued = AI_QUEUE.some(x => x.id === sig.id);
    if (!aiReady()) {
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'MATH_ONLY', note: 'AI kapalı — matematik kararı', decidedAt: now });
      if (sig.module === 'AUTO') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; } else { sig.status = 'AKTIF'; }
      dirty = true; continue;
    }
    if (now - sig.createdAt > 20 * M1) {
      sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'AI yanıtı gecikti — matematik kararı', decidedAt: now });
      if (sig.module === 'AUTO') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + 10 * M1; } else { sig.status = 'AKTIF'; }
      dirty = true; continue;
    }
    if (!queued && !AI_STATE.busy) queueAI(sig);
  }
}

/* ───────── LIVE TRADING (BITGET) ───────── */
let liveInited = false;
async function liveInit() {
  if (liveInited || !HAS_KEYS) return;
  try { await ex.setPositionMode(false); } catch (e) { log('LIVE UYARI: pozisyon modu ayarlanamadı (' + e.message + ')'); }
  liveInited = true;
}
async function liveSetup(sym, lev) {
  try { await ex.setMarginMode('isolated', sym); } catch (e) { }
  await ex.setLeverage(lev, sym);
}
async function placeStop(sym, side, amount, price) {
  let lastErr = null;
  for (const params of [{ stopLossPrice: price, reduceOnly: true }, { triggerPrice: price, reduceOnly: true }]) {
    for (let i = 0; i < 2; i++) {
      try { const o = await ex.createOrder(sym, 'market', side, amount, undefined, params); if (o && o.id) return o.id; lastErr = new Error('stop id yok'); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300)); }
    }
  }
  throw lastErr || new Error('stop kurulamadı');
}
async function emergencyClose(sym, side, amount) {
  for (let i = 0; i < 4; i++) { try { await ex.createOrder(sym, 'market', side, amount, undefined, { reduceOnly: true }); return true; } catch (e) { await new Promise(r => setTimeout(r, 400)); } }
  return false;
}
async function fillOf(order, sym) {
  let f = Number(order && order.average) || Number(order && order.price) || 0;
  if (!f && order && order.id) { try { const o2 = await ex.fetchOrder(order.id, sym); f = Number(o2.average) || Number(o2.price) || 0; } catch (e) { } }
  return f;
}
async function cancelStopOrder(p) {
  if (!p.stopId) return true;
  let ok = false;
  for (const params of [{ stop: true }, { trigger: true }, { stop: true, planType: 'loss_plan' }]) { try { await ex.cancelOrder(p.stopId, p.symbol, params); ok = true; break; } catch (e) { } }
  if (!ok) { try { await ex.cancelAllOrders(p.symbol, { stop: true }); ok = true; } catch (e) { } }
  return ok;
}
async function openLive(sig, margin, lev, entryHint) {
  await liveInit(); await liveSetup(sig.symbol, lev);
  const side = sig.dir === 'LONG' ? 'buy' : 'sell', slSide = sig.dir === 'LONG' ? 'sell' : 'buy';
  const amount = ex.amountToPrecision(sig.symbol, (margin * lev) / entryHint);
  if (!(Number(amount) > 0) || Number(amount) * entryHint < 5) throw new Error('miktar çok küçük');
  const order = await ex.createOrder(sig.symbol, 'market', side, amount);
  const fill = (await fillOf(order, sig.symbol)) || entryHint;
  const qty = Number(order.filled) > 0 ? ex.amountToPrecision(sig.symbol, order.filled) : amount;
  let stopId = null;
  try { stopId = await placeStop(sig.symbol, slSide, qty, sig.sl); }
  catch (e) {
    log('LIVE STOP KURULAMADI (' + sig.base + '): ' + e.message + ' → ACİL KAPAT');
    if (await emergencyClose(sig.symbol, slSide, qty)) throw new Error('Stop kurulamadı, pozisyon kapatıldı');
  }
  const notional = Number(qty) * fill;
  const p = { id: 'P' + (++seq).toString(36), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir, entry: rp(fill), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, qty: +qty, initialQty: +qty, remainingQty: +qty, notional: +notional.toFixed(4), margin: +(notional / lev).toFixed(4), leverage: lev, riskAmt: +(qty * Math.abs(fill - sig.sl)).toFixed(4), openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 2 * H1)), setup: (sig.info && sig.info.setup) || null, isLive: true, scalp: sig.module === 'AUTO' || sig.module === 'SCALP', stopId, unprotected: !stopId, aiExitCheckedAt: 0 };
  sig.entry = rp(fill); sig.status = 'AKTIF'; sig.startedAt = p.openedAt; sig.operatorApprovedAt = p.openedAt;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'live açıldı', decidedAt: Date.now() });
  paper.open.push(p); dirty = true;
  log('LIVE AÇILDI: ' + p.base + ' ' + p.dir + ' | ' + fmtP(sig.entry) + ' → dolum ' + fmtP(fill) + ' | miktar ' + qty + ' | ' + lev + 'x | stop ' + fmtP(p.sl) + (stopId ? '' : ' (STOP YOK!)'));
  return p;
}
async function liveClose(p) {
  const side = p.dir === 'LONG' ? 'sell' : 'buy';
  const o = await ex.createOrder(p.symbol, 'market', side, p.remainingQty, undefined, { reduceOnly: true });
  const fill = await fillOf(o, p.symbol);
  if (p.stopId) { const ok = await cancelStopOrder(p); if (!ok) log('UYARI: ' + p.base + ' stop emri iptal edilemedi'); }
  return fill || null;
}
async function syncLive() {
  if (!HAS_KEYS) return;
  const lives = paper.open.filter(p => p.isLive && !p.closing && Date.now() - p.openedAt > 8000);
  if (!lives.length) return;
  let poss; try { poss = await ex.fetchPositions(lives.map(p => p.symbol)); } catch (e) { return; }
  if (!Array.isArray(poss)) return;
  const has = new Set(poss.filter(x => Math.abs(Number(x.contracts) || 0) > 0).map(x => x.symbol));
  for (const p of lives) {
    if (has.has(p.symbol)) continue;
    log('LIVE: ' + p.base + ' borsada kapalı → yerelde kapatılıyor');
    p.extClosed = true; await closePaper(p, p.curSl || p.sl, 'SL');
  }
}

/* ───────── PAPER MOTORU ───────── */
function openPaper(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin açık' };
  if (paper.open.length >= settings.maxOpen) return { error: 'maks açık işlem' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const px = priceOf(sig.symbol); if (!(px > 0)) return { error: 'fiyat yok' };
  const atrPct = num(sig.info && sig.info.atrPct, 0.5);
  const maxDrift = Math.max(0.22, Math.min(0.65, atrPct * 0.35));
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > maxDrift) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const d = sig.dir === 'LONG' ? 1 : -1; const entry = rp(px); const riskPerUnit = Math.abs(entry - sig.sl); if (!(riskPerUnit > 0)) return { error: 'stop geçersiz' };
  const live = settings.tradeMode === 'live';
  if (live && !HAS_KEYS) return { error: 'Live mod için API anahtarı gerekli' };
  const eq = live ? realBal.total : paper.equity;
  if (live && !(eq > 0)) return { error: 'Bakiye okunamadı' };
  const riskAmt = eq * settings.riskPct / 100;
  let lev = live ? Math.min(settings.leverage, settings.liveMaxLeverage) : settings.leverage;
  let margin = live ? Math.min(settings.margin, settings.liveMaxMargin, realBal.free * 0.9) : Math.min(settings.margin, paper.equity);
  let qty = riskAmt / riskPerUnit;
  const maxNotional = margin * lev;
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  if (!(qty > 0)) return { error: 'miktar 0' };
  const pos = { id: 'P' + (++seq).toString(36) + '-' + Date.now().toString(36), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir, entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, qty: +qty.toFixed(8), initialQty: +qty.toFixed(8), remainingQty: +qty.toFixed(8), notional: +(qty * entry).toFixed(4), margin: +((qty * entry) / lev).toFixed(4), leverage: lev, riskAmt: +(qty * riskPerUnit).toFixed(4), openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, realized: 0, maxHoldMs: (sig.holdSec ? sig.holdSec * 1000 : (sig.maxAgeMs || 2 * H1)), setup: (sig.info && sig.info.setup) || null, isLive: live, scalp: sig.module === 'AUTO' || sig.module === 'SCALP', aiExitCheckedAt: 0 };
  if (live) {
    openLive(sig, margin, lev, entry).then(p => {
      const idx = paper.open.findIndex(x => x.id === pos.id);
      if (idx !== -1) paper.open.splice(idx, 1);
    }).catch(e => log('LIVE AÇILAMADI: ' + e.message));
    sig.status = 'AKTIF'; sig.startedAt = Date.now(); sig.operatorApprovedAt = Date.now();
    sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'live emri gönderildi', decidedAt: Date.now() });
    paper.open.push(pos); dirty = true;
    return { pos };
  } else {
    sig.entry = entry; sig.status = 'AKTIF'; sig.startedAt = pos.openedAt; sig.operatorApprovedAt = pos.openedAt;
    sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'paper açıldı', decidedAt: Date.now() });
    paper.open.push(pos); dirty = true;
    log('PAPER AÇILDI: ' + sig.base + ' ' + sig.dir + ' | giriş ' + entry + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | risk %' + settings.riskPct);
    return { pos };
  }
}

function closePortion(pos, qty, price) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  const portionNotional = qty * pos.entry;
  const gross = (price - pos.entry) * d * qty;
  const cost = portionNotional * EX.H / 100;
  pos.grossRealized += gross; pos.costPaid += cost; pos.realized = pos.grossRealized - pos.costPaid;
  pos.remainingQty = +(pos.remainingQty - qty).toFixed(8);
  return { gross, cost };
}

async function closePaper(pos, price, reason) {
  if (!pos || pos.closing || pos.status === 'KAPALI') return false;
  pos.closing = true;
  try {
    let exit = price;
    if (pos.isLive && !pos.extClosed && pos.remainingQty > 0) {
      try { const f = await liveClose(pos); if (f) exit = f; }
      catch (e) { pos.closeFail = (pos.closeFail || 0) + 1; if (pos.closeFail < 3) return false; log('LIVE KAPATMA HATASI (' + pos.base + '): ' + e.message); }
    }
    const qty = pos.remainingQty;
    if (qty > 0) closePortion(pos, qty, exit);
    const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
    const grossR = +(pos.grossRealized / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    const netR = +(net / Math.max(0.0001, pos.riskAmt)).toFixed(3);
    if (!pos.isLive) { paper.equity = +(paper.equity + net).toFixed(4); paper.peak = Math.max(paper.peak, paper.equity); }
    const sig = signals.find(s => s.id === pos.sigId);
    if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(exit); sig.closedAt = Date.now(); sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.analysis = analyzeSignal(sig); }
    paper.open = paper.open.filter(p => p.id !== pos.id);
    const rec = Object.assign({}, pos, { exit: rp(exit), result: reason, pnl: net, netR, grossR, closedAt: Date.now(), durationMs: Date.now() - pos.openedAt });
    delete rec.remainingQty; paper.closed.push(rec); capArr(paper.closed, 300);
    OUT.push({ t: Date.now(), module: pos.module, base: pos.base, dir: pos.dir, result: reason, netR, pnl: net, setup: pos.setup, conf: sig ? sig.conf : null, createdAt: sig ? sig.createdAt : pos.openedAt }); capArr(OUT, 300);
    dirty = true;
    log('PAPER KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + netR + 'R (' + net + ' USDT)');
    return true;
  } finally { pos.closing = false; }
}

/* ───────── AUTOTRADE AI EXIT MANAGER ───────── */
async function aiManageAutoTrade(pos) {
  if (!pos || pos.closing || pos.status === 'KAPALI' || !aiReady()) return;
  const now = Date.now();
  if (now - (pos.aiExitCheckedAt || 0) < 45 * 1000) return;
  if (now - pos.openedAt < 30 * 1000) return; // 30 saniye bekle
  pos.aiExitCheckedAt = now;
  const px = priceOf(pos.symbol); if (!(px > 0)) return;
  const d = pos.dir === 'LONG' ? 1 : -1;
  const pnl = (px / pos.entry - 1) * d * 100;
  const cs = await getCandles(pos.symbol, '1m', 15, true);
  if (!cs || !cs.length) return;
  const lines = cs.slice(-8).map(c => new Date(c.t).toISOString().slice(14, 16) + ' dk: değişim ' + ((c.c/c.o -1)*100 >=0?'+':'') + ((c.c/c.o -1)*100).toFixed(2) + '% hacim ' + Math.round(c.v)).join('\n');
  const prompt = `Pozisyon: ${pos.base} ${pos.dir} (OtoTrade). Giriş: ${pos.entry}, Güncel: ${px}, K/Z: ${pnl.toFixed(2)}%. Zirve: ${pos.peakPct ? pos.peakPct.toFixed(2) : pnl.toFixed(2)}%. Kurulum: ${pos.setup}.\nSon 1 dakikalık mumlar:\n${lines}\n\nİvme sürüyor mu, yoksa ters dönüş mü var? Eğer kâr geri veriliyorsa, mumlar küçülüyorsa veya ters yönlü güçlü fitil/mum oluşuyorsa KAPAT. Yoksa TUT. JSON döndür: {"action":"TUT|KAPAT","reason":"kısa cümle"}`;
  try {
    const r = await callAI([
      { role: 'system', content: 'Sen AlphaSon işlem yöneticisisin. Açık scalpe pozisyonu izler, ters dönüş anında kapatırsın. JSON döndür.' },
      { role: 'user', content: prompt }
    ], { timeoutMs: 15000 });
    const j = looseJSON(r.text) || {};
    const act = String(j.action || '').toUpperCase();
    if (act === 'KAPAT' || act === 'CLOSE') {
      log('AI EXIT: ' + pos.base + ' → KAPAT (' + (j.reason || 'ters dönüş') + ')');
      await closePaper(pos, px, 'AI_EXIT');
    }
  } catch(e) { /* sessiz */ }
}

/* ───────── MONITOR ───────── */
async function monitorPaper() {
  const now = Date.now();
  for (const pos of paper.open.slice()) {
    const px = priceOf(pos.symbol); if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px); pos.ageMs = now - pos.openedAt;
    pos.livePnl = +((pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
    pos.livePnlPct = +(pos.livePnl / Math.max(0.0001, pos.margin) * 100).toFixed(2);
    if (pos.remainingQty <= 0) { await closePaper(pos, px, 'TP2'); continue; }
    
    // AI Yönetimi (OtoTrade ve Scalp için)
    if (pos.module === 'AUTO') aiManageAutoTrade(pos).catch(()=>{});

    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { await closePaper(pos, pos.curSl, pos.tp1Hit ? 'BE' : 'SL'); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { await closePaper(pos, pos.tp2, 'TP2'); continue; }
    
    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const q = +(pos.initialQty * 0.5).toFixed(8);
      closePortion(pos, q, pos.tp1);
      pos.tp1Hit = true;
      pos.curSl = rp(pos.entry + d * pos.entry * EX.H / 100);
      const sig = signals.find(s => s.id === pos.sigId);
      if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
      dirty = true;
      log('TP1: ' + pos.base + ' yarısı alındı, stop ' + pos.curSl + ' (BE)');
      if (pos.isLive) { // Canlıda TP1'de stopu güncelle
        try { if (pos.stopId) await cancelStopOrder(pos); pos.stopId = await placeStop(pos.symbol, pos.dir === 'LONG' ? 'sell' : 'buy', pos.remainingQty, pos.curSl); } catch(e){}
      }
    }
    if (now - pos.openedAt >= pos.maxHoldMs) { await closePaper(pos, px, 'TIME'); continue; }
  }
}

function closeVirtual(sig, exitPx, result) {
  const d = sig.dir === 'LONG' ? 1 : -1; const risk = Math.abs(sig.entry - sig.sl); if (!(risk > 0)) return;
  const riskPct = risk / sig.entry * 100; let grossR = sig.tp1Hit ? 0.5 * Math.abs(sig.tp1 - sig.entry) / risk + 0.5 * ((exitPx - sig.entry) * d / risk) : (exitPx - sig.entry) * d / risk;
  const netR = +(grossR - EX.H / riskPct).toFixed(3);
  sig.status = 'KAPALI'; sig.result = result; sig.exit = rp(exitPx); sig.closedAt = Date.now(); sig.grossR = +grossR.toFixed(3); sig.netR = netR; sig.pnlUsdt = null; sig.analysis = analyzeSignal(sig);
  OUT.push({ t: Date.now(), module: sig.module, base: sig.base, dir: sig.dir, result, netR, pnl: null, setup: 'LT', conf: sig.conf, createdAt: sig.createdAt }); capArr(OUT, 300);
  dirty = true;
  log('LT SANAL KAPANDI: ' + sig.base + ' ' + sig.dir + ' → ' + (RES[result] || result) + ' | net ' + netR + 'R');
}

function monitorVirtual() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'KAPALI' || sig.tradeable !== false) continue;
    const px = priceOf(sig.symbol); if (!(px > 0)) continue;
    const d = sig.dir === 'LONG' ? 1 : -1;
    if (now - sig.createdAt > (sig.maxAgeMs || MODS.LT.maxAge)) { closeVirtual(sig, px, 'TIME'); continue; }
    if (sig.tp2 && (d === 1 ? px >= sig.tp2 : px <= sig.tp2)) { closeVirtual(sig, sig.tp2, 'TP2'); continue; }
    if (d === 1 ? px <= sig.curSl : px >= sig.curSl) { closeVirtual(sig, sig.curSl, sig.tp1Hit ? 'BE' : 'SL'); continue; }
    if (!sig.tp1Hit && (d === 1 ? px >= sig.tp1 : px <= sig.tp1)) {
      sig.tp1Hit = true; sig.curSl = rp(sig.entry + d * sig.entry * EX.H / 100); dirty = true;
      log('LT TP1 (sanal): ' + sig.base + ' yarısı alındı, stop ' + sig.curSl);
    }
  }
}

function paperSummary() {
  const closed = paper.closed; const wins = closed.filter(x => x.pnl > 0).length; const losses = closed.filter(x => x.pnl <= 0).length;
  const sumPnl = +closed.reduce((s, x) => s + num(x.pnl), 0).toFixed(4);
  let unrealized = 0;
  for (const p of paper.open) { const px = priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  const eq = paper.equity; const peak = Math.max(paper.peak || eq, eq);
  return { equity: +eq.toFixed(2), balance: +eq.toFixed(2), start: paper.start, dayStart: +paper.dayStart.toFixed(2), dayPnl: dayPnl(), open: paper.open.length, closed: closed.length, wins, losses, winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : 0, sumPnl, avgPnl: closed.length ? +(sumPnl / closed.length).toFixed(2) : 0, unrealized: +unrealized.toFixed(2), peak: +peak.toFixed(2), drawdownPct: peak > 0 ? +((peak - eq) / peak * 100).toFixed(2) : 0 };
}

function paperSettingsView() { return { auto: settings.auto, tradeMode: settings.tradeMode, margin: settings.margin, leverage: settings.leverage, riskPct: settings.riskPct, maxOpen: settings.maxOpen, dailyLossPct: settings.dailyLossPct, liveMaxMargin: settings.liveMaxMargin, liveMaxLeverage: settings.liveMaxLeverage }; }

function viewPaper(p) {
  const px = priceOf(p.symbol) || p.entry; const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +((p.grossRealized - p.costPaid) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(0.0001, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt, durationMs: Date.now() - p.openedAt });
}

function viewSignal(s) {
  const plan = (s.info && s.info.plan) || { entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2 };
  return Object.assign({}, s, { ageMs: Date.now() - s.createdAt, approvalRemainingMs: s.approvalExpiresAt ? Math.max(0, s.approvalExpiresAt - Date.now()) : 0, riskPct: +(Math.abs(s.entry - s.sl) / s.entry * 100).toFixed(2), plan, analysis: s.analysis || analyzeSignal(s) });
}

/* ───────── İSTATİSTİK ───────── */
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
    const wins = filled.filter(s => s.netR > 0); const losses = filled.filter(s => s.netR <= 0);
    const vWins = virt.filter(s => s.netR > 0);
    const reasons = {}, skipReasons = {};
    for (const s of filled) reasons[s.result] = (reasons[s.result] || 0) + 1;
    for (const s of skipped) skipReasons[s.result] = (skipReasons[s.result] || 0) + 1;
    const netR = +filled.reduce((a, s) => a + num(s.netR), 0).toFixed(3);
    const grossR = +filled.reduce((a, s) => a + num(s.grossR), 0).toFixed(3);
    rows.push({ module: m, label: MODS[m].label, total: list.length, open: open.length, filled: filled.length, skipped: skipped.length, unfilled: list.filter(s => s.status === 'KAPALI' && !TRADE_RESULTS.has(s.result) && !SKIP_RESULTS.has(s.result)).length, wins: wins.length, losses: losses.length, winRate: filled.length ? +(wins.length / filled.length * 100).toFixed(1) : 0, grossR, netR, avgR: filled.length ? +(netR / filled.length).toFixed(3) : null, virtual: virt.length, virtualWins: vWins.length, hitRate: virt.length ? +(vWins.length / virt.length * 100).toFixed(1) : 0, reasons, skipReasons });
  }
  const tot = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, filled: 0, skipped: 0, unfilled: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, avgR: null, virtual: 0, virtualWins: 0, hitRate: 0, reasons: {}, skipReasons: {} };
  for (const r of rows) {
    for (const k of ['total', 'open', 'filled', 'skipped', 'unfilled', 'wins', 'losses', 'virtual', 'virtualWins']) tot[k] += r[k];
    tot.grossR += r.grossR; tot.netR += r.netR;
    for (const k of Object.keys(r.reasons)) tot.reasons[k] = (tot.reasons[k] || 0) + r.reasons[k];
    for (const k of Object.keys(r.skipReasons)) tot.skipReasons[k] = (tot.skipReasons[k] || 0) + r.skipReasons[k];
  }
  tot.grossR = +tot.grossR.toFixed(3); tot.netR = +tot.netR.toFixed(3); tot.winRate = tot.filled ? +(tot.wins / tot.filled * 100).toFixed(1) : 0;
  tot.avgR = tot.filled ? +(tot.netR / tot.filled).toFixed(3) : null; tot.hitRate = tot.virtual ? +(tot.virtualWins / tot.virtual * 100).toFixed(1) : 0;
  rows.push(tot);
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════════
   AI KATMANI — Yön Tayini, Giriş Onayı, Keşif
   ══════════════════════════════════════════════════════════════════════════════ */
const AI_CFG = { modules: ['AUTO', 'LT', 'SCALP'], maxPerDay: 400, maxPerHour: 80, briefPerDay: 6, pumpMinScore: 55, ltMinScore: 45, timeoutMs: 25000, approvalWindowMs: 10 * M1, cacheMs: 5 * M1, gapMs: 1400 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function aiKeys() { return AI_PROV.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled === true && aiKeys().length > 0); }
function aiQuota() {
  const now = Date.now(); const dk = dayKey(now), hk = Math.floor(now / H1);
  if (AI_USAGE.dayKey !== dk) { AI_USAGE.dayKey = dk; AI_USAGE.dayCount = 0; }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  if (AI_USAGE.briefDay !== dk) { AI_USAGE.briefDay = dk; AI_USAGE.briefCount = 0; }
  const ok = AI_USAGE.dayCount < AI_CFG.maxPerDay && AI_USAGE.hourCount < AI_CFG.maxPerHour;
  return { ok, day: dk, hour: hk, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount, leftDay: Math.max(0, AI_CFG.maxPerDay - AI_USAGE.dayCount), leftHour: Math.max(0, AI_CFG.maxPerHour - AI_USAGE.hourCount) };
}
function orderedProviders(prefer) {
  const now = Date.now();
  return aiKeys().slice().sort((a, b) => {
    const ca = (a.cooldownUntil || 0) > now ? 1 : 0; const cb = (b.cooldownUntil || 0) > now ? 1 : 0;
    if (ca !== cb) return ca - cb;
    if (prefer) { if (a.id === prefer) return -1; if (b.id === prefer) return 1; }
    return (a.prefer || 9) - (b.prefer || 9);
  });
}
function aiProviderView(p) {
  const now = Date.now(); const lat = (p.lat || []).filter(v => Number.isFinite(v));
  return { id: p.id, name: p.name, hasKey: !!p.key, models: p.models.slice(), ok: p.ok || 0, fail: p.fail || 0, avgMs: lat.length ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : 0, cooldownSec: Math.max(0, Math.ceil(((p.cooldownUntil || 0) - now) / 1000)), lastError: p.lastError || null, modelCooldowns: Object.assign({}, p.modelCooldowns || {}), prefer: p.prefer || 9 };
}
function aiStatus() {
  const q = aiQuota();
  return { enabled: aiReady(), settingsEnabled: settings.aiEnabled === true, watchAuto: settings.aiWatchAuto === true, keys: aiKeys().length, providers: AI_PROV.map(aiProviderView), usage: { dayKey: q.day, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount, briefCount: AI_USAGE.briefCount, lastAt: AI_USAGE.lastAt || 0, lastError: AI_USAGE.lastError || null }, limits: { maxPerDay: AI_CFG.maxPerDay, maxPerHour: AI_CFG.maxPerHour, briefPerDay: AI_CFG.briefPerDay, pumpMinScore: AI_CFG.pumpMinScore, ltMinScore: AI_CFG.ltMinScore }, queue: AI_QUEUE.length, busy: AI_STATE.busy === true, lastAt: AI_STATE.lastAt || 0, lastError: AI_STATE.lastError || null, brief: marketBrief || null };
}

function normTR(s) { return String(s == null ? '' : s).replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g').replace(/Ü/g, 'U').replace(/ü/g, 'u').replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c').toUpperCase().replace(/\s+/g, ' ').trim(); }
function parseAIJSON(text) {
  let raw = String(text || '').trim(); raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { return { verdict: 'RED', score: 0, trust: 'DÜŞÜK', reason: 'AI yanıtı okunamadı', summary: raw.slice(0, 300), risks: ['AI yanıtı JSON biçiminde değil'], parseError: true }; }
  const v = normTR(j.verdict || j.decision || j.karar || j.entryDecision || '');
  const no = /GIRILMEZ|GIRME|RED|REJECT|HAYIR|NO$/.test(v); const yes = !no && /GIRILIR|GIREBILIR|AL$|BUY|LONG|APPROVE|ONAY|UYGUN|EVET/.test(v);
  const verdict = yes ? 'ONY' : 'RED';
  let trust = normTR(j.trust || j.confidence || j.guven || '');
  if (/YUKSEK|HIGH/.test(trust)) trust = 'YÜKSEK'; else if (/DUSUK|LOW/.test(trust)) trust = 'DÜŞÜK'; else trust = 'ORTA';
  let score = Number(j.score != null ? j.score : j.puan); if (!Number.isFinite(score)) score = trust === 'YÜKSEK' ? 80 : trust === 'ORTA' ? 60 : 40;
  score = clamp(Math.round(score), 0, 100);
  const arr = x => { if (Array.isArray(x)) return x.map(v2 => String(v2)).filter(Boolean).slice(0, 4); if (typeof x === 'string' && x.trim()) return x.split(/[\n;\u2022]/).map(v2 => v2.trim()).filter(Boolean).slice(0, 4); return []; };
  return { verdict, score, trust, reason: String(j.reason || j.neden || '').slice(0, 300), summary: String(j.summary || j.ozet || j.reason || j.neden || '').slice(0, 500), risks: arr(j.risks || j.riskler), parseError: false };
}
function looseJSON(text) { try { const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); return JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw); } catch (e) { return null; } }

function isModelError(e) { const s = String((e && e.message) || '').toLowerCase(); return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer/.test(s); }
function isQuotaExhausted(e) { const s = String((e && e.message) || '').toLowerCase(); return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|credit balance|exceeded.*quota|resource_exhausted/.test(s); }
function isTransientAIError(e) { const status = Number(e && e.status) || 0; return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e); }
function providerFail(p, e) {
  const status = Number(e && e.status) || 0; p.fail = (p.fail || 0) + 1; p.lastError = redact((e && e.message) || 'bilinmeyen hata');
  let ms = M1;
  if (isQuotaExhausted(e)) ms = 6 * H1; else if (status === 402) ms = 6 * H1; else if (status === 429) ms = 2 * M1; else if (status === 401 || status === 403) ms = 60 * M1; else if (status >= 500) ms = 2 * M1; else if (isModelError(e)) ms = 10 * M1;
  p.cooldownUntil = Date.now() + ms; AI_USAGE.lastError = p.name + ': ' + p.lastError; AI_USAGE.lastAt = Date.now(); AI_STATE.lastError = AI_USAGE.lastError; dirty = true;
  log('AI HATA: ' + p.name + ' → ' + p.lastError + ' | ' + Math.ceil(ms / 1000) + ' sn bekleme');
}

/* v84.1 Yamalı Model Keşfi */
async function discoverModels(p) {
  if (!p.key) return [];
  const url = p.base.replace(/\/$/, '') + '/models';
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + p.key }, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const raw = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
    return raw.map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  } catch (e) { p.lastError = 'Keşif: ' + redact(e.message); return []; }
  finally { clearTimeout(tm); }
}

function pickModelsFor(providerId, list) {
  const bad = /whisper|guard|tts|playai|orpheus|embed|safeguard|compound|audio|image|vision|moderation|deprecat|decommission/i;
  const ok = list.filter(id => !bad.test(id));
  
  if (providerId === 'gemini') {
    const out = [];
    for (const re of [/gemini-2\.0-flash/, /gemini-1\.5-flash-latest/, /gemini-1\.5-flash-002/, /gemini-1\.5-flash-001/, /gemini-1\.5-flash/]) {
      const m = ok.find(x => re.test(x) && !out.includes(x));
      if (m) out.push(m);
      if (out.length >= 2) break;
    }
    return out.length ? out : ['gemini-1.5-flash'];
  }
  
  if (providerId === 'groq') {
    const out = [];
    for (const re of [/llama-3\.3-70b-versatile/, /llama-3\.1-8b-instant/, /llama-3\.1-70b-versatile/, /llama3-70b-8192/, /llama3-8b-8192/, /gemma2-9b-it/]) {
      const m = ok.find(x => re.test(x) && !out.includes(x));
      if (m) out.push(m);
      if (out.length >= 3) break;
    }
    return out.length ? out : ['llama-3.1-8b-instant'];
  }
  
  if (providerId === 'openrouter') {
    const free = ok.filter(id => /:free$/.test(id));
    if (free.length) return free.slice(0, 3);
    return [];
  }
  
  if (providerId === 'deepseek') return ['deepseek-chat'];
  
  if (providerId === 'openai') {
    const out = [];
    for (const re of [/gpt-4o-mini/, /gpt-4o/, /gpt-3\.5-turbo/]) {
      const m = ok.find(x => re.test(x) && !out.includes(x));
      if (m) out.push(m);
      if (out.length >= 2) break;
    }
    return out.length ? out : ['gpt-4o-mini'];
  }
  return ok.slice(0, 3);
}

async function discoverAll() {
  const res = [];
  for (const p of AI_PROV) {
    if (!p.key) { res.push({ id: p.id, ok: false, note: 'anahtar yok' }); continue; }
    const list = await discoverModels(p);
    if (!list.length) { res.push({ id: p.id, ok: false, note: 'model listesi alınamadı', error: p.lastError }); continue; }
    const picked = pickModelsFor(p.id, list);
    if (picked.length) {
      p.models = picked;
      p.modelCooldowns = {};
      p.cooldownUntil = 0;
      p.lastError = null;
      p.badModels = {};   // keşifte temizle
      log('AI MODEL KEŞFİ: ' + p.name + ' → ' + picked.join(', '));
      res.push({ id: p.id, ok: true, models: picked });
    } else {
      res.push({ id: p.id, ok: false, note: 'uygun model yok', total: list.length });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return res;
}

async function callProviderModel(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI_CFG.timeoutMs; const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), tmo); const t0 = Date.now();
  try {
    const url = p.base.replace(/\/$/, '') + '/chat/completions';
    const res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, body: JSON.stringify({ model, messages, temperature: 0.15, max_tokens: 450, stream: false }) });
    const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.message) || txt.slice(0, 300) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = res.status; const ra = res.headers.get('retry-after'); if (ra) { const n = Number(ra); er.retryAfterMs = Number.isFinite(n) ? n * 1000 : 60000; } throw er; }
    if (!j) throw new Error('geçersiz JSON yanıtı');
    if (j.error && !j.choices) { const er = new Error(redact(j.error.message || j.error.code || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
    let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
    if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
    if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.emptyResp = true; throw er; }
    p.lat = (p.lat || []).concat(Date.now() - t0).slice(-20);
    return { text: String(c), model: (j.model || model) };
  } catch (e) { if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı'); er.status = 0; throw er; } throw e; } finally { clearTimeout(timer); }
}

async function callProvider(p, messages, opts) {
  const now = Date.now(); 
  const usable = (p.models || []).filter(m => 
    !((p.modelCooldowns && p.modelCooldowns[m]) > now) && 
    !((p.badModels && p.badModels[m]) === true)
  );
  if (!usable.length) { const er = new Error('tüm modeller soğumada'); er.status = 404; er.allModelsCooldown = true; throw er; }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const gap = AI_CFG.gapMs; const at = Math.max(Date.now(), p.nextAt || 0); p.nextAt = at + gap; if (at > Date.now()) await sleep(Math.min(at - Date.now(), 8000)); return await callProviderModel(p, messages, model, opts); }
      catch (e) {
        lastErr = e;
        if (isModelError(e)) { 
          p.badModels = p.badModels || {}; 
          p.badModels[model] = true; 
          p.models = (p.models || []).filter(m => m !== model); 
          log('AI MODEL KALICI OLARAK ÇIKARILDI: ' + p.name + '/' + model + ' → ' + redact(e.message).slice(0, 120)); 
          break; 
        }
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
  opts = opts || {}; let lastErr = null;
  for (const p of orderedProviders(opts.prefer)) {
    if ((p.cooldownUntil || 0) > Date.now()) continue; const q = aiQuota(); if (!q.ok) throw new Error('AI kotası doldu');
    try { const t0 = Date.now(); const r = await callProvider(p, messages, opts); const parsed = parseAIJSON(r.text); p.ok = (p.ok || 0) + 1; p.lastAt = Date.now(); p.lastError = null; AI_USAGE.dayCount++; AI_USAGE.hourCount++; AI_USAGE.lastAt = Date.now(); AI_USAGE.lastError = null; AI_STATE.lastAt = Date.now(); AI_STATE.lastError = null; dirty = true; return Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai' }); }
    catch (e) { lastErr = e; providerFail(p, e); }
  }
  throw lastErr || new Error('AI sağlayıcısı yok');
}

/* ───────── SİNYAL AI İNCELEMESİ ───────── */
const AI_SYS = 'Sen AlphaSon adlı kripto sinyal süzgecisin. Sinyali önce matematik üretti. Sen yalnızca şu soruya cevap verirsin: "Girişe engel açık bir sorun var mı?" Kararın SADECE "GİRİLİR" veya "GİRİLMEZ" olur. Açık bir sorun yoksa GİRİLİR de. Çok basit günlük Türkçe kullan. Veride olmayan sayı uydurma. Yalnızca JSON döndür.';

async function aiContextFor(sig) {
  const tf = sig.module === 'LT' ? ((sig.info && sig.info.tf) || '2h') : '5m';
  const cs = await getCandles(sig.symbol, tf, 60, false); if (!cs || !cs.length) return '(veri yok)';
  return cs.slice(-24).map(c => { const t = new Date(c.t).toISOString().replace('T', ' ').slice(0, 16); const p = c.c >= 1 ? 4 : 6; return t + ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v); }).join('\n');
}

function aiPromptFor(sig, ctx) {
  const i = sig.info || {}; const plan = i.plan || { entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2 };
  let strategy = sig.module === 'LT' ? 'LT Üçgen: Sıkışma kırılımı.' : sig.module === 'AUTO' ? 'OtoTrade (Pump/Dump): Ani hacim ve fiyat patlaması/çöküşü.' : 'Günlük Hızlı Scalp: VWAP/ORB/REV.';
  let head = MODS[sig.module].label + ' sinyali: ' + sig.base + ' ' + sig.dir + '\n' + strategy + '\n' +
    'Giriş: ' + sig.entry + ' | Stop: ' + sig.sl + ' | Hedef 1: ' + sig.tp1 + (sig.tp2 ? ' | Hedef 2: ' + sig.tp2 : '') + '\n' +
    'Matematik güven puanı: ' + sig.conf + '/100 | Net R:R: ' + (i.netRR != null ? i.netRR : '?') + '\n' +
    'Piyasa yönü: ' + market.dir + ' (skor ' + market.score + ')\n';
  let body = 'Kurulum: ' + (i.setup || '?') + ' | ATR% ' + (i.atrPct != null ? i.atrPct : '?') + ' | Hacim ' + (i.volRatio != null ? i.volRatio : '?') + 'x | RSI ' + (i.rsi != null ? i.rsi : '?') + ' | ADX ' + (i.adx != null ? i.adx : '?') + '\n';
  return head + body + '\nSon mumlar:\n' + ctx + '\n\nGörevin yalnızca karar vermek. Planı değiştirme. Şu durumlarda GİRİLMEZ de: kırılım sahte görünüyor, hareket zaten çok uzamış, hacim sönük, piyasa yönü sert ters. Bunların hiçbiri yoksa GİRİLİR de.\nJSON şeması: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"reason":"tek kısa cümle","summary":"en fazla 2 cümle","risks":["risk"]}\nSadece JSON döndür.';
}

async function aiReview(sig, opts) {
  opts = opts || {}; if (!sig || !AI_CFG.modules.includes(sig.module)) return null; if (sig.status === 'KAPALI') return sig.ai || null;
  if (!aiReady()) { sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'MATH_ONLY', note: 'AI kapalı — matematik kararı', decidedAt: Date.now() }); if (sig.module === 'AUTO' && sig.status === 'AI_BEKLIYOR') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; } dirty = true; return null; }
  const q = aiQuota(); if (!q.ok) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI kotası doldu' }); sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'AI kotası doldu', decidedAt: Date.now() }); if (sig.module === 'AUTO' && sig.status === 'AI_BEKLIYOR') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; } dirty = true; return null; }
  let ctx; try { ctx = await aiContextFor(sig); } catch (e) { sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'Veri alınamadı', decidedAt: Date.now() }); if (sig.module === 'AUTO' && sig.status === 'AI_BEKLIYOR') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; } dirty = true; return null; }
  let ai = null; try { ai = await callAI([ { role: 'system', content: AI_SYS }, { role: 'user', content: aiPromptFor(sig, ctx) } ], { prefer: sig.module === 'AUTO' ? 'groq' : null, timeoutMs: AI_CFG.timeoutMs }); }
  catch (e) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI yanıt vermedi: ' + redact(e.message), at: Date.now() }); sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'OFFLINE', note: 'AI yanıtı yok', decidedAt: Date.now() }); AI_STATE.lastError = redact(e.message); if (sig.module === 'AUTO' && sig.status === 'AI_BEKLIYOR') { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; } dirty = true; log('AI YANIT YOK: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + redact(e.message) + ' | matematik kararı'); return null; }
  sig.ai = ai; AI_HIST.push({ at: ai.at, kind: 'Sinyal', module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir, provider: ai.providerName, model: ai.model, decision: ai.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: 'SİNYAL', score: ai.score, dataQuality: 'TAM', disagree: false, verdict: ai.verdict, trust: ai.trust, reason: ai.reason || ai.summary, latencyMs: ai.latencyMs }); capArr(AI_HIST, 200);
  const approved = ai.verdict === 'ONY' && Number(ai.score) >= (sig.module === 'LT' ? AI_CFG.ltMinScore : AI_CFG.pumpMinScore);
  if (!approved) { const note = 'AI: GİRİLMEZ' + (ai.score != null ? ' (' + ai.score + '/100)' : '') + (ai.reason ? ' — ' + ai.reason : ''); sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'AI_RED', note, decidedAt: Date.now(), score: ai.score, trust: ai.trust, provider: ai.provider }); skipSignal(sig, 'AI_RED', note); logRej(sig.module, sig.symbol, 'AI GİRİLMEZ', sig.entry); return ai; }
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'APPROVED', note: 'AI: GİRİLİR' + (ai.reason ? ' — ' + ai.reason : ''), decidedAt: Date.now(), score: ai.score, trust: ai.trust, provider: ai.provider });
  if (sig.module === 'AUTO') {
    if (sig.status === 'AI_BEKLIYOR' || sig.status === 'ONAY_BEKLIYOR') {
      if (canAutoOpen()) { const r = openPaper(sig); if (r && r.error) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; sig.aiGate = Object.assign({}, sig.aiGate, { note: 'AI GİRİLİR ama oto açılamadı: ' + r.error }); log('OTO AÇILAMADI: ' + sig.base + ' → ' + r.error + ' | ONAY BEKLİYOR'); } }
      else { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI_CFG.approvalWindowMs; log('AI GİRİLİR (ONAY): ' + sig.base + ' ' + sig.dir + ' | ' + ai.score + '/100 | oto kapalı → ONAY BEKLİYOR'); }
    }
  } else if (sig.status !== 'KAPALI') { sig.status = 'AKTIF'; }
  sig.analysis = analyzeSignal(sig); dirty = true;
  log('AI: ' + MODS[sig.module].label + ' ' + sig.base + ' → GİRİLİR (' + ai.trust + ' güven, ' + ai.score + ' puan, ' + ai.providerName + '/' + ai.model + ', ' + ai.latencyMs + 'ms)');
  return ai;
}

function queueAI(sig, opts) {
  if (!sig || !AI_CFG.modules.includes(sig.module) || !aiReady()) return;
  if (AI_QUEUE.some(x => x.id === sig.id)) return;
  AI_QUEUE.push({ id: sig.id, force: !!(opts && opts.force), at: Date.now() });
  if (AI_QUEUE.length > 40) AI_QUEUE.splice(0, AI_QUEUE.length - 40);
  runAIQueue();
}
async function runAIQueue() {
  if (AI_STATE.busy) return; AI_STATE.busy = true;
  try { while (AI_QUEUE.length) { const job = AI_QUEUE.shift(); const sig = signals.find(s => s.id === job.id); if (!sig) continue; try { await aiReview(sig, { force: job.force }); } catch (e) { log('AI KUYRUK HATASI: ' + redact(e.message)); } } }
  finally { AI_STATE.busy = false; }
}

/* ───────── WATCH AI & MANUEL SORMA ───────── */
async function watchAI(kind, base) {
  if (!aiReady()) return { error: settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok' };
  const rows = kind === 'lt' ? WATCH.lt : kind === 'scalp' ? WATCH.scalp : WATCH.auto;
  const row = rows.find(r => String(r.base).toUpperCase() === String(base).toUpperCase());
  if (!row) return { error: 'coin izleme listesinde yok' };
  try {
    const prompt = 'İzleme satırı: ' + JSON.stringify(row) + '\nBu coin girişe uygun mu? JSON döndür: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"reason":"tek kısa cümle","summary":"en fazla 2 cümle","risks":["risk"]}';
    const ai = await callAI([ { role: 'system', content: AI_SYS }, { role: 'user', content: prompt } ], { timeoutMs: AI_CFG.timeoutMs });
    const view = { verdict: ai.verdict, label: ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ', verdictLabel: ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ', score: ai.score, trust: ai.trust, reason: ai.reason || ai.summary, summary: ai.summary, risks: ai.risks, provider: ai.providerName, model: ai.model, at: ai.at };
    row.ai = view; AI_HIST.push({ at: ai.at, kind: kind.toUpperCase(), module: kind === 'lt' ? 'LT' : 'SCALP', symbol: row.symbol, base: row.base, dir: row.dir || row.dirHint, provider: ai.providerName, model: ai.model, decision: ai.verdict === 'ONY' ? 'CANDIDATE' : 'REJECT', phase: 'İZLEME', score: ai.score, dataQuality: 'TAM', disagree: false, verdict: ai.verdict, trust: ai.trust, reason: ai.reason || ai.summary, latencyMs: ai.latencyMs });
    capArr(AI_HIST, 200); dirty = true;
    log('İZLEME AI: ' + kind.toUpperCase() + ' ' + row.base + ' → ' + view.label + ' (' + ai.score + ')');
    return { ok: true, ai: view };
  } catch (e) { log('İZLEME AI HATASI: ' + row.base + ' → ' + redact(e.message)); return { error: redact(e.message) }; }
}

async function maybeWatchAI() {
  if (!aiReady() || settings.aiWatchAuto !== true) return;
  if (AI_STATE.busy) return;
  const lt = WATCH.lt.find(r => !r.ai); if (lt) await watchAI('lt', lt.base);
  const sc = WATCH.scalp.find(r => !r.ai); if (sc) await watchAI('scalp', sc.base);
  const au = WATCH.auto.find(r => !r.ai); if (au) await watchAI('auto', au.base);
}

/* ───────── AI PİYASA YÖNÜ ───────── */
async function aiMarketDirection() {
  if (!aiReady()) return null;
  if (Date.now() - lastMarketAI < 10 * M1 && lastMarketAIDir) return lastMarketAIDir;
  lastMarketAI = Date.now();
  try {
    const btc = await getCandles('BTC/USDT:USDT', '15m', 30, true); const eth = await getCandles('ETH/USDT:USDT', '15m', 30, true);
    if (!btc || btc.length < 12) return null;
    const fmt = cs => (cs || []).slice(-16).map(c => new Date(c.t).toISOString().slice(11, 16) + ' O' + c.o + ' H' + c.h + ' L' + c.l + ' C' + c.c + ' V' + Math.round(c.v)).join('\n');
    let green = 0, tot = 0; for (const s of UNIVERSE) { const t = tick(s); if (t && t.chg != null) { tot++; if (t.chg > 0) green++; } }
    const breadth = tot ? green / tot : 0.5;
    const prompt = '15 dakikalık BTC mumları (en yeni en sonda):\n' + fmt(btc) + '\n\n15 dakikalık ETH mumları:\n' + fmt(eth) + '\n\nPiyasa genişliği: %' + Math.round(breadth * 100) + ' coin yeşil.\n\nSorular: Piyasa kısa vadede (15-45 dk) yukarı mı, aşağı mı, yoksa nötr mü? Sert düşüş veya sert yükseliş olacak mı? Kısa bir cümleyle neden?\n\nYanıt SADECE JSON olsun: {"dir":"LONG|SHORT|NOTR","score":0.0-1.0,"reason":"tek kısa cümle"}';
    for (const p of orderedProviders()) {
      if ((p.cooldownUntil || 0) > Date.now()) continue; if (!aiQuota().ok) break;
      try {
        const r = await callProvider(p, [ { role: 'system', content: 'Sen AlphaSon piyasa yönü belirleyicisisin. Sadece JSON döndür. Kısa ve net.' }, { role: 'user', content: prompt } ], { timeoutMs: 18000 });
        let j = null; const raw = String(r.text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
        try { j = JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw); } catch (e) { j = null; }
        if (!j || !j.dir) continue;
        let dir = String(j.dir).toUpperCase(); if (!['LONG', 'SHORT', 'NOTR'].includes(dir)) { if (/LONG|YUKARI|YÜKSELİŞ/.test(dir)) dir = 'LONG'; else if (/SHORT|AŞAĞI|DÜŞÜŞ/.test(dir)) dir = 'SHORT'; else dir = 'NOTR'; }
        const score = clamp(Number(j.score) || 0.5, 0, 1); const reason = String(j.reason || j.summary || '').slice(0, 200);
        AI_USAGE.dayCount++; AI_USAGE.hourCount++; AI_USAGE.lastAt = Date.now(); dirty = true;
        const result = { dir, score: +score.toFixed(2), reason, provider: p.name, at: Date.now() }; lastMarketAIDir = result;
        log('AI PİYASA YÖNÜ: ' + dir + ' (skor ' + score.toFixed(2) + ') — ' + reason + ' [' + p.name + ']'); return result;
      } catch (e) { providerFail(p, e); }
    }
  } catch (e) { log('AI yön tayini hatası: ' + redact(e.message)); }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP API
   ══════════════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const h = fn => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch(e => { log('API HATASI: ' + req.method + ' ' + req.path + ' → ' + redact(e.message)); if (!res.headersSent) res.status(500).json({ error: redact(e.message) }); }); };
function tvUrl(sym) { return 'https://www.tradingview.com/chart/?symbol=BITGET:' + encodeURIComponent(baseOf(sym)) + 'USDT.P'; }

function chartPayload(sym, tf, cs, sig, extra) {
  const cl = closesOf(cs); const e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  const out = { symbol: sym, base: baseOf(sym), tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]), ema20: e20.map(v => v == null ? null : rp(v)), ema50: e50.map(v => v == null ? null : rp(v)), tradingview: tvUrl(sym), signal: sig ? viewSignal(sig) : { base: baseOf(sym), dir: (extra && extra.dir) || null, entry: num(extra && extra.entry), sl: num(extra && extra.sl), tp1: num(extra && extra.tp1), tp2: num(extra && extra.tp2) }, levels: [], triangle: null, supportResistance: [] };
  if (sig && sig.module === 'LT') {
    let tri = analyzeTriangle(cs, tf); let tc = null;
    if (tri) tc = triangleChart(tri, cs, tf); else { const cached = LT_CACHE.get(sym); if (cached && cached.tri) { tri = cached.tri; tc = triangleChart(cached.tri, cached.cs, cached.tri.tf); } }
    if (tc) { out.triangle = tc; out.levels = [{ v: tc.upperNow, col: '#f6465d', l: 'ÜST ÇİZGİ' }, { v: tc.lowerNow, col: '#0ecb81', l: 'ALT ÇİZGİ' }]; out.supportResistance = srLevels(cs, tri ? tri.atr : 0, priceOf(sym) || cl[cl.length - 1]); }
  } else if (extra && (Number(extra.upper) > 0 || Number(extra.lower) > 0)) { if (Number(extra.upper) > 0) out.levels.push({ v: Number(extra.upper), col: '#f6465d', l: 'ÜST' }); if (Number(extra.lower) > 0) out.levels.push({ v: Number(extra.lower), col: '#0ecb81', l: 'ALT' }); }
  return out;
}

app.get('/', (req, res) => { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) res.sendFile(p); else res.type('text/plain').send('AlphaSon ' + VERSION + ' çalışıyor. Arayüz için index.html koyun.'); });
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, ready: READY, ai: aiReady(), live: settings.tradeMode === 'live' }));

app.get('/api/state', h((req, res) => {
  const active = signals.filter(isOpenSignal); const byModule = {}; for (const m of ACTIVE_MODULES) byModule[m] = active.filter(s => s.module === m).length;
  const modules = {}; for (const m of ACTIVE_MODULES) modules[m] = { enabled: MODS[m].enabled, label: MODS[m].label, tf: MODS[m].tf, tradeable: MODS[m].tradeable };
  res.json({ version: VERSION, at: Date.now(), ready: READY, settings, activeModules: ACTIVE_MODULES, modules, market, realBal, paper: paperSummary(), counts: { active: active.length, byModule, pendingApproval: active.filter(s => s.status === 'ONAY_BEKLIYOR').length, aiPending: active.filter(s => s.status === 'AI_BEKLIYOR').length, openPump: paper.open.length, autoMaxOpen: settings.maxOpen, totalSignals: signals.length, closed: signals.filter(s => s.status === 'KAPALI').length }, scan: { universe: UNIVERSE.length, scalpAt: lastScan.scalp || 0, ltAt: lastScan.lt || 0, autoAt: lastScan.auto || 0, tickAt: lastScan.tick || 0, ltWatch: WATCH.lt.length, scalpWatch: WATCH.scalp.length, autoWatch: WATCH.auto.length }, ai: aiStatus(), costPct: EX.H, hasKeys: HAS_KEYS });
}));

app.get('/api/signals', h((req, res) => {
  const mod = String(req.query.module || '').toUpperCase(); let list = signals.slice();
  if (mod) { if (!MODS[mod]) return res.json({ module: mod, active: [], closed: [], removed: true }); list = list.filter(s => s.module === mod); }
  const active = list.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt).map(viewSignal);
  const closed = list.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 100).map(viewSignal);
  res.json({ module: mod || null, active, closed, all: active.concat(closed) });
}));

app.get('/api/paper', h((req, res) => res.json({ settings: paperSettingsView(), summary: paperSummary(), open: paper.open.map(viewPaper), closed: paper.closed.slice(-50).reverse(), limits: { maxOpen: settings.maxOpen, autoMaxOpen: settings.maxOpen, dailyLossPct: settings.dailyLossPct, costPct: EX.H, live: settings.tradeMode === 'live' } })));

app.post('/api/paper/settings', h((req, res) => { settings = sanitizeSettings(Object.assign({}, settings, req.body || {})); dirty = true; saveState(true); res.json({ ok: true, settings }); }));
app.post('/api/paper/toggle', h((req, res) => { const b = req.body || {}; if (typeof b.auto === 'boolean') settings.auto = b.auto; else if (typeof b.enabled === 'boolean') settings.auto = b.enabled; else settings.auto = !settings.auto; dirty = true; saveState(true); res.json({ ok: true, auto: settings.auto }); }));
app.post('/api/paper/reset', h((req, res) => { const eq = settings.paperEquity; paper = { open: [], closed: [], equity: eq, start: eq, dayStart: eq, dayKey: dayKey(), peak: eq }; dirty = true; saveState(true); log('Paper sıfırlandı: ' + eq + ' USDT'); res.json({ ok: true, summary: paperSummary() }); }));
app.post('/api/paper/:id/close', h(async (req, res) => { const pos = paper.open.find(p => p.id === req.params.id); if (!pos) return res.status(404).json({ error: 'pozisyon yok' }); const px = priceOf(pos.symbol) || pos.entry; const ok = await closePaper(pos, px, 'MANUEL'); if (!ok) return res.status(500).json({ error: 'kapatılamadı' }); res.json({ ok: true, exit: rp(px) }); }));
app.post('/api/trade/mode', h(async (req, res) => {
  const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper';
  if (mode === 'live') { if (!HAS_KEYS) return res.status(400).json({ error: 'Canlı işlem için API anahtarları eksik!' }); await fetchRealBalance(); if (!(realBal.total > 0)) return res.status(400).json({ error: 'Bitget bakiyesi okunamadı' }); if (!(settings.dailyLossPct > 0)) settings.dailyLossPct = 3; }
  settings.tradeMode = mode; dirty = true; saveState(true); log('İŞLEM MODU: ' + mode.toUpperCase());
  res.json({ ok: true, settings, realBal });
}));
app.get('/api/balance', h(async (req, res) => { await fetchRealBalance(); res.json({ realBal, hasKeys: HAS_KEYS }); }));

app.get('/api/watch/:kind', h((req, res) => { const kind = String(req.params.kind || '').toLowerCase(); if (kind === 'lt') return res.json({ items: WATCH.lt, meta: WATCH_META.lt }); if (kind === 'scalp') return res.json({ items: WATCH.scalp, meta: WATCH_META.scalp }); if (kind === 'auto') return res.json({ items: WATCH.auto, meta: WATCH_META.auto }); res.json({ items: [], meta: null }); }));
app.post('/api/watch/:kind/:base/ai', h(async (req, res) => { const kind = req.params.kind; const r = await watchAI(kind, req.params.base); if (r.error) return res.status(400).json(r); res.json(r); }));

app.get('/api/chart/:id', h(async (req, res) => { const sig = signals.find(s => s.id === req.params.id); if (!sig) return res.status(404).json({ error: 'sinyal yok' }); const tf = (sig.info && sig.info.tf) || MODS[sig.module].chartTf; const cs = await getCandles(sig.symbol, tf, 220, false); if (!cs || !cs.length) return res.status(404).json({ error: 'mum verisi yok' }); res.json(chartPayload(sig.symbol, tf, cs, sig, null)); }));
app.get('/api/chart', h(async (req, res) => { const sym = String(req.query.symbol || ''); if (!sym.includes('/')) return res.status(400).json({ error: 'symbol gerekli' }); const tf = TF_MS[req.query.tf] ? String(req.query.tf) : '15m'; const cs = await getCandles(sym, tf, 220, false); if (!cs || !cs.length) return res.status(404).json({ error: 'mum verisi yok' }); const extra = { dir: String(req.query.dir || '').toUpperCase() || null, entry: num(req.query.entry), sl: num(req.query.sl), tp1: num(req.query.tp1), tp2: num(req.query.tp2), upper: num(req.query.upper), lower: num(req.query.lower) }; res.json(chartPayload(sym, tf, cs, null, extra)); }));

app.post('/api/signal/:id/close', h((req, res) => { const sig = signals.find(s => s.id === req.params.id); if (!sig) return res.status(404).json({ error: 'sinyal yok' }); if (sig.status === 'KAPALI') return res.json({ ok: true, note: 'zaten kapalı' }); const pos = paper.open.find(p => p.sigId === sig.id); const px = priceOf(sig.symbol) || sig.entry; if (pos) closePaper(pos, px, 'MANUEL'); else if (sig.tradeable === false) closeVirtual(sig, px, 'MANUEL'); else skipSignal(sig, 'SKIP', 'manuel kapatıldı'); res.json({ ok: true, exit: rp(px) }); }));
app.post('/api/signal/:id/execute', h(async (req, res) => { const sig = signals.find(s => s.id === req.params.id); if (!sig) return res.status(404).json({ error: 'sinyal yok' }); const r = approveSignal(sig); if (r && r.error) return res.status(400).json({ error: r.error }); res.json({ ok: true, position: r.pos ? viewPaper(r.pos) : null }); }));
app.post('/api/signal/:id/ai', h(async (req, res) => { const sig = signals.find(s => s.id === req.params.id); if (!sig) return res.status(404).json({ error: 'sinyal yok' }); if (sig.status === 'KAPALI') return res.status(400).json({ error: 'sinyal kapanmış' }); if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' }); const ai = await aiReview(sig, { force: true }); if (!ai) return res.status(502).json({ error: 'AI yanıt vermedi' }); res.json({ ok: true, ai: sig.ai, signal: viewSignal(sig) }); }));

app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: EX.H, version: VERSION })));
app.get('/api/rejections', h((req, res) => { const items = REJ.slice(-150).reverse().map(r => ({ at: r.t, lastAt: r.t, mod: r.module, module: r.module, base: r.base, symbol: r.symbol, code: r.reason, label: r.reason, reason: r.reason, count: r.n || 1, kind: 'MATEMATİK', price: r.price })); const byCode = {}; for (const r of REJ) byCode[r.reason] = (byCode[r.reason] || 0) + (r.n || 1); res.json({ items, byCode }); }));
app.get('/api/opportunities', h((req, res) => { const items = Array.from(OPP.values()).sort((a, b) => b.updatedAt - a.updatedAt).map(o => Object.assign({}, o, { ai: o.ai ? (o.ai.summary || o.ai.reason || '') : '' })); res.json({ items }); }));
app.get('/api/outcomes', h((req, res) => {
  const done = OUT.filter(o => Number.isFinite(o.netR)); const stats = [];
  for (const m of ACTIVE_MODULES) { for (const dir of ['LONG', 'SHORT']) { const list = done.filter(o => o.module === m && o.dir === dir); if (!list.length) continue; const wins = list.filter(o => o.netR > 0); const sum = list.reduce((s, o) => s + o.netR, 0); const gw = wins.reduce((s, o) => s + o.netR, 0); const gl = Math.abs(list.filter(o => o.netR <= 0).reduce((s, o) => s + o.netR, 0)); stats.push({ mod: m, kind: 'paper', dir, n: list.length, winRate: +(wins.length / list.length * 100).toFixed(1), avgNet15: +(sum / list.length).toFixed(3), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), avgMFE: 0, avgMAE: 0, sampleOk: list.length >= 30 }); } }
  const recent = done.slice(-40).reverse().map(o => ({ base: o.base, mod: o.module, dir: o.dir, p0: null, net15: o.netR, mfe: 0, mae: 0, timing: '', at: o.t }));
  res.json({ open: signals.filter(s => s.tradeable === false && s.status !== 'KAPALI').length, done: done.length, stats, recent, note: VERSION + ': sonuç ölçümü kapanan sinyallerin net R değerinden hesaplanır.' });
}));

app.get('/api/radar', h(async (req, res) => {
  const rsiOf = async (sym, tf) => { try { const cs = await getCandles(sym, tf, 120, true); return cs && cs.length ? rsiLast(closesOf(cs), 14) : null; } catch (e) { return null; } };
  const [b1, b4, e1, e4] = await Promise.all([rsiOf('BTC/USDT:USDT', '1h'), rsiOf('BTC/USDT:USDT', '4h'), rsiOf('ETH/USDT:USDT', '1h'), rsiOf('ETH/USDT:USDT', '4h')]);
  const r0 = v => v == null ? null : Math.round(v); const avg1 = [b1, e1].filter(v => v != null); const avg4 = [b4, e4].filter(v => v != null);
  res.json({ radar: { updatedAt: Date.now(), fng: null, rsi: { btc1h: r0(b1), btc4h: r0(b4), eth1h: r0(e1), eth4h: r0(e4), avg1h: avg1.length ? Math.round(avg1.reduce((s, v) => s + v, 0) / avg1.length) : null, avg4h: avg4.length ? Math.round(avg4.reduce((s, v) => s + v, 0) / avg4.length) : null, text: 'RSI 14 · BTC/ETH 1s ve 4s' }, ls: { long: 50, short: 50, text: 'Alış/satış oranı verisi yok.' }, extremes: { overbought: [], oversold: [] } }, market, moneyFlow: [] });
}));

app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: [ { module: 'AUTO', name: 'OtoTrade', active: true, tf: '5m', desc: 'Pump/Dump yakalama. AI giriş ve çıkışı yönetir. TP1 %50, TP2 tamamı. AI ters dönüş anında kapatır. Max 3 işlem.' }, { module: 'SCALP', name: 'Günlük Hızlı Scalp', active: true, tf: '5m', desc: 'ORB, VWAP Pullback, REV. TP1 1.5R, TP2 2.5R.' }, { module: 'LT', name: 'LT Üçgen', active: true, tf: '2h', desc: '2 saatlik grafikte sıkışma kırılımı. Sanal işlem.' } ], limits: { AUTO: MODS.AUTO.maxPerDaySym, LT: MODS.LT.maxPerDaySym, SCALP: MODS.SCALP.maxPerDaySym } })));

app.get('/api/ai/status', h((req, res) => { const recent = signals.filter(s => s.ai && !s.ai.error).sort((a, b) => (b.ai.at || 0) - (a.ai.at || 0)).slice(0, 12).map(s => ({ id: s.id, base: s.base, dir: s.dir, module: s.module, at: s.ai.at, verdict: s.ai.verdict, score: s.ai.score, trust: s.ai.trust, reason: s.ai.reason, summary: s.ai.summary, provider: s.ai.providerName || s.ai.provider })); res.json(Object.assign(aiStatus(), { recent })); }));
app.get('/api/ai/history', h((req, res) => res.json({ items: AI_HIST.slice(-100).reverse(), providers: AI_PROV.map(aiProviderView) })));
app.post('/api/ai/toggle', h((req, res) => { const b = req.body || {}; if (typeof b.enabled === 'boolean') settings.aiEnabled = b.enabled; if (typeof b.watchAuto === 'boolean') settings.aiWatchAuto = b.watchAuto; if (settings.aiEnabled === false) AI_QUEUE.length = 0; dirty = true; saveState(true); if (settings.aiEnabled && !aiKeys().length) { return res.json({ ok: true, enabled: false, settingsEnabled: true, keys: 0, note: 'AI açıldı ama anahtar yok.' }); } res.json({ ok: true, enabled: aiReady(), settingsEnabled: settings.aiEnabled, watchAuto: settings.aiWatchAuto, keys: aiKeys().length }); }));
app.post('/api/ai/reset', h((req, res) => { for (const p of AI_PROV) { p.cooldownUntil = 0; p.modelCooldowns = {}; p.lastError = null; p.nextAt = 0; p.badModels = {}; } AI_USAGE.dayCount = 0; AI_USAGE.hourCount = 0; AI_USAGE.briefCount = 0; AI_STATE.lastError = null; dirty = true; saveState(true); res.json({ ok: true, note: 'AI soğumaları sıfırlandı.' }); }));
app.get('/api/ai/test', h(async (req, res) => { const out = []; for (const p of AI_PROV) { const row = { id: p.id, name: p.name, hasKey: !!p.key, results: [] }; if (!p.key) { out.push(row); continue; } for (const model of p.models.slice(0, 1)) { try { const r = await callProviderModel(p, [{ role: 'system', content: 'Yalnızca JSON döndür.' }, { role: 'user', content: '{"ok":true}' }], model, { timeoutMs: 15000 }); row.results.push({ model, ok: true, ms: (p.lat || []).slice(-1)[0] || null, sample: String(r.text).slice(0, 80) }); } catch (e) { row.results.push({ model, ok: false, error: redact(e.message) }); } } out.push(row); } res.json({ ok: out.some(p => p.results.some(r => r.ok)), providers: out }); }));
app.get('/api/ai/discover', h(async (req, res) => { const result = await discoverAll(); saveState(true); res.json({ ok: result.some(r => r.ok), results: result, providers: AI_PROV.map(aiProviderView) }); }));

app.get('/api/diag', h((req, res) => res.json({ version: VERSION, uptimeSec: Math.round(process.uptime()), ready: READY, universe: UNIVERSE.length, cache: CACHE.size, ltCache: LT_CACHE.size, signals: signals.length, openSignals: signals.filter(isOpenSignal).length, paperOpen: paper.open.length, paperClosed: paper.closed.length, ai: { ready: aiReady(), queue: AI_QUEUE.length, busy: AI_STATE.busy, usage: AI_USAGE }, market, lastScan, live: settings.tradeMode === 'live', realBal })));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));

app.use((req, res) => res.status(404).json({ error: 'yol yok', path: req.path, version: VERSION }));

/* ══════════════════════════════════════════════════════════════════════════════
   DÖNGÜLER & BAŞLATMA
   ══════════════════════════════════════════════════════════════════════════════ */
function every(ms, fn, delay) { let stopped = false; const tickOnce = async () => { if (stopped) return; try { await fn(); } catch (e) { log('DÖNGÜ HATASI: ' + redact(e.message)); } if (!stopped) setTimeout(tickOnce, ms); }; setTimeout(tickOnce, Math.max(1000, delay || ms)); return () => { stopped = true; }; }
function dayRollover() { const dk = dayKey(); if (paper.dayKey !== dk) { paper.dayKey = dk; paper.dayStart = paper.equity; dirty = true; log('Gün değişti: paper gün başı ' + paper.dayStart + ' USDT'); } aiQuota(); }
let LOOP_STOPS = [];
function startLoops() {
  setInterval(() => { refreshTickers().catch(() => {}); }, 20e3);
  setInterval(() => { fetchRealBalance().catch(() => {}); }, 30e3);
  setInterval(ltTick, 10e3);
  setInterval(monitorPaper, 3e3);
  setInterval(monitorVirtual, 10e3);
  setInterval(reconcilePending, 15e3);
  setInterval(syncLive, 10e3);
  setInterval(() => { dayRollover(); saveState(false); }, 20e3);
  LOOP_STOPS.push(every(60e3, scalpScan, 15e3));
  LOOP_STOPS.push(every(60e3, autoScan, 25e3));
  LOOP_STOPS.push(every(10 * M1, ltScan, 30e3));
  LOOP_STOPS.push(every(5 * M1, updateMarket, 60e3));
  LOOP_STOPS.push(every(5 * M1, maybeWatchAI, 2 * M1));
}

async function init() {
  log('AlphaSon ' + VERSION + ' başlıyor — modüller: OtoTrade, LT Üçgen, Günlük Hızlı Scalp');
  log('Canlı işlem ' + (HAS_KEYS ? 'HAZIR' : 'API ANAHTARI YOK') + '. AI varsayılan ' + (settings.aiEnabled ? 'AÇIK' : 'KAPALI') + '.');
  loadState();
  try { await refreshUniverse(); } catch (e) { log('Evren hatası: ' + redact(e.message)); }
  try { await refreshTickers(); } catch (e) { }
  try { await fetchRealBalance(); } catch (e) { }
  try { await updateMarket(); } catch (e) { }
  READY = true; startLoops(); reconcilePending();
  setTimeout(() => { scalpScan().catch(() => {}); }, 3000);
  setTimeout(() => { autoScan().catch(() => {}); }, 5000);
  setTimeout(() => { ltScan().catch(() => {}); }, 8000);
  log('Hazır. http://localhost:' + PORT + ' | evren ' + UNIVERSE.length + ' coin');
}

const server = app.listen(PORT, () => { init().catch(e => log('BAŞLATMA HATASI: ' + e.message)); });
function shutdown(sig) { log(sig + ' alındı, kapatılıyor...'); try { saveState(true); } catch (e) { } for (const stop of LOOP_STOPS) { try { stop(); } catch (e) { } } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => log('YAKALANMAMIŞ PROMISE: ' + redact(e && e.message || e)));
// ===== PART 2 SONU =====
