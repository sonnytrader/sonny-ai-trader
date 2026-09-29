'use strict';
// ============================================================
// SONER TRADE v11 — 15m TREND PULLBACK (maliyet-bilinçli, canlı/backtest aynı kod)
// v10 backtest teşhisi: brüt beklenti ~0R, işlem başı maliyet ~0.22R => net negatif.
// v11 değişiklikleri:
//  1) Sinyal 15m kapanışında, trend 1H (+4H). Stop >= %0.6 => maliyet/R düşer. MAX_COST_R 0.18
//  2) Evren: sadece likit coinler (min 20M USDT hacim, top 60)
//  3) Klimaks hacim tavanı (VOL_MAX), pullback hacim kuruması, BTC'ye göre göreli güç (RS)
//  4) Puan artık sadece sıralama: ağırlıklar öncül mantıkla, 48 işlemlik veriye uydurulmadı.
//     Backtest "puan monotonluk" testi yapar; monoton değilse puan anlamsızdır.
//  5) Canlı sağlık kapısı: son 30 kapanan işlem ortalaması < 0 ise yeni sinyaller KAĞIT modunda (Telegram yok)
//  6) Backtest: brüt/net/maliyet ayrımı, 15m veri (90 güne kadar), varyant karşılaştırma, hüküm kutusu
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
    MIN_SCORE: num('MIN_SCORE', 50),
    ENABLE_PB: flag('ENABLE_PB', true), ENABLE_SW: flag('ENABLE_SW', false),
    REQ_4H: flag('REQ_4H', false),                 // true: 4H trend işlemle aynı yönde şart
    MKT_MODE: process.env.MKT_MODE || 'notAgainst', // align | notAgainst | off
    MIN_ADX: num('MIN_ADX', 20),
    RS_LB: 24, RS_MIN: num('RS_MIN', 0),           // 6 saatlik getiri farkı (coin - BTC), % ; yön ile çarpılır
    // Pullback
    PB_WIN: 6, PB_TOUCH_ATR: 0.10, PB_MAX_DEPTH_ATR: 0.5, PB_DRY: num('PB_DRY', 1.1),
    PB_MIN_VOLX: num('PB_MIN_VOLX', 1.0), VOL_MAX: num('VOL_MAX', 2.8),
    MIN_BODY: 0.5, MIN_CLOSEPOS: 0.65, RSI_L: [42, 65], RSI_S: [35, 58], MAX_EXT_ATR: 1.0,
    // Sweep (varsayılan kapalı; backtest kanıtlarsa aç)
    SW_LOOK: 32, SW_DEPTH_ATR: 0.10, SW_WICK: 0.45, SW_MIN_VOLX: 1.5,
    // Risk / maliyet / hedef
    STOP_BUF_ATR: num('STOP_BUF_ATR', 0.30), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.6), MAX_RISK_PCT: 2.5,
    COST_PCT: 0.14, COST_MULT: num('COST_MULT', 1), MAX_COST_R: num('MAX_COST_R', 0.18),
    ROOM_MIN: num('ROOM_MIN', 1.2), ROOM_LOOK: 96,
    EXIT_MODE: process.env.EXIT_MODE || 'A',       // A: %50 TP1 + BE + TP2 | B: tek hedef | C: TP1 sonrası trailing
    TP1_R: num('TP1_R', 1.0), TP2_R: num('TP2_R', 2.0), TPB_R: 1.5, TRAIL_ATR: 2, CAP_R: 4,
    TIME_STOP_MS: 6 * M15, TIME_STOP_MFE: 0.3, MAX_HOLD_MS: 8 * H1,
    // Portföy
    COOLDOWN_MS: 2 * H1, MAX_OPEN_PER_DIR: 2, MAX_OPEN_TOTAL: 4, MAX_PER_SCAN: 2, DAY_STOP_R: -3,
    MAX_SIGNAL_AGE_MS: 5 * 60e3, SCAN_DELAY_MS: 8000,
    // Evren
    UNIVERSE: num('UNIVERSE', 60), MIN_VOL_USDT: num('MIN_VOL', 20e6), FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: 6, TRACK_MS: 15e3, UNIVERSE_MS: 5 * 60e3, KEEP: 1000,
    HEALTH_N: 30, HEALTH_MIN_R: 0
};

