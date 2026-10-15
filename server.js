'use strict';
// ============================================================
// SONER TRADE v49 — TEK DOSYA
//   v49 (v46 üzerine):
//   - MOMENTUM FLOW sinyallerine STOP / TP1 / TP2 eklendi (ATR tabanlı, 1R / 2R)
//   - FLOW sinyalleri artık canlı takip edilir: kâr/zarar (R, %, USDT), TP1 → stop girişe, STOP, TP2, SÜRE
//   - Grafikte FLOW için giriş / stop / TP1 / TP2 çizgileri ve K/Z kutusu çizilir
//   - Giriş fiyatı artık mum kapanışı değil, sinyal anındaki canlı fiyat
//   - FLOW sinyali 30 dk sonra "EXPIRED" yapılmıyordu → artık stop/hedef/süre ile kapanır
//   - İstatistik: FLOW + CONFLUENCE birlikte hesaplanır (strateji kırılımı dahil)
//   - TP1 alınmış açık pozisyonda K/Z, realize edilen yarım pozisyon dahil gösterilir
//   - Telegram FLOW mesajına stop/TP1/TP2 eklendi
//   - Küçük hata düzeltmeleri (OI desteklenmiyorsa tekrar tekrar deneme, eski kayıt göçü vb.)
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
const CFG = {
    UNIVERSE: num('UNIVERSE', 400),
    MIN_VOL_USDT: num('MIN_VOL', 3e6),
    FLAT_MAX: 0.08, MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 7),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CONCURRENCY: num('SCAN_CONCURRENCY', 3),
    UNIVERSE_MS: 5 * 60e3, KEEP: 500, SCAN_DELAY_MS: 8000,
    TRI_K: num('TRI_K', 3), TRI_LOOK: num('TRI_LOOK', 150), TRI_MIN_LEN: num('TRI_MIN_LEN', 15), TRI_MAX_LEN: num('TRI_MAX_LEN', 100),
    TRI_TOL_ATR: num('TRI_TOL_ATR', 0.30), TRI_WICK_ATR: num('TRI_WICK_ATR', 0.60), TRI_CLOSE_ATR: num('TRI_CLOSE_ATR', 0.20),
    TRI_MIN_TOUCH: num('TRI_MIN_TOUCH', 3), TRI_SQUEEZE: num('TRI_SQUEEZE', 0.85), TRI_FLAT: num('TRI_FLAT', 0.12), GRACE_MIN: num('GRACE_MIN', 30),
    NEAR_ATR: num('NEAR_ATR', 1.2), BRK_SEE: num('BRK_SEE', 2.0), BRK_ATR: num('BRK_ATR', 0.15), BRK_VOL: num('BRK_VOL', 1.3),
    FRESH_MIN: num('FRESH_MIN', 5), MAX_CHASE: num('MAX_CHASE', 0.6),
    FRESH_ENTRY_MIN: num('FRESH_ENTRY_MIN', 10),
    STOP_ATR15: num('STOP_ATR15', 2.0), STOP_MIN_PCT: num('STOP_MIN_PCT', 0.8),
    BRK_TP1_R: num('BRK_TP1_R', 1.0), BRK_TP2_R: num('BRK_TP2_R', 2.0), BRK_EXPIRE_H: num('BRK_EXPIRE_H', 12),
    BRK_REG_FILTER: num('BRK_REG_FILTER', 1),
    BRK_LONG_MIN_STR: num('BRK_LONG_MIN_STR', 75),
    MIN_RR: num('MIN_RR', 0.8), MAX_TP2R: num('MAX_TP2R', 5),
    MIN_STRENGTH: num('MIN_STRENGTH', 45), MAX_COST_R: num('MAX_COST_R', 0.35),
    BK_MAX_ATR15: num('BK_MAX_ATR15', 2.5), MIN_SIG_VOL: num('MIN_SIG_VOL', 3e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    COOLDOWN_MIN: num('COOLDOWN_MIN', 45), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 6.0),
    TP1_R: num('TP1_R', 1.0), TRAIL_R: num('TRAIL_R', 1.0), MAX_HOLD_MS: num('MAX_HOLD_H', 6) * H1, TS_MS: num('TS_MIN', 90) * 60e3, TS_MFE: 0.3,
    NEAR_WARN_VOL_X: num('NEAR_WARN_VOL_X', 0.7), NEAR_WARN_CD_MIN: num('NEAR_WARN_CD_MIN', 60)
};

// ======================= TREND (CF/FLOW ortak) =======================
const TR = {
    ON: num('TR_ON', 1),
    MIN_VOL: num('TR_MIN_VOL', 5e6),
    TOP: num('TR_TOP', 400),
    NOTIFY: num('TR_NOTIFY', 50),
    MAX_COST_R: num('TR_MAX_COST_R', 0.35),
    MAX_OPEN: num('TR_MAX_OPEN', 25),
    KEEP: 300,
    TG: num('TR_TG', 1)
};
const BIAS_TH = num('BIAS_TH', 15), BIAS_FILTER = num('TREND_BIAS_FILTER', 0);

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
const atrAt = (c, n, p = 14) => { let s = 0; for (let i = n - p + 1; i <= n; i++) s += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); return s / p; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clOf = a => a.map(x => x[4]);

