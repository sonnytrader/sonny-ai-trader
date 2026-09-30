'use strict';
// ============================================================
// SONER TRADE v24 — Üçgen 1H yapı + 15m onaylı kırılım + piyasa yönü filtresi
//   Yapı  : 1H mumlardan üçgen (TRI_TF ile 2h/1h/15m seçilebilir)
//   Giriş : 15m kapanışı çizgi dışında + hacim  (onaylı)
//           ya da mum içi güçlü patlama           (erken)
//   Stop  : çizginin geri içi (15m ATR tamponlu) | Hedef: üçgen yüksekliği (ölçülü hareket)
//   Filtre: regime.js (BTC+ETH+breadth yönü), güç eşiği, maliyet/R eşiği
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

let createRegime = () => ({ tick: async () => null, chg: () => null }), gate = () => ({ ok: true });
try { ({ createRegime, gate } = require('./regime')); } catch (e) { console.log('[SONER] regime.js bulunamadı — yön filtresi KAPALI'); }

const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UI_KEY = process.env.UI_KEY || '';
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';

const TRI_TF = (process.env.TRI_TF || '1h').toLowerCase();
const TRI_MS = TRI_TF === '2h' ? H2 : TRI_TF === '1h' ? H1 : M15;
const SCAN_MS = M15;

const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

// ======================= AYARLAR =======================
const CFG = {
    UNIVERSE: num('UNIVERSE', 150),
    MIN_VOL_USDT: num('MIN_VOL', 1e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, UNIVERSE_MS: 5 * 60e3, KEEP: 500,
    SCAN_DELAY_MS: 8000,
    // --- üçgen tespiti ---
    TRI_K: num('TRI_K', 3),
    TRI_LOOK: num('TRI_LOOK', 150),
    TRI_MIN_LEN: num('TRI_MIN_LEN', 15),
    TRI_MAX_LEN: num('TRI_MAX_LEN', 100),
    TRI_TOL_ATR: num('TRI_TOL_ATR', 0.30),      // v23: 0.50 (çok gevşekti)
    TRI_WICK_ATR: num('TRI_WICK_ATR', 0.60),
    TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.20),
    TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 3),
    TRI_SQUEEZE: num('TRI_SQUEEZE', 0.85),
    TRI_FLAT: num('TRI_FLAT', 0.12),
    GRACE_MIN: num('GRACE_MIN', 30),            // üçgen bozulsa bile (kırılım mumu) çizgiler bu kadar dk tutulur
    // --- radar / kırılım ---
    NEAR_ATR: num('NEAR_ATR', 0.4),             // radara girme mesafesi (1H ATR)
    BRK_SEE: num('BRK_SEE', 0.8),               // çizgiyi aştıktan sonra radarda kalma mesafesi
    BRK_ATR: num('BRK_ATR', 0.15),              // 15m kapanış çizgiyi en az bu kadar aşmalı
    BRK_VOL: num('BRK_VOL', 1.3),               // kırılım mumu hacmi / önceki 20 ort.
    FRESH_MIN: num('FRESH_MIN', 5),             // onaylı kapanıştan sonra en fazla kaç dk içinde gir
    MAX_CHASE: num('MAX_CHASE', 0.6),           // çizgiden en fazla bu kadar uzaklaşmış fiyattan girme
    EARLY_ATR: num('EARLY_ATR', 0.35),          // erken giriş: çizgi ötesi min mesafe
    EARLY_VOL: num('EARLY_VOL', 2.0),           // erken giriş: projeksiyon hacim çarpanı
    // --- risk / hedef ---
    STOP_ATR15: num('STOP_ATR15', 0.6),         // stop = çizgi ∓ bu kadar 15m ATR
    MIN_RR: num('MIN_RR', 1.5),                 // ölçülü hedefe en az bu kadar R kalmalı
    MAX_TP2R: num('MAX_TP2R', 5),
    MIN_STRENGTH: num('MIN_STRENGTH', 45),
    MAX_COST_R: num('MAX_COST_R', 0.25),
    SLIP_PCT: num('SLIP_PCT', 0.03),            // taraf başı kayma (%)
    COOLDOWN_MIN: num('COOLDOWN_MIN', 45),
    MAX_OPEN: num('MAX_OPEN', 6),
    DAY_STOP_R: num('DAY_STOP_R', -3),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.25),
    MAX_RISK_PCT: num('MAX_RISK_PCT', 2.5),
    TP1_R: num('TP1_R', 1.0),
    TRAIL_R: num('TRAIL_R', 1.0),
    MAX_HOLD_MS: num('MAX_HOLD_H', 6) * H1,
    TS_MS: num('TS_MIN', 90) * 60e3, TS_MFE: 0.3
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const flatRatio = c => { const a = c.slice(-48); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const hasGap = (c, ms, n) => { const a = c.slice(-n); for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] !== ms) return true; return false; };
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const r2 = x => Number(x.toFixed(3));
const atrMean = (c, p = 14) => {
    if (c.length <= p) return 0; let s = 0;
    for (let i = c.length - p; i < c.length; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
    return s / p;
};
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ======================= GÖSTERGELER =======================
function aggregateN(c, baseMs, n) {
    const ms = baseMs * n, g = new Map();
    for (const x of c) {
        const k = Math.floor(x[0] / ms) * ms;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}
function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
}
function atrSeries(c, p = 14) {
    const o = new Array(c.length).fill(null); if (c.length <= p) return o;
    let a = 0;
    for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
    a /= p; o[p] = a;
    for (let i = p + 1; i < c.length; i++) {
        const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
        a = (a * (p - 1) + tr) / p; o[i] = a;
    }
    return o;
}
function volSma(c, p = 20) {
    const o = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; }
    return o;
}
const clOf = a => a.map(x => x[4]);

