'use strict';
// ============================================================
// SONER TRADE v9.23 — VOLUME BREAKOUT PRO
// v9.22 iskeleti korundu, strateji Volume Breakout v2'ye değişti
//   * 5m kırılım + hacim patlaması (3.5x)
//   * ADX > 22 (trend var mı)
//   * MACD momentum onayı
//   * RSI dar aralık (52-70 / 30-48)
//   * Trend 15m uyumlu
//   * Counter-trend yasak + korelasyon filtresi
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
const M1 = 60e3, M5 = 5 * M1, M15 = 15 * M1, H1 = 3600e3, D1 = 24 * H1;

const NON_CRYPTO = ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','USDE','SUSDE','USDS','USD1','PYUSD','USDD','FRAX','MIM','LUSD','GUSD','USDF','BUIDL','USTC','USDP','WBTC','WETH','WSTETH','STETH','RETH','CBETH','PAXG','XAUT','XAU','XAG','WTI','BRENT','CL','NG','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NVDA','AMD','INTC','ORCL','NFLX','DIS','IBM','SPY','QQQ','DIA','IWM','VTI','VOO','ARKK','TQQQ','SQQQ','SPXU','UPRO','SOXL','SOXS','VIX','USOIL','UKOIL','DXY'];

const CFG = {
    // ★ v9.23 Volume Breakout
    // Kırılım
    BREAKOUT_LOOKBACK: num('BREAKOUT_LOOKBACK', 48),       // 48 × 5m = 4 saat
    BREAKOUT_BUF_ATR: num('BREAKOUT_BUF_ATR', 0.2),        // kapanış seviyeden en az 0.2 ATR ötede
    MAX_EXT_ATR: num('MAX_EXT_ATR', 1.3),                  // seviyeden 1.3 ATR'den fazla uzaksa girme

    // Hacim
    MIN_VOL_RATIO: num('MIN_VOL_RATIO', 3.5),              // 30 mum ort. × 3.5
    MIN_BODY: num('MIN_BODY', 0.50),                       // mum gövdesi %50
    MIN_CLOSE_POS_LONG: num('MIN_CLOSE_POS_LONG', 0.65),   // LONG kapanış üst %35
    MAX_CLOSE_POS_SHORT: num('MAX_CLOSE_POS_SHORT', 0.35), // SHORT kapanış alt %35

    // ADX
    MIN_ADX: num('MIN_ADX', 22),

    // RSI
    RSI_LONG_MIN: num('RSI_LONG_MIN', 52),
    RSI_LONG_MAX: num('RSI_LONG_MAX', 70),
    RSI_SHORT_MIN: num('RSI_SHORT_MIN', 30),
    RSI_SHORT_MAX: num('RSI_SHORT_MAX', 48),

    // Risk
    STOP_ATR_K: num('STOP_ATR_K', 0.4),
    STOP_CANDLE_BUF_ATR: num('STOP_CANDLE_BUF_ATR', 0.1),
    TP1_R: num('TP1_R', 1.0),
    TP2_R: num('TP2_R', 2.5),
    MIN_RISK_PCT: num('MIN_RISK_PCT', 0.35),
    MAX_RISK_PCT: num('MAX_RISK_PCT', 3.5),
    COST_PCT: 0.12,
    MAX_COST_R: num('MAX_COST_R', 0.25),
    BE_AT_R: num('BE_AT_R', 0.7),

    // Zaman
    MAX_HOLD_MS: num('MAX_HOLD_MIN', 60) * 60e3,
    TIME_STOP_MS: num('TIME_STOP_MIN', 30) * 60e3,
    TIME_STOP_MFE: 0.25,
    COOLDOWN_MS: num('COOLDOWN_MIN', 45) * 60e3,

    // Portfolio
    MAX_OPEN_PER_DIR: num('MAX_OPEN_PER_DIR', 3),
    MAX_PER_SCAN: num('MAX_PER_SCAN', 2),
    MAX_SIGNAL_AGE_MS: 90 * 1000,

    // Universe
    UNIVERSE: num('UNIVERSE', 120),
    MIN_VOL_USDT: num('MIN_VOL', 15e6),

    EXCLUDED: NON_CRYPTO.concat((process.env.EXCLUDE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)),

    SCAN_MS: num('SCAN_MS', 60e3),
    CONCURRENCY: 6,
    TRACK_MS: 15e3,
    UNIVERSE_MS: 5 * M1,
    KEEP: 500,

    MIN_BREADTH_ACTIVE: num('MIN_BREADTH_ACTIVE', 20),
    BLOCK_COUNTER_MKT: flag('BLOCK_COUNTER_MKT', true),
    DISABLE_SHORT: flag('DISABLE_SHORT', false),
    BLOCK_MIXED_DIR: flag('BLOCK_MIXED_DIR', true),

    BT_DAYS_MAX: num('BT_DAYS_MAX', 30),
    BT_SLEEP_PER_COIN: num('BT_SLEEP_PER_COIN', 500),
    BT_SLEEP_PER_PAGE: num('BT_SLEEP_PER_PAGE', 250),
    BT_MAX_RETRY: num('BT_MAX_RETRY', 5),
    BT_USE_FUNDING: flag('BT_USE_FUNDING', false)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[SONER]', ...a);
const baseOf = s => s.split('/')[0];
const trDay = t => new Date(t + 3 * H1).toISOString().slice(0, 10);
const trHour = t => String(new Date(t + 3 * H1).getUTCHours()).padStart(2, '0') + ':00';
const session = t => { const h = new Date(t).getUTCHours(); return h < 7 ? '1 Asya' : h < 13 ? '2 Londra' : h < 21 ? '3 ABD' : '4 Gece'; };
const sessOf = s => session(s.candleT != null ? s.candleT : s.time - M1);
const costFor = vol => { const v = vol || 0; return v >= 200e6 ? 0.14 : v >= 50e6 ? 0.18 : v >= 10e6 ? 0.25 : 0.40; };
const closedOnly = (c, ms, now = Date.now()) => c.filter(x => x[0] + ms <= now);
const fmt = p => { const a = Math.abs(p); return a >= 1000 ? p.toFixed(2) : a >= 1 ? p.toFixed(4) : a >= 0.01 ? p.toFixed(5) : p.toFixed(7); };
const isMajor = s => /^(BTC|ETH)\//.test(s);

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
    g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * (p - 1) + Math.max(d, 0)) / p;
        l = (l * (p - 1) + Math.max(-d, 0)) / p;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
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
function macdHistSeries(cl) {
    const e12 = emaSeries(cl, 12), e26 = emaSeries(cl, 26), mv = [];
    for (let i = 0; i < cl.length; i++) mv.push(e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
    const clean = mv.filter(x => x != null);
    const sig = emaSeries(clean, 9);
    const out = new Array(cl.length).fill(null);
    let j = 0;
    for (let i = 0; i < cl.length; i++) {
        if (mv[i] == null) continue;
        if (sig[j] != null) out[i] = mv[i] - sig[j];
        j++;
    }
    return out;
}
function trendOfTF(c, fast = 21, slow = 50) {
    if (!c || c.length < slow + 3) return 0;
    const cl = c.map(x => x[4]);
    const ef = emaSeries(cl, fast), es = emaSeries(cl, slow);
    const n = cl.length - 1;
    if (ef[n] == null || es[n] == null) return 0;
    const sp = (ef[n] - es[n]) / cl[n] * 100;
    if (sp >= 0.05 && cl[n] > es[n]) return 1;
    if (sp <= -0.05 && cl[n] < es[n]) return -1;
    return 0;
}
function aggregate(c1, targetMs) {
    const g = new Map();
    for (const x of c1) {
        const k = Math.floor(x[0] / targetMs) * targetMs;
        let a = g.get(k);
        if (!a) { a = [k, x[1], x[2], x[3], x[4], x[5], 1]; g.set(k, a); }
        else { a[2] = Math.max(a[2], x[2]); a[3] = Math.min(a[3], x[3]); a[4] = x[4]; a[5] += x[5]; a[6]++; }
    }
    return [...g.values()].filter(a => a[6] === targetMs / M1);
}
// ★ YENİ: ADX
function adxLast(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 1) return null;
    const trs = [], plusDM = [], minusDM = [];
    for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i][2]), l = Number(candles[i][3]);
        const ph = Number(candles[i-1][2]), pl = Number(candles[i-1][3]), pc = Number(candles[i-1][4]);
        if (![h,l,ph,pl,pc].every(Number.isFinite)) continue;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const upMove = h - ph, dnMove = pl - l;
        plusDM.push((upMove > dnMove && upMove > 0) ? upMove : 0);
        minusDM.push((dnMove > upMove && dnMove > 0) ? dnMove : 0);
    }
    if (trs.length < period + 1) return null;
    let atrS = trs.slice(0, period).reduce((a,b)=>a+b,0);
    let pS = plusDM.slice(0, period).reduce((a,b)=>a+b,0);
    let mS = minusDM.slice(0, period).reduce((a,b)=>a+b,0);
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
        atrS = atrS - atrS / period + trs[i];
        pS = pS - pS / period + plusDM[i];
        mS = mS - mS / period + minusDM[i];
        const pDI = atrS > 0 ? 100 * pS / atrS : 0;
        const mDI = atrS > 0 ? 100 * mS / atrS : 0;
        const sum = pDI + mDI;
        dxs.push(sum > 0 ? 100 * Math.abs(pDI - mDI) / sum : 0);
    }
    if (dxs.length < period) return null;
    let adxV = dxs.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < dxs.length; i++) adxV = (adxV * (period - 1) + dxs[i]) / period;
    return adxV;
}

function marketContextScore(ctx, side) {
    let s = 0;
    if (ctx.btcDir === side) s += 4; else if (ctx.btcDir === 0) s += 2; else s -= 2;
    if (ctx.ethDir === side) s += 3; else if (ctx.ethDir === 0) s += 1;
    if (ctx.mkt === side) s += 3; else if (ctx.mkt === 0) s += 1; else s -= 2;
    return s;
}

// ============================================================
// ★ v9.23 VOLUME BREAKOUT MOTORU
// ============================================================
function newState() {
    return { lastSignalAt: 0 };
}

