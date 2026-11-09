/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v91.0 — Sade Sinyal Motoru
   ───────────────────────────────────────────────────────────────────────────
   3 strateji, tamamı yalnızca SİNYAL üretir (otomatik işlem yok):

     1) TREND   "Trend Takip"   15m — EMA21/55 rejim + geri çekilme + yapı kırılımı
     2) HIZLI   "Hızlı Trend"    5m — EMA9/21 + VWAP + RSI + hacim momentumu
     3) LT      "LT Üçgen"     1h+2h — simetrik üçgen, çizgiye DEĞİNCE sinyal

   Kurallar:
     • Piyasa yönü yalnızca matematikle belirlenir (BTC/ETH + genişlik).
       Piyasa NOTR ise hiçbir strateji sinyal üretmez.
     • Ters yönlü sinyal yok: coin rejimi ve piyasa yönü sinyal yönüyle aynı olmalı.
     • Sinyalde giriş / TP1 / TP2 / stop belli olur. Takip: TP1 → KAR,
       stop → ZARAR, süre dolarsa ZAMAN. Maliyet / R / AI / backtest YOKTUR.
   Veriler: Bitget USDT-M vadeli, yalnızca açık veri (API anahtarı gerekmez).
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ccxt = require('ccxt');

const VERSION = 'v91.0';
const PORT = Number(process.env.PORT) || 3000;

const M1 = 60 * 1000, M5 = 5 * M1, M15 = 15 * M1, H1 = 60 * M1, H2 = 2 * H1;
const TF_MS = { '5m': M5, '15m': M15, '1h': H1, '2h': H2 };
const TTL = { '5m': 45e3, '15m': 90e3, '1h': 5 * M1, '2h': 10 * M1 };

const DATA_DIR = (() => {
  const cands = [process.env.ALPHASON_DATA, path.join(__dirname, 'data'), '/tmp/alphason-data', osTmp()].filter(Boolean);
  for (const d of cands) { try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* dene sonrakini */ } }
  throw new Error('Yazılabilir veri dizini yok');
  function osTmp() { try { return require('os').tmpdir() + '/alphason-data'; } catch (e) { return null; } }
})();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const API_TOKEN = String(process.env.ALPHASON_API_TOKEN || '').trim();

/* ── Yardımcılar ─────────────────────────────────────────────────────────── */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const avg = a => { const x = (a || []).filter(v => Number.isFinite(Number(v))); return x.length ? x.reduce((s, v) => s + Number(v), 0) / x.length : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rp = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return 0; if (n >= 1000) return +n.toFixed(2); if (n >= 1) return +n.toFixed(4); if (n >= 0.01) return +n.toFixed(6); return +n.toFixed(8); };
const baseOf = sym => String(sym || '').split('/')[0].toUpperCase();
const bodyRatio = c => { const r = c.h - c.l; return r > 0 ? Math.abs(c.c - c.o) / r : 0; };
const bodyAtr = (c, atr) => atr > 0 ? Math.abs(c.c - c.o) / atr : 0;
const closesOf = cs => cs.map(c => c.c);
const toC = a => ({ t: Number(a[0]), o: Number(a[1]), h: Number(a[2]), l: Number(a[3]), c: Number(a[4]), v: Number(a[5]) || 0 });

function emaArr(vals, len) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < len) return out;
  const k = 2 / (len + 1);
  let e = 0;
  for (let i = 0; i < len; i++) e += vals[i];
  e /= len;
  out[len - 1] = e;
  for (let i = len; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsiLast(closes, len = 14) {
  if (closes.length < len + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - len; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  const rs = (g / len) / (l / len);
  return 100 - 100 / (1 + rs);
}
function atrArr(cs, len = 14) {
  const out = new Array(cs.length).fill(null);
  if (cs.length < len + 1) return out;
  const trs = [];
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let a = 0;
  for (let i = 0; i < len; i++) a += trs[i];
  a /= len;
  out[len] = a;
  for (let i = len; i < trs.length; i++) { a = (a * (len - 1) + trs[i]) / len; out[i + 1] = a; }
  return out;
}
function atrLast(cs, len = 14) { const a = atrArr(cs, len); return a.length ? a[a.length - 1] : null; }
function adxLast(cs, len = 14) {
  if (cs.length < 2 * len + 2) return null;
  let pDM = 0, mDM = 0, tr = 0;
  const start = cs.length - len;
  for (let i = start; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    const up = c.h - p.h, dn = p.l - c.l;
    pDM += up > dn && up > 0 ? up : 0;
    mDM += dn > up && dn > 0 ? dn : 0;
    tr += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  if (!(tr > 0)) return null;
  const pDI = 100 * pDM / tr, mDI = 100 * mDM / tr;
  const dx = 100 * Math.abs(pDI - mDI) / Math.max(pDI + mDI, 1e-9);
  return { adx: dx, plusDI: pDI, minusDI: mDI }; // yaklaşık DX (son pencere)
}
function vwapOf(cs, sinceMs) {
  let pv = 0, v = 0, pv2 = 0;
  for (const c of cs) {
    if (c.t < sinceMs) continue;
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v; v += c.v; pv2 += tp * tp * c.v;
  }
  if (!(v > 0)) return { vwap: cs.length ? cs[cs.length - 1].c : 0, sd: 0 };
  const vw = pv / v;
  return { vwap: vw, sd: Math.sqrt(Math.max(0, pv2 / v - vw * vw)) };
}

/* ── Log ─────────────────────────────────────────────────────────────────── */
const LOGS = [];
const LOG_ONCE = new Map();
function log(msg) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  LOGS.push(line); if (LOGS.length > 300) LOGS.splice(0, LOGS.length - 300);
  console.log(line);
}
function logOnce(key, msg, ms) {
  const now = Date.now(), last = LOG_ONCE.get(key) || 0;
  if (now - last < ms) return;
  LOG_ONCE.set(key, now); log(msg);
}

/* ── Ayarlar ─────────────────────────────────────────────────────────────── */
const DEF_SET = {
  trendEnabled: true, hizliEnabled: true, ltEnabled: true,
  trendScan: 50,        // Trend Takip: tur başına taranan coin
  hizliScan: 50,        // Hızlı Trend: tur başına taranan coin
  ltScan: 90,           // LT Üçgen: izlenen coin sayısı
  minStopPct: 0.40,     // stop aralığı: girişin %0.40'ı altına düşmez
  maxStopPct: 2.50,     // ve %2.50 üstüne çıkmaz (referans plan olarak çekilir)
  signalCooldownMin: 45 // aynı coin + strateji için sinyal bekleme süresi
};
let settings = Object.assign({}, DEF_SET);

/* ── Borsa (yalnız açık veri) ────────────────────────────────────────────── */
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
const CACHE = new Map();   // sym|tf → { at, cs }
const INFLIGHT = new Map();
const TICK = new Map();    // sym → { last, bid, ask, chg, vol24, ts }
const UNIVERSE = [];
const ROT = {};            // strateji bazlı dönüş sayacı

const EXCLUDE = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'PYUSD', 'EUR', 'GBP', 'BTC3L', 'BTC3S', 'ETH3L', 'ETH3S', 'SOL3L', 'SOL3S', 'XRP3L', 'XRP3S', 'BUSD']);

async function pool(items, n, fn) {
  const q = items.slice(); let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, q.length)) }, async () => {
    while (i < q.length) { const it = q[i++]; try { await fn(it); } catch (e) { /* tek coin hatası taramayı durdurmaz */ } }
  });
  await Promise.all(workers);
}