// ======================= ÜÇGEN =======================
function pivots(c, end, K, from) {
    const hi = [], lo = [];
    for (let i = Math.max(K, from); i <= end - K; i++) {
        let isH = true, isL = true;
        for (let d = 1; d <= K && (isH || isL); d++) {
            if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false;
            if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false;
        }
        if (isH) hi.push({ i, p: c[i][2] });
        if (isL) lo.push({ i, p: c[i][3] });
    }
    return { hi, lo };
}
function fitLine(pts, c, end, atr, side, C) {
    const P = pts.slice(-8); let best = null;
    for (let a = 0; a < P.length - 1; a++) {
        for (let b = a + 1; b < P.length; b++) {
            const A = P[a], B = P[b];
            if (B.i - A.i < 3) continue;
            const s = (B.p - A.p) / (B.i - A.i);
            let ok = true;
            for (let x = A.i; x <= end; x++) {
                const ln = A.p + s * (x - A.i);
                if (side === 1 ? (c[x][4] > ln + C.TRI_CLOSE_ATR * atr || c[x][2] > ln + C.TRI_WICK_ATR * atr)
                               : (c[x][4] < ln - C.TRI_CLOSE_ATR * atr || c[x][3] < ln - C.TRI_WICK_ATR * atr)) { ok = false; break; }
            }
            if (!ok) continue;
            const pts2 = [];
            for (const p of P) if (p.i >= A.i && Math.abs(p.p - (A.p + s * (p.i - A.i))) <= C.TRI_TOL_ATR * atr) pts2.push(p);
            if (pts2.length < 2) continue;
            const lastI = pts2[pts2.length - 1].i;
            if (end - lastI > 40) continue;
            const score = pts2.length * 1000 + (lastI - A.i) * 2;
            if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches: pts2.length, last: lastI, score, pts: pts2 };
        }
    }
    return best;
}
function detectTriangle(c, end, C) {
    if (end < 50) return null;
    const atr = atrSeries(c, 14)[end];
    if (!(atr > 0)) return null;
    const pv = pivots(c, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
    if (pv.hi.length < 2 || pv.lo.length < 2) return null;
    const R = fitLine(pv.hi, c, end, atr, 1, C);
    const S = fitLine(pv.lo, c, end, atr, -1, C);
    if (!R || !S) return null;
    if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null;
    const xs = Math.max(R.i0, S.i0), len = end - xs;
    if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null;
    const rv = x => R.p0 + R.s * (x - R.i0);
    const sv = x => S.p0 + S.s * (x - S.i0);
    const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
    if (!(w0 > 0 && wN > 0)) return null;
    if (wN / w0 > C.TRI_SQUEEZE) return null;
    if (wN < 0.4 * atr) return null;
    const dsl = S.s - R.s;
    if (!(dsl > 0)) return null;
    const apex = end + wN / dsl;
    if (apex - end > 100) return null;
    const flatTol = C.TRI_FLAT * w0 / len;
    const rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol;
    let type = 'Simetrik';
    if (rf && S.s > flatTol) type = 'Yükselen';
    else if (sf && R.s < -flatTol) type = 'Alçalan';
    else if (R.s < -flatTol && S.s > flatTol) type = 'Simetrik';
    else if (R.s > flatTol && S.s > flatTol) type = 'Yükselen Kama';
    else if (R.s < -flatTol && S.s < -flatTol) type = 'Alçalan Kama';
    return { type, end, atr, w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: wN / w0 };
}
function pack(tri, c) {
    const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * TRI_MS;
    const xEnd = Math.min(tri.apex, tri.end + 15);
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0);
    const lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);
    const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
    return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0,
        res: seg(tri.R, lineR), sup: seg(tri.S, lineS),
        hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
}

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0 }, dirty = false, lastScanSlot = 0;
const candleCache = new Map();
let triRadar = [], dropped = [], blocked = [], liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const struct = {}, volCache = new Map(), blockT = {};
const prevRadarKeys = new Set();
const regime = createRegime(); let REG = null;

// ======================= STATE =======================
function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => s && s.id && s.entry);
        lastSig = j.lastSig || {};
        log('durum:', signals.length, 'sinyal');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        const cut = Date.now() - 24 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals: signals.slice(0, CFG.KEEP), lastSig }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = Date.now(); tgTimes = tgTimes.filter(t => now - t < 60e3);
    if (tgTimes.length >= 18) return; tgTimes.push(now);
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) }); } catch (e) { }
}
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;

// ======================= EVREN =======================
function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const m = ex.markets[sym], inf = (m && m.info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    const st = String(inf.symbolType || inf.category || '').toLowerCase();
    if (st && st !== 'perpetual' && st !== 'crypto') return true;
    const lt = Number(inf.launchTime || inf.onlineTime || 0);
    return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * 86400e3;
}
async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers(); market.lastTick = Date.now();
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = all.filter(t => {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase())) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) return false;
            return true;
        });
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length;
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t.last, chg: t.percentage }; } }
    } catch (e) { log('evren hatası', e.message); }
}
async function fetchTriCandles(sym) {
    if (TRI_TF === '2h') {
        const c1h = await ex.fetchOHLCV(sym, '1h', undefined, 500);
        return closedOnly(aggregateN(c1h, H1, 2), H2);
    } else if (TRI_TF === '1h') {
        return closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 400), H1);
    } else {
        return closedOnly(await ex.fetchOHLCV(sym, '15m', undefined, 500), M15);
    }
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t[s].last, chg: t[s].percentage }; }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}

