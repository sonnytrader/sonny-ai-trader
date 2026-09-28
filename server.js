'use strict';
// ============================================================
// SONER TRADE v7 — SCALP RADAR
// Manuel scalp için: 5m giriş + 15m trend, "GÜÇLÜ LONG / GÜÇLÜ SHORT" puanlı sinyaller,
// canlı takip (R hesabı), günlük pano, radar, istatistik ve geçmiş veri testi.
// Bağımlılık: sadece ccxt (Node 18+)
// Ortam değişkenleri (hepsi opsiyonel):
//   PORT, DATA_DIR (kalıcı disk), ADMIN_TOKEN (backtest/sıfırlama şifresi)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MIN_SCORE (varsayılan 72), UNIVERSE (varsayılan 40)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const M5 = 5 * 60e3, H1 = 3600e3;

const CFG = {
    MIN_SCORE: Number(process.env.MIN_SCORE || 72),
    UNIVERSE: Number(process.env.UNIVERSE || 40),
    MIN_VOL_USDT: 15e6,
    CANDLES: 500,
    EXCLUDED: ['USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD', 'WBTC', 'WETH', 'STETH', 'WSTETH'],
    // trend
    TREND_MIN_SPREAD: 0.12,      // 15m EMA21-EMA50 farkı, fiyatın yüzdesi
    TREND_STRONG_SPREAD: 0.25,
    // setup A: trend içi geri çekilme
    PB_LOOKBACK: 10, PB_TOUCH_ATR: 0.1, PB_MAX_DEPTH_ATR: 0.3, A_BODY_MIN_ATR: 0.35, A_BODY_MAX_ATR: 1.8, A_MAX_EXT_ATR: 1.3, A_MIN_VOLX: 1.0,
    // setup B: likidite süpürme
    SW_LOOKBACK: 48, SW_GAP: 4, SW_MIN_WICK: 0.45, SW_MIN_VOLX: 1.4, SW_PIERCE_ATR: 0.05,
    // risk / hedef
    STOP_BUF_A: 0.25, STOP_BUF_B: 0.15, MIN_RISK_PCT: 0.25, MAX_RISK_PCT: 1.5, MAX_RISK_ATR: 2.2,
    TP1_R: 1, TP2_R: 2, ROOM_R: 1.3,
    COST_PCT: 0.12,              // gidiş-dönüş komisyon + kayma tahmini (%)
    MAX_COST_R: 0.35,
    MAX_HOLD_CANDLES: 36,        // 36 x 5m = 3 saat
    // operasyon
    COOLDOWN_MS: 30 * 60e3, MAX_OPEN_PER_DIR: 3, MAX_PER_SCAN: 3, MAX_SIGNAL_AGE_MS: 150e3,
    SCAN_DELAY_MS: 6000, CONCURRENCY: 4, TRACK_MS: 20e3, UNIVERSE_MS: 10 * 60e3, FUNDING_MS: 5 * 60e3, KEEP: 1000
};

