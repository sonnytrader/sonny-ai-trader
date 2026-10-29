'use strict';
/* ══════════════════════════════════════════════════════════════════
   AlphaSon v91.1 — Gelişmiş Sürüm
   · OtoTrade   : 1m ivme yakalama (İlk fitil dönüşünde anında kâr alır)
   · PUMP       : 5m trend yönü + yapı kırılımı
   · MOM        : 15m sıkışma + seviye kırılımı
   · LT         : 1h/2h simetrik üçgen ÇİZGİ TEMASI sinyali (Filtreler esnetildi)
   ══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const ccxt = require('ccxt');

(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (e) {}
})();

const VERSION = 'v91.1';
const PORT = Number(process.env.PORT) || 3000;
const M1 = 60e3, M5 = 5 * M1, M15 = 15 * M1, H1 = 60 * M1, H2 = 2 * H1, D1 = 24 * H1;
const TF_MS = { '1m': M1, '5m': M5, '15m': M15, '1h': H1, '2h': H2 };
const TTL = { '1m': 8e3, '5m': 30e3, '15m': 60e3, '1h': 3 * M1, '2h': 8 * M1 };
const LT_BARS = 1000;
const EX = { FEE: 0.0006, SLIP: 0.0004, H: 0.20, COST: 0.24 };

const DATA_DIR = (() => {
  const want = process.env.DATA_DIR || path.join(__dirname, 'data');
  try { fs.mkdirSync(want, { recursive: true }); return want; }
  catch (e) { const alt = path.join(os.tmpdir(), 'alphason-v91'); try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) {} return alt; }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || process.env.BITGET_API_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || process.env.BITGET_PASSWORD || '';
const HAS_KEYS = !!(API_KEY && API_SECRET && API_PASS);
const API_TOKEN = String(process.env.ALPHASON_API_TOKEN || '').trim();

const AI_PROV = [
  { id: 'gemini', name: 'Gemini', native: true, base: 'https://generativelanguage.googleapis.com/v1beta', key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], prefer: 1, dayLimit: 800 },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', key: process.env.DEEPSEEK_API_KEY || '', models: ['deepseek-chat'], prefer: 2, dayLimit: 1500 },
  { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY || '', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'], prefer: 3, dayLimit: 800 },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', key: process.env.OPENAI_API_KEY || '', models: ['gpt-4o-mini', 'gpt-4.1-mini'], prefer: 4, dayLimit: 1000 }
];
for (const p of AI_PROV) Object.assign(p, { ok: 0, fail: 0, lastError: null, cooldownUntil: 0, modelCooldowns: {}, dayKey: '', dayCount: 0, lat: [] });

const AI_USAGE = { dayKey: '', dayCount: 0, hourKey: 0, hourCount: 0 };
const AI_QUEUE = [];
const AI_STATE = { busy: false, currentId: null, lastError: null };

const MODS = {
  AUTO: { key: 'AUTO', label: 'OtoTrade (Ivme)', tf: '1m', tradeable: true, maxPerDaySym: 10, cooldown: 10 * M1, maxAge: 45 * M1 },
  PUMP: { key: 'PUMP', label: 'Trend Kırılımı', tf: '5m', tradeable: false, maxPerDaySym: 8, cooldown: 45 * M1, maxAge: 4 * H1 },
  MOM:  { key: 'MOM', label: 'Kırılım Avcısı', tf: '15m', tradeable: false, maxPerDaySym: 6, cooldown: 1 * H1, maxAge: 4 * H1 },
  LT:   { key: 'LT', label: 'LT Üçgen', tf: '2h', tradeable: false, maxPerDaySym: 3, cooldown: 3 * H1, maxAge: 8 * H1 }
};
const ACTIVE_MODULES = ['AUTO', 'PUMP', 'MOM', 'LT'];

const SKIP_RESULTS = new Set(['DOLMADI', 'AI_RED', 'AI_ERROR', 'AI_TIMEOUT', 'AI_STALE', 'SKIP', 'MATH_ONLY']);
const TRADE_RESULTS = new Set(['TP1', 'TP2', 'SL', 'BE', 'TIME', 'MANUEL', 'MOMENTUM', 'REVERSAL', 'STALL', 'LOCK', 'AI_EXIT', 'EXCHANGE', 'FIRST_IMPULSE']);
const RES = {
  TP1: 'HEDEF 1', TP2: 'HEDEF 2', SL: 'STOP', BE: 'BAŞA BAŞ', TIME: 'SÜRE DOLDU', MANUEL: 'MANUEL',
  MOMENTUM: 'İVME BİTTİ', REVERSAL: 'TERS DÖNÜŞ', STALL: 'HAREKETSİZ', LOCK: 'KÂR KİLİDİ',
  DOLMADI: 'DOLMADI', AI_RED: 'AI GİRİLMEZ', AI_ERROR: 'AI YANITI YOK', AI_TIMEOUT: 'AI ZAMAN AŞIMI',
  AI_STALE: 'FİYAT KAÇTI', SKIP: 'ATLANDI', MATH_ONLY: 'MATEMATİK KARARI',
  AI_EXIT: 'AI ÇIKIŞ', EXCHANGE: 'BORSADA KAPANDI', FIRST_IMPULSE: 'İLK İVME ÇIKIŞI'
};

const TOKENIZED_STOCKS = new Set(['INTC','MSTR','KORU','SNXX','TSLA','NVDA','AAPL','COIN','HOOD','CRCL','AMZN','GOOGL','MSFT','META','SPY','QQQ','PLTR','AMD','NFLX','BABA','MARA','RIOT','CBRS','TQQQ','BE','CRWV','XAG','MU','NBIS','SAMSUNG','SKHY','SKHYNIX','EWY','DRAM','SOXS','SPCX','CL','BZ','XAU','XAUT','PAXG','MRVL','SNDK','AAOI','ZEC','HYPE','PUMP','MINIMAX','ZHIPU','OPENAI','ANTHROPIC','XPT','CSOPSK2LHKD','SKUU','MUU','APT','PENGU','ONDO','AVAX','UNI','LINK','XRP','ADA','ENA','BNB','SOL','BCH','DOGE','ONDO','APT']);

const DEF_SET = {
  autoTrade: false, tradeMode: 'paper', margin: 100, leverage: 3, riskPct: 0.5,
  autoMaxOpen: 2, dailyLossPct: 2, maxOpen: 3, aiEnabled: false, paperEquity: 1000,
  maxSpreadPct: 0.08, minQuoteVol: 2e6, topN: 100, ltTfs: ['2h'], includeStocks: false
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rp = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n >= 1000) return +n.toFixed(2); if (n >= 1) return +n.toFixed(4); if (n >= 0.01) return +n.toFixed(6); return +n.toFixed(8); };
const avg = a => { const x = (a || []).filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0; };
const sum = a => (a || []).reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const dayKey = ts => new Date(ts || Date.now()).toISOString().slice(0, 10);
const utcDayStart = ts => Math.floor((ts || Date.now()) / D1) * D1;
const sgn = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isStock = sym => TOKENIZED_STOCKS.has(baseOf(sym));

function sanitizeSettings(o) {
  const s = Object.assign({}, DEF_SET, o && typeof o === 'object' ? o : {});
  s.autoTrade = s.autoTrade === true;
  s.tradeMode = s.tradeMode === 'live' ? 'live' : 'paper';
  s.margin = clamp(num(s.margin, DEF_SET.margin), 10, 100000);
  s.leverage = clamp(Math.round(num(s.leverage, DEF_SET.leverage)), 1, 20);
  s.riskPct = clamp(num(s.riskPct, DEF_SET.riskPct), 0.05, 5);
  s.autoMaxOpen = clamp(Math.round(num(s.autoMaxOpen, DEF_SET.autoMaxOpen)), 1, 5);
  s.dailyLossPct = clamp(num(s.dailyLossPct, DEF_SET.dailyLossPct), 0.5, 50);
  s.maxOpen = clamp(Math.round(num(s.maxOpen, DEF_SET.maxOpen)), 1, 20);
  s.aiEnabled = s.aiEnabled === true;
  s.paperEquity = clamp(num(s.paperEquity, DEF_SET.paperEquity), 10, 1e9);
  s.maxSpreadPct = clamp(num(s.maxSpreadPct, DEF_SET.maxSpreadPct), 0.01, 1);
  s.minQuoteVol = clamp(num(s.minQuoteVol, DEF_SET.minQuoteVol), 1e5, 1e9);
  s.topN = clamp(Math.round(num(s.topN, DEF_SET.topN)), 10, 150);
  s.ltTfs = Array.isArray(s.ltTfs) ? s.ltTfs.filter(t => ['1h', '2h'].includes(t)) : ['2h'];
  if (!s.ltTfs.length) s.ltTfs = ['2h'];
  s.includeStocks = s.includeStocks === true;
  return s;
}

let settings = sanitizeSettings({});
let signals = [];
let paper = { open: [], closed: [], equity: DEF_SET.paperEquity, start: DEF_SET.paperEquity, dayStart: DEF_SET.paperEquity, dayKey: dayKey(), peak: DEF_SET.paperEquity };
let REJ = [];
let FIRED = new Map();
let REJ_STAT = {};
let seq = 0;
let dirty = false;
let lastScan = { auto: 0, pump: 0, mom: 0, lt: 0, tick: 0 };
let market = { dir: 'NOTR', breadth: 0.5, why: 'veri bekleniyor', btc: null, eth: null, at: 0 };
let WATCH = { lt: [], trend: [], brk: [] };
let LT_CACHE = new Map();
let TREND_WATCH = [];
let BRK_WATCH = [];
let LIVE = { open: [], closed: [], balance: null, positions: null, lastSync: 0, lastError: null, busy: false, needsSync: false, ipHint: null, dayKey: dayKey(), dayStart: 0 };

const LOGS = [];
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  console.log(line);
  LOGS.push({ t: Date.now(), msg: String(msg).slice(0, 400) });
  if (LOGS.length > 300) LOGS.splice(0, LOGS.length - 300);
}
function redact(s) {
  let x = String(s == null ? '' : s);
  for (const p of AI_PROV) if (p.key) x = x.split(p.key).join('[KEY]');
  for (const k of [API_KEY, API_SECRET, API_PASS]) if (k) x = x.split(k).join('[KEY]');
  return x.slice(0, 500);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.settings) settings = sanitizeSettings(j.settings);
    if (settings.tradeMode === 'live' && (!HAS_KEYS || !API_TOKEN)) { settings.tradeMode = 'paper'; log('Canlı mod için anahtar/token gerekli → paper'); }
    if (j && Array.isArray(j.signals)) {
      signals = j.signals.filter(s => s && ACTIVE_MODULES.includes(s.module)).slice(-400);
      for (const sig of signals) {
        if (!Number.isFinite(Number(sig.curSl)) || !(sig.curSl > 0)) sig.curSl = sig.sl;
        sig.info = Object.assign({}, sig.info || {});
        if (!sig.info.plan) sig.info.plan = { entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2 || null };
      }
    }
    if (j && j.paper) {
      paper = Object.assign(paper, j.paper);
      paper.open = Array.isArray(paper.open) ? paper.open.filter(p => p && p.module === 'AUTO').slice(0, 30) : [];
      paper.closed = Array.isArray(paper.closed) ? paper.closed.slice(-200) : [];
      paper.equity = num(paper.equity, DEF_SET.paperEquity);
      paper.peak = Math.max(num(paper.peak, paper.equity), paper.equity);
    }
    if (j && j.live && typeof j.live === 'object') {
      LIVE.open = Array.isArray(j.live.open) ? j.live.open.filter(p => p && p.isLive) : [];
      LIVE.closed = Array.isArray(j.live.closed) ? j.live.closed.slice(-100) : [];
      LIVE.balance = j.live.balance || null;
      LIVE.dayKey = j.live.dayKey || dayKey();
      LIVE.dayStart = num(j.live.dayStart, 0);
      LIVE.needsSync = true;
    }
    if (j && Array.isArray(j.rej)) REJ = j.rej.slice(-150);
    if (j && j.rejStat) REJ_STAT = j.rejStat;
    if (j && Number.isFinite(Number(j.seq))) seq = Number(j.seq);
    if (j && j.aiUsage) Object.assign(AI_USAGE, j.aiUsage);
    log('Durum yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık paper işlem');
  } catch (e) { log('Durum yüklenemedi: ' + e.message); }
}
function saveState(force) {
  if (!dirty && !force) return;
  try {
    const j = {
      version: VERSION, at: Date.now(), settings, signals: signals.slice(-400),
      paper, rej: REJ.slice(-150), rejStat: REJ_STAT, seq, aiUsage: AI_USAGE,
      live: { open: LIVE.open.slice(-20), closed: LIVE.closed.slice(-100), balance: LIVE.balance, dayKey: LIVE.dayKey, dayStart: LIVE.dayStart }
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (e) { log('Durum kaydedilemedi: ' + e.message); }
}

/* ── Göstergeler ─────────────────────────────────────────────── */
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
  const bucketMs = srcTfMs * factor;
  let cur = null, bucket = null;
  for (const c of cs) {
    const b = Math.floor(c.t / bucketMs);
    if (bucket !== b) {
      if (cur) out.push(cur);
      bucket = b; cur = { t: b * bucketMs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  if (cur) out.push(cur);
  return out;
}
function fmtCandles(cs, n) {
  return (cs || []).slice(-n).map(c => {
    const p = c.c >= 1 ? 4 : 6;
    return new Date(c.t).toISOString().slice(5, 16).replace('T', ' ') + ' O' + c.o.toFixed(p) + ' H' + c.h.toFixed(p) + ' L' + c.l.toFixed(p) + ' C' + c.c.toFixed(p) + ' V' + Math.round(c.v);
  }).join('\n');
}

/* ── Borsa + veri katmanı ────────────────────────────────────── */
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
const FALLBACK = ['BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','XRP/USDT:USDT','DOGE/USDT:USDT','BNB/USDT:USDT','ADA/USDT:USDT','AVAX/USDT:USDT','LINK/USDT:USDT','SUI/USDT:USDT','TON/USDT:USDT','DOT/USDT:USDT','LTC/USDT:USDT','BCH/USDT:USDT','NEAR/USDT:USDT','APT/USDT:USDT','ARB/USDT:USDT','OP/USDT:USDT','INJ/USDT:USDT','ENA/USDT:USDT'];
const EXCLUDE = new Set(['USDC','USDT','DAI','FDUSD','TUSD','USDD','PYUSD','EUR','GBP','BUSD']);

async function pool(items, n, fn) {
  const list = items.slice(); let idx = 0;
  await Promise.all(new Array(Math.min(n, list.length)).fill(0).map(async () => {
    while (idx < list.length) { const i = idx++; try { await fn(list[i], i); } catch (e) {} }
  }));
}
function scanSyms(kind, n) {
  const l = UNIVERSE.filter(s => kind === 'LT' || settings.includeStocks || !isStock(s));
  return l.slice(0, n);
}
function hotSyms(n) {
  const base = UNIVERSE.filter(s => settings.includeStocks || !isStock(s));
  const now = Date.now(), mv = [];
  for (const s of base) {
    const h = TICKHIST.get(s);
    if (!h || h.length < 3) continue;
    const last = h[h.length - 1].p;
    let old = h[0].p;
    for (let i = h.length - 1; i >= 0; i--) { if (now - h[i].t >= 120e3) { old = h[i].p; break; } }
    mv.push({ s, m: Math.abs(last / old - 1) });
  }
  mv.sort((a, b) => b.m - a.m);
  const out = base.slice(0, 8);
  for (const x of mv) { if (out.length >= n) break; if (x.m < 0.002) break; if (!out.includes(x.s)) out.push(x.s); }
  return out;
}
function tick(sym) { return TICK.get(sym) || null; }
function priceOf(sym, maxAgeMs) {
  const t = tick(sym), maxAge = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 20e3;
  return t && t.last > 0 && t.ts > 0 && Date.now() - t.ts <= maxAge ? t.last : 0;
}
function spreadPct(sym) {
  const t = tick(sym);
  if (!t || !(t.bid > 0) || !(t.ask > 0) || !(t.ts > 0) || Date.now() - t.ts > 20e3) return 99;
  return (t.ask - t.bid) / t.bid * 100;
}
async function freshMarketPrice(sym, maxAgeMs) {
  const maxAge = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 5000;
  const c = priceOf(sym, maxAge);
  if (c > 0) { const t = tick(sym); return { price: c, priceAt: t.ts, source: 'cache' }; }
  try {
    const t = await ex.fetchTicker(sym);
    const price = num(t && (t.last || t.close));
    if (!(price > 0)) return { price: 0, priceAt: 0, error: 'borsa fiyatı boş' };
    const now = Date.now();
    TICK.set(sym, { last: price, bid: num(t.bid), ask: num(t.ask), qv: num(t.quoteVolume), chg: num(t.percentage), ts: now });
    return { price, priceAt: now, source: 'exchange' };
  } catch (e) { return { price: 0, priceAt: 0, error: 'taze fiyat yok: ' + redact(e.message) }; }
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
      hh.push({ t: Date.now(), p: last });
      if (hh.length > 60) hh.splice(0, hh.length - 60);
    }
  } catch (e) {}
}
async function fetchOHLCV(sym, tf, limit) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const ent = CACHE.get(key);
  if (ent && now - ent.t < (TTL[tf] || 60e3) && ent.lim >= limit) return ent.data.slice(-limit);
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
    if (CACHE.size > 300) { const cutoff = now - 30 * M1; for (const [k, v] of CACHE) if (v.t < cutoff) CACHE.delete(k); }
    return data;
  })();
  INFLIGHT.set(key, { promise: p, limit });
  try { const data = await p; return data ? data.slice(-limit) : null; }
  finally { const cur = INFLIGHT.get(key); if (cur && cur.promise === p) INFLIGHT.delete(key); }
}
async function getCandles(sym, tf, limit, closedOnly = true) {
  const data = await fetchOHLCV(sym, tf, limit);
  if (!data) return null;
  return closedOnly ? closed(data, TF_MS[tf] || M5) : data;
}
async function getLtCandles(sym, tf, bars) {
  if (tf !== '2h') return getCandles(sym, tf, bars, true);
  const need = bars * 2 + 6;
  const now = Date.now();
  const hourStart = Math.floor(now / H1) * H1;
  let ent = LONG1H.get(sym);
  const fresh = ent && now - ent.at < 20 * M1 && ent.at >= hourStart + 15e3;
  if (!fresh) {
    const map = new Map();
    if (ent) for (const c of ent.data) map.set(c.t, c);
    let since = ent && ent.data.length ? ent.data[ent.data.length - 1].t - 2 * H1 : now - need * H1;
    let got = false;
    for (let g = 0; g < 12; g++) {
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
  return closed(aggTF(ent.data, 2, H1), H2).slice(-bars);
}

async function updateMarket() {
  try {
    const btc = await getCandles('BTC/USDT:USDT', '15m', 120, true);
    const eth = await getCandles('ETH/USDT:USDT', '15m', 120, true);
    const one = (cs, sym) => {
      if (!cs || cs.length < 60) return null;
      const cl = closesOf(cs);
      const e20a = emaArr(cl, 20), e50a = emaArr(cl, 50);
      const i = cl.length - 1;
      return { price: rp(cl[i]), e20: e20a[i], e50: e50a[i], slopeUp: e20a[i] > e20a[i - 6], chg: num(tick(sym) && tick(sym).chg), up: e20a[i] > e50a[i] };
    };
    const b = one(btc, 'BTC/USDT:USDT'), e = one(eth, 'ETH/USDT:USDT');
    let green = 0, total = 0;
    for (const sym of UNIVERSE) { const t = tick(sym); if (!t) continue; total++; if (t.chg > 0) green++; }
    const breadth = total ? green / total : 0.5;
    let sc = 0;
    const parts = [];
    if (b) { sc += (b.up ? 1 : -1) + (b.slopeUp ? 1 : -1); parts.push('BTC ' + (b.up ? 'EMA20>50' : 'EMA20<50') + (b.slopeUp ? ' eğim↑' : ' eğim↓')); }
    if (e) { sc += (e.up ? 1 : -1); parts.push('ETH ' + (e.up ? 'yukarı' : 'aşağı')); }
    if (breadth >= 0.55) sc += 1; else if (breadth <= 0.45) sc -= 1;
    parts.push('genişlik %' + Math.round(breadth * 100) + ' yeşil');
    market = { dir: sc >= 2 ? 'LONG' : sc <= -2 ? 'SHORT' : 'NOTR', breadth: +breadth.toFixed(3), why: parts.join(' · '), btc: b, eth: e, at: Date.now() };
  } catch (e) { log('Piyasa hatası: ' + redact(e.message)); }
}
/* ── Risk / plan matematiği ──────────────────────────────────── */
function rrNet(entry, sl, tp) {
  entry = Number(entry); sl = Number(sl); tp = Number(tp);
  const risk = entry > 0 ? Math.abs(entry - sl) / entry * 100 : 0;
  const gain = entry > 0 ? Math.abs(tp - entry) / entry * 100 : 0;
  const rr = risk > 0 ? gain / risk : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +(rr - EX.COST / Math.max(risk, 1e-9)).toFixed(2) };
}
function outcomeR(sig, exitPx) {
  const d = sig.dir === 'LONG' ? 1 : -1, risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0) || !(sig.entry > 0) || !Number.isFinite(Number(exitPx))) return { grossR: null, netR: null };
  const f = Number.isFinite(Number(sig.tp1Fraction)) ? sig.tp1Fraction : 0.5;
  const grossR = sig.tp1Hit
    ? f * Math.abs(sig.tp1 - sig.entry) / risk + (1 - f) * ((exitPx - sig.entry) * d / risk)
    : (exitPx - sig.entry) * d / risk;
  const costR = EX.COST / (risk / sig.entry * 100);
  return { grossR: +grossR.toFixed(3), netR: +(grossR - costR).toFixed(3) };
}
function moreProtective(cur, cand, d) {
  if (!(cand > 0)) return cur;
  if (!(cur > 0)) return cand;
  return d === 1 ? Math.max(cur, cand) : Math.min(cur, cand);
}
function planFromStop(entry, sl, dir, tp1R, tp2R) {
  const d = dir === 'LONG' ? 1 : -1;
  const q0 = rrNet(entry, sl, entry);
  const riskPct = q0.risk;
  if (!(riskPct >= 0.4 && riskPct <= 3.5)) return null;
  const riskPx = entry * riskPct / 100;
  const tp1 = rp(entry + d * tp1R * riskPx);
  const tp2 = rp(entry + d * tp2R * riskPx);
  const q1 = rrNet(entry, sl, tp1), q2 = rrNet(entry, sl, tp2);
  if (q1.net < 0.5 || q2.net < 1.0) return null;
  return { sl: rp(sl), tp1, tp2, riskPct: +riskPct.toFixed(2), netRR: q1.net, netRR2: q2.net };
}

