'use strict';
// AlphaSon v59.5 — BTC/ETH 15m Piyasa Yönlü PMax + LT Üçgen (Tam Sürüm)
// - Piyasa Yönü: BTC 15m PMax ve ETH 15m PMax aynı yönü gösteriyorsa o yön, çelişiyorsa NÖTR.
// - Sinyal Filtresi: Piyasa LONG ise sadece LONG, SHORT ise sadece SHORT.

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
    TRI_LOOK: num('TRI_LT_LOOK', 650),
    TRI_MIN_LEN: num('TRI_LT_MIN_LEN', 40),
    TRI_MAX_LEN: num('TRI_LT_MAX_LEN', 900),
    TRI_TOL_ATR: num('TRI_LT_TOL_ATR', 0.60),
    TRI_WICK_ATR: num('TRI_LT_WICK_ATR', 1.50),
    TRI_CLOSE_ATR: num('TRI_LT_CLOSE_ATR', 0.35),
    TRI_MIN_TOUCH: num('TRI_LT_MIN_TOUCH', 5),
    TRI_LINE_TOUCH: num('TRI_LT_LINE_TOUCH', 3),
    TRI_TOUCH_SEP: num('TRI_LT_TOUCH_SEP', 6),
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
    STOP_ATR15: num('STOP_ATR15', 2.5), STOP_LINE_ATR2H: num('STOP_LINE_ATR2H', 0.8), STOP_MIN_PCT: num('STOP_MIN_PCT', 1.5),
    BRK_TP1_R: num('BRK_TP1_R', 2.0), BRK_EXPIRE_H: num('BRK_EXPIRE_H', 72),
    BRK_COOLDOWN_H: num('BRK_COOLDOWN_H', 1),
    BRK_MIN_EXT: num('BRK_MIN_EXT', 0.10), BRK_MAX_EXT: num('BRK_MAX_EXT', 99.0),
    BRK_MIN_VOL: num('BRK_MIN_VOL', 1.2), BRK_MAX_VOL: num('BRK_MAX_VOL', 0), BRK_CLOSE_CONFIRM: num('BRK_CLOSE_CONFIRM', 0),
    BRK_RETEST: num('BRK_RETEST', 1), BRK_RETEST_MAX: num('BRK_RETEST_MAX', 0.4), BRK_RETEST_PIERCE: num('BRK_RETEST_PIERCE', 0.1),
    BRK_HTF: num('BRK_HTF', 0), BRK_BTC: num('BRK_BTC', 0), BTC_PEN: num('BTC_PEN', 0),
    MIN_RR: num('MIN_RR', 1.5), MAX_TP2R: num('MAX_TP2R', 8),
    MIN_STRENGTH: num('MIN_STRENGTH', 40), MAX_COST_R: num('MAX_COST_R', 0.8),
    MIN_SIG_VOL: num('MIN_SIG_VOL', 1e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 10.0),
    TRAIL_R: num('TRAIL_R', 1.5), RAW_BREAK_MIN_ATR: num('RAW_BREAK_MIN_ATR', 0.05),
    LATE_EXT: num('LATE_EXT', 0.8), LT_TRAIL_R: num('LT_TRAIL_R', 1.5), LT_MAX_DIR: num('LT_MAX_DIR', 0),
    LT_SHADOW: num('LT_SHADOW', 1), MKT_BLOCK_TH: num('MKT_BLOCK_TH', 35), DAY_LOSS_R: num('DAY_LOSS_R', 4), MAX_DIR_TOTAL: num('MAX_DIR_TOTAL', 4)
};
const TR = { ON: num('TR_ON', 1), MIN_VOL: num('TR_MIN_VOL', 1e6), TOP: num('TR_TOP', 400), NOTIFY: num('TR_NOTIFY', 50), MAX_COST_R: num('TR_MAX_COST_R', 0.5), MAX_OPEN: num('TR_MAX_OPEN', 15), KEEP: 300, TG: num('TR_TG', 1) };
const TREND = { ON: num('TREND_ON', 1), TOP: num('TREND_TOP', 1500), MIN_VOL: num('TREND_MIN_VOL', 1e6), ADX_MIN: num('TREND_ADX_MIN', 18), PMAX: num('TREND_PMAX', 1),
    MIN_RISK_PCT: num('TREND_MIN_RISK_PCT', 2.0), MAX_RISK_PCT: num('TREND_MAX_RISK_PCT', 10), MAX_COST_R: num('TREND_MAX_COST_R', 0.2),
    TP1_R: num('TREND_TP1_R', 2.0), TRAIL_ATR: num('TREND_TRAIL_ATR', 2.5), MAX_HOLD: num('TREND_MAX_HOLD_H', 120) * H1,
    COOLDOWN_H: num('TREND_COOLDOWN_H', 2), MAX_PER_SCAN: num('TREND_MAX_PER_SCAN', 3), FRESH_MIN: num('TREND_FRESH_MIN', 30), WINDOW_MIN: num('TREND_WINDOW_MIN', 40), BTC: num('TREND_BTC', 0),
    MAX_DIR: num('TREND_MAX_DIR', 3), FLIP_BARS: num('TREND_FLIP_BARS', 0),
    HTF_FILTER: num('TREND_HTF_FILTER', 1), HTF_TF: num('TREND_HTF_TF', 4), HTF_CACHE_MIN: num('TREND_HTF_CACHE_MIN', 5),
    TF: (process.env.TREND_TF || '15m').toLowerCase() };
const TREND_MS = TREND.TF === '5m' ? M5 : TREND.TF === '15m' ? M15 : TREND.TF === '1h' ? H1 : H4;
const BIAS_TH = num('BIAS_TH', 15);
const PMAX_LEN = num('PMAX_LEN', 10);
const PMAX_ATR = num('PMAX_ATR', 10);
const PMAX_MULT = num('PMAX_MULT', 3.0);
const OF = { GATE: num('OF_GATE', 1), WIN_MIN: num('OF_WIN_MIN', 15), TRADES: num('OF_TRADES', 500), MIN_N: num('OF_MIN_N', 40), MIN_DELTA: num('OF_MIN_DELTA', 0.05), BOOK_LEVELS: num('OF_BOOK_LEVELS', 20), BLOCK_IMB: num('OF_BLOCK_IMB', -0.35) };

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
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));
const clOf = a => a.map(x => x[4]);

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
function rmaN(v, p) { const o = new Array(v.length).fill(null); let s0 = 0; while (s0 < v.length && v[s0] == null) s0++; if (v.length - s0 < p) return o; let e = 0; for (let i = s0; i < s0 + p; i++) e += v[i]; e /= p; o[s0 + p - 1] = e; for (let i = s0 + p; i < v.length; i++) { e = (e * (p - 1) + v[i]) / p; o[i] = e; } return o; }
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }

// ======================= PİYASA YÖNÜ (BTC/ETH 15M) =======================
let MKT_DIR = 'NÖTR'; 
let mktLastUpdate = 0;
let mktBtcDir = 0, mktEthDir = 0;

async function updateMarketDirection() {
    try {
        const now = Date.now();
        if (now - mktLastUpdate < 60e3) return;
        const [btcC, ethC] = await Promise.all([
            safeFetch(ex, BTC, '15m', 100),
            safeFetch(ex, ETH, '15m', 100)
        ]);
        
        let bDir = 0, eDir = 0;
        if (btcC && btcC.length > 30) {
            const cl = fillGaps(btcC.filter(x => x[0] + M15 <= now), M15);
            if(cl.length > 30) { const pm = pmaxSeries(cl, PMAX_ATR, PMAX_MULT, PMAX_LEN); bDir = pm.dir[cl.length-1] || 0; }
        }
        if (ethC && ethC.length > 30) {
            const cl = fillGaps(ethC.filter(x => x[0] + M15 <= now), M15);
            if(cl.length > 30) { const pm = pmaxSeries(cl, PMAX_ATR, PMAX_MULT, PMAX_LEN); eDir = pm.dir[cl.length-1] || 0; }
        }

        mktBtcDir = bDir; mktEthDir = eDir;

        if (bDir === 1 && eDir === 1) MKT_DIR = 'LONG';
        else if (bDir === -1 && eDir === -1) MKT_DIR = 'SHORT';
        else MKT_DIR = 'NÖTR';

        mktLastUpdate = now;
    } catch(e) {}
}

// ======================= PMAX & ORDER FLOW =======================
function pmaxSeries(c, atrLen, mult, maLen) {
    const n = c.length, ma = emaN(c.map(x => (x[2] + x[3]) / 2), maLen), atr = atrSeries(c, atrLen);
    const dir = new Array(n).fill(0), pm = new Array(n).fill(null);
    let ls = null, ss = null, d = 1;
    for (let i = 0; i < n; i++) {
        if (ma[i] == null || atr[i] == null) continue;
        const lsPrev = ls == null ? ma[i] - mult * atr[i] : ls, ssPrev = ss == null ? ma[i] + mult * atr[i] : ss;
        let nl = ma[i] - mult * atr[i], ns = ma[i] + mult * atr[i];
        if (ma[i] > lsPrev) nl = Math.max(nl, lsPrev);
        if (ma[i] < ssPrev) ns = Math.min(ns, ssPrev);
        if (d === -1 && ma[i] > ssPrev) d = 1; else if (d === 1 && ma[i] < lsPrev) d = -1;
        ls = nl; ss = ns; dir[i] = d; pm[i] = d === 1 ? nl : ns;
    }
    return { dir, pm, ma };
}
const htfPmaxCache = new Map();
async function getHtfPmax(sym) {
    const now = Date.now(), hit = htfPmaxCache.get(sym);
    if (hit && now - hit.t < TREND.HTF_CACHE_MIN * 60e3) return hit.dir;
    try {
        const tf = TREND.HTF_TF === 4 ? '4h' : TREND.HTF_TF === 1 ? '1h' : '2h';
        const tfMs = tf === '4h' ? H4 : tf === '1h' ? H1 : H2;
        const raw = await safeFetch(ex, sym, tf, 200);
        if (!raw || raw.length < 30) { htfPmaxCache.set(sym, { t: now, dir: 0 }); return 0; }
        const cl = fillGaps(raw.filter(x => x[0] + tfMs <= now), tfMs);
        if (cl.length < 20) { htfPmaxCache.set(sym, { t: now, dir: 0 }); return 0; }
        const pm = pmaxSeries(cl, PMAX_ATR, PMAX_MULT, PMAX_LEN);
        const dir = pm.dir[cl.length - 1] || 0;
        htfPmaxCache.set(sym, { t: now, dir });
        return dir;
    } catch (e) {
        htfPmaxCache.set(sym, { t: now, dir: 0 });
        return 0;
    }
}
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
        d = { n, takerBuyRatio: total > 0 ? buyVol / total : 0.5, obImbalance: (bidVol + askVol) > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0, t: now };
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

// ======================= TREND TAKİP (PMax + HTF) =======================
const trendRun = { running: false, lastBar: 0, last: 0, ms: 0, dg: null, retryAt: 0, tryBar: 0, tries: 0 };
function trendEval(c, n, entry, vol24, btcD, isBtc, htf4hDir, mktDir) {
    if (n < 100) return { skip: 'short' };
    
    if (mktDir === 'NÖTR') return { skip: 'mktNotr' };
    
    const pm = pmaxSeries(c.slice(0, n + 1), PMAX_ATR, PMAX_MULT, PMAX_LEN);
    if (!pm || !pm.dir[n] || pm.pm[n] == null || pm.ma[n] == null) return { skip: 'short' };
    const L = pm.dir[n];
    
    const mktL = mktDir === 'LONG' ? 1 : -1;
    if (L !== mktL) return { skip: 'mktTers' };

    if (TREND.HTF_FILTER && htf4hDir != null && htf4hDir !== 0 && htf4hDir !== L) return { skip: 'htfTers' };
    
    const atr = atrAt(c, n, 14);
    if (!(atr > 0)) return { skip: 'short' };
    
    if (L * (entry - pm.ma[n]) / atr > 1.0) return { skip: 'chase' };
    
    const stop = pm.pm[n];
    const riskAbs = L * (entry - stop);
    if (!(riskAbs > 0)) return { skip: 'risk' };
    const riskPct = riskAbs / entry * 100;
    if (riskPct < TREND.MIN_RISK_PCT || riskPct > TREND.MAX_RISK_PCT) return { skip: 'risk' };
    const costR = (costFor(vol24) + 2 * CFG.SLIP_PCT) / riskPct;
    if (costR > TREND.MAX_COST_R) return { skip: 'cost' };
    
    let av = 0; for (let i = n - 20; i < n; i++) av += c[i][5]; av /= 20;
    const volX = av > 0 ? c[n][5] / av : 1;
    
    const score = Math.round(Math.min(100, 60 + (volX >= 1.5 ? 15 : 0) + (L * (entry - pm.ma[n]) / atr < 0.5 ? 15 : 0)));
    
    return { cand: { dir: L === 1 ? 'LONG' : 'SHORT', score, entry, stop, riskAbs, riskPct, costR, atr, volX, adx: 0, candleT: c[n][0], pmax: pm.pm[n], htf4h: htf4hDir } };
}
function buildTREND(sym, cd, time) {
    const L = cd.dir === 'LONG' ? 1 : -1;
    return { id: 'TREND_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT, symbol: sym, base: baseOf(sym), dir: cd.dir, strategy: 'TREND',
        setup: 'TREND', setupName: 'PMax Trend (' + TREND.TF + ')', entry: cd.entry, stop: cd.stop, initialStop: cd.stop,
        tp1: cd.entry + L * cd.riskAbs * TREND.TP1_R, tp1R: TREND.TP1_R, trail: 0, trailAbs: TREND.TRAIL_ATR * cd.atr, ext: cd.entry,
        riskAbs: cd.riskAbs, riskPct: r2(cd.riskPct), costR: r2(cd.costR), volX: r2(cd.volX), adx: 0, atr: cd.atr, score: cd.score, htf4h: cd.htf4h,
        chartTf: TREND.TF, reg: MKT_DIR, aligned: MKT_DIR !== 'NÖTR' ? MKT_DIR === cd.dir : null, takerBuy: cd.takerBuy,
        time, candleT: cd.candleT, freshMin: TREND.FRESH_MIN, lastPrice: cd.entry, mfe: 0, mae: 0, maxHold: TREND.MAX_HOLD, status: 'OPEN', trackedTo: cd.candleT };
}
function trendMsg(s) {
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + '📈 PMAX TREND (' + TREND.TF + ') ' + s.dir + ' ' + s.base + ' — PUAN %' + s.score + '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' +
        '\nTP1 ' + fmt(s.tp1) + ' (' + s.tp1R + 'R hedef — bilgi amaçlı)' +
        '\nHTF 4H: ' + (s.htf4h === 1 ? 'yukarı' : s.htf4h === -1 ? 'aşağı' : 'nötr') + ' • Taker %' + (s.takerBuy || '?') +
        '\n⏱ ' + TREND.FRESH_MIN + ' dk içinde gir\n📈 ' + tvLink(s.base, TREND.TF === '5m' ? 5 : TREND.TF === '15m' ? 15 : TREND.TF === '1h' ? 60 : 240);
}
async function runTrend(force) {
    if (!TREND.ON || !TR.ON || trendRun.running || !universe.length || !Object.keys(tickers).length) return;
    const t0 = Date.now(), bar = Math.floor(t0 / TREND_MS) * TREND_MS;
    if (!force) { if (trendRun.lastBar === bar || t0 < trendRun.retryAt || t0 - bar < 8000) return; }
    
    await updateMarketDirection();
    
    trendRun.running = true;
    try {
        const list = universe.filter(s => isMajor(s) || ((tickers[s] || {}).quoteVolume || 0) >= TREND.MIN_VOL).slice(0, TREND.TOP);
        let idx = 0; const cands = [];
        const dg = { list: list.length, ok: 0, stale: 0, cand: 0, sig: 0, err: 0, errMsg: '', t: t0, bar, skip: {}, mkt: MKT_DIR };
        const btcD = mktBtcDir;
        const worker = async () => {
            while (idx < list.length) {
                const sym = list[idx++];
                try {
                    const raw = await safeFetch(ex, sym, TREND.TF, 300);
                    const closed = raw.filter(x => x[0] + TREND_MS <= t0 + 2000);
                    if (closed.length < 100) { dg.skip.short = (dg.skip.short || 0) + 1; continue; }
                    const c = fillGaps(closed, TREND_MS);
                    if (!c || c.length < 100) { dg.skip.short = (dg.skip.short || 0) + 1; continue; }
                    const n = c.length - 1;
                    const lastClose = c[n][0] + TREND_MS;
                    const ageMin = (t0 - lastClose) / 60000;
                    if (ageMin > TREND_MS / 60000 * 2) { dg.stale++; continue; }
                    dg.ok++;
                    const htf4h = TREND.HTF_FILTER ? await getHtfPmax(sym) : 0;
                    const tk = tickers[sym] || {}, entry = tk.last || c[n][4], isBtc = /^BTC\//.test(sym);
                    const r = trendEval(c, n, entry, tk.quoteVolume, isBtc ? 0 : btcD, isBtc, htf4h, MKT_DIR);
                    if (!r.cand) { dg.skip[r.skip] = (dg.skip[r.skip] || 0) + 1; continue; }
                    dg.cand++; cands.push(Object.assign({ sym }, r.cand));
                } catch (e) { dg.err++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 120); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        cands.sort((a, b) => b.score - a.score);
        let openN = trendSignals.filter(isOpen).length, added = 0;
        for (const cd of cands) {
            if (added >= TREND.MAX_PER_SCAN || openN >= TR.MAX_OPEN) { dg.skip.cap = (dg.skip.cap || 0) + 1; continue; }
            if (TREND.MAX_DIR > 0 && trendSignals.filter(x => x.strategy === 'TREND' && isOpen(x) && x.dir === cd.dir).length >= TREND.MAX_DIR) { dg.skip.dirCap = (dg.skip.dirCap || 0) + 1; continue; }
            const lk = 'TREND|' + cd.sym + '|' + cd.dir;
            if (t0 - (lastSig[lk] || 0) < TREND.COOLDOWN_H * H1) { dg.skip.cool = (dg.skip.cool || 0) + 1; continue; }
            if (trendSignals.some(x => x.symbol === cd.sym && isOpen(x))) { dg.skip.open = (dg.skip.open || 0) + 1; continue; }
            
            const flow = await getFlowData(cd.sym);
            if (flow) {
                if (cd.dir === 'LONG' && flow.takerBuyRatio < 0.55) { dg.skip.flow = (dg.skip.flow || 0) + 1; continue; }
                if (cd.dir === 'SHORT' && flow.takerBuyRatio > 0.45) { dg.skip.flow = (dg.skip.flow || 0) + 1; continue; }
                cd.takerBuy = Math.round(flow.takerBuyRatio * 100);
            }
            const sig = buildTREND(cd.sym, cd, t0);
            if (trendSignals.some(x => x.id === sig.id)) { dg.skip.dup = (dg.skip.dup || 0) + 1; continue; }
            trendSignals.unshift(sig); if (trendSignals.length > TR.KEEP) trendSignals.length = TR.KEEP;
            lastSig[lk] = t0; dirty = true; added++; openN++; dg.sig++;
            log('PMAX TREND', cd.dir, sig.base, 'puan', sig.score, 'risk %' + sig.riskPct, 'maliyet', sig.costR + 'R', 'Taker %' + cd.takerBuy, 'HTF4H', cd.htf4h);
            if (TR.TG && sig.score >= TR.NOTIFY) telegram(trendMsg(sig));
        }
        trendRun.dg = dg;
        if (trendRun.tryBar !== bar) { trendRun.tryBar = bar; trendRun.tries = 0; } trendRun.tries++;
        if (dg.ok >= list.length * 0.5 || trendRun.tries >= 3) trendRun.lastBar = bar; else trendRun.retryAt = Date.now() + 10e3;
        log('PMAX TREND tarama: liste', dg.list, 'piyasa', dg.mkt, 'kontrol', dg.ok, 'bayat', dg.stale, 'aday', dg.cand, 'sinyal', dg.sig, 'elenen', JSON.stringify(dg.skip), 'hata', dg.err + (dg.errMsg ? ' (' + dg.errMsg + ')' : ''));
    } catch (e) { log('TREND hata', e.message); trendRun.retryAt = Date.now() + 10e3; }
    trendRun.last = Date.now(); trendRun.ms = trendRun.last - t0; trendRun.running = false;
}

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0, drop: { excluded: 0, lowVol: 0, suspect: 0 }, funnel: null }, dirty = false, lastScanSlot = 0;
const candleCache = new Map();
let triRadar = [], liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const structLT = {}, volCache = new Map();
const brokeAt = {}; let firstScanAt = 0;
let trendSignals = [], brkEvents = [];
let ltNear = [], ltDepth = null, ltShadow = [];
const LT_SH = { MAX_OPEN: num('LT_SHADOW_MAX_OPEN', 60), KEEP: num('LT_SHADOW_KEEP', 300) };
const LTP = { lt: CFG_LT, MIN_EXT: CFG.BRK_MIN_EXT, MAX_EXT: CFG.BRK_MAX_EXT, MIN_VOL: CFG.BRK_MIN_VOL, MAX_VOL: CFG.BRK_MAX_VOL, CLOSE_CONFIRM: CFG.BRK_CLOSE_CONFIRM,
    RETEST: CFG.BRK_RETEST, RETEST_MAX: CFG.BRK_RETEST_MAX, RETEST_PIERCE: CFG.BRK_RETEST_PIERCE, HTF: CFG.BRK_HTF, BTC: CFG.BRK_BTC, BTC_PEN: CFG.BTC_PEN, MIN_STRENGTH: CFG.MIN_STRENGTH };

// ======================= STATE =======================
function loadState() {
    try { const b = JSON.parse(fs.readFileSync(BT_FILE, 'utf8')); if (b && b.result) { b.running = false; bt = b; } } catch (e) { }
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const rawTr = (j.tr || []).filter(s => s && s.id && s.entry);
        trendSignals = rawTr.filter(s => s.strategy === 'TREND');
        brkEvents = (j.brk || []).filter(s => s && s.id && s.type === 'Simetrik');
        ltShadow = (j.sh || []).filter(s => s && s.id && s.entry && s.strategy === 'TRI');
        lastSig = j.lastSig || {};
        log('durum:', trendSignals.length, 'trend,', brkEvents.length, 'LT kırılım,', ltShadow.length, 'gölge');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        const cut = Date.now() - 24 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ lastSig, tr: trendSignals.slice(0, TR.KEEP), brk: brkEvents.slice(0, 200), sh: ltShadow.slice(0, LT_SH.KEEP) }));
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
        await sleep(300);
        tickers = await ex.fetchTickers(); market.lastTick = Date.now();
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = []; let dEx = 0, dVol = 0, dSus = 0;
        for (const t of all) {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase())) { dEx++; continue; }
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) { dVol++; continue; }
            if (isSuspect(t.symbol)) { dSus++; continue; }
            ok.push(t);
        }
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length; scan.drop = { excluded: dEx, lowVol: dVol, suspect: dSus };
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t.last, chg: t.percentage }; } }
    } catch (e) { log('evren hatası', e.message); }
}
async function fetchTriCandles(sym) {
    if (TRI_TF === '2h') {
        const need = CFG_LT.TRI_LOOK * 2 + 120;
        const c1h = fillGaps(await getHist1h(sym, Math.max(need, HIST_NEED)), H1);
        return closedOnly(aggregateN(c1h, H1, 2), H2);
    }
    if (TRI_TF === '1h') {
        const need = CFG_LT.TRI_LOOK + 100;
        return closedOnly(fillGaps(await getHist1h(sym, need), H1), H1);
    }
    return closedOnly(fillGaps(await safeFetch(ex, sym, '15m', 800), M15), M15);
}
async function refreshTickers() {
    try {
        await sleep(200);
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t[s].last, chg: t[s].percentage }; }
        for (const list of [trendSignals, brkEvents]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}

