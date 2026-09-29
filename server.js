'use strict';
// ============================================================
// SONER TRADE v11 + GÖLGE SİNYAL — 15m TREND PULLBACK
// Ana strateji tek, gölge varyantlar aynı veriyle paralel test
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

const CFG = {
    MIN_SCORE: num('MIN_SCORE', 0),   // puan kapısı kapalı: puanın öngörü gücü kanıtlanmadı
    ENABLE_PB: flag('ENABLE_PB', true), ENABLE_SW: flag('ENABLE_SW', false),
    REQ_4H: flag('REQ_4H', false), TREND_LOOSE: flag('TREND_LOOSE', false),
    MKT_MODE: process.env.MKT_MODE || 'notAgainst',
    MIN_ADX: num('MIN_ADX', 20),
    RS_LB: 24, RS_MIN: num('RS_MIN', 0),
    PB_WIN: 6, PB_TOUCH_ATR: 0.10, PB_MAX_DEPTH_ATR: 0.5, PB_DRY: num('PB_DRY', 1.1),
    PB_MIN_VOLX: num('PB_MIN_VOLX', 1.0), VOL_MAX: num('VOL_MAX', 2.8),
    MIN_BODY: 0.5, MIN_CLOSEPOS: 0.65, RSI_L: [42, 65], RSI_S: [35, 58], MAX_EXT_ATR: 1.0,
    SW_LOOK: 32, SW_DEPTH_ATR: 0.10, SW_WICK: 0.45, SW_MIN_VOLX: 1.5,
    STOP_BUF_ATR: num('STOP_BUF_ATR', 0.30), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.6), MAX_RISK_PCT: 3.5,
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1), MAX_COST_R: num('MAX_COST_R', 0.18),
    ROOM_MIN: num('ROOM_MIN', 1.2), ROOM_LOOK: 96,
    EXIT_MODE: process.env.EXIT_MODE || 'A',
    TP1_R: num('TP1_R', 1.0), TP2_R: num('TP2_R', 2.0), TPB_R: 1.5, TRAIL_ATR: 2, CAP_R: 4,
    TIME_STOP_MS: 6 * M15, TIME_STOP_MFE: 0.3, MAX_HOLD_MS: 8 * H1,
    COOLDOWN_MS: 2 * H1, MAX_OPEN_PER_DIR: 2, MAX_OPEN_TOTAL: 4, MAX_PER_SCAN: 2, DAY_STOP_R: -3,
    MAX_SIGNAL_AGE_MS: 5 * 60e3, SCAN_DELAY_MS: 8000,
    UNIVERSE: num('UNIVERSE', 150), MIN_VOL_USDT: Math.min(num('MIN_VOL', 3e6), 3e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, TRACK_MS: 15e3, UNIVERSE_MS: 5 * 60e3, KEEP: 1000,
    HEALTH_N: 30, HEALTH_MIN_R: 0
};

