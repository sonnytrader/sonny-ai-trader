'use strict';
/*
 * AlphaSon v62.4 - Sinyal + Paper + Manuel Kontrol (tek dosya)
 * Kurulum: npm i ccxt && node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let ccxt;
try { ccxt = require('ccxt'); } catch (e) { console.error('ccxt bulunamadı. Önce: npm i ccxt'); process.exit(1); }

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'alphason_signals.json');
const PAPER_FILE = path.join(__dirname, 'alphason_paper.json');
const envN = (k, d) => (process.env[k] == null || process.env[k] === '' || isNaN(+process.env[k])) ? d : +process.env[k];

const CFG = {
  minQv: envN('MIN_QV', 500000),
  batchMin: 60, batchMax: 60, cyclesPerFull: 6,
  scanEvery: 120000, pumpEvery: 30000, paperTrackEvery: 20000, pendingEvery: 5000,
  tickerEvery: 15000, radarEvery: 300000, trackEvery: 30000,
  gapMs: 120, maxSignals: 400, keepMs: 7 * 864e5, snapTtl: 50 * 60e3,
  maxAgeH: { lt: 72, trend: 24, scalper: 12, pump: 6, zone: 24, range: 12 },
  // v62.4: modül başına max açık sinyal (toplu tetikleme engeli)
  moduleLimits: { trend: 2, scalper: 3, zone: 3, lt: 2, range: 2, pump: 5 },
  globalMaxOpen: 18,
  blockRecentCount: 6,     // son 10dk aynı yönde 6+ açık varsa yeni blok
  blockRecentMs: 10 * 60e3,
  pump: {
    n: envN('PUMP_N', 150),
    window: 3, baseBars: 20,
    volX: envN('PUMP_VOLX', 1.6),
    movePct: envN('PUMP_MOVE', 0.5),
    takerLong: 0.55, takerShort: 0.45,
    rsiLongMax: 82, rsiShortMin: 18,
    slAtr: 1.5, slMinPct: 0.005, slMaxPct: 0.02, tp1R: 1.0, tp2R: 2.0,
    dedupMs: 5 * 60e3, logEvery: 300000,
    obOn: envN('PUMP_OB', 0) === 1,
    obLevels: 20, obLong: 1.3, obShort: 0.77
  },
  paper: {
    maxOpen: 5, maxPerSector: 2, histKeep: 200,
    confirmMs: envN('CONFIRM_MS', 10000),
    confirmMinAdv: -0.15, confirmMaxAdv: 0.9, confirmMinVolX: 0.8,
    trailStartR: 1.5, trailGapR: 1.0,
    tightAfterMs: 5 * 60e3, tightMinFavR: 0.3, tightToR: 0.5
  },
  zone: { slAtr: 0.5, tp1R: 1.5, tp2R: 2.5, minRiskPct: 0.005, tol: 0.002, minStrength: 40 },
  range: { ratioMax: 0.85, widthMax: 3.5, volX: 1.5, slAtr: 1.5, slMaxPct: 0.04, tp1R: 1.5, tp2R: 2.5, minRiskPct: 0.003 }
};
const OK_TF = ['15m', '30m', '1h', '2h', '4h', '6h', '12h'];
const TRI_TF = OK_TF.includes(process.env.TRI_TF) ? process.env.TRI_TF : '2h';
const MKT_FILTER = ['hide', 'mark', 'off'].includes((process.env.MKT_FILTER || '').toLowerCase()) ? process.env.MKT_FILTER.toLowerCase() : 'hide';
const VERSION = 'v62.4';
const TF_MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5 };
const TREND_TF = '1h';
const TREND_HTF = ['1h', '4h'].includes(process.env.TREND_HTF) ? process.env.TREND_HTF : '4h';
const TREND_ATR_MULT = 1.5;
const TREND_TP1 = 1.0, TREND_TP2 = 2.0;
const LT_VOLX = envN('LT_VOLX', 1.5);
const LT_TAKER_LONG = 0.60, LT_TAKER_SHORT = 0.40;
const LT_BREAK_PCT = 0.005, LT_MAX_DRIFT_R = 0.15;
const SC_MIN_VOLX = 2.0, SC_MAX_AGE = 4, SC_MAX_DIST_PCT = 1.5, SC_TP1 = 1.5, SC_TP2 = 2.5;
const BREADTH_TH = envN('BREADTH_TH', 0.60);
const COST = 0.0012;

const NON_CRYPTO = new Set([
  'QQQ','SPY','IWM','US500','US30','US100','NAS100','DE40','UK100','JP225',
  'NVDA','TSLA','AAPL','MSFT','AMZN','GOOGL','GOOG','META','NFLX','AMD','INTC','MU',
  'MSTR','COIN','HOOD','CRCL','PLTR','SNDK','SNXX','SOXL','SOXS',
  'OPENAI','ANTHROPIC','CRWV','NBIS','SKHY','SKHYNIX','SAMSUNG','DRAM','ZHIPU','MINIMAX',
  'BR','BTW','Q','SPXC','EWY','KORU','MUU','BWET','LITE','AVGO','CSOP','CSOPSS2LHKD',
  'XAU','XAG','XPT','XPD','CL','BZ','WTI','BRENT','USOIL','UKOIL','NATGAS','NG','COPPER','HG',
  'PAXG','XAUT'
].concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)));
const isNonCrypto = sym => NON_CRYPTO.has(sym.split('/')[0].toUpperCase());

const SECTOR_LISTS = {
  L1: 'BTC ETH SOL ADA AVAX DOT NEAR SUI APT ATOM TON TRX BNB XRP LTC BCH ETC ALGO FIL ICP SEI INJ TIA HBAR XLM KAS FTM S EGLD',
  MEME: 'DOGE SHIB PEPE WIF BONK FLOKI MEME TURBO POPCAT MOG NEIRO PNUT GOAT FARTCOIN TRUMP BOME MEW BRETT',
  AI: 'FET RENDER RNDR TAO WLD AGIX OCEAN AI16Z VIRTUAL ARKM GRASS AIXBT GRIFFAIN GRT AKT',
  DEFI: 'UNI AAVE MKR CRV LDO SNX COMP SUSHI DYDX GMX PENDLE JUP RAY ENA ONDO ETHFI 1INCH BAL'
};
const SECTOR = {};
for (const k in SECTOR_LISTS) SECTOR_LISTS[k].split(' ').forEach(b => { SECTOR[b] = k; });
function sectorOf(sym) {
  let b = String(sym).split('/')[0].toUpperCase().replace(/^(10000|1000|1M)/, '');
  return SECTOR[b] || null;
}

const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap', defaultSubType: 'linear' } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let lastCall = 0, chain = Promise.resolve();
function throttle(fn) {
  const run = chain.then(async () => {
    const w = lastCall + CFG.gapMs - Date.now();
    if (w > 0) await sleep(w);
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}
async function safeFetch(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await throttle(fn); }
    catch (e) {
      err = e;
      const rl = e instanceof ccxt.RateLimitExceeded || e instanceof ccxt.DDoSProtection;
      await sleep(600 * (i + 1) * (rl ? 3 : 1));
    }
  }
  throw err;
}
async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'AlphaSon/1.0' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const cache = new Map();
async function getCandles(sym, tf = TRI_TF, limit = 250, ttl = 60000) {
  const k = sym + '|' + tf + '|' + limit;
  const c = cache.get(k);
  if (c && Date.now() - c.t < ttl) return c.v;
  const raw = await safeFetch(() => ex.fetchOHLCV(sym, tf, undefined, limit));
  const v = raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  cache.set(k, { t: Date.now(), v });
  if (cache.size > 900) {
    const old = [...cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 300);
    old.forEach(e => cache.delete(e[0]));
  }
  return v;
}

const TICK = {};
let ALL = [], UNIVERSE = [], PUMPU = [];
const PH = [];
let CURSOR = 0, BATCH_INFO = { size: 0, total: 0 };

async function refreshTickers() {
  const t = await safeFetch(() => ex.fetchTickers());
  for (const k in t) {
    const m = ex.markets[k];
    if (!m || !m.swap || !m.linear || m.quote !== 'USDT' || m.active === false) continue;
    const x = t[k];
    if (!x.last) continue;
    TICK[k] = { last: x.last, pct: x.percentage, qv: x.quoteVolume || 0 };
  }
  ALL = Object.keys(TICK).filter(k => !isNonCrypto(k) && TICK[k].qv >= CFG.minQv).sort((a, b) => TICK[b].qv - TICK[a].qv);
  UNIVERSE = ALL;
  PUMPU = ALL.slice(0, CFG.pump.n);
  const now = Date.now();
  if (!PH.length || now - PH[PH.length - 1].t >= 290000) {
    const p = {};
    for (const k of ALL) p[k] = TICK[k].last;
    PH.push({ t: now, p });
    while (PH.length && now - PH[0].t > 75 * 60e3) PH.shift();
  }
}
function nextBatch() {
  const n = UNIVERSE.length;
  if (!n) return [];
  const size = Math.min(n, CFG.batchMax, Math.max(CFG.batchMin, Math.ceil(n / CFG.cyclesPerFull)));
  const out = [];
  for (let i = 0; i < size; i++) out.push(UNIVERSE[(CURSOR + i) % n]);
  CURSOR = (CURSOR + size) % n;
  BATCH_INFO = { size, total: n };
  return out;
}
async function takerRatio(sym, fb) {
  try {
    const tr = await safeFetch(() => ex.fetchTrades(sym, undefined, 300));
    let b = 0, t = 0;
    for (const x of tr) {
      const v = (x.cost != null ? x.cost : x.amount * x.price) || 0;
      t += v;
      if (x.side === 'buy') b += v;
    }
    if (t > 0) return b / t;
  } catch (e) {}
  return fb;
}
function candleTaker(cs) {
  let b = 0, t = 0;
  for (const c of cs) {
    const r = c.h > c.l ? (c.c - c.l) / (c.h - c.l) : 0.5;
    b += c.v * r; t += c.v;
  }
  return t ? b / t : 0.5;
}

function ema(a, p) {
  const k = 2 / (p + 1), o = [];
  let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o.push(e); }
  return o;
}
function atrArr(cs, p = 14) {
  const o = []; let a = 0;
  for (let i = 0; i < cs.length; i++) {
    const tr = i === 0 ? cs[i].h - cs[i].l
      : Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    a = i < p ? (a * i + tr) / (i + 1) : (a * (p - 1) + tr) / p;
    o.push(a);
  }
  return o;
}
function rsiLast(closes, p = 14) {
  if (closes.length < p + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function pivots(cs, L = 3, R = 3, from = 0, to = cs.length - 1) {
  const hi = [], lo = [];
  for (let i = Math.max(L, from); i <= to - R; i++) {
    let h = true, l = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (cs[j].h > cs[i].h) h = false;
      if (cs[j].l < cs[i].l) l = false;
    }
    if (h) hi.push({ i, p: cs[i].h });
    if (l) lo.push({ i, p: cs[i].l });
  }
  return { hi, lo };
}
function trf(cs, per1 = 27, m1 = 1.6, per2 = 55, m2 = 2.0) {
  const src = cs.map(c => c.c);
  const diff = src.map((x, i) => (i ? Math.abs(x - src[i - 1]) : 0));
  const rng = (t, m) => ema(ema(diff, t), t * 2 - 1).map(x => x * m);
  const r1 = rng(per1, m1), r2 = rng(per2, m2);
  const filt = r => {
    const f = [src[0]];
    for (let i = 1; i < src.length; i++) {
      const x = src[i], p = f[i - 1];
      let v;
      if (x > p) v = (x - r[i]) < p ? p : x - r[i];
      else v = (x + r[i]) > p ? p : x + r[i];
      f.push(v);
    }
    return f;
  };
  const f1 = filt(r1), f2 = filt(r2);
  const fl = f1.map((x, i) => (x + f2[i]) / 2);
  const dir = [0]; let up = 0, dn = 0;
  for (let i = 1; i < src.length; i++) {
    if (fl[i] > fl[i - 1]) { up += 1; dn = 0; }
    else if (fl[i] < fl[i - 1]) { dn += 1; up = 0; }
    const lc = src[i] > fl[i] && up > 0;
    const sc = src[i] < fl[i] && dn > 0;
    dir.push(lc ? 1 : sc ? -1 : dir[i - 1]);
  }
  return { filt: fl, dir };
}
function fmtN(p) { return Number(p).toPrecision(5); }

/* ───────── Sinyal deposu ───────── */
let SIGNALS = [];
const SIGSET = new Set();
let DIRTY = false;
const SNAP = { zones: new Map(), range: new Map(), lt: new Map() };
let MARKET = { dir: 'NÖTR', trfDir: 'NÖTR', btc: 0, eth: 0, breadth: null, src: 'trf', time: 0 };
let RADAR = {};
let LAST_SCAN = 0, SCANNING = false;

