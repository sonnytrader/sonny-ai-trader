'use strict';
// ============================================================
// SONER TRADE v14.4 (TEK DOSYA) — HYBRID
//   - 2H üçgen tespiti, 15m kırılım onayı (hızlı + kaliteli)
//   - Piyasa yönü zorunlu (MKT_MODE=align)
//   - Aynı üçgen tekrar sinyal vermez (triSig)
//   - TB / PB / LV_SR kapalı
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
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1, D1 = 24 * H1;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';

const NON_CRYPTO = [
    'USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC',
    'PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','DXY','VIX','NASDAQ','SPX','NIKKEI','DAX',
    'OPENAI','ANTHROPIC','SPACEX','XAI','SAMSUNG','HYNIX','SKHY','SKHYNIX'
];

// ======================= ÜÇGEN MODÜLÜ =======================
const TRI = (() => {
    const AGG = Math.max(1, Math.round(Number(process.env.TRI_AGG) || 2));
    const DUR = AGG * H1;

    function cfg(num, flag) {
        return {
            ENABLE_TR: flag('ENABLE_TR', true),
            TRI_K: num('TRI_K', 3), TRI_LOOK: num('TRI_LOOK', 120),
            TRI_MIN_LEN: num('TRI_MIN_LEN', 18), TRI_MAX_LEN: num('TRI_MAX_LEN', 110),
            TRI_TOL_ATR: num('TRI_TOL_ATR', 0.35), TRI_WICK_ATR: num('TRI_WICK_ATR', 0.6), TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.15),
            TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 4), TRI_SQUEEZE: num('TRI_SQUEEZE', 0.7), TRI_FLAT: num('TRI_FLAT', 0.08),
            TRI_MAX_LIFE: num('TRI_MAX_LIFE', 1), TRI_REQ_HTF: flag('TRI_REQ_HTF', false),
            TRI_NEAR_ATR: num('TRI_NEAR_ATR', 0.8),
            TRI_BRK_ATR: num('TRI_BRK_ATR', 0.1), TRI_VOLX: num('TRI_VOLX', 1.2), TRI_BODY: num('TRI_BODY', 0.45),
            TRI_CLOSEPOS: num('TRI_CLOSEPOS', 0.65), TRI_MAX_EXT_ATR: num('TRI_MAX_EXT_ATR', 1.2),
            TRI_STOP_ATR: num('TRI_STOP_ATR', 0.25), TRI_MIN_RISK_PCT: num('TRI_MIN_RISK_PCT', 0.8), TRI_MAX_RISK_PCT: num('TRI_MAX_RISK_PCT', 10),
            TRI_MAX_COST_R: num('TRI_MAX_COST_R', 0.5), TRI_MIN_TP2R: num('TRI_MIN_TP2R', 1.5), TRI_CAP_R: num('TRI_CAP_R', 5),
            TRI_HOLD_MS: num('TRI_HOLD_H', 48) * H1, TRI_TS_MS: 6 * DUR
        };
    }
    const sigKey = C => [C.TRI_K, C.TRI_LOOK, C.TRI_MIN_LEN, C.TRI_MAX_LEN, C.TRI_TOL_ATR, C.TRI_WICK_ATR, C.TRI_CLOSE_ATR, C.TRI_MIN_TOUCH, C.TRI_SQUEEZE, C.TRI_FLAT].join(',');
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0);
    const lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);

    function atrAt(c, j, p = 14) {
        if (j < p) return 0;
        let s = 0;
        for (let i = j - p + 1; i <= j; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
        return s / p;
    }
    function volAvg(c, j, p = 20) {
        let s = 0, n = 0;
        for (let i = Math.max(0, j - p); i < j; i++) { s += c[i][5]; n++; }
        return n ? s / n : 0;
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
        const life = (end - xs) / Math.max(1e-9, apex - xs);
        return { type, end, atr, w0, wN, apex, len, life, R, S, touches: R.touches + S.touches };
    }
    function get(S, j2, C) {
        const m = S._tri || (S._tri = new Map()), k = j2 + '|' + sigKey(C);
        if (m.has(k)) return m.get(k);
        const t = j2 >= 60 ? detect(S.c2, j2 - 1, C) : null;
        m.set(k, t); return t;
    }
    function near(tri, c, j, price, tEnd, C) {
        const x = j + (tEnd - c[j][0]) / DUR, r = lineR(tri, x), s = lineS(tri, x), a = tri.atr;
        const dR = (r - price) / a, dS = (price - s) / a;
        const pk = Math.abs(dR) <= Math.abs(dS) ? { side: 1, d: dR, line: r } : { side: -1, d: dS, line: s };
        if (Math.abs(pk.d) > C.TRI_NEAR_ATR) return null;
        return { side: pk.side, dist: Math.abs(pk.d), over: pk.d < 0, line: pk.line, tri: { type: tri.type, touches: tri.touches, squeeze: tri.wN / tri.w0 } };
    }
    function pack(tri, c) {
        const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * DUR;
        const xEnd = Math.min(tri.apex, tri.end + 1 + 10);
        const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
        return { type: tri.type, touches: tri.touches, squeeze: Number((tri.wN / tri.w0).toFixed(2)), apex: tOf(tri.apex),
            res: seg(tri.R, lineR), sup: seg(tri.S, lineS),
            hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
    }
    function extra(c15, c1h, aggregateN, ptrMap) {
        const c2 = aggregateN(c1h, H1, AGG);
        return { c2, p2h: ptrMap(c15, c2, DUR) };
    }
    const aggregate = (c1h, aggregateN) => aggregateN(c1h, H1, AGG);
    return { cfg, detect, get, near, pack, extra, aggregate, AGG, DUR };
})();

