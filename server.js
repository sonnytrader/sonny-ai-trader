'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v77.1 — AI ONAYLI ALGOPUMP + TREND
   ───────────────────────────────────────────────────────────────────────────
   v77.1 MODEL DÜZELTMESİ (v76 çalışan setine dönüş):
     • Gemini: gemini-3.5-flash-lite (+ 3.6-flash yedek). 2.x serisi TAMAMEN
       kaldırıldı; Google bu modeller için 404 döndürüyor.
     • Groq: openai/gpt-oss-20b (+ qwen/qwen3.8-27b yedek). llama-3.x serisi
       Groq'tan kaldırıldı.
     • modelCooldownMs 30→10 dk, providerFail isModelError 30→10 dk.
     • POST /api/ai/reset ile cooldown'lar elle sıfırlanabilir.

   Akış: MATEMATİK → SİNYAL → AI KARAR → OPERATÖR ONAYI → İŞLEM.
   AlgoPump için AI ONAY sonrası sinyal ONAY_BEKLIYOR'a düşer; işlem
   /api/signal/:id/execute çağrısı gelene kadar AÇILMAZ.
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = 'v77.1';
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

/* ───────── API & BORSA ───────── */
const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || '';
const IS_LIVE_READY = !!(API_KEY && API_SECRET && API_PASS);
const LIVE_MAX_MARGIN = Number(process.env.LIVE_MAX_MARGIN) || 25;
const LIVE_MAX_LEVERAGE = Number(process.env.LIVE_MAX_LEVERAGE) || 5;
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };

/* ───────── SABİTLER ───────── */
const COST_PCT = 0.20;
const FEE_SIDE = 0.0006;
const PAPER_SLIP = 0;
const START_BALANCE = 1000;
const M1 = 60000, M3 = 180000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '3m': 20000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend (PSAR)',      max: 99, quota: null, maxAge: 2 * H1,  cooldown: 10 * M1, chartTf: '5m',  enabled: true },
  SCALPER: { label: 'Scalper',           max: 99, quota: null, maxAge: 4 * H1,  cooldown: 15 * M1, chartTf: '15m', enabled: false },
  LT:      { label: 'LT Üçgen',          max: 99, quota: null, maxAge: 5 * D1,  cooldown: 6 * H1,  chartTf: '4h',  enabled: true },
  ZONE:    { label: 'Zone Master',       max: 99, quota: null, maxAge: 12 * H1, cooldown: 30 * M1, chartTf: '1h',  enabled: false },
  RANGE:   { label: 'Range (Mean Rev.)', max: 99, quota: null, maxAge: 3 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: false },
  PUMP:    { label: 'AlgoPump',          max: 99, quota: null, maxAge: 4 * M1,  cooldown: 2 * M1,  chartTf: '1m',  enabled: true },
  DAILY:   { label: 'Günlük Sweep',      max: 99, quota: null, maxAge: 6 * H1,  cooldown: 4 * H1,  chartTf: '15m', enabled: true, maxPerDaySym: 3 }
};
const REASON = {
  TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'TP1 sonrası başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel kapatma',
  TPMAX: 'Maksimum hedef', FADE: 'Kâr geri verildi', BAIL: 'Erken kaçış', NOMOVE: 'Hareket yok', MOMENTUM: 'İvme bitti (net kârda)',
  QUICK: 'Vur-kaç kârı', QUICK_TIME: 'Vur-kaç süresi doldu',
  AI_RED: 'AI giriş reddi', AI_ERROR: 'AI yanıtı yok', AI_TIMEOUT: 'AI onayı zaman aşımı', AI_STALE: 'AI sonrası fiyat değişti',
  APPROVAL_EXPIRED: 'Operatör onayı verilmedi'
};

/* ───────── v77.0 PUMP — ESNETİLMİŞ ───────── */
const PUMP = {
  minQuoteVol: 500000,
  maxSpreadPct: 0.20,
  snapKeepMs: 360000,
  pre30: 0.30, pre60: 0.45, pre150: 0.80,
  maxCand: 10,
  recheckMs: 2500,
  barMs: 15000,
  coilBars: 10,
  coilMaxPct: 1.40,
  bodyMin: 0.40,
  dispMinPct: 0.07,
  minElapsedMs: 3000,
  m1: { minMovePct: 0.60, minVolX: 3.0, minAtrX: 2.2, maxMovePct: 4.5, hold: 120, noMove: 40 },
  m3: { minMovePct: 1.00, minVolX: 2.5, minAtrX: 2.2, maxMovePct: 6.5, hold: 180, noMove: 45 },
  posMin: 0.50,
  priorMaxFrac: 0.45, priorVolMax: 3.0,
  maxExt15Pct: 9,
  slBodyFrac: 0.5, slMin: 0.50, slMax: 1.30,
  tpMaxPct: 1.6,
  macroFilter: true,
  useCandlePath: false,
  vel: {
    w: 6000, fastW: 2500,
    minMovePct: 0.10, fastMovePct: 0.07,
    minZ: 1.5,
    minVolRatio: 1.3,
    minHist: 30, minNoiseN: 12,
    minAtrX: 0.6,
    priorMaxPct: 0.65,
    maxLatePct: 0.25,
    dynamicLateCap: true,
    lateCapFrac: 0.28, lateCapMin: 0.12, lateCapMax: 0.32,
    minEdgeMult: 1.6,
    slBufferPct: 0.04,
    slMin: 0.50, slMax: 1.30, slAtrK: 0.80, slCostK: 2.50,
    maxCand: 10, recheckMs: 3000
  }
};

/* ───────── ÇIKIŞ MERDİVENİ ───────── */
const EX = {
  H: 0.20,
  MIN_NET: 0.10,
  GB_MIN: 0.30,
  GB_FRAC: 0.30,
  LOCK_ARM: 0.60,
  BE_ARM: 0.40,
  BE_LOCK: 0.22,
  BAIL_ARM: 0.35,
  BAIL_BELOW: -0.02,
  TP_MIN: 0.90,
  TP_MAX: 1.80,
  TP_ATR_K: 1.45,
  NO_MOVE: 40,
  HOLD: 120,
  DECAY_RATIO: 0.30,
  DECAY_MIN_PNL: 0.25,
  MIN_NET_RR: 1.05,
  VEL_WIN_MS: 2000,
  VEL_PEAK_MEMORY_MS: 12000,
  MIN_SL_PCT: 0.50,
  SL_ATR_K: 0.80,
  SL_COST_K: 2.50,
  QUICK_TP_K: 0.55, QUICK_TP_MIN: 0.40, QUICK_TP_MAX: 0.70,
  QUICK_TIME: 20, QUICK_ARM: 0.15
};

const EPS = 1e-9;

function rrNet(entry, sl, tp) {
  const risk = Math.abs(entry - sl) / entry * 100;
  const gain = Math.abs(tp - entry) / entry * 100;
  const rr = risk > 0 ? gain / risk : 0;
  const net = risk > 0 ? (gain - EX.H) / (risk + EX.H) : 0;
  return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) };
}
function assertInvariants() {
  const e = [];
  const worstFadeNet = EX.LOCK_ARM - EX.GB_MIN - EX.H;
  if (EX.GB_MIN < EX.H + EX.MIN_NET - EPS) e.push('GB_MIN < H + MIN_NET');
  if (worstFadeNet < EX.MIN_NET - EPS) e.push('LOCK_ARM çok düşük');
  if (!(EX.GB_FRAC < 1)) e.push('GB_FRAC >= 1');
  if (!(EX.LOCK_ARM > EX.BE_ARM)) e.push('LOCK_ARM > BE_ARM olmalı');
  if (!(EX.TP_MIN > EX.H + EX.MIN_NET)) e.push('TP_MIN > H + MIN_NET olmalı');
  if (EX.DECAY_MIN_PNL < EX.H + 0.05 - EPS) e.push('DECAY_MIN_PNL >= H+0.05 olmalı');
  if (!(EX.BE_LOCK > EX.H)) e.push('BE_LOCK > H olmalı');
  if (EX.MIN_SL_PCT < EX.SL_COST_K * EX.H - EPS) e.push('MIN_SL_PCT < SL_COST_K*H');
  if (PUMP.vel.minEdgeMult * EX.H >= EX.TP_MAX) e.push('minEdgeMult * H TP için yer bırakmıyor');
  if (EX.QUICK_TP_MIN < EX.H + 0.05 - EPS) e.push('QUICK_TP_MIN maliyet+0.05 üstünde olmalı');
  if (EX.QUICK_TP_MAX > EX.TP_MAX + EPS) e.push('QUICK_TP_MAX > TP_MAX');
  if (!(EX.QUICK_TIME < EX.NO_MOVE)) e.push('QUICK_TIME < NO_MOVE olmalı');
  if (!(EX.QUICK_ARM < EX.QUICK_TP_MIN)) e.push('QUICK_ARM < QUICK_TP_MIN olmalı');
  if (e.length) throw new Error('AlgoPump v77 invariant ihlali:\n  - ' + e.join('\n  - '));
  let minAtr = null, minA = null;
  for (let a = 0.05; a <= 5.0001; a += 0.005) {
    const A = clamp(EX.TP_ATR_K * a, 0.35, 3.0);
    const late = clamp(PUMP.vel.lateCapFrac * A, PUMP.vel.lateCapMin, PUMP.vel.lateCapMax);
    if (A - late < PUMP.vel.minEdgeMult * EX.H - EPS) continue;
    const slPct = Math.max(EX.MIN_SL_PCT, EX.SL_ATR_K * a, EX.SL_COST_K * EX.H);
    const tpPct = clamp(EX.TP_ATR_K * a, EX.TP_MIN, EX.TP_MAX);
    if (slPct > PUMP.vel.slMax + EPS) continue;
    if ((tpPct - EX.H) / (slPct + EX.H) < EX.MIN_NET_RR - EPS) continue;
    minAtr = +a.toFixed(3); minA = +A.toFixed(3); break;
  }
  return {
    H: EX.H, GB_MIN: EX.GB_MIN, LOCK_ARM: EX.LOCK_ARM,
    worstFadeNet: +worstFadeNet.toFixed(3),
    costCoverNet: +(EX.BE_LOCK - EX.H).toFixed(3),
    minTradeableLegPct: minA,
    minTradeableAtrPct: minAtr
  };
}

const SCALP = { minVolX: 2.0, maxDistPct: 1.2, maxDistAtrK: 0.80, minRiskPct: 0.80, minNetRR: 1.0, minConf: 65, tp1R: 1.5, tp2R: 2.5, pivL: 3, pivR: 3, lookback: 70 };
const REVERT = { bbP: 20, bbK: 2, adxMax: 25, minVolX: 1.5, wickMin: 0.5, limitAtr: 0.15, stopAtr: 0.3, minRiskPct: 0.50, maxRiskPct: 3, minRR: 1.0, minNetRR: 1.0, minConf: 60 };
const PSAR = { step: 0.02, max: 0.2, adxMin: 18, emaP: 34, wrP: 14, tp1R: 1.5, tp2R: 3, minRiskPct: 0.60, maxRiskPct: 4.0, minNetRR: 0.90, maxExtAtr: 3.0, minVolX: 0.60 };
const DAILY = {
  topN: 60, scanEvery: 2 * M1, minConf: 55,
  sessionStart: 0, lastEntryHour: 22, sessionEnd: 23, minRemainMs: 15 * M1,
  minWickAtr: 0.15, minWickRatio: 0.10, minBodyRatio: 0.30, minClosePos: 0.50,
  minVolX: 1.0, maxSpreadPct: 0.20, minRiskPct: 0.50, maxRiskPct: 3.0,
  stopAtr: 0.25, minDayRangePct: 0.80, maxDayRangePct: 15.0,
  tp1R: 1.5, tp2R: 2.5, tp1MidMinR: 0.60,
  maxAge: 6 * H1, maxSignalsPerDay: 3, firstSweepOnly: false, sweepLookback: 20,
  repeatPenalty: 8, requireAlign: false
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
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const rp = p => Number(Number(p).toPrecision(7));
const fmtP = p => (p >= 1 ? p.toFixed(4) : p.toPrecision(5));
const dayStartMs = () => Math.floor(Date.now() / D1) * D1;
const toC = a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] || 0 });
const closed = (cs, tfMs) => (cs && cs.length && cs[cs.length - 1].t + tfMs > Date.now() ? cs.slice(0, -1) : cs || []);

function loadJSON(f, def) {
  try {
    if (!fs.existsSync(f)) return def;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : def;
  } catch (e) { log('UYARI: ' + path.basename(f) + ' okunamadı, yeni başlanıyor (' + e.message + ')'); return def; }
}
function saveJSON(f, obj) {
  try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); }
  catch (e) { log('HATA: ' + path.basename(f) + ' kaydedilemedi: ' + e.message); }
}
async function fetchJSON(url, ms) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), ms || 8000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  const w = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { res[k] = await fn(items[k], k); } catch (e) { res[k] = null; } }
  });
  await Promise.all(w);
  return res;
}
function every(name, ms, fn, delay) {
  let run = false;
  const tick = async () => {
    if (run) return;
    run = true;
    try { await fn(); } catch (e) { log('HATA [' + name + ']: ' + e.message); } finally { run = false; }
  };
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
  if (!ps[m] || !ps[m - 1]) return null;
  if (ps[m].up === ps[m - 1].up) return no('PSAR dönüşü yok');
  const dir = ps[m].up ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1;
  const adx = adxLast(cs, 14);
  if (adx == null || adx < PSAR.adxMin) return no('ADX düşük');
  const wr = williamsR(cs, PSAR.wrP);
  if (wr == null) return null;
  if (dir === 'LONG' ? !(wr > -50) : !(wr < -50)) return no('Williams uyumsuz');
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
  const conf = 55 + clamp((adx - PSAR.adxMin) * 0.8, 0, 12) + clamp(Math.abs(wr + 50) / 50 * 10, 0, 8) + (vr >= 1.2 ? 5 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(tp1), tp2: rp(e + d * PSAR.tp2R * risk), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { adx: +adx.toFixed(1), williamsR: +wr.toFixed(1), psar: rp(ps[m].sar), ema34: rp(e34[m]), volRatio: +vr.toFixed(1), atr, riskPct: +riskPct.toFixed(2), netRR: q.net }
  };
}

function anchorLine(pts, up) {
  if (pts.length < 2) return null;
  const order = pts.slice().sort((x, y) => (up ? y.p - x.p : x.p - y.p));
  for (const a of order.slice(0, 4)) {
    const later = pts.filter(q => q.i > a.i);
    let best = null;
    for (const b of later) {
      const sl = (b.p - a.p) / (b.i - a.i);
      let ok = true, touches = 0;
      for (const q of later) {
        const lp = a.p + sl * (q.i - a.i), dv = (q.p - lp) / lp;
        if (up ? dv > 0.004 : dv < -0.004) { ok = false; break; }
        if (Math.abs(dv) <= 0.004) touches++;
      }
      if (!ok) continue;
      if (!best || touches > best.touches || (touches === best.touches && b.i > best.b.i)) best = { a, b, sl, touches };
    }
    if (best) return { a: best.a, sl: best.sl, touches: best.touches + 1 };
  }
  return null;
}
function analyzeTriangle(cs) {
  if (cs.length < 60) return null;
  const w = cs.slice(-120), m = w.length - 1, px = w[m].c;
  const pv = pivots(w, 4, 4);
  const Uc = anchorLine(pv.hi, true), Lc = anchorLine(pv.lo, false);
  if (!Uc || !Lc) return null;
  const U = x => Uc.a.p + Uc.sl * (x - Uc.a.i), L = x => Lc.a.p + Lc.sl * (x - Lc.a.i);
  if (Lc.sl <= Uc.sl) return null;
  const x0 = Math.max(Uc.a.i, Lc.a.i);
  if (m - x0 < 15) return null;
  const w0 = U(x0) - L(x0), wN = U(m) - L(m);
  if (w0 <= 0 || wN <= 0) return null;
  const comp = wN / w0;
  if (comp >= 0.75) return null;
  const xA = x0 + w0 / (Lc.sl - Uc.sl);
  const mat = (m - x0) / (xA - x0);
  if (mat < 0.4 || mat > 1.0) return null;
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
      info: {
        compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), volRatio: +vr.toFixed(1), height: rp(H), d1Confirm: d1,
        atr, atrPct: +atrPct.toFixed(2), netRR: q.net, riskPct: q.risk, lines,
        line0: rp(line0), lineSlope: +lineSlope.toPrecision(10), lineStep: step, lineT: last.t, mid: rp(mid), extPct: +extPct.toFixed(2)
      }
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
  if (below ? !(last.c > last.o) : !(last.c < last.o)) return null;
  const closePos = below ? (last.c - last.l) / rng : (last.h - last.c) / rng;
  if (closePos < DAILY.minClosePos) return null;
  const reclaim = (last.c - level) * d;
  if (!(reclaim >= 0.05 * atr)) return null;
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
  if (q.net < 1.0) return null;
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
    conf: clamp(Math.round(conf), 40, 95),
    maxAgeMs: Math.min(DAILY.maxAge, remain),
    maxBars,
    atrPct: +(atr / e * 100).toFixed(2),
    info: {
      tf: '15m', pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid), level: rp(level),
      sweepSide: below ? 'PDL' : 'PDH', dayKey,
      wickAtr: +(wick / atr).toFixed(2), wickRatio: +(wick / rng).toFixed(2),
      bodyRatio: +(body / rng).toFixed(2), closePos: +closePos.toFixed(2),
      reclaimAtr: +(reclaim / atr).toFixed(2), volRatio: +vr.toFixed(1),
      dayRangePct: +dayRangePct.toFixed(2), sweptBefore, tp1Mid,
      atr, atrPct: +(atr / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), netRR: q.net,
      session: '00:00–23:00 UTC', sessionEnd: new Date(sessionEnd).toISOString(), maxBars
    }
  };
}

function dailyWatch(cs, lv) {
  if (!cs || !cs.length || !lv || !(lv.pdh > 0) || !(lv.pdl > 0)) return null;
  const last = cs[cs.length - 1], atr = atrLast(cs, 14), price = last.c;
  if (!(atr > 0) || !(price > 0)) return null;
  const distPdh = (lv.pdh / price - 1) * 100, distPdl = (price / lv.pdl - 1) * 100;
  const near = Math.min(Math.abs(distPdh), Math.abs(distPdl));
  if (near > Math.max(1.5, 1.5 * (atr / price * 100))) return null;
  return {
    symbol: null, price: rp(price), pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid),
    distPdh: +distPdh.toFixed(2), distPdl: +distPdl.toFixed(2),
    nearSide: Math.abs(distPdh) < Math.abs(distPdl) ? 'PDH' : 'PDL',
    dayRangePct: +((lv.pdh - lv.pdl) / lv.pdl * 100).toFixed(2)
  };
}

function buildDailyMap(cs1d) {
  const m = new Map();
  for (const d of cs1d || []) {
    const dayKey = dayKeyOf(d.t + D1);
    m.set(dayKey, { pdh: d.h, pdl: d.l, dayMid: (d.h + d.l) / 2, dayKey, candleT: d.t });
  }
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

let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: 0, liveDayStart: 0 };
const DEF_SET = { auto: false, tradeMode: 'paper', margin: 100, leverage: 5, minConf: 60, maxMinutes: 5, riskPct: 0.5, maxOpen: 8, dailyLossPct: 0, pumpQuick: true, aiEnabled: true };
let settings = Object.assign({}, DEF_SET);
const market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, b1h: 0.5, b4h: 0.5, btc: null, eth: null, lastDirChange: 0, lastDirective: null, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [], daily: [] };
const DAILY_LEVELS = new Map();
const DWHY = {};
let marketBrief = null;
const LTR = new Map();
function saveLTR() { saveJSON(F_LTR, Array.from(LTR.values())); }
function loadLTR() {
  const a = loadJSON(F_LTR, []);
  if (!Array.isArray(a)) return;
  const now = Date.now();
  for (const e of a) {
    if (!e || !e.sym || !(e.step > 0) || !(e.line0 > 0)) continue;
    if (now - e.lineT > 12.5 * e.step || now - e.breakoutAt > 3 * D1) continue;
    LTR.set(e.sym + '|' + e.tf, e);
  }
}