// ---------------- yardımcılar ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
function trMinutes(t) { const d = new Date(t + 3 * H1); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function inWindow(t) { const m = trMinutes(t); return (m >= 600 && m < 720) || (m >= 990 && m < 1140); }
function trDay(t) { return new Date(t + 3 * H1).toISOString().slice(0, 10); }
function trHour(t) { return String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00'; }

function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
}
function atrSeries(c, p = 14) {
    const out = new Array(c.length).fill(null); if (c.length <= p) return out;
    const tr = [null]; for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4])));
    let a = 0; for (let i = 1; i <= p; i++) a += tr[i]; a /= p; out[p] = a;
    for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
    return out;
}
function rsiLast(closes, p = 14) {
    if (closes.length <= p) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function vwapSeries(c, win = 96) {
    const out = new Array(c.length).fill(null); let pv = 0, vv = 0;
    for (let i = 0; i < c.length; i++) {
        const tp = (c[i][2] + c[i][3] + c[i][4]) / 3; pv += tp * c[i][5]; vv += c[i][5];
        if (i >= win) { const o = c[i - win], tpo = (o[2] + o[3] + o[4]) / 3; pv -= tpo * o[5]; vv -= o[5]; }
        out[i] = vv > 0 ? pv / vv : c[i][4];
    }
    return out;
}
function aggregate(c, n, ms) {   // 5m -> 15m/1h, sadece tamamlanmış gruplar
    const g = new Map();
    for (const x of c) {
        const k = Math.floor(x[0] / (ms * n)) * ms * n;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}
function trendOf(c5) {           // 15m trend: 1 yukarı, -1 aşağı, 0 yatay
    const c15 = aggregate(c5, 3, M5); if (c15.length < 60) return { dir: 0, spread: 0 };
    const cl = c15.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), n = cl.length - 1;
    const spread = (e21[n] - e50[n]) / cl[n] * 100, slope = e21[n] - e21[n - 3];
    if (spread >= CFG.TREND_MIN_SPREAD && cl[n] > e50[n] && slope > 0) return { dir: 1, spread };
    if (spread <= -CFG.TREND_MIN_SPREAD && cl[n] < e50[n] && slope < 0) return { dir: -1, spread };
    return { dir: 0, spread };
}
function nearestLevel(c, i, dir, entry) {   // önümüzdeki en yakın swing tepe (long) / dip (short)
    let best = null;
    for (let j = Math.max(3, i - 150); j <= i - 4; j++) {
        let ok = true;
        for (let k = 1; k <= 3; k++) { if (dir === 1 ? (c[j][2] < c[j - k][2] || c[j][2] < c[j + k][2]) : (c[j][3] > c[j - k][3] || c[j][3] > c[j + k][3])) { ok = false; break; } }
        if (!ok) continue;
        const p = dir === 1 ? c[j][2] : c[j][3];
        if (dir === 1 ? p > entry : p < entry) { if (best == null || (dir === 1 ? p < best : p > best)) best = p; }
    }
    return best;
}

// ---------------- sinyal motoru ----------------
// c5: kapanmış 5m mumlar [t,o,h,l,c,v]. ctx: { btcDir, funding, sym }
// Döner: { signal|null, radar, reason }
function evaluate(c5, ctx) {
    const n = c5.length - 1;
    if (n < 320) return { signal: null, radar: null, reason: 'veri az' };
    const cl = c5.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), at = atrSeries(c5, 14), vw = vwapSeries(c5, 96);
    const a = at[n], k = c5[n], prev = c5[n - 1];
    if (!a || !e50[n] || !k[5]) return { signal: null, radar: null, reason: 'veri az' };
    let vs = 0; for (let i = n - 20; i < n; i++) vs += c5[i][5]; const volX = vs > 0 ? k[5] / (vs / 20) : 0;
    const rsi = rsiLast(cl.slice(-100), 14), tr = trendOf(c5);
    const h1 = aggregate(c5, 12, M5).map(x => x[4]), e1h = emaSeries(h1, 21), h1e = e1h[e1h.length - 1];
    const range = Math.max(1e-12, k[2] - k[3]), body = Math.abs(k[4] - k[1]);
    const radar = { symbol: ctx.sym, base: baseOf(ctx.sym), price: k[4], trend: tr.dir, volX, rsi, funding: ctx.funding, bias: '-', state: 'Trend yatay', score: 0 };
    // radar durumu
    const distEma = Math.abs(k[4] - e21[n]) / a;
    if (tr.dir !== 0) {
        radar.bias = tr.dir === 1 ? 'LONG' : 'SHORT';
        radar.state = distEma <= 0.6 ? 'EMA21 bölgesinde, tetik bekle' : (tr.dir === 1 ? k[4] > e21[n] : k[4] < e21[n]) ? 'Trend yönünde uzak, geri çekilme bekle' : 'Geri çekilmiş, dönüş bekle';
        radar.score = Math.round(Math.min(40, Math.abs(tr.spread) * 80) + Math.min(30, volX * 10) + (distEma <= 0.6 ? 30 : distEma <= 1.2 ? 15 : 0));
    } else radar.score = Math.round(Math.min(30, volX * 10));

    const cands = [];
    // ---- Setup A: 15m trend yönünde geri çekilme sonrası dönüş ----
    for (const dir of [1, -1]) {
        if (tr.dir !== dir) continue;
        if (dir === 1 ? !(e21[n] > e50[n] && k[4] > e21[n]) : !(e21[n] < e50[n] && k[4] < e21[n])) continue;
        let pb = null;
        for (let j = n - CFG.PB_LOOKBACK; j < n; j++) {
            const touch = dir === 1 ? c5[j][3] <= e21[j] + CFG.PB_TOUCH_ATR * a : c5[j][2] >= e21[j] - CFG.PB_TOUCH_ATR * a;
            if (touch) { const ext = dir === 1 ? c5[j][3] : c5[j][2]; if (pb == null || (dir === 1 ? ext < pb : ext > pb)) pb = ext; }
        }
        if (pb == null) continue;
        let ok50 = true;
        for (let j = n - CFG.PB_LOOKBACK; j < n; j++) if (dir === 1 ? c5[j][3] < e50[j] - CFG.PB_MAX_DEPTH_ATR * a : c5[j][2] > e50[j] + CFG.PB_MAX_DEPTH_ATR * a) ok50 = false;
        if (!ok50) continue;
        const bull = dir === 1 ? k[4] > k[1] && k[4] > prev[2] : k[4] < k[1] && k[4] < prev[3];
        const wick = dir === 1 ? (k[2] - k[4]) / range : (k[4] - k[3]) / range;
        if (!bull || body < CFG.A_BODY_MIN_ATR * a || body > CFG.A_BODY_MAX_ATR * a || wick > 0.5) continue;
        if (Math.abs(k[4] - e21[n]) > CFG.A_MAX_EXT_ATR * a) continue;
        if (volX < CFG.A_MIN_VOLX) continue;
        let pv = 0, pc = 0; for (let j = n - 5; j < n; j++) { pv += c5[j][5]; pc++; }
        const stop = dir === 1 ? pb - CFG.STOP_BUF_A * a : pb + CFG.STOP_BUF_A * a;
        const closePos = dir === 1 ? (k[4] - k[3]) / range : (k[2] - k[4]) / range;
        cands.push({ dir, setup: 'A', name: 'Trend içi geri çekilme', stop, q: 14 + (closePos >= 0.75 ? 3 : 0) + (pv / pc < k[5] ? 3 : 0) });
    }
    // ---- Setup B: likidite süpürme ve geri kazanma ----
    for (const dir of [1, -1]) {
        if (tr.dir === -dir) continue;
        const s0 = n - CFG.SW_LOOKBACK, s1 = n - CFG.SW_GAP; let lvl = dir === 1 ? Infinity : -Infinity;
        for (let j = s0; j <= s1; j++) lvl = dir === 1 ? Math.min(lvl, c5[j][3]) : Math.max(lvl, c5[j][2]);
        const swept = dir === 1 ? k[3] < lvl - CFG.SW_PIERCE_ATR * a && k[4] > lvl : k[2] > lvl + CFG.SW_PIERCE_ATR * a && k[4] < lvl;
        if (!swept) continue;
        const wick = dir === 1 ? (Math.min(k[1], k[4]) - k[3]) / range : (k[2] - Math.max(k[1], k[4])) / range;
        const closePos = dir === 1 ? (k[4] - k[3]) / range : (k[2] - k[4]) / range;
        if (wick < CFG.SW_MIN_WICK || closePos < 0.55 || volX < CFG.SW_MIN_VOLX) continue;
        const stop = dir === 1 ? k[3] - CFG.STOP_BUF_B * a : k[2] + CFG.STOP_BUF_B * a;
        cands.push({ dir, setup: 'B', name: 'Likidite süpürme', stop, q: 14 + (wick >= 0.6 ? 3 : 0) + (Math.abs(k[4] - lvl) > 0.3 * a ? 3 : 0) });
    }
    if (!cands.length) return { signal: null, radar, reason: 'kurulum yok' };

    let best = null, why = 'skor';
    for (const cd of cands) {
        const dir = cd.dir, entry = k[4]; let stop = cd.stop;
        const minD = entry * CFG.MIN_RISK_PCT / 100;
        if (Math.abs(entry - stop) < minD) stop = dir === 1 ? entry - minD : entry + minD;
        const risk = Math.abs(entry - stop), riskPct = risk / entry * 100;
        if (riskPct > CFG.MAX_RISK_PCT || risk > CFG.MAX_RISK_ATR * a) { why = 'stop geniş'; continue; }
        const costR = CFG.COST_PCT / riskPct;
        if (costR > CFG.MAX_COST_R) { why = 'maliyet'; continue; }
        const lvl = nearestLevel(c5, n, dir, entry);
        if (lvl != null && Math.abs(lvl - entry) < CFG.ROOM_R * risk) { why = 'önü kapalı'; continue; }
        if (ctx.btcShock === dir * -1) { why = 'BTC şoku'; continue; }
        const P = {}, warn = [];
        P.trend = tr.dir === dir ? (Math.abs(tr.spread) >= CFG.TREND_STRONG_SPREAD ? 22 : 14) : 0;
        P.htf = h1e != null && (dir === 1 ? k[4] > h1e : k[4] < h1e) ? 8 : 0;
        P.vol = volX >= 2.5 ? 20 : volX >= 1.8 ? 16 : volX >= 1.3 ? 11 : volX >= 1.0 ? 6 : 0;
        P.setup = cd.q;
        P.vwap = (dir === 1 ? k[4] > vw[n] : k[4] < vw[n]) ? 8 : 0;
        P.rsi = rsi != null && (dir === 1 ? rsi >= 42 && rsi <= 68 : rsi <= 58 && rsi >= 32) ? 6 : 0;
        P.btc = ctx.sym.startsWith('BTC/') ? 10 : ctx.btcDir === dir ? 10 : ctx.btcDir === 0 ? 4 : 0;
        P.fund = 0;
        if (ctx.funding != null) {
            const f = ctx.funding * 100;
            if (dir === 1 && f > 0.05) { P.fund = -8; warn.push('Long kalabalık (funding +' + f.toFixed(3) + '%)'); }
            else if (dir === -1 && f < -0.05) { P.fund = -8; warn.push('Short kalabalık (funding ' + f.toFixed(3) + '%)'); }
            else if ((dir === 1 && f < -0.02) || (dir === -1 && f > 0.02)) P.fund = 4;
        }
        const win = inWindow(k[0] + M5);
        P.win = win ? 6 : -8; if (!win) warn.push('İşlem penceresi dışı');
        P.cost = costR <= 0.2 ? 6 : 3;
        if (tr.dir !== dir) warn.push('15m trende karşı, dikkatli ol');
        if (ctx.btcDir === -dir && !ctx.sym.startsWith('BTC/')) warn.push('BTC yönü ters');
        const score = Math.max(0, Math.min(100, Object.values(P).reduce((x, y) => x + y, 0)));
        const sig = { symbol: ctx.sym, base: baseOf(ctx.sym), dir: dir === 1 ? 'LONG' : 'SHORT', setup: cd.setup, setupName: cd.name, score, parts: P, warnings: warn,
            entry, stop, initialStop: stop, tp1: entry + dir * CFG.TP1_R * risk, tp2: entry + dir * CFG.TP2_R * risk, riskPct, costR, volX, rsi, funding: ctx.funding, trend: tr.dir,
            time: k[0] + M5, candleT: k[0], atr: a };
        if (!best || score > best.score) best = sig;
    }
    if (!best) return { signal: null, radar, reason: why };
    if (best.score < CFG.MIN_SCORE) return { signal: null, radar: Object.assign(radar, { state: 'Kurulum var, puan ' + best.score + ' (yetersiz)', score: Math.max(radar.score, best.score) }), reason: 'skor' };
    return { signal: best, radar: Object.assign(radar, { state: 'GÜÇLÜ ' + best.dir + ' sinyali', score: 100 }), reason: 'sinyal' };
}