const CFG = {
    MIN_SCORE: num('MIN_SCORE', 0),
    ENABLE_PB: false, ENABLE_SW: false,
    MKT_MODE: process.env.MKT_MODE || 'align',    // <<< DEĞİŞTİ: align
    MIN_ADX: num('MIN_ADX', 20),
    RS_LB: 24, RS_MIN: num('RS_MIN', 0),
    STOP_BUF_ATR: num('STOP_BUF_ATR', 0.30), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.6), MAX_RISK_PCT: 3.5,
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1), MAX_COST_R: num('MAX_COST_R', 0.18),
    ROOM_MIN: num('ROOM_MIN', 1.2), ROOM_LOOK: 96,
    EXIT_MODE: 'A', TP1_R: 1.0, TP2_R: 2.0, TRAIL_ATR: 2, CAP_R: 4,
    TIME_STOP_MS: 6 * M15, TIME_STOP_MFE: 0.3, MAX_HOLD_MS: 8 * H1,
    COOLDOWN_MS: 2 * H1, MAX_OPEN_PER_DIR: num('MAX_OPEN_PER_DIR', 4), MAX_OPEN_TOTAL: num('MAX_OPEN_TOTAL', 8),
    MAX_OPEN_SETUP: { PB: 0, SW: 0, TB: 0, TR: num('MAX_OPEN_TR', 3), LTR: num('MAX_OPEN_LTR', 3) },
    MAX_PER_SCAN: 3, DAY_STOP_R: -3,
    MAX_SIGNAL_AGE_MS: 5 * 60e3, SCAN_DELAY_MS: 8000,
    UNIVERSE: num('UNIVERSE', 250), MIN_VOL_USDT: num('MIN_VOL', 2e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, TRACK_MS: 15e3, UNIVERSE_MS: 5 * 60e3, KEEP: 1000,
    HEALTH_N: 30, HEALTH_MIN_R: 0,
    ENABLE_TB: false, TB_DON: 20, TB_COOLDOWN_MS: 12 * H1,
    TR_PAPER: false,
    BT_MIN_VOL: num('BT_MIN_VOL', 2e6),
    ENABLE_LIVE: flag('ENABLE_LIVE', true),
    LIVE_MS: num('LIVE_MS', 30000),
    LV_NEAR_ATR: num('LV_NEAR_ATR', 0.45),
    LV_TOUCH_ATR: num('LV_TOUCH_ATR', 0.08),
    LV_BRK_ATR: num('LV_BRK_ATR', 0.12),
    LV_MAX_EXT_ATR: num('LV_MAX_EXT_ATR', 1.0),
    LV_HOLD_TICKS: num('LV_HOLD_TICKS', 2),
    LV_VOL_NEAR: num('LV_VOL_NEAR', 1.3),
    LV_VOL_TOUCH: num('LV_VOL_TOUCH', 1.0),
    LV_VOL_BRK: num('LV_VOL_BRK', 1.0),
    LV_VOL_STRONG: num('LV_VOL_STRONG', 1.5),
    LV_STOP_ATR: num('LV_STOP_ATR', 0.6),
    LV_SR: false,
    LV_CD_NEAR_MIN: num('LV_CD_NEAR_MIN', 60), LV_CD_BRK_MIN: num('LV_CD_BRK_MIN', 90), LV_SYM_GAP_MIN: num('LV_SYM_GAP_MIN', 20),
    LV_TG_MAX_H: num('LV_TG_MAX_H', 30), LV_MAX_VOLFETCH: num('LV_MAX_VOLFETCH', 14),
    LV_STALE_MS: 45 * 60e3,
    LV_LIVE_SIG: flag('LV_LIVE_SIG', true),
    LV_LIVE_MIN_VOL: num('LV_LIVE_MIN_VOL', 1.5),
    LV_LIVE_MAX_RISK: num('LV_LIVE_MAX_RISK', 8),
    LV_LIVE_COOLDOWN_MS: num('LV_LIVE_COOLDOWN_H', 6) * H1,
    TRI_AGG: num('TRI_AGG', 2),
    TRI_K: num('TRI_K', 3), TRI_LOOK: num('TRI_LOOK', 120),
    TRI_MIN_LEN: num('TRI_MIN_LEN', 18), TRI_MAX_LEN: num('TRI_MAX_LEN', 110),
    TRI_TOL_ATR: num('TRI_TOL_ATR', 0.35), TRI_WICK_ATR: num('TRI_WICK_ATR', 0.6), TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.15),
    TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 4), TRI_SQUEEZE: num('TRI_SQUEEZE', 0.7), TRI_FLAT: num('TRI_FLAT', 0.08),
    TRI_MAX_LIFE: num('TRI_MAX_LIFE', 1), TRI_REQ_HTF: flag('TRI_REQ_HTF', false),
    TRI_NEAR_ATR: num('TRI_NEAR_ATR', 0.8),
    TRI_BRK_ATR: num('TRI_BRK_ATR', 0.1), TRI_VOLX: num('TRI_VOLX', 1.2), TRI_BODY: num('TRI_BODY', 0.45),
    TRI_CLOSEPOS: num('TRI_CLOSEPOS', 0.65), TRI_MAX_EXT_ATR: num('TRI_MAX_EXT_ATR', 1.2),
    TRI_STOP_ATR: num('TRI_STOP_ATR', 0.25), TRI_MIN_RISK_PCT: num('TRI_MIN_RISK_PCT', 0.8), TRI_MAX_RISK_PCT: num('TRI_MAX_RISK_PCT', 10),
    TRI_MAX_COST_R: num('TRI_MAX_COST_R', 0.5), TRI_MIN_TP2R: num('TRI_MIN_TP2R', 1.5), TRI_CAP_R: num('TRI_CAP_R', 5),
    TRI_HOLD_MS: num('TRI_HOLD_H', 48) * H1, TRI_TS_MS: 12 * H1,
    ENABLE_TR: flag('ENABLE_TR', true)
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
const last = a => a[a.length - 1];
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };

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
    for (let i = p + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return o;
}
function adxSeries(c, p = 14) {
    const n = c.length, o = new Array(n).fill(null); if (n < p * 2 + 2) return o;
    const dm = i => { const up = c[i][2] - c[i - 1][2], dn = c[i - 1][3] - c[i][3]; return [up > dn && up > 0 ? up : 0, dn > up && dn > 0 ? dn : 0]; };
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i <= p; i++) { const m = dm(i); trS += trAt(c, i); pS += m[0]; mS += m[1]; }
    const dxAt = () => { const pd = trS ? 100 * pS / trS : 0, md = trS ? 100 * mS / trS : 0, s = pd + md; return s ? 100 * Math.abs(pd - md) / s : 0; };
    const dxs = [dxAt()]; let adx = null;
    for (let i = p + 1; i < n; i++) {
        const m = dm(i);
        trS = trS - trS / p + trAt(c, i); pS = pS - pS / p + m[0]; mS = mS - mS / p + m[1];
        dxs.push(dxAt()); const k = dxs.length;
        if (k === p) { adx = dxs.reduce((a, b) => a + b, 0) / p; o[i] = adx; }
        else if (k > p) { adx = (adx * (p - 1) + dxs[k - 1]) / p; o[i] = adx; }
    }
    return o;
}
function volSma(c, p = 20) {
    const o = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; }
    return o;
}
function feats(c) { const cl = c.map(x => x[4]); return { c, cl, e21: emaSeries(cl, 21), e50: emaSeries(cl, 50), atr: atrSeries(c), rsi: rsiSeries(cl), adx: adxSeries(c), vsma: volSma(c, 20) }; }
function trendSeries(f, minSpread) {
    const o = new Array(f.cl.length).fill(0);
    for (let i = 0; i < o.length; i++) {
        const a = f.e21[i], b = f.e50[i]; if (a == null || b == null) continue;
        const sp = (a - b) / f.cl[i] * 100;
        o[i] = sp >= minSpread && f.cl[i] > b ? 1 : sp <= -minSpread && f.cl[i] < b ? -1 : 0;
    }
    return o;
}
function ptrMap(c, cH, dur) {
    const o = new Array(c.length); let p = -1;
    for (let i = 0; i < c.length; i++) { const t = c[i][0] + M15; while (p + 1 < cH.length && cH[p + 1][0] + dur <= t) p++; o[i] = p; }
    return o;
}
function buildSym(c15, c1h, c4h) {
    const f15 = feats(c15), f1h = feats(c1h), f4h = feats(c4h);
    return { f15, f1h, f4h, t15: trendSeries(f15, 0.08), t1h: trendSeries(f1h, 0.10), t4h: trendSeries(f4h, 0.15),
        p1h: ptrMap(c15, c1h, H1), p4h: ptrMap(c15, c4h, 4 * H1), ...TRI.extra(c15, c1h, aggregateN, ptrMap) };
}
function rsAt(c, i, btcMap, lb) {
    if (!btcMap || i < lb) return null;
    const a = btcMap.get(c[i][0]), b = btcMap.get(c[i - lb][0]);
    if (a == null || b == null) return null;
    return ((c[i][4] / c[i - lb][4] - 1) - (a / b - 1)) * 100;
}

