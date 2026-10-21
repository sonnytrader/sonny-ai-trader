'use strict';
/* ═══════════════════════════════════════════════════════════════════
   AlphaSon v63.0 — PARÇA 1: BACKEND (tek dosya)
   Bitget USDT-M futures • 6 sinyal modülü • Paper oto-trade • Backtest
   Gerekli paketler: npm i express ccxt     (Node 18+)
   Frontend: server.js ile aynı klasöre index.html (Parça 2)
   ═══════════════════════════════════════════════════════════════════ */
const VERSION = 'v63.0';
const fs = require('fs');
const path = require('path');
const express = require('express');
const ccxt = require('ccxt');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const F_SIG = path.join(DATA_DIR, 'signals.json');
const F_PAPER = path.join(DATA_DIR, 'paper.json');
const F_SET = path.join(DATA_DIR, 'settings.json');

/* ───────── SABİTLER ───────── */
const COST_PCT = 0.17;      // gidiş-dönüş maliyet (komisyon %0.12 + slippage %0.05) — Net R için
const FEE_SIDE = 0.0006;    // taker komisyonu (taraf başına)
const PAPER_SLIP = 0.0005;  // paper girişinde kötü yönde slippage
const GLOBAL_MAX = 14;
const COOL_DIR_MS = 15 * 60000;
const PAPER_MAX_OPEN = 2;
const PAPER_SECTOR_LIM = 2;
const DAILY_LOSS_LIM = 0.05;
const START_BALANCE = 1000;
const M1 = 60000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend',       max: 3, quota: 2,    maxAge: 72 * H1,  cooldown: 6 * H1,  chartTf: '1h' },
  SCALPER: { label: 'Scalper',     max: 99, quota: null,    maxAge: 90 * M1,  cooldown: 45 * M1, chartTf: '5m' },
  LT:      { label: 'LT Üçgen',    max: 3, quota: null, maxAge: 5 * D1,   cooldown: 24 * H1, chartTf: '4h' },
  ZONE:    { label: 'Zone Master', max: 4, quota: null, maxAge: 12 * H1,  cooldown: 2 * H1,  chartTf: '1h' },
  RANGE:   { label: 'Range Pro',   max: 4, quota: null, maxAge: 6 * H1,   cooldown: H1,      chartTf: '15m' },
  PUMP:    { label: 'AlgoPump',    max: 6, quota: null, maxAge: 20 * M1,  cooldown: 30 * M1, chartTf: '1m' }
};
const REASON = { TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'TP1 sonrası başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel kapatma', TREND_BITTI: 'Trend bitti' };

const PUMP = { move5: 1.6, move15: 3.0, volMult: 3, thrust: 2.5 };

/* ───────── SEKTÖRLER ───────── */
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
const secLimSig = sec => (sec === 'DİĞER' ? 6 : 3);
const secLimPaper = sec => (sec === 'DİĞER' ? 3 : PAPER_SECTOR_LIM);

/* ───────── YARDIMCILAR ───────── */
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