// ======================= SİNYAL =======================
function mkSig(o) {
    const side = o.dir === 'LONG' ? 1 : -1, risk = side * (o.entry - o.stop), riskPct = risk / o.entry * 100;
    return {
        id: o.sym.replace(/[^A-Z0-9]/g, '') + '_' + o.time,
        symbol: o.sym, base: baseOf(o.sym), dir: o.dir,
        setup: 'TRI', setupName: 'Üçgen ' + o.type + ' • ' + (side === 1 ? 'yukarı' : 'aşağı') + ' kırılım (' + o.mode + ')',
        mode: o.mode, reg: o.reg || '-',
        strength: o.strength,
        entry: o.entry, stop: o.stop, initialStop: o.stop,
        tp1R: CFG.TP1_R, tp2R: o.tp2R, trail: CFG.TRAIL_R, atr: o.atr,
        tp1: o.entry + side * risk * CFG.TP1_R, tp2: o.entry + side * risk * o.tp2R,
        tsMs: CFG.TS_MS, tsMfe: CFG.TS_MFE, maxHold: CFG.MAX_HOLD_MS,
        riskPct: r2(riskPct), costR: r2(o.costPct / riskPct),
        volX: r2(o.volX), level: o.level,
        warnings: [], tri: o.triPack || null,
        time: o.time, lastPrice: o.entry, mfe: 0, mae: 0, trackedTo: o.trackedTo,
        status: 'OPEN', reason: o.reason
    };
}
function canOpen(sym) {
    const open = signals.filter(isOpen);
    if (open.some(x => x.symbol === sym)) return 'açık var';
    if (open.length >= CFG.MAX_OPEN) return 'limit dolu';
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const today = trDay(Date.now());
    const dayR = closed.filter(s => trDay(s.closedAt) === today).reduce((a, s) => a + s.netR, 0);
    if (dayR <= CFG.DAY_STOP_R) return 'günlük limit';
    return null;
}
function block(sym, dir, why, now) {
    const k = sym + dir + why;
    if (now - (blockT[k] || 0) < 60e3) return;
    if (Object.keys(blockT).length > 500) for (const x of Object.keys(blockT)) delete blockT[x];
    blockT[k] = now;
    blocked.unshift({ symbol: sym, base: baseOf(sym), dir, why, t: now });
    if (blocked.length > 30) blocked.length = 30;
}
function puan(strength) {
    return strength >= 75 ? 'ÇOK GÜÇLÜ' : strength >= 55 ? 'GÜÇLÜ' : strength >= 35 ? 'ORTA' : 'ZAYIF';
}
// Üçgen tipine göre beklenen kırılım yönü (+1 yukarı, -1 aşağı)
const TYPE_BIAS = { 'Yükselen': 1, 'Alçalan': -1, 'Yükselen Kama': -1, 'Alçalan Kama': 1, 'Simetrik': 0 };
const typeBias = (type, dir) => (TYPE_BIAS[type] || 0) * (dir === 'LONG' ? 1 : -1) * 8;
function calculateStrength(tri, vol, ext, q, dir, rs) {
    let s = Math.min(25, Math.max(0, (tri.touches - 2) * 8));
    s += Math.round(Math.max(0, 0.85 - tri.squeeze) / 0.85 * 20);
    s += vol >= 2.5 ? 25 : vol >= 1.8 ? 20 : vol >= 1.3 ? 14 : 6;
    s += q >= 0.85 ? 15 : q >= 0.7 ? 10 : 5;
    s += ext <= 0.3 ? 15 : ext <= 0.5 ? 8 : 3;
    s += typeBias(tri.type, dir);
    if (rs != null) { const x = (dir === 'LONG' ? 1 : -1) * rs; s += x > 0.3 ? 5 : x < -0.3 ? -5 : 0; }
    return Math.max(0, Math.min(100, Math.round(s)));
}
function signalMsg(s) {
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName +
        '\nGÜÇ ' + s.strength + ' ' + puan(s.strength) + ' | Hacim ' + s.volX.toFixed(1) + 'x | Piyasa: ' + s.reg +
        '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ')' +
        '\nTP1: ' + fmt(s.tp1) + '\nTP2 (' + s.tp2R.toFixed(1) + 'R): ' + fmt(s.tp2) +
        '\n📈 ' + tvLink(s.base, 15);
}