/* ── Eleme kaydı ─────────────────────────────────────────────── */
function logRej(module, sym, reason, price) {
  const now = Date.now();
  const last = REJ.find(r => r.symbol === sym && r.reason === reason && now - r.t < 10 * M1);
  if (last) { last.n = (last.n || 1) + 1; last.t = now; REJ.splice(REJ.indexOf(last), 1); REJ.push(last); }
  else { REJ.push({ t: now, module, symbol: sym, base: baseOf(sym), reason, price: rp(price || priceOf(sym)), n: 1 }); if (REJ.length > 150) REJ.shift(); }
  REJ_STAT[module + '|' + reason] = (REJ_STAT[module + '|' + reason] || 0) + 1;
  dirty = true;
}
function reasonSummary(counts) {
  const rows = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return rows.length ? rows.map(x => x[0] + ' (' + x[1] + ')').join(' · ') : '—';
}

/* ═══ MODÜL 1: OTOTRADE — 1m ivme (giriş ivme BAŞINDA, çıkış ivme bitince) ═══ */
const AUTO_CFG = { chg1: 0.35, chg3: 0.60, vol: 1.5, body: 0.45, maxProgressAtr: 2.0, minProgressAtr: 0.25, maxHoldMs: 10 * M1, trailDropR: 0.5, stallSec: 180, tp1R: 1.2, tp2R: 2.2 };

function autoContext(sym, cs) {
  if (!cs || cs.length < 40) return null;
  const n = cs.length, last = cs[n - 1], prev = cs[n - 2];
  const cc = closed(cs, M1);
  if (cc.length < 30) return null;
  const atr = atrLast(cc, 14);
  if (!atr || atr <= 0) return null;
  const now = Date.now();
  const t = tick(sym);
  const px = (t && t.last > 0 && now - t.ts < 10e3) ? t.last : last.c;
  if (!(px > 0)) return null;
  const ageMs = now - last.t;
  const forming = ageMs >= 0 && ageMs < 55e3;
  if (forming && ageMs < 10e3) return null; // mumun ilk 10 sn bekle
  const candleAgeSec = forming ? Math.max(10, Math.round(ageMs / 1000)) : 60;
  const cl = closesOf(cc);
  const volSma = avg(cc.slice(-21, -1).map(c => c.v));
  const expVol = volSma * (forming ? candleAgeSec / 60 : 1);
  const volRatio = expVol > 0 ? last.v / expVol : 0;
  const recent = cl.slice(-10);
  const moveStartL = Math.min.apply(null, recent);
  const moveStartS = Math.max.apply(null, recent);
  return {
    sym, cs, n, last, px, now, atr, atrPct: atr / px * 100, forming, candleAgeSec,
    chg1: (last.c / prev.c - 1) * 100, chg3: (last.c / cc[cc.length - 4].c - 1) * 100,
    volRatio, body: bodyRatio(last), bodyAtr: bodyAtr(last, atr),
    progL: (px - moveStartL) / atr, progS: (moveStartS - px) / atr,
    swingL: Math.min.apply(null, cc.slice(-6).map(c => c.l)),
    swingS: Math.max.apply(null, cc.slice(-6).map(c => c.h))
  };
}
function autoCandidate(ctx) {
  const pump = ctx.chg1 >= AUTO_CFG.chg1 || ctx.chg3 >= AUTO_CFG.chg3;
  const dump = ctx.chg1 <= -AUTO_CFG.chg1 || ctx.chg3 <= -AUTO_CFG.chg3;
  if (!pump && !dump) return null;
  if (ctx.volRatio < AUTO_CFG.vol) return null;
  if (ctx.body < AUTO_CFG.body || ctx.bodyAtr < 0.5) return null;
  const dir = pump && (!dump || ctx.chg1 >= -ctx.chg1) ? 'LONG' : 'SHORT';
  const d = dir === 'LONG' ? 1 : -1;
  const prog = dir === 'LONG' ? ctx.progL : ctx.progS;
  // KRİTİK: ivmenin BAŞINDA mıyız? İlerleme 2 ATR'ı geçtiyse kaçmış demektir.
  if (prog > AUTO_CFG.maxProgressAtr || prog < AUTO_CFG.minProgressAtr) return null;
  const px = rp(ctx.px);
  let sl = dir === 'LONG' ? Math.min(ctx.swingL - 0.2 * ctx.atr, px - px * 0.005) : Math.max(ctx.swingS + 0.2 * ctx.atr, px + px * 0.005);
  const plan = planFromStop(px, sl, dir, AUTO_CFG.tp1R, AUTO_CFG.tp2R);
  if (!plan) return null;
  return {
    module: 'AUTO', symbol: ctx.sym, base: baseOf(ctx.sym), dir,
    entry: px, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2, tp1Fraction: 0.5,
    conf: clamp(Math.round(55 + Math.min(ctx.volRatio - 1.5, 2) * 10 + Math.min(Math.abs(ctx.chg3), 2) * 6 + (AUTO_CFG.maxProgressAtr - prog) * 4), 50, 95),
    maxAgeMs: 6 * M1,
    info: {
      tf: '1m', source: 'math', setup: dir === 'LONG' ? 'PUMP' : 'DUMP',
      plan: { entry: px, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2 },
      netRR: plan.netRR, netRR2: plan.netRR2, riskPct: plan.riskPct,
      atrPct: +ctx.atrPct.toFixed(2), volRatio: +ctx.volRatio.toFixed(2), chg1: +ctx.chg1.toFixed(2), chg3: +ctx.chg3.toFixed(2),
      body: +ctx.body.toFixed(2), progAtr: +prog.toFixed(2), forming: ctx.forming, candleAgeSec: ctx.candleAgeSec,
      reasons: [(dir === 'LONG' ? 'Pump' : 'Dump') + ' ivmesi 1m %' + ctx.chg1.toFixed(2) + ' / 3m %' + ctx.chg3.toFixed(2), 'Hacim ' + ctx.volRatio.toFixed(1) + 'x', 'İlerleme ' + prog.toFixed(2) + ' ATR (başlangıçta)']
    },
    setupKey: 'AUTO|' + ctx.sym + '|' + dir + '|' + Math.floor(ctx.last.t / M1)
  };
}
let autoScanning = false;
async function autoScan(fast) {
  if (autoScanning) return;
  autoScanning = true;
  const elim = {};
  try {
    const list = fast ? hotSyms(20) : scanSyms('AUTO', 70);
    let raws = [];
    await pool(list, 5, async (sym) => {
      const cs = await getCandles(sym, '1m', 60, false);
      if (!cs || cs.length < 40) { elim['1m veri yok'] = (elim['1m veri yok'] || 0) + 1; return; }
      if (spreadPct(sym) > settings.maxSpreadPct) { elim['spread yüksek'] = (elim['spread yüksek'] || 0) + 1; return; }
      const ctx = autoContext(sym, cs);
      if (!ctx) { elim['bağlam yok/erken mum'] = (elim['bağlam yok/erken mum'] || 0) + 1; return; }
      if (ctx.atrPct < 0.05 || ctx.atrPct > 3.5) { elim['ATR sınır dışı'] = (elim['ATR sınır dışı'] || 0) + 1; return; }
      const c = autoCandidate(ctx);
      if (!c) {
        const why = ctx.volRatio < AUTO_CFG.vol ? 'hacim zayıf (' + ctx.volRatio.toFixed(1) + 'x<' + AUTO_CFG.vol + 'x)'
          : ctx.body < AUTO_CFG.body ? 'gövde zayıf'
          : Math.max(ctx.progL, ctx.progS) > AUTO_CFG.maxProgressAtr ? 'ivme kaçtı (' + Math.max(ctx.progL, ctx.progS).toFixed(1) + ' ATR)'
          : 'ivme eşiği yok';
        elim[why] = (elim[why] || 0) + 1;
        logRej('AUTO', sym, why, ctx.px);
        return;
      }
      raws.push(c);
    });
    raws.sort((a, b) => b.conf - a.conf);
    let emitted = 0;
    for (const raw of raws) {
      if (emitted >= 2) break;
      const prev = FIRED.get(raw.setupKey);
      if (prev && Date.now() - prev < 6 * M1) continue;
      const sig = addSignal(raw);
      if (sig) { FIRED.set(raw.setupKey, Date.now()); emitted++; }
    }
    lastScan.auto = Date.now();
    if (!fast) log('OTOTRADE: ' + list.length + ' coin | ' + raws.length + ' aday | ' + emitted + ' sinyal | piyasa ' + market.dir + ' | eleme: ' + reasonSummary(elim));
  } catch (e) { log('OtoTrade tarama hatası: ' + redact(e.message)); }
  finally { autoScanning = false; }
}