// ---------------- sonuç takibi (canlı ve backtest ortak) ----------------
function rOf(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t) { s.status = status; s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }
function advance(s, k, maxCandles) {  // k: mum [t,o,h,l,c,v]; sonuç değiştiyse true
    const L = s.dir === 'LONG', risk = Math.abs(s.entry - s.initialStop);
    s.candles = (s.candles || 0) + 1;
    const hiR = L ? (k[2] - s.entry) / risk : (s.entry - k[3]) / risk, loR = L ? (k[3] - s.entry) / risk : (s.entry - k[2]) / risk;
    s.mfe = Math.max(s.mfe || 0, hiR); s.mae = Math.min(s.mae || 0, loR);
    s.lastPrice = k[4];
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, k[0] + 60e3); return true; }   // aynı mumda ikisi de olduysa stop sayılır
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) { s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, 'BE', 0.5 * CFG.TP1_R, k[0] + 60e3); return true; }
        if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * CFG.TP1_R + 0.5 * CFG.TP2_R, k[0] + 60e3); return true; }
    }
    if (maxCandles && s.candles >= maxCandles && (s.status === 'ACTIVE' || s.status === 'TP1_HIT')) {
        const r = rOf(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * CFG.TP1_R + 0.5 * r : r, k[0] + 60e3); return true;
    }
    return false;
}
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';

// ---------------- istatistik ----------------
function grp(list) {
    const n = list.length; if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0;
    for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
    return { n, win: w / n, avgR: tot / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 90 ? '90-100' : s.score >= 80 ? '80-89' : '80 altı';
function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return { all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)), bySetup: groupBy(sorted, s => s.setup + ' ' + s.setupName), byDir: groupBy(sorted, s => s.dir), byBand: groupBy(sorted, band), byHour: groupBy(sorted, s => trHour(s.time)) };
}

// ---------------- durum ve borsa ----------------
const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, fundingMap = {}, radar = [], market = { btc: null, eth: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, reasonDay: '' }, dirty = false, lastScanSlot = 0, btcCtx = { dir: 0, shock: 0 };
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map();

function loadState() {
    try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); signals = j.signals || []; lastSig = j.lastSig || {}; log('durum yüklendi:', signals.length, 'sinyal'); } catch (e) { log('temiz başlangıç'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig })); fs.renameSync(tmp, STATE_FILE); } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { log('telegram hata', e.message); }
}
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };

async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers();
        const list = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear && !CFG.EXCLUDED.includes(baseOf(t.symbol)) && (t.quoteVolume || 0) >= CFG.MIN_VOL_USDT)
            .sort((a, b) => b.quoteVolume - a.quoteVolume).map(t => t.symbol);
        const top = list.slice(0, CFG.UNIVERSE);
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (!top.includes(s)) top.push(s);
        universe = top;
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) { const t = tickers[s]; if (t) market[s.startsWith('BTC') ? 'btc' : 'eth'] = Object.assign(market[s.startsWith('BTC') ? 'btc' : 'eth'] || { dir: 0 }, { price: t.last, chg: t.percentage }); }
    } catch (e) { log('evren hatası', e.message); }
}
async function refreshFunding() {
    try { const f = await ex.fetchFundingRates(universe); for (const s of universe) if (f[s] && f[s].fundingRate != null) fundingMap[s] = Number(f[s].fundingRate); } catch (e) { /* bazı sürümlerde desteklenmeyebilir */ }
}
async function fetchC5(sym) { return closedOnly(await ex.fetchOHLCV(sym, '5m', undefined, CFG.CANDLES), M5); }

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.reasonDay = day; }
    const found = [], rad = [];
    try {
        // BTC bağlamı
        try {
            const b = await fetchC5('BTC/USDT:USDT'), tr = trendOf(b), m = b.length - 1;
            const mv = (b[m][4] - b[m - 3][1]) / b[m - 3][1] * 100;
            btcCtx = { dir: tr.dir, shock: mv <= -1 ? -1 : mv >= 1 ? 1 : 0 };
            market.btc = Object.assign(market.btc || {}, { dir: tr.dir });
            try { const e = await fetchC5('ETH/USDT:USDT'); market.eth = Object.assign(market.eth || {}, { dir: trendOf(e).dir }); } catch (e) {}
        } catch (e) { log('BTC hatası', e.message); }
        let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const c = await fetchC5(sym);
                    const t = tickers[sym] || {};
                    const r = evaluate(c, { sym, btcDir: btcCtx.dir, btcShock: btcCtx.shock, funding: fundingMap[sym] != null ? fundingMap[sym] : null });
                    if (r.radar) { r.radar.chg24 = t.percentage != null ? t.percentage : 0; rad.push(r.radar); }
                    if (r.signal) {
                        const age = Date.now() - r.signal.time;
                        if (age > CFG.MAX_SIGNAL_AGE_MS) scan.reasons['eski'] = (scan.reasons['eski'] || 0) + 1; else found.push(r.signal);
                    } else scan.reasons[r.reason] = (scan.reasons[r.reason] || 0) + 1;
                } catch (e) { scan.reasons['hata'] = (scan.reasons['hata'] || 0) + 1; }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        radar = rad.sort((a, b) => b.score - a.score).slice(0, 30);
        found.sort((a, b) => b.score - a.score);
        let added = 0;
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) { scan.reasons['zaten açık'] = (scan.reasons['zaten açık'] || 0) + 1; continue; }
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) { scan.reasons['bekleme'] = (scan.reasons['bekleme'] || 0) + 1; continue; }
            if (signals.filter(x => isOpen(x) && x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR) { scan.reasons['yön limiti'] = (scan.reasons['yön limiti'] || 0) + 1; continue; }
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.candleT; s.status = 'ACTIVE'; s.lastPrice = s.entry; s.mfe = 0; s.mae = 0; s.candles = 0; s.trackedTo = s.candleT + M5 - 60e3;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            log('SİNYAL', s.dir, s.symbol, 'puan', s.score, 'giriş', fmt(s.entry), 'stop', fmt(s.stop));
            telegram('GÜÇLÜ ' + s.dir + ' ' + s.base + ' (puan ' + s.score + ')\n' + s.setupName + '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + '\nTP1 ' + fmt(s.tp1) + '\nTP2 ' + fmt(s.tp2) + '\nStop mesafesi %' + s.riskPct.toFixed(2) + (s.warnings.length ? '\n⚠ ' + s.warnings.join(', ') : ''));
        }
        if (signals.length > CFG.KEEP) signals = signals.slice(0, CFG.KEEP);
        scan.last = Date.now(); scan.ms = scan.last - t0;
    } catch (e) { log('tarama hatası', e.message); }
    scan.running = false;
}

