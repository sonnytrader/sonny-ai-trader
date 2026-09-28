'use strict';
// ============================================================
// SONER TRADE v9.4 — SCALP 15m BREAKOUT (FIXED)
// - BTC/ETH piyasa yönü 15m
// - MIN_SCORE 90
// - SHORT için EMA21 onayı
// - Geniş kripto-dışı filtre
// - apply() süslü parantez hatası düzeltildi
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
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const M5 = 5 * 60e3, M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1, H4 = 4 * H1;

const NON_CRYPTO = [
    'USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','MIM','LUSD','GUSD','USDF','BUIDL','USTC','USDP','USDL','EURS','USDR','SUSD',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','SFRXETH','WBNB','WAVAX','WMATIC',
    'PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','CL','BZ','NG','XAUUSD','XAGUSD','XPTUSD','XPDUSD','COPPER','PLATINUM',
    'AAPL','MSFT','GOOGL','GOOG','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','CRM','ADBE','NFLX','DIS','IBM','CSCO','QCOM','TXN','AVGO','MU','PYPL','SQ','SHOP','SPOT','NOW','SNOW','PLTR','UBER','LYFT','ABNB','DASH','ZOOM','DOCU','OKTA','TWLO','CRWD','ZS','PANW','FTNT','MDB','NET','DDOG',
    'JPM','BAC','WFC','GS','MS','C','V','MA','BRK','SCHW','BLK','AXP','USB','PNC','TFC','COF','BK','STT','MET','PRU','AIG','ALL','TRV','CB','PGR','AFL',
    'WMT','COST','KO','PEP','MCD','NKE','SBUX','HD','TGT','LOW','BA','CAT','GE','MMM','DE','HON','LMT','RTX','NOC','GD','UPS','FDX','DAL','UAL','AAL','LUV','F','GM','RIVN','LCID','NIO','XPEV','LI',
    'JNJ','PFE','MRK','ABBV','LLY','BMY','AMGN','GILD','BIIB','REGN','VRTX','MRNA','UNH','CVS','CI','HUM','ANTM','HCA','MDT','ABT','SYK','BSX','ZBH','BDX',
    'COIN','HOOD','CRCL','MSTR','MARA','RIOT','CLSK','BTBT','HUT','BITF','CORZ','WULF','IREN','GLXY',
    'BABA','JD','PDD','BIDU','TCOM','NTES','TME','BILI','IQ','VIPS','EDU','YUMC',
    'SPY','QQQ','SPCX','SNXX','SOXL','SOXS','SNDK','SKHY','DIA','IWM','VTI','VOO','ARKK','TQQQ','SQQQ','SPXU','UPRO','SPXL','LABU','LABD','FNGU','FNGD','JNUG','JDST','NUGT','DUST','UVXY','SVXY','VXX','VIXY',
    'MOONSHOT','MSTX','MSTU','MSTZ','CONL','NVDU','NVDS','TSLL','TSLQ','TSLS','AAPU','AAPD','MSFU','MSFD','AMZU','AMZD','METU','METD','GGLL','GGLS','NFXL','NFXS','BABX','BABU','BABD',
    'CIIG','DXYZ','ARM','SMCI','GME','AMC','BB','NOK','ERIC','SONY','TM','HMC','STLA','RACE','FERRARI','MC','LVMH','NVS','AZN','SNY','GSK','NVO','TAK','SAN','BTI','MO','PM','UL','UN','PG','CL','KMB','GIS','K','HSY','STZ','BUD','TAP','SAM','MNST','KDP','CELH',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','HKD','SGD','MXN','BRL','ZAR','TRY','INR','KRW','RUB','DXY','USDX','USOIL','UKOIL',
    'VIX','NASDAQ','DOW','SPX','NIKKEI','DAX','FTSE','HSI','CAC','STOXX','MSCI','EEM','EFA','VEA','VWO',
    'ROKU','WBD','PARA','FOX','FOXA','NWSA','NWS','LYV','MTCH','IAC','MATCH','TRIP','EXPE','BKNG','MAR','HLT','RCL','CCL','NCLH','MGM','LVS','WYNN','CZR','PENN','DKNG','FLUT'
];