/* ───────── v77.1 AI SAĞLAYICI HAVUZU ─────────
   ⚠ MODEL DÜZELTMESİ: v77.0'daki modeller Google/Groq tarafından KALDIRILDI.
   v76.0'da çalışan modeller geri yüklendi:
     Gemini: gemini-3.5-flash-lite (+ 3.6-flash)
     Groq:   openai/gpt-oss-20b (+ qwen/qwen3.8-27b)
   Anahtarlar SADECE ortamdan. 404 → sadece o model 10 dk soğur, sıradaki
   denenir. Kotası biten sağlayıcı Pacific gece yarısına kadar sessizleşir. */
const AI = {
  modules: ['PUMP', 'LT', 'DAILY'],
  maxPerDay: clamp(Number(process.env.AI_MAX_PER_DAY) || 120, 1, 400),
  maxPerHour: clamp(Number(process.env.AI_MAX_PER_HOUR) || 36, 1, 180),
  briefPerDay: clamp(Number(process.env.AI_BRIEF_PER_DAY) || 2, 0, 6),
  timeoutMs: clamp(Number(process.env.AI_TIMEOUT_MS) || 18000, 5000, 120000),
  maxTokens: clamp(Number(process.env.AI_MAX_TOKENS) || 500, 200, 2000),
  temperature: 0.30,
  cacheMs: 6 * H1,
  pumpMinScore: clamp(Number(process.env.AI_PUMP_MIN_SCORE) || 55, 40, 95),
  pumpWaitMs: clamp(Number(process.env.AI_PUMP_WAIT_MS) || 18000, 4000, 60000),
  pumpEntryDriftPct: clamp(Number(process.env.AI_PUMP_ENTRY_DRIFT_PCT) || 0.30, 0.10, 0.80),
  approvalWindowMs: 5 * M1,
  providers: [
    {
      id: 'gemini', name: 'Gemini Flash', key: process.env.GEMINI_API_KEY || '',
      base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      models: process.env.GEMINI_MODEL
        ? [process.env.GEMINI_MODEL]
        : ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'groq', name: 'Groq GPT-OSS', key: process.env.GROQ_API_KEY || '',
      base: 'https://api.groq.com/openai/v1/chat/completions',
      models: process.env.GROQ_MODEL
        ? [process.env.GROQ_MODEL]
        : ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'openrouter', name: 'OpenRouter', key: process.env.OPENROUTER_API_KEY || '',
      base: 'https://openrouter.ai/api/v1/chat/completions',
      models: process.env.OPENROUTER_MODEL
        ? [process.env.OPENROUTER_MODEL]
        : ['meta-llama/llama-3.3-70b-instruct:free'],
      headers: { 'HTTP-Referer': 'https://alphason-z8kj.onrender.com', 'X-Title': 'AlphaSon' },
      cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'github', name: 'GitHub Models', key: process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN || '',
      base: 'https://models.github.ai/inference/chat/completions',
      models: process.env.GITHUB_MODEL
        ? [process.env.GITHUB_MODEL]
        : ['openai/gpt-4o-mini', 'openai/gpt-4o'],
      headers: {}, cooldownMs: 10 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'cerebras', name: 'Cerebras', key: process.env.CEREBRAS_API_KEY || '',
      base: 'https://api.cerebras.ai/v1/chat/completions',
      models: process.env.CEREBRAS_MODEL
        ? [process.env.CEREBRAS_MODEL]
        : ['llama-3.3-70b', 'llama3.1-8b'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'sambanova', name: 'SambaNova', key: process.env.SAMBANOVA_API_KEY || '',
      base: 'https://api.sambanova.ai/v1/chat/completions',
      models: process.env.SAMBANOVA_MODEL
        ? [process.env.SAMBANOVA_MODEL]
        : ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'mistral', name: 'Mistral', key: process.env.MISTRAL_API_KEY || '',
      base: 'https://api.mistral.ai/v1/chat/completions',
      models: process.env.MISTRAL_MODEL
        ? [process.env.MISTRAL_MODEL]
        : ['mistral-small-latest'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    },
    {
      id: 'cohere', name: 'Cohere', key: process.env.COHERE_API_KEY || '',
      base: 'https://api.cohere.ai/compatibility/v1/chat/completions',
      models: process.env.COHERE_MODEL
        ? [process.env.COHERE_MODEL]
        : ['command-r-plus-08-2024', 'command-r7b-12-2024'],
      headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {}
    }
  ]
};
let aiUsage = { day: '', dayCount: 0, hourKey: 0, hourCount: 0, briefDay: '', briefCount: 0, total: 0, lastAt: 0, lastError: null, lastProvider: null };
const AI_QUEUE = [];
let aiBusy = false;
function loadAI() {
  try {
    const j = loadJSON(F_AI, null);
    if (j && typeof j === 'object') aiUsage = Object.assign(aiUsage, j);
    if (j && j.brief) marketBrief = j.brief;
  } catch (e) { /* yoksay */ }
  if (!aiUsage.day) aiUsage.day = new Date().toISOString().slice(0, 10);
}
function saveAI() { saveJSON(F_AI, { day: aiUsage.day, dayCount: aiUsage.dayCount, hourKey: aiUsage.hourKey, hourCount: aiUsage.hourCount, briefDay: aiUsage.briefDay, briefCount: aiUsage.briefCount, total: aiUsage.total, lastAt: aiUsage.lastAt, lastError: aiUsage.lastError, lastProvider: aiUsage.lastProvider, brief: marketBrief || undefined }); }
function aiKeys() { return AI.providers.filter(p => p.key); }
function aiReady() { return !!(settings.aiEnabled !== false && aiKeys().length > 0); }
function aiProviderView(p) {
  const now = Date.now();
  return {
    id: p.id, name: p.name,
    models: (p.models || []).slice(),
    hasKey: !!p.key,
    cooldownUntil: p.cooldownUntil || 0,
    cooldownSec: p.cooldownUntil && p.cooldownUntil > now ? Math.ceil((p.cooldownUntil - now) / 1000) : 0,
    modelCooldowns: p.modelCooldowns || {},
    lastError: p.lastError || null, lastAt: p.lastAt || 0,
    calls: p.calls || 0, ok: p.ok || 0, fail: p.fail || 0
  };
}
function aiQuota() {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), hk = Math.floor(now / H1);
  if (aiUsage.day !== day) { aiUsage.day = day; aiUsage.dayCount = 0; aiUsage.briefDay = day; aiUsage.briefCount = 0; }
  if (aiUsage.hourKey !== hk) { aiUsage.hourKey = hk; aiUsage.hourCount = 0; }
  return { ok: aiUsage.dayCount < AI.maxPerDay && aiUsage.hourCount < AI.maxPerHour, day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour };
}
function aiCount(provider) {
  const q = aiQuota();
  if (!q.ok) return false;
  aiUsage.dayCount++; aiUsage.hourCount++; aiUsage.total++; aiUsage.lastAt = Date.now(); aiUsage.lastProvider = provider ? provider.id : null;
  saveAI(); return true;
}
function aiStatus() {
  const q = aiQuota(), keys = aiKeys();
  return {
    version: VERSION, enabled: aiReady(), settingsEnabled: settings.aiEnabled !== false,
    keys: keys.length, modules: AI.modules.slice(),
    limits: { maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour, briefPerDay: AI.briefPerDay, pumpMinScore: AI.pumpMinScore, pumpWaitMs: AI.pumpWaitMs, approvalWindowMs: AI.approvalWindowMs },
    usage: { day: q.day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, briefCount: aiUsage.briefCount, total: aiUsage.total, lastAt: aiUsage.lastAt, lastError: aiUsage.lastError, lastProvider: aiUsage.lastProvider },
    providers: AI.providers.map(aiProviderView), brief: marketBrief,
    scope: 'AlgoPump: AI KARAR + PLAN üretir; otomatik işlem AÇILMAZ. Operatör /api/signal/:id/execute çağırınca taze fiyatla işlem açılır. LT ve Günlük Sweep AI yorumuyla manueldir. Trend yalnızca sinyal + yorum.'
  };
}

const BLK = {};
const PWHY = {};
const SWHY = {};
const TWHY = {};
const RWHY = {};
const SC = {};
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
function loadAll() {
  const s = loadJSON(F_SIG, { seq: 0, list: [] });
  signals = Array.isArray(s.list) ? s.list : [];
  sigSeq = Number(s.seq) || signals.length;
  const p = loadJSON(F_PAPER, null);
  if (p && Array.isArray(p.open) && Array.isArray(p.closed)) paper = Object.assign(paper, p);
  settings = sanitizeSettings(loadJSON(F_SET, {}));
  loadLTR();
  loadAI();
  log('Veriler yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık işlem, oto-trade ' + (settings.auto ? 'AÇIK' : 'KAPALI') + ', mod ' + settings.tradeMode.toUpperCase() + ', LT retest izleme ' + LTR.size + ', AI ' + (aiReady() ? 'HAZIR' : 'KAPALI/anahtarsız'));
}
function saveAll() {
  if (!dirty) return;
  dirty = false;
  const act = signals.filter(isOpenSignal);
  const cl = signals.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 600);
  signals = act.concat(cl).sort((a, b) => a.createdAt - b.createdAt);
  saveJSON(F_SIG, { seq: sigSeq, list: signals });
  paper.closed = paper.closed.slice(0, 300);
  saveJSON(F_PAPER, paper);
}
function saveSettings() { saveJSON(F_SET, settings); }

const priceOf = sym => (TICK[sym] && TICK[sym].last ? TICK[sym].last : null);
function quoteVolOf(t) {
  if (!t) return 0;
  const q = Number(t.quoteVolume);
  if (isFinite(q) && q > 0) return q;
  const b = Number(t.baseVolume), px = Number(t.last);
  return isFinite(b) && b > 0 && isFinite(px) && px > 0 ? b * px : 0;
}
async function refreshTickers() {
  const t = await ex.fetchTickers();
  for (const k in t) { const x = t[k]; if (x && x.last && k.endsWith('/USDT:USDT')) TICK[k] = Object.assign({}, TICK[k], x); }
  stats.tickAt = Date.now();
  const now = stats.tickAt;
  for (const sym in TICK) {
    const x = TICK[sym];
    if (!x || !(x.last > 0)) continue;
    pushSnap(sym, now, x.last, x.quoteVolume);
    ringPush(sym, now, x.last);
  }
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
  } catch (e) { /* kısmi */ }
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
  ALL = list;
  TOP = list.slice(0, 120);
  stats.excluded = skipped.length;
  log('Evren güncellendi: ' + ALL.length + ' sözleşme, en likit ' + TOP.length + ' taranıyor' + (skipped.length ? ' | tokenize dışlandı: ' + skipped.length : ''));
}

function analyzeSignal(sig) {
  const mod = sig.module, dir = sig.dir, info = sig.info || {}, conf = Number(sig.conf) || 0;
  const price = Number(sig.entry) || 0;
  const riskPct = info.riskPct != null ? Number(info.riskPct) : (price > 0 ? Math.abs(price - sig.sl) / price * 100 : 0);
  const rr = info.netRR != null ? Number(info.netRR) : (price > 0 ? rrNet(price, sig.sl, sig.tp1).net : 0);
  const counter = market.dir !== 'NOTR' && market.dir !== dir;
  const aligned = market.dir !== 'NOTR' && market.dir === dir;
  const reasons = [], risks = [];
  let score = clamp(conf, 0, 100);
  const fmt = x => (x >= 1 ? x.toFixed(4) : x.toPrecision(5));

  if (mod === 'LT') {
    if (info.retest) { score += 5; reasons.push('Kırılım sonrası çizgiye geri dönüş (retest).'); }
    else reasons.push('Üçgen kırılımı yeni kapandı.');
    if (Number(info.volRatio) >= 1.5) { score += 5; reasons.push('Hacim ' + Number(info.volRatio).toFixed(1) + 'x, kırılım teyitli.'); }
    else if (Number(info.volRatio) > 0) { score -= 4; risks.push('Hacim 1.5x altında.'); }
    if (info.d1Confirm === true) { score += 5; reasons.push('1D trend uyumlu.'); }
    else if (info.d1Confirm === false) { score -= 6; risks.push('1D trend çelişiyor.'); }
    if (rr < 1.2) { score -= 8; risks.push('Net R:R ' + rr.toFixed(2) + ' zayıf.'); }
    else reasons.push('Net R:R ' + rr.toFixed(2) + '.');
    if (counter) { score -= 8; risks.push('Piyasa yönüne ters.'); }
    else if (aligned) { score += 4; reasons.push('Piyasa yönü uyumlu.'); }
  } else if (mod === 'DAILY') {
    reasons.push('Önceki gün ' + (info.sweepSide === 'PDL' ? 'dip' : 'tepe') + ' süpürüldü, içeri kapanış.');
    if (Number(info.wickAtr) >= 0.35) { score += 4; reasons.push('Fitil ' + Number(info.wickAtr).toFixed(2) + ' ATR.'); }
    if (Number(info.volRatio) >= 1.5) { score += 5; reasons.push('Hacim ' + Number(info.volRatio).toFixed(1) + 'x.'); }
    else if (Number(info.volRatio) > 0) { score -= 4; risks.push('Hacim zayıf.'); }
    if (Number(info.bodyRatio) >= 0.45) { score += 4; reasons.push('Gövde güçlü.'); }
    if (Number(info.closePos) >= 0.65) { score += 3; reasons.push('Kapanış yönlü.'); }
    if (Number(info.sweptBefore) > 0) { score -= 8; risks.push('Aynı seviye daha önce süpürülmüş.'); }
    if (rr < 1.2) { score -= 8; risks.push('Net R:R ' + rr.toFixed(2) + ' zayıf.'); }
    else reasons.push('Net R:R ' + rr.toFixed(2) + '.');
    if (counter) { score -= 6; risks.push('Piyasa yönüne ters.'); }
    else if (aligned) { score += 4; reasons.push('Piyasa uyumlu.'); }
  } else if (mod === 'PUMP') {
    reasons.push('Coil kırılımı + hacim patlaması.');
    if (Number(info.netRR) >= 1.4) { score += 5; reasons.push('Net R:R ' + Number(info.netRR).toFixed(2) + ' makul.'); }
    if (Number(info.spreadPct) <= 0.10) reasons.push('Spread ' + Number(info.spreadPct).toFixed(3) + '%.');
    else if (Number(info.spreadPct) > 0.15) { score -= 8; risks.push('Spread geniş.'); }
    if (Number(info.oi1) < -0.5) { score -= 8; risks.push('OI düşüyor; hareket zayıf.'); }
    if (info.quickTpPct != null) reasons.push('Vur-kaç TP ' + Number(info.quickTpPct).toFixed(2) + '% / ' + (info.quickTimeSec || EX.QUICK_TIME) + ' sn.');
    risks.push('AlgoPump işlemleri AI KARAR + operatör onayına bağlı.');
  } else {
    reasons.push('Modül bazlı kural seti.');
  }

  if (counter && mod !== 'PUMP') risks.push('Piyasa yönü ' + market.dir + '; ters riski.');
  if (market.dir === 'NOTR') reasons.push('Piyasa nötr.');
  if (riskPct > 2.5) risks.push('Risk %' + riskPct.toFixed(2) + '; küçült.');
  if (sig.conf < 65) risks.push('Güven ' + sig.conf + ' (eşik üstü ama güçlü değil).');

  score = Math.round(clamp(score, 0, 100));
  const verdict = score >= 75 ? 'ONY' : score >= 55 ? 'TEMKINLI' : 'RED';
  const verdictLabel = verdict === 'ONY' ? 'GİRİLİR' : verdict === 'TEMKINLI' ? 'BEKLE' : 'GİRİLMEZ';
  const riskLevel = riskPct > 1.8 ? 'YÜKSEK' : riskPct > 1.0 ? 'ORTA' : 'DÜŞÜK';
  const marketView = market.dir === 'NOTR'
    ? 'Piyasa yönü nötr (skor ' + Number(market.score || 0.5).toFixed(2) + ').'
    : 'Piyasa ' + market.dir + ' (skor ' + Number(market.score || 0.5).toFixed(2) + '). ' + (counter ? 'Sinyal ters yönde.' : 'Sinyal uyumlu.');
  const summary = MODS[mod].label + ' ' + dir + ' · ' + fmt(price) + ' giriş, ' + fmt(sig.sl) + ' stop, ' + fmt(sig.tp1) + ' TP1. ' +
    'Güven ' + sig.conf + '/100, net R:R ' + (isFinite(rr) ? rr.toFixed(2) : '-') + ', risk %' + riskPct.toFixed(2) + '.';
  const simpleSummary = 'Sinyal ' + fmt(price) + ' giriş, stop ' + fmt(sig.sl) + '. Bu sinyale güven: ' + (sig.conf >= 75 ? 'YÜKSEK' : sig.conf >= 60 ? 'ORTA' : 'DÜŞÜK') + '.';
  const suggested = mod === 'LT'
    ? 'TradingView\'de üçgen çizgilerini ve retest mumunu doğrula. TP1\'de yarısını kapat, kalanı TP2\'ye bırak.'
    : mod === 'DAILY'
      ? 'Süpürme seviyesini ve geri alım mumunu doğrula. TP1\'de yarısını kapat; seans sonuna kadar takip et.'
      : 'Onaylarsan işlem operatör tarafından açılır. AI planı: ' + (sig.aiGate && sig.aiGate.plan ? 'TP %' + sig.aiGate.plan.takeProfitPct + ', SL %' + sig.aiGate.plan.stopPct + ', süre ' + sig.aiGate.plan.maxHoldSec + ' sn' : '—');
  const invalidation = 'Fiyat ' + fmt(sig.sl) + ' seviyesinin ' + (dir === 'LONG' ? 'altına' : 'üstüne') + ' kapanırsa sinyal geçersiz.';
  const timeHorizon = mod === 'LT' ? '2–10 gün' : mod === 'DAILY' ? '1–6 saat' : '20–120 sn';
  return { source: 'kural', verdict, verdictLabel, score, riskLevel, marketView, summary, simpleSummary, reasons: reasons.slice(0, 8), risks: risks.slice(0, 6), suggested, invalidation, timeHorizon, at: Date.now() };
}

function analyzeMarket() {
  const m = market || {}, r = radar || {};
  const score = Math.round(clamp((m.score != null ? m.score : 0.5) * 100, 0, 100));
  const verdict = score >= 60 ? 'ONY' : score >= 45 ? 'TEMKINLI' : 'RED';
  const verdictLabel = verdict === 'ONY' ? 'GİRİLİR' : verdict === 'TEMKINLI' ? 'BEKLE' : 'GİRİLMEZ';
  const drivers = [];
  if (m.btc) drivers.push('BTC ' + fmtP(m.btc.price) + ' (' + (m.btc.change >= 0 ? '+' : '') + Number(m.btc.change || 0).toFixed(2) + '%)');
  if (m.eth) drivers.push('ETH ' + fmtP(m.eth.price) + ' (' + (m.eth.change >= 0 ? '+' : '') + Number(m.eth.change || 0).toFixed(2) + '%)');
  if (m.breadth != null) drivers.push('EMA üstü genişlik %' + Math.round(m.breadth * 100));
  if (r.fng) drivers.push('Korku/Hırs ' + r.fng.value + ' (' + r.fng.label + ')');
  if (r.rsi && r.rsi.avg1h != null) drivers.push('RSI 1h ' + r.rsi.avg1h);
  if (r.ls) drivers.push('Long/Short %' + r.ls.long + '/' + r.ls.short);
  const risks = [];
  if (score < 45) risks.push('Piyasa zayıf; LONG sinyalleri hızlı bozulabilir.');
  else if (score > 60) risks.push('Piyasa güçlü; SHORT sinyalleri riskli.');
  else risks.push('Yön belirsiz; stop disiplini şart.');
  if (r.fng && r.fng.value >= 75) risks.push('Aşırı hırs; düzeltme riski.');
  if (r.fng && r.fng.value <= 25) risks.push('Aşırı korku; dip teyidi olmadan alım riskli.');
  const summary = 'Piyasa skoru ' + score + '/100, yön ' + (m.dir || 'NOTR') + '.';
  return { source: 'kural', verdict, verdictLabel, score, summary, drivers: drivers.slice(0, 6), risks: risks.slice(0, 4), plan: verdict === 'ONY' ? 'Trend yönünde sinyallere öncelik ver.' : verdict === 'RED' ? 'Yeni risk alımını azalt.' : 'Sinyal bazlı ilerle.', invalidation: 'Piyasa skoru 45 altına inerse LONG iştahı; 60 üstüne çıkarsa SHORT iştahı azalır.', at: Date.now() };
}

