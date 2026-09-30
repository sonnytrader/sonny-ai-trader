'use strict';
// ============================================================
// SONER TRADE v15 (TEK DOSYA)
//   TEK ODAK: Seviye Kırılımı (Triangle 2H + Donchian 1H)
//   - Kırılım = sinyal. Ses ve Telegram aynı anda gelir.
//   - Radar: yaklaşan seviyeler, üstünde durum etiketi
//   - Sinyaller sekmesi: açık + kapanmış, K/Z görünür
//   - PB (pullback) kaldırıldı. Gölge/kâğıt modu kaldırıldı.
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
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, D1 = 24 * H1;
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
            TRI_MAX_LIFE: num('TRI_MAX_LIFE', 1),
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
    function breakout(tri, c, j, C) {
        const q = c[j], atr = tri.atr, rj = lineR(tri, j), sj = lineS(tri, j);
        let side = 0;
        if (q[4] > rj + C.TRI_BRK_ATR * atr) side = 1; else if (q[4] < sj - C.TRI_BRK_ATR * atr) side = -1;
        if (!side) return { fail: 'tr kırılım yok' };
        if (tri.life > C.TRI_MAX_LIFE) return { fail: 'tr apex çok yakın' };
        const L = side === 1, line = L ? rj : sj;
        const rng = (q[2] - q[3]) || 1e-12, body = Math.abs(q[4] - q[1]) / rng, cp = (q[4] - q[3]) / rng;
        if (body < C.TRI_BODY || (L ? cp < C.TRI_CLOSEPOS : cp > 1 - C.TRI_CLOSEPOS)) return { fail: 'tr zayıf mum' };
        const vs = volAvg(c, j, 20), volX = vs > 0 ? q[5] / vs : 0;
        if (volX < C.TRI_VOLX) return { fail: 'tr hacim düşük' };
        const ext = Math.abs(q[4] - line) / atr;
        if (ext > C.TRI_MAX_EXT_ATR) return { fail: 'tr uzamış' };
        return { side, line, atr, volX, ext, height: tri.w0 };
    }
    function near(tri, c, j, price, tEnd, C, nearAtr) {
        const x = j + (tEnd - c[j][0]) / DUR, r = lineR(tri, x), s = lineS(tri, x), a = tri.atr;
        const dR = (r - price) / a, dS = (price - s) / a;
        const pk = Math.abs(dR) <= Math.abs(dS) ? { side: 1, d: dR, line: r } : { side: -1, d: dS, line: s };
        if (Math.abs(pk.d) > nearAtr) return null;
        return { side: pk.side, dist: Math.abs(pk.d), over: pk.d < 0, line: pk.line, tri: { type: tri.type, touches: tri.touches, squeeze: tri.wN / tri.w0 } };
    }
    function pack(tri, c) {
        const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * DUR;
        const xEnd = Math.min(tri.apex, tri.end + 1 + 10);
        const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
        return { type: tri.type, touches: tri.touches, squeeze: Number((tri.wN / tri.w0).toFixed(2)), apex: tOf(tri.apex), res: seg(tri.R, lineR), sup: seg(tri.S, lineS), hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
    }
    function extra(c15, c1h, aggregateN, ptrMap) {
        const c2 = aggregateN(c1h, H1, AGG);
        return { c2, p2h: ptrMap(c15, c2, DUR) };
    }
    const aggregate = (c1h, aggregateN) => aggregateN(c1h, H1, AGG);
    return { cfg, detect, get, breakout, near, pack, extra, aggregate, AGG, DUR };
})();

const CFG = {
    MIN_SCORE: num('MIN_SCORE', 0),
    MKT_MODE: process.env.MKT_MODE || 'notAgainst',
    RS_LB: 24, RS_MIN: num('RS_MIN', -99),
    ENABLE_TB: flag('ENABLE_TB', true), TB_DON: num('TB_DON', 20), TB_ADX: num('TB_ADX', 18), TB_VOLX: num('TB_VOLX', 1.2),
    TB_STOP_ATR: num('TB_STOP_ATR', 2), TB_TRAIL_ATR: num('TB_TRAIL_ATR', 3), TB_CAP_R: 10,
    TB_MAX_HOLD_MS: 72 * H1, TB_TS_MS: 8 * H1, TB_TS_MFE: 0.3, TB_COOLDOWN_MS: 6 * H1,
    TB_MIN_RISK_PCT: 0.8, TB_MAX_RISK_PCT: 6, TB_MAX_COST_R: num('TB_MAX_COST_R', 0.15),
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1),
    MAX_OPEN_PER_DIR: num('MAX_OPEN_PER_DIR', 5), MAX_OPEN_TOTAL: num('MAX_OPEN_TOTAL', 10),
    MAX_PER_SCAN: 3, UNIVERSE: num('UNIVERSE', 250), MIN_VOL_USDT: num('MIN_VOL', 2e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, TRACK_MS: 15e3, UNIVERSE_MS: 5 * 60e3, KEEP: 500,
    SCAN_DELAY_MS: 8000,
    // canlı radar
    RADAR_ATR: num('RADAR_ATR', 0.8),
    ...TRI.cfg(num, flag)
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
function feats(c) {
    const cl = c.map(x => x[4]);
    return { c, cl, e21: emaSeries(cl, 21), e50: emaSeries(cl, 50), atr: atrSeries(c), rsi: rsiSeries(cl), adx: adxSeries(c), vsma: volSma(c, 20) };
}
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
    return {
        f15, f1h, f4h,
        t15: trendSeries(f15, 0.08), t1h: trendSeries(f1h, 0.10), t4h: trendSeries(f4h, 0.15),
        p1h: ptrMap(c15, c1h, H1), p4h: ptrMap(c15, c4h, 4 * H1),
        ...TRI.extra(c15, c1h, aggregateN, ptrMap)
    };
}
function rsAt(c, i, btcMap, lb) {
    if (!btcMap || i < lb) return null;
    const a = btcMap.get(c[i][0]), b = btcMap.get(c[i - lb][0]);
    if (a == null || b == null) return null;
    return ((c[i][4] / c[i - lb][4] - 1) - (a / b - 1)) * 100;
}

