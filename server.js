'use strict';
// ============================================================
// SONER TRADE v33 — TEK DOSYA
//   v33: Scalp Sweep, VWAP Reversion, UT Bot, Trend Pullback, AI Scalp SİLİNDİ. Kalanlar:
//     1) ÜÇGEN KIRILIM — 1s formasyon tespiti, kırılım yakalama, BTC kapısı, radar, canlı K/Z.
//     2) CASUS — tarayıcı. "Bu coine bak" der, "al" demez. İşlem açmaz. Sanal pozisyonla izlenir (istatistik için).
//   Sistem bilgi aracıdır; karar kullanıcıdadır.
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
const M1 = 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1, M5 = 5 * 60e3;
const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
const TRI_TF = (process.env.TRI_TF || '1h').toLowerCase();
const TRI_MS = TRI_TF === '2h' ? H2 : TRI_TF === '1h' ? H1 : M15;
const SCAN_MS = M15;
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
    NEAR_ATR: num('NEAR_ATR', 0.4), BRK_SEE: num('BRK_SEE', 0.8), BRK_ATR: num('BRK_ATR', 0.15), BRK_VOL: num('BRK_VOL', 1.3),
    FRESH_MIN: num('FRESH_MIN', 5), MAX_CHASE: num('MAX_CHASE', 0.6),
    STOP_ATR15: num('STOP_ATR15', 2.0), STOP_MIN_PCT: num('STOP_MIN_PCT', 0.8),
    BRK_TP1_R: num('BRK_TP1_R', 1.0), BRK_TP2_R: num('BRK_TP2_R', 2.0), BRK_EXPIRE_H: num('BRK_EXPIRE_H', 12), BRK_TS_MIN: num('BRK_TS_MIN', 180),
    MIN_RR: num('MIN_RR', 0.8), MAX_TP2R: num('MAX_TP2R', 5),
    MIN_STRENGTH: num('MIN_STRENGTH', 45), MAX_COST_R: num('MAX_COST_R', 0.35),
    BK_MAX_ATR15: num('BK_MAX_ATR15', 2.5), MIN_SIG_VOL: num('MIN_SIG_VOL', 3e6), SLIP_PCT: num('SLIP_PCT', 0.03),
    COOLDOWN_MIN: num('COOLDOWN_MIN', 45), MIN_RISK_PCT: num('MIN_RISK_PCT', 0.3), MAX_RISK_PCT: num('MAX_RISK_PCT', 6.0),
    TRAIL_R: num('TRAIL_R', 1.0), TS_MFE: 0.3,
    GATE_TH: num('GATE_TH', 0.15),       // BTC kapı eşiği
    GATE_STRICT: num('GATE_STRICT', 0),  // 0 = yumuşak (sadece BTC ters yönde güçlüyse engelle), 1 = sert (nötr bölgede ikisi de kapalı)
    GATE_BRK: num('GATE_BRK', 1),        // üçgen kırılımlara da kapı uygula
    MAX_DIR: num('MAX_DIR', 10),         // aynı yönde max açık onaylı kırılım
    RADAR_LOCK_H: num('RADAR_LOCK_H', 6) // kırılım alınan coin radardan çıkar
};

// ======================= CASUS AYARLARI =======================
// Casus bir tarayıcıdır: "bak buraya" der, al/sat demez. Sanal pozisyonlar sadece istatistik içindir.
const CAS = {
    ON: num('CAS_ON', 1),
    // Evren
    MIN_VOL: num('CAS_MIN_VOL', 5e6),               // 24s hacim alt sınırı (USDT)
    MAX_COINS: num('CAS_MAX_COINS', 400),
    // Aşama 1 (ücretsiz, ticker anlık görüntüleri)
    SNAP_MS: num('CAS_SNAP_MS', 15e3),              // anlık görüntü aralığı. 45 sn'den küçük olmalı (casStage1 tazelik kontrolü)
    HIST_MS: num('CAS_HIST_MS', 65 * 60e3),
    S1_VOLX: num('CAS_S1_VOLX', 2.5),               // hacim vekili eşiği
    S1_MOVE3: num('CAS_S1_MOVE3', 0.8),             // 3 dk'da % hareket
    S1_MOVE15: num('CAS_S1_MOVE15', 2.0),           // 15 dk'da % hareket
    OI_PCT: num('CAS_OI_PCT', 3),                   // 10 dk'da OI artışı %
    OI_MIN_USD: num('CAS_OI_MIN_USD', 2e6),         // OI'nin minimum USD büyüklüğü
    FUND_ABS: num('CAS_FUND_ABS', 0.0008),
    FUND_JUMP: num('CAS_FUND_JUMP', 0.0003),
    FUND_CD_H: num('CAS_FUND_CD_H', 4),
    // Aşama 2 (sadece bayraklılar, 1 dk mumlarla doğrulama)
    S2_CD: num('CAS_S2_CD', 180e3),                 // aynı coin için aşama 2 tekrar aralığı (ms)
    S2_MAX: num('CAS_S2_MAX', 25),                  // döngü başına en fazla mum çekilecek coin
    VOLX: num('CAS_VOLX', 3.0),                     // 1 dk mum hacim patlaması
    WICK_VOLX: num('CAS_WICK_VOLX', 2.5),
    WICK_ATR: num('CAS_WICK_ATR', 1.5),
    WICK_RATIO: num('CAS_WICK_RATIO', 0.5),
    SQZ_RATIO: num('CAS_SQZ_RATIO', 0.6),
    SQZ_VOLX: num('CAS_SQZ_VOLX', 2.0),
    ALIGN_Z5: num('CAS_ALIGN_Z5', 1.0),
    ALIGN_Z15: num('CAS_ALIGN_Z15', 1.2),
    ALIGN_Z60: num('CAS_ALIGN_Z60', 1.2),
    ALIGN_VOLX: num('CAS_ALIGN_VOLX', 1.2),
    // Sinyal yönetimi
    COOLDOWN_MIN: num('CAS_COOLDOWN_MIN', 15),
    MAX_PER_CYCLE: num('CAS_MAX_PER_CYCLE', 3),
    MAX_OPEN: num('CAS_MAX_OPEN', 30),
    KEEP: num('CAS_KEEP', 300),
    // Sanal pozisyon (istatistik için)
    STOP_ATR: num('CAS_STOP_ATR', 3.5),
    MIN_STOP_PCT: num('CAS_MIN_STOP_PCT', 0.3),
    MAX_STOP_PCT: num('CAS_MAX_STOP_PCT', 3.0),
    TP1_R: num('CAS_TP1_R', 1.0),
    TP2_R: num('CAS_TP2_R', 2.0),
    TS_MS: num('CAS_TS_MIN', 20) * 60e3,
    MAX_HOLD: num('CAS_MAX_HOLD_H', 1) * H1,
    // Telegram (10 dk'da en fazla 6 mesaj; sadece conf>=2 veya güç>=TG_MIN_STR)
    TG: num('CAS_TG', 1),
    TG_MIN_STR: num('CAS_TG_MIN_STR', 80)
};
const CAS_NAMES = {
    VOL: 'Hacim patlaması',
    OI: 'OI sıçraması',
    WICK: 'Likidite fitili',
    FUND: 'Funding uçurumu',
    SQZ: 'Sıkışma kırılımı',
    ALIGN: 'TF hizalanması'
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
const r2n = x => x == null ? null : Number(Number(x).toFixed(2));
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
function atrSeries(c, p = 14) { const o = new Array(c.length).fill(null); if (c.length <= p) return o; let a = 0; for (let i = 1; i <= p; i++) a += Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a /= p; o[p] = a; for (let i = p + 1; i < c.length; i++) { const tr = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])); a = (a * (p - 1) + tr) / p; o[i] = a; } return o; }
function volSma(c, p = 20) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { if (i >= p) { o[i] = s / p; s -= c[i - p][5]; } s += c[i][5]; } return o; }
const clOf = a => a.map(x => x[4]);

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
let lastSig = {}, universe = [], tickers = {}, market = { btc: null, eth: null, lastTick: 0 };
let scan = { last: 0, ms: 0, running: false, total: 0, eligible: 0, drop: { excluded: 0, lowVol: 0, suspect: 0 } }, dirty = false, lastScanSlot = 0;
const candleCache = new Map();
let triRadar = [], liveRunning = false, tgTimes = [], tracking = false;
let live = { last: 0, ms: 0, n: 0, lines: 0, err: '' };
const struct = {}, volCache = new Map();
const regime = createRegime(); let REG = null;
let brkEvents = [], shadow = [], GATE = null;
// Casus durumu
let casUniverse = [];
const casHist = new Map();
let casEvents = [];
const casSt = { running: false, last: 0, ms: 0, dg: null, probe: null, hot: [] };
let casRecent = {};
let casSeen = {};
let casTg = [];
const casCandleCache = new Map();

// ======================= POZİSYON ÜRETİCİ =======================
function norm(s) {
    if (!s.initialStop) s.initialStop = s.stop;
    if (!s.riskAbs) s.riskAbs = Math.abs(s.entry - s.initialStop);
    s.tp1R = s.tp1R || CFG.BRK_TP1_R; s.tp2R = s.tp2R || CFG.BRK_TP2_R;
    s.trail = s.trail || CFG.TRAIL_R;
    s.tsMs = s.tsMs || CFG.BRK_TS_MIN * 60e3; if (s.tsMfe == null) s.tsMfe = CFG.TS_MFE;
    s.maxHold = s.maxHold || CFG.BRK_EXPIRE_H * H1;
    s.trackedTo = s.trackedTo || s.time; s.mfe = s.mfe || 0; s.mae = s.mae || 0; s.costR = s.costR || 0;
    if (s.status === 'TP1' && !s.tp1At) s.tp1At = s.time;
    return s;
}
function mkPos(o) {
    const L = o.dir === 'LONG' ? 1 : -1, riskAbs = L * (o.entry - o.stop), riskPct = riskAbs / o.entry * 100;
    return Object.assign({
        id: o.id, strategy: o.strategy, symbol: o.sym, base: baseOf(o.sym), dir: o.dir, time: o.time,
        entry: o.entry, stop: o.stop, initialStop: o.stop, riskAbs, riskPct: r2(riskPct), costR: r2(o.costPct / riskPct),
        tp1R: o.tp1R, tp2R: o.tp2R, tp1: o.entry + L * riskAbs * o.tp1R, tp2: o.entry + L * riskAbs * o.tp2R, trail: CFG.TRAIL_R,
        tsMs: o.tsMs, tsMfe: CFG.TS_MFE, maxHold: o.maxHold, status: 'OPEN', lastPrice: o.entry, mfe: 0, mae: 0,
        trackedTo: Math.floor(o.time / M1) * M1
    }, o.extra || {});
}

// ======================= STATE =======================
function loadState() {
    try { const b = JSON.parse(fs.readFileSync(BT_FILE, 'utf8')); if (b && b.result) { b.running = false; bt = b; } } catch (e) { }
    try {
        const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        brkEvents = (j.brk || []).filter(s => s && s.id && s.entry).map(norm);
        shadow = (j.shadow || []).filter(s => s && s.id && s.entry).map(norm);
        casEvents = (j.cas || []).filter(s => s && s.id && s.entry).map(norm);
        lastSig = j.lastSig || {};
        log('durum:', brkEvents.length, 'kırılım,', shadow.length, 'gölge,', casEvents.length, 'casus');
    } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try {
        const cut = Date.now() - 24 * H1;
        for (const k of Object.keys(lastSig)) if (lastSig[k] < cut) delete lastSig[k];
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ brk: brkEvents.slice(0, 200), shadow: shadow.slice(0, 300), cas: casEvents.slice(0, CAS.KEEP), lastSig }));
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
        buildCasUniverse(all);
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
        for (const list of [brkEvents, shadow, casEvents]) for (const s of list) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
        if (CAS.ON) { try { casSnap(t, Date.now()); } catch (e) { } }
    } catch (e) { }
}

