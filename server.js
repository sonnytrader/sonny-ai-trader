'use strict';
/*
 * AlphaSon - Kripto Sinyal ve Tarama Botu (tek dosya)
 * Kurulum:  npm i ccxt      (Node 18+ gerekir: global fetch kullanılır)
 * Çalıştır: node server.js  ->  http://localhost:3000
 * Not: Yatırım tavsiyesi değildir. Sinyaller eğitim/araştırma amaçlıdır.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let ccxt;
try { ccxt = require('ccxt'); } catch (e) { console.error('ccxt bulunamadı. Önce: npm i ccxt'); process.exit(1); }

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'alphason_signals.json');
const CFG = {
  topN: 70,            // 15m/1h modülleri için taranacak coin sayısı
  pumpN: 120,          // AlgoPump için taranacak coin sayısı
  scanEvery: 300000,   // tam tarama aralığı
  pumpEvery: 60000,
  tickerEvery: 15000,
  radarEvery: 300000,
  gapMs: 120,          // istekler arası minimum bekleme (throttle)
  maxSignals: 600,
  keepMs: 7 * 864e5
};

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
async function getCandles(sym, tf, limit = 250, ttl = 60000) {
  const k = sym + '|' + tf + '|' + limit;
  const c = cache.get(k);
  if (c && Date.now() - c.t < ttl) return c.v;
  const raw = await safeFetch(() => ex.fetchOHLCV(sym, tf, undefined, limit));
  const v = raw.map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
  cache.set(k, { t: Date.now(), v });
  if (cache.size > 700) {
    const old = [...cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 200);
    old.forEach(e => cache.delete(e[0]));
  }
  return v;
}

const TICK = {};
let ALL = [], UNIVERSE = [], PUMPU = [];
async function refreshTickers() {
  const t = await safeFetch(() => ex.fetchTickers());
  for (const k in t) {
    const m = ex.markets[k];
    if (!m || !m.swap || !m.linear || m.quote !== 'USDT' || m.active === false) continue;
    const x = t[k];
    if (!x.last) continue;
    TICK[k] = { last: x.last, pct: x.percentage, qv: x.quoteVolume || 0 };
  }
  ALL = Object.keys(TICK).sort((a, b) => TICK[b].qv - TICK[a].qv);
  UNIVERSE = ALL.slice(0, CFG.topN);
  PUMPU = ALL.slice(0, CFG.pumpN);
  trackOutcomes();
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
function pivots(cs, L = 3, R = 3) {
  const hi = [], lo = [];
  for (let i = L; i < cs.length - R; i++) {
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
const SNAP = { zones: new Map(), range: new Map() };
let MARKET = { dir: 'NÖTR', btc: 0, eth: 0, time: 0 };
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

function addSignal(o) {
  const s = Object.assign({ time: Date.now(), status: 'AÇIK', hit1: false, hit2: false, stopped: false, tf: '15m', info: [] }, o);
  if (!s.id) s.id = crypto.createHash('md5').update(JSON.stringify([s.module, s.symbol, s.dir, s.time])).digest('hex').slice(0, 12);
  if (SIGSET.has(s.id)) return false;
  SIGSET.add(s.id);
  SIGNALS.unshift(s);
  while (SIGNALS.length > CFG.maxSignals) { const x = SIGNALS.pop(); SIGSET.delete(x.id); }
  DIRTY = true;
  log('SİNYAL', s.module, s.symbol, s.dir);
  return true;
}
function trackOutcomes() {
  for (const s of SIGNALS) {
    if (s.stopped || s.hit2 || !s.sl) continue;
    const tk = TICK[s.symbol];
    if (!tk) continue;
    const p = tk.last, L = s.dir === 'LONG';
    const stop = L ? p <= s.sl : p >= s.sl;
    const t1 = L ? p >= s.tp1 : p <= s.tp1;
    const t2 = L ? p >= s.tp2 : p <= s.tp2;
    if (t2) { s.hit1 = s.hit2 = true; s.status = 'TP2'; s.closed = Date.now(); DIRTY = true; }
    else if (stop) { s.stopped = true; s.status = s.hit1 ? 'TP1 → STOP' : 'STOP'; s.closed = Date.now(); DIRTY = true; }
    else if (t1 && !s.hit1) { s.hit1 = true; s.status = 'TP1'; DIRTY = true; }
  }
}
function computeStats() {
  const out = {};
  for (const m of ['trend', 'lt', 'pump', 'scalper']) {
    const arr = SIGNALS.filter(s => s.module === m);
    let win = 0, loss = 0, open = 0, R = 0;
    for (const s of arr) {
      const risk = Math.abs(s.entry - s.sl) || 1;
      const r1 = Math.abs(s.tp1 - s.entry) / risk, r2 = Math.abs(s.tp2 - s.entry) / risk;
      if (s.hit2) { win++; R += r2; }
      else if (s.hit1) { win++; R += r1; if (!s.stopped) open++; }
      else if (s.stopped) { loss++; R -= 1; }
      else open++;
    }
    const closed = win + loss;
    out[m] = { total: arr.length, open, win, loss, winRate: closed ? win / closed * 100 : null, R };
  }
  return out;
}

/* ===================== MODÜL A: PİYASA YÖNÜ ===================== */
async function marketDirection() {
  const dirs = [];
  for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) {
    const c = await getCandles(s, '15m', 250, 120000);
    dirs.push(trf(c.slice(0, -1)).dir.slice(-1)[0]);
  }
  const d = dirs[0] === 1 && dirs[1] === 1 ? 'LONG' : dirs[0] === -1 && dirs[1] === -1 ? 'SHORT' : 'NÖTR';
  MARKET = { dir: d, btc: dirs[0], eth: dirs[1], time: Date.now() };
}