// ======================= KIRILIM =======================
function calculateStrength(tri, vol, ext, q, dir, rs, x) {
    x = x || {};
    let s = 30;
    s += Math.min(16, Math.max(0, (tri.touches - 6) * 4));
    s += Math.round(Math.max(0, CFG_LT.TRI_SQUEEZE - tri.squeeze) / CFG_LT.TRI_SQUEEZE * 14);
    if (x.mat != null) s += Math.round(Math.min(1, Math.max(0, (x.mat - 0.75) / 0.2)) * 10);
    s += vol >= 2.5 ? 10 : vol >= 1.8 ? 8 : vol >= 1.3 ? 5 : vol >= 1.0 ? 2 : 0;
    s += ext <= 0.3 ? 8 : ext <= 0.5 ? 4 : 0;
    if (x.htf) s += x.htf > 0 ? 10 : -10;
    if (x.btc) s += x.btc > 0 ? 5 : -5;
    if (rs != null) { const y = (dir === 'LONG' ? 1 : -1) * rs; s += y > 0.3 ? 5 : y < -0.3 ? -5 : 0; }
    return Math.max(0, Math.min(100, Math.round(s)));
}
const strLabel = s => s >= 75 ? 'ÇOK GÜÇLÜ' : s >= 55 ? 'GÜÇLÜ' : s >= 35 ? 'ORTA' : 'ZAYIF';
function brkMsg(e) {
    return '🐢 KIRILIM — UZUN VADE ÜÇGEN ' + (e.dir === 'LONG' ? '🟢 ' : '🔴 ') + e.dir + ' ' + e.base + ' — ' + e.type + ' üçgen ' + (e.dir === 'LONG' ? 'yukarı' : 'aşağı') + '\nGüç %' + e.strength + ' ' + strLabel(e.strength) + ' | Hacim ' + e.volX.toFixed(1) + 'x | Piyasa: ' + e.reg + '\nGiriş ' + fmt(e.entry) + ' | Stop ' + fmt(e.stop) + ' | TP1 ' + fmt(e.tp1) + (e.costR != null ? '\nRisk %' + e.riskPct.toFixed(2) + ' | Maliyet ' + e.costR.toFixed(2) + 'R' : '') + (e.takerBuy ? '\nTaker Buy: %' + e.takerBuy : '') + '\nBüyük simetrik üçgen kırıldı.' + '\n⏱ ' + CFG.FRESH_ENTRY_MIN + ' dk içinde gir' + '\n📈 ' + tvLink(e.base, TRI_TF === '2h' ? 120 : 15);
}
function buildStruct(S, t0, ms, C, prev) {
    const o = { t: t0, lines: [] };
    if (S.c2 && S.c2.length >= 60) {
        const CC = C || CFG_LT; let tri = detectTriangle(S.c2, S.c2.length - 1, CC, prev && prev.keys), ago = 0;
        if (!tri) {
            const keepLast = triLast, wasMute = triMute; triMute = true;
            try { for (let k = 1; k <= (CC.TRI_BACK || 0) && !tri; k++) { tri = detectTriangle(S.c2, S.c2.length - 1 - k, CC, prev && prev.keys); if (tri) ago = k; } }
            finally { triMute = wasMute; }
            triLast = keepLast;
        }
        if (tri) {
            const pk = pack(tri, S.c2, ms);
            o.tri = pk; o.htf = htfDir(S.c2); o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type; o.w0 = tri.w0; o.mat = tri.mat; o.keys = tri.keys; o.ago = ago;
            { const wnd = S.c2.slice(-200); o.hiN = Math.max.apply(null, wnd.map(x => x[2])); o.loN = Math.min.apply(null, wnd.map(x => x[3])); }
            o.lines.push({ key: 'R', kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type });
            o.lines.push({ key: 'S', kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, touches: tri.touches, squeeze: tri.squeeze, type: tri.type });
        }
    }
    return o;
}
async function liveVol(sym) {
    const now = Date.now(), hit = volCache.get(sym);
    if (hit && now - hit.t < 15000) return hit.d;
    try {
        const raw = await safeFetch(ex, sym, '15m', 40);
        const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), n = closed.length;
        const base = closed.slice(-20), pb = closed.slice(-21, -1);
        let avg = 0, avgP = 0;
        for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0;
        for (const x of pb) avgP += x[5]; avgP = pb.length ? avgP / pb.length : 0;
        const bk = closed[n - 1], pv = closed[n - 2];
        let volX = 0, projX = 0, el = 0;
        if (avg > 0) { const prev = bk ? bk[5] : 0; if (cur) { el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15)); const proj = cur[5] / el; projX = proj / avg; const w = Math.min(1, el / 0.6); volX = (w * proj + (1 - w) * prev) / avg; } else volX = prev / avg; }
        const d = { volX, projX, el, bk, pv, bars: closed.slice(-13), avg15: avg, bkVolX: avgP > 0 && bk ? bk[5] / avgP : 0, atr15: n > 15 ? atrMean(closed, 14) : 0 };
        volCache.set(sym, { t: now, d }); return d;
    } catch (e) { const d = { volX: 0, projX: 0, el: 0, bk: null, pv: null, bars: [], avg15: 0, bkVolX: 0, atr15: 0 }; volCache.set(sym, { t: now, d }); return d; }
}
function lineValues(st, now) {
    const out = {};
    for (const L of st.lines) {
        const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0];
        if (!dt) { out[L.key] = a[1]; continue; }
        const q = (now - a[0]) / dt;
        out[L.key] = CFG_LT.LOG ? Math.exp(Math.log(a[1]) + (Math.log(b[1]) - Math.log(a[1])) * q) : a[1] + (b[1] - a[1]) * q;
    }
    return out;
}
function btcNum() { return mktBtcDir; }
function mktBias() { return MKT_DIR === 'NÖTR' ? null : MKT_DIR; }
function brkCheck(prof, st, L, P, now, bars, volX, v) {
    const key = L === 1 ? 'R' : 'S', atr = st.lines[0].atr;
    const lv = t => lineValues(st, t)[key];
    const lineNow = lv(now), ext = L * (P - lineNow) / atr;
    if (!(ext >= prof.MIN_EXT)) return { ok: false, ext, why: 'aşım yetersiz' };
    if (ext > prof.MAX_EXT) return { ok: false, ext, why: 'çok geç' };
    const bk = bars && bars.length ? bars[bars.length - 1] : null;
    const early = !!(v && v.el >= 0.3 && ext >= 0.25 && v.projX >= 1.5);
    if (prof.CLOSE_CONFIRM && !early && !(bk && L * (bk[4] - lineNow) > 0)) return { ok: false, ext, why: 'kapanış teyidi yok' };
    if (volX < prof.MIN_VOL) return { ok: false, ext, why: 'hacim yetersiz' };
    if (prof.MAX_VOL && volX > prof.MAX_VOL) return { ok: false, ext, why: 'hacim bandı üstü' };
    let retest = false;
    if (prof.RETEST) {
        if (!bars || bars.length < 6) return { ok: false, ext, why: 'retest verisi yok' };
        const dOut = b => L * (b[4] - lv(b[0] + M15)) / atr;
        let bi = -1;
        if (dOut(bars[0]) <= 0) for (let i = 1; i < bars.length; i++) if (dOut(bars[i]) >= prof.MIN_EXT * 0.5) { bi = i; break; }
        if (bi >= 0) for (let j = bi + 1; j < bars.length; j++) {
            const b = bars[j], l = lv(b[0] + M15), extreme = L === 1 ? b[3] : b[2], d = L * (extreme - l) / atr;
            if (d <= prof.RETEST_MAX && d >= -prof.RETEST_PIERCE && L * (b[4] - l) > 0) { retest = true; break; }
        }
        if (!retest) return { ok: false, ext, why: 'retest yok' };
    }
    return { ok: true, ext, retest, early };
}
function planTrade(st, dir, P, vals, v, C) {
    const L = dir === 'LONG' ? 1 : -1;
    const line = L === 1 ? vals.R : vals.S;
    if (!(v && v.atr15 > 0)) return null;
    const atr2 = st.lines[0].atr;
    const cands = [line - L * CFG.STOP_ATR15 * v.atr15, line - L * CFG.STOP_LINE_ATR2H * atr2, P - L * P * CFG.STOP_MIN_PCT / 100];
    const stop = L === 1 ? Math.min(...cands) : Math.max(...cands);
    const risk = L * (P - stop); if (!(risk > 0)) return null;
    const riskPct = risk / P * 100;
    if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return null;
    const rawR = L * (line + L * st.w0 - P) / risk;
    if (rawR < CFG.MIN_RR) return null;
    return { stop, riskPct, tp1R: CFG.BRK_TP1_R, line, rawR };
}
function virtualPlan(L, lineP, atr2h, v) {
    const a15 = v && v.atr15 > 0 ? v.atr15 : atr2h * 0.5;
    const c = [lineP - L * CFG.STOP_ATR15 * a15, lineP - L * CFG.STOP_LINE_ATR2H * atr2h, lineP - L * lineP * CFG.STOP_MIN_PCT / 100];
    const stop = L === 1 ? Math.min(...c) : Math.max(...c);
    const risk = L * (lineP - stop); if (!(risk > 0)) return null;
    return { entry: lineP, stop, riskAbs: risk, riskPct: r2(risk / lineP * 100), tp1: lineP + L * risk * CFG.BRK_TP1_R };
}
function rsOf(sym) { return null; }
function ltShadowAdd(sym, L, cand, st, v, why, atr) {
    if (!CFG.LT_SHADOW || !why) return;
    if (/^bekleme|^başlangıçta/.test(why)) return;
    const now = Date.now(), dir = L === 1 ? 'LONG' : 'SHORT', k = 'LTSH|' + sym + '|' + dir;
    if (now - (lastSig[k] || 0) < 6 * H1) return;
    if (ltShadow.some(x => x.symbol === sym && isOpen(x))) return;
    if (ltShadow.filter(isOpen).length >= LT_SH.MAX_OPEN) return;
    const tk = tickers[sym]; if (!tk || !tk.last) return;
    const vp = virtualPlan(L, cand.v, atr, v); if (!vp) return;
    const P = tk.last, stop = vp.stop, riskAbs = L * (P - stop);
    if (!(riskAbs > 0)) return;
    const riskPct = riskAbs / P * 100, costR = (costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT) / riskPct;
    const key = 'LT:' + why.split(' (')[0].slice(0, 48);
    ltShadow.unshift({ id: 'LTSH_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, symbol: sym, base: baseOf(sym), dir, strategy: 'TRI', shadow: true, fails: [key],
        setup: 'LT_SHADOW', setupName: 'LT gölge', entry: P, stop, initialStop: stop, level: cand.v,
        tp1: P + L * riskAbs * CFG.BRK_TP1_R, tp1R: CFG.BRK_TP1_R, trail: 0,
        riskAbs, riskPct: r2(riskPct), costR: r2(costR), lastPrice: P, mfe: 0, mae: 0, maxHold: CFG.BRK_EXPIRE_H * H1, trackedTo: now,
        time: now, candleT: now, volX: r2(v.volX), status: 'OPEN' });
    if (ltShadow.length > LT_SH.KEEP) ltShadow.length = LT_SH.KEEP;
    lastSig[k] = now; dirty = true;
}