// ======================= OHLCV YARDIMCILARI =======================
const REQ_QUEUE = { next: 0, minGap: num('REQ_GAP_MS', 120) };
async function throttle() {
    const now = Date.now(), at = Math.max(now, REQ_QUEUE.next);
    REQ_QUEUE.next = at + REQ_QUEUE.minGap;
    if (at > now) await sleep(at - now);
}
async function safeFetch(ex, sym, tf, limit, since) {
    let attempt = 0;
    while (attempt < 3) {
        await throttle();
        try { return await ex.fetchOHLCV(sym, tf, since, limit); }
        catch (e) {
            const msg = String(e.message || e);
            if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit') || msg.includes('Rate Limit')) {
                attempt++;
                const backoff = 2000 * Math.pow(2, attempt - 1);
                REQ_QUEUE.next = Math.max(REQ_QUEUE.next, Date.now() + backoff);
                log('RATE LIMIT → ' + backoff + 'ms bekle (' + sym + ' ' + tf + ')');
                await sleep(backoff);
            } else throw e;
        }
    }
    throw new Error('Rate limit: ' + sym + ' ' + tf);
}
function aggregateN(c, baseMs, n) { const ms = baseMs * n, g = new Map(); for (const x of c) { const k = Math.floor(x[0] / ms) * ms; let a = g.get(k); if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); } else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; } } return [...g.values()].filter(a => a[6] === n); }
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
function cciSeries(c, p) {
    const tp = c.map(x => (x[2] + x[3] + x[4]) / 3), o = new Array(c.length).fill(null);
    for (let i = p - 1; i < c.length; i++) { let m = 0; for (let j = i - p + 1; j <= i; j++) m += tp[j]; m /= p; let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - m); md /= p; o[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md); }
    return o;
}
function adxSeries(c, p) {
    const tr = [null], pdm = [null], mdm = [null];
    for (let i = 1; i < c.length; i++) {
        const up = c[i][2] - c[i - 1][2], dn = c[i - 1][3] - c[i][3];
        pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
        tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])));
    }
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
    for (let i = 0; i < n; i++) {
        if (rsiMa[i] == null || basis[i] == null) continue;
        const up = basis[i] + 0.35 * sd[i], lo = basis[i] - 0.35 * sd[i], v = rsiMa[i] - 50;
        if (v > 3 && v > up) blue[i] = true; else if (v < -3 && v < lo) red[i] = true;
    }
    return { blue, red };
}
function lorentzPred(F, y, t, K) {
    const ft = F[t]; if (!ft) return 0;
    let last = -1; const dist = [], pr = [];
    const start = Math.max(0, t - 200);
    for (let j = start; j <= t - 4; j++) {
        const fj = F[j]; if (!fj || y[j] == null) continue;
        let d = 0; for (let k = 0; k < 5; k++) d += Math.log(1 + Math.abs(ft[k] - fj[k]));
        if (d >= last && (j % 4) !== 0) {
            last = d; dist.push(d); pr.push(y[j]);
            if (pr.length > K) { last = dist[Math.round(K * 3 / 4)]; dist.shift(); pr.shift(); }
        }
    }
    let sum = 0; for (const v of pr) sum += v; return sum;
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
function pack(tri, c, ms) {
    const lastI = c.length - 1, tOf = i => i <= lastI ? c[Math.max(0, Math.round(i))][0] : c[lastI][0] + (i - lastI) * (ms || TRI_MS);
    const xEnd = Math.min(tri.apex, tri.end + 15);
    const lineR = (t, x) => t.R.p0 + t.R.s * (x - t.R.i0), lineS = (t, x) => t.S.p0 + t.S.s * (x - t.S.i0);
    const seg = (L, f) => [[tOf(L.i0), L.p0], [tOf(xEnd), f(tri, xEnd)]];
    return { type: tri.type, touches: tri.touches, squeeze: Number(tri.squeeze.toFixed(2)), apex: tOf(tri.apex), w0: tri.w0,
        res: seg(tri.R, lineR), sup: seg(tri.S, lineS), hi: tri.R.pts.map(p => [tOf(p.i), p.p]), lo: tri.S.pts.map(p => [tOf(p.i), p.p]) };
}

// ======================= CONFLUENCE (15m varsayılan) =======================
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
// FLOW: Üçgenlerden bağımsız fiyat + hacim + açık pozisyon (OI) momentum sinyali.
const FLOW = {
    ON: num('FLOW_ON', 1), TOP: num('FLOW_TOP', 50), MIN_VOL_USDT: num('FLOW_MIN_VOL', 5e6),
    MIN_PRICE_PCT: num('FLOW_MIN_PRICE_PCT', 0.35), MAX_PRICE_PCT: num('FLOW_MAX_PRICE_PCT', 2.5),
    MIN_OI_PCT: num('FLOW_MIN_OI_PCT', 0.35), MIN_VOL_X: num('FLOW_MIN_VOL_X', 1.5),
    COOLDOWN_MS: num('FLOW_COOLDOWN_MIN', 30) * M1, FRESH_MIN: num('FLOW_FRESH_MIN', 10),
    SCAN_MS: M5, MAX_PER_SCAN: num('FLOW_MAX_PER_SCAN', 8),
    // v49: stop / hedef planı
    STOP_ATR: num('FLOW_STOP_ATR', 2.5),            // minimum stop mesafesi = 2.5 × ATR(5m)
    SWING_BARS: num('FLOW_SWING_BARS', 12), SWING_BUF: num('FLOW_SWING_BUF', 0.3), // yapısal stop: son 12 mumun dibi/tepesi ± 0.3 ATR
    MIN_RISK_PCT: num('FLOW_MIN_RISK_PCT', 1.2),    // en az %1.2 risk
    MAX_RISK_PCT: num('FLOW_MAX_RISK_PCT', 4),      // %4'ten büyük riskli sinyal alınmaz
    TP1_R: num('FLOW_TP1_R', 1), TP2_R: num('FLOW_TP2_R', 2),
    MAX_HOLD: num('FLOW_MAX_HOLD_H', 4) * H1,
    MAX_COST_R: num('FLOW_MAX_COST_R', 0.6),
    RANGE_BARS: num('FLOW_RANGE_BARS', 24),
    WICK_BODY: num('FLOW_WICK_BODY', 0.5),
    RVOL: num('FLOW_RVOL', 2.0),
    ROOM_BARS: num('FLOW_ROOM_BARS', 100),
    ROOM_R: num('FLOW_ROOM_R', 2),
    CHASE_ATR: num('FLOW_CHASE_ATR', 0.5),
    REQ_WICK: num('FLOW_REQ_WICK', 1), REQ_RVOL: num('FLOW_REQ_RVOL', 1),
    REQ_OI: num('FLOW_REQ_OI', 1), REQ_LATE: num('FLOW_REQ_LATE', 1),
    REQ_ROOM: num('FLOW_REQ_ROOM', 1),
    SHADOW: num('FLOW_SHADOW', 1),
    SHADOW_MAX_OPEN: num('FLOW_SHADOW_MAX_OPEN', 60),
    SHADOW_KEEP: num('FLOW_SHADOW_KEEP', 400)
};
const flowRun = { running: false, lastBar: 0, last: 0, ms: 0, supported: null, dg: null };
const TRI_OI = { ON: num('TRI_OI_ON', 1), MIN_PCT: num('TRI_OI_MIN', 0.3), 
    FILTER: num('TRI_OI_FILTER', 0), REF_MIN: num('TRI_OI_REF_MIN', 30), 
    SAMPLE_MS: num('TRI_OI_SAMPLE_MIN', 5) * M1 };
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
    for (let i = 0; i < N; i++) {
        if (rsi14[i] == null || rsi9[i] == null || wt.wt1[i] == null || cci[i] == null || adx[i] == null) continue;
        F[i] = [rsi14[i] / 100, cp((wt.wt1[i] + 100) / 200), cp((cci[i] + 200) / 400), cp(adx[i] / 100), rsi9[i] / 100];
    }
    const y = cl.map((x, i) => i + 4 < N ? Math.sign(cl[i + 4] - x) : null);
    const trv = c.map((x, i) => i === 0 ? x[2] - x[3] : Math.max(x[2] - x[3], Math.abs(x[2] - c[i - 1][4]), Math.abs(x[3] - c[i - 1][4])));
    const atr10 = rmaN(trv, 10);
    const mlState = {}; let stt = 0;
    for (let t = Math.max(0, n - CF.ML_BARS - 6); t <= n; t++) {
        const pred = lorentzPred(F, y, t, CF.K), volOk = atr10[t] != null && trv[t] > atr10[t];
        if (pred > 0 && volOk) stt = 1; else if (pred < 0 && volOk) stt = -1;
        mlState[t] = stt;
    }
    const W = 26, hh = 8, rr = 8, wts = []; for (let j = 0; j < W; j++) wts.push(Math.pow(1 + (j * j) / (2 * rr * hh * hh), -rr));
    const kv = {}, kFrom = Math.max(1, n - 60);
    for (let i = kFrom; i <= n; i++) { let a = 0, ws = 0; for (let j = 0; j < W && i - j >= 0; j++) { a += cl[i - j] * wts[j]; ws += wts[j]; } kv[i] = a / ws; }
    const qq = qqeMod(cl), atr14 = atrAt(c, n, 14);
    if (!(atr14 > 0)) return { skip: 'short' };
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
        for (let i = n; i > n - CF.WT_BARS && wb < 0; i--) {
            const a1 = wt.wt1[i], a0 = wt.wt1[i - 1], b1 = wt.wt2[i], b0 = wt.wt2[i - 1];
            if (a1 == null || a0 == null || b1 == null || b0 == null) continue;
            if (L === 1 ? (a1 > b1 && a0 <= b0 && b1 < 0) : (a1 < b1 && a0 >= b0 && b1 > 0)) wb = i;
        }
        if (wb >= 0) { passes++; chk.wt = n - wb; chk.os = L === 1 ? wt.wt2[wb] <= -CF.OS : wt.wt2[wb] >= CF.OS; } else miss.push('wt');
        const rank = (kOk ? 100 : 0) + passes;
        if (!best || rank > best.rank) best = { rank, passes, L, chk, miss, b, streak, kOk };
    }
    if (!best.kOk) return { skip: 'eksik_kernel' };
    if (best.passes < CF.MIN_PASS) {
        const r = { skip: 'eksik_' + best.miss.join('+') };
        if (best.passes === CF.MIN_PASS - 1) r.near = { dir: best.L === 1 ? 'LONG' : 'SHORT', passes: best.passes, miss: best.miss.join('+') };
        return r;
    }
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
    return {
        id: 'CF_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT, symbol: sym, base: baseOf(sym), dir: cd.dir, strategy: 'CF',
        setup: 'CONFLUENCE', setupName: 'Confluence ' + CF.TF + ' (kernel + ML + QQE MOD + WaveTrend)',
        entry: cd.entry, stop: cd.stop, initialStop: cd.stop,
        tp1: cd.entry + L * cd.riskAbs * CF.TP1_R, tp2: cd.entry + L * cd.riskAbs * CF.TP2_R, tp1R: CF.TP1_R, tp2R: CF.TP2_R, trail: 0,
        riskAbs: cd.riskAbs, riskPct: r2(cd.riskPct), costR: r2(cd.costR), volX: r2(cd.volX), rsi: r2(cd.rsi), atr: cd.atr,
        score: cd.score, passes: cd.passes, checks: cd.checks, chartTf: CF.TF, reg: REG ? REG.regime : '-', aligned: mktBias() ? mktBias() === cd.dir : null,
        time, candleT: cd.candleT, freshMin: CF.FRESH_MIN, lastPrice: cd.entry, mfe: 0, mae: 0, maxHold: CF.MAX_HOLD, status: 'OPEN', trackedTo: cd.candleT
    };
}
function cfMsg(s) {
    const k = s.checks || {}, ok = [];
    if (k.kernel != null) ok.push('Kernel'); if (k.prior != null) ok.push('Ters hareket'); if (k.ml != null) ok.push('ML'); if (k.qqe) ok.push('QQE'); if (k.wt != null) ok.push('WaveTrend' + (k.os ? ' (aşırı bölge)' : ''));
    return (s.dir === 'LONG' ? '🟢 ' : '🔴 ') + '🧩 CONFLUENCE ' + CF.TF.toUpperCase() + ' ' + s.dir + ' ' + s.base + ' — PUAN %' + s.score +
        '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' +
        '\nTP1 ' + fmt(s.tp1) + ' (' + s.tp1R + 'R) | TP2 ' + fmt(s.tp2) + ' (' + s.tp2R + 'R)' +
        '\n✓ ' + ok.join(' ✓ ') + ' (' + (s.passes || ok.length) + '/5)' +
        '\nHacim ' + s.volX.toFixed(1) + 'x' +
        (s.aligned === true ? '\nPiyasa yönü uyumlu' : s.aligned === false ? '\nPiyasa yönü TERS' : '') +
        '\n⏱ ' + CF.FRESH_MIN + ' dk içinde gir\n📈 ' + tvLink(s.base, CF.TF === '4h' ? 240 : CF.TF === '1h' ? 60 : 15);
}
function flowMsg(s) {
    return (s.dir === 'LONG' ? '🟢' : '🔴') + ' ⚡ MOMENTUM FLOW ' + s.dir + ' ' + s.base + ' (kapanışlı kırılım)' +
        '\nGiriş: ' + fmt(s.entry) + (s.level != null ? ' (kırılan seviye ' + fmt(s.level) + ')' : '') +
        '\nStop: ' + fmt(s.stop) + ' (risk %' + s.riskPct.toFixed(2) + ', maliyet ' + s.costR.toFixed(2) + 'R)' +
        '\nTP1: ' + fmt(s.tp1) + ' (' + s.tp1R + 'R) | TP2: ' + fmt(s.tp2) + ' (' + s.tp2R + 'R)' +
        '\nFitil/gövde: ' + s.wickR + ' | Hacim: ' + s.volX + 'x | OI: ' + (s.oiPct > 0 ? '+' : '') + s.oiPct + '% | Boşluk: ' + (s.roomR >= 99 ? 'açık' : s.roomR + 'R') +
        '\nSinyal puanı: ' + s.score + '/100 (olasılık değildir)' +
        (s.aligned === true ? '\nPiyasa yönü uyumlu' : s.aligned === false ? '\nPiyasa yönü TERS' : '') +
        '\n⏱ ' + FLOW.FRESH_MIN + ' dk içinde gir, sonrası eski sayılır' +
        '\n📈 ' + tvLink(s.base, 5);
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
    flowRun.running = true;
    const t0 = Date.now();
    try {
        if (ex.has && ex.has.fetchOpenInterest === false) {
            flowRun.supported = false;
            flowRun.dg = { error: 'Bu CCXT/Bitget sürümünde fetchOpenInterest desteklenmiyor.' };
            flowRun.lastBar = bar;
            return;
        }
        const list = universe.filter(sym => ((tickers[sym] || {}).quoteVolume || 0) >= FLOW.MIN_VOL_USDT).slice(0, FLOW.TOP);
        const NEED = Math.max(FLOW.ROOM_BARS, FLOW.RANGE_BARS) + 30;
        const candidates = [];
        const dg = { list: list.length, checked: 0, oiMissing: 0, baseline: 0, signal: 0, shadow: 0, skipped: {}, errors: 0, t: now,
            funnel: { brk: 0, plan: 0, wick: 0, rvol: 0, oi: 0, late: 0, room: 0, signal: 0 },
            single: { wick: 0, rvol: 0, oi: 0, late: 0, room: 0 } };
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
                    const hist = flowOi.get(sym) || [];
                    const last = hist.length ? hist[hist.length - 1] : null;
                    hist.push({ t: now, oi });
                    while (hist.length > 6 || (hist.length && now - hist[0].t > 40 * M1)) hist.shift();
                    flowOi.set(sym, hist);
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
            return {
                id: (shadow ? 'FLOWSH_' : 'FLOW_') + cd.sym.replace(/[^A-Z0-9]/g, '') + '_' + cd.candleT,
                symbol: cd.sym, base: baseOf(cd.sym), dir: cd.dir, strategy: 'FLOW', shadow: !!shadow, fails: fails || [],
                setup: 'FLOW_BREAK', setupName: 'Flow kırılım',
                entry, stop, initialStop: stop, level: cd.level,
                tp1: entry + L * riskAbs * FLOW.TP1_R, tp2: entry + L * riskAbs * FLOW.TP2_R,
                tp1R: FLOW.TP1_R, tp2R: FLOW.TP2_R, trail: 0,
                riskAbs, riskPct: r2(riskPct), costR: r2(costR), atr: cd.atr5,
                planV: 3, lastPrice: entry, mfe: 0, mae: 0, maxHold: FLOW.MAX_HOLD, trackedTo: cd.time,
                signalClose: cd.price, time: cd.time, candleT: cd.candleT, chartTf: '5m', freshMin: FLOW.FRESH_MIN,
                reg: REG ? REG.regime : '-', aligned: bias ? bias === cd.dir : null,
                pricePct: r2(cd.pricePct), oiPct: r2(cd.oiPct), volX: r2(cd.volX), wickR: r2(cd.wickR), roomR: r2(roomR), flags: f, score,
                status: 'OPEN'
            };
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
            const f = {
                wick: cd.wickR <= FLOW.WICK_BODY,
                rvol: cd.volX >= FLOW.RVOL,
                oi: cd.oiPct >= FLOW.MIN_OI_PCT,
                late: Math.abs(cd.pricePct) <= FLOW.MAX_PRICE_PCT && Math.abs(cd.pricePct) >= FLOW.MIN_PRICE_PCT,
                room: roomR >= FLOW.ROOM_R
            };
            let alive = true;
            for (const k of ['wick', 'rvol', 'oi', 'late', 'room']) {
                if (f[k]) dg.single[k]++;
                if (alive) { if (f[k]) dg.funnel[k]++; else alive = false; }
            }
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
    if (!force) {
        if (cfRun.lastBar === bar || t0 - bar < CF.DELAY_MS || t0 < cfRun.retryAt) return;
        if (!first && t0 - bar > CF.WINDOW_MIN * 60e3) return;
    }
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
                    if (!r.cand) {
                        dg.skip[r.skip] = (dg.skip[r.skip] || 0) + 1;
                        if (r.near) near.push(Object.assign({ b: baseOf(sym) }, r.near));
                        continue;
                    }
                    dg.cand++;
                    cands.push(Object.assign({ sym }, r.cand));
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
        near.sort((a, b) => b.passes - a.passes);
        dg.near = near.slice(0, 8);
        cfRun.dg = dg;
        if (cfRun.tryBar !== bar) { cfRun.tryBar = bar; cfRun.tries = 0; }
        cfRun.tries++;
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
const struct = {}, volCache = new Map();
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
        // v49 göçü: stop/hedefi olmayan eski FLOW kayıtları takip edilemez → kapat
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
    if (TRI_TF === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); return closedOnly(aggregateN(c1h, H1, 2), H2); }
    if (TRI_TF === '1h') return closedOnly(await safeFetch(ex, sym, '1h', 400), H1);
    return closedOnly(await safeFetch(ex, sym, '15m', 500), M15);
}
async function refreshTickers() {
    try {
        await sleep(200);
        const t = await ex.fetchTickers(); tickers = t; market.lastTick = Date.now();
        for (const s of [BTC, ETH]) if (t[s]) { const key = s === BTC ? 'btc' : 'eth'; market[key] = { price: t[s].last, chg: t[s].percentage }; }
        for (const list of [signals, trendSignals, brkEvents]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
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
    return '🔔 ÜÇGEN KIRILIM ' + (e.dir === 'LONG' ? '🟢 ' : '🔴 ') + e.dir + ' ' + e.base + ' — ' + e.type + ' üçgen ' + (e.dir === 'LONG' ? 'yukarı' : 'aşağı') +
        '\nGüç %' + e.strength + ' ' + strLabel(e.strength) + ' | Hacim ' + e.volX.toFixed(1) + 'x | Piyasa: ' + e.reg +
        '\nGiriş ' + fmt(e.entry) + ' | Stop ' + fmt(e.stop) + ' | TP1 ' + fmt(e.tp1) + ' | TP2 ' + fmt(e.tp2) +
        (e.costR != null ? '\nRisk %' + e.riskPct.toFixed(2) + ' | Maliyet ' + e.costR.toFixed(2) + 'R' : '') +
        '\n⏱ ' + CFG.FRESH_ENTRY_MIN + ' dk içinde gir, sonrası eski sayılır' +
        '\n📈 ' + tvLink(e.base, TRI_TF === '2h' ? 120 : 15);
}
function buildStruct(S, t0, ms) {
    const o = { t: t0, lines: [] };
    if (S.c2 && S.c2.length >= 50) {
        const tri = detectTriangle(S.c2, S.c2.length - 1, CFG);
        if (tri) {
            const pk = pack(tri, S.c2, ms);
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
function planTrade(st, dir, P, vals, v) {
    const L = dir === 'LONG' ? 1 : -1;
    const line = L === 1 ? vals.R : vals.S;
    const stopFromLine = line - L * CFG.STOP_ATR15 * v.atr15;
    const stopFromPct = P - L * P * CFG.STOP_MIN_PCT / 100;
    const stop = L === 1 ? Math.min(stopFromLine, stopFromPct) : Math.max(stopFromLine, stopFromPct);
    const risk = L * (P - stop); if (!(risk > 0)) return null;
    const riskPct = risk / P * 100;
    if (riskPct < CFG.MIN_RISK_PCT || riskPct > CFG.MAX_RISK_PCT) return null;
    const rawR = L * (line + L * st.w0 - P) / risk;
    if (rawR < CFG.MIN_RR) return null;
    return { stop, riskPct, tp1R: CFG.BRK_TP1_R, tp2R: Math.min(Math.max(rawR, CFG.BRK_TP2_R), CFG.MAX_TP2R), line };
}
function virtualPlan(L, lineP, atr1h, v) {
    const a15 = v && v.atr15 > 0 ? v.atr15 : atr1h * 0.5;
    const sf = lineP - L * CFG.STOP_ATR15 * a15, sp = lineP - L * lineP * CFG.STOP_MIN_PCT / 100;
    const stop = L === 1 ? Math.min(sf, sp) : Math.max(sf, sp);
    const risk = L * (lineP - stop); if (!(risk > 0)) return null;
    return { entry: lineP, stop, riskAbs: risk, riskPct: r2(risk / lineP * 100), tp1: lineP + L * risk * CFG.BRK_TP1_R, tp2: lineP + L * risk * CFG.BRK_TP2_R };
}
function rsOf(sym) { const a = regime.chg(sym), b = regime.chg(BTC); return a == null || b == null ? null : a - b; }

// ======================= TREND TAKİP (FLOW + CF) =======================
// v49: FLOW sinyalleri de takip edilir (stop → STOP, TP1 → stop girişe, TP2, SÜRE)
function trTrack(now) {
    for (const s of trendSignals) {
        if (!isOpen(s) || !s.riskAbs) continue;
        const t = tickers[s.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = s.dir === 'LONG' ? 1 : -1;
        s.lastPrice = P;
        let res = null;
        const r = L * (P - s.entry) / s.riskAbs;
        s.mfe = Math.max(s.mfe || 0, r); s.mae = Math.min(s.mae || 0, r);
        if (s.status === 'OPEN') {
            if (L * (P - s.stop) <= 0) { s.status = 'STOP'; res = -1; }
            else if (r >= s.tp1R) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = now; dirty = true; }
        } else if (s.status === 'TP1') {
            if (L * (P - s.stop) <= 0) { s.status = 'BE'; res = 0.5 * s.tp1R + 0.5 * r; }
            else if (r >= s.tp2R) { s.status = 'TP2'; res = 0.5 * s.tp1R + 0.5 * s.tp2R; }
        }
        if (res == null && isOpen(s) && now - s.time > s.maxHold) { res = s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r; s.status = 'SÜRE'; }
        if (res != null) { s.closedAt = now; s.exitPrice = P; s.grossR = r2(res); s.netR = r2(res - (s.costR || 0)); dirty = true; }
    }
    // v49: gölge takip
    for (const sh of flowShadow) {
        if (!isOpen(sh) || !sh.riskAbs) continue;
        const t = tickers[sh.symbol]; if (!t || !t.last) continue;
        const P = t.last, L = sh.dir === 'LONG' ? 1 : -1;
        sh.lastPrice = P;
        let res = null;
        const r = L * (P - sh.entry) / sh.riskAbs;
        sh.mfe = Math.max(sh.mfe || 0, r); sh.mae = Math.min(sh.mae || 0, r);
        if (sh.status === 'OPEN') {
            if (L * (P - sh.stop) <= 0) { sh.status = 'STOP'; res = -1; }
            else if (r >= sh.tp1R) { sh.status = 'TP1'; sh.stop = sh.entry; sh.tp1At = now; }
        } else if (sh.status === 'TP1') {
            if (L * (P - sh.stop) <= 0) { sh.status = 'BE'; res = 0.5 * sh.tp1R + 0.5 * r; }
            else if (r >= sh.tp2R) { sh.status = 'TP2'; res = 0.5 * sh.tp1R + 0.5 * sh.tp2R; }
        }
        if (res == null && isOpen(sh) && now - sh.time > sh.maxHold) { res = sh.status === 'TP1' ? 0.5 * sh.tp1R + 0.5 * r : r; sh.status = 'SÜRE'; }
        if (res != null) { sh.closedAt = now; sh.exitPrice = P; sh.grossR = r2(res); sh.netR = r2(res - (sh.costR || 0)); dirty = true; }
    }
}

// ======================= İSTATİSTİK =======================
const trBucket = s => s.score == null ? 'puan yok' : s.score >= 80 ? 'Puan 80+' : s.score >= 70 ? 'Puan 70-79' : s.score >= 60 ? 'Puan 60-69' : 'Puan <60';
const trStratName = s => s.strategy === 'FLOW' ? 'Momentum Flow 5m' : 'Confluence ' + CF.TF;
function trStatsCalc() {
    const closed = trendSignals.filter(s => (s.strategy === 'CF' || s.strategy === 'FLOW') && !isOpen(s) && s.netR != null);
    return {
        all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))),
        bySetup: groupBy(closed, trStratName),
        byScore: groupBy(closed, trBucket),
        byDir: groupBy(closed, s => s.dir),
        byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x'),
        byReg: groupBy(closed, s => 'rejim ' + (s.reg || '-')),
        byCost: groupBy(closed, s => s.costR <= 0.1 ? 'maliyet ≤0.1R' : s.costR <= 0.2 ? 'maliyet 0.1-0.2R' : 'maliyet >0.2R'),
        byPlan: groupBy(closed, s => s.strategy === 'FLOW' ? (s.planV === 2 ? 'Flow v2 (yapısal stop)' : 'Flow v1 (dar stop)') : 'Confluence'),
        byAlign: groupBy(closed, s => s.aligned === true ? 'piyasa uyumlu' : s.aligned === false ? 'piyasa ters' : 'piyasa nötr'),
        byExit: groupBy(closed, s => s.status)
    };
}
function brkStatsCalc() {
    const closed = brkEvents.filter(s => !isOpen(s) && s.netR != null);
    return {
        all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))),
        byStrength: groupBy(closed, s => (s.strength || 0) >= 75 ? 'Güç 75+' : (s.strength || 0) >= 55 ? 'Güç 55-74' : 'Güç <55'),
        byDir: groupBy(closed, s => s.dir),
        byType: groupBy(closed, s => s.type),
        byExit: groupBy(closed, s => s.status)
    };
}
function flowShadowStatsCalc() {
    const closed = flowShadow.filter(s => !isOpen(s) && s.netR != null);
    const failsB = {};
    for (const s of closed) for (const f of (s.fails || [])) { (failsB[f] = failsB[f] || []).push(s); }
    const byFail = {};
    for (const k of Object.keys(failsB).sort()) byFail['sadece ' + k + ' takıldı'] = grp(failsB[k]);
    return {
        all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === trDay(Date.now()))),
        byDir: groupBy(closed, s => s.dir),
        byExit: groupBy(closed, s => s.status),
        byFail,
        byVol: groupBy(closed, s => s.volX >= 2 ? 'hacim 2x+' : s.volX >= 1.3 ? 'hacim 1.3-2x' : 'hacim <1.3x')
    };
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
        trTrack(now);
        brkTrack(now);

        // ===== YAKLAŞAN ÜÇGENLER İÇİN ERKEN UYARI =====
        if (TR.TG) {
            for (const sym of Object.keys(struct)) {
                const st = struct[sym], tk = tickers[sym];
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
                telegram('⚠️ KIRILIM YAKIN ' + (bias === 'LONG' ? '🟢 ' : '🔴 ') + bias + ' ' + baseOf(sym) +
                    '\n' + st.type + ' üçgen • ' + (bias === 'LONG' ? 'üst' : 'alt') + ' çizgiye ' + dist.toFixed(2) + ' ATR (' + fmt(linePrice) + ')' +
                    '\nHacim ' + v.volX.toFixed(1) + 'x • Güç %' + strength + ' ' + strLabel(strength) +
                    '\nKırılım henüz YOK. Fiyat çizgiyi geçerse ayrı sinyal gelir.' +
                    '\n📈 ' + tvLink(baseOf(sym), TRI_TF === '2h' ? 120 : 15));
            }
        }

        const rad = [];
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > 4 * TRI_MS) continue;
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
            const item = { symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, dir: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type,
                volX: r2(v.volX), strength: pre, broke, rs: rs == null ? null : r2(rs), aligned,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)' };
            if (broke) { const vp = virtualPlan(L, cand.v, atr, v); if (vp) Object.assign(item, vp, { virtual: true }); }
            const bkey = sym + '|' + cand.bias;
            if (broke) { if (!brokeAt[bkey]) brokeAt[bkey] = now; item.brokeAt = brokeAt[bkey]; item.ageUnsure = brokeAt[bkey] - firstScanAt < 20e3; }
            rad.push(item);

            if (!broke) continue;
            const br = evalBreakout(st, cand.bias, P, now, v);
            if (!br) continue;
            const sk = 'BRK|' + sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            if (brkEvents.some(x => x.symbol === sym && x.dir === cand.bias && isOpen(x))) continue;
            if (CFG.BRK_REG_FILTER && REG && REG.dir !== 'NÖTR' && REG.dir !== cand.bias) continue;
            if (CFG.BRK_REG_FILTER >= 2 && (!REG || REG.dir !== cand.bias)) continue;
            const plan = planTrade(st, cand.bias, P, vals, v);
            if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, cand.bias, rs);
            if (strength < CFG.MIN_STRENGTH) continue;
            if (cand.bias === 'LONG' && !(REG && REG.dir === 'LONG') && strength < CFG.BRK_LONG_MIN_STR) continue;
            const qv = (tickers[sym] || {}).quoteVolume || 0;
            if (qv < CFG.MIN_SIG_VOL) continue;
            const entry = P, stop = plan.stop;
            const riskAbs = L * (P - stop); if (!(riskAbs > 0)) continue;
            const riskPct = plan.riskPct;
            const costR = (costFor(qv) + 2 * CFG.SLIP_PCT) / riskPct;
            if (costR > CFG.MAX_COST_R) continue;
            let triOi = null;
            if (TRI_OI.ON) {
                try { await triOiSample(sym); triOi = triOiPct(sym); } catch (e) { }
                if (TRI_OI.FILTER && triOi != null && triOi < TRI_OI.MIN_PCT) { triOiStat.filtered++; continue; }
            }
            const ev = {
                id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', tf: TRI_TF, symbol: sym, base: baseOf(sym), dir: cand.bias, time: now,
                price: P, line: cand.v, type: st.type, touches: st.touches, squeeze: st.squeeze, volX: r2(br.vol), ext: r2(br.ext), strength,
                aligned, rs: rs == null ? null : r2(rs), reg: REG ? REG.dir : '-',
                entry, stop, initialStop: stop, riskAbs, riskPct: r2(riskPct), costR: r2(costR),
                tp1: P + L * riskAbs * CFG.BRK_TP1_R, tp2: P + L * riskAbs * CFG.BRK_TP2_R, tp1R: CFG.BRK_TP1_R, tp2R: CFG.BRK_TP2_R,
                status: 'OPEN', lastPrice: P, mfe: 0, mae: 0, trackedTo: now,
                triOiPct: triOi == null ? null : r2(triOi)
            };
            brkEvents.unshift(ev);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM', ev.dir, ev.base, ev.type, 'güç', strength, 'hacim', br.vol.toFixed(1), 'entry', fmt(P), 'stop', fmt(stop), 'risk %' + riskPct.toFixed(2));
            telegram(brkMsg(ev));
        }
        { const liveKeys = new Set(rad.filter(x => x.broke).map(x => x.symbol + '|' + x.bias)); for (const k of Object.keys(brokeAt)) if (!liveKeys.has(k)) delete brokeAt[k]; }
        triRadar = rad.sort((a, b) => a.rank - b.rank).slice(0, 40);
        live.last = Date.now(); live.ms = live.last - t0; live.n = Object.keys(struct).length;
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
        if (L * (P - b.stop) <= 0) {
            if (afterTp1) { b.status = 'BE'; res = 0.5 * CFG.BRK_TP1_R; }
            else { b.status = 'STOP'; res = -1; }
        } else if (r >= CFG.BRK_TP2_R) {
            res = afterTp1 ? 0.5 * CFG.BRK_TP1_R + 0.5 * CFG.BRK_TP2_R : CFG.BRK_TP2_R;
            b.status = 'TP2';
        } else if (!afterTp1 && r >= CFG.BRK_TP1_R) {
            b.status = 'TP1'; b.stop = b.entry; b.tp1At = now; dirty = true;
        } else if (now - b.time > CFG.BRK_EXPIRE_H * H1) {
            res = afterTp1 ? 0.5 * CFG.BRK_TP1_R + 0.5 * r : r; b.status = 'SÜRE';
        }
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
                const stc = buildStruct(s, t0, TRI_MS);
                if (stc && stc.lines && stc.lines.length) struct[sym] = stc;
                else if (!(struct[sym] && t0 - struct[sym].t < CFG.GRACE_MIN * 60e3)) delete struct[sym];
            } catch (e) { }
        }
        for (const k of Object.keys(struct)) if (!universe.includes(k)) delete struct[k];
        for (const [k, v] of volCache) if (Date.now() - v.t > 5 * 60e3) volCache.delete(k);
        scan.last = Date.now(); scan.ms = scan.last - t0; if (!firstScanAt) firstScanAt = scan.last;
        log('tarama:', Object.keys(struct).length, 'üçgen (' + TRI_TF + ')');
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

