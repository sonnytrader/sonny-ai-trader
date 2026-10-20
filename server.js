'use strict';
/*
 * AlphaSon v61.7 - Kripto Sinyal ve Tarama Botu (tek dosya)
 * Kurulum:  npm i ccxt      (Node 18+ gerekir: global fetch kullanılır)
 * Çalıştır: node server.js  ->  http://localhost:3000
 * Not: Yatırım tavsiyesi değildir. Sinyaller eğitim/araştırma amaçlıdır.
 *
 * v61.7 değişiklikleri (v61.6'ya göre):
 *  - Evren: 24s hacmi >= 500k USDT olan TÜM coinler; tarama parça parça (batch) ve dönüşümlü.
 *  - Piyasa yönü: BTC+ETH TRF + piyasa genişliği (coinlerin >%60'ı yükselişteyse BTC düşse de LONG).
 *  - Konfluans: aynı coinde AYNI yönde farklı modüllerin sinyallerine izin verilir.
 *  - Zone Master: destekte yeşil / dirençte kırmızı mum "sekme" sinyali (hedefi olan, iki taraflı bölge şart).
 *  - Range Pro: sıkışma kırılımı sinyali (üst kırılım LONG, alt kırılım SHORT).
 *  - AlgoPump: hacim 2.5x, taker %65, ayrıca DUMP (SHORT) yönü.
 *  - Trend: 4H teyidi korunur, TP1/TP2 = 1.0 / 1.618 dalga boyu.
 *  - Takip: 1 dakikalık mum fitilleriyle (fiyat anlık okunmaz); stop/TP seviyesinden kapanır, R = backtest modeliyle aynı.
 *  - Piyasa Radarı: sayıların yanında sade açıklamalar. Stratejiler sayfasına bilgi notu.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let ccxt;
try { ccxt = require('ccxt'); } catch (e) { console.error('ccxt bulunamadı. Önce: npm i ccxt'); process.exit(1); }

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'alphason_signals.json');
const envN = (k, d) => (process.env[k] == null || process.env[k] === '' || isNaN(+process.env[k])) ? d : +process.env[k];
const CFG = {
  minQv: envN('MIN_QV', 500000),     // 24s hacmi bunun altındaki coinler taranmaz
  batchMin: 50, batchMax: 150,       // her tarama turunda taranacak coin sayısı (evren büyüdükçe artar)
  cyclesPerFull: 6,                  // tüm evren yaklaşık 6 turda (~30 dk) bir kez taranır
  pumpN: envN('PUMP_N', 120),        // AlgoPump için taranacak (en hacimli) coin sayısı
  scanEvery: 300000,                 // tarama turu aralığı
  pumpEvery: 60000,
  tickerEvery: 15000,
  radarEvery: 300000,
  trackEvery: 30000,                 // açık sinyallerin 1 dk mumlarla kontrolü
  gapMs: 120,                        // istekler arası minimum bekleme (throttle)
  maxSignals: 600,
  keepMs: 7 * 864e5,
  snapTtl: 50 * 60e3,                // izleme listesi kayıtlarının ömrü
  maxAgeH: { lt: 72, trend: 24, scalper: 12, pump: 6, zone: 24, range: 12 }   // süre dolunca sinyal kapanır
};
const OK_TF = ['15m', '30m', '1h', '2h', '4h', '6h', '12h'];
const TRI_TF = OK_TF.includes(process.env.TRI_TF) ? process.env.TRI_TF : '2h';       // LT Üçgen zaman dilimi
const MKT_FILTER = ['hide', 'mark', 'off'].includes((process.env.MKT_FILTER || '').toLowerCase()) ? process.env.MKT_FILTER.toLowerCase() : 'hide';

const VERSION = 'v61.7';
const TF_MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5 };
const TREND_HTF = ['1h', '4h'].includes(process.env.TREND_HTF) ? process.env.TREND_HTF : '4h';   // Trend teyit zaman dilimi
const TREND_ATR_MULT = 1.5;                               // Trend stop = 1.5 x ATR
const TREND_TP1 = envN('TREND_TP1', 1.0), TREND_TP2 = envN('TREND_TP2', 1.618);   // hedefler: dalga boyu çarpanı
const LT_VOLX = envN('LT_VOLX', 1.5);
const LT_TAKER_LONG = 0.60, LT_TAKER_SHORT = 0.40;
const LT_BREAK_PCT = 0.005;
const LT_MAX_DRIFT_R = 0.3;
const SC_MIN_VOLX = 2.0, SC_MAX_AGE = 5, SC_MAX_DIST_PCT = 3, SC_TP1 = 1.5, SC_TP2 = 2.5;
const PUMP_X = envN('PUMP_X', 2.5), PUMP_TAKER = envN('PUMP_TAKER', 0.65), PUMP_MOVE = envN('PUMP_MOVE', 0.5);   // hacim katı, taker oranı, en az % hareket (10 dk)
const BREADTH_TH = envN('BREADTH_TH', 0.60);              // coinlerin bu oranı aynı yöndeyse piyasa yönü o yöndedir
const ZONE_MIN_STR = envN('ZONE_MIN_STR', 36);            // sekme sinyali için minimum bölge gücü (3 değme)
const COST = 0.0012;                                      // işlem başı yaklaşık maliyet (komisyon+kayma), R hesabından düşülür
/* Kripto olmayan sembol tabanları (hisse, ETF, emtia, endeks). Ek için: EXCLUDE=ABC,XYZ */
const NON_CRYPTO = new Set(['QQQ', 'SPY', 'IWM', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META', 'NFLX', 'AMD', 'INTC', 'MU',
  'MSTR', 'COIN', 'HOOD', 'CRCL', 'PLTR', 'SNDK', 'SNXX', 'SOXL', 'SOXS', 'SKHYNIX', 'SAMSUNG', 'EWY', 'KORU', 'SPCX', 'ZHIPU', 'MINIMAX',
  'XAU', 'XAG', 'XPT', 'XPD', 'CL', 'BZ', 'WTI', 'BRENT', 'USOIL', 'UKOIL', 'NATGAS', 'NG', 'COPPER', 'HG',
  'US500', 'US30', 'US100', 'NAS100', 'DE40', 'UK100', 'JP225']
  .concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)));