function tick(sym) { return TICK.get(sym) || null; }
function priceOf(sym) { const t = TICK.get(sym); return t && t.last > 0 ? t.last : 0; }
function spreadPct(sym) { const t = TICK.get(sym); return t && t.bid > 0 && t.ask > 0 ? (t.ask - t.bid) / t.bid * 100 : 99; }

async function refreshUniverse() {
  try {
    const markets = await ex.loadMarkets();
    UNIVERSE.length = 0;
    for (const sym of Object.keys(markets)) {
      const m = markets[sym];
      if (!m.swap || !m.quote || m.quote !== 'USDT') continue;
      const b = m.base;
      if (EXCLUDE.has(b) || !m.active) continue;
      UNIVERSE.push(sym);
    }
    logOnce('universe', 'Evren: ' + UNIVERSE.length + ' USDT-M coin (Bitget açık veri)', 30 * M1);
  } catch (e) { logOnce('unierr', 'Evren yenileme hatası: ' + (e.message || e), M1); }
}

async function refreshTickers() {
  try {
    const all = await ex.fetchTickers();
    const now = Date.now();
    let n = 0;
    for (const sym of UNIVERSE) {
      const t = all[sym];
      if (!t) continue;
      const last = num(t.last || t.close);
      if (!(last > 0)) continue;
      const bid = num(t.bid, last), ask = num(t.ask, last);
      const open = num(t.open);
      TICK.set(sym, { last, bid, ask, chg: open > 0 ? (last - open) / open * 100 : 0, vol24: num(t.quoteVolume || t.baseVolume), ts: now });
      n++;
    }
    if (!n) logOnce('tick0', 'Ticker gelmedi; evren yenileniyor…', 30e3), refreshUniverse().catch(() => {});
  } catch (e) { logOnce('tickerr', 'Ticker yenileme hatası: ' + (e.message || e), M1); }
}

async function fetchOHLCV(sym, tf, limit) {
  const raw = await ex.fetchOHLCV(sym, tf, undefined, limit);
  return (raw || []).map(toC);
}
async function getCandles(sym, tf, limit, closedOnly) {
  const key = sym + '|' + tf;
  const now = Date.now();
  const hit = CACHE.get(key);
  const ttl = TTL[tf] || M5;
  if (hit && now - hit.at < ttl) return hit.cs;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = (async () => {
    let cs = await fetchOHLCV(sym, tf, limit);
    if (closedOnly && cs.length) {
      const tfMs = TF_MS[tf] || M5;
      cs = cs.filter(c => c.t + tfMs <= now);
    }
    CACHE.set(key, { at: now, cs });
    return cs;
  })().finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  return p;
}

// Tarama listesi: hacim çekirdeği + 24s hareketliler + dönen kalan coinler
// → her turda farklı coinler görülür, altcoinler de sırayla taranır.
function scanSyms(kind, n) {
  const withTick = UNIVERSE.filter(s => TICK.has(s));
  const byVol = withTick.slice().sort((a, b) => (TICK.get(b).vol24 || 0) - (TICK.get(a).vol24 || 0));
  const core = byVol.slice(0, Math.max(10, Math.round(n * 0.4)));
  const byMove = withTick.slice().sort((a, b) => Math.abs(TICK.get(b).chg) - Math.abs(TICK.get(a).chg));
  const movers = byMove.filter(s => !core.includes(s)).slice(0, Math.round(n * 0.25));
  const rest = withTick.filter(s => !core.includes(s) && !movers.includes(s));
  ROT[kind] = (ROT[kind] || 0) % Math.max(1, rest.length);
  const rotN = Math.max(0, n - core.length - movers.length);
  const rotated = rest.length ? rest.slice(ROT[kind]).concat(rest.slice(0, ROT[kind])).slice(0, rotN) : [];
  ROT[kind] = (ROT[kind] + rotN) % Math.max(1, rest.length);
  return core.concat(movers, rotated);
}

/* ── Piyasa yönü (yalnız matematik) ─────────────────────────────────────── */
let market = { dir: 'NOTR', score: 0.5, why: 'henüz hesaplanmadı', breadth: 0.5, at: 0 };

function assetScore(cs15, cs1h) {
  if (!cs15 || cs15.length < 120) return null;
  const cl = closesOf(cs15), i = cl.length - 1;
  const atr = atrLast(cs15, 14);
  const adx = adxLast(cs15, 14);
  if (!atr || atr <= 0) return null;
  const e21 = emaArr(cl, 21), e55 = emaArr(cl, 55);
  const parts = { ema: 0, slope: 0, price: 0, adx: 0, htf: 0 };
  parts.ema = e21[i] > e55[i] ? 0.35 : -0.35;
  const slope = (e21[i] - e21[i - 20]) / atr;
  parts.slope = clamp(slope, -1, 1) * 0.25;
  parts.price = cl[i] > e55[i] ? 0.20 : -0.20;
  if (adx) {
    const s = adx.plusDI >= adx.minusDI ? 1 : -1;
    parts.adx = s * clamp((adx.adx - 18) / 24, 0, 1) * 0.20;
  }
  if (cs1h && cs1h.length >= 60) {
    const c1 = closesOf(cs1h), j = c1.length - 1;
    const a1 = emaArr(c1, 21), b1 = emaArr(c1, 55);
    parts.htf = a1[j] > b1[j] ? 0.15 : -0.15;
  }
  const score = clamp(parts.ema + parts.slope + parts.price + parts.adx + parts.htf, -1, 1);
  return { score: +score.toFixed(3), parts };
}

async function updateMarket() {
  try {
    const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
    const [b15, e15, b1h, e1h] = await Promise.all([
      getCandles(BTC, '15m', 160, true), getCandles(ETH, '15m', 160, true),
      getCandles(BTC, '1h', 120, true), getCandles(ETH, '1h', 120, true)
    ]);
    const b = assetScore(b15, b1h), e = assetScore(e15, e1h);
    if (!b && !e) { logOnce('mknodata', 'PİYASA: BTC/ETH verisi yok; önceki yön korunuyor', 5 * M1); return; }

    let green = 0, total = 0;
    for (const sym of UNIVERSE) { const t = tick(sym); if (!t) continue; total++; if (t.chg > 0) green++; }
    const breadth = total ? green / total : 0.5;
    const breadthScore = clamp((breadth - 0.5) / 0.20, -1, 1);

    const sig = b && e ? (b.score + e.score) / 2 : (b ? b.score : e.score);
    const score = clamp(sig * 0.7 + breadthScore * 0.3, -1, 1);

    // Histerezis: skor eşikleri aşmadıkça mevcut yön korunur (yön NOTR↔LONG
    // arasında gidip gelmez).
    const ENTER = 0.10, HOLD = 0.04;
    const prev = ['LONG', 'SHORT', 'NOTR'].includes(market.dir) ? market.dir : 'NOTR';
    let dir = 'NOTR';
    if (prev === 'LONG') { if (score >= -HOLD) dir = 'LONG'; else if (score <= -ENTER) dir = 'SHORT'; }
    else if (prev === 'SHORT') { if (score <= HOLD) dir = 'SHORT'; else if (score >= ENTER) dir = 'LONG'; }
    else { if (score >= ENTER) dir = 'LONG'; else if (score <= -ENTER) dir = 'SHORT'; }

    market = {
      dir, raw: +score.toFixed(3),
      score: +clamp(0.5 + score * 0.5, 0.05, 0.95).toFixed(2),
      breadth: +breadth.toFixed(3),
      btc: b ? b.score : null, eth: e ? e.score : null,
      at: Date.now(),
      why: 'skor ' + score.toFixed(2) + ' · BTC ' + (b ? b.score.toFixed(2) : 'yok') + ' · ETH ' + (e ? e.score.toFixed(2) : 'yok') + ' · genişlik %' + Math.round(breadth * 100)
    };
    if (dir !== prev) log('PİYASA YÖNÜ: ' + dir + ' (' + market.why + ')');
  } catch (err) {
    log('Piyasa yönü hatası (önceki yön korunuyor): ' + (err.message || err));
  }
}