// ======================= BACKTEST =======================
const DAY = 86400e3;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, strategy: 'tri', startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;
const yieldLoop = () => new Promise(r => setImmediate(r));
async function btSymbol(sym, c1h, c15, vol24, startT, tfMs) {
    tfMs = tfMs || H1;
    const hz = tfMs === H2 ? 48 * H1 : 24 * H1;
    const trades = [], busy = {}, lastT = {};
    let st = null, h = 0, lastH = -1;
    for (let k = 31; k < c15.length - 1; k++) {
        if (k % 300 === 0) await yieldLoop();
        const bk = c15[k], now = c15[k + 1][0];
        if (bk[0] < startT) continue;
        while (h < c1h.length && c1h[h][0] + tfMs <= now) h++;
        if (h !== lastH && h >= 60) {
            lastH = h;
            const arr = c1h.slice(Math.max(0, h - 400), h);
            if (hasGap(arr, tfMs, CFG.TRI_LOOK)) st = null;
            else { const ns = buildStruct({ c2: arr }, now, tfMs); if (ns.lines.length) st = ns; else if (st) st.dead = true; }
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
            const sk = dir;
            if (now - (lastT[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
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
                tp2R: r2(sig.tp2R), status: sig.status, netR: sig.netR, t: now, fp: firstPass(sig, c15, k + 1, hz) });
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
        trades.push({ sym, dir: cd.dir, score: cd.score, vol: r2(cd.volX),
            costR: sig.costR, riskPct: sig.riskPct, mfe: r2(sig.mfe),
            status: sig.status, netR: sig.netR, t: tc,
            fp: firstPass(sig, c, j, 10 * 24 * H1) });
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
    verdict += ' Maliyet öncesi ort. R: ' + (g.gross >= 0 ? '+' : '') + g.gross.toFixed(2) + '. Sinyal yönü doğruluğu için aşağıdaki "Sinyal isabeti" tablosuna bak.';
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
        base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b },
            'Yön': groupBy(t, x => x.dir), 'Puan': groupBy(t, scB),
            'Hacim': groupBy(t, vB), 'Risk %': groupBy(t, riskB),
            'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
        return base;
    }
    const volB = x => x.vol >= 2.5 ? 'hacim 2.5x+' : x.vol >= 1.8 ? 'hacim 1.8-2.5x' : 'hacim 1.3-1.8x';
    const extB = x => x.ext <= 0.3 ? 'çizgi ötesi ≤0.3' : x.ext <= 0.45 ? 'çizgi ötesi 0.3-0.45' : 'çizgi ötesi >0.45';
    base.tables = { 'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b },
        'Yön': groupBy(t, x => x.dir), 'Üçgen tipi': groupBy(t, x => x.type), 'Güç': groupBy(t, strBucket),
        'Kırılım hacmi': groupBy(t, volB), 'Çizgi ötesi (ATR)': groupBy(t, extB), 'Risk %': groupBy(t, riskB), 'Ay': groupBy(t, x => new Date(x.t).toISOString().slice(0, 7)), 'Çıkış': groupBy(t, x => x.status) };
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
    strategy = strategy === 'cf' || strategy === 'tri2' ? strategy : 'tri';
    bt = { running: true, i: 0, total: 0, sym: '', days, n, strategy, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt[BT_EX]({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const minV = strategy === 'cf' ? TR.MIN_VOL : CFG.MIN_SIG_VOL;
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear &&
            !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= minV && !isSuspect(t.symbol))
            .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
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
                    const two = strategy === 'tri2';
                    const c1h = await btFetchAll(exBT, t.symbol, '1h', H1, start - (two ? 22 : 9) * DAY);
                    const cs = two ? aggregateN(c1h, H1, 2) : c1h;
                    all = all.concat(await btSymbol(t.symbol, cs, c15, t.quoteVolume, start, two ? H2 : H1));
                }
            } catch (e) { skipped++; }
            bt.i++;
            await sleep(500);
        }
        bt.result = btReport(all, strategy === 'cf' ? 'cf' : 'tri');
        Object.assign(bt.result, { skipped, coins: list.length, requested: n, days, coverage: cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : 0, exchange: BT_EX, dataFrom: firstTs.length ? firstTs.slice().sort((a, b) => a - b)[firstTs.length >> 1] : 0 });
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
    const radSyms = new Set(triRadar.map(x => x.symbol)), forming = [];
    for (const sym of Object.keys(struct)) {
        if (radSyms.has(sym)) continue;
        const stx = struct[sym], tk = tickers[sym];
        if (!stx || !tk || !tk.last || now - stx.t > 4 * TRI_MS) continue;
        const v = lineValues(stx, now); if (v.R == null || v.S == null || v.R <= v.S) continue;
        const atr = stx.lines[0].atr; if (!(atr > 0)) continue;
        forming.push({ symbol: sym, base: baseOf(sym), price: tk.last, type: stx.type, touches: stx.touches, toUp: (v.R - tk.last) / atr, toDn: (tk.last - v.S) / atr });
    }
    forming.sort((a, b) => Math.min(Math.abs(a.toUp), Math.abs(a.toDn)) - Math.min(Math.abs(b.toUp), Math.abs(b.toDn)));
    return {
        now, mode: 'v49 • Üçgen(' + TRI_TF + ') + Momentum Flow(5m, OI + hacim + stop/TP)',
        px, market, regime: REG,
        tr: trendSignals.slice(0, 80), trStats: trStatsCalc(),
        trInfo: { strategy: 'FLOW', last: flowRun.last, ms: flowRun.ms, running: flowRun.running, tf: '5m', flow: flowRun.dg, cfDisabled: !CF.ON, minVol: TR.MIN_VOL, notify: TR.NOTIFY, top: TR.TOP, maxOpen: TR.MAX_OPEN, minPass: CF.MIN_PASS, minVolX: CF.MIN_VOL_X,
            perScan: CF.MAX_PER_SCAN, freshMin: FLOW.FRESH_MIN, nextBar: Math.floor(Date.now() / FLOW.SCAN_MS) * FLOW.SCAN_MS + FLOW.SCAN_MS, lastBar: flowRun.lastBar, cfDg: cfRun.dg || null,
            flowStopAtr: FLOW.STOP_ATR, flowTp1: FLOW.TP1_R, flowTp2: FLOW.TP2_R, flowMaxHoldH: FLOW.MAX_HOLD / H1 },
        breakouts: brkEvents.slice(0, 80), brkStats: brkStatsCalc(),
        flowShadow: flowShadow.slice(0, 60), flowShadowStats: flowShadowStatsCalc(),
        brkInfo: { tp1: CFG.BRK_TP1_R, tp2: CFG.BRK_TP2_R, expireH: CFG.BRK_EXPIRE_H, stopAtr: CFG.STOP_ATR15, cd: CFG.COOLDOWN_MIN, triTf: TRI_TF, nearAtr: CFG.NEAR_ATR },
        radar: triRadar, forming: forming.slice(0, 30),
        tri: { tf: TRI_TF, structs: Object.keys(struct).length, scanLast: scan.last, scanMs: scan.ms, liveLast: live.last, liveErr: live.err, nearWarnVolX: CFG.NEAR_WARN_VOL_X, nearWarnCdMin: CFG.NEAR_WARN_CD_MIN },
        stats: st,
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.COOLDOWN_MIN, freshMin: CFG.FRESH_ENTRY_MIN, cfTf: CF.TF },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible, minVol: CFG.MIN_VOL_USDT, drop: scan.drop }
    };
}
async function apiCandles(sym, reqTf) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const useTf = reqTf || TRI_TF;
    const key = sym + '|' + useTf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let c, dur, tf;
    if (useTf === '5m') { c = await safeFetch(ex, sym, '5m', 400); dur = M5; tf = '5m'; }
    else if (useTf === '15m') { c = await safeFetch(ex, sym, '15m', 400); dur = M15; tf = '15m'; }
    else if (useTf === '4h') { c = await safeFetch(ex, sym, '4h', 400); dur = H4; tf = '4H'; }
    else if (useTf === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); c = aggregateN(c1h, H1, 2); dur = H2; tf = '2H'; }
    else { c = await safeFetch(ex, sym, '1h', 400); dur = H1; tf = '1H'; }
    const cl = clOf(c);
    const e21 = emaN(cl, 21), e50 = emaN(cl, 50), vs = volSma(c, 20);
    let tri = null;
    if (c.length > 50) { const t = detectTriangle(c, c.length - 1, CFG) || detectTriangle(c, c.length - 2, CFG); if (t) tri = pack(t, c, dur); }
    const cut = Math.max(0, c.length - 130);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur, tri };
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ======================= ARAYÜZ =======================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER TRADE</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff;--pp:#b794f4}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}.chip b{color:var(--dm);font-weight:600}
.chip.big{padding:5px 11px;border-width:2px}.chip.big b{font-size:11px;text-transform:uppercase;letter-spacing:.3px}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}.grow{flex:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:440px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:11px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.list{flex:1;overflow:auto;padding:8px}.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card.sel{border-color:var(--am);box-shadow:0 0 0 1px var(--am)}.card.closed{opacity:.7}.card.old{opacity:.82}
.card.L{border-left:5px solid var(--lg);background:linear-gradient(90deg,rgba(61,220,151,.09),var(--p2) 45%)}
.card.S{border-left:5px solid var(--st);background:linear-gradient(90deg,rgba(255,107,122,.09),var(--p2) 45%)}
.r1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dirb{font-weight:800;font-size:13px;padding:4px 12px;border-radius:5px;letter-spacing:.3px}
.dirb.L{background:var(--lg);color:#08130d}.dirb.S{background:var(--st);color:#1a0508}
.strat{font-weight:800;font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid}
.strat.tr{color:#b794f4;border-color:#b794f4;background:rgba(183,148,244,.10)}
.strat.tri{color:var(--bl);border-color:var(--bl);background:rgba(90,169,255,.10)}
.strat.rad{color:var(--dm);border-color:var(--dm)}
.coin{font-weight:800;font-size:14px}.sc{margin-left:auto;font-weight:800;font-size:15px}.sc small{font-size:11px;opacity:.85}
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
.pnl{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;padding:10px 14px;border-radius:8px;border:2px solid var(--ln);margin-bottom:10px;background:var(--p2)}
.pnl.kar{border-color:var(--lg);background:rgba(61,220,151,.08)}.pnl.zarar{border-color:var(--st);background:rgba(255,107,122,.08)}
.pnl b{font-size:22px;display:block}.pnl .pl{font-size:10px;color:var(--dm);text-transform:uppercase;letter-spacing:.4px}
.why{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:8px 10px;margin:10px 0;font-size:12px;color:var(--dm)}.why b{color:var(--tx)}
canvas{width:100%;height:470px;display:block;background:var(--bg);border:2px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;width:100px}
.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;color:var(--tx)}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.tv{background:#2962ff;color:#fff;text-decoration:none;display:inline-block}
.tfb{display:inline-flex;gap:0;margin-left:auto}.tfb button{background:var(--bg);border:1px solid var(--ln);padding:5px 10px;font-weight:700;font-size:11px;color:var(--dm)}
.tfb button.a{background:var(--am);color:#1a1405;border-color:var(--am)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:320px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v49</small></div>
  <div class="chip big" id="cBtcDir"></div>
  <div class="chip big" id="cReg"></div>
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
var TABS=[['sig','Trend'],['rad','Üçgen Kırılım'],['stat','İstatistik'],['bt','Backtest']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='sig',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastSigT=0,lastTrT=0,toastT=null;
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;x=Number(x);if(isNaN(x))return'-';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function FM(){return (S&&S.config&&S.config.freshMin)||10}
function isFresh(o){return o.status==='OPEN'&&(Date.now()-o.time)<((o.freshMin||FM()))*60e3}
function ageTag(o){if(!o||o.status!=='OPEN')return'';var m=Math.floor((Date.now()-o.time)/60000);
 return m<(o.freshMin||FM())?'<span class="tag g">🟢 TAZE '+m+' dk • giriş açık</span>':'<span class="tag r">⏳ ESKİ '+ago(o.time)+' • girme, sadece takip</span>'}
function strTag(s){var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};return '<span class="tag '+x.c+'">GÜÇ %'+s+' '+x.l+'</span>'}
function volTag(v){var c=v>=1.5?'g':v>=1.0?'w':'r';return '<span class="tag '+c+'">Hacim '+f2(v,1)+'x</span>'}
function scTag(s){if(s==null)return '<span class="tag">puan yok</span>';var x=s>=80?['ÇOK GÜÇLÜ','g']:s>=70?['GÜÇLÜ','g']:['ORTA','w'];return '<span class="tag '+x[1]+'" style="font-weight:800">PUAN %'+s+' '+x[0]+'</span>'}
function passTag(p){var x=p>=5?['5/5','g']:p>=4?['4/5','g']:p>=3?['3/5','w']:['2/5','r'];return '<span class="tag '+x[1]+'">'+x[0]+'</span>'}
function stratTag(k){return k==='tr'?'<span class="strat tr">🧩 CONFLUENCE</span>':k==='brk'?'<span class="strat tri">△ ÜÇGEN KIRILIM</span>':'<span class="strat rad">◎ ÜÇGEN RADAR</span>'}
function stratName(k,o){return k==='tr'?(o&&o.strategy==='FLOW'?'MOMENTUM FLOW '+((o.chartTf||'5m').toUpperCase()):'CONFLUENCE '+((o&&o.chartTf||'').toUpperCase())):k==='brk'?'ÜÇGEN KIRILIM':'ÜÇGEN RADAR'+(o&&o.broke?' • ONAYSIZ KIRILIM':'')}
function dirBadge(d){return '<span class="dirb '+(d==='LONG'?'L':'S')+'">'+(d==='LONG'?'▲ LONG':'▼ SHORT')+'</span>'}
function tvl(sym,iv){return '<a target="_blank" style="color:var(--bl);text-decoration:none;font-weight:700;font-size:11px" href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sym.split('/')[0])+'USDT.P&interval='+iv+'" onclick="event.stopPropagation()">📈 TV</a>'}
var ST={OPEN:['AÇIK','w'],TP1:['TP1 ✓','g'],TP2:['TP2 ✓','g'],TRAIL:['TRAIL ✓','g'],BE:['BE','w'],STOP:['STOP','r'],'SÜRE':['SÜRE','w'],TIMEOUT:['SÜRE','w'],EXPIRED:['SÜRESİ DOLDU','w']};
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.textContent=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor='';$('main').removeAttribute('data-view')}
function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastSigT){lastSigT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastSigT});if(mx>lastSigT)lastSigT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('🔔 ÜÇGEN KIRILIM '+e.dir+' '+e.base+' — GÜÇ %'+e.strength,function(){tab='rad';pick('brk',e.id,e.symbol);renderAll()})}}
function checkTr(){var a=S.tr||[],nt=(S.trInfo||{}).notify||0,mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastTrT){lastTrT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastTrT&&x.score>=nt});if(mx>lastTrT)lastTrT=mx;
 if(nw.length){beep();setTimeout(beep,400);var s=nw[0];showToast('🔔 '+(s.strategy==='FLOW'?'MOMENTUM FLOW':'CONFLUENCE')+' '+s.dir+' '+s.base+' — PUAN %'+s.score,function(){tab='sig';pick('tr',s.id,s.symbol);renderAll()})}}