try {
  if (fs.existsSync(DATA_FILE)) {
    SIGNALS = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).filter(s => Date.now() - s.time < CFG.keepMs);
    SIGNALS.forEach(s => SIGSET.add(s.id));
  }
} catch (e) { log('Kayıt dosyası okunamadı:', e.message); }
function save() {
  if (!DIRTY) return;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(SIGNALS)); DIRTY = false; } catch (e) { log('Kayıt hatası', e.message); }
}
setInterval(save, 60000);
const bye = () => { save(); savePaper(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
process.on('uncaughtException', e => log('uncaughtException', e && e.message));

const isOpenSig = s => !s.stopped && !s.hit2 && !s.expired;
const isCounter = s => MARKET.dir !== 'NÖTR' && s.dir !== MARKET.dir;
const hasOpenMod = (sym, mod) => SIGNALS.some(s => s.symbol === sym && s.module === mod && isOpenSig(s));

function openSameDir(s) { return SIGNALS.filter(x => x.symbol === s.symbol && isOpenSig(x) && x.dir === s.dir && x.module !== s.module); }
function canOpen(s) {
  const open = SIGNALS.filter(x => x.symbol === s.symbol && isOpenSig(x));
  return open.every(x => x.dir === s.dir && x.module !== s.module);
}
let PEND = null;
function emit(o) { if (PEND) { PEND.push(o); return true; } return addSignal(o); }
function qScore(s) {
  let q = ({ lt: 70, trend: 55, scalper: 45, pump: 60, zone: 50, range: 48 })[s.module] || 40;
  q += s.q || 0;
  if (s.dir === MARKET.dir) q += 10;
  return q;
}
function confOf(s) { const q = qScore(s); return Math.round(Math.min(99, Math.max(50, 50 + (q - 40) / 75 * 49))); }
function addSignal(o) {
  try {
    const s = Object.assign({ time: Date.now(), status: 'AÇIK', hit1: false, hit2: false, stopped: false, tf: '15m', info: [] }, o);
    if (!s.id) s.id = crypto.createHash('md5').update(JSON.stringify([s.module, s.symbol, s.dir, s.time])).digest('hex').slice(0, 12);
    if (SIGSET.has(s.id)) return false;
    if (!(s.entry > 0) || !(s.sl > 0) || s.sl === s.entry) return false;
    if (s.conf == null) s.conf = confOf(s);
    if (isCounter(s)) {
      if (s.module === 'pump') s.counter = true;
      else {
        if (MKT_FILTER === 'hide') return false;
        if (MKT_FILTER === 'mark') s.counter = true;
      }
    }
    if (!canOpen(s)) return false;

    /* v62.4: TOPLU TETİKLEME ENGELİ — 3 katman */
    if (!s.watch) {
      // 1) Modül limiti
      const modLimit = CFG.moduleLimits[s.module] || 3;
      const modOpen = SIGNALS.filter(x => x.module === s.module && isOpenSig(x) && !x.watch).length;
      if (modOpen >= modLimit) {
        log('SİNYAL BLOK (modül dolu):', s.module, s.symbol, modOpen + '/' + modLimit);
        return false;
      }
      // 2) Aynı yönde son 10 dk 6+ açık
      const recentSameDir = SIGNALS.filter(x => x.time > Date.now() - CFG.blockRecentMs && x.dir === s.dir && isOpenSig(x) && !x.watch).length;
      if (recentSameDir >= CFG.blockRecentCount) {
        log('SİNYAL BLOK (toplu tetikleme):', s.module, s.symbol, s.dir, recentSameDir + ' açık');
        return false;
      }
      // 3) Global açık sinyal limiti
      const totalOpen = SIGNALS.filter(x => isOpenSig(x) && !x.watch).length;
      if (totalOpen >= CFG.globalMaxOpen) {
        log('SİNYAL BLOK (global limit):', s.module, s.symbol, totalOpen + '/' + CFG.globalMaxOpen);
        return false;
      }
    }

    const same = openSameDir(s).length;
    if (same) s.conf = Math.min(99, s.conf + 6 * same);
    SIGSET.add(s.id);
    SIGNALS.unshift(s);
    while (SIGNALS.length > CFG.maxSignals) { const x = SIGNALS.pop(); SIGSET.delete(x.id); }
    DIRTY = true;
    log('SİNYAL', s.module, s.symbol, s.dir, same ? '(konfluans x' + (same + 1) + ')' : (s.counter ? '(counter)' : ''));
    return true;
  } catch (e) { log('addSignal hata', e.message); return false; }
}

const sigRisk = s => Math.abs(s.entry - s.sl) || 1e-9;
function closeSig(s, R, status, exit) {
  s.R = R - COST * s.entry / sigRisk(s);
  s.status = status; s.exit = exit; s.closed = Date.now();
  if (status === 'TP2') { s.hit1 = true; s.hit2 = true; }
  else if (status.indexOf('STOP') >= 0) s.stopped = true;
  else s.expired = true;
  DIRTY = true;
}
function sigR(s) {
  if (s.R != null) return s.R;
  const risk = sigRisk(s), r1 = Math.abs(s.tp1 - s.entry) / risk, r2 = Math.abs(s.tp2 - s.entry) / risk;
  if (s.hit2) return 0.5 * r1 + 0.5 * r2;
  if (s.stopped) return s.hit1 ? 0.5 * r1 - 0.5 : -1;
  return null;
}
let TRACKING = false;
async function trackSignals() {
  if (TRACKING) return;
  TRACKING = true;
  try {
    const now = Date.now();
    for (const s of SIGNALS) {
      if (!isOpenSig(s) || !s.sl) continue;
      const L = s.dir === 'LONG', risk = sigRisk(s);
      const r1 = Math.abs(s.tp1 - s.entry) / risk, r2 = Math.abs(s.tp2 - s.entry) / risk;
      let cs = null;
      try { cs = await getCandles(s.symbol, '1m', 200, 25000); } catch (e) {}
      let done = false;
      if (cs && cs.length) {
        const from = s.chk || (Math.floor(s.time / 6e4) * 6e4 + 6e4);
        for (let i = 0; i < cs.length && !done; i++) {
          const c = cs[i];
          if (c.t < from) continue;
          const be = s.module === 'pump' && s.hit1;
          const slx = be ? s.entry : s.sl;
          const stop = !(be && s.tp1At === c.t) && (L ? c.l <= slx : c.h >= slx);
          const t1 = L ? c.h >= s.tp1 : c.l <= s.tp1;
          const t2 = L ? c.h >= s.tp2 : c.l <= s.tp2;
          if (stop) {
            if (be) closeSig(s, 0.5 * r1, 'TP1 → BE-STOP', s.entry);
            else closeSig(s, s.hit1 ? 0.5 * r1 - 0.5 : -1, s.hit1 ? 'TP1 → STOP' : 'STOP', s.sl);
            done = true;
          }
          else if (t2) { closeSig(s, 0.5 * r1 + 0.5 * r2, 'TP2', s.tp2); done = true; }
          else if (t1 && !s.hit1) { s.hit1 = true; s.status = 'TP1'; s.tp1At = c.t; DIRTY = true; }
          if (i < cs.length - 1) s.chk = c.t + 6e4;
        }
      }
      if (!done && now - s.time > (CFG.maxAgeH[s.module] || 24) * 36e5) {
        const tk = TICK[s.symbol];
        const p = tk ? tk.last : s.entry;
        const open = (L ? p - s.entry : s.entry - p) / risk;
        closeSig(s, s.hit1 ? 0.5 * r1 + 0.5 * open : open, s.hit1 ? 'TP1 + SÜRE' : 'SÜRE DOLDU', p);
      }
    }
  } catch (e) { log('trackSignals hata', e.message); }
  finally { TRACKING = false; }
}
function computeStats() {
  const out = {};
  for (const m of ['trend', 'lt', 'pump', 'scalper', 'zone', 'range']) {
    const arr = SIGNALS.filter(s => s.module === m);
    let win = 0, loss = 0, open = 0, R = 0;
    for (const s of arr) {
      if (isOpenSig(s)) { open++; continue; }
      const r = sigR(s);
      if (r == null) continue;
      if (r > 0) win++; else loss++;
      R += r;
    }
    const closed = win + loss;
    out[m] = { total: arr.length, open, win, loss, winRate: closed ? win / closed * 100 : null, R };
  }
  return out;
}

/* ───────── Piyasa yönü ───────── */
function breadthCalc() {
  if (ALL.length < 30) return null;
  let up24 = 0, n24 = 0;
  for (const k of ALL) { const x = TICK[k].pct; if (x == null || !isFinite(x)) continue; n24++; if (x > 0) up24++; }
  const share24 = n24 >= 30 ? up24 / n24 : null;
  let share1h = null, ref = null;
  const target = Date.now() - 60 * 60e3;
  for (const s of PH) { const d = Math.abs(s.t - target); if (d < 12 * 60e3 && (!ref || d < Math.abs(ref.t - target))) ref = s; }
  if (ref) {
    let u = 0, n = 0;
    for (const k of ALL) { const p0 = ref.p[k]; if (!p0 || !TICK[k]) continue; n++; if (TICK[k].last > p0) u++; }
    if (n >= 30) share1h = u / n;
  }
  if (share24 == null && share1h == null) return null;
  const share = share24 == null ? share1h : share1h == null ? share24 : (share24 * 0.3 + share1h * 0.7);
  return { share, share24, share1h, n: n24 };
}
async function marketDirection() {
  const dirs = [];
  for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) {
    const c = await getCandles(s, '15m', 250, 120000);
    dirs.push(trf(c.slice(0, -1)).dir.slice(-1)[0]);
  }
  const trfDir = dirs[0] === 1 && dirs[1] === 1 ? 'LONG' : dirs[0] === -1 && dirs[1] === -1 ? 'SHORT' : 'NÖTR';
  const br = breadthCalc();
  let d = trfDir, src = 'trf';
  if (br) {
    if (br.share >= BREADTH_TH) { d = 'LONG'; src = 'genislik'; }
    else if (br.share <= 1 - BREADTH_TH) { d = 'SHORT'; src = 'genislik'; }
  }
  MARKET = { dir: d, trfDir, btc: dirs[0], eth: dirs[1], breadth: br, src, time: Date.now() };
}

/* ───────── LT üçgen ───────── */
const LT_WINDOWS = [120, 240, 400, 600, 800, 1000];
function lineAt(l, i) { return l.p1 + (l.p2 - l.p1) * (i - l.i1) / (l.i2 - l.i1); }
function evalHull(cs, W) {
  const b = cs.length - 1;
  const last = b - 1, lo0 = b - W;
  if (lo0 < 0) return null;
  let iH = lo0, iL = lo0;
  for (let i = lo0; i <= last; i++) {
    if (cs[i].h >= cs[iH].h) iH = i;
    if (cs[i].l <= cs[iL].l) iL = i;
  }
  if (last - iH < 20 || last - iL < 20) return null;
  let sR = -Infinity, jR = -1, sS = Infinity, jS = -1;
  for (let q = iH + 1; q <= last; q++) { const s = (cs[q].h - cs[iH].h) / (q - iH); if (s > sR) { sR = s; jR = q; } }
  for (let q = iL + 1; q <= last; q++) { const s = (cs[q].l - cs[iL].l) / (q - iL); if (s < sS) { sS = s; jS = q; } }
  if (jR - iH < 8 || jS - iL < 8) return null;
  if (sR >= 0 || sS <= 0) return null;
  const res = { i1: iH, p1: cs[iH].h, i2: jR, p2: cs[jR].h };
  const sup = { i1: iL, p1: cs[iL].l, i2: jS, p2: cs[jS].l };
  const ratio = Math.abs(sR / res.p1) / Math.abs(sS / sup.p1);
  if (ratio < 0.2 || ratio > 5) return null;
  const start = Math.min(iH, iL);
  const w0 = lineAt(res, start) - lineAt(sup, start);
  const wn = lineAt(res, last) - lineAt(sup, last);
  if (w0 <= 0 || wn <= 0) return null;
  if (w0 / cs[b].c < 0.02) return null;
  const squeeze = wn / w0;
  if (squeeze > 0.70) return null;
  const apex = start + w0 / (sS - sR);
  const mat = (b - start) / (apex - start);
  if (mat < 0.4 || mat > 1.05) return null;
  let tR = 0, tS = 0, lr = -9, ls = -9, bad = 0;
  for (let i = start; i <= last; i++) {
    const R = lineAt(res, i), S = lineAt(sup, i), c = cs[i];
    if (c.c > R * 1.003 || c.c < S * 0.997) { bad++; if (bad > 2) return null; }
    if (c.h >= R * 0.997 && i - lr >= 3) { tR++; lr = i; }
    if (c.l <= S * 1.003 && i - ls >= 3) { tS++; ls = i; }
  }
  if (tR < 2 || tS < 2 || tR + tS < 5) return null;
  return { res, sup, start, apex, mat, squeeze, w0, wn, touches: tR + tS, W };
}
function fitLines(cs) {
  for (let k = LT_WINDOWS.length - 1; k >= 0; k--) { const r = evalHull(cs, LT_WINDOWS[k]); if (r) return r; }
  return null;
}
function mkLines(cs, fit, b) {
  return [
    { k: 'res', t1: cs[fit.start].t, p1: lineAt(fit.res, fit.start), t2: cs[b].t, p2: lineAt(fit.res, b) },
    { k: 'sup', t1: cs[fit.start].t, p1: lineAt(fit.sup, fit.start), t2: cs[b].t, p2: lineAt(fit.sup, b) }
  ];
}
function ltConfirm(bk, tk) {
  if (bk.volX < LT_VOLX) return false;
  return bk.dir === 'LONG' ? tk >= LT_TAKER_LONG : tk <= LT_TAKER_SHORT;
}
function detLT(cs, tf, curP) {
  if (cs.length < 80) return null;
  const price = curP || cs[cs.length - 1].c;
  let watch = null;
  for (let k = 0; k < 4; k++) {
    const sub = k ? cs.slice(0, cs.length - k) : cs;
    if (sub.length < 80) break;
    const b = sub.length - 1;
    const fit = fitLines(sub);
    if (!fit) continue;
    const R = lineAt(fit.res, b), S = lineAt(fit.sup, b);
    const Rp = lineAt(fit.res, b - 1), Sp = lineAt(fit.sup, b - 1);
    const cl = sub[b].c, pc = sub[b - 1].c;
    const h = Math.min(fit.w0, cl * 0.1);
    const mid = (R + S) / 2;
    const lines = mkLines(sub, fit, b);
    const span = Math.round((b - fit.start) * (sub[1].t - sub[0].t) / 864e5);
    let dir = null;
    if (cl > R * (1 + LT_BREAK_PCT) && pc <= Rp * (1 + LT_BREAK_PCT)) dir = 'LONG';
    else if (cl < S * (1 - LT_BREAK_PCT) && pc >= Sp * (1 - LT_BREAK_PCT)) dir = 'SHORT';
    if (dir) {
      let vsum = 0;
      for (let i = b - 20; i < b; i++) vsum += sub[i].v;
      const volX = sub[b].v / (vsum / 20 || 1);
      if (volX < LT_VOLX) continue;
      const L = dir === 'LONG', sg = L ? 1 : -1;
      let sl = L ? Math.min(mid, cl * 0.996) : Math.max(mid, cl * 1.004);
      if (Math.abs(cl - sl) > cl * 0.03) sl = L ? cl * 0.97 : cl * 1.03;
      const risk0 = Math.abs(cl - sl);
      if (Math.abs(price - cl) > LT_MAX_DRIFT_R * risk0) continue;
      if (L ? price <= sl : price >= sl) continue;
      return { brk: { dir, entry: price, sl, tp1: price + sg * h * 0.618, tp2: price + sg * h, lines, volX, tkp: candleTaker([sub[b]]), touches: fit.touches, mat: fit.mat, span, t: sub[b].t, key: 'lt|' + tf + '|' + dir + '|' + sub[b].t } };
    }
    if (k === 0 && cl < R && cl > S) {
      const dR = R - cl, dS = cl - S, wn = R - S;
      if (Math.min(dR, dS) <= Math.max(wn * 0.25, cl * 0.003) && fit.mat >= 0.55) {
        const L = dR < dS, sg = L ? 1 : -1, trig = L ? R : S;
        const sl = L ? Math.min(mid, trig * 0.996) : Math.max(mid, trig * 1.004);
        watch = { dir: L ? 'LONG' : 'SHORT', trig, dist: Math.min(dR, dS) / cl * 100, sl, tp1: trig + sg * h * 0.618, tp2: trig + sg * h, lines, touches: fit.touches, mat: fit.mat, span };
      }
    }
  }
  return watch ? { watch } : null;
}
async function ltMod(sym, c, tf, watchOut) {
  const cs = c.slice(0, -1);
  if (cs.length < 80) return;
  const curP = TICK[sym] ? TICK[sym].last : cs[cs.length - 1].c;
  const r = detLT(cs, tf, curP);
  if (!r) return;
  if (r.watch) {
    const w = r.watch;
    if (!hasOpenMod(sym, 'lt') && (MKT_FILTER !== 'hide' || !isCounter(w))) {
      watchOut.set('ltw|' + tf + '|' + sym, {
        id: 'ltw|' + tf + '|' + sym, module: 'lt', watch: true, symbol: sym, dir: w.dir, tf, time: Date.now(),
        entry: w.trig, sl: w.sl, tp1: w.tp1, tp2: w.tp2, lines: w.lines, dist: w.dist, status: 'YAKLAŞIYOR',
        conf: Math.round(Math.min(95, 50 + w.touches * 2 + w.mat * 15)),
        info: [['Tetik', fmtN(w.trig)], ['Uzaklık', '%' + w.dist.toFixed(2)], ['Değme', w.touches], ['Olgunluk', '%' + (w.mat * 100).toFixed(0)], ['Süre', w.span + ' gün']]
      });
    }
    return;
  }
  const bk = r.brk;
  const tk = await takerRatio(sym, bk.tkp);
  if (!ltConfirm(bk, tk)) return;
  emit({
    q: Math.min(bk.touches, 10) * 2 + Math.min(bk.volX, 5) * 3,
    id: 'lt|' + tf + '|' + sym + '|' + bk.dir + '|' + bk.t,
    module: 'lt', symbol: sym, dir: bk.dir, tf, entry: bk.entry, sl: bk.sl, tp1: bk.tp1, tp2: bk.tp2, lines: bk.lines,
    info: [['Hacim', 'x' + bk.volX.toFixed(1)], ['Taker Buy', '%' + (tk * 100).toFixed(0)], ['Değme', bk.touches], ['Olgunluk', '%' + (bk.mat * 100).toFixed(0)], ['Süre', bk.span + ' gün'], ['Zaman Dil.', tf]]
  });
}

/* ───────── TREND (1H + 4H) v62.4: EMA200 + ATR min + wave fix ───────── */
function alignHtf(cs, dt, hc, hdir, hms) {
  const out = new Int8Array(cs.length);
  let p = -1;
  for (let i = 0; i < cs.length; i++) {
    const tc = cs[i].t + dt;
    while (p + 1 < hc.length && hc[p + 1].t + hms <= tc) p++;
    out[i] = p >= 0 ? hdir[p] : 0;
  }
  return out;
}
function detTrend(cs, n, pre, opts) {
  if (n < 200) return null;                          // v62.4: 120→200 (EMA200 için)
  const dir = pre.dir;
  let chg = -1;
  for (let k = 0; k < 3; k++) if (dir[n - k] !== dir[n - k - 1]) { chg = n - k; break; }
  if (chg < 0 || dir[n] === 0) return null;
  if (!(opts && opts.noHtf) && (!pre.htfDir || pre.htfDir[n] !== dir[n])) return null;
  const L = dir[n] === 1;
  const entry = cs[n].c;
  const atr = pre.atr[n];

  // v62.4: EMA200 filter (ana trend yönünde olmalı)
  const closes = cs.map(c => c.c);
  const ema200 = ema(closes, 200);
  const ema200v = ema200[n];
  if (L ? entry <= ema200v : entry >= ema200v) return null;

  // v62.4: ATR/entry min %0.6 (çok düşük volatilite atla)
  if (atr / entry < 0.006) return null;

  let lo = Infinity, hi = -Infinity;
  for (let k = n - 9; k <= n; k++) { if (cs[k].l < lo) lo = cs[k].l; if (cs[k].h > hi) hi = cs[k].h; }
  let dist = atr * TREND_ATR_MULT;
  dist = Math.max(entry * 0.005, Math.min(dist, entry * 0.02));  // v62.4: max %5→%2
  const sl = L ? entry - dist : entry + dist;
  const risk = Math.abs(entry - sl);
  const rawWave = hi - lo;
  const wave = Math.min(Math.max(rawWave, risk), risk * 2.5);
  const sg = L ? 1 : -1;
  return { dir: L ? 'LONG' : 'SHORT', entry, sl, tp1: entry + sg * wave * TREND_TP1, tp2: entry + sg * wave * TREND_TP2, atr, t: cs[chg].t, key: 'trend|' + cs[chg].t };
}
async function trendMod(sym, c) {
  const cs = c.slice(0, -1);
  if (cs.length < 200) return;
  const n = cs.length - 1;
  const pre = { dir: trf(cs).dir, atr: atrArr(cs) };
  if (!detTrend(cs, n, pre, { noHtf: true })) return;
  const ch = await getCandles(sym, TREND_HTF, 250, 1800000);
  const hc = ch.slice(0, -1);
  if (hc.length < 120) return;
  pre.htfDir = alignHtf(cs, cs[1].t - cs[0].t, hc, trf(hc).dir, TF_MS[TREND_HTF]);
  const r = detTrend(cs, n, pre);
  if (!r) return;
  emit({
    id: 'trend|' + sym + '|' + r.t, module: 'trend', symbol: sym, dir: r.dir, tf: TREND_TF,
    q: Math.min(4, Math.abs(r.tp1 - r.entry) / Math.abs(r.entry - r.sl)) * 3 + 4,
    entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2,
    info: [['Piyasa', MARKET.dir], [TREND_HTF.toUpperCase() + ' Teyit', r.dir === 'LONG' ? '▲' : '▼'], ['Risk', '%' + (Math.abs(r.entry - r.sl) / r.entry * 100).toFixed(2)], ['ATR', '%' + (r.atr / r.entry * 100).toFixed(2)]]
  });
}

/* ───────── PAPER MOTORU ───────── */
const PAPER = {
  trades: [], balance: 0,
  cfg: { minConf: 75, maxAgeMin: 30, sizeUSDT: 50, leverage: 5, autoTrade: true, trailing: true, tightEarly: true, confirm: true }
};
const PENDING_CONFIRM = new Map();
try {
  if (fs.existsSync(PAPER_FILE)) {
    const d = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
    PAPER.trades = d.trades || [];
    PAPER.balance = d.balance || 0;
    if (d.cfg) Object.assign(PAPER.cfg, d.cfg);
  }
} catch (e) { log('Paper dosya hatası', e.message); }
function savePaper() {
  try {
    const open = PAPER.trades.filter(t => !t.closed);
    const done = PAPER.trades.filter(t => t.closed).slice(-CFG.paper.histKeep);
    PAPER.trades = done.concat(open);
    fs.writeFileSync(PAPER_FILE, JSON.stringify({ trades: PAPER.trades, balance: PAPER.balance, cfg: PAPER.cfg }));
  } catch (e) { log('Paper kayıt hatası', e.message); }
}
function paperBlock(sym) {
  const open = PAPER.trades.filter(t => !t.closed);
  if (open.some(t => t.symbol === sym)) return 'aynı coinde açık paper var';
  if (open.length >= CFG.paper.maxOpen) return 'maks ' + CFG.paper.maxOpen + ' açık paper';
  const sec = sectorOf(sym);
  if (sec && open.filter(t => sectorOf(t.symbol) === sec).length >= CFG.paper.maxPerSector) return 'sektör limiti (' + sec + ')';
  return null;
}
function mkPaper(sig, entry, manual) {
  const risk = Math.abs(sig.entry - sig.sl) || entry * 0.006;
  const r1 = Math.abs(sig.tp1 - sig.entry) / (Math.abs(sig.entry - sig.sl) || 1e-9);
  const r2 = Math.abs(sig.tp2 - sig.entry) / (Math.abs(sig.entry - sig.sl) || 1e-9);
  const sg = sig.dir === 'LONG' ? 1 : -1;
  const lev = PAPER.cfg.leverage || 1;
  return {
    id: 'paper|' + sig.id, sigId: sig.id, symbol: sig.symbol, dir: sig.dir,
    entry, sl: entry - sg * risk, tp1: entry + sg * risk * r1, tp2: entry + sg * risk * r2, risk,
    conf: sig.conf, size: PAPER.cfg.sizeUSDT, leverage: lev, notional: PAPER.cfg.sizeUSDT * lev,
    opened: Date.now(), closed: null, status: 'OPEN',
    exit: null, exitReason: null, pnl: 0, pnlPct: 0,
    remaining: 1.0, beMoved: false, checkpoint: null, manual: !!manual,
    best: entry, trailed: false, tightened: false, tp1At: 0, fee: 0
  };
}
function logPaperOpen(t, tag) {
  log(tag || '📄 PAPER AÇILDI', t.symbol, t.dir, '@' + t.entry, 'conf=' + t.conf, 'margin=$' + t.size, 'x' + t.leverage, 'notional=$' + t.notional.toFixed(2));
}
function openPaperTrade(sig, price) {
  try {
    if (!sig || sig.module !== 'pump') return;
    if (!PENDING_CONFIRM.has(sig.id)) return;
    PENDING_CONFIRM.delete(sig.id);
    if (!PAPER.cfg.autoTrade) { log('📄 OTO KAPALI - sinyal paper açmadı:', sig.symbol); return; }
    if (sig.conf < PAPER.cfg.minConf) { log('📄 PAPER conf düşük:', sig.symbol, sig.conf, '<', PAPER.cfg.minConf); return; }
    const why = paperBlock(sig.symbol);
    if (why) { log('📄 PAPER açılmadı:', sig.symbol, '-', why); return; }
    const t = mkPaper(sig, price || sig.entry, false);
    PAPER.trades.push(t);
    savePaper();
    logPaperOpen(t);
  } catch (e) { log('openPaperTrade hata', e.message); }
}
function queuePaper(sig) {
  try {
    if (!sig || sig.module !== 'pump') return;
    if (!PAPER.cfg.autoTrade) { log('📄 OTO KAPALI - sinyal paper açmadı:', sig.symbol); return; }
    if (sig.conf < PAPER.cfg.minConf) { log('📄 PAPER conf düşük:', sig.symbol, sig.conf, '<', PAPER.cfg.minConf); return; }
    if (paperBlock(sig.symbol)) return;
    const wait = PAPER.cfg.confirm ? CFG.paper.confirmMs : 0;
    PENDING_CONFIRM.set(sig.id, { sig, due: Date.now() + wait });
    if (!wait) { const tk = TICK[sig.symbol]; openPaperTrade(sig, tk ? tk.last : sig.entry); }
    else log('📄 PAPER kuyruğa alındı (teyit ' + (wait/1000) + 'sn):', sig.symbol);
  } catch (e) { log('queuePaper hata', e.message); }
}
async function confirmPump(sig) {
  const c = await getCandles(sig.symbol, '1m', 40, 5000);
  const n = c.length;
  if (n < 25) return null;
  const tk = TICK[sig.symbol];
  const cur = tk ? tk.last : c[n - 1].c;
  const L = sig.dir === 'LONG', sg = L ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl) || 1e-9;
  if (L ? cur <= sig.sl : cur >= sig.sl) return null;
  const adv = (cur - sig.entry) * sg / risk;
  if (adv < CFG.paper.confirmMinAdv || adv > CFG.paper.confirmMaxAdv) return null;
  const last = c[n - 1];
  if (L ? last.c < last.o : last.c > last.o) return null;
  const base = c.slice(n - 23, n - 3);
  const bAvg = base.reduce((a, x) => a + x.v, 0) / (base.length || 1);
  if (!bAvg) return null;
  const volX = (c[n - 1].v + c[n - 2].v) / (bAvg * 2);
  if (volX < CFG.paper.confirmMinVolX) return null;
  return cur;
}
let PENDING_RUN = false;
async function processPending() {
  if (PENDING_RUN) return;
  PENDING_RUN = true;
  try {
    const now = Date.now();
    for (const [id, p] of [...PENDING_CONFIRM.entries()]) {
      if (now < p.due) continue;
      const sig = p.sig;
      try {
        if (!PAPER.cfg.autoTrade || !isOpenSig(sig)) { PENDING_CONFIRM.delete(id); log('📄 PAPER iptal - auto OFF veya sinyal kapalı:', sig.symbol); continue; }
        const px = await confirmPump(sig);
        if (!px) { PENDING_CONFIRM.delete(id); log('📄 PAPER teyit alınamadı, iptal:', sig.symbol); continue; }
        openPaperTrade(sig, px);
      } catch (e) {
        PENDING_CONFIRM.delete(id);
        log('📄 processPending sembol hata:', sig.symbol, e.message);
      }
    }
  } catch (e) { log('processPending hata', e.message); }
  finally { PENDING_RUN = false; }
}
function openPaperManual(sigId) {
  try {
    const sig = SIGNALS.find(s => s.id === sigId);
    if (!sig || sig.module !== 'pump') return { error: 'sadece pump sinyali' };
    if (!isOpenSig(sig)) return { error: 'sinyal kapalı' };
    const why = paperBlock(sig.symbol);
    if (why) return { error: why };
    const tk = TICK[sig.symbol];
    const t = mkPaper(sig, tk ? tk.last : sig.entry, true);
    PAPER.trades.push(t);
    savePaper();
    logPaperOpen(t, '📄 PAPER AÇILDI (manuel)');
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}
function closePaper(t, exitPrice, reason) {
  if (t.closed) return;
  const L = t.dir === 'LONG';
  const notional = (t.notional != null) ? t.notional : t.size * (t.leverage || 1);
  const remainPnl = (L ? exitPrice - t.entry : t.entry - exitPrice) / t.entry * (notional * t.remaining);
  t.fee = notional * COST;
  t.pnl = t.pnl + remainPnl - t.fee;
  t.pnlPct = t.size > 0 ? t.pnl / t.size * 100 : 0;
  t.exit = exitPrice; t.closed = Date.now();
  t.exitReason = reason; t.status = reason;
  t.remaining = 0;
  PAPER.balance += t.pnl;
  savePaper();
  log('📄 PAPER KAPANDI', t.symbol, reason, 'PnL=$' + t.pnl.toFixed(4), '(margin %' + t.pnlPct.toFixed(2) + ')');
}
function manualClosePaper(id) {
  try {
    const t = PAPER.trades.find(x => x.id === id);
    if (!t) return { error: 'bulunamadı' };
    if (t.closed) return { error: 'zaten kapalı' };
    const tk = TICK[t.symbol];
    const price = tk ? tk.last : t.entry;
    closePaper(t, price, 'MANUAL');
    return { ok: true, price };
  } catch (e) { return { error: e.message }; }
}
function manualCloseSignal(id) {
  try {
    const s = SIGNALS.find(x => x.id === id);
    if (!s) return { error: 'bulunamadı' };
    if (!isOpenSig(s)) return { error: 'zaten kapalı' };
    const tk = TICK[s.symbol];
    const price = tk ? tk.last : s.entry;
    const L = s.dir === 'LONG', risk = sigRisk(s);
    const open = (L ? price - s.entry : s.entry - price) / risk;
    closeSig(s, s.hit1 ? 0.5 * (Math.abs(s.tp1 - s.entry) / risk) + 0.5 * open : open, s.hit1 ? 'TP1 + MANUEL' : 'MANUEL', price);
    return { ok: true, price };
  } catch (e) { return { error: e.message }; }
}
let PAPER_TRACKING = false;
async function trackPaper() {
  if (PAPER_TRACKING) return;
  PAPER_TRACKING = true;
  try {
    const now = Date.now();
    for (const t of PAPER.trades) {
      if (t.closed) continue;
      try {
        const cs = await getCandles(t.symbol, '1m', 60, 20000);
        if (!cs || !cs.length) continue;
        const L = t.dir === 'LONG', sg = L ? 1 : -1;
        const from = t.checkpoint || (Math.floor(t.opened / 6e4) * 6e4 + 6e4);
        const notional = (t.notional != null) ? t.notional : t.size * (t.leverage || 1);
        const risk = t.risk || Math.abs(t.entry - t.sl) || t.entry * 0.006;
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          if (c.t < from) continue;
          if (t.closed) break;
          // TP1 aynı mumda görüldüyse SL kontrolü atlanır (BE tetiklemesin)
          const skipSl = t.beMoved && t.tp1At === c.t;
          const hitSl = !skipSl && (L ? c.l <= t.sl : c.h >= t.sl);
          if (hitSl) { closePaper(t, t.sl, t.trailed ? 'TRAIL-STOP' : (t.beMoved ? 'BE-STOP' : 'STOP')); break; }
          const hitTp1 = L ? c.h >= t.tp1 : c.l <= t.tp1;
          const hitTp2 = L ? c.h >= t.tp2 : c.l <= t.tp2;
          if (hitTp1 && !t.beMoved) {
            const half = (L ? t.tp1 - t.entry : t.entry - t.tp1) / t.entry * (notional * 0.5);
            t.pnl += half; t.remaining = 0.5; t.status = 'TP1';
            t.beMoved = true; t.sl = t.entry; t.tp1At = c.t;
            savePaper();
            log('📄 PAPER TP1', t.symbol, 'yarı kapatıldı, SL→BE');
          }
          if (hitTp2 && t.beMoved) { closePaper(t, t.tp2, 'TP2'); break; }
          t.best = L ? Math.max(t.best || t.entry, c.h) : Math.min(t.best || t.entry, c.l);
          const fav = (t.best - t.entry) * sg / risk;
          if (PAPER.cfg.trailing && t.beMoved && fav >= CFG.paper.trailStartR) {
            const ns = t.best - sg * CFG.paper.trailGapR * risk;
            if (L ? ns > t.sl : ns < t.sl) { t.sl = ns; t.trailed = true; }
          }
          if (PAPER.cfg.tightEarly && !t.beMoved && !t.tightened && (c.t + 6e4 - t.opened) >= CFG.paper.tightAfterMs && fav < CFG.paper.tightMinFavR) {
            const ns = t.entry - sg * CFG.paper.tightToR * risk;
            if (L ? ns > t.sl : ns < t.sl) { t.sl = ns; log('📄 PAPER SL sıkıldı (5dk hareket yok):', t.symbol); }
            t.tightened = true;
          }
          if (i < cs.length - 1) t.checkpoint = c.t + 6e4;
        }
        if (!t.closed && now - t.opened > PAPER.cfg.maxAgeMin * 60000) {
          const tk = TICK[t.symbol];
          closePaper(t, tk ? tk.last : cs[cs.length - 1].c, 'TIMEOUT');
        }
      } catch (e) {}
    }
    savePaper();
  } catch (e) { log('trackPaper hata', e.message); }
  finally { PAPER_TRACKING = false; }
}
function paperStats() {
  const done = PAPER.trades.filter(t => t.closed);
  const open = PAPER.trades.filter(t => !t.closed);
  const wins = done.filter(t => t.pnl > 0).length;
  const losses = done.filter(t => t.pnl < 0).length;
  const totalPnl = done.reduce((a, t) => a + t.pnl, 0);
  return {
    total: done.length, open: open.length, wins, losses,
    winRate: done.length ? wins / done.length * 100 : null,
    totalPnl: +totalPnl.toFixed(4),
    balance: +PAPER.balance.toFixed(4),
    avgPnl: done.length ? +(totalPnl / done.length).toFixed(4) : null
  };
}