// ======================= BTC KAPISI =======================
// Ortak bağlam: 15m mumlardan EMA/ATR + 4 mumdan toplanan 1s EMA'lar. Canlı ve backtest AYNI fonksiyonları kullanır.
function mkCtx(c) {
    const cl = clOf(c), h = aggregateN(c, M15, 4), hc = h.map(x => x[4]);
    return { c, cl, e21: emaSeries(cl, 21), e50: emaSeries(cl, 50), atr: atrSeries(c, 14),
        h1: { t: h.map(x => x[0]), cl: hc, e21: emaSeries(hc, 21), e50: emaSeries(hc, 50) } };
}
function h1Idx(ctx, tEnd) { const t = ctx.h1.t; let lo = 0, hi = t.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] + H1 <= tEnd) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
function gateAt(ctx, i) {
    if (i < 55) return null;
    const c = ctx.c, atr = ctx.atr[i], e21 = ctx.e21, e50 = ctx.e50;
    if (!(atr > 0) || e21[i] == null || e50[i] == null || e21[i - 3] == null) return null;
    const j = h1Idx(ctx, c[i][0] + M15); if (j < 0) return null;
    const H = ctx.h1; if (H.e21[j] == null || H.e50[j] == null) return null;
    const a1 = atr * 2;
    const t1 = 0.5 * th((H.cl[j] - H.e50[j]) / a1 / 2) + 0.5 * th((H.e21[j] - H.e50[j]) / a1);
    const sl = th((e21[i] - e21[i - 3]) / atr * 2);
    const mv = th((ctx.cl[i] - ctx.cl[i - 3]) / atr / 1.5);
    const score = 0.45 * t1 + 0.30 * sl + 0.25 * mv;
    const TH = CFG.GATE_TH;
    // Yumuşak kapı: BTC ters yönde güçlü değilse izin ver. Sert kapı: yönde güçlü olmalı.
    const long = CFG.GATE_STRICT ? score >= TH : score > -TH;
    const short = CFG.GATE_STRICT ? score <= -TH : score < TH;
    return { score, t1, sl, mv, long, short, ret16: i >= 16 ? (ctx.cl[i] / ctx.cl[i - 16] - 1) * 100 : 0, t: c[i][0] };
}
async function updateGate() {
    if (GATE && Date.now() - GATE.u < 20e3) return;
    try {
        const c = closedOnly(await safeFetch(ex, BTC, '15m', 400), M15);
        if (c.length < 130) return;
        const g = gateAt(mkCtx(c), c.length - 1);
        if (g) GATE = Object.assign(g, { u: Date.now() });
    } catch (e) { }
}
function gateWhy(dir) {
    if (!GATE || Date.now() - GATE.u > 240e3) return 'kapı verisi yok';
    if (!(dir === 'LONG' ? GATE.long : GATE.short)) return 'BTC kapısı';
    if (REG && REG.dir !== 'NÖTR' && REG.dir !== dir && Math.abs(REG.score) >= 40) return 'piyasa yönü';
    return null;
}
const gateOk = dir => gateWhy(dir) === null;
const openPos = () => brkEvents.filter(isOpen);
const openDir = dir => openPos().filter(x => x.dir === dir).length;
function isLocked(sym, dir, now) {
    if (openPos().some(x => x.symbol === sym)) return true;
    return brkEvents.some(b => b.symbol === sym && b.dir !== dir && now - b.time < CFG.RADAR_LOCK_H * H1);
}
function addShadow(pos, reason) {
    const k = 'SH|' + pos.strategy + '|' + pos.symbol + '|' + pos.dir, now = Date.now();
    if (now - (lastSig[k] || 0) < 90 * 60e3) return false;
    if (shadow.filter(isOpen).length >= 40) return false;
    lastSig[k] = now; pos.shadow = true; pos.reason = reason;
    shadow.unshift(pos); if (shadow.length > 300) shadow.length = 300; dirty = true; return true;
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

// ======================= KIRILIM (üçgen) =======================
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

// ======================= POZİSYON TAKİBİ (1 dk mum high/low) =======================
function curR(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t, px) { s.status = status; s.grossR = r2(gross); s.netR = r2(gross - s.costR); s.closedAt = t; s.exitPrice = px; }
function advance(s, k, dur) {
    dur = dur || M1;
    const L = s.dir === 'LONG', side = L ? 1 : -1, risk = Math.abs(s.entry - s.initialStop);
    const end = k[0] + dur, el = k[0] - s.time;
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    s.lastPrice = k[4];
    s.mfe = Math.max(s.mfe || 0, (side * (k[L ? 2 : 3] - s.entry)) / risk);
    s.mae = Math.min(s.mae || 0, (side * (k[L ? 3 : 2] - s.entry)) / risk);
    if (s.status === 'OPEN') {
        if (hitStop) { closeSig(s, 'STOP', -1, end, s.stop); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) { s.status = 'TP1'; s.stop = s.entry; s.tp1At = k[0]; return false; }
        if (el >= s.tsMs && s.mfe < s.tsMfe) { closeSig(s, 'TIMEOUT', curR(s, k[4]), end, k[4]); return true; }
    } else if (s.status === 'TP1' && k[0] > s.tp1At) {
        const hh = L ? k[2] : k[3];
        const ts = s.entry + side * Math.max(0, (side * (hh - s.entry)) / risk - s.trail) * risk;
        if (L ? ts > s.stop : ts < s.stop) s.stop = ts;
        if (hitStop) { closeSig(s, s.stop === s.entry ? 'BE' : 'TRAIL', 0.5 * s.tp1R + 0.5 * curR(s, s.stop), end, s.stop); return true; }
        if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * s.tp1R + 0.5 * s.tp2R, end, s.tp2); return true; }
    }
    if (el >= s.maxHold && isOpen(s)) { const r = curR(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1' ? 0.5 * s.tp1R + 0.5 * r : r, end, k[4]); return true; }
    return false;
}
// Kapanış mesajı sadece onaylı üçgen kırılımlar için. Casus ve gölge kapanışları Telegram'a gitmez (spam olmasın).
function onClose(s) { dirty = true; if (!s.shadow && s.strategy === 'TRI') telegram(closeMsg(s)); }
async function track() {
    if (tracking) return; tracking = true;
    try {
        const open = brkEvents.concat(casEvents, shadow).filter(isOpen); if (!open.length) { tracking = false; return; }
        const bySym = {}; for (const s of open) (bySym[s.symbol] = bySym[s.symbol] || []).push(s);
        for (const sym of Object.keys(bySym)) {
            try {
                const list = bySym[sym]; const since = Math.min(...list.map(x => x.trackedTo));
                const raw = await safeFetch(ex, sym, '1m', 500, since), c = closedOnly(raw, M1);
                for (const s of list) {
                    if (!isOpen(s)) continue;
                    for (const k of c) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; dirty = true;
                        if (advance(s, k, M1) && !isOpen(s)) { onClose(s); break; }
                    }
                }
            } catch (e) { }
        }
    } catch (e) { }
    tracking = false;
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
const doneOf = list => list.filter(s => !isOpen(s) && s.netR != null);
function brkStatsCalc() {
    const closed = doneOf(brkEvents), today = trDay(Date.now());
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === today)),
        byStrength: groupBy(closed, strBucket), byDir: groupBy(closed, s => s.dir), byType: groupBy(closed, s => s.type), byExit: groupBy(closed, s => s.status) };
}
function shadowStatsCalc() {
    const closed = doneOf(shadow);
    return { all: grp(closed), byReason: groupBy(closed, s => s.reason || '?'), open: shadow.filter(isOpen).length };
}

// ======================= CANLI MOTOR (üçgen radar + kırılım) =======================
// Fiyatlar priceLoop (4 sn) ile tickers'a gelir; burada ayrıca çekilmez.
async function liveTick() {
    if (liveRunning) return;
    liveRunning = true; const t0 = Date.now();
    try {
        const now = Date.now();
        if (now - market.lastTick > 90e3) { live.err = 'fiyat eski'; liveRunning = false; return; }
        live.err = '';
        try { REG = (await regime.tick(ex, tickers, universe)) || REG; } catch (e) { }
        await updateGate();

        const recent = new Set(brkEvents.filter(b => now - b.time < CFG.RADAR_LOCK_H * H1).map(b => b.symbol));
        const rad = [];
        for (const sym of Object.keys(struct)) {
            const st = struct[sym], tk = tickers[sym];
            if (!st || !tk || !tk.last || now - st.t > 4 * H1) continue;
            if (recent.has(sym)) continue;   // kırılım alınan coin radardan çıkar
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
            const aligned = gateOk(cand.bias);
            const item = { symbol: sym, base: baseOf(sym), price: P, bias: cand.bias, dir: cand.bias, rank: Math.abs(cand.d), touches: st.touches, type: st.type,
                volX: r2(v.volX), strength: pre, broke, rs: rs == null ? null : r2(rs), aligned,
                state: st.type + ' üçgen • ' + cand.line + ' ' + fmt(cand.v) + ' (' + (broke ? 'aştı ' : '') + Math.abs(cand.d).toFixed(2) + ' ATR)' };
            if (broke) { const vp = virtualPlan(L, cand.v, atr, v); if (vp) Object.assign(item, vp, { virtual: true }); }
            rad.push(item);

            if (!broke) continue;
            const br = evalBreakout(st, cand.bias, P, now, v);
            if (!br) continue;
            const sk = 'BRK|' + sym + '|' + cand.bias;
            if (now - (lastSig[sk] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            if (openPos().some(x => x.symbol === sym && (x.strategy === 'TRI' || x.dir !== cand.bias))) continue;
            const plan = planTrade(st, cand.bias, P, vals, v);
            if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, cand.bias, rs);
            const costPct = costFor((tickers[sym] || {}).quoteVolume) + 2 * CFG.SLIP_PCT;
            const pos = mkPos({ id: 'BRK_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'TRI', sym, dir: cand.bias, time: now, entry: P, stop: plan.stop,
                tp1R: CFG.BRK_TP1_R, tp2R: CFG.BRK_TP2_R, costPct, tsMs: CFG.BRK_TS_MIN * 60e3, maxHold: CFG.BRK_EXPIRE_H * H1,
                extra: { tf: TRI_TF, type: st.type, touches: st.touches, squeeze: st.squeeze, volX: r2(br.vol), ext: r2(br.ext), strength, line: cand.v,
                    aligned, rs: rs == null ? null : r2(rs), reg: REG ? REG.dir : '-', gateScore: GATE ? r2(GATE.score) : null } });
            if (!(pos.riskAbs > 0)) continue;
            if (CFG.GATE_BRK) {
                const why = gateWhy(cand.bias);
                if (why) { addShadow(pos, 'Kapı: ' + why); lastSig[sk] = now; continue; }
            }
            if (openDir(cand.bias) >= CFG.MAX_DIR) { addShadow(pos, 'Yön/adet limiti'); lastSig[sk] = now; continue; }
            brkEvents.unshift(pos);
            if (brkEvents.length > 200) brkEvents.length = 200;
            lastSig[sk] = now; dirty = true;
            log('KIRILIM', pos.dir, pos.base, pos.type, 'güç', strength, 'hacim', br.vol.toFixed(1), 'entry', fmt(P), 'stop', fmt(pos.stop), 'risk %' + pos.riskPct);
            telegram(brkMsg(pos));
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

// ======================= TARAMA (üçgen yapı) =======================
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

// ======================= BACKTEST (sadece Üçgen) =======================
const DAY = 86400e3;
let bt = { running: false, i: 0, total: 0, sym: '', days: 0, n: 0, mode: 'tri', offset: 0, startedAt: 0, finishedAt: 0, err: '', result: null };
let exBT = null;
const yieldLoop = () => new Promise(r => setImmediate(r));
async function btSymbolTri(sym, c1h, c15, vol24, startT, endT) {
    const trades = [], busy = {}, lastT = {};
    let st = null, h = 0, lastH = -1;
    for (let k = 31; k < c15.length - 1; k++) {
        if (k % 300 === 0) await yieldLoop();
        const bk = c15[k], now = c15[k + 1][0];
        if (bk[0] < startT) continue;
        if (bk[0] >= endT) break;
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
            if (now - (lastT[dir] || 0) < CFG.COOLDOWN_MIN * 60e3) continue;
            const br = evalBreakout(st, dir, P, now, v); if (!br) continue;
            const plan = planTrade(st, dir, P, vals, v); if (!plan) continue;
            const strength = calculateStrength({ touches: st.touches, squeeze: st.squeeze, type: st.type }, br.vol, br.ext, br.q, dir, null);
            const costPct = costFor(vol24) + 2 * CFG.SLIP_PCT, costR = costPct / plan.riskPct;
            if (strength < CFG.MIN_STRENGTH || costR > CFG.MAX_COST_R || vol24 < CFG.MIN_SIG_VOL) continue;
            const sig = mkPos({ id: 'bt', strategy: 'TRI', sym, dir, time: now, entry: P, stop: plan.stop, tp1R: CFG.BRK_TP1_R, tp2R: plan.tp2R, costPct,
                tsMs: CFG.BRK_TS_MIN * 60e3, maxHold: CFG.BRK_EXPIRE_H * H1, extra: { type: st.type } });
            lastT[dir] = now;
            let done = false;
            for (let j = k + 1; j < c15.length; j++) if (advance(sig, c15[j], M15)) { done = true; break; }
            if (!done) continue;
            busy[sym] = sig.closedAt;
            trades.push({ sym, dir, type: st.type, strength, vol: r2(br.vol), ext: r2(br.ext), costR: sig.costR, riskPct: sig.riskPct, tp2R: r2(sig.tp2R), status: sig.status, netR: sig.netR, t: now });
        }
    }
    return trades;
}
function verdictOf(t, g, a, b) {
    if (t.length < 100) return ['w', 'Örnek az (' + t.length + ' işlem). Sonuca güvenme.'];
    if (g.avgR <= 0) return ['r', 'Bu kurallarla maliyetler sonrası kenar görünmüyor.'];
    if (g.t >= 2 && a.avgR > 0 && b.avgR > 0) return ['g', 'Olumlu işaret: ortalama R pozitif, iki yarıda da pozitif, t ≥ 2.'];
    return ['w', 'Karışık sonuç: ortalama R pozitif ama istikrarsız.'];
}
function btReportTri(trades) {
    const t = trades.filter(x => x.netR != null).sort((a, b) => a.t - b.t);
    if (!t.length) return { n: 0 };
    const mid = Math.floor(t.length / 2), g = grp(t), a = grp(t.slice(0, mid)), b = grp(t.slice(mid));
    const days = {}; for (const x of t) { const d = new Date(x.t).toISOString().slice(0, 10); days[d] = (days[d] || 0) + x.netR; }
    const dv = Object.values(days), [level, verdict] = verdictOf(t, g, a, b);
    const volB = x => x.vol >= 2.5 ? 'hacim 2.5x+' : x.vol >= 1.8 ? 'hacim 1.8-2.5x' : 'hacim 1.3-1.8x';
    const extB = x => x.ext <= 0.3 ? 'çizgi ötesi ≤0.3' : x.ext <= 0.45 ? 'çizgi ötesi 0.3-0.45' : 'çizgi ötesi >0.45';
    const riskB = x => x.riskPct < 0.6 ? 'risk <0.6%' : x.riskPct < 1.2 ? 'risk 0.6-1.2%' : 'risk >1.2%';
    return { n: t.length, level, verdict, perDay: t.length / dv.length, worstDay: Math.min(...dv), bestDay: Math.max(...dv), tables: {
        'Genel': { 'Tümü': g, 'İlk yarı': a, 'İkinci yarı': b },
        'Yön': groupBy(t, x => x.dir), 'Üçgen tipi': groupBy(t, x => x.type), 'Güç': groupBy(t, strBucket),
        'Kırılım hacmi': groupBy(t, volB), 'Çizgi ötesi (ATR)': groupBy(t, extB), 'Risk %': groupBy(t, riskB), 'Çıkış': groupBy(t, x => x.status) } };
}
async function btFetchAll(xc, sym, tf, ms, from, to) {
    let since = from; const out = [], end = Math.min(Date.now(), to || Infinity);
    for (let g = 0; g < 80 && since < end; g++) { const r = await xc.fetchOHLCV(sym, tf, since, 1000); if (!r.length) break; out.push(...r); const lt = r[r.length - 1][0]; if (lt < since) break; since = lt + ms; }
    const m = new Map(); for (const x of out) m.set(x[0], x);
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter(x => x[0] + ms <= end);
}
// offset: kaç gün geriye kaydırılacak. Örn days=30, offset=0 → son 30 gün; days=60, offset=30 → 90-30 gün önce arası.
async function runBacktestJob(days, n, offset) {
    if (bt.running) return;
    offset = Math.max(0, Math.min(90, Number(offset) || 0));
    bt = { running: true, i: 0, total: 0, sym: '', days, n, mode: 'tri', offset, startedAt: Date.now(), finishedAt: 0, err: '', result: null };
    try {
        if (!exBT) exBT = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
        if (!Object.keys(exBT.markets || {}).length) await exBT.loadMarkets();
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear &&
            !CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase()) && (t.quoteVolume || 0) >= CFG.MIN_SIG_VOL && !isSuspect(t.symbol))
            .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, n);
        bt.total = list.length;
        const endT = Date.now() - offset * DAY, start = endT - days * DAY, to = endT + DAY;
        let all = [], skipped = 0; const cov = [];
        for (const t of list) {
            bt.sym = baseOf(t.symbol);
            try {
                const c15 = await btFetchAll(exBT, t.symbol, '15m', M15, start - 12 * H1, to);
                const c1h = await btFetchAll(exBT, t.symbol, '1h', H1, start - 9 * DAY, to);
                cov.push(Math.min(1, c15.filter(x => x[0] >= start && x[0] < endT).length / (days * 96)));
                all = all.concat(await btSymbolTri(t.symbol, c1h, c15, t.quoteVolume, start, endT));
            } catch (e) { skipped++; }
            bt.i++;
            await sleep(500);
        }
        bt.result = btReportTri(all);
        const covAvg = cov.length ? cov.reduce((a, b) => a + b, 0) / cov.length : 0;
        Object.assign(bt.result, { skipped, coins: list.length, requested: n, days, offset, mode: 'tri', coverage: covAvg });
        if (covAvg < 0.85) { if (bt.result.level === 'g') bt.result.level = 'w'; bt.result.verdict = 'Veri kapsamı düşük (%' + Math.round(covAvg * 100) + '): borsa eski mumları eksik veriyor olabilir, sonuç güvenilmez. ' + (bt.result.verdict || ''); }
    } catch (e) { bt.err = e.message; log('backtest hata', e.message); }
    bt.running = false; bt.finishedAt = Date.now();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BT_FILE, JSON.stringify(bt)); } catch (e) { }
}