// v49: TP1 alınmış açık pozisyonda realize edilen yarım kâr dahil toplam R/% hesaplanır
function posInfo(o){if(!o||o.entry==null||!o.riskAbs)return null;
 var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.entry,open=isOp(o),fin=!open&&o.netR!=null;
 var raw=L*(px-o.entry)/o.riskAbs,rawPct=L*(px-o.entry)/o.entry*100,t1=o.tp1R||((S.brkInfo&&S.brkInfo.tp1)||1),rp=o.riskPct||0,r,pct;
 if(fin){r=o.netR;pct=(o.grossR!=null?o.grossR:o.netR)*rp}
 else if(o.status==='TP1'){r=0.5*t1+0.5*raw;pct=0.5*t1*rp+0.5*rawPct}
 else{r=raw;pct=rawPct}
 return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,tp2:o.tp2,t:o.time}}}

function renderTop(){var m=S.market,R=S.regime,sc=S.scan||{},dr=sc.drop||{};
 if(!R)$('cBtcDir').innerHTML='<b>BTC Yön</b> <span class="fl">…</span>';
 else{var bc=R.btcDir==='LONG'?'up':R.btcDir==='SHORT'?'dn':'fl';
  $('cBtcDir').style.borderColor=bc==='up'?'var(--lg)':bc==='dn'?'var(--st)':'var(--ln)';
  $('cBtcDir').innerHTML='<b>BTC</b> <span class="'+bc+'" style="font-weight:800">'+R.btcDir+'</span> <span class="'+bc+'">'+sg(R.btcScore||0,0)+'</span>'}
 if(!R)$('cReg').innerHTML='<b>Piyasa Yön</b> <span class="fl">…</span>';
 else{var c=R.dir==='LONG'?'up':R.dir==='SHORT'?'dn':'fl';
  $('cReg').style.borderColor=c==='up'?'var(--lg)':c==='dn'?'var(--st)':'var(--ln)';
  $('cReg').innerHTML='<b>Piyasa Yön</b> <span class="'+c+'" style="font-weight:800">'+R.dir+'</span> <span class="'+c+'">'+sg(R.score,0)+'</span> <span class="fl">| '+R.regime+(R.breadth?' | ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'</span>'}
 $('cMkt').innerHTML='<b>Piyasa</b> '+sc.universe+' coin <span class="fl">• min '+f2((sc.minVol||0)/1e6,0)+'M$ • hacim altı '+(dr.lowVol||0)+'</span>';
 $('cBTC').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 var A=(S.trStats&&S.trStats.today)||{totalR:0,n:0};var B=(S.brkStats&&S.brkStats.today)||{totalR:0,n:0};
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(A.totalR)+'">Tr '+sg(A.totalR,1)+'R</span> <span class="fl">|</span> <span class="'+cl(B.totalR)+'">Kır '+sg(B.totalR,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var oc=(S.tr||[]).filter(isFresh).length,nr=(S.radar||[]).length,nb=(S.breakouts||[]).filter(isFresh).length,nk=(S.radar||[]).filter(function(x){return x.broke}).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t[0]==='sig'?' (taze '+oc+')':t[0]==='rad'?' (taze '+nb+'/'+nk+'/'+nr+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab!=='stat'&&tab!=='bt')sel=null;if(tab==='bt')pollBT();$('main').removeAttribute('data-view');renderAll()}})}