/* ───────── ALGOPUMP v2 (gevşetilmiş) ───────── */
const PUMP_LAST = {};
const PUMP_INFO = { last: 0, scanned: 0, signals: SIGNALS.filter(s => s.module === 'pump').length };
let PUMP_LAST_LOG = Date.now(), PUMP_WIN_SIGS = 0;

async function obRatio(sym) {
  try {
    const ob = await safeFetch(() => ex.fetchOrderBook(sym, CFG.pump.obLevels));
    let b = 0, a = 0;
    for (const x of (ob.bids || [])) b += x[0] * x[1];
    for (const x of (ob.asks || [])) a += x[0] * x[1];
    return a > 0 ? b / a : null;
  } catch (e) { return null; }
}
async function pumpScan() {
  const P = CFG.pump;
  for (const k in PUMP_LAST) if (Date.now() - PUMP_LAST[k] > P.dedupMs) delete PUMP_LAST[k];
  for (const sym of PUMPU) {
    try {
      const lastP = PUMP_LAST[sym];
      if (lastP && Date.now() - lastP < P.dedupMs) continue;
      const c = await getCandles(sym, '1m', 40, 20000);
      if (c.length < 30) continue;
      const n = c.length;
      const last = c.slice(n - P.window);
      const base = c.slice(Math.max(0, n - P.window - P.baseBars), n - P.window);
      if (base.length < 15) continue;
      const vLast = last.reduce((a, x) => a + x.v, 0);
      const vAvg = base.reduce((a, x) => a + x.v, 0) / base.length * P.window;
      if (!vAvg) continue;
      const volX = vLast / vAvg;
      if (volX < P.volX) continue;
      const priceChange = (c[n - 1].c / c[n - P.window].o - 1) * 100;
      if (Math.abs(priceChange) < P.movePct) continue;
      const c1 = c[n - 1], c2 = c[n - 2];
      const upC = c1.c > c1.o && c2.c > c2.o;
      const dnC = c1.c < c1.o && c2.c < c2.o;
      const win10 = c.slice(n - 11, n - 1);
      const hi10 = Math.max(...win10.map(q => q.h));
      const lo10 = Math.min(...win10.map(q => q.l));
      let dirCand = null;
      if (priceChange >= P.movePct && upC && c1.c > hi10) dirCand = 'LONG';
      else if (priceChange <= -P.movePct && dnC && c1.c < lo10) dirCand = 'SHORT';
      if (!dirCand) continue;
      const tk = await takerRatio(sym, candleTaker(last));
      if (dirCand === 'LONG' && tk < P.takerLong) continue;
      if (dirCand === 'SHORT' && tk > P.takerShort) continue;
      const rsi = rsiLast(c.slice(0, -1).map(q => q.c), 14);
      if (rsi != null) {
        if (dirCand === 'LONG' && rsi > P.rsiLongMax) continue;
        if (dirCand === 'SHORT' && rsi < P.rsiShortMin) continue;
      }
      let ob = null;
      if (P.obOn) {
        ob = await obRatio(sym);
        if (ob != null) {
          if (dirCand === 'LONG' && ob < P.obLong) continue;
          if (dirCand === 'SHORT' && ob > P.obShort) continue;
        }
      }
      const entry = c1.c;
      const atr = atrArr(c)[n - 1] || entry * 0.005;
      let risk = Math.max(atr * P.slAtr, entry * P.slMinPct);
      risk = Math.min(risk, entry * P.slMaxPct);
      const sg = dirCand === 'LONG' ? 1 : -1;
      const sl = entry - sg * risk;
      const tp1 = entry + sg * risk * P.tp1R;
      const tp2 = entry + sg * risk * P.tp2R;
      let conf = 50;
      conf += Math.max(0, Math.min(20, (volX - 1.6) * 3));
      conf += Math.max(0, Math.min(15, (Math.abs(priceChange) - 0.5) * 10));
      conf += Math.max(0, Math.min(10, (Math.abs(tk - 0.5) - 0.05) * 50));
      conf += 10;
      if (rsi != null && ((dirCand === 'LONG' && rsi < 65) || (dirCand === 'SHORT' && rsi > 35))) conf += 5;
      conf = Math.round(Math.min(99, Math.max(50, conf)));
      const sigId = 'pump|' + sym + '|' + dirCand + '|' + Math.floor(Date.now() / 60000);
      const info = [
        ['Hacim', 'x' + volX.toFixed(1)],
        ['Taker', '%' + (tk * 100).toFixed(0)],
        ['3dk', '%' + priceChange.toFixed(2)],
        ['ATR', '%' + (atr / entry * 100).toFixed(2)],
        ['RSI', rsi != null ? rsi.toFixed(0) : '-']
      ];
      if (ob != null) info.push(['OB', ob.toFixed(2)]);
      const added = addSignal({ id: sigId, module: 'pump', symbol: sym, dir: dirCand, tf: '1m', q: conf - 50, conf, entry, sl, tp1, tp2, info });
      if (added) {
        PUMP_LAST[sym] = Date.now();
        PUMP_INFO.signals++;
        PUMP_WIN_SIGS++;
        const justAdded = SIGNALS.find(x => x.id === sigId);
        if (justAdded) queuePaper(justAdded);
      }
    } catch (e) {}
  }
  PUMP_INFO.last = Date.now();
  PUMP_INFO.scanned = PUMPU.length;
  if (Date.now() - PUMP_LAST_LOG >= P.logEvery) {
    PUMP_LAST_LOG = Date.now();
    log('PUMP:', PUMPU.length, 'coin,', PUMP_WIN_SIGS, 'sinyal, toplam', PUMP_INFO.signals);
    PUMP_WIN_SIGS = 0;
  }
}