// ------------------------- STRATEJİ -------------------------
function signalAt(S, i, ctx) {
    const C = ctx.cfg || CFG, f = S.f15, c = f.c;
    if (i < 80) return { signal: null, reason: 'veri az' };
    const atr = f.atr[i], e21 = f.e21[i], e50 = f.e50[i], adx = f.adx[i], rv = f.rsi[i], vs = f.vsma[i];
    const j1 = S.p1h[i], j4 = S.p4h[i];
    if ([atr, e21, e50, adx, rv, vs].some(x => x == null) || j1 < 1 || j4 < 1) return { signal: null, reason: 'veri az' };
    const k0 = c[i], price = k0[4], h1 = S.t1h[j1], h4 = S.t4h[j4], t15 = S.t15[i], mkt = ctx.mkt || 0, rsv = ctx.rs;
    const volX = vs > 0 ? k0[5] / vs : 0;
    const rng = (k0[2] - k0[3]) || 1e-12, body = Math.abs(k0[4] - k0[1]) / rng, cp = (k0[4] - k0[3]) / rng;
    const mktOK = side => C.MKT_MODE === 'align' ? mkt === side : C.MKT_MODE === 'off' ? true : mkt !== -side;
    const isHourClose = (k0[0] + M15) % H1 === 0;

    const buildTB = side => {
        if (!C.ENABLE_TB || !isHourClose) return null;
        const L = side === 1, F = S.f1h, n = j1;
        if (n < C.TB_DON + 3) return { fail: 'veri az' };
        const q = F.c[n];
        if (q[0] + H1 !== k0[0] + M15) return { fail: 'tb 1h eski' };
        const a1 = F.atr[n], ad1 = F.adx[n], v1 = F.vsma[n], e1 = F.e21[n];
        if ([a1, ad1, v1, e1].some(x => x == null)) return { fail: 'veri az' };
        let ch = L ? -Infinity : Infinity, cp0 = ch;
        for (let j = n - C.TB_DON; j < n; j++) { const x = F.c[j]; if (L) { if (x[2] > ch) ch = x[2]; } else if (x[3] < ch) ch = x[3]; }
        for (let j = n - 1 - C.TB_DON; j < n - 1; j++) { const x = F.c[j]; if (L) { if (x[2] > cp0) cp0 = x[2]; } else if (x[3] < cp0) cp0 = x[3]; }
        const pc = F.c[n - 1][4];
        if (!(L ? q[4] > ch : q[4] < ch) || (L ? pc > cp0 : pc < cp0)) return { fail: 'tb kırılım yok' };
        if (ad1 < C.TB_ADX) return { fail: 'tb adx' };
        if (!mktOK(side)) return { fail: 'tb piyasa ters' };
        const vx = q[5] / v1, rg = (q[2] - q[3]) || 1e-12, bd1 = Math.abs(q[4] - q[1]) / rg, cp1 = (q[4] - q[3]) / rg;
        if (vx < C.TB_VOLX) return { fail: 'tb hacim düşük' };
        if (bd1 < 0.5 || (L ? cp1 < 0.7 : cp1 > 0.3)) return { fail: 'tb zayıf mum' };
        const ext1 = Math.abs(q[4] - e1) / a1;
        if (ext1 > 3) return { fail: 'tb uzamış' };
        const entry = price, risk = C.TB_STOP_ATR * a1, stop = entry - side * risk, riskPct = risk / entry * 100;
        if (riskPct < C.TB_MIN_RISK_PCT || riskPct > C.TB_MAX_RISK_PCT) return { fail: 'tb risk aralığı' };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.TB_MAX_COST_R) return { fail: 'tb maliyet' };
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (rsv != null && side * rsv < -2) warnings.push('BTC\'den zayıf');
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup: 'TB', setupName: '1H Kırılım', warnings,
            entry, stop, initialStop: stop, mode: 'T', tp1R: 2, tp2R: C.TB_CAP_R, capR: C.TB_CAP_R, trail: C.TB_TRAIL_ATR, atr: a1, hh: entry,
            tp1: entry + side * risk * 2, tp2: entry + side * risk * C.TB_CAP_R, tsMs: C.TB_TS_MS, tsMfe: C.TB_TS_MFE, maxHold: C.TB_MAX_HOLD_MS,
            riskPct, costR, volX: vx, adx: ad1, rsi: rv, rs: rsv, mkt, trend1h: h1, trend4h: h4,
            time: k0[0] + M15, candleT: k0[0], level: ch, lastPrice: entry, mfe: 0, mae: 0, risk,
            reason: '1H kırılım • hacim ' + vx.toFixed(1) + 'x • ADX ' + ad1.toFixed(0) + ' • stop ' + C.TB_STOP_ATR + 'xATR trailing'
        } };
    };
    const buildTR = side => {
        if (!C.ENABLE_TR || !S.c2 || !S.p2h) return null;
        const j2 = S.p2h[i];
        if (j2 == null || j2 < 60) return null;
        const q = S.c2[j2];
        if (q[0] + TRI.DUR !== k0[0] + M15) return null;
        const tri = TRI.get(S, j2, C);
        if (!tri) return side === 1 ? { fail: 'tr üçgen yok' } : null;
        const b = TRI.breakout(tri, S.c2, j2, C);
        if (b.fail) return side === 1 ? { fail: b.fail } : null;
        if (b.side !== side) return null;
        if (!mktOK(side)) return { fail: 'tr piyasa ters' };
        const L = side === 1, entry = price, ref = L ? Math.min(q[3], b.line) : Math.max(q[2], b.line);
        const stop = ref - side * C.TRI_STOP_ATR * b.atr, risk = side * (entry - stop);
        if (!(risk > 0)) return { fail: 'tr risk' };
        const riskPct = risk / entry * 100;
        if (riskPct < C.TRI_MIN_RISK_PCT || riskPct > C.TRI_MAX_RISK_PCT) return { fail: 'tr risk aralığı' };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.TRI_MAX_COST_R) return { fail: 'tr maliyet' };
        let tp2R = side * ((b.line + side * b.height) - entry) / risk;
        if (tp2R < C.TRI_MIN_TP2R) return { fail: 'tr hedef kısa' };
        tp2R = Math.min(tp2R, C.TRI_CAP_R);
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (h1 === -side) warnings.push('1H ters');
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup: 'TR', setupName: '2H Üçgen (' + tri.type + ')', warnings,
            entry, stop, initialStop: stop, mode: 'A', tp1R: 1, tp2R, capR: C.CAP_R, trail: 2, atr: b.atr,
            tp1: entry + side * risk, tp2: entry + side * risk * tp2R, tsMs: C.TRI_TS_MS, tsMfe: 0.3, maxHold: C.TRI_HOLD_MS,
            riskPct, costR, volX: b.volX, adx, rsi: rv, rs: rsv, mkt, trend1h: h1, trend4h: h4,
            time: k0[0] + M15, candleT: k0[0], level: b.line, lastPrice: entry, mfe: 0, mae: 0, risk,
            tri: TRI.pack(tri, S.c2),
            reason: tri.type + ' • ' + tri.touches + ' dokunuş • hacim ' + b.volX.toFixed(1) + 'x • hedef ' + tp2R.toFixed(1) + 'R'
        } };
    };

    const cands = [];
    for (const side of [1, -1]) {
        for (const r of [buildTB(side), buildTR(side)]) {
            if (r && r.sig) cands.push(r.sig);
        }
    }
    if (cands.length) { cands.sort((a, b) => b.risk ? a.risk - b.risk : 0); return { signal: cands[0], reason: 'sinyal' }; }

    // radar
    let near = null;
    if (ctx.watch && C.ENABLE_TB && j1 >= C.TB_DON + 3 && S.f1h.atr[j1] != null) {
        const F = S.f1h, n = j1, a1 = F.atr[n];
        for (const side of [1, -1]) {
            if (!(h1 === side && h4 === side && mktOK(side))) continue;
            let ch = side === 1 ? -Infinity : Infinity;
            for (let j = n - C.TB_DON + 1; j <= n; j++) { const x = F.c[j]; if (side === 1) { if (x[2] > ch) ch = x[2]; } else if (x[3] < ch) ch = x[3]; }
            const dist = side * (ch - price) / a1;
            if (dist >= 0 && dist <= C.RADAR_ATR && (!near || dist < near.dist)) near = { side, dist, line: ch, trigger: ch, kind: 'TB' };
        }
    }
    if (ctx.watch && C.ENABLE_TR && S.c2 && S.p2h && S.p2h[i] >= 60) {
        const j2 = S.p2h[i], tri = TRI.get(S, j2, C);
        if (tri) {
            const nr = TRI.near(tri, S.c2, j2, price, k0[0] + M15, C, C.RADAR_ATR);
            if (nr && (!near || nr.dist < near.dist)) near = { side: nr.side, dist: nr.dist, line: nr.line, trigger: nr.line, kind: 'TR', tri: nr.tri, over: nr.over };
        }
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

// ------------------------- İSTATİSTİK -------------------------
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, avgCost: 0, avgGross: 0, totalR: 0, pf: 0, dd: 0, t: 0, ci: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0, cost = 0;
    for (const s of list) {
        tot += s.netR; cost += s.costR || 0; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR;
        eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR;
    }
    const avg = tot / n; let se = 0, t = 0, ci = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)); se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; ci = 1.96 * se; }
    return { n, win: w / n, avgR: avg, avgCost: cost / n, avgGross: avg + cost / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)), ci: Number(ci.toFixed(3)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }

// ------------------------- DURUM -------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, universe: 0, eligible: 0 }, dirty = false, lastScanSlot = 0;
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), mtf = new Map();

function loadState() {
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => s.setup === 'TB' || s.setup === 'TR');
        log('durum:', signals.length, 'sinyal');
    } catch (e) { log('temiz başlangıç'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ signals: signals.slice(0, 500) })); fs.renameSync(tmp, STATE_FILE); } catch (e) { }
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
        if (Date.now() - nonCryptoAt > 6 * H1) { nonCrypto = new Set(); nonCryptoAt = Date.now(); }
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = all.filter(t => {
            if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) || nonCrypto.has(t.symbol)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) return false;
            return true;
        });
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of [BTC, ETH]) if (!top.includes(s)) top.push(s);
        universe = top; scan.universe = top.length; scan.eligible = ok.length;
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

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now();
    try {
        const S = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const d = await getMulti(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); continue; }
                    if (d.c15.length < 120 || !d.c1h || d.c1h.length < 60 || !d.c4h || d.c4h.length < 60) continue;
                    S[sym] = buildSym(d.c15, d.c1h, d.c4h);
                } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));

        let up = 0, dn = 0; const keys = Object.keys(S);
        for (const k of keys) { const v = last(S[k].t15); if (v === 1) up++; else if (v === -1) dn++; }
        const bsc = breadthScore(up, dn, keys.length);
        const bd = S[BTC] ? last(S[BTC].t15) : 0, ed = S[ETH] ? last(S[ETH].t15) : 0;
        mktDir = mktOf(bd, ed, bsc);
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, n: keys.length };

        const btcMap = S[BTC] ? new Map(S[BTC].f15.c.map(x => [x[0], x[4]])) : null;
        const watchAll = [], found = [];
        for (const sym of universe) {
            const s = S[sym]; if (!s) continue;
            const c = s.f15.c, i = c.length - 1;
            if (t0 - (c[i][0] + M15) > 2 * M15) continue;
            const t = tickers[sym] || {};
            const r = signalAt(s, i, { sym, mkt: mktDir, rs: isMajor(sym) ? null : rsAt(c, i, btcMap, CFG.RS_LB), costPct: costFor(t.quoteVolume) * CFG.COST_MULT, watch: true });
            if (r.near) {
                const kind = r.near.kind === 'TR' ? 'ÜÇGEN' : '1H';
                const state = r.near.kind === 'TR'
                    ? (r.near.tri ? r.near.tri.type + ' • ' + r.near.tri.touches + ' dokunuş • ' + (r.near.side === 1 ? 'direnç' : 'destek') + ' ' + fmt(r.near.line) + ' (' + r.near.dist.toFixed(2) + ' ATR uzakta)' : 'Üçgen')
                    : '1H seviye ' + fmt(r.near.line) + (r.near.side === 1 ? ' üstü' : ' altı') + ' (' + r.near.dist.toFixed(2) + ' ATR uzakta)';
                watchAll.push({ symbol: sym, base: baseOf(sym), price: c[i][4], bias: r.near.side === 1 ? 'LONG' : 'SHORT', rank: r.near.dist, chg24: t.percentage != null ? t.percentage : 0, kind, state });
            }
            if (r.signal) found.push(r.signal);
        }
        radar = watchAll.sort((a, b) => a.rank - b.rank).slice(0, 30);

        found.sort((a, b) => (a.risk || 99) - (b.risk || 99));
        for (const s of found) {
            const open = signals.filter(x => isOpen(x));
            if (open.filter(x => x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR) continue;
            if (open.length >= CFG.MAX_OPEN_TOTAL) continue;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < 4 * H1) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.setup + '_' + s.candleT;
            s.status = 'ACTIVE'; s.trackedTo = s.candleT + M15 - M1;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); dirty = true;
            log('SİNYAL', s.setup, s.dir, s.symbol, 'risk%', s.riskPct.toFixed(2));
            const iv = s.setup === 'TR' ? String(TRI.AGG * 60) : '15';
            const tv = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P&interval=' + iv;
            telegram((s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName +
                '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)' +
                (s.mode === 'T' ? '\nÇıkış: ' + s.trail + 'xATR trailing' : '\nTP1 ' + fmt(s.tp1) + ' | TP2 ' + fmt(s.tp2)) +
                '\n📈 ' + tv + (s.warnings && s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
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
                const since = Math.min(...list.map(x => x.trackedTo));
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
        const t = await ex.fetchTickers(); tickers = t;
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}
const selfPing = async () => { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } };

function apiState() {
    const now = Date.now();
    const closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const bySetup = groupBy(closed, s => s.setup + ' ' + s.setupName);
    const byDir = groupBy(closed, s => s.dir);
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    return {
        now, market,
        signals: signals.slice(0, 100),
        radar,
        stats: { all: grp(closed), bySetup, byDir },
        equity: eq,
        scan: { last: scan.last, ms: scan.ms, universe: scan.universe, eligible: scan.eligible },
        last24: signals.filter(s => now - s.time < 24 * H1).length
    };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const key = sym, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const raw = closedOnly(await ex.fetchOHLCV(sym, '1h', undefined, 400), H1), c2 = TRI.aggregate(raw, aggregateN);
    const cl = c2.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c2.length - 120);
    const tri = c2.length > 60 ? (TRI.detect(c2, c2.length - 1, CFG) || TRI.detect(c2, c2.length - 2, CFG)) : null;
    const d = { c: c2.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), tf: TRI.AGG + 'H', tri: tri ? TRI.pack(tri, c2) : null };
    candleCache.set(key, { t: Date.now(), d }); return d;
}

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
        for (let i = 0; i < c.length; i++) {
            const t = c[i][0], v = S.t15[i]; let a = cnt.get(t); if (!a) { a = [0, 0, 0]; cnt.set(t, a); }
            a[2]++; if (v === 1) a[0]++; else if (v === -1) a[1]++;
            if (trMap[s]) trMap[s].set(t, v);
        }
    }
    const mkt = new Map();
    for (const [t, a] of cnt) mkt.set(t, mktOf(trMap[BTC].get(t) || 0, trMap[ETH].get(t) || 0, breadthScore(a[0], a[1], a[2])));
    return { pre, maps: { mkt, btc: new Map(pre[BTC].f15.c.map(x => [x[0], x[4]])) } };
}
async function simulate(pre, use, maps, cfgO, opts, startT) {
    const C = Object.assign({}, CFG, cfgO || {}), raw = {};
    for (const sym of use) {
        const S = pre[sym], c = S.f15.c, n = c.length; let busy = 0;
        const from = Math.max(startT, c[0][0] + 11 * D1);
        for (let i = 80; i < n - 1; i++) {
            const t = c[i][0]; if (t < from || t < busy) continue;
            const r = signalAt(S, i, { sym, mkt: maps.mkt.get(t) || 0, rs: isMajor(sym) ? null : rsAt(c, i, maps.btc, C.RS_LB), costPct: S.costPct, cfg: C });
            if (!r.signal) continue;
            const s = r.signal; s.status = 'ACTIVE';
            for (let j = i + 1; j < n; j++) { if (advance(s, c[j], M15) && !isOpen(s)) break; }
            if (isOpen(s)) continue;
            raw[s.symbol + '_' + s.candleT] = { symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, time: s.time, candleT: s.candleT, closedAt: s.closedAt, netR: s.netR, costR: s.costR, status: s.status };
            busy = Math.max(s.closedAt, s.time + 4 * H1);
        }
    }
    const arr = Object.values(raw).sort((a, b) => a.time - b.time);
    const trades = [], openL = [];
    for (const t of arr) {
        for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
        if (openL.filter(o => o.dir === t.dir).length >= C.MAX_OPEN_PER_DIR || openL.length >= C.MAX_OPEN_TOTAL) continue;
        openL.push(t); trades.push(t);
    }
    return { trades };
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
            try {
                const h = await fetchHistory15(s, days);
                if (h.usable < 4 && !isMajor(s)) skipped.push(baseOf(s));
                else { data[s] = h.c; usableMax = Math.max(usableMax, h.usable); }
            } catch (e) { skipped.push(baseOf(s) + '(hata)'); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 1500) throw new Error('BTC verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];
        btJob.msg = 'Hesaplanıyor';
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult);
        const effDays = Math.max(1, Math.min(days, Math.round(usableMax))), startT = Date.now() - days * D1;
        const r = await simulate(pre, Object.keys(data), maps, {}, opts, startT);
        const trades = r.trades;
        btJob.result = {
            days: effDays, coins, skipped: skipped.slice(0, 10),
            all: grp(trades),
            bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName),
            byDir: groupBy(trades, s => s.dir),
            byExit: groupBy(trades, s => s.status)
        };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Hata: ' + e.message; }
    btJob.running = false;
}