// ======================= TRACK & STATS =======================
function trTrack(now) {
    for (const s of trendSignals) {
        if (!isOpen(s) || !s.riskAbs) continue;
        const t = tickers[s.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = s.dir === 'LONG' ? 1 : -1;
        s.lastPrice = P; let res = null;
        const r = L * (P - s.entry) / s.riskAbs;
        s.mfe = Math.max(s.mfe || 0, r); s.mae = Math.min(s.mae || 0, r);
        if (s.trailAbs) s.ext = L === 1 ? Math.max(s.ext || s.entry, P) : Math.min(s.ext || s.entry, P);
        if (s.status === 'OPEN') { if (L * (P - s.stop) <= 0) { s.status = 'STOP'; res = -1; } else if (r >= s.tp1R) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = now; dirty = true; } }
        else if (s.status === 'TP1') { if (s.trailAbs) { const ts = s.ext - L * s.trailAbs; if (L === 1 ? ts > s.stop : ts < s.stop) { s.stop = ts; dirty = true; } } if (L * (P - s.stop) <= 0) { s.status = L * (s.stop - s.entry) > 0.05 * s.riskAbs ? 'TRAIL' : 'BE'; res = 0.5 * s.tp1R + 0.5 * r; } }
        if (res == null && isOpen(s) && now - s.time > s.maxHold) { res = s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r; s.status = 'SÜRE'; }
        if (res != null) { s.closedAt = now; s.exitPrice = P; s.grossR = r2(res); s.netR = r2(res - (s.costR || 0)); dirty = true; }
    }
    for (const sh of ltShadow) {
        if (!isOpen(sh) || !sh.riskAbs) continue;
        const t = tickers[sh.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = sh.dir === 'LONG' ? 1 : -1;
        sh.lastPrice = P; let res = null;
        const r = L * (P - sh.entry) / sh.riskAbs;
        sh.mfe = Math.max(sh.mfe || 0, r); sh.mae = Math.min(sh.mae || 0, r);
        if (sh.status === 'OPEN') { if (L * (P - sh.stop) <= 0) { sh.status = 'STOP'; res = -1; } else if (r >= sh.tp1R) { sh.status = 'TP1'; sh.stop = sh.entry; sh.tp1At = now; } }
        else if (sh.status === 'TP1') { if (L * (P - sh.stop) <= 0) { sh.status = 'BE'; res = 0.5 * sh.tp1R + 0.5 * r; } }
        if (res == null && isOpen(sh) && now - sh.time > sh.maxHold) { res = sh.status === 'TP1' ? 0.5 * sh.tp1R + 0.5 * r : r; sh.status = 'SÜRE'; }
        if (res != null) { sh.closedAt = now; sh.exitPrice = P; sh.grossR = r2(res); sh.netR = r2(res - (sh.costR || 0)); dirty = true; }
    }
}
const trBucket = s => s.score == null ? 'puan yok' : s.score >= 80 ? 'Puan 80+' : s.score >= 70 ? 'Puan 70-79' : s.score >= 60 ? 'Puan 60-69' : 'Puan <60';
const trStratName = s => s.strategy === 'TREND' ? ('PMax Trend ' + TREND.TF) : 'Bilinmeyen';
function trStatsCalc() {
    const closed = trendSignals.filter(s => s.strategy === 'TREND' && !isOpen(s) && s.netR != null);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), bySetup: groupBy(closed, trStratName), byScore: groupBy(closed, trBucket), byDir: groupBy(closed, s => s.dir), byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x'), byReg: groupBy(closed, s => 'rejim ' + (s.reg || '-')), byCost: groupBy(closed, s => s.costR <= 0.1 ? 'maliyet ≤0.1R' : s.costR <= 0.2 ? 'maliyet 0.1-0.2R' : 'maliyet >0.2R'), byAlign: groupBy(closed, s => s.aligned === true ? 'piyasa uyumlu' : s.aligned === false ? 'piyasa ters' : 'piyasa nötr'), byEntry: groupBy(closed, s => 'PMax dönüşü'), byExit: groupBy(closed, s => s.status) };
}
function brkStatsCalc() {
    const closed = brkEvents.filter(s => !isOpen(s) && s.netR != null);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), byStrength: groupBy(closed, s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : 'Güç <55'), byDir: groupBy(closed, s => s.dir), byType: groupBy(closed, s => s.type), byExit: groupBy(closed, s => s.status) };
}
function shadowStatsCalc() {
    const closed = ltShadow.filter(s => !isOpen(s) && s.netR != null);
    const failsB = {};
    for (const s of closed) for (const f of (s.fails || [])) { (failsB[f] = failsB[f] || []).push(s); }
    const byFail = {};
    for (const k of Object.keys(failsB).sort()) byFail['sadece ' + k + ' takıldı'] = grp(failsB[k]);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status), byFail };
}
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, gross: 0, totalR: 0, pf: 0, dd: 0, t: null };
    let gt = 0, tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0;
    for (const s of list) { tot += s.netR; gt += s.netR + (s.costR || 0); if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR; }
    const avg = tot / n; let t = null;
    if (n >= 5) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)), se = Math.sqrt(v / n); if (se > 1e-6) t = avg / se; }
    return { n, win: w / n, avgR: avg, gross: gt / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: t == null ? null : Number(t.toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const strBucket = s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : (s.strength || 0) >= 35 ? 'Güç 35-54' : 'Güç <35';
function dayLossR() { const cut = Date.now() - 24 * H1; let t = 0; for (const s of trendSignals) if (!isOpen(s) && s.netR != null && (s.closedAt || 0) >= cut) t += s.netR; for (const s of brkEvents) if (!isOpen(s) && s.netR != null && (s.closedAt || 0) >= cut) t += s.netR; return t; }
function dirCapHit(dir) { if (!(CFG.MAX_DIR_TOTAL > 0)) return false; let n = 0; for (const s of trendSignals) if (isOpen(s) && s.dir === dir) n++; for (const s of brkEvents) if (isOpen(s) && s.dir === dir) n++; return n >= CFG.MAX_DIR_TOTAL; }
function mktBlocks(L) { return false; }

// ======================= CANLI MOTOR =======================
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        await updateMarketDirection();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        trTrack(now); brkTrack(now);
        const rad = [];
        for (const sym of Object.keys(structLT)) {
            const st = structLT[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > 4 * TRI_MS) continue;
            const P = tk.last;
            const vals = lineValues(st, now);
            if (vals.R == null || vals.S == null || vals.R <= vals.S) continue;
            const atr = st.lines[0].atr; if (!(atr > 0)) continue;
            const dR = (P - vals.R) / atr, dS = (P - vals.S) / atr;
            let cand = null;
            if (Math.abs(dR) <= CFG.NEAR_ATR || (dR > 0 && dR <= CFG.BRK_SEE)) cand = { bias: 'LONG', d: dR, v: vals.R, line: 'üst çizgi' };
            if (Math.abs(dS) <= CFG.NEAR_ATR || (dS < 0 && -dS <= CFG.BRK_SEE)) { if (!cand || Math.abs(dS) < Math.abs(cand.d)) cand = { bias: 'SHORT', d: dS, v: vals.S, line: 'alt çizgi' }; }
            if (!cand) continue;
            if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && isOpen(x))) continue;
            const L = cand.bias === 'LONG' ? 1 : -1;
            const broke = L * cand.d > CFG.RAW_BREAK_MIN_ATR;
            const v = await liveVol(sym), rs = null;
            const pre = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, Math.abs(cand.d), 0.7, cand.bias, rs, { mat: st.mat, htf: (st.htf || 0) * L, btc: 0 });
            const aligned = MKT_DIR !== 'NÖTR' ? MKT_DIR === cand.bias : null;
            const item = { symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, dir: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type,
                volX: r2(v.volX), strength: pre, broke, rs: null, aligned,
                squeeze: st.squeeze != null ? Number(st.squeeze) : null,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)' };
            if (broke) { const vp = virtualPlan(L, cand.v, atr, v); if (vp) Object.assign(item, vp, { virtual: true }); }
            const volEff = v.el >= 0.2 ? Math.max(v.volX, v.projX * 0.8) : v.volX;
            item.volX = r2(volEff);
            const bkey = sym + '|' + cand.bias;
            if (broke) { if (!brokeAt[bkey]) brokeAt[bkey] = now; item.brokeAt = brokeAt[bkey]; item.ageUnsure = brokeAt[bkey] - firstScanAt < 20e3; }
            rad.push(item);
            if (!broke) continue;

            const chk = brkCheck(LTP, st, L, P, now, v.bars || [], volEff, v);
            if (!chk.ok) { item.why = chk.why; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            const ext0 = chk.ext;
            if (item.ageUnsure && ext0 > 0.3) { item.why = 'başlangıçta zaten kırıktı'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            const sk = 'BRK|' + sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.BRK_COOLDOWN_H * H1) { item.why = 'bekleme süresinde'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && isOpen(x))) continue;
            if (dirCapHit(cand.bias)) { item.why = 'yön limiti'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            if (dayLossR() <= -CFG.DAY_LOSS_R) { item.why = 'günlük kayıp limiti'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            
            const htfN = st.htf || 0;
            if (LTP.HTF && htfN === -L) { item.why = '4H trend ters'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            
            const plan = planTrade(st, cand.bias, P, vals, v, CFG_LT);
            if (!plan) { item.why = v.atr15 > 0 ? 'plan reddi' : 'veri yok (15m ATR)'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, volEff, ext0, 0.6, cand.bias, null, { mat: st.mat, htf: htfN * L, btc: 0 });
            const minS = CFG.MIN_STRENGTH;
            if (strength < minS) { item.why = 'güç düşük'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            const qv = (tickers[sym] || {}).quoteVolume || 0;
            if (qv < CFG.MIN_SIG_VOL) { item.why = 'günlük hacim düşük'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            const entry = P, stop = plan.stop;
            const riskAbs = L * (P - stop); if (!(riskAbs > 0)) continue;
            const riskPct = plan.riskPct;
            const costR = (costFor(qv) + 2 * CFG.SLIP_PCT) / riskPct;
            if (costR > CFG.MAX_COST_R) { item.why = 'maliyet yüksek'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }

            const flow = await getFlowData(sym);
            if (flow && OF.GATE) {
                item.takerBuy = Math.round(flow.takerBuyRatio * 100);
                item.obImbalance = Number(flow.obImbalance.toFixed(2));
                if (cand.bias === 'LONG' && flow.takerBuyRatio < 0.55) { item.why = 'alıcı baskısı zayıf'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
                if (cand.bias === 'SHORT' && flow.takerBuyRatio > 0.45) { item.why = 'satıcı baskısı zayıf'; ltShadowAdd(sym, L, cand, st, v, item.why, atr); continue; }
            }

            const ev = { id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', tf: TRI_TF, symbol: sym, base: baseOf(sym), dir: cand.bias, time: now,
                price: P, line: cand.v, type: st.type, touches: st.touches, squeeze: st.squeeze, mat: st.mat != null ? r2(st.mat) : null, htf: st.htf || 0, retest: !!chk.retest, volX: r2(volEff), ext: r2(ext0), strength: Math.round(strength),
                mode: 'uzun vade', aligned, rs: null, reg: MKT_DIR, takerBuy: item.takerBuy,
                entry, stop, initialStop: stop, riskAbs, riskPct: r2(riskPct), costR: r2(costR),
                tp1: P + L * riskAbs * plan.tp1R, tp1R: plan.tp1R,
                status: 'OPEN', lastPrice: P, mfe: 0, mae: 0, trackedTo: now,
                late: ext0 > CFG.LATE_EXT, early: !!chk.early, stage: 'KIRILIM', rawR: r2(plan.rawR), ago: st.ago || 0 };
            brkEvents.unshift(ev);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM LT', ev.dir, ev.base, ev.type, 'güç', ev.strength, 'hacim', volEff.toFixed(1), 'entry', fmt(P), 'stop', fmt(stop), 'risk %' + riskPct.toFixed(2), 'Taker %' + ev.takerBuy);
            telegram(brkMsg(ev));
        }
        { const liveKeys = new Set(rad.filter(x => x.broke).map(x => x.symbol + '|' + x.bias)); for (const k of Object.keys(brokeAt)) if (!liveKeys.has(k)) delete brokeAt[k]; }
        triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 40);
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(structLT).length;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function brkTrack(now) {
    for (const b of brkEvents) {
        if (!isOpen(b) || b.riskAbs == null) continue;
        const t = tickers[b.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = b.dir === 'LONG' ? 1 : -1;
        const r = L * (P - b.entry) / b.riskAbs;
        b.lastPrice = P; b.mfe = Math.max(b.mfe || 0, r); b.mae = Math.min(b.mae || 0, r);
        const afterTp1 = b.status === 'TP1';
        if (afterTp1) { const ts = b.entry + L * Math.max(0, b.mfe - CFG.LT_TRAIL_R) * b.riskAbs; if (L === 1 ? ts > b.stop : ts < b.stop) { b.stop = ts; dirty = true; } }
        let res = null;
        if (L * (P - b.stop) <= 0) { if (afterTp1) { const sr = L * (b.stop - b.entry) / b.riskAbs; b.status = sr > 0.05 ? 'TRAIL' : 'BE'; res = 0.5 * b.tp1R + 0.5 * sr; } else { b.status = 'STOP'; res = -1; } }
        else if (!afterTp1 && r >= b.tp1R) { b.status = 'TP1'; b.stop = b.entry; b.tp1At = now; dirty = true; }
        else if (now - b.time > CFG.BRK_EXPIRE_H * H1) { res = afterTp1 ? 0.5 * b.tp1R + 0.5 * r : r; b.status = 'SÜRE'; }
        if (res != null) { b.closedAt = now; b.exitPrice = P; b.netR = r2(res - (b.costR || 0)); dirty = true; }
    }
}

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
                    if (c.length < 60 || (!isMajor(sym) && flatRatio(c) >= CFG.FLAT_MAX)) { S[sym] = false; continue; }
                    S[sym] = { c2: c };
                } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        { const dep = Object.values(S).filter(Boolean).map(s => s.c2.length).sort((a, b) => a - b);
          ltDepth = dep.length ? { min: dep[0], med: dep[dep.length >> 1], max: dep[dep.length - 1], n: dep.length, look: CFG_LT.TRI_LOOK, tf: TRI_TF } : null; }
        let kk = 0, built = 0, reused = 0; const nm = [];
        for (const sym of universe) {
            if (++kk % 3 === 0) await yieldLoop();
            const s = S[sym];
            if (s === false) { delete structLT[sym]; continue; }
            if (!s) continue;
            const c = s.c2, i = c.length - 1;
            if (t0 - (c[i][0] + TRI_MS) > 3 * TRI_MS) { delete structLT[sym]; continue; }
            const prev = structLT[sym];
            if (prev && prev.lastC === c[i][0] && prev.lines.length) { prev.t = t0; reused++; continue; }
            try {
                triLast = null;
                const st = buildStruct(s, t0, TRI_MS, CFG_LT, prev);
                st.lastC = c[i][0]; built++;
                if (!st.lines.length && triLast) nm.push({ b: baseOf(sym), g: triLast.g, rank: triLast.rank, sq: triLast.sq != null ? Number(triLast.sq.toFixed(2)) : null, mat: triLast.mat != null ? Number(triLast.mat.toFixed(2)) : null, tc: triLast.tc });
                if (st.lines.length) structLT[sym] = st;
                else if (!(prev && t0 - prev.t < CFG_LT.GRACE_MIN * 60e3)) delete structLT[sym];
            } catch (e) { }
        }
        nm.sort((a, b) => b.rank - a.rank || (a.sq == null ? 9 : a.sq) - (b.sq == null ? 9 : b.sq));
        ltNear = nm.slice(0, 20);
        for (const k of Object.keys(structLT)) if (!universe.includes(k)) delete structLT[k];
        for (const k of [...histCache.keys()]) if (!universe.includes(k)) histCache.delete(k);
        for (const [k, v] of ofCache) if (Date.now() - v.t > 5 * 60e3) ofCache.delete(k);
        for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
        scan.last = Date.now(); scan.ms = scan.last - t0; if (!firstScanAt) firstScanAt = scan.last;
        scan.funnel = Object.assign({}, triDiag); for (const k of Object.keys(triDiag)) delete triDiag[k];
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= BACKTEST =======================
const DAY = 86400e3;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, strategy: 'lt', startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;
async function btSymbol(sym, c1h, c15, vol24, startT, tfMs, prof, btcC) {
    prof = prof || LTP; tfMs = tfMs || H2;
    const hz = 48 * H1;
    const trades = [], lastT = {};
    let st = null, h = 0, lastH = -1, busyUntil = 0, bj = -1, btcV = 0, btcI = -2;
    const btcAt = now => { return 0; };
    for (let k = 31; k < c15.length - 1; k++) {
        if (k % 300 === 0) { await yieldLoop(); await sleep(10); }
        const bk = c15[k], now = c15[k + 1][0];
        if (bk[0] < startT) continue;
        while (h < c1h.length && c1h[h][0] + tfMs <= now) h++;
        if (h !== lastH && h >= 60) {
            lastH = h;
            const arr = c1h.slice(Math.max(0, h - prof.lt.TRI_LOOK - 100), h);
            await yieldLoop();
            triMute = true; let ns; try { ns = buildStruct({ c2: arr }, now, tfMs, prof.lt, st && !st.dead ? st : null); } finally { triMute = false; }
            if (ns.lines.length) st = ns; else if (st) st.dead = true;
        }
        if (st && st.dead && now - st.t >= CFG_LT.GRACE_MIN * 60e3) st = null;
        if (!st) continue;
        if (busyUntil > now) continue;
        const vals = lineValues(st, now);
        if (!(vals.R > vals.S)) continue;
        const P = c15[k + 1][1];
        const pw = c15.slice(k - 20, k);
        const avgP = pw.reduce((a, x) => a + x[5], 0) / pw.length;
        const volX = avgP > 0 ? bk[5] / avgP : 0;
        const bars = c15.slice(Math.max(0, k - 12), k + 1);
        const v = { bk, pv: c15[k - 1], avg15: avgP, bkVolX: volX, volX, atr15: atrMean(c15.slice(k - 30, k + 1), 14), projX: 0, el: 0 };
        for (const dir of ['LONG', 'SHORT']) {
            if (busyUntil > now) continue;
            if (now - (lastT[dir] || 0) < CFG.BRK_COOLDOWN_H * H1) continue;
            const L = dir === 'LONG' ? 1 : -1;
            const chk = brkCheck(prof, st, L, P, now, bars, volX); if (!chk.ok) continue;
            const htfN = st.htf || 0;
            if (prof.HTF && htfN === -L) continue;
            const btcD = 0;
            const plan = planTrade(st, dir, P, vals, v, prof.lt); if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, volX, chk.ext, 0.6, dir, null, { mat: st.mat, htf: htfN * L, btc: btcD * L });
            if (strength < prof.MIN_STRENGTH + (btcD === -L ? prof.BTC_PEN : 0)) continue;
            const costPct = costFor(vol24) + 2 * CFG.SLIP_PCT, costR = costPct / plan.riskPct;
            if (costR > CFG.MAX_COST_R || vol24 < CFG.MIN_SIG_VOL) continue;
            const side = L, risk = side * (P - plan.stop), riskPct = risk / P * 100;
            const sig = { id: 'BT_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, symbol: sym, base: baseOf(sym), dir, entry: P, stop: plan.stop, initialStop: plan.stop,
                tp1: P + side * risk * plan.tp1R, tp1R: plan.tp1R, trail: 0, noTrail: true,
                riskAbs: Math.abs(risk), riskPct: r2(riskPct), costR: r2(costR), atr: st.lines[0].atr, strength, volX: r2(volX),
                time: now, maxHold: CFG.BRK_EXPIRE_H * H1, status: 'OPEN', mfe: 0, mae: 0, trackedTo: now };
            lastT[dir] = now;
            let done = false;
            for (let j = k + 1; j < c15.length; j++) {
                if (j % 100 === 0) await yieldLoop();
                if (advance(sig, c15[j], M15)) { done = true; break; }
            }
            if (!done) continue;
            busyUntil = sig.closedAt;
            trades.push({ sym, dir, type: st.type, strength, vol: r2(volX), ext: r2(chk.ext), retest: !!chk.retest, costR: sig.costR, riskPct: sig.riskPct, status: sig.status, netR: sig.netR, t: now, fp: firstPass(sig, c15, k + 1, hz) });
        }
    }
    return trades;
}
async function btTrend(sym, c, vol24, startT, btc15, eth15) {
    const trades = [], lastT = {}; let busyUntil = 0;
    const isBtc = /^BTC\//.test(sym);
    let btcIdx = 0, ethIdx = 0;
    
    const getMktDir = (now) => {
        while (btcIdx + 1 < btc15.length && btc15[btcIdx + 1][0] + M15 <= now) btcIdx++;
        while (ethIdx + 1 < eth15.length && eth15[ethIdx + 1][0] + M15 <= now) ethIdx++;
        if (btcIdx < 0 || ethIdx < 0) return 'NÖTR';
        
        const btcCl = btc15.slice(0, btcIdx+1);
        const ethCl = eth15.slice(0, ethIdx+1);
        const pmB = pmaxSeries(btcCl, PMAX_ATR, PMAX_MULT, PMAX_LEN);
        const pmE = pmaxSeries(ethCl, PMAX_ATR, PMAX_MULT, PMAX_LEN);
        const bDir = pmB.dir[pmB.dir.length-1] || 0;
        const eDir = pmE.dir[pmE.dir.length-1] || 0;
        
        if (bDir === 1 && eDir === 1) return 'LONG';
        if (bDir === -1 && eDir === -1) return 'SHORT';
        return 'NÖTR';
    };

    const c4h = aggregateN(c, TREND_MS, H4 / TREND_MS);
    const pm4h = c4h.length >= 30 ? pmaxSeries(c4h, PMAX_ATR, PMAX_MULT, PMAX_LEN) : null;
    let h4 = 0;
    for (let n = 100; n < c.length - 1; n++) {
        if (n % 25 === 0) { await yieldLoop(); await sleep(10); }
        const tc = c[n][0] + TREND_MS;
        if (c[n][0] < startT || tc <= busyUntil) continue;
        
        const mktDir = getMktDir(c[n][0]);
        if (mktDir === 'NÖTR') continue;
        
        while (h4 < c4h.length && c4h[h4][0] + H4 <= c[n][0]) h4++;
        const htf4hDir = (pm4h && h4 > 0 && pm4h.dir[h4-1] != null) ? pm4h.dir[h4-1] : 0;
        const entry = c[n + 1][1];
        const r = trendEval(c.slice(0, n + 1), n, entry, vol24, 0, isBtc, htf4hDir, mktDir);
        if (!r.cand) continue;
        const cd = r.cand;
        if (tc - (lastT[cd.dir] || 0) < TREND.COOLDOWN_H * H1) continue;
        const sig = buildTREND(sym, cd, tc);
        lastT[cd.dir] = tc;
        let done = false;
        for (let j = n + 1; j < c.length; j++) {
            if (j % 100 === 0) await yieldLoop();
            if (advance(sig, c[j], TREND_MS)) { done = true; break; }
        }
        if (!done) continue;
        busyUntil = sig.closedAt;
        trades.push({ sym, dir: cd.dir, type: 'Trend', strength: 100, ext: 0, score: cd.score, vol: r2(cd.volX), costR: sig.costR, riskPct: sig.riskPct, mfe: r2(sig.mfe), status: sig.status, netR: sig.netR, t: tc, fp: firstPass(sig, c, n + 1, 10 * 24 * H1) });
    }
    return trades;
}
function firstPass(sig, cs, from, horizonMs) {
    const L = sig.dir === 'LONG' ? 1 : -1, risk = Math.abs(sig.entry - sig.initialStop);
    const out = { a1: null, a2: null, a3: null }; if (!(risk > 0)) return out;
    const lim = sig.time + horizonMs;
    for (let j = from; j < cs.length && cs[j][0] < lim; j++) {
        const k = cs[j];
        const advR = L === 1 ? (k[3] - sig.entry) / risk : (sig.entry - k[2]) / risk;
        const favR = L === 1 ? (k[2] - sig.entry) / risk : (sig.entry - k[3]) / risk;
        if (advR <= -1) { for (const q of ['a1', 'a2', 'a3']) if (out[q] == null) out[q] = 0; return out; }
        if (out.a1 == null && favR >= 1) out.a1 = 1;
        if (out.a2 == null && favR >= 2) out.a2 = 1;
        if (out.a3 == null && favR >= 3) out.a3 = 1;
        if (out.a1 != null && out.a2 != null && out.a3 != null) return out;
    }
    return out;
}
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
        if (s.tsMs && el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', curR(s, k[4]), end); return true; }
    } else if (s.status === 'TP1' && k[0] > s.tp1At) {
        if (s.trailAbs) {
            const hh = L ? k[2] : k[3];
            s.ext = L ? Math.max(s.ext || s.entry, hh) : Math.min(s.ext || s.entry, hh);
            const ts = s.ext - side * s.trailAbs;
            if (L ? ts > s.stop : ts < s.stop) s.stop = ts;
        } else if (!s.noTrail) {
            const hh = L ? k[2] : k[3];
            const ts = s.entry + side * Math.max(0, (side * (hh - s.entry)) / risk - CFG.TRAIL_R) * risk;
            if (L ? ts > s.stop : ts < s.stop) s.stop = ts;
        }
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * s.tp1R + 0.5 * curR(s, s.stop), end); return true; }
    }
    if (el >= s.maxHold && isOpen(s)) { const r = curR(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r, end); return true; }
    return false;
}
async function track() {
    const open = trendSignals.filter(isOpen).concat(brkEvents.filter(isOpen)); if (!open.length) return;
    try {
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym]; const since = Math.min(...list.map(x => x.trackedTo));
                const raw = await safeFetch(ex, sym, '1m', 500, since), c = closedOnly(raw, M1);
                for (const s of list) { if (!isOpen(s)) continue; for (const k of c) { if (k[0] <= s.trackedTo) continue; s.trackedTo = k[0]; dirty = true; if (advance(s, k, M1) && !isOpen(s)) break; } }
            } catch (e) { }
        }
    } catch (e) { }
}
function btReport(trades, strategy) {
    strategy = strategy || 'lt';
    const t = trades.filter(x => x.netR != null).sort((a, b) => a.t - b.t);
    if (!t.length) return { n: 0 };
    const mid = Math.floor(t.length / 2), g = grp(t), a = grp(t.slice(0, mid)), b = grp(t.slice(mid));
    const days = {}; for (const x of t) { const d = new Date(x.t).toISOString().slice(0, 10); days[d] = (days[d] || 0) + x.netR; }
    const dv = Object.values(days);
    let level, verdict;
    if (t.length < 100) { level = 'w'; verdict = 'Örnek az (' + t.length + ' işlem). Sonuca güvenme.'; }
    else if (g.avgR <= 0) { level = 'r'; verdict = 'Bu kurallarla maliyetler sonrası kenar görünmüyor.'; }
    else if (g.t >= 2 && a.avgR > 0 && b.avgR > 0) { level = 'g'; verdict = 'Olumlu işaret: ortalama R pozitif.'; }
    else { level = 'w'; verdict = 'Karışık sonuç: ortalama R pozitif ama istikrarsız.'; }
    verdict += ' Maliyet öncesi ort. R: ' + (g.gross >= 0 ? '+' : '') + g.gross.toFixed(2) + '.';
    const riskB = x => x.riskPct < 0.6 ? 'risk <0.6%' : x.riskPct < 1.2 ? 'risk 0.6-1.2%' : 'risk >1.2%';
    const base = { n: t.length, level, verdict, perDay: t.length / dv.length, worstDay: Math.min(...dv), bestDay: Math.max(...dv), tFrom: t[0].t, tTo: t[t.length - 1].t, strategy };
    base.edge = [];
    for (const gname of ['Tümü', 'LONG', 'SHORT']) {
        const sub = gname === 'Tümü' ? t : t.filter(x => x.dir === gname);
        for (const kk of [1, 2, 3]) {
            const res = sub.filter(x => x.fp && x.fp['a' + kk] != null);
            const n = res.length; if (!n) continue;
            const p = res.filter(x => x.fp['a' + kk] === 1).length / n, bb = 1 / (1 + kk), z = (p - bb) / Math.sqrt(bb * (1 - bb) / n);
            base.edge.push({ g: gname, k: kk, n, un: sub.length - n, hit: p, base: bb, z: Number(z.toFixed(2)) });
        }
    }
    if (strategy === 'trend') {
        const scoreB = x => x.score == null ? 'puan yok' : x.score >= 80 ? 'Puan 80+' : x.score >= 70 ? 'Puan 70-79' : x.score >= 60 ? 'Puan 60-69' : 'Puan <60';
        base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b }, 'Yön': groupBy(t, x => x.dir), 'Puan': groupBy(t, scoreB), 'Risk %': groupBy(t, riskB), 'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
    } else {
        const volB = x => x.vol >= 2.5 ? 'hacim 2.5x+' : x.vol >= 1.8 ? 'hacim 1.8-2.5x' : 'hacim 1.3-1.8x';
        const extB = x => x.ext <= 0.4 ? 'çizgi ötesi ≤0.4' : x.ext <= 0.7 ? 'çizgi ötesi 0.4-0.7' : 'çizgi ötesi >0.7';
        base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b }, 'Yön': groupBy(t, x => x.dir), 'Üçgen tipi': groupBy(t, x => x.type || 'bilinmiyor'), 'Güç': groupBy(t, strBucket), 'Kırılım hacmi': groupBy(t, volB), 'Çizgi ötesi (ATR)': groupBy(t, extB), 'Risk %': groupBy(t, riskB), 'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
    }
    return base;
}
async function btFetchAll(xc, sym, tf, ms, from) {
    const end = Date.now(); let since = from; const out = [];
    for (let g = 0; g < 300 && since < end; g++) {
        await sleep(150);
        let r;
        try {
            r = await Promise.race([
                xc.fetchOHLCV(sym, tf, since, 1000),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
            ]);
        } catch (e) { log('btFetchAll timeout/err (' + sym + '):', e.message); break; }
        if (!r || !r.length) break;
        out.push(...r);
        const lt = r[r.length - 1][0]; if (lt < since) break; since = lt + ms;
    }
    await yieldLoop();
    const m = new Map(); for (const x of out) m.set(x[0], x);
    let firstT = Infinity; for (const k of m.keys()) if (k < firstT) firstT = k;
    if (m.size && firstT - from > 0.03 * (end - from)) {
        let until = firstT - 1;
        for (let g = 0; g < 200 && until > from; g++) {
            await sleep(150);
            let r;
            try {
                r = await Promise.race([
                    xc.fetchOHLCV(sym, tf, undefined, 1000, { until }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
                ]);
            } catch (e) { break; }
            if (!r || !r.length) break;
            let added = 0; for (const x of r) if (!m.has(x[0])) { m.set(x[0], x); added++; }
            const ft = r[0][0]; if (!added || ft >= until) break; until = ft - 1;
            await yieldLoop();
        }
    }
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter(x => x[0] + ms <= end);
}
async function runBacktestJob(days, n, strategy) {
    if (bt.running) return;
    strategy = ['trend', 'lt'].includes(strategy) ? strategy : 'lt';
    bt = { running: true, i: 0, total: 0, sym: '', days, n, strategy, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt[BT_EX]({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const minV = strategy === 'trend' ? TREND.MIN_VOL : CFG.MIN_SIG_VOL;
        const maxCoins = Math.min(n, 60);
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear && !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= minV && !isSuspect(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, maxCoins);
        bt.total = list.length;
        const start = Date.now() - days * DAY; let all = [], skipped = 0; const cov = [], firstTs = [], lowCov = [];
        
        let btc15 = null, eth15 = null;
        try { 
            bt.sym = 'BTC/ETH (15m yön)'; 
            const [bRaw, eRaw] = await Promise.all([btFetchAll(exBT, BTC, '15m', M15, start - 30 * DAY), btFetchAll(exBT, ETH, '15m', M15, start - 30 * DAY)]);
            btc15 = fillGaps(bRaw, M15); eth15 = fillGaps(eRaw, M15);
        } catch (e) { bt.btcErr = String(e.message || e).slice(0, 100); }
        
        for (const t of list) {
            bt.sym = baseOf(t.symbol);
            try {
                if (!exBT.markets[t.symbol]) throw new Error('sembol ' + BT_EX + ' borsasında yok');
                if (strategy === 'trend') {
                    const c = await btFetchAll(exBT, t.symbol, TREND.TF, TREND_MS, start - 40 * DAY);
                    const cv = Math.min(1, c.filter(x => x[0] >= start).length / (days * 24 * (60e3 / TREND_MS))); cov.push(cv); if (cv < 0.8) lowCov.push(bt.sym + ' %' + Math.round(cv * 100));
                    if (c.length) firstTs.push(c[0][0]);
                    all = all.concat(await btTrend(t.symbol, fillGaps(c, TREND_MS), t.quoteVolume, start, btc15, eth15));
                } else {
                    const c15 = await btFetchAll(exBT, t.symbol, '15m', M15, start - 12 * H1);
                    const cv = Math.min(1, c15.filter(x => x[0] >= start).length / (days * 96)); cov.push(cv); if (cv < 0.8) lowCov.push(bt.sym + ' %' + Math.round(cv * 100));
                    if (c15.length) firstTs.push(c15[0][0]);
                    const needDays = Math.ceil(CFG_LT.TRI_LOOK * 2 / 24) + 8;
                    const c1h = await btFetchAll(exBT, t.symbol, '1h', H1, start - needDays * DAY);
                    const cs = aggregateN(fillGaps(c1h, H1), H1, 2);
                    all = all.concat(await btSymbol(t.symbol, cs, c15, t.quoteVolume, start, H2, LTP, null));
                }
            } catch (e) { skipped++; if (!bt.firstErr) bt.firstErr = bt.sym + ': ' + String(e.message || e).slice(0, 120); }
            bt.i++;
            await sleep(300);
            await yieldLoop();
        }
        bt.result = btReport(all, strategy);
        Object.assign(bt.result, { skipped, coins: list.length, requested: n, days, coverage: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : 0, exchange: BT_EX, dataFrom: firstTs.length ? firstTs.slice().sort((a, b) => a - b)[firstTs.length >> 1] : 0, lowCov: lowCov.slice(0, 15), btcErr: bt.btcErr || '' });
        if (bt.firstErr) bt.result.firstErr = bt.firstErr;
    } catch (e) { bt.err = e.message; log('backtest hata', e.message); }
    bt.running = false; bt.finishedAt = Date.now();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BT_FILE, JSON.stringify(bt)); } catch (e) { }
}

// ======================= API =======================
function apiState() {
    const now = Date.now();
    const px = {};
    for (const x of triRadar.concat(brkEvents.slice(0, 80), trendSignals.slice(0, 80))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    const radSyms = new Set(triRadar.map(x => x.symbol));
    const forming = [];
    for (const sym of Object.keys(structLT)) {
        if (radSyms.has(sym)) continue;
        if (brkEvents.some(x => x.symbol === sym && isOpen(x))) continue;
        const stx = structLT[sym], tk = tickers[sym];
        if (!stx || !tk || !tk.last || now - stx.t > 4 * TRI_MS) continue;
        const v = lineValues(stx, now); if (v.R == null || v.S == null || v.R <= v.S) continue;
        const atr = stx.lines[0].atr; if (!(atr > 0)) continue;
        const toUp = (v.R - tk.last) / atr, toDn = (tk.last - v.S) / atr;
        if (!(toUp > 0 && toDn > 0)) continue;
        forming.push({ symbol: sym, base: baseOf(sym), price: tk.last, type: stx.type, touches: stx.touches, squeeze: stx.squeeze != null ? Number(stx.squeeze) : null, mat: stx.mat != null ? Number(stx.mat.toFixed(2)) : null, toUp, toDn });
    }
    forming.sort((a, b) => (a.squeeze || 1) - (b.squeeze || 1));
    return {
        now, mode: 'v59.5 • PMax Trend (' + TREND.TF + ') + BTC/ETH 15m Yön + LT Üçgen',
        px, market, regime: { dir: MKT_DIR, score: 0, regime: 'YATAY', btcDir: mktBtcDir === 1 ? 'LONG' : mktBtcDir === -1 ? 'SHORT' : 'NÖTR', btcScore: 0, funding: { avg: null } }, forming,
        tr: trendSignals.slice(0, 80), trStats: trStatsCalc(),
        trInfo: { strategy: 'TREND', last: trendRun.last, ms: trendRun.ms, running: trendRun.running, tf: TREND.TF, dg: trendRun.dg, minVol: TR.MIN_VOL, notify: TR.NOTIFY, top: TR.TOP, maxOpen: TR.MAX_OPEN, freshMin: TREND.FRESH_MIN, nextBar: Math.floor(Date.now() / TREND_MS) * TREND_MS + TREND_MS, lastBar: trendRun.lastBar, htfFilter: TREND.HTF_FILTER, htfTf: TREND.HTF_TF },
        trend: { on: TREND.ON, last: trendRun.last, ms: trendRun.ms, dg: trendRun.dg, tf: TREND.TF, adxMin: TREND.ADX_MIN, tp1: TREND.TP1_R, trail: TREND.TRAIL_ATR, htfFilter: TREND.HTF_FILTER, htfTf: TREND.HTF_TF },
        breakouts: brkEvents.slice(0, 80), brkStats: brkStatsCalc(),
        brkInfo: { tp1: CFG.BRK_TP1_R, expireH: CFG.BRK_EXPIRE_H, stopAtr: CFG.STOP_ATR15, cd: CFG.BRK_COOLDOWN_H * 60, triTf: TRI_TF, nearAtr: CFG.NEAR_ATR, minExt: CFG.BRK_MIN_EXT, minVol: CFG.BRK_MIN_VOL },
        radar: triRadar,
        tri: { near: ltNear, depth: ltDepth, funnel: scan.funnel || null, tf: TRI_TF, structs: Object.keys(structLT).length, scanLast: scan.last, scanMs: scan.ms, liveLast: live.last, liveErr: live.err, ltParams: { K: CFG_LT.TRI_K, look: CFG_LT.TRI_LOOK, maxLen: CFG_LT.TRI_MAX_LEN, squeeze: CFG_LT.TRI_SQUEEZE, lineTouch: CFG_LT.TRI_LINE_TOUCH, minMat: CFG_LT.TRI_MIN_MAT, cand: CFG_LT.TRI_CAND, minStrength: CFG.MIN_STRENGTH, retest: CFG.BRK_RETEST, maxExt: CFG.BRK_MAX_EXT, log: CFG_LT.LOG } },
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.BRK_COOLDOWN_H * 60, freshMin: CFG.FRESH_ENTRY_MIN },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible, minVol: CFG.MIN_VOL_USDT, drop: scan.drop }
    };
}
const candleInflight = new Map();
async function apiCandles(sym, reqTf) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const useTf = ['5m', '15m', '1h', '2h', '4h'].includes(reqTf) ? reqTf : TRI_TF;
    const key = sym + '|' + useTf, now = Date.now(), hit = candleCache.get(key);
    if (hit && now - hit.t < 8000) return hit.d;
    if (candleInflight.has(key)) return candleInflight.get(key);
    const job = (async () => {
        let c, dur, tf;
        if (useTf === '5m') { c = await uiFetch(sym, '5m', 300); dur = M5; tf = '5m'; }
        else if (useTf === '15m') { c = await uiFetch(sym, '15m', 300); dur = M15; tf = '15m'; }
        else if (useTf === '4h') { c = await uiFetch(sym, '4h', 300); dur = H4; tf = '4H'; }
        else if (useTf === '2h') {
            const hc = histCache.get(sym); let c1h;
            if (hc && hc.c.length > 100) { const rec = await uiFetch(sym, '1h', 5); c1h = mergeC(hc.c, rec); }
            else c1h = await uiFetch(sym, '1h', 900);
            c = aggregateN(fillGaps(c1h, H1), H1, 2); dur = H2; tf = '2H';
        }
        else { c = await uiFetch(sym, '1h', 600); dur = H1; tf = '1H'; }
        const cl = clOf(c);
        const e21 = emaN(cl, 21), e50 = emaN(cl, 50), vs = volSma(c, 20);
        let tri = null;
        if (structLT[sym] && structLT[sym].tri) tri = structLT[sym].tri;
        else if (c.length > 60) { triMute = true; try { const t = detectTriangle(c, c.length - 1, CFG_LT) || detectTriangle(c, c.length - 2, CFG_LT); if (t) tri = pack(t, c, dur); } finally { triMute = false; } }
        let cut = Math.max(0, c.length - 130);
        if (tri) {
            const tS = Math.min(tri.res[0][0], tri.sup[0][0]);
            let ix = c.findIndex(x => x[0] >= tS); if (ix < 0) ix = 0;
            cut = Math.max(0, Math.min(cut, ix - 20));
            if (c.length - cut > 520) cut = c.length - 520;
        }
        const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur, tri };
        candleCache.set(key, { t: Date.now(), d });
        if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
        return d;
    })();
    candleInflight.set(key, job);
    try { return await job; } finally { candleInflight.delete(key); }
}
function apiUniverse() {
    const out = [];
    for (const sym of universe) { const t = tickers[sym]; if (!t || !t.last) continue; out.push({ sym, base: baseOf(sym), price: t.last, chg: t.percentage || 0, vol: t.quoteVolume || 0 }); }
    return { now: Date.now(), list: out };
}
const fundingCache = { t: 0, data: null };
async function apiFunding() {
    if (fundingCache.data && Date.now() - fundingCache.t < 5 * 60e3) return fundingCache.data;
    try {
        const syms = universe.slice(0, 50); const out = [];
        for (const sym of syms) { const t = tickers[sym]; if (!t) continue; let rate = null; if (t.fundingRate != null) rate = t.fundingRate; else if (t.info && t.info.fundingRate != null) rate = Number(t.info.fundingRate); if (rate == null) continue; out.push({ sym, base: baseOf(sym), ratePct: rate * 100, price: t.last || 0, chg: t.percentage || 0, vol: t.quoteVolume || 0 }); }
        out.sort((a, b) => Math.abs(b.ratePct) - Math.abs(a.ratePct));
        fundingCache.data = { now: Date.now(), list: out }; fundingCache.t = Date.now();
        return fundingCache.data;
    } catch (e) { log('funding hata', e.message); return { now: Date.now(), list: [], error: e.message }; }
}

