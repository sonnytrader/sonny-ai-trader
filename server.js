'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v81.0 — AI Opportunity Engine
   PUMP · LT · TREND · DAILY · SCALPER · RANGE · ZONE
   ───────────────────────────────────────────────────────────────────────────
   v81.0 (v80.1'e göre):
     - DeepSeek sağlayıcısı (DEEPSEEK_API_KEY).
     - Modüle özel AI prompt + geniş JSON şema (phase/evidence/missingConditions/...).
     - LT WATCH otomatik AI (top 5 yakın coin, tıklama gerekmiyor).
     - RECENT_REJ diske (rejections.json), yeniden başlatma sonrası korunur.
     - Eleme kayıtlarına phase/nextCondition/aiVerdict.
     - Sağlayıcı sıralaması ölçülen başarı + gecikme.
     - AI puanı tek başına sinyal üretmiyor.
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = 'v81.0';
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
const F_REJ = path.join(DATA_DIR, 'rejections.json');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || '';
const IS_LIVE_READY = !!(API_KEY && API_SECRET && API_PASS);
const LIVE_MAX_MARGIN = Number(process.env.LIVE_MAX_MARGIN) || 25;
const LIVE_MAX_LEVERAGE = Number(process.env.LIVE_MAX_LEVERAGE) || 5;
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };

const COST_PCT = 0.20;
const FEE_SIDE = 0.0006;
const PAPER_SLIP = 0;
const START_BALANCE = 1000;
const M1 = 60000, M3 = 180000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '3m': 20000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend (Pullback)',  max: 99, quota: null, maxAge: 8 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: true },
  SCALPER: { label: 'Scalper',           max: 99, quota: null, maxAge: 4 * H1,  cooldown: 15 * M1, chartTf: '15m', enabled: false },
  LT:      { label: 'LT Üçgen',          max: 99, quota: null, maxAge: 5 * D1,  cooldown: 6 * H1,  chartTf: '4h',  enabled: true },
  ZONE:    { label: 'Zone Master',       max: 99, quota: null, maxAge: 12 * H1, cooldown: 30 * M1, chartTf: '1h',  enabled: false },
  RANGE:   { label: 'Range (Mean Rev.)', max: 99, quota: null, maxAge: 3 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: false },
  PUMP:    { label: 'AlgoScalp (3-5dk)', max: 99, quota: null, maxAge: 20 * M1, cooldown: 10 * M1, chartTf: '5m',  enabled: true },
  DAILY:   { label: 'Günlük Sweep',      max: 99, quota: null, maxAge: 6 * H1,  cooldown: 4 * H1,  chartTf: '15m', enabled: false, maxPerDaySym: 3 }
};
const REASON = {
  TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'TP1 sonrası başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel kapatma',
  TPMAX: 'Maksimum hedef', FADE: 'Kâr geri verildi', BAIL: 'Erken kaçış', NOMOVE: 'Hareket yok', MOMENTUM: 'İvme bitti (AI/net kârda)',
  QUICK: 'Vur-kaç kârı', QUICK_TIME: 'Vur-kaç süresi doldu',
  AI_RED: 'AI giriş reddi', AI_ERROR: 'AI yanıtı yok', AI_TIMEOUT: 'AI onayı zaman aşımı', AI_STALE: 'AI sonrası fiyat değişti',
  APPROVAL_EXPIRED: 'Operatör onayı verilmedi'
};

const PUMP = {
  minQuoteVol: 400000, maxSpreadPct: 0.25, snapKeepMs: 360000,
  pre30: 0.30, pre60: 0.45, pre150: 0.80, maxCand: 10, recheckMs: 2000,
  barMs: 15000, coilBars: 10, coilMaxPct: 2.00, bodyMin: 0.35, dispMinPct: 0.07, minElapsedMs: 3000,
  m1: { minMovePct: 0.60, minVolX: 3.0, minAtrX: 2.2, maxMovePct: 4.5, hold: 120, noMove: 40 },
  m3: { minMovePct: 1.00, minVolX: 2.5, minAtrX: 2.2, maxMovePct: 6.5, hold: 180, noMove: 45 },
  posMin: 0.55, priorMaxFrac: 0.40, priorVolMax: 2.5, maxExt15Pct: 8,
  slBodyFrac: 0.5, slMin: 0.50, slMax: 1.30, tpMaxPct: 1.6,
  macroFilter: true, useCandlePath: false, useIgnition: process.env.PUMP_IGNITION === '1',
  vel: {
    w: 6000, fastW: 2500, minMovePct: 0.10, fastMovePct: 0.07, minZ: 1.5, minVolRatio: 1.5,
    minHist: 24, minNoiseN: 10, minAtrX: 0.8, priorMaxPct: 0.80, maxLatePct: 0.25,
    dynamicLateCap: true, lateCapFrac: 0.30, lateCapMin: 0.10, lateCapMax: 0.40,
    minEdgeMult: 1.5, minNetRR: 0.90, slBufferPct: 0.04, slMin: 0.50, slMax: 1.30, slAtrK: 0.80, slCostK: 2.50,
    maxCand: 10, recheckMs: 2500
  }
};

const SCALPX = {
  enabled: true, scanMs: 25000, topN: 60, tfs: ['3m', '5m'],
  minQuoteVol: 1500000, maxSpreadPct: 0.15,
  brkBars: 12, minBodyFrac: 0.50, minVolX: 1.5, minBodyAtr: 0.7, maxExtAtr: 2.8, maxRunAtr: 3.0, maxCounterWick: 0.35,
  minAtrPct: 0.12, maxAtrPct: 2.5,
  tp1K: 0.55, tp1Min: 0.40, tp1Max: 0.80, tp2Mult: 2.2,
  slMin: 0.50, slMax: 1.20,
  maxLagMs: { '3m': 50000, '5m': 70000 },
  holdMs: { '3m': 9 * M1, '5m': 15 * M1 },
  maxDriftAtr: 0.35
};

const EX = {
  H: 0.20, MIN_NET: 0.10, GB_MIN: 0.30, GB_FRAC: 0.30,
  LOCK_ARM: 0.60, BE_ARM: 0.40, BE_LOCK: 0.22, BAIL_ARM: 0.35, BAIL_BELOW: -0.02,
  TP_MIN: 0.90, TP_MAX: 1.80, TP_ATR_K: 1.45, NO_MOVE: 40, HOLD: 120,
  DECAY_RATIO: 0.30, DECAY_MIN_PNL: 0.25, MIN_NET_RR: 1.05,
  VEL_WIN_MS: 2000, VEL_PEAK_MEMORY_MS: 12000,
  MIN_SL_PCT: 0.50, SL_ATR_K: 0.80, SL_COST_K: 2.50,
  QUICK_TP_K: 0.55, QUICK_TP_MIN: 0.40, QUICK_TP_MAX: 0.70,
  QUICK_TIME: 20, QUICK_ARM: 0.15, MOM_ARM: 0.28
};

const SCALP = { minVolX: 2.0, maxDistPct: 1.2, maxDistAtrK: 0.80, minRiskPct: 0.80, minNetRR: 1.0, minConf: 65, tp1R: 1.5, tp2R: 2.5, pivL: 3, pivR: 3, lookback: 70 };
const REVERT = { bbP: 20, bbK: 2, adxMax: 25, minVolX: 1.5, wickMin: 0.5, limitAtr: 0.15, stopAtr: 0.3, minRiskPct: 0.50, maxRiskPct: 3, minRR: 1.0, minNetRR: 1.0, minConf: 60 };
const PSAR = { step: 0.02, max: 0.2, adxMin: 14, emaP: 34, wrP: 14, wrBand: 10, tp1R: 1.5, tp2R: 3, minRiskPct: 0.60, maxRiskPct: 4.5, minNetRR: 0.75, maxExtAtr: 4.0, minVolX: 0.40, flipLookback: 3 };
const DAILY = {
  topN: 80, scanEvery: 2 * M1, minConf: 40, sessionStart: 0, lastEntryHour: 22, sessionEnd: 23, minRemainMs: 10 * M1,
  minWickAtr: 0.04, minWickRatio: 0.03, minBodyRatio: 0.12, minClosePos: 0.30, minVolX: 0.50, maxSpreadPct: 0.30, minRiskPct: 0.50, maxRiskPct: 4.5,
  stopAtr: 0.25, minDayRangePct: 0.40, maxDayRangePct: 25.0, tp1R: 1.5, tp2R: 2.5, tp1MidMinR: 0.50, minNetRR: 0.60, minReclaimAtr: 0.0,
  maxAge: 6 * H1, maxSignalsPerDay: 3, firstSweepOnly: false, sweepLookback: 20, repeatPenalty: 3, requireAlign: false
};

const SECT = {
  L1: 'BTC ETH SOL ADA AVAX DOT ATOM NEAR APT SUI SEI TON TRX XRP BNB LTC BCH ETC ALGO XLM HBAR ICP FTM S KAS EGLD XTZ EOS NEO FLOW MINA KAVA ONE CELO ZIL VET IOTA THETA XMR DASH ZEC'.split(' '),
  L2: 'ARB OP MATIC POL STRK MANTA METIS IMX ZK BLAST MNT ZRO TAIKO SCR LRC'.split(' '),
  MEME: 'DOGE SHIB PEPE WIF BONK FLOKI MEME TURBO BOME NEIRO POPCAT MEW PNUT GOAT ACT MOODENG FARTCOIN TRUMP'.split(' '),
  AI: 'FET AGIX OCEAN RNDR RENDER TAO WLD ARKM AI16Z VIRTUAL GRASS AIXBT GRIFFAIN IO NMR AKT PHB'.split(' '),
  DEFI: 'UNI AAVE MKR CRV SNX COMP LDO SUSHI 1INCH DYDX GMX PENDLE JUP RUNE CAKE ENA ETHFI YFI BAL JTO RAY ONDO SSV LQTY CVX'.split(' '),
  GAMING: 'AXS SAND MANA GALA ENJ APE ILV PIXEL PORTAL BEAM YGG GMT RON MAGIC PRIME'.split(' '),
  ORACLE_INFRA: 'LINK GRT BAND API3 PYTH AR STORJ FIL W ANKR QNT CHZ'.split(' '),
  EXCHANGE: 'OKB BGB CRO KCS GT FTT LEO HT'.split(' ')
};
const SEC_OF = {};
Object.keys(SECT).forEach(k => SECT[k].forEach(b => { SEC_OF[b] = k; }));
const baseOf = sym => String(sym).split('/')[0];
const normBase = b => String(b).replace(/^(1000000|100000|10000|1000|1M)/, '');
const sectorOf = b => SEC_OF[normBase(b)] || 'DİĞER';

const TOKENIZED = new Set((
  'XAU XAG XPT XPD XAUT PAXG WTI BRENT OIL NATGAS COPPER ' +
  'SPY QQQ TQQQ SQQQ IWM DIA VOO VTI ARKK SOXL SOXS SOXX SMH DRAM SNXX ' +
  'TSLA NVDA AAPL MSFT AMZN GOOGL GOOG META NFLX AMD INTC MU SNDK SKHYNIX HYNIX SAMSUNG TSM TSMC ASML AVGO QCOM ' +
  'COIN MSTR HOOD CRCL PLTR BABA PYPL SHOP UBER ORCL CRM ADBE DIS NIO GME AMC LITE DELL SMCI ' +
  (process.env.EXCLUDE_EXTRA || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean).join(' ')
).split(/\s+/).filter(Boolean));
const ALLOW_TOKENIZED = process.env.ALLOW_TOKENIZED === '1';
const isTokenized = base => TOKENIZED.has(String(base).toUpperCase()) || TOKENIZED.has(normBase(base).toUpperCase());

const LOGS = [];
function log(m) {
  let t;
  try { t = new Date().toLocaleTimeString('tr-TR', { hour12: false, timeZone: 'Europe/Istanbul' }); } catch (e) { t = new Date().toISOString().slice(11, 19); }
  const line = '[' + t + '] ' + m;
  console.log(line);
  LOGS.push(line);
  if (LOGS.length > 400) LOGS.shift();
}

/* v81.0 — Diske kalıcı eleme kayıtları */
const RECENT_REJ = [];
const LAST_REJ_BY_SYM = new Map();
let rejDirty = false;
function loadRej() {
  try {
    const j = loadJSON(F_REJ, []);
    if (Array.isArray(j)) {
      const now = Date.now();
      for (const r of j) if (r && now - r.t < 2 * H1) RECENT_REJ.push(r);
      if (RECENT_REJ.length > 200) RECENT_REJ.length = 200;
      for (const r of RECENT_REJ) LAST_REJ_BY_SYM.set(r.module + ':' + r.base, { t: r.t, reason: r.reason });
    }
  } catch (e) { /* yoksay */ }
}
function saveRej() {
  if (!rejDirty) return;
  rejDirty = false;
  saveJSON(F_REJ, RECENT_REJ.slice(0, 200));
}
function logRejSym(mod, sym, reason, info, phase, nextCond, aiVerdict) {
  const base = String(sym || '').split('/')[0].toUpperCase();
  if (!base || !reason) return;
  const key = mod + ':' + base, now = Date.now();
  const prev = LAST_REJ_BY_SYM.get(key);
  if (prev && prev.reason === reason && now - prev.t < 90000) return;
  LAST_REJ_BY_SYM.set(key, { t: now, reason });
  RECENT_REJ.unshift({ t: now, module: mod, base, reason, phase: phase || null, nextCondition: nextCond || null, aiVerdict: aiVerdict || null, info: info || {} });
  if (RECENT_REJ.length > 200) RECENT_REJ.length = 200;
  rejDirty = true;
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const rp = p => Number(Number(p).toPrecision(7));
const fmtP = p => (p >= 1 ? p.toFixed(4) : p.toPrecision(5));
const dayStartMs = () => Math.floor(Date.now() / D1) * D1;
const toC = a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] || 0 });
const closed = (cs, tfMs) => (cs && cs.length && cs[cs.length - 1].t + tfMs > Date.now() ? cs.slice(0, -1) : cs || []);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJSON(f, def) {
  try {
    if (!fs.existsSync(f)) return def;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : def;
  } catch (e) { log('UYARI: ' + path.basename(f) + ' okunamadı (' + e.message + ')'); return def; }
}
function saveJSON(f, obj) {
  try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); }
  catch (e) { log('HATA: ' + path.basename(f) + ' kaydedilemedi: ' + e.message); }
}
async function fetchJSON(url, ms) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), ms || 8000);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  const w = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { res[k] = await fn(items[k], k); } catch (e) { res[k] = null; } }
  });
  await Promise.all(w); return res;
}
function every(name, ms, fn, delay) {
  let run = false;
  const tick = async () => { if (run) return; run = true; try { await fn(); } catch (e) { log('HATA [' + name + ']: ' + e.message); } finally { run = false; } };
  setTimeout(() => { tick(); setInterval(tick, ms); }, delay || 0);
}

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
function rsiLast(cl, p) {
  p = p || 14;
  if (cl.length < p + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function adxLast(cs, p) {
  p = p || 14;
  const n = cs.length;
  if (n < p * 2 + 2) return null;
  let trS = 0, pS = 0, mS = 0;
  const dx = [];
  for (let i = 1; i < n; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i <= p) { trS += tr; pS += pdm; mS += mdm; } else { trS = trS - trS / p + tr; pS = pS - pS / p + pdm; mS = mS - mS / p + mdm; }
    if (i >= p && trS > 0) { const pdi = 100 * pS / trS, mdi = 100 * mS / trS, sm = pdi + mdi; dx.push(sm === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sm); }
  }
  if (dx.length < p) return null;
  let adx = avg(dx.slice(0, p));
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
}
function bbwArr(cl, p) {
  p = p || 20;
  const o = new Array(cl.length).fill(null);
  for (let i = p - 1; i < cl.length; i++) {
    let m = 0;
    for (let j = i - p + 1; j <= i; j++) m += cl[j];
    m /= p;
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += (cl[j] - m) * (cl[j] - m);
    o[i] = m ? 4 * Math.sqrt(v / p) / m : null;
  }
  return o;
}
function pivots(cs, L, R, from, to) {
  const hi = [], lo = [];
  const a = Math.max(L, from != null ? from : L), b = Math.min(cs.length - 1 - R, to != null ? to : cs.length - 1 - R);
  for (let i = a; i <= b; i++) {
    let h = true, l = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (cs[j].h > cs[i].h) h = false;
      if (cs[j].l < cs[i].l) l = false;
      if (!h && !l) break;
    }
    if (h) hi.push({ i, p: cs[i].h });
    if (l) lo.push({ i, p: cs[i].l });
  }
  return { hi, lo };
}
function linFit(pts) {
  const n = pts.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const q of pts) { sx += q.i; sy += q.p; sxy += q.i * q.p; sxx += q.i * q.i; }
  const den = n * sxx - sx * sx;
  const a = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  return { a, b: (sy - a * sx) / n };
}
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
function aggTF(cs, m) {
  const ms = m * 60000, out = [];
  let cur = null;
  for (const c of cs) {
    const b = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== b) { cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  return out;
}

/* ── Trade mathematics ── */
function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}
const EPS = 1e-9;
function assertInvariants() {
  const e = [];
  const worstFadeNet = EX.LOCK_ARM - EX.GB_MIN - EX.H;
  if (EX.GB_MIN < EX.H + EX.MIN_NET - EPS) e.push('GB_MIN < H + MIN_NET');
  if (worstFadeNet < EX.MIN_NET - EPS) e.push('LOCK_ARM çok düşük');
  if (!(EX.GB_FRAC < 1)) e.push('GB_FRAC >= 1');
  if (!(EX.LOCK_ARM > EX.BE_ARM)) e.push('LOCK_ARM > BE_ARM');
  if (!(EX.TP_MIN > EX.H + EX.MIN_NET)) e.push('TP_MIN > H + MIN_NET');
  if (EX.DECAY_MIN_PNL < EX.H + 0.05 - EPS) e.push('DECAY_MIN_PNL');
  if (!(EX.BE_LOCK > EX.H)) e.push('BE_LOCK > H');
  if (SCALPX.tp1Min < EX.H + 0.10 - EPS) e.push('SCALPX.tp1Min');
  if (e.length) throw new Error('Invariant: ' + e.join(', '));
  return { H: EX.H, worstFadeNet: +worstFadeNet.toFixed(3), costCoverNet: +(EX.BE_LOCK - EX.H).toFixed(3) };
}

function stepTrade(t, c) {
  const L = t.dir === 'LONG';
  if (!(t.tp1Hit && c.t <= t.tp1Ts)) {
    const slHit = L ? c.l <= t.curSl : c.h >= t.curSl;
    if (slHit) return { done: true, price: t.curSl, reason: t.tp1Hit ? 'BE' : 'SL' };
  }
  if (!t.tp1Hit) {
    if (L ? c.h >= t.tp1 : c.l <= t.tp1) {
      if (t.single || !t.tp2) return { done: true, price: t.tp1, reason: 'TP1' };
      const d = L ? 1 : -1;
      t.tp1Hit = true; t.tp1Ts = c.t;
      t.curSl = t.entry * (1 + d * EX.BE_LOCK / 100);
      return { done: false, event: 'TP1' };
    }
  } else if (t.tp2 && (L ? c.h >= t.tp2 : c.l <= t.tp2)) return { done: true, price: t.tp2, reason: 'TP2' };
  return null;
}
function calcR(t, exitPrice) {
  const risk = Math.abs(t.entry - t.sl);
  if (!(risk > 0)) return { gross: 0, net: 0 };
  const d = t.dir === 'LONG' ? 1 : -1;
  const rOf = p => (p - t.entry) * d / risk;
  const gross = t.tp1Hit && !t.single ? 0.5 * rOf(t.tp1) + 0.5 * rOf(exitPrice) : rOf(exitPrice);
  const cost = t.costPct != null ? t.costPct : COST_PCT;
  return { gross, net: gross - (t.entry * cost / 100) / risk };
}

/* ── Detection functions ── */
function detectBurst(cs, tfMs, now, why) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 45) return null;
  const P = tfMs === M1 ? PUMP.m1 : PUMP.m3, L = cs[n - 1];
  const forming = now != null && now < L.t + tfMs;
  const elapsed = forming ? Math.max(now - L.t, 0) : tfMs;
  if (forming && elapsed < PUMP.minElapsedMs) return no('mum çok yeni');
  const price = L.c, body = L.c - L.o;
  if (!(L.o > 0) || body === 0) return no('hareket yok');
  const dir = body > 0 ? 'LONG' : 'SHORT', d = body > 0 ? 1 : -1;
  const movePct = Math.abs(body) / L.o * 100;
  if (movePct < P.minMovePct) return no('hareket küçük');
  if (movePct > P.maxMovePct) return no('aşırı uzamış');
  const atr = atrLast(cs.slice(0, n - 1), 14);
  if (!atr) return null;
  const moveAtr = Math.abs(body) / atr;
  if (moveAtr < P.minAtrX) return no('itme zayıf');
  const volBase = avg(cs.slice(n - 31, n - 1).map(c => c.v));
  if (!(volBase > 0)) return no('hacim yok');
  const frac = Math.max(elapsed / tfMs, 0.25);
  const volX = (L.v / frac) / volBase;
  if (volX < P.minVolX) return no('hacim zayıf');
  const rng = L.h - L.l;
  if (!(rng > 0)) return no('aralık yok');
  const pos = d > 0 ? (L.c - L.l) / rng : (L.h - L.c) / rng;
  if (pos < PUMP.posMin) return no('geri çekilmiş');
  const prior = cs.slice(n - 4, n - 1);
  const priorDir = prior.reduce((s, c) => s + (c.c - c.o) * d / c.o * 100, 0);
  if (priorDir > PUMP.priorMaxFrac * movePct) return no('ilk patlama değil');
  if (Math.max.apply(null, prior.map(c => c.v)) > PUMP.priorVolMax * volBase) return no('hacim önceden patlamış');
  if (Math.abs(price / cs[n - 16].o - 1) * 100 > PUMP.maxExt15Pct) return no('aşırı uzamış');
  const atrPct = atr > 0 && L.c > 0 ? atr / L.c * 100 : 0;
  let slPct = Math.max(clamp(PUMP.slBodyFrac * movePct, PUMP.slMin, PUMP.slMax), EX.SL_ATR_K * atrPct, EX.SL_COST_K * EX.H);
  slPct = Math.min(slPct, PUMP.slMax);
  const tpPct = Math.max(PUMP.tpMaxPct, clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX));
  const q = rrNet(price, price * (1 - d * slPct / 100), price * (1 + d * tpPct / 100));
  if (q.risk < EX.MIN_SL_PCT || q.net < EX.MIN_NET_RR) return no('net R:R düşük');
  const quiet = clamp((1 - priorDir / Math.max(0.01, PUMP.priorMaxFrac * movePct)) * 4, 0, 4);
  const conf = 55 + clamp((volX - P.minVolX) * 2.5, 0, 15) + clamp((moveAtr - P.minAtrX) * 3, 0, 12) + clamp((pos - PUMP.posMin) * 20, 0, 6) + quiet;
  return {
    dir, entry: rp(price), sl: rp(price * (1 - d * slPct / 100)), tp1: rp(price * (1 + d * tpPct / 100)), tp2: null, single: true,
    conf: clamp(Math.round(conf), 40, 95), holdSec: P.hold, noMoveSec: P.noMove, maxAgeMs: (P.hold + 30) * 1000,
    info: { tf: tfMs === M1 ? '1m' : '3m', forming, movePct: +movePct.toFixed(2), volRatio: +volX.toFixed(1), atrX: +moveAtr.toFixed(1), closePos: +pos.toFixed(2), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2), atr }
  };
}

function detectScalper(cs, why) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 80) return null;
  const last = cs[n - 1];
  const rng = last.h - last.l, body = Math.abs(last.c - last.o);
  if (!(rng > 0) || body <= 0.5 * rng) return no('gövde zayıf');
  const dir = last.c > last.o ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1;
  const pv = pivots(cs, SCALP.pivL, SCALP.pivR, n - SCALP.lookback);
  const list = dir === 'LONG' ? pv.hi : pv.lo;
  if (!list.length) return no('pivot yok');
  const piv = list[list.length - 1], level = piv.p;
  if (dir === 'LONG' ? !(last.c > level) : !(last.c < level)) return no('kırılım yok');
  for (let k = piv.i + 1; k <= n - 2; k++) if (dir === 'LONG' ? cs[k].c > level : cs[k].c < level) return no('kırılım eski');
  const prev = cs.slice(n - 21, n - 1);
  const vSma = avg(prev.map(c => c.v));
  if (!(vSma > 0)) return no('hacim yok');
  const vr = last.v / vSma;
  if (vr < SCALP.minVolX) return no('hacim zayıf');
  const e = last.c, atr = atrLast(cs, 14);
  if (!atr) return null;
  const atrPct = atr / e * 100;
  const distPct = Math.abs(e - level) / level * 100;
  const distCap = Math.min(SCALP.maxDistPct, SCALP.maxDistAtrK * atrPct);
  if (distPct > distCap) return no('seviyeden uzak');
  let risk = Math.abs(e - (level - d * 0.5 * atr));
  risk = Math.max(risk, e * SCALP.minRiskPct / 100, e * EX.SL_COST_K * EX.H / 100);
  if (risk > e * 0.05) return no('risk büyük');
  const tp1 = e + d * SCALP.tp1R * risk;
  const q = rrNet(e, e - d * risk, tp1);
  if (q.net < SCALP.minNetRR) return no('net R:R düşük');
  const closePos = (dir === 'LONG' ? e - last.l : last.h - e) / rng;
  const conf = 55 + clamp((vr - SCALP.minVolX) * 5, 0, 12) + clamp((body / rng - 0.5) * 20, 0, 8) + clamp((1 - distPct / Math.max(distCap, 0.01)) * 5, 0, 5) + (closePos > 0.8 ? 4 : 0) - (rng > 3 * atr ? 8 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(e + d * SCALP.tp1R * risk), tp2: rp(e + d * SCALP.tp2R * risk), single: false,
    conf: clamp(Math.round(conf), 40, 92),
    info: { bos: true, level: rp(level), distPct: +distPct.toFixed(2), volRatio: +vr.toFixed(1), bodyRatio: +(body / rng).toFixed(2), atr, riskPct: +(risk / e * 100).toFixed(2) }
  };
}

function regimeOf(cs) {
  const n = cs.length, adx = adxLast(cs, 14);
  const bb = bbwArr(closes(cs), 20), now = bb[n - 1], prev = bb[n - 6];
  const expanding = now != null && prev != null && prev > 0 && now > 1.3 * prev;
  const regime = adx == null ? 'BELIRSIZ' : adx < 25 ? 'RANGE' : adx < 30 ? 'MIX' : 'TREND';
  return { regime, adx, expanding };
}
function bandsOf(cs) {
  const P = REVERT.bbP, w = closes(cs).slice(-P), mid = avg(w);
  let v = 0;
  for (const x of w) v += (x - mid) * (x - mid);
  const sd = Math.sqrt(v / P);
  return { mid, sd, up: mid + REVERT.bbK * sd, lo: mid - REVERT.bbK * sd };
}
function detectRevert(cs, why, adxMax) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 80) return null;
  adxMax = adxMax != null ? adxMax : REVERT.adxMax;
  const rg = regimeOf(cs);
  if (rg.adx == null) return null;
  if (rg.adx >= adxMax) return no('trend rejimi');
  if (rg.expanding) return no('bant genişliyor');
  const last = cs[n - 1], { mid, sd, up, lo } = bandsOf(cs), rng = last.h - last.l;
  if (!(rng > 0) || !(sd > 0)) return no('aralık yok');
  let dir = null;
  if (last.l < lo && last.c > lo) dir = 'LONG';
  else if (last.h > up && last.c < up) dir = 'SHORT';
  if (!dir) return no('bant reddi yok');
  const d = dir === 'LONG' ? 1 : -1;
  const wick = (dir === 'LONG' ? Math.min(last.o, last.c) - last.l : last.h - Math.max(last.o, last.c)) / rng;
  if (wick < REVERT.wickMin) return no('fitil zayıf');
  const prev = cs.slice(n - 21, n - 1), vSma = avg(prev.map(c => c.v));
  if (!(vSma > 0)) return no('hacim yok');
  const vr = last.v / vSma;
  if (vr < REVERT.minVolX) return no('hacim zayıf');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c, extreme = dir === 'LONG' ? last.l : last.h;
  let sl = extreme - d * REVERT.stopAtr * atr;
  const riskFloor = Math.max(REVERT.minRiskPct, EX.SL_COST_K * EX.H);
  if (Math.abs(e - sl) / e * 100 < riskFloor) sl = e - d * e * riskFloor / 100;
  const risk = Math.abs(e - sl), gain = (mid - e) * d;
  if (!(gain > 0)) return no('hedef ters');
  const riskPct = risk / e * 100;
  if (riskPct > REVERT.maxRiskPct) return no('risk büyük');
  const q = rrNet(e, sl, mid);
  if (q.net < REVERT.minNetRR) return no('net R:R düşük');
  const rr = q.rr;
  const tp2 = mid + d * 0.5 * Math.abs((dir === 'LONG' ? up : lo) - mid);
  const better = e - d * REVERT.limitAtr * atr;
  const conf = 56 + clamp((vr - REVERT.minVolX) * 6, 0, 10) + clamp((wick - REVERT.wickMin) * 20, 0, 8) + clamp((rr - REVERT.minRR) * 5, 0, 8) + (rg.adx < 18 ? 4 : 0);
  return {
    dir, entry: rp(e), sl: rp(sl), tp1: rp(mid), tp2: rp(tp2), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { regime: rg.regime, adx: +rg.adx.toFixed(1), band: { lo: rp(lo), mid: rp(mid), up: rp(up) }, wickRatio: +wick.toFixed(2), volRatio: +vr.toFixed(1), gainPct: +(gain / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), rr: +rr.toFixed(2), betterEntry: rp(better), atr }
  };
}