// ------------------------- ARAYÜZ -------------------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v15</title>
<style>
:root{--bg:#0d0f12;--p1:#161a1f;--p2:#1c2228;--ln:#2a323b;--tx:#e8edf2;--dm:#8a95a3;--lg:#3ddc97;--st:#ff5f6d;--am:#f5b942;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}
.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.am{color:var(--am)}
.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:420px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}
.tab{flex:1;padding:12px 4px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.card.live{border-left:3px solid var(--am)}
.r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,95,109,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}
.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(245,185,66,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,95,109,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}
th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(42,50,59,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:380px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--am)}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.frm input{width:90px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.note{font-size:11px;color:var(--dm);margin-top:8px}
.empty{color:var(--dm);text-align:center;padding:30px 10px;font-size:12px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:280px}}
</style>
</head>
<body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v15</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div>
  <div class="grow"></div>
  <span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<script>
const TABS=[['sig','Sinyaller'],['radar','Radar'],['stat','İstatistik'],['bt','Test']];
let S=null,tab='sig',sel=null,bt=null,chartCache={},chartFor='',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),lastSigId=null;
const $=id=>document.getElementById(id);
const fp=p=>{if(p==null)return'-';p=Number(p);const a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)};
const f2=(x,d=2)=>x==null||isNaN(x)?'-':Number(x).toFixed(d);
const sg=(x,d=2)=>{x=Number(x);return(x>0?'+':'')+x.toFixed(d)};
const cl=x=>x>0?'up':x<0?'dn':'fl';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ts=>{const m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s'};
const openS=s=>s.status==='ACTIVE'||s.status==='TP1_HIT';
const pnlR=s=>s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null;
const pnlUSDT=s=>{const r=pnlR(s);if(r==null)return null;const bal=+cfgC.bal||0,ru=bal*(Math.min(2,+cfgC.risk||0))/100;return r*ru;};
const ST={ACTIVE:['AÇIK','w'],TP1_HIT:['TP1 ✓','g'],TP2:['TP2 ✓','g'],TRAIL:['Trailing','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre','w']};
function beep(){try{const a=new(window.AudioContext||window.webkitAudioContext)();const o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.08;o.start();o.stop(a.currentTime+.25)}catch(e){}}

function renderTop(){
 const md=S.market&&S.market.mood;
 $('cMkt').innerHTML=md?'<b>Piyasa</b> <span class="'+(md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl')+'"><b style="color:inherit">'+md.label+'</b></span> <span class="fl">'+md.up+'↑/'+md.down+'↓</span>':'<b>Piyasa</b> ...';
 [['cBTC','BTC','btc'],['cETH','ETH','eth']].forEach(a=>{const m=S.market[a[2]];$(a[0]).innerHTML=m?'<b>'+a[1]+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg)+'%</span>':'<b>'+a[1]+'</b> -'});
 $('modeB').textContent='v15';
}
function renderTabs(){const oc=S.signals.filter(openS).length;
 $('tabs').innerHTML=TABS.map(t=>'<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?' ('+oc+')':'')+'</button>').join('');
 [...$('tabs').children].forEach(b=>b.onclick=()=>{tab=b.dataset.t;if(tab!=='bt')sel=null;renderAll()});
}
function sigCard(s){
 const st=ST[s.status]||['?',''],R=pnlR(s),U=pnlUSDT(s);let pn='';
 if(openS(s)&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R <span class="fl" style="font-size:10px">('+sg(U||0)+'$)</span></span>';
 else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed')+(openS(s)?' live':'')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span><span class="tag">'+esc(s.setupName||s.setup)+'</span>'+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Şu an '+fp(s.lastPrice||s.entry)+'</span><span>Stop '+fp(s.stop)+'</span><span>Risk '+f2(s.riskPct)+'%</span><span>'+ago(s.time)+' önce</span></div></div>';
}
function radarCard(r){return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span><span class="tag w">'+esc(r.kind)+'</span><span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.chg24)+'" style="font-size:12px">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>'+esc(r.state)+'</span></div></div>'}
function renderList(){let h='';
 if(tab==='sig'){const a=S.signals.filter(openS),c=S.signals.filter(s=>!openS(s)).slice(0,25);
  h+=a.length?a.map(sigCard).join(''):'<div class="empty">Açık sinyal yok.<br><br>Kırılım olunca otomatik düşer.</div>';
  if(c.length)h+='<h3>Kapanmış</h3>'+c.map(sigCard).join('')}
 else if(tab==='radar')h=S.radar.length?S.radar.map(radarCard).join(''):'<div class="empty">Yaklaşan seviye yok.</div>';
 else h='<div class="empty">Detay sağ panelde.</div>';
 $('list').innerHTML=h;
 [...$('list').querySelectorAll('.card')].forEach(e=>e.onclick=()=>{const id=e.dataset.id,sy=e.dataset.sym;
  if(id)sel={id,sym:S.signals.find(x=>x.id===id).symbol};else sel={sym:sy};chartFor='';renderList();renderMain()});
}

function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){const upd=()=>{cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));const bal=cfgC.bal,rk=cfgC.risk,ru=bal*rk/100,E=+$('cE').value,S=+$('cS').value,d=Math.abs(E-S);if(!d||!bal)return $('cOut').innerHTML='Değerleri gir.';
  const q=ru/d;$('cOut').innerHTML='1R = <b>'+f2(ru)+' USDT</b> &nbsp; Miktar <b>'+f2(q,4)+'</b> &nbsp; Pozisyon <b>'+f2(q*E,1)+' USDT</b> &nbsp; Kaldıraç <b>'+f2(q*E/bal,1)+'x</b>'};
 ['cBal','cRisk','cE','cS'].forEach(i=>{const e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

function sigView(s){const st=ST[s.status]||['?',''],R=pnlR(s),U=pnlUSDT(s),w=(s.warnings||[]).map(x=>'<span class="tag w">'+esc(x)+'</span> ').join('');
 const live=openS(s)?'<span class="tag g">CANLI</span>':'';
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2>'+live+'<span class="tag '+st[1]+'">'+st[0]+'</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce</div>'+w+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Şu an</span><b>'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>K/Z ($)</span><b class="'+cl(U)+'">'+(U!=null?sg(U)+'$':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="https://www.tradingview.com/chart/?symbol=BITGET:'+s.base+'USDT.P&interval='+(s.setup==='TR'?120:60)+'" target="_blank">📈 TradingView</a></div><div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div>'+calcBox(s.entry,s.initialStop);
}
function homeView(){const a=S.stats.all||{n:0,win:0,avgR:0,totalR:0,pf:0};
 return '<h2>Genel bakış</h2><div class="tiles"><div class="tile"><div class="k">Açık sinyal</div><div class="v">'+S.signals.filter(openS).length+'</div></div><div class="tile"><div class="k">Son 24s sinyal</div><div class="v">'+S.last24+'</div></div><div class="tile"><div class="k">Radar</div><div class="v">'+S.radar.length+'</div></div><div class="tile"><div class="k">Kapanan</div><div class="v">'+a.n+'</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Nasıl çalışır</h3><div class="note" style="color:var(--tx)">Bot iki strateji tarar: <b>1H Kırılım</b> (fiyat son 20 saatin zirvesini/dibini ilk kez kırar) ve <b>2H Üçgen Kırılımı</b> (daralan üçgen içinde 4+ dokunuş, kırılım mumu güçlü). Kırılım olur olmaz <b>Sinyaller</b> sekmesine düşer ve Telegram\'a gider. Radar sekmesi kırılım <b>yaklaşan</b> seviyeleri gösterir, henüz tetiklenmemiş.</div><div class="note" style="color:var(--tx)"><b>Giriş:</b> grafikte gösterilen seviyelerden. <b>Stop:</b> ATR bazlı. <b>Çıkış:</b> 1H kırılımda trailing stop (3×ATR), 2H üçgende TP1/TP2.</div></div>'+
 '<div class="box"><h3 style="margin-top:0">Son tarama</h3><div class="note" style="color:var(--tx)">'+(S.scan.last?ago(S.scan.last)+' önce, '+f2(S.scan.ms/1000,1)+' sn':'...')+' • '+S.scan.eligible+' uygun / '+S.scan.universe+' coin</div></div>';
}
const tbl=(t,title)=>'<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Net R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(k=>{const x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>';
function statView(){const a=S.stats.all||{n:0,win:0,avgR:0,totalR:0,pf:0,dd:0};
 return '<h2>İstatistik (kapanan sinyaller)</h2><div class="tiles"><div class="tile"><div class="k">İşlem</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">Toplam R</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'</div></div></div>'+tbl(S.stats.bySetup||{},'Kurulum')+tbl(S.stats.byDir||{},'Yön');
}
const _bs=JSON.parse(localStorage.getItem('st_bt')||'{"d":90,"c":100,"m":1}');
const opt=(v,cur,t)=>'<option value="'+v+'"'+(+cur===v?' selected':'')+'>'+t+'</option>';
function btView(){let h='<h2>Geçmiş veri testi</h2><div class="box"><div class="frm"><select id="bD">'+opt(30,_bs.d,'30 gün')+opt(60,_bs.d,'60 gün')+opt(90,_bs.d,'90 gün')+'</select><select id="bC">'+opt(50,_bs.c,'50 coin')+opt(100,_bs.c,'100 coin')+opt(150,_bs.c,'150 coin')+opt(250,_bs.c,'250 coin')+'</select><select id="bM">'+opt(1,_bs.m,'Maliyet x1')+opt(1.5,_bs.m,'Maliyet x1.5')+opt(2,_bs.m,'Maliyet x2')+'</select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">Bu test, kapanmış sinyallerin geçmişte ne yapacağını ölçer. 90 gün ve 200+ işlem şart.</div></div>';
 if(!bt)return h;
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){const R=bt.result,a=R.all;
  h+='<div class="tiles"><div class="tile"><div class="k">İşlem</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">t-stat</div><div class="v">'+f2(a.t,2)+'</div></div></div>';
  h+=tbl(R.bySetup,'Kurulum')+tbl(R.byDir,'Yön')+tbl(R.byExit,'Çıkış');
 }
 return h;
}
function bindBt(){[['bD','d'],['bC','c'],['bM','m']].forEach(a=>{const e=$(a[0]);if(e)e.onchange=()=>{_bs[a[1]]=+e.value;localStorage.setItem('st_bt',JSON.stringify(_bs))}});
 const b=$('bGo');if(b)b.onclick=async()=>{const r=await fetch('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:+$('bD').value,coins:+$('bC').value,costMult:+$('bM').value})});if(r.ok)pollBt()}}
function pollBt(){fetch('/api/backtest').then(r=>r.json()).then(d=>{bt=d;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}

function drawChart(d,s){const c=$('cv');if(!c||!d||!d.c.length)return;
 const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 const x=c.getContext('2d');x.scale(dp,dp);
 const tri=s&&s.tri?s.tri:d.tri,nc=d.c.length,n=nc+(tri?10:0);
 const L=8,R=90,T=12,B=20,PW=W-L-R,PH=H-T-B;
 const ti=t=>(t-d.c[0][0])/d.dur;
 let hi=-1e99,lo=1e99;d.c.forEach(k=>{hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 const lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.stop,'#ff5f6d','STOP'],[s.entry,'#5aa9ff','GİRİŞ']]:[];
 lv.forEach(a=>{hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});
 const tl=[];
 if(tri)[tri.res,tri.sup].forEach(l=>{const a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(q=>{const v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 const pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 const Y=p=>T+(hi-p)/(hi-lo)*PH,X=k=>L+(k+.5)/n*PW,cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8a95a3';
 for(let i=0;i<=4;i++){const gy=T+PH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 const line=(arr,col,w)=>{x.strokeStyle=col;x.lineWidth=w;x.beginPath();let st=false;arr.forEach((v,k)=>{if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#8a95a3',1.2);line(d.e21,'#f5b942',1.4);
 d.c.forEach((k,i)=>{const col=k[4]>=k[1]?'#3ddc97':'#ff5f6d';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(l=>{x.strokeStyle='#ffd400';x.lineWidth=2.2;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='#ffd400';tri.hi.concat(tri.lo).forEach(p=>{x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),3,0,7);x.fill()});
  x.restore()}
 lv.forEach(a=>{x.strokeStyle=x.fillStyle=a[1];x.lineWidth=a[2]==='GİRİŞ'?2:1.3;x.setLineDash(a[2]==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.font='bold 10px system-ui';x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 const lp=s&&s.lastPrice?s.lastPrice:d.c[nc-1][4];
 if(s){ // canlı çizgi ve K/Z kutusu
   x.strokeStyle='#fff';x.lineWidth=1.2;x.setLineDash([3,3]);x.beginPath();x.moveTo(L,Y(lp));x.lineTo(W-R,Y(lp));x.stroke();x.setLineDash([]);
 }
 x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp)-9,68,18);x.fillStyle='#0d0f12';x.font='bold 11px system-ui';x.fillText(fp(lp),W-R+2,Y(lp)+4);
 if(s){const R=pnlR(s),col=R>0?'#3ddc97':R<0?'#ff5f6d':'#8a95a3';x.fillStyle=col;x.font='bold 12px system-ui';x.fillText((R>0?'+':'')+R.toFixed(2)+'R',L+4,T+14)}
 x.fillStyle='#8a95a3';x.font='10px system-ui';x.fillText((tri?tri.type+' • ':'')+d.tf+' • EMA21 sarı • EMA50 gri',L+4,H-5)}
function loadChart(sym){const s=sel&&sel.id?S.signals.find(x=>x.id===sel.id):null;fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(r=>r.json()).then(d=>{chartCache[sym]=d;if(sel&&sel.sym===sym&&$('cv'))drawChart(d,s)}).catch(()=>{})}

function renderMain(){const M=$('main');
 if(tab==='stat'){M.innerHTML=statView();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){const s=S.signals.find(x=>x.id===sel.id);if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol)}return}}
 if(sel&&sel.sym){const r=S.radar.find(x=>x.symbol===sel.sym);M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split(':')[0])+'</h2>'+(r?'<span class="tag w">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval=120" target="_blank">📈 TradingView</a></div><canvas id="cv"></canvas>'+calcBox('','');bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym)}return}
 M.innerHTML=homeView();
}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch('/api/state').then(r=>r.json()).then(d=>{
 const prevIds=S?new Set(S.signals.filter(openS).map(x=>x.id)):new Set();
 S=d;const newIds=d.signals.filter(openS).map(x=>x.id);const fresh=newIds.filter(id=>!prevIds.has(id));
 if(fresh.length&&prevIds.size){beep();document.title='('+fresh.length+') YENİ SİNYAL • SONER'}
 $('dot').className='dot on';$('conn').textContent='Bağlı';renderAll();
}).catch(()=>{$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('focus',()=>{document.title='SONER TRADE v15'});
addEventListener('resize',()=>{if(S)renderMain()});
setInterval(poll,5000);setInterval(()=>{if(sel&&sel.sym)loadChart(sel.sym)},20000);poll();pollBt();
</script>
</body>
</html>
`;

// ------------------------- HTTP -------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { r({}); req.destroy(); } }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); req.on('error', () => r({})); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            const b = await readBody(req);
            const days = [30, 60, 90].includes(b.days) ? b.days : 90, coins = [50, 100, 150, 250].includes(b.coins) ? b.coins : 100;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1;
            if (!btJob.running) runBacktest(days, coins, { costMult });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true });
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
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(track, CFG.TRACK_MS); setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3); setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);
        log('SONER TRADE v15 hazır | TB ' + (CFG.ENABLE_TB ? 'açık' : 'kapalı') + ' | TR ' + (CFG.ENABLE_TR ? 'açık' : 'kapalı'));
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, signalAt, advance, buildSym, CFG, TRI };