function blocked(mod, sym, reason, silent) {
  BLK[reason] = (BLK[reason] || 0) + 1;
  if (silent) return false;
  const k = mod + '|' + reason, t = Date.now();
  if (!blockLog[k] || t - blockLog[k] > 120000) { blockLog[k] = t; log('ENGEL: ' + MODS[mod].label + ' ' + baseOf(sym) + ' → ' + reason); }
  return false;
}
function isOpenSignal(s) { return !!s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR' || s.status === 'ONAY_BEKLIYOR'); }
function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = baseOf(sym);
  if (M.maxPerDaySym) {
    const dayStart = Math.floor(t / D1) * D1;
    const cnt = signals.filter(s => s.module === mod && s.symbol === sym && s.createdAt >= dayStart).length;
    if (cnt >= M.maxPerDaySym) { BLK['günlük limit'] = (BLK['günlük limit'] || 0) + 1; return false; }
  }
  if (raw.retest) {
    const actLT = signals.filter(s => s.module === mod && s.symbol === sym && isOpenSignal(s));
    if (actLT.some(s => s.dir !== dir)) return false;
    if (actLT.some(s => s.info && s.info.retest)) return false;
  } else if (signals.some(s => s.module === mod && s.symbol === sym && (isOpenSignal(s) || (s.dir === dir && t - (s.closedAt || s.createdAt) < M.cooldown)))) return false;
  const act = signals.filter(isOpenSignal);
  const sec = sectorOf(base);
  const counter = market.dir !== 'NOTR' && dir !== market.dir;
  const align = market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU');
  if (counter && (mod === 'PUMP' || mod === 'TREND' || mod === 'SCALPER')) { BLK['piyasa ters'] = (BLK['piyasa ters'] || 0) + 1; return false; }
  const same = act.filter(s => s.symbol === sym && s.dir === dir && s.module !== mod);
  const bonus = Math.min(25, same.length * 12);
  const base0 = raw.conf - (counter && mod !== 'PUMP' ? 6 : 0);
  const oi1 = oiChg(sym, 60000), oi5 = oiChg(sym, 5 * M1);
  const pumpGate = mod === 'PUMP' ? { state: 'PENDING', queuedAt: t, expiresAt: t + AI.pumpWaitMs, minScore: AI.pumpMinScore } : null;
  const sig = {
    id: 'S' + (++sigSeq), module: mod, symbol: sym, base, sector: sec, dir,
    entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single, tp1Hit: false,
    baseConf: base0, confBonus: bonus, conf: clamp(Math.round(base0 + bonus), 30, 99), counter, marketAlign: align,
    confl: same.map(s => s.module), info: Object.assign({}, raw.info || {}, { oi1: oi1 != null ? +oi1.toFixed(2) : null, oi5: oi5 != null ? +oi5.toFixed(2) : null }), status: pumpGate ? 'AI_BEKLIYOR' : 'AKTIF', result: null, aiGate: pumpGate,
    createdAt: t, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0,
    holdSec: raw.holdSec != null ? raw.holdSec : undefined, noMoveSec: raw.noMoveSec != null ? raw.noMoveSec : undefined,
    quickTpPct: raw.quickTpPct != null ? raw.quickTpPct : undefined,
    quickTimeSec: raw.quickTimeSec != null ? raw.quickTimeSec : undefined,
    quickArmPct: raw.quickArmPct != null ? raw.quickArmPct : undefined,
    retest: !!raw.retest,
    atrPct: raw.atrPct, velSeries: [], peakPct: null
  };
  same.forEach(s => {
    if (!s.confl.includes(mod)) {
      s.confl.push(mod);
      s.confBonus = Math.min(25, (s.confBonus || 0) + 12);
      s.conf = clamp(Math.round(s.baseConf + s.confBonus), 30, 99);
      s.analysis = analyzeSignal(s);
    }
  });
  sig.analysis = analyzeSignal(sig);
  signals.push(sig);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + base + ' | ' + dir + ' | güven ' + sig.conf + ' | piyasa ' + align + (same.length ? ' | konfluans x' + (same.length + 1) : '') + (raw.info && raw.info.tf ? ' | ' + raw.info.tf : '') + ' | analiz ' + sig.analysis.verdictLabel + ' ' + sig.analysis.score + (pumpGate ? ' | AI ONAY BEKLİYOR' : ''));
  if (mod === 'PUMP') {
    stats.pumpFound++;
    if (aiReady()) queueAI(sig);
    else {
      sig.aiGate = Object.assign({}, sig.aiGate, { state: 'OFFLINE', note: (settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok'), decidedAt: Date.now() });
      sig.status = 'ONAY_BEKLIYOR';
      sig.approvalExpiresAt = Date.now() + AI.approvalWindowMs;
      dirty = true;
      log('ALGOPUMP (AI ÇEVRİMDIŞI): ' + base + ' ' + dir + ' | ONAY BEKLİYOR');
    }
  } else if (AI.modules.includes(mod)) queueAI(sig);
  return true;
}
function emit(mod, sym, det, last, tfMs, maxLag) {
  sc(mod, 'aday');
  if (Date.now() - (last.t + tfMs) > maxLag) { sc(mod, 'mum eski'); return false; }
  const px = priceOf(sym), atr = det.info && det.info.atr;
  if (px && atr && Math.abs(px - det.entry) > 0.30 * atr) { sc(mod, 'fiyat uzaklaştı'); return false; }
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
  log('SİNYAL KAPANDI: ' + MODS[s.module].label + ' ' + s.base + ' ' + s.dir + ' → ' + (REASON[reason] || reason) + ' (net ' + (s.netR >= 0 ? '+' : '') + s.netR + 'R)');
}

/* ───────── v77.1 AI İSTEMCİSİ ───────── */
function redact(s) {
  let x = String(s == null ? '' : s);
  for (const p of AI.providers) if (p.key) x = x.split(p.key).join('[KEY]');
  return x.slice(0, 500);
}

function parseAIJSON(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  const arr = x => {
    if (Array.isArray(x)) return x.map(v => String(v)).filter(Boolean).slice(0, 6);
    if (typeof x === 'string' && x.trim()) return x.split(/[\n;\u2022]/).map(v => v.trim()).filter(Boolean).slice(0, 6);
    return [];
  };
  if (!j || typeof j !== 'object') {
    return {
      verdict: 'TEMKINLI', score: 50, trust: 'ORTA', riskLevel: 'ORTA',
      entryDecision: 'REJECT', exitStyle: 'FAST', marketView: '',
      summary: raw.slice(0, 500) || 'AI yanıtı anlaşılamadı.',
      reasons: [], risks: ['AI yanıtı JSON biçiminde değil.'], suggested: '', invalidation: '', timeHorizon: '', reason: '',
      parseError: true
    };
  }
  let v = String(j.verdict || '').toUpperCase();
  v = v.replace(/İ/g, 'I').replace(/\s+/g, '_');
  let verdict;
  if (['GIRILIR', 'GİRİLİR', 'AL', 'BUY', 'LONG', 'APPROVE', 'ONY', 'ONAY', 'UYGUN', 'GIREBILIR'].includes(v)) verdict = 'ONY';
  else if (['GIRILMEZ', 'GİRİLMEZ', 'RED', 'REJECT', 'SAT', 'SHORT', 'RET', 'UYGUN_DEGIL', 'GIREMEZ'].includes(v)) verdict = 'RED';
  else verdict = 'TEMKINLI';

  let tr = String(j.trust || j.confidence || '').toUpperCase().replace(/İ/g, 'I');
  if (['YUKSEK', 'YÜKSEK', 'HIGH'].includes(tr)) tr = 'YÜKSEK';
  else if (['DUSUK', 'DÜŞÜK', 'LOW'].includes(tr)) tr = 'DÜŞÜK';
  else tr = 'ORTA';

  let score = Number(j.score);
  if (!isFinite(score)) score = tr === 'YÜKSEK' ? 80 : tr === 'ORTA' ? 60 : 40;
  score = clamp(Math.round(score), 0, 100);

  let riskLevel = String(j.riskLevel || '').toUpperCase().replace(/İ/g, 'I');
  if (!['DÜŞÜK', 'ORTA', 'YÜKSEK'].includes(riskLevel)) riskLevel = tr === 'DÜŞÜK' ? 'DÜŞÜK' : tr === 'YÜKSEK' ? 'ORTA' : 'ORTA';

  const decisionRaw = String(j.entryDecision || j.entry_decision || j.decision || '').toUpperCase().replace(/İ/g, 'I').replace(/\s+/g, '_');
  const DMAP = { APPROVE: 'APPROVE', ONAY: 'APPROVE', AL: 'APPROVE', GIREBILIR: 'APPROVE', GIRILIR: 'APPROVE', GİRİLİR: 'APPROVE', REJECT: 'REJECT', RED: 'REJECT', GIRILMEZ: 'REJECT', GİRİLMEZ: 'REJECT' };
  let entryDecision = DMAP[decisionRaw];
  if (!entryDecision) entryDecision = verdict === 'ONY' ? 'APPROVE' : 'REJECT';

  const styleRaw = String(j.exitStyle || '').toUpperCase();
  const exitStyle = ['FAST', 'BALANCED', 'TRAIL'].includes(styleRaw) ? styleRaw : 'FAST';
  const numOrNull = v => { const n = Number(v); return isFinite(n) ? n : null; };

  return {
    verdict, score, trust: tr, riskLevel, entryDecision, exitStyle,
    stopLossPct: numOrNull(j.stopLossPct || j.stop_loss_pct),
    takeProfitPct: numOrNull(j.takeProfitPct || j.take_profit_pct),
    maxHoldSec: numOrNull(j.maxHoldSec || j.max_hold_sec),
    noMoveSec: numOrNull(j.noMoveSec || j.no_move_sec),
    quickArmPct: numOrNull(j.quickArmPct || j.quick_arm_pct),
    marketView: String(j.marketView || j.market_view || '').slice(0, 400),
    summary: String(j.summary || j.özet || j.reason || '').slice(0, 600),
    reason: String(j.reason || j.neden || '').slice(0, 300),
    reasons: arr(j.reasons || j.gerekçeler || j.reason),
    risks: arr(j.risks || j.riskler),
    suggested: String(j.suggested || j.öneri || j.plan || '').slice(0, 500),
    invalidation: String(j.invalidation || j.geçersizlik || '').slice(0, 400),
    timeHorizon: String(j.timeHorizon || j.vade || '').slice(0, 100)
  };
}

function isModelError(e) {
  const s = String(e && e.message || '').toLowerCase();
  return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer available|no longer supported/.test(s);
}
function isQuotaExhausted(e) {
  const s = String(e && e.message || '').toLowerCase();
  return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|credit balance|exceeded.*quota|resource_exhausted|rate limit exceeded for model/.test(s);
}
function isTransientAIError(e) {
  const status = Number(e && e.status) || 0;
  return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e);
}
function untilNextPacificMidnight(now) {
  try {
    const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const next = new Date(local); next.setDate(next.getDate() + 1); next.setHours(0, 0, 10, 0);
    return Math.max(M1, next.getTime() - local.getTime());
  } catch (e) { return 12 * H1; }
}
function providerFail(p, e) {
  const status = Number(e && e.status) || 0;
  p.fail = (p.fail || 0) + 1;
  p.lastError = redact(e && e.message || 'bilinmeyen hata');
  p.lastAt = Date.now();
  let ms;
  if (e && e.retryAfterMs) ms = e.retryAfterMs;
  else if (isQuotaExhausted(e)) ms = untilNextPacificMidnight(Date.now());
  else if (status === 429) ms = 2 * M1;
  else if (status === 401 || status === 403) ms = 60 * M1;
  else if (status >= 500) ms = 2 * M1;
  else if (isModelError(e) || (e && e.allModelsCooldown)) ms = 10 * M1;   // v77.1: 30→10 dk
  else ms = M1;
  p.cooldownUntil = Date.now() + ms;
  aiUsage.lastError = p.name + ': ' + p.lastError; aiUsage.lastAt = Date.now();
  saveAI();
  log('AI HATA: ' + p.name + ' → ' + p.lastError + ' | ' + Math.ceil(ms / 1000) + ' sn bekleme' +
    (isModelError(e) || (e && e.allModelsCooldown) ? ' | /api/ai/reset ile sıfırlanabilir' : ''));
}
async function callProviderModel(p, messages, model) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI.timeoutMs);
  const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, p.headers || {});
  try {
    const res = await fetch(p.base, {
      method: 'POST', headers, signal: ctl.signal,
      body: JSON.stringify({ model, messages, temperature: AI.temperature, max_tokens: AI.maxTokens, stream: false })
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) {
      const msg = (j && (j.error && (j.error.message || j.error.code) || j.message)) || txt.slice(0, 300) || ('HTTP ' + res.status);
      const er = new Error(redact(msg)); er.status = res.status;
      const ra = res.headers.get('retry-after');
      if (ra) { const n = Number(ra); er.retryAfterMs = isFinite(n) ? n * 1000 : Math.max(60000, (Date.parse(ra) || Date.now() + 300000) - Date.now()); }
      throw er;
    }
    if (!j) throw new Error('geçersiz JSON yanıtı');
    let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
    if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
    if (!c && j.candidates && j.candidates[0] && j.candidates[0].content) c = j.candidates[0].content.parts.map(x => x.text || '').join('\n');
    if (!c || !String(c).trim()) throw new Error('boş yanıt');
    return { text: String(c), model: (j.model || model) };
  } catch (e) {
    if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı (' + Math.round(AI.timeoutMs / 1000) + ' sn)'); er.status = 0; throw er; }
    throw e;
  } finally { clearTimeout(timer); }
}
async function callProvider(p, messages) {
  const now = Date.now();
  const usable = (p.models || []).filter(m => {
    const cd = (p.modelCooldowns && p.modelCooldowns[m]) || 0;
    return cd < now;
  });
  if (!usable.length) {
    const nextFree = p.models && p.models.length
      ? Math.min(...p.models.map(m => (p.modelCooldowns && p.modelCooldowns[m]) || 0))
      : now;
    const waitSec = Math.ceil(Math.max(0, nextFree - now) / 1000);
    throw Object.assign(
      new Error('tüm modeller soğumada (en erken ' + waitSec + ' sn) — /api/ai/reset çağırın'),
      { status: 404, allModelsCooldown: true }
    );
  }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await callProviderModel(p, messages, model);
        return r;
      } catch (e) {
        lastErr = e;
        if (isModelError(e)) {
          p.modelCooldowns = p.modelCooldowns || {};
          p.modelCooldowns[model] = Date.now() + (p.modelCooldownMs || 10 * M1);
          log('AI MODEL YOK: ' + p.name + '/' + model + ' → ' + redact(e.message).slice(0, 100) + ' | model soğutuldu');
          break;
        }
        if (isQuotaExhausted(e)) throw e;
        if (!isTransientAIError(e) || attempt === 1) throw e;
        const backoff = Math.min(5000, 600 * Math.pow(2, attempt) + Math.round(Math.random() * 350));
        await sleep(backoff);
      }
    }
  }
  throw lastErr || new Error('sağlayıcı yanıt vermedi');
}

async function buildAIContext(sig) {
  const tf = sig.module === 'PUMP' ? '1m' : sig.module === 'LT' ? (sig.info && sig.info.tf === '2h' ? '2h' : '4h') : '15m';
  const fetchTf = tf === '2h' ? '1h' : tf;
  const limit = tf === '15m' ? 60 : tf === '1m' ? 40 : 50;
  const raw = await getC(sig.symbol, fetchTf, limit, 2 * M1);
  let cs = raw ? closed(raw, TF_MS[fetchTf] || M15) : [];
  if (tf === '2h') cs = aggTF(cs, 120);
  if (cs.length > 25) cs = cs.slice(-25);
  return cs.map(c => {
    const t = new Date(c.t).toISOString().replace('T', ' ').slice(0, 16);
    const p = c.c >= 1 ? 4 : 6;
    return `${t} O${c.o.toFixed(p)} H${c.h.toFixed(p)} L${c.l.toFixed(p)} C${c.c.toFixed(p)}`;
  }).join('\n');
}

function declinePumpAI(sig, reason, note) {
  if (!sig || sig.module !== 'PUMP' || sig.status !== 'AI_BEKLIYOR') return false;
  sig.status = 'KAPALI'; sig.result = reason; sig.closedAt = Date.now();
  sig.exit = null; sig.netR = null; sig.grossR = null; sig.pnlPct = null;
  sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'REJECTED', reason, note: note || '', decidedAt: Date.now() });
  dirty = true;
  log('ALGOPUMP AI RED: ' + sig.base + ' ' + sig.dir + ' → ' + (note || REASON[reason] || reason));
  return true;
}

function finalizePumpAIApproval(sig, ai) {
  if (!sig || sig.module !== 'PUMP' || !sig.aiGate || sig.aiGate.state !== 'PENDING') return ai;
  const now = Date.now();
  if (now >= sig.aiGate.expiresAt) { declinePumpAI(sig, 'AI_TIMEOUT', 'AI onayı giriş penceresine yetişmedi'); return null; }
  if (!ai || ai.error) {
    sig.aiGate = Object.assign({}, sig.aiGate, {
      state: 'OFFLINE',
      note: (ai && ai.error) || 'AI yanıtı alınamadı — manuel inceleme',
      decidedAt: now
    });
    sig.status = 'ONAY_BEKLIYOR';
    sig.approvalExpiresAt = now + AI.approvalWindowMs;
    dirty = true;
    log('ALGOPUMP AI ÇEVRİMDIŞI: ' + sig.base + ' ' + sig.dir + ' | ONAY BEKLİYOR');
    return null;
  }
  const approved = (ai.verdict === 'ONY') && (ai.entryDecision === 'APPROVE') && Number(ai.score) >= AI.pumpMinScore && ai.riskLevel !== 'YÜKSEK';
  if (!approved) {
    declinePumpAI(sig, 'AI_RED', 'AI: ' + (ai.verdict || 'TEMKINLI') + ' ' + (ai.score != null ? ai.score + '/100' : '') + ' — giriş onayı yok');
    return null;
  }
  const i = sig.info || {}, d = sig.dir === 'LONG' ? 1 : -1;
  const hardStop = Math.max(EX.MIN_SL_PCT, PUMP.vel.slCostK * EX.H, Number(i.slFloor) || 0);
  const stopPct = clamp(Number(ai.stopLossPct) > 0 ? Number(ai.stopLossPct) : (Number(i.slPct) || hardStop), hardStop, PUMP.vel.slMax);
  const minTp = Math.max(EX.QUICK_TP_MIN, EX.H + 0.10);
  const takeProfitPct = clamp(Number(ai.takeProfitPct) > 0 ? Number(ai.takeProfitPct) : (Number(i.quickTpPct) || minTp), minTp, Math.min(EX.TP_MAX, 1.20));
  const maxHoldSec = Math.round(clamp(Number(ai.maxHoldSec) > 0 ? Number(ai.maxHoldSec) : EX.HOLD, 20, EX.HOLD));
  const noMoveSec = Math.round(clamp(Number(ai.noMoveSec) > 0 ? Number(ai.noMoveSec) : Math.min(EX.NO_MOVE, maxHoldSec - 5), 10, Math.max(10, maxHoldSec - 5)));
  const quickArmPct = +clamp(Number(ai.quickArmPct) > 0 ? Number(ai.quickArmPct) : Math.min(EX.QUICK_ARM, takeProfitPct - 0.05), 0.08, Math.max(0.08, takeProfitPct - 0.05)).toFixed(2);
  const netRR = (takeProfitPct - EX.H) / (stopPct + EX.H);
  if (netRR < 0.20) { declinePumpAI(sig, 'AI_RED', 'AI planının net R:R değeri yetersiz'); return null; }

  sig.sl = rp(sig.entry * (1 - d * stopPct / 100));
  sig.curSl = sig.sl;
  sig.tp1 = rp(sig.entry * (1 + d * takeProfitPct / 100));
  sig.quickTpPct = +takeProfitPct.toFixed(2);
  sig.quickTimeSec = maxHoldSec;
  sig.quickArmPct = quickArmPct;
  sig.holdSec = maxHoldSec;
  sig.noMoveSec = noMoveSec;
  sig.maxAgeMs = (maxHoldSec + 300) * 1000;
  sig.info = Object.assign({}, i, {
    aiStopPct: +stopPct.toFixed(2), aiTakeProfitPct: +takeProfitPct.toFixed(2),
    aiMaxHoldSec: maxHoldSec, aiNoMoveSec: noMoveSec, aiQuickArmPct: quickArmPct,
    aiExitStyle: ai.exitStyle, aiNetRR: +netRR.toFixed(2)
  });
  sig.aiGate = Object.assign({}, sig.aiGate, {
    state: 'APPROVED', decidedAt: now, score: ai.score, trust: ai.trust || 'ORTA',
    reason: ai.reason || ai.summary || '', provider: ai.provider,
    plan: { stopPct: +stopPct.toFixed(2), takeProfitPct: +takeProfitPct.toFixed(2), maxHoldSec, noMoveSec, quickArmPct, exitStyle: ai.exitStyle }
  });
  sig.status = 'ONAY_BEKLIYOR';
  sig.approvalExpiresAt = now + AI.approvalWindowMs;
  dirty = true;
  log('ALGOPUMP AI ONAY: ' + sig.base + ' ' + sig.dir + ' | ' + (ai.trust || 'ORTA') + ' güven | TP %' + takeProfitPct.toFixed(2) + ' | SL %' + stopPct.toFixed(2) + ' | süre ' + maxHoldSec + ' sn | ONAY BEKLİYOR (' + Math.round(AI.approvalWindowMs / 60000) + ' dk)');
  return ai;
}