const CFG = {
    MIN_SCORE: Number(process.env.MIN_SCORE || 90),
    LONG_RSI_MIN: 48, LONG_RSI_MAX: 68,
    SHORT_RSI_MIN: 32, SHORT_RSI_MAX: 52,
    LOOKBACK_4H: 30, LOOKBACK_2H: 30,
    RETEST_PERCENT: 0.80,
    RSI_PERIOD: 14,

    UNIVERSE: Number(process.env.UNIVERSE || 150),
    MIN_VOL_USDT: Number(process.env.MIN_VOL || 2e6),
    FLAT_MAX: 0.25,
    CANDLES_4H: 100, CANDLES_2H: 100, CANDLES_15M: 200,

    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),

    STOP_ATR_MULT: 1.8,
    TP1_R: 1.5, TP2_R: 2.0,
    MAX_RISK_PCT: 3.0, MIN_RISK_PCT: 0.5,
    COST_PCT: 0.12, MAX_COST_R: 0.40,
    MAX_HOLD_CANDLES: 96,

    COOLDOWN_MS: 2 * H1,
    MAX_OPEN_PER_DIR: 3, MAX_PER_SCAN: 3,
    MAX_SIGNAL_AGE_MS: 20 * 60e3,
    SCAN_DELAY_MS: 30000,
    CONCURRENCY: 6,
    TRACK_MS: 20e3, UNIVERSE_MS: 5 * 60e3, FUNDING_MS: 5 * 60e3, KEEP: 1000,
    HTF_CACHE_MS: 8 * 60e3
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
function trDay(t) { return new Date(t + 3 * H1).toISOString().slice(0, 10); }
function trHour(t) { return String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00'; }
function session(t) { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya (03-10 TR)' : h < 13 ? '2 Londra (10-16 TR)' : h < 21 ? '3 ABD (16-00 TR)' : '4 Gece (00-03 TR)'; }
function costFor(vol) { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.40; }
function flatRatio(c) { const a = c.slice(-288); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; }
function mktOf(bd, ed, breadthScore) { const s = 2 * (bd || 0) + (ed || 0) + (breadthScore || 0); return s >= 2 ? 1 : s <= -2 ? -1 : 0; }

function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
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
function trendOfTF(c, fast, slow, minSpread) {
    fast = fast || 21; slow = slow || 50; minSpread = minSpread || 0.08;
    if (!c || c.length < slow + 5) return 0;
    const cl = c.map(x => x[4]);
    const ef = emaSeries(cl, fast), es = emaSeries(cl, slow);
    const n = cl.length - 1;
    if (ef[n] == null || es[n] == null) return 0;
    const spread = (ef[n] - es[n]) / cl[n] * 100;
    if (spread >= minSpread && cl[n] > es[n]) return 1;
    if (spread <= -minSpread && cl[n] < es[n]) return -1;
    return 0;
}
function breakoutInfo(c, lookback) {
    if (c.length < lookback + 5) return null;
    const closed = c.slice(0, -1);
    const recent = Math.min(8, closed.length - lookback);
    let longBreak = false, shortBreak = false, longLevel = null, shortLevel = null;
    for (let i = closed.length - recent; i < closed.length; i++) {
        const history = closed.slice(i - lookback, i);
        if (history.length < lookback) continue;
        const resistance = Math.max(...history.map(x => x[2]));
        const support = Math.min(...history.map(x => x[3]));
        const current = closed[i], previous = closed[i - 1];
        if (current[4] > resistance && previous[4] <= resistance) { longBreak = true; longLevel = resistance; }
        if (current[4] < support && previous[4] >= support) { shortBreak = true; shortLevel = support; }
    }
    const last = closed.slice(-lookback);
    return {
        current: closed[closed.length - 1],
        resistance: longLevel || Math.max(...last.map(x => x[2])),
        support: shortLevel || Math.min(...last.map(x => x[3])),
        longBreak, shortBreak, longLevel, shortLevel
    };
}
function near(price, level) { if (!level) return false; return Math.abs((price - level) / level * 100) <= CFG.RETEST_PERCENT; }
function aggregate15(c15, n) {
    const ms = M15 * n, g = new Map();
    for (const x of c15) {
        const k = Math.floor(x[0] / ms) * ms;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}

function evaluate(c15, c4h, c2h, ctx) {
    if (c15.length < 50 || c4h.length < 40 || c2h.length < 40) return { signal: null, radar: null, reason: 'veri az' };
    const h4 = breakoutInfo(c4h, CFG.LOOKBACK_4H);
    const h2 = breakoutInfo(c2h, CFG.LOOKBACK_2H);
    if (!h4 || !h2) return { signal: null, radar: null, reason: 'veri az' };
    const last15 = c15[c15.length - 1];
    const closes15 = c15.map(x => x[4]);
    const rv = rsiLast(closes15.slice(0, -1), CFG.RSI_PERIOD);
    if (rv == null) return { signal: null, radar: null, reason: 'veri az' };
    const price = last15[4];
    const trend15 = trendOfTF(c15.slice(-60), 21, 50);
    const ema21Arr = emaSeries(closes15, 21);
    const ema21Last = ema21Arr[ema21Arr.length - 1];

    const radar = { symbol: ctx.sym, base: baseOf(ctx.sym), price, rsi: rv,
        funding: ctx.funding, bias: '-', state: 'Bekliyor', score: 0,
        h4Res: h4.resistance, h4Sup: h4.support, h4Break: h4.longBreak ? 1 : h4.shortBreak ? -1 : 0,
        h2Break: h2.longBreak ? 1 : h2.shortBreak ? -1 : 0, chg24: 0, trend15m: trend15 };

    const distRes = h4.resistance ? (h4.resistance - price) / price * 100 : 999;
    const distSup = h4.support ? (price - h4.support) / price * 100 : 999;
    if (h4.longBreak) { radar.bias = 'LONG'; radar.state = '4H kırılım var, retest bekle'; }
    else if (h4.shortBreak) { radar.bias = 'SHORT'; radar.state = '4H kırılım var, retest bekle'; }
    else if (distRes >= 0 && distRes <= 1.5) { radar.bias = 'LONG'; radar.state = '4H dirence yakın (' + distRes.toFixed(2) + '%)'; }
    else if (distSup >= 0 && distSup <= 1.5) { radar.bias = 'SHORT'; radar.state = '4H desteğe yakın (' + distSup.toFixed(2) + '%)'; }
    radar.score = radar.bias === '-' ? 0 : 60;

    let dir = null, level = null, reason = '';
    if (h4.longBreak || h2.longBreak) {
        const lv = h4.longBreak ? (h4.longLevel || h4.resistance) : (h2.longLevel || h2.resistance);
        const h4ok = h4.longBreak || price >= h4.resistance * 0.997;
        const h2ok = h2.longBreak || h2.current[4] >= h2.resistance * 0.997;
        const rsiOk = rv >= CFG.LONG_RSI_MIN && rv <= CFG.LONG_RSI_MAX;
        const retest = near(price, lv);
        if (h4ok && h2ok && retest && rsiOk) { dir = 'LONG'; level = lv; reason = (h4.longBreak ? '4H kırılım' : '2H kırılım') + ' + retest + RSI LONG'; }
    }
    if (!dir && (h4.shortBreak || h2.shortBreak)) {
        const lv = h4.shortBreak ? (h4.shortLevel || h4.support) : (h2.shortLevel || h2.support);
        const h4ok = h4.shortBreak || price <= h4.support * 1.003;
        const h2ok = h2.shortBreak || h2.current[4] <= h2.support * 1.003;
        const rsiOk = rv >= CFG.SHORT_RSI_MIN && rv <= CFG.SHORT_RSI_MAX;
        const retest = near(price, lv);
        const emaOk = ema21Last != null && price < ema21Last;
        if (h4ok && h2ok && retest && rsiOk && emaOk) { dir = 'SHORT'; level = lv; reason = (h4.shortBreak ? '4H kırılım' : '2H kırılım') + ' + retest + RSI + EMA21 SHORT'; }
    }
    if (!dir) return { signal: null, radar, reason: 'kurulum yok' };

    const side = dir === 'LONG' ? 1 : -1;
    const entry = price;
    const stop = dir === 'LONG' ? level * (1 - CFG.STOP_ATR_MULT / 100) : level * (1 + CFG.STOP_ATR_MULT / 100);
    const risk = Math.abs(entry - stop);
    const riskPct = risk / entry * 100;
    if (riskPct < CFG.MIN_RISK_PCT) return { signal: null, radar, reason: 'stop dar' };
    if (riskPct > CFG.MAX_RISK_PCT) return { signal: null, radar, reason: 'stop geniş' };
    const costPct = ctx.costPct != null ? ctx.costPct : CFG.COST_PCT;
    const costR = costPct / riskPct;
    if (costR > CFG.MAX_COST_R) return { signal: null, radar, reason: 'maliyet' };

    let score = 0;
    const h4b = h4.longBreak || h4.shortBreak;
    const h2b = h2.longBreak || h2.shortBreak;
    if (h4b) score += 35;
    if (h2b) score += 30; else if (h4b) score += 15;
    score += 20; score += 10;
    if ((dir === 'LONG' && rv >= 52 && rv <= 63) || (dir === 'SHORT' && rv >= 37 && rv <= 48)) score += 5;
    const mkt = ctx.mkt || 0;
    if (mkt === side) score += 3; else if (mkt === -side) score -= 10;
    if (ctx.sym.startsWith('BTC/')) score += 3;
    else if (ctx.btcDir === side) score += 3;
    else if (ctx.btcDir === -side) score -= 5;
    score = Math.max(0, Math.min(100, score));
    if (score < CFG.MIN_SCORE) return { signal: null, radar: Object.assign(radar, { state: 'Puan ' + score + ' yetersiz' }), reason: 'skor' };

    const tp1 = dir === 'LONG' ? entry + risk * CFG.TP1_R : entry - risk * CFG.TP1_R;
    const tp2 = dir === 'LONG' ? entry + risk * CFG.TP2_R : entry - risk * CFG.TP2_R;
    const warnings = [];
    if (mkt === -side) warnings.push('Piyasa ters');
    if (ctx.btcDir === -side && !ctx.sym.startsWith('BTC/')) warnings.push('BTC ters');

    const sig = {
        symbol: ctx.sym, base: baseOf(ctx.sym), dir,
        setup: 'BR', setupName: '4H/2H Kırılım + Retest',
        score,
        parts: { h4: h4b ? 35 : 0, h2: h2b ? 30 : (h4b ? 15 : 0), retest: 20, rsi: 10, mkt: mkt === side ? 3 : mkt === -side ? -10 : 0 },
        warnings,
        entry, stop, initialStop: stop, tp1, tp2,
        riskPct, costR, volX: 1, rsi: rv, funding: ctx.funding,
        trend: h4b ? (h4.longBreak ? 1 : -1) : 0, trend15m: trend15, mkt,
        time: last15[0] + M15, candleT: last15[0],
        level, h4Res: h4.resistance, h4Sup: h4.support,
        lastPrice: entry, mfe: 0, mae: 0,
        reason: reason + ' | Seviye ' + level.toFixed(4)
    };
    return { signal: sig, radar: Object.assign(radar, { state: 'GÜÇLÜ ' + dir, score: 100 }), reason: 'sinyal' };
}

function rOf(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t) { s.status = status; s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }
function advance(s, k, maxCandles) {
    const L = s.dir === 'LONG', risk = Math.abs(s.entry - s.initialStop);
    s.candles = (s.candles || 0) + 1;
    const hiR = L ? (k[2] - s.entry) / risk : (s.entry - k[3]) / risk, loR = L ? (k[3] - s.entry) / risk : (s.entry - k[2]) / risk;
    s.mfe = Math.max(s.mfe || 0, hiR); s.mae = Math.min(s.mae || 0, loR);
    s.lastPrice = k[4];
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, k[0] + 60e3); return true; }
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

function grp(list) {
    const n = list.length; if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0;
    for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
    return { n, win: w / n, avgR: tot / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 90 ? '90-100' : s.score >= 80 ? '80-89' : '80 altı';
const mktName = s => s.mkt === 1 ? 'Piyasa LONG' : s.mkt === -1 ? 'Piyasa SHORT' : 'Piyasa YATAY';
function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return { all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)),
        bySetup: groupBy(sorted, s => s.setup + ' ' + s.setupName), byDir: groupBy(sorted, s => s.dir),
        byBand: groupBy(sorted, band), bySession: groupBy(sorted, s => session(s.time)),
        byMkt: groupBy(sorted, mktName), byExit: groupBy(sorted, s => s.status),
        byHour: groupBy(sorted, s => trHour(s.time)) };
}

const ex = new ccxt.bitget({ enableRateLimit: true, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, fundingMap = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, reasonDay: '', total: 0, eligible: 0, excluded: 0 }, dirty = false, lastScanSlot = 0, btcCtx = { dir: 0, shock: 0 };
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const candleCache = new Map();
const htfCache = new Map();

function loadState() {
    try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); signals = j.signals || []; lastSig = j.lastSig || {}; log('durum:', signals.length, 'sinyal'); } catch (e) { log('temiz başlangıç'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig })); fs.renameSync(tmp, STATE_FILE); } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { }
}
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isMajor = s => /^(BTC|ETH)\//.test(s);

