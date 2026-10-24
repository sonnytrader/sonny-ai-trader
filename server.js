'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v83.0 — v82.0 (güvenlik/katılık) + v81 katmanı (ölçüm) TAM ENTEGRE
   ───────────────────────────────────────────────────────────────────────────
   AUTH YOK — tüm endpoint'ler açık.
   v81 katmanı tam: outcome ölçümü, state machine, rejection sınıflandırma,
   deterministik trigger, 2. sağlayıcı görüşü, AI inflight dedup.
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = 'v83.0';
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
const F_OPP = path.join(DATA_DIR, 'opportunities.json');
const F_OUT = path.join(DATA_DIR, 'outcomes.json');

const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || '';
const IS_LIVE_READY = !!(API_KEY && API_SECRET && API_PASS);
const LIVE_MAX_MARGIN = Number(process.env.LIVE_MAX_MARGIN) || 25;
const LIVE_MAX_LEVERAGE = Number(process.env.LIVE_MAX_LEVERAGE) || 5;
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };

/* TEK MALİYET */
const FEE_ROUNDTRIP = 0.20;
const PAPER_SLIP = 0.02;
const COST_TOTAL = FEE_ROUNDTRIP + PAPER_SLIP;
const COST_PCT = COST_TOTAL;

const START_BALANCE = 1000;
const M1 = 60000, M3 = 180000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '3m': 20000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend (Pullback)',  maxAge: 8 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: true },
  SCALPER: { label: 'Scalper',           maxAge: 4 * H1,  cooldown: 15 * M1, chartTf: '15m', enabled: false },
  LT:      { label: 'LT Üçgen',          maxAge: 5 * D1,  cooldown: 6 * H1,  chartTf: '4h',  enabled: true },
  ZONE:    { label: 'Zone Master',       maxAge: 12 * H1, cooldown: 30 * M1, chartTf: '1h',  enabled: false },
  RANGE:   { label: 'Range (Mean Rev.)', maxAge: 3 * H1,  cooldown: 30 * M1, chartTf: '15m', enabled: false },
  PUMP:    { label: 'AlgoScalp (3-5dk)', maxAge: 20 * M1, cooldown: 10 * M1, chartTf: '5m',  enabled: true },
  DAILY:   { label: 'Günlük Sweep',      maxAge: 6 * H1,  cooldown: 4 * H1,  chartTf: '15m', enabled: false, maxPerDaySym: 3 }
};
const REASON = {
  TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'TP1 sonrası başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel kapatma',
  TPMAX: 'Maksimum hedef', FADE: 'Kâr geri verildi', BAIL: 'Erken kaçış', NOMOVE: 'Hareket yok', MOMENTUM: 'İvme bitti',
  QUICK: 'Vur-kaç kârı', QUICK_TIME: 'Vur-kaç süresi doldu',
  AI_RED: 'AI giriş reddi', AI_ERROR: 'AI yanıtı yok', AI_TIMEOUT: 'AI onayı zaman aşımı', AI_STALE: 'AI sonrası fiyat değişti',
  APPROVAL_EXPIRED: 'Operatör onayı verilmedi', LATE_ENTRY: 'Geç giriş', NOT_CONFIRMED: 'Tetik teyit edilmedi'
};

const PUMP = {
  minQuoteVol: 400000, maxSpreadPct: 0.25, snapKeepMs: 360000,
  pre30: 0.30, pre60: 0.45, pre150: 0.80, maxCand: 10, recheckMs: 2000,
  barMs: 15000, coilBars: 10, coilMaxPct: 2.00, bodyMin: 0.35, dispMinPct: 0.07, minElapsedMs: 3000,
  m1: { minMovePct: 0.60, minVolX: 3.0, minAtrX: 2.2, maxMovePct: 4.5, hold: 120, noMove: 40 },
  m3: { minMovePct: 1.00, minVolX: 2.5, minAtrX: 2.2, maxMovePct: 6.5, hold: 180, noMove: 45 },
  posMin: 0.55, priorMaxFrac: 0.40, priorVolMax: 2.5, maxExt15Pct: 8,
  slBodyFrac: 0.5, slMin: 0.50, slMax: 1.30, tpMaxPct: 1.6,
  macroFilter: true, useCandlePath: false, useIgnition: process.env.PUMP_IGNITION === '1'
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
  H: FEE_ROUNDTRIP, MIN_NET: 0.10, GB_MIN: 0.30, GB_FRAC: 0.30,
  LOCK_ARM: 0.60, BE_ARM: 0.40, BE_LOCK: 0.22, BAIL_ARM: 0.35, BAIL_BELOW: -0.02,
  TP_MIN: 0.90, TP_MAX: 1.80, TP_ATR_K: 1.45, NO_MOVE: 40, HOLD: 120,
  DECAY_RATIO: 0.30, DECAY_MIN_PNL: 0.25, MIN_NET_RR: 1.05,
  VEL_WIN_MS: 2000, VEL_PEAK_MEMORY_MS: 12000,
  MIN_SL_PCT: 0.50, SL_ATR_K: 0.80, SL_COST_K: 2.50,
  QUICK_TP_K: 0.55, QUICK_TP_MIN: 0.40, QUICK_TP_MAX: 0.70,
  QUICK_TIME: 20, QUICK_ARM: 0.15, MOM_ARM: 0.28
};

const SCALP = { minVolX: 2.0, maxDistPct: 1.2, maxDistAtrK: 0.80, minRiskPct: 0.80, minNetRR: 1.0, minConf: 65, tp1R: 1.5, tp2R: 2.5, pivL: 3, pivR: 3, lookback: 70, minFlowRatio: 1.2 };
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

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sumA = a => a.reduce((s, x) => s + x, 0);
const rp = p => Number(Number(p).toPrecision(7));
const fmtP = p => (p >= 1 ? p.toFixed(4) : p.toPrecision(5));
const dayKeyOf = t => new Date(t).toISOString().slice(0, 10);
const toC = a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] || 0 });
const closed = (cs, tfMs) => (cs && cs.length && cs[cs.length - 1].t + tfMs > Date.now() ? cs.slice(0, -1) : cs || []);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJSON(f, def) { try { if (!fs.existsSync(f)) return def; const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : def; } catch (e) { log('UYARI: ' + path.basename(f) + ' (' + e.message + ')'); return def; } }
function saveJSON(f, obj) { try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); } catch (e) { log('HATA: ' + path.basename(f) + ' (' + e.message + ')'); } }
async function fetchJSON(url, ms) { const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms || 8000); try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(tm); } }
async function pool(items, n, fn) { const res = new Array(items.length); let i = 0; const w = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { res[k] = await fn(items[k], k); } catch (e) { res[k] = null; } } }); await Promise.all(w); return res; }
function every(name, ms, fn, delay) { let run = false; const tick = async () => { if (run) return; run = true; try { await fn(); } catch (e) { log('HATA [' + name + ']: ' + e.message); } finally { run = false; } }; setTimeout(() => { tick(); setInterval(tick, ms); }, delay || 0); }

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: STATE
   ═══════════════════════════════════════════════════════════════════════════ */
let dirtyV = false;
const RECENT_REJ = [];
const REJ_MAX = 300;
const REJ_COUNT = {};
const OPPS = new Map();
const OUT_OPEN = [];
let OUT_DONE = [];
const OUT_LAST = new Map();
const FLOWS = new Map();
const LT_AI = new Map();
const TR_AI = new Map();
const AI_INFLIGHT = new Set();
const AI_HISTORY = [];
const SW = new Map();
const WATCH_META = { lt: { at: 0 }, trend: { at: 0 }, scalp: { at: 0 } };

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: REJECTION CLASSIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */
const REJ_RULES = [
  [/fitil/i, 'WICK_AGAINST', 'Ters yönde fitil var'],
  [/spread/i, 'SPREAD_WIDE', 'Spread yüksek'],
  [/hacim/i, 'LOW_VOLUME', 'Hacim yetersiz'],
  [/stop uzak|net r:r|risk/i, 'RISK_REWARD', 'Risk/ödül yetersiz'],
  [/geç kalındı|uzak|uzamış|kaçtı|çekildi|geç/i, 'LATE_ENTRY', 'Fiyat çok ilerlemiş / giriş geç'],
  [/ters|uyumsuz|eğim/i, 'MARKET_CONFLICT', 'Piyasa veya üst zaman yönüyle uyumsuz'],
  [/eski|bayat|veri|bulunamadı|yanıt vermedi|zaman aşımı|kota/i, 'STALE_DATA', 'Veri eski, eksik veya erişilemedi'],
  [/kırılım|yakınlık|teyit/i, 'BREAKOUT_UNCONFIRMED', 'Kırılım teyidi yok'],
  [/formasyon|üçgen/i, 'PATTERN_INVALID', 'Formasyon geçersiz'],
  [/cooldown|limit|bekleme/i, 'COOLDOWN', 'Bekleme süresi / limit'],
  [/\bai\b|strateji/i, 'AI_UNCERTAIN', 'AI stratejiye uygun bulmadı'],
  [/gövde|momentum|adx|rsi|dönüş|geri çekilme|volatilite|ema/i, 'MOMENTUM_WEAK', 'Momentum / giriş koşulu zayıf']
];
const REJ_NEXT = {
  LOW_VOLUME: 'Hacim ortalamanın üstüne çıkınca yeniden değerlendirilir', BREAKOUT_UNCONFIRMED: 'Seviye üstünde/altında net mum kapanışı gelince',
  LATE_ENTRY: 'Geri çekilme veya yeni yapı oluşunca', SPREAD_WIDE: 'Spread daralınca', STALE_DATA: 'Veri akışı düzelince',
  MARKET_CONFLICT: 'Piyasa / üst zaman yönü uyumlanınca', RISK_REWARD: 'Stop-hedef oranı düzelince', WICK_AGAINST: 'Yeni mum temiz kapanınca',
  PATTERN_INVALID: 'Yeni formasyon oluşunca', COOLDOWN: 'Bekleme süresi dolunca', AI_UNCERTAIN: 'Veri anlamlı değişince AI yeniden sorulur',
  MOMENTUM_WEAK: 'Momentum / giriş şartı sağlanınca', RULE: 'Giriş şartları sağlanınca', AI_ERROR: 'AI sağlayıcı düzelince'
};
const REJ_NOISE = new Set(['üçgen yok', 'veri kısa', 'trend yönü yok', 'hareket yok', 'kırılım yok', 'gövde zayıf', 'volatilite düşük', 'hacim yok', 'geri çekilme yok', 'adx düşük']);
function classifyRej(reason) { const s = String(reason || ''); for (const [re, code, label] of REJ_RULES) if (re.test(s)) return { code, label }; return { code: 'RULE', label: 'Strateji giriş şartları sağlanmadı' }; }
function mergeWhy(dst, src) { for (const k in src) dst[k] = (dst[k] || 0) + src[k]; }
function logRej(mod, sym, reason, o) {
  o = o || {};
  const kind = o.kind || 'RULE';
  let cl = kind === 'AI_ERROR' ? { code: 'AI_ERROR', label: 'AI hatası / yanıt yok' } : classifyRej(reason);
  if (kind === 'AI_DECISION' && cl.code === 'RULE') cl = { code: 'AI_UNCERTAIN', label: 'AI stratejiye uygun bulmadı' };
  const now = Date.now(), key = mod + '|' + sym + '|' + cl.code + '|' + kind;
  REJ_COUNT[cl.code] = (REJ_COUNT[cl.code] || 0) + 1;
  const same = RECENT_REJ.find(r => r.key === key && now - r.lastAt < 30 * M1);
  if (same) { same.count++; same.lastAt = now; if (o.price) same.price = rp(o.price); return false; }
  const prev = RECENT_REJ.find(r => r.mod === mod && r.sym === sym);
  const px = o.price || priceOf(sym) || null;
  const e = {
    id: 'R' + now.toString(36) + Math.random().toString(36).slice(2, 5), key, at: now, lastAt: now, mod, sym, base: baseOf(sym),
    price: px ? rp(px) : null, kind, code: cl.code, label: cl.label, reason: String(reason || '').slice(0, 200),
    missing: o.missing || cl.label, next: o.next || REJ_NEXT[cl.code] || REJ_NEXT.RULE, ai: o.ai ? String(o.ai).slice(0, 240) : null,
    count: 1, prevCode: prev ? prev.code : null
  };
  RECENT_REJ.unshift(e);
  if (RECENT_REJ.length > REJ_MAX) RECENT_REJ.length = REJ_MAX;
  dirtyV = true;
  if (kind !== 'AI_ERROR') oppUpdate(mod, sym, null, 'REJECTED', e.price, cl.label, null);
  return true;
}
function logRejWhy(mod, sym, why, price) {
  const ks = Object.keys(why || {});
  if (!ks.length) return;
  const k = ks[0].replace(/^scalp:/, '');
  const gk = '_gate:' + mod + ':' + k;
  REJ_COUNT[gk] = (REJ_COUNT[gk] || 0) + 1;
  if (REJ_NOISE.has(k)) return;
  logRej(mod, sym, k, { price });
}
function logAIRej(mod, sym, det, price) {
  if (det && det.none) logRej(mod, sym, det.reason || 'AI: strateji uymuyor', { kind: 'AI_DECISION', price, ai: det.reason });
  else if (!det) logRej(mod, sym, 'AI yanıt vermedi (kota veya sağlayıcı)', { kind: 'AI_ERROR', price });
}
function ltCandTracked(sym, cs, tf) { const w1 = {}; const cand = ltCandidates(cs, null, tf, w1); mergeWhy(LWHY, w1); if (!cand) logRejWhy('LT', sym, w1, cs[cs.length - 1].c); return cand; }

/* v82 COMPAT wrapper */
function logRejSym(mod, sym, reason, info, phase, nextCond, aiVerdict) {
  logRej(mod, sym, reason, { kind: 'RULE', price: info && info.price, missing: nextCond, ai: aiVerdict });
}

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: STATE MACHINE
   ═══════════════════════════════════════════════════════════════════════════ */
const OPP_ACTIVE = ['DISCOVERED', 'WATCHING', 'PRE_BREAKOUT', 'TRIGGER_PENDING'];
function oppUpdate(mod, sym, dir, state, price, reason, ai) {
  const id = mod + '|' + sym, now = Date.now();
  let o = OPPS.get(id);
  if (!o) {
    o = { id, mod, sym, base: baseOf(sym), dir: dir || null, state: 'DISCOVERED', firstAt: now, updatedAt: now, price: price || null, hist: [{ t: now, from: null, to: 'DISCOVERED', price: price || null, reason: 'ilk tespit' }] };
    OPPS.set(id, o); dirtyV = true;
  }
  if (state === 'REJECTED' && o.state === 'CONFIRMED' && now - o.updatedAt < 6 * H1) return o;
  if (dir) o.dir = dir;
  if (price) o.price = rp(price);
  o.updatedAt = now;
  if (ai) o.ai = typeof ai === 'string' ? ai : (ai.summary || ai.reason || null);
  if (state && state !== o.state) {
    o.hist.push({ t: now, from: o.state, to: state, price: price ? rp(price) : null, reason: String(reason || '').slice(0, 160) });
    if (o.hist.length > 12) o.hist.shift();
    o.state = state; dirtyV = true;
  }
  return o;
}
function oppPrune() {
  const now = Date.now();
  for (const [id, o] of Array.from(OPPS)) {
    const age = now - o.updatedAt;
    if (OPP_ACTIVE.includes(o.state) && age > 6 * H1) { o.hist.push({ t: now, from: o.state, to: 'EXPIRED', price: o.price, reason: 'süre doldu' }); o.state = 'EXPIRED'; dirtyV = true; }
    else if (age > 24 * H1) { OPPS.delete(id); dirtyV = true; }
  }
  if (OPPS.size > 250) { const arr = Array.from(OPPS.values()).sort((a, b) => a.updatedAt - b.updatedAt); for (let i = 0; i < arr.length - 250; i++) OPPS.delete(arr[i].id); }
}
function onSignalAdded(sig) {
  const o = oppUpdate(sig.module, sig.symbol, sig.dir, sig.status === 'AI_BEKLIYOR' ? 'TRIGGER_PENDING' : 'CONFIRMED', sig.entry, 'sinyal üretildi (' + sig.id + ')', sig.ai || null);
  o.sigId = sig.id;
  outRegister('SIGNAL', sig.module, sig.symbol, sig.dir, sig.entry, sig.id);
}

/* v82 COMPAT wrapper */
function setOpp(module, base, phase, reason, info) {
  const sym = (info && info.symbol) || (base + '/USDT:USDT');
  const dir = (info && info.dir) || null;
  const px = info && info.price;
  oppUpdate(module, sym, dir, phase, px, reason, null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: OUTCOMES
   ═══════════════════════════════════════════════════════════════════════════ */
const OUT_MARKS = [1, 3, 5, 15, 60];
function outRegister(kind, mod, sym, dir, price, sigId) {
  if (!dir || !(price > 0)) return;
  const k = kind + '|' + mod + '|' + sym + '|' + dir, now = Date.now();
  if (OUT_LAST.get(k) && now - OUT_LAST.get(k) < 15 * M1) return;
  OUT_LAST.set(k, now);
  if (OUT_LAST.size > 600) { for (const [kk, t] of Array.from(OUT_LAST)) if (now - t > 30 * M1) OUT_LAST.delete(kk); }
  if (OUT_OPEN.length >= 200) return;
  OUT_OPEN.push({ id: 'O' + now.toString(36) + Math.random().toString(36).slice(2, 4), kind, mod, sym, base: baseOf(sym), dir, p0: price, t0: now, marks: {}, mfe: 0, mae: 0, sigId: sigId || null, market: market.dir });
}
function outTick() {
  const now = Date.now();
  for (let i = OUT_OPEN.length - 1; i >= 0; i--) {
    const o = OUT_OPEN[i], px = priceOf(o.sym);
    if (!px) { if (now - o.t0 > 80 * M1) OUT_OPEN.splice(i, 1); continue; }
    const d = o.dir === 'LONG' ? 1 : -1, pct = (px / o.p0 - 1) * d * 100;
    if (pct > o.mfe) o.mfe = pct;
    if (pct < o.mae) o.mae = pct;
    for (const m of OUT_MARKS) if (o.marks[m] === undefined && now - o.t0 >= m * M1) o.marks[m] = +pct.toFixed(3);
    if (o.marks[60] !== undefined || now - o.t0 > 75 * M1) {
      const m15 = o.marks[15], m3 = o.marks[3];
      o.net15 = m15 !== undefined ? +(m15 - COST_TOTAL).toFixed(3) : null;
      o.mfe = +o.mfe.toFixed(3); o.mae = +o.mae.toFixed(3);
      o.timing = (m3 !== undefined && m3 <= -0.2 && m15 !== undefined && m15 > 0) ? 'ERKEN' : (o.mfe > 0.3 && m15 !== undefined && m15 < 0.25 * o.mfe) ? 'GEÇ' : 'ZAMANINDA';
      OUT_DONE.push(o); OUT_OPEN.splice(i, 1); dirtyV = true;
    }
  }
  if (OUT_DONE.length > 500) OUT_DONE = OUT_DONE.slice(-500);
}
function outStats() {
  const g = {};
  for (const o of OUT_DONE) { if (o.net15 == null) continue; (g[o.mod + '|' + o.kind + '|' + o.dir] = g[o.mod + '|' + o.kind + '|' + o.dir] || []).push(o); }
  return Object.keys(g).map(k => {
    const a = g[k], parts = k.split('|'), nets = a.map(x => x.net15), w = nets.filter(x => x > 0);
    const gw = sumA(w), gl = -sumA(nets.filter(x => x <= 0));
    let cum = 0, peak = 0, dd = 0;
    nets.forEach(x => { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); });
    return { mod: parts[0], kind: parts[1], dir: parts[2], n: a.length, winRate: +(w.length / a.length * 100).toFixed(1), avgNet15: +(sumA(nets) / a.length).toFixed(3), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), maxDD: +dd.toFixed(2), avgMFE: +(sumA(a.map(x => x.mfe)) / a.length).toFixed(3), avgMAE: +(sumA(a.map(x => x.mae)) / a.length).toFixed(3), sampleOk: a.length >= 30 };
  }).sort((a, b) => b.n - a.n);
}

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: PERSISTENCE
   ═══════════════════════════════════════════════════════════════════════════ */
function loadV81() {
  const r = loadJSON(F_REJ, { list: [] });
  if (Array.isArray(r.list)) r.list.slice(0, REJ_MAX).forEach(x => { if (x && x.key) RECENT_REJ.push(x); });
  const o = loadJSON(F_OPP, { list: [] });
  if (Array.isArray(o.list)) o.list.slice(-250).forEach(x => { if (x && x.id && Array.isArray(x.hist)) OPPS.set(x.id, x); });
  const u = loadJSON(F_OUT, { list: [] });
  if (Array.isArray(u.list)) OUT_DONE = u.list.slice(-500);
}
function saveV81() {
  if (!dirtyV) return;
  dirtyV = false;
  saveJSON(F_REJ, { list: RECENT_REJ.slice(0, REJ_MAX) });
  saveJSON(F_OPP, { list: Array.from(OPPS.values()).slice(-250) });
  saveJSON(F_OUT, { list: OUT_DONE.slice(-500) });
}

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: FLOWS
   ═══════════════════════════════════════════════════════════════════════════ */
function flowSideOnTrade(sym, ts, side, notional) {
  const s = String(side || '').toLowerCase();
  if ((s !== 'buy' && s !== 'sell') || !(notional > 0)) return;
  let f = FLOWS.get(sym);
  if (!f) { f = { b: Object.create(null), last: 0, n: 0 }; FLOWS.set(sym, f); }
  const k = Math.floor(ts / 1000) * 1000;
  const c = f.b[k] || (f.b[k] = { buy: 0, sell: 0, n: 0 });
  c[s] += notional; c.n++; f.n++;
  if (ts > f.last) f.last = ts;
  if ((f.n & 63) === 0) { const cut = ts - 130000; for (const kk of Object.keys(f.b)) if (Number(kk) < cut) delete f.b[kk]; }
}
function flowSummary(sym) {
  const f = FLOWS.get(sym), now = Date.now();
  if (!f || now - f.last > 20000) return null;
  const out = { semantics: 'taker yönü (trade.side; doğrulanmadı)', ageSec: Math.round((now - f.last) / 1000) };
  for (const w of [15, 30, 60]) {
    let b = 0, s = 0, n = 0;
    for (const kk of Object.keys(f.b)) { if (Number(kk) >= now - w * 1000) { b += f.b[kk].buy; s += f.b[kk].sell; n += f.b[kk].n; } }
    out['w' + w] = { buy: Math.round(b), sell: Math.round(s), net: Math.round(b - s), n };
  }
  return out;
}
function flowLine(sym) { const f = flowSummary(sym); if (!f) return '\nAgresif akış: VERİ YOK'; return '\nAgresif akış (taker yönü): 30s alış ' + f.w30.buy + ', satış ' + f.w30.sell + ', net ' + f.w30.net + ', n=' + f.w30.n; }
function wsFlowSubscribe() {
  const set = new Set(TOP.slice(0, 25));
  (WATCH.lt || []).slice(0, 10).forEach(r => set.add(r.symbol));
  Array.from(SW.values()).slice(0, 10).forEach(r => set.add(r.symbol));
  stream.setSymbols(Array.from(set));
}

/* ═══════════════════════════════════════════════════════════════════════════
   v81 KATMANI: AI EVALUATION
   ═══════════════════════════════════════════════════════════════════════════ */
const EV_DEC = ['WATCH', 'CANDIDATE', 'REJECT', 'INSUFFICIENT_DATA'];
const EV_PH = ['EARLY', 'PRE_BREAKOUT', 'TRIGGER_PENDING', 'CONFIRMED', 'LATE', 'INVALID', 'CONTINUATION', 'PULLBACK', 'EXHAUSTION', 'UNCLEAR'];
const pickEnum = (v, list, def) => { const x = String(v == null ? '' : v).toUpperCase().replace(/[\s-]+/g, '_'); return list.includes(x) ? x : def; };
const strArr = (a, n, len) => (Array.isArray(a) ? a.map(x => String(x).slice(0, len || 160)).filter(Boolean).slice(0, n || 4) : (typeof a === 'string' && a.trim() ? [a.slice(0, len || 160)] : []));
function normEval(j, mod, sym, hints) {
  j = j || {};
  const ev = {
    module: mod, symbol: sym, decision: pickEnum(j.decision, EV_DEC, 'WATCH'), direction: pickEnum(j.direction, ['LONG', 'SHORT', 'BOTH', 'NONE'], 'NONE'),
    phase: pickEnum(j.phase, EV_PH, 'UNCLEAR'), score: clamp(Math.round(Number(j.score) || 0), 0, 100), confidence: pickEnum(j.confidence, ['LOW', 'MEDIUM', 'HIGH'], 'LOW'),
    dataQuality: pickEnum(j.dataQuality, ['GOOD', 'PARTIAL', 'POOR'], 'PARTIAL'), lateEntry: j.lateEntry === true || j.lateEntry === 'true',
    triggerConfirmed: false, entryAllowed: false,
    evidence: strArr(j.evidence, 5), missingConditions: strArr(j.missingConditions, 4), risks: strArr(j.risks, 4),
    bullishScenario: String(j.bullishScenario || '').slice(0, 260), bearishScenario: String(j.bearishScenario || '').slice(0, 260),
    triggerCondition: String(j.triggerCondition || '').slice(0, 260), invalidationCondition: String(j.invalidationCondition || '').slice(0, 260),
    summary: String(j.summary || '').slice(0, 300), evaluatedAt: Date.now()
  };
  if (hints) {
    if (hints.lateEntry) ev.lateEntry = true;
    ev.triggerConfirmed = !!hints.triggerConfirmed;
    if (hints.dataQuality === 'POOR') ev.dataQuality = 'POOR';
    else if (hints.dataQuality === 'PARTIAL' && ev.dataQuality === 'GOOD') ev.dataQuality = 'PARTIAL';
    if (ev.dataQuality === 'POOR') { ev.confidence = 'LOW'; ev.score = Math.min(ev.score, 40); }
  }
  return ev;
}
const EV_SYS = 'Sen AlphaSon piyasa analiz asistanısın. Sana verilen ÖLÇÜLMÜŞ verilerle senaryo yazarsın. Yalnızca verilen sayıları kullan; verilmeyen OI, akış, hacim, destek/direnç değerini ASLA uydurma; eksikse dataQuality değerini PARTIAL veya POOR yap ve missingConditions içinde belirt. Giriş/stop/hedef fiyatı verme. Kısa, basit Türkçe yaz. Yalnızca JSON döndür.';
const EV_SCHEMA = '{"decision":"WATCH|CANDIDATE|REJECT|INSUFFICIENT_DATA","direction":"LONG|SHORT|BOTH|NONE","phase":"EARLY|PRE_BREAKOUT|TRIGGER_PENDING|CONFIRMED|LATE|INVALID|CONTINUATION|PULLBACK|EXHAUSTION|UNCLEAR","score":0,"confidence":"LOW|MEDIUM|HIGH","dataQuality":"GOOD|PARTIAL|POOR","lateEntry":false,"evidence":["somut veri"],"missingConditions":["eksik koşul"],"risks":["risk"],"bullishScenario":"kısa","bearishScenario":"kısa","triggerCondition":"ölçülebilir tetikleyici","invalidationCondition":"ölçülebilir geçersizlik","summary":"en fazla 2 kısa cümle"}';
function aiView(e, sig) {
  if (!e) return { status: aiReady() ? 'AI_BEKLENIYOR' : 'AI_KAPALI' };
  const ageMin = Math.round((Date.now() - e.at) / 60000);
  if (e.error) return { status: 'AI_HATASI', error: e.error, ageMin };
  const stale = ageMin > 60 || (sig && e.sig !== sig && ageMin > 8);
  return { status: stale ? 'DEGERLENDIRME_ESKI' : 'GUNCEL', ageMin, ev: e.ev, provider: e.providerName, model: e.model, ms: e.ms, second: e.second || null };
}
async function watchAIRun(kind, rows, cache, mkPrompt, max, second) {
  if (!aiReady()) return;
  const now = Date.now(), need = [];
  for (const r of rows) {
    const e = cache.get(r.key);
    if (!e) need.push(r);
    else if (e.error ? now - e.at > 10 * M1 : ((e.sig !== r.sig && now - e.at > 4 * M1) || now - e.at > 45 * M1)) need.push(r);
  }
  let done = 0;
  for (const r of need) {
    if (done >= max) break;
    const hk = 'W' + kind + '|' + Math.floor(Date.now() / H1);
    if ((AI_MOD_HOUR[hk] || 0) >= 40) break;
    AI_MOD_HOUR[hk] = (AI_MOD_HOUR[hk] || 0) + 1;
    const ik = kind + '|' + r.symbol;
    if (AI_INFLIGHT.has(ik)) continue;
    AI_INFLIGHT.add(ik);
    try {
      const res = await aiJSON(EV_SYS, mkPrompt(r), { timeoutMs: 22000 });
      const at = Date.now();
      if (res.error) { cache.set(r.key, { at, sig: r.sig, error: res.error }); done++; continue; }
      const ev = normEval(res.j, kind, r.symbol, { lateEntry: r.late, triggerConfirmed: r.triggerConfirmed, dataQuality: r.dataQuality });
      const ent = { at, sig: r.sig, ev, provider: res.provider, providerName: res.providerName, model: res.model, ms: res.ms };
      if (second && ev.confidence === 'LOW' && ['PRE_BREAKOUT', 'TRIGGER_PENDING', 'CONFIRMED'].includes(r.phase) && aiReserveOk(0.6)) {
        const r2 = await aiJSON(EV_SYS, mkPrompt(r), { timeoutMs: 22000, exclude: [res.provider] });
        if (!r2.error) {
          const ev2 = normEval(r2.j, kind, r.symbol, { lateEntry: r.late, triggerConfirmed: r.triggerConfirmed, dataQuality: r.dataQuality });
          ent.second = { provider: r2.providerName, model: r2.model, decision: ev2.decision, direction: ev2.direction, score: ev2.score, summary: ev2.summary, disagree: ev2.decision !== ev.decision || ev2.direction !== ev.direction };
        }
      }
      cache.set(r.key, ent);
      AI_HISTORY.unshift({ at, kind, symbol: r.symbol, tf: r.tf || null, provider: res.providerName, model: res.model, ms: res.ms, decision: ev.decision, phase: ev.phase, score: ev.score, dataQuality: ev.dataQuality, sig: r.sig, disagree: ent.second ? ent.second.disagree : null });
      if (AI_HISTORY.length > 200) AI_HISTORY.length = 200;
      oppUpdate(kind === 'LT' ? 'LT' : 'TREND', r.symbol, null, null, r.price, '', ev.summary);
      done++;
    } catch (e) { cache.set(r.key, { at: Date.now(), sig: r.sig, error: redact(e.message) }); }
    finally { AI_INFLIGHT.delete(ik); }
  }
  if (cache.size > 150) { for (const [k, v] of Array.from(cache)) if (now - v.at > 3 * H1) cache.delete(k); }
}

