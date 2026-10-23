'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v77.0 — AI ONAYLI ALGOPUMP + TREND & SÜPÜRME SİSTEMİ (GÜNCELLENDİ)
   ───────────────────────────────────────────────────────────────────────────
   • AlgoPump : Matematiksel tarama + AI Giriş/Çıkış Kararı + Oto-Trade
   • Trend    : PSAR & EMA Trend Taraması (Yalnızca Sinyal / Oto-Trade YOK)
   • LT Üçgen : 2h/4h Kırılım + Retest (Manuel / AI Yorumlu)
   • Daily    : 15m PDH/PDL Sweep (Manuel / AI Yorumlu)
   • Model ID'leri güncellendi (Gemini 2.0-flash & Groq Llama 3.1)
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = 'v77.0';
const fs = require('fs');
const path = require('path');
const express = require('express');
const ccxt = require('ccxt');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const F_SIG = path.join(DATA_DIR, 'signals.json');
const F_PAPER = path.join(DATA_DIR, 'paper.json');
const F_SET = path.join(DATA_DIR, 'settings.json');
const F_LTR = path.join(DATA_DIR, 'ltr.json');
const F_AI = path.join(DATA_DIR, 'ai.json');

/* ───────── API & BORSA KİMLİK BİLGİLERİ ───────── */
const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || '';
const IS_LIVE_READY = !!(API_KEY && API_SECRET && API_PASS);

const LIVE_MAX_MARGIN = Number(process.env.LIVE_MAX_MARGIN) || 25;
const LIVE_MAX_LEVERAGE = Number(process.env.LIVE_MAX_LEVERAGE) || 5;
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };

/* ───────── SABİTLER & AYARLAR ───────── */
const COST_PCT = 0.20;
const FEE_SIDE = 0.0006;
const PAPER_SLIP = 0;
const START_BALANCE = 1000;
const M1 = 60000, M3 = 180000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '3m': 20000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend (PSAR)',      max: 99, quota: null, maxAge: 2 * H1,  cooldown: 5 * M1,  chartTf: '5m',  enabled: true },
  SCALPER: { label: 'Scalper',           max: 99, quota: null, maxAge: 4 * H1,  cooldown: 15 * M1, chartTf: '15m', enabled: false },
  LT:      { label: 'LT Üçgen',          max: 99, quota: null, maxAge: 5 * D1,  cooldown: 2 * H1,  chartTf: '4h',  enabled: true },
  ZONE:    { label: 'Zone Master',       max: 99, quota: null, maxAge: 12 * H1, cooldown: 30 * M1, chartTf: '1h',  enabled: false },
  RANGE:   { label: 'Range (Mean Rev.)', max: 99, quota: null, maxAge: 3 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: false },
  PUMP:    { label: 'AlgoPump',          max: 99, quota: null, maxAge: 4 * M1,  cooldown: 1 * M1,  chartTf: '1m',  enabled: true },
  DAILY:   { label: 'Günlük Sweep',       max: 99, quota: null, maxAge: 6 * H1,  cooldown: 2 * H1,  chartTf: '15m', enabled: true, maxPerDaySym: 3 }
};

const REASON = {
  TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'Başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel',
  TPMAX: 'Max hedef', FADE: 'Kâr geri verildi', BAIL: 'Erken kaçış', NOMOVE: 'Hareket yok', MOMENTUM: 'İvme bitti',
  QUICK: 'Vur-kaç kârı', QUICK_TIME: 'Vur-kaç süresi doldu',
  AI_RED: 'AI reddi', AI_ERROR: 'AI yanıt vermedi', AI_TIMEOUT: 'AI zaman aşımı', AI_STALE: 'Fiyat kaydı'
};

