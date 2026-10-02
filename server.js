'use strict';
// ============================================================
// SONER TRADE v28.1 — TEK DOSYA
//   KIRILIM : üçgen yapı + 15m onaylı kırılım
//             → BİLDİRİM + CANLI R TAKİBİ (entry/stop/TP1/TP2)
//   SİNYALLER: AI SCALP — RSI + MACD + BB + 9 faktör skoru
//   v28.1: Grafik titremesi düzeltildi (viewKey cache)
//          Kırılım kartlarına canlı R eklendi
//          Stop mesafeleri genişletildi (STOP_ATR15=1.5, AI_ATR_SL_MULT=1.8)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

// ======================= PİYASA YÖNÜ =======================
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const th = Math.tanh;
function ema(v, p) { const k = 2 / (p + 1); let e = v[0]; const o = [e]; for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); o.push(e); } return o; }
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
const trMean = (c, n) => { let s = 0; for (let i = c.length - n; i < c.length; i++) s += trAt(c, i); return s / n; };
function trendScore(c) { const cl = c.map(x => x[4]), e21 = ema(cl, 21), e50 = ema(cl, 50), n = cl.length - 1; const a = trMean(c, 14) || 1e-9; return 0.4 * th((cl[n] - e50[n]) / a / 2) + 0.3 * th((e21[n] - e50[n]) / a) + 0.3 * th((e21[n] - e21[n - 3]) / a * 2); }
function vwapScore(c5, a15) { const d0 = Math.floor(c5[c5.length - 1][0] / 86400e3) * 86400e3; let pv = 0, v = 0; for (const k of c5) if (k[0] >= d0) { const tp = (k[2] + k[3] + k[4]) / 3; pv += tp * k[5]; v += k[5]; } if (!v) return 0; return th((c5[c5.length - 1][4] - pv / v) / a15); }
function structScore(c15) { const w = c15.slice(-16); let hi = -Infinity, lo = Infinity; for (const k of w) { hi = Math.max(hi, k[2]); lo = Math.min(lo, k[3]); } return hi > lo ? 2 * (w[w.length - 1][4] - lo) / (hi - lo) - 1 : 0; }
function effRatio(c, n) { const s = c.slice(-n - 1); let path = 0; for (let i = 1; i < s.length; i++) path += Math.abs(s[i][4] - s[i - 1][4]); return path ? Math.abs(s[s.length - 1][4] - s[0][4]) / path : 0; }
function scoreOne(c5, c15, c1h) {
    if (c5.length < 110 || c15.length < 60 || c1h.length < 60) return null;
    const n5 = c5.length - 1, a5 = trMean(c5, 14) || 1e-9, a15 = trMean(c15, 14) || 1e-9;
    const comps = { t1h: trendScore(c1h), t15: trendScore(c15), mom: th((c5[n5][4] - c5[n5 - 12][4]) / (a5 * Math.sqrt(12)) / 1.5), vwap: vwapScore(c5, a15), str: structScore(c15) };
    const W = { t1h: 20, t15: 20, mom: 15, vwap: 10, str: 10 };
    let raw = 0; for (const k in W) raw += comps[k] * W[k];
    raw = raw / 75 * 100;
    const er = effRatio(c15, 24), damp = 0.6 + 0.4 * clamp(er / 0.35, 0, 1), vr = trMean(c5, 6) / (trMean(c5, 100) || 1e-9);
    return { score: raw * damp, er, vr, comps };
}
function createRegime() {
    const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
    const hist = new Map(); let cache = { t: 0, btc: null, eth: null }, sm = 0, dir = 'NÖTR', since = Date.now(), state = null;
    function breadth(tickers, universe, now) {
        let up = 0, dn = 0, n = 0; const chg = [];
        for (const s of universe) {
            const t = tickers[s]; if (!t || !t.last) continue;
            let h = hist.get(s); if (!h) { h = []; hist.set(s, h); } h.push([now, t.last]);
            while (h.length && now - h[0][0] > 16 * 60e3) h.shift();
            if (now - h[0][0] < 10 * 60e3) continue;
            const p = (t.last / h[0][1] - 1) * 100; chg.push(p); n++;
            if (p > 0.10) up++; else if (p < -0.10) dn++;
        }
        if (n < 20) return null;
        chg.sort((a, b) => a - b);
        return { up, dn, n, median: chg[n >> 1], score: clamp(((up - dn) / n) * 1.5) * 100 };
    }
    async function pull(ex, sym) {
        const now = Date.now();
        const [a, b, c] = await Promise.all([ex.fetchOHLCV(sym, '5m', undefined, 300), ex.fetchOHLCV(sym, '15m', undefined, 200), ex.fetchOHLCV(sym, '1h', undefined, 200)]);
        const cl = (x, ms) => x.filter(k => k[0] + ms <= now);
        return scoreOne(cl(a, 300e3), cl(b, 900e3), cl(c, 3600e3));
    }
    async function tick(ex, tickers, universe) {
        const now = Date.now(); const br = breadth(tickers, universe, now);
        if (now - cache.t > 30e3) {
            try { const [b, e] = await Promise.all([pull(ex, BTC), pull(ex, ETH)]); if (b && e) { cache.btc = b; cache.eth = e; } } catch (err) { }
            cache.t = now;
        }
        const { btc, eth } = cache; if (!btc || !eth) return state;
        let raw = 0.65 * btc.score + 0.35 * eth.score; if (br) raw = 0.55 * raw + 0.45 * br.score;
        sm = sm * 0.8 + raw * 0.2;
        const ENTER = 30, EXIT = 12, DWELL = 5 * 60e3;
        let nd = dir;
        if (dir === 'NÖTR') { if (sm >= ENTER) nd = 'LONG'; else if (sm <= -ENTER) nd = 'SHORT'; }
        else if (dir === 'LONG') { if (sm <= -ENTER) nd = 'SHORT'; else if (sm < EXIT) nd = 'NÖTR'; }
        else { if (sm >= ENTER) nd = 'LONG'; else if (sm > -EXIT) nd = 'NÖTR'; }
        if (nd !== dir && (now - since >= DWELL || Math.abs(sm) >= 60)) { dir = nd; since = now; }
        const er = (btc.er + eth.er) / 2, vr = Math.max(btc.vr, eth.vr);
        const regime = vr > 2.2 ? 'VOLATİL' : er < 0.18 ? 'YATAY' : 'TREND';
        state = { dir, score: Math.round(sm), raw: Math.round(raw), regime, er: Number(er.toFixed(2)), vr: Number(vr.toFixed(2)), since, updated: now,
            btc: { score: Math.round(btc.score) }, eth: { score: Math.round(eth.score) },
            breadth: br ? { up: br.up, dn: br.dn, n: br.n, median: Number(br.median.toFixed(2)) } : null };
        return state;
    }
    function chg(sym) { const h = hist.get(sym); if (!h || h.length < 2) return null; const a = h[0], b = h[h.length - 1]; return b[0] - a[0] < 10 * 60e3 ? null : (b[1] / a[1] - 1) * 100; }
    return { tick, chg, get state() { return state; } };
}

const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BT_FILE = path.join(DATA_DIR, 'backtest.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UI_KEY = process.env.UI_KEY || '';
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const TRI_TF = (process.env.TRI_TF || '1h').toLowerCase();
const TRI_MS = TRI_TF === '2h' ? H2 : TRI_TF === '1h' ? H1 : M15;
const SCAN_MS = M15;
const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

// ======================= AYARLAR =======================
const CFG = {
    UNIVERSE: num('UNIVERSE', 300),
    MIN_VOL_USDT: num('MIN_VOL', 1e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 3),
    UNIVERSE_MS: 5 * 60e3, KEEP: 500, SCAN_DELAY_MS: 8000,
    // Üçgen tespiti
    TRI_K: num('TRI_K', 3), TRI_LOOK: num('TRI_LOOK', 150), TRI_MIN_LEN: num('TRI_MIN_LEN', 15), TRI_MAX_LEN: num('TRI_MAX_LEN', 100),
    TRI_TOL_ATR: num('TRI_TOL_ATR', 0.30), TRI_WICK_ATR: num('TRI_WICK_ATR', 0.60), TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.20),
    TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 3), TRI_SQUEEZE: num('TRI_SQUEEZE', 0.85), TRI_FLAT: num('TRI_FLAT', 0.12), GRACE_MIN: num('GRACE_MIN', 30),
    // Radar / kırılım
    NEAR_ATR: num('NEAR_ATR', 0.4), BRK_SEE: num('BRK_SEE', 0.8), BRK_ATR: num('BRK_ATR', 0.15), BRK_VOL: num('BRK_VOL', 1.3),
    FRESH_MIN: num('FRESH_MIN', 5), MAX_CHASE: num('MAX_CHASE', 0.6), EARLY_ATR: num('EARLY_ATR', 0.35), EARLY_VOL: num('EARLY_VOL', 2.0),
    // Risk / hedef — GENİŞLETİLDİ
    STOP_ATR15: num('STOP_ATR15', 1.5),         // v27: 0.6 → v28.1: 1.5
    BRK_TP1_R: num('BRK_TP1_R', 1.0),
    BRK_TP2_R: num('BRK_TP2_R', 2.5),
    BRK_EXPIRE_H: num('BRK_EXPIRE_H', 12),
    MIN_RR: num('MIN_RR', 1.2), MAX_TP2R: num('MAX_TP2R', 5),
    MIN_STRENGTH: num('MIN_STRENGTH', 45), MAX_COST_R: num('MAX_COST_R', 0.35), EARLY_ON: num('EARLY_ON', 0),
    BK_MAX_ATR15: num('BK_MAX_ATR15', 2.5), MIN_SIG_VOL: num('MIN_SIG_VOL', 15e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    COOLDOWN_MIN: num('COOLDOWN_MIN', 45), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 5.0),
    TP1_R: num('TP1_R', 1.0), TRAIL_R: num('TRAIL_R', 1.0), MAX_HOLD_MS: num('MAX_HOLD_H', 6) * H1, TS_MS: num('TS_MIN', 90) * 60e3, TS_MFE: 0.3
};