async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers();
        if (Date.now() - nonCryptoAt > 6 * H1) { nonCrypto = new Set(); nonCryptoAt = Date.now(); }
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = all.filter(t => {
            const base = baseOf(t.symbol).toUpperCase();
            if (CFG.EXCLUDED.includes(base)) return false;
            if (nonCrypto.has(t.symbol)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            return true;
        });
        const rank = (arr, f) => { const m = new Map(); arr.slice().sort((x, y) => f(x) - f(y)).forEach((t, i) => m.set(t.symbol, i / Math.max(1, arr.length - 1))); return m; };
        const rv = rank(ok, t => t.quoteVolume || 0), ra = rank(ok, t => Math.abs(t.percentage || 0) + (t.last ? ((t.high || 0) - (t.low || 0)) / t.last * 100 : 0));
        const top = ok.sort((x, y) => (rv.get(y.symbol) + ra.get(y.symbol)) - (rv.get(x.symbol) + ra.get(x.symbol))).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (!top.includes(s)) top.push(s);
        universe = top; scan.total = all.length; scan.eligible = ok.length;
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) { const t = tickers[s]; if (t) { const key = s.startsWith('BTC') ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t.last, chg: t.percentage }); } }
    } catch (e) { log('evren hatası', e.message); }
}
async function refreshFunding() {
    try { const f = await ex.fetchFundingRates(universe); for (const s of universe) if (f[s] && f[s].fundingRate != null) fundingMap[s] = Number(f[s].fundingRate); } catch (e) { }
}
async function fetchTF(sym, tf, limit, tfMs) { return closedOnly(await ex.fetchOHLCV(sym, tf, undefined, limit), tfMs); }
async function fetchMulti(sym) {
    const [c4h, c2h, c15] = await Promise.all([fetchTF(sym, '4h', CFG.CANDLES_4H, H4), fetchTF(sym, '2h', CFG.CANDLES_2H, H2), fetchTF(sym, '15m', CFG.CANDLES_15M, M15)]);
    return { c4h, c2h, c15 };
}
async function fetchMultiCache(sym) {
    const hit = htfCache.get(sym);
    if (hit && Date.now() - hit.t < CFG.HTF_CACHE_MS) return hit;
    try { const d = await fetchMulti(sym); htfCache.set(sym, Object.assign({ t: Date.now() }, d)); return { t: Date.now(), ...d }; }
    catch (e) { await sleep(500); const d = await fetchMulti(sym); htfCache.set(sym, Object.assign({ t: Date.now() }, d)); return { t: Date.now(), ...d }; }
}
function breadthScore(up, dn, n) { if (!n || n <= 0) return 0; return ((up - dn) / n) * 4; }

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.reasonDay = day; }
    const rad = [];
    try {
        let ethDir = 0;
        try {
            const b15 = await fetchTF('BTC/USDT:USDT', '15m', 100, M15);
            btcCtx.dir = trendOfTF(b15, 21, 50);
            market.btc = Object.assign(market.btc || {}, { dir: btcCtx.dir });
            try {
                const e15 = await fetchTF('ETH/USDT:USDT', '15m', 100, M15);
                ethDir = trendOfTF(e15, 21, 50);
                market.eth = Object.assign(market.eth || {}, { dir: ethDir });
            } catch (e) { }
        } catch (e) { log('BTC 15m hatası', e.message); }

        let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const d = await fetchMultiCache(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); continue; }
                    const t = tickers[sym] || {};
                    const r = evaluate(d.c15, d.c4h, d.c2h, { sym, btcDir: btcCtx.dir, funding: fundingMap[sym] != null ? fundingMap[sym] : null, mkt: 0, costPct: costFor(t.quoteVolume) });
                    if (r.radar) { r.radar.chg24 = t.percentage != null ? t.percentage : 0; rad.push(r.radar); }
                    scan.reasons[r.reason] = (scan.reasons[r.reason] || 0) + 1;
                } catch (e) { scan.reasons['hata'] = (scan.reasons['hata'] || 0) + 1; }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));

        let up = 0, dn = 0, fl = 0;
        for (const x of rad) { if (x.trend15m === 1) up++; else if (x.trend15m === -1) dn++; else fl++; }
        const bsc = breadthScore(up, dn, rad.length);
        mktDir = mktOf(btcCtx.dir, ethDir, bsc);
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: rad.length, breadth: Number(bsc.toFixed(2)) };
        scan.excluded = nonCrypto.size;
        radar = rad.filter(x => x.bias !== '-' || x.rsi >= 40).sort((a, b) => b.score - a.score).slice(0, 40);

        const found = [];
        for (const sym of universe) {
            const hit = htfCache.get(sym); if (!hit) continue;
            const t = tickers[sym] || {};
            const r = evaluate(hit.c15, hit.c4h, hit.c2h, { sym, btcDir: btcCtx.dir, funding: fundingMap[sym] != null ? fundingMap[sym] : null, mkt: mktDir, costPct: costFor(t.quoteVolume) });
            if (r.signal) { const age = Date.now() - r.signal.time; if (age <= CFG.MAX_SIGNAL_AGE_MS) found.push(r.signal); }
        }
        found.sort((a, b) => b.score - a.score);
        let added = 0;
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) continue;
            if (signals.filter(x => isOpen(x) && x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.candleT;
            s.status = 'ACTIVE'; s.lastPrice = s.entry; s.mfe = 0; s.mae = 0; s.candles = 0; s.trackedTo = s.candleT + M15 - 60e3;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            log('SİNYAL', s.dir, s.symbol, 'puan', s.score, 'piyasa', market.mood.label);
            telegram('GÜÇLÜ ' + s.dir + ' ' + s.base + ' (puan ' + s.score + ')\n' + s.setupName + '\nPiyasa: ' + market.mood.label + '\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + '\nTP1 ' + fmt(s.tp1) + '\nTP2 ' + fmt(s.tp2) + '\n' + (s.warnings.length ? '⚠ ' + s.warnings.join(', ') : ''));
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
                if (advance(s, k, CFG.MAX_HOLD_CANDLES * 15)) { dirty = true; if (!isOpen(s)) { log('KAPANDI', s.symbol, s.status, s.netR); telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; } }
                dirty = true;
            }
            const t = tickers[s.symbol]; if (t && t.last && isOpen(s)) s.lastPrice = t.last;
        }
    } catch (e) { }
}
async function refreshTickers() {
    try {
        const t = await ex.fetchTickers(); tickers = t;
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (t[s]) { const key = s.startsWith('BTC') ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}
async function selfPing() { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } }

function apiState() {
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = calcStats(closed, trDay(now));
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    return { now, mode: 'SCALP 15m v9.4', minScore: CFG.MIN_SCORE, market, signals: signals.slice(0, 80), radar, stats: st, equity: eq,
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible, excluded: scan.excluded } };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const hit = candleCache.get(sym); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const c = await ex.fetchOHLCV(sym, '15m', undefined, 200);
    const cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), N = 120, cut = Math.max(0, c.length - N);
    const d = { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut) };
    candleCache.set(sym, { t: Date.now(), d }); return d;
}

