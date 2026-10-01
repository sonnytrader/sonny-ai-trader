'use strict';
// ============================================================
// SONER TRADE v34 — TEK DOSYA
//   STRATEJİ 1 : TRAPZONE  — 4H aralık sahte kırılım (5m)
//   STRATEJİ 2 : PFG       — Pull · Flip · Go (1H bias + 5m giriş)
//   Altyapı    : safeFetch kuyruğu, state.json, Telegram, canlı R, backtest
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ccxt = require('ccxt');

// ------------------------------------------------------------
// Piyasa yönü motoru (üst bar göstergesi)
// ------------------------------------------------------------
const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const th = Math.tanh;
function ema(v, p) { const k = 2 / (p + 1); let e = v[0]; const o = [e]; for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); o.push(e); } return o; }
const trAt = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
const trMean = (c, n) => { let s = 0; for (let i = c.length - n; i < c.length; i++) s += trAt(c, i); return s / n; };
function trendScore(c) {
    const cl = c.map(x => x[4]), e21 = ema(cl, 21), e50 = ema(cl, 50), n = cl.length - 1;
    const a = trMean(c, 14) || 1e-9;
    return 0.4 * th((cl[n] - e50[n]) / a / 2) + 0.3 * th((e21[n] - e50[n]) / a) + 0.3 * th((e21[n] - e21[n - 3]) / a * 2);
}
function vwapScore(c5, a15) {
    const d0 = Math.floor(c5[c5.length - 1][0] / 86400e3) * 86400e3;
    let pv = 0, v = 0;
    for (const k of c5) if (k[0] >= d0) { const tp = (k[2] + k[3] + k[4]) / 3; pv += tp * k[5]; v += k[5]; }
    if (!v) return 0;
    return th((c5[c5.length - 1][4] - pv / v) / a15);
}
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
        const [a, b, c] = await Promise.all([safeFetch(ex, sym, '5m', 300), safeFetch(ex, sym, '15m', 200), safeFetch(ex, sym, '1h', 200)]);
        const cl = (x, ms) => x.filter(k => k[0] + ms <= now);
        return scoreOne(cl(a, 300e3), cl(b, 900e3), cl(c, 3600e3));
    }
    async function tick(ex, tickers, universe) {
        const now = Date.now(); const br = breadth(tickers, universe, now);
        if (now - cache.t > 60e3) {
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
    return { tick, get state() { return state; } };
}

// ------------------------------------------------------------
// Konfig
// ------------------------------------------------------------
const num = (k, d) => process.env[k] == null || process.env[k] === '' ? d : Number(process.env[k]);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BT_FILE = path.join(DATA_DIR, 'backtest.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const UI_KEY = process.env.UI_KEY || '';
const M5 = 5 * 60e3, M15 = 15 * 60e3, H1 = 3600e3, DAY = 86400e3;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','LUSD','GUSD','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','WBNB','WAVAX','WMATIC','PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','USOIL','UKOIL','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','COIN','HOOD','CRCL','MSTR','MARA','RIOT','PLTR','SPY','QQQ','SPCX','SNDK','ARM','SMCI','GME','AMC'];

const CFG = {
    UNIVERSE: num('UNIVERSE', 300), MIN_VOL_USDT: num('MIN_VOL', 1e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: 30,
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 3), UNIVERSE_MS: 5 * 60e3, SCAN_DELAY_MS: 8000,
    SLIP_PCT: num('SLIP_PCT', 0.03), KEEP: 300
};
// STRATEJİ 1 — TRAPZONE
const TZ = {
    RANGE_H: 4,                                   // 00:00-04:00 UTC ilk 4H mum
    END_H: num('TZ_END_H', 19),                   // sinyal mumu saati < 19 UTC
    MIN_W_ATR: num('TZ_MIN_W_ATR', 0.5), MAX_W_ATR: num('TZ_MAX_W_ATR', 8),
    MAX_WICK_ATR: num('TZ_MAX_WICK_ATR', 1.0),
    TP_R: num('TZ_TP_R', 2), MAX_DAY: num('TZ_MAX_DAY', 2),
    EXPIRE_MS: num('TZ_EXPIRE_H', 12) * H1,
    MAX_BREACH: num('TZ_MAX_BREACH_BARS', 12),    // kırılım dışarıda en fazla kaç 5m kapanış sürebilir
    FRESH_MIN: num('TZ_FRESH_MIN', 10),
    TOP: num('TZ_TOP', 150), MIN_VOL: num('TZ_MIN_VOL', 10e6), TG: num('TZ_TG', 1)
};
// STRATEJİ 2 — PULL FLIP GO
const PFG = {
    START_H: num('PFG_START_H', 7), END_H: num('PFG_END_H', 19),
    MA_FAST: num('PFG_MA_FAST', 9), MA_SLOW: num('PFG_MA_SLOW', 20),
    MA_TYPE: (process.env.PFG_MA_TYPE || 'sma').toLowerCase() === 'ema' ? 'ema' : 'sma',
    VWAP_N: num('PFG_VWAP_N', 200),               // 5m rolling VWAP penceresi (mum)
    ATR_MULT: num('PFG_ATR_MULT', 0.9),
    TP_R: num('PFG_TP_R', 1.5), MAX_DAY: num('PFG_MAX_DAY', 2),
    EXPIRE_MS: num('PFG_EXPIRE_H', 12) * H1,
    MAX_PULL: num('PFG_MAX_PULL_BARS', 48),       // PULL ile FLIP arası en fazla kaç 5m mum
    FRESH_MIN: num('PFG_FRESH_MIN', 10),
    TOP: num('PFG_TOP', 150), MIN_VOL: num('PFG_MIN_VOL', 10e6), TG: num('PFG_TG', 1)
};

// ------------------------------------------------------------
// Yardımcılar
// ------------------------------------------------------------
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const isMajor = s => /^(BTC|ETH)\//.test(s);
const hourUTC = t => new Date(t).getUTCHours();
const utcDay = t => new Date(t).toISOString().slice(0, 10);
const dayStart = t => Math.floor(t / DAY) * DAY;
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.35; };
const flatRatio = c => { const a = c.slice(-48); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const r2 = x => Number(x.toFixed(3));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clOf = a => a.map(x => x[4]);
const hourBucket = h => { const a = Math.floor(h / 4) * 4; return String(a).padStart(2, '0') + '-' + String(a + 4).padStart(2, '0') + ' UTC'; };

// ============ RATE LIMIT KUYRUĞU ============
const REQ_QUEUE = { last: 0, minGap: num('REQ_GAP_MS', 250) };
async function safeFetch(ex, sym, tf, limit, since) {
    const now = Date.now();
    const wait = REQ_QUEUE.minGap - (now - REQ_QUEUE.last);
    if (wait > 0) await sleep(wait);
    REQ_QUEUE.last = Date.now();
    let attempt = 0;
    while (attempt < 3) {
        try {
            const r = await ex.fetchOHLCV(sym, tf, since, limit);
            REQ_QUEUE.last = Date.now();
            return r;
        } catch (e) {
            const msg = String(e.message || e);
            if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
                attempt++;
                const backoff = 2000 * Math.pow(2, attempt - 1);
                log('RATE LIMIT → ' + backoff + 'ms bekle (' + sym + ' ' + tf + ') deneme ' + attempt + '/3');
                await sleep(backoff);
            } else throw e;
        }
    }
    throw new Error('Rate limit sonrası başarısız: ' + sym + ' ' + tf);
}

// ------------------------------------------------------------
// İndikatörler (hepsi nedensel: i. değer sadece ≤ i. muma bakar)
// ------------------------------------------------------------
function emaSeries(v, p) { const out = new Array(v.length).fill(null); if (v.length < p) return out; let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e; const k = 2 / (p + 1); for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out; }
function smaSeries(v, p) { const o = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
const maSeries = (v, p, type) => type === 'ema' ? emaSeries(v, p) : smaSeries(v, p);
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
// Rolling VWAP: i. mumda son n mumun (i dahil) typical-price × hacim ağırlıklı ortalaması
function vwapSeries(c, n) {
    const o = new Array(c.length).fill(null), pv = [0], vv = [0];
    for (let i = 0; i < c.length; i++) {
        const tp = (c[i][2] + c[i][3] + c[i][4]) / 3;
        pv.push(pv[i] + tp * c[i][5]); vv.push(vv[i] + c[i][5]);
        const a = Math.max(0, i + 1 - n), dv = vv[i + 1] - vv[a];
        if (i + 1 >= Math.min(n, 20) && dv > 0) o[i] = (pv[i + 1] - pv[a]) / dv;
    }
    return o;
}

// ------------------------------------------------------------
// STRATEJİ 1 — TRAPZONE tarayıcı
//   c: kapanmış 5m mumlar (artan zaman). Her UTC günü için en fazla 1 aday döner.
// ------------------------------------------------------------
function tzScan(c, P) {
    const atr = atrSeries(c, 14), out = [], need = P.RANGE_H * 12;
    let day = -1, hi = 0, lo = 0, cnt = 0, done = false, ls = null, ss = null, ld = false, sd = false;
    for (let i = 0; i < c.length; i++) {
        const t = c[i][0], d0 = dayStart(t);
        if (d0 !== day) { day = d0; hi = -Infinity; lo = Infinity; cnt = 0; done = false; ls = ss = null; ld = sd = false; }
        const off = t - d0;
        if (off < P.RANGE_H * H1) { hi = Math.max(hi, c[i][2]); lo = Math.min(lo, c[i][3]); cnt++; continue; }
        if (done || cnt < need || off >= P.END_H * H1) continue;
        const a = atr[i]; if (!(a > 0)) continue;
        const h = c[i][2], l = c[i][3], cl = c[i][4], w = hi - lo;
        if (l < lo && h > hi) { ls = ss = null; ld = sd = true; continue; }        // iki uca birden taşan mum: belirsiz, atla
        // ---- LONG: RL altına iner → 5m kapanış RL üstüne döner
        if (!ld && l < lo) { if (!ls) ls = { ext: l, n: 0 }; else ls.ext = Math.min(ls.ext, l); }
        if (ls) {
            if (cl > lo) {
                const wick = lo - ls.ext;
                if (w >= P.MIN_W_ATR * a && w <= P.MAX_W_ATR * a && wick <= P.MAX_WICK_ATR * a) {
                    out.push({ strat: 'TZ', dir: 'LONG', day: d0, time: t + M5, hour: hourUTC(t), entry: cl, stop: ls.ext, rl: lo, rh: hi, wickATR: wick / a, widthATR: w / a, atr: a });
                    done = true;
                }
                ls = null;
            } else if (++ls.n >= P.MAX_BREACH) { ls = null; ld = true; }
        } else if (ld && cl > lo) ld = false;
        if (done) continue;
        // ---- SHORT: RH üstüne çıkar → 5m kapanış RH altına döner
        if (!sd && h > hi) { if (!ss) ss = { ext: h, n: 0 }; else ss.ext = Math.max(ss.ext, h); }
        if (ss) {
            if (cl < hi) {
                const wick = ss.ext - hi;
                if (w >= P.MIN_W_ATR * a && w <= P.MAX_W_ATR * a && wick <= P.MAX_WICK_ATR * a) {
                    out.push({ strat: 'TZ', dir: 'SHORT', day: d0, time: t + M5, hour: hourUTC(t), entry: cl, stop: ss.ext, rl: lo, rh: hi, wickATR: wick / a, widthATR: w / a, atr: a });
                    done = true;
                }
                ss = null;
            } else if (++ss.n >= P.MAX_BREACH) { ss = null; sd = true; }
        } else if (sd && cl < hi) sd = false;
    }
    return out;
}

// ------------------------------------------------------------
// STRATEJİ 2 — PULL FLIP GO tarayıcı
//   c: kapanmış 5m mumlar, h1: kapanmış 1H mumlar. Her UTC günü için en fazla 1 aday.
//   Sıra: bias(1H) → PULL (MA9, MA20'yi bias'a ters keser) → FLIP (bias yönünde geri keser) → VWAP filtresi → entry
// ------------------------------------------------------------
function pfgScan(c, h1, P) {
    const out = [];
    if (c.length < 50 || h1.length < 30) return out;
    const cl = clOf(c), m9 = maSeries(cl, P.MA_FAST, P.MA_TYPE), m20 = maSeries(cl, P.MA_SLOW, P.MA_TYPE), vw = vwapSeries(c, P.VWAP_N);
    const hc = clOf(h1), h9 = maSeries(hc, P.MA_FAST, P.MA_TYPE), h20 = maSeries(hc, P.MA_SLOW, P.MA_TYPE), hatr = atrSeries(h1, 14);
    let hp = -1, pull = null, day = -1, done = false;
    for (let i = 1; i < c.length; i++) {
        const t = c[i][0], close = t + M5, d0 = dayStart(t);
        if (d0 !== day) { day = d0; done = false; }
        while (hp + 1 < h1.length && h1[hp + 1][0] + H1 <= close) hp++;        // sadece kapanmış 1H
        if (hp < 0 || h9[hp] == null || h20[hp] == null || hatr[hp] == null) { pull = null; continue; }
        if (m9[i] == null || m20[i] == null || m9[i - 1] == null || m20[i - 1] == null) continue;
        const bias = h9[hp] > h20[hp] ? 1 : h9[hp] < h20[hp] ? -1 : 0;
        if (!bias) { pull = null; continue; }
        if (pull && pull.dir !== bias) pull = null;                             // bias değişti → eski PULL geçersiz
        const up = m9[i - 1] <= m20[i - 1] && m9[i] > m20[i];
        const dn = m9[i - 1] >= m20[i - 1] && m9[i] < m20[i];
        const pullX = bias === 1 ? dn : up, flipX = bias === 1 ? up : dn;
        if (pullX) { pull = { dir: bias, i }; continue; }
        if (!flipX || !pull) continue;
        const age = i - pull.i; pull = null;
        if (age > P.MAX_PULL) continue;
        const h = hourUTC(t); if (h < P.START_H || h >= P.END_H) continue;
        if (done) continue;
        const entry = c[i][4], v = vw[i]; if (v == null) continue;
        if (bias === 1 ? !(v < entry) : !(v > entry)) continue;                 // LONG: VWAP entry altında · SHORT: üstünde
        const risk = P.ATR_MULT * hatr[hp]; if (!(risk > 0)) continue;
        out.push({ strat: 'PFG', dir: bias === 1 ? 'LONG' : 'SHORT', day: d0, time: close, hour: h, entry, stop: entry - bias * risk,
            bias: bias === 1 ? 'LONG' : 'SHORT', pullBars: age, vwap: v, ma9: m9[i], ma20: m20[i], atr1h: hatr[hp] });
        done = true;
    }
    return out;
}

// ------------------------------------------------------------
// Durum
// ------------------------------------------------------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0 }, dirty = false, lastScanSlot = 0, liveRunning = false;
let live = { last: 0, ms: 0, err: '' };
let tzSignals = [], pfgSignals = [];
let diag = { t: 0, ms: 0, list: 0, ok: 0, short: 0, stale: 0, err: 0, errMsg: '', tz: { on: false, cand: 0, sig: 0 }, pfg: { on: false, cand: 0, sig: 0 } };
const candleCache = new Map(), h1Cache = new Map();
const regime = createRegime(); let REG = null;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, strat: 'both', startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;

function loadState() {
    try { const b = JSON.parse(fs.readFileSync(BT_FILE, 'utf8')); if (b && b.result) { b.running = false; bt = b; } } catch (e) { }
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        tzSignals = (j.tz || []).filter(s => s && s.id && s.entry);
        pfgSignals = (j.pfg || []).filter(s => s && s.id && s.entry);
        log('durum:', tzSignals.length, 'Trapzone,', pfgSignals.length, 'PFG');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ tz: tzSignals.slice(0, CFG.KEEP), pfg: pfgSignals.slice(0, CFG.KEEP) }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { log('kayıt hatası', e.message); }
}
let tgTimes = [];
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = Date.now(); tgTimes = tgTimes.filter(t => now - t < 60e3);
    if (tgTimes.length >= 18) return; tgTimes.push(now);
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) }); } catch (e) { }
}
const tvLink = (base, iv) => 'https://www.tradingview.com/chart/?symbol=BITGET:' + base + 'USDT.P&interval=' + iv;