// ======================= AI SCALP =======================
const AI = {
    RSI_PERIOD: num('AI_RSI_PERIOD', 14),
    RSI_LOW: num('AI_RSI_LOW', 30),
    RSI_HIGH: num('AI_RSI_HIGH', 70),
    MACD_FAST: num('AI_MACD_FAST', 12),
    MACD_SLOW: num('AI_MACD_SLOW', 26),
    MACD_SIGNAL: num('AI_MACD_SIGNAL', 9),
    BB_PERIOD: num('AI_BB_PERIOD', 20),
    BB_STDDEV: num('AI_BB_STDDEV', 2),
    ATR_PERIOD: num('AI_ATR_PERIOD', 14),
    ATR_SL_MULT: num('AI_ATR_SL_MULT', 1.8),    // v27: 1.0 → v28.1: 1.8
    TP_R: num('AI_TP_R', 2.0),
    MIN_CONFIDENCE: num('AI_MIN_CONF', 60),
    MIN_VOL: num('AI_MIN_VOL', 10e6),
    TOP: num('AI_TOP', 150),
    EXPIRE_MIN: num('AI_EXPIRE_MIN', 180),
    COOLDOWN_MIN: num('AI_COOLDOWN_MIN', 30),
    KEEP: 300,
    TG: num('AI_TG', 1),
    NOTIFY: num('AI_NOTIFY', 65)
};

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
const atrMean = (c, p = 14) => { if (c.length <= p) return 0; let s = 0; for (let i = c.length - p; i < c.length; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REQ_QUEUE = { last: 0, minGap: num('REQ_GAP_MS', 250) };
async function safeFetch(ex, sym, tf, limit, since) {
    const now = Date.now();
    const wait = REQ_QUEUE.minGap - (now - REQ_QUEUE.last);
    if (wait > 0) await sleep(wait);
    REQ_QUEUE.last = Date.now();
    let attempt = 0;
    while (attempt < 3) {
        try { const r = await ex.fetchOHLCV(sym, tf, since, limit); REQ_QUEUE.last = Date.now(); return r; }
        catch (e) {
            const msg = String(e.message || e);
            if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
                attempt++;
                const backoff = 2000 * Math.pow(2, attempt - 1);
                log('RATE LIMIT → ' + backoff + 'ms bekle (' + sym + ' ' + tf + ')');
                await sleep(backoff);
            } else throw e;
        }
    }
    throw new Error('Rate limit: ' + sym + ' ' + tf);
}

function aggregateN(c, baseMs, n) { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }
function emaSeries(v, p) { const out = new Array(v.length).fill(null); if (v.length < p) return out; let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e; const k = 2 / (p + 1); for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out; }
function smaSeries(v, p) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }
function stdDev(v, p) { const s = v.slice(-p); if (s.length < p) return 0; const m = s.reduce((a, b) => a + b, 0) / p; let sq = 0; for (const x of s) sq += (x - m) * (x - m); return Math.sqrt(sq / p); }
const clOf = a => a.map(x => x[4]);

function rsiSeries(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    let ag = gain / period, al = loss / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
        ag = (ag * (period - 1) + g) / period;
        al = (al * (period - 1) + l) / period;
        out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
}
function macdSeries(closes, fast, slow, signal) {
    const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
    const macd = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
    const valid = macd.filter(x => x != null);
    const sig = emaSeries(valid, signal);
    const out = new Array(closes.length).fill(null);
    let vi = 0;
    for (let i = 0; i < closes.length; i++) {
        if (macd[i] != null) {
            const s = sig[vi];
            if (s != null) out[i] = { macd: macd[i], signal: s, hist: macd[i] - s };
            vi++;
        }
    }
    return out;
}

// ======================= ÜÇGEN =======================
function pivots(c, end, K, from) { const hi = [], lo = []; for (let i = Math.max(K, from); i <= end - K; i++) { let isH = true, isL = true; for (let d = 1; d <= K && (isH || isL); d++) { if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false; if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false; } if (isH) hi.push({ i, p: c[i][2] }); if (isL) lo.push({ i, p: c[i][3] }); } return { hi, lo }; }
function fitLine(pts, c, end, atr, side, C) {
    const P = pts.slice(-8); let best = null;
    for (let a = 0; a < P.length - 1; a++) for (let b = a + 1; b < P.length; b++) {
        const A = P[a], B = P[b]; if (B.i - A.i < 3) continue;
        const s = (B.p - A.p) / (B.i - A.i); let ok = true;
        for (let x = A.i; x <= end; x++) { const ln = A.p + s * (x - A.i); if (side === 1 ? (c[x][4] > ln + C.TRI_CLOSE_ATR * atr || c[x][2] > ln + C.TRI_WICK_ATR * atr) : (c[x][4] < ln - C.TRI_CLOSE_ATR * atr || c[x][3] < ln - C.TRI_WICK_ATR * atr)) { ok = false; break; } }
        if (!ok) continue;
        const pts2 = []; for (const p of P) if (p.i >= A.i && Math.abs(p.p - (A.p + s * (p.i - A.i))) <= C.TRI_TOL_ATR * atr) pts2.push(p);
        if (pts2.length < 2) continue;
        const lastI = pts2[pts2.length - 1].i; if (end - lastI > 40) continue;
        const score = pts2.length * 1000 + (lastI - A.i) * 2;
        if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches: pts2.length, last: lastI, score, pts: pts2 };
    }
    return best;
}
function detectTriangle(c, end, C) {
    if (end < 50) return null;
    const atr = atrSeries(c, 14)[end]; if (!(atr > 0)) return null;
    const pv = pivots(c, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
    if (pv.hi.length < 2 || pv.lo.length < 2) return null;
    const R = fitLine(pv.hi, c, end, atr, 1, C), S = fitLine(pv.lo, c, end, atr, -1, C);
    if (!R || !S) return null;
    if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null;
    const xs = Math.max(R.i0, S.i0), len = end - xs;
    if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null;
    const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0);
    const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
    if (!(w0 > 0 && wN > 0)) return null;
    if (wN / w0 > C.TRI_SQUEEZE) return null;
    if (wN < 0.4 * atr) return null;
    const dsl = S.s - R.s; if (!(dsl > 0)) return null;
    const apex = end + wN / dsl; if (apex - end > 100) return null;
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
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0), lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);
    const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
    return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0,
        res: seg(tri.R, lineR), sup: seg(tri.S, lineS), hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
}

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0 }, dirty = false, lastScanSlot = 0;
const candleCache = new Map();
let triRadar = [], liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const struct = {}, volCache = new Map();
const regime = createRegime(); let REG = null;
let aiSignals = [], brkEvents = []; const aiSt = { running: false, last: 0, ms: 0, n: 0, dg: null };

// ======================= STATE =======================
function loadState() {
    try { const b = JSON.parse(fs.readFileSync(BT_FILE, 'utf8')); if (b && b.result) { b.running = false; bt = b; } } catch (e) { }
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => s && s.id && s.entry);
        aiSignals = (j.ai || []).filter(s => s && s.id && s.entry);
        brkEvents = (j.brk || []).filter(s => s && s.id);
        lastSig = j.lastSig || {};
        log('durum:', signals.length, 'arşiv,', aiSignals.length, 'AI,', brkEvents.length, 'kırılım');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        const cut = Date.now() - 24 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals: signals.slice(0, CFG.KEEP), lastSig, ai: aiSignals.slice(0, AI.KEEP), brk: brkEvents.slice(0, 200) }));
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
        const ok = all.filter(t => !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= CFG.MIN_VOL_USDT && !isSuspect(t.symbol));
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length;
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t.last, chg: t.percentage }; } }
    } catch (e) { log('evren hatası', e.message); }
}
async function fetchTriCandles(sym) {
    if (TRI_TF === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); return closedOnly(aggregateN(c1h, H1, 2), H2); }
    if (TRI_TF === '1h') return closedOnly(await safeFetch(ex, sym, '1h', 400), H1);
    return closedOnly(await safeFetch(ex, sym, '15m', 500), M15);
}
async function refreshTickers() {
    try {
        await sleep(200);
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t[s].last, chg: t[s].percentage }; }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}

