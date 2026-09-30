'use strict';
// ============================================================
// SONER TRADE v18.1 — Üçgen (LV) + Momentum Scalp (SC) + Sweep Reversal (SW)
//   LV: 2H üçgen, canlı (tick) kırılım -> sinyal (15m teyitli, klasik yön dışı kapalı)
//   SC: 5m Donchian(20) kırılımı + hacim + 15m/1H trend uyumu -> sinyal
//   SW: 5m aralık ucu süpürmesi + hacimle geri dönüş -> sinyal (yatay piyasada da çalışır)
//   Backtest: 5m veriyle her üç sistemi de aynı kodla simüle eder
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const flag = (k, d) => process.env[k] == null || process.env[k] === '' ? d : process.env[k] !== '0';
const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const M1 = 60e3, M5 = 5 * 60e3, M15 = 15 * 60e3, H1 = 3600e3, D1 = 24 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';

const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','DXY','VIX','NASDAQ','SPX','NIKKEI','DAX','OPENAI','ANTHROPIC','SPACEX','XAI','SAMSUNG','HYNIX','SKHY','SKHYNIX'];

// ======================= ÜÇGEN MODÜLÜ =======================
const TRI = (() => {
    const AGG = Math.max(1, Math.round(Number(process.env.TRI_AGG) || 2));
    const DUR = AGG * H1;
    function cfg(num) {
        return {
            TRI_K: num('TRI_K', 3), TRI_LOOK: num('TRI_LOOK', 120),
            TRI_MIN_LEN: num('TRI_MIN_LEN', 18), TRI_MAX_LEN: num('TRI_MAX_LEN', 110),
            TRI_TOL_ATR: num('TRI_TOL_ATR', 0.35), TRI_WICK_ATR: num('TRI_WICK_ATR', 0.6), TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.15),
            TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 4), TRI_SQUEEZE: num('TRI_SQUEEZE', 0.7), TRI_FLAT: num('TRI_FLAT', 0.08)
        };
    }
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0);
    const lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);
    function atrAt(c, j, p = 14) {
        if (j < p) return 0;
        let s = 0;
        for (let i = j - p + 1; i <= j; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
        return s / p;
    }
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
    function fit(pts, c, end, atr, side, C) {
        const P = pts.slice(-8); let best = null;
        for (let a = 0; a < P.length - 1; a++) {
            for (let b = a + 1; b < P.length; b++) {
                const A = P[a], B = P[b];
                if (B.i - A.i < 4) continue;
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
                if (end - lastI > 45) continue;
                const score = pts2.length * 1000 + (lastI - A.i) * 2 + lastI * 0.01;
                if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches: pts2.length, last: lastI, score, pts: pts2 };
            }
        }
        return best;
    }
    function detect(c, end, C) {
        if (end < 50) return null;
        const atr = atrAt(c, end);
        if (!(atr > 0)) return null;
        const pv = pivots(c, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
        if (pv.hi.length < 2 || pv.lo.length < 2) return null;
        const R = fit(pv.hi, c, end, atr, 1, C), S = fit(pv.lo, c, end, atr, -1, C);
        if (!R || !S) return null;
        if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null;
        const xs = Math.max(R.i0, S.i0), len = end - xs;
        if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null;
        const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0);
        const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
        if (!(w0 > 0 && wN > 0)) return null;
        if (wN / w0 > C.TRI_SQUEEZE || wN < 0.5 * atr) return null;
        const dsl = S.s - R.s;
        if (!(dsl > 0)) return null;
        const apex = end + wN / dsl;
        if (apex - end > 80) return null;
        const flatTol = C.TRI_FLAT * w0 / len, rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol;
        let type = 'Sıkışma';
        if (R.s < -flatTol && S.s > flatTol) type = 'Simetrik üçgen';
        else if (rf && S.s > flatTol) type = 'Yükselen üçgen';
        else if (sf && R.s < -flatTol) type = 'Alçalan üçgen';
        else if (R.s > flatTol && S.s > flatTol) type = 'Yükselen kama';
        else if (R.s < -flatTol && S.s < -flatTol) type = 'Alçalan kama';
        return { type, end, atr, w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: wN / w0 };
    }
    function pack(tri, c) {
        const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * DUR;
        const xEnd = Math.min(tri.apex, tri.end + 1 + 10);
        const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
        return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), apex: tOf(tri.apex),
            res: seg(tri.R, lineR), sup: seg(tri.S, lineS),
            hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
    }
    return { cfg, detect, pack, AGG, DUR, lineR, lineS };
})();

const CLASSIC = { 'Yükselen üçgen': 'LONG', 'Alçalan üçgen': 'SHORT', 'Yükselen kama': 'SHORT', 'Alçalan kama': 'LONG' };

// ======================= AYARLAR =======================
const CFG = {
    MKT_MODE: process.env.MKT_MODE || 'block',
    UNIVERSE: num('UNIVERSE', 250),
    MIN_VOL_USDT: num('MIN_VOL', 2e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, UNIVERSE_MS: 5 * 60e3, KEEP: 500,
    SCAN_DELAY_MS: 8000,
    ...TRI.cfg(num),
    // ---- Üçgen (LV) ----
    ENABLE_LIVE: flag('ENABLE_LIVE', true),
    LIVE_MS: num('LIVE_MS', 10000),
    ENABLE_TR: flag('ENABLE_TR', true),
    LV_BRK_ATR: num('LV_BRK_ATR', 0.12),
    LV_HOLD_TICKS: num('LV_HOLD_TICKS', 3),
    LV_NEAR_ATR: num('LV_NEAR_ATR', 0.45),
    LV_VOL_SIG: num('LV_VOL_SIG', 1.3),
    LV_COUNTER_VOL: num('LV_COUNTER_VOL', 99),      // klasik yön dışı kırılım (varsayılan: kapalı)
    LV_CONFIRM15: flag('LV_CONFIRM15', true),       // 15m kapanış çizginin ötesinde olmadan sinyal yok
    LV_REQ_H1: flag('LV_REQ_H1', true),
    LV_STOP_ATR: num('LV_STOP_ATR', 0.5),
    LV_MIN_RISK_PCT: num('LV_MIN_RISK_PCT', 0.5),
    LV_MAX_RISK_PCT: num('LV_MAX_RISK_PCT', 6),
    LV_MAX_COST_R: num('LV_MAX_COST_R', 0.30),
    LV_CD_BRK_MIN: num('LV_CD_BRK_MIN', 90),
    LV_MAX_EXT_ATR: num('LV_MAX_EXT_ATR', 1.0),
    LV_HOLD_MS: num('LV_HOLD_H', 24) * H1,
    LV_TG_MAX_H: num('LV_TG_MAX_H', 30),
    LV_MAX_VOLFETCH: num('LV_MAX_VOLFETCH', 20),
    LV_STALE_MS: 45 * 60e3,
    // ---- Scalp (SC) ----
    ENABLE_SC: flag('ENABLE_SC', true),
    SC_UNIVERSE: num('SC_UNIVERSE', 80),
    SC_LOOK: num('SC_LOOK', 20),
    SC_MIN_VOLX: num('SC_MIN_VOLX', 1.5),
    SC_BODY_MIN: num('SC_BODY_MIN', 0.6),
    SC_CLOSEPOS: num('SC_CLOSEPOS', 0.75),
    SC_MAX_RANGE_ATR: num('SC_MAX_RANGE_ATR', 2.5),
    SC_MAX_EXT_ATR: num('SC_MAX_EXT_ATR', 1.0),
    SC_RSI_HI: num('SC_RSI_HI', 80),
    SC_STOP_ATR: num('SC_STOP_ATR', 1.0),
    SC_STOP_PAD: num('SC_STOP_PAD', 0.1),
    SC_MAX_STOP_ATR: num('SC_MAX_STOP_ATR', 2.2),
    SC_MIN_RISK_PCT: num('SC_MIN_RISK_PCT', 0.3),
    SC_MAX_RISK_PCT: num('SC_MAX_RISK_PCT', 2),
    SC_MAX_COST_R: num('SC_MAX_COST_R', 0.30),
    SC_TP2_R: num('SC_TP2_R', 2),
    SC_TS_MIN: num('SC_TS_MIN', 45),
    SC_HOLD_MS: num('SC_HOLD_H', 3) * H1,
    SC_CD_MIN: num('SC_CD_MIN', 30),
    SC_LATE_ATR: num('SC_LATE_ATR', 0.3),
    SC_NEAR_ATR: num('SC_NEAR_ATR', 0.6),
    SC_MAX_AGE_MS: 120e3,
    SC_DELAY_MS: 6000,
    // ---- Sweep Reversal (SW) ----
    ENABLE_SW: flag('ENABLE_SW', true),
    SW_LOOK: num('SW_LOOK', 30),
    SW_MIN_VOLX: num('SW_MIN_VOLX', 1.3),
    SW_WICK_MIN: num('SW_WICK_MIN', 0.5),
    SW_PIERCE_ATR: num('SW_PIERCE_ATR', 0.1),
    SW_MIN_RANGE_ATR: num('SW_MIN_RANGE_ATR', 0.8),
    SW_MAX_RANGE_ATR: num('SW_MAX_RANGE_ATR', 3),
    SW_STOP_PAD: num('SW_STOP_PAD', 0.15),
    SW_MIN_STOP_ATR: num('SW_MIN_STOP_ATR', 0.6),
    SW_MAX_STOP_ATR: num('SW_MAX_STOP_ATR', 2.0),
    SW_MIN_RISK_PCT: num('SW_MIN_RISK_PCT', 0.25),
    SW_MAX_RISK_PCT: num('SW_MAX_RISK_PCT', 1.5),
    SW_MAX_COST_R: num('SW_MAX_COST_R', 0.30),
    SW_MIN_ROOM_R: num('SW_MIN_ROOM_R', 1.2),
    SW_TP2_MIN: num('SW_TP2_MIN', 1.5),
    SW_TP2_MAX: num('SW_TP2_MAX', 3),
    SW_TS_MIN: num('SW_TS_MIN', 30),
    SW_HOLD_MS: num('SW_HOLD_H', 2) * H1,
    SW_NEAR_ATR: num('SW_NEAR_ATR', 0.4),
    MAX_OPEN_SW: num('MAX_OPEN_SW', 4),
    // ---- Ortak ----
    MAX_OPEN_PER_DIR: num('MAX_OPEN_PER_DIR', 4),
    MAX_OPEN_TOTAL: num('MAX_OPEN_TOTAL', 8),
    MAX_OPEN_LV: num('MAX_OPEN_LV', 4),
    MAX_OPEN_SC: num('MAX_OPEN_SC', 4),
    DAY_STOP_R: num('DAY_STOP_R', -3),
    TP1_R: num('TP1_R', 1.0),
    TRAIL_R: num('TRAIL_R', 1.0),
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const flatRatio = c => { const a = c.slice(-96); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const mktOf = (bd, ed, bsc) => { const s = 2 * (bd || 0) + (ed || 0) + (bsc || 0); return s >= 2 ? 1 : s <= -2 ? -1 : 0; };
const breadthScore = (up, dn, n) => n > 0 ? ((up - dn) / n) * 4 : 0;
const mktOk = (m, side) => CFG.MKT_MODE === 'align' ? m === side : CFG.MKT_MODE === 'off' ? true : m !== -side;
const last = a => a[a.length - 1];
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const r2 = x => Number(x.toFixed(3));

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
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
function atrSeries(c, p = 14) {
    const o = new Array(c.length).fill(null); if (c.length <= p) return o;
    let a = 0; for (let i = 1; i <= p; i++) a += trAt(c, i); a /= p; o[p] = a;
    for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + trAt(c, i)) / p; o[i] = a; }
    return o;
}
function rsiSeries(cl, p = 14) {
    const o = new Array(cl.length).fill(null); if (cl.length <= p) return o;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1];
        g = (g * (p - 1) + Math.max(d, 0)) / p;
        l = (l * (p - 1) + Math.max(-d, 0)) / p;
        o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return o;
}
function volSma(c, p = 20) {
    const o = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; }
    return o;
}
function trendSeries(cl, minSpread) {
    const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50);
    const o = new Array(cl.length).fill(0);
    for (let i = 0; i < o.length; i++) {
        const a = e21[i], b = e50[i]; if (a == null || b == null) continue;
        const sp = (a - b) / cl[i] * 100;
        o[i] = sp >= minSpread && cl[i] > b ? 1 : sp <= -minSpread && cl[i] < b ? -1 : 0;
    }
    return o;
}
function ptrMap(c, cH, dur, base) {
    const o = new Array(c.length); let p = -1;
    for (let i = 0; i < c.length; i++) { const t = c[i][0] + base; while (p + 1 < cH.length && cH[p + 1][0] + dur <= t) p++; o[i] = p; }
    return o;
}
const clOf = a => a.map(x => x[4]);
function fSeries(c) {
    const cl = clOf(c);
    return { c, atr: atrSeries(c), e21: emaSeries(cl, 21), e50: emaSeries(cl, 50), rsi: rsiSeries(cl), vsma: volSma(c, 20) };
}