// ======================= CANLI MOTOR =======================
function buildStruct(S, t0) {
    const o = { t: t0, lines: [] };
    if (S.c2 && S.c2.length >= 50) {
        const tri = detectTriangle(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = pack(tri, S.c2);
            o.tri = pk; o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type;
            o.w0 = tri.w0;
            o.lines.push({ key: 'R', kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type });
            o.lines.push({ key: 'S', kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type });
        }
    }
    return o;
}
// 15m verisi: hacim, son kapanan/önceki kapanan mum, oluşan mumun projeksiyonu, 15m ATR
async function liveVol(sym) {
    const now = Date.now(), hit = volCache.get(sym);
    if (hit && now - hit.t < 15000) return hit.d;
    try {
        const raw = await ex.fetchOHLCV(sym, '15m', undefined, 40);
        const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), n = closed.length;
        const base = closed.slice(-20), pb = closed.slice(-21, -1);
        let avg = 0, avgP = 0;
        for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0;
        for (const x of pb) avgP += x[5]; avgP = pb.length ? avgP / pb.length : 0;
        const bk = closed[n - 1], pv = closed[n - 2];
        let volX = 0, projX = 0, el = 0;
        if (avg > 0) {
            const prev = bk ? bk[5] : 0;
            if (cur) {
                el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15));
                const proj = cur[5] / el; projX = proj / avg;
                const w = Math.min(1, el / 0.6);
                volX = (w * proj + (1 - w) * prev) / avg;
            } else volX = prev / avg;
        }
        const d = { volX, projX, el, bk, pv, avg15: avg, bkVolX: avgP > 0 && bk ? bk[5] / avgP : 0, atr15: n > 15 ? atrMean(closed, 14) : 0 };
        volCache.set(sym, { t: now, d }); return d;
    } catch (e) { const d = { volX: 0, projX: 0, el: 0, bk: null, pv: null, avg15: 0, bkVolX: 0, atr15: 0 }; volCache.set(sym, { t: now, d }); return d; }
}
function lineValues(st, now) {
    const out = {};
    for (const L of st.lines) {
        const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0];
        out[L.key] = dt ? a[1] + (b[1] - a[1]) * (now - a[0]) / dt : a[1];
    }
    return out;
}
// Kırılım değerlendirmesi: 'onaylı' (15m kapanış) veya 'erken' (mum içi güçlü patlama)
function evalBreakout(st, dir, P, now, v) {
    if (!v.bk || !v.pv || !(v.avg15 > 0) || !(v.atr15 > 0)) return null;
    const atr = st.lines[0].atr, L = dir === 'LONG' ? 1 : -1, key = L === 1 ? 'R' : 'S';
    const at = t => lineValues(st, t)[key];
    const ext = L * (P - at(now)) / atr;                        // çizgi ötesi mesafe (1H ATR)
    if (ext < 0.05 || ext > CFG.MAX_CHASE) return null;
    const dBk = L * (v.bk[4] - at(v.bk[0] + M15));
    const dPv = L * (v.pv[4] - at(v.pv[0] + M15));
    const rng = (v.bk[2] - v.bk[3]) || 1e-9;
    const q = L === 1 ? (v.bk[4] - v.bk[3]) / rng : (v.bk[2] - v.bk[4]) / rng;   // kapanış mum ucuna yakın mı
    if (dBk >= CFG.BRK_ATR * atr && dPv <= 0.05 * atr && q >= 0.55 && v.bkVolX >= CFG.BRK_VOL && now - (v.bk[0] + M15) <= CFG.FRESH_MIN * 60e3)
        return { mode: 'onaylı', ext, vol: v.bkVolX, q };
    if (dBk <= 0.05 * atr && ext >= CFG.EARLY_ATR && v.projX >= CFG.EARLY_VOL && v.el >= 0.3)
        return { mode: 'erken', ext, vol: v.projX, q: 0.7 };
    return null;
}
// Stop / hedef planı: stop çizginin geri içi, hedef üçgen yüksekliği (ölçülü hareket)
function planTrade(st, dir, P, vals, v) {
    const L = dir === 'LONG' ? 1 : -1;
    const line = L === 1 ? vals.R : vals.S, opp = L === 1 ? vals.S : vals.R;
    let stop = line - L * CFG.STOP_ATR15 * v.atr15;
    stop = L === 1 ? Math.max(stop, opp) : Math.min(stop, opp);
    const risk = L * (P - stop); if (!(risk > 0)) return null;
    const riskPct = risk / P * 100;
    if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return null;
    const rawR = L * (line + L * st.w0 - P) / risk;
    if (rawR < CFG.MIN_RR) return null;
    return { stop, riskPct, tp2R: Math.min(rawR, CFG.MAX_TP2R), line };
}
function rsOf(sym) {
    const a = regime.chg(sym), b = regime.chg(BTC);
    return a == null || b == null ? null : a - b;
}

async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        try { REG = (await regime.tick(ex, tickers, universe)) || REG; } catch (e) { }

        const rad = [];
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > 4 * H1) continue;
            const P = tk.last;
            const vals = lineValues(st, now);
            if (vals.R == null || vals.S == null || vals.R <= vals.S) continue;
            const atr = st.lines[0].atr;
            if (!(atr > 0)) continue;

            const dR = (P - vals.R) / atr, dS = (P - vals.S) / atr;
            let cand = null;
            if (Math.abs(dR) <= CFG.NEAR_ATR || (dR > 0 && dR <= CFG.BRK_SEE)) cand = { bias: 'LONG', d: dR, v: vals.R, line: 'üst çizgi' };
            if (Math.abs(dS) <= CFG.NEAR_ATR || (dS < 0 && -dS <= CFG.BRK_SEE)) {
                if (!cand || Math.abs(dS) < Math.abs(cand.d)) cand = { bias: 'SHORT', d: dS, v: vals.S, line: 'alt çizgi' };
            }
            if (!cand) continue;

            const L = cand.bias === 'LONG' ? 1 : -1;
            const broke = L * cand.d > 0.05;
            const v = await liveVol(sym), rs = rsOf(sym);
            const pre = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, Math.abs(cand.d), 0.7, cand.bias, rs);
            rad.push({
                symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, rank: Math.abs(cand.d),
                touches: st.touches, type: st.type, volX: r2(v.volX), strength: pre, broke, rs: rs == null ? null : r2(rs),
                aligned: REG && REG.dir !== 'NÖTR' ? REG.dir === cand.bias : null,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)'
            });

            if (!broke) continue;
            const br = evalBreakout(st, cand.bias, P, now, v);
            if (!br) continue;
            const sk = sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            if (canOpen(sym)) continue;
            const plan = planTrade(st, cand.bias, P, vals, v);
            if (!plan) { block(sym, cand.bias, 'risk/RR uygun değil', now); continue; }
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, cand.bias, rs);
            const costPct = costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT;
            const costR = costPct / plan.riskPct;
            if (strength < CFG.MIN_STRENGTH) { block(sym, cand.bias, 'güç ' + strength + ' < ' + CFG.MIN_STRENGTH, now); continue; }
            if (costR > CFG.MAX_COST_R) { block(sym, cand.bias, 'maliyet ' + costR.toFixed(2) + 'R', now); continue; }
            const g = gate(cand.bias, strength, br.vol, REG);
            if (!g.ok) { block(sym, cand.bias, g.why, now); continue; }

            const sig = mkSig({
                sym, dir: cand.bias, type: st.type, mode: br.mode, reg: REG ? REG.dir : '-',
                entry: P, stop: plan.stop, tp2R: plan.tp2R, atr, strength, costPct,
                volX: br.vol, level: plan.line, triPack: st.tri,
                time: now, trackedTo: Math.ceil(now / M1) * M1 - M1,
                reason: st.type + ' üçgen • ' + (L === 1 ? 'yukarı' : 'aşağı') + ' kırılım (' + br.mode + ') • ' + st.touches + ' dokunuş • hacim ' + br.vol.toFixed(1) + 'x • çizgi ötesi ' + br.ext.toFixed(2) + ' ATR' + (REG ? ' • piyasa ' + REG.dir + ' ' + REG.regime : '')
            });
            signals.unshift(sig);
            if (signals.length > CFG.KEEP) signals.length = CFG.KEEP;
            lastSig[sk] = now; dirty = true;
            log('SİNYAL', sig.dir, sig.base, br.mode, 'güç', strength, 'hacim', br.vol.toFixed(1), 'giriş', fmt(P), 'piyasa', sig.reg);
            telegram(signalMsg(sig));
        }
        const newKeys = new Set(rad.map(r => r.symbol));
        for (const old of prevRadarKeys) if (!newKeys.has(old)) {
            const rr = triRadar.find(x => x.symbol === old);
            if (rr && !dropped.some(d => d.symbol === old && now - d.t < 10 * 60e3)) dropped.unshift({ symbol: old, base: baseOf(old), bias: rr.bias, rank: rr.rank, t: now });
        }
        if (dropped.length > 30) dropped.length = 30;
        prevRadarKeys.clear(); for (const k of newKeys) prevRadarKeys.add(k);
        triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 40);

        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function pruneLive() {
    for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
    for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
}