function trTag(s){return s&&s.strategy==='FLOW'?'<span class="strat tr">⚡ MOMENTUM FLOW 5M</span>':'<span class="strat tr">🧩 CONFLUENCE '+esc((s.chartTf||'').toUpperCase())+'</span>'}
function cfTags(s){if(!s.checks)return'';var k=s.checks,out='';if(k.kernel!=null)out+='<span class="tag g">Kernel ✓</span>';if(k.prior!=null)out+='<span class="tag g">Ters hareket ✓</span>';if(k.ml!=null)out+='<span class="tag g">ML ✓</span>';if(k.qqe)out+='<span class="tag g">QQE ✓</span>';if(k.wt!=null)out+='<span class="tag g">WaveTrend ✓'+(k.os?' aşırı bölge':'')+'</span>';return out}
function alignTag(s){return s.aligned===true?'<span class="tag g">piyasa yönü uyumlu</span>':s.aligned===false?'<span class="tag r">piyasa yönü ters</span>':''}
function trCard(s){var L=s.dir==='LONG'?1:-1,op=isOp(s),old=op&&!isFresh(s);
 var selc=(sel&&sel.kind==='tr'&&sel.id===s.id?' sel':'')+(op?'':' closed')+(old?' old':'');
 var P=posInfo(s),r=P?P.r:0,pct=P?P.pct:0;var st=ST[s.status]||[s.status||'?',''];
 var pn=P?'<span class="sc '+cl(r)+'">'+sg(r)+'R <small>'+sg(pct)+'%</small></span>':'';
 var lvl=s.riskAbs?'<span>Giriş <b>'+fp(s.entry)+'</b></span><span>Stop <b class="zarar">'+fp(s.stop)+'</b></span><span>TP1 <b class="kar">'+fp(s.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(s.tp2)+'</b></span>':'<span>Sinyal fiyatı <b>'+fp(s.entry)+'</b></span>';
 if(s.strategy==='FLOW'){return '<div class="card '+(L===1?'L':'S')+selc+'" data-kind="tr" data-id="'+esc(s.id)+'" data-sym="'+esc(s.symbol)+'"><div class="r1">'+dirBadge(s.dir)+'<span class="coin">'+esc(s.base)+'</span><span class="tag '+(s.score>=75?'g':'w')+'">MOMENTUM '+s.score+'/100</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+trTag(s)+ageTag(s)+alignTag(s)+'<span class="tag '+(s.pricePct>=0?'g':'r')+'">Fiyat '+sg(s.pricePct)+'%</span><span class="tag g">OI +'+f2(s.oiPct)+'%</span>'+volTag(s.volX||0)+'</div><div class="sub">'+lvl+'<span>Şu an <b>'+fp((S.px&&S.px[s.symbol])||s.lastPrice||s.entry)+'</b></span>'+(s.riskPct!=null?'<span>Risk '+f2(s.riskPct)+'%</span>':'')+'<span>'+ago(s.time)+' önce</span></div></div>'}
 return '<div class="card '+(L===1?'L':'S')+selc+'" data-kind="tr" data-id="'+esc(s.id)+'" data-sym="'+esc(s.symbol)+'"><div class="r1">'+dirBadge(s.dir)+'<span class="coin">'+esc(s.base)+'</span>'+scTag(s.score)+passTag(s.passes||0)+'<span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+trTag(s)+ageTag(s)+alignTag(s)+cfTags(s)+'</div><div class="sub">'+lvl+'<span>RSI '+f2(s.rsi,0)+'</span><span>'+volTag(s.volX||0)+'</span><span>'+ago(s.time)+' önce</span></div></div>'}

function radCard(r){var s=r.strength||0,P=(r.broke&&r.entry!=null)?posInfo(r):null;
 var al=r.aligned===true?'<span class="tag g">yön uyumlu</span>':r.aligned===false?'<span class="tag r">yön ters</span>':'';
 var rs=r.rs!=null?'<span class="tag '+(r.rs>0?'g':'r')+'">RS '+sg(r.rs)+'%</span>':'';
 var pn=P?'<span class="sc '+cl(P.r)+'">'+sg(P.r)+'R <small>'+sg(P.pct)+'%</small></span>':'';
 var bm=r.brokeAt?Math.floor((Date.now()-r.brokeAt)/60000):null;
 var at=!r.broke?'':r.ageUnsure?'<span class="tag w">⏱ aşma zamanı bilinmiyor</span>':bm<FM()?'<span class="tag g">🟢 YENİ aştı '+bm+' dk önce</span>':'<span class="tag r">⏳ '+ago(r.brokeAt)+' önce aştı</span>';
 if(r.broke)at+='<span class="tag">sinyal değil • onay bekliyor</span>';
 var lv=P?'<div class="sub"><span>Çizgi <b>'+fp(r.entry)+'</b></span><span>Stop <b class="zarar">'+fp(r.stop)+'</b></span><span>TP1 <b class="kar">'+fp(r.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(r.tp2)+'</b></span></div>':'';
 return '<div class="card '+(r.bias==='LONG'?'L':'S')+(sel&&sel.kind==='rad'&&sel.sym===r.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="r1">'+dirBadge(r.bias)+'<span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag '+(r.broke?'w':'')+'">'+(r.broke?'KIRILDI':'hazır')+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+stratTag('rad')+strTag(s)+al+rs+at+'</div><div class="sub"><span>'+esc(r.state)+'</span></div>'+lv+'</div>'}

function brkCard(e){var P=posInfo(e),L=e.dir==='LONG'?1:-1,op=isOp(e);var st=ST[e.status]||[e.status||'?',''];
 var tp1R=(S.brkInfo&&S.brkInfo.tp1)||1;var old=op&&!isFresh(e);
 var pn=P?'<span class="sc '+cl(P.r)+'">'+sg(P.r)+'R <small>'+sg(P.pct)+'%</small></span>':'';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+(old?' old':'')+(sel&&sel.kind==='brk'&&sel.id===e.id?' sel':'')+'" data-kind="brk" data-id="'+esc(e.id)+'" data-sym="'+esc(e.symbol)+'"><div class="r1">'+dirBadge(e.dir)+'<span class="coin">'+esc(e.base)+'</span><span class="tag w">'+esc(e.type||'')+'</span>'+strTag(e.strength||0)+'<span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+stratTag('brk')+'<span class="tag g">ONAYLI</span>'+volTag(e.volX||0)+ageTag(e)+'</div><div class="sub"><span>'+esc(e.touches||'')+' dokunuş</span><span>TP1 '+tp1R+'R</span>'+(e.entry!=null?'<span>Giriş <b>'+fp(e.entry)+'</b></span><span>Stop <b class="zarar">'+fp(e.stop)+'</b></span>':'')+'<span>'+ago(e.time)+' önce</span></div></div>'}

function shCard(s){var L=s.dir==='LONG'?1:-1,op=isOp(s);
 var curPx=(S.px&&S.px[s.symbol])||s.lastPrice||s.entry;
 var r=op?L*(curPx-s.entry)/s.riskAbs:(s.netR||0);
 var st=ST[s.status]||[s.status||'?',''];
 var fails=(s.fails||[]).join('+')||'-';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+'" style="opacity:.65;cursor:default" data-sym="'+esc(s.symbol)+'"><div class="r1">'+dirBadge(s.dir)+'<span class="coin">'+esc(s.base)+'</span><span class="tag w">👻 GÖLGE</span><span class="tag '+st[1]+'">'+st[0]+'</span><span class="sc '+cl(r)+'">'+sg(r)+'R</span></div><div class="sub"><span>Filtre: <b>'+esc(fails)+'</b></span><span>Hacim '+f2(s.volX,1)+'x</span><span>OI '+sg(s.oiPct)+'%</span><span>Fitil '+f2(s.wickR,2)+'</span><span>'+ago(s.time)+' önce</span></div></div>'}
function renderList(){var h='',L=$('list'),sc=L.scrollTop;
 try{
 if(tab==='sig'){var a=(S.tr||[]),ao=a.filter(isOp),ac=a.filter(function(x){return !isOp(x)});
  var fr=ao.filter(isFresh),od=ao.filter(function(x){return !isFresh(x)});
  var ti=S.trInfo||{};
  var fd=ti.flow;
  var funnel=fd&&fd.funnel?'<div class="note" style="padding:6px 8px;background:var(--bg);border-radius:6px;margin:6px 0"><b>Son huni:</b> '+fd.checked+' kontrol → <b>'+fd.funnel.brk+'</b> kırılım → <b>'+fd.funnel.plan+'</b> plan → <b>'+fd.funnel.wick+'</b> fitil → <b>'+fd.funnel.rvol+'</b> rvol → <b>'+fd.funnel.oi+'</b> oi → <b>'+fd.funnel.late+'</b> hareket → <b>'+fd.funnel.room+'</b> boşluk → <b style="color:var(--lg)">'+fd.funnel.signal+'</b> sinyal &nbsp;•&nbsp; <b style="color:var(--am)">'+(fd.shadow||0)+'</b> gölge<br><span style="font-size:10px">Elenen: '+JSON.stringify(fd.skipped||{})+'</span></div>':'';
  h='<div class="note" style="padding:6px 8px">⚡ <b>MOMENTUM FLOW (5M)</b> • <b>Kapanışlı kırılım</b> (son 24 mumun tepesi/dibi) + fitil ≤ 0.5 + RVol ≥ 2.0 + OI artışı + boşluk ≥ 2R. Gölge sinyaller filtreye takılanlardır.</div>'+funnel;
  var nL=ao.filter(function(x){return x.dir==='LONG'}).length,nS=ao.length-nL,mb=S.regime?(S.regime.score>=15?'LONG':S.regime.score<=-15?'SHORT':'yok'):'?';
  var btcDir=S.regime?S.regime.btcDir:'?';
  h+='<div class="note" style="padding:2px 8px">Takip edilen açık: <b>'+nL+' LONG / '+nS+' SHORT</b> • BTC yönü: <b>'+btcDir+'</b> • piyasa eğilimi: <b>'+mb+'</b>.</div>';
  if(fr.length)h+='<h3>🟢 TAZE — girilebilir ('+fr.length+')</h3>'+fr.map(trCard).join('');
  if(od.length)h+='<h3>⏳ Açık ama eski / TP1 alınmış — takip ('+od.length+')</h3>'+od.map(trCard).join('');
  if(ac.length)h+='<h3>Kapananlar</h3>'+ac.slice(0,20).map(trCard).join('');
  var sh=(S.flowShadow||[]).filter(isOp);
  var shC=(S.flowShadow||[]).filter(function(x){return !isOp(x)});
  if(sh.length)h+='<h3>👻 Gölge açık ('+sh.length+')</h3>'+sh.slice(0,10).map(shCard).join('');
  if(shC.length)h+='<h3>👻 Gölge kapandı ('+shC.length+')</h3>'+shC.slice(0,10).map(shCard).join('');
  if(!a.length)h+='<div class="note" style="padding:10px">Henüz Momentum Flow sinyali yok. OI verisi, fiyat hareketi ve hacim birlikte eşikleri geçtiğinde sinyal oluşur.</div>'}
 else if(tab==='rad'){var ev=S.breakouts||[],rd=S.radar||[],fo=S.forming||[];
  var act=ev.filter(isOp),closed=ev.filter(function(x){return !isOp(x)});
  var brk=rd.filter(function(x){return x.broke}),near=rd.filter(function(x){return !x.broke});
  var fresh=act.filter(isFresh),old=act.filter(function(x){return !isFresh(x)});
  var triTf=((S.tri||{}).tf||'2h').toUpperCase();
  var nearAtr=((S.brkInfo||{}).nearAtr||1.2);
  h='<div class="note" style="padding:6px 8px">△ Üçgen (<b>'+triTf+'</b>): <b>ONAYLI</b> = kapanış + hacim onaylı kırılım. <b>KIRILDI (onaysız)</b> = fiyat çizgiyi aştı ama onay yok. <b>⚠️ KIRILIM YAKIN</b> uyarısı fiyat çizgiye '+nearAtr+' ATR yaklaşınca Telegram\'a düşer.</div>';
  if(fresh.length)h+='<h3>🟢 TAZE — girilebilir ('+fresh.length+')</h3>'+fresh.map(brkCard).join('');
  if(old.length)h+='<h3>⏳ Açık ama eski — sadece takip ('+old.length+')</h3>'+old.map(brkCard).join('');
  if(brk.length)h+='<h3>Çizgiyi aşanlar — onaysız, anlık K/Z ('+brk.length+')</h3>'+brk.map(radCard).join('');
  if(near.length)h+='<h3>Çizgiye yaklaşanlar ('+near.length+')</h3>'+near.map(radCard).join('');
  if(!rd.length&&!act.length)h+='<div class="note" style="padding:10px">Yaklaşan yok. Tespit edilen üçgen yapısı: '+((S.tri||{}).structs||0)+'.</div>';
  if(fo.length)h+='<h3>Oluşan üçgenler — çizgilere henüz uzak ('+fo.length+')</h3>'+fo.map(function(x){return '<div class="card" style="cursor:default"><div class="r1"><span class="coin">'+esc(x.base)+'</span><span class="tag">'+esc(x.type)+'</span><span class="fl">'+fp(x.price)+'</span></div><div class="sub"><span>üst çizgiye <b>'+f2(x.toUp,2)+'</b> ATR</span><span>alt çizgiye <b>'+f2(x.toDn,2)+'</b> ATR</span><span>'+x.touches+' dokunuş</span></div></div>'}).join('');
  if(closed.length)h+='<h3>Kapanan onaylı kırılımlar</h3>'+closed.slice(0,15).map(brkCard).join('')}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 }catch(err){console.error(err);h='<div class="note" style="padding:10px;color:var(--st)">Liste hatası: '+esc(err.message)+'</div>'}
 L.innerHTML=h;L.scrollTop=sc;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){if(!e.dataset.kind)return;e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesabı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">Brüt</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.gross)+'">'+sg(x.gross)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>'};
function statView(){var A=S.trStats||{},B=S.brkStats||{},h='<h2>İstatistik</h2>';
 h+='<h3 style="color:var(--tx);font-size:14px">⚡🧩 TREND (Momentum Flow + Confluence) — net R (maliyet düşülmüş)</h3>';
 if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.bySetup||{},'Strateji')+tbl(A.byScore||{},'Puan')+tbl(A.byDir||{},'Yön')+tbl(A.byVol||{},'Hacim')+tbl(A.byReg||{},'Piyasa rejimi')+tbl(A.byPlan||{},'Stop planı sürümü')+tbl(A.byAlign||{},'Piyasa yönü uyumu')+tbl(A.byCost||{},'Maliyet/R')+tbl(A.byExit||{},'Çıkış')}
 else h+='<div class="note">Henüz kapanan trend sinyali yok.</div>';
 h+='<h3 style="color:var(--tx);font-size:14px;margin-top:18px">△ ÜÇGEN KIRILIM (onaylı)</h3>';
 if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Üçgen tipi')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Çıkış')}
 else h+='<div class="note">Henüz kapanan kırılım yok.</div>';
 return h}

function drawChart(d,V,cid){var c=$(cid);if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}
 var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);
 var dirCol=V&&V.dir?(V.dir==='LONG'?'#3ddc97':'#ff6b7a'):'#243040';c.style.borderColor=dirCol;
 var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?15:4);
 var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;
 var ti=function(t){return (t-d.c[0][0])/d.dur};var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];
 var hi=-1e99,lo=1e99;d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});hi=Math.max(hi,px);lo=Math.min(lo,px);
 if(lv)[lv.entry,lv.stop,lv.tp1,lv.tp2].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var tl=[];if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.07;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.7);
 var labs=[];if(lv){labs.push({p:lv.entry,col:'#f2b84b',t:V.virtual?'ÇİZGİ':'GİRİŞ'});labs.push({p:lv.stop,col:'#ff6b7a',t:'STOP'});if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#3ddc97',t:lv.tp2!=null?'TP1':'TP'});if(lv.tp2!=null)labs.push({p:lv.tp2,col:'#5aa9ff',t:'TP2'})}
 labs.push({p:px,col:'#e6ebf2',t:'',cur:1});labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});labs.sort(function(a,b){return a.y-b.y});for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}
 var si=-1;if(lv&&lv.t){si=Math.floor(ti(lv.t));if(si<0||si>=nc)si=-1}
 if(lv){var zx=si>=0?X(si):L,zw=W-R-zx,ye=Y(lv.entry),ys=Y(lv.stop),far=lv.tp2!=null?lv.tp2:lv.tp1,yt=far!=null?Y(far):ye;x.fillStyle='rgba(255,107,122,.11)';x.fillRect(zx,Math.min(ye,ys),zw,Math.abs(ys-ye));x.fillStyle='rgba(61,220,151,.11)';x.fillRect(zx,Math.min(ye,yt),zw,Math.abs(yt-ye))}
 x.font='10px system-ui';for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#6f7e91';x.fillText(fp(gp),W-R+8,gy+3)}}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};line(d.e50,'#b794f4',1.1);line(d.e21,'#5aa9ff',1.1);
 d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;x.strokeStyle='rgba(255,255,255,.08)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.55;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#f2b84b';x.lineWidth=1.1;x.beginPath();var s2=false;d.vsma.forEach(function(v,k){if(v==null)return;var y=vTop+volH-(v/vmax)*(volH-4);s2?x.lineTo(X(k),y):(x.moveTo(X(k),y),s2=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();tl.forEach(function(l){x.strokeStyle='rgba(255,212,0,.8)';x.lineWidth=1.6;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});x.fillStyle='rgba(255,212,0,.9)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});x.restore()}
 x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.3;x.globalAlpha=.85;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});x.restore();
 if(si>=0){var kk=d.c[si],isL=V.dir==='LONG',mx=X(si);x.strokeStyle='rgba(242,184,75,.5)';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(mx,T);x.lineTo(mx,T+PH);x.stroke();x.setLineDash([]);x.fillStyle=isL?'#3ddc97':'#ff6b7a';x.beginPath();if(isL){var y0=Y(kk[3])+5;x.moveTo(mx,y0);x.lineTo(mx-8,y0+14);x.lineTo(mx+8,y0+14)}else{var y1=Y(kk[2])-5;x.moveTo(mx,y1);x.lineTo(mx-8,y1-14);x.lineTo(mx+8,y1-14)}x.closePath();x.fill();x.fillStyle='#e6ebf2';x.font='bold 10px system-ui';x.fillText('GİRİŞ',mx+10,isL?Y(kk[3])+18:Y(kk[2])-8)}
 x.strokeStyle='rgba(255,255,255,.7)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);
 labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#0c1117';x.font='bold 10px system-ui';x.fillText(txt,W-R+6,y+3.5)});
 x.fillStyle='#6f7e91';x.font='10px system-ui';var stp=Math.max(1,Math.ceil(nc/7));for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);x.fillText(hh,X(q)-12,H-5)}
 x.font='10px system-ui';x.fillStyle='#5aa9ff';x.fillRect(L+6,T+6,10,3);x.fillStyle='#8593a5';x.fillText('EMA21',L+20,T+10);
 x.fillStyle='#b794f4';x.fillRect(L+62,T+6,10,3);x.fillStyle='#8593a5';x.fillText('EMA50',L+76,T+10);
 x.fillStyle='#8593a5';x.fillText(d.tf,L+118,T+10);
 if(V&&V.dir){var isLg=V.dir==='LONG';x.fillStyle=dirCol;x.fillRect(8,7,96,26);x.fillStyle='#0c1117';x.font='bold 14px system-ui';x.fillText(isLg?'▲ LONG':'▼ SHORT',18,25);if(V.strat){x.fillStyle='#e6ebf2';x.font='bold 12px system-ui';x.fillText(V.strat,114,25)}if(V.pnl){var pc=V.pnl.r>0.005?'#3ddc97':V.pnl.r<-0.005?'#ff6b7a':'#8593a5',txt=(V.pnl.fin?'KAPANDI ':(V.pnl.lbl||'CANLI')+' ')+sg(V.pnl.r)+'R   '+sg(V.pnl.pct)+'%';x.font='bold 13px system-ui';var w=x.measureText(txt).width+22;x.fillStyle=pc;x.fillRect(W-R-w+L,7,w,26);x.fillStyle='#0c1117';x.fillText(txt,W-R-w+L+11,25)}}}