/* ───────── ZONE MASTER ───────── */
function groupPivots(list, tolPct = 0.5) {
  const s = list.slice().sort((a, b) => a.p - b.p);
  const groups = [];
  for (const x of s) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(x.p - g.avg) / g.avg * 100 <= tolPct) { g.items.push(x); g.avg = g.items.reduce((a, y) => a + y.p, 0) / g.items.length; }
    else groups.push({ avg: x.p, items: [x] });
  }
  return groups.map(g => ({ p: g.avg, touches: g.items.length, strength: Math.min(100, g.items.length * 12) }));
}
function zoneMod(sym, c, out) {
  const Z = CFG.zone;
  const cs = c.slice(0, -1);
  if (cs.length < 100) return;
  const pv = pivots(cs, 5, 5);
  const zones = groupPivots(pv.hi.concat(pv.lo)).filter(z => z.strength >= Z.minStrength);
  const price = (TICK[sym] && TICK[sym].last) || cs[cs.length - 1].c;
  const sups = zones.filter(z => z.p < price).sort((a, b) => b.p - a.p);
  const ress = zones.filter(z => z.p > price).sort((a, b) => a.p - b.p);
  const s = sups[0], r = ress[0];
  if (!s || !r) return;
  const ds = (price - s.p) / price * 100, dr = (r.p - price) / price * 100;
  const lv = [{ p: s.p, label: 'S ' + s.strength, color: '#10b981' }, { p: r.p, label: 'R ' + r.strength, color: '#f43f5e' }];
  out.set('zone|' + sym, {
    id: 'zone|' + sym, module: 'zone', symbol: sym, dir: ds <= dr ? 'LONG' : 'SHORT', tf: '1h', time: Date.now(),
    watch: true, entry: price, levels: lv, status: 'İZLE',
    conf: Math.round(Math.min(99, 50 + (ds <= dr ? s : r).strength * 0.49)),
    support: s, resistance: r, distS: ds, distR: dr,
    info: [['Destek', fmtN(s.p) + ' (' + s.strength + ')'], ['Direnç', fmtN(r.p) + ' (' + r.strength + ')']]
  });
  const lastC = cs[cs.length - 1];
  const atrVal = atrArr(cs)[cs.length - 1];
  if (lastC.l <= s.p * (1 + Z.tol) && lastC.c > s.p && lastC.c > lastC.o) {
    const entry = lastC.c;
    let sl = s.p - atrVal * Z.slAtr;
    if (entry - sl < entry * Z.minRiskPct) sl = entry * (1 - Z.minRiskPct);
    const risk = entry - sl;
    emit({
      id: 'zone|' + sym + '|L|' + lastC.t, module: 'zone', symbol: sym, dir: 'LONG', tf: '1h',
      entry, sl, tp1: entry + risk * Z.tp1R, tp2: entry + risk * Z.tp2R, levels: lv,
      info: [['Bölge', 'Destek Sekmesi'], ['Güç', s.strength], ['Destek', fmtN(s.p)], ['Direnç', fmtN(r.p)], ['ATR', fmtN(atrVal)]]
    });
  } else if (lastC.h >= r.p * (1 - Z.tol) && lastC.c < r.p && lastC.c < lastC.o) {
    const entry = lastC.c;
    let sl = r.p + atrVal * Z.slAtr;
    if (sl - entry < entry * Z.minRiskPct) sl = entry * (1 + Z.minRiskPct);
    const risk = sl - entry;
    emit({
      id: 'zone|' + sym + '|S|' + lastC.t, module: 'zone', symbol: sym, dir: 'SHORT', tf: '1h',
      entry, sl, tp1: entry - risk * Z.tp1R, tp2: entry - risk * Z.tp2R, levels: lv,
      info: [['Bölge', 'Direnç Sekmesi'], ['Güç', r.strength], ['Destek', fmtN(s.p)], ['Direnç', fmtN(r.p)], ['ATR', fmtN(atrVal)]]
    });
  }
}