// ======================= POZİSYON =======================
function curR(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t) { s.status = status; s.grossR = r2(gross); s.netR = r2(gross - s.costR); s.closedAt = t; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', side = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop);
    const end = k[0] + dur, el = k[0] - s.time;
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    s.lastPrice = k[4];
    s.mfe = Math.max(s.mfe || 0, (side * (k[L ? 2 : 3] - s.entry)) / risk);
    s.mae = Math.min(s.mae || 0, (side * (k[L ? 3 : 2] - s.entry)) / risk);
    if (s.status === 'OPEN') {
        if (hitStop) { closeSig(s, 'STOP', -1, end); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = k[0]; return false; }
        if (el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', curR(s, k[4]), end); return true; }
    } else if (s.status === 'TP1' && k[0] > s.tp1At) {
        const hh = L ? k[2] : k[3];
        const ts = s.entry + side * Math.max(0, (side * (hh - s.entry)) / risk - CFG.TRAIL_R) * risk;
        if (L ? ts > s.stop : ts < s.stop) s.stop = ts;
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * s.tp1R + 0.5 * curR(s, s.stop), end); return true; }
        if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * s.tp1R + 0.5 * s.tp2R, end); return true; }
    }
    if (el >= s.maxHold && isOpen(s)) { const r = curR(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r, end); return true; }
    return false;
}
async function track() {
    const open = signals.filter(isOpen); if (!open.length) return;
    try {
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym];
                const since = Math.min(...list.map(x => x.trackedTo));
                const raw = await ex.fetchOHLCV(sym, '1m', since, 500), c = closedOnly(raw, M1);
                for (const s of list) {
                    if (!isOpen(s)) continue;
                    for (const k of c) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; dirty = true;
                        const before = s.status;
                        if (advance(s, k, M1) && !isOpen(s)) { telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                        if (before === 'OPEN' && s.status === 'TP1') telegram('💰 ' + s.base + ' TP1 — stop girişe');
                    }
                }
            } catch (e) { }
        }
    } catch (e) { }
}