// ======================= API =======================
// Ayarlar sekmesi için: anahtar = Render ortam değişkeni adı.
function casEnv() {
    const o = {};
    for (const k of Object.keys(CAS)) {
        if (k === 'TS_MS') o.CAS_TS_MIN = CAS.TS_MS / 60e3;
        else if (k === 'MAX_HOLD') o.CAS_MAX_HOLD_H = CAS.MAX_HOLD / H1;
        else o['CAS_' + k] = CAS[k];
    }
    return o;
}
function settingsView() {
    return {
        'Casus': casEnv(),
        'Üçgen': { TRI_TF, UNIVERSE: CFG.UNIVERSE, MIN_VOL: CFG.MIN_VOL_USDT, MIN_SIG_VOL: CFG.MIN_SIG_VOL, TRI_K: CFG.TRI_K, TRI_LOOK: CFG.TRI_LOOK, TRI_MIN_LEN: CFG.TRI_MIN_LEN, TRI_MAX_LEN: CFG.TRI_MAX_LEN,
            TRI_TOL_ATR: CFG.TRI_TOL_ATR, TRI_MIN_TOUCH: CFG.TRI_MIN_TOUCH, TRI_SQUEEZE: CFG.TRI_SQUEEZE, NEAR_ATR: CFG.NEAR_ATR, BRK_SEE: CFG.BRK_SEE, BRK_ATR: CFG.BRK_ATR, BRK_VOL: CFG.BRK_VOL,
            FRESH_MIN: CFG.FRESH_MIN, MAX_CHASE: CFG.MAX_CHASE, STOP_ATR15: CFG.STOP_ATR15, STOP_MIN_PCT: CFG.STOP_MIN_PCT, BRK_TP1_R: CFG.BRK_TP1_R, BRK_TP2_R: CFG.BRK_TP2_R,
            BRK_EXPIRE_H: CFG.BRK_EXPIRE_H, BRK_TS_MIN: CFG.BRK_TS_MIN, MIN_STRENGTH: CFG.MIN_STRENGTH, MAX_COST_R: CFG.MAX_COST_R, COOLDOWN_MIN: CFG.COOLDOWN_MIN, RADAR_LOCK_H: CFG.RADAR_LOCK_H },
        'BTC Kapısı': { GATE_TH: CFG.GATE_TH, GATE_STRICT: CFG.GATE_STRICT, GATE_BRK: CFG.GATE_BRK, MAX_DIR: CFG.MAX_DIR },
        'Genel': { SCAN_CONCURRENCY: CFG.CONCURRENCY, REQ_GAP_MS: REQ_QUEUE.minGap, SLIP_PCT: CFG.SLIP_PCT, TRAIL_R: CFG.TRAIL_R }
    };
}
function apiState() {
    const now = Date.now();
    const px = {};
    for (const x of triRadar.concat(brkEvents.slice(0, 80), casEvents.slice(0, 80), casSt.hot || [])) { const t = tickers[x.symbol]; if (t && t.last) px[x.symbol] = t.last; }
    return {
        now, mode: 'v33 • Üçgen Kırılım + Casus (tarayıcı)',
        px, market, regime: REG,
        gate: GATE ? { score: GATE.score, long: GATE.long, short: GATE.short, t1: GATE.t1, sl: GATE.sl, mv: GATE.mv, age: now - GATE.u, th: CFG.GATE_TH, strict: !!CFG.GATE_STRICT } : null,
        shadowStats: shadowStatsCalc(),
        breakouts: brkEvents.slice(0, 80), brkStats: brkStatsCalc(),
        radar: triRadar,
        cas: {
            on: !!CAS.ON,
            ev: casEvents.slice(0, 80),
            stats: casStatsCalc(),
            hot: casSt.hot || [],
            dg: casSt.dg,
            probe: casSt.probe,
            ms: casSt.ms,
            last: casSt.last,
            coins: casUniverse.length
        },
        settings: settingsView(),
        live: { enabled: true, last: live.last, symbols: live.n, err: live.err, tgOn: !!(TG_TOKEN && TG_CHAT) },
        config: { tf: TRI_TF, near: CFG.NEAR_ATR, cd: CFG.COOLDOWN_MIN },
        scan: { last: scan.last, ms: scan.ms, universe: universe.length, total: scan.total, eligible: scan.eligible, minVol: CFG.MIN_VOL_USDT, drop: scan.drop }
    };
}
async function apiCandles(sym, reqTf) {
    if (!Object.prototype.hasOwnProperty.call(ex.markets || {}, sym)) throw new Error('bilinmeyen sembol');
    const useTf = reqTf || TRI_TF;
    const key = sym + '|' + useTf, hit = candleCache.get(key); if (hit && Date.now() - hit.t < 8000) return hit.d;
    let c, dur, tf;
    if (useTf === '1m') { c = await safeFetch(ex, sym, '1m', 400); dur = M1; tf = '1m'; }
    else if (useTf === '5m') { c = await safeFetch(ex, sym, '5m', 400); dur = M5; tf = '5m'; }
    else if (useTf === '15m') { c = await safeFetch(ex, sym, '15m', 400); dur = M15; tf = '15m'; }
    else if (useTf === '2h') { const c1h = await safeFetch(ex, sym, '1h', 500); c = aggregateN(c1h, H1, 2); dur = H2; tf = '2H'; }
    else { c = await safeFetch(ex, sym, '1h', 400); dur = H1; tf = '1H'; }
    const cl = clOf(c);
    const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), vs = volSma(c, 20);
    let tri = null;
    if (useTf !== '1m' && c.length > 50) { const t = detectTriangle(c, c.length - 1, CFG) || detectTriangle(c, c.length - 2, CFG); if (t) tri = pack(t, c); }
    const cut = Math.max(0, c.length - 130);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vsma: vs.slice(cut), tf, dur, tri };
    candleCache.set(key, { t: Date.now(), d });
    if (candleCache.size > 300) { const old = [...candleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100); for (const o of old) candleCache.delete(o[0]); }
    return d;
}

// ======================= MESAJLAR / YARDIMCI =======================
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function brkMsg(e) {
    return '🔔 ÜÇGEN KIRILIM ' + (e.dir === 'LONG' ? '🟢 ' : '🔴 ') + e.dir + ' ' + e.base + ' — ' + e.type + ' üçgen ' + (e.dir === 'LONG' ? 'yukarı' : 'aşağı') +
        '\nGüç ' + e.strength + ' | Hacim ' + e.volX.toFixed(1) + 'x | Piyasa: ' + e.reg +
        '\nGiriş ' + fmt(e.entry) + ' | Stop ' + fmt(e.stop) + ' | TP1 ' + fmt(e.tp1) + ' | TP2 ' + fmt(e.tp2) +
        '\nRisk %' + e.riskPct.toFixed(2) + ' | Maliyet ' + e.costR.toFixed(2) + 'R\n📈 ' + tvLink(e.base, 15);
}
function closeMsg(s) {
    return (s.netR > 0 ? '✅ ' : s.netR < 0 ? '❌ ' : '➖ ') + 'ÜÇGEN ' + s.dir + ' ' + s.base + ' kapandı: ' + s.status + ' • net ' + (s.netR > 0 ? '+' : '') + s.netR.toFixed(2) + 'R';
}

// ======================= CASUS: TARAYICI ("bak buraya") =======================
// Tahmin değil, gözlem. İki aşama:
//  AŞAMA 1 (ücretsiz): fetchTickers her 4 sn'de tüm coinleri verir (fiyat, 24s hacim, OI=holdingAmount, funding). Bunlardan
//                      bellekte ~65 dk'lık anlık görüntü geçmişi tutulur; hacim/fiyat/OI/funding anomalisi olan coinler bayraklanır.
//  AŞAMA 2 (sadece bayraklılar): 1 dk mumlar çekilip 6 sinyal tipi gerçek mum verisiyle doğrulanır.
// Çıkan her sinyal sanal pozisyon olarak 1 dk mumlarla izlenir (yön = sanal izleme için seçilmiş eğilim) → ileri dönük istatistik.
function casSnap(t, now) {
    const set = new Set(casUniverse);
    for (const sym of set) {
        const k = t[sym]; if (!k || !k.last) continue;
        let h = casHist.get(sym); if (!h) { h = []; casHist.set(sym, h); }
        if (h.length && now - h[h.length - 1][0] < CAS.SNAP_MS) continue;
        const inf = k.info || {}, oiB = Number(inf.holdingAmount), fr = Number(inf.fundingRate);
        h.push([now, k.last, k.quoteVolume || 0, isFinite(oiB) && oiB > 0 ? oiB * k.last : null, inf.fundingRate != null && isFinite(fr) ? fr : null]);
        while (h.length && now - h[0][0] > CAS.HIST_MS) h.shift();
    }
}
function buildCasUniverse(all) {
    const u = [];
    for (const t of all) {
        if (CFG.EXCLUDED.includes(baseOf(t.symbol).toUpperCase())) continue;
        if ((t.quoteVolume || 0) < CAS.MIN_VOL) continue;
        if (isSuspect(t.symbol)) continue;
        u.push(t);
    }
    u.sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
    casUniverse = u.slice(0, CAS.MAX_COINS).map(t => t.symbol);
    const set = new Set(casUniverse);
    for (const k of casHist.keys()) if (!set.has(k)) casHist.delete(k);
}
function histAt(h, now, ms) {
    const tgt = now - ms;
    for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= tgt) return (tgt - h[i][0] <= Math.max(30e3, ms * 0.5)) ? h[i] : null;
    return null;
}
function casStage1(sym, now) {
    const h = casHist.get(sym); if (!h || h.length < 3) return null;
    const a = h[h.length - 1]; if (now - a[0] > 45e3) return null;
    const p = a[1], qv = a[2];
    const h3 = histAt(h, now, 180e3), h10 = histAt(h, now, 600e3), h15 = histAt(h, now, 900e3);
    const ret = x => x ? (p / x[1] - 1) * 100 : null;
    const ret3 = ret(h3), ret10 = ret(h10), ret15 = ret(h15);
    const avgMin = qv / 1440;
    const vm3 = h3 && avgMin > 0 ? 1 + (qv - h3[2]) / (3 * avgMin) : null;      // hacim vekili: son 3 dk'nın ortalama dakikalık hacmi / 24s ortalama
    const oiChg = x => (x && x[3] && a[3]) ? (a[3] / x[3] - 1) * 100 : null;
    const oiChg10 = oiChg(h10), oiChg3 = oiChg(h3);
    let frOld = null; for (let k = 0; k < h.length; k++) if (h[k][4] != null) { frOld = h[k][4]; break; }
    const fr = a[4], frJump = (fr != null && frOld != null && now - h[0][0] >= 30 * 60e3) ? fr - frOld : null;
    const fundCd = now - (lastSig['CT|FUND|' + sym] || 0) < CAS.FUND_CD_H * H1;
    const flags = {
        vol: vm3 != null && vm3 >= CAS.S1_VOLX,
        move: (ret3 != null && Math.abs(ret3) >= CAS.S1_MOVE3) || (ret15 != null && Math.abs(ret15) >= CAS.S1_MOVE15),
        oi: oiChg10 != null && oiChg10 >= CAS.OI_PCT && a[3] >= CAS.OI_MIN_USD,
        fund: !fundCd && fr != null && frJump != null && Math.abs(fr) >= CAS.FUND_ABS && Math.abs(frJump) >= CAS.FUND_JUMP
    };
    const score1 = (flags.vol ? Math.min(3, vm3 / CAS.S1_VOLX) : 0) + (flags.move ? 1 + Math.min(2, Math.abs(ret3 || 0) / CAS.S1_MOVE3 * 0.5) : 0) + (flags.oi ? 1.5 : 0) + (flags.fund ? 1 : 0);
    return { sym, price: p, vol24: qv, ret3, ret10, ret15, vm3, oiUsd: a[3], oiChg10, oiChg3, fr, frJump, flags, flag: flags.vol || flags.move || flags.oi || flags.fund, score1 };
}
const casSlim = s => ({ symbol: s.sym, base: baseOf(s.sym), price: s.price, ret3: s.ret3 == null ? null : r2(s.ret3), ret15: s.ret15 == null ? null : r2(s.ret15), vm3: s.vm3 == null ? null : r2(s.vm3),
    oiChg10: s.oiChg10 == null ? null : r2(s.oiChg10), fr: s.fr, flags: s.flags, score1: r2(s.score1) });