function detectPSAR(cs, why) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 100) return null;
  const ps = calcPSAR(cs, PSAR.step, PSAR.max), m = n - 1;
  if (!ps[m] || !ps[m - 1] || !ps[m - 2]) return null;
  const flipNow = ps[m].up !== ps[m - 1].up;
  const flipPrev = !flipNow && ps[m - 1].up !== ps[m - 2].up && ps[m].up === ps[m - 1].up;
  if (!flipNow && !flipPrev) return no('PSAR dönüşü yok');
  const dir = ps[m].up ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1;
  const adx = adxLast(cs, 14);
  if (adx == null || adx < PSAR.adxMin) return no('ADX düşük');
  const wr = williamsR(cs, PSAR.wrP);
  if (wr == null) return null;
  if (dir === 'LONG' ? !(wr > -50 - PSAR.wrBand) : !(wr < -50 + PSAR.wrBand)) return no('Williams uyumsuz');
  const cl = closes(cs), e34 = emaArr(cl, PSAR.emaP), last = cs[m];
  if (dir === 'LONG' ? !(last.c > e34[m]) : !(last.c < e34[m])) return no('EMA34 ters');
  const vSma = avg(cs.slice(m - 20, m).map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0;
  if (!(vr >= PSAR.minVolX)) return no('hacim zayıf');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c;
  if (Math.abs(e - e34[m]) > PSAR.maxExtAtr * atr) return no('EMA34 çok uzak');
  let risk = clamp(Math.abs(e - ps[m].sar), 1.2 * atr, 2.5 * atr);
  risk = Math.max(risk, e * PSAR.minRiskPct / 100, e * EX.SL_COST_K * EX.H / 100);
  const riskPct = risk / e * 100;
  if (riskPct > PSAR.maxRiskPct) return no('risk büyük');
  const tp1 = e + d * PSAR.tp1R * risk;
  const q = rrNet(e, e - d * risk, tp1);
  if (q.net < PSAR.minNetRR) return no('net R:R düşük');
  const conf = 55 + clamp((adx - PSAR.adxMin) * 0.8, 0, 12) + clamp(Math.abs(wr + 50) / 50 * 10, 0, 8) + (vr >= 1.2 ? 5 : 0) - (flipPrev ? 3 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(tp1), tp2: rp(e + d * PSAR.tp2R * risk), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { adx: +adx.toFixed(1), williamsR: +wr.toFixed(1), psar: rp(ps[m].sar), ema34: rp(e34[m]), volRatio: +vr.toFixed(1), atr, atrPct: +(atr / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), netRR: q.net, flipAge: flipNow ? 0 : 1 }
  };
}

function anchorLine(pts, up, tol) {
  tol = tol || 0.004;
  if (pts.length < 2) return null;
  const order = pts.slice().sort((x, y) => (up ? y.p - x.p : x.p - y.p));
  for (const a of order.slice(0, 4)) {
    const later = pts.filter(q => q.i > a.i);
    let best = null;
    for (const b of later) {
      const sl = (b.p - a.p) / (b.i - a.i);
      let ok = true, touches = 0;
      for (const q of later) { const lp = a.p + sl * (q.i - a.i), dv = (q.p - lp) / lp; if (up ? dv > tol : dv < -tol) { ok = false; break; } if (Math.abs(dv) <= tol) touches++; }
      if (!ok) continue;
      if (!best || touches > best.touches || (touches === best.touches && b.i > best.b.i)) best = { a, b, sl, touches };
    }
    if (best) return { a: best.a, sl: best.sl, touches: best.touches + 1 };
  }
  return null;
}
function analyzeTriangle(cs, loose) {
  if (cs.length < 60) return null;
  const w = cs.slice(-120), m = w.length - 1, px = w[m].c;
  const pv = pivots(w, 4, 4);
  const tolA = loose ? 0.007 : undefined;
  const Uc = anchorLine(pv.hi, true, tolA), Lc = anchorLine(pv.lo, false, tolA);
  if (!Uc || !Lc) return null;
  const U = x => Uc.a.p + Uc.sl * (x - Uc.a.i), L = x => Lc.a.p + Lc.sl * (x - Lc.a.i);
  if (Lc.sl <= Uc.sl) return null;
  const x0 = Math.max(Uc.a.i, Lc.a.i);
  if (m - x0 < (loose ? 10 : 15)) return null;
  const w0 = U(x0) - L(x0), wN = U(m) - L(m);
  if (w0 <= 0 || wN <= 0) return null;
  const comp = wN / w0;
  if (comp >= (loose ? 0.88 : 0.75)) return null;
  const xA = x0 + w0 / (Lc.sl - Uc.sl);
  const mat = (m - x0) / (xA - x0);
  if (mat < (loose ? 0.25 : 0.4) || mat > (loose ? 1.2 : 1.0)) return null;
  return { w, m, U, L, x0, ua: Uc.a.i, la: Lc.a.i, w0, wN, comp, mat, px, uN: U(m), lN: L(m) };
}
function detectLT(cs, cs1d) {
  const A = analyzeTriangle(cs);
  if (!A) return {};
  const { w, m, U, L } = A, last = w[m], prev = w[m - 1], step = last.t - prev.t;
  const vSma = avg(w.slice(m - 20, m).map(c => c.v));
  const vr = vSma > 0 ? last.v / vSma : 0;
  const lines = {
    upper: [{ t: w[A.ua].t, p: rp(U(A.ua)) }, { t: last.t, p: rp(A.uN) }, { t: last.t + 12 * step, p: rp(U(m + 12)) }],
    lower: [{ t: w[A.la].t, p: rp(L(A.la)) }, { t: last.t, p: rp(A.lN) }, { t: last.t + 12 * step, p: rp(L(m + 12)) }]
  };
  let dir = null;
  if (last.c > A.uN * 1.003 && prev.c <= U(m - 1) * 1.003) dir = 'LONG';
  else if (last.c < A.lN * 0.997 && prev.c >= L(m - 1) * 0.997) dir = 'SHORT';
  if (!dir) {
    const distU = (A.uN / A.px - 1) * 100, distL = (A.px / A.lN - 1) * 100;
    const near = Math.min(Math.abs(distU), Math.abs(distL));
    if (A.mat > 0.5 && near < 2.5) return { watch: { upper: rp(A.uN), lower: rp(A.lN), price: rp(A.px), compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2), nearSide: Math.abs(distU) < Math.abs(distL) ? 'ÜST' : 'ALT', lines } };
    return {};
  }
  if (vr < 1.2) return {};
  const d = dir === 'LONG' ? 1 : -1, e = last.c, H = A.w0, mid = (A.uN + A.lN) / 2;
  let sl = mid;
  const minR = Math.max(0.60, EX.SL_COST_K * EX.H);
  if (Math.abs(e - sl) < e * minR / 100 || (e - sl) * d <= 0) sl = e - d * e * minR / 100;
  if (Math.abs(e - sl) / e * 100 > 5) return {};
  const tp1 = e + d * 0.6 * H;
  const q = rrNet(e, sl, tp1);
  if (q.net < 1.0) return {};
  let conf = 55 + clamp((vr - 1.2) * 8, 0, 15) + (A.mat >= 0.6 && A.mat <= 0.9 ? 8 : 0) + clamp((0.75 - A.comp) * 25, 0, 8);
  let d1 = null;
  if (cs1d && cs1d.length >= 30) {
    const ec = emaArr(closes(cs1d), 20), s1 = ec[ec.length - 1] - ec[ec.length - 4];
    d1 = (dir === 'LONG' && s1 > 0) || (dir === 'SHORT' && s1 < 0);
    conf += d1 ? 8 : -8;
  }
  const atr = atrLast(w, 14);
  const line0 = dir === 'LONG' ? A.uN : A.lN;
  const lineSlope = dir === 'LONG' ? (U(m) - U(m - 1)) : (L(m) - L(m - 1));
  const atrPct = atr && e > 0 ? atr / e * 100 : 0;
  const extPct = dir === 'LONG' ? (last.h / line0 - 1) * 100 : (line0 / last.l - 1) * 100;
  return {
    signal: {
      dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(e + d * H), single: false, conf: clamp(Math.round(conf), 40, 92),
      info: { compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), volRatio: +vr.toFixed(1), height: rp(H), d1Confirm: d1, atr, atrPct: +atrPct.toFixed(2), netRR: q.net, riskPct: q.risk, lines, line0: rp(line0), lineSlope: +lineSlope.toPrecision(10), lineStep: step, lineT: last.t, mid: rp(mid), extPct: +extPct.toFixed(2) }
    }
  };
}

const dayKeyOf = t => new Date(t).toISOString().slice(0, 10);
const dayStartOf = t => Math.floor(t / D1) * D1;
function detectDailySweep(cs, lv) {
  if (!cs || cs.length < 40 || !lv) return null;
  if (!(lv.pdh > 0) || !(lv.pdl > 0) || !(lv.pdh > lv.pdl)) return null;
  const n = cs.length, last = cs[n - 1];
  const dayKey = dayKeyOf(last.t);
  if (lv.dayKey && lv.dayKey !== dayKey) return null;
  const hour = new Date(last.t).getUTCHours();
  if (hour < DAILY.sessionStart || hour > DAILY.lastEntryHour) return null;
  const dayStart = dayStartOf(last.t), sessionEnd = dayStart + DAILY.sessionEnd * H1;
  const signalAt = last.t + M15;
  const remain = sessionEnd - signalAt;
  if (remain < DAILY.minRemainMs) return null;
  const atr = atrLast(cs, 14);
  if (!(atr > 0)) return null;
  const rng = last.h - last.l, body = Math.abs(last.c - last.o);
  if (!(rng > 0) || !(body > 0)) return null;
  const below = last.l < lv.pdl && last.c > lv.pdl;
  const above = last.h > lv.pdh && last.c < lv.pdh;
  if (below === above) return null;
  const dir = below ? 'LONG' : 'SHORT', d = below ? 1 : -1;
  const level = below ? lv.pdl : lv.pdh;
  const wick = below ? lv.pdl - last.l : last.h - lv.pdh;
  if (!(wick >= DAILY.minWickAtr * atr)) return null;
  if (wick / rng < DAILY.minWickRatio) return null;
  if (body / rng < DAILY.minBodyRatio) return null;
  const closePos = below ? (last.c - last.l) / rng : (last.h - last.c) / rng;
  if (closePos < DAILY.minClosePos) return null;
  const reclaim = (last.c - level) * d;
  if (!(reclaim >= DAILY.minReclaimAtr * atr)) return null;
  const prev = cs.slice(n - 21, n - 1), vSma = avg(prev.map(c => c.v));
  if (!(vSma > 0)) return null;
  const vr = last.v / vSma;
  if (!(vr >= DAILY.minVolX)) return null;
  const dayRangePct = (lv.pdh - lv.pdl) / lv.pdl * 100;
  if (dayRangePct < DAILY.minDayRangePct || dayRangePct > DAILY.maxDayRangePct) return null;
  let sweptBefore = 0;
  for (let i = Math.max(0, n - 1 - DAILY.sweepLookback); i < n - 1; i++) {
    if (cs[i].t < dayStart) continue;
    if (below ? cs[i].l < lv.pdl : cs[i].h > lv.pdh) sweptBefore++;
  }
  if (DAILY.firstSweepOnly && sweptBefore > 0) return null;
  let sl = below ? last.l - DAILY.stopAtr * atr : last.h + DAILY.stopAtr * atr;
  const minRisk = last.c * DAILY.minRiskPct / 100;
  if (Math.abs(last.c - sl) < minRisk) sl = last.c - d * minRisk;
  const risk = Math.abs(last.c - sl);
  const riskPct = risk / last.c * 100;
  if (riskPct > DAILY.maxRiskPct) return null;
  const e = last.c;
  const midGain = (lv.dayMid - e) * d;
  const midNet = midGain > 0 ? rrNet(e, sl, lv.dayMid).net : -1;
  let tp1 = midGain > 0 && midNet >= DAILY.tp1MidMinR ? lv.dayMid : e + d * DAILY.tp1R * risk;
  const tp1Gain = Math.abs(tp1 - e);
  const opp = below ? lv.pdh : lv.pdl;
  const oppGain = (opp - e) * d;
  let tp2 = oppGain > tp1Gain + 0.4 * risk && rrNet(e, sl, opp).net >= 1.5 ? opp : e + d * DAILY.tp2R * risk;
  if ((tp2 - tp1) * d <= 0) tp2 = tp1 + d * Math.max(0.5 * risk, (e + d * DAILY.tp2R * risk - tp1) * d);
  const q = rrNet(e, sl, tp1);
  if (q.net < DAILY.minNetRR) return null;
  const tp1Mid = Math.abs(tp1 - lv.dayMid) < 1e-9;
  let conf = 55;
  conf += clamp((wick / atr - DAILY.minWickAtr) * 25, 0, 10);
  conf += clamp((vr - DAILY.minVolX) * 8, 0, 10);
  conf += clamp((body / rng - DAILY.minBodyRatio) * 25, 0, 10);
  conf += clamp((closePos - DAILY.minClosePos) * 22, 0, 5);
  conf += clamp((dayRangePct - DAILY.minDayRangePct) * 1.5, 0, 5);
  const counter = market.dir !== 'NOTR' && market.dir !== dir;
  if (market.dir === dir) conf += 5;
  else if (counter) conf -= 6;
  if (sweptBefore) conf -= DAILY.repeatPenalty;
  const maxBars = Math.min(Math.ceil(DAILY.maxAge / M15), Math.max(1, Math.floor(remain / M15)));
  return {
    dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false,
    conf: clamp(Math.round(conf), 40, 95), maxAgeMs: Math.min(DAILY.maxAge, remain), maxBars, atrPct: +(atr / e * 100).toFixed(2),
    info: { tf: '15m', pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid), level: rp(level), sweepSide: below ? 'PDL' : 'PDH', dayKey, wickAtr: +(wick / atr).toFixed(2), wickRatio: +(wick / rng).toFixed(2), bodyRatio: +(body / rng).toFixed(2), closePos: +closePos.toFixed(2), reclaimAtr: +(reclaim / atr).toFixed(2), volRatio: +vr.toFixed(1), dayRangePct: +dayRangePct.toFixed(2), sweptBefore, tp1Mid, atr, atrPct: +(atr / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), netRR: q.net, session: '00:00–23:00 UTC', sessionEnd: new Date(sessionEnd).toISOString(), maxBars }
  };
}
function dailyWatch(cs, lv) {
  if (!cs || !cs.length || !lv || !(lv.pdh > 0) || !(lv.pdl > 0)) return null;
  const last = cs[cs.length - 1], atr = atrLast(cs, 14), price = last.c;
  if (!(atr > 0) || !(price > 0)) return null;
  const distPdh = (lv.pdh / price - 1) * 100, distPdl = (price / lv.pdl - 1) * 100;
  const near = Math.min(Math.abs(distPdh), Math.abs(distPdl));
  if (near > Math.max(1.5, 1.5 * (atr / price * 100))) return null;
  return { symbol: null, price: rp(price), pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid), distPdh: +distPdh.toFixed(2), distPdl: +distPdl.toFixed(2), nearSide: Math.abs(distPdh) < Math.abs(distPdl) ? 'PDH' : 'PDL', dayRangePct: +((lv.pdh - lv.pdl) / lv.pdl * 100).toFixed(2) };
}
function buildDailyMap(cs1d) {
  const m = new Map();
  for (const d of cs1d || []) { const dayKey = dayKeyOf(d.t + D1); m.set(dayKey, { pdh: d.h, pdl: d.l, dayMid: (d.h + d.l) / 2, dayKey, candleT: d.t }); }
  return m;
}
function buildZones(c1h, c4h) {
  const pts = [];
  const add = (cs, L, wt) => {
    const pv = pivots(cs, L, L);
    for (const q of pv.hi.concat(pv.lo)) {
      let s = 0, k = 0;
      for (let j = Math.max(0, q.i - 20); j < q.i; j++) { s += cs[j].v; k++; }
      pts.push({ p: q.p, t: cs[q.i].t, vr: k && s > 0 ? cs[q.i].v / (s / k) : 1, w: wt });
    }
  };
  add(c1h.slice(-250), 4, 1);
  if (c4h && c4h.length > 20) add(c4h.slice(-120), 3, 2);
  pts.sort((a, b) => a.p - b.p);
  const ref = c1h[c1h.length - 1].t, zones = [];
  let cur = null;
  const fin = z => {
    const touches = z.touches, volW = Math.min(3, z.vr / z.n), ageH = (ref - z.lastT) / H1;
    const score = touches * 1.5 + volW - Math.min(2, ageH / 150);
    if (score >= 5) zones.push({ lo: z.min * 0.9985, hi: z.max * 1.0015, mid: (z.min + z.max) / 2, touches, score });
  };
  for (const q of pts) {
    if (cur && q.p <= (cur.sum / cur.n) * 1.004) { cur.max = q.p; cur.sum += q.p; cur.n++; cur.touches += q.w; cur.vr += q.vr; cur.lastT = Math.max(cur.lastT, q.t); }
    else { if (cur) fin(cur); cur = { min: q.p, max: q.p, sum: q.p, n: 1, touches: q.w, vr: q.vr, lastT: q.t }; }
  }
  if (cur) fin(cur);
  return zones;
}
function detectZone(cs, zones) {
  const n = cs.length, out = { signal: null, watch: [] };
  if (n < 60 || !zones || !zones.length) return out;
  const last = cs[n - 1], prev = cs[n - 2], px = last.c, atr = atrLast(cs, 14);
  if (!atr) return out;
  const e50 = emaArr(closes(cs), 50), m = n - 1;
  const slope = (e50[m] - e50[m - 5]) / e50[m] * 100;
  const vSma = avg(cs.slice(n - 21, n - 1).map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0;
  const body = Math.abs(last.c - last.o), upW = last.h - Math.max(last.o, last.c), loW = Math.min(last.o, last.c) - last.l;
  let best = null;
  for (const z of zones) {
    const dist = px >= z.lo && px <= z.hi ? 0 : Math.min(Math.abs(px - z.hi), Math.abs(px - z.lo)) / px * 100;
    if (dist < 1.2) out.watch.push({ lo: rp(z.lo), hi: rp(z.hi), mid: rp(z.mid), score: +z.score.toFixed(1), touches: z.touches, dist: +dist.toFixed(2), side: z.mid < px ? 'DESTEK' : 'DİRENÇ', price: rp(px) });
    if (z.score < 6) continue;
    let dir = null;
    if (prev.c > z.lo && last.l <= z.hi * 1.002 && last.l >= z.lo * 0.99 && last.c > last.o && last.c > z.mid && loW >= body) dir = 'LONG';
    else if (prev.c < z.hi && last.h >= z.lo * 0.998 && last.h <= z.hi * 1.01 && last.c < last.o && last.c < z.mid && upW >= body) dir = 'SHORT';
    if (dir === 'LONG' && !(slope >= 0 && px > e50[m] * 0.985)) dir = null;
    if (dir === 'SHORT' && !(slope <= 0 && px < e50[m] * 1.015)) dir = null;
    if (dir && vr < 1.2) dir = null;
    if (dir && (!best || z.score > best.z.score)) best = { z, dir };
  }
  if (best) {
    const { z, dir } = best, d = dir === 'LONG' ? 1 : -1, e = px;
    let sl = dir === 'LONG' ? z.lo - 0.3 * atr : z.hi + 0.3 * atr;
    let R = Math.abs(e - sl);
    const rFloor = e * Math.max(0.008, EX.SL_COST_K * EX.H / 100);
    if (R < rFloor) { sl = e - d * rFloor; R = rFloor; }
    if (R <= e * 0.05) {
      const opp = zones.filter(o => (dir === 'LONG' ? o.lo > e * 1.003 : o.hi < e * 0.997)).sort((a, b) => (dir === 'LONG' ? a.lo - b.lo : b.hi - a.hi))[0];
      let tp1 = e + d * 1.5 * R;
      if (opp) { const c = dir === 'LONG' ? opp.lo * 0.998 : opp.hi * 1.002; const dd = Math.abs(c - e); if (dd >= R && dd <= 4 * R) tp1 = c; }
      let tp2 = e + d * 2.5 * R;
      if ((tp2 - tp1) * d <= 0) tp2 = tp1 + d * R;
      const q = rrNet(e, sl, tp1);
      const wick = dir === 'LONG' ? loW : upW;
      const conf = 52 + Math.min(22, (z.score - 6) * 3) + Math.min(8, wick / Math.max(body, 1e-12) * 2) + Math.min(6, (vr - 1.2) * 4);
      if (q.net >= 1.0) out.signal = { dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 92), info: { zoneLo: rp(z.lo), zoneHi: rp(z.hi), zoneScore: +z.score.toFixed(1), touches: z.touches, volRatio: +vr.toFixed(1), ema50Slope: +slope.toFixed(2), atr, netRR: q.net, riskPct: q.risk } };
    }
  }
  return out;
}
function detectRange(cs, why) {
  const sig = detectRevert(cs, why, REVERT.adxMax);
  if (sig) return { signal: sig };
  const n = cs.length;
  if (n < 80) return {};
  const rg = regimeOf(cs);
  if (rg.adx == null || rg.adx >= REVERT.adxMax || rg.expanding) return {};
  const { mid, sd, up, lo } = bandsOf(cs), px = cs[n - 1].c;
  if (!(sd > 0) || !(mid > 0)) return {};
  const dHi = (up / px - 1) * 100, dLo = (px / lo - 1) * 100;
  if (Math.min(Math.abs(dHi), Math.abs(dLo)) < 0.4)
    return { watch: { rangeHi: rp(up), rangeLo: rp(lo), price: rp(px), distHi: +dHi.toFixed(2), distLo: +dLo.toFixed(2), nearSide: Math.abs(dHi) < Math.abs(dLo) ? 'ÜST' : 'ALT', squeezeScore: Math.round(100 * clamp(1 - (up - lo) / mid / 0.05, 0, 1)), width: +((up - lo) / mid * 100).toFixed(2) } };
  return {};
}

/* ── v81.0: Sembole özel red kayıtlı scalp ── */
function detectScalpX(cs, tf, why, sym) {
  const no = k => {
    if (why) why['scalp:' + k] = (why['scalp:' + k] || 0) + 1;
    if (sym) logRejSym('PUMP', sym, 'scalp:' + k, { tf }, 'REJECTED', 'kırılım + gövde + hacim');
    return null;
  };
  const n = cs.length;
  if (n < 50) return null;
  const L = cs[n - 1], P = cs.slice(n - 1 - SCALPX.brkBars, n - 1);
  const rng = L.h - L.l, body = L.c - L.o;
  if (!(rng > 0) || body === 0) return no('hareket yok');
  const dir = body > 0 ? 'LONG' : 'SHORT', d = body > 0 ? 1 : -1;
  if (Math.abs(body) / rng < SCALPX.minBodyFrac) return no('gövde zayıf');
  const hi = Math.max.apply(null, P.map(c => c.h)), lo = Math.min.apply(null, P.map(c => c.l));
  if (dir === 'LONG' ? !(L.c > hi) : !(L.c < lo)) return no('kırılım yok');
  const atr = atrLast(cs.slice(0, n - 1), 14);
  if (!atr) return null;
  const px = L.c, atrPct = atr / px * 100;
  if (atrPct < SCALPX.minAtrPct) return no('volatilite düşük');
  if (atrPct > SCALPX.maxAtrPct) return no('volatilite aşırı');
  const bodyAtr = Math.abs(body) / atr;
  if (bodyAtr < SCALPX.minBodyAtr) return no('gövde ATR küçük');
  const vSma = avg(cs.slice(n - 21, n - 1).map(c => c.v));
  if (!(vSma > 0)) return no('hacim yok');
  const vr = L.v / vSma;
  if (vr < SCALPX.minVolX) return no('hacim zayıf');
  const wick = (dir === 'LONG' ? L.h - L.c : L.c - L.l) / rng;
  if (wick > SCALPX.maxCounterWick) return no('ters fitil');
  const e20 = emaArr(closes(cs), 20);
  const ext = (px - e20[n - 1]) * d / atr;
  if (ext > SCALPX.maxExtAtr) return no('EMA20den uzak');
  const run = (px - cs[n - 7].c) * d / atr;
  if (run > SCALPX.maxRunAtr) return no('geç kalındı');
  const slope = (e20[n - 1] - e20[n - 6]) / e20[n - 1] * 100 * d;
  if (slope < -0.05) return no('eğim ters');
  const tp1Pct = clamp(SCALPX.tp1K * atrPct, SCALPX.tp1Min, SCALPX.tp1Max);
  const structSl = Math.abs(px - (dir === 'LONG' ? L.l - 0.1 * atr : L.h + 0.1 * atr)) / px * 100;
  const slPct = clamp(structSl, SCALPX.slMin, SCALPX.slMax);
  const tp2Pct = tp1Pct * SCALPX.tp2Mult;
  const sl = px * (1 - d * slPct / 100), tp1 = px * (1 + d * tp1Pct / 100), tp2 = px * (1 + d * tp2Pct / 100);
  const q1 = rrNet(px, sl, tp1), q2 = rrNet(px, sl, tp2);
  if (q1.net < 0.30 || q2.net < 0.90) return no('net R:R düşük');
  const conf = 55 + clamp((vr - SCALPX.minVolX) * 6, 0, 14) + clamp((bodyAtr - SCALPX.minBodyAtr) * 8, 0, 10) + clamp((Math.abs(body) / rng - SCALPX.minBodyFrac) * 20, 0, 8) + (market.dir === dir ? 4 : 0) - clamp(ext - 1.5, 0, 4) * 2;
  const holdSec = Math.round((SCALPX.holdMs[tf] || 9 * M1) / 1000);
  return {
    dir, entry: rp(px), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false,
    conf: clamp(Math.round(conf), 45, 92), holdSec, noMoveSec: 150, maxAgeMs: (holdSec + 300) * 1000, atrPct: +atrPct.toFixed(3),
    info: { tf, trigger: 'scalp-break', breakLevel: rp(dir === 'LONG' ? hi : lo), volRatio: +vr.toFixed(1), bodyAtr: +bodyAtr.toFixed(2), bodyFrac: +(Math.abs(body) / rng).toFixed(2), ext: +ext.toFixed(2), run: +run.toFixed(2), counterWick: +wick.toFixed(2), atr, atrPct: +atrPct.toFixed(3), slPct: +slPct.toFixed(2), tp1Pct: +tp1Pct.toFixed(2), tp2Pct: +tp2Pct.toFixed(2), netRR: q1.net, netRR2: q2.net, barT: L.t }
  };
}

function ltCandidates(cs, cs1d, tf, why) {
  const A = analyzeTriangle(cs, true);
  if (!A) { if (why) why['üçgen yok'] = (why['üçgen yok'] || 0) + 1; return null; }
  const { w, m } = A, last = w[m], step = last.t - w[m - 1].t;
  const vS = avg(w.slice(m - 20, m).map(c => c.v));
  const vr = vS > 0 ? last.v / vS : 0;
  const d1 = (cs1d && cs1d.length >= 30) ? (() => { const ec = emaArr(closes(cs1d), 20); const s1 = ec[ec.length - 1] - ec[ec.length - 4]; return s1 > 0 ? 'UP' : 'DOWN'; })() : null;
  let recentUp = false, recentDn = false;
  for (let k = m - 2; k <= m; k++) { if (w[k].c > A.U(k) * 1.002) recentUp = true; if (w[k].c < A.L(k) * 0.998) recentDn = true; }
  const distU = (A.uN / A.px - 1) * 100, distL = (A.px / A.lN - 1) * 100;
  const nearPct = Math.min(Math.abs(distU), Math.abs(distL));
  const hasBreak = recentUp || recentDn;
  const isNear = nearPct < 1.5 && A.mat > 0.5;
  if (!hasBreak && !isNear) { if (why) why['kırılım/yakınlık yok'] = (why['kırılım/yakınlık yok'] || 0) + 1; return null; }
  if (!hasBreak && isNear) {
    return { watch: true, tf, price: rp(A.px), upper: rp(A.uN), lower: rp(A.lN), mid: rp((A.uN + A.lN) / 2), compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), height: rp(A.w0), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2), nearPct: +nearPct.toFixed(2), nearSide: Math.abs(distU) < Math.abs(distL) ? 'ÜST' : 'ALT', volRatio: +vr.toFixed(2), d1Confirm: d1, lineStep: step };
  }
  const dirHint = recentUp ? 'LONG' : 'SHORT';
  const dd = dirHint === 'LONG' ? 1 : -1, midP = (A.uN + A.lN) / 2;
  let slP = midP;
  if (Math.abs(A.px - slP) < A.px * 0.006 || (A.px - slP) * dd <= 0) slP = A.px - dd * A.px * 0.006;
  const plan = { entry: rp(A.px), sl: rp(slP), tp1: rp(A.px + dd * 0.6 * A.w0), tp2: rp(A.px + dd * A.w0) };
  return { tf, dirHint, plan, yakinlikPct: +nearPct.toFixed(2), price: rp(A.px), upper: rp(A.uN), lower: rp(A.lN), mid: rp((A.uN + A.lN) / 2), compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), height: rp(A.w0), volRatio: +vr.toFixed(2), lineStep: step, breakoutUp: recentUp, breakoutDn: recentDn, d1Confirm: d1, recentCandles: w.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) })) };
}