// ======================= GÜÇ PUANI =======================
function strengthScore(o) {
    let s = 0;
    s += Math.min(40, Math.max(0, ((o.touches || 0) - 3) * 10));
    const tight = Math.max(0, 0.7 - (o.squeeze || 0.7)) / 0.7;
    s += Math.round(tight * 20);
    const v = o.volX || 0;
    s += v >= 3 ? 30 : v >= 2 ? 22 : v >= 1.5 ? 14 : v >= 1.3 ? 8 : v >= 1.0 ? 3 : 0;
    const d = o.distAtr != null ? o.distAtr : 0.5;
    s += d <= 0.1 ? 10 : d <= 0.2 ? 6 : d <= 0.3 ? 3 : 0;
    return Math.min(100, s);
}
function scStrength(o) {
    let s = 0; const v = o.volX;
    s += v >= 3 ? 30 : v >= 2.5 ? 24 : v >= 2 ? 18 : v >= 1.5 ? 12 : 5;
    s += o.body >= 0.8 ? 20 : o.body >= 0.7 ? 15 : 10;
    s += o.ext <= 0.3 ? 20 : o.ext <= 0.6 ? 14 : o.ext <= 1 ? 8 : 2;
    s += o.aligned ? 15 : 8;
    s += o.coil <= 4 ? 15 : o.coil <= 6 ? 10 : o.coil <= 9 ? 5 : 0;
    return Math.min(100, s);
}
function swStrength(o) {
    let s = 0; const v = o.volX;
    s += v >= 3 ? 30 : v >= 2 ? 22 : v >= 1.6 ? 15 : 8;
    s += o.wick >= 0.7 ? 25 : o.wick >= 0.6 ? 18 : 10;
    s += o.pierce >= 0.5 ? 15 : o.pierce >= 0.25 ? 10 : 5;
    s += (o.h15 === o.side ? 15 : 8) + (o.h1 === o.side ? 15 : 8);
    return Math.min(100, s);
}
const strengthLabel = s => s >= 75 ? 'ÇOK GÜÇLÜ' : s >= 55 ? 'GÜÇLÜ' : s >= 35 ? 'ORTA' : 'ZAYIF';

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, mood: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, reasons: {}, total: 0, eligible: 0, suspect: 0 }, dirty = false, lastScanSlot = 0;
let mktDir = 0, mktUpdatedAt = 0, nonCrypto = new Set(), nonCryptoAt = 0;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), mtf = new Map();
let triRadar = [], scRadar = [], movers = { up: [], down: [] }, liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
let scState = { last: 0, ms: 0, n: 0, running: false, found: 0, diag: {} };
const struct = {}, pend = {}, hist = {}, volCache = new Map(), symCache = {}, scCache = {}, rejMem = {};
let dropped = [];
const prevRadarKeys = new Set();

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
        const cut = Date.now() - 12 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals: signals.slice(0, CFG.KEEP), lastSig }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) }); } catch (e) { }
}
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;
const tgCap = () => { const now = Date.now(); tgTimes = tgTimes.filter(x => now - x < H1); return tgTimes.length < CFG.LV_TG_MAX_H; };

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
        if (Date.now() - nonCryptoAt > 6 * H1) { nonCrypto = new Set(); nonCryptoAt = Date.now(); }
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        let suspect = 0;
        const ok = all.filter(t => {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) || nonCrypto.has(t.symbol)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) { suspect++; return false; }
            return true;
        });
        scan.suspect = suspect;
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length;
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t.last, chg: t.percentage }); } }
    } catch (e) { log('evren hatası', e.message); }
}
const fetchTF = async (sym, tf, limit, ms) => closedOnly(await ex.fetchOHLCV(sym, tf, undefined, limit), ms);
async function getMulti(sym) {
    const now = Date.now(), rec = mtf.get(sym) || {};
    const lastH1 = Math.floor(now / H1) * H1 - H1, lastH4 = Math.floor(now / (4 * H1)) * (4 * H1) - 4 * H1;
    const need1h = !rec.c1h || last(rec.c1h)[0] < lastH1, need4h = !rec.c4h || last(rec.c4h)[0] < lastH4;
    const get = () => Promise.all([fetchTF(sym, '15m', 300, M15), need1h ? fetchTF(sym, '1h', 400, H1) : null, need4h ? fetchTF(sym, '4h', 150, 4 * H1) : null]);
    let d; try { d = await get(); } catch (e) { await sleep(400); d = await get(); }
    rec.c15 = d[0]; if (d[1]) rec.c1h = d[1]; if (d[2]) rec.c4h = d[2];
    mtf.set(sym, rec); return rec;
}

// ======================= PİYASA YÖNÜ (60 sn) =======================
async function refreshMktDir() {
    if (Date.now() - mktUpdatedAt < 60e3) return;
    mktUpdatedAt = Date.now();
    try {
        const [b, e] = await Promise.all([
            fetchTF(BTC, '15m', 120, M15).catch(() => null),
            fetchTF(ETH, '15m', 120, M15).catch(() => null)
        ]);
        if (!b || !e || !b.length || !e.length) return;
        const tb = last(trendSeries(clOf(b), 0.08)), te = last(trendSeries(clOf(e), 0.08));
        const bsc = market.mood ? (market.mood.breadth || 0) : 0;
        const newDir = mktOf(tb, te, bsc);
        if (newDir !== mktDir) log('piyasa yönü değişti:', mktDir, '→', newDir, '(BTC', tb, 'ETH', te, ')');
        mktDir = newDir;
        market.btc = Object.assign(market.btc || {}, { dir: tb });
        market.eth = Object.assign(market.eth || {}, { dir: te });
        if (market.mood) {
            market.mood.label = newDir === 1 ? 'LONG' : newDir === -1 ? 'SHORT' : 'YATAY';
            market.mood.btc = tb; market.mood.eth = te;
            market.mood.score = Number((2 * tb + te + bsc).toFixed(2));
        }
    } catch (err) { }
}

// ======================= ORTAK SİNYAL ÜRETİCİ =======================
function mkSig(o) {
    const side = o.dir === 'LONG' ? 1 : -1, risk = side * (o.entry - o.stop);
    return {
        id: o.sym.replace(/[^A-Z0-9]/g, '') + '_' + o.setup + '_' + o.time,
        symbol: o.sym, base: baseOf(o.sym), dir: o.dir, setup: o.setup, setupName: o.name,
        strength: o.strength, entry: o.entry, stop: o.stop, initialStop: o.stop, mode: 'A',
        tp1R: CFG.TP1_R, tp2R: o.tp2R, trail: CFG.TRAIL_R, atr: o.atr,
        tp1: o.entry + side * risk * CFG.TP1_R, tp2: o.entry + side * risk * o.tp2R,
        tsMs: o.tsMs, tsMfe: 0.3, maxHold: o.maxHold,
        riskPct: r2(risk / o.entry * 100), costR: r2(o.costR), volX: r2(o.volX), level: o.level,
        warnings: o.warnings || [], tri: o.tri || null,
        trend1h: o.h1, trend4h: o.h4 || 0, mkt: o.mkt,
        time: o.time, candleT: o.time, lastPrice: o.entry, mfe: 0, mae: 0, trackedTo: o.trackedTo,
        status: 'OPEN', reason: o.reason
    };
}
function canOpen(sym, dir, setup) {
    const C = CFG, open = signals.filter(isOpen);
    if (health().dayStop) return 'günlük limit';
    if (open.some(x => x.symbol === sym)) return 'açık var';
    if (open.filter(x => x.dir === dir).length >= C.MAX_OPEN_PER_DIR || open.length >= C.MAX_OPEN_TOTAL ||
        open.filter(x => x.setup === setup).length >= ({ LV: C.MAX_OPEN_LV, SW: C.MAX_OPEN_SW }[setup] || C.MAX_OPEN_SC)) return 'limit dolu';
    return null;
}
function signalMsg(s) {
    const lbl = strengthLabel(s.strength || 0);
    const tag = s.setup === 'SW' ? '↩️ Sweep Reversal 5m' : s.setup === 'SC' ? '⚡ Momentum Scalp 5m' : s.setup === 'LV' ? '🟡 Üçgen Kırılımı' : '🔵 ' + s.setupName;
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + tag +
        '\nGÜÇ ' + (s.strength || 0) + ' ' + lbl + ' | Hacim ' + s.volX.toFixed(1) + 'x' +
        '\nGiriş ' + fmt(s.entry) + ' (şimdi)\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ')' +
        '\nHedef 1 (' + s.tp1R + 'R): ' + fmt(s.tp1) + ' → yarısını kapat, stop girişe' +
        '\nHedef 2 (' + s.tp2R.toFixed(1) + 'R): ' + fmt(s.tp2) +
        '\nPiyasa ' + (market.mood ? market.mood.label : '-') +
        (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : '') +
        '\n⏱ 0.3R uzaklaştıysa atla.\n📈 ' + tvLink(s.base, s.setup === 'SC' || s.setup === 'SW' ? 5 : 15);
}