function stepState(sym, st, c1, c5, c15, ctx) {
    // Her 5m kapanışında tara
    if (c1.length < 20) return null;
    const last1 = c1[c1.length - 1];
    const now = last1[0];
    const is5mBoundary = (now + M1) % M5 === 0;
    if (!is5mBoundary) return null;

    if (c5.length < CFG.BREAKOUT_LOOKBACK + 5 || c15.length < 55) return null;

    const last5 = c5[c5.length - 1];
    const prior5 = c5.slice(0, -1);

    const open = last5[1], high = last5[2], low = last5[3], close = last5[4], vol = last5[5];
    if (![open, high, low, close, vol].every(Number.isFinite)) return null;

    const atr5 = atrLast(prior5, 14);
    if (!atr5 || atr5 <= 0) return null;

    // ★ Kırılım seviyesi: son N mumun high/low'u
    const lookback = Math.min(CFG.BREAKOUT_LOOKBACK, prior5.length);
    const recent = prior5.slice(-lookback);
    const brokenHigh = Math.max(...recent.map(x => x[2]));
    const brokenLow = Math.min(...recent.map(x => x[3]));

    // ★ Kırılım yönü
    let direction = 0, level = 0;
    const buf = atr5 * CFG.BREAKOUT_BUF_ATR;
    if (close > brokenHigh + buf && close > open) {
        direction = 1;
        level = brokenHigh;
    } else if (close < brokenLow - buf && close < open) {
        direction = -1;
        level = brokenLow;
    } else {
        return null;  // kırılım yok
    }

    if (direction === -1 && CFG.DISABLE_SHORT) return null;

    // ★ Hacim patlaması
    const avgVol = prior5.slice(-30).reduce((a, x) => a + Number(x[5]), 0) / Math.min(30, prior5.length);
    const volX = avgVol > 0 ? Number(vol) / avgVol : 0;
    if (volX < CFG.MIN_VOL_RATIO) return null;

    // ★ Mum gövdesi
    const rng = (high - low) || 1e-12;
    const body = Math.abs(close - open) / rng;
    if (body < CFG.MIN_BODY) return null;

    // ★ Kapanış pozisyonu
    const closePos = (close - low) / rng;
    if (direction === 1 && closePos < CFG.MIN_CLOSE_POS_LONG) return null;
    if (direction === -1 && closePos > CFG.MAX_CLOSE_POS_SHORT) return null;

    // ★ ADX trend filtresi
    const adxV = adxLast(prior5, 14);
    if (!adxV || adxV < CFG.MIN_ADX) return null;

    // ★ MACD momentum
    const closes5 = c5.map(x => x[4]);
    const macdArr = macdHistSeries(closes5);
    const macdHist = macdArr[macdArr.length - 1];
    const macdPrev = macdArr[macdArr.length - 2];
    if (direction === 1) {
        if (macdHist == null || macdHist <= 0) return null;
        if (macdPrev != null && macdHist < macdPrev) return null;  // momentum artmalı
    } else {
        if (macdHist == null || macdHist >= 0) return null;
        if (macdPrev != null && macdHist > macdPrev) return null;
    }

    // ★ RSI dar aralık
    const rsiArr = rsiSeries(closes5, 14);
    const rsiV = rsiArr[rsiArr.length - 1];
    if (rsiV == null) return null;
    if (direction === 1 && (rsiV < CFG.RSI_LONG_MIN || rsiV > CFG.RSI_LONG_MAX)) return null;
    if (direction === -1 && (rsiV < CFG.RSI_SHORT_MIN || rsiV > CFG.RSI_SHORT_MAX)) return null;

    // ★ Trend 15m uyumlu
    const t15 = trendOfTF(c15, 21, 50);
    if (t15 !== direction) return null;

    // ★ Counter-trend yasak
    if (CFG.BLOCK_COUNTER_MKT && ctx.mkt === -direction) return null;
    if (CFG.BLOCK_COUNTER_MKT && ctx.btcDir === -direction) return null;

    // ★ Aşırı uzama
    const ext = Math.abs(close - level) / atr5;
    if (ext > CFG.MAX_EXT_ATR) return null;

    // ★ Stop / TP
    const entry = close;
    let stop;
    if (direction === 1) {
        stop = Math.min(level - CFG.STOP_ATR_K * atr5, low - CFG.STOP_CANDLE_BUF_ATR * atr5);
    } else {
        stop = Math.max(level + CFG.STOP_ATR_K * atr5, high + CFG.STOP_CANDLE_BUF_ATR * atr5);
    }
    const risk = direction === 1 ? (entry - stop) : (stop - entry);
    if (!(risk > 0)) return null;
    const riskPct = risk / entry * 100;
    if (riskPct < CFG.MIN_RISK_PCT) return null;
    if (riskPct > CFG.MAX_RISK_PCT) return null;
    const costPct = ctx.costPct != null ? ctx.costPct : CFG.COST_PCT;
    const costR = costPct / riskPct;
    if (costR > CFG.MAX_COST_R) return null;

    // ★ Skor
    const mkScore = marketContextScore(ctx, direction);
    const qualityScore = Math.min(100, Math.round(
        (volX * 6) +                                    // hacim katkısı
        (Math.min(adxV, 50) * 1.2) +                    // ADX katkısı
        (body * 15) +                                   // mum gövdesi
        (closePos >= 0.75 || closePos <= 0.25 ? 10 : 5) + // kapanış kalitesi
        (mkScore > 0 ? 10 : 0)                          // piyasa uyumu
    ));
    if (qualityScore < 70) return null;

    const tp1 = entry + direction * risk * CFG.TP1_R;
    const tp2 = entry + direction * risk * CFG.TP2_R;

    const waveId = sym.replace(/[^A-Z0-9]/g, '') + '_' + direction + '_' + now;
    return {
        id: waveId + '_' + Date.now().toString(36),
        waveId,
        symbol: sym, base: baseOf(sym),
        dir: direction === 1 ? 'LONG' : 'SHORT',
        state: 'ENTRY', score: qualityScore,
        parts: {
            volume: Number(volX.toFixed(2)),
            adx: Number(adxV.toFixed(1)),
            body: Number(body.toFixed(2)),
            closePos: Number(closePos.toFixed(2)),
            market: mkScore,
            rsi: Number((rsiV || 0).toFixed(1))
        },
        setup: 'VB', setupName: 'Volume Breakout',
        entry, stop, initialStop: stop, tp1, tp2,
        tp1R: CFG.TP1_R, tp2R: CFG.TP2_R,
        riskPct, costR,
        volX: Number(volX.toFixed(2)), body: Number(body.toFixed(2)),
        atr: atr5, rsi: Number((rsiV || 0).toFixed(1)), adx: Number(adxV.toFixed(1)),
        macdHist: Number((macdHist || 0).toFixed(6)),
        funding: ctx.funding, mkt: ctx.mkt, btcDir: ctx.btcDir, ethDir: ctx.ethDir,
        time: now + M1, candleT: now,
        status: 'ACTIVE', stage: 'ENTRY',
        lastPrice: entry, mfe: 0, mae: 0,
        trackedTo: now,
        tsMs: CFG.TIME_STOP_MS, tsMfe: CFG.TIME_STOP_MFE,
        level: level,
        reason: 'vol ' + volX.toFixed(1) + 'x adx ' + adxV.toFixed(0) + ' rsi ' + (rsiV||0).toFixed(0) + ' body ' + body.toFixed(2)
    };
}

// ==================== EXIT ====================
const isOpen = s => s.status === 'ACTIVE' || s.status === 'TP1_HIT';
function rOf(s, price) { return (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / Math.abs(s.entry - s.initialStop); }
function closeSig(s, status, gross, t) { s.status = status; s.netR = Number((gross - s.costR).toFixed(3)); s.closedAt = t; }

function advance(s, k) {
    const L = s.dir === 'LONG', risk = Math.abs(s.entry - s.initialStop);
    const T1 = s.tp1R || CFG.TP1_R, T2 = s.tp2R || CFG.TP2_R;
    const tsMs = s.tsMs != null ? s.tsMs : CFG.TIME_STOP_MS, tsMfe = s.tsMfe != null ? s.tsMfe : CFG.TIME_STOP_MFE;
    const hiR = L ? (k[2] - s.entry) / risk : (s.entry - k[3]) / risk;
    const loR = L ? (k[3] - s.entry) / risk : (s.entry - k[2]) / risk;
    s.mfe = Math.max(s.mfe || 0, hiR); s.mae = Math.min(s.mae || 0, loR);
    s.lastPrice = k[4];
    const hitStop = L ? k[3] <= s.stop : k[2] >= s.stop;
    const hitTp1 = L ? k[2] >= s.tp1 : k[3] <= s.tp1;
    const hitTp2 = L ? k[2] >= s.tp2 : k[3] <= s.tp2;
    const el = k[0] - s.time;

    if (s.status === 'ACTIVE' && !s.beLocked && CFG.BE_AT_R > 0) {
        const trig = L ? (k[2] - s.entry) / risk : (s.entry - k[3]) / risk;
        if (trig >= CFG.BE_AT_R) { s.stop = s.entry; s.beLocked = true; }
    }

    if (s.status === 'ACTIVE') {
        if (hitStop) { closeSig(s, 'STOP', s.beLocked ? 0 : -1, k[0] + 60e3); return true; }
        if (hitTp1) { s.status = 'TP1_HIT'; s.stop = s.entry; s.tp1At = k[0]; return true; }
        if (el >= tsMs && s.mfe < tsMfe) { closeSig(s, 'TIMEOUT', rOf(s, k[4]), k[0] + 60e3); return true; }
    } else if (s.status === 'TP1_HIT' && k[0] > s.tp1At) {
        if (hitStop) { closeSig(s, 'BE', 0.5 * T1, k[0] + 60e3); return true; }
        if (hitTp2) { closeSig(s, 'TP2', 0.5 * T1 + 0.5 * T2, k[0] + 60e3); return true; }
    }
    if (el >= CFG.MAX_HOLD_MS && isOpen(s)) {
        const r = rOf(s, k[4]); closeSig(s, 'TIMEOUT', s.status === 'TP1_HIT' ? 0.5 * T1 + 0.5 * r : r, k[0] + 60e3); return true;
    }
    return false;
}

// ==================== SAĞLIK ====================
function signalHealth(s, livePrice) {
    if (!isOpen(s)) return null;
    const risk = Math.abs(s.entry - s.initialStop);
    if (!risk) return null;
    const L = s.dir === 'LONG';
    const price = livePrice || s.lastPrice || s.entry;
    const R = (L ? 1 : -1) * (price - s.entry) / risk;
    const el = Date.now() - s.time, minAge = el / 60000;
    const mfe = s.mfe || 0;
    let score = 50; const reasons = [];
    if (R >= 0.6) { score += 30; reasons.push('Kâr'); }
    else if (R >= 0.25) { score += 15; reasons.push('Kârda'); }
    else if (R >= -0.25) { }
    else if (R >= -0.55) { score -= 15; reasons.push('Zarar'); }
    else { score -= 30; reasons.push('Stop yakın'); }
    if (mfe > 0.3 && (mfe - R) > 0.4) { score -= 15; reasons.push('Momentum kaybı'); }
    if (minAge > 20 && mfe < 0.3) { score -= 15; reasons.push('İlerleme yok'); }
    score = Math.max(0, Math.min(100, score));
    if (minAge < 8 && score < 55) { score = 55; reasons.unshift('Taze'); }
    let status, color, advice;
    if (score >= 75) { status = 'GÜÇLÜ TUT'; color = 'g'; advice = 'Tut.'; }
    else if (score >= 60) { status = 'TUT'; color = 'g'; advice = 'İzle.'; }
    else if (score >= 45) { status = 'DİKKAT'; color = 'w'; advice = 'Yakından izle.'; }
    else if (score >= 30) { status = 'ZAYIF'; color = 'w'; advice = 'Çıkış düşün.'; }
    else { status = 'ÇIK'; color = 'r'; advice = 'Kapat.'; }
    return { score, status, color, advice, reason: reasons.slice(0, 2).join(' • ') || 'Normal', R: Number(R.toFixed(2)), mfe: Number(mfe.toFixed(2)), mae: Number((s.mae || 0).toFixed(2)), hAge: Number((el / H1).toFixed(2)) };
}
function entryAdvice(s) {
    const risk = Math.abs(s.entry - s.initialStop);
    if (!risk) return null;
    const minAge = (Date.now() - s.time) / 60000;
    const price = s.lastPrice || s.entry;
    const drift = (s.dir === 'LONG' ? 1 : -1) * (price - s.entry) / risk;
    if (s.health && (s.health.status === 'ZAYIF' || s.health.status === 'ÇIK')) return { status: 'GİRME', color: 'r', reason: 'Sağlık zayıf' };
    if (minAge < 3 && Math.abs(drift) < 0.2) return { status: 'GİR', color: 'g', reason: 'Taze' };
    if (drift > 0.5) return { status: 'KAÇIRILDI', color: 'w', reason: 'Geç' };
    if (drift < -0.5) return { status: 'GİRME', color: 'r', reason: 'Ters' };
    if (minAge > 15) return { status: 'GEÇ', color: 'w', reason: 'Eski' };
    return { status: 'GİR', color: 'g', reason: 'Uygun' };
}

// ==================== İSTATİSTİK ====================
function grp(list) {
    const n = list.length;
    if (!n) return { n: 0, win: 0, realWin: 0, avgR: 0, totalR: 0, pf: 0, dd: 0, se: 0, t: 0, ci: 0, med: 0, avgHold: 0, avgMfe: 0, avgMae: 0 };
    let tot = 0, w = 0, rw = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0, sq = 0, holdSum = 0, mfeSum = 0, maeSum = 0;
    const rs = [];
    for (const s of list) {
        tot += s.netR; if (s.netR > 0) { w++; gp += s.netR; } else gl -= s.netR;
        if (s.netR > 0.5) rw++;
        eq += s.netR; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq);
        sq += s.netR * s.netR; rs.push(s.netR);
        if (s.closedAt && s.time) holdSum += (s.closedAt - s.time);
        if (s.mfe != null) mfeSum += s.mfe;
        if (s.mae != null) maeSum += s.mae;
    }
    const avg = tot / n;
    rs.sort((a, b) => a - b);
    const med = rs[Math.floor(n / 2)];
    let se = 0, t = 0, ci = 0;
    if (n > 1) { const v = Math.max(0, (sq - n * avg * avg) / (n - 1)); se = Math.sqrt(v / n); t = se > 0 ? avg / se : 0; ci = 1.96 * se; }
    return { n, win: w / n, realWin: rw / n, avgR: avg, totalR: tot, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd, se: Number(se.toFixed(4)), t: Number(t.toFixed(2)), ci: Number(ci.toFixed(3)), med, avgHold: Number((holdSum / n / 60000).toFixed(1)), avgMfe: Number((mfeSum / n).toFixed(2)), avgMae: Number((maeSum / n).toFixed(2)) };
}
function groupBy(list, fn) { const m = {}; for (const s of list) { const k = fn(s); (m[k] = m[k] || []).push(s); } const o = {}; Object.keys(m).sort().forEach(k => { o[k] = grp(m[k]); }); return o; }
const band = s => s.score >= 90 ? '90-100' : s.score >= 80 ? '80-89' : s.score >= 70 ? '70-79' : '60-69';
const mktName = s => s.mkt === 1 ? 'Piyasa LONG' : s.mkt === -1 ? 'Piyasa SHORT' : 'Piyasa YATAY';
const volBucket = s => s.volX == null ? 'yok' : s.volX < 3.5 ? '1 <3.5x' : s.volX < 5 ? '2 3.5-5x' : s.volX < 8 ? '3 5-8x' : s.volX < 12 ? '4 8-12x' : '5 12x+';
const adxBucket = s => s.adx == null ? 'yok' : s.adx < 22 ? '1 <22' : s.adx < 28 ? '2 22-28' : s.adx < 35 ? '3 28-35' : '4 35+';
const mfeBucket = s => s.mfe == null ? 'yok' : s.mfe < 0.3 ? '1 <0.3' : s.mfe < 0.5 ? '2 0.3-0.5' : s.mfe < 1 ? '3 0.5-1' : s.mfe < 2 ? '4 1-2' : '5 2+';
function calcStats(closed, todayKey) {
    const sorted = closed.slice().sort((a, b) => a.closedAt - b.closedAt);
    return {
        all: grp(sorted), today: grp(sorted.filter(s => trDay(s.closedAt) === todayKey)),
        bySetup: groupBy(sorted, s => s.setupName), byDir: groupBy(sorted, s => s.dir),
        byBand: groupBy(sorted, band), bySession: groupBy(sorted, sessOf),
        byMkt: groupBy(sorted, mktName), byExit: groupBy(sorted, s => s.status),
        byVol: groupBy(sorted, volBucket), byAdx: groupBy(sorted, adxBucket),
        byMfe: groupBy(sorted, mfeBucket), byHour: groupBy(sorted, s => trHour(s.time))
    };
}