/* ───────── SCALPER (v62.4: son 2 mum consistent + dist max %1.5) ───────── */
function detScalper(cs, n, atrA) {
  if (n < 60) return null;
  // v62.4: son 2 mum aynı yönde kapanış (momentum teyidi)
  const c1 = cs[n], c2 = cs[n - 1];
  const consistentUp = c1.c > c1.o && c2.c > c2.o;
  const consistentDn = c1.c < c1.o && c2.c < c2.o;
  if (!consistentUp && !consistentDn) return null;
  const ws = n - SC_MAX_AGE - 1;
  const pv = pivots(cs, 3, 3, ws - 150, ws);
  const sh = pv.hi[pv.hi.length - 1], sw = pv.lo[pv.lo.length - 1];
  if (!sh || !sw) return null;
  const bosOk = (j, L, level) => {
    const c = cs[j], rng = c.h - c.l;
    if (!(rng > 0) || j < 21) return 0;
    if (Math.abs(c.c - c.o) < rng * 0.5) return 0;
    if (L ? c.c <= c.o : c.c >= c.o) return 0;
    const m = Math.max(level * 0.002, atrA[j] * 0.3);
    if (L ? c.c < level + m : c.c > level - m) return 0;
    let vs = 0;
    for (let k = j - 20; k < j; k++) vs += cs[k].v;
    const volX = c.v / (vs / 20 || 1);
    return volX >= SC_MIN_VOLX ? volX : 0;
  };
  const doneUp = cs[ws].c > sh.p, doneDn = cs[ws].c < sw.p;
  let fu = -1, fd = -1;
  for (let j = ws + 1; j <= n; j++) {
    if (!doneUp && fu < 0 && cs[j].c > sh.p) fu = j;
    if (!doneDn && fd < 0 && cs[j].c < sw.p) fd = j;
  }
  const vu = fu >= 0 ? bosOk(fu, true, sh.p) : 0;
  const vd = fd >= 0 ? bosOk(fd, false, sw.p) : 0;
  if (!vu && !vd) return null;
  const L = vu > 0 && (vd === 0 || fu > fd);
  if (L && !consistentUp) return null;
  if (!L && !consistentDn) return null;
  const j = L ? fu : fd, volX = L ? vu : vd;
  const level = L ? sh.p : sw.p;
  const entry = cs[n].c;
  if (L ? entry <= level : entry >= level) return null;
  if (Math.abs(entry - level) / level * 100 > SC_MAX_DIST_PCT) return null;
  const atr = atrA[n];
  let lo = Infinity, hi = -Infinity;
  for (let k = n - 9; k <= n; k++) { if (cs[k].l < lo) lo = cs[k].l; if (cs[k].h > hi) hi = cs[k].h; }
  let sl = L ? lo - atr * 0.3 : hi + atr * 0.3;
  if (Math.abs(entry - sl) > entry * 0.02) sl = L ? entry * 0.98 : entry * 1.02;
  if (L ? sl >= entry : sl <= entry) sl = L ? entry * 0.99 : entry * 1.01;
  const risk = Math.abs(entry - sl), sg = L ? 1 : -1;
  return { dir: L ? 'LONG' : 'SHORT', entry, sl, tp1: entry + sg * risk * SC_TP1, tp2: entry + sg * risk * SC_TP2, t: cs[j].t, key: 'scalper|' + (L ? 'L' : 'S') + '|' + cs[j].t, level, age: n - j, volX };
}
function scalperMod(sym, c) {
  const cs = c.slice(0, -1);
  if (cs.length < 60) return;
  const r = detScalper(cs, cs.length - 1, atrArr(cs));
  if (!r) return;
  emit({
    id: 'scalper|' + sym + '|' + (r.dir === 'LONG' ? 'L' : 'S') + '|' + r.t,
    module: 'scalper', symbol: sym, dir: r.dir, tf: '15m', q: Math.min(r.volX, 5) * 3,
    entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2,
    levels: [{ p: r.level, label: 'BOS', color: '#a855f7' }],
    info: [['Yapı', 'BOS ' + (r.dir === 'LONG' ? '↑' : '↓')], ['Hacim', 'x' + r.volX.toFixed(1)], ['Kırılan Seviye', fmtN(r.level)], ['Mum Önce', r.age + '']]
  });
}