function trendCandidates(cs, why, sym) {
  const no = k => {
    if (why) why[k] = (why[k] || 0) + 1;
    if (sym) logRejSym('TREND', sym, k, {}, 'REJECTED', 'EMA20 geri çekilme + dönüş mumu');
    return null;
  };
  const n = cs.length;
  if (n < 120) return no('veri kısa');
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = n - 1;
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const last = cs[m], px = last.c;
  const adx = adxLast(cs, 14), rsi = rsiLast(cl, 14);
  if (adx == null || adx < 15) return no('adx düşük');
  const slope50 = (e50[m] - e50[m - 6]) / e50[m] * 100;
  let dir = null;
  if (e20[m] > e50[m] && slope50 > 0.02 && px > e20[m]) dir = 'LONG';
  else if (e20[m] < e50[m] && slope50 < -0.02 && px < e20[m]) dir = 'SHORT';
  if (!dir) return no('trend yönü yok');
  const d = dir === 'LONG' ? 1 : -1;
  let touched = false;
  for (let k = m - 10; k < m; k++) if (dir === 'LONG' ? cs[k].l <= e20[k] + 0.35 * atr : cs[k].h >= e20[k] - 0.35 * atr) { touched = true; break; }
  if (!touched) return no('geri çekilme yok');
  if (dir === 'LONG' ? !(last.c > last.o) : !(last.c < last.o)) return no('dönüş mumu yok');
  if (rsi == null || (dir === 'LONG' ? (rsi < 38 || rsi > 72) : (rsi > 62 || rsi < 28))) return no('rsi uygunsuz');
  const distAtr = (px - e20[m]) * d / atr;
  if (distAtr > 2.2) return no('ema20den uzak');
  const sw = cs.slice(m - 8, m + 1);
  const swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.2 * atr;
  let risk = Math.abs(px - sl);
  risk = Math.max(risk, px * 0.006);
  if (risk > px * 0.05) return no('stop uzak');
  sl = px - d * risk;
  const vSma = avg(cs.slice(m - 20, m).map(c => c.v));
  return {
    dir, flipAge: null, price: rp(px), atr: +atr.toFixed(8), atrPct: +(atr / px * 100).toFixed(3),
    adx: +adx.toFixed(1), rsi: +rsi.toFixed(0), ema20: rp(e20[m]), ema50: rp(e50[m]), distAtr: +distAtr.toFixed(2),
    volRatio: vSma > 0 ? +(last.v / vSma).toFixed(2) : null,
    plan: { entry: rp(px), sl: rp(sl), tp1: rp(px + d * 1.5 * risk), tp2: rp(px + d * 2.5 * risk) },
    recentCandles: cs.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) }))
  };
}

/* ── AI system prompts (v81.0) ── */
const SYSTEM_PROMPTS = {
  PUMP: 'Sen AlphaSon AlgoScalp süzgecisin. 3-5 dakikalık kırılım scalp sinyali geldi. Görevin: AÇIK BİR SORUN var mı? Yoksa GİRİLİR de. Şunlarda GİRİLMEZ: kırılım sahte (uzun ters fitil + hemen geri dönüş), fiyat zaten çok uzamış (>=2.5 ATR), hacim sönük, spread geniş. Çok basit günlük Türkçe, teknik terim yok. Yalnızca JSON döndür.',
  LT: 'Sen AlphaSon LT Üçgen asistanısın. Coin bir üçgen sıkışmasında. Kırılım henüz OLMAMIŞSA "GİRİLMEZ" + score 30-50 ver, hangi koşulda kırılımın teyit olacağını açıkla. Net kırılım varsa + hacim >=1.5x + üst zaman trendi uyumluysa GİRİLİR. Geç kalınmış mı? Fiyat üçgen çizgisinden çok uzaklaşmış mı? Yalnızca JSON döndür.',
  TREND: 'Sen AlphaSon Trend asistanısın. EMA20/50 trendinde geri çekilme adayı. Trendin gerçek mi, düzeltme mi, tükenme mi olduğunu ayırt et. Mevcut noktada yeni pozisyon için geç kalınmış mı? Hacim destekliyor mu? RSI aşırı bölgede mi? Yalnızca JSON döndür.',
  DAILY: 'Sen AlphaSon Günlük Sweep asistanısın. PDH/PDL fitille süpürüldü, içeri kapanış var. Gerçekten süpürme mi yoksa kalıcı kırılım mı? Geri dönüş mumu net mi? Hacim yeterli mi? Yalnızca JSON döndür.',
  SCALPER: 'Sen AlphaSon Scalper asistanısın. Kısa vadeli momentum adayı. Para akışı sürekli mi yoksa tek işlem mi? Kırılım teyitli mi? Fiyat çoktan uzamış mı? Yalnızca JSON döndür.',
  RANGE: 'Sen AlphaSon Range asistanısın. Yatay bant ortalamasına dönüş adayı. Sahte kırılım mı yoksa gerçek mean-reversion mı? ADX düşük mü? Yalnızca JSON döndür.',
  ZONE: 'Sen AlphaSon Zone asistanısın. Destek/direnç bölgesine temas var. Bölge güçlü mü? Gerçek dönüş mü, sahte bounce mı? Yalnızca JSON döndür.'
};
const COMMON_JSON_HINT = 'Zorunlu JSON alanları:\n{"verdict":"GİRİLİR|GİRİLMEZ","decision":"CONFIRMED|WATCH|REJECTED","phase":"PRE_BREAKOUT|TRIGGER_PENDING|BREAKOUT_CONFIRMED|LATE|INVALIDATED","direction":"LONG|SHORT|NEUTRAL","score":0,"confidence":"YÜKSEK|ORTA|DÜŞÜK","dataQuality":"GOOD|FAIR|POOR","lateEntry":false,"triggerConfirmed":false,"entryAllowed":false,"reason":"tek kısa cümle","evidence":["gözlem"],"missingConditions":["eksik"],"risks":["risk"],"bullishScenario":"","bearishScenario":"","triggerCondition":"","invalidationCondition":"","summary":"2-3 cümle"}\nBaşka anahtar KULLANMA. JSON dışında hiçbir şey yazma.';

/* ── v81.0 AI provider ── */
const envKey = (...names) => {
  for (const n of names) {
    let v = process.env[n];
    if (!v) continue;
    v = String(v).trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
    if (v) return v;
  }
  return '';
};
const AI = {
  modules: ['PUMP', 'LT', 'DAILY', 'TREND', 'SCALPER', 'RANGE', 'ZONE'],
  maxPerDay: clamp(Number(process.env.AI_MAX_PER_DAY) || 1500, 1, 3000),
  maxPerHour: clamp(Number(process.env.AI_MAX_PER_HOUR) || 180, 1, 400),
  nonPumpShare: 0.75,
  briefPerDay: clamp(Number(process.env.AI_BRIEF_PER_DAY) || 6, 0, 12),
  briefGapMs: 3 * H1,
  timeoutMs: clamp(Number(process.env.AI_TIMEOUT_MS) || 18000, 5000, 120000),
  pumpTimeoutMs: clamp(Number(process.env.AI_PUMP_TIMEOUT_MS) || 8000, 3000, 30000),
  maxTokens: clamp(Number(process.env.AI_MAX_TOKENS) || 700, 200, 2000),
  temperature: 0.30,
  cacheMs: 6 * H1,
  pumpMinScore: clamp(Number(process.env.AI_PUMP_MIN_SCORE) || 55, 40, 95),
  pumpWaitMs: clamp(Number(process.env.AI_PUMP_WAIT_MS) || 20000, 4000, 60000),
  pumpEntryDriftPct: clamp(Number(process.env.AI_PUMP_ENTRY_DRIFT_PCT) || 0.30, 0.10, 0.80),
  approvalWindowMs: 5 * M1,
  autoMaxOpen: clamp(Number(process.env.AI_AUTO_MAX_OPEN) || 3, 1, 3),
  aiScanTrendMs: 10 * M1,
  aiScanLTMs: 15 * M1,
  aiTrendCandidatesMax: 4,
  aiLTCandidatesMax: 3,
  aiWatchTopN: 5,
  watchAiRefreshMs: 20 * M1,
  modMinConf: { TREND: 0, DAILY: 0, LT: 0 },
  modHourCap: { TREND: 20, DAILY: 20, LT: 15, SCALPER: 20, RANGE: 12, ZONE: 10 },
  gapMs: { gemini: 5000, groq: 6000, openrouter: 5000, deepseek: 4000, github: 4000, cerebras: 3000, sambanova: 3000, mistral: 3000, cohere: 3500 },
  providers: [
    { id: 'gemini', name: 'Gemini Flash', key: envKey('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_KEY'), base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-3.5-flash-lite', 'gemini-3.6-flash'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'groq', name: 'Groq', key: envKey('GROQ_API_KEY', 'GROQ_KEY', 'GROQ_TOKEN'), base: 'https://api.groq.com/openai/v1/chat/completions', models: process.env.GROQ_MODEL ? [process.env.GROQ_MODEL] : ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'deepseek', name: 'DeepSeek', key: envKey('DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DEEPSEEK_TOKEN'), base: 'https://api.deepseek.com/v1/chat/completions', models: process.env.DEEPSEEK_MODEL ? [process.env.DEEPSEEK_MODEL] : ['deepseek-chat'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'openrouter', name: 'OpenRouter', key: envKey('OPENROUTER_API_KEY', 'OPENROUTER_KEY', 'OPEN_ROUTER_API_KEY'), base: 'https://openrouter.ai/api/v1/chat/completions', models: process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : [], headers: { 'HTTP-Referer': 'https://alphason-z8kj.onrender.com', 'X-Title': 'AlphaSon' }, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'github', name: 'GitHub Models', key: envKey('GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN'), base: 'https://models.github.ai/inference/chat/completions', models: process.env.GITHUB_MODEL ? [process.env.GITHUB_MODEL] : ['openai/gpt-4o-mini'], headers: {}, cooldownMs: 10 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'cerebras', name: 'Cerebras', key: envKey('CEREBRAS_API_KEY', 'CEREBRAS_KEY'), base: 'https://api.cerebras.ai/v1/chat/completions', models: process.env.CEREBRAS_MODEL ? [process.env.CEREBRAS_MODEL] : ['llama-3.3-70b'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'mistral', name: 'Mistral', key: envKey('MISTRAL_API_KEY', 'MISTRAL_KEY'), base: 'https://api.mistral.ai/v1/chat/completions', models: process.env.MISTRAL_MODEL ? [process.env.MISTRAL_MODEL] : ['mistral-small-latest'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} }
  ]
};
let aiUsage = { day: '', dayCount: 0, hourKey: 0, hourCount: 0, briefDay: '', briefCount: 0, total: 0, lastAt: 0, lastError: null, lastProvider: null };
const AI_QUEUE = [];
const AI_MOD_HOUR = {};
let aiBusy = false;
let AI_RR = 0;

function loadAI() { try { const j = loadJSON(F_AI, null); if (j && typeof j === 'object') aiUsage = Object.assign(aiUsage, j); if (j && j.brief) marketBrief = j.brief; } catch (e) { } if (!aiUsage.day) aiUsage.day = new Date().toISOString().slice(0, 10); }
function saveAI() { saveJSON(F_AI, { day: aiUsage.day, dayCount: aiUsage.dayCount, hourKey: aiUsage.hourKey, hourCount: aiUsage.hourCount, briefDay: aiUsage.briefDay, briefCount: aiUsage.briefCount, total: aiUsage.total, lastAt: aiUsage.lastAt, lastError: aiUsage.lastError, lastProvider: aiUsage.lastProvider, brief: marketBrief || undefined }); }
function aiKeys() { return AI.providers.filter(p => p.key && p.models && p.models.length); }
function aiReady() { return !!(settings.aiEnabled !== false && aiKeys().length > 0); }
function orderedProviders(prefer) {
  const ks = AI.providers.filter(p => p.key && p.models && p.models.length);
  if (!ks.length) return [];
  if (prefer) return ks.filter(p => p.id === prefer).concat(ks.filter(p => p.id !== prefer));
  const score = p => {
    const total = (p.ok || 0) + (p.fail || 0);
    const rate = total > 0 ? (p.ok || 0) / total : 0.5;
    const lat = p.lastLatencyMs || 3000;
    const recentFail = p.lastError && Date.now() - (p.lastAt || 0) < 5 * M1 ? 1 : 0;
    return rate - (lat / 30000) - recentFail * 0.3;
  };
  return ks.slice().sort((a, b) => score(b) - score(a));
}
const MODEL_PICK = {
  groq: list => {
    const bad = /whisper|guard|tts|playai|orpheus|embed|safeguard|compound/i;
    const ok = list.map(m => m.id).filter(x => !bad.test(x));
    const out = [];
    for (const re of [/gpt-oss-20b/i, /llama-3\.1-8b-instant/i, /llama-3\.3-70b-versatile/i, /qwen/i]) {
      const m = ok.find(x => re.test(x) && !out.includes(x));
      if (m) out.push(m);
      if (out.length >= 3) break;
    }
    return out;
  },
  openrouter: list => {
    const bad = /thinking|reasoning|r1|vision|vl\b|embed|guard|audio|image|lyria|safeguard|moderation/i;
    const free = list.filter(m => (m.free === true || /:free$/.test(m.id)) && !bad.test(m.id));
    const pref = [/llama/, /gemma/, /qwen/, /mistral/, /glm/, /nemotron/, /gpt-oss/, /deepseek/, /hermes/];
    const rank = id => { const k = pref.findIndex(re => re.test(id)); return k < 0 ? 99 : k; };
    return free.map(m => m.id).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 4);
  }
};
async function discoverModels(p) {
  if (p.id === 'deepseek') return [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }];
  const url = p.base.replace(/\/chat\/completions$/, '/models');
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: Object.assign({ Authorization: 'Bearer ' + p.key }, p.headers || {}), signal: ctl.signal });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) throw new Error('HTTP ' + res.status);
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    return list.map(m => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), free: m.pricing ? (Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) : null })).filter(m => m.id);
  } finally { clearTimeout(tm); }
}
async function discoverAll() {
  for (const p of AI.providers) {
    if (!p.key) continue;
    if (p.id === 'deepseek' && !process.env.DEEPSEEK_MODEL) { p.models = ['deepseek-chat']; p.modelCooldowns = {}; p.cooldownUntil = 0; log('AI MODEL KEŞFİ: DeepSeek → deepseek-chat (sabit)'); continue; }
    if (!MODEL_PICK[p.id]) continue;
    if (process.env[p.id.toUpperCase() + '_MODEL']) continue;
    try {
      const list = await discoverModels(p);
      const picked = MODEL_PICK[p.id](list || []);
      if (picked.length) { p.models = picked; p.modelCooldowns = {}; p.cooldownUntil = 0; log('AI MODEL KEŞFİ: ' + p.name + ' → ' + picked.join(', ')); }
      else log('AI MODEL KEŞFİ: ' + p.name + ' → uygun model yok (' + (list || []).length + ' listelendi)');
    } catch (e) { log('AI MODEL KEŞFİ HATASI: ' + p.name + ' → ' + redact(e.message)); }
  }
}
async function aiTestProvider(p) {
  const out = [];
  for (const model of (p.models || [])) {
    const t0 = Date.now();
    try {
      const r = await callProviderModel(p, [{ role: 'system', content: 'Yalnızca JSON döndür.' }, { role: 'user', content: '{"ok":true} döndür.' }], model, { timeoutMs: 12000 });
      p.lastLatencyMs = Date.now() - t0;
      out.push({ model, ok: true, ms: Date.now() - t0, sample: String(r.text).slice(0, 60) });
    } catch (e) { out.push({ model, ok: false, ms: Date.now() - t0, status: e.status || 0, error: redact(e.message).slice(0, 200) }); }
    await sleep(300);
  }
  return out;
}
async function aiBootstrap() {
  log('AI ANAHTAR DURUMU: ' + AI.providers.map(p => p.id + (p.key ? ' ✓' : ' ✗')).join(' | '));
  await discoverAll();
  for (const p of AI.providers) {
    if (!p.key) continue;
    if (!(p.models || []).length) { log('AI TEST: ' + p.name + ' → kullanılabilir model yok'); continue; }
    const res = await aiTestProvider(p);
    for (const r of res) log('AI TEST: ' + p.name + '/' + r.model + ' → ' + (r.ok ? 'ÇALIŞIYOR (' + r.ms + 'ms)' : 'HATA ' + r.status + ' ' + r.error));
  }
}
function aiProviderView(p) {
  const now = Date.now();
  return { id: p.id, name: p.name, models: (p.models || []).slice(), hasKey: !!p.key, cooldownUntil: p.cooldownUntil || 0, cooldownSec: p.cooldownUntil && p.cooldownUntil > now ? Math.ceil((p.cooldownUntil - now) / 1000) : 0, modelCooldowns: p.modelCooldowns || {}, lastError: p.lastError || null, lastAt: p.lastAt || 0, lastLatencyMs: p.lastLatencyMs || null, calls: p.calls || 0, ok: p.ok || 0, fail: p.fail || 0 };
}
function aiQuota() {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), hk = Math.floor(now / H1);
  if (aiUsage.day !== day) { aiUsage.day = day; aiUsage.dayCount = 0; aiUsage.briefDay = day; aiUsage.briefCount = 0; }
  if (aiUsage.hourKey !== hk) { aiUsage.hourKey = hk; aiUsage.hourCount = 0; }
  return { ok: aiUsage.dayCount < AI.maxPerDay && aiUsage.hourCount < AI.maxPerHour, day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour };
}
function aiReserveOk(frac) { const q = aiQuota(); return q.ok && aiUsage.dayCount < AI.maxPerDay * frac && aiUsage.hourCount < AI.maxPerHour * frac; }
function aiCount(provider) { const q = aiQuota(); if (!q.ok) return false; aiUsage.dayCount++; aiUsage.hourCount++; aiUsage.total++; aiUsage.lastAt = Date.now(); aiUsage.lastProvider = provider ? provider.id : null; saveAI(); return true; }
function aiStatus() {
  const q = aiQuota(), keys = aiKeys();
  return {
    version: VERSION, enabled: aiReady(), settingsEnabled: settings.aiEnabled !== false, keys: keys.length, modules: AI.modules.slice(),
    limits: { maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour, briefPerDay: AI.briefPerDay, pumpMinScore: AI.pumpMinScore, pumpWaitMs: AI.pumpWaitMs, approvalWindowMs: AI.approvalWindowMs, autoMaxOpen: AI.autoMaxOpen, watchTopN: AI.aiWatchTopN, modHourCap: AI.modHourCap, modMinConf: AI.modMinConf, gapMs: AI.gapMs, nonPumpShare: AI.nonPumpShare },
    usage: { day: q.day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, briefCount: aiUsage.briefCount, total: aiUsage.total, lastAt: aiUsage.lastAt, lastError: aiUsage.lastError, lastProvider: aiUsage.lastProvider },
    providers: AI.providers.map(aiProviderView), brief: marketBrief
  };
}

const BLK = {}, PWHY = {}, SWHY = {}, TWHY = {}, LWHY = {}, RWHY = {}, SC = {};
const sc = (m, k) => { const o = SC[m] || (SC[m] = {}); o[k] = (o[k] || 0) + 1; };
const blockLog = {};
const stats = { apiErr: 0, pumpScanned: 0, pumpFound: 0, tickAt: 0, excluded: 0 };
let dirty = false;
let ALL = [], TOP = [];
const TICK = {};
const CACHE = new Map();
const jobs = {};
const ex = new ccxt.bitget({ apiKey: API_KEY, secret: API_SECRET, password: API_PASS, enableRateLimit: true, options: { defaultType: 'swap', defaultSubType: 'linear' } });

function sanitizeSettings(s) {
  const o = Object.assign({}, DEF_SET, s || {});
  o.auto = !!o.auto;
  o.tradeMode = o.tradeMode === 'live' ? 'live' : 'paper';
  o.margin = clamp(Number(o.margin) || DEF_SET.margin, 10, 100000);
  o.leverage = clamp(Math.round(Number(o.leverage) || DEF_SET.leverage), 1, 20);
  o.minConf = clamp(Math.round(Number(o.minConf) || DEF_SET.minConf), 40, 95);
  o.maxMinutes = clamp(Math.round(Number(o.maxMinutes) || DEF_SET.maxMinutes), 3, 120);
  o.maxOpen = clamp(Math.round(Number(o.maxOpen) || DEF_SET.maxOpen), 1, 50);
  o.dailyLossPct = clamp(Number(o.dailyLossPct) || 0, 0, 50);
  o.pumpQuick = o.pumpQuick !== false;
  o.aiEnabled = o.aiEnabled !== false;
  const rpct = Number(o.riskPct);
  o.riskPct = clamp(isFinite(rpct) && rpct >= 0 ? rpct : DEF_SET.riskPct, 0, 5);
  return o;
}

/* State init: signals, paper, settings, market, radar, WATCH */
let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: 0, liveDayStart: 0 };
const DEF_SET = { auto: false, tradeMode: 'paper', margin: 100, leverage: 5, minConf: 60, maxMinutes: 5, riskPct: 0.5, maxOpen: 8, dailyLossPct: 0, pumpQuick: true, aiEnabled: true };
let settings = Object.assign({}, DEF_SET);
const market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, b1h: 0.5, b4h: 0.5, btc: null, eth: null, lastDirChange: 0, lastDirective: null, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [], daily: [] };
const DAILY_LEVELS = new Map();
const DAILY_ASKED = new Map();
const DWHY = {};
let marketBrief = null;
const LTR = new Map();
function saveLTR() { saveJSON(F_LTR, Array.from(LTR.values())); }
function loadLTR() {
  const a = loadJSON(F_LTR, []);
  if (!Array.isArray(a)) return;
  const now = Date.now();
  for (const e of a) { if (!e || !e.sym || !(e.step > 0) || !(e.line0 > 0)) continue; if (now - e.lineT > 12.5 * e.step || now - e.breakoutAt > 3 * D1) continue; LTR.set(e.sym + '|' + e.tf, e); }
}
function loadAll() {
  const s = loadJSON(F_SIG, { seq: 0, list: [] });
  signals = Array.isArray(s.list) ? s.list : [];
  sigSeq = Number(s.seq) || signals.length;
  const p = loadJSON(F_PAPER, null);
  if (p && Array.isArray(p.open) && Array.isArray(p.closed)) paper = Object.assign(paper, p);
  settings = sanitizeSettings(loadJSON(F_SET, {}));
  if (settings.auto) { settings.auto = false; saveSettings(); log('GÜVENLİK: yeniden başlatma sonrası oto-trade KAPATILDI'); }
  loadLTR(); loadAI(); loadRej();
  log('Veriler yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık işlem, AI ' + (aiReady() ? 'HAZIR' : 'KAPALI') + ', eleme kayıtları: ' + RECENT_REJ.length);
}
function saveAll() {
  if (dirty) {
    dirty = false;
    const act = signals.filter(isOpenSignal);
    const cl = signals.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 600);
    signals = act.concat(cl).sort((a, b) => a.createdAt - b.createdAt);
    saveJSON(F_SIG, { seq: sigSeq, list: signals });
    paper.closed = paper.closed.slice(0, 300);
    saveJSON(F_PAPER, paper);
  }
  saveRej();
}
function saveSettings() { saveJSON(F_SET, settings); }

const priceOf = sym => (TICK[sym] && TICK[sym].last ? TICK[sym].last : null);
function quoteVolOf(t) { if (!t) return 0; const q = Number(t.quoteVolume); if (isFinite(q) && q > 0) return q; const b = Number(t.baseVolume), px = Number(t.last); return isFinite(b) && b > 0 && isFinite(px) && px > 0 ? b * px : 0; }
async function refreshTickers() {
  const t = await ex.fetchTickers();
  for (const k in t) { const x = t[k]; if (x && x.last && k.endsWith('/USDT:USDT')) TICK[k] = Object.assign({}, TICK[k], x); }
  stats.tickAt = Date.now();
  const now = stats.tickAt;
  for (const sym in TICK) { const x = TICK[sym]; if (!x || !(x.last > 0)) continue; pushSnap(sym, now, x.last, x.quoteVolume); ringPush(sym, now, x.last); }
}
async function fetchRealBalance() {
  if (!IS_LIVE_READY) return;
  try {
    const bal = await ex.fetchBalance();
    const u = bal && bal['USDT'];
    if (u) realBal = { total: Number(u.total) || 0, free: Number(u.free) || 0, used: Number(u.used) || 0, updatedAt: Date.now(), error: null };
  } catch (e) { realBal.error = e.message; }
}
async function getC(sym, tf, limit, ttl) {
  const key = sym + '|' + tf, e = CACHE.get(key), now = Date.now(), tt = ttl != null ? ttl : TTL[tf];
  if (e && now - e.t < tt && e.limit >= limit) return e.data.slice(-limit);
  try {
    const raw = await ex.fetchOHLCV(sym, tf, undefined, limit);
    if (!raw || !raw.length) return e ? e.data.slice(-limit) : null;
    const data = raw.map(toC);
    CACHE.set(key, { t: now, limit, data });
    return data;
  } catch (err) { stats.apiErr++; return e ? e.data.slice(-limit) : null; }
}
async function fetchHistory(sym, tf, total) {
  const ms = TF_MS[tf];
  let since = Date.now() - total * ms, out = [];
  try {
    for (let g = 0; g < 40 && out.length < total; g++) {
      const b = await ex.fetchOHLCV(sym, tf, since, 200);
      if (!b || !b.length) break;
      out = out.concat(b);
      const lastT = b[b.length - 1][0];
      if (lastT + ms >= Date.now() || b.length < 2) break;
      since = lastT + ms;
    }
  } catch (e) { }
  if (out.length < 50) { try { out = await ex.fetchOHLCV(sym, tf, undefined, 500); } catch (e) { return []; } }
  const seen = new Set(), res = [];
  for (const a of out) { if (!seen.has(a[0])) { seen.add(a[0]); res.push(toC(a)); } }
  res.sort((a, b) => a.t - b.t);
  return res;
}
async function refreshUniverse() {
  await refreshTickers();
  const list = [], skipped = [];
  for (const k in ex.markets) {
    const m = ex.markets[k];
    if (m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false && TICK[m.symbol]) {
      if (!ALLOW_TOKENIZED && isTokenized(baseOf(m.symbol))) { skipped.push(baseOf(m.symbol)); continue; }
      list.push(m.symbol);
    }
  }
  list.sort((a, b) => quoteVolOf(TICK[b]) - quoteVolOf(TICK[a]));
  ALL = list; TOP = list.slice(0, 120); stats.excluded = skipped.length;
  log('Evren güncellendi: ' + ALL.length + ' sözleşme, likit ' + TOP.length + ' taranıyor' + (skipped.length ? ' | dışlanan: ' + skipped.length : ''));
}