/* Placeholder for detection functions (aşağıda) */
let market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, b1h: 0.5, b4h: 0.5, btc: null, eth: null, lastDirChange: 0, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [], daily: [] };
const DAILY_LEVELS = new Map();
const DAILY_ASKED = new Map();
const DWHY = {};
let marketBrief = null;
const LTR = new Map();
const BLK = {}, PWHY = {}, SWHY = {}, TWHY = {}, LWHY = {}, RWHY = {}, SC = {};
const stats = { apiErr: 0, pumpScanned: 0, pumpFound: 0, tickAt: 0, excluded: 0 };
const TICK = {}, CACHE = new Map(), jobs = {};
let ALL = [], TOP = [];
const DEF_SET = { auto: false, tradeMode: 'paper', margin: 100, leverage: 5, minConf: 60, maxMinutes: 5, riskPct: 0.5, maxOpen: 8, dailyLossPct: 0, pumpQuick: true, aiEnabled: true };
let settings = Object.assign({}, DEF_SET);
let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: 0, liveDayStart: 0 };
const ex = new ccxt.bitget({ apiKey: API_KEY, secret: API_SECRET, password: API_PASS, enableRateLimit: true, options: { defaultType: 'swap', defaultSubType: 'linear' } });
const sc = (m, k) => { const o = SC[m] || (SC[m] = {}); o[k] = (o[k] || 0) + 1; };
const priceOf = sym => (TICK[sym] && TICK[sym].last ? TICK[sym].last : null);

/* ═══════════════════════════════════════════════════════════════════════════
   AI SAĞLAYICI
   ═══════════════════════════════════════════════════════════════════════════ */
const envKey = (...names) => { for (const n of names) { let v = process.env[n]; if (!v) continue; v = String(v).trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim(); if (v) return v; } return ''; };
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
  requireEntryAllowed: process.env.AI_REQUIRE_ENTRY_ALLOWED !== '0',
  requireTriggerConfirmed: process.env.AI_REQUIRE_TRIGGER_CONFIRMED !== '0',
  rejectLateEntry: process.env.AI_REJECT_LATE_ENTRY !== '0',
  modHourCap: { TREND: 20, DAILY: 20, LT: 15, SCALPER: 20, RANGE: 12, ZONE: 10 },
  gapMs: { gemini: 5000, groq: 6000, openrouter: 5000, deepseek: 4000, github: 4000, cerebras: 3000, sambanova: 3000, mistral: 3000, cohere: 3500 },
  providers: [
    { id: 'gemini', name: 'Gemini Flash', key: envKey('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_KEY'), base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-3.5-flash-lite', 'gemini-3.6-flash'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'groq', name: 'Groq', key: envKey('GROQ_API_KEY', 'GROQ_KEY', 'GROQ_TOKEN'), base: 'https://api.groq.com/openai/v1/chat/completions', models: process.env.GROQ_MODEL ? [process.env.GROQ_MODEL] : ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'deepseek', name: 'DeepSeek', key: envKey('DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'DEEPSEEK_TOKEN'), base: 'https://api.deepseek.com/v1/chat/completions', models: process.env.DEEPSEEK_MODEL ? [process.env.DEEPSEEK_MODEL] : ['deepseek-chat'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'openrouter', name: 'OpenRouter', key: envKey('OPENROUTER_API_KEY', 'OPENROUTER_KEY', 'OPEN_ROUTER_API_KEY'), base: 'https://openrouter.ai/api/v1/chat/completions', models: process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : [], headers: { 'HTTP-Referer': 'https://alphason-z8kj.onrender.com', 'X-Title': 'AlphaSon' }, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} },
    { id: 'cerebras', name: 'Cerebras', key: envKey('CEREBRAS_API_KEY', 'CEREBRAS_KEY'), base: 'https://api.cerebras.ai/v1/chat/completions', models: process.env.CEREBRAS_MODEL ? [process.env.CEREBRAS_MODEL] : ['llama-3.3-70b'], headers: {}, cooldownMs: 3 * M1, modelCooldownMs: 10 * M1, modelCooldowns: {} }
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
  const score = p => { const total = (p.ok || 0) + (p.fail || 0); const rate = total > 0 ? (p.ok || 0) / total : 0.5; const lat = p.lastLatencyMs || 3000; const recentFail = p.lastError && Date.now() - (p.lastAt || 0) < 5 * M1 ? 1 : 0; return rate - (lat / 30000) - recentFail * 0.3; };
  return ks.slice().sort((a, b) => score(b) - score(a));
}
const MODEL_PICK = {
  groq: list => { const bad = /whisper|guard|tts|playai|orpheus|embed|safeguard|compound/i; const ok = list.map(m => m.id).filter(x => !bad.test(x)); const out = []; for (const re of [/gpt-oss-20b/i, /llama-3\.1-8b-instant/i, /llama-3\.3-70b-versatile/i, /qwen/i]) { const m = ok.find(x => re.test(x) && !out.includes(x)); if (m) out.push(m); if (out.length >= 3) break; } return out; },
  openrouter: list => { const bad = /thinking|reasoning|r1|vision|vl\b|embed|guard|audio|image|lyria|safeguard|moderation/i; const free = list.filter(m => (m.free === true || /:free$/.test(m.id)) && !bad.test(m.id)); const pref = [/llama/, /gemma/, /qwen/, /mistral/, /glm/, /nemotron/, /gpt-oss/, /deepseek/, /hermes/]; const rank = id => { const k = pref.findIndex(re => re.test(id)); return k < 0 ? 99 : k; }; return free.map(m => m.id).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 4); }
};
async function discoverModels(p) {
  if (p.id === 'deepseek') return [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }];
  const url = p.base.replace(/\/chat\/completions$/, '/models');
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try { const res = await fetch(url, { headers: Object.assign({ Authorization: 'Bearer ' + p.key }, p.headers || {}), signal: ctl.signal }); const j = await res.json().catch(() => null); if (!res.ok || !j) throw new Error('HTTP ' + res.status); const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []; return list.map(m => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), free: m.pricing ? (Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) : null })).filter(m => m.id); }
  finally { clearTimeout(tm); }
}
async function discoverAll() {
  for (const p of AI.providers) {
    if (!p.key) continue;
    if (p.id === 'deepseek' && !process.env.DEEPSEEK_MODEL) { p.models = ['deepseek-chat']; p.modelCooldowns = {}; p.cooldownUntil = 0; log('AI MODEL: DeepSeek → deepseek-chat'); continue; }
    if (!MODEL_PICK[p.id]) continue;
    if (process.env[p.id.toUpperCase() + '_MODEL']) continue;
    try { const list = await discoverModels(p); const picked = MODEL_PICK[p.id](list || []); if (picked.length) { p.models = picked; p.modelCooldowns = {}; p.cooldownUntil = 0; log('AI MODEL: ' + p.name + ' → ' + picked.join(', ')); } else log('AI MODEL: ' + p.name + ' → uygun yok'); }
    catch (e) { log('AI MODEL HATA: ' + p.name + ' → ' + redact(e.message)); }
  }
}
async function aiTestProvider(p) {
  const out = [];
  for (const model of (p.models || [])) {
    const t0 = Date.now();
    try { const r = await callProviderModel(p, [{ role: 'system', content: 'Yalnızca JSON döndür.' }, { role: 'user', content: '{"ok":true} döndür.' }], model, { timeoutMs: 12000 }); p.lastLatencyMs = Date.now() - t0; out.push({ model, ok: true, ms: Date.now() - t0 }); }
    catch (e) { out.push({ model, ok: false, ms: Date.now() - t0, status: e.status || 0, error: redact(e.message).slice(0, 200) }); }
    await sleep(300);
  }
  return out;
}
async function aiBootstrap() {
  log('AI ANAHTAR: ' + AI.providers.map(p => p.id + (p.key ? ' ✓' : ' ✗')).join(' | '));
  await discoverAll();
  for (const p of AI.providers) { if (!p.key) continue; if (!(p.models || []).length) { log('AI TEST: ' + p.name + ' → model yok'); continue; } const res = await aiTestProvider(p); for (const r of res) log('AI TEST: ' + p.name + '/' + r.model + ' → ' + (r.ok ? 'OK ' + r.ms + 'ms' : 'HATA ' + r.status)); }
}
function aiProviderView(p) { const now = Date.now(); return { id: p.id, name: p.name, models: (p.models || []).slice(), hasKey: !!p.key, cooldownUntil: p.cooldownUntil || 0, cooldownSec: p.cooldownUntil && p.cooldownUntil > now ? Math.ceil((p.cooldownUntil - now) / 1000) : 0, modelCooldowns: p.modelCooldowns || {}, lastError: p.lastError || null, lastAt: p.lastAt || 0, lastLatencyMs: p.lastLatencyMs || null, calls: p.calls || 0, ok: p.ok || 0, fail: p.fail || 0 }; }
function aiQuota() { const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), hk = Math.floor(now / H1); if (aiUsage.day !== day) { aiUsage.day = day; aiUsage.dayCount = 0; aiUsage.briefDay = day; aiUsage.briefCount = 0; } if (aiUsage.hourKey !== hk) { aiUsage.hourKey = hk; aiUsage.hourCount = 0; } return { ok: aiUsage.dayCount < AI.maxPerDay && aiUsage.hourCount < AI.maxPerHour, day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour }; }
function aiReserveOk(frac) { const q = aiQuota(); return q.ok && aiUsage.dayCount < AI.maxPerDay * frac && aiUsage.hourCount < AI.maxPerHour * frac; }
function aiCount(provider) { const q = aiQuota(); if (!q.ok) return false; aiUsage.dayCount++; aiUsage.hourCount++; aiUsage.total++; aiUsage.lastAt = Date.now(); aiUsage.lastProvider = provider ? provider.id : null; saveAI(); return true; }
function aiStatus() { const q = aiQuota(), keys = aiKeys(); return { version: VERSION, enabled: aiReady(), settingsEnabled: settings.aiEnabled !== false, keys: keys.length, modules: AI.modules.slice(), limits: { maxPerDay: AI.maxPerDay, maxPerHour: AI.maxPerHour, briefPerDay: AI.briefPerDay, pumpMinScore: AI.pumpMinScore, pumpWaitMs: AI.pumpWaitMs, approvalWindowMs: AI.approvalWindowMs, autoMaxOpen: AI.autoMaxOpen, watchTopN: AI.aiWatchTopN, requireEntryAllowed: AI.requireEntryAllowed, requireTriggerConfirmed: AI.requireTriggerConfirmed, rejectLateEntry: AI.rejectLateEntry, modHourCap: AI.modHourCap, modMinConf: { TREND: 0, DAILY: 0, LT: 0 }, gapMs: AI.gapMs, nonPumpShare: AI.nonPumpShare }, usage: { day: q.day, dayCount: aiUsage.dayCount, hourCount: aiUsage.hourCount, briefCount: aiUsage.briefCount, total: aiUsage.total, lastAt: aiUsage.lastAt, lastError: aiUsage.lastError, lastProvider: aiUsage.lastProvider }, providers: AI.providers.map(aiProviderView), brief: marketBrief }; }

/* AI hata/yedek */
function redact(s) { let x = String(s == null ? '' : s); for (const p of AI.providers) if (p.key) x = x.split(p.key).join('[KEY]'); return x.slice(0, 500); }
function isModelError(e) { const s = String(e && e.message || '').toLowerCase(); return Number(e && e.status) === 404 || /model.+(does not exist|not found|not available|no access|not supported|decommission)|unknown model|unsupported model|model_not_found|no longer available|no longer supported/.test(s); }
function isQuotaExhausted(e) { const s = String(e && e.message || '').toLowerCase(); return /quota_exceeded|current quota|daily quota|billing details|insufficient quota|credit balance|exceeded.*quota|resource_exhausted|rate limit reached|tokens per minute|tpm|requests per minute|rpm/.test(s); }
function isTransientAIError(e) { const status = Number(e && e.status) || 0; return (status === 408 || status === 409 || status === 429 || status >= 500) && !isQuotaExhausted(e); }
function untilNextPacificMidnight(now) { try { const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })); const next = new Date(local); next.setDate(next.getDate() + 1); next.setHours(0, 0, 10, 0); return Math.max(M1, next.getTime() - local.getTime()); } catch (e) { return 12 * H1; } }
function providerFail(p, e) { const status = Number(e && e.status) || 0; p.fail = (p.fail || 0) + 1; p.lastError = redact(e && e.message || 'bilinmeyen hata'); p.lastAt = Date.now(); let ms; if (e && e.retryAfterMs) ms = e.retryAfterMs; else if (isQuotaExhausted(e)) ms = untilNextPacificMidnight(Date.now()); else if (status === 429) ms = 2 * M1; else if (status === 401 || status === 403) ms = 60 * M1; else if (status >= 500) ms = 2 * M1; else if (isModelError(e) || (e && e.allModelsCooldown)) ms = 10 * M1; else ms = M1; p.cooldownUntil = Date.now() + ms; aiUsage.lastError = p.name + ': ' + p.lastError; aiUsage.lastAt = Date.now(); saveAI(); log('AI HATA: ' + p.name + ' → ' + p.lastError + ' | ' + Math.ceil(ms / 1000) + 's'); }
async function callProviderModel(p, messages, model, opts) {
  const tmo = (opts && opts.timeoutMs) || AI.timeoutMs;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), tmo);
  const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key }, p.headers || {});
  try {
    const res = await fetch(p.base, { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify({ model, messages, temperature: AI.temperature, max_tokens: AI.maxTokens, stream: false }) });
    const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (!res.ok) { const msg = (j && (j.error && (j.error.message || j.error.code) || j.message)) || txt.slice(0, 300) || ('HTTP ' + res.status); const er = new Error(redact(msg)); er.status = res.status; const ra = res.headers.get('retry-after'); if (ra) { const n = Number(ra); er.retryAfterMs = isFinite(n) ? n * 1000 : Math.max(60000, (Date.parse(ra) || Date.now() + 300000) - Date.now()); } throw er; }
    if (!j) throw new Error('geçersiz JSON');
    if (j.error && !j.choices) { const er = new Error(redact(j.error.message || j.error.code || 'sağlayıcı hatası')); er.status = Number(j.error.code) || 502; throw er; }
    let c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
    if (Array.isArray(c)) c = c.map(x => (x && (x.text || x.content)) || '').join('\n');
    if (!c || !String(c).trim()) { const er = new Error('boş yanıt'); er.emptyResp = true; er.status = 0; throw er; }
    return { text: String(c), model: (j.model || model) };
  } catch (e) { if (e && e.name === 'AbortError') { const er = new Error('zaman aşımı'); er.status = 0; throw er; } throw e; }
  finally { clearTimeout(timer); }
}
async function paceProvider(p) { const gap = AI.gapMs[p.id] || 3000; const at = Math.max(Date.now(), p.nextAt || 0); p.nextAt = at + gap; const wait = at - Date.now(); if (wait > 0) await sleep(Math.min(wait, 15000)); }
async function callProvider(p, messages, opts) {
  const now = Date.now();
  const usable = (p.models || []).filter(m => ((p.modelCooldowns && p.modelCooldowns[m]) || 0) < now);
  if (!usable.length) { const nextFree = p.models && p.models.length ? Math.min(...p.models.map(m => (p.modelCooldowns && p.modelCooldowns[m]) || 0)) : now; throw Object.assign(new Error('modeller soğumada'), { status: 404, allModelsCooldown: true }); }
  let lastErr = null;
  for (const model of usable) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await paceProvider(p); return await callProviderModel(p, messages, model, opts); }
      catch (e) {
        lastErr = e;
        if (isModelError(e)) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + (p.modelCooldownMs || 10 * M1); break; }
        if (e && e.emptyResp) { p.modelCooldowns = p.modelCooldowns || {}; p.modelCooldowns[model] = Date.now() + 5 * M1; break; }
        if (isQuotaExhausted(e)) throw e;
        if (!isTransientAIError(e) || attempt === 1) throw e;
        await sleep(Math.min(5000, 600 * Math.pow(2, attempt) + Math.round(Math.random() * 350)));
      }
    }
  }
  throw lastErr || new Error('sağlayıcı yanıt vermedi');
}

/* v81: aiJSON */
function looseJSON(text) { try { const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); return JSON.parse(a >= 0 && b > a ? raw.slice(a, b + 1) : raw); } catch (e) { return null; } }
async function aiJSON(system, user, opt) {
  opt = opt || {};
  let lastErr = null;
  for (const p of orderedProviders(opt.prefer || null)) {
    if (opt.exclude && opt.exclude.includes(p.id)) continue;
    if (p.cooldownUntil && p.cooldownUntil > Date.now()) continue;
    if (!aiQuota().ok) { lastErr = new Error('AI kotası dolu'); break; }
    if (!aiReserveOk(AI.nonPumpShare)) { lastErr = new Error('AI kotası ayrıldı'); break; }
    if (!aiCount(p)) break;
    const t0 = Date.now();
    try {
      const r = await callProvider(p, [{ role: 'system', content: system }, { role: 'user', content: user }], { timeoutMs: opt.timeoutMs || AI.timeoutMs });
      p.ok = (p.ok || 0) + 1; p.calls = (p.calls || 0) + 1; p.lastAt = Date.now(); p.lastError = null;
      const j = looseJSON(r.text);
      if (!j || typeof j !== 'object') { p.jsonFail = (p.jsonFail || 0) + 1; lastErr = new Error('geçersiz JSON'); continue; }
      return { j, provider: p.id, providerName: p.name, model: r.model || '?', ms: Date.now() - t0 };
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  return { error: lastErr ? redact(lastErr.message) : 'AI sağlayıcı yok' };
}

console.log('[AlphaSon ' + VERSION + '] PARÇA 1/2 hazır. PARÇA 2 için "2" yaz.');
/* ═══════════════════════════════════════════════════════════════════════════
   PARÇA 2/2 — Detection, Watch, Paper, API, Init
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── MATH: helpers ── */
const closes = cs => cs.map(x => x.c);
function emaArr(a, p) { const k = 2 / (p + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o[i] = e; } return o; }
function atrArr(cs, p) { p = p || 14; const o = new Array(cs.length).fill(null); if (cs.length < p + 1) return o; const tr = i => Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); let s = 0; for (let i = 1; i <= p; i++) s += tr(i); let a = s / p; o[p] = a; for (let i = p + 1; i < cs.length; i++) { a = (a * (p - 1) + tr(i)) / p; o[i] = a; } return o; }
function atrLast(cs, p) { const a = atrArr(cs, p || 14); return a[a.length - 1]; }
function rsiLast(cl, p) { p = p || 14; if (cl.length < p + 2) return null; let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d >= 0) g += d; else l -= d; } g /= p; l /= p; for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + (d > 0 ? d : 0)) / p; l = (l * (p - 1) + (d < 0 ? -d : 0)) / p; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
function adxLast(cs, p) { p = p || 14; const n = cs.length; if (n < p * 2 + 2) return null; let trS = 0, pS = 0, mS = 0; const dx = []; for (let i = 1; i < n; i++) { const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l; const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0; const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); if (i <= p) { trS += tr; pS += pdm; mS += mdm; } else { trS = trS - trS / p + tr; pS = pS - pS / p + pdm; mS = mS - mS / p + mdm; } if (i >= p && trS > 0) { const pdi = 100 * pS / trS, mdi = 100 * mS / trS, sm = pdi + mdi; dx.push(sm === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sm); } } if (dx.length < p) return null; let adx = avg(dx.slice(0, p)); for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p; return adx; }
function bbwArr(cl, p) { p = p || 20; const o = new Array(cl.length).fill(null); for (let i = p - 1; i < cl.length; i++) { let m = 0; for (let j = i - p + 1; j <= i; j++) m += cl[j]; m /= p; let v = 0; for (let j = i - p + 1; j <= i; j++) v += (cl[j] - m) * (cl[j] - m); o[i] = m ? 4 * Math.sqrt(v / p) / m : null; } return o; }
function pivots(cs, L, R, from, to) { const hi = [], lo = []; const a = Math.max(L, from != null ? from : L), b = Math.min(cs.length - 1 - R, to != null ? to : cs.length - 1 - R); for (let i = a; i <= b; i++) { let h = true, l = true; for (let j = i - L; j <= i + R; j++) { if (j === i) continue; if (cs[j].h > cs[i].h) h = false; if (cs[j].l < cs[i].l) l = false; if (!h && !l) break; } if (h) hi.push({ i, p: cs[i].h }); if (l) lo.push({ i, p: cs[i].l }); } return { hi, lo }; }
function calcPSAR(cs, step, max) { step = step || 0.02; max = max || 0.2; const n = cs.length, out = new Array(n).fill(null); if (n < 3) return out; let up = cs[1].c >= cs[0].c, af = step; let sar = up ? cs[0].l : cs[0].h, ep = up ? cs[0].h : cs[0].l; out[0] = { sar, up }; for (let i = 1; i < n; i++) { let ns = sar + af * (ep - sar); if (up) { ns = Math.min(ns, cs[i - 1].l, i > 1 ? cs[i - 2].l : cs[i - 1].l); if (cs[i].l < ns) { up = false; ns = ep; ep = cs[i].l; af = step; } else if (cs[i].h > ep) { ep = cs[i].h; af = Math.min(af + step, max); } } else { ns = Math.max(ns, cs[i - 1].h, i > 1 ? cs[i - 2].h : cs[i - 1].h); if (cs[i].h > ns) { up = true; ns = ep; ep = cs[i].h; af = step; } else if (cs[i].l < ep) { ep = cs[i].l; af = Math.min(af + step, max); } } sar = ns; out[i] = { sar, up }; } return out; }
function williamsR(cs, p) { p = p || 14; if (cs.length < p) return null; const w = cs.slice(-p); const hh = Math.max.apply(null, w.map(c => c.h)), ll = Math.min.apply(null, w.map(c => c.l)); if (hh === ll) return -50; return (hh - cs[cs.length - 1].c) / (hh - ll) * -100; }
function aggTF(cs, m) { const ms = m * 60000, out = []; let cur = null; for (const c of cs) { const b = Math.floor(c.t / ms) * ms; if (!cur || cur.t !== b) { cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; out.push(cur); } else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; } } return out; }
function anchorLine(pts, up, tol) { tol = tol || 0.004; if (pts.length < 2) return null; const order = pts.slice().sort((x, y) => (up ? y.p - x.p : x.p - y.p)); for (const a of order.slice(0, 4)) { const later = pts.filter(q => q.i > a.i); let best = null; for (const b of later) { const sl = (b.p - a.p) / (b.i - a.i); let ok = true, touches = 0; for (const q of later) { const lp = a.p + sl * (q.i - a.i), dv = (q.p - lp) / lp; if (up ? dv > tol : dv < -tol) { ok = false; break; } if (Math.abs(dv) <= tol) touches++; } if (!ok) continue; if (!best || touches > best.touches || (touches === best.touches && b.i > best.b.i)) best = { a, b, sl, touches }; } if (best) return { a: best.a, sl: best.sl, touches: best.touches + 1 }; } return null; }
function analyzeTriangle(cs, loose) { if (cs.length < 60) return null; const w = cs.slice(-120), m = w.length - 1, px = w[m].c; const pv = pivots(w, 4, 4); const tolA = loose ? 0.007 : undefined; const Uc = anchorLine(pv.hi, true, tolA), Lc = anchorLine(pv.lo, false, tolA); if (!Uc || !Lc) return null; const U = x => Uc.a.p + Uc.sl * (x - Uc.a.i), L = x => Lc.a.p + Lc.sl * (x - Lc.a.i); if (Lc.sl <= Uc.sl) return null; const x0 = Math.max(Uc.a.i, Lc.a.i); if (m - x0 < (loose ? 10 : 15)) return null; const w0 = U(x0) - L(x0), wN = U(m) - L(m); if (w0 <= 0 || wN <= 0) return null; const comp = wN / w0; if (comp >= (loose ? 0.88 : 0.75)) return null; const xA = x0 + w0 / (Lc.sl - Uc.sl); const mat = (m - x0) / (xA - x0); if (mat < (loose ? 0.25 : 0.4) || mat > (loose ? 1.2 : 1.0)) return null; return { w, m, U, L, x0, ua: Uc.a.i, la: Lc.a.i, w0, wN, comp, mat, px, uN: U(m), lN: L(m) }; }
function regimeOf(cs) { const n = cs.length, adx = adxLast(cs, 14); const bb = bbwArr(closes(cs), 20), now = bb[n - 1], prev = bb[n - 6]; const expanding = now != null && prev != null && prev > 0 && now > 1.3 * prev; return { regime: adx == null ? 'BELIRSIZ' : adx < 25 ? 'RANGE' : adx < 30 ? 'MIX' : 'TREND', adx, expanding }; }
function bandsOf(cs) { const P = REVERT.bbP, w = closes(cs).slice(-P), mid = avg(w); let v = 0; for (const x of w) v += (x - mid) * (x - mid); const sd = Math.sqrt(v / P); return { mid, sd, up: mid + REVERT.bbK * sd, lo: mid - REVERT.bbK * sd }; }
function rrNet(entry, sl, tp) { const risk = Math.abs(entry - sl) / entry * 100; const gain = Math.abs(tp - entry) / entry * 100; const rr = risk > 0 ? gain / risk : 0; const net = risk > 0 ? (gain - FEE_ROUNDTRIP) / (risk + FEE_ROUNDTRIP) : 0; return { risk: +risk.toFixed(3), gain: +gain.toFixed(3), rr: +rr.toFixed(2), net: +net.toFixed(2) }; }
const EPS = 1e-9;