/* ───────── ALGOPUMP PARAMETRELERİ (ESNETİLMİŞ) ───────── */
const PUMP = {
  minQuoteVol: 300000,
  maxSpreadPct: 0.25,
  snapKeepMs: 360000,
  barMs: 15000,
  coilBars: 8,
  coilMaxPct: 1.80,
  bodyMin: 0.35,
  dispMinPct: 0.05,
  vel: {
    w: 6000, fastW: 2500,
    minMovePct: 0.08, fastMovePct: 0.05,
    minZ: 1.4,
    minVolRatio: 1.2,
    minHist: 20, minNoiseN: 8,
    minAtrX: 0.5,
    priorMaxPct: 0.80,
    dynamicLateCap: true,
    lateCapFrac: 0.35, lateCapMin: 0.12, lateCapMax: 0.40,
    minEdgeMult: 1.3,
    slBufferPct: 0.03,
    slMin: 0.35, slMax: 1.80, slAtrK: 0.60, slCostK: 1.80
  }
};

const EX = {
  H: 0.20, MIN_NET: 0.05, GB_MIN: 0.25, GB_FRAC: 0.25, LOCK_ARM: 0.50, BE_ARM: 0.30, BE_LOCK: 0.22,
  BAIL_ARM: 0.25, BAIL_BELOW: -0.05, TP_MIN: 0.60, TP_MAX: 2.50, TP_ATR_K: 1.30,
  NO_MOVE: 50, HOLD: 180, DECAY_RATIO: 0.25, DECAY_MIN_PNL: 0.20, MIN_NET_RR: 0.60,
  MIN_SL_PCT: 0.35, SL_ATR_K: 0.60, SL_COST_K: 1.80,
  QUICK_TP_K: 0.50, QUICK_TP_MIN: 0.35, QUICK_TP_MAX: 0.90, QUICK_TIME: 30, QUICK_ARM: 0.10
};

const EPS = 1e-9;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const rp = p => Number(Number(p).toPrecision(7));
const fmtP = p => (p >= 1 ? p.toFixed(4) : p.toPrecision(5));

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}

/* ───────── YARDIMCI VERİ YAPILARI ───────── */
const LOGS = [];
function log(m) {
  let t;
  try { t = new Date().toLocaleTimeString('tr-TR', { hour12: false, timeZone: 'Europe/Istanbul' }); } catch (e) { t = new Date().toISOString().slice(11, 19); }
  const line = '[' + t + '] ' + m;
  console.log(line);
  LOGS.push(line);
  if (LOGS.length > 500) LOGS.shift();
}

function loadJSON(f, def) {
  try {
    if (!fs.existsSync(f)) return def;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : def;
  } catch (e) { return def; }
}
function saveJSON(f, obj) {
  try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); } catch (e) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const closed = (cs, tfMs) => (cs && cs.length && cs[cs.length - 1].t + tfMs > Date.now() ? cs.slice(0, -1) : cs || []);
const toC = a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] || 0 });

