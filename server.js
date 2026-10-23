'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   AlphaSon v73.0 — AlgoPump: patlamayı yapısal kırılımda yakala, maliyetin
   ÜSTÜNDE çık. Tek dosya (server.js); harici modül yok.
   ───────────────────────────────────────────────────────────────────────────
   v72 → v73, TEK CÜMLE: hiçbir çıkış kuralı maliyet çizgisinin altında karar
   veremez. Geri kalan her değişiklik bu eşitsizliğin etrafına inşa edildi.

   MALİYET (pnl uzayı):
     giriş = ask (LONG) / bid (SHORT), çıkış = bid (LONG) / ask (SHORT)
     => spread ZATEN pnl'in içinde, ikinci kez düşülmez.
     H = FEE_RT (0.12%) + EXIT_SLIP (0.08%) = 0.20%
   v72'de trail maliyetin ALTINDA kuruluyordu:
     peak 0.15 → g=max(0.02, 0.0225) → çıkış 0.1275 → net -0.073%  (garanti zarar)
   v73: LOCK_ARM 0.65, GB_MIN 0.30 → en kötü FADE neti +0.15%.

   GİRİŞ (v72 → v73):
   • 8 sn'de %0.28 + z>=5 + hacim>=3x  →  TIGHT COIL + gövde-baskın barın coil
     dışına kapanışı (yapısal kapı). z 5→3.2, hacim 3→2.2 gevşetildi çünkü
     yapısal koşul çok daha az yanlış pozitif üretiyor.
   • 1.5 sn ticker örnekleri → 15 sn SENTETİK mumlar (microBars). REST yok.
   • Geç kalma tavanı sabit 0.45 → DİNAMİK clamp(0.30*A, 0.12, 0.25).
   • ALTIN KURAL: (A - latePct) >= 3 * H. Kalan mesafe maliyetin 3 katını
     karşılayamıyorsa grafik ne kadar güzel olursa olsun girilmez.
   • origin = KIRILAN coil kenarı (uzak kenar değil: o 0.80%'e kadar hayali
     gecikme ekliyordu).
   • priorRunPct artık now-20s'e kadar ölçülüyor (ignition penceresi hariç).

   ÇIKIŞ: TP → cost-cover → trail → decay → BAIL/NOMOVE/SURE sırası sabit.
   • GB_MIN 0.02→0.30, lockPct 0.15→0.65, giveBackFrac 0.15→0.25
   • TP sabit 1.5% → clamp(1.10*ATR, 0.70, 1.20)
   • Momentum decay SADECE pnl >= H+0.05 iken ateşlenir (v72'nin kanaması)
   • BE_LOCK 0.15: en kötü net -0.05% (tam başabaş değil, maliyet boyu zarar)

   GECİKME: pumpScanVel senkron — emirden önce tek bir await yok. Kaldıraç
   ön-armed, ATR ön-cache. v72'de sinyal→dolum arası 5-8 REST turu vardı.

   NOT: mum tabanlı eski yol (PUMP.useCandlePath) ve backtest simülatörü
   korunmuştur; backtest hâlâ kapanmış mumlarda çalışır.
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = 'v73.0';
const fs = require('fs');
const path = require('path');
const express = require('express');
const ccxt = require('ccxt');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const F_SIG = path.join(DATA_DIR, 'signals.json');
const F_PAPER = path.join(DATA_DIR, 'paper.json');
const F_SET = path.join(DATA_DIR, 'settings.json');

/* ───────── API & BORSA ───────── */
const API_KEY = process.env.BITGET_API_KEY || '';
const API_SECRET = process.env.BITGET_SECRET || '';
const API_PASS = process.env.BITGET_PASSPHRASE || '';
const IS_LIVE_READY = !!(API_KEY && API_SECRET && API_PASS);
// CANLI mod için sert tavanlar (arayüzdeki ayarlardan bağımsızdır; ortam değişkeniyle değiştirilir)
const LIVE_MAX_MARGIN = Number(process.env.LIVE_MAX_MARGIN) || 25;        // işlem başına en fazla teminat (USDT)
const LIVE_MAX_LEVERAGE = Number(process.env.LIVE_MAX_LEVERAGE) || 5;     // en fazla kaldıraç
let realBal = { total: 0, free: 0, used: 0, updatedAt: 0, error: null };

/* ───────── SABİTLER ───────── */
const COST_PCT = 0;         // v69: maliyet hesabı YOK → Net R = Brüt R
const FEE_SIDE = 0.0006;    // yalnızca PAPER bakiyesi için taker komisyonu (sinyal R'sini etkilemez)
const PAPER_SLIP = 0;       // paper girişinde slipaj yok
const START_BALANCE = 1000;
const M1 = 60000, M3 = 180000, M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const TF_MS = { '1m': M1, '3m': M3, '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': D1 };
const TTL = { '1m': 8000, '3m': 20000, '5m': 45000, '15m': 150000, '1h': 540000, '4h': 1500000, '1d': 7200000 };

const MODS = {
  TREND:   { label: 'Trend (PSAR)',      max: 99, quota: null, maxAge: 2 * H1,  cooldown: 10 * M1, chartTf: '5m' },
  SCALPER: { label: 'Scalper',           max: 99, quota: null, maxAge: 4 * H1,  cooldown: 15 * M1, chartTf: '15m' },
  LT:      { label: 'LT Üçgen',          max: 99, quota: null, maxAge: 5 * D1,  cooldown: 6 * H1,  chartTf: '4h' },
  ZONE:    { label: 'Zone Master',       max: 99, quota: null, maxAge: 12 * H1, cooldown: 30 * M1, chartTf: '1h' },
  RANGE:   { label: 'Range (Mean Rev.)', max: 99, quota: null, maxAge: 3 * H1,  cooldown: 30 * M1, chartTf: '15m' },
  PUMP:    { label: 'AlgoPump',          max: 99, quota: null, maxAge: 4 * M1,  cooldown: 2 * M1,  chartTf: '1m' }
};
const REASON = {
  TP1: 'TP1 hedefi', TP2: 'TP2 hedefi', SL: 'Stop', BE: 'TP1 sonrası başa baş', SURE: 'Süre doldu', MANUEL: 'Manuel kapatma',
  TPMAX: 'Maksimum hedef', FADE: 'Kâr geri verildi', BAIL: 'Erken kaçış', NOMOVE: 'Hareket yok', MOMENTUM: 'İvme bitti (net kârda)'
};

/* ═══════════════════════════════════════════════════════════════════════════
   AlgoPump v73 PARAMETRELERİ
   PUMP = giriş, EX = çıkış. Maliyet matematiği dosya başında.
   ═══════════════════════════════════════════════════════════════════════════ */
const PUMP = {
  /* ── ön eleme / tarama ── */
  minQuoteVol: 1500000,        // 800k → 1.5M: ince defter = geniş spread = edge yok
  maxSpreadPct: 0.15,          // 0.40 → 0.15: ALL_IN <= 0.30 varsayımını taşıyan parametre
  snapKeepMs: 360000,          // 200000 → 360000: coilBars(16) * barMs(15s) = 240s > retention'dı
  pre30: 0.30, pre60: 0.45, pre150: 0.80,   // legacy mum yolu (useCandlePath) için
  maxCand: 10,
  recheckMs: 2500,             // sinyal başına yeniden kontrol aralığı (ms)

  /* ── sentetik mum motoru ── */
  barMs: 15000,                // 1.5 sn tick örneklerinden 15 sn'lik mum
  coilBars: 16,                // 16 * 15s = 4 dakika coil
  coilMaxPct: 0.80,            // coil aralığı bundan genişse "kırılım" gürültüdür
  bodyMin: 0.60,               // |c-o|/(h-l): ignition barı gövde-baskın olmalı
  dispMinPct: 0.12,            // coil kenarının en az bu kadar ötesine taşmalı

  /* ── legacy mum yolu + backtest (detectBurst) ── */
  minElapsedMs: 3000,
  m1: { minMovePct: 0.70, minVolX: 3.5, minAtrX: 2.5, maxMovePct: 4.0, hold: 75, noMove: 30 },
  m3: { minMovePct: 1.10, minVolX: 3.0, minAtrX: 2.5, maxMovePct: 6.0, hold: 180, noMove: 45 },
  posMin: 0.55,
  priorMaxFrac: 0.40, priorVolMax: 2.5,
  maxExt15Pct: 8,
  slBodyFrac: 0.5, slMin: 0.35, slMax: 1.20,
  tpMaxPct: 1.5,
  macroFilter: true,           // piyasa güçlü tek yöndeyken ters yönlü pump alınmaz
  useCandlePath: false,        // eski (geç kalan) mum taraması — KAPALI

  /* ── HIZ / IGNITION EŞİKLERİ ── */
  vel: {
    w: 6000, fastW: 2500,             // hareket pencereleri (ms)
    minMovePct: 0.16, fastMovePct: 0.11,
    minZ: 3.2,                        // 5 → 3.2: yapısal kapı daha güçlü olduğu için
    minVolRatio: 2.2,                 // 3 → 2.2
    minHist: 30, minNoiseN: 12,        // 12: 3 sn REST yedeğinde 60 sn'de ~19 örnek var
    minAtrX: 0.8,
    priorMaxPct: 0.30,                // son 90 sn'de aynı yönde en fazla %0.30
    maxLatePct: 0.20,                 // dinamik tavan kapalıysa kullanılan sabit
    dynamicLateCap: true,             // cap = clamp(0.30*A, 0.12, 0.25)
    minEdgeMult: 3.0,                 // ALTIN KURAL: (A - latePct) >= 3 * H
    slBufferPct: 0.04, slMin: 0.20, slMax: 0.65,
    maxCand: 10, recheckMs: 4000
  }
};

/* ── ÇIKIŞ MERDİVENİ ── */
const EX = {
  H: 0.20,             // fee RT 0.12 + exit slip 0.08 (spread pnl içinde)
  MIN_NET: 0.10,       // yönetilen bir çıkışın bankalaması gereken min net
  GB_MIN: 0.30,        // = H + MIN_NET   (v72: 0.02)
  GB_FRAC: 0.25,       // zirvenin %25'i (v72: 0.15)
  LOCK_ARM: 0.65,      // = GB_MIN + H + MIN_NET (v72: 0.15)
  BE_ARM: 0.45,        // zirve buraya ulaşınca stop maliyete çekilir
  BE_LOCK: 0.15,       // stop = giriş + %0.15 → en kötü net -0.05% (tam BE değil)
  BAIL_ARM: 0.35,
  BAIL_BELOW: -0.02,
  TP_MIN: 0.70,
  TP_MAX: 1.20,
  TP_ATR_K: 1.10,      // TP = clamp(1.10 * ATR%, TP_MIN, TP_MAX)
  NO_MOVE: 30,         // sn — hiç silahlandırmadan ölü
  HOLD: 75,            // sn — sert süre tavanı
  DECAY_RATIO: 0.30,   // 2 sn hız / son 12 sn zirve hızı
  DECAY_MIN_PNL: 0.25, // == H + 0.05: decay asla net zarara kapatamaz
  MIN_NET_RR: 0.90,    // (tp - H) / (sl + H) alt sınırı
  VEL_WIN_MS: 2000,
  VEL_PEAK_MEMORY_MS: 12000
};

const EPS = 1e-9;      // 0.7 >= 0.70 float'ta 1e-14 yüzünden false dönüyordu

/* ── BOOT-TIME KANIT: eşitsizlik bozulursa bot AÇILMAZ ── */
function assertInvariants() {
  const e = [];
  const worstFadeNet = EX.LOCK_ARM - EX.GB_MIN - EX.H;
  if (EX.GB_MIN < EX.H + EX.MIN_NET - EPS) e.push('GB_MIN < H + MIN_NET → trailing çıkış net-negatif olabilir');
  if (worstFadeNet < EX.MIN_NET - EPS) e.push('LOCK_ARM çok düşük: en kötü FADE neti ' + worstFadeNet.toFixed(2) + '%');
  if (!(EX.GB_FRAC < 1)) e.push('GB_FRAC >= 1 → trail yakınsamaz');
  if (!(EX.LOCK_ARM > EX.BE_ARM)) e.push('LOCK_ARM > BE_ARM olmalı');
  if (!(EX.TP_MIN > EX.H)) e.push('TP_MIN maliyet çizgisinin üstünde olmalı');
  if (EX.DECAY_MIN_PNL < EX.H + 0.05 - EPS) e.push('DECAY_MIN_PNL >= H + 0.05 olmalı');
  if (PUMP.vel.minEdgeMult * EX.H >= EX.TP_MAX) e.push('minEdgeMult * H TP için yer bırakmıyor');
  if (e.length) throw new Error('AlgoPump v73 invariant ihlali:\n  - ' + e.join('\n  - '));
  // Altın kural + dinamik tavan birlikte: kalan = 0.70*A → A >= (3H)/0.70
  const minA = (PUMP.vel.minEdgeMult * EX.H) / 0.70;
  return {
    H: EX.H, GB_MIN: EX.GB_MIN, LOCK_ARM: EX.LOCK_ARM,
    worstFadeNet: +worstFadeNet.toFixed(3),
    costCoverNet: +(EX.BE_LOCK - EX.H).toFixed(3),
    minTradeableLegPct: +minA.toFixed(3),
    minTradeableAtrPct: +(minA / 1.10).toFixed(3)
  };
}

// Scalper: 15m SMC / BOS
const SCALP = { minVolX: 2.0, maxDistPct: 3, minConf: 65, tp1R: 1.5, tp2R: 2.5, pivL: 3, pivR: 3, lookback: 70 };

// Range slotu: Mean Reversion — 15m Bollinger dışı reddedilme → ortalamaya dönüş
const REVERT = {
  bbP: 20, bbK: 2, adxMax: 25, minVolX: 1.5, wickMin: 0.5,
  limitAtr: 0.15,      // önerilen daha iyi giriş (bilgi): kapanıştan 0.15 ATR içeride
  stopAtr: 0.3,        // stop: aşırılığın (fitil ucu) 0.3 ATR ötesi
  minRiskPct: 0.30, maxRiskPct: 3, minRR: 1.0, minConf: 60
};

// Trend: 5m PSAR "vur-kaç"
const PSAR = { step: 0.02, max: 0.2, adxMin: 25, emaP: 34, wrP: 14, tp1R: 1.5, tp2R: 3, minRiskPct: 0.5, maxExtAtr: 2.5 };

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

/* ───────── TOKENİZE VARLIK FİLTRESİ (hisse / ETF / emtia perp'leri) ───────── */
// Kripto modülleri bu enstrümanlar için tasarlanmadı (hacim/trend filtreleri anlamsız, hepsi tek tema gibi hareket eder).
// Listede olmayan yeni bir tokenize varlık görürsen: EXCLUDE_EXTRA="ABC,XYZ" ortam değişkeni ile ekle.
const TOKENIZED = new Set((
  'XAU XAG XPT XPD XAUT PAXG WTI BRENT OIL NATGAS COPPER ' +
  'SPY QQQ TQQQ SQQQ IWM DIA VOO VTI ARKK SOXL SOXS SOXX SMH DRAM SNXX ' +
  'TSLA NVDA AAPL MSFT AMZN GOOGL GOOG META NFLX AMD INTC MU SNDK SKHYNIX HYNIX SAMSUNG TSM TSMC ASML AVGO QCOM ' +
  'COIN MSTR HOOD CRCL PLTR BABA PYPL SHOP UBER ORCL CRM ADBE DIS NIO GME AMC LITE DELL SMCI ' +
  (process.env.EXCLUDE_EXTRA || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean).join(' ')
).split(/\s+/).filter(Boolean));
const ALLOW_TOKENIZED = process.env.ALLOW_TOKENIZED === '1';
const isTokenized = base => TOKENIZED.has(String(base).toUpperCase()) || TOKENIZED.has(normBase(base).toUpperCase());

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
// Parabolic SAR: her mum için { sar, up } (up=true → SAR fiyatın altında, yükseliş)
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
// Williams %R (son değer, -100..0)
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
  const cost = t.costPct != null ? t.costPct : COST_PCT;
  return { gross, net: gross - (t.entry * cost / 100) / risk };
}
/* ───────── DEDEKTÖRLER (saf fonksiyonlar) ───────── */
// AlgoPump: 1m / 3m grafikte İLK patlama. Son mum oluşmakta olabilir (now verilirse); hacim, geçen süreye göre ölçeklenir.
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
  if (movePct > P.maxMovePct) return no('aşırı uzamış, geç kalındı');
  const atr = atrLast(cs.slice(0, n - 1), 14);
  if (!atr) return null;
  const moveAtr = Math.abs(body) / atr;
  if (moveAtr < P.minAtrX) return no('itme zayıf');
  const volBase = avg(cs.slice(n - 31, n - 1).map(c => c.v));
  if (!(volBase > 0)) return no('hacim verisi yok');
  const frac = Math.max(elapsed / tfMs, 0.25);
  const volX = (L.v / frac) / volBase;
  if (volX < P.minVolX) return no('hacim zayıf');
  const rng = L.h - L.l;
  if (!(rng > 0)) return no('mum aralığı yok');
  const pos = d > 0 ? (L.c - L.l) / rng : (L.h - L.c) / rng;           // 1 = tam zirvede/dipte
  if (pos < PUMP.posMin) return no('geri çekilmiş');
  const prior = cs.slice(n - 4, n - 1);                                  // İLK patlama: önceki 3 mum sakin olmalı
  const priorDir = prior.reduce((s, c) => s + (c.c - c.o) * d / c.o * 100, 0);
  if (priorDir > PUMP.priorMaxFrac * movePct) return no('ilk patlama değil (hareket başlamış)');
  if (Math.max.apply(null, prior.map(c => c.v)) > PUMP.priorVolMax * volBase) return no('ilk patlama değil (hacim zaten patlamış)');
  if (Math.abs(price / cs[n - 16].o - 1) * 100 > PUMP.maxExt15Pct) return no('aşırı uzamış');
  const slPct = clamp(PUMP.slBodyFrac * movePct, PUMP.slMin, PUMP.slMax), tpPct = PUMP.tpMaxPct;
  const quiet = clamp((1 - priorDir / Math.max(0.01, PUMP.priorMaxFrac * movePct)) * 4, 0, 4);
  const conf = 55 + clamp((volX - P.minVolX) * 2.5, 0, 15) + clamp((moveAtr - P.minAtrX) * 3, 0, 12) + clamp((pos - PUMP.posMin) * 20, 0, 6) + quiet;
  return {
    dir, entry: rp(price), sl: rp(price * (1 - d * slPct / 100)), tp1: rp(price * (1 + d * tpPct / 100)), tp2: null, single: true,
    conf: clamp(Math.round(conf), 40, 95), holdSec: P.hold, noMoveSec: P.noMove, maxAgeMs: (P.hold + 30) * 1000,
    info: { tf: tfMs === M1 ? '1m' : '3m', forming, movePct: +movePct.toFixed(2), volRatio: +volX.toFixed(1), atrX: +moveAtr.toFixed(1), closePos: +pos.toFixed(2), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2), atr }
  };
}