function blocked(mod, sym, reason, silent) {
  BLK[reason] = (BLK[reason] || 0) + 1;
  if (silent) return false;
  const k = mod + '|' + reason, t = Date.now();
  if (!blockLog[k] || t - blockLog[k] > 120000) { blockLog[k] = t; log('ENGEL: ' + MODS[mod].label + ' ' + baseOf(sym) + ' → ' + reason); }
  return false;
}
function isOpenSignal(s) { return !!s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR' || s.status === 'ONAY_BEKLIYOR'); }

/* ── Analysis ── */
function analyzeSignal(sig) {
  const mod = sig.module, dir = sig.dir, info = sig.info || {}, conf = Number(sig.conf) || 0, price = Number(sig.entry) || 0;
  const riskPct = info.riskPct != null ? Number(info.riskPct) : (price > 0 ? Math.abs(price - sig.sl) / price * 100 : 0);
  const rr = info.netRR != null ? Number(info.netRR) : (price > 0 ? rrNet(price, sig.sl, sig.tp1).net : 0);
  const counter = market.dir !== 'NOTR' && market.dir !== dir, aligned = market.dir !== 'NOTR' && market.dir === dir;
  const reasons = [], risks = [];
  let score = clamp(conf, 0, 100);
  const fmt = x => (x >= 1 ? x.toFixed(4) : x.toPrecision(5));
  if (mod === 'LT') { if (Number(info.volRatio) >= 1.5) { score += 5; reasons.push('Hacim ' + Number(info.volRatio).toFixed(1) + 'x'); } if (rr < 1.2) { score -= 8; risks.push('Net R:R ' + rr.toFixed(2)); } }
  else if (mod === 'PUMP') { if (info.trigger === 'scalp-break') { reasons.push(info.tf + ' kırılım'); } if (Number(info.volRatio) >= 2.5) { score += 4; } if (Number(info.counterWick) > 0.25) { score -= 4; risks.push('Ters fitil'); } }
  else if (mod === 'TREND') { if (Number(info.adx) >= 25) { score += 4; } }
  if (counter) { score -= 6; risks.push('Piyasa yönüne ters'); }
  else if (aligned) { score += 4; reasons.push('Piyasa uyumlu'); }
  if (riskPct > 2.5) risks.push('Risk %' + riskPct.toFixed(2));
  score = Math.round(clamp(score, 0, 100));
  const verdict = score >= 60 ? 'ONY' : 'RED', verdictLabel = verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ';
  return { source: 'kural', verdict, verdictLabel, score, riskLevel: riskPct > 1.8 ? 'YÜKSEK' : riskPct > 1.0 ? 'ORTA' : 'DÜŞÜK', marketView: 'Piyasa ' + market.dir, summary: MODS[mod].label + ' ' + dir + ' · güven ' + sig.conf, simpleSummary: fmt(price) + ' giriş, stop ' + fmt(sig.sl), reasons: reasons.slice(0, 8), risks: risks.slice(0, 6), at: Date.now() };
}
function analyzeMarket() {
  const m = market || {}, score = Math.round(clamp((m.score || 0.5) * 100, 0, 100));
  return { source: 'kural', verdict: score >= 50 ? 'ONY' : 'RED', verdictLabel: score >= 50 ? 'GİRİLİR' : 'GİRİLMEZ', score, summary: 'Piyasa skoru ' + score + '/100', at: Date.now() };
}

/* ── Pump addSignal ── */
function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = baseOf(sym);
  if (M.maxPerDaySym) { const dayStart = Math.floor(t / D1) * D1; const cnt = signals.filter(s => s.module === mod && s.symbol === sym && s.createdAt >= dayStart).length; if (cnt >= M.maxPerDaySym) { BLK['günlük limit'] = (BLK['günlük limit'] || 0) + 1; return false; } }
  if (raw.retest) { const actLT = signals.filter(s => s.module === mod && s.symbol === sym && isOpenSignal(s)); if (actLT.some(s => s.dir !== dir)) return false; if (actLT.some(s => s.info && s.info.retest)) return false; }
  else if (signals.some(s => s.module === mod && s.symbol === sym && (isOpenSignal(s) || (s.dir === dir && t - (s.closedAt || s.createdAt) < M.cooldown)))) return false;
  const act = signals.filter(isOpenSignal), sec = sectorOf(base);
  const counter = market.dir !== 'NOTR' && dir !== market.dir;
  const align = market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU');
  if (counter && (mod === 'PUMP' || mod === 'SCALPER')) { BLK['piyasa ters'] = (BLK['piyasa ters'] || 0) + 1; return false; }
  const same = act.filter(s => s.symbol === sym && s.dir === dir && s.module !== mod);
  const bonus = Math.min(25, same.length * 12);
  const base0 = raw.conf - (counter ? 6 : 0);
  const oi1 = oiChg(sym, 60000), oi5 = oiChg(sym, 5 * M1);
  const pumpGate = mod === 'PUMP' ? { state: 'PENDING', queuedAt: t, expiresAt: t + AI.pumpWaitMs, minScore: AI.pumpMinScore } : null;
  const sig = {
    id: 'S' + (++sigSeq), module: mod, symbol: sym, base, sector: sec, dir,
    entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single, tp1Hit: false,
    baseConf: base0, confBonus: bonus, conf: clamp(Math.round(base0 + bonus), 30, 99), counter, marketAlign: align,
    confl: same.map(s => s.module), info: Object.assign({}, raw.info || {}, { oi1: oi1 != null ? +oi1.toFixed(2) : null, oi5: oi5 != null ? +oi5.toFixed(2) : null }),
    status: pumpGate ? 'AI_BEKLIYOR' : 'AKTIF', result: null, aiGate: pumpGate,
    createdAt: t, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0,
    holdSec: raw.holdSec, noMoveSec: raw.noMoveSec, quickTpPct: raw.quickTpPct, quickTimeSec: raw.quickTimeSec, quickArmPct: raw.quickArmPct,
    retest: !!raw.retest, atrPct: raw.atrPct, velSeries: [], peakPct: null
  };
  if (sig.info && sig.info.source === 'ai') {
    sig.ai = { verdict: 'ONY', entryDecision: 'APPROVE', trust: sig.info.aiTrust || 'ORTA', score: sig.info.aiScore != null ? sig.info.aiScore : sig.conf, reason: sig.info.reason || '', summary: sig.info.reason || '', risks: sig.info.risks || [], provider: sig.info.provider, providerName: sig.info.providerName, model: sig.info.model, latencyMs: sig.info.latencyMs, at: t, source: 'ai' };
  }
  sig.analysis = analyzeSignal(sig);
  signals.push(sig); dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + base + ' | ' + dir + ' | güven ' + sig.conf + ' | ' + align + (pumpGate ? ' | AI BEKLİYOR' : ''));
  if (mod === 'PUMP') {
    stats.pumpFound++;
    if (aiReady()) queueAI(sig);
    else { sig.aiGate = Object.assign({}, sig.aiGate, { state: 'OFFLINE', note: (settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok'), decidedAt: Date.now() }); sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI.approvalWindowMs; dirty = true; log('ALGOPUMP (AI YOK): ' + base + ' → ONAY BEKLİYOR'); }
  } else if (mod === 'DAILY' && AI.modules.includes(mod) && !(sig.info && sig.info.source === 'ai')) queueAI(sig);
  return true;
}
function emit(mod, sym, det, last, tfMs, maxLag) {
  sc(mod, 'aday');
  if (Date.now() - (last.t + tfMs) > maxLag) { sc(mod, 'mum eski'); return false; }
  const px = priceOf(sym), atr = det.info && det.info.atr;
  if (px && atr && Math.abs(px - det.entry) > 0.50 * atr) { sc(mod, 'fiyat uzaklaştı'); return false; }
  const ok = addSignal(Object.assign({ module: mod, symbol: sym }, det));
  sc(mod, ok ? 'sinyal' : 'engel/cooldown');
  return ok;
}
function closeSignal(s, price, reason) {
  if (s.status === 'KAPALI') return;
  s.status = 'KAPALI'; s.result = reason; s.exit = rp(price); s.closedAt = Date.now();
  const r = calcR(s, price);
  s.grossR = +r.gross.toFixed(3); s.netR = +r.net.toFixed(3);
  s.pnlPct = +(((price / s.entry - 1) * (s.dir === 'LONG' ? 1 : -1)) * 100).toFixed(3);
  dirty = true;
  log('SİNYAL KAPANDI: ' + MODS[s.module].label + ' ' + s.base + ' → ' + (REASON[reason] || reason) + ' (net ' + (s.netR >= 0 ? '+' : '') + s.netR + 'R)');
}

/* ── AI JSON parser + error classes ── */
function redact(s) { let x = String(s == null ? '' : s); for (const p of AI.providers) if (p.key) x = x.split(p.key).join('[KEY]'); return x.slice(0, 500); }
function parseAIJSON(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  const arr = x => { if (Array.isArray(x)) return x.map(v => String(v)).filter(Boolean).slice(0, 6); if (typeof x === 'string' && x.trim()) return x.split(/[\n;\u2022]/).map(v => v.trim()).filter(Boolean).slice(0, 6); return []; };
  if (!j || typeof j !== 'object') {
    return { verdict: 'RED', decision: 'REJECTED', phase: 'INVALIDATED', direction: 'NEUTRAL', score: 0, trust: 'DÜŞÜK', confidence: 'DÜŞÜK', riskLevel: 'ORTA', entryDecision: 'REJECT', entryAllowed: false, triggerConfirmed: false, lateEntry: false, dataQuality: 'POOR', summary: raw.slice(0, 500) || 'AI yanıtı anlaşılamadı.', reasons: [], risks: ['AI yanıtı JSON değil.'], evidence: [], missingConditions: [], bullishScenario: '', bearishScenario: '', triggerCondition: '', invalidationCondition: '', reason: '', parseError: true };
  }
  let v = String(j.verdict || '').toUpperCase().replace(/İ/g, 'I').replace(/\s+/g, '_');
  const verdict = ['GIRILIR', 'GİRİLİR', 'AL', 'BUY', 'LONG', 'APPROVE', 'ONY', 'ONAY', 'UYGUN', 'GIREBILIR'].includes(v) ? 'ONY' : 'RED';
  let tr = String(j.trust || j.confidence || '').toUpperCase().replace(/İ/g, 'I');
  if (['YUKSEK', 'YÜKSEK', 'HIGH'].includes(tr)) tr = 'YÜKSEK'; else if (['DUSUK', 'DÜŞÜK', 'LOW'].includes(tr)) tr = 'DÜŞÜK'; else tr = 'ORTA';
  let score = clamp(Math.round(Number(j.score) || (tr === 'YÜKSEK' ? 80 : tr === 'ORTA' ? 60 : 40)), 0, 100);
  let riskLevel = String(j.riskLevel || '').toUpperCase().replace(/İ/g, 'I');
  if (!['DÜŞÜK', 'ORTA', 'YÜKSEK'].includes(riskLevel)) riskLevel = 'ORTA';
  const decisionRaw = String(j.decision || '').toUpperCase().replace(/\s+/g, '_');
  const decision = ['CONFIRMED', 'WATCH', 'REJECTED'].includes(decisionRaw) ? decisionRaw : (verdict === 'ONY' ? 'CONFIRMED' : 'WATCH');
  const phaseRaw = String(j.phase || '').toUpperCase().replace(/\s+/g, '_');
  const phase = ['PRE_BREAKOUT', 'TRIGGER_PENDING', 'BREAKOUT_CONFIRMED', 'LATE', 'INVALIDATED'].includes(phaseRaw) ? phaseRaw : 'PRE_BREAKOUT';
  const direction = ['LONG', 'SHORT', 'NEUTRAL'].includes(String(j.direction || '').toUpperCase()) ? String(j.direction).toUpperCase() : 'NEUTRAL';
  let dq = String(j.dataQuality || '').toUpperCase();
  if (!['GOOD', 'FAIR', 'POOR'].includes(dq)) dq = 'FAIR';
  const decisionRaw2 = String(j.entryDecision || '').toUpperCase().replace(/\s+/g, '_');
  const DMAP = { APPROVE: 'APPROVE', ONAY: 'APPROVE', REJECT: 'REJECT', RED: 'REJECT' };
  const entryDecision = DMAP[decisionRaw2] || (verdict === 'ONY' ? 'APPROVE' : 'REJECT');
  return {
    verdict, decision, phase, direction, score, trust: tr, confidence: tr, riskLevel, dataQuality: dq, entryDecision,
    entryAllowed: j.entryAllowed === true, triggerConfirmed: j.triggerConfirmed === true, lateEntry: j.lateEntry === true,
    stopLossPct: Number(j.stopLossPct) || null, takeProfitPct: Number(j.takeProfitPct) || null, takeProfit2Pct: Number(j.takeProfit2Pct) || null,
    maxHoldSec: Number(j.maxHoldSec) || null, noMoveSec: Number(j.noMoveSec) || null, quickArmPct: Number(j.quickArmPct) || null,
    exitStyle: ['FAST', 'BALANCED', 'TRAIL', 'SCALE_OUT'].includes(String(j.exitStyle || '').toUpperCase()) ? String(j.exitStyle).toUpperCase() : 'FAST',
    marketView: String(j.marketView || '').slice(0, 400), summary: String(j.summary || j.reason || '').slice(0, 600), reason: String(j.reason || '').slice(0, 300),
    reasons: arr(j.reasons || j.evidence || j.reason), evidence: arr(j.evidence), missingConditions: arr(j.missingConditions), risks: arr(j.risks),
    bullishScenario: String(j.bullishScenario || '').slice(0, 400), bearishScenario: String(j.bearishScenario || '').slice(0, 400),
    triggerCondition: String(j.triggerCondition || '').slice(0, 300), invalidationCondition: String(j.invalidationCondition || '').slice(0, 300),
    suggested: String(j.suggested || j.plan || '').slice(0, 500), invalidation: String(j.invalidation || j.invalidationCondition || '').slice(0, 400),
    timeHorizon: String(j.timeHorizon || '').slice(0, 100), drivers: arr(j.drivers), ideas: Array.isArray(j.ideas) ? j.ideas.slice(0, 4).map(x => ({ coin: String(x && x.coin || '').toUpperCase().slice(0, 12), dir: String(x && x.dir || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG', reason: String(x && x.reason || '').slice(0, 200) })).filter(x => x.coin) : []
  };
}
function isModelError(e) { const s = String(e && e.message || '').toLowerCase(); return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer available|no longer supported/.test(s); }
function isQuotaExhausted(e) { const s = String(e && e.message || '').toLowerCase(); return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|credit balance|exceeded.*quota|resource_exhausted|rate limit reached|tokens per minute|tpm|requests per minute|rpm/.test(s); }
function isTransientAIError(e) { const status = Number(e && e.status) || 0; return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e); }
function untilNextPacificMidnight(now) { try { const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })); const next = new Date(local); next.setDate(next.getDate() + 1); next.setHours(0, 0, 10, 0); return Math.max(M1, next.getTime() - local.getTime()); } catch (e) { return 12 * H1; } }
function providerFail(p, e) {
  const status = Number(e && e.status) || 0;
  p.fail = (p.fail || 0) + 1; p.lastError = redact(e && e.message || 'bilinmeyen hata'); p.lastAt = Date.now();
  let ms;
  if (e && e.retryAfterMs) ms = e.retryAfterMs;
  else if (isQuotaExhausted(e)) ms = untilNextPacificMidnight(Date.now());
  else if (status === 429) ms = 2 * M1;
  else if (status === 401 || status === 403) ms = 60 * M1;
  else if (status >= 500) ms = 2 * M1;
  else if (isModelError(e) || (e && e.allModelsCooldown)) ms = 10 * M1;
  else ms = M1;
  p.cooldownUntil = Date.now() + ms;
  aiUsage.lastError = p.name + ': ' + p.lastError; aiUsage.lastAt = Date.now(); saveAI();
  log('AI HATA: ' + p.name + ' → ' + p.lastError + ' | ' + Math.ceil(ms / 1000) + ' sn bekleme');
}
async function callProviderModel(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI.timeoutMs;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), tmo);
  const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, p.headers || {});
  try {
    const res = await fetch(p.base, { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify({ model, messages, temperature: AI.temperature, max_tokens: AI.maxTokens, stream: false }) });
    const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) {
      const msg = (j && (j.error && (j.error.message || j.error.code) || j.message)) || txt.slice(0, 300) || ('HTTP ' + res.status);
      const er = new Error(redact(msg)); er.status = res.status;
      const ra = res.headers.get('retry-after');
      if (ra) { const n = Number(ra); er.retryAfterMs = isFinite(n) ? n * 1000 : Math.max(60000, (Date.parse(ra) || Date.now() + 300000) - Date.now()); }
      throw er;
    }
    if (!j) throw new Error('geçersiz JSON yanıtı');
    if (j.error && !j.choices) { const er = new Error(redact(j.error.message || j.error.code || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
    let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
    if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
    if (!c && j.candidates && j.candidates[0] && j.candidates[0].content) c = j.candidates[0].content.parts.map(x => x.text || '').join('\n');
    if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.emptyResp = true; er.status = 0; throw er; }
    return { text: String(c), model: (j.model || model) };
  } catch (e) { if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(tmo / 1000) + ' sn)'); er.status = 0; throw er; } throw e; }
  finally { clearTimeout(timer); }
}
async function paceProvider(p) { const gap = AI.gapMs[p.id] || 3000; const at = Math.max(Date.now(), p.nextAt || 0); p.nextAt = at + gap; const wait = at - Date.now(); if (wait > 0) await sleep(Math.min(wait, 15000)); }
async function callProvider(p, messages, opts) {
  const now = Date.now();
  const usable = (p.models || []).filter(m => ((p.modelCooldowns && p.modelCooldowns[m]) || 0) < now);
  if (!usable.length) { const nextFree = p.models && p.models.length ? Math.min(...p.models.map(m => (p.modelCooldowns && p.modelCooldowns[m]) || 0)) : now; const waitSec = Math.ceil(Math.max(0, nextFree - now) / 1000); throw Object.assign(new Error('tüm modeller soğumada (' + waitSec + ' sn)'), { status: 404, allModelsCooldown: true }); }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await paceProvider(p); return await callProviderModel(p, messages, model, opts); }
      catch (e) {
        lastErr = e;
        if (isModelError(e)) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + (p.modelCooldownMs || 10 * M1); log('AI MODEL YOK: ' + p.name + '/' + model); break; }
        if (e && e.emptyResp) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + 5 * M1; break; }
        if (isQuotaExhausted(e)) throw e;
        if (!isTransientAIError(e) || attempt === 1) throw e;
        await sleep(Math.min(5000, 600 * Math.pow(2, attempt) + Math.round(Math.random() * 350)));
      }
    }
  }
  throw lastErr || new Error('sağlayıcı yanıt vermedi');
}

/* ── Build context + review ── */
async function buildAIContext(sig) {
  if (sig.module === 'PUMP' && sig.info && sig.info.trigger === 'scalp-break') {
    const tf0 = sig.info.tf || '3m';
    const raw0 = await getC(sig.symbol, tf0, 50, 15000);
    const cs0 = raw0 ? closed(raw0, TF_MS[tf0]).slice(-13) : [];
    if (!cs0.length) return '(veri yok)';
    const vs = avg(cs0.slice(0, -1).map(c => c.v)) || 1;
    return cs0.map(c => { const chg = (c.c / c.o - 1) * 100, up = (c.h - Math.max(c.o, c.c)) / Math.max(c.h - c.l, 1e-12) * 100, dn = (Math.min(c.o, c.c) - c.l) / Math.max(c.h - c.l, 1e-12) * 100; return new Date(c.t).toISOString().slice(11, 16) + ' değişim ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% üst fitil ' + up.toFixed(0) + '% alt fitil ' + dn.toFixed(0) + '% hacim x' + (c.v / vs).toFixed(1); }).join('\n');
  }
  if (sig.module === 'PUMP') {
    const mb = microBars(sig.symbol, Date.now(), 14);
    if (!mb) return '(veri yok)';
    return mb.map((b, k) => { const ago = (mb.length - 1 - k) * 15; const chg = b.o > 0 ? (b.c / b.o - 1) * 100 : 0; return '-' + ago + 'sn: değişim ' + (chg >= 0 ? '+' : '') + chg.toFixed(3) + '%' + (k === mb.length - 1 ? ' (oluşuyor)' : ''); }).join('\n');
  }
  const tf = sig.module === 'TREND' ? '15m' : sig.module === 'LT' ? (sig.info && sig.info.tf === '2h' ? '2h' : '4h') : '15m';
  const fetchTf = tf === '2h' ? '1h' : tf;
  const limit = tf === '15m' ? 60 : tf === '1m' ? 40 : 50;
  const raw = await getC(sig.symbol, fetchTf, limit, 2 * M1);
  let cs = raw ? closed(raw, TF_MS[fetchTf] || M15) : [];
  if (tf === '2h') cs = aggTF(cs, 120);
  if (cs.length > 25) cs = cs.slice(-25);
  return cs.map(c => { const t = new Date(c.t).toISOString().replace('T', ' ').slice(0, 16); const p = c.c >= 1 ? 4 : 6; return `${t} O${c.o.toFixed(p)} H${c.h.toFixed(p)} L${c.l.toFixed(p)} C${c.c.toFixed(p)}`; }).join('\n');
}

async function aiReview(sig, opts) {
  opts = opts || {};
  if (!sig || !AI.modules.includes(sig.module)) return null;
  if (!opts.force && sig.ai && !sig.ai.error && Date.now() - (sig.ai.at || 0) < AI.cacheMs) return sig.ai;
  if (!aiReady()) { if (!sig.ai) { sig.ai = { error: settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok', at: Date.now() }; dirty = true; } return finalizePumpAIApproval(sig, sig.ai); }
  const q = aiQuota();
  if (!q.ok) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI kotası doldu', at: Date.now() }); dirty = true; return finalizePumpAIApproval(sig, sig.ai); }
  let ctx;
  try { ctx = await buildAIContext(sig); } catch (e) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'Veri: ' + redact(e.message), at: Date.now() }); dirty = true; return finalizePumpAIApproval(sig, sig.ai); }
  const sys = (SYSTEM_PROMPTS[sig.module] || SYSTEM_PROMPTS.TREND) + '\n\n' + COMMON_JSON_HINT;
  const head = `${MODS[sig.module].label} sinyali: ${sig.base} ${sig.dir}\nFiyat: ${sig.entry}, Stop: ${sig.sl}, Hedef: ${sig.tp1}\nGüven: ${sig.conf}/100\nPiyasa: ${market.dir} (skor ${Number(market.score || 0.5).toFixed(2)})${sig.info && sig.info.tf ? '\nTF: ' + sig.info.tf : ''}`;
  const user = `${head}\n\nSon mumlar:\n${ctx}\n\n${COMMON_JSON_HINT} şemasında YALNIZCA JSON döndür.`;
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  let lastErr = null;
  const isPump = sig.module === 'PUMP';
  for (const p of orderedProviders()) {
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
    if (isPump && Date.now() >= sig.aiGate.expiresAt) break;
    if (!aiQuota().ok) break;
    if (!isPump && !aiReserveOk(AI.nonPumpShare)) break;
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, messages, isPump ? { timeoutMs: AI.pumpTimeoutMs } : null);
      const parsed = parseAIJSON(r.text);
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastLatencyMs = Date.now() - t0; p.lastError = null;
      sig.ai = Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai' });
      aiUsage.lastError = null; dirty = true; saveAI();
      log('AI: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + (sig.ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ') + ' · ' + sig.ai.phase + ' · ' + (sig.ai.confidence || 'ORTA') + ' · ' + sig.ai.score + ' (' + p.name + '/' + (r.model || '?') + ', ' + sig.ai.latencyMs + 'ms)');
      return finalizePumpAIApproval(sig, sig.ai);
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI sağlayıcıları yanıt vermedi' + (lastErr ? ': ' + redact(lastErr.message) : ''), at: Date.now() });
  aiUsage.lastError = redact(lastErr && lastErr.message || 'sağlayıcı yok'); aiUsage.lastAt = Date.now(); dirty = true; saveAI();
  return finalizePumpAIApproval(sig, sig.ai);
}

function declinePumpAI(sig, reason, note) {
  if (!sig || sig.module !== 'PUMP' || sig.status !== 'AI_BEKLIYOR') return false;
  sig.status = 'KAPALI'; sig.result = reason; sig.closedAt = Date.now(); sig.exit = null; sig.netR = null; sig.grossR = null; sig.pnlPct = null;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'REJECTED', reason, note: note || '', decidedAt: Date.now() });
  dirty = true;
  log('ALGOPUMP AI GİRİLMEZ: ' + sig.base + ' → ' + (note || reason));
  return true;
}
function finalizePumpAIApproval(sig, ai) {
  if (!sig || sig.module !== 'PUMP' || !sig.aiGate || sig.aiGate.state !== 'PENDING') return ai;
  const now = Date.now();
  if (now >= sig.aiGate.expiresAt) { declinePumpAI(sig, 'AI_TIMEOUT', 'AI onayı yetişmedi'); return null; }
  if (!ai || ai.error) { sig.aiGate = Object.assign({}, sig.aiGate, { state: 'OFFLINE', note: (ai && ai.error) || 'AI yanıtı yok', decidedAt: now }); sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + AI.approvalWindowMs; dirty = true; log('ALGOPUMP AI ÇEVRİMDIŞI: ' + sig.base + ' → ONAY BEKLİYOR'); return null; }
  const approved = (ai.verdict === 'ONY') && (ai.entryDecision === 'APPROVE') && Number(ai.score) >= AI.pumpMinScore && ai.riskLevel !== 'YÜKSEK';
  if (!approved) { declinePumpAI(sig, 'AI_RED', 'AI GİRİLMEZ ' + ai.score + (ai.reason ? ' — ' + ai.reason : '')); return null; }
  const i = sig.info || {}, d = sig.dir === 'LONG' ? 1 : -1;
  const scalp = i.trigger === 'scalp-break';
  const lvPx = entryPx(sig.symbol, sig.dir);
  if (lvPx > 0) {
    const drift = Math.abs(lvPx / sig.entry - 1) * 100;
    if (drift > (scalp ? Math.max(AI.pumpEntryDriftPct, 0.35) : AI.pumpEntryDriftPct)) { declinePumpAI(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return null; }
    sig.entry = rp(lvPx);
  }
  let stopPct, tp1Pct, tp2Pct = null, maxHoldSec, noMoveSec, quickArmPct = null, netRR, planObj;
  if (scalp) {
    stopPct = clamp(Number(ai.stopLossPct) > 0 ? Number(ai.stopLossPct) : (Number(i.slPct) || SCALPX.slMin), SCALPX.slMin, SCALPX.slMax);
    tp1Pct = clamp(Number(ai.takeProfitPct) > 0 ? Number(ai.takeProfitPct) : (Number(i.tp1Pct) || 0.5), SCALPX.tp1Min, SCALPX.tp1Max);
    tp2Pct = clamp(Number(ai.takeProfit2Pct) > 0 ? Number(ai.takeProfit2Pct) : (Number(i.tp2Pct) || tp1Pct * SCALPX.tp2Mult), tp1Pct * 1.5, 3.0);
    maxHoldSec = Math.round(clamp(Number(ai.maxHoldSec) > 0 ? Number(ai.maxHoldSec) : (SCALPX.holdMs[i.tf] || 9 * M1) / 1000, 120, 900));
    noMoveSec = Math.round(clamp(Number(ai.noMoveSec) > 0 ? Number(ai.noMoveSec) : 150, 60, Math.max(60, maxHoldSec - 60)));
    netRR = (tp1Pct - EX.H) / (stopPct + EX.H);
    if (netRR < 0.25) { declinePumpAI(sig, 'AI_RED', 'net R:R düşük'); return null; }
    planObj = { stopPct: +stopPct.toFixed(2), takeProfitPct: +tp1Pct.toFixed(2), takeProfit2Pct: +tp2Pct.toFixed(2), maxHoldSec, noMoveSec, exitStyle: 'SCALE_OUT' };
  } else {
    const hardStop = Math.max(EX.MIN_SL_PCT, EX.SL_COST_K * EX.H);
    stopPct = clamp(Number(ai.stopLossPct) > 0 ? Number(ai.stopLossPct) : (Number(i.slPct) || hardStop), hardStop, EX.TP_MAX);
    const minTp = Math.max(EX.QUICK_TP_MIN, EX.H + 0.10);
    tp1Pct = clamp(Number(ai.takeProfitPct) > 0 ? Number(ai.takeProfitPct) : (Number(i.quickTpPct) || minTp), minTp, Math.min(EX.QUICK_TP_MAX, 0.70));
    maxHoldSec = Math.round(clamp(Number(ai.maxHoldSec) > 0 ? Number(ai.maxHoldSec) : EX.HOLD, 20, 90));
    noMoveSec = Math.round(clamp(Number(ai.noMoveSec) > 0 ? Number(ai.noMoveSec) : Math.min(EX.NO_MOVE, maxHoldSec - 5), 10, Math.max(10, maxHoldSec - 5)));
    quickArmPct = +clamp(Number(ai.quickArmPct) > 0 ? Number(ai.quickArmPct) : Math.min(EX.QUICK_ARM, tp1Pct - 0.05), 0.08, Math.max(0.08, tp1Pct - 0.05)).toFixed(2);
    netRR = (tp1Pct - EX.H) / (stopPct + EX.H);
    if (netRR < 0.20) { declinePumpAI(sig, 'AI_RED', 'net R:R düşük'); return null; }
    planObj = { stopPct: +stopPct.toFixed(2), takeProfitPct: +tp1Pct.toFixed(2), maxHoldSec, noMoveSec, quickArmPct, exitStyle: ai.exitStyle };
  }
  sig.sl = rp(sig.entry * (1 - d * stopPct / 100)); sig.curSl = sig.sl;
  sig.tp1 = rp(sig.entry * (1 + d * tp1Pct / 100));
  if (scalp) { sig.tp2 = rp(sig.entry * (1 + d * tp2Pct / 100)); sig.single = false; sig.scalpMode = true; delete sig.quickTpPct; delete sig.quickTimeSec; delete sig.quickArmPct; }
  else { sig.quickTpPct = +tp1Pct.toFixed(2); sig.quickTimeSec = maxHoldSec; sig.quickArmPct = quickArmPct; }
  sig.holdSec = maxHoldSec; sig.noMoveSec = noMoveSec; sig.maxAgeMs = (maxHoldSec + 300) * 1000;
  sig.info = Object.assign({}, i, { aiStopPct: +stopPct.toFixed(2), aiTakeProfitPct: +tp1Pct.toFixed(2), aiTakeProfit2Pct: tp2Pct != null ? +tp2Pct.toFixed(2) : null, aiMaxHoldSec: maxHoldSec, aiNoMoveSec: noMoveSec, aiQuickArmPct: quickArmPct, aiExitStyle: scalp ? 'SCALE_OUT' : ai.exitStyle, aiNetRR: +netRR.toFixed(2) });
  sig.aiGate = Object.assign({}, sig.aiGate, { state: 'APPROVED', decidedAt: now, score: ai.score, trust: ai.trust || 'ORTA', reason: ai.reason || ai.summary || '', provider: ai.provider, plan: planObj });
  sig.analysis = analyzeSignal(sig); dirty = true;
  const openPump = paper.open.filter(p => p.module === 'PUMP').length + opening.size;
  const canAuto = settings.auto === true && openPump < AI.autoMaxOpen;
  if (canAuto) {
    sig.status = 'AKTIF'; sig.startedAt = now; sig.operatorApprovedAt = now;
    log('ALGOPUMP AI GİRİLİR (OTO): ' + sig.base + ' ' + sig.dir + ' | TP1 %' + tp1Pct.toFixed(2) + ' SL %' + stopPct.toFixed(2));
    maybeOpenPaper(sig).then(err => { if (err) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI.approvalWindowMs; delete sig.startedAt; delete sig.operatorApprovedAt; dirty = true; log('ALGOPUMP OTO AÇILAMADI: ' + sig.base + ' → ' + err); } }).catch(e => log('HATA oto: ' + e.message));
  } else {
    sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + AI.approvalWindowMs;
    log('ALGOPUMP AI GİRİLİR (ONAY): ' + sig.base + ' ' + sig.dir + ' → ONAY BEKLİYOR (sebep: ' + (settings.auto !== true ? 'oto kapalı' : 'max açık') + ')');
  }
  return ai;
}