// ==================== DURUM ====================
const ex = new ccxt.bitget({ enableRateLimit: true, rateLimit: 200, options: { defaultType: 'swap' } });
let signals = [], lastSig = {}, lastWave = {}, universe = [], tickers = {}, radar = [], market = { btc: null, eth: null, mood: null };
let scan = { last: 0, ms: 0, running: false, reasons: {}, reasonDay: '', total: 0, eligible: 0 }, dirty = false, btcCtx = { dir: 0 }, ethCtx = { dir: 0 };
let mktDir = 0, tracking = false;
let btJob = { running: false, msg: '', done: 0, total: 0, result: null, error: null };
const c1Cache = new Map(), stateMap = new Map();
const c5Cache = new Map(), c15Cache = new Map();

function loadState() {
    try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); signals = j.signals || []; lastSig = j.lastSig || {}; lastWave = j.lastWave || {}; log('durum:', signals.length); } catch (e) { log('temiz başlangıç.'); }
}
function saveState() {
    if (!dirty) return; dirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ signals, lastSig, lastWave })); fs.renameSync(tmp, STATE_FILE); } catch (e) { log('kayıt hatası', e.message); }
}
async function telegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }) }); } catch (e) { }
}
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
        const all = Object.values(tickers).filter(t => t && t.symbol && t.symbol.endsWith(':USDT') && ex.markets[t.symbol] && ex.markets[t.symbol].linear);
        const ok = all.filter(t => {
            const base = baseOf(t.symbol).toUpperCase();
            if (CFG.EXCLUDED.includes(base)) return false;
            if ((t.quoteVolume || 0) < CFG.MIN_VOL_USDT) return false;
            if (isSuspect(t.symbol)) return false;
            return true;
        });
        const top = ok.slice().sort((x, y) => (y.quoteVolume || 0) - (x.quoteVolume || 0)).slice(0, CFG.UNIVERSE).map(t => t.symbol);
        for (const s of ['BTC/USDT:USDT', 'ETH/USDT:USDT']) if (!top.includes(s)) top.push(s);
        universe = top;
        scan.total = all.length; scan.eligible = ok.length;
    } catch (e) { log('evren hatası', e.message); }
}
async function fetchOHLCVsafe(sym, tf, limit) {
    let r = null, retry = 0;
    while (retry < 3) { try { r = await ex.fetchOHLCV(sym, tf, undefined, limit); break; } catch (e) { retry++; await sleep(500 * retry); } }
    return r || [];
}
async function getCandles(sym, tf) {
    const now = Date.now();
    if (tf === '1m') { const h = c1Cache.get(sym); if (h && now - h.t < 30e3) return h.c; const c = closedOnly(await fetchOHLCVsafe(sym, '1m', 500), M1); c1Cache.set(sym, { t: now, c }); return c; }
    if (tf === '5m') { const h = c5Cache.get(sym); if (h && now - h.t < 3 * 60e3) return h.c; const c = closedOnly(await fetchOHLCVsafe(sym, '5m', 300), M5); c5Cache.set(sym, { t: now, c }); return c; }
    if (tf === '15m') { const h = c15Cache.get(sym); if (h && now - h.t < 5 * 60e3) return h.c; const c = closedOnly(await fetchOHLCVsafe(sym, '15m', 150), M15); c15Cache.set(sym, { t: now, c }); return c; }
    return [];
}