/* ───────── İNDİKATÖR FONKSİYONLARI ───────── */
const closes = cs => cs.map(x => x.c);
function emaArr(a, p) {
  const k = 2 / (p + 1), o = new Array(a.length);
  let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function atrArr(cs, p) {
  p = p || 14;
  const o = new Array(cs.length).fill(null);
  if (cs.length < p + 1) return o;
  const tr = i => Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  let s = 0;
  for (let i = 1; i <= p; i++) s += tr(i);
  let a = s / p; o[p] = a;
  for (let i = p + 1; i < cs.length; i++) { a = (a * (p - 1) + tr(i)) / p; o[i] = a; }
  return o;
}
function atrLast(cs, p) { const a = atrArr(cs, p || 14); return a[a.length - 1]; }

function calcPSAR(cs, step, max) {
  step = step || 0.02; max = max || 0.2;
  const n = cs.length, out = new Array(n).fill(null);
  if (n < 3) return out;
  let up = cs[1].c >= cs[0].c, af = step;
  let sar = up ? cs[0].l : cs[0].h, ep = up ? cs[0].h : cs[0].l;
  out[0] = { sar, up };
  for (let i = 1; i < n; i++) {
    let ns = sar + af * (ep - sar);
    if (up) {
      ns = Math.min(ns, cs[i - 1].l, i > 1 ? cs[i - 2].l : cs[i - 1].l);
      if (cs[i].l < ns) { up = false; ns = ep; ep = cs[i].l; af = step; }
      else if (cs[i].h > ep) { ep = cs[i].h; af = Math.min(af + step, max); }
    } else {
      ns = Math.max(ns, cs[i - 1].h, i > 1 ? cs[i - 2].h : cs[i - 1].h);
      if (cs[i].h > ns) { up = true; ns = ep; ep = cs[i].h; af = step; }
      else if (cs[i].l < ep) { ep = cs[i].l; af = Math.min(af + step, max); }
    }
    sar = ns;
    out[i] = { sar, up };
  }
  return out;
}

function williamsR(cs, p) {
  p = p || 14;
  if (cs.length < p) return null;
  const w = cs.slice(-p);
  const hh = Math.max.apply(null, w.map(c => c.h)), ll = Math.min.apply(null, w.map(c => c.l));
  if (hh === ll) return -50;
  return (hh - cs[cs.length - 1].c) / (hh - ll) * -100;
}

/* ───────── DEDEKTÖRLER ───────── */
function detectPSAR(cs) {
  const n = cs.length;
  if (n < 60) return null;
  const ps = calcPSAR(cs, 0.02, 0.2), m = n - 1;
  if (!ps[m] || !ps[m - 1]) return null;
  if (ps[m].up === ps[m - 1].up) return null;
  const dir = ps[m].up ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1;
  const wr = williamsR(cs, 14);
  if (wr == null) return null;
  const cl = closes(cs), e34 = emaArr(cl, 34), last = cs[m];
  if (dir === 'LONG' ? !(last.c > e34[m]) : !(last.c < e34[m])) return null;
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c;
  let risk = clamp(Math.abs(e - ps[m].sar), 0.8 * atr, 3.0 * atr);
  const riskPct = risk / e * 100;
  if (riskPct > 4.0) return null;
  const tp1 = e + d * 1.5 * risk;
  const q = rrNet(e, e - d * risk, tp1);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(tp1), tp2: rp(e + d * 2.5 * risk), single: false,
    conf: clamp(Math.round(60 + Math.abs(wr + 50) / 5), 40, 90),
    info: { psar: rp(ps[m].sar), ema34: rp(e34[m]), atr, riskPct: +riskPct.toFixed(2), netRR: q.net }
  };
}

/* ───────── GÜNLÜK SWEEP DEDEKTÖRÜ ───────── */
function detectDailySweep(cs, lv) {
  if (!cs || cs.length < 20 || !lv) return null;
  const n = cs.length, last = cs[n - 1];
  const atr = atrLast(cs, 14);
  if (!(atr > 0)) return null;
  const rng = last.h - last.l;
  if (!(rng > 0)) return null;

  const below = last.l < lv.pdl && last.c > lv.pdl;
  const above = last.h > lv.pdh && last.c < lv.pdh;
  if (below === above) return null;
  const dir = below ? 'LONG' : 'SHORT', d = below ? 1 : -1;
  const level = below ? lv.pdl : lv.pdh;
  const wick = below ? lv.pdl - last.l : last.h - lv.pdh;

  let sl = below ? last.l - 0.2 * atr : last.h + 0.2 * atr;
  const e = last.c;
  const risk = Math.abs(e - sl);
  const riskPct = risk / e * 100;
  const tp1 = e + d * 1.5 * risk;
  const q = rrNet(e, sl, tp1);

  return {
    dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(e + d * 2.5 * risk), single: false,
    conf: clamp(Math.round(65 + (wick / atr) * 10), 40, 95),
    info: { pdh: rp(lv.pdh), pdl: rp(lv.pdl), sweepSide: below ? 'PDL' : 'PDH', atr, riskPct: +riskPct.toFixed(2), netRR: q.net }
  };
}