// ======================= ÜÇGEN: SİNYAL KURUCU =======================
function triBuild(o) {
    const C = CFG, side = o.dir === 'LONG' ? 1 : -1, P = o.P, line = o.line, atr = o.atr;
    const cls = CLASSIC[o.type];
    if (cls && cls !== o.dir && o.volX < C.LV_COUNTER_VOL) return { why: 'klasik yön dışı', hard: true };
    const stop = line - side * C.LV_STOP_ATR * atr, risk = side * (P - stop);
    if (!(risk > 0)) return { why: 'risk', hard: true };
    const riskPct = risk / P * 100;
    if (riskPct < C.LV_MIN_RISK_PCT) return { why: 'stop yakın %' + riskPct.toFixed(2) };
    if (riskPct > C.LV_MAX_RISK_PCT) return { why: 'stop geniş %' + riskPct.toFixed(1) };
    const costR = o.costPct / riskPct;
    if (costR > C.LV_MAX_COST_R) return { why: 'maliyet' };
    const meas = o.h ? side * ((line + side * o.h) - P) / risk : 3;
    const tp2R = Math.min(Math.max(meas, 1.5), 5);
    const strength = strengthScore({ touches: o.touches, squeeze: o.squeeze, volX: o.volX, distAtr: Math.abs((P - line) / atr) });
    const warnings = [];
    if (o.h4 === -side) warnings.push('4H ters');
    if (riskPct > 4) warnings.push('stop geniş');
    return { sig: mkSig({
        sym: o.sym, setup: 'LV', name: 'Üçgen Kırılımı ' + TRI.AGG + 'H (' + (o.type || 'Üçgen') + ')', dir: o.dir,
        strength, entry: P, stop, tp2R, atr, tsMs: 8 * H1, maxHold: C.LV_HOLD_MS, costR, volX: o.volX, level: line, warnings,
        tri: o.tri, h1: o.h1, h4: o.h4, mkt: o.mkt, time: o.time, trackedTo: o.trackedTo,
        reason: (o.type || 'Üçgen') + ' • ' + o.touches + ' dokunuş • hacim ' + o.volX.toFixed(1) + 'x • güç ' + strength + ' • hedef ' + tp2R.toFixed(1) + 'R'
    }) };
}

// ======================= ÜÇGEN: CANLI MOTOR =======================
function buildStruct(S, t0) {
    const o = { t: t0, h1: last(S.t1h), h4: last(S.t4h), lines: [] };
    if (S.c2 && S.c2.length >= 60) {
        const tri = TRI.detect(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = TRI.pack(tri, S.c2), lb = tri.type + ' • ' + tri.touches + ' dokunuş';
            o.tri = pk; o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type;
            o.lines.push({ key: 'TR|res|' + pk.res[0][0], kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, touches: tri.touches, squeeze: tri.squeeze });
            o.lines.push({ key: 'TR|sup|' + pk.sup[0][0], kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, touches: tri.touches, squeeze: tri.squeeze });
        }
    }
    return o;
}
async function liveVol(sym) {
    const now = Date.now(), hit = volCache.get(sym);
    if (hit && now - hit.t < 8000) return hit.d;
    try {
        const raw = await ex.fetchOHLCV(sym, '15m', undefined, 24);
        const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), base = closed.slice(-20);
        let avg = 0; for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0;
        let volX = 0;
        if (avg > 0) {
            const prev = closed.length ? closed[closed.length - 1][5] : 0;
            if (cur) {
                const el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15));
                const proj = cur[5] / el, w = Math.min(1, el / 0.6);
                volX = (w * proj + (1 - w) * prev) / avg;
            } else volX = prev / avg;
        }
        const d = { volX, lastClose: closed.length ? closed[closed.length - 1][4] : null };
        volCache.set(sym, { t: now, d }); return d;
    } catch (e) { const d = { volX: 0, lastClose: null }; volCache.set(sym, { t: now, d }); return d; }
}
function rej(sym, why) {
    const p = rejMem[sym];
    if (!p || p.why !== why) log('ÜÇGEN ret', baseOf(sym), why);
    rejMem[sym] = { why, t: Date.now() };
}
function liveSignal(e, vol) {
    const C = CFG, side = e.dir === 'LONG' ? 1 : -1, st = e.st;
    if (vol.volX < C.LV_VOL_SIG) return { why: 'hacim ' + vol.volX.toFixed(1) + 'x < ' + C.LV_VOL_SIG + 'x' };
    if (C.LV_CONFIRM15 && vol.lastClose != null && side * (vol.lastClose - e.v) <= 0) return { why: '15m kapanış teyidi yok' };
    if (!mktOk(mktDir, side)) return { why: 'piyasa ' + (mktDir === 0 ? 'YATAY' : mktDir === 1 ? 'LONG' : 'SHORT') };
    if (C.LV_REQ_H1 && st.h1 === -side) return { why: '1H ters' };
    const blk = canOpen(e.sym, e.dir, 'LV'); if (blk) return { why: blk };
    if (Date.now() - (lastSig[e.sym + '|LV'] || 0) < C.LV_CD_BRK_MIN * 60e3) return { why: 'cooldown' };
    const now = Date.now();
    const r = triBuild({ sym: e.sym, dir: e.dir, P: e.P, line: e.v, atr: e.L.atr, h: e.L.h, touches: e.L.touches || 4, squeeze: e.L.squeeze || 0.7,
        type: st.type, volX: vol.volX, costPct: costFor((tickers[e.sym] || {}).quoteVolume) * C.COST_MULT,
        tri: st.tri || null, h1: st.h1, h4: st.h4, mkt: mktDir, time: now, trackedTo: Math.ceil(now / M1) * M1 - M1 });
    if (!r.sig) return r;
    const sig = r.sig;
    signals.unshift(sig);
    if (signals.length > C.KEEP) signals.length = C.KEEP;
    lastSig[e.sym + '|LV'] = now; dirty = true;
    log('SİNYAL LV', sig.dir, sig.base, 'güç', sig.strength, 'hacim', vol.volX.toFixed(1), 'giriş', fmt(e.P));
    if (tgCap()) { tgTimes.push(now); telegram(signalMsg(sig)); }
    return { sig };
}

// ======================= SCALP 1: MOMENTUM BREAKOUT (5m) =======================
function scalpCand(F, i, ctx, D) {
    const C = CFG, c = F.c, cnt = D ? (k => { D[k] = (D[k] || 0) + 1; }) : () => { };
    if (i < 60) return null;
    const atr = F.atr[i], e21 = F.e21[i], e50 = F.e50[i], rv = F.rsi[i], vs = F.vsma[i];
    if ([atr, e21, e50, rv, vs].some(x => x == null) || !(vs > 0)) return null;
    const k = c[i], pv = c[i - 1], rng = (k[2] - k[3]) || 1e-12;
    const body = Math.abs(k[4] - k[1]) / rng, cp = (k[4] - k[3]) / rng, volX = k[5] / vs;
    if (volX < C.SC_MIN_VOLX) { cnt('KIR hacim'); return null; }
    if (body < C.SC_BODY_MIN) { cnt('KIR gövde'); return null; }
    if (rng > C.SC_MAX_RANGE_ATR * atr) { cnt('KIR mum büyük'); return null; }
    let hiA = -Infinity, loA = Infinity;
    for (let j = i - C.SC_LOOK; j <= i - 2; j++) { if (c[j][2] > hiA) hiA = c[j][2]; if (c[j][3] < loA) loA = c[j][3]; }
    const hi = Math.max(hiA, pv[2]), lo = Math.min(loA, pv[3]), coil = (hi - lo) / atr;
    let trendOk = false;
    for (const side of [1, -1]) {
        const L = side === 1;
        if (ctx.h15 !== side || ctx.h1 === -side || !mktOk(ctx.mkt, side)) continue;
        trendOk = true;
        const lvl = L ? hi : lo;
        const okShape = L ? (k[4] > lvl && k[4] > k[1] && cp >= C.SC_CLOSEPOS && k[4] > e21 && e21 > e50 && pv[4] <= hiA)
                          : (k[4] < lvl && k[4] < k[1] && cp <= 1 - C.SC_CLOSEPOS && k[4] < e21 && e21 < e50 && pv[4] >= loA);
        if (!okShape) continue;
        const ext = side * (k[4] - lvl) / atr;
        if (ext > C.SC_MAX_EXT_ATR) continue;
        if (L ? rv > C.SC_RSI_HI : rv < 100 - C.SC_RSI_HI) continue;
        const strength = scStrength({ volX, body, ext, coil, aligned: ctx.h1 === side });
        return { setup: 'SC', side, dir: L ? 'LONG' : 'SHORT', lvl, atr, volX, body, ext, coil, rv, strength, extreme: L ? k[3] : k[2], closeP: k[4], h1: ctx.h1, h4: ctx.h4 || 0, mkt: ctx.mkt };
    }
    cnt(trendOk ? 'KIR seviye/şekil' : 'KIR trend');
    return null;
}
function scalpBuild(cd, P, ctx, time, trackedTo) {
    const C = CFG, side = cd.side;
    const dist = Math.max(C.SC_STOP_ATR * cd.atr, side * (P - cd.extreme) + C.SC_STOP_PAD * cd.atr);
    if (dist > C.SC_MAX_STOP_ATR * cd.atr) return null;
    const stop = P - side * dist, riskPct = dist / P * 100;
    if (riskPct < C.SC_MIN_RISK_PCT || riskPct > C.SC_MAX_RISK_PCT) return null;
    const costR = ctx.costPct / riskPct;
    if (costR > C.SC_MAX_COST_R) return null;
    const warnings = [];
    if (cd.h1 === 0) warnings.push('1H yatay');
    if (ctx.h4 === -side) warnings.push('4H ters');
    return mkSig({
        sym: ctx.sym, setup: 'SC', name: 'Momentum Scalp 5m', dir: cd.dir, strength: cd.strength, entry: P, stop, tp2R: C.SC_TP2_R, atr: cd.atr,
        tsMs: C.SC_TS_MIN * 60e3, maxHold: C.SC_HOLD_MS, costR, volX: cd.volX, level: cd.lvl, warnings,
        h1: cd.h1, h4: cd.h4, mkt: cd.mkt, time, trackedTo,
        reason: '5m ' + C.SC_LOOK + ' mum ' + (side === 1 ? 'tepe' : 'dip') + ' kırılımı • hacim ' + cd.volX.toFixed(1) + 'x • gövde %' + Math.round(cd.body * 100) + ' • güç ' + cd.strength + ' • hedef ' + C.SC_TP2_R + 'R'
    });
}