async function fetchHistory15(sym, days) {
    let since = Date.now() - (days + 3) * 86400e3, all = [], guard = 0;
    while (since < Date.now() - M15 && guard++ < 120) {
        const r = await ex.fetchOHLCV(sym, '15m', since, 1000);
        if (!r || !r.length) break;
        all = all.concat(r); const last = r[r.length - 1][0];
        if (last <= since) break; since = last + M15;
    }
    const seen = new Set(); return closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
}
async function runBacktest(days, coins) {
    if (btJob.running) return;
    btJob = { running: true, msg: 'Coin listesi hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const syms = universe.filter(s => !isMajor(s) || s === 'ETH/USDT:USDT').filter(s => s !== 'BTC/USDT:USDT').slice(0, coins);
        const all = ['BTC/USDT:USDT'].concat(syms.includes('ETH/USDT:USDT') ? [] : ['ETH/USDT:USDT'], syms);
        btJob.total = all.length * 2;
        const data = {}; let candles = 0; const skipped = [];
        for (const s of all) { btJob.msg = 'Veri indiriliyor: ' + baseOf(s); data[s] = await fetchHistory15(s, days); candles += data[s].length; btJob.done++; }
        btJob.msg = 'BTC/ETH 15m yönü hesaplanıyor';
        const btc15 = data['BTC/USDT:USDT']; const btcMap = new Map();
        for (let i = 400; i < btc15.length; i++) {
            const w = btc15.slice(0, i + 1);
            btcMap.set(btc15[i][0], trendOfTF(w, 21, 50));
            if (i % 300 === 0) await sleep(0);
        }
        const eth15 = data['ETH/USDT:USDT']; const ethMap = new Map();
        for (let i = 400; i < eth15.length; i++) {
            const w = eth15.slice(0, i + 1);
            ethMap.set(eth15[i][0], trendOfTF(w, 21, 50));
            if (i % 300 === 0) await sleep(0);
        }
        const breadthMap = new Map();
        for (const k of btcMap.keys()) { const bd = btcMap.get(k) || 0, ed = ethMap.get(k) || 0; breadthMap.set(k, (bd + ed) * 2); }

        const startT = Date.now() - days * 86400e3, trades = [], funnel = {};
        for (const sym of syms) {
            btJob.msg = 'Test ediliyor: ' + baseOf(sym); const c = data[sym]; let busyUntil = 0;
            if (!isMajor(sym) && flatRatio(c) >= CFG.FLAT_MAX) { skipped.push(baseOf(sym)); btJob.done++; continue; }
            const costPct = costFor((tickers[sym] || {}).quoteVolume);
            for (let i = 400; i < c.length - 2; i++) {
                if (c[i][0] < startT || c[i][0] < busyUntil) continue;
                const w = c.slice(0, i + 1);
                const c4h = aggregate15(w, 16), c2h = aggregate15(w, 8);
                if (c4h.length < 40 || c2h.length < 40) continue;
                const bd = btcMap.get(c[i][0]) || 0, ed = ethMap.get(c[i][0]) || 0;
                const bsc = (breadthMap.get(c[i][0]) || 0) / 2;
                const mkt = mktOf(bd, ed, bsc);
                const r = evaluate(w, c4h, c2h, { sym, btcDir: bd, funding: null, mkt, costPct });
                if (i % 150 === 0) await sleep(0);
                if (!r.signal) { if (r.reason !== 'veri az') funnel[r.reason] = (funnel[r.reason] || 0) + 1; continue; }
                funnel['sinyal'] = (funnel['sinyal'] || 0) + 1;
                const s = r.signal; s.status = 'ACTIVE'; s.mfe = 0; s.mae = 0; s.candles = 0; s.lastPrice = s.entry;
                for (let j = i + 1; j < c.length; j++) { if (advance(s, c[j], CFG.MAX_HOLD_CANDLES)) { if (!isOpen(s)) { s.closedAt = c[j][0] + M15; break; } } }
                if (isOpen(s)) continue;
                trades.push({ symbol: s.symbol, base: s.base, dir: s.dir, setup: s.setup, setupName: s.setupName, score: s.score, time: s.time, closedAt: s.closedAt, netR: s.netR, status: s.status, mkt: s.mkt, mfe: s.mfe });
                busyUntil = Math.max(s.closedAt, s.time + CFG.COOLDOWN_MS);
            }
            btJob.done++;
        }
        trades.sort((a, b) => a.time - b.time);
        const cut = Math.floor(trades.length * 0.7);
        btJob.result = { days, coins, candles, skipped, funnel,
            all: grp(trades), train: grp(trades.slice(0, cut)), test: grp(trades.slice(cut)),
            bySetup: groupBy(trades, s => s.setup + ' ' + s.setupName), byDir: groupBy(trades, s => s.dir),
            byBand: groupBy(trades, band), bySession: groupBy(trades, s => session(s.time)),
            byMkt: groupBy(trades, s => mktName(s)), byExit: groupBy(trades, s => s.status),
            byMfe: groupBy(trades, s => s.mfe < 0.5 ? '1 MFE < 0.5R' : s.mfe < 1 ? '2 MFE 0.5-1R' : s.mfe < 2 ? '3 MFE 1-2R' : '4 MFE 2R+'),
            byCoin: groupBy(trades, s => s.base) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; }
    btJob.running = false;
}

const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v9.4</title>
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
.mk{font-weight:800;font-size:13px}
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
.card.closed{opacity:.72}
.r1{display:flex;align-items:center;gap:8px}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}
.sc{margin-left:auto;font-weight:800;font-size:15px;color:var(--am)}
.pnl-big{font-weight:900;font-size:15px;margin-left:auto;margin-right:4px}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}
.sub b{color:var(--tx);font-weight:700}
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
.pr{display:grid;grid-template-columns:140px 1fr 34px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
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
  <div class="brand">SONER TRADE<small id="modeB">SCALP 15m v9.4</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div>
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
var _btSel={d:30,c:20};
function $(i){return document.getElementById(i)}
function ls(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function ss(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
var journal=ls('st_journal',[]),cfg=ls('st_cfg',{bal:1000,risk:0.5,token:''}),checks=ls('st_checks',{day:'',v:[0,0,0,0,0]});
if(localStorage.getItem('st_btSel')){try{_btSel=JSON.parse(localStorage.getItem('st_btSel'))}catch(e){}}
function saveBtSel(){try{localStorage.setItem('st_btSel',JSON.stringify(_btSel))}catch(e){}}
function fp(p){if(p==null)return '-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){return x==null||isNaN(x)?'-':Number(x).toFixed(d==null?2:d)}
function sg(x,d){x=Number(x);return (x>0?'+':'')+x.toFixed(d==null?2:d)}
function cl(x){return x>0?'up':x<0?'dn':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function trNow(){return new Date(Date.now()+3*3600e3)}
function dayKey(){return trNow().toISOString().slice(0,10)}
function moodOf(){return S&&S.market&&S.market.mood?S.market.mood:null}
function todayJ(){var k=dayKey();return journal.filter(function(j){return j.day===k})}
function pnlR(s){if(!s||!s.lastPrice)return null;return (s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop)}
function gateState(){var t=todayJ(),r=0,i,cons=0,lastLoss=0,md=moodOf();t.forEach(function(j){r+=j.r});
 for(i=t.length-1;i>=0;i--){if(t[i].r<0){cons++;if(!lastLoss)lastLoss=t[i].ts}else break}
 var pauseLeft=lastLoss?Math.ceil((lastLoss+LIM.pause*60000-Date.now())/60000):0;
 if(r<=LIM.loss)return {c:'stop',a:'DUR',b:'Günlük limit doldu ('+sg(r,1)+'R). Bugün bitti.'};
 if(t.length>=LIM.trades)return {c:'stop',a:'DUR',b:'Günlük işlem limiti doldu ('+LIM.trades+').'};
 if(cons>=LIM.cons&&pauseLeft>0)return {c:'stop',a:'MOLA',b:cons+' üst üste stop. '+pauseLeft+' dk bekle.'};
 if(r>=LIM.win)return {c:'wait',a:'YAVAŞLA',b:sg(r,1)+'R hedef doldu.'};
 if(md&&md.label==='YATAY')return {c:'wait',a:'DİKKAT',b:'Piyasa yatay. Sahte hareket riski yüksek.'};
 var dt=md?(md.label==='LONG'?'Piyasa LONG: long kırılımlara bak. ':md.label==='SHORT'?'Piyasa SHORT: short kırılımlara bak. ':''):'';
 return {c:'ok',a:'AÇIK',b:dt+'Bugün '+sg(r,1)+'R, '+t.length+' işlem.'}}
function renderGate(){var d=trNow();$('clock').textContent=('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2)+':'+('0'+d.getUTCSeconds()).slice(-2);
 var g=gateState();$('gate').className='gate '+g.c;$('g1').textContent=g.a;$('g2').textContent=g.b}
function mchip(id,n,m){var e=$(id);if(!m){e.innerHTML='<b>'+n+'</b> -';return}
 var t=m.dir===1?'<span class="up">15m ▲</span>':m.dir===-1?'<span class="dn">15m ▼</span>':'<span class="fl">15m ▬</span>';
 e.innerHTML='<b>'+n+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg,2)+'%</span> '+t}
function renderTop(){if(!S)return;var md=moodOf();
 if(md){var mc=md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl',ar=md.label==='LONG'?' ▲':md.label==='SHORT'?' ▼':' ▬';
  $('cMkt').innerHTML='<b>Piyasa</b> <span class="mk '+mc+'">'+md.label+ar+'</span> <span class="mut">'+md.up+'↑/'+md.down+'↓ (b '+f2(md.breadth,1)+')</span>'}
 else $('cMkt').innerHTML='<b>Piyasa</b> ...';
 mchip('cBTC','BTC',S.market&&S.market.btc);mchip('cETH','ETH',S.market&&S.market.eth);$('modeB').textContent=S.mode}
function openS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT'}
var ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1 alındı','g'],TP2:['TP2 ✓','g'],STOP:['Stop','r'],BE:['Başa baş','w'],TIMEOUT:['Süre doldu','w']};
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function renderTabs(){var oc=S?S.signals.filter(openS).length:0,h='';TABS.forEach(function(t){h+='<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?'<i>'+oc+'</i>':'')+'</button>'});$('tabs').innerHTML=h;
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.getAttribute('data-t');if(tab==='sig'||tab==='radar')sel=null;renderAll()}})}
function sigCard(s){
 var st=ST[s.status]||['?',''],cls='card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed');
 var pnlHtml='', pxHtml='', warn='';
 if(s.warnings&&s.warnings.length)warn='<span class="tag w">'+esc(s.warnings[0])+'</span>';
 var R=pnlR(s);
 if(openS(s)&&R!=null){
   var pcls=R>0?'up':R<0?'dn':'fl';
   pnlHtml='<span class="pnl-big '+pcls+'">'+(R>0?'+':'')+R.toFixed(2)+'R</span>';
   pxHtml='<span>Anlık <b>'+fp(s.lastPrice)+'</b></span>';
 } else if(s.netR!=null){
   var rc=s.netR>0?'up':s.netR<0?'dn':'fl';
   pnlHtml='<span class="pnl-big '+rc+'">'+(s.netR>0?'+':'')+s.netR+'R</span>';
 }
 return '<div class="'+cls+'" data-id="'+s.id+'"><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">GÜÇLÜ '+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+warn+pnlHtml+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span>'+pxHtml+'<span>Stop '+fp(s.stop)+'</span><span>TP1 '+fp(s.tp1)+'</span><span>'+ago(s.time)+' önce</span></div></div>'
}
function radarCard(r){var cls='card'+(sel&&sel.sym===r.symbol?' sel':''),b=r.bias==='LONG'?'<span class="badge L">LONG</span>':r.bias==='SHORT'?'<span class="badge S">SHORT</span>':'<span class="badge" style="color:var(--dm)">-</span>';
 var hb=r.h4Break===1?'4H ▲':r.h4Break===-1?'4H ▼':'4H ▬';
 var h2b=r.h2Break===1?'2H ▲':r.h2Break===-1?'2H ▼':'2H ▬';
 var t15=r.trend15m===1?'15m ▲':r.trend15m===-1?'15m ▼':'15m ▬';
 return '<div class="'+cls+'" data-sym="'+esc(r.symbol)+'"><div class="r1">'+b+'<span class="coin">'+esc(r.base)+'</span><span class="mut">'+fp(r.price)+'</span><span class="'+cl(r.chg24)+'" style="margin-left:auto">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>RSI '+f2(r.rsi,0)+'</span><span>'+hb+'</span><span>'+h2b+'</span><span>'+t15+'</span><span>'+esc(r.state)+'</span></div></div>'}
function renderList(){var L=$('list'),h='';if(!S){L.innerHTML='<div class="note">Yükleniyor...</div>';return}
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return !openS(s)}).slice(0,25);
  if(!a.length)h+='<div class="note" style="padding:10px">Şu an açık sinyal yok. Bot her 15 dakikalık mum kapanışında 4H/2H kırılım + retest + RSI arar.</div>';
  a.forEach(function(s){h+=sigCard(s)});if(c.length)h+='<h3>Kapanan</h3>';c.forEach(function(s){h+=sigCard(s)})}
 else if(tab==='radar'){S.radar.forEach(function(r){h+=radarCard(r)});if(!S.radar.length)h='<div class="note" style="padding:10px">Radar ilk taramadan sonra dolar.</div>'}
 else if(tab==='stat'){h='<div class="note" style="padding:8px">Sağdaki panelde botun geçmiş sinyal sonuçları var.</div>'}
 else if(tab==='jr'){h='<div class="note" style="padding:8px">Kendi işlemlerini sağdaki panelden kaydet.</div>'}
 else{h='<div class="note" style="padding:8px">Testi sağdaki panelden başlat.</div>'}
 L.innerHTML=h;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.getAttribute('data-id'),sy=e.getAttribute('data-sym');
  if(id){var s=S.signals.filter(function(x){return x.id===id})[0];sel={id:id,sym:s.symbol}}else{sel={sym:sy}}chartFor='';renderList();renderMain()}})}