/* ───────── İNDİKATÖRLER ───────── */
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
function pivots(cs, L, R) {
  const hi = [], lo = [];
  for (let i = L; i < cs.length - R; i++) {
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

/* ───────── ORTAK İŞLEM MANTIĞI (canlı + backtest) ───────── */
// t: {dir, entry, sl, curSl, tp1, tp2, single, tp1Hit, tp1Ts}
function stepTrade(t, c) {
  const L = t.dir === 'LONG';
  if (!(t.tp1Hit && c.t <= t.tp1Ts)) {
    const slHit = L ? c.l <= t.curSl : c.h >= t.curSl;      // KÖTÜMSER: SL önce
    if (slHit) return { done: true, price: t.curSl, reason: t.tp1Hit ? 'BE' : 'SL' };
  }
  if (!t.tp1Hit) {
    if (L ? c.h >= t.tp1 : c.l <= t.tp1) {
      if (t.single || !t.tp2) return { done: true, price: t.tp1, reason: 'TP1' };
      t.tp1Hit = true; t.tp1Ts = c.t; t.curSl = t.entry;
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
  return { gross, net: gross - (t.entry * COST_PCT / 100) / risk };
}

/* ───────── DEDEKTÖRLER (saf fonksiyonlar) ───────── */
function detectPump(c1, why) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = c1.length;
  if (n < 60) return null;
  const last = c1[n - 1], price = last.c;
  const o5 = c1[n - 5].o, o15 = c1[n - 15].o;
  const move5 = (price / o5 - 1) * 100, move15 = (price / o15 - 1) * 100;
  let dir = null;
  if (move5 >= PUMP.move5) dir = 'LONG';
  else if (move5 <= -PUMP.move5) dir = 'SHORT';
  else if (move15 >= PUMP.move15 && move5 >= 1.0) dir = 'LONG';
  else if (move15 <= -PUMP.move15 && move5 <= -1.0) dir = 'SHORT';
  if (!dir) return no('hareket küçük');
  if (Math.abs(move15) > 15) return no('aşırı uzamış');
  const d = dir === 'LONG' ? 1 : -1;
  const v3 = (c1[n - 1].v + c1[n - 2].v + c1[n - 3].v) / 3;
  let base = 0;
  for (let i = n - 33; i < n - 3; i++) base += c1[i].v;
  base /= 30;
  if (!(base > 0)) return no('hacim verisi yok');
  const volRatio = v3 / base;
  if (volRatio < PUMP.volMult) return no('hacim zayıf');
  let dirCnt = 0;
  for (let i = n - 5; i < n; i++) if ((c1[i].c - c1[i].o) * d > 0) dirCnt++;
  if (dirCnt < 3) return no('mum yönü zayıf');
  const atr1 = atrLast(c1.slice(0, n - 5), 14);
  const moveAbs = Math.abs(price - o5);
  if (!atr1 || moveAbs / atr1 < PUMP.thrust) return no('itme zayıf (sahte)');
  const ext3 = dir === 'LONG' ? Math.max(c1[n - 3].h, c1[n - 2].h, c1[n - 1].h) : Math.min(c1[n - 3].l, c1[n - 2].l, c1[n - 1].l);
  if (Math.abs(ext3 - price) < Math.max(0.3 * atr1, 0.1 * moveAbs)) return no('zirve/dip yakını');
  const body = Math.abs(last.c - last.o);
  const adverse = dir === 'LONG' ? last.h - Math.max(last.o, last.c) : Math.min(last.o, last.c) - last.l;
  if (adverse > 2 * Math.max(body, price * 0.0005)) return no('fitil tuzağı');
  if (body / moveAbs > 0.5) return no('tek mumda hareket');
  const a5 = atrLast(aggTF(c1, 5), 14);
  const atr5p = a5 ? a5 / price * 100 : 0.8;
  const rsi = rsiLast(closes(c1.slice(-60)), 14);
  const tpPct = Math.max(0.6, 0.6 * atr5p);
  const slPct = clamp(1.1 * atr5p, 0.7, 1.8);
  let conf = 58 + clamp((volRatio - PUMP.volMult) * 1.5, 0, 15) + clamp((Math.abs(move5) - PUMP.move5) * 5, 0, 15)
    + (dirCnt >= 5 ? 6 : dirCnt >= 4 ? 3 : 0) + clamp((moveAbs / atr1 - 3) * 1.5, 0, 6);
  if (rsi != null && ((dir === 'LONG' && rsi > 88) || (dir === 'SHORT' && rsi < 12))) conf -= 15;
  return {
    dir, entry: rp(price), sl: rp(price * (1 - d * slPct / 100)), tp1: rp(price * (1 + d * tpPct / 100)), tp2: rp(price * (1 + d * tpPct * 2 / 100)), single: false,
    conf: clamp(Math.round(conf), 40, 95),
    info: { move5: +move5.toFixed(2), move15: +move15.toFixed(2), volRatio: +volRatio.toFixed(1), rsi: rsi != null ? +rsi.toFixed(0) : null, atr5Pct: +atr5p.toFixed(2), tpPct: +tpPct.toFixed(2), slPct: +slPct.toFixed(2), dirCandles: dirCnt, atr: a5 || null }
  };
}

function detectScalper(cs, why) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 60) return null;
  const last = cs[n - 1];
  const prev = cs.slice(n - 21, n - 1);
  const hi = Math.max.apply(null, prev.map(c => c.h)), lo = Math.min.apply(null, prev.map(c => c.l));
  const vSma = avg(prev.map(c => c.v));
  if (!(vSma > 0)) return no('hacim verisi yok');
  const vr = last.v / vSma;
  let dir = null;
  if (last.c > hi && last.c > last.o) dir = 'LONG';
  else if (last.c < lo && last.c < last.o) dir = 'SHORT';
  if (!dir) return no('kırılım yok');
  if (vr < 1.3) return no('hacim zayıf');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c, d = dir === 'LONG' ? 1 : -1, rng = last.h - last.l;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  if (dir === 'LONG' ? !(e20[n - 1] > e50[n - 1]) : !(e20[n - 1] < e50[n - 1])) return no('5m trend uyumsuz');
  const rsi = rsiLast(cl, 14);
  const e12 = emaArr(cl, 12), e26 = emaArr(cl, 26), line = e12.map((x, i) => x - e26[i]), sg = emaArr(line, 9);
  const hist = line[n - 1] - sg[n - 1];
  const mom = dir === 'LONG' ? (rsi > 50 && hist > 0) : (rsi < 50 && hist < 0);
  const closePos = rng > 0 ? (dir === 'LONG' ? e - last.l : last.h - e) / rng : 0.5;
  const risk = Math.max(1.2 * atr, e * 0.006);      // maliyet R'yi yemesin: min %0.6 risk mesafesi
  const conf = 55 + (mom ? 10 : 0) + clamp((vr - 1.3) * 5, 0, 10) + (closePos > 0.8 ? 5 : 0) - (rng > 2.5 * atr ? 10 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(e + d * 0.9 * risk), tp2: rp(e + d * 2 * risk), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { volRatio: +vr.toFixed(1), rsi: rsi != null ? +rsi.toFixed(0) : null, momentum: mom, atr, breakLevel: dir === 'LONG' ? rp(hi) : rp(lo), riskPct: +(risk / e * 100).toFixed(2) }
  };
}

function trendReversed(cs, dir) {
  if (!cs || cs.length < 60) return false;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cs.length - 1;
  return dir === 'LONG' ? e20[m] < e50[m] * 0.9995 : e20[m] > e50[m] * 1.0005;
}
function detectTrend(cs, cs4) {
  const n = cs.length;
  if (n < 220) return null;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), e200 = emaArr(cl, 200), m = n - 1, last = cs[m];
  const adx = adxLast(cs, 14), atr = atrLast(cs, 14);
  if (adx == null || adx < 20 || !atr) return null;
  let dir = null, how = '';
  const up = e20[m] > e50[m] && e50[m] > e200[m] && cl[m] > e50[m];
  const dn = e20[m] < e50[m] && e50[m] < e200[m] && cl[m] < e50[m];
  if (up || dn) {      // oturmuş trendde EMA20 geri çekilmesinden dönüş
    const touch = up ? Math.min(cs[m].l, cs[m - 1].l) <= e20[m] + 0.25 * atr : Math.max(cs[m].h, cs[m - 1].h) >= e20[m] - 0.25 * atr;
    const bounce = up ? (last.c > last.o && last.c > e20[m]) : (last.c < last.o && last.c < e20[m]);
    if (touch && bounce) { dir = up ? 'LONG' : 'SHORT'; how = 'pullback'; }
  }
  if (!dir) {          // taze EMA20/50 kesişimi (son 6 mum)
    for (let k = m - 6; k <= m - 1; k++) {
      if (e20[k - 1] <= e50[k - 1] && e20[k] > e50[k] && e20[m] > e50[m] && cl[m] > e200[m]) { dir = 'LONG'; how = 'kesişim'; break; }
      if (e20[k - 1] >= e50[k - 1] && e20[k] < e50[k] && e20[m] < e50[m] && cl[m] < e200[m]) { dir = 'SHORT'; how = 'kesişim'; break; }
    }
  }
  if (!dir) return null;
  if (Math.abs(cl[m] - e50[m]) > 4 * atr) return null;    // aşırı uzamışken kovalama
  const vSma = avg(cs.slice(m - 20, m).map(c => c.v));
  let conf = 55 + clamp((adx - 20) * 0.8, 0, 15) + (how === 'pullback' ? 5 : 0) + (vSma > 0 && Math.max(cs[m].v, cs[m - 1].v) / vSma >= 1.2 ? 5 : 0);
  if (cs4 && cs4.length >= 60) {     // 4H teyit: engel değil, güven puanı
    const e = emaArr(closes(cs4), 50), sl4 = e[e.length - 1] - e[e.length - 4];
    conf += (dir === 'LONG' ? sl4 > 0 : sl4 < 0) ? 8 : -8;
  }
  const d = dir === 'LONG' ? 1 : -1, e = cl[m];
  const recent = cs.slice(m - 9, m + 1);
  const swing = dir === 'LONG' ? Math.min.apply(null, recent.map(c => c.l)) : Math.max.apply(null, recent.map(c => c.h));
  const slDist = Math.max(atr, Math.min(1.8 * atr, Math.abs(e - swing)));
  return {
    dir, entry: rp(e), sl: rp(e - d * slDist), tp1: rp(e + d * 2 * atr), tp2: rp(e + d * 4 * atr), single: false,
    conf: clamp(Math.round(conf), 40, 92),
    info: { adx: +adx.toFixed(1), setup: how, ema20: rp(e20[m]), ema50: rp(e50[m]), ema200: rp(e200[m]), atr, h4Confirm: !!cs4 }
  };
}

function anchorLine(pts, up) {
  if (pts.length < 2) return null;
  const order = pts.slice().sort((x, y) => (up ? y.p - x.p : x.p - y.p));   // en tepe / en dip önce
  for (const a of order.slice(0, 4)) {                                      // çizgi çıkmazsa sıradaki uç noktayı dene
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
  if (Lc.sl <= Uc.sl) return null;                                       // yakınsama yok
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
  if (Math.abs(e - sl) < e * 0.005 || (e - sl) * d <= 0) sl = e - d * e * 0.005;
  let conf = 55 + clamp((vr - 1.2) * 8, 0, 15) + (A.mat >= 0.6 && A.mat <= 0.9 ? 8 : 0) + clamp((0.75 - A.comp) * 25, 0, 8);
  let d1 = null;
  if (cs1d && cs1d.length >= 30) {
    const ec = emaArr(closes(cs1d), 20), s1 = ec[ec.length - 1] - ec[ec.length - 4];
    d1 = (dir === 'LONG' && s1 > 0) || (dir === 'SHORT' && s1 < 0);
    conf += d1 ? 8 : -8;
  }
  return {
    signal: {
      dir, entry: rp(e), sl: rp(sl), tp1: rp(e + d * 0.6 * H), tp2: rp(e + d * H), single: false, conf: clamp(Math.round(conf), 40, 92),
      info: { compression: +A.comp.toFixed(2), maturity: +A.mat.toFixed(2), volRatio: +vr.toFixed(1), height: rp(H), d1Confirm: d1, atr: atrLast(w, 14), lines }
    }
  };
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
  const body = Math.abs(last.c - last.o), upW = last.h - Math.max(last.o, last.c), loW = Math.min(last.o, last.c) - last.l;
  let best = null;
  for (const z of zones) {
    const dist = px >= z.lo && px <= z.hi ? 0 : Math.min(Math.abs(px - z.hi), Math.abs(px - z.lo)) / px * 100;
    if (dist < 1.2) out.watch.push({ lo: rp(z.lo), hi: rp(z.hi), mid: rp(z.mid), score: +z.score.toFixed(1), touches: z.touches, dist: +dist.toFixed(2), side: z.mid < px ? 'DESTEK' : 'DİRENÇ', price: rp(px) });
    if (z.score < 6) continue;
    let dir = null;
    if (prev.c > z.lo && last.l <= z.hi * 1.002 && last.l >= z.lo * 0.99 && last.c > last.o && last.c > z.mid && loW >= body) dir = 'LONG';
    else if (prev.c < z.hi && last.h >= z.lo * 0.998 && last.h <= z.hi * 1.01 && last.c < last.o && last.c < z.mid && upW >= body) dir = 'SHORT';
    if (dir && (!best || z.score > best.z.score)) best = { z, dir };
  }
  if (best) {
    const { z, dir } = best, d = dir === 'LONG' ? 1 : -1, e = px;
    let sl = dir === 'LONG' ? z.lo - 0.3 * atr : z.hi + 0.3 * atr;
    let R = Math.abs(e - sl);
    if (R < e * 0.004) { sl = e - d * e * 0.004; R = e * 0.004; }
    if (R <= e * 0.05) {
      const opp = zones.filter(o => (dir === 'LONG' ? o.lo > e * 1.003 : o.hi < e * 0.997)).sort((a, b) => (dir === 'LONG' ? a.lo - b.lo : b.hi - a.hi))[0];
      let tp1 = e + d * 1.5 * R;
      if (opp) { const c = dir === 'LONG' ? opp.lo * 0.998 : opp.hi * 1.002; const dd = Math.abs(c - e); if (dd >= R && dd <= 4 * R) tp1 = c; }
      let tp2 = e + d * 2.5 * R;
      if ((tp2 - tp1) * d <= 0) tp2 = tp1 + d * R;
      const wick = dir === 'LONG' ? loW : upW;
      const conf = 52 + Math.min(22, (z.score - 6) * 3) + Math.min(8, wick / Math.max(body, 1e-12) * 2);
      out.signal = { dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 92), info: { zoneLo: rp(z.lo), zoneHi: rp(z.hi), zoneScore: +z.score.toFixed(1), touches: z.touches, atr } };
    }
  }
  return out;
}