// ======================= KIRILIM (üçgen) =======================
function mkSig(o) {
    const side = o.dir === 'LONG' ? 1 : -1, risk = side * (o.entry - o.stop), riskPct = risk / o.entry * 100;
    return { id: o.sym.replace(/[^A-Z0-9]/g, '') + '_' + o.time, symbol: o.sym, base: baseOf(o.sym), dir: o.dir,
        setup: 'TRI', setupName: 'Üçgen ' + o.type + ' • ' + (side === 1 ? 'yukarı' : 'aşağı') + ' kırılım (' + o.mode + ')',
        mode: o.mode, reg: o.reg || '-', strength: o.strength, entry: o.entry, stop: o.stop, initialStop: o.stop,
        tp1R: CFG.TP1_R, tp2R: o.tp2R, trail: CFG.TRAIL_R, atr: o.atr,
        tp1: o.entry + side * risk * CFG.TP1_R, tp2: o.entry + side * risk * o.tp2R,
        tsMs: CFG.TS_MS, tsMfe: CFG.TS_MFE, maxHold: CFG.MAX_HOLD_MS,
        riskPct: r2(riskPct), costR: r2(o.costPct / riskPct), volX: r2(o.volX), level: o.level,
        warnings: [], tri: o.triPack || null, time: o.time, lastPrice: o.entry, mfe: 0, mae: 0, trackedTo: o.trackedTo,
        status: 'OPEN', reason: o.reason };
}
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
const strLabel = s => s >= 75 ? 'ÇOK GÜÇLÜ' : s >= 55 ? 'GÜÇLÜ' : s >= 35 ? 'ORTA' : 'ZAYIF';
function brkMsg(e) {
    return '🔔 KIRILIM ' + (e.dir === 'LONG' ? '🟢 ' : '🔴 ') + e.dir + ' ' + e.base + ' — ' + e.type + ' üçgen ' + (e.dir === 'LONG' ? 'yukarı' : 'aşağı') +
        '\nGüç ' + e.strength + ' ' + strLabel(e.strength) + ' | Hacim ' + e.volX.toFixed(1) + 'x | Piyasa: ' + e.reg +
        '\nGiriş ' + fmt(e.entry) + ' | Stop ' + fmt(e.stop) + ' | TP1 ' + fmt(e.tp1) + ' | TP2 ' + fmt(e.tp2) +
        (e.costR != null ? '\nRisk %' + e.riskPct.toFixed(2) + ' | Maliyet ' + e.costR.toFixed(2) + 'R' : '') +
        '\n📈 ' + tvLink(e.base, 15);
}

function buildStruct(S, t0) {
    const o = { t: t0, lines: [] };
    if (S.c2 && S.c2.length >= 50) {
        const tri = detectTriangle(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = pack(tri, S.c2);
            o.tri = pk; o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type; o.w0 = tri.w0;
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
        if (avg > 0) {
            const prev = bk ? bk[5] : 0;
            if (cur) { el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15)); const proj = cur[5] / el; projX = proj / avg; const w = Math.min(1, el / 0.6); volX = (w * proj + (1 - w) * prev) / avg; }
            else volX = prev / avg;
        }
        const d = { volX, projX, el, bk, pv, avg15: avg, bkVolX: avgP > 0 && bk ? bk[5] / avgP : 0, atr15: n > 15 ? atrMean(closed, 14) : 0 };
        volCache.set(sym, { t: now, d }); return d;
    } catch (e) { const d = { volX: 0, projX: 0, el: 0, bk: null, pv: null, avg15: 0, bkVolX: 0, atr15: 0 }; volCache.set(sym, { t: now, d }); return d; }
}
function lineValues(st, now) { const out = {}; for (const L of st.lines) { const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0]; out[L.key] = dt ? a[1] + (b[1] - a[1]) * (now - a[0]) / dt : a[1]; } return out; }
function evalBreakout(st, dir, P, now, v) {
    if (!v.bk || !v.pv || !(v.avg15 > 0) || !(v.atr15 > 0)) return null;
    const atr = st.lines[0].atr, L = dir === 'LONG' ? 1 : -1, key = L === 1 ? 'R' : 'S';
    const at = t => lineValues(st, t)[key];
    const ext = L * (P - at(now)) / atr;
    if (ext < 0.05 || ext > CFG.MAX_CHASE) return null;
    const dBk = L * (v.bk[4] - at(v.bk[0] + M15));
    const dPv = L * (v.pv[4] - at(v.pv[0] + M15));
    const rng = (v.bk[2] - v.bk[3]) || 1e-9;
    const q = L === 1 ? (v.bk[4] - v.bk[3]) / rng : (v.bk[2] - v.bk[4]) / rng;
    if (dBk >= CFG.BRK_ATR * atr && dPv <= 0.05 * atr && q >= 0.55 && rng <= CFG.BK_MAX_ATR15 * v.atr15 && v.bkVolX >= CFG.BRK_VOL && now - (v.bk[0] + M15) <= CFG.FRESH_MIN * 60e3)
        return { mode: 'onaylı', ext, vol: v.bkVolX, q };
    return null;
}
function planTrade(st, dir, P, vals, v) {
    const L = dir === 'LONG' ? 1 : -1;
    const line = L === 1 ? vals.R : vals.S, opp = L === 1 ? vals.S : vals.R;
    // GENİŞLETİLMİŞ stop: karşı çizgiye kadar en az STOP_ATR15 * ATR, en az %0.5
    const stopFromLine = line - L * CFG.STOP_ATR15 * v.atr15;
    const stopFromPct = P - L * P * 0.005;
    let stop = L === 1 ? Math.max(stopFromLine, stopFromPct) : Math.min(stopFromLine, stopFromPct);
    stop = L === 1 ? Math.max(stop, opp) : Math.min(stop, opp);
    const risk = L * (P - stop); if (!(risk > 0)) return null;
    const riskPct = risk / P * 100;
    if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return null;
    const rawR = L * (line + L * st.w0 - P) / risk;
    if (rawR < CFG.MIN_RR) return null;
    return { stop, riskPct, tp1R: CFG.BRK_TP1_R, tp2R: Math.min(Math.max(rawR, CFG.BRK_TP2_R), CFG.MAX_TP2R), line };
}
function rsOf(sym) { const a = regime.chg(sym), b = regime.chg(BTC); return a == null || b == null ? null : a - b; }