// Varyantlar: shadow=true olanlar canlıda paralel kağıt test
const VARIANTS = [
    { name: 'Temel v11', o: {} },
    { name: 'Sweep de açık', o: { ENABLE_SW: true }, shadow: true },
    { name: 'Piyasa uyumu şart (align)', o: { MKT_MODE: 'align' } },
    { name: 'Piyasa filtresi yok', o: { MKT_MODE: 'off' }, shadow: true },
    { name: 'RS filtresi yok', o: { RS_MIN: -99 }, shadow: true },
    { name: '4H uyumu şart', o: { REQ_4H: true } },
    { name: 'Hacim tavanı yok', o: { VOL_MAX: 99 } },
    { name: 'Pullback hacim kuruması yok', o: { PB_DRY: 99 } },
    { name: 'ADX 25+', o: { MIN_ADX: 25 }, shadow: true },
    { name: 'ADX 15+', o: { MIN_ADX: 15 }, shadow: true },
    { name: 'Trend gevşek (1H nötr olabilir)', o: { TREND_LOOSE: true }, shadow: true },
    { name: 'ADX25 + RS yok (kombine)', o: { MIN_ADX: 25, RS_MIN: -99 }, shadow: true },
    { name: 'Çıkış B: tek hedef 1.5R', o: { EXIT_MODE: 'B' }, shadow: true },
    { name: 'Çıkış C: trailing', o: { EXIT_MODE: 'C' }, shadow: true },
    { name: 'Maliyet gevşek (v10 benzeri)', o: { MAX_COST_R: 0.30, MIN_RISK_PCT: 0.25 }, shadow: true }
];
const SHADOW = VARIANTS.filter(v => v.shadow);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const trHour = t => String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00';
const session = t => { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya (03-10 TR)' : h < 13 ? '2 Londra (10-16 TR)' : h < 21 ? '3 ABD (16-00 TR)' : '4 Gece (00-03 TR)'; };
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
    for (let i = p + 1; i < cl.length; i++) {
        const d = cl[i] - cl[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
        o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
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
        dxs.push(dxAt());
        const k = dxs.length;
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
    return { f15, t15: trendSeries(f15, 0.08), t1h: trendSeries(f1h, 0.10), t4h: trendSeries(f4h, 0.15), p1h: ptrMap(c15, c1h, H1), p4h: ptrMap(c15, c4h, 4 * H1) };
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
    if (i < 80) return { signal: null, reason: 'veri az', stage: 0 };
    const atr = f.atr[i], e21 = f.e21[i], e50 = f.e50[i], adx = f.adx[i], rv = f.rsi[i], vs = f.vsma[i];
    const j1 = S.p1h[i], j4 = S.p4h[i];
    if ([atr, e21, e50, adx, rv, vs].some(x => x == null) || j1 < 1 || j4 < 1) return { signal: null, reason: 'veri az', stage: 0 };
    const k0 = c[i], price = k0[4], h1 = S.t1h[j1], h4 = S.t4h[j4], t15 = S.t15[i], mkt = ctx.mkt || 0, rsv = ctx.rs;
    const minScore = ctx.minScore != null ? ctx.minScore : C.MIN_SCORE;
    const volX = vs > 0 ? k0[5] / vs : 0;
    const rng = (k0[2] - k0[3]) || 1e-12, body = Math.abs(k0[4] - k0[1]) / rng, cp = (k0[4] - k0[3]) / rng;
    const mktOK = side => C.MKT_MODE === 'align' ? mkt === side : C.MKT_MODE === 'off' ? true : mkt !== -side;

    const finish = (setup, name, side, o) => {
        const L = side === 1, entry = price, stop = o.ref - side * C.STOP_BUF_ATR * atr, risk = side * (entry - stop);
        if (!(risk > 0)) return { fail: 'risk', stage: 9 };
        const riskPct = risk / entry * 100;
        if (riskPct < C.MIN_RISK_PCT || riskPct > C.MAX_RISK_PCT) return { fail: 'risk aralığı', stage: 9 };
        const costPct = ctx.costPct != null ? ctx.costPct : C.COST_PCT, costR = costPct / riskPct;
        if (costR > C.MAX_COST_R) return { fail: 'maliyet', stage: 10 };
        let tgt = L ? -Infinity : Infinity;
        for (let j = Math.max(0, i - C.ROOM_LOOK); j < i; j++) { if (L) { if (c[j][2] > tgt) tgt = c[j][2]; } else if (c[j][3] < tgt) tgt = c[j][3]; }
        let room = side * (tgt - entry) / risk; if (room <= 0) room = 9;
        if (room < C.ROOM_MIN) return { fail: 'oda yok', stage: 11 };
        const parts = {};
        parts.trend = adx >= 30 ? 25 : adx >= 25 ? 20 : adx >= C.MIN_ADX ? 12 : 5;
        parts.rs = rsv == null ? 8 : Math.round(Math.max(0, Math.min(20, side * rsv * 8)));
        parts.htf = (h1 === side ? 8 : 0) + (h4 === side ? 7 : 0);
        parts.pullback = (o.dry <= 0.8 ? 8 : o.dry <= 1.0 ? 5 : 2) + (o.extd <= 0.5 ? 7 : o.extd <= 0.9 ? 4 : 1);
        parts.oda = room >= 3 ? 15 : room >= 2 ? 11 : room >= 1.5 ? 8 : 4;
        parts.maliyet = costR <= 0.08 ? 10 : costR <= 0.12 ? 7 : 4;
        let score = 0; for (const k in parts) score += parts[k];
        if (score < minScore) return { fail: 'skor', stage: 12 };
        const warnings = [];
        if (mkt === -side) warnings.push('Piyasa ters');
        if (rsv != null && side * rsv < 0) warnings.push('BTC\'den zayıf');
        const mode = C.EXIT_MODE, tp1R = mode === 'B' ? C.TPB_R : C.TP1_R;
        return { sig: {
            symbol: ctx.sym, base: baseOf(ctx.sym), dir: L ? 'LONG' : 'SHORT', setup, setupName: name, score, parts, warnings,
            entry, stop, initialStop: stop, mode, tp1R, tp2R: C.TP2_R, capR: C.CAP_R, trail: C.TRAIL_ATR, atr,
            tp1: entry + side * risk * tp1R, tp2: entry + side * risk * C.TP2_R,
            tsMs: C.TIME_STOP_MS, tsMfe: C.TIME_STOP_MFE,
            riskPct, costR, volX: o.volX != null ? o.volX : volX, adx, rsi: rv, room, rs: rsv, trend: t15, trend1h: h1, trend4h: h4, mkt,
            time: k0[0] + M15, candleT: k0[0], level: o.level, lastPrice: entry, mfe: 0, mae: 0,
            reason: name + ' | hacim ' + volX.toFixed(1) + 'x | ADX ' + adx.toFixed(0) + ' | hedef alanı ' + room.toFixed(1) + 'R'
        } };
    };

    const buildPB = side => {
        const L = side === 1;
        const h4ok = C.REQ_4H ? h4 === side : h4 !== -side;
        if (!(t15 === side && (C.TREND_LOOSE ? h1 !== -side : h1 === side) && h4ok)) return { fail: 'trend yok', stage: 1 };
        if (adx < C.MIN_ADX) return { fail: 'adx', stage: 2 };
        if (!mktOK(side)) return { fail: 'piyasa ters', stage: 3 };
        if (rsv != null && side * rsv < C.RS_MIN) return { fail: 'rs zayıf', stage: 3 };
        if (!(L ? (e21 > e50 && price > e50) : (e21 < e50 && price < e50))) return { fail: 'pullback yok', stage: 4 };
        let touched = false, held = true, ext = L ? Infinity : -Infinity;
        for (let j = i - C.PB_WIN; j < i; j++) {
            const x = c[j], a = f.e21[j], b = f.e50[j]; if (a == null || b == null) continue;
            if (L) { if (x[3] <= a + C.PB_TOUCH_ATR * atr) touched = true; if (x[4] < b) held = false; if (x[3] < ext) ext = x[3]; }
            else { if (x[2] >= a - C.PB_TOUCH_ATR * atr) touched = true; if (x[4] > b) held = false; if (x[2] > ext) ext = x[2]; }
        }
        if (!touched || !held) return { fail: 'pullback yok', stage: 4 };
        if (L ? ext < e50 - C.PB_MAX_DEPTH_ATR * atr : ext > e50 + C.PB_MAX_DEPTH_ATR * atr) return { fail: 'pullback derin', stage: 4 };
        const prev = c[i - 1];
        const trig = L ? (k0[4] > k0[1] && k0[4] > e21 && k0[4] > prev[2] && cp >= C.MIN_CLOSEPOS)
                       : (k0[4] < k0[1] && k0[4] < e21 && k0[4] < prev[3] && cp <= 1 - C.MIN_CLOSEPOS);
        if (!trig || body < C.MIN_BODY) return { fail: 'tetik yok', stage: 5 };
        if (volX < C.PB_MIN_VOLX) return { fail: 'hacim düşük', stage: 6 };
        if (volX > C.VOL_MAX) return { fail: 'klimaks hacim', stage: 6 };
        const pv = (c[i - 1][5] + c[i - 2][5] + c[i - 3][5]) / 3, dry = vs > 0 ? pv / vs : 1;
        if (dry > C.PB_DRY) return { fail: 'pullback hacmi yüksek', stage: 6 };
        const rr = L ? C.RSI_L : C.RSI_S;
        if (rv < rr[0] || rv > rr[1]) return { fail: 'rsi', stage: 7 };
        const extd = Math.abs(price - e21) / atr;
        if (extd > C.MAX_EXT_ATR) return { fail: 'uzamış', stage: 8 };
        return finish('PB', 'Trend Pullback', side, { ref: L ? Math.min(ext, k0[3]) : Math.max(ext, k0[2]), extd, dry, level: e21 });
    };

    const buildSW = side => {
        const L = side === 1, s = i - 1;
        if (!(t15 !== -side && h1 !== -side && h4 !== -side)) return { fail: 'trend yok', stage: 1 };
        if (!mktOK(side)) return { fail: 'piyasa ters', stage: 3 };
        let lvl = L ? Infinity : -Infinity;
        for (let j = s - C.SW_LOOK; j < s; j++) { const x = c[j]; if (L) { if (x[3] < lvl) lvl = x[3]; } else if (x[2] > lvl) lvl = x[2]; }
        const sc = c[s], r = (sc[2] - sc[3]) || 1e-12;
        const depth = L ? (lvl - sc[3]) / atr : (sc[2] - lvl) / atr, back = L ? sc[4] > lvl : sc[4] < lvl;
        const wick = L ? (Math.min(sc[1], sc[4]) - sc[3]) / r : (sc[2] - Math.max(sc[1], sc[4])) / r;
        if (depth < C.SW_DEPTH_ATR || !back || wick < C.SW_WICK) return { fail: 'sweep yok', stage: 4 };
        const confirm = L ? (k0[4] > k0[1] && k0[4] > sc[4] && k0[4] > lvl) : (k0[4] < k0[1] && k0[4] < sc[4] && k0[4] < lvl);
        if (!confirm || body < C.MIN_BODY * 0.8) return { fail: 'tetik yok', stage: 5 };
        const sv = f.vsma[s], svx = sv > 0 ? sc[5] / sv : 0;
        if (svx < C.SW_MIN_VOLX) return { fail: 'hacim düşük', stage: 6 };
        const extd = Math.abs(price - lvl) / atr;
        if (extd > 1.5) return { fail: 'uzamış', stage: 8 };
        return finish('SW', 'Sweep Dönüşü', side, { ref: L ? Math.min(sc[3], k0[3]) : Math.max(sc[2], k0[2]), extd: extd * 0.66, dry: 1, volX: svx, level: lvl });
    };

    const cands = []; let best = { reason: 'trend yok', stage: 0 };
    for (const side of [1, -1]) {
        for (const r of [C.ENABLE_PB ? buildPB(side) : null, C.ENABLE_SW ? buildSW(side) : null]) {
            if (!r) continue;
            if (r.sig) cands.push(r.sig); else if (r.stage > best.stage) best = { reason: r.fail, stage: r.stage };
        }
    }
    if (cands.length) { cands.sort((a, b) => b.score - a.score); return { signal: cands[0], reason: 'sinyal', stage: 99 }; }

    let near = null;
    if (ctx.watch) {
        for (const side of [1, -1]) {
            const L = side === 1;
            if (t15 === side && h1 === side && adx >= C.MIN_ADX && mktOK(side) && (L ? (e21 > e50 && price > e50) : (e21 < e50 && price < e50))) {
                const dist = Math.abs(price - e21) / atr;
                if (dist <= 0.8 && (!near || dist < near.dist)) near = { side, dist, e21, trigger: L ? k0[2] : k0[3] };
            }
        }
    }
    return { signal: null, reason: best.reason, stage: best.stage, near };
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
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, end); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) {
            if (s.mode === 'B') { closeSig(s, 'TP', T1, end); return true; }
            s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; s.hh = L ? k[2] : k[3]; return true;
        }
        if (el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', rA(k[4]), end); return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * T1 + 0.5 * rA(s.stop), end); return true; }
        if (s.mode === 'C') {
            s.hh = L ? Math.max(s.hh, k[2]) : Math.min(s.hh, k[3]);
            const ns = s.hh - sg * s.trail * s.atr; if (L ? ns > s.stop : ns < s.stop) s.stop = ns;
            if (rA(s.hh) >= s.capR) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * s.capR, end); return true; }
        } else if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * T2, end); return true; }
    }
    if (el >= CFG.MAX_HOLD_MS && isOpen(s)) { const r = rA(k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * T1 + 0.5 * r : r, end); return true; }
    return false;
}