/* ═══ MODÜL 2: TREND KIRILIMI — 5m EMA yön + 10 mumluk yapı kırılımı ═══ */
const PUMP_CFG = { emaF: 20, emaS: 50, look: 10, vol: 1.4, body: 0.4, rsiMax: 75, rsiMin: 25, tp1R: 1.3, tp2R: 2.4 };

async function pumpAnalyze(sym) {
  const cs = await getCandles(sym, '5m', 200, true);
  if (!cs || cs.length < 60) return { elim: '5m veri yok' };
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return { elim: 'ATR yok' };
  const atrPct = atr / last.c * 100;
  if (atrPct < 0.15 || atrPct > 4) return { elim: 'ATR sınır dışı (%' + atrPct.toFixed(2) + ')' };
  if (spreadPct(sym) > settings.maxSpreadPct) return { elim: 'spread yüksek' };
  const cl = closesOf(cs);
  const eF = emaArr(cl, PUMP_CFG.emaF), eS = emaArr(cl, PUMP_CFG.emaS);
  const px = priceOf(sym) || last.c;
  const up = eF[n - 1] > eS[n - 1] && last.c > eF[n - 1];
  const dn = eF[n - 1] < eS[n - 1] && last.c < eF[n - 1];
  const volSma = avg(cs.slice(-21, -1).map(c => c.v));
  const volRatio = volSma > 0 ? last.v / volSma : 0;
  const rsi = rsiLast(cl, 14);
  const prior = cs.slice(-(PUMP_CFG.look + 1), -1);
  const levelUp = Math.max.apply(null, prior.map(c => c.h));
  const levelDn = Math.min.apply(null, prior.map(c => c.l));

  for (const dir of ['LONG', 'SHORT']) {
    const d = dir === 'LONG' ? 1 : -1;
    if (dir === 'LONG' && !up) continue;
    if (dir === 'SHORT' && !dn) continue;
    const level = dir === 'LONG' ? levelUp : levelDn;
    const broken = d * (last.c - level) > 0;
    if (broken) {
      if (d * (last.c - last.o) <= 0) return { elim: 'kırılım mumu yönünde değil' };
      if (bodyRatio(last) < PUMP_CFG.body) return { elim: 'gövde zayıf' };
      if (volRatio < PUMP_CFG.vol) return { elim: 'hacim zayıf (' + volRatio.toFixed(2) + 'x)' };
      if (rsi != null && (dir === 'LONG' ? rsi > PUMP_CFG.rsiMax : rsi < PUMP_CFG.rsiMin)) return { elim: 'RSI aşırı (' + Math.round(rsi) + ')' };
      let sl = dir === 'LONG'
        ? Math.min.apply(null, cs.slice(-6).map(c => c.l)) - 0.25 * atr
        : Math.max.apply(null, cs.slice(-6).map(c => c.h)) + 0.25 * atr;
      const entry = rp(px);
      const plan = planFromStop(entry, sl, dir, PUMP_CFG.tp1R, PUMP_CFG.tp2R);
      if (!plan) return { elim: 'stop/risk uygun değil' };
      return {
        raw: {
          module: 'PUMP', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
          conf: clamp(Math.round(55 + Math.min(volRatio - 1, 1.5) * 12 + (rsi != null ? 10 - Math.abs(rsi - 55) / 5 : 0)), 50, 95),
          maxAgeMs: 2 * H1,
          info: {
            tf: '5m', source: 'math', setup: 'TREND_BREAK',
            plan: { entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2 },
            netRR: plan.netRR, netRR2: plan.netRR2, riskPct: plan.riskPct,
            atrPct: +atrPct.toFixed(2), volRatio: +volRatio.toFixed(2), rsi: rsi != null ? Math.round(rsi) : null,
            trigger: rp(level), distPct: +((level - px) * d / px * 100).toFixed(2),
            ema20: rp(eF[n - 1]), ema50: rp(eS[n - 1]), trend: dir === 'LONG' ? 'YUKARI' : 'ASAGI'
          },
          setupKey: 'PUMP|' + sym + '|' + dir + '|' + last.t
        }
      };
    }
  }
  if (up || dn) {
    const dir = up ? 'LONG' : 'SHORT';
    const level = up ? levelUp : levelDn;
    const distPct = (level - px) * (up ? 1 : -1) / px * 100;
    if (distPct > -1.5 && distPct < 3) {
      return { row: { symbol: sym, base: baseOf(sym), tf: '5m', price: rp(px), dir, trigger: rp(level), distPct: +distPct.toFixed(2), volRatio: +volRatio.toFixed(2), atrPct: +atrPct.toFixed(2), rsi: rsi != null ? Math.round(rsi) : null, trend: up ? 'YUKARI' : 'ASAGI', status: 'TETİK YAKIN' } };
    }
    return { elim: 'yapı kırılmadı (' + rp(level) + ')' };
  }
  return { elim: '5m trend yönü net değil' };
}
let pumpScanning = false;
async function pumpScan() {
  if (pumpScanning) return;
  pumpScanning = true;
  const elim = {};
  try {
    const list = scanSyms('PUMP', 60);
    const rows = [];
    await pool(list, 4, async (sym) => {
      const r = await pumpAnalyze(sym);
      if (r.raw) {
        const prev = FIRED.get(r.raw.setupKey);
        if (!(prev && Date.now() - prev < PUMP_CFG.look * 5 * M1)) {
          const sig = addSignal(r.raw);
          if (sig) { FIRED.set(r.raw.setupKey, Date.now()); log('TREND KIRILIMI: ' + sig.base + ' ' + sig.dir + ' | 5m yapı ' + r.raw.info.trigger + ' kırıldı | güven ' + sig.conf + ' | net ' + r.raw.info.netRR); }
        }
      } else if (r.row) rows.push(r.row);
      else { elim[r.elim] = (elim[r.elim] || 0) + 1; logRej('PUMP', sym, r.elim, priceOf(sym)); }
    });
    rows.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
    TREND_WATCH = rows.slice(0, 25);
    WATCH.trend = TREND_WATCH;
    lastScan.pump = Date.now();
    log('TREND TARAMA: ' + list.length + ' coin | izleme ' + rows.length + ' | piyasa ' + market.dir + ' | eleme: ' + reasonSummary(elim));
  } catch (e) { log('Trend tarama hatası: ' + redact(e.message)); }
  finally { pumpScanning = false; }
}

/* ═══ MODÜL 3: KIRILIM AVCISI — 15m sıkışma + 24 mumluk seviye kırılımı ═══ */
const MOM_CFG = { look: 24, squeezeAtr: 7, vol: 1.5, body: 0.4, nearAtr: 1.0, tp1R: 1.2, tp2R: 2.2 };

async function momAnalyze(sym) {
  const cs = await getCandles(sym, '15m', 120, true);
  if (!cs || cs.length < 50) return { elim: '15m veri yok' };
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return { elim: 'ATR yok' };
  const atrPct = atr / last.c * 100;
  if (atrPct < 0.15 || atrPct > 5) return { elim: 'ATR sınır dışı' };
  if (spreadPct(sym) > settings.maxSpreadPct) return { elim: 'spread yüksek' };
  const px = priceOf(sym) || last.c;
  const win20 = cs.slice(-21, -1);
  const rangeNr = (Math.max.apply(null, win20.map(c => c.h)) - Math.min.apply(null, win20.map(c => c.l))) / atr;
  const volSma = avg(cs.slice(-21, -1).map(c => c.v));
  const volRatio = volSma > 0 ? last.v / volSma : 0;
  const prior = cs.slice(-(MOM_CFG.look + 1), -1);
  const levelUp = Math.max.apply(null, prior.map(c => c.h));
  const levelDn = Math.min.apply(null, prior.map(c => c.l));
  const squeezed = rangeNr <= MOM_CFG.squeezeAtr;

  for (const dir of ['LONG', 'SHORT']) {
    const d = dir === 'LONG' ? 1 : -1;
    const level = dir === 'LONG' ? levelUp : levelDn;
    const broken = d * (last.c - level) > 0.02 * atr;
    if (broken) {
      if (!squeezed) return { elim: 'kırılım var ama sıkışma yok (range ' + rangeNr.toFixed(1) + ' ATR)' };
      if (d * (last.c - last.o) <= 0) return { elim: 'kırılım mumu yönünde değil' };
      if (bodyRatio(last) < MOM_CFG.body) return { elim: 'gövde zayıf' };
      if (volRatio < MOM_CFG.vol) return { elim: 'hacim zayıf (' + volRatio.toFixed(2) + 'x<' + MOM_CFG.vol + 'x)' };
      let sl = level - d * 0.3 * atr;
      const entry = rp(px);
      const plan = planFromStop(entry, sl, dir, MOM_CFG.tp1R, MOM_CFG.tp2R);
      if (!plan) return { elim: 'stop/risk uygun değil' };
      return {
        raw: {
          module: 'MOM', symbol: sym, base: baseOf(sym), dir, entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
          conf: clamp(Math.round(55 + (MOM_CFG.squeezeAtr - rangeNr) * 3 + Math.min(volRatio - 1, 1.5) * 10), 50, 95),
          maxAgeMs: 3 * H1,
          info: {
            tf: '15m', source: 'math', setup: 'SQZ_BREAK',
            plan: { entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2 },
            netRR: plan.netRR, netRR2: plan.netRR2, riskPct: plan.riskPct,
            atrPct: +atrPct.toFixed(2), volRatio: +volRatio.toFixed(2), rangeAtr: +rangeNr.toFixed(2),
            level: rp(level), distPct: +((level - px) * d / px * 100).toFixed(2)
          },
          setupKey: 'MOM|' + sym + '|' + dir + '|' + last.t
        }
      };
    }
  }
  if (squeezed) {
    const distUp = (levelUp - px) / atr, distDn = (px - levelDn) / atr;
    const near = Math.min(distUp, distDn);
    if (near <= MOM_CFG.nearAtr) {
      const dir = distUp <= distDn ? 'LONG' : 'SHORT';
      return { row: { symbol: sym, base: baseOf(sym), tf: '15m', price: rp(px), dir, level: rp(dir === 'LONG' ? levelUp : levelDn), distAtr: +near.toFixed(2), rangeAtr: +rangeNr.toFixed(2), volRatio: +volRatio.toFixed(2), status: 'KIRILIMA YAKIN' } };
    }
  }
  return { elim: 'seviyeye uzak (>1 ATR) veya sıkışma yok' };
}
let momScanning = false;
async function momScan() {
  if (momScanning) return;
  momScanning = true;
  const elim = {};
  try {
    const list = scanSyms('MOM', 60);
    const rows = [];
    await pool(list, 4, async (sym) => {
      const r = await momAnalyze(sym);
      if (r.raw) {
        const prev = FIRED.get(r.raw.setupKey);
        if (!(prev && Date.now() - prev < MOM_CFG.look * M15)) {
          const sig = addSignal(r.raw);
          if (sig) { FIRED.set(r.raw.setupKey, Date.now()); log('KIRILIM: ' + sig.base + ' ' + sig.dir + ' | 15m seviye ' + r.raw.info.level + ' | sıkışma ' + r.raw.info.rangeAtr + ' ATR | güven ' + sig.conf); }
        }
      } else if (r.row) rows.push(r.row);
      else { elim[r.elim] = (elim[r.elim] || 0) + 1; logRej('MOM', sym, r.elim, priceOf(sym)); }
    });
    rows.sort((a, b) => a.distAtr - b.distAtr);
    BRK_WATCH = rows.slice(0, 25);
    WATCH.brk = BRK_WATCH;
    lastScan.mom = Date.now();
    log('KIRILIM TARAMA: ' + list.length + ' coin | izleme ' + rows.length + ' | piyasa ' + market.dir + ' | eleme: ' + reasonSummary(elim));
  } catch (e) { log('Kırılım tarama hatası: ' + redact(e.message)); }
  finally { momScanning = false; }
}

/* ═══ MODÜL 4: LT ÜÇGEN — simetrik üçgen, ÇİZGİ TEMASI sinyali ═══
   En yüksek fitil (long tepesi) ile en düşük fitil (short dibi)
   hizalanır; fiyat çizgiye değdiğinde sinyal düşer. Karar kullanıcıda. */
function triUpperAt(tri, i) { return tri.hi.intercept + tri.hi.slope * (i - tri.refIdx); }
function triLowerAt(tri, i) { return tri.lo.intercept + tri.lo.slope * (i - tri.refIdx); }