// ======================= AI SCALP =======================
function whaleScore(vol24) { const v = vol24 || 0; return v > 5e6 ? 85 : v > 2e6 ? 75 : v > 1e6 ? 65 : v > 5e5 ? 55 : 30; }
function liqScore(vol24) { const v = vol24 || 0; return v > 3e6 ? 90 : v > 1.5e6 ? 75 : v > 5e5 ? 60 : v > 1e5 ? 45 : 25; }
function volScore(vol24) { const v = vol24 || 0; return v > 5e6 ? 95 : v > 2e6 ? 85 : v > 1e6 ? 75 : v > 5e5 ? 65 : v > 1e5 ? 50 : 30; }
function volaScore(pct) { const v = Number(pct) || 0; return v >= 3 && v <= 10 ? 80 : v > 10 && v <= 15 ? 60 : v > 15 && v <= 25 ? 40 : v > 25 ? 20 : 50; }
function techScoreAI(rsi, macd, bb, price) {
    let s = 50;
    if (rsi < 25) s += 20; else if (rsi < 30) s += 15; else if (rsi > 75) s -= 20; else if (rsi > 70) s -= 15;
    else if (rsi < 45) s += 8; else if (rsi > 55) s -= 8;
    if (macd && macd.macd > macd.signal) { s += macd.hist > 0 ? 15 : 8; } else { s -= macd && macd.hist < 0 ? 15 : 8; }
    if (bb && bb.upper > bb.lower) {
        const pos = (price - bb.lower) / (bb.upper - bb.lower);
        if (pos < 0.1) s += 12; else if (pos > 0.9) s -= 12; else if (pos < 0.3) s += 6; else if (pos > 0.7) s -= 6;
    }
    return Math.max(0, Math.min(100, s));
}
function assessRiskAI(currentCount, maxCount, priceChange24h, vol24) {
    let s = 60;
    if (currentCount >= maxCount) s -= 25;
    if (priceChange24h > 25 || priceChange24h < -25) s -= 15;
    if ((vol24 || 0) < 5e5) s -= 10;
    return Math.max(0, s);
}
function posDensityScore(count, maxCount) { return 100 - (count / maxCount) * 100; }
function aiDecide(o) {
    const matrix = {
        technical: o.tech, market: o.marketScore, risk: o.risk, whale: o.whale, liquidity: o.liquidity,
        volume: o.volume, volatility: o.vola, position: o.position, performance: 60
    };
    const total = matrix.technical * 0.35 + matrix.market * 0.15 + matrix.risk * 0.15 + matrix.whale * 0.10 + matrix.liquidity * 0.10
        + matrix.volume * 0.08 + matrix.volatility * 0.05 + matrix.position * 0.01 + matrix.performance * 0.01;
    const confidence = Math.min(100, Math.max(0, Math.round(total)));
    let execute = confidence >= AI.MIN_CONFIDENCE;
    let dir = matrix.technical >= 50 ? 'LONG' : 'SHORT';
    let reason = execute ? `AI ${confidence}% — ${dir}` : `AI RED ${confidence}%`;
    if (execute && matrix.whale < 30) { execute = false; reason = 'Balina aktivitesi düşük'; }
    if (execute && matrix.liquidity < 40) { execute = false; reason = 'Likidite düşük'; }
    if (execute && (matrix.volatility < 15 || matrix.volatility > 85)) { execute = false; reason = 'Volatilite uygun değil'; }
    return { execute, direction: dir, confidence, matrix, reason };
}
async function runAI() {
    if (aiSt.running || !universe.length) return;
    aiSt.running = true; const t0 = Date.now();
    try {
        const list = universe.filter(s => isMajor(s) || ((tickers[s] || {}).quoteVolume || 0) >= AI.MIN_VOL).slice(0, AI.TOP);
        for (const s of [BTC, ETH]) if (universe.includes(s) && !list.includes(s)) list.push(s);
        let idx = 0;
        const dg = { list: list.length, ok: 0, short: 0, stale: 0, sig: 0, err: 0, errMsg: '', t: t0 };
        const worker = async () => {
            while (idx < list.length) {
                const sym = list[idx++];
                try {
                    const c = closedOnly(await safeFetch(ex, sym, '15m', 200), M15, t0);
                    if (c.length < 60) { dg.short++; continue; }
                    const lastT = c[c.length - 1][0];
                    if (t0 - (lastT + M15) > 10 * 60e3) { dg.stale++; continue; }
                    dg.ok++;
                    const closes = clOf(c);
                    const rsi = rsiSeries(closes, AI.RSI_PERIOD);
                    const macdArr = macdSeries(closes, AI.MACD_FAST, AI.MACD_SLOW, AI.MACD_SIGNAL);
                    const bbMid = smaSeries(closes, AI.BB_PERIOD);
                    const sd = stdDev(closes, AI.BB_PERIOD);
                    const atr = atrSeries(c, AI.ATR_PERIOD);
                    const i = c.length - 1;
                    if (rsi[i] == null || macdArr[i] == null || bbMid[i] == null || atr[i] == null || !(atr[i] > 0)) continue;
                    const price = c[i][4];
                    const bbUpper = bbMid[i] + AI.BB_STDDEV * sd, bbLower = bbMid[i] - AI.BB_STDDEV * sd;
                    const tk = tickers[sym] || {};
                    const vol24 = tk.quoteVolume || 0;
                    const priceChange24h = tk.percentage || 0;
                    const b20 = c.slice(-21, -1); let av = 0; for (const x of b20) av += x[5]; av /= b20.length;
                    const volX = av > 0 ? c[i][5] / av : 1;
                    const high24 = Math.max.apply(null, c.slice(-96).map(x => x[2])), low24 = Math.min.apply(null, c.slice(-96).map(x => x[3]));
                    const volaPct = ((high24 - low24) / price) * 100;
                    const tech = techScoreAI(rsi[i], macdArr[i], { upper: bbUpper, lower: bbLower, middle: bbMid[i] }, price);
                    const risk = assessRiskAI(aiSignals.filter(x => x.status === 'OPEN').length, 5, priceChange24h, vol24);
                    const marketScore = REG && REG.dir !== 'NÖTR' ? (REG.score > 0 ? 60 : 40) : 50;
                    const whale = whaleScore(vol24);
                    const liquidity = liqScore(vol24);
                    const volume = volScore(vol24) * Math.min(1.5, Math.max(0.5, volX));
                    const vola = volaScore(volaPct);
                    const position = posDensityScore(aiSignals.filter(x => x.status === 'OPEN').length, 5);
                    const dec = aiDecide({ tech, marketScore, risk, whale, liquidity, volume, vola, position });
                    if (!dec.execute) continue;
                    const dir = dec.direction, L = dir === 'LONG' ? 1 : -1;
                    const stopDist = atr[i] * AI.ATR_SL_MULT;
                    const entry = price, stop = entry - L * stopDist;
                    const tp = entry + L * stopDist * AI.TP_R;
                    const id = 'AI_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + lastT;
                    if (aiSignals.some(x => x.id === id)) continue;
                    const cdKey = 'AI|' + sym;
                    if (t0 - (lastSig[cdKey] || 0) < AI.COOLDOWN_MIN * 60e3) continue;
                    lastSig[cdKey] = t0;
                    const riskPct = stopDist / entry * 100;
                    const costR = (costFor(vol24) + 2 * CFG.SLIP_PCT) / riskPct;
                    const sig = {
                        id, symbol: sym, base: baseOf(sym), dir, time: t0, candleT: lastT, price,
                        entry, stop, tp, tpR: AI.TP_R, riskAbs: stopDist, riskPct: r2(riskPct), costR: r2(costR),
                        rsi: r2(rsi[i]), macdHist: Number(macdArr[i].hist.toFixed(6)), bbPos: bbUpper > bbLower ? Number(((price - bbLower) / (bbUpper - bbLower)).toFixed(2)) : 0.5,
                        volX: r2(volX), volaPct: r2(volaPct), vol24: Number(vol24.toFixed(0)),
                        aligned: REG && REG.dir !== 'NÖTR' ? REG.dir === dir : null,
                        score: dec.confidence, parts: dec.matrix,
                        status: 'OPEN', lastPrice: price, mfe: 0, mae: 0
                    };
                    aiSignals.unshift(sig); dirty = true;
                    dg.sig++;
                    log('AI', dir, sig.base, 'puan', sig.score, 'risk %' + sig.riskPct, 'maliyet ' + sig.costR + 'R', 'RSI', sig.rsi.toFixed(1));
                    if (AI.TG && sig.score >= AI.NOTIFY) telegram(aiMsg(sig));
                } catch (e) { dg.err++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 120); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        aiSt.dg = dg;
        log('AI tarama: liste', dg.list, 'kontrol', dg.ok, 'kısa', dg.short, 'eski', dg.stale, 'hata', dg.err, 'sinyal', dg.sig, dg.errMsg ? '| ilk hata: ' + dg.errMsg : '');
        if (aiSignals.length > AI.KEEP) aiSignals.length = AI.KEEP;
        aiSt.n = list.length;
    } catch (e) { log('AI hata', e.message); }
    aiSt.last = Date.now(); aiSt.ms = aiSt.last - t0; aiSt.running = false;
}
function aiMsg(s) {
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + 'AI SCALP ' + s.dir + ' ' + s.base + ' (15m) — PUAN ' + s.score +
        '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' +
        '\nTP ' + fmt(s.tp) + ' (' + s.tpR + 'R)\nRSI ' + s.rsi.toFixed(1) + ' • Hacim ' + s.volX.toFixed(1) + 'x • Volatilite %' + s.volaPct.toFixed(2) +
        '\n📈 ' + tvLink(s.base, 15);
}
function aiTrack(now) {
    for (const s of aiSignals) {
        if (s.status !== 'OPEN') continue;
        const t = tickers[s.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = s.dir === 'LONG' ? 1 : -1, r = L * (P - s.entry) / s.riskAbs;
        s.lastPrice = P; s.mfe = Math.max(s.mfe, r); s.mae = Math.min(s.mae, r);
        let res = null;
        if (L * (P - s.stop) <= 0) { s.status = 'STOP'; res = -1; }
        else if (r >= s.tpR) { s.status = 'TP'; res = s.tpR; }
        else if (now - s.time > AI.EXPIRE_MIN * 60e3) { s.status = 'SÜRE'; res = r; }
        if (res != null) { s.closedAt = now; s.netR = r2(res - s.costR); dirty = true; }
    }
}
function brkTrack(now) {
    for (const b of brkEvents) {
        if (b.status !== 'OPEN') continue;
        if (b.riskAbs == null) continue;
        const t = tickers[b.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = b.dir === 'LONG' ? 1 : -1;
        const r = L * (P - b.entry) / b.riskAbs;
        b.lastPrice = P; b.mfe = Math.max(b.mfe || 0, r); b.mae = Math.min(b.mae || 0, r);
        let res = null;
        if (L * (P - b.stop) <= 0) { b.status = 'STOP'; res = -1; }
        else if (r >= CFG.BRK_TP2_R) { b.status = 'TP2'; res = CFG.BRK_TP2_R; }
        else if (r >= CFG.BRK_TP1_R) { b.status = 'TP1'; res = CFG.BRK_TP1_R; }
        else if (now - b.time > CFG.BRK_EXPIRE_H * H1) { b.status = 'SÜRE'; res = r; }
        if (res != null) { b.closedAt = now; b.netR = r2(res - (b.costR || 0)); dirty = true; }
    }
}
const aiBucket = s => s.score == null ? 'Puan yok' : s.score >= 80 ? 'Puan 80+' : s.score >= 65 ? 'Puan 65-79' : s.score >= 50 ? 'Puan 50-64' : 'Puan <50';
function aiStatsCalc() {
    const closed = aiSignals.filter(s => s.status !== 'OPEN' && s.netR != null);
    return {
        all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))),
        byScore: groupBy(closed, aiBucket), byDir: groupBy(closed, s => s.dir),
        byAlign: groupBy(closed, s => s.aligned === true ? 'yön uyumlu' : s.aligned === false ? 'yön ters' : 'yön nötr'),
        byRsi: groupBy(closed, s => s.rsi < 30 ? 'RSI <30' : s.rsi < 45 ? 'RSI 30-45' : s.rsi < 55 ? 'RSI 45-55' : s.rsi < 70 ? 'RSI 55-70' : 'RSI >70'),
        byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x'),
        byCost: groupBy(closed, s => s.costR <= 0.3 ? 'maliyet ≤0.3R' : s.costR <= 0.6 ? 'maliyet 0.3-0.6R' : 'maliyet >0.6R'),
        byExit: groupBy(closed, s => s.status)
    };
}
function brkStatsCalc() {
    const closed = brkEvents.filter(s => s.status !== 'OPEN' && s.netR != null);
    return {
        all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))),
        byStrength: groupBy(closed, strBucket), byDir: groupBy(closed, s => s.dir),
        byType: groupBy(closed, s => s.type), byExit: groupBy(closed, s => s.status)
    };
}