async function aiReview(sig, opts) {
  opts = opts || {};
  if (!sig || !AI.modules.includes(sig.module)) return null;
  if (!opts.force && sig.ai && !sig.ai.error && Date.now() - (sig.ai.at || 0) < AI.cacheMs) return sig.ai;
  if (!aiReady()) {
    if (!sig.ai) { sig.ai = { error: settings.aiEnabled === false ? 'AI kapalı' : 'AI anahtarı yok', at: Date.now() }; dirty = true; }
    return finalizePumpAIApproval(sig, sig.ai);
  }
  const q = aiQuota();
  if (!q.ok) {
    sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI kotası doldu (' + aiUsage.dayCount + '/' + AI.maxPerDay + ' gün, ' + aiUsage.hourCount + '/' + AI.maxPerHour + ' saat)', at: Date.now() });
    dirty = true; saveAI(); return finalizePumpAIApproval(sig, sig.ai);
  }
  let ctx;
  try { ctx = await buildAIContext(sig); }
  catch (e) { sig.ai = Object.assign({}, sig.ai || {}, { error: 'Veri alınamadı: ' + redact(e.message), at: Date.now() }); dirty = true; return finalizePumpAIApproval(sig, sig.ai); }

  const sys = 'Sen AlphaSon adlı kripto sinyal asistanısın. Verilen sinyali inceleyip BASİT, ANLAŞILIR Türkçe ile "GİRİLİR", "GİRİLMEZ" veya "BEKLE" kararı ver. Karmaşık teknik terim KULLANMA. Trader\'a güveni "YÜKSEK", "ORTA" veya "DÜŞÜK" olarak söyle. Yalnızca JSON döndür. Veride olmayan sayı uydurma.';

  let user;
  if (sig.module === 'PUMP') {
    user = `AlgoPump sinyali: ${sig.base} ${sig.dir}
Fiyat: ${sig.entry}, Stop: ${sig.sl}, Hedef: ${sig.tp1}
Güven skoru: ${sig.conf}/100
Piyasa yönü: ${market.dir} (skor ${Number(market.score || 0.5).toFixed(2)})
ATR%: ${sig.info.atrPct || '?'}, SL%: ${sig.info.slPct || '?'}, TP%: ${sig.info.tpPct || '?'}, Spread%: ${sig.info.spreadPct || '?'}, OI1m: ${sig.info.oi1 != null ? sig.info.oi1 : '?'}

Son mumlar (kısa):
${ctx}

JSON şeması (başka anahtar KULLANMA):
{"verdict":"GİRİLİR|GİRİLMEZ|BEKLE","trust":"YÜKSEK|ORTA|DÜŞÜK","reason":"tek cümle basit neden","summary":"kısa özet","stopLossPct":0.00,"takeProfitPct":0.00,"maxHoldSec":0,"noMoveSec":0,"quickArmPct":0.00,"exitStyle":"FAST|BALANCED|TRAIL","risks":["basit risk"]}

Kurallar: stopLossPct %0.50-%1.30, takeProfitPct %0.30-%1.20, maxHoldSec 20-120, noMoveSec 10-50 (maxHoldSec'ten küçük). APPROVE kararı için GİRİLİR + YÜKSEK/ORTA güven gerekir. Sadece JSON döndür.`;
  } else if (sig.module === 'LT') {
    user = `LT Üçgen sinyali: ${sig.base} ${sig.dir}
Fiyat: ${sig.entry}, Stop: ${sig.sl}, Hedef: ${sig.tp1}
Piyasa yönü: ${market.dir}
Not: ${sig.retest ? 'Kırılım sonrası retest' : 'Yeni kırılım'}

Son mumlar:
${ctx}

JSON şeması (başka anahtar KULLANMA):
{"verdict":"GİRİLİR|GİRİLMEZ|BEKLE","trust":"YÜKSEK|ORTA|DÜŞÜK","reason":"tek cümle basit neden","summary":"kısa özet","risks":["basit risk"]}

Sadece JSON döndür.`;
  } else {
    user = `Günlük Sweep sinyali: ${sig.base} ${sig.dir}
Fiyat: ${sig.entry}, Stop: ${sig.sl}, Hedef: ${sig.tp1}
Piyasa yönü: ${market.dir}

Son mumlar:
${ctx}

JSON şeması:
{"verdict":"GİRİLİR|GİRİLMEZ|BEKLE","trust":"YÜKSEK|ORTA|DÜŞÜK","reason":"tek cümle basit neden","summary":"kısa özet","risks":["basit risk"]}

Sadece JSON döndür.`;
  }

  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  let lastErr = null;
  for (const p of AI.providers) {
    if (!p.key) continue;
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
    if (!aiQuota().ok) break;
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, messages);
      const parsed = parseAIJSON(r.text);
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
      sig.ai = Object.assign(parsed, {
        provider: p.id, providerName: p.name, model: r.model || 'unknown',
        latencyMs: Date.now() - t0, at: Date.now(), source: 'ai'
      });
      aiUsage.lastError = null; dirty = true; saveAI();
      log('AI: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + sig.ai.verdict + ' (' + (sig.ai.trust || 'ORTA') + ' güven, ' + p.name + '/' + (r.model || '?') + ', ' + sig.ai.latencyMs + 'ms)');
      return finalizePumpAIApproval(sig, sig.ai);
    } catch (e) {
      lastErr = e; providerFail(p, e);
    }
  }
  sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI sağlayıcıları yanıt vermedi' + (lastErr ? ': ' + redact(lastErr.message) : ''), at: Date.now() });
  aiUsage.lastError = redact(lastErr && lastErr.message || 'sağlayıcı yok'); aiUsage.lastAt = Date.now();
  dirty = true; saveAI();
  return finalizePumpAIApproval(sig, sig.ai);
}

function queueAI(sig, opts) {
  if (!sig || !AI.modules.includes(sig.module) || !aiReady()) return;
  if (AI_QUEUE.some(x => x.id === sig.id)) return;
  AI_QUEUE.push({ id: sig.id, force: !!(opts && opts.force), at: Date.now() });
  if (AI_QUEUE.length > 40) AI_QUEUE.splice(0, AI_QUEUE.length - 40);
  runAIQueue();
}
async function runAIQueue() {
  if (aiBusy) return;
  aiBusy = true;
  try {
    while (AI_QUEUE.length) {
      const job = AI_QUEUE.shift(), sig = signals.find(s => s.id === job.id);
      if (!sig) continue;
      try { await aiReview(sig, { force: job.force }); }
      catch (e) { log('AI KUYRUK HATA: ' + redact(e.message)); }
    }
  } finally { aiBusy = false; }
}

async function buildMarketContext() {
  const pairs = [['BTC/USDT:USDT', 'BTC'], ['ETH/USDT:USDT', 'ETH']];
  const candles = {};
  for (const [sym, name] of pairs) {
    const a = await getC(sym, '1h', 80), b = await getC(sym, '4h', 80);
    const c1 = a ? closed(a, H1).slice(-30) : [], c4 = b ? closed(b, H4).slice(-20) : [];
    candles[name] = { h1: c1.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n'), h4: c4.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n') };
  }
  const movers = TOP.slice(0, 50).map(sym => ({ base: baseOf(sym), chg: TICK[sym] ? TICK[sym].percentage : null, qv: TICK[sym] ? TICK[sym].quoteVolume : null })).filter(x => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8);
  return JSON.stringify({ market, radar: { fng: radar.fng, rsi: radar.rsi, ls: radar.ls }, baseline: analyzeMarket(), movers, btc: candles.BTC, eth: candles.ETH }, null, 1);
}
async function aiMarketBrief(force) {
  if (!aiReady() || AI.briefPerDay <= 0) return null;
  const q = aiQuota();
  if (!q.ok) return null;
  if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 0; }
  if (aiUsage.briefCount >= AI.briefPerDay && !force) return marketBrief;
  if (aiUsage.briefCount >= AI.briefPerDay) return marketBrief;
  let ctx;
  try { ctx = await buildMarketContext(); }
  catch (e) { aiUsage.lastError = 'Brifing verisi: ' + redact(e.message); saveAI(); return null; }
  const sys = 'Sen AlphaSon adlı kripto piyasa asistanısın. Piyasa brifingi üret. KISA ve BASİT Türkçe. Yalnızca JSON döndür.';
  const user = ctx + '\n\nJSON şeması: {"verdict":"GİRİLİR|GİRİLMEZ|BEKLE","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0-100,"summary":"2-3 cümle basit","drivers":["itici"],"risks":["risk"],"plan":"2-4 saatlik basit plan","invalidation":"geçersizlik"}. Sadece JSON.';
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
  let lastErr = null;
  for (const p of AI.providers) {
    if (!p.key || (p.cooldownUntil && p.cooldownUntil > Date.now())) continue;
    if (!aiQuota().ok) break;
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, messages), parsed = parseAIJSON(r.text);
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
      aiUsage.briefCount++; if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 1; }
      marketBrief = Object.assign(parsed, { provider: p.id, providerName: p.name, model: r.model || '?', latencyMs: Date.now() - t0, at: Date.now(), source: 'ai' });
      aiUsage.lastError = null; saveAI(); dirty = true;
      log('AI BRİFİNG: ' + marketBrief.verdict + ' ' + marketBrief.score + '/100 (' + p.name + ', ' + marketBrief.latencyMs + 'ms)');
      return marketBrief;
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  aiUsage.lastError = redact(lastErr && lastErr.message || 'brifing sağlayıcısı yok'); saveAI();
  return marketBrief;
}
async function maybeMarketBrief() {
  if (!aiReady() || AI.briefPerDay <= 0) return;
  const q = aiQuota(); if (!q.ok) return;
  if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 0; }
  if (aiUsage.briefCount >= AI.briefPerDay) return;
  const h = new Date().getUTCHours();
  if (h < 8) return;
  if (aiUsage.briefCount === 0) { await aiMarketBrief(false); return; }
  if (aiUsage.briefCount === 1 && h >= 16) { await aiMarketBrief(false); }
}
/* ───────── PAPER / LIVE ENGINE — MANUEL ONAY ZORUNLU ───────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const opening = new Set();
const bookOf = sym => { const t = TICK[sym]; if (!t || !t.last) return null; const bid = t.bid > 0 ? t.bid : t.last, ask = t.ask > 0 ? t.ask : t.last; return { last: t.last, bid, ask, approx: !(t.bid > 0 && t.ask > 0) }; };
const entryPx = (sym, dir) => { const b = bookOf(sym); return b ? (dir === 'LONG' ? b.ask : b.bid) : null; };
const exitPx = o => { const b = bookOf(o.symbol); return b ? (o.dir === 'LONG' ? b.bid : b.ask) : null; };

function paperPnl(p, price) {
  const d = p.dir === 'LONG' ? 1 : -1;
  const part = p.tp1Hit && !p.single ? 0.5 * (p.tp1 / p.entry - 1) + 0.5 * (price / p.entry - 1) : price / p.entry - 1;
  let pnl = p.notional * part * d - p.notional * FEE_SIDE * 2;
  if (pnl < -p.margin) pnl = -p.margin;
  return { pnl, pct: pnl / p.margin * 100 };
}
function checkDailyLoss() {
  const key = new Date().toISOString().slice(0, 10);
  if (paper.dayKey !== key) { paper.dayKey = key; paper.dayStart = paper.balance; paper.liveDayPnl = 0; paper.liveDayStart = realBal.total || 0; dirty = true; }
  if (!(settings.dailyLossPct > 0)) return;
  if (settings.tradeMode === 'paper' && paper.balance <= paper.dayStart * (1 - settings.dailyLossPct / 100)) {
    settings.auto = false; saveSettings();
    log('PAPER: Günlük zarar limiti (%' + settings.dailyLossPct + ') aşıldı, OTO-TRADE otomatik KAPATILDI');
  } else if (settings.tradeMode === 'live' && paper.liveDayStart > 0 && (paper.liveDayPnl || 0) <= -(paper.liveDayStart * settings.dailyLossPct / 100)) {
    settings.auto = false; saveSettings();
    log('LIVE: Günlük zarar limiti (%' + settings.dailyLossPct + ') aşıldı, OTO-TRADE otomatik KAPATILDI');
  }
}

let liveInited = false;
async function liveInit() {
  if (liveInited) return;
  try { await ex.setPositionMode(false); } catch (e) { log('UYARI: tek yönlü pozisyon modu ayarlanamadı (' + e.message + ')'); }
  liveInited = true;
}
async function liveSetup(sym, lev) {
  try { await ex.setMarginMode('isolated', sym); } catch (e) { /* zaten isolated */ }
  await ex.setLeverage(lev, sym);
}
async function placeStop(sym, side, amount, price) {
  let lastErr = null;
  for (const params of [{ stopLossPrice: price, reduceOnly: true }, { triggerPrice: price, reduceOnly: true }]) {
    for (let i = 0; i < 2; i++) {
      try { const o = await ex.createOrder(sym, 'market', side, amount, undefined, params); if (o && o.id) return o.id; lastErr = new Error('stop emri id döndürmedi'); }
      catch (e) { lastErr = e; await sleep(250); }
    }
  }
  throw lastErr || new Error('stop emri doğrulanamadı');
}
async function emergencyClose(sym, side, amount) {
  for (let i = 0; i < 4; i++) { try { await ex.createOrder(sym, 'market', side, amount, undefined, { reduceOnly: true }); return true; } catch (e) { await sleep(400); } }
  return false;
}
async function fillOf(order, sym) {
  let f = Number(order && order.average) || Number(order && order.price) || 0;
  if (!f && order && order.id) { try { const o2 = await ex.fetchOrder(order.id, sym); f = Number(o2.average) || Number(o2.price) || 0; } catch (e) { /* yok */ } }
  return f;
}
async function openLive(sig, margin, lev, entryHint) {
  await liveInit();
  await liveSetup(sig.symbol, lev);
  const side = sig.dir === 'LONG' ? 'buy' : 'sell', slSide = sig.dir === 'LONG' ? 'sell' : 'buy';
  const amount = ex.amountToPrecision(sig.symbol, (margin * lev) / entryHint);
  if (!(Number(amount) > 0) || Number(amount) * entryHint < 5) throw new Error('miktar/notional çok küçük');
  const order = await ex.createOrder(sig.symbol, 'market', side, amount);
  const fill = (await fillOf(order, sig.symbol)) || entryHint;
  const qty = Number(order.filled) > 0 ? ex.amountToPrecision(sig.symbol, order.filled) : amount;
  let stopId = null;
  try { stopId = await placeStop(sig.symbol, slSide, qty, sig.sl); }
  catch (e) {
    log('LIVE STOP KURULAMADI (' + sig.base + '): ' + e.message + ' → ACİL KAPAT');
    if (await emergencyClose(sig.symbol, slSide, qty)) { log('LIVE: ' + sig.base + ' korumasız pozisyon kapatıldı'); return null; }
    log('ACİL: ' + sig.base + ' KORUMASIZ ve kapatılamadı!');
  }
  const notional = Number(qty) * fill;
  const p = {
    id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir,
    entry: rp(fill), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false,
    isLive: true, amount: qty, stopId, unprotected: !stopId, holdSec: sig.holdSec, noMoveSec: sig.noMoveSec,
    atrPct: sig.atrPct, quickTpPct: sig.quickTpPct, quickTimeSec: sig.quickTimeSec, quickArmPct: sig.quickArmPct,
    margin: +(notional / lev).toFixed(2), leverage: lev, notional, conf: sig.conf, aiScore: sig.ai && sig.ai.score, aiPlan: sig.aiGate && sig.aiGate.plan, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
  };
  paper.open.push(p); dirty = true;
  log('LIVE AÇILDI: ' + p.base + ' ' + p.dir + ' | ' + fmtP(sig.entry) + ' → dolum ' + fmtP(fill) + ' | miktar ' + qty + ' | ' + lev + 'x | stop ' + fmtP(p.sl) + (stopId ? '' : ' (STOP YOK!)'));
  return p;
}
async function liveClose(p) {
  const side = p.dir === 'LONG' ? 'sell' : 'buy';
  const o = await ex.createOrder(p.symbol, 'market', side, p.amount, undefined, { reduceOnly: true });
  const fill = await fillOf(o, p.symbol);
  if (p.stopId) {
    let ok = false;
    for (const params of [{ stop: true }, { trigger: true }, { stop: true, planType: 'loss_plan' }]) { try { await ex.cancelOrder(p.stopId, p.symbol, params); ok = true; break; } catch (e) { /* sıradaki */ } }
    if (!ok) { try { await ex.cancelAllOrders(p.symbol, { stop: true }); ok = true; } catch (e) { /* yok */ } }
    if (!ok) log('UYARI: ' + p.base + ' stop emri iptal edilemedi');
  }
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
  for (const p of lives) {
    if (has.has(p.symbol)) continue;
    log('LIVE: ' + p.base + ' borsada kapalı (stop tetiklenmiş olabilir) → yerelde kapatılıyor');
    p.extClosed = true;
    await closePaper(p, p.curSl || p.sl, 'SL');
  }
}

