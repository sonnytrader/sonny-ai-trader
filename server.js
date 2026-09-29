'use strict';
// ============================================================
// SOL SCALPER v1.1
// v1.0 -> v1.1:
//  * FIX: obOk scope hatası (build dışına tanımlandı)
//  * FIX: trends[sym] hesaplanmıyordu (breadth 0↑/0↓) -> EMA21/50 eklendi
//  * Frontend v9.12 stiline çevrildi (zengin üst çubuk, aynı renkler)
//  * Health box + entry advice v9.12 stili
//  * Grafik etiket çakışma önleme
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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const M15 = 15 * 60e3, H1 = 3600e3, H2 = 2 * H1, H4 = 4 * H1;

const NON_CRYPTO = [
    'USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','MIM','LUSD','GUSD','USDF','BUIDL','USTC','USDP','USDL','EURS','USDR','SUSD',
    'WBTC','WETH','WSTETH','STETH','RETH','CBETH','SFRXETH','WBNB','WAVAX','WMATIC',
    'PAXG','XAUT','XAU','XAG','XPT','XPD','GOLD','SILVER','OIL','WTI','BRENT','CL','BZ','NG','XAUUSD','XAGUSD',
    'AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','CRM','ADBE','NFLX','DIS','IBM','CSCO','QCOM','TXN','AVGO','MU','PYPL','SQ','SHOP','SPOT','NOW','SNOW','PLTR','UBER','ABNB','DASH','ZOOM','DOCU','OKTA','TWLO','CRWD','ZS','PANW','FTNT','MDB','NET','DDOG',
    'JPM','BAC','WFC','GS','MS','C','V','MA','BRK','SCHW','BLK','AXP','USB','PNC','TFC','COF','BK','STT','MET','PRU','AIG','ALL','TRV','CB','PGR',
    'WMT','COST','KO','PEP','MCD','NKE','SBUX','HD','TGT','LOW','BA','CAT','GE','MMM','DE','HON','LMT','RTX','NOC','GD','UPS','FDX','DAL','UAL','AAL','LUV','F','GM','RIVN','LCID','NIO','XPEV','LI',
    'JNJ','PFE','MRK','ABBV','LLY','BMY','AMGN','GILD','BIIB','REGN','VRTX','MRNA','UNH','CVS','CI','HUM','HCA','MDT','ABT','SYK','BSX','ZBH','BDX',
    'COIN','HOOD','CRCL','MSTR','MARA','RIOT','CLSK','BTBT','HUT','BITF','CORZ','WULF','IREN','GLXY',
    'BABA','JD','PDD','BIDU','TCOM','NTES','TME','BILI','IQ','VIPS','EDU','YUMC',
    'SPY','QQQ','SPCX','SNXX','SOXL','SOXS','SNDK','SKHY','DIA','IWM','VTI','VOO','ARKK','TQQQ','SQQQ','SPXU','UPRO','SPXL','LABU','LABD','FNGU','FNGD','JNUG','JDST','NUGT','DUST','UVXY','SVXY','VXX','VIXY',
    'MOONSHOT','MSTX','MSTU','MSTZ','CONL','NVDU','NVDS','TSLL','TSLQ','TSLS','AAPU','AAPD','MSFU','MSFD','AMZU','AMZD','METU','METD','GGLL','GGLS','NFXL','NFXS','BABX','BABU','BABD',
    'OPENAI','ANTHROPIC','SPACEX','STARLINK','XAI','GROK','NEURALINK','STRIPE','DATABRICKS',
    'CIIG','DXYZ','ARM','SMCI','GME','AMC','BB','NOK','ERIC','SONY','TM','HMC','STLA','RACE','FERRARI','MC','LVMH','NVS','AZN','SNY','GSK','NVO','TAK','SAN','BTI','MO','PM','UL','UN','PG','CL','KMB','GIS','K','HSY','STZ','BUD','TAP','SAM','MNST','KDP','CELH',
    'EUR','GBP','JPY','CHF','AUD','CAD','NZD','CNH','CNY','HKD','SGD','MXN','BRL','ZAR','TRY','INR','KRW','RUB','DXY','USDX','USOIL','UKOIL',
    'VIX','NASDAQ','DOW','SPX','NIKKEI','DAX','FTSE','HSI','CAC','STOXX','MSCI','EEM','EFA','VEA','VWO',
    'ROKU','WBD','PARA','FOX','FOXA','NWSA','NWS','LYV','MTCH','IAC','TRIP','EXPE','BKNG','MAR','HLT','RCL','CCL','NCLH','MGM','LVS','WYNN','CZR','PENN','DKNG','FLUT',
    'SAMSUNG','SKHYNIX','HYNIX','DRAM','KORU','CBRS','USAR'
];

const CFG = {
    EMA_FAST: 9,
    EMA_SLOW: 21,
    EMA_TREND: 50,
    EMA_REGIME: 200,
    RSI_PERIOD: 14,
    RSI_SMOOTH: 5,
    RSI_LONG_MIN: 45, RSI_LONG_MAX: 65,
    RSI_SHORT_MIN: 35, RSI_SHORT_MAX: 55,
    VOLUME_LOOKBACK: 20,
    VOLUME_SURGE: 1.3,
    VWAP_LOOKBACK: 96,
    ORDER_BLOCK_LOOKBACK: 20,
    FUNDING_MAX_LONG: 0.0001,
    FUNDING_MIN_SHORT: -0.0001,
    
    STOP_ATR_MULT: 1.5,
    TP1_R: 1.5,
    TP2_R: 2.5,
    MIN_RISK_PCT: 0.3,
    MAX_RISK_PCT: 3.0,
    COST_PCT: 0.12,
    MAX_COST_R: 0.40,
    COST_MULT: num('COST_MULT', 1),
    MAX_HOLD_MS: 48 * H1,
    
    UNIVERSE: num('UNIVERSE', 300),
    MIN_VOL_USDT: num('MIN_VOL', 5e5),
    FLAT_MAX: num('FLAT_MAX', 0.15),
    MIN_LISTING_DAYS: num('MIN_LISTING_DAYS', 14),
    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),
    CANDLES_15M: 500,
    CANDLES_1H: 200,
    CANDLES_4H: 100,
    
    BLOCK_COUNTER_MKT: flag('BLOCK_COUNTER_MKT', true),
    BLOCK_ASIA: flag('BLOCK_ASIA', false),
    ASIA_END_UTC: num('ASIA_END_UTC', 7),
    REQUIRE_ORDER_BLOCK: flag('REQUIRE_OB', true),
    REQUIRE_FUNDING: flag('REQUIRE_FUNDING', false),
    REQUIRE_1H_ALIGN: flag('REQUIRE_1H', true),
    REQUIRE_VWAP: flag('REQUIRE_VWAP', true),
    REQUIRE_REGIME: flag('REQUIRE_REGIME', true),
    
    COOLDOWN_MS: 30 * 60e3,
    MAX_OPEN_PER_DIR: 3,
    MAX_PER_SCAN: 3,
    MAX_SIGNAL_AGE_MS: 15 * 60e3,
    CONCURRENCY: 6,
    KEEP: 500,
    HTF_CACHE_MS: 3 * 60e3,
    
    BT_SLEEP_PER_COIN: num('BT_SLEEP_PER_COIN', 400),
    BT_MAX_RETRY: num('BT_MAX_RETRY', 5)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const log = (...a) => console.log('[SOL]', ...a);
const baseOf = s => s.split('/')[0];
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const trHour = t => String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00';
const session = t => { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya (03-10 TR)' : h < 13 ? '2 Londra (10-16 TR)' : h < 21 ? '3 ABD (16-00 TR)' : '4 Gece (00-03 TR)'; };
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.40; };
const flatRatio = c => { const a = c.slice(-96); let f = 0; for (const x of a) if (x[2] === x[3] || !x[5]) f++; return a.length ? f / a.length : 1; };
const mktOf = (bd, ed, bsc) => { const s = 2 * (bd || 0) + (ed || 0) + (bsc || 0); return s >= 2 ? 1 : s <= -2 ? -1 : 0; };
const breadthScore = (up, dn, n) => n > 0 ? ((up - dn) / n) * 4 : 0;

// ==================== İNDİKATÖRLER ====================
function emaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let e = 0; for (let i = 0; i < p; i++) e += v[i]; e /= p; out[p - 1] = e;
    const k = 2 / (p + 1);
    for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
}
function rsiSeries(closes, p = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= p) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p;
    out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * (p - 1) + Math.max(d, 0)) / p;
        l = (l * (p - 1) + Math.max(-d, 0)) / p;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
}
function smaSeries(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
        sum += v[i];
        if (i >= p) sum -= v[i - p];
        if (i >= p - 1) out[i] = sum / p;
    }
    return out;
}
const trueRange = (c, i) => Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
function atrLast(c, p = 14) {
    if (c.length < p + 1) return null;
    let a = 0; for (let i = 1; i <= p; i++) a += trueRange(c, i); a /= p;
    for (let i = p + 1; i < c.length; i++) a = (a * (p - 1) + trueRange(c, i)) / p;
    return a;
}
function vwap(c, lookback = 96) {
    const slice = c.slice(-lookback);
    let pv = 0, v = 0;
    for (const x of slice) {
        const tp = (x[2] + x[3] + x[4]) / 3;
        pv += tp * x[5]; v += x[5];
    }
    return v > 0 ? pv / v : null;
}
function trend15(cl) {
    if (cl.length < 60) return 0;
    const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50);
    const last = cl.length - 1;
    if (e21[last] == null || e50[last] == null) return 0;
    return e21[last] > e50[last] ? 1 : e21[last] < e50[last] ? -1 : 0;
}