/* ───────── DURUM & DEĞİŞKENLER ───────── */
let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: 0, liveDayStart: 0 };
const DEF_SET = { auto: false, tradeMode: 'paper', margin: 100, leverage: 5, minConf: 55, maxMinutes: 5, riskPct: 0.5, maxOpen: 8, dailyLossPct: 0, pumpQuick: true, aiEnabled: true };
let settings = Object.assign({}, DEF_SET);
const market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, btc: null, eth: null, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [], daily: [] };
const DAILY_LEVELS = new Map();
let marketBrief = null;
let dirty = false;
let ALL = [], TOP = [];
const TICK = {};
const CACHE = new Map();
const jobs = {};

/* ───────── AI SAĞLAYICI HAVUZU & GÜNCELLENMİŞ MODEL YÖNETİMİ ───────── */
const AI = {
  modules: ['PUMP', 'LT', 'DAILY', 'TREND'],
  maxPerDay: Number(process.env.AI_MAX_PER_DAY) || 150,
  maxPerHour: Number(process.env.AI_MAX_PER_HOUR) || 50,
  timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 20000,
  pumpMinScore: Number(process.env.AI_PUMP_MIN_SCORE) || 68,
  pumpWaitMs: Number(process.env.AI_PUMP_WAIT_MS) || 20000,
  providers: [
    { id: 'gemini', name: 'Gemini Flash', key: process.env.GEMINI_API_KEY || '', base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash', fallbackModel: 'gemini-1.5-flash', headers: {}, cooldownUntil: 0 },
    { id: 'groq', name: 'Groq Llama', key: process.env.GROQ_API_KEY || '', base: 'https://api.groq.com/openai/v1/chat/completions', model: process.env.GROQ_MODEL || 'llama-3.1-70b-versatile', fallbackModel: 'llama-3.1-8b-instant', headers: {}, cooldownUntil: 0 },
    { id: 'openrouter', name: 'OpenRouter', key: process.env.OPENROUTER_API_KEY || '', base: 'https://openrouter.ai/api/v1/chat/completions', model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', fallbackModel: null, headers: {}, cooldownUntil: 0 },
    { id: 'github', name: 'GitHub Models', key: process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '', base: 'https://models.github.ai/inference/chat/completions', model: 'openai/gpt-4o-mini', fallbackModel: null, headers: {}, cooldownUntil: 0 },
    { id: 'cerebras', name: 'Cerebras', key: process.env.CEREBRAS_API_KEY || '', base: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama3.3-70b', fallbackModel: null, headers: {}, cooldownUntil: 0 }
  ]
};

let aiUsage = { day: '', dayCount: 0, hourKey: 0, hourCount: 0, total: 0, lastAt: 0, lastError: null, lastProvider: null };
const AI_QUEUE = [];
let aiBusy = false;

function aiKeys() { return AI.providers.filter(p => p.key); }
function aiReady() { return !!(settings.aiEnabled !== false && aiKeys().length > 0); }

function aiQuota() {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), hk = Math.floor(now / H1);
  if (aiUsage.day !== day) { aiUsage.day = day; aiUsage.dayCount = 0; }
  if (aiUsage.hourKey !== hk) { aiUsage.hourKey = hk; aiUsage.hourCount = 0; }
  return { ok: aiUsage.dayCount < AI.maxPerDay && aiUsage.hourCount < AI.maxPerHour };
}

function aiCount(provider) {
  if (!aiQuota().ok) return false;
  aiUsage.dayCount++; aiUsage.hourCount++; aiUsage.total++; aiUsage.lastAt = Date.now(); aiUsage.lastProvider = provider ? provider.id : null;
  saveJSON(F_AI, aiUsage); return true;
}

/* ───────── SİNYAL VE YAZILIM YÖNETİMİ ───────── */
function isOpenSignal(s) { return !!s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR'); }

function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = sym.split('/')[0];
  if (signals.some(s => s.module === mod && s.symbol === sym && (isOpenSignal(s) || (s.dir === dir && t - (s.closedAt || s.createdAt) < M.cooldown)))) return false;

  const pumpGate = mod === 'PUMP' ? { state: 'PENDING', queuedAt: t, expiresAt: t + AI.pumpWaitMs } : null;

  const sig = {
    id: 'S' + (++sigSeq), module: mod, symbol: sym, base, dir,
    entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single,
    conf: raw.conf, info: raw.info || {}, status: pumpGate ? 'AI_BEKLIYOR' : 'AKTIF', result: null, aiGate: pumpGate,
    createdAt: t, maxAgeMs: raw.maxAgeMs || M.maxAge,
    quickTpPct: raw.quickTpPct, quickTimeSec: raw.quickTimeSec, quickArmPct: raw.quickArmPct
  };

  sig.analysis = analyzeSignal(sig);
  signals.push(sig);
  dirty = true;
  log('SİNYAL OLUŞTU: ' + M.label + ' | ' + base + ' | ' + dir + ' | Güven: ' + sig.conf + (pumpGate ? ' | AI ONAYI BEKLENİYOR' : ''));

  if (mod === 'PUMP') {
    if (aiReady()) queueAI(sig);
    else declinePumpAI(sig, 'AI_ERROR', 'AI sistemi aktif değil');
  } else if (AI.modules.includes(mod)) {
    queueAI(sig);
  }
  return true;
}

function closeSignal(s, price, reason) {
  if (s.status === 'KAPALI') return;
  s.status = 'KAPALI'; s.result = reason; s.exit = rp(price); s.closedAt = Date.now();
  dirty = true;
  log('SİNYAL KAPANDI: ' + MODS[s.module].label + ' ' + s.base + ' ' + s.dir + ' → ' + (REASON[reason] || reason));
}

/* ───────── SADE VE YALIN KURAL TABANLI ANALİZ ───────── */
function analyzeSignal(sig) {
  const mod = sig.module, dir = sig.dir, price = sig.entry;
  const rr = sig.sl > 0 ? Math.abs(sig.tp1 - price) / Math.abs(price - sig.sl) : 1;
  const verdict = sig.conf >= 70 ? 'ONY' : sig.conf >= 55 ? 'TEMKINLI' : 'RED';
  
  const summary = `${MODS[mod].label} ${dir} sinyali. Giriş: ${fmtP(price)}, Stop: ${fmtP(sig.sl)}, TP1: ${fmtP(sig.tp1)}. Net R:R ${rr.toFixed(2)}.`;
  const decision = verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ';

  return { verdict, decision, score: sig.conf, summary, at: Date.now() };
}

/* ───────── AI İSTEK VE ÇAĞRI MOTORU ───────── */
function parseAIJSON(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(raw.slice(a, b + 1));
      return {
        verdict: j.verdict || 'TEMKINLI',
        score: clamp(Number(j.score) || 50, 0, 100),
        entryDecision: j.entryDecision === 'APPROVE' ? 'APPROVE' : 'REJECT',
        simpleDecision: j.entryDecision === 'APPROVE' ? 'GİRİLİR' : 'GİRİLMEZ',
        summary: String(j.summary || '').slice(0, 500),
        stopLossPct: Number(j.stopLossPct) || null,
        takeProfitPct: Number(j.takeProfitPct) || null,
        maxHoldSec: Number(j.maxHoldSec) || null
      };
    } catch (e) {}
  }
  return { verdict: 'TEMKINLI', score: 50, entryDecision: 'REJECT', simpleDecision: 'GİRİLMEZ', summary: raw.slice(0, 300) };
}