/* ── Detect functions ── */
function detectBurst(cs, tfMs, now, why) { const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; }; const n = cs.length; if (n < 45) return null; const P = tfMs === M1 ? PUMP.m1 : PUMP.m3, L = cs[n - 1]; const forming = now != null && now < L.t + tfMs; const elapsed = forming ? Math.max(now - L.t, 0) : tfMs; if (forming && elapsed < PUMP.minElapsedMs) return no('mum çok yeni'); const price = L.c, body = L.c - L.o; if (!(L.o > 0) || body === 0) return no('hareket yok'); const dir = body > 0 ? 'LONG' : 'SHORT', d = body > 0 ? 1 : -1; const movePct = Math.abs(body) / L.o * 100; if (movePct < P.minMovePct) return no('hareket küçük'); if (movePct > P.maxMovePct) return no('aşırı uzamış'); const atr = atrLast(cs.slice(0, n - 1), 14); if (!atr) return null; const moveAtr = Math.abs(body) / atr; if (moveAtr < P.minAtrX) return no('itme zayıf'); const volBase = avg(cs.slice(n - 31, n - 1).map(c => c.v)); if (!(volBase > 0)) return no('hacim yok'); const frac = Math.max(elapsed / tfMs, 0.25); const volX = (L.v / frac) / volBase; if (volX < P.minVolX) return no('hacim zayıf'); const rng = L.h - L.l; if (!(rng > 0)) return no('aralık yok'); const pos = d > 0 ? (L.c - L.l) / rng : (L.h - L.c) / rng; if (pos < PUMP.posMin) return no('geri çekilmiş'); const prior = cs.slice(n - 4, n - 1); const priorDir = prior.reduce((s, c) => s + (c.c - c.o) * d / c.o * 100, 0); if (priorDir > PUMP.priorMaxFrac * movePct) return no('ilk patlama değil'); if (Math.abs(price / cs[n - 16].o - 1) * 100 > PUMP.maxExt15Pct) return no('aşırı uzamış'); const atrPct = atr > 0 && L.c > 0 ? atr / L.c * 100 : 0; let slPct = Math.max(clamp(PUMP.slBodyFrac * movePct, PUMP.slMin, PUMP.slMax), EX.SL_ATR_K * atrPct, EX.SL_COST_K * FEE_ROUNDTRIP); slPct = Math.min(slPct, PUMP.slMax); const tpPct = Math.max(PUMP.tpMaxPct, clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX)); const q = rrNet(price, price * (1 - d * slPct / 100), price * (1 + d * tpPct / 100)); if (q.risk < EX.MIN_SL_PCT || q.net < EX.MIN_NET_RR) return no('net R:R düşük'); const quiet = clamp((1 - priorDir / Math.max(0.01, PUMP.priorMaxFrac * movePct)) * 4, 0, 4); const conf = 55 + clamp((volX - P.minVolX) * 2.5, 0, 15) + clamp((moveAtr - P.minAtrX) * 3, 0, 12) + clamp((pos - PUMP.posMin) * 20, 0, 6) + quiet; return { dir, entry: rp(price), sl: rp(price * (1 - d * slPct / 100)), tp1: rp(price * (1 + d * tpPct / 100)), tp2: null, single: true, conf: clamp(Math.round(conf), 40, 95), holdSec: P.hold, noMoveSec: P.noMove, maxAgeMs: (P.hold + 30) * 1000, info: { tf: tfMs === M1 ? '1m' : '3m', forming, movePct: +movePct.toFixed(2), volRatio: +volX.toFixed(1), atrX: +moveAtr.toFixed(1), closePos: +pos.toFixed(2), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2), atr } }; }

function detectScalper(cs, why, bookImbalance, flowRatio) { const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; }; const n = cs.length; if (n < 80) return null; const last = cs[n - 1]; const rng = last.h - last.l, body = Math.abs(last.c - last.o); if (!(rng > 0) || body <= 0.5 * rng) return no('gövde zayıf'); const dir = last.c > last.o ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1; const pv = pivots(cs, SCALP.pivL, SCALP.pivR, n - SCALP.lookback); const list = dir === 'LONG' ? pv.hi : pv.lo; if (!list.length) return no('pivot yok'); const piv = list[list.length - 1], level = piv.p; if (dir === 'LONG' ? !(last.c > level) : !(last.c < level)) return no('kırılım yok'); for (let k = piv.i + 1; k <= n - 2; k++) if (dir === 'LONG' ? cs[k].c > level : cs[k].c < level) return no('kırılım eski'); const prev = cs.slice(n - 21, n - 1); const vSma = avg(prev.map(c => c.v)); if (!(vSma > 0)) return no('hacim yok'); const vr = last.v / vSma; if (vr < SCALP.minVolX) return no('hacim zayıf'); if (bookImbalance != null) { const reqImbalance = dir === 'LONG' ? 0.55 : 0.45; if (dir === 'LONG' && bookImbalance < reqImbalance) return no('order book zayıf'); if (dir === 'SHORT' && bookImbalance > 1 - reqImbalance) return no('order book zayıf'); } if (flowRatio != null && flowRatio < SCALP.minFlowRatio) return no('net akış zayıf'); const e = last.c, atr = atrLast(cs, 14); if (!atr) return null; const atrPct = atr / e * 100; const distPct = Math.abs(e - level) / level * 100; const distCap = Math.min(SCALP.maxDistPct, SCALP.maxDistAtrK * atrPct); if (distPct > distCap) return no('seviyeden uzak'); let risk = Math.abs(e - (level - d * 0.5 * atr)); risk = Math.max(risk, e * SCALP.minRiskPct / 100, e * EX.SL_COST_K * FEE_ROUNDTRIP / 100); if (risk > e * 0.05) return no('risk büyük'); const tp1 = e + d * SCALP.tp1R * risk; const q = rrNet(e, e - d * risk, tp1); if (q.net < SCALP.minNetRR) return no('net R:R düşük'); const closePos = (dir === 'LONG' ? e - last.l : last.h - e) / rng; const conf = 55 + clamp((vr - SCALP.minVolX) * 5, 0, 12) + clamp((body / rng - 0.5) * 20, 0, 8) + clamp((1 - distPct / Math.max(distCap, 0.01)) * 5, 0, 5) + (closePos > 0.8 ? 4 : 0) - (rng > 3 * atr ? 8 : 0) + (flowRatio != null && flowRatio > 2 ? 4 : 0); return { dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(e + d * SCALP.tp1R * risk), tp2: rp(e + d * SCALP.tp2R * risk), single: false, conf: clamp(Math.round(conf), 40, 92), info: { bos: true, level: rp(level), distPct: +distPct.toFixed(2), volRatio: +vr.toFixed(1), bodyRatio: +(body / rng).toFixed(2), atr, riskPct: +(risk / e * 100).toFixed(2), bookImbalance: bookImbalance != null ? +bookImbalance.toFixed(2) : null, netFlowRatio: flowRatio != null ? +flowRatio.toFixed(2) : null } }; }

function detectRevert(cs, why, adxMax) { const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; }; const n = cs.length; if (n < 80) return null; adxMax = adxMax != null ? adxMax : REVERT.adxMax; const rg = regimeOf(cs); if (rg.adx == null) return null; if (rg.adx >= adxMax) return no('trend rejimi'); if (rg.expanding) return no('bant genişliyor'); const last = cs[n - 1], { mid, sd, up, lo } = bandsOf(cs), rng = last.h - last.l; if (!(rng > 0) || !(sd > 0)) return no('aralık yok'); let dir = null; if (last.l < lo && last.c > lo) dir = 'LONG'; else if (last.h > up && last.c < up) dir = 'SHORT'; if (!dir) return no('bant reddi yok'); const d = dir === 'LONG' ? 1 : -1; const wick = (dir === 'LONG' ? Math.min(last.o, last.c) - last.l : last.h - Math.max(last.o, last.c)) / rng; if (wick < REVERT.wickMin) return no('fitil zayıf'); const prev = cs.slice(n - 21, n - 1), vSma = avg(prev.map(c => c.v)); if (!(vSma > 0)) return no('hacim yok'); const vr = last.v / vSma; if (vr < REVERT.minVolX) return no('hacim zayıf'); const atr = atrLast(cs, 14); if (!atr) return null; const e = last.c, extreme = dir === 'LONG' ? last.l : last.h; let sl = extreme - d * REVERT.stopAtr * atr; const riskFloor = Math.max(REVERT.minRiskPct, EX.SL_COST_K * FEE_ROUNDTRIP); if (Math.abs(e - sl) / e * 100 < riskFloor) sl = e - d * e * riskFloor / 100; const risk = Math.abs(e - sl), gain = (mid - e) * d; if (!(gain > 0)) return no('hedef ters'); const riskPct = risk / e * 100; if (riskPct > REVERT.maxRiskPct) return no('risk büyük'); const q = rrNet(e, sl, mid); if (q.net < REVERT.minNetRR) return no('net R:R düşük'); const rr = q.rr; const tp2 = mid + d * 0.5 * Math.abs((dir === 'LONG' ? up : lo) - mid); const better = e - d * REVERT.limitAtr * atr; const conf = 56 + clamp((vr - REVERT.minVolX) * 6, 0, 10) + clamp((wick - REVERT.wickMin) * 20, 0, 8) + clamp((rr - REVERT.minRR) * 5, 0, 8) + (rg.adx < 18 ? 4 : 0); return { dir, entry: rp(e), sl: rp(sl), tp1: rp(mid), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 90), info: { regime: rg.regime, adx: +rg.adx.toFixed(1), band: { lo: rp(lo), mid: rp(mid), up: rp(up) }, wickRatio: +wick.toFixed(2), volRatio: +vr.toFixed(1), gainPct: +(gain / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), rr: +rr.toFixed(2), betterEntry: rp(better), atr } }; }

function detectPSAR(cs, why) { const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; }; const n = cs.length; if (n < 100) return null; const ps = calcPSAR(cs, PSAR.step, PSAR.max), m = n - 1; if (!ps[m] || !ps[m - 1] || !ps[m - 2]) return null; const flipNow = ps[m].up !== ps[m - 1].up; const flipPrev = !flipNow && ps[m - 1].up !== ps[m - 2].up && ps[m].up === ps[m - 1].up; if (!flipNow && !flipPrev) return no('PSAR dönüşü yok'); const dir = ps[m].up ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1; const adx = adxLast(cs, 14); if (adx == null || adx < PSAR.adxMin) return no('ADX düşük'); const wr = williamsR(cs, PSAR.wrP); if (wr == null) return null; if (dir === 'LONG' ? !(wr > -50 - PSAR.wrBand) : !(wr < -50 + PSAR.wrBand)) return no('Williams uyumsuz'); const cl = closes(cs), e34 = emaArr(cl, PSAR.emaP), last = cs[m]; if (dir === 'LONG' ? !(last.c > e34[m]) : !(last.c < e34[m])) return no('EMA34 ters'); const vSma = avg(cs.slice(m - 20, m).map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0; if (!(vr >= PSAR.minVolX)) return no('hacim zayıf'); const atr = atrLast(cs, 14); if (!atr) return null; const e = last.c; if (Math.abs(e - e34[m]) > PSAR.maxExtAtr * atr) return no('EMA34 uzak'); let risk = clamp(Math.abs(e - ps[m].sar), 1.2 * atr, 2.5 * atr); risk = Math.max(risk, e * PSAR.minRiskPct / 100, e * EX.SL_COST_K * FEE_ROUNDTRIP / 100); const riskPct = risk / e * 100; if (riskPct > PSAR.maxRiskPct) return no('risk büyük'); const tp1 = e + d * PSAR.tp1R * risk; const q = rrNet(e, e - d * risk, tp1); if (q.net < PSAR.minNetRR) return no('net R:R düşük'); const conf = 55 + clamp((adx - PSAR.adxMin) * 0.8, 0, 12) + clamp(Math.abs(wr + 50) / 50 * 10, 0, 8) + (vr >= 1.2 ? 5 : 0) - (flipPrev ? 3 : 0); return { dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(tp1), tp2: rp(e + d * PSAR.tp2R * risk), single: false, conf: clamp(Math.round(conf), 40, 90), info: { adx: +adx.toFixed(1), williamsR: +wr.toFixed(1), psar: rp(ps[m].sar), ema34: rp(e34[m]), volRatio: +vr.toFixed(1), atr, atrPct: +(atr / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), netRR: q.net, flipAge: flipNow ? 0 : 1 } }; }

function detectScalpX(cs, tf, why, sym) {
  const no = k => {
    if (why) why['scalp:' + k] = (why['scalp:' + k] || 0) + 1;
    if (sym) logRejSym('PUMP', sym, 'scalp:' + k, { tf }, 'REJECTED', 'kırılım + gövde + hacim');
    return null;
  };
  const n = cs.length; if (n < 50) return null;
  const L = cs[n - 1], P = cs.slice(n - 1 - SCALPX.brkBars, n - 1);
  const rng = L.h - L.l, body = L.c - L.o;
  if (!(rng > 0) || body === 0) return no('hareket yok');
  const dir = body > 0 ? 'LONG' : 'SHORT', d = body > 0 ? 1 : -1;
  if (Math.abs(body) / rng < SCALPX.minBodyFrac) return no('gövde zayıf');
  const hi = Math.max.apply(null, P.map(c => c.h)), lo = Math.min.apply(null, P.map(c => c.l));
  if (dir === 'LONG' ? !(L.c > hi) : !(L.c < lo)) return no('kırılım yok');
  const atr = atrLast(cs.slice(0, n - 1), 14); if (!atr) return null;
  const px = L.c, atrPct = atr / px * 100;
  if (atrPct < SCALPX.minAtrPct) return no('volatilite düşük');
  if (atrPct > SCALPX.maxAtrPct) return no('volatilite aşırı');
  const bodyAtr = Math.abs(body) / atr;
  if (bodyAtr < SCALPX.minBodyAtr) return no('gövde ATR küçük');
  const vSma = avg(cs.slice(n - 21, n - 1).map(c => c.v)); if (!(vSma > 0)) return no('hacim yok');
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
  return { dir, entry: rp(px), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 45, 92), holdSec, noMoveSec: 150, maxAgeMs: (holdSec + 300) * 1000, atrPct: +atrPct.toFixed(3), info: { tf, trigger: 'scalp-break', breakLevel: rp(dir === 'LONG' ? hi : lo), volRatio: +vr.toFixed(1), bodyAtr: +bodyAtr.toFixed(2), bodyFrac: +(Math.abs(body) / rng).toFixed(2), ext: +ext.toFixed(2), run: +run.toFixed(2), counterWick: +wick.toFixed(2), atr, atrPct: +atrPct.toFixed(3), slPct: +slPct.toFixed(2), tp1Pct: +tp1Pct.toFixed(2), tp2Pct: +tp2Pct.toFixed(2), netRR: q1.net, netRR2: q2.net, barT: L.t } };
}

function ltCandidates(cs, cs1d, tf, why) {
  const A = analyzeTriangle(cs, true);
  if (!A) { if (why) why['üçgen yok'] = (why['üçgen yok'] || 0) + 1; return null; }
  const { w, m } = A, last = w[m], step = last.t - w[m - 1].t;
  const vS = avg(w.slice(m - 20, m).map(c => c.v)), vr = vS > 0 ? last.v / vS : 0;
  const d1 = (cs1d && cs1d.length >= 30) ? (() => { const ec = emaArr(closes(cs1d), 20); const s1 = ec[ec.length - 1] - ec[ec.length - 4]; return s1 > 0 ? 'UP' : 'DOWN'; })() : null;
  let recentUp = false, recentDn = false;
  for (let k = m - 2; k <= m; k++) { if (w[k].c > A.U(k) * 1.002) recentUp = true; if (w[k].c < A.L(k) * 0.998) recentDn = true; }
  const distU = (A.uN / A.px - 1) * 100, distL = (A.px / A.lN - 1) * 100;
  const nearPct = Math.min(Math.abs(distU), Math.abs(distL));
  const hasBreak = recentUp || recentDn, isNear = nearPct < 1.5 && A.mat > 0.5;
  if (!hasBreak && !isNear) { if (why) why['kırılım/yakınlık yok'] = (why['kırılım/yakınlık yok'] || 0) + 1; return null; }
  if (!hasBreak && isNear) return { watch: true, tf, price: rp(A.px), upper: rp(A.uN), lower: rp(A.lN), mid: rp((A.uN + A.lN) / 2), compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), height: rp(A.w0), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2), nearPct: +nearPct.toFixed(2), nearSide: Math.abs(distU) < Math.abs(distL) ? 'ÜST' : 'ALT', volRatio: +vr.toFixed(2), d1Confirm: d1, lineStep: step };
  const dirHint = recentUp ? 'LONG' : 'SHORT';
  const dd = dirHint === 'LONG' ? 1 : -1, midP = (A.uN + A.lN) / 2;
  let slP = midP;
  if (Math.abs(A.px - slP) < A.px * 0.006 || (A.px - slP) * dd <= 0) slP = A.px - dd * A.px * 0.006;
  const plan = { entry: rp(A.px), sl: rp(slP), tp1: rp(A.px + dd * 0.6 * A.w0), tp2: rp(A.px + dd * A.w0) };
  return { tf, dirHint, plan, yakinlikPct: +nearPct.toFixed(2), price: rp(A.px), upper: rp(A.uN), lower: rp(A.lN), mid: rp((A.uN + A.lN) / 2), compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), height: rp(A.w0), volRatio: +vr.toFixed(2), lineStep: step, breakoutUp: recentUp, breakoutDn: recentDn, d1Confirm: d1, recentCandles: w.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) })) };
}

function trendCandidates(cs, cs4h, why, sym) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; if (sym) logRejSym('TREND', sym, k, {}, 'REJECTED', 'EMA20 geri çekilme + dönüş mumu'); return null; };
  const n = cs.length; if (n < 120) return no('veri kısa');
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = n - 1;
  const atr = atrLast(cs, 14); if (!atr) return null;
  const last = cs[m], px = last.c;
  const adx = adxLast(cs, 14), rsi = rsiLast(cl, 14);
  if (adx == null || adx < 15) return no('adx düşük');
  const slope50 = (e50[m] - e50[m - 6]) / e50[m] * 100;
  let dir = null;
  if (e20[m] > e50[m] && slope50 > 0.02 && px > e20[m]) dir = 'LONG';
  else if (e20[m] < e50[m] && slope50 < -0.02 && px < e20[m]) dir = 'SHORT';
  if (!dir) return no('trend yönü yok');
  let htfAligned = null;
  if (cs4h && cs4h.length >= 55) { const e50_4h = emaArr(closes(cs4h), 50), mm = cs4h.length - 1; htfAligned = (dir === 'LONG' && cs4h[mm].c > e50_4h[mm]) || (dir === 'SHORT' && cs4h[mm].c < e50_4h[mm]); if (htfAligned === false) return no('üst zaman uyumsuz'); }
  const d = dir === 'LONG' ? 1 : -1;
  let touched = false;
  for (let k = m - 10; k < m; k++) if (dir === 'LONG' ? cs[k].l <= e20[k] + 0.35 * atr : cs[k].h >= e20[k] - 0.35 * atr) { touched = true; break; }
  if (!touched) return no('geri çekilme yok');
  if (dir === 'LONG' ? !(last.c > last.o) : !(last.c < last.o)) return no('dönüş mumu yok');
  if (rsi == null || (dir === 'LONG' ? (rsi < 38 || rsi > 72) : (rsi > 62 || rsi < 28))) return no('rsi uygunsuz');
  const distAtr = (px - e20[m]) * d / atr;
  if (distAtr > 2.2) return no('ema20den uzak');
  const recentMove = Math.abs(px - cs[m - 8].c) / atr;
  if (recentMove > 4.0) return no('tükenme riski');
  if (adx > 45 && recentMove > 3.0) return no('aşırı trend');
  const sw = cs.slice(m - 8, m + 1);
  const swing = dir === 'LONG' ? Math.min.apply(null, sw.map(c => c.l)) : Math.max.apply(null, sw.map(c => c.h));
  let sl = swing - d * 0.2 * atr;
  let risk = Math.abs(px - sl); risk = Math.max(risk, px * 0.006);
  if (risk > px * 0.05) return no('stop uzak');
  sl = px - d * risk;
  const vSma = avg(cs.slice(m - 20, m).map(c => c.v));
  return { dir, flipAge: null, price: rp(px), atr: +atr.toFixed(8), atrPct: +(atr / px * 100).toFixed(3), adx: +adx.toFixed(1), rsi: +rsi.toFixed(0), ema20: rp(e20[m]), ema50: rp(e50[m]), distAtr: +distAtr.toFixed(2), volRatio: vSma > 0 ? +(last.v / vSma).toFixed(2) : null, htfAligned, recentMove: +recentMove.toFixed(2), plan: { entry: rp(px), sl: rp(sl), tp1: rp(px + d * 1.5 * risk), tp2: rp(px + d * 2.5 * risk) }, recentCandles: cs.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) })) };
}

function detectDailySweep(cs, lv) {
  if (!cs || cs.length < 40 || !lv) return null;
  if (!(lv.pdh > 0) || !(lv.pdl > 0) || !(lv.pdh > lv.pdl)) return null;
  const n = cs.length, last = cs[n - 1]; const dayKey = dayKeyOf(last.t);
  if (lv.dayKey && lv.dayKey !== dayKey) return null;
  const hour = new Date(last.t).getUTCHours();
  if (hour < DAILY.sessionStart || hour > DAILY.lastEntryHour) return null;
  const dayStart = Math.floor(last.t / D1) * D1, sessionEnd = dayStart + DAILY.sessionEnd * H1;
  const signalAt = last.t + M15, remain = sessionEnd - signalAt;
  if (remain < DAILY.minRemainMs) return null;
  const atr = atrLast(cs, 14); if (!(atr > 0)) return null;
  const rng = last.h - last.l, body = Math.abs(last.c - last.o);
  if (!(rng > 0) || !(body > 0)) return null;
  const below = last.l < lv.pdl && last.c > lv.pdl, above = last.h > lv.pdh && last.c < lv.pdh;
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
  for (let i = Math.max(0, n - 1 - DAILY.sweepLookback); i < n - 1; i++) { if (cs[i].t < dayStart) continue; if (below ? cs[i].l < lv.pdl : cs[i].h > lv.pdh) sweptBefore++; }
  if (DAILY.firstSweepOnly && sweptBefore > 0) return null;
  let sl = below ? last.l - DAILY.stopAtr * atr : last.h + DAILY.stopAtr * atr;
  const minRisk = last.c * DAILY.minRiskPct / 100;
  if (Math.abs(last.c - sl) < minRisk) sl = last.c - d * minRisk;
  const risk = Math.abs(last.c - sl), riskPct = risk / last.c * 100;
  if (riskPct > DAILY.maxRiskPct) return null;
  const e = last.c, midGain = (lv.dayMid - e) * d, midNet = midGain > 0 ? rrNet(e, sl, lv.dayMid).net : -1;
  let tp1 = midGain > 0 && midNet >= DAILY.tp1MidMinR ? lv.dayMid : e + d * DAILY.tp1R * risk;
  const tp1Gain = Math.abs(tp1 - e), opp = below ? lv.pdh : lv.pdl, oppGain = (opp - e) * d;
  let tp2 = oppGain > tp1Gain + 0.4 * risk && rrNet(e, sl, opp).net >= 1.5 ? opp : e + d * DAILY.tp2R * risk;
  if ((tp2 - tp1) * d <= 0) tp2 = tp1 + d * Math.max(0.5 * risk, (e + d * DAILY.tp2R * risk - tp1) * d);
  const q = rrNet(e, sl, tp1);
  if (q.net < DAILY.minNetRR) return null;
  const tp1Mid = Math.abs(tp1 - lv.dayMid) < 1e-9;
  let conf = 55 + clamp((wick / atr - DAILY.minWickAtr) * 25, 0, 10) + clamp((vr - DAILY.minVolX) * 8, 0, 10) + clamp((body / rng - DAILY.minBodyRatio) * 25, 0, 10) + clamp((closePos - DAILY.minClosePos) * 22, 0, 5) + clamp((dayRangePct - DAILY.minDayRangePct) * 1.5, 0, 5);
  const counter = market.dir !== 'NOTR' && market.dir !== dir;
  if (market.dir === dir) conf += 5; else if (counter) conf -= 6;
  if (sweptBefore) conf -= DAILY.repeatPenalty;
  const maxBars = Math.min(Math.ceil(DAILY.maxAge / M15), Math.max(1, Math.floor(remain / M15)));
  return { dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 95), maxAgeMs: Math.min(DAILY.maxAge, remain), maxBars, atrPct: +(atr / e * 100).toFixed(2), info: { tf: '15m', pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid), level: rp(level), sweepSide: below ? 'PDL' : 'PDH', dayKey, wickAtr: +(wick / atr).toFixed(2), wickRatio: +(wick / rng).toFixed(2), bodyRatio: +(body / rng).toFixed(2), closePos: +closePos.toFixed(2), reclaimAtr: +(reclaim / atr).toFixed(2), volRatio: +vr.toFixed(1), dayRangePct: +dayRangePct.toFixed(2), sweptBefore, tp1Mid, atr, atrPct: +(atr / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), netRR: q.net, session: '00:00–23:00 UTC', sessionEnd: new Date(sessionEnd).toISOString(), maxBars } };
}
function dailyWatch(cs, lv) { if (!cs || !cs.length || !lv || !(lv.pdh > 0) || !(lv.pdl > 0)) return null; const last = cs[cs.length - 1], atr = atrLast(cs, 14), price = last.c; if (!(atr > 0) || !(price > 0)) return null; const distPdh = (lv.pdh / price - 1) * 100, distPdl = (price / lv.pdl - 1) * 100; const near = Math.min(Math.abs(distPdh), Math.abs(distPdl)); if (near > Math.max(1.5, 1.5 * (atr / price * 100))) return null; return { symbol: null, price: rp(price), pdh: rp(lv.pdh), pdl: rp(lv.pdl), dayMid: rp(lv.dayMid), distPdh: +distPdh.toFixed(2), distPdl: +distPdl.toFixed(2), nearSide: Math.abs(distPdh) < Math.abs(distPdl) ? 'PDH' : 'PDL', dayRangePct: +((lv.pdh - lv.pdl) / lv.pdl * 100).toFixed(2) }; }
function buildDailyMap(cs1d) { const m = new Map(); for (const d of cs1d || []) { const dayKey = dayKeyOf(d.t + D1); m.set(dayKey, { pdh: d.h, pdl: d.l, dayMid: (d.h + d.l) / 2, dayKey, candleT: d.t }); } return m; }
function buildZones(c1h, c4h) { const pts = []; const add = (cs, L, wt) => { const pv = pivots(cs, L, L); for (const q of pv.hi.concat(pv.lo)) { let s = 0, k = 0; for (let j = Math.max(0, q.i - 20); j < q.i; j++) { s += cs[j].v; k++; } pts.push({ p: q.p, t: cs[q.i].t, vr: k && s > 0 ? cs[q.i].v / (s / k) : 1, w: wt }); } }; add(c1h.slice(-250), 4, 1); if (c4h && c4h.length > 20) add(c4h.slice(-120), 3, 2); pts.sort((a, b) => a.p - b.p); const ref = c1h[c1h.length - 1].t, zones = []; let cur = null; const fin = z => { const touches = z.touches, volW = Math.min(3, z.vr / z.n), ageH = (ref - z.lastT) / H1; const score = touches * 1.5 + volW - Math.min(2, ageH / 150); if (score >= 5) zones.push({ lo: z.min * 0.9985, hi: z.max * 1.0015, mid: (z.min + z.max) / 2, touches, score }); }; for (const q of pts) { if (cur && q.p <= (cur.sum / cur.n) * 1.004) { cur.max = q.p; cur.sum += q.p; cur.n++; cur.touches += q.w; cur.vr += q.vr; cur.lastT = Math.max(cur.lastT, q.t); } else { if (cur) fin(cur); cur = { min: q.p, max: q.p, sum: q.p, n: 1, touches: q.w, vr: q.vr, lastT: q.t }; } } if (cur) fin(cur); return zones; }
function detectZone(cs, zones) { const n = cs.length, out = { signal: null, watch: [] }; if (n < 60 || !zones || !zones.length) return out; const last = cs[n - 1], prev = cs[n - 2], px = last.c, atr = atrLast(cs, 14); if (!atr) return out; const e50 = emaArr(closes(cs), 50), m = n - 1; const slope = (e50[m] - e50[m - 5]) / e50[m] * 100; const vSma = avg(cs.slice(n - 21, n - 1).map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0; const body = Math.abs(last.c - last.o), upW = last.h - Math.max(last.o, last.c), loW = Math.min(last.o, last.c) - last.l; let best = null; for (const z of zones) { const dist = px >= z.lo && px <= z.hi ? 0 : Math.min(Math.abs(px - z.hi), Math.abs(px - z.lo)) / px * 100; if (dist < 1.2) out.watch.push({ lo: rp(z.lo), hi: rp(z.hi), mid: rp(z.mid), score: +z.score.toFixed(1), touches: z.touches, dist: +dist.toFixed(2), side: z.mid < px ? 'DESTEK' : 'DİRENÇ', price: rp(px) }); if (z.score < 6) continue; let dir = null; if (prev.c > z.lo && last.l <= z.hi * 1.002 && last.l >= z.lo * 0.99 && last.c > last.o && last.c > z.mid && loW >= body) dir = 'LONG'; else if (prev.c < z.hi && last.h >= z.lo * 0.998 && last.h <= z.hi * 1.01 && last.c < last.o && last.c < z.mid && upW >= body) dir = 'SHORT'; if (dir === 'LONG' && !(slope >= 0 && px > e50[m] * 0.985)) dir = null; if (dir === 'SHORT' && !(slope <= 0 && px < e50[m] * 1.015)) dir = null; if (dir && vr < 1.2) dir = null; if (dir && (!best || z.score > best.z.score)) best = { z, dir }; } if (best) { const { z, dir } = best, d = dir === 'LONG' ? 1 : -1, e = px; let sl = dir === 'LONG' ? z.lo - 0.3 * atr : z.hi + 0.3 * atr; let R = Math.abs(e - sl); const rFloor = e * Math.max(0.008, EX.SL_COST_K * FEE_ROUNDTRIP / 100); if (R < rFloor) { sl = e - d * rFloor; R = rFloor; } if (R <= e * 0.05) { const opp = zones.filter(o => (dir === 'LONG' ? o.lo > e * 1.003 : o.hi < e * 0.997)).sort((a, b) => (dir === 'LONG' ? a.lo - b.lo : b.hi - a.hi))[0]; let tp1 = e + d * 1.5 * R; if (opp) { const c = dir === 'LONG' ? opp.lo * 0.998 : opp.hi * 1.002; const dd = Math.abs(c - e); if (dd >= R && dd <= 4 * R) tp1 = c; } let tp2 = e + d * 2.5 * R; if ((tp2 - tp1) * d <= 0) tp2 = tp1 + d * R; const q = rrNet(e, sl, tp1); const wick = dir === 'LONG' ? loW : upW; const conf = 52 + Math.min(22, (z.score - 6) * 3) + Math.min(8, wick / Math.max(body, 1e-12) * 2) + Math.min(6, (vr - 1.2) * 4); if (q.net >= 1.0) out.signal = { dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 92), info: { zoneLo: rp(z.lo), zoneHi: rp(z.hi), zoneScore: +z.score.toFixed(1), touches: z.touches, volRatio: +vr.toFixed(1), ema50Slope: +slope.toFixed(2), atr, netRR: q.net, riskPct: q.risk } }; } } return out; }
function detectRange(cs, why) { const sig = detectRevert(cs, why, REVERT.adxMax); if (sig) return { signal: sig }; const n = cs.length; if (n < 80) return {}; const rg = regimeOf(cs); if (rg.adx == null || rg.adx >= REVERT.adxMax || rg.expanding) return {}; const { mid, sd, up, lo } = bandsOf(cs), px = cs[n - 1].c; if (!(sd > 0) || !(mid > 0)) return {}; const dHi = (up / px - 1) * 100, dLo = (px / lo - 1) * 100; if (Math.min(Math.abs(dHi), Math.abs(dLo)) < 0.4) return { watch: { rangeHi: rp(up), rangeLo: rp(lo), price: rp(px), distHi: +dHi.toFixed(2), distLo: +dLo.toFixed(2), nearSide: Math.abs(dHi) < Math.abs(dLo) ? 'ÜST' : 'ALT', squeezeScore: Math.round(100 * clamp(1 - (up - lo) / mid / 0.05, 0, 1)), width: +((up - lo) / mid * 100).toFixed(2) } }; return {}; }