// ======================= İSTATİSTİK =======================
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0, t: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0;
    for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR; }
    const avg = tot / n; let t = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)), se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; }
    return { n, win: w / n, avgR: avg, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const strBucket = s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : (s.strength || 0) >= 35 ? 'Güç 35-54' : 'Güç <35';

// ======================= TARAMA =======================
async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now();
    try {
        const S = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const c = await fetchTriCandles(sym);
                    if (c.length < 60 || hasGap(c, TRI_MS, CFG.TRI_LOOK) || (!isMajor(sym) && flatRatio(c) >= CFG.FLAT_MAX)) { S[sym] = false; continue; }
                    S[sym] = { c2: c };
                } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        for (const sym of universe) {
            const s = S[sym];
            if (s === false) { delete struct[sym]; continue; }
            if (!s) continue;                       // getirme hatası: eski yapı kalsın
            const c = s.c2, i = c.length - 1;
            if (t0 - (c[i][0] + TRI_MS) > 3 * TRI_MS) { delete struct[sym]; continue; }
            try {
                const stc = buildStruct(s, t0);
                if (stc && stc.lines && stc.lines.length) struct[sym] = stc;
                else if (!(struct[sym] && t0 - struct[sym].t < CFG.GRACE_MIN * 60e3)) delete struct[sym];   // kırılım mumu için çizgiler kısa süre tutulur
            } catch (e) { }
        }
        pruneLive();
        scan.last = Date.now(); scan.ms = scan.last - t0;
        log('tarama:', Object.keys(struct).length, 'üçgen (' + TRI_TF + ')');
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= API =======================
function pnlR(s) { return s && s.lastPrice ? (s.dir === 'LONG' ? 1 : -1) * (s.lastPrice - s.entry) / Math.abs(s.entry - s.initialStop) : null; }
function apiState() {
    const now = Date.now();
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(now))),
        byStrength: groupBy(closed, strBucket), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status),
        byMode: groupBy(closed, s => s.mode || '-'), byReg: groupBy(closed, s => 'Piyasa ' + (s.reg || '-')) };
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const open = signals.filter(isOpen);
    const openPnl = open.reduce((t, s) => t + (pnlR(s) || 0), 0);
    const px = {};
    for (const x of signals.slice(0, 80).concat(triRadar)) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now, mode: 'v24 • Üçgen ' + TRI_TF.toUpperCase() + ' + 15m onay', px, market, regime: REG,
        signals: signals.slice(0, 80), radar: triRadar, dropped: dropped.slice(0, 15), blocked: blocked.slice(0, 10),
        stats: st, equity: eq, openPnl: r2(openPnl),
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.COOLDOWN_MIN, minStrength: CFG.MIN_STRENGTH },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible }
    };
}
async function apiCandles(sym) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const key = sym + '|' + TRI_TF, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let c, dur, tf;
    if (TRI_TF === '2h') {
        const c1h = await ex.fetchOHLCV(sym, '1h', undefined, 500);
        c = aggregateN(c1h, H1, 2); dur = H2; tf = '2H';
    } else if (TRI_TF === '1h') {
        c = await ex.fetchOHLCV(sym, '1h', undefined, 400); dur = H1; tf = '1H';
    } else {
        c = await ex.fetchOHLCV(sym, '15m', undefined, 500); dur = M15; tf = '15m';
    }
    const cl = clOf(c);
    const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), vs = volSma(c, 20);
    let tri = null;
    if (c.length > 50) { const t = detectTriangle(c, c.length - 1, CFG) || detectTriangle(c, c.length - 2, CFG); if (t) tri = pack(t, c); }
    const cut = Math.max(0, c.length - 120);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur, tri };
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:420px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:11px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.card.L{border-left:3px solid var(--lg)}.card.S{border-left:3px solid var(--st)}
.r1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}.sc{margin-left:auto;font-weight:800;font-size:15px}
.kar{color:var(--lg)}.zarar{color:var(--st)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:420px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:280px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v24</small></div>
  <div class="chip" id="cReg"></div><div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div><span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<div id="toast"></div>
<script>
var TABS=[['sig','Sinyaller'],['rad','Radar'],['stat','İstatistik']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='sig',sel=null,chartCache={},chartFor='',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),actx=null,lastSigT=0,toastT=null;
function $(id){return document.getElementById(id)}
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function openS(s){return s.status==='OPEN'||s.status==='TP1'}
function pnlR(s){return s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null}
var ST={OPEN:['AÇIK','w'],TP1:['TP1 ✓','g'],TP2:['TP2 ✓','g'],STOP:['STOP','r'],BE:['BE','w'],TRAIL:['TRAIL','g'],TIMEOUT:['SÜRE','w']};
function strTag(s){var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};return '<span class="tag '+x.c+'">GÜÇ '+s+' '+x.l+'</span>'}
function volTag(v){var c=v>=1.5?'g':v>=1.0?'w':'r';return '<span class="tag '+c+'">Hacim '+f2(v,1)+'x</span>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(s){var t=$('toast');t.textContent='🔔 '+s.dir+' '+s.base+' — GÜÇ '+s.strength;t.style.display='block';
 t.onclick=function(){t.style.display='none';tab='sig';sel={id:s.id,sym:s.symbol};renderAll()};
 clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},30000)}
function checkNew(){var sg2=S.signals||[],mx=sg2.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=sg2.filter(function(x){return x.time>lastSigT&&openS(x)});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);showToast(nw[0])}}

