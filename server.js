'use strict';
// ============================================================
// AlphaSon v55 — TEK DOSYA (TAM)
// v55: LT üçgen motoru yeniden düzenlendi
//  - log-fiyat uzayında pivot/çizgi, yerel ATR toleransı
//  - gerçek dokunuş sayımı (çizgi başına >=3), bileşik skor, çizgi sürekliliği
//  - olgunluk / daralma / minimum yükseklik filtreleri
//  - tek tanımlı kırılım (kapanış teyidi + aşım + hacim) canlı ve backtestte aynı
//  - ölçülen hedef (TP2) gerçekten kullanılıyor, stop 2H ATR'ye de bakıyor
//  - backtest düzeltildi (volX hatası), canlı ile aynı yönetim kuralları
//  - 1h geçmiş önbelleği + sayfalama (650 bar gerçekten alınıyor), boşluk doldurma
//  - tarama event loop'u kilitlemiyor
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
    const dirOf = s => s >= 15 ? 'LONG' : s <= -15 ? 'SHORT' : 'NÖTR';
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
        const btcScore = Math.round(btc.score), ethScore = Math.round(eth.score);
        state = { dir, score: Math.round(sm), raw: Math.round(raw), regime, er: Number(er.toFixed(2)), vr: Number(vr.toFixed(2)), since, updated: now,
            btcDir: dirOf(btcScore), ethDir: dirOf(ethScore), btcScore, ethScore,
            btc: { score: btcScore }, eth: { score: ethScore },
            breadth: br ? { up: br.up, dn: br.dn, n: br.n, median: Number(br.median.toFixed(2)) } : null };
        return state;
    }
    function chg(sym) { const h = hist.get(sym); if (!h || h.length < 2) return null; const a = h[0], b = h[h.length - 1]; return b[0] - a[0] < 10 * 60e3 ? null : (b[1] / a[1] - 1) * 100; }
    return { tick, chg, get state() { return state; } };
}

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
    TRI_K: num('TRI_LT_K', 3),
    TRI_LOOK: num('TRI_LT_LOOK', 650),
    TRI_MIN_LEN: num('TRI_LT_MIN_LEN', 60),
    TRI_MAX_LEN: num('TRI_LT_MAX_LEN', 700),
    TRI_TOL_ATR: num('TRI_LT_TOL_ATR', 0.60),
    TRI_WICK_ATR: num('TRI_LT_WICK_ATR', 1.50),
    TRI_CLOSE_ATR: num('TRI_LT_CLOSE_ATR', 0.35),
    TRI_MIN_TOUCH: num('TRI_LT_MIN_TOUCH', 6),
    TRI_LINE_TOUCH: num('TRI_LT_LINE_TOUCH', 3),
    TRI_TOUCH_SEP: num('TRI_LT_TOUCH_SEP', 6),
    TRI_SQUEEZE: num('TRI_LT_SQUEEZE', 0.75),
    TRI_FLAT: num('TRI_LT_FLAT', 0.10),
    TRI_MIN_W0_ATR: num('TRI_LT_MIN_W0_ATR', 4),
    TRI_MIN_MAT: num('TRI_LT_MIN_MAT', 0.30),
    TRI_MAX_MAT: num('TRI_LT_MAX_MAT', 0.95),
    TRI_FRESH: num('TRI_LT_FRESH', 120),
    GRACE_MIN: num('TRI_LT_GRACE_MIN', 90)
};
const CFG = {
    UNIVERSE: num('UNIVERSE', 400),
    MIN_VOL_USDT: num('MIN_VOL', 3e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 7),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 3),
    UNIVERSE_MS: 5 * 60e3, KEEP: 500, SCAN_DELAY_MS: 8000,
    NEAR_ATR: num('NEAR_ATR', 1.2), BRK_SEE: num('BRK_SEE', 2.0),
    FRESH_ENTRY_MIN: num('FRESH_ENTRY_MIN', 10),
    STOP_ATR15: num('STOP_ATR15', 2.0), STOP_LINE_ATR2H: num('STOP_LINE_ATR2H', 0.5), STOP_MIN_PCT: num('STOP_MIN_PCT', 0.8),
    BRK_TP1_R: num('BRK_TP1_R', 1.0), BRK_TP2_R: num('BRK_TP2_R', 2.0), BRK_EXPIRE_H: num('BRK_EXPIRE_H', 24),
    BRK_COOLDOWN_H: num('BRK_COOLDOWN_H', 12),
    BRK_MIN_EXT: num('BRK_MIN_EXT', 0.25), BRK_MAX_EXT: num('BRK_MAX_EXT', 1.5),
    BRK_MIN_VOL: num('BRK_MIN_VOL', 1.3), BRK_CLOSE_CONFIRM: num('BRK_CLOSE_CONFIRM', 1),
    BRK_REG_FILTER: num('BRK_REG_FILTER', 0),
    BRK_LONG_MIN_STR: num('BRK_LONG_MIN_STR', 0),
    MIN_RR: num('MIN_RR', 1.5), MAX_TP2R: num('MAX_TP2R', 5),
    MIN_STRENGTH: num('MIN_STRENGTH', 35), MAX_COST_R: num('MAX_COST_R', 0.35),
    MIN_SIG_VOL: num('MIN_SIG_VOL', 3e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 8.0),
    TRAIL_R: num('TRAIL_R', 1.0),
    NEAR_WARN_VOL_X: num('NEAR_WARN_VOL_X', 0.7), NEAR_WARN_CD_MIN: num('NEAR_WARN_CD_MIN', 60),
    RAW_BREAK_MIN_ATR: num('RAW_BREAK_MIN_ATR', 0.05)
};
const TR = { ON: num('TR_ON', 1), MIN_VOL: num('TR_MIN_VOL', 5e6), TOP: num('TR_TOP', 400), NOTIFY: num('TR_NOTIFY', 50), MAX_COST_R: num('TR_MAX_COST_R', 0.35), MAX_OPEN: num('TR_MAX_OPEN', 25), KEEP: 300, TG: num('TR_TG', 1) };
const BIAS_TH = num('BIAS_TH', 15), BIAS_FILTER = num('TREND_BIAS_FILTER', 0);

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
            if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit') || msg.includes('Rate Limit')) {
                attempt++; const backoff = 2000 * Math.pow(2, attempt - 1);
                REQ_QUEUE.next = Math.max(REQ_QUEUE.next, Date.now() + backoff);
                log('RATE LIMIT → ' + backoff + 'ms bekle (' + sym + ' ' + tf + ')');
                await sleep(backoff);
            } else throw e;
        }
    }
    throw new Error('Rate limit: ' + sym + ' ' + tf);
}
let exUI = null;
async function uiFetch(sym, tf, limit) {
    if (!exUI) { exUI = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } }); try { exUI.setMarkets(ex.markets); } catch (e) { await exUI.loadMarkets(); } }
    try { return await exUI.fetchOHLCV(sym, tf, undefined, limit); }
    catch (e) { return await safeFetch(ex, sym, tf, limit); }
}
function aggregateN(c, baseMs, n) { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }
// küçük boşlukları düz mumla doldurur; büyük boşluktan önceki veriyi atar
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
// 1h geçmiş önbelleği: ilk seferde sayfalayarak tam derinlik, sonra sadece artımlı
const histCache = new Map();
async function getHist1h(sym, need) {
    const now = Date.now(); let h = histCache.get(sym);
    if (!h || !h.c.length) {
        let since = now - need * H1, out = [];
        for (let g = 0; g < 10; g++) {
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
function smaN(v, p) { const o = new Array(v.length).fill(null); let s0 = 0; while (s0 < v.length && v[s0] == null) s0++; for (let i = s0 + p - 1; i < v.length; i++) { let a = 0; for (let j = i - p + 1; j <= i; j++) a += v[j]; o[i] = a / p; } return o; }
function stdevN(v, p) { const o = new Array(v.length).fill(null); let s0 = 0; while (s0 < v.length && v[s0] == null) s0++; for (let i = s0 + p - 1; i < v.length; i++) { let a = 0; for (let j = i - p + 1; j <= i; j++) a += v[j]; a /= p; let q = 0; for (let j = i - p + 1; j <= i; j++) q += (v[j] - a) ** 2; o[i] = Math.sqrt(q / p); } return o; }
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }
function rsiSeries(cl, p) { const g = [null], l = [null]; for (let i = 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0); } const ag = rmaN(g, p), al = rmaN(l, p); return ag.map((x, i) => x == null || al[i] == null ? null : (al[i] === 0 ? 100 : 100 - 100 / (1 + x / al[i]))); }
function waveTrend(c) {
    const ap = c.map(x => (x[2] + x[3] + x[4]) / 3), esa = emaN(ap, 9);
    const ad = ap.map((x, i) => esa[i] == null ? null : Math.abs(x - esa[i])), d = emaN(ad, 9);
    const ci = ap.map((x, i) => (esa[i] == null || d[i] == null) ? null : (d[i] === 0 ? 0 : (x - esa[i]) / (0.015 * d[i])));
    const wt1 = emaN(ci, 12);
    return { wt1, wt2: smaN(wt1, 3) };
}
function cciSeries(c, p) { const tp = c.map(x => (x[2] + x[3] + x[4]) / 3), o = new Array(c.length).fill(null); for (let i = p - 1; i < c.length; i++) { let m = 0; for (let j = i - p + 1; j <= i; j++) m += tp[j]; m /= p; let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - m); md /= p; o[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md); } return o; }
function adxSeries(c, p) {
    const tr = [null], pdm = [null], mdm = [null];
    for (let i = 1; i < c.length; i++) { const up = c[i][2] - c[i - 1][2], dn = c[i - 1][3] - c[i][3]; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]))); }
    const st = rmaN(tr, p), sp = rmaN(pdm, p), sm = rmaN(mdm, p);
    const dx = st.map((x, i) => { if (x == null || !(x > 0) || sp[i] == null || sm[i] == null) return null; const a = 100 * sp[i] / x, b = 100 * sm[i] / x; return a + b === 0 ? 0 : 100 * Math.abs(a - b) / (a + b); });
    return rmaN(dx, p);
}
function qqeMod(cl) {
    const n = cl.length, rsi = rsiSeries(cl, 6), rsiMa = emaN(rsi, 5);
    const atrRsi = rsiMa.map((x, i) => (i > 0 && x != null && rsiMa[i - 1] != null) ? Math.abs(rsiMa[i - 1] - x) : null);
    const dar = emaN(emaN(atrRsi, 11), 11).map(x => x == null ? null : x * 3);
    const tl = new Array(n).fill(null); let lb = null, sb = null, trend = 1;
    for (let i = 1; i < n; i++) {
        if (rsiMa[i] == null || rsiMa[i - 1] == null || dar[i] == null) continue;
        const r = rsiMa[i], rp = rsiMa[i - 1], plb = lb == null ? 0 : lb, psb = sb == null ? 0 : sb;
        const nlb = (rp > plb && r > plb) ? Math.max(plb, r - dar[i]) : r - dar[i];
        const nsb = (rp < psb && r < psb) ? Math.min(psb, r + dar[i]) : r + dar[i];
        if (rp <= psb && r > psb) trend = 1; else if (rp >= plb && r < plb) trend = -1;
        lb = nlb; sb = nsb; tl[i] = trend === 1 ? lb : sb;
    }
    const x = tl.map(v => v == null ? null : v - 50), basis = smaN(x, 50), sd = stdevN(x, 50);
    const blue = new Array(n).fill(false), red = new Array(n).fill(false);
    for (let i = 0; i < n; i++) { if (rsiMa[i] == null || basis[i] == null) continue; const up = basis[i] + 0.35 * sd[i], lo = basis[i] - 0.35 * sd[i], v = rsiMa[i] - 50; if (v > 3 && v > up) blue[i] = true; else if (v < -3 && v < lo) red[i] = true; }
    return { blue, red };
}
function lorentzPred(F, y, t, K) {
    const ft = F[t]; if (!ft) return 0;
    let last = -1; const dist = [], pr = [];
    const start = Math.max(0, t - 200);
    for (let j = start; j <= t - 4; j++) {
        const fj = F[j]; if (!fj || y[j] == null) continue;
        let d = 0; for (let k = 0; k < 5; k++) d += Math.log(1 + Math.abs(ft[k] - fj[k]));
        if (d >= last && (j % 4) !== 0) { last = d; dist.push(d); pr.push(y[j]); if (pr.length > K) { last = dist[Math.round(K * 3 / 4)]; dist.shift(); pr.shift(); } }
    }
    let sum = 0; for (const v of pr) sum += v; return sum;
}

// ======================= ÜÇGEN (v55) =======================
// Tüm geometri log-fiyat uzayında yapılır; toleranslar yerel ATR (log) ile ölçülür.
function toLog(c, end) {
    const o = new Array(end + 1);
    for (let i = 0; i <= end; i++) { const x = c[i]; o[i] = [x[0], Math.log(x[1]), Math.log(x[2]), Math.log(x[3]), Math.log(x[4]), x[5]]; }
    return o;
}
function pivots(c, end, K, from) { const hi = [], lo = []; for (let i = Math.max(K, from); i <= end - K; i++) { let isH = true, isL = true; for (let d = 1; d <= K && (isH || isL); d++) { if (c[i][2] <= c[i - d][2] || c[i][2] < c[i + d][2]) isH = false; if (c[i][3] >= c[i - d][3] || c[i][3] > c[i + d][3]) isL = false; } if (isH) hi.push({ i, p: c[i][2] }); if (isL) lo.push({ i, p: c[i][3] }); } return { hi, lo }; }

// side=1 direnç (üst), side=-1 destek (alt). Pivotlar log uzayında.
function fitLine(pts, c, end, atrA, side, C, prevKey) {
    if (!pts || pts.length < 2) return null;
    const aEnd = atrA[end];
    let best = null;
    for (let a = 0; a < pts.length - 1; a++) {
        for (let b = a + 1; b < pts.length; b++) {
            const A = pts[a], B = pts[b], len = B.i - A.i;
            if (len < 15) continue;
            const s = (B.p - A.p) / len;
            // 1) pivotlar çizginin iç tarafında mı + gerçek dokunuş sayımı
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
            // 2) mumlar çizgiyi delmemeli (kapanış sıkı, fitil yumuşak)
            let cok = true;
            for (let x = A.i; x <= end; x++) {
                const lp = A.p + s * (x - A.i), at = atrA[x] || aEnd;
                if (side === 1) { if (c[x][4] > lp + C.TRI_CLOSE_ATR * at || c[x][2] > lp + C.TRI_WICK_ATR * at) { cok = false; break; } }
                else { if (c[x][4] < lp - C.TRI_CLOSE_ATR * at || c[x][3] < lp - C.TRI_WICK_ATR * at) { cok = false; break; } }
            }
            if (!cok) continue;
            // 3) bileşik skor: uzunluk (log) + dokunuş - sapma - bayatlık + süreklilik
            const dev = devSum / touches;
            let score = Math.log(len) * 40 + touches * 40 - dev * 15 - (end - lastT) * 0.3;
            if (prevKey) { if (prevKey[0] === c[A.i][0]) score += 40; if (prevKey[1] === c[B.i][0]) score += 40; }
            if (!best || score > best.score) best = { i0: A.i, p0: A.p, s, touches, last: lastT, score, dev, pts: inl, t0: c[A.i][0], t1: c[B.i][0] };
        }
    }
    return best;
}
function detectTriangle(c, end, C, prevKeys) {
    if (end < 60) return null;
    const lc = toLog(c, end);
    const atrA = atrSeries(lc, 14), atr = atrA[end]; if (!(atr > 0)) return null;
    const atrP = atrSeries(c.slice(0, end + 1), 14)[end]; if (!(atrP > 0)) return null;
    const pv = pivots(lc, end, C.TRI_K, Math.max(1, end - C.TRI_LOOK));
    if (pv.hi.length < 2 || pv.lo.length < 2) return null;
    const R = fitLine(pv.hi, lc, end, atrA, 1, C, prevKeys && prevKeys.R), S = fitLine(pv.lo, lc, end, atrA, -1, C, prevKeys && prevKeys.S);
    if (!R || !S) return null;
    if (R.touches + S.touches < C.TRI_MIN_TOUCH) return null;
    const xs = Math.max(R.i0, S.i0), len = end - xs;
    if (len < C.TRI_MIN_LEN || len > C.TRI_MAX_LEN) return null;
    const rv = x => R.p0 + R.s * (x - R.i0), sv = x => S.p0 + S.s * (x - S.i0);
    const w0 = rv(xs) - sv(xs), wN = rv(end) - sv(end);
    if (!(w0 > 0 && wN > 0)) return null;
    if (wN / w0 > C.TRI_SQUEEZE) return null;
    if (wN < 0.4 * atr) return null;
    if (w0 < C.TRI_MIN_W0_ATR * atr) return null;
    const dsl = S.s - R.s; if (!(dsl > 0)) return null;
    const apex = end + wN / dsl; if (apex - end > 300) return null;
    const mat = (end - xs) / (apex - xs);
    if (mat < C.TRI_MIN_MAT || mat > C.TRI_MAX_MAT) return null;
    const flatTol = C.TRI_FLAT * w0 / len;
    const rf = Math.abs(R.s) <= flatTol, sf = Math.abs(S.s) <= flatTol;
    let type = 'Simetrik';
    if (rf && S.s > flatTol) type = 'Yükselen';
    else if (sf && R.s < -flatTol) type = 'Alçalan';
    else if (R.s < -flatTol && S.s > flatTol) type = 'Simetrik';
    else if (R.s > flatTol && S.s > flatTol) type = 'Yükselen Kama';
    else if (R.s < -flatTol && S.s < -flatTol) type = 'Alçalan Kama';
    const w0p = Math.exp(rv(xs)) - Math.exp(sv(xs)); // fiyat cinsinden başlangıç yüksekliği
    return { type, end, atr: atrP, atrLog: atr, w0: w0p, w0Log: w0, wN, apex, len, R, S, touches: R.touches + S.touches, squeeze: wN / w0, mat, keys: { R: [R.t0, R.t1], S: [S.t0, S.t1] } };
}
function pack(tri, c, ms) {
    const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * (ms || TRI_MS);
    const xEnd = Math.min(tri.apex, tri.end + 15);
    const seg = L => [[tOf(L.i0), Math.exp(L.p0)], [tOf(xEnd), Math.exp(L.p0 + L.s * (xEnd - L.i0))]];
    return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), mat: Number(tri.mat.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0, res: seg(tri.R), sup: seg(tri.S), hi: tri.R.pts.map(p => [tOf(p.i), Math.exp(p.p)]), lo: tri.S.pts.map(p => [tOf(p.i), Math.exp(p.p)]) };
}