// ------------------------- STRATEJİ: HYBRID TR -------------------------
function signalAt(S, i, ctx) {
    const C = ctx.cfg || CFG, f = S.f15, c = f.c;
    if (i < 80) return { signal: null, reason: 'veri az' };
    const atr = f.atr[i], adx = f.adx[i], rv = f.rsi[i], vs = f.vsma[i];
    const j1 = S.p1h[i], j4 = S.p4h[i];
    if ([atr, adx, rv, vs].some(x => x == null) || j1 < 1 || j4 < 1) return { signal: null, reason: 'veri az' };
    const k0 = c[i], price = k0[4], h1 = S.t1h[j1], h4 = S.t4h[j4], t15 = S.t15[i], mkt = ctx.mkt || 0, rsv = ctx.rs;
    const minScore = ctx.minScore != null ? ctx.minScore : C.MIN_SCORE;
    const rng = (k0[2] - k0[3]) || 1e-12, body = Math.abs(k0[4] - k0[1]) / rng, cp = (k0[4] - k0[3]) / rng;
    const volX15 = vs > 0 ? k0[5] / vs : 0;
    const mktOK = side => C.MKT_MODE === 'align' ? mkt === side : C.MKT_MODE === 'off' ? true : mkt !== -side;

    const buildTR = side => {
        if (!C.ENABLE_TR || !S.c2 || !S.p2h) return null;
        const j2 = S.p2h[i];
        if (j2 == null || j2 < 60) return null;
        const tri = TRI.get(S, j2, C);
        if (!tri) return side === 1 ? { fail: 'tr üçgen yok', stage: 1 } : null;
        if (tri.life > C.TRI_MAX_LIFE) return side === 1 ? { fail: 'tr apex yakın', stage: 2 } : null;
        const triKey = ctx.sym + '|' + tri.R.i0 + '|' + tri.S.i0;
        if (ctx.triSig && ctx.triSig.has(triKey)) return side === 1 ? { fail: 'tr tekrar', stage: 2 } : null;

        // HYBRID: 15m kapanış fiyatı, 2H çizgisine göre kırılım kontrolü
        const L = side === 1;
        const lineNow = L ? (tri.R.p0 + tri.R.s * (j2 - tri.R.i0)) : (tri.S.p0 + tri.S.s * (j2 - tri.S.i0));
        const buf = tri.atr * C.TRI_BRK_ATR;
        const brkOK = L ? (k0[4] > lineNow + buf) : (k0[4] < lineNow - buf);
        if (!brkOK) return side === 1 ? { fail: 'tr kırılım yok (15m)', stage: 2 } : null;

        // 15m mum kalitesi
        if (body < C.TRI_BODY || (L ? cp < C.TRI_CLOSEPOS : cp > 1 - C.TRI_CLOSEPOS)) return side === 1 ? { fail: 'tr zayıf mum 15m', stage: 3 } : null;
        // 15m hacim
        if (volX15 < C.TRI_VOLX) return side === 1 ? { fail: 'tr hacim düşük 15m', stage: 4 } : null;
        // uzamış mı?
        const ext = Math.abs(k0[4] - lineNow) / tri.atr;
        if (ext > C.TRI_MAX_EXT_ATR) return side === 1 ? { fail: 'tr uzamış 15m', stage: 5 } : null;

        if (!mktOK(side)) return { fail: 'tr piyasa ters (align)', stage: 3 };
        if (C.TRI_REQ_HTF && (h1 === -side || h4 === -side)) return { fail: 'tr htf ters', stage: 3 };

        const L2 = L, entry = price, ref = L2 ? Math.min(k0[3], lineNow) : Math.max(k0[2], lineNow);
        const stop = ref - side * C.TRI_STOP_ATR * tri.atr, risk = side * (entry - stop);
        if (!(risk > 0)) return { fail: 'tr risk', stage: 9 };
        const riskPct = risk / entry * 100;
        if (riskPct < C.TRI_MIN_RISK_PCT || riskPct > C.TRI_MAX_RISK_PCT) return { fail: 'tr risk aralığı', stage: 9 };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.TRI_MAX_COST_R) return { fail: 'tr maliyet', stage: 10 };
        let tp2R = side * ((lineNow + side * tri.w0) - entry) / risk;
        if (tp2R < C.TRI_MIN_TP2R) return { fail: 'tr hedef kısa', stage: 11 };
        tp2R = Math.min(tp2R, C.TRI_CAP_R);

        const warnings = [];
        if (h1 === -side) warnings.push('1H ters');
        if (rsv != null && side * rsv < 0) warnings.push('BTC\'den zayıf');

        if (ctx.triSig) ctx.triSig.add(triKey);

        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup: 'TR',
            setupName: 'Üçgen Kırılımı ' + TRI.AGG + 'H → 15m onay (' + tri.type + ')',
            score: 0, parts: {}, warnings,
            entry, stop, initialStop: stop, mode: 'A', tp1R: 1, tp2R, capR: C.CAP_R, trail: C.TRAIL_ATR, atr: tri.atr,
            tp1: entry + side * risk, tp2: entry + side * risk * tp2R, tsMs: C.TRI_TS_MS, tsMfe: 0.3, maxHold: C.TRI_HOLD_MS,
            riskPct, costR, volX: volX15, adx, rsi: rv, room: tp2R, rs: rsv, trend: t15, trend1h: h1, trend4h: h4, mkt,
            time: k0[0] + M15, candleT: k0[0], level: lineNow, lastPrice: entry, mfe: 0, mae: 0, tri: TRI.pack(tri, S.c2),
            reason: tri.type + ' • ' + tri.touches + ' dokunuş • 15m hacim ' + volX15.toFixed(1) + 'x • ölçülü hedef ' + tp2R.toFixed(1) + 'R'
        } };
    };

    const cands = [];
    for (const side of [1, -1]) {
        const r = buildTR(side);
        if (r && r.sig) cands.push(r.sig);
    }
    if (cands.length) { return { signal: cands[0], reason: 'sinyal' }; }

    let near = null;
    if (ctx.watch && C.ENABLE_TR && S.c2 && S.p2h && S.p2h[i] >= 60) {
        const j2 = S.p2h[i], tri = TRI.get(S, j2, C);
        if (tri) { const nr = TRI.near(tri, S.c2, j2, price, k0[0] + M15, C); if (nr) near = { side: nr.side, dist: nr.dist, e21: nr.line, trigger: nr.line, tr: nr }; }
    }
    return { signal: null, reason: 'bekliyor', near };
}

// ------------------------- İŞLEM TAKİBİ -------------------------
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';
function closeSig(s, status, gross, t) { s.status = status; s.grossR = Number(gross.toFixed(3)); s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', sg = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop), rA = p => sg * (p - s.entry) / risk;
    s.mfe = Math.max(s.mfe || 0, rA(L ? k[2] : k[3])); s.mae = Math.min(s.mae || 0, rA(L ? k[3] : k[2]));
    s.lastPrice = k[4];
    const end = k[0] + dur, el = k[0] - s.time, hitStop = L ? k[3] <= s.stop : k[2] >= s.stop, T1 = s.tp1R, T2 = s.tp2R;
    if (s.mode === 'T') {
        if (hitStop) { const r = rA(s.stop); closeSig(s, r > -0.98 ? 'TRAIL' : 'STOP', r, end); return true; }
        if (el >= (s.maxHold || CFG.MAX_HOLD_MS) || (el >= s.tsMs && s.mfe < s.tsMfe)) { closeSig(s, 'TIMEOUT', rA(k[4]), end); return true; }
        s.hh = L ? Math.max(s.hh == null ? s.entry : s.hh, k[2]) : Math.min(s.hh == null ? s.entry : s.hh, k[3]);
        if (rA(s.hh) >= s.capR) { closeSig(s, 'TP2', s.capR, end); return true; }
        const ns = s.hh - sg * s.trail * s.atr;
        if (L ? ns > s.stop : ns < s.stop) s.stop = ns;
        return false;
    }
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, end); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) {
            s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; s.hh = L ? k[2] : k[3]; return true;
        }
        if (el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', rA(k[4]), end); return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * T1 + 0.5 * rA(s.stop), end); return true; }
        if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * T2, end); return true; }
    }
    if (el >= (s.maxHold || CFG.MAX_HOLD_MS) && isOpen(s)) { const r = rA(k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * T1 + 0.5 * r : r, end); return true; }
    return false;
}

function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0, t: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0;
    for (const s of list) {
        tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR;
        eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR;
    }
    const avg = tot / n; let t = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)), se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; }
    return { n, win: w / n, avgR: avg, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }

// ------------------------- DURUM -------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, by: {}, total: 0, eligible: 0, suspect: 0 }, dirty = false, lastScanSlot = 0;
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), mtf = new Map();
let alerts = [], alertCd = {}, liveRadar = [], movers = { up: [], down: [] }, liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const struct = {}, lineState = {}, pend = {}, hist = {}, volCache = new Map();
let triSig = new Set();    // <<< YENİ: aynı üçgen tekrar sinyal vermesin

function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => !s.shadow && s.setup !== 'LK' && !s.live);
        lastSig = j.lastSig || {}; alerts = j.alerts || []; alertCd = j.alertCd || {};
        triSig = new Set(j.triSig || []);
        log('durum:', signals.length, 'sinyal,', triSig.size, 'üçgen imza');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const now = Date.now(), cd = {}; for (const k in alertCd) if (now - alertCd[k] < 6 * H1) cd[k] = alertCd[k];
        // triSig max 500 tut
        const triArr = [...triSig].slice(-500);
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig, alerts: alerts.slice(0, 400), alertCd: cd, triSig: triArr }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { }
}
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
        tickers = await ex.fetchTickers();
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