/* ===================== MODÜL B: LT ÜÇGEN (simetrik) ===================== */
function lineAt(l, i) { return l.p1 + (l.p2 - l.p1) * (i - l.i1) / (l.i2 - l.i1); }

function evalPair(cs, h1, h2, l1, l2) {
  const b = cs.length - 1; // kırılım adayı mum
  const res = { i1: h1.i, p1: h1.p, i2: h2.i, p2: h2.p };
  const sup = { i1: l1.i, p1: l1.p, i2: l2.i, p2: l2.p };
  const sr = (res.p2 - res.p1) / (res.i2 - res.i1);
  const ss = (sup.p2 - sup.p1) / (sup.i2 - sup.i1);
  if (sr >= 0 || ss <= 0) return null;                   // direnç düşen, destek yükselen
  const ratio = Math.abs(sr / res.p1) / Math.abs(ss / sup.p1);
  if (ratio < 0.5 || ratio > 2) return null;             // simetrik
  const start = Math.min(h1.i, l1.i);
  if (b - start < 20 || b - start > 160) return null;
  const w0 = lineAt(res, start) - lineAt(sup, start);
  const wn = lineAt(res, b - 1) - lineAt(sup, b - 1);
  if (w0 <= 0 || wn <= 0) return null;
  if (w0 / cs[b].c < 0.008) return null;
  const squeeze = wn / w0;
  if (squeeze > 0.7) return null;                        // daralma şartı
  const apex = start + w0 / (ss - sr);                   // çizgilerin kesiştiği mum indeksi
  const mat = (b - start) / (apex - start);
  if (mat < 0.5 || mat > 1.0) return null;               // olgunluk
  let tR = 0, tS = 0, lr = -9, ls = -9;
  for (let i = start; i < b; i++) {
    const R = lineAt(res, i), S = lineAt(sup, i), c = cs[i];
    if (c.c > R * 1.002 || c.c < S * 0.998) return null; // çizgi ihlali
    if (c.h >= R * 0.996 && i - lr >= 3) { tR++; lr = i; }
    if (c.l <= S * 1.004 && i - ls >= 3) { tS++; ls = i; }
  }
  if (tR < 2 || tS < 2 || tR + tS < 5) return null;
  return { res, sup, start, apex, mat, squeeze, w0, wn, touches: tR + tS, score: (tR + tS) * 10 + mat * 10 - squeeze * 5 };
}
function fitLines(cs) {
  const b = cs.length - 1;
  const pv = pivots(cs, 3, 3);
  const H = pv.hi.filter(p => p.i > b - 150).slice(-5);
  const Lw = pv.lo.filter(p => p.i > b - 150).slice(-5);
  let best = null;
  for (let a = 0; a < H.length; a++) for (let c = a + 1; c < H.length; c++)
    for (let d = 0; d < Lw.length; d++) for (let e = d + 1; e < Lw.length; e++) {
      const r = evalPair(cs, H[a], H[c], Lw[d], Lw[e]);
      if (r && (!best || r.score > best.score)) best = r;
    }
  return best;
}
async function ltMod(sym, c, tf) {
  const cs = c.slice(0, -1);
  if (cs.length < 80) return;
  const b = cs.length - 1;
  const fit = fitLines(cs);
  if (!fit) return;
  const R = lineAt(fit.res, b), S = lineAt(fit.sup, b);
  const Rp = lineAt(fit.res, b - 1), Sp = lineAt(fit.sup, b - 1);
  const cl = cs[b].c, pc = cs[b - 1].c;
  let dir = null;
  if (cl > R * 1.001 && pc <= Rp * 1.001) dir = 'LONG';
  else if (cl < S * 0.999 && pc >= Sp * 0.999) dir = 'SHORT';
  if (!dir) return;
  let vsum = 0;
  for (let i = b - 20; i < b; i++) vsum += cs[i].v;
  const volX = cs[b].v / (vsum / 20 || 1);
  if (volX < 1.5) return;
  const tk = await takerRatio(sym, candleTaker([cs[b]]));
  if (dir === 'LONG' && tk < 0.55) return;
  if (dir === 'SHORT' && tk > 0.45) return;
  const L = dir === 'LONG';
  const h = Math.min(fit.w0, cl * 0.1);
  const mid = (R + S) / 2;
  let sl = L ? Math.min(mid, cl * 0.996) : Math.max(mid, cl * 1.004);
  if (Math.abs(cl - sl) > cl * 0.03) sl = L ? cl * 0.97 : cl * 1.03;
  const sg = L ? 1 : -1;
  addSignal({
    id: 'lt|' + tf + '|' + sym + '|' + dir + '|' + cs[b].t,
    module: 'lt', symbol: sym, dir, tf, time: Date.now(),
    entry: cl, sl, tp1: cl + sg * h * 0.618, tp2: cl + sg * h,
    lines: [
      { k: 'res', t1: cs[fit.start].t, p1: lineAt(fit.res, fit.start), t2: cs[b].t, p2: R },
      { k: 'sup', t1: cs[fit.start].t, p1: lineAt(fit.sup, fit.start), t2: cs[b].t, p2: S }
    ],
    info: [['Hacim', 'x' + volX.toFixed(1)], ['Taker Buy', '%' + (tk * 100).toFixed(0)], ['Değme', fit.touches], ['Olgunluk', '%' + (fit.mat * 100).toFixed(0)], ['Zaman Dil.', tf]]
  });
}