function queueAI(sig, opts) { if (!sig || !AI.modules.includes(sig.module) || !aiReady()) return; if (AI_QUEUE.some(x => x.id === sig.id)) return; if (sig.module === 'PUMP') { aiReview(sig, opts || {}).catch(e => log('AI PUMP HATA: ' + redact(e.message))); return; } AI_QUEUE.push({ id: sig.id, force: !!(opts && opts.force), at: Date.now() }); if (AI_QUEUE.length > 40) AI_QUEUE.splice(40); runAIQueue(); }
async function runAIQueue() { if (aiBusy) return; aiBusy = true; try { while (AI_QUEUE.length) { const job = AI_QUEUE.shift(), sig = signals.find(s => s.id === job.id); if (!sig) continue; try { await aiReview(sig, { force: job.force }); } catch (e) { log('AI KUYRUK: ' + redact(e.message)); } } } finally { aiBusy = false; } }

/* ── SNAP / RING / OI ── */
const SNAP = {};
const OI = new Map();
const RING = new Map();
const FLOW = new Map();
const ATRC = new Map();
const ARMED = new Set();
const lastBurstChk = {};

function snapAt(h, t) { if (!h || !h.length) return null; let lo = 0, hi = h.length - 1, res = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m].t <= t) { res = m; lo = m + 1; } else hi = m - 1; } return res >= 0 ? h[res] : null; }
function pushSnap(sym, ts, price, qv) { if (!(price > 0)) return; let h = SNAP[sym]; if (!h) h = SNAP[sym] = []; const last = h[h.length - 1]; if (last && ts - last.t < 900) { last.p = price; if (qv != null) last.qv = Number(qv); return; } h.push({ t: ts, p: price, qv: qv != null ? Number(qv) : null }); const cut = ts - PUMP.snapKeepMs; let drop = 0; while (drop < h.length && h[drop].t < cut) drop++; if (drop > 64) h.splice(0, drop); }
function pushOI(sym, ts, v) { if (!(v > 0)) return; let a = OI.get(sym); if (!a) { a = []; OI.set(sym, a); } const last = a[a.length - 1]; if (last && ts - last.t < 5000) { last.v = v; return; } a.push({ t: ts, v }); const cut = ts - 15 * M1; let drop = 0; while (drop < a.length && a[drop].t < cut) drop++; if (drop > 16) a.splice(0, drop); if (a.length > 400) a.splice(0, a.length - 400); }
function oiChg(sym, ms) { const a = OI.get(sym); if (!a || a.length < 2) return null; const now = a[a.length - 1]; let ref = null; for (const x of a) { if (x.t >= now.t - ms) { ref = x; break; } } if (!ref || ref === now || !(ref.v > 0)) return null; return (now.v / ref.v - 1) * 100; }
function ringOf(sym) { let r = RING.get(sym); if (!r) { r = { t: [], p: [] }; RING.set(sym, r); } return r; }
function ringPush(sym, ts, price) { if (!(price > 0) || !isFinite(price)) return; const r = ringOf(sym); const n = r.p.length; if (n && ts <= r.t[n - 1]) { r.p[n - 1] = price; return; } r.p.push(price); r.t.push(ts); const cut = ts - EX.VEL_PEAK_MEMORY_MS; let drop = 0; while (drop < r.t.length && r.t[drop] < cut) drop++; if (drop > 64) { r.t.splice(0, drop); r.p.splice(0, drop); } if (r.p.length > 2000) { r.t.splice(0, 400); r.p.splice(0, 400); } }
function ringAt(r, ts) { const t = r.t; let lo = 0, hi = t.length - 1, res = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res >= 0 ? r.p[res] : null; }
function ringMove(r, winMs, now) { const n = r.p.length; if (n < 2) return 0; const ref = ringAt(r, now - winMs); if (!(ref > 0)) return 0; return (r.p[n - 1] / ref - 1) * 100; }
function flowOf(sym) { let f = FLOW.get(sym); if (!f) { f = { b: Object.create(null), last: 0 }; FLOW.set(sym, f); } return f; }
function flowOnTrade(sym, ts, notional) { if (!(notional > 0) || !isFinite(notional)) return; const f = flowOf(sym); const k = Math.floor(ts / 1000) * 1000; f.b[k] = (f.b[k] || 0) + notional; if (ts > f.last) f.last = ts; }
function flowBurst(sym, now) { const f = FLOW.get(sym); if (!f) return null; const nowB = Math.floor(now / 1000) * 1000; let recent = 0; for (let k = nowB - 3000; k <= nowB; k += 1000) recent += f.b[k] || 0; const from = nowB - 60000, to = nowB - 10000; let baseSum = 0, baseBuckets = 0; for (let k = from; k < to; k += 1000) { baseSum += f.b[k] || 0; baseBuckets++; } if (baseBuckets < 20) return null; const basePerShort = (baseSum / baseBuckets) * 3; if (!(basePerShort > 0)) return null; return recent / basePerShort; }
function qvBurst(sym, now) { const s = SNAP[sym]; if (!s || s.length < 12) return null; const last = s[s.length - 1]; const a = snapAt(s, now - 3000); const c = snapAt(s, now - 60000); const d = snapAt(s, now - 10000); if (!a || !c || !d) return null; if (a.qv == null || last.qv == null || c.qv == null || d.qv == null) return null; const recentMs = last.t - a.t, baseSpan = d.t - c.t; if (!(recentMs > 400) || !(baseSpan > 20000)) return null; const recentFlow = (last.qv - a.qv) / recentMs; const baseFlow = (d.qv - c.qv) / baseSpan; if (!(baseFlow > 0) || !(recentFlow > 0)) return null; return recentFlow / baseFlow; }
function volumeBurst(sym, now) { const f = flowBurst(sym, now); if (f != null && isFinite(f)) return f; return qvBurst(sym, now); }
function priorRunPct(sym, now, d, ms) { const s = SNAP[sym]; if (!s || s.length < 6) return 0; const a = snapAt(s, now - ms); const end = snapAt(s, now - 20000); if (!a || !end || !(a.p > 0)) return 0; return (end.p / a.p - 1) * d * 100; }
function microBars(sym, now, count) {
  const s = SNAP[sym]; if (!s || s.length < 8) return null;
  const B = PUMP.barMs, out = [];
  for (let i = 0; i < s.length; i++) {
    const x = s[i]; if (!(x.p > 0)) continue;
    const b = Math.floor(x.t / B) * B;
    const last = out[out.length - 1];
    if (!last || last.t !== b) { out.push({ t: b, o: x.p, h: x.p, l: x.p, c: x.p, qv0: x.qv, qv1: x.qv, n: 1, trunc: false }); }
    else { if (x.p > last.h) last.h = x.p; if (x.p < last.l) last.l = x.p; last.c = x.p; if (x.qv != null) last.qv1 = x.qv; last.n++; }
  }
  if (!out.length) return null;
  if (s[0].t > out[0].t + 1) out[0].trunc = true;
  const tail = out.slice(-(count || 40));
  return tail.length ? tail : null;
}
function zOf(sym, now, winMs) {
  const s = SNAP[sym]; if (!s || s.length < 24) return 0;
  const a = snapAt(s, now - winMs); const last = s[s.length - 1];
  if (!a || !(a.p > 0) || now - a.t > winMs + 2500) return 0;
  const move = Math.abs(last.p / a.p - 1) * 100;
  const cutoff = now - winMs, floor = now - 60000;
  let n = 0, mean = 0, m2 = 0, dtSum = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].t > cutoff) break;
    if (s[i].t < floor) continue;
    const p0 = s[i - 1].p, p1 = s[i].p;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = (p1 / p0 - 1) * 100;
    n++;
    const d = r - mean;
    mean += d / n; m2 += d * (r - mean); dtSum += Math.max(1, s[i].t - s[i - 1].t);
  }
  if (n < PUMP.vel.minNoiseN) return 0;
  const sd = Math.sqrt(m2 / Math.max(1, n - 1));
  const dt = Math.max(250, dtSum / n);
  return move / Math.max(sd * Math.sqrt(winMs / dt), 0.03);
}
function ignition(sym, now) {
  const mb = microBars(sym, now, 40);
  if (!mb || mb.length < PUMP.coilBars + 2) return null;
  const f = mb[mb.length - 1];
  const ctx = mb.slice(0, -1).filter(b => !b.trunc);
  if (ctx.length < PUMP.coilBars) return null;
  const win = ctx.slice(-PUMP.coilBars);
  let hiN = -Infinity, loN = Infinity;
  for (let i = 0; i < win.length; i++) { if (win[i].h > hiN) hiN = win[i].h; if (win[i].l < loN) loN = win[i].l; }
  if (!(loN > 0) || !(hiN > loN)) return null;
  const preRng = (hiN / loN - 1) * 100;
  if (preRng > PUMP.coilMaxPct) return null;
  const rng = f.h - f.l; if (!(rng > 0)) return null;
  const body = (f.c - f.o) / rng;
  const up = f.c > hiN && body >= PUMP.bodyMin;
  const dn = f.c < loN && body <= -PUMP.bodyMin;
  if (!up && !dn) return null;
  const dir = up ? 'LONG' : 'SHORT'; const d = up ? 1 : -1;
  const origin = up ? hiN : loN;
  const disp = (f.c / origin - 1) * d * 100;
  if (!(disp >= PUMP.dispMinPct)) return null;
  const vBurst = volumeBurst(sym, now);
  if (vBurst == null) { PWHY['veri yok (hacim)'] = (PWHY['veri yok (hacim)'] || 0) + 1; return null; }
  if (vBurst < PUMP.vel.minVolRatio) return null;
  const z = zOf(sym, now, 4000);
  if (z < PUMP.vel.minZ) return null;
  const priorRun = priorRunPct(sym, now, d, 90000);
  if (priorRun > PUMP.vel.priorMaxPct) return null;
  return { dir, origin, disp, z, vBurst, preRng, body: Math.abs(body), priorRun };
}
function entryGuard(sym, ig) {
  if (PUMP.macroFilter && market.dir !== 'NOTR' && ig.dir !== market.dir) {
    const strongL = market.dir === 'LONG' && market.score > 0.75, strongS = market.dir === 'SHORT' && market.score < 0.25;
    if (strongL || strongS) return { ok: false, reject: 'ters' };
  }
  const bk = bookOf(sym); if (!bk) return { ok: false, reject: 'no-book' };
  if (!(bk.ask > 0) || !(bk.bid > 0) || !(bk.ask >= bk.bid)) return { ok: false, reject: 'bad-book' };
  const spreadPct = ((bk.ask - bk.bid) / bk.last) * 100;
  if (!(spreadPct <= PUMP.maxSpreadPct)) return { ok: false, reject: 'spread' };
  const d = ig.dir === 'LONG' ? 1 : -1;
  const fill = ig.dir === 'LONG' ? bk.ask : bk.bid;
  const latePct = (fill / ig.origin - 1) * d * 100;
  if (!(latePct > -0.05)) return { ok: false, reject: 'stale-origin' };
  const A = expectedLeg(sym); if (A == null) return { ok: false, reject: 'no-atr' };
  const oi1 = oiChg(sym, 60000), oi5 = oiChg(sym, 5 * M1);
  if (oi1 != null && oi1 < -2.0) return { ok: false, reject: 'oi-dusuyor' };
  const cap = PUMP.vel.dynamicLateCap ? clamp(PUMP.vel.lateCapFrac * A, PUMP.vel.lateCapMin, PUMP.vel.lateCapMax) : PUMP.vel.maxLatePct;
  if (latePct > cap) return { ok: false, reject: 'late' };
  if (A - latePct < PUMP.vel.minEdgeMult * EX.H) return { ok: false, reject: 'no-edge' };
  const atrPct = atrPctOf(sym);
  const slRaw = ig.dir === 'LONG' ? ig.origin * (1 - PUMP.vel.slBufferPct / 100) : ig.origin * (1 + PUMP.vel.slBufferPct / 100);
  const slStruct = Math.abs(fill - slRaw) / fill * 100;
  const slFloor = Math.max(EX.MIN_SL_PCT, PUMP.vel.slAtrK * atrPct, PUMP.vel.slCostK * EX.H);
  const slPct = Math.min(Math.max(slStruct, slFloor), PUMP.vel.slMax);
  const sl = fill * (1 - d * slPct / 100);
  const tpPct = clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX);
  const tp = fill * (1 + d * tpPct / 100);
  const netRR = (tpPct - EX.H) / (slPct + EX.H);
  if (netRR < PUMP.vel.minNetRR) return { ok: false, reject: 'net-rr' };
  if (spreadPct > 0.40 * slPct) return { ok: false, reject: 'spread-wide' };
  return { ok: true, dir: ig.dir, fill: rp(fill), sl: rp(sl), tp: rp(tp), latePct: +latePct.toFixed(3), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2), slStruct: +slStruct.toFixed(2), slFloor: +slFloor.toFixed(2), atrPct: +atrPct.toFixed(2), netRR: +netRR.toFixed(2), A: +A.toFixed(2), spreadPct: +spreadPct.toFixed(3), originPx: rp(ig.origin), oi1: oi1 != null ? +oi1.toFixed(2) : null, oi5: oi5 != null ? +oi5.toFixed(2) : null };
}
function scoreConfidence(ig, g) {
  const c = 60 + clamp((ig.z - PUMP.vel.minZ) * 2.0, 0, 12) + clamp((ig.vBurst - PUMP.vel.minVolRatio) * 3.0, 0, 12) + clamp((g.A - g.latePct - PUMP.vel.minEdgeMult * EX.H) * 6, 0, 8) + clamp((PUMP.coilMaxPct - ig.preRng) * 4, 0, 5) + clamp((g.netRR - PUMP.vel.minNetRR) * 6, 0, 5);
  return clamp(Math.round(c), 40, 95);
}
function pumpScanVel(now) {
  if (!ARMED.size) return;
  for (const sym of ARMED) {
    const prev = lastBurstChk[sym]; if (prev && now - prev < PUMP.recheckMs) continue;
    const ig = ignition(sym, now); if (!ig) continue;
    stats.pumpScanned++;
    lastBurstChk[sym] = now;
    const g = entryGuard(sym, ig);
    if (!g.ok) { PWHY['guard:' + g.reject] = (PWHY['guard:' + g.reject] || 0) + 1; continue; }
    const quickTpPct = quickTpOf(g.atrPct);
    const quickNetRR = quickTpPct != null ? +((quickTpPct - EX.H) / (g.slPct + EX.H)).toFixed(2) : null;
    const det = {
      module: 'PUMP', symbol: sym, dir: g.dir, entry: g.fill, sl: g.sl, tp1: g.tp, tp2: null, single: true,
      conf: scoreConfidence(ig, g), holdSec: EX.HOLD, noMoveSec: EX.NO_MOVE, maxAgeMs: (EX.HOLD + 30) * 1000,
      quickTpPct, quickTimeSec: quickTpPct != null ? EX.QUICK_TIME : null, quickArmPct: quickTpPct != null ? EX.QUICK_ARM : null, atrPct: g.atrPct,
      info: { tf: 'ignition', trigger: 'coil-break', originPx: g.originPx, latePct: g.latePct, disp: +ig.disp.toFixed(3), z: +ig.z.toFixed(1), vBurst: +ig.vBurst.toFixed(2), preRng: +ig.preRng.toFixed(2), body: +ig.body.toFixed(2), spreadPct: g.spreadPct, slPct: g.slPct, tpPct: g.tpPct, quickTpPct, quickTimeSec: quickTpPct != null ? EX.QUICK_TIME : null, quickNetRR, slStruct: g.slStruct, slFloor: g.slFloor, atrPct: g.atrPct, netRR: g.netRR, expectedLeg: g.A, oi1: g.oi1, oi5: g.oi5, lastPx: rp(bookOf(sym).last) }
    };
    addSignal(det);
  }
}
function snapMove(h, now, ms) { let ref = null; for (let i = 0; i < h.length; i++) { if (h[i].t >= now - ms - 2500) { ref = h[i]; break; } } if (!ref || now - ref.t < ms * 0.6) return null; return (h[h.length - 1].p / ref.p - 1) * 100; }
function pumpCandidates(now) {
  const out = [];
  for (const sym of ALL) {
    const tk = TICK[sym], h = SNAP[sym];
    if (!tk || !h || h.length < 5 || quoteVolOf(tk) < PUMP.minQuoteVol) continue;
    if (lastBurstChk[sym] && now - lastBurstChk[sym] < PUMP.recheckMs) continue;
    const m30 = snapMove(h, now, 30000), m60 = snapMove(h, now, 60000), m150 = snapMove(h, now, 150000);
    const score = Math.max(Math.abs(m30 || 0) / PUMP.pre30, Math.abs(m60 || 0) / PUMP.pre60, Math.abs(m150 || 0) / PUMP.pre150);
    if (score >= 1) out.push({ sym, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, PUMP.maxCand);
}
async function pumpScanCandle(now) {
  const list = pumpCandidates(now); if (!list.length) return;
  await pool(list, 5, async c => {
    const sym = c.sym; lastBurstChk[sym] = now;
    const tk = TICK[sym];
    if (tk && tk.bid && tk.ask) { const sp = (tk.ask - tk.bid) / tk.last * 100; if (sp > PUMP.maxSpreadPct) { PWHY['spread geniş'] = (PWHY['spread geniş'] || 0) + 1; return; } }
    const raw = await getC(sym, '1m', 60, 0);
    const tNow = Date.now();
    if (!raw || raw.length < 45 || tNow - raw[raw.length - 1].t > 2 * M1) { PWHY['veri yok/bayat'] = (PWHY['veri yok/bayat'] || 0) + 1; return; }
    stats.pumpScanned++;
    let det = detectBurst(raw, M1, tNow, PWHY);
    if (!det) det = detectBurst(aggTF(raw, 3), M3, tNow, PWHY);
    if (!det) return;
    if (PUMP.macroFilter) { if (market.dir === 'SHORT' && market.score < 0.35 && det.dir === 'LONG') return; if (market.dir === 'LONG' && market.score > 0.65 && det.dir === 'SHORT') return; }
    const px = priceOf(sym) || det.entry, d = det.dir === 'LONG' ? 1 : -1;
    const bk = bookOf(sym), fillPx = bk ? (det.dir === 'LONG' ? bk.ask : bk.bid) : px;
    det.entry = rp(fillPx); det.sl = rp(fillPx * (1 - d * det.info.slPct / 100)); det.tp1 = rp(fillPx * (1 + d * det.info.tpPct / 100));
    det.info.lastPx = rp(px); det.info.spreadPct = bk ? +((bk.ask - bk.bid) / px * 100).toFixed(3) : null;
    det.atrPct = atrPctOf(sym);
    addSignal(Object.assign({ module: 'PUMP', symbol: sym }, det));
  });
}
function pumpCycle() { const now = Date.now(); if (PUMP.useIgnition) pumpScanVel(now); if (PUMP.useCandlePath) pumpScanCandle(now).catch(e => log('HATA pumpScanCandle: ' + e.message)); pumpManage(now).catch(e => log('HATA pumpManage: ' + e.message)); }
const ARM_SEEN = new Map();
function refreshArmed() {
  const now = Date.now();
  for (const sym of ALL) {
    const tk = TICK[sym]; if (!tk || !(tk.last > 0)) continue;
    if (!(quoteVolOf(tk) >= PUMP.minQuoteVol)) continue;
    const bid = tk.bid > 0 ? tk.bid : tk.last, ask = tk.ask > 0 ? tk.ask : tk.last;
    if (!(ask >= bid)) continue;
    if (((ask - bid) / tk.last) * 100 > PUMP.maxSpreadPct) continue;
    const s = SNAP[sym]; if (!s || s.length < PUMP.vel.minHist) continue;
    ARM_SEEN.set(sym, now);
  }
  ARMED.clear();
  for (const [sym, ts] of ARM_SEEN) { if (now - ts > 180000) { ARM_SEEN.delete(sym); continue; } const s = SNAP[sym]; if (s && s.length >= PUMP.vel.minHist) ARMED.add(sym); }
  stream.setSymbols(ARMED);
  log('ARMED: ' + ARMED.size + ' sembol');
}
function atrPctFromCandles(cs, p) {
  p = p || 14; if (!cs || cs.length < p + 2) return null;
  let s = 0;
  for (let i = 1; i <= p; i++) { const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); s += tr; }
  let a = s / p;
  for (let i = p + 1; i < cs.length; i++) { const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); a = (a * (p - 1) + tr) / p; }
  const c = cs[cs.length - 1].c;
  return c > 0 ? (a / c) * 100 : null;
}
function setAtr(sym, atrPct, now) { if (!(atrPct > 0)) return; ATRC.set(sym, { atrPct: clamp(atrPct, 0.05, 8), at: now || Date.now() }); }
function atrPctOf(sym) { const a = ATRC.get(sym); return a && a.atrPct > 0 && Date.now() - a.at < 5 * M1 ? a.atrPct : 0.55; }
function expectedLeg(sym) { const a = ATRC.get(sym); if (!a || !(a.atrPct > 0) || Date.now() - a.at > 5 * M1) return null; return clamp(EX.TP_ATR_K * a.atrPct, 0.35, 3.0); }
async function refreshAtr() {
  const q = Array.from(ARMED);
  const workers = Array.from({ length: Math.min(6, q.length) }, async () => { while (q.length) { const sym = q.pop(); try { const raw = await ex.fetchOHLCV(sym, '1m', undefined, 40); if (!raw || raw.length < 20) continue; const cs = raw.map(toC); const pct = atrPctFromCandles(cs, 14); if (pct) setAtr(sym, pct); } catch (e) { } } });
  await Promise.all(workers);
}
const ARM_CTX = new Map();
async function armSymbol(sym, lev) { const c = ARM_CTX.get(sym) || {}; if (c.levSetAt && c.lev === lev && Date.now() - c.levSetAt < 10 * M1) return c; try { await ex.setMarginMode('isolated', sym); } catch (e) { } await ex.setLeverage(lev, sym); c.lev = lev; c.levSetAt = Date.now(); ARM_CTX.set(sym, c); return c; }
async function refreshLeverageArms() { if (settings.tradeMode !== 'live' || !IS_LIVE_READY) return; const lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE); for (const sym of ARMED) { try { await armSymbol(sym, lev); } catch (e) { } } }
function prunePumpState(now) {
  for (const sym of Object.keys(SNAP)) { const h = SNAP[sym]; if (!h.length || now - h[h.length - 1].t > 10 * M1) delete SNAP[sym]; }
  for (const [sym, r] of RING) { let drop = 0; const cut = now - EX.VEL_PEAK_MEMORY_MS; while (drop < r.t.length && r.t[drop] < cut) drop++; if (drop) { r.t.splice(0, drop); r.p.splice(0, drop); } if (!r.p.length) RING.delete(sym); }
  for (const [sym, f] of FLOW) { const cut = now - 62000; for (const k of Object.keys(f.b)) if (Number(k) < cut) delete f.b[k]; if (!Object.keys(f.b).length) FLOW.delete(sym); }
  for (const [sym, t] of DAILY_ASKED) if (now - t > 2 * H1) DAILY_ASKED.delete(sym);
  for (const [sym, t] of LAST_REJ_BY_SYM) if (now - t.t > 2 * H1) LAST_REJ_BY_SYM.delete(sym);
}

/* ── WS stream ── */
function getWS() { if (globalThis.WebSocket) return globalThis.WebSocket; try { return require('ws'); } catch (e) { return null; } }
class BitgetStream {
  constructor(url) { this.url = url || 'wss://ws.bitget.com/v2/ws/public'; this.ws = null; this.subs = new Set(); this.backoff = 1000; this.pingTimer = null; this.reconnectTimer = null; this.closed = false; }
  start() {
    const WS = getWS(); if (!WS) { log('WS yok → REST ticker yedeği'); return; }
    this.closed = false;
    try { this.ws = new WS(this.url); } catch (e) { log('WS açılamadı: ' + e.message); return; }
    this.ws.onopen = () => { this.backoff = 1000; log('WS bağlandı (' + this.subs.size + ' kanal)'); this._flush(); this.pingTimer = setInterval(() => this._send('ping'), 25000); };
    this.ws.onmessage = ev => { const raw = typeof ev === 'string' ? ev : (ev && ev.data); if (!raw || raw === 'pong' || raw === 'ping') return; let msg; try { msg = JSON.parse(raw); } catch (e) { return; } this._onMsg(msg); };
    this.ws.onerror = () => { };
    this.ws.onclose = () => { clearInterval(this.pingTimer); this.pingTimer = null; if (this.closed) return; this.backoff = Math.min(this.backoff * 2, 30000); log('WS koptu, ' + (this.backoff / 1000) + ' sn sonra yeniden'); this.reconnectTimer = setTimeout(() => this.start(), this.backoff); };
  }
  stop() { this.closed = true; clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); try { if (this.ws) this.ws.close(); } catch (e) { } }
  _send(o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { } }
  _args(keys) { return keys.map(k => { const a = k.split('|'); return { instType: 'USDT-FUTURES', channel: a[0], instId: a[1] }; }); }
  _batch(keys) { for (let i = 0; i < keys.length; i += 20) this._send({ op: 'subscribe', args: this._args(keys.slice(i, i + 20)) }); }
  _flush() { if (this.subs.size) this._batch(Array.from(this.subs)); }
  setSymbols(symbols) {
    const want = new Set();
    for (const sym of symbols) { const inst = String(sym).split('/')[0] + 'USDT'; want.add('ticker|' + inst); want.add('trade|' + inst); }
    for (const k of Array.from(this.subs)) { if (want.has(k)) continue; this.subs.delete(k); this._send({ op: 'unsubscribe', args: this._args([k]) }); }
    const add = [];
    for (const k of want) if (!this.subs.has(k)) { this.subs.add(k); add.push(k); }
    if (add.length) this._batch(add);
  }
  _onMsg(msg) {
    if (msg.op === 'pong' || msg.op === 'ping') return;
    if (msg.event === 'error' || (msg.code && String(msg.code) !== '0')) { log('WS hata: ' + (msg.msg || msg.code)); return; }
    const arg = msg.arg, data = msg.data;
    if (!arg || !Array.isArray(data)) return;
    const sym = String(arg.instId).replace(/USDT$/, '') + '/USDT:USDT';
    const now = Date.now();
    if (arg.channel === 'ticker') { for (const d of data) ingestTicker(sym, d, now); }
    else if (arg.channel === 'trade') { for (const d of data) ingestTrade(sym, d); }
  }
}
const stream = new BitgetStream();
const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
function ingestTicker(sym, d, now) {
  const last = num(d.lastPr); if (!(last > 0)) return;
  const prev = TICK[sym] || {};
  const bid = num(d.bidPr) || last, ask = num(d.askPr) || last;
  const qv = num(d.quoteVolume) || prev.quoteVolume || 0;
  const oi = num(d.holdingAmount) || prev.oi || null;
  TICK[sym] = { last, bid, ask, quoteVolume: qv, percentage: d.change24h != null ? num(d.change24h) : (prev.percentage || 0), timestamp: now, oi };
  pushSnap(sym, now, last, qv); pushOI(sym, now, oi); ringPush(sym, now, last);
}
function ingestTrade(sym, d) { const price = num(d.price), size = num(d.size); if (!(price > 0) || !(size > 0)) return; flowOnTrade(sym, num(d.ts) || Date.now(), price * size); }

/* ── Paper/live ── */
const opening = new Set();
const bookOf = sym => { const t = TICK[sym]; if (!t || !t.last) return null; const bid = t.bid > 0 ? t.bid : t.last, ask = t.ask > 0 ? t.ask : t.last; return { last: t.last, bid, ask, approx: !(t.bid > 0 && t.ask > 0) }; };
const entryPx = (sym, dir) => { const b = bookOf(sym); return b ? (dir === 'LONG' ? b.ask : b.bid) : null; };
const exitPx = o => { const b = bookOf(o.symbol); return b ? (o.dir === 'LONG' ? b.bid : b.ask) : null; };
function paperPnl(p, price) { const d = p.dir === 'LONG' ? 1 : -1; const part = p.tp1Hit && !p.single ? 0.5 * (p.tp1 / p.entry - 1) + 0.5 * (price / p.entry - 1) : price / p.entry - 1; let pnl = p.notional * part * d - p.notional * FEE_SIDE * 2; if (pnl < -p.margin) pnl = -p.margin; return { pnl, pct: pnl / p.margin * 100 }; }
function dailyLossBreached() { if (!(settings.dailyLossPct > 0)) return false; if (settings.tradeMode === 'live') return paper.liveDayStart > 0 && (paper.liveDayPnl || 0) <= -(paper.liveDayStart * settings.dailyLossPct / 100); return paper.balance <= paper.dayStart * (1 - settings.dailyLossPct / 100); }
function checkDailyLoss() {
  const key = new Date().toISOString().slice(0, 10);
  if (paper.dayKey !== key) { paper.dayKey = key; paper.dayStart = paper.balance; paper.liveDayPnl = 0; paper.liveDayStart = realBal.total || 0; dirty = true; }
  if (!(settings.dailyLossPct > 0)) return;
  if (dailyLossBreached() && settings.auto) { settings.auto = false; saveSettings(); log((settings.tradeMode === 'live' ? 'LIVE' : 'PAPER') + ': günlük zarar limiti aşıldı, oto KAPATILDI'); }
}