// ======================= CANLI MOTOR =======================
const lineVal = (L, t) => {
    if (L.seg) { const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0]; return dt ? a[1] + (b[1] - a[1]) * (t - a[0]) / dt : a[1]; }
    return L.p;
};
function buildStruct(S, t0) {
    const F1 = S.f1h, c1 = F1.c, n1 = c1.length - 1, atr1 = F1.atr[n1];
    if (!(atr1 > 0) || n1 < 60) return null;
    const o = { t: t0, atr1, h1: last(S.t1h), h4: last(S.t4h), lines: [] };
    if (CFG.ENABLE_TR && S.c2 && S.c2.length >= 60) {
        const tri = TRI.detect(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = TRI.pack(tri, S.c2), lb = tri.type + ' • ' + tri.touches + ' dokunuş';
            o.lines.push({ key: 'TR|res|' + pk.res[0][0], src: 'ÜÇGEN', kind: 'res', seg: pk.res, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, n: 9 });
            o.lines.push({ key: 'TR|sup|' + pk.sup[0][0], src: 'ÜÇGEN', kind: 'sup', seg: pk.sup, apex: pk.apex, atr: tri.atr, label: lb, h: tri.w0, n: 9 });
        }
    }
    return o;
}
async function liveVol(sym) {
    const now = Date.now(), hit = volCache.get(sym);
    if (hit && now - hit.t < 8000) return hit.d;
    const raw = await ex.fetchOHLCV(sym, '15m', undefined, 24);
    const closed = raw.filter(x => x[0] + M15 <= now), cur = raw.find(x => x[0] + M15 > now), base = closed.slice(-20);
    let avg = 0; for (const x of base) avg += x[5]; avg = base.length ? avg / base.length : 0;
    let volX = 0;
    if (avg > 0) {
        const prev = closed.length ? closed[closed.length - 1][5] : 0;
        if (cur) { const el = Math.min(1, Math.max(0.05, (now - cur[0]) / M15)), proj = cur[5] / el; volX = (el < 0.3 ? Math.max(proj, prev) : proj) / avg; }
        else volX = prev / avg;
    }
    const d = { volX }; volCache.set(sym, { t: now, d }); return d;
}
const tgCap = () => { const now = Date.now(); tgTimes = tgTimes.filter(x => now - x < H1); return tgTimes.length < CFG.LV_TG_MAX_H; };
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;
function alertMsg(a) {
    const head = a.kind === 'KIRILDI' ? '🚀 KIRILDI ' : a.kind === 'TEMAS' ? '🔵 TEMAS ' : '🟡 YAKLAŞIYOR ';
    let m = head + (a.dir === 'LONG' ? '🟢 ' : '🔴 ') + a.dir + ' ' + a.base + ' — ' + a.src + ' • ' + a.label + ' (' + a.role + ')';
    m += '\nFiyat ' + fmt(a.price) + ' | çizgi ' + fmt(a.line) + ' (' + a.dist.toFixed(2) + ' ATR' + (a.kind === 'KIRILDI' ? ' ötede' : ' uzakta') + ')';
    m += '\nHacim ' + a.volX.toFixed(1) + 'x ' + (a.strong ? '✅ GÜÇLÜ' : '⚠️ zayıf');
    if (a.kind === 'KIRILDI') m += '\n⏳ 15m kapanış onayı bekleniyor';
    m += '\nPiyasa: ' + (market.mood ? market.mood.label : '-') + (a.warnings.length ? ' | ⚠ ' + a.warnings.join(', ') : '') + '\n📈 ' + tvLink(a.base, 15);
    return m;
}
function liveSigMsg(s) {
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + 'CANLI SİNYAL ' + s.dir + ' ' + s.base + ' — ' + s.setupName +
        '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)' +
        '\nTP1 ' + fmt(s.tp1) + ' | TP2 ' + fmt(s.tp2) +
        '\nHacim ' + s.volX.toFixed(1) + 'x' +
        '\n📈 ' + tvLink(s.base, 15);
}

async function liveTick() {
    if (!CFG.ENABLE_LIVE || liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - (market.lastTick || 0) > 60e3) { }
        live.err = '';
        const mv = [];
        for (const sym of universe) {
            const tk = tickers[sym]; if (!tk || !tk.last) continue;
            const P = tk.last, h = hist[sym] || (hist[sym] = []);
            h.push([now, P]); while (h.length && now - h[0][0] > 20 * 60e3) h.shift();
            const ago = ms => { if (!h.length || h[0][0] > now - ms + 60e3) return null; let b = h[0]; for (const x of h) if (Math.abs(x[0] - (now - ms)) < Math.abs(b[0] - (now - ms))) b = x; return b[1]; };
            const p5 = ago(5 * 60e3), p15 = ago(15 * 60e3);
            if (p5) mv.push({ symbol: sym, base: baseOf(sym), price: P, c5: (P / p5 - 1) * 100, c15: p15 ? (P / p15 - 1) * 100 : 0, c24: tk.percentage != null ? tk.percentage : 0 });
        }
        mv.sort((a, b) => b.c5 - a.c5);
        movers = { up: mv.filter(x => x.c5 > 0).slice(0, 10), down: mv.filter(x => x.c5 < 0).slice(-10).reverse() };

        const evs = [], rad = []; let nl = 0;
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > CFG.LV_STALE_MS) continue;
            const P = tk.last; let best = null;
            for (const L of st.lines) {
                if (L.apex && now > L.apex) continue;
                nl++;
                const v = lineVal(L, now), d = (P - v) / L.atr, sk = sym + '|' + L.key;
                const sideNow = L.kind === 'res' ? -1 : 1;
                const brk = L.kind === 'res' ? (d >= CFG.LV_BRK_ATR ? 1 : 0) : (d <= -CFG.LV_BRK_ATR ? -1 : 0);
                if (brk) {
                    pend[sk] = (pend[sk] || 0) + 1;
                    if (pend[sk] >= CFG.LV_HOLD_TICKS) {
                        const role = brk === 1 ? 'direnç' : 'destek';
                        delete pend[sk];
                        evs.push({ type: 'KIRILDI', sym, L, d, v, P, dir: brk === 1 ? 'LONG' : 'SHORT', role, st });
                    }
                    continue;
                }
                delete pend[sk];
                if (!(sideNow * d >= -CFG.LV_BRK_ATR)) continue;
                const ad = Math.abs(d), role = sideNow === -1 ? 'direnç' : 'destek', bias = sideNow === -1 ? 'LONG' : 'SHORT';
                if (ad <= CFG.LV_NEAR_ATR) {
                    const touch = ad <= CFG.LV_TOUCH_ATR || sideNow * d < 0;
                    evs.push({ type: touch ? 'TEMAS' : 'YAKLAŞIYOR', sym, L, d, v, P, dir: bias, role, st });
                }
                if (ad <= CFG.LV_NEAR_ATR * 2.2 && (!best || ad < best.ad)) best = { ad, L, v, role, bias, P, sideNow, d };
            }
            if (best) {
                const tkp = tickers[sym];
                rad.push({ symbol: sym, base: baseOf(sym), price: P, bias: best.bias, rank: best.ad, chg24: tkp && tkp.percentage != null ? tkp.percentage : 0, tr: best.L.src === 'ÜÇGEN',
                    state: best.L.src + ' • ' + best.L.label + ' • ' + best.role + ' ' + fmt(best.v) + ' (' + best.ad.toFixed(2) + ' ATR uzakta)' });
            }
        }
        liveRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 30);

        evs.sort((a, b) => (a.type === 'KIRILDI' ? 0 : 1) - (b.type === 'KIRILDI' ? 0 : 1) || Math.abs(a.d) - Math.abs(b.d));
        let fetched = 0;
        for (const e of evs) {
            const isB = e.type === 'KIRILDI';
            const cdKey = (isB ? 'B|' : e.type === 'TEMAS' ? 'T|' : 'N|') + e.sym + '|' + e.L.key;
            if (now - (alertCd[cdKey] || 0) < (isB ? CFG.LV_CD_BRK_MIN : CFG.LV_CD_NEAR_MIN) * 60e3) continue;
            if (!isB && now - (alertCd['S|' + e.sym] || 0) < CFG.LV_SYM_GAP_MIN * 60e3) continue;
            const ad = Math.abs(e.d);
            if (isB && ad > CFG.LV_MAX_EXT_ATR) { alertCd[cdKey] = now; dirty = true; continue; }
            if (fetched >= CFG.LV_MAX_VOLFETCH) break;
            let vol; try { vol = await liveVol(e.sym); fetched++; } catch (er) { continue; }
            const gate = isB ? CFG.LV_VOL_BRK : e.type === 'TEMAS' ? CFG.LV_VOL_TOUCH : CFG.LV_VOL_NEAR;
            if (!isB && vol.volX < gate) continue;
            const side = e.dir === 'LONG' ? 1 : -1, warnings = [];
            if (mktDir === -side) warnings.push('Piyasa ters');
            if (e.st.h1 === -side) warnings.push('1H ters');
            if (e.st.h4 === -side) warnings.push('4H ters');
            const a = { id: e.sym.replace(/[^A-Z0-9]/g, '') + '_' + now, t: now, symbol: e.sym, base: baseOf(e.sym), kind: e.type, src: e.L.src, label: e.L.label, role: e.role, dir: e.dir,
                line: e.v, price: e.P, dist: ad, volX: vol.volX, strong: vol.volX >= CFG.LV_VOL_STRONG, status: isB ? 'BEKLİYOR' : '—', atr: e.L.atr, warnings,
                slope: e.L.seg ? (e.L.seg[1][1] - e.L.seg[0][1]) / ((e.L.seg[1][0] - e.L.seg[0][0]) || 1) : 0, tg: false };
            if (isB) {
                const stop = e.v - side * CFG.LV_STOP_ATR * e.L.atr, risk = side * (e.P - stop);
                a.stop = stop; a.riskPct = risk / e.P * 100; a.tp1 = e.P + side * 1.5 * risk;
                a.tp2 = e.L.h ? e.v + side * e.L.h : e.P + side * 3 * risk;
                if (side * (a.tp2 - e.P) < 1.5 * risk) a.tp2 = e.P + side * 3 * risk;
            }
            a.tg = vol.volX >= gate && tgCap();
            alertCd[cdKey] = now; alertCd['S|' + e.sym] = now;
            alerts.unshift(a); if (alerts.length > 400) alerts.length = 400; dirty = true;
            log('UYARI', a.kind, a.dir, a.base, a.src, 'hacim', a.volX.toFixed(1), a.tg ? '[TG]' : '');
            if (a.tg) { tgTimes.push(now); telegram(alertMsg(a)); }

            // Canlı üçgen kırılımı → Sinyaller (align modunda sadece piyasa yönü uyumlu)
            if (CFG.LV_LIVE_SIG && isB && a.src === 'ÜÇGEN' && a.volX >= CFG.LV_LIVE_MIN_VOL && a.riskPct <= CFG.LV_LIVE_MAX_RISK) {
                const mktOKLive = CFG.MKT_MODE === 'align' ? mktDir === side : (CFG.MKT_MODE === 'off' ? true : mktDir !== -side);
                if (!mktOKLive) { /* piyasa yönü uyumsuz, canlı sinyal üretme */ }
                else {
                    const lkey = e.sym + '|LTR';
                    const alreadyOpen = signals.some(x => x.symbol === e.sym && isOpen(x) && !x.trPaper);
                    if (!alreadyOpen && Date.now() - (lastSig[lkey] || 0) > CFG.LV_LIVE_COOLDOWN_MS) {
                        const riskDist = Math.abs(e.P - a.stop);
                        const sig = {
                            id: e.sym.replace(/[^A-Z0-9]/g, '') + '_LTR_' + now,
                            symbol: e.sym, base: baseOf(e.sym), dir: e.dir, setup: 'LTR', setupName: 'Canlı Üçgen Kırılımı',
                            score: 0, parts: {}, warnings: (a.warnings || []).slice(),
                            entry: e.P, stop: a.stop, initialStop: a.stop,
                            mode: 'A', tp1R: 1.5, tp2R: 3, capR: 5, trail: 2, atr: e.L.atr,
                            tp1: e.P + side * 1.5 * riskDist, tp2: e.P + side * 3 * riskDist,
                            tsMs: 8 * H1, tsMfe: 0.3, maxHold: 48 * H1,
                            riskPct: a.riskPct, costR: 0,
                            volX: a.volX, adx: 0, rsi: 0, room: 3, rs: null,
                            trend: 0, trend1h: e.st.h1, trend4h: e.st.h4, mkt: mktDir,
                            time: now, candleT: now - (now % M15), level: e.v,
                            lastPrice: e.P, mfe: 0, mae: 0, trackedTo: now - M1,
                            status: 'ACTIVE', live: true,
                            reason: 'Canlı üçgen kırılımı • ' + e.L.label + ' • hacim ' + a.volX.toFixed(1) + 'x'
                        };
                        signals.unshift(sig);
                        if (signals.length > CFG.KEEP) signals.length = CFG.KEEP;
                        lastSig[lkey] = now; dirty = true;
                        log('CANLI SİNYAL', sig.dir, sig.base, 'hacim', a.volX.toFixed(1));
                        if (tgCap()) { tgTimes.push(now); telegram(liveSigMsg(sig)); }
                    }
                }
            }
        }

        let chk = 0;
        for (const a of alerts) {
            if (a.kind !== 'KIRILDI' || a.status !== 'BEKLİYOR') continue;
            const cs = Math.floor(a.t / M15) * M15, evalT = (a.t - cs > 12 * 60e3) ? cs + M15 : cs;
            if (now < evalT + M15 + 6000) continue;
            if (chk++ >= 5) break;
            try {
                const raw = await ex.fetchOHLCV(a.symbol, '15m', undefined, 8), k = raw.find(x => x[0] === evalT);
                if (!k) { if (now > evalT + M15 + 5 * 60e3) { a.status = 'BELİRSİZ'; dirty = true; } continue; }
                const ln = a.line + (a.slope || 0) * (evalT + M15 - a.t), ok = a.dir === 'LONG' ? k[4] > ln : k[4] < ln;
                a.status = ok ? 'ONAYLI' : 'SAHTE'; a.closeAt = k[4]; dirty = true;
                if (a.tg) telegram((ok ? '✅ ONAYLANDI: ' : '❌ SAHTE: ') + a.base + ' ' + a.dir + ' — 15m kapanış ' + fmt(k[4]));
            } catch (er) { }
        }
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length; live.lines = nl;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    liveRunning = false;
}
function pruneLive() {
    const ok = new Set();
    for (const sym of Object.keys(struct)) for (const L of struct[sym].lines) ok.add(sym + '|' + L.key);
    for (const k of Object.keys(pend)) if (!ok.has(k)) delete pend[k];
    for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
    for (const k of Object.keys(hist)) if (!universe.includes(k)) delete hist[k];
    for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
}
function alertStats() {
    const g = {};
    const add = (k, a) => { const x = g[k] || (g[k] = { n: 0, ok: 0, fake: 0, wait: 0 }); x.n++; if (a.status === 'ONAYLI') x.ok++; else if (a.status === 'SAHTE') x.fake++; else x.wait++; };
    for (const a of alerts) { if (a.kind !== 'KIRILDI') continue; add('Tüm kırılımlar', a); add(a.src, a); add(a.strong ? 'Güçlü hacim' : 'Zayıf hacim', a); }
    return g;
}