/* ===================== MODÜL C: TRF TREND ===================== */
function trendMod(sym, c) {
  const cs = c.slice(0, -1);
  if (cs.length < 120) return;
  const { dir } = trf(cs);
  const n = cs.length - 1;
  let chg = -1;
  for (let k = 0; k < 3; k++) if (dir[n - k] !== dir[n - k - 1]) { chg = n - k; break; }
  if (chg < 0 || dir[n] === 0) return;                    // taze trend değilse çık
  const L = dir[n] === 1;
  const entry = cs[n].c;
  const atr = atrArr(cs)[n];
  const last10 = cs.slice(n - 9);
  const lo = Math.min(...last10.map(x => x.l)), hi = Math.max(...last10.map(x => x.h));
  let sl = L ? lo - atr * 0.5 : hi + atr * 0.5;           // swing + ATR
  const maxRisk = entry * 0.03;
  if (Math.abs(entry - sl) > maxRisk) sl = L ? entry - maxRisk : entry + maxRisk;
  if (L ? sl >= entry : sl <= entry) sl = L ? entry * 0.99 : entry * 1.01;
  const wave = Math.max(hi - lo, Math.abs(entry - sl));
  const sg = L ? 1 : -1;
  addSignal({
    id: 'trend|' + sym + '|' + cs[chg].t,
    module: 'trend', symbol: sym, dir: L ? 'LONG' : 'SHORT', tf: '15m',
    entry, sl, tp1: entry + sg * wave * 1.618, tp2: entry + sg * wave * 2.618,
    info: [['Piyasa', MARKET.dir], ['Risk', '%' + (Math.abs(entry - sl) / entry * 100).toFixed(2)], ['ATR', '%' + (atr / entry * 100).toFixed(2)]]
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
      if (x <= 4) continue;
      if (c[n - 1].c <= c[n - 10].o) continue;
      const proxy = candleTaker(last);
      if (proxy < 0.6) continue;
      const tk = await takerRatio(sym, proxy);
      if (tk <= 0.75) continue;
      const entry = c[n - 1].c;
      let sl = Math.max(Math.min(...last.map(q => q.l)) * 0.995, entry * 0.97);
      if (sl >= entry) sl = entry * 0.97;
      addSignal({
        id: 'pump|' + sym + '|' + Math.floor(Date.now() / 600000),
        module: 'pump', symbol: sym, dir: 'LONG', tf: '1m',
        entry, sl, tp1: entry * 1.03, tp2: entry * 1.06,
        info: [['Hacim', 'x' + x.toFixed(1)], ['Taker Buy', '%' + (tk * 100).toFixed(0)], ['10dk Değişim', '%' + ((entry / c[n - 10].o - 1) * 100).toFixed(2)]]
      });
    } catch (e) { /* sembol atla */ }
  }
}

/* ===================== MODÜL E: ZONE MASTER ===================== */
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
  const zones = groupPivots(pv.hi.concat(pv.lo)).filter(z => z.strength >= 24);
  const price = (TICK[sym] && TICK[sym].last) || cs[cs.length - 1].c;
  const sups = zones.filter(z => z.p < price).sort((a, b) => b.p - a.p);
  const ress = zones.filter(z => z.p > price).sort((a, b) => a.p - b.p);
  const s = sups[0], r = ress[0];
  if (!s && !r) return;
  const ds = s ? (price - s.p) / price * 100 : 99, dr = r ? (r.p - price) / price * 100 : 99;
  if (Math.min(ds, dr) > 2.5) return;
  const L = ds <= dr;
  const atr = atrArr(cs)[cs.length - 1];
  const lv = zones.filter(z => Math.abs(z.p - price) / price < 0.08).map(z => ({ p: z.p, label: (z.p < price ? 'S ' : 'R ') + z.strength, color: z.p < price ? '#10b981' : '#f43f5e' }));
  const it = {
    id: 'zone|' + sym, module: 'zone', symbol: sym, dir: L ? 'LONG' : 'SHORT', tf: '1h', time: Date.now(),
    entry: price, levels: lv, status: 'İZLE',
    support: s || null, resistance: r || null, distS: ds, distR: dr, info: []
  };
  if (L && s) {
    it.sl = s.p - atr * 0.5; it.tp1 = r ? r.p : price * 1.02; it.tp2 = it.tp1 + (it.tp1 - price) * 0.618;
  } else if (!L && r) {
    it.sl = r.p + atr * 0.5; it.tp1 = s ? s.p : price * 0.98; it.tp2 = it.tp1 - (price - it.tp1) * 0.618;
  }
  it.info = [['Destek', s ? fmtN(s.p) + ' (güç ' + s.strength + ')' : '-'], ['Direnç', r ? fmtN(r.p) + ' (güç ' + r.strength + ')' : '-']];
  out.set(it.id, it);
}
function fmtN(p) { return Number(p).toPrecision(5); }

