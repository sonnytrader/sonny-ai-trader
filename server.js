'use strict';
// AlphaSon v60.2 — TRF Trend + LT Üçgen + Fibonacci (Nihai Sürüm)
// - atrSeries eksikliği giderildi, Runtime hataları çözüldü.
// - Nötr piyasa filtresi esnetildi, stop gizlendi, Fibonacci TP1 & TP2 korundu.
// - Order Flow ve OI mekanizmaları muhafaza edildi.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

// ======================= SABİTLER =======================
const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BT_FILE = path.join(DATA_DIR, 'backtest.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UI_KEY = process.env.UI_KEY || '';
const M1 = 60e3, M5 = 5 * M1, M15 = 15 * M1, H1 = 3600e3, H2 = 2 * H1, H4 = 4 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const TRI_TF = (process.env.TRI_TF || '2h').toLowerCase();
const TRI_MS = TRI_TF === '2h' ? H2 : TRI_TF === '1h' ? H1 : M15;
const SCAN_MS = M15;
const BT_EX = ccxt[(process.env.BT_EXCHANGE || 'bitget').toLowerCase()] ? (process.env.BT_EXCHANGE || 'bitget').toLowerCase() : 'bitget';
const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

// ======================= AYARLAR =======================
const CFG_LT = {
    LOG: num('TRI_LOG', 0),
    TRI_K: num('TRI_LT_K', 3),
    TRI_LOOK: num('TRI_LT_LOOK', 200),
    TRI_MIN_LEN: num('TRI_LT_MIN_LEN', 20),
    TRI_MAX_LEN: num('TRI_LT_MAX_LEN', 300),
    TRI_TOL_ATR: num('TRI_LT_TOL_ATR', 0.40),
    TRI_WICK_ATR: num('TRI_LT_WICK_ATR', 1.50),
    TRI_CLOSE_ATR: num('TRI_LT_CLOSE_ATR', 0.35),
    TRI_MIN_TOUCH: num('TRI_LT_MIN_TOUCH', 5),
    TRI_LINE_TOUCH: num('TRI_LT_LINE_TOUCH', 3),
    TRI_TOUCH_SEP: num('TRI_LT_TOUCH_SEP', 4),
    TRI_SQUEEZE: num('TRI_LT_SQUEEZE', 0.88),
    TRI_FLAT: num('TRI_LT_FLAT', 0.10),
    TRI_MIN_W0_ATR: num('TRI_LT_MIN_W0_ATR', 2.5),
    TRI_MIN_MAT: num('TRI_LT_MIN_MAT', 0.45),
    TRI_BACK: num('TRI_LT_BACK', 3),
    TRI_MAX_APEX: num('TRI_LT_MAX_APEX', 500),
    TRI_MAX_MAT: num('TRI_LT_MAX_MAT', 0.98),
    TRI_FRESH: num('TRI_LT_FRESH', 150),
    TRI_CAND: num('TRI_LT_CAND', 10),
    GRACE_MIN: num('TRI_LT_GRACE_MIN', 90)
};
const HIST_NEED = CFG_LT.TRI_LOOK * 2 + 120;
const CFG = {
    UNIVERSE: num('UNIVERSE', 1500),
    MIN_VOL_USDT: num('MIN_VOL', 1e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 7),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 5),
    UNIVERSE_MS: 5 * 60e3, KEEP: 500, SCAN_DELAY_MS: 8000,
    NEAR_ATR: num('NEAR_ATR', 1.2), BRK_SEE: num('BRK_SEE', 3.0),
    FRESH_ENTRY_MIN: num('FRESH_ENTRY_MIN', 10),
    BRK_TP1_FIB: num('BRK_TP1_FIB', 1.618),
    BRK_TP2_FIB: num('BRK_TP2_FIB', 2.618),
    BRK_EXPIRE_H: num('BRK_EXPIRE_H', 72),
    BRK_COOLDOWN_H: num('BRK_COOLDOWN_H', 1),
    BRK_MIN_EXT: num('BRK_MIN_EXT', 0.10), BRK_MAX_EXT: num('BRK_MAX_EXT', 99.0),
    BRK_MIN_VOL: num('BRK_MIN_VOL', 1.5),
    BRK_RETEST: 0,
    MIN_STRENGTH: num('MIN_STRENGTH', 40), MAX_COST_R: num('MAX_COST_R', 0.8),
    MIN_SIG_VOL: num('MIN_SIG_VOL', 1e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 10.0),
    LATE_EXT: num('LATE_EXT', 0.8), LT_TRAIL_R: num('LT_TRAIL_R', 1.5), LT_MAX_DIR: num('LT_MAX_DIR', 0),
    LT_SHADOW: num('LT_SHADOW', 1), MKT_BLOCK_TH: num('MKT_BLOCK_TH', 35), DAY_LOSS_R: num('DAY_LOSS_R', 4), MAX_DIR_TOTAL: num('MAX_DIR_TOTAL', 4)
};
const TR = { ON: num('TR_ON', 1), MIN_VOL: num('TR_MIN_VOL', 1e6), TOP: num('TR_TOP', 400), NOTIFY: num('TR_NOTIFY', 50), MAX_COST_R: num('TR_MAX_COST_R', 0.5), MAX_OPEN: num('TR_MAX_OPEN', 15), KEEP: 300, TG: num('TR_TG', 1) };
const TREND = { ON: num('TREND_ON', 1), TOP: num('TREND_TOP', 1500), MIN_VOL: num('TREND_MIN_VOL', 1e6),
    TP1_FIB: num('TREND_TP1_FIB', 1.618), TP2_FIB: num('TREND_TP2_FIB', 2.618),
    COOLDOWN_H: num('TREND_COOLDOWN_H', 2), MAX_PER_SCAN: num('TREND_MAX_PER_SCAN', 3), FRESH_MIN: num('TREND_FRESH_MIN', 30), WINDOW_MIN: num('TREND_WINDOW_MIN', 40), BTC: num('TREND_BTC', 0),
    MAX_DIR: num('TREND_MAX_DIR', 3), TF: (process.env.TREND_TF || '15m').toLowerCase() };