// Scalper: 15m SMC / BOS — son confirmed swing high/low'un GÖVDE ile ilk kez kırılması
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
  if (!(vSma > 0)) return no('hacim verisi yok');
  const vr = last.v / vSma;
  if (vr < SCALP.minVolX) return no('hacim zayıf');
  const e = last.c, distPct = Math.abs(e - level) / level * 100;
  if (distPct > SCALP.maxDistPct) return no('seviyeden uzak');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  let risk = Math.abs(e - (level - d * 0.5 * atr));       // stop: kırılan seviyenin 0.5 ATR gerisi
  risk = Math.max(risk, e * 0.006);                       // maliyet R'yi yemesin: min %0.6
  if (risk > e * 0.05) return no('risk büyük');
  const closePos = (dir === 'LONG' ? e - last.l : last.h - e) / rng;
  const conf = 55 + clamp((vr - SCALP.minVolX) * 5, 0, 12) + clamp((body / rng - 0.5) * 20, 0, 8) + clamp((1 - distPct / SCALP.maxDistPct) * 5, 0, 5) + (closePos > 0.8 ? 4 : 0) - (rng > 3 * atr ? 8 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(e + d * SCALP.tp1R * risk), tp2: rp(e + d * SCALP.tp2R * risk), single: false,
    conf: clamp(Math.round(conf), 40, 92),
    info: { bos: true, level: rp(level), distPct: +distPct.toFixed(2), volRatio: +vr.toFixed(1), bodyRatio: +(body / rng).toFixed(2), atr, riskPct: +(risk / e * 100).toFixed(2) }
  };
}

// Rejim ayırıcı: ADX + Bollinger bant genişlemesi
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
// Mean Reversion: bant dışına taşıp içeri kapanan, fitilli ve hacimli mum → ortalamaya (orta banda) dönüş.
function detectRevert(cs, why, adxMax) {
  const no = k => { if (why) why[k] = (why[k] || 0) + 1; return null; };
  const n = cs.length;
  if (n < 80) return null;
  adxMax = adxMax != null ? adxMax : REVERT.adxMax;
  const rg = regimeOf(cs);
  if (rg.adx == null) return null;
  if (rg.adx >= adxMax) return no('trend rejimi (ADX yüksek)');
  if (rg.expanding) return no('bant genişliyor');
  const last = cs[n - 1], { mid, sd, up, lo } = bandsOf(cs), rng = last.h - last.l;
  if (!(rng > 0) || !(sd > 0)) return no('mum aralığı yok');
  let dir = null;
  if (last.l < lo && last.c > lo) dir = 'LONG';
  else if (last.h > up && last.c < up) dir = 'SHORT';
  if (!dir) return no('bant dışı reddedilme yok');
  const d = dir === 'LONG' ? 1 : -1;
  const wick = (dir === 'LONG' ? Math.min(last.o, last.c) - last.l : last.h - Math.max(last.o, last.c)) / rng;
  if (wick < REVERT.wickMin) return no('fitil zayıf');
  const prev = cs.slice(n - 21, n - 1), vSma = avg(prev.map(c => c.v));
  if (!(vSma > 0)) return no('hacim verisi yok');
  const vr = last.v / vSma;
  if (vr < REVERT.minVolX) return no('hacim zayıf');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c, extreme = dir === 'LONG' ? last.l : last.h;
  let sl = extreme - d * REVERT.stopAtr * atr;
  if (Math.abs(e - sl) / e * 100 < REVERT.minRiskPct) sl = e - d * e * REVERT.minRiskPct / 100;
  const risk = Math.abs(e - sl), gain = (mid - e) * d;
  if (!(gain > 0)) return no('hedef yönü ters');
  const riskPct = risk / e * 100;
  if (riskPct > REVERT.maxRiskPct) return no('risk büyük');
  const rr = gain / risk;
  if (rr < REVERT.minRR) return no('R:R düşük');
  const tp2 = mid + d * 0.5 * Math.abs((dir === 'LONG' ? up : lo) - mid);       // ikinci hedef: orta bandın ötesi (karşı bandın yarısı)
  const better = e - d * REVERT.limitAtr * atr;
  const conf = 56 + clamp((vr - REVERT.minVolX) * 6, 0, 10) + clamp((wick - REVERT.wickMin) * 20, 0, 8) + clamp((rr - REVERT.minRR) * 5, 0, 8) + (rg.adx < 18 ? 4 : 0);
  return {
    dir, entry: rp(e), sl: rp(sl), tp1: rp(mid), tp2: rp(tp2), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { regime: rg.regime, adx: +rg.adx.toFixed(1), band: { lo: rp(lo), mid: rp(mid), up: rp(up) }, wickRatio: +wick.toFixed(2), volRatio: +vr.toFixed(1), gainPct: +(gain / e * 100).toFixed(2), riskPct: +riskPct.toFixed(2), rr: +rr.toFixed(2), betterEntry: rp(better), atr }
  };
}