/* ── LT WATCH ── */
function ltWatchRow(sym, cs, tf) {
  const A = analyzeTriangle(cs, true);
  if (!A) return null;
  const { w, m } = A, last = w[m], tfMs = tf === '4h' ? H4 : 2 * H1, now = Date.now();
  const px = priceOf(sym) || A.px;
  const distU = (A.uN / px - 1) * 100, distL = (px / A.lN - 1) * 100;
  const vS = avg(w.slice(m - 20, m).map(c => c.v)), vr = vS > 0 ? last.v / vS : 0;
  let recentUp = false, recentDn = false;
  for (let k = m - 2; k <= m; k++) { if (w[k].c > A.U(k) * 1.002) recentUp = true; if (w[k].c < A.L(k) * 0.998) recentDn = true; }
  const dataAgeMin = Math.round((now - (last.t + tfMs)) / 60000);
  const fresh = dataAgeMin <= Math.round(tfMs / 60000) * 1.3;
  const mom = (last.c / w[m - 3].c - 1) * 100;
  const flow = flowSummary(sym), oi1 = oiChg(sym, 5 * M1);
  let status, phase, dirHint, late = false, trig = false, overshoot = 0;
  const up = recentUp && px > A.uN * 0.998 && !recentDn, dn = recentDn && px < A.lN * 1.002 && !recentUp;
  if (up || dn) {
    overshoot = up ? Math.max(0, (px / A.uN - 1) * 100) : Math.max(0, (A.lN / px - 1) * 100);
    dirHint = up ? 'LONG' : 'SHORT';
    if (overshoot > 2.5) { status = 'GEÇ KALINMIŞ'; phase = 'LATE'; late = true; }
    else if (overshoot >= 0.3 && vr >= 1.2) { status = 'KIRILIM GERÇEKLEŞTİ (hacimli)'; phase = 'CONFIRMED'; trig = true; }
    else { status = 'TEYİT BEKLENİYOR'; phase = 'TRIGGER_PENDING'; }
  } else {
    const nearPct = Math.min(Math.abs(distU), Math.abs(distL));
    dirHint = Math.abs(distU) < Math.abs(distL) ? 'LONG' : 'SHORT';
    if (nearPct <= 1.0 && A.mat >= 0.5) { status = 'KIRILIM YAKLAŞIYOR'; phase = 'PRE_BREAKOUT'; }
    else if (nearPct <= 3.0) { status = 'İZLE'; phase = 'EARLY'; }
    else return null;
  }
  const missing = [];
  if (!flow) missing.push('Agresif akış verisi yok');
  if (oi1 == null) missing.push('OI verisi yok');
  if (!fresh) { status = 'VERİ YETERSİZ'; }
  const dq = !fresh ? 'POOR' : (flow && oi1 != null ? 'GOOD' : 'PARTIAL');
  const nearPct2 = up || dn ? -overshoot : Math.min(Math.abs(distU), Math.abs(distL));
  const volB = vr < 0.8 ? 0 : vr < 1.2 ? 1 : vr < 2 ? 2 : 3;
  return { key: sym + '|' + tf, symbol: sym, base: baseOf(sym), tf, price: rp(px), upper: rp(A.uN), lower: rp(A.lN), distUpper: +distU.toFixed(2), distLower: +distL.toFixed(2), nearPct: +nearPct2.toFixed(2), dirHint, maturity: +A.mat.toFixed(2), compression: +A.comp.toFixed(2), volRatio: +vr.toFixed(2), momentum: +mom.toFixed(2), flow, oi1: oi1 != null ? +oi1.toFixed(2) : null, status, phase, late, triggerConfirmed: trig, overshoot: +overshoot.toFixed(2), dataQuality: dq, dataAgeMin, missingData: missing, updatedAt: now, sig: status + '|' + Math.round(distU * 2) + '|' + Math.round(distL * 2) + '|' + volB };
}
function ltPrompt(r) { const facts = { coin: r.base, zaman: r.tf, fiyat: r.price, ustSinir: r.upper, altSinir: r.lower, ustUzaklikPct: r.distUpper, altUzaklikPct: r.distLower, olgunluk: r.maturity, sikisma: r.compression, hacimOrani: r.volRatio, momentum3MumPct: r.momentum, sistemDurumu: r.status, sistemFazi: r.phase, gecKalinmis: r.late, kirilimAsimiPct: r.overshoot, yonIpucu: r.dirHint, agresifAkis: r.flow || 'YOK', oi5dkPct: r.oi1 == null ? 'YOK' : r.oi1, veriYasiDk: r.dataAgeMin, piyasaYonu: market.dir }; return 'Modül: LT Üçgen (' + r.tf + ')\nÖlçülmüş veriler:\n' + JSON.stringify(facts) + '\nEksik veriler: ' + (r.missingData.join('; ') || 'yok') + '\nSorular:\n- Üçgen geometrisi geçerli mi, sıkışma yeterli mi?\n- Fiyat sınıra yüzde kaç uzakta?\n- Hacim birikim mi daralma mı gösteriyor?\n- Yukarı kırılım hangi koşulla, aşağı kırılım hangi koşulla teyit kazanır?\n- Sahte kırılım ipuçları neler?\n- Hareket uzamışsa geç kalınmış mı?\n- Karar için veri yeterli ve güncel mi?\nKural: Teyitli kırılım yoksa triggerConfirmed anlamı taşıyan ifade kullanma; tetikleyiciyi ölçülebilir yaz (örn. "4s kapanış ' + r.upper + ' üstü + hacim ≥1.2x"). JSON şeması: ' + EV_SCHEMA; }
async function ltWatchCycle() {
  if (!MODS.LT.enabled) return;
  const rows = [];
  await pool(TOP.slice(0, 70), 6, async sym => {
    const best = [];
    const r4 = await getC(sym, '4h', 150);
    if (r4) { const cs = closed(r4, H4); if (cs.length >= 60) { const row = ltWatchRow(sym, cs, '4h'); if (row) best.push(row); } }
    const r1 = await getC(sym, '1h', 300);
    if (r1) { const c1 = closed(r1, H1); let a2 = aggTF(c1, 120); if (a2.length && a2[a2.length - 1].t + H1 > c1[c1.length - 1].t) a2 = a2.slice(0, -1); if (a2.length >= 60) { const row = ltWatchRow(sym, a2, '2h'); if (row) best.push(row); } }
    best.sort((a, b) => Math.abs(a.nearPct) - Math.abs(b.nearPct));
    if (best[0]) rows.push(best[0]);
  });
  const rank = { PRE_BREAKOUT: 0, TRIGGER_PENDING: 1, CONFIRMED: 2, EARLY: 3, LATE: 4 };
  rows.sort((a, b) => ((rank[a.phase] != null ? rank[a.phase] : 5) - (rank[b.phase] != null ? rank[b.phase] : 5)) || (Math.abs(a.nearPct) - Math.abs(b.nearPct)));
  const list = rows.slice(0, 40), seen = new Set(list.map(r => r.symbol));
  for (const r of list) { const st = r.phase === 'LATE' ? 'EXPIRED' : r.phase === 'EARLY' ? 'WATCHING' : r.phase; oppUpdate('LT', r.symbol, r.dirHint, st, r.price, r.status, null); if (r.phase === 'PRE_BREAKOUT' || r.phase === 'TRIGGER_PENDING') outRegister('WATCH', 'LT', r.symbol, r.dirHint, r.price, null); }
  for (const o of Array.from(OPPS.values())) { if (o.mod === 'LT' && ['WATCHING', 'PRE_BREAKOUT', 'TRIGGER_PENDING'].includes(o.state) && !seen.has(o.sym)) oppUpdate('LT', o.sym, null, 'INVALIDATED', null, 'formasyon artık tespit edilmiyor', null); }
  WATCH.lt = list;
  WATCH_META.lt = { at: Date.now(), count: list.length };
  await watchAIRun('LT', list, LT_AI, ltPrompt, 4, true);
}

/* ── TREND WATCH ── */
function trendWatchRow(sym, cs, htfDir) {
  const n = cs.length; if (n < 120) return null;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = n - 1, atr = atrLast(cs, 14);
  if (!atr) return null;
  const px = priceOf(sym) || cs[m].c, adx = adxLast(cs, 14), adx5 = adxLast(cs.slice(0, -5), 14), rsi = rsiLast(cl, 14);
  if (adx == null || adx < 15) return null;
  const slope = (e50[m] - e50[m - 6]) / e50[m] * 100;
  let dir = null;
  if (e20[m] > e50[m] && slope > 0.02) dir = 'LONG'; else if (e20[m] < e50[m] && slope < -0.02) dir = 'SHORT';
  if (!dir) return null;
  const d = dir === 'LONG' ? 1 : -1, distAtr = (px - e20[m]) * d / atr;
  let touched = false;
  for (let k = m - 10; k < m; k++) if (dir === 'LONG' ? cs[k].l <= e20[k] + 0.35 * atr : cs[k].h >= e20[k] - 0.35 * atr) { touched = true; break; }
  const reversal = dir === 'LONG' ? cs[m].c > cs[m].o : cs[m].c < cs[m].o;
  const ext20 = dir === 'LONG' ? Math.max.apply(null, cs.slice(m - 20, m).map(c => c.h)) : Math.min.apply(null, cs.slice(m - 20, m).map(c => c.l));
  const nearExt = (ext20 - px) * d / atr < 0.5 && (ext20 - px) * d / atr >= -0.2;
  let status, phase;
  if (distAtr > 2.2) { status = 'TÜKENME RİSKİ'; phase = 'EXHAUSTION'; }
  else if (adx5 != null && adx < adx5 * 0.9 && adx < 25) { status = 'MOMENTUM ZAYIFLIYOR'; phase = 'EXHAUSTION'; }
  else if (touched && reversal) { status = 'TREND DEVAM'; phase = 'CONTINUATION'; }
  else if (touched) { status = 'DÜZELTME'; phase = 'PULLBACK'; }
  else if (nearExt) { status = 'KIRILIM BEKLENİYOR'; phase = 'PRE_BREAKOUT'; }
  else { status = 'TREND DEVAM'; phase = 'CONTINUATION'; }
  const vS = avg(cs.slice(m - 20, m).map(c => c.v)), vr = vS > 0 ? cs[m].v / vS : 0;
  const flow = flowSummary(sym), oi1 = oiChg(sym, 5 * M1);
  const missing = [];
  if (!flow) missing.push('Agresif akış verisi yok');
  if (oi1 == null) missing.push('OI verisi yok');
  if (!htfDir) missing.push('Üst zaman yönü hesaplanamadı');
  const dataAgeMin = Math.round((Date.now() - (cs[m].t + M15)) / 60000);
  const fresh = dataAgeMin <= 20;
  return { key: sym + '|15m', symbol: sym, base: baseOf(sym), tf: '15m', price: rp(px), dir, status, phase, late: phase === 'EXHAUSTION' && distAtr > 2.2, triggerConfirmed: false, adx: +adx.toFixed(1), adxPrev: adx5 != null ? +adx5.toFixed(1) : null, rsi: rsi != null ? +rsi.toFixed(0) : null, distAtr: +distAtr.toFixed(2), htfDir: htfDir || null, htfAligned: htfDir ? htfDir === dir : null, volRatio: +vr.toFixed(2), flow, oi1: oi1 != null ? +oi1.toFixed(2) : null, dataQuality: !fresh ? 'POOR' : (flow && oi1 != null && htfDir ? 'GOOD' : 'PARTIAL'), dataAgeMin, missingData: missing, updatedAt: Date.now(), sig: status + '|' + dir + '|' + Math.round(distAtr * 2) };
}
function trendPrompt(r) { const facts = { coin: r.base, zaman: '15m', fiyat: r.price, yon: r.dir, sistemDurumu: r.status, sistemFazi: r.phase, adx: r.adx, adx5MumOnce: r.adxPrev, rsi: r.rsi, ema20denUzaklikATR: r.distAtr, ustZamanYon1s: r.htfDir || 'YOK', ustZamanUyumlu: r.htfAligned, hacimOrani: r.volRatio, agresifAkis: r.flow || 'YOK', oi5dkPct: r.oi1 == null ? 'YOK' : r.oi1, veriYasiDk: r.dataAgeMin, piyasaYonu: market.dir }; return 'Modül: Trend (15m)\nÖlçülmüş veriler:\n' + JSON.stringify(facts) + '\nEksik veriler: ' + (r.missingData.join('; ') || 'yok') + '\nSorular:\n- Üst zaman yönü ile 15m momentum uyumlu mu?\n- Hareket trend devamı mı, düzeltme mi, tükenme mi?\n- Fiyat EMA20\'den aşırı uzak mı?\n- Hacim hareketi destekliyor mu?\n- Devam için hangi ölçülebilir koşul, bozulma için hangisi?\n- LONG ve SHORT senaryoları ayrı ayrı hangi veriyle desteklenir?\n- Yeni pozisyon için geç kalınmış mı?\nJSON şeması: ' + EV_SCHEMA; }
async function trendWatchCycle() {
  if (!MODS.TREND.enabled) return;
  const rows = [];
  await pool(TOP.slice(0, 60), 6, async sym => {
    const raw = await getC(sym, '15m', 220); if (!raw) return;
    const cs = closed(raw, M15);
    const r1 = await getC(sym, '1h', 120);
    let htf = null;
    if (r1) { const c1 = closed(r1, H1); if (c1.length >= 60) { const cl = closes(c1), a = emaArr(cl, 20), b = emaArr(cl, 50); htf = a[a.length - 1] > b[b.length - 1] ? 'LONG' : 'SHORT'; } }
    const row = trendWatchRow(sym, cs, htf);
    if (row) rows.push(row);
  });
  rows.sort((a, b) => b.adx - a.adx);
  const list = rows.slice(0, 30);
  for (const r of list) oppUpdate('TREND', r.symbol, r.dir, r.phase === 'PRE_BREAKOUT' ? 'PRE_BREAKOUT' : 'WATCHING', r.price, r.status, null);
  WATCH.trend = list;
  WATCH_META.trend = { at: Date.now(), count: list.length };
  await watchAIRun('TREND', list, TR_AI, trendPrompt, 3, false);
}

/* ── SCALP WATCH ── */
function scalpWatchPush(sym, tf, cs, det, why, spreadPct) {
  try {
    const n = cs.length, L = cs[n - 1], atr = atrLast(cs.slice(0, n - 1), 14);
    if (!atr) return;
    const P = cs.slice(n - 1 - SCALPX.brkBars, n - 1);
    const hi = Math.max.apply(null, P.map(c => c.h)), lo = Math.min.apply(null, P.map(c => c.l));
    const vS = avg(cs.slice(n - 21, n - 1).map(c => c.v)), vr = vS > 0 ? L.v / vS : 0;
    const px = priceOf(sym) || L.c, dHi = (hi - px) / atr, dLo = (px - lo) / atr;
    const kk = (Object.keys(why || {})[0] || '').replace(/^scalp:/, '');
    const near = Math.min(Math.abs(dHi), Math.abs(dLo)), nearDir = Math.abs(dHi) < Math.abs(dLo) ? 'LONG' : 'SHORT', candDir = L.c > L.o ? 'LONG' : 'SHORT';
    let state = null, dir = null;
    if (det) { state = 'ADAY SİNYAL'; dir = det.dir; }
    else if (/geç kalındı|EMA20den uzak/.test(kk)) { state = 'GEÇ KALINMIŞ'; dir = candDir; }
    else if (['ters fitil', 'hacim zayıf', 'net R:R düşük', 'eğim ters', 'gövde ATR küçük'].includes(kk)) { state = 'TEYİT BEKLENİYOR'; dir = candDir; }
    else if (near <= 0.4 && vr >= 1.0) { state = 'KIRILIM YAKLAŞIYOR'; dir = nearDir; }
    else if (near <= 1.0 && vr >= 1.2) { state = 'MOMENTUM OLUŞUYOR'; dir = nearDir; }
    else return;
    const flow = flowSummary(sym);
    SW.set(sym, { key: sym + '|' + tf, symbol: sym, base: baseOf(sym), tf, state, dir, price: rp(px), volRatio: +vr.toFixed(2), distHiAtr: +dHi.toFixed(2), distLoAtr: +dLo.toFixed(2), mom1: +((L.c / cs[n - 2].c - 1) * 100).toFixed(2), mom3: +((L.c / cs[n - 4].c - 1) * 100).toFixed(2), spreadPct: +Number(spreadPct || 0).toFixed(3), reason: kk || null, flow, missingData: flow ? [] : ['Agresif akış verisi yok'], updatedAt: Date.now() });
    oppUpdate('PUMP', sym, dir, state === 'ADAY SİNYAL' ? 'TRIGGER_PENDING' : state === 'KIRILIM YAKLAŞIYOR' ? 'PRE_BREAKOUT' : state === 'GEÇ KALINMIŞ' ? 'EXPIRED' : 'WATCHING', px, state, null);
    if (SW.size > 80) { const arr = Array.from(SW.values()).sort((a, b) => a.updatedAt - b.updatedAt); for (let i = 0; i < arr.length - 80; i++) SW.delete(arr[i].symbol); }
    WATCH_META.scalp = { at: Date.now(), count: SW.size };
  } catch (e) { }
}
function watchItems(kind) {
  const now = Date.now();
  if (kind === 'lt') return (WATCH.lt || []).map(r => Object.assign({}, r, { ai: aiView(LT_AI.get(r.key), r.sig), ageSec: Math.round((now - r.updatedAt) / 1000) }));
  if (kind === 'trend') return (WATCH.trend || []).map(r => Object.assign({}, r, { ai: aiView(TR_AI.get(r.key), r.sig), ageSec: Math.round((now - r.updatedAt) / 1000) }));
  if (kind === 'scalp') { const rank = { 'ADAY SİNYAL': 0, 'KIRILIM YAKLAŞIYOR': 1, 'TEYİT BEKLENİYOR': 2, 'MOMENTUM OLUŞUYOR': 3, 'GEÇ KALINMIŞ': 4 }; return Array.from(SW.values()).filter(r => now - r.updatedAt < 12 * M1).sort((a, b) => (rank[a.state] - rank[b.state]) || (b.updatedAt - a.updatedAt)).slice(0, 40).map(r => Object.assign({}, r, { ageSec: Math.round((now - r.updatedAt) / 1000), flow: flowSummary(r.symbol) })); }
  return WATCH[kind] || [];
}

/* ── SNAP / RING / STREAM ── */
const SNAP = {}, RING = new Map(), OI = new Map(), ATRC = new Map(), ARMED = new Set(), lastBurstChk = {};
function snapAt(h, t) { if (!h || !h.length) return null; let lo = 0, hi = h.length - 1, res = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m].t <= t) { res = m; lo = m + 1; } else hi = m - 1; } return res >= 0 ? h[res] : null; }
function pushSnap(sym, ts, price, qv) { if (!(price > 0)) return; let h = SNAP[sym]; if (!h) h = SNAP[sym] = []; const last = h[h.length - 1]; if (last && ts - last.t < 900) { last.p = price; if (qv != null) last.qv = Number(qv); return; } h.push({ t: ts, p: price, qv: qv != null ? Number(qv) : null }); const cut = ts - PUMP.snapKeepMs; let drop = 0; while (drop < h.length && h[drop].t < cut) drop++; if (drop > 64) h.splice(0, drop); }
function pushOI(sym, ts, v) { if (!(v > 0)) return; let a = OI.get(sym); if (!a) { a = []; OI.set(sym, a); } const last = a[a.length - 1]; if (last && ts - last.t < 5000) { last.v = v; return; } a.push({ t: ts, v }); const cut = ts - 15 * M1; let drop = 0; while (drop < a.length && a[drop].t < cut) drop++; if (drop > 16) a.splice(0, drop); if (a.length > 400) a.splice(0, a.length - 400); }
function oiChg(sym, ms) { const a = OI.get(sym); if (!a || a.length < 2) return null; const now = a[a.length - 1]; let ref = null; for (const x of a) { if (x.t >= now.t - ms) { ref = x; break; } } if (!ref || ref === now || !(ref.v > 0)) return null; return (now.v / ref.v - 1) * 100; }
function ringOf(sym) { let r = RING.get(sym); if (!r) { r = { t: [], p: [] }; RING.set(sym, r); } return r; }
function ringPush(sym, ts, price) { if (!(price > 0) || !isFinite(price)) return; const r = ringOf(sym); const n = r.p.length; if (n && ts <= r.t[n - 1]) { r.p[n - 1] = price; return; } r.p.push(price); r.t.push(ts); const cut = ts - EX.VEL_PEAK_MEMORY_MS; let drop = 0; while (drop < r.t.length && r.t[drop] < cut) drop++; if (drop > 64) { r.t.splice(0, drop); r.p.splice(0, drop); } if (r.p.length > 2000) { r.t.splice(0, 400); r.p.splice(0, 400); } }
function ringAt(r, ts) { const t = r.t; let lo = 0, hi = t.length - 1, res = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res >= 0 ? r.p[res] : null; }
function ringMove(r, winMs, now) { const n = r.p.length; if (n < 2) return 0; const ref = ringAt(r, now - winMs); if (!(ref > 0)) return 0; return (r.p[n - 1] / ref - 1) * 100; }
function getWS() { if (globalThis.WebSocket) return globalThis.WebSocket; try { return require('ws'); } catch (e) { return null; } }
class BitgetStream {
  constructor(url) { this.url = url || 'wss://ws.bitget.com/v2/ws/public'; this.ws = null; this.subs = new Set(); this.backoff = 1000; this.pingTimer = null; this.reconnectTimer = null; this.closed = false; }
  start() { const WS = getWS(); if (!WS) { log('WS yok → REST'); return; } this.closed = false; try { this.ws = new WS(this.url); } catch (e) { log('WS hata: ' + e.message); return; } this.ws.onopen = () => { this.backoff = 1000; log('WS bağlı (' + this.subs.size + ')'); this._flush(); this.pingTimer = setInterval(() => this._send('ping'), 25000); }; this.ws.onmessage = ev => { const raw = typeof ev === 'string' ? ev : (ev && ev.data); if (!raw || raw === 'pong' || raw === 'ping') return; let msg; try { msg = JSON.parse(raw); } catch (e) { return; } this._onMsg(msg); }; this.ws.onerror = () => { }; this.ws.onclose = () => { clearInterval(this.pingTimer); this.pingTimer = null; if (this.closed) return; this.backoff = Math.min(this.backoff * 2, 30000); log('WS koptu ' + (this.backoff / 1000) + 's'); this.reconnectTimer = setTimeout(() => this.start(), this.backoff); }; }
  stop() { this.closed = true; clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); try { if (this.ws) this.ws.close(); } catch (e) { } }
  _send(o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { } }
  _args(keys) { return keys.map(k => { const a = k.split('|'); return { instType: 'USDT-FUTURES', channel: a[0], instId: a[1] }; }); }
  _batch(keys) { for (let i = 0; i < keys.length; i += 20) this._send({ op: 'subscribe', args: this._args(keys.slice(i, i + 20)) }); }
  _flush() { if (this.subs.size) this._batch(Array.from(this.subs)); }
  setSymbols(symbols) { const want = new Set(); for (const sym of symbols) { const inst = String(sym).split('/')[0] + 'USDT'; want.add('ticker|' + inst); want.add('trade|' + inst); } for (const k of Array.from(this.subs)) { if (want.has(k)) continue; this.subs.delete(k); this._send({ op: 'unsubscribe', args: this._args([k]) }); } const add = []; for (const k of want) if (!this.subs.has(k)) { this.subs.add(k); add.push(k); } if (add.length) this._batch(add); }
  _onMsg(msg) { if (msg.op === 'pong' || msg.op === 'ping') return; if (msg.event === 'error' || (msg.code && String(msg.code) !== '0')) return; const arg = msg.arg, data = msg.data; if (!arg || !Array.isArray(data)) return; const sym = String(arg.instId).replace(/USDT$/, '') + '/USDT:USDT'; const now = Date.now(); if (arg.channel === 'ticker') { for (const d of data) ingestTicker(sym, d, now); } else if (arg.channel === 'trade') { for (const d of data) ingestTrade(sym, d); } }
}
const stream = new BitgetStream();
const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
function ingestTicker(sym, d, now) { const last = num(d.lastPr); if (!(last > 0)) return; const prev = TICK[sym] || {}; const bid = num(d.bidPr) || last, ask = num(d.askPr) || last; const qv = num(d.quoteVolume) || prev.quoteVolume || 0; const oi = num(d.holdingAmount) || prev.oi || null; TICK[sym] = { last, bid, ask, quoteVolume: qv, percentage: d.change24h != null ? num(d.change24h) : (prev.percentage || 0), timestamp: now, oi }; pushSnap(sym, now, last, qv); pushOI(sym, now, oi); ringPush(sym, now, last); }
function ingestTrade(sym, d) {
  const price = num(d.price), size = num(d.size), side = String(d.side || '').toLowerCase();
  if (!(price > 0) || !(size > 0)) return;
  const notional = price * size;
  const ts = num(d.ts) || Date.now();
  flowSideOnTrade(sym, ts, side, notional);
}