function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const m = ex.markets[sym], inf = (m && m.info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    const st = String(inf.symbolType || inf.category || '').toLowerCase();
    if (st && st !== 'perpetual' && st !== 'crypto') return true;
    const lt = Number(inf.launchTime || inf.onlineTime || 0);
    return lt > 1e12 && Date.now() - lt < CFG.MIN_LISTING_DAYS * DAY;
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
        for (const s of [BTC, ETH]) { const t = tickers[s]; if (t) market[s === BTC ? 'btc' : 'eth'] = { price: t.last, chg: t.percentage }; }
    } catch (e) { log('evren hatası', e.message); }
}
async function refreshTickers() {
    try {
        await sleep(200);
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) market[s === BTC ? 'btc' : 'eth'] = { price: t[s].last, chg: t[s].percentage };
    } catch (e) { }
}

// ------------------------------------------------------------
// Sinyal üretimi + canlı takip
// ------------------------------------------------------------
const PCFG = { TZ, PFG };
const listOf = strat => strat === 'TZ' ? tzSignals : pfgSignals;
const sigId = (strat, sym, day) => strat + '_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + day;

function makeSig(strat, sym, cd, tk, nth) {
    const P = PCFG[strat], L = cd.dir === 'LONG' ? 1 : -1, risk = Math.abs(cd.entry - cd.stop);
    if (!(risk > 0)) return null;
    const riskPct = risk / cd.entry * 100, tp = cd.entry + L * risk * P.TP_R, last = tk.last || cd.entry;
    if (L * (last - cd.stop) <= 0 || L * (last - tp) >= 0) return null;          // fiyat zaten stop/TP'ye gitmiş
    const costR = (costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT) / riskPct;
    const info = strat === 'TZ'
        ? { rl: cd.rl, rh: cd.rh, widthATR: r2(cd.widthATR), wickATR: r2(cd.wickATR), atr: cd.atr }
        : { bias: cd.bias, pullBars: cd.pullBars, vwap: cd.vwap, ma9: cd.ma9, ma20: cd.ma20, atr1h: cd.atr1h };
    return { id: sigId(strat, sym, cd.day), strat, symbol: sym, base: baseOf(sym), dir: cd.dir, time: cd.time, createdAt: Date.now(), day: cd.day, hour: cd.hour, nth,
        entry: cd.entry, stop: cd.stop, riskAbs: risk, riskPct: r2(riskPct), costR: r2(costR), tpR: P.TP_R, tp, info,
        aligned: REG && REG.dir !== 'NÖTR' ? REG.dir === cd.dir : null,
        status: 'OPEN', lastPrice: last, mfe: 0, mae: 0 };
}
function sigMsg(s) {
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + (s.strat === 'TZ' ? 'TRAPZONE ' : 'PFG ') + s.dir + ' ' + s.base + ' (5m)' +
        '\nGiriş ' + fmt(s.entry) + ' | Stop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' +
        '\nTP ' + fmt(s.tp) + ' (' + s.tpR + 'R) • Gün içi #' + s.nth +
        '\n📈 ' + tvLink(s.base, 5);
}
function trackSigs(list, P, now) {
    for (const s of list) {
        if (s.status !== 'OPEN') continue;
        const t = tickers[s.symbol]; if (!t || !t.last) continue;
        const px = t.last, L = s.dir === 'LONG' ? 1 : -1, r = L * (px - s.entry) / s.riskAbs;
        s.lastPrice = px; s.mfe = Math.max(s.mfe || 0, r); s.mae = Math.min(s.mae || 0, r);
        let res = null;
        if (L * (px - s.stop) <= 0) { s.status = 'STOP'; res = -1; }
        else if (r >= s.tpR) { s.status = 'TP'; res = s.tpR; }
        else if (now - s.time >= P.EXPIRE_MS) { s.status = 'SÜRE'; res = r; }
        if (res != null) { s.closedAt = now; s.netR = r2(res - s.costR); dirty = true; }
    }
}
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; return; }
        live.err = '';
        try { REG = (await regime.tick(ex, tickers, universe)) || REG; } catch (e) { }
        trackSigs(tzSignals, TZ, now); trackSigs(pfgSignals, PFG, now);
        live.last = Date.now(); live.ms = live.last - t0;
    } catch (e) { live.err = e.message; log('canlı hata', e.message); }
    finally { liveRunning = false; }
}