// ==================== ORDER BLOCK ====================
function findOrderBlocks(c15, lookback = 20) {
    const n = c15.length;
    if (n < lookback + 5) return { bullishOB: null, bearishOB: null };
    const slice = c15.slice(-lookback);
    let avgVol = 0; for (const x of slice) avgVol += x[5]; avgVol /= slice.length;
    let bullishOB = null, bearishOB = null;
    for (let i = slice.length - 2; i >= 1; i--) {
        const cur = slice[i];
        const range = cur[2] - cur[3];
        const body = Math.abs(cur[4] - cur[1]);
        const bodyRatio = range > 0 ? body / range : 0;
        const volX = avgVol > 0 ? cur[5] / avgVol : 1;
        if (cur[4] < cur[1] && bodyRatio >= 0.5 && volX >= 1.5 && !bullishOB) {
            const next = slice[i + 1];
            if (next && next[4] > cur[2]) bullishOB = { low: cur[3], high: cur[1], mid: (cur[3] + cur[1]) / 2 };
        }
        if (cur[4] > cur[1] && bodyRatio >= 0.5 && volX >= 1.5 && !bearishOB) {
            const next = slice[i + 1];
            if (next && next[4] < cur[3]) bearishOB = { low: cur[4], high: cur[2], mid: (cur[4] + cur[2]) / 2 };
        }
    }
    return { bullishOB, bearishOB };
}
function nearOB(price, ob, tolerancePct = 0.3) {
    if (!ob) return false;
    const dist = Math.abs(price - ob.mid) / ob.mid * 100;
    return dist <= tolerancePct;
}

// ==================== DEĞERLENDİRME ====================
function evaluate(c15, c1h, c4h, ctx) {
    const C = ctx.cfg || CFG;
    if (c15.length < 250 || c1h.length < 60) return { signal: null, radar: null, reason: 'veri az' };

    const closes = c15.map(x => x[4]);
    const vols = c15.map(x => x[5]);
    
    const ema9 = emaSeries(closes, C.EMA_FAST);
    const ema21 = emaSeries(closes, C.EMA_SLOW);
    const ema50 = emaSeries(closes, C.EMA_TREND);
    const ema200 = emaSeries(closes, C.EMA_REGIME);
    
    const rsiRaw = rsiSeries(closes, C.RSI_PERIOD);
    const rsiClean = rsiRaw.filter(v => v !== null);
    const rsiSmooth = smaSeries(rsiClean, C.RSI_SMOOTH);
    
    const c1hCloses = c1h.map(x => x[4]);
    const ema50_1h = emaSeries(c1hCloses, C.EMA_TREND);
    
    const n = c15.length - 1;
    const price = closes[n];
    const e9 = ema9[n], e21 = ema21[n], e50 = ema50[n], e200 = ema200[n];
    const e50_1h = ema50_1h[ema50_1h.length - 1];
    const rv = rsiSmooth[rsiSmooth.length - 1];
    
    if (!e9 || !e21 || !e50 || !e200 || !rv) return { signal: null, radar: null, reason: 'veri az' };
    
    const prevE9 = ema9[n - 1], prevE21 = ema21[n - 1];
    const crossUp = prevE9 != null && prevE21 != null && prevE9 <= prevE21 && e9 > e21;
    const crossDown = prevE9 != null && prevE21 != null && prevE9 >= prevE21 && e9 < e21;
    
    const avgVol = vols.slice(-C.VOLUME_LOOKBACK - 1, -1).reduce((a, b) => a + b, 0) / C.VOLUME_LOOKBACK;
    const volX = avgVol > 0 ? vols[n] / avgVol : 1;
    const vw = vwap(c15, C.VWAP_LOOKBACK);
    const atr = atrLast(c15.slice(-60), 14);
    if (!atr) return { signal: null, radar: null, reason: 'veri az' };
    
    const obs = findOrderBlocks(c15, C.ORDER_BLOCK_LOOKBACK);
    
    const radar = {
        symbol: ctx.sym, base: baseOf(ctx.sym), price, rsi: rv,
        ema9: e9, ema21: e21, ema50: e50, ema200: e200,
        volX: Number(volX.toFixed(2)), vwap: vw, atr,
        bias: '-', state: 'Bekliyor', score: 0,
        chg24: 0, funding: ctx.funding,
        trend15m: e9 > e21 ? 1 : e9 < e21 ? -1 : 0,
        regim: price > e200 ? 'UP' : 'DOWN',
        trend1h: e50_1h && price > e50_1h ? 1 : -1,
        hasOB: !!(obs.bullishOB || obs.bearishOB)
    };

    let dir = null, reason = '';
    let obOk = false;   // ★ FIX: build dışına taşındı

    if (crossUp) {
        radar.bias = 'LONG';
        radar.state = 'EMA kesişim';
        const checks = [];
        if (price < e50) checks.push('ema50');
        if (C.REQUIRE_REGIME && price < e200) checks.push('regim');
        if (rv < C.RSI_LONG_MIN || rv > C.RSI_LONG_MAX) checks.push('rsi');
        if (volX < C.VOLUME_SURGE) checks.push('hacim');
        if (C.REQUIRE_1H_ALIGN && (!e50_1h || price < e50_1h)) checks.push('1h');
        if (C.REQUIRE_VWAP && vw && price < vw) checks.push('vwap');
        obOk = !C.REQUIRE_ORDER_BLOCK || nearOB(price, obs.bullishOB, 0.4);
        if (!obOk) checks.push('ob');
        if (C.REQUIRE_FUNDING && ctx.funding != null && ctx.funding > C.FUNDING_MAX_LONG) checks.push('funding');
        if (C.BLOCK_COUNTER_MKT && ctx.mkt === -1) checks.push('piyasa ters');
        if (checks.length === 0) { dir = 'LONG'; reason = 'EMA9/21 ↑ + trend + rejim + RSI + hacim'; }
        else radar.state = 'Elendi: ' + checks.join(', ');
    }
    
    if (!dir && crossDown) {
        radar.bias = 'SHORT';
        radar.state = 'EMA kesişim';
        const checks = [];
        if (price > e50) checks.push('ema50');
        if (C.REQUIRE_REGIME && price > e200) checks.push('regim');
        if (rv < C.RSI_SHORT_MIN || rv > C.RSI_SHORT_MAX) checks.push('rsi');
        if (volX < C.VOLUME_SURGE) checks.push('hacim');
        if (C.REQUIRE_1H_ALIGN && (!e50_1h || price > e50_1h)) checks.push('1h');
        if (C.REQUIRE_VWAP && vw && price > vw) checks.push('vwap');
        obOk = !C.REQUIRE_ORDER_BLOCK || nearOB(price, obs.bearishOB, 0.4);   // ★ FIX: const kaldırıldı
        if (!obOk) checks.push('ob');
        if (C.REQUIRE_FUNDING && ctx.funding != null && ctx.funding < C.FUNDING_MIN_SHORT) checks.push('funding');
        if (C.BLOCK_COUNTER_MKT && ctx.mkt === 1) checks.push('piyasa ters');
        if (checks.length === 0) { dir = 'SHORT'; reason = 'EMA9/21 ↓ + trend + rejim + RSI + hacim'; }
        else radar.state = 'Elendi: ' + checks.join(', ');
    }

    if (!dir) return { signal: null, radar, reason: radar.bias === '-' ? 'kesişim yok' : 'filtre' };

    const L = dir === 'LONG', side = L ? 1 : -1;
    const entry = price;
    const stop = L ? entry - C.STOP_ATR_MULT * atr : entry + C.STOP_ATR_MULT * atr;
    const risk = Math.abs(entry - stop);
    const riskPct = risk / entry * 100;
    
    if (riskPct < C.MIN_RISK_PCT) return { signal: null, radar, reason: 'stop dar' };
    if (riskPct > C.MAX_RISK_PCT) return { signal: null, radar, reason: 'stop geniş' };
    
    const costPct = ctx.costPct != null ? ctx.costPct : CFG.COST_PCT;
    const costR = costPct / riskPct;
    if (costR > C.MAX_COST_R) return { signal: null, radar, reason: 'maliyet' };
    
    const tp1 = L ? entry + risk * C.TP1_R : entry - risk * C.TP1_R;
    const tp2 = L ? entry + risk * C.TP2_R : entry - risk * C.TP2_R;
    
    let score = 60;
    const parts = {};
    parts.ema = crossUp || crossDown ? 15 : 0; score += parts.ema;
    parts.trend = (price > e50 && L) || (price < e50 && !L) ? 10 : 0; score += parts.trend;
    parts.regim = (price > e200 && L) || (price < e200 && !L) ? 10 : 0; score += parts.regim;
    parts.rsi = (L && rv >= 50 && rv <= 60) || (!L && rv >= 40 && rv <= 50) ? 10 : 0; score += parts.rsi;
    parts.vol = volX >= 2.0 ? 10 : volX >= 1.5 ? 5 : 0; score += parts.vol;
    parts.ob = obOk ? 5 : 0; score += parts.ob;
    parts.vwap = vw && ((L && price > vw) || (!L && price < vw)) ? 5 : 0; score += parts.vwap;
    parts.h1 = e50_1h && ((L && price > e50_1h) || (!L && price < e50_1h)) ? 5 : 0; score += parts.h1;
    score = Math.min(100, score);
    
    const warnings = [];
    if (ctx.mkt === -side) warnings.push('Piyasa ters');

    const sig = {
        symbol: ctx.sym, base: baseOf(ctx.sym), dir,
        setup: 'SOL', setupName: 'EMA 9/21 + Multi-Filter',
        score, parts, warnings,
        entry, stop, initialStop: stop, tp1, tp2, tp1R: C.TP1_R, tp2R: C.TP2_R,
        riskPct, costR, volX, adx: 0, atr, body: 0, rsi: rv, funding: ctx.funding,
        ema9: e9, ema21: e21, ema50: e50, ema200: e200,
        vwap: vw, ob: L ? obs.bullishOB : obs.bearishOB,
        time: c15[n][0] + M15, candleT: c15[n][0],
        lastPrice: entry, mfe: 0, mae: 0,
        reason: reason + ' | RSI ' + rv.toFixed(0) + ' | hacim ' + volX.toFixed(1) + 'x'
    };
    
    return { signal: sig, radar: Object.assign(radar, { state: 'GÜÇLÜ ' + dir, score: score }), reason: 'sinyal' };
}