// Ablation: aynı veri, aynı portföy kuralları, TEK değişiklik. Çok varyant = çoklu test; en iyisini seçmek için t >= 3 ara.
const VARIANTS = [
    { name: 'Temel v11', o: {} },
    { name: 'Sweep de açık', o: { ENABLE_SW: true } },
    { name: 'Piyasa uyumu şart (align)', o: { MKT_MODE: 'align' } },
    { name: 'Piyasa filtresi yok', o: { MKT_MODE: 'off' } },
    { name: 'RS filtresi yok', o: { RS_MIN: -99 } },
    { name: '4H uyumu şart', o: { REQ_4H: true } },
    { name: 'Hacim tavanı yok', o: { VOL_MAX: 99 } },
    { name: 'Pullback hacim kuruması yok', o: { PB_DRY: 99 } },
    { name: 'ADX 25+', o: { MIN_ADX: 25 } },
    { name: 'Çıkış B: tek hedef 1.5R', o: { EXIT_MODE: 'B' } },
    { name: 'Çıkış C: trailing', o: { EXIT_MODE: 'C' } },
    { name: 'Maliyet gevşek (v10 benzeri)', o: { MAX_COST_R: 0.30, MIN_RISK_PCT: 0.25 } }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const trHour = t => String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00';
const session = t => { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya (03-10 TR)' : h < 13 ? '2 Londra (10-16 TR)' : h < 21 ? '3 ABD (16-00 TR)' : '4 Gece (00-03 TR)'; };
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.40; };   // gidiş-dönüş % (komisyon + slippage tahmini)
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

// ------------------------- İNDİKATÖR DİZİLERİ (nedensel: değer[i] sadece <= i verisini kullanır) -------------------------
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
function volSma(c, p = 20) {   // c[i-p..i-1] ortalaması (mevcut mum hariç)
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
function ptrMap(c, cH, dur) {   // her 15m mum için o an KAPANMIŞ son üst-zaman mumunun indeksi
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

// ------------------------- STRATEJİ (canlı ve backtest AYNI fonksiyon) -------------------------
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
        let room = side * (tgt - entry) / risk; if (room <= 0) room = 9;   // 24s tepe/dip aşıldı: önde engel yok
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
        if (!(t15 === side && h1 === side && (C.REQ_4H ? h4 === side : h4 !== -side))) return { fail: 'trend yok', stage: 1 };
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

    let near = null;   // radar: trend uyumlu ve EMA21'e yakın
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

// ------------------------- İŞLEM TAKİBİ (canlı 1m, backtest 15m) -------------------------
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';
function closeSig(s, status, gross, t) { s.status = status; s.grossR = Number(gross.toFixed(3)); s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', sg = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop), rA = p => sg * (p - s.entry) / risk;
    s.mfe = Math.max(s.mfe || 0, rA(L ? k[2] : k[3])); s.mae = Math.min(s.mae || 0, rA(L ? k[3] : k[2]));
    s.lastPrice = k[4];
    const end = k[0] + dur, el = k[0] - s.time, hitStop = L ? k[3] <= s.stop : k[2] >= s.stop, T1 = s.tp1R, T2 = s.tp2R;
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, end); return true; }              // aynı mumda stop+hedef: stop önce (kötümser)
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
    const cl = signals.filter(s => !isOpen(s) && s.netR != null).sort((a, b) => b.closedAt - a.closedAt).slice(0, CFG.HEALTH_N);
    const g = grp(cl), today = trDay(Date.now());
    const dayR = signals.filter(s => !isOpen(s) && s.netR != null && trDay(s.closedAt) === today).reduce((a, s) => a + s.netR, 0);
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
    catch (e) { log('temiz başlangıç (state.json yok). Render için kalıcı disk bağlayıp DATA_DIR verin.'); }
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
    const lastH1 = Math.floor(now / H1) * H1 - H1, lastH4 = Math.floor(now / (4 * H1)) * (4 * H1) - 4 * H1;   // beklenen son kapanmış mum başlangıcı
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
        const watchAll = [], found = [];
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
        }
        radar = watchAll.sort((a, b) => a.rank - b.rank).slice(0, 25);

        found.sort((a, b) => b.score - a.score);
        let added = 0; const H = health();
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) continue;
            const open = signals.filter(isOpen);
            if (open.filter(x => x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR || open.length >= CFG.MAX_OPEN_TOTAL) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.setup + '_' + s.candleT;
            s.status = 'ACTIVE'; s.paper = H.paper; s.trackedTo = s.candleT + M15 - M1;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            log('SİNYAL', s.paper ? '[KAĞIT]' : '', s.dir, s.symbol, 'puan', s.score, 'piyasa', market.mood.label);
            if (!s.paper) {
                const tv = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P&interval=15';
                telegram((s.dir === 'LONG' ? '🟢 ' : '🔴 ') + s.dir + ' ' + s.base + ' — ' + s.setupName + ' (puan ' + s.score + ')' + (H.n < H.need ? ' 🧪 doğrulanmamış' : '') +
                    '\nPiyasa: ' + market.mood.label + ' | Hedef alanı ' + s.room.toFixed(1) + 'R | Maliyet ' + s.costR.toFixed(2) + 'R\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)\nTP1 ' + fmt(s.tp1) + (s.mode === 'B' ? '' : ' | TP2 ' + fmt(s.tp2)) +
                    '\n⏱ 5 dk içinde gir; fiyat girişten 0.3R uzaklaştıysa atla.\n📈 ' + tv + (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
            }
        }
        if (signals.length > CFG.KEEP) signals = signals.slice(0, CFG.KEEP);
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

async function track() {
    if (tracking) return;
    const open = signals.filter(isOpen); if (!open.length) return;
    tracking = true;
    try {
        for (const s of open) {
            try {
                let guard = 0;
                while (guard++ < 12 && isOpen(s)) {
                    const raw = await ex.fetchOHLCV(s.symbol, '1m', s.trackedTo, 500), c = closedOnly(raw, M1);
                    let progressed = false;
                    for (const k of c) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; progressed = true; dirty = true;
                        const before = s.status;
                        if (advance(s, k, M1)) {
                            if (!isOpen(s)) { log('KAPANDI', s.symbol, s.status, s.netR); if (!s.paper) telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                            if (before === 'ACTIVE' && s.status === 'TP1_HIT' && !s.paper) telegram(s.base + ' ' + s.dir + ': TP1 alındı, stop girişe çekildi.');
                        }
                    }
                    if (raw.length < 500 || !progressed) break;
                }
                const t = tickers[s.symbol]; if (t && t.last && isOpen(s)) s.lastPrice = t.last;
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
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null), st = calcStats(closed, trDay(now));
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    return { now, mode: 'SCALP→SWING 15m v11', minScore: CFG.MIN_SCORE, market, signals: signals.slice(0, 80), radar, stats: st, equity: eq, health: health(),
        last24: signals.filter(s => now - s.time < 24 * H1).length,
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

// ------------------------- BACKTEST (15m; 1H/4H bu veriden toplanır) -------------------------
async function fetchHistory15(sym, days) {
    const total = days + 14, need = total * 96;   // +14 gün: 4H EMA50 ısınması
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
    return { c, coverage: need > 0 ? c.length / need : 0 };
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
        for (let i = 80; i < n - 1; i++) {
            const t = c[i][0]; if (t < startT || t < busy) continue;
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
        const data = {}, skipped = []; let candles = 0;
        for (const s of all) {
            btJob.msg = 'Veri indiriliyor: ' + baseOf(s);
            try {
                const h = await fetchHistory15(s, days);
                if (h.coverage < 0.7 && !isMajor(s)) skipped.push(baseOf(s) + ' (%' + Math.round(h.coverage * 100) + ')');
                else if (!isMajor(s) && flatRatio(h.c) >= CFG.FLAT_MAX) skipped.push(baseOf(s) + ' (düz mum)');
                else { data[s] = h.c; candles += h.c.length; }
            } catch (e) { skipped.push(baseOf(s) + ' (hata)'); }
            btJob.done++;
        }
        if (!data[BTC] || data[BTC].length < 1500) throw new Error('BTC 15m verisi yetersiz');
        if (!data[ETH]) data[ETH] = data[BTC];   // ETH inmezse breadth için BTC'yi kullan (nadir)
        btJob.msg = 'Trend ve piyasa yönü hesaplanıyor'; await tick();
        const { pre, maps } = prepare(data, s => costFor((tickers[s] || {}).quoteVolume) * opts.costMult);
        const startT = Date.now() - days * D1, use = Object.keys(data), compare = []; let base = null;
        for (const v of list) {
            btJob.msg = 'Test ediliyor: ' + v.name;
            const r = await simulate(pre, use, maps, v.o, opts, startT), sp = split3(r.trades);
            compare.push({ name: v.name, n: sp.all.n, perDay: sp.all.n / days, win: sp.all.win, avgR: sp.all.avgR, gross: sp.all.avgGross, cost: sp.all.avgCost, totalR: sp.all.totalR, pf: sp.all.pf, dd: sp.all.dd, t: sp.all.t, isR: sp.is.avgR, valR: sp.val.avgR, oosR: sp.oos.avgR, oosN: sp.oos.n });
            if (!base) base = { r, sp };
            btJob.done++;
        }
        const trades = base.r.trades, sp = base.sp, byScore = trades.slice().sort((a, b) => a.score - b.score), mid = Math.floor(byScore.length / 2);
        btJob.result = { days, coins, candles, skipped, funnel: base.r.funnel, costMult: opts.costMult, minScore: opts.minScore, rawN: base.r.raw.length,
            perDay: sp.all.n / days, all: sp.all, is: sp.is, val: sp.val, oos: sp.oos, compare: opts.compare ? compare : null,
            scoreCheck: { lo: grp(byScore.slice(0, mid)), hi: grp(byScore.slice(mid)) },
            bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName), byDir: groupBy(trades, s => s.dir), byBand: groupBy(trades, band),
            bySession: groupBy(trades, sessOf), byMkt: groupBy(trades, mktName), byExit: groupBy(trades, s => s.status),
            byWeek: groupBy(trades, s => 'Hafta ' + String(Math.floor((s.time - startT) / (7 * D1)) + 1).padStart(2, '0')), byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ------------------------- HTTP -------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); });
const authed = u => !ADMIN_KEY || u.searchParams.get('key') === ADMIN_KEY;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') {
            let html; try { html = fs.readFileSync(path.join(__dirname, 'public', 'index.html')); } catch (e) { html = 'public/index.html bulunamadı'; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html);
        }
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/export') return json(res, 200, { signals, lastSig });
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            const b = await readBody(req);
            const days = [14, 30, 60, 90].includes(b.days) ? b.days : 30, coins = [10, 20, 40, 60].includes(b.coins) ? b.coins : 20;
            const costMult = [1, 1.5, 2].includes(b.costMult) ? b.costMult : 1, minScore = [30, 50, 60, 70].includes(b.minScore) ? b.minScore : CFG.MIN_SCORE;
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
        log('SONER TRADE v11 hazır | çıkış ' + CFG.EXIT_MODE + ' | piyasa ' + CFG.MKT_MODE + ' | puan ' + CFG.MIN_SCORE + '+ | ADX ' + CFG.MIN_ADX + '+');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { signalAt, advance, buildSym, prepare, simulate, grp, aggregateN, CFG, VARIANTS };