function detectRange(cs) {
  const n = cs.length;
  if (n < 120) return {};
  const cl = closes(cs), bbw = bbwArr(cl, 20), atrV = atrLast(cs, 14);
  if (!atrV) return {};
  const rk = idx => {
    let cnt = 0, tot = 0;
    for (let i = idx - 99; i <= idx; i++) { const v = bbw[i]; if (v == null) continue; tot++; if (v <= bbw[idx]) cnt++; }
    return tot >= 60 ? cnt / tot : 1;
  };
  const last = cs[n - 1], win = cs.slice(n - 21, n - 1);
  const hi = Math.max.apply(null, win.map(c => c.h)), lo = Math.min.apply(null, win.map(c => c.l));
  const W = hi - lo, mid = (hi + lo) / 2, rkP = rk(n - 2);
  const vSma = avg(win.map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0;
  if (rkP <= 0.30 && W / mid < 0.05 && vr >= 1.3 && (last.c > hi || last.c < lo)) {
    const dir = last.c > hi ? 'LONG' : 'SHORT', d = dir === 'LONG' ? 1 : -1, e = last.c;
    let sl = mid;
    if ((e - sl) * d < 0.005 * e) sl = e - d * 0.005 * e;      // min %0.5 risk (maliyet R'yi yemesin)
    const R = Math.abs(e - sl);
    const conf = 52 + clamp((vr - 1.3) * 6, 0, 12) + clamp((0.3 - rkP) * 40, 0, 12);
    return { signal: { dir, entry: rp(e), sl: rp(sl), tp1: rp(e + d * Math.max(W, R)), tp2: rp(e + d * Math.max(1.8 * W, 2 * R)), single: false, conf: clamp(Math.round(conf), 40, 90), info: { rangeHi: rp(hi), rangeLo: rp(lo), volRatio: +vr.toFixed(1), bbwRank: +rkP.toFixed(2), atr: atrV } } };
  }
  const w2 = cs.slice(n - 20), hi2 = Math.max.apply(null, w2.map(c => c.h)), lo2 = Math.min.apply(null, w2.map(c => c.l)), mid2 = (hi2 + lo2) / 2;
  const rk2 = rk(n - 1), px = last.c;
  if (rk2 <= 0.35 && (hi2 - lo2) / mid2 < 0.05) {
    const dHi = (hi2 / px - 1) * 100, dLo = (px / lo2 - 1) * 100;
    if (Math.min(Math.abs(dHi), Math.abs(dLo)) < 0.6)
      return { watch: { rangeHi: rp(hi2), rangeLo: rp(lo2), price: rp(px), distHi: +dHi.toFixed(2), distLo: +dLo.toFixed(2), nearSide: Math.abs(dHi) < Math.abs(dLo) ? 'ÜST' : 'ALT', squeezeScore: Math.round(100 * (1 - rk2)), width: +((hi2 - lo2) / mid2 * 100).toFixed(2) } };
  }
  return {};
}

/* ───────── DURUM ───────── */
let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE };
const DEF_SET = { auto: false, margin: 100, leverage: 5, minConf: 60, maxMinutes: 20 };
let settings = Object.assign({}, DEF_SET);
const market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, b1h: 0.5, b4h: 0.5, btc: null, eth: null, lastDirChange: 0, lastDirective: null, btcDir: null, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [] };
const BLK = {};
const PWHY = {};
const SWHY = {};
const SC = {};
const sc = (m, k) => { const o = SC[m] || (SC[m] = {}); o[k] = (o[k] || 0) + 1; };
const blockLog = {};
const stats = { apiErr: 0, pumpScanned: 0, pumpFound: 0, tickAt: 0 };
let dirty = false;
let ALL = [], TOP = [];
const TICK = {};
const HIST = {};
const CACHE = new Map();
const jobs = {};
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap', defaultSubType: 'linear' } });

function sanitizeSettings(s) {
  const o = Object.assign({}, DEF_SET, s || {});
  o.auto = !!o.auto;
  o.margin = clamp(Number(o.margin) || DEF_SET.margin, 10, 100000);
  o.leverage = clamp(Math.round(Number(o.leverage) || DEF_SET.leverage), 1, 20);
  o.minConf = clamp(Math.round(Number(o.minConf) || DEF_SET.minConf), 40, 95);
  o.maxMinutes = clamp(Math.round(Number(o.maxMinutes) || DEF_SET.maxMinutes), 3, 120);
  return o;
}
function loadAll() {
  const s = loadJSON(F_SIG, { seq: 0, list: [] });
  signals = Array.isArray(s.list) ? s.list : [];
  sigSeq = Number(s.seq) || signals.length;
  const p = loadJSON(F_PAPER, null);
  if (p && Array.isArray(p.open) && Array.isArray(p.closed)) paper = Object.assign(paper, p);
  settings = sanitizeSettings(loadJSON(F_SET, {}));
  log('Veriler yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık paper, oto-trade ' + (settings.auto ? 'AÇIK' : 'KAPALI'));
}
function saveAll() {
  if (!dirty) return;
  dirty = false;
  const act = signals.filter(s => s.status === 'AKTIF');
  const cl = signals.filter(s => s.status !== 'AKTIF').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 600);
  signals = act.concat(cl).sort((a, b) => a.createdAt - b.createdAt);
  saveJSON(F_SIG, { seq: sigSeq, list: signals });
  paper.closed = paper.closed.slice(0, 300);
  saveJSON(F_PAPER, paper);
}
function saveSettings() { saveJSON(F_SET, settings); }