// ======================= TARAMA =======================
async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.by = {}; scan.reasonDay = day; }
    const bump = k => { scan.reasons[k] = (scan.reasons[k] || 0) + 1; };
    try {
        const S = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const d = await getMulti(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); continue; }
                    if (d.c15.length < 120 || !d.c1h || d.c1h.length < 60 || !d.c4h || d.c4h.length < 60) { bump('veri az'); continue; }
                    S[sym] = buildSym(d.c15, d.c1h, d.c4h);
                } catch (e) { bump('hata'); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));

        let up = 0, dn = 0, fl = 0; const keys = Object.keys(S);
        for (const k of keys) { const v = last(S[k].t15); if (v === 1) up++; else if (v === -1) dn++; else fl++; }
        const bsc = breadthScore(up, dn, keys.length);
        const bd = S[BTC] ? last(S[BTC].t15) : 0, ed = S[ETH] ? last(S[ETH].t15) : 0;
        mktDir = mktOf(bd, ed, bsc);
        market.btc = Object.assign(market.btc || {}, { dir: bd }); market.eth = Object.assign(market.eth || {}, { dir: ed });
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: keys.length, breadth: Number(bsc.toFixed(2)), btc: bd, eth: ed, score: Number((2 * bd + ed + bsc).toFixed(2)) };

        const btcMap = S[BTC] ? new Map(S[BTC].f15.c.map(x => [x[0], x[4]])) : null;
        const watchAll = [], found = [];
        for (const sym of universe) {
            const s = S[sym]; if (!s) continue;
            const c = s.f15.c, i = c.length - 1;
            if (t0 - (c[i][0] + M15) > 2 * M15) { bump('bayat veri'); continue; }
            const t = tickers[sym] || {};
            if (CFG.ENABLE_LIVE) { try { const stc = buildStruct(s, t0); if (stc) struct[sym] = stc; } catch (e) { } }
            const r = signalAt(s, i, { sym, mkt: mktDir, rs: isMajor(sym) ? null : rsAt(c, i, btcMap, CFG.RS_LB), costPct: costFor(t.quoteVolume) * CFG.COST_MULT, watch: true, triSig });
            bump(r.reason);
            if (r.near) {
                watchAll.push({ symbol: sym, base: baseOf(sym), price: c[i][4], rsi: s.f15.rsi[i], adx: s.f15.adx[i], bias: r.near.side === 1 ? 'LONG' : 'SHORT', rank: r.near.dist, chg24: t.percentage != null ? t.percentage : 0, state: (r.near.tr ? r.near.tr.tri.type + ' • ' + r.near.tr.tri.touches + ' dokunuş • ' + (r.near.side === 1 ? 'direnç' : 'destek') + ' ' + fmt(r.near.line) + ' (' + r.near.dist.toFixed(2) + ' ATR uzakta)' : ''), tr: !!r.near.tr });
            }
            if (r.signal) { if (Date.now() - r.signal.time <= CFG.MAX_SIGNAL_AGE_MS) found.push(r.signal); else bump('eski sinyal'); }
        }
        radar = watchAll.sort((a, b) => a.rank - b.rank).slice(0, 25);
        if (CFG.ENABLE_LIVE) pruneLive();

        found.sort((a, b) => b.score - a.score);
        let added = 0;
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < 4 * H1) continue;
            const open = signals.filter(x => isOpen(x) && !x.trPaper);
            if (open.length >= CFG.MAX_OPEN_TOTAL || open.filter(x => x.setup === s.setup).length >= (CFG.MAX_OPEN_SETUP[s.setup] || 3)) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_TR_' + s.candleT;
            s.status = 'ACTIVE'; s.trackedTo = s.candleT + M15 - M1; s.variant = 'Ana';
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            log('SİNYAL', s.dir, s.base, 'puan', s.score, 'piyasa', market.mood.label, 'hacim', s.volX.toFixed(1));
            const iv = String(TRI.AGG * 60);
            telegram((s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName +
                '\nPiyasa: ' + market.mood.label + ' | Hedef ' + s.room.toFixed(1) + 'R | Maliyet ' + s.costR.toFixed(2) + 'R' +
                '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)' +
                '\nTP1 ' + fmt(s.tp1) + ' | TP2 ' + fmt(s.tp2) +
                '\n⏱ 5 dk içinde gir; 0.3R uzaklaştıysa atla.\n📈 ' + tvLink(s.base, iv) + (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
        }
        signals = signals.slice(0, CFG.KEEP);
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

async function track() {
    if (tracking) return;
    const open = signals.filter(isOpen); if (!open.length) return;
    tracking = true;
    try {
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym];
                const since = Math.min(...list.filter(isOpen).map(x => x.trackedTo));
                const raw = await ex.fetchOHLCV(sym, '1m', since, 500), c = closedOnly(raw, M1);
                for (const s of list) {
                    if (!isOpen(s)) continue;
                    for (const k of c) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; dirty = true;
                        if (advance(s, k, M1) && !isOpen(s)) {
                            log('KAPANDI', s.symbol, s.status, s.netR);
                            telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)');
                            break;
                        }
                    }
                }
                const t = tickers[sym]; if (t && t.last) for (const s of list) if (isOpen(s)) s.lastPrice = t.last;
            } catch (e) { }
        }
    } catch (e) { }
    tracking = false;
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}
const selfPing = async () => { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } };

function apiState() {
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null && !s.trPaper);
    const st = { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(now))), bySetup: groupBy(closed, s => s.setup + ' ' + s.setupName), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status) };
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const rd = liveRadar.concat(radar.filter(r => !liveRadar.some(x => x.symbol === r.symbol))).sort((a, b) => a.rank - b.rank).slice(0, 30);
    return { now, mode: 'v14.4 HYBRID (2H üçgen + 15m onay)', market, signals: signals.filter(s => !s.shadow).slice(0, 60), radar: rd, stats: st, equity: eq,
        alerts: alerts.slice(0, 60), alertStats: alertStats(), movers,
        live: { enabled: CFG.ENABLE_LIVE, periodMs: CFG.LIVE_MS, last: live.last, ms: live.ms, symbols: live.n, lines: live.lines, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        last24: signals.filter(s => !s.shadow && now - s.time < 24 * H1).length,
        filters: { mkt: CFG.MKT_MODE, tr: CFG.ENABLE_TR, trAgg: TRI.AGG, trVolx: CFG.TRI_VOLX, trBrk: CFG.TRI_BRK_ATR, liveSig: CFG.LV_LIVE_SIG, triSigCount: triSig.size },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible, suspect: scan.suspect } };
}
async function apiCandles(sym, tf) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    tf = tf === '15m' ? '15m' : 'tri';
    const key = sym + '|' + tf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let d;
    if (tf === '15m') {
        const c = await ex.fetchOHLCV(sym, '15m', undefined, 200), cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c.length - 120);
        d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf: '15m', dur: M15, tri: null };
    } else {
        const raw = closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 400), H1), c2 = TRI.aggregate(raw, aggregateN);
        if (c2.length < 30) throw new Error('yetersiz veri');
        const cl = c2.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c2.length - 120);
        const tri = c2.length > 60 ? (TRI.detect(c2, c2.length - 1, CFG) || TRI.detect(c2, c2.length - 2, CFG)) : null;
        d = { c: c2.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf: TRI.AGG + 'H', dur: TRI.DUR, tri: tri ? TRI.pack(tri, c2) : null };
    }
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ======================= BACKTEST =======================
async function fetchHistory15(sym, days) {
    const total = days + 14;
    let since = Date.now() - total * D1, all = [], guard = 0;
    while (since < Date.now() - M15 && guard++ < 200) {
        let r = null, retry = 0;
        while (retry < 4) { try { r = await ex.fetchOHLCV(sym, '15m', since, 1000); break; } catch (e) { retry++; await sleep(800 * retry); } }
        if (!r || !r.length) break;
        all = all.concat(r); const l = last(r)[0];
        if (l <= since) break; since = l + M15;
        await sleep(100);
    }
    all.sort((a, b) => a[0] - b[0]);
    const seen = new Set();
    const c = closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
    const usable = c.length ? (last(c)[0] - c[0][0]) / D1 - 11 : 0;
    return { c, usable };
}
function prepare(data, costOf) {
    const pre = {}, cnt = new Map(), trMap = { [BTC]: new Map(), [ETH]: new Map() };
    for (const s of Object.keys(data)) {
        const c = data[s], S = buildSym(c, aggregateN(c, M15, 4), aggregateN(c, M15, 16));
        S.costPct = costOf(s); pre[s] = S;
        for (let i = 0; i < c.length; i++) { const t = c[i][0], v = S.t15[i]; let a = cnt.get(t); if (!a) { a = [0, 0, 0]; cnt.set(t, a); } a[2]++; if (v === 1) a[0]++; else if (v === -1) a[1]++; if (trMap[s]) trMap[s].set(t, v); }
    }
    const mkt = new Map();
    for (const [t, a] of cnt) mkt.set(t, mktOf(trMap[BTC].get(t) || 0, trMap[ETH].get(t) || 0, breadthScore(a[0], a[1], a[2])));
    return { pre, maps: { mkt, btc: new Map(pre[BTC].f15.c.map(x => [x[0], x[4]])) } };
}
async function simulate(pre, use, maps, cfgO, opts, startT) {
    const C = Object.assign({}, CFG, cfgO || {}), raw = [], funnel = {};
    const triSigSim = new Set();
    for (const sym of use) {
        const S = pre[sym], c = S.f15.c, n = c.length; let busy = 0;
        const from = Math.max(startT, c[0][0] + 11 * D1);
        for (let i = 80; i < n - 1; i++) {
            const t = c[i][0]; if (t < from || t < busy) continue;
            const r = signalAt(S, i, { sym, mkt: maps.mkt.get(t) || 0, rs: isMajor(sym) ? null : rsAt(c, i, maps.btc, C.RS_LB), costPct: S.costPct, minScore: opts.minScore, cfg: C, triSig: triSigSim });
            if (!r.signal) continue;
            funnel.sinyal = (funnel.sinyal || 0) + 1;
            const s = r.signal; s.status = 'ACTIVE';
            for (let j = i + 1; j < n; j++) { if (advance(s, c[j], M15) && !isOpen(s)) break; }
            if (isOpen(s)) continue;
            raw.push({ symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, score: s.score, time: s.time, candleT: s.candleT, closedAt: s.closedAt, netR: s.netR, costR: s.costR, status: s.status, mkt: s.mkt });
            busy = Math.max(s.closedAt, s.time + 4 * H1);
        }
    }
    raw.sort((a, b) => a.time - b.time);
    const trades = [], openL = []; let blocked = 0;
    for (const t of raw) {
        for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
        if (openL.length >= C.MAX_OPEN_TOTAL) { blocked++; continue; }
        openL.push(t); trades.push(t);
    }
    funnel['portföy limiti'] = blocked;
    return { trades, raw, funnel };
}
const split3 = tr => { const n = tr.length, a = Math.floor(n * 0.5), b = Math.floor(n * 0.75); return { all: grp(tr), is: grp(tr.slice(0, a)), val: grp(tr.slice(a, b)), oos: grp(tr.slice(b)) }; };