// ======================= CANLI MOTOR =======================
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        try { REG = (await regime.tick(ex, tickers, universe)) || REG; } catch (e) { }
        aiTrack(now);
        brkTrack(now);

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
            if (Math.abs(dS) <= CFG.NEAR_ATR || (dS < 0 && -dS <= CFG.BRK_SEE)) { if (!cand || Math.abs(dS) < Math.abs(cand.d)) cand = { bias: 'SHORT', d: dS, v: vals.S, line: 'alt çizgi' }; }
            if (!cand) continue;
            const L = cand.bias === 'LONG' ? 1 : -1;
            const broke = L * cand.d > 0.05;
            const v = await liveVol(sym), rs = rsOf(sym);
            const pre = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, Math.abs(cand.d), 0.7, cand.bias, rs);
            const aligned = REG && REG.dir !== 'NÖTR' ? REG.dir === cand.bias : null;
            rad.push({ symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type,
                volX: r2(v.volX), strength: pre, broke, rs: rs == null ? null : r2(rs), aligned,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)' });

            if (!broke) continue;
            const br = evalBreakout(st, cand.bias, P, now, v);
            if (!br) continue;
            const sk = 'BRK|' + sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && x.status === 'OPEN')) continue;
            const plan = planTrade(st, cand.bias, P, vals, v);
            if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, cand.bias, rs);
            const entry = P, stop = plan.stop;
            const riskAbs = L * (P - stop); if (!(riskAbs > 0)) continue;
            const riskPct = plan.riskPct;
            const costR = (costFor((tickers[sym] || {}).quoteVolume) + 2 * CFG.SLIP_PCT) / riskPct;
            const ev = {
                id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, symbol: sym, base: baseOf(sym), dir: cand.bias, time: now,
                price: P, line: cand.v, type: st.type, touches: st.touches, volX: r2(br.vol), ext: r2(br.ext), strength,
                aligned, rs: rs == null ? null : r2(rs), reg: REG ? REG.dir : '-',
                entry, stop, riskAbs, riskPct: r2(riskPct), costR: r2(costR),
                tp1: P + L * riskAbs * CFG.BRK_TP1_R, tp2: P + L * riskAbs * CFG.BRK_TP2_R,
                status: 'OPEN', lastPrice: P, mfe: 0, mae: 0
            };
            brkEvents.unshift(ev);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM', ev.dir, ev.base, ev.type, 'güç', strength, 'hacim', br.vol.toFixed(1), 'entry', fmt(P), 'stop', fmt(stop), 'risk %' + riskPct.toFixed(2));
            telegram(brkMsg(ev));
        }
        triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 40);
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function pruneLive() {
    for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
    for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
}

// ======================= POZİSYON (arşiv + backtest) =======================
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
                const list = bySym[sym]; const since = Math.min(...list.map(x => x.trackedTo));
                const raw = await safeFetch(ex, sym, '1m', 500, since), c = closedOnly(raw, M1);
                for (const s of list) { if (!isOpen(s)) continue; for (const k of c) { if (k[0] <= s.trackedTo) continue; s.trackedTo = k[0]; dirty = true; if (advance(s, k, M1) && !isOpen(s)) break; } }
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
            if (!s) continue;
            const c = s.c2, i = c.length - 1;
            if (t0 - (c[i][0] + TRI_MS) > 3 * TRI_MS) { delete struct[sym]; continue; }
            try {
                const stc = buildStruct(s, t0);
                if (stc && stc.lines && stc.lines.length) struct[sym] = stc;
                else if (!(struct[sym] && t0 - struct[sym].t < CFG.GRACE_MIN * 60e3)) delete struct[sym];
            } catch (e) { }
        }
        pruneLive();
        scan.last = Date.now(); scan.ms = scan.last - t0;
        log('tarama:', Object.keys(struct).length, 'üçgen (' + TRI_TF + ')');
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= BACKTEST (üçgen) =======================
const DAY = 86400e3;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;
const yieldLoop = () => new Promise(r => setImmediate(r));
async function btSymbol(sym, c1h, c15, vol24, startT) {
    const trades = [], busy = {}, lastT = {};
    let st = null, h = 0, lastH = -1;
    for (let k = 31; k < c15.length - 1; k++) {
        if (k % 300 === 0) await yieldLoop();
        const bk = c15[k], now = c15[k + 1][0];
        if (bk[0] < startT) continue;
        while (h < c1h.length && c1h[h][0] + H1 <= now) h++;
        if (h !== lastH && h >= 60) {
            lastH = h;
            const arr = c1h.slice(Math.max(0, h - 400), h);
            if (hasGap(arr, H1, CFG.TRI_LOOK)) st = null;
            else { const ns = buildStruct({ c2: arr }, now); if (ns.lines.length) st = ns; else if (st) st.dead = true; }
        }
        if (st && st.dead && now - st.t >= CFG.GRACE_MIN * 60e3) st = null;
        if (!st) continue;
        const vals = lineValues(st, now);
        if (!(vals.R > vals.S)) continue;
        const P = c15[k + 1][1];
        const w = c15.slice(k - 19, k + 1), pw = c15.slice(k - 20, k);
        const avg = w.reduce((a, x) => a + x[5], 0) / w.length, avgP = pw.reduce((a, x) => a + x[5], 0) / pw.length;
        const v = { bk, pv: c15[k - 1], avg15: avg, bkVolX: avgP > 0 ? bk[5] / avgP : 0, atr15: atrMean(c15.slice(k - 30, k + 1), 14), projX: 0, el: 0 };
        for (const dir of ['LONG', 'SHORT']) {
            if ((busy[sym] || 0) > now) continue;
            const sk = dir; if (now - (lastT[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            const br = evalBreakout(st, dir, P, now, v); if (!br) continue;
            const plan = planTrade(st, dir, P, vals, v); if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, dir, null);
            const costPct = costFor(vol24) + 2 * CFG.SLIP_PCT, costR = costPct / plan.riskPct;
            if (strength < CFG.MIN_STRENGTH || costR > CFG.MAX_COST_R || vol24 < CFG.MIN_SIG_VOL) continue;
            const sig = mkSig({ sym, dir, type: st.type, mode: 'onaylı', reg: '-', entry: P, stop: plan.stop, tp2R: plan.tp2R,
                atr: st.lines[0].atr, strength, costPct, volX: br.vol, level: plan.line, triPack: null, time: now, trackedTo: now, reason: '' });
            lastT[sk] = now;
            let done = false;
            for (let j = k + 1; j < c15.length; j++) if (advance(sig, c15[j], M15)) { done = true; break; }
            if (!done) continue;
            busy[sym] = sig.closedAt;
            trades.push({ sym, dir, type: st.type, strength, vol: r2(br.vol), ext: r2(br.ext), costR: sig.costR, riskPct: sig.riskPct,
                tp2R: r2(sig.tp2R), status: sig.status, netR: sig.netR, t: now });
        }
    }
    return trades;
}
function btReport(trades) {
    const t = trades.filter(x => x.netR != null).sort((a, b) => a.t - b.t);
    if (!t.length) return { n: 0 };
    const mid = Math.floor(t.length / 2), g = grp(t), a = grp(t.slice(0, mid)), b = grp(t.slice(mid));
    const days = {}; for (const x of t) { const d = new Date(x.t).toISOString().slice(0, 10); days[d] = (days[d] || 0) + x.netR; }
    const dv = Object.values(days);
    let level, verdict;
    if (t.length < 100) { level = 'w'; verdict = 'Örnek az (' + t.length + ' işlem). Sonuca güvenme.'; }
    else if (g.avgR <= 0) { level = 'r'; verdict = 'Bu kurallarla maliyetler sonrası kenar görünmüyor.'; }
    else if (g.t >= 2 && a.avgR > 0 && b.avgR > 0) { level = 'g'; verdict = 'Olumlu işaret: ortalama R pozitif, iki yarıda da pozitif, t ≥ 2.'; }
    else { level = 'w'; verdict = 'Karışık sonuç: ortalama R pozitif ama istikrarsız.'; }
    const volB = x => x.vol >= 2.5 ? 'hacim 2.5x+' : x.vol >= 1.8 ? 'hacim 1.8-2.5x' : 'hacim 1.3-1.8x';
    const extB = x => x.ext <= 0.3 ? 'çizgi ötesi ≤0.3' : x.ext <= 0.45 ? 'çizgi ötesi 0.3-0.45' : 'çizgi ötesi >0.45';
    const riskB = x => x.riskPct < 0.6 ? 'risk <0.6%' : x.riskPct < 1.2 ? 'risk 0.6-1.2%' : 'risk >1.2%';
    return { n: t.length, level, verdict, perDay: t.length / dv.length, worstDay: Math.min(...dv), bestDay: Math.max(...dv), tables: {
        'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b },
        'Yön': groupBy(t, x => x.dir), 'Üçgen tipi': groupBy(t, x => x.type), 'Güç': groupBy(t, strBucket),
        'Kırılım hacmi': groupBy(t, volB), 'Çizgi ötesi (ATR)': groupBy(t, extB), 'Risk %': groupBy(t, riskB), 'Çıkış': groupBy(t, x => x.status) } };
}
async function btFetchAll(xc, sym, tf, ms, from) {
    let since = from; const out = [], end = Date.now();
    for (let g = 0; g < 80 && since < end; g++) { const r = await xc.fetchOHLCV(sym, tf, since, 1000); if (!r.length) break; out.push(...r); const lt = r[r.length - 1][0]; if (lt < since) break; since = lt + ms; }
    const m = new Map(); for (const x of out) m.set(x[0], x);
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter(x => x[0] + ms <= end);
}
async function runBacktestJob(days, n) {
    if (bt.running) return;
    bt = { running: true, i: 0, total: 0, sym: '', days, n, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear &&
            !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= CFG.MIN_SIG_VOL && !isSuspect(t.symbol))
            .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
        bt.total = list.length;
        const start = Date.now() - days * DAY; let all = [], skipped = 0; const cov = [], covD = [];
        for (const t of list) {
            bt.sym = baseOf(t.symbol);
            try {
                const c15 = await btFetchAll(exBT, t.symbol, '15m', M15, start - 12 * H1);
                const c1h = await btFetchAll(exBT, t.symbol, '1h', H1, start - 9 * DAY);
                const cv = Math.min(1, c15.filter(x => x[0] >= start).length / (days * 96));
                cov.push(cv); covD.push({ s: baseOf(t.symbol), pct: cv, first: c15.length ? c15[0][0] : 0 });
                all = all.concat(await btSymbol(t.symbol, c1h, c15, t.quoteVolume, start));
            } catch (e) { skipped++; }
            bt.i++;
            await sleep(500);
        }
        bt.result = btReport(all);
        Object.assign(bt.result, { skipped, coins: list.length, requested: n, covDetail: covD.sort((a, b) => a.pct - b.pct).slice(0, 8), covLow: covD.filter(c => c.pct < 0.9).length, days, coverage: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : 0 });
    } catch (e) { bt.err = e.message; log('backtest hata', e.message); }
    bt.running = false; bt.finishedAt = Date.now();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BT_FILE, JSON.stringify(bt)); } catch (e) { }
}