async function getH1(sym, now) {
    const slot = Math.floor(now / H1), hit = h1Cache.get(sym);
    if (hit && hit.slot === slot) return hit.d;
    const d = closedOnly(await safeFetch(ex, sym, '1h', 120), H1, now);
    const res = d.length >= 40 ? d : null;
    h1Cache.set(sym, { slot, d: res }); return res;
}

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now();
    const dg = { t: t0, ms: 0, list: 0, ok: 0, short: 0, stale: 0, err: 0, errMsg: '', tz: { on: false, cand: 0, sig: 0 }, pfg: { on: false, cand: 0, sig: 0 } };
    try {
        const today = dayStart(t0), hNow = hourUTC(t0);
        const tzOn = hNow >= TZ.RANGE_H && hourUTC(t0 - TZ.FRESH_MIN * 60e3) < TZ.END_H;
        const pfgOn = hNow >= PFG.START_H && hourUTC(t0 - PFG.FRESH_MIN * 60e3) < PFG.END_H;
        dg.tz.on = tzOn; dg.pfg.on = pfgOn;
        if (tzOn || pfgOn) {
            const minV = Math.min(TZ.MIN_VOL, PFG.MIN_VOL);
            const list = universe.filter(s => isMajor(s) || ((tickers[s] || {}).quoteVolume || 0) >= minV).slice(0, Math.max(TZ.TOP, PFG.TOP));
            for (const s of [BTC, ETH]) if (universe.includes(s) && !list.includes(s)) list.push(s);
            dg.list = list.length;
            const cands = []; let idx = 0;
            const worker = async () => {
                while (idx < list.length) {
                    const k = idx++, sym = list[k], vol = (tickers[sym] || {}).quoteVolume || 0;
                    const doTz = tzOn && (isMajor(sym) || (k < TZ.TOP && vol >= TZ.MIN_VOL));
                    const doPfg = pfgOn && (isMajor(sym) || (k < PFG.TOP && vol >= PFG.MIN_VOL));
                    if (!doTz && !doPfg) continue;
                    try {
                        const c = closedOnly(await safeFetch(ex, sym, '5m', 300), M5, t0);
                        if (c.length < 150) { dg.short++; continue; }
                        if (t0 - (c[c.length - 1][0] + M5) > 10 * 60e3) { dg.stale++; continue; }
                        if (!isMajor(sym) && flatRatio(c) >= CFG.FLAT_MAX) continue;
                        dg.ok++;
                        if (doTz) {
                            const cd = tzScan(c, TZ).find(x => x.day === today);
                            if (cd) { dg.tz.cand++; if (t0 - cd.time <= TZ.FRESH_MIN * 60e3) cands.push({ strat: 'TZ', sym, cd, vol }); }
                        }
                        if (doPfg) {
                            const h1 = await getH1(sym, t0);
                            if (h1) {
                                const cd = pfgScan(c, h1, PFG).find(x => x.day === today);
                                if (cd) { dg.pfg.cand++; if (t0 - cd.time <= PFG.FRESH_MIN * 60e3) cands.push({ strat: 'PFG', sym, cd, vol }); }
                            }
                        }
                    } catch (e) { dg.err++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 120); }
                }
            };
            await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
            // Kronolojik sırala, günlük limit + coin/gün tekilliği uygula
            cands.sort((a, b) => a.cd.time - b.cd.time || b.vol - a.vol);
            for (const x of cands) {
                const arr = listOf(x.strat), P = PCFG[x.strat];
                if (arr.some(s => s.id === sigId(x.strat, x.sym, x.cd.day))) continue;
                const n = arr.filter(s => s.day === today).length;
                if (n >= P.MAX_DAY) continue;
                const sig = makeSig(x.strat, x.sym, x.cd, tickers[x.sym] || {}, n + 1);
                if (!sig) continue;
                arr.unshift(sig); if (arr.length > CFG.KEEP) arr.length = CFG.KEEP;
                dirty = true; dg[x.strat === 'TZ' ? 'tz' : 'pfg'].sig++;
                log(x.strat, sig.dir, sig.base, 'giriş', fmt(sig.entry), 'stop', fmt(sig.stop), 'risk %' + sig.riskPct, 'maliyet ' + sig.costR + 'R', 'gün #' + sig.nth);
                if (P.TG) telegram(sigMsg(sig));
            }
        }
        for (const [k] of h1Cache) if (!universe.includes(k)) h1Cache.delete(k);
        log('tarama: TZ', dg.tz.on ? 'açık' : 'kapalı', 'aday', dg.tz.cand, 'sinyal', dg.tz.sig, '| PFG', dg.pfg.on ? 'açık' : 'kapalı', 'aday', dg.pfg.cand, 'sinyal', dg.pfg.sig,
            '| liste', dg.list, 'kontrol', dg.ok, 'hata', dg.err, dg.errMsg ? '| ilk hata: ' + dg.errMsg : '');
    } catch (e) { log('tarama hatası', e.message); }
    dg.ms = Date.now() - t0; diag = dg; scan.last = Date.now(); scan.ms = dg.ms; scan.running = false;
}