async function callProviderModel(p, messages, model) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI.timeoutMs);
  const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, p.headers || {});
  try {
    const res = await fetch(p.base, {
      method: 'POST', headers, signal: ctl.signal,
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 600 })
    });
    const txt = await res.text();
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ': ' + txt.slice(0, 200));
      err.status = res.status;
      throw err;
    }
    const j = JSON.parse(txt);
    const content = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    return { text: content, model };
  } finally { clearTimeout(timer); }
}

async function aiReview(sig) {
  if (!sig || !aiReady()) return null;
  const sys = 'Sen AlphaSon trading asistanısın. Gelen sinyali analiz et ve kararı basit Türkçe ile açıkla. Jargon kullanma. Sadece JSON döndür.';
  const user = `Coin: ${sig.symbol}, Modül: ${sig.module}, Yön: ${sig.dir}, Fiyat: ${sig.entry}, SL: ${sig.sl}, TP1: ${sig.tp1}, Güven Skoru: ${sig.conf}.
JSON Formatı: {"verdict":"ONY|TEMKINLI|RED","score":0-100,"entryDecision":"APPROVE|REJECT","summary":"Basit Türkçe açıklama (Girilir veya Girilmez desin)"}`;

  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];

  for (const p of AI.providers) {
    if (!p.key || p.cooldownUntil > Date.now()) continue;
    if (!aiCount(p)) break;
    
    // Model ve fallback modelleri sırayla dene
    const modelsToTry = [p.model];
    if (p.fallbackModel) modelsToTry.push(p.fallbackModel);

    for (const m of modelsToTry) {
      try {
        const r = await callProviderModel(p, messages, m);
        const parsed = parseAIJSON(r.text);
        sig.ai = Object.assign(parsed, { provider: p.id, model: m, at: Date.now() });
        log(`AI Yorumu (${sig.base} - ${m}): ${parsed.simpleDecision} (${parsed.score}/100)`);
        return finalizePumpAIApproval(sig, sig.ai);
      } catch (e) {
        log(`AI Hata (${p.name} / ${m}): ${e.message}`);
        // Eğer 404 ise diğer modele geç, diğer hatalarda provider cooldown yapabilir
        if (e.status !== 404) {
          p.cooldownUntil = Date.now() + 180000;
          break; 
        }
      }
    }
  }
  return finalizePumpAIApproval(sig, null);
}