function calc(entry,stop){var bal=Number(cfg.bal)||0,rk=Number(cfg.risk)||0,riskUsd=bal*rk/100,d=Math.abs(entry-stop);if(!d||!bal)return null;
 var qty=riskUsd/d,notional=qty*entry;return {riskUsd:riskUsd,qty:qty,notional:notional,lev:notional/bal}}
function calcBox(entry,stop){var c=entry&&stop?calc(Number(entry),Number(stop)):null;
 return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="mut">Bakiye<br><input id="cBal" type="number" value="'+cfg.bal+'"></label><label class="mut">Risk %<br><input id="cRisk" type="number" step="0.1" value="'+cfg.risk+'"></label><label class="mut">Giriş<br><input id="cE" type="number" step="any" value="'+(entry||'')+'"></label><label class="mut">Stop<br><input id="cS" type="number" step="any" value="'+(stop||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px">'+calcOut(c)+'</div></div>'}
function calcOut(c){return c?'1R = <b>'+f2(c.riskUsd,2)+' USDT</b> &nbsp; Miktar <b>'+f2(c.qty,4)+'</b> &nbsp; Pozisyon <b>'+f2(c.notional,1)+' USDT</b> &nbsp; Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değerleri gir.'}
function bindCalc(){['cBal','cRisk','cE','cS'].forEach(function(id){var e=$(id);if(!e)return;e.oninput=function(){cfg.bal=Number($('cBal').value);cfg.risk=Number($('cRisk').value);ss('st_cfg',cfg);var en=Number($('cE').value),so=Number($('cS').value);$('cOut').innerHTML=calcOut(en&&so?calc(en,so):null)}})}
function checklist(){var k=dayKey();if(checks.day!==k){checks={day:k,v:[0,0,0,0,0]};ss('st_checks',checks)}
 var Q=['4H yönü işlemle aynı mı?','Fiyat kırılan seviyeye yakın mı (retest)?','RSI uygun bölgede mi?','R/R en az 1.5 ve maliyet uygun mu?','Piyasa yönüne ters değil mi, günlük limitim dolmadı mı?'],h='<div class="box chk"><h3 style="margin-top:0">Giriş öncesi kontrol</h3>';
 Q.forEach(function(q,i){h+='<label><input type="checkbox" data-c="'+i+'"'+(checks.v[i]?' checked':'')+'> '+q+'</label>'});return h+'<div class="note">Biri boşsa girme.</div><button class="btn g" id="chkClr">Temizle</button></div>'}
function bindChecklist(){Array.prototype.forEach.call(document.querySelectorAll('[data-c]'),function(e){e.onchange=function(){checks.v[Number(e.getAttribute('data-c'))]=e.checked?1:0;ss('st_checks',checks)}});var b=$('chkClr');if(b)b.onclick=function(){checks.v=[0,0,0,0,0];ss('st_checks',checks);renderMain()}}
function reasonTxt(o){var a=[];for(var k in o)a.push([k,o[k]]);a.sort(function(x,y){return y[1]-x[1]});return a.slice(0,7).map(function(x){return x[0]+' '+x[1]}).join(', ')||'-'}
function homeView(){var t=todayJ(),r=0,w=0,l=0,md=moodOf()||{label:'-',up:0,down:0,flat:0,breadth:0},ml=md.label==='LONG'?'LONG ▲':md.label==='SHORT'?'SHORT ▼':md.label==='YATAY'?'YATAY ▬':'-',mc=md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl';
 t.forEach(function(j){r+=j.r;if(j.r>0)w++;else if(j.r<0)l++});
 var td=S.stats.today,h='<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Piyasa yönü</div><div class="v '+mc+'">'+ml+'</div><div class="k">breadth '+f2(md.breadth,1)+' (15m)</div></div><div class="tile"><div class="k">Benim günüm (R)</div><div class="v '+cl(r)+'">'+sg(r,1)+'</div></div><div class="tile"><div class="k">Benim işlemlerim</div><div class="v">'+t.length+'</div></div><div class="tile"><div class="k">Bot sinyali bugün</div><div class="v">'+td.n+' <span class="mut" style="font-size:12px">ort '+sg(td.avgR,2)+'R</span></div></div><div class="tile"><div class="k">Taranan coin</div><div class="v">'+S.scan.universe+'</div></div></div>';
 h+='<div class="grid2"><div><div class="box"><h3 style="margin-top:0">En yakın kurulumlar</h3><table><tr><th>Coin</th><th>Yön</th><th>4H</th><th>15m</th><th class="n">RSI</th><th>Durum</th></tr>';
 S.radar.slice(0,8).forEach(function(x){h+='<tr><td><b>'+esc(x.base)+'</b></td><td class="'+(x.bias==='LONG'?'up':x.bias==='SHORT'?'dn':'fl')+'">'+(x.bias==='-'?'-':x.bias)+'</td><td>'+(x.h4Break===1?'▲':x.h4Break===-1?'▼':'▬')+'</td><td>'+(x.trend15m===1?'▲':x.trend15m===-1?'▼':'▬')+'</td><td class="n">'+f2(x.rsi,0)+'</td><td class="mut">'+esc(x.state)+'</td></tr>'});
 h+='</table></div>'+checklist()+'</div><div>'+calcBox('','')+'<div class="box"><h3 style="margin-top:0">Tarama özeti</h3><div class="note" style="color:var(--tx)">Son tarama: '+(S.scan.last?ago(S.scan.last)+' önce':'-')+' &nbsp; Süre: '+f2(S.scan.ms/1000,1)+' sn</div><div class="note">Kapsam: '+S.scan.total+' vadeli, '+S.scan.eligible+' hacim geçen, '+S.scan.universe+' taranan, '+S.scan.excluded+' kripto dışı.</div><div class="note">Elenme: '+reasonTxt(S.scan.reasons)+'</div><div class="note">v9.4: BTC/ETH piyasa yönü 15m. Sadece gerçek kripto. Puan '+S.minScore+' ve üstü. SHORT için EMA21 onayı.</div></div></div></div>';
 return h}
function partsView(s){var lab={h4:'4H kırılım',h2:'2H kırılım (onay)',retest:'Retest',rsi:'RSI',mkt:'Piyasa uyumu'},mx={h4:35,h2:30,retest:20,rsi:10,mkt:3},h='';
 for(var k in lab){var v=s.parts[k]||0;h+='<div class="pr"><span>'+lab[k]+'</span><div class="bar"><i style="width:'+Math.max(0,Math.min(100,v/mx[k]*100))+'%;background:'+(v<0?'var(--st)':'var(--am)')+'"></i></div><b class="'+(v<0?'dn':'')+'">'+v+'</b></div>'}return h}
function sigView(s){
 var st=ST[s.status]||['?',''],w='';
 (s.warnings||[]).forEach(function(x){w+='<span class="tag w">'+esc(x)+'</span> '});
 var txt=s.dir+' '+s.base+' | Giriş '+fp(s.entry)+' | Stop '+fp(s.initialStop)+' | TP1 '+fp(s.tp1)+' | TP2 '+fp(s.tp2);
 var R=pnlR(s);
 var h='<div class="r1" style="margin-bottom:8px"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">GÜÇLÜ '+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span><span class="sc" style="font-size:24px">'+s.score+'</span></div>';
 h+='<div class="mut" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce'+(s.netR!=null&&!openS(s)?' • Sonuç '+sg(s.netR,2)+'R':'')+'</div>'+w;
 h+='<canvas id="cv"></canvas>';
 h+='<div class="lv"><div><span>Anlık Fiyat</span><b style="color:#fff;font-size:16px">'+fp(s.lastPrice||s.entry)+'</b></div>'+
    '<div><span>K/Z (R)</span><b class="'+(R>0?'up':R<0?'dn':'fl')+'" style="font-size:16px">'+(R!=null?(R>0?'+':'')+R.toFixed(2)+'R':'-')+'</b></div>'+
    '<div><span>Giriş</span><b>'+fp(s.entry)+'</b></div>'+
    '<div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div>'+
    '<div><span>TP1 (1.5R)</span><b class="up">'+fp(s.tp1)+'</b></div>'+
    '<div><span>TP2 (2R)</span><b class="up">'+fp(s.tp2)+'</b></div>'+
    '<div><span>Risk</span><b>'+f2(s.riskPct,2)+'%</b></div>'+
    '<div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+'R / '+f2(s.mae,1)+'R</b></div></div>';
 h+='<div class="frm"><button class="btn" id="cpy">Kopyala</button><button class="btn g" id="addJ">Günlüğe ekle</button></div><div class="grid2"><div class="box"><h3 style="margin-top:0">Puan dağılımı</h3>'+partsView(s)+'<div class="note">RSI '+f2(s.rsi,0)+' • 4H resistance '+fp(s.h4Res)+' • 4H support '+fp(s.h4Sup)+'</div><div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div></div><div>'+calcBox(s.entry,s.initialStop)+'</div></div>';
 return {h:h,txt:txt,s:s}}
function radarView(sym){var r=S.radar.filter(function(x){return x.symbol===sym})[0];var h='<div class="r1" style="margin-bottom:8px"><h2 style="margin:0">'+esc(sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'</div><canvas id="cv"></canvas>';
 if(r)h+='<div class="lv"><div><span>Fiyat</span><b>'+fp(r.price)+'</b></div><div><span>24s</span><b class="'+cl(r.chg24)+'">'+sg(r.chg24,1)+'%</b></div><div><span>4H kırılım</span><b>'+(r.h4Break===1?'▲ Y':r.h4Break===-1?'▼ A':'▬')+'</b></div><div><span>2H kırılım</span><b>'+(r.h2Break===1?'▲ Y':r.h2Break===-1?'▼ A':'▬')+'</b></div><div><span>15m trend</span><b>'+(r.trend15m===1?'▲ Y':r.trend15m===-1?'▼ A':'▬')+'</b></div><div><span>RSI</span><b>'+f2(r.rsi,0)+'</b></div></div>';
 return h+calcBox('','')}
function tbl(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Ort R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR,2)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>'}
function statView(){var a=S.stats.all,h='<h2>Bot sinyal istatistiği</h2><div class="tiles"><div class="tile"><div class="k">Kapanan sinyal</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Ortalama R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR,2)+'</div></div><div class="tile"><div class="k">Toplam R</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'</div></div><div class="tile"><div class="k">Profit factor</div><div class="v">'+f2(a.pf,2)+'</div></div><div class="tile"><div class="k">Maks. düşüş</div><div class="v dn">'+f2(a.dd,1)+'R</div></div></div><canvas id="eq" style="height:160px"></canvas>';
 h+='<div class="note">Ortalama R pozitif ve işlem sayısı 200+ olunca anlamlı.</div>'+tbl(S.stats.bySetup,'Kurulum')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byMkt,'Piyasa yönü')+tbl(S.stats.byExit,'Çıkış')+tbl(S.stats.byBand,'Puan bandı')+tbl(S.stats.bySession,'Seans')+tbl(S.stats.byHour,'Saat');return h}
function jrView(){var t=todayJ(),r=0,all=0,w=0;t.forEach(function(j){r+=j.r});journal.forEach(function(j){all+=j.r;if(j.r>0)w++});
 var h='<h2>Benim işlem günlüğüm</h2><div class="tiles"><div class="tile"><div class="k">Bugün</div><div class="v '+cl(r)+'">'+sg(r,1)+'R</div></div><div class="tile"><div class="k">Tümü</div><div class="v '+cl(all)+'">'+sg(all,1)+'R</div></div><div class="tile"><div class="k">İşlem</div><div class="v">'+journal.length+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+(journal.length?f2(w/journal.length*100,0):'-')+'%</div></div></div>';
 h+='<div class="box"><div class="frm"><input id="jSym" placeholder="Coin"><select id="jDir"><option>LONG</option><option>SHORT</option></select><input id="jR" type="number" step="0.1" placeholder="R"><input id="jN" placeholder="Not" style="width:200px"><button class="btn" id="jAdd">Kaydet</button></div></div><table><tr><th>Zaman</th><th>Coin</th><th>Yön</th><th class="n">R</th><th>Not</th><th></th></tr>';
 journal.slice().reverse().slice(0,40).forEach(function(j){var d=new Date(j.ts+3*3600e3);h+='<tr><td class="mut">'+d.toISOString().slice(5,16).replace('T',' ')+'</td><td><b>'+esc(j.sym)+'</b></td><td class="'+(j.dir==='LONG'?'up':'dn')+'">'+j.dir+'</td><td class="n '+cl(j.r)+'">'+sg(j.r,1)+'</td><td class="mut">'+esc(j.note||'')+'</td><td><button class="ibtn" data-del="'+j.id+'">Sil</button></td></tr>'});return h+'</table>'}
function bindJr(pre){var b=$('jAdd');if(!b)return;if(pre){$('jSym').value=pre.base;$('jDir').value=pre.dir;$('jN').value=pre.setupName}
 b.onclick=function(){var sy=$('jSym').value.trim().toUpperCase(),r=Number($('jR').value);if(!sy||isNaN(r)||$('jR').value===''){alert('Coin ve R gerekli');return}journal.push({id:Date.now(),ts:Date.now(),day:dayKey(),sym:sy,dir:$('jDir').value,r:r,note:$('jN').value});ss('st_journal',journal);renderAll()};
 Array.prototype.forEach.call(document.querySelectorAll('[data-del]'),function(e){e.onclick=function(){var id=Number(e.getAttribute('data-del'));journal=journal.filter(function(j){return j.id!==id});ss('st_journal',journal);renderAll()}})}
function btView(){var h='<h2>Geçmiş veri testi</h2><div class="box"><div class="frm"><select id="bD"><option value="7"'+(_btSel.d===7?' selected':'')+'>7 gün</option><option value="14"'+(_btSel.d===14?' selected':'')+'>14 gün</option><option value="30"'+(_btSel.d===30?' selected':'')+'>30 gün</option></select><select id="bC"><option value="10"'+(_btSel.c===10?' selected':'')+'>10 coin</option><option value="20"'+(_btSel.c===20?' selected':'')+'>20 coin</option><option value="40"'+(_btSel.c===40?' selected':'')+'>40 coin</option></select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">15m backtest (4H/2H agrege, 15m BTC/ETH piyasa yönü). 30 gün / 40 coin birkaç dakika sürer.</div></div>';
 if(!bt)return h+'<div class="note">Henüz test yok.</div>';
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){var R=bt.result;h+='<div class="tiles"><div class="tile"><div class="k">Toplam işlem</div><div class="v">'+R.all.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(R.all.win*100,0)+'%</div></div><div class="tile"><div class="k">Ort R (net)</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR,2)+'</div></div><div class="tile"><div class="k">Test bloğu ort R</div><div class="v '+cl(R.test.avgR)+'">'+sg(R.test.avgR,2)+'</div><div class="k">'+R.test.n+' işlem</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(R.all.pf,2)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(R.all.dd,1)+'R</div></div></div><div class="note">'+R.days+' gün / '+R.coins+' coin / '+R.candles+' mum. Atlanan: '+(R.skipped.length?esc(R.skipped.join(', ')):'yok')+'.</div><div class="note">Filtre hunisi: '+reasonTxt(R.funnel)+'</div>'+tbl(R.byExit,'Çıkış')+tbl(R.byMfe,'MFE')+tbl(R.bySetup,'Kurulum')+tbl(R.byDir,'Yön')+tbl(R.byMkt,'Piyasa')+tbl(R.bySession,'Seans')+tbl(R.byBand,'Puan bandı')+tbl(R.byCoin,'Coin')}
 return h}