function manualTriangle(cs, tf) {
  const n = cs.length;
  if (n < 120) return null;
  const refIdx = n - 1;
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const px = cs[refIdx].c;
  const win = Math.min(n - 3, 300); // Son 300 mumu tara
  const from = n - 3 - win;
  let hiBar = null, loBar = null;
  for (let i = from; i < n - 3; i++) {
    const c = cs[i];
    if (!hiBar || c.h > hiBar.p) hiBar = { i, t: c.t, p: c.h };
    if (!loBar || c.l < loBar.p) loBar = { i, t: c.t, p: c.l };
  }
  if (!hiBar || !loBar) return null;
  if (Math.abs(hiBar.i - loBar.i) < 5) return null; // Çok yakın olmasın (5 bar)
  
  const lastH = Math.max.apply(null, cs.slice(-4, -1).map(c => c.h));
  const lastL = Math.min.apply(null, cs.slice(-4, -1).map(c => c.l));
  const hiSlope = (lastH - hiBar.p) / (refIdx - hiBar.i);
  const loSlope = (lastL - loBar.p) / (refIdx - loBar.i);
  
  if (!(hiSlope < loSlope)) return null; // Sağda birleşmeli
  
  const apexX = (lastL - lastH) / (hiSlope - loSlope);
  if (!(apexX > 0) || apexX > 500) return null; // Apeks uzaklığı 500 barı geçmesin
  
  const firstIdx = Math.min(hiBar.i, loBar.i);
  const apexIdx = refIdx + apexX;
  const maturity = clamp((refIdx - firstIdx) / Math.max(1, apexIdx - firstIdx), 0, 1);
  if (maturity < 0.3) return null; // Olgunluk 0.5'ten 0.3'e düşürüldü
  
  const widthNow = lastH - lastL;
  if (!(widthNow > 0.05 * atr) || widthNow > 12 * atr) return null; // Genişlik esnetildi
  
  const hi = { slope: hiSlope, intercept: lastH };
  const lo = { slope: loSlope, intercept: lastL };
  const hiAt = i => hi.intercept + hi.slope * (i - refIdx);
  const loAt = i => lo.intercept + lo.slope * (i - refIdx);
  
  // Çizgi taşma kontrolü (gevşetildi)
  for (let k = firstIdx; k <= refIdx; k++) {
    if (cs[k].h > hiAt(k) + 1.0 * atr || cs[k].c > hiAt(k) + 0.8 * atr) return null;
    if (cs[k].l < loAt(k) - 1.5 * atr || cs[k].c < loAt(k) - 1.0 * atr) return null;
  }
  
  const widthStart = hiAt(firstIdx) - loAt(firstIdx);
  const compression = widthStart > 0 ? clamp(1 - widthNow / widthStart, 0, 1) : 0;
  if (compression < 0.2) return null; // Sıkışma 0.4'ten 0.2'ye düşürüldü
  
  const shape = Math.abs(hiSlope * 60) < 0.25 * atr ? 'ALÇALAN' : Math.abs(loSlope * 60) < 0.25 * atr ? 'YÜKSELEN' : 'SİMETRİK';
  const score = clamp(Math.round(50 + maturity * 20 + compression * 20), 0, 100);
  
  return {
    ok: true, tf, n, refIdx, atr, px, hi, lo,
    upperNow: lastH, lowerNow: lastL, widthPct: +(widthNow / px * 100).toFixed(2),
    maturity: +maturity.toFixed(2), compression: +compression.toFixed(2),
    apexX, apexAt: cs[refIdx].t + Math.round(apexX) * (TF_MS[tf] || H2),
    firstIdx, firstT: cs[firstIdx].t, hiStart: hiBar.i, loStart: loBar.i,
    shape, score, spanBars: refIdx - firstIdx
  };
}
let ltScanning = false;
async function ltScan() {
  if (ltScanning) return;
  ltScanning = true;
  try {
    const now = Date.now();
    for (const [key, e] of LT_CACHE) if (!e || now - (e.at || 0) > 8 * H1) LT_CACHE.delete(key);
    const list = scanSyms('LT', 60);
    let found = 0;
    for (const tf of settings.ltTfs) {
      await pool(list, 3, async (sym) => {
        const cs = await getLtCandles(sym, tf, LT_BARS);
        if (!cs || cs.length < 150) return;
        const tri = manualTriangle(cs, tf);
        const key = sym + '|' + tf;
        if (tri) { LT_CACHE.set(key, { sym, tf, cs, tri, at: now, barAt: now }); found++; }
        else LT_CACHE.delete(key);
      });
    }
    buildLtWatch();
    lastScan.lt = Date.now();
    log('LT TARAMA: ' + (list.length * settings.ltTfs.length) + ' coin-TF | ' + found + ' üçgen izlemede');
  } catch (e) { log('LT tarama hatası: ' + redact(e.message)); }
  finally { ltScanning = false; }
}
function ltTouch(sym, e) {
  // Canlı fiyatla çizgi teması var mı? Üst çizgi → SHORT, alt çizgi → LONG.
  const t = TICK.get(sym);
  const px = t && t.last > 0 && Date.now() - t.ts < 20e3 ? t.last : 0;
  if (!px) return null;
  const { tri, tf } = e;
  const atr = tri.atr;
  const up = triUpperAt(tri, tri.refIdx), dn = triLowerAt(tri, tri.refIdx);
  const distUp = (up - px) / atr;   // üst çizgiye uzaklık (ATR)
  const distDn = (px - dn) / atr;   // alt çizgiye uzaklık (ATR)
  const TOL = 0.35;
  if (distUp >= -0.1 && distUp <= TOL) return { dir: 'SHORT', line: 'ÜST', px, up, dn, distAtr: +distUp.toFixed(2) };
  if (distDn >= -0.1 && distDn <= TOL) return { dir: 'LONG', line: 'ALT', px, up, dn, distAtr: +distDn.toFixed(2) };
  return null;
}
function ltSignalRaw(e, touch) {
  const { tri, tf } = e;
  const d = touch.dir === 'LONG' ? 1 : -1;
  const entry = rp(touch.px);
  const atr = tri.atr;
  // Stop: çizginin 0.8 ATR ötesi (temaS fiyatı geri çevirirse çık)
  const sl = rp(entry - d * Math.max(0.8 * atr, entry * 0.006));
  const plan = planFromStop(entry, sl, touch.dir, 1.2, 2.2);
  if (!plan) return null;
  return {
    module: 'LT', symbol: e.sym, base: baseOf(e.sym), dir: touch.dir,
    entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2,
    conf: clamp(Math.round(50 + tri.score * 0.4), 50, 90),
    maxAgeMs: 8 * H1, touch: true,
    info: {
      tf, source: 'math', setup: 'LT_TOUCH', shape: tri.shape,
      plan: { entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2 },
      netRR: plan.netRR, netRR2: plan.netRR2, riskPct: plan.riskPct,
      atr: rp(atr), atrPct: +(atr / entry * 100).toFixed(2),
      upper: rp(touch.up), lower: rp(touch.dn), line: touch.line,
      distAtr: touch.distAtr, maturity: tri.maturity, compression: tri.compression,
      widthPct: tri.widthPct, score: tri.score, apexAt: tri.apexAt,
      note: touch.line + ' çizgi teması — fake/kırılım kontrolü kullanıcıda'
    },
    setupKey: 'LT|' + e.sym + '|' + tf + '|' + tri.firstT + '|' + touch.dir
  };
}
let ltTicking = false;
async function ltTick() {
  if (ltTicking || ltScanning) return;
  ltTicking = true;
  try {
    const now = Date.now();
    for (const [key, e] of LT_CACHE) {
      if (!e || !e.tri) continue;
      // mum tazeliği: son kapanış 2 TF'den eskiyse yenile
      const last = e.cs[e.cs.length - 1];
      if (now - (last.t + (TF_MS[e.tf] || H2)) > 2 * (TF_MS[e.tf] || H2)) {
        try {
          const cs = await getLtCandles(e.sym, e.tf, LT_BARS);
          if (cs && cs.length >= 150) {
            const tri = manualTriangle(cs, e.tf);
            if (tri) { e.cs = cs; e.tri = tri; e.barAt = now; }
            else { LT_CACHE.delete(key); continue; }
          }
        } catch (err) { continue; }
      }
      const touch = ltTouch(e.sym, e);
      if (!touch) continue;
      const raw = ltSignalRaw(e, touch);
      if (!raw) continue;
      const prev = FIRED.get(raw.setupKey);
      if (prev && now - prev < 2 * H1) continue;
      const sig = addSignal(raw);
      if (sig) {
        FIRED.set(raw.setupKey, now);
        log('LT TEMAS: ' + sig.base + ' ' + sig.dir + ' | ' + raw.info.tf + ' ' + raw.info.shape + ' | ' + raw.info.line + ' çizgi ' + rp(touch.dir === 'LONG' ? touch.dn : touch.up));
      }
    }
    buildLtWatch();
    lastScan.tick = now;
  } catch (e) { /* sessiz */ }
  finally { ltTicking = false; }
}
function buildLtWatch() {
  const rows = [];
  for (const [, e] of LT_CACHE) {
    if (!e || !e.tri) continue;
    const { tri, tf } = e;
    const t = TICK.get(e.sym);
    const px = t && t.last > 0 ? t.last : tri.px;
    const atr = tri.atr;
    const up = triUpperAt(tri, tri.refIdx), dn = triLowerAt(tri, tri.refIdx);
    const distUp = (up - px) / atr, distDn = (px - dn) / atr;
    const near = Math.min(Math.abs(distUp), Math.abs(distDn));
    let status = 'SIKIŞMA', dirHint = null;
    if (distUp >= -0.1 && distUp <= 0.35) { status = 'ÜST ÇİZGİ TEMAS'; dirHint = 'SHORT'; }
    else if (distDn >= -0.1 && distDn <= 0.35) { status = 'ALT ÇİZGİ TEMAS'; dirHint = 'LONG'; }
    else if (near <= 1.0) { status = 'ÇİZGİYE YAKIN'; dirHint = Math.abs(distUp) <= Math.abs(distDn) ? 'SHORT' : 'LONG'; }
    rows.push({
      symbol: e.sym, base: baseOf(e.sym), tf, price: rp(px), upper: rp(up), lower: rp(dn),
      distUpPct: +((up / px - 1) * 100).toFixed(2), distDnPct: +((px / dn - 1) * 100).toFixed(2),
      nearAtr: +near.toFixed(2), status, dirHint,
      shape: tri.shape, maturity: tri.maturity, compression: tri.compression, score: tri.score,
      widthPct: tri.widthPct, apexAt: tri.apexAt, spanBars: tri.spanBars,
      firstT: tri.firstT
    });
  }
  rows.sort((a, b) => a.nearAtr - b.nearAtr || b.score - a.score);
  WATCH.lt = rows.slice(0, 40);
}
/* ── Sinyal yaşam döngüsü ────────────────────────────────────── */
function isOpenSignal(s) { return !!s && s.status !== 'KAPALI' && s.status !== 'BEKLE'; }
function dayPnl() { return +(paper.equity - paper.dayStart).toFixed(4); }
function paperMarkEquity() {
  let eq = paper.equity;
  for (const p of paper.open) {
    const px = priceOf(p.symbol) || p.livePrice || p.entry;
    eq += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty;
  }
  return eq;
}
function dailyLossHit() {
  if (settings.tradeMode === 'live' && HAS_KEYS) {
    const equity = num(LIVE.balance && LIVE.balance.total, 0);
    const start = num(LIVE.dayStart, 0);
    if (equity > 0 && start > 0) return equity - start <= -Math.abs(start * settings.dailyLossPct / 100);
  }
  return paperMarkEquity() - paper.dayStart <= -Math.abs(paper.dayStart * settings.dailyLossPct / 100);
}
function autoOpenCount() { return paper.open.length + LIVE.open.filter(p => p.module === 'AUTO').length; }
function canAutoOpen() { return settings.autoTrade === true && autoOpenCount() < settings.autoMaxOpen && !dailyLossHit(); }