// Trend (5m, vur-kaç): PSAR dönüşü + Williams %R + EMA34 + ADX
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
  if (dir === 'LONG' ? !(wr > -50) : !(wr < -50)) return no('Williams %R uyumsuz');
  const cl = closes(cs), e34 = emaArr(cl, PSAR.emaP), last = cs[m];
  if (dir === 'LONG' ? !(last.c > e34[m]) : !(last.c < e34[m])) return no('EMA34 ters');
  const atr = atrLast(cs, 14);
  if (!atr) return null;
  const e = last.c;
  if (Math.abs(e - e34[m]) > PSAR.maxExtAtr * atr) return no('EMA34\'ten çok uzak (geç kalınmış)');
  let risk = clamp(Math.abs(e - ps[m].sar), 1.2 * atr, 2.5 * atr);   // stop: yeni PSAR (önceki uç) ama 1.2–2.5 ATR bandında
  risk = Math.max(risk, e * PSAR.minRiskPct / 100);
  const vSma = avg(cs.slice(m - 20, m).map(c => c.v)), vr = vSma > 0 ? last.v / vSma : 0;
  const conf = 55 + clamp((adx - PSAR.adxMin) * 0.8, 0, 12) + clamp(Math.abs(wr + 50) / 50 * 10, 0, 8) + (vr >= 1.2 ? 5 : 0);
  return {
    dir, entry: rp(e), sl: rp(e - d * risk), tp1: rp(e + d * PSAR.tp1R * risk), tp2: rp(e + d * PSAR.tp2R * risk), single: false,
    conf: clamp(Math.round(conf), 40, 90),
    info: { adx: +adx.toFixed(1), williamsR: +wr.toFixed(1), psar: rp(ps[m].sar), ema34: rp(e34[m]), volRatio: +vr.toFixed(1), atr, riskPct: +(risk / e * 100).toFixed(2) }
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
// Zone Master: yalnızca TREND YÖNÜNDE (destekte long = EMA50 düşmüyor, dirençte short = EMA50 yükselmiyor) ve hacimli tepkide sinyal.
function detectZone(cs, zones) {
  const n = cs.length, out = { signal: null, watch: [] };
  if (n < 60 || !zones || !zones.length) return out;
  const last = cs[n - 1], prev = cs[n - 2], px = last.c, atr = atrLast(cs, 14);
  if (!atr) return out;
  const e50 = emaArr(closes(cs), 50), m = n - 1;
  const slope = (e50[m] - e50[m - 5]) / e50[m] * 100;               // son 5 mumda EMA50 eğimi (%)
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
    if (dir === 'LONG' && !(slope >= 0 && px > e50[m] * 0.985)) dir = null;      // düşen bıçağı tutma
    if (dir === 'SHORT' && !(slope <= 0 && px < e50[m] * 1.015)) dir = null;
    if (dir && vr < 1.2) dir = null;                                              // tepkide hacim şart
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
      const conf = 52 + Math.min(22, (z.score - 6) * 3) + Math.min(8, wick / Math.max(body, 1e-12) * 2) + Math.min(6, (vr - 1.2) * 4);
      out.signal = { dir, entry: rp(e), sl: rp(sl), tp1: rp(tp1), tp2: rp(tp2), single: false, conf: clamp(Math.round(conf), 40, 92), info: { zoneLo: rp(z.lo), zoneHi: rp(z.hi), zoneScore: +z.score.toFixed(1), touches: z.touches, volRatio: +vr.toFixed(1), ema50Slope: +slope.toFixed(2), atr } };
    }
  }
  return out;
}

// Range slotu: Mean Reversion sinyali + bant uçlarına yakın coinler için izleme listesi
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

/* ───────── DURUM ───────── */
let signals = [], sigSeq = 0;
let paper = { seq: 0, balance: START_BALANCE, startBalance: START_BALANCE, open: [], closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: 0, liveDayStart: 0 };
// riskPct: >0 ise pozisyon boyutu "bakiyenin %riskPct'i kadar risk" olacak şekilde hesaplanır (margin üst sınırdır). 0 = sabit margin.
const DEF_SET = { auto: false, tradeMode: 'paper', margin: 100, leverage: 5, minConf: 60, maxMinutes: 5, riskPct: 0.5, maxOpen: 8, dailyLossPct: 0 };
let settings = Object.assign({}, DEF_SET);
const market = { dir: 'NOTR', score: 0.5, trf: 0.5, breadth: 0.5, b1h: 0.5, b4h: 0.5, btc: null, eth: null, lastDirChange: 0, lastDirective: null, updatedAt: 0 };
let radar = { updatedAt: 0 };
const WATCH = { zone: [], range: [], lt: [] };
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
  log('Veriler yüklendi: ' + signals.length + ' sinyal, ' + paper.open.length + ' açık işlem, oto-trade ' + (settings.auto ? 'AÇIK' : 'KAPALI') + ', mod ' + settings.tradeMode.toUpperCase());
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
  // REST yedeği: WS yoksa (veya gecikirse) SNAP/RING yine de dolsun.
  // WS varsa bu 3 sn'lik örnekler ek bir katman olur; pushSnap 1 sn'de tekilleştirir.
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
  const list = [], skipped = [];
  for (const k in ex.markets) {
    const m = ex.markets[k];
    if (m && m.swap && m.linear && m.quote === 'USDT' && m.active !== false && TICK[m.symbol]) {
      if (!ALLOW_TOKENIZED && isTokenized(baseOf(m.symbol))) { skipped.push(baseOf(m.symbol)); continue; }
      list.push(m.symbol);
    }
  }
  list.sort((a, b) => (TICK[b].quoteVolume || 0) - (TICK[a].quoteVolume || 0));
  ALL = list;
  TOP = list.slice(0, 120);
  stats.excluded = skipped.length;
  log('Evren güncellendi: ' + ALL.length + ' sözleşme, en likit ' + TOP.length + ' taranıyor' + (skipped.length ? ' | tokenize varlık dışlandı: ' + skipped.length + ' (' + skipped.slice(0, 12).join(', ') + (skipped.length > 12 ? '...' : '') + ')' : ''));
}