async function maybeOpenPaper(sig) {
  if (!sig || sig.module !== 'PUMP') return;
  if (sig.status !== 'AKTIF') return;
  if (!sig.aiGate || !['APPROVED', 'OFFLINE'].includes(sig.aiGate.state)) return;
  if (sig.ai && sig.ai.entryDecision === 'REJECT') return;
  if (!settings.auto) { log('ENGEL: ' + sig.base + ' oto-trade anahtarı kapalı'); return; }
  checkDailyLoss();
  if (!settings.auto) return;
  if (sig.conf < settings.minConf) return;
  if (paper.open.some(p => p.symbol === sig.symbol) || opening.has(sig.symbol)) return;
  if (paper.open.length + opening.size >= settings.maxOpen) { log('ENGEL: ' + sig.base + ' → max açık işlem (' + settings.maxOpen + ')'); return; }
  const live = settings.tradeMode === 'live';
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = sig.entry * (1 + d * PAPER_SLIP);
  let lev = settings.leverage, eq = paper.balance, margin = Math.min(settings.margin, paper.balance);
  if (live) {
    if (!IS_LIVE_READY) { log('HATA: Canlı işlem için API anahtarları eksik!'); return; }
    if (Date.now() - realBal.updatedAt > 3 * M1 || !(realBal.free > 0)) { log('LIVE ENGEL: gerçek bakiye okunamadı'); return; }
    lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE);
    eq = realBal.total;
    margin = Math.min(settings.margin, LIVE_MAX_MARGIN, realBal.free * 0.9);
  }
  const slDist = Math.abs(entry - sig.sl) / entry;
  if (settings.riskPct > 0 && slDist > 0 && eq > 0) margin = Math.min(margin, (eq * settings.riskPct / 100) / slDist / lev);
  margin = +margin.toFixed(2);
  if (margin < (live ? 2 : 10)) { log((live ? 'LIVE' : 'PAPER') + ' ENGEL: ' + sig.base + ' boyut yetersiz (' + margin + ')'); return; }
  opening.add(sig.symbol);
  try {
    if (!live) {
      const p = {
        id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir,
        entry: rp(entry), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, isLive: false,
        atrPct: sig.atrPct, velSeries: [],
        holdSec: sig.holdSec, noMoveSec: sig.noMoveSec,
        quickTpPct: sig.quickTpPct, quickTimeSec: sig.quickTimeSec, quickArmPct: sig.quickArmPct,
        margin, leverage: lev, notional: margin * lev, conf: sig.conf, aiScore: sig.ai && sig.ai.score, aiPlan: sig.aiGate && sig.aiGate.plan, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
      };
      paper.open.push(p); dirty = true;
      log('PAPER AÇILDI (operatör onayı): ' + p.base + ' ' + p.dir + ' | ' + fmtP(p.entry) + ' | SL %' + (sig.info.slPct != null ? sig.info.slPct : '?') + ' | TP %' + (sig.info.quickTpPct != null ? sig.info.quickTpPct : '?') + ' | ' + p.margin.toFixed(0) + ' USDT | ' + lev + 'x');
    } else {
      await openLive(sig, margin, lev, entry);
    }
  } catch (e) {
    log((live ? 'LIVE' : 'PAPER') + ' HATA (' + sig.base + '): ' + e.message);
  } finally { opening.delete(sig.symbol); }
}

async function closePaper(p, price, reason) {
  if (p.status === 'KAPALI' || p.closing) return false;
  p.closing = true;
  try {
    let exit = price;
    if (p.isLive && !p.extClosed) {
      try { const f = await liveClose(p); if (f) exit = f; }
      catch (e) {
        p.closeFail = (p.closeFail || 0) + 1;
        if (p.closeFail === 1 || p.closeFail % 10 === 0) log('LIVE KAPATMA HATASI (' + p.base + ', deneme ' + p.closeFail + '): ' + e.message);
        return false;
      }
    }
    const r = paperPnl(p, exit);
    p.status = 'KAPALI'; p.result = reason; p.exit = rp(exit); p.closedAt = Date.now();
    p.pnl = +r.pnl.toFixed(3); p.pnlPct = +r.pct.toFixed(2); p.durationMs = p.closedAt - p.openedAt;
    if (p.isLive) paper.liveDayPnl = (paper.liveDayPnl || 0) + r.pnl;
    else { paper.balance += r.pnl; paper.n++; paper.sumPnl += r.pnl; if (r.pnl > 0) paper.wins++; }
    paper.open = paper.open.filter(x => x.id !== p.id);
    paper.closed.unshift(p); dirty = true;
    log((p.isLive ? 'LIVE' : 'PAPER') + ' KAPANDI: ' + p.base + ' → ' + (REASON[reason] || reason) + ' | PnL ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) + ' USDT');
    checkDailyLoss();
    return true;
  } finally { p.closing = false; }
}
function paperSummary() {
  let unreal = 0;
  paper.open.filter(p => !p.isLive).forEach(p => { unreal += paperPnl(p, exitPx(p) || p.entry).pnl; });
  return {
    balance: +paper.balance.toFixed(2), start: paper.startBalance, equity: +(paper.balance + unreal).toFixed(2), unrealized: +unreal.toFixed(2),
    total: paper.n + paper.open.filter(p => !p.isLive).length, open: paper.open.length, closed: paper.n, wins: paper.wins,
    winRate: paper.n ? +(paper.wins / paper.n * 100).toFixed(1) : 0, sumPnl: +paper.sumPnl.toFixed(2), avgPnl: paper.n ? +(paper.sumPnl / paper.n).toFixed(3) : 0,
    dayStart: +paper.dayStart.toFixed(2), liveOpen: paper.open.filter(p => p.isLive).length, liveDayPnl: +(paper.liveDayPnl || 0).toFixed(2)
  };
}

const fromOf = o => (o.lastTs ? o.lastTs + M1 : Math.ceil((o.createdAt || o.openedAt) / M1) * M1);
const finish = (o, price, reason, kind) => (kind === 'sig' ? closeSignal(o, price, reason) : closePaper(o, price, reason));
function pumpPeak(o, price) {
  const d = o.dir === 'LONG' ? 1 : -1, pct = (price / o.entry - 1) * d * 100;
  if (o.peakPct == null || pct > o.peakPct) o.peakPct = pct;
  return pct;
}
function tpTarget(o) {
  const atrPct = o.atrPct > 0 ? o.atrPct : 0.55;
  return clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX);
}
function quickTpOf(atrPct) {
  if (settings.pumpQuick === false) return null;
  const a = atrPct > 0 ? atrPct : 0.55;
  return +clamp(EX.QUICK_TP_K * a, EX.QUICK_TP_MIN, EX.QUICK_TP_MAX).toFixed(2);
}
function applyCostCover(o, pnl) {
  if (!(o.peakPct >= EX.BE_ARM)) return false;
  const d = o.dir === 'LONG' ? 1 : -1;
  const lock = o.entry * (1 + d * EX.BE_LOCK / 100);
  const cur = o.curSl;
  if (cur == null || (lock - cur) * d > 0) { o.curSl = lock; o.beArmed = true; return true; }
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
  for (let i = 0; i < ser.length; i++) if (ser[i].v > peak) peak = ser[i].v;
  if (!(peak > 1e-6)) return 1;
  return Math.max(0, cur) / peak;
}
function pumpDecide(o, price, nowMs) {
  const pnl = pumpPeak(o, price);
  const peak = o.peakPct;
  const born = o.startedAt || (o.createdAt != null ? o.createdAt : o.openedAt);
  const age = Math.max(0, nowMs - born) / 1000;
  const holdSec = o.holdSec != null ? o.holdSec : EX.HOLD;
  const noMoveSec = o.noMoveSec != null ? o.noMoveSec : EX.NO_MOVE;
  if (pnl >= tpTarget(o) - EPS) return 'TPMAX';
  applyCostCover(o, pnl);
  if (peak >= EX.LOCK_ARM) {
    const gb = Math.max(EX.GB_MIN, EX.GB_FRAC * peak);
    if (peak - pnl >= gb - EPS) return 'FADE';
  }
  if (peak >= EX.BE_ARM) {
    const vr = velRatio(o, nowMs);
    const minPnl = Math.max(EX.H + 0.05, EX.DECAY_MIN_PNL);
    if (vr < EX.DECAY_RATIO && pnl >= minPnl - EPS) return 'MOMENTUM';
  }
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
      if (r) {
        if (r.done) { closeSignal(o, r.price, r.reason); return; }
        dirty = true;
        log('TP1 vuruldu: ' + MODS[o.module].label + ' ' + o.base + ' (yarısı kapandı)');
      }
      if (c.t + M1 <= t) o.lastTs = c.t;
    }
  }
  const px = priceOf(o.symbol) || lastClose || o.entry;
  if (t - o.createdAt > o.maxAgeMs) closeSignal(o, px, 'SURE');
}
async function pumpTick(o, now, kind) {
  if (!o || o.status !== 'AKTIF' || o.closing) return;
  const born = o.startedAt || (o.createdAt != null ? o.createdAt : o.openedAt), age = (now - born) / 1000;
  const hold = o.holdSec != null ? o.holdSec : EX.HOLD;
  const px = exitPx(o);
  if (!px) { if (age > hold + 30) await finish(o, o.lastPx || o.entry, 'SURE', kind); return; }
  o.lastPx = px;
  pumpPeak(o, px);
  applyCostCover(o, o.peakPct);
  if (settings.pumpQuick !== false && o.quickTpPct != null) {
    const d = o.dir === 'LONG' ? 1 : -1;
    const pnl = (px / o.entry - 1) * d * 100;
    if (pnl >= o.quickTpPct - EPS) { await finish(o, px, 'QUICK', kind); return; }
  }
  const r = stepTrade(o, { t: now, h: px, l: px, c: px });
  if (r && r.done) {
    let price = r.price;
    if (r.reason === 'SL' || r.reason === 'BE') price = o.dir === 'LONG' ? Math.min(price, px) : Math.max(price, px);
    await finish(o, price, r.reason === 'TP1' ? 'TPMAX' : r.reason, kind);
    return;
  }
  const dec = pumpDecide(o, px, now);
  if (dec) await finish(o, px, dec, kind);
}
async function pumpManage(now) {
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'AI_BEKLIYOR')) {
    if (s.aiGate && now >= s.aiGate.expiresAt) declinePumpAI(s, 'AI_TIMEOUT', 'AI onayı ' + Math.round(AI.pumpWaitMs / 1000) + ' sn içinde gelmedi');
  }
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'ONAY_BEKLIYOR')) {
    if (s.approvalExpiresAt && now >= s.approvalExpiresAt) {
      s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = now;
      s.exit = null; s.netR = null; s.grossR = null; s.pnlPct = null;
      dirty = true;
      log('ALGOPUMP ONAY SÜRESİ DOLDU: ' + s.base + ' ' + s.dir);
    }
  }
  for (const s of signals.filter(x => x.status === 'AKTIF' && x.module === 'PUMP')) { try { await pumpTick(s, now, 'sig'); } catch (e) { log('HATA pump takip ' + s.base + ': ' + e.message); } }
  for (const p of paper.open.slice()) { try { await pumpTick(p, now, 'paper'); } catch (e) { log('HATA pump işlem ' + p.base + ': ' + e.message); } }
}
async function trackerCycle() {
  const t = Date.now();
  const act = signals.filter(s => s.status === 'AKTIF' && s.module !== 'PUMP' && (!s._chk || t - s._chk >= 55000));
  if (!act.length) return;
  const need = new Map();
  for (const o of act) { const f = fromOf(o), v = need.get(o.symbol); if (v === undefined || f < v) need.set(o.symbol, f); }
  const data = {};
  await pool(Array.from(need.keys()), 6, async sym => {
    const since = need.get(sym), lim = Math.min(300, Math.ceil((t - since) / M1) + 2);
    try { const raw = await ex.fetchOHLCV(sym, '1m', since, lim); data[sym] = (raw || []).map(toC); } catch (e) { stats.apiErr++; }
  });
  for (const s of act) { s._chk = t; try { processTrade(s, data[s.symbol], t); } catch (e) { log('HATA takip ' + s.base + ': ' + e.message); } }
}

/* ───────── PUMP ENGINE ───────── */
const SNAP = {};
const OI = new Map();
const RING = new Map();
const FLOW = new Map();
const ATRC = new Map();
const ARMED = new Set();
const lastBurstChk = {};

function snapAt(h, t) {
  if (!h || !h.length) return null;
  let lo = 0, hi = h.length - 1, res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h[m].t <= t) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return res >= 0 ? h[res] : null;
}
function pushSnap(sym, ts, price, qv) {
  if (!(price > 0)) return;
  let h = SNAP[sym];
  if (!h) h = SNAP[sym] = [];
  const last = h[h.length - 1];
  if (last && ts - last.t < 900) { last.p = price; if (qv != null) last.qv = Number(qv); return; }
  h.push({ t: ts, p: price, qv: qv != null ? Number(qv) : null });
  const cut = ts - PUMP.snapKeepMs;
  let drop = 0;
  while (drop < h.length && h[drop].t < cut) drop++;
  if (drop > 64) h.splice(0, drop);
}
function pushOI(sym, ts, v) {
  if (!(v > 0)) return;
  let a = OI.get(sym);
  if (!a) { a = []; OI.set(sym, a); }
  const last = a[a.length - 1];
  if (last && ts - last.t < 5000) { last.v = v; return; }
  a.push({ t: ts, v });
  const cut = ts - 15 * M1;
  let drop = 0;
  while (drop < a.length && a[drop].t < cut) drop++;
  if (drop > 16) a.splice(0, drop);
  if (a.length > 400) a.splice(0, a.length - 400);
}
function oiChg(sym, ms) {
  const a = OI.get(sym);
  if (!a || a.length < 2) return null;
  const now = a[a.length - 1];
  let ref = null;
  for (const x of a) { if (x.t >= now.t - ms) { ref = x; break; } }
  if (!ref || ref === now || !(ref.v > 0)) return null;
  return (now.v / ref.v - 1) * 100;
}
function ringOf(sym) {
  let r = RING.get(sym);
  if (!r) { r = { t: [], p: [] }; RING.set(sym, r); }
  return r;
}
function ringPush(sym, ts, price) {
  if (!(price > 0) || !isFinite(price)) return;
  const r = ringOf(sym);
  const n = r.p.length;
  if (n && ts <= r.t[n - 1]) { r.p[n - 1] = price; return; }
  r.p.push(price); r.t.push(ts);
  const cut = ts - EX.VEL_PEAK_MEMORY_MS;
  let drop = 0;
  while (drop < r.t.length && r.t[drop] < cut) drop++;
  if (drop > 64) { r.t.splice(0, drop); r.p.splice(0, drop); }
  if (r.p.length > 2000) { r.t.splice(0, 400); r.p.splice(0, 400); }
}
function ringAt(r, ts) {
  const t = r.t;
  let lo = 0, hi = t.length - 1, res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return res >= 0 ? r.p[res] : null;
}
function ringMove(r, winMs, now) {
  const n = r.p.length;
  if (n < 2) return 0;
  const ref = ringAt(r, now - winMs);
  if (!(ref > 0)) return 0;
  return (r.p[n - 1] / ref - 1) * 100;
}
function flowOf(sym) {
  let f = FLOW.get(sym);
  if (!f) { f = { b: Object.create(null), last: 0 }; FLOW.set(sym, f); }
  return f;
}
function flowOnTrade(sym, ts, notional) {
  if (!(notional > 0) || !isFinite(notional)) return;
  const f = flowOf(sym);
  const k = Math.floor(ts / 1000) * 1000;
  f.b[k] = (f.b[k] || 0) + notional;
  if (ts > f.last) f.last = ts;
}
function flowBurst(sym, now) {
  const f = FLOW.get(sym);
  if (!f) return null;
  const nowB = Math.floor(now / 1000) * 1000;
  let recent = 0;
  for (let k = nowB - 3000; k <= nowB; k += 1000) recent += f.b[k] || 0;
  const from = nowB - 60000, to = nowB - 10000;
  let baseSum = 0, baseBuckets = 0;
  for (let k = from; k < to; k += 1000) { baseSum += f.b[k] || 0; baseBuckets++; }
  if (baseBuckets < 20) return null;
  const basePerShort = (baseSum / baseBuckets) * 3;
  if (!(basePerShort > 0)) return null;
  return recent / basePerShort;
}