let liveInited = false;
async function liveInit() { if (liveInited) return; try { await ex.setPositionMode(false); } catch (e) { log('UYARI: tek yönlü mod (' + e.message + ')'); } liveInited = true; }
async function liveSetup(sym, lev) { try { await ex.setMarginMode('isolated', sym); } catch (e) { } await ex.setLeverage(lev, sym); }
async function placeStop(sym, side, amount, price) {
  let lastErr = null;
  for (const params of [{ stopLossPrice: price, reduceOnly: true }, { triggerPrice: price, reduceOnly: true }]) {
    for (let i = 0; i < 2; i++) { try { const o = await ex.createOrder(sym, 'market', side, amount, undefined, params); if (o && o.id) return o.id; lastErr = new Error('stop id yok'); } catch (e) { lastErr = e; await sleep(250); } }
  }
  throw lastErr || new Error('stop kurulamadı');
}
async function emergencyClose(sym, side, amount) { for (let i = 0; i < 4; i++) { try { await ex.createOrder(sym, 'market', side, amount, undefined, { reduceOnly: true }); return true; } catch (e) { await sleep(400); } } return false; }
async function fillOf(order, sym) { let f = Number(order && order.average) || Number(order && order.price) || 0; if (!f && order && order.id) { try { const o2 = await ex.fetchOrder(order.id, sym); f = Number(o2.average) || Number(o2.price) || 0; } catch (e) { } } return f; }
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
  if (!(Number(amount) > 0) || Number(amount) * entryHint < 5) throw new Error('miktar/notional çok küçük');
  const order = await ex.createOrder(sig.symbol, 'market', side, amount);
  const fill = (await fillOf(order, sig.symbol)) || entryHint;
  const qty = Number(order.filled) > 0 ? ex.amountToPrecision(sig.symbol, order.filled) : amount;
  let stopId = null;
  try { stopId = await placeStop(sig.symbol, slSide, qty, sig.sl); }
  catch (e) { log('LIVE STOP KURULAMADI (' + sig.base + '): ' + e.message); if (await emergencyClose(sig.symbol, slSide, qty)) { log('LIVE: ' + sig.base + ' korumasız kapatıldı'); throw new Error('Stop kurulamadı, kapatıldı'); } log('ACİL: ' + sig.base + ' KORUMASIZ!'); }
  const notional = Number(qty) * fill;
  const p = {
    id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir, entry: rp(fill), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, scalp: !!sig.scalpMode, tf: sig.info && sig.info.tf, startedAt: Date.now(), isLive: true, amount: qty, stopId, unprotected: !stopId, holdSec: sig.holdSec, noMoveSec: sig.noMoveSec, atrPct: sig.atrPct, quickTpPct: sig.quickTpPct, quickTimeSec: sig.quickTimeSec, quickArmPct: sig.quickArmPct, margin: +(notional / lev).toFixed(2), leverage: lev, notional, conf: sig.conf, aiScore: sig.ai && sig.ai.score, aiPlan: sig.aiGate && sig.aiGate.plan, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
  };
  paper.open.push(p); dirty = true;
  log('LIVE AÇILDI: ' + p.base + ' ' + p.dir + ' | dolum ' + fmtP(fill) + ' | miktar ' + qty + ' | ' + lev + 'x | stop ' + fmtP(p.sl) + (stopId ? '' : ' (STOP YOK!)'));
  return p;
}
async function liveClose(p) {
  const side = p.dir === 'LONG' ? 'sell' : 'buy';
  const o = await ex.createOrder(p.symbol, 'market', side, p.amount, undefined, { reduceOnly: true });
  const fill = await fillOf(o, p.symbol);
  if (p.stopId) { const ok = await cancelStopOrder(p); if (!ok) log('UYARI: ' + p.base + ' stop iptal edilemedi'); }
  return fill || null;
}
async function syncLive() {
  if (!IS_LIVE_READY) return;
  const lives = paper.open.filter(p => p.isLive && !p.closing && Date.now() - p.openedAt > 8000);
  if (!lives.length) return;
  let poss;
  try { poss = await ex.fetchPositions(lives.map(p => p.symbol)); } catch (e) { return; }
  if (!Array.isArray(poss)) return;
  const has = new Set(poss.filter(x => Math.abs(Number(x.contracts) || 0) > 0).map(x => x.symbol));
  for (const p of lives) { if (has.has(p.symbol)) continue; log('LIVE: ' + p.base + ' borsada kapalı → yerelde kapatılıyor'); p.extClosed = true; await closePaper(p, p.curSl || p.sl, 'SL'); }
}

async function maybeOpenPaper(sig) {
  if (!sig || sig.module !== 'PUMP') return 'Sadece PUMP';
  if (sig.status !== 'AKTIF') return 'Sinyal aktif değil';
  if (!sig.aiGate || !['APPROVED', 'OFFLINE'].includes(sig.aiGate.state)) return 'AI onayı yok';
  if (sig.ai && sig.ai.entryDecision === 'REJECT') return 'AI GİRİLMEZ';
  checkDailyLoss();
  if (dailyLossBreached()) return 'Günlük zarar limiti';
  if (paper.open.some(p => p.symbol === sig.symbol) || opening.has(sig.symbol)) return 'Bu coinde zaten açık';
  if (paper.open.length + opening.size >= settings.maxOpen) return 'Max açık işlem (' + settings.maxOpen + ')';
  const live = settings.tradeMode === 'live', d = sig.dir === 'LONG' ? 1 : -1, entry = sig.entry * (1 + d * PAPER_SLIP);
  let lev = settings.leverage, eq = paper.balance, margin = Math.min(settings.margin, paper.balance);
  if (live) {
    if (!IS_LIVE_READY) return 'API anahtarı eksik';
    if (Date.now() - realBal.updatedAt > 3 * M1 || !(realBal.free > 0)) return 'Gerçek bakiye okunamadı';
    lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE); eq = realBal.total; margin = Math.min(settings.margin, LIVE_MAX_MARGIN, realBal.free * 0.9);
  }
  const slDist = Math.abs(entry - sig.sl) / entry;
  if (settings.riskPct > 0 && slDist > 0 && eq > 0) margin = Math.min(margin, (eq * settings.riskPct / 100) / slDist / lev);
  margin = +margin.toFixed(2);
  if (margin < (live ? 2 : 10)) return 'Boyut yetersiz (' + margin + ')';
  opening.add(sig.symbol);
  try {
    if (!live) {
      const p = { id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir, entry: rp(entry), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, scalp: !!sig.scalpMode, tf: sig.info && sig.info.tf, isLive: false, atrPct: sig.atrPct, velSeries: [], startedAt: Date.now(), holdSec: sig.holdSec, noMoveSec: sig.noMoveSec, quickTpPct: sig.quickTpPct, quickTimeSec: sig.quickTimeSec, quickArmPct: sig.quickArmPct, margin, leverage: lev, notional: margin * lev, conf: sig.conf, aiScore: sig.ai && sig.ai.score, aiPlan: sig.aiGate && sig.aiGate.plan, openedAt: Date.now(), lastTs: 0, status: 'ACIK' };
      paper.open.push(p); dirty = true;
      log('PAPER AÇILDI: ' + p.base + ' ' + p.dir + ' | ' + fmtP(p.entry) + ' | SL %' + (sig.info.aiStopPct || sig.info.slPct || '?') + ' | TP1 %' + (sig.info.aiTakeProfitPct || sig.quickTpPct || '?') + (sig.scalpMode ? ' / TP2 %' + sig.info.aiTakeProfit2Pct : '') + ' | ' + margin.toFixed(0) + ' USDT | ' + lev + 'x');
    } else await openLive(sig, margin, lev, entry);
    return null;
  } catch (e) { log((live ? 'LIVE' : 'PAPER') + ' HATA (' + sig.base + '): ' + e.message); return e.message || 'İşlem açılamadı'; }
  finally { opening.delete(sig.symbol); }
}
async function closePaper(p, price, reason) {
  if (p.status === 'KAPALI' || p.closing) return false;
  p.closing = true;
  try {
    let exit = price;
    if (p.isLive && !p.extClosed) { try { const f = await liveClose(p); if (f) exit = f; } catch (e) { p.closeFail = (p.closeFail || 0) + 1; if (p.closeFail === 1 || p.closeFail % 10 === 0) log('LIVE KAPATMA HATASI (' + p.base + ', ' + p.closeFail + '): ' + e.message); return false; } }
    const r = paperPnl(p, exit);
    p.status = 'KAPALI'; p.result = reason; p.exit = rp(exit); p.closedAt = Date.now(); p.pnl = +r.pnl.toFixed(3); p.pnlPct = +r.pct.toFixed(2); p.durationMs = p.closedAt - p.openedAt;
    if (p.isLive) paper.liveDayPnl = (paper.liveDayPnl || 0) + r.pnl;
    else { paper.balance += r.pnl; paper.n++; paper.sumPnl += r.pnl; if (r.pnl > 0) paper.wins++; }
    paper.open = paper.open.filter(x => x.id !== p.id); paper.closed.unshift(p); dirty = true;
    log((p.isLive ? 'LIVE' : 'PAPER') + ' KAPANDI: ' + p.base + ' → ' + (REASON[reason] || reason) + ' | PnL ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2));
    checkDailyLoss();
    return true;
  } finally { p.closing = false; }
}
function paperSummary() {
  let unreal = 0;
  paper.open.filter(p => !p.isLive).forEach(p => { unreal += paperPnl(p, exitPx(p) || p.entry).pnl; });
  return { balance: +paper.balance.toFixed(2), start: paper.startBalance, equity: +(paper.balance + unreal).toFixed(2), unrealized: +unreal.toFixed(2), total: paper.n + paper.open.filter(p => !p.isLive).length, open: paper.open.length, closed: paper.n, wins: paper.wins, winRate: paper.n ? +(paper.wins / paper.n * 100).toFixed(1) : 0, sumPnl: +paper.sumPnl.toFixed(2), avgPnl: paper.n ? +(paper.sumPnl / paper.n).toFixed(3) : 0, dayStart: +paper.dayStart.toFixed(2), liveOpen: paper.open.filter(p => p.isLive).length, liveDayPnl: +(paper.liveDayPnl || 0).toFixed(2) };
}

const fromOf = o => (o.lastTs ? o.lastTs + M1 : Math.ceil((o.createdAt || o.openedAt) / M1) * M1);
const finish = (o, price, reason, kind) => (kind === 'sig' ? closeSignal(o, price, reason) : closePaper(o, price, reason));
function pumpPeak(o, price) { const d = o.dir === 'LONG' ? 1 : -1, pct = (price / o.entry - 1) * d * 100; if (o.peakPct == null || pct > o.peakPct) o.peakPct = pct; return pct; }
function tpTarget(o) { const atrPct = o.atrPct > 0 ? o.atrPct : 0.55; return clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX); }
function quickTpOf(atrPct) { if (settings.pumpQuick === false) return null; const a = atrPct > 0 ? atrPct : 0.55; return +clamp(EX.QUICK_TP_K * a, EX.QUICK_TP_MIN, EX.QUICK_TP_MAX).toFixed(2); }
function applyCostCover(o, pnl) {
  if (!(o.peakPct >= EX.BE_ARM)) return false;
  const d = o.dir === 'LONG' ? 1 : -1;
  const lock = o.entry * (1 + d * EX.BE_LOCK / 100);
  if (o.curSl == null || (lock - o.curSl) * d > 0) { o.curSl = lock; o.beArmed = true; return true; }
  return false;
}
function velRatio(o, nowMs) {
  const ring = RING.get(o.symbol);
  if (!ring || ring.p.length < 4) return 1;
  const d = o.dir === 'LONG' ? 1 : -1;
  const cur = ringMove(ring, EX.VEL_WIN_MS, nowMs) * d;
  const ser = o.velSeries || (o.velSeries = []);
  const lastT = ser.length ? ser[ser.length - 1].t : 0;
  if (nowMs - lastT >= 250) ser.push({ t: nowMs, v: cur });
  const floor = nowMs - EX.VEL_PEAK_MEMORY_MS;
  while (ser.length && ser[0].t < floor) ser.shift();
  let peak = 0;
  for (const s of ser) if (s.v > peak) peak = s.v;
  if (!(peak > 1e-6)) return 1;
  return Math.max(0, cur) / peak;
}
function pumpDecide(o, price, nowMs) {
  const pnl = pumpPeak(o, price), peak = o.peakPct;
  const born = o.startedAt || (o.createdAt != null ? o.createdAt : o.openedAt);
  const age = Math.max(0, nowMs - born) / 1000;
  const holdSec = o.holdSec != null ? o.holdSec : EX.HOLD;
  const noMoveSec = o.noMoveSec != null ? o.noMoveSec : EX.NO_MOVE;
  if (pnl >= tpTarget(o) - EPS) return 'TPMAX';
  applyCostCover(o, pnl);
  if (peak >= EX.LOCK_ARM) { const gb = Math.max(EX.GB_MIN, EX.GB_FRAC * peak); if (peak - pnl >= gb - EPS) return 'FADE'; }
  if (peak >= EX.MOM_ARM) { const vr = velRatio(o, nowMs); const minPnl = Math.max(EX.H + 0.05, EX.DECAY_MIN_PNL); if (vr < EX.DECAY_RATIO && pnl >= minPnl - EPS) return 'MOMENTUM'; }
  if (peak >= EX.BAIL_ARM && peak < EX.LOCK_ARM && pnl <= EX.BAIL_BELOW + EPS) return 'BAIL';
  if (age >= noMoveSec - EPS && peak < EX.BE_ARM) return 'NOMOVE';
  if (age >= holdSec - EPS) return 'SURE';
  if (settings.pumpQuick !== false && o.quickTpPct != null && age >= (o.quickTimeSec || EX.QUICK_TIME) - EPS && pnl < (o.quickArmPct || EX.QUICK_ARM) - EPS) return 'QUICK_TIME';
  return null;
}
function processTrade(o, cs, t) {
  if (o.status === 'KAPALI') return;
  const from = fromOf(o);
  let lastClose = null;
  if (cs) {
    for (const c of cs) {
      lastClose = c.c;
      if (c.t < from) continue;
      const r = stepTrade(o, c);
      if (r) { if (r.done) { closeSignal(o, r.price, r.reason); return; } dirty = true; log('TP1 vuruldu: ' + MODS[o.module].label + ' ' + o.base); }
      if (c.t + M1 <= t) o.lastTs = c.t;
    }
  }
  const px = priceOf(o.symbol) || lastClose || o.entry;
  if (t - o.createdAt > o.maxAgeMs) closeSignal(o, px, 'SURE');
}
const isScalpPos = o => !!(o && (o.scalp || o.scalpMode));
function looseJSON(text) { try { const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); return JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw); } catch (e) { return null; } }
function scalpDecide(o, price, nowMs) {
  const d = o.dir === 'LONG' ? 1 : -1;
  const pnl = pumpPeak(o, price), peak = o.peakPct;
  const born = o.startedAt || (o.createdAt != null ? o.createdAt : o.openedAt);
  const age = Math.max(0, nowMs - born) / 1000;
  const holdSec = o.holdSec != null ? o.holdSec : 540;
  const noMoveSec = o.noMoveSec != null ? o.noMoveSec : 150;
  if (o.tp1Hit) {
    const gap = clamp(0.35 * peak, 0.22, 0.50), lvl = peak - gap;
    if (lvl > EX.BE_LOCK + 0.02) { const lock = o.entry * (1 + d * lvl / 100); if ((lock - o.curSl) * d > 0) { o.curSl = lock; o.trailed = true; } }
    if (o.aiExit === 'EXIT' && nowMs - (o.aiExitAt || 0) < 120000 && pnl >= 0.10) return 'MOMENTUM';
    if (peak >= 0.60 && peak - pnl >= Math.max(0.28, 0.40 * peak)) return 'FADE';
  } else if (age >= noMoveSec && peak < 0.25) return 'NOMOVE';
  if (age >= holdSec) return 'SURE';
  return null;
}
async function maybeAIExit(o, now) {
  if (!aiReady() || o.aiExitBusy || o.closing || (o.aiExitCalls || 0) >= 6) return;
  if (now - (o.aiExitCheckAt || o.tp1At || now) < 30000) return;
  if (!aiQuota().ok) return;
  o.aiExitBusy = true; o.aiExitCheckAt = now; o.aiExitCalls = (o.aiExitCalls || 0) + 1;
  try {
    const raw = await getC(o.symbol, '1m', 14, 10000);
    const cs = raw ? raw.slice(-8) : [];
    const lines = cs.map(c => new Date(c.t).toISOString().slice(14, 16) + ' dk: değişim ' + ((c.c / c.o - 1) * 100 >= 0 ? '+' : '') + ((c.c / c.o - 1) * 100).toFixed(2) + '% hacim ' + Math.round(c.v)).join('\n');
    const d = o.dir === 'LONG' ? 1 : -1, pnl = o.lastPx ? (o.lastPx / o.entry - 1) * d * 100 : 0;
    const messages = [{ role: 'system', content: 'Sen AlphaSon işlem yöneticisisin. Açık scalp pozisyonunda ivmenin sürüp sürmediğini söylersin. Çok basit Türkçe, teknik terim yok. Yalnızca JSON döndür.' }, { role: 'user', content: `Pozisyon: ${o.base} ${o.dir}. Giriş ${o.entry}, şu an %${pnl.toFixed(2)} ${pnl >= 0 ? 'kârda' : 'zararda'}, zirve %${(o.peakPct || 0).toFixed(2)}. Yarısı kârla satıldı. Süre: ${Math.round((now - (o.openedAt || now)) / 1000)} sn.\nSon 1 dakikalık mumlar:\n${lines}\n\nİvme sürüyor mu? JSON: {"action":"TUT|ÇIK","reason":"tek kısa cümle"}` }];
    for (const p of orderedProviders()) {
      if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
      if (!aiQuota().ok) break;
      if (!aiCount(p)) break;
      try {
        const r = await callProvider(p, messages, { timeoutMs: 6000 });
        p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
        const j = looseJSON(r.text) || {};
        const act = /(Ç|C)IK|EXIT|SAT/i.test(String(j.action || j.karar || '')) ? 'EXIT' : 'HOLD';
        o.aiExit = act; o.aiExitAt = Date.now(); o.aiExitReason = String(j.reason || '').slice(0, 160);
        const sg = signals.find(s => s.id === o.sigId); if (sg) { sg.aiExit = act; sg.aiExitAt = o.aiExitAt; sg.aiExitReason = o.aiExitReason; }
        dirty = true;
        log('AI İVME: ' + o.base + ' → ' + (act === 'EXIT' ? 'ÇIK' : 'TUT') + ' | ' + p.name);
        break;
      } catch (e) { providerFail(p, e); }
    }
  } finally { o.aiExitBusy = false; }
}
async function livePartial(p) {
  if (!p.isLive || p.partialDone || p.partialBusy) return;
  p.partialBusy = true;
  try {
    const half = ex.amountToPrecision(p.symbol, Number(p.amount) / 2);
    if (!(Number(half) > 0)) { p.partialDone = true; return; }
    const side = p.dir === 'LONG' ? 'sell' : 'buy';
    await ex.createOrder(p.symbol, 'market', side, half, undefined, { reduceOnly: true });
    p.partialDone = true;
    p.amount = ex.amountToPrecision(p.symbol, Number(p.amount) - Number(half));
    if (p.stopId) await cancelStopOrder(p);
    try { p.stopId = await placeStop(p.symbol, side, p.amount, p.curSl); p.unprotected = false; } catch (e) { p.stopId = null; p.unprotected = true; log('UYARI: ' + p.base + ' yeni stop kurulamadı'); }
  } finally { p.partialBusy = false; }
}
async function pumpTick(o, now, kind) {
  if (!o || (o.status !== 'AKTIF' && o.status !== 'ACIK') || o.closing) return;
  const born = o.startedAt || (o.createdAt != null ? o.createdAt : o.openedAt), age = (now - born) / 1000;
  const hold = o.holdSec != null ? o.holdSec : EX.HOLD;
  const px = exitPx(o);
  if (!px) { if (age > hold + 30) await finish(o, o.lastPx || o.entry, 'SURE', kind); return; }
  o.lastPx = px;
  pumpPeak(o, px);
  const scalp = isScalpPos(o);
  if (!scalp) { velRatio(o, now); applyCostCover(o, o.peakPct); }
  if (!scalp && settings.pumpQuick !== false && o.quickTpPct != null) {
    const d = o.dir === 'LONG' ? 1 : -1, pnl = (px / o.entry - 1) * d * 100;
    if (pnl >= o.quickTpPct - EPS) { await finish(o, px, 'QUICK', kind); return; }
  }
  const r = stepTrade(o, { t: now, h: px, l: px, c: px });
  if (r && r.event === 'TP1') { o.tp1At = now; dirty = true; log('TP1 vuruldu: ' + MODS[o.module].label + ' ' + o.base); if (kind === 'paper' && o.isLive) await livePartial(o); }
  if (r && r.done) { let price = r.price; if (r.reason === 'SL' || r.reason === 'BE') price = o.dir === 'LONG' ? Math.min(price, px) : Math.max(price, px); let reason = r.reason === 'TP1' ? 'TPMAX' : r.reason; if (scalp && r.reason === 'BE' && o.trailed) reason = 'FADE'; await finish(o, price, reason, kind); return; }
  if (scalp && kind === 'paper' && o.tp1Hit) maybeAIExit(o, now).catch(() => { });
  const dec = scalp ? scalpDecide(o, px, now) : pumpDecide(o, px, now);
  if (dec) await finish(o, px, dec, kind);
}
async function pumpManage(now) {
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'AI_BEKLIYOR')) { if (s.aiGate && now >= s.aiGate.expiresAt) declinePumpAI(s, 'AI_TIMEOUT', 'AI onayı yetişmedi'); }
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'ONAY_BEKLIYOR')) { if (s.approvalExpiresAt && now >= s.approvalExpiresAt) { s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = now; s.exit = null; s.netR = null; s.grossR = null; s.pnlPct = null; dirty = true; log('ONAY SÜRESİ DOLDU: ' + s.base); } }
  for (const s of signals.filter(x => x.status === 'AKTIF' && x.module === 'PUMP')) { try { await pumpTick(s, now, 'sig'); } catch (e) { log('HATA takip ' + s.base + ': ' + e.message); } }
  for (const p of paper.open.slice()) { try { await pumpTick(p, now, 'paper'); } catch (e) { log('HATA işlem ' + p.base + ': ' + e.message); } }
}
async function trackerCycle() {
  const t = Date.now();
  const act = signals.filter(s => s.status === 'AKTIF' && s.module !== 'PUMP' && (!s._chk || t - s._chk >= 55000));
  if (!act.length) return;
  const need = new Map();
  for (const o of act) { const f = fromOf(o), v = need.get(o.symbol); if (v === undefined || f < v) need.set(o.symbol, f); }
  const data = {};
  await pool(Array.from(need.keys()), 6, async sym => { const since = need.get(sym), lim = Math.min(300, Math.ceil((t - since) / M1) + 2); try { const raw = await ex.fetchOHLCV(sym, '1m', since, lim); data[sym] = (raw || []).map(toC); } catch (e) { stats.apiErr++; } });
  for (const s of act) { s._chk = t; try { processTrade(s, data[s.symbol], t); } catch (e) { log('HATA takip ' + s.base + ': ' + e.message); } }
}

/* ── Scans ── */
async function scalpScanX() {
  if (!SCALPX.enabled || !MODS.PUMP.enabled) return;
  const found = [];
  await pool(TOP.slice(0, SCALPX.topN), 6, async sym => {
    const tk = TICK[sym]; if (!tk || quoteVolOf(tk) < SCALPX.minQuoteVol) { PWHY['hacim düşük'] = (PWHY['hacim düşük'] || 0) + 1; return; }
    const bk = bookOf(sym); if (!bk) return;
    const spreadPct = (bk.ask - bk.bid) / bk.last * 100;
    if (spreadPct > SCALPX.maxSpreadPct) { PWHY['spread geniş'] = (PWHY['spread geniş'] || 0) + 1; return; }
    for (const tf of SCALPX.tfs) {
      const ms = TF_MS[tf], raw = await getC(sym, tf, 80, ms >= M5 ? 40000 : 25000);
      if (!raw) continue;
      const cs = closed(raw, ms); if (cs.length < 50) continue;
      const last = cs[cs.length - 1], age = Date.now() - (last.t + ms);
      if (age > SCALPX.maxLagMs[tf] || age < -2000) continue;
      const key = sym + '|' + tf + '|' + last.t;
      if (SCALP_SEEN.has(key)) continue;
      SCALP_SEEN.add(key);
      stats.pumpScanned++; sc('PUMP', 'taranan');
      const det = detectScalpX(cs, tf, PWHY, sym); if (!det) continue;
      sc('PUMP', 'aday'); found.push({ sym, det, spreadPct, bk }); break;
    }
  });
  found.sort((a, b) => b.det.conf - a.det.conf);
  let added = 0;
  for (const f of found) {
    if (added >= 3) break;
    const { sym, det, bk } = f, d = det.dir === 'LONG' ? 1 : -1;
    const fill = det.dir === 'LONG' ? bk.ask : bk.bid;
    const drift = (fill - det.entry) * d / det.info.atr;
    if (drift > SCALPX.maxDriftAtr) { PWHY['scalp:fiyat kaçtı'] = (PWHY['scalp:fiyat kaçtı'] || 0) + 1; continue; }
    if (drift < -SCALPX.maxDriftAtr * 1.5) { PWHY['scalp:geri çekildi'] = (PWHY['scalp:geri çekildi'] || 0) + 1; continue; }
    det.entry = rp(fill); det.sl = rp(fill * (1 - d * det.info.slPct / 100)); det.tp1 = rp(fill * (1 + d * det.info.tp1Pct / 100)); det.tp2 = rp(fill * (1 + d * det.info.tp2Pct / 100));
    det.info.spreadPct = +f.spreadPct.toFixed(3); det.info.lastPx = rp(bk.last);
    if (addSignal(Object.assign({ module: 'PUMP', symbol: sym }, det))) added++;
  }
}
const SCALP_SEEN = new Set();
async function scanScalper() {
  if (!MODS.SCALPER.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 80), 8, async sym => { const raw = await getC(sym, '15m', 120); if (!raw) return; const cs = closed(raw, M15); if (cs.length < 80) return; sc('SCALPER', 'taranan'); const det = detectScalper(cs, SWHY); if (!det) return; if (det.conf < SCALP.minConf) { SWHY['güven düşük'] = (SWHY['güven düşük'] || 0) + 1; return; } cands.push({ sym, det, last: cs[cs.length - 1] }); });
  cands.sort((a, b) => (b.det.conf - a.det.conf) || ((b.det.info.volRatio || 0) - (a.det.info.volRatio || 0)));
  for (const c of cands) emit('SCALPER', c.sym, c.det, c.last, M15, 6 * M1);
}
async function scanRange() {
  if (!MODS.RANGE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 8, async sym => { const raw = await getC(sym, '15m', 170); if (!raw) return; const cs = closed(raw, M15); if (cs.length < 120) return; sc('RANGE', 'taranan'); const r = detectRange(cs, RWHY); if (r.watch) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, r.watch)); if (r.signal && r.signal.conf >= REVERT.minConf) emit('RANGE', sym, r.signal, cs[cs.length - 1], M15, 12 * M1); else if (r.signal) RWHY['güven düşük'] = (RWHY['güven düşük'] || 0) + 1; });
  watch.sort((a, b) => b.squeezeScore - a.squeezeScore);
  WATCH.range = watch.slice(0, 40);
}
async function scanZone() {
  if (!MODS.ZONE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 6, async sym => { const r1 = await getC(sym, '1h', 260); if (!r1) return; const c1 = closed(r1, H1); if (c1.length < 100) return; sc('ZONE', 'taranan'); const r4 = await getC(sym, '4h', 130); const c4 = r4 ? closed(r4, H4) : null; const res = detectZone(c1, buildZones(c1, c4)); res.watch.forEach(w => watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, w))); if (res.signal) emit('ZONE', sym, res.signal, c1[c1.length - 1], H1, 55 * M1); });
  watch.sort((a, b) => a.dist - b.dist);
  WATCH.zone = watch.slice(0, 40);
}