async function casCandles(sym, now) {
    const hit = casCandleCache.get(sym); if (hit && now - hit.t < 20e3) return hit.c;
    const c = closedOnly(await safeFetch(ex, sym, '1m', 130), M1, now);
    casCandleCache.set(sym, { t: now, c });
    if (casCandleCache.size > 200) { const old = [...casCandleCache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 60); for (const o of old) casCandleCache.delete(o[0]); }
    return c;
}
// 6 sinyal tipi. Hepsi fiyat/hacim/OI/funding türevi, hepsi canlı gözlemlenebilir ve sanal pozisyonla ölçülebilir.
function casDetect(c, s1, now) {
    const out = [], n = c.length, i = n - 1;
    if (n >= 70) {
        const atr = atrSeries(c, 14), vols = c.map(x => x[5]);
        const medV = j => median(vols.slice(Math.max(0, j - 30), j));
        for (const j of [i, i - 1]) {
            if (j < 40 || now - (c[j][0] + M1) > 150e3 || !(atr[j] > 0)) continue;
            const b = c[j], rng = b[2] - b[3], mv = medV(j), aj = atr[j];
            if (!(rng > 0) || !(mv > 0)) continue;
            const vx = b[5] / mv;
            // 1) HACİM PATLAMASI: mum hacmi önceki 30 mumun medyanının VOLX katı + fiyat hareketi ATR'yi aşıyor, mum yönünde kapanıyor
            if (vx >= CAS.VOLX && rng >= 1.2 * aj) {
                const up = b[4] >= b[1], q = up ? (b[4] - b[3]) / rng : (b[2] - b[4]) / rng;
                if (q >= 0.5) out.push({ type: 'VOL', dir: up ? 'LONG' : 'SHORT', strength: Math.min(95, 40 + 5 * (vx - CAS.VOLX) + 10 * Math.min(2, rng / aj / 2)), vx });
            }
            // 2) LİKİDASYON FİTİLİ: büyük menzil, uzun fitil, yüksek hacim, mum fitilin tersine kapanıyor (OI düşüşü teyit sayılır). Eğilim = fitilin tersi
            if (vx >= CAS.WICK_VOLX && rng >= CAS.WICK_ATR * aj) {
                const lw = (Math.min(b[1], b[4]) - b[3]) / rng, uw = (b[2] - Math.max(b[1], b[4])) / rng;
                const dir = lw >= CAS.WICK_RATIO ? 'LONG' : uw >= CAS.WICK_RATIO ? 'SHORT' : null;
                if (dir) { const oiDrop = !!(s1 && s1.oiChg3 != null && s1.oiChg3 <= -1); out.push({ type: 'WICK', dir, strength: Math.min(95, 45 + Math.min(20, (rng / aj - CAS.WICK_ATR) * 8) + Math.min(15, vx * 2) + (oiDrop ? 15 : 0)), vx, oiDrop }); }
            }
            // 3) SIKIŞMA KIRILIMI: son 25 mumun ortalama menzili önceki 55 mumun CAS.SQZ_RATIO'sundan dar, sonra hacimli bir mum 25 mumluk aralığı kırıyor
            if (j >= 105) {
                let rs = 0, rp = 0; for (let k = j - 25; k < j; k++) rs += c[k][2] - c[k][3]; for (let k = j - 80; k < j - 25; k++) rp += c[k][2] - c[k][3];
                const comp = (rs / 25) / ((rp / 55) || 1e-12);
                if (comp <= CAS.SQZ_RATIO && vx >= CAS.SQZ_VOLX) {
                    let hi = -1e99, lo = 1e99; for (let k = j - 25; k < j; k++) { hi = Math.max(hi, c[k][2]); lo = Math.min(lo, c[k][3]); }
                    const dir = b[4] > hi + 0.2 * aj ? 'LONG' : b[4] < lo - 0.2 * aj ? 'SHORT' : null;
                    if (dir) out.push({ type: 'SQZ', dir, strength: Math.min(95, 45 + (CAS.SQZ_RATIO - comp) * 60 + vx * 3), vx });
                }
            }
        }
        // 4) TF HİZALANMASI: 5, 15 ve 60 dk'lık hareketler aynı yönde ve gürültünün (ATR*karekök(k)) üstünde, son 3 mumda hacim artmış
        if (n >= 62 && atr[i] > 0) {
            const a1 = atr[i], z = k => (c[i][4] - c[i - k][4]) / (a1 * Math.sqrt(k)), z5 = z(5), z15 = z(15), z60 = z(60);
            if (z5 !== 0 && Math.sign(z5) === Math.sign(z15) && Math.sign(z15) === Math.sign(z60) && Math.abs(z5) >= CAS.ALIGN_Z5 && Math.abs(z15) >= CAS.ALIGN_Z15 && Math.abs(z60) >= CAS.ALIGN_Z60) {
                const mv = medV(i), v3 = (vols[i] + vols[i - 1] + vols[i - 2]) / 3, vx = mv > 0 ? v3 / mv : 0;
                if (vx >= CAS.ALIGN_VOLX) out.push({ type: 'ALIGN', dir: z5 > 0 ? 'LONG' : 'SHORT', strength: Math.min(95, 40 + 10 * Math.min(Math.abs(z5) / CAS.ALIGN_Z5, Math.abs(z15) / CAS.ALIGN_Z15, Math.abs(z60) / CAS.ALIGN_Z60)), vx });
            }
        }
    }
    // 5) OI SIÇRAMASI: 10 dk'da açık pozisyon (OI) >= %OI_PCT arttı ve fiyat da hareket etti. Eğilim = fiyat yönü (yeni pozisyonlar o yönde açılıyor)
    if (s1 && s1.flags.oi && s1.ret10 != null && Math.abs(s1.ret10) >= 0.3) out.push({ type: 'OI', dir: s1.ret10 > 0 ? 'LONG' : 'SHORT', strength: Math.min(95, 45 + s1.oiChg10 * 4), vx: null });
    // 6) FUNDING UÇURUMU: funding aşırı (|f| >= FUND_ABS) ve son ~1 saatte keskin değişti. Eğilim = kalabalık tarafın tersi (squeeze hazırlığı)
    if (s1 && s1.flags.fund) out.push({ type: 'FUND', dir: s1.fr > 0 ? 'SHORT' : 'LONG', strength: Math.min(90, 40 + Math.abs(s1.fr) * 10000 * 4), vx: null });
    return out;
}
async function casEval(s1, now) {
    let c = [];
    try { c = await casCandles(s1.sym, now); } catch (e) { c = []; }
    const fired = casDetect(c, s1, now);
    if (!fired.length) return null;
    const keep = fired.filter(f => now - (lastSig['CT|' + f.type + '|' + s1.sym] || 0) >= (f.type === 'FUND' ? CAS.FUND_CD_H * H1 : CAS.COOLDOWN_MIN * 60e3));
    if (!keep.length) return null;
    const by = {}; for (const f of keep) if (!by[f.type] || f.strength > by[f.type].strength) by[f.type] = f;
    const list = Object.values(by).sort((a, b) => b.strength - a.strength), prim = list[0];
    const tset = new Set(list.map(f => f.type)), rec = casRecent[s1.sym] || {};
    for (const k of Object.keys(rec)) if (now - rec[k] <= 15 * 60e3) tset.add(k);
    const conflict = list.some(f => f.dir !== prim.dir), conf = tset.size;
    const strength = Math.max(0, Math.min(100, Math.round(prim.strength + 10 * (conf - 1) - (conflict ? 10 : 0))));
    const atr = c.length >= 20 ? atrSeries(c, 14)[c.length - 1] : null;
    return { prim, list, types: [...tset], conf, conflict, strength, atr1: atr > 0 ? atr : null, lastClose: c.length ? c[c.length - 1][4] : null };
}
function casCreate(s1, r, now) {
    const sym = s1.sym, tk = tickers[sym] || {}, price = tk.last || r.lastClose; if (!price) return null;
    const dir = r.prim.dir, L = dir === 'LONG' ? 1 : -1;
    let sd = r.atr1 ? CAS.STOP_ATR * r.atr1 : price * 0.008;
    sd = Math.max(price * CAS.MIN_STOP_PCT / 100, Math.min(price * CAS.MAX_STOP_PCT / 100, sd));
    const costPct = costFor(tk.quoteVolume || s1.vol24) + 2 * CFG.SLIP_PCT;
    return mkPos({ id: 'CAS_' + sym.replace(/[^A-Z0-9]/g, '') + '_' + now, strategy: 'CAS', sym, dir, time: now, entry: price, stop: price - L * sd, tp1R: CAS.TP1_R, tp2R: CAS.TP2_R,
        costPct, tsMs: CAS.TS_MS, maxHold: CAS.MAX_HOLD,
        extra: { type: r.prim.type, types: r.types, conf: r.conf, conflict: r.conflict, strength: r.strength, volX: r2n(r.prim.vx != null ? r.prim.vx : s1.vm3),
            ret3: r2n(s1.ret3), ret15: r2n(s1.ret15), vm3: r2n(s1.vm3), oiChg: r2n(s1.oiChg10), fr: s1.fr, tf: '1m',
            aligned: GATE ? gateOk(dir) : null, gateScore: GATE ? r2(GATE.score) : null, reg: REG ? REG.dir : '-', vol24: Number((s1.vol24 || 0).toFixed(0)), atr1: r.atr1 } });
}
function casMsg(p) {
    return '🕵️ CASUS — bak: ' + p.base + ' (sanal eğilim ' + p.dir + ')\n' + p.types.map(t => CAS_NAMES[t] || t).join(' + ') + ' • güç ' + p.strength + (p.conf >= 2 ? ' • ' + p.conf + ' tip birlikte' : '') +
        '\n3dk ' + (p.ret3 == null ? '-' : p.ret3 + '%') + ' • 15dk ' + (p.ret15 == null ? '-' : p.ret15 + '%') + ' • hacim ~' + (p.volX == null ? '-' : p.volX + 'x') + (p.oiChg != null ? ' • OI ' + p.oiChg + '%' : '') + (p.fr != null ? ' • funding ' + (p.fr * 100).toFixed(3) + '%' : '') +
        '\nSanal: giriş ' + fmt(p.entry) + ' • stop ' + fmt(p.stop) + ' • TP1 ' + fmt(p.tp1) + ' • TP2 ' + fmt(p.tp2) + '\nBu al/sat sinyali değil, gözlem uyarısıdır.\n📈 ' + tvLink(p.base, 1);
}
function casTelegram(p) {
    if (!CAS.TG || !(p.conf >= 2 || p.strength >= CAS.TG_MIN_STR)) return;
    const now = Date.now(); while (casTg.length && now - casTg[0] > 600e3) casTg.shift();
    if (casTg.length >= 6) return; casTg.push(now); telegram(casMsg(p));
}
async function casusCycle() {
    if (!CAS.ON || casSt.running || !casUniverse.length || !market.lastTick || Date.now() - market.lastTick > 60e3) return;
    casSt.running = true; const t0 = Date.now();
    const dg = { n: 0, noHist: 0, flagged: 0, s2: 0, fired: 0, sig: 0, err: 0, errMsg: '', skip: { open: 0, cap: 0, price: 0 }, byType: {}, oiN: 0, frN: 0, coins: casUniverse.length, t: t0 };
    try {
        const cands = [];
        for (const sym of casUniverse) {
            const s1 = casStage1(sym, t0); if (!s1) { dg.noHist++; continue; }
            dg.n++; if (s1.oiUsd != null) dg.oiN++; if (s1.fr != null) dg.frN++;
            if (s1.flag) cands.push(s1);
        }
        cands.sort((a, b) => b.score1 - a.score1);
        dg.flagged = cands.length; casSt.hot = cands.slice(0, 25).map(casSlim);
        const pick = cands.filter(s => t0 - (casSeen[s.sym] || 0) >= CAS.S2_CD).slice(0, CAS.S2_MAX);
        let made = 0;
        for (const s1 of pick) {
            casSeen[s1.sym] = Date.now(); dg.s2++;
            let r = null;
            try { r = await casEval(s1, Date.now()); } catch (e) { dg.err++; if (!dg.errMsg) dg.errMsg = String(e.message || e).slice(0, 120); continue; }
            if (!r) continue;
            dg.fired++;
            if (made >= CAS.MAX_PER_CYCLE || casEvents.filter(isOpen).length >= CAS.MAX_OPEN) { dg.skip.cap++; continue; }
            if (casEvents.some(x => x.symbol === s1.sym && isOpen(x))) { dg.skip.open++; continue; }
            const now = Date.now(), pos = casCreate(s1, r, now); if (!pos) { dg.skip.price++; continue; }
            casEvents.unshift(pos); if (casEvents.length > CAS.KEEP) casEvents.length = CAS.KEEP;
            const rec = casRecent[s1.sym] || (casRecent[s1.sym] = {});
            for (const f of r.list) { lastSig['CT|' + f.type + '|' + s1.sym] = now; rec[f.type] = now; }
            dirty = true; made++; dg.sig++; dg.byType[pos.type] = (dg.byType[pos.type] || 0) + 1;
            log('CASUS', pos.base, pos.types.join('+'), 'eğilim', pos.dir, 'güç', pos.strength, 'risk %' + pos.riskPct, 'maliyet ' + pos.costR + 'R');
            casTelegram(pos);
        }
        for (const k of Object.keys(casSeen)) if (t0 - casSeen[k] > 10 * 60e3) delete casSeen[k];
        for (const k of Object.keys(casRecent)) { const o = casRecent[k]; for (const t of Object.keys(o)) if (t0 - o[t] > 15 * 60e3) delete o[t]; if (!Object.keys(o).length) delete casRecent[k]; }
        log('Casus:', dg.n + '/' + dg.coins, 'coin • bayraklı', dg.flagged, '• aşama2', dg.s2, '• tetik', dg.fired, '• sinyal', dg.sig, '• OI var', dg.oiN, '• funding var', dg.frN, dg.err ? '• hata ' + dg.err + ' ' + dg.errMsg : '');
    } catch (e) { log('Casus hata', e.message); dg.errMsg = String(e.message || e).slice(0, 120); }
    finally { casSt.dg = dg; casSt.last = Date.now(); casSt.ms = casSt.last - t0; casSt.running = false; }
}
// Veri kaynağı yoklaması: OI ve funding gerçekten geliyor mu? /api/casus/probe ile de çağrılabilir.
async function casProbe() {
    const out = { t: Date.now(), tickerOI: false, tickerFunding: false, sample: null, fundingApi: null, oiApi: null, mode: '' };
    try {
        const inf = (tickers[BTC] && tickers[BTC].info) || {};
        out.tickerOI = Number(inf.holdingAmount) > 0; out.tickerFunding = inf.fundingRate != null && isFinite(Number(inf.fundingRate));
        out.sample = { holdingAmount: inf.holdingAmount == null ? null : inf.holdingAmount, fundingRate: inf.fundingRate == null ? null : inf.fundingRate, infoKeys: Object.keys(inf).slice(0, 40) };
    } catch (e) { out.sample = { err: String(e.message || e) }; }
    try { const f = await ex.fetchFundingRate(BTC); out.fundingApi = { ok: true, rate: f.fundingRate == null ? null : f.fundingRate }; } catch (e) { out.fundingApi = { ok: false, err: String(e.message || e).slice(0, 150) }; }
    try { const o = await ex.fetchOpenInterest(BTC); out.oiApi = { ok: true, amount: o.openInterestAmount == null ? null : o.openInterestAmount, value: o.openInterestValue == null ? null : o.openInterestValue }; } catch (e) { out.oiApi = { ok: false, err: String(e.message || e).slice(0, 150) }; }
    out.mode = out.tickerOI ? 'OI: ticker üzerinden (toplu, ek istek yok)' : (out.oiApi && out.oiApi.ok) ? 'OI: sadece REST var, ticker\'da yok → OI sinyali KAPALI, hacim vekili kullanılıyor' : 'OI: YOK → OI sinyali kapalı, hacim vekili kullanılıyor';
    out.mode += out.tickerFunding ? ' | Funding: ticker üzerinden' : ' | Funding: ticker\'da yok → FUND sinyali kapalı';
    casSt.probe = out; return out;
}
const CAS_TYPES = Object.keys(CAS_NAMES);
function casStatsCalc() {
    const closed = doneOf(casEvents), today = trDay(Date.now());
    const mv = list => { const n = list.length; if (!n) return { n: 0, mfe: 0, mae: 0, moved: 0 }; let a = 0, b = 0, m = 0; for (const s of list) { a += s.mfe || 0; b += s.mae || 0; if ((s.mfe || 0) >= 1 || (s.mae || 0) <= -1) m++; } return { n, mfe: a / n, mae: b / n, moved: m / n }; };
    const byHas = {}, move = {};
    for (const t of CAS_TYPES) { const l = closed.filter(s => (s.types || [s.type]).includes(t)); if (l.length) { byHas[CAS_NAMES[t]] = grp(l); move[CAS_NAMES[t]] = mv(l); } }
    return { all: grp(closed), today: grp(closed.filter(s => trDay(s.closedAt) === today)), open: casEvents.filter(isOpen).length,
        byType: groupBy(closed, s => CAS_NAMES[s.type] || s.type), byHas,
        byConf: groupBy(closed, s => s.conf >= 2 ? '2+ tip birlikte' : 'tek tip'),
        byDir: groupBy(closed, s => s.dir), byGate: groupBy(closed, s => s.aligned === true ? 'BTC kapısı uyumlu' : s.aligned === false ? 'BTC kapısı ters' : 'kapı yok'),
        byCost: groupBy(closed, s => s.costR <= 0.3 ? 'maliyet ≤0.3R' : s.costR <= 0.6 ? 'maliyet 0.3-0.6R' : 'maliyet >0.6R'),
        byExit: groupBy(closed, s => s.status), move, moveAll: mv(closed) };
}