const TREND_MS = TREND.TF === '5m' ? M5 : TREND.TF === '15m' ? M15 : TREND.TF === '1h' ? H1 : H4;
const OF = { GATE: num('OF_GATE', 1), WIN_MIN: num('OF_WIN_MIN', 15), TRADES: num('OF_TRADES', 500), MIN_N: num('OF_MIN_N', 40), MIN_DELTA: num('OF_MIN_DELTA', 0.05), BOOK_LEVELS: num('OF_BOOK_LEVELS', 20), BLOCK_IMB: num('OF_BLOCK_IMB', -0.35) };
const TRF = { PER1: num('TRF_PER1', 27), MULT1: num('TRF_MULT1', 1.6), PER2: num('TRF_PER2', 55), MULT2: num('TRF_MULT2', 2.0) };

const log = (...a) => console.log('[ALPHASON]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const flatRatio = c => { const a = c.slice(-48); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const hasGap = (c, ms, n) => { const a = c.slice(-n); for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] !== ms) return true; return false; };
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isOpen = s => s.status === 'OPEN' || s.status === 'TP1';
const r2 = x => Number((Number(x) || 0).toFixed(3));
const atrMean = (c, p = 14) => { if (c.length <= p) return 0; let s = 0; for (let i = c.length - p; i < c.length; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const atrAt = (c, n, p = 14) => { let s = 0; for (let i = n - p + 1; i <= n; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const atrSeries = (c, p = 14) => {
    const o = new Array(c.length).fill(null);
    if (c.length < p) return o;
    let s = 0;
    for (let i = 0; i < c.length; i++) {
        const tr = i === 0 ? c[i][2] - c[i][3] : Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
        s += tr;
        if (i >= p) {
            const prevTr = i - p === 0 ? c[0][2] - c[0][3] : Math.max(c[i - p][2] - c[i - p][3], Math.abs(c[i - p][2] - c[i - p - 1][4]), Math.abs(c[i - p][3] - c[i - p - 1][4]));
            s -= prevTr;
        }
        if (i >= p - 1) o[i] = s / p;
    }
    return o;
};
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));
const clOf = a => a.map(x => x[4]);

// trendScore for htfDir (restored)
function trendScore(c) { const cl = c.map(x => x[4]), e21 = emaN(cl, 21), e50 = emaN(cl, 50), n = cl.length - 1; const a = atrMean(c, 14) || 1e-9; return 0.4 * Math.tanh((cl[n] - e50[n]) / a / 2) + 0.3 * Math.tanh((e21[n] - e50[n]) / a) + 0.3 * Math.tanh((e21[n] - e21[n - 3]) / a * 2); }

// ======================= OHLCV =======================
const REQ_QUEUE = { next: 0, minGap: num('REQ_GAP_MS', 120) };
async function throttle() { const now = Date.now(), at = Math.max(now, REQ_QUEUE.next); REQ_QUEUE.next = at + REQ_QUEUE.minGap; if (at > now) await sleep(at - now); }
async function safeFetch(ex, sym, tf, limit, since) {
    let attempt = 0;
    while (attempt < 3) {
        await throttle();
        try { return await ex.fetchOHLCV(sym, tf, since, limit); }
        catch (e) {
            const msg = String(e.message || e);
            if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
                attempt++; const backoff = 2000 * Math.pow(2, attempt - 1);
                REQ_QUEUE.next = Math.max(REQ_QUEUE.next, Date.now() + backoff);
                await sleep(backoff);
            } else throw e;
        }
    }
    throw new Error('Rate limit: ' + sym);
}
let exUI = null;
async function uiFetch(sym, tf, limit) {
    if (!exUI) { exUI = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } }); try { exUI.setMarkets(ex.markets); } catch (e) { await exUI.loadMarkets(); } }
    try { return await exUI.fetchOHLCV(sym, tf, undefined, limit); }
    catch (e) { return await safeFetch(ex, sym, tf, limit); }
}
function aggregateN(c, baseMs, n) { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }
function fillGaps(c, ms, maxFill = 3) {
    if (!c || !c.length) return c || [];
    let out = [c[0]];
    for (let i = 1; i < c.length; i++) {
        const prev = out.length ? out[out.length - 1] : null;
        const gap = prev ? Math.round((c[i][0] - prev[0]) / ms) : 1;
        if (prev && gap > 1) {
            if (gap - 1 > maxFill) out = [];
            else for (let k = 1; k < gap; k++) { const p = prev[4]; out.push([prev[0] + k * ms, p, p, p, p, 0]); }
        }
        out.push(c[i]);
    }
    return out;
}
function mergeC(a, b) { const m = new Map(); for (const x of a) m.set(x[0], x); for (const x of b) m.set(x[0], x); return [...m.values()].sort((p, q) => p[0] - q[0]); }
const histCache = new Map(), histInflight = new Map();
async function getHist1h(sym, need) {
    if (histInflight.has(sym)) return histInflight.get(sym);
    const job = getHist1hRaw(sym, need);
    histInflight.set(sym, job);
    try { return await job; } finally { histInflight.delete(sym); }
}
async function getHist1hRaw(sym, need) {
    const now = Date.now(); let h = histCache.get(sym);
    if (!h || !h.c.length) {
        const want0 = now - need * H1;
        let since = want0, out = [];
        for (let g = 0; g < 25; g++) {
            const r = await safeFetch(ex, sym, '1h', 1000, since);
            if (!r || !r.length) break;
            out = out.concat(r);
            const lt = r[r.length - 1][0];
            if (lt >= now - 2 * H1 || lt < since) break;
            since = lt + H1;
        }
        h = { c: closedOnly(mergeC([], out), H1, now), t: now };
    } else {
        const since = h.c[h.c.length - 1][0] - 2 * H1;
        const r = await safeFetch(ex, sym, '1h', 100, since);
        h.c = closedOnly(mergeC(h.c, r || []), H1, now); h.t = now;
    }
    const cap = need + 300; if (h.c.length > cap) h.c = h.c.slice(-cap);
    histCache.set(sym, h);
    return h.c;
}
function emaN(v, p) { const o = new Array(v.length).fill(null); let s0 = 0; while (s0 < v.length && v[s0] == null) s0++; if (v.length - s0 < p) return o; let e = 0; for (let i = s0; i < s0 + p; i++) e += v[i]; e /= p; o[s0 + p - 1] = e; const k = 2 / (p + 1); for (let i = s0 + p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }

// ======================= TWIN RANGE FILTER (TRF) =======================
function smoothrng(src, t, m) {
    const wper = t * 2 - 1;
    const absDiff = src.map((v, i) => i === 0 ? 0 : Math.abs(v - src[i - 1]));
    const avrng = emaN(absDiff, t);
    const smrng = emaN(avrng, wper);
    return smrng.map(v => v == null ? null : v * m);
}

function rngfilt(src, r) {
    const res = new Array(src.length).fill(null);
    for (let i = 0; i < src.length; i++) {
        if (r[i] == null || src[i] == null) continue;
        if (i === 0) { res[i] = src[i]; continue; }
        if (src[i] > res[i - 1]) {
            res[i] = src[i] - r[i] < res[i - 1] ? res[i - 1] : src[i] - r[i];
        } else if (src[i] + r[i] > res[i - 1]) {
            res[i] = res[i - 1];
        } else {
            res[i] = src[i] + r[i];
        }
    }
    return res;
}

function trfSeries(c) {
    const src = c.map(x => x[4]);
    if (src.length < TRF.PER2 + 10) return { dir: new Array(src.length).fill(0), filt: new Array(src.length).fill(null) };
    
    const smrng1 = smoothrng(src, TRF.PER1, TRF.MULT1);
    const smrng2 = smoothrng(src, TRF.PER2, TRF.MULT2);
    const smrng = smrng1.map((v, i) => v != null && smrng2[i] != null ? (v + smrng2[i]) / 2 : null);
    
    const filt = rngfilt(src, smrng);
    const dir = new Array(src.length).fill(0);
    
    let upward = 0, downward = 0;
    for (let i = 1; i < src.length; i++) {
        if (filt[i] == null || filt[i-1] == null) continue;
        
        if (filt[i] > filt[i - 1]) { upward = (dir[i-1] === 1 ? upward : 0) + 1; downward = 0; }
        else if (filt[i] < filt[i - 1]) { downward = (dir[i-1] === -1 ? downward : 0) + 1; upward = 0; }
        
        const longCond = (src[i] > filt[i] && src[i] > src[i - 1] && upward > 0) || (src[i] > filt[i] && src[i] < src[i - 1] && upward > 0);
        const shortCond = (src[i] < filt[i] && src[i] < src[i - 1] && downward > 0) || (src[i] < filt[i] && src[i] > src[i - 1] && downward > 0);
        
        if (longCond) dir[i] = 1;
        else if (shortCond) dir[i] = -1;
        else dir[i] = dir[i - 1];
    }
    return { dir, filt };
}

// ======================= PİYASA YÖNÜ =======================
let MKT_DIR = 'NÖTR'; 
let mktLastUpdate = 0;

async function updateMarketDirection() {
    try {
        const now = Date.now();
        if (now - mktLastUpdate < 60e3) return;
        const [btcC, ethC] = await Promise.all([
            safeFetch(ex, BTC, '15m', 100),
            safeFetch(ex, ETH, '15m', 100)
        ]);
        
        let bDir = 0, eDir = 0;
        if (btcC && btcC.length > 60) {
            const cl = fillGaps(btcC.filter(x => x[0] + M15 <= now), M15);
            if(cl.length > 60) { const trf = trfSeries(cl); bDir = trf.dir[cl.length-1] || 0; }
        }
        if (ethC && ethC.length > 60) {
            const cl = fillGaps(ethC.filter(x => x[0] + M15 <= now), M15);
            if(cl.length > 60) { const trf = trfSeries(cl); eDir = trf.dir[cl.length-1] || 0; }
        }

        if (bDir === 1 && eDir === 1) MKT_DIR = 'LONG';
        else if (bDir === -1 && eDir === -1) MKT_DIR = 'SHORT';
        else MKT_DIR = 'NÖTR';
        
        mktLastUpdate = now;
    } catch(e) {}
}

// ======================= ORDER FLOW & OI =======================
const ofCache = new Map();
async function getFlowData(sym) {
    const now = Date.now(), hit = ofCache.get(sym);
    if (hit && now - hit.t < 20e3) return hit.d;
    let d = null;
    try {
        await throttle();
        const trades = await ex.fetchTrades(sym, undefined, OF.TRADES);
        const from = now - OF.WIN_MIN * M1;
        let buyVol = 0, sellVol = 0, n = 0;
        for (const t of trades || []) {
            if (!t || !(t.timestamp >= from)) continue;
            const v = Number(t.cost) || (Number(t.price) * Number(t.amount)) || 0;
            if (t.side === 'buy') buyVol += v; else if (t.side === 'sell') sellVol += v; else continue;
            n++;
        }
        await throttle();
        const ob = await ex.fetchOrderBook(sym, OF.BOOK_LEVELS);
        let bidVol = 0, askVol = 0;
        for (const q of (ob.bids || []).slice(0, OF.BOOK_LEVELS)) bidVol += q[0] * q[1];
        for (const q of (ob.asks || []).slice(0, OF.BOOK_LEVELS)) askVol += q[0] * q[1];
        const total = buyVol + sellVol;
        
        let oi = null;
        try {
            const oiData = await ex.fetchOpenInterest(sym);
            if (oiData) oi = oiData.openInterestAmount;
        } catch(e) {}

        d = { n, takerBuyRatio: total > 0 ? buyVol / total : 0.5, obImbalance: (bidVol + askVol) > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0, oi, t: now };
    } catch (e) { d = null; }
    ofCache.set(sym, { t: now, d });
    return d;
}

// ======================= ÜÇGEN (Simetrik) =======================
function pivots(c, end, K, from) { const hi = [], lo = []; for (let i = Math.max(K, from); i <= end - K; i++) { let isH = true, isL = true; for (let d = 1; d <= K && (isH || isL); d++) { if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false; if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false; } if (isH) hi.push({ i, p: c[i][2] }); if (isL) lo.push({ i, p: c[i][3] }); } return { hi, lo }; }
function fitLines(pts, c, end, atrA, side, C, prevKey, maxC) {
    if (!pts || pts.length < 2) return [];
    const aEnd = atrA[end], all = [];
    for (let a = 0; a < pts.length - 1; a++) {
        for (let b = a + 1; b < pts.length; b++) {
            const A = pts[a], B = pts[b], len = B.i - A.i;
            if (len < 15) continue;
            const s = (B.p - A.p) / len;
            let ok = true, touches = 0, lastT = -1e9, devSum = 0; const inl = [];
            for (let q = a; q < pts.length; q++) {
                const p = pts[q];
                const lp = A.p + s * (p.i - A.i), at = atrA[p.i] || aEnd;
                const gap = side * (p.p - lp);
                if (gap > C.TRI_TOL_ATR * at * 2) { ok = false; break; }
                if (Math.abs(gap) <= C.TRI_TOL_ATR * at) {
                    inl.push(p);
                    if (p.i - lastT >= C.TRI_TOUCH_SEP) { touches++; lastT = p.i; devSum += Math.abs(gap) / at; }
                }
            }
            if (!ok || touches < C.TRI_LINE_TOUCH) continue;
            if (end - lastT > C.TRI_FRESH) continue;
            let cok = true;
            for (let x = A.i; x <= end; x++) {
                const lp = A.p + s * (x - A.i), at = atrA[x] || aEnd;
                if (side === 1) { if (c[x][4] > lp + C.TRI_CLOSE_ATR * at || c[x][2] > lp + C.TRI_WICK_ATR * at) { cok = false; break; } }
                else { if (c[x][4] < lp - C.TRI_CLOSE_ATR * at || c[x][3] < lp - C.TRI_WICK_ATR * at) { cok = false; break; } }
            }
            if (!cok) continue;
            const dev = devSum / touches;
            let score = Math.log(len) * 40 + touches * 40 - dev * 15 - (end - lastT) * 0.3;
            if (prevKey) { if (prevKey[0] === c[A.i][0]) score += 40; if (prevKey[1] === c[B.i][0]) score += 40; }
            all.push({ i0: A.i, p0: A.p, s, sn: s / aEnd, touches, last: lastT, score, dev, pts: inl, t0: c[A.i][0], t1: c[B.i][0] });
        }
    }
    all.sort((x, y) => y.score - x.score);
    const out = [];
    for (const L of all) { if (out.every(o => Math.abs(o.sn - L.sn) > 0.005)) { out.push(L); if (out.length >= maxC) break; } }
    return out;
}
const triDiag = {};
let triMute = false, triLast = null;
function triRej(k) { if (!triMute) triDiag[k] = (triDiag[k] || 0) + 1; return null; }
const TRI_GATES = ['toplamDokunus', 'uzunluk', 'genislikNegatif', 'konverjansYok', 'daralmaYetersiz', 'cokDar', 'yukseklikAz', 'apeksUzak', 'olgunluk', 'yasakliTip'];
function evalPair(end, atr, atrP, C, R, S) {
    const rej = (g, o) => Object.assign({ ok: false, g, rank: TRI_GATES.indexOf(g), tc: R.touches + S.touches }, o);
    if (R.touches + S.touches < C.TRI_MIN_TOUCH) return rej('toplamDokunus');
    const xs = Math.max(R.i0, S.i0), len = end - xs;
    if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return rej('uzunluk');
    const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0);
    const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
    if (!(w0 > 0 && wN > 0)) return rej('genislikNegatif');
    const sq = wN / w0, dsl = S.s - R.s;
    if (!(dsl > 0)) return rej('konverjansYok', { sq });
    if (sq > C.TRI_SQUEEZE) return rej('daralmaYetersiz', { sq });
    if (wN < 0.4 * atr) return rej('cokDar', { sq });
    if (w0 < C.TRI_MIN_W0_ATR * atr) return rej('yukseklikAz', { sq });
    const apex = end + wN / dsl; if (apex - end > (C.TRI_MAX_APEX || 300)) return rej('apeksUzak', { sq });
    const mat = (end - xs) / (apex - xs);
    if (mat < C.TRI_MIN_MAT || mat > C.TRI_MAX_MAT) return rej('olgunluk', { sq, mat });
    const flatTol = C.TRI_FLAT * w0 / len;
    if (!(R.s < -flatTol && S.s > flatTol)) return rej('yasakliTip', { sq, mat });
    const type = 'Simetrik';
    const pscore = R.score + S.score + (1 - sq) * 150 - Math.abs(R.i0 - S.i0) * 0.1;
    return { ok: true, pscore, tri: { type, end, atr: atrP, atrLog: atr, w0: w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: sq, mat, keys: { R: [R.t0, R.t1], S: [S.t0, S.t1] } } };
}
function detectTriangle(c, end, C, prevKeys) {
    triLast = null;
    if (end < 60) return triRej('kisaVeri');
    const lc = c.slice(0, end + 1);
    const atrA = atrSeries(lc, 14), atr = atrA[end]; if (!(atr > 0)) return triRej('atrYok');
    const atrP = atrSeries(c.slice(0, end + 1), 14)[end]; if (!(atrP > 0)) return triRej('atrFiyatYok');
    const pv = pivots(lc, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
    if (pv.hi.length < 2 || pv.lo.length < 2) return triRej('pivotYetersiz');
    const mc = C.TRI_CAND || 8;
    const Rs = fitLines(pv.hi, lc, end, atrA, 1, C, prevKeys && prevKeys.R, mc);
    const Ss = fitLines(pv.lo, lc, end, atrA, -1, C, prevKeys && prevKeys.S, mc);
    if (!Rs.length || !Ss.length) return triRej('cizgiBulunamadi');
    let best = null, worst = null, anyConv = false;
    for (const R of Rs) for (const S of Ss) {
        if (S.s > R.s) anyConv = true;
        const r = evalPair(end, atr, atrP, C, R, S);
        if (r.ok) { if (!best || r.pscore > best.pscore) best = r; }
        else if (!worst || r.rank > worst.rank || (r.rank === worst.rank && (r.sq == null ? 9 : r.sq) < (worst.sq == null ? 9 : worst.sq))) worst = r;
    }
    if (!triMute) { const ck = anyConv ? '_konvVar' : '_konvYok'; triDiag[ck] = (triDiag[ck] || 0) + 1; }
    if (!best) { triLast = worst; return triRej(worst.g); }
    if (!triMute) triDiag.OK = (triDiag.OK || 0) + 1;
    return best.tri;
}
function htfDir(c2) {
    try { const c4 = aggregateN(c2, H2, 2); if (c4.length < 60) return 0; const s = trendScore(c4); return s > 0.15 ? 1 : s < -0.15 ? -1 : 0; } catch (e) { return 0; }
}
function pack(tri, c, ms) {
    const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * (ms || TRI_MS);
    const xEnd = tri.end + 30;
    const seg = L => [[tOf(L.i0), L.p0], [tOf(xEnd), L.p0 + L.s * (xEnd - L.i0)]];
    return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), mat: Number(tri.mat.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0, res: seg(tri.R), sup: seg(tri.S), hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
}

// ======================= TREND TAKİP (TRF) =======================
const trendRun = { running: false, lastBar: 0, last: 0, ms: 0, dg: null, retryAt: 0, tryBar: 0, tries: 0 };
function trendEval(c, n, entry, vol24, btcD, isBtc, htf4hDir, mktDir) {
    if (n < 100) return { skip: 'short' };
    
    const trf = trfSeries(c.slice(0, n + 1));
    if (!trf || !trf.dir[n] || trf.filt[n] == null) return { skip: 'short' };
    const L = trf.dir[n];
    
    // Nötr piyasada da koşulları sağlayan işlemlerin üretilmesine izin verilir (mktNotr filtresi kaldırıldı, yön uyumu korunur)
    if (mktDir !== 'NÖTR') {
        const mktL = mktDir === 'LONG' ? 1 : -1;
        if (L !== mktL) return { skip: 'mktTers' };
    }

    const atr = atrAt(c, n, 14);
    if (!(atr > 0)) return { skip: 'short' };
    
    const stop = trf.filt[n]; 
    const riskAbs = Math.abs(entry - stop);
    if (!(riskAbs > 0)) return { skip: 'risk' };
    
    const swing = c.slice(n - 20, n + 1);
    const swingHigh = Math.max(...swing.map(x => x[2]));
    const swingLow = Math.min(...swing.map(x => x[3]));
    const wave = swingHigh - swingLow;
    
    const tp1 = L === 1 ? entry + (wave * TREND.TP1_FIB) : entry - (wave * TREND.TP1_FIB);
    const tp2 = L === 1 ? entry + (wave * TREND.TP2_FIB) : entry - (wave * TREND.TP2_FIB);
    
    let av = 0; for (let i = n - 20; i < n; i++) av += c[i][5]; av /= 20;
    const volX = av > 0 ? c[n][5] / av : 1;
    const score = Math.round(Math.min(100, 70 + (volX >= 1.5 ? 15 : 0)));
    
    return { cand: { dir: L === 1 ? 'LONG' : 'SHORT', score, entry, stop, riskAbs, riskPct: r2(riskAbs/entry*100), tp1, tp2, tp1R: TREND.TP1_FIB, tp2R: TREND.TP2_FIB, atr, volX, adx: 0, candleT: c[n][0] } };
}

function buildTREND(sym, cd, time) {
    return {
        id: 'TREND_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT,
        symbol: sym,
        base: baseOf(sym),
        dir: cd.dir,
        strategy: 'TREND',
        setup: 'TREND',
        setupName: 'TRF Trend (' + TREND.TF + ')',
        entry: cd.entry,
        stop: cd.stop,
        initialStop: cd.stop,
        tp1: cd.tp1,
        tp2: cd.tp2,
        tp1R: cd.tp1R,
        tp2R: cd.tp2R,
        riskAbs: cd.riskAbs,
        riskPct: cd.riskPct,
        atr: cd.atr,
        score: cd.score,
        time: time || Date.now(),
        status: 'OPEN'
    };
}

// ======================= SUNUCU VE BAŞLANGIÇ =======================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', version: '60.2', market: MKT_DIR }));
});

async function init() {
    try {
        global.ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
        await ex.loadMarkets();
        log('PORT', PORT);
        log('temiz başlangıç.');
        server.listen(PORT, () => log('AlphaSon v60.2 çalışıyor.'));
        setInterval(updateMarketDirection, 60e3);
        updateMarketDirection();
    } catch (e) {
        log('INIT ERROR:', e.message);
    }
}

init();