// ======================= CONFLUENCE =======================
const CF = (() => {
    const tf = ['15m', '1h', '4h'].includes(process.env.CF_TF) ? process.env.CF_TF : '15m';
    const m = { '15m': { ms: M15, win: 10, fresh: 10 }, '1h': { ms: H1, win: 45, fresh: 30 }, '4h': { ms: H4, win: 120, fresh: 60 } }[tf];
    return { ON: num('CF_ON', 0), TF: tf, MS: m.ms, WINDOW_MIN: num('CF_WINDOW_MIN', m.win), FRESH_MIN: num('CF_FRESH_MIN', m.fresh),
        DELAY_MS: num('CF_DELAY_S', 3) * 1000, MIN_PASS: num('CF_MIN_PASS', 4), MIN_VOL_X: num('CF_MIN_VOL_X', 0.7),
        K: num('CF_K', 15), BARS: num('CF_BARS', 600), KERNEL_FLIP: num('CF_KERNEL_FLIP', 3), ML_BARS: num('CF_ML_BARS', 6), QQE_BARS: num('CF_QQE_BARS', 2),
        WT_BARS: num('CF_WT_BARS', 5), PRIOR: num('CF_PRIOR', 3), STOP_BUF: num('CF_STOP_ATR', 0.2), MIN_RISK_PCT: num('CF_MIN_RISK_PCT', 0.5), MAX_RISK_PCT: num('CF_MAX_RISK_PCT', 8),
        TP1_R: num('CF_TP1_R', 1.5), TP2_R: num('CF_TP2_R', 3), MIN_SCORE: num('CF_MIN_SCORE', 60), MAX_PER_SCAN: num('CF_MAX_PER_SCAN', 4),
        COOLDOWN_H: num('CF_COOLDOWN_H', 8), MAX_HOLD: num('CF_MAX_HOLD_H', 48) * H1, OS: num('CF_OS_LEVEL', 53) };
})();
const FLOW = { ON: num('FLOW_ON', 1), TOP: num('FLOW_TOP', 50), MIN_VOL_USDT: num('FLOW_MIN_VOL', 5e6),
    MIN_PRICE_PCT: num('FLOW_MIN_PRICE_PCT', 0.35), MAX_PRICE_PCT: num('FLOW_MAX_PRICE_PCT', 2.5),
    MIN_OI_PCT: num('FLOW_MIN_OI_PCT', 0.35), MIN_VOL_X: num('FLOW_MIN_VOL_X', 1.5),
    COOLDOWN_MS: num('FLOW_COOLDOWN_MIN', 30) * M1, FRESH_MIN: num('FLOW_FRESH_MIN', 10),
    SCAN_MS: M5, MAX_PER_SCAN: num('FLOW_MAX_PER_SCAN', 8),
    STOP_ATR: num('FLOW_STOP_ATR', 2.5), SWING_BARS: num('FLOW_SWING_BARS', 12), SWING_BUF: num('FLOW_SWING_BUF', 0.3),
    MIN_RISK_PCT: num('FLOW_MIN_RISK_PCT', 1.2), MAX_RISK_PCT: num('FLOW_MAX_RISK_PCT', 4),
    TP1_R: num('FLOW_TP1_R', 1), TP2_R: num('FLOW_TP2_R', 2), MAX_HOLD: num('FLOW_MAX_HOLD_H', 4) * H1,
    MAX_COST_R: num('FLOW_MAX_COST_R', 0.6), RANGE_BARS: num('FLOW_RANGE_BARS', 24),
    WICK_BODY: num('FLOW_WICK_BODY', 0.5), RVOL: num('FLOW_RVOL', 2.0),
    ROOM_BARS: num('FLOW_ROOM_BARS', 100), ROOM_R: num('FLOW_ROOM_R', 2), CHASE_ATR: num('FLOW_CHASE_ATR', 0.5),
    REQ_WICK: num('FLOW_REQ_WICK', 1), REQ_RVOL: num('FLOW_REQ_RVOL', 1), REQ_OI: num('FLOW_REQ_OI', 1), REQ_LATE: num('FLOW_REQ_LATE', 1), REQ_ROOM: num('FLOW_REQ_ROOM', 1),
    SHADOW: num('FLOW_SHADOW', 1), SHADOW_MAX_OPEN: num('FLOW_SHADOW_MAX_OPEN', 60), SHADOW_KEEP: num('FLOW_SHADOW_KEEP', 400) };
const flowRun = { running: false, lastBar: 0, last: 0, ms: 0, supported: null, dg: null };
const TRI_OI = { ON: num('TRI_OI_ON', 1), MIN_PCT: num('TRI_OI_MIN', 0.3), FILTER: num('TRI_OI_FILTER', 0), REF_MIN: num('TRI_OI_REF_MIN', 30), SAMPLE_MS: num('TRI_OI_SAMPLE_MIN', 5) * M1 };
const triOiHist = new Map(), triOiStat = { filtered: 0 };
let flowShadow = [];
const flowOi = new Map();
const cfRun = { running: false, lastBar: 0, dg: null, last: 0, ms: 0, retryAt: 0, tryBar: 0, tries: 0 };
function mktBias() { return (REG && REG.score >= BIAS_TH) ? 'LONG' : (REG && REG.score <= -BIAS_TH) ? 'SHORT' : null; }

function cfEval(c, n, entry, vol24) {
    if (n < 250) return { skip: 'short' };
    const N = n + 1, cl = clOf(c);
    const rsi14 = rsiSeries(cl, 14), rsi9 = rsiSeries(cl, 9), wt = waveTrend(c), cci = cciSeries(c, 20), adx = adxSeries(c, 20);
    const F = new Array(N).fill(null), cp = v => Math.min(1, Math.max(0, v));
    for (let i = 0; i < N; i++) { if (rsi14[i] == null || rsi9[i] == null || wt.wt1[i] == null || cci[i] == null || adx[i] == null) continue; F[i] = [rsi14[i] / 100, cp((wt.wt1[i] + 100) / 200), cp((cci[i] + 200) / 400), cp(adx[i] / 100), rsi9[i] / 100]; }
    const y = cl.map((x, i) => i + 4 < N ? Math.sign(cl[i + 4] - x) : null);
    const trv = c.map((x, i) => i === 0 ? x[2] - x[3] : Math.max(x[2] - x[3], Math.abs(x[2] - c[i - 1][4]), Math.abs(x[3] - c[i - 1][4])));
    const atr10 = rmaN(trv, 10);
    const mlState = {}; let stt = 0;
    for (let t = Math.max(0, n - CF.ML_BARS - 6); t <= n; t++) { const pred = lorentzPred(F, y, t, CF.K), volOk = atr10[t] != null && trv[t] > atr10[t]; if (pred > 0 && volOk) stt = 1; else if (pred < 0 && volOk) stt = -1; mlState[t] = stt; }
    const W = 26, hh = 8, rr = 8, wts = []; for (let j = 0; j < W; j++) wts.push(Math.pow(1 + (j * j) / (2 * rr * hh * hh), -rr));
    const kv = {}, kFrom = Math.max(1, n - 60);
    for (let i = kFrom; i <= n; i++) { let a = 0, ws = 0; for (let j = 0; j < W && i - j >= 0; j++) { a += cl[i - j] * wts[j]; ws += wts[j]; } kv[i] = a / ws; }
    const qq = qqeMod(cl), atr14 = atrAt(c, n, 14); if (!(atr14 > 0)) return { skip: 'short' };
    let best = null;
    for (const L of [1, -1]) {
        const chk = {}, miss = []; let passes = 0, b = -1;
        for (let i = n; i > n - CF.KERNEL_FLIP && b < 0; i--) if (kv[i] != null && kv[i - 1] != null && kv[i - 2] != null && L * (kv[i] - kv[i - 1]) > 0 && L * (kv[i - 1] - kv[i - 2]) <= 0) b = i;
        const kOk = b >= 0 && kv[n] != null && kv[n - 1] != null && L * (kv[n] - kv[n - 1]) > 0;
        if (kOk) { passes++; chk.kernel = n - b; } else miss.push('kernel');
        let streak = 0; if (b >= 0) for (let i = b - 1; i > kFrom + 1 && kv[i] != null && kv[i - 1] != null && L * (kv[i] - kv[i - 1]) < 0; i--) streak++;
        if (kOk && streak >= CF.PRIOR) { passes++; chk.prior = streak; } else miss.push('prior');
        let mb = -1; for (let i = n; i > n - CF.ML_BARS && mb < 0; i--) if (mlState[i] === L && mlState[i - 1] !== L) mb = i;
        if (mb >= 0 && mlState[n] === L) { passes++; chk.ml = n - mb; } else miss.push('ml');
        const arr = L === 1 ? qq.blue : qq.red, opp = L === 1 ? qq.red : qq.blue;
        let qOk = false; for (let i = n; i > n - CF.QQE_BARS; i--) if (arr[i]) qOk = true;
        if (qOk && !opp[n]) { passes++; chk.qqe = true; } else miss.push('qqe');
        let wb = -1;
        for (let i = n; i > n - CF.WT_BARS && wb < 0; i--) { const a1 = wt.wt1[i], a0 = wt.wt1[i - 1], b1 = wt.wt2[i], b0 = wt.wt2[i - 1]; if (a1 == null || a0 == null || b1 == null || b0 == null) continue; if (L === 1 ? (a1 > b1 && a0 <= b0 && b1 < 0) : (a1 < b1 && a0 >= b0 && b1 > 0)) wb = i; }
        if (wb >= 0) { passes++; chk.wt = n - wb; chk.os = L === 1 ? wt.wt2[wb] <= -CF.OS : wt.wt2[wb] >= CF.OS; } else miss.push('wt');
        const rank = (kOk ? 100 : 0) + passes;
        if (!best || rank > best.rank) best = { rank, passes, L, chk, miss, b, streak, kOk };
    }
    if (!best.kOk) return { skip: 'eksik_kernel' };
    if (best.passes < CF.MIN_PASS) { const r = { skip: 'eksik_' + best.miss.join('+') }; if (best.passes === CF.MIN_PASS - 1) r.near = { dir: best.L === 1 ? 'LONG' : 'SHORT', passes: best.passes, miss: best.miss.join('+') }; return r; }
    const L = best.L, chk = best.chk;
    if (L * (entry - c[n][4]) > 0.5 * atr14) return { skip: 'chase' };
    let ext = L === 1 ? Infinity : -Infinity;
    for (let i = Math.max(0, best.b - 6); i <= n; i++) ext = L === 1 ? Math.min(ext, c[i][3]) : Math.max(ext, c[i][2]);
    const stop = ext - L * CF.STOP_BUF * atr14, riskAbs = L * (entry - stop);
    if (!(riskAbs > 0)) return { skip: 'risk' };
    const riskPct = riskAbs / entry * 100;
    if (riskPct < CF.MIN_RISK_PCT || riskPct > CF.MAX_RISK_PCT) return { skip: 'risk' };
    const costR = (costFor(vol24) + 2 * CFG.SLIP_PCT) / riskPct;
    if (costR > TR.MAX_COST_R) return { skip: 'cost' };
    let av = 0; for (let i = n - 20; i < n; i++) av += c[i][5]; av /= 20;
    const volX = av > 0 ? c[n][5] / av : 1;
    if (volX < CF.MIN_VOL_X) return { skip: 'volX' };
    const score = Math.round(Math.min(100, 40 + best.passes * 6 + (chk.os ? 10 : 0) + (chk.ml != null && chk.ml <= 2 ? 10 : 0) + (chk.wt != null && chk.wt <= 1 ? 5 : 0) + Math.min(10, best.streak) + Math.min(15, Math.max(0, volX - 1) * 8)));
    if (score < CF.MIN_SCORE) return { skip: 'score' };
    return { cand: { dir: L === 1 ? 'LONG' : 'SHORT', score, passes: best.passes, entry, stop, riskAbs, riskPct, costR, atr: atr14, volX, rsi: rsi14[n], checks: chk, candleT: c[n][0] } };
}
function buildCF(sym, cd, time) {
    const L = cd.dir === 'LONG' ? 1 : -1;
    return { id: 'CF_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT, symbol: sym, base: baseOf(sym), dir: cd.dir, strategy: 'CF',
        setup: 'CONFLUENCE', setupName: 'Confluence ' + CF.TF + ' (kernel + ML + QQE MOD + WaveTrend)',
        entry: cd.entry, stop: cd.stop, initialStop: cd.stop,
        tp1: cd.entry + L * cd.riskAbs * CF.TP1_R, tp2: cd.entry + L * cd.riskAbs * CF.TP2_R, tp1R: CF.TP1_R, tp2R: CF.TP2_R, trail: 0,
        riskAbs: cd.riskAbs, riskPct: r2(cd.riskPct), costR: r2(cd.costR), volX: r2(cd.volX), rsi: r2(cd.rsi), atr: cd.atr,
        score: cd.score, passes: cd.passes, checks: cd.checks, chartTf: CF.TF, reg: REG ? REG.regime : '-', aligned: mktBias() ? mktBias() === cd.dir : null,
        time, candleT: cd.candleT, freshMin: CF.FRESH_MIN, lastPrice: cd.entry, mfe: 0, mae: 0, maxHold: CF.MAX_HOLD, status: 'OPEN', trackedTo: cd.candleT };
}
function cfMsg(s) {
    const k = s.checks || {}, ok = [];
    if (k.kernel != null) ok.push('Kernel'); if (k.prior != null) ok.push('Ters hareket'); if (k.ml != null) ok.push('ML'); if (k.qqe) ok.push('QQE'); if (k.wt != null) ok.push('WaveTrend' + (k.os ? ' (aşırı bölge)' : ''));
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + '🧩 CONFLUENCE ' + CF.TF.toUpperCase() + ' ' + s.dir + ' ' + s.base + ' — PUAN %' + s.score + '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' + '\nTP1 ' + fmt(s.tp1) + ' (' + s.tp1R + 'R) | TP2 ' + fmt(s.tp2) + ' (' + s.tp2R + 'R)' + '\n✓ ' + ok.join(' ✓ ') + ' (' + (s.passes || ok.length) + '/5)' + '\nHacim ' + s.volX.toFixed(1) + 'x' + (s.aligned === true ? '\nPiyasa yönü uyumlu' : s.aligned === false ? '\nPiyasa yönü TERS' : '') + '\n⏱ ' + CF.FRESH_MIN + ' dk içinde gir\n📈 ' + tvLink(s.base, CF.TF === '4h' ? 240 : CF.TF === '1h' ? 60 : 15);
}
function flowMsg(s) {
    return (s.dir === 'LONG' ? '🟢' : '🔴') + ' ⚡ MOMENTUM FLOW ' + s.dir + ' ' + s.base + ' (kapanışlı kırılım)' + '\nGiriş: ' + fmt(s.entry) + (s.level != null ? ' (kırılan seviye ' + fmt(s.level) + ')' : '') + '\nStop: ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' + '\nTP1: ' + fmt(s.tp1) + ' (' + s.tp1R + 'R) | TP2: ' + fmt(s.tp2) + ' (' + s.tp2R + 'R)' + '\nFitil/gövde: ' + s.wickR + ' | Hacim: ' + s.volX + 'x | OI: ' + (s.oiPct > 0 ? '+' : '') + s.oiPct + '% | Boşluk: ' + (s.roomR >= 99 ? 'açık' : s.roomR + 'R') + '\nSinyal puanı: ' + s.score + '/100 (olasılık değildir)' + (s.aligned === true ? '\nPiyasa yönü uyumlu' : s.aligned === false ? '\nPiyasa yönü TERS' : '') + '\n⏱ ' + FLOW.FRESH_MIN + ' dk içinde gir, sonrası eski sayılır' + '\n📈 ' + tvLink(s.base, 5);
}
async function fetchOiValue(sym) {
    if (ex.has && ex.has.fetchOpenInterest === false) return null;
    if (typeof ex.fetchOpenInterest !== 'function') return null;
    await throttle();
    const r = await ex.fetchOpenInterest(sym);
    const info = r && r.info || {};
    const vals = [r && r.openInterestAmount, r && r.openInterest, info.openInterest, info.openInterestAmount, info.total, info.size];
    for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    return null;
}
async function runFlow(force) {
    if (!FLOW.ON || flowRun.running || !universe.length || !Object.keys(tickers).length) return;
    const now = Date.now(), bar = Math.floor(now / FLOW.SCAN_MS) * FLOW.SCAN_MS;
    if (!force && (flowRun.lastBar === bar || now - bar < 2500)) return;
    flowRun.running = true; const t0 = Date.now();
    try {
        if (ex.has && ex.has.fetchOpenInterest === false) { flowRun.supported = false; flowRun.dg = { error: 'Bu CCXT/Bitget sürümünde fetchOpenInterest desteklenmiyor.' }; flowRun.lastBar = bar; return; }
        const list = universe.filter(sym => ((tickers[sym] || {}).quoteVolume || 0) >= FLOW.MIN_VOL_USDT).slice(0, FLOW.TOP);
        const NEED = Math.max(FLOW.ROOM_BARS, FLOW.RANGE_BARS) + 30;
        const candidates = [];
        const dg = { list: list.length, checked: 0, oiMissing: 0, baseline: 0, signal: 0, shadow: 0, skipped: {}, errors: 0, t: now, funnel: { brk: 0, plan: 0, wick: 0, rvol: 0, oi: 0, late: 0, room: 0, signal: 0 }, single: { wick: 0, rvol: 0, oi: 0, late: 0, room: 0 } };
        const sk = k => { dg.skipped[k] = (dg.skipped[k] || 0) + 1; };
        let idx = 0;
        const worker = async () => {
            while (idx < list.length) {
                const sym = list[idx++];
                try {
                    const [raw, oi] = await Promise.all([safeFetch(ex, sym, '5m', NEED), fetchOiValue(sym)]);
                    if (!(oi > 0)) { dg.oiMissing++; continue; }
                    const c = closedOnly(raw, M5, now);
                    if (c.length < Math.max(FLOW.ROOM_BARS, FLOW.RANGE_BARS) + 5 || hasGap(c, M5, FLOW.RANGE_BARS + 22) || c[c.length - 1][0] !== bar - M5) { sk('candle'); continue; }
                    dg.checked++;
                    const hist = flowOi.get(sym) || []; const last = hist.length ? hist[hist.length - 1] : null;
                    hist.push({ t: now, oi }); while (hist.length > 6 || (hist.length && now - hist[0].t > 40 * M1)) hist.shift(); flowOi.set(sym, hist);
                    if (!last || now - last.t < 4 * M1) { dg.baseline++; continue; }
                    const ref = hist.slice().reverse().find(x => now - x.t >= 4 * M1 && now - x.t <= 12 * M1) || hist[0];
                    if (!ref || ref.oi <= 0 || now - ref.t < 4 * M1) { dg.baseline++; continue; }
                    const oiPct = (oi / ref.oi - 1) * 100;
                    const n = c.length - 1, nw = c[n];
                    const rg = c.slice(n - FLOW.RANGE_BARS, n);
                    const rHi = Math.max(...rg.map(x => x[2])), rLo = Math.min(...rg.map(x => x[3]));
                    let dir = null, level = null;
                    if (nw[4] > rHi) { dir = 'LONG'; level = rHi; } else if (nw[4] < rLo) { dir = 'SHORT'; level = rLo; }
                    if (!dir) { sk('noBreak'); continue; }
                    dg.funnel.brk++;
                    const atr5 = atrMean(c, 14);
                    const vols = c.slice(-21, -1).map(x => x[5]);
                    const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
                    const volX = avgVol > 0 ? nw[5] / avgVol : 0;
                    const body = Math.abs(nw[4] - nw[1]);
                    const wick = dir === 'LONG' ? nw[2] - Math.max(nw[1], nw[4]) : Math.min(nw[1], nw[4]) - nw[3];
                    const wickR = body > 0 ? Math.min(99, wick / body) : (wick > 0 ? 99 : 0);
                    const pricePct = (nw[4] / c[n - 3][4] - 1) * 100;
                    const win = c.slice(n - FLOW.ROOM_BARS, n);
                    const resist = dir === 'LONG' ? Math.max(...win.map(x => x[2])) : Math.min(...win.map(x => x[3]));
                    const sw = c.slice(-FLOW.SWING_BARS);
                    const swingLo = Math.min(...sw.map(x => x[3])), swingHi = Math.max(...sw.map(x => x[2]));
                    candidates.push({ sym, dir, level, price: nw[4], time: now, candleT: nw[0], pricePct, oiPct, volX, wickR, resist, atr5, swingLo, swingHi, refOiTime: ref.t });
                } catch (e) { dg.errors++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 100); if (/not supported|does not have|not available/i.test(String(e.message)) && /open.?interest/i.test(String(e.message))) { flowRun.supported = false; dg.error = 'OI desteklenmiyor'; idx = list.length; } }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CFG.CONCURRENCY, 3) }, worker));
        candidates.sort((a, b) => b.volX - a.volX);
        const REQ = { wick: FLOW.REQ_WICK, rvol: FLOW.REQ_RVOL, oi: FLOW.REQ_OI, late: FLOW.REQ_LATE, room: FLOW.REQ_ROOM };
        const mk = (cd, entry, riskAbs, riskPct, costR, roomR, f, score, shadow, fails) => {
            const L = cd.dir === 'LONG' ? 1 : -1, stop = entry - L * riskAbs, bias = mktBias();
            return { id: (shadow ? 'FLOWSH_' : 'FLOW_') + cd.sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT,
                symbol: cd.sym, base: baseOf(cd.sym), dir: cd.dir, strategy: 'FLOW', shadow: !!shadow, fails: fails || [],
                setup: 'FLOW_BREAK', setupName: 'Flow kırılım', entry, stop, initialStop: stop, level: cd.level,
                tp1: entry + L * riskAbs * FLOW.TP1_R, tp2: entry + L * riskAbs * FLOW.TP2_R, tp1R: FLOW.TP1_R, tp2R: FLOW.TP2_R, trail: 0,
                riskAbs, riskPct: r2(riskPct), costR: r2(costR), atr: cd.atr5, planV: 3, lastPrice: entry, mfe: 0, mae: 0, maxHold: FLOW.MAX_HOLD, trackedTo: cd.time,
                signalClose: cd.price, time: cd.time, candleT: cd.candleT, chartTf: '5m', freshMin: FLOW.FRESH_MIN,
                reg: REG ? REG.regime : '-', aligned: bias ? bias === cd.dir : null,
                pricePct: r2(cd.pricePct), oiPct: r2(cd.oiPct), volX: r2(cd.volX), wickR: r2(cd.wickR), roomR: r2(roomR), flags: f, score, status: 'OPEN' };
        };
        let added = 0, openN = trendSignals.filter(isOpen).length, shOpen = flowShadow.filter(isOpen).length;
        for (const cd of candidates) {
            const tk = tickers[cd.sym] || {};
            const L = cd.dir === 'LONG' ? 1 : -1;
            const entry = tk.last || cd.price;
            if (!(entry > 0) || !(cd.atr5 > 0)) { sk('plan'); continue; }
            if (L * (entry - cd.level) / cd.atr5 > FLOW.CHASE_ATR) { sk('chase'); continue; }
            const structDist = L === 1 ? entry - cd.swingLo : cd.swingHi - entry;
            const riskAbs = Math.max(FLOW.STOP_ATR * cd.atr5, entry * FLOW.MIN_RISK_PCT / 100, structDist + FLOW.SWING_BUF * cd.atr5);
            const riskPct = riskAbs / entry * 100;
            if (riskPct > FLOW.MAX_RISK_PCT) { sk('risk'); continue; }
            const costR = (costFor(tk.quoteVolume) + 2 * CFG.SLIP_PCT) / riskPct;
            if (costR > FLOW.MAX_COST_R) { sk('cost'); continue; }
            dg.funnel.plan++;
            const roomR = L === 1 ? (cd.resist > entry ? (cd.resist - entry) / riskAbs : 99) : (cd.resist < entry ? (entry - cd.resist) / riskAbs : 99);
            const f = { wick: cd.wickR <= FLOW.WICK_BODY, rvol: cd.volX >= FLOW.RVOL, oi: cd.oiPct >= FLOW.MIN_OI_PCT, late: Math.abs(cd.pricePct) <= FLOW.MAX_PRICE_PCT && Math.abs(cd.pricePct) >= FLOW.MIN_PRICE_PCT, room: roomR >= FLOW.ROOM_R };
            let alive = true;
            for (const k of ['wick', 'rvol', 'oi', 'late', 'room']) { if (f[k]) dg.single[k]++; if (alive) { if (f[k]) dg.funnel[k]++; else alive = false; } }
            const fails = Object.keys(REQ).filter(k => REQ[k] && !f[k]);
            const score = Math.round(Math.min(100, 40 + Math.min(20, Math.max(0, cd.volX - 1) * 8) + Math.min(15, Math.max(0, cd.oiPct) * 10) + (f.wick ? 10 : 0) + (f.room ? 10 : 0) + (f.rvol ? 5 : 0)));
            if (fails.length) {
                if (!FLOW.SHADOW) { sk('filtered'); continue; }
                const shk = 'FLOWSH|' + cd.sym;
                if (now - (lastSig[shk] || 0) < FLOW.COOLDOWN_MS) { sk('shCooldown'); continue; }
                if (shOpen >= FLOW.SHADOW_MAX_OPEN) { sk('shCap'); continue; }
                if (flowShadow.some(x => x.symbol === cd.sym && isOpen(x))) { sk('shOpen'); continue; }
                flowShadow.unshift(mk(cd, entry, riskAbs, riskPct, costR, roomR, f, score, true, fails));
                if (flowShadow.length > FLOW.SHADOW_KEEP) flowShadow.length = FLOW.SHADOW_KEEP;
                lastSig[shk] = now; dirty = true; shOpen++; dg.shadow++;
                continue;
            }
            if (added >= FLOW.MAX_PER_SCAN) { sk('perScan'); continue; }
            if (openN >= TR.MAX_OPEN) { sk('cap'); continue; }
            const lk = 'FLOW|' + cd.sym;
            if (now - (lastSig[lk] || 0) < FLOW.COOLDOWN_MS) { sk('cooldown'); continue; }
            if (trendSignals.some(x => x.strategy === 'FLOW' && x.symbol === cd.sym && isOpen(x))) { sk('open'); continue; }
            const sig = mk(cd, entry, riskAbs, riskPct, costR, roomR, f, score, false, []);
            trendSignals.unshift(sig);
            if (trendSignals.length > TR.KEEP) trendSignals.length = TR.KEEP;
            lastSig[lk] = now; dirty = true; added++; openN++; dg.signal++; dg.funnel.signal++;
            log('FLOW', sig.dir, sig.base, 'puan', sig.score, 'kırılım', fmt(sig.level), 'fitil', sig.wickR, 'OI', sig.oiPct + '%', 'hacim', sig.volX + 'x', 'boşluk', sig.roomR >= 99 ? 'açık' : sig.roomR + 'R', 'stop', fmt(sig.stop), 'risk %' + sig.riskPct);
            if (TR.TG && sig.score >= TR.NOTIFY) telegram(flowMsg(sig));
        }
        if (flowRun.supported !== false) flowRun.supported = true;
        flowRun.dg = dg; flowRun.lastBar = bar;
        log('FLOW tarama:', 'liste', dg.list, 'kontrol', dg.checked, 'kırılım', dg.funnel.brk, 'plan', dg.funnel.plan, 'sinyal', dg.signal, 'gölge', dg.shadow, 'elenen', JSON.stringify(dg.skipped), 'hata', dg.errors);
    } catch (e) { flowRun.dg = { error: String(e.message || e) }; log('FLOW hata', e.message); }
    finally { flowRun.last = Date.now(); flowRun.ms = flowRun.last - t0; flowRun.running = false; }
}
async function runConfluence(force) {
    if (!CF.ON || !TR.ON || cfRun.running || !universe.length || !Object.keys(tickers).length) return;
    const t0 = Date.now(), bar = Math.floor(t0 / CF.MS) * CF.MS, first = cfRun.lastBar === 0;
    if (!force) { if (cfRun.lastBar === bar || t0 - bar < CF.DELAY_MS || t0 < cfRun.retryAt) return; if (!first && t0 - bar > CF.WINDOW_MIN * 60e3) return; }
    cfRun.running = true;
    try {
        const list = universe.filter(s => isMajor(s) || ((tickers[s] || {}).quoteVolume || 0) >= TR.MIN_VOL).slice(0, TR.TOP);
        let idx = 0; const cands = [], near = [], want = bar - CF.MS;
        const dg = { list: list.length, ok: 0, short: 0, stale: 0, gap: 0, cand: 0, sig: 0, err: 0, errMsg: '', t: t0, bar, skip: {}, near: [] };
        const worker = async () => {
            while (idx < list.length) {
                const sym = list[idx++];
                try {
                    const c = closedOnly(await safeFetch(ex, sym, CF.TF, CF.BARS), CF.MS, t0);
                    if (c.length < 260) { dg.short++; continue; }
                    const n = c.length - 1;
                    if (c[n][0] !== want) { dg.stale++; continue; }
                    if (hasGap(c, CF.MS, 80)) { dg.gap++; continue; }
                    dg.ok++;
                    const tk = tickers[sym] || {}, entry = tk.last || c[n][4];
                    const r = cfEval(c, n, entry, tk.quoteVolume);
                    if (!r.cand) { dg.skip[r.skip] = (dg.skip[r.skip] || 0) + 1; if (r.near) near.push(Object.assign({ b: baseOf(sym) }, r.near)); continue; }
                    dg.cand++; cands.push(Object.assign({ sym }, r.cand));
                } catch (e) { dg.err++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 120); }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        cands.sort((a, b) => b.score - a.score);
        let openN = trendSignals.filter(isOpen).length, added = 0;
        for (const cd of cands) {
            if (added >= CF.MAX_PER_SCAN || openN >= TR.MAX_OPEN) { dg.skip.cap = (dg.skip.cap || 0) + 1; continue; }
            const lk = 'CF|' + cd.sym + '|' + cd.dir;
            if (BIAS_FILTER && mktBias() && mktBias() !== cd.dir) { dg.skip.bias = (dg.skip.bias || 0) + 1; continue; }
            if (t0 - (lastSig[lk] || 0) < CF.COOLDOWN_H * H1) { dg.skip.cool = (dg.skip.cool || 0) + 1; continue; }
            if (trendSignals.some(x => x.symbol === cd.sym && isOpen(x))) { dg.skip.open = (dg.skip.open || 0) + 1; continue; }
            const sig = buildCF(cd.sym, cd, cd.candleT + CF.MS);
            if (trendSignals.some(x => x.id === sig.id)) { dg.skip.dup = (dg.skip.dup || 0) + 1; continue; }
            trendSignals.unshift(sig);
            if (trendSignals.length > TR.KEEP) trendSignals.length = TR.KEEP;
            lastSig[lk] = t0; dirty = true; added++; openN++; dg.sig++;
            log('CONFLUENCE', cd.dir, sig.base, 'puan', sig.score, cd.passes + '/5', 'risk %' + sig.riskPct, 'hacim', cd.volX.toFixed(1) + 'x');
            if (TR.TG && sig.score >= TR.NOTIFY && t0 - sig.time <= CF.FRESH_MIN * 60e3) telegram(cfMsg(sig));
        }
        near.sort((a, b) => b.passes - a.passes); dg.near = near.slice(0, 8); cfRun.dg = dg;
        if (cfRun.tryBar !== bar) { cfRun.tryBar = bar; cfRun.tries = 0; } cfRun.tries++;
        const enough = dg.ok >= list.length * 0.5 && dg.stale <= list.length * 0.3;
        if (enough || cfRun.tries >= 3) cfRun.lastBar = bar; else cfRun.retryAt = Date.now() + 30e3;
        log('CONFLUENCE tarama: liste', dg.list, 'kontrol', dg.ok, 'bayat', dg.stale, 'aday', dg.cand, 'sinyal', dg.sig, 'elenen', JSON.stringify(dg.skip), 'hata', dg.err);
    } catch (e) { log('CONFLUENCE hata', e.message); cfRun.retryAt = Date.now() + 30e3; }
    cfRun.last = Date.now(); cfRun.ms = cfRun.last - t0; cfRun.running = false;
}

// ======================= DURUM =======================
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0, drop: { excluded: 0, lowVol: 0, suspect: 0 } }, dirty = false, lastScanSlot = 0;
const candleCache = new Map();
let triRadar = [], liveRunning = false, tgTimes = [];
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const structLT = {}, volCache = new Map();
const brokeAt = {}; let firstScanAt = 0;
const regime = createRegime(); let REG = null;
let trendSignals = [], brkEvents = [];