// ======================= API =======================
function apiState() {
    const now = Date.now();
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = { all: grp(closed), byExit: groupBy(closed, s => s.status) };
    const px = {};
    for (const x of triRadar.concat(brkEvents.slice(0, 40), aiSignals.slice(0, 80))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now, mode: 'v28.1 • Kırılım(canlı R) + AI Scalp',
        px, market, regime: REG,
        ai: aiSignals.slice(0, 80), aiStats: aiStatsCalc(),
        aiInfo: { last: aiSt.last, ms: aiSt.ms, n: aiSt.n, minVol: AI.MIN_VOL, expire: AI.EXPIRE_MIN, tg: !!AI.TG, notify: AI.NOTIFY, top: AI.TOP, conf: AI.MIN_CONFIDENCE, dg: aiSt.dg || null },
        breakouts: brkEvents.slice(0, 80), brkStats: brkStatsCalc(),
        brkInfo: { tp1: CFG.BRK_TP1_R, tp2: CFG.BRK_TP2_R, expireH: CFG.BRK_EXPIRE_H, stopAtr: CFG.STOP_ATR15, cd: CFG.COOLDOWN_MIN },
        radar: triRadar, stats: st,
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.COOLDOWN_MIN },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible }
    };
}
async function apiCandles(sym, reqTf) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const useTf = reqTf || TRI_TF;
    const key = sym + '|' + useTf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let c, dur, tf;
    if (useTf === '5m') { c = await safeFetch(ex, sym, '5m', 400); dur = 5 * 60e3; tf = '5m'; }
    else if (useTf === '15m') { c = await safeFetch(ex, sym, '15m', 400); dur = M15; tf = '15m'; }
    else if (useTf === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); c = aggregateN(c1h, H1, 2); dur = H2; tf = '2H'; }
    else { c = await safeFetch(ex, sym, '1h', 400); dur = H1; tf = '1H'; }
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
.side{width:440px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
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
.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;color:var(--tx)}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:280px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v28.1</small></div>
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
var TABS=[['sig','AI Sinyaller'],['rad','Kırılım'],['stat','İstatistik'],['bt','Backtest']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='sig',sel=null,chartCache={},chartFor='',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),actx=null,lastSigT=0,lastAiT=0,toastT=null;
function $(id){return document.getElementById(id)}
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function strTag(s){var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};return '<span class="tag '+x.c+'">GÜÇ '+s+' '+x.l+'</span>'}
function volTag(v){var c=v>=1.5?'g':v>=1.0?'w':'r';return '<span class="tag '+c+'">Hacim '+f2(v,1)+'x</span>'}
function scTag(s){if(s==null)return '<span class="tag">puan yok</span>';var x=s>=80?['ÇOK GÜÇLÜ','g']:s>=65?['GÜÇLÜ','g']:s>=50?['ORTA','w']:['ZAYIF','r'];return '<span class="tag '+x[1]+'" style="font-weight:800">PUAN '+s+' '+x[0]+'</span>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.textContent=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastSigT});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('🔔 KIRILIM '+e.dir+' '+e.base+' — GÜÇ '+e.strength,function(){tab='rad';sel={sym:e.symbol};chartFor='';renderAll()})}}
function checkAi(){var a=S.ai||[],nt=(S.aiInfo||{}).notify||0,mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastAiT){lastAiT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastAiT&&x.score>=nt});if(mx>lastAiT)lastAiT=mx;
 if(nw.length){beep();setTimeout(beep,400);var s=nw[0];showToast('🔔 AI '+s.dir+' '+s.base+' — PUAN '+s.score,function(){tab='sig';sel={sym:s.symbol};chartFor='';renderAll()})}}

function renderTop(){var m=S.market,R=S.regime;
 if(!R)$('cReg').innerHTML='<b>Yön</b> <span class="fl">hesaplanıyor…</span>';
 else{var c=R.dir==='LONG'?'up':R.dir==='SHORT'?'dn':'fl';
  $('cReg').innerHTML='<b>Yön</b> <span class="'+c+'" style="font-weight:800">'+R.dir+'</span> <span class="'+c+'">'+sg(R.score,0)+'</span> <span class="fl">| '+R.regime+(R.breadth?' | ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'</span>'}
 $('cMkt').innerHTML='<b>Piyasa</b> <span class="fl">'+S.scan.universe+' coin</span>';
 $('cBTC').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 var A=(S.aiStats&&S.aiStats.today)||{totalR:0,n:0};
 var B=(S.brkStats&&S.brkStats.today)||{totalR:0,n:0};
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(A.totalR)+'">AI '+sg(A.totalR,1)+'R</span> <span class="fl">|</span> <span class="'+cl(B.totalR)+'">Kır '+sg(B.totalR,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var nt=(S.aiInfo||{}).notify||0,oc=(S.ai||[]).filter(function(x){return x.status==='OPEN'&&x.score>=nt}).length,nr=(S.radar||[]).length,nb=(S.breakouts||[]).filter(function(x){return x.status==='OPEN'}).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t[0]==='sig'?' ('+oc+')':t[0]==='rad'?' ('+nb+'/'+nr+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;if(tab==='bt')pollBT();$('main').removeAttribute('data-view');renderAll()}})}