// ======================= SCALP 2: SWEEP REVERSAL (5m) =======================
function swCand(F, i, ctx, D) {
    const C = CFG, c = F.c, cnt = D ? (k => { D[k] = (D[k] || 0) + 1; }) : () => { };
    if (i < C.SW_LOOK + 2) return null;
    const atr = F.atr[i], vs = F.vsma[i];
    if (atr == null || vs == null || !(vs > 0)) return null;
    const k = c[i], rng = k[2] - k[3];
    if (!(rng > 0)) return null;
    const volX = k[5] / vs;
    if (volX < C.SW_MIN_VOLX) { cnt('SW hacim'); return null; }
    if (rng < C.SW_MIN_RANGE_ATR * atr || rng > C.SW_MAX_RANGE_ATR * atr) { cnt('SW mum boyu'); return null; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - C.SW_LOOK; j < i; j++) { if (c[j][2] > hi) hi = c[j][2]; if (c[j][3] < lo) lo = c[j][3]; }
    if (hi - lo < 3 * atr) { cnt('SW dar aralık'); return null; }
    const mid = (hi + lo) / 2, top = Math.max(k[1], k[4]), bot = Math.min(k[1], k[4]), cp = (k[4] - k[3]) / rng;
    let swept = false, shape = false;
    for (const side of [1, -1]) {
        const L = side === 1, pierce = (L ? lo - k[3] : k[2] - hi) / atr;
        if (pierce < C.SW_PIERCE_ATR) continue;
        swept = true;
        const wick = L ? (bot - k[3]) / rng : (k[2] - top) / rng;
        if (wick < C.SW_WICK_MIN || (L ? !(k[4] > lo && cp >= 0.5) : !(k[4] < hi && cp <= 0.5))) continue;
        shape = true;
        if (ctx.h15 === -side || ctx.h1 === -side || !mktOk(ctx.mkt, side)) continue;
        const strength = swStrength({ volX, wick, pierce, side, h15: ctx.h15, h1: ctx.h1 });
        return { setup: 'SW', side, dir: L ? 'LONG' : 'SHORT', lvl: L ? lo : hi, extreme: L ? k[3] : k[2], mid, atr, volX, wick, pierce, strength, closeP: k[4], h1: ctx.h1, h4: ctx.h4 || 0, mkt: ctx.mkt };
    }
    cnt(!swept ? 'SW süpürme yok' : !shape ? 'SW fitil/kapanış' : 'SW trend');
    return null;
}
function swBuild(cd, P, ctx, time, trackedTo) {
    const C = CFG, side = cd.side;
    let dist = side * (P - cd.extreme) + C.SW_STOP_PAD * cd.atr;
    dist = Math.max(dist, C.SW_MIN_STOP_ATR * cd.atr);
    if (dist > C.SW_MAX_STOP_ATR * cd.atr) return null;
    const stop = P - side * dist, riskPct = dist / P * 100;
    if (riskPct < C.SW_MIN_RISK_PCT || riskPct > C.SW_MAX_RISK_PCT) return null;
    const costR = ctx.costPct / riskPct;
    if (costR > C.SW_MAX_COST_R) return null;
    const room = side * (cd.mid - P) / dist;
    if (room < C.SW_MIN_ROOM_R) return null;
    const tp2R = Math.min(Math.max(room, C.SW_TP2_MIN), C.SW_TP2_MAX);
    const warnings = [];
    if (ctx.h15 !== side) warnings.push('15m trend yatay');
    return mkSig({
        sym: ctx.sym, setup: 'SW', name: 'Sweep Reversal 5m', dir: cd.dir, strength: cd.strength, entry: P, stop, tp2R, atr: cd.atr,
        tsMs: C.SW_TS_MIN * 60e3, maxHold: C.SW_HOLD_MS, costR, volX: cd.volX, level: cd.lvl, warnings,
        h1: cd.h1, h4: cd.h4, mkt: cd.mkt, time, trackedTo,
        reason: '5m ' + C.SW_LOOK + ' mum ' + (side === 1 ? 'dip' : 'tepe') + ' süpürme + geri dönüş • fitil %' + Math.round(cd.wick * 100) + ' • hacim ' + cd.volX.toFixed(1) + 'x • güç ' + cd.strength + ' • hedef ' + tp2R.toFixed(1) + 'R (aralık ortası)'
    });
}

// ======================= SCALP TARAMA + RADAR =======================
async function scanScalp() {
    if ((!CFG.ENABLE_SC && !CFG.ENABLE_SW) || scState.running) return;
    scState.running = true; const t0 = Date.now(); const D = {};
    try {
        await refreshMktDir();
        const syms = Object.keys(symCache).filter(s => universe.includes(s))
            .sort((a, b) => ((tickers[b] || {}).quoteVolume || 0) - ((tickers[a] || {}).quoteVolume || 0)).slice(0, CFG.SC_UNIVERSE);
        const cands = []; let idx = 0, nOk = 0;
        const worker = async () => {
            while (idx < syms.length) {
                const sym = syms[idx++];
                try {
                    const c = closedOnly(await ex.fetchOHLCV(sym, '5m', undefined, 150), M5);
                    if (c.length < 80) continue;
                    const sc = symCache[sym]; if (!sc) continue;
                    const i = c.length - 1, age = Date.now() - (c[i][0] + M5);
                    if (age > 3 * M5) continue;
                    nOk++;
                    const F = fSeries(c);
                    const ctx = { sym, h15: sc.h15, h1: sc.h1, h4: sc.h4, mkt: mktDir, costPct: costFor((tickers[sym] || {}).quoteVolume) * CFG.COST_MULT };
                    const rangeOf = n => { let hi = -Infinity, lo = Infinity; for (let j = i - n + 1; j <= i; j++) { if (c[j][2] > hi) hi = c[j][2]; if (c[j][3] < lo) lo = c[j][3]; } return [hi, lo]; };
                    const [hi, lo] = rangeOf(CFG.SC_LOOK), [hiW, loW] = rangeOf(CFG.SW_LOOK);
                    scCache[sym] = { t: Date.now(), atr: F.atr[i], hi, lo, hiW, loW, h15: sc.h15, h1: sc.h1, volX: F.vsma[i] ? c[i][5] / F.vsma[i] : 0 };
                    if (age <= CFG.SC_MAX_AGE_MS) {
                        if (CFG.ENABLE_SC) { const cd = scalpCand(F, i, ctx, D); if (cd) cands.push({ sym, cd, ctx }); }
                        if (CFG.ENABLE_SW) { const cd = swCand(F, i, ctx, D); if (cd) cands.push({ sym, cd, ctx }); }
                    }
                } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        cands.sort((a, b) => b.cd.strength - a.cd.strength);
        let added = 0;
        for (const x of cands) {
            if (added >= 3) break;
            const { sym, cd, ctx } = x, key = sym + '|' + cd.setup;
            if (Date.now() - (lastSig[key] || 0) < CFG.SC_CD_MIN * 60e3) continue;
            if (canOpen(sym, cd.dir, cd.setup)) continue;
            const t = tickers[sym], P = t && t.last ? t.last : cd.closeP;
            if (cd.side * (P - cd.closeP) / cd.atr > CFG.SC_LATE_ATR) { log(cd.setup, 'geç kaldı', cd.dir, baseOf(sym)); continue; }
            if (cd.side * (P - cd.lvl) <= 0) { log(cd.setup, 'seviyeye geri döndü', cd.dir, baseOf(sym)); continue; }
            const now = Date.now();
            const sig = (cd.setup === 'SW' ? swBuild : scalpBuild)(cd, P, ctx, now, Math.ceil(now / M1) * M1 - M1);
            if (!sig || signals.some(s => s.id === sig.id)) continue;
            signals.unshift(sig); if (signals.length > CFG.KEEP) signals.length = CFG.KEEP;
            lastSig[key] = now; added++; dirty = true;
            log('SİNYAL', cd.setup, sig.dir, sig.base, 'güç', sig.strength, 'hacim', sig.volX, 'giriş', fmt(P));
            if (tgCap()) { tgTimes.push(now); telegram(signalMsg(sig)); }
        }
        scState.found = cands.length; scState.n = nOk; scState.diag = D;
        log('Scalp tarama:', nOk, 'coin,', cands.length, 'aday,', added, 'eklendi', JSON.stringify(D));
    } catch (e) { log('Scalp tarama hatası', e.message); }
    scState.running = false; scState.last = Date.now(); scState.ms = scState.last - t0;
}
function buildSCRadar() {
    const now = Date.now(), out = [], C = CFG;
    for (const sym of Object.keys(scCache)) {
        const z = scCache[sym]; if (now - z.t > 12 * 60e3 || !(z.atr > 0)) continue;
        const tk = tickers[sym]; if (!tk || !tk.last) continue;
        const P = tk.last;
        for (const side of [1, -1]) {
            const dirN = side === 1 ? 'LONG' : 'SHORT';
            if (C.ENABLE_SC && z.h15 === side && z.h1 !== -side && mktOk(mktDir, side)) {
                const lvl = side === 1 ? z.hi : z.lo, d = side * (lvl - P) / z.atr;
                if (d >= 0 && d <= C.SC_NEAR_ATR) out.push({ symbol: sym, base: baseOf(sym), price: P, kind: 'SC', bias: dirN, rank: d, volX: r2(z.volX),
                    state: (side === 1 ? '📈 ' : '📉 ') + '5m ' + C.SC_LOOK + ' mum ' + (side === 1 ? 'tepe ' : 'dip ') + fmt(lvl) + ' (' + d.toFixed(2) + ' ATR) • kırılırsa ' + dirN });
            }
            if (C.ENABLE_SW && z.h15 !== -side && z.h1 !== -side && mktOk(mktDir, side) && (z.hiW - z.loW) >= 3 * z.atr) {
                const lvl = side === 1 ? z.loW : z.hiW, d = side * (P - lvl) / z.atr;
                if (d >= 0 && d <= C.SW_NEAR_ATR) out.push({ symbol: sym, base: baseOf(sym), price: P, kind: 'SW', bias: dirN, rank: d, volX: r2(z.volX),
                    state: '↩️ 5m ' + C.SW_LOOK + ' mum ' + (side === 1 ? 'dip ' : 'tepe ') + fmt(lvl) + ' (' + d.toFixed(2) + ' ATR) • süpürüp geri dönerse ' + dirN });
            }
        }
    }
    return out;
}

// ======================= CANLI DÖNGÜ =======================
async function liveTick() {
    if (!CFG.ENABLE_LIVE || liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshMktDir();
        await refreshTickers();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        const mv = [];
        for (const sym of universe) {
            const tk = tickers[sym]; if (!tk || !tk.last) continue;
            const h = hist[sym] || (hist[sym] = []);
            h.push([now, tk.last]); while (h.length && now - h[0][0] > 20 * 60e3) h.shift();
            const ago = ms => { if (!h.length || h[0][0] > now - ms + 60e3) return null; let b = h[0]; for (const x of h) if (Math.abs(x[0] - (now - ms)) < Math.abs(b[0] - (now - ms))) b = x; return b[1]; };
            const p5 = ago(5 * 60e3), p15 = ago(15 * 60e3);
            if (p5) mv.push({ symbol: sym, base: baseOf(sym), price: tk.last, c5: (tk.last / p5 - 1) * 100, c15: p15 ? (tk.last / p15 - 1) * 100 : 0, c24: tk.percentage != null ? tk.percentage : 0 });
        }
        mv.sort((a, b) => b.c5 - a.c5);
        movers = { up: mv.filter(x => x.c5 > 0).slice(0, 10), down: mv.filter(x => x.c5 < 0).slice(-10).reverse() };

        const evs = [], rad = []; let nl = 0;
        if (CFG.ENABLE_TR) {
            for (const sym of Object.keys(struct)) {
                const st = struct[sym], tk = tickers[sym];
                if (!st || !tk || !tk.last || now - st.t > CFG.LV_STALE_MS) continue;
                const P = tk.last; let best = null;
                for (const L of st.lines) {
                    if (L.apex && now > L.apex) continue;
                    nl++;
                    const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0];
                    const v = dt ? a[1] + (b[1] - a[1]) * (now - a[0]) / dt : a[1];
                    const d = (P - v) / L.atr, sk = sym + '|' + L.key;
                    const sideNow = L.kind === 'res' ? -1 : 1;
                    const brk = L.kind === 'res' ? (d >= CFG.LV_BRK_ATR ? 1 : 0) : (d <= -CFG.LV_BRK_ATR ? -1 : 0);
                    if (brk) {
                        pend[sk] = (pend[sk] || 0) + 1;
                        if (pend[sk] >= CFG.LV_HOLD_TICKS) {
                            evs.push({ sym, L, d, v, P, dir: brk === 1 ? 'LONG' : 'SHORT', st });
                            delete pend[sk];
                        }
                        continue;
                    }
                    delete pend[sk];
                    if (!(sideNow * d >= -CFG.LV_BRK_ATR)) continue;
                    const ad = Math.abs(d);
                    if (ad <= CFG.LV_NEAR_ATR && (!best || ad < best.ad)) best = { ad, L, v };
                }
                if (best) {
                    const breakDir = best.L.kind === 'res' ? 'LONG' : 'SHORT', lineName = best.L.kind === 'res' ? 'direnç' : 'destek', cls = CLASSIC[st.type];
                    rad.push({ symbol: sym, base: baseOf(sym), price: P, kind: 'TRI', rank: best.ad, touches: best.L.touches, squeeze: best.L.squeeze, type: st.type,
                        state: best.L.label + ' • ' + lineName + ' ' + fmt(best.v) + ' (' + best.ad.toFixed(2) + ' ATR) → kırılırsa ' + breakDir + (cls && cls !== breakDir ? ' (klasik ' + cls + ')' : '') });
                }
            }
            for (const r of rad) {
                try { const v = await liveVol(r.symbol); r.volX = r2(v.volX); r.strength = strengthScore({ touches: r.touches, squeeze: r.squeeze, volX: v.volX, distAtr: r.rank }); } catch (e) { r.volX = 0; r.strength = 0; }
            }
        }
        const newKeys = new Set(rad.map(r => r.symbol));
        for (const old of prevRadarKeys) if (!newKeys.has(old)) {
            const rr = triRadar.find(x => x.symbol === old);
            if (!rr || signals.some(s => s.symbol === old && s.setup === 'LV' && now - s.time < 120e3)) continue;
            const m = rejMem[old];
            dropped.unshift({ symbol: old, base: baseOf(old), rank: rr.rank, t: now, why: m && now - m.t < 120e3 ? 'kırdı ama sinyal yok: ' + m.why : 'çizgiden uzaklaştı' });
        }
        if (dropped.length > 30) dropped.length = 30;
        prevRadarKeys.clear(); for (const k of newKeys) prevRadarKeys.add(k);
        triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 30);
        scRadar = buildSCRadar().sort((a, b) => a.rank - b.rank).slice(0, 40);

        if (CFG.ENABLE_TR) {
            evs.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
            let fetched = 0;
            for (const e of evs) {
                const cdKey = 'B|' + e.sym + '|' + e.L.key;
                if (now - (lastSig[cdKey] || 0) < CFG.LV_CD_BRK_MIN * 60e3) continue;
                if (Math.abs(e.d) > CFG.LV_MAX_EXT_ATR) { lastSig[cdKey] = now; rej(e.sym, 'çok uzak (' + Math.abs(e.d).toFixed(2) + ' ATR)'); continue; }
                if (fetched >= CFG.LV_MAX_VOLFETCH) { rej(e.sym, 'veri limiti'); break; }
                let vol; try { vol = await liveVol(e.sym); fetched++; } catch (er) { continue; }
                const r = liveSignal(e, vol);
                if (r.sig) lastSig[cdKey] = now;
                else { rej(e.sym, r.why); if (r.hard) lastSig[cdKey] = now; }
            }
        }
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length; live.lines = nl;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function pruneLive() {
    for (const m of [struct, hist, symCache, scCache]) for (const k of Object.keys(m)) if (!universe.includes(k)) delete m[k];
    for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
    for (const k of Object.keys(rejMem)) if (Date.now() - rejMem[k].t > 30 * 60e3) delete rejMem[k];
}

// ======================= SANAL POZİSYON =======================
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
                        if (advance(s, k, M1) && !isOpen(s)) { log('KAPANDI', s.setup, s.symbol, s.status, s.netR); telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                        if (before === 'OPEN' && s.status === 'TP1') telegram('💰 ' + s.base + ' ' + s.dir + ' — TP1 vuruldu. Yarısını sat, stop girişe.');
                    }
                }
            } catch (e) { }
        }
    } catch (e) { }
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
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
function health() {
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const today = trDay(Date.now());
    const dayR = closed.filter(s => trDay(s.closedAt) === today).reduce((a, s) => a + s.netR, 0);
    return { n: closed.length, dayR, dayStop: dayR <= CFG.DAY_STOP_R };
}