// ======================= STATE =======================
function loadState() {
    try { const b = JSON.parse(fs.readFileSync(BT_FILE, 'utf8')); if (b && b.result) { b.running = false; bt = b; } } catch (e) { }
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        signals = (j.signals || []).filter(s => s && s.id && s.entry);
        const rawTr = (j.tr || []).filter(s => s && s.id && s.entry);
        trendSignals = rawTr.filter(s => s.strategy === 'FLOW' || s.strategy === 'CF');
        if (rawTr.length !== trendSignals.length) { log('uyumsuz trend kayıtları ayrıldı:', rawTr.length - trendSignals.length); dirty = true; }
        for (const s of trendSignals) if (s.strategy === 'FLOW' && !s.riskAbs && isOpen(s)) { s.status = 'EXPIRED'; dirty = true; }
        brkEvents = (j.brk || []).filter(s => s && s.id);
        flowShadow = (j.sh || []).filter(s => s && s.id && s.entry);
        lastSig = j.lastSig || {};
        log('durum:', signals.length, 'arşiv,', trendSignals.length, 'trend,', brkEvents.length, 'kırılım');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        const cut = Date.now() - 24 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ signals: signals.slice(0, CFG.KEEP), lastSig, tr: trendSignals.slice(0, TR.KEEP), brk: brkEvents.slice(0, 200), sh: flowShadow.slice(0, FLOW.SHADOW_KEEP) }));
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
        const c1h = fillGaps(await getHist1h(sym, need), H1);
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
        for (const list of [signals, trendSignals, brkEvents]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}

// ======================= KIRILIM =======================
const TYPE_BIAS = { 'Yükselen': 1, 'Alçalan': -1, 'Yükselen Kama': -1, 'Alçalan Kama': 1, 'Simetrik': 0 };
const typeBias = (type, dir) => (TYPE_BIAS[type] || 0) * (dir === 'LONG' ? 1 : -1) * 8;
function calculateStrength(tri, vol, ext, q, dir, rs) {
    let s = Math.min(25, Math.max(0, (tri.touches - 5) * 6));
    s += Math.round(Math.max(0, CFG_LT.TRI_SQUEEZE - tri.squeeze) / CFG_LT.TRI_SQUEEZE * 20);
    s += vol >= 2.5 ? 25 : vol >= 1.8 ? 20 : vol >= 1.3 ? 14 : 6;
    s += q >= 0.85 ? 15 : q >= 0.7 ? 10 : 5;
    s += ext <= 0.3 ? 15 : ext <= 0.5 ? 8 : 3;
    s += typeBias(tri.type, dir);
    if (rs != null) { const x = (dir === 'LONG' ? 1 : -1) * rs; s += x > 0.3 ? 5 : x < -0.3 ? -5 : 0; }
    return Math.max(0, Math.min(100, Math.round(s)));
}
const strLabel = s => s >= 75 ? 'ÇOK GÜÇLÜ' : s >= 55 ? 'GÜÇLÜ' : s >= 35 ? 'ORTA' : 'ZAYIF';
function brkMsg(e) {
    return '🐢 UZUN VADE ÜÇGEN KIRILIM ' + (e.dir === 'LONG' ? '🟢 ' : '🔴 ') + e.dir + ' ' + e.base + ' — ' + e.type + ' üçgen ' + (e.dir === 'LONG' ? 'yukarı' : 'aşağı') + '\nGüç %' + e.strength + ' ' + strLabel(e.strength) + ' | Hacim ' + e.volX.toFixed(1) + 'x | Piyasa: ' + e.reg + '\nGiriş ' + fmt(e.entry) + ' | Stop ' + fmt(e.stop) + ' | TP1 ' + fmt(e.tp1) + ' | TP2 ' + fmt(e.tp2) + (e.costR != null ? '\nRisk %' + e.riskPct.toFixed(2) + ' | Maliyet ' + e.costR.toFixed(2) + 'R' : '') + '\nBüyük simetrik üçgen kırıldı — daha büyük hareketler başlatabilir.' + '\n⏱ ' + CFG.FRESH_ENTRY_MIN + ' dk içinde gir, sonrası eski sayılır' + '\n📈 ' + tvLink(e.base, TRI_TF === '2h' ? 120 : 15);
}
function buildStruct(S, t0, ms, C, prev) {
    const o = { t: t0, lines: [] };
    if (S.c2 && S.c2.length >= 60) {
        const tri = detectTriangle(S.c2, S.c2.length - 1, C || CFG_LT, prev && prev.keys);
        if (tri) {
            const pk = pack(tri, S.c2, ms);
            o.tri = pk; o.squeeze = tri.squeeze; o.touches = tri.touches; o.type = tri.type; o.w0 = tri.w0; o.mat = tri.mat; o.keys = tri.keys;
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
        const d = { volX, projX, el, bk, pv, avg15: avg, bkVolX: avgP > 0 && bk ? bk[5] / avgP : 0, atr15: n > 15 ? atrMean(closed, 14) : 0 };
        volCache.set(sym, { t: now, d }); return d;
    } catch (e) { const d = { volX: 0, projX: 0, el: 0, bk: null, pv: null, avg15: 0, bkVolX: 0, atr15: 0 }; volCache.set(sym, { t: now, d }); return d; }
}
// çizgi değeri log uzayında interpolasyon/ekstrapolasyon
function lineValues(st, now) { const out = {}; for (const L of st.lines) { const a = L.seg[0], b = L.seg[1], dt = b[0] - a[0], la = Math.log(a[1]), lb = Math.log(b[1]); out[L.key] = dt ? Math.exp(la + (lb - la) * (now - a[0]) / dt) : a[1]; } return out; }
async function triOiSample(sym) {
    if (!TRI_OI.ON) return null;
    try {
        const now = Date.now(), h = triOiHist.get(sym) || [];
        if (h.length && now - h[h.length - 1].t < TRI_OI.SAMPLE_MS) return h[h.length - 1].v;
        const oi = await fetchOiValue(sym);
        if (oi > 0) { h.push({ t: now, v: oi }); while (h.length > 30) h.shift(); triOiHist.set(sym, h); }
        return oi;
    } catch (e) { return null; }
}
function triOiPct(sym) {
    const h = triOiHist.get(sym); if (!h || h.length < 2) return null;
    const now = Date.now(), refT = now - TRI_OI.REF_MIN * 60e3;
    const ref = h.slice().reverse().find(x => x.t <= refT) || h[0];
    if (!ref || !(ref.v > 0) || ref.t === h[h.length - 1].t) return null;
    return (h[h.length - 1].v / ref.v - 1) * 100;
}
// v55: stop = çizgiden en uzak olan (2H ATR, 15m ATR, yüzde); hedef = ölçülen hareket (tavanlı)
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
    const tp2R = Math.min(rawR, CFG.MAX_TP2R);
    return { stop, riskPct, tp1R: CFG.BRK_TP1_R, tp2R, line };
}
function virtualPlan(L, lineP, atr2h, v) {
    const a15 = v && v.atr15 > 0 ? v.atr15 : atr2h * 0.5;
    const c = [lineP - L * CFG.STOP_ATR15 * a15, lineP - L * CFG.STOP_LINE_ATR2H * atr2h, lineP - L * lineP * CFG.STOP_MIN_PCT / 100];
    const stop = L === 1 ? Math.min(...c) : Math.max(...c);
    const risk = L * (lineP - stop); if (!(risk > 0)) return null;
    return { entry: lineP, stop, riskAbs: risk, riskPct: r2(risk / lineP * 100), tp1: lineP + L * risk * CFG.BRK_TP1_R, tp2: lineP + L * risk * CFG.BRK_TP2_R };
}
function rsOf(sym) { const a = regime.chg(sym), b = regime.chg(BTC); return a == null || b == null ? null : a - b; }