// ==================== TAKİP ====================
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';
function rOf(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t) { s.status = status; s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }

function advance(s, k) {
    const L = s.dir === 'LONG', risk = Math.abs(s.entry - s.initialStop);
    const T1 = s.tp1R || CFG.TP1_R, T2 = s.tp2R || CFG.TP2_R;
    const hiR = L ? (k[2] - s.entry) / risk : (s.entry - k[3]) / risk;
    const loR = L ? (k[3] - s.entry) / risk : (s.entry - k[2]) / risk;
    s.mfe = Math.max(s.mfe || 0, hiR); s.mae = Math.min(s.mae || 0, loR);
    s.lastPrice = k[4];
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    const el = k[0] - s.time;
    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', -1, k[0] + 60e3); return true; }
        if (L ? k[2] >= s.tp1 : k[3] <= s.tp1) { s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, 'BE', 0.5 * T1, k[0] + 60e3); return true; }
        if (L ? k[2] >= s.tp2 : k[3] <= s.tp2) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * T2, k[0] + 60e3); return true; }
    }
    if (el >= CFG.MAX_HOLD_MS && isOpen(s)) {
        const r = rOf(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * T1 + 0.5 * r : r, k[0] + 60e3); return true;
    }
    return false;
}

// ==================== SAĞLIK SKORU ====================
function signalHealth(s, livePrice) {
    if (!isOpen(s)) return null;
    const risk = Math.abs(s.entry - s.initialStop);
    if (!risk) return null;
    const L = s.dir === 'LONG';
    const price = livePrice || s.lastPrice || s.entry;
    const R = (L ? 1 : -1) * (price - s.entry) / risk;
    const el = Date.now() - s.time;
    const mfe = s.mfe || 0;
    const mae = s.mae || 0;
    const hAge = el / H1;
    let score = 50;
    const reasons = [];
    if (R >= 1) { score += 30; reasons.push('Kâr +1R+'); }
    else if (R >= 0.5) { score += 20; reasons.push('Kârda'); }
    else if (R >= 0.2) { score += 10; }
    else if (R >= -0.2) { }
    else if (R >= -0.5) { score -= 15; reasons.push('Zarar büyüyor'); }
    else if (R >= -0.8) { score -= 25; reasons.push('Stop yakın'); }
    else { score -= 40; reasons.push('Stop tehlikede'); }
    if (mfe > 0.3) { const pull = mfe - R; if (pull > 0.5) { score -= 20; reasons.push('Momentum kaybı'); } }
    if (hAge > 1 && mfe < 0.3) { score -= 15; reasons.push('İlerleme yok'); }
    if (hAge > 4 && R < 0.3) { score -= 25; reasons.push('4 saat geçti'); }
    if (hAge > 12 && R < 0.5) { score -= 15; reasons.push('12 saat geçti'); }
    score = Math.max(0, Math.min(100, score));
    let status, color, advice;
    if (score >= 75) { status = 'GÜÇLÜ TUT'; color = 'g'; advice = 'Trend güçlü, tut.'; }
    else if (score >= 60) { status = 'TUT'; color = 'g'; advice = 'İzlemeye devam.'; }
    else if (score >= 45) { status = 'DİKKAT'; color = 'w'; advice = 'Yakından izle.'; }
    else if (score >= 30) { status = 'ZAYIF'; color = 'w'; advice = 'Manuel çıkış düşün.'; }
    else { status = 'ÇIK'; color = 'r'; advice = 'Hemen kapat.'; }
    return { score, status, color, advice, reason: reasons.slice(0, 2).join(' • ') || 'Normal seyir', R: Number(R.toFixed(2)), mfe: Number(mfe.toFixed(2)), mae: Number(mae.toFixed(2)), hAge: Number(hAge.toFixed(2)) };
}

function entryAdvice(s) {
    const risk = Math.abs(s.entry - s.initialStop);
    if (!risk) return null;
    const age = Date.now() - s.time;
    const minAge = age / 60000;
    const price = s.lastPrice || s.entry;
    const L = s.dir === 'LONG';
    const drift = (L ? 1 : -1) * (price - s.entry) / risk;
    if (minAge < 2 && Math.abs(drift) < 0.1) return { status: 'GİR', color: 'g', reason: 'Taze sinyal' };
    if (minAge < 5 && drift > -0.1 && drift < 0.3) return { status: 'GİR', color: 'g', reason: 'Girişe yakın' };
    if (drift > 0.5) return { status: 'KAÇIRILDI', color: 'w', reason: 'Fiyat uzaklaştı' };
    if (drift < -0.3) return { status: 'GİRME', color: 'r', reason: 'Ters hareket' };
    if (minAge > 15) return { status: 'GEÇ', color: 'w', reason: 'Sinyal eski' };
    return { status: 'GİR', color: 'g', reason: 'Uygun' };
}

// ==================== İSTATİSTİK ====================
function grp(list) {
    const n = list.length; if (!n) return { n: 0, win: 0, avgR: 0, totalR: 0, pf: 0, dd: 0 };
    let tot = 0, w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0;
    for (const s of list) { tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR; eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
    return { n, win: w / n, avgR: tot / n, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 90 ? '90-100' : s.score >= 80 ? '80-89' : s.score >= 70 ? '70-79' : '60-69';
const mktName = s => s.mkt === 1 ? 'Piyasa LONG' : s.mkt === -1 ? 'Piyasa SHORT' : 'Piyasa YATAY';

function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return { all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)),
        bySetup: groupBy(sorted, s => s.setupName), byDir: groupBy(sorted, s => s.dir),
        byBand: groupBy(sorted, band), bySession: groupBy(sorted, s => session(s.time)),
        byMkt: groupBy(sorted, mktName), byExit: groupBy(sorted, s => s.status),
        byHour: groupBy(sorted, s => trHour(s.time)) };
}

// ==================== DURUM ====================
const ex = new ccxt.bitget({ enableRateLimit: true, rateLimit: 200, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, universe = [], tickers = {}, fundingMap = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, reasonDay: '', total: 0, eligible: 0, excluded: 0, suspect: 0 }, dirty = false, lastScanSlot = 0, btcCtx = { dir: 0 };
let mktDir = 0, nonCrypto = new Set(), nonCryptoAt = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const htfCache = new Map();
const candleCache = new Map();

function loadState() {
    try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); signals = j.signals || []; lastSig = j.lastSig || {}; log('durum:', signals.length, 'sinyal'); } catch (e) { log('temiz başlangıç.'); }
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

function isSuspect(sym) {
    if (isMajor(sym)) return false;
    const m = ex.markets[sym]; const inf = (m && m.info) || {};
    if (String(inf.isRwa || inf.rwa || '').toUpperCase() === 'YES') return true;
    const st = String(inf.symbolType || inf.category || '').toLowerCase();
    if (st && st !== 'perpetual' && st !== 'crypto') return true;
    return false;
}