const isNonCrypto = sym => NON_CRYPTO.has(sym.split('/')[0].toUpperCase());

const ex = new ccxt.bitget({
  enableRateLimit: true,
  options: { defaultType: 'swap', defaultSubType: 'linear' }
});

/* ===================== YARDIMCILAR / RATE LIMIT ===================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let lastCall = 0;
let chain = Promise.resolve();
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

/* ===================== VERİ ===================== */
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
const PH = [];                                            // fiyat anlık görüntüleri (1 saatlik genişlik için)
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
  PUMPU = ALL.slice(0, CFG.pumpN);
  const now = Date.now();
  if (!PH.length || now - PH[PH.length - 1].t >= 290000) {   // 5 dakikada bir anlık görüntü
    const p = {};
    for (const k of ALL) p[k] = TICK[k].last;
    PH.push({ t: now, p });
    while (PH.length && now - PH[0].t > 75 * 60e3) PH.shift();
  }
}
/* Evreni dönüşümlü parçalara böler: tüm liste ~cyclesPerFull turda bir kez taranır */
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

/* Taker buy oranı: son işlemlerden; yoksa mum içi konumdan tahmin */
async function takerRatio(sym, fb) {
  try {
    const tr = await safeFetch(() => ex.fetchTrades(sym, undefined, 500));
    let b = 0, t = 0;
    for (const x of tr) {
      const v = (x.cost != null ? x.cost : x.amount * x.price) || 0;
      t += v;
      if (x.side === 'buy') b += v;
    }
    if (t > 0) return b / t;
  } catch (e) { /* yedek */ }
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

/* ===================== GÖSTERGELER ===================== */
function ema(a, p) {
  const k = 2 / (p + 1), o = [];
  let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o.push(e); }
  return o;
}
function atrArr(cs, p = 14) {
  const o = [];
  let a = 0;
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

/* Twin Range Filter (src=close, 27/1.6 ve 55/2.0) -> dir: 1 long, -1 short */
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
  const dir = [0];
  let up = 0, dn = 0;
  for (let i = 1; i < src.length; i++) {
    if (fl[i] > fl[i - 1]) { up += 1; dn = 0; }
    else if (fl[i] < fl[i - 1]) { dn += 1; up = 0; }
    const lc = src[i] > fl[i] && up > 0;
    const sc = src[i] < fl[i] && dn > 0;
    dir.push(lc ? 1 : sc ? -1 : dir[i - 1]);
  }
  return { filt: fl, dir };
}

/* ===================== SİNYAL DEPOSU ===================== */
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
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));

const isOpenSig = s => !s.stopped && !s.hit2 && !s.expired;
const hasOpen = sym => SIGNALS.some(s => s.symbol === sym && isOpenSig(s));
const isCounter = s => MARKET.dir !== 'NÖTR' && s.dir !== MARKET.dir;
/* KONFLUANS: aynı coinde yalnızca AYNI yönde ve FARKLI modülden gelen yeni sinyale izin verilir.
   Aynı modülden ikinci sinyal veya ters yönlü sinyal engellenir. */
function openSameDir(s) { return SIGNALS.filter(x => x.symbol === s.symbol && isOpenSig(x) && x.dir === s.dir && x.module !== s.module); }
function canOpen(s) {
  const open = SIGNALS.filter(x => x.symbol === s.symbol && isOpenSig(x));
  return open.every(x => x.dir === s.dir && x.module !== s.module);
}
let PEND = null;                                          // tarama sırasında aday sinyal havuzu
function emit(o) { if (PEND) { PEND.push(o); return true; } return addSignal(o); }
function qScore(s) {
  let q = ({ lt: 70, trend: 55, scalper: 45, pump: 60, zone: 50, range: 48 })[s.module] || 40;
  q += s.q || 0;
  if (s.dir === MARKET.dir) q += 10;
  return q;
}
function confOf(s) {                                      // 50-99 arası güven puanı
  const q = qScore(s);
  return Math.round(Math.min(99, Math.max(50, 50 + (q - 40) / 75 * 49)));
}
function addSignal(o) {
  const s = Object.assign({ time: Date.now(), status: 'AÇIK', hit1: false, hit2: false, stopped: false, tf: '15m', info: [] }, o);
  if (!s.id) s.id = crypto.createHash('md5').update(JSON.stringify([s.module, s.symbol, s.dir, s.time])).digest('hex').slice(0, 12);
  if (SIGSET.has(s.id)) return false;
  if (!(s.entry > 0) || !(s.sl > 0) || s.sl === s.entry) return false;
  if (s.conf == null) s.conf = confOf(s);
  if (isCounter(s)) {                                     // piyasa yönüne ters sinyal
    if (MKT_FILTER === 'hide') return false;
    if (MKT_FILTER === 'mark') s.counter = true;
  }
  if (!canOpen(s)) return false;
  const same = openSameDir(s).length;                     // konfluans: aynı yönde açık diğer modül sayısı
  if (same) s.conf = Math.min(99, s.conf + 6 * same);
  SIGSET.add(s.id);
  SIGNALS.unshift(s);
  while (SIGNALS.length > CFG.maxSignals) { const x = SIGNALS.pop(); SIGSET.delete(x.id); }
  DIRTY = true;
  log('SİNYAL', s.module, s.symbol, s.dir, same ? '(konfluans x' + (same + 1) + ')' : '');
  return true;
}