// ======================= TREND TAKİP =======================
function trTrack(now) {
    for (const s of trendSignals) {
        if (!isOpen(s) || !s.riskAbs) continue;
        const t = tickers[s.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = s.dir === 'LONG' ? 1 : -1;
        s.lastPrice = P; let res = null;
        const r = L * (P - s.entry) / s.riskAbs;
        s.mfe = Math.max(s.mfe || 0, r); s.mae = Math.min(s.mae || 0, r);
        if (s.status === 'OPEN') { if (L * (P - s.stop) <= 0) { s.status = 'STOP'; res = -1; } else if (r >= s.tp1R) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = now; dirty = true; } }
        else if (s.status === 'TP1') { if (L * (P - s.stop) <= 0) { s.status = 'BE'; res = 0.5 * s.tp1R + 0.5 * r; } else if (r >= s.tp2R) { s.status = 'TP2'; res = 0.5 * s.tp1R + 0.5 * s.tp2R; } }
        if (res == null && isOpen(s) && now - s.time > s.maxHold) { res = s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r; s.status = 'SÜRE'; }
        if (res != null) { s.closedAt = now; s.exitPrice = P; s.grossR = r2(res); s.netR = r2(res - (s.costR || 0)); dirty = true; }
    }
    for (const sh of flowShadow) {
        if (!isOpen(sh) || !sh.riskAbs) continue;
        const t = tickers[sh.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = sh.dir === 'LONG' ? 1 : -1;
        sh.lastPrice = P; let res = null;
        const r = L * (P - sh.entry) / sh.riskAbs;
        sh.mfe = Math.max(sh.mfe || 0, r); sh.mae = Math.min(sh.mae || 0, r);
        if (sh.status === 'OPEN') { if (L * (P - sh.stop) <= 0) { sh.status = 'STOP'; res = -1; } else if (r >= sh.tp1R) { sh.status = 'TP1'; sh.stop = sh.entry; sh.tp1At = now; } }
        else if (sh.status === 'TP1') { if (L * (P - sh.stop) <= 0) { sh.status = 'BE'; res = 0.5 * sh.tp1R + 0.5 * r; } else if (r >= sh.tp2R) { sh.status = 'TP2'; res = 0.5 * sh.tp1R + 0.5 * sh.tp2R; } }
        if (res == null && isOpen(sh) && now - sh.time > sh.maxHold) { res = sh.status === 'TP1' ? 0.5 * sh.tp1R + 0.5 * r : r; sh.status = 'SÜRE'; }
        if (res != null) { sh.closedAt = now; sh.exitPrice = P; sh.grossR = r2(res); sh.netR = r2(res - (sh.costR || 0)); dirty = true; }
    }
}

// ======================= İSTATİSTİK =======================
const trBucket = s => s.score == null ? 'puan yok' : s.score >= 80 ? 'Puan 80+' : s.score >= 70 ? 'Puan 70-79' : s.score >= 60 ? 'Puan 60-69' : 'Puan <60';
const trStratName = s => s.strategy === 'FLOW' ? 'Momentum Flow 5m' : 'Confluence ' + CF.TF;
function trStatsCalc() {
    const closed = trendSignals.filter(s => (s.strategy === 'CF' || s.strategy === 'FLOW') && !isOpen(s) && s.netR != null);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), bySetup: groupBy(closed, trStratName), byScore: groupBy(closed, trBucket), byDir: groupBy(closed, s => s.dir), byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x'), byReg: groupBy(closed, s => 'rejim ' + (s.reg || '-')), byCost: groupBy(closed, s => s.costR <= 0.1 ? 'maliyet ≤0.1R' : s.costR <= 0.2 ? 'maliyet 0.1-0.2R' : 'maliyet >0.2R'), byPlan: groupBy(closed, s => s.strategy === 'FLOW' ? 'Flow' : 'Confluence'), byAlign: groupBy(closed, s => s.aligned === true ? 'piyasa uyumlu' : s.aligned === false ? 'piyasa ters' : 'piyasa nötr'), byExit: groupBy(closed, s => s.status) };
}
function brkStatsCalc() {
    const closed = brkEvents.filter(s => !isOpen(s) && s.netR != null);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), byStrength: groupBy(closed, s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : 'Güç <55'), byDir: groupBy(closed, s => s.dir), byType: groupBy(closed, s => s.type), byExit: groupBy(closed, s => s.status) };
}
function flowShadowStatsCalc() {
    const closed = flowShadow.filter(s => !isOpen(s) && s.netR != null);
    const failsB = {};
    for (const s of closed) for (const f of (s.fails || [])) { (failsB[f] = failsB[f] || []).push(s); }
    const byFail = {};
    for (const k of Object.keys(failsB).sort()) byFail['sadece ' + k + ' takıldı'] = grp(failsB[k]);
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))), byDir: groupBy(closed, s => s.dir), byExit: groupBy(closed, s => s.status), byFail, byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x') };
}
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, avgR: 0, gross: 0, totalR: 0, pf: 0, dd: 0, t: 0 };
    let gt = 0, tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0;
    for (const s of list) { tot += s.netR; gt += s.netR + (s.costR || 0); if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); sq += s.netR * s.netR; }
    const avg = tot / n; let t = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)), se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; }
    return { n, win: w / n, avgR: avg, gross: gt / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, t: Number(t.toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const strBucket = s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : (s.strength || 0) >= 35 ? 'Güç 35-54' : 'Güç <35';

// ======================= CANLI MOTOR (sadece LT) =======================
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        await refreshTickers();
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        try { REG = (await regime.tick(ex, tickers, universe)) || REG; } catch (e) { }
        trTrack(now); brkTrack(now);
        if (TR.TG) {
            for (const sym of Object.keys(structLT)) {
                const st = structLT[sym], tk = tickers[sym];
                if (!st || !tk || !tk.last || now - st.t > 4 * TRI_MS) continue;
                const vals = lineValues(st, now);
                if (vals.R == null || vals.S == null || vals.R <= vals.S) continue;
                const atr = st.lines[0].atr; if (!(atr > 0)) continue;
                const dR = (vals.R - tk.last) / atr, dS = (tk.last - vals.S) / atr;
                let bias = null, dist = null, linePrice = null;
                if (dR > 0 && dR <= CFG.NEAR_ATR) { bias = 'LONG'; dist = dR; linePrice = vals.R; }
                else if (dS > 0 && dS <= CFG.NEAR_ATR) { bias = 'SHORT'; dist = dS; linePrice = vals.S; }
                if (!bias) continue;
                const bkey = 'NEAR|' + sym + '|' + bias;
                if (now - (lastSig[bkey] || 0) < CFG.NEAR_WARN_CD_MIN * 60e3) continue;
                const qv = tk.quoteVolume || 0;
                if (qv < CFG.MIN_SIG_VOL) continue;
                if (BIAS_FILTER && REG && REG.dir !== 'NÖTR' && REG.dir !== bias) continue;
                const v = await liveVol(sym);
                if (v.volX < CFG.NEAR_WARN_VOL_X) continue;
                lastSig[bkey] = now; dirty = true;
                const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, dist, 0.7, bias, rsOf(sym));
                telegram('⚠️ 🐢 UZUN VADE KIRILIM YAKIN ' + (bias === 'LONG' ? '🟢 ' : '🔴 ') + bias + ' ' + baseOf(sym) + '\n' + st.type + ' üçgen • ' + (bias === 'LONG' ? 'üst' : 'alt') + ' çizgiye ' + dist.toFixed(2) + ' ATR (' + fmt(linePrice) + ')' + '\nHacim ' + v.volX.toFixed(1) + 'x • Güç %' + strength + ' ' + strLabel(strength) + '\nKırılım henüz YOK. Fiyat çizgiyi geçerse ayrı sinyal gelir.' + '\n📈 ' + tvLink(baseOf(sym), TRI_TF === '2h' ? 120 : 15));
            }
        }
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
            const v = await liveVol(sym), rs = rsOf(sym);
            const pre = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, Math.abs(cand.d), 0.7, cand.bias, rs);
            const aligned = REG && REG.dir !== 'NÖTR' ? REG.dir === cand.bias : null;
            const item = { symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, dir: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type,
                volX: r2(v.volX), strength: pre, broke, rs: rs == null ? null : r2(rs), aligned,
                squeeze: st.squeeze != null ? Number(st.squeeze) : null,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)' };
            if (broke) { const vp = virtualPlan(L, cand.v, atr, v); if (vp) Object.assign(item, vp, { virtual: true }); }
            const bkey = sym + '|' + cand.bias;
            if (broke) { if (!brokeAt[bkey]) brokeAt[bkey] = now; item.brokeAt = brokeAt[bkey]; item.ageUnsure = brokeAt[bkey] - firstScanAt < 20e3; }
            rad.push(item);
            if (!broke) continue;
            // ---- tek tanımlı kırılım (backtest ile aynı) ----
            const ext0 = L * cand.d;
            if (ext0 < CFG.BRK_MIN_EXT) { item.why = 'aşım yetersiz (' + ext0.toFixed(2) + ' < ' + CFG.BRK_MIN_EXT + ' ATR)'; continue; }
            if (ext0 > CFG.BRK_MAX_EXT) { item.why = 'çok geç (' + ext0.toFixed(2) + ' ATR)'; continue; }
            if (item.ageUnsure && ext0 > 0.3) { item.why = 'başlangıçta zaten kırıktı'; continue; }
            if (CFG.BRK_CLOSE_CONFIRM && !(v.bk && L * (v.bk[4] - cand.v) > 0)) { item.why = '15m kapanış çizgi ötesinde değil'; continue; }
            if (v.volX < CFG.BRK_MIN_VOL) { item.why = 'hacim yetersiz (' + v.volX.toFixed(1) + 'x < ' + CFG.BRK_MIN_VOL + 'x)'; continue; }
            const sk = 'BRK|' + sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.BRK_COOLDOWN_H * H1) { item.why = 'bekleme süresinde'; continue; }
            if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && isOpen(x))) continue;
            if (CFG.BRK_REG_FILTER && REG && REG.dir !== 'NÖTR' && REG.dir !== cand.bias) { item.why = 'piyasa yönü ters (filtre)'; continue; }
            const plan = planTrade(st, cand.bias, P, vals, v, CFG_LT);
            if (!plan) { item.why = v.atr15 > 0 ? 'plan reddi (risk % veya ölçülen hedef R/R yetersiz)' : 'veri yok (15m ATR)'; continue; }
            const brv = v.volX; const brext = Math.abs(cand.d); const brq = 0.6;
            let strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, brv, brext, brq, cand.bias, rs);
            if (strength < CFG.MIN_STRENGTH) { item.why = 'güç düşük (%' + Math.round(strength) + ')'; continue; }
            if (CFG.BRK_LONG_MIN_STR && cand.bias === 'LONG' && !(REG && REG.dir === 'LONG') && strength < CFG.BRK_LONG_MIN_STR) continue;
            const qv = (tickers[sym] || {}).quoteVolume || 0;
            if (qv < CFG.MIN_SIG_VOL) { item.why = 'günlük hacim düşük'; continue; }
            const entry = P, stop = plan.stop;
            const riskAbs = L * (P - stop); if (!(riskAbs > 0)) continue;
            const riskPct = plan.riskPct;
            const costR = (costFor(qv) + 2 * CFG.SLIP_PCT) / riskPct;
            if (costR > CFG.MAX_COST_R) { item.why = 'maliyet yüksek (' + costR.toFixed(2) + 'R)'; continue; }
            let triOi = null;
            if (TRI_OI.ON) { try { await triOiSample(sym); triOi = triOiPct(sym); } catch (e) { } if (TRI_OI.FILTER && triOi != null && triOi < TRI_OI.MIN_PCT) { triOiStat.filtered++; continue; } }
            const ev = { id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', tf: TRI_TF, symbol: sym, base: baseOf(sym), dir: cand.bias, time: now,
                price: P, line: cand.v, type: st.type, touches: st.touches, squeeze: st.squeeze, volX: r2(brv), ext: r2(brext), strength: Math.round(strength),
                mode: 'uzun vade', aligned, rs: rs == null ? null : r2(rs), reg: REG ? REG.dir : '-',
                entry, stop, initialStop: stop, riskAbs, riskPct: r2(riskPct), costR: r2(costR),
                tp1: P + L * riskAbs * plan.tp1R, tp2: P + L * riskAbs * plan.tp2R, tp1R: plan.tp1R, tp2R: r2(plan.tp2R),
                status: 'OPEN', lastPrice: P, mfe: 0, mae: 0, trackedTo: now, triOiPct: triOi == null ? null : r2(triOi) };
            brkEvents.unshift(ev);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM LT', ev.dir, ev.base, ev.type, 'güç', ev.strength, 'hacim', brv.toFixed(1), 'entry', fmt(P), 'stop', fmt(stop), 'risk %' + riskPct.toFixed(2), 'tp2', plan.tp2R.toFixed(2) + 'R');
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
        let res = null;
        if (L * (P - b.stop) <= 0) { if (afterTp1) { b.status = 'BE'; res = 0.5 * b.tp1R; } else { b.status = 'STOP'; res = -1; } }
        else if (r >= b.tp2R) { res = afterTp1 ? 0.5 * b.tp1R + 0.5 * b.tp2R : b.tp2R; b.status = 'TP2'; }
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
        let kk = 0, built = 0, reused = 0;
        for (const sym of universe) {
            if (++kk % 3 === 0) await yieldLoop(); // event loop'u serbest bırak
            const s = S[sym];
            if (s === false) { delete structLT[sym]; continue; }
            if (!s) continue;
            const c = s.c2, i = c.length - 1;
            if (t0 - (c[i][0] + TRI_MS) > 3 * TRI_MS) { delete structLT[sym]; continue; }
            const prev = structLT[sym];
            // aynı kapanmış mum için yeniden hesaplama yapma
            if (prev && prev.lastC === c[i][0] && prev.lines.length) { prev.t = t0; reused++; continue; }
            try {
                const st = buildStruct(s, t0, TRI_MS, CFG_LT, prev);
                st.lastC = c[i][0]; built++;
                if (st.lines.length) structLT[sym] = st;
                else if (!(prev && t0 - prev.t < CFG_LT.GRACE_MIN * 60e3)) delete structLT[sym];
            } catch (e) { }
        }
        for (const k of Object.keys(structLT)) if (!universe.includes(k)) delete structLT[k];
        for (const k of [...histCache.keys()]) if (!universe.includes(k)) histCache.delete(k);
        for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
        for (const [k, v] of triOiHist) if (v.length && Date.now() - v[v.length - 1].t > 60 * M1) triOiHist.delete(k);
        scan.last = Date.now(); scan.ms = scan.last - t0; if (!firstScanAt) firstScanAt = scan.last;
        log('tarama:', Object.keys(structLT).length, 'LT üçgen (' + TRI_TF + ') | yeni hesap', built, 'önbellekten', reused, '|', scan.ms + 'ms');
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= BACKTEST =======================
const DAY = 86400e3;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, strategy: 'tri', startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;
// v55: canlı ile aynı kırılım tanımı, aynı yönetim (trailing yok, 24h süre)
async function btSymbol(sym, c1h, c15, vol24, startT, tfMs) {
    tfMs = tfMs || H1;
    const hz = tfMs === H2 ? 48 * H1 : 24 * H1;
    const trades = [], lastT = {};
    let st = null, h = 0, lastH = -1, busyUntil = 0;
    for (let k = 31; k < c15.length - 1; k++) {
        if (k % 300 === 0) await yieldLoop();
        const bk = c15[k], now = c15[k + 1][0];
        if (bk[0] < startT) continue;
        while (h < c1h.length && c1h[h][0] + tfMs <= now) h++;
        if (h !== lastH && h >= 60) {
            lastH = h;
            const arr = c1h.slice(Math.max(0, h - CFG_LT.TRI_LOOK - 100), h);
            await yieldLoop();
            const ns = buildStruct({ c2: arr }, now, tfMs, CFG_LT, st && !st.dead ? st : null);
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
        const v = { bk, pv: c15[k - 1], avg15: avgP, bkVolX: volX, volX, atr15: atrMean(c15.slice(k - 30, k + 1), 14), projX: 0, el: 0 };
        for (const dir of ['LONG', 'SHORT']) {
            if (busyUntil > now) continue;
            if (now - (lastT[dir] || 0) < CFG.BRK_COOLDOWN_H * H1) continue;
            const L = dir === 'LONG' ? 1 : -1;
            const at = vals[L === 1 ? 'R' : 'S'];
            const ext = L * (P - at) / st.lines[0].atr;
            if (ext < CFG.BRK_MIN_EXT || ext > CFG.BRK_MAX_EXT) continue;
            if (CFG.BRK_CLOSE_CONFIRM && !(L * (bk[4] - at) > 0)) continue;
            if (v.volX < CFG.BRK_MIN_VOL) continue;
            const plan = planTrade(st, dir, P, vals, v, CFG_LT); if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, v.volX, ext, 0.6, dir, null);
            if (strength < CFG.MIN_STRENGTH) continue;
            const costPct = costFor(vol24) + 2 * CFG.SLIP_PCT, costR = costPct / plan.riskPct;
            if (costR > CFG.MAX_COST_R || vol24 < CFG.MIN_SIG_VOL) continue;
            const side = L, risk = side * (P - plan.stop), riskPct = risk / P * 100;
            const sig = { id: 'BT_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, symbol: sym, base: baseOf(sym), dir, entry: P, stop: plan.stop, initialStop: plan.stop,
                tp1: P + side * risk * plan.tp1R, tp2: P + side * risk * plan.tp2R, tp1R: plan.tp1R, tp2R: plan.tp2R, trail: 0, noTrail: true,
                riskAbs: Math.abs(risk), riskPct: r2(riskPct), costR: r2(costR), atr: st.lines[0].atr, strength, volX: r2(v.volX),
                time: now, maxHold: CFG.BRK_EXPIRE_H * H1, status: 'OPEN', mfe: 0, mae: 0, trackedTo: now };
            lastT[dir] = now;
            let done = false;
            for (let j = k + 1; j < c15.length; j++) if (advance(sig, c15[j], M15)) { done = true; break; }
            if (!done) continue;
            busyUntil = sig.closedAt;
            trades.push({ sym, dir, type: st.type, strength, vol: r2(v.volX), ext: r2(ext), costR: sig.costR, riskPct: sig.riskPct, tp2R: r2(sig.tp2R), status: sig.status, netR: sig.netR, t: now, fp: firstPass(sig, c15, k + 1, hz) });
        }
    }
    return trades;
}
async function btConfluence(sym, c, vol24, startT) {
    const trades = [], lastT = {}; let busyUntil = 0;
    const need = 260;
    for (let n = need; n < c.length - 1; n++) {
        if (n % 50 === 0) await yieldLoop();
        const tc = c[n][0] + CF.MS;
        if (c[n][0] < startT || tc <= busyUntil) continue;
        const j = n + 1;
        const entry = c[j][1];
        const cs = c.slice(Math.max(0, n - 699), n + 1);
        const r = cfEval(cs, cs.length - 1, entry, vol24);
        if (!r.cand) continue;
        const cd = r.cand;
        if (tc - (lastT[cd.dir] || 0) < CF.COOLDOWN_H * H1) continue;
        const sig = buildCF(sym, cd, tc);
        lastT[cd.dir] = tc;
        let done = false;
        for (let k2 = j; k2 < c.length; k2++) if (advance(sig, c[k2], CF.MS)) { done = true; break; }
        if (!done) continue;
        busyUntil = sig.closedAt;
        trades.push({ sym, dir: cd.dir, score: cd.score, vol: r2(cd.volX), costR: sig.costR, riskPct: sig.riskPct, mfe: r2(sig.mfe), status: sig.status, netR: sig.netR, t: tc, fp: firstPass(sig, c, j, 10 * 24 * H1) });
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
        if (!s.noTrail) {
            const hh = L ? k[2] : k[3];
            const ts = s.entry + side * Math.max(0, (side * (hh - s.entry)) / risk - CFG.TRAIL_R) * risk;
            if (L ? ts > s.stop : ts < s.stop) s.stop = ts;
        }
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
function btReport(trades, kind) {
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
    verdict += ' Maliyet öncesi ort. R: ' + (g.gross >= 0 ? '+' : '') + g.gross.toFixed(2) + '.';
    const riskB = x => x.riskPct < 0.6 ? 'risk <0.6%' : x.riskPct < 1.2 ? 'risk 0.6-1.2%' : 'risk >1.2%';
    const base = { n: t.length, level, verdict, perDay: t.length / dv.length, worstDay: Math.min(...dv), bestDay: Math.max(...dv), tFrom: t[0].t, tTo: t[t.length - 1].t };
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
    if (kind === 'cf') {
        const scB = x => x.score >= 80 ? 'Puan 80+' : x.score >= 70 ? 'Puan 70-79' : 'Puan 60-69';
        const vB = x => x.vol >= 2 ? 'hacim 2x+' : x.vol >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x';
        base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b }, 'Yön': groupBy(t, x => x.dir), 'Puan': groupBy(t, scB), 'Hacim': groupBy(t, vB), 'Risk %': groupBy(t, riskB), 'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
        return base;
    }
    const volB = x => x.vol >= 2.5 ? 'hacim 2.5x+' : x.vol >= 1.8 ? 'hacim 1.8-2.5x' : 'hacim 1.3-1.8x';
    const extB = x => x.ext <= 0.4 ? 'çizgi ötesi ≤0.4' : x.ext <= 0.7 ? 'çizgi ötesi 0.4-0.7' : 'çizgi ötesi >0.7';
    base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b }, 'Yön': groupBy(t, x => x.dir), 'Üçgen tipi': groupBy(t, x => x.type), 'Güç': groupBy(t, strBucket), 'Kırılım hacmi': groupBy(t, volB), 'Çizgi ötesi (ATR)': groupBy(t, extB), 'Risk %': groupBy(t, riskB), 'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
    return base;
}
async function btFetchAll(xc, sym, tf, ms, from) {
    let since = from; const out = [], end = Date.now();
    for (let g = 0; g < 300 && since < end; g++) { const r = await xc.fetchOHLCV(sym, tf, since, 1000); if (!r.length) break; out.push(...r); const lt = r[r.length - 1][0]; if (lt < since) break; since = lt + ms; }
    const m = new Map(); for (const x of out) m.set(x[0], x);
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter(x => x[0] + ms <= end);
}
async function runBacktestJob(days, n, strategy) {
    if (bt.running) return;
    strategy = strategy === 'cf' ? 'cf' : 'lt';
    bt = { running: true, i: 0, total: 0, sym: '', days, n, strategy, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt[BT_EX]({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const minV = strategy === 'cf' ? TR.MIN_VOL : CFG.MIN_SIG_VOL;
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear && !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= minV && !isSuspect(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
        bt.total = list.length;
        const start = Date.now() - days * DAY; let all = [], skipped = 0; const cov = [], firstTs = [];
        for (const t of list) {
            bt.sym = baseOf(t.symbol);
            try {
                if (!exBT.markets[t.symbol]) throw new Error('sembol ' + BT_EX + ' borsasında yok');
                if (strategy === 'cf') {
                    const c = await btFetchAll(exBT, t.symbol, CF.TF, CF.MS, start - 30 * DAY);
                    const barPerDay = (24 * H1) / CF.MS;
                    cov.push(Math.min(1, c.filter(x => x[0] >= start).length / (days * barPerDay)));
                    if (c.length) firstTs.push(c[0][0]);
                    all = all.concat(await btConfluence(t.symbol, c, t.quoteVolume, start));
                } else {
                    const c15 = await btFetchAll(exBT, t.symbol, '15m', M15, start - 12 * H1);
                    cov.push(Math.min(1, c15.filter(x => x[0] >= start).length / (days * 96)));
                    if (c15.length) firstTs.push(c15[0][0]);
                    const needDays = Math.ceil(CFG_LT.TRI_LOOK * 2 / 24) + 8;
                    const c1h = await btFetchAll(exBT, t.symbol, '1h', H1, start - needDays * DAY);
                    const cs = aggregateN(fillGaps(c1h, H1), H1, 2);
                    all = all.concat(await btSymbol(t.symbol, cs, c15, t.quoteVolume, start, H2));
                }
            } catch (e) { skipped++; if (!bt.firstErr) bt.firstErr = bt.sym + ': ' + String(e.message || e).slice(0, 120); }
            bt.i++;
            await sleep(500);
        }
        bt.result = btReport(all, strategy === 'cf' ? 'cf' : 'tri');
        Object.assign(bt.result, { skipped, coins: list.length, requested: n, days, coverage: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : 0, exchange: BT_EX, dataFrom: firstTs.length ? firstTs.slice().sort((a, b) => a - b)[firstTs.length >> 1] : 0 });
        if (bt.firstErr) bt.result.firstErr = bt.firstErr;
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
    for (const x of triRadar.concat(brkEvents.slice(0, 80), trendSignals.slice(0, 80), flowShadow.slice(0, 80))) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    const radSyms = new Set(triRadar.map(x => x.symbol));
    const forming = [];
    for (const sym of Object.keys(structLT)) {
        if (radSyms.has(sym)) continue;
        if (brkEvents.some(x => x.symbol === sym && isOpen(x))) continue;
        const stx = structLT[sym], tk = tickers[sym];
        if (!stx || !tk || !tk.last || now - stx.t > 4 * TRI_MS) continue;
        const v = lineValues(stx, now); if (v.R == null || v.S == null || v.R <= v.S) continue;
        const atr = stx.lines[0].atr; if (!(atr > 0)) continue;
        forming.push({ symbol: sym, base: baseOf(sym), price: tk.last, type: stx.type, touches: stx.touches, squeeze: stx.squeeze != null ? Number(stx.squeeze) : null, mat: stx.mat != null ? Number(stx.mat.toFixed(2)) : null, toUp: (v.R - tk.last) / atr, toDn: (tk.last - v.S) / atr });
    }
    forming.sort((a, b) => (a.squeeze || 1) - (b.squeeze || 1));
    return {
        now, mode: 'v55 • Sadece LT (büyük simetrik üçgen) + Momentum Flow(5m)',
        px, market, regime: REG,
        tr: trendSignals.slice(0, 80), trStats: trStatsCalc(),
        trInfo: { strategy: 'FLOW', last: flowRun.last, ms: flowRun.ms, running: flowRun.running, tf: '5m', flow: flowRun.dg, cfDisabled: !CF.ON, minVol: TR.MIN_VOL, notify: TR.NOTIFY, top: TR.TOP, maxOpen: TR.MAX_OPEN, minPass: CF.MIN_PASS, minVolX: CF.MIN_VOL_X, perScan: CF.MAX_PER_SCAN, freshMin: FLOW.FRESH_MIN, nextBar: Math.floor(Date.now() / FLOW.SCAN_MS) * FLOW.SCAN_MS + FLOW.SCAN_MS, lastBar: flowRun.lastBar, cfDg: cfRun.dg || null, flowStopAtr: FLOW.STOP_ATR, flowTp1: FLOW.TP1_R, flowTp2: FLOW.TP2_R, flowMaxHoldH: FLOW.MAX_HOLD / H1 },
        breakouts: brkEvents.slice(0, 80), brkStats: brkStatsCalc(),
        flowShadow: flowShadow.slice(0, 60), flowShadowStats: flowShadowStatsCalc(),
        brkInfo: { tp1: CFG.BRK_TP1_R, tp2: CFG.BRK_TP2_R, expireH: CFG.BRK_EXPIRE_H, stopAtr: CFG.STOP_ATR15, cd: CFG.BRK_COOLDOWN_H * 60, triTf: TRI_TF, nearAtr: CFG.NEAR_ATR, minExt: CFG.BRK_MIN_EXT, minVol: CFG.BRK_MIN_VOL },
        radar: triRadar, forming: forming.slice(0, 60),
        tri: { tf: TRI_TF, structs: Object.keys(structLT).length, scanLast: scan.last, scanMs: scan.ms, liveLast: live.last, liveErr: live.err, nearWarnVolX: CFG.NEAR_WARN_VOL_X, nearWarnCdMin: CFG.NEAR_WARN_CD_MIN, ltParams: { K: CFG_LT.TRI_K, look: CFG_LT.TRI_LOOK, maxLen: CFG_LT.TRI_MAX_LEN, squeeze: CFG_LT.TRI_SQUEEZE, lineTouch: CFG_LT.TRI_LINE_TOUCH } },
        stats: st,
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.BRK_COOLDOWN_H * 60, freshMin: CFG.FRESH_ENTRY_MIN, cfTf: CF.TF },
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
        else if (c.length > 60) { const t = detectTriangle(c, c.length - 1, CFG_LT) || detectTriangle(c, c.length - 2, CFG_LT); if (t) tri = pack(t, c, dur); }
        // pencere: üçgenin başlangıcını da gösterecek şekilde genişlet
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
        if (out.length < 5 && typeof ex.fetchFundingRates === 'function') {
            try { const rates = await ex.fetchFundingRates(syms); for (const sym of syms) { const r = rates && rates[sym]; if (!r) continue; const rate = r.fundingRate != null ? r.fundingRate : 0; const t = tickers[sym] || {}; out.push({ sym, base: baseOf(sym), ratePct: rate * 100, price: t.last || 0, chg: t.percentage || 0, vol: t.quoteVolume || 0 }); } } catch (e) { log('funding fetch hata', e.message); }
        }
        out.sort((a, b) => Math.abs(b.ratePct) - Math.abs(a.ratePct));
        fundingCache.data = { now: Date.now(), list: out }; fundingCache.t = Date.now();
        return fundingCache.data;
    } catch (e) { log('funding hata', e.message); return { now: Date.now(), list: [], error: e.message }; }
}
const momCache = { t: 0, data: null };
async function apiMomentum() {
    if (momCache.data && Date.now() - momCache.t < 5 * 60e3) return momCache.data;
    const list = universe.slice(0, 40); const out = [];
    const worker = async (sym) => {
        try {
            const raw = await safeFetch(ex, sym, '1h', 100); const c = closedOnly(raw, H1);
            if (c.length < 50) return;
            const cl = c.map(x => x[4]); const rsi = rsiSeries(cl, 14); const n = cl.length - 1;
            const chg1h = (cl[n] / cl[n - 1] - 1) * 100;
            const chg4h = n >= 4 ? (cl[n] / cl[n - 4] - 1) * 100 : 0;
            const vols = c.slice(-21, -1).map(x => x[5]);
            const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
            const volRatio = avgVol > 0 ? c[n][5] / avgVol : 1;
            const e21 = emaN(cl, 21), e50 = emaN(cl, 50);
            let trend = 'NÖTR';
            if (e21[n] > e50[n] && cl[n] > e21[n]) trend = 'GÜÇLÜ'; else if (e21[n] < e50[n] && cl[n] < e21[n]) trend = 'ZAYIF';
            const tk = tickers[sym] || {};
            let score = 0; score += chg4h * 1.5 + chg1h * 2 + ((rsi[n] || 50) - 50) * 0.3 + (volRatio - 1) * 3;
            if (trend === 'GÜÇLÜ') score += 5; else if (trend === 'ZAYIF') score -= 5;
            out.push({ sym, base: baseOf(sym), price: tk.last || cl[n], chg1h, chg4h, rsi: rsi[n], volRatio, trend, score });
        } catch (e) { }
    };
    let idx = 0;
    const runner = async () => { while (idx < list.length) { const i = idx++; await worker(list[i]); } };
    await Promise.all([runner(), runner(), runner()]);
    out.sort((a, b) => b.score - a.score);
    momCache.data = { now: Date.now(), list: out }; momCache.t = Date.now();
    return momCache.data;
}

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AlphaSon v55 — Terminal</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config={darkMode:'class',theme:{extend:{colors:{
brand:{50:'#eef2ff',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',900:'#312e81'},
dark:{bg:'#080b12',card:'#0e131d',panel:'#131926',border:'#1e2734',hover:'#1a2230',muted:'#7e8ca8'},
trade:{long:'#00e0a0',longBg:'rgba(0,224,160,0.10)',short:'#ff4d6d',shortBg:'rgba(255,77,109,0.10)',gold:'#ffb020',purple:'#a78bfa',blue:'#3b82f6'}
},fontFamily:{sans:['Inter','sans-serif'],mono:['JetBrains Mono','monospace']}}}};
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{-webkit-tap-highlight-color:transparent}
body{background:#080b12;color:#f3f4f6;font-family:'Inter',sans-serif;overflow-x:hidden;font-variant-numeric:tabular-nums;letter-spacing:-.1px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#0e131d}
::-webkit-scrollbar-thumb{background:#1e2734;border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:#2a3648}
.glass{background:rgba(19,25,38,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.06)}
.glow-long{box-shadow:0 0 20px rgba(0,224,160,.15),inset 0 1px 0 rgba(255,255,255,.03)}
.glow-short{box-shadow:0 0 20px rgba(255,77,109,.15),inset 0 1px 0 rgba(255,255,255,.03)}
.chart-grid{background-size:24px 24px;background-image:linear-gradient(to right,rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.025) 1px,transparent 1px)}
canvas{display:block;width:100%;height:100%}
.tab-btn{transition:all .15s}
.tab-btn.a{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;box-shadow:0 6px 20px rgba(99,102,241,.35)}
.sig-row{transition:all .15s;cursor:pointer;border-left:3px solid transparent}
.sig-row:hover{background:rgba(26,34,48,.6)}
.sig-row.sel{background:rgba(99,102,241,.08);border-left-color:#6366f1}
.sig-row.L{border-left-color:#00e0a0}
.sig-row.S{border-left-color:#ff4d6d}
.sig-row.LT{border-left-color:#a78bfa}
.sig-row.closed{opacity:.55}
.sig-row.old{opacity:.78}
#toast{position:fixed;top:80px;right:20px;z-index:999;background:linear-gradient(135deg,rgba(19,25,38,.98),rgba(14,19,29,.98));border:1px solid #a78bfa;color:#fff;padding:14px 20px;border-radius:12px;font-weight:600;font-size:13px;box-shadow:0 20px 60px rgba(0,0,0,.7),0 0 40px rgba(167,139,250,.25);display:none;cursor:pointer;max-width:360px;backdrop-filter:blur(16px);animation:slideIn .3s ease}
@keyframes slideIn{from{transform:translateX(40px);opacity:0}to{transform:translateX(0);opacity:1}}
.pulse-dot{animation:pulseDot 1.8s infinite}
@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.2)}}
.heatmap{display:grid;grid-template-columns:repeat(auto-fill,minmax(66px,1fr));gap:3px;margin-top:6px}
.heat-cell{aspect-ratio:1;border-radius:8px;padding:6px 6px 5px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;transition:all .15s;border:1px solid rgba(255,255,255,.06);overflow:hidden}
.heat-cell:hover{transform:scale(1.08);border-color:rgba(255,255,255,.45);z-index:10;box-shadow:0 6px 24px rgba(0,0,0,.55)}
.hc-sym{font-size:10px;font-weight:800;letter-spacing:-.3px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hc-chg{font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;line-height:1}
.mom-tbl{width:100%;font-size:11px;font-family:'JetBrains Mono',monospace;border-collapse:collapse}
.mom-tbl thead th{color:#7e8ca8;font-size:10px;text-transform:uppercase;padding:6px 6px;border-bottom:1px solid #1e2734;font-weight:700;letter-spacing:.4px;background:transparent}
.mom-tbl td{padding:5px 6px;border-bottom:1px solid rgba(30,39,52,.6)}
.mom-tbl tbody tr{cursor:pointer;transition:background .12s}
.mom-tbl tbody tr:hover{background:rgba(26,34,48,.55)}
.rsi-bar{display:inline-block;width:30px;height:4px;background:rgba(38,50,79,.6);border-radius:2px;vertical-align:middle;overflow:hidden;position:relative;margin-left:4px}
.rsi-bar i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#00e0a0,#ffb020,#ff4d6d);border-radius:2px}
.lt-badge{display:inline-block;padding:1px 7px;border-radius:6px;background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.35);font-size:9px;font-weight:800;font-family:'JetBrains Mono',monospace;letter-spacing:.3px;margin-left:6px}
.squeeze-bar{display:inline-block;width:40px;height:5px;background:rgba(38,50,79,.6);border-radius:3px;vertical-align:middle;overflow:hidden;position:relative;margin-left:6px}
.squeeze-bar i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#00e0a0,#a78bfa,#ffb020);border-radius:3px}
</style>
</head>
<body class="min-h-screen flex flex-col antialiased">

<header class="h-16 border-b border-dark-border bg-dark-card/90 backdrop-blur-xl sticky top-0 z-50 flex items-center justify-between px-4 lg:px-6 gap-3">
  <div class="flex items-center gap-3 min-w-0">
    <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-indigo-400 flex items-center justify-center shadow-lg shadow-brand-500/30 shrink-0">
      <i class="fa-solid fa-chart-line text-white text-base"></i>
    </div>
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-bold text-[15px] tracking-tight text-white whitespace-nowrap">AlphaSon</span>
        <span id="modeB" class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-trade-purple/20 text-trade-purple border border-trade-purple/30 whitespace-nowrap">v55 LT</span>
      </div>
      <p class="text-[10px] text-dark-muted hidden sm:block">Long-Term Triangle Engine</p>
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
  <div>AlphaSon v55 • Long-Term Triangle Engine</div>
  <div class="flex items-center gap-4">
    <span>Bitget Perpetual</span>
    <span class="w-2 h-2 rounded-full bg-trade-purple pulse-dot"></span>
  </div>
</footer>

<div id="toast"></div>

<script>
var TABS=[
  {k:'sig',    ico:'fa-bolt',          lbl:'Momentum'},
  {k:'lt',     ico:'fa-draw-polygon',  lbl:'LT Üçgenler'},
  {k:'piyasa', ico:'fa-globe',         lbl:'Piyasa'},
  {k:'stat',   ico:'fa-chart-simple',  lbl:'İstatistik'},
  {k:'bt',     ico:'fa-flask',         lbl:'Backtest'}
];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,UNI=null,FUND=null,MOM=null,tab='lt',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastSigT=0,lastTrT=0,toastT=null,insTick=0,BT=null,btDays=60,btN=40,btS='lt';
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'—';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'—':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);if(isNaN(x))return'—';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'text-trade-long':x<0?'text-trade-short':'text-dark-muted'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function FM(){return (S&&S.config&&S.config.freshMin)||10}
function isFresh(o){return o.status==='OPEN'&&(Date.now()-o.time)<((o.freshMin||FM()))*60e3}
function stratName(k,o){return k==='tr'?(o&&o.strategy==='FLOW'?'MOMENTUM FLOW '+((o.chartTf||'5m').toUpperCase()):'CONFLUENCE '+((o&&o.chartTf||'').toUpperCase())):k==='brk'?'🐢 UZUN VADE ÜÇGEN KIRILIM':'🐢 UZUN VADE ÜÇGEN'+(o&&o.broke?' • ÇİZGİ AŞILDI':'')}
function dirBadge(d){return d==='LONG'?'<span class="px-2 py-0.5 rounded-md bg-trade-longBg text-trade-long border border-trade-long/30 text-[10px] font-bold font-mono">▲ LONG</span>':'<span class="px-2 py-0.5 rounded-md bg-trade-shortBg text-trade-short border border-trade-short/30 text-[10px] font-bold font-mono">▼ SHORT</span>'}
var ST={OPEN:['AÇIK','amber'],TP1:['TP1 ✓','blue'],TP2:['TP2 ✓','long'],TRAIL:['TRAIL ✓','long'],BE:['BE','muted'],STOP:['STOP','short'],'SÜRE':['SÜRE','muted'],TIMEOUT:['SÜRE','muted'],EXPIRED:['SÜRESİ DOLDU','muted']};
function stTag(k){var v=ST[k]||[k||'?','muted'];var c={amber:'bg-amber-500/10 text-amber-400 border-amber-500/30',blue:'bg-blue-500/10 text-blue-400 border-blue-500/30',long:'bg-trade-longBg text-trade-long border-trade-long/30',short:'bg-trade-shortBg text-trade-short border-trade-short/30',muted:'bg-dark-hover text-dark-muted border-dark-border'}[v[1]];return '<span class="px-2 py-0.5 rounded-md '+c+' border text-[10px] font-bold font-mono">'+v[0]+'</span>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.08;o.start();o.stop(actx.currentTime+0.3)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.innerHTML=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn&&fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor='';prefetch(sym,defTf())}

function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastSigT});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('<i class="fa-solid fa-bell text-trade-purple mr-2"></i>🐢 LT KIRILIM '+e.dir+' <b>'+e.base+'</b> — GÜÇ %'+e.strength,function(){tab='lt';pick('brk',e.id,e.symbol);renderAll()})}}
function checkTr(){var a=S.tr||[],nt=(S.trInfo||{}).notify||0,mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastTrT){lastTrT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastTrT&&x.score>=nt});if(mx>lastTrT)lastTrT=mx;
 if(nw.length){beep();setTimeout(beep,400);var s=nw[0];showToast('<i class="fa-solid fa-bolt text-trade-gold mr-2"></i>'+(s.strategy==='FLOW'?'MOMENTUM':'CONFLUENCE')+' '+s.dir+' <b>'+s.base+'</b> — PUAN %'+s.score,function(){tab='sig';pick('tr',s.id,s.symbol);renderAll()})}}

function posInfo(o){if(!o||o.entry==null||!o.riskAbs)return null;
 var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry,open=isOp(o),fin=!open&&o.netR!=null;
 var raw=L*(px-o.entry)/o.riskAbs,rawPct=L*(px-o.entry)/o.entry*100,t1=o.tp1R||((S.brkInfo&&S.brkInfo.tp1)||1),rp=o.riskPct||0,r,pct;
 if(fin){r=o.netR;pct=(o.grossR!=null?o.grossR:o.netR)*rp}
 else if(o.status==='TP1'){r=0.5*t1+0.5*raw;pct=0.5*t1*rp+0.5*rawPct}
 else{r=raw;pct=rawPct}
 return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,tp2:o.tp2,t:o.time}}}