// ------------------------------------------------------------
// İstatistik
// ------------------------------------------------------------
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
function statsCalc(list) {
    const closed = list.filter(s => s.status !== 'OPEN' && s.netR != null), td = utcDay(Date.now());
    return {
        all: grp(closed), today: grp(closed.filter(s => utcDay(s.closedAt) === td)),
        todayN: list.filter(s => utcDay(s.time) === td).length, open: list.filter(s => s.status === 'OPEN').length,
        byHour: groupBy(closed, s => hourBucket(s.hour)), byNth: groupBy(closed, s => 'Gün içi #' + s.nth),
        byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status)
    };
}

// ------------------------------------------------------------
// BACKTEST (sadece kapanmış mumlar, giriş = sinyal mumu kapanışı, simülasyon sonraki mumdan başlar)
// ------------------------------------------------------------
const yieldLoop = () => new Promise(r => setImmediate(r));
// Aynı mumda hem stop hem TP görünürse STOP varsayılır (muhafazakâr).
function simulate(c, i, L, entry, stop, tp, tpR, sigTime, expMs) {
    const risk = Math.abs(entry - stop);
    for (let j = i + 1; j < c.length; j++) {
        const k = c[j], end = k[0] + M5;
        if (L === 1 ? k[3] <= stop : k[2] >= stop) return { status: 'STOP', gross: -1, t: end };
        if (L === 1 ? k[2] >= tp : k[3] <= tp) return { status: 'TP', gross: tpR, t: end };
        if (end - sigTime >= expMs) return { status: 'SÜRE', gross: L * (k[4] - entry) / risk, t: end };
    }
    return null;                                                                  // veri bitti, sonuç belirsiz → işleme alma
}
async function btSymbol(sym, c5, h1, vol24, startT, which) {
    const out = [];
    const emit = (cd, P, extra) => {
        if (cd.time < startT) return;
        const L = cd.dir === 'LONG' ? 1 : -1, risk = Math.abs(cd.entry - cd.stop), riskPct = risk / cd.entry * 100;
        if (!(risk > 0)) return;
        const i = c5.findIndex(x => x[0] + M5 === cd.time); if (i < 0) return;
        const tp = cd.entry + L * risk * P.TP_R;
        const sim = simulate(c5, i, L, cd.entry, cd.stop, tp, P.TP_R, cd.time, P.EXPIRE_MS); if (!sim) return;
        const costR = (costFor(vol24) + 2 * CFG.SLIP_PCT) / riskPct;
        out.push(Object.assign({ strat: cd.strat, sym, dir: cd.dir, t: cd.time, day: cd.day, hour: cd.hour, riskPct: r2(riskPct), costR: r2(costR),
            status: sim.status, grossR: r2(sim.gross), netR: r2(sim.gross - costR) }, extra));
    };
    if (which.tz) { await yieldLoop(); for (const cd of tzScan(c5, TZ)) emit(cd, TZ, { wick: r2(cd.wickATR), width: r2(cd.widthATR) }); }
    if (which.pfg && h1 && h1.length >= 40) { await yieldLoop(); for (const cd of pfgScan(c5, h1, PFG)) emit(cd, PFG, { pull: cd.pullBars }); }
    return out;
}
function verdictOf(n, g, a, b) {
    if (n < 100) return ['w', 'Örnek az (' + n + ' işlem). Sonuca güvenme.'];
    if (g.avgR <= 0) return ['r', 'Bu kurallarla maliyetler sonrası kenar görünmüyor.'];
    if (g.t >= 2 && a.avgR > 0 && b.avgR > 0) return ['g', 'Olumlu işaret: ortalama R pozitif, iki yarıda da pozitif, t ≥ 2.'];
    return ['w', 'Karışık sonuç: ortalama R pozitif ama istikrarsız.'];
}
function btReport(trades, P) {
    const all = trades.filter(x => x.netR != null).sort((a, b) => a.t - b.t);
    if (!all.length) return { n: 0, nAll: 0 };
    const cnt = {}, lim = [];
    for (const x of all) { cnt[x.day] = (cnt[x.day] || 0) + 1; x.nth = cnt[x.day]; if (x.nth <= P.MAX_DAY) lim.push(x); }
    const mid = Math.floor(all.length / 2), gAll = grp(all), gLim = grp(lim), a = grp(all.slice(0, mid)), b = grp(all.slice(mid));
    const [level, vtxt] = verdictOf(all.length, gAll, a, b);
    const dayR = {}; for (const x of lim) dayR[x.day] = (dayR[x.day] || 0) + x.netR;
    const dv = Object.values(dayR), nDays = Object.keys(cnt).length;
    const costB = x => x.costR <= 0.3 ? 'maliyet ≤0.3R' : x.costR <= 0.6 ? 'maliyet 0.3-0.6R' : 'maliyet >0.6R';
    return { n: lim.length, nAll: all.length, level, maxDay: P.MAX_DAY, days: nDays, g: gLim, gAll,
        verdict: vtxt + ' (değerlendirme limitsiz ' + all.length + ' aday üzerinden; limitli ' + lim.length + ' işlem)',
        worstDay: dv.length ? Math.min.apply(null, dv) : 0, bestDay: dv.length ? Math.max.apply(null, dv) : 0,
        tables: {
            'Genel': { ['Limitli (günde max ' + P.MAX_DAY + ')']: gLim, 'Limitsiz (tüm adaylar)': gAll, 'Limitsiz ilk yarı': a, 'Limitsiz ikinci yarı': b },
            'Saat dilimi (limitli)': groupBy(lim, x => hourBucket(x.hour)),
            'Gün içi sinyal sırası (limitsiz)': groupBy(all, x => 'Gün içi #' + x.nth),
            'Yön (limitli)': groupBy(lim, x => x.dir), 'Maliyet (limitli)': groupBy(lim, costB), 'Çıkış (limitli)': groupBy(lim, x => x.status) } };
}
async function btFetchAll(xc, sym, tf, ms, from) {
    let since = from; const out = [], end = Date.now();
    for (let g = 0; g < 80 && since < end; g++) { const r = await xc.fetchOHLCV(sym, tf, since, 1000); if (!r.length) break; out.push(...r); const lt = r[r.length - 1][0]; if (lt < since) break; since = lt + ms; }
    const m = new Map(); for (const x of out) m.set(x[0], x);
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter(x => x[0] + ms <= end);
}
async function runBacktestJob(days, n, strat) {
    if (bt.running) return;
    const which = { tz: strat === 'tz' || strat === 'both', pfg: strat === 'pfg' || strat === 'both' };
    bt = { running: true, i: 0, total: 0, sym: '', days, n, strat, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const minV = Math.min(which.tz ? TZ.MIN_VOL : Infinity, which.pfg ? PFG.MIN_VOL : Infinity);
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear &&
            !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= minV && !isSuspect(t.symbol))
            .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
        bt.total = list.length;
        const start = dayStart(Date.now() - days * DAY); let tzT = [], pfgT = [], skipped = 0;
        for (const t of list) {
            bt.sym = baseOf(t.symbol);
            try {
                const c5 = await btFetchAll(exBT, t.symbol, '5m', M5, start - DAY);
                const h1 = which.pfg ? await btFetchAll(exBT, t.symbol, '1h', H1, start - 4 * DAY) : null;
                const tr = await btSymbol(t.symbol, c5, h1, t.quoteVolume, start, which);
                for (const x of tr) (x.strat === 'TZ' ? tzT : pfgT).push(x);
            } catch (e) { skipped++; }
            bt.i++;
            await sleep(500);
        }
        bt.result = { days, coins: list.length, requested: n, skipped, strat, start };
        if (which.tz) bt.result.tz = btReport(tzT, TZ);
        if (which.pfg) bt.result.pfg = btReport(pfgT, PFG);
    } catch (e) { bt.err = e.message; log('backtest hata', e.message); }
    bt.running = false; bt.finishedAt = Date.now();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BT_FILE, JSON.stringify(bt)); } catch (e) { }
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
function infoOf(P, list, d) {
    return { maxDay: P.MAX_DAY, tpR: P.TP_R, expireH: P.EXPIRE_MS / H1, startH: P.START_H == null ? 0 : P.START_H, endH: P.END_H,
        todayN: list.filter(s => s.day === dayStart(Date.now())).length, last: diag.t, ms: diag.ms, dg: d, scanned: diag.ok, errMsg: diag.errMsg };
}
function apiState() {
    const px = {};
    for (const x of tzSignals.slice(0, 80).concat(pfgSignals.slice(0, 80))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now: Date.now(), mode: 'v34 • Trapzone + PFG', px, market, regime: REG,
        tz: tzSignals.slice(0, 80), tzStats: statsCalc(tzSignals), tzInfo: infoOf(TZ, tzSignals, diag.tz),
        pfg: pfgSignals.slice(0, 80), pfgStats: statsCalc(pfgSignals), pfgInfo: infoOf(PFG, pfgSignals, diag.pfg),
        live: { last: live.last, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible }
    };
}
async function apiCandles(sym, reqTf) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const tf = ['5m', '15m', '1h'].includes(reqTf) ? reqTf : '5m', dur = tf === '5m' ? M5 : tf === '15m' ? M15 : H1;
    const key = sym + '|' + tf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const c = await safeFetch(ex, sym, tf, 400), cl = clOf(c), m9 = smaSeries(cl, 9), m20 = smaSeries(cl, 20), cut = Math.max(0, c.length - 150);
    const d = { c: c.slice(cut), m9: m9.slice(cut), m20: m20.slice(cut), tf, dur };
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ------------------------------------------------------------
// UI
// ------------------------------------------------------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
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
.tag.b{color:var(--bl);border-color:rgba(90,169,255,.4)}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:9px 12px}.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:20px;font-weight:800;margin-top:2px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:420px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:100px}
.frm select{width:auto}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:280px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v34</small></div>
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
var TABS=[['tz','Trapzone'],['pfg','PFG'],['stat','İstatistik'],['bt','Backtest']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='tz',selId={tz:null,pfg:null},chartCache={},chartFor='',cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}'),actx=null,lastNew={tz:0,pfg:0},toastT=null,sound=true;
function $(id){return document.getElementById(id)}
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function tag(t,c){return '<span class="tag '+c+'">'+t+'</span>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.textContent=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function checkNew(k){var a=S[k]||[],mx=a.reduce(function(m,x){return Math.max(m,x.createdAt||0)},0);
 if(!lastNew[k]){lastNew[k]=mx||Date.now();return}
 var nw=a.filter(function(x){return (x.createdAt||0)>lastNew[k]});if(mx>lastNew[k])lastNew[k]=mx;
 if(nw.length&&sound){beep();var s=nw[0];showToast('🔔 '+(k==='tz'?'TRAPZONE ':'PFG ')+s.dir+' '+s.base,function(){tab=k;selId[k]=s.id;chartFor='';renderAll()})}}