async function refreshUniverse() {
    try {
        if (!Object.keys(ex.markets || {}).length) await ex.loadMarkets();
        tickers = await ex.fetchTickers();
        if (Date.now() - nonCryptoAt > 6 * H1) { nonCrypto = new Set(); nonCryptoAt = Date.now(); }
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        let suspect = 0;
        const ok = all.filter(t => {
            const base = baseOf(t.symbol).toUpperCase();
            if (CFG.EXCLUDED.includes(base)) return false;
            if (nonCrypto.has(t.symbol)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) { suspect++; return false; }
            return true;
        });
        scan.suspect = suspect;
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
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
    const [c15, c1h, c4h] = await Promise.all([
        fetchTF(sym, '15m', CFG.CANDLES_15M, M15),
        fetchTF(sym, '1h', CFG.CANDLES_1H, H1),
        fetchTF(sym, '4h', CFG.CANDLES_4H, H4)
    ]);
    return { c15, c1h, c4h };
}
async function fetchMultiCache(sym) {
    const hit = htfCache.get(sym);
    if (hit && Date.now() - hit.t < CFG.HTF_CACHE_MS) return hit;
    let d;
    try { d = await fetchMulti(sym); } catch (e) { await sleep(500); d = await fetchMulti(sym); }
    const rec = Object.assign({ t: Date.now() }, d); htfCache.set(sym, rec); return rec;
}

async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true; const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.reasonDay = day; }
    try {
        let ethDir = 0;
        try {
            const b15 = await fetchTF('BTC/USDT:USDT', '15m', 100, M15);
            const bCl = b15.map(x => x[4]);
            const bE21 = emaSeries(bCl, 21), bE50 = emaSeries(bCl, 50);
            const bi = bCl.length - 1;
            btcCtx.dir = bE21[bi] > bE50[bi] ? 1 : bE21[bi] < bE50[bi] ? -1 : 0;
            market.btc = Object.assign(market.btc || {}, { dir: btcCtx.dir });
            try {
                const e15 = await fetchTF('ETH/USDT:USDT', '15m', 100, M15);
                const eCl = e15.map(x => x[4]);
                const eE21 = emaSeries(eCl, 21), eE50 = emaSeries(eCl, 50);
                const ei = eCl.length - 1;
                ethDir = eE21[ei] > eE50[ei] ? 1 : eE21[ei] < eE50[ei] ? -1 : 0;
                market.eth = Object.assign(market.eth || {}, { dir: ethDir });
            } catch (e) { }
        } catch (e) { log('BTC 15m hatası', e.message); }

        const trends = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const hit = htfCache.get(sym); if (hit && Date.now() - hit.t >= CFG.HTF_CACHE_MS) htfCache.delete(sym);
                    const d = await fetchMultiCache(sym);
                    if (!isMajor(sym) && flatRatio(d.c15) >= CFG.FLAT_MAX) { nonCrypto.add(sym); continue; }
                    // ★ FIX: trend hesaplama
                    const cl = d.c15.map(x => x[4]);
                    trends[sym] = trend15(cl);
                } catch (e) { scan.reasons['hata'] = (scan.reasons['hata'] || 0) + 1; }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        let up = 0, dn = 0, fl = 0;
        const tk = Object.keys(trends);
        for (const k of tk) { if (trends[k] === 1) up++; else if (trends[k] === -1) dn++; else fl++; }
        const bsc = breadthScore(up, dn, tk.length);
        mktDir = mktOf(btcCtx.dir, ethDir, bsc);
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, flat: fl, n: tk.length, breadth: Number(bsc.toFixed(2)) };
        scan.excluded = nonCrypto.size;

        const rad = [], found = [];
        for (const sym of universe) {
            if (trends[sym] === undefined) continue;
            const hit = htfCache.get(sym); if (!hit) continue;
            const t = tickers[sym] || {};
            const r = evaluate(hit.c15, hit.c1h, hit.c4h, { sym, btcDir: btcCtx.dir, funding: fundingMap[sym] != null ? fundingMap[sym] : null, mkt: mktDir, costPct: costFor(t.quoteVolume) * CFG.COST_MULT });
            if (r.radar) { r.radar.chg24 = t.percentage != null ? t.percentage : 0; rad.push(r.radar); }
            scan.reasons[r.reason] = (scan.reasons[r.reason] || 0) + 1;
            if (r.signal) { const age = Date.now() - r.signal.time; if (age <= CFG.MAX_SIGNAL_AGE_MS) found.push(r.signal); }
        }
        radar = rad.filter(x => x.bias !== '-' || x.rsi >= 40).sort((a, b) => b.score - a.score).slice(0, 40);

        found.sort((a, b) => b.score - a.score);
        let added = 0;
        for (const s of found) {
            if (added >= CFG.MAX_PER_SCAN) break;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) continue;
            if (signals.filter(x => isOpen(x) && x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR) continue;
            s.id = s.symbol.replace(/[^A-Z0-9]/g, '') + '_' + s.candleT;
            s.status = 'ACTIVE'; s.lastPrice = s.entry; s.mfe = 0; s.mae = 0; s.trackedTo = s.candleT + M15 - 60e3;
            signals.unshift(s); lastSig[s.symbol] = Date.now(); added++; dirty = true;
            const tvUrl = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.base + 'USDT.P&interval=15';
            log('SİNYAL', s.dir, s.symbol, 'puan', s.score, 'hacim', s.volX.toFixed(1) + 'x', 'RSI', s.rsi.toFixed(0));
            telegram('🚀 SOL SCALPER ' + s.dir + ' ' + s.base + '\nPuan ' + s.score + ' | RSI ' + s.rsi.toFixed(0) + ' | Hacim ' + s.volX.toFixed(1) + 'x\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)\nTP1 ' + fmt(s.tp1) + '\nTP2 ' + fmt(s.tp2) + '\n📈 ' + tvUrl);
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
                    const raw = await ex.fetchOHLCV(s.symbol, '1m', s.trackedTo, 500);
                    const c = closedOnly(raw, 60e3);
                    let progressed = false;
                    for (const k of c) {
                        if (k[0] <= s.trackedTo) continue;
                        s.trackedTo = k[0]; progressed = true; dirty = true;
                        const before = s.status;
                        if (advance(s, k)) {
                            if (!isOpen(s)) { log('KAPANDI', s.symbol, s.status, s.netR); telegram(s.base + ' ' + s.dir + ' kapandı: ' + s.status + ' (' + s.netR + 'R)'); break; }
                            if (before === 'ACTIVE' && s.status === 'TP1_HIT') telegram(s.base + ' TP1 alındı.');
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
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (t[s]) { const key = s.startsWith('BTC') ? 'btc' : 'eth'; market[key] = Object.assign(market[key] || { dir: 0 }, { price: t[s].last, chg: t[s].percentage }); }
        for (const s of signals) if (isOpen(s) && t[s.symbol] && t[s.symbol].last) s.lastPrice = t[s.symbol].last;
    } catch (e) { }
}
const selfPing = async () => { if (SELF_URL) { try { await fetch(SELF_URL + '/health'); } catch (e) { } } };

function apiState() {
    const now = Date.now(), closed = signals.filter(s => !isOpen(s) && s.netR != null);
    const st = calcStats(closed, trDay(now));
    let e = 0; const eq = closed.slice().sort((a, b) => a.closedAt - b.closedAt).slice(-200).map(s => (e += s.netR));
    const enriched = signals.slice(0, 80).map(s => {
        if (isOpen(s)) return Object.assign({}, s, { health: signalHealth(s, s.lastPrice), entryAdvice: entryAdvice(s) });
        return s;
    });
    return { now, mode: 'SOL SCALPER v1.1', minScore: 60, market, signals: enriched, radar, stats: st, equity: eq,
        filters: { stopK: CFG.STOP_ATR_MULT, tp1: CFG.TP1_R, tp2: CFG.TP2_R, volume: CFG.VOLUME_SURGE, regime: CFG.REQUIRE_REGIME, ob: CFG.REQUIRE_ORDER_BLOCK, vwap: CFG.REQUIRE_VWAP, h1: CFG.REQUIRE_1H_ALIGN, counter: CFG.BLOCK_COUNTER_MKT },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible, excluded: scan.excluded, suspect: scan.suspect } };
}

async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const hit = candleCache.get(sym); if (hit && Date.now() - hit.t < 8000) return hit.d;
    const c = await ex.fetchOHLCV(sym, '15m', undefined, 300);
    const cl = c.map(x => x[4]);
    const e9 = emaSeries(cl, 9), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), e200 = emaSeries(cl, 200);
    const N = 150, cut = Math.max(0, c.length - N);
    const d = { c: c.slice(cut), e9: e9.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut), e200: e200.slice(cut) };
    candleCache.set(sym, { t: Date.now(), d }); return d;
}

// ==================== BACKTEST ====================
async function fetchHistory15(sym, days) {
    let since = Date.now() - (days + 4) * 86400e3, all = [], guard = 0;
    while (since < Date.now() - M15 && guard++ < 150) {
        let r = null, retry = 0;
        while (retry < CFG.BT_MAX_RETRY) {
            try { r = await ex.fetchOHLCV(sym, '15m', since, 1000); break; }
            catch (e) {
                const msg = String(e.message || '');
                if (msg.includes('429') || msg.includes('Too Many') || msg.includes('rate')) { retry++; await sleep(2000 * retry); }
                else throw e;
            }
        }
        if (!r || !r.length) break;
        all = all.concat(r); const last = r[r.length - 1][0];
        if (last <= since) break; since = last + M15;
        await sleep(250);
    }
    const seen = new Set();
    return closedOnly(all, M15).filter(x => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]);
}

function aggregate(c15, n) {
    const ms = M15 * n, g = new Map();
    for (const x of c15) {
        const k = Math.floor(x[0] / ms) * ms;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === n);
}