async function track() {
    const open = signals.filter(isOpen); if (!open.length) return;
    try {
        for (const s of open) {
            const c = closedOnly(await ex.fetchOHLCV(s.symbol, '1m', s.trackedTo, 200), 60e3);
            for (const k of c) {
                if (k[0] <= s.trackedTo) continue;
                s.trackedTo = k[0];
                if (advance(s, k, CFG.MAX_HOLD_CANDLES * 5)) { dirty = true; if (!isOpen(s)) { log('KAPANDI', s.symbol, s.status, s.netR); telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; } }
                dirty = true;
            }
            const t = tickers[s.symbol]; if (t && t.last && isOpen(s)) s.lastPrice = t.last;
        }
    } catch (e) { log('takip hatası', e.message); }
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t;
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (t[s]) { const key = s.startsWith('BTC') ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) {}
}

// ---------------- API durumu ----------------
function apiState() {
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = calcStats(closed, trDay(now));
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    return { now, mode: 'SCALP 5m', minScore: CFG.MIN_SCORE, market, signals: signals.slice(0, 80), radar, stats: st, equity: eq,
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length } };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const hit = candleCache.get(sym); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const raw = await ex.fetchOHLCV(sym, '5m', undefined, CFG.CANDLES), c = raw;   // son (açık) mum da grafikte görünür
    const cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), vw = vwapSeries(c, 96), N = 110, cut = Math.max(0, c.length - N);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), vwap: vw.slice(cut) };
    candleCache.set(sym, { t: Date.now(), d }); return d;
}

// ---------------- backtest ----------------
async function fetchHistory(sym, days) {
    let since = Date.now() - (days + 2) * 86400e3, all = [], guard = 0;
    while (since < Date.now() - M5 && guard++ < 60) {
        const r = await ex.fetchOHLCV(sym, '5m', since, 1000);
        if (!r || !r.length) break;
        all = all.concat(r); const last = r[r.length - 1][0];
        if (last <= since) break; since = last + M5;
    }
    const seen = new Set(); return closedOnly(all, M5).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
}
async function runBacktest(days, coins) {
    if (btJob.running) return;
    btJob = { running: true, msg: 'Coin listesi hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => s !== 'BTC/USDT:USDT').slice(0, coins), all = ['BTC/USDT:USDT'].concat(syms);
        btJob.total = all.length + syms.length;
        const data = {}; let candles = 0;
        for (const s of all) { btJob.msg = 'Veri indiriliyor: ' + baseOf(s); data[s] = await fetchHistory(s, days); candles += data[s].length; btJob.done++; }
        const btc = data['BTC/USDT:USDT'], btcMap = new Map();
        btJob.msg = 'BTC yönü hesaplanıyor';
        for (let i = 330; i < btc.length; i++) { const w = btc.slice(i - 329, i + 1), tr = trendOf(w), mv = (w[329][4] - w[326][1]) / w[326][1] * 100; btcMap.set(btc[i][0], { dir: tr.dir, shock: mv <= -1 ? -1 : mv >= 1 ? 1 : 0 }); if (i % 300 === 0) await sleep(0); }
        const startT = Date.now() - days * 86400e3, trades = [];
        for (const sym of syms) {
            btJob.msg = 'Test ediliyor: ' + baseOf(sym); const c = data[sym]; let busyUntil = 0;
            for (let i = 330; i < c.length - 2; i++) {
                if (c[i][0] < startT || c[i][0] < busyUntil) continue;
                const b = btcMap.get(c[i][0]) || { dir: 0, shock: 0 };
                const r = evaluate(c.slice(i - 329, i + 1), { sym, btcDir: b.dir, btcShock: b.shock, funding: null });
                if (i % 150 === 0) await sleep(0);
                if (!r.signal) continue;
                const s = r.signal; s.status = 'ACTIVE'; s.mfe = 0; s.mae = 0; s.candles = 0; s.lastPrice = s.entry;
                for (let j = i + 1; j < c.length; j++) { if (advance(s, c[j], CFG.MAX_HOLD_CANDLES)) { if (!isOpen(s)) { s.closedAt = c[j][0] + M5; break; } } }
                if (isOpen(s)) continue;
                trades.push({ symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, score: s.score, time: s.time, closedAt: s.closedAt, netR: s.netR });
                busyUntil = Math.max(s.closedAt, s.time + CFG.COOLDOWN_MS);
            }
            btJob.done++;
        }
        trades.sort((a, b) => a.time - b.time);
        const cut = Math.floor(trades.length * 0.7);
        btJob.result = { days, coins, candles, all: grp(trades), train: grp(trades.slice(0, cut)), test: grp(trades.slice(cut)), bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName), byDir: groupBy(trades, s => s.dir), byBand: groupBy(trades, band), byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; }
    btJob.running = false;
}

// ---------------- HTTP sunucusu ----------------
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--bl);outline-offset:2px}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px;letter-spacing:.3px}
.brand small{font-weight:600;color:var(--am);margin-left:8px;font-size:11px}
.chip{display:flex;gap:6px;align-items:center;background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}
.chip b{color:var(--dm);font-weight:600}
.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}
.grow{flex:1}
.gate{display:flex;align-items:center;gap:12px;padding:6px 14px;border-radius:8px;border:1px solid var(--ln);min-width:330px}
.gate .g1{font-size:16px;font-weight:800;line-height:1.1}
.gate .g2{font-size:11px;color:var(--dm)}
.gate.ok{border-color:rgba(61,220,151,.5);background:rgba(61,220,151,.09)}.gate.ok .g1{color:var(--lg)}
.gate.wait{border-color:rgba(242,184,75,.5);background:rgba(242,184,75,.08)}.gate.wait .g1{color:var(--am)}
.gate.stop{border-color:rgba(255,107,122,.6);background:rgba(255,107,122,.1)}.gate.stop .g1{color:var(--st)}
.clock{font-size:20px;font-weight:700}
.ibtn{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:5px 9px;color:var(--dm)}
.ibtn.on{color:var(--am);border-color:var(--am)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:410px;flex-shrink:0;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}
.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}
.tab i{font-style:normal;background:var(--p2);border-radius:9px;padding:0 6px;margin-left:4px;font-size:10px}
.list{flex:1;overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
.card:hover{border-color:#34455a}
.card.sel{border-color:var(--am)}
.card.closed{opacity:.62}
.r1{display:flex;align-items:center;gap:8px}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}
.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
h2{font-size:15px;margin-bottom:10px}
h3{font-size:12px;color:var(--dm);font-weight:700;margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:22px;font-weight:800;margin-top:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}
th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}
td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:340px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--am)}
.pr{display:grid;grid-template-columns:110px 1fr 34px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px;min-width:0}
.frm input{width:110px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.g{background:var(--p1);color:var(--tx);border:1px solid var(--ln);font-weight:600}
.chk label{display:flex;gap:8px;padding:5px 0;cursor:pointer}
.mut{color:var(--dm)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:48vh}.grid2{grid-template-columns:1fr}.gate{min-width:0;width:100%}canvas{height:260px}}
</style>
</head>
<body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">SCALP</small></div>
  <div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div>
  <div class="grow"></div>
  <div class="gate" id="gate"><div><div class="clock" id="clock">--:--:--</div><div class="g2">Türkiye saati</div></div><div><div class="g1" id="g1">...</div><div class="g2" id="g2"></div></div></div>
  <button class="ibtn" id="bSound" title="Ses ve bildirim">Bildirim kapalı</button>
  <span class="mut"><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body">
  <div class="side">
   <div class="tabs" id="tabs"></div>
   <div class="list" id="list"></div>
  </div>
  <div class="main" id="main"></div>
 </div>