/* ───────── SİNYAL YÖNETİCİSİ ───────── */
function blocked(mod, sym, reason, silent) {
  BLK[reason] = (BLK[reason] || 0) + 1;
  if (silent) return false;
  const k = mod + '|' + reason, t = Date.now();
  if (!blockLog[k] || t - blockLog[k] > 120000) { blockLog[k] = t; log('ENGEL: ' + MODS[mod].label + ' ' + baseOf(sym) + ' → ' + reason); }
  return false;
}
function addSignal(raw) {
  const mod = raw.module, M = MODS[mod], t = Date.now(), dir = raw.dir, sym = raw.symbol, base = baseOf(sym);
  // v69: KISITLAMA YOK (modül/global/sektör/flood/kota/piyasa yönü). Yalnızca tekrar önleme:
  // aynı modül + sembol + yönde AKTİF sinyal varsa ya da yakın zamanda kapanmışsa (kısa soğuma) üretilmez.
  if (signals.some(s => s.module === mod && s.symbol === sym && (s.status === 'AKTIF' ? s.dir === dir : s.dir === dir && t - (s.closedAt || s.createdAt) < M.cooldown))) return false;
  const act = signals.filter(s => s.status === 'AKTIF');
  const sec = sectorOf(base);
  const counter = market.dir !== 'NOTR' && dir !== market.dir;               // piyasa yönüne ters: yalnızca bilgi (engel değil)
  const align = market.dir === 'NOTR' ? 'NOTR' : (counter ? 'TERS' : 'UYUMLU');
  const same = act.filter(s => s.symbol === sym && s.dir === dir && s.module !== mod);
  const bonus = Math.min(25, same.length * 12);
  const base0 = raw.conf - (counter && mod !== 'PUMP' ? 6 : 0);              // AlgoPump yön fark etmeksizin (pump da dump da) cezasız
  const sig = {
    id: 'S' + (++sigSeq), module: mod, symbol: sym, base, sector: sec, dir,
    entry: raw.entry, sl: raw.sl, curSl: raw.sl, tp1: raw.tp1, tp2: raw.tp2 || null, single: !!raw.single, tp1Hit: false,
    baseConf: base0, confBonus: bonus, conf: clamp(Math.round(base0 + bonus), 30, 99), counter, marketAlign: align,
    confl: same.map(s => s.module), info: raw.info || {}, status: 'AKTIF', result: null,
    createdAt: t, maxAgeMs: raw.maxAgeMs || M.maxAge, lastTs: 0,
    holdSec: raw.holdSec != null ? raw.holdSec : undefined, noMoveSec: raw.noMoveSec != null ? raw.noMoveSec : undefined,
    atrPct: raw.atrPct, velSeries: [], peakPct: null      // v73: dinamik TP + decay için gerekli
  };
  same.forEach(s => {
    if (!s.confl.includes(mod)) {
      s.confl.push(mod);
      s.confBonus = Math.min(25, (s.confBonus || 0) + 12);
      s.conf = clamp(Math.round(s.baseConf + s.confBonus), 30, 99);
    }
  });
  signals.push(sig);
  dirty = true;
  log('SİNYAL: ' + M.label + ' | ' + base + ' | ' + dir + ' | güven ' + sig.conf + ' | piyasa ' + align + (same.length ? ' | konfluans x' + (same.length + 1) : '') + (raw.info && raw.info.tf ? ' | ' + raw.info.tf : ''));
  if (mod === 'PUMP') { stats.pumpFound++; maybeOpenPaper(sig).catch(e => log('HATA maybeOpenPaper: ' + e.message)); }
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

/* ───────── PAPER / LIVE ENGINE (yalnızca AlgoPump oto-trade) ───────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const opening = new Set();
// Gerçek defter fiyatları: LONG girişte ask'tan alır / bid'den satar; SHORT girişte bid'den satar / ask'tan geri alır.
const bookOf = sym => { const t = TICK[sym]; if (!t || !t.last) return null; const bid = t.bid > 0 ? t.bid : t.last, ask = t.ask > 0 ? t.ask : t.last; return { last: t.last, bid, ask, approx: !(t.bid > 0 && t.ask > 0) }; };
const entryPx = (sym, dir) => { const b = bookOf(sym); return b ? (dir === 'LONG' ? b.ask : b.bid) : null; };
const exitPx = o => { const b = bookOf(o.symbol); return b ? (o.dir === 'LONG' ? b.bid : b.ask) : null; };

function paperPnl(p, price) {
  const d = p.dir === 'LONG' ? 1 : -1;
  const part = p.tp1Hit && !p.single ? 0.5 * (p.tp1 / p.entry - 1) + 0.5 * (price / p.entry - 1) : price / p.entry - 1;
  let pnl = p.notional * part * d - p.notional * FEE_SIDE * 2;
  if (pnl < -p.margin) pnl = -p.margin;     // likidasyon üst sınırı
  return { pnl, pct: pnl / p.margin * 100 };
}
function checkDailyLoss() {
  const key = new Date().toISOString().slice(0, 10);
  if (paper.dayKey !== key) { paper.dayKey = key; paper.dayStart = paper.balance; paper.liveDayPnl = 0; paper.liveDayStart = realBal.total || 0; dirty = true; }
  if (!settings.auto || !(settings.dailyLossPct > 0)) return;
  if (settings.tradeMode === 'paper' && paper.balance <= paper.dayStart * (1 - settings.dailyLossPct / 100)) {
    settings.auto = false; saveSettings();
    log('PAPER: Günlük zarar limiti (%' + settings.dailyLossPct + ') aşıldı, OTO-TRADE otomatik KAPATILDI');
  } else if (settings.tradeMode === 'live' && paper.liveDayStart > 0 && (paper.liveDayPnl || 0) <= -(paper.liveDayStart * settings.dailyLossPct / 100)) {
    settings.auto = false; saveSettings();
    log('LIVE: Günlük zarar limiti (%' + settings.dailyLossPct + ') aşıldı (' + (paper.liveDayPnl || 0).toFixed(2) + ' USDT), OTO-TRADE otomatik KAPATILDI');
  }
}

// ── CANLI emir yardımcıları (ccxt/Bitget; gerçek borsaya karşı test edilemedi — küçük tutarla dene) ──
let liveInited = false;
async function liveInit() {
  if (liveInited) return;
  try { await ex.setPositionMode(false); } catch (e) { log('UYARI: tek yönlü pozisyon modu ayarlanamadı (' + e.message + '). Hesap hedge modundaysa emirler reddedilebilir.'); }
  liveInited = true;
}
async function liveSetup(sym, lev) {
  try { await ex.setMarginMode('isolated', sym); } catch (e) { /* zaten isolated olabilir */ }
  await ex.setLeverage(lev, sym);                 // kaldıraç ayarlanamazsa işlem AÇILMAZ (hata fırlatır)
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
  if (!f && order && order.id) { try { const o2 = await ex.fetchOrder(order.id, sym); f = Number(o2.average) || Number(o2.price) || 0; } catch (e) { /* yok say */ } }
  return f;
}
async function openLive(sig, margin, lev, entryHint) {
  await liveInit();
  await liveSetup(sig.symbol, lev);
  const side = sig.dir === 'LONG' ? 'buy' : 'sell', slSide = sig.dir === 'LONG' ? 'sell' : 'buy';
  const amount = ex.amountToPrecision(sig.symbol, (margin * lev) / entryHint);
  if (!(Number(amount) > 0) || Number(amount) * entryHint < 5) throw new Error('miktar/notional çok küçük (' + amount + ')');
  const order = await ex.createOrder(sig.symbol, 'market', side, amount);
  const fill = (await fillOf(order, sig.symbol)) || entryHint;
  const qty = Number(order.filled) > 0 ? ex.amountToPrecision(sig.symbol, order.filled) : amount;
  let stopId = null;
  try { stopId = await placeStop(sig.symbol, slSide, qty, sig.sl); }
  catch (e) {
    log('LIVE STOP KURULAMADI (' + sig.base + '): ' + e.message + ' → pozisyon HEMEN kapatılıyor');
    if (await emergencyClose(sig.symbol, slSide, qty)) { log('LIVE: ' + sig.base + ' korumasız pozisyon kapatıldı, işlem iptal edildi'); return null; }
    log('ACİL: ' + sig.base + ' pozisyonu KORUMASIZ ve kapatılamadı! Bitget uygulamasından elle kapat.');
  }
  const notional = Number(qty) * fill;
  const p = {
    id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir,
    entry: rp(fill), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false,
    isLive: true, amount: qty, stopId, unprotected: !stopId, holdSec: sig.holdSec, noMoveSec: sig.noMoveSec,
    margin: +(notional / lev).toFixed(2), leverage: lev, notional, conf: sig.conf, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
  };
  paper.open.push(p); dirty = true;
  log('LIVE AÇILDI: ' + p.base + ' ' + p.dir + ' | sinyal ' + fmtP(sig.entry) + ' → dolum ' + fmtP(fill) + ' (kayma %' + (Math.abs(fill / sig.entry - 1) * 100).toFixed(3) + ') | miktar ' + qty + ' | ' + lev + 'x | stop ' + fmtP(p.sl) + (stopId ? '' : ' (STOP YOK!)'));
  return p;
}
async function liveClose(p) {
  const side = p.dir === 'LONG' ? 'sell' : 'buy';
  const o = await ex.createOrder(p.symbol, 'market', side, p.amount, undefined, { reduceOnly: true });
  const fill = await fillOf(o, p.symbol);
  if (p.stopId) {                                   // açık stop emri sonraki pozisyonu tetiklemesin
    let ok = false;
    for (const params of [{ stop: true }, { trigger: true }, { stop: true, planType: 'loss_plan' }]) { try { await ex.cancelOrder(p.stopId, p.symbol, params); ok = true; break; } catch (e) { /* sıradaki */ } }
    if (!ok) { try { await ex.cancelAllOrders(p.symbol, { stop: true }); ok = true; } catch (e) { /* yok say */ } }
    if (!ok) log('UYARI: ' + p.base + ' stop emri iptal edilemedi; Bitget açık emirlerini kontrol et');
  }
  return fill || null;
}
// Borsada kapanmış (ör. borsa tarafı stop tetiklenmiş) canlı pozisyonları yerelde de kapat
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
    log('LIVE: ' + p.base + ' borsada artık açık görünmüyor (stop tetiklenmiş olabilir) → yerelde kapatılıyor');
    p.extClosed = true;
    await closePaper(p, p.curSl || p.sl, 'SL');
  }
}

async function maybeOpenPaper(sig) {
  if (!settings.auto) return;
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
    if (Date.now() - realBal.updatedAt > 3 * M1 || !(realBal.free > 0)) { log('LIVE ENGEL: ' + sig.base + ' → gerçek bakiye okunamadı/0 (serbest ' + realBal.free + ')'); return; }
    lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE);
    eq = realBal.total;
    margin = Math.min(settings.margin, LIVE_MAX_MARGIN, realBal.free * 0.9);
  }
  const slDist = Math.abs(entry - sig.sl) / entry;
  if (settings.riskPct > 0 && slDist > 0 && eq > 0) margin = Math.min(margin, (eq * settings.riskPct / 100) / slDist / lev);
  margin = +margin.toFixed(2);
  if (margin < (live ? 2 : 10)) { log((live ? 'LIVE' : 'PAPER') + ' ENGEL: ' + sig.base + ' → boyut/bakiye yetersiz (' + margin + ' USDT)'); return; }
  opening.add(sig.symbol);
  try {
    if (!live) {
      const p = {
        id: 'P' + (++paper.seq), sigId: sig.id, module: sig.module, symbol: sig.symbol, base: sig.base, sector: sig.sector, dir: sig.dir,
        entry: rp(entry), sl: sig.sl, curSl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, single: !!sig.single, isPump: true, peakPct: null, tp1Hit: false, isLive: false,
        atrPct: sig.atrPct, velSeries: [],                   // v73: dinamik TP + momentum decay
        holdSec: sig.holdSec, noMoveSec: sig.noMoveSec,
        margin, leverage: lev, notional: margin * lev, conf: sig.conf, openedAt: Date.now(), lastTs: 0, status: 'ACIK'
      };
      paper.open.push(p); dirty = true;
      const li = sig.info || {};
      log('PAPER AÇILDI: ' + p.base + ' ' + p.dir + ' | son fiyat ' + fmtP(li.lastPx || sig.entry) + ' → dolum (' + (p.dir === 'LONG' ? 'ask' : 'bid') + ') ' + fmtP(p.entry) + ' | spread %' + (li.spreadPct != null ? li.spreadPct : '?') + ' | ' + p.margin.toFixed(0) + ' USDT | ' + lev + 'x');
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
        if (p.closeFail === 1 || p.closeFail % 10 === 0) log('LIVE KAPATMA HATASI (' + p.base + ', deneme ' + p.closeFail + '): ' + e.message + (p.closeFail >= 5 ? ' | ACİL: Bitget uygulamasından elle kapat' : ''));
        return false;                                  // pozisyon AÇIK kalır; sonraki döngüde yeniden denenir
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

/* ───────── TAKİPÇİ (1m mum High/Low) ───────── */
const fromOf = o => (o.lastTs ? o.lastTs + M1 : Math.ceil((o.createdAt || o.openedAt) / M1) * M1);
const finish = (o, price, reason, kind) => (kind === 'sig' ? closeSignal(o, price, reason) : closePaper(o, price, reason));
/* ───────── v73 ÇIKIŞ KARARI ─────────
   Sıra SABİT: TP → cost-cover → trail → decay → BAIL/NOMOVE/SURE.
   `price` = ÇIKIŞ tarafı fiyatı (long → bid, short → ask); spread pnl içinde.
   En kötü trailing çıkış: 0.65 - 0.30 - 0.20 = +0.15% net.            */
function pumpPeak(o, price) {
  const d = o.dir === 'LONG' ? 1 : -1, pct = (price / o.entry - 1) * d * 100;
  if (o.peakPct == null || pct > o.peakPct) o.peakPct = pct;
  return pct;
}

// Dinamik TP: 0.4% ATR'li coinde 1.5% hedef HOLD içinde ulaşılamaz,
// 1.4% ATR'li coinde ise ikinci bacağı masada bırakır.
function tpTarget(o) {
  const atrPct = o.atrPct > 0 ? o.atrPct : 0.55;
  return clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX);
}

// RULE 2 — maliyet koruması. peak >= BE_ARM olunca stop giriş+BE_LOCK'a çekilir.
// Dürüst not: buradaki en kötü net 0.15-0.20 = -0.05%. Tam başabaş istersen
// EX.BE_LOCK = 0.22 yap. Idempotent ve monoton (asla gevşetmez).
function applyCostCover(o, pnl) {
  if (!(o.peakPct >= EX.BE_ARM)) return false;
  const d = o.dir === 'LONG' ? 1 : -1;
  const lock = o.entry * (1 + d * EX.BE_LOCK / 100);
  const cur = o.curSl;
  if (cur == null || (lock - cur) * d > 0) {
    o.curSl = lock;
    o.beArmed = true;
    return true;
  }
  return false;
}

// RULE 4 girdisi: son 2 sn yönlü hız / son 12 sn'de görülen zirve 2 sn hız.
// Zirve ROLLING — tek bir spike oranı sonsuza kadar çökertemez.
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
  const pnl = pumpPeak(o, price);          // önce peak güncellenir
  const peak = o.peakPct;
  const born = o.createdAt != null ? o.createdAt : o.openedAt;
  const age = Math.max(0, nowMs - born) / 1000;

  // RULE 1 — HARD TP: momentumun "ölmesini" bekleme; ölüm bir geri vermedir
  // ve geri vermenin bedeli ödenir.
  if (pnl >= tpTarget(o) - EPS) return 'TPMAX';

  // RULE 2 — COST-COVER: +0.45% gören işlem tam zarara dönemez.
  applyCostCover(o, pnl);

  // RULE 3 — TRAIL: sadece maliyet çizgisinin üstünde silahlanır.
  if (peak >= EX.LOCK_ARM) {
    const gb = Math.max(EX.GB_MIN, EX.GB_FRAC * peak);
    if (peak - pnl >= gb - EPS) return 'FADE';
  }

  // RULE 4 — MOMENTUM DECAY: sadece net-pozitifken. v72'nin "İVME BİTTİ"
  // kanamasının tam çözümü: kural H+0.05 altında ateşlenemez.
  if (peak >= EX.BE_ARM) {
    const vr = velRatio(o, nowMs);
    const minPnl = Math.max(EX.H + 0.05, EX.DECAY_MIN_PNL);
    if (vr < EX.DECAY_RATIO && pnl >= minPnl - EPS) return 'MOMENTUM';
  }

  // RULE 5 — başarısızlık yolları
  if (peak >= EX.BAIL_ARM && peak < EX.LOCK_ARM && pnl <= EX.BAIL_BELOW + EPS) return 'BAIL';
  if (age >= EX.NO_MOVE - EPS && peak < EX.BE_ARM) return 'NOMOVE';
  if (age >= EX.HOLD - EPS) return 'SURE';
  return null;
}
// Pump dışı sinyallerin mum (1m high/low) takibi
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
        log('TP1 vuruldu: ' + MODS[o.module].label + ' ' + o.base + ' (yarısı kapandı, stop başa çekildi)');
      }
      if (c.t + M1 <= t) o.lastTs = c.t;
    }
  }
  const px = priceOf(o.symbol) || lastClose || o.entry;
  if (t - o.createdAt > o.maxAgeMs) closeSignal(o, px, 'SURE');
}
// AlgoPump tick yönetimi: çıkış tarafı gerçek fiyatıyla (long → bid, short → ask).
// Stop = stop-market gibi (kötü dolum). Cost-cover stopu stepTrade'den ÖNCE
// sıkılır, böylece bu tick'te geçerli olur.
async function pumpTick(o, now, kind) {
  if (o.status === 'KAPALI' || o.closing) return;
  const born = o.createdAt != null ? o.createdAt : o.openedAt, age = (now - born) / 1000;
  const hold = o.holdSec != null ? o.holdSec : EX.HOLD;
  const px = exitPx(o);
  if (!px) { if (age > hold + 30) await finish(o, o.lastPx || o.entry, 'SURE', kind); return; }     // fiyat akışı yoksa süre bitince yine kapat
  o.lastPx = px;
  pumpPeak(o, px);
  applyCostCover(o, o.peakPct);
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

/* ═══════════════════════════════════════════════════════════════════════════
   AlgoPump v73 — GİRİŞ MOTORU (tek dosya, harici modül yok)
   ───────────────────────────────────────────────────────────────────────────
   Akış:
     WS (ticker + trade)  →  SNAP / RING / FLOW / TICK
     15 sn SENTETİK mum   →  coil kırılımı (ignition)
     entryGuard           →  geç kalma tavanı + ALTIN KURAL
     addSignal            →  SENKRON dispatch (emirden önce await YOK)

   Neden yapısal kapı: ilk ignition'ın imzası "%0.28 hareket" değil,
   "sıkışmış coil + gövde-baskın barın coil dışına kapanışı"dır. Bu koşulun
   yanlış pozitif oranı çok daha düşük olduğu için z 5→3.2, hacim 3→2.2
   gevşetilebildi ve giriş v72'ye göre ~2-4 sn erken oldu.
   ═══════════════════════════════════════════════════════════════════════════ */

const SNAP = {};                 // sym -> [{ t, p, qv }]  ticker örnekleri (360 sn)
const RING = new Map();          // sym -> { t: [], p: [] } fiyat halkası (velRatio)
const FLOW = new Map();          // sym -> { b: { bucketTs: notional }, last }
const ATRC = new Map();          // sym -> { atrPct, at }
const ARMED = new Set();         // ön elemeden geçen semboller (sıcak yol sadece bunları gezer)
const lastBurstChk = {};

/* ─────────── SNAP: ticker örnekleri ─────────── */
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
  if (last && ts - last.t < 900) {                      // sembol başına <= 1 örnek/sn
    last.p = price;
    if (qv != null) last.qv = Number(qv);
    return;
  }
  h.push({ t: ts, p: price, qv: qv != null ? Number(qv) : null });
  const cut = ts - PUMP.snapKeepMs;
  let drop = 0;
  while (drop < h.length && h[drop].t < cut) drop++;
  if (drop > 64) h.splice(0, drop);
}