/* ───────── RANGE PRO ───────── */
function rangeMod(sym, c, out) {
  const RG = CFG.range;
  const cs = c.slice(0, -1);
  if (cs.length < 60) return;
  const n = cs.length - 1;
  const atr = atrArr(cs);
  const win = cs.slice(n - 20, n);
  const hi = Math.max(...win.map(x => x.h)), lo = Math.min(...win.map(x => x.l));
  const width = (hi - lo) / ((hi + lo) / 2) * 100;
  const ratio = atr[n - 1] / (atr[n - 15] || atr[n - 1]);
  if (!(ratio < RG.ratioMax && width < RG.widthMax)) return;
  const lv = [{ p: hi, label: 'Üst', color: '#06b6d4' }, { p: lo, label: 'Alt', color: '#a855f7' }];
  out.set('range|' + sym, {
    id: 'range|' + sym, module: 'range', symbol: sym, dir: 'NÖTR', tf: '15m', time: Date.now(),
    watch: true, entry: (hi + lo) / 2, status: 'SIKIŞMA',
    conf: Math.round(Math.min(95, Math.max(50, 55 + (RG.ratioMax - ratio) * 40 + (RG.widthMax - width) * 5))),
    top: hi, bottom: lo, width, atrRatio: ratio, levels: lv,
    info: [['Genişlik', '%' + width.toFixed(2)], ['ATR Oranı', ratio.toFixed(2)], ['Üst / Alt', fmtN(hi) + ' / ' + fmtN(lo)]]
  });
  const last = cs[n];
  const volAvg = win.reduce((a, x) => a + x.v, 0) / win.length;
  const volX = last.v / (volAvg || 1);
  if (last.c > hi && volX > RG.volX) {
    let risk = Math.max(last.c - lo, atr[n] * RG.slAtr);
    risk = Math.min(Math.max(risk, last.c * RG.minRiskPct), last.c * RG.slMaxPct);
    emit({
      id: 'range|' + sym + '|L|' + last.t, module: 'range', symbol: sym, dir: 'LONG', tf: '15m', q: Math.min(volX, 5) * 2,
      entry: last.c, sl: last.c - risk, tp1: last.c + risk * RG.tp1R, tp2: last.c + risk * RG.tp2R, levels: lv,
      info: [['Kırılım', 'Yukarı'], ['Hacim', 'x' + volX.toFixed(1)], ['Sıkışma', '%' + width.toFixed(2)], ['ATR', fmtN(atr[n])]]
    });
  } else if (last.c < lo && volX > RG.volX) {
    let risk = Math.max(hi - last.c, atr[n] * RG.slAtr);
    risk = Math.min(Math.max(risk, last.c * RG.minRiskPct), last.c * RG.slMaxPct);
    emit({
      id: 'range|' + sym + '|S|' + last.t, module: 'range', symbol: sym, dir: 'SHORT', tf: '15m', q: Math.min(volX, 5) * 2,
      entry: last.c, sl: last.c + risk, tp1: last.c - risk * RG.tp1R, tp2: last.c - risk * RG.tp2R, levels: lv,
      info: [['Kırılım', 'Aşağı'], ['Hacim', 'x' + volX.toFixed(1)], ['Sıkışma', '%' + width.toFixed(2)], ['ATR', fmtN(atr[n])]]
    });
  }
}