/* ===================== TAKİP (1 dk mum fitilleri) ===================== */
/* Stop/TP, anlık fiyat yerine 1 dakikalık mumların high/low değerleriyle kontrol edilir; kapanış fiyatı seviyenin kendisidir.
   Sonuç modeli backtest ile aynı: TP1'de yarı pozisyon kapanır, kalan yarı TP2'ye veya orijinal stopa gider.
   Aynı mumda stop ve hedef birlikte görülürse stop sayılır. İşlem maliyeti (%0.12) R'den düşülür. */
const sigRisk = s => Math.abs(s.entry - s.sl) || 1e-9;
function closeSig(s, R, status, exit) {
  s.R = R - COST * s.entry / sigRisk(s);
  s.status = status; s.exit = exit; s.closed = Date.now();
  if (status === 'TP2') { s.hit1 = true; s.hit2 = true; }
  else if (status.indexOf('STOP') >= 0) s.stopped = true;
  else s.expired = true;
  DIRTY = true;
}
function sigR(s) {                                        // kapanmış sinyalin net R değeri (eski kayıtlar için tahmin)
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
      try { cs = await getCandles(s.symbol, '1m', 200, 25000); } catch (e) { /* sonraki turda denenir */ }
      let done = false;
      if (cs && cs.length) {
        const from = s.chk || (Math.floor(s.time / 6e4) * 6e4 + 6e4);   // sinyalden sonraki ilk tam dakika
        for (let i = 0; i < cs.length && !done; i++) {
          const c = cs[i];
          if (c.t < from) continue;
          const stop = L ? c.l <= s.sl : c.h >= s.sl;
          const t1 = L ? c.h >= s.tp1 : c.l <= s.tp1;
          const t2 = L ? c.h >= s.tp2 : c.l <= s.tp2;
          if (stop) { closeSig(s, s.hit1 ? 0.5 * r1 - 0.5 : -1, s.hit1 ? 'TP1 → STOP' : 'STOP', s.sl); done = true; }
          else if (t2) { closeSig(s, 0.5 * r1 + 0.5 * r2, 'TP2', s.tp2); done = true; }
          else if (t1 && !s.hit1) { s.hit1 = true; s.status = 'TP1'; DIRTY = true; }
          if (i < cs.length - 1) s.chk = c.t + 6e4;           // oluşmakta olan mum bir sonraki turda tekrar okunur
        }
      }
      if (!done && now - s.time > (CFG.maxAgeH[s.module] || 24) * 36e5) {    // süre doldu: güncel fiyattan kapat
        const tk = TICK[s.symbol];
        const p = tk ? tk.last : s.entry;
        const open = (L ? p - s.entry : s.entry - p) / risk;
        closeSig(s, s.hit1 ? 0.5 * r1 + 0.5 * open : open, s.hit1 ? 'TP1 + SÜRE' : 'SÜRE DOLDU', p);
      }
    }
  } finally { TRACKING = false; }
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

/* ===================== MODÜL A: PİYASA YÖNÜ ===================== */
/* 1) BTC+ETH 15m TRF yönü  2) piyasa genişliği: taranan (likit) coinlerin yükselen oranı (24s ve 1s ortalaması).
   Coinlerin >= %60'ı yükselişteyse (BTC düşse bile) LONG, <= %40'ı yükselişteyse SHORT. Aksi halde BTC+ETH TRF belirler. */
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
    for (const k of ALL) { const p0 = ref.p[k]; if (!p0) continue; n++; if (TICK[k].last > p0) u++; }
    if (n >= 30) share1h = u / n;
  }
  if (share24 == null && share1h == null) return null;
  const share = share24 == null ? share1h : share1h == null ? share24 : (share24 + share1h) / 2;
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

/* ===================== MODÜL B: LT ÜÇGEN (simetrik) ===================== */
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
  return { res, sup, start, apex, mat, squeeze, w0, wn, touches: tR + tS, W, score: (tR + tS) * 10 + mat * 10 - squeeze * 5 + W / 100 };
}
function fitLines(cs) {
  for (let k = LT_WINDOWS.length - 1; k >= 0; k--) {
    const r = evalHull(cs, LT_WINDOWS[k]);
    if (r) return r;
  }
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
    if (!hasOpen(sym) && (MKT_FILTER !== 'hide' || !isCounter(w))) {
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

/* ===================== MODÜL C: TRF TREND ===================== */
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
  if (n < 120) return null;
  const dir = pre.dir;
  let chg = -1;
  for (let k = 0; k < 3; k++) if (dir[n - k] !== dir[n - k - 1]) { chg = n - k; break; }
  if (chg < 0 || dir[n] === 0) return null;
  if (!(opts && opts.noHtf) && (!pre.htfDir || pre.htfDir[n] !== dir[n])) return null;
  const L = dir[n] === 1;
  const entry = cs[n].c;
  const atr = pre.atr[n];
  let lo = Infinity, hi = -Infinity;
  for (let k = n - 9; k <= n; k++) { if (cs[k].l < lo) lo = cs[k].l; if (cs[k].h > hi) hi = cs[k].h; }
  let dist = atr * TREND_ATR_MULT;
  dist = Math.max(entry * 0.004, Math.min(dist, entry * 0.03));
  const sl = L ? entry - dist : entry + dist;
  const wave = Math.max(hi - lo, dist);
  const sg = L ? 1 : -1;
  return { dir: L ? 'LONG' : 'SHORT', entry, sl, tp1: entry + sg * wave * TREND_TP1, tp2: entry + sg * wave * TREND_TP2, atr, t: cs[chg].t, key: 'trend|' + cs[chg].t };
}
async function trendMod(sym, c) {
  const cs = c.slice(0, -1);
  if (cs.length < 120) return;
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
    id: 'trend|' + sym + '|' + r.t, module: 'trend', symbol: sym, dir: r.dir, tf: '15m',
    q: Math.min(4, Math.abs(r.tp1 - r.entry) / Math.abs(r.entry - r.sl)) * 3 + 4,
    entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2,
    info: [['Piyasa', MARKET.dir], [TREND_HTF.toUpperCase() + ' Teyit', r.dir === 'LONG' ? '▲' : '▼'], ['Risk', '%' + (Math.abs(r.entry - r.sl) / r.entry * 100).toFixed(2)], ['ATR', '%' + (r.atr / r.entry * 100).toFixed(2)]]
  });
}