function addSignal(raw) {
  if (!raw || !MODS[raw.module]) return false;
  const M = MODS[raw.module], now = Date.now();
  if (!['LONG', 'SHORT'].includes(raw.dir)) return false;
  if (!(raw.entry > 0) || !(raw.sl > 0) || !(raw.tp1 > 0)) return false;
  const d = raw.dir === 'LONG' ? 1 : -1;
  if ((raw.tp1 - raw.entry) * d <= 0 || (raw.sl - raw.entry) * d >= 0) return false;
  const same = signals.filter(s => s.module === raw.module && s.symbol === raw.symbol);
  if (same.some(s => s.status !== 'KAPALI')) { logRej(raw.module, raw.symbol, 'aynı coin açık sinyal', raw.entry); return false; }
  const last = same.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && now - (last.closedAt || last.createdAt) < M.cooldown) { logRej(raw.module, raw.symbol, 'soğuma', raw.entry); return false; }
  if (same.filter(s => s.createdAt >= utcDayStart(now)).length >= M.maxPerDaySym) { logRej(raw.module, raw.symbol, 'günlük limit', raw.entry); return false; }
  if (raw.setupKey) {
    const f = FIRED.get(raw.setupKey);
    const ttl = raw.module === 'LT' ? 6 * H1 : raw.module === 'AUTO' ? 6 * M1 : 30 * M1;
    if (f && now - f < ttl) return false;
  }
  const id = 'S' + (++seq).toString(36) + '-' + now.toString(36);
  const counter = market.dir !== 'NOTR' && market.dir !== raw.dir;
  const sig = {
    id, module: raw.module, symbol: raw.symbol, base: raw.base || baseOf(raw.symbol),
    dir: raw.dir, entry: rp(raw.entry), sl: rp(raw.sl), curSl: rp(raw.sl),
    tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null, tp1Hit: false,
    tp1Fraction: Number.isFinite(Number(raw.tp1Fraction)) ? raw.tp1Fraction : 0.5,
    conf: clamp(Math.round(num(raw.conf, 55)), 30, 99),
    counter, marketAlign: market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU'),
    info: Object.assign({}, raw.info || {}, { plan: (raw.info && raw.info.plan) || { entry: rp(raw.entry), sl: rp(raw.sl), tp1: rp(raw.tp1), tp2: raw.tp2 ? rp(raw.tp2) : null } }),
    status: 'AKTIF', result: null, ai: null, aiAttempt: 0, nextAiRetryAt: 0, executionBusy: false,
    createdAt: now, updatedAt: now, maxAgeMs: raw.maxAgeMs || M.maxAge,
    setupKey: raw.setupKey || null, tradeable: M.tradeable, virtual: !M.tradeable,
    startedAt: now, activatedAt: now, waitExpiresAt: now + (raw.module === 'AUTO' ? 60e3 : 30 * M1),
    isLive: false, skipNote: null
  };
  // OtoTrade: AI koordinasyonu
  if (raw.module === 'AUTO') {
    if (settings.autoTrade === true && aiReady() && canAutoOpen()) {
      sig.status = 'AI_BEKLIYOR';
      sig.note = 'AI giriş onayı bekleniyor';
    } else {
      sig.status = 'AKTIF';
      sig.note = !settings.autoTrade ? 'OtoTrade kapalı — yalnızca sinyal' : !aiReady() ? 'AI kapalı — otomatik giriş yok' : 'kapasite/risk limiti — otomatik giriş yok';
    }
  }
  signals.push(sig);
  if (signals.length > 400) signals.splice(0, signals.length - 400);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + sig.base + ' | ' + sig.dir + ' | güven ' + sig.conf + ' | ' + (sig.info.setup || ''));
  if (sig.status === 'AI_BEKLIYOR') queueAI(sig);
  return sig;
}
function removeAIWork(sig) {
  if (!sig) return;
  for (let i = AI_QUEUE.length - 1; i >= 0; i--) if (AI_QUEUE[i].id === sig.id) AI_QUEUE.splice(i, 1);
  sig.aiAttempt = (sig.aiAttempt || 0) + 1;
}
function skipSignal(sig, code, note) {
  if (!sig || sig.status === 'KAPALI') return;
  removeAIWork(sig);
  if (sig.status === 'AKTIF' && sig.virtual) {
    const px = priceOf(sig.symbol) || sig.entry;
    closeVirtual(sig, px, code === 'AI_RED' ? 'AI_EXIT' : 'REVERSAL');
    sig.skipNote = note || RES[code] || code;
    dirty = true;
    return;
  }
  sig.status = 'KAPALI';
  sig.result = code;
  sig.netR = null; sig.grossR = null;
  sig.closedAt = Date.now();
  sig.skipNote = note || '';
  dirty = true;
  log('ATLANDI: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + (RES[code] || code) + (note ? ' (' + String(note).slice(0, 120) + ')' : ''));
}

/* sanal sinyal kapanışı (PUMP/MOM/LT) */
function closeVirtual(sig, px, result) {
  if (!sig || sig.status === 'KAPALI') return;
  const r = outcomeR(sig, px);
  sig.status = 'KAPALI';
  sig.result = result;
  sig.exit = rp(px);
  sig.closedAt = Date.now();
  sig.netR = r.netR;
  sig.grossR = r.grossR;
  sig.maxR = +(sig.maxR || 0).toFixed(2);
  dirty = true;
  log('SANAL KAPANDI: ' + sig.base + ' ' + sig.dir + ' → ' + (RES[result] || result) + ' | net ' + (r.netR == null ? '—' : sgn(r.netR)) + 'R');
}
let virtMon = false;
async function monitorVirtual() {
  if (virtMon) return;
  virtMon = true;
  try {
    for (const sig of signals) {
      if (sig.status !== 'AKTIF' || !sig.virtual) continue;
      const px = priceOf(sig.symbol);
      if (!(px > 0)) continue;
      const d = sig.dir === 'LONG' ? 1 : -1;
      const risk = Math.abs(sig.entry - sig.sl);
      if (!(risk > 0)) { skipSignal(sig, 'SKIP', 'plan hatalı'); continue; }
      sig.maxR = Math.max(num(sig.maxR, 0), (px - sig.entry) * d / risk);
      if ((sig.sl - px) * d >= 0) { closeVirtual(sig, sig.sl, sig.tp1Hit ? 'BE' : 'SL'); continue; }
      if (!sig.tp1Hit && (sig.tp1 - px) * d <= 0) sig.tp1Hit = true;
      if (sig.tp2 && (sig.tp2 - px) * d <= 0) { closeVirtual(sig, sig.tp2, 'TP2'); continue; }
      if (sig.maxR >= 1 && !sig.lockDone) { sig.lockDone = true; sig.curSl = rp(sig.entry + d * sig.entry * EX.COST / 100); }
      if (sig.maxR >= 1) sig.curSl = moreProtective(sig.curSl, rp(sig.entry + d * (sig.maxR - 0.5) * risk), d);
      if (Date.now() - sig.startedAt >= (sig.maxAgeMs || MODS[sig.module].maxAge)) closeVirtual(sig, px, 'TIME');
    }
  } finally { virtMon = false; }
}

/* ── Paper (yalnız AUTO) ─────────────────────────────────────── */
function executionPlanError(sig, entry) {
  const d = sig.dir === 'LONG' ? 1 : -1;
  if (!d || !(entry > 0) || !(sig.sl > 0) || !(sig.tp1 > 0)) return 'plan geçersiz';
  if ((sig.sl - entry) * d >= 0 || (sig.tp1 - entry) * d <= 0) return 'fiyat stop/hedef sınırını geçti';
  if (sig.tp2 && (sig.tp2 - sig.tp1) * d <= 0) return 'TP2 sırası geçersiz';
  const riskPct = Math.abs(entry - sig.sl) / entry * 100;
  if (!(riskPct >= 0.4 && riskPct <= 3.6)) return 'risk sınırı bozuldu (%' + riskPct.toFixed(2) + ')';
  return null;
}
function openPaper(sig) {
  if (!sig || sig.status === 'KAPALI') return { error: 'sinyal kapalı' };
  if (sig.module !== 'AUTO') return { error: 'bu modül sanal sinyal üretir' };
  if (paper.open.some(p => p.symbol === sig.symbol) || LIVE.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin açık' };
  if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks ' + settings.autoMaxOpen + ' işlem' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const px = priceOf(sig.symbol, 5000);
  if (!(px > 0)) return { error: 'taze fiyat yok' };
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > 0.5) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const entry = rp(px);
  const planError = executionPlanError(sig, entry);
  if (planError) { skipSignal(sig, 'AI_STALE', planError); return { error: planError }; }
  const riskPerUnit = Math.abs(entry - sig.sl);
  if (!(riskPerUnit > 0)) return { error: 'stop geçersiz' };
  const riskAmt = paper.equity * settings.riskPct / 100;
  let qty = riskAmt / riskPerUnit;
  const maxNotional = settings.margin * settings.leverage;
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  if (!(qty > 0)) return { error: 'miktar 0' };
  const pos = {
    id: 'P' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: 'AUTO', symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +qty.toFixed(8), initialQty: +qty.toFixed(8), remainingQty: +qty.toFixed(8),
    notional: +(qty * entry).toFixed(4), margin: +((qty * entry) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(qty * riskPerUnit).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, maxR: 0,
    peakPx: entry, isLive: false, tp1Fraction: sig.tp1Fraction || 0.5
  };
  sig.executionEntry = entry;
  sig.status = 'AKTIF';
  if (!(Number(sig.startedAt) > 0)) sig.startedAt = pos.openedAt;
  paper.open.push(pos);
  dirty = true;
  log('PAPER AÇILDI: ' + sig.base + ' ' + sig.dir + ' | giriş ' + entry + ' | SL ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | risk %' + settings.riskPct);
  return { pos };
}
function closePortion(pos, qty, price) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  qty = Math.min(Math.max(0, Number(qty) || 0), Math.max(0, pos.remainingQty));
  if (!(qty > 0)) return;
  const costPct = pos.isLive ? EX.H : EX.COST;
  pos.grossRealized += (price - pos.entry) * d * qty;
  pos.costPaid += qty * (pos.entry + price) / 2 * costPct / 100;
  pos.remainingQty = +Math.max(0, pos.remainingQty - qty).toFixed(12);
}
function stopResult(pos, d) {
  if (pos.tp1Hit) return 'BE';
  const diff = (pos.curSl - pos.entry) * d / Math.max(1e-9, pos.entry);
  if (diff > 0.0003) return 'LOCK';
  return Math.abs(diff) <= 0.0003 ? 'BE' : 'SL';
}
function breakEvenPrice(pos) {
  const d = pos.dir === 'LONG' ? 1 : -1;
  return rp(pos.entry + d * pos.entry * (pos.isLive ? EX.H : EX.COST) / 100);
}
function closePaper(pos, price, reason) {
  if (!pos || pos.isLive || !paper.open.some(p => p.id === pos.id)) return;
  const qty = pos.remainingQty;
  if (qty > 0) closePortion(pos, qty, price);
  const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
  const grossR = +(pos.grossRealized / Math.max(1e-9, pos.riskAmt)).toFixed(3);
  const netR = +(net / Math.max(1e-9, pos.riskAmt)).toFixed(3);
  paper.equity = +(paper.equity + net).toFixed(4);
  paper.peak = Math.max(paper.peak, paper.equity);
  const sig = signals.find(s => s.id === pos.sigId);
  if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(price); sig.closedAt = Date.now(); sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.maxR = +(pos.maxR || 0).toFixed(3); }
  paper.open = paper.open.filter(p => p.id !== pos.id);
  const rec = Object.assign({}, pos, { exit: rp(price), result: reason, pnl: net, netR, grossR, closedAt: Date.now() });
  delete rec.remainingQty;
  paper.closed.push(rec);
  if (paper.closed.length > 200) paper.closed.shift();
  dirty = true;
  log('PAPER KAPANDI: ' + pos.base + ' ' + pos.dir + ' → ' + (RES[reason] || reason) + ' | net ' + sgn(netR) + 'R (' + net + ' USDT) | bakiye ' + paper.equity);
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
      let px = priceOf(pos.symbol, 5000);
      if (!(px > 0)) { const q = await freshMarketPrice(pos.symbol, 5000); px = q.price; }
      if (!(px > 0)) continue;
      const tk = TICK.get(pos.symbol); if (tk) { tk.last = px; tk.ts = now; }
      pos.livePrice = rp(px);
      pos.ageMs = now - pos.openedAt;
      pos.livePnl = +((pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty).toFixed(4);
      pos.livePnlPct = +(pos.livePnl / Math.max(1e-9, pos.margin) * 100).toFixed(2);
      const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
      pos.peakPx = d === 1 ? Math.max(pos.peakPx || pos.entry, px) : Math.min(pos.peakPx || pos.entry, px);
      pos.maxR = Math.max(pos.maxR || 0, (pos.peakPx - pos.entry) * d / rRisk);
      const rNow = (px - pos.entry) * d / rRisk;

      if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { closePaper(pos, pos.curSl, stopResult(pos, d)); continue; }
      if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { closePaper(pos, pos.tp2, 'TP2'); continue; }
      if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
        closePortion(pos, pos.remainingQty * (pos.tp1Fraction || 0.5), pos.tp1);
        pos.tp1Hit = true;
        pos.curSl = rp(moreProtective(pos.curSl, breakEvenPrice(pos), d));
        const sig = signals.find(s => s.id === pos.sigId);
        if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; }
        dirty = true;
        log('TP1: ' + pos.base + ' %' + Math.round((pos.tp1Fraction || 0.5) * 100) + ' alındı, stop girişe çekildi');
      }
      // OtoTrade vur-kaç çıkışları: ivme bitince çık
      if (pos.module === 'AUTO') {
        // İLK İVME BİTTİYSE VE KÂRDAYSak HEMEN ÇIK
        // (Fitil döndüğü an veya fiyat tepe noktasından geri çekildiği an)
        if (pos.maxR >= 0.4 && rNow <= pos.maxR - AUTO_CFG.trailDropR) { 
            closePaper(pos, px, 'MOMENTUM'); 
            continue; 
        } 
        // Kâr 0.5R'yi geçtiyse ve fiyat tepe noktasından (fitil) geri gelmeye başladıysa hemen çık
        if (pos.maxR >= 0.5 && rNow < pos.maxR - 0.15) {
             closePaper(pos, px, 'FIRST_IMPULSE');
             continue;
        }
        // 3 dakika içinde ivme yoksa (kâr yoksa) çık
        if (pos.ageMs > AUTO_CFG.stallSec * 1000 && pos.maxR < 0.25 && rNow <= 0) { 
            closePaper(pos, px, 'STALL'); 
            continue; 
        }
        // 10 dakika tavan
        if (pos.ageMs >= AUTO_CFG.maxHoldMs) { 
            closePaper(pos, px, 'TIME'); 
            continue; 
        }
      }
      if (pos.tp1Hit && pos.module === 'AUTO' && pos.maxR > 1.1) {
        const ns = rp(pos.entry + d * (pos.maxR - 0.7) * rRisk);
        if (d === 1 ? ns > pos.curSl : ns < pos.curSl) {
          pos.curSl = ns;
          const sig = signals.find(s => s.id === pos.sigId);
          if (sig) sig.curSl = ns;
          dirty = true;
        }
      }
    }
  } finally { paperMon = false; }
}
function paperSummary() {
  const cl = paper.closed;
  const wins = cl.filter(x => x.pnl > 0).length;
  let unrealized = 0;
  for (const p of paper.open) { const px = priceOf(p.symbol) || p.entry; unrealized += (px - p.entry) * (p.dir === 'LONG' ? 1 : -1) * p.remainingQty; }
  const eq = paper.equity;
  const peak = Math.max(paper.peak || eq, eq);
  return {
    equity: +eq.toFixed(2), start: paper.start, dayStart: +paper.dayStart.toFixed(2), dayPnl: dayPnl(),
    open: paper.open.length, closed: cl.length, wins, losses: cl.length - wins,
    winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0,
    sumPnl: +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4),
    unrealized: +unrealized.toFixed(2), mode: settings.tradeMode, autoTrade: settings.autoTrade
  };
}
function viewPaper(p) {
  const px = priceOf(p.symbol) || p.livePrice || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +((p.grossRealized - p.costPaid) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(1e-9, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt });
}
function sigPL(s) {
  const d = s.dir === 'LONG' ? 1 : -1;
  const riskAmt = paper.equity * settings.riskPct / 100;
  if (s.status === 'KAPALI') {
    if (s.netR == null) return null;
    return { price: s.exit || null, netR: s.netR, usdt: s.pnlUsdt != null ? s.pnlUsdt : +(s.netR * riskAmt).toFixed(2), maxR: +(s.maxR || 0).toFixed(2), closed: true, virtual: s.virtual };
  }
  const px = priceOf(s.symbol);
  if (!(px > 0)) return null;
  const pos = paper.open.find(p => p.sigId === s.id) || LIVE.open.find(p => p.sigId === s.id);
  if (pos) {
    const r = pos.livePnl != null ? pos.livePnl : 0;
    return { price: rp(px), netR: +(r / Math.max(1e-9, pos.riskAmt)).toFixed(2), usdt: +r.toFixed(2), maxR: +(pos.maxR || 0).toFixed(2), closed: false, virtual: false };
  }
  const r = outcomeR(s, px).netR;
  if (r == null) return null;
  return { price: rp(px), netR: r, usdt: +(r * riskAmt).toFixed(2), maxR: +(s.maxR || 0).toFixed(2), closed: false, virtual: true };
}
function viewSignal(s) {
  return Object.assign({}, s, { pl: sigPL(s), ageMs: Date.now() - s.createdAt, riskPct: +(Math.abs(s.entry - s.sl) / s.entry * 100).toFixed(2) });
}