/* ───────── VERİ KATMANI ───────── */
const priceOf = sym => (TICK[sym] && TICK[sym].last ? TICK[sym].last : null);
async function refreshTickers() {
  const t = await ex.fetchTickers();
  for (const k in t) { const x = t[k]; if (x && x.last && k.endsWith('/USDT:USDT')) TICK[k] = x; }
  stats.tickAt = Date.now();
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
    for (let g = 0; g < 13 && out.length < total; g++) {
      const b = await ex.fetchOHLCV(sym, tf, since, 200);
      if (!b || !b.length) break;
      out = out.concat(b);
      const lastT = b[b.length - 1][0];
      if (lastT + ms >= Date.now() || b.length < 2) break;
      since = lastT + ms;
    }
  } catch (e) { /* kısmi veri ile devam */ }
  if (out.length < 50) { try { out = await ex.fetchOHLCV(sym, tf, undefined, 500); } catch (e) { return []; } }
  const seen = new Set(), res = [];
  for (const a of out) { if (!seen.has(a[0])) { seen.add(a[0]); res.push(toC(a)); } }
  res.sort((a, b) => a.t - b.t);
  return res;
}
async function refreshUniverse() {
  await refreshTickers();
  const list = [];
  for (const k in ex.markets) {
    const m = ex.markets[k];
    if (m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false && TICK[m.symbol]) list.push(m.symbol);
  }
  list.sort((a, b) => (TICK[b].quoteVolume || 0) - (TICK[a].quoteVolume || 0));
  ALL = list;
  TOP = list.slice(0, 120);
  log('Evren güncellendi: ' + ALL.length + ' sözleşme, en likit ' + TOP.length + ' taranıyor');
}