function microBars(sym, now, count) { const s = SNAP[sym]; if (!s || s.length < 8) return null; const B = PUMP.barMs, out = []; for (let i = 0; i < s.length; i++) { const x = s[i]; if (!(x.p > 0)) continue; const b = Math.floor(x.t / B) * B; const last = out[out.length - 1]; if (!last || last.t !== b) { out.push({ t: b, o: x.p, h: x.p, l: x.p, c: x.p, qv0: x.qv, qv1: x.qv, n: 1, trunc: false }); } else { if (x.p > last.h) last.h = x.p; if (x.p < last.l) last.l = x.p; last.c = x.p; if (x.qv != null) last.qv1 = x.qv; last.n++; } } if (!out.length) return null; if (s[0].t > out[0].t + 1) out[0].trunc = true; const tail = out.slice(-(count || 40)); return tail.length ? tail : null; }
function zOf(sym, now, winMs) { const s = SNAP[sym]; if (!s || s.length < 24) return 0; const a = snapAt(s, now - winMs); const last = s[s.length - 1]; if (!a || !(a.p > 0) || now - a.t > winMs + 2500) return 0; const move = Math.abs(last.p / a.p - 1) * 100; const cutoff = now - winMs, floor = now - 60000; let n = 0, mean = 0, m2 = 0, dtSum = 0; for (let i = 1; i < s.length; i++) { if (s[i].t > cutoff) break; if (s[i].t < floor) continue; const p0 = s[i - 1].p, p1 = s[i].p; if (!(p0 > 0) || !(p1 > 0)) continue; const r = (p1 / p0 - 1) * 100; n++; const d = r - mean; mean += d / n; m2 += d * (r - mean); dtSum += Math.max(1, s[i].t - s[i - 1].t); } if (n < PUMP.vel.minNoiseN) return 0; const sd = Math.sqrt(m2 / Math.max(1, n - 1)); const dt = Math.max(250, dtSum / n); return move / Math.max(sd * Math.sqrt(winMs / dt), 0.03); }
function volumeBurst(sym, now) { const fb = (() => { const f = FLOWS.get(sym); if (!f) return null; const nowB = Math.floor(now / 1000) * 1000; let recent = 0, recentN = 0; for (let k = nowB - 3000; k <= nowB; k += 1000) { const c = f.b[k]; if (c) { recent += c.buy + c.sell; recentN += c.n; } } let baseSum = 0, baseN = 0; for (let k = nowB - 60000; k < nowB - 10000; k += 1000) { const c = f.b[k]; if (c) { baseSum += c.buy + c.sell; baseN++; } } if (baseN < 20 || !(baseSum > 0)) return null; const basePerShort = (baseSum / baseN) * 3; return basePerShort > 0 ? recent / basePerShort : null; })(); if (fb != null && isFinite(fb)) return fb; const s = SNAP[sym]; if (!s || s.length < 12) return null; const last = s[s.length - 1]; const a = snapAt(s, now - 3000); const c = snapAt(s, now - 60000); const d = snapAt(s, now - 10000); if (!a || !c || !d || a.qv == null || last.qv == null || c.qv == null || d.qv == null) return null; const recentMs = last.t - a.t, baseSpan = d.t - c.t; if (!(recentMs > 400) || !(baseSpan > 20000)) return null; const rf = (last.qv - a.qv) / recentMs, bf = (d.qv - c.qv) / baseSpan; if (!(bf > 0) || !(rf > 0)) return null; return rf / bf; }
function priorRunPct(sym, now, d, ms) { const s = SNAP[sym]; if (!s || s.length < 6) return 0; const a = snapAt(s, now - ms); const end = snapAt(s, now - 20000); if (!a || !end || !(a.p > 0)) return 0; return (end.p / a.p - 1) * d * 100; }
function ignition(sym, now) { const mb = microBars(sym, now, 40); if (!mb || mb.length < PUMP.coilBars + 2) return null; const f = mb[mb.length - 1]; const ctx = mb.slice(0, -1).filter(b => !b.trunc); if (ctx.length < PUMP.coilBars) return null; const win = ctx.slice(-PUMP.coilBars); let hiN = -Infinity, loN = Infinity; for (let i = 0; i < win.length; i++) { if (win[i].h > hiN) hiN = win[i].h; if (win[i].l < loN) loN = win[i].l; } if (!(loN > 0) || !(hiN > loN)) return null; const preRng = (hiN / loN - 1) * 100; if (preRng > PUMP.coilMaxPct) return null; const rng = f.h - f.l; if (!(rng > 0)) return null; const body = (f.c - f.o) / rng; const up = f.c > hiN && body >= PUMP.bodyMin, dn = f.c < loN && body <= -PUMP.bodyMin; if (!up && !dn) return null; const dir = up ? 'LONG' : 'SHORT', d = up ? 1 : -1; const origin = up ? hiN : loN; const disp = (f.c / origin - 1) * d * 100; if (!(disp >= PUMP.dispMinPct)) return null; const vBurst = volumeBurst(sym, now); if (vBurst == null) return null; if (vBurst < PUMP.vel.minVolRatio) return null; const z = zOf(sym, now, 4000); if (z < PUMP.vel.minZ) return null; const priorRun = priorRunPct(sym, now, d, 90000); if (priorRun > PUMP.vel.priorMaxPct) return null; return { dir, origin, disp, z, vBurst, preRng, body: Math.abs(body), priorRun }; }
function entryGuard(sym, ig) { if (PUMP.macroFilter && market.dir !== 'NOTR' && ig.dir !== market.dir) { const strongL = market.dir === 'LONG' && market.score > 0.75, strongS = market.dir === 'SHORT' && market.score < 0.25; if (strongL || strongS) return { ok: false, reject: 'ters' }; } const bk = bookOf(sym); if (!bk) return { ok: false, reject: 'no-book' }; if (!(bk.ask > 0) || !(bk.bid > 0) || !(bk.ask >= bk.bid)) return { ok: false, reject: 'bad-book' }; const spreadPct = ((bk.ask - bk.bid) / bk.last) * 100; if (!(spreadPct <= PUMP.maxSpreadPct)) return { ok: false, reject: 'spread' }; const d = ig.dir === 'LONG' ? 1 : -1; const fill = ig.dir === 'LONG' ? bk.ask : bk.bid; const latePct = (fill / ig.origin - 1) * d * 100; if (!(latePct > -0.05)) return { ok: false, reject: 'stale-origin' }; const A = expectedLeg(sym); if (A == null) return { ok: false, reject: 'no-atr' }; const oi1 = oiChg(sym, 60000); if (oi1 != null && oi1 < -2.0) return { ok: false, reject: 'oi-dusuyor' }; const cap = clamp(PUMP.vel.lateCapFrac * A, PUMP.vel.lateCapMin, PUMP.vel.lateCapMax); if (latePct > cap) return { ok: false, reject: 'late' }; if (A - latePct < PUMP.vel.minEdgeMult * FEE_ROUNDTRIP) return { ok: false, reject: 'no-edge' }; const atrPct = atrPctOf(sym); const slRaw = ig.dir === 'LONG' ? ig.origin * (1 - PUMP.vel.slBufferPct / 100) : ig.origin * (1 + PUMP.vel.slBufferPct / 100); const slStruct = Math.abs(fill - slRaw) / fill * 100; const slFloor = Math.max(EX.MIN_SL_PCT, PUMP.vel.slAtrK * atrPct, PUMP.vel.slCostK * FEE_ROUNDTRIP); const slPct = Math.min(Math.max(slStruct, slFloor), PUMP.vel.slMax); const sl = fill * (1 - d * slPct / 100); const tpPct = clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX); const tp = fill * (1 + d * tpPct / 100); const netRR = (tpPct - FEE_ROUNDTRIP) / (slPct + FEE_ROUNDTRIP); if (netRR < PUMP.vel.minNetRR) return { ok: false, reject: 'net-rr' }; if (spreadPct > 0.40 * slPct) return { ok: false, reject: 'spread-wide' }; return { ok: true, dir: ig.dir, fill: rp(fill), sl: rp(sl), tp: rp(tp), latePct: +latePct.toFixed(3), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2), netRR: +netRR.toFixed(2), A: +A.toFixed(2), spreadPct: +spreadPct.toFixed(3), originPx: rp(ig.origin), oi1: oi1 != null ? +oi1.toFixed(2) : null }; }
function scoreConfidence(ig, g) { const c = 60 + clamp((ig.z - PUMP.vel.minZ) * 2.0, 0, 12) + clamp((ig.vBurst - PUMP.vel.minVolRatio) * 3.0, 0, 12) + clamp((g.A - g.latePct - PUMP.vel.minEdgeMult * FEE_ROUNDTRIP) * 6, 0, 8) + clamp((g.netRR - PUMP.vel.minNetRR) * 6, 0, 5); return clamp(Math.round(c), 40, 95); }
function pumpScanVel(now) { if (!ARMED.size) return; for (const sym of ARMED) { const prev = lastBurstChk[sym]; if (prev && now - prev < PUMP.recheckMs) continue; const ig = ignition(sym, now); if (!ig) continue; stats.pumpScanned++; lastBurstChk[sym] = now; const g = entryGuard(sym, ig); if (!g.ok) { PWHY['guard:' + g.reject] = (PWHY['guard:' + g.reject] || 0) + 1; continue; } const det = { module: 'PUMP', symbol: sym, dir: g.dir, entry: g.fill, sl: g.sl, tp1: g.tp, tp2: null, single: true, conf: scoreConfidence(ig, g), holdSec: EX.HOLD, noMoveSec: EX.NO_MOVE, maxAgeMs: (EX.HOLD + 30) * 1000, atrPct: atrPctOf(sym), info: { tf: 'ignition', trigger: 'coil-break', originPx: g.originPx, latePct: g.latePct, disp: +ig.disp.toFixed(3), z: +ig.z.toFixed(1), vBurst: +ig.vBurst.toFixed(2), preRng: +ig.preRng.toFixed(2), body: +ig.body.toFixed(2), spreadPct: g.spreadPct, slPct: g.slPct, tpPct: g.tpPct, netRR: g.netRR, expectedLeg: g.A, oi1: g.oi1, lastPx: rp(bookOf(sym).last) } }; addSignal(det); } }
function atrPctFromCandles(cs, p) { p = p || 14; if (!cs || cs.length < p + 2) return null; let s = 0; for (let i = 1; i <= p; i++) { const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); s += tr; } let a = s / p; for (let i = p + 1; i < cs.length; i++) { const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)); a = (a * (p - 1) + tr) / p; } return cs[cs.length - 1].c > 0 ? (a / cs[cs.length - 1].c) * 100 : null; }
function setAtr(sym, atrPct) { if (!(atrPct > 0)) return; ATRC.set(sym, { atrPct: clamp(atrPct, 0.05, 8), at: Date.now() }); }
function atrPctOf(sym) { const a = ATRC.get(sym); return a && a.atrPct > 0 && Date.now() - a.at < 5 * M1 ? a.atrPct : 0.55; }
function expectedLeg(sym) { const a = ATRC.get(sym); if (!a || !(a.atrPct > 0) || Date.now() - a.at > 5 * M1) return null; return clamp(EX.TP_ATR_K * a.atrPct, 0.35, 3.0); }
async function refreshAtr() { const q = Array.from(ARMED); const workers = Array.from({ length: Math.min(6, q.length) }, async () => { while (q.length) { const sym = q.pop(); try { const raw = await ex.fetchOHLCV(sym, '1m', undefined, 40); if (!raw || raw.length < 20) continue; const pct = atrPctFromCandles(raw.map(toC), 14); if (pct) setAtr(sym, pct); } catch (e) { } } }); await Promise.all(workers); }
const ARM_SEEN = new Map();
function refreshArmed() { const now = Date.now(); for (const sym of ALL) { const tk = TICK[sym]; if (!tk || !(tk.last > 0) || !(quoteVolOf(tk) >= PUMP.minQuoteVol)) continue; const bid = tk.bid > 0 ? tk.bid : tk.last, ask = tk.ask > 0 ? tk.ask : tk.last; if (!(ask >= bid) || ((ask - bid) / tk.last) * 100 > PUMP.maxSpreadPct) continue; const s = SNAP[sym]; if (!s || s.length < PUMP.vel.minHist) continue; ARM_SEEN.set(sym, now); } ARMED.clear(); for (const [sym, ts] of ARM_SEEN) { if (now - ts > 180000) { ARM_SEEN.delete(sym); continue; } const s = SNAP[sym]; if (s && s.length >= PUMP.vel.minHist) ARMED.add(sym); } stream.setSymbols(ARMED); }
function prunePumpState(now) { for (const sym of Object.keys(SNAP)) { const h = SNAP[sym]; if (!h.length || now - h[h.length - 1].t > 10 * M1) delete SNAP[sym]; } for (const [sym, r] of RING) { let drop = 0; const cut = now - EX.VEL_PEAK_MEMORY_MS; while (drop < r.t.length && r.t[drop] < cut) drop++; if (drop) { r.t.splice(0, drop); r.p.splice(0, drop); } if (!r.p.length) RING.delete(sym); } for (const [sym, f] of FLOWS) { const cut = now - 130000; for (const k of Object.keys(f.b)) if (Number(k) < cut) delete f.b[k]; if (!Object.keys(f.b).length) FLOWS.delete(sym); } for (const [sym, t] of DAILY_ASKED) if (now - t > 2 * H1) DAILY_ASKED.delete(sym); }

/* ── Utilities ── */
function quoteVolOf(t) { if (!t) return 0; const q = Number(t.quoteVolume); if (isFinite(q) && q > 0) return q; const b = Number(t.baseVolume), px = Number(t.last); return isFinite(b) && b > 0 && isFinite(px) && px > 0 ? b * px : 0; }
async function refreshTickers() { const t = await ex.fetchTickers(); for (const k in t) { const x = t[k]; if (x && x.last && k.endsWith('/USDT:USDT')) TICK[k] = Object.assign({}, TICK[k], x); } stats.tickAt = Date.now(); const now = stats.tickAt; for (const sym in TICK) { const x = TICK[sym]; if (!x || !(x.last > 0)) continue; pushSnap(sym, now, x.last, x.quoteVolume); ringPush(sym, now, x.last); } }
async function getC(sym, tf, limit, ttl) { const key = sym + '|' + tf, e = CACHE.get(key), now = Date.now(), tt = ttl != null ? ttl : TTL[tf]; if (e && now - e.t < tt && e.limit >= limit) return e.data.slice(-limit); try { const raw = await ex.fetchOHLCV(sym, tf, undefined, limit); if (!raw || !raw.length) return e ? e.data.slice(-limit) : null; const data = raw.map(toC); CACHE.set(key, { t: now, limit, data }); return data; } catch (err) { stats.apiErr++; return e ? e.data.slice(-limit) : null; } }
async function fetchHistory(sym, tf, total) { const ms = TF_MS[tf]; let since = Date.now() - total * ms, out = []; try { for (let g = 0; g < 40 && out.length < total; g++) { const b = await ex.fetchOHLCV(sym, tf, since, 200); if (!b || !b.length) break; out = out.concat(b); const lastT = b[b.length - 1][0]; if (lastT + ms >= Date.now() || b.length < 2) break; since = lastT + ms; } } catch (e) { } if (out.length < 50) { try { out = await ex.fetchOHLCV(sym, tf, undefined, 500); } catch (e) { return []; } } const seen = new Set(), res = []; for (const a of out) { if (!seen.has(a[0])) { seen.add(a[0]); res.push(toC(a)); } } res.sort((a, b) => a.t - b.t); return res; }
async function refreshUniverse() { await refreshTickers(); const list = [], skipped = []; for (const k in ex.markets) { const m = ex.markets[k]; if (m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false && TICK[m.symbol]) { if (!ALLOW_TOKENIZED && isTokenized(baseOf(m.symbol))) { skipped.push(baseOf(m.symbol)); continue; } list.push(m.symbol); } } list.sort((a, b) => quoteVolOf(TICK[b]) - quoteVolOf(TICK[a])); ALL = list; TOP = list.slice(0, 120); stats.excluded = skipped.length; log('Evren: ' + ALL.length + ' sözleşme, ' + TOP.length + ' taranıyor' + (skipped.length ? ' | dışlanan: ' + skipped.length : '')); }
function isOpenSignal(s) { return !!s && (s.status === 'AKTIF' || s.status === 'AI_BEKLIYOR' || s.status === 'ONAY_BEKLIYOR'); }
function analyzeSignal(sig) { const mod = sig.module, dir = sig.dir, info = sig.info || {}, conf = Number(sig.conf) || 0, price = Number(sig.entry) || 0; const riskPct = info.riskPct != null ? Number(info.riskPct) : (price > 0 ? Math.abs(price - sig.sl) / price * 100 : 0); const rr = info.netRR != null ? Number(info.netRR) : (price > 0 ? rrNet(price, sig.sl, sig.tp1).net : 0); const counter = market.dir !== 'NOTR' && market.dir !== dir, aligned = market.dir !== 'NOTR' && market.dir === dir; const reasons = [], risks = []; let score = clamp(conf, 0, 100); if (mod === 'LT') { if (Number(info.volRatio) >= 1.5) { score += 5; reasons.push('Hacim ' + Number(info.volRatio).toFixed(1) + 'x'); } if (rr < 1.2) { score -= 8; risks.push('Net R:R ' + rr.toFixed(2)); } } else if (mod === 'PUMP') { if (info.trigger === 'scalp-break') reasons.push(info.tf + ' kırılım'); if (Number(info.counterWick) > 0.25) { score -= 4; risks.push('Ters fitil'); } } else if (mod === 'TREND') { if (Number(info.adx) >= 25) score += 4; if (info.htfAligned === false) { score -= 5; risks.push('Üst zaman uyumsuz'); } } if (counter) { score -= 6; risks.push('Piyasa yönüne ters'); } else if (aligned) { score += 4; reasons.push('Piyasa uyumlu'); } if (riskPct > 2.5) risks.push('Risk %' + riskPct.toFixed(2)); score = Math.round(clamp(score, 0, 100)); return { source: 'kural', verdict: score >= 60 ? 'ONY' : 'RED', verdictLabel: score >= 60 ? 'GİRİLİR' : 'GİRİLMEZ', score, riskLevel: riskPct > 1.8 ? 'YÜKSEK' : riskPct > 1.0 ? 'ORTA' : 'DÜŞÜK', marketView: 'Piyasa ' + market.dir, summary: MODS[mod].label + ' ' + dir + ' · güven ' + sig.conf, reasons: reasons.slice(0, 8), risks: risks.slice(0, 6), at: Date.now() }; }
function analyzeMarket() { const m = market || {}, score = Math.round(clamp((m.score || 0.5) * 100, 0, 100)); return { source: 'kural', verdict: score >= 50 ? 'ONY' : 'RED', verdictLabel: score >= 50 ? 'GİRİLİR' : 'GİRİLMEZ', score, summary: 'Piyasa skoru ' + score + '/100', at: Date.now() }; }

function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = baseOf(sym);
  if (M.maxPerDaySym) { const dayStart = Math.floor(t / D1) * D1; const cnt = signals.filter(s => s.module === mod && s.symbol === sym && s.createdAt >= dayStart).length; if (cnt >= M.maxPerDaySym) { BLK['günlük limit'] = (BLK['günlük limit'] || 0) + 1; return false; } }
  if (raw.retest) { const actLT = signals.filter(s => s.module === mod && s.symbol === sym && isOpenSignal(s)); if (actLT.some(s => s.dir !== dir)) return false; if (actLT.some(s => s.info && s.info.retest)) return false; }
  else if (signals.some(s => s.module === mod && s.symbol === sym && (isOpenSignal(s) || (s.dir === dir && t - (s.closedAt || s.createdAt) < M.cooldown)))) return false;
  const act = signals.filter(isOpenSignal);
  const counter = market.dir !== 'NOTR' && dir !== market.dir;
  const align = market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU');
  if (counter && (mod === 'PUMP' || mod === 'SCALPER')) { BLK['piyasa ters'] = (BLK['piyasa ters'] || 0) + 1; return false; }
  const same = act.filter(s => s.symbol === sym && s.dir === dir && s.module !== mod);
  const bonus = Math.min(25, same.length * 12);
  const base0 = raw.conf - (counter ? 6 : 0);
  const pumpGate = mod === 'PUMP' ? { state: 'PENDING', queuedAt: t, expiresAt: t + AI.pumpWaitMs, minScore: AI.pumpMinScore } : null;
  const sig = { id: 'S' + (++sigSeq), module: mod, symbol: sym, base, sector: sectorOf(base), dir, entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single, tp1Hit: false, baseConf: base0, confBonus: bonus, conf: clamp(Math.round(base0 + bonus), 30, 99), counter, marketAlign: align, confl: same.map(s => s.module), info: raw.info || {}, status: pumpGate ? 'AI_BEKLIYOR' : 'AKTIF', result: null, aiGate: pumpGate, createdAt: t, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0, holdSec: raw.holdSec, noMoveSec: raw.noMoveSec, quickTpPct: raw.quickTpPct, quickTimeSec: raw.quickTimeSec, quickArmPct: raw.quickArmPct, retest: !!raw.retest, atrPct: raw.atrPct, velSeries: [], peakPct: null };
  if (sig.info && sig.info.source === 'ai') { sig.ai = { verdict: 'ONY', entryDecision: 'APPROVE', trust: sig.info.aiTrust || 'ORTA', score: sig.info.aiScore != null ? sig.info.aiScore : sig.conf, reason: sig.info.reason || '', summary: sig.info.reason || '', risks: sig.info.risks || [], provider: sig.info.provider, providerName: sig.info.providerName, model: sig.info.model, latencyMs: sig.info.latencyMs, at: t, source: 'ai' }; }
  sig.analysis = analyzeSignal(sig);
  signals.push(sig); dirty = true;
  onSignalAdded(sig); /* v81 hook */
  log('SİNYAL: ' + M.label + ' | ' + base + ' | ' + dir + ' | güven ' + sig.conf + ' | ' + align + (pumpGate ? ' | AI BEKLİYOR' : ''));
  if (mod === 'PUMP') { stats.pumpFound++; if (aiReady()) queueAI(sig); else { sig.aiGate = Object.assign({}, sig.aiGate, { state: 'OFFLINE', note: 'AI kapalı', decidedAt: Date.now() }); sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI.approvalWindowMs; dirty = true; } }
  else if (mod === 'DAILY' && AI.modules.includes(mod) && !(sig.info && sig.info.source === 'ai')) queueAI(sig);
  return true;
}
function emit(mod, sym, det, last, tfMs, maxLag) { sc(mod, 'aday'); if (Date.now() - (last.t + tfMs) > maxLag) { sc(mod, 'mum eski'); return false; } const px = priceOf(sym), atr = det.info && det.info.atr; if (px && atr && Math.abs(px - det.entry) > 0.50 * atr) { sc(mod, 'fiyat uzaklaştı'); return false; } const ok = addSignal(Object.assign({ module: mod, symbol: sym }, det)); sc(mod, ok ? 'sinyal' : 'engel/cooldown'); return ok; }
function closeSignal(s, price, reason) { if (s.status === 'KAPALI') return; s.status = 'KAPALI'; s.result = reason; s.exit = rp(price); s.closedAt = Date.now(); const r = calcR(s, price); s.grossR = +r.gross.toFixed(3); s.netR = +r.net.toFixed(3); s.pnlPct = +(((price / s.entry - 1) * (s.dir === 'LONG' ? 1 : -1)) * 100).toFixed(3); dirty = true; oppUpdate(s.module, s.symbol, null, 'EXPIRED', price, 'kapandı: ' + reason, null); log('SİNYAL KAPANDI: ' + MODS[s.module].label + ' ' + s.base + ' → ' + (REASON[reason] || reason)); }

/* ── AI Signal (v82 + katı) ── */
const SYSTEM_PROMPTS = {
  PUMP: 'Sen AlphaSon AlgoScalp süzgecisin. 3-5 dakikalık kırılım scalp sinyali geldi. Açık bir sorun YOKSA GİRİLİR de. Şunlarda GİRİLMEZ: kırılım sahte (uzun ters fitil + hemen geri dönüş), fiyat zaten çok uzamış (>=2.5 ATR), hacim sönük, spread geniş. Yalnızca JSON döndür.',
  LT: 'Sen AlphaSon LT Üçgen asistanısın. Kırılım henüz OLMAMIŞSA "GİRİLMEZ" + score 30-50 ver. Net kırılım varsa + hacim >=1.5x + üst zaman uyumluysa GİRİLİR. Yalnızca JSON döndür.',
  TREND: 'Sen AlphaSon Trend asistanısın. EMA20/50 trendinde geri çekilme adayı. Trendin gerçek mi, düzeltme mi, tükenme mi olduğunu ayırt et. 15m trend 4h trend ile uyumlu mu? Yalnızca JSON döndür.',
  DAILY: 'Sen AlphaSon Günlük Sweep asistanısın. PDH/PDL fitille süpürüldü, içeri kapanış var. Gerçek süpürme mi yoksa kalıcı kırılım mı? Yalnızca JSON döndür.',
  SCALPER: 'Sen AlphaSon Scalper asistanısın. Kısa vadeli momentum adayı. Yalnızca JSON döndür.',
  RANGE: 'Sen AlphaSon Range asistanısın. Yalnızca JSON döndür.',
  ZONE: 'Sen AlphaSon Zone asistanısın. Yalnızca JSON döndür.'
};
const COMMON_JSON_HINT = 'JSON: {"verdict":"GİRİLİR|GİRİLMEZ","decision":"CONFIRMED|WATCH|REJECTED","phase":"PRE_BREAKOUT|TRIGGER_PENDING|BREAKOUT_CONFIRMED|LATE|INVALIDATED","direction":"LONG|SHORT|NEUTRAL","score":0,"confidence":"YÜKSEK|ORTA|DÜŞÜK","dataQuality":"GOOD|FAIR|POOR","lateEntry":false,"triggerConfirmed":false,"entryAllowed":false,"reason":"tek kısa cümle","evidence":["gözlem"],"missingConditions":["eksik"],"risks":["risk"],"bullishScenario":"","bearishScenario":"","triggerCondition":"","invalidationCondition":"","summary":"2-3 cümle"}. Başka anahtar KULLANMA.';