// ==================== SCAN ====================
async function runScan() {
    if (scan.running || !universe.length) return;
    scan.running = true;
    const t0 = Date.now(), day = trDay(t0);
    if (scan.reasonDay !== day) { scan.reasons = {}; scan.reasonDay = day; }
    try {
        const b15 = await getCandles('BTC/USDT:USDT', '15m');
        btcCtx.dir = trendOfTF(b15, 21, 50);
        const e15 = await getCandles('ETH/USDT:USDT', '15m');
        ethCtx.dir = trendOfTF(e15, 21, 50);
        market.btc = Object.assign(market.btc || {}, { dir: btcCtx.dir });
        market.eth = Object.assign(market.eth || {}, { dir: ethCtx.dir });

        const trends = {}; let idx = 0;
        const worker = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try { const c15 = await getCandles(sym, '15m'); if (c15.length >= 55) trends[sym] = trendOfTF(c15, 21, 50); } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker));
        let up = 0, dn = 0;
        for (const k in trends) { if (trends[k] === 1) up++; else if (trends[k] === -1) dn++; }
        const active = up + dn;
        let breadth = 0;
        if (active >= CFG.MIN_BREADTH_ACTIVE) breadth = ((up - dn) / active) * 6;
        mktDir = btcCtx.dir === 1 && ethCtx.dir === 1 ? 1 : btcCtx.dir === -1 && ethCtx.dir === -1 ? -1 :
            (2 * btcCtx.dir + ethCtx.dir + breadth) >= 2 ? 1 : (2 * btcCtx.dir + ethCtx.dir + breadth) <= -2 ? -1 : 0;
        market.mood = { label: mktDir === 1 ? 'LONG' : mktDir === -1 ? 'SHORT' : 'YATAY', up, down: dn, active, breadth: Number(breadth.toFixed(2)), btcDir: btcCtx.dir, ethDir: ethCtx.dir };

        const newSignals = [];
        idx = 0;
        const worker2 = async () => {
            while (idx < universe.length) {
                const sym = universe[idx++];
                try {
                    const [c1, c5, c15] = await Promise.all([getCandles(sym, '1m'), getCandles(sym, '5m'), getCandles(sym, '15m')]);
                    if (c1.length < 20) return;
                    let st = stateMap.get(sym);
                    if (!st) { st = newState(); stateMap.set(sym, st); }
                    const t = tickers[sym] || {};
                    const sig = stepState(sym, st, c1, c5, c15, { btcDir: btcCtx.dir, ethDir: ethCtx.dir, mkt: mktDir, funding: null, costPct: costFor(t.quoteVolume) });
                    if (sig) newSignals.push(sig);
                } catch (e) { }
            }
        };
        await Promise.all(Array.from({ length: CFG.CONCURRENCY }, worker2));

        newSignals.sort((a, b) => b.score - a.score);
        let added = 0;
        for (const s of newSignals) {
            if (added >= CFG.MAX_PER_SCAN) break;
            const waveKey = s.base + '_' + s.dir + '_' + s.candleT;
            if (lastWave[waveKey]) continue;
            if (signals.some(x => x.symbol === s.symbol && isOpen(x))) continue;
            if (Date.now() - (lastSig[s.symbol] || 0) < CFG.COOLDOWN_MS) { scan.reasons['cooldown'] = (scan.reasons['cooldown'] || 0) + 1; continue; }
            if (CFG.BLOCK_MIXED_DIR) {
                const oppDir = s.dir === 'LONG' ? 'SHORT' : 'LONG';
                const oppCount = signals.filter(x => isOpen(x) && x.dir === oppDir).length;
                if (oppCount > 0) { scan.reasons['korelasyon'] = (scan.reasons['korelasyon'] || 0) + 1; continue; }
            }
            if (signals.filter(x => isOpen(x) && x.dir === s.dir).length >= CFG.MAX_OPEN_PER_DIR) { scan.reasons['portfolio'] = (scan.reasons['portfolio'] || 0) + 1; continue; }
            signals.unshift(s); lastSig[s.symbol] = Date.now(); lastWave[waveKey] = Date.now();
            added++; dirty = true;
            log('🟢 ENTRY', s.dir, s.symbol, 'score', s.score, '|', s.reason);
            telegram('🟢 ENTRY ' + s.dir + ' ' + s.base + '\nQ ' + s.score + ' (vol ' + s.parts.volume + 'x adx ' + s.parts.adx + ' body ' + s.parts.body + ')\nGiriş ' + fmt(s.entry) + '\nStop ' + fmt(s.stop) + ' (' + s.riskPct.toFixed(2) + '%)\nTP1 ' + fmt(s.tp1) + ' | TP2 ' + fmt(s.tp2));
        }
        radar = [];
        for (const [sym, st] of stateMap) {
            if (st.state === 'IDLE') continue;
            radar.push({ symbol: sym, base: baseOf(sym), price: 0, rsi: 0, bias: st.dir === 1 ? 'LONG' : 'SHORT', state: st.state, score: 0, btcDir: btcCtx.dir, ethDir: ethCtx.dir, mkt: mktDir, chg24: 0 });
        }
        radar.sort((a, b) => b.score - a.score);
        radar = radar.slice(0, 40);

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
                const raw = await ex.fetchOHLCV(s.symbol, '1m', s.trackedTo, 200);
                const c = closedOnly(raw, M1);
                for (const k of c) {
                    if (k[0] <= s.trackedTo) continue;
                    s.trackedTo = k[0]; dirty = true;
                    if (advance(s, k) && !isOpen(s)) break;
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
        if (isOpen(s)) { const h = signalHealth(s, s.lastPrice); const es = Object.assign({}, s, { health: h }); const ea = entryAdvice(es); return Object.assign({}, s, { health: h, entryAdvice: ea }); }
        return s;
    });
    const states = {};
    for (const [sym, st2] of stateMap) { if (st2.state !== 'IDLE') states[sym] = st2.state; }
    return { now, mode: 'VB v9.23 (Volume Breakout 5m)',
        market, signals: enriched, radar, stats: st, equity: eq,
        filters: {
            tp1: CFG.TP1_R, tp2: CFG.TP2_R, maxHold: CFG.MAX_HOLD_MS / 60000,
            cooldown: CFG.COOLDOWN_MS / 60000, minVol: CFG.MIN_VOL_RATIO,
            minAdx: CFG.MIN_ADX, minBody: CFG.MIN_BODY, minRsi: CFG.RSI_LONG_MIN,
            maxRsi: CFG.RSI_LONG_MAX, beAtR: CFG.BE_AT_R
        },
        scan: { last: scan.last, ms: scan.ms, reasons: scan.reasons, universe: universe.length, total: scan.total, eligible: scan.eligible },
        states };
}
async function apiCandles(sym) {
    if (!ex.markets[sym]) throw new Error('bilinmeyen sembol');
    const c = await ex.fetchOHLCV(sym, '15m', undefined, 200);
    const cl = c.map(x => x[4]), e21 = emaSeries(cl, 21), e50 = emaSeries(cl, 50), N = 120, cut = Math.max(0, c.length - N);
    return { c: c.slice(cut), e21: e21.slice(cut), e50: e50.slice(cut) };
}

// ==================== BACKTEST ====================
async function fetchHistory1m(sym, days, log_) {
    const expected = Math.floor(days * 24 * 60);
    const endTarget = Date.now() - M1;
    const startTarget = endTarget - days * D1;
    const allMap = new Map();
    let endMs = endTarget, guard = 0;
    while (allMap.size < expected && guard++ < 600) {
        const since = Math.max(startTarget, endMs - 999 * M1);
        let r = null, retry = 0;
        while (retry < CFG.BT_MAX_RETRY) {
            try { r = await ex.fetchOHLCV(sym, '1m', since, 1000); break; }
            catch (e) { const m = String(e.message || ''); if (m.includes('429') || m.includes('rate')) { retry++; await sleep(2000 * retry); } else break; }
        }
        if (!r || !r.length) break;
        let added = 0;
        for (const x of r) if (x[0] < endMs && !allMap.has(x[0])) { allMap.set(x[0], x); added++; }
        if (added === 0) break;
        if (r[0][0] <= since) break;
        endMs = r[0][0] - M1;
        await sleep(CFG.BT_SLEEP_PER_PAGE);
    }
    const clean = [...allMap.values()].sort((a, b) => a[0] - b[0]);
    const cov = expected > 0 ? clean.length / expected : 0;
    if (log_) log_('  ' + baseOf(sym) + ': ' + clean.length + '/' + expected + ' (' + (cov * 100).toFixed(1) + '%)');
    return { c: clean, coverage: cov, count: clean.length, expected };
}

function simulateBT(pre, use, maps, opts, startT) {
    const raw = [], funnel = {};
    for (const sym of use) {
        const P = pre[sym];
        const c1 = P.c1, c5 = P.c5, c15 = P.c15;
        if (c1.length < 100 || c5.length < CFG.BREAKOUT_LOOKBACK + 5 || c15.length < 55) continue;
        let p5 = 0, p15 = 0;
        const st = newState();
        let busyUntil = 0;
        let lastSigT = 0;
        for (let i = 40; i < c1.length - 2; i++) {
            const t = c1[i][0];
            if (t < startT || t < busyUntil) continue;
            while (p5 < c5.length && c5[p5][0] + M5 <= t + M1) p5++;
            while (p15 < c15.length && c15[p15][0] + M15 <= t + M1) p15++;
            if (p5 < CFG.BREAKOUT_LOOKBACK + 5 || p15 < 55) continue;
            const w1 = c1.slice(Math.max(0, i - 199), i + 1);
            const w5 = c5.slice(0, p5);
            const w15 = c15.slice(0, p15);
            const ctx = { btcDir: maps.btc.get(t) || 0, ethDir: maps.eth.get(t) || 0, mkt: maps.mkt.get(t) || 0, costPct: P.costPct, funding: opts.useFunding ? (P.fundingMap ? P.fundingMap.get(t) : null) : null };
            const sig = stepState(sym, st, w1, w5, w15, ctx);
            if (!sig) continue;
            funnel['sinyal'] = (funnel['sinyal'] || 0) + 1;
            const wk = sig.base + '_' + sig.dir + '_' + sig.candleT;
            if (P.waves && P.waves.has(wk)) { funnel['wave_dup'] = (funnel['wave_dup'] || 0) + 1; continue; }
            if (!P.waves) P.waves = new Set();
            P.waves.add(wk);
            if (lastSigT && (t - lastSigT) < CFG.COOLDOWN_MS) { funnel['cooldown'] = (funnel['cooldown'] || 0) + 1; continue; }
            lastSigT = t;
            sig.status = 'ACTIVE'; sig.mfe = 0; sig.mae = 0; sig.lastPrice = sig.entry;
            for (let j = i + 1; j < c1.length; j++) {
                if (advance(sig, c1[j]) && !isOpen(sig)) { sig.closedAt = c1[j][0] + M1; break; }
            }
            if (isOpen(sig)) continue;
            raw.push({ symbol: sig.symbol, base: sig.base, dir: sig.dir, setupName: sig.setupName, score: sig.score, time: sig.time, candleT: sig.candleT, closedAt: sig.closedAt, netR: sig.netR, status: sig.status, mkt: sig.mkt, mfe: sig.mfe, mae: sig.mae, volX: sig.volX, rsi: sig.rsi, adx: sig.adx, riskPct: sig.riskPct, parts: sig.parts });
            busyUntil = sig.closedAt;
        }
    }
    raw.sort((a, b) => a.time - b.time || b.score - a.score);
    const trades = [], openList = [], slotCnt = {}; let blocked = 0;
    for (const t of raw) {
        for (let q = openList.length - 1; q >= 0; q--) if (openList[q].closedAt <= t.time) openList.splice(q, 1);
        const slot = Math.floor(t.time / M1);
        if (openList.filter(o => o.dir === t.dir).length >= CFG.MAX_OPEN_PER_DIR) { blocked++; continue; }
        if (CFG.BLOCK_MIXED_DIR) {
            const oppDir = t.dir === 'LONG' ? 'SHORT' : 'LONG';
            if (openList.some(o => o.dir === oppDir)) { blocked++; continue; }
        }
        slotCnt[slot] = (slotCnt[slot] || 0) + 1; openList.push(t); trades.push(t);
    }
    funnel['portföy'] = blocked;
    return { trades, raw, funnel };
}
const split3 = tr => { const n = tr.length, a = Math.floor(n * 0.5), b = Math.floor(n * 0.75); return { all: grp(tr), is: grp(tr.slice(0, a)), val: grp(tr.slice(a, b)), oos: grp(tr.slice(b)) }; };