// ======================= ARAYÜZ (v59.5 UI) =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AlphaSon v59.5 — Terminal</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config={darkMode:'class',theme:{extend:{colors:{
brand:{50:'#eef2ff',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',900:'#312e81'},
dark:{bg:'#080b12',card:'#0e131d',panel:'#131926',border:'#1e2734',hover:'#1a2230',muted:'#7e8ca8'},
trade:{long:'#00e0a0',longBg:'rgba(0,224,160,0.10)',short:'#ff4d6d',shortBg:'rgba(255,77,109,0.10)',gold:'#ffb020',purple:'#a78bfa',blue:'#3b82f6'}
},fontFamily:{sans:['Inter','sans-serif'],mono:['JetBrains Mono','monospace']}}}};
</script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{-webkit-tap-highlight-color:transparent}
body{background:#080b12;color:#f3f4f6;font-family:'Inter',sans-serif;overflow-x:hidden;font-variant-numeric:tabular-nums;letter-spacing:-.1px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0e131d}
::-webkit-scrollbar-thumb{background:#1e2734;border-radius:4px}
.glass{background:rgba(19,25,38,.72);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.06)}
.chart-grid{background-size:24px 24px;background-image:linear-gradient(to right,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.025) 1px,transparent 1px)}
canvas{display:block;width:100%;height:100%}
.tab-btn{transition:all .15s}
.tab-btn.a{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;box-shadow:0 6px 20px rgba(99,102,241,.35)}
.sig-row{transition:all .15s;cursor:pointer;border-left:3px solid transparent}
.sig-row:hover{background:rgba(26,34,48,.6)}
.sig-row.sel{background:rgba(99,102,241,.08)}
.sig-row.L{border-left-color:#00e0a0}
.sig-row.S{border-left-color:#ff4d6d}
.sig-row.LT{border-left-color:#a78bfa}
.sig-row.closed{opacity:.55}
.sig-row.old{opacity:.78}
#toast{position:fixed;top:80px;right:20px;z-index:999;background:linear-gradient(135deg,rgba(19,25,38,.98),rgba(14,19,29,.98));border:1px solid #a78bfa;color:#fff;padding:14px 20px;border-radius:12px;font-weight:600;font-size:13px;box-shadow:0 20px 60px rgba(0,0,0,.7);display:none;cursor:pointer;max-width:360px;backdrop-filter:blur(16px);animation:slideIn .3s ease}
@keyframes slideIn{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}
.pulse-dot{animation:pulseDot 1.8s infinite}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.2)}}
.grade-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800}
.lt-badge{display:inline-block;padding:1px 7px;border-radius:6px;background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.35);font-size:9px;font-weight:800;font-family:'JetBrains Mono',monospace;margin-left:6px}
.report-box{background:rgba(19,25,38,.85);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin-top:10px}
</style>
</head>
<body class="min-h-screen flex flex-col antialiased">
<header class="h-16 border-b border-dark-border bg-dark-card/90 backdrop-blur-xl sticky top-0 z-50 flex items-center justify-between px-4 lg:px-6 gap-3">
  <div class="flex items-center gap-3 min-w-0">
    <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-400 flex items-center justify-center shadow-lg shrink-0">
      <i class="fa-solid fa-chart-line text-white text-base"></i>
    </div>
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-bold text-[15px] tracking-tight text-white whitespace-nowrap">AlphaSon</span>
        <span id="modeB" class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-trade-purple/20 text-trade-purple border border-trade-purple/30 whitespace-nowrap">v59.5</span>
      </div>
      <p class="text-[10px] text-dark-muted hidden sm:block">PMax Trend + BTC/ETH 15m Yön + LT Üçgen</p>
    </div>
  </div>
  <div class="hidden xl:flex items-center gap-2 text-xs">
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cReg"><span class="text-dark-muted">Piyasa:</span><span class="text-dark-muted">…</span></div>
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cBtcDir"><span class="text-dark-muted">BTC:</span><span class="text-dark-muted">…</span></div>
    <div class="flex items-center gap-2 bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border" id="cHealth"></div>
  </div>
  <div class="flex items-center gap-2">
    <div class="hidden md:flex items-center gap-3 text-xs font-mono bg-dark-bg px-3 py-1.5 rounded-lg border border-dark-border">
      <div id="cBTC"><span class="text-dark-muted">BTC:</span> <span class="text-dark-muted">…</span></div>
      <div class="w-px h-3 bg-dark-border"></div>
      <div id="cETH"><span class="text-dark-muted">ETH:</span> <span class="text-dark-muted">…</span></div>
    </div>
    <div class="px-3 py-1.5 rounded-lg bg-dark-bg border border-dark-border text-xs flex items-center gap-2">
      <span class="w-2 h-2 rounded-full bg-trade-short pulse-dot" id="dot"></span>
      <span id="conn" class="text-dark-muted">Bağlanıyor</span>
    </div>
  </div>