/* ===================== MODÜL D: ALGOPUMP ===================== */
async function pumpScan() {
  for (const sym of PUMPU) {
    try {
      const c = await getCandles(sym, '1m', 190, 30000);
      if (c.length < 150) continue;
      const n = c.length;
      const last = c.slice(n - 10);
      const base = c.slice(0, n - 10);
      const v10 = last.reduce((a, x) => a + x.v, 0);
      const avg10 = base.reduce((a, x) => a + x.v, 0) / base.length * 10;
      if (!avg10) continue;
      const x = v10 / avg10;
      if (x <= PUMP_X) continue;
      
      const priceChange = (c[n-1].c / c[n-10].o - 1) * 100;
      const proxy = candleTaker(last);
      const tk = await takerRatio(sym, proxy);
      
      let dir = null;
      // LONG PUMP
      if (priceChange >= PUMP_MOVE && tk >= PUMP_TAKER) dir = 'LONG';
      // SHORT DUMP
      else if (priceChange <= -PUMP_MOVE && tk <= (1 - PUMP_TAKER)) dir = 'SHORT';
      if (!dir) continue;

      const entry = c[n - 1].c;
      let sl, tp1, tp2;
      if (dir === 'LONG') {
        sl = Math.max(Math.min(...last.map(q => q.l)) * 0.995, entry * 0.97);
        if (sl >= entry) sl = entry * 0.97;
        tp1 = entry * 1.03; tp2 = entry * 1.06;
      } else {
        sl = Math.min(Math.max(...last.map(q => q.h)) * 1.005, entry * 1.03);
        if (sl <= entry) sl = entry * 1.03;
        tp1 = entry * 0.97; tp2 = entry * 0.94;
      }
      
      addSignal({
        id: 'pump|' + sym + '|' + dir + '|' + Math.floor(Date.now() / 600000),
        module: 'pump', symbol: sym, dir, tf: '1m', q: Math.min(25, (x - PUMP_X) * 2 + Math.abs(tk - 0.5) * 40),
        entry, sl, tp1, tp2,
        info: [['Hacim', 'x' + x.toFixed(1)], ['Taker', '%' + (tk * 100).toFixed(0)], ['10dk Değişim', '%' + priceChange.toFixed(2)]]
      });
    } catch (e) { /* sembol atla */ }
  }
}

/* ===================== MODÜL E: ZONE MASTER (Bounce) ===================== */
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
  const cs = c.slice(0, -1);
  if (cs.length < 100) return;
  const pv = pivots(cs, 5, 5);
  const zones = groupPivots(pv.hi.concat(pv.lo)).filter(z => z.strength >= ZONE_MIN_STR);
  const price = (TICK[sym] && TICK[sym].last) || cs[cs.length - 1].c;
  const sups = zones.filter(z => z.p < price).sort((a, b) => b.p - a.p);
  const ress = zones.filter(z => z.p > price).sort((a, b) => a.p - b.p);
  const s = sups[0], r = ress[0];
  if (!s || !r) return; // Sadece iki taraflı bölgeler
  
  const ds = (price - s.p) / price * 100, dr = (r.p - price) / price * 100;
  const lv = [{ p: s.p, label: 'S ' + s.strength, color: '#10b981' }, { p: r.p, label: 'R ' + r.strength, color: '#f43f5e' }];
  
  // İzleme listesi için güncelle
  out.set('zone|' + sym, {
    id: 'zone|' + sym, module: 'zone', symbol: sym, dir: ds <= dr ? 'LONG' : 'SHORT', tf: '1h', time: Date.now(),
    entry: price, levels: lv, status: 'İZLE', conf: Math.round(Math.min(99, 50 + (ds <= dr ? s : r).strength * 0.49)),
    support: s, resistance: r, distS: ds, distR: dr, info: [['Destek', fmtN(s.p) + ' (' + s.strength + ')'], ['Direnç', fmtN(r.p) + ' (' + r.strength + ')']]
  });

  // Sinyal Üretimi (Sekme)
  const lastC = cs[cs.length - 1];
  const atr = atrArr(cs)[cs.length - 1];
  
  // Desteğe değdi ve yeşil kapanış yaptı
  if (lastC.l <= s.p * 1.002 && lastC.c > s.p && lastC.c > lastC.o) {
    emit({
      id: 'zone|' + sym + '|L|' + lastC.t, module: 'zone', symbol: sym, dir: 'LONG', tf: '1h',
      entry: lastC.c, sl: s.p - atr * 0.5, tp1: r.p, tp2: r.p + (r.p - s.p) * 0.618,
      levels: lv, info: [['Bölge', 'Destek Sekmesi'], ['Güç', s.strength], ['Destek', fmtN(s.p)], ['Direnç', fmtN(r.p)]]
    });
  }
  // Dirence değdi ve kırmızı kapanış yaptı
  else if (lastC.h >= r.p * 0.998 && lastC.c < r.p && lastC.c < lastC.o) {
    emit({
      id: 'zone|' + sym + '|S|' + lastC.t, module: 'zone', symbol: sym, dir: 'SHORT', tf: '1h',
      entry: lastC.c, sl: r.p + atr * 0.5, tp1: s.p, tp2: s.p - (r.p - s.p) * 0.618,
      levels: lv, info: [['Bölge', 'Direnç Sekmesi'], ['Güç', r.strength], ['Destek', fmtN(s.p)], ['Direnç', fmtN(r.p)]]
    });
  }
}
function fmtN(p) { return Number(p).toPrecision(5); }