function getWS() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  try { return require('ws'); } catch (e) { return null; }
}
class BitgetStream {
  constructor(url) {
    this.url = url || 'wss://ws.bitget.com/v2/ws/public';
    this.ws = null; this.subs = new Set(); this.backoff = 1000;
    this.pingTimer = null; this.reconnectTimer = null; this.closed = false;
  }
  start() {
    const WS = getWS();
    if (!WS) { log('WS yok → REST ticker yedeği'); return; }
    this.closed = false;
    try { this.ws = new WS(this.url); } catch (e) { log('WS açılamadı: ' + e.message); return; }
    this.ws.onopen = () => {
      this.backoff = 1000;
      log('WS bağlandı (' + this.subs.size + ' kanal)');
      this._flush();
      this.pingTimer = setInterval(() => this._send('ping'), 25000);
    };
    this.ws.onmessage = ev => {
      const raw = typeof ev === 'string' ? ev : (ev && ev.data);
      if (!raw || raw === 'pong' || raw === 'ping') return;
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      this._onMsg(msg);
    };
    this.ws.onerror = () => { /* onclose takip eder */ };
    this.ws.onclose = () => {
      clearInterval(this.pingTimer); this.pingTimer = null;
      if (this.closed) return;
      this.backoff = Math.min(this.backoff * 2, 30000);
      log('WS koptu, ' + (this.backoff / 1000) + ' sn sonra yeniden');
      this.reconnectTimer = setTimeout(() => this.start(), this.backoff);
    };
  }
  stop() { this.closed = true; clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); try { if (this.ws) this.ws.close(); } catch (e) { /* yok */ } }
  _send(o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { /* yeniden */ } }
  _args(keys) { return keys.map(k => { const a = k.split('|'); return { instType: 'USDT-FUTURES', channel: a[0], instId: a[1] }; }); }
  _batch(keys) { for (let i = 0; i < keys.length; i += 20) this._send({ op: 'subscribe', args: this._args(keys.slice(i, i + 20)) }); }
  _flush() { if (this.subs.size) this._batch(Array.from(this.subs)); }
  setSymbols(symbols) {
    const want = new Set();
    for (const sym of symbols) {
      const inst = String(sym).split('/')[0] + 'USDT';
      want.add('ticker|' + inst);
      want.add('trade|' + inst);
    }
    for (const k of Array.from(this.subs)) {
      if (want.has(k)) continue;
      this.subs.delete(k);
      this._send({ op: 'unsubscribe', args: this._args([k]) });
    }
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
  const last = num(d.lastPr);
  if (!(last > 0)) return;
  const prev = TICK[sym] || {};
  const bid = num(d.bidPr) || last;
  const ask = num(d.askPr) || last;
  const qv = num(d.quoteVolume) || prev.quoteVolume || 0;
  const oi = num(d.holdingAmount) || prev.oi || null;
  TICK[sym] = { last, bid, ask, quoteVolume: qv, percentage: d.change24h != null ? num(d.change24h) : (prev.percentage || 0), timestamp: now, oi };
  pushSnap(sym, now, last, qv);
  pushOI(sym, now, oi);
  ringPush(sym, now, last);
}
function ingestTrade(sym, d) {
  const price = num(d.price), size = num(d.size);
  if (!(price > 0) || !(size > 0)) return;
  flowOnTrade(sym, num(d.ts) || Date.now(), price * size);
}
function microBars(sym, now, count) {
  const s = SNAP[sym];
  if (!s || s.length < 8) return null;
  const B = PUMP.barMs, out = [];
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    if (!(x.p > 0)) continue;
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
  const s = SNAP[sym];
  if (!s || s.length < 24) return 0;
  const a = snapAt(s, now - winMs);
  const last = s[s.length - 1];
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
    mean += d / n;
    m2 += d * (r - mean);
    dtSum += Math.max(1, s[i].t - s[i - 1].t);
  }
  if (n < PUMP.vel.minNoiseN) return 0;
  const sd = Math.sqrt(m2 / Math.max(1, n - 1));
  const dt = Math.max(250, dtSum / n);
  return move / Math.max(sd * Math.sqrt(winMs / dt), 0.03);
}
function qvBurst(sym, now) {
  const s = SNAP[sym];
  if (!s || s.length < 12) return null;
  const last = s[s.length - 1];
  const a = snapAt(s, now - 3000);
  const c = snapAt(s, now - 60000);
  const d = snapAt(s, now - 10000);
  if (!a || !c || !d) return null;
  if (a.qv == null || last.qv == null || c.qv == null || d.qv == null) return null;
  const recentMs = last.t - a.t, baseSpan = d.t - c.t;
  if (!(recentMs > 400) || !(baseSpan > 20000)) return null;
  const recentFlow = (last.qv - a.qv) / recentMs;
  const baseFlow = (d.qv - c.qv) / baseSpan;
  if (!(baseFlow > 0) || !(recentFlow > 0)) return null;
  return recentFlow / baseFlow;
}
function volumeBurst(sym, now) {
  const f = flowBurst(sym, now);
  if (f != null && isFinite(f)) return f;
  return qvBurst(sym, now);
}
function priorRunPct(sym, now, d, ms) {
  const s = SNAP[sym];
  if (!s || s.length < 6) return 0;
  const a = snapAt(s, now - ms);
  const end = snapAt(s, now - 20000);
  if (!a || !end || !(a.p > 0)) return 0;
  return (end.p / a.p - 1) * d * 100;
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
  const rng = f.h - f.l;
  if (!(rng > 0)) return null;
  const body = (f.c - f.o) / rng;
  const up = f.c > hiN && body >= PUMP.bodyMin;
  const dn = f.c < loN && body <= -PUMP.bodyMin;
  if (!up && !dn) return null;
  const dir = up ? 'LONG' : 'SHORT';
  const d = up ? 1 : -1;
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
    const strongL = market.dir === 'LONG' && market.score > 0.68;
    const strongS = market.dir === 'SHORT' && market.score < 0.32;
    if (strongL || strongS) return { ok: false, reject: 'ters' };
  }
  const bk = bookOf(sym);
  if (!bk) return { ok: false, reject: 'no-book' };
  if (!(bk.ask > 0) || !(bk.bid > 0) || !(bk.ask >= bk.bid)) return { ok: false, reject: 'bad-book' };
  const spreadPct = ((bk.ask - bk.bid) / bk.last) * 100;
  if (!(spreadPct <= PUMP.maxSpreadPct)) return { ok: false, reject: 'spread' };
  const d = ig.dir === 'LONG' ? 1 : -1;
  const fill = ig.dir === 'LONG' ? bk.ask : bk.bid;
  const latePct = (fill / ig.origin - 1) * d * 100;
  if (!(latePct > -0.05)) return { ok: false, reject: 'stale-origin' };
  const A = expectedLeg(sym);
  if (A == null) return { ok: false, reject: 'no-atr' };
  const oi1 = oiChg(sym, 60000), oi5 = oiChg(sym, 5 * M1);
  if (oi1 != null && oi1 < -0.50) return { ok: false, reject: 'oi-dusuyor' };
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
  if (netRR < EX.MIN_NET_RR) return { ok: false, reject: 'net-rr' };
  if (spreadPct > 0.30 * slPct) return { ok: false, reject: 'spread-wide' };
  return {
    ok: true, dir: ig.dir, fill: rp(fill), sl: rp(sl), tp: rp(tp),
    latePct: +latePct.toFixed(3), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2),
    slStruct: +slStruct.toFixed(2), slFloor: +slFloor.toFixed(2), atrPct: +atrPct.toFixed(2),
    netRR: +netRR.toFixed(2), A: +A.toFixed(2), spreadPct: +spreadPct.toFixed(3),
    originPx: rp(ig.origin), oi1: oi1 != null ? +oi1.toFixed(2) : null, oi5: oi5 != null ? +oi5.toFixed(2) : null
  };
}
function scoreConfidence(ig, g) {
  const c = 60 +
    clamp((ig.z - PUMP.vel.minZ) * 2.0, 0, 12) +
    clamp((ig.vBurst - PUMP.vel.minVolRatio) * 3.0, 0, 12) +
    clamp((g.A - g.latePct - PUMP.vel.minEdgeMult * EX.H) * 6, 0, 8) +
    clamp((PUMP.coilMaxPct - ig.preRng) * 4, 0, 5) +
    clamp((g.netRR - EX.MIN_NET_RR) * 6, 0, 5);
  return clamp(Math.round(c), 40, 95);
}
function pumpScanVel(now) {
  if (!ARMED.size) return;
  for (const sym of ARMED) {
    const prev = lastBurstChk[sym];
    if (prev && now - prev < PUMP.recheckMs) continue;
    const ig = ignition(sym, now);
    if (!ig) continue;
    stats.pumpScanned++;
    lastBurstChk[sym] = now;
    const g = entryGuard(sym, ig);
    if (!g.ok) { PWHY['guard:' + g.reject] = (PWHY['guard:' + g.reject] || 0) + 1; continue; }
    const quickTpPct = quickTpOf(g.atrPct);
    const quickNetRR = quickTpPct != null ? +((quickTpPct - EX.H) / (g.slPct + EX.H)).toFixed(2) : null;
    const det = {
      module: 'PUMP', symbol: sym, dir: g.dir,
      entry: g.fill, sl: g.sl, tp1: g.tp, tp2: null, single: true,
      conf: scoreConfidence(ig, g),
      holdSec: EX.HOLD, noMoveSec: EX.NO_MOVE, maxAgeMs: (EX.HOLD + 30) * 1000,
      quickTpPct, quickTimeSec: quickTpPct != null ? EX.QUICK_TIME : null, quickArmPct: quickTpPct != null ? EX.QUICK_ARM : null,
      atrPct: g.atrPct,
      info: {
        tf: 'ignition', trigger: 'coil-break',
        originPx: g.originPx, latePct: g.latePct, disp: +ig.disp.toFixed(3),
        z: +ig.z.toFixed(1), vBurst: +ig.vBurst.toFixed(2),
        preRng: +ig.preRng.toFixed(2), body: +ig.body.toFixed(2),
        spreadPct: g.spreadPct, slPct: g.slPct, tpPct: g.tpPct,
        quickTpPct, quickTimeSec: quickTpPct != null ? EX.QUICK_TIME : null, quickNetRR,
        slStruct: g.slStruct, slFloor: g.slFloor, atrPct: g.atrPct,
        netRR: g.netRR, expectedLeg: g.A, oi1: g.oi1, oi5: g.oi5,
        lastPx: rp(bookOf(sym).last)
      }
    };
    addSignal(det);
  }
}
function snapMove(h, now, ms) {
  let ref = null;
  for (let i = 0; i < h.length; i++) { if (h[i].t >= now - ms - 2500) { ref = h[i]; break; } }
  if (!ref || now - ref.t < ms * 0.6) return null;
  return (h[h.length - 1].p / ref.p - 1) * 100;
}
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
  const list = pumpCandidates(now);
  if (!list.length) return;
  await pool(list, 5, async c => {
    const sym = c.sym;
    lastBurstChk[sym] = now;
    const tk = TICK[sym];
    if (tk && tk.bid && tk.ask) { const sp = (tk.ask - tk.bid) / tk.last * 100; if (sp > PUMP.maxSpreadPct) { PWHY['spread geniş'] = (PWHY['spread geniş'] || 0) + 1; return; } }
    const raw = await getC(sym, '1m', 60, 0);
    const tNow = Date.now();
    if (!raw || raw.length < 45 || tNow - raw[raw.length - 1].t > 2 * M1) { PWHY['veri yok/bayat'] = (PWHY['veri yok/bayat'] || 0) + 1; return; }
    stats.pumpScanned++;
    let det = detectBurst(raw, M1, tNow, PWHY);
    if (!det) det = detectBurst(aggTF(raw, 3), M3, tNow, PWHY);
    if (!det) return;
    if (PUMP.macroFilter) {
      if (market.dir === 'SHORT' && market.score < 0.35 && det.dir === 'LONG') return;
      if (market.dir === 'LONG' && market.score > 0.65 && det.dir === 'SHORT') return;
    }
    const px = priceOf(sym) || det.entry, d = det.dir === 'LONG' ? 1 : -1;
    const bk = bookOf(sym), fillPx = bk ? (det.dir === 'LONG' ? bk.ask : bk.bid) : px;
    det.entry = rp(fillPx); det.sl = rp(fillPx * (1 - d * det.info.slPct / 100)); det.tp1 = rp(fillPx * (1 + d * det.info.tpPct / 100));
    det.info.lastPx = rp(px); det.info.spreadPct = bk ? +((bk.ask - bk.bid) / px * 100).toFixed(3) : null;
    det.atrPct = atrPctOf(sym);
    addSignal(Object.assign({ module: 'PUMP', symbol: sym }, det));
  });
}
function pumpCycle() {
  const now = Date.now();
  pumpScanVel(now);
  if (PUMP.useCandlePath) pumpScanCandle(now).catch(e => log('HATA pumpScanCandle: ' + e.message));
  pumpManage(now).catch(e => log('HATA pumpManage: ' + e.message));
}
const ARM_SEEN = new Map();
function refreshArmed() {
  const now = Date.now();
  for (const sym of ALL) {
    const tk = TICK[sym];
    if (!tk || !(tk.last > 0)) continue;
    if (!(quoteVolOf(tk) >= PUMP.minQuoteVol)) continue;
    const bid = tk.bid > 0 ? tk.bid : tk.last, ask = tk.ask > 0 ? tk.ask : tk.last;
    if (!(ask >= bid)) continue;
    if (((ask - bid) / tk.last) * 100 > PUMP.maxSpreadPct) continue;
    const s = SNAP[sym];
    if (!s || s.length < PUMP.vel.minHist) continue;
    ARM_SEEN.set(sym, now);
  }
  ARMED.clear();
  for (const [sym, ts] of ARM_SEEN) {
    if (now - ts > 180000) { ARM_SEEN.delete(sym); continue; }
    const s = SNAP[sym];
    if (s && s.length >= PUMP.vel.minHist) ARMED.add(sym);
  }
  stream.setSymbols(ARMED);
  log('ARMED: ' + ARMED.size + ' sembol');
}
function atrPctFromCandles(cs, p) {
  p = p || 14;
  if (!cs || cs.length < p + 2) return null;
  let s = 0;
  for (let i = 1; i <= p; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    s += tr;
  }
  let a = s / p;
  for (let i = p + 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    a = (a * (p - 1) + tr) / p;
  }
  const c = cs[cs.length - 1].c;
  return c > 0 ? (a / c) * 100 : null;
}
function setAtr(sym, atrPct, now) {
  if (!(atrPct > 0)) return;
  ATRC.set(sym, { atrPct: clamp(atrPct, 0.05, 8), at: now || Date.now() });
}
function atrPctOf(sym) {
  const a = ATRC.get(sym);
  return a && a.atrPct > 0 && Date.now() - a.at < 5 * M1 ? a.atrPct : 0.55;
}
function expectedLeg(sym) {
  const a = ATRC.get(sym);
  if (!a || !(a.atrPct > 0) || Date.now() - a.at > 5 * M1) return null;
  return clamp(EX.TP_ATR_K * a.atrPct, 0.35, 3.0);
}
async function refreshAtr() {
  const q = Array.from(ARMED);
  const workers = Array.from({ length: Math.min(6, q.length) }, async () => {
    while (q.length) {
      const sym = q.pop();
      try {
        const raw = await ex.fetchOHLCV(sym, '1m', undefined, 40);
        if (!raw || raw.length < 20) continue;
        const cs = raw.map(toC);
        const pct = atrPctFromCandles(cs, 14);
        if (pct) setAtr(sym, pct);
      } catch (e) { /* atla */ }
    }
  });
  await Promise.all(workers);
}
const ARM_CTX = new Map();
async function armSymbol(sym, lev) {
  const c = ARM_CTX.get(sym) || {};
  if (c.levSetAt && c.lev === lev && Date.now() - c.levSetAt < 10 * M1) return c;
  try { await ex.setMarginMode('isolated', sym); } catch (e) { /* zaten */ }
  await ex.setLeverage(lev, sym);
  c.lev = lev; c.levSetAt = Date.now();
  ARM_CTX.set(sym, c);
  return c;
}
async function refreshLeverageArms() {
  if (settings.tradeMode !== 'live' || !IS_LIVE_READY) return;
  const lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE);
  for (const sym of ARMED) {
    try { await armSymbol(sym, lev); } catch (e) { /* sonraki */ }
  }
}
function prunePumpState(now) {
  for (const sym of Object.keys(SNAP)) {
    const h = SNAP[sym];
    if (!h.length || now - h[h.length - 1].t > 10 * M1) delete SNAP[sym];
  }
  for (const [sym, r] of RING) {
    let drop = 0;
    const cut = now - EX.VEL_PEAK_MEMORY_MS;
    while (drop < r.t.length && r.t[drop] < cut) drop++;
    if (drop) { r.t.splice(0, drop); r.p.splice(0, drop); }
    if (!r.p.length) RING.delete(sym);
  }
  for (const [sym, f] of FLOW) {
    const cut = now - 62000;
    for (const k of Object.keys(f.b)) if (Number(k) < cut) delete f.b[k];
    if (!Object.keys(f.b).length) FLOW.delete(sym);
  }
}
async function scanScalper() {
  if (!MODS.SCALPER.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '15m', 120);
    if (!raw) return;
    const cs = closed(raw, M15);
    if (cs.length < 80) return;
    sc('SCALPER', 'taranan');
    const det = detectScalper(cs, SWHY);
    if (!det) return;
    if (det.conf < SCALP.minConf) { SWHY['güven düşük'] = (SWHY['güven düşük'] || 0) + 1; return; }
    cands.push({ sym, det, last: cs[cs.length - 1] });
  });
  cands.sort((a, b) => (b.det.conf - a.det.conf) || ((b.det.info.volRatio || 0) - (a.det.info.volRatio || 0)));
  for (const c of cands) emit('SCALPER', c.sym, c.det, c.last, M15, 6 * M1);
}
async function scanRange() {
  if (!MODS.RANGE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '15m', 170);
    if (!raw) return;
    const cs = closed(raw, M15);
    if (cs.length < 120) return;
    sc('RANGE', 'taranan');
    const r = detectRange(cs, RWHY);
    if (r.watch) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, r.watch));
    if (r.signal && r.signal.conf >= REVERT.minConf) emit('RANGE', sym, r.signal, cs[cs.length - 1], M15, 12 * M1);
    else if (r.signal) RWHY['güven düşük'] = (RWHY['güven düşük'] || 0) + 1;
  });
  watch.sort((a, b) => b.squeezeScore - a.squeezeScore);
  WATCH.range = watch.slice(0, 40);
}
async function scanZone() {
  if (!MODS.ZONE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const r1 = await getC(sym, '1h', 260);
    if (!r1) return;
    const c1 = closed(r1, H1);
    if (c1.length < 100) return;
    sc('ZONE', 'taranan');
    const r4 = await getC(sym, '4h', 130);
    const c4 = r4 ? closed(r4, H4) : null;
    const res = detectZone(c1, buildZones(c1, c4));
    res.watch.forEach(w => watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, w)));
    if (res.signal) emit('ZONE', sym, res.signal, c1[c1.length - 1], H1, 55 * M1);
  });
  watch.sort((a, b) => a.dist - b.dist);
  WATCH.zone = watch.slice(0, 40);
}
async function scanTrend() {
  if (!MODS.TREND.enabled) return;
  await pool(TOP.slice(0, 100), 6, async sym => {
    const raw = await getC(sym, '5m', 150);
    if (!raw) return;
    const cs = closed(raw, M5);
    if (cs.length < 100) return;
    sc('TREND', 'taranan');
    const det = detectPSAR(cs, TWHY);
    if (det) emit('TREND', sym, det, cs[cs.length - 1], M5, 4 * M1);
  });
}
async function scanLT() {
  if (!MODS.LT.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const sets = [];
    const r4 = await getC(sym, '4h', 150);
    if (r4) sets.push({ tf: '4h', ms: H4, cs: closed(r4, H4), lag: 90 * M1 });
    const r1 = await getC(sym, '1h', 300);
    if (r1) {
      const c1 = closed(r1, H1);
      let a2 = aggTF(c1, 120);
      if (a2.length && a2[a2.length - 1].t + H1 > c1[c1.length - 1].t) a2 = a2.slice(0, -1);
      sets.push({ tf: '2h', ms: 2 * H1, cs: a2, lag: 60 * M1 });
    }
    for (const T of sets) {
      if (T.cs.length < 60) continue;
      sc('LT', 'taranan');
      let r = detectLT(T.cs);
      if (r.watch && !watch.some(x => x.symbol === sym)) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)), tf: T.tf }, r.watch));
      if (r.signal) {
        const rd = await getC(sym, '1d', 60);
        r = detectLT(T.cs, rd ? closed(rd, D1) : null);
        if (r.signal) {
          r.signal.info.tf = T.tf;
          const si = r.signal.info;
          if (si.line0 > 0 && si.lineStep > 0) {
            const armDist = Math.max(0.45, 0.60 * (si.atrPct || 1));
            LTR.set(sym + '|' + T.tf, {
              sym, base: baseOf(sym), tf: T.tf, dir: r.signal.dir,
              line0: si.line0, slope: si.lineSlope, step: si.lineStep, lineT: si.lineT,
              height: si.height, mid: si.mid, atrPct: si.atrPct,
              breakoutAt: Date.now(), lastAlertAt: 0, failCount: 0,
              armed: false, lines: si.lines
            });
            saveLTR();
            log('LT İZLEME: ' + baseOf(sym) + ' ' + r.signal.dir + ' | ' + T.tf + ' çizgi ' + fmtP(si.line0) + ' | retest için ' + armDist.toFixed(2) + '% uzaklaşma şartı');
          }
          emit('LT', sym, r.signal, T.cs[T.cs.length - 1], T.ms, T.lag);
        }
      }
    }
  });
  watch.sort((a, b) => b.maturity - a.maturity);
  WATCH.lt = watch.slice(0, 40);
}