function renderTop(){var m=S.market,R=S.regime;
 if(!R)$('cReg').innerHTML='<b>Yön</b> <span class="fl">hesaplanıyor…</span>';
 else{var c=R.dir==='LONG'?'up':R.dir==='SHORT'?'dn':'fl';
  $('cReg').innerHTML='<b>Yön</b> <span class="'+c+'" style="font-weight:800">'+R.dir+'</span> <span class="'+c+'">'+sg(R.score,0)+'</span> <span class="fl">| '+R.regime+(R.breadth?' | ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'</span>'}
 $('cMkt').innerHTML='<b>Piyasa</b> <span class="fl">'+S.scan.universe+' coin</span>';
 $('cBTC').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 var T=(S.tzStats&&S.tzStats.today)||{totalR:0},P=(S.pfgStats&&S.pfgStats.today)||{totalR:0};
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(T.totalR)+'">Trapzone '+sg(T.totalR,1)+' R</span> <span class="fl">|</span> <span class="'+cl(P.totalR)+'">PFG '+sg(P.totalR,1)+' R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){
 $('tabs').innerHTML=TABS.map(function(t){
  var st=S[t[0]+'Stats'],cnt=st?' ('+st.open+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;chartFor='';if(tab==='bt')pollBT();renderAll()}})}

function sigCard(s){
 var L=s.dir==='LONG'?1:-1,op=s.status==='OPEN',px=(S.px&&S.px[s.symbol])||s.lastPrice||s.entry,r=op?L*(px-s.entry)/s.riskAbs:null;
 var st={OPEN:['AÇIK','w'],TP:['TP ✓','g'],STOP:['STOP','r'],'SÜRE':['SÜRE','w']}[s.status]||['?',''];
 var pn=op?'<span class="sc '+cl(r)+'">'+sg(r)+'R</span>':(s.netR!=null?'<span class="sc '+cl(s.netR)+'">'+sg(s.netR)+'R</span>':'');
 var al=s.aligned===true?tag('yön uyumlu','g'):s.aligned===false?tag('yön ters','r'):'';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+(selId[tab]===s.id?' sel':'')+'" data-id="'+esc(s.id)+'"><div class="r1"><span class="badge '+(L===1?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span>'+tag('#'+s.nth,'b')+tag(st[0],st[1])+al+pn+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop <b class="zarar">'+fp(s.stop)+'</b></span><span>TP <b class="kar">'+fp(s.tp)+'</b></span><span>Risk '+f2(s.riskPct)+'%</span><span>'+ago(s.time)+' önce</span></div></div>'}

function renderList(){
 if(tab==='tz'||tab==='pfg'){
  var a=S[tab]||[],I=S[tab+'Info']||{};
  var h='<div class="frm" style="padding:4px 8px"><label class="fl"><input type="checkbox" style="width:auto" '+(sound?'checked ':'')+'onchange="sound=this.checked"> ses</label><span class="fl">Bugün '+(I.todayN||0)+' / '+(I.maxDay||0)+' sinyal</span></div>';
  h+=a.length?a.map(sigCard).join(''):'<div class="note" style="padding:10px">Henüz sinyal yok.</div>';
  $('list').innerHTML=h;
  Array.prototype.forEach.call($('list').querySelectorAll('.card'),function(e){e.onclick=function(){selId[tab]=e.dataset.id;chartFor='';renderList();renderMain()}})}
 else $('list').innerHTML='<div class="note" style="padding:10px">Detaylar sağda.</div>'}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){if(!$('cBal'))return;var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);localStorage.setItem('st_calc',JSON.stringify(cfgC));var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});upd()}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>'};