/* ─────────── RING: 2 sn hız / 12 sn zirve (velRatio) ─────────── */
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

/* ─────────── FLOW: gerçek işlem akışı (hacim patlaması) ─────────── */
/* burst() = son 3 sn notional / [60..10 sn] ortalamasının 3 sn'lik payı.
   Payda penceresi patlama penceresini DIŞLAR: v72'nin 24s quoteVolume
   farkı kendi paydasını şişiriyordu ve saniyelerce gecikiyordu.          */
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
  if (baseBuckets < 20) return null;                    // ~20 sn geçmiş gerekli
  const basePerShort = (baseSum / baseBuckets) * 3;
  if (!(basePerShort > 0)) return null;
  return recent / basePerShort;
}

/* ─────────── WS: Bitget public (ticker + trade) ─────────── */
/* Node >= 22'de global WebSocket var; yoksa "ws" paketi; o da yoksa REST
   yedeği devrede kalır (refreshTickers 3 sn).                            */
function getWS() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  try { return require('ws'); } catch (e) { return null; }
}

class BitgetStream {
  constructor(url) {
    this.url = url || 'wss://ws.bitget.com/v2/ws/public';
    this.ws = null;
    this.subs = new Set();
    this.backoff = 1000;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.closed = false;
  }
  start() {
    const WS = getWS();
    if (!WS) { log('WS yok (Node<22 ve "ws" kurulu değil) → REST ticker yedeği kullanılıyor'); return; }
    this.closed = false;
    try { this.ws = new WS(this.url); } catch (e) { log('WS açılamadı: ' + e.message); return; }

    this.ws.onopen = () => {
      this.backoff = 1000;
      log('WS bağlandı (' + this.subs.size + ' kanal)');
      this._flush();
      this.pingTimer = setInterval(() => this._send({ op: 'ping' }), 25000);
    };
    this.ws.onmessage = ev => {
      const raw = typeof ev === 'string' ? ev : (ev && ev.data);
      if (!raw || raw === 'pong') return;
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
  stop() {
    this.closed = true;
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer);
    try { if (this.ws) this.ws.close(); } catch (e) { /* yok say */ }
  }
  _send(o) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); } catch (e) { /* yeniden bağlanır */ } }
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

/* WS ticker → TICK (mevcut priceOf/bookOf/exitPx/paperPnl hepsi bunu kullanır) */
function ingestTicker(sym, d, now) {
  const last = num(d.lastPr);
  if (!(last > 0)) return;
  const bid = num(d.bidPr) || last;
  const ask = num(d.askPr) || last;
  TICK[sym] = { last, bid, ask, quoteVolume: num(d.quoteVolume), percentage: num(d.change24h), timestamp: now };
  pushSnap(sym, now, last, num(d.quoteVolume));
  ringPush(sym, now, last);
}

/* WS trade → FLOW (gerçek işlem hacmi) */
function ingestTrade(sym, d) {
  const price = num(d.price), size = num(d.size);
  if (!(price > 0) || !(size > 0)) return;
  flowOnTrade(sym, num(d.ts) || Date.now(), price * size);
}

/* ─────────── SENTETİK 15 sn MUMLAR (REST yok) ─────────── */
/* Her mum qv0/qv1 taşır: WS trade kanalı soğukken hacim patlaması ticker
   quoteVolume farkından türetilebilsin. En eski bar `trunc` işaretlenir;
   coil penceresi onu dışlar, yoksa yarım bar sahte "sıkı aralık" üretir. */
function microBars(sym, now, count) {
  const s = SNAP[sym];
  if (!s || s.length < 8) return null;
  const B = PUMP.barMs, out = [];
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    if (!(x.p > 0)) continue;
    const b = Math.floor(x.t / B) * B;
    const last = out[out.length - 1];
    if (!last || last.t !== b) {
      out.push({ t: b, o: x.p, h: x.p, l: x.p, c: x.p, qv0: x.qv, qv1: x.qv, n: 1, trunc: false });
    } else {
      if (x.p > last.h) last.h = x.p;
      if (x.p < last.l) last.l = x.p;
      last.c = x.p;
      if (x.qv != null) last.qv1 = x.qv;
      last.n++;
    }
  }
  if (!out.length) return null;
  if (s[0].t > out[0].t + 1) out[0].trunc = true;
  const tail = out.slice(-(count || 40));
  return tail.length ? tail : null;
}

/* ─────────── z: coin'in KENDİ gürültüsüne göre sapma ─────────── */
/* Welford tek geçiş. Gürültü örneği son winMs'i DIŞLAR, böylece patlama
   kendi sigma'sını kirletemez. 0.03% taban: ölü defter sonsuz z üretmesin. */
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

/* ─────────── Hacim patlaması: WS flow → yoksa ticker farkı ─────────── */
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

/* ─────────── priorRunPct: "ilk bacak mı?" ─────────── */
/* KRİTİK: ölçüm now-20s'te BİTER. `now`a kadar ölçmek kırılımın kendisini
   "önceden hareket" sayar ve her geçerli sinyali reddeder.               */
function priorRunPct(sym, now, d, ms) {
  const s = SNAP[sym];
  if (!s || s.length < 6) return 0;
  const a = snapAt(s, now - ms);
  const end = snapAt(s, now - 20000);
  if (!a || !end || !(a.p > 0)) return 0;
  return (end.p / a.p - 1) * d * 100;
}

/* ─────────── IGNITION: coil kırılımı ─────────── */
function ignition(sym, now) {
  const mb = microBars(sym, now, 40);
  if (!mb || mb.length < PUMP.coilBars + 2) return null;

  const f = mb[mb.length - 1];                          // oluşmakta olan bar
  const ctx = mb.slice(0, -1).filter(b => !b.trunc);    // kapanmış, kırpılmamış
  if (ctx.length < PUMP.coilBars) return null;

  const win = ctx.slice(-PUMP.coilBars);
  let hiN = -Infinity, loN = Infinity;
  for (let i = 0; i < win.length; i++) {
    if (win[i].h > hiN) hiN = win[i].h;
    if (win[i].l < loN) loN = win[i].l;
  }
  if (!(loN > 0) || !(hiN > loN)) return null;

  // 1) coil SIKI olmalı, yoksa "kırılım" gürültüdür
  const preRng = (hiN / loN - 1) * 100;
  if (preRng > PUMP.coilMaxPct) return null;

  const rng = f.h - f.l;
  if (!(rng > 0)) return null;

  // 2) gövde baskınlığı: ignition barı bir "displacement" mumu olmalı
  const body = (f.c - f.o) / rng;
  const up = f.c > hiN && body >= PUMP.bodyMin;
  const dn = f.c < loN && body <= -PUMP.bodyMin;
  if (!up && !dn) return null;

  const dir = up ? 'LONG' : 'SHORT';
  const d = up ? 1 : -1;

  /* ORIGIN = KIRILAN kenar. Uzak kenarı kullanmak coil genişliği kadar
     (0.80%'e kadar) hayali gecikme ekler ve her geçerli kırılımı "geç"
     gösterir. Karşı kenar sadece başarısızlık sınırıdır; o iş slMin/slMax
     ile ifade edilir. */
  const origin = up ? hiN : loN;
  const disp = (f.c / origin - 1) * d * 100;
  if (!(disp >= PUMP.dispMinPct)) return null;

  // 3) hacim patlaması
  const vBurst = volumeBurst(sym, now);
  if (vBurst == null) { PWHY['veri yok (hacim)'] = (PWHY['veri yok (hacim)'] || 0) + 1; return null; }
  if (vBurst < PUMP.vel.minVolRatio) return null;

  // 4) istatistiksel teyit (gevşek: yapısal kapı işi zaten yaptı)
  const z = zOf(sym, now, 4000);
  if (z < PUMP.vel.minZ) return null;

  // 5) ilk bacak testi: son 90 sn'de aynı yönde anlamlı koşu olmamalı
  const priorRun = priorRunPct(sym, now, d, 90000);
  if (priorRun > PUMP.vel.priorMaxPct) return null;

  return { dir, origin, disp, z, vBurst, preRng, body: Math.abs(body), priorRun };
}