function aiCard(s){var L=s.dir==='LONG'?1:-1,op=s.status==='OPEN',px=(S.px&&S.px[s.symbol])||s.lastPrice||s.entry,r=op?L*(px-s.entry)/s.riskAbs:null;
 var st={OPEN:['AÇIK','w'],TP:['TP ✓','g'],STOP:['STOP','r'],'SÜRE':['SÜRE','w']}[s.status]||['?',''];
 var pn=op&&r!=null?'<span class="sc '+cl(r)+'">'+sg(r)+'R</span>':(s.netR!=null?'<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>':'');
 return '<div class="card '+(L===1?'L':'S')+(sel&&sel.sym===s.symbol?' sel':'')+(op?'':' closed')+'" data-sym="'+esc(s.symbol)+'"><div class="r1"><span class="badge '+(L===1?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span>'+scTag(s.score)+'<span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop '+fp(s.stop)+'</span><span>TP '+fp(s.tp)+'</span><span>RSI '+f2(s.rsi,1)+'</span><span>'+volTag(s.volX)+'</span></div><div class="sub"><span>'+ago(s.time)+' önce</span></div></div>'}

function radCard(r){var s=r.strength||0;
 var al=r.aligned===true?'<span class="tag g">yön uyumlu</span>':r.aligned===false?'<span class="tag r">yön ters</span>':'';
 var rs=r.rs!=null?'<span class="tag '+(r.rs>0?'g':'r')+'">RS '+sg(r.rs)+'%</span>':'';
 return '<div class="card '+(r.bias==='LONG'?'L':'S')+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag '+(r.broke?'w':'')+'">'+(r.broke?'KIRILDI':'hazır')+'</span>'+strTag(s)+al+rs+'</div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function brkCard(e){
 var L=e.dir==='LONG'?1:-1, op=e.status==='OPEN', px=(S.px&&S.px[e.symbol])||e.lastPrice||e.entry||e.price;
 var r=null;
 if(e.entry!=null){r=op?L*(px-e.entry)/e.riskAbs:(e.netR!=null?e.netR:null);}
 var st={OPEN:['AÇIK','w'],TP1:['TP1 ✓','g'],TP2:['TP2 ✓','g'],STOP:['STOP','r'],'SÜRE':['SÜRE','w']}[e.status]||['?',''];
 var pn=(r!=null)?'<span class="sc '+cl(r)+'">'+sg(r)+'R</span>':'';
 var al=e.aligned===true?'<span class="tag g">uyumlu</span>':e.aligned===false?'<span class="tag r">ters</span>':'';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+(sel&&sel.sym===e.symbol?' sel':'')+'" data-sym="'+esc(e.symbol)+'"><div class="r1"><span class="badge '+(L===1?'L':'S')+'">'+e.dir+'</span><span class="coin">'+esc(e.base)+'</span><span class="tag w">'+esc(e.type||'')+'</span>'+strTag(e.strength||0)+volTag(e.volX||0)+'<span class="tag '+st[1]+'">'+st[0]+'</span>'+al+pn+'</div><div class="sub">'+
 (e.entry!=null?'<span>Giriş <b>'+fp(e.entry)+'</b></span><span>Stop <b class="zarar">'+fp(e.stop)+'</b></span><span>TP1 <b class="kar">'+fp(e.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(e.tp2)+'</b></span><span>'+ago(e.time)+' önce</span>':
  '<span>Fiyat <b>'+fp(e.price)+'</b></span><span>Çizgi '+fp(e.line)+'</span><span>'+f2(e.ext)+' ATR</span><span>'+ago(e.time)+' önce</span>')+
 '</div></div>'}

function renderList(){var h='';
 if(tab==='sig'){var a=S.ai||[];
  h='<div class="note" style="padding:6px 8px">AI Scalp • 15m • RSI+MACD+BB + 9 faktör skoru. Bildirim puan ≥ '+((S.aiInfo||{}).notify||65)+'.</div>';
  h+=a.length?a.map(aiCard).join(''):'<div class="note" style="padding:10px">Henüz sinyal yok.</div>'}
 else if(tab==='rad'){var ev=S.breakouts||[];
  var act=ev.filter(function(x){return x.status==='OPEN'});
  var closed=ev.filter(function(x){return x.status!=='OPEN'});
  h='<div class="note" style="padding:6px 8px">Üçgen çizgisini 15m kapanışla kıran coinler. Canlı R takip edilir.</div>';
  if(act.length)h+='<h3>Açık takipler ('+act.length+')</h3>'+act.map(brkCard).join('');
  if(closed.length)h+='<h3>Kapananlar</h3>'+closed.slice(0,15).map(brkCard).join('');
  h+='<h3>Radar</h3>';
  h+=(S.radar||[]).length?S.radar.map(radCard).join(''):'<div class="note" style="padding:10px">Yaklaşan yok.</div>'}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 $('list').innerHTML=h;
 Array.prototype.forEach.call($('list').querySelectorAll('.card'),function(e){e.onclick=function(){sel={sym:e.dataset.sym};chartFor='';$('main').removeAttribute('data-view');renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>'};
function statView(){var A=S.aiStats||{},B=S.brkStats||{},h='<h2>İstatistik</h2>';
 h+='<h3 style="color:var(--tx);font-size:14px">KIRILIM (canlı R)</h3>';
 if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Üçgen tipi')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Çıkış')}
 else h+='<div class="note">Henüz kapanan kırılım yok.</div>';
 h+='<h3 style="color:var(--tx);font-size:14px;margin-top:18px">AI Scalp</h3>';
 if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.byScore||{},'Puan aralığına göre')+tbl(A.byDir||{},'Yön')+tbl(A.byAlign||{},'Piyasa yönü')+tbl(A.byRsi||{},'RSI aralığı')+tbl(A.byVol||{},'Hacim')+tbl(A.byCost||{},'Maliyet / risk')+tbl(A.byExit||{},'Çıkış')+
  '<div class="note">Sonuçlar 8 sn\'lik fiyatla yaklaşık izlenir, maliyet düşülmüştür.</div>'}
 else h+='<div class="note">Henüz kapanan AI sinyali yok.</div>';
 return h}

function ckey(sym){return sym+'|'+(tab==='sig'?'15m':S.config.tf)}
function drawChart(d,levels,cid,sym){
 var c=$(cid||'cv');if(!c||!d||!d.c.length)return;
 var W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 var x=c.getContext('2d');x.setTransform(1,0,0,1,0,0);x.scale(dp,dp);
 var tri=d.tri,nc=d.c.length,n=nc+(tri?15:0);
 var L=8,R=100,T=12,B=20,PW=W-L-R,PH=H-T-B;
 var volH=70, priceH=PH-volH;
 var ti=function(t){return (t-d.c[0][0])/d.dur};
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 var lp0=(sym&&S.px&&S.px[sym])||d.c[nc-1][4];
 hi=Math.max(hi,lp0);lo=Math.min(lo,lp0);
 if(levels){[levels.entry,levels.stop,levels.tp1,levels.tp2].forEach(function(q){var v=Number(q);if(q!=null&&isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v);}});}
 var tl=[];
 if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*priceH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';
 for(var i=0;i<=4;i++){var gy=T+priceH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#4a5568',0.8);line(d.e21,'#6b7280',1.0);
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1;
 var vTop=priceH+40,vHeight=volH-20;
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';var h=(k[5]/vmax)*vHeight;x.fillStyle=col;x.globalAlpha=0.7;x.fillRect(X(i)-cw/2,vTop+vHeight-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#f2b84b';x.lineWidth=1.2;x.beginPath();var st=false;d.vsma.forEach(function(v,k){if(v==null||vmax<=0)return;var y=vTop+vHeight-(v/vmax)*vHeight;st?x.lineTo(X(k),y):(x.moveTo(X(k),y),st=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(function(l){x.strokeStyle='rgba(255,212,0,.75)';x.lineWidth=1.6;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='rgba(255,212,0,.85)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});
  x.restore()}
 if(levels){
  var drawLv=function(price,col,label){var v=Number(price);if(!isFinite(v))return;var y=Y(v);if(y<T-2||y>T+priceH+2)return;
   x.strokeStyle=col;x.lineWidth=1.2;x.globalAlpha=0.75;x.setLineDash([4,4]);x.beginPath();x.moveTo(L,y);x.lineTo(W-R,y);x.stroke();x.setLineDash([]);x.globalAlpha=1;
   x.fillStyle=col;x.font='bold 10px system-ui';x.fillText(label+' '+fp(v),W-R+4,y+3)};
  drawLv(levels.entry,'#f2b84b','GİRİŞ');drawLv(levels.stop,'#ff6b7a','SL');
  if(levels.tp1!=null)drawLv(levels.tp1,'#3ddc97','TP1');
  if(levels.tp2!=null)drawLv(levels.tp2,'#5aa9ff','TP2')}
 x.strokeStyle='rgba(255,255,255,.85)';x.lineWidth=1.2;x.beginPath();x.moveTo(L,Y(lp0));x.lineTo(W-R,Y(lp0));x.stroke();
 x.fillStyle='#e6ebf2';x.font='bold 11px system-ui';x.fillText(fp(lp0),W-R+4,Y(lp0)-4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText(d.tf+' • EMA21/50',L+4,H-5);
}
function loadChart(sym,tf,levels){fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym&&$('cv'))drawChart(d,levels,'cv',sym)}).catch(function(){})}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.removeAttribute('data-view');M.innerHTML=statView();return}
 if(tab==='bt'){M.removeAttribute('data-view');if(!$('btOut'))M.innerHTML=btShell();$('btOut').innerHTML=btOut();return}
 if(sel&&sel.sym){
  var ai=(S.ai||[]).find(function(x){return x.symbol===sel.sym});
  var b=(S.breakouts||[]).find(function(x){return x.symbol===sel.sym});
  var r=(S.radar||[]).find(function(x){return x.symbol===sel.sym});
  var hdr='';var levels=null;var tf=tab==='sig'?'15m':S.config.tf;
  var vk=tab+'|'+sel.sym+'|'+(ai?'ai':b?'b':'rad')+'|'+(ai?ai.id:b?b.id:'-');
  if(M.getAttribute('data-view')!==vk){
   M.setAttribute('data-view',vk);
   if(ai){var L=ai.dir==='LONG'?1:-1,op=ai.status==='OPEN',px=(S.px&&S.px[ai.symbol])||ai.lastPrice||ai.entry,rr=L*(px-ai.entry)/ai.riskAbs;
    hdr='<span class="badge '+(L===1?'L':'S')+'">'+ai.dir+'</span>'+scTag(ai.score)+'<span class="sc '+cl(op?rr:ai.netR)+'">'+sg(op?rr:ai.netR)+'R</span>';levels={entry:ai.entry,stop:ai.stop,tp1:ai.tp};}
   else if(b&&b.entry!=null){var L2=b.dir==='LONG'?1:-1,op2=b.status==='OPEN',px2=(S.px&&S.px[b.symbol])||b.lastPrice||b.entry,rr2=L2*(px2-b.entry)/b.riskAbs;
    hdr='<span class="badge '+(L2===1?'L':'S')+'">'+b.dir+'</span><span class="tag w">'+esc(b.type)+'</span>'+strTag(b.strength||0)+'<span class="sc '+cl(op2?rr2:b.netR)+'">'+sg(op2?rr2:b.netR)+'R</span>';
    levels={entry:b.entry,stop:b.stop,tp1:b.tp1,tp2:b.tp2};}
   else if(b){hdr='<span class="badge '+(b.dir==='LONG'?'L':'S')+'">'+b.dir+'</span><span class="tag w">KIRILDI</span>';}
   M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2>'+hdr+'<a class="btn tv" style="margin-left:auto" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval='+(tab==='sig'?'15':'60')+'" target="_blank">📈 TV</a></div>'+
   '<canvas id="cv"></canvas>'+
   (ai?'<div class="lv"><div><span>Anlık</span><b id="lvPx">'+fp((S.px&&S.px[ai.symbol])||ai.lastPrice)+'</b></div><div><span>Giriş</span><b>'+fp(ai.entry)+'</b></div><div><span>Stop</span><b class="zarar">'+fp(ai.stop)+'</b></div><div><span>TP</span><b class="kar">'+fp(ai.tp)+'</b></div><div><span>Risk</span><b>'+f2(ai.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(ai.costR)+'R</b></div><div><span>RSI</span><b>'+f2(ai.rsi,1)+'</b></div><div><span>Hacim</span><b>'+f2(ai.volX,1)+'x</b></div><div><span>MFE/MAE</span><b>'+f2(ai.mfe,1)+' / '+f2(ai.mae,1)+'R</b></div></div>':
    b&&b.entry!=null?'<div class="lv"><div><span>Anlık</span><b id="lvPx">'+fp((S.px&&S.px[b.symbol])||b.lastPrice)+'</b></div><div><span>Giriş</span><b>'+fp(b.entry)+'</b></div><div><span>Stop</span><b class="zarar">'+fp(b.stop)+'</b></div><div><span>TP1</span><b class="kar">'+fp(b.tp1)+'</b></div><div><span>TP2</span><b class="kar">'+fp(b.tp2)+'</b></div><div><span>Risk</span><b>'+f2(b.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(b.costR)+'R</b></div><div><span>MFE/MAE</span><b>'+f2(b.mfe||0,1)+' / '+f2(b.mae||0,1)+'R</b></div></div>':
    b?'<div class="lv"><div><span>Fiyat</span><b>'+fp(b.price)+'</b></div><div><span>Çizgi</span><b>'+fp(b.line)+'</b></div><div><span>Güç</span><b>'+b.strength+'</b></div><div><span>Hacim</span><b>'+f2(b.volX,1)+'x</b></div></div>':'')+
   calcBox(ai?ai.entry:(b&&b.entry!=null?b.entry:''),ai?ai.stop:(b&&b.stop!=null?b.stop:''));
   bindCalc();
  }
  // Sadece canlı fiyat ve grafiği güncelle (innerHTML'e dokunmadan)
  var pxNow=(S.px&&S.px[sel.sym]);
  if(pxNow!=null){var el=$('lvPx');if(el)el.textContent=fp(pxNow);}
  var k=sym+'|'+tf;
  if(chartCache[k])drawChart(chartCache[k],levels,'cv',sel.sym);
  if(chartFor!==k){chartFor=k;loadChart(sel.sym,tf,levels)}
  return}
 // home
 var R=S.regime,A=S.aiStats||{},Ad=A.today||{totalR:0,n:0},B2=S.brkStats||{},Bd=B2.today||{totalR:0,n:0};
 var rg=R?'<div class="note" style="color:var(--tx);font-size:12px"><b>Piyasa yönü:</b> '+R.dir+' (skor '+sg(R.score,0)+', rejim '+R.regime+')</div>':'<div class="note">Yön motoru ısınıyor.</div>';
 M.innerHTML='<h2>Panel</h2><div class="tiles">'+
 '<div class="tile"><div class="k">AI açık</div><div class="v">'+(S.ai||[]).filter(function(x){return x.status==='OPEN'}).length+'</div></div>'+
 '<div class="tile"><div class="k">AI bugün</div><div class="v '+cl(Ad.totalR)+'">'+sg(Ad.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Kırılım açık</div><div class="v">'+(S.breakouts||[]).filter(function(x){return x.status==='OPEN'}).length+'</div></div>'+
 '<div class="tile"><div class="k">Kırılım bugün</div><div class="v '+cl(Bd.totalR)+'">'+sg(Bd.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Radar</div><div class="v">'+(S.radar||[]).length+'</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Sistem</h3>'+rg+
 '<div class="note" style="color:var(--tx);font-size:12px">Sekmeler: AI Sinyaller (RSI+MACD+BB+9 faktör), Kırılım (üçgen + canlı R), İstatistik, Backtest. Soldan kart seç, sağda grafik açılır.</div></div>'}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}

var BT=null,btDays=30,btN=40;
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 return '<h2>Backtest (üçgen kırılımı)</h2><div class="box"><div class="note" style="color:var(--tx);font-size:12px;margin:0 0 8px">Üçgen kırılım kuralları. Giriş sonraki mumun açılışı, stop/hedef aynı mumdaysa STOP önce sayılır.</div><div class="frm"><label class="fl">Gün<br><select onchange="btDays=this.value">'+so([14,30,60,90],btDays)+'</select></label><label class="fl">Coin<br><select onchange="btN=this.value">'+so([20,40,60,100],btN)+'</select></label><button class="btn" onclick="btStart()">▶ Başlat</button></div></div><div id="btOut"></div>'}
function btOut(){var b=BT;if(!b)return '<div class="note">Yükleniyor…</div>';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="box"><b>Çalışıyor:</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') %'+pc+'</div>'}
 if(b.err)return '<div class="box zarar">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return '<div class="note">Henüz çalıştırılmadı.</div>';
 if(!r.n)return '<div class="box">'+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.</div>';
 var col=r.level==='g'?'var(--lg)':r.level==='r'?'var(--st)':'var(--am)';
 var h='<div class="box" style="border-color:'+col+'"><b style="color:'+col+'">Değerlendirme</b><div class="note" style="color:var(--tx);font-size:12px">'+esc(r.verdict)+'</div></div>';
 h+='<div class="note">'+r.coins+' coin • '+r.days+' gün • '+r.n+' işlem • bitiş '+ago(b.finishedAt)+' önce</div>';
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});return h}
function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){S=d;checkBrk();checkAi();$('dot').className='dot on';$('conn').textContent='Bağlı';renderAll()}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)renderMain()});
setInterval(poll,3000);
setInterval(function(){if(tab==='bt')pollBT()},2000);
setInterval(function(){
 if((tab==='sig'||tab==='rad')&&sel&&sel.sym){
  var tf=tab==='sig'?'15m':S.config.tf;
  var ai=(S.ai||[]).find(function(x){return x.symbol===sel.sym});
  var b=(S.breakouts||[]).find(function(x){return x.symbol===sel.sym});
  var levels=ai?{entry:ai.entry,stop:ai.stop,tp1:ai.tp}:(b&&b.entry!=null?{entry:b.entry,stop:b.stop,tp1:b.tp1,tp2:b.tp2}:null);
  loadChart(sel.sym,tf,levels);
 }},8000);