async function runBacktest(days, coins, opts) {
    if (btJob.running) return;
    if (days > CFG.BT_DAYS_MAX) days = CFG.BT_DAYS_MAX;
    opts = Object.assign({ costMult: 1, useFunding: CFG.BT_USE_FUNDING }, opts || {});
    btJob = { running: true, msg: 'Hazırlanıyor', done: 0, total: 1, result: null, error: null };
    try {
        if (!universe.length) await refreshUniverse();
        const BTC = 'BTC/USDT:USDT', ETH = 'ETH/USDT:USDT';
        const syms = universe.filter(s => !isMajor(s) || s === ETH).filter(s => s !== BTC).slice(0, coins);
        const all = [BTC].concat(syms.includes(ETH) ? [] : [ETH], syms);
        btJob.total = all.length;
        const data = {}, coverage = {}, skipped = [];
        for (const s of all) {
            btJob.msg = '1m veri: ' + baseOf(s);
            const h = await fetchHistory1m(s, days, m => log(m));
            coverage[s] = { count: h.count, expected: h.expected, coverage: Number(h.coverage.toFixed(3)) };
            if (h.coverage < 0.7 && !isMajor(s)) skipped.push({ symbol: s, reason: 'veri ' + (h.coverage * 100).toFixed(0) + '%' });
            else data[s] = h.c;
            btJob.done++;
            await sleep(CFG.BT_SLEEP_PER_COIN);
        }
        if (!data[BTC] || data[BTC].length < 2000) throw new Error('BTC 1m verisi yetersiz');
        const use = Object.keys(data).filter(s => s !== BTC);
        const C5 = {}, C15 = {};
        for (const s of Object.keys(data)) { C5[s] = aggregate(data[s], M5); C15[s] = aggregate(data[s], M15); }
        const tmap = {};
        for (const s of Object.keys(data)) {
            const c = C15[s], m = new Map();
            for (let i = 55; i < c.length; i++) m.set(c[i][0], trendOfTF(c.slice(Math.max(0, i - 59), i + 1), 21, 50));
            tmap[s] = m;
        }
        const maps = { mkt: new Map(), btc: new Map(), eth: new Map() };
        for (const x of C15[BTC]) {
            const t = x[0]; let up = 0, dn = 0;
            for (const s of Object.keys(data)) { const v = tmap[s].get(t); if (v === undefined) continue; if (v === 1) up++; else if (v === -1) dn++; }
            const bd = tmap[BTC].get(t) || 0, ed = tmap[ETH] ? (tmap[ETH].get(t) || 0) : 0;
            maps.btc.set(t, bd); maps.eth.set(t, ed);
            const act = up + dn;
            const brd = act >= CFG.MIN_BREADTH_ACTIVE ? ((up - dn) / act) * 6 : 0;
            maps.mkt.set(t, bd === 1 && ed === 1 ? 1 : bd === -1 && ed === -1 ? -1 : (2 * bd + ed + brd) >= 2 ? 1 : (2 * bd + ed + brd) <= -2 ? -1 : 0);
        }
        const pre = {};
        for (const s of use) pre[s] = { c1: data[s], c5: C5[s], c15: C15[s], costPct: costFor((tickers[s] || {}).quoteVolume) };
        btJob.msg = 'Simülasyon (1m)...';
        const startT = Date.now() - days * D1;
        const r = simulateBT(pre, use, maps, opts, startT);
        const sp3 = split3(r.trades);
        btJob.result = {
            days, coins, skipped, coverage, funnel: r.funnel, rawN: r.raw.length,
            all: sp3.all, is: sp3.is, val: sp3.val, oos: sp3.oos,
            bySetup: groupBy(r.trades, s => s.setupName), byDir: groupBy(r.trades, s => s.dir),
            byBand: groupBy(r.trades, band), byExit: groupBy(r.trades, s => s.status),
            bySession: groupBy(r.trades, sessOf), byMkt: groupBy(r.trades, mktName),
            byVol: groupBy(r.trades, volBucket), byAdx: groupBy(r.trades, adxBucket),
            byMfe: groupBy(r.trades, mfeBucket),
            byCoin: groupBy(r.trades, s => s.base),
            byWeek: groupBy(r.trades, s => 'H' + String(Math.floor((s.time - startT) / (7 * D1)) + 1).padStart(2, '0'))
        };
        btJob.msg = 'Tamamlandı';
    } catch (e) { btJob.error = 'Test: ' + e.message; log('BT hata', e.message); }
    btJob.running = false;
}