function bindBt(){var selD=$('bD'),selC=$('bC');
 if(selD)selD.onchange=function(){_btSel.d=Number(selD.value);saveBtSel()};
 if(selC)selC.onchange=function(){_btSel.c=Number(selC.value);saveBtSel()};
 var b=$('bGo');if(!b)return;
 b.onclick=function(){var hd={'Content-Type':'application/json'};if(cfg.token)hd['x-admin-token']=cfg.token;
  fetch('/api/backtest',{method:'POST',headers:hd,body:JSON.stringify({days:Number(selD.value),coins:Number(selC.value)})})
   .then(function(r){if(r.status===401){var t=prompt('Admin şifresi:');if(t){cfg.token=t;ss('st_cfg',cfg)}return null}return r.json()})
   .then(function(){pollBt()})}}
function pollBt(){fetch('/api/backtest').then(function(r){return r.json()}).then(function(d){bt=d;var ae=document.activeElement,tag=ae&&ae.tagName;if(tag!=='SELECT'&&tag!=='INPUT'){if(tab==='bt')renderMain()}if(d.running)setTimeout(pollBt,3000)})}
function drawEq(){var c=$('eq');if(!c||!S.equity.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);var v=S.equity,mn=Math.min(0,Math.min.apply(null,v)),mx=Math.max(0.1,Math.max.apply(null,v)),Y=function(a){return H-10-(a-mn)/(mx-mn)*(H-20)};
 x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach(function(a,i){var px=i/Math.max(1,v.length-1)*(W-8)+4;if(i)x.lineTo(px,Y(a));else x.moveTo(px,Y(a))});x.stroke()}