/* ── v81.0: LT auto AI ── */
async function autoWatchAI(w) {
  if (!w || w.aiBusy || !aiReady()) return;
  if (w.ai && Date.now() - (w.ai.at || 0) < AI.watchAiRefreshMs) return;
  if (!aiQuota().ok) return;
  w.aiBusy = true;
  try {
    if (!aiCount(null)) return;
    const sys = SYSTEM_PROMPTS.LT + '\n\n' + COMMON_JSON_HINT;
    const info = { base: w.base, tf: w.tf, price: w.price, upper: w.upper, lower: w.lower, mid: w.mid, compression: w.compression, maturity: w.maturity, height: w.height, distUpperPct: w.distUpper, distLowerPct: w.distLower, yakinTaraf: w.nearSide, hacimOrani: w.volRatio };
    const user = 'LT üçgen gözlemi (kırılım HENÜZ OLMADI):\n' + JSON.stringify(info, null, 1) + '\n\nKırılım henüz olmadığı için "GİRİLMEZ" + WATCH + score 30-50 ver. Hangi koşulda kırılım teyit olur açıkla. Yalnızca JSON.';
    for (const p of orderedProviders()) {
      if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
      if (!aiQuota().ok) break;
      try {
        const r = await callProvider(p, [{ role: 'system', content: sys }, { role: 'user', content: user }]);
        p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
        const parsed = parseAIJSON(r.text);
        w.ai = Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', at: Date.now() });
        log('AI LT WATCH: ' + w.base + ' → ' + parsed.verdict + ' · ' + parsed.phase + ' · ' + parsed.score + ' (' + p.name + ')');
        break;
      } catch (e) { providerFail(p, e); }
    }
  } finally { w.aiBusy = false; }
}
async function aiScanLT() {
  if (!MODS.LT.enabled) return;
  const cands = [], watches = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const r4 = await getC(sym, '4h', 150);
    if (r4) { const cs = closed(r4, H4); if (cs.length >= 60) { sc('LT', 'taranan'); const cand = ltCandidates(cs, null, '4h', LWHY); if (cand && cand.watch) watches.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, cand)); else if (cand) cands.push({ sym, cand }); } }
    const r1 = await getC(sym, '1h', 300);
    if (r1) { const c1 = closed(r1, H1); let a2 = aggTF(c1, 120); if (a2.length && a2[a2.length - 1].t + H1 > c1[c1.length - 1].t) a2 = a2.slice(0, -1); if (a2.length >= 60) { sc('LT', 'taranan'); const cand = ltCandidates(a2, null, '2h', LWHY); if (cand && cand.watch) watches.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, cand)); else if (cand) cands.push({ sym, cand, cs: a2 }); } }
  });
  const seen = new Set(), unique = [];
  watches.sort((a, b) => a.nearPct - b.nearPct);
  for (const w of watches) { if (seen.has(w.symbol)) continue; seen.add(w.symbol); unique.push(w); if (unique.length >= 40) break; }
  for (const w of unique) { const old = (WATCH.lt || []).find(o => o.symbol === w.symbol); if (old && old.ai && !w.ai) w.ai = old.ai; }
  WATCH.lt = unique;
  unique.slice(0, AI.aiWatchTopN).forEach(w => { autoWatchAI(w).catch(() => {}); });
  for (const c of cands.sort((a, b) => b.cand.maturity - a.cand.maturity).slice(0, AI.aiLTCandidatesMax)) {
    if (signals.some(s => s.module === 'LT' && s.symbol === c.sym && isOpenSignal(s))) continue;
    const det = await aiAskSignal('LT', c.sym, c.cand);
    if (!det || det.none) continue;
    addSignal(Object.assign({ module: 'LT', symbol: c.sym, retest: false }, det));
  }
}
async function aiAskSignal(module, symbol, cand) {
  if (!aiReady() || !aiQuota().ok || !aiReserveOk(AI.nonPumpShare)) return null;
  const sys = SYSTEM_PROMPTS[module] + '\n\n' + COMMON_JSON_HINT;
  const ctx = (cand.recentCandles || []).map(c => `${new Date(c.t).toISOString().replace('T', ' ').slice(0, 16)} O${c.o} H${c.h} L${c.l} C${c.c} V${c.v}`).join('\n');
  const extra = { price: cand.price, upper: cand.upper, lower: cand.lower, compression: cand.compression, maturity: cand.maturity, height: cand.height, volRatio: cand.volRatio, yakinlikPct: cand.yakinlikPct, breakoutUp: cand.breakoutUp, breakoutDn: cand.breakoutDn, plan: cand.plan };
  const user = `${MODS[module].label} adayı: ${baseOf(symbol)} ${cand.tf}\nFiyat: ${cand.price}\nEk: ${JSON.stringify(extra)}\n\nSon mumlar:\n${ctx}\n\nSinyal VAR MI? Yalnızca JSON.`;
  let lastErr = null;
  for (const p of orderedProviders()) {
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
    if (!aiQuota().ok) break;
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, [{ role: 'system', content: sys }, { role: 'user', content: user }]);
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastLatencyMs = Date.now() - t0; p.lastError = null;
      const parsed = parseAIJSON(r.text);
      if (parsed.verdict !== 'ONY' || parsed.score < 55) return { none: true, reason: parsed.reason };
      const dir = parsed.direction;
      if (dir !== 'LONG' && dir !== 'SHORT') return { none: true, reason: 'yön belirsiz' };
      const entry = Number((cand.plan && cand.plan.entry) || cand.price);
      const sl = Number((cand.plan && cand.plan.sl) || entry * (dir === 'LONG' ? 0.97 : 1.03));
      const tp1 = Number((cand.plan && cand.plan.tp1) || entry * (dir === 'LONG' ? 1.02 : 0.98));
      if (!(entry > 0) || !(sl > 0) || !(tp1 > 0)) return { none: true, reason: 'fiyat eksik' };
      const q = rrNet(entry, sl, tp1);
      if (q.net < 0.6) return { none: true, reason: 'net R:R ' + q.net };
      return { dir, entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: cand.plan && cand.plan.tp2 ? rp(cand.plan.tp2) : null, single: false, conf: clamp(parsed.score, 40, 95), info: { tf: cand.tf, source: 'ai', aiScore: parsed.score, aiTrust: parsed.confidence, netRR: q.net, riskPct: q.risk, reason: parsed.reason, risks: parsed.risks, phase: parsed.phase, provider: p.id, providerName: p.name, model: r.model, latencyMs: Date.now() - t0 } };
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  return null;
}
async function aiScanTrend() {
  if (!MODS.TREND.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 100), 6, async sym => { const raw = await getC(sym, '15m', 220); if (!raw) return; const cs = closed(raw, M15); if (cs.length < 120) return; sc('TREND', 'taranan'); const cand = trendCandidates(cs, TWHY, sym); if (cand) cands.push({ sym, cand }); });
  cands.sort((a, b) => (b.cand.volRatio || 0) - (a.cand.volRatio || 0));
  for (const c of cands.filter(c => !signals.some(s => s.module === 'TREND' && s.symbol === c.sym && isOpenSignal(s))).filter(c => market.dir === 'NOTR' || c.cand.dir === market.dir || c.cand.adx >= 22).slice(0, AI.aiTrendCandidatesMax)) {
    const det = await aiAskSignal('TREND', c.sym, c.cand);
    if (!det || det.none) { sc('TREND', 'ai-red'); continue; }
    addSignal(Object.assign({ module: 'TREND', symbol: c.sym, retest: false }, det));
  }
}
async function getDailyLevels(sym, force) {
  const now = Date.now(), dayKey = dayKeyOf(now), hit = DAILY_LEVELS.get(sym);
  if (!force && hit && hit.dayKey === dayKey && now - hit.at < 90 * M1) return hit;
  const raw = await getC(sym, '1d', 5, 60 * M1);
  if (!raw || raw.length < 2) return null;
  const cs = closed(raw, D1); if (!cs.length) return null;
  const d = cs[cs.length - 1];
  if (!(d.h > d.l) || !(d.l > 0)) return null;
  const lv = { sym, dayKey, pdh: d.h, pdl: d.l, dayMid: (d.h + d.l) / 2, candleT: d.t, at: now, rangePct: +((d.h - d.l) / d.l * 100).toFixed(2) };
  DAILY_LEVELS.set(sym, lv);
  return lv;
}
async function refreshDailyLevels() {
  if (!MODS.DAILY.enabled) return;
  const syms = TOP.slice(0, DAILY.topN);
  let ok = 0;
  await pool(syms, 6, async sym => { const lv = await getDailyLevels(sym); if (lv) ok++; else DWHY['seviye yok'] = (DWHY['seviye yok'] || 0) + 1; });
  log('Günlük seviyeler hazır: ' + ok + '/' + syms.length);
}
async function scanDaily() {
  if (!MODS.DAILY.enabled) return;
  const watch = [], found = [];
  await pool(TOP.slice(0, DAILY.topN), 6, async sym => {
    const raw = await getC(sym, '15m', 120, 150000); if (!raw) return;
    const cs = closed(raw, M15); if (cs.length < 40) return;
    const last = cs[cs.length - 1];
    if (Date.now() - (last.t + M15) > 9 * M1) return;
    const lv = await getDailyLevels(sym); if (!lv) return;
    sc('DAILY', 'taranan');
    const det = detectDailySweep(cs, lv);
    if (det) { if (det.conf < DAILY.minConf) { DWHY['güven düşük'] = (DWHY['güven düşük'] || 0) + 1; return; } const tk = TICK[sym]; const spread = tk && tk.last > 0 && tk.bid > 0 && tk.ask > 0 ? (tk.ask - tk.bid) / tk.last * 100 : null; if (spread != null && spread > DAILY.maxSpreadPct) { DWHY['spread geniş'] = (DWHY['spread geniş'] || 0) + 1; return; } found.push({ sym, det, cs, last }); }
    else { const w = dailyWatch(cs, lv); if (w) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, w)); }
  });
  watch.sort((a, b) => Math.min(Math.abs(a.distPdh), Math.abs(a.distPdl)) - Math.min(Math.abs(b.distPdh), Math.abs(b.distPdl)));
  WATCH.daily = watch.slice(0, 40);
  found.sort((a, b) => b.det.conf - a.det.conf);
  for (const f of found) { try { await dailyAIEmit(f.sym, f.det, f.cs, f.last); } catch (e) { log('HATA dailyAI: ' + e.message); } }
}
async function dailyAIEmit(sym, det, cs, last) {
  const t = Date.now();
  if (t - (last.t + M15) > 9 * M1) return;
  if (signals.some(s => s.module === 'DAILY' && s.symbol === sym && isOpenSignal(s))) return;
  const ak = DAILY_ASKED.get(sym);
  if (ak && t - ak < 30 * M1) return;
  sc('DAILY', 'aday');
  if (!aiReady()) { emit('DAILY', sym, det, last, M15, 9 * M1); return; }
  DAILY_ASKED.set(sym, t);
  const cand = { price: det.entry, recentCandles: cs.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) })) };
  const ai = await aiAskSignal('DAILY', sym, cand);
  if (!ai) { emit('DAILY', sym, det, last, M15, 9 * M1); return; }
  if (ai.none) { sc('DAILY', 'ai-red'); return; }
  const merged = Object.assign({}, det, ai, { module: 'DAILY', symbol: sym, maxAgeMs: det.maxAgeMs, atrPct: det.atrPct });
  merged.info = Object.assign({}, det.info, ai.info);
  const ok = addSignal(merged);
  sc('DAILY', ok ? 'sinyal' : 'engel/cooldown');
}
function ltRetestCycle() {
  if (!MODS.LT.enabled) return;
  const now = Date.now();
  for (const [key, e] of Array.from(LTR)) {
    if (!e || !e.sym || !(e.step > 0)) { LTR.delete(key); continue; }
    const x = (now - e.lineT) / e.step;
    if (x > 12.5) { LTR.delete(key); saveLTR(); continue; }
    const px = priceOf(e.sym); if (!(px > 0)) continue;
    const line = e.line0 + e.slope * x; if (!(line > 0)) { LTR.delete(key); continue; }
    const d = e.dir === 'LONG' ? 1 : -1;
    const dist = (px / line - 1) * 100 * d;
    const atrPct = e.atrPct || 1;
    const tol = Math.max(0.15, 0.25 * atrPct), fail = Math.max(0.35, 0.50 * atrPct);
    if (dist < -fail) { e.failCount = (e.failCount || 0) + 1; if (e.failCount >= 2) { LTR.delete(key); saveLTR(); log('LT RETEST İPTAL: ' + e.base); } continue; }
    e.failCount = 0;
    if (!e.armed) { if (dist >= Math.max(0.45, 0.60 * atrPct)) { e.armed = true; saveLTR(); } continue; }
    if (dist > tol) continue;
    const recent = Array.from(LTR.values()).some(o => o.sym === e.sym && o.lastAlertAt && now - o.lastAlertAt < 30 * M1);
    if (recent) continue;
    const entry = line, slPct = Math.max(0.50, 0.50 * atrPct), sl = entry * (1 - d * slPct / 100);
    const tp1 = entry + d * 0.60 * e.height, tp2 = entry + d * e.height;
    const q = rrNet(entry, sl, tp1);
    const conf = clamp(62 + (e.tf === '2h' ? 6 : 0) + clamp((e.height / entry * 100 - 1) * 4, 0, 10), 40, 92);
    const info = { retest: true, tf: e.tf, line: rp(line), distPct: +dist.toFixed(2), height: rp(e.height), mid: rp(e.mid), breakoutAgeMin: Math.round((now - e.breakoutAt) / M1), netRR: q.net, riskPct: q.risk, slPct: +slPct.toFixed(2), lines: e.lines };
    addSignal({ module: 'LT', symbol: e.sym, dir: e.dir, entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf, retest: true, info });
    e.lastAlertAt = now; saveLTR();
    log('LT RETEST: ' + e.base + ' ' + e.dir + ' | çizgi ' + fmtP(line));
  }
}

/* ── Market cycle ── */
function emaScore(cs) { if (!cs || cs.length < 60) return null; const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cl.length - 1; return ((cl[m] > e50[m] ? 1 : 0) + (e20[m] > e50[m] ? 1 : 0) + (e50[m] > e50[m - 6] ? 1 : 0) + (cl[m] > e20[m] ? 1 : 0)) / 4; }
const chgScore = c => (c == null || !isFinite(c) ? null : clamp(0.5 + c / 8, 0, 1));
async function marketCycle() {
  const emaS = [], chgS = [];
  for (const [key, sym] of [['btc', 'BTC/USDT:USDT'], ['eth', 'ETH/USDT:USDT']]) {
    const tk = TICK[sym], chg = tk && tk.percentage != null ? Number(tk.percentage) : null;
    if (tk) market[key] = { price: tk.last, change: chg != null ? +chg.toFixed(2) : null };
    const r1 = await getC(sym, '1h', 120), r4 = await getC(sym, '4h', 120);
    const a = r1 ? emaScore(closed(r1, H1)) : null, b = r4 ? emaScore(closed(r4, H4)) : null;
    if (a != null) emaS.push(a); if (b != null) emaS.push(b);
    const cs = chgScore(chg); if (cs != null) chgS.push(cs);
  }
  const trfPct = 0.7 * (emaS.length ? avg(emaS) : 0.5) + 0.3 * (chgS.length ? avg(chgS) : 0.5);
  let a1 = 0, n1 = 0, a4 = 0, n4 = 0, up24 = 0, n24 = 0;
  await pool(TOP.slice(0, 60), 8, async sym => {
    const tk = TICK[sym];
    if (tk && tk.percentage != null) { n24++; if (Number(tk.percentage) > 0) up24++; }
    const a = await getC(sym, '1h', 60), b = await getC(sym, '4h', 60);
    if (a) { const c = closed(a, H1); if (c.length >= 25) { const e = emaArr(closes(c), 20); n1++; if (c[c.length - 1].c > e[e.length - 1]) a1++; } }
    if (b) { const c = closed(b, H4); if (c.length >= 55) { const e = emaArr(closes(c), 50); n4++; if (c[c.length - 1].c > e[e.length - 1]) a4++; } }
  });
  const b1 = n1 ? a1 / n1 : 0.5, b4 = n4 ? a4 / n4 : 0.5, bp = n24 ? up24 / n24 : 0.5;
  const breadth = 0.40 * b1 + 0.35 * b4 + 0.25 * bp, score = 0.5 * trfPct + 0.5 * breadth;
  let dir = market.dir;
  if (score > 0.58) dir = 'LONG'; else if (score < 0.42) dir = 'SHORT';
  else if (dir === 'LONG' && score <= 0.54) dir = 'NOTR';
  else if (dir === 'SHORT' && score >= 0.46) dir = 'NOTR';
  const pc = x => '%' + (x * 100).toFixed(0);
  const why = 'Trend ' + pc(trfPct) + ', 1s ' + pc(b1) + ', 4s ' + pc(b4) + ', 24s ' + pc(bp) + ' → skor ' + score.toFixed(2) + (dir === 'LONG' ? ' (LONG)' : dir === 'SHORT' ? ' (SHORT)' : ' (NÖTR)');
  if (dir !== market.dir) log('PİYASA YÖNÜ: ' + market.dir + ' → ' + dir + ' | ' + why);
  Object.assign(market, { dir, score: +score.toFixed(3), trf: +trfPct.toFixed(3), breadth: +breadth.toFixed(3), b1h: +b1.toFixed(3), b4h: +b4.toFixed(3), b24: +bp.toFixed(3), why, updatedAt: Date.now() });
}
function fngText(v) { if (v <= 25) return 'Aşırı korku.'; if (v <= 45) return 'Korku.'; if (v <= 55) return 'Nötr.'; if (v <= 75) return 'Hırs.'; return 'Aşırı hırs.'; }
async function radarCycle() {
  const R = { updatedAt: Date.now() };
  try { const j = await fetchJSON('https://api.alternative.me/fng/?limit=1'); const v = parseInt(j.data[0].value, 10); R.fng = { value: v, label: j.data[0].value_classification, text: fngText(v) }; } catch (e) { R.fng = null; }
  const rs = { 1: [], 4: [] }, named = {}, ext = [];
  const syms = ['BTC/USDT:USDT', 'ETH/USDT:USDT'].concat(TOP.slice(0, 30));
  await pool(syms, 6, async (sym, i) => {
    const a = await getC(sym, '1h', 100), b = await getC(sym, '4h', 100);
    const r1 = a ? rsiLast(closes(closed(a, H1))) : null, r4 = b ? rsiLast(closes(closed(b, H4))) : null;
    if (r1 != null) rs[1].push(r1); if (r4 != null) rs[4].push(r4);
    if (r1 != null && (r1 >= 72 || r1 <= 28)) ext.push({ base: baseOf(sym), rsi1h: Math.round(r1) });
    if (i === 0) named.btc = [r1, r4];
    if (i === 1) named.eth = [r1, r4];
  });
  R.extremes = { overbought: ext.filter(x => x.rsi1h >= 72).sort((x, y) => y.rsi1h - x.rsi1h).slice(0, 6), oversold: ext.filter(x => x.rsi1h <= 28).sort((x, y) => x.rsi1h - y.rsi1h).slice(0, 6) };
  const f = x => (x == null ? null : +x.toFixed(1)), a1 = avg(rs[1]), a4 = avg(rs[4]);
  R.rsi = { btc1h: f(named.btc && named.btc[0]), btc4h: f(named.btc && named.btc[1]), eth1h: f(named.eth && named.eth[0]), eth4h: f(named.eth && named.eth[1]), avg1h: f(a1), avg4h: f(a4) };
  R.rsi.text = a1 >= 70 ? 'RSI yüksek.' : a1 <= 30 ? 'RSI düşük.' : 'RSI normal.';
  try { const j = await fetchJSON('https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=BTCUSDT&period=1h'); const d = j && j.data, row = Array.isArray(d) ? d[d.length - 1] : d; const lr = parseFloat(row && (row.longAccountRatio || row.longRatio)), sr = parseFloat(row && (row.shortAccountRatio || row.shortRatio)); if (!isFinite(lr) || !isFinite(sr) || lr + sr <= 0) throw new Error('veri yok'); R.ls = { long: +(lr / (lr + sr) * 100).toFixed(1), short: +(sr / (lr + sr) * 100).toFixed(1), source: 'Bitget' }; }
  catch (e) { R.ls = { long: +(market.breadth * 100).toFixed(1), short: +((1 - market.breadth) * 100).toFixed(1), source: 'Tahmini' }; }
  R.ls.ratio = R.ls.short > 0 ? +(R.ls.long / R.ls.short).toFixed(2) : null;
  R.ls.text = R.ls.long >= 60 ? 'Çoğunluk LONG.' : R.ls.long <= 40 ? 'Çoğunluk SHORT.' : 'Dengeli.';
  radar = R;
}

/* ── Money flow / brief ── */
function moneyFlow(n) {
  const now = Date.now(), out = [];
  for (const sym of TOP.slice(0, 80)) {
    const s = SNAP[sym]; if (!s || s.length < 6) continue;
    const last = s[s.length - 1], a = snapAt(s, now - 5 * M1);
    if (!a || a.qv == null || last.qv == null || !(a.p > 0) || now - a.t > 5 * M1 + 20000) continue;
    const flow = last.qv - a.qv;
    if (!(flow > 0)) continue;
    out.push({ base: baseOf(sym), flowUsdt: Math.round(flow), chg5m: +((last.p / a.p - 1) * 100).toFixed(2) });
  }
  out.sort((x, y) => y.flowUsdt - x.flowUsdt);
  return out.slice(0, n || 8);
}
async function buildMarketContext() {
  const pairs = [['BTC/USDT:USDT', 'BTC'], ['ETH/USDT:USDT', 'ETH']];
  const candles = {};
  for (const [sym, name] of pairs) {
    const a = await getC(sym, '1h', 80), b = await getC(sym, '4h', 80);
    const c1 = a ? closed(a, H1).slice(-24) : [], c4 = b ? closed(b, H4).slice(-12) : [];
    candles[name] = { h1: c1.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n'), h4: c4.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n') };
  }
  const movers = TOP.slice(0, 50).map(sym => ({ base: baseOf(sym), chg: TICK[sym] ? TICK[sym].percentage : null })).filter(x => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8);
  return JSON.stringify({ market, radar: { fng: radar.fng, rsi: radar.rsi, ls: radar.ls }, baseline: analyzeMarket(), paraGirisi5dk: moneyFlow(8), movers, btc: candles.BTC, eth: candles.ETH }, null, 1);
}
async function aiMarketBrief(force) {
  if (!aiReady() || AI.briefPerDay <= 0) return null;
  const q = aiQuota();
  if (!q.ok || !aiReserveOk(0.9)) return null;
  if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 0; }
  if (aiUsage.briefCount >= AI.briefPerDay) return marketBrief;
  let ctx;
  try { ctx = await buildMarketContext(); } catch (e) { aiUsage.lastError = 'Brifing: ' + redact(e.message); saveAI(); return null; }
  const sys = 'Sen AlphaSon adlı kripto piyasa asistanısın. Genel piyasa yönünü, para girişini ve aşırı alım/satım durumunu okuyup KISA ve ÇOK BASİT Türkçe ile yorum yaparsın; teknik terim yok. Karar yalnızca "GİRİLİR" veya "GİRİLMEZ" (genel olarak işlem açmaya uygun mu). Yalnızca JSON döndür.';
  const user = ctx + '\n\nGörev: piyasa yönünü söyle; en fazla 3 sebepli fikir üret. JSON şeması: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"summary":"2-3 kısa cümle","drivers":["itici"],"risks":["risk"],"plan":"basit plan","invalidation":"geçersizlik","ideas":[{"coin":"BTC","dir":"LONG|SHORT","reason":"tek kısa cümle"}]}. Sadece JSON.';
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  let lastErr = null;
  for (const p of orderedProviders()) {
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
    if (!aiQuota().ok) break;
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, messages), parsed = parseAIJSON(r.text);
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastLatencyMs = Date.now() - t0; p.lastError = null;
      aiUsage.briefCount++;
      marketBrief = Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai' });
      aiUsage.lastError = null; saveAI(); dirty = true;
      log('AI BRİFİNG: ' + (marketBrief.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ') + ' ' + marketBrief.score + '/100 (' + p.name + ')');
      return marketBrief;
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  aiUsage.lastError = redact(lastErr && lastErr.message || 'brifing yok'); saveAI();
  return marketBrief;
}
async function maybeMarketBrief() {
  if (!aiReady() || AI.briefPerDay <= 0) return;
  const q = aiQuota(); if (!q.ok) return;
  if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 0; }
  if (aiUsage.briefCount >= AI.briefPerDay) return;
  if (marketBrief && marketBrief.at && Date.now() - marketBrief.at < AI.briefGapMs) return;
  await aiMarketBrief(false);
}

/* ── Stats ── */
function statsByModule() {
  const rows = [];
  let T = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, reasons: {} };
  Object.keys(MODS).forEach(k => {
    const all = signals.filter(s => s.module === k), cl = all.filter(s => s.status === 'KAPALI' && s.result !== 'DOLMADI');
    const wins = cl.filter(s => s.netR > 0).length, losses = cl.length - wins;
    const reasons = {};
    cl.forEach(s => { const r = s.result || '?'; reasons[r] = (reasons[r] || 0) + 1; T.reasons[r] = (T.reasons[r] || 0) + 1; });
    const row = { module: k, label: MODS[k].label, enabled: !!MODS[k].enabled, total: all.length, open: all.filter(s => s.status !== 'KAPALI').length, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, grossR: +cl.reduce((a, s) => a + (s.grossR || 0), 0).toFixed(2), netR: +cl.reduce((a, s) => a + (s.netR || 0), 0).toFixed(2), reasons };
    rows.push(row);
    T.total += row.total; T.open += row.open; T.wins += wins; T.losses += losses; T.grossR += row.grossR; T.netR += row.netR;
  });
  const c = T.wins + T.losses;
  T.winRate = c ? +(T.wins / c * 100).toFixed(1) : 0; T.grossR = +T.grossR.toFixed(2); T.netR = +T.netR.toFixed(2);
  rows.push(T);
  return rows;
}