function parseAIJSON(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(raw.slice(a, b + 1)); } catch (e) { j = null; } }
  const arr = x => { if (Array.isArray(x)) return x.map(v => String(v)).filter(Boolean).slice(0, 6); if (typeof x === 'string' && x.trim()) return x.split(/[\n;\u2022]/).map(v => v.trim()).filter(Boolean).slice(0, 6); return []; };
  if (!j || typeof j !== 'object') { return { verdict: 'RED', decision: 'REJECTED', phase: 'INVALIDATED', direction: 'NEUTRAL', score: 0, trust: 'DÜŞÜK', confidence: 'DÜŞÜK', riskLevel: 'ORTA', entryDecision: 'REJECT', entryAllowed: false, triggerConfirmed: false, lateEntry: false, dataQuality: 'POOR', summary: 'AI yanıtı anlaşılamadı.', reasons: [], risks: ['AI JSON değil'], evidence: [], missingConditions: [], bullishScenario: '', bearishScenario: '', triggerCondition: '', invalidationCondition: '', reason: '', parseError: true }; }
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
  let dq = String(j.dataQuality || '').toUpperCase(); if (!['GOOD', 'FAIR', 'POOR'].includes(dq)) dq = 'FAIR';
  const decisionRaw2 = String(j.entryDecision || '').toUpperCase().replace(/\s+/g, '_');
  const DMAP = { APPROVE: 'APPROVE', ONAY: 'APPROVE', REJECT: 'REJECT', RED: 'REJECT' };
  const entryDecision = DMAP[decisionRaw2] || (verdict === 'ONY' ? 'APPROVE' : 'REJECT');
  return { verdict, decision, phase, direction, score, trust: tr, confidence: tr, riskLevel, dataQuality: dq, entryDecision, entryAllowed: j.entryAllowed === true, triggerConfirmed: j.triggerConfirmed === true, lateEntry: j.lateEntry === true, stopLossPct: Number(j.stopLossPct) || null, takeProfitPct: Number(j.takeProfitPct) || null, takeProfit2Pct: Number(j.takeProfit2Pct) || null, maxHoldSec: Number(j.maxHoldSec) || null, noMoveSec: Number(j.noMoveSec) || null, quickArmPct: Number(j.quickArmPct) || null, exitStyle: ['FAST', 'BALANCED', 'TRAIL', 'SCALE_OUT'].includes(String(j.exitStyle || '').toUpperCase()) ? String(j.exitStyle).toUpperCase() : 'FAST', marketView: String(j.marketView || '').slice(0, 400), summary: String(j.summary || j.reason || '').slice(0, 600), reason: String(j.reason || '').slice(0, 300), reasons: arr(j.reasons || j.evidence || j.reason), evidence: arr(j.evidence), missingConditions: arr(j.missingConditions), risks: arr(j.risks), bullishScenario: String(j.bullishScenario || '').slice(0, 400), bearishScenario: String(j.bearishScenario || '').slice(0, 400), triggerCondition: String(j.triggerCondition || '').slice(0, 300), invalidationCondition: String(j.invalidationCondition || '').slice(0, 300), suggested: String(j.suggested || j.plan || '').slice(0, 500), invalidation: String(j.invalidation || j.invalidationCondition || '').slice(0, 400), timeHorizon: String(j.timeHorizon || '').slice(0, 100), drivers: arr(j.drivers), ideas: Array.isArray(j.ideas) ? j.ideas.slice(0, 4).map(x => ({ coin: String(x && x.coin || '').toUpperCase().slice(0, 12), dir: String(x && x.dir || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG', reason: String(x && x.reason || '').slice(0, 200) })).filter(x => x.coin) : [] };
}

async function buildAIContext(sig) {
  if (sig.module === 'PUMP' && sig.info && sig.info.trigger === 'scalp-break') { const tf0 = sig.info.tf || '3m'; const raw0 = await getC(sig.symbol, tf0, 50, 15000); const cs0 = raw0 ? closed(raw0, TF_MS[tf0]).slice(-13) : []; if (!cs0.length) return '(veri yok)'; const vs = avg(cs0.slice(0, -1).map(c => c.v)) || 1; return cs0.map(c => { const chg = (c.c / c.o - 1) * 100, up = (c.h - Math.max(c.o, c.c)) / Math.max(c.h - c.l, 1e-12) * 100, dn = (Math.min(c.o, c.c) - c.l) / Math.max(c.h - c.l, 1e-12) * 100; return new Date(c.t).toISOString().slice(11, 16) + ' değişim ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% üst fitil ' + up.toFixed(0) + '% alt fitil ' + dn.toFixed(0) + '% hacim x' + (c.v / vs).toFixed(1); }).join('\n'); }
  const tf = sig.module === 'TREND' ? '15m' : sig.module === 'LT' ? (sig.info && sig.info.tf === '2h' ? '2h' : '4h') : '15m';
  const fetchTf = tf === '2h' ? '1h' : tf;
  const raw = await getC(sig.symbol, fetchTf, 60, 2 * M1);
  let cs = raw ? closed(raw, TF_MS[fetchTf] || M15) : [];
  if (tf === '2h') cs = aggTF(cs, 120);
  if (cs.length > 25) cs = cs.slice(-25);
  return cs.map(c => { const t = new Date(c.t).toISOString().replace('T', ' ').slice(0, 16), p = c.c >= 1 ? 4 : 6; return `${t} O${c.o.toFixed(p)} H${c.h.toFixed(p)} L${c.l.toFixed(p)} C${c.c.toFixed(p)}`; }).join('\n');
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
  const head = `${MODS[sig.module].label} sinyali: ${sig.base} ${sig.dir}\nFiyat: ${sig.entry}, Stop: ${sig.sl}, Hedef: ${sig.tp1}\nGüven: ${sig.conf}/100\nPiyasa: ${market.dir} (skor ${Number(market.score || 0.5).toFixed(2)})${sig.info && sig.info.tf ? '\nTF: ' + sig.info.tf : ''}${flowLine(sig.symbol)}`;
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
      log('AI: ' + MODS[sig.module].label + ' ' + sig.base + ' → ' + sig.ai.verdict + ' · ' + sig.ai.phase + ' · ' + sig.ai.score + ' (' + p.name + ')');
      return finalizePumpAIApproval(sig, sig.ai);
    } catch (e) { lastErr = e; providerFail(p, e); }
  }
  sig.ai = Object.assign({}, sig.ai || {}, { error: 'AI sağlayıcıları yanıt vermedi', at: Date.now() });
  aiUsage.lastError = redact(lastErr && lastErr.message || 'sağlayıcı yok'); aiUsage.lastAt = Date.now(); dirty = true; saveAI();
  return finalizePumpAIApproval(sig, sig.ai);
}
function declinePumpAI(sig, reason, note) { if (!sig || sig.module !== 'PUMP' || sig.status !== 'AI_BEKLIYOR') return false; sig.status = 'KAPALI'; sig.result = reason; sig.closedAt = Date.now(); sig.exit = null; sig.netR = null; sig.grossR = null; sig.pnlPct = null; sig.aiGate = Object.assign({}, sig.aiGate || {}, { state: 'REJECTED', reason, note: note || '', decidedAt: Date.now() }); dirty = true; oppUpdate('PUMP', sig.symbol, null, 'REJECTED', sig.entry, note || reason, null); log('ALGOPUMP AI GİRİLMEZ: ' + sig.base + ' → ' + (note || reason)); return true; }

function finalizePumpAIApproval(sig, ai) {
  if (!sig || sig.module !== 'PUMP' || !sig.aiGate || sig.aiGate.state !== 'PENDING') return ai;
  const now = Date.now();
  if (now >= sig.aiGate.expiresAt) { declinePumpAI(sig, 'AI_TIMEOUT', 'AI yetişmedi'); return null; }
  if (!ai || ai.error) { sig.aiGate = Object.assign({}, sig.aiGate, { state: 'OFFLINE', note: (ai && ai.error) || 'AI yanıtı yok', decidedAt: now }); sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + AI.approvalWindowMs; dirty = true; return null; }
  const failures = [];
  if (ai.verdict !== 'ONY') failures.push('verdict=' + ai.verdict);
  if (ai.entryDecision !== 'APPROVE') failures.push('entryDecision=' + ai.entryDecision);
  if (Number(ai.score) < AI.pumpMinScore) failures.push('score=' + ai.score + '<' + AI.pumpMinScore);
  if (ai.riskLevel === 'YÜKSEK') failures.push('riskLevel=YÜKSEK');
  if (AI.requireEntryAllowed && ai.entryAllowed !== true) failures.push('entryAllowed!=true');
  if (AI.requireTriggerConfirmed && ai.triggerConfirmed !== true) failures.push('triggerConfirmed!=true');
  if (AI.rejectLateEntry && ai.lateEntry === true) failures.push('lateEntry=true');
  if (failures.length > 0) { declinePumpAI(sig, 'AI_RED', 'AI GİRİLMEZ [' + failures.join(', ') + ']' + (ai.reason ? ' — ' + ai.reason : '')); return null; }
  const i = sig.info || {}, d = sig.dir === 'LONG' ? 1 : -1;
  const scalp = i.trigger === 'scalp-break';
  const lvPx = entryPx(sig.symbol, sig.dir);
  if (lvPx > 0) { const drift = Math.abs(lvPx / sig.entry - 1) * 100; if (drift > (scalp ? Math.max(AI.pumpEntryDriftPct, 0.35) : AI.pumpEntryDriftPct)) { declinePumpAI(sig, 'AI_STALE', 'fiyat %' + drift.toFixed(2) + ' kaçtı'); return null; } sig.entry = rp(lvPx); }
  let stopPct, tp1Pct, tp2Pct = null, maxHoldSec, noMoveSec, quickArmPct = null, netRR;
  if (scalp) { stopPct = clamp(Number(ai.stopLossPct) > 0 ? Number(ai.stopLossPct) : (Number(i.slPct) || SCALPX.slMin), SCALPX.slMin, SCALPX.slMax); tp1Pct = clamp(Number(ai.takeProfitPct) > 0 ? Number(ai.takeProfitPct) : (Number(i.tp1Pct) || 0.5), SCALPX.tp1Min, SCALPX.tp1Max); tp2Pct = clamp(Number(ai.takeProfit2Pct) > 0 ? Number(ai.takeProfit2Pct) : (Number(i.tp2Pct) || tp1Pct * SCALPX.tp2Mult), tp1Pct * 1.5, 3.0); maxHoldSec = Math.round(clamp(Number(ai.maxHoldSec) > 0 ? Number(ai.maxHoldSec) : (SCALPX.holdMs[i.tf] || 9 * M1) / 1000, 120, 900)); noMoveSec = Math.round(clamp(Number(ai.noMoveSec) > 0 ? Number(ai.noMoveSec) : 150, 60, Math.max(60, maxHoldSec - 60))); netRR = (tp1Pct - FEE_ROUNDTRIP) / (stopPct + FEE_ROUNDTRIP); if (netRR < 0.25) { declinePumpAI(sig, 'AI_RED', 'net R:R düşük'); return null; } }
  else { const hardStop = Math.max(EX.MIN_SL_PCT, EX.SL_COST_K * FEE_ROUNDTRIP); stopPct = clamp(Number(ai.stopLossPct) > 0 ? Number(ai.stopLossPct) : (Number(i.slPct) || hardStop), hardStop, EX.TP_MAX); const minTp = Math.max(EX.QUICK_TP_MIN, FEE_ROUNDTRIP + 0.10); tp1Pct = clamp(Number(ai.takeProfitPct) > 0 ? Number(ai.takeProfitPct) : (Number(i.quickTpPct) || minTp), minTp, Math.min(EX.QUICK_TP_MAX, 0.70)); maxHoldSec = Math.round(clamp(Number(ai.maxHoldSec) > 0 ? Number(ai.maxHoldSec) : EX.HOLD, 20, 90)); noMoveSec = Math.round(clamp(Number(ai.noMoveSec) > 0 ? Number(ai.noMoveSec) : Math.min(EX.NO_MOVE, maxHoldSec - 5), 10, Math.max(10, maxHoldSec - 5))); quickArmPct = +clamp(Number(ai.quickArmPct) > 0 ? Number(ai.quickArmPct) : Math.min(EX.QUICK_ARM, tp1Pct - 0.05), 0.08, Math.max(0.08, tp1Pct - 0.05)).toFixed(2); netRR = (tp1Pct - FEE_ROUNDTRIP) / (stopPct + FEE_ROUNDTRIP); if (netRR < 0.20) { declinePumpAI(sig, 'AI_RED', 'net R:R düşük'); return null; } }
  sig.sl = rp(sig.entry * (1 - d * stopPct / 100)); sig.curSl = sig.sl;
  sig.tp1 = rp(sig.entry * (1 + d * tp1Pct / 100));
  if (scalp) { sig.tp2 = rp(sig.entry * (1 + d * tp2Pct / 100)); sig.single = false; sig.scalpMode = true; delete sig.quickTpPct; delete sig.quickTimeSec; delete sig.quickArmPct; }
  else { sig.quickTpPct = +tp1Pct.toFixed(2); sig.quickTimeSec = maxHoldSec; sig.quickArmPct = quickArmPct; }
  sig.holdSec = maxHoldSec; sig.noMoveSec = noMoveSec; sig.maxAgeMs = (maxHoldSec + 300) * 1000;
  sig.info = Object.assign({}, i, { aiStopPct: +stopPct.toFixed(2), aiTakeProfitPct: +tp1Pct.toFixed(2), aiTakeProfit2Pct: tp2Pct != null ? +tp2Pct.toFixed(2) : null, aiMaxHoldSec: maxHoldSec, aiNoMoveSec: noMoveSec, aiQuickArmPct: quickArmPct, aiExitStyle: scalp ? 'SCALE_OUT' : ai.exitStyle, aiNetRR: +netRR.toFixed(2) });
  sig.aiGate = Object.assign({}, sig.aiGate, { state: 'APPROVED', decidedAt: now, score: ai.score, trust: ai.trust || 'ORTA', reason: ai.reason || ai.summary || '', provider: ai.provider, plan: { stopPct: +stopPct.toFixed(2), takeProfitPct: +tp1Pct.toFixed(2), takeProfit2Pct: tp2Pct != null ? +tp2Pct.toFixed(2) : null, maxHoldSec, noMoveSec, exitStyle: scalp ? 'SCALE_OUT' : ai.exitStyle } });
  sig.analysis = analyzeSignal(sig); dirty = true;
  const openPump = paper.open.filter(p => p.module === 'PUMP').length + opening.size;
  const canAuto = settings.auto === true && openPump < AI.autoMaxOpen;
  if (canAuto) { sig.status = 'AKTIF'; sig.startedAt = now; sig.operatorApprovedAt = now; log('ALGOPUMP AI GİRİLİR (OTO): ' + sig.base + ' ' + sig.dir); maybeOpenPaper(sig).then(err => { if (err) { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = Date.now() + AI.approvalWindowMs; delete sig.startedAt; delete sig.operatorApprovedAt; dirty = true; log('ALGOPUMP OTO HATA: ' + sig.base + ' → ' + err); } }).catch(e => log('HATA oto: ' + e.message)); }
  else { sig.status = 'ONAY_BEKLIYOR'; sig.approvalExpiresAt = now + AI.approvalWindowMs; log('ALGOPUMP AI GİRİLİR (ONAY): ' + sig.base + ' ' + sig.dir + ' → ONAY BEKLİYOR'); }
  return ai;
}
function queueAI(sig, opts) { if (!sig || !AI.modules.includes(sig.module) || !aiReady()) return; if (AI_QUEUE.some(x => x.id === sig.id)) return; if (sig.module === 'PUMP') { aiReview(sig, opts || {}).catch(e => log('AI PUMP HATA: ' + redact(e.message))); return; } AI_QUEUE.push({ id: sig.id, force: !!(opts && opts.force), at: Date.now() }); if (AI_QUEUE.length > 40) AI_QUEUE.splice(40); runAIQueue(); }
async function runAIQueue() { if (aiBusy) return; aiBusy = true; try { while (AI_QUEUE.length) { const job = AI_QUEUE.shift(), sig = signals.find(s => s.id === job.id); if (!sig) continue; try { await aiReview(sig, { force: job.force }); } catch (e) { log('AI KUYRUK: ' + redact(e.message)); } } } finally { aiBusy = false; } }

/* v81: aiAskSignal raw + inflight dedup */
async function aiAskSignalRaw(module, symbol, cand, tf, extraCtx) {
  if (!aiReady() || !aiQuota().ok || !aiReserveOk(AI.nonPumpShare)) return null;
  const sys = SYSTEM_PROMPTS[module] + '\n\n' + COMMON_JSON_HINT;
  const ctx = (cand.recentCandles || []).map(c => `${new Date(c.t).toISOString().replace('T', ' ').slice(0, 16)} O${c.o} H${c.h} L${c.l} C${c.c} V${c.v}`).join('\n');
  const extra = { price: cand.price, upper: cand.upper, lower: cand.lower, compression: cand.compression, maturity: cand.maturity, height: cand.height, volRatio: cand.volRatio, yakinlikPct: cand.yakinlikPct, breakoutUp: cand.breakoutUp, breakoutDn: cand.breakoutDn, plan: cand.plan };
  const user = `${MODS[module].label} adayı: ${baseOf(symbol)} ${cand.tf}\nFiyat: ${cand.price}\nEk: ${JSON.stringify(extra)}${flowLine(symbol)}\n\nSon mumlar:\n${ctx}\n\nSinyal VAR MI? Yalnızca JSON.`;
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
      if (parsed.verdict !== 'ONY' || parsed.score < 55 || parsed.entryAllowed !== true || parsed.triggerConfirmed !== true || parsed.lateEntry === true) {
        oppUpdate(module, symbol, null, parsed.lateEntry ? 'REJECTED' : 'WATCHING', null, parsed.reason || 'AI reddi', null);
        logAIRej(module, symbol, { none: true, reason: parsed.reason }, cand.price);
        return { none: true, reason: parsed.reason };
      }
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
async function aiAskSignal(module, symbol, cand, tf, extraCtx) {
  const ik = module + '|' + symbol;
  if (AI_INFLIGHT.has(ik)) return null;
  AI_INFLIGHT.add(ik);
  try { return await aiAskSignalRaw(module, symbol, cand, tf, extraCtx); }
  finally { AI_INFLIGHT.delete(ik); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCANS
   ═══════════════════════════════════════════════════════════════════════════ */
const SCALP_SEEN = new Set();
async function scalpScanX() {
  if (!SCALPX.enabled || !MODS.PUMP.enabled) return;
  const found = [];
  await pool(TOP.slice(0, SCALPX.topN), 6, async sym => {
    const tk = TICK[sym]; if (!tk || quoteVolOf(tk) < SCALPX.minQuoteVol) { PWHY['hacim düşük'] = (PWHY['hacim düşük'] || 0) + 1; return; }
    const bk = bookOf(sym); if (!bk) return;
    const spreadPct = (bk.ask - bk.bid) / bk.last * 100;
    if (spreadPct > SCALPX.maxSpreadPct) { PWHY['spread geniş'] = (PWHY['spread geniş'] || 0) + 1; return; }
    for (const tf of SCALPX.tfs) {
      const ms = TF_MS[tf], raw = await getC(sym, tf, 80, ms >= M5 ? 40000 : 25000); if (!raw) continue;
      const cs = closed(raw, ms); if (cs.length < 50) continue;
      const last = cs[cs.length - 1], age = Date.now() - (last.t + ms);
      if (age > SCALPX.maxLagMs[tf] || age < -2000) continue;
      const key = sym + '|' + tf + '|' + last.t;
      if (SCALP_SEEN.has(key)) continue;
      SCALP_SEEN.add(key);
      stats.pumpScanned++; sc('PUMP', 'taranan');
      const subWhy = {};
      const det = detectScalpX(cs, tf, subWhy, sym);
      mergeWhy(PWHY, subWhy);
      scalpWatchPush(sym, tf, cs, det, subWhy, spreadPct); /* v81 hook */
      if (!det) continue;
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
    if (drift > SCALPX.maxDriftAtr) continue;
    det.entry = rp(fill); det.sl = rp(fill * (1 - d * det.info.slPct / 100)); det.tp1 = rp(fill * (1 + d * det.info.tp1Pct / 100)); det.tp2 = rp(fill * (1 + d * det.info.tp2Pct / 100));
    if (addSignal(Object.assign({ module: 'PUMP', symbol: sym }, det))) added++;
  }
}
async function scanScalper() {
  if (!MODS.SCALPER.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '15m', 120); if (!raw) return;
    const cs = closed(raw, M15); if (cs.length < 80) return;
    sc('SCALPER', 'taranan');
    const flow = flowSummary(sym);
    const flowRatio = flow && flow.w30.sell > 0 ? flow.w30.buy / flow.w30.sell : null;
    const det = detectScalper(cs, SWHY, 0.5, flowRatio);
    if (!det) { logRejWhy('SCALPER', sym, SWHY, cs[cs.length - 1].c); return; }
    if (det.conf < SCALP.minConf) return;
    cands.push({ sym, det, last: cs[cs.length - 1] });
  });
  cands.sort((a, b) => b.det.conf - a.det.conf);
  for (const c of cands) emit('SCALPER', c.sym, c.det, c.last, M15, 6 * M1);
}
async function scanRange() {
  if (!MODS.RANGE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '15m', 170); if (!raw) return;
    const cs = closed(raw, M15); if (cs.length < 120) return;
    const r = detectRange(cs, RWHY);
    if (r.watch) watch.push(Object.assign({ symbol: sym, base: baseOf(sym) }, r.watch));
    if (r.signal && r.signal.conf >= REVERT.minConf) emit('RANGE', sym, r.signal, cs[cs.length - 1], M15, 12 * M1);
  });
  watch.sort((a, b) => b.squeezeScore - a.squeezeScore);
  WATCH.range = watch.slice(0, 40);
}
async function scanZone() {
  if (!MODS.ZONE.enabled) return;
  const watch = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const r1 = await getC(sym, '1h', 260); if (!r1) return;
    const c1 = closed(r1, H1); if (c1.length < 100) return;
    const r4 = await getC(sym, '4h', 130);
    const c4 = r4 ? closed(r4, H4) : null;
    const res = detectZone(c1, buildZones(c1, c4));
    res.watch.forEach(w => watch.push(Object.assign({ symbol: sym, base: baseOf(sym) }, w)));
    if (res.signal) emit('ZONE', sym, res.signal, c1[c1.length - 1], H1, 55 * M1);
  });
  watch.sort((a, b) => a.dist - b.dist);
  WATCH.zone = watch.slice(0, 40);
}
async function scanTrendSignals() {
  if (!MODS.TREND.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 100), 6, async sym => {
    const raw = await getC(sym, '15m', 220); if (!raw) return;
    const cs = closed(raw, M15); if (cs.length < 120) return;
    const raw4 = await getC(sym, '4h', 100);
    const cs4 = raw4 ? closed(raw4, H4) : null;
    sc('TREND', 'taranan');
    const cand = trendCandidates(cs, cs4, TWHY, sym); if (cand) cands.push({ sym, cand });
  });
  cands.sort((a, b) => (b.cand.volRatio || 0) - (a.cand.volRatio || 0));
  for (const c of cands.filter(c => !signals.some(s => s.module === 'TREND' && s.symbol === c.sym && isOpenSignal(s))).filter(c => market.dir === 'NOTR' || c.cand.dir === market.dir || c.cand.adx >= 22).slice(0, AI.aiTrendCandidatesMax)) {
    const det = await aiAskSignal('TREND', c.sym, c.cand, '15m', null);
    if (!det || det.none) { sc('TREND', 'ai-red'); continue; }
    addSignal(Object.assign({ module: 'TREND', symbol: c.sym, retest: false }, det));
  }
}
async function scanLTSignals() {
  if (!MODS.LT.enabled) return;
  const cands = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const r4 = await getC(sym, '4h', 150);
    if (r4) { const cs = closed(r4, H4); if (cs.length >= 60) { sc('LT', 'taranan'); const cand = ltCandTracked(sym, cs, '4h'); if (cand && !cand.watch) cands.push({ sym, cand }); } }
    const r1 = await getC(sym, '1h', 300);
    if (r1) { const c1 = closed(r1, H1); let a2 = aggTF(c1, 120); if (a2.length && a2[a2.length - 1].t + H1 > c1[c1.length - 1].t) a2 = a2.slice(0, -1); if (a2.length >= 60) { sc('LT', 'taranan'); const cand = ltCandTracked(sym, a2, '2h'); if (cand && !cand.watch) cands.push({ sym, cand }); } }
  });
  for (const c of cands.sort((a, b) => b.cand.maturity - a.cand.maturity).slice(0, AI.aiLTCandidatesMax)) {
    if (signals.some(s => s.module === 'LT' && s.symbol === c.sym && isOpenSignal(s))) continue;
    const det = await aiAskSignal('LT', c.sym, c.cand, c.cand.tf, null);
    if (!det || det.none) continue;
    addSignal(Object.assign({ module: 'LT', symbol: c.sym, retest: false }, det));
  }
}
async function getDailyLevels(sym) { const now = Date.now(), dayKey = dayKeyOf(now), hit = DAILY_LEVELS.get(sym); if (hit && hit.dayKey === dayKey && now - hit.at < 90 * M1) return hit; const raw = await getC(sym, '1d', 5, 60 * M1); if (!raw || raw.length < 2) return null; const cs = closed(raw, D1); if (!cs.length) return null; const d = cs[cs.length - 1]; if (!(d.h > d.l) || !(d.l > 0)) return null; const lv = { sym, dayKey, pdh: d.h, pdl: d.l, dayMid: (d.h + d.l) / 2, candleT: d.t, at: now, rangePct: +((d.h - d.l) / d.l * 100).toFixed(2) }; DAILY_LEVELS.set(sym, lv); return lv; }
async function refreshDailyLevels() { if (!MODS.DAILY.enabled) return; const syms = TOP.slice(0, DAILY.topN); let ok = 0; await pool(syms, 6, async sym => { const lv = await getDailyLevels(sym); if (lv) ok++; }); log('Günlük seviyeler: ' + ok + '/' + syms.length); }
async function scanDaily() {
  if (!MODS.DAILY.enabled) return;
  const watch = [], found = [];
  await pool(TOP.slice(0, DAILY.topN), 6, async sym => {
    const raw = await getC(sym, '15m', 120, 150000); if (!raw) return;
    const cs = closed(raw, M15); if (cs.length < 40) return;
    const last = cs[cs.length - 1]; if (Date.now() - (last.t + M15) > 9 * M1) return;
    const lv = await getDailyLevels(sym); if (!lv) return;
    sc('DAILY', 'taranan');
    const det = detectDailySweep(cs, lv);
    if (det) { if (det.conf < DAILY.minConf) return; found.push({ sym, det, cs, last }); }
    else { const w = dailyWatch(cs, lv); if (w) watch.push(Object.assign({ symbol: sym, base: baseOf(sym) }, w)); }
  });
  watch.sort((a, b) => Math.min(Math.abs(a.distPdh), Math.abs(a.distPdl)) - Math.min(Math.abs(b.distPdh), Math.abs(b.distPdl)));
  WATCH.daily = watch.slice(0, 40);
  found.sort((a, b) => b.det.conf - a.det.conf);
  for (const f of found) {
    const t = Date.now(); if (t - (f.last.t + M15) > 9 * M1) continue;
    if (signals.some(s => s.module === 'DAILY' && s.symbol === f.sym && isOpenSignal(s))) continue;
    const ak = DAILY_ASKED.get(f.sym); if (ak && t - ak < 30 * M1) continue;
    if (!aiReady()) { emit('DAILY', f.sym, f.det, f.last, M15, 9 * M1); continue; }
    DAILY_ASKED.set(f.sym, t);
    const cand = { price: f.det.entry, recentCandles: f.cs.slice(-12).map(c => ({ t: c.t, o: rp(c.o), h: rp(c.h), l: rp(c.l), c: rp(c.c), v: Math.round(c.v) })) };
    const ai = await aiAskSignal('DAILY', f.sym, cand, '15m', null);
    if (!ai) { emit('DAILY', f.sym, f.det, f.last, M15, 9 * M1); continue; }
    if (ai.none) continue;
    const merged = Object.assign({}, f.det, ai, { module: 'DAILY', symbol: f.sym, maxAgeMs: f.det.maxAgeMs, atrPct: f.det.atrPct });
    merged.info = Object.assign({}, f.det.info, ai.info);
    addSignal(merged);
  }
}
function ltRetestCycle() {
  if (!MODS.LT.enabled) return;
  const now = Date.now();
  for (const [key, e] of Array.from(LTR)) {
    if (!e || !e.sym || !(e.step > 0)) { LTR.delete(key); continue; }
    const x = (now - e.lineT) / e.step; if (x > 12.5) { LTR.delete(key); saveLTR(); continue; }
    const px = priceOf(e.sym); if (!(px > 0)) continue;
    const line = e.line0 + e.slope * x; if (!(line > 0)) { LTR.delete(key); continue; }
    const d = e.dir === 'LONG' ? 1 : -1, dist = (px / line - 1) * 100 * d;
    const atrPct = e.atrPct || 1, tol = Math.max(0.15, 0.25 * atrPct), fail = Math.max(0.35, 0.50 * atrPct);
    if (dist < -fail) { e.failCount = (e.failCount || 0) + 1; if (e.failCount >= 2) { LTR.delete(key); saveLTR(); } continue; }
    e.failCount = 0;
    if (!e.armed) { if (dist >= Math.max(0.45, 0.60 * atrPct)) { e.armed = true; saveLTR(); } continue; }
    if (dist > tol) continue;
    const entry = line, slPct = Math.max(0.50, 0.50 * atrPct), sl = entry * (1 - d * slPct / 100);
    const tp1 = entry + d * 0.60 * e.height, tp2 = entry + d * e.height;
    const q = rrNet(entry, sl, tp1);
    const conf = clamp(62 + (e.tf === '2h' ? 6 : 0) + clamp((e.height / entry * 100 - 1) * 4, 0, 10), 40, 92);
    addSignal({ module: 'LT', symbol: e.sym, dir: e.dir, entry: rp(entry), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf, retest: true, info: { retest: true, tf: e.tf, line: rp(line), distPct: +dist.toFixed(2), height: rp(e.height), mid: rp(e.mid), netRR: q.net, riskPct: q.risk } });
    e.lastAlertAt = now; saveLTR();
    log('LT RETEST: ' + e.base + ' ' + e.dir);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MARKET / RADAR / BRIEF
   ═══════════════════════════════════════════════════════════════════════════ */
function emaScore(cs) { if (!cs || cs.length < 60) return null; const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cl.length - 1; return ((cl[m] > e50[m] ? 1 : 0) + (e20[m] > e50[m] ? 1 : 0) + (e50[m] > e50[m - 6] ? 1 : 0) + (cl[m] > e20[m] ? 1 : 0)) / 4; }
async function marketCycle() {
  const emaS = [];
  for (const [key, sym] of [['btc', 'BTC/USDT:USDT'], ['eth', 'ETH/USDT:USDT']]) {
    const tk = TICK[sym], chg = tk && tk.percentage != null ? Number(tk.percentage) : null;
    if (tk) market[key] = { price: tk.last, change: chg != null ? +chg.toFixed(2) : null };
    const r1 = await getC(sym, '1h', 120), r4 = await getC(sym, '4h', 120);
    const a = r1 ? emaScore(closed(r1, H1)) : null, b = r4 ? emaScore(closed(r4, H4)) : null;
    if (a != null) emaS.push(a); if (b != null) emaS.push(b);
  }
  const trfPct = emaS.length ? avg(emaS) : 0.5;
  let a1 = 0, n1 = 0, up24 = 0, n24 = 0;
  await pool(TOP.slice(0, 60), 8, async sym => {
    const tk = TICK[sym];
    if (tk && tk.percentage != null) { n24++; if (Number(tk.percentage) > 0) up24++; }
    const a = await getC(sym, '1h', 60);
    if (a) { const c = closed(a, H1); if (c.length >= 25) { const e = emaArr(closes(c), 20); n1++; if (c[c.length - 1].c > e[e.length - 1]) a1++; } }
  });
  const b1 = n1 ? a1 / n1 : 0.5, bp = n24 ? up24 / n24 : 0.5;
  const breadth = 0.60 * b1 + 0.40 * bp, score = 0.5 * trfPct + 0.5 * breadth;
  let dir = market.dir;
  if (score > 0.58) dir = 'LONG'; else if (score < 0.42) dir = 'SHORT'; else dir = 'NOTR';
  if (dir !== market.dir) log('PİYASA: ' + market.dir + ' → ' + dir);
  Object.assign(market, { dir, score: +score.toFixed(3), breadth: +breadth.toFixed(3), b1h: +b1.toFixed(3), why: 'Trend %' + (trfPct * 100).toFixed(0) + ', EMA üstü %' + (b1 * 100).toFixed(0) + ', 24s yeşil %' + (bp * 100).toFixed(0) + ' → ' + score.toFixed(2), updatedAt: Date.now() });
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
    if (i === 0) named.btc = [r1, r4]; if (i === 1) named.eth = [r1, r4];
  });
  R.extremes = { overbought: ext.filter(x => x.rsi1h >= 72).sort((x, y) => y.rsi1h - x.rsi1h).slice(0, 6), oversold: ext.filter(x => x.rsi1h <= 28).sort((x, y) => x.rsi1h - y.rsi1h).slice(0, 6) };
  const f = x => (x == null ? null : +x.toFixed(1)), a1 = avg(rs[1]), a4 = avg(rs[4]);
  R.rsi = { btc1h: f(named.btc && named.btc[0]), btc4h: f(named.btc && named.btc[1]), eth1h: f(named.eth && named.eth[0]), eth4h: f(named.eth && named.eth[1]), avg1h: f(a1), avg4h: f(a4), text: a1 >= 70 ? 'RSI yüksek' : a1 <= 30 ? 'RSI düşük' : 'RSI normal' };
  try { const j = await fetchJSON('https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=BTCUSDT&period=1h'); const d = j && j.data, row = Array.isArray(d) ? d[d.length - 1] : d; const lr = parseFloat(row && (row.longAccountRatio || row.longRatio)), sr = parseFloat(row && (row.shortAccountRatio || row.shortRatio)); if (!isFinite(lr) || !isFinite(sr) || lr + sr <= 0) throw new Error(); R.ls = { long: +(lr / (lr + sr) * 100).toFixed(1), short: +(sr / (lr + sr) * 100).toFixed(1), source: 'Bitget' }; }
  catch (e) { R.ls = { long: +(market.breadth * 100).toFixed(1), short: +((1 - market.breadth) * 100).toFixed(1), source: 'Tahmini' }; }
  R.ls.text = R.ls.long >= 60 ? 'Çoğunluk LONG' : R.ls.long <= 40 ? 'Çoğunluk SHORT' : 'Dengeli';
  radar = R;
}
function moneyFlow(n) {
  const now = Date.now(), out = [];
  for (const sym of TOP.slice(0, 80)) {
    const flow = flowSummary(sym); if (!flow || !(flow.w30.buy + flow.w30.sell > 0)) continue;
    out.push({ base: baseOf(sym), buyUsdt: flow.w30.buy, sellUsdt: flow.w30.sell, netUsdt: flow.w30.net, ratio: flow.w30.sell > 0 ? +(flow.w30.buy / flow.w30.sell).toFixed(2) : null });
  }
  out.sort((x, y) => y.netUsdt - x.netUsdt);
  return out.slice(0, n || 8);
}
async function buildMarketContext() {
  const candles = {};
  for (const [sym, name] of [['BTC/USDT:USDT', 'BTC'], ['ETH/USDT:USDT', 'ETH']]) { const a = await getC(sym, '1h', 80), b = await getC(sym, '4h', 80); const c1 = a ? closed(a, H1).slice(-24) : [], c4 = b ? closed(b, H4).slice(-12) : []; candles[name] = { h1: c1.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n'), h4: c4.map(c => new Date(c.t).toISOString().slice(0, 16) + ' C' + c.c).join('\n') }; }
  const movers = TOP.slice(0, 50).map(sym => ({ base: baseOf(sym), chg: TICK[sym] ? TICK[sym].percentage : null })).filter(x => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8);
  return JSON.stringify({ market, radar: { fng: radar.fng, rsi: radar.rsi, ls: radar.ls }, baseline: analyzeMarket(), flowTop: moneyFlow(8), movers, btc: candles.BTC, eth: candles.ETH }, null, 1);
}
async function aiMarketBrief(force) {
  if (!aiReady() || AI.briefPerDay <= 0) return null;
  const q = aiQuota(); if (!q.ok || !aiReserveOk(0.9)) return null;
  if (aiUsage.briefDay !== q.day) { aiUsage.briefDay = q.day; aiUsage.briefCount = 0; }
  if (aiUsage.briefCount >= AI.briefPerDay) return marketBrief;
  let ctx; try { ctx = await buildMarketContext(); } catch (e) { return null; }
  const sys = 'Sen AlphaSon adlı kripto piyasa asistanısın. Genel piyasa yönünü, para girişini ve aşırı alım/satım durumunu okuyup KISA ve ÇOK BASİT Türkçe ile yorum yaparsın; teknik terim yok. Karar yalnızca "GİRİLİR" veya "GİRİLMEZ". Yalnızca JSON döndür.';
  const user = ctx + '\n\nGörev: piyasa yönünü söyle; en fazla 3 sebepli fikir üret. JSON: {"verdict":"GİRİLİR|GİRİLMEZ","trust":"YÜKSEK|ORTA|DÜŞÜK","score":0,"summary":"2-3 kısa cümle","drivers":["itici"],"risks":["risk"],"plan":"basit plan","invalidation":"geçersizlik","ideas":[{"coin":"BTC","dir":"LONG|SHORT","reason":"tek kısa cümle"}]}. Sadece JSON.';
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: user }];
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
      aiUsage.lastError = null; saveAI();
      log('AI BRİFİNG: ' + marketBrief.verdict + ' ' + marketBrief.score + ' (' + p.name + ')');
      return marketBrief;
    } catch (e) { providerFail(p, e); }
  }
  return marketBrief;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PAPER / LIVE ENGINE
   ═══════════════════════════════════════════════════════════════════════════ */