/* ── Canlı işlem (kısaltılmış) ───────────────────────────────── */
function liveReady() { return HAS_KEYS && !!API_TOKEN && settings.tradeMode === 'live'; }
function friendlyBitgetError(msg) {
  const s = String(msg || '');
  if (/40018|Invalid IP/i.test(s)) {
    const m = s.match(/Current request IP\s*:?\s*([0-9a-fA-F:.]+)/i);
    if (m) LIVE.ipHint = m[1];
    return "Bitget IP kısıtlaması. Çıkış IP: " + (m ? m[1] : '?') + " — Bitget API anahtarına bu IP'yi ekle.";
  }
  if (/40012|40006|40009|Invalid ApiKey|signature/i.test(s)) return 'Bitget API key/secret/passphrase hatalı: ' + s.slice(0, 140);
  if (/40014|permission/i.test(s)) return 'API anahtarında futures işlem yetkisi eksik: ' + s.slice(0, 140);
  return s;
}
async function fetchLiveBalance(force) {
  if (!HAS_KEYS) return { total: 0, free: 0, used: 0, at: Date.now(), error: 'Bitget anahtarı yok' };
  if (!force && LIVE.balance && Date.now() - LIVE.balance.at < 10e3) return LIVE.balance;
  try {
    const raw = await ex.fetchBalance({ type: 'swap' });
    const u = (raw && (raw.USDT || raw.usdt)) || {};
    let total = num(u.total, 0), free = num(u.free, 0), used = num(u.used, 0);
    if (!(total > 0) && raw && raw.info) {
      const arr = Array.isArray(raw.info) ? raw.info : (Array.isArray(raw.info.data) ? raw.info.data : []);
      const row = arr.find(x => String(x.marginCoin || x.coin || '').toUpperCase() === 'USDT');
      if (row) { total = num(row.equity || row.available, total); free = num(row.available || row.crossedMaxAvailable, free); used = Math.max(0, total - free); }
    }
    LIVE.balance = { total, free, used, at: Date.now() };
    const dk = dayKey();
    if (LIVE.dayKey !== dk || !(LIVE.dayStart > 0)) { LIVE.dayKey = dk; LIVE.dayStart = total; dirty = true; }
    LIVE.lastError = null;
    return LIVE.balance;
  } catch (e) {
    LIVE.lastError = friendlyBitgetError(redact(e.message));
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
  } catch (e) { LIVE.lastError = friendlyBitgetError(redact(e.message)); return null; }
}
function findExchangePosition(sym, dir) {
  return (LIVE.positions || []).find(p => p && p.symbol === sym && Math.abs(num(p.contracts)) > 0 && String(p.side || '').toLowerCase() === (dir === 'LONG' ? 'long' : 'short')) || null;
}
function priceForExchange(sym, v) { try { return Number(ex.priceToPrecision(sym, v)); } catch (e) { return v; } }
async function placeLiveProtection(sig, pos, d, amount) {
  const closeSide = d === 1 ? 'sell' : 'buy';
  try {
    const so = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { stopLossPrice: priceForExchange(sig.symbol, sig.sl), reduceOnly: true });
    pos.stopOrderId = so && so.id;
  } catch (e) {
    log('CANLI STOP KURULAMADI: ' + sig.base + ' → ' + redact(e.message));
    try { await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { reduceOnly: true }); } catch (e2) { log('!!! ACİL: ' + sig.base + ' stopsuz açık olabilir'); }
    return false;
  }
  if (sig.tp2) {
    try { const to = await ex.createOrder(sig.symbol, 'market', closeSide, amount, undefined, { takeProfitPrice: priceForExchange(sig.symbol, sig.tp2), reduceOnly: true }); pos.tpOrderId = to && to.id; } catch (e) { log('CANLI TP KURULAMADI: ' + sig.base); }
  }
  return true;
}
async function liveOpen(sig) {
  if (settings.tradeMode !== 'live') return openPaper(sig);
  if (!HAS_KEYS || !API_TOKEN) return { error: 'Canlı mod için Bitget anahtarı + ALPHASON_API_TOKEN gerekli' };
  if (LIVE.open.some(p => p.symbol === sig.symbol) || paper.open.some(p => p.symbol === sig.symbol)) return { error: 'aynı coin açık' };
  if (autoOpenCount() >= settings.autoMaxOpen) return { error: 'OtoTrade maks işlem' };
  if (dailyLossHit()) return { error: 'günlük zarar limiti' };
  const quote = await freshMarketPrice(sig.symbol, 5000), px = quote.price;
  if (!(px > 0)) return { error: quote.error || 'taze fiyat yok' };
  const drift = Math.abs(px / sig.entry - 1) * 100;
  if (drift > 0.5) { skipSignal(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return { error: 'fiyat kaçtı' }; }
  const bal = await fetchLiveBalance(true);
  if (LIVE.lastError) return { error: LIVE.lastError };
  if (!(bal.total > 0)) return { error: 'Bitget USDT bakiyesi okunamadı/0' };
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = rp(px);
  const planError = executionPlanError(sig, entry);
  if (planError) { skipSignal(sig, 'AI_STALE', planError); return { error: planError }; }
  const riskPerUnit = Math.abs(entry - sig.sl);
  const riskAmt = bal.total * settings.riskPct / 100;
  let qty = riskAmt / riskPerUnit;
  const maxNotional = Math.min(bal.total * settings.leverage * 0.95, settings.margin * settings.leverage);
  if (qty * entry > maxNotional) qty = maxNotional / entry;
  let amount;
  try { amount = ex.amountToPrecision(sig.symbol, qty); } catch (e) { amount = qty; }
  if (!(Number(amount) > 0) || Number(amount) * entry < 5) return { error: 'emir çok küçük (min 5 USDT)' };
  try { await ex.setMarginMode('isolated', sig.symbol, { leverage: settings.leverage }); } catch (e) { log('Marjin notu: ' + redact(e.message).slice(0, 120)); }
  try { await ex.setLeverage(settings.leverage, sig.symbol); } catch (e) { return { error: 'kaldıraç ayarlanamadı: ' + friendlyBitgetError(redact(e.message)) }; }
  let order;
  try { order = await ex.createOrder(sig.symbol, 'market', d === 1 ? 'buy' : 'sell', amount, undefined, {}); }
  catch (e) { LIVE.lastError = friendlyBitgetError(redact(e.message)); return { error: LIVE.lastError }; }
  const fill = rp(num(order && (order.average || order.price), entry));
  const fillErr = executionPlanError(sig, fill);
  if (fillErr) {
    try { await ex.createOrder(sig.symbol, 'market', d === 1 ? 'sell' : 'buy', amount, undefined, { reduceOnly: true }); } catch (e) {}
    skipSignal(sig, 'AI_STALE', fillErr);
    return { error: fillErr };
  }
  const pos = {
    id: 'L' + (++seq).toString(36) + '-' + Date.now().toString(36),
    sigId: sig.id, module: 'AUTO', symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry: fill, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
    qty: +Number(amount).toFixed(8), initialQty: +Number(amount).toFixed(8), remainingQty: +Number(amount).toFixed(8),
    notional: +(Number(amount) * fill).toFixed(4), margin: +((Number(amount) * fill) / settings.leverage).toFixed(4),
    leverage: settings.leverage, riskAmt: +(Number(amount) * Math.abs(fill - sig.sl)).toFixed(4),
    openedAt: Date.now(), tp1Hit: false, grossRealized: 0, costPaid: 0, maxR: 0, peakPx: fill,
    isLive: true, tp1Fraction: sig.tp1Fraction || 0.5, orderId: order && order.id, stopOrderId: null, tpOrderId: null, closing: false
  };
  const prot = await placeLiveProtection(sig, pos, d, amount);
  if (!prot) { skipSignal(sig, 'SKIP', 'stop kurulamadı, pozisyon kapatıldı'); return { error: 'stop kurulamadı' }; }
  sig.executionEntry = fill;
  sig.status = 'AKTIF';
  sig.isLive = true;
  LIVE.open.push(pos);
  LIVE.needsSync = true;
  dirty = true;
  saveState(false);
  log('CANLI AÇILDI: ' + sig.base + ' ' + sig.dir + ' | giriş ' + fill + ' | miktar ' + amount + ' | ' + settings.leverage + 'x');
  fetchLiveBalance(true).catch(() => {});
  return { pos };
}
async function liveClose(pos, price, reason, portion) {
  if (!pos || !pos.isLive || !LIVE.open.some(p => p.id === pos.id)) return { error: 'pozisyon kapalı' };
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
    } catch (e) { LIVE.lastError = friendlyBitgetError(redact(e.message)); return { error: LIVE.lastError }; }
    if (!(fill > 0)) fill = priceOf(pos.symbol) || pos.entry;
    const partQty = Number(amount);
    pos.grossRealized += (fill - pos.entry) * d * partQty;
    pos.costPaid += partQty * (pos.entry + fill) / 2 * EX.H / 100;
    pos.remainingQty = +(pos.remainingQty - partQty).toFixed(8);
    if (pos.remainingQty > pos.initialQty * 0.01) {
      dirty = true;
      fetchLiveBalance(true).catch(() => {});
      return { partial: true };
    }
    const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
    const netR = +(net / Math.max(1e-9, pos.riskAmt)).toFixed(3);
    const grossR = +(pos.grossRealized / Math.max(1e-9, pos.riskAmt)).toFixed(3);
    const sig = signals.find(s => s.id === pos.sigId);
    if (sig) { sig.status = 'KAPALI'; sig.result = reason; sig.exit = rp(fill); sig.closedAt = Date.now(); sig.netR = netR; sig.grossR = grossR; sig.pnlUsdt = net; sig.isLive = true; }
    LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
    LIVE.closed.push(Object.assign({}, pos, { exit: rp(fill), result: reason, pnl: net, netR, grossR, closedAt: Date.now() }));
    if (LIVE.closed.length > 100) LIVE.closed.shift();
    LIVE.needsSync = true;
    dirty = true;
    if (pos.stopOrderId) ex.cancelOrder(pos.stopOrderId, pos.symbol).catch(() => {});
    if (pos.tpOrderId) ex.cancelOrder(pos.tpOrderId, pos.symbol).catch(() => {});
    log('CANLI KAPANDI: ' + pos.base + ' → ' + (RES[reason] || reason) + ' | net ' + sgn(netR) + 'R (' + net + ' USDT)');
    fetchLiveBalance(true).catch(() => {});
    return { exit: rp(fill), netR, pnl: net };
  } finally { pos.closing = false; }
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
        const quote = await freshMarketPrice(pos.symbol, 5000);
        if (quote.price > 0) {
          const d = pos.dir === 'LONG' ? 1 : -1;
          const qty = pos.remainingQty || 0;
          if (qty > 0) { pos.grossRealized += (quote.price - pos.entry) * d * qty; pos.costPaid += qty * (pos.entry + quote.price) / 2 * EX.H / 100; }
          const net = +(pos.grossRealized - pos.costPaid).toFixed(4);
          const netR = +(net / Math.max(1e-9, pos.riskAmt)).toFixed(3);
          const sig = signals.find(s => s.id === pos.sigId);
          if (sig) { sig.status = 'KAPALI'; sig.result = 'EXCHANGE'; sig.exit = rp(quote.price); sig.closedAt = Date.now(); sig.netR = netR; sig.pnlUsdt = net; }
          LIVE.open = LIVE.open.filter(p => p.id !== pos.id);
          LIVE.closed.push(Object.assign({}, pos, { exit: rp(quote.price), result: 'EXCHANGE', pnl: net, netR, closedAt: Date.now() }));
          if (LIVE.closed.length > 100) LIVE.closed.shift();
          dirty = true;
          log('CANLI POZİSYON BORSADA KAPANMIŞ: ' + pos.base + ' → ' + sgn(netR) + 'R');
        }
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
  if (orphans.length) log('UYARI: Borsada bilinmeyen ' + orphans.length + ' pozisyon: ' + orphans.map(p => baseOf(p.symbol) + ' ' + p.side).join(', '));
}
async function monitorLive() {
  if (!HAS_KEYS || !LIVE.open.length) return;
  for (const pos of LIVE.open.slice()) {
    if (pos.closing) continue;
    const quote = await freshMarketPrice(pos.symbol, 5000), px = quote.price;
    if (!(px > 0)) continue;
    const d = pos.dir === 'LONG' ? 1 : -1;
    pos.livePrice = rp(px);
    pos.ageMs = Date.now() - pos.openedAt;
    const unreal = (pos.grossRealized - pos.costPaid) + (px - pos.entry) * d * pos.remainingQty;
    pos.livePnl = +unreal.toFixed(4);
    pos.livePnlPct = +(unreal / Math.max(1e-9, pos.margin) * 100).toFixed(2);
    const rRisk = Math.max(1e-9, Math.abs(pos.entry - pos.sl));
    pos.peakPx = d === 1 ? Math.max(pos.peakPx || pos.entry, px) : Math.min(pos.peakPx || pos.entry, px);
    pos.maxR = Math.max(pos.maxR || 0, (pos.peakPx - pos.entry) * d / rRisk);
    const rNow = (px - pos.entry) * d / rRisk;
    if (d === 1 ? px <= pos.curSl : px >= pos.curSl) { await liveClose(pos, pos.curSl, stopResult(pos, d)); continue; }
    if (pos.tp2 && (d === 1 ? px >= pos.tp2 : px <= pos.tp2)) { await liveClose(pos, pos.tp2, 'TP2'); continue; }
    if (!pos.tp1Hit && (d === 1 ? px >= pos.tp1 : px <= pos.tp1)) {
      const r = await liveClose(pos, pos.tp1, 'TP1', +(pos.initialQty * (pos.tp1Fraction || 0.5)).toFixed(8));
      if (r && !r.error) { pos.tp1Hit = true; pos.curSl = rp(moreProtective(pos.curSl, breakEvenPrice(pos), d)); const sig = signals.find(s => s.id === pos.sigId); if (sig) { sig.tp1Hit = true; sig.curSl = pos.curSl; } dirty = true; log('CANLI TP1: ' + pos.base + ', stop girişe çekildi'); }
      continue;
    }
    if (pos.module === 'AUTO') {
      if (pos.maxR >= 0.4 && rNow <= pos.maxR - AUTO_CFG.trailDropR) { await liveClose(pos, px, 'MOMENTUM'); continue; }
      if (pos.maxR >= 0.5 && rNow < pos.maxR - 0.15) { await liveClose(pos, px, 'FIRST_IMPULSE'); continue; }
      if (pos.ageMs > AUTO_CFG.stallSec * 1000 && pos.maxR < 0.25 && rNow <= 0) { await liveClose(pos, px, 'STALL'); continue; }
      if (pos.ageMs >= AUTO_CFG.maxHoldMs) { await liveClose(pos, px, 'TIME'); continue; }
    }
  }
  LIVE.lastSync = Date.now();
}
function liveSummary() {
  const b = LIVE.balance || { total: 0, free: 0, used: 0 };
  const cl = LIVE.closed;
  const wins = cl.filter(x => num(x.pnl) > 0).length;
  return {
    equity: +num(b.total).toFixed(2), free: +num(b.free).toFixed(2), used: +num(b.used).toFixed(2),
    dayStart: num(LIVE.dayStart, num(b.total)), dayPnl: +(num(b.total) - num(LIVE.dayStart, num(b.total))).toFixed(2),
    open: LIVE.open.length, closed: cl.length, wins, losses: cl.length - wins,
    winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0,
    sumPnl: +cl.reduce((s, x) => s + num(x.pnl), 0).toFixed(4), mode: 'live', balanceError: LIVE.lastError || (b.error || null), ipHint: LIVE.ipHint
  };
}
function viewLivePos(p) {
  const px = p.livePrice || p.markPrice || priceOf(p.symbol) || p.entry;
  const d = p.dir === 'LONG' ? 1 : -1;
  const livePnl = +(((p.grossRealized || 0) - (p.costPaid || 0)) + (px - p.entry) * d * p.remainingQty).toFixed(4);
  return Object.assign({}, p, { livePrice: rp(px), livePnl, livePnlPct: +(livePnl / Math.max(1e-9, p.margin) * 100).toFixed(2), ageMs: Date.now() - p.openedAt });
}

/* ── AI katmanı (sade) ───────────────────────────────────────── */
function aiKeys() { return AI_PROV.filter(p => p.key && p.models.length); }
function aiReady() { return settings.aiEnabled === true && aiKeys().length > 0; }
function provDay(p) { const dk = dayKey(); if (p.dayKey !== dk) { p.dayKey = dk; p.dayCount = 0; } return p; }
function aiQuota() {
  const now = Date.now(), dk = dayKey(now), hk = Math.floor(now / H1);
  if (AI_USAGE.dayKey !== dk) { AI_USAGE.dayKey = dk; AI_USAGE.dayCount = 0; }
  if (AI_USAGE.hourKey !== hk) { AI_USAGE.hourKey = hk; AI_USAGE.hourCount = 0; }
  return { ok: AI_USAGE.dayCount < 1500 && AI_USAGE.hourCount < 200, dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount };
}
function aiReserve() {
  const q = aiQuota();
  if (!q.ok) { const e = new Error('AI kotası doldu'); e.status = 402; throw e; }
  AI_USAGE.dayCount++; AI_USAGE.hourCount++;
  dirty = true;
}
function orderedProviders() {
  const now = Date.now();
  return aiKeys().filter(p => provDay(p).dayCount < p.dayLimit).sort((a, b) => {
    const ca = (a.cooldownUntil || 0) > now ? 1 : 0, cb = (b.cooldownUntil || 0) > now ? 1 : 0;
    return ca !== cb ? ca - cb : a.prefer - b.prefer;
  });
}
function providerFail(p, e) {
  p.fail++;
  p.lastError = redact(e.message || 'hata');
  const st = Number(e.status) || 0;
  let ms = M1;
  if (e.budgetExhausted || st === 402) ms = 6 * H1;
  else if (st === 401 || st === 403) ms = 30 * M1;
  else if (st === 404) ms = 10 * M1;
  else if (st === 429) ms = 2 * M1;
  else if (st >= 500) ms = M1;
  p.cooldownUntil = Date.now() + ms;
  AI_STATE.lastError = p.name + ': ' + p.lastError;
  log('AI HATA: ' + p.name + ' → ' + p.lastError.slice(0, 160) + ' | ' + Math.ceil(ms / 1000) + 'sn bekleme');
}
function isModelError(e) { return Number(e && e.status) === 404 || /model.+(does not exist|not found|not supported|no access)|unknown model/i.test(String(e && e.message || '')); }
function isQuotaExhausted(e) { return /quota|insufficient|billing|resource_exhausted/i.test(String(e && e.message || '')) || Number(e && e.status) === 402; }