function declinePumpAI(sig, reason, note) {
  if (!sig || sig.module !== 'PUMP' || sig.status !== 'AI_BEKLIYOR') return false;
  sig.status = 'KAPALI'; sig.result = reason; sig.closedAt = Date.now();
  sig.aiGate = { state: 'REJECTED', reason, note: note || '', decidedAt: Date.now() };
  dirty = true;
  log('ALGOPUMP AI REDDİ: ' + sig.base + ' → ' + (note || reason));
  return true;
}

function finalizePumpAIApproval(sig, ai) {
  if (!sig || sig.module !== 'PUMP' || !sig.aiGate || sig.aiGate.state !== 'PENDING') return ai;
  if (!ai || ai.entryDecision !== 'APPROVE' || ai.score < AI.pumpMinScore) {
    declinePumpAI(sig, 'AI_RED', ai ? `AI Skoru Yetersiz (${ai.score})` : 'AI Yanıt Vermedi');
    return null;
  }
  sig.status = 'AKTIF';
  sig.aiGate = { state: 'APPROVED', decidedAt: Date.now(), score: ai.score };
  dirty = true;
  log('ALGOPUMP AI ONAYLADI (İŞLEM AÇILIYOR): ' + sig.base + ' | Skor: ' + ai.score);
  maybeOpenPaper(sig);
  return ai;
}

function queueAI(sig) {
  if (!sig || AI_QUEUE.some(x => x.id === sig.id)) return;
  AI_QUEUE.push({ id: sig.id });
  runAIQueue();
}

async function runAIQueue() {
  if (aiBusy) return;
  aiBusy = true;
  try {
    while (AI_QUEUE.length) {
      const item = AI_QUEUE.shift();
      const sig = signals.find(s => s.id === item.id);
      if (sig) await aiReview(sig);
    }
  } finally { aiBusy = false; }
}

/* ───────── PAPER & CANLI POZİSYON İŞLEMLERİ ───────── */
async function maybeOpenPaper(sig) {
  /* Oto-Trade sadece AlgoPump için geçerlidir */
  if (!sig || sig.module !== 'PUMP' || !sig.aiGate || sig.aiGate.state !== 'APPROVED') return;
  if (!settings.auto) return;
  if (paper.open.some(p => p.symbol === sig.symbol)) return;

  const entry = sig.entry;
  const margin = Math.min(settings.margin, paper.balance);
  const lev = settings.leverage;

  const p = {
    id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, dir: sig.dir,
    entry, sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, isLive: false,
    margin, leverage: lev, notional: margin * lev, openedAt: Date.now(), status: 'ACIK'
  };

  paper.open.push(p);
  dirty = true;
  log('OTOMATİK İŞLEM AÇILDI (PUMP): ' + p.base + ' ' + p.dir + ' | Fiyat: ' + entry);
}