</div>
<script>
var LIM={loss:-3,win:3,trades:8,cons:3,pause:30};
var TABS=[['sig','Sinyaller'],['radar','Radar'],['stat','İstatistik'],['jr','Günlük'],['bt','Test']];
var S=null,tab='sig',sel=null,seenIds={},firstLoad=true,soundOn=false,chartCache={},chartFor='',bt=null;
function $(i){return document.getElementById(i)}
function ls(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function ss(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
var journal=ls('st_journal',[]),cfg=ls('st_cfg',{bal:1000,risk:0.5,token:''}),checks=ls('st_checks',{day:'',v:[0,0,0,0,0]});
function fp(p){if(p==null)return '-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){return x==null||isNaN(x)?'-':Number(x).toFixed(d==null?2:d)}
function sg(x,d){x=Number(x);return (x>0?'+':'')+x.toFixed(d==null?2:d)}
function cl(x){return x>0?'up':x<0?'dn':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function trNow(){return new Date(Date.now()+3*3600e3)}
function dayKey(){return trNow().toISOString().slice(0,10)}
function hm(min){var h=Math.floor(min/60),m=min%60;return h>0?h+'s '+m+'dk':m+'dk'}
function winInfo(){var d=trNow(),m=d.getUTCHours()*60+d.getUTCMinutes(),W=[[600,720,'Londra'],[990,1140,'ABD']],i;
 for(i=0;i<W.length;i++)if(m>=W[i][0]&&m<W[i][1])return {open:true,name:W[i][2],left:W[i][1]-m};
 for(i=0;i<W.length;i++)if(m<W[i][0])return {open:false,name:W[i][2],left:W[i][0]-m};
 return {open:false,name:W[0][2],left:W[0][0]+1440-m}}
function todayJ(){var k=dayKey();return journal.filter(function(j){return j.day===k})}
function gateState(){var w=winInfo(),t=todayJ(),r=0,i,cons=0,lastLoss=0;t.forEach(function(j){r+=j.r});
 for(i=t.length-1;i>=0;i--){if(t[i].r<0){cons++;if(!lastLoss)lastLoss=t[i].ts}else break}
 var pauseLeft=lastLoss?Math.ceil((lastLoss+LIM.pause*60000-Date.now())/60000):0;
 if(r<=LIM.loss)return {c:'stop',a:'DUR',b:'Günlük limit doldu ('+sg(r,1)+'R). Bugün bitti.'};
 if(t.length>=LIM.trades)return {c:'stop',a:'DUR',b:'Günlük işlem limiti doldu ('+LIM.trades+').'};
 if(cons>=LIM.cons&&pauseLeft>0)return {c:'stop',a:'MOLA',b:cons+' üst üste stop. '+pauseLeft+' dk bekle.'};
 if(r>=LIM.win)return {c:'wait',a:'YAVAŞLA',b:sg(r,1)+'R hedef doldu. Sadece en güçlü kurulum.'};
 if(!w.open)return {c:'wait',a:'BEKLE',b:'Pencere dışı. '+w.name+' penceresine '+hm(w.left)+' var.'};
 return {c:'ok',a:'AÇIK',b:w.name+' penceresi, '+hm(w.left)+' kaldı. Bugün '+sg(r,1)+'R, '+t.length+' işlem.'}}
function renderGate(){var d=trNow();$('clock').textContent=('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2)+':'+('0'+d.getUTCSeconds()).slice(-2);
 var g=gateState();$('gate').className='gate '+g.c;$('g1').textContent=g.a;$('g2').textContent=g.b}
function mchip(id,n,m){var e=$(id);if(!m){e.innerHTML='<b>'+n+'</b> -';return}
 var t=m.dir===1?'<span class="up">15m ▲</span>':m.dir===-1?'<span class="dn">15m ▼</span>':'<span class="fl">15m ▬</span>';
 e.innerHTML='<b>'+n+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg,2)+'%</span> '+t}
function renderTop(){if(!S)return;mchip('cBTC','BTC',S.market&&S.market.btc);mchip('cETH','ETH',S.market&&S.market.eth);$('modeB').textContent=S.mode}
function openS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT'}
var ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1 alındı','g'],TP2:['TP2 ✓','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre doldu','w']};
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function renderTabs(){var oc=S?S.signals.filter(openS).length:0,h='';TABS.forEach(function(t){h+='<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?'<i>'+oc+'</i>':'')+'</button>'});$('tabs').innerHTML=h;
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.getAttribute('data-t');if(tab==='sig'||tab==='radar')sel=null;renderAll()}})}
function sigCard(s){var st=ST[s.status]||['?',''],cls='card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed'),ch='';
 if(openS(s)&&s.lastPrice){var mv=(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop);if(s.status==='ACTIVE'&&mv>0.35)ch='<span class="tag r">Kovalama</span>'}
 return '<div class="'+cls+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">GÜÇLÜ '+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+(s.netR!=null&&!openS(s)?' '+sg(s.netR,2)+'R':'')+'</span>'+ch+'<span class="sc">'+s.score+'</span></div><div class="sub"><span>Giriş '+fp(s.entry)+'</span><span>Stop '+fp(s.stop)+'</span><span>TP1 '+fp(s.tp1)+'</span><span>'+ago(s.time)+' önce</span><span>'+esc(s.setupName)+'</span></div></div>'}
function radarCard(r){var cls='card'+(sel&&sel.sym===r.symbol?' sel':''),b=r.bias==='LONG'?'<span class="badge L">LONG</span>':r.bias==='SHORT'?'<span class="badge S">SHORT</span>':'<span class="badge" style="color:var(--dm)">-</span>';
 return '<div class="'+cls+'" data-sym="'+esc(r.symbol)+'"><div class="r1">'+b+'<span class="coin">'+esc(r.base)+'</span><span class="mut">'+fp(r.price)+'</span><span class="'+cl(r.chg24)+'" style="margin-left:auto">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>Hacim x'+f2(r.volX,1)+'</span><span>RSI '+f2(r.rsi,0)+'</span><span>Fon '+(r.funding==null?'-':f2(r.funding*100,3)+'%')+'</span><span>'+esc(r.state)+'</span></div></div>'}
function renderList(){var L=$('list'),h='',i;if(!S){L.innerHTML='<div class="note">Yükleniyor...</div>';return}
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return !openS(s)}).slice(0,25);
  if(!a.length)h+='<div class="note" style="padding:10px">Şu an açık güçlü sinyal yok. Bot her 5 dakikalık mum kapanışında tarar. Bu sırada Radar sekmesindeki en yakın kurulumlara bak.</div>';
  a.forEach(function(s){h+=sigCard(s)});if(c.length)h+='<h3>Kapanan</h3>';c.forEach(function(s){h+=sigCard(s)})}
 else if(tab==='radar'){S.radar.forEach(function(r){h+=radarCard(r)});if(!S.radar.length)h='<div class="note" style="padding:10px">Radar ilk taramadan sonra dolar.</div>'}
 else if(tab==='stat'){h='<div class="note" style="padding:8px">Sağdaki panelde botun geçmiş sinyal sonuçları var.</div>'}
 else if(tab==='jr'){h='<div class="note" style="padding:8px">Kendi işlemlerini sağdaki panelden kaydet. Günlük limit kontrolü bu kayıtlara göre çalışır. Kayıtlar bu cihazda saklanır.</div>'}
 else{h='<div class="note" style="padding:8px">Testi sağdaki panelden başlat.</div>'}
 L.innerHTML=h;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.getAttribute('data-id'),sy=e.getAttribute('data-sym');
  if(id){var s=S.signals.filter(function(x){return x.id===id})[0];sel={id:id,sym:s.symbol}}else{sel={sym:sy}}chartFor='';renderList();renderMain()}})}