/* ── Sinyal yöneticisi ───────────────────────────────────────────────────── */
let signals = [];                    // tüm sinyaller (açık + kapanan)
let seq = 1;
let dirty = false;

function isOpen(s) { return s.status === 'ACIK'; }
function openCount(module) { return signals.filter(s => isOpen(s) && s.module === module).length; }
function moduleStats(module) {
  const closed = signals.filter(s => s.module === module && s.status === 'KAPALI');
  const win = closed.filter(s => s.result === 'KAR').length;
  const loss = closed.filter(s => s.result === 'ZARAR').length;
  const time = closed.filter(s => s.result === 'ZAMAN').length;
  const dec = win + loss;
  return { win, loss, time, total: closed.length, winPct: dec ? Math.round(win / dec * 100) : null, open: openCount(module) };
}
function lastSignalAt(sym, module) {
  let best = 0;
  for (const s of signals) if (s.symbol === sym && s.module === module && s.createdAt > best) best = s.createdAt;
  return best;
}
function hasSetup(setupKey) { return signals.some(s => s.setupKey === setupKey); }

// Stop girişin yüzde aralığına çekilir (referans plan): çok sıkı veya çok
// geniş stoplu sinyaller düzeltilir; sinyal hiçbir zaman silinmez.
function clampStop(entry, sl, dir) {
  const d = dir === 'LONG' ? 1 : -1;
  const riskPct = () => Math.abs(entry - sl) / entry * 100;
  if (riskPct() < settings.minStopPct) sl = entry - d * entry * settings.minStopPct / 100;
  if (riskPct() > settings.maxStopPct) sl = entry - d * entry * settings.maxStopPct / 100;
  return { sl: rp(sl), riskPct: +riskPct().toFixed(2) };
}

function emitSignal(cand) {
  if (!cand || !cand.symbol || !['LONG', 'SHORT'].includes(cand.dir)) return null;
  if (hasSetup(cand.setupKey)) return null;
  const now = Date.now();
  if (now - lastSignalAt(cand.symbol, cand.module) < settings.signalCooldownMin * M1) return null;
  if (openCount(cand.module) >= 10) return null;

  const entry = rp(cand.entry);
  const stopFix = clampStop(entry, cand.sl, cand.dir);
  const d = cand.dir === 'LONG' ? 1 : -1;
  const risk = Math.abs(entry - stopFix.sl);
  if (!(risk > 0)) return null;
  const tp1 = rp(entry + d * 1.5 * risk);
  const tp2 = rp(entry + d * 2.5 * risk);

  const sig = {
    id: 'S' + (seq++) + '-' + now.toString(36),
    module: cand.module, symbol: cand.symbol, base: baseOf(cand.symbol),
    dir: cand.dir, entry, sl: stopFix.sl, tp1, tp2,
    riskPct: +((risk / entry) * 100).toFixed(2),
    conf: clamp(Math.round(num(cand.conf, 60)), 1, 100),
    note: cand.note || '', info: cand.info || {},
    tf: cand.tf || '',
    createdAt: now, maxAgeMs: cand.maxAgeMs || 6 * H1,
    status: 'ACIK', result: null, exit: null, exitAt: null
  };
  signals.push(sig);
  capArr(signals, 600);
  dirty = true;
  log('SİNYAL: ' + MODS[sig.module].label + ' | ' + sig.base + ' | ' + sig.dir +
    ' | giriş ' + sig.entry + ' | TP1 ' + sig.tp1 + ' | TP2 ' + sig.tp2 + ' | SL ' + sig.sl +
    ' | güven ' + sig.conf + (sig.tf ? ' | ' + sig.tf : ''));
  return sig;
}
function capArr(a, n) { if (a.length > n) a.splice(0, a.length - n); return a; }

// Takip: canlı fiyatla TP1 → KAR, stop → ZARAR, süre → ZAMAN.
function trackSignals() {
  const now = Date.now();
  for (const s of signals) {
    if (!isOpen(s)) continue;
    const px = priceOf(s.symbol);
    if (!(px > 0)) continue;
    const d = s.dir === 'LONG' ? 1 : -1;
    if (d * (px - s.sl) <= 0) { closeSignal(s, px, 'ZARAR'); continue; }
    if (d * (px - s.tp1) >= 0) { closeSignal(s, px, 'KAR'); continue; }
    if (now - s.createdAt > s.maxAgeMs) { closeSignal(s, px, 'ZAMAN'); continue; }
  }
}
function closeSignal(s, px, result) {
  s.status = 'KAPALI'; s.result = result; s.exit = rp(px); s.exitAt = Date.now();
  dirty = true;
  const pnlPct = +(((s.exit - s.entry) / s.entry * 100) * (s.dir === 'LONG' ? 1 : -1)).toFixed(2);
  log('SONUÇ: ' + MODS[s.module].label + ' | ' + s.base + ' ' + s.dir + ' → ' + result +
    ' (giriş ' + s.entry + ' → çıkış ' + s.exit + ', %' + pnlPct + ')');
}