/* ───────── VERİ TABANI VE BORSA DÖNGÜSÜ ───────── */
const ex = new ccxt.bitget({ apiKey: API_KEY, secret: API_SECRET, password: API_PASS, enableRateLimit: true, options: { defaultType: 'swap' } });

async function refreshTickers() {
  try {
    const t = await ex.fetchTickers();
    for (const k in t) { if (t[k] && t[k].last && k.endsWith('/USDT:USDT')) TICK[k] = t[k]; }
  } catch (e) {}
}

async function refreshUniverse() {
  await refreshTickers();
  const list = [];
  for (const k in ex.markets) {
    if (ex.markets[k] && ex.markets[k].swap && ex.markets[k].quote === 'USDT' && TICK[ex.markets[k].symbol]) {
      list.push(ex.markets[k].symbol);
    }
  }
  ALL = list;
  TOP = list.slice(0, 100);
}

async function getC(sym, tf, limit) {
  try {
    const raw = await ex.fetchOHLCV(sym, tf, undefined, limit);
    return raw ? raw.map(toC) : null;
  } catch (e) { return null; }
}

/* ───────── TARAMA DÖNGÜLERİ ───────── */
async function scanTrend() {
  if (!MODS.TREND.enabled) return;
  for (const sym of TOP.slice(0, 40)) {
    const cs = await getC(sym, '5m', 80);
    if (!cs || cs.length < 50) continue;
    const det = detectPSAR(cs);
    if (det) emitSignal('TREND', sym, det);
  }
}

async function scanDaily() {
  if (!MODS.DAILY.enabled) return;
  for (const sym of TOP.slice(0, 40)) {
    const cs = await getC(sym, '15m', 80);
    if (!cs || cs.length < 40) continue;
    const d1 = await getC(sym, '1d', 5);
    if (!d1 || d1.length < 2) continue;
    const lv = { pdh: d1[d1.length - 2].h, pdl: d1[d1.length - 2].l };
    const det = detectDailySweep(cs, lv);
    if (det) emitSignal('DAILY', sym, det);
  }
}

function emitSignal(mod, sym, det) {
  addSignal(Object.assign({ module: mod, symbol: sym }, det));
}

/* ───────── EXPRESS API SUNUCUSU ───────── */
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send(`<h2>AlphaSon ${VERSION} Sunucusu Aktif</h2>`));
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));

app.get('/api/state', (req, res) => {
  res.json({
    version: VERSION,
    settings,
    signalsCount: signals.length,
    activeSignals: signals.filter(isOpenSignal),
    openPositions: paper.open,
    aiStatus: { enabled: aiReady(), quota: aiQuota() }
  });
});

app.post('/api/paper/toggle', (req, res) => {
  settings.auto = !settings.auto;
  saveJSON(F_SET, settings);
  log('OTO-TRADE ' + (settings.auto ? 'AÇILDI' : 'KAPATILDI'));
  res.json({ ok: true, auto: settings.auto });
});

/* ───────── SİSTEMİ BAŞLATMA ───────── */
async function start() {
  log(`AlphaSon ${VERSION} Başlatılıyor...`);
  try {
    await ex.loadMarkets();
    await refreshUniverse();
    log('Borsa bağlantısı başarılı. Taranan coin sayısı: ' + TOP.length);
  } catch (e) {
    log('Borsa bağlantı hatası: ' + e.message);
  }

  setInterval(refreshTickers, 5000);
  setInterval(scanTrend, 60000);
  setInterval(scanDaily, 120000);

  app.listen(PORT, () => log('Sunucu ' + PORT + ' portunda aktif.'));
}

start();