// ======================= TARAMA (15 dk) =======================
async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now();
    scan.reasons = {};
    const bump = k => { scan.reasons[k] = (scan.reasons[k] || 0) + 1; };
    try {
        const S = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const d = await getMulti(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); bump('düz'); continue; }
                    if (d.c15.length < 120 || !d.c1h || d.c1h.length < 60 || !d.c4h || d.c4h.length < 60) { bump('veri az'); continue; }
                    S[sym] = { c15: d.c15, t15: trendSeries(clOf(d.c15), 0.08), t1h: trendSeries(clOf(d.c1h), 0.10), t4h: trendSeries(clOf(d.c4h), 0.15), c2: aggregateN(d.c1h, H1, TRI.AGG) };
                } catch (e) { bump('hata'); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        let up = 0, dn = 0, fl = 0; const keys = Object.keys(S);
        for (const k of keys) { const v = last(S[k].t15); if (v === 1) up++; else if (v === -1) dn++; else fl++; }
        const bsc = breadthScore(up, dn, keys.length);
        const bd = S[BTC] ? last(S[BTC].t15) : 0, ed = S[ETH] ? last(S[ETH].t15) : 0;
        mktDir = mktOf(bd, ed, bsc);
        mktUpdatedAt = Date.now();
        market.btc = Object.assign(market.btc || {}, { dir: bd }); market.eth = Object.assign(market.eth || {}, { dir: ed });
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: keys.length, breadth: Number(bsc.toFixed(2)), btc: bd, eth: ed, score: Number((2 * bd + ed + bsc).toFixed(2)) };
        for (const sym of universe) {
            const s = S[sym]; if (!s) continue;
            const c = s.c15, i = c.length - 1;
            if (t0 - (c[i][0] + M15) > 2 * M15) { bump('bayat'); continue; }
            symCache[sym] = { t: t0, h15: last(s.t15), h1: last(s.t1h), h4: last(s.t4h) };
            if (CFG.ENABLE_LIVE && CFG.ENABLE_TR) { try { const stc = buildStruct(s, t0); if (stc) struct[sym] = stc; else delete struct[sym]; } catch (e) { } }
        }
        pruneLive();
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= BACKTEST =======================
async function fetchHistory5(sym, days) {
    const total = days + 12;
    let since = Date.now() - total * D1, all = [], guard = 0;
    while (since < Date.now() - M5 && guard++ < 200) {
        let r = null, retry = 0;
        while (retry < 4) { try { r = await ex.fetchOHLCV(sym, '5m', since, 1000); break; } catch (e) { retry++; await sleep(800 * retry); } }
        if (!r || !r.length) break;
        all = all.concat(r); const l = last(r)[0];
        if (l <= since) break; since = l + M5;
        await sleep(100);
    }
    const seen = new Set();
    const c = closedOnly(all, M5).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
    const usable = c.length ? (last(c)[0] - c[0][0]) / D1 - 11 : 0;
    return { c, usable };
}
function buildBT(c5) {
    const c15 = aggregateN(c5, M5, 3), c1h = aggregateN(c5, M5, 12), c2 = aggregateN(c5, M5, 12 * TRI.AGG);
    return { c5, c2, triMemo: new Map(), F: fSeries(c5),
        t15: trendSeries(clOf(c15), 0.08), t1h: trendSeries(clOf(c1h), 0.10),
        p15: ptrMap(c5, c15, M15, M5), p1h: ptrMap(c5, c1h, H1, M5), p2: ptrMap(c5, c2, TRI.DUR, M5) };
}
function prepare(data, costOf) {
    const pre = {}, cnt = new Map(), trMap = { [BTC]: new Map(), [ETH]: new Map() };
    for (const s of Object.keys(data)) {
        const S = buildBT(data[s]); S.costPct = costOf(s); pre[s] = S;
        const c = S.c5;
        for (let i = 0; i < c.length; i++) {
            const t = c[i][0], p = S.p15[i], v = p >= 0 ? S.t15[p] : 0;
            let a = cnt.get(t); if (!a) { a = [0, 0, 0]; cnt.set(t, a); }
            a[2]++; if (v === 1) a[0]++; else if (v === -1) a[1]++;
            if (trMap[s]) trMap[s].set(t, v);
        }
    }
    const mkt = new Map();
    for (const [t, a] of cnt) mkt.set(t, mktOf(trMap[BTC].get(t) || 0, trMap[ETH].get(t) || 0, breadthScore(a[0], a[1], a[2])));
    return { pre, maps: { mkt } };
}
function triBT(S, i, ctx, t, fired) {
    const c = S.c5, j2 = S.p2[i];
    if (j2 == null || j2 < 60) return null;
    let tri = S.triMemo.get(j2);
    if (tri === undefined) { tri = TRI.detect(S.c2, j2, CFG); S.triMemo.set(j2, tri); }
    if (!tri) return null;
    const frac = Math.min(1, Math.max(0, (t - (S.c2[j2][0] + TRI.DUR)) / TRI.DUR)), x = j2 + 1 + frac;
    const lr = TRI.lineR(tri, x), ls = TRI.lineS(tri, x), P = c[i][4];
    const side = P > lr + CFG.LV_BRK_ATR * tri.atr ? 1 : P < ls - CFG.LV_BRK_ATR * tri.atr ? -1 : 0;
    if (!side || fired.has(j2 + '|' + side)) return null;
    if (!mktOk(ctx.mkt, side) || (CFG.LV_REQ_H1 && ctx.h1 === -side)) return null;
    const vs = S.F.vsma[i]; if (!(vs > 0) || i < 3) return null;
    const volX = (c[i][5] + c[i - 1][5] + c[i - 2][5]) / (3 * vs);
    if (volX < CFG.LV_VOL_SIG) return null;
    const line = side === 1 ? lr : ls;
    if (Math.abs((P - line) / tri.atr) > CFG.LV_MAX_EXT_ATR) return null;
    if (CFG.LV_CONFIRM15 && (side === 1 ? Math.min(c[i][4], c[i - 1][4], c[i - 2][4]) <= line : Math.max(c[i][4], c[i - 1][4], c[i - 2][4]) >= line)) return null;
    const r = triBuild({ sym: ctx.sym, dir: side === 1 ? 'LONG' : 'SHORT', P, line, atr: tri.atr, h: tri.w0, touches: tri.touches, squeeze: tri.squeeze, type: tri.type,
        volX, costPct: ctx.costPct, tri: null, h1: ctx.h1, h4: 0, mkt: ctx.mkt, time: t, trackedTo: t - M1 });
    if (!r.sig) return null;
    r.sig.fk = j2 + '|' + side;
    return r.sig;
}
async function simulate(pre, use, maps, startT) {
    const raw = [];
    for (const sym of use) {
        const S = pre[sym], c = S.c5, n = c.length, fired = new Set(); let busy = 0;
        const from = Math.max(startT, c[0][0] + 11 * D1);
        for (let i = 60; i < n - 1; i++) {
            const t = c[i][0] + M5; if (t < from || t < busy) continue;
            const p15 = S.p15[i], p1 = S.p1h[i]; if (p15 < 1 || p1 < 1) continue;
            const ctx = { sym, h15: S.t15[p15], h1: S.t1h[p1], h4: 0, mkt: maps.mkt.get(c[i][0]) || 0, costPct: S.costPct };
            const cs = [];
            if (CFG.ENABLE_SC) { const cd = scalpCand(S.F, i, ctx); if (cd) { const x = scalpBuild(cd, c[i][4], ctx, t, t - M1); if (x) cs.push(x); } }
            if (CFG.ENABLE_SW) { const cd = swCand(S.F, i, ctx); if (cd) { const x = swBuild(cd, c[i][4], ctx, t, t - M1); if (x) cs.push(x); } }
            if (CFG.ENABLE_TR) { const x = triBT(S, i, ctx, t, fired); if (x) cs.push(x); }
            if (!cs.length) continue;
            // LV adayı her zaman işaretlenir (aynı 2H mumda SC/SW öne geçse bile tekrar denemesin)
            for (const x of cs) if (x.fk) fired.add(x.fk);
            const sig = cs.sort((a, b) => b.strength - a.strength)[0];
            for (let j = i + 1; j < n; j++) { if (advance(sig, c[j], M5) && !isOpen(sig)) break; }
            if (isOpen(sig)) break;
            raw.push({ symbol: sym, base: baseOf(sym), dir: sig.dir, setup: sig.setup, setupName: sig.setupName, strength: sig.strength,
                time: sig.time, closedAt: sig.closedAt, netR: sig.netR, costR: sig.costR, status: sig.status });
            busy = Math.max(sig.closedAt, sig.time + (sig.setup === 'LV' ? CFG.LV_CD_BRK_MIN : CFG.SC_CD_MIN) * 60e3);
        }
        await sleep(0);
    }
    raw.sort((a, b) => a.time - b.time);
    const trades = [], openL = []; let blocked = 0;
    for (const t of raw) {
        for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
        if (openL.length >= CFG.MAX_OPEN_TOTAL || openL.filter(x => x.dir === t.dir).length >= CFG.MAX_OPEN_PER_DIR ||
            openL.filter(x => x.setup === t.setup).length >= ({ LV: CFG.MAX_OPEN_LV, SW: CFG.MAX_OPEN_SW }[t.setup] || CFG.MAX_OPEN_SC)) { blocked++; continue; }
        openL.push(t); trades.push(t);
    }
    return { trades, raw, blocked };
}
async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    opts = Object.assign({ costMult: 1 }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => s !== BTC && s !== ETH).slice(0, coins), all = [BTC, ETH].concat(syms);
        btJob.total = all.length + 1;
        const data = {}, skipped = []; let usableMax = 0;
        for (const s of all) {
            btJob.msg = 'Veri: ' + baseOf(s);
            try { const h = await fetchHistory5(s, days); if (h.usable < 4 && !isMajor(s)) skipped.push(baseOf(s)); else { data[s] = h.c; usableMax = Math.max(usableMax, h.usable); } } catch (e) { skipped.push(baseOf(s)); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 4000) throw new Error('BTC verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];
        btJob.msg = 'Simülasyon';
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult);
        const effDays = Math.max(1, Math.min(days, Math.round(usableMax))), startT = Date.now() - days * D1;
        const r = await simulate(pre, Object.keys(data), maps, startT);
        const tr = r.trades, n = tr.length, h = Math.floor(n / 2);
        const sortedR = tr.map(t => t.netR).sort((a, b) => a - b);
        btJob.result = { days: effDays, coins, skipped: skipped.slice(0, 10), costMult: opts.costMult, rawN: r.raw.length, blocked: r.blocked,
            all: grp(tr), is: grp(tr.slice(0, h)), oos: grp(tr.slice(h)), median: n ? sortedR[Math.floor(n / 2)] : 0,
            bySetup: groupBy(tr, s => s.setup + ' ' + s.setupName), byDir: groupBy(tr, s => s.dir), byExit: groupBy(tr, s => s.status), byStrength: groupBy(tr, strBucket) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Hata: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ======================= API =======================
function pnlR(s) { return s && s.lastPrice ? (s.dir === 'LONG' ? 1 : -1) * (s.lastPrice - s.entry) / Math.abs(s.entry - s.initialStop) : null; }
function apiState() {
    const now = Date.now();
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(now))),
        bySetup: groupBy(closed, s => s.setup + ' ' + s.setupName), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status), byStrength: groupBy(closed, strBucket) };
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const open = signals.filter(isOpen);
    const openPnl = open.reduce((t, s) => t + (pnlR(s) || 0), 0);
    const px = {};
    for (const x of signals.slice(0, 80).concat(triRadar).concat(scRadar)) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now, mode: 'v18.1 • Üçgen + Kırılım + Sweep', px, market,
        signals: signals.slice(0, 80), radar: triRadar, scRadar, dropped: dropped.slice(0, 15),
        stats: st, equity: eq, openPnl: r2(openPnl), last24: signals.filter(s => now - s.time < 24 * H1).length, movers,
        live: { enabled: CFG.ENABLE_LIVE, periodMs: CFG.LIVE_MS, last: live.last, symbols: live.n, lines: live.lines, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { triAgg: TRI.AGG, volSig: CFG.LV_VOL_SIG, mkt: CFG.MKT_MODE, reqH1: CFG.LV_REQ_H1, scOn: CFG.ENABLE_SC, swOn: CFG.ENABLE_SW, swLook: CFG.SW_LOOK, scVol: CFG.SC_MIN_VOLX, scLook: CFG.SC_LOOK, scTp: CFG.SC_TP2_R },
        sc: { last: scState.last, ms: scState.ms, n: scState.n, found: scState.found, diag: scState.diag || {} },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible, suspect: scan.suspect }
    };
}
async function apiCandles(sym, tf) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    tf = tf === '15m' || tf === '5m' ? tf : 'tri';
    const key = sym + '|' + tf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let d;
    if (tf === '15m' || tf === '5m') {
        const c = await ex.fetchOHLCV(sym, tf, undefined, 200), cl = clOf(c), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), vs = volSma(c, 20), cut = Math.max(0, c.length - 120);
        d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur: tf === '5m' ? M5 : M15, tri: null };
    } else {
        const raw = closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 400), H1), c2 = aggregateN(raw, H1, TRI.AGG);
        if (c2.length < 30) throw new Error('yetersiz veri');
        const cl = clOf(c2), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), vs = volSma(c2, 20), cut = Math.max(0, c2.length - 120);
        const tri = c2.length > 60 ? (TRI.detect(c2, c2.length - 1, CFG) || TRI.detect(c2, c2.length - 2, CFG)) : null;
        d = { c: c2.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf: TRI.AGG + 'H', dur: TRI.DUR, tri: tri ? TRI.pack(tri, c2) : null };
    }
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE v18.1</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.am{color:var(--am)}.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:420px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:11px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.r1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.badge.TRI{background:rgba(255,212,0,.15);color:#ffd400}
.coin{font-weight:800;font-size:14px}.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
.tag.scl{color:#7ec8ff;border-color:rgba(90,169,255,.5)}.tag.lv{color:var(--lg);border-color:rgba(61,220,151,.5)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}.box.ok{border-color:rgba(61,220,151,.5)}.box.no{border-color:rgba(255,107,122,.5)}
table{width:100%;border-collapse:collapse}th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:400px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.frm input{width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}.btn.off{background:var(--p2);color:var(--dm);border:1px solid var(--ln)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.5);display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:260px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v18.1</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div><span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<div id="toast"></div>
<script>
var TABS=[['sig','Sinyal'],['near','Üçgen'],['sc','Scalp'],['mv','Hareket'],['stat','İstatistik'],['bt','Test']];
var S=null,tab='sig',sel=null,bt=null,chartCache={},chartFor='',chartTF='tri',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),actx=null,lastSigT=0,toastT=null;
function $(id){return document.getElementById(id)}
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'up':x<0?'dn':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function openS(s){return s.status==='OPEN'||s.status==='TP1'}
function pnlR(s){return s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null}
var ST={OPEN:['AÇIK','w'],TP1:['TP1 ✓','g'],TP2:['TP2 ✓','g'],STOP:['STOP','r'],BE:['BAŞA BAŞ','w'],TRAIL:['TRAIL','g'],TIMEOUT:['SÜRE','w']};
function volTag(v){var c=v>=1.5?'g':v>=1.0?'w':'r';return '<span class="tag '+c+'">Hacim '+f2(v,1)+'x</span>'}
function strTag(s){var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};return '<span class="tag '+x.c+'">GÜÇ '+s+' '+x.l+'</span>'}
function setupTag(s){return s.setup==='LV'?'<span class="tag lv">Üçgen</span>':s.setup==='SC'?'<span class="tag scl">Kırılım</span>':s.setup==='SW'?'<span class="tag scl">Sweep</span>':'<span class="tag">Eski</span>'}
function setupName(s){return s.setup==='SC'?'KIRILIM':s.setup==='SW'?'SWEEP':s.setup==='LV'?'ÜÇGEN':'SİNYAL'}
function key(){return localStorage.getItem('st_key')||''}
async function post(url,b){var r=await fetch(url+'?key='+encodeURIComponent(key()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
 if(r.status===401){var k=prompt('ADMIN_KEY:');if(k){localStorage.setItem('st_key',k);return post(url,b)}}return r}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function defTF(s){return s.setup==='SC'||s.setup==='SW'?'5m':'tri'}
function showToast(s){var t=$('toast');var st=s.strength>=75?'ÇOK GÜÇLÜ':s.strength>=55?'GÜÇLÜ':s.strength>=35?'ORTA':'ZAYIF';t.textContent='🔔 '+setupName(s)+' '+s.dir+' '+s.base+' • '+st+' ('+s.strength+')';t.style.display='block';
 t.onclick=function(){t.style.display='none';tab='sig';sel={id:s.id,sym:s.symbol};chartTF=defTF(s);chartFor='';renderAll()};
 clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},30000)}