function statBlock(name,T,I){
 var h='<h3 style="color:var(--tx);font-size:14px;margin-top:18px">'+name+'</h3><div class="note">Bugün '+(T.todayN||0)+' sinyal • açık '+(T.open||0)+' • günlük limit '+(I.maxDay||'-')+'</div>';
 if(T.all&&T.all.n)h+=tbl({'Tümü':T.all,'Bugün':T.today},'Genel')+tbl(T.byHour||{},'Saat dilimi (UTC)')+tbl(T.byNth||{},'Gün içi sinyal sayısı')+tbl(T.byDir||{},'Yön')+tbl(T.byExit||{},'Çıkış');
 else h+='<div class="note">Henüz kapanan sinyal yok.</div>';
 return h}
function statView(){return '<h2>İstatistik</h2>'+statBlock('TRAPZONE',S.tzStats||{},S.tzInfo||{})+statBlock('PFG',S.pfgStats||{},S.pfgInfo||{})+'<div class="note">Canlı takip 8 sn lik fiyatla yapılır, wick/ara fiyat kaçabilir. Maliyet (komisyon+kayma) düşülmüştür. Saatler UTC.</div>'}

// Sade grafik: sadece STOP + TP çizgileri (ince, kesikli) + anlık fiyat
function drawChart(d,lv,cid,sym){
 var c=$(cid);if(!c||!d||!d.c||!d.c.length)return;
 var W=c.clientWidth,H=c.clientHeight,dp=devicePixelRatio||1;c.width=W*dp;c.height=H*dp;
 var x=c.getContext('2d');x.setTransform(1,0,0,1,0,0);x.scale(dp,dp);
 var nc=d.c.length,n=nc+3,Lm=8,Rm=76,T=12,B=20,PW=W-Lm-Rm,PH=H-T-B;
 var volH=Math.max(50,Math.min(70,PH*0.18)),priceH=PH-volH;
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 var lp=(sym&&S.px&&S.px[sym])||d.c[nc-1][4];hi=Math.max(hi,lp);lo=Math.min(lo,lp);
 var act=lv&&lv.active;
 if(act)[lv.stop,lv.tp1].forEach(function(q){var v=Number(q);if(q!=null&&isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var pad=(hi-lo)*.06;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*priceH},X=function(k){return Lm+(k+.5)/n*PW},cw=Math.max(2,PW/n*.68);
 x.font='10px system-ui';x.fillStyle='#8593a5';
 for(var i=0;i<=4;i++){var gy=T+priceH*i/4;x.strokeStyle='rgba(255,255,255,.05)';x.beginPath();x.moveTo(Lm,gy);x.lineTo(W-Rm,gy);x.stroke();x.fillText(fp(hi-(hi-lo)*i/4),W-Rm+6,gy+3)}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.m20,'#4a5568',0.9);line(d.m9,'#6b7280',0.9);
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.strokeStyle=x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+priceH+8,vH=volH-4;
 d.c.forEach(function(k,i){var h=(k[5]/vmax)*vH;x.fillStyle=k[4]>=k[1]?'#3ddc97':'#ff6b7a';x.globalAlpha=0.6;x.fillRect(X(i)-cw/2,vTop+vH-h,cw,h);x.globalAlpha=1});
 if(act){
  var drawLv=function(price,col,label){var v=Number(price);if(!isFinite(v))return;var y=Y(v);if(y<T-2||y>T+priceH+2)return;
   x.strokeStyle=col;x.lineWidth=1.2;x.globalAlpha=0.75;x.setLineDash([4,4]);x.beginPath();x.moveTo(Lm,y);x.lineTo(W-Rm,y);x.stroke();x.setLineDash([]);x.globalAlpha=1;
   x.fillStyle=col;x.font='bold 10px system-ui';x.fillText(label+' '+fp(v),W-Rm+4,y+3)};
  drawLv(lv.stop,'#ff6b7a','SL');drawLv(lv.tp1,'#3ddc97','TP')}
 x.strokeStyle='rgba(255,255,255,.85)';x.lineWidth=1.2;x.beginPath();x.moveTo(Lm,Y(lp));x.lineTo(W-Rm,Y(lp));x.stroke();
 x.fillStyle='#e6ebf2';x.font='bold 11px system-ui';x.fillText(fp(lp),W-Rm+4,Y(lp)-4);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText(d.tf+' • MA9/MA20',Lm+4,H-5)}
function selSig(){var s=null;(S[tab]||[]).forEach(function(x){if(x.id===selId[tab])s=x});return s}
function loadChart(s,force){
 var lv={stop:s.stop,tp1:s.tp,active:s.status==='OPEN'};
 if(chartCache[s.symbol])drawChart(chartCache[s.symbol],lv,'cv',s.symbol);
 if(!force&&chartFor===s.id)return;chartFor=s.id;
 fetch(api('/api/candles?symbol='+encodeURIComponent(s.symbol)+'&tf=5m')).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[s.symbol]=d;var c=selSig();if(c&&c.id===s.id&&$('cv'))drawChart(d,{stop:c.stop,tp1:c.tp,active:c.status==='OPEN'},'cv',c.symbol)}).catch(function(){})}