// ------------------------- İSTATİSTİK -------------------------
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, avgCost: 0, avgGross: 0, totalR: 0, pf: 0, dd: 0, se: 0, t: 0, ci: 0, avgHold: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0, hold = 0, cost = 0;
    for (const s of list) {
        tot += s.netR; cost += s.costR || 0; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR;
        eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR;
        if (s.closedAt && s.time) hold += s.closedAt - s.time;
    }
    const avg = tot / n; let se = 0, t = 0, ci = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)); se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; ci = 1.96 * se; }
    return { n, win: w / n, avgR: avg, avgCost: cost / n, avgGross: avg + cost / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, se, t: Number(t.toFixed(2)), ci: Number(ci.toFixed(3)), avgHold: Number((hold / n / 60000).toFixed(1)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 70 ? '4 70+' : s.score >= 60 ? '3 60-69' : s.score >= 50 ? '2 50-59' : '1 <50';
const mktName = s => s.mkt === 1 ? 'Piyasa LONG' : s.mkt === -1 ? 'Piyasa SHORT' : 'Piyasa YATAY';
const sessOf = s => session(s.candleT != null ? s.candleT : s.time - M15);
function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return { all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)),
        bySetup: groupBy(sorted, s => s.setup + ' ' + s.setupName), byDir: groupBy(sorted, s => s.dir), byBand: groupBy(sorted, band),
        bySession: groupBy(sorted, sessOf), byMkt: groupBy(sorted, mktName), byExit: groupBy(sorted, s => s.status), byHour: groupBy(sorted, s => trHour(s.time)) };
}
function health() {
    const cl = signals.filter(s => !s.shadow && !isOpen(s) && s.netR != null).sort((a, b) => b.closedAt - a.closedAt).slice(0, CFG.HEALTH_N);
    const g = grp(cl), today = trDay(Date.now());
    const dayR = signals.filter(s => !s.shadow && !isOpen(s) && s.netR != null && trDay(s.closedAt) === today).reduce((a, s) => a + s.netR, 0);
    const badEdge = g.n >= CFG.HEALTH_N && g.avgR < CFG.HEALTH_MIN_R, dayStop = dayR <= CFG.DAY_STOP_R;
    return { n: g.n, need: CFG.HEALTH_N, avgR: g.avgR, dayR, badEdge, dayStop, paper: badEdge || dayStop };
}

// ------------------------- DURUM -------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, reasonDay: '', total: 0, eligible: 0, excluded: 0, suspect: 0 }, dirty = false, lastScanSlot = 0;
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map(), mtf = new Map();