// ==================== HTML ====================
const HTML = String.raw`<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SONER v9.23 VB</title>
<style>
:root{--bg:#0c1117;--p1:#141b24;--p2:#1a2430;--ln:#243040;--tx:#e6ebf2;--dm:#8593a5;--lg:#3ddc97;--st:#ff6b7a;--am:#f2b84b;--tv:#2962ff;--bl:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{background:var(--bg);color:var(--tx);font:13px/1.45 system-ui,sans-serif;font-variant-numeric:tabular-nums}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
.app{display:flex;flex-direction:column;height:100vh}
.top{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--p1);border-bottom:1px solid var(--ln);flex-wrap:wrap}
.brand{font-weight:800;font-size:15px}.brand small{color:var(--am);margin-left:8px;font-size:11px}
.chip{display:flex;gap:6px;align-items:center;background:var(--bg);border:1px solid var(--ln);padding:4px 9px;border-radius:6px;font-size:12px}
.chip b{color:var(--dm);font-weight:600}.up{color:var(--lg)}.dn{color:var(--st)}.fl{color:var(--dm)}
.grow{flex:1}
.gate{display:flex;gap:12px;align-items:center;padding:6px 14px;border-radius:8px;border:1px solid var(--ln);min-width:280px}
.gate .g1{font-size:16px;font-weight:800}.gate .g2{font-size:11px;color:var(--dm)}
.gate.ok{border-color:rgba(61,220,151,.5);background:rgba(61,220,151,.09)}.gate.ok .g1{color:var(--lg)}
.gate.wait{border-color:rgba(242,184,75,.5);background:rgba(242,184,75,.08)}.gate.wait .g1{color:var(--am)}
.gate.stop{border-color:rgba(255,107,122,.6);background:rgba(255,107,122,.1)}.gate.stop .g1{color:var(--st)}
.clock{font-size:20px;font-weight:700}
.ibtn{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:5px 9px;color:var(--dm)}.ibtn.on{color:var(--am);border-color:var(--am)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--st);display:inline-block;margin-right:5px}.dot.on{background:var(--lg)}
.body{flex:1;display:flex;min-height:0}
.side{width:420px;background:var(--p1);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--ln)}
.tab{flex:1;padding:11px 2px;background:none;border:none;border-bottom:2px solid transparent;color:var(--dm);font-weight:700;font-size:12px}
.tab.a{color:var(--tx);border-bottom-color:var(--am)}.tab i{font-style:normal;background:var(--p2);border-radius:9px;padding:0 6px;margin-left:4px;font-size:10px}
.list{flex:1;overflow:auto;padding:8px}
.main{flex:1;overflow:auto;padding:16px;min-width:0}
.card{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;position:relative}
.card:hover{border-color:#34455a}.card.sel{border-color:var(--am)}.card.closed{opacity:.72}
.card-tv{position:absolute;top:8px;right:8px;background:var(--tv);color:#fff;border-radius:4px;padding:3px 8px;font-size:10px;font-weight:700;text-decoration:none;z-index:2}
.r1{display:flex;align-items:center;gap:8px;padding-right:60px;flex-wrap:wrap}
.badge{font-weight:800;font-size:11px;padding:2px 7px;border-radius:4px}
.badge.L{background:rgba(61,220,151,.16);color:var(--lg)}.badge.S{background:rgba(255,107,122,.16);color:var(--st)}
.coin{font-weight:800;font-size:14px}.pnl-big{font-weight:900;font-size:15px;margin-left:auto;margin-right:4px}
.sub{color:var(--dm);font-size:11px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}.sub b{color:var(--tx)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--ln);color:var(--dm)}
.tag.w{color:var(--am);border-color:rgba(242,184,75,.4)}.tag.g{color:var(--lg);border-color:rgba(61,220,151,.4)}.tag.r{color:var(--st);border-color:rgba(255,107,122,.4)}
.tag.entry{background:rgba(61,220,151,.2);color:var(--lg);border-color:rgba(61,220,151,.6);font-weight:800}
.tag.vb{background:rgba(90,169,255,.2);color:var(--bl);border-color:rgba(90,169,255,.6);font-weight:800}
h2{font-size:15px;margin-bottom:10px}h3{font-size:12px;color:var(--dm);margin:14px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:10px 12px}
.tile .k{color:var(--dm);font-size:11px}.tile .v{font-size:22px;font-weight:800;margin-top:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.box{background:var(--p2);border:1px solid var(--ln);border-radius:8px;padding:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}
th{color:var(--dm);font-weight:600;text-align:left;font-size:11px;padding:4px 6px;border-bottom:1px solid var(--ln)}
td{padding:5px 6px;border-bottom:1px solid rgba(36,48,64,.6)}td.n,th.n{text-align:right}
.lv{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin:10px 0}
.lv div{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.lv span{display:block;font-size:10px;color:var(--dm)}.lv b{font-size:14px}
canvas{width:100%;height:340px;display:block;background:var(--bg);border:1px solid var(--ln);border-radius:8px}
.frm{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
.frm input,.frm select{background:var(--bg);border:1px solid var(--ln);border-radius:6px;padding:6px 8px}
.frm input{width:110px}
.btn{background:var(--am);color:#1a1405;border:none;border-radius:6px;padding:7px 12px;font-weight:800}
.btn.g{background:var(--p1);color:var(--tx);border:1px solid var(--ln)}
.btn.tv{background:var(--tv);color:#fff;text-decoration:none;padding:7px 14px;border-radius:6px;font-weight:700}
.mut{color:var(--dm)}.note{font-size:11px;color:var(--dm);margin-top:8px}
.warn{background:rgba(242,184,75,.08);border:1px solid rgba(242,184,75,.4);border-radius:6px;padding:8px 10px;margin:6px 0;font-size:11px;color:var(--am)}
.health-box{border:1.5px solid;border-radius:8px;padding:10px 12px;margin-top:8px;display:flex;align-items:center;gap:12px}
.health-box .hs{font-size:28px;font-weight:900}.health-box .hl{font-size:11px;color:var(--dm)}
@media(max-width:900px){.body{flex-direction:column}.side{width:100%;height:48vh}.grid2{grid-template-columns:1fr}}
</style></head><body>
<div class="app">
 <div class="top">
  <div class="brand">SONER TRADE<small id="modeB">v9.23 VB</small></div>
  <div class="chip" id="cMkt"></div><div class="chip" id="cBTC"></div><div class="chip" id="cETH"></div>
  <div class="grow"></div>
  <div class="gate" id="gate"><div><div class="clock" id="clock">--:--:--</div><div class="g2">TR</div></div><div><div class="g1" id="g1">...</div><div class="g2" id="g2"></div></div></div>
  <button class="ibtn" id="bSound">Bildirim kapalı</button>
  <span class="mut"><span class="dot" id="dot"></span><span id="conn">Bağlanıyor</span></span>
 </div>
 <div class="body"><div class="side"><div class="tabs" id="tabs"></div><div class="list" id="list"></div></div><div class="main" id="main"></div></div>
</div>
<script>
var TABS=[['sig','Sinyaller'],['radar','Radar'],['stat','İstatistik'],['jr','Günlük'],['bt','Test']];
var S=null,tab='sig',sel=null,seenIds={},firstLoad=true,soundOn=false,chartCache={},chartFor='',bt=null;
var _btSel={d:14,c:20};
function $(i){return document.getElementById(i)}
function ls(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function ss(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
var journal=ls('st_journal',[]),cfg=ls('st_cfg',{bal:1000,risk:0.5});
if(!(Number(cfg.risk)>0&&Number(cfg.risk)<=2))cfg.risk=0.5;
if(!(Number(cfg.bal)>0))cfg.bal=1000;
function fp(p){if(p==null)return'-';p=Number(p);var a=Math.abs(p);return a>=1000?p.toFixed(2):a>=1?p.toFixed(4):a>=0.01?p.toFixed(5):p.toFixed(7)}
function f2(x,d){return x==null||isNaN(x)?'-':Number(x).toFixed(d==null?2:d)}
function sg(x,d){x=Number(x);return(x>0?'+':'')+x.toFixed(d==null?2:d)}
function cl(x){return x>0?'up':x<0?'dn':'fl'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function trNow(){return new Date(Date.now()+3*3600e3)}
function dayKey(){return trNow().toISOString().slice(0,10)}
function moodOf(){return S&&S.market&&S.market.mood?S.market.mood:null}
function todayJ(){var k=dayKey();return journal.filter(function(j){return j.day===k})}
function pnlR(s){if(!s||!s.lastPrice)return null;return(s.dir==='LONG'?1:-1)*(s.lastPrice-s.entry)/Math.abs(s.entry-s.initialStop)}
function tvUrl(sym){var b=sym.split('/')[0];return'https://www.tradingview.com/chart/?symbol=BITGET:'+b+'USDT.P&interval=5'}
function openS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT'}
var ST={ACTIVE:['Açık','w'],TP1_HIT:['TP1','g'],TP2:['TP2 ✓','g'],STOP:['Stop','r'],BE:['BE','w'],TIMEOUT:['Süre','w']};
function stateTag(st){var m={'ENTRY':['🟢 ENTRY','entry'],'IDLE':['⚪ IDLE','none']};var x=m[st]||[st,'none'];return '<span class="tag '+x[1]+'">'+x[0]+'</span>'}
function ago(ts){var m=Math.floor((Date.now()-ts)/60000);return m<1?'şimdi':m<60?m+' dk':Math.floor(m/60)+'s '+(m%60)+'dk'}
function renderGate(){var d=trNow();$('clock').textContent=('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2)+':'+('0'+d.getUTCSeconds()).slice(-2);
 var t=todayJ(),r=0;t.forEach(function(j){r+=j.r});var c='ok',a='AÇIK',b='Bugün '+sg(r,1)+'R, '+t.length+' işlem';
 if(r<=-3){c='stop';a='DUR';b='Günlük limit';}else if(t.length>=15){c='stop';a='DUR';b='15 işlem';}else if(r>=3){c='wait';a='YAVAŞLA';b='Hedef';}
 $('gate').className='gate '+c;$('g1').textContent=a;$('g2').textContent=b}
function mchip(id,n,m){var e=$(id);if(!m){e.innerHTML='<b>'+n+'</b> -';return}
 var t=m.dir===1?'<span class="up">15m ▲</span>':m.dir===-1?'<span class="dn">15m ▼</span>':'<span class="fl">15m ▬</span>';
 e.innerHTML='<b>'+n+'</b> '+fp(m.price)+' <span class="'+cl(m.chg)+'">'+sg(m.chg,2)+'%</span> '+t}
function renderTop(){if(!S)return;var md=moodOf();
 if(md){var mc=md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl',ar=md.label==='LONG'?' ▲':md.label==='SHORT'?' ▼':' ▬';
  $('cMkt').innerHTML='<b>Piyasa</b> <span class="'+mc+'" style="font-weight:800">'+md.label+ar+'</span> <span class="mut">'+md.up+'↑/'+md.down+'↓ akt'+md.active+'</span>'}
 mchip('cBTC','BTC',S.market&&S.market.btc);mchip('cETH','ETH',S.market&&S.market.eth);$('modeB').textContent=S.mode}
function renderTabs(){var oc=S?S.signals.filter(openS).length:0,h='';TABS.forEach(function(t){h+='<button class="tab'+(tab===t[0]?' a':'')+'" data-t="'+t[0]+'">'+t[1]+(t[0]==='sig'?'<i>'+oc+'</i>':'')+'</button>'});$('tabs').innerHTML=h;
 Array.prototype.forEach.call($('tabs').children,function(b){b.onclick=function(){tab=b.getAttribute('data-t');if(tab==='sig'||tab==='radar')sel=null;renderAll()}})}
function sigCard(s){var st=ST[s.status]||['?',''];
 var cls='card'+(sel&&sel.id===s.id?' sel':'')+(openS(s)?'':' closed');
 var pnlHtml='',pxHtml='',healthTag='';
 if(openS(s)&&s.health)healthTag='<span class="tag '+s.health.color+'">'+s.health.status+' '+s.health.score+'</span>';
 var R=pnlR(s);
 if(openS(s)&&R!=null){var pcls=R>0?'up':R<0?'dn':'fl';pnlHtml='<span class="pnl-big '+pcls+'">'+(R>0?'+':'')+R.toFixed(2)+'R</span>';pxHtml='<span>Anlık <b>'+fp(s.lastPrice)+'</b></span>';}
 else if(s.netR!=null){var rc=s.netR>0?'up':s.netR<0?'dn':'fl';pnlHtml='<span class="pnl-big '+rc+'">'+(s.netR>0?'+':'')+s.netR+'R</span>';}
 var p=s.parts||{};
 return '<div class="'+cls+'" data-id="'+s.id+'"><a class="card-tv" href="'+tvUrl(s.symbol)+'" target="_blank" onclick="event.stopPropagation()">📈 TV</a><div class="r1"><span class="badge '+(s.dir==='LONG'?'L':'S')+'">'+s.dir+'</span><span class="coin">'+esc(s.base)+'</span><span class="tag vb">📊 VB</span><span class="tag '+st[1]+'">'+st[0]+'</span>'+healthTag+pnlHtml+'</div><div class="sub"><span>Q <b>'+s.score+'</b></span><span>Vol <b>'+(p.volume||0).toFixed(1)+'x</b></span><span>ADX <b>'+(p.adx||0).toFixed(0)+'</b></span><span>RSI <b>'+(p.rsi||0).toFixed(0)+'</b></span><span>Giriş <b>'+fp(s.entry)+'</b></span>'+pxHtml+'<span>Stop '+fp(s.stop)+'</span><span>'+ago(s.time)+' önce</span></div></div>'}
function renderList(){var L=$('list'),h='';if(!S){L.innerHTML='<div class="note">Yükleniyor...</div>';return}
 if(tab==='sig'){var a=S.signals.filter(openS),c=S.signals.filter(function(s){return!openS(s)}).slice(0,40);
  if(!a.length)h+='<div class="note" style="padding:10px">Açık sinyal yok. Volume Breakout motoru 5m kırılım + hacim bekliyor.</div>';
  a.forEach(function(s){h+=sigCard(s)});if(c.length)h+='<h3>Kapanan</h3>';c.forEach(function(s){h+=sigCard(s)})}
 else if(tab==='radar'){
  var sts=S.states||{};
  h+='<h3>Aktif state</h3>';
  var any=false;
  Object.keys(sts).forEach(function(k){any=true;h+='<div class="card"><div class="r1"><span class="coin">'+esc(k.split('/')[0])+'</span>'+stateTag(sts[k])+'</div></div>'});
  if(!any)h+='<div class="note" style="padding:10px">Tüm coinler IDLE.</div>';
  S.radar.forEach(function(r){h+='<div class="card" data-sym="'+esc(r.symbol)+'"><div class="r1"><span class="badge '+(r.bias==='LONG'?'L':'S')+'">'+r.bias+'</span><span class="coin">'+esc(r.base)+'</span>'+stateTag(r.state)+'<span class="mut" style="margin-left:auto">ctx '+f2(r.score,0)+'</span></div></div>'});
 }
 else if(tab==='stat'){h='<div class="note" style="padding:8px">Sağdaki panelde</div>'}
 else if(tab==='jr'){h='<div class="note" style="padding:8px">Sağdaki panelden kaydet</div>'}
 else{h='<div class="note" style="padding:8px">Testi sağdaki panelden başlat</div>'}
 L.innerHTML=h;
 Array.prototype.forEach.call(L.querySelectorAll('.card'),function(e){e.onclick=function(){var id=e.getAttribute('data-id'),sy=e.getAttribute('data-sym');
  if(id){var s=S.signals.filter(function(x){return x.id===id})[0];if(s)sel={id:id,sym:s.symbol}}else if(sy){sel={sym:sy}}chartFor='';renderList();renderMain()}})}
function calc(entry,stop){var bal=Number(cfg.bal)||0,rk=Math.min(2,Number(cfg.risk)||0),ru=bal*rk/100,d=Math.abs(entry-stop);if(!d||!bal)return null;var q=ru/d;return{riskUsd:ru,qty:q,notional:q*entry,lev:q*entry/bal}}
function calcBox(entry,stop){var c=entry&&stop?calc(Number(entry),Number(stop)):null;
 return '<div class="box"><h3 style="margin-top:0">Pozisyon</h3><div class="frm"><label class="mut">Bakiye<br><input id="cBal" type="number" value="'+cfg.bal+'"></label><label class="mut">Risk%<br><input id="cRisk" type="number" step="0.1" max="2" value="'+cfg.risk+'"></label><label class="mut">Giriş<br><input id="cE" type="number" step="any" value="'+(entry||'')+'"></label><label class="mut">Stop<br><input id="cS" type="number" step="any" value="'+(stop||'')+'"></label></div><div id="cOut" class="note" style="color:var(--tx)">'+calcOut(c)+'</div></div>'}
function calcOut(c){return c?'1R = <b>'+f2(c.riskUsd,2)+' USDT</b> | Miktar <b>'+f2(c.qty,4)+'</b> | Kaldıraç <b>'+f2(c.lev,1)+'x</b>':'Değer gir.'}
function bindCalc(){['cBal','cRisk','cE','cS'].forEach(function(id){var e=$(id);if(!e)return;e.oninput=function(){cfg.bal=Number($('cBal').value);var rk=Math.min(2,Number($('cRisk').value)||0.5);cfg.risk=rk;ss('st_cfg',cfg);var en=Number($('cE').value),so=Number($('cS').value);$('cOut').innerHTML=calcOut(en&&so?calc(en,so):null)}})}
function homeView(){
 var t=todayJ(),r=0;t.forEach(function(j){r+=j.r});
 var md=moodOf()||{label:'-',up:0,down:0,active:0,breadth:0};
 var ml=md.label==='LONG'?'LONG ▲':md.label==='SHORT'?'SHORT ▼':'YATAY ▬';
 var mc=md.label==='LONG'?'up':md.label==='SHORT'?'dn':'fl';
 var td=S.stats.today;
 var h='<h2>Volume Breakout v9.23 — 5m Kırılım + Hacim + ADX + MACD</h2>';
 h+='<div class="tiles">';
 h+='<div class="tile"><div class="k">Piyasa</div><div class="v '+mc+'">'+ml+'</div><div class="k">'+md.up+'↑/'+md.down+'↓</div></div>';
 h+='<div class="tile"><div class="k">Bugün R</div><div class="v '+cl(r)+'">'+sg(r,1)+'</div></div>';
 h+='<div class="tile"><div class="k">Bugün sinyal</div><div class="v">'+td.n+'</div></div>';
 h+='<div class="tile"><div class="k">Taranan</div><div class="v">'+S.scan.universe+'</div></div>';
 h+='</div>';
 h+='<div class="grid2"><div>';
 h+='<div class="box"><h3 style="margin-top:0">Kurallar (v9.23)</h3>';
 h+='<div class="note" style="color:var(--tx)">Hacim ≥ '+S.filters.minVol+'x | ADX ≥ '+S.filters.minAdx+' | Body ≥ '+S.filters.minBody+'</div>';
 h+='<div class="note" style="color:var(--tx)">RSI LONG '+S.filters.minRsi+'-'+S.filters.maxRsi+' | SHORT ters</div>';
 h+='<div class="note" style="color:var(--tx)">TP '+S.filters.tp1+'R/'+S.filters.tp2+'R | BE '+S.filters.beAtR+'R | Hold '+S.filters.maxHold+'dk</div>';
 h+='<div class="note" style="color:var(--tx)">Counter-trend yasak | Korelasyon filtresi aktif</div>';
 h+='<div class="note">Son tarama: '+(S.scan.last?ago(S.scan.last)+' önce':'-')+'</div>';
 h+='<div class="note">Elenme: '+reasonTxt(S.scan.reasons)+'</div>';
 h+='</div>';
 h+='</div><div>'+calcBox('','')+'</div></div>';
 return h;
}
function reasonTxt(o){var a=[];for(var k in o)a.push([k,o[k]]);a.sort(function(x,y){return y[1]-x[1]});return a.slice(0,8).map(function(x){return x[0]+' '+x[1]}).join(', ')||'-'}
function partRow(name,v,max,color){var pct=Math.min(100,Math.abs(v)/max*100);return '<div style="display:grid;grid-template-columns:130px 1fr 60px;gap:8px;margin:4px 0;font-size:12px"><span>'+name+'</span><div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden"><i style="display:block;height:100%;width:'+pct+'%;background:'+color+'"></i></div><b style="text-align:right">'+v+'</b></div>'}
function healthBoxHTML(s){if(!openS(s)||!s.health)return '';var hc=s.health.color==='g'?'var(--lg)':s.health.color==='r'?'var(--st)':'var(--am)';
 return '<div class="health-box" style="border-color:'+hc+'"><div><div class="hl">SAĞLIK</div><div class="hs" style="color:'+hc+'">'+s.health.score+'</div></div><div><div style="font-weight:800;color:'+hc+'">'+s.health.status+'</div><div class="hl">'+esc(s.health.reason)+'</div><div class="hl">→ '+esc(s.health.advice)+'</div></div></div>'}
function sigView(s){var st=ST[s.status]||['?',''],tv=tvUrl(s.symbol),R=pnlR(s);
 var txt=s.dir+' '+s.base+' | Giriş '+fp(s.entry)+' | Stop '+fp(s.initialStop)+' | TP1 '+fp(s.tp1)+' | TP2 '+fp(s.tp2);
 var p=s.parts||{};
 var h='<div class="r1" style="padding-right:0"><span class="badge '+(s.dir==='LONG'?'L':'S')+'" style="font-size:13px">'+s.dir+'</span><h2 style="margin:0">'+esc(s.symbol.split(':')[0])+'</h2><span class="tag vb">📊 VB</span><span class="tag '+st[1]+'">'+st[0]+'</span><span style="font-size:24px;font-weight:800">'+s.score+'</span></div>';
 h+='<div class="mut" style="margin-bottom:6px">'+ago(s.time)+' önce</div>'+healthBoxHTML(s);
 h+='<canvas id="cv" style="margin-top:10px"></canvas>';
 h+='<div class="lv"><div><span>Anlık</span><b style="color:#fff">'+fp(s.lastPrice||s.entry)+'</b></div><div><span>K/Z</span><b class="'+(R>0?'up':R<0?'dn':'fl')+'">'+(R!=null?(R>0?'+':'')+R.toFixed(2)+'R':'-')+'</b></div><div><span>Giriş</span><b>'+fp(s.entry)+'</b></div><div><span>Stop</span><b class="dn">'+fp(s.stop)+'</b></div><div><span>TP1</span><b class="up">'+fp(s.tp1)+'</b></div><div><span>TP2</span><b class="up">'+fp(s.tp2)+'</b></div><div><span>Risk</span><b>'+f2(s.riskPct,2)+'%</b></div><div><span>Vol</span><b>'+f2(s.volX,1)+'x</b></div><div><span>ADX</span><b>'+f2(s.adx,1)+'</b></div><div><span>RSI</span><b>'+f2(s.rsi,0)+'</b></div></div>';
 h+='<div class="frm"><a class="btn tv" href="'+tv+'" target="_blank">📈 TV</a><button class="btn" id="cpy">Kopyala</button><button class="btn g" id="addJ">Günlüğe ekle</button></div>';
 h+='<div class="box"><h3 style="margin-top:0">Kırılım kalitesi</h3>';
 h+=partRow('Hacim',(p.volume||0).toFixed(1)+'x',8,'#ff8c42');
 h+=partRow('ADX',(p.adx||0).toFixed(0),40,'#5aa9ff');
 h+=partRow('Body',(p.body||0).toFixed(2),1,'#3ddc97');
 h+=partRow('RSI',(p.rsi||0).toFixed(0),100,'#f2b84b');
 h+='<div class="note" style="color:var(--tx)">'+esc(s.reason||'')+'</div></div>';
 h+=calcBox(s.entry,s.initialStop);
 return {h:h,txt:txt,s:s}}
function radarView(sym){var r=S.radar.filter(function(x){return x.symbol===sym})[0];var tv=tvUrl(sym);
 var h='<div class="r1" style="padding-right:0"><h2 style="margin:0">'+esc(sym.split(':')[0])+'</h2>'+(r?'<span class="tag">'+esc(r.state)+'</span>':'')+'<a class="btn tv" style="margin-left:auto" href="'+tv+'" target="_blank">📈 TV</a></div><canvas id="cv"></canvas>';
 return h+calcBox('','')}
function tbl(t,title){if(!t)return '';return '<h3>'+title+'</h3><table><tr><th>Grup</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">t</th><th class="n">Hold</th></tr>'+Object.keys(t).map(function(k){var x=t[k];return '<tr><td>'+esc(k)+'</td><td class="n">'+x.n+'</td><td class="n">'+f2(x.win*100,0)+'</td><td class="n '+cl(x.avgR)+'">'+sg(x.avgR,2)+'</td><td class="n '+cl(x.totalR)+'">'+sg(x.totalR,1)+'</td><td class="n mut">'+f2(x.t,1)+'</td><td class="n mut">'+f2(x.avgHold,0)+'dk</td></tr>'}).join('')+'</table>'}
function statView(){var a=S.stats.all,h='<h2>İstatistik</h2><div class="tiles"><div class="tile"><div class="k">N</div><div class="v">'+a.n+'</div></div><div class="tile"><div class="k">Win%</div><div class="v">'+f2(a.win*100,0)+'</div><div class="k">Gerçek '+f2(a.realWin*100,0)+'%</div></div><div class="tile"><div class="k">Ort R</div><div class="v '+cl(a.avgR)+'">'+sg(a.avgR,2)+'</div><div class="k">±'+f2(a.ci,2)+'</div></div><div class="tile"><div class="k">Top R</div><div class="v '+cl(a.totalR)+'">'+sg(a.totalR,1)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(a.pf,2)+'</div></div><div class="tile"><div class="k">DD</div><div class="v dn">'+f2(a.dd,1)+'</div></div><div class="tile"><div class="k">t-stat</div><div class="v '+(Math.abs(a.t)>=2?'up':'fl')+'">'+f2(a.t,2)+'</div></div></div><canvas id="eq" style="height:160px"></canvas>'+tbl(S.stats.byDir,'Yön')+tbl(S.stats.byExit,'Çıkış')+tbl(S.stats.bySession,'Seans')+tbl(S.stats.byBand,'Puan')+tbl(S.stats.byVol,'Hacim')+tbl(S.stats.byAdx,'ADX')+tbl(S.stats.byMfe,'MFE')+tbl(S.stats.byHour,'Saat');return h}
function jrView(){var t=todayJ(),r=0,all=0;t.forEach(function(j){r+=j.r});journal.forEach(function(j){all+=j.r});
 var h='<h2>Günlük</h2><div class="tiles"><div class="tile"><div class="k">Bugün</div><div class="v '+cl(r)+'">'+sg(r,1)+'R</div></div><div class="tile"><div class="k">Tümü</div><div class="v '+cl(all)+'">'+sg(all,1)+'R</div></div><div class="tile"><div class="k">N</div><div class="v">'+journal.length+'</div></div></div>';
 h+='<div class="box"><div class="frm"><input id="jSym" placeholder="Coin"><select id="jDir"><option>LONG</option><option>SHORT</option></select><input id="jR" type="number" step="0.1" placeholder="R"><input id="jN" placeholder="Not" style="width:200px"><button class="btn" id="jAdd">Kaydet</button></div></div><table><tr><th>Zaman</th><th>Coin</th><th>Yön</th><th class="n">R</th><th>Not</th><th></th></tr>';
 journal.slice().reverse().slice(0,40).forEach(function(j){var d=new Date(j.ts+3*3600e3);h+='<tr><td class="mut">'+d.toISOString().slice(5,16).replace('T',' ')+'</td><td><b>'+esc(j.sym)+'</b></td><td>'+(j.dir==='LONG'?'<span class="up">L</span>':'<span class="dn">S</span>')+'</td><td class="n '+cl(j.r)+'">'+sg(j.r,1)+'</td><td class="mut">'+esc(j.note||'')+'</td><td><button class="ibtn" data-del="'+j.id+'">Sil</button></td></tr>'});
 return h+'</table>'}
function bindJr(pre){var b=$('jAdd');if(!b)return;if(pre){$('jSym').value=pre.base;$('jDir').value=pre.dir}
 b.onclick=function(){var sy=$('jSym').value.trim().toUpperCase(),r=Number($('jR').value);if(!sy||isNaN(r))return;journal.push({id:Date.now(),ts:Date.now(),day:dayKey(),sym:sy,dir:$('jDir').value,r:r,note:$('jN').value});ss('st_journal',journal);renderAll()};
 Array.prototype.forEach.call(document.querySelectorAll('[data-del]'),function(e){e.onclick=function(){journal=journal.filter(function(j){return j.id!==Number(e.getAttribute('data-del'))});ss('st_journal',journal);renderAll()}})}
function btView(){var h='<h2>Backtest — GERÇEK 1m</h2><div class="box"><div class="frm"><select id="bD">'+(function(){var o='';[7,14,30].forEach(function(v){o+='<option value="'+v+'"'+(_btSel.d===v?' selected':'')+'>'+v+' gün</option>'});return o})()+'</select><select id="bC">'+(function(){var o='';[10,20,40].forEach(function(v){o+='<option value="'+v+'"'+(_btSel.c===v?' selected':'')+'>'+v+' coin</option>'});return o})()+'</select><button class="btn" id="bGo">Başlat</button></div><div class="warn">v9.23 VOLUME BREAKOUT: 5m kırılım + hacim + ADX + MACD + counter-trend yasak.</div></div>';
 if(!bt)return h+'<div class="note">Test yok.</div>';
 if(bt.running)h+='<div class="box"><div>'+esc(bt.msg)+'</div></div>';
 if(bt.error)h+='<div class="box dn">'+esc(bt.error)+'</div>';
 if(bt.result){var R=bt.result;
  h+='<div class="tiles"><div class="tile"><div class="k">N</div><div class="v">'+R.all.n+'</div></div><div class="tile"><div class="k">Win%</div><div class="v">'+f2(R.all.win*100,0)+'</div><div class="k">Gerçek '+f2(R.all.realWin*100,0)+'%</div></div><div class="tile"><div class="k">Ort R</div><div class="v '+cl(R.all.avgR)+'">'+sg(R.all.avgR,2)+'</div><div class="k">±'+f2(R.all.ci,2)+'</div></div><div class="tile"><div class="k">t-stat</div><div class="v '+(Math.abs(R.all.t)>=2?'up':'fl')+'">'+f2(R.all.t,2)+'</div></div><div class="tile"><div class="k">PF</div><div class="v">'+f2(R.all.pf,2)+'</div></div><div class="tile"><div class="k">DD</div><div class="v dn">'+f2(R.all.dd,1)+'</div></div><div class="tile"><div class="k">Medyan R</div><div class="v">'+sg(R.all.med,2)+'</div></div><div class="tile"><div class="k">Ort Hold</div><div class="v">'+f2(R.all.avgHold,0)+' dk</div></div></div>';
  h+='<h3>Walk-forward</h3><table><tr><th>Dilim</th><th class="n">N</th><th class="n">Win%</th><th class="n">OrtR</th><th class="n">TopR</th><th class="n">PF</th></tr>'
   +'<tr><td>IS</td><td class="n">'+R.is.n+'</td><td class="n">'+f2(R.is.win*100,0)+'</td><td class="n '+cl(R.is.avgR)+'">'+sg(R.is.avgR,2)+'</td><td class="n '+cl(R.is.totalR)+'">'+sg(R.is.totalR,1)+'</td><td class="n">'+f2(R.is.pf,2)+'</td></tr>'
   +'<tr><td>VALIDATION</td><td class="n">'+R.val.n+'</td><td class="n">'+f2(R.val.win*100,0)+'</td><td class="n '+cl(R.val.avgR)+'">'+sg(R.val.avgR,2)+'</td><td class="n '+cl(R.val.totalR)+'">'+sg(R.val.totalR,1)+'</td><td class="n">'+f2(R.val.pf,2)+'</td></tr>'
   +'<tr><td><b>OOS</b></td><td class="n">'+R.oos.n+'</td><td class="n">'+f2(R.oos.win*100,0)+'</td><td class="n '+cl(R.oos.avgR)+'">'+sg(R.oos.avgR,2)+'</td><td class="n '+cl(R.oos.totalR)+'">'+sg(R.oos.totalR,1)+'</td><td class="n">'+f2(R.oos.pf,2)+'</td></tr></table>';
  if(R.skipped&&R.skipped.length)h+='<div class="warn">⚠️ '+R.skipped.length+' coin atlandı</div>';
  h+='<div class="note">Funnel: '+reasonTxt(R.funnel)+'</div>';
  h+=tbl(R.byDir,'Yön')+tbl(R.byExit,'Çıkış')+tbl(R.byBand,'Puan')+tbl(R.byVol,'Hacim')+tbl(R.byAdx,'ADX')+tbl(R.byMfe,'MFE')+tbl(R.bySession,'Seans')+tbl(R.byWeek,'Hafta')+tbl(R.byCoin,'Coin');
 }
 return h}
function bindBt(){var sD=$('bD'),sC=$('bC'),b=$('bGo');if(!b)return;
 if(sD)sD.onchange=function(){_btSel.d=Number(sD.value)};if(sC)sC.onchange=function(){_btSel.c=Number(sC.value)};
 b.onclick=function(){fetch('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:Number(sD.value),coins:Number(sC.value)})}).then(function(r){return r.json()}).then(function(){pollBt()})}}
function pollBt(){fetch('/api/backtest').then(function(r){return r.json()}).then(function(d){bt=d;var ae=document.activeElement;if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'))return;if(tab==='bt')renderMain();if(d.running)setTimeout(pollBt,3000)})}
function drawEq(){var c=$('eq');if(!c||!S.equity.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);var v=S.equity,mn=Math.min(0,Math.min.apply(null,v)),mx=Math.max(0.1,Math.max.apply(null,v)),Y=function(a){return H-10-(a-mn)/(mx-mn)*(H-20)};x.strokeStyle='#243040';x.beginPath();x.moveTo(0,Y(0));x.lineTo(W,Y(0));x.stroke();x.strokeStyle='#f2b84b';x.lineWidth=2;x.beginPath();v.forEach(function(a,i){var px=i/Math.max(1,v.length-1)*(W-8)+4;if(i)x.lineTo(px,Y(a));else x.moveTo(px,Y(a))});x.stroke()}
function drawChart(d,s){var c=$('cv');if(!c||!d||!d.c.length)return;var W=c.clientWidth,H=c.clientHeight,dp=window.devicePixelRatio||1;c.width=W*dp;c.height=H*dp;var x=c.getContext('2d');x.scale(dp,dp);
 var L=8,R=90,T=14,B=22,n=d.c.length,PW=W-L-R,PH=H-T-B,hi=-1e99,lo=1e99,i;for(i=0;i<n;i++){hi=Math.max(hi,d.c[i][2]);lo=Math.min(lo,d.c[i][3])}
 var lv=[];if(s){lv=[[s.tp2,'#3ddc97','TP2'],[s.tp1,'#3ddc97','TP1'],[s.initialStop,'#ff6b7a','STOP'],[s.entry,'#5aa9ff','GİRİŞ']];lv.forEach(function(a){if(a[0])hi=Math.max(hi,a[0]),lo=Math.min(lo,a[0])})}
 var pad=(hi-lo)*0.06;hi+=pad;lo-=pad;var Y=function(p){return T+(hi-p)/(hi-lo)*PH};var X=function(k){return L+(k+0.5)/n*PW};var cw=Math.max(2,PW/n*0.68);
 x.strokeStyle='rgba(255,255,255,.05)';for(i=0;i<=4;i++){var gy=T+PH*i/4;x.beginPath();x.moveTo(L,gy);x.lineTo(W-R,gy);x.stroke();x.fillStyle='#8593a5';x.font='10px system-ui';x.fillText(fp(hi-(hi-lo)*i/4),W-R+6,gy+3)}
 function line(arr,col,w){if(!arr)return;x.strokeStyle=col;x.lineWidth=w;x.beginPath();var st=false;for(var k=0;k<Math.min(arr.length,n);k++){if(arr[k]==null)continue;if(!st){x.moveTo(X(k),Y(arr[k]));st=true}else x.lineTo(X(k),Y(arr[k]))}x.stroke()}
 line(d.e50,'#8593a5',1.2);line(d.e21,'#f2b84b',1.4);
 for(i=0;i<n;i++){var k=d.c[i],up=k[4]>=k[1],col=up?'#3ddc97':'#ff6b7a';x.strokeStyle=col;x.fillStyle=col;x.beginPath();x.moveTo(X(i),Y(k[2]));x.lineTo(X(i),Y(k[3]));x.stroke();var y1=Y(k[1]),y2=Y(k[4]);x.fillRect(X(i)-cw/2,Math.min(y1,y2),cw,Math.max(1,Math.abs(y2-y1)))}
 lv.forEach(function(a){if(!a[0])return;x.strokeStyle=a.color;x.lineWidth=a.name==='GİRİŞ'?2:1.5;x.setLineDash(a.name==='GİRİŞ'?[]:[6,4]);x.beginPath();x.moveTo(L,Y(a[0]));x.lineTo(W-R,Y(a[0]));x.stroke();x.setLineDash([]);x.fillStyle=a.color;x.font='bold 11px system-ui';x.fillText(a[2],W-R+6,Y(a[0])-4)});
}
function loadChart(sym){if(!sym)return;fetch('/api/candles?symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(d){chartCache[sym]=d;if(sel&&sel.sym===sym){var s2=sel.id?S.signals.filter(function(x){return x.id===sel.id})[0]:null;drawChart(d,s2)}}).catch(function(){})}
function renderMain(){var M=$('main');if(!S){M.innerHTML='';return}
 if(tab==='stat'){M.innerHTML=statView();drawEq();return}
 if(tab==='jr'){M.innerHTML=jrView();bindJr();return}
 if(tab==='bt'){M.innerHTML=btView();bindBt();return}
 if(sel&&sel.id){var s=S.signals.filter(function(x){return x.id===sel.id})[0];if(s){var v=sigView(s);M.innerHTML=v.h;$('cpy').onclick=function(){try{navigator.clipboard.writeText(v.txt);$('cpy').textContent='✓'}catch(e){}};$('addJ').onclick=function(){tab='jr';renderAll();bindJr(s)};bindCalc();if(chartCache[s.symbol])drawChart(chartCache[s.symbol],s);if(chartFor!==s.symbol){chartFor=s.symbol;loadChart(s.symbol)}return}}
 if(sel&&sel.sym){M.innerHTML=radarView(sel.sym);bindCalc();if(chartCache[sel.sym])drawChart(chartCache[sel.sym],null);if(chartFor!==sel.sym){chartFor=sel.sym;loadChart(sel.sym)}return}
 M.innerHTML=homeView();bindCalc()}
function renderAll(){renderTop();renderTabs();renderList();renderMain();renderGate()}
function beep(){try{var a=new(window.AudioContext||window.webkitAudioContext)(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.15;o.start();o.stop(a.currentTime+.2)}catch(e){}}
function apply(d){if(!d)return;S=d;var fresh=[];
 d.signals.forEach(function(s){if(openS(s)&&!seenIds[s.id]){seenIds[s.id]=1;if(!firstLoad)fresh.push(s)}else if(!seenIds[s.id])seenIds[s.id]=1});
 if(fresh.length&&soundOn){beep();try{if(Notification.permission==='granted')new Notification('ENTRY '+fresh[0].dir+' '+fresh[0].base,{body:'Q '+fresh[0].score})}catch(e){}}}
 firstLoad=false;var ae=document.activeElement;if(ae&&(ae.tagName==='INPUT'||ae.tagName==='SELECT'||ae.tagName==='TEXTAREA')){renderTop();renderTabs();renderList();renderGate();return}renderAll()}
function poll(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){apply(d);$('dot').className='dot on';$('conn').textContent='Bağlı'}).catch(function(){$('dot').className='dot';$('conn').textContent='Bağlantı yok'})}
$('bSound').onclick=function(){soundOn=!soundOn;this.className='ibtn'+(soundOn?' on':'');this.textContent=soundOn?'Bildirim açık':'Bildirim kapalı';if(soundOn){beep();try{Notification.requestPermission()}catch(e){}}};
window.addEventListener('resize',function(){if(S)renderMain()});
setInterval(renderGate,1000);setInterval(poll,5000);
poll();pollBt();
</script></body></html>`;

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
            const days = [7, 14, 30].includes(b.days) ? b.days : 14;
            const coins = [10, 20, 40].includes(b.coins) ? b.coins : 20;
            if (!btJob.running) runBacktest(days, coins, { costMult: 1 });
            return json(res, 200, { started: true });
        }
        if (u.pathname === '/api/reset' && req.method === 'POST') {
            if (!authed(req)) return json(res, 401, { error: 'yetkisiz' });
            signals = []; lastSig = {}; lastWave = {}; stateMap.clear(); dirty = true; saveState();
            return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'yok' });
    } catch (e) { json(res, 500, { error: e.message }); }
});

async function start() {
    try {
        loadState();
        await ex.loadMarkets(); log('marketler:', Object.keys(ex.markets).length);
        await refreshUniverse();
        log('evren:', universe.length, 'coin | v9.23 VOLUME BREAKOUT');
        setInterval(refreshUniverse, CFG.UNIVERSE_MS);
        setInterval(track, CFG.TRACK_MS);
        setInterval(refreshTickers, 15e3);
        setInterval(saveState, 15e3);
        setInterval(selfPing, 10 * 60e3);
        runScan();
        setInterval(runScan, CFG.SCAN_MS);
        log('SONER v9.23 VB hazır — 5m kırılım + hacim + ADX + MACD');
    } catch (e) { log('başlatma hata', e.message); setTimeout(start, 30000); }
}
function shutdown() { saveState(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) server.listen(PORT, '0.0.0.0', () => { log('PORT', PORT); start(); });
module.exports = { stepState, newState, adxLast, trendOfTF, advance, calcStats, atrLast, emaSeries, rsiSeries, CFG, _set: o => Object.assign(CFG, o) };