function checkNew(){var sg2=S.signals||[],mx=sg2.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=sg2.filter(function(x){return x.time>lastSigT&&openS(x)});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);document.title='('+nw.length+') YENİ '+nw[0].dir+' '+nw[0].base;showToast(nw[0])}
 else if(!document.hidden)document.title='SONER TRADE v18.1'}

function renderTop(){var md=S.market&&S.market.mood;
 $('cMkt').innerHTML=md?'<b>Piyasa</b> <span class="'+(md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl')+'"><b style="color:inherit">'+md.label+'</b></span> <span class="fl">'+md.up+'↑/'+md.down+'↓</span>':'<b>Piyasa</b> ...';
 [['cBTC','BTC','btc'],['cETH','ETH','eth']].forEach(function(a){var m=S.market[a[2]];$(a[0]).innerHTML=m?'<b>'+a[1]+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg)+'%</span>':'<b>'+a[1]+'</b> -'});
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(S.stats.today.totalR)+'">'+sg(S.stats.today.totalR,1)+'R</span> <span class="fl">| açık '+sg(S.openPnl,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var oc=S.signals.filter(openS).length,nr=(S.radar||[]).length,ns=(S.scRadar||[]).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t[0]==='sig'?' ('+oc+')':t[0]==='near'?' ('+nr+')':t[0]==='sc'?' ('+ns+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;renderAll()}})}