/* ── Kalıcı durum ────────────────────────────────────────────────────────── */
function saveState(force) {
  if (!force && !dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ v: 1, settings, signals, seq, savedAt: Date.now() }));
  } catch (e) { /* disk hatası ölümcül değil */ }
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      settings = Object.assign({}, DEF_SET, raw.settings || {});
      signals = Array.isArray(raw.signals) ? raw.signals.filter(s => s && s.id && s.symbol) : [];
      seq = Math.max(1, num(raw.seq, signals.length + 1));
      // Yeniden başlatmada eski açık sinyaller kaldığı yerden takip edilir.
    }
  } catch (e) { /* ilk açılış */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEJİ 1 — TREND TAKİP (15m)
   ─────────────────────────────────────────────────────────────────────────
   Rejim (son KAPANMIŞ 15m mumlar): EMA21>EMA55 + fiyat EMA55 üstü + EMA21 eğimi
   yönünde + ADX≥20 ve +DI/-DI üstünlüğü. Rejim yoksa sinyal yok (nötr piyasa).
   Giriş: son 18 mum içinde EMA21/55 bölgesine geri çekilme oldu MU + son
   KAPANMIŞ mum önceki 8 mumun yapısını (tepe/dip) trend yönünde kırdı MI.
   Mum kalitesi, hacim ve kapanış konumu teyit eder. Piyasa yönü ve coin
   rejimi sinyal yönüyle AYNI olmalı; ters yönde sinyal üretilmez.
   ═══════════════════════════════════════════════════════════════════════════ */
const MODS = {
  TREND: { label: 'Trend Takip', tf: '15m' },
  HIZLI: { label: 'Hızlı Trend', tf: '5m' },
  LT: { label: 'LT Üçgen', tf: '1h+2h' }
};

function trendRegime(cs) {
  if (!cs || cs.length < 80) return null;
  const cl = closesOf(cs), i = cl.length - 1;
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;
  const e21 = emaArr(cl, 21), e55 = emaArr(cl, 55);
  const adx = adxLast(cs, 14);
  // Eğim: 20 mumluk (5 saat) — ana trend yönünü ölçer, geri çekilmede bozulmaz.
  const slopeAtr = (e21[i] - e21[i - 20]) / atr;
  let dir = null;
  if (e21[i] > e55[i] && cl[i] > e55[i] && slopeAtr > 0.05) dir = 'LONG';
  else if (e21[i] < e55[i] && cl[i] < e55[i] && slopeAtr < -0.05) dir = 'SHORT';
  if (dir && adx) {
    if (adx.adx < 20) dir = null;
    else if (dir === 'LONG' && adx.plusDI <= adx.minusDI) dir = null;
    else if (dir === 'SHORT' && adx.minusDI <= adx.plusDI) dir = null;
  } else if (dir && !adx) dir = null;
  return {
    dir, atr, px: cl[i], slopeAtr: +slopeAtr.toFixed(2),
    e21: e21[i], e55: e55[i],
    adx: adx ? +adx.adx.toFixed(1) : null,
    plusDI: adx ? +adx.plusDI.toFixed(1) : null,
    minusDI: adx ? +adx.minusDI.toFixed(1) : null
  };
}

function trendCheck(sym, cs) {
  if (!cs || cs.length < 90) return { watch: null };
  const n = cs.length, last = cs[n - 1]; // son mum KAPANMIŞ
  const reg = trendRegime(cs);
  if (!reg || !reg.dir) return { watch: { sym, state: 'REJIM_YOK', adx: reg ? reg.adx : null } };

  // Ters yön filtresi: piyasa yönü sinyal yönüyle aynı olmalı.
  if (market.dir !== 'NOTR' && market.dir !== reg.dir)
    return { watch: { sym, state: 'PIYASA_TERSTE', dir: reg.dir, adx: reg.adx } };

  const d = reg.dir === 'LONG' ? 1 : -1;
  const atr = reg.atr;

  // 1) Geri çekilme: son 18 mumda fiyat EMA21/EMA55 bandına değdi mi?
  const look = cs.slice(-19, -1);
  const zoneHi = Math.max(reg.e21, reg.e55) + 0.15 * atr;
  const zoneLo = Math.min(reg.e21, reg.e55) - 0.15 * atr;
  if (!look.some(c => c.l <= zoneHi && c.h >= zoneLo))
    return { watch: { sym, state: 'GERI_CEKILME_YOK', dir: reg.dir, adx: reg.adx } };

  // 2) Yapı kırılımı: son kapanmış mum, önceki 8 kapanmış mumun tepe/dibini geçti mi?
  const prior = cs.slice(-9, -1);
  const level = d === 1 ? Math.max.apply(null, prior.map(c => c.h)) : Math.min.apply(null, prior.map(c => c.l));
  if (!(d * (last.c - level) > 0))
    return { watch: { sym, state: 'TETIK_BEKLENIYOR', dir: reg.dir, level: rp(level), adx: reg.adx } };

  // 3) Mum kalitesi + hacim teyidi
  if (d * (last.c - last.o) <= 0) return { watch: { sym, state: 'MUM_YONSUZ', dir: reg.dir, adx: reg.adx } };
  if (bodyRatio(last) < 0.35 || bodyAtr(last, atr) < 0.30) return { watch: { sym, state: 'MUM_ZAYIF', dir: reg.dir, adx: reg.adx } };
  const rangeAtr = (last.h - last.l) / atr;
  if (rangeAtr < 0.5) return { watch: { sym, state: 'MENZIL_DAR', dir: reg.dir, adx: reg.adx } };
  const closePos = (last.c - last.l) / Math.max(1e-9, last.h - last.l);
  if (d === 1 ? closePos < 0.60 : closePos > 0.40) return { watch: { sym, state: 'KAPANIS_ZAYIF', dir: reg.dir, adx: reg.adx } };
  const vol20 = avg(cs.slice(-21, -1).map(c => c.v));
  const vr = vol20 > 0 ? last.v / vol20 : 0;
  if (vr < 1.20) return { watch: { sym, state: 'HACIM_DUSUK', dir: reg.dir, vr: +vr.toFixed(2), adx: reg.adx } };

  // 4) Kovalamaca yok: canlı fiyat tetik kapanışının 0.20 ATR ötesine kaçtıysa bekle.
  const px = priceOf(sym) || last.c;
  if (!(Math.abs(px - last.c) <= 0.20 * atr)) return { watch: { sym, state: 'FIYAT_KACTI', dir: reg.dir, adx: reg.adx } };

  // 5) Stop: son 6 mumun yapısal ucu + 0.30 ATR pay
  const sw = cs.slice(-6);
  const sl = d === 1
    ? Math.min.apply(null, sw.map(c => c.l)) - 0.30 * atr
    : Math.max.apply(null, sw.map(c => c.h)) + 0.30 * atr;

  const conf = clamp(Math.round(55 + reg.adx + (vr - 1) * 10 + Math.abs(reg.slopeAtr) * 6 + (market.dir === reg.dir ? 6 : 0)), 40, 95);
  return {
    cand: {
      module: 'TREND', symbol: sym, dir: reg.dir, entry: px, sl, conf, tf: '15m',
      note: '15m EMA21/55 trend + geri çekilme sonrası yapı kırılımı',
      info: { adx: reg.adx, slopeAtr: reg.slopeAtr, trigger: rp(level), volRatio: +vr.toFixed(2), marketDir: market.dir },
      maxAgeMs: 8 * H1,
      setupKey: 'TREND|' + sym + '|' + last.t + '|' + reg.dir
    }
  };
}

async function trendScan() {
  if (!settings.trendEnabled) return;
  if (market.dir === 'NOTR') { logOnce('trendnotr', 'Trend Takip: piyasa NOTR, tarama atlandı', 5 * M1); return; }
  const list = scanSyms('trend', settings.trendScan);
  let found = 0;
  await pool(list, 6, async (sym) => {
    if (spreadPct(sym) > 0.12) return;
    try {
      const cs = await getCandles(sym, '15m', 200, true);
      const r = trendCheck(sym, cs);
      if (r.cand) { const s = emitSignal(r.cand); if (s) found++; }
    } catch (e) { /* tek coin atlanır */ }
  });
  lastScan.trend = Date.now();
  if (found) log('Trend taraması: ' + found + ' sinyal (' + list.length + ' coin)');
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEJİ 2 — HIZLI TREND (5m)  [OtoTrade'in yerine]
   ─────────────────────────────────────────────────────────────────────────
   Günlük hızlı işlemler için indikatör momentumu. 5m rejim: EMA21/EMA55
   dizilimi + ADX≥18. Tetik: son KAPANMIŞ mumda EMA9, EMA21'i rejim yönünde
   YENİ kesti (bir önceki mum henüz kesmemişti) ve fiyat VWAP'ın doğru
   tarafında, RSI momentum bölgesinde (LONG 50–72 / SHORT 28–50), hacim
   ≥1.4x. Rejim yoksa / piyasa tersse / momentum nötrse sinyal yok.
   ═══════════════════════════════════════════════════════════════════════════ */
function hizliRegime(cs) {
  if (!cs || cs.length < 70) return null;
  const cl = closesOf(cs), i = cl.length - 1;
  const atr = atrLast(cs, 14);
  const adx = adxLast(cs, 14);
  if (!atr || atr <= 0 || !adx) return null;
  const e21 = emaArr(cl, 21), e55 = emaArr(cl, 55);
  let dir = null;
  if (e21[i] > e55[i] && adx.adx >= 18 && adx.plusDI > adx.minusDI) dir = 'LONG';
  else if (e21[i] < e55[i] && adx.adx >= 18 && adx.minusDI > adx.plusDI) dir = 'SHORT';
  return { dir, atr, adx: +adx.adx.toFixed(1), e21: e21[i], e55: e55[i], e9arr: emaArr(cl, 9), e21arr: e21 };
}

function hizliCheck(sym, cs) {
  if (!cs || cs.length < 70) return { watch: null };
  const n = cs.length, last = cs[n - 1], prev = cs[n - 2];
  const reg = hizliRegime(cs);
  if (!reg || !reg.dir) return { watch: { sym, state: 'REJIM_YOK' } };
  if (market.dir !== 'NOTR' && market.dir !== reg.dir)
    return { watch: { sym, state: 'PIYASA_TERSTE', dir: reg.dir } };

  const d = reg.dir === 'LONG' ? 1 : -1;
  const atr = reg.atr;
  const e9 = reg.e9arr, e21 = reg.e21arr, i = n - 1;

  // Taze kesişim: bu mumda EMA9 EMA21'i yönünde kesmiş, önceki mumda kesmemiş.
  const crossedNow = d === 1 ? e9[i] > e21[i] : e9[i] < e21[i];
  const crossedPrev = d === 1 ? e9[i - 1] > e21[i - 1] : e9[i - 1] < e21[i - 1];
  if (!crossedNow || crossedPrev) return { watch: { sym, state: 'KESISIM_YOK', dir: reg.dir } };

  // Fiyat yön lehine: mum kapanışı EMA21'in ötesinde ve VWAP'ın doğru tarafında.
  if (d * (last.c - e21[i]) <= 0) return { watch: { sym, state: 'Fiyat EMA21 yanlış tarafta', dir: reg.dir } };
  const dayStart = Math.floor(Date.now() / (24 * H1)) * 24 * H1;
  const vw = vwapOf(cs, dayStart);
  if (d * (last.c - vw.vwap) < 0) return { watch: { sym, state: 'VWAP_KARŞI', dir: reg.dir } };

  // RSI momentum bölgesi (aşırı alım/teslimatta kovalamaca yok)
  const cl = closesOf(cs);
  const rsi = rsiLast(cl, 14);
  if (rsi == null) return { watch: { sym, state: 'RSI_YOK', dir: reg.dir } };
  if (d === 1 && !(rsi >= 50 && rsi <= 72)) return { watch: { sym, state: 'RSI_UYGUN_DEGIL(' + Math.round(rsi) + ')', dir: reg.dir } };
  if (d === -1 && !(rsi >= 28 && rsi <= 50)) return { watch: { sym, state: 'RSI_UYGUN_DEGIL(' + Math.round(rsi) + ')', dir: reg.dir } };

  // Hacim + mum kalitesi
  const vol20 = avg(cs.slice(-21, -1).map(c => c.v));
  const vr = vol20 > 0 ? last.v / vol20 : 0;
  if (vr < 1.40) return { watch: { sym, state: 'HACIM_DUSUK', dir: reg.dir, vr: +vr.toFixed(2) } };
  if (bodyRatio(last) < 0.40) return { watch: { sym, state: 'MUM_ZAYIF', dir: reg.dir } };

  // Kovalamaca yok
  const px = priceOf(sym) || last.c;
  if (!(Math.abs(px - last.c) <= 0.20 * atr)) return { watch: { sym, state: 'FIYAT_KACTI', dir: reg.dir } };

  // Stop: son 8 mumun yapısal ucu + 0.25 ATR
  const sw = cs.slice(-8);
  const sl = d === 1
    ? Math.min.apply(null, sw.map(c => c.l)) - 0.25 * atr
    : Math.max.apply(null, sw.map(c => c.h)) + 0.25 * atr;

  const conf = clamp(Math.round(52 + reg.adx + (vr - 1) * 12 + (market.dir === reg.dir ? 6 : 0)), 40, 95);
  return {
    cand: {
      module: 'HIZLI', symbol: sym, dir: reg.dir, entry: px, sl, conf, tf: '5m',
      note: '5m EMA9/21 kesişim + VWAP + RSI(' + Math.round(rsi) + ') momentum',
      info: { adx: reg.adx, rsi: +rsi.toFixed(1), volRatio: +vr.toFixed(2), vwap: rp(vw.vwap), marketDir: market.dir },
      maxAgeMs: 3 * H1,
      setupKey: 'HIZLI|' + sym + '|' + last.t + '|' + reg.dir
    }
  };
}

async function hizliScan() {
  if (!settings.hizliEnabled) return;
  if (market.dir === 'NOTR') { logOnce('hizlinotr', 'Hızlı Trend: piyasa NOTR, tarama atlandı', 5 * M1); return; }
  const list = scanSyms('hizli', settings.hizliScan);
  let found = 0;
  await pool(list, 6, async (sym) => {
    if (spreadPct(sym) > 0.12) return;
    try {
      const cs = await getCandles(sym, '5m', 160, true);
      const r = hizliCheck(sym, cs);
      if (r.cand) { const s = emitSignal(r.cand); if (s) found++; }
    } catch (e) { /* tek coin atlanır */ }
  });
  lastScan.hizli = Date.now();
  if (found) log('Hızlı tarama: ' + found + ' sinyal (' + list.length + ' coin)');
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEJİ 3 — LT ÜÇGEN (1h + 2h)
   ─────────────────────────────────────────────────────────────────────────
   Kullanıcının çizim tarzı: pencerenin EN YÜKSEK tepesi ile EN DÜŞÜK dibi
   üçgenin başlangıcıdır; üst çizgi tepeden, alt çizgi dibinden başlayıp son
   kapanmış 3 mumun tepe/dibi üzerinden uzatılır ve çizgiler SAĞDA birleşir.
   Bu doğal olarak simetrik üçgeni bulur (tepe alçalan + dip yükselen).
   Form kuralı: üst çizgi eğimi < alt çizgi eğimi (daralma), apeks 5–260 mum
   ileride, olgunluk ≥ %45, sıkışma ≥ %45, fiyat çizgilerin arasında kalmış.
   SİNYAL: fiyat canlı olarak üst çizgiye/alt çizgiye DEĞER değmez — çizgiyi
   0.05 ATR kadar geçer geçmez üretilir (mum kapanması beklenmez).
   Yön: üst çizgi → LONG, alt çizgi → SHORT. Bir üçgenden yalnızca İLK
   kırılım sinyal üretir (sonraki değmeler izlenmez).
   ═══════════════════════════════════════════════════════════════════════════ */
const LT_WATCH = new Map();  // sym|tf → { tri, cs, lastCheck, fired }
let ltQueue = [];            // round-robin kuyruğu
let ltPtr = 0;

function triUpperAt(tri, i) { return tri.hi.intercept + tri.hi.slope * (i - tri.refIdx); }
function triLowerAt(tri, i) { return tri.lo.intercept + tri.lo.slope * (i - tri.refIdx); }

// Kullanıcı çizim tarzı üçgen: tepe → son 3 kapanmış mumun tepesi;
// dip adayları → (a) tepeden SONRAKI en düşük dip  (b) tepe ÖNCESİKİ en düşük dip.
function buildTriangle(cs, tf) {
  if (!cs || cs.length < 200) return null;
  const n = cs.length, refIdx = n - 1;
  const atr = atrLast(cs, 14);
  if (!atr || atr <= 0) return null;

  const win = Math.min(n, 600), from = n - win;
  let hiBar = null;
  for (let i = from; i < n; i++) if (!hiBar || cs[i].h > hiBar.p) hiBar = { i, t: cs[i].t, p: cs[i].h };
  // Tepe son ~8 mum içindeyse üçgen henüz şekil değildir (kırılımın tepeyi
  // yenilemesi beklenir). Tepe pencerenin başında OLABİLİR — yükselen/simetrik
  // üçgenlerde tepe genelde serinin en başındadır ve bu geçerli bir şekildir.
  if (!hiBar || hiBar.i > refIdx - 8) return null;

  // Tek iğne (spike) kontrolü: tepe komşu mumlardan 12 ATR fazla yukarıdaysa
  // gerçek sıkışma değil tek fitildir. (Eski 2.2 ATR eşiği, yüksek tepeden
  // başlayan simetrik üçgenlerin tamamını haksız yere eliyordu.)
  let top2 = -Infinity;
  for (let k = Math.max(from, hiBar.i - 200); k < n; k++) {
    if (Math.abs(k - hiBar.i) > 5) top2 = Math.max(top2, cs[k].h);
  }
  if (hiBar.p - top2 > 12 * atr) return null;

  let loAfter = null, loBefore = null;
  for (let i = hiBar.i; i < n; i++) if (!loAfter || cs[i].l < loAfter.p) loAfter = { i, t: cs[i].t, p: cs[i].l };
  for (let i = from; i <= hiBar.i; i++) if (!loBefore || cs[i].l < loBefore.p) loBefore = { i, t: cs[i].t, p: cs[i].l };
  const dipCandidates = [loAfter, loBefore].filter(x => x && Math.abs(x.i - hiBar.i) >= 5 && x.i <= refIdx - 3);

  // Not: çizgiler artık uç nokta + pivot temaslarından uyduruluyor; son 3
  // mumun tepe/dibi referansı kullanılmıyor (kırılım anında çizgi bozulmaz).

  // Çizgi uydurma (elle çizimin bilgisayar hali):
  // 1) Uç nokta + her pivot tepe/dip ikilisinden aday eğimler üretilir
  //    (RANSAC tarzı) — en çok TEMAS toplayan eğim kazanır. İçerideki
  //    gürültü mumları tek eğimde toplanamayacağından gerçek sınır çizgisi
  //    seçilir; "son 3 mum tepeye değmedi" gibi durumlar çizgiyi bozmaz.
  // 2) Seçilen eğim etrafında yineleme: temaslar → ilk/son temastan eğim →
  //    temaslara en küçük kareler oturtma. Kesim noktası tepeyi zorunlu
  //    tutmaz; tek mumluk fitil gürültüsü çizgiyi kaydırmaz.
  function collectTouches(side, slope, iv) {
    const at = i => iv + slope * i;
    const found = [];
    let lastK = -99;
    for (let k = from; k <= refIdx - 1; k++) {
      const c = cs[k], v = at(k);
      const d = side === 'H' ? c.h - v : v - c.l;
      if (d >= -0.35 * atr && d <= 0.40 * atr && k - lastK >= 4) { found.push({ i: k, p: side === 'H' ? c.h : c.l, d }); lastK = k; }
    }
    return found;
  }
  // Ağırlıklı en küçük kareler: çizgiye TAM değen noktalar (d≈0) tam ağırlık,
  // toleransın kenarındaki gürültü noktaları az ağırlık — eğim sapması kalkar.
  function wlsq(touches) {
    let W = 0, Swi = 0, Swp = 0, Sww = 0, Swip = 0;
    for (const t of touches) {
      const w = 1 / (1 + (t.d / (0.30 * atr)) * (t.d / (0.30 * atr)));
      W += w; Swi += w * t.i; Swp += w * t.p; Sww += w * t.i * t.i; Swip += w * t.i * t.p;
    }
    if (W <= 0 || (Sww - Swi * Swi / W) <= 0) return null;
    const slope = (Swip - Swi * Swp / W) / (Sww - Swi * Swi / W);
    const iv = (Swp - slope * Swi) / W;
    return { slope, iv };
  }
  function fitLine(anchor, side, pivs) {
    const sidePivs = pivs.filter(q => q.i > anchor.i + 10 && q.i <= refIdx - 1);
    let best = null;
    for (const q of sidePivs) {
      const slope = (q.p - anchor.p) / (q.i - anchor.i);
      // Aday çizgi uç noktadan geçer: iv = p - slope*i
      const iv = anchor.p - slope * anchor.i;
      const touches = collectTouches(side, slope, iv);
      if (touches.length < 2) continue;
      const lastT = touches[touches.length - 1].i;
      if (lastT < refIdx - 100) continue;      // teması çok eski = eski şekil
      const score = touches.length * 10 + lastT * 0.02;
      if (!best || score > best.score) best = { slope, iv, touches, score, lastT };
    }
    if (!best) return null;
    // Yinelemeli iyileştirme: temaslar toplanır → ağırlıklı en küçük kareler →
    // yeni çizgiyle temaslar yeniden toplanır (2 tur).
    let { slope, iv } = best;
    let touches = best.touches;
    for (let iter = 0; iter < 2; iter++) {
      const fit = wlsq(touches);
      if (!fit) break;
      slope = fit.slope; iv = fit.iv;
      const found = collectTouches(side, slope, iv);
      if (found.length < 2) break;
      touches = found;
    }
    const fit = wlsq(touches);
    if (fit) { slope = fit.slope; iv = fit.iv; }
    return { slope, intercept: iv, touches: touches.length + 1, lastT: touches.length ? touches[touches.length - 1].i : anchor.i };
  }
  const pivsH = [], pivsL = [];
  for (let k = from + 2; k <= refIdx - 3; k++) {
    const c = cs[k];
    if (c.h >= cs[k - 1].h && c.h >= cs[k + 1].h && c.h > cs[k - 2].h && c.h > cs[k + 2].h) pivsH.push({ i: k, p: c.h });
    if (c.l <= cs[k - 1].l && c.l <= cs[k + 1].l && c.l < cs[k - 2].l && c.l < cs[k + 2].l) pivsL.push({ i: k, p: c.l });
  }

  let best = null;
  for (const loBar of dipCandidates) {
    const fH = fitLine(hiBar, 'H', pivsH);
    const fL = fitLine(loBar, 'L', pivsL);
    if (!fH || !fL) continue;
    if (fH.touches < 2 || fL.touches < 2) continue;        // her çizgide ≥2 değme
    const hiSlope = fH.slope, loSlope = fL.slope;
    const hiIv = fH.intercept + hiSlope * refIdx;          // refIdx'deki değer
    const loIv = fL.intercept + loSlope * refIdx;
    if (!(hiSlope < loSlope)) continue;                      // sağda birleşmeli
    const apexX = (loIv - hiIv) / (hiSlope - loSlope);
    if (!(apexX >= 5) || apexX > 320) continue;            // apeks 5–320 mum ileride
    const firstIdx = Math.min(hiBar.i, loBar.i);
    const maturity = clamp((refIdx - firstIdx) / Math.max(1, refIdx + apexX - firstIdx), 0, 1);
    if (maturity < 0.45) continue;
    const hiAt = i => hiIv + hiSlope * (i - refIdx);
    const loAt = i => loIv + loSlope * (i - refIdx);
    const pxNow = cs[n - 1].c;
    // Genişlik sınırları: hem ATR'a hem fiyata göre — sadece ATR'a bağlamak
    // yüksek sıkışmalı üçgenlerin ATR'ı küçüldüğünde sağlıklı üçgeni eliyordu.
    const widthNow = hiIv - loIv;
    if (!(widthNow > Math.max(0.05 * atr, 0.0005 * pxNow))) continue;
    if (widthNow > Math.min(25 * atr, 0.07 * pxNow)) continue;
    const widthStart = hiAt(firstIdx) - loAt(firstIdx);
    if (!(widthStart > 0) || widthStart > Math.min(60 * atr, 0.15 * pxNow)) continue;
    const compression = clamp(1 - widthNow / widthStart, 0, 1);
    if (compression < 0.45) continue;

    // Fiyat üçgen içinde kalmalı: çizgileri anlamlı şekilde aşan geçmiş mum yok.
    // SON 3 KAPANMIŞ MUM ihlal denetimine DAHİL DEĞİLDİR — kırılım anında
    // üçgen silinmesin diye (kırılım mumu geçmiş ihlal sayılmaz; sinyal, fiyat
    // çizgiye canlı değdiğinde ltTick tarafında üretilir).
    let violated = false;
    for (let k = firstIdx + 1; k <= refIdx - 4; k++) {
      const c = cs[k];
      // Eşikler çizgi uydurma gürültüsünden (±~0.3 ATR) geniş: amaç, çizgiyi
      // ÇOKTAN anlamlı şekilde aşmış (kırılım geçmişi) yapıları elemek.
      if (c.h > hiAt(k) + 0.55 * atr || c.c > hiAt(k) + 0.40 * atr) { violated = true; break; }
      if (c.l < loAt(k) - 1.00 * atr || c.c < loAt(k) - 0.60 * atr) { violated = true; break; }
    }
    if (violated) continue;

    // Sıkışma hacmi: son 20 mum hacmi, önceki 30 mumun altında olmalı (izlenir).
    const vol20 = avg(cs.slice(-20).map(c => c.v));
    const volPrev = avg(cs.slice(-50, -20).map(c => c.v));
    const volContraction = volPrev > 0 ? clamp(1 - vol20 / volPrev, -1, 1) : 0;

    // Form sınıfı: eğimler ATR/100-bar cinsinden; |s|<0.15 "düz" sayılır.
    const hi100 = hiSlope * 100 / atr, lo100 = loSlope * 100 / atr;
    const hiDir = hi100 < -0.15 ? 'D' : hi100 > 0.15 ? 'U' : 'F';
    const loDir = lo100 < -0.15 ? 'D' : lo100 > 0.15 ? 'U' : 'F';
    const shape = (hiDir === 'D' && loDir === 'U') ? 'SİMETRİK'
      : (hiDir === 'D' && loDir !== 'U') ? 'ALÇALAN'
      : (hiDir !== 'D' && loDir === 'U') ? 'YÜKSELEN' : 'KAMA';

    const score = clamp(Math.round(40 + compression * 25 + maturity * 20 + clamp(volContraction, 0, 1) * 8), 0, 100);
    const cand = {
      ok: true, tf, refIdx, atr, px: cs[n - 1].c,
      hi: { slope: hiSlope, intercept: hiIv },
      lo: { slope: loSlope, intercept: loIv },
      upperNow: hiIv, lowerNow: loIv,
      widthNow: +widthNow.toFixed(8), widthPct: +(widthNow / cs[n - 1].c * 100).toFixed(2),
      compression: +compression.toFixed(3), maturity: +maturity.toFixed(3),
      apexX: +apexX.toFixed(1), apexAt: cs[refIdx].t + Math.round(apexX) * (TF_MS[tf] || H2),
      firstIdx, firstT: cs[firstIdx].t, spanBars: refIdx - firstIdx,
      shape, score, volContraction: +volContraction.toFixed(2),
      hiStart: { i: hiBar.i, p: rp(hiBar.p), t: hiBar.t },
      loStart: { i: loBar.i, p: rp(loBar.p), t: loBar.t },
      tfMs: TF_MS[tf] || H2
    };
    if (!best || cand.score > best.score) best = cand;
  }
  return best;
}

function triangleView(tri) {
  if (!tri) return null;
  return {
    tf: tri.tf, shape: tri.shape, score: tri.score,
    upper: rp(triUpperAt(tri, tri.refIdx)), lower: rp(triLowerAt(tri, tri.refIdx)),
    widthPct: tri.widthPct, compression: tri.compression, maturity: tri.maturity,
    apexAt: tri.apexAt, apexX: tri.apexX, spanBars: tri.spanBars,
    hiStart: tri.hiStart, loStart: tri.loStart,
    volContraction: tri.volContraction
  };
}

// LT taraması: round-robin. Her tur 1 coin × (1h+2h) güncellenir.
async function ltStep() {
  if (!settings.ltEnabled) return;
  if (!ltQueue.length) ltQueue = scanSyms('lt', settings.ltScan);
  if (!ltQueue.length) return;
  const sym = ltQueue[ltPtr++ % ltQueue.length];
  if (ltPtr >= ltQueue.length) { ltPtr = 0; ltQueue = []; lastScan.lt = Date.now(); }

  for (const tf of ['1h', '2h']) {
    const key = sym + '|' + tf;
    try {
      const cs = await getCandles(sym, tf, 620, true);
      const tri = buildTriangle(cs, tf);
      if (tri) {
        LT_WATCH.set(key, { tri, cs, lastCheck: Date.now(), fired: false });
      } else {
        // Üçgen bozuldu/apeks geçti → izlemeden düşür (sinyal üretilmediyse)
        const old = LT_WATCH.get(key);
        if (old && !old.fired) LT_WATCH.delete(key);
      }
    } catch (e) { /* tek coin atlanır */ }
  }
}

// Canlı dokunuş kontrolü: fiyat çizgiyi 0.05 ATR geçer geçmez sinyal.
function ltTick() {
  if (!settings.ltEnabled) return;
  const now = Date.now();
  for (const [key, e] of Array.from(LT_WATCH.entries())) {
    const { tri } = e;
    if (e.fired) { LT_WATCH.delete(key); continue; }
    if (now - e.lastCheck > 30 * M1) { LT_WATCH.delete(key); continue; } // taze kalmadı
    const sym = key.split('|')[0];
    const px = priceOf(sym);
    if (!(px > 0)) continue;
    const i = e.cs.length - 1;
    const up = triUpperAt(tri, i), dn = triLowerAt(tri, i);
    const atr = tri.atr;

    // Üçgenin hâlâ geçerli olup olmadığı: çizgiler aşırı daraldıysa (apeks
    // geçildi) izleme biter.
    if (up - dn < 0.05 * atr) { LT_WATCH.delete(key); continue; }

    const touchUp = px >= up + 0.05 * atr;
    const touchDn = px <= dn - 0.05 * atr;
    if (!touchUp && !touchDn) continue;

    // Kovalamaca yok: çizgiden 1.6 ATR öteye kaçmışsa sinyal verilmez.
    const line = touchUp ? up : dn;
    const dir = touchUp ? 'LONG' : 'SHORT';
    if (Math.abs(px - line) > 1.6 * atr) { continue; }

    // Alt sinyal: piyasa yönüyle çelişiyorsa üretme (ters sinyal yok).
    if (market.dir !== 'NOTR' && market.dir !== dir) continue;

    const d = dir === 'LONG' ? 1 : -1;
    // Stop: karşı çizginin ötesi + 0.35 ATR (üçgen dışına dönüş = setup öldü).
    const slRef = dir === 'LONG' ? dn - 0.35 * atr : up + 0.35 * atr;
    const height = Math.max(tri.widthNow, 1.2 * Math.abs(px - slRef));

    const conf = clamp(Math.round(50 + tri.compression * 20 + tri.maturity * 15 + tri.score * 0.15), 40, 95);
    const sig = emitSignal({
      module: 'LT', symbol: sym, dir, entry: px, sl: slRef, conf, tf: tri.tf,
      note: tri.shape + ' üçgen ' + (dir === 'LONG' ? 'üst çizgi' : 'alt çizgi') + ' kırılımı',
      info: {
        shape: tri.shape, upper: rp(up), lower: rp(dn), line: rp(line),
        compression: tri.compression, maturity: tri.maturity, apexX: tri.apexX,
        spanBars: tri.spanBars, volContraction: tri.volContraction, marketDir: market.dir
      },
      maxAgeMs: 12 * H1,
      setupKey: 'LT|' + sym + '|' + tri.firstT + '|' + tri.tf
    });
    if (sig) { e.fired = true; LT_WATCH.delete(key); }
  }
}

/* ── Express API ─────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
// ALPHASON_API_TOKEN tanımlıysa API korunur (web arayüzü token'ı localStorage'da tutar).
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next();
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-api-key'];
  if (!tokenMatches(token)) return res.status(401).json({ error: 'Yetkisiz: Bearer token gerekli.' });
  next();
});
const h = fn => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch(e => {
    log('API HATASI: ' + req.method + ' ' + req.path + ' → ' + (e.message || e));
    if (!res.headersSent) res.status(500).json({ error: e.message || 'sunucu hatası' });
  });
};
const viewSig = s => ({
  id: s.id, module: s.module, symbol: s.symbol, base: s.base, dir: s.dir,
  entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, riskPct: s.riskPct,
  conf: s.conf, tf: s.tf, note: s.note, info: s.info,
  createdAt: s.createdAt, status: s.status, result: s.result,
  exit: s.exit, exitAt: s.exitAt, maxAgeMs: s.maxAgeMs,
  livePrice: priceOf(s.symbol) || null,
  livePnlPct: s.status === 'ACIK' && priceOf(s.symbol) > 0
    ? +(((priceOf(s.symbol) - s.entry) / s.entry * 100) * (s.dir === 'LONG' ? 1 : -1)).toFixed(2)
    : null
});

let lastScan = { trend: 0, hizli: 0, lt: 0, tick: 0 };
let READY = false;

app.get('/', (req, res) => {
  const p = path.join(__dirname, 'index.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.type('text/plain').send('AlphaSon ' + VERSION + ' çalışıyor. Arayüz için index.html koyun.');
});
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, ready: READY, market: market.dir, signals: signals.filter(isOpen).length }));

app.get('/api/state', h((req, res) => {
  const modules = {};
  for (const k of Object.keys(MODS)) {
    modules[k] = {
      label: MODS[k].label, tf: MODS[k].tf,
      enabled: k === 'TREND' ? settings.trendEnabled : k === 'HIZLI' ? settings.hizliEnabled : settings.ltEnabled,
      stats: moduleStats(k)
    };
  }
  res.json({
    version: VERSION, at: Date.now(), ready: READY, market, settings, modules,
    universe: UNIVERSE.length,
    scan: {
      trendAt: lastScan.trend, hizliAt: lastScan.hizli, ltAt: lastScan.lt, tickAt: lastScan.tick,
      ltWatch: LT_WATCH.size
    },
    counts: {
      open: signals.filter(isOpen).length,
      closed: signals.filter(s => s.status === 'KAPALI').length,
      total: signals.length
    },
    tokenRequired: !!API_TOKEN
  });
}));

app.get('/api/signals', h((req, res) => {
  const mod = String(req.query.module || '').toUpperCase();
  let list = signals.slice();
  if (mod && MODS[mod]) list = list.filter(s => s.module === mod);
  const active = list.filter(isOpen).sort((a, b) => b.createdAt - a.createdAt).map(viewSig);
  const closed = list.filter(s => s.status === 'KAPALI').sort((a, b) => (b.exitAt || 0) - (a.exitAt || 0)).slice(0, 200).map(viewSig);
  res.json({ active, closed });
}));

app.get('/api/watch', h((req, res) => {
  const rows = [];
  for (const [key, e] of LT_WATCH.entries()) {
    const sym = key.split('|')[0];
    const t = tick(sym);
    rows.push(Object.assign({ symbol: sym, base: baseOf(sym), price: t ? t.last : null }, triangleView(e.tri)));
  }
  rows.sort((a, b) => b.score - a.score);
  res.json({ lt: rows.slice(0, 120) });
}));

app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-200) })));

app.post('/api/module/:id/toggle', h((req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  const on = !!(req.body && req.body.enabled);
  if (id === 'TREND') settings.trendEnabled = on;
  else if (id === 'HIZLI') settings.hizliEnabled = on;
  else if (id === 'LT') { settings.ltEnabled = on; if (!on) LT_WATCH.clear(); }
  else return res.status(400).json({ error: 'Bilinmeyen modül: ' + id });
  dirty = true; saveState(true);
  log(MODS[id].label + (on ? ' AÇILDI' : ' KAPATILDI'));
  res.json({ ok: true, settings });
}));

app.post('/api/settings', h((req, res) => {
  const b = req.body || {};
  for (const k of ['trendScan', 'hizliScan', 'ltScan', 'signalCooldownMin']) {
    if (Number.isFinite(Number(b[k]))) settings[k] = clamp(Math.round(Number(b[k])), k === 'signalCooldownMin' ? 5 : 10, k === 'ltScan' ? 200 : 150);
  }
  for (const k of ['minStopPct', 'maxStopPct']) {
    if (Number.isFinite(Number(b[k]))) settings[k] = clamp(Number(b[k]), 0.1, 5);
  }
  if (settings.minStopPct >= settings.maxStopPct) settings.maxStopPct = settings.minStopPct + 0.5;
  dirty = true; saveState(true);
  res.json({ ok: true, settings });
}));

app.post('/api/signals/clear', h((req, res) => {
  const openN = signals.filter(isOpen).length;
  signals = signals.filter(isOpen); // yalnızca kapanan geçmiş silinir
  dirty = true; saveState(true);
  log('Sinyal geçmişi temizlendi (' + openN + ' açık sinyal korundu)');
  res.json({ ok: true });
}));

/* ── Ana döngü ───────────────────────────────────────────────────────────── */
async function boot() {
  loadState();
  log('AlphaSon ' + VERSION + ' başlıyor · veri dizini: ' + DATA_DIR + (API_TOKEN ? ' · token koruması AÇIK' : ''));
  await refreshUniverse();
  await refreshTickers();
  await updateMarket();
  READY = true;

  setInterval(refreshUniverse, 10 * M1).unref();
  setInterval(refreshTickers, 30e3).unref();
  setInterval(updateMarket, 60e3).unref();
  setInterval(trackSignals, 10e3).unref();
  setInterval(() => saveState(false), 30e3).unref();
  setInterval(ltTick, 5e3).unref();

  // Tarama döngüleri: hızlı (20sn) + trend (45sn) + LT round-robin (2.5sn/coin)
  (async () => {
    while (true) {
      try { if (READY) await hizliScan(); } catch (e) { logOnce('hs', 'Hızlı tarama hatası: ' + (e.message || e), M1); }
      await sleep(20e3);
    }
  })();
  (async () => {
    while (true) {
      try { if (READY) await trendScan(); } catch (e) { logOnce('ts', 'Trend tarama hatası: ' + (e.message || e), M1); }
      await sleep(45e3);
    }
  })();
  (async () => {
    while (true) {
      try { if (READY) await ltStep(); } catch (e) { logOnce('ls', 'LT adım hatası: ' + (e.message || e), M1); }
      await sleep(2500);
    }
  })();

  setInterval(() => {
    const o = signals.filter(isOpen).length;
    logOnce('durum', 'DURUM: piyasa ' + market.dir + ' | açık sinyal ' + o + ' | izlenen üçgen ' + LT_WATCH.size + ' | evren ' + UNIVERSE.length + ' coin', 5 * M1);
  }, 60e3).unref();
}

app.listen(PORT, () => log('HTTP dinleniyor: :' + PORT));
boot().catch(e => { log('BAŞLATMA HATASI: ' + (e.message || e)); READY = false; });