/* ─────────── ENTRY GUARD: parayı kurtaran iki kural ─────────── */
/* 1) GEÇ KALMA TAVANI: v72 dolumun origin'den 0.45% uzakta olmasına izin
      veriyordu. 0.60%'lik bir ilk bacakta bu 0.15% brüt bırakır = NET -0.05%.
      dEV/dLate = -1; her 10 bps gecikme bütçenin üçte birini yok eder.
        cap = clamp(0.30 * A, 0.12, 0.25)
   2) ALTIN KURAL: A - latePct >= 3 * H. Kalan mesafe maliyetin 3 katını
      karşılayamıyorsa işlem reddedilir.
      İkisi birlikte: A >= (3*0.20)/0.70 = 0.857% → ATR >= ~0.78%/1m.
      Daha fazla sinyal istiyorsan minEdgeMult'u 2.5 yap; H'yi DÜŞÜRME.   */
function entryGuard(sym, ig) {
  const bk = bookOf(sym);
  if (!bk) return { ok: false, reject: 'no-book' };
  if (!(bk.ask > 0) || !(bk.bid > 0) || !(bk.ask >= bk.bid)) return { ok: false, reject: 'bad-book' };

  const spreadPct = ((bk.ask - bk.bid) / bk.last) * 100;
  if (!(spreadPct <= PUMP.maxSpreadPct)) return { ok: false, reject: 'spread' };

  const d = ig.dir === 'LONG' ? 1 : -1;
  const fill = ig.dir === 'LONG' ? bk.ask : bk.bid;      // dürüst dolum, asla uydurma
  const latePct = (fill / ig.origin - 1) * d * 100;
  if (!(latePct > -0.05)) return { ok: false, reject: 'stale-origin' };

  const A = expectedLeg(sym);
  if (A == null) return { ok: false, reject: 'no-atr' }; // ATR cache soğuk; sonraki tur
  const cap = PUMP.vel.dynamicLateCap ? clamp(0.30 * A, 0.12, 0.25) : PUMP.vel.maxLatePct;
  if (latePct > cap) return { ok: false, reject: 'late' };

  // ---- ALTIN KURAL ----
  if (A - latePct < PUMP.vel.minEdgeMult * EX.H) return { ok: false, reject: 'no-edge' };

  // stop = origin ± tampon, sonra dolumdan [slMin, slMax] aralığına sıkıştır
  const slRaw = ig.dir === 'LONG'
    ? ig.origin * (1 - PUMP.vel.slBufferPct / 100)
    : ig.origin * (1 + PUMP.vel.slBufferPct / 100);
  const slPct = clamp(Math.abs(fill - slRaw) / fill * 100, PUMP.vel.slMin, PUMP.vel.slMax);
  const sl = fill * (1 - d * slPct / 100);

  // dinamik TP
  const atrPct = atrPctOf(sym);
  const tpPct = clamp(EX.TP_ATR_K * atrPct, EX.TP_MIN, EX.TP_MAX);
  const tp = fill * (1 + d * tpPct / 100);

  // net R:R maliyet tabanını geçmeli
  const netRR = (tpPct - EX.H) / (slPct + EX.H);
  if (netRR < EX.MIN_NET_RR) return { ok: false, reject: 'net-rr' };

  return {
    ok: true, dir: ig.dir, fill: rp(fill), sl: rp(sl), tp: rp(tp),
    latePct: +latePct.toFixed(3), slPct: +slPct.toFixed(2), tpPct: +tpPct.toFixed(2),
    netRR: +netRR.toFixed(2), A: +A.toFixed(2), spreadPct: +spreadPct.toFixed(3),
    originPx: rp(ig.origin)
  };
}

function scoreConfidence(ig, g) {
  const c =
    60 +
    clamp((ig.z - PUMP.vel.minZ) * 2.0, 0, 12) +
    clamp((ig.vBurst - PUMP.vel.minVolRatio) * 3.0, 0, 12) +
    clamp((g.A - g.latePct - PUMP.vel.minEdgeMult * EX.H) * 6, 0, 8) +
    clamp((PUMP.coilMaxPct - ig.preRng) * 4, 0, 5) +
    clamp((g.netRR - EX.MIN_NET_RR) * 6, 0, 5);
  return clamp(Math.round(c), 40, 95);
}

/* ─────────── SICAK YOL: senkron tarama ─────────── */
/* Bu fonksiyonda emirden ÖNCE tek bir await YOK. Sadece bellekteki
   ARMED kümesi gezilir. openPosition() ilk await'i kendi içinde yapar. */
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

    const det = {
      module: 'PUMP',
      symbol: sym,
      dir: g.dir,
      entry: g.fill,
      sl: g.sl,
      tp1: g.tp,
      tp2: null,
      single: true,
      conf: scoreConfidence(ig, g),
      holdSec: EX.HOLD,
      noMoveSec: EX.NO_MOVE,
      maxAgeMs: (EX.HOLD + 30) * 1000,
      // A = 1.10 * ATR%  →  pumpDecide'ın ihtiyaç duyduğu atrPct
      atrPct: +(g.A / EX.TP_ATR_K).toFixed(3),
      info: {
        tf: 'ignition', trigger: 'coil-break',
        originPx: g.originPx, latePct: g.latePct, disp: +ig.disp.toFixed(3),
        z: +ig.z.toFixed(1), vBurst: +ig.vBurst.toFixed(2),
        preRng: +ig.preRng.toFixed(2), body: +ig.body.toFixed(2),
        spreadPct: g.spreadPct, slPct: g.slPct, tpPct: g.tpPct,
        netRR: g.netRR, expectedLeg: g.A,
        lastPx: rp(bookOf(sym).last)
      }
    };
    addSignal(det);                     // SENKRON dispatch
  }
}

/* ─────────── legacy mum yolu (varsayılan KAPALI) ─────────── */
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
    if (!tk || !h || h.length < 5 || (tk.quoteVolume || 0) < PUMP.minQuoteVol) continue;
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

/* ─────────── ANA DÖNGÜ ─────────── */
/* Tarama ÖNCE: giriş gecikmesi beklentinin baskın terimi.
   Yönetim fire-and-forget; sadece canlı emir I/O'sunda await eder.       */
function pumpCycle() {
  const now = Date.now();
  pumpScanVel(now);
  if (PUMP.useCandlePath) pumpScanCandle(now).catch(e => log('HATA pumpScanCandle: ' + e.message));
  pumpManage(now).catch(e => log('HATA pumpManage: ' + e.message));
}

/* ─────────── ÖN ELEME / ÖN-ARM (sıcak yol dışında) ─────────── */
function refreshArmed() {
  const now = Date.now();
  ARMED.clear();
  for (const sym of ALL) {
    const tk = TICK[sym];
    if (!tk || !(tk.last > 0)) continue;
    if (!((tk.quoteVolume || 0) >= PUMP.minQuoteVol)) continue;
    const bid = tk.bid > 0 ? tk.bid : tk.last, ask = tk.ask > 0 ? tk.ask : tk.last;
    if (!(ask >= bid)) continue;
    if (((ask - bid) / tk.last) * 100 > PUMP.maxSpreadPct) continue;
    const s = SNAP[sym];
    if (!s || s.length < PUMP.vel.minHist) continue;
    ARMED.add(sym);
  }
  stream.setSymbols(ARMED);
  log('ARMED: ' + ARMED.size + ' sembol (spread<=' + PUMP.maxSpreadPct + '%, hacim>=' + (PUMP.minQuoteVol / 1e6).toFixed(1) + 'M)');
}

/* ATR: bilerek pumpScanVel'in DIŞINDA. 1m mumlardan, 6 paralel işçi. */
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
/* Beklenen ilk bacak. ATR cache soğuksa null → entryGuard 'no-atr' ile
   reddeder. Uydurma bir yedek ya her sinyali sessizce bloklar ya da zayıf
   coinleri sessizce geçirirdi; açık ret hata ayıklanabilir.               */
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
      } catch (e) { /* sembol atlanır */ }
    }
  });
  await Promise.all(workers);
}

/* Kaldıraç/marjin ön-arm: sinyal anında REST turu olmasın. */
const ARM_CTX = new Map();
async function armSymbol(sym, lev) {
  const c = ARM_CTX.get(sym) || {};
  if (c.levSetAt && c.lev === lev && Date.now() - c.levSetAt < 10 * M1) return c;
  try { await ex.setMarginMode('isolated', sym); } catch (e) { /* zaten isolated */ }
  await ex.setLeverage(lev, sym);                       // başarısızsa işlem açılmaz
  c.lev = lev; c.levSetAt = Date.now();
  ARM_CTX.set(sym, c);
  return c;
}
async function refreshLeverageArms() {
  if (settings.tradeMode !== 'live' || !IS_LIVE_READY) return;
  const lev = Math.min(settings.leverage, LIVE_MAX_LEVERAGE);
  for (const sym of ARMED) {
    try { await armSymbol(sym, lev); } catch (e) { /* sonraki turda tekrar */ }
  }
}