/* ===================== MODÜL F: SCALPER (SMC / BOS) ===================== */
function scalperMod(sym, c) {
  const cs = c.slice(0, -1);
  if (cs.length < 60) return;
  const n = cs.length - 1, ws = n - 10;
  const pv = pivots(cs.slice(0, ws + 1), 3, 3);
  const sh = pv.hi[pv.hi.length - 1], sw = pv.lo[pv.lo.length - 1];
  if (!sh || !sw) return;
  let up = -1, dn = -1;
  for (let j = ws + 1; j <= n; j++) {
    if (up < 0 && cs[j].c > sh.p) up = j;
    if (dn < 0 && cs[j].c < sw.p) dn = j;
  }
  if (up < 0 && dn < 0) return;
  const L = up > dn;
  const j = L ? up : dn;
  const entry = cs[n].c;
  if (L ? entry <= sh.p : entry >= sw.p) return;          // seviye geri kaybedildiyse
  const atr = atrArr(cs)[n];
  const last10 = cs.slice(n - 9);
  const lo = Math.min(...last10.map(x => x.l)), hi = Math.max(...last10.map(x => x.h));
  let sl = L ? lo - atr * 0.3 : hi + atr * 0.3;
  if (Math.abs(entry - sl) > entry * 0.03) sl = L ? entry * 0.97 : entry * 1.03;
  if (L ? sl >= entry : sl <= entry) sl = L ? entry * 0.99 : entry * 1.01;
  const risk = Math.abs(entry - sl), sg = L ? 1 : -1;
  addSignal({
    id: 'scalper|' + sym + '|' + (L ? 'L' : 'S') + '|' + cs[j].t,
    module: 'scalper', symbol: sym, dir: L ? 'LONG' : 'SHORT', tf: '15m',
    entry, sl, tp1: entry + sg * risk * 1.5, tp2: entry + sg * risk * 3,
    levels: [{ p: L ? sh.p : sw.p, label: 'BOS', color: '#a855f7' }],
    info: [['Yapı', 'BOS ' + (L ? '↑' : '↓')], ['Kırılan Seviye', fmtN(L ? sh.p : sw.p)], ['Mum Önce', (n - j) + '']]
  });
}

/* ===================== MODÜL G: RANGE PRO ===================== */
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
  const it = {
    id: 'range|' + sym, module: 'range', symbol: sym, dir: 'NÖTR', tf: '15m', time: Date.now(),
    entry: (hi + lo) / 2, status: 'SIKIŞMA', top: hi, bottom: lo, width, atrRatio: ratio,
    levels: [{ p: hi, label: 'Üst', color: '#06b6d4' }, { p: lo, label: 'Alt', color: '#a855f7' }],
    info: [['Genişlik', '%' + width.toFixed(2)], ['ATR Oranı', ratio.toFixed(2)], ['Üst / Alt', fmtN(hi) + ' / ' + fmtN(lo)]]
  };
  out.set(it.id, it);
}

/* ===================== MODÜL H: PİYASA RADARI ===================== */
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
  const zones = new Map(), range = new Map();
  for (const sym of UNIVERSE) {
    try {
      const c15 = await getCandles(sym, '15m', 250, 240000);
      const c1h = await getCandles(sym, '1h', 250, 900000);
      trendMod(sym, c15);
      scalperMod(sym, c15);
      rangeMod(sym, c15, range);
      zoneMod(sym, c1h, zones);
      await ltMod(sym, c15, '15m');
      await ltMod(sym, c1h, '1h');
    } catch (e) { log('Tarama hatası', sym, e.message); }
  }
  SNAP.zones = zones; SNAP.range = range;
  log('Tarama bitti:', UNIVERSE.length, 'sembol');
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
    .concat([...SNAP.zones.values()], [...SNAP.range.values()]);
  const need = new Set(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  sigs.forEach(s => need.add(s.symbol));
  const prices = {};
  need.forEach(k => { if (TICK[k]) prices[k] = TICK[k].last; });
  return {
    now, market: MARKET, prices,
    chg: { btc: TICK['BTC/USDT:USDT'] && TICK['BTC/USDT:USDT'].pct, eth: TICK['ETH/USDT:USDT'] && TICK['ETH/USDT:USDT'].pct },
    signals: sigs, radar: RADAR, stats: computeStats(),
    status: { universe: UNIVERSE.length, lastScan: LAST_SCAN, scanning: SCANNING }
  };
}
const TFS = { '1m': 1, '5m': 1, '15m': 1, '30m': 1, '1h': 1, '4h': 1, '1d': 1 };
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
      const c = await getCandles(sym, tf, 300, 20000);
      const closes = c.map(x => x.c);
      return send(res, 200, { symbol: sym, tf, candles: c, ema21: ema(closes, 21), ema50: ema(closes, 50) });
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
  server.listen(PORT, () => log('AlphaSon hazır -> http://localhost:' + PORT));
  loop(refreshTickers, CFG.tickerEvery, 'ticker');
  loop(async () => { SCANNING = true; try { await scanCycle(); } finally { SCANNING = false; LAST_SCAN = Date.now(); } }, CFG.scanEvery, 'tarama');
  loop(pumpScan, CFG.pumpEvery, 'pump');
  loop(radarScan, CFG.radarEvery, 'radar');
})().catch(e => { console.error('Başlatma hatası:', e); process.exit(1); });