function detailsOf(s){var i=s.info||{};
 if(s.strat==='TZ')return '<div><span>Range High</span><b>'+fp(i.rh)+'</b></div><div><span>Range Low</span><b>'+fp(i.rl)+'</b></div><div><span>Genişlik</span><b>'+f2(i.widthATR,1)+' ATR</b></div><div><span>İğne</span><b>'+f2(i.wickATR,2)+' ATR</b></div>';
 return '<div><span>1H Bias</span><b>'+esc(i.bias||'-')+'</b></div><div><span>Pull→Flip</span><b>'+(i.pullBars==null?'-':i.pullBars)+' mum</b></div><div><span>VWAP</span><b>'+fp(i.vwap)+'</b></div><div><span>1H ATR</span><b>'+fp(i.atr1h)+'</b></div>'}
function rulesOf(k,I){
 if(k==='tz')return 'İlk 4H (00:00-04:00 UTC) high/low = aralık. Fiyat aralık dışına çıkıp 5m mum aralığa geri kapanırsa ters yöne işlem. Stop = iğne ucu, TP = '+I.tpR+'R, sinyal saati &lt; '+I.endH+':00 UTC, günde max '+I.maxDay+', coin başına günde 1, süre '+I.expireH+' saat.';
 return '1H MA9/MA20 = bias. 5m: PULL (MA9, MA20’yi ters keser) → FLIP (bias yönünde geri keser) → VWAP entry’nin doğru tarafında ise giriş. Stop = 1H ATR × 0.9, TP = '+I.tpR+'R, '+I.startH+':00-'+I.endH+':00 UTC, günde max '+I.maxDay+', coin başına günde 1, süre '+I.expireH+' saat.'}
function sigMain(){
 var s=selSig(),I=S[tab+'Info']||{},nm=tab==='tz'?'Trapzone':'PFG',h='';
 if(s){var L=s.dir==='LONG'?1:-1,op=s.status==='OPEN',px=(S.px&&S.px[s.symbol])||s.lastPrice||s.entry,r=L*(px-s.entry)/s.riskAbs,rn=op?r:s.netR;
  var st={OPEN:'AÇIK',TP:'TP ✓',STOP:'STOP','SÜRE':'SÜRE'}[s.status]||'?';
  h+='<div class="r1" style="margin-bottom:8px"><span class="badge '+(L===1?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.base)+'</h2>'+tag(nm,'b')+tag(st,op?'w':s.status==='STOP'?'r':'g')+tag('gün içi #'+s.nth,'')+'<span class="sc '+cl(rn)+'" style="font-size:22px">'+(rn==null?'':sg(rn)+'R')+'</span><a class="btn tv" style="margin-left:8px" href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(s.base)+'USDT.P&interval=5" target="_blank">📈 TV</a></div>'+
  '<canvas id="cv"></canvas>'+
  '<div class="lv"><div><span>Anlık</span><b>'+fp(px)+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="zarar">'+fp(s.stop)+'</b></div><div><span>TP ('+s.tpR+'R)</span><b class="kar">'+fp(s.tp)+'</b></div><div><span>Anlık R</span><b class="'+cl(r)+'">'+sg(r)+'R</b></div><div><span>MFE / MAE</span><b>'+f2(s.mfe,2)+' / '+f2(s.mae,2)+'R</b></div><div><span>Risk</span><b>'+f2(s.riskPct)+'%</b></div><div><span>Maliyet</span><b>'+f2(s.costR)+'R</b></div>'+detailsOf(s)+'</div>'+
  calcBox(s.entry,s.stop)+'<div class="note">Sinyal 5m mum kapanışında üretildi (UTC saat '+s.hour+'). Grafikte sadece aktif işlemin stop ve TP çizgileri gösterilir.</div>'}
 else h+='<h2>'+nm+'</h2><div class="box"><div class="note" style="color:var(--tx);font-size:12px;margin:0">'+rulesOf(tab,I)+'</div></div>';
 var d=I.dg;
 h+='<div class="note">Son tarama: '+(I.last?ago(I.last)+' önce':'-')+' ('+f2((I.ms||0)/1000,1)+' sn) • kontrol edilen '+(I.scanned||0)+' coin • pencere '+(d&&d.on?'<b style="color:var(--lg)">açık</b>':'<b>kapalı</b>')+(d?' • aday '+d.cand+' • yeni sinyal '+d.sig:'')+(I.errMsg?' • hata: '+esc(I.errMsg):'')+'</div>';
 return h}