</header>
<div class="border-b border-dark-border bg-dark-bg/60 backdrop-blur sticky top-16 z-40">
  <div class="max-w-[1920px] mx-auto px-4 lg:px-6 flex items-center gap-2 py-2 overflow-x-auto" id="tabs"></div>
</div>
<main class="flex-1 p-4 lg:p-6 max-w-[1920px] mx-auto w-full">
  <div id="main"></div>
</main>
<footer class="border-t border-dark-border bg-dark-card/50 py-3 px-6 text-[11px] text-dark-muted flex flex-col sm:flex-row justify-between items-center gap-2 font-mono">
  <div>AlphaSon v59.5 • PMax Trend + BTC/ETH 15m Yön + LT Üçgen</div>
  <div class="flex items-center gap-4"><span>Bitget Perpetual</span><span class="w-2 h-2 rounded-full bg-trade-purple pulse-dot"></span></div>
</footer>
<div id="toast"></div>
<script>
var TABS=[{k:'sig',ico:'fa-arrow-trend-up',lbl:'Trend'},{k:'lt',ico:'fa-draw-polygon',lbl:'LT Üçgenler'},{k:'piyasa',ico:'fa-globe',lbl:'Piyasa'},{k:'stat',ico:'fa-chart-simple',lbl:'İstatistik'},{k:'bt',ico:'fa-flask',lbl:'Backtest'}];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,UNI=null,FUND=null,tab='lt',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastSigT=0,lastTrT=0,toastT=null,insTick=0,BT=null,btDays=90,btN=40,btS='trend';
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'—';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'—':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);if(isNaN(x))return'—';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'text-trade-long':x<0?'text-trade-short':'text-dark-muted'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function FM(){return (S&&S.config&&S.config.freshMin)||10}
function isFresh(o){return o.status==='OPEN'&&(Date.now()-o.time)<((o.freshMin||FM()))*60e3}
function trendTf(){return ((S&&S.trend&&S.trend.tf)||'15m').toUpperCase()}
function stratName(k,o){return k==='tr'?'PMAX TREND ('+trendTf()+')':k==='brk'?'🐢 LT ÜÇGEN KIRILIM':'🐢 LT ÜÇGEN'}
function dirBadge(d){return d==='LONG'?'<span class="px-2 py-0.5 rounded-md bg-trade-longBg text-trade-long border border-trade-long/30 text-[10px] font-bold font-mono">▲ LONG</span>':'<span class="px-2 py-0.5 rounded-md bg-trade-shortBg text-trade-short border border-trade-short/30 text-[10px] font-bold font-mono">▼ SHORT</span>'}
function gradeSig(o){if(!o||o.riskPct==null)return null;var riskOk=(o.riskPct>=2.0),costOk=((o.costR||0)<=0.35),volOk=((o.volX||0)>=1.3),alignOk=(o.aligned!==false);var sc=(riskOk?1:0)+(costOk?1:0)+(volOk?1:0)+(alignOk?1:0),reasons=[];if(!riskOk)reasons.push('kaybetme mesafesi çok küçük');if(!costOk)reasons.push('işlem ücreti kârı yiyor');if(!volOk)reasons.push('hacim zayıf');if(!alignOk)reasons.push('piyasa yönü ters');if(sc>=4)return{t:'İYİ',e:'🟢',c:'text-trade-long',bg:'bg-trade-longBg border-trade-long/40',reasons:[]};if(sc>=2)return{t:'ORTA',e:'🟡',c:'text-amber-400',bg:'bg-amber-500/10 border-amber-500/40',reasons:reasons};return{t:'ZAYIF',e:'🔴',c:'text-trade-short',bg:'bg-trade-shortBg border-trade-short/40',reasons:reasons}}
function gradeBadge(g){return g?'<span class="grade-badge '+g.bg+' border '+g.c+'">'+g.e+' '+g.t+'</span>':''}
function sadeWhy(w){if(!w)return'şartlar tamam değil';if(w.indexOf('mktNotr')>=0)return'piyasa NÖTR (BTC/ETH çelişiyor)';if(w.indexOf('mktTers')>=0)return'piyasa ters (BTC/ETH yönü farklı)';if(w.indexOf('htf')>=0)return'4H PMax ters (trend uyumsuz)';if(w.indexOf('aşım')>=0)return'fiyat çizgiyi sadece biraz geçti';if(w.indexOf('çok geç')>=0)return'fiyat çizgiden çok uzaklaştı';if(w.indexOf('hacim')>=0)return'hacim yetersiz';if(w.indexOf('kapanış')>=0)return'mum kapanışı çizgi ötesinde değil';if(w.indexOf('güç')>=0)return'kurulum gücü düşük';if(w.indexOf('retest')>=0)return'geri test yok';if(w.indexOf('4H')>=0)return'4H trend ters';if(w.indexOf('maliyet')>=0)return'işlem ücreti yüksek';if(w.indexOf('hacim düşük')>=0)return'coin likit değil';if(w.indexOf('plan')>=0)return'hedef/kayıp oranı uygun değil';if(w.indexOf('bekleme')>=0)return'bekleme süresi';if(w.indexOf('yön limiti')>=0)return'aynı yönde çok açık var';if(w.indexOf('piyasa')>=0)return'piyasa yönü ters';if(w.indexOf('günlük')>=0)return'günlük kayıp limiti';if(w.indexOf('başlangıç')>=0)return'sistem açılırken zaten kırıktı';if(w.indexOf('yasakliTip')>=0)return'simetrik değil (kama vb.)';return w}
function statusReport(o){if(!o) return '';var k=o.status;var dir=o.dir==='LONG'?'YUKARI':'AŞAĞI';var lines=[];if(k==='OPEN'){lines.push('🕐 <b>Sinyal açık</b> — fiyat henüz 1. kâr hedefine gitmedi.');lines.push('Giriş/stop/hedef fiyatları izleniyor. Çıkışı sen yaparsın.')}else if(k==='TP1'){lines.push('✅ <b>1. kâr hedefi vuruldu!</b> — yarım pozisyon kâr aldı.');lines.push('Stop başabaş noktasına çekildi.');lines.push('Kalan yarı <b>izleyen stop</b> ile trend bitene kadar taşınıyor.')}else if(k==='BE'){lines.push('⚖️ <b>Başabaş kapandı</b> — ne kâr ne zarar.')}else if(k==='STOP'){lines.push('❌ <b>Stop oldu</b> — bu sinyal zarar ile kapandı.')}else if(k==='TRAIL'){lines.push('📉 <b>Takip eden stop ile kapandı</b> — kısmi kâr.')}else if(k==='SÜRE'||k==='TIMEOUT'){lines.push('⏰ <b>Süre doldu</b> — beklenen hareket gelmedi.')}else{lines.push('Durum: '+esc(k||'-'))}return '<div class="report-box"><div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider mb-2">📋 Durum Raporu ('+dir+')</div>'+lines.map(function(l){return '<div class="text-[11px] text-gray-300 leading-relaxed mb-1">'+l+'</div>'}).join('')+'</div>'}
var ST={OPEN:['AÇIK','amber'],TP1:['TP1 ✓','blue'],TRAIL:['TRAIL ✓','long'],BE:['BE','muted'],STOP:['STOP','short'],'SÜRE':['SÜRE','muted'],TIMEOUT:['SÜRE','muted'],EXPIRED:['SÜRESİ DOLDU','muted']};
function stTag(k){var v=ST[k]||[k||'?','muted'];var c={amber:'bg-amber-500/10 text-amber-400 border-amber-500/30',blue:'bg-blue-500/10 text-blue-400 border-blue-500/30',long:'bg-trade-longBg text-trade-long border-trade-long/30',short:'bg-trade-shortBg text-trade-short border-trade-short/30',muted:'bg-dark-hover text-dark-muted border-dark-border'}[v[1]];return '<span class="px-2 py-0.5 rounded-md '+c+' border text-[10px] font-bold font-mono">'+v[0]+'</span>'}
function posInfo(o){if(!o||o.entry==null||!o.riskAbs)return null;var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry,open=isOp(o),fin=!open&&o.netR!=null;var raw=L*(px-o.entry)/o.riskAbs,rawPct=L*(px-o.entry)/o.entry*100,t1=o.tp1R||2,rp=o.riskPct||0,r,pct;if(fin){r=o.netR;pct=(o.grossR!=null?o.grossR:o.netR)*rp}else if(o.status==='TP1'){r=0.5*t1+0.5*raw;pct=0.5*t1*rp+0.5*rawPct}else{r=raw;pct=rawPct}return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,t:o.time}}}
function renderTop(){var m=S.market,R=S.regime||{};if(!R.dir){$('cBtcDir').innerHTML='';$('cReg').innerHTML=''}else{var bc=R.btcDir==='LONG'?'text-trade-long':R.btcDir==='SHORT'?'text-trade-short':'text-dark-muted';$('cBtcDir').innerHTML='<span class="text-dark-muted">BTC:</span> <span class="'+bc+' font-bold">'+R.btcDir+'</span>';var rc=R.dir==='LONG'?'text-trade-long':R.dir==='SHORT'?'text-trade-short':'text-dark-muted';$('cReg').innerHTML='<span class="text-dark-muted">Piyasa:</span> <span class="'+rc+' font-bold">'+R.dir+'</span>'} $('cBTC').innerHTML=m.btc?'<span class="text-dark-muted">BTC:</span> <span class="text-white font-semibold">'+fp(m.btc.price)+'</span> <span class="'+cl(m.btc.chg)+' text-[10px] ml-1">'+sg(m.btc.chg)+'%</span>':'';$('cETH').innerHTML=m.eth?'<span class="text-dark-muted">ETH:</span> <span class="text-white font-semibold">'+fp(m.eth.price)+'</span> <span class="'+cl(m.eth.chg)+' text-[10px] ml-1">'+sg(m.eth.chg)+'%</span>':'';var A=(S.trStats&&S.trStats.today)||{totalR:0};var B=(S.brkStats&&S.brkStats.today)||{totalR:0};$('cHealth').innerHTML='<span class="text-dark-muted">24s:</span> <span class="'+cl(A.totalR)+' font-bold font-mono">'+sg(A.totalR,1)+'R</span> <span class="text-dark-border">|</span> <span class="'+cl(B.totalR)+' font-mono">'+sg(B.totalR,1)+'R</span>';$('modeB').textContent=(S.mode||'v59.5').split('•')[0].trim()}
function renderTabs(){var oc=(S.tr||[]).filter(isFresh).length,nb=(S.breakouts||[]).filter(isFresh).length+(S.radar||[]).length+(S.forming||[]).length;$('tabs').innerHTML=TABS.map(function(t){var cnt=t.k==='sig'&&oc?oc:t.k==='lt'&&nb?nb:0;return '<button class="tab-btn'+(tab===t.k?' a':'')+' px-4 py-2 rounded-lg text-xs font-bold text-dark-muted flex items-center gap-2 whitespace-nowrap" data-t="'+t.k+'"><i class="fa-solid '+t.ico+'"></i>'+t.lbl+(cnt?'<span class="px-1.5 py-0.5 rounded-md bg-white/15 text-[10px] font-mono">'+cnt+'</span>':'')+'</button>'}).join('');Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;if(tab==='bt')pollBT();renderAll()}})}
function sigRow(s){var L=s.dir==='LONG'?1:-1,op=isOp(s),old=op&&!isFresh(s);var P=posInfo(s),r=P?P.r:0,pct=P?P.pct:0;var rTxt=P?sg(r)+'R':'—',rCls=!P?'text-dark-muted':r>0.005?'text-trade-long':r<-0.005?'text-trade-short':'text-dark-muted';var selc=(sel&&sel.kind==='tr'&&sel.id===s.id?' sel':'')+(op?'':' closed')+(old?' old':'')+(L===1?' L':' S');var g=op?gradeSig(s):null;var takerVal=s.dir==='LONG'?s.takerBuy:(100-s.takerBuy);var takerLabel=s.dir==='LONG'?'Alıcı':'Satıcı';var takerCls=takerVal>=55?'text-trade-long':'text-trade-short';var flowTxt=s.takerBuy!=null?'<div class="text-[9px] font-mono mt-0.5"><span class="'+takerCls+'">'+takerLabel+' Baskısı: %'+takerVal+'</span></div>':'';var htfTxt=s.htf4h!=null&&s.htf4h!==0?'<div class="text-[9px] font-mono mt-0.5 '+(s.htf4h===1?'text-trade-long':'text-trade-short')+'">4H PMax: '+(s.htf4h===1?'yukarı':'aşağı')+'</div>':'';var riskLine=op&&s.riskPct!=null?'<div class="text-[9px] text-dark-muted font-mono">Risk %'+f2(s.riskPct,1)+' • Üc '+f2(s.costR||0,2)+'R</div>'+htfTxt+flowTxt:'';return '<div class="sig-row '+selc+'" data-kind="tr" data-id="'+esc(s.id)+'" data-sym="'+esc(s.symbol)+'"><div class="grid grid-cols-12 gap-2 px-4 py-3 items-center"><div class="col-span-3 flex items-center gap-2 min-w-0"><span class="w-1.5 h-1.5 rounded-full '+(L===1?'bg-trade-long':'bg-trade-short')+' shrink-0"></span><div class="min-w-0"><div class="font-bold text-white text-sm truncate">'+esc(s.base)+'</div>'+riskLine+'</div></div><div class="col-span-2">'+dirBadge(s.dir)+'</div><div class="col-span-2 text-xs font-mono text-gray-200 leading-tight">'+fp(s.entry)+'<div class="text-[9px] text-trade-short">S:'+fp(s.stop)+'</div></div><div class="col-span-3 leading-tight">'+stTag(s.status)+' '+gradeBadge(g)+'</div><div class="col-span-2 text-right font-mono font-bold '+rCls+'">'+rTxt+(P&&P.pct!=null?'<div class="text-[10px] '+cl(pct)+' font-normal">'+sg(pct)+'%</div>':'')+'</div></div></div>'}
function brkRow(e){var L=e.dir==='LONG'?1:-1,op=isOp(e);var P=posInfo(e);var r=P?P.r:0;var selc=(sel&&sel.kind==='brk'&&sel.id===e.id?' sel':'')+(op?'':' closed')+(L===1?' L':' S')+' LT';var g=op?gradeSig(e):null;var takerVal=e.dir==='LONG'?e.takerBuy:(100-e.takerBuy);var takerLabel=e.dir==='LONG'?'Alıcı':'Satıcı';var takerCls=takerVal>=55?'text-trade-long':'text-trade-short';var flowTxt=e.takerBuy!=null?'<div class="text-[9px] font-mono mt-0.5"><span class="'+takerCls+'">'+takerLabel+' Baskısı: %'+takerVal+'</span></div>':'';var riskLine=op&&e.riskPct!=null?'<div class="text-[9px] text-dark-muted font-mono">Risk %'+f2(e.riskPct,1)+' • Üc '+f2(e.costR||0,2)+'R</div>'+flowTxt:'<div class="text-[9px] text-dark-muted font-mono">Güç %'+e.strength+' • Hcm '+f2(e.volX,1)+'x</div>'+flowTxt;return '<div class="sig-row '+selc+'" data-kind="brk" data-id="'+esc(e.id)+'" data-sym="'+esc(e.symbol)+'"><div class="grid grid-cols-12 gap-2 px-4 py-3 items-center"><div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(e.base)+'<span class="lt-badge">🐢 LT</span></div>'+riskLine+'</div></div><div class="col-span-2">'+dirBadge(e.dir)+'</div><div class="col-span-2 text-xs font-mono text-gray-200 leading-tight">'+fp(e.entry)+'<div class="text-[9px] text-trade-short">S:'+fp(e.stop)+'</div></div><div class="col-span-3 leading-tight">'+stTag(e.status)+' '+gradeBadge(g)+'</div><div class="col-span-2 text-right font-mono font-bold '+cl(r)+'">'+(op||e.netR!=null?sg(r)+'R':'—')+'</div></div></div>'}
function radRow(r){var L=r.bias==='LONG'?1:-1;var str=r.strength>=75?'text-trade-long':r.strength>=55?'text-trade-long/80':'text-trade-gold';var cls='LT '+(L===1?'L':'S');var whyTxt=(r.broke&&r.why)?'<div class="text-amber-400 text-[10px] mt-0.5">⏸ '+esc(sadeWhy(r.why))+'</div>':'';var takerVal=r.dir==='LONG'?r.takerBuy:(100-r.takerBuy);var takerLabel=r.dir==='LONG'?'Alıcı':'Satıcı';var takerCls=takerVal>=55?'text-trade-long':'text-trade-short';var flowTxt=r.takerBuy!=null?'<div class="text-[9px] font-mono mt-0.5"><span class="'+takerCls+'">'+takerLabel+' Baskısı: %'+takerVal+'</span></div>':'';return '<div class="sig-row '+cls+(sel&&sel.kind==='rad'&&sel.sym===r.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="grid grid-cols-12 gap-2 px-4 py-3 items-center"><div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(r.base)+'<span class="lt-badge">🐢 LT</span></div><div class="text-[10px] text-dark-muted font-mono">'+esc(r.type||'üçgen')+' • '+r.touches+' değme</div></div></div><div class="col-span-2">'+dirBadge(r.bias)+'</div><div class="col-span-2 text-xs font-mono text-gray-200">'+fp(r.price)+'</div><div class="col-span-4 text-[11px] text-dark-muted break-words">'+esc(r.state||'')+whyTxt+flowTxt+'</div><div class="col-span-1 text-right font-mono font-bold '+str+'">%'+r.strength+'</div></div></div>'}
var lpHold=0;
function lpCount(){return tab==='lt'?((S.radar||[]).length+(S.forming||[]).length+(S.breakouts||[]).length):(S.tr||[]).length}
function lpKey(r){return (r.getAttribute('data-kind')||'')+'|'+(r.getAttribute('data-id')||'')+'|'+(r.getAttribute('data-sym')||'')}
function lpSnap(el){if(!el||el.scrollTop<=2)return {top:true};var er=el.getBoundingClientRect(),rows=el.querySelectorAll('.sig-row'),cnt={};for(var i=0;i<rows.length;i++){var r=rows[i],k=lpKey(r);cnt[k]=(cnt[k]||0)+1;var b=r.getBoundingClientRect();if(b.bottom>er.top+1)return {k:k,n:cnt[k],off:b.top-er.top,st:el.scrollTop}}return {st:el.scrollTop}}
function lpRestore(el,s){if(!el)return;if(!s||s.top){el.scrollTop=0;return}if(s.k){var er=el.getBoundingClientRect(),rows=el.querySelectorAll('.sig-row'),cnt=0;for(var i=0;i<rows.length;i++){var r=rows[i];if(lpKey(r)===s.k&&++cnt===s.n){el.scrollTop+=(r.getBoundingClientRect().top-er.top)-s.off;return}}}el.scrollTop=s.st||0}
function lpTop(){var l=$('listPanel');if(l)l.scrollTop=0}
function renderListPanel(force){var lp=$('listPanel');if(!lp)return;if(!force&&Date.now()-lpHold<700)return;var snap=lpSnap(lp);var byT=function(a,b){return (b.time||0)-(a.time||0)};var H=function(t){return '<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">'+t+'</div>'};var tr=(S.tr||[]).filter(isOp),ac=(S.tr||[]).filter(function(x){return !isOp(x)});var fr=tr.filter(isFresh).sort(byT),od=tr.filter(function(x){return !isFresh(x)}).sort(byT);var ev=S.breakouts||[],rd=S.radar||[],fo=S.forming||[];var brk=rd.filter(function(x){return x.broke}),near=rd.filter(function(x){return !x.broke});var fresh=ev.filter(isFresh).sort(byT),oldB=ev.filter(function(x){return isOp(x)&&!isFresh(x)}).sort(byT),closedB=ev.filter(function(x){return !isOp(x)});var html='';if(tab==='sig'){var tdg=(S.trend||{}).dg;if(tdg)html+='<div class="glass rounded-xl p-3 mb-3 text-[11px] text-dark-muted">📈 <b class="text-trade-purple">PMax Trend ('+trendTf()+')</b> — Piyasa: <b class="text-white">'+tdg.mkt+'</b> • taranan <b class="text-white">'+tdg.ok+'</b> • aday <b class="text-white">'+tdg.cand+'</b> • sinyal <b class="text-trade-long">'+tdg.sig+'</b><br>Elenme: '+Object.keys(tdg.skip||{}).map(function(k){return k+':'+tdg.skip[k]}).join(' • ')+'</div>';if(fr.length)html+=H('🟢 Taze — giriş açık ('+fr.length+')')+fr.map(sigRow).join('');if(od.length)html+=H('⏳ Açık — takip ('+od.length+')')+od.map(sigRow).join('');if(ac.length)html+=H('Kapananlar ('+Math.min(20,ac.length)+'/'+ac.length+')')+ac.slice(0,20).map(sigRow).join('');if(!tr.length&&!ac.length)html+='<div class="text-center text-dark-muted py-12 text-xs">Henüz PMax Trend sinyali yok.</div>'}else if(tab==='lt'){var triTf=((S.tri||{}).tf||'2h').toUpperCase();var ltN=(S.tri||{}).structs||0;var dp=(S.tri||{}).depth;html+='<div class="glass rounded-xl p-3 mb-3 text-[11px] text-dark-muted">🐢 <b class="text-trade-purple">LT Üçgenler (Simetrik)</b> — TF <b class="text-white">'+triTf+'</b> • yapı: <b class="text-white">'+ltN+'</b> • izlenen: <b class="text-white">'+rd.length+'</b> • sinyal: <b class="text-trade-long">'+ev.length+'</b> • sıkışan: <b class="text-white">'+fo.length+'</b>'+(dp?'<br>Veri derinliği: <b class="text-white">'+dp.med+'</b> bar':'')+'</div>';if(fresh.length)html+=H('🟢 Taze kırılım ('+fresh.length+')')+fresh.map(brkRow).join('');if(oldB.length)html+=H('⏳ Eski kırılım ('+oldB.length+')')+oldB.map(brkRow).join('');if(brk.length)html+=H('◎ Çizgiyi aşanlar — sinyal yok ('+brk.length+')')+brk.map(radRow).join('');if(near.length)html+=H('🎯 Çizgiye yaklaşanlar ('+near.length+')')+near.map(radRow).join('');if(fo.length)html+=H('📐 Sıkışanlar ('+fo.length+')')+fo.map(function(x){return '<div class="sig-row LT" data-kind="rad" data-id="" data-sym="'+esc(x.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center"><div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(x.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+esc(x.type||'üçgen')+' • '+x.touches+' değme</div></div></div><div class="col-span-2">'+(x.toUp<x.toDn?dirBadge('LONG'):dirBadge('SHORT'))+'</div><div class="col-span-2 text-xs font-mono text-gray-200">'+fp(x.price)+'</div><div class="col-span-3 text-[11px] text-dark-muted">Üste '+f2(x.toUp,2)+' • Alta '+f2(x.toDn,2)+' ATR</div><div class="col-span-2 text-right font-mono font-bold text-trade-purple">%'+(x.squeeze!=null?Math.round((1-x.squeeze)*100):'—')+'</div></div></div>'}).join('');if(closedB.length)html+=H('Kapanan')+closedB.slice(0,12).map(brkRow).join('');if(!rd.length&&!ev.length&&!fo.length)html+='<div class="text-center text-dark-muted py-8 text-xs">Şu anda LT üçgen yok.</div>';var nr=((S.tri||{}).near)||[];if(nr.length)html+=H('🔬 En yakın kaçanlar')+nr.slice(0,8).map(function(n){return '<div class="px-4 py-2 text-[11px] text-dark-muted font-mono border-b border-dark-border/40"><b class="text-white">'+esc(n.b)+'</b> • '+esc(sadeWhy(n.g))+(n.tc!=null?' • '+n.tc+' değme':'')+'</div>'}).join('')}else html='<div class="text-center text-dark-muted py-12 text-xs">Sağ panelde detaylar.</div>';lp.innerHTML=html;Array.prototype.forEach.call(lp.querySelectorAll('.sig-row'),function(e){if(!e.dataset.kind)return;e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderListPanel(true);renderMain()}});lpRestore(lp,snap);var c=$('lpCnt');if(c)c.textContent=lpCount()}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor='';prefetch(sym,defTf())}
function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);if(!lastSigT){lastSigT=mx||Date.now();return}var nw=a.filter(function(x){return x.time>lastSigT});if(mx>lastSigT)lastSigT=mx;if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('🐢 LT KIRILIM '+e.dir+' <b>'+e.base+'</b> — Güç %'+e.strength,function(){tab='lt';pick('brk',e.id,e.symbol);renderAll();lpTop()})}}
function checkTr(){var a=S.tr||[],nt=(S.trInfo||{}).notify||0,mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);if(!lastTrT){lastTrT=mx||Date.now();return}var nw=a.filter(function(x){return x.time>lastTrT&&x.score>=nt});if(mx>lastTrT)lastTrT=mx;if(nw.length){beep();setTimeout(beep,400);var s=nw[0];showToast('⚡ PMAX TREND '+s.dir+' <b>'+s.base+'</b> — Puan %'+s.score,function(){tab='sig';pick('tr',s.id,s.symbol);renderAll();lpTop()})}}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.08;o.start();o.stop(actx.currentTime+0.3)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.innerHTML=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn&&fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function drawChart(d,V,cid){var c=$(cid);if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?32:4);var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;var ti=function(t){return (t-d.c[0][0])/d.dur};var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];var lin=!!(tri&&tri.lin);var lg=function(a,pa,b,pb,q){var t=(q-a)/((b-a)||1);return lin?pa+(pb-pa)*t:Math.exp(Math.log(pa)+(Math.log(pb)-Math.log(pa))*t)};var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});hi=Math.max(hi,px);lo=Math.min(lo,px);if(lv)[lv.entry,lv.stop,lv.tp1].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});var tl=[];if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),xa=Math.min(Math.max(a,0),nc+2),xb=Math.min(b,nc+2);tl.push([a,l[0][1],b,l[1][1]]);[xa,xb].forEach(function(q){var v=lg(a,l[0][1],b,l[1][1],q);hi=Math.max(hi,v);lo=Math.min(lo,v)})});var pad=(hi-lo)*.07;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(1.5,PW/n*.7);var labs=[];if(lv){labs.push({p:lv.entry,col:'#ffb020',t:V.virtual?'ÇİZGİ':'GİRİŞ'});labs.push({p:lv.stop,col:'#ff4d6d',t:'STOP'});if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#00e0a0',t:'TP1'})}labs.push({p:px,col:'#f3f4f6',t:'',cur:1});labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});labs.sort(function(a,b){return a.y-b.y});for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}var si=-1;if(lv&&lv.t){si=Math.floor(ti(lv.t));if(si<0||si>=nc)si=-1}if(lv){var zx=si>=0?X(si):L,zw=W-R-zx,ye=Y(lv.entry),ys=Y(lv.stop),far=lv.tp1,yt=far!=null?Y(far):ye;x.fillStyle='rgba(255,77,109,.10)';x.fillRect(zx,Math.min(ye,ys),zw,Math.abs(ys-ye));x.fillStyle='rgba(0,224,160,.10)';x.fillRect(zx,Math.min(ye,yt),zw,Math.abs(yt-ye))}x.font='10px JetBrains Mono,monospace';for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.04)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#7e8ca8';x.fillText(fp(gp),W-R+8,gy+3)}}var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};line(d.e50,'#a78bfa',1.1);line(d.e21,'#3b82f6',1.1);d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#00e0a0':'#ff4d6d';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;x.strokeStyle='rgba(255,255,255,.06)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#00e0a0':'#ff4d6d',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.5;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});if(d.vsma){x.strokeStyle='#ffb020';x.lineWidth=1.1;x.beginPath();var s2=false;d.vsma.forEach(function(v,k){if(v==null)return;var y=vTop+volH-(v/vmax)*(volH-4);s2?x.lineTo(X(k),y):(x.moveTo(X(k),y),s2=true)});x.stroke()}if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();tl.forEach(function(l){x.strokeStyle='rgba(167,139,250,.85)';x.lineWidth=2;x.beginPath();var NS=80;for(var z=0;z<=NS;z++){var q=l[0]+(l[2]-l[0])*z/NS,yv=lg(l[0],l[1],l[2],l[3],q);z?x.lineTo(X(q),Y(yv)):x.moveTo(X(q),Y(yv))}x.stroke()});x.fillStyle='rgba(167,139,250,.9)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});x.restore()}x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.2;x.globalAlpha=.8;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});x.restore();if(si>=0){var kk=d.c[si],isL=V.dir==='LONG',mx=X(si);x.strokeStyle='rgba(167,139,250,.45)';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(mx,T);x.lineTo(mx,T+PH);x.stroke();x.setLineDash([]);x.fillStyle=isL?'#00e0a0':'#ff4d6d';x.beginPath();if(isL){var y0=Y(kk[3])+5;x.moveTo(mx,y0);x.lineTo(mx-8,y0+14);x.lineTo(mx+8,y0+14)}else{var y1=Y(kk[2])-5;x.moveTo(mx,y1);x.lineTo(mx-8,y1-14);x.lineTo(mx+8,y1-14)}x.closePath();x.fill()}x.strokeStyle='rgba(255,255,255,.5)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#080b12';x.font='bold 10px JetBrains Mono,monospace';x.fillText(txt,W-R+6,y+3.5)});x.fillStyle='#7e8ca8';x.font='10px JetBrains Mono,monospace';var stp=Math.max(1,Math.ceil(nc/7));for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);if(d.dur>=3600e3)hh=('0'+dt.getDate()).slice(-2)+'.'+('0'+(dt.getMonth()+1)).slice(-2)+' '+hh;x.fillText(hh,X(q)-12,H-5)}if(V&&V.dir){var isLg=V.dir==='LONG';x.fillStyle=isLg?'#00e0a0':'#ff4d6d';x.fillRect(8,7,92,24);x.fillStyle='#051412';x.font='bold 13px Inter,sans-serif';x.fillText(isLg?'▲ LONG':'▼ SHORT',16,24);if(V.strat){x.fillStyle='#f3f4f6';x.font='bold 11px Inter,sans-serif';x.fillText(V.strat,108,24)}if(V.pnl){var pc=V.pnl.r>0.005?'#00e0a0':V.pnl.r<-0.005?'#ff4d6d':'#7e8ca8',txt=(V.pnl.fin?'KAPANDI ':(V.pnl.lbl||'CANLI')+' ')+sg(V.pnl.r)+'R   '+sg(V.pnl.pct)+'%';x.font='bold 12px JetBrains Mono,monospace';var w=x.measureText(txt).width+22;x.fillStyle=pc;x.fillRect(W-R-w+L,7,w,24);x.fillStyle='#080b12';x.fillText(txt,W-R-w+L+11,23)}}}
function refreshView(){var M=$('main');if(M){M.removeAttribute('data-view-key');renderMain()}}
function loadChart(sym,tf){var k=sym+'|'+tf;fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error||!d.c)return;chartCache[k]=d;if(sel&&sel.sym===sym&&(tfSel||defTf())===tf){chartFor=k;refreshView()}}).catch(function(){})}
function prefetch(sym,tf){if(sym&&!chartCache[sym+'|'+tf])loadChart(sym,tf)}
function setTf(v){tfSel=v;chartFor='';refreshView()}
function selData(){if(!sel||!sel.sym)return null;if(sel.kind==='tr')return(S.tr||[]).find(function(x){return x.id===sel.id})||null;if(sel.kind==='brk')return(S.breakouts||[]).find(function(x){return x.id===sel.id})||null;return(S.radar||[]).find(function(x){return x.symbol===sel.sym})||null}
function defTf(){if(sel&&sel.kind==='rad')return S.config.tf;if(sel&&sel.kind==='tr'){var o=selData()||{};return o.chartTf||((S.trend||{}).tf)||'15m'}return((S.tri||{}).tf||'2h')}
function whyText(o,kind){if(!o)return'<b>Bu sinyal artık listede değil.</b>';var L=(o.dir||o.bias)==='LONG';var dirWord=L?'yukarı':'aşağı';var fresh=isFresh(o)?'<b class="text-trade-long">✅ Sinyal taze, girmek için uygun.</b>':(o.status==='OPEN'?'<b class="text-amber-400">⏰ Sinyal eski — sadece takip et.</b>':'<b>Kapanmış sinyal.</b>');var g=gradeSig(o);var gradeBox=g?'<div class="mb-3 p-3 rounded-lg '+g.bg+' border '+g.c+'"><b>'+g.e+' Kalite: '+g.t+'</b>'+(g.reasons.length?'<br><span class="text-xs">Sorunlar: '+g.reasons.join(' • ')+'</span>':'<br><span class="text-xs">Her şey yerinde.</span>')+'</div>':'';var flowBox=o.takerBuy!=null?'<div class="mb-3 p-3 rounded-lg bg-dark-bg border border-dark-border text-sm"><b>Kim daha güçlü?</b> '+(L?(o.takerBuy>=55?'Alıcılar baskın ✅ (%'+o.takerBuy+')':'Alıcılar zayıf ⚠️'):((100-o.takerBuy)>=55?'Satıcılar baskın ✅ (%'+(100-o.takerBuy)+')':'Satıcılar zayıf ⚠️'))+'</div>':'';var htfBox=o.htf4h!=null&&o.htf4h!==0?'<div class="mb-3 p-3 rounded-lg bg-dark-bg border border-dark-border text-sm"><b>4H PMax HTF:</b> '+(o.htf4h===1?'yukarı ✅ (uyumlu)':'aşağı ✅ (uyumlu)')+'</div>':'';if(kind==='tr'&&o.strategy==='TREND'){return gradeBox+flowBox+htfBox+'📈 <b>PMax Trend ('+trendTf()+'):</b> Fiyat PMax çizgisini <b>'+dirWord+'</b> kesti. Bu, momentumun yön değiştirdiğini gösterir.<br>🛑 <b>Stop:</b> PMax çizgisi (ATR bazlı dinamik stop).<br>🎯 <b>Giriş/Stop/TP1</b> kartlarda net. <b>Çıkışı sen yaparsın.</b><br>💸 İşlem ücreti: '+f2(o.costR,2)+'R • Risk %'+f2(o.riskPct,2)+'<br><br>'+fresh}if(kind==='brk'){var parts=[];parts.push('🎯 <b>Ne oldu?</b> Bir Simetrik üçgenin '+(L?'üst':'alt')+' çizgisi kırıldı.');parts.push('📍 <b>Kaç kez değmiş:</b> '+(o.touches||'?')+' kez'+(o.touches>=8?' (güçlü ✅)':' (normal)'));parts.push('💪 <b>Kırılım hacmi:</b> '+f2(o.volX,1)+'x (eşik 1.2x)');parts.push('🎚 <b>Kurulum gücü:</b> %'+o.strength+(o.strength>=75?' (güçlü ✅)':o.strength>=55?' (orta)':' (zayıf)'));if(o.riskPct!=null)parts.push('⚠️ <b>Kaybetme mesafesi:</b> %'+f2(o.riskPct,2)+(o.riskPct>=1.8?' (uygun ✅)':' (sınırda)'));if(o.retest)parts.push('🔄 <b>Geri test:</b> Fiyat çizgiye geri döndü ve tuttu ✅');if(o.mat!=null)parts.push('⏳ <b>Üçgen olgunluğu:</b> %'+Math.round(o.mat*100));parts.push('🧭 <b>Piyasa yönü:</b> '+(o.aligned===true?'✅ aynı yönde':o.aligned===false?'⚠️ TERS':'nötr'));return gradeBox+flowBox+parts.join('<br>')+'<br><br>'+fresh}if(o.broke){return '⚠️ <b>Fiyat çizgiyi geçti AMA sinyal verilmedi.</b><br><br>🔍 <b>Sebep:</b> '+esc(sadeWhy(o.why||'-'))+'<br><br><b>Ne yapmalı?</b> Fiyat çizgiyi geçmiş olsa bile eksik şartlar varsa giriş riskli. Sistem bekliyor.'}return '🎯 <b>Üçgen izleniyor, henüz kırılmadı.</b> Fiyat çizgiye yaklaşıyor.'}
function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="flex flex-wrap gap-3 items-end">'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Bakiye</div><input id="cBal" type="number" value="'+cfgC.bal+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-24 focus:border-brand-500 focus:outline-none"></label>'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Risk %</div><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-20 focus:border-brand-500 focus:outline-none"></label>'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Giriş</div><input id="cE" type="number" step="any" value="'+(e||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Stop</div><input id="cS" type="number" step="any" value="'+(s||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+'<div id="cOut" class="text-xs text-dark-muted font-mono"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b class="text-trade-gold">'+f2(c.ru)+' USDT</b> • Miktar <b>'+f2(c.q,4)+'</b> • Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}
var tbl=function(t,title,nt){return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">'+title+'</h3><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2 px-2">Grup</th><th class="text-right py-2 px-2">N</th><th class="text-right py-2 px-2">Kazanma%</th><th class="text-right py-2 px-2">Ort.R</th><th class="text-right py-2 px-2">Toplam R</th><th class="text-right py-2 px-2">PF</th><th class="text-right py-2 px-2">t</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+Object.keys(t).map(function(k){var x=t[k];var tOk=!(nt||x.t==null||x.n<5);return '<tr class="hover:bg-dark-hover/40"><td class="py-2 px-2 text-white">'+esc(k)+'</td><td class="text-right py-2 px-2">'+x.n+'</td><td class="text-right py-2 px-2">'+f2(x.win*100,0)+'</td><td class="text-right py-2 px-2 '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="text-right py-2 px-2 '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="text-right py-2 px-2">'+(x.pf>=99?'∞':f2(x.pf))+'</td><td class="text-right py-2 px-2">'+(tOk?f2(x.t):'—')+'</td></tr>'}).join('')+'</tbody></table></div>'};
function statView(){var A=S.trStats||{},B=S.brkStats||{},h='<h2 class="text-lg font-bold text-white mb-4"><i class="fa-solid fa-chart-simple text-brand-400 mr-2"></i>İstatistik</h2>';h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 text-brand-400">📈 PMAX TREND SİNYALLERİ</div>';if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.bySetup||{},'Strateji')+tbl(A.byScore||{},'Puan')+tbl(A.byDir||{},'Yön')+tbl(A.byAlign||{},'Piyasa Uyumu')+tbl(A.byReg||{},'Piyasa Rejimi')+tbl(A.byCost||{},'İşlem Maliyeti')+tbl(A.byExit||{},'Nasıl Kapanmış',1)}else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan trend sinyali yok.</div>';h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-6 mb-2 text-trade-purple">🐢 LT ÜÇGEN KIRILIMLARI (Simetrik)</div>';if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Tip')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Nasıl Kapanmış',1)}else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan LT kırılımı yok.</div>';return h}
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&s='+btS),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
var btErrCount = 0;
function pollBT(){
    fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){
        BT=d; btErrCount=0;
        if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut();
    }).catch(function(){
        btErrCount++;
        if(btErrCount>3 && tab==='bt' && $('btOut')){
            $('btOut').innerHTML='<div class="glass rounded-2xl p-5"><div class="text-sm text-amber-400"><b>Sunucu hesaplıyor...</b> (Büyük veri seti, lütfen bekleyin). Sayfayı yenilemeyin.</div></div>';
        }
    })
}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};return '<div class="glass rounded-2xl p-5"><h2 class="text-lg font-bold text-white mb-3"><i class="fa-solid fa-flask text-brand-400 mr-2"></i>Backtest</h2><div class="text-xs text-dark-muted mb-4">Geçmiş veri ile test. Sağlıklı sonuç için en az <b class="text-white">90 gün</b> ve <b class="text-white">40 coin</b> seç.</div>'+'<div class="flex flex-wrap gap-3 items-end">'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Ne test edilsin?</div><select onchange="btS=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs"><option value="trend"'+(btS==='trend'?' selected':'')+'>📈 PMax Trend</option><option value="lt"'+(btS==='lt'?' selected':'')+'>🐢 LT Üçgen</option></select></label>'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Kaç gün?</div><select onchange="btDays=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([30,60,90,180],btDays)+'</select></label>'+'<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Kaç coin?</div><select onchange="btN=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([20, 40, 60],btN)+'</select></label>'+'<button onclick="btStart()" class="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-bold"><i class="fa-solid fa-play mr-1"></i>Başlat</button></div></div>'}
function edgeTbl(e){if(!e||!e.length)return'';return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">Sinyal İsabeti</h3><div class="text-xs text-dark-muted mb-2">Sinyal geldikten sonra fiyat +kR hedefe ulaştı mı?</div><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2">Grup</th><th class="text-left py-2">Hedef</th><th class="text-right py-2">N</th><th class="text-right py-2">Ulaştı%</th><th class="text-right py-2">Rastgele%</th><th class="text-right py-2">Fark</th><th class="text-right py-2">z</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+e.map(function(x){var d=(x.hit-x.base)*100;return '<tr><td class="py-2 text-white">'+esc(x.g)+'</td><td class="py-2">+'+x.k+'R</td><td class="text-right py-2">'+x.n+'</td><td class="text-right py-2">'+f2(x.hit*100,0)+'</td><td class="text-right py-2">'+f2(x.base*100,0)+'</td><td class="text-right py-2 '+cl(d)+'">'+sg(d,0)+'</td><td class="text-right py-2 '+cl(x.z)+'">'+f2(x.z)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function btOut(){var b=BT;if(!b)return '';var sn=b.strategy==='trend'?('📈 PMax Trend ('+trendTf()+')'):'🐢 LT Üçgen';if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="glass rounded-2xl p-5"><div class="text-sm"><b class="text-white">Test sürüyor:</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') <span class="text-brand-400 font-mono">%'+pc+'</span></div><div class="mt-2 h-1 bg-dark-bg rounded-full overflow-hidden"><div class="h-full bg-brand-500" style="width:'+pc+'%"></div></div></div>'}if(b.err)return '<div class="glass rounded-2xl p-5 border border-trade-short/40 text-trade-short text-sm">Hata: '+esc(b.err)+'</div>';var r=b.result;if(!r)return'';if(!r.n)return '<div class="glass rounded-2xl p-5 text-sm">'+sn+': '+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.'+(r.skipped?'<div class="text-xs text-amber-400 mt-2">Atlanan coin: '+r.skipped+'</div>':'')+'</div>';var col=r.level==='g'?'border-trade-long':r.level==='r'?'border-trade-short':'border-trade-gold';var tc=r.level==='g'?'text-trade-long':r.level==='r'?'text-trade-short':'text-trade-gold';var humanVerdict='';if(r.n<100)humanVerdict='⚠️ Örneklem çok az ('+r.n+' işlem). Sonuca güvenme.';else if(r.tables.Genel['Tümü'].avgR<=0)humanVerdict='❌ Bu kurallarla geçmişte para kazanılmamış.';else if(r.tables.Genel['Tümü'].t>=2)humanVerdict='✅ İyi işaret: ortalama kâr pozitif.';else humanVerdict='⚠️ Karışık: ortalama kâr pozitif ama istikrar zayıf.';var h='<div class="glass rounded-2xl p-5 border-l-4 '+col+'"><b class="'+tc+' text-sm">Sonuç — '+sn+'</b><div class="text-xs text-dark-muted mt-2 leading-relaxed">'+humanVerdict+'</div></div>';var dt=function(x){return x?new Date(x).toISOString().slice(0,10):'—'};h+='<div class="text-xs text-dark-muted mt-3 font-mono">'+r.coins+' coin • '+r.days+' gün • '+r.n+' işlem • '+dt(r.tFrom)+' → '+dt(r.tTo)+' • veri %'+Math.round((r.coverage||0)*100)+(r.skipped?' • atlanan '+r.skipped:'')+'</div>';if(r.edge)h+=edgeTbl(r.edge);Object.keys(r.tables||{}).forEach(function(k){h+=tbl(r.tables[k],k)});return '<div class="mt-3">'+h+'</div>'}
function heatCell(x){var chg=Number(x.chg)||0,abs=Math.min(8,Math.abs(chg))/8;var bg,fg;if(chg>0.15){bg='rgba(0,224,160,'+(0.12+abs*0.75)+')';fg='#031a12'}else if(chg<-0.15){bg='rgba(255,77,109,'+(0.12+abs*0.75)+')';fg='#2a0612'}else{bg='rgba(38,50,79,.45)';fg='#c8d0e0'}return '<div class="heat-cell" data-kind="ins" data-sym="'+esc(x.sym)+'" style="background:'+bg+';color:'+fg+';aspect-ratio:1;border-radius:8px;padding:6px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;font-size:10px;font-weight:700;border:1px solid rgba(255,255,255,.06)"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(x.base)+'</div><div>'+sg(chg,1)+'%</div></div>'}
function fundRow(x){var r=x.ratePct||0,clx=r>0.01?'text-trade-short':r<-0.01?'text-trade-long':'text-dark-muted';return '<tr data-kind="ins" data-sym="'+esc(x.sym)+'"><td class="text-white font-bold">'+esc(x.base)+'</td><td class="text-dark-muted">'+fp(x.price)+'</td><td class="'+cl(x.chg)+'">'+sg(x.chg,1)+'%</td><td class="text-right '+clx+' font-bold">'+(r>0?'+':'')+f2(r,4)+'%</td></tr>'}
function insTable(title,icon,rows,th){if(!rows||!rows.length)return '<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-2"><i class="fa-solid '+icon+' text-brand-400 mr-1.5"></i>'+title+'</div><div class="text-dark-muted text-xs text-center py-4">veri bekleniyor…</div></div>';return '<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid '+icon+' text-brand-400 mr-1.5"></i>'+title+'</div><table class="w-full text-xs font-mono"><thead><tr>'+th+'</tr></thead><tbody>'+rows+'</tbody></table></div>'}
function renderDash(){var uni=(UNI&&UNI.list)||[];var hm=uni.slice().sort(function(a,b){return (b.vol||0)-(a.vol||0)}).slice(0,60);var heat='<div class="glass rounded-2xl p-4 mb-4"><div class="flex items-center justify-between mb-2"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted"><i class="fa-solid fa-fire text-trade-gold mr-1.5"></i>Isı Haritası — 24s değişim</div><div class="text-[10px] text-dark-muted font-mono">'+uni.length+' coin</div></div>'+(hm.length?'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:3px">'+hm.map(heatCell).join('')+'</div>':'<div class="text-dark-muted text-xs text-center py-6">yükleniyor…</div>')+'</div>';var fl=(FUND&&FUND.list)||[];var fund=insTable('Funding Rates','fa-money-bill-transfer',fl.map(fundRow).join(''),'<th class="text-left">Coin</th><th class="text-left">Fiyat</th><th class="text-left">24s</th><th class="text-right">Oran</th>');var m=(S.market)||{},R=S.regime||{};var pulse='<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid fa-heart-pulse text-trade-short mr-1.5"></i>Nabız</div><div class="grid grid-cols-2 gap-3"><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">BTC</div><div class="font-mono font-bold mt-1">'+fp(m.btc?m.btc.price:0)+'</div><div class="text-xs '+cl(m.btc?m.btc.chg:0)+' font-mono">'+sg(m.btc?m.btc.chg:0)+'%</div></div><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">ETH</div><div class="font-mono font-bold mt-1">'+fp(m.eth?m.eth.price:0)+'</div><div class="text-xs '+cl(m.eth?m.eth.chg:0)+' font-mono">'+sg(m.eth?m.eth.chg:0)+'%</div></div></div>'+(R.breadth?'<div class="mt-3 text-[11px] text-dark-muted">Genişlik: <b class="text-trade-long">↑'+R.breadth.up+'</b> / <b class="text-trade-short">↓'+R.breadth.dn+'</b></div>':'')+(R.funding&&R.funding.avg!=null?'<div class="mt-1 text-[11px] text-dark-muted">Funding: <b class="'+(R.funding.avg>0?'text-trade-long':'text-trade-short')+'">'+sg(R.funding.avg,3)+'%</b></div>':'')+'</div>';var sq=(S.forming||[]).slice(0,6);var sqh='<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid fa-compress text-trade-purple mr-1.5"></i>En Yakın LT Üçgenler</div>'+(sq.length?sq.map(function(x){return '<div class="sig-row LT" data-kind="ins" data-sym="'+esc(x.symbol)+'" style="cursor:pointer"><div class="flex justify-between items-center px-2 py-2 border-b border-dark-border/60"><span class="font-bold text-white text-xs">'+esc(x.base)+'</span><span class="text-[10px] text-dark-muted">'+esc(x.type)+'</span><span class="text-trade-purple font-mono text-xs font-bold">'+f2(Math.min(Math.abs(x.toUp),Math.abs(x.toDn)),2)+'</span></div></div>'}).join(''):'<div class="text-dark-muted text-xs text-center py-4">yok</div>')+'</div>';return heat+'<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">'+fund+pulse+'</div><div class="mt-4">'+sqh+'</div>'}
function renderMain(){var M=$('main');if(tab!=='bt'){var vKey=(tab||'')+'|'+(sel?sel.kind+'|'+sel.id+'|'+sel.sym:'')+'|'+(tfSel||'');if(M.getAttribute('data-view-key')===vKey && (Date.now()-(+M.getAttribute('data-view-t')||0))<15000){if(tab==='sig'||tab==='lt')renderListPanel();return}M.setAttribute('data-view-key',vKey);M.setAttribute('data-view-t',Date.now())}if(tab==='piyasa'||tab==='stat'||tab==='bt')M.removeAttribute('data-shell');if(tab==='piyasa'){M.innerHTML=renderDash();bindIns(M);return}if(tab==='stat'){M.innerHTML='<div class="glass rounded-2xl p-5">'+statView()+'</div>';return}if(tab==='bt'){M.innerHTML=btShell()+'<div id="btOut" class="mt-4">'+(BT?btOut():'')+'</div>';return}var o=sel&&sel.sym?selData():null;var detail='';if(o){var kind=sel.kind,tf=tfSel||defTf();var P=((kind==='tr'&&o.riskAbs)||kind==='brk'||(kind==='rad'&&o.broke&&o.entry!=null))?posInfo(o):null;var dir=o.dir||o.bias;var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100;var lvHtml='';if(P){var usd=P.r*ru;lvHtml='<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4"><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">'+(P.fin?'KAPANDI':'CANLI')+'</div><div class="text-2xl font-bold font-mono '+cl(P.r)+' mt-1">'+sg(P.r)+'R</div></div><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">Fiyat Farkı</div><div class="text-2xl font-bold font-mono '+cl(P.pct)+' mt-1">'+sg(P.pct)+'%</div></div><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">≈ K/Z (USDT)</div><div class="text-2xl font-bold font-mono '+cl(usd)+' mt-1">'+sg(usd)+'</div></div><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">En İyi / En Kötü</div><div class="text-2xl font-bold font-mono text-white mt-1">'+(o.mfe!=null?f2(o.mfe,1)+'/'+f2(o.mae||0,1):'—')+'</div></div></div>'}var lvGrid='';if(P){lvGrid='<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3"><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Şu Anki</div><div class="font-mono font-bold mt-0.5">'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</div></div><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Giriş</div><div class="font-mono font-bold text-trade-gold mt-0.5">'+fp(o.entry)+'</div></div><div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Kaybetme Sınırı</div><div class="font-mono font-bold text-trade-short mt-0.5">'+fp(o.stop)+'</div></div>'+(o.tp1!=null?'<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">1. Kâr Hedefi (bilgi)</div><div class="font-mono font-bold text-trade-long mt-0.5">'+fp(o.tp1)+'</div></div>':'')+'</div>'}var tfs=['5m','15m','1h','2h','4h'].map(function(t){return '<button class="'+(t===tf?'a':'')+' px-3 py-1.5 rounded-md text-[11px] font-bold font-mono text-dark-muted hover:text-white" data-tf="'+t+'">'+t.toUpperCase()+'</button>'}).join('');detail='<div class="glass rounded-2xl p-5 mb-5"><div class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-dark-border"><div class="flex items-center gap-3 min-w-0">'+dirBadge(dir)+'<div class="min-w-0"><h2 class="text-lg font-bold text-white flex items-center gap-2">'+esc(sel.sym.split('/')[0])+'<span class="text-xs text-dark-muted font-normal">/USDT.P</span>'+(kind==='brk'||kind==='rad'?'<span class="lt-badge">🐢 LT</span>':'<span class="lt-badge" style="background:rgba(59,130,246,.15);color:#3b82f6;border-color:rgba(59,130,246,.35)">📈 '+trendTf()+'</span>')+'</h2><p class="text-[11px] text-dark-muted">'+stratName(kind,o)+'</p></div></div><div class="flex items-center gap-2"><div class="flex gap-0.5 bg-dark-bg p-1 rounded-lg border border-dark-border">'+tfs+'</div><a href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sel.sym.split('/')[0])+'USDT.P&interval='+(tf==='5m'?'5':tf==='15m'?'15':tf==='2h'?'120':tf==='4h'?'240':'60')+'" target="_blank" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-[11px] text-white font-bold flex items-center gap-1.5"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>TV</a></div></div><div class="chart-grid relative w-full h-[440px] mt-4 rounded-xl bg-dark-bg/60 border border-dark-border overflow-hidden"><canvas id="cv"></canvas></div>'+lvHtml+lvGrid+statusReport(o)+'<div class="glass rounded-xl p-4 mt-4 text-xs text-dark-muted leading-relaxed">'+whyText(o,kind)+'</div><div class="glass rounded-xl p-4 mt-4"><div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider mb-2">Pozisyon Hesabı</div>'+calcBox(P?P.levels.entry:null,P?P.levels.stop:null)+'</div></div>';setTimeout(function(){var k=sel.sym+'|'+tf;if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||null,strat:stratName(kind,o),pnl:P?{r:P.r,pct:P.pct,fin:P.fin,lbl:(kind==='rad'?'ÇİZGİDEN':'CANLI')}:null},'cv')}else{var cv=$('cv');if(cv){var xx=cv.getContext('2d');cv.width=cv.clientWidth;cv.height=cv.clientHeight;xx.fillStyle='#7e8ca8';xx.font='12px Inter,sans-serif';xx.fillText('Grafik yükleniyor…',16,28)}}if(!chartCache[k]&&chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}Array.prototype.forEach.call(M.querySelectorAll('[data-tf]'),function(b){b.onclick=function(){setTf(b.dataset.tf)}});bindCalc()},0)}else if(tab==='lt'){detail='<div class="glass rounded-2xl p-6 text-center text-dark-muted"><i class="fa-solid fa-draw-polygon text-3xl mb-3 opacity-40 text-trade-purple"></i><div class="text-sm font-bold text-white mb-1">🐢 LT Üçgenler (Sadece Simetrik)</div><div class="text-xs max-w-md mx-auto leading-relaxed">Sistem <b class="text-white">büyük simetrik üçgenleri</b> izler.<br><br><b class="text-trade-purple">SIKIŞIYOR</b> = fiyat sıkışıyor<br><b class="text-amber-400">ÇİZGİ AŞILDI</b> = kırıldı ama teyit yok<br><b class="text-trade-long">KIRILIM</b> = sinyal üretildi (hacim ≥ 1.2x)<br><br>Listeden bir coine tıkla → detaylı açıklama görürsün.</div></div>'}else{var os_=(S.tr||[]).filter(isOp).length,ob_=(S.breakouts||[]).filter(isOp).length;detail='<div class="text-center py-20 text-dark-muted"><i class="fa-solid fa-satellite-dish text-4xl mb-4 opacity-30"></i><div class="text-sm font-bold text-white mb-1">Sinyal bekleniyor</div><div class="text-xs">Açık trend: <b class="text-white">'+os_+'</b> • Açık LT kırılım: <b class="text-white">'+ob_+'</b></div></div>'}if(M.getAttribute('data-shell')!==tab||!$('detailPane')||!$('listPanel')){M.innerHTML='<div class="grid grid-cols-1 lg:grid-cols-12 gap-5"><div id="detailPane" class="lg:col-span-8 flex flex-col gap-5"></div><div class="lg:col-span-4"><div class="glass rounded-2xl p-4 sticky top-32"><div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 flex items-center justify-between"><span><i class="fa-solid fa-bolt text-trade-purple mr-1.5"></i>'+(tab==='lt'?'LT Üçgenler':'Sinyal Akışı')+'</span><span id="lpCnt" class="text-dark-muted font-mono"></span></div><div id="listPanel" class="-mx-4 max-h-[calc(100vh-220px)] overflow-y-auto"></div></div></div></div>';M.setAttribute('data-shell',tab);$('listPanel').addEventListener('pointerdown',function(){lpHold=Date.now()})}$('detailPane').innerHTML=detail;renderListPanel();bindIns(M)}
function bindIns(M){Array.prototype.forEach.call(M.querySelectorAll('[data-kind="ins"]'),function(e){e.onclick=function(){var sym=e.dataset.sym;if(!sym)return;tab='lt';sel={kind:'rad',id:'',sym:sym};tfSel='2h';chartFor='';prefetch(sym,'2h');renderAll()}})}
function poll(){fetch(api('/api/state')).then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json()}).then(function(d){if(!d||d.error)throw new Error('bad');S=d;$('dot').className='w-2 h-2 rounded-full bg-trade-long pulse-dot';$('conn').textContent='Bağlı';try{checkBrk();checkTr();renderAll()}catch(e){console.error('render:',e)}var now=Date.now();if(now-insTick>30e3){insTick=now;fetchIns()}}).catch(function(err){console.warn('poll:',err&&err.message);$('dot').className='w-2 h-2 rounded-full bg-amber-500 pulse-dot';$('conn').textContent='Bağlantı bekleniyor...'})}
function fetchIns(){fetch(api('/api/universe')).then(function(r){return r.json()}).then(function(d){UNI=d;if(tab==='piyasa')refreshView()}).catch(function(){});fetch(api('/api/funding')).then(function(r){return r.json()}).then(function(d){FUND=d;if(tab==='piyasa')refreshView()}).catch(function(){})}
function renderAll(){renderTop();renderTabs();renderMain()}
addEventListener('resize',function(){if(S)try{refreshView()}catch(e){}});
setInterval(poll,3000);
setInterval(function(){if(tab==='bt')pollBT()},2000);
setInterval(function(){if(sel&&sel.sym){loadChart(sel.sym,tfSel||defTf())}},15000);
poll();
</script>
</body></html>`;

// ======================= HTTP =======================
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const authed = u => !!ADMIN_KEY && safeEq(u.searchParams.get('key') || '', ADMIN_KEY);
const uiOk = u => !UI_KEY || safeEq(u.searchParams.get('key') || '', UI_KEY);
const hits = new Map();
function rateOk(ip, max) { const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60e3); if (a.length >= max) { hits.set(ip, a); return false; } a.push(now); hits.set(ip, a); if (hits.size > 2000) hits.clear(); return true; }

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
        if (u.pathname === '/health') return json(res, 200, { ok: true, name: 'AlphaSon', version: 'v59.5', trendTf: TREND.TF, htfFilter: TREND.HTF_FILTER, triTf: TRI_TF, triSpace: CFG_LT.LOG ? 'log' : 'linear', trendOn: TREND.ON, trend: trendRun.dg || null, triangles: Object.keys(structLT).length, radar: triRadar.length, breakouts: brkEvents.length, trendN: trendSignals.length, regime: MKT_DIR, universe: universe.length, histCached: histCache.size, ltDepth, ltNear: ltNear.slice(0, 5), triFunnel: scan.funnel || null });
        if (u.pathname === '/api/reset' && req.method === 'POST') { if (!authed(u)) return json(res, 401, { error: 'yetkisiz' }); signals = []; trendSignals = []; brkEvents = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true }); }
        if (u.pathname === '/api/ltdebug') return json(res, 200, { tf: TRI_TF, look: CFG_LT.TRI_LOOK, cand: CFG_LT.TRI_CAND, depth: ltDepth, near: ltNear, funnel: scan.funnel || null, structCount: Object.keys(structLT).length });
        if (['/', '/index.html', '/api/state', '/api/candles', '/api/backtest', '/api/backtest/start', '/api/universe', '/api/funding', '/api/ltdebug'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/universe') return json(res, 200, apiUniverse());
        if (u.pathname === '/api/funding') return json(res, 200, await apiFunding());
        if (u.pathname === '/api/backtest') return json(res, 200, bt);
        if (u.pathname === '/api/backtest/start' && req.method === 'POST') {
            if (bt.running) return json(res, 409, { error: 'Backtest zaten çalışıyor' });
            if (!Object.keys(tickers).length) return json(res, 503, { error: 'Piyasa verisi henüz yüklenmedi' });
            if (!rateOk(ip + '|bt', 3)) return json(res, 429, { error: 'çok fazla istek' });
            const days = Math.min(180, Math.max(7, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            const sp = u.searchParams.get('s'); const strategy = ['trend', 'lt'].includes(sp) ? sp : 'lt';
            runBacktestJob(days, n, strategy);
            return json(res, 200, { ok: true, days, n, strategy });
        }
        if (u.pathname === '/api/candles') { if (!rateOk(ip, 120)) return json(res, 429, { error: 'çok fazla istek' }); return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || '')); }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

// ======================= START =======================
async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('evren:', universe.length, 'coin | toplam', scan.total, '| elenen: hacim<' + (CFG.MIN_VOL_USDT / 1e6) + 'M$', scan.drop.lowVol);
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(track, 15e3);
        setInterval(liveTick, 5000);
        setInterval(saveState, 15e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
        (async () => { await runScan(); })();
        setInterval(async () => { await runTrend(false); }, 5000);
        setInterval(async () => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; await runScan(); }
        }, 3000);
        log('AlphaSon v59.5 • PMax Trend (' + TREND.TF + ') + BTC/ETH 15m Yön + LT Üçgen (2h) + Order Flow • evren ' + universe.length + ' coin');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('unhandledRejection', e => log('UNHANDLED REJECTION:', e && e.stack ? e.stack : e));
process.on('uncaughtException', e => log('UNCAUGHT EXCEPTION:', e && e.stack ? e.stack : e));
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, planTrade, virtualPlan, CFG, CFG_LT,
    buildStruct, lineValues, calculateStrength, costFor, advance, grp, groupBy, strBucket, atrMean, aggregateN, hasGap, fillGaps,
    runBacktestJob, btSymbol, btTrend, btReport, getBt: () => bt,
    runTrend, trendEval, buildTREND, TREND, TREND_MS, LTP, brkCheck, getFlowData, getHtfPmax, htfDir, emaN, rmaN, atrSeries, adxSeries, volSma, trTrack, trStatsCalc, pmaxSeries, brkStatsCalc, shadowStatsCalc,
    getTr: () => trendSignals, getBrk: () => brkEvents, getShadow: () => ltShadow, fitLines, evalPair, getLtNear: () => ltNear, getLtDepth: () => ltDepth };