function loadChart(sym,tf){fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym){renderMain()}}).catch(function(){})}
function setTf(v){tfSel=v;chartFor='';$('main').removeAttribute('data-view');renderMain()}
function selData(){if(!sel||!sel.sym)return null;if(sel.kind==='tr')return(S.tr||[]).find(function(x){return x.id===sel.id})||null;if(sel.kind==='brk')return(S.breakouts||[]).find(function(x){return x.id===sel.id})||null;return(S.radar||[]).find(function(x){return x.symbol===sel.sym})||null}
function defTf(){if(sel&&sel.kind==='rad')return S.config.tf;if(sel&&sel.kind==='tr'){var o=selData()||{};return o.chartTf||'15m'}return((S.tri||{}).tf||'2h')}

function whyText(o,kind){
 if(!o)return'Bu sinyal artık listede değil.';
 var fresh=isFresh(o)?'<b style="color:var(--lg)">Sinyal taze, giriş açık.</b>':(o.status==='OPEN'?'<b style="color:var(--st)">Sinyal eski — girme, sadece takip.</b>':'');
 if(kind==='tr'&&o.strategy==='FLOW'){
  var plan=o.riskAbs?' Stop = '+((S.trInfo||{}).flowStopAtr||1.5)+' × ATR(5m) veya son 12 mumun dibi/tepesi (hangisi uzaksa) (risk %'+f2(o.riskPct)+'), TP1 '+o.tp1R+'R, TP2 '+o.tp2R+'R. TP1\'de pozisyonun yarısı kapanır, stop girişe çekilir; en fazla '+f2((o.maxHold||0)/3600e3,0)+' saat tutulur. Maliyet '+f2(o.costR)+'R.':' (Eski sinyal: stop/hedef planı yok.)';
  return '<b>Strateji: MOMENTUM FLOW (5m).</b> Fiyat hareketi '+(o.pricePct>0?'+':'')+o.pricePct+'%, açık pozisyon (OI) değişimi +'+o.oiPct+'%, hacim '+o.volX+'x. Bu puan kazanma olasılığı değildir.'+plan+' Sinyal saati '+new Date(o.time).toLocaleString('tr-TR')+'. '+fresh}
 if(kind==='tr'&&o.strategy==='CF')return '<b>Strateji: CONFLUENCE ('+esc((o.chartTf||'').toUpperCase())+').</b> Kernel regresyon çizgisi dönüşü ZORUNLU tetikleyici; diğer 4 koşuldan en az '+((S.trInfo||{}).minPass||4)+' tanesi onayladı: ters hareket, ML sinyali, QQE MOD rengi, WaveTrend kesişimi. Hacim '+(o.volX||0).toFixed(1)+'x • min '+((S.trInfo||{}).minVolX||0.7)+'x. Stop trend başlangıcının ötesinde, TP1 '+o.tp1R+'R, TP2 '+o.tp2R+'R. Puan <b>%'+o.score+'</b> • Onay '+(o.passes||0)+'/5. '+fresh;
 if(kind==='brk')return '<b>Strateji: ÜÇGEN KIRILIM (onaylı, '+esc((o.tf||((S.tri||{}).tf)||'2h').toUpperCase())+')</b> — '+esc(o.type)+' üçgenin '+(o.dir==='LONG'?'üst':'alt')+' çizgisi kapanış + hacimle kırıldı ('+(o.touches||'?')+' dokunuş, hacim '+f2(o.volX,1)+'x, güç %'+o.strength+'). TP1 alınca stop girişe çekilir. '+fresh;
 if(o.broke)return '<b>Radar — ONAYSIZ KIRILIM:</b> '+esc(o.state)+'. Fiyat çizgiyi aştı ama kapanış/hacim onayı henüz yok. Gösterilen R ve %, çizgi seviyesi sanal giriş sayılarak hesaplanır; gerçek işlem değildir.';
 return '<b>Radar:</b> '+esc(o.state)+' — henüz kırılmadı. Fiyat çizgiye yaklaşırsa Telegram\'a "KIRILIM YAKIN" uyarısı düşer.'}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.removeAttribute('data-view');M.innerHTML=statView();return}
 if(tab==='bt'){M.removeAttribute('data-view');if(!$('btOut'))M.innerHTML=btShell();$('btOut').innerHTML=btOut();return}
 if(sel&&sel.sym){var kind=sel.kind,o=selData(),tf=tfSel||defTf();var P=(o&&((kind==='tr'&&o.riskAbs)||kind==='brk'||(kind==='rad'&&o.broke&&o.entry!=null)))?posInfo(o):null;var dir=o?(o.dir||o.bias):null;
  var vk=kind+'|'+sel.sym+'|'+(sel.id||'')+'|'+tf+'|'+(P?'p':'n');
  if(M.getAttribute('data-view')!==vk){M.setAttribute('data-view',vk);
   var tfs=['5m','15m','1h','2h','4h'].map(function(t){return '<button class="'+(t===tf?'a':'')+'" onclick="setTf(\''+t+'\')">'+t.toUpperCase()+'</button>'}).join('');
   M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2><span id="hdrTags" class="r1"></span><span class="tfb">'+tfs+'</span><a class="btn tv" style="margin-left:8px" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval='+(tf==='5m'?'5':tf==='15m'?'15':tf==='2h'?'120':tf==='4h'?'240':'60')+'" target="_blank">📈 TV</a></div>'+
    '<div id="pnlB"></div><canvas id="cv"></canvas><div id="lvB"></div><div id="why" class="why"></div>'+
    (P?'<div id="calcWrap">'+calcBox(P.levels.entry,P.levels.stop)+'</div>':'');if(P)bindCalc()}
  $('hdrTags').innerHTML=(dir?dirBadge(dir):'')+(kind==='tr'&&o?trTag(o)+(o.strategy==='FLOW'?'':cfTags(o)):stratTag(kind))+(kind==='tr'&&o?(o.strategy==='FLOW'?'<span class="tag '+(o.score>=75?'g':'w')+'">MOMENTUM '+o.score+'/100</span>':scTag(o.score)+passTag(o.passes||0))+ageTag(o):'')+(kind==='brk'&&o?'<span class="tag w">'+esc(o.type||'')+'</span>'+strTag(o.strength||0)+ageTag(o):'')+(kind==='rad'&&o?strTag(o.strength||0)+(o.broke?'<span class="tag w">KIRILDI • ONAYSIZ</span>':''):'');
  if(P){var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100,usd=P.r*ru,virt=(kind==='rad'),stTxt=P.fin?('KAPANDI • '+o.status):(virt?'ÇİZGİDEN BERİ • ONAYSIZ':(o.status==='TP1'?'CANLI • TP1 ALINDI (yarım kâr cepte)':'CANLI'));
   $('pnlB').innerHTML='<div class="pnl '+cl(P.r)+'"><div><span class="pl">'+stTxt+'</span><b class="'+cl(P.r)+'">'+sg(P.r)+'R</b></div><div><span class="pl">Fiyat farkı</span><b class="'+cl(P.pct)+'">'+sg(P.pct)+'%</b></div><div><span class="pl">≈ Kâr / Zarar</span><b class="'+cl(usd)+'">'+sg(usd)+' USDT</b></div><div><span class="pl">En iyi / en kötü</span><b style="font-size:16px">'+(o.mfe!=null?f2(o.mfe,1)+' / '+f2(o.mae||0,1)+'R':'-')+'</b></div></div>';
   $('lvB').innerHTML='<div class="lv"><div><span>Anlık</span><b>'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</b></div><div><span>'+(virt?'Çizgi (sanal giriş)':'Giriş')+'</span><b>'+fp(o.entry)+'</b></div><div><span>Stop'+(o.status==='TP1'?' (BE/iz)':'')+'</span><b class="zarar">'+fp(o.stop)+'</b></div>'+(o.tp1!=null?'<div><span>TP1'+(o.tp1R?' ('+o.tp1R+'R)':'')+'</span><b class="kar">'+fp(o.tp1)+'</b></div><div><span>TP2'+(o.tp2R?' ('+f2(o.tp2R,1)+'R)':'')+'</span><b class="kar">'+fp(o.tp2)+'</b></div>':'')+'<div><span>Risk</span><b>'+f2(o.riskPct)+'%</b></div>'+(o.costR!=null?'<div><span>Maliyet</span><b>'+f2(o.costR)+'R</b></div>':'')+'</div>'}
  else{$('pnlB').innerHTML='';$('lvB').innerHTML=(o&&kind==='rad')?'<div class="lv"><div><span>Fiyat</span><b>'+fp(o.price)+'</b></div><div><span>Hacim</span><b>'+f2(o.volX,1)+'x</b></div><div><span>Güç</span><b>%'+(o.strength||0)+'</b></div></div>':''}
  $('why').innerHTML=whyText(o,kind);
  var k=sel.sym+'|'+tf;if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||null,strat:stratName(kind,o),pnl:P?{r:P.r,pct:P.pct,fin:P.fin,lbl:(kind==='rad'?'ÇİZGİDEN':'CANLI')}:null},'cv')}
  if(chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}return}
 var A=S.trStats||{},Ad=A.today||{totalR:0,n:0},B2=S.brkStats||{},Bd=B2.today||{totalR:0,n:0};
 var R=S.regime;
 var rg=R?'<div class="note" style="color:var(--tx);font-size:12px"><b>BTC yönü:</b> <span class="'+(R.btcDir==='LONG'?'kar':R.btcDir==='SHORT'?'zarar':'fl')+'">'+R.btcDir+' ('+sg(R.btcScore,0)+')</span> &nbsp;•&nbsp; <b>Piyasa yönü:</b> <span class="'+cl(R.score)+'">'+R.dir+' ('+sg(R.score,0)+', '+R.regime+')</span>'+(R.breadth?' • ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'<br><span style="color:var(--dm);font-size:11px">BTC yönü sadece BTC trend skoru (±15 eşik). Piyasa yönü BTC+ETH+genişlik karışımı.</span></div>':'<div class="note">Yön motoru ısınıyor.</div>';
 var ti=S.trInfo||{};
 var cf=ti.cfDg;
 var cdt='';
 if(cf){
  var near=(cf.near||[]).map(function(n){return '<div class="sub" style="margin-top:4px"><span class="tag w">'+esc(n.b)+'</span><span>'+esc(n.dir)+' • '+n.passes+'/5 • eksik: '+esc(n.miss)+'</span></div>'}).join('');
  cdt='<div class="note">Son confluence taraması ('+esc((S.config&&S.config.cfTf||'').toUpperCase())+'): <b>'+cf.ok+'</b> kontrol • '+cf.short+' kısa • <b>'+cf.stale+'</b> bayat • '+cf.gap+' boşluk • <b>'+cf.cand+'</b> aday • <b>'+cf.sig+'</b> sinyal'+((cf.err?' • <span class="zarar">hata '+cf.err+'</span>':'')||'')+'<br>Elenen: '+esc(JSON.stringify(cf.skip))+(near?'<br><b>Ramak kaldı (4/5):</b>'+near:'')+'</div>';
 }
 var fd=ti.flow,fdt=fd?'<div class="note">Son flow taraması: '+(fd.error?'<span class="zarar">'+esc(fd.error)+'</span>':'liste <b>'+fd.list+'</b> • kontrol <b>'+fd.checked+'</b> • OI yok '+fd.oiMissing+' • sinyal <b>'+fd.signal+'</b> • elenen '+esc(JSON.stringify(fd.skipped||{}))+(fd.errors?' • <span class="zarar">hata '+fd.errors+'</span>':''))+'</div>':'';
 var tg=S.tri||{};var tgl='<div class="note">Üçgen motoru (<b>'+esc((tg.tf||'2h').toUpperCase())+'</b>): <b>'+(tg.structs||0)+'</b> yapı tespit edildi • son tarama '+(tg.scanLast?ago(tg.scanLast)+' önce':'yok')+' • canlı motor '+(tg.liveErr?'<span class="zarar">HATA: '+esc(tg.liveErr)+'</span>':'ok')+' • radarda '+(S.radar||[]).length+'<br>⚠️ <b>KIRILIM YAKIN</b> uyarısı: fiyat çizgiye '+((S.brkInfo||{}).nearAtr||1.2)+' ATR yaklaşınca Telegram (hacim min '+((S.tri||{}).nearWarnVolX||0.7)+'x, cooldown '+((S.tri||{}).nearWarnCdMin||60)+' dk)</div>';
 M.innerHTML='<h2>Panel</h2><div class="tiles">'+
 '<div class="tile"><div class="k">Flow taze</div><div class="v">'+(S.tr||[]).filter(isFresh).length+'</div></div>'+
 '<div class="tile"><div class="k">Flow sinyalleri (açık)</div><div class="v">'+(S.tr||[]).filter(isOp).length+'</div></div>'+
 '<div class="tile"><div class="k">Trend bugün</div><div class="v '+cl(Ad.totalR)+'">'+sg(Ad.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Kırılım taze</div><div class="v">'+(S.breakouts||[]).filter(isFresh).length+'</div></div>'+
 '<div class="tile"><div class="k">Kırılım bugün</div><div class="v '+cl(Bd.totalR)+'">'+sg(Bd.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Radar (aşan / toplam)</div><div class="v">'+(S.radar||[]).filter(function(x){return x.broke}).length+' / '+(S.radar||[]).length+'</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Sistem</h3>'+rg+fdt+tgl+cdt+'<div class="note" style="color:var(--tx);font-size:12px">⚡ MOMENTUM FLOW (5M) • △ ÜÇGEN KIRILIM ('+esc((tg.tf||'2h').toUpperCase())+') • ◎ RADAR. Kartlara tıkla → grafik + giriş/stop/TP çizgileri + canlı K/Z + sinyal gerekçesi.</div></div>'}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}

var BT=null,btDays=30,btN=40,btS='cf';
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&s='+btS),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 return '<h2>Backtest</h2><div class="box"><div class="note" style="color:var(--tx);font-size:12px;margin:0 0 8px">Giriş sinyal mumundan sonraki mumun açılışı. Stop/hedef aynı mumdaysa STOP önce sayılır.</div><div class="frm"><label class="fl">Strateji<br><select onchange="btS=this.value"><option value="cf"'+(btS==='cf'?' selected':'')+'>Confluence (kernel+ML+QQE+WT)</option><option value="tri"'+(btS==='tri'?' selected':'')+'>Üçgen kırılım (1h yapı)</option><option value="tri2"'+(btS==='tri2'?' selected':'')+'>Üçgen kırılım (2h yapı)</option></select></label><label class="fl">Gün<br><select onchange="btDays=this.value">'+so([14,30,60,90,180],btDays)+'</select></label><label class="fl">Coin<br><select onchange="btN=this.value">'+so([20,40,60,100],btN)+'</select></label><button class="btn" onclick="btStart()">▶ Başlat</button></div></div><div id="btOut"></div>'}
function edgeTbl(e){if(!e||!e.length)return'';return '<h3>Sinyal isabeti</h3><div class="note" style="margin:0 0 6px">Giriş sonrası fiyat <b>stop mesafesi kadar ters</b> gitmeden önce <b>+kR</b> hedefine ulaşıyor mu? Rastgele yürüyüşte beklenen: +1R için %50, +2R için %33, +3R için %25.</div><table><tr><th>Grup</th><th>Hedef</th><th class="n">N</th><th class="n">Belirsiz</th><th class="n">İsabet%</th><th class="n">Rastgele%</th><th class="n">Fark</th><th class="n">z</th></tr>'+e.map(function(x){var d=(x.hit-x.base)*100;return '<tr><td>'+esc(x.g)+'</td><td>+'+x.k+'R</td><td class="n">'+x.n+'</td><td class="n">'+x.un+'</td><td class="n">'+f2(x.hit*100,0)+'</td><td class="n">'+f2(x.base*100,0)+'</td><td class="n '+cl(d)+'">'+sg(d,0)+'</td><td class="n '+cl(x.z)+'">'+f2(x.z)+'</td></tr>'}).join('')+'</table>'}
function btOut(){var b=BT;if(!b)return '<div class="note">Yükleniyor…</div>';
 var sn=b.strategy==='cf'?'Confluence (kernel+ML+QQE+WT)':b.strategy==='tri2'?'Üçgen kırılım (2h yapı)':'Üçgen kırılım (1h yapı)';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="box"><b>Çalışıyor ('+sn+'):</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') %'+pc+'</div>'}
 if(b.err)return '<div class="box zarar">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return '<div class="note">Henüz çalıştırılmadı.</div>';
 if(!r.n)return '<div class="box">'+sn+': '+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.</div>';
 var col=r.level==='g'?'var(--lg)':r.level==='r'?'var(--st)':'var(--am)';
 var h='<div class="box" style="border-color:'+col+'"><b style="color:'+col+'">Değerlendirme — '+sn+'</b><div class="note" style="color:var(--tx);font-size:12px">'+esc(r.verdict)+'</div></div>';
 var dt=function(x){return x?new Date(x).toISOString().slice(0,10):'-'};
 h+='<div class="note">'+r.coins+' coin • '+r.days+' gün istendi • '+r.n+' işlem • ilk işlem '+dt(r.tFrom)+', son işlem '+dt(r.tTo)+' • veri kapsamı %'+Math.round((r.coverage||0)*100)+' • bitiş '+ago(b.finishedAt)+' önce</div>';
 if((r.coverage||0)<0.9)h+='<div class="box" style="border-color:var(--am)"><b style="color:var(--am)">⚠ Veri eksik olabilir</b></div>';
 if(r.edge)h+=edgeTbl(r.edge);
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});return h}