/* ===================== FRONTEND ===================== */
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlphaSon</title>
<script src="https://cdn.tailwindcss.com"></script>
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
      <div class="text-xs text-slate-500 mt-1">Sinyal ve tarama botu</div>
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
var NAV=[['home','Ana Sayfa','fa-house'],['radar','Piyasa Radarı','fa-satellite-dish'],['pump','AlgoPump','fa-rocket'],['trend','Trend','fa-chart-line'],['lt','LT Üçgenler','fa-play fa-rotate-270'],['zone','Zone Master','fa-layer-group'],['scalper','Scalper','fa-bolt'],['range','Range Pro','fa-arrows-left-right'],['strat','Stratejiler','fa-chess'],['stats','İstatistik','fa-chart-pie']];
var TITLES={home:'Ana Sayfa',radar:'Piyasa Radarı',pump:'AlgoPump',trend:'TRF Trend',lt:'LT Üçgenler',zone:'Zone Master',scalper:'Scalper (SMC)',range:'Range Pro',strat:'Hazır Stratejiler',stats:'İstatistik'};
function $(i){return document.getElementById(i);}
function fp(p){if(p==null||isNaN(p))return '-';var a=Math.abs(p);var d=a>=1000?2:a>=100?3:a>=1?4:a>=0.1?5:a>=0.01?6:8;return Number(p).toFixed(d);}
function ago(t){var s=(Date.now()-t)/1000;if(s<60)return Math.floor(s)+' sn';if(s<3600)return Math.floor(s/60)+' dk';if(s<86400)return Math.floor(s/3600)+' sa';return Math.floor(s/86400)+' g';}
function short(sym){return sym.split('/')[0];}
function find(id){if(!S)return null;for(var i=0;i<S.signals.length;i++)if(S.signals[i].id===id)return S.signals[i];return null;}
function isOpen(s){return !s.stopped&&!s.hit2;}
function pnl(s){var p=S.prices[s.symbol];if(p==null||s.entry==null)return null;var L=s.dir==='LONG';var d=L?p-s.entry:s.entry-p;if(s.dir==='NÖTR')return {p:p,pct:null,r:null};return {p:p,pct:d/s.entry*100,r:s.sl?d/Math.abs(s.entry-s.sl):null};}
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
  $('side-status').innerHTML='<i class="fa-solid fa-circle '+(st.scanning?'text-amber-400':'text-emerald-400')+' text-[8px] mr-1"></i>'+(st.scanning?'Taranıyor…':'Hazır')+'<br>'+st.universe+' coin · Son tarama '+(st.lastScan?ago(st.lastScan)+' önce':'-');
}

/* KARTLAR */
function badge(d){var c=col(d);var t=d==='LONG'?'▲ LONG':d==='SHORT'?'▼ SHORT':'● NÖTR';return '<span class="px-2 py-0.5 rounded text-xs font-bold bg-'+c+'-500/20 text-'+c+'-300">'+t+'</span>';}
function card(s){
  var q=pnl(s);
  var st=s.status||'';
  var stc=st==='TP1'||st==='TP2'?'text-emerald-400':st.indexOf('STOP')>=0?'text-rose-400':'text-cyan-300';
  var h='<div class="sc" data-id="'+s.id+'"><div class="flex items-center justify-between"><div class="font-semibold">'+short(s.symbol)+'<span class="text-slate-500 text-xs"> /USDT · '+s.tf+'</span></div>'+badge(s.dir)+'</div>';
  h+='<div class="mt-2 flex items-end justify-between"><div class="text-xs text-slate-500">Giriş<div class="text-sm text-slate-200">'+fp(s.entry)+'</div></div>';
  h+='<div class="text-xs text-slate-500 text-center">Şimdi<div class="text-sm text-slate-200">'+(q?fp(q.p):'-')+'</div></div>';
  h+='<div class="text-right text-xs text-slate-500">K/Z<div class="text-sm font-semibold '+pc(q&&q.pct)+'">'+(q&&q.pct!=null?sgn(q.pct)+'%':'-')+'</div></div></div>';
  h+='<div class="mt-2 flex items-center justify-between text-xs"><span class="'+stc+'">'+st+'</span><span class="text-slate-500">'+ago(s.time)+' önce</span></div>';
  if(s.module==='zone'){h+='<div class="mt-2 text-xs text-slate-400">'+s.info.map(function(x){return x[0]+': '+x[1];}).join('<br>')+'</div>';}
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
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">Korku / Hırs Endeksi</div><div class="text-4xl font-bold mt-2 '+fc+'">'+(f?f.value:'-')+'</div><div class="text-xs text-slate-500 mt-1">'+(f?f.label:'Veri yok')+'</div></div>';
  var rs=r.rsi||{};
  function rv(k,tf){var v=rs[k]&&rs[k][tf];return v==null?'-':v.toFixed(1);}
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">RSI (14)</div><div class="mt-2 text-sm space-y-1"><div class="flex justify-between"><span>BTC 1s / 4s</span><b>'+rv('BTC','1h')+' / '+rv('BTC','4h')+'</b></div><div class="flex justify-between"><span>ETH 1s / 4s</span><b>'+rv('ETH','1h')+' / '+rv('ETH','4h')+'</b></div></div></div>';
  function ls(k){var x=r.ls&&r.ls[k];if(!x)return '<div class="flex justify-between"><span>'+k+'</span><b>-</b></div>';return '<div><div class="flex justify-between"><span>'+k+' L/S</span><b>'+x.ratio.toFixed(2)+'</b></div><div class="h-1.5 rounded bg-rose-500/60 mt-1 overflow-hidden"><div class="h-full bg-emerald-500" style="width:'+(x.long*100).toFixed(0)+'%"></div></div></div>';}
  h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div class="text-sm text-slate-400">Long / Short Oranı (Binance)</div><div class="mt-2 text-sm space-y-3">'+ls('BTC')+ls('ETH')+'</div></div>';
  return h+'</div>';
}