function renderTop(){var m=S.market,R=S.regime;
 if(!R){$('cBtcDir').innerHTML='<span class="text-dark-muted">BTC:</span> <span class="text-dark-muted">…</span>';$('cReg').innerHTML='<span class="text-dark-muted">Piyasa:</span> <span class="text-dark-muted">…</span>'}
 else{var bc=R.btcDir==='LONG'?'text-trade-long':R.btcDir==='SHORT'?'text-trade-short':'text-dark-muted';
  $('cBtcDir').innerHTML='<span class="text-dark-muted">BTC:</span> <span class="'+bc+' font-bold">'+R.btcDir+' <span class="font-mono">'+sg(R.btcScore||0,0)+'</span></span>';
  var rc=R.dir==='LONG'?'text-trade-long':R.dir==='SHORT'?'text-trade-short':'text-dark-muted';
  $('cReg').innerHTML='<span class="text-dark-muted">Piyasa:</span> <span class="'+rc+' font-bold">'+R.dir+' <span class="font-mono">'+sg(R.score,0)+'</span></span><span class="text-dark-muted text-[10px] ml-1">'+R.regime+'</span>';}
 $('cBTC').innerHTML=m.btc?'<span class="text-dark-muted">BTC:</span> <span class="text-white font-semibold">'+fp(m.btc.price)+'</span> <span class="'+cl(m.btc.chg)+' text-[10px] ml-1">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<span class="text-dark-muted">ETH:</span> <span class="text-white font-semibold">'+fp(m.eth.price)+'</span> <span class="'+cl(m.eth.chg)+' text-[10px] ml-1">'+sg(m.eth.chg)+'%</span>':'';
 var A=(S.trStats&&S.trStats.today)||{totalR:0,n:0};var B=(S.brkStats&&S.brkStats.today)||{totalR:0,n:0};
 $('cHealth').innerHTML='<span class="text-dark-muted">24s:</span> <span class="'+cl(A.totalR)+' font-bold font-mono">'+sg(A.totalR,1)+'R</span> <span class="text-dark-border">|</span> <span class="'+cl(B.totalR)+' font-mono">'+sg(B.totalR,1)+'R</span>';
 $('modeB').textContent=(S.mode||'v55').split('•')[0].trim()}