function poll(){fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){if(d&&d.error){$('dot').className='dot';$('conn').textContent='Hata: '+d.error;return}
 S=d;$('dot').className='dot on';$('conn').textContent='Bağlı';try{checkBrk();checkTr();renderAll()}catch(e){console.error(e);$('conn').textContent='Bağlı (arayüz hatası: '+e.message+')'}}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)try{renderMain()}catch(e){}});
setInterval(poll,3000);
setInterval(function(){if(tab==='bt')pollBT()},2000);
setInterval(function(){if((tab==='sig'||tab==='rad')&&sel&&sel.sym){loadChart(sel.sym,tfSel||defTf())}},8000);
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
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v49', triTf: TRI_TF, flowOn: FLOW.ON, oiSupported: flowRun.supported, flowDiag: flowRun.dg || null, triangles: Object.keys(struct).length, radar: triRadar.length, breakouts: brkEvents.length, trend: trendSignals.length, regime: REG, universe: universe.length });
        if (u.pathname === '/api/reset' && req.method === 'POST') { if (!authed(u)) return json(res, 401, { error: 'yetkisiz' }); signals = []; trendSignals = []; brkEvents = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true }); }
        if (['/', '/index.html', '/api/state', '/api/candles', '/api/backtest', '/api/backtest/start'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/backtest') return json(res, 200, bt);
        if (u.pathname === '/api/backtest/start' && req.method === 'POST') {
            if (bt.running) return json(res, 409, { error: 'Backtest zaten çalışıyor' });
            if (!Object.keys(tickers).length) return json(res, 503, { error: 'Piyasa verisi henüz yüklenmedi' });
            if (!rateOk(ip + '|bt', 3)) return json(res, 429, { error: 'çok fazla istek' });
            const days = Math.min(180, Math.max(7, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            const sp = u.searchParams.get('s'); const strategy = sp === 'tri' || sp === 'tri2' || sp === 'cf' ? sp : 'cf';
            runBacktestJob(days, n, strategy);
            return json(res, 200, { ok: true, days, n, strategy });
        }
        if (u.pathname === '/api/candles') { if (!rateOk(ip, 60)) return json(res, 429, { error: 'çok fazla istek' }); return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || '')); }
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
        setInterval(liveTick, 8000);
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
        log('SONER TRADE v49 • Üçgen(' + TRI_TF + ') + Flow v49 (kapanışlı kırılım + gölge) • Confluence ' + (CF.ON ? 'açık' : 'kapalı') + ' • evren ' + universe.length + ' coin');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, evalBreakout, planTrade, virtualPlan, CFG, CF,
    buildStruct, lineValues, calculateStrength, costFor, advance, mkSig, grp, groupBy, strBucket, atrMean, aggregateN, hasGap,
    runBacktestJob, btSymbol, btReport, btConfluence, getBt: () => bt,
    runConfluence, runFlow, FLOW, cfEval, buildCF, qqeMod, waveTrend, rsiSeries, lorentzPred, emaN, rmaN, smaN, stdevN, cciSeries, adxSeries, trTrack, trStatsCalc,
    getTr: () => trendSignals, getBrk: () => brkEvents };