/* ===================== MODÜL F: SCALPER (SMC / BOS) ===================== */
function detScalper(cs, n, atrA) {
  if (n < 60) return null;
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
  const j = L ? fu : fd, volX = L ? vu : vd;
  const level = L ? sh.p : sw.p;
  const entry = cs[n].c;
  if (L ? entry <= level : entry >= level) return null;
  if (Math.abs(entry - level) / level * 100 > SC_MAX_DIST_PCT) return null;
  const atr = atrA[n];
  let lo = Infinity, hi = -Infinity;
  for (let k = n - 9; k <= n; k++) { if (cs[k].l < lo) lo = cs[k].l; if (cs[k].h > hi) hi = cs[k].h; }
  let sl = L ? lo - atr * 0.3 : hi + atr * 0.3;
  if (Math.abs(entry - sl) > entry * 0.03) sl = L ? entry * 0.97 : entry * 1.03;
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

/* ===================== MODÜL G: RANGE PRO (Breakout) ===================== */
function rangeMod(sym, c, out) {
  const cs = c.slice(0, -1);
  if (cs.length < 60) return;
  const n = cs.length - 1;
  const atr = atrArr(cs);
  const ratio = atr[n] / atr[n - 14];
  const win = cs.slice(n - 19);
  const hi = Math.max(...win.map(x => x.h)), lo = Math.min(...win.map(x => x.l));
  const width = (hi - lo) / ((hi + lo) / 2) * 100;
  if (!(ratio < 0.85 && width < 3.5)) return;

  const lv = [{ p: hi, label: 'Üst', color: '#06b6d4' }, { p: lo, label: 'Alt', color: '#a855f7' }];
  
  // İzleme listesi için
  out.set('range|' + sym, {
    id: 'range|' + sym, module: 'range', symbol: sym, dir: 'NÖTR', tf: '15m', time: Date.now(),
    entry: (hi + lo) / 2, status: 'SIKIŞMA', conf: Math.round(Math.min(95, Math.max(50, 55 + (0.85 - ratio) * 40 + (3.5 - width) * 5))), top: hi, bottom: lo, width, atrRatio: ratio,
    levels: lv, info: [['Genişlik', '%' + width.toFixed(2)], ['ATR Oranı', ratio.toFixed(2)], ['Üst / Alt', fmtN(hi) + ' / ' + fmtN(lo)]]
  });

  // Kırılım Sinyali
  const last = cs[n];
  const volAvg = cs.slice(n-20, n).reduce((a,x)=>a+x.v,0)/20;
  const volX = last.v / (volAvg||1);
  
  if (last.c > hi && volX > 1.5) {
    emit({
      id: 'range|' + sym + '|L|' + last.t, module: 'range', symbol: sym, dir: 'LONG', tf: '15m',
      entry: last.c, sl: lo, tp1: hi + (hi - lo), tp2: hi + (hi - lo) * 1.618,
      levels: lv, info: [['Kırılım', 'Yukarı'], ['Hacim', 'x' + volX.toFixed(1)], ['Sıkışma', '%' + width.toFixed(2)]]
    });
  } else if (last.c < lo && volX > 1.5) {
    emit({
      id: 'range|' + sym + '|S|' + last.t, module: 'range', symbol: sym, dir: 'SHORT', tf: '15m',
      entry: last.c, sl: hi, tp1: lo - (hi - lo), tp2: lo - (hi - lo) * 1.618,
      levels: lv, info: [['Kırılım', 'Aşağı'], ['Hacim', 'x' + volX.toFixed(1)], ['Sıkışma', '%' + width.toFixed(2)]]
    });
  }
}

/* ===================== BACKTEST ===================== */
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
  const startI = 120;
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

/* ===================== PİYASA RADARI ===================== */
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

/* ===================== TARAMA DÖNGÜSÜ ===================== */
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
      
      rangeMod(sym, c15, range);
      zoneMod(sym, c1h, zones);
      
      let picked = [];
      PEND = [];
      try {
        await trendMod(sym, c15);
        scalperMod(sym, c15);
        await ltMod(sym, cTri, TRI_TF, ltw);
      } finally { picked = PEND || []; PEND = null; }
      
      const pool = picked.filter(x => !SIGSET.has(x.id) && (MKT_FILTER !== 'hide' || !isCounter(x)));
      pool.sort((x, y) => qScore(y) - qScore(x));
      for (const x of pool) if (addSignal(x)) break;
      
    } catch (e) { log('Tarama hatası', sym, e.message); }
  }
  
  // Eski izleme verilerini temizle
  const now = Date.now();
  [zones, range, ltw].forEach(m => {
    for (const [k, v] of m.entries()) if (now - v.time > CFG.snapTtl) m.delete(k);
  });
  
  SNAP.zones = zones; SNAP.range = range; SNAP.lt = ltw;
  log('Tarama bitti. Evren:', UNIVERSE.length, '| Bu tur:', batch.length);
}

async function loop(fn, every, name) {
  while (true) {
    try { await fn(); } catch (e) { log(name, 'hata:', e.message); }
    await sleep(every);
  }
}

/* ===================== HTTP SUNUCU ===================== */
function stateJSON() {
  const now = Date.now();
  const sigs = SIGNALS.filter(s => now - s.time < 48 * 36e5)
    .concat([...SNAP.zones.values()], [...SNAP.range.values()], [...SNAP.lt.values()]);
  const need = new Set(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  sigs.forEach(s => need.add(s.symbol));
  const prices = {};
  need.forEach(k => { if (TICK[k]) prices[k] = TICK[k].last; });
  return {
    now, market: MARKET, prices,
    chg: { btc: TICK['BTC/USDT:USDT'] && TICK['BTC/USDT:USDT'].pct, eth: TICK['ETH/USDT:USDT'] && TICK['ETH/USDT:USDT'].pct },
    signals: sigs, radar: RADAR, stats: computeStats(),
    status: { universe: UNIVERSE.length, lastScan: LAST_SCAN, scanning: SCANNING, triTf: TRI_TF, mktFilter: MKT_FILTER, version: VERSION, batch: BATCH_INFO }
  };
}
const TFS = { '1m': 1, '5m': 1, '15m': 1, '30m': 1, '1h': 1, '2h': 1, '4h': 1, '6h': 1, '12h': 1, '1d': 1 };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
    send(res, 500, { error: e.message });
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
})().catch(e => { console.error('Başlatma hatası:', e); process.exit(1); });