/* ───────── SİNYAL YÖNETİCİSİ ───────── */
const effDir = () => (market.dir !== 'NOTR' ? market.dir : market.btcDir);
function blocked(mod, sym, reason, silent) {
  BLK[reason] = (BLK[reason] || 0) + 1;
  if (silent) return false;
  const k = mod + '|' + reason, t = Date.now();
  if (!blockLog[k] || t - blockLog[k] > 120000) { blockLog[k] = t; log('ENGEL: ' + MODS[mod].label + ' ' + baseOf(sym) + ' → ' + reason); }
  return false;
}
function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = baseOf(sym);
  const act = signals.filter(s => s.status === 'AKTIF');
  if (signals.some(s => s.module === mod && s.symbol === sym && t - s.createdAt < M.cooldown)) return false;
  if (act.filter(s => s.module === mod).length >= M.max) return blocked(mod, sym, 'modül dolu');
  if (mod !== 'SCALPER' && act.filter(s => s.module !== 'SCALPER').length >= GLOBAL_MAX) return blocked(mod, sym, 'global limit');
  if (act.some(s => s.symbol === sym && s.dir !== dir)) return blocked(mod, sym, 'zıt yönlü aktif sinyal var');
  if (M.quota && signals.filter(s => s.module === mod && s.createdAt >= dayStartMs()).length >= M.quota) return blocked(mod, sym, 'günlük kota doldu');
  if (mod === 'PUMP') {
    if (signals.filter(s => s.module === 'PUMP' && s.dir === dir && t - s.createdAt < 5 * M1).length >= 3) return blocked(mod, sym, 'toplu tetikleme (pump)');
  } else {
    if (mod !== 'SCALPER') {
      if (signals.filter(s => s.module !== 'PUMP' && s.module !== 'SCALPER' && s.dir === dir && t - s.createdAt < 10 * M1).length >= 4) return blocked(mod, sym, 'toplu tetikleme');
      if (t - market.lastDirChange < COOL_DIR_MS) return blocked(mod, sym, 'piyasa yönü değişti, soğuma');
    }
  }
  let counter = false, conf = raw.conf;
  const eff = effDir();
  if (!eff) return blocked(mod, sym, 'piyasa/BTC yönü belirsiz');
  if (dir !== eff) return blocked(mod, sym, (market.dir !== 'NOTR' ? 'genel piyasa yönüne ters (' : 'piyasa NÖTR, BTC 1h yönüne ters (') + eff + ')');
  const sec = sectorOf(base);
  if (mod !== 'SCALPER' && act.filter(s => s.sector === sec && s.module !== 'SCALPER').length >= secLimSig(sec)) return blocked(mod, sym, 'sektör limiti (' + sec + ')');
  const same = act.filter(s => s.symbol === sym && s.dir === dir && s.module !== mod);
  const bonus = Math.min(25, same.length * 12);
  const sig = {
    id: 'S' + (++sigSeq), module: mod, symbol: sym, base, sector: sec, dir,
    entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single, tp1Hit: false,
    baseConf: raw.conf, confBonus: bonus, conf: clamp(Math.round(conf + bonus), 30, 99), counter,
    confl: same.map(s => s.module), info: raw.info || {}, status: 'AKTIF', result: null,
    createdAt: t, maxAgeMs: M.maxAge, lastTs: 0
  };
  same.forEach(s => {
    if (!s.confl.includes(mod)) {
      s.confl.push(mod);
      s.confBonus = Math.min(25, (s.confBonus || 0) + 12);
      s.conf = clamp(Math.round(s.baseConf + s.confBonus - (s.counter ? 15 : 0)), 30, 99);
    }
  });
  signals.push(sig);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + base + ' | ' + dir + ' | güven ' + sig.conf + (counter ? ' | COUNTER' : '') + (same.length ? ' | konfluans x' + (same.length + 1) : ''));
  if (mod === 'PUMP') stats.pumpFound++;
  if (mod === 'PUMP') maybeOpenPaper(sig);
  return true;
}
function emit(mod, sym, det, last, tfMs, maxLag) {
  sc(mod, 'aday');
  if (Date.now() - (last.t + tfMs) > maxLag) { sc(mod, 'mum eski'); return false; }
  const px = priceOf(sym), atr = det.info && det.info.atr;
  if (px && atr && Math.abs(px - det.entry) > 0.6 * atr) { sc(mod, 'fiyat uzaklaştı'); return false; }
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

/* ───────── PAPER ENGINE ───────── */
function paperPnl(p, price) {
  const d = p.dir === 'LONG' ? 1 : -1;
  const part = p.tp1Hit && !p.single ? 0.5 * (p.tp1 / p.entry - 1) + 0.5 * (price / p.entry - 1) : price / p.entry - 1;
  let pnl = p.notional * part * d - p.notional * FEE_SIDE * 2;
  if (pnl < -p.margin) pnl = -p.margin;     // likidasyon üst sınırı
  return { pnl, pct: pnl / p.margin * 100 };
}
function checkDailyLoss() {
  const key = new Date().toISOString().slice(0, 10);
  if (paper.dayKey !== key) { paper.dayKey = key; paper.dayStart = paper.balance; dirty = true; }
  if (settings.auto && paper.balance <= paper.dayStart * (1 - DAILY_LOSS_LIM)) {
    settings.auto = false; saveSettings();
    log('PAPER: Günlük zarar limiti (%' + DAILY_LOSS_LIM * 100 + ') aşıldı, OTO-TRADE otomatik KAPATILDI');
  }
}
function maybeOpenPaper(sig) {
  if (!settings.auto) return;
  checkDailyLoss();
  if (!settings.auto) return;
  if (sig.conf < settings.minConf) return;
  if (paper.open.some(p => p.symbol === sig.symbol)) return;
  if (paper.open.length >= PAPER_MAX_OPEN) { log('PAPER ENGEL: ' + sig.base + ' → max açık paper limiti'); return; }
  if (paper.open.filter(p => p.sector === sig.sector).length >= secLimPaper(sig.sector)) { log('PAPER ENGEL: ' + sig.base + ' → sektör limiti (' + sig.sector + ')'); return; }
  const margin = Math.min(settings.margin, paper.balance);
  if (margin < 10) { log('PAPER ENGEL: bakiye yetersiz'); return; }
  const d = sig.dir === 'LONG' ? 1 : -1;
  const entry = sig.entry * (1 + d * PAPER_SLIP);
  const p = {
    id: 'P' + (++paper.seq), sigId: sig.id, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir,
    entry: rp(entry), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: false, tp1Hit: false,
    margin, leverage: settings.leverage, notional: margin * settings.leverage, conf: sig.conf, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
  };
  paper.open.push(p); dirty = true;
  log('PAPER AÇILDI: ' + p.base + ' ' + p.dir + ' | giriş ' + fmtP(p.entry) + ' | boyut ' + p.margin.toFixed(0) + ' USDT | ' + p.leverage + 'x');
}
function closePaper(p, price, reason) {
  if (p.status === 'KAPALI') return;
  const r = paperPnl(p, price);
  p.status = 'KAPALI'; p.result = reason; p.exit = rp(price); p.closedAt = Date.now();
  p.pnl = +r.pnl.toFixed(3); p.pnlPct = +r.pct.toFixed(2); p.durationMs = p.closedAt - p.openedAt;
  paper.balance += r.pnl; paper.n++; paper.sumPnl += r.pnl; if (r.pnl > 0) paper.wins++;
  paper.open = paper.open.filter(x => x.id !== p.id);
  paper.closed.unshift(p); dirty = true;
  log('PAPER KAPANDI: ' + p.base + ' → ' + (REASON[reason] || reason) + ' | PnL ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) + ' USDT');
  checkDailyLoss();
}
function paperSummary() {
  let unreal = 0;
  paper.open.forEach(p => { unreal += paperPnl(p, priceOf(p.symbol) || p.entry).pnl; });
  return {
    balance: +paper.balance.toFixed(2), start: paper.startBalance, equity: +(paper.balance + unreal).toFixed(2), unrealized: +unreal.toFixed(2),
    total: paper.n + paper.open.length, open: paper.open.length, closed: paper.n, wins: paper.wins,
    winRate: paper.n ? +(paper.wins / paper.n * 100).toFixed(1) : 0, sumPnl: +paper.sumPnl.toFixed(2), avgPnl: paper.n ? +(paper.sumPnl / paper.n).toFixed(3) : 0,
    dayStart: +paper.dayStart.toFixed(2)
  };
}

/* ───────── TAKİPÇİ (1m mum High/Low) ───────── */
const fromOf = o => (o.lastTs ? o.lastTs + M1 : Math.ceil((o.createdAt || o.openedAt) / M1) * M1);
function processTrade(o, cs, t, kind) {
  if (o.status === 'KAPALI') return;
  const from = fromOf(o);
  let lastClose = null;
  if (cs) {
    for (const c of cs) {
      lastClose = c.c;
      if (c.t < from) continue;
      const r = stepTrade(o, c);
      if (r) {
        if (r.done) { if (kind === 'sig') closeSignal(o, r.price, r.reason); else closePaper(o, r.price, r.reason); return; }
        dirty = true;
        if (kind === 'sig') log('TP1 vuruldu: ' + MODS[o.module].label + ' ' + o.base + ' (yarısı kapandı, stop başa çekildi)');
      }
      if (c.t + M1 <= t) o.lastTs = c.t;
    }
  }
  const px = priceOf(o.symbol) || lastClose || o.entry;
  if (kind === 'sig') { if (t - o.createdAt > o.maxAgeMs) closeSignal(o, px, 'SURE'); }
  else if (t - o.openedAt >= settings.maxMinutes * 60000) closePaper(o, px, 'SURE');
}
async function trackerCycle() {
  const t = Date.now();
  const act = signals.filter(s => s.status === 'AKTIF' && (s.module === 'PUMP' || !s._chk || t - s._chk >= 55000));
  const ops = paper.open.slice();
  const need = new Map();
  for (const o of act.concat(ops)) { const f = fromOf(o), v = need.get(o.symbol); if (v === undefined || f < v) need.set(o.symbol, f); }
  const data = {};
  await pool(Array.from(need.keys()), 6, async sym => {
    const since = need.get(sym), lim = Math.min(300, Math.ceil((t - since) / M1) + 2);
    try { const raw = await ex.fetchOHLCV(sym, '1m', since, lim); data[sym] = (raw || []).map(toC); } catch (e) { stats.apiErr++; }
  });
  for (const s of act) { s._chk = t; try { processTrade(s, data[s.symbol], t, 'sig'); } catch (e) { log('HATA takip ' + s.base + ': ' + e.message); } }
  for (const p of ops) { try { processTrade(p, data[p.symbol], t, 'paper'); } catch (e) { log('HATA paper ' + p.base + ': ' + e.message); } }
  if (dirty && act.length + ops.length > 0) dirty = true;
}

/* ───────── TARAYICILAR ───────── */
async function scanPump() {
  await refreshTickers();
  const now = Date.now(), cands = [];
  for (const sym of ALL) {
    const tk = TICK[sym];
    if (!tk) continue;
    const h = HIST[sym] || (HIST[sym] = []);
    h.push({ t: now, p: tk.last });
    while (h.length && now - h[0].t > 300000) h.shift();
    if ((tk.quoteVolume || 0) < 1500000) continue;
    const ref = h.find(x => x.t >= now - 200000);
    if (!ref || now - ref.t < 90000) continue;
    const mv = (tk.last / ref.p - 1) * 100;
    if (Math.abs(mv) >= 0.8) cands.push({ sym, mv });
  }
  cands.sort((a, b) => Math.abs(b.mv) - Math.abs(a.mv));
  const list = cands.slice(0, 12);
  await pool(list, 4, async c => {
    const cs = await getC(c.sym, '1m', 120, 0);
    if (!cs || cs.length < 60 || now - cs[cs.length - 1].t > 2 * M1) { PWHY['veri bayat'] = (PWHY['veri bayat'] || 0) + 1; return; }
    stats.pumpScanned++;
    const tk = TICK[c.sym];
    if (tk && tk.bid && tk.ask) { const sp = (tk.ask - tk.bid) / tk.last * 100; if (sp > 0.25) { PWHY['spread geniş'] = (PWHY['spread geniş'] || 0) + 1; return; } }
    const det = detectPump(cs, PWHY);
    if (det) addSignal(Object.assign({ module: 'PUMP', symbol: c.sym }, det));
  });
}
async function scanScalper() {
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '5m', 90);
    if (!raw) return;
    const cs = closed(raw, M5);
    if (cs.length < 60) return;
    sc('SCALPER', 'taranan');
    const det = detectScalper(cs, SWHY);
    if (det) emit('SCALPER', sym, det, cs[cs.length - 1], M5, 4 * M1);
  });
}
async function scanRange() {
  const watch = [];
  await pool(TOP.slice(0, 80), 8, async sym => {
    const raw = await getC(sym, '15m', 170);
    if (!raw) return;
    const cs = closed(raw, M15);
    if (cs.length < 120) return;
    sc('RANGE', 'taranan');
    const r = detectRange(cs);
    if (r.watch) watch.push(Object.assign({ symbol: sym, base: baseOf(sym), sector: sectorOf(baseOf(sym)) }, r.watch));
    if (r.signal) emit('RANGE', sym, r.signal, cs[cs.length - 1], M15, 12 * M1);
  });
  watch.sort((a, b) => b.squeezeScore - a.squeezeScore);
  WATCH.range = watch.slice(0, 40);
}
async function scanZone() {
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
  for (const s of signals.filter(x => x.status === 'AKTIF' && x.module === 'TREND')) {
    const raw = await getC(s.symbol, '1h', 250);
    if (!raw) continue;
    const cs = closed(raw, H1);
    if (trendReversed(cs, s.dir)) closeSignal(s, priceOf(s.symbol) || cs[cs.length - 1].c, 'TREND_BITTI');
  }
  await pool(TOP.slice(0, 100), 6, async sym => {
    const raw = await getC(sym, '1h', 260);
    if (!raw) return;
    const cs = closed(raw, H1);
    if (cs.length < 220) return;
    sc('TREND', 'taranan');
    if (!detectTrend(cs)) return;
    const r4 = await getC(sym, '4h', 120);
    const det = detectTrend(cs, r4 ? closed(r4, H4) : null);
    if (det) emit('TREND', sym, det, cs[cs.length - 1], H1, 55 * M1);
  });
}
async function scanLT() {
  const watch = [];
  await pool(TOP.slice(0, 80), 6, async sym => {
    const sets = [];
    const r4 = await getC(sym, '4h', 150);
    if (r4) sets.push({ tf: '4h', ms: H4, cs: closed(r4, H4), lag: 90 * M1 });
    const r1 = await getC(sym, '1h', 300);
    if (r1) {
      const c1 = closed(r1, H1);
      let a2 = aggTF(c1, 120);
      if (a2.length && a2[a2.length - 1].t + H1 > c1[c1.length - 1].t) a2 = a2.slice(0, -1);   // tamamlanmamış 2h mumu at
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
        if (r.signal) { r.signal.info.tf = T.tf; emit('LT', sym, r.signal, T.cs[T.cs.length - 1], T.ms, T.lag); }
      }
    }
  });
  watch.sort((a, b) => b.maturity - a.maturity);
  WATCH.lt = watch.slice(0, 40);
}