async function getDailyLevels(sym, force) {
  const now = Date.now(), dayKey = dayKeyOf(now), hit = DAILY_LEVELS.get(sym);
  if (!force && hit && hit.dayKey === dayKey && now - hit.at < 90 * M1) return hit;
  const raw = await getC(sym, '1d', 5, 60 * M1);
  if (!raw || raw.length < 2) return null;
  const cs = closed(raw, D1);
  if (!cs.length) return null;
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
  const watch = [];
  await pool(TOP.slice(0, DAILY.topN), 6, async sym => {
    const raw = await getC(sym, '15m', 120, 150000);
    if (!raw) return;
    const cs = closed(raw, M15);
    if (cs.length < 40) return;
    const last = cs[cs.length - 1];
    if (Date.now() - (last.t + M15) > 6 * M1) return;
    const lv = await getDailyLevels(sym);
    if (!lv) return;
    sc('DAILY', 'taranan');
    const det = detectDailySweep(cs, lv);
    if (det) {
      if (det.conf < DAILY.minConf) { DWHY['güven düşük'] = (DWHY['güven düşük'] || 0) + 1; return; }
      const tk = TICK[sym];
      const spread = tk && tk.last > 0 && tk.bid > 0 && tk.ask > 0 ? (tk.ask - tk.bid) / tk.last * 100 : null;
      if (spread != null && spread > DAILY.maxSpreadPct) { DWHY['spread geniş'] = (DWHY['spread geniş'] || 0) + 1; return; }
      emit('DAILY', sym, det, last, M15, 6 * M1);
    } else {
      const w = dailyWatch(cs, lv);
      if (w) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, w));
    }
  });
  watch.sort((a, b) => Math.min(Math.abs(a.distPdh), Math.abs(a.distPdl)) - Math.min(Math.abs(b.distPdh), Math.abs(b.distPdl)));
  WATCH.daily = watch.slice(0, 40);
}
function ltRetestCycle() {
  if (!MODS.LT.enabled) return;
  const now = Date.now();
  for (const [key, e] of Array.from(LTR)) {
    if (!e || !e.sym || !(e.step > 0)) { LTR.delete(key); continue; }
    const x = (now - e.lineT) / e.step;
    if (x > 12.5) { LTR.delete(key); saveLTR(); continue; }
    const px = priceOf(e.sym);
    if (!(px > 0)) continue;
    const line = e.line0 + e.slope * x;
    if (!(line > 0)) { LTR.delete(key); continue; }
    const d = e.dir === 'LONG' ? 1 : -1;
    const dist = (px / line - 1) * 100 * d;
    const atrPct = e.atrPct || 1;
    const tol = Math.max(0.15, 0.25 * atrPct);
    const fail = Math.max(0.35, 0.50 * atrPct);
    if (dist < -fail) {
      e.failCount = (e.failCount || 0) + 1;
      if (e.failCount >= 2) {
        LTR.delete(key); saveLTR();
        log('LT RETEST İPTAL: ' + e.base + ' ' + e.dir + ' | çizgi ' + fmtP(line) + ' | fiyat ' + fmtP(px));
      }
      continue;
    }
    e.failCount = 0;
    if (!e.armed) { if (dist >= Math.max(0.45, 0.60 * atrPct)) { e.armed = true; saveLTR(); } continue; }
    if (dist > tol) continue;
    const recent = Array.from(LTR.values()).some(o => o.sym === e.sym && o.lastAlertAt && now - o.lastAlertAt < 30 * M1);
    if (recent) continue;
    const entry = line;
    const slPct = Math.max(0.50, 0.50 * atrPct);
    const sl = entry * (1 - d * slPct / 100);
    const tp1 = entry + d * 0.60 * e.height;
    const tp2 = entry + d * e.height;
    const q = rrNet(entry, sl, tp1);
    const conf = clamp(62 + (e.tf === '2h' ? 6 : 0) + clamp((e.height / entry * 100 - 1) * 4, 0, 10), 40, 92);
    const info = {
      retest: true, tf: e.tf, line: rp(line), distPct: +dist.toFixed(2), height: rp(e.height), mid: rp(e.mid),
      breakoutAgeMin: Math.round((now - e.breakoutAt) / M1), netRR: q.net, riskPct: q.risk, slPct: +slPct.toFixed(2), lines: e.lines
    };
    const okAdd = addSignal({
      module: 'LT', symbol: e.sym, dir: e.dir,
      entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false,
      conf, retest: true, info
    });
    e.lastAlertAt = now; saveLTR();
    log('LT RETEST: ' + e.base + ' ' + e.dir + ' | çizgi ' + fmtP(line) + ' | fiyat ' + fmtP(px) + ' | mesafe %' + dist.toFixed(2) + ' | ' + e.tf + (okAdd ? '' : ' (sinyal kaydı engellendi)'));
  }
}

function emaScore(cs) {
  if (!cs || cs.length < 60) return null;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cl.length - 1;
  return ((cl[m] > e50[m] ? 1 : 0) + (e20[m] > e50[m] ? 1 : 0) + (e50[m] > e50[m - 6] ? 1 : 0) + (cl[m] > e20[m] ? 1 : 0)) / 4;
}
const chgScore = c => (c == null || !isFinite(c) ? null : clamp(0.5 + c / 8, 0, 1));
async function marketCycle() {
  const emaS = [], chgS = [];
  for (const [key, sym] of [['btc', 'BTC/USDT:USDT'], ['eth', 'ETH/USDT:USDT']]) {
    const tk = TICK[sym], chg = tk && tk.percentage != null ? Number(tk.percentage) : null;
    if (tk) market[key] = { price: tk.last, change: chg != null ? +chg.toFixed(2) : null };
    const r1 = await getC(sym, '1h', 120), r4 = await getC(sym, '4h', 120);
    const a = r1 ? emaScore(closed(r1, H1)) : null, b = r4 ? emaScore(closed(r4, H4)) : null;
    if (a != null) emaS.push(a);
    if (b != null) emaS.push(b);
    const cs = chgScore(chg);
    if (cs != null) chgS.push(cs);
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
function fngText(v) {
  if (v <= 25) return 'Aşırı korku: Herkes satıyor. Tarihsel dipler böyle dönemlerde oluşur ama düşüş sürebilir.';
  if (v <= 45) return 'Korku: Piyasa temkinli. Yükseliş sinyallerini teyit et.';
  if (v <= 55) return 'Nötr: Ne korku ne hırs. Yön belirsiz.';
  if (v <= 75) return 'Hırs: Alıcılar iştahlı. Geri çekilmeye hazırlıklı ol.';
  return 'Aşırı hırs: Düzeltme riski yüksek, yeni LONG açarken çok temkinli ol.';
}
async function radarCycle() {
  const R = { updatedAt: Date.now() };
  try { const j = await fetchJSON('https://api.alternative.me/fng/?limit=1'); const v = parseInt(j.data[0].value, 10); R.fng = { value: v, label: j.data[0].value_classification, text: fngText(v) }; } catch (e) { R.fng = null; }
  const rs = { 1: [], 4: [] }, named = {};
  const syms = ['BTC/USDT:USDT', 'ETH/USDT:USDT'].concat(TOP.slice(0, 30));
  await pool(syms, 6, async (sym, i) => {
    const a = await getC(sym, '1h', 100), b = await getC(sym, '4h', 100);
    const r1 = a ? rsiLast(closes(closed(a, H1))) : null, r4 = b ? rsiLast(closes(closed(b, H4))) : null;
    if (r1 != null) rs[1].push(r1);
    if (r4 != null) rs[4].push(r4);
    if (i === 0) named.btc = [r1, r4];
    if (i === 1) named.eth = [r1, r4];
  });
  const f = x => (x == null ? null : +x.toFixed(1));
  const a1 = avg(rs[1]), a4 = avg(rs[4]);
  R.rsi = { btc1h: f(named.btc && named.btc[0]), btc4h: f(named.btc && named.btc[1]), eth1h: f(named.eth && named.eth[0]), eth4h: f(named.eth && named.eth[1]), avg1h: f(a1), avg4h: f(a4) };
  R.rsi.text = a1 >= 70 ? 'RSI yüksek: kısa vadede aşırı alım.' : a1 <= 30 ? 'RSI düşük: aşırı satım.' : 'RSI normal.';
  try {
    const j = await fetchJSON('https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=BTCUSDT&period=1h');
    const d = j && j.data, row = Array.isArray(d) ? d[d.length - 1] : d;
    const lr = parseFloat(row && (row.longAccountRatio || row.longRatio)), sr = parseFloat(row && (row.shortAccountRatio || row.shortRatio));
    if (!isFinite(lr) || !isFinite(sr) || lr + sr <= 0) throw new Error('veri yok');
    R.ls = { long: +(lr / (lr + sr) * 100).toFixed(1), short: +(sr / (lr + sr) * 100).toFixed(1), source: 'Bitget' };
  } catch (e) {
    R.ls = { long: +(market.breadth * 100).toFixed(1), short: +((1 - market.breadth) * 100).toFixed(1), source: 'Tahmini' };
  }
  R.ls.ratio = R.ls.short > 0 ? +(R.ls.long / R.ls.short).toFixed(2) : null;
  R.ls.label = 'Long/Short hesap oranı (fiyat yönü değildir)';
  const crowd = R.ls.long >= 60 ? 'Çoğunluk LONG.' : R.ls.long <= 40 ? 'Çoğunluk SHORT.' : 'Dengeli.';
  R.ls.text = crowd;
  radar = R;
}

function statsByModule() {
  const rows = [];
  let T = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, reasons: {} };
  Object.keys(MODS).forEach(k => {
    const all = signals.filter(s => s.module === k), cl = all.filter(s => s.status === 'KAPALI' && s.result !== 'DOLMADI');
    const unfilled = all.filter(s => s.result === 'DOLMADI').length;
    const wins = cl.filter(s => s.netR > 0).length, losses = cl.length - wins;
    const reasons = {};
    cl.forEach(s => { const r = s.result || '?'; reasons[r] = (reasons[r] || 0) + 1; T.reasons[r] = (T.reasons[r] || 0) + 1; });
    const row = { module: k, label: MODS[k].label, enabled: !!MODS[k].enabled, total: all.length, open: all.filter(s => s.status !== 'KAPALI').length, unfilled, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, grossR: +cl.reduce((a, s) => a + (s.grossR || 0), 0).toFixed(2), netR: +cl.reduce((a, s) => a + (s.netR || 0), 0).toFixed(2), reasons };
    rows.push(row);
    T.total += row.total; T.open += row.open; T.wins += wins; T.losses += losses; T.grossR += row.grossR; T.netR += row.netR;
  });
  const c = T.wins + T.losses;
  T.winRate = c ? +(T.wins / c * 100).toFixed(1) : 0; T.grossR = +T.grossR.toFixed(2); T.netR = +T.netR.toFixed(2);
  rows.push(T);
  return rows;
}

const BT = {
  PUMP:    { tf: '1m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m1.hold / 60), detect: w => detectBurst(w, M1, null), pump: true },
  PUMP3:   { tf: '3m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m3.hold / 180), detect: w => detectBurst(w, M3, null), pump: true },
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
    if (cfg.pump) {
      const atrPct = det.info && det.info.atr && det.entry > 0 ? det.info.atr / det.entry * 100 : (det.atrPct > 0 ? det.atrPct : 0.55);
      t.atrPct = atrPct;
      t.quickTpPct = quickTpOf(atrPct);
      t.quickTimeSec = t.quickTpPct != null ? EX.QUICK_TIME : null;
      t.quickArmPct = t.quickTpPct != null ? EX.QUICK_ARM : null;
    }
    const maxBars = det.maxBars > 0 ? det.maxBars : cfg.maxBars;
    let exit = null, reason = 'SURE', k = Math.min(cs.length - 1, i + maxBars);
    for (let j = i + 1; j <= k; j++) {
      const c = cs[j];
      if (cfg.pump && t.quickTpPct != null) {
        const d = t.dir === 'LONG' ? 1 : -1;
        const slHit = d > 0 ? c.l <= t.curSl : c.h >= t.curSl;
        if (slHit) { exit = t.curSl; reason = 'SL'; k = j; break; }
        const qp = t.entry * (1 + d * t.quickTpPct / 100);
        if (d > 0 ? c.h >= qp : c.l <= qp) { exit = qp; reason = 'QUICK'; k = j; break; }
      }
      const r = stepTrade(t, c);
      if (r && r.done) { exit = r.price; reason = cfg.pump && r.reason === 'TP1' ? 'TPMAX' : r.reason; k = j; break; }
      if (cfg.pump) {
        pumpPeak(t, t.dir === 'LONG' ? c.h : c.l);
        if (t.quickTpPct != null) {
          const age = (j - i) * ms, d = t.dir === 'LONG' ? 1 : -1;
          const pnl = (c.c / t.entry - 1) * d * 100;
          const qt = (t.quickTimeSec || EX.QUICK_TIME) * 1000;
          if (age >= qt - 1 && pnl < (t.quickArmPct || EX.QUICK_ARM) - 1e-9) {
            exit = ms > qt ? c.o + (c.c - c.o) * (qt / ms) : c.c;
            reason = 'QUICK_TIME'; k = j; break;
          }
        }
        const dec = pumpDecide(t, c.c, (j - i) * ms);
        if (dec) {
          const at = dec === 'NOMOVE' ? EX.NO_MOVE * 1000 : (dec === 'QUICK_TIME' ? (t.quickTimeSec || EX.QUICK_TIME) * 1000 : 0);
          exit = at > 0 && ms > at ? c.o + (c.c - c.o) * (at / ms) : c.c;
          reason = dec; k = j; break;
        }
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
  const baseCfg = (mod === 'PUMP' && tf === '3m') ? BT.PUMP3 : BT[mod];
  const syms = TOP.slice(0, coins), trades = [];
  let tMin = Infinity, tMax = 0, done = 0, used = 0;
  const btc = await fetchHistory('BTC/USDT:USDT', '1h', Math.min(2400, Math.ceil(BT_TOTAL[tf] * ms / H1) + 60));
  const dirBy = new Map();
  if (btc.length > 60) { const e50 = emaArr(closes(btc), 50); btc.forEach((c, i) => dirBy.set(c.t, c.c > e50[i] ? 'LONG' : 'SHORT')); }
  const refDir = t => dirBy.get(Math.floor(t / H1) * H1 - H1);
  for (const sym of syms) {
    try {
      let cfg = baseCfg;
      if (mod === 'DAILY') {
        const d1 = await fetchHistory(sym, '1d', BT_TOTAL['1d']);
        const dm = buildDailyMap(d1);
        cfg = Object.assign({}, BT.DAILY, { detect: w => { const lv = dm.get(dayKeyOf(w[w.length - 1].t)); return lv ? detectDailySweep(w, lv) : null; } });
      }
      const cs = await fetchHistory(sym, tf, BT_TOTAL[tf]);
      if (cs.length >= cfg.warm + 30) {
        used++; tMin = Math.min(tMin, cs[0].t); tMax = Math.max(tMax, cs[cs.length - 1].t);
        btCoin(cs, cfg, refDir, ms).forEach(x => trades.push(Object.assign({ sym: baseOf(sym) }, x)));
      }
    } catch (e) { /* atla */ }
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
    module: mod, label: MODS[mod].label, tf, coins: used, trades: ft.length, rawTrades: trades.length, reasons,
    all: btStats(ft.map(x => x.net)), raw: btStats(trades.map(x => x.net)), train: btStats(train), valid: btStats(valid),
    curve, splitIdx: Math.floor(train.length / step),
    aligned: btStats(trades.filter(x => x.aligned).map(x => x.net)), counter: btStats(trades.filter(x => !x.aligned).map(x => x.net)),
    note: 'v77.1: Net R maliyetlidir (H=%' + COST_PCT + '). Backtest kapanmış mumlarda çalışır; canlı AlgoPump ignition kullanır.'
  };
  job.status = 'bitti';
}

const STRATEGIES = [
  { module: 'TREND', name: 'Trend (PSAR)', tf: '5m', desc: 'Parabolic SAR dönüşü + Williams %R + EMA34 + ADX > ' + PSAR.adxMin + ' + hacim ≥ ' + PSAR.minVolX + 'x. Risk > %' + PSAR.maxRiskPct + ' ise sinyal yok. Kısa vade.', params: 'SL yeni PSAR (1.2–2.5 ATR bandı), TP1 ' + PSAR.tp1R + 'R, TP2 ' + PSAR.tp2R + 'R.' },
  { module: 'SCALPER', name: 'Scalper (SMC/BOS)', tf: '15m', desc: 'Swing kırılımı + hacim ≥ ' + SCALP.minVolX + 'x.', params: 'SL 0.5 ATR, TP1 ' + SCALP.tp1R + 'R, TP2 ' + SCALP.tp2R + 'R.' },
  { module: 'LT', name: 'LT Üçgen', tf: '2h + 4h (1d teyit)', desc: 'Üçgen kırılımı (hacim > 1.2x) ve kırılım sonrası retest. AI yorumu vardır; otomatik açılmaz.', params: 'TP1 üçgenin %60, TP2 %100; retest girişi çizgi, SL çizgi ±max(%0.5, 0.5×ATR).' },
  { module: 'DAILY', name: 'Günlük Sweep', tf: '15m', desc: 'PDH/PDL fitille süpürme + içeri kapanış. Fitil ≥ ' + DAILY.minWickAtr + ' ATR, hacim ≥ ' + DAILY.minVolX + 'x. Seans 00:00–23:00 UTC.', params: 'SL süpürme ucu ±' + DAILY.stopAtr + ' ATR. TP1 gün ortası veya ' + DAILY.tp1R + 'R; TP2 ' + DAILY.tp2R + 'R.' },
  { module: 'ZONE', name: 'Zone Master', tf: '1h + 4h bölge', desc: 'Pivot kümeleme + onay mumu + trend yönü.', params: 'SL bölge dışı 0.3×ATR, TP1 1.5R.' },
  { module: 'RANGE', name: 'Range (Mean Reversion)', tf: '15m', desc: 'Bollinger dışı reddedilme + fitil. ADX < ' + REVERT.adxMax + '.', params: 'SL fitil ucunun ' + REVERT.stopAtr + ' ATR ötesi, TP1 orta bant.' },
  { module: 'PUMP', name: 'AlgoPump', tf: 'ignition (15 sn sentetik)', desc: 'Coil kırılımı (≤ %' + PUMP.coilMaxPct + ') + gövde ≥ %' + Math.round(PUMP.bodyMin * 100) + ' + hacim ≥ ' + PUMP.vel.minVolRatio + 'x + z ≥ ' + PUMP.vel.minZ + ' + OI düşmüyor. AI KARAR + PLAN üretir; OTOMATİK İŞLEM YOK. Operatör /api/signal/:id/execute ile açar.', params: 'SL = max(%' + PUMP.vel.slMin + ', ' + (PUMP.vel.slAtrK * 100) + '×ATR, ' + PUMP.vel.slCostK + '×H), tavan %' + PUMP.vel.slMax + '. TP = clamp(' + EX.TP_ATR_K + '×ATR%, %' + EX.TP_MIN + ', %' + EX.TP_MAX + '). AI plan: TP %0.30–1.20, SL %0.50–1.30, süre 20–120 sn. Vur-kaç 20 sn içinde +%' + EX.QUICK_ARM + ' yoksa çık.' }
];

const app = express();
app.use(express.json({ limit: '100kb' }));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { log('API HATA ' + req.path + ': ' + e.message); res.status(500).json({ error: e.message }); });
function view(s) {
  const px = priceOf(s.symbol), d = s.dir === 'LONG' ? 1 : -1;
  const v = Object.assign({}, s, {
    modLabel: MODS[s.module].label, livePrice: px || null,
    livePct: px && isOpenSignal(s) ? +(((px / s.entry - 1) * d) * 100).toFixed(3) : null
  });
  if (s.status === 'ONAY_BEKLIYOR' && s.approvalExpiresAt) v.approvalRemainingMs = Math.max(0, s.approvalExpiresAt - Date.now());
  return v;
}
function paperView(p) {
  if (p.status === 'KAPALI') return p;
  const px = priceOf(p.symbol) || p.entry, r = paperPnl(p, px);
  return Object.assign({}, p, { livePrice: px, livePnl: +r.pnl.toFixed(2), livePnlPct: +r.pct.toFixed(2), ageMs: Date.now() - p.openedAt });
}
const PLACEHOLDER = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>AlphaSon ' + VERSION + '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;background:#0b1220;color:#e5e7eb;padding:2rem"><h2>AlphaSon ' + VERSION + '</h2><p>Backend çalışıyor. <code>index.html</code> dosyasını server.js ile aynı klasöre koyun.</p><p><a style="color:#60a5fa" href="/api/state">/api/state</a></p></body></html>';
app.get('/', (req, res) => {
  let html = PLACEHOLDER;
  try { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) html = fs.readFileSync(p, 'utf8'); } catch (e) { /* placeholder */ }
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, liveReady: IS_LIVE_READY }));
app.get('/api/state', h((req, res) => {
  const act = signals.filter(isOpenSignal), byMod = {}, pending = signals.filter(s => s.status === 'AI_BEKLIYOR'), pendingApproval = signals.filter(s => s.status === 'ONAY_BEKLIYOR');
  Object.keys(MODS).forEach(k => { byMod[k] = act.filter(s => s.module === k).length; });
  res.json({ version: VERSION, now: Date.now(), uptime: Math.round(process.uptime()), market, settings, counts: { active: act.length, pendingAI: pending.length, pendingApproval: pendingApproval.length, byModule: byMod }, scan: { universe: TOP.length, all: ALL.length, excluded: stats.excluded, apiErr: stats.apiErr, tickAt: stats.tickAt }, blocks: BLK, paper: paperSummary(), modules: MODS, activeModules: Object.keys(MODS).filter(k => MODS[k].enabled), passiveModules: Object.keys(MODS).filter(k => !MODS[k].enabled), daily: { levels: Array.from(DAILY_LEVELS.values()).slice(0, 40), watch: WATCH.daily.length }, ai: aiStatus(), ready: TOP.length > 0, liveReady: IS_LIVE_READY, realBal, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE } });
}));
app.get('/api/signals', h((req, res) => {
  let l = signals;
  if (req.query.module) l = l.filter(s => s.module === String(req.query.module).toUpperCase());
  if (req.query.status) l = l.filter(s => s.status === String(req.query.status).toUpperCase());
  const act = l.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt);
  const cl = l.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, Number(req.query.closed) || 60);
  res.json({ active: act.map(view), closed: cl.map(view) });
}));
app.get('/api/chart/:id', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Sinyal bulunamadı' });
  let tf = MODS[s.module].chartTf, raw;
  if (s.module === 'LT' && s.info && s.info.tf === '2h') { tf = '2h'; const r1 = await getC(s.symbol, '1h', 300, 20000); raw = r1 ? aggTF(r1, 120).slice(-150) : null; }
  else raw = await getC(s.symbol, tf, 150, 20000);
  const cs = raw || [], cl = closes(cs);
  res.json({ signal: view(s), tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]), ema20: emaArr(cl, 20).map(rp), ema50: emaArr(cl, 50).map(rp), tradingview: 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P' });
}));
app.post('/api/signal/:id/close', h((req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Sinyal bulunamadı' });
  if (!isOpenSignal(s)) return res.status(400).json({ error: 'Sinyal zaten kapalı' });
  closeSignal(s, priceOf(s.symbol) || s.entry, 'MANUEL');
  res.json({ ok: true, signal: view(s) });
}));
/* v77.1 — OPERATÖR ONAYI: AI planı onaylandıktan sonra işlemi açar. */
app.post('/api/signal/:id/execute', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Sinyal bulunamadı' });
  if (s.module !== 'PUMP') return res.status(400).json({ error: 'Sadece AlgoPump sinyalleri icra edilebilir' });
  if (s.status !== 'ONAY_BEKLIYOR') return res.status(400).json({ error: 'Sinyal onay beklemiyor (statü: ' + s.status + ')' });
  if (s.approvalExpiresAt && Date.now() > s.approvalExpiresAt) {
    s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = Date.now(); dirty = true;
    return res.status(400).json({ error: 'Onay süresi doldu' });
  }
  if (!settings.auto) return res.status(400).json({ error: 'Oto-trade anahtarı kapalı. Ayarlar > Oto-trade açın.' });
  const liveEntry = entryPx(s.symbol);
  if (!(liveEntry > 0)) return res.status(400).json({ error: 'Güncel fiyat alınamadı' });
  const drift = Math.abs(liveEntry / s.entry - 1) * 100;
  if (drift > AI.pumpEntryDriftPct * 2) {
    s.status = 'KAPALI'; s.result = 'AI_STALE'; s.closedAt = Date.now(); dirty = true;
    return res.status(400).json({ error: 'Fiyat %' + drift.toFixed(3) + ' değişti, sinyal geçersiz' });
  }
  if (drift > 0.01) {
    const d = s.dir === 'LONG' ? 1 : -1;
    const stopPct = Math.abs(s.entry - s.sl) / s.entry * 100;
    const tpPct = Math.abs(s.tp1 - s.entry) / s.entry * 100;
    s.entry = rp(liveEntry);
    s.sl = rp(liveEntry * (1 - d * stopPct / 100));
    s.curSl = s.sl;
    s.tp1 = rp(liveEntry * (1 + d * tpPct / 100));
  }
  s.status = 'AKTIF';
  s.startedAt = Date.now();
  dirty = true;
  log('ALGOPUMP ONAY (operatör): ' + s.base + ' ' + s.dir + ' | icra ediliyor');
  try { await maybeOpenPaper(s); }
  catch (e) { log('HATA execute: ' + e.message); }
  res.json({ ok: true, signal: view(s), paper: paperSummary() });
}));
app.get('/api/paper', h((req, res) => res.json({ settings, summary: paperSummary(), open: paper.open.map(paperView), closed: paper.closed.slice(0, 50), limits: { maxOpen: settings.maxOpen, sectorLimit: 0, dailyLoss: settings.dailyLossPct / 100, dailyLossPct: settings.dailyLossPct, slippage: PAPER_SLIP } })));
app.post('/api/paper/settings', h((req, res) => {
  const b = req.body || {};
  const merged = Object.assign({}, settings, b);
  if (b.auto === undefined) merged.auto = settings.auto;
  settings = sanitizeSettings(merged);
  saveSettings();
  log('AYARLAR: oto-trade ' + (settings.auto ? 'AÇIK' : 'KAPALI') + ' | margin ' + settings.margin + ' | ' + settings.leverage + 'x | risk %' + settings.riskPct + ' | min güven ' + settings.minConf + ' | max ' + settings.maxMinutes + ' dk');
  res.json({ ok: true, settings });
}));
app.post('/api/paper/toggle', h((req, res) => {
  settings.auto = req.body && req.body.auto !== undefined ? !!req.body.auto : !settings.auto;
  if (settings.auto) { paper.dayKey = ''; checkDailyLoss(); }
  saveSettings();
  log('OTO-TRADE ' + (settings.auto ? 'AÇILDI' : 'KAPATILDI'));
  res.json({ ok: true, settings });
}));
app.post('/api/paper/:id/close', h(async (req, res) => {
  const p = paper.open.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Açık işlem bulunamadı' });
  const ok = await closePaper(p, exitPx(p) || priceOf(p.symbol) || p.entry, 'MANUEL');
  if (!ok) return res.status(500).json({ error: 'Kapatılamadı' });
  res.json({ ok: true, paper: p });
}));
app.post('/api/trade/mode', h(async (req, res) => {
  const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper';
  if (mode === 'live') {
    if (!IS_LIVE_READY) return res.status(400).json({ error: 'API anahtarları eksik!' });
    await fetchRealBalance();
    if (!(realBal.total > 0)) return res.status(400).json({ error: 'Bitget bakiyesi okunamadı' });
    if (!(settings.dailyLossPct > 0)) { settings.dailyLossPct = 3; log('LIVE: günlük zarar limiti zorunlu → %3'); }
    paper.liveDayStart = realBal.total; paper.liveDayPnl = 0; paper.dayKey = new Date().toISOString().slice(0, 10);
  }
  settings.tradeMode = mode;
  saveSettings();
  log('İŞLEM MODU: ' + mode.toUpperCase());
  res.json({ ok: true, settings, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE } });
}));
app.post('/api/paper/reset', h((req, res) => {
  const lives = paper.open.filter(p => p.isLive);
  paper = { seq: paper.seq, balance: START_BALANCE, startBalance: START_BALANCE, open: lives, closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: paper.liveDayPnl || 0, liveDayStart: paper.liveDayStart || 0 };
  dirty = true;
  res.json({ ok: true });
}));
app.get('/api/watch/:kind', h((req, res) => res.json({ items: WATCH[req.params.kind] || [] })));
app.get('/api/radar', h((req, res) => res.json({ radar, market })));
app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: COST_PCT })));
app.get('/api/dataset', h((req, res) => {
  const rows = signals.filter(s => s.status === 'KAPALI' && s.result !== 'DOLMADI' && s.exit != null).map(s => {
    const R = calcR(s, s.exit);
    const f = s.info || {};
    return { id: s.id, module: s.module, dir: s.dir, conf: s.conf, marketAlign: s.marketAlign, counter: !!s.counter, createdAt: s.createdAt, closedAt: s.closedAt, reason: s.result, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, grossR: +R.gross.toFixed(4), netR: +R.net.toFixed(4), adx: f.adx, williamsR: f.williamsR, volRatio: f.volRatio, atrPct: f.atrPct, riskPct: f.riskPct, netRR: f.netRR, latePct: f.latePct, z: f.z, vBurst: f.vBurst, spreadPct: f.spreadPct, oi1: f.oi1, oi5: f.oi5, expectedLeg: f.expectedLeg, tf: f.tf };
  });
  res.json({ n: rows.length, costPct: COST_PCT, rows });
}));
app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: STRATEGIES.map(s => Object.assign({}, s, { active: !!MODS[s.module].enabled })), limits: { perModule: Object.keys(MODS).reduce((o, k) => { o[k] = MODS[k].max; return o; }, {}) } })));
app.get('/api/ai/status', h((req, res) => {
  const st = aiStatus();
  st.recent = signals.filter(s => s.ai && !s.ai.error).slice(-15).reverse().map(s => ({ id: s.id, module: s.module, base: s.base, dir: s.dir, verdict: s.ai.verdict, trust: s.ai.trust, score: s.ai.score, summary: s.ai.summary, reason: s.ai.reason, provider: s.ai.providerName, model: s.ai.model, at: s.ai.at, latencyMs: s.ai.latencyMs }));
  res.json(st);
}));
app.get('/api/ai/brief', h((req, res) => res.json({ brief: marketBrief, status: aiStatus() })));
app.post('/api/ai/brief', h(async (req, res) => {
  if (!aiReady()) return res.status(400).json({ error: 'AI anahtarı yok veya AI kapalı.', status: aiStatus() });
  const b = await aiMarketBrief(true);
  if (!b) return res.status(429).json({ error: aiUsage.lastError || 'Brifing üretilemedi.', status: aiStatus() });
  res.json({ ok: true, brief: b, status: aiStatus() });
}));
/* v77.1 — AI cooldown sıfırlama. Env değiştirdikten sonra beklemek zorunda kalmadan tekrar denemek için. */
app.post('/api/ai/reset', h((req, res) => {
  const target = (req.body && req.body.provider) ? String(req.body.provider).toLowerCase() : null;
  const cleared = [];
  for (const p of AI.providers) {
    if (target && p.id !== target) continue;
    p.cooldownUntil = 0;
    p.modelCooldowns = {};
    p.lastError = null;
    cleared.push(p.id);
  }
  aiUsage.lastError = null;
  saveAI();
  log('AI SIFIRLANDI: ' + (cleared.length ? cleared.join(', ') : 'eşleşen sağlayıcı yok'));
  res.json({ ok: true, cleared, providers: AI.providers.map(aiProviderView) });
}));
app.post('/api/ai/toggle', h((req, res) => {
  settings.aiEnabled = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !settings.aiEnabled;
  saveSettings();
  log('AI ' + (settings.aiEnabled ? 'AÇILDI' : 'KAPATILDI'));
  res.json({ ok: true, ai: aiStatus() });
}));
app.post('/api/signal/:id/ai', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Sinyal bulunamadı' });
  if (!AI.modules.includes(s.module)) return res.status(400).json({ error: 'AI yalnızca PUMP/LT/DAILY sinyallerini inceler.' });
  if (!aiReady()) return res.status(400).json({ error: settings.aiEnabled === false ? 'AI kapalı.' : 'AI anahtarı yok.', signal: view(s), ai: s.ai || null });
  const ai = await aiReview(s, { force: true });
  if (!ai || ai.error) return res.status(429).json({ error: (ai && ai.error) || 'AI yanıtı alınamadı', signal: view(s), ai: s.ai || null });
  res.json({ ok: true, ai, signal: view(s), status: aiStatus() });
}));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.post('/api/backtest', h((req, res) => {
  const b = req.body || {}, mod = String(b.module || '').toUpperCase();
  if (!BT[mod]) return res.status(400).json({ error: 'Geçersiz modül' });
  const tf = BT_TOTAL[b.tf] ? b.tf : BT[mod].tf;
  const effTf = mod === 'PUMP' ? (b.tf === '3m' ? '3m' : '1m') : (mod === 'TREND' || mod === 'SCALPER' || mod === 'RANGE' || mod === 'DAILY') ? BT[mod].tf : tf;
  const coins = clamp(parseInt(b.coins, 10) || 10, 1, 40);
  if (!TOP.length) return res.status(503).json({ error: 'Sistem henüz hazır değil' });
  if (Object.values(jobs).some(j => j.status === 'çalışıyor')) return res.status(429).json({ error: 'Başka bir backtest çalışıyor' });
  const id = 'B' + Date.now(), job = { id, status: 'çalışıyor', progress: 0, params: { module: mod, tf: effTf, coins }, startedAt: Date.now() };
  jobs[id] = job;
  log('BACKTEST başladı: ' + MODS[mod].label + ' ' + effTf + ' ' + coins + ' coin');
  runBacktest(job).catch(e => { job.status = 'hata'; job.error = e.message; log('BACKTEST HATA: ' + e.message); });
  res.json({ id });
}));
app.get('/api/backtest/:id', h((req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'İş bulunamadı' });
  res.json(j);
}));