function renderTop(){var m=S.market,R=S.regime;
 if(!R)$('cReg').innerHTML='<b>Yön</b> <span class="fl">hesaplanıyor…</span>';
 else{var c=R.dir==='LONG'?'up':R.dir==='SHORT'?'dn':'fl';
  $('cReg').innerHTML='<b>Yön</b> <span class="'+c+'" style="font-weight:800">'+R.dir+'</span> <span class="'+c+'">'+sg(R.score,0)+'</span> <span class="fl">| '+R.regime+(R.breadth?' | ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'</span>'}
 $('cMkt').innerHTML='<b>Piyasa</b> <span class="fl">'+S.scan.universe+' coin</span>';
 $('cBTC').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(S.stats.today.totalR)+'">'+sg(S.stats.today.totalR,1)+'R</span> <span class="fl">| açık '+sg(S.openPnl,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var oc=S.signals.filter(openS).length,nr=(S.radar||[]).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t[0]==='sig'?' ('+oc+')':t[0]==='rad'?' ('+nr+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat')sel=null;renderAll()}})}

function sigCard(s){var st=ST[s.status]||['?',''],R=pnlR(s),op=openS(s),px=s.lastPrice||s.entry,pc=(s.dir==='LONG'?1:-1)*(px/s.entry-1)*100;var pn='';
 if(op&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R <span class="fl" style="font-size:10px">'+sg(pc)+'%</span></span>';
 else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card '+(s.dir==='LONG'?'L':'S')+(sel&&sel.id===s.id?' sel':'')+(op?'':' closed')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+strTag(s.strength||0)+volTag(s.volX||0)+pn+'</div><div class="sub">'+(op?'<span>Şimdi <b>'+fp(px)+'</b></span>':'')+'<span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop '+fp(s.stop)+'</span><span>TP2 '+fp(s.tp2)+'</span><span>'+esc(s.mode||'')+'</span><span>'+ago(s.time)+' önce</span></div></div>'}
function radCard(r){var s=r.strength||0;var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};
 var al=r.aligned===true?'<span class="tag g">yön uyumlu</span>':r.aligned===false?'<span class="tag r">yön ters</span>':'';
 var rs=r.rs!=null?'<span class="tag '+(r.rs>0?'g':'r')+'">RS '+sg(r.rs)+'%</span>':'';
 return '<div class="card '+(r.bias==='LONG'?'L':'S')+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag '+(r.broke?'w':'')+'">'+(r.broke?'KIRILDI':'hazır')+'</span><span class="tag '+x.c+'">GÜÇ '+s+' '+x.l+'</span>'+al+rs+'</div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}

function renderList(){var h='';
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return !openS(s)}).slice(0,25);
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Açık sinyal yok.</div>';
  if(c.length)h+='<h3>Kapanan</h3>'+c.map(sigCard).join('')}
 else if(tab==='rad'){
  h='<div class="note" style="padding:6px 8px">Üçgen çizgisine yaklaşan / yeni kırılan coinler. Sinyal, 15m kapanış onayı (veya güçlü erken patlama) + hacim + yön filtresi geçince gelir.</div>';
  h+=(S.radar||[]).length?S.radar.map(radCard).join(''):'<div class="note" style="padding:10px">Yaklaşan yok.</div>'}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 $('list').innerHTML=h;
 Array.prototype.forEach.call($('list').querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.dataset.id,sy=e.dataset.sym;
  if(id){var s=S.signals.find(function(x){return x.id===id});sel={id:id,sym:s.symbol}}else{sel={sym:sy}}chartFor='';renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

function sigView(s){var st=ST[s.status]||['?',''],R=pnlR(s),op=openS(s),px=s.lastPrice||s.entry,pc=(s.dir==='LONG'?1:-1)*(px/s.entry-1)*100;
 var big=op&&R!=null?'<span class="'+cl(R)+'">'+sg(R)+'R ('+sg(pc)+'%)</span>':(s.netR!=null?'<span class="'+cl(s.netR)+'">'+sg(s.netR)+'R</span>':'');
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.base)+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span>'+strTag(s.strength||0)+volTag(s.volX||0)+'<span class="sc '+cl(R)+'" style="font-size:22px">'+big+'</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(s.setupName)+' • piyasa '+esc(s.reg||'-')+' • '+ago(s.time)+' önce</div><canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Anlık</span><b>'+fp(px)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="zarar">'+fp(s.stop)+'</b></div><div><span>TP1 (1R)</span><b class="kar">'+fp(s.tp1)+'</b></div><div><span>TP2 ('+f2(s.tp2R,1)+'R)</span><b class="kar">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(s.costR)+'R</b></div><div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+' / '+f2(s.mae,1)+'R</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="https://www.tradingview.com/chart/?symbol=BITGET:'+s.base+'USDT.P&interval=15" target="_blank">📈 TradingView</a></div>'+calcBox(s.entry,s.initialStop)+'<div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div>'}

function homeView(){var open=S.signals.filter(openS),td=S.stats.today,a=S.stats.all,R=S.regime;
 var bl=(S.blocked||[]).slice(0,6).map(function(b){return '<div class="note" style="margin-top:2px">'+esc(b.base)+' '+b.dir+' — '+esc(b.why)+' ('+ago(b.t)+')</div>'}).join('');
 var rg=R?'<div class="note" style="color:var(--tx);font-size:12px"><b>Piyasa yönü:</b> '+R.dir+' (skor '+sg(R.score,0)+', rejim '+R.regime+', verimlilik '+f2(R.er)+', volatilite '+f2(R.vr,1)+'x)'+(R.breadth?' • genişlik ↑'+R.breadth.up+' ↓'+R.breadth.dn+' medyan '+sg(R.breadth.median)+'%':' • genişlik ısınıyor (ilk ~10 dk)')+'</div>':'<div class="note">Yön motoru ısınıyor veya regime.js yok.</div>';
 return '<h2>Pano</h2><div class="tiles">'+
 '<div class="tile"><div class="k">Açık</div><div class="v">'+open.length+'</div><div class="k">'+sg(S.openPnl,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Bugün</div><div class="v '+cl(td.totalR)+'">'+sg(td.totalR,1)+'R</div><div class="k">'+td.n+' kapanan</div></div>'+
 '<div class="tile"><div class="k">Toplam</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'R</div><div class="k">'+a.n+' işlem PF '+f2(a.pf)+'</div></div>'+
 '<div class="tile"><div class="k">Radar</div><div class="v">'+(S.radar||[]).length+'</div><div class="k">yaklaşan / kıran</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Üçgen ' + S.config.tf.toUpperCase() + ' + 15m kırılım onayı</h3>'+rg+
 '<div class="note" style="color:var(--tx);font-size:12px"><b>Giriş:</b> 15m kapanış çizgiyi aşar + hacim artar (onaylı) ya da mum içi güçlü patlama (erken). Stop çizginin geri içi, hedef üçgen yüksekliği. Min güç '+S.config.minStrength+'.</div>'+
 '<div class="note">'+S.scan.universe+' coin taranıyor</div></div>'+
 '<div class="box"><h3 style="margin-top:0">Son engellenen sinyaller</h3>'+(bl||'<div class="note">Henüz yok.</div>')+'</div>'}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td></tr>'}).join('')+'</table>'};
function statView(){return '<h2>İstatistik</h2>'+tbl({'Tümü':S.stats.all,'Bugün':S.stats.today},'Genel')+tbl(S.stats.byMode||{},'Giriş modu')+tbl(S.stats.byReg||{},'Piyasa yönü (sinyal anı)')+tbl(S.stats.byStrength||{},'Güç')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byExit,'Çıkış')}

function ckey(sym){return sym+'|'+S.config.tf}
function curSig(){return sel&&sel.id?S.signals.find(function(x){return x.id===sel.id}):null}
function drawChart(d,s){
 var c=$('cv');if(!c||!d||!d.c.length)return;
 var W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 var x=c.getContext('2d');x.scale(dp,dp);
 var tri=(s&&s.tri)||d.tri,nc=d.c.length,n=nc+(tri?15:0);
 var L=8,R=86,T=12,B=20,PW=W-L-R,PH=H-T-B;
 var volH=70, priceH=PH-volH;
 var ti=function(t){return (t-d.c[0][0])/d.dur};
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 var lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.stop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']]:[];
 var lp0=(sel&&sel.sym&&S.px&&S.px[sel.sym])||(s&&s.lastPrice)||d.c[nc-1][4];
 hi=Math.max(hi,lp0);lo=Math.min(lo,lp0);lv.forEach(function(a){hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});
 var tl=[];
 if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*priceH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';
 for(var i=0;i<=4;i++){var gy=T+priceH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 var line=function(arr,col,w){x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#4a5568',0.8);line(d.e21,'#6b7280',1.0);
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1;
 var vTop=priceH+40,vHeight=volH-20;
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';var h=(k[5]/vmax)*vHeight;x.fillStyle=col;x.globalAlpha=0.7;x.fillRect(X(i)-cw/2,vTop+vHeight-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#f2b84b';x.lineWidth=1.2;x.beginPath();var st=false;d.vsma.forEach(function(v,k){if(v==null||vmax<=0)return;var y=vTop+vHeight-(v/vmax)*vHeight;st?x.lineTo(X(k),y):(x.moveTo(X(k),y),st=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(function(l){x.strokeStyle='#ffd400';x.lineWidth=2.4;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='#ffd400';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),3,0,7);x.fill()});
  x.restore()}
 lv.forEach(function(a){x.strokeStyle=x.fillStyle=a[1];x.lineWidth=a[2]==='GİRİŞ'?2:1.3;x.setLineDash(a[2]==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.font='bold 10px system-ui';x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 x.strokeStyle='#fff';x.lineWidth=1.5;x.beginPath();x.moveTo(L,Y(lp0));x.lineTo(W-R,Y(lp0));x.stroke();x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp0)-9,66,18);x.fillStyle='#0c1117';x.font='bold 11px system-ui';x.fillText(fp(lp0),W-R+2,Y(lp0)+4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText(d.tf+' • sarı EMA21 • gri EMA50'+(tri?' • '+tri.type+' ('+tri.touches+' dokunuş)':''),L+4,H-5)}
function loadChart(sym){fetch(api('/api/candles?symbol='+encodeURIComponent(sym))).then(function(r){return r.json()}).then(function(d){chartCache[sym+'|'+S.config.tf]=d;if(sel&&sel.sym===sym&&$('cv'))drawChart(d,curSig())}).catch(function(){})}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.innerHTML=statView();return}
 if(sel&&sel.id){var s=S.signals.find(function(x){return x.id===sel.id});if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[ckey(s.symbol)])drawChart(chartCache[ckey(s.symbol)],s);if(chartFor!==ckey(s.symbol)){chartFor=ckey(s.symbol);loadChart(s.symbol)}return}}
 if(sel&&sel.sym){var r=(S.radar||[]).find(function(x){return x.symbol===sel.sym});
  M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2>'+(r?'<span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span>'+strTag(r.strength||0):'')+'<a class="btn tv" style="margin-left:auto" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval=15" target="_blank">📈 TradingView</a></div><canvas id="cv"></canvas>'+calcBox('','');bindCalc();
  if(chartCache[ckey(sel.sym)])drawChart(chartCache[ckey(sel.sym)],null);
  if(chartFor!==ckey(sel.sym)){chartFor=ckey(sel.sym);loadChart(sel.sym)}return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){S=d;checkNew();$('dot').className='dot on';$('conn').textContent='Bağlı';renderAll()}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)renderMain()});
setInterval(poll,3000);setInterval(function(){if(sel&&sel.sym)loadChart(sel.sym)},15000);poll();
</script></body></html>`;

// ======================= HTTP =======================
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const authed = u => !!ADMIN_KEY && safeEq(u.searchParams.get('key') || '', ADMIN_KEY);
const uiOk = u => !UI_KEY || safeEq(u.searchParams.get('key') || '', UI_KEY);
const hits = new Map();
function rateOk(ip, max) {
    const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60e3);
    if (a.length >= max) { hits.set(ip, a); return false; }
    a.push(now); hits.set(ip, a); if (hits.size > 2000) hits.clear(); return true;
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v24', tf: TRI_TF, triangles: Object.keys(struct).length, radar: triRadar.length, signals: signals.length, universe: universe.length });
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; dirty = true; saveState();
            return json(res, 200, { ok: true });
        }
        if (['/', '/index.html', '/api/state', '/api/candles'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') {
            if (!rateOk(ip, 40)) return json(res, 429, { error: 'çok fazla istek' });
            return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

// ======================= START =======================
async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(track, 15e3);
        setInterval(liveTick, 8000);
        setInterval(saveState, 15e3);

        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);

        log('SONER TRADE v24 • Üçgen ' + TRI_TF.toUpperCase() + ' + 15m onay • evren ' + universe.length + ' coin • min güç ' + CFG.MIN_STRENGTH);
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, evalBreakout, planTrade, CFG };