// ======================= ARAYÜZ =======================
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
.card.sel{border-color:var(--am);box-shadow:0 0 0 1px var(--am)}.card.closed{opacity:.7}
.card.L{border-left:5px solid var(--lg);background:linear-gradient(90deg,rgba(61,220,151,.09),var(--p2) 45%)}
.card.S{border-left:5px solid var(--st);background:linear-gradient(90deg,rgba(255,107,122,.09),var(--p2) 45%)}
.r1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.dirb{font-weight:800;font-size:13px;padding:4px 12px;border-radius:5px;letter-spacing:.3px}
.dirb.L{background:var(--lg);color:#08130d}.dirb.S{background:var(--st);color:#1a0508}
.strat{font-weight:800;font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid}
.strat.cas{color:#b794f4;border-color:#b794f4;background:rgba(183,148,244,.10)}
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
.tvl{font-size:11px;color:var(--bl);text-decoration:none;font-weight:700}
.tfb{display:inline-flex;gap:0;margin-left:auto}.tfb button{background:var(--bg);border:1px solid var(--ln);padding:5px 10px;font-weight:700;font-size:11px;color:var(--dm)}
.tfb button.a{background:var(--am);color:#1a1405;border-color:var(--am)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
#toast{position:fixed;top:12px;right:12px;z-index:99;background:#f2b84b;color:#1a1405;padding:12px 16px;border-radius:8px;font-weight:800;cursor:pointer;display:none}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:46vh}canvas{height:320px}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v33</small></div>
  <div class="chip" id="cReg"></div><div class="chip" id="cGate"></div><div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div><div class="chip" id="cHealth"></div>
  <div class="grow"></div><span><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div>
  <div class="main" id="main"></div>
 </div>
</div>
<div id="toast"></div>
<script>
var TABS=[['tri','Üçgen'],['cas','Casus'],['stat','İstatistik'],['bt','Backtest'],['set','Ayarlar']];
var KEY=new URLSearchParams(location.search).get('key')||'';
function api(p){return KEY?p+(p.indexOf('?')>=0?'&':'?')+'key='+encodeURIComponent(KEY):p}
var S=null,tab='tri',sel=null,tfSel=null,chartCache={},chartFor='',cfgC={bal:1000,risk:0.5},actx=null,lastBrkT=0,lastCasT=0,toastT=null;
try{cfgC=JSON.parse(localStorage.getItem('st_calc')||'{"bal":1000,"risk":0.5}')}catch(e){}
function $(id){return document.getElementById(id)}
function fp(p){if(p==null||isNaN(p))return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){d=d==null?2:d;return x==null||isNaN(x)?'-':Number(x).toFixed(d)}
function sg(x,d){d=d==null?2:d;if(x==null)return'-';x=Number(x);if(isNaN(x))return'-';return(x>0?'+':'')+x.toFixed(d)}
function cl(x){return x>0?'kar':x<0?'zarar':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])})}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function clk(ts){var d=new Date(ts);return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
function isOp(x){return x.status==='OPEN'||x.status==='TP1'}
function strTag(s){var x=s>=75?{l:'ÇOK GÜÇLÜ',c:'g'}:s>=55?{l:'GÜÇLÜ',c:'g'}:s>=35?{l:'ORTA',c:'w'}:{l:'ZAYIF',c:'r'};return '<span class="tag '+x.c+'">GÜÇ '+s+' '+x.l+'</span>'}
function volTag(v){if(v==null)return'';var c=v>=1.5?'g':v>=1.0?'w':'r';return '<span class="tag '+c+'">Hacim '+f2(v,1)+'x</span>'}
function stratTag(k){return k==='cas'?'<span class="strat cas">🕵️ CASUS</span>':k==='brk'?'<span class="strat tri">△ ÜÇGEN KIRILIM</span>':k==='hot'?'<span class="strat cas">👀 DİKKAT LİSTESİ</span>':'<span class="strat rad">◎ ÜÇGEN RADAR</span>'}
function stratName(k,o){return k==='cas'?'CASUS':k==='hot'?'DİKKAT':k==='brk'?'ÜÇGEN KIRILIM':'ÜÇGEN RADAR'+(o&&o.broke?' • ONAYSIZ KIRILIM':'')}
function dirBadge(d){return '<span class="dirb '+(d==='LONG'?'L':'S')+'">'+(d==='LONG'?'▲ LONG':'▼ SHORT')+'</span>'}
var CN={VOL:'Hacim patlaması',OI:'OI sıçraması',WICK:'Likidite fitili',FUND:'Funding uçurumu',SQZ:'Sıkışma kırılımı',ALIGN:'TF hizalanması'};
var ST={OPEN:['AÇIK','w'],TP1:['TP1_ALINDI','g'],TP2:['TP2','g'],TRAIL:['TRAIL','g'],BE:['BE','w'],STOP:['STOP','r'],TIMEOUT:['TIMEOUT','w'],'SÜRE':['TIMEOUT','w']};
function tvl(sym,iv){return '<a class="tvl" target="_blank" href="https://www.tradingview.com/chart/?symbol=BITGET:'+esc(sym.split('/')[0])+'USDT.P&interval='+iv+'" onclick="event.stopPropagation()">📈 TV</a>'}
function beep(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();var o=actx.createOscillator(),g=actx.createGain();o.connect(g);g.connect(actx.destination);o.frequency.value=880;g.gain.value=0.1;o.start();o.stop(actx.currentTime+0.35)}catch(e){}}
addEventListener('pointerdown',function(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==='suspended')actx.resume()}catch(e){}},{once:true});
function showToast(txt,fn){var t=$('toast');t.textContent=txt;t.style.display='block';t.onclick=function(){t.style.display='none';fn()};clearTimeout(toastT);toastT=setTimeout(function(){t.style.display='none'},25000)}
function pick(kind,id,sym){sel={kind:kind,id:id||'',sym:sym};tfSel=null;chartFor='';$('main').removeAttribute('data-view')}
function defTf(kind){return kind==='rad'?S.config.tf:(kind==='cas'||kind==='hot')?'1m':'15m'}
function checkBrk(){var a=S.breakouts||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastBrkT){lastBrkT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastBrkT});if(mx>lastBrkT)lastBrkT=mx;
 if(nw.length){beep();setTimeout(beep,400);var e=nw[0];showToast('🔔 ÜÇGEN KIRILIM '+e.dir+' '+e.base+' — GÜÇ '+e.strength,function(){tab='tri';pick('brk',e.id,e.symbol);renderAll()})}}
function checkCas(){var a=(S.cas&&S.cas.ev)||[],mx=a.reduce(function(m,x){return Math.max(m,x.time||0)},0);
 if(!lastCasT){lastCasT=mx||Date.now();return}
 var nw=a.filter(function(x){return x.time>lastCasT&&(x.conf>=2||x.strength>=80)});if(mx>lastCasT)lastCasT=mx;
 if(nw.length){beep();var s=nw[0];showToast('🕵️ CASUS bak: '+s.base+' • '+(s.types||[s.type]).map(function(t){return CN[t]||t}).join(' + '),function(){tab='cas';pick('cas',s.id,s.symbol);renderAll()})}}

function posInfo(o){
 if(!o||o.entry==null||!o.riskAbs)return null;
 var L=o.dir==='LONG'?1:-1,px=(S.px&&S.px[o.symbol])||o.lastPrice||o.price||o.entry,open=isOp(o),fin=!open&&o.netR!=null;
 var r=fin?o.netR:L*(px-o.entry)/o.riskAbs;
 var pct=fin?((o.grossR!=null?o.grossR:o.netR)*(o.riskPct||0)):L*(px-o.entry)/o.entry*100;
 return{L:L,px:px,open:open,fin:fin,r:r,pct:pct,levels:{entry:o.entry,stop:o.stop,tp1:o.tp1,tp2:o.tp2,t:o.time}}}

function renderTop(){var m=S.market,R=S.regime,G=S.gate,sc=S.scan||{},dr=sc.drop||{},C=S.cas||{};
 if(!R)$('cReg').innerHTML='<b>Yön</b> <span class="fl">hesaplanıyor…</span>';
 else{var c=R.dir==='LONG'?'up':R.dir==='SHORT'?'dn':'fl';
  $('cReg').innerHTML='<b>Yön</b> <span class="'+c+'" style="font-weight:800">'+R.dir+'</span> <span class="'+c+'">'+sg(R.score,0)+'</span> <span class="fl">| '+R.regime+(R.breadth?' | ↑'+R.breadth.up+' ↓'+R.breadth.dn:'')+'</span>'}
 if(!G)$('cGate').innerHTML='<b>BTC Kapı</b> <span class="fl">bekleniyor…</span>';
 else $('cGate').innerHTML='<b>BTC Kapı</b> <span class="'+(G.long?'up':'fl')+'">LONG '+(G.long?'✓':'✗')+'</span> <span class="'+(G.short?'dn':'fl')+'">SHORT '+(G.short?'✓':'✗')+'</span> <span class="fl">('+sg(G.score*100,0)+')</span>';
 $('cMkt').innerHTML='<b>Üçgen evreni</b> '+sc.universe+' coin <span class="fl">• <b>Casus</b> '+(C.coins||0)+' coin</span>';
 $('cBTC').innerHTML=m.btc?'<b>BTC</b> '+fp(m.btc.price)+' <span class="'+cl(m.btc.chg)+'">'+sg(m.btc.chg)+'%</span>':'';
 $('cETH').innerHTML=m.eth?'<b>ETH</b> '+fp(m.eth.price)+' <span class="'+cl(m.eth.chg)+'">'+sg(m.eth.chg)+'%</span>':'';
 var A=(C.stats&&C.stats.today)||{totalR:0,n:0},B=(S.brkStats&&S.brkStats.today)||{totalR:0,n:0};
 $('cHealth').innerHTML='<b>Bugün</b> <span class="'+cl(B.totalR)+'">Üçgen '+sg(B.totalR,1)+'R</span> <span class="fl">|</span> <span class="'+cl(A.totalR)+'">Casus '+sg(A.totalR,1)+'R</span>';
 $('modeB').textContent=S.mode}

function renderTabs(){var C=S.cas||{},oc=(C.ev||[]).filter(isOp).length,nr=(S.radar||[]).length,nb=(S.breakouts||[]).filter(isOp).length,nk=(S.radar||[]).filter(function(x){return x.broke}).length;
 $('tabs').innerHTML=TABS.map(function(t){
  var cnt=t[0]==='cas'?' ('+oc+')':t[0]==='tri'?' ('+nb+' • '+nk+' • '+(nr-nk)+')':'';
  return '<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+cnt+'</button>'
 }).join('');
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.dataset.t;if(tab==='stat'||tab==='bt'||tab==='set')sel=null;else if(sel&&((tab==='tri'&&sel.kind==='cas')||(tab==='cas'&&(sel.kind==='brk'||sel.kind==='rad'))))sel=null;if(tab==='bt')pollBT();$('main').removeAttribute('data-view');renderAll()}})}