function renderTabs(){
 var oc=(S.tr||[]).filter(isFresh).length;
 var nb=(S.breakouts||[]).filter(isFresh).length + (S.radar||[]).length + (S.forming||[]).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t.k==='sig'&&oc?oc:t.k==='lt'&&nb?nb:0;
  return '<button class="tab-btn'+(tab===t.k?' a':'')+' px-4 py-2 rounded-lg text-xs font-bold text-dark-muted flex items-center gap-2 whitespace-nowrap" data-t="'+t.k+'"><i class="fa-solid '+t.ico+'"></i>'+t.lbl+(cnt?'<span class="px-1.5 py-0.5 rounded-md bg-white/15 text-[10px] font-mono">'+cnt+'</span>':'')+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;if(tab==='bt')pollBT();renderAll()}})}

function sigRow(s){var L=s.dir==='LONG'?1:-1,op=isOp(s),old=op&&!isFresh(s);
 var P=posInfo(s),r=P?P.r:0,pct=P?P.pct:0;
 var rTxt=P?sg(r)+'R':'—',rCls=!P?'text-dark-muted':r>0.005?'text-trade-long':r<-0.005?'text-trade-short':'text-dark-muted';
 var selc=(sel&&sel.kind==='tr'&&sel.id===s.id?' sel':'')+(op?'':' closed')+(old?' old':'')+(L===1?' L':' S');
 return '<div class="sig-row '+selc+'" data-kind="tr" data-id="'+esc(s.id)+'" data-sym="'+esc(s.symbol)+'">'+
  '<div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
   '<div class="col-span-3 flex items-center gap-2 min-w-0"><span class="w-1.5 h-1.5 rounded-full '+(L===1?'bg-trade-long':'bg-trade-short')+' shrink-0"></span><div class="min-w-0"><div class="font-bold text-white text-sm truncate">'+esc(s.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+(s.strategy==='FLOW'?'FLOW '+f2(s.volX,1)+'x':'CF '+(s.passes||0)+'/5')+'</div></div></div>'+
   '<div class="col-span-2">'+dirBadge(s.dir)+'</div>'+
   '<div class="col-span-2 text-xs font-mono text-gray-200 truncate">'+fp(s.entry)+'</div>'+
   '<div class="col-span-2 text-xs font-mono text-dark-muted truncate"><span class="text-trade-short">'+fp(s.stop)+'</span> / <span class="text-trade-long">'+fp(s.tp1)+'</span></div>'+
   '<div class="col-span-1">'+stTag(s.status)+'</div>'+
   '<div class="col-span-2 text-right font-mono font-bold '+rCls+'">'+rTxt+(P&&P.pct!=null?'<div class="text-[10px] '+cl(pct)+' font-normal">'+sg(pct)+'%</div>':'')+'</div>'+
  '</div></div>'}

function radRow(r){var L=r.bias==='LONG'?1:-1;
 var st=r.broke?'<span class="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold">AŞILDI</span>':'<span class="px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold">HAZIR</span>';
 var str=r.strength>=75?'text-trade-long':r.strength>=55?'text-trade-long/80':'text-trade-gold';
 var cls='LT '+(L===1?'L':'S');
 return '<div class="sig-row '+cls+(sel&&sel.kind==='rad'&&sel.sym===r.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(r.base)+'<span class="lt-badge">🐢 LT</span></div><div class="text-[10px] text-dark-muted font-mono">'+esc(r.type||'üçgen')+' • '+r.touches+' dokunuş</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(r.bias)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-gray-200">'+fp(r.price)+'</div>'+
  '<div class="col-span-3 text-[11px] text-dark-muted">'+esc((r.state||'').slice(0,50))+(r.broke&&r.why?'<div class="text-amber-400 text-[10px] mt-0.5">sinyal yok: '+esc(r.why)+'</div>':'')+'</div>'+
  '<div class="col-span-1">'+st+'</div>'+
  '<div class="col-span-1 text-right font-mono font-bold '+str+'">%'+r.strength+'</div></div></div>'}

function brkRow(e){var L=e.dir==='LONG'?1:-1,op=isOp(e);var P=posInfo(e);var r=P?P.r:0;
 var selc=(sel&&sel.kind==='brk'&&sel.id===e.id?' sel':'')+(op?'':' closed')+(L===1?' L':' S')+' LT';
 return '<div class="sig-row '+selc+'" data-kind="brk" data-id="'+esc(e.id)+'" data-sym="'+esc(e.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(e.base)+'<span class="lt-badge">🐢 LT</span></div><div class="text-[10px] text-dark-muted font-mono">'+esc(e.type||'')+'</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(e.dir)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-gray-200">'+fp(e.entry)+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-dark-muted"><span class="text-trade-short">'+fp(e.stop)+'</span> / <span class="text-trade-long">'+fp(e.tp1)+'</span></div>'+
  '<div class="col-span-1">'+stTag(e.status)+'</div>'+
  '<div class="col-span-2 text-right font-mono font-bold '+cl(r)+'">'+(op||e.netR!=null?sg(r)+'R':'—')+'</div></div></div>'}

function shRow(s){var L=s.dir==='LONG'?1:-1,op=isOp(s);var px=(S.px&&S.px[s.symbol])||s.entry;var r=op?L*(px-s.entry)/s.riskAbs:(s.netR||0);
 var fails=(s.fails||[]).join('+')||'—';
 return '<div class="sig-row '+(L===1?'L':'S')+'" style="opacity:.55" data-sym="'+esc(s.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-2 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="text-[10px]">👻</span><div><div class="font-bold text-white text-xs">'+esc(s.base)+'</div><div class="text-[9px] text-dark-muted font-mono">GÖLGE</div></div></div>'+
  '<div class="col-span-2">'+dirBadge(s.dir)+'</div>'+
  '<div class="col-span-3 text-[10px] text-dark-muted font-mono">eksik: '+esc(fails)+'</div>'+
  '<div class="col-span-2">'+stTag(s.status)+'</div>'+
  '<div class="col-span-2 text-right font-mono font-bold '+cl(r)+'">'+sg(r)+'R</div></div></div>'}

function sqRow(x){var L=(x.toUp<x.toDn)?1:-1;
 var sq=x.squeeze!=null?Math.round((1-x.squeeze)*100):0;
 var sqBar=x.squeeze!=null?'<div class="squeeze-bar"><i style="width:'+Math.max(4,sq)+'%"></i></div>':'';
 var dirTxt=L===1?'<span class="text-trade-long text-[10px] font-bold">▲ LONG</span>':'<span class="text-trade-short text-[10px] font-bold">▼ SHORT</span>';
 return '<div class="sig-row LT'+(sel&&sel.kind==='rad'&&sel.sym===x.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(x.symbol)+'"><div class="grid grid-cols-12 gap-3 px-4 py-3 items-center">'+
  '<div class="col-span-3 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-trade-purple"></span><div><div class="font-bold text-white text-sm">'+esc(x.base)+'</div><div class="text-[10px] text-dark-muted font-mono">'+esc(x.type||'üçgen')+' • '+x.touches+' dokunuş'+(x.mat!=null?' • olgun %'+Math.round(x.mat*100):'')+'</div></div></div>'+
  '<div class="col-span-2">'+dirTxt+'</div>'+
  '<div class="col-span-2 text-xs font-mono text-gray-200">'+fp(x.price)+'</div>'+
  '<div class="col-span-3 text-[11px] text-dark-muted">Üst <b class="text-white">'+f2(x.toUp,2)+'</b> ATR • Alt <b class="text-white">'+f2(x.toDn,2)+'</b> ATR'+sqBar+'</div>'+
  '<div class="col-span-1"><span class="px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold">SIKIŞIYOR</span></div>'+
  '<div class="col-span-1 text-right font-mono font-bold text-trade-purple">%'+sq+'</div></div></div>'}

function renderListPanel(){
 var tr=(S.tr||[]).filter(isOp),ac=(S.tr||[]).filter(function(x){return !isOp(x)});
 var fr=tr.filter(isFresh),od=tr.filter(function(x){return !isFresh(x)});
 var ev=S.breakouts||[],rd=S.radar||[],fo=S.forming||[];
 var brk=rd.filter(function(x){return x.broke}),near=rd.filter(function(x){return !x.broke});
 var fresh=ev.filter(isFresh),oldB=ev.filter(function(x){return isOp(x)&&!isFresh(x)}),closedB=ev.filter(function(x){return !isOp(x)});
 var html='';
 if(tab==='sig'){
  if(fr.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">🟢 Taze — giriş açık ('+fr.length+')</div>'+fr.map(sigRow).join('');
  if(od.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">⏳ Açık / TP1 — takip ('+od.length+')</div>'+od.map(sigRow).join('');
  if(ac.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Kapananlar ('+Math.min(20,ac.length)+'/'+ac.length+')</div>'+ac.slice(0,20).map(sigRow).join('');
  var shA=(S.flowShadow||[]).filter(isOp);
  if(shA.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">👻 Gölge açık ('+shA.length+')</div>'+shA.slice(0,8).map(shRow).join('');
  if(!tr.length&&!ac.length&&!shA.length)html='<div class="text-center text-dark-muted py-12 text-xs">Henüz Momentum Flow sinyali yok.<br>OI + hacim + fitil + boşluk koşulları sağlanınca sinyal oluşur.</div>';
 } else if(tab==='lt'){
  var ltP=((S.tri||{}).ltParams)||{K:3,look:650,maxLen:700,squeeze:0.75};
  var triTf=((S.tri||{}).tf||'2h').toUpperCase();
  var ltN=(S.tri||{}).structs||0;
  html+='<div class="glass rounded-xl p-3 mb-3 text-[11px] text-dark-muted">🐢 <b class="text-trade-purple">Uzun Vadeli Üçgenler</b> — TF <b class="text-white">'+triTf+'</b> • yapı: <b class="text-white">'+ltN+'</b> • izlenen: <b class="text-white">'+rd.length+'</b> • sinyal: <b class="text-trade-long">'+ev.length+'</b> • sıkışan: <b class="text-white">'+fo.length+'</b></div>';
  if(fresh.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">🟢 Taze kırılım ('+fresh.length+')</div>'+fresh.map(brkRow).join('');
  if(oldB.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">⏳ Eski kırılım ('+oldB.length+')</div>'+oldB.map(brkRow).join('');
  if(brk.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">◎ Çizgiyi aşanlar ('+brk.length+')</div>'+brk.map(radRow).join('');
  if(near.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">🎯 Çizgiye yaklaşanlar ('+near.length+')</div>'+near.map(radRow).join('');
  if(fo.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">📐 Sıkışanlar — daralma sırası ('+fo.length+')</div>'+fo.map(sqRow).join('');
  if(closedB.length)html+='<div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider px-3 py-2">Kapanan kırılım</div>'+closedB.slice(0,12).map(brkRow).join('');
  if(!rd.length&&!ev.length&&!fo.length)html='<div class="text-center text-dark-muted py-12 text-xs">Şu anda LT üçgen yok.<br>Sistem 2H\'de son '+ltP.look+' mumu tarıyor.<br><span class="text-dark-muted">Büyük üçgenler haftalar içinde oluşur.</span></div>';
 } else html='<div class="text-center text-dark-muted py-12 text-xs">Sağ panelde detaylar.</div>';
 $('listPanel').innerHTML=html;
 Array.prototype.forEach.call($('listPanel').querySelectorAll('.sig-row'),function(e){if(!e.dataset.kind)return;e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderListPanel();renderMain()}})}

function drawChart(d,V,cid){var c=$(cid);if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}
 var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);
 var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?15:4);
 var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;
 var ti=function(t){return (t-d.c[0][0])/d.dur};var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];
 var lg=function(a,pa,b,pb,q){return Math.exp(Math.log(pa)+(Math.log(pb)-Math.log(pa))*(q-a)/((b-a)||1))};
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});hi=Math.max(hi,px);lo=Math.min(lo,px);
 if(lv)[lv.entry,lv.stop,lv.tp1,lv.tp2].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var tl=[];if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),xa=Math.min(Math.max(a,0),n),xb=Math.min(b,n);tl.push([a,l[0][1],b,l[1][1]]);[xa,xb].forEach(function(q){var v=lg(a,l[0][1],b,l[1][1],q);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.07;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(1.5,PW/n*.7);
 var labs=[];if(lv){labs.push({p:lv.entry,col:'#ffb020',t:V.virtual?'ÇİZGİ':'GİRİŞ'});labs.push({p:lv.stop,col:'#ff4d6d',t:'STOP'});if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#00e0a0',t:lv.tp2!=null?'TP1':'TP'});if(lv.tp2!=null)labs.push({p:lv.tp2,col:'#3b82f6',t:'TP2'})}
 labs.push({p:px,col:'#f3f4f6',t:'',cur:1});labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});labs.sort(function(a,b){return a.y-b.y});for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}
 var si=-1;if(lv&&lv.t){si=Math.floor(ti(lv.t));if(si<0||si>=nc)si=-1}
 if(lv){var zx=si>=0?X(si):L,zw=W-R-zx,ye=Y(lv.entry),ys=Y(lv.stop),far=lv.tp2!=null?lv.tp2:lv.tp1,yt=far!=null?Y(far):ye;x.fillStyle='rgba(255,77,109,.10)';x.fillRect(zx,Math.min(ye,ys),zw,Math.abs(ys-ye));x.fillStyle='rgba(0,224,160,.10)';x.fillRect(zx,Math.min(ye,yt),zw,Math.abs(yt-ye))}
 x.font='10px JetBrains Mono,monospace';for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.04)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#7e8ca8';x.fillText(fp(gp),W-R+8,gy+3)}}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};line(d.e50,'#a78bfa',1.1);line(d.e21,'#3b82f6',1.1);
 d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#00e0a0':'#ff4d6d';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;x.strokeStyle='rgba(255,255,255,.06)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#00e0a0':'#ff4d6d',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.5;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#ffb020';x.lineWidth=1.1;x.beginPath();var s2=false;d.vsma.forEach(function(v,k){if(v==null)return;var y=vTop+volH-(v/vmax)*(volH-4);s2?x.lineTo(X(k),y):(x.moveTo(X(k),y),s2=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(function(l){x.strokeStyle='rgba(167,139,250,.85)';x.lineWidth=2;x.beginPath();var NS=80;for(var z=0;z<=NS;z++){var q=l[0]+(l[2]-l[0])*z/NS,yv=lg(l[0],l[1],l[2],l[3],q);z?x.lineTo(X(q),Y(yv)):x.moveTo(X(q),Y(yv))}x.stroke()});
  x.fillStyle='rgba(167,139,250,.9)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});
  x.font='9px JetBrains Mono,monospace';x.fillStyle='#c4b5fd';
  tri.hi.forEach(function(p,i){x.fillText(String(i+1),X(ti(p[0]))-3,Y(p[1])-6)});
  tri.lo.forEach(function(p,i){x.fillText(String(i+1),X(ti(p[0]))-3,Y(p[1])+14)});
  x.restore()}
 x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.2;x.globalAlpha=.8;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});x.restore();
 if(si>=0){var kk=d.c[si],isL=V.dir==='LONG',mx=X(si);x.strokeStyle='rgba(167,139,250,.45)';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(mx,T);x.lineTo(mx,T+PH);x.stroke();x.setLineDash([]);x.fillStyle=isL?'#00e0a0':'#ff4d6d';x.beginPath();if(isL){var y0=Y(kk[3])+5;x.moveTo(mx,y0);x.lineTo(mx-8,y0+14);x.lineTo(mx+8,y0+14)}else{var y1=Y(kk[2])-5;x.moveTo(mx,y1);x.lineTo(mx-8,y1-14);x.lineTo(mx+8,y1-14)}x.closePath();x.fill();x.fillStyle='#f3f4f6';x.font='bold 10px JetBrains Mono,monospace';x.fillText('GİRİŞ',mx+10,isL?Y(kk[3])+18:Y(kk[2])-8)}
 x.strokeStyle='rgba(255,255,255,.5)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);
 labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#080b12';x.font='bold 10px JetBrains Mono,monospace';x.fillText(txt,W-R+6,y+3.5)});
 x.fillStyle='#7e8ca8';x.font='10px JetBrains Mono,monospace';var stp=Math.max(1,Math.ceil(nc/7));for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);if(d.dur>=3600e3)hh=('0'+dt.getDate()).slice(-2)+'.'+('0'+(dt.getMonth()+1)).slice(-2)+' '+hh;x.fillText(hh,X(q)-12,H-5)}
 x.font='10px JetBrains Mono,monospace';x.fillStyle='#3b82f6';x.fillRect(L+6,T+6,10,3);x.fillStyle='#7e8ca8';x.fillText('EMA21',L+20,T+10);
 x.fillStyle='#a78bfa';x.fillRect(L+62,T+6,10,3);x.fillStyle='#7e8ca8';x.fillText('EMA50',L+76,T+10);
 x.fillStyle='#a78bfa';x.fillText('🐢 '+d.tf+' · LT üçgen'+(tri&&tri.mat!=null?' · olgunluk %'+Math.round(tri.mat*100):''),L+118,T+10);
 if(V&&V.dir){var isLg=V.dir==='LONG';x.fillStyle=isLg?'#00e0a0':'#ff4d6d';x.fillRect(8,7,92,24);x.fillStyle='#051412';x.font='bold 13px Inter,sans-serif';x.fillText(isLg?'▲ LONG':'▼ SHORT',16,24);if(V.strat){x.fillStyle='#f3f4f6';x.font='bold 11px Inter,sans-serif';x.fillText(V.strat,108,24)}if(V.pnl){var pc=V.pnl.r>0.005?'#00e0a0':V.pnl.r<-0.005?'#ff4d6d':'#7e8ca8',txt=(V.pnl.fin?'KAPANDI ':(V.pnl.lbl||'CANLI')+' ')+sg(V.pnl.r)+'R   '+sg(V.pnl.pct)+'%';x.font='bold 12px JetBrains Mono,monospace';var w=x.measureText(txt).width+22;x.fillStyle=pc;x.fillRect(W-R-w+L,7,w,24);x.fillStyle='#080b12';x.fillText(txt,W-R-w+L+11,23)}}}