/* ─────────── TEMİZLİK ─────────── */
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
// EMA yapısı skoru (0=tam düşüş yapısı, 1=tam yükseliş yapısı): fiyat>EMA50, EMA20>EMA50, EMA50 eğimi yukarı, fiyat>EMA20
function emaScore(cs) {
  if (!cs || cs.length < 60) return null;
  const cl = closes(cs), e20 = emaArr(cl, 20), e50 = emaArr(cl, 50), m = cl.length - 1;
  return ((cl[m] > e50[m] ? 1 : 0) + (e20[m] > e50[m] ? 1 : 0) + (e50[m] > e50[m - 6] ? 1 : 0) + (cl[m] > e20[m] ? 1 : 0)) / 4;
}
const chgScore = c => (c == null || !isFinite(c) ? null : clamp(0.5 + c / 8, 0, 1));      // 24s değişim: -%4 → 0, +%4 → 1
// Piyasa yönü (bilgi amaçlı; sinyal engellemez). Skor = 0.5 x BTC/ETH trend puanı + 0.5 x genişlik
//  trend puanı = 0.7 x (BTC/ETH 1s+4s EMA yapısı) + 0.3 x (BTC/ETH 24s değişim)
//  genişlik    = 0.40 x (1s'te EMA20 üstü coin oranı) + 0.35 x (4s'te EMA50 üstü coin oranı) + 0.25 x (24s'te yükselen coin oranı)
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
  const why = 'BTC/ETH trend puanı ' + pc(trfPct) + ' (EMA yapısı + 24s değişim); EMA üstü coin oranı 1s ' + pc(b1) + ', 4s ' + pc(b4) + '; 24s yükselen ' + pc(bp) +
    ' → skor ' + score.toFixed(2) + (dir === 'LONG' ? ' (>0.58 ALIŞ)' : dir === 'SHORT' ? ' (<0.42 SATIŞ)' : ' (0.42–0.58 arası NÖTR)');
  if (dir !== market.dir) log('PİYASA YÖNÜ: ' + market.dir + ' → ' + dir + ' | ' + why);
  Object.assign(market, { dir, score: +score.toFixed(3), trf: +trfPct.toFixed(3), breadth: +breadth.toFixed(3), b1h: +b1.toFixed(3), b4h: +b4.toFixed(3), b24: +bp.toFixed(3), why, updatedAt: Date.now() });
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
    if (i === 0) named.btc = [r1, r4];
    if (i === 1) named.eth = [r1, r4];
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
  // Bu oran FİYAT YÖNÜ değil, hesapların long/short POZİSYON dağılımıdır (kalabalığın ne yaptığı). Fiyat yönüyle çelişmesi normaldir.
  R.ls.label = 'Long/Short hesap oranı (kalabalığın pozisyonu — fiyat yönü değildir)';
  const crowd = R.ls.long >= 60 ? 'Çoğunluk LONG pozisyonda.' : R.ls.long <= 40 ? 'Çoğunluk SHORT pozisyonda.' : 'Long ve short dengeli.';
  let rel = '';
  if (market.dir === 'SHORT' && R.ls.long >= 55) rel = ' Fiyat düşerken kalabalığın long olması aşağı yönlü baskıyı ve long likidasyon (long squeeze) riskini artırır; çelişki değil, düşüşü besleyen bir unsurdur.';
  else if (market.dir === 'LONG' && R.ls.long <= 45) rel = ' Fiyat yükselirken kalabalığın short olması short squeeze ile yukarı ivmeyi besleyebilir.';
  else if (market.dir === 'LONG' && R.ls.long >= 60) rel = ' Yükselişe kalabalık long eşlik ediyor; aşırı kalabalık geri çekilme riskini artırır.';
  else if (market.dir === 'SHORT' && R.ls.long <= 40) rel = ' Düşüşe kalabalık short eşlik ediyor; sert tepki yükselişinde short squeeze riski vardır.';
  R.ls.text = crowd + rel;
  radar = R;
}