function posCard(kind,o){
 var P=posInfo(o),L=o.dir==='LONG'?1:-1,op=isOp(o),st=ST[o.status]||['?',''];
 var pn=P?'<span class="sc '+cl(P.r)+'">'+sg(P.r)+'R <small>'+sg(P.pct)+'%</small></span>':'';
 var al=o.aligned===true?'<span class="tag g">BTC kapısı uyumlu</span>':o.aligned===false?'<span class="tag r">BTC kapısı ters</span>':'';
 var tags=kind==='cas'?(o.types||[o.type]).map(function(t){return '<span class="tag w">'+(CN[t]||t)+'</span>'}).join('')+(o.conf>=2?'<span class="tag g">'+o.conf+' TİP</span>':'')+'<span class="tag">eğilim</span>':'<span class="tag w">'+esc(o.type||'')+'</span><span class="tag g">ONAYLI</span>';
 return '<div class="card '+(L===1?'L':'S')+(op?'':' closed')+(sel&&sel.kind===kind&&sel.id===o.id?' sel':'')+'" data-kind="'+kind+'" data-id="'+esc(o.id)+'" data-sym="'+esc(o.symbol)+'"><div class="r1">'+dirBadge(o.dir)+'<span class="coin">'+esc(o.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+stratTag(kind)+tags+strTag(o.strength||0)+volTag(o.volX)+al+'</div><div class="sub"><span>Sinyal <b>'+clk(o.time)+'</b> ('+ago(o.time)+' önce)</span>'+(op?'':'<span>Kapandı <b>'+clk(o.closedAt)+'</b></span>')+'<span>Giriş <b>'+fp(o.entry)+'</b></span><span>Stop <b class="zarar">'+fp(o.stop)+'</b></span><span>TP1 <b class="kar">'+fp(o.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(o.tp2)+'</b></span>'+tvl(o.symbol,kind==='cas'?1:15)+'</div></div>'}

function radCard(r){var s=r.strength||0,P=(r.broke&&r.entry!=null)?posInfo(r):null;
 var al=r.aligned===true?'<span class="tag g">kapı açık</span>':r.aligned===false?'<span class="tag r">kapı kapalı</span>':'';
 var rs=r.rs!=null?'<span class="tag '+(r.rs>0?'g':'r')+'">RS '+sg(r.rs)+'%</span>':'';
 var pn=P?'<span class="sc '+cl(P.r)+'">'+sg(P.r)+'R <small>'+sg(P.pct)+'%</small></span>':'';
 var lv=P?'<div class="sub"><span>Çizgi <b>'+fp(r.entry)+'</b></span><span>Stop <b class="zarar">'+fp(r.stop)+'</b></span><span>TP1 <b class="kar">'+fp(r.tp1)+'</b></span><span>TP2 <b class="kar">'+fp(r.tp2)+'</b></span></div>':'';
 return '<div class="card '+(r.bias==='LONG'?'L':'S')+(sel&&sel.kind==='rad'&&sel.sym===r.symbol?' sel':'')+'" data-kind="rad" data-id="" data-sym="'+esc(r.symbol)+'"><div class="r1">'+dirBadge(r.bias)+'<span class="coin">'+esc(r.base)+'</span><span class="fl">'+fp(r.price)+'</span><span class="tag '+(r.broke?'w':'')+'">'+(r.broke?'KIRILDI (onaysız)':'hazır')+'</span>'+pn+'</div><div class="r1" style="margin-top:5px">'+stratTag('rad')+strTag(s)+al+rs+tvl(r.symbol,15)+'</div><div class="sub"><span>'+esc(r.state)+'</span></div>'+lv+'</div>'}

function hotRow(x){var f=x.flags||{},tg=(f.vol?'<span class="tag w">hacim</span>':'')+(f.move?'<span class="tag w">hareket</span>':'')+(f.oi?'<span class="tag w">OI</span>':'')+(f.fund?'<span class="tag w">funding</span>':'');
 return '<div class="card'+(sel&&sel.kind==='hot'&&sel.sym===x.symbol?' sel':'')+'" data-kind="hot" data-id="" data-sym="'+esc(x.symbol)+'"><div class="r1"><span class="coin">'+esc(x.base)+'</span><span class="fl">'+fp(x.price)+'</span>'+tg+tvl(x.symbol,1)+'</div><div class="sub"><span>3dk <b class="'+cl(x.ret3)+'">'+sg(x.ret3)+'%</b></span><span>15dk <b class="'+cl(x.ret15)+'">'+sg(x.ret15)+'%</b></span><span>hacim ~<b>'+f2(x.vm3,1)+'x</b></span><span>OI10dk <b>'+sg(x.oiChg10,1)+'%</b></span><span>funding <b>'+(x.fr==null?'-':f2(x.fr*100,3)+'%')+'</b></span></div></div>'}

function renderList(){var h='',L=$('list'),sc=L.scrollTop;
 if(tab==='tri'){var ev=S.breakouts||[],rd=S.radar||[];
  var act=ev.filter(isOp),closed=ev.filter(function(x){return !isOp(x)});
  var brk=rd.filter(function(x){return x.broke}),near=rd.filter(function(x){return !x.broke});
  h='<div class="note" style="padding:6px 8px">△ Sekme sayacı: (açık onaylı • çizgiyi aşan • yaklaşan). <b>ONAYLI</b> = 1s üçgen çizgisi 15m kapanış + hacimle kırıldı ve BTC kapısı geçti. Her kart sinyal anından itibaren canlı R ve % gösterir; TP1 alınca stop girişe çekilir. <b>KIRILDI (onaysız)</b> = çizgi aşıldı ama onay yok, R çizgi seviyesinden hesaplanır. Onaylı kırılım alınan coin '+6+' saat radardan çıkar.</div>';
  if(act.length)h+='<h3>Onaylı kırılımlar — açık ('+act.length+')</h3>'+act.map(function(e){return posCard('brk',e)}).join('');
  if(brk.length)h+='<h3>Çizgiyi aşanlar — onaysız, anlık K/Z ('+brk.length+')</h3>'+brk.map(radCard).join('');
  if(near.length)h+='<h3>Çizgiye yaklaşanlar ('+near.length+')</h3>'+near.map(radCard).join('');
  if(!rd.length&&!act.length)h+='<div class="note" style="padding:10px">Yaklaşan yok.</div>';
  if(closed.length)h+='<h3>Kapananlar</h3>'+closed.slice(0,20).map(function(e){return posCard('brk',e)}).join('')}
 else if(tab==='cas'){var C=S.cas||{},cev=C.ev||[],ao=cev.filter(isOp),ac=cev.filter(function(x){return !isOp(x)}),hot=C.hot||[];
  h='<div class="note" style="padding:6px 8px">🕵️ <b>CASUS bir tahmin değil, tarayıcıdır.</b> Coinlerde hacim patlaması, OI sıçraması, funding uçurumu, sıkışma kırılımı, likidite fitili ve zaman dilimi hizalanması arar ve "şuraya bak" der. Karar sende. Kartlardaki <b>eğilim</b>, yalnızca sanal izleme için seçilen yöndür; Casus "al" demez. Her sinyal 1 dk mumlarla sanal izlenir (stop '+(((S.settings||{})['Casus']||{}).CAS_STOP_ATR||3.5)+'×ATR, TP1 1R yarım, TP2 2R, 20 dk hareket yoksa TIMEOUT) ve İstatistik sekmesinde hangi tipin işe yaradığı birikir.</div>';
  if(!C.on)h+='<div class="note" style="padding:6px 8px;color:var(--st)">Casus kapalı (CAS_ON=0).</div>';
  h+='<h3>Anlık dikkat listesi — bayraklı coinler ('+hot.length+')</h3>';
  h+=hot.length?hot.slice(0,15).map(hotRow).join(''):'<div class="note" style="padding:6px 8px">Şu an bayraklı coin yok (geçmiş birikiyor: ilk 15 dk veri toplar).</div>';
  if(ao.length)h+='<h3>Açık sinyaller ('+ao.length+')</h3>'+ao.map(function(e){return posCard('cas',e)}).join('');
  if(ac.length)h+='<h3>Kapananlar</h3>'+ac.slice(0,25).map(function(e){return posCard('cas',e)}).join('');
  if(!cev.length)h+='<div class="note" style="padding:10px">Henüz Casus sinyali yok.</div>'}
 else h='<div class="note" style="padding:10px">Detaylar sağda.</div>';
 L.innerHTML=h;L.scrollTop=sc;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){pick(e.dataset.kind,e.dataset.id,e.dataset.sym);renderList();renderMain()}})}

function calc(e,s){var bal=+cfgC.bal||0,rk=Math.min(2,+cfgC.risk||0),ru=bal*rk/100,d=Math.abs(e-s);if(!d||!bal)return null;var q=ru/d;return{ru:ru,q:q,n:q*e,lev:q*e/bal}}
function calcBox(e,s){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesabı</h3><div class="frm"><label class="fl">Bakiye<br><input id="cBal" type="number" value="'+cfgC.bal+'"></label><label class="fl">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfgC.risk+'"></label><label class="fl">Giriş<br><input id="cE" type="number" step="any" value="'+(e||'')+'"></label><label class="fl">Stop<br><input id="cS" type="number" step="any" value="'+(s||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px"></div></div>'}
function bindCalc(){var upd=function(){cfgC.bal=+$('cBal').value;cfgC.risk=Math.min(2,+$('cRisk').value);try{localStorage.setItem('st_calc',JSON.stringify(cfgC))}catch(e){}var c=calc(+$('cE').value,+$('cS').value);$('cOut').innerHTML=c?'1R = <b>'+f2(c.ru)+' USDT</b> | Miktar <b>'+f2(c.q,4)+'</b> | Poz <b>'+f2(c.n,1)+'</b> | Kald <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'};
 ['cBal','cRisk','cE','cS'].forEach(function(i){var e=$(i);if(e)e.oninput=upd});if($('cOut'))upd()}

var tbl=function(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th><th class="n">t</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n">'+f2(x.pf)+'</td><td class="n">'+f2(x.t)+'</td></tr>'}).join('')+'</table>'};
function moveTbl(m,all){var rows=Object.keys(m).map(function(k){var x=m[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n kar">'+sg(x.mfe)+'</td><td class="n zarar">'+sg(x.mae)+'</td><td class="n">'+f2(x.moved*100,0)+'</td></tr>'}).join('');
 return '<h3>Hareket gözlemi (yön doğru mu bağımsız: sinyalden sonra fiyat ±1R oynadı mı?)</h3><table><tr><th>Tip (içeren)</th><th class="n">N</th><th class="n">Ort. lehte (MFE)</th><th class="n">Ort. aleyhte (MAE)</th><th class="n">≥1R hareket %</th></tr>'+rows+'<tr><td><b>Tümü</b></td><td class="n">'+all.n+'</td><td class="n kar">'+sg(all.mfe)+'</td><td class="n zarar">'+sg(all.mae)+'</td><td class="n">'+f2(all.moved*100,0)+'</td></tr></table><div class="note">Casus bir yön tahmincisi değil dikkat çekicidir. "≥1R hareket" yüksek ama OrtR negatifse tip bir şeyin olduğunu yakalıyor ama eğilim yönü yanlış demektir. Yön kuralı sonra düzeltilebilir.</div>'}
function statView(){var C=S.cas||{},A=C.stats||{},B=S.brkStats||{},Sh=S.shadowStats||{},h='<h2>İstatistik</h2>';
 h+='<h3 style="color:var(--tx);font-size:14px">△ ÜÇGEN KIRILIM (onaylı)</h3>';
 if(B.all&&B.all.n){h+=tbl({'Tümü':B.all,'Bugün':B.today},'Genel')+tbl(B.byStrength||{},'Güç')+tbl(B.byType||{},'Üçgen tipi')+tbl(B.byDir||{},'Yön')+tbl(B.byExit||{},'Çıkış')+'<div class="note">En az 100 kapanmış işlem olmadan sonuca güvenme. Takip 1 dk mum high/low ile yapılır, maliyet düşülmüştür.</div>'}
 else h+='<div class="note">Henüz kapanan kırılım yok.</div>';
 h+='<h3 style="color:var(--tx);font-size:14px;margin-top:18px">🕵️ CASUS (ileri dönük gözlem, sanal pozisyon)</h3>';
 if(A.all&&A.all.n){h+=tbl({'Tümü':A.all,'Bugün':A.today},'Genel')+tbl(A.byType||{},'Ana tip')+tbl(A.byHas||{},'Tipi içeren sinyaller (bir sinyal birden fazla grupta olabilir)')+tbl(A.byConf||{},'Birleşme (aynı coinde 15 dk içinde kaç tip)')+tbl(A.byDir||{},'Eğilim yönü')+tbl(A.byGate||{},'BTC kapısı')+tbl(A.byCost||{},'Maliyet / risk')+tbl(A.byExit||{},'Çıkış')+moveTbl(A.move||{},A.moveAll||{n:0,mfe:0,mae:0,moved:0})}
 else h+='<div class="note">Henüz kapanan Casus sinyali yok (açık: '+(A.open||0)+'). Her sinyal en fazla 60 dk içinde kapanır.</div>';
 h+='<h3 style="color:var(--tx);font-size:14px;margin-top:18px">👻 GÖLGE KAYIT (Üçgen: filtrenin eleyip sanal izlediği sinyaller)</h3>';
 if(Sh.all&&Sh.all.n){h+=tbl({'Tümü':Sh.all},'Genel')+tbl(Sh.byReason||{},'Elenme nedeni')+'<div class="note">OrtR <b>negatifse</b> filtre zararlı işlemi engellemiş (işe yarıyor). <b>Pozitifse</b> filtre fazla katı demektir.</div>'}
 else h+='<div class="note">Henüz kapanan gölge işlem yok (açık: '+(Sh.open||0)+').</div>';
 return h}

function setView(){var st=S.settings||{},C=S.cas||{},pr=C.probe,h='<h2>Ayarlar</h2><div class="note" style="margin:0 0 10px">Salt okunur. Değerleri Render ortam değişkenleriyle (Environment) değiştir; kolon başlığı ortam değişkeni adıdır. Değiştirince servis yeniden başlar.</div>';
 Object.keys(st).forEach(function(g){h+='<h3>'+esc(g)+'</h3><table><tr><th>Ortam değişkeni</th><th class="n">Değer</th></tr>'+Object.keys(st[g]).map(function(k){return '<tr><td>'+esc(k)+'</td><td class="n">'+esc(String(st[g][k]))+'</td></tr>'}).join('')+'</table>'});
 h+='<h3>Casus veri kaynağı yoklaması</h3>';
 if(!pr)h+='<div class="note">Henüz yoklanmadı.</div>';
 else h+='<div class="box"><b>'+esc(pr.mode)+'</b><div class="note" style="color:var(--tx)">Ticker OI: '+(pr.tickerOI?'VAR':'YOK')+' • Ticker funding: '+(pr.tickerFunding?'VAR':'YOK')+' • fetchFundingRate: '+(pr.fundingApi&&pr.fundingApi.ok?'çalışıyor':'hata: '+esc(pr.fundingApi?pr.fundingApi.err:'?'))+' • fetchOpenInterest: '+(pr.oiApi&&pr.oiApi.ok?'çalışıyor':'hata: '+esc(pr.oiApi?pr.oiApi.err:'?'))+'</div><div class="note">Örnek (BTC) holdingAmount: '+esc(String(pr.sample&&pr.sample.holdingAmount))+' • fundingRate: '+esc(String(pr.sample&&pr.sample.fundingRate))+'</div></div>';
 var dg=C.dg;if(dg)h+='<h3>Son Casus taraması ('+f2((C.ms||0)/1000,1)+' sn, '+ago(C.last)+' önce)</h3><div class="box"><div class="note" style="color:var(--tx)">Geçmişi hazır coin '+dg.n+'/'+dg.coins+' (hazır olmayan '+dg.noHist+') • bayraklı '+dg.flagged+' • mum çekilen '+dg.s2+' • tip tetikleyen '+dg.fired+' • yeni sinyal '+dg.sig+' • OI verisi olan '+dg.oiN+' • funding olan '+dg.frN+' • elenen '+esc(JSON.stringify(dg.skip))+(dg.err?' • hata '+dg.err+' '+esc(dg.errMsg):'')+'</div></div>';
 return h}

// ---------------- GRAFİK ----------------
function drawChart(d,V,cid){
 var c=$(cid);if(!c||!d||!d.c.length)return;
 var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;
 if(c.width!==Math.round(W*dp)||c.height!==Math.round(H*dp)){c.width=Math.round(W*dp);c.height=Math.round(H*dp)}
 var x=c.getContext('2d');x.setTransform(dp,0,0,dp,0,0);x.clearRect(0,0,W,H);
 var dirCol=V&&V.dir?(V.dir==='LONG'?'#3ddc97':'#ff6b7a'):'#243040';c.style.borderColor=dirCol;
 var lv=V&&V.levels,tri=d.tri,nc=d.c.length,n=nc+(tri?15:4);
 var L=8,R=112,T=42,B=18,volH=56,PW=W-L-R,PH=H-T-B-volH-8;
 var ti=function(t){return (t-d.c[0][0])/d.dur};
 var px=(V&&V.px!=null)?V.px:d.c[nc-1][4];
 var hi=-1e99,lo=1e99;
 d.c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3])});
 hi=Math.max(hi,px);lo=Math.min(lo,px);
 if(lv)[lv.entry,lv.stop,lv.tp1,lv.tp2].forEach(function(q){if(q==null)return;var v=Number(q);if(isFinite(v)){hi=Math.max(hi,v);lo=Math.min(lo,v)}});
 var tl=[];
 if(tri)[tri.res,tri.sup].forEach(function(l){var a=ti(l[0][0]),b=ti(l[1][0]),m=(l[1][1]-l[0][1])/((b-a)||1),xa=Math.max(a,0);tl.push([a,l[0][1],b,l[1][1]]);[xa,b].forEach(function(q){var v=l[0][1]+m*(q-a);hi=Math.max(hi,v);lo=Math.min(lo,v)})});
 var pad=(hi-lo)*.07;hi+=pad;lo-=pad;
 var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+.5)/n*PW},cw=Math.max(2,PW/n*.7);
 var labs=[];
 if(lv){labs.push({p:lv.entry,col:'#f2b84b',t:V.virtual?'ÇİZGİ':'GİRİŞ'});labs.push({p:lv.stop,col:'#ff6b7a',t:'STOP'});
  if(lv.tp1!=null)labs.push({p:lv.tp1,col:'#3ddc97',t:lv.tp2!=null?'TP1':'TP'});
  if(lv.tp2!=null)labs.push({p:lv.tp2,col:'#5aa9ff',t:'TP2'})}
 labs.push({p:px,col:'#e6ebf2',t:'',cur:1});
 labs.forEach(function(l){l.y=Y(l.p);l.yy=l.y});
 labs.sort(function(a,b){return a.y-b.y});
 for(var i=1;i<labs.length;i++){if(labs[i].yy-labs[i-1].yy<16)labs[i].yy=labs[i-1].yy+16}
 var si=-1;if(lv&&lv.t){si=Math.floor(ti(lv.t));if(si<0||si>=nc)si=-1}
 if(lv){var zx=si>=0?X(si):L,zw=W-R-zx,ye=Y(lv.entry),ys=Y(lv.stop),far=lv.tp2!=null?lv.tp2:lv.tp1,yt=far!=null?Y(far):ye;
  x.fillStyle='rgba(255,107,122,.11)';x.fillRect(zx,Math.min(ye,ys),zw,Math.abs(ys-ye));
  x.fillStyle='rgba(61,220,151,.11)';x.fillRect(zx,Math.min(ye,yt),zw,Math.abs(yt-ye))}
 x.font='10px system-ui';
 for(var g=0;g<=5;g++){var gy=T+PH*g/5,gp=hi-(hi-lo)*g/5;x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();
  var near=labs.some(function(l){return Math.abs(l.yy-gy)<10});if(!near){x.fillStyle='#6f7e91';x.fillText(fp(gp),W-R+8,gy+3)}}
 var line=function(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;st?x.lineTo(X(k),Y(v)):(x.moveTo(X(k),Y(v)),st=true)});x.stroke()};
 line(d.e50,'#b794f4',1.1);line(d.e21,'#5aa9ff',1.1);
 d.c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();x.fillRect(X(i)-cw/2,Math.min(Y(k[1]),Y(k[4])),cw,Math.max(1,Math.abs(Y(k[4])-Y(k[1]))))});
 var vmax=Math.max.apply(null,d.c.map(function(k){return k[5]}))||1,vTop=T+PH+8;
 x.strokeStyle='rgba(255,255,255,.08)';x.beginPath();x.moveTo(L,vTop);x.lineTo(W-R,vTop);x.stroke();
 d.c.forEach(function(k,i){var col=k[4]>=k[1]?'#3ddc97':'#ff6b7a',h=(k[5]/vmax)*(volH-4);x.fillStyle=col;x.globalAlpha=0.55;x.fillRect(X(i)-cw/2,vTop+volH-h,cw,h);x.globalAlpha=1});
 if(d.vsma){x.strokeStyle='#f2b84b';x.lineWidth=1.1;x.beginPath();var s2=false;d.vsma.forEach(function(v,k){if(v==null)return;var y=vTop+volH-(v/vmax)*(volH-4);s2?x.lineTo(X(k),y):(x.moveTo(X(k),y),s2=true)});x.stroke()}
 if(tri){x.save();x.beginPath();x.rect(L,T,PW,PH);x.clip();
  tl.forEach(function(l){x.strokeStyle='rgba(255,212,0,.8)';x.lineWidth=1.6;x.beginPath();x.moveTo(X(l[0]),Y(l[1]));x.lineTo(X(l[2]),Y(l[3]));x.stroke()});
  x.fillStyle='rgba(255,212,0,.9)';tri.hi.concat(tri.lo).forEach(function(p){x.beginPath();x.arc(X(ti(p[0])),Y(p[1]),2.5,0,7);x.fill()});
  x.restore()}
 x.save();x.beginPath();x.rect(L,T,W-R-L,PH);x.clip();
 labs.forEach(function(l){if(l.cur)return;x.strokeStyle=l.col;x.lineWidth=1.3;x.globalAlpha=.85;x.setLineDash([6,4]);x.beginPath();x.moveTo(L,l.y);x.lineTo(W-R,l.y);x.stroke();x.setLineDash([]);x.globalAlpha=1});
 x.restore();
 if(si>=0){var kk=d.c[si],isL=V.dir==='LONG',mx=X(si);
  x.strokeStyle='rgba(242,184,75,.5)';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(mx,T);x.lineTo(mx,T+PH);x.stroke();x.setLineDash([]);
  x.fillStyle=isL?'#3ddc97':'#ff6b7a';x.beginPath();
  if(isL){var y0=Y(kk[3])+5;x.moveTo(mx,y0);x.lineTo(mx-8,y0+14);x.lineTo(mx+8,y0+14)}else{var y1=Y(kk[2])-5;x.moveTo(mx,y1);x.lineTo(mx-8,y1-14);x.lineTo(mx+8,y1-14)}
  x.closePath();x.fill();x.fillStyle='#e6ebf2';x.font='bold 10px system-ui';x.fillText('GİRİŞ',mx+10,isL?Y(kk[3])+18:Y(kk[2])-8)}
 x.strokeStyle='rgba(255,255,255,.7)';x.lineWidth=1;x.setLineDash([1,3]);x.beginPath();x.moveTo(L,Y(px));x.lineTo(W-R,Y(px));x.stroke();x.setLineDash([]);
 labs.forEach(function(l){var y=Math.max(T-4,Math.min(T+PH+4,l.yy)),txt=(l.t?l.t+' ':'')+fp(l.p);
  x.fillStyle=l.col;x.fillRect(W-R+2,y-8,R-4,16);x.fillStyle='#0c1117';x.font='bold 10px system-ui';x.fillText(txt,W-R+6,y+3.5)});
 x.fillStyle='#6f7e91';x.font='10px system-ui';var stp=Math.max(1,Math.ceil(nc/7));
 for(var q=0;q<nc;q+=stp){var dt=new Date(d.c[q][0]),hh=('0'+dt.getHours()).slice(-2)+':'+('0'+dt.getMinutes()).slice(-2);x.fillText(hh,X(q)-12,H-5)}
 x.font='10px system-ui';x.fillStyle='#5aa9ff';x.fillRect(L+6,T+6,10,3);x.fillStyle='#8593a5';x.fillText('EMA21',L+20,T+10);
 x.fillStyle='#b794f4';x.fillRect(L+62,T+6,10,3);x.fillStyle='#8593a5';x.fillText('EMA50',L+76,T+10);
 x.fillStyle='#8593a5';x.fillText(d.tf,L+118,T+10);
 if(V&&V.dir){var isLg=V.dir==='LONG';
  x.fillStyle=dirCol;x.fillRect(8,7,96,26);x.fillStyle='#0c1117';x.font='bold 14px system-ui';x.fillText(isLg?'▲ LONG':'▼ SHORT',18,25);
  if(V.strat){x.fillStyle='#e6ebf2';x.font='bold 12px system-ui';x.fillText(V.strat,114,25)}
  if(V.pnl){var pc=V.pnl.r>0.005?'#3ddc97':V.pnl.r<-0.005?'#ff6b7a':'#8593a5',txt=(V.pnl.fin?'KAPANDI ':(V.pnl.lbl||'CANLI')+' ')+sg(V.pnl.r)+'R   '+sg(V.pnl.pct)+'%';
   x.font='bold 13px system-ui';var w=x.measureText(txt).width+22;x.fillStyle=pc;x.fillRect(W-R-w+L,7,w,26);x.fillStyle='#0c1117';x.fillText(txt,W-R-w+L+11,25)}}
}
function loadChart(sym,tf){fetch(api('/api/candles?symbol='+encodeURIComponent(sym)+'&tf='+tf)).then(function(r){return r.json()}).then(function(d){if(d.error)return;chartCache[sym+'|'+tf]=d;if(sel&&sel.sym===sym){renderMain()}}).catch(function(){})}
function setTf(v){tfSel=v;chartFor='';$('main').removeAttribute('data-view');renderMain()}
function selData(){
 if(!sel||!sel.sym)return null;
 if(sel.kind==='cas')return((S.cas&&S.cas.ev)||[]).find(function(x){return x.id===sel.id})||null;
 if(sel.kind==='hot')return((S.cas&&S.cas.hot)||[]).find(function(x){return x.symbol===sel.sym})||null;
 if(sel.kind==='brk')return(S.breakouts||[]).find(function(x){return x.id===sel.id})||null;
 return(S.radar||[]).find(function(x){return x.symbol===sel.sym})||null}