/* ───────── BAŞLANGIÇ ───────── */
async function init() {
  if (!IS_LIVE_READY) log('UYARI: API anahtarları eksik. Yalnızca PAPER modda çalışabilir.');
  else log('API anahtarları yüklendi. CANLI moda geçmeye hazır (tavanlar: teminat ' + LIVE_MAX_MARGIN + ' USDT, kaldıraç ' + LIVE_MAX_LEVERAGE + 'x).');
  for (;;) {
    try { await ex.loadMarkets(); await refreshUniverse(); break; }
    catch (e) { log('HATA: Borsa verisi alınamadı (' + e.message + '), 15 sn sonra...'); await new Promise(r => setTimeout(r, 15000)); }
  }
  every('evren', 30 * M1, refreshUniverse, 30 * M1);
  every('piyasa', 2 * M1, marketCycle, 3000);
  every('realbal', 30000, fetchRealBalance, 5000);
  every('livesync', 10000, syncLive, 15000);
  every('ticker', 3000, refreshTickers, 0);
  every('armed', 30000, refreshArmed, 2500);
  every('atr', 30000, refreshAtr, 6000);
  every('levarm', 60000, refreshLeverageArms, 15000);
  every('pump', 500, pumpCycle, 1500);
  every('takip', 20000, trackerCycle, 8000);
  if (MODS.SCALPER.enabled) every('scalper', 60000, scanScalper, 12000);
  if (MODS.RANGE.enabled) every('range', 5 * M1, scanRange, 25000);
  if (MODS.ZONE.enabled) every('zone', 5 * M1, scanZone, 45000);
  if (MODS.TREND.enabled) every('trend', 60000, scanTrend, 20000);
  if (MODS.LT.enabled) { every('lt', 15 * M1, scanLT, 100000); every('ltretest', 60000, ltRetestCycle, 120000); }
  if (MODS.DAILY.enabled) { every('dailylev', 60 * M1, refreshDailyLevels, 30000); every('daily', DAILY.scanEvery, scanDaily, 90000); }
  every('radar', 5 * M1, radarCycle, 20000);
  every('aibrief', 30 * M1, maybeMarketBrief, 150000);
  every('kayit', 30000, async () => { saveAll(); }, 30000);
  every('pump-log', 5 * M1, async () => {
    const tot = signals.filter(s => s.module === 'PUMP').length;
    log('Pump taraması: ' + stats.pumpScanned + ' coin, ' + stats.pumpFound + ' sinyal, toplam ' + tot);
    const why = Object.keys(PWHY).sort((a, b) => PWHY[b] - PWHY[a]).map(k => k + ' ' + PWHY[k]).join(', ');
    if (why) log('Pump red: ' + why);
    Object.keys(PWHY).forEach(k => delete PWHY[k]);
    stats.pumpScanned = 0; stats.pumpFound = 0;
  }, 5 * M1);
  every('tarama-ozet', 10 * M1, async () => {
    const parts = Object.keys(SC).map(m => MODS[m].label + ' [' + Object.keys(SC[m]).map(k => k + ' ' + SC[m][k]).join(', ') + ']');
    log('Tarama özeti (10 dk): ' + (parts.join(' | ') || 'henüz tarama yok'));
    ['SWHY', 'TWHY', 'RWHY', 'DWHY'].forEach((n, i) => {
      const map = [SWHY, TWHY, RWHY, DWHY][i];
      const w = Object.keys(map).sort((a, b) => map[b] - map[a]).map(k => k + ' ' + map[k]).join(', ');
      if (w) log(n + ' red: ' + w);
      Object.keys(map).forEach(k => delete map[k]);
    });
    Object.keys(SC).forEach(k => delete SC[k]);
  }, 10 * M1);
  every('temizlik', 10 * M1, async () => {
    const now = Date.now();
    Object.keys(jobs).forEach(k => { if (now - jobs[k].startedAt > 30 * M1) delete jobs[k]; });
    prunePumpState(now);
  }, 10 * M1);
}
function start() {
  log('AlphaSon ' + VERSION + ' başlatılıyor...' + (ALLOW_TOKENIZED ? ' (tokenize varlıklar AÇIK)' : ''));
  const inv = assertInvariants();
  log('AlgoPump v77.1 maliyet: H=' + inv.H + '% | en kötü FADE neti +' + inv.worstFadeNet + '% | BE neti ' + inv.costCoverNet + '%');
  log('AlgoPump v77.1 taban: A >= %' + inv.minTradeableLegPct + ' (ATR >= %' + inv.minTradeableAtrPct + '/1m) | stop >= max(%' + EX.MIN_SL_PCT + ', %' + EX.SL_ATR_K + '×ATR, %' + (EX.SL_COST_K * EX.H) + ')');
  loadAll();
  log('v77.1 odak: LT Üçgen + AlgoPump (manuel onay) + Günlük Sweep | pasif: ' + Object.keys(MODS).filter(k => !MODS[k].enabled).map(k => MODS[k].label).join(', '));
  log('v77.1 AI: ' + (aiReady() ? 'HAZIR (' + aiKeys().length + ' sağlayıcı) | kapsam ' + AI.modules.join('+') + ' | kota ' + AI.maxPerDay + '/gün, ' + AI.maxPerHour + '/saat' : 'anahtar yok → yalnızca kural tabanlı analiz'));
  // Model listelerini logla (teşhis için)
  for (const p of AI.providers) {
    if (p.key) log('  AI ' + p.name + ': ' + (p.models || []).join(' → '));
  }
  log('v77.1 akış: MATEMATİK → SİNYAL → AI KARAR → OPERATÖR ONAYI → İŞLEM. Otomatik açma YOK.');
  log('v77.1 vur-kaç: TP %' + EX.QUICK_TP_MIN + '-' + EX.QUICK_TP_MAX + ' | süre ' + EX.QUICK_TIME + ' sn | pumpQuick ' + (settings.pumpQuick === false ? 'KAPALI' : 'AÇIK'));
  stream.start();
  app.listen(PORT, () => log('Sunucu hazır: port ' + PORT));
  init().catch(e => log('KRİTİK: init hatası ' + e.message));
}
process.on('uncaughtException', e => log('YAKALANMAMIŞ HATA: ' + (e && e.message)));
process.on('unhandledRejection', e => log('YAKALANMAMIŞ RED: ' + (e && e.message ? e.message : e)));
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { log('Kapanıyor...'); dirty = true; saveAll(); process.exit(0); }));

if (require.main === module) start();
module.exports = { btCoin, BT, analyzeTriangle, anchorLine, pivots, calcPSAR, williamsR, regimeOf, bandsOf, detectPSAR, detectBurst, detectScalper, detectRevert, detectRange, detectLT, detectZone, buildZones, pumpDecide, stepTrade, calcR, rrNet, isTokenized, VERSION, assertInvariants, pumpScanVel, ignition, entryGuard, microBars, atrPctFromCandles, pumpPeak, applyCostCover, velRatio, tpTarget, quickTpOf, setAtr, TICK, SNAP, RING, FLOW, ATRC, ARMED, market, EX, SCALP, REVERT, PSAR, zOf, qvBurst, volumeBurst, priorRunPct, OI, pushOI, oiChg, ingestTicker, DAILY, MODS, detectDailySweep, dailyWatch, buildDailyMap, dayKeyOf, analyzeSignal, analyzeMarket, AI, aiStatus, aiReview, aiMarketBrief, maybeMarketBrief, parseAIJSON, callProvider, buildAIContext, buildMarketContext, aiQuota, aiCount, getDailyLevels, scanDaily, DAILY_LEVELS, DWHY, WATCH, getMarketBrief: () => marketBrief, getAIUsage: () => aiUsage, LTR, ltRetestCycle, addSignal, getSignals: () => signals, getSettings: () => settings, setPumpQuick: v => { settings.pumpQuick = v !== false; } };