function loadState() {
    try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); signals = j.signals || []; lastSig = j.lastSig || {}; log('durum:', signals.length, 'sinyal'); }
    catch (e) { log('temiz başlangıç (state.json yok).'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig })); fs.renameSync(tmp, STATE_FILE); } catch (e) { log('kayıt hatası', e.message); }
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
    const get = () => Promise.all([fetchTF(sym, '15m', 300, M15), need1h ? fetchTF(sym, '1h', 150, H1) : null, need4h ? fetchTF(sym, '4h', 150, 4 * H1) : null]);
    let d; try { d = await get(); } catch (e) { await sleep(400); d = await get(); }
    rec.c15 = d[0]; if (d[1]) rec.c1h = d[1]; if (d[2]) rec.c4h = d[2];
    mtf.set(sym, rec); return rec;
}

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.reasonDay = day; }
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
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: keys.length, breadth: Number(bsc.toFixed(2)) };
        scan.excluded = nonCrypto.size;

        const btcMap = S[BTC] ? new Map(S[BTC].f15.c.map(x => [x[0], x[4]])) : null;
        const watchAll = [], found = [], sfound = [];
        for (const sym of universe) {
            const s = S[sym]; if (!s) continue;
            const c = s.f15.c, i = c.length - 1;
            if (t0 - (c[i][0] + M15) > 2 * M15) { bump('bayat veri'); continue; }
            const t = tickers[sym] || {};
            const r = signalAt(s, i, { sym, mkt: mktDir, rs: isMajor(sym) ? null : rsAt(c, i, btcMap, CFG.RS_LB), costPct: costFor(t.quoteVolume) * CFG.COST_MULT, watch: true });
            bump(r.reason);
            if (r.near) watchAll.push({ symbol: sym, base: baseOf(sym), price: c[i][4], rsi: s.f15.rsi[i], adx: s.f15.adx[i], bias: r.near.side === 1 ? 'LONG' : 'SHORT', rank: r.near.dist, chg24: t.percentage != null ? t.percentage : 0,
                state: 'Pullback bölgesi (EMA21 ' + fmt(r.near.e21) + '), tetik: ' + fmt(r.near.trigger) + (r.near.side === 1 ? ' üstü' : ' altı') + ' 15m kapanış' });
            if (r.signal) { if (Date.now() - r.signal.time <= CFG.MAX_SIGNAL_AGE_MS) found.push(r.signal); else bump('eski sinyal'); }
            const rsV = isMajor(sym) ? null : rsAt(c, i, btcMap, CFG.RS_LB);
            SHADOW.forEach((v, vi) => {
                const r2 = signalAt(s, i, { sym, mkt: mktDir, rs: rsV, costPct: costFor(t.quoteVolume) * CFG.COST_MULT, cfg: Object.assign({}, CFG, v.o) });
                if (r2.signal && Date.now() - r2.signal.time <= CFG.MAX_SIGNAL_AGE_MS) { r2.signal.variant = v.name; r2.signal.vid = 'V' + vi; sfound.push(r2.signal); }
            });
        }
        radar = watchAll.sort((a, b) => a.rank - b.rank).slice(0, 25);

        found.sort((a, b) => b.score - a.score);
        let added = 0; const H = health();
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => !x.shadow && x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) continue;
            const open = signals.filter(x => isOpen(x) && !x.shadow);
            if (open.filter(x => x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR || open.length >= CFG.MAX_OPEN_TOTAL) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.setup + '_' + s.candleT;
            s.status = 'ACTIVE'; s.paper = H.paper; s.variant = 'Ana'; s.shadow = false; s.trackedTo = s.candleT + M15 - M1;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            log('SİNYAL', s.paper ? '[KAĞIT]' : '', s.dir, s.symbol, 'puan', s.score, 'piyasa', market.mood.label);
            if (!s.paper) {
                const tv = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P&interval=15';
                telegram((s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName + ' (puan ' + s.score + ')' + (H.n < H.need ? ' 🧪 doğrulanmamış' : '') +
                    '\nPiyasa: ' + market.mood.label + ' | Hedef alanı ' + s.room.toFixed(1) + 'R | Maliyet ' + s.costR.toFixed(2) + 'R\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)\nTP1 ' + fmt(s.tp1) + (s.mode === 'B' ? '' : ' | TP2 ' + fmt(s.tp2)) +
                    '\n⏱ 5 dk içinde gir; fiyat girişten 0.3R uzaklaştıysa atla.\n📈 ' + tv + (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
            }
        }

        // Gölge sinyalleri ekle
        for (const s of sfound) {
            const key = s.symbol + '|' + s.vid;
            if (signals.some(x => x.shadow && x.symbol === s.symbol && x.vid === s.vid && isOpen(x))) continue;
            if (Date.now() - (lastSig[key] || 0) < CFG.COOLDOWN_MS) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.setup + '_' + s.candleT + '_' + s.vid;
            s.status = 'ACTIVE'; s.paper = true; s.shadow = true; s.trackedTo = s.candleT + M15 - M1;
            signals.unshift(s); lastSig[key] = Date.now(); dirty = true;
        }
        { const ana = signals.filter(x => !x.shadow).slice(0, CFG.KEEP), sh = signals.filter(x => x.shadow).slice(0, CFG.KEEP * 3); signals = ana.concat(sh).sort((a, b) => b.time - a.time); }
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// Sembol bazlı toplu takip — API'yi boğmaz
async function track() {
    if (tracking) return;
    const open = signals.filter(isOpen); if (!open.length) return;
    tracking = true;
    try {
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym]; let guard = 0;
                while (guard++ < 12 && list.some(isOpen)) {
                    const since = Math.min(...list.filter(isOpen).map(x => x.trackedTo));
                    const raw = await ex.fetchOHLCV(sym, '1m', since, 500), c = closedOnly(raw, M1); let progressed = false;
                    for (const s of list) {
                        if (!isOpen(s)) continue;
                        for (const k of c) {
                            if (k[0] <= s.trackedTo) continue;
                            s.trackedTo = k[0]; progressed = true; dirty = true;
                            const before = s.status;
                            if (advance(s, k, M1)) {
                                if (!isOpen(s)) { log('KAPANDI', s.shadow ? '[' + s.variant + ']' : '', s.symbol, s.status, s.netR); if (!s.paper) telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                                if (before === 'ACTIVE' && s.status === 'TP1_HIT' && !s.paper) telegram(s.base + ' ' + s.dir + ': TP1 alındı, stop girişe çekildi.');
                            }
                        }
                    }
                    if (raw.length < 500 || !progressed) break;
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
    const now = Date.now(), closedAll = signals.filter(s => !isOpen(s) && s.netR != null), closed = closedAll.filter(s => !s.shadow), st = calcStats(closed, trDay(now));
    st.byVariant = groupBy(closedAll, s => s.variant || 'Ana');
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    return { now, mode: 'SCALP→SWING 15m v11', minScore: CFG.MIN_SCORE, market, signals: signals.filter(s => !s.shadow).slice(0, 80), shadow: signals.filter(s => s.shadow).slice(0, 80), shadowOpen: signals.filter(s => s.shadow && isOpen(s)).length, radar, stats: st, equity: eq, health: health(),
        last24: signals.filter(s => !s.shadow && now - s.time < 24 * H1).length,
        filters: { exit: CFG.EXIT_MODE, mkt: CFG.MKT_MODE, adx: CFG.MIN_ADX, room: CFG.ROOM_MIN, maxCostR: CFG.MAX_COST_R, minRisk: CFG.MIN_RISK_PCT, volMax: CFG.VOL_MAX, rsMin: CFG.RS_MIN, sw: CFG.ENABLE_SW, req4h: CFG.REQ_4H },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible, excluded: scan.excluded, suspect: scan.suspect } };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const hit = candleCache.get(sym); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const c = await ex.fetchOHLCV(sym, '15m', undefined, 200), cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), cut = Math.max(0, c.length - 120);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut) };
    candleCache.set(sym, { t: Date.now(), d }); return d;
}

// ------------------------- BACKTEST -------------------------
async function fetchHistory15(sym, days) {
    const total = days + 14, need = total * 96;
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
    let g2 = 0;
    while (all.length && all[0][0] > Date.now() - total * D1 + D1 && g2++ < 40) {
        let r = null;
        try { r = await ex.fetchOHLCV(sym, '15m', undefined, 1000, { until: all[0][0] - 1 }); } catch (e) { break; }
        const fresh = (r || []).filter(x => x[0] < all[0][0]);
        if (!fresh.length) break;
        all = fresh.concat(all); await sleep(100);
    }
    const seen = new Set();
    const c = closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
    const usable = c.length ? (last(c)[0] - c[0][0]) / D1 - 11 : 0;
    return { c, coverage: need > 0 ? c.length / need : 0, usable };
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
    const C = Object.assign({}, CFG, cfgO || {}), raw = [], funnel = {};
    for (const sym of use) {
        const S = pre[sym], c = S.f15.c, n = c.length; let busy = 0;
        const from = Math.max(startT, c[0][0] + 11 * D1);
        for (let i = 80; i < n - 1; i++) {
            const t = c[i][0]; if (t < from || t < busy) continue;
            const r = signalAt(S, i, { sym, mkt: maps.mkt.get(t) || 0, rs: isMajor(sym) ? null : rsAt(c, i, maps.btc, C.RS_LB), costPct: S.costPct, minScore: opts.minScore, cfg: C });
            if (i % 1500 === 0) await tick();
            if (!r.signal) { if (r.reason !== 'veri az') funnel[r.reason] = (funnel[r.reason] || 0) + 1; continue; }
            funnel.sinyal = (funnel.sinyal || 0) + 1;
            const s = r.signal; s.status = 'ACTIVE';
            for (let j = i + 1; j < n; j++) { if (advance(s, c[j], M15) && !isOpen(s)) break; }
            if (isOpen(s)) continue;
            raw.push({ symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, score: s.score, time: s.time, candleT: s.candleT, closedAt: s.closedAt, netR: s.netR, costR: s.costR, status: s.status, mkt: s.mkt, mfe: s.mfe });
            busy = Math.max(s.closedAt, s.time + C.COOLDOWN_MS);
        }
    }
    raw.sort((a, b) => a.time - b.time || b.score - a.score);
    const trades = [], openL = [], slot = {}; let blocked = 0;
    for (const t of raw) {
        for (let q = openL.length - 1; q >= 0; q--) if (openL[q].closedAt <= t.time) openL.splice(q, 1);
        const sk = Math.floor(t.time / M15), td = trDay(t.time);
        let dayR = 0; for (let q = trades.length - 1; q >= 0 && q > trades.length - 200; q--) { const x = trades[q]; if (x.closedAt <= t.time && trDay(x.closedAt) === td) dayR += x.netR; }
        if (openL.filter(o => o.dir === t.dir).length >= C.MAX_OPEN_PER_DIR || openL.length >= C.MAX_OPEN_TOTAL || (slot[sk] || 0) >= C.MAX_PER_SCAN || dayR <= C.DAY_STOP_R) { blocked++; continue; }
        slot[sk] = (slot[sk] || 0) + 1; openL.push(t); trades.push(t);
    }
    funnel['portföy limiti'] = blocked;
    return { trades, raw, funnel };
}
const split3 = tr => { const n = tr.length, a = Math.floor(n * 0.5), b = Math.floor(n * 0.75); return { all: grp(tr), is: grp(tr.slice(0, a)), val: grp(tr.slice(a, b)), oos: grp(tr.slice(b)) }; };

async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    opts = Object.assign({ costMult: 1, minScore: CFG.MIN_SCORE, compare: false }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => s !== BTC && s !== ETH).slice(0, coins), all = [BTC, ETH].concat(syms);
        const list = opts.compare ? VARIANTS : [VARIANTS[0]];
        btJob.total = all.length + list.length;
        const data = {}, skipped = []; let candles = 0, usableMax = 0;
        for (const s of all) {
            btJob.msg = 'Veri indiriliyor: ' + baseOf(s);
            try {
                const h = await fetchHistory15(s, days);
                if (h.usable < 4 && !isMajor(s)) skipped.push(baseOf(s) + ' (' + Math.max(0, Math.round(h.usable)) + ' gün)');
                else if (!isMajor(s) && flatRatio(h.c) >= CFG.FLAT_MAX) skipped.push(baseOf(s) + ' (düz mum)');
                else { data[s] = h.c; usableMax = Math.max(usableMax, h.usable); candles += h.c.length; }
            } catch (e) { skipped.push(baseOf(s) + ' (hata)'); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 1500) throw new Error('BTC 15m verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];
        btJob.msg = 'Trend ve piyasa yönü hesaplanıyor'; await tick();
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult);
        const effDays = Math.max(1, Math.min(days, Math.round(usableMax))), startT = Date.now() - days * D1, use = Object.keys(data), compare = []; let base = null;
        for (const v of list) {
            btJob.msg = 'Test ediliyor: ' + v.name;
            const r = await simulate(pre, use, maps, v.o, opts, startT), sp = split3(r.trades);
            compare.push({ name: v.name, n: sp.all.n, perDay: sp.all.n / effDays, win: sp.all.win, avgR: sp.all.avgR, gross: sp.all.avgGross, cost: sp.all.avgCost, totalR: sp.all.totalR, pf: sp.all.pf, dd: sp.all.dd, t: sp.all.t, isR: sp.is.avgR, valR: sp.val.avgR, oosR: sp.oos.avgR, oosN: sp.oos.n });
            if (!base) base = { r, sp };
            btJob.done++;
        }
        const trades = base.r.trades, sp = base.sp, byScore = trades.slice().sort((a, b) => a.score - b.score), mid = Math.floor(byScore.length / 2);
        btJob.result = { days: effDays, reqDays: days, coins, candles, skipped, funnel: base.r.funnel, costMult: opts.costMult, minScore: opts.minScore, rawN: base.r.raw.length,
            perDay: sp.all.n / effDays, all: sp.all, is: sp.is, val: sp.val, oos: sp.oos, compare: opts.compare ? compare : null,
            scoreCheck: { lo: grp(byScore.slice(0, mid)), hi: grp(byScore.slice(mid)) },
            bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName), byDir: groupBy(trades, s => s.dir), byBand: groupBy(trades, band),
            bySession: groupBy(trades, sessOf), byMkt: groupBy(trades, mktName), byExit: groupBy(trades, s => s.status),
            byWeek: groupBy(trades, s => 'Hafta ' + String(Math.floor((s.time - startT) / (7 * D1)) + 1).padStart(2, '0')), byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ------------------------- ARAYÜZ (gömülü) -------------------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v11</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
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
.side{width:390px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}
.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.r1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}
.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:21px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
.box.ok{border-color:rgba(61,220,151,.6)}.box.no{border-color:rgba(255,107,122,.6)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
table{width:100%;border-collapse:collapse}
th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:360px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--am)}
.pr{display:grid;grid-template-columns:120px 1fr 30px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:auto}
.frm input{width:100px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.note{font-size:11px;color:var(--dm);margin-top:8px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}.grid2{grid-template-columns:1fr}canvas{height:260px}}
</style>
</head>
<body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v11</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div>
  <span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<script>