async function callGeminiNative(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || 20000;
  const t0 = Date.now();
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const url = p.base + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(p.key);
  aiReserve();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  let res, txt = '';
  try {
    const body = { contents, generationConfig: { temperature: 0.1, maxOutputTokens: 800, responseMimeType: 'application/json' } };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    txt = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı'); er.status = 0; throw er; }
    throw e;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const msg = (j && j.error && (j.error.message || j.error.status)) || txt.slice(0, 240) || ('HTTP ' + res.status);
    const er = new Error(msg);
    er.status = /api key|permission|unauthenticated/i.test(msg) ? 401 : /not found|not supported|does not exist/i.test(msg) ? 404 : res.status;
    throw er;
  }
  const j = JSON.parse(txt);
  const cand = j && j.candidates && j.candidates[0];
  const c = cand && cand.content && cand.content.parts ? cand.content.parts.map(x => (x && x.text) || '').join('\n') : '';
  if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.status = 502; throw er; }
  p.lat.push(Date.now() - t0); if (p.lat.length > 20) p.lat.shift();
  return { text: String(c), model };
}
async function callProviderModel(p, messages, model, opts) {
  if (p.native) return callGeminiNative(p, messages, model, opts);
  const tmo = (opts && opts.timeoutMs) || 20000;
  const t0 = Date.now();
  aiReserve();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tmo);
  let res, txt = '';
  try {
    res = await fetch(p.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 800, stream: false, response_format: { type: 'json_object' } })
    });
    txt = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; }
    throw e;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const msg = (j && j.error && (j.error.message || j.error.code)) || txt.slice(0, 240) || ('HTTP ' + res.status);
    const er = new Error(msg); er.status = res.status;
    throw er;
  }
  const j = JSON.parse(txt);
  let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
  if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
  c = c == null ? '' : String(c).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!c) { const er = new Error('boş yanıt'); er.status = 502; throw er; }
  p.lat.push(Date.now() - t0); if (p.lat.length > 20) p.lat.shift();
  return { text: c, model: j.model || model };
}
async function callAI(messages, opts) {
  opts = opts || {};
  let lastErr = null;
  for (const p of orderedProviders()) {
    if ((p.cooldownUntil || 0) > Date.now()) continue;
    const models = p.models.filter(m => !((p.modelCooldowns[m] || 0) > Date.now()));
    for (const model of models) {
      try {
        const r = await callProviderModel(p, messages, model, opts);
        if (opts.validate && !opts.validate(r.text)) {
          p.modelCooldowns[model] = Date.now() + 5 * M1;
          lastErr = new Error('geçersiz yanıt (' + p.name + '/' + model + ')');
          continue;
        }
        p.ok++; provDay(p).dayCount++; p.lastError = null;
        AI_STATE.lastError = null;
        return { provider: p.id, providerName: p.name, model: r.model || model, at: Date.now(), text: r.text };
      } catch (e) {
        lastErr = e;
        if (e.budgetExhausted || Number(e.status) === 402 || /kota/i.test(String(e.message))) { e.budgetExhausted = true; providerFail(p, e); throw e; }
        if (isModelError(e)) { p.modelCooldowns[model] = Date.now() + 30 * M1; continue; }
        providerFail(p, e);
        break;
      }
    }
  }
  const er = lastErr || new Error('AI sağlayıcısı yok');
  if (isQuotaExhausted(er)) er.budgetExhausted = true;
  throw er;
}
function extractJSON(text) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(raw.slice(a, b + 1)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { return null; }
}
function normTR(s) { return String(s == null ? '' : s).replace(/İ/g, 'I').replace(/ı/g, 'i').replace(/Ş/g, 'S').replace(/ş/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g').replace(/Ü/g, 'U').replace(/ü/g, 'u').replace(/Ö/g, 'O').replace(/ö/g, 'o').replace(/Ç/g, 'C').replace(/ç/g, 'c').toUpperCase().trim(); }
function parseAutoDec(text) {
  const j = extractJSON(text);
  if (!j) return null;
  let d = normTR(j.decision || j.karar);
  if (d === 'GIR' || d === 'ONY' || d === 'GIRILIR') d = 'APPROVE';
  if (d === 'GIRME' || d === 'RED' || d === 'GIRILMEZ') d = 'REJECT';
  if (d === 'BEKLE') d = 'WAIT';
  if (!['APPROVE', 'WAIT', 'REJECT'].includes(d)) return null;
  const conf = Number(j.confidence);
  const reason = String(j.reason || '').trim();
  if (!Number.isFinite(conf) || conf < 0 || conf > 100 || reason.length < 5) return null;
  return { decision: d, confidence: Math.round(conf), reason: reason.slice(0, 240) };
}
const AI_SYS_AUTO = 'Sen kripto scalp giriş kontrolcüsüsün. 1m ivme sinyali geldi; kod risk/spread/R:R kontrollerini yaptı. Varsayılan APPROVE. Yalnızca veride somut bozulma varsa REJECT (hareket tükenmiş, sert ters mum, hacim sönmüş). Belirsizse WAIT. Yanıt tek JSON: {"decision":"APPROVE|WAIT|REJECT","confidence":0-100,"reason":"kısa Türkçe gerekçe"}. Emir yetkin yok.';

async function autoEntryReview(sig) {
  if (!sig || sig.status === 'KAPALI') return;
  const attempt = (sig.aiAttempt || 0) + 1; sig.aiAttempt = attempt;
  if (!aiReady()) { skipSignal(sig, 'AI_ERROR', 'AI kapalı'); return; }
  if (settings.autoTrade !== true) { skipSignal(sig, 'SKIP', 'OtoTrade kapalı'); return; }
  if (Date.now() - sig.createdAt > 60e3) { skipSignal(sig, 'AI_TIMEOUT', 'giriş penceresi doldu'); return; }
  const pre = await freshMarketPrice(sig.symbol, 5000);
  if (attempt !== sig.aiAttempt || sig.status === 'KAPALI') return;
  if (!(pre.price > 0)) {
    if (attempt < 2) { sig.status = 'BEKLE'; sig.nextAiRetryAt = Date.now() + 5e3; return; }
    skipSignal(sig, 'AI_ERROR', pre.error || 'fiyat yok'); return;
  }
  const i = sig.info || {};
  const prompt = 'OTOTRADE İVME — ' + sig.base + ' ' + sig.dir + '\nPlan: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | TP2 ' + sig.tp2 + '\n' +
    '1m %' + num(i.chg1).toFixed(2) + ' | 3m %' + num(i.chg3).toFixed(2) + ' | hacim ' + num(i.volRatio).toFixed(2) + 'x | gövde ' + num(i.body).toFixed(2) + ' | ilerleme ' + num(i.progAtr).toFixed(2) + ' ATR | canlı mum ' + (i.forming ? 'evet (' + i.candleAgeSec + ' sn)' : 'hayır') + '\n' +
    'Piyasa yönü: ' + market.dir + ' (' + (sig.marketAlign || 'NOTR') + ')\nKararını ver.';
  let ai;
  try {
    ai = await callAI([{ role: 'system', content: AI_SYS_AUTO }, { role: 'user', content: prompt }], { timeoutMs: 15000, validate: t => !!parseAutoDec(t) });
  } catch (e) {
    if (attempt === sig.aiAttempt && sig.status !== 'KAPALI') {
      if (attempt < 2 && !e.budgetExhausted) { sig.status = 'BEKLE'; sig.nextAiRetryAt = Date.now() + 5e3; log('OTOTRADE AI hata, tekrar: ' + redact(e.message).slice(0, 120)); }
      else skipSignal(sig, 'AI_ERROR', 'AI yanıtı yok: ' + redact(e.message).slice(0, 160));
    }
    return;
  }
  if (attempt !== sig.aiAttempt || sig.status === 'KAPALI') return;
  if (Date.now() - sig.createdAt > 60e3) { skipSignal(sig, 'AI_TIMEOUT', 'AI yanıtı geç geldi'); return; }
  const d = parseAutoDec(ai.text);
  if (!d) { skipSignal(sig, 'AI_ERROR', 'geçersiz AI yanıtı'); return; }
  sig.ai = Object.assign({}, d, { provider: ai.providerName, model: ai.model, at: ai.at });
  if (d.decision === 'REJECT') { skipSignal(sig, 'AI_RED', 'AI REJECT: ' + d.reason); return; }
  if (d.decision === 'WAIT' && attempt < 2) { sig.status = 'BEKLE'; sig.nextAiRetryAt = Date.now() + 4e3; log('OTOTRADE AI WAIT: ' + sig.base + ' → kısa teyit beklemesi'); return; }
  sig.status = 'AKTIF';
  const r = settings.tradeMode === 'live' ? await liveOpen(sig) : openPaper(sig);
  if (!r || r.error) skipSignal(sig, 'SKIP', 'açılamadı: ' + ((r && r.error) || 'bilinmeyen'));
  else log('OTOTRADE GİRİŞ: ' + sig.base + ' ' + sig.dir + ' | ' + (sig.executionEntry || sig.entry) + ' | ' + (settings.tradeMode === 'live' ? 'CANLI' : 'PAPER'));
}
function reconcilePending() {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status === 'KAPALI') continue;
    if (!sig.waitExpiresAt) sig.waitExpiresAt = sig.createdAt + (sig.module === 'AUTO' ? 60e3 : 30 * M1);
    if (['BEKLE', 'AI_BEKLIYOR', 'AI_HATA'].includes(sig.status) && now > sig.waitExpiresAt) {
      skipSignal(sig, sig.module === 'AUTO' ? 'AI_TIMEOUT' : 'DOLMADI', 'bekleme süresi doldu');
      continue;
    }
    if (sig.module === 'AUTO' && sig.status === 'BEKLE' && now >= (sig.nextAiRetryAt || 0) && !AI_STATE.busy) {
      sig.status = 'AI_BEKLIYOR';
      queueAI(sig);
      continue;
    }
    if (sig.module === 'AUTO' && sig.status === 'AI_BEKLIYOR' && now - sig.createdAt > 90e3) skipSignal(sig, 'AI_TIMEOUT', 'toplam AI bekleme süresi doldu');
  }
}
function queueAI(sig) {
  if (!sig || sig.status === 'KAPALI') return;
  if (!aiReady()) return;
  if (AI_STATE.currentId === sig.id || AI_QUEUE.some(x => x.id === sig.id)) return;
  AI_QUEUE.push({ id: sig.id, at: Date.now() });
  if (AI_QUEUE.length > 20) AI_QUEUE.shift();
  runAIQueue();
}
async function runAIQueue() {
  if (AI_STATE.busy) return;
  AI_STATE.busy = true;
  try {
    while (AI_QUEUE.length) {
      const job = AI_QUEUE.shift();
      const sig = signals.find(s => s.id === job.id);
      if (!sig || sig.status === 'KAPALI') continue;
      AI_STATE.currentId = sig.id;
      try { await autoEntryReview(sig); }
      catch (e) { log('AI kuyruk hatası: ' + redact(e.message)); }
      finally { if (AI_STATE.currentId === sig.id) AI_STATE.currentId = null; }
    }
  } finally { AI_STATE.busy = false; dirty = true; }
}
async function aiComment(sig) {
  if (!aiReady()) return { error: 'AI kapalı veya anahtar yok' };
  const cs = await getCandles(sig.symbol, MODS[sig.module].tf, 40, true);
  const i = sig.info || {};
  const prompt = 'SİNYAL DEĞERLENDİRME — ' + sig.base + ' ' + sig.dir + ' (' + MODS[sig.module].label + ')\nPlan: giriş ' + sig.entry + ' | stop ' + sig.sl + ' | TP1 ' + sig.tp1 + ' | TP2 ' + sig.tp2 + '\nDetay: ' + JSON.stringify({ setup: i.setup, tf: i.tf, volRatio: i.volRatio, riskPct: i.riskPct, netRR: i.netRR, level: i.level || i.trigger || i.upper, piyasa: market.dir }) + '\nSon mumlar:\n' + fmtCandles(cs, 8) + '\nYanıt tek JSON: {"decision":"APPROVE|WAIT|REJECT","confidence":0-100,"reason":"kısa Türkçe gerekçe"}';
  try {
    const ai = await callAI([{ role: 'system', content: 'Sen teknik analiz yardımcısısın. Veriye bak, uydurma. Yanıt tek JSON.' }, { role: 'user', content: prompt }], { timeoutMs: 20000, validate: t => !!parseAutoDec(t) });
    const d = parseAutoDec(ai.text);
    if (!d) return { error: 'geçersiz yanıt' };
    sig.ai = Object.assign({}, d, { provider: ai.providerName, model: ai.model, at: ai.at });
    dirty = true;
    return { ok: true, ai: sig.ai };
  } catch (e) { return { error: redact(e.message).slice(0, 200) }; }
}
function aiStatus() {
  const q = aiQuota();
  return {
    enabled: aiReady(), settingsEnabled: settings.aiEnabled === true, keys: aiKeys().length,
    queue: AI_QUEUE.length, busy: !!AI_STATE.busy, lastError: AI_STATE.lastError,
    usage: { dayCount: AI_USAGE.dayCount, hourCount: AI_USAGE.hourCount, dayOk: q.ok },
    providers: AI_PROV.map(p => ({ id: p.id, name: p.name, hasKey: !!p.key, models: p.models, ok: p.ok, fail: p.fail, avgMs: p.lat.length ? Math.round(p.lat.reduce((a, b) => a + b, 0) / p.lat.length) : 0, cooldownSec: Math.max(0, Math.ceil(((p.cooldownUntil || 0) - Date.now()) / 1000)), lastError: p.lastError, dayCount: provDay(p).dayCount, dayLimit: p.dayLimit }))
  };
}
async function aiTest() {
  const out = [];
  for (const p of aiKeys()) {
    const t0 = Date.now();
    try {
      const r = await callProviderModel(p, [{ role: 'user', content: 'Yalnızca şu JSONu döndür: {"ok":true}' }], p.models[0], { timeoutMs: 15000 });
      const j = extractJSON(r.text);
      out.push({ id: p.id, name: p.name, ok: !!(j && j.ok === true), ms: Date.now() - t0, model: r.model });
    } catch (e) { out.push({ id: p.id, name: p.name, ok: false, error: redact(e.message).slice(0, 160) }); }
  }
  return { providers: out };
}