/* ───────── BACKTEST ───────── */
const JOBS = new Map();
const BT_TF = { '15m': 1, '1h': 1, '2h': 1, '4h': 1 };
async function fetchAllCandles(sym, tf) { return getCandles(sym, tf, 1000, 600000); }
async function buildHistMkt(tf) {
  const d = [];
  for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) {
    const c = (await fetchAllCandles(s, tf)).slice(0, -1);
    d.push({ t: c.map(x => x.t), dir: trf(c).dir });
  }
  const em = new Map();
  d[1].t.forEach((t, i) => em.set(t, d[1].dir[i]));
  const out = new Map();
  d[0].t.forEach((t, i) => {
    const b = d[0].dir[i], e = em.get(t);
    out.set(t, e === undefined ? 0 : (b === 1 && e === 1 ? 1 : b === -1 && e === -1 ? -1 : 0));
  });
  return out;
}
function genSignal(module, tf, cs, i, pre) {
  if (module === 'trend') return detTrend(cs, i, pre);
  if (module === 'scalper') return detScalper(cs, i, pre.atr);
  if (module === 'lt') {
    let any = false;
    for (let k = 0; k < 4 && !any; k++) {
      let vs = 0;
      for (let q = i - k - 20; q < i - k; q++) vs += cs[q].v;
      if (cs[i - k].v / (vs / 20 || 1) >= LT_VOLX) any = true;
    }
    if (!any) return null;
    const r = detLT(cs.slice(0, i + 1), tf, cs[i].c);
    if (!r || !r.brk) return null;
    return ltConfirm(r.brk, r.brk.tkp) ? r.brk : null;
  }
  return null;
}
function simulate(cs, i, s, hold) {
  const L = s.dir === 'LONG';
  const risk = Math.abs(s.entry - s.sl) || 1e-9;
  const r1 = Math.abs(s.tp1 - s.entry) / risk, r2 = Math.abs(s.tp2 - s.entry) / risk;
  const cost = COST * s.entry / risk;
  const fin = (R, out, bars) => ({ R: R - cost, out, bars });
  let hit1 = false;
  const end = Math.min(cs.length - 1, i + hold);
  for (let j = i + 1; j <= end; j++) {
    const c = cs[j];
    const stop = L ? c.l <= s.sl : c.h >= s.sl;
    const t1 = L ? c.h >= s.tp1 : c.l <= s.tp1;
    const t2 = L ? c.h >= s.tp2 : c.l <= s.tp2;
    if (stop) return fin(hit1 ? 0.5 * r1 - 0.5 : -1, hit1 ? 'TP1→STOP' : 'STOP', j - i);
    if (t2) return fin(0.5 * r1 + 0.5 * r2, 'TP2', j - i);
    if (t1) hit1 = true;
  }
  const last = cs[end].c;
  const open = (L ? last - s.entry : s.entry - last) / risk;
  const out = fin(hit1 ? 0.5 * r1 + 0.5 * open : open, hit1 ? 'TP1+SÜRE' : 'SÜRE DOLDU', end - i);
  out.trunc = i + hold > cs.length - 1;
  return out;
}
function summarize(trades, coinDays, full) {
  trades.sort((a, b) => a.t - b.t);
  let cum = 0, peak = 0, dd = 0, gw = 0, gl = 0, w = 0;
  const curve = [];
  const by = { LONG: { n: 0, w: 0, R: 0 }, SHORT: { n: 0, w: 0, R: 0 } };
  for (const t of trades) {
    cum += t.R; curve.push(+cum.toFixed(2));
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    if (t.R > 0) { w++; gw += t.R; by[t.dir].w++; } else gl -= t.R;
    by[t.dir].n++; by[t.dir].R += t.R;
  }
  const n = trades.length;
  for (const k in by) by[k].winRate = by[k].n ? by[k].w / by[k].n * 100 : null;
  const o = { n, win: w, winRate: n ? w / n * 100 : null, totalR: cum, avgR: n ? cum / n : null, pf: gl > 0 ? gw / gl : null, maxDD: dd, perWeek: coinDays > 0 ? n / coinDays * 7 : null };
  if (full) { o.curve = curve; o.byDir = by; o.last = trades.slice(-30).reverse(); }
  return o;
}
function pack(trades, splitT, coinDays) {
  const all = summarize(trades.slice(), coinDays, true);
  const train = summarize(trades.filter(t => t.t < splitT), coinDays * 0.6, false);
  const test = summarize(trades.filter(t => t.t >= splitT), coinDays * 0.4, false);
  all.splitIdx = train.n;
  return { all, train, test };
}
async function runBacktest(job) {
  const tfMs = TF_MS[job.tf], hms = TF_MS[TREND_HTF];
  job.stage = 'BTC/ETH piyasa yönü';
  const hm = await buildHistMkt(job.tf);
  const syms = UNIVERSE.slice(0, job.total);
  job.total = syms.length;
  const A = [], B = [];
  let used = 0, minT = Infinity, maxT = 0, coinMs = 0;
  const startI = 200;
  for (const sym of syms) {
    job.stage = sym.split('/')[0];
    try {
      const cs = (await fetchAllCandles(sym, job.tf)).slice(0, -1);
      if (cs.length > startI + 80) {
        const pre = { atr: atrArr(cs) };
        if (job.module === 'trend') {
          pre.dir = trf(cs).dir;
          const hc = (await fetchAllCandles(sym, TREND_HTF)).slice(0, -1);
          pre.htfDir = alignHtf(cs, tfMs, hc, trf(hc).dir, hms);
        }
        minT = Math.min(minT, cs[startI].t); maxT = Math.max(maxT, cs[cs.length - 1].t);
        coinMs += cs[cs.length - 1].t - cs[startI].t;
        const seen = new Set(), list = [];
        for (let i = startI; i < cs.length - 2; i++) {
          if (i % 800 === 0) await sleep(0);
          const s = genSignal(job.module, job.tf, cs, i, pre);
          if (!s || seen.has(s.key)) continue;
          seen.add(s.key);
          list.push({ i, s, mk: hm.get(cs[i].t) || 0 });
        }
        for (const pass of [0, 1]) {
          let busy = -1;
          for (const c of list) {
            if (pass === 1 && c.mk !== 0 && (c.mk === 1) !== (c.s.dir === 'LONG')) continue;
            if (c.i <= busy) continue;
            const r = simulate(cs, c.i, c.s, job.hold);
            if (r.trunc) continue;
            busy = c.i + r.bars;
            (pass ? B : A).push({ symbol: sym, dir: c.s.dir, t: cs[c.i].t, entry: c.s.entry, out: r.out, R: r.R, bars: r.bars });
          }
        }
        used++;
      }
    } catch (e) { log('backtest hata', sym, e.message); }
    job.done++;
    await sleep(0);
  }
  const splitT = minT + (maxT - minT) * 0.6;
  const coinDays = coinMs / 864e5;
  job.result = { coins: used, minT, maxT, split: splitT, module: job.module, tf: job.tf, A: pack(A, splitT, coinDays), B: pack(B, splitT, coinDays) };
  job.status = 'done';
}
function pubJob(j) { return { id: j.id, status: j.status, stage: j.stage, done: j.done, total: j.total, module: j.module, tf: j.tf, result: j.result, error: j.error }; }