var CW={VOL:function(o){return 'Son 1 dk mumunun hacmi önceki 30 mumun medyanının çok üstündeydi ve fiyat hareketi ATR\'yi aştı (hacim ~'+f2(o.volX,1)+'x).'},
 WICK:function(o){return 'Büyük menzilli, uzun fitilli, yüksek hacimli bir 1 dk mumu oluştu; stop avı / likidasyon fitili olabilir. Eğilim fitilin tersi.'},
 SQZ:function(o){return 'Fiyat 25 mumdur dar bir aralıkta sıkışmıştı ve hacimli bir mum bu aralığı kırdı.'},
 ALIGN:function(o){return '5, 15 ve 60 dk\'lık hareketler aynı yönde ve gürültünün üstünde, son mumlarda hacim arttı.'},
 OI:function(o){return 'Açık pozisyon (OI) 10 dk içinde '+sg(o.oiChg,1)+'% arttı ve fiyat hareket etti: yeni pozisyonlar açılıyor.'},
 FUND:function(o){return 'Funding aşırı ('+(o.fr==null?'-':f2(o.fr*100,3)+'%')+') ve son saatte keskin değişti: kalabalık taraf var, sıkışma (squeeze) riski. Eğilim kalabalığın tersi.'}};
function whyText(o,kind){
 if(!o)return'Bu sinyal artık listede değil.';
 if(kind==='hot')return '<b>Dikkat listesi:</b> bu coin tarayıcının ilk aşama bayraklarından en az birini geçti (hacim vekili / hızlı hareket / OI / funding). Henüz sinyal değil; 1 dk mum doğrulaması bekleniyor. Grafiğe bakıp kendin karar ver.';
 if(kind==='cas')return '<b>CASUS gözlemi:</b> '+(o.types||[o.type]).map(function(t){return '<b>'+(CN[t]||t)+'</b>: '+(CW[t]?CW[t](o):'')}).join(' ')+' Güç '+o.strength+(o.conflict?' (tipler zıt yönde, düşürüldü)':'')+'. Fiyat 3dk '+sg(o.ret3)+'% • 15dk '+sg(o.ret15)+'%. <b>Bu bir al/sat sinyali değil, gözlem uyarısıdır.</b> Gösterilen giriş/stop/TP yalnızca sanal izleme içindir ('+o.dir+' yönü sanal eğilimdir) ve istatistik bu eğilimin işe yarayıp yaramadığını ölçer.';
 if(kind==='brk')return '<b>Strateji: ÜÇGEN KIRILIM (onaylı)</b> — '+esc(o.type)+' üçgenin '+(o.dir==='LONG'?'üst':'alt')+' çizgisi 15m kapanış + hacimle kırıldı ('+(o.touches||'?')+' dokunuş, hacim '+f2(o.volX,1)+'x, güç '+o.strength+'). BTC kapısı bu yöne açıktı. TP1 alınca yarısı kapanır ve stop girişe çekilir; sonra iz süren stop devreye girer.';
 if(o.broke)return '<b>Radar — ONAYSIZ KIRILIM:</b> '+esc(o.state)+'. Fiyat çizgiyi aştı ama 15m kapanış/hacim/BTC kapısı onayı yok. Gösterilen R ve %, çizgi seviyesi sanal giriş sayılarak hesaplanır; gerçek işlem değildir.';
 return '<b>Radar:</b> '+esc(o.state)+' — henüz kırılmadı.'}