/* ───────── PİYASA YÖNÜ / RADAR ───────── */
function trfScore(cs) {
  if (!cs || cs.length < 60) return 0;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cl.length - 1;
  return (cl[m] > e50[m] ? 1 : -1) * 0.5 + (e20[m] > e50[m] ? 1 : -1) * 0.5;
}
async function marketCycle() {
  const parts = [];
  for (const [key, sym] of [['btc', 'BTC/USDT:USDT'], ['eth', 'ETH/USDT:USDT']]) {
    const tk = TICK[sym];
    if (tk) market[key] = { price: tk.last, change: tk.percentage != null ? +Number(tk.percentage).toFixed(2) : null };
    const r1 = await getC(sym, '1h', 120), r4 = await getC(sym, '4h', 120);
    if (r1) parts.push(trfScore(closed(r1, H1)));
    if (key === 'btc' && r1) { const bc = closed(r1, H1); if (bc.length >= 60) { const be = emaArr(closes(bc), 50); market.btcDir = bc[bc.length - 1].c > be[be.length - 1] ? 'LONG' : 'SHORT'; } }
    if (r4) parts.push(trfScore(closed(r4, H4)));
  }
  const trfPct = parts.length ? (avg(parts) + 1) / 2 : 0.5;
  let g1 = 0, n1 = 0, g4 = 0, n4 = 0;
  await pool(TOP.slice(0, 60), 8, async sym => {
    const a = await getC(sym, '1h', 60), b = await getC(sym, '4h', 60);
    if (a) { const c = closed(a, H1); if (c.length) { n1++; if (c[c.length - 1].c > c[c.length - 1].o) g1++; } }
    if (b) { const c = closed(b, H4); if (c.length) { n4++; if (c[c.length - 1].c > c[c.length - 1].o) g4++; } }
  });
  const b1 = n1 ? g1 / n1 : 0.5, b4 = n4 ? g4 / n4 : 0.5;
  const breadth = 0.6 * b1 + 0.4 * b4, score = 0.5 * trfPct + 0.5 * breadth;
  let dir = market.dir;
  if (score > 0.58) dir = 'LONG'; else if (score < 0.42) dir = 'SHORT';
  else if (dir === 'LONG' && score <= 0.54) dir = 'NOTR';
  else if (dir === 'SHORT' && score >= 0.46) dir = 'NOTR';
  if (dir !== 'NOTR') {
    if (market.lastDirective && market.lastDirective !== dir) market.lastDirChange = Date.now();
    market.lastDirective = dir;
  }
  if (dir !== market.dir) log('PİYASA YÖNÜ: ' + market.dir + ' → ' + dir + ' (skor ' + score.toFixed(2) + ', genişlik %' + (breadth * 100).toFixed(0) + ')');
  Object.assign(market, { dir, score: +score.toFixed(3), trf: +trfPct.toFixed(3), breadth: +breadth.toFixed(3), b1h: +b1.toFixed(3), b4h: +b4.toFixed(3), updatedAt: Date.now() });
}
function fngText(v) {
  if (v <= 25) return 'Aşırı korku: Herkes satıyor. Tarihsel olarak dipler böyle dönemlerde oluşur ama düşüş sürebilir, acele etme.';
  if (v <= 45) return 'Korku: Piyasa temkinli. Yükseliş sinyalleri daha dikkatli teyit edilmeli.';
  if (v <= 55) return 'Nötr: Ne korku ne hırs baskın. Yön belirsiz, sinyallere göre hareket et.';
  if (v <= 75) return 'Hırs: Alıcılar iştahlı. Trend yukarı olabilir ama sert geri çekilmelere hazırlıklı ol.';
  return 'Aşırı hırs: Herkes alıyor. Düzeltme riski yüksek, yeni LONG açarken çok temkinli ol.';
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
    if (i === 0) named.btc = [r1, r4]; if (i === 1) named.eth = [r1, r4];
  });
  const f = x => (x == null ? null : +x.toFixed(1));
  const a1 = avg(rs[1]), a4 = avg(rs[4]);
  R.rsi = { btc1h: f(named.btc && named.btc[0]), btc4h: f(named.btc && named.btc[1]), eth1h: f(named.eth && named.eth[0]), eth4h: f(named.eth && named.eth[1]), avg1h: f(a1), avg4h: f(a4) };
  R.rsi.text = a1 >= 70 ? 'Piyasa genelinde RSI yüksek: coinler kısa vadede aşırı alınmış, geri çekilme olabilir.'
    : a1 <= 30 ? 'Piyasa genelinde RSI düşük: coinler aşırı satılmış, tepki yükselişi gelebilir.'
    : 'RSI normal bölgede: aşırı alım ya da satım yok, piyasa dengeli.';
  try {
    const j = await fetchJSON('https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=BTCUSDT&period=1h');
    const d = j && j.data, row = Array.isArray(d) ? d[d.length - 1] : d;
    const lr = parseFloat(row && (row.longAccountRatio || row.longRatio)), sr = parseFloat(row && (row.shortAccountRatio || row.shortRatio));
    if (!isFinite(lr) || !isFinite(sr) || lr + sr <= 0) throw new Error('veri yok');
    R.ls = { long: +(lr / (lr + sr) * 100).toFixed(1), short: +(sr / (lr + sr) * 100).toFixed(1), source: 'Bitget' };
  } catch (e) {
    R.ls = { long: +(market.breadth * 100).toFixed(1), short: +((1 - market.breadth) * 100).toFixed(1), source: 'Tahmini (yeşil/kırmızı coin oranı)' };
  }
  R.ls.ratio = R.ls.short > 0 ? +(R.ls.long / R.ls.short).toFixed(2) : null;
  R.ls.text = R.ls.long >= 60 ? 'Çoğunluk LONG tarafında. Kalabalık tek yöndeyse ters hareket (long squeeze) riski artar.'
    : R.ls.long <= 40 ? 'Çoğunluk SHORT tarafında. Sert yükselişte shortlar patlayabilir (short squeeze).'
    : 'Long ve short dengeli, aşırı kalabalık bir taraf yok.';
  radar = R;
}

/* ───────── İSTATİSTİK ───────── */
function statsByModule() {
  const rows = [];
  let T = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0 };
  Object.keys(MODS).forEach(k => {
    const all = signals.filter(s => s.module === k), cl = all.filter(s => s.status === 'KAPALI');
    const wins = cl.filter(s => s.netR > 0).length, losses = cl.length - wins;
    const row = { module: k, label: MODS[k].label, total: all.length, open: all.length - cl.length, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, grossR: +cl.reduce((a, s) => a + (s.grossR || 0), 0).toFixed(2), netR: +cl.reduce((a, s) => a + (s.netR || 0), 0).toFixed(2) };
    rows.push(row);
    T.total += row.total; T.open += row.open; T.wins += wins; T.losses += losses; T.grossR += row.grossR; T.netR += row.netR;
  });
  const c = T.wins + T.losses;
  T.winRate = c ? +(T.wins / c * 100).toFixed(1) : 0; T.grossR = +T.grossR.toFixed(2); T.netR = +T.netR.toFixed(2);
  rows.push(T);
  return rows;
}