poll();
</script></body></html>`;

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
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v28.1', cfg: { AI_NOTIFY: AI.NOTIFY, AI_TOP: AI.TOP, AI_MIN_VOL: AI.MIN_VOL, AI_MIN_CONF: AI.MIN_CONFIDENCE, AI_ATR_SL_MULT: AI.ATR_SL_MULT, STOP_ATR15: CFG.STOP_ATR15, BRK_TP1_R: CFG.BRK_TP1_R, BRK_TP2_R: CFG.BRK_TP2_R, BRK_EXPIRE_H: CFG.BRK_EXPIRE_H, COOLDOWN_MIN: CFG.COOLDOWN_MIN }, tf: TRI_TF, triangles: Object.keys(struct).length, radar: triRadar.length, breakouts: brkEvents.length, openBreakouts: brkEvents.filter(b => b.status === 'OPEN').length, ai: aiSignals.length, aiDiag: aiSt.dg || null, universe: universe.length });
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; aiSignals = []; brkEvents = []; lastSig = {}; dirty = true; saveState();
            return json(res, 200, { ok: true });
        }
        if (['/', '/index.html', '/api/state', '/api/candles', '/api/backtest', '/api/backtest/start'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/backtest') return json(res, 200, bt);
        if (u.pathname === '/api/backtest/start' && req.method === 'POST') {
            if (bt.running) return json(res, 409, { error: 'Backtest zaten çalışıyor' });
            if (!Object.keys(tickers).length) return json(res, 503, { error: 'Piyasa verisi henüz yüklenmedi' });
            if (!rateOk(ip + '|bt', 3)) return json(res, 429, { error: 'çok fazla istek' });
            const days = Math.min(90, Math.max(7, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            runBacktestJob(days, n);
            return json(res, 200, { ok: true, days, n });
        }
        if (u.pathname === '/api/candles') {
            if (!rateOk(ip, 40)) return json(res, 429, { error: 'çok fazla istek' });
            return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || ''));
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
        (async () => { await runScan(); await runAI(); })();
        setInterval(async () => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; await runScan(); await runAI(); }
        }, 3000);
        log('SONER TRADE v28.1 • Kırılım + AI Scalp • evren ' + universe.length + ' coin • AI eşik ' + AI.MIN_CONFIDENCE + ' • Stop ATR x' + CFG.STOP_ATR15);
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, evalBreakout, planTrade, CFG,
    buildStruct, lineValues, calculateStrength, costFor, advance, mkSig, grp, groupBy, strBucket, atrMean, aggregateN, hasGap,
    runBacktestJob, btSymbol, btReport, getBt: () => bt,
    rsiSeries, macdSeries, aiDecide, runAI, aiTrack, brkTrack, getAi: () => aiSignals, getBrk: () => brkEvents };