function drawChart(d,s){var c=$('cv');if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);
 var L=8,R=74,T=12,B=18,n=d.c.length,PW=W-L-R,PH=H-T-B,hi=-1e99,lo=1e99,i;for(i=0;i<n;i++){hi=Math.max(hi,d.c[i][2]);lo=Math.min(lo,d.c[i][3])}
 var lv=[];if(s){lv=[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.initialStop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ'],[s.level,'#f2b84b','KIRILIM']];lv.forEach(function(a){if(a[0])hi=Math.max(hi,a[0]),lo=Math.min(lo,a[0])})}
 var pad=(hi-lo)*0.05;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH},X=function(k){return L+(k+0.5)/n*PW},cw=Math.max(2,PW/n*0.68);
 x.strokeStyle='rgba(255,255,255,.05)';for(i=0;i<=4;i++){var gy=T+PH*i/4;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillStyle='#8593a5';x.font='10px system-ui';x.textAlign='left';x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 function line(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;for(var k=0;k<Math.min(arr.length,n);k++){if(arr[k]==null)continue;if(!st){x.moveTo(X(k),Y(arr[k]));st=true}else x.lineTo(X(k),Y(arr[k]))}x.stroke()}
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 for(i=0;i<n;i++){var k=d.c[i],up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();var y1=Y(k[1]),y2=Y(k[4]);x.fillRect(X(i)-cw/2,Math.min(y1,y2),cw,Math.max(1,Math.abs(y2-y1)))}
 lv.forEach(function(a){x.strokeStyle=a[1];x.lineWidth=1.5;x.setLineDash(a[2]==='GİRİŞ'?[]:[5,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.fillStyle=a[1];x.font='bold 10px system-ui';x.fillText(a[2],W-R+6,Y(a[0])-3)});
 var livePrice=s&&s.lastPrice?s.lastPrice:d.c[n-1][4];
 x.strokeStyle='#ffffff';x.lineWidth=2;x.setLineDash([2,3]);x.beginPath();x.moveTo(L,Y(livePrice));x.lineTo(W-R,Y(livePrice));x.stroke();x.setLineDash([]);
 x.fillStyle='#fff';x.font='bold 11px system-ui';x.textAlign='left';x.fillText('ANLIK '+fp(livePrice),L+4,Y(livePrice)-4);
 if(s){var R2=(s.dir==='LONG'?1:-1)*(livePrice-s.entry)/Math.abs(s.entry-s.initialStop);var pcol=R2>0?'#3ddc97':R2<0?'#ff6b7a':'#8593a5';
   x.fillStyle=pcol;x.font='bold 15px system-ui';x.textAlign='right';x.fillText((R2>0?'+':'')+R2.toFixed(2)+'R',W-R-6,T+20);
   x.font='10px system-ui';x.fillStyle='#8593a5';x.fillText('K/Z',W-R-6,T+34);x.textAlign='left';}
 x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText('15m • sarı EMA21 • gri EMA50',L+4,H-5)}
function loadChart(sym){if(!sym)return;fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(d){chartCache[sym]=d;if(sel&&sel.sym===sym){var s2=sel.id?S.signals.filter(function(x){return x.id===sel.id})[0]:null;drawChart(d,s2)}}).catch(function(){})}
function renderMain(){var M=$('main');if(!S){M.innerHTML='';return}var pre=null;
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='jr'){M.innerHTML=jrView();bindJr();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){var s=S.signals.filter(function(x){return x.id===sel.id})[0];if(s){var v=sigView(s);M.innerHTML=v.h;pre=s;$('cpy').onclick=function(){try{navigator.clipboard.writeText(v.txt);$('cpy').textContent='Kopyalandı'}catch(e){prompt('Kopyala:',v.txt)}};$('addJ').onclick=function(){tab='jr';renderAll();bindJr(pre)};bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol)}return}}
 if(sel&&sel.sym){M.innerHTML=radarView(sel.sym);bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym)}return}
 M.innerHTML=homeView();bindCalc();bindChecklist()}