function calc(entry,stop,dirSign){var bal=Number(cfg.bal)||0,rk=Number(cfg.risk)||0,riskUsd=bal*rk/100,d=Math.abs(entry-stop);if(!d||!bal)return null;
 var qty=riskUsd/d,notional=qty*entry;return {riskUsd:riskUsd,qty:qty,notional:notional,lev:notional/bal}}
function calcBox(entry,stop){var c=entry&&stop?calc(Number(entry),Number(stop)):null;
 return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="mut">Bakiye USDT<br><input id="cBal" type="number" value="'+cfg.bal+'"></label><label class="mut">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfg.risk+'"></label><label class="mut">Giriş<br><input id="cE" type="number" step="any" value="'+(entry||'')+'"></label><label class="mut">Stop<br><input id="cS" type="number" step="any" value="'+(stop||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px">'+calcOut(c)+'</div><div class="note">1R, bakiyenin risk yüzdesi kadardır. Değerler bu cihazda saklanır.</div></div>'}
function calcOut(c){return c?'1R = <b>'+f2(c.riskUsd,2)+' USDT</b> &nbsp; Miktar <b>'+f2(c.qty,4)+'</b> &nbsp; Pozisyon <b>'+f2(c.notional,1)+' USDT</b> &nbsp; Gereken kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değerleri gir.'}
function bindCalc(){['cBal','cRisk','cE','cS'].forEach(function(id){var e=$(id);if(!e)return;e.oninput=function(){cfg.bal=Number($('cBal').value);cfg.risk=Number($('cRisk').value);ss('st_cfg',cfg);var en=Number($('cE').value),so=Number($('cS').value);$('cOut').innerHTML=calcOut(en&&so?calc(en,so):null)}})}
function checklist(){var k=dayKey();if(checks.day!==k){checks={day:k,v:[0,0,0,0,0]};ss('st_checks',checks)}
 var Q=['15m yönü işlemle aynı mı?','Hacim ortalamanın üstünde mi?','Stop net bir yapının arkasında mı?','R/R en az 1.5 ve maliyet uygun mu?','Pencere açık ve günlük limit dolmadı mı?'],h='<div class="box chk"><h3 style="margin-top:0">Giriş öncesi kontrol</h3>';
 Q.forEach(function(q,i){h+='<label><input type="checkbox" data-c="'+i+'"'+(checks.v[i]?' checked':'')+'> '+q+'</label>'});return h+'<div class="note">Biri boşsa girme. Her yeni işlemde işaretleri temizle.</div><button class="btn g" id="chkClr">Temizle</button></div>'}
function bindChecklist(){Array.prototype.forEach.call(document.querySelectorAll('[data-c]'),function(e){e.onchange=function(){checks.v[Number(e.getAttribute('data-c'))]=e.checked?1:0;ss('st_checks',checks)}});var b=$('chkClr');if(b)b.onclick=function(){checks.v=[0,0,0,0,0];ss('st_checks',checks);renderMain()}}
function homeView(){var t=todayJ(),r=0,w=0,l=0;t.forEach(function(j){r+=j.r;if(j.r>0)w++;else if(j.r<0)l++});
 var td=S.stats.today,h='<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Benim günüm (R)</div><div class="v '+cl(r)+'">'+sg(r,1)+'</div></div><div class="tile"><div class="k">Benim işlemlerim</div><div class="v">'+t.length+' <span class="mut" style="font-size:12px">'+w+'K / '+l+'Z</span></div></div><div class="tile"><div class="k">Bot sinyali bugün</div><div class="v">'+td.n+' <span class="mut" style="font-size:12px">ort '+sg(td.avgR,2)+'R</span></div></div><div class="tile"><div class="k">Taranan coin</div><div class="v">'+S.scan.universe+'</div></div></div>';
 h+='<div class="grid2"><div><div class="box"><h3 style="margin-top:0">En yakın kurulumlar</h3><table><tr><th>Coin</th><th>Yön</th><th class="n">Hacim</th><th>Durum</th></tr>';
 S.radar.slice(0,6).forEach(function(x){h+='<tr><td><b>'+esc(x.base)+'</b></td><td class="'+(x.bias==='LONG'?'up':x.bias==='SHORT'?'dn':'fl')+'">'+(x.bias==='-'?'-':x.bias)+'</td><td class="n">x'+f2(x.volX,1)+'</td><td class="mut">'+esc(x.state)+'</td></tr>'});
 h+='</table></div>'+checklist()+'</div><div>'+calcBox('','')+'<div class="box"><h3 style="margin-top:0">Tarama özeti</h3><div class="note" style="color:var(--tx)">Son tarama: '+(S.scan.last?ago(S.scan.last)+' önce':'-')+' &nbsp; Süre: '+f2(S.scan.ms/1000,1)+' sn</div><div class="note">Elenme nedenleri (bugün): '+reasonTxt(S.scan.reasons)+'</div><div class="note">Sinyal kuralı: 15m trend + 5m geri çekilme/likidite süpürme + hacim + maliyet filtresi. Puan '+S.minScore+' ve üstü "güçlü" sayılır.</div></div></div></div>';
 return h}
function reasonTxt(o){var a=[];for(var k in o)a.push([k,o[k]]);a.sort(function(x,y){return y[1]-x[1]});return a.slice(0,6).map(function(x){return x[0]+' '+x[1]}).join(', ')||'-'}
function partsView(s){var lab={trend:'15m trend',htf:'1s yön',vol:'Hacim',setup:'Kurulum',vwap:'VWAP',rsi:'RSI payı',btc:'BTC uyumu',fund:'Funding',win:'Saat',cost:'Maliyet'},mx={trend:22,htf:8,vol:20,setup:20,vwap:8,rsi:6,btc:10,fund:4,win:6,cost:6},h='';
 for(var k in lab){var v=s.parts[k]||0;h+='<div class="pr"><span>'+lab[k]+'</span><div class="bar"><i style="width:'+Math.max(0,Math.min(100,v/mx[k]*100))+'%;background:'+(v<0?'var(--st)':'var(--am)')+'"></i></div><b class="'+(v<0?'dn':'')+'">'+v+'</b></div>'}return h}
function sigView(s){var st=ST[s.status]||['?',''],risk=Math.abs(s.entry-s.initialStop),w='';
 (s.warnings||[]).forEach(function(x){w+='<span class="tag w">'+esc(x)+'</span> '});
 var txt=s.dir+' '+s.base+' | Giriş '+fp(s.entry)+' | Stop '+fp(s.initialStop)+' | TP1 '+fp(s.tp1)+' | TP2 '+fp(s.tp2);
 var h='<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">GÜÇLÜ '+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span><span class="sc" style="font-size:24px">'+s.score+'</span></div>';
 h+='<div class="mut" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce'+(s.netR!=null&&!openS(s)?' • Sonuç '+sg(s.netR,2)+'R':'')+'</div>'+w;
 h+='<canvas id="cv"></canvas><div class="lv"><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1 (1R)</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2 (2R)</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Stop mesafesi</span><b>'+f2(s.riskPct,2)+'%</b></div><div><span>Maliyet</span><b>'+f2(s.costR,2)+'R</b></div><div><span>Anlık</span><b>'+fp(s.lastPrice)+'</b></div><div><span>En iyi/kötü</span><b>'+f2(s.mfe,1)+'R / '+f2(s.mae,1)+'R</b></div></div>';
 h+='<div class="frm"><button class="btn" id="cpy">Seviyeleri kopyala</button><button class="btn g" id="addJ">Günlüğe ekle</button></div><div class="grid2"><div class="box"><h3 style="margin-top:0">Puan dağılımı</h3>'+partsView(s)+'<div class="note">Hacim x'+f2(s.volX,1)+' • RSI '+f2(s.rsi,0)+' • Funding '+(s.funding==null?'-':f2(s.funding*100,3)+'%')+'</div></div><div>'+calcBox(s.entry,s.initialStop)+'</div></div>';
 return {h:h,txt:txt,s:s}}
function radarView(sym){var r=S.radar.filter(function(x){return x.symbol===sym})[0];var h='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'</div><canvas id="cv"></canvas>';
 if(r)h+='<div class="lv"><div><span>Fiyat</span><b>'+fp(r.price)+'</b></div><div><span>24s</span><b class="'+cl(r.chg24)+'">'+sg(r.chg24,1)+'%</b></div><div><span>15m trend</span><b>'+(r.trend===1?'Yukarı':r.trend===-1?'Aşağı':'Yatay')+'</b></div><div><span>Hacim</span><b>x'+f2(r.volX,1)+'</b></div><div><span>RSI</span><b>'+f2(r.rsi,0)+'</b></div><div><span>Funding</span><b>'+(r.funding==null?'-':f2(r.funding*100,3)+'%')+'</b></div></div>';
 return h+calcBox('','')}
function statBlock(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Ort R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR,2)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>'}
function statView(){var a=S.stats.all,h='<h2>Bot sinyal istatistiği</h2><div class="tiles"><div class="tile"><div class="k">Kapanan sinyal</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Ortalama R (net)</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR,2)+'</div></div><div class="tile"><div class="k">Toplam R</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'</div></div><div class="tile"><div class="k">Profit factor</div><div class="v">'+f2(a.pf,2)+'</div></div><div class="tile"><div class="k">Maks. düşüş</div><div class="v dn">'+f2(a.dd,1)+'R</div></div></div><canvas id="eq" style="height:160px"></canvas>';
 h+='<div class="note">Ortalama R pozitif ve işlem sayısı 100 civarına gelince istatistik anlam kazanır. Net R, komisyon ve kayma dahil hesaplanır.</div>'+statBlock(S.stats.bySetup,'Kurulum bazında')+statBlock(S.stats.byDir,'Yön bazında')+statBlock(S.stats.byBand,'Puan bandı')+statBlock(S.stats.byHour,'Saat (TR)');return h}
function jrView(){var t=todayJ(),r=0,all=0,w=0;t.forEach(function(j){r+=j.r});journal.forEach(function(j){all+=j.r;if(j.r>0)w++});
 var h='<h2>Benim işlem günlüğüm</h2><div class="tiles"><div class="tile"><div class="k">Bugün</div><div class="v '+cl(r)+'">'+sg(r,1)+'R</div></div><div class="tile"><div class="k">Tümü</div><div class="v '+cl(all)+'">'+sg(all,1)+'R</div></div><div class="tile"><div class="k">İşlem</div><div class="v">'+journal.length+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+(journal.length?f2(w/journal.length*100,0):'-')+'%</div></div></div>';
 h+='<div class="box"><div class="frm"><input id="jSym" placeholder="Coin (SOL)"><select id="jDir"><option>LONG</option><option>SHORT</option></select><input id="jR" type="number" step="0.1" placeholder="Sonuç R (örn -1, 1.5)"><input id="jN" placeholder="Not / setup" style="width:200px"><button class="btn" id="jAdd">Kaydet</button></div><div class="note">Sonucu R olarak yaz: stop yedin -1, TP1+başa baş 0.5, TP2 1.5 gibi. Bu kayıtlar üstteki "AÇIK/DUR" kararını besler.</div></div><table><tr><th>Zaman</th><th>Coin</th><th>Yön</th><th class="n">R</th><th>Not</th><th></th></tr>';
 journal.slice().reverse().slice(0,40).forEach(function(j){var d=new Date(j.ts+3*3600e3);h+='<tr><td class="mut">'+d.toISOString().slice(5,16).replace('T',' ')+'</td><td><b>'+esc(j.sym)+'</b></td><td class="'+(j.dir==='LONG'?'up':'dn')+'">'+j.dir+'</td><td class="n '+cl(j.r)+'">'+sg(j.r,1)+'</td><td class="mut">'+esc(j.note||'')+'</td><td><button class="ibtn" data-del="'+j.id+'">Sil</button></td></tr>'});return h+'</table>'}
function bindJr(pre){var b=$('jAdd');if(!b)return;if(pre){$('jSym').value=pre.base;$('jDir').value=pre.dir;$('jN').value=pre.setupName}
 b.onclick=function(){var sy=$('jSym').value.trim().toUpperCase(),r=Number($('jR').value);if(!sy||isNaN(r)||$('jR').value===''){alert('Coin ve sonuç R gerekli.');return}journal.push({id:Date.now(),ts:Date.now(),day:dayKey(),sym:sy,dir:$('jDir').value,r:r,note:$('jN').value});ss('st_journal',journal);renderAll()};
 Array.prototype.forEach.call(document.querySelectorAll('[data-del]'),function(e){e.onclick=function(){var id=Number(e.getAttribute('data-del'));journal=journal.filter(function(j){return j.id!==id});ss('st_journal',journal);renderAll()}})}
function btTable(o,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Ort R</th><th class="n">Toplam R</th></tr>'+Object.keys(o).map(function(k){var x=o[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR,2)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>'}
function btView(){var h='<h2>Geçmiş veri testi</h2><div class="box"><div class="frm"><select id="bD"><option value="7">7 gün</option><option value="14" selected>14 gün</option><option value="30">30 gün</option></select><select id="bC"><option value="5">5 coin</option><option value="10" selected>10 coin</option><option value="20">20 coin</option></select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">Aynı sinyal kuralları geçmiş 5 dakikalık mumlar üzerinde çalıştırılır. Süre coin ve gün sayısına göre birkaç dakika sürebilir. Sayfayı kapatsan da sunucu devam eder. Funding geçmişte yok, o kısım nötr sayılır.</div></div>';
 if(!bt)return h+'<div class="note">Henüz test yok.</div>';
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){var R=bt.result;h+='<div class="tiles"><div class="tile"><div class="k">Toplam işlem</div><div class="v">'+R.all.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(R.all.win*100,0)+'%</div></div><div class="tile"><div class="k">Ort R (net)</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR,2)+'</div></div><div class="tile"><div class="k">Test bloğu ort R</div><div class="v '+cl(R.test.avgR)+'">'+sg(R.test.avgR,2)+'</div><div class="k">'+R.test.n+' işlem (son %30)</div></div><div class="tile"><div class="k">Profit factor</div><div class="v">'+f2(R.all.pf,2)+'</div></div><div class="tile"><div class="k">Maks. düşüş</div><div class="v dn">'+f2(R.all.dd,1)+'R</div></div></div><div class="note">'+R.days+' gün, '+R.coins+' coin, '+R.candles+' mum. En önemli satır "Test bloğu": veri iki parçaya bölünür, son %30 stratejiyi ayarlarken görmediğin kısımdır. Orada ort R pozitif ve işlem sayısı yeterliyse güven artar.</div>'+btTable(R.bySetup,'Kurulum')+btTable(R.byDir,'Yön')+btTable(R.byBand,'Puan bandı')+btTable(R.byCoin,'Coin')}
 return h}
function bindBt(){var b=$('bGo');if(!b)return;b.onclick=function(){var hd={'Content-Type':'application/json'};if(cfg.token)hd['x-admin-token']=cfg.token;
 fetch('/api/backtest',{method:'POST',headers:hd,body:JSON.stringify({days:Number($('bD').value),coins:Number($('bC').value)})}).then(function(r){if(r.status===401){var t=prompt('Admin şifresi (ADMIN_TOKEN):');if(t){cfg.token=t;ss('st_cfg',cfg)}return null}return r.json()}).then(function(){pollBt()})}}
function pollBt(){fetch('/api/backtest').then(function(r){return r.json()}).then(function(d){bt=d;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}
function drawEq(){var c=$('eq');if(!c||!S.equity.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);var v=S.equity,mn=Math.min(0,Math.min.apply(null,v)),mx=Math.max(0.1,Math.max.apply(null,v)),Y=function(a){return H-10-(a-mn)/(mx-mn)*(H-20)};
 x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach(function(a,i){var px=i/Math.max(1,v.length-1)*(W-8)+4;if(i)x.lineTo(px,Y(a));else x.moveTo(px,Y(a))});x.stroke()}
function drawChart(d,s){var c=$('cv');if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);
 var L=8,R=74,T=12,B=18,n=d.c.length,PW=W-L-R,PH=H-T-B,hi=-1e99,lo=1e99,i;for(i=0;i<n;i++){hi=Math.max(hi,d.c[i][2]);lo=Math.min(lo,d.c[i][3])}
 var lv=[];if(s){lv=[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.initialStop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']];lv.forEach(function(a){hi=Math.max(hi,a[0]);lo=Math.min(lo,a[0])})}
 var pad=(hi-lo)*0.05;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+0.5)/n*PW},cw=Math.max(2,PW/n*0.68);
 x.strokeStyle='rgba(255,255,255,.05)';for(i=0;i<=4;i++){var gy=T+PH*i/4;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillStyle='#8593a5';x.font='10px system-ui';x.textAlign='left';x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 function line(arr,col,w){x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;arr.forEach(function(v,k){if(v==null)return;if(!st){x.moveTo(X(k),Y(v));st=true}else x.lineTo(X(k),Y(v))});x.stroke()}
 line(d.vwap,'#5aa9ff',1.2);line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 for(i=0;i<n;i++){var k=d.c[i],up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();var y1=Y(k[1]),y2=Y(k[4]);x.fillRect(X(i)-cw/2,Math.min(y1,y2),cw,Math.max(1,Math.abs(y2-y1)))}
 lv.forEach(function(a){x.strokeStyle=a[1];x.lineWidth=1.5;x.setLineDash(a[2]==='GİRİŞ'?[]:[5,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.fillStyle=a[1];x.font='bold 10px system-ui';x.fillText(a[2],W-R+6,Y(a[0])-3)});
 if(s){var ei=-1;for(i=0;i<n;i++)if(d.c[i][0]+300000>=s.time-1000){ei=i;break}if(ei>=0){x.strokeStyle='rgba(242,184,75,.6)';x.setLineDash([3,3]);x.beginPath();x.moveTo(X(ei),T);x.lineTo(X(ei),H-B);x.stroke();x.setLineDash([])}}
 var lc=d.c[n-1][4];x.strokeStyle='#e6ebf2';x.lineWidth=1;x.setLineDash([2,3]);x.beginPath();x.moveTo(L,Y(lc));x.lineTo(W-R,Y(lc));x.stroke();x.setLineDash([]);x.fillStyle='#e6ebf2';x.fillText(fp(lc),W-R+6,Y(lc)+3);
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText('5m  •  sarı EMA21  •  gri EMA50  •  mavi VWAP',L+4,H-5)}
function loadChart(sym,s){if(!sym)return;var key=sym;fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(d){chartCache[key]=d;if(sel&&sel.sym===sym){var ss2=sel.id?S.signals.filter(function(x){return x.id===sel.id})[0]:null;drawChart(d,ss2)}}).catch(function(){})}
function renderMain(){var M=$('main');if(!S){M.innerHTML='';return}var h='',pre=null;
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='jr'){M.innerHTML=jrView();bindJr();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){var s=S.signals.filter(function(x){return x.id===sel.id})[0];if(s){var v=sigView(s);M.innerHTML=v.h;pre=s;$('cpy').onclick=function(){try{navigator.clipboard.writeText(v.txt);$('cpy').textContent='Kopyalandı'}catch(e){prompt('Kopyala:',v.txt)}};$('addJ').onclick=function(){tab='jr';renderAll();bindJr(pre)};bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol,s)}return}}
 if(sel&&sel.sym){M.innerHTML=radarView(sel.sym);bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym,null)}return}
 M.innerHTML=homeView();bindCalc();bindChecklist()}