async function simulate(pre, use, maps, opts, startT) {
    const C = Object.assign({}, CFG, opts.o || {}), raw = [], funnel = {};
    for (const sym of use) {
        const P = pre[sym], c = P.c;
        const a1h = aggregate(c, 4), a4h = aggregate(c, 16);
        let p1h = 0, p4h = 0, busyUntil = 0;
        for (let i = 250; i < c.length - 2; i++) {
            const t = c[i][0];
            if (t < startT || t < busyUntil) continue;
            const closeT = t + M15;
            while (p1h < a1h.length && a1h[p1h][0] + H1 <= closeT) p1h++;
            while (p4h < a4h.length && a4h[p4h][0] + H4 <= closeT) p4h++;
            if (p1h < 50 || p4h < 50) continue;
            const c1h = a1h.slice(Math.max(0, p1h - 200), p1h);
            const c4h = a4h.slice(Math.max(0, p4h - 100), p4h);
            const w = c.slice(Math.max(0, i - 499), i + 1);
            const r = evaluate(w, c1h, c4h, { sym, btcDir: maps.btc.get(t) || 0, funding: null, mkt: maps.mkt.get(t) || 0, costPct: P.costPct, cfg: C });
            if (i % 400 === 0) await tick();
            if (!r.signal) { if (r.reason !== 'veri az') funnel[r.reason] = (funnel[r.reason] || 0) + 1; continue; }
            funnel['sinyal'] = (funnel['sinyal'] || 0) + 1;
            const s = r.signal; s.status = 'ACTIVE'; s.mfe = 0; s.mae = 0; s.lastPrice = s.entry;
            for (let j = i + 1; j < c.length; j++) { if (advance(s, c[j]) && !isOpen(s)) { s.closedAt = c[j][0] + M15; break; } }
            if (isOpen(s)) continue;
            raw.push({ symbol: s.symbol, base: s.base, dir: s.dir, setupName: s.setupName, score: s.score, time: s.time, candleT: s.candleT, closedAt: s.closedAt, netR: s.netR, status: s.status, mkt: s.mkt, mfe: s.mfe, volX: s.volX, rsi: s.rsi });
            busyUntil = Math.max(s.closedAt, s.time + C.COOLDOWN_MS);
        }
    }
    raw.sort((a, b) => a.time - b.time || b.score - a.score);
    const trades = [], openList = [], slotCnt = {}; let blocked = 0;
    for (const t of raw) {
        for (let q = openList.length - 1; q >= 0; q--) if (openList[q].closedAt <= t.time) openList.splice(q, 1);
        const slot = Math.floor(t.time / M15);
        if (openList.filter(o => o.dir === t.dir).length >= C.MAX_OPEN_PER_DIR || (slotCnt[slot] || 0) >= C.MAX_PER_SCAN) { blocked++; continue; }
        slotCnt[slot] = (slotCnt[slot] || 0) + 1; openList.push(t); trades.push(t);
    }
    funnel['portföy limiti'] = blocked;
    return { trades, funnel };
}
const split = tr => { const cut = Math.floor(tr.length * 0.6); return { all: grp(tr), train: grp(tr.slice(0, cut)), test: grp(tr.slice(cut)) }; };

async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    opts = Object.assign({ costMult: 1 }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
        const syms = universe.filter(s => !isMajor(s) || s === ETH).filter(s => s !== BTC).slice(0, coins);
        const all = [BTC].concat(syms.includes(ETH) ? [] : [ETH], syms);
        btJob.total = all.length;
        const data = {}; let candles = 0;
        for (const s of all) {
            btJob.msg = 'Veri: ' + baseOf(s);
            data[s] = await fetchHistory15(s, days);
            candles += data[s].length;
            btJob.done++;
            await sleep(CFG.BT_SLEEP_PER_COIN);
        }
        const use = syms.filter(s => isMajor(s) || flatRatio(data[s]) < CFG.FLAT_MAX);

        btJob.msg = 'Piyasa yönü';
        const partic = Array.from(new Set([BTC, ETH].concat(use)));
        const tmap = {};
        for (const s of partic) {
            const c = data[s], m = new Map();
            for (let i = 200; i < c.length; i++) {
                const cl = c.slice(i - 199, i + 1).map(x => x[4]);
                const e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50);
                const last = cl.length - 1;
                m.set(c[i][0], e21[last] > e50[last] ? 1 : e21[last] < e50[last] ? -1 : 0);
                if (i % 2000 === 0) await tick();
            }
            tmap[s] = m;
        }
        const maps = { mkt: new Map(), btc: new Map() };
        for (const x of data[BTC]) {
            const t = x[0]; let up = 0, dn = 0, n = 0;
            for (const s of partic) { const v = tmap[s].get(t); if (v === undefined) continue; n++; if (v === 1) up++; else if (v === -1) dn++; }
            const bd = tmap[BTC].get(t) || 0, ed = tmap[ETH].get(t) || 0;
            maps.btc.set(t, bd);
            maps.mkt.set(t, mktOf(bd, ed, breadthScore(up, dn, n)));
        }
        const pre = {};
        for (const s of use) pre[s] = { c: data[s], costPct: costFor((tickers[s] || {}).quoteVolume) * opts.costMult };

        const startT = Date.now() - days * 86400e3;
        btJob.msg = 'Simüle ediliyor...';
        const r = await simulate(pre, use, maps, opts, startT);
        const sp = split(r.trades);
        const trades = r.trades;
        btJob.result = { days, coins, candles, funnel: r.funnel, costMult: opts.costMult,
            all: sp.all, train: sp.train, test: sp.test,
            bySetup: groupBy(trades, s => s.setupName), byDir: groupBy(trades, s => s.dir),
            byBand: groupBy(trades, band), bySession: groupBy(trades, s => session(s.time)),
            byMkt: groupBy(trades, mktName), byExit: groupBy(trades, s => s.status),
            byMfe: groupBy(trades, s => s.mfe < 0.5 ? '1 MFE <0.5R' : s.mfe < 1 ? '2 0.5-1R' : s.mfe < 2 ? '3 1-2R' : '4 2R+'),
            byCoin: groupBy(trades, s => s.base),
            byWeek: groupBy(trades, s => 'H' + String(Math.floor((s.time - startT) / (7 * 86400e3)) + 1).padStart(2, '0')) };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test hatası: ' + e.message; }
    btJob.running = false;
}