/* STRATEJİLER */
function strategies(){
  var now=Date.now(),mk=S.market.dir;
  var open=S.signals.filter(function(s){return isOpen(s)&&['trend','lt','pump','scalper'].indexOf(s.module)>=0&&now-s.time<24*36e5;});
  var s1=open.filter(function(s){return s.module==='trend'&&s.dir===mk;});
  var s2=open.filter(function(s){return s.module==='lt'&&/x(\d+(\.\d+)?)/.test(s.info[0][1])&&parseFloat(s.info[0][1].slice(1))>=2;});
  var s3=open.filter(function(s){return s.module==='pump'&&now-s.time<2*36e5;});
  var by={};open.forEach(function(s){var k=s.symbol+'|'+s.dir;(by[k]=by[k]||[]).push(s);});
  var s4=[];for(var k in by){var mods={};by[k].forEach(function(s){mods[s.module]=1;});if(Object.keys(mods).length>=2)s4=s4.concat(by[k]);}
  return [
    {n:'Piyasa Uyumlu Trend',d:'Taze TRF trendi, piyasa yönüyle (BTC+ETH) aynı yönde.',i:'fa-compass',c:'cyan',l:s1},
    {n:'Kırılım Avcısı',d:'LT üçgen kırılımı ve hacim en az 2 kat.',i:'fa-play fa-rotate-270',c:'purple',l:s2},
    {n:'Pump Takibi',d:'Son 2 saatte yakalanan hacimli alıcı baskısı.',i:'fa-rocket',c:'amber',l:s3},
    {n:'Konfluans',d:'Aynı coinde aynı yönde en az iki farklı modül sinyali.',i:'fa-bullseye',c:'emerald',l:s4}
  ];
}

/* GÖRÜNÜMLER */
function render(){
  if(!S){$('view').innerHTML='<div class="text-slate-500">Yükleniyor…</div>';return;}
  var h='<h1 class="text-xl font-bold mb-4">'+TITLES[view]+'</h1>';
  var now=Date.now();
  if(view==='home'){
    var tr=S.signals.filter(function(s){return s.module==='trend'&&isOpen(s);}).length;
    var lt=S.signals.filter(function(s){return s.module==='lt'&&now-s.time<24*36e5;}).length;
    var pm=S.signals.filter(function(s){return s.module==='pump'&&now-s.time<24*36e5;}).length;
    h+='<div class="grid gap-3 grid-cols-1 sm:grid-cols-3">'+sum('Açık Trend',tr,'fa-chart-line','cyan')+sum('LT Kırılım (24s)',lt,'fa-play fa-rotate-270','purple')+sum('Pump (24s)',pm,'fa-rocket','amber')+'</div>';
    h+='<h2 class="text-sm text-slate-400 mt-6 mb-2">Piyasa Radarı</h2>'+radarBlock(true);
    h+='<h2 class="text-sm text-slate-400 mt-6 mb-2">Hazır Stratejiler</h2><div class="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">';
    strategies().forEach(function(s){h+='<div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4 cursor-pointer hover:border-'+s.c+'-500" data-view="strat"><div class="flex items-center justify-between"><b>'+s.n+'</b><i class="fa-solid '+s.i+' text-'+s.c+'-400"></i></div><p class="text-xs text-slate-400 mt-2">'+s.d+'</p><div class="mt-3 text-2xl font-bold text-'+s.c+'-300">'+s.l.length+'</div></div>';});
    h+='</div>';
  } else if(view==='radar'){
    h+=radarBlock(false);
  } else if(view==='strat'){
    strategies().forEach(function(s){h+='<div class="mb-6"><div class="flex items-center gap-2 mb-1"><i class="fa-solid '+s.i+' text-'+s.c+'-400"></i><b>'+s.n+'</b><span class="text-xs text-slate-500">('+s.l.length+')</span></div><p class="text-xs text-slate-400 mb-2">'+s.d+'</p>'+grid(s.l,'Şu an eşleşen sinyal yok.')+'</div>';});
  } else if(view==='stats'){
    var NM={trend:'Trend',lt:'LT Üçgen',pump:'AlgoPump',scalper:'Scalper'};
    h+='<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-slate-400 text-left"><tr><th class="py-2">Modül</th><th>Toplam</th><th>Açık</th><th>Kazanç</th><th>Kayıp</th><th>Başarı</th><th>Toplam R</th></tr></thead><tbody>';
    for(var m in NM){var x=S.stats[m];h+='<tr class="border-t border-slate-800"><td class="py-2 font-medium">'+NM[m]+'</td><td>'+x.total+'</td><td>'+x.open+'</td><td class="text-emerald-400">'+x.win+'</td><td class="text-rose-400">'+x.loss+'</td><td>'+(x.winRate==null?'-':x.winRate.toFixed(0)+'%')+'</td><td class="'+pc(x.R)+'">'+sgn(x.R,1)+'R</td></tr>';}
    h+='</tbody></table></div><p class="text-xs text-slate-500 mt-3">Kazanç: TP1 görülen sinyal. Kayıp: TP1 görmeden stop olan. Fiyat takibi 15 sn aralıklı anlık fiyatla yapılır; bu yüzden gerçek sonuçlardan sapabilir.</p>';
  } else if(view==='zone'){
    h+=grid(modList('zone'),'Fiyata yakın güçlü bölge yok. Tarama bitince burada görünür.');
  } else if(view==='range'){
    h+=grid(modList('range'),'Sıkışma tespit edilen coin yok.');
  } else {
    h+=grid(modList(view,48),'Son 48 saatte bu modülden sinyal yok.');
  }
  var sc=$('view').scrollTop;$('view').innerHTML=h;$('view').scrollTop=sc;
}