/* ===================== FRONTEND ===================== */
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlphaSon</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .nav-btn{display:flex;align-items:center;gap:.75rem;width:100%;padding:.6rem .9rem;border-radius:.6rem;color:#94a3b8;font-size:.9rem;transition:background .15s,color .15s}
  .nav-btn:hover{background:#0f172a;color:#e2e8f0}
  .nav-btn.on{background:linear-gradient(90deg,rgba(6,182,212,.18),rgba(168,85,247,.12));color:#67e8f9;box-shadow:inset 2px 0 0 #06b6d4}
  .sc{background:#0b1222;border:1px solid #1e293b;border-radius:.8rem;padding:.9rem 1rem;cursor:pointer;transition:border-color .15s}
  .sc:hover{border-color:#06b6d4}
  ::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:8px}
</style>
</head>
<body class="bg-slate-950 text-slate-200">
<div class="flex h-screen overflow-hidden">
  <aside class="hidden md:flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950 p-3">
    <div class="px-3 py-4 mb-2">
      <div class="text-xl font-bold tracking-tight"><span class="text-cyan-400">Alpha</span><span class="text-purple-400">Son</span></div>
      <div class="text-xs text-slate-500 mt-1">Sinyal ve tarama botu · v61.7</div>
    </div>
    <nav id="nav" class="space-y-1 overflow-y-auto"></nav>
    <div id="side-status" class="mt-auto px-3 py-3 text-xs text-slate-500"></div>
  </aside>
  <main class="flex-1 flex flex-col min-w-0">
    <header class="flex items-center gap-4 px-5 py-3 border-b border-slate-800 bg-slate-950/90">
      <select id="mnav" class="md:hidden bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm"></select>
      <div class="flex items-center gap-2"><span class="text-xs text-slate-500">Piyasa Yönü</span><span id="mkt" class="px-3 py-1 rounded-full text-xs font-bold bg-slate-800">-</span></div>
      <div class="ml-auto flex items-center gap-5 text-sm">
        <div><span class="text-slate-500 mr-1">BTC</span><span id="pbtc" class="font-semibold">-</span><span id="cbtc" class="ml-1 text-xs"></span></div>
        <div><span class="text-slate-500 mr-1">ETH</span><span id="peth" class="font-semibold">-</span><span id="ceth" class="ml-1 text-xs"></span></div>
      </div>
    </header>
    <div id="view" class="flex-1 overflow-y-auto p-5 md:p-7"></div>
  </main>
</div>

<div id="shade" class="fixed inset-0 bg-black/50 hidden z-30"></div>
<aside id="panel" class="fixed right-0 top-0 h-full w-full md:w-[660px] bg-slate-950 border-l border-slate-800 z-40 translate-x-full transition-transform duration-300 overflow-y-auto">
  <div class="p-5">
    <div class="flex items-start justify-between">
      <div id="pHead"></div>
      <button id="pClose" class="text-slate-400 hover:text-white text-xl px-2"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div id="pGrid" class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4"></div>
    <canvas id="cv" class="w-full mt-4 rounded-lg border border-slate-800" style="height:400px"></canvas>
    <div id="pInfo" class="mt-4 flex flex-wrap gap-2"></div>
  </div>
</aside>

<script>
var S=null, view='home', cur=null, curC=null, lastCF=0;
var NAV=[['home','Ana Sayfa','fa-house'],['radar','Piyasa Radarı','fa-satellite-dish'],['pump','AlgoPump','fa-rocket'],['trend','Trend','fa-chart-line'],['lt','LT Üçgenler','fa-play fa-rotate-270'],['zone','Zone Master','fa-layer-group'],['scalper','Scalper','fa-bolt'],['range','Range Pro','fa-arrows-left-right'],['strat','Stratejiler','fa-chess'],['bt','Backtest','fa-flask'],['stats','İstatistik','fa-chart-pie']];
var TITLES={home:'Ana Sayfa',radar:'Piyasa Radarı',pump:'AlgoPump',trend:'TRF Trend',lt:'LT Üçgenler',zone:'Zone Master',scalper:'Scalper (SMC)',range:'Range Pro',strat:'Hazır Stratejiler',bt:'Backtest',stats:'İstatistik'};
function $(i){return document.getElementById(i);}
function fp(p){if(p==null||isNaN(p))return '-';var a=Math.abs(p);var d=a>=1000?2:a>=100?3:a>=1?4:a>=0.1?5:a>=0.01?6:8;return Number(p).toFixed(d);}
function ago(t){var s=(Date.now()-t)/1000;if(s<60)return Math.floor(s)+' sn';if(s<3600)return Math.floor(s/60)+' dk';if(s<86400)return Math.floor(s/3600)+' sa';return Math.floor(s/86400)+' g';}
function short(sym){return sym.split('/')[0];}
function tvUrl(s){var iv={'1m':'1','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','1d':'D'}[s.tf]||'15';return 'https://www.tradingview.com/chart/?symbol=BITGET%3A'+short(s.symbol)+'USDT.P&interval='+iv;}
function find(id){if(!S)return null;for(var i=0;i<S.signals.length;i++)if(S.signals[i].id===id)return S.signals[i];return null;}
function isOpen(s){return !s.stopped&&!s.hit2&&!s.expired;}
function pnl(s){var p=S.prices[s.symbol];if(p==null||s.entry==null)return null;if(s.watch)return {p:p,pct:null,r:null};var L=s.dir==='LONG';var d=L?p-s.entry:s.entry-p;if(s.dir==='NÖTR')return {p:p,pct:null,r:null};return {p:p,pct:d/s.entry*100,r:s.sl?d/Math.abs(s.entry-s.sl):null};}
function col(d){return d==='LONG'?'emerald':d==='SHORT'?'rose':'slate';}
function sgn(x,dg){if(x==null)return '-';return (x>=0?'+':'')+x.toFixed(dg==null?2:dg);}
function pc(x){return x==null?'text-slate-400':x>=0?'text-emerald-400':'text-rose-400';}

/* NAV */
function buildNav(){
  var h='',o='';
  NAV.forEach(function(n){h+='<button class="nav-btn" data-view="'+n[0]+'"><i class="fa-solid '+n[2]+' w-5 text-center"></i><span>'+n[1]+'</span></button>';o+='<option value="'+n[0]+'">'+n[1]+'</option>';});
  $('nav').innerHTML=h;$('mnav').innerHTML=o;
}
function setView(v){view=v;var b=document.querySelectorAll('.nav-btn');for(var i=0;i<b.length;i++)b[i].classList.toggle('on',b[i].dataset.view===v);$('mnav').value=v;render();}
document.addEventListener('click',function(e){
  if(e.target.closest('a.tv'))return;
  var n=e.target.closest('[data-view]');if(n){setView(n.dataset.view);return;}
  var c=e.target.closest('[data-id]');if(c){openDetail(c.dataset.id);}
});
$('mnav').addEventListener('change',function(e){setView(e.target.value);});

/* ÜST BAR */
function renderTop(){
  var m=S.market.dir,cl=m==='LONG'?'bg-emerald-500/20 text-emerald-300':m==='SHORT'?'bg-rose-500/20 text-rose-300':'bg-slate-700 text-slate-300';
  var ic=m==='LONG'?'▲ ':m==='SHORT'?'▼ ':'● ';
  $('mkt').className='px-3 py-1 rounded-full text-xs font-bold '+cl;$('mkt').textContent=ic+m;
  var b=S.prices['BTC/USDT:USDT'],e=S.prices['ETH/USDT:USDT'];
  $('pbtc').textContent=b?'$'+fp(b):'-';$('peth').textContent=e?'$'+fp(e):'-';
  var cb=S.chg.btc,ce=S.chg.eth;
  $('cbtc').textContent=cb==null?'':sgn(cb)+'%';$('cbtc').className='ml-1 text-xs '+pc(cb);
  $('ceth').textContent=ce==null?'':sgn(ce)+'%';$('ceth').className='ml-1 text-xs '+pc(ce);
  var st=S.status;
  $('side-status').innerHTML='<i class="fa-solid fa-circle '+(st.scanning?'text-amber-400':'text-emerald-400')+' text-[8px] mr-1"></i>'+(st.scanning?'Taranıyor…':'Hazır')+'<br>'+st.universe+' coin · Tur: '+st.batch.size+'<br>LT '+st.triTf+' · Piyasa: '+S.market.src;
}

/* KARTLAR */
function badge(d){var c=col(d);var t=d==='LONG'?'▲ LONG':d==='SHORT'?'▼ SHORT':'● NÖTR';return '<span class="px-2 py-0.5 rounded text-xs font-bold bg-'+c+'-500/20 text-'+c+'-300">'+t+'</span>';}
function card(s){
  var q=pnl(s);
  var st=s.status||'';
  var stc=st==='TP1'||st==='TP2'?'text-emerald-400':st.indexOf('STOP')>=0?'text-rose-400':'text-cyan-300';
  var h='<div class="sc" data-id="'+s.id+'"><div class="flex items-center justify-between"><div class="font-semibold">'+short(s.symbol)+'<span class="text-slate-500 text-xs"> /USDT · '+s.tf+'</span></div><span>'+(s.counter?'<span class="mr-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300">Piyasa Ters</span>':'')+badge(s.dir)+'</span></div>';
  h+='<div class="mt-2 flex items-end justify-between"><div class="text-xs text-slate-500">Giriş<div class="text-sm text-slate-200">'+fp(s.entry)+'</div></div>';
  h+='<div class="text-xs text-slate-500 text-center">Şimdi<div class="text-sm text-slate-200">'+(q?fp(q.p):'-')+'</div></div>';
  h+='<div class="text-right text-xs text-slate-500">K/Z<div class="text-sm font-semibold '+pc(q&&q.pct)+'">'+(q&&q.pct!=null?sgn(q.pct)+'%':'-')+'</div></div></div>';
  if(s.conf!=null)h+='<div class="mt-2 flex items-center gap-2 text-[11px] text-slate-400"><span>Güven</span><div class="flex-1 h-1.5 rounded bg-slate-800 overflow-hidden"><div class="h-full bg-gradient-to-r from-cyan-500 to-purple-500" style="width:'+s.conf+'%"></div></div><b class="text-slate-200">%'+s.conf+'</b></div>';
  h+='<div class="mt-2 flex items-center justify-between text-xs"><span class="'+stc+'">'+st+'</span><span class="text-slate-500">'+ago(s.time)+' önce <a class="tv ml-2 text-cyan-400 hover:text-cyan-200" href="'+tvUrl(s)+'" target="_blank" rel="noopener" title="TradingView"><i class="fa-solid fa-arrow-up-right-from-square"></i> TV</a></span></div>';
  if(s.module==='zone'||s.module==='range'){h+='<div class="mt-2 text-xs text-slate-400">'+s.info.map(function(x){return x[0]+': '+x[1];}).join('<br>')+'</div>';}
  else if(s.info&&s.info.length){h+='<div class="mt-2 flex flex-wrap gap-1">'+s.info.slice(0,3).map(function(x){return '<span class="px-1.5 py-0.5 rounded bg-slate-800 text-[11px] text-slate-300">'+x[0]+' '+x[1]+'</span>';}).join('')+'</div>';}
  return h+'</div>';
}
function modList(m,hours){
  var now=Date.now();
  return S.signals.filter(function(s){return s.module===m&&(!hours||now-s.time<hours*36e5);}).sort(function(a,b){var oa=isOpen(a)?1:0,ob=isOpen(b)?1:0;return ob-oa||b.time-a.time;});
}
function grid(list,empty){
  if(!list.length)return '<div class="text-slate-500 text-sm border border-dashed border-slate-800 rounded-lg p-8 text-center">'+empty+'</div>';
  return '<div class="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">'+list.map(card).join('')+'</div>';
}
function sum(label,val,ic,c){return '<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="flex items-center justify-between text-slate-400 text-sm"><span>'+label+'</span><i class="fa-solid '+ic+' text-'+c+'-400"></i></div><div class="text-3xl font-bold mt-2">'+val+'</div></div>';}

/* RADAR */
function radarBlock(compact){
  var r=S.radar||{};var f=r.fng;
  var fc=!f?'text-slate-400':f.value<25?'text-rose-400':f.value<45?'text-orange-400':f.value<55?'text-slate-200':f.value<75?'text-lime-400':'text-emerald-400';
  var h='<div class="grid gap-3 grid-cols-1 md:grid-cols-3">';
  
  // Korku / Hırs
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">Korku / Hırs Endeksi</div><div class="text-4xl font-bold mt-2 '+fc+'">'+(f?f.value:'-')+'</div><div class="text-xs text-slate-500 mt-1">'+(f?f.label:'Veri yok')+'</div>';
  if(f) {
    var text = f.value > 75 ? "Aşırı iyimserlik hakim. Düzeltme gelebilir, kâr al seviyelerini sıkı tutun." : f.value < 25 ? "Aşırı korku var. Dip seviyeler olabilir, agresif satıştan kaçının." : "Piyasa nötr/aşırılık yok. Normal seyir.";
    h+='<div class="text-xs text-slate-400 mt-2 leading-tight">'+text+'</div>';
  }
  h+='</div>';

  // RSI
  var rs=r.rsi||{};
  function rv(k,tf){var v=rs[k]&&rs[k][tf];return v==null?'-':v.toFixed(1);}
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">RSI (14)</div><div class="mt-2 text-sm space-y-1"><div class="flex justify-between"><span>BTC 1s / 4s</span><b>'+rv('BTC','1h')+' / '+rv('BTC','4h')+'</b></div><div class="flex justify-between"><span>ETH 1s / 4s</span><b>'+rv('ETH','1h')+' / '+rv('ETH','4h')+'</b></div></div>';
  h+='<div class="text-xs text-slate-400 mt-2 leading-tight">RSI 30 altı aşırı satım (tepki alımı), 70 üstü aşırı alım (düşüş riski) demektir.</div></div>';

  // Long / Short
  function ls(k){var x=r.ls&&r.ls[k];if(!x)return '<div class="flex justify-between"><span>'+k+'</span><b>-</b></div>';return '<div><div class="flex justify-between"><span>'+k+' L/S</span><b>'+x.ratio.toFixed(2)+'</b></div><div class="h-1.5 rounded bg-rose-500/60 mt-1 overflow-hidden"><div class="h-full bg-emerald-500" style="width:'+(x.long*100).toFixed(0)+'%"></div></div></div>';}
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">Long / Short Oranı (Binance)</div><div class="mt-2 text-sm space-y-3">'+ls('BTC')+ls('ETH')+'</div>';
  var lsWarning = (r.ls && r.ls.ETH && r.ls.ETH.ratio > 2.5) ? "Dikkat: Retail aşırı Long'ta. Balinalar fiyatı aşağı çekip Long sıkışması (Long Squeeze) yaratabilir." : "Oranlar normal seyrinde.";
  h+='<div class="text-xs text-slate-400 mt-2 leading-tight">'+lsWarning+'</div></div>';

  return h+'</div>';
}

/* STRATEJİLER */
function strategies(){
  var now=Date.now(),mk=S.market.dir;
  var open=S.signals.filter(function(s){return isOpen(s)&&!s.watch&&['trend','lt','pump','scalper'].indexOf(s.module)>=0&&now-s.time<24*36e5;});
  var s1=open.filter(function(s){return s.module==='trend'&&s.dir===mk;});
  var s2=open.filter(function(s){return s.module==='lt'&&!s.watch&&/x(\\d+(\\.\\d+)?)/.test(s.info[0][1])&&parseFloat(s.info[0][1].slice(1))>=2;});
  var s3=open.filter(function(s){return s.module==='pump'&&now-s.time<2*36e5;});
  var by={};open.forEach(function(s){var k=s.symbol+'|'+s.dir;(by[k]=by[k]||[]).push(s);});
  var s4=[];for(var k in by){var mods={};by[k].forEach(function(s){mods[s.module]=1;});if(Object.keys(mods).length>=2)s4=s4.concat(by[k]);}
  return [
    {n:'Piyasa Uyumlu Trend',d:'Taze TRF trendi, piyasa yönüyle (BTC+ETH) aynı yönde.',i:'fa-compass',c:'cyan',l:s1},
    {n:'Kırılım Avcısı',d:'LT üçgen kırılımı ve hacim en az 2 kat.',i:'fa-play fa-rotate-270',c:'purple',l:s2},
    {n:'Pump Takibi',d:'Son 2 saatte yakalanan hacimli alıcı baskısı.',i:'fa-rocket',c:'amber',l:s3},
    {n:'Konfluans (Teyit)',d:'Aynı coinde aynı yönde en az iki farklı modül sinyali.',i:'fa-bullseye',c:'emerald',l:s4}
  ];
}

/* GÖRÜNÜMLER */
function render(){
  if(!S){$('view').innerHTML='<div class="text-slate-500">Yükleniyor…</div>';return;}
  var h='<h1 class="text-xl font-bold mb-4">'+TITLES[view]+'</h1>';
  var now=Date.now();
  
  if(view==='home'){
    var tr=S.signals.filter(function(s){return s.module==='trend'&&isOpen(s);}).length;
    var lt=S.signals.filter(function(s){return s.module==='lt'&&!s.watch&