/* ───────── BACKTEST ───────── */
const BT = {
  PUMP:    { tf: '1m',  warm: 130, win: 130, maxBars: 20, detect: w => detectPump(w) },
  SCALPER: { tf: '5m',  warm: 60,  win: 80,  maxBars: 18, detect: w => detectScalper(w) },
  TREND:   { tf: '1h',  warm: 260, win: 260, maxBars: 72, detect: w => detectTrend(w) },
  LT:      { tf: '4h',  warm: 70,  win: 130, maxBars: 30, detect: w => detectLT(w).signal || null },
  ZONE:    { tf: '1h',  warm: 260, win: 260, maxBars: 24, detect: w => detectZone(w, buildZones(w, null)).signal },
  RANGE:   { tf: '15m', warm: 140, win: 170, maxBars: 24, detect: w => detectRange(w).signal || null }
};
const BT_TOTAL = { '1m': 2400, '5m': 1500, '15m': 1500, '1h': 1500, '4h': 1000 };
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
    const t = Object.assign({}, det, { curSl: det.sl, tp1Hit: false });
    let exit = null, reason = 'SURE', k = Math.min(cs.length - 1, i + cfg.maxBars);
    for (let j = i + 1; j <= k; j++) { const r = stepTrade(t, cs[j]); if (r && r.done) { exit = r.price; reason = r.reason; k = j; break; } }
    if (exit == null) exit = cs[k].c;
    const R = calcR(t, exit);
    const rd = refDir(cs[i].t + ms);
    out.push({ t: cs[i].t, net: R.net, gross: R.gross, reason, ok: !rd || rd === det.dir });
    i = k;
  }
  return out;
}
async function runBacktest(job) {
  const { module: mod, coins } = job.params, cfg = BT[mod], tf = job.params.tf, ms = TF_MS[tf];
  const syms = TOP.slice(0, coins), trades = [];
  let tMin = Infinity, tMax = 0, done = 0, used = 0;
  // canlı kuralın aynısı: BTC 1h EMA50 yönüne ters sinyaller elenir
  const btc = await fetchHistory('BTC/USDT:USDT', '1h', Math.min(2400, Math.ceil(BT_TOTAL[tf] * ms / H1) + 60));
  const dirBy = new Map();
  if (btc.length > 60) { const e50 = emaArr(closes(btc), 50); btc.forEach((c, i) => dirBy.set(c.t, c.c > e50[i] ? 'LONG' : 'SHORT')); }
  const refDir = t => dirBy.get(Math.floor(t / H1) * H1 - H1);
  for (const sym of syms) {
    try {
      const cs = await fetchHistory(sym, tf, BT_TOTAL[tf]);
      if (cs.length >= cfg.warm + 30) {
        used++; tMin = Math.min(tMin, cs[0].t); tMax = Math.max(tMax, cs[cs.length - 1].t);
        btCoin(cs, cfg, refDir, ms).forEach(x => trades.push(Object.assign({ sym: baseOf(sym) }, x)));
      }
    } catch (e) { /* coin atla */ }
    job.progress = +(++done / syms.length).toFixed(2);
  }
  trades.sort((a, b) => a.t - b.t);
  const ft = trades.filter(x => x.ok), split = tMin + 0.6 * (tMax - tMin);
  const train = ft.filter(x => x.t < split).map(x => x.net), valid = ft.filter(x => x.t >= split).map(x => x.net);
  let cum = 0, curve = ft.map(x => +(cum += x.net).toFixed(3));
  const step = Math.max(1, Math.ceil(curve.length / 400));
  if (step > 1) curve = curve.filter((_, i) => i % step === 0);
  job.result = {
    module: mod, label: MODS[mod].label, tf, coins: used, trades: ft.length, rawTrades: trades.length,
    all: btStats(ft.map(x => x.net)), raw: btStats(trades.map(x => x.net)), train: btStats(train), valid: btStats(valid),
    curve, splitIdx: Math.floor(train.length / step),
    note: 'Yön filtreli sonuçlar canlı kuralı taklit eder (BTC 1h EMA50 yönüne ters sinyaller elenir; canlıda piyasa genişliği de katılır). Backtest tek zaman dilimiyle çalışır: 4H/1D teyitleri, konfluans ve limitler dahil değildir. Komisyon+slippage Net R\'den düşülmüştür. Geçmiş performans gelecek garantisi değildir.'
  };
  job.status = 'bitti';
}

/* ───────── STRATEJİ AÇIKLAMALARI ───────── */
const STRATEGIES = [
  { module: 'TREND', name: 'Trend', tf: '1h + 4h teyit', desc: 'EMA20>EMA50>EMA200 dizilimi + ADX>20 olan trendde EMA20 geri çekilmesinden dönüş mumu (pullback) veya son 6 mumda taze EMA20/50 kesişimi. 4H EMA50 eğimi ve hacim güven puanını etkiler, engellemez. Trend ters kesişince kapanır.', params: 'TP1 2xATR, TP2 4xATR, SL min(1.8xATR, swing). Max 3 açık, günde 2 sinyal.' },
  { module: 'SCALPER', name: 'Scalper', tf: '5m', desc: '20 mumluk high/low kapanışla kırılır + hacim>1.3x + 5m EMA20/50 trend uyumu. RSI+MACD momentum, güçlü kapanış ve mum boyu sadece güven puanını etkiler.', params: 'Risk = max(1.2xATR, %0.6). TP1 0.9R (yarısı kapanır, stop girişe), TP2 2R. Süre 90 dk. Modül/flood/global/sektör limiti yok.' },
  { module: 'LT', name: 'LT Üçgen', tf: '4h + 1d teyit', desc: '2h ve 4h grafikte en tepe pivottan alçalan tepeler boyunca üst çizgi, en dip pivottan yükselen dipler boyunca alt çizgi çekilir ve ileriye uzatılır. Sıkışma<0.75, olgunluk 0.4–1.0. Kırılım: çizgiyi %0.3 aşan kapanış + hacim>1.2x.', params: 'TP1 %60, TP2 %100 üçgen yüksekliği, SL üçgen orta noktası. Max 3 açık.' },
  { module: 'ZONE', name: 'Zone Master', tf: '1h + 4h bölge', desc: '1H ve 4H pivotları %0.4 toleransla kümelenir; skor = değme×1.5 + hacim − yaşlanma. Skor≥6 bölgede onay mumu (yeşil/kırmızı + fitil≥gövde) = sinyal.', params: 'SL bölge dışı 0.3xATR, TP1 karşı bölge veya 1.5R, TP2 2.5R. Max 4 açık.' },
  { module: 'RANGE', name: 'Range Pro', tf: '15m', desc: 'Bollinger genişliği son 100 mumun alt %30 diliminde (sıkışma) ve 20 mumluk range < %5. Kırılım: range dışında kapanış + hacim>1.3x.', params: 'SL range ortası (min %0.5 risk), TP1 max(1x range, 1R), TP2 1.8x range. Max 4 açık.' },
  { module: 'PUMP', name: 'AlgoPump', tf: '1m + 5m ATR', desc: 'Son 5 dk ≥%1.6 (veya 15 dk ≥%3) hareket + 3 dk hacim>3x + mum yönü ≥3/5 + itme gücü ≥2.5xATR. Sahte pump, fitil tuzağı, geç kalma ve geniş spread filtrelenir. Zirve/dip yakını ve tek mumluk hareket girişleri engellenir.', params: 'TP1 max(%0.6, 0.6xATR5m) yarısı kapanır, stop girişe çekilir; TP2 = 2x TP1; SL 1.1xATR5m (%0.7–1.8). Süre 20 dk. Max 6 açık.' }
];