function renderAll(){renderTop();renderTabs();renderList();renderMain();renderGate()}
function beep(){try{var a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.15;o.start();o.stop(a.currentTime+.25)}catch(e){}}
function apply(d){if(!d)return;S=d;var fresh=[];d.signals.forEach(function(s){if(openS(s)&&!seenIds[s.id]){seenIds[s.id]=1;if(!firstLoad)fresh.push(s)}else if(!seenIds[s.id])seenIds[s.id]=1});
 if(fresh.length&&soundOn){beep();try{if(Notification.permission==='granted')new Notification('GÜÇLÜ '+fresh[0].dir+' '+fresh[0].base,{body:'Giriş '+fp(fresh[0].entry)+' Stop '+fp(fresh[0].initialStop)+' Puan '+fresh[0].score})}catch(e){}}
 firstLoad=false;var keep=document.activeElement&&document.activeElement.tagName==='INPUT';if(keep&&(tab==='jr'||tab==='bt'||tab==='sig'&&!sel||tab==='radar'&&!sel)){renderTop();renderTabs();renderList();renderGate();return}renderAll()}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){apply(d);$('dot').className='dot on';$('conn').textContent='Bağlı'}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
$('bSound').onclick=function(){soundOn=!soundOn;this.className='ibtn'+(soundOn?' on':'');this.textContent=soundOn?'Bildirim açık':'Bildirim kapalı';if(soundOn){beep();try{Notification.requestPermission()}catch(e){}}};
window.addEventListener('resize',function(){if(S)renderMain()});
setInterval(renderGate,1000);setInterval(poll,5000);setInterval(function(){if(sel&&sel.sym)loadChart(sel.sym,null)},20000);
poll();pollBt();
</script>
</body>
</html>
`;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const authed = req => !ADMIN_TOKEN || req.headers['x-admin-token'] === ADMIN_TOKEN;
function body(req) { return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
        if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(HTML); }
        if (u.pathname === '/health') return json(res, 200, { ok: true });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(req)) return json(res, 401, { error: 'yetkisiz' });
            const b = await body(req), days = [7, 14, 30].includes(b.days) ? b.days : 14, coins = [5, 10, 20].includes(b.coins) ? b.coins : 10;
            if (!btJob.running) runBacktest(days, coins);
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!ADMIN_TOKEN || !authed(req)) return json(res, 401, { error: 'ADMIN_TOKEN tanımlı değil veya yanlış' });
            signals = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler yüklendi:', Object.keys(ex.markets).length);
        await refreshUniverse(); await refreshFunding();
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(refreshFunding, CFG.FUNDING_MS);
        setInterval(track, CFG.TRACK_MS); setInterval(refreshTickers, 15e3); setInterval(saveState, 15e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M5); runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M5); if (slot > lastScanSlot) { lastScanSlot = slot; runScan(); } }, 2000);
        log('SONER TRADE v7 SCALP hazır');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { evaluate, advance, calcStats, trendOf, aggregate, CFG, _set: o => Object.assign(CFG, o) };