/* DETAY PANELİ */
function openDetail(id){
  var s=find(id);if(!s)return;cur=id;curC=null;
  $('panel').classList.remove('translate-x-full');$('shade').classList.remove('hidden');
  renderPanel();loadCandles(true);
}
function closeDetail(){cur=null;$('panel').classList.add('translate-x-full');$('shade').classList.add('hidden');}
$('pClose').addEventListener('click',closeDetail);$('shade').addEventListener('click',closeDetail);
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDetail();});
function cell(l,v,c){return '<div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5"><div class="text-[11px] text-slate-500">'+l+'</div><div class="text-sm font-semibold '+(c||'')+'">'+v+'</div></div>';}
function renderPanel(){
  var s=find(cur);if(!s)return;var q=pnl(s);
  $('pHead').innerHTML='<div class="text-2xl font-bold">'+short(s.symbol)+'<span class="text-slate-500 text-base"> /USDT</span></div><div class="mt-1 flex items-center gap-2">'+badge(s.dir)+'<span class="text-xs text-slate-500">'+TITLES[s.module==='lt'?'lt':s.module]+' · '+s.tf+' · '+ago(s.time)+' önce</span></div>';
  var g=cell('Giriş',fp(s.entry),'text-amber-300')+cell('Mevcut Fiyat',q?fp(q.p):'-')+cell('Durum',s.status||'-',s.status==='TP1'||s.status==='TP2'?'text-emerald-400':(s.status||'').indexOf('STOP')>=0?'text-rose-400':'text-cyan-300');
  g+=cell('Stop',s.sl?fp(s.sl):'-','text-rose-400')+cell('TP1',s.tp1?fp(s.tp1):'-','text-emerald-400')+cell('TP2',s.tp2?fp(s.tp2):'-','text-emerald-400');
  g+=cell('K/Z (R)',q&&q.r!=null?sgn(q.r)+'R':'-',pc(q&&q.r))+cell('K/Z (%)',q&&q.pct!=null?sgn(q.pct)+'%':'-',pc(q&&q.pct));
  $('pGrid').innerHTML=g;
  var inf=(s.info||[]).map(function(x){return '<span class="px-2 py-1 rounded bg-slate-800 text-xs text-slate-300">'+x[0]+': <b>'+x[1]+'</b></span>';}).join('');
  $('pInfo').innerHTML=inf;
  paint();
}
function loadCandles(force){
  var s=find(cur);if(!s)return;
  if(!force&&Date.now()-lastCF<30000)return;
  lastCF=Date.now();
  fetch('/api/candles?symbol='+encodeURIComponent(s.symbol)+'&tf='+(s.tf||'15m')).then(function(r){return r.json();}).then(function(d){if(d&&d.candles){curC=d;paint();}}).catch(function(){});
}
function paint(){var s=find(cur);if(!s||!curC)return;drawChart($('cv'),curC,s);}