/* ───────── RADAR ───────── */
async function radarScan() {
  const r = { time: Date.now() };
  try {
    const f = await jget('https://api.alternative.me/fng/?limit=1');
    r.fng = { value: +f.data[0].value, label: f.data[0].value_classification };
  } catch (e) { r.fng = null; }
  r.ls = {};
  for (const [k, s] of [['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT']]) {
    try {
      const d = await jget('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=' + s + '&period=1h&limit=1');
      r.ls[k] = { ratio: +d[0].longShortRatio, long: +d[0].longAccount, short: +d[0].shortAccount };
    } catch (e) { r.ls[k] = null; }
  }
  r.rsi = {};
  for (const k of ['BTC', 'ETH']) {
    r.rsi[k] = {};
    for (const tf of ['1h', '4h']) {
      try {
        const c = await getCandles(k + '/USDT:USDT', tf, 200, 300000);
        r.rsi[k][tf] = rsiLast(c.slice(0, -1).map(x => x.c));
      } catch (e) { r.rsi[k][tf] = null; }
    }
  }
  RADAR = r;
}

/* ───────── Tarama ───────── */
async function scanCycle() {
  try { await marketDirection(); } catch (e) { log('Piyasa yönü hatası', e.message); }
  const zones = new Map(), range = new Map(), ltw = new Map();
  const batch = nextBatch();
  if (!batch.length) return;
  log('Taranıyor:', batch.length, 'coin...');
  for (const sym of batch) {
    try {
      const c15 = await getCandles(sym, '15m', 250, 240000);
      const c1h = await getCandles(sym, '1h', 250, 900000);
      const cTri = await getCandles(sym, TRI_TF, 1000, 1800000);
      let picked = [];
      PEND = [];
      try {
        rangeMod(sym, c15, range);
        zoneMod(sym, c1h, zones);
        await trendMod(sym, c1h);
        scalperMod(sym, c15);
        await ltMod(sym, cTri, TRI_TF, ltw);
      } finally { picked = PEND || []; PEND = null; }
      const pool = picked.filter(x => !SIGSET.has(x.id) && (MKT_FILTER !== 'hide' || !isCounter(x)));
      pool.sort((x, y) => qScore(y) - qScore(x));
      for (const x of pool) addSignal(x);
    } catch (e) { log('Tarama hatası', sym, e.message); }
  }
  const now = Date.now();
  for (const [k, v] of zones.entries()) SNAP.zones.set(k, v);
  for (const [k, v] of range.entries()) SNAP.range.set(k, v);
  for (const [k, v] of ltw.entries()) SNAP.lt.set(k, v);
  for (const map of [SNAP.zones, SNAP.range, SNAP.lt]) {
    for (const [k, v] of map.entries()) if (now - v.time > CFG.snapTtl) map.delete(k);
  }
  log('Tarama bitti. Evren:', UNIVERSE.length, '| Bu tur:', batch.length);
}

async function loop(fn, every, name) {
  while (true) {
    try { await fn(); } catch (e) { log(name, 'hata:', e.message); }
    await sleep(every);
  }
}

/* ───────── HTTP ───────── */
function stateJSON() {
  const now = Date.now();
  const sigs = SIGNALS.filter(s => now - s.time < 48 * 36e5)
    .concat([...SNAP.zones.values()], [...SNAP.range.values()], [...SNAP.lt.values()]);
  const need = new Set(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  sigs.forEach(s => { if (s && s.symbol) need.add(s.symbol); });
  PAPER.trades.filter(t => !t.closed).forEach(t => need.add(t.symbol));
  const prices = {};
  need.forEach(k => { if (TICK[k]) prices[k] = TICK[k].last; });
  return {
    now, market: MARKET, prices,
    chg: { btc: TICK['BTC/USDT:USDT'] && TICK['BTC/USDT:USDT'].pct, eth: TICK['ETH/USDT:USDT'] && TICK['ETH/USDT:USDT'].pct },
    signals: sigs, radar: RADAR, stats: computeStats(),
    status: { universe: UNIVERSE.length, lastScan: LAST_SCAN, scanning: SCANNING, triTf: TRI_TF, mktFilter: MKT_FILTER, version: VERSION, batch: BATCH_INFO, pump: PUMP_INFO, limits: CFG.moduleLimits }
  };
}
const TFS = { '1m': 1, '5m': 1, '15m': 1, '30m': 1, '1h': 1, '2h': 1, '4h': 1, '6h': 1, '12h': 1, '1d': 1 };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) { b = ''; req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
async function jsonBody(req) {
  const body = await readBody(req);
  try { return { ok: true, j: JSON.parse(body || '{}') || {} }; } catch (e) { return { ok: false }; }
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/') return send(res, 200, HTML, 'text/html; charset=utf-8');
    if (u.pathname === '/api/state') return send(res, 200, stateJSON());
    if (u.pathname === '/api/candles') {
      const sym = u.searchParams.get('symbol'), tf = u.searchParams.get('tf') || '15m';
      if (!sym || !ex.markets || !ex.markets[sym] || !TFS[tf]) return send(res, 400, { error: 'geçersiz parametre' });
      const lim = Math.min(1000, Math.max(50, +u.searchParams.get('limit') || 300));
      const c = await getCandles(sym, tf, lim, 20000);
      const closes = c.map(x => x.c);
      return send(res, 200, { symbol: sym, tf, candles: c, ema21: ema(closes, 21), ema50: ema(closes, 50) });
    }
    if (u.pathname === '/api/paper' && req.method === 'GET') {
      return send(res, 200, {
        stats: paperStats(), cfg: PAPER.cfg,
        open: PAPER.trades.filter(t => !t.closed).slice(-20),
        recent: PAPER.trades.filter(t => t.closed).slice(-50).reverse(),
        balance: +PAPER.balance.toFixed(4), pending: PENDING_CONFIRM.size
      });
    }
    if (u.pathname === '/api/paper/config' && req.method === 'POST') {
      const p = await jsonBody(req);
      if (!p.ok) return send(res, 400, { error: 'geçersiz json' });
      const j = p.j;
      if (typeof j.sizeUSDT === 'number' && j.sizeUSDT > 0) PAPER.cfg.sizeUSDT = Math.min(10000, j.sizeUSDT);
      if (typeof j.minConf === 'number' && j.minConf >= 50) PAPER.cfg.minConf = Math.min(99, j.minConf);
      if (typeof j.maxAgeMin === 'number' && j.maxAgeMin >= 5) PAPER.cfg.maxAgeMin = Math.min(240, j.maxAgeMin);
      if (typeof j.leverage === 'number' && j.leverage >= 1) PAPER.cfg.leverage = Math.min(20, Math.round(j.leverage));
      for (const k of ['autoTrade', 'trailing', 'tightEarly', 'confirm']) if (typeof j[k] === 'boolean') PAPER.cfg[k] = j[k];
      savePaper();
      log('PAPER CFG', JSON.stringify(PAPER.cfg));
      return send(res, 200, { ok: true, cfg: PAPER.cfg });
    }
    if (u.pathname === '/api/paper/close' && req.method === 'POST') {
      const p = await jsonBody(req);
      if (!p.ok) return send(res, 400, { error: 'geçersiz json' });
      const r = manualClosePaper(p.j.id);
      return send(res, r.error ? 400 : 200, r);
    }
    if (u.pathname === '/api/paper/open' && req.method === 'POST') {
      const p = await jsonBody(req);
      if (!p.ok) return send(res, 400, { error: 'geçersiz json' });
      const r = openPaperManual(p.j.sigId);
      return send(res, r.error ? 400 : 200, r);
    }
    if (u.pathname === '/api/signal/close' && req.method === 'POST') {
      const p = await jsonBody(req);
      if (!p.ok) return send(res, 400, { error: 'geçersiz json' });
      const r = manualCloseSignal(p.j.id);
      return send(res, r.error ? 400 : 200, r);
    }
    if (u.pathname === '/api/backtest') {
      const jid = u.searchParams.get('job');
      if (jid) { const j = JOBS.get(jid); return send(res, j ? 200 : 404, j ? pubJob(j) : { error: 'yok' }); }
      const module = u.searchParams.get('module'), tf = u.searchParams.get('tf') || '15m';
      const n = Math.min(70, Math.max(5, +u.searchParams.get('n') || 30));
      if (!['trend', 'scalper', 'lt'].includes(module) || !BT_TF[tf]) return send(res, 400, { error: 'geçersiz parametre' });
      const running = [...JOBS.values()].find(j => j.status === 'running');
      if (running) return send(res, 200, pubJob(running));
      const job = { id: crypto.randomBytes(5).toString('hex'), status: 'running', stage: '', done: 0, total: n, module, tf, hold: 96, result: null };
      JOBS.set(job.id, job);
      if (JOBS.size > 8) JOBS.delete(JOBS.keys().next().value);
      runBacktest(job).catch(e => { job.status = 'error'; job.error = e.message; });
      return send(res, 200, pubJob(job));
    }
    send(res, 404, { error: 'yok' });
  } catch (e) {
    try { send(res, 500, { error: e.message }); } catch (e2) {}
  }
});

(async () => {
  log('Piyasalar yükleniyor...');
  await safeFetch(() => ex.loadMarkets());
  await refreshTickers();
  server.listen(PORT, () => log('AlphaSon ' + VERSION + ' hazır -> http://localhost:' + PORT));
  loop(refreshTickers, CFG.tickerEvery, 'ticker');
  loop(async () => { SCANNING = true; try { await scanCycle(); } finally { SCANNING = false; LAST_SCAN = Date.now(); } }, CFG.scanEvery, 'tarama');
  loop(pumpScan, CFG.pumpEvery, 'pump');
  loop(radarScan, CFG.radarEvery, 'radar');
  loop(trackSignals, CFG.trackEvery, 'takip');
  loop(trackPaper, CFG.paperTrackEvery, 'paper-takip');
  loop(processPending, CFG.pendingEvery, 'paper-teyit');
})().catch(e => { console.error('Başlatma hatası:', e); process.exit(1); });

/* HTML aşağıda — PARÇA 2'yi buraya ekle */