/* ───────── İSTATİSTİK ───────── */
function statsByModule() {
  const rows = [];
  let T = { module: 'TOPLAM', label: 'Toplam', total: 0, open: 0, wins: 0, losses: 0, winRate: 0, grossR: 0, netR: 0, reasons: {} };
  Object.keys(MODS).forEach(k => {
    const all = signals.filter(s => s.module === k), cl = all.filter(s => s.status === 'KAPALI' && s.result !== 'DOLMADI');
    const unfilled = all.filter(s => s.result === 'DOLMADI').length;
    const wins = cl.filter(s => s.netR > 0).length, losses = cl.length - wins;
    const reasons = {};
    cl.forEach(s => { const r = s.result || '?'; reasons[r] = (reasons[r] || 0) + 1; T.reasons[r] = (T.reasons[r] || 0) + 1; });
    const row = { module: k, label: MODS[k].label, total: all.length, open: all.filter(s => s.status !== 'KAPALI').length, unfilled, wins, losses, winRate: cl.length ? +(wins / cl.length * 100).toFixed(1) : 0, grossR: +cl.reduce((a, s) => a + (s.grossR || 0), 0).toFixed(2), netR: +cl.reduce((a, s) => a + (s.netR || 0), 0).toFixed(2), reasons };
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
  PUMP:    { tf: '1m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m1.hold / 60), detect: w => detectBurst(w, M1, null), pump: true },
  PUMP3:   { tf: '3m',  warm: 50,  win: 60,  maxBars: Math.ceil(PUMP.m3.hold / 180), detect: w => detectBurst(w, M3, null), pump: true },
  SCALPER: { tf: '15m', warm: 80,  win: 100, maxBars: 16, detect: w => detectScalper(w) },
  TREND:   { tf: '5m',  warm: 100, win: 130, maxBars: 24, detect: w => detectPSAR(w) },
  LT:      { tf: '4h',  warm: 70,  win: 130, maxBars: 30, detect: w => detectLT(w).signal || null },
  ZONE:    { tf: '1h',  warm: 260, win: 260, maxBars: 24, detect: w => detectZone(w, buildZones(w, null)).signal },
  RANGE:   { tf: '15m', warm: 80,  win: 100, maxBars: 12, detect: w => detectRevert(w) }
};
const BT_TOTAL = { '1m': 2400, '3m': 1500, '5m': 1500, '15m': 1500, '1h': 1500, '4h': 1000 };
function btStats(rs) {
  const n = rs.length;
  if (!n) return { n: 0, winRate: 0, pf: 0, maxDD: 0, sumR: 0, avgR: 0 };
  let w = 0, gw = 0, gl = 0, cum = 0, peak = 0, dd = 0;
  for (const r of rs) { if (r > 0) { w++; gw += r; } else gl -= r; cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { n, winRate: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0), maxDD: +dd.toFixed(2), sumR: +cum.toFixed(2), avgR: +(cum / n).toFixed(3) };
}
// Tüm modüller için tek mum tabanlı simülatör (PUMP: cfg.pump → pumpDecide ile çıkış). Maliyet yok (Net R = Brüt R).
// Not: backtest kapanmış mumlarda çalışır; canlıda AlgoPump oluşmakta olan mumda daha erken girebilir.
function btCoin(cs, cfg, refDir, ms) {
  const out = [];
  for (let i = cfg.warm; i < cs.length - 1; i++) {
    const w = cs.slice(Math.max(0, i - cfg.win + 1), i + 1);
    let det = null;
    try { det = cfg.detect(w); } catch (e) { det = null; }
    if (!det) continue;
    const t = Object.assign({}, det, { curSl: det.sl, tp1Hit: false, createdAt: 0, peakPct: null });
    let exit = null, reason = 'SURE', k = Math.min(cs.length - 1, i + cfg.maxBars);
    for (let j = i + 1; j <= k; j++) {
      const c = cs[j], r = stepTrade(t, c);
      if (r && r.done) { exit = r.price; reason = cfg.pump && r.reason === 'TP1' ? 'TPMAX' : r.reason; k = j; break; }
      if (cfg.pump) {
        pumpPeak(t, t.dir === 'LONG' ? c.h : c.l);
        const dec = pumpDecide(t, c.c, (j - i) * ms);
        if (dec) { exit = c.c; reason = dec; k = j; break; }
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
  const cfg = (mod === 'PUMP' && tf === '3m') ? BT.PUMP3 : BT[mod];
  const syms = TOP.slice(0, coins), trades = [];
  let tMin = Infinity, tMax = 0, done = 0, used = 0, unfilledTotal = 0;
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
  const reasons = {};
  ft.forEach(x => { const r = reasons[x.reason] || (reasons[x.reason] = { n: 0, sumNet: 0 }); r.n++; r.sumNet = +(r.sumNet + x.net).toFixed(3); });
  job.result = {
    module: mod, label: MODS[mod].label, tf, coins: used, trades: ft.length, rawTrades: trades.length, reasons,
    all: btStats(ft.map(x => x.net)), raw: btStats(trades.map(x => x.net)), train: btStats(train), valid: btStats(valid),
    curve, splitIdx: Math.floor(train.length / step),
    aligned: btStats(trades.filter(x => x.aligned).map(x => x.net)), counter: btStats(trades.filter(x => !x.aligned).map(x => x.net)),
    note: 'Canlıda yön filtresi ve maliyet hesabı yoktur (Net R = Brüt R). aligned/counter alanları BTC 1h EMA50 yönüne uyumlu ve ters işlemleri ayrı gösterir. Backtest tek zaman dilimiyle çalışır ve kapanmış mumlarda çalışır; canlıda AlgoPump oluşmakta olan mumda daha erken girebilir. 4H/1D teyitleri ve konfluans dahil değildir. Geçmiş performans gelecek garantisi değildir.'
  };
  job.status = 'bitti';
}

/* ───────── STRATEJİ AÇIKLAMALARI ───────── */
const STRATEGIES = [
  { module: 'TREND', name: 'Trend (PSAR)', tf: '5m', desc: 'Parabolic SAR dönüşü (son kapanan mumda yön değişimi) + Williams %R (LONG > -50, SHORT < -50) + fiyat EMA' + PSAR.emaP + ' doğru tarafında + ADX > ' + PSAR.adxMin + '. Fiyat EMA' + PSAR.emaP + '\'ten ' + PSAR.maxExtAtr + ' ATR\'den fazla uzaksa (geç kalınmış) sinyal verilmez. Kısa vadeli vur-kaç.', params: 'SL yeni PSAR (1.2–2.5 ATR bandı, min %' + PSAR.minRiskPct + '), TP1 ' + PSAR.tp1R + 'R (yarısı kapanır, stop girişe), TP2 ' + PSAR.tp2R + 'R. Süre 2 saat.' },
  { module: 'SCALPER', name: 'Scalper (SMC/BOS)', tf: '15m', desc: 'Son onaylı pivot swing high/low seviyesinin ilk kez GÖVDE ile kırılması (gövde > mumun yarısı) + hacim ≥ ' + SCALP.minVolX + 'x + giriş kırılan seviyeye en fazla %' + SCALP.maxDistPct + ' uzak + min güven ' + SCALP.minConf + '.', params: 'SL kırılan seviyenin 0.5 ATR gerisi (min %0.6). TP1 ' + SCALP.tp1R + 'R, TP2 ' + SCALP.tp2R + 'R. Süre 4 saat.' },
  { module: 'LT', name: 'LT Üçgen', tf: '4h + 1d teyit', desc: '2h ve 4h grafikte en tepe pivottan alçalan tepeler boyunca üst çizgi, en dip pivottan yükselen dipler boyunca alt çizgi çekilir ve ileriye uzatılır. Sıkışma<0.75, olgunluk 0.4–1.0. Kırılım: çizgiyi %0.3 aşan kapanış + hacim>1.2x.', params: 'TP1 %60, TP2 %100 üçgen yüksekliği, SL üçgen orta noktası.' },
  { module: 'ZONE', name: 'Zone Master', tf: '1h + 4h bölge', desc: '1H ve 4H pivotları %0.4 toleransla kümelenir; skor = değme×1.5 + hacim − yaşlanma. Skor≥6 bölgede onay mumu (yeşil/kırmızı + fitil≥gövde) + hacim ≥1.2x + TREND YÖNÜNDE (destekte LONG için EMA50 düşmüyor, dirençte SHORT için yükselmiyor) olduğunda sinyal. Düşen bıçağı tutmaz.', params: 'SL bölge dışı 0.3xATR, TP1 karşı bölge veya 1.5R, TP2 2.5R.' },
  { module: 'RANGE', name: 'Range (Mean Reversion)', tf: '15m', desc: 'Bollinger(20,2) bandının dışına taşıp içeri kapanan, fitili mum aralığının ≥%' + REVERT.wickMin * 100 + '\'i olan ve hacmi ≥' + REVERT.minVolX + 'x olan mumda ORTALAMAYA (orta banda) dönüş. Rejim ayırıcı: ADX < ' + REVERT.adxMax + ' ve bant genişlemiyor. Min R:R ' + REVERT.minRR + '. Yön fark etmeksizin (iki yönde) sinyal verir.', params: 'Giriş kapanış fiyatı (bilgi: ' + REVERT.limitAtr + ' ATR içeriden limit daha iyi giriş verir). SL fitil ucunun ' + REVERT.stopAtr + ' ATR ötesi, TP1 orta bant, TP2 orta bandın ötesi. Süre 3 saat.' },
  { module: 'PUMP', name: 'AlgoPump', tf: 'ignition (15 sn sentetik mum)', desc: 'Coil kırılımı: 16 x 15 sn sıkışma (<=%' + PUMP.coilMaxPct + ') + gövde-baskın barın coil dışına kapanışı (|gövde| >= %' + Math.round(PUMP.bodyMin * 100) + ') + hacim >= ' + PUMP.vel.minVolRatio + 'x + z >= ' + PUMP.vel.minZ + '. Yapısal kapı olduğu için eşikler v72\'ye göre gevşetildi ve giriş 2-4 sn daha erken. Geç kalma tavanı DİNAMİK: clamp(0.30*A, %0.12, %0.25). ALTIN KURAL: kalan mesafe >= ' + PUMP.vel.minEdgeMult + ' x maliyet (' + EX.H + '%). Giriş/çıkış GERÇEK bid/ask\'tan; spread ikinci kez düşülmez.', params: 'STOP = kırılan coil kenarı (origin) ± %' + PUMP.vel.slBufferPct + ' (min %' + PUMP.vel.slMin + ', max %' + PUMP.vel.slMax + '). TP = clamp(' + EX.TP_ATR_K + ' x ATR%, %' + EX.TP_MIN + ', %' + EX.TP_MAX + '). FADE sadece zirve >= %' + EX.LOCK_ARM + ' sonra; en kötü neti +%' + (EX.LOCK_ARM - EX.GB_MIN - EX.H).toFixed(2) + '. Cost-cover stopu zirve >= %' + EX.BE_ARM + ' (giriş + %' + EX.BE_LOCK + '). Momentum decay SADECE net >= %' + EX.DECAY_MIN_PNL + ' iken. BAIL, NOMOVE (' + EX.NO_MOVE + ' sn), SURE (' + EX.HOLD + ' sn).' }
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
const PLACEHOLDER = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>AlphaSon ' + VERSION + '</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;background:#0b1220;color:#e5e7eb;padding:2rem"><h2>AlphaSon ' + VERSION + '</h2><p>Backend çalışıyor. Arayüz henüz eklenmedi: <code>index.html</code> dosyasını server.js ile aynı klasöre koyun.</p><p><a style="color:#60a5fa" href="/api/state">/api/state</a></p></body></html>';
app.get('/', (req, res) => {
  let html = PLACEHOLDER;
  try { const p = path.join(__dirname, 'index.html'); if (fs.existsSync(p)) html = fs.readFileSync(p, 'utf8'); } catch (e) { /* placeholder */ }
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, liveReady: IS_LIVE_READY }));
app.get('/api/state', h((req, res) => {
  const act = signals.filter(s => s.status === 'AKTIF'), byMod = {};
  Object.keys(MODS).forEach(k => { byMod[k] = act.filter(s => s.module === k).length; });
  res.json({ version: VERSION, now: Date.now(), uptime: Math.round(process.uptime()), market, settings, counts: { active: act.length, byModule: byMod }, scan: { universe: TOP.length, all: ALL.length, excluded: stats.excluded, apiErr: stats.apiErr, tickAt: stats.tickAt }, blocks: BLK, paper: paperSummary(), modules: MODS, ready: TOP.length > 0, liveReady: IS_LIVE_READY, realBal, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE } });
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
  if (!ok) return res.status(500).json({ error: 'Kapatılamadı (canlı emir hatası olabilir, logları kontrol et)' });
  res.json({ ok: true, paper: p });
}));
app.post('/api/trade/mode', h(async (req, res) => {
  const mode = req.body && req.body.mode === 'live' ? 'live' : 'paper';
  if (mode === 'live') {
    if (!IS_LIVE_READY) return res.status(400).json({ error: 'API anahtarları eksik! Render Environment kısmına BITGET_API_KEY, BITGET_SECRET, BITGET_PASSPHRASE ekleyin.' });
    await fetchRealBalance();
    if (!(realBal.total > 0)) return res.status(400).json({ error: 'Bitget bakiyesi okunamadı ya da 0' + (realBal.error ? ' (' + realBal.error + ')' : '') });
    if (!(settings.dailyLossPct > 0)) { settings.dailyLossPct = 3; log('LIVE: günlük zarar limiti zorunlu → %3 olarak ayarlandı'); }
    paper.liveDayStart = realBal.total; paper.liveDayPnl = 0; paper.dayKey = new Date().toISOString().slice(0, 10);
  }
  settings.tradeMode = mode;
  saveSettings();
  log('İŞLEM MODU: ' + mode.toUpperCase() + (mode === 'live' ? ' | tavanlar: teminat ' + LIVE_MAX_MARGIN + ' USDT, kaldıraç ' + LIVE_MAX_LEVERAGE + 'x, günlük zarar %' + settings.dailyLossPct : ''));
  res.json({ ok: true, settings, liveCaps: { maxMargin: LIVE_MAX_MARGIN, maxLeverage: LIVE_MAX_LEVERAGE } });
}));
app.post('/api/paper/reset', h((req, res) => {
  const lives = paper.open.filter(p => p.isLive);       // canlı pozisyonlar sıfırlamayla SİLİNMEZ
  paper = { seq: paper.seq, balance: START_BALANCE, startBalance: START_BALANCE, open: lives, closed: [], n: 0, wins: 0, sumPnl: 0, dayKey: '', dayStart: START_BALANCE, liveDayPnl: paper.liveDayPnl || 0, liveDayStart: paper.liveDayStart || 0 };
  dirty = true; log('PAPER: Sanal hesap sıfırlandı (bakiye ' + START_BALANCE + ' USDT)' + (lives.length ? ' | ' + lives.length + ' canlı pozisyon korundu' : ''));
  res.json({ ok: true });
}));
app.get('/api/watch/:kind', h((req, res) => res.json({ items: WATCH[req.params.kind] || [] })));
app.get('/api/radar', h((req, res) => res.json({ radar, market })));
app.get('/api/stats', h((req, res) => res.json({ modules: statsByModule(), costPct: COST_PCT, note: 'Maliyet hesabı kapalı: Net R = Brüt R' })));
app.get('/api/strategies', h((req, res) => res.json({ version: VERSION, strategies: STRATEGIES, limits: { globalMax: 0, perModule: Object.keys(MODS).reduce((o, k) => { o[k] = MODS[k].max; return o; }, {}) } })));
app.get('/api/logs', h((req, res) => res.json({ logs: LOGS.slice(-150) })));
app.post('/api/backtest', h((req, res) => {
  const b = req.body || {}, mod = String(b.module || '').toUpperCase();
  if (!BT[mod]) return res.status(400).json({ error: 'Geçersiz modül' });
  const tf = BT_TOTAL[b.tf] ? b.tf : BT[mod].tf;
  const effTf = mod === 'PUMP' ? (b.tf === '3m' ? '3m' : '1m') : (mod === 'TREND' || mod === 'SCALPER' || mod === 'RANGE') ? BT[mod].tf : tf;
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
    catch (e) { log('HATA: Borsa verisi alınamadı (' + e.message + '), 15 sn sonra tekrar...'); await new Promise(r => setTimeout(r, 15000)); }
  }
  every('evren', 30 * M1, refreshUniverse, 30 * M1);
  every('piyasa', 2 * M1, marketCycle, 3000);
  every('realbal', 30000, fetchRealBalance, 5000);
  every('livesync', 10000, syncLive, 15000);
  every('ticker', 3000, refreshTickers, 0);              // REST yedeği (WS varsa üstüne yazar)
  every('armed', 30000, refreshArmed, 2500);             // ön eleme + WS abonelik
  every('atr', 30000, refreshAtr, 6000);                 // ATR önbelleği (sıcak yol dışı)
  every('levarm', 60000, refreshLeverageArms, 15000);    // canlı kaldıraç ön-arm
  every('pump', 500, pumpCycle, 1500);                   // 500 ms tarama (v72: 1500 ms)
  every('takip', 20000, trackerCycle, 8000);
  every('scalper', 60000, scanScalper, 12000);
  every('range', 5 * M1, scanRange, 25000);
  every('zone', 5 * M1, scanZone, 45000);
  every('trend', 60000, scanTrend, 20000);
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
    const tw = Object.keys(TWHY).sort((a, b) => TWHY[b] - TWHY[a]).map(k => k + ' ' + TWHY[k]).join(', ');
    if (tw) log('Trend (PSAR) red nedenleri: ' + tw);
    const rw = Object.keys(RWHY).sort((a, b) => RWHY[b] - RWHY[a]).map(k => k + ' ' + RWHY[k]).join(', ');
    if (rw) log('Range (Mean Rev.) red nedenleri: ' + rw);
    Object.keys(SC).forEach(k => delete SC[k]);
    Object.keys(SWHY).forEach(k => delete SWHY[k]);
    Object.keys(TWHY).forEach(k => delete TWHY[k]);
    Object.keys(RWHY).forEach(k => delete RWHY[k]);
  }, 10 * M1);
  every('temizlik', 10 * M1, async () => {
    const now = Date.now();
    Object.keys(jobs).forEach(k => { if (now - jobs[k].startedAt > 30 * M1) delete jobs[k]; });
    prunePumpState(now);
  }, 10 * M1);
}
function start() {
  log('AlphaSon ' + VERSION + ' başlatılıyor...' + (ALLOW_TOKENIZED ? ' (tokenize varlıklar AÇIK)' : ''));
  // Maliyet eşitsizliği boot'ta kanıtlanır: bozulursa bot AÇILMAZ.
  const inv = assertInvariants();
  log('AlgoPump v73 maliyet: H=' + inv.H + '% | en kötü FADE neti +' + inv.worstFadeNet + '% | BE neti ' + inv.costCoverNet + '%');
  log('AlgoPump v73 taban: işlem için A >= %' + inv.minTradeableLegPct + ' (ATR >= %' + inv.minTradeableAtrPct + '/1m)');
  loadAll();
  stream.start();
  app.listen(PORT, () => log('Sunucu hazır: port ' + PORT));
  init().catch(e => log('KRİTİK: init hatası ' + e.message));
}
process.on('uncaughtException', e => log('YAKALANMAMIŞ HATA: ' + (e && e.message)));
process.on('unhandledRejection', e => log('YAKALANMAMIŞ RED: ' + (e && e.message ? e.message : e)));
['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, () => { log('Kapanıyor, veriler kaydediliyor...'); dirty = true; saveAll(); process.exit(0); }));

if (require.main === module) start();
module.exports = { btCoin, BT, analyzeTriangle, anchorLine, pivots, calcPSAR, williamsR, regimeOf, bandsOf, detectPSAR, detectBurst, detectScalper, detectRevert, detectRange, detectLT, detectZone, buildZones, pumpDecide, stepTrade, calcR, isTokenized, VERSION, assertInvariants, pumpScanVel, ignition, entryGuard, microBars, atrPctFromCandles, pumpPeak, applyCostCover, velRatio, tpTarget, setAtr, TICK, SNAP, RING, FLOW, ATRC, ARMED, zOf, qvBurst, volumeBurst, priorRunPct };