var BT=null,btDays=30,btN=40,btStrat='both';
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&strat='+btStrat),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 var op=function(v,l){return '<option value="'+v+'"'+(btStrat===v?' selected':'')+'>'+l+'</option>'};
 return '<h2>Backtest</h2><div class="box"><div class="note" style="color:var(--tx);font-size:12px;margin:0 0 8px">Seçilen stratejinin kurallarını geçmiş 5m/1H verisinde çalıştırır. Sadece kapanmış mumlar, giriş sinyal mumunun kapanışı, aynı mumda stop+TP birlikte görünürse STOP sayılır.</div><div class="frm"><label class="fl">Strateji<br><select onchange="btStrat=this.value">'+op('tz','Trapzone')+op('pfg','PFG')+op('both','İkisi')+'</select></label><label class="fl">Gün<br><select onchange="btDays=this.value">'+so([7,14,30,60],btDays)+'</select></label><label class="fl">Coin<br><select onchange="btN=this.value">'+so([20,40,60,100],btN)+'</select></label><button class="btn" onclick="btStart()">▶ Başlat</button></div></div><div id="btOut"></div>'}
function btBlock(name,r){
 if(!r||!r.n)return '<div class="box"><b>'+name+':</b> işlem çıkmadı (aday: '+(r?r.nAll:0)+').</div>';
 var col=r.level==='g'?'var(--lg)':r.level==='r'?'var(--st)':'var(--am)',g=r.g,a=r.gAll;
 var h='<h2 style="margin-top:18px">'+name+'</h2><div class="box" style="border-color:'+col+'"><b style="color:'+col+'">Değerlendirme</b><div class="note" style="color:var(--tx);font-size:12px">'+esc(r.verdict)+'</div></div>';
 h+='<div class="tiles"><div class="tile"><div class="k">İşlem (limitli)</div><div class="v">'+r.n+'</div></div><div class="tile"><div class="k">Aday (limitsiz)</div><div class="v">'+r.nAll+'</div></div><div class="tile"><div class="k">Win % (limitli)</div><div class="v">'+f2(g.win*100,0)+'</div></div><div class="tile"><div class="k">Ort R (limitli)</div><div class="v '+cl(g.avgR)+'">'+sg(g.avgR)+'</div></div><div class="tile"><div class="k">Toplam R (limitli)</div><div class="v '+cl(g.totalR)+'">'+sg(g.totalR,1)+'</div></div><div class="tile"><div class="k">Ort R (limitsiz)</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR)+'</div></div><div class="tile"><div class="k">PF (limitsiz)</div><div class="v">'+f2(a.pf)+'</div></div><div class="tile"><div class="k">Max DD (limitli)</div><div class="v">'+f2(g.dd,1)+'R</div></div><div class="tile"><div class="k">En kötü / iyi gün</div><div class="v" style="font-size:15px">'+sg(r.worstDay,1)+' / '+sg(r.bestDay,1)+'</div></div></div>';
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});
 return h}
function btOut(){var b=BT;if(!b)return '<div class="note">Yükleniyor…</div>';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="box"><b>Çalışıyor:</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') %'+pc+'</div>'}
 if(b.err)return '<div class="box zarar">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return '<div class="note">Henüz çalıştırılmadı.</div>';
 var h='<div class="note">'+r.coins+' coin • '+r.days+' gün • atlanan '+r.skipped+' • bitiş '+ago(b.finishedAt)+' önce</div>';
 if(r.tz)h+=btBlock('TRAPZONE',r.tz);
 if(r.pfg)h+=btBlock('PFG',r.pfg);
 return h}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.innerHTML=statView();return}
 if(tab==='bt'){if(!$('btOut'))M.innerHTML=btShell();$('btOut').innerHTML=btOut();return}
 M.innerHTML=sigMain();bindCalc();
 var s=selSig();if(s&&$('cv'))loadChart(s,false)}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}
function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){S=d;checkNew('tz');checkNew('pfg');$('dot').className='dot on';$('conn').textContent='Bağlı';renderAll()}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)renderMain()});
setInterval(poll,3000);setInterval(function(){if(tab==='bt')pollBT()},2000);setInterval(function(){var s=S&&(tab==='tz'||tab==='pfg')?selSig():null;if(s&&$('cv'))loadChart(s,true)},8000);poll();
</script></body></html>`;

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const authed = u => !!ADMIN_KEY && safeEq(u.searchParams.get('key') || '', ADMIN_KEY);
const uiOk = u => !UI_KEY || safeEq(u.searchParams.get('key') || '', UI_KEY);
const hits = new Map();
function rateOk(ip, max) { const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60e3); if (a.length >= max) { hits.set(ip, a); return false; } a.push(now); hits.set(ip, a); if (hits.size > 2000) hits.clear(); return true; }

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
        if (u.pathname === '/health') {
            const td = dayStart(Date.now());
            return json(res, 200, { ok: true, version: 'v34', tf: '5m', universe: universe.length,
                scan: { last: scan.last, ms: scan.ms, running: scan.running, list: diag.list, ok: diag.ok, short: diag.short, stale: diag.stale, err: diag.err, errMsg: diag.errMsg },
                trapzone: { cfg: { endH: TZ.END_H, tpR: TZ.TP_R, maxDay: TZ.MAX_DAY, minWAtr: TZ.MIN_W_ATR, maxWAtr: TZ.MAX_W_ATR, maxWickAtr: TZ.MAX_WICK_ATR, maxBreachBars: TZ.MAX_BREACH, expireH: TZ.EXPIRE_MS / H1, top: TZ.TOP, minVol: TZ.MIN_VOL },
                    diag: diag.tz, signals: tzSignals.length, today: tzSignals.filter(s => s.day === td).length, open: tzSignals.filter(s => s.status === 'OPEN').length },
                pfg: { cfg: { startH: PFG.START_H, endH: PFG.END_H, ma: PFG.MA_TYPE + PFG.MA_FAST + '/' + PFG.MA_SLOW, vwapN: PFG.VWAP_N, atrMult: PFG.ATR_MULT, tpR: PFG.TP_R, maxDay: PFG.MAX_DAY, maxPullBars: PFG.MAX_PULL, expireH: PFG.EXPIRE_MS / H1, top: PFG.TOP, minVol: PFG.MIN_VOL },
                    diag: diag.pfg, signals: pfgSignals.length, today: pfgSignals.filter(s => s.day === td).length, open: pfgSignals.filter(s => s.status === 'OPEN').length } });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            tzSignals = []; pfgSignals = []; dirty = true; saveState();
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
            const days = Math.min(60, Math.max(3, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            const st = u.searchParams.get('strat'), strat = st === 'tz' || st === 'pfg' ? st : 'both';
            runBacktestJob(days, n, strat);
            return json(res, 200, { ok: true, days, n, strat });
        }
        if (u.pathname === '/api/candles') {
            if (!rateOk(ip, 40)) return json(res, 429, { error: 'çok fazla istek' });
            return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || ''));
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); log('evren:', universe.length, 'coin');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(liveTick, 8000);
        setInterval(saveState, 15e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M5) - 1;     // açılışta bir kez hemen tara
        setInterval(async () => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M5);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; await runScan(); }
        }, 3000);
        log('SONER TRADE v34 • Trapzone + PFG • evren ' + universe.length + ' coin');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { tzScan, pfgScan, simulate, btSymbol, btReport, runBacktestJob, runScan, liveTick, apiState, makeSig, statsCalc, grp, groupBy,
    vwapSeries, smaSeries, atrSeries, TZ, PFG, CFG, getBt: () => bt, getTz: () => tzSignals, getPfg: () => pfgSignals };