/* ── API ─────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const h = String(req.headers.authorization || '');
  if (h === 'Bearer ' + API_TOKEN) return next();
  return res.status(401).json({ error: 'API token gerekli (ALPHASON_API_TOKEN)' });
}
app.use('/api', auth);

function byModuleStats() {
  return ACTIVE_MODULES.map(m => {
    const list = signals.filter(s => s.module === m);
    const done = list.filter(s => s.status === 'KAPALI' && TRADE_RESULTS.has(s.result) && Number.isFinite(Number(s.netR)));
    const wins = done.filter(s => Number(s.netR) > 0);
    return {
      module: m, label: MODS[m].label, total: list.length,
      open: list.filter(isOpenSignal).length,
      closed: done.length, wins: wins.length, losses: done.length - wins.length,
      winRate: done.length ? +(wins.length / done.length * 100).toFixed(1) : 0,
      netR: +sum(done.map(s => Number(s.netR) || 0)).toFixed(2),
      skipped: list.filter(s => SKIP_RESULTS.has(s.result)).length
    };
  });
}
function stateView() {
  const bm = {};
  for (const s of signals) if (isOpenSignal(s)) bm[s.module] = (bm[s.module] || 0) + 1;
  return {
    version: VERSION, at: Date.now(), ready: true,
    settings: paperSettingsView(),
    market,
    modules: Object.fromEntries(ACTIVE_MODULES.map(k => [k, { label: MODS[k].label, tf: MODS[k].tf, tradeable: MODS[k].tradeable }])),
    counts: { active: signals.filter(isOpenSignal).length, byModule: bm, autoOpen: autoOpenCount(), autoMaxOpen: settings.autoMaxOpen, pendingApproval: 0 },
    paper: { summary: paperSummary(), open: paper.open.map(viewPaper) },
    live: { balance: LIVE.balance, summary: liveSummary(), open: LIVE.open.map(viewLivePos), lastError: LIVE.lastError, ipHint: LIVE.ipHint },
    ai: aiStatus(),
    scan: {
      universe: UNIVERSE.length,
      autoAt: lastScan.auto, pumpAt: lastScan.pump, momAt: lastScan.mom, ltAt: lastScan.lt,
      autoWatch: 0, trendWatch: TREND_WATCH.length, brkWatch: BRK_WATCH.length, ltWatch: WATCH.lt.length
    },
    logs: LOGS.slice(-12)
  };
}
function paperSettingsView() {
  return {
    autoTrade: settings.autoTrade, tradeMode: settings.tradeMode, margin: settings.margin, leverage: settings.leverage,
    riskPct: settings.riskPct, autoMaxOpen: settings.autoMaxOpen, dailyLossPct: settings.dailyLossPct, maxOpen: settings.maxOpen,
    aiEnabled: settings.aiEnabled, liveKeys: HAS_KEYS, ltTfs: settings.ltTfs, includeStocks: settings.includeStocks,
    maxSpreadPct: settings.maxSpreadPct, minQuoteVol: settings.minQuoteVol, topN: settings.topN, paperEquity: settings.paperEquity
  };
}
app.get('/api/state', (req, res) => res.json(stateView()));
app.get('/api/logs', (req, res) => res.json({ items: LOGS.slice(-80) }));
app.get('/api/signals', (req, res) => {
  const mod = String(req.query.module || '').toUpperCase();
  const list = signals.filter(s => !mod || s.module === mod).slice().sort((a, b) => b.createdAt - a.createdAt);
  res.json({
    active: list.filter(s => isOpenSignal(s) && s.status !== 'BEKLE').map(viewSignal),
    bekleyen: list.filter(s => s.status === 'BEKLE' || s.status === 'AI_BEKLIYOR').map(viewSignal),
    closed: list.filter(s => s.status === 'KAPALI').slice(0, 30).map(viewSignal)
  });
});
app.get('/api/watch/:kind', (req, res) => {
  const k = req.params.kind;
  if (k === 'lt') return res.json({ items: WATCH.lt, meta: { scannedAt: lastScan.lt, count: WATCH.lt.length } });
  if (k === 'trend') return res.json({ items: TREND_WATCH, meta: { scannedAt: lastScan.pump, count: TREND_WATCH.length } });
  if (k === 'brk') return res.json({ items: BRK_WATCH, meta: { scannedAt: lastScan.mom, count: BRK_WATCH.length } });
  res.json({ items: [], meta: {} });
});
app.get('/api/paper', (req, res) => res.json({ settings: paperSettingsView(), summary: paperSummary(), open: paper.open.map(viewPaper), closed: paper.closed.slice(-30) }));
app.get('/api/rejections', (req, res) => {
  const byCode = {};
  for (const k of Object.keys(REJ_STAT)) byCode[k] = REJ_STAT[k];
  res.json({ items: REJ.slice().reverse().slice(0, 60), byCode });
});
app.get('/api/stats', (req, res) => res.json({ version: VERSION, costPct: EX.COST, modules: byModuleStats(), paper: paperSummary(), live: liveSummary(), reasons: signals.filter(s => s.status === 'KAPALI' && TRADE_RESULTS.has(s.result)).reduce((a, s) => { a[s.result] = (a[s.result] || 0) + 1; return a; }, {}) }));
app.get('/api/ai/status', (req, res) => res.json(aiStatus()));
app.post('/api/ai/toggle', (req, res) => {
  settings.aiEnabled = req.body && req.body.enabled === true;
  dirty = true;
  log('AI ' + (settings.aiEnabled ? 'AÇIK' : 'KAPALI'));
  res.json({ ok: true, enabled: settings.aiEnabled });
});
app.post('/api/ai/reset', (req, res) => {
  for (const p of AI_PROV) { p.cooldownUntil = 0; p.modelCooldowns = {}; p.lastError = null; }
  AI_USAGE.dayCount = 0; AI_USAGE.hourCount = 0;
  AI_STATE.lastError = null;
  dirty = true;
  res.json({ ok: true });
});
app.post('/api/ai/test', async (req, res) => res.json(await aiTest()));
app.post('/api/signal/:id/ai', async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.json({ error: 'sinyal yok' });
  res.json(await aiComment(sig));
});
app.post('/api/signal/:id/close', (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.json({ error: 'sinyal yok' });
  if (sig.status === 'KAPALI') return res.json({ error: 'zaten kapalı' });
  const p = paper.open.find(x => x.sigId === sig.id), lp = LIVE.open.find(x => x.sigId === sig.id);
  if (p) { closePaper(p, priceOf(sig.symbol) || p.livePrice || p.entry, 'MANUEL'); return res.json({ ok: true }); }
  if (lp) { liveClose(lp, priceOf(lp.symbol) || lp.markPrice || lp.entry, 'MANUEL').then(r => res.json(r.error ? { error: r.error } : { ok: true })); return; }
  skipSignal(sig, 'SKIP', 'kullanıcı kapattı');
  res.json({ ok: true });
});
app.post('/api/signal/:id/execute', async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.json({ error: 'sinyal yok' });
  if (sig.module !== 'AUTO') return res.json({ error: 'yalnızca OtoTrade sinyali işlem açar' });
  if (sig.status === 'KAPALI') return res.json({ error: 'sinyal kapalı' });
  if (sig.executionBusy) return res.json({ error: 'işlem sürüyor' });
  sig.executionBusy = true;
  try {
    const r = settings.tradeMode === 'live' ? await liveOpen(sig) : openPaper(sig);
    res.json(r.error ? { error: r.error } : { ok: true });
  } finally { sig.executionBusy = false; }
});
app.post('/api/auto/toggle', (req, res) => {
  settings.autoTrade = !!(req.body && req.body.enabled === true);
  if (!settings.autoTrade) {
    let closed = 0;
    for (const sig of signals) if (sig.module === 'AUTO' && (sig.status === 'AI_BEKLIYOR' || sig.status === 'BEKLE')) { skipSignal(sig, 'SKIP', 'OtoTrade kapatıldı'); closed++; }
    AI_QUEUE.length = 0;
    log('OTOTRADE KAPALI — ' + closed + ' bekleyen sinyal temizlendi');
  } else log('OTOTRADE AÇIK');
  dirty = true;
  res.json({ ok: true, enabled: settings.autoTrade, aiReady: aiReady() });
});
app.post('/api/auto/scan', async (req, res) => { autoScan(false).catch(() => {}); res.json({ ok: true }); });
app.post('/api/paper/settings', (req, res) => {
  const b = req.body || {};
  const cur = Object.assign({}, settings);
  settings = sanitizeSettings(Object.assign({}, settings, b));
  if (settings.paperEquity !== cur.paperEquity && !paper.open.length) { paper.equity = settings.paperEquity; paper.start = settings.paperEquity; paper.dayStart = settings.paperEquity; }
  dirty = true;
  log('Ayarlar kaydedildi');
  res.json({ ok: true, settings: paperSettingsView() });
});
app.post('/api/paper/reset', (req, res) => {
  if (paper.open.length) return res.json({ error: 'açık işlem varken sıfırlanamaz' });
  paper.equity = settings.paperEquity; paper.start = settings.paperEquity; paper.dayStart = settings.paperEquity; paper.peak = settings.paperEquity;
  dirty = true;
  res.json({ ok: true });
});
app.post('/api/trade/mode', (req, res) => {
  const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper';
  if (mode === 'live' && (!HAS_KEYS || !API_TOKEN)) return res.json({ error: 'Canlı mod için Bitget anahtarı + ALPHASON_API_TOKEN gerekli' });
  settings.tradeMode = mode;
  dirty = true;
  log('İşlem modu: ' + mode.toUpperCase());
  res.json({ ok: true, mode });
});
app.post('/api/paper/:id/close', (req, res) => {
  const pos = paper.open.find(p => p.id === req.params.id);
  if (!pos) return res.json({ error: 'pozisyon yok' });
  closePaper(pos, priceOf(pos.symbol) || pos.livePrice || pos.entry, 'MANUEL');
  res.json({ ok: true });
});
app.post('/api/live/sync', async (req, res) => {
  if (!HAS_KEYS) return res.json({ error: 'Bitget anahtarı yok' });
  await fetchLiveBalance(true);
  await fetchLivePositions();
  await syncLive();
  res.json({ ok: !LIVE.lastError, error: LIVE.lastError || null, balance: LIVE.balance });
});
app.post('/api/live/:id/close', async (req, res) => {
  const pos = LIVE.open.find(p => p.id === req.params.id);
  if (!pos) return res.json({ error: 'pozisyon yok' });
  const r = await liveClose(pos, priceOf(pos.symbol) || pos.markPrice || pos.entry, 'MANUEL');
  res.json(r.error ? { error: r.error } : { ok: true });
});
app.get('/api/myip', async (req, res) => {
  try { const r = await fetch('https://api.ipify.org?format=json'); const j = await r.json(); res.json({ ip: j.ip }); }
  catch (e) { res.json({ error: redact(e.message) }); }
});
app.get('/api/live/diag', async (req, res) => {
  const out = { hasKeys: HAS_KEYS, token: !!API_TOKEN };
  if (HAS_KEYS) { const b = await fetchLiveBalance(true); out.balance = b; out.error = LIVE.lastError || null; out.ipHint = LIVE.ipHint; }
  res.json(out);
});
app.get('/api/live/positions', async (req, res) => {
  if (!HAS_KEYS) return res.json({ error: 'Bitget anahtarı yok' });
  const list = await fetchLivePositions();
  res.json({ items: (list || []).filter(p => p && Math.abs(num(p.contracts)) > 0).map(p => ({ symbol: p.symbol, base: baseOf(p.symbol), side: p.side, contracts: p.contracts, markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl })), error: LIVE.lastError });
});
app.get('/api/chart/:id', async (req, res) => {
  const sig = signals.find(s => s.id === req.params.id);
  if (!sig) return res.json({ error: 'sinyal yok' });
  const tf = (sig.info && sig.info.tf) || MODS[sig.module].tf;
  const cs = sig.module === 'LT' ? await getLtCandles(sig.symbol, tf, 400) : await getCandles(sig.symbol, tf, 300, true);
  if (!cs) return res.json({ error: 'mum verisi yok' });
  const cl = closesOf(cs);
  res.json({
    signal: viewSignal(sig), tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c]),
    ema20: emaArr(cl, 20), ema50: emaArr(cl, 50),
    levels: [], tradingview: 'https://www.tradingview.com/chart/?symbol=BITGET:' + encodeURIComponent(sig.base) + 'USDT.P',
    triangle: null
  });
});
app.get('/api/chart', async (req, res) => {
  const sym = String(req.query.symbol || '');
  const tf = String(req.query.tf || '15m');
  if (!sym) return res.json({ error: 'symbol gerekli' });
  const cs = tf === '2h' ? await getLtCandles(sym, '2h', 400) : await getCandles(sym, tf, 300, true);
  if (!cs) return res.json({ error: 'mum verisi yok' });
  const cl = closesOf(cs);
  let triangle = null;
  if (tf === '2h' || tf === '1h') {
    const e = LT_CACHE.get(sym + '|' + tf);
    if (e && e.tri) {
      const tri = e.tri, n = e.cs.length, future = clamp(Math.ceil(tri.apexX) + 10, 12, 90);
      const sample = (upper, from, to) => {
        const pts = [], steps = Math.min(80, Math.max(2, to - from));
        for (let s = 0; s <= steps; s++) {
          const i = Math.round(from + (to - from) * s / steps);
          const t = i < n ? e.cs[Math.max(0, i)].t : e.cs[n - 1].t + (i - n + 1) * (TF_MS[tf] || H2);
          const v = upper ? triUpperAt(tri, i) : triLowerAt(tri, i);
          if (v > 0) pts.push([t, rp(v)]);
        }
        return pts;
      };
      const start = Math.max(0, tri.firstIdx);
      triangle = { upper: sample(true, tri.hiStart, n - 1 + future), lower: sample(false, tri.loStart, n - 1 + future), upperNow: rp(tri.upperNow), lowerNow: rp(tri.lowerNow), apexAt: tri.apexAt, firstIdx: tri.firstIdx, shape: tri.shape };
    }
  }
  res.json({
    signal: { base: baseOf(sym), dir: String(req.query.dir || ''), entry: num(req.query.entry), sl: num(req.query.sl), tp1: num(req.query.tp1), tp2: num(req.query.tp2) },
    tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c]), ema20: emaArr(cl, 20), ema50: emaArr(cl, 50), triangle,
    levels: [], tradingview: 'https://www.tradingview.com/chart/?symbol=BITGET:' + encodeURIComponent(baseOf(sym)) + 'USDT.P'
  });
});
app.get('/api/debug/state', (req, res) => {
  res.json({ ltCache: LT_CACHE.size, universe: UNIVERSE.length, signals: signals.length, queue: AI_QUEUE.length });
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── Döngüler ────────────────────────────────────────────────── */
let loopsStarted = false;
function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;
  const iv = (fn, ms) => setInterval(() => { try { fn(); } catch (e) { log('Döngü hatası: ' + redact(e.message)); } }, ms);
  iv(refreshTickers, 8e3);
  iv(() => { if (!autoScanning) autoScan(true); }, 15e3);
  iv(() => { if (!autoScanning) autoScan(false); }, 60e3);
  iv(() => { if (!pumpScanning) pumpScan(); }, 45e3);
  iv(() => { if (!momScanning) momScan(); }, 45e3);
  iv(() => { if (!ltScanning) ltScan(); }, 5 * M1);
  iv(() => { if (!ltTicking) ltTick(); }, 20e3);
  iv(updateMarket, 5 * M1);
  iv(monitorPaper, 3e3);
  iv(monitorVirtual, 5e3);
  iv(monitorLive, 5e3);
  iv(syncLive, 30e3);
  iv(checkOrphans, 10 * M1);
  iv(reconcilePending, 5e3);
  iv(() => saveState(false), 20e3);
  iv(() => {
    if (paper.dayKey !== dayKey()) { paper.dayKey = dayKey(); paper.dayStart = paper.equity; dirty = true; }
    log('DURUM: piyasa ' + market.dir + ' | açık paper ' + paper.open.length + ' + canlı ' + LIVE.open.length + ' | aktif sinyal ' + signals.filter(isOpenSignal).length + ' | izleme trend ' + TREND_WATCH.length + ' / kırılım ' + BRK_WATCH.length + ' / lt ' + WATCH.lt.length + ' | AI ' + (aiReady() ? 'açık kuyruk ' + AI_QUEUE.length : 'kapalı'));
  }, 60e3);
  setInterval(() => { try { saveState(true); } catch (e) {} }, 120e3).unref();
}

(async function boot() {
  loadState();
  log('AlphaSon ' + VERSION + ' başlıyor — modüller: ' + ACTIVE_MODULES.map(k => MODS[k].label).join(', '));
  log('İşlem modu: ' + settings.tradeMode.toUpperCase() + ' | AI ' + (settings.aiEnabled ? 'AÇIK' : 'KAPALI') + ' | OtoTrade ' + (settings.autoTrade ? 'AÇIK' : 'KAPALI') + ' | Bitget anahtarı ' + (HAS_KEYS ? 'var' : 'YOK'));
  startLoops();
  app.listen(PORT, () => log('Web arayüzü: http://localhost:' + PORT));
  setTimeout(refreshUniverse, 1500);
  setTimeout(updateMarket, 3000);
  setTimeout(() => autoScan(false), 4000);
  setTimeout(() => pumpScan(), 6000);
  setTimeout(() => momScan(), 8000);
  setTimeout(ltScan, 5000);
  setTimeout(() => fetchLiveBalance(false).catch(() => {}), 10000);
})();