function renderAll(){renderTop();renderTabs();renderList();renderMain();renderGate()}
function beep(){try{var a=new (window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.15;o.start();o.stop(a.currentTime+.25)}catch(e){}}
function apply(d){
  if(!d)return;
  S=d;
  var fresh=[];
  d.signals.forEach(function(s){
    if(openS(s)&&!seenIds[s.id]){seenIds[s.id]=1;if(!firstLoad)fresh.push(s)}
    else if(!seenIds[s.id])seenIds[s.id]=1;
  });
  if(fresh.length&&soundOn){
    beep();
    try{
      if(Notification.permission==='granted')new Notification('GÜÇLÜ '+fresh[0].dir+' '+fresh[0].base,{body:'Giriş '+fp(fresh[0].entry)+' Stop '+fp(fresh[0].initialStop)+' Puan '+fresh[0].score});
    }catch(e){}
  }
  firstLoad=false;
  var ae=document.activeElement,tag=ae&&ae.tagName;
  if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'){renderTop();renderTabs();renderList();renderGate();return}
  renderAll();
}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){apply(d);$('dot').className='dot on';$('conn').textContent='Bağlı'}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
$('bSound').onclick=function(){soundOn=!soundOn;this.className='ibtn'+(soundOn?' on':'');this.textContent=soundOn?'Bildirim açık':'Bildirim kapalı';if(soundOn){beep();try{Notification.requestPermission()}catch(e){}}};
window.addEventListener('resize',function(){if(S)renderMain()});
setInterval(renderGate,1000);setInterval(poll,5000);setInterval(function(){if(sel&&sel.sym)loadChart(sel.sym)},20000);
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
        if (u.pathname === '/health') return json(res, 200, { ok: true, lastScan: scan.last, universe: universe.length });
        if (u.pathname === '/api/state') return json(res, 200, apiState());
        if (u.pathname === '/api/candles') return json(res, 200, await apiCandles(u.searchParams.get('symbol') || ''));
        if (u.pathname === '/api/backtest' && req.method === 'GET') return json(res, 200, btJob);
        if (u.pathname === '/api/backtest' && req.method === 'POST') {
            if (!authed(req)) return json(res, 401, { error: 'yetkisiz' });
            const b = await body(req);
            const days = [7, 14, 30].includes(b.days) ? b.days : 30;
            const coins = [10, 20, 40].includes(b.coins) ? b.coins : 20;
            if (!btJob.running) runBacktest(days, coins);
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!ADMIN_TOKEN || !authed(req)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; dirty = true; saveState(); return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse(); await refreshFunding();
        setInterval(refreshUniverse, CFG.UNIVERSE_MS); setInterval(refreshFunding, CFG.FUNDING_MS);
        setInterval(track, CFG.TRACK_MS); setInterval(refreshTickers, 15e3); setInterval(saveState, 15e3); setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - CFG.SCAN_DELAY_MS) / M15); if (slot > lastScanSlot) { lastScanSlot = slot; runScan(); } }, 5000);
        log('SONER TRADE v9.4 hazır — BTC/ETH 15m, MIN_SCORE 90, SHORT EMA21 onaylı');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { evaluate, breakoutInfo, trendOfTF, advance, calcStats, aggregate15, mktOf, CFG, _set: o => Object.assign(CFG, o) };