function refreshView(){var M=$('main');if(M){M.removeAttribute('data-view-key');renderMain()}}
function loadChart(sym,tf){var k=sym+'|'+tf;fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error||!d.c)return;chartCache[k]=d;if(sel&&sel.sym===sym&&(tfSel||defTf())===tf){chartFor=k;refreshView()}}).catch(function(){})}
function prefetch(sym,tf){if(sym&&!chartCache[sym+'|'+tf])loadChart(sym,tf)}
function setTf(v){tfSel=v;chartFor='';refreshView()}
function selData(){if(!sel||!sel.sym)return null;if(sel.kind==='tr')return(S.tr||[]).find(function(x){return x.id===sel.id})||null;if(sel.kind==='brk')return(S.breakouts||[]).find(function(x){return x.id===sel.id})||null;return(S.radar||[]).find(function(x){return x.symbol===sel.sym})||null}
function defTf(){if(sel&&sel.kind==='rad')return S.config.tf;if(sel&&sel.kind==='tr'){var o=selData()||{};return o.chartTf||'15m'}return((S.tri||{}).tf||'2h')}

function whyText(o,kind){
 if(!o)return'Bu sinyal artık listede değil.';
 var fresh=isFresh(o)?'<b class="text-trade-long">Sinyal taze, giriş açık.</b>':(o.status==='OPEN'?'<b class="text-trade-short">Sinyal eski — sadece takip.</b>':'');
 if(kind==='tr'&&o.strategy==='FLOW'){return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">⚡ MOMENTUM FLOW 5M</span><br>Fiyat hareketi <b>'+(o.pricePct>0?'+':'')+o.pricePct+'%</b>, OI değişimi <b>+'+o.oiPct+'%</b>, hacim <b>'+o.volX+'x</b>. Bu puan kazanma olasılığı değildir. '+fresh}
 if(kind==='tr'&&o.strategy==='CF')return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">🧩 CONFLUENCE</span><br>Kernel + ML + QQE + WaveTrend onayı. Puan <b>%'+o.score+'</b> • Onay '+(o.passes||0)+'/5. '+fresh;
 if(kind==='brk')return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">🐢 UZUN VADE ÜÇGEN KIRILIM</span><br>'+esc(o.type)+' üçgenin '+(o.dir==='LONG'?'üst':'alt')+' çizgisi aşıldı ('+(o.touches||'?')+' dokunuş, hacim '+f2(o.volX,1)+'x, güç %'+o.strength+'). TP1 '+o.tp1R+'R, TP2 '+f2(o.tp2R,1)+'R (ölçülen üçgen yüksekliği). '+fresh;
 if(o.broke)return '<span class="inline-block px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-bold mb-1.5">◎ ÇİZGİ AŞILDI</span><br>'+esc(o.state)+'. Fiyat çizgiyi aştı.'+(o.why?'<br><b class="text-amber-400">Sinyal verilmedi:</b> '+esc(o.why)+'.':'');
 return '<span class="inline-block px-2 py-0.5 rounded-md bg-trade-purple/15 text-trade-purple border border-trade-purple/30 text-[10px] font-bold mb-1.5">🐢 UZUN VADE RADAR</span><br>'+esc(o.state)+' — henüz kırılmadı.'}

function heatCell(x){var chg=Number(x.chg)||0,abs=Math.min(8,Math.abs(chg))/8;var bg,fg;
 if(chg>0.15){bg='rgba(0,224,160,'+(0.12+abs*0.75)+')';fg='#031a12';}
 else if(chg<-0.15){bg='rgba(255,77,109,'+(0.12+abs*0.75)+')';fg='#2a0612';}
 else{bg='rgba(38,50,79,.45)';fg='#c8d0e0';}
 return '<div class="heat-cell" data-kind="ins" data-sym="'+esc(x.sym)+'" style="background:'+bg+';color:'+fg+'" title="'+esc(x.base)+' • 24s '+sg(chg)+'% • hacim '+f2(x.vol/1e6,1)+'M$"><div class="hc-sym">'+esc(x.base)+'</div><div class="hc-chg">'+sg(chg,1)+'%</div></div>'}
function fundRow(x){var r=x.ratePct||0,clx=r>0.01?'text-trade-short':r<-0.01?'text-trade-long':'text-dark-muted';var bar=Math.min(100,Math.abs(r)*20);
 return '<tr data-kind="ins" data-sym="'+esc(x.sym)+'"><td class="text-white font-bold">'+esc(x.base)+'</td><td class="text-dark-muted">'+fp(x.price)+'</td><td class="'+cl(x.chg)+'">'+sg(x.chg,1)+'%</td><td class="text-right '+clx+' font-bold">'+(r>0?'+':'')+f2(r,4)+'%<div class="rsi-bar"><i style="width:'+bar+'%;background:'+(r>0?'#ff4d6d':'#00e0a0')+'"></i></div></td></tr>'}
function momRow(x){var rsi=x.rsi||50,clx=rsi>=70?'text-trade-short':rsi<=30?'text-trade-long':'text-dark-muted';var trendC=x.trend==='GÜÇLÜ'?'text-trade-long':x.trend==='ZAYIF'?'text-trade-short':'text-dark-muted';
 return '<tr data-kind="ins" data-sym="'+esc(x.sym)+'"><td class="text-white font-bold">'+esc(x.base)+'</td><td class="text-dark-muted">'+fp(x.price)+'</td><td class="'+cl(x.chg1h)+'">'+sg(x.chg1h,1)+'%</td><td class="'+cl(x.chg4h)+'">'+sg(x.chg4h,1)+'%</td><td class="text-right '+clx+'">'+f2(rsi,0)+'<div class="rsi-bar"><i style="width:'+Math.min(100,rsi)+'%"></i></div></td><td class="text-right text-dark-muted">'+f2(x.volRatio,1)+'x</td><td class="text-right '+trendC+' text-[10px]">'+x.trend+'</td></tr>'}
function insTable(title,icon,rows,th){if(!rows||!rows.length)return '<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-2"><i class="fa-solid '+icon+' text-brand-400 mr-1.5"></i>'+title+'</div><div class="text-dark-muted text-xs text-center py-4">veri bekleniyor…</div></div>';
 return '<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid '+icon+' text-brand-400 mr-1.5"></i>'+title+'</div><table class="mom-tbl"><thead><tr>'+th+'</tr></thead><tbody>'+rows+'</tbody></table></div>'}
function renderDash(){
  var uni=(UNI&&UNI.list)||[];
  var hm=uni.slice().sort(function(a,b){return (b.vol||0)-(a.vol||0)}).slice(0,60);
  var heat='<div class="glass rounded-2xl p-4 mb-4"><div class="flex items-center justify-between mb-2"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted"><i class="fa-solid fa-fire text-trade-gold mr-1.5"></i>Isı Haritası — 24s değişim (hacme göre top 60)</div><div class="text-[10px] text-dark-muted font-mono">'+uni.length+' coin</div></div>'+(hm.length?'<div class="heatmap">'+hm.map(heatCell).join('')+'</div>':'<div class="text-dark-muted text-xs text-center py-6">yükleniyor…</div>')+'</div>';
  var fl=(FUND&&FUND.list)||[];
  var fund=insTable('Funding Rates','fa-money-bill-transfer',fl.map(fundRow).join(''),'<th class="text-left">Coin</th><th class="text-left">Fiyat</th><th class="text-left">24s</th><th class="text-right">Funding</th>');
  var ml=(MOM&&MOM.list)||[];
  var mom=insTable('Momentum (1h RSI + trend)','fa-gauge-high',ml.slice(0,12).map(momRow).join(''),'<th class="text-left">Coin</th><th class="text-left">Fiyat</th><th class="text-left">1h</th><th class="text-left">4h</th><th class="text-right">RSI</th><th class="text-right">Vol</th><th class="text-right">Trend</th>');
  var m=(S.market)||{},R=S.regime||{};
  var pulse='<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid fa-heart-pulse text-trade-short mr-1.5"></i>Nabız</div><div class="grid grid-cols-2 gap-3"><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">BTC</div><div class="font-mono font-bold mt-1">'+fp(m.btc?m.btc.price:0)+'</div><div class="text-xs '+cl(m.btc?m.btc.chg:0)+' font-mono">'+sg(m.btc?m.btc.chg:0)+'%</div></div><div class="glass rounded-lg p-3"><div class="text-[10px] text-dark-muted uppercase">ETH</div><div class="font-mono font-bold mt-1">'+fp(m.eth?m.eth.price:0)+'</div><div class="text-xs '+cl(m.eth?m.eth.chg:0)+' font-mono">'+sg(m.eth?m.eth.chg:0)+'%</div></div></div>'+(R.breadth?'<div class="mt-3 text-[11px] text-dark-muted">Genişlik: <b class="text-trade-long">↑'+R.breadth.up+'</b> / <b class="text-trade-short">↓'+R.breadth.dn+'</b> <span class="text-dark-muted">('+R.breadth.n+' coin)</span></div>':'')+'</div>';
  var sq=(S.forming||[]).slice(0,6);
  var sqh='<div class="glass rounded-2xl p-4"><div class="text-[11px] font-bold uppercase tracking-wider text-dark-muted mb-3"><i class="fa-solid fa-compress text-trade-purple mr-1.5"></i>En Yakın LT Üçgenler</div>'+(sq.length?sq.map(function(x){return '<div class="sig-row LT" data-kind="ins" data-sym="'+esc(x.symbol)+'" style="cursor:pointer"><div class="flex justify-between items-center px-2 py-2 border-b border-dark-border/60"><span class="font-bold text-white text-xs">'+esc(x.base)+'</span><span class="text-[10px] text-dark-muted">'+esc(x.type)+'</span><span class="text-trade-purple font-mono text-xs font-bold">'+f2(Math.min(Math.abs(x.toUp),Math.abs(x.toDn)),2)+' ATR</span></div></div>'}).join(''):'<div class="text-dark-muted text-xs text-center py-4">yok</div>')+'</div>';
  return heat+'<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">'+fund+mom+'</div><div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">'+pulse+sqh+'</div>';
}

function renderMain(){var M=$('main');
  if(tab!=='bt'){
    var vKey=(tab||'')+'|'+(sel?sel.kind+'|'+sel.id+'|'+sel.sym:'')+'|'+(tfSel||'');
    if(M.getAttribute('data-view-key')===vKey && (Date.now()-(+M.getAttribute('data-view-t')||0))<15000){return}
    M.setAttribute('data-view-key',vKey);M.setAttribute('data-view-t',Date.now());
  }
 if(tab==='piyasa'){M.innerHTML=renderDash();bindIns(M);return}
 if(tab==='stat'){M.innerHTML='<div class="glass rounded-2xl p-5">'+statView()+'</div>';return}
 if(tab==='bt'){M.innerHTML=btShell()+'<div id="btOut" class="mt-4">'+(BT?btOut():'')+'</div>';return}
 var o=sel&&sel.sym?selData():null;
 var detail='';
 if(o){var kind=sel.kind,tf=tfSel||defTf();
  var P=((kind==='tr'&&o.riskAbs)||kind==='brk'||(kind==='rad'&&o.broke&&o.entry!=null))?posInfo(o):null;
  var dir=o.dir||o.bias;
  var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100;
  var lvHtml='';
  if(P){var usd=P.r*ru;
   lvHtml='<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">'+
    '<div class="glass rounded-xl p-3 '+(P.r>0.005?'glow-long':P.r<-0.005?'glow-short':'')+'"><div class="text-[10px] text-dark-muted font-bold uppercase">'+(P.fin?'KAPANDI • '+o.status:'CANLI')+'</div><div class="text-2xl font-bold font-mono '+cl(P.r)+' mt-1">'+sg(P.r)+'R</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">Fiyat Farkı</div><div class="text-2xl font-bold font-mono '+cl(P.pct)+' mt-1">'+sg(P.pct)+'%</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">≈ K/Z (USDT)</div><div class="text-2xl font-bold font-mono '+cl(usd)+' mt-1">'+sg(usd)+'</div></div>'+
    '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted font-bold uppercase">MFE / MAE</div><div class="text-2xl font-bold font-mono text-white mt-1">'+(o.mfe!=null?f2(o.mfe,1)+'/'+f2(o.mae||0,1):'—')+'</div></div>'+
   '</div>'}
  var lvGrid='';
  if(P){lvGrid='<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Anlık</div><div class="font-mono font-bold mt-0.5">'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</div></div>'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Giriş</div><div class="font-mono font-bold text-trade-gold mt-0.5">'+fp(o.entry)+'</div></div>'+
   '<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">Stop</div><div class="font-mono font-bold text-trade-short mt-0.5">'+fp(o.stop)+'</div></div>'+
   (o.tp1!=null?'<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">TP1 ('+f2(o.tp1R||((S.brkInfo||{}).tp1)||1,1)+'R)</div><div class="font-mono font-bold text-trade-long mt-0.5">'+fp(o.tp1)+'</div></div>':'')+
   (o.tp2!=null?'<div class="glass rounded-xl p-3"><div class="text-[10px] text-dark-muted uppercase">TP2 ('+f2(o.tp2R||((S.brkInfo||{}).tp2)||2,1)+'R)</div><div class="font-mono font-bold text-trade-blue mt-0.5">'+fp(o.tp2)+'</div></div>':'')+
  '</div>'}
  var tfs=['5m','15m','1h','2h','4h'].map(function(t){return '<button class="'+(t===tf?'a':'')+' px-3 py-1.5 rounded-md text-[11px] font-bold font-mono text-dark-muted hover:text-white" data-tf="'+t+'">'+t.toUpperCase()+'</button>'}).join('');
  detail='<div class="glass rounded-2xl p-5 mb-5">'+
   '<div class="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-dark-border">'+
    '<div class="flex items-center gap-3 min-w-0">'+dirBadge(dir)+'<div class="min-w-0"><h2 class="text-lg font-bold text-white flex items-center gap-2">'+esc(sel.sym.split('/')[0])+'<span class="text-xs text-dark-muted font-normal">/USDT.P</span><span class="lt-badge">🐢 LT</span></h2>'+
     '<p class="text-[11px] text-dark-muted">'+stratName(kind,o)+(o.score?' • Puan '+o.score:'')+(o.strength!=null?' • Güç %'+o.strength:'')+(o.passes?' • '+o.passes+'/5':'')+'</p></div></div>'+
    '<div class="flex items-center gap-2"><div class="flex gap-0.5 bg-dark-bg p-1 rounded-lg border border-dark-border">'+tfs+'</div>'+
    '<a href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sel.sym.split('/')[0])+'USDT.P&interval='+(tf==='5m'?'5':tf==='15m'?'15':tf==='2h'?'120':tf==='4h'?'240':'60')+'" target="_blank" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-[11px] text-white font-bold flex items-center gap-1.5"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>TV</a></div>'+
   '</div>'+
   '<div class="chart-grid relative w-full h-[440px] mt-4 rounded-xl bg-dark-bg/60 border border-dark-border overflow-hidden"><canvas id="cv"></canvas></div>'+
   lvHtml+lvGrid+
   '<div class="glass rounded-xl p-4 mt-4 text-xs text-dark-muted leading-relaxed">'+whyText(o,kind)+'</div>'+
   '<div class="glass rounded-xl p-4 mt-4"><div class="text-[10px] text-dark-muted font-bold uppercase tracking-wider mb-2">Pozisyon Hesabı</div>'+calcBox(P?P.levels.entry:null,P?P.levels.stop:null)+'</div>'+
  '</div>';
  setTimeout(function(){
   var k=sel.sym+'|'+tf;
   if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||null,strat:stratName(kind,o),pnl:P?{r:P.r,pct:P.pct,fin:P.fin,lbl:(kind==='rad'?'ÇİZGİDEN':'CANLI')}:null},'cv')}
   else{var cv=$('cv');if(cv){var xx=cv.getContext('2d');cv.width=cv.clientWidth;cv.height=cv.clientHeight;xx.fillStyle='#7e8ca8';xx.font='12px Inter,sans-serif';xx.fillText('Grafik yükleniyor…',16,28)}}
   if(!chartCache[k]&&chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}
   Array.prototype.forEach.call(M.querySelectorAll('[data-tf]'),function(b){b.onclick=function(){setTf(b.dataset.tf)}});
   bindCalc();
  },0);
 } else if(tab==='lt'){
  detail='<div class="glass rounded-2xl p-6 text-center text-dark-muted"><i class="fa-solid fa-draw-polygon text-3xl mb-3 opacity-40 text-trade-purple"></i><div class="text-sm font-bold text-white mb-1">🐢 Uzun Vadeli Üçgenler</div><div class="text-xs max-w-md mx-auto leading-relaxed">Sistem TradingView\'da elle çizdiğin tarz <b class="text-white">büyük simetrik üçgenleri</b> izler. Çizgi başına en az 3 gerçek dokunuş, log-fiyat uzayında, yerel ATR toleransıyla.<br><br><b class="text-trade-purple">SIKIŞIYOR</b> = üçgen daralıyor<br><b class="text-trade-purple">HAZIR</b> = fiyat çizgiye yakın<br><b class="text-amber-400">AŞILDI</b> = çizgi geçildi<br><b class="text-trade-long">KIRILIM</b> = sinyal üretildi (15m kapanış teyidi + aşım + hacim)<br><br>Tüm liste sağ panelde, daralma yüzdesine göre sıralı.</div></div>';
 } else {
  var os_=(S.tr||[]).filter(isOp).length,ob_=(S.breakouts||[]).filter(isOp).length;
  detail='<div class="text-center py-20 text-dark-muted"><i class="fa-solid fa-satellite-dish text-4xl mb-4 opacity-30"></i><div class="text-sm font-bold text-white mb-1">Sinyal bekleniyor</div><div class="text-xs">Açık sinyal: <b class="text-white">'+os_+'</b> • Açık LT kırılım: <b class="text-white">'+ob_+'</b></div></div>';
 }
 M.innerHTML='<div class="grid grid-cols-1 lg:grid-cols-12 gap-5">'+
  '<div class="lg:col-span-8 flex flex-col gap-5">'+detail+'</div>'+
  '<div class="lg:col-span-4"><div class="glass rounded-2xl p-4 sticky top-32"><div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 flex items-center justify-between"><span><i class="fa-solid fa-bolt text-trade-purple mr-1.5"></i>'+(tab==='lt'?'LT Üçgenler':'Sinyal Akışı')+'</span><span class="text-dark-muted font-mono">'+(tab==='lt'?((S.radar||[]).length+(S.forming||[]).length+(S.breakouts||[]).length):(S.tr||[]).length)+'</span></div><div id="listPanel" class="-mx-4 max-h-[calc(100vh-220px)] overflow-y-auto"></div></div></div>'+
 '</div>';
 renderListPanel();
 bindIns(M);
}
function bindIns(M){Array.prototype.forEach.call(M.querySelectorAll('[data-kind="ins"]'),function(e){e.onclick=function(){var sym=e.dataset.sym;if(!sym)return;tab='lt';sel={kind:'rad',id:'',sym:sym};tfSel='2h';chartFor='';prefetch(sym,'2h');renderAll()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="flex flex-wrap gap-3 items-end">'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Bakiye</div><input id="cBal" type="number" value="'+cfgC.bal+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-24 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Risk %</div><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-20 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Giriş</div><input id="cE" type="number" step="any" value="'+(e||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Stop</div><input id="cS" type="number" step="any" value="'+(s||'')+'" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs font-mono w-28 focus:border-brand-500 focus:outline-none"></label>'+
 '<div id="cOut" class="text-xs text-dark-muted font-mono"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b class="text-trade-gold">'+f2(c.ru)+' USDT</b> • Miktar <b>'+f2(c.q,4)+'</b> • Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">'+title+'</h3><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2 px-2">Grup</th><th class="text-right py-2 px-2">N</th><th class="text-right py-2 px-2">Win%</th><th class="text-right py-2 px-2">OrtR</th><th class="text-right py-2 px-2">Brüt</th><th class="text-right py-2 px-2">TopR</th><th class="text-right py-2 px-2">PF</th><th class="text-right py-2 px-2">t</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+Object.keys(t).map(function(k){var x=t[k];return '<tr class="hover:bg-dark-hover/40"><td class="py-2 px-2 text-white">'+esc(k)+'</td><td class="text-right py-2 px-2">'+x.n+'</td><td class="text-right py-2 px-2">'+f2(x.win*100,0)+'</td><td class="text-right py-2 px-2 '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="text-right py-2 px-2 '+cl(x.gross)+'">'+sg(x.gross)+'</td><td class="text-right py-2 px-2 '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="text-right py-2 px-2">'+f2(x.pf)+'</td><td class="text-right py-2 px-2">'+f2(x.t)+'</td></tr>'}).join('')+'</tbody></table></div>'};
function statView(){var A=S.trStats||{},B=S.brkStats||{},h='<h2 class="text-lg font-bold text-white mb-4"><i class="fa-solid fa-chart-simple text-brand-400 mr-2"></i>İstatistik</h2>';
 h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mb-2 text-brand-400">⚡🧩 TREND (Momentum Flow + Confluence) — net R</div>';
 if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.bySetup||{},'Strateji')+tbl(A.byScore||{},'Puan')+tbl(A.byDir||{},'Yön')+tbl(A.byVol||{},'Hacim')+tbl(A.byReg||{},'Rejim')+tbl(A.byAlign||{},'Yön Uyumu')+tbl(A.byCost||{},'Maliyet')+tbl(A.byExit||{},'Çıkış')}
 else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan trend sinyali yok.</div>';
 h+='<div class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-6 mb-2 text-trade-purple">🐢 UZUN VADE ÜÇGEN KIRILIM</div>';
 if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Tip')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Çıkış')}
 else h+='<div class="text-dark-muted text-xs py-3">Henüz kapanan kırılım yok.</div>';
 return h}