const TABS=[['sig','Sinyaller'],['radar','Radar'],['gol','Gölge'],['stat','İstatistik'],['bt','Test']];
const allSigs=()=>S.signals.concat(S.shadow||[]);
let S=null,tab='sig',sel=null,bt=null,chartCache={},chartFor='',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}');
const $=id=>document.getElementById(id);
const fp=p=>{if(p==null)return'-';p=Number(p);const a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)};
const f2=(x,d=2)=>x==null||isNaN(x)?'-':Number(x).toFixed(d);
const sg=(x,d=2)=>{x=Number(x);return(x>0?'+':'')+x.toFixed(d)};
const cl=x=>x>0?'up':x<0?'dn':'fl';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ts=>{const m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'};
const openS=s=>s.status==='ACTIVE'||s.status==='TP1_HIT';
const tvUrl=sym=>'https://www.tradingview.com/chart/?symbol=BITGET:'+sym.split('/')[0]+'USDT.P&interval=15';
const pnlR=s=>s&&s.lastPrice?(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop):null;
const ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1 ✓','g'],TP2:['TP2 ✓','g'],TP:['Hedef ✓','g'],TRAIL:['Trailing','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre','w']};
const key=()=>localStorage.getItem('st_key')||'';
async function post(url,b){const r=await fetch(url+'?key='+encodeURIComponent(key()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
 if(r.status===401){const k=prompt('Yönetici anahtarı (ADMIN_KEY):');if(k){localStorage.setItem('st_key',k);return post(url,b)}}return r}

function renderTop(){
 const md=S.market&&S.market.mood;
 $('cMkt').innerHTML=md?'<b>Piyasa</b> <span class="'+(md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl')+'"><b style="color:inherit">'+md.label+'</b></span> <span class="fl">'+md.up+'↑/'+md.down+'↓</span>':'<b>Piyasa</b> ...';
 [['cBTC','BTC','btc'],['cETH','ETH','eth']].forEach(a=>{const m=S.market[a[2]];$(a[0]).innerHTML=m?'<b>'+a[1]+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg)+'%</span> <span class="'+(m.dir===1?'up':m.dir===-1?'dn':'fl')+'">15m '+(m.dir===1?'▲':m.dir===-1?'▼':'▬')+'</span>':'<b>'+a[1]+'</b> -'});
 const h=S.health;
 $('cHealth').innerHTML='<b>Sağlık</b> '+(h.n<h.need?'<span class="am">doğrulanıyor '+h.n+'/'+h.need+'</span>':'<span class="'+cl(h.avgR)+'">son '+h.need+': '+sg(h.avgR)+'R</span>')+(h.paper?' <span class="tag r">KAĞIT MODU</span>':'');
 $('modeB').textContent=S.mode}

function renderTabs(){const oc=S.signals.filter(openS).length;
 $('tabs').innerHTML=TABS.map(t=>'<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?' ('+oc+')':'')+'</button>').join('');
 [...$('tabs').children].forEach(b=>b.onclick=()=>{tab=b.dataset.t;if(tab==='sig'||tab==='radar'||tab==='gol')sel=null;renderAll()})}

function sigCard(s){
 const st=ST[s.status]||['?',''],R=pnlR(s);let pn='';
 if(openS(s)&&R!=null)pn='<span class="sc '+cl(R)+'">'+sg(R)+'R</span>';else if(s.netR!=null)pn='<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>';
 return '<div class="card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed')+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+(s.shadow?'<span class="tag w">'+esc(s.variant)+'</span>':(s.paper?'<span class="tag r">KAĞIT</span>':''))+'<span class="tag">P'+s.score+'</span>'+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop '+fp(s.stop)+'</span><span>Risk '+f2(s.riskPct)+'%</span><span>Maliyet '+f2(s.costR)+'R</span><span>'+ago(s.time)+' önce</span></div></div>'}
function radarCard(r){return '<div class="card'+(sel&&sel.sym===r.symbol?' sel':'')+'" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="sc '+cl(r.chg24)+'" style="font-size:12px">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>RSI '+f2(r.rsi,0)+'</span><span>ADX '+f2(r.adx,0)+'</span><span>'+esc(r.state)+'</span></div></div>'}
function renderList(){let h='';
 if(tab==='sig'){const a=S.signals.filter(openS),c=S.signals.filter(s=>!openS(s)).slice(0,25);
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Açık sinyal yok. Kaliteli kurulum azdır; bu normal.</div>';
  if(c.length)h+='<h3>Kapanan</h3>'+c.map(sigCard).join('')}
 else if(tab==='radar')h=S.radar.length?S.radar.map(radarCard).join(''):'<div class="note" style="padding:10px">Yaklaşan kurulum yok.</div>';
 else if(tab==='gol'){const g=S.shadow||[];h='<div class="note" style="padding:8px">Gölge varyantlar aynı taramada kağıt üstünde izlenir; gerçek işlem değildir. Sonuçlar İstatistik > Varyant tablosunda.</div>'+(g.length?g.map(sigCard).join(''):'<div class="note" style="padding:10px">Gölge sinyal yok.</div>')}
 else h='<div class="note" style="padding:10px">Ayrıntılar sağ panelde.</div>';
 $('list').innerHTML=h;
 [...$('list').querySelectorAll('.card')].forEach(e=>e.onclick=()=>{const id=e.dataset.id,sy=e.dataset.sym;
  if(id){const s=allSigs().find(x=>x.id===id);sel={id,sym:s.symbol}}else sel={sym:sy};chartFor='';renderList();renderMain()})}

function calc(e,s){const bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;const q=ru/d;return{ru,q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk % (maks 2)<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){const upd=()=>{cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));const c=calc(+$('cE').value,+$('cS').value);
  $('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> &nbsp; Miktar <b>'+f2(c.q,4)+'</b> &nbsp; Pozisyon <b>'+f2(c.n,1)+' USDT</b> &nbsp; Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değerleri gir.'};
 ['cBal','cRisk','cE','cS'].forEach(i=>{const e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

function partsView(s){const lab={trend:'Trend gücü (ADX)',rs:'BTC\'ye göre güç',htf:'1H+4H uyum',pullback:'Pullback kalitesi',oda:'Hedef önü alan',maliyet:'Maliyet verimi'},mx={trend:25,rs:20,htf:15,pullback:15,oda:15,maliyet:10},p=s.parts||{};
 return Object.keys(lab).map(k=>'<div class="pr"><span>'+lab[k]+'</span><div class="bar"><i style="width:'+Math.min(100,(p[k]||0)/mx[k]*100)+'%"></i></div><b>'+(p[k]||0)+'</b></div>').join('')}
function sigView(s){const st=ST[s.status]||['?',''],R=pnlR(s),w=(s.warnings||[]).map(x=>'<span class="tag w">'+esc(x)+'</span> ').join('');
 return '<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span>'+(s.shadow?'<span class="tag w">'+esc(s.variant)+'</span>':'')+(s.paper?'<span class="tag r">KAĞIT</span>':'')+'<span class="sc" style="font-size:24px">'+s.score+'</span></div>'+
 '<div class="fl" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce'+(s.netR!=null&&!openS(s)?' • Sonuç '+sg(s.netR)+'R (brüt '+sg(s.grossR)+')':'')+'</div>'+w+'<canvas id="cv"></canvas>'+
 '<div class="lv"><div><span>Anlık</span><b>'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z</span><b class="'+cl(R)+'">'+(R!=null?sg(R)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1 ('+s.tp1R+'R)</span><b class="up">'+fp(s.tp1)+'</b></div>'+(s.mode==='B'?'':'<div><span>TP2</span><b class="up">'+fp(s.tp2)+'</b></div>')+'<div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(s.costR)+'R</b></div><div><span>Hedef alanı</span><b>'+f2(s.room,1)+'R</b></div><div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+' / '+f2(s.mae,1)+'</b></div></div>'+
 '<div class="frm"><a class="btn tv" href="'+tvUrl(s.symbol)+'" target="_blank">📈 TradingView</a></div><div class="grid2"><div class="box"><h3 style="margin-top:0">Puan dağılımı</h3>'+partsView(s)+'<div class="note">Puan sadece sıralama içindir. Backtest\'teki "puan monotonluk" testi geçmedikçe ona güvenme.</div><div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div></div><div>'+calcBox(s.entry,s.initialStop)+'</div></div>'}

const reasonTxt=o=>Object.entries(o||{}).sort((a,b)=>b[1]-a[1]).slice(0,10).map(x=>x[0]+' '+x[1]).join(', ')||'-';
function homeView(){const F=S.filters,open=S.signals.filter(openS).length,td=S.stats.today,h=S.health;
 return '<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Açık sinyal</div><div class="v">'+open+'</div></div><div class="tile"><div class="k">Son 24s sinyal</div><div class="v">'+S.last24+'</div></div><div class="tile"><div class="k">Bugün bot R</div><div class="v '+cl(h.dayR)+'">'+sg(h.dayR,1)+'</div><div class="k">'+td.n+' kapanan</div></div><div class="tile"><div class="k">Gölge (ileri test)</div><div class="v">'+(S.shadowOpen||0)+'</div><div class="k">açık</div></div><div class="tile"><div class="k">Taranan coin</div><div class="v">'+S.scan.universe+'</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Strateji v11 — 15m Trend Pullback</h3><div class="note" style="color:var(--tx)">15m + 1H trend yönünde (4H ters olmasın), fiyat EMA21\'e çekilir, pullback hacmi kurur, yönde tetik mumu kapanır. Klimaks hacim (>'+F.volMax+'x) reddedilir, BTC\'ye göre güç ≥ '+F.rsMin+'%. Stop yapısal, en az %'+F.minRisk+'; maliyet ≤ '+F.maxCostR+'R; hedef önü ≥ '+F.room+'R.</div><div class="note">Çıkış modu '+F.exit+' • piyasa filtresi '+F.mkt+' • ADX ≥ '+F.adx+' • Sweep '+(F.sw?'açık':'kapalı')+' • 4H '+(F.req4h?'zorunlu':'ters olmasın')+'</div>'+
 '<div class="note" style="color:var(--tx)">Ana strateji bilerek seçicidir: geçmiş testte 60 coinde günde ~0.3 sinyal. Sinyal yokken bekle, filtre gevşetme. Aynı anda gölge varyantlar kağıt üstünde çalışıp ileri test verisi biriktirir.</div><div class="note">Sağlık kapısı: son '+h.need+' kapanan işlemin net ortalaması negatifse yeni sinyaller KAĞIT modunda üretilir (izlenir, Telegram gitmez). Günlük -3R olursa da aynı.</div></div>'+
 '<div class="box"><h3 style="margin-top:0">Son tarama</h3><div class="note" style="color:var(--tx)">'+(S.scan.last?ago(S.scan.last)+' önce, '+f2(S.scan.ms/1000,1)+' sn':'-')+' • '+S.scan.eligible+' uygun / '+S.scan.total+' vadeli</div><div class="note">Elenme nedenleri (bugün): '+reasonTxt(S.scan.reasons)+'</div></div>'}

const tbl=(t,title)=>'<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(k=>{const x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.avgGross)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>';
function statView(){const a=S.stats.all;
 return '<h2>Canlı bot sonuçları</h2><div class="tiles"><div class="tile"><div class="k">Kapanan</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div><div class="k">±'+f2(a.ci)+'</div></div><div class="tile"><div class="k">Brüt ort R</div><div class="v">'+sg(a.avgGross)+'</div></div><div class="tile"><div class="k">Maliyet ort R</div><div class="v dn">'+f2(a.avgCost)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(a.dd,1)+'R</div></div></div><canvas id="eq" style="height:150px"></canvas><div class="note">Anlamlı olması için 200+ kapanan işlem gerekir. Eski sürüm sinyallerini silmek için POST /api/reset.</div>'+
 tbl(S.stats.bySetup,'Kurulum')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byMkt,'Piyasa')+tbl(S.stats.byExit,'Çıkış')+tbl(S.stats.byBand,'Puan bandı')+tbl(S.stats.bySession,'Seans')+tbl(S.stats.byVariant||{},'Varyant — canlı ileri test (ana + gölge, aynı anda)')}
function drawEq(){const c=$('eq');if(!c||!S.equity.length)return;const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;const x=c.getContext('2d');x.scale(dp,dp);const v=S.equity,mn=Math.min(0,...v),mx=Math.max(.1,...v),Y=a=>H-10-(a-mn)/(mx-mn)*(H-20);
 x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach((a,i)=>{const px=i/Math.max(1,v.length-1)*(W-8)+4;i?x.lineTo(px,Y(a)):x.moveTo(px,Y(a))});x.stroke()}

const _bs=JSON.parse(localStorage.getItem('st_bt')||'{"d":30,"c":20,"m":1,"s":0,"x":0}');
const opt=(v,cur,t)=>'<option value="'+v+'"'+(+cur===v?' selected':'')+'>'+t+'</option>';
function verdict(R){const r=[];
 if(R.all.n<150)r.push('örnek küçük ('+R.all.n+' işlem, en az 150 gerek)');
 [['IS',R.is],['VAL',R.val],['OOS',R.oos]].forEach(p=>{if(p[1].n<10)r.push(p[0]+' diliminde çok az işlem ('+p[1].n+')');else if(!(p[1].avgR>0))r.push(p[0]+' dilimi negatif ('+sg(p[1].avgR)+'R)')});
 if(R.all.t<2)r.push('t-stat '+f2(R.all.t,1)+' < 2');
 const sc=R.scoreCheck;if(sc.hi.n>=20&&!(sc.hi.avgR>sc.lo.avgR))r.push('puan monoton değil (yüksek puan ≤ düşük puan)');
 return r}
function btView(){let h='<h2>Geçmiş veri testi (15m)</h2><div class="box"><div class="frm"><select id="bD">'+opt(14,_bs.d,'14 gün')+opt(30,_bs.d,'30 gün')+opt(60,_bs.d,'60 gün')+opt(90,_bs.d,'90 gün')+'</select><select id="bC">'+opt(10,_bs.c,'10 coin')+opt(20,_bs.c,'20 coin')+opt(40,_bs.c,'40 coin')+opt(60,_bs.c,'60 coin')+opt(100,_bs.c,'100 coin')+opt(150,_bs.c,'150 coin')+'</select><select id="bM">'+opt(1,_bs.m,'Maliyet x1')+opt(1.5,_bs.m,'Maliyet x1.5')+opt(2,_bs.m,'Maliyet x2 (stres)')+'</select><select id="bS">'+opt(0,_bs.s,'Puan kapısı yok')+opt(30,_bs.s,'Min puan 30')+opt(50,_bs.s,'Min puan 50')+opt(60,_bs.s,'Min puan 60')+opt(70,_bs.s,'Min puan 70')+'</select><select id="bX">'+opt(0,_bs.x,'Tek test')+opt(1,_bs.x,'Varyant karşılaştırma (15 test)')+'</select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">Canlıyla aynı sinyal kodu. 15m mumda stop ve hedef aynı mumdaysa stop önce sayılır (kötümser). Gerçek karar için 60-90 gün ve 200+ işlem şart. Geçmiş, bugünün hacim listesiyle test edilir (survivorship). Varyantlar çoklu testtir: en iyisini seçmek için t ≥ 3 ara.</div></div>';
 if(!bt)return h;
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box no dn">'+esc(bt.error)+'</div>';
 if(bt.result){const R=bt.result,v=verdict(R);
  h+='<div class="box '+(v.length?'no':'ok')+'"><b class="'+(v.length?'dn':'up')+'">'+(v.length?'HENÜZ KANIT YOK':'ADAY')+'</b><div class="note" style="color:var(--tx)">'+(v.length?v.map(esc).join(' • '):'İşlem sayısı, üç dilim, t-stat ve puan testi geçti. Yine de kağıt üstünde canlı izle.')+'</div></div>';
  h+='<div class="tiles"><div class="tile"><div class="k">İşlem</div><div class="v">'+R.all.n+'</div><div class="k">'+f2(R.perDay,1)+'/gün</div></div><div class="tile"><div class="k">Kazanç</div><div class="v">'+f2(R.all.win*100,0)+'%</div></div><div class="tile"><div class="k">Net ort R</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR)+'</div><div class="k">±'+f2(R.all.ci)+'</div></div><div class="tile"><div class="k">Brüt ort R</div><div class="v">'+sg(R.all.avgGross)+'</div></div><div class="tile"><div class="k">Maliyet ort R</div><div class="v dn">'+f2(R.all.avgCost)+'</div></div><div class="tile"><div class="k">t-stat</div><div class="v '+(Math.abs(R.all.t)>=2?cl(R.all.t):'fl')+'">'+f2(R.all.t,2)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(R.all.pf)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(R.all.dd,1)+'R</div></div></div>';
  h+='<h3>Walk-forward</h3><table><tr><th>Dilim</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Toplam R</th><th class="n">PF</th></tr>'+[['IS (ilk %50)',R.is],['VAL (%25)',R.val],['OOS (son %25)',R.oos]].map(p=>{const x=p[1];return '<tr><td>'+p[0]+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.avgGross)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td></tr>'}).join('')+'</table>';
  h+='<div class="note">Puan testi: üst yarı '+sg(R.scoreCheck.hi.avgR)+'R ('+R.scoreCheck.hi.n+') • alt yarı '+sg(R.scoreCheck.lo.avgR)+'R ('+R.scoreCheck.lo.n+'). Üst yarı belirgin iyi değilse puan gürültüdür.</div><div class="note">'+R.days+' gün / '+R.coins+' coin / '+R.candles+' mum • maliyet x'+R.costMult+' • min puan '+R.minScore+' • portföy öncesi '+R.rawN+' • atlanan: '+(R.skipped.length?esc(R.skipped.join(', ')):'yok')+'</div><div class="note">Filtre hunisi: '+reasonTxt(R.funnel)+'</div>';
  if(R.compare)h+='<h3>Varyantlar (aynı veri, tek değişiklik)</h3><table><tr><th>Varyant</th><th class="n">İşlem</th><th class="n">Net R</th><th class="n">Brüt R</th><th class="n">Maliyet</th><th class="n">PF</th><th class="n">t</th><th class="n">IS</th><th class="n">VAL</th><th class="n">OOS</th></tr>'+R.compare.map(x=>'<tr><td>'+esc(x.name)+'</td><td class="n">'+x.n+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n">'+sg(x.gross)+'</td><td class="n">'+f2(x.cost)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t,1)+'</td><td class="n '+cl(x.isR)+'">'+sg(x.isR)+'</td><td class="n '+cl(x.valR)+'">'+sg(x.valR)+'</td><td class="n '+cl(x.oosR)+'">'+sg(x.oosR)+' ('+x.oosN+')</td></tr>').join('')+'</table>';
  h+=tbl(R.bySetup,'Kurulum')+tbl(R.byExit,'Çıkış')+tbl(R.byBand,'Puan bandı')+tbl(R.byDir,'Yön')+tbl(R.byMkt,'Piyasa')+tbl(R.bySession,'Seans')+tbl(R.byWeek,'Hafta (tutarlılık)')+tbl(R.byCoin,'Coin (küçük örnek anlamsız)')}
 return h}
function bindBt(){[['bD','d'],['bC','c'],['bM','m'],['bS','s'],['bX','x']].forEach(a=>{const e=$(a[0]);if(e)e.onchange=()=>{_bs[a[1]]=+e.value;localStorage.setItem('st_bt',JSON.stringify(_bs))}});
 const b=$('bGo');if(b)b.onclick=async()=>{const r=await post('/api/backtest',{days:+$('bD').value,coins:+$('bC').value,costMult:+$('bM').value,minScore:+$('bS').value,compare:+$('bX').value===1});if(r.ok)pollBt()}}
function pollBt(){fetch('/api/backtest').then(r=>r.json()).then(d=>{bt=d;const t=document.activeElement&&document.activeElement.tagName;if(tab==='bt'&&t!=='SELECT'&&t!=='INPUT')renderMain();if(d.running)setTimeout(pollBt,3000)})}

function drawChart(d,s){const c=$('cv');if(!c||!d||!d.c.length)return;const W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;const x=c.getContext('2d');x.scale(dp,dp);
 const L=8,R=86,T=12,B=20,n=d.c.length,PW=W-L-R,PH=H-T-B;let hi=-1e99,lo=1e99;d.c.forEach(k=>{hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 const lv=s?[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.initialStop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']].filter(a=>s.mode==='B'?a[2]!=='TP2':true):[];
 lv.forEach(a=>{hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])});const pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 const Y=p=>T+(hi-p)/(hi-lo)*PH,X=k=>L+(k+.5)/n*PW,cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';for(let i=0;i<=4;i++){const gy=T+PH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 if(s){x.fillStyle='rgba(255,107,122,.12)';x.fillRect(L,Math.min(Y(s.initialStop),Y(s.entry)),PW,Math.abs(Y(s.entry)-Y(s.initialStop)));x.fillStyle='rgba(61,220,151,.12)';x.fillRect(L,Math.min(Y(s.entry),Y(s.tp1)),PW,Math.abs(Y(s.tp1)-Y(s.entry)))}
 const line=(arr,col,w)=>{x.strokeStyle=col;x.lineWidth=w;x.beginPath();let st=false;arr.forEach((v,k)=>{if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 d.c.forEach((k,i)=>{const col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 lv.forEach(a=>{x.strokeStyle=x.fillStyle=a[1];x.lineWidth=a[2]==='GİRİŞ'?2:1.3;x.setLineDash(a[2]==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.font='bold 10px system-ui';x.fillText(a[2]+' '+fp(a[0]),W-R+6,Y(a[0])-3)});
 const lp=s&&s.lastPrice?s.lastPrice:d.c[n-1][4];x.strokeStyle='#fff';x.lineWidth=1.5;x.beginPath();x.moveTo(L,Y(lp));x.lineTo(W-R,Y(lp));x.stroke();x.fillStyle='#fff';x.fillRect(W-R-2,Y(lp)-9,66,18);x.fillStyle='#0c1117';x.font='bold 11px system-ui';x.fillText(fp(lp),W-R+2,Y(lp)+4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText('15m • sarı EMA21 • gri EMA50',L+4,H-5)}
function loadChart(sym){fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(r=>r.json()).then(d=>{chartCache[sym]=d;if(sel&&sel.sym===sym&&$('cv'))drawChart(d,sel.id?allSigs().find(x=>x.id===sel.id):null)}).catch(()=>{})}

function renderMain(){const M=$('main');
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){const s=allSigs().find(x=>x.id===sel.id);if(s){M.innerHTML=sigView(s);bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol)}return}}
 if(sel&&sel.sym){const r=S.radar.find(x=>x.symbol===sel.sym);M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="'+tvUrl(sel.sym)+'" target="_blank">📈 TradingView</a></div><canvas id="cv"></canvas>'+calcBox('','');bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym)}return}
 M.innerHTML=homeView()}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch('/api/state').then(r=>r.json()).then(d=>{S=d;$('dot').className='dot on';$('conn').textContent='Bağlı';const t=document.activeElement&&document.activeElement.tagName;if(t==='INPUT'||t==='SELECT'){renderTop();renderTabs();renderList()}else renderAll()}).catch(()=>{$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',()=>{if(S)renderMain()});
setInterval(poll,5000);setInterval(()=>{if(sel&&sel.sym)loadChart(sel.sym)},20000);poll();pollBt();
</script>
</body>
</html>
`;

// ------------------------- HTTP -------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML);
        }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/export') return json(res, 200, { signals, lastSig });
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [14, 30, 60, 90].includes(b.days) ? b.days : 30, coins = [10, 20, 40, 60, 100, 150].includes(b.coins) ? b.coins : 20;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1, minScore = [0, 30, 50, 60, 70].includes(b.minScore) ? b.minScore : CFG.MIN_SCORE;
            if (!btJob.running) runBacktest(days, coins, { costMult, minScore, compare: b.compare === true });
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
        log('evren:', universe.length, 'coin | elenen şüpheli:', scan.suspect);
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(track, CFG.TRACK_MS); setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3); setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; runScan(); } }, 3000);
        log('SONER TRADE v11 + Gölge hazır | çıkış ' + CFG.EXIT_MODE + ' | puan ' + CFG.MIN_SCORE + '+ | ADX ' + CFG.MIN_ADX + '+ | gölge varyant: ' + SHADOW.length);
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, _sigs: () => signals, signalAt, advance, buildSym, prepare, simulate, grp, aggregateN, CFG, VARIANTS };