async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    opts = Object.assign({ costMult: 1, minScore: 0 }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => s !== BTC && s !== ETH).slice(0, coins), all = [BTC, ETH].concat(syms);
        btJob.total = all.length + 1;
        const data = {}, skipped = []; let usableMax = 0;
        for (const s of all) {
            btJob.msg = 'Veri: ' + baseOf(s);
            try {
                const h = await fetchHistory15(s, days);
                if (h.usable < 4 && !isMajor(s)) skipped.push(baseOf(s));
                else { data[s] = h.c; usableMax = Math.max(usableMax, h.usable); }
            } catch (e) { skipped.push(baseOf(s) + '(hata)'); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 1500) throw new Error('BTC verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];
        btJob.msg = 'Simülasyon';
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult);
        const effDays = Math.max(1, Math.min(days, Math.round(usableMax))), startT = Date.now() - days * D1;
        const r = await simulate(pre, Object.keys(data), maps, {}, opts, startT);
        const sp = split3(r.trades);
        btJob.result = { days: effDays, coins, skipped: skipped.slice(0, 10), funnel: r.funnel, costMult: opts.costMult,
            all: sp.all, is: sp.is, val: sp.val, oos: sp.oos, rawN: r.raw.length,
            bySetup: groupBy(r.trades, s => s.setup + ' ' + s.setupName), bySetupDir: groupBy(r.trades, s => s.setup + ' ' + s.setupName + ' ' + s.dir),
            byDir: groupBy(r.trades, s => s.dir), byExit: groupBy(r.trades, s => s.status) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Hata: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE v14.4 HYBRID</title>
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
.side{width:400px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
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
canvas{width:100%;height:360px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.frm input{width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}.btn.off{background:var(--p2);color:var(--dm);border:1px solid var(--ln)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:260px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v14.4</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div><span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<script>
const TABS=[['sig','Sinyaller'],['al','Uyarılar'],['radar','Radar'],['mv','Hareket'],['stat','İstatistik'],['bt','Test']];
let S=null,tab='sig',sel=null,bt=null,chartCache={},chartFor='',chartTF='tri',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),lastAl=0,actx=null,lastSigIds=new Set();
const $=id=>document.getElementById(id);
const fp=p=>{if(p==null)return'-';p=Number(p);const a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)};
const f2=(x,d=2)=>x==null||isNaN(x)?'-':Number(x).toFixed(d);
const sg=(x,d=2)=>{x=Number(x);return(x>0?'+':'')+x.toFixed(d)};
const cl=x=>x>0?'up':x<0?'dn':'fl';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ts=>{const m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'};
const openS=s=>s.status==='ACTIVE'||s.status==='TP1_HIT';
const tvUrl=(sym,iv)=>'https://www.tradingview.com/chart/?symbol=BITGET:'+sym.split('/')[0]+'USDT.P&interval='+(iv||120);
const pnlR=s=>s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null;
const ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1 ✓','g'],TP2:['TP2 ✓','g'],TRAIL:['Trailing','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre','w']};
const key=()=>localStorage.getItem('st_key')||'';
async function post(url,b){const r=await fetch(url+'?key='+encodeURIComponent(key()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
 if(r.status===401){const k=prompt('ADMIN_KEY:');if(k){localStorage.setItem('st_key',k);return post(url,b)}}return r}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();const o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.08;o.start();o.stop(actx.currentTime+0.25)}catch(e){}}
function checkNew(){const ids=new Set(S.signals.filter(openS).map(x=>x.id));const nw=[...ids].filter(x=>!lastSigIds.has(x));
 if(lastSigIds.size&&nw.length){beep();const s=S.signals.find(x=>x.id===nw[0]);document.title='('+nw.length+') YENİ '+s.base+' • SONER'}lastSigIds=ids;}

function renderTop(){const md=S.market&&S.market.mood;
 $('cMkt').innerHTML=md?'<b>Piyasa</b> <span class="'+(md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl')+'"><b style="color:inherit">'+md.label+'</b></span> <span class="fl">'+md.up+'↑/'+md.down+'↓</span>':'<b>Piyasa</b> ...';
 [['cBTC','BTC','btc'],['cETH','ETH','eth']].forEach(a=>{const m=S.market[a[2]];$(a[0]).innerHTML=m?'<b>'+a[1]+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg)+'%</span>':'<b>'+a[1]+'</b> -'});
 $('modeB').textContent=S.mode}

function renderTabs(){const oc=S.signals.filter(openS).length,al=(S.alerts||[]).length;
 $('tabs').innerHTML=TABS.map(t=>'<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?' ('+oc+')':t[0]==='al'?' ('+al+')':'')+'</button>').join('');
 [...$('tabs').children].forEach(b=>b.onclick=()=>{tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;renderAll()})}

function sigCard(s){const st=ST[s.status]||['?',''],R=pnlR(s);let pn='';
 if(openS(s)&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R</span>';else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span><span class="tag">'+esc(s.setup)+'</span>'+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Şu an '+fp(s.lastPrice||s.entry)+'</span><span>Stop '+fp(s.stop)+'</span><span>'+ago(s.time)+'</span></div></div>'}
function radarCard(r){return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span>'+(r.tr?'<span class="tag w">ÜÇGEN</span>':'')+'<span class="fl">'+fp(r.price)+'</span></div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function alCard(a){return '<div class="card" data-aid="'+a.id+'"><div class="r1"><span class="badge '+(a.dir==='LONG'?'L':'S')+'">'+a.dir+'</span><span class="coin">'+esc(a.base)+'</span><span class="tag">'+esc(a.kind)+'</span><span class="tag g">'+esc(a.src)+'</span><span class="tag '+(a.strong?'g':'w')+'">'+f2(a.volX,1)+'x</span></div><div class="sub"><span>'+esc(a.label)+'</span><span>çizgi '+fp(a.line)+'</span><span>'+ago(a.t)+'</span></div></div>'}
function mvCard(r){return '<div class="card" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.c5)+'" style="font-size:14px">'+sg(r.c5)+'%</span></div><div class="sub"><span>15dk <b class="'+cl(r.c15)+'">'+sg(r.c15)+'%</b></span><span>24s <b class="'+cl(r.c24)+'">'+sg(r.c24,1)+'%</b></span></div></div>'}
function renderList(){let h='';
 if(tab==='sig'){const a=S.signals.filter(openS),c=S.signals.filter(s=>!openS(s)).slice(0,25);
  h+='<div class="note" style="padding:6px 8px">HYBRID: 2H üçgen + 15m kırılım. Piyasa yönü zorunlu.</div>';
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Açık sinyal yok.</div>';
  if(c.length)h+='<h3>Kapanan</h3>'+c.map(sigCard).join('')}
 else if(tab==='al'){const a=S.alerts||[];h='<div class="note" style="padding:6px 8px">Canlı uyarılar (sadece üçgen).</div>'+(a.length?a.map(alCard).join(''):'<div class="note" style="padding:10px">-</div>')}
 else if(tab==='radar')h=S.radar.length?S.radar.map(radarCard).join(''):'<div class="note" style="padding:10px">-</div>';
 else if(tab==='mv'){const m=S.movers||{up:[],down:[]};h='<h3>Yükselenler</h3>'+(m.up.map(mvCard).join('')||'-')+'<h3>Düşenler</h3>'+(m.down.map(mvCard).join('')||'-')}
 else h='<div class="note">Detay sağda.</div>';
 $('list').innerHTML=h;
 [...$('list').querySelectorAll('.card')].forEach(e=>e.onclick=()=>{const id=e.dataset.id,sy=e.dataset.sym,ai=e.dataset.aid;
  if(id){const s=S.signals.find(x=>x.id===id);sel={id,sym:s.symbol}}else if(sy)sel={sym:sy};else sel=null;chartFor='';renderList();renderMain()})}

function calcBox(e,s){return '<div class="box"><h3>Pozisyon</h3><div class="frm"><label>Bakiye<input id="cBal" type="number" value="'+cfgC.bal+'"></label><label>Risk%<input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label>Giriş<input id="cE" type="number" value="'+(e||'')+'"></label><label>Stop<input id="cS" type="number" value="'+(s||'')+'"></label></div><div id="cOut" class="note"></div></div>'}
function bindCalc(){const upd=()=>{cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));const c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R '+f2(c.ru)+' USDT | Miktar '+f2(c.q,4)+' | Poz '+f2(c.n,1)+' | Kald '+f2(c.lev,1)+'x':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(i=>{const e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}
function calc(e,s){const bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;const q=ru/d;return{ru,q,n:q*e,lev:q*e/bal}}

function sigView(s){const st=ST[s.status]||['?',''],R=pnlR(s),w=(s.warnings||[]).map(x=>'<span class="tag w">'+esc(x)+'</span>').join(' ');
 const tinfo=s.tri&&s.tri.type?'<span class="tag g">'+esc(s.tri.type)+'</span>':'';
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.base)+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span>'+tinfo+'</div>'+w+tfBar()+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Şu an</span><b>'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="'+tvUrl(s.symbol)+'" target="_blank">📈 TradingView</a></div><div class="note">'+esc(s.reason||'')+'</div>'+calcBox(s.entry,s.initialStop)}

const reasonTxt=o=>Object.entries(o||{}).sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]+' '+x[1]).join(', ')||'-';
function homeView(){const F=S.filters,open=S.signals.filter(openS).length,h=S.stats.today,a=S.stats.all;
 return '<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Açık</div><div class="v">'+open+'</div></div><div class="tile"><div class="k">Bugün</div><div class="v '+cl(h.avgR)+'">'+sg(h.avgR)+'R</div><div class="k">'+h.n+' işlem</div></div><div class="tile"><div class="k">Toplam</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'R</div><div class="k">'+a.n+' işlem</div></div><div class="tile"><div class="k">Tri imza</div><div class="v">'+F.triSigCount+'</div></div></div>'+
 '<div class="box"><h3>v14.4 HYBRID — Sadece ÜÇGEN</h3><div class="note">Piyasa modu: <b>'+F.mkt+'</b> (align=piyasa yönü zorunlu). 2H üçgen tespiti + 15m kırılım onayı. Aynı üçgen tekrar sinyal vermez ('+F.triSigCount+' imza).</div></div>'+
 '<div class="box"><h3>Son tarama</h3><div class="note">'+(S.scan.last?ago(S.scan.last)+' önce':'-')+' | '+S.scan.eligible+'/'+S.scan.total+' coin</div><div class="note">'+reasonTxt(S.scan.reasons)+'</div></div>'}

const tbl=(t,title)=>'<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th></tr>'+Object.keys(t).map(k=>{const x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td></tr>'}).join('')+'</table>';
function statView(){return '<h2>İstatistik</h2>'+tbl({'Tümü':S.stats.all,'Bugün':S.stats.today},'Genel')+tbl(S.stats.bySetup,'Kurulum')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byExit,'Çıkış')}

const _bs=JSON.parse(localStorage.getItem('st_bt')||'{"d":90,"c":100,"m":1}');
const opt=(v,cur,t)=>'<option value="'+v+'"'+(+cur===v?' selected':'')+'>'+t+'</option>';
function btView(){let h='<h2>Backtest</h2><div class="box"><div class="frm"><select id="bD">'+opt(30,_bs.d,'30g')+opt(60,_bs.d,'60g')+opt(90,_bs.d,'90g')+'</select><select id="bC">'+opt(50,_bs.c,'50c')+opt(100,_bs.c,'100c')+opt(150,_bs.c,'150c')+'</select><select id="bM">'+opt(1,_bs.m,'x1')+opt(1.5,_bs.m,'x1.5')+opt(2,_bs.m,'x2')+'</select><button class="btn" id="bGo">Başlat</button></div><div class="note">HYBRID: 2H üçgen + 15m onay. Piyasa yönü zorunlu. Canlı LTR hariç.</div></div>';
 if(!bt)return h;
 if(bt.running)h+='<div class="box">'+esc(bt.msg)+' ('+bt.done+'/'+bt.total+')</div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){const R=bt.result,a=R.all;
  h+='<div class="tiles"><div class="tile"><div class="k">N</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Win%</div><div class="v">'+f2(a.win*100,0)+'</div></div><div class="tile"><div class="k">Ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">t</div><div class="v">'+f2(a.t)+'</div></div></div>';
  h+='<h3>Walk-forward</h3><table><tr><th>Dilim</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th></tr>'+[['IS',R.is],['VAL',R.val],['OOS',R.oos]].map(p=>{const x=p[1];return '<tr><td>'+p[0]+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>';
  h+=tbl(R.bySetup,'Kurulum')+tbl(R.bySetupDir,'Kurulum × Yön')+tbl(R.byDir,'Yön')+tbl(R.byExit,'Çıkış');
  h+='<div class="note">'+R.days+'g / '+R.coins+' coin / '+R.rawN+' işlem</div>';
 }
 return h}
function bindBt(){[['bD','d'],['bC','c'],['bM','m']].forEach(a=>{const e=$(a[0]);if(e)e.onchange=()=>{_bs[a[1]]=+e.value;localStorage.setItem('st_bt',JSON.stringify(_bs))}});
 const b=$('bGo');if(b)b.onclick=async()=>{const r=await post('/api/backtest',{days:+$('bD').value,coins:+$('bC').value,costMult:+$('bM').value});if(r.ok)pollBt()}}
function pollBt(){fetch('/api/backtest').then(r=>r.json()).then(d=>{bt=d;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}

function setTF(v){chartTF=v?'tri':'15m';chartFor='';if(S)renderMain()}
function tfBar(){return '<div class="frm"><button class="btn'+(chartTF==='tri'?'':' off')+'" onclick="setTF(1)">Üçgen 2H</button><button class="btn'+(chartTF==='15m'?'':' off')+'" onclick="setTF(0)">15m</button></div>'}
function drawChart(d,s){const c=$('cv');if(!c||!d||!d.c.length)return;const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;const x=c.getContext('2d');x.scale(dp,dp);
 const tri=(s&&s.tri)||d.tri,nc=d.c.length,n=nc+(tri?10:0);const L=8,R=86,T=12,B=20,PW=W-L-R,PH=H-T-B;
 const ti=t=>(t-d.c[0][0])/d.dur;let hi=-1e99,lo=1e99;d.c.forEach(k=>{hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 const lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.stop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']]:[];
 lv.forEach(a=>{hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});
 const tl=[];if(tri)[tri.res,tri.sup].forEach(l=>{const a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(q=>{const v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 const pad=(hi-lo)*.06;hi+=pad;lo-=pad;const Y=p=>T+(hi-p)/(hi-lo)*PH,X=k=>L+(k+.5)/n*PW,cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';for(let i=0;i<=4;i++){const gy=T+PH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 const line=(arr,col,w)=>{x.strokeStyle=col;x.lineWidth=w;x.beginPath();let st=false;arr.forEach((v,k)=>{if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 d.c.forEach((k,i)=>{const col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();tl.forEach(l=>{x.strokeStyle='#ffd400';x.lineWidth=2.2;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});x.fillStyle='#ffd400';tri.hi.concat(tri.lo).forEach(p=>{x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),3,0,7);x.fill()});x.restore()}
 lv.forEach(a=>{x.strokeStyle=x.fillStyle=a[1];x.lineWidth=2;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 const lp=s&&s.lastPrice?s.lastPrice:d.c[nc-1][4];x.strokeStyle='#fff';x.lineWidth=1.5;x.beginPath();x.moveTo(L,Y(lp));x.lineTo(W-R,Y(lp));x.stroke();x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp)-9,66,18);x.fillStyle='#0c1117';x.font='bold 11px';x.fillText(fp(lp),W-R+2,Y(lp)+4)}
function loadChart(sym){const tf=chartTF;fetch('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf).then(r=>r.json()).then(d=>{chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym&&tf===chartTF&&$('cv'))drawChart(d,sel.id?S.signals.find(x=>x.id===sel.id):null)}).catch(()=>{})}

function renderMain(){const M=$('main');
 if(tab==='stat'){M.innerHTML=statView();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){const s=S.signals.find(x=>x.id===sel.id);if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[chartTF==='tri'?sel.sym+'|tri':sel.sym+'|15m'])drawChart(chartCache[chartTF==='tri'?sel.sym+'|tri':sel.sym+'|15m'],s);loadChart(sel.sym);return}}
 if(sel&&sel.sym){const r=S.radar.find(x=>x.symbol===sel.sym);M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="'+tvUrl(sel.sym,120)+'" target="_blank">TradingView</a></div>'+tfBar()+'<canvas id="cv"></canvas>'+calcBox('','');bindCalc();loadChart(sel.sym);return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch('/api/state').then(r=>r.json()).then(d=>{S=d;checkNew();$('dot').className='dot on';$('conn').textContent='Bağlı';const t=document.activeElement&&document.activeElement.tagName;if(t==='INPUT'||t==='SELECT'){renderTop();renderTabs();renderList()}else renderAll()}).catch(()=>{$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',()=>{if(S)renderMain()});
setInterval(poll,15000);setInterval(()=>{if(sel&&sel.sym)loadChart(sel.sym)},60000);poll();pollBt();
</script></body></html>`;

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf')));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [30, 60, 90].includes(b.days) ? b.days : 90, coins = [50, 100, 150, 250].includes(b.coins) ? b.coins : 100;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1;
            if (!btJob.running) runBacktest(days, coins, { costMult });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; alerts = []; alertCd = {}; triSig = new Set(); dirty = true; saveState(); return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(track, CFG.TRACK_MS);
        if (CFG.ENABLE_LIVE) setInterval(liveTick, CFG.LIVE_MS); else setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3); setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);
        log('SONER TRADE v14.4 HYBRID hazır | MKT ' + CFG.MKT_MODE + ' | TR ' + (CFG.ENABLE_TR ? 'açık' : 'kapalı') + ' | 15m onaylı');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, signalAt, advance, buildSym, prepare, simulate, grp, aggregateN, CFG, TRI };