function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&s='+btS),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 return '<div class="glass rounded-2xl p-5"><h2 class="text-lg font-bold text-white mb-3"><i class="fa-solid fa-flask text-brand-400 mr-2"></i>Backtest</h2><div class="text-xs text-dark-muted mb-4">Giriş sinyal mumundan sonraki mumun açılışı. Stop/hedef aynı mumdaysa STOP önce. LT kuralları canlı ile aynı (trailing yok, 24s süre).</div>'+
 '<div class="flex flex-wrap gap-3 items-end">'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Strateji</div><select onchange="btS=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs"><option value="lt"'+(btS==='lt'?' selected':'')+'>🐢 Uzun Vadeli Üçgen (2h)</option><option value="cf"'+(btS==='cf'?' selected':'')+'>Confluence</option></select></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Gün</div><select onchange="btDays=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([14,30,60,90,180],btDays)+'</select></label>'+
 '<label><div class="text-[10px] text-dark-muted font-bold uppercase mb-1">Coin</div><select onchange="btN=this.value" class="bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-xs">'+so([20,40,60,100],btN)+'</select></label>'+
 '<button onclick="btStart()" class="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-bold"><i class="fa-solid fa-play mr-1"></i>Başlat</button></div></div>'}
function edgeTbl(e){if(!e||!e.length)return'';return '<h3 class="text-[11px] text-dark-muted font-bold uppercase tracking-wider mt-4 mb-2">Sinyal İsabeti</h3><div class="text-xs text-dark-muted mb-2">Giriş sonrası stop mesafesi kadar ters gitmeden +kR hedefe ulaşma.</div><div class="overflow-x-auto"><table class="w-full text-xs font-mono"><thead><tr class="text-dark-muted border-b border-dark-border text-[10px] uppercase"><th class="text-left py-2">Grup</th><th class="text-left py-2">Hedef</th><th class="text-right py-2">N</th><th class="text-right py-2">İsabet%</th><th class="text-right py-2">Rastgele%</th><th class="text-right py-2">Fark</th><th class="text-right py-2">z</th></tr></thead><tbody class="divide-y divide-dark-border/40">'+e.map(function(x){var d=(x.hit-x.base)*100;return '<tr><td class="py-2 text-white">'+esc(x.g)+'</td><td class="py-2">+'+x.k+'R</td><td class="text-right py-2">'+x.n+'</td><td class="text-right py-2">'+f2(x.hit*100,0)+'</td><td class="text-right py-2">'+f2(x.base*100,0)+'</td><td class="text-right py-2 '+cl(d)+'">'+sg(d,0)+'</td><td class="text-right py-2 '+cl(x.z)+'">'+f2(x.z)+'</td></tr>'}).join('')+'</tbody></table></div>'}
function btOut(){var b=BT;if(!b)return '';var sn=b.strategy==='cf'?'Confluence':'🐢 Uzun Vadeli Üçgen (2h)';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="glass rounded-2xl p-5"><div class="text-sm"><b class="text-white">Çalışıyor ('+sn+'):</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') <span class="text-brand-400 font-mono">%'+pc+'</span></div><div class="mt-2 h-1 bg-dark-bg rounded-full overflow-hidden"><div class="h-full bg-brand-500" style="width:'+pc+'%"></div></div></div>'}
 if(b.err)return '<div class="glass rounded-2xl p-5 border border-trade-short/40 text-trade-short text-sm">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return'';
 if(!r.n)return '<div class="glass rounded-2xl p-5 text-sm">'+sn+': '+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.'+(r.skipped?'<div class="text-xs text-amber-400 mt-2">Atlanan coin: '+r.skipped+(r.firstErr?' • ilk hata: '+esc(r.firstErr):'')+'</div>':'')+'</div>';
 var col=r.level==='g'?'border-trade-long':r.level==='r'?'border-trade-short':'border-trade-gold';
 var tc=r.level==='g'?'text-trade-long':r.level==='r'?'text-trade-short':'text-trade-gold';
 var h='<div class="glass rounded-2xl p-5 border-l-4 '+col+'"><b class="'+tc+' text-sm">Değerlendirme — '+sn+'</b><div class="text-xs text-dark-muted mt-2 leading-relaxed">'+esc(r.verdict)+'</div></div>';
 var dt=function(x){return x?new Date(x).toISOString().slice(0,10):'—'};
 h+='<div class="text-xs text-dark-muted mt-3 font-mono">'+r.coins+' coin • '+r.days+' gün • '+r.n+' işlem • '+dt(r.tFrom)+' → '+dt(r.tTo)+' • kapsam %'+Math.round((r.coverage||0)*100)+(r.skipped?' • atlanan '+r.skipped:'')+'</div>';
 if((r.coverage||0)<0.9)h+='<div class="glass rounded-xl p-3 mt-3 border border-trade-gold/40 text-trade-gold text-xs">⚠ Veri eksik olabilir</div>';
 if(r.edge)h+=edgeTbl(r.edge);
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});return '<div class="mt-3">'+h+'</div>'}

function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){
  if(d&&d.error){$('dot').className='w-2 h-2 rounded-full bg-trade-short pulse-dot';$('conn').textContent='Hata';return}
  S=d;
  $('dot').className='w-2 h-2 rounded-full bg-trade-long pulse-dot';$('conn').textContent='Bağlı';
  try{checkBrk();checkTr();renderAll()}catch(e){console.error(e);$('conn').textContent='UI hata'}
  var now=Date.now();
  if(now-insTick>30e3){insTick=now;fetchIns();}
}).catch(function(){$('dot').className='w-2 h-2 rounded-full bg-trade-short pulse-dot';$('conn').textContent='Bağlantı yok'})}
function fetchIns(){
  fetch(api('/api/universe')).then(function(r){return r.json()}).then(function(d){UNI=d;if(tab==='piyasa')refreshView()}).catch(function(){});
  fetch(api('/api/funding')).then(function(r){return r.json()}).then(function(d){FUND=d;if(tab==='piyasa')refreshView()}).catch(function(){});
  fetch(api('/api/momentum')).then(function(r){return r.json()}).then(function(d){MOM=d;if(tab==='piyasa')refreshView()}).catch(function(){});
}
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
        if (u.pathname === '/health') return json(res, 200, { ok: true, name: 'AlphaSon', version: 'v55', triTf: TRI_TF, flowOn: FLOW.ON, oiSupported: flowRun.supported, flowDiag: flowRun.dg || null, triangles: Object.keys(structLT).length, radar: triRadar.length, breakouts: brkEvents.length, trend: trendSignals.length, regime: REG, universe: universe.length, histCached: histCache.size });
        if (u.pathname === '/api/reset' && req.method === 'POST') { if (!authed(u)) return json(res, 401, { error: 'yetkisiz' }); signals = []; trendSignals = []; brkEvents = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true }); }
        if (['/', '/index.html', '/api/state', '/api/candles', '/api/backtest', '/api/backtest/start', '/api/universe', '/api/funding', '/api/momentum'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/universe') return json(res, 200, apiUniverse());
        if (u.pathname === '/api/funding') return json(res, 200, await apiFunding());
        if (u.pathname === '/api/momentum') return json(res, 200, await apiMomentum());
        if (u.pathname === '/api/backtest') return json(res, 200, bt);
        if (u.pathname === '/api/backtest/start' && req.method === 'POST') {
            if (bt.running) return json(res, 409, { error: 'Backtest zaten çalışıyor' });
            if (!Object.keys(tickers).length) return json(res, 503, { error: 'Piyasa verisi henüz yüklenmedi' });
            if (!rateOk(ip + '|bt', 3)) return json(res, 429, { error: 'çok fazla istek' });
            const days = Math.min(180, Math.max(7, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            const sp = u.searchParams.get('s'); const strategy = sp === 'cf' ? 'cf' : 'lt';
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
        (async () => { await runScan(); await runConfluence(true); })();
        setInterval(async () => { await runConfluence(false); }, 5000);
        (async () => { await runFlow(true); })();
        setInterval(async () => { await runFlow(false); }, 5000);
        setInterval(async () => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; await runScan(); }
        }, 3000);
        log('AlphaSon v55 • Sadece LT (log-uzay, gerçek dokunuş, birleşik kırılım tanımı) • evren ' + universe.length + ' coin');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('unhandledRejection', e => log('UNHANDLED REJECTION:', e && e.stack ? e.stack : e));
process.on('uncaughtException', e => log('UNCAUGHT EXCEPTION:', e && e.stack ? e.stack : e));
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, planTrade, virtualPlan, CFG, CFG_LT, CF,
    buildStruct, lineValues, calculateStrength, costFor, advance, grp, groupBy, strBucket, atrMean, aggregateN, hasGap, fillGaps,
    runBacktestJob, btSymbol, btReport, btConfluence, getBt: () => bt,
    runConfluence, runFlow, FLOW, cfEval, buildCF, qqeMod, waveTrend, rsiSeries, lorentzPred, emaN, rmaN, smaN, stdevN, cciSeries, adxSeries, trTrack, trStatsCalc,
    getTr: () => trendSignals, getBrk: () => brkEvents };