const opening = new Set();
const bookOf = sym => { const t = TICK[sym]; if (!t || !t.last) return null; const bid = t.bid > 0 ? t.bid : t.last, ask = t.ask > 0 ? t.ask : t.last; return { last: t.last, bid, ask }; };
const entryPx = (sym, dir) => { const b = bookOf(sym); return b ? (dir === 'LONG' ? b.ask : b.bid) : null; };
const exitPx = o => { const b = bookOf(o.symbol); return b ? (o.dir === 'LONG' ? b.bid : b.ask) : null; };
function paperPnl(p, price) { const d = p.dir === 'LONG' ? 1 : -1; const part = p.tp1Hit && !p.single ? 0.5 * (p.tp1 / p.entry - 1) + 0.5 * (price / p.entry - 1) : price / p.entry - 1; let pnl = p.notional * part * d - p.notional * (COST_TOTAL / 100); if (pnl < -p.margin) pnl = -p.margin; return { pnl, pct: pnl / p.margin * 100 }; }
function dailyLossBreached() { if (!(settings.dailyLossPct > 0)) return false; if (settings.tradeMode === 'live') return paper.liveDayStart > 0 && (paper.liveDayPnl || 0) <= -(paper.liveDayStart * settings.dailyLossPct / 100); return paper.balance <= paper.dayStart * (1 - settings.dailyLossPct / 100); }
function checkDailyLoss() { const key = new Date().toISOString().slice(0, 10); if (paper.dayKey !== key) { paper.dayKey = key; paper.dayStart = paper.balance; paper.liveDayPnl = 0; paper.liveDayStart = realBal.total || 0; dirty = true; } if (!(settings.dailyLossPct > 0)) return; if (dailyLossBreached() && settings.auto) { settings.auto = false; saveSettings(); log('Günlük zarar limiti: oto KAPATILDI'); } }
async function maybeOpenPaper(sig) {
  if (!sig || sig.module !== 'PUMP') return 'Sadece PUMP';
  if (sig.status !== 'AKTIF') return 'Sinyal aktif değil';
  if (!sig.aiGate || !['APPROVED', 'OFFLINE'].includes(sig.aiGate.state)) return 'AI onayı yok';
  if (sig.ai && sig.ai.entryDecision === 'REJECT') return 'AI GİRİLMEZ';
  checkDailyLoss(); if (dailyLossBreached()) return 'Günlük zarar limiti';
  if (paper.open.some(p => p.symbol === sig.symbol) || opening.has(sig.symbol)) return 'Zaten açık';
  if (paper.open.length + opening.size >= settings.maxOpen) return 'Max açık (' + settings.maxOpen + ')';
  const live = settings.tradeMode === 'live', d = sig.dir === 'LONG' ? 1 : -1, entry = sig.entry * (1 + d * PAPER_SLIP / 100);
  let lev = settings.leverage, eq = paper.balance, margin = Math.min(settings.margin, paper.balance);
  if (live) { if (!IS_LIVE_READY) return 'API anahtarı eksik'; if (Date.now() - realBal.updatedAt > 3 * M1 || !(realBal.free > 0)) return 'Bakiye okunamadı'; lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE); eq = realBal.total; margin = Math.min(settings.margin, LIVE_MAX_MARGIN, realBal.free * 0.9); }
  const slDist = Math.abs(entry - sig.sl) / entry;
  if (settings.riskPct > 0 && slDist > 0 && eq > 0) margin = Math.min(margin, (eq * settings.riskPct / 100) / slDist / lev);
  margin = +margin.toFixed(2);
  if (margin < (live ? 2 : 10)) return 'Boyut yetersiz';
  opening.add(sig.symbol);
  try {
    if (!live) {
      const p = { id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir, entry: rp(entry), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, scalp: !!sig.scalpMode, tf: sig.info && sig.info.tf, isLive: false, atrPct: sig.atrPct, velSeries: [], startedAt: Date.now(), holdSec: sig.holdSec, noMoveSec: sig.noMoveSec, quickTpPct: sig.quickTpPct, quickTimeSec: sig.quickTimeSec, quickArmPct: sig.quickArmPct, margin, leverage: lev, notional: margin * lev, conf: sig.conf, aiScore: sig.ai && sig.ai.score, openedAt: Date.now(), lastTs: 0, status: 'ACIK' };
      paper.open.push(p); dirty = true;
      log('PAPER AÇILDI: ' + p.base + ' ' + p.dir + ' | ' + fmtP(p.entry) + ' | ' + margin.toFixed(0) + ' USDT ' + lev + 'x');
    } else { await openLive(sig, margin, lev, entry); }
    return null;
  } catch (e) { log('HATA açma: ' + e.message); return e.message; }
  finally { opening.delete(sig.symbol); }
}
async function closePaper(p, price, reason) {
  if (p.status === 'KAPALI' || p.closing) return false;
  p.closing = true;
  try {
    let exit = price;
    if (p.isLive && !p.extClosed) { try { const f = await liveClose(p); if (f) exit = f; } catch (e) { return false; } }
    const r = paperPnl(p, exit);
    p.status = 'KAPALI'; p.result = reason; p.exit = rp(exit); p.closedAt = Date.now(); p.pnl = +r.pnl.toFixed(3); p.pnlPct = +r.pct.toFixed(2); p.durationMs = p.closedAt - p.openedAt;
    if (p.isLive) paper.liveDayPnl = (paper.liveDayPnl || 0) + r.pnl;
    else { paper.balance += r.pnl; paper.n++; paper.sumPnl += r.pnl; if (r.pnl > 0) paper.wins++; }
    paper.open = paper.open.filter(x => x.id !== p.id); paper.closed.unshift(p); dirty = true;
    log('PAPER KAPANDI: ' + p.base + ' → ' + reason + ' | PnL ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2));
    return true;
  } finally { p.closing = false; }
}
function paperSummary() { let unreal = 0; paper.open.filter(p => !p.isLive).forEach(p => { unreal += paperPnl(p, exitPx(p) || p.entry).pnl; }); return { balance: +paper.balance.toFixed(2), start: paper.startBalance, equity: +(paper.balance + unreal).toFixed(2), unrealized: +unreal.toFixed(2), total: paper.n + paper.open.filter(p => !p.isLive).length, open: paper.open.length, closed: paper.n, wins: paper.wins, winRate: paper.n ? +(paper.wins / paper.n * 100).toFixed(1) : 0, sumPnl: +paper.sumPnl.toFixed(2), avgPnl: paper.n ? +(paper.sumPnl / paper.n).toFixed(3) : 0, dayStart: +paper.dayStart.toFixed(2), liveOpen: paper.open.filter(p => p.isLive).length, liveDayPnl: +(paper.liveDayPnl || 0).toFixed(2) }; }
function stepTrade(t, c) { const L = t.dir === 'LONG'; if (!(t.tp1Hit && c.t <= t.tp1Ts)) { const slHit = L ? c.l <= t.curSl : c.h >= t.curSl; if (slHit) return { done: true, price: t.curSl, reason: t.tp1Hit ? 'BE' : 'SL' }; } if (!t.tp1Hit) { if (L ? c.h >= t.tp1 : c.l <= t.tp1) { if (t.single || !t.tp2) return { done: true, price: t.tp1, reason: 'TP1' }; const d = L ? 1 : -1; t.tp1Hit = true; t.tp1Ts = c.t; t.curSl = t.entry * (1 + d * EX.BE_LOCK / 100); return { done: false, event: 'TP1' }; } } else if (t.tp2 && (L ? c.h >= t.tp2 : c.l <= t.tp2)) return { done: true, price: t.tp2, reason: 'TP2' }; return null; }
function calcR(t, exitPrice) { const risk = Math.abs(t.entry - t.sl); if (!(risk > 0)) return { gross: 0, net: 0 }; const d = t.dir === 'LONG' ? 1 : -1; const rOf = p => (p - t.entry) * d / risk; const gross = t.tp1Hit && !t.single ? 0.5 * rOf(t.tp1) + 0.5 * rOf(exitPrice) : rOf(exitPrice); return { gross, net: gross - (t.entry * COST_TOTAL / 100) / risk }; }
const fromOf = o => (o.lastTs ? o.lastTs + M1 : Math.ceil((o.createdAt || o.openedAt) / M1) * M1);
const finish = (o, price, reason, kind) => (kind === 'sig' ? closeSignal(o, price, reason) : closePaper(o, price, reason));
function pumpPeak(o, price) { const d = o.dir === 'LONG' ? 1 : -1, pct = (price / o.entry - 1) * d * 100; if (o.peakPct == null || pct > o.peakPct) o.peakPct = pct; return pct; }
function tpTarget(o) { const atrPct = o.atrPct > 0 ? o.atrPct : 0.55; return clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX); }
function applyCostCover(o, pnl) { if (!(o.peakPct >= EX.BE_ARM)) return false; const d = o.dir === 'LONG' ? 1 : -1; const lock = o.entry * (1 + d * EX.BE_LOCK / 100); if (o.curSl == null || (lock - o.curSl) * d > 0) { o.curSl = lock; o.beArmed = true; return true; } return false; }
function velRatio(o, nowMs) { const ring = RING.get(o.symbol); if (!ring || ring.p.length < 4) return 1; const d = o.dir === 'LONG' ? 1 : -1; const cur = ringMove(ring, EX.VEL_WIN_MS, nowMs) * d; const ser = o.velSeries || (o.velSeries = []); const lastT = ser.length ? ser[ser.length - 1].t : 0; if (nowMs - lastT >= 250) ser.push({ t: nowMs, v: cur }); const floor = nowMs - EX.VEL_PEAK_MEMORY_MS; while (ser.length && ser[0].t < floor) ser.shift(); let peak = 0; for (const s of ser) if (s.v > peak) peak = s.v; if (!(peak > 1e-6)) return 1; return Math.max(0, cur) / peak; }
function pumpDecide(o, price, nowMs) { const pnl = pumpPeak(o, price), peak = o.peakPct; const born = o.startedAt || o.createdAt; const age = Math.max(0, nowMs - born) / 1000; const holdSec = o.holdSec != null ? o.holdSec : EX.HOLD; const noMoveSec = o.noMoveSec != null ? o.noMoveSec : EX.NO_MOVE; if (pnl >= tpTarget(o) - EPS) return 'TPMAX'; applyCostCover(o, pnl); if (peak >= EX.LOCK_ARM) { const gb = Math.max(EX.GB_MIN, EX.GB_FRAC * peak); if (peak - pnl >= gb - EPS) return 'FADE'; } if (peak >= EX.MOM_ARM) { const vr = velRatio(o, nowMs); const minPnl = Math.max(FEE_ROUNDTRIP + 0.05, EX.DECAY_MIN_PNL); if (vr < EX.DECAY_RATIO && pnl >= minPnl - EPS) return 'MOMENTUM'; } if (peak >= EX.BAIL_ARM && peak < EX.LOCK_ARM && pnl <= EX.BAIL_BELOW + EPS) return 'BAIL'; if (age >= noMoveSec - EPS && peak < EX.BE_ARM) return 'NOMOVE'; if (age >= holdSec - EPS) return 'SURE'; return null; }
const isScalpPos = o => !!(o && (o.scalp || o.scalpMode));
function scalpDecide(o, price, nowMs) { const d = o.dir === 'LONG' ? 1 : -1; const pnl = pumpPeak(o, price), peak = o.peakPct; const born = o.startedAt || o.createdAt; const age = Math.max(0, nowMs - born) / 1000; const holdSec = o.holdSec != null ? o.holdSec : 540; const noMoveSec = o.noMoveSec != null ? o.noMoveSec : 150; if (o.tp1Hit) { const gap = clamp(0.35 * peak, 0.22, 0.50), lvl = peak - gap; if (lvl > EX.BE_LOCK + 0.02) { const lock = o.entry * (1 + d * lvl / 100); if ((lock - o.curSl) * d > 0) { o.curSl = lock; o.trailed = true; } } if (peak >= 0.60 && peak - pnl >= Math.max(0.28, 0.40 * peak)) return 'FADE'; } else if (age >= noMoveSec && peak < 0.25) return 'NOMOVE'; if (age >= holdSec) return 'SURE'; return null; }
async function pumpTick(o, now, kind) { if (!o || (o.status !== 'AKTIF' && o.status !== 'ACIK') || o.closing) return; const born = o.startedAt || o.createdAt, age = (now - born) / 1000; const hold = o.holdSec != null ? o.holdSec : EX.HOLD; const px = exitPx(o); if (!px) { if (age > hold + 30) await finish(o, o.lastPx || o.entry, 'SURE', kind); return; } o.lastPx = px; pumpPeak(o, px); const scalp = isScalpPos(o); if (!scalp) { velRatio(o, now); applyCostCover(o, o.peakPct); } const r = stepTrade(o, { t: now, h: px, l: px, c: px }); if (r && r.event === 'TP1') { o.tp1At = now; dirty = true; log('TP1: ' + MODS[o.module].label + ' ' + o.base); } if (r && r.done) { let price = r.price; if (r.reason === 'SL' || r.reason === 'BE') price = o.dir === 'LONG' ? Math.min(price, px) : Math.max(price, px); let reason = r.reason === 'TP1' ? 'TPMAX' : r.reason; if (scalp && r.reason === 'BE' && o.trailed) reason = 'FADE'; await finish(o, price, reason, kind); return; } const dec = scalp ? scalpDecide(o, px, now) : pumpDecide(o, px, now); if (dec) await finish(o, px, dec, kind); }
async function pumpManage(now) {
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'AI_BEKLIYOR')) { if (s.aiGate && now >= s.aiGate.expiresAt) declinePumpAI(s, 'AI_TIMEOUT', 'AI yetişmedi'); }
  for (const s of signals.filter(x => x.module === 'PUMP' && x.status === 'ONAY_BEKLIYOR')) { if (s.approvalExpiresAt && now >= s.approvalExpiresAt) { s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = now; dirty = true; log('ONAY SÜRESİ: ' + s.base); } }
  for (const s of signals.filter(x => x.status === 'AKTIF' && x.module === 'PUMP')) { try { await pumpTick(s, now, 'sig'); } catch (e) { } }
  for (const p of paper.open.slice()) { try { await pumpTick(p, now, 'paper'); } catch (e) { } }
}
function pumpCycle() { const now = Date.now(); if (PUMP.useIgnition) pumpScanVel(now); pumpManage(now).catch(e => log('HATA pump: ' + e.message)); }
async function trackerCycle() {
  const t = Date.now();
  const act = signals.filter(s => s.status === 'AKTIF' && s.module !== 'PUMP' && (!s._chk || t - s._chk >= 55000));
  if (!act.length) return;
  const need = new Map();
  for (const o of act) { const f = fromOf(o), v = need.get(o.symbol); if (v === undefined || f < v) need.set(o.symbol, f); }
  const data = {};
  await pool(Array.from(need.keys()), 6, async sym => { const since = need.get(sym), lim = Math.min(300, Math.ceil((t - since) / M1) + 2); try { const raw = await ex.fetchOHLCV(sym, '1m', since, lim); data[sym] = (raw || []).map(toC); } catch (e) { } });
  for (const s of act) { s._chk = t; try { const cs = data[s.symbol]; if (!cs) continue; for (const c of cs) { if (c.t < fromOf(s)) continue; const r = stepTrade(s, c); if (r && r.done) { closeSignal(s, r.price, r.reason === 'TP1' ? 'TPMAX' : r.reason); break; } } if (t - s.createdAt > s.maxAgeMs) closeSignal(s, priceOf(s.symbol) || s.entry, 'SURE'); } catch (e) { } }
}
/* Live ops */
let liveInited = false;
async function liveInit() { if (liveInited) return; try { await ex.setPositionMode(false); } catch (e) { } liveInited = true; }
async function liveSetup(sym, lev) { try { await ex.setMarginMode('isolated', sym); } catch (e) { } await ex.setLeverage(lev, sym); }
async function placeStop(sym, side, amount, price) { let lastErr = null; for (const params of [{ stopLossPrice: price, reduceOnly: true }, { triggerPrice: price, reduceOnly: true }]) { for (let i = 0; i < 2; i++) { try { const o = await ex.createOrder(sym, 'market', side, amount, undefined, params); if (o && o.id) return o.id; lastErr = new Error('id yok'); } catch (e) { lastErr = e; await sleep(250); } } } throw lastErr || new Error('stop kurulamadı'); }
async function emergencyClose(sym, side, amount) { for (let i = 0; i < 4; i++) { try { await ex.createOrder(sym, 'market', side, amount, undefined, { reduceOnly: true }); return true; } catch (e) { await sleep(400); } } return false; }
async function fillOf(order, sym) { let f = Number(order && order.average) || Number(order && order.price) || 0; if (!f && order && order.id) { try { const o2 = await ex.fetchOrder(order.id, sym); f = Number(o2.average) || Number(o2.price) || 0; } catch (e) { } } return f; }
async function cancelStopOrder(p) { if (!p.stopId) return true; let ok = false; for (const params of [{ stop: true }, { trigger: true }, { stop: true, planType: 'loss_plan' }]) { try { await ex.cancelOrder(p.stopId, p.symbol, params); ok = true; break; } catch (e) { } } if (!ok) { try { await ex.cancelAllOrders(p.symbol, { stop: true }); ok = true; } catch (e) { } } return ok; }
async function openLive(sig, margin, lev, entryHint) {
  await liveInit(); await liveSetup(sig.symbol, lev);
  const side = sig.dir === 'LONG' ? 'buy' : 'sell', slSide = sig.dir === 'LONG' ? 'sell' : 'buy';
  const amount = ex.amountToPrecision(sig.symbol, (margin * lev) / entryHint);
  if (!(Number(amount) > 0) || Number(amount) * entryHint < 5) throw new Error('miktar küçük');
  const order = await ex.createOrder(sig.symbol, 'market', side, amount);
  const fill = (await fillOf(order, sig.symbol)) || entryHint;
  const qty = Number(order.filled) > 0 ? ex.amountToPrecision(sig.symbol, order.filled) : amount;
  let stopId = null;
  try { stopId = await placeStop(sig.symbol, slSide, qty, sig.sl); } catch (e) { log('LIVE STOP: ' + sig.base + ' → ACİL'); if (await emergencyClose(sig.symbol, slSide, qty)) throw new Error('Stop kurulamadı, kapatıldı'); }
  const notional = Number(qty) * fill;
  const p = { id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir, entry: rp(fill), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, scalp: !!sig.scalpMode, tf: sig.info && sig.info.tf, startedAt: Date.now(), isLive: true, amount: qty, stopId, unprotected: !stopId, holdSec: sig.holdSec, noMoveSec: sig.noMoveSec, atrPct: sig.atrPct, margin: +(notional / lev).toFixed(2), leverage: lev, notional, conf: sig.conf, aiScore: sig.ai && sig.ai.score, openedAt: Date.now(), lastTs: 0, status: 'ACIK' };
  paper.open.push(p); dirty = true;
  log('LIVE AÇILDI: ' + p.base + ' ' + p.dir + ' | ' + fmtP(fill) + ' | ' + margin.toFixed(0) + ' USDT ' + lev + 'x');
  return p;
}
async function liveClose(p) { const side = p.dir === 'LONG' ? 'sell' : 'buy'; const o = await ex.createOrder(p.symbol, 'market', side, p.amount, undefined, { reduceOnly: true }); const fill = await fillOf(o, p.symbol); if (p.stopId) await cancelStopOrder(p); return fill || null; }
async function syncLive() { if (!IS_LIVE_READY) return; const lives = paper.open.filter(p => p.isLive && !p.closing && Date.now() - p.openedAt > 8000); if (!lives.length) return; let poss; try { poss = await ex.fetchPositions(lives.map(p => p.symbol)); } catch (e) { return; } if (!Array.isArray(poss)) return; const has = new Set(poss.filter(x => Math.abs(Number(x.contracts) || 0) > 0).map(x => x.symbol)); for (const p of lives) { if (has.has(p.symbol)) continue; log('LIVE: ' + p.base + ' borsada kapalı'); p.extClosed = true; await closePaper(p, p.curSl || p.sl, 'SL'); } }