/* ───────── API ───────── */
const app = express();
app.use(express.json({ limit: '100kb' }));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { log('API HATA ' + req.path + ': ' + e.message); res.status(500).json({ error: e.message }); });
function view(s) {
  const px = priceOf(s.symbol), d = s.dir === 'LONG' ? 1 : -1;
  return Object.assign({}, s, { modLabel: MODS[s.module].label, livePrice: px || null, livePct: px && s.status === 'AKTIF' ? +(((px / s.entry - 1) * d) * 100).toFixed(3) : null });
}
function paperView(p) {
  if (p.status === 'KAPALI') return p;
  const px = priceOf(p.symbol) || p.entry, r = paperPnl(p, px);
  return Object.assign({}, p, { livePrice: px, livePnl: +r.pnl.toFixed(2), livePnlPct: +r.pct.toFixed(2), ageMs: Date.now() - p.openedAt });
}
const PLACEHOLDER = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>AlphaSon ' + VERSION + '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;background:#0b1220;color:#e5e7eb;padding:2rem"><h2>AlphaSon ' + VERSION + '</h2><p>Backend çalışıyor. Arayüz (Parça 2) henüz eklenmedi: <code>index.html</code> dosyasını server.js ile aynı klasöre koyun.</p><p><a style="color:#60a5fa" href="/api/state">/api/state</a></p></body></html>';
app.get('/', (req, res) => {
  let html = PLACEHOLDER;
  try { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) html = fs.readFileSync(p, 'utf8'); } catch (e) { /* placeholder */ }
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION }));
app.get('/api/state', h((req, res) => {
  const act = signals.filter(s => s.status === 'AKTIF'), byMod = {};
  Object.keys(MODS).forEach(k => { byMod[k] = act.filter(s => s.module === k).length; });
  res.json({ version: VERSION, now: Date.now(), uptime: Math.round(process.uptime()), market, settings, counts: { active: act.length, byModule: byMod }, scan: { universe: TOP.length, all: ALL.length, apiErr: stats.apiErr, tickAt: stats.tickAt }, blocks: BLK, paper: paperSummary(), modules: MODS, ready: TOP.length > 0 });
}));
app.get('/api/signals', h((req, res) => {
  let l = signals;
  if (req.query.module) l = l.filter(s => s.module === String(req.query.module).toUpperCase());
  if (req.query.status) l = l.filter(s => s.status === String(req.query.status).toUpperCase());
  const act = l.filter(s => s.status === 'AKTIF').sort((a, b) => b.createdAt - a.createdAt);
  const cl = l.filter(s => s.status !== 'AKTIF').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, Number(req.query.closed) || 60);
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
  if (s.status !== 'AKTIF') return res.status(400).json({ error: 'Sinyal zaten kapalı' });
  closeSignal(s, priceOf(s.symbol) || s.entry, 'MANUEL');
  res.json({ ok: true, signal: view(s) });
}));
app.get('/api/paper', h((req, res) => res.json({ settings, summary: paperSummary(), open: paper.open.map(paperView), closed: paper.closed.slice(0, 50), limits: { maxOpen: PAPER_MAX_OPEN, sectorLimit: PAPER_SECTOR_LIM, dailyLoss: DAILY_LOSS_LIM } })));
app.post('/api/paper/settings', h((req, res) => {
  const b = req.body || {};
  const merged = Object.assign({}, settings, b);
  if (b.auto === undefined) merged.auto = settings.auto;
  settings = sanitizeSettings(merged);
  saveSettings();
  log('AYARLAR: oto-trade ' + (settings.auto ? 'AÇIK' : 'KAPALI') + ' | margin ' + settings.margin + ' | ' + settings.leverage + 'x | min güven ' + settings.minConf + ' | max ' + settings.maxMinutes + ' dk');
  res.json({ ok: true, settings });
}));
app.post('/api/paper/toggle', h((req, res) => {
  settings.auto = req.body && req.body.auto !== undefined ? !!req.body.auto : !settings.auto;
  if (settings.auto) { paper.dayKey = ''; checkDailyLoss(); }
  saveSettings();
  log('OTO-TRADE ' + (settings.auto ? 'AÇILDI' : 'KAPATILDI'));
  res.json({ ok: true, settings });
}));
app.post('/api/paper/:id/close', h((req, res) => {
  const p = paper.open.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Açık paper bulunamadı' });
  closePaper(p, priceOf(p.symbol) || p.entry, 'MANUEL');
  res.json({ ok: true, paper: p });
}));
app.post('/api/paper/reset', h((req, res) => {
  paper = { seq: paper.seq, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE };
  dirty = true; log('PAPER: Hesap sıfırlandı (bakiye ' + START_BALANCE + ' USDT)');
  res.json({ ok: true });
}));
app.get('/api/watch/:kind', h((req, res) => res.json({ items: WATCH[req.params.kind] || [] })));
app.get('/api/radar', h((req, res) => res.json({ radar, market })));
app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: COST_PCT, note: 'Net R = brüt R − (komisyon+slippage / risk)' })));
app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: STRATEGIES, limits: { globalMax: GLOBAL_MAX, perModule: Object.keys(MODS).reduce((o, k) => { o[k] = MODS[k].max; return o; }, {}) } })));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.post('/api/backtest', h((req, res) => {
  const b = req.body || {}, mod = String(b.module || '').toUpperCase();
  if (!BT[mod]) return res.status(400).json({ error: 'Geçersiz modül' });
  const tf = BT_TOTAL[b.tf] ? b.tf : BT[mod].tf;
  const effTf = mod === 'PUMP' ? '1m' : tf;
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
  for (;;) {
    try { await ex.loadMarkets(); await refreshUniverse(); break; }
    catch (e) { log('HATA: Borsa verisi alınamadı (' + e.message + '), 15 sn sonra tekrar...'); await new Promise(r => setTimeout(r, 15000)); }
  }
  every('evren', 30 * M1, refreshUniverse, 30 * M1);
  every('piyasa', 2 * M1, marketCycle, 3000);
  every('pump', 15000, scanPump, 5000);
  every('takip', 20000, trackerCycle, 8000);
  every('scalper', 60000, scanScalper, 12000);
  every('range', 5 * M1, scanRange, 25000);
  every('zone', 5 * M1, scanZone, 45000);
  every('trend', 15 * M1, scanTrend, 70000);
  every('lt', 15 * M1, scanLT, 100000);
  every('radar', 5 * M1, radarCycle, 20000);
  every('kayit', 30000, async () => { saveAll(); }, 30000);
  every('pump-log', 5 * M1, async () => {
    const tot = signals.filter(s => s.module === 'PUMP').length;
    log('Pump taraması: ' + stats.pumpScanned + ' coin, ' + stats.pumpFound + ' sinyal, toplam ' + tot);
    const why = Object.keys(PWHY).sort((a, b) => PWHY[b] - PWHY[a]).map(k => k + ' ' + PWHY[k]).join(', ');
    if (why) log('Pump red nedenleri: ' + why);
    Object.keys(PWHY).forEach(k => delete PWHY[k]);
    stats.pumpScanned = 0; stats.pumpFound = 0;
  }, 5 * M1);
  every('tarama-ozet', 10 * M1, async () => {
    const parts = Object.keys(SC).map(m => MODS[m].label + ' [' + Object.keys(SC[m]).map(k => k + ' ' + SC[m][k]).join(', ') + ']');
    log('Tarama özeti (10 dk): ' + (parts.join(' | ') || 'henüz tarama yok'));
    const w = Object.keys(SWHY).sort((a, b) => SWHY[b] - SWHY[a]).map(k => k + ' ' + SWHY[k]).join(', ');
    if (w) log('Scalper red nedenleri: ' + w);
    Object.keys(SC).forEach(k => delete SC[k]);
    Object.keys(SWHY).forEach(k => delete SWHY[k]);
  }, 10 * M1);
  every('temizlik', 10 * M1, async () => {
    const now = Date.now();
    Object.keys(jobs).forEach(k => { if (now - jobs[k].startedAt > 30 * M1) delete jobs[k]; });
    for (const k of Object.keys(HIST)) if (!HIST[k].length) delete HIST[k];
  }, 10 * M1);
}
function start() {
  log('AlphaSon ' + VERSION + ' başlatılıyor...');
  loadAll();
  app.listen(PORT, () => log('Sunucu hazır: port ' + PORT));
  init().catch(e => log('KRİTİK: init hatası ' + e.message));
}
process.on('uncaughtException', e => log('YAKALANMAMIŞ HATA: ' + (e && e.message)));
process.on('unhandledRejection', e => log('YAKALANMAMIŞ RED: ' + (e && e.message ? e.message : e)));
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { log('Kapanıyor, veriler kaydediliyor...'); dirty = true; saveAll(); process.exit(0); }));

if (require.main === module) start();
module.exports = { btCoin, BT, analyzeTriangle, anchorLine, pivots, detectPump, detectScalper, detectTrend, detectLT, detectZone, buildZones, detectRange, stepTrade, calcR, VERSION };