// ==================== HTML PANEL (v9.12 STİLİ) ====================
const HTML = String.raw`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOL SCALPER v1.1</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--bl:#5aa9ff;--tv:#2962ff}
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
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;position:relative}
.card:hover{border-color:#34455a}
.card.sel{border-color:var(--am)}
.card.closed{opacity:.72}
.card-tv{position:absolute;top:8px;right:8px;background:var(--tv);color:#fff;border:none;border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;text-decoration:none;z-index:2}
.card-tv:hover{background:#1e50d6}
.r1{display:flex;align-items:center;gap:8px;padding-right:60px;flex-wrap:wrap}
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
canvas{width:100%;height:380px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--am)}
.pr{display:grid;grid-template-columns:120px 1fr 34px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.frm input{width:110px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.g{background:var(--p1);color:var(--tx);border:1px solid var(--ln);font-weight:600}
.btn.tv{background:var(--tv);color:#fff;text-decoration:none;padding:7px 14px;border-radius:6px;font-weight:700}
.btn.tv:hover{background:#1e50d6}
.mut{color:var(--dm)}
.note{font-size:11px;color:var(--dm);margin-top:8px}
.health-box{border:1.5px solid;border-radius:8px;padding:10px 12px;margin-top:8px;display:flex;align-items:center;gap:12px}
.health-box .hs{font-size:28px;font-weight:900;line-height:1}
.health-box .hl{font-size:11px;color:var(--dm)}
.health-box .hv{font-weight:800;font-size:14px}
@media(max-width:900px){body{overflow:auto}.app{height:auto}.body{flex-direction:column}.side{width:100%;height:48vh}.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="app">
 <div class="top">
  <div class="brand">SOL SCALPER<small id="modeB">v1.1</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div>
  <div class="grow"></div>
  <div class="gate" id="gate"><div><div class="clock" id="clock">--:--:--</div><div class="g2">Türkiye saati</div></div><div><div class="g1" id="g1">...</div><div class="g2" id="g2"></div></div></div>
  <button class="ibtn" id="bSound">Bildirim kapalı</button>
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
var TABS=[['sig','Sinyaller'],['radar','Radar'],['stat','İstatistik'],['bt','Test']];
var S=null,tab='sig',sel=null,seen={},first=true,sound=false,chartCache={},chartFor='',bt=null;
var _btSel={d:30,c:20};
function $(i){return document.getElementById(i)}
function ls(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function ss(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
try{var _b=JSON.parse(localStorage.getItem('st_btSel')||'null');if(_b){for(var _k in _b)_btSel[_k]=_b[_k]}}catch(e){}
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){return x==null||isNaN(x)?'-':Number(x).toFixed(d==null?2:d)}
function sg(x,d){x=Number(x);return(x>0?'+':'')+x.toFixed(d==null?2:d)}
function cl(x){return x>0?'up':x<0?'dn':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function trNow(){return new Date(Date.now()+3*3600e3)}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s'}
function tvUrl(sym){var b=sym.split('/')[0];return'https://www.tradingview.com/chart/?symbol=BITGET:'+b+'USDT.P&interval=15'}
function openS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT'}
function pnlR(s){if(!s||!s.lastPrice)return null;return(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop)}
var ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1','g'],TP2:['TP2 ✓','g'],STOP:['Stop','r'],BE:['BE','w'],TIMEOUT:['Süre','w']};
function renderTop(){if(!S)return;var md=S.market&&S.market.mood;if(md){var mc=md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl';$('cMkt').innerHTML='<b>Piyasa</b> <span class="mk '+mc+'">'+md.label+'</span> <span class="mut">'+md.up+'↑/'+md.down+'↓ (b '+f2(md.breadth,1)+')</span>'}else $('cMkt').innerHTML='<b>Piyasa</b> ...';
 function chip(id,n,m){var e=$(id);if(!m){e.innerHTML='<b>'+n+'</b> -';return}var t=m.dir===1?'<span class="up">15m ▲</span>':m.dir===-1?'<span class="dn">15m ▼</span>':'<span class="fl">15m ▬</span>';e.innerHTML='<b>'+n+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg,2)+'%</span> '+t}
 chip('cBTC','BTC',S.market&&S.market.btc);chip('cETH','ETH',S.market&&S.market.eth);$('modeB').textContent=S.mode}
function renderGate(){var d=trNow();$('clock').textContent=('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2)+':'+('0'+d.getUTCSeconds()).slice(-2);
 var t=S&&S.stats&&S.stats.today?S.stats.today.n:0,r=S&&S.stats&&S.stats.today?S.stats.today.totalR:0;
 if(r<=-3){$('gate').className='gate stop';$('g1').textContent='DUR';$('g2').textContent='Günlük limit doldu ('+sg(r,1)+'R)'}
 else if(r>=3){$('gate').className='gate wait';$('g1').textContent='YAVAŞLA';$('g2').textContent=sg(r,1)+'R hedef doldu'}
 else {$('gate').className='gate ok';$('g1').textContent='AÇIK';$('g2').textContent='Bugün '+sg(r,1)+'R, '+t+' işlem'}}
function renderTabs(){var oc=S?S.signals.filter(openS).length:0,h='';TABS.forEach(function(t){h+='<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?'<i>'+oc+'</i>':'')+'</button>'});$('tabs').innerHTML=h;
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.getAttribute('data-t');if(tab==='sig'||tab==='radar')sel=null;renderAll()}})}
function sigCard(s){var st=ST[s.status]||['?',''];var cls='card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed');
 var pnl='',px='',warn='',hb='';if(s.warnings&&s.warnings.length)warn='<span class="tag w">'+esc(s.warnings[0])+'</span>';
 var R=pnlR(s);if(openS(s)&&R!=null){var pc=R>0?'up':R<0?'dn':'fl';pnl='<span class="pnl-big '+pc+'">'+(R>0?'+':'')+R.toFixed(2)+'R</span>';px='<span>Anlık <b>'+fp(s.lastPrice)+'</b></span>'}
 else if(s.netR!=null){var rc=s.netR>0?'up':s.netR<0?'dn':'fl';pnl='<span class="pnl-big '+rc+'">'+(s.netR>0?'+':'')+s.netR+'R</span>'}
 if(openS(s)&&s.health)hb='<span class="tag '+s.health.color+'" title="'+esc(s.health.reason)+'">'+s.health.status+' '+s.health.score+'</span>';
 return '<div class="'+cls+'" data-id="'+s.id+'"><a class="card-tv" href="'+tvUrl(s.symbol)+'" target="_blank" onclick="event.stopPropagation()">📈 TV</a><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">GÜÇLÜ '+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+hb+warn+pnl+'</div><div class="sub"><span>Giriş <b>'+fp(s.entry)+'</b></span>'+px+'<span>Stop '+fp(s.stop)+'</span><span>TP1 '+fp(s.tp1)+'</span><span>'+ago(s.time)+' önce</span></div></div>'}
function radarCard(r){var cls='card'+(sel&&sel.sym===r.symbol?' sel':'');var b=r.bias==='LONG'?'<span class="badge L">LONG</span>':r.bias==='SHORT'?'<span class="badge S">SHORT</span>':'<span class="badge" style="color:var(--dm)">-</span>';
 return '<div class="'+cls+'" data-sym="'+esc(r.symbol)+'"><a class="card-tv" href="'+tvUrl(r.symbol)+'" target="_blank" onclick="event.stopPropagation()">📈 TV</a><div class="r1">'+b+'<span class="coin">'+esc(r.base)+'</span><span class="mut">'+fp(r.price)+'</span><span class="'+cl(r.chg24)+'" style="margin-left:auto">'+sg(r.chg24,1)+'%</span></div><div class="sub"><span>RSI '+f2(r.rsi,0)+'</span><span>Hacim '+f2(r.volX,1)+'x</span><span>EMA '+(r.trend15m===1?'▲':r.trend15m===-1?'▼':'▬')+'</span><span>'+esc(r.state)+'</span></div></div>'}
function renderList(){var L=$('list'),h='';if(!S){L.innerHTML='<div class="note">Yükleniyor...</div>';return}
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return!openS(s)}).slice(0,20);if(!a.length)h+='<div class="note" style="padding:10px">Şu an açık sinyal yok. EMA 9/21 kesişimi aranıyor.</div>';a.forEach(function(s){h+=sigCard(s)});if(c.length)h+='<h3>Kapanan</h3>';c.forEach(function(s){h+=sigCard(s)})}
 else if(tab==='radar'){S.radar.forEach(function(r){h+=radarCard(r)});if(!S.radar.length)h='<div class="note" style="padding:10px">Radar ilk taramadan sonra dolar.</div>'}
 else if(tab==='stat'){h='<div class="note" style="padding:8px">Sağdaki panelde istatistikler</div>'}
 else{h='<div class="note" style="padding:8px">Testi sağdaki panelden başlat</div>'}
 L.innerHTML=h;Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.getAttribute('data-id'),sy=e.getAttribute('data-sym');if(id){var s=S.signals.filter(function(x){return x.id===id})[0];sel={id:id,sym:s.symbol}}else{sel={sym:sy}}chartFor='';renderList();renderMain()}})}
function calcBox(entry,stop){return '<div class="box"><h3 style="margin-top:0">Pozisyon hesaplayıcı</h3><div class="frm"><label class="mut">Bakiye<br><input id="cBal" type="number" value="1000"></label><label class="mut">Risk % (maks 2)<br><input id="cRisk" type="number" step="0.1" max="2" value="0.5"></label><label class="mut">Giriş<br><input id="cE" type="number" step="any" value="'+(entry||'')+'"></label><label class="mut">Stop<br><input id="cS" type="number" step="any" value="'+(stop||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx);font-size:13px">Değer gir</div></div>'}
function bindCalc(){['cBal','cRisk','cE','cS'].forEach(function(id){var e=$(id);if(!e)return;e.oninput=function(){var bal=Number($('cBal').value),rk=Math.min(2,Number($('cRisk').value));var en=Number($('cE').value),so=Number($('cS').value);if(!en||!so){$('cOut').innerHTML='Değer gir';return}var riskUsd=bal*rk/100,d=Math.abs(en-so),qty=riskUsd/d,notional=qty*en;$('cOut').innerHTML='1R = <b>'+f2(riskUsd,2)+' USDT</b> &nbsp; Miktar <b>'+f2(qty,4)+'</b> &nbsp; Pozisyon <b>'+f2(notional,1)+' USDT</b> &nbsp; Kaldıraç <b>'+f2(notional/bal,1)+'x</b>'}})}
function partsView(s){var lab={ema:'EMA kesişim',trend:'EMA50 trend',regim:'EMA200 rejim',rsi:'RSI',vol:'Hacim',ob:'Order Block',vwap:'VWAP',h1:'1H hizalama'},mx={ema:15,trend:10,regim:10,rsi:10,vol:10,ob:5,vwap:5,h1:5},h='',p=s.parts||{};
 for(var k in lab){var v=p[k]||0;h+='<div class="pr"><span>'+lab[k]+'</span><div class="bar"><i style="width:'+Math.min(100,Math.abs(v)/mx[k]*100)+'%;background:var(--am)"></i></div><b>'+v+'</b></div>'}return h}
function healthBoxHTML(s){if(!openS(s)||!s.health)return '';var hc=s.health.color==='g'?'var(--lg)':s.health.color==='r'?'var(--st)':'var(--am)';var hbg=s.health.color==='g'?'rgba(61,220,151,.08)':s.health.color==='r'?'rgba(255,107,122,.08)':'rgba(242,184,75,.08)';
 var ea=s.entryAdvice?'<div class="mut" style="margin-left:auto;font-size:11px">Giriş: <span class="tag '+s.entryAdvice.color+'">'+s.entryAdvice.status+'</span> '+esc(s.entryAdvice.reason)+'</div>':'';
 return '<div class="health-box" style="border-color:'+hc+';background:'+hbg+'"><div><div class="hl">CANLI SAĞLIK</div><div class="hs" style="color:'+hc+'">'+s.health.score+'</div></div><div><div class="hv" style="color:'+hc+'">'+s.health.status+'</div><div class="hl">'+esc(s.health.reason)+'</div><div class="hl" style="color:'+hc+';margin-top:2px">→ '+esc(s.health.advice)+'</div></div>'+ea+'</div>'}
function sigView(s){var st=ST[s.status]||['?',''],w='';(s.warnings||[]).forEach(function(x){w+='<span class="tag w">'+esc(x)+'</span> '});
 var tv=tvUrl(s.symbol),R=pnlR(s);
 var txt=s.dir+' '+s.base+' | Giriş '+fp(s.entry)+' | Stop '+fp(s.initialStop)+' | TP1 '+fp(s.tp1)+' | TP2 '+fp(s.tp2)+' | '+tv;
 var h='<div class="r1" style="margin-bottom:8px;padding-right:0"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">GÜÇLÜ '+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag '+st[1]+'">'+st[0]+'</span><span class="sc" style="font-size:24px">'+s.score+'</span></div>';
 h+='<div class="mut" style="margin-bottom:6px">'+esc(s.setupName)+' • '+ago(s.time)+' önce'+(s.netR!=null&&!openS(s)?' • Sonuç '+sg(s.netR,2)+'R':'')+'</div>'+w;
 h+=healthBoxHTML(s);
 h+='<canvas id="cv" style="margin-top:10px"></canvas>';
 h+='<div class="lv"><div><span>Anlık Fiyat</span><b style="color:#fff;font-size:16px">'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z (R)</span><b class="'+(R>0?'up':R<0?'dn':'fl')+'" style="font-size:16px">'+(R!=null?(R>0?'+':'')+R.toFixed(2)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1 ('+s.tp1R+'R)</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2 ('+s.tp2R+'R)</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct,2)+'%</b></div><div><span>RSI</span><b>'+f2(s.rsi,0)+'</b></div><div><span>Hacim</span><b>'+f2(s.volX,1)+'x</b></div><div><span>MFE/MAE</span><b>'+f2(s.mfe,1)+'R / '+f2(s.mae,1)+'R</b></div></div>';
 h+='<div class="frm"><a class="btn tv" href="'+tv+'" target="_blank">📈 TradingView</a><button class="btn" id="cpy">Kopyala</button></div><div class="grid2"><div class="box"><h3 style="margin-top:0">Puan dağılımı</h3>'+partsView(s)+'<div class="note">RSI '+f2(s.rsi,0)+' • 4H resistance '+fp(s.ema50)+' • 4H support '+fp(s.ema200)+'</div><div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div></div><div>'+calcBox(s.entry,s.initialStop)+'</div></div>';
 return {h:h,txt:txt,s:s}}
function radarView(sym){var r=S.radar.filter(function(x){return x.symbol===sym})[0];var tv=tvUrl(sym);var h='<div class="r1" style="margin-bottom:8px;padding-right:0"><h2 style="margin:0">'+esc(sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="'+tv+'" target="_blank">📈 TradingView</a></div><canvas id="cv"></canvas>';
 if(r)h+='<div class="lv"><div><span>Fiyat</span><b>'+fp(r.price)+'</b></div><div><span>24s</span><b class="'+cl(r.chg24)+'">'+sg(r.chg24,1)+'%</b></div><div><span>RSI</span><b>'+f2(r.rsi,0)+'</b></div><div><span>EMA9</span><b>'+fp(r.ema9)+'</b></div><div><span>EMA21</span><b>'+fp(r.ema21)+'</b></div><div><span>EMA50</span><b>'+fp(r.ema50)+'</b></div><div><span>EMA200</span><b>'+fp(r.ema200)+'</b></div><div><span>VWAP</span><b>'+fp(r.vwap)+'</b></div></div>';
 return h+calcBox('','')}
function tbl(t,title){return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">İşlem</th><th class="n">Kazanç %</th><th class="n">Ort R</th><th class="n">Toplam R</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR,2)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td></tr>'}).join('')+'</table>'}
function statView(){var a=S.stats.all,h='<h2>Bot istatistiği</h2><div class="tiles"><div class="tile"><div class="k">Kapanan sinyal</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(a.win*100,0)+'%</div></div><div class="tile"><div class="k">Ortalama R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR,2)+'</div></div><div class="tile"><div class="k">Toplam R</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf,2)+'</div></div><div class="tile"><div class="k">Maks. düşüş</div><div class="v dn">'+f2(a.dd,1)+'R</div></div></div><canvas id="eq" style="height:160px"></canvas>'+tbl(S.stats.bySetup,'Kurulum')+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byMkt,'Piyasa yönü')+tbl(S.stats.byExit,'Çıkış')+tbl(S.stats.byBand,'Puan bandı')+tbl(S.stats.bySession,'Seans');return h}
function reasonTxt(o){var a=[];for(var k in o)a.push([k,o[k]]);a.sort(function(x,y){return y[1]-x[1]});return a.slice(0,9).map(function(x){return x[0]+' '+x[1]}).join(', ')||'-'}
function opt(v,cur,txt){return '<option value="'+v+'"'+(Number(cur)===v?' selected':'')+'>'+txt+'</option>'}
function btView(){var h='<h2>Geçmiş veri testi</h2><div class="box"><div class="frm"><select id="bD">'+opt(7,_btSel.d,'7 gün')+opt(14,_btSel.d,'14 gün')+opt(30,_btSel.d,'30 gün')+opt(60,_btSel.d,'60 gün')+opt(90,_btSel.d,'90 gün')+'</select><select id="bC">'+opt(10,_btSel.c,'10 coin')+opt(20,_btSel.c,'20 coin')+opt(40,_btSel.c,'40 coin')+'</select><button class="btn" id="bGo">Testi başlat</button></div><div class="note">SOL Scalper v1.1: EMA9/21 + EMA50/200 + RSI + Hacim + OB + VWAP + 1H. Stop 1.5 ATR, TP1 1.5R, TP2 2.5R. 90g/40coin ~3-5 dk.</div></div>';
 if(!bt)return h+'<div class="note">Henüz test yok.</div>';
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div><div class="bar" style="margin-top:8px"><i style="width:'+Math.round(bt.done/Math.max(1,bt.total)*100)+'%"></i></div></div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){var R=bt.result;h+='<div class="tiles"><div class="tile"><div class="k">Toplam işlem</div><div class="v">'+R.all.n+'</div></div><div class="tile"><div class="k">Kazanç oranı</div><div class="v">'+f2(R.all.win*100,0)+'%</div></div><div class="tile"><div class="k">Ort R</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR,2)+'</div></div><div class="tile"><div class="k">İlk %60</div><div class="v '+cl(R.train.avgR)+'">'+sg(R.train.avgR,2)+'</div><div class="k">'+R.train.n+' işlem</div></div><div class="tile"><div class="k">Son %40 (test)</div><div class="v '+cl(R.test.avgR)+'">'+sg(R.test.avgR,2)+'</div><div class="k">'+R.test.n+' işlem</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(R.all.pf,2)+'</div></div><div class="tile"><div class="k">Max DD</div><div class="v dn">'+f2(R.all.dd,1)+'R</div></div></div><div class="note">'+R.days+' gün / '+R.coins+' coin / '+R.candles+' mum • maliyet x'+R.costMult+'.</div><div class="note">Filtre hunisi: '+reasonTxt(R.funnel)+'</div>'+tbl(R.byExit,'Çıkış')+tbl(R.byMfe,'MFE')+tbl(R.byDir,'Yön')+tbl(R.byMkt,'Piyasa')+tbl(R.byBand,'Puan')+tbl(R.bySession,'Seans')+tbl(R.byWeek,'Hafta')+tbl(R.byCoin,'Coin')}
 return h}
function bindBt(){var sD=$('bD'),sC=$('bC');if(sD)sD.onchange=function(){_btSel.d=Number(sD.value);ss('st_btSel',_btSel)};if(sC)sC.onchange=function(){_btSel.c=Number(sC.value);ss('st_btSel',_btSel)};var b=$('bGo');if(!b)return;b.onclick=function(){fetch('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:Number(sD.value),coins:Number(sC.value)})}).then(function(r){return r.json()}).then(function(){pollBt()})}}
function pollBt(){fetch('/api/backtest').then(function(r){return r.json()}).then(function(d){bt=d;var ae=document.activeElement;if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'))return;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}
function drawEq(){var c=$('eq');if(!c||!S.equity.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);var v=S.equity,mn=Math.min(0,Math.min.apply(null,v)),mx=Math.max(0.1,Math.max.apply(null,v)),Y=function(a){return H-10-(a-mn)/(mx-mn)*(H-20)};x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach(function(a,i){var px=i/Math.max(1,v.length-1)*(W-8)+4;if(i)x.lineTo(px,Y(a));else x.moveTo(px,Y(a))});x.stroke()}
function drawChart(d,s){var c=$('cv');if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);
 var L=8,R=90,T=14,B=22,n=d.c.length,PW=W-L-R,PH=H-T-B,hi=-1e99,lo=1e99,i;for(i=0;i<n;i++){hi=Math.max(hi,d.c[i][2]);lo=Math.min(lo,d.c[i][3])}
 var lv=[];if(s){lv=[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.initialStop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ'],[s.ema50,'#f2b84b','EMA50']];lv.forEach(function(a){if(a[0])hi=Math.max(hi,a[0]),lo=Math.min(lo,a[0])})}
 var pad=(hi-lo)*0.06;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH};var X=function(k){return L+(k+0.5)/n*PW};var cw=Math.max(2,PW/n*0.68);
 x.strokeStyle='rgba(255,255,255,.05)';x.lineWidth=1;for(i=0;i<=4;i++){var gy=T+PH*i/4;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillStyle='#8593a5';x.font='10px system-ui';x.textAlign='left';x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 if(s){x.fillStyle='rgba(255,107,122,.13)';var ys=Y(s.initialStop),ye=Y(s.entry);x.fillRect(L,Math.min(ys,ye),PW,Math.abs(ye-ys));x.fillStyle='rgba(61,220,151,.13)';var yt1=Y(s.tp1);x.fillRect(L,Math.min(ye,yt1),PW,Math.abs(yt1-ye))}
 function line(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;for(var k=0;k<Math.min(arr.length,n);k++){if(arr[k]==null)continue;if(!st){x.moveTo(X(k),Y(arr[k]));st=true}else x.lineTo(X(k),Y(arr[k]))}x.stroke()}
 line(d.e200,'#8593a5',1.0);line(d.e50,'#4da3ff',1.2);line(d.e21,'#f2b84b',1.4);line(d.e9,'#3ddc97',1.2);
 for(i=0;i<n;i++){var k=d.c[i],up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();var y1=Y(k[1]),y2=Y(k[4]);x.fillRect(X(i)-cw/2,Math.min(y1,y2),cw,Math.max(1,Math.abs(y2-y1)))}
 // Etiket çakışma önleme
 var labels=[];lv.forEach(function(a){if(!a[0])return;labels.push({price:a[0],color:a[1],name:a[2],y:Y(a[0])})});labels.sort(function(a,b){return a.y-b.y});for(var li=1;li<labels.length;li++){if(labels[li].y-labels[li-1].y<26)labels[li].y=labels[li-1].y+26}
 labels.forEach(function(a){x.strokeStyle=a.color;x.lineWidth=a.name==='GİRİŞ'?2:1.5;x.setLineDash(a.name==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a.price));x.lineTo(W-R,Y(a.price));x.stroke();x.setLineDash([]);x.fillStyle=a.color;x.font='bold 11px system-ui';x.textAlign='left';x.fillText(a.name,W-R+8,a.y-4);x.fillStyle='rgba(133,147,165,.85)';x.font='10px system-ui';x.fillText(fp(a.price),W-R+8,a.y+8)});
 var livePrice=s&&s.lastPrice?s.lastPrice:d.c[n-1][4];var yLive=Y(livePrice);x.shadowColor='#ffffff';x.shadowBlur=8;x.strokeStyle='#ffffff';x.lineWidth=2.5;x.beginPath();x.moveTo(L,yLive);x.lineTo(W-R,yLive);x.stroke();x.shadowBlur=0;
 if(s){var R2=(s.dir==='LONG'?1:-1)*(livePrice-s.entry)/Math.abs(s.entry-s.initialStop);var pc=R2>0?'#3ddc97':R2<0?'#ff6b7a':'#8593a5';x.fillStyle='rgba(12,17,23,.92)';x.fillRect(L+4,T+4,170,74);x.strokeStyle=pc;x.lineWidth=1.5;x.strokeRect(L+4,T+4,170,74);x.fillStyle='#8593a5';x.font='10px system-ui';x.textAlign='left';x.fillText('K/Z (R)',L+12,T+18);x.fillStyle=pc;x.font='bold 20px system-ui';x.fillText((R2>0?'+':'')+R2.toFixed(2)+'R',L+12,T+40);x.fillStyle=s.dir==='LONG'?'#3ddc97':'#ff6b7a';x.font='bold 11px system-ui';x.textAlign='right';x.fillText(s.dir,L+166,T+18);x.textAlign='left';x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText('ANLIK',L+12,T+58);x.fillStyle='#fff';x.font='bold 13px system-ui';x.fillText(fp(livePrice),L+52,T+58)}
 x.fillStyle='#8593a5';x.font='10px system-ui';x.textAlign='left';x.fillText('15m • EMA9 (yeşil) • EMA21 (sarı) • EMA50 (mavi) • EMA200 (gri)',L+4,H-6)}
function loadChart(sym){if(!sym)return;fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(d){chartCache[sym]=d;if(sel&&sel.sym===sym){var s2=sel.id?S.signals.filter(function(x){return x.id===sel.id})[0]:null;drawChart(d,s2)}}).catch(function(){})}
function renderMain(){var M=$('main');if(!S){M.innerHTML='';return}
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){var s=S.signals.filter(function(x){return x.id===sel.id})[0];if(s){var v=sigView(s);M.innerHTML=v.h;$('cpy').onclick=function(){try{navigator.clipboard.writeText(v.txt);$('cpy').textContent='Kopyalandı'}catch(e){}};bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol)}return}}
 if(sel&&sel.sym){M.innerHTML=radarView(sel.sym);bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym)}return}
 var md=S.market&&S.market.mood,h='<h2>Pano</h2><div class="tiles"><div class="tile"><div class="k">Piyasa yönü</div><div class="v">'+(md?md.label:'-')+'</div><div class="k">breadth '+f2(md?md.breadth:0,1)+' (15m)</div></div><div class="tile"><div class="k">Taranan coin</div><div class="v">'+S.scan.universe+'</div></div><div class="tile"><div class="k">Aktif sinyal</div><div class="v">'+S.signals.filter(openS).length+'</div></div><div class="tile"><div class="k">Bugün sinyal</div><div class="v">'+(S.stats.today?S.stats.today.n:0)+' <span class="mut" style="font-size:12px">ort '+sg(S.stats.today?S.stats.today.avgR:0,2)+'R</span></div></div></div>';
 h+='<div class="grid2"><div><div class="box"><h3 style="margin-top:0">Strateji: SOL Scalper v1.1</h3><div class="note" style="color:var(--tx)">EMA 9/21 kesişim + EMA50 trend + EMA200 rejim + RSI + Hacim + OB + VWAP + 1H hizalama. Stop 1.5 ATR, TP1 1.5R, TP2 2.5R.</div><div class="note">Kapsam: '+S.scan.total+' vadeli → '+S.scan.eligible+' filtre geçen → '+S.scan.universe+' taranan. Şüpheli: '+(S.scan.suspect||0)+'.</div><div class="note">Elenme (bugün): '+reasonTxt(S.scan.reasons)+'</div></div></div><div>'+calcBox('','')+'</div></div>';
 return h}
function renderAll(){renderTop();renderTabs();renderList();renderMain();renderGate()}
function beep(){try{var a=new(window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.15;o.start();o.stop(a.currentTime+.25)}catch(e){}}
function apply(d){if(!d)return;S=d;var fresh=[];d.signals.forEach(function(s){if(openS(s)&&!seen[s.id]){seen[s.id]=1;if(!first)fresh.push(s)}else if(!seen[s.id])seen[s.id]=1});
 if(fresh.length&&sound){beep();try{if(Notification.permission==='granted')new Notification('SOL '+fresh[0].dir+' '+fresh[0].base,{body:'Giriş '+fp(fresh[0].entry)+' Puan '+fresh[0].score})}catch(e){}}
 first=false;var ae=document.activeElement,tag=ae&&ae.tagName;if(tag==='INPUT'||tag==='SELECT'){renderTop();renderTabs();renderList();renderGate();return}renderAll()}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){apply(d);$('dot').className='dot on';$('conn').textContent='Bağlı'}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
$('bSound').onclick=function(){sound=!sound;this.className='ibtn'+(sound?' on':'');this.textContent=sound?'Bildirim açık':'Bildirim kapalı';if(sound){beep();try{Notification.requestPermission()}catch(e){}}};
window.addEventListener('resize',function(){if(S)renderMain()});
setInterval(renderGate,1000);setInterval(poll,5000);setInterval(function(){if(sel&&sel.sym)loadChart(sel.sym)},20000);
poll();pollBt();
</script>
</body>
</html>`;

// ==================== HTTP ====================
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
            const days = [7, 14, 30, 60, 90].includes(b.days) ? b.days : 30;
            const coins = [10, 20, 40].includes(b.coins) ? b.coins : 20;
            if (!btJob.running) runBacktest(days, coins, { costMult: 1 });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(req)) return json(res, 401, { error: 'yetkisiz' });
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
        log('evren:', universe.length, 'coin | min hacim:', CFG.MIN_VOL_USDT / 1e6 + 'M');
        setInterval(refreshUniverse, 5 * 60e3);
        setInterval(refreshFunding, 5 * 60e3);
        setInterval(track, 20e3);
        setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3);
        setInterval(selfPing, 10 * 60e3);
        lastScanSlot = Math.floor((Date.now() - 30000) / M15);
        runScan();
        setInterval(() => { const slot = Math.floor((Date.now() - 30000) / M15); if (slot > lastScanSlot) { lastScanSlot = slot; runScan(); } }, 5000);
        log('SOL SCALPER v1.1 hazır');
    } catch (e) { log('başlatma hatası', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { evaluate, signalHealth, entryAdvice, advance, CFG, _set: o => Object.assign(CFG, o) };