/* CANVAS GRAFİK */
function drawChart(cv,D,sig){
  var dpr=window.devicePixelRatio||1,W=cv.clientWidth,H=cv.clientHeight;
  if(!W||!H)return;
  cv.width=W*dpr;cv.height=H*dpr;
  var g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle='#020617';g.fillRect(0,0,W,H);
  var cs=D.candles,n=cs.length,show=Math.min(n,110),off=n-show;
  var padR=74,padT=8,padB=22,plotW=W-padR,plotH=H-padT-padB;
  var dt=cs.length>1?cs[1].t-cs[0].t:60000;
  function idx(t){return (t-cs[0].t)/dt;}
  var price=S.prices[sig.symbol];
  var lo=Infinity,hi=-Infinity,i;
  for(i=off;i<n;i++){if(cs[i].l<lo)lo=cs[i].l;if(cs[i].h>hi)hi=cs[i].h;}
  var lv=[];
  if(sig.entry)lv.push({p:sig.entry,c:'#facc15',l:'Giriş',d:false});
  if(sig.sl)lv.push({p:sig.sl,c:'#ef4444',l:'Stop',d:false});
  if(sig.tp1)lv.push({p:sig.tp1,c:'#22c55e',l:'TP1',d:true});
  if(sig.tp2)lv.push({p:sig.tp2,c:'#16a34a',l:'TP2',d:true});
  (sig.levels||[]).forEach(function(x){lv.push({p:x.p,c:x.color,l:x.label,d:true});});
  lv.forEach(function(x){if(x.p<lo)lo=x.p;if(x.p>hi)hi=x.p;});
  var mg=(hi-lo)*0.05||hi*0.01;lo-=mg;hi+=mg;
  var cw=plotW/(show+4);
  function X(k){return (k-off)*cw+cw/2;}
  function Y(p){return padT+(hi-p)/(hi-lo)*plotH;}
  g.font='11px ui-sans-serif,system-ui';g.textBaseline='middle';
  for(i=0;i<=5;i++){var pv=lo+(hi-lo)*i/5,y=Y(pv);g.strokeStyle='#0f172a';g.lineWidth=1;g.beginPath();g.moveTo(0,y);g.lineTo(plotW,y);g.stroke();g.fillStyle='#64748b';g.textAlign='left';g.fillText(fp(pv),plotW+6,y);}
  g.textAlign='center';g.textBaseline='top';g.fillStyle='#475569';
  for(i=off;i<n;i+=Math.ceil(show/5)){var d=new Date(cs[i].t);g.fillText(('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2),X(i),H-padB+6);}
  g.textBaseline='middle';
  for(i=off;i<n;i++){
    var c=cs[i],up=c.c>=c.o,x=X(i);
    g.strokeStyle=up?'#10b981':'#f43f5e';g.fillStyle=up?'#10b981':'#f43f5e';g.lineWidth=1;
    g.beginPath();g.moveTo(x,Y(c.h));g.lineTo(x,Y(c.l));g.stroke();
    var y1=Y(Math.max(c.o,c.c)),y2=Y(Math.min(c.o,c.c));
    g.fillRect(x-cw*0.35,y1,cw*0.7,Math.max(1,y2-y1));
  }
  function line(arr,color){g.strokeStyle=color;g.lineWidth=1.4;g.beginPath();for(var k=off;k<n;k++){var x=X(k),y=Y(arr[k]);if(k===off)g.moveTo(x,y);else g.lineTo(x,y);}g.stroke();}
  line(D.ema21,'#06b6d4');line(D.ema50,'#a855f7');
  (sig.lines||[]).forEach(function(l){
    var i1=idx(l.t1),i2=idx(l.t2);
    g.strokeStyle=l.k==='res'?'#f43f5e':'#10b981';g.lineWidth=2;g.setLineDash([]);
    g.beginPath();g.moveTo(X(i1),Y(l.p1));g.lineTo(X(i2+3),Y(l.p2+(l.p2-l.p1)/(i2-i1)*3));g.stroke();
  });
  lv.forEach(function(x){
    var y=Y(x.p);g.strokeStyle=x.c;g.lineWidth=1.3;g.setLineDash(x.d?[6,4]:[]);
    g.beginPath();g.moveTo(0,y);g.lineTo(plotW,y);g.stroke();g.setLineDash([]);
    g.fillStyle=x.c;g.fillRect(plotW,y-8,padR-2,16);g.fillStyle='#020617';g.textAlign='left';g.font='bold 10px ui-sans-serif,system-ui';
    g.fillText(x.l+' '+fp(x.p),plotW+3,y);
  });
  if(price){
    var yp=Y(price);g.strokeStyle='#e2e8f0';g.setLineDash([2,3]);g.lineWidth=1;g.beginPath();g.moveTo(0,yp);g.lineTo(plotW,yp);g.stroke();g.setLineDash([]);
    g.fillStyle='#e2e8f0';g.fillRect(plotW,yp-8,padR-2,16);g.fillStyle='#020617';g.font='bold 10px ui-sans-serif,system-ui';g.textAlign='left';g.fillText(fp(price),plotW+3,yp);
  }
  var q=pnl(sig);
  var L=sig.dir==='LONG',N=sig.dir==='NÖTR';
  g.textAlign='left';g.textBaseline='top';
  g.font='bold 34px ui-sans-serif,system-ui';
  g.fillStyle=N?'#94a3b8':L?'rgba(16,185,129,.9)':'rgba(244,63,94,.9)';
  g.fillText(N?'● NÖTR':L?'▲ LONG':'▼ SHORT',12,12);
  if(q&&q.pct!=null){g.font='bold 22px ui-sans-serif,system-ui';g.fillStyle=q.pct>=0?'#34d399':'#fb7185';g.fillText(sgn(q.pct)+'%'+(q.r!=null?'  ('+sgn(q.r)+'R)':''),14,52);}
  g.font='11px ui-sans-serif,system-ui';g.fillStyle='#06b6d4';g.fillText('EMA 21',14,H-padB-34);g.fillStyle='#a855f7';g.fillText('EMA 50',64,H-padB-34);
}
window.addEventListener('resize',paint);

/* DÖNGÜ */
function refresh(){
  fetch('/api/state').then(function(r){return r.json();}).then(function(d){
    S=d;renderTop();render();if(cur){renderPanel();loadCandles(false);}
  }).catch(function(){});
}
buildNav();setView('home');refresh();setInterval(refresh,10000);
</script>
</body>
</html>`;