/* ═══════════════════════════════════════════════════════════════════════════
   STATS / BACKTEST
   ═══════════════════════════════════════════════════════════════════════════ */
function statsByModule() { const rows = []; let T = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, reasons: {} }; Object.keys(MODS).forEach(k => { const all = signals.filter(s => s.module === k), cl = all.filter(s => s.status === 'KAPALI'); const wins = cl.filter(s => s.netR > 0).length, losses = cl.length - wins; const reasons = {}; cl.forEach(s => { const r = s.result || '?'; reasons[r] = (reasons[r] || 0) + 1; T.reasons[r] = (T.reasons[r] || 0) + 1; }); const row = { module: k, label: MODS[k].label, enabled: !!MODS[k].enabled, total: all.length, open: all.filter(s => s.status !== 'KAPALI').length, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, grossR: +cl.reduce((a, s) => a + (s.grossR || 0), 0).toFixed(2), netR: +cl.reduce((a, s) => a + (s.netR || 0), 0).toFixed(2), reasons }; rows.push(row); T.total += row.total; T.open += row.open; T.wins += wins; T.losses += losses; T.grossR += row.grossR; T.netR += row.netR; }); const c = T.wins + T.losses; T.winRate = c ? +(T.wins / c * 100).toFixed(1) : 0; T.grossR = +T.grossR.toFixed(2); T.netR = +T.netR.toFixed(2); rows.push(T); return rows; }
const BT = { SCALPX3: { tf: '3m', warm: 60, win: 80, maxBars: 3, detect: w => detectScalpX(w, '3m') }, SCALPX5: { tf: '5m', warm: 60, win: 80, maxBars: 3, detect: w => detectScalpX(w, '5m') }, SCALPER: { tf: '15m', warm: 80, win: 100, maxBars: 16, detect: w => detectScalper(w, null, null, null) }, LT: { tf: '4h', warm: 70, win: 130, maxBars: 30, detect: w => detectLT(w).signal || null } };
const BT_TOTAL = { '1m': 2400, '3m': 1500, '5m': 1500, '15m': 6000, '1h': 2500, '4h': 1500, '1d': 400 };
function btStats(rs) { const n = rs.length; if (!n) return { n: 0, winRate: 0, pf: 0, maxDD: 0, sumR: 0, avgR: 0 }; let w = 0, gw = 0, gl = 0, cum = 0, peak = 0, dd = 0; for (const r of rs) { if (r > 0) { w++; gw += r; } else gl -= r; cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); } return { n, winRate: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), maxDD: +dd.toFixed(2), sumR: +cum.toFixed(2), avgR: +(cum / n).toFixed(3) }; }
function btCoin(cs, cfg, ms) { const out = []; for (let i = cfg.warm; i < cs.length - 1; i++) { const w = cs.slice(Math.max(0, i - cfg.win + 1), i + 1); let det = null; try { det = cfg.detect(w); } catch (e) { det = null; } if (!det) continue; const t = Object.assign({}, det, { curSl: det.sl, tp1Hit: false, createdAt: 0 }); let exit = null, reason = 'SURE', k = Math.min(cs.length - 1, i + cfg.maxBars); for (let j = i + 1; j <= k; j++) { const c = cs[j]; const r = stepTrade(t, c); if (r && r.done) { exit = r.price; reason = r.reason === 'TP1' ? 'TPMAX' : r.reason; k = j; break; } } if (exit == null) exit = cs[k].c; const R = calcR(t, exit); out.push({ t: cs[i].t, net: R.net, reason, ok: true }); i = k; } return out; }
async function runBacktest(job) { const { module: mod, coins } = job.params, tf = job.params.tf, ms = TF_MS[tf]; const cfg = BT[job.params.cfgKey] || BT.SCALPX3; const syms = TOP.slice(0, coins), trades = []; let done = 0; for (const sym of syms) { try { const cs = await fetchHistory(sym, tf, BT_TOTAL[tf]); if (cs.length >= cfg.warm + 30) btCoin(cs, cfg, ms).forEach(x => trades.push(x)); } catch (e) { } job.progress = +(++done / syms.length).toFixed(2); } trades.sort((a, b) => a.t - b.t); const ft = trades.filter(x => x.ok); let cum = 0, curve = ft.map(x => +(cum += x.net).toFixed(3)); const step = Math.max(1, Math.ceil(curve.length / 400)); if (step > 1) curve = curve.filter((_, i) => i % step === 0); const reasons = {}; ft.forEach(x => { const r = reasons[x.reason] || (reasons[x.reason] = { n: 0, sumNet: 0 }); r.n++; r.sumNet = +(r.sumNet + x.net).toFixed(3); }); job.result = { module: mod, label: MODS[mod].label, tf, coins: syms.length, trades: ft.length, reasons, all: btStats(ft.map(x => x.net)), curve, splitIdx: 0, note: VERSION + ': Net R maliyet %' + COST_TOTAL.toFixed(2) + '.' }; job.status = 'bitti'; }

/* ═══════════════════════════════════════════════════════════════════════════
   EXPRESS API (AUTH YOK)
   ═══════════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json({ limit: '200kb' }));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { log('API ' + req.path + ': ' + e.message); res.status(500).json({ error: e.message }); });
function view(s) { const px = priceOf(s.symbol), d = s.dir === 'LONG' ? 1 : -1; const v = Object.assign({}, s, { modLabel: MODS[s.module].label, livePrice: px || null, livePct: px && isOpenSignal(s) ? +(((px / s.entry - 1) * d) * 100).toFixed(3) : null }); if (s.status === 'ONAY_BEKLIYOR' && s.approvalExpiresAt) v.approvalRemainingMs = Math.max(0, s.approvalExpiresAt - Date.now()); return v; }
function paperView(p) { if (p.status === 'KAPALI') return p; const px = priceOf(p.symbol) || p.entry, r = paperPnl(p, px); return Object.assign({}, p, { livePrice: px, livePnl: +r.pnl.toFixed(2), livePnlPct: +r.pct.toFixed(2), ageMs: Date.now() - p.openedAt }); }

app.get('/', (req, res) => { let html = '<h2>AlphaSon ' + VERSION + '</h2>'; try { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) html = fs.readFileSync(p, 'utf8'); } catch (e) { } res.set('Content-Type', 'text/html; charset=utf-8').send(html); });
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, liveReady: IS_LIVE_READY }));

app.get('/api/state', h((req, res) => {
  const act = signals.filter(isOpenSignal), byMod = {};
  Object.keys(MODS).forEach(k => { byMod[k] = act.filter(s => s.module === k).length; });
  res.json({ version: VERSION, now: Date.now(), market, settings, counts: { active: act.length, pendingApproval: signals.filter(s => s.status === 'ONAY_BEKLIYOR').length, byModule: byMod, openPump: paper.open.filter(p => p.module === 'PUMP').length, autoMaxOpen: AI.autoMaxOpen, rejections: RECENT_REJ.length, opportunities: OPPS.size, outcomesDone: OUT_DONE.length }, scan: { universe: TOP.length, apiErr: stats.apiErr, tickAt: stats.tickAt }, paper: paperSummary(), modules: MODS, activeModules: Object.keys(MODS).filter(k => MODS[k].enabled), passiveModules: Object.keys(MODS).filter(k => !MODS[k].enabled), daily: { levels: Array.from(DAILY_LEVELS.values()).slice(0, 40) }, ai: aiStatus(), ready: TOP.length > 0, liveReady: IS_LIVE_READY, realBal, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE }, feeModel: { feeRoundTrip: FEE_ROUNDTRIP, slip: PAPER_SLIP, total: COST_TOTAL }, watchMeta: WATCH_META });
}));
app.get('/api/signals', h((req, res) => { let l = signals; if (req.query.module) l = l.filter(s => s.module === String(req.query.module).toUpperCase()); const act = l.filter(isOpenSignal).sort((a, b) => b.createdAt - a.createdAt); const cl = l.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 60); res.json({ active: act.map(view), closed: cl.map(view) }); }));

/* v81 endpoints */
app.get('/api/rejections', h((req, res) => { let l = RECENT_REJ; if (req.query.module) { const m = String(req.query.module).toUpperCase(); l = l.filter(r => r.mod === m); } if (req.query.kind) { const k = String(req.query.kind).toUpperCase(); l = l.filter(r => r.kind === k); } if (req.query.code) { const c = String(req.query.code).toUpperCase(); l = l.filter(r => r.code === c); } const byCode = {}, byKind = {}; RECENT_REJ.forEach(r => { byCode[r.code] = (byCode[r.code] || 0) + 1; byKind[r.kind] = (byKind[r.kind] || 0) + 1; }); res.json({ now: Date.now(), total: RECENT_REJ.length, byCode, byKind, items: l.slice(0, Math.min(300, Number(req.query.limit) || 80)).map(r => Object.assign({ modLabel: (MODS[r.mod] || { label: r.mod }).label }, r)) }); }));
app.get('/api/opportunities', h((req, res) => { const arr = Array.from(OPPS.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.min(150, Number(req.query.limit) || 60)); res.json({ now: Date.now(), total: OPPS.size, items: arr.map(o => Object.assign({ modLabel: (MODS[o.mod] || { label: o.mod }).label }, o)) }); }));
app.get('/api/outcomes', h((req, res) => res.json({ now: Date.now(), open: OUT_OPEN.length, done: OUT_DONE.length, stats: outStats(), recent: OUT_DONE.slice(-40).reverse(), note: 'Net 15dk = 15 dakika sonraki yönlü getiri − %' + COST_TOTAL + '. Örneklem ≥30 olmadan güvenme.' })));
app.get('/api/ai/history', h((req, res) => res.json({ items: AI_HISTORY.slice(0, 100), providers: AI.providers.map(aiProviderView) })));
app.get('/api/v81/overview', h((req, res) => { const act = signals.filter(isOpenSignal); let flowSyms = 0; for (const [, f] of FLOWS) if (Date.now() - f.last < 20000) flowSyms++; res.json({ version: VERSION, now: Date.now(), market, ai: { ready: aiReady(), usage: aiStatus().usage, limits: aiStatus().limits }, data: { tickAgeSec: stats.tickAt ? Math.round((Date.now() - stats.tickAt) / 1000) : null, wsConnected: !!(stream.ws && stream.ws.readyState === 1), flowSymbols: flowSyms, universe: TOP.length, apiErr: stats.apiErr, oiSymbols: OI.size }, counts: { active: act.length, pendingApproval: act.filter(s => s.status === 'ONAY_BEKLIYOR').length, rejections: RECENT_REJ.length, opportunities: OPPS.size, outcomesDone: OUT_DONE.length }, watchMeta: WATCH_META, autoTrade: !!settings.auto }); }));

/* Watches */
app.get('/api/watch/:kind', h((req, res) => res.json({ items: watchItems(req.params.kind) })));
app.post('/api/watch/lt/:base/ai', h(async (req, res) => {
  const base = String(req.params.base).toUpperCase();
  const row = (WATCH.lt || []).find(r => r.base === base);
  if (!row) return res.status(404).json({ error: 'Coin LT listesinde yok' });
  if (!aiReady()) return res.status(400).json({ error: 'AI kapalı', ai: aiView(null) });
  LT_AI.delete(row.key);
  await watchAIRun('LT', [row], LT_AI, ltPrompt, 1, true);
  res.json({ ok: true, ai: aiView(LT_AI.get(row.key), row.sig) });
}));

/* Paper / trade */
app.get('/api/paper', h((req, res) => res.json({ settings, summary: paperSummary(), open: paper.open.map(paperView), closed: paper.closed.slice(0, 50), limits: { maxOpen: settings.maxOpen, autoMaxOpen: AI.autoMaxOpen, fee: FEE_ROUNDTRIP, slip: PAPER_SLIP } })));
app.post('/api/paper/settings', h((req, res) => { const merged = Object.assign({}, settings, req.body || {}); merged.auto = settings.auto; settings = sanitizeSettings(merged); saveSettings(); log('AYAR kaydedildi'); res.json({ ok: true, settings }); }));
app.post('/api/paper/toggle', h((req, res) => { settings.auto = req.body && req.body.auto !== undefined ? !!req.body.auto : !settings.auto; saveSettings(); log('OTO-TRADE ' + (settings.auto ? 'AÇIK' : 'KAPALI')); res.json({ ok: true, settings }); }));
app.post('/api/paper/:id/close', h(async (req, res) => { const p = paper.open.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Yok' }); const ok = await closePaper(p, exitPx(p) || p.entry, 'MANUEL'); res.json({ ok }); }));
app.post('/api/paper/reset', h((req, res) => { const lives = paper.open.filter(p => p.isLive); paper = { seq: paper.seq, balance: START_BALANCE, startBalance: START_BALANCE, open: lives, closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: paper.liveDayPnl || 0, liveDayStart: paper.liveDayStart || 0 }; dirty = true; res.json({ ok: true }); }));
app.post('/api/trade/mode', h(async (req, res) => { const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper'; if (mode === 'live') { if (!IS_LIVE_READY) return res.status(400).json({ error: 'API anahtarı eksik' }); await fetchRealBalance(); if (!(realBal.total > 0)) return res.status(400).json({ error: 'Bakiye okunamadı' }); if (!(settings.dailyLossPct > 0)) { settings.dailyLossPct = 3; log('LIVE: günlük zarar %3'); } paper.liveDayStart = realBal.total; paper.liveDayPnl = 0; paper.dayKey = new Date().toISOString().slice(0, 10); } settings.tradeMode = mode; saveSettings(); log('MOD: ' + mode.toUpperCase()); res.json({ ok: true, settings }); }));

/* Signals exec/close */
app.post('/api/signal/:id/execute', h(async (req, res) => {
  const s = signals.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Yok' });
  if (s.module !== 'PUMP') return res.status(400).json({ error: 'Sadece PUMP' });
  if (s.status !== 'ONAY_BEKLIYOR') return res.status(400).json({ error: 'Onay beklemiyor' });
  if (s.approvalExpiresAt && Date.now() > s.approvalExpiresAt) { s.status = 'KAPALI'; s.result = 'APPROVAL_EXPIRED'; s.closedAt = Date.now(); dirty = true; return res.status(400).json({ error: 'Süre doldu' }); }
  const liveEntry = entryPx(s.symbol, s.dir); if (!(liveEntry > 0)) return res.status(400).json({ error: 'Fiyat yok' });
  s.status = 'AKTIF'; s.startedAt = Date.now(); s.operatorApprovedAt = Date.now(); s.entry = rp(liveEntry); dirty = true;
  const err = await maybeOpenPaper(s);
  if (err) { s.status = 'ONAY_BEKLIYOR'; dirty = true; return res.status(400).json({ error: err }); }
  res.json({ ok: true, signal: view(s) });
}));
app.post('/api/signal/:id/close', h((req, res) => { const s = signals.find(x => x.id === req.params.id); if (!s || !isOpenSignal(s)) return res.status(400).json({ error: 'Yok' }); closeSignal(s, priceOf(s.symbol) || s.entry, 'MANUEL'); res.json({ ok: true }); }));
app.post('/api/signal/:id/ai', h(async (req, res) => { const s = signals.find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: 'Yok' }); if (!AI.modules.includes(s.module)) return res.status(400).json({ error: 'AI bu modülü incelemiyor' }); if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' }); const ai = await aiReview(s, { force: true }); if (!ai || ai.error) return res.status(429).json({ error: (ai && ai.error) || 'AI yanıt yok' }); res.json({ ok: true, ai, signal: view(s) }); }));
app.get('/api/chart/:id', h(async (req, res) => { const s = signals.find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: 'Yok' }); const tf = MODS[s.module].chartTf; const raw = await getC(s.symbol, tf, 150, 20000); const cs = raw || [], cl = closes(cs); res.json({ signal: view(s), tf, candles: cs.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]), ema20: emaArr(cl, 20).map(rp), ema50: emaArr(cl, 50).map(rp), tradingview: 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P' }); }));

/* Radar/stats/ai/brief/logs */
app.get('/api/radar', h((req, res) => res.json({ radar, market, moneyFlow: moneyFlow(10), note: 'Agresif akış trade.side üzerinden' })));
app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), fee: FEE_ROUNDTRIP, slip: PAPER_SLIP, totalCost: COST_TOTAL })));
app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: Object.keys(MODS).map(k => ({ module: k, name: MODS[k].label, active: !!MODS[k].enabled })) })));
app.get('/api/ai/status', h((req, res) => { const st = aiStatus(); st.recent = signals.filter(s => s.ai && !s.ai.error).slice(-15).reverse().map(s => ({ id: s.id, module: s.module, base: s.base, verdict: s.ai.verdict, phase: s.ai.phase, score: s.ai.score, provider: s.ai.providerName, at: s.ai.at })); res.json(st); }));
app.post('/api/ai/brief', h(async (req, res) => { if (!aiReady()) return res.status(400).json({ error: 'AI kapalı' }); const b = await aiMarketBrief(true); if (!b) return res.status(429).json({ error: aiUsage.lastError || 'üretilemedi' }); res.json({ ok: true, brief: b }); }));
app.post('/api/ai/reset', h((req, res) => { for (const p of AI.providers) { p.cooldownUntil = 0; p.modelCooldowns = {}; p.lastError = null; p.nextAt = 0; } aiUsage.lastError = null; saveAI(); res.json({ ok: true }); }));
app.post('/api/ai/toggle', h((req, res) => { settings.aiEnabled = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !settings.aiEnabled; saveSettings(); res.json({ ok: true, ai: aiStatus() }); }));
app.get('/api/ai/test', h(async (req, res) => { const out = []; for (const p of AI.providers) { if (!p.key) { out.push({ provider: p.id, hasKey: false, results: [] }); continue; } out.push({ provider: p.id, name: p.name, hasKey: true, results: await aiTestProvider(p) }); } res.json({ at: Date.now(), providers: out }); }));
app.all('/api/ai/discover', h(async (req, res) => { await discoverAll(); res.json({ ok: true, providers: AI.providers.map(aiProviderView) }); }));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.get('/api/diag', h((req, res) => res.json({ version: VERSION, market, gates: { scalp: PWHY, blocks: BLK }, ai: aiStatus(), opp: Array.from(OPPS.values()).slice(0, 50), fee: { fee: FEE_ROUNDTRIP, slip: PAPER_SLIP, total: COST_TOTAL } })));

app.post('/api/backtest', h((req, res) => {
  const b = req.body || {}, mod = String(b.module || '').toUpperCase();
  const cfgKey = b.cfgKey || ('SCALPX' + (b.tf === '5m' ? '5' : '3'));
  if (!BT[cfgKey]) return res.status(400).json({ error: 'Geçersiz' });
  const finalTf = cfgKey === 'SCALPX5' ? '5m' : cfgKey === 'SCALPX3' ? '3m' : (cfgKey === 'LT' ? '4h' : '15m');
  const coins = clamp(parseInt(b.coins, 10) || 10, 1, 40);
  if (!TOP.length) return res.status(503).json({ error: 'Hazır değil' });
  if (Object.values(jobs).some(j => j.status === 'çalışıyor')) return res.status(429).json({ error: 'Başka çalışıyor' });
  const id = 'B' + Date.now(), job = { id, status: 'çalışıyor', progress: 0, params: { module: mod, tf: finalTf, coins, cfgKey }, startedAt: Date.now() };
  jobs[id] = job;
  runBacktest(job).catch(e => { job.status = 'hata'; job.error = e.message; });
  res.json({ id });
}));
app.get('/api/backtest/:id', h((req, res) => { const j = jobs[req.params.id]; if (!j) return res.status(404).json({ error: 'Yok' }); res.json(j); }));

/* ═══════════════════════════════════════════════════════════════════════════
   LOAD/SAVE + INIT
   ═══════════════════════════════════════════════════════════════════════════ */
function sanitizeSettings(s) { const o = Object.assign({}, DEF_SET, s || {}); o.auto = !!o.auto; o.tradeMode = o.tradeMode === 'live' ? 'live' : 'paper'; o.margin = clamp(Number(o.margin) || DEF_SET.margin, 10, 100000); o.leverage = clamp(Math.round(Number(o.leverage) || DEF_SET.leverage), 1, 20); o.minConf = clamp(Math.round(Number(o.minConf) || DEF_SET.minConf), 40, 95); o.maxMinutes = clamp(Math.round(Number(o.maxMinutes) || DEF_SET.maxMinutes), 3, 120); o.maxOpen = clamp(Math.round(Number(o.maxOpen) || DEF_SET.maxOpen), 1, 50); o.dailyLossPct = clamp(Number(o.dailyLossPct) || 0, 0, 50); o.pumpQuick = o.pumpQuick !== false; o.aiEnabled = o.aiEnabled !== false; const rpct = Number(o.riskPct); o.riskPct = clamp(isFinite(rpct) && rpct >= 0 ? rpct : DEF_SET.riskPct, 0, 5); return o; }
function loadLTR() { const a = loadJSON(F_LTR, []); if (!Array.isArray(a)) return; const now = Date.now(); for (const e of a) { if (!e || !e.sym || !(e.step > 0) || !(e.line0 > 0)) continue; if (now - e.lineT > 12.5 * e.step || now - e.breakoutAt > 3 * D1) continue; LTR.set(e.sym + '|' + e.tf, e); } }
function saveLTR() { saveJSON(F_LTR, Array.from(LTR.values())); }
function loadAll() {
  const s = loadJSON(F_SIG, { seq: 0, list: [] });
  signals = Array.isArray(s.list) ? s.list : [];
  sigSeq = Number(s.seq) || signals.length;
  const p = loadJSON(F_PAPER, null);
  if (p && Array.isArray(p.open) && Array.isArray(p.closed)) paper = Object.assign(paper, p);
  settings = sanitizeSettings(loadJSON(F_SET, {}));
  if (settings.auto) { settings.auto = false; saveSettings(); log('GÜVENLİK: oto KAPATILDI'); }
  loadLTR(); loadAI(); loadV81();
  log('Yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık, AI ' + (aiReady() ? 'HAZIR' : 'KAPALI') + ', rej ' + RECENT_REJ.length + ', opp ' + OPPS.size + ', out ' + OUT_DONE.length);
}
function saveAll() {
  if (dirty) { dirty = false; const act = signals.filter(isOpenSignal); const cl = signals.filter(s => s.status === 'KAPALI').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 600); signals = act.concat(cl).sort((a, b) => a.createdAt - b.createdAt); saveJSON(F_SIG, { seq: sigSeq, list: signals }); paper.closed = paper.closed.slice(0, 300); saveJSON(F_PAPER, paper); }
  saveV81();
}
function saveSettings() { saveJSON(F_SET, settings); }
async function fetchRealBalance() { if (!IS_LIVE_READY) return; try { const bal = await ex.fetchBalance(); const u = bal && bal['USDT']; if (u) realBal = { total: Number(u.total) || 0, free: Number(u.free) || 0, used: Number(u.used) || 0, updatedAt: Date.now(), error: null }; } catch (e) { realBal.error = e.message; } }

async function init() {
  if (!IS_LIVE_READY) log('UYARI: Bitget API anahtarı yok — sadece PAPER');
  for (;;) { try { await ex.loadMarkets(); await refreshUniverse(); break; } catch (e) { log('HATA borsa: ' + e.message + ', 15 sn'); await sleep(15000); } }
  every('evren', 30 * M1, refreshUniverse, 30 * M1);
  every('piyasa', 2 * M1, marketCycle, 3000);
  every('realbal', 30000, fetchRealBalance, 5000);
  every('livesync', 10000, syncLive, 15000);
  every('ticker', 3000, refreshTickers, 0);
  if (PUMP.useIgnition) { every('armed', 30000, refreshArmed, 2500); every('atr', 30000, refreshAtr, 6000); }
  every('pump', PUMP.useIgnition ? 500 : 1000, pumpCycle, 1500);
  every('scalpx', SCALPX.scanMs, scalpScanX, 20000);
  every('takip', 20000, trackerCycle, 8000);
  if (MODS.SCALPER.enabled) every('scalper', 60000, scanScalper, 12000);
  if (MODS.RANGE.enabled) every('range', 5 * M1, scanRange, 25000);
  if (MODS.ZONE.enabled) every('zone', 5 * M1, scanZone, 45000);
  if (MODS.TREND.enabled) { every('trend-signals', AI.aiScanTrendMs, scanTrendSignals, 60000); every('trend-watch', 10 * M1, trendWatchCycle, 60000); }
  if (MODS.LT.enabled) { every('lt-signals', AI.aiScanLTMs, scanLTSignals, 120000); every('lt-watch', 15 * M1, ltWatchCycle, 120000); every('ltretest', 60000, ltRetestCycle, 120000); }
  if (MODS.DAILY.enabled) { every('dailylev', 60 * M1, refreshDailyLevels, 30000); every('daily', DAILY.scanEvery, scanDaily, 90000); }
  every('radar', 5 * M1, radarCycle, 20000);
  every('aibrief', 30 * M1, aiMarketBrief, 150000);
  every('outTick', 30000, outTick, 30000); /* v81 */
  every('oppPrune', 5 * M1, oppPrune, 300000); /* v81 */
  every('wsFlowSub', 3 * M1, wsFlowSubscribe, 180000); /* v81 */
  every('save', 30000, saveAll, 30000);
  every('pump-log', 5 * M1, () => { log('Scalp: ' + stats.pumpScanned + ' mum, ' + stats.pumpFound + ' sinyal'); const why = Object.keys(PWHY).sort((a, b) => PWHY[b] - PWHY[a]).map(k => k + ' ' + PWHY[k]).join(', '); if (why) log('Scalp red: ' + why); Object.keys(PWHY).forEach(k => delete PWHY[k]); stats.pumpScanned = 0; stats.pumpFound = 0; }, 5 * M1);
  every('temizlik', 10 * M1, () => { const now = Date.now(); Object.keys(jobs).forEach(k => { if (now - jobs[k].startedAt > 30 * M1) delete jobs[k]; }); prunePumpState(now); if (SCALP_SEEN.size > 4000) SCALP_SEEN.clear(); }, 10 * M1);
}
function start() {
  log('AlphaSon ' + VERSION + ' başlatılıyor...');
  log('Maliyet: FEE=%' + FEE_ROUNDTRIP + ' slip=%' + PAPER_SLIP + ' toplam=%' + COST_TOTAL);
  loadAll();
  log('AI: ' + (aiReady() ? 'HAZIR (' + aiKeys().length + ' sağlayıcı)' : 'anahtar yok'));
  log('Katı AI: entryAllowed=' + AI.requireEntryAllowed + ', triggerConfirmed=' + AI.requireTriggerConfirmed + ', rejectLateEntry=' + AI.rejectLateEntry);
  log('v81 katmanı: OUT/MARKS=[' + OUT_MARKS.join(',') + '], LT watch, TREND watch, scalp watch aktif');
  if (PUMP.useIgnition) stream.start();
  setTimeout(() => aiBootstrap().catch(e => log('AI BOOTSTRAP: ' + e.message)), 4000);
  setInterval(() => discoverAll().catch(() => { }), 60 * M1);
  app.listen(PORT, () => log('Sunucu: port ' + PORT));
  init().catch(e => log('KRİTİK: ' + e.message));
}
process.on('uncaughtException', e => log('UNCAUGHT: ' + (e && e.message)));
process.on('unhandledRejection', e => log('UNHANDLED: ' + (e && e.message ? e.message : e)));
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { log('Kapanıyor...'); dirty = true; saveAll(); process.exit(0); }));
if (require.main === module) start();
module.exports = { VERSION, aiStatus, getSignals: () => signals, getSettings: () => settings, RECENT_REJ, WATCH, OPPS, OUT_DONE, FEE_ROUNDTRIP, COST_TOTAL };