function sigCard(s){var st=ST[s.status]||['?',''],R=pnlR(s),op=openS(s),px=s.lastPrice||s.entry,pc=(s.dir==='LONG'?1:-1)*(px/s.entry-1)*100;var pn='';
 if(op&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R <span class="fl" style="font-size:10px">'+sg(pc)+'%</span></span>';
 else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card'+(sel&&sel.id===s.id?' sel':'')+(op?'':' closed')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+setupTag(s)+strTag(s.strength||0)+volTag(s.volX||0)+pn+'</div><div class="sub">'+(op?'<span>Şimdi <b>'+fp(px)+'</b></span>':'')+'<span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop '+fp(s.stop)+'</span><span>'+ago(s.time)+' önce</span></div></div>'}
function triCard(r){
 return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge TRI">ÜÇGEN</span><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span>'+strTag(r.strength||0)+volTag(r.volX||0)+'</div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function scCard(r){
 return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag scl">'+(r.kind==='SW'?'Sweep aday':'Kırılım aday')+'</span></div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function mvCard(r){return '<div class="card" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.c5)+'" style="font-size:14px">'+sg(r.c5)+'%</span></div><div class="sub"><span>15dk <b class="'+cl(r.c15)+'">'+sg(r.c15)+'%</b></span><span>24s <b class="'+cl(r.c24)+'">'+sg(r.c24,1)+'%</b></span></div></div>'}

function renderList(){var h='';
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return !openS(s)}).slice(0,25);
  h+='<div class="note" style="padding:6px 8px">Canlı sinyaller (Üçgen + Kırılım + Sweep). Ses + Telegram gelir.</div>';
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Açık sinyal yok.</div>';
  if(c.length)h+='<h3>Kapanan</h3>'+c.map(sigCard).join('')}
 else if(tab==='near'){
  h='<div class="note" style="padding:6px 8px">Üçgen çizgisine 0.45 ATR yakın coinler. Yönsüz aday, kırılırsa yön belirir. Sinyal değil.</div>';
  h+=(S.radar||[]).length?S.radar.map(triCard).join(''):'<div class="note" style="padding:10px">Yaklaşan yok.</div>';
  if((S.dropped||[]).length){h+='<h3>Son düşenler</h3>';h+=S.dropped.slice(0,10).map(function(d){return '<div class="card" data-sym="'+esc(d.symbol)+'"><div class="r1"><span class="badge TRI">ÜÇGEN</span><span class="coin">'+esc(d.base)+'</span><span class="tag">'+esc(d.why)+'</span></div><div class="sub"><span>'+ago(d.t)+' önce</span></div></div>'}).join('')}}
 else if(tab==='sc'){
  h='<div class="note" style="padding:6px 8px">Yaklaşan scalp adayları (kırılım: trend yönünde tepe/dip, sweep: aralık ucundan dönüş). Sinyal değil, izleme listesi.</div>';
  var dg=(S.sc&&S.sc.diag)||{},dk=Object.keys(dg).sort(function(a,b){return dg[b]-dg[a]}).slice(0,8);
  if(dk.length)h+='<div class="note" style="padding:0 8px 6px">Son taramada eleme nedenleri: '+dk.map(function(k){return esc(k)+' '+dg[k]}).join(' • ')+'</div>';
  h+=(S.scRadar||[]).length?S.scRadar.map(scCard).join(''):'<div class="note" style="padding:10px">Scalp adayı yok.</div>'}
 else if(tab==='mv'){var m=S.movers||{up:[],down:[]};h='<h3>Yükselenler</h3>'+(m.up.length?m.up.map(mvCard).join(''):'-')+'<h3>Düşenler</h3>'+(m.down.length?m.down.map(mvCard).join(''):'-')}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 $('list').innerHTML=h;
 Array.prototype.forEach.call($('list').querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.dataset.id,sy=e.dataset.sym;
  if(id){var s=S.signals.find(function(x){return x.id===id});sel={id:id,sym:s.symbol};chartTF=defTF(s)}else{sel={sym:sy};chartTF=tab==='sc'?'5m':'tri'}chartFor='';renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

function sigView(s){var st=ST[s.status]||['?',''],R=pnlR(s),op=openS(s),px=s.lastPrice||s.entry,pc=(s.dir==='LONG'?1:-1)*(px/s.entry-1)*100,w=(s.warnings||[]).map(function(x){return '<span class="tag w">'+esc(x)+'</span> '}).join('');
 var tinfo=s.tri&&s.tri.type?'<span class="tag g">'+esc(s.tri.type)+'</span>':'';
 var big=op&&R!=null?'<span class="'+cl(R)+'">'+sg(R)+'R ('+sg(pc)+'%)</span>':(s.netR!=null?'<span class="'+cl(s.netR)+'">'+sg(s.netR)+'R</span>':'');
 var iv=s.setup==='SC'||s.setup==='SW'?5:15;
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.base)+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span>'+setupTag(s)+tinfo+strTag(s.strength||0)+volTag(s.volX||0)+'<span class="sc" style="font-size:22px">'+big+'</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce</div>'+w+tfBar()+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Anlık</span><b>'+fp(px)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1 ('+s.tp1R+'R)</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2 ('+f2(s.tp2R,1)+'R)</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div><div><span>Hacim</span><b>'+f2(s.volX,1)+'x</b></div><div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+' / '+f2(s.mae,1)+'R</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="https://www.tradingview.com/chart/?symbol=BITGET:'+s.base+'USDT.P&interval='+iv+'" target="_blank">📈 TradingView</a></div>'+calcBox(s.entry,s.initialStop)+'<div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div>'}

function moodTxt(){var m=S.market&&S.market.mood;if(!m||m.score==null)return'';var w=function(v){return v===1?'yukarı':v===-1?'aşağı':'yatay'};return '<div class="note" style="color:var(--tx)">Piyasa '+m.label+' (BTC 15m '+w(m.btc)+', ETH 15m '+w(m.eth)+', genişlik '+m.up+'↑/'+m.down+'↓). Mod: '+S.config.mkt+'</div>'}
function homeView(){var open=S.signals.filter(openS),L=S.live,td=S.stats.today,a=S.stats.all,F=S.config;
 var scN=open.filter(function(s){return s.setup==='SC'}).length,swN=open.filter(function(s){return s.setup==='SW'}).length,lvN=open.filter(function(s){return s.setup==='LV'}).length;
 return '<h2>Pano</h2><div class="tiles">'+
 '<div class="tile"><div class="k">Açık (Ü '+lvN+' / K '+scN+' / S '+swN+')</div><div class="v">'+open.length+'</div><div class="k">anlık '+sg(S.openPnl,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Bugün</div><div class="v '+cl(td.totalR)+'">'+sg(td.totalR,1)+'R</div><div class="k">'+td.n+' kapanan</div></div>'+
 '<div class="tile"><div class="k">Toplam</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'R</div><div class="k">'+a.n+' işlem, PF '+f2(a.pf)+'</div></div>'+
 '<div class="tile"><div class="k">Radar (Ü/S)</div><div class="v">'+(S.radar||[]).length+'/'+(S.scRadar||[]).length+'</div><div class="k">üçgen / scalp adayı</div></div></div>'+
 '<div class="box '+(L.enabled&&!L.err?'ok':'no')+'"><h3 style="margin-top:0">Sistemler</h3>'+
 '<div class="note" style="color:var(--tx);font-size:12px"><b>1) Üçgen (LV):</b> '+F.triAgg+'H üçgen. Çizgi kırılıp tutarsa + hacim '+F.volSig+'x + 15m kapanış teyidi + piyasa/1H ters değil → sinyal.</div>'+
 '<div class="note" style="color:var(--tx);font-size:12px"><b>2) Momentum Scalp (SC):</b> 15m trend yönünde, 5m '+F.scLook+' mumluk tepe/dip kırılımı + güçlü gövde + hacim '+F.scVol+'x + taze kırılım → sinyal. Hedef '+F.scTp+'R, 45 dk içinde hareket yoksa kapanır.</div>'+
 '<div class="note" style="color:var(--tx);font-size:12px"><b>3) Sweep Reversal (SW):</b> 5m '+F.swLook+' mumluk dip/tepe iğneyle delinip hacimle geri içeri kapanırsa, trend/piyasa ters değilse dönüş sinyali. Hedef aralık ortası, 30 dk içinde hareket yoksa kapanır. Yatay piyasada da çalışır.</div>'+
 '<div class="note">Telegram: '+(L.tgOn?'açık':'kapalı')+' • '+S.scan.universe+' coin izleniyor • scalp taraması: '+(S.sc?S.sc.n:0)+' coin</div></div>'+moodTxt()}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td></tr>'}).join('')+'</table>'};
function statView(){return '<h2>İstatistik (sanal)</h2><div class="note">Botun sanal sonuçları. Gerçek hesap değil.</div>'+tbl({'Tümü':S.stats.all,'Bugün':S.stats.today},'Genel')+tbl(S.stats.bySetup||{},'Kurulum')+tbl(S.stats.byStrength||{},'Güç puanı')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byExit,'Çıkış')}

var _bs=JSON.parse(localStorage.getItem('st_bt18')||'{"d":30,"c":60,"m":1}');
function opt(v,cur,t){return '<option value="'+v+'"'+(+cur===v?' selected':'')+'>'+t+'</option>'}
function btView(){var h='<h2>Backtest (5m veri)</h2><div class="box"><div class="frm"><select id="bD">'+opt(14,_bs.d,'14g')+opt(30,_bs.d,'30g')+opt(60,_bs.d,'60g')+'</select><select id="bC">'+opt(30,_bs.c,'30c')+opt(60,_bs.c,'60c')+opt(100,_bs.c,'100c')+'</select><select id="bM">'+opt(1,_bs.m,'maliyet x1')+opt(1.5,_bs.m,'x1.5')+opt(2,_bs.m,'x2')+'</select><button class="btn" id="bGo">Başlat</button></div><div class="note">Önce maliyet x1.5 ile dene. Sonuç pozitif ve işlem sayısı 100+ değilse canlıya güvenme.</div></div>';
 if(!bt)return h;
 if(bt.running)h+='<div class="box">'+esc(bt.msg)+' ('+bt.done+'/'+bt.total+')</div>';
 if(bt.error)h+='<div class="box no dn">'+esc(bt.error)+'</div>';
 if(bt.result){var R=bt.result,a=R.all;
  h+='<div class="tiles"><div class="tile"><div class="k">İşlem</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Win%</div><div class="v">'+f2(a.win*100,0)+'</div></div><div class="tile"><div class="k">Ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">t</div><div class="v">'+f2(a.t)+'</div></div><div class="tile"><div class="k">Medyan</div><div class="v '+cl(R.median)+'">'+sg(R.median)+'</div></div></div>';
  h+=tbl({'İlk yarı':R.is,'İkinci yarı (OOS)':R.oos},'Tutarlılık')+tbl(R.bySetup||{},'Kurulum')+tbl(R.byStrength||{},'Güç puanı')+tbl(R.byDir,'Yön')+tbl(R.byExit,'Çıkış');
  h+='<div class="note">'+R.days+'g / '+R.coins+' coin / '+R.rawN+' ham / '+R.blocked+' limitli</div>';
 }
 return h}
function bindBt(){[['bD','d'],['bC','c'],['bM','m']].forEach(function(a){var e=$(a[0]);if(e)e.onchange=function(){_bs[a[1]]=+e.value;localStorage.setItem('st_bt18',JSON.stringify(_bs))}});
 var b=$('bGo');if(b)b.onclick=async function(){var r=await post('/api/backtest',{days:+$('bD').value,coins:+$('bC').value,costMult:+$('bM').value});if(r.ok)pollBt()}}
function pollBt(){fetch('/api/backtest').then(function(r){return r.json()}).then(function(d){bt=d;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}

function ckey(sym){return sym+'|'+chartTF}
function setTF(v){chartTF=v;chartFor='';if(S)renderMain()}
function tfBar(){return '<div class="frm"><button class="btn'+(chartTF==='tri'?'':' off')+'" onclick="setTF(\'tri\')">Üçgen 2H</button><button class="btn'+(chartTF==='15m'?'':' off')+'" onclick="setTF(\'15m\')">15m</button><button class="btn'+(chartTF==='5m'?'':' off')+'" onclick="setTF(\'5m\')">5m</button></div>'}
function curSig(){return sel&&sel.id?S.signals.find(function(x){return x.id===sel.id}):null}
function drawChart(d,s){
 var c=$('cv');if(!c||!d||!d.c.length)return;
 var W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 var x=c.getContext('2d');x.scale(dp,dp);
 var tri=(s&&s.tri)||d.tri,nc=d.c.length,n=nc+(tri?10:0);
 var L=8,R=86,T=12,B=20,PW=W-L-R,PH=H-T-B;
 var volH=70, priceH=PH-volH;
 var ti=function(t){return (t-d.c[0][0])/d.dur};
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 var lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.stop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']]:[];
 if(s&&(s.setup==='SC'||s.setup==='SW')&&s.level)lv.push([s.level,'#ffd400','SEVİYE']);
 var lp0=(sel&&sel.sym&&S.px&&S.px[sel.sym])||(s&&s.lastPrice)||d.c[nc-1][4];
 hi=Math.max(hi,lp0);lo=Math.min(lo,lp0);lv.forEach(function(a){hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});
 var tl=[];
 if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*priceH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';
 for(var i=0;i<=4;i++){var gy=T+priceH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 var line=function(arr,col,w){x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1;
 var vTop=priceH+40,vHeight=volH-20;
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';var h=(k[5]/vmax)*vHeight;x.fillStyle=col;x.globalAlpha=0.7;x.fillRect(X(i)-cw/2,vTop+vHeight-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#f2b84b';x.lineWidth=1.2;x.beginPath();var st=false;d.vsma.forEach(function(v,k){if(v==null||vmax<=0)return;var y=vTop+vHeight-(v/vmax)*vHeight;st?x.lineTo(X(k),y):(x.moveTo(X(k),y),st=true)});x.stroke()}
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText('Hacim (sarı = 20 mum ort.)',L+4,vTop+12);
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(function(l){x.strokeStyle='#ffd400';x.lineWidth=2.2;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='#ffd400';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),3,0,7);x.fill()});
  x.restore()}
 lv.forEach(function(a){x.strokeStyle=x.fillStyle=a[1];x.lineWidth=a[2]==='GİRİŞ'?2:1.3;x.setLineDash(a[2]==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.font='bold 10px system-ui';x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 x.strokeStyle='#fff';x.lineWidth=1.5;x.beginPath();x.moveTo(L,Y(lp0));x.lineTo(W-R,Y(lp0));x.stroke();x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp0)-9,66,18);x.fillStyle='#0c1117';x.font='bold 11px system-ui';x.fillText(fp(lp0),W-R+2,Y(lp0)+4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText((tri?tri.type+' • '+tri.touches+' dokunuş • ':'')+d.tf+' • sarı EMA21 • gri EMA50',L+4,H-5)}
function loadChart(sym){var tf=chartTF;fetch('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf).then(function(r){return r.json()}).then(function(d){chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym&&tf===chartTF&&$('cv'))drawChart(d,curSig())}).catch(function(){})}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.innerHTML=statView();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){var s=S.signals.find(function(x){return x.id===sel.id});if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[ckey(s.symbol)])drawChart(chartCache[ckey(s.symbol)],s);if(chartFor!==ckey(s.symbol)){chartFor=ckey(s.symbol);loadChart(s.symbol)}return}}
 if(sel&&sel.sym){
  var rTri=(S.radar||[]).find(function(x){return x.symbol===sel.sym});
  var rSc=(S.scRadar||[]).find(function(x){return x.symbol===sel.sym});
  var r=rTri||rSc,tagTxt='';
  if(rTri)tagTxt='<span class="tag lv">Üçgen yaklaşan</span>'+strTag(rTri.strength||0)+volTag(rTri.volX||0);
  else if(rSc)tagTxt='<span class="tag scl">'+(rSc.kind==='SW'?'Sweep adayı':'Kırılım adayı')+'</span>';
  M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2>'+(r?'<span class="tag w">'+esc(r.state)+'</span>'+tagTxt:'')+'<a class="btn tv" style="margin-left:auto" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval='+(chartTF==='5m'?5:120)+'" target="_blank">📈 TradingView</a></div>'+tfBar()+'<canvas id="cv"></canvas>'+calcBox('','');bindCalc();
  if(chartCache[ckey(sel.sym)])drawChart(chartCache[ckey(sel.sym)],null);
  if(chartFor!==ckey(sel.sym)){chartFor=ckey(sel.sym);loadChart(sel.sym)}return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){S=d;checkNew();$('dot').className='dot on';$('conn').textContent='Bağlı';var t=document.activeElement&&document.activeElement.tagName;if(t==='INPUT'||t==='SELECT'){renderTop();renderTabs();renderList()}else renderAll()}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)renderMain()});
setInterval(poll,3000);setInterval(function(){if(sel&&sel.sym)loadChart(sel.sym)},15000);poll();pollBt();
</script></body></html>`;

// ======================= HTTP =======================
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); });
const authed = u => !!ADMIN_KEY && u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v18.1', lastScan: scan.last, lastLive: live.last, lastScalp: scState.last, universe: universe.length, signals: signals.length,
            scOpen: signals.filter(s => isOpen(s) && s.setup === 'SC').length, swOpen: signals.filter(s => isOpen(s) && s.setup === 'SW').length, lvOpen: signals.filter(s => isOpen(s) && s.setup === 'LV').length,
            mktDir, triRadar: triRadar.length, scRadar: scRadar.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf')));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz (ADMIN_KEY gerekli)' });
            const b = await readBody(req);
            const days = [14, 30, 60].includes(b.days) ? b.days : 30, coins = [30, 60, 100].includes(b.coins) ? b.coins : 60;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1;
            if (!btJob.running) runBacktest(days, coins, { costMult });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz (ADMIN_KEY gerekli)' });
            signals = []; lastSig = {}; dirty = true; saveState();
            return json(res, 200, { ok: true });
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
        if (CFG.ENABLE_LIVE) setInterval(liveTick, CFG.LIVE_MS); else setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3);

        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan().then(() => scanScalp());
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);

        let scSlot = Math.floor((Date.now() - CFG.SC_DELAY_MS) / M5);
        if (CFG.ENABLE_SC || CFG.ENABLE_SW) setInterval(() => {
            const slot = Math.floor((Date.now() - CFG.SC_DELAY_MS) / M5);
            if (slot > scSlot && !scState.running) { scSlot = slot; scanScalp().catch(e => log('SC hata', e.message)); }
        }, 2000);

        log('SONER TRADE v18.1 hazır | LV üçgen ' + TRI.AGG + 'H ≥' + CFG.LV_VOL_SIG + 'x (15m teyitli, klasik yön dışı kapalı) | SC 5m Donchian' + CFG.SC_LOOK + ' hacim≥' + CFG.SC_MIN_VOLX + 'x | SW 5m ' + CFG.SW_LOOK + ' süpürme | piyasa modu ' + CFG.MKT_MODE);
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, scanScalp, track, refreshUniverse, apiState, liveTick, liveSignal, buildStruct, signalMsg, strengthScore, scStrength, swStrength, scalpCand, scalpBuild, swCand, swBuild, prepare, simulate, triBuild, buildSCRadar, refreshMktDir, grp, aggregateN, CFG, TRI };