function renderMain(){var M=$('main');
 if(tab==='stat'){M.removeAttribute('data-view');M.innerHTML=statView();return}
 if(tab==='set'){M.removeAttribute('data-view');M.innerHTML=setView();return}
 if(tab==='bt'){M.removeAttribute('data-view');if(!$('btOut'))M.innerHTML=btShell();$('btOut').innerHTML=btOut();return}
 if(sel&&sel.sym){
  var kind=sel.kind,o=selData(),tf=tfSel||defTf(kind);
  var P=(o&&(kind==='cas'||kind==='brk'||(kind==='rad'&&o.broke&&o.entry!=null)))?posInfo(o):null;
  var dir=o?(o.dir||o.bias):null;
  var vk=kind+'|'+sel.sym+'|'+(sel.id||'')+'|'+tf;
  if(M.getAttribute('data-view')!==vk){
   M.setAttribute('data-view',vk);
   var tfs=['1m','5m','15m','1h','2h'].map(function(t){return '<button class="'+(t===tf?'a':'')+'" onclick="setTf(\''+t+'\')">'+t.toUpperCase()+'</button>'}).join('');
   M.innerHTML='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sel.sym.split('/')[0])+'</h2><span id="hdrTags" class="r1"></span><span class="tfb">'+tfs+'</span><a class="btn tv" style="margin-left:8px" href="https://www.tradingview.com/chart/?symbol=BITGET:'+sel.sym.split('/')[0]+'USDT.P&interval='+({'1m':'1','5m':'5','15m':'15','2h':'120','1h':'60'}[tf]||'60')+'" target="_blank">📈 TV</a></div>'+
    '<div id="pnlB"></div><canvas id="cv"></canvas><div id="lvB"></div><div id="why" class="why"></div>'+
    '<div id="calcWrap">'+calcBox(P?P.levels.entry:'',P?P.levels.stop:'')+'</div>';
   bindCalc();
  }
  $('hdrTags').innerHTML=(dir?dirBadge(dir):'')+stratTag(kind)+(kind==='cas'&&o?(o.types||[o.type]).map(function(t){return '<span class="tag w">'+(CN[t]||t)+'</span>'}).join('')+strTag(o.strength||0):'')+(kind==='brk'&&o?'<span class="tag w">'+esc(o.type||'')+'</span>'+strTag(o.strength||0):'')+(kind==='rad'&&o?strTag(o.strength||0)+(o.broke?'<span class="tag w">KIRILDI • ONAYSIZ</span>':''):'');
  if(P){var ru=(+cfgC.bal||0)*Math.min(2,+cfgC.risk||0)/100,usd=P.r*ru,virt=(kind==='rad'),
    stTxt=P.fin?('KAPANDI • '+(ST[o.status]||[o.status])[0]):(virt?'ÇİZGİDEN BERİ • ONAYSIZ':(o.status==='TP1'?'CANLI • TP1_ALINDI':'CANLI'));
   $('pnlB').innerHTML='<div class="pnl '+cl(P.r)+'"><div><span class="pl">'+stTxt+'</span><b class="'+cl(P.r)+'">'+sg(P.r)+'R</b></div><div><span class="pl">Fiyat farkı</span><b class="'+cl(P.pct)+'">'+sg(P.pct)+'%</b></div><div><span class="pl">≈ Kâr / Zarar'+(kind==='cas'?' (sanal)':'')+'</span><b class="'+cl(usd)+'">'+sg(usd)+' USDT</b></div><div><span class="pl">Sinyal / geçen süre</span><b style="font-size:16px">'+(o.time?clk(o.time)+' • '+ago(o.time):'-')+'</b></div><div><span class="pl">En iyi / en kötü</span><b style="font-size:16px">'+(o.mfe!=null?f2(o.mfe,1)+' / '+f2(o.mae||0,1)+'R':'-')+'</b></div></div>';
   var lvh='<div class="lv"><div><span>'+(P.fin?'Çıkış':'Anlık')+'</span><b>'+fp(P.fin&&o.exitPrice?o.exitPrice:P.px)+'</b></div><div><span>'+(virt?'Çizgi (sanal giriş)':'Giriş')+'</span><b>'+fp(o.entry)+'</b></div><div><span>Stop'+(o.status==='TP1'?' (BE/iz)':'')+'</span><b class="zarar">'+fp(o.stop)+'</b></div><div><span>TP1</span><b class="kar">'+fp(o.tp1)+'</b></div><div><span>TP2</span><b class="kar">'+fp(o.tp2)+'</b></div><div><span>Risk</span><b>'+f2(o.riskPct)+'%</b></div>'+(o.costR!=null?'<div><span>Maliyet</span><b>'+f2(o.costR)+'R</b></div>':'')+'</div>';
   $('lvB').innerHTML=lvh}
  else{$('pnlB').innerHTML='';$('lvB').innerHTML=(o&&kind==='rad')?'<div class="lv"><div><span>Fiyat</span><b>'+fp(o.price)+'</b></div><div><span>Hacim</span><b>'+f2(o.volX,1)+'x</b></div><div><span>Güç</span><b>'+(o.strength||0)+'</b></div></div>':(o&&kind==='hot')?'<div class="lv"><div><span>Fiyat</span><b>'+fp(o.price)+'</b></div><div><span>3dk</span><b class="'+cl(o.ret3)+'">'+sg(o.ret3)+'%</b></div><div><span>15dk</span><b class="'+cl(o.ret15)+'">'+sg(o.ret15)+'%</b></div><div><span>Hacim vekili</span><b>'+f2(o.vm3,1)+'x</b></div><div><span>OI 10dk</span><b>'+sg(o.oiChg10,1)+'%</b></div></div>':''}
  $('why').innerHTML=whyText(o,kind);
  var k=sel.sym+'|'+tf;
  if(chartCache[k]){drawChart(chartCache[k],{dir:dir,levels:P?P.levels:null,virtual:(kind==='rad'),px:(S.px&&S.px[sel.sym])||(o&&o.price)||null,strat:stratName(kind,o),pnl:P?{r:P.r,pct:P.pct,fin:P.fin,lbl:(kind==='rad'?'ÇİZGİDEN':'CANLI')}:null},'cv')}
  if(chartFor!==k){chartFor=k;loadChart(sel.sym,tf)}
  return}
 var R=S.regime,G=S.gate,C=S.cas||{},A=C.stats||{},Ad=A.today||{totalR:0,n:0},B2=S.brkStats||{},Bd=B2.today||{totalR:0,n:0},dg=C.dg,pr=C.probe;
 var rg=R?'<div class="note" style="color:var(--tx);font-size:12px"><b>Piyasa yönü:</b> '+R.dir+' (skor '+sg(R.score,0)+', rejim '+R.regime+')</div>':'<div class="note">Yön motoru ısınıyor.</div>';
 var gt=G?'<div class="note" style="color:var(--tx);font-size:12px"><b>BTC kapısı ('+(G.strict?'sert':'yumuşak')+', Üçgen için):</b> skor '+sg(G.score,2)+' (1s '+sg(G.t1,2)+' • 15m eğim '+sg(G.sl,2)+' • 45dk hareket '+sg(G.mv,2)+') → LONG '+(G.long?'AÇIK':'KAPALI')+', SHORT '+(G.short?'AÇIK':'KAPALI')+' (eşik ±'+G.th+')</div>':'<div class="note">Kapı verisi bekleniyor.</div>';
 var cd=dg?'<div class="note">Casus: '+dg.n+'/'+dg.coins+' coin geçmişi hazır • bayraklı '+dg.flagged+' • mum çekilen '+dg.s2+' • sinyal '+dg.sig+' • OI '+dg.oiN+' coinde, funding '+dg.frN+' coinde var'+(dg.err?' • hata '+dg.err:'')+'</div>':'<div class="note">Casus ilk taramayı bekliyor.</div>';
 var pm=pr?'<div class="note">Veri kaynağı: '+esc(pr.mode)+'</div>':'';
 M.innerHTML='<h2>Panel</h2><div class="tiles">'+
 '<div class="tile"><div class="k">Üçgen onaylı açık</div><div class="v">'+(S.breakouts||[]).filter(isOp).length+'</div></div>'+
 '<div class="tile"><div class="k">Üçgen bugün</div><div class="v '+cl(Bd.totalR)+'">'+sg(Bd.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Casus açık sinyal</div><div class="v">'+(C.ev||[]).filter(isOp).length+'</div></div>'+
 '<div class="tile"><div class="k">Casus bugün (sanal)</div><div class="v '+cl(Ad.totalR)+'">'+sg(Ad.totalR,1)+'R</div></div>'+
 '<div class="tile"><div class="k">Radar (aşan / toplam)</div><div class="v">'+(S.radar||[]).filter(function(x){return x.broke}).length+' / '+(S.radar||[]).length+'</div></div>'+
 '<div class="tile"><div class="k">Casus dikkat listesi</div><div class="v">'+((C.hot||[]).length)+'</div></div></div>'+
 '<div class="box"><h3 style="margin-top:0">Sistem</h3>'+rg+gt+cd+pm+
 '<div class="note" style="color:var(--tx);font-size:12px">△ ÜÇGEN KIRILIM (1s formasyon, onaylı + onaysız canlı K/Z) • 🕵️ CASUS (tarayıcı: "bak buraya", tahmin değil) • ◎ RADAR. Kartlarda R ve % fiyatla canlı güncellenir; sanal pozisyonlar 1 dk mumlarla izlenir.</div></div>'}
function renderAll(){renderTop();renderTabs();renderList();renderMain()}

var BT=null,btDays=30,btN=40,btOff=0;
function btStart(){fetch(api('/api/backtest/start?days='+btDays+'&n='+btN+'&offset='+btOff),{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d&&d.error)alert(d.error);pollBT()}).catch(function(){})}
function pollBT(){fetch(api('/api/backtest')).then(function(r){return r.json()}).then(function(d){BT=d;if(tab==='bt'&&$('btOut'))$('btOut').innerHTML=btOut()}).catch(function(){})}
function btShell(){var so=function(a,v){return a.map(function(x){return '<option value="'+x+'"'+(String(x)===String(v)?' selected':'')+'>'+x+'</option>'}).join('')};
 return '<h2>Backtest (sadece Üçgen kırılım)</h2><div class="box"><div class="note" style="color:var(--tx);font-size:12px;margin:0 0 8px">Casus için backtest yoktur (OI geçmişi sınırlı); Casus ileri dönük gözlemle ölçülür. Üçgen: giriş sonraki 15m mum açılışı, stop/hedef aynı mumdaysa STOP önce sayılır. <b>Kaydır</b> testi N gün geriye kaydırır: önce bir dönemde bak (örn. 60 gün, kaydır 30), sonra hiç dokunmadan en yeni döneme bak (kaydır 0). İkisinde de pozitifse güvenilir.</div><div class="frm"><label class="fl">Gün<br><select onchange="btDays=this.value">'+so([14,30,60,90],btDays)+'</select></label><label class="fl">Kaydır (gün)<br><select onchange="btOff=this.value">'+so([0,30,60,90],btOff)+'</select></label><label class="fl">Coin<br><select onchange="btN=this.value">'+so([20,40,60,100],btN)+'</select></label><button class="btn" onclick="btStart()">▶ Başlat</button></div></div><div id="btOut"></div>'}
function btOut(){var b=BT;if(!b)return '<div class="note">Yükleniyor…</div>';
 if(b.running){var pc=b.total?Math.round(b.i/b.total*100):0;return '<div class="box"><b>Çalışıyor:</b> '+b.i+' / '+b.total+' ('+esc(b.sym||'')+') %'+pc+'</div>'}
 if(b.err)return '<div class="box zarar">Hata: '+esc(b.err)+'</div>';
 var r=b.result;if(!r)return '<div class="note">Henüz çalıştırılmadı.</div>';
 if(!r.n)return '<div class="box">'+r.days+' gün / '+r.coins+' coinde hiç işlem çıkmadı.</div>';
 var col=r.level==='g'?'var(--lg)':r.level==='r'?'var(--st)':'var(--am)';
 var h='<div class="box" style="border-color:'+col+'"><b style="color:'+col+'">Değerlendirme</b><div class="note" style="color:var(--tx);font-size:12px">'+esc(r.verdict)+'</div></div>';
 h+='<div class="note">'+r.coins+' coin • '+r.days+' gün'+(r.offset?' (son '+r.offset+' gün hariç)':'')+' • '+r.n+' işlem • günde ≈'+f2(r.perDay,1)+' • en kötü gün '+sg(r.worstDay,1)+'R • veri kapsamı %'+f2((r.coverage||0)*100,0)+' • bitiş '+ago(b.finishedAt)+' önce</div>';
 Object.keys(r.tables).forEach(function(k){h+=tbl(r.tables[k],k)});return h}

function poll(){
 fetch(api('/api/state')).then(function(r){return r.json()}).then(function(d){
  if(d&&d.error){$('dot').className='dot';$('conn').textContent='Hata: '+d.error;return}
  S=d;$('dot').className='dot on';$('conn').textContent='Bağlı';
  try{checkBrk();checkCas();renderAll()}catch(e){console.error(e);$('conn').textContent='Bağlı (arayüz hatası)'}
 }).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
addEventListener('resize',function(){if(S)try{renderMain()}catch(e){}});
setInterval(poll,3000);
setInterval(function(){if(tab==='bt')pollBT()},2000);
setInterval(function(){
 if((tab==='tri'||tab==='cas')&&sel&&sel.sym){
  loadChart(sel.sym,tfSel||defTf(sel.kind));
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
        if (u.pathname === '/health') return json(res, 200, { ok: true, version: 'v33', gate: GATE ? { score: r2(GATE.score), long: GATE.long, short: GATE.short } : null,
            tf: TRI_TF, triangles: Object.keys(struct).length, radar: triRadar.length, radarBroke: triRadar.filter(r => r.broke).length,
            breakouts: brkEvents.length, openBreakouts: brkEvents.filter(isOpen).length, shadow: shadow.length,
            casus: { on: !!CAS.ON, coins: casUniverse.length, hist: casHist.size, events: casEvents.length, open: casEvents.filter(isOpen).length, last: casSt.last, ms: casSt.ms, dg: casSt.dg, mode: casSt.probe ? casSt.probe.mode : null },
            universe: universe.length, eligible: scan.eligible, total: scan.total, drop: scan.drop });
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(u)) return json(res, 401, { error: 'yetkisiz' });
            casEvents = []; brkEvents = []; shadow = []; lastSig = {}; dirty = true; saveState();
            return json(res, 200, { ok: true });
        }
        if (['/', '/index.html', '/api/state', '/api/candles', '/api/backtest', '/api/backtest/start', '/api/casus/probe'].includes(u.pathname) && !uiOk(u)) return json(res, 401, { error: 'yetkisiz' });
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/casus/probe') {
            if (!rateOk(ip + '|probe', 6)) return json(res, 429, { error: 'çok fazla istek' });
            return json(res, 200, await casProbe());
        }
        if (u.pathname === '/api/backtest') return json(res, 200, bt);
        if (u.pathname === '/api/backtest/start' && req.method === 'POST') {
            if (bt.running) return json(res, 409, { error: 'Backtest zaten çalışıyor' });
            if (!Object.keys(tickers).length) return json(res, 503, { error: 'Piyasa verisi henüz yüklenmedi' });
            if (!rateOk(ip + '|bt', 3)) return json(res, 429, { error: 'çok fazla istek' });
            const days = Math.min(90, Math.max(7, Number(u.searchParams.get('days')) || 30));
            const n = Math.min(100, Math.max(10, Number(u.searchParams.get('n')) || 40));
            const offset = Math.min(90, Math.max(0, Number(u.searchParams.get('offset')) || 0));
            runBacktestJob(days, n, offset);
            return json(res, 200, { ok: true, days, n, offset });
        }
        if (u.pathname === '/api/candles') {
            if (!rateOk(ip, 60)) return json(res, 429, { error: 'çok fazla istek' });
            return json(res, 200, await apiCandles(u.searchParams.get('symbol') || '', u.searchParams.get('tf') || ''));
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

// ======================= START =======================
let tickBusy = false;
async function priceLoop() { if (tickBusy) return; tickBusy = true; try { await refreshTickers(); } finally { tickBusy = false; } }
async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('evren (Üçgen):', universe.length, 'coin | Casus evreni:', casUniverse.length, 'coin | toplam', scan.total, '| elenen: hacim<' + (CFG.MIN_VOL_USDT / 1e6) + 'M$', scan.drop.lowVol, ', şüpheli/yeni', scan.drop.suspect, ', hariç', scan.drop.excluded);
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(priceLoop, 4000);
        setInterval(track, 15e3);
        setInterval(liveTick, 6000);
        setInterval(casusCycle, 10e3);
        setInterval(saveState, 15e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
        (async () => { await runScan(); })();
        setInterval(async () => {
            const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / SCAN_MS);
            if (slot > lastScanSlot && !scan.running) { lastScanSlot = slot; await runScan(); }
        }, 3000);
        casProbe().then(p => log('Casus veri kaynağı:', p.mode)).catch(() => { });
        log('SONER TRADE v33 • Üçgen Kırılım + Casus (tarayıcı) • Üçgen evreni ' + universe.length + ' • Casus evreni ' + casUniverse.length + ' • kapı ' + (CFG.GATE_STRICT ? 'sert' : 'yumuşak') + ' ±' + CFG.GATE_TH);
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { dirty = true; saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { runScan, track, refreshUniverse, apiState, liveTick, detectTriangle, pack, evalBreakout, planTrade, virtualPlan, CFG, CAS, CAS_NAMES,
    buildStruct, lineValues, calculateStrength, costFor, advance, mkPos, grp, groupBy, strBucket, atrMean, aggregateN, hasGap,
    runBacktestJob, btSymbolTri, btReportTri, getBt: () => bt,
    mkCtx, gateAt, casDetect, casStage1, casSnap, casEval, casCreate, casusCycle, casStatsCalc, casProbe, buildCasUniverse,
    setCasUniverse: a => { casUniverse = a; }, casHist, getCas: () => casEvents, getBrk: () => brkEvents, getShadow: () => shadow, HTML };