/* ── Backtest ── */
const BT = {
  PUMP:    { tf: '1m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m1.hold / 60), detect: w => detectBurst(w, M1, null), pump: true },
  PUMP3:   { tf: '3m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m3.hold / 180), detect: w => detectBurst(w, M3, null), pump: true },
  SCALPX3: { tf: '3m',  warm: 60,  win: 80,  maxBars: 3, detect: w => detectScalpX(w, '3m') },
  SCALPX5: { tf: '5m',  warm: 60,  win: 80,  maxBars: 3, detect: w => detectScalpX(w, '5m') },
  SCALPER: { tf: '15m', warm: 80,  win: 100, maxBars: 16, detect: w => detectScalper(w) },
  TREND:   { tf: '5m',  warm: 100, win: 130, maxBars: 24, detect: w => detectPSAR(w) },
  LT:      { tf: '4h',  warm: 70,  win: 130, maxBars: 30, detect: w => detectLT(w).signal || null },
  ZONE:    { tf: '1h',  warm: 260, win: 260, maxBars: 24, detect: w => detectZone(w, buildZones(w, null)).signal },
  RANGE:   { tf: '15m', warm: 80,  win: 100, maxBars: 12, detect: w => detectRevert(w) },
  DAILY:   { tf: '15m', warm: 80,  win: 100, maxBars: 24, detect: () => null }
};
const BT_TOTAL = { '1m': 2400, '3m': 1500, '5m': 1500, '15m': 6000, '1h': 2500, '4h': 1500, '1d': 400 };
function btStats(rs) {
  const n = rs.length;
  if (!n) return { n: 0, winRate: 0, pf: 0, maxDD: 0, sumR: 0, avgR: 0 };
  let w = 0, gw = 0, gl = 0, cum = 0, peak = 0, dd = 0;
  for (const r of rs) { if (r > 0) { w++; gw += r; } else gl -= r; cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { n, winRate: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), maxDD: +dd.toFixed(2), sumR: +cum.toFixed(2), avgR: +(cum / n).toFixed(3) };
}
function btCoin(cs, cfg, refDir, ms) {
  const out = [];
  for (let i = cfg.warm; i < cs.length - 1; i++) {
    const w = cs.slice(Math.max(0, i - cfg.win + 1), i + 1);
    let det = null;
    try { det = cfg.detect(w); } catch (e) { det = null; }
    if (!det) continue;
    const t = Object.assign({}, det, { curSl: det.sl, tp1Hit: false, createdAt: 0, peakPct: null });
    if (cfg.pump) { const atrPct = det.info && det.info.atr && det.entry > 0 ? det.info.atr / det.entry * 100 : (det.atrPct > 0 ? det.atrPct : 0.55); t.atrPct = atrPct; t.quickTpPct = quickTpOf(atrPct); t.quickTimeSec = t.quickTpPct != null ? EX.QUICK_TIME : null; t.quickArmPct = t.quickTpPct != null ? EX.QUICK_ARM : null; }
    const maxBars = det.maxBars > 0 ? det.maxBars : cfg.maxBars;
    let exit = null, reason = 'SURE', k = Math.min(cs.length - 1, i + maxBars);
    for (let j = i + 1; j <= k; j++) {
      const c = cs[j];
      if (cfg.pump && t.quickTpPct != null) { const d = t.dir === 'LONG' ? 1 : -1; const slHit = d > 0 ? c.l <= t.curSl : c.h >= t.curSl; if (slHit) { exit = t.curSl; reason = 'SL'; k = j; break; } const qp = t.entry * (1 + d * t.quickTpPct / 100); if (d > 0 ? c.h >= qp : c.l <= qp) { exit = qp; reason = 'QUICK'; k = j; break; } }
      const r = stepTrade(t, c);
      if (r && r.done) { exit = r.price; reason = cfg.pump && r.reason === 'TP1' ? 'TPMAX' : r.reason; k = j; break; }
      if (cfg.pump) {
        pumpPeak(t, t.dir === 'LONG' ? c.h : c.l);
        if (t.quickTpPct != null) { const age = (j - i) * ms, d = t.dir === 'LONG' ? 1 : -1; const pnl = (c.c / t.entry - 1) * d * 100; const qt = (t.quickTimeSec || EX.QUICK_TIME) * 1000; if (age >= qt - 1 && pnl < (t.quickArmPct || EX.QUICK_ARM) - 1e-9) { exit = ms > qt ? c.o + (c.c - c.o) * (qt / ms) : c.c; reason = 'QUICK_TIME'; k = j; break; } }
        const dec = pumpDecide(t, c.c, (j - i) * ms);
        if (dec) { const at = dec === 'NOMOVE' ? EX.NO_MOVE * 1000 : (dec === 'QUICK_TIME' ? (t.quickTimeSec || EX.QUICK_TIME) * 1000 : 0); exit = at > 0 && ms > at ? c.o + (c.c - c.o) * (at / ms) : c.c; reason = dec; k = j; break; }
      }
    }
    if (exit == null) exit = cs[k].c;
    const R = calcR(t, exit);
    const rd = refDir(cs[i].t + ms);
    out.push({ t: cs[i].t, net: R.net, gross: R.gross, reason, ok: true, aligned: !rd || rd === det.dir });
    i = k;
  }
  return out;
}
async function runBacktest(job) {
  const { module: mod, coins } = job.params, tf = job.params.tf, ms = TF_MS[tf];
  const baseCfg = job.params.cfgKey ? BT[job.params.cfgKey] : ((mod === 'PUMP' && tf === '3m') ? BT.PUMP3 : BT[mod]);
  const syms = TOP.slice(0, coins), trades = [];
  let tMin = Infinity, tMax = 0, done = 0, used = 0;
  const btc = await fetchHistory('BTC/USDT:USDT', '1h', Math.min(2400, Math.ceil(BT_TOTAL[tf] * ms / H1) + 60));
  const dirBy = new Map();
  if (btc.length > 60) { const e50 = emaArr(closes(btc), 50); btc.forEach((c, i) => dirBy.set(c.t, c.c > e50[i] ? 'LONG' : 'SHORT')); }
  const refDir = t => dirBy.get(Math.floor(t / H1) * H1 - H1);
  for (const sym of syms) {
    try {
      let cfg = baseCfg;
      if (mod === 'DAILY') { const d1 = await fetchHistory(sym, '1d', BT_TOTAL['1d']); const dm = buildDailyMap(d1); cfg = Object.assign({}, BT.DAILY, { detect: w => { const lv = dm.get(dayKeyOf(w[w.length - 1].t)); return lv ? detectDailySweep(w, lv) : null; } }); }
      const cs = await fetchHistory(sym, tf, BT_TOTAL[tf]);
      if (cs.length >= cfg.warm + 30) { used++; tMin = Math.min(tMin, cs[0].t); tMax = Math.max(tMax, cs[cs.length - 1].t); btCoin(cs, cfg, refDir, ms).forEach(x => trades.push(Object.assign({ sym: baseOf(sym) }, x))); }
    } catch (e) { }
    job.progress = +(++done / syms.length).toFixed(2);
  }
  trades.sort((a, b) => a.t - b.t);
  const ft = trades.filter(x => x.ok), split = tMin + 0.6 * (tMax - tMin);
  const train = ft.filter(x => x.t < split).map(x => x.net), valid = ft.filter(x => x.t >= split).map(x => x.net);
  let cum = 0, curve = ft.map(x => +(cum += x.net).toFixed(3));
  const step = Math.max(1, Math.ceil(curve.length / 400));
  if (step > 1) curve = curve.filter((_, i) => i % step === 0);
  const reasons = {};
  ft.forEach(x => { const r = reasons[x.reason] || (reasons[x.reason] = { n: 0, sumNet: 0 }); r.n++; r.sumNet = +(r.sumNet + x.net).toFixed(3); });
  job.result = {
    module: mod, label: MODS[mod].label, tf, coins: used, trades: ft.length, reasons,
    all: btStats(ft.map(x => x.net)), train: btStats(train), valid: btStats(valid),
    curve, splitIdx: Math.floor(train.length / step),
    aligned: btStats(trades.filter(x => x.aligned).map(x => x.net)), counter: btStats(trades.filter(x => !x.aligned).map(x => x.net)),
    note: VERSION + ': Net R maliyetlidir (H=%' + COST_PCT + '). Backtest kapanmış mumlarda. AI onayı simüle edilmez.'
  };
  job.status = 'bitti';
}

const STRATEGIES = [
  { module: 'TREND', name: 'Trend (Pullback)', tf: '15m', desc: 'EMA20>EMA50 trendinde EMA20 bölgesine geri çekilme + dönüş mumu + RSI makul + ADX ≥ 15. AI puanlar; işlem açmaz.', params: 'SL son 8 mumun ucu ∓0.2 ATR, TP1 1.5R, TP2 2.5R.' },
  { module: 'SCALPER', name: 'Scalper (SMC/BOS)', tf: '15m', desc: 'Swing kırılımı + hacim ≥ ' + SCALP.minVolX + 'x.', params: 'SL 0.5 ATR, TP1 ' + SCALP.tp1R + 'R, TP2 ' + SCALP.tp2R + 'R.' },
  { module: 'LT', name: 'LT Üçgen', tf: '2h + 4h (1d teyit)', desc: 'AI üretimli: matematik gevşek üçgen (son 3 mumda kırılım veya %1.5 yakınlık). AI stratejiye uyuyor mu bakar, puanlar, sinyali üretir. İşlem açmaz.', params: 'AI entry/sl/tp1/tp2 verir. AI risk kuralları: max %6 stop, min 0.6 net R:R.' },
  { module: 'DAILY', name: 'Günlük Sweep', tf: '15m', desc: 'PDH/PDL fitille süpürme + içeri kapanış. AI stratejiye uyuyor mu bakar, puanlar ve sinyali üretir. Seans 00:00–23:00 UTC. İşlem açılmaz.', params: 'SL süpürme ucu ±' + DAILY.stopAtr + ' ATR, TP1 gün ortası veya ' + DAILY.tp1R + 'R, TP2 ' + DAILY.tp2R + 'R.' },
  { module: 'ZONE', name: 'Zone Master', tf: '1h + 4h', desc: 'Pivot kümeleme + onay mumu + trend yönü.', params: 'SL bölge dışı 0.3×ATR, TP1 1.5R.' },
  { module: 'RANGE', name: 'Range (Mean Reversion)', tf: '15m', desc: 'Bollinger dışı reddedilme + fitil. ADX < ' + REVERT.adxMax + '.', params: 'SL fitil ucunun ' + REVERT.stopAtr + ' ATR ötesi, TP1 orta bant.' },
  { module: 'PUMP', name: 'AlgoScalp (3-5dk)', tf: '3m + 5m', desc: 'Son ' + SCALPX.brkBars + ' mumun tepe/dip kırılımı + gövde ≥ %' + Math.round(SCALPX.minBodyFrac * 100) + ' + hacim ≥ ' + SCALPX.minVolX + 'x. AI GİRİLİR/GİRİLMEZ + planı verir.', params: 'SL yapısal (%' + SCALPX.slMin + '–' + SCALPX.slMax + '), TP2 ≈ ' + SCALPX.tp2Mult + '×TP1.' }
];

/* ── Express API ── */
const app = express();
app.use(express.json({ limit: '100kb' }));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { log('API HATA ' + req.path + ': ' + e.message); res.status(500).json({ error: e.message }); });
function view(s) {
  const px = priceOf(s.symbol), d = s.dir === 'LONG' ? 1 : -1;
  const v = Object.assign({}, s, { modLabel: MODS[s.module].label, livePrice: px || null, livePct: px && isOpenSignal(s) ? +(((px / s.entry - 1) * d) * 100).toFixed(3) : null });
  if (s.status === 'ONAY_BEKLIYOR' && s.approvalExpiresAt) v.approvalRemainingMs = Math.max(0, s.approvalExpiresAt - Date.now());
  return v;
}
function paperView(p) { if (p.status === 'KAPALI') return p; const px = priceOf(p.symbol) || p.entry, r = paperPnl(p, px); return Object.assign({}, p, { livePrice: px, livePnl: +r.pnl.toFixed(2), livePnlPct: +r.pct.toFixed(2), ageMs: Date.now() - p.openedAt }); }
const PLACEHOLDER = '<!doctype html><html><body><h2>AlphaSon ' + VERSION + '</h2><p><a href="/api/state">/api/state</a></p></body></html>';
app.get('/', (req, res) => { let html = PLACEHOLDER; try { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) html = fs.readFileSync(p, 'utf8'); } catch (e) { } res.set('Content-Type', 'text/html; charset=utf-8').send(html); });
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, liveReady: IS_LIVE_READY }));
app.get('/api/state', h((req, res) => {
  const act = signals.filter(isOpenSignal), byMod = {};
  Object.keys(MODS).forEach(k => { byMod[k] = act.filter(s => s.module === k).length; });
  res.json({ version: VERSION, now: Date.now(), uptime: Math.round(process.uptime()), market, settings, counts: { active: act.length, pendingAI: signals.filter(s => s.status === 'AI_BEKLIYOR').length, pendingApproval: signals.filter(s => s.status === 'ONAY_BEKLIYOR').length, byModule: byMod, openPump: paper.open.filter(p => p.module === 'PUMP').length, autoMaxOpen: AI.autoMaxOpen }, scan: { universe: TOP.length, all: ALL.length, excluded: stats.excluded, apiErr: stats.apiErr, tickAt: stats.tickAt }, blocks: BLK, paper: paperSummary(), modules: MODS, activeModules: Object.keys(MODS).filter(k => MODS[k].enabled), passiveModules: Object.keys(MODS).filter(k => !MODS[k].enabled), daily: { levels: Array.from(DAILY_LEVELS.values()).slice(0, 40), watch: WATCH.daily.length }, ai: aiStatus(), ready: TOP.length > 0, liveReady: IS_LIVE_READY, realBal, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE } });
}));
app.get('/api/signals', h((req, res) => { let l = signals; if (req.query.module) l = l.filter(s => s.module === String(req.query.module).toUpperCase()); if (req.query.status) l = l.filter(s => s.status === String(req.query.status).toUpperCase()); const act = l.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt); const cl = l.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, Number(req.query.closed) || 60); res.json({ active: act.map(view), closed: cl.map(view) }); }));
app.get('/api/chart/:id', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Sinyal bulunamadı' });
  let tf = s.module === 'PUMP' && s.info && s.info.tf && TF_MS[s.info.tf] ? s.info.tf : MODS[s.module].chartTf, raw;
  if (s.module === 'LT' && s.info && s.info.tf === '2h') { tf = '2h'; const r1 = await getC(s.symbol, '1h', 300, 20000); raw = r1 ? aggTF(r1, 120).slice(-150) : null; }
  else raw = await getC(s.symbol, tf, 150, 20000);
  const cs = raw || [], cl = closes(cs);
  res.json({ signal: view(s), tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]), ema20: emaArr(cl, 20).map(rp), ema50: emaArr(cl, 50).map(rp), tradingview: 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P' });
}));
app.post('/api/signal/:id/close', h((req, res) => { const s = signals.find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: 'Yok' }); if (!isOpenSignal(s)) return res.status(400).json({ error: 'Zaten kapalı' }); closeSignal(s, priceOf(s.symbol) || s.entry, 'MANUEL'); res.json({ ok: true }); }));
app.post('/api/signal/:id/execute', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Yok' });
  if (s.module !== 'PUMP') return res.status(400).json({ error: 'Sadece PUMP' });
  if (s.status !== 'ONAY_BEKLIYOR') return res.status(400).json({ error: 'Onay beklemiyor' });
  if (s.approvalExpiresAt && Date.now() > s.approvalExpiresAt) { s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = Date.now(); dirty = true; return res.status(400).json({ error: 'Onay süresi doldu' }); }
  const liveEntry = entryPx(s.symbol, s.dir);
  if (!(liveEntry > 0)) return res.status(400).json({ error: 'Fiyat yok' });
  const drift = Math.abs(liveEntry / s.entry - 1) * 100;
  const scalpSig = !!(s.info && s.info.trigger === 'scalp-break');
  if (drift > AI.pumpEntryDriftPct * (scalpSig ? 3 : 2)) { s.status = 'KAPALI'; s.result = 'AI_STALE'; s.closedAt = Date.now(); dirty = true; return res.status(400).json({ error: 'Fiyat %' + drift.toFixed(3) + ' değişti' }); }
  const prev = { entry: s.entry, sl: s.sl, curSl: s.curSl, tp1: s.tp1, tp2: s.tp2 };
  if (drift > 0.01) {
    const d = s.dir === 'LONG' ? 1 : -1;
    const stopPct = Math.abs(s.entry - s.sl) / s.entry * 100, tpPct = Math.abs(s.tp1 - s.entry) / s.entry * 100, tp2Pct = s.tp2 ? Math.abs(s.tp2 - s.entry) / s.entry * 100 : null;
    s.entry = rp(liveEntry); s.sl = rp(liveEntry * (1 - d * stopPct / 100)); s.curSl = s.sl; s.tp1 = rp(liveEntry * (1 + d * tpPct / 100));
    if (tp2Pct != null) s.tp2 = rp(liveEntry * (1 + d * tp2Pct / 100));
  }
  s.status = 'AKTIF'; s.startedAt = Date.now(); s.operatorApprovedAt = Date.now(); dirty = true;
  log('ALGOPUMP ONAY (operatör): ' + s.base + ' ' + s.dir);
  let err = null;
  try { err = await maybeOpenPaper(s); } catch (e) { err = e.message; }
  if (err) { Object.assign(s, prev); s.status = 'ONAY_BEKLIYOR'; delete s.startedAt; delete s.operatorApprovedAt; dirty = true; return res.status(400).json({ error: err }); }
  res.json({ ok: true, signal: view(s), paper: paperSummary() });
}));
app.post('/api/signal/:id/ai', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Yok' });
  if (!AI.modules.includes(s.module)) return res.status(400).json({ error: 'AI bu modülü incelemiyor' });
  if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' });
  const ai = await aiReview(s, { force: true });
  if (!ai || ai.error) return res.status(429).json({ error: (ai && ai.error) || 'AI yanıt yok' });
  res.json({ ok: true, ai, signal: view(s) });
}));
app.get('/api/paper', h((req, res) => res.json({ settings, summary: paperSummary(), open: paper.open.map(paperView), closed: paper.closed.slice(0, 50), limits: { maxOpen: settings.maxOpen, autoMaxOpen: AI.autoMaxOpen, dailyLossPct: settings.dailyLossPct, slippage: PAPER_SLIP } })));
app.post('/api/paper/settings', h((req, res) => { const merged = Object.assign({}, settings, req.body || {}); merged.auto = settings.auto; settings = sanitizeSettings(merged); saveSettings(); log('AYARLAR kaydedildi'); res.json({ ok: true, settings }); }));
app.post('/api/paper/toggle', h((req, res) => { settings.auto = req.body && req.body.auto !== undefined ? !!req.body.auto : !settings.auto; saveSettings(); log('OTO-TRADE ' + (settings.auto ? 'AÇILDI' : 'KAPALI')); res.json({ ok: true, settings, autoMaxOpen: AI.autoMaxOpen }); }));
app.post('/api/paper/:id/close', h(async (req, res) => { const p = paper.open.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Yok' }); const ok = await closePaper(p, exitPx(p) || p.entry, 'MANUEL'); if (!ok) return res.status(500).json({ error: 'Kapatılamadı' }); res.json({ ok: true }); }));
app.post('/api/trade/mode', h(async (req, res) => { const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper'; if (mode === 'live') { if (!IS_LIVE_READY) return res.status(400).json({ error: 'API anahtarı eksik' }); await fetchRealBalance(); if (!(realBal.total > 0)) return res.status(400).json({ error: 'Bakiye okunamadı' }); if (!(settings.dailyLossPct > 0)) { settings.dailyLossPct = 3; log('LIVE: günlük zarar limiti %3'); } paper.liveDayStart = realBal.total; paper.liveDayPnl = 0; paper.dayKey = new Date().toISOString().slice(0, 10); } settings.tradeMode = mode; saveSettings(); log('MOD: ' + mode.toUpperCase()); res.json({ ok: true, settings }); }));
app.post('/api/paper/reset', h((req, res) => { const lives = paper.open.filter(p => p.isLive); paper = { seq: paper.seq, balance: START_BALANCE, startBalance: START_BALANCE, open: lives, closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: paper.liveDayPnl || 0, liveDayStart: paper.liveDayStart || 0 }; dirty = true; res.json({ ok: true }); }));
app.get('/api/watch/:kind', h((req, res) => res.json({ items: WATCH[req.params.kind] || [] })));
app.post('/api/watch/lt/:base/ai', h(async (req, res) => {
  const base = String(req.params.base || '').toUpperCase();
  const w = (WATCH.lt || []).find(x => x.base === base);
  if (!w) return res.status(404).json({ error: 'Coin LT watch listesinde yok' });
  if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' });
  w.ai = null; // force refresh
  await autoWatchAI(w);
  if (!w.ai) return res.status(502).json({ error: 'AI yanıt vermedi' });
  res.json({ ok: true, ai: w.ai });
}));
app.get('/api/rejections', h((req, res) => { const limit = Math.min(Number(req.query.limit) || 60, 200); const module = req.query.module ? String(req.query.module).toUpperCase() : null; const items = module ? RECENT_REJ.filter(r => r.module === module) : RECENT_REJ; res.json({ at: Date.now(), items: items.slice(0, limit), modules: Array.from(new Set(RECENT_REJ.map(r => r.module))) }); }));
app.get('/api/radar', h((req, res) => res.json({ radar, market, moneyFlow: moneyFlow(10) })));
app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: COST_PCT })));
app.get('/api/dataset', h((req, res) => { const rows = signals.filter(s => s.status === 'KAPALI' && s.result !== 'DOLMADI' && s.exit != null).map(s => { const R = calcR(s, s.exit); const f = s.info || {}; return { id: s.id, module: s.module, dir: s.dir, conf: s.conf, marketAlign: s.marketAlign, counter: !!s.counter, createdAt: s.createdAt, closedAt: s.closedAt, reason: s.result, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, grossR: +R.gross.toFixed(4), netR: +R.net.toFixed(4), adx: f.adx, volRatio: f.volRatio, atrPct: f.atrPct, riskPct: f.riskPct, netRR: f.netRR, z: f.z, vBurst: f.vBurst, spreadPct: f.spreadPct, oi1: f.oi1, oi5: f.oi5, tf: f.tf, source: f.source }; }); res.json({ n: rows.length, costPct: COST_PCT, rows }); }));
app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: STRATEGIES.map(s => Object.assign({}, s, { active: !!MODS[s.module].enabled })) })));
app.get('/api/ai/status', h((req, res) => {
  const st = aiStatus();
  st.recent = signals.filter(s => s.ai && !s.ai.error).slice(-15).reverse().map(s => ({ id: s.id, module: s.module, base: s.base, dir: s.dir, verdict: s.ai.verdict, verdictLabel: s.ai.verdict === 'ONY' ? 'GİRİLİR' : 'GİRİLMEZ', phase: s.ai.phase, trust: s.ai.trust, score: s.ai.score, summary: s.ai.summary, provider: s.ai.providerName, model: s.ai.model, at: s.ai.at, latencyMs: s.ai.latencyMs }));
  st.recentAISignals = signals.filter(s => s.info && s.info.source === 'ai').slice(-15).reverse().map(s => ({ id: s.id, module: s.module, base: s.base, dir: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, conf: s.conf, score: s.info.aiScore, trust: s.info.aiTrust, reason: s.info.reason, risks: s.info.risks, provider: s.info.providerName, model: s.info.model, at: s.createdAt }));
  res.json(st);
}));
app.get('/api/ai/brief', h((req, res) => res.json({ brief: marketBrief, status: aiStatus() })));
app.post('/api/ai/brief', h(async (req, res) => { if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' }); const b = await aiMarketBrief(true); if (!b) return res.status(429).json({ error: aiUsage.lastError || 'Brifing üretilemedi' }); res.json({ ok: true, brief: b, status: aiStatus() }); }));
app.post('/api/ai/reset', h((req, res) => { const target = (req.body && req.body.provider) ? String(req.body.provider).toLowerCase() : null; const cleared = []; for (const p of AI.providers) { if (target && p.id !== target) continue; p.cooldownUntil = 0; p.modelCooldowns = {}; p.lastError = null; p.nextAt = 0; cleared.push(p.id); } aiUsage.lastError = null; saveAI(); log('AI SIFIRLANDI: ' + (cleared.join(', ') || '-')); res.json({ ok: true, cleared, providers: AI.providers.map(aiProviderView) }); }));
app.post('/api/ai/toggle', h((req, res) => { settings.aiEnabled = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !settings.aiEnabled; saveSettings(); log('AI ' + (settings.aiEnabled ? 'AÇILDI' : 'KAPATILDI')); res.json({ ok: true, ai: aiStatus() }); }));
app.get('/api/ai/test', h(async (req, res) => { const target = req.query.provider ? String(req.query.provider).toLowerCase() : null; const out = []; for (const p of AI.providers) { if (target && p.id !== target) continue; if (!p.key) { out.push({ provider: p.id, hasKey: false, results: [] }); continue; } out.push({ provider: p.id, name: p.name, hasKey: true, keyLen: p.key.length, models: p.models, results: await aiTestProvider(p) }); } res.json({ at: Date.now(), providers: out }); }));
app.all('/api/ai/discover', h(async (req, res) => { await discoverAll(); res.json({ ok: true, providers: AI.providers.map(aiProviderView) }); }));
app.get('/api/diag', h((req, res) => res.json({ version: VERSION, now: Date.now(), market, universe: TOP.length, tickAgeSec: stats.tickAt ? Math.round((Date.now() - stats.tickAt) / 1000) : null, settings, openPump: paper.open.filter(p => p.module === 'PUMP').length, gates: { scalp: Object.assign({}, PWHY), trend: Object.assign({}, TWHY), lt: Object.assign({}, LWHY), blocks: BLK }, scanCounters: SC, ai: aiStatus() })));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.post('/api/backtest', h((req, res) => {
  const b = req.body || {}, mod = String(b.module || '').toUpperCase();
  if (!BT[mod]) return res.status(400).json({ error: 'Geçersiz modül' });
  const tf = BT_TOTAL[b.tf] ? b.tf : BT[mod].tf;
  const effTf = mod === 'PUMP' ? (b.tf === '3m' ? '3m' : b.tf === '5m' ? '5m' : '1m') : (mod === 'TREND' || mod === 'SCALPER' || mod === 'RANGE' || mod === 'DAILY') ? BT[mod].tf : tf;
  const cfgKey = mod === 'PUMP' && b.engine === 'scalp' ? (effTf === '5m' ? 'SCALPX5' : 'SCALPX3') : null;
  const coins = clamp(parseInt(b.coins, 10) || 10, 1, 40);
  if (!TOP.length) return res.status(503).json({ error: 'Sistem hazır değil' });
  if (Object.values(jobs).some(j => j.status === 'çalışıyor')) return res.status(429).json({ error: 'Başka backtest çalışıyor' });
  const finalTf = cfgKey ? (cfgKey === 'SCALPX5' ? '5m' : '3m') : effTf;
  const id = 'B' + Date.now(), job = { id, status: 'çalışıyor', progress: 0, params: { module: mod, tf: finalTf, coins, cfgKey }, startedAt: Date.now() };
  jobs[id] = job;
  log('BACKTEST: ' + MODS[mod].label + ' ' + finalTf + ' ' + coins + ' coin' + (cfgKey ? ' (scalp)' : ''));
  runBacktest(job).catch(e => { job.status = 'hata'; job.error = e.message; log('BACKTEST HATA: ' + e.message); });
  res.json({ id });
}));
app.get('/api/backtest/:id', h((req, res) => { const j = jobs[req.params.id]; if (!j) return res.status(404).json({ error: 'Yok' }); res.json(j); }));

/* ── Init / start ── */
async function init() {
  if (!IS_LIVE_READY) log('UYARI: API anahtarı yok — sadece PAPER');
  else log('API anahtarları yüklendi. CANLI için hazır (tavan: ' + LIVE_MAX_MARGIN + ' USDT, ' + LIVE_MAX_LEVERAGE + 'x).');
  for (;;) { try { await ex.loadMarkets(); await refreshUniverse(); break; } catch (e) { log('HATA borsa: ' + e.message + ', 15 sn sonra'); await sleep(15000); } }
  every('evren', 30 * M1, refreshUniverse, 30 * M1);
  every('piyasa', 2 * M1, marketCycle, 3000);
  every('realbal', 30000, fetchRealBalance, 5000);
  every('livesync', 10000, syncLive, 15000);
  every('ticker', 3000, refreshTickers, 0);
  if (PUMP.useIgnition) { every('armed', 30000, refreshArmed, 2500); every('atr', 30000, refreshAtr, 6000); every('levarm', 60000, refreshLeverageArms, 15000); }
  every('pump', PUMP.useIgnition ? 500 : 1000, pumpCycle, 1500);
  every('scalpx', SCALPX.scanMs, scalpScanX, 20000);
  every('takip', 20000, trackerCycle, 8000);
  if (MODS.SCALPER.enabled) every('scalper', 60000, scanScalper, 12000);
  if (MODS.RANGE.enabled) every('range', 5 * M1, scanRange, 25000);
  if (MODS.ZONE.enabled) every('zone', 5 * M1, scanZone, 45000);
  if (MODS.TREND.enabled) every('trend', AI.aiScanTrendMs, aiScanTrend, 60000);
  if (MODS.LT.enabled) { every('lt', AI.aiScanLTMs, aiScanLT, 120000); every('ltretest', 60000, ltRetestCycle, 120000); }
  if (MODS.DAILY.enabled) { every('dailylev', 60 * M1, refreshDailyLevels, 30000); every('daily', DAILY.scanEvery, scanDaily, 90000); }
  every('radar', 5 * M1, radarCycle, 20000);
  every('aibrief', 30 * M1, maybeMarketBrief, 150000);
  every('kayit', 30000, async () => { saveAll(); }, 30000);
  every('pump-log', 5 * M1, async () => { const tot = signals.filter(s => s.module === 'PUMP').length; log('Scalp taraması: ' + stats.pumpScanned + ' mum, ' + stats.pumpFound + ' sinyal, toplam ' + tot); const why = Object.keys(PWHY).sort((a, b) => PWHY[b] - PWHY[a]).map(k => k + ' ' + PWHY[k]).join(', '); if (why) log('Scalp red: ' + why); Object.keys(PWHY).forEach(k => delete PWHY[k]); stats.pumpScanned = 0; stats.pumpFound = 0; }, 5 * M1);
  every('tarama-ozet', 10 * M1, async () => { const parts = Object.keys(SC).map(m => MODS[m].label + ' [' + Object.keys(SC[m]).map(k => k + ' ' + SC[m][k]).join(', ') + ']'); log('Tarama özeti (10 dk): ' + (parts.join(' | ') || 'yok')); const wy = o => Object.keys(o).sort((a, b) => o[b] - o[a]).map(k => k + ' ' + o[k]).join(', '); if (Object.keys(TWHY).length) log('Trend red: ' + wy(TWHY)); if (Object.keys(LWHY).length) log('LT red: ' + wy(LWHY)); Object.keys(TWHY).forEach(k => delete TWHY[k]); Object.keys(LWHY).forEach(k => delete LWHY[k]); Object.keys(SC).forEach(k => delete SC[k]); }, 10 * M1);
  every('temizlik', 10 * M1, async () => { const now = Date.now(); Object.keys(jobs).forEach(k => { if (now - jobs[k].startedAt > 30 * M1) delete jobs[k]; }); prunePumpState(now); if (SCALP_SEEN.size > 4000) SCALP_SEEN.clear(); }, 10 * M1);
}
function start() {
  log('AlphaSon ' + VERSION + ' başlatılıyor...' + (ALLOW_TOKENIZED ? ' (tokenize AÇIK)' : ''));
  const inv = assertInvariants();
  log('Maliyet: H=' + inv.H + '% | en kötü FADE neti +' + inv.worstFadeNet + '% | BE neti ' + inv.costCoverNet + '%');
  loadAll();
  log(VERSION + ' odak: ' + Object.keys(MODS).filter(k => MODS[k].enabled).map(k => MODS[k].label).join(', ') + ' | pasif: ' + Object.keys(MODS).filter(k => !MODS[k].enabled).map(k => MODS[k].label).join(', '));
  log(VERSION + ' AI: ' + (aiReady() ? 'HAZIR (' + aiKeys().length + ' sağlayıcı) | kapsam ' + AI.modules.join('+') + ' | kota ' + AI.maxPerDay + '/gün' : 'anahtar yok'));
  for (const p of AI.providers) if (p.key) log('  AI ' + p.name + ': ' + ((p.models || []).join(' → ') || '(keşif bekliyor)') + ' | gap ' + (AI.gapMs[p.id] || 3000) + ' ms');
  if (PUMP.useIgnition) stream.start();
  setTimeout(() => aiBootstrap().catch(e => log('AI BOOTSTRAP: ' + e.message)), 4000);
  setInterval(() => discoverAll().catch(() => { }), 60 * M1);
  app.listen(PORT, () => log('Sunucu: port ' + PORT));
  init().catch(e => log('KRİTİK init: ' + e.message));
}
process.on('uncaughtException', e => log('UNCAUGHT: ' + (e && e.message)));
process.on('unhandledRejection', e => log('UNHANDLED: ' + (e && e.message ? e.message : e)));
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { log('Kapanıyor...'); dirty = true; saveAll(); process.exit(0); }));

if (require.main === module) start();
module.exports = { VERSION, aiStatus, getSignals: () => signals, getSettings: () => settings, RECENT_REJ, WATCH };
