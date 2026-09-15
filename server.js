'use strict';

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
    BREAKOUT_TIMEFRAME: '2h',
    LOOKBACK: 50,
    FETCH_LIMIT: 80,
    BREAKOUT_BUFFER: 0.001,
    WATCH_DISTANCE_PERCENT: 2.50,

    MIN_VOLUME_RATIO: 1.20,
    MIN_24H_VOLUME_USDT: 500000,
    MAX_TARGETS: 180,

    ATR_PERIOD: 14,
    SL_ATR_MULTIPLIER: 1.20,
    MIN_RR: 1.50,
    TARGET_SPACE_MIN_PERCENT: 0.80,

    RETEST_REQUIRED: true,
    RETEST_ZONE_ATR: 0.30,
    RETEST_INVALID_ATR: 0.60,
    RETEST_TIMEOUT_MS: 90 * 60 * 1000,

    SETUP_EXPIRY_MS: 14 * 60 * 60 * 1000,
    SIGNAL_KEEP_MS: 12 * 60 * 60 * 1000,
    MAX_ACTIVE_SETUPS: 80,

    SCAN_INTERVAL_MS: 5 * 60 * 1000,
    LIVE_INTERVAL_MS: 5000,
    PRESCAN_INTERVAL_MS: 5 * 60 * 1000,
    API_DELAY_MS: 120,

    OI_ENABLED: true,
    OI_SUPPORTIVE_PCT: 0.10,

    REGIME_FILTER_ENABLED: true,
    REGIME_TIMEFRAME: '4h',
    REGIME_EMA: 200,

    RSI_CONTEXT_ENABLED: true,
    RSI_PERIOD: 14,
    RSI_LONG_WEAK: 42,
    RSI_SHORT_WEAK: 58,

    SWING_LEFT: 3,
    SWING_RIGHT: 3,

    TRENDLINE_LOOKBACK: 40,
    TRENDLINE_NEAREST_COUNT: 5,
    TRENDLINE_MAX_SLOPE_PCT: 0.03,
    TRENDLINE_MAX_DISTANCE_PCT: 0.035,
    TRENDLINE_MIN_TOUCHES: 2,
    TRENDLINE_TOUCH_PCT: 0.008,
    TRENDLINE_VIOLATION_PCT: 0.008,
    TRENDLINE_MAX_VIOLATIONS: 0,

    TRIANGLE_MIN_HIGHS: 2,
    TRIANGLE_MIN_LOWS: 2,
    TRIANGLE_MAX_AGE: 30,
    TRIANGLE_MIN_CONVERGENCE_PCT: 0.40,
    TRIANGLE_MIN_APEX_DISTANCE: 3,
    TRIANGLE_MAX_APEX_DISTANCE: 60,

    DEBUG: true,
    MAX_REJECT_LOGS_PER_SCAN: 20
};

// ============================================================
// EXCHANGE
// ============================================================

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 250,
    options: { defaultType: 'swap' }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let setups = [];
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;
let rejectLogCount = 0;

const oiHistory = new Map();
const lastClosed2H = new Map();

const APP_STATE = {
    signals: [],
    scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false },
    updatedAt: Date.now()
};

const DEBUG = {
    scanned: 0, watchCreated: 0, breakouts: 0, retests: 0, signals: 0,
    noData: 0, tooFar: 0, lowVolume: 0, duplicate: 0, invalid: 0,
    expired: 0, targetTooClose: 0, noTrendline: 0, triangles: 0,
    rejectionReasons: {}
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function pct(a, b) { return b ? (a / b) * 100 : 0; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function logReject(symbol, reason) {
    DEBUG.rejectionReasons[reason] = (DEBUG.rejectionReasons[reason] || 0) + 1;
    if (CONFIG.DEBUG && rejectLogCount < CONFIG.MAX_REJECT_LOGS_PER_SCAN) {
        console.log(`[REJECT] ${symbol} -> ${reason}`);
        rejectLogCount++;
    }
}

function closedCandles(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return [];
    return ohlcv.slice(0, -1).filter(c => Array.isArray(c) && c.length >= 6);
}

function sma(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    return arr.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.map(Number);
    if (arr.some(v => !Number.isFinite(v))) return null;
    let r = sma(arr.slice(0, period), period);
    if (r == null) return null;
    const k = 2 / (period + 1);
    for (let i = period; i < arr.length; i++) r = arr[i] * k + r * (1 - k);
    return r;
}

function atr(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i][2]);
        const l = Number(candles[i][3]);
        const pc = Number(candles[i - 1][4]);
        if (![h, l, pc].every(Number.isFinite)) continue;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return sma(trs, period);
}

function rsi(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * (period - 1) + Math.max(0, d)) / period;
        l = (l * (period - 1) + Math.max(0, -d)) / period;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
}

// ============================================================
// SWING NOKTALARI
// ============================================================

function findSwingHighs(candles) {
    const res = [];
    const L = CONFIG.SWING_LEFT, R = CONFIG.SWING_RIGHT;
    for (let i = L; i < candles.length - R; i++) {
        const h = Number(candles[i][2]);
        if (!Number.isFinite(h)) continue;
        let ok = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][2]) >= h) { ok = false; break; }
        }
        if (ok) res.push({ index: i, time: candles[i][0], price: h });
    }
    return res;
}

function findSwingLows(candles) {
    const res = [];
    const L = CONFIG.SWING_LEFT, R = CONFIG.SWING_RIGHT;
    for (let i = L; i < candles.length - R; i++) {
        const lo = Number(candles[i][3]);
        if (!Number.isFinite(lo)) continue;
        let ok = true;
        for (let j = i - L; j <= i + R; j++) {
            if (j === i) continue;
            if (Number(candles[j][3]) <= lo) { ok = false; break; }
        }
        if (ok) res.push({ index: i, time: candles[i][0], price: lo });
    }
    return res;
}

// ============================================================
// LINE MATH
// ============================================================

function lineFromPoints(p1, p2) {
    if (!p1 || !p2 || p1.index === p2.index) return null;
    const slope = (p2.price - p1.price) / (p2.index - p1.index);
    const intercept = p1.price - slope * p1.index;
    return { p1, p2, slope, intercept };
}

function valueAt(line, index) {
    if (!line) return null;
    return line.slope * index + line.intercept;
}

// ============================================================
// TRENDLINE SECIMI
// ============================================================

function selectTrendline(points, type, lastIndex, currentPrice) {
    if (!points || points.length < 2) return null;

    const isResistance = type === 'RESISTANCE';
    const minIdx = lastIndex - CONFIG.TRENDLINE_LOOKBACK;
    let recent = points.filter(p => p.index >= minIdx);
    if (recent.length < 2) recent = points.slice(-CONFIG.TRENDLINE_NEAREST_COUNT);
    if (recent.length < 2) return null;

    const sorted = recent.slice().sort((a, b) =>
        Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
    );
    const candidates = sorted.slice(0, CONFIG.TRENDLINE_NEAREST_COUNT);
    if (candidates.length < 2) return null;

    let best = null;

    for (let i = 0; i < candidates.length - 1; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const p1 = candidates[i];
            const p2 = candidates[j];
            if (p1.index === p2.index) continue;

            const line = lineFromPoints(p1, p2);
            if (!line) continue;

            const nowVal = valueAt(line, lastIndex);
            const proj12 = valueAt(line, lastIndex + 12);
            if (!Number.isFinite(nowVal) || !Number.isFinite(proj12)) continue;

            const slopePct = Math.abs(proj12 - nowVal) / currentPrice;
            if (slopePct > CONFIG.TRENDLINE_MAX_SLOPE_PCT) continue;

            if (isResistance && line.slope > 0.0001) continue;
            if (!isResistance && line.slope < -0.0001) continue;

            const distPct = (nowVal - currentPrice) / currentPrice;
            if (isResistance) {
                if (distPct < 0.0005) continue;
                if (distPct > CONFIG.TRENDLINE_MAX_DISTANCE_PCT) continue;
            } else {
                if (distPct > -0.0005) continue;
                if (distPct < -CONFIG.TRENDLINE_MAX_DISTANCE_PCT) continue;
            }

            let touches = 0;
            let violations = 0;

            for (const p of recent) {
                const projected = valueAt(line, p.index);
                if (!Number.isFinite(projected)) continue;
                const relDiff = (p.price - projected) / p.price;

                if (isResistance) {
                    if (relDiff > CONFIG.TRENDLINE_VIOLATION_PCT) violations++;
                    else if (Math.abs(relDiff) < CONFIG.TRENDLINE_TOUCH_PCT) touches++;
                } else {
                    if (relDiff < -CONFIG.TRENDLINE_VIOLATION_PCT) violations++;
                    else if (Math.abs(relDiff) < CONFIG.TRENDLINE_TOUCH_PCT) touches++;
                }
            }

            if (touches < CONFIG.TRENDLINE_MIN_TOUCHES) continue;
            if (violations > CONFIG.TRENDLINE_MAX_VIOLATIONS) continue;

            const dist = Math.abs(distPct);
            const score = touches * 100 - dist * 1500 - slopePct * 800;

            if (!best || score > best.score) {
                best = { line, touches, score };
            }
        }
    }

    if (!best) return null;

    const chosen = best.line;
    chosen.contacts = best.touches;
    chosen.type = type;
    chosen.current = valueAt(chosen, lastIndex);
    chosen.projected = valueAt(chosen, lastIndex + 12);
    return chosen;
}

// ============================================================
// UCGEN FORMASYONU TESPITI
// ============================================================

function detectTriangle(candles, lastIndex) {
    if (candles.length < 20) return null;

    const swingHighs = findSwingHighs(candles);
    const swingLows = findSwingLows(candles);

    if (swingHighs.length < CONFIG.TRIANGLE_MIN_HIGHS) return null;
    if (swingLows.length < CONFIG.TRIANGLE_MIN_LOWS) return null;

    const minIdx = lastIndex - CONFIG.TRIANGLE_MAX_AGE;
    const recentHighs = swingHighs.filter(p => p.index >= minIdx);
    const recentLows = swingLows.filter(p => p.index >= minIdx);

    if (recentHighs.length < 2) return null;
    if (recentLows.length < 2) return null;

    const currentPrice = Number(candles[lastIndex][4]);
    let best = null;

    for (let hi = 0; hi < recentHighs.length - 1; hi++) {
        for (let hj = hi + 1; hj < recentHighs.length; hj++) {
            const h1 = recentHighs[hi];
            const h2 = recentHighs[hj];
            if (h1.index === h2.index) continue;

            const rLine = lineFromPoints(h1, h2);
            if (!rLine) continue;

            const rNow = valueAt(rLine, lastIndex);
            if (rNow < currentPrice * 0.995) continue;

            for (let li = 0; li < recentLows.length - 1; li++) {
                for (let lj = li + 1; lj < recentLows.length; lj++) {
                    const l1 = recentLows[li];
                    const l2 = recentLows[lj];
                    if (l1.index === l2.index) continue;

                    const sLine = lineFromPoints(l1, l2);
                    if (!sLine) continue;

                    const sNow = valueAt(sLine, lastIndex);
                    if (sNow > currentPrice * 1.005) continue;

                    if (rNow <= sNow) continue;

                    const denom = rLine.slope - sLine.slope;
                    if (Math.abs(denom) < 1e-12) continue;

                    const apexIndex = (sLine.intercept - rLine.intercept) / denom;

                    if (apexIndex <= lastIndex + CONFIG.TRIANGLE_MIN_APEX_DISTANCE) continue;
                    if (apexIndex > lastIndex + CONFIG.TRIANGLE_MAX_APEX_DISTANCE) continue;

                    const rFuture = valueAt(rLine, lastIndex + 12);
                    const sFuture = valueAt(sLine, lastIndex + 12);

                    const curGap = rNow - sNow;
                    const futGap = rFuture - sFuture;

                    if (curGap <= 0 || futGap <= 0) continue;
                    if (futGap >= curGap) continue;

                    const convPct = (1 - futGap / curGap) * 100;
                    if (convPct < CONFIG.TRIANGLE_MIN_CONVERGENCE_PCT) continue;

                    let rTouches = 0;
                    let sTouches = 0;

                    for (const h of recentHighs) {
                        const projected = valueAt(rLine, h.index);
                        if (!Number.isFinite(projected)) continue;
                        const relDiff = Math.abs(h.price - projected) / h.price;
                        if (relDiff < CONFIG.TRENDLINE_TOUCH_PCT) rTouches++;
                    }
                    for (const l of recentLows) {
                        const projected = valueAt(sLine, l.index);
                        if (!Number.isFinite(projected)) continue;
                        const relDiff = Math.abs(l.price - projected) / l.price;
                        if (relDiff < CONFIG.TRENDLINE_TOUCH_PCT) sTouches++;
                    }

                    if (rTouches < 2) continue;
                    if (sTouches < 2) continue;

                    const rSlope = rLine.slope;
                    const sSlope = sLine.slope;
                    const FLAT_TOLERANCE = 0.0005;

                    const rFlat = Math.abs(rSlope) < FLAT_TOLERANCE;
                    const sFlat = Math.abs(sSlope) < FLAT_TOLERANCE;

                    let type = 'UNKNOWN';
                    let bias = 'NEUTRAL';

                    if (rSlope < -FLAT_TOLERANCE && sSlope > FLAT_TOLERANCE) {
                        type = 'SYMMETRICAL'; bias = 'NEUTRAL';
                    } else if (rFlat && sSlope > FLAT_TOLERANCE) {
                        type = 'ASCENDING'; bias = 'BULLISH';
                    } else if (rSlope < -FLAT_TOLERANCE && sFlat) {
                        type = 'DESCENDING'; bias = 'BEARISH';
                    } else {
                        continue;
                    }

                    const score =
                        convPct * 2 +
                        (rTouches + sTouches) * 15 -
                        Math.abs(apexIndex - lastIndex - 15);

                    if (!best || score > best.score) {
                        const apexPrice = valueAt(rLine, apexIndex);
                        best = {
                            type, bias, convPct, apexIndex, apexPrice,
                            rLine, sLine, rTouches, sTouches, score
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const rNow = valueAt(best.rLine, lastIndex);
    const sNow = valueAt(best.sLine, lastIndex);
    const height = rNow - sNow;

    let target = null;
    if (best.type === 'ASCENDING') {
        target = rNow + height;
    } else if (best.type === 'DESCENDING') {
        target = sNow - height;
    }

    return {
        type: best.type,
        bias: best.bias,
        convergencePct: num(best.convPct, 2),
        apexIndex: num(best.apexIndex, 2),
        apexPrice: num(best.apexPrice),
        apexDistance: num(best.apexIndex - lastIndex, 2),
        formationHeight: num(height),
        target: num(target),
        resistanceTouches: best.rTouches,
        supportTouches: best.sTouches,
        resistance: {
            current: num(rNow),
            future: num(valueAt(best.rLine, lastIndex + 12)),
            slope: best.rLine.slope,
            intercept: best.rLine.intercept,
            p1: {
                index: best.rLine.p1.index,
                price: num(best.rLine.p1.price),
                time: best.rLine.p1.time
            },
            p2: {
                index: best.rLine.p2.index,
                price: num(best.rLine.p2.price),
                time: best.rLine.p2.time
            }
        },
        support: {
            current: num(sNow),
            future: num(valueAt(best.sLine, lastIndex + 12)),
            slope: best.sLine.slope,
            intercept: best.sLine.intercept,
            p1: {
                index: best.sLine.p1.index,
                price: num(best.sLine.p1.price),
                time: best.sLine.p1.time
            },
            p2: {
                index: best.sLine.p2.index,
                price: num(best.sLine.p2.price),
                time: best.sLine.p2.time
            }
        }
    };
}

// ============================================================
// STRUCTURE BUILD - v7: UCGEN VARSA AYNI CIZGILERI KULLAN
// ============================================================

function buildStructure(candles) {
    const lastIndex = candles.length - 1;
    const currentPrice = Number(candles[lastIndex][4]);

    const trendCandles = candles.slice(-CONFIG.TRENDLINE_LOOKBACK);
    const trendLastIndex = trendCandles.length - 1;

    const swingHighs = findSwingHighs(trendCandles);
    const swingLows = findSwingLows(trendCandles);

    // ==========================================
    // 1) ONCE UCGEN ARA
    // ==========================================
    const triangle = detectTriangle(candles, lastIndex);

    // ==========================================
    // 2) UCGEN VARSA, KENARLARINI TRENDLINE OLARAK KULLAN
    // ==========================================
    let resistanceLineRaw = null;
    let supportLineRaw = null;

    if (triangle && triangle.resistance && triangle.support) {
        const rLine = {
            p1: {
                index: triangle.resistance.p1.index,
                time: 0,
                price: triangle.resistance.p1.price
            },
            p2: {
                index: triangle.resistance.p2.index,
                time: 0,
                price: triangle.resistance.p2.price
            },
            slope: triangle.resistance.slope,
            intercept: triangle.resistance.intercept,
            contacts: triangle.resistanceTouches,
            type: 'RESISTANCE',
            current: triangle.resistance.current,
            projected: triangle.resistance.future
        };

        const sLine = {
            p1: {
                index: triangle.support.p1.index,
                time: 0,
                price: triangle.support.p1.price
            },
            p2: {
                index: triangle.support.p2.index,
                time: 0,
                price: triangle.support.p2.price
            },
            slope: triangle.support.slope,
            intercept: triangle.support.intercept,
            contacts: triangle.supportTouches,
            type: 'SUPPORT',
            current: triangle.support.current,
            projected: triangle.support.future
        };

        resistanceLineRaw = rLine;
        supportLineRaw = sLine;
    } else {
        resistanceLineRaw = selectTrendline(
            swingHighs, 'RESISTANCE', trendLastIndex, currentPrice
        );
        supportLineRaw = selectTrendline(
            swingLows, 'SUPPORT', trendLastIndex, currentPrice
        );
    }

    // Ucgen zaten kendi ic penceresinden geldigi icin offset YOK
    // Trendline ise trendCandles penceresinden geldigi icin offset VAR
    let resistanceLine = null;
    let supportLine = null;

    if (triangle && triangle.resistance && triangle.support) {
        // Ucgen cizgileri zaten tam candle indexinde
        resistanceLine = resistanceLineRaw;
        supportLine = supportLineRaw;
    } else {
        const offset = lastIndex - trendLastIndex;
        resistanceLine = resistanceLineRaw ? shiftLine(resistanceLineRaw, offset) : null;
        supportLine = supportLineRaw ? shiftLine(supportLineRaw, offset) : null;
    }

    const offset = lastIndex - trendLastIndex;

    const swingHighsShifted = swingHighs.map(p => ({
        index: p.index + offset, time: p.time, price: p.price
    }));
    const swingLowsShifted = swingLows.map(p => ({
        index: p.index + offset, time: p.time, price: p.price
    }));

    const resistance = Math.max(...candles.map(c => Number(c[2])));
    const support = Math.min(...candles.map(c => Number(c[3])));

    return {
        resistance: num(resistance),
        support: num(support),
        resistanceLine,
        supportLine,
        swingHighs: swingHighsShifted,
        swingLows: swingLowsShifted,
        triangle,
        lastIndex,
        currentPrice
    };
}

function shiftLine(line, offset) {
    if (!line) return null;
    return {
        p1: { index: line.p1.index + offset, time: line.p1.time, price: line.p1.price },
        p2: { index: line.p2.index + offset, time: line.p2.time, price: line.p2.price },
        slope: line.slope,
        intercept: line.intercept - line.slope * offset,
        current: line.current,
        projected: line.projected,
        contacts: line.contacts,
        type: line.type
    };
}

// ============================================================
// COMPRESSION
// ============================================================

function compressionInfo(candles) {
    const lookback = 16;
    if (candles.length < lookback + CONFIG.ATR_PERIOD + 2) return null;

    const recent = candles.slice(-lookback);
    const prev = candles.slice(-lookback * 2, -lookback);
    const rAtr = atr(recent, Math.min(CONFIG.ATR_PERIOD, recent.length - 1));
    const pAtr = atr(prev, Math.min(CONFIG.ATR_PERIOD, prev.length - 1));
    if (!rAtr || !pAtr) return null;

    const ratio = rAtr / pAtr;
    return {
        ratio: num(ratio, 3),
        good: ratio <= 0.72
    };
}

// ============================================================
// OI
// ============================================================

async function getOI(symbol) {
    if (!CONFIG.OI_ENABLED) return null;
    try {
        if (typeof exchange.fetchOpenInterest !== 'function') return null;
        const d = await exchange.fetchOpenInterest(symbol);
        const v = Number(d && (d.openInterestValue ?? d.openInterestAmount ?? d.baseVolume));
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
}

function oiContext(symbol, value, direction) {
    if (!value) return { changePct: null, status: 'NOT_AVAILABLE' };
    const h = oiHistory.get(symbol) || [];
    h.push({ t: Date.now(), v: value });
    while (h.length > 30) h.shift();
    oiHistory.set(symbol, h);
    if (h.length < 2) return { changePct: null, status: 'NOT_AVAILABLE' };

    const prev = h[h.length - 2].v;
    const change = pct(value - prev, prev);

    let status = 'NEUTRAL';
    if (direction === 'LONG' && change >= CONFIG.OI_SUPPORTIVE_PCT) status = 'SUPPORTIVE';
    if (direction === 'SHORT' && change <= -CONFIG.OI_SUPPORTIVE_PCT) status = 'SUPPORTIVE';
    if (direction === 'LONG' && change <= -CONFIG.OI_SUPPORTIVE_PCT) status = 'NOT_SUPPORTIVE';
    if (direction === 'SHORT' && change >= CONFIG.OI_SUPPORTIVE_PCT) status = 'NOT_SUPPORTIVE';

    return { changePct: num(change, 3), status };
}

// ============================================================
// REGIME
// ============================================================

async function marketRegime(symbol) {
    try {
        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.REGIME_TIMEFRAME, undefined, CONFIG.REGIME_EMA + 30
        );
        const c = closedCandles(raw);
        const closes = c.map(x => Number(x[4]));
        if (closes.length < CONFIG.REGIME_EMA) return 'UNKNOWN';
        const e = ema(closes, CONFIG.REGIME_EMA);
        const last = closes[closes.length - 1];
        if (last > e) return 'BULLISH';
        if (last < e) return 'BEARISH';
        return 'SIDEWAYS';
    } catch { return 'UNKNOWN'; }
}

// ============================================================
// NEXT LEVEL
// ============================================================

function meaningfulNextLevel(candles, direction, entry) {
    const highs = findSwingHighs(candles)
        .map(x => x.price).filter(p => p > entry * 1.003).sort((a, b) => a - b);
    const lows = findSwingLows(candles)
        .map(x => x.price).filter(p => p < entry * 0.997).sort((a, b) => b - a);
    return direction === 'LONG' ? (highs[0] || null) : (lows[0] || null);
}

// ============================================================
// RISK
// ============================================================

function buildRisk(candles, direction, entry, structure) {
    const curATR = atr(candles, CONFIG.ATR_PERIOD);
    if (!curATR || curATR <= 0) return null;

    let stop;
    if (direction === 'LONG') {
        stop = structure.support - curATR * CONFIG.SL_ATR_MULTIPLIER;
    } else {
        stop = structure.resistance + curATR * CONFIG.SL_ATR_MULTIPLIER;
    }

    const risk = Math.abs(entry - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;

    const nl = meaningfulNextLevel(candles, direction, entry);
    const minR = risk * CONFIG.MIN_RR;

    let tp1;
    if (direction === 'LONG') {
        const mt = entry + minR;
        tp1 = (nl && nl > entry && (nl - entry) >= minR) ? nl * 0.998 : mt;
    } else {
        const mt = entry - minR;
        tp1 = (nl && nl < entry && (entry - nl) >= minR) ? nl * 1.002 : mt;
    }

    const reward = Math.abs(tp1 - entry);
    const rr = reward / risk;

    return {
        atr: curATR, stop, risk, tp1,
        tp2: direction === 'LONG' ? entry + risk * 2.2 : entry - risk * 2.2,
        rr, nextLevel: nl
    };
}

// ============================================================
// SCORE
// ============================================================

function qualityScore(d) {
    let s = 50;
    if (d.volumeRatio >= 2) s += 18;
    else if (d.volumeRatio >= 1.5) s += 12;
    else if (d.volumeRatio >= CONFIG.MIN_VOLUME_RATIO) s += 6;
    if (d.compression && d.compression.good) s += 6;
    if (d.triangle) s += 12;
    if (d.oiStatus === 'SUPPORTIVE') s += 8;
    if (d.oiStatus === 'NOT_SUPPORTIVE') s -= 8;
    if ((d.direction === 'LONG' && d.regime === 'BULLISH') ||
        (d.direction === 'SHORT' && d.regime === 'BEARISH')) s += 8;
    if ((d.direction === 'LONG' && d.regime === 'BEARISH') ||
        (d.direction === 'SHORT' && d.regime === 'BULLISH')) s -= 6;
    if (d.rr >= 2) s += 5;
    if (CONFIG.RSI_CONTEXT_ENABLED && d.rsiValue != null) {
        if (d.direction === 'LONG' && d.rsiValue < CONFIG.RSI_LONG_WEAK) s -= 5;
        if (d.direction === 'SHORT' && d.rsiValue > CONFIG.RSI_SHORT_WEAK) s -= 5;
    }
    return Math.round(clamp(s, 0, 100));
}

function activeFor(symbol) {
    return setups.find(s => s.symbol === symbol &&
        ['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING', 'RETEST_CONFIRMED'].includes(s.state));
}

function serializeLine(line) {
    if (!line) return null;
    return {
        p1: { index: line.p1.index, time: line.p1.time, price: num(line.p1.price) },
        p2: { index: line.p2.index, time: line.p2.time, price: num(line.p2.price) },
        slope: line.slope,
        intercept: line.intercept,
        current: num(line.current),
        projected: num(line.projected),
        contacts: line.contacts,
        type: line.type
    };
}

// ============================================================
// MAKE SETUP
// ============================================================

function makeSetup(symbol, direction, data) {
    const now = Date.now();
    return {
        id: `${symbol.replace(/[^A-Z0-9]/gi, '')}-${direction}-${data.breakoutLevel}-${now}`,
        symbol, timeframe: '2H', direction, signalType: '2H_BREAKOUT', state: 'WATCH',
        currentPrice: num(data.currentPrice),
        trigger: num(data.trigger),
        breakoutLevel: num(data.breakoutLevel),
        resistance: num(data.structure.resistance),
        support: num(data.structure.support),
        resistanceLine: serializeLine(data.structure.resistanceLine),
        supportLine: serializeLine(data.structure.supportLine),
        triangle: data.structure.triangle,
        swingHighs: data.structure.swingHighs,
        swingLows: data.structure.swingLows,
        compression: data.compression,
        compressionRatio: data.compression ? data.compression.ratio : null,
        volumeRatio: num(data.volumeRatio, 3),
        oiChangePct: data.oi.changePct,
        oiStatus: data.oi.status,
        regime: data.regime,
        rsi: data.rsi,
        atr: num(data.risk.atr),
        stop: num(data.risk.stop),
        tp1: num(data.risk.tp1),
        tp2: num(data.risk.tp2),
        rr: num(data.risk.rr, 2),
        risk: data.risk.risk,
        score: data.score,
        retestStatus: 'PENDING',
        retestTouched: false,
        breakoutCandleTime: null,
        breakoutClose: null,
        breakoutHigh: null,
        breakoutLow: null,
        createdAt: now, updatedAt: now,
        expiresAt: now + CONFIG.SETUP_EXPIRY_MS,
        retestPendingSince: null,
        retestTouchAt: null,
        invalidReason: null,
        reason: `${direction} 2H WATCH`
    };
}

// ============================================================
// ANALYZE 2H
// ============================================================

async function analyze2H(symbol) {
    DEBUG.scanned++;
    try {
        const raw = await exchange.fetchOHLCV(symbol, '2h', undefined, CONFIG.FETCH_LIMIT);
        const candles = closedCandles(raw);

        if (candles.length < CONFIG.LOOKBACK + 2) {
            DEBUG.noData++;
            logReject(symbol, 'NO_2H_DATA');
            return null;
        }

        const lookback = candles.slice(-CONFIG.LOOKBACK);
        const structure = buildStructure(lookback);
        const currentPrice = Number(candles[candles.length - 1][4]);

        if (structure.triangle) DEBUG.triangles++;

        let nearestRes = null;
        for (const sh of structure.swingHighs) {
            if (sh.price > currentPrice * 1.001) {
                if (nearestRes === null || sh.price < nearestRes.price) nearestRes = sh;
            }
        }
        let nearestSup = null;
        for (const sl of structure.swingLows) {
            if (sl.price < currentPrice * 0.999) {
                if (nearestSup === null || sl.price > nearestSup.price) nearestSup = sl;
            }
        }

        let resistance = nearestRes ? nearestRes.price : structure.resistance;
        let support = nearestSup ? nearestSup.price : structure.support;

        if (structure.triangle) {
            const t = structure.triangle;
            if (t.resistance.current > currentPrice * 1.001) {
                if (Math.abs(t.resistance.current - currentPrice) < Math.abs(resistance - currentPrice)) {
                    resistance = t.resistance.current;
                }
            }
            if (t.support.current < currentPrice * 0.999) {
                if (Math.abs(t.support.current - currentPrice) < Math.abs(support - currentPrice)) {
                    support = t.support.current;
                }
            }
        }

        if (structure.resistanceLine) {
            const rlNow = valueAt(structure.resistanceLine, structure.lastIndex);
            if (rlNow > currentPrice * 1.001 &&
                Math.abs(rlNow - currentPrice) < Math.abs(resistance - currentPrice)) {
                resistance = rlNow;
            }
        }
        if (structure.supportLine) {
            const slNow = valueAt(structure.supportLine, structure.lastIndex);
            if (slNow < currentPrice * 0.999 &&
                Math.abs(slNow - currentPrice) < Math.abs(support - currentPrice)) {
                support = slNow;
            }
        }

        if (!Number.isFinite(resistance) || !Number.isFinite(support)) {
            DEBUG.noTrendline++;
            logReject(symbol, 'NO_LEVELS');
            return null;
        }

        const longTrigger = resistance * (1 + CONFIG.BREAKOUT_BUFFER);
        const shortTrigger = support * (1 - CONFIG.BREAKOUT_BUFFER);

        const longDist = pct(longTrigger - currentPrice, currentPrice);
        const shortDist = pct(currentPrice - shortTrigger, currentPrice);

        let direction = null, trigger = null, breakoutLevel = null;

        const longOk = longDist >= 0 && longDist <= CONFIG.WATCH_DISTANCE_PERCENT;
        const shortOk = shortDist >= 0 && shortDist <= CONFIG.WATCH_DISTANCE_PERCENT;

        if (longOk && shortOk) {
            if (longDist <= shortDist) {
                direction = 'LONG'; trigger = longTrigger; breakoutLevel = resistance;
            } else {
                direction = 'SHORT'; trigger = shortTrigger; breakoutLevel = support;
            }
        } else if (longOk) {
            direction = 'LONG'; trigger = longTrigger; breakoutLevel = resistance;
        } else if (shortOk) {
            direction = 'SHORT'; trigger = shortTrigger; breakoutLevel = support;
        }

        if (structure.triangle) {
            if (structure.triangle.bias === 'BULLISH' && longOk) {
                direction = 'LONG'; trigger = longTrigger; breakoutLevel = resistance;
            } else if (structure.triangle.bias === 'BEARISH' && shortOk) {
                direction = 'SHORT'; trigger = shortTrigger; breakoutLevel = support;
            }
        }

        if (!direction) {
            DEBUG.tooFar++;
            logReject(symbol, 'TOO_FAR_FROM_LEVEL');
            return null;
        }

        const effStruct = { ...structure, resistance, support };
        const risk = buildRisk(candles, direction, trigger, effStruct);
        if (!risk) { logReject(symbol, 'NO_RISK'); return null; }

        const volumes = lookback.slice(0, -1).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVol = sma(volumes, Math.min(30, volumes.length));
        const lastVol = Number(candles[candles.length - 1][5]);
        const volumeRatio = avgVol ? lastVol / avgVol : 0;

        const compression = compressionInfo(candles);
        const regime = await marketRegime(symbol);
        const oiV = await getOI(symbol);
        const oi = oiContext(symbol, oiV, direction);
        const rsiV = rsi(candles.map(c => Number(c[4])), CONFIG.RSI_PERIOD);

        const score = qualityScore({
            volumeRatio, compression, oiStatus: oi.status,
            regime, direction, rr: risk.rr,
            triangle: structure.triangle, rsiValue: rsiV
        });

        const existing = activeFor(symbol);
        if (existing) {
            DEBUG.duplicate++;
            existing.currentPrice = num(currentPrice);
            existing.resistance = num(resistance);
            existing.support = num(support);
            existing.resistanceLine = serializeLine(structure.resistanceLine);
            existing.supportLine = serializeLine(structure.supportLine);
            existing.triangle = structure.triangle;
            existing.compression = compression;
            existing.compressionRatio = compression ? compression.ratio : null;
            existing.volumeRatio = num(volumeRatio, 3);
            existing.updatedAt = Date.now();
            return existing;
        }

        const activeCount = setups.filter(s =>
            !['SIGNAL_READY', 'EXPIRED', 'CANCELED', 'BREAKOUT_INVALID'].includes(s.state)
        ).length;
        if (activeCount >= CONFIG.MAX_ACTIVE_SETUPS) return null;

        const setup = makeSetup(symbol, direction, {
            currentPrice, trigger, breakoutLevel,
            structure: effStruct, compression, volumeRatio,
            oi, regime, rsi: rsiV, risk, score
        });

        setups.unshift(setup);
        DEBUG.watchCreated++;

        const triStr = structure.triangle
            ? ` | TRI:${structure.triangle.type}(${structure.triangle.convergencePct}%)`
            : '';
        console.log(`\x1b[36m[WATCH] ${symbol} ${direction} | RR=${num(risk.rr, 2)}${triStr}\x1b[0m`);

        return setup;
    } catch (err) {
        logReject(symbol, 'INTERNAL_ERROR');
        console.error(`[analyze2H] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// BREAKOUT CHECK
// ============================================================

async function checkClosed2HBreakouts() {
    const list = setups.filter(s => s.state === 'WATCH');
    for (const setup of list) {
        try {
            const raw = await exchange.fetchOHLCV(setup.symbol, '2h', undefined, CONFIG.FETCH_LIMIT);
            const candles = closedCandles(raw);
            if (candles.length < CONFIG.LOOKBACK + 1) continue;

            const last = candles[candles.length - 1];
            const ts = Number(last[0]);
            if (lastClosed2H.get(setup.symbol) === ts) continue;
            lastClosed2H.set(setup.symbol, ts);

            const prevLB = candles.slice(-CONFIG.LOOKBACK - 1, -1);
            const struct = buildStructure(prevLB);

            const close = Number(last[4]);
            const high = Number(last[2]);
            const low = Number(last[3]);
            const vol = Number(last[5]);

            const cp = Number(setup.currentPrice || close);

            let res = struct.resistance, sup = struct.support;
            if (struct.resistanceLine) res = valueAt(struct.resistanceLine, struct.lastIndex);
            if (struct.supportLine) sup = valueAt(struct.supportLine, struct.lastIndex);

            let nR = null;
            for (const sh of struct.swingHighs) {
                if (sh.price > cp * 1.001) {
                    if (nR === null || sh.price < nR.price) nR = sh;
                }
            }
            let nS = null;
            for (const sl of struct.swingLows) {
                if (sl.price < cp * 0.999) {
                    if (nS === null || sl.price > nS.price) nS = sl;
                }
            }

            if (nR) res = Math.abs(nR.price - cp) < Math.abs(res - cp) ? nR.price : res;
            if (nS) sup = Math.abs(nS.price - cp) < Math.abs(sup - cp) ? nS.price : sup;

            const lt = res * (1 + CONFIG.BREAKOUT_BUFFER);
            const st = sup * (1 - CONFIG.BREAKOUT_BUFFER);

            const avgV = sma(prevLB.map(c => Number(c[5])).filter(Number.isFinite), Math.min(30, prevLB.length));
            const vRatio = avgV ? vol / avgV : 0;

            let confirmed = false;
            if (setup.direction === 'LONG') {
                confirmed = close > lt;
                if (!confirmed && high > lt) setup.invalidReason = 'FALSE_BREAKOUT_WICK';
            } else {
                confirmed = close < st;
                if (!confirmed && low < st) setup.invalidReason = 'FALSE_BREAKOUT_WICK';
            }
            if (!confirmed) continue;

            if (vRatio < CONFIG.MIN_VOLUME_RATIO) {
                setup.invalidReason = 'LOW_VOLUME';
                DEBUG.lowVolume++;
                continue;
            }

            setup.state = CONFIG.RETEST_REQUIRED ? 'RETEST_PENDING' : 'BREAKOUT_CONFIRMED';
            setup.retestPendingSince = Date.now();
            setup.breakoutCandleTime = ts;
            setup.breakoutClose = num(close);
            setup.breakoutHigh = num(high);
            setup.breakoutLow = num(low);
            setup.breakoutLevel = num(setup.direction === 'LONG' ? res : sup);
            setup.trigger = num(setup.direction === 'LONG' ? lt : st);
            setup.volumeRatio = num(vRatio, 3);
            setup.retestStatus = CONFIG.RETEST_REQUIRED ? 'PENDING' : 'NOT_REQUIRED';
            setup.retestTouched = false;
            setup.updatedAt = Date.now();

            DEBUG.breakouts++;
            console.log(`\x1b[33m[2H BREAKOUT] ${setup.symbol} ${setup.direction}\x1b[0m`);

            if (!CONFIG.RETEST_REQUIRED) await finalizeSignal(setup);
        } catch (err) {
            console.error(`[BREAKOUT] ${setup.symbol}: ${err.message}`);
        }
    }
}

// ============================================================
// LIVE / RETEST
// ============================================================

async function updateLivePricesAndRetests() {
    let tickers = {};
    try { tickers = await exchange.fetchTickers(); }
    catch (err) { console.error(`[TICKER] ${err.message}`); return; }

    const now = Date.now();

    for (const setup of setups) {
        const t = tickers[setup.symbol];
        if (t && Number(t.last) > 0) {
            setup.currentPrice = num(t.last);
            setup.updatedAt = now;
        }

        if (['SIGNAL_READY', 'EXPIRED', 'CANCELED', 'BREAKOUT_INVALID'].includes(setup.state)) continue;

        if (now > setup.expiresAt) {
            setup.state = 'EXPIRED';
            setup.invalidReason = 'EXPIRED';
            setup.finishedAt = now;
            DEBUG.expired++;
            continue;
        }

        if (!['BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(setup.state)) continue;
        if (!setup.currentPrice || !setup.breakoutLevel) continue;

        if (!setup.retestPendingSince) setup.retestPendingSince = now;
        if (now - setup.retestPendingSince > CONFIG.RETEST_TIMEOUT_MS) {
            setup.state = 'EXPIRED';
            setup.invalidReason = 'RETEST_TIMEOUT';
            setup.finishedAt = now;
            DEBUG.expired++;
            continue;
        }

        const price = Number(setup.currentPrice);
        const cATR = Number(setup.atr) || 0;
        const zone = cATR * CONFIG.RETEST_ZONE_ATR;
        const inv = cATR * CONFIG.RETEST_INVALID_ATR;

        if (setup.direction === 'LONG') {
            if (price >= setup.breakoutLevel - zone && price <= setup.breakoutLevel + zone) {
                if (price <= setup.breakoutLevel) {
                    setup.retestTouched = true;
                    setup.retestTouchAt = setup.retestTouchAt || now;
                    setup.retestStatus = 'TOUCHING';
                }
            }
            if (setup.retestTouched && price > setup.breakoutLevel + zone * 0.35) {
                setup.state = 'RETEST_CONFIRMED';
                setup.retestStatus = 'CONFIRMED';
                DEBUG.retests++;
                await finalizeSignal(setup);
            }
            if (price < setup.breakoutLevel - inv) invalidateSetup(setup, 'BREAKOUT_INVALID_RETEST');
        } else {
            if (price >= setup.breakoutLevel - zone && price <= setup.breakoutLevel + zone) {
                if (price >= setup.breakoutLevel) {
                    setup.retestTouched = true;
                    setup.retestTouchAt = setup.retestTouchAt || now;
                    setup.retestStatus = 'TOUCHING';
                }
            }
            if (setup.retestTouched && price < setup.breakoutLevel - zone * 0.35) {
                setup.state = 'RETEST_CONFIRMED';
                setup.retestStatus = 'CONFIRMED';
                DEBUG.retests++;
                await finalizeSignal(setup);
            }
            if (price > setup.breakoutLevel + inv) invalidateSetup(setup, 'BREAKOUT_INVALID_RETEST');
        }
    }

    cleanSetups();
    broadcast();
}

function invalidateSetup(setup, reason) {
    setup.state = 'BREAKOUT_INVALID';
    setup.invalidReason = reason;
    setup.finishedAt = Date.now();
    DEBUG.invalid++;
}

// ============================================================
// FINALIZE
// ============================================================

async function finalizeSignal(setup) {
    if (setup.state === 'SIGNAL_READY') return;

    const entry = Number(setup.currentPrice || setup.trigger);
    const stop = Number(setup.stop);
    const risk = Math.abs(entry - stop);

    if (!Number.isFinite(entry) || !Number.isFinite(risk) || risk <= 0) {
        invalidateSetup(setup, 'NO_RISK');
        return;
    }

    const tp1 = Number(setup.tp1);
    if (setup.direction === 'LONG' && tp1 <= entry) { invalidateSetup(setup, 'INVALID_TP1'); return; }
    if (setup.direction === 'SHORT' && tp1 >= entry) { invalidateSetup(setup, 'INVALID_TP1'); return; }

    const reward = Math.abs(tp1 - entry);
    const rr = reward / risk;
    if (rr < CONFIG.MIN_RR) { setup.invalidReason = 'RR_TOO_LOW'; return; }

    const tpPct = pct(reward, entry);
    if (tpPct < CONFIG.TARGET_SPACE_MIN_PERCENT) {
        setup.invalidReason = 'TARGET_TOO_CLOSE';
        DEBUG.targetTooClose++;
        return;
    }

    setup.state = 'SIGNAL_READY';
    setup.finishedAt = Date.now();
    setup.retestStatus = CONFIG.RETEST_REQUIRED ? 'CONFIRMED' : 'NOT_REQUIRED';

    const signal = {
        id: setup.id, symbol: setup.symbol, timeframe: '2H',
        direction: setup.direction, signalType: '2H_BREAKOUT',
        entry: num(entry), stop: num(setup.stop),
        tp1: num(setup.tp1), tp2: num(setup.tp2),
        rr: num(rr, 2), score: setup.score,
        breakoutLevel: num(setup.breakoutLevel),
        volumeRatio: setup.volumeRatio,
        oiStatus: setup.oiStatus,
        regime: setup.regime,
        triangle: setup.triangle,
        timestamp: Date.now()
    };

    APP_STATE.signals.unshift(signal);
    APP_STATE.signals = APP_STATE.signals.slice(0, 50);
    DEBUG.signals++;

    console.log(`\x1b[32m>>> SINYAL ${setup.symbol} ${setup.direction} @ ${signal.entry}\x1b[0m`);
    broadcast();
}

function cleanSetups() {
    const now = Date.now();
    setups = setups.filter(s => {
        if (s.state === 'SIGNAL_READY') return (now - (s.finishedAt || now)) < CONFIG.SIGNAL_KEEP_MS;
        if (['EXPIRED', 'CANCELED', 'BREAKOUT_INVALID'].includes(s.state))
            return (now - (s.finishedAt || now)) < 2 * 60 * 60 * 1000;
        return true;
    });
}

// ============================================================
// PRESCAN
// ============================================================

async function runPreScan() {
    try {
        if (!exchange.markets || !Object.keys(exchange.markets).length) {
            await exchange.loadMarkets(true);
        }
        const tickers = await exchange.fetchTickers(undefined, { type: 'swap' });
        const list = [];
        for (const t of Object.values(tickers || {})) {
            if (!t || !t.symbol) continue;
            const m = exchange.markets[t.symbol];
            if (!m || !m.active || !m.swap || m.quote !== 'USDT') continue;
            const v = Number(t.quoteVolume);
            if (Number.isFinite(v) && v >= CONFIG.MIN_24H_VOLUME_USDT) {
                list.push({ symbol: t.symbol, volume: v });
            }
        }
        list.sort((a, b) => b.volume - a.volume);
        targets = list.slice(0, CONFIG.MAX_TARGETS).map(i => i.symbol);
        lastPrescanAt = Date.now();
        console.log(`RADAR | ${targets.length} coin`);
    } catch (err) {
        console.error(`[runPreScan] ${err.message}`);
    }
}

// ============================================================
// SCAN
// ============================================================

async function run2HScan() {
    if (scanRunning) return;
    scanRunning = true;
    rejectLogCount = 0;

    APP_STATE.scanStatus = { message: `2H tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    try {
        for (const s of targets) {
            if (isShuttingDown) break;
            await analyze2H(s);
            await sleep(CONFIG.API_DELAY_MS);
        }
        await checkClosed2HBreakouts();
        lastScanAt = Date.now();
    } catch (err) {
        console.error(`[run2HScan] ${err.message}`);
    }

    scanRunning = false;
    APP_STATE.scanStatus = { message: `Tarama bitti | ${setups.length} setup`, isScanning: false };
    broadcast();
    console.log(`[SCAN DONE] scanned=${DEBUG.scanned} watch=${DEBUG.watchCreated} active=${setups.length} triangles=${DEBUG.triangles}`);
}

async function runAll() {
    if (Date.now() - lastPrescanAt > CONFIG.PRESCAN_INTERVAL_MS || !targets.length) {
        await runPreScan();
    }
    await run2HScan();
}

// ============================================================
// HELPERS
// ============================================================

function normalizeSymbol(input) {
    let s = String(input || '').trim().toUpperCase();
    if (!s.includes('/')) {
        if (s.endsWith('USDT')) s = s.slice(0, -4) + '/USDT:USDT';
    }
    return s;
}

async function chartData(symbol, timeframe) {
    const allowed = ['2h', '4h', '1h', '15m', '5m'];
    const tf = allowed.includes(timeframe) ? timeframe : '2h';

    const raw = await exchange.fetchOHLCV(symbol, tf, undefined, tf === '2h' ? 80 : 100);
    const candles = closedCandles(raw);

    let structure = null;
    if (tf === '2h' && candles.length >= CONFIG.LOOKBACK) {
        structure = buildStructure(candles.slice(-CONFIG.LOOKBACK));
    }

    return {
        success: true, symbol, timeframe: tf,
        candles: candles.slice(-80),
        structure: structure ? {
            resistance: structure.resistance,
            support: structure.support,
            resistanceLine: serializeLine(structure.resistanceLine),
            supportLine: serializeLine(structure.supportLine),
            triangle: structure.triangle,
            swingHighs: structure.swingHighs,
            swingLows: structure.swingLows
        } : null
    };
}

// ============================================================
// API
// ============================================================

app.get('/api/setups', (req, res) => res.json(snapshot()));
app.get('/api/debug', (req, res) => res.json({
    success: true, debug: DEBUG, config: CONFIG,
    rejectionReasons: DEBUG.rejectionReasons, targets: targets.length
}));
app.get('/api/health', (req, res) => res.json({
    ok: true, time: Date.now(), targets: targets.length, setups: setups.length
}));
app.get('/api/chart', async (req, res) => {
    try {
        const s = normalizeSymbol(req.query.symbol);
        const data = await chartData(s, req.query.timeframe);
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
app.post('/api/analyze-coin', async (req, res) => {
    try {
        const s = normalizeSymbol(req.body.symbol);
        if (!s) return res.status(400).json({ success: false, error: 'Sembol eksik' });
        const setup = await analyze2H(s);
        res.json({ success: true, setup });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// SNAPSHOT / BROADCAST
// ============================================================

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    return {
        success: true,
        setups: setups.slice(0, 100),
        signals: APP_STATE.signals,
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: setups.length,
            watch: setups.filter(x => x.state === 'WATCH').length,
            breakout: setups.filter(x => ['BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(x.state)).length,
            signal: setups.filter(x => x.state === 'SIGNAL_READY').length,
            triangle: setups.filter(x => !!x.triangle).length
        },
        updatedAt: APP_STATE.updatedAt
    };
}

function broadcast() {
    const msg = JSON.stringify({ type: 'update', data: snapshot() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', sock => {
    sock.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

// ============================================================
// FRONTEND
// ============================================================

const HTML = `
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI TRADER - 2H BREAKOUT</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#070b11;color:#e9eef5;font-family:Arial,sans-serif}
.wrap{max-width:1500px;margin:auto;padding:12px}
.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #17202b;padding-bottom:10px}
.brand{font-size:18px;font-weight:800}
.status{font-size:11px;color:#9aa7b5}
.grid{display:grid;grid-template-columns:330px 1fr;gap:12px;margin-top:12px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.panel{background:#0b1119;border:1px solid #17212d;border-radius:10px;overflow:hidden}
.list{max-height:78vh;overflow:auto}
.card{padding:12px;border-bottom:1px solid #17212d;cursor:pointer}
.card:hover,.card.sel{background:#101923}
.row{display:flex;justify-content:space-between;gap:8px}
.coin{font-weight:800}
.long{color:#17d7a0}
.short{color:#ff5c77}
.meta{font-size:10px;color:#7f8b98;margin-top:7px;display:flex;gap:8px;flex-wrap:wrap}
.main{padding:10px}
.chartHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.chart{height:65vh;min-height:420px}
canvas{width:100%;height:100%;display:block;background:#070b11}
.details{border-top:1px solid #17212d;margin-top:10px;padding-top:10px;display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
@media(max-width:800px){.details{grid-template-columns:repeat(2,1fr)}}
.d{background:#0e151e;border-radius:7px;padding:8px}
.d span{display:block;font-size:9px;color:#7f8b98}
.d b{font-size:12px}
.legend{font-size:10px;color:#8d9aa8}
.badge{padding:4px 7px;border-radius:5px;font-size:10px;font-weight:700}
.tri{color:#f6c453;background:#2a2410}
.asc{color:#17d7a0;background:#0f2a24}
.desc{color:#ff5c77;background:#2a0f14}
.sym{color:#f6c453;background:#2a2410}
</style>
</head>
<body>
<div class="wrap">
<div class="top">
<div class="brand">SONNY AI TRADER - 2H BREAKOUT</div>
<div id="status" class="status">Baglaniyor...</div>
</div>
<div class="grid">
<div class="panel"><div class="list" id="list"></div></div>
<div class="panel main">
<div class="chartHead">
<b id="title">2H YAPI</b>
<span class="legend">YESIL DESTEK - KIRMIZI DIRENC - SARI UCGEN - APEX</span>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
<div id="details" class="details"></div>
</div>
</div>
</div>
<script>
var setups=[],selected=null,chart=null,ws=null;
var TRIANGLE_EXTEND = 20;

function fmt(v){
    v=Number(v);
    if(!Number.isFinite(v))return '-';
    if(v>=1000)return v.toFixed(2);
    if(v>=100)return v.toFixed(3);
    if(v>=1)return v.toFixed(5);
    return v.toFixed(8);
}

function esc(v){
    return String(v==null?'':v).replace(/[&<>"']/g,function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
}

function triangleBadge(t){
    if(!t) return '';
    if(t.type==='SYMMETRICAL') return '<span class="badge sym">SIMETRIK UCGEN</span>';
    if(t.type==='ASCENDING')   return '<span class="badge asc">YUKSELEN UCGEN</span>';
    if(t.type==='DESCENDING')  return '<span class="badge desc">ALCALAN UCGEN</span>';
    return '<span class="badge tri">UCGEN</span>';
}

function render(){
    var list=document.getElementById('list');
    if(!setups.length){
        list.innerHTML='<div style="padding:20px;color:#7f8b98">Setup yok. Tarama devam ediyor...</div>';
        return;
    }
    var html='';
    for(var i=0;i<setups.length;i++){
        var s=setups[i];
        var sel=(selected && selected.id===s.id)?'sel':'';
        var cls=(s.direction==='LONG')?'long':'short';
        var tri=triangleBadge(s.triangle);
        html+='<div class="card '+sel+'" data-id="'+esc(s.id)+'">'
            +'<div class="row">'
            +'<span class="coin">'+esc(s.symbol.replace(':USDT',''))+'</span>'
            +'<b class="'+cls+'">'+s.direction+'</b>'
            +'</div>'
            +'<div style="margin-top:5px"><span class="badge">'+esc(s.state)+'</span> '+tri+'</div>'
            +'<div class="meta">'
            +'<span>Skor '+esc(s.score)+'</span>'
            +'<span>Vol '+esc(s.volumeRatio)+'x</span>'
            +'<span>RR '+esc(s.rr)+'</span>'
            +'</div>'
            +'</div>';
    }
    list.innerHTML=html;
    var cards=list.querySelectorAll('.card');
    for(var k=0;k<cards.length;k++){
        cards[k].onclick=function(){
            var id=this.getAttribute('data-id');
            for(var m=0;m<setups.length;m++){
                if(setups[m].id===id){selected=setups[m];break;}
            }
            render();
            if(selected)loadChart(selected.symbol);
        };
    }
}

function draw(){
    var canvas=document.getElementById('cv');
    if(!chart||!chart.candles||!chart.candles.length)return;
    var parent=canvas.parentElement;
    var W=parent.clientWidth;
    var H=parent.clientHeight;
    var dpr=window.devicePixelRatio||1;
    canvas.width=W*dpr;canvas.height=H*dpr;
    canvas.style.width=W+'px';canvas.style.height=H+'px';
    var ctx=canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#070b11';ctx.fillRect(0,0,W,H);

    var visible=chart.candles.slice(-60);
    var count=visible.length;
    var st=chart.structure;
    var chartOffset=chart.candles.length - count;

    // Apex varsa gorunur alani uzat
    var extraCount=0;
    var hasTriangle=!!(st && st.triangle);

    if(hasTriangle && st.triangle.apexIndex != null){
        var apexGlobal=st.triangle.apexIndex;
        if(apexGlobal > chartOffset + count - 1){
            extraCount=Math.min(
                TRIANGLE_EXTEND,
                apexGlobal - (chartOffset + count - 1)
            );
        }
    }

    var totalCount=count + extraCount;
    var offset=chartOffset;

    // MIN/MAX
    var minP=Infinity,maxP=-Infinity;
    for(var i=0;i<visible.length;i++){
        var lo=Number(visible[i][3]),hi=Number(visible[i][2]);
        if(lo<minP)minP=lo;
        if(hi>maxP)maxP=hi;
    }

    if(st){
        var vals=[st.resistance,st.support];
        // TRENDLINE'lari min/max'a kat SADECE ucgen yoksa
        if(!hasTriangle){
            if(st.resistanceLine){vals.push(st.resistanceLine.current);vals.push(st.resistanceLine.projected);}
            if(st.supportLine){vals.push(st.supportLine.current);vals.push(st.supportLine.projected);}
        } else {
            vals.push(st.triangle.resistance.current);
            vals.push(st.triangle.resistance.future);
            vals.push(st.triangle.support.current);
            vals.push(st.triangle.support.future);
            if(st.triangle.apexPrice!=null) vals.push(st.triangle.apexPrice);
            if(st.triangle.target!=null) vals.push(st.triangle.target);
        }
        for(var v=0;v<vals.length;v++){
            if(vals[v]&&vals[v]<minP)minP=vals[v];
            if(vals[v]&&vals[v]>maxP)maxP=vals[v];
        }
    }

    var pad=(maxP-minP)*0.08||1;
    minP-=pad;maxP+=pad;

    var LEFT=50,RIGHT=115,TOP=15,BOTTOM=18;
    var PW=W-LEFT-RIGHT, PH=H-TOP-BOTTOM;

    function X(i){return LEFT+i*PW/(totalCount-1||1);}
    function Y(p){return TOP+(maxP-p)/(maxP-minP)*PH;}

    // GRID
    ctx.font='9px Arial';ctx.fillStyle='#607083';
    for(var g=0;g<=5;g++){
        var y=TOP+PH*g/5;
        ctx.strokeStyle='#16212c';
        ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();
        ctx.fillText(fmt(maxP-(maxP-minP)*g/5),5,y+3);
    }

    // MUM CIZIMI
    var cw=Math.max(2,Math.min(9,PW/count*0.65));
    for(var c=0;c<visible.length;c++){
        var k=visible[c];
        var x=X(c);
        var o=Number(k[1]),cl=Number(k[4]),h=Number(k[2]),l=Number(k[3]);
        var bull=cl>=o;
        var color=bull?'#17d7a0':'#ff5c77';
        ctx.strokeStyle=color;ctx.fillStyle=color;
        ctx.beginPath();ctx.moveTo(x,Y(h));ctx.lineTo(x,Y(l));ctx.stroke();
        var oY=Y(o),cY=Y(cl);
        ctx.fillRect(x-cw/2,Math.min(oY,cY),cw,Math.max(1,Math.abs(cY-oY)));
    }

    if(st){
        var extendTo=totalCount-1;

        // ==========================================
        // TRENDLINE CIZIMI - SADECE UCGEN YOKSA
        // ==========================================
        if(!hasTriangle){
            // Kirmizi direnc
            if(st.resistanceLine && st.resistanceLine.p1){
                var l=st.resistanceLine;
                var y1=Y(l.slope*offset+l.intercept);
                var y2=Y(l.slope*(offset+extendTo)+l.intercept);
                ctx.save();
                ctx.strokeStyle='#ff5c77';ctx.lineWidth=2;ctx.setLineDash([8,5]);
                ctx.beginPath();ctx.moveTo(X(0),y1);ctx.lineTo(X(extendTo),y2);ctx.stroke();
                ctx.restore();
            }

            // Yesil destek
            if(st.supportLine && st.supportLine.p1){
                var l2=st.supportLine;
                var y3=Y(l2.slope*offset+l2.intercept);
                var y4=Y(l2.slope*(offset+extendTo)+l2.intercept);
                ctx.save();
                ctx.strokeStyle='#17d7a0';ctx.lineWidth=2;ctx.setLineDash([8,5]);
                ctx.beginPath();ctx.moveTo(X(0),y3);ctx.lineTo(X(extendTo),y4);ctx.stroke();
                ctx.restore();
            }
        }

        // SWING NOKTALARI
        if(st.swingHighs){
            ctx.save();ctx.fillStyle='#ff5c77';
            for(var sh=0;sh<st.swingHighs.length;sh++){
                var p=st.swingHighs[sh];
                if(p.index>=offset && p.index<offset+count){
                    var px=X(p.index-offset),py=Y(p.price);
                    ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();
                }
            }
            ctx.restore();
        }

        if(st.swingLows){
            ctx.save();ctx.fillStyle='#17d7a0';
            for(var sl=0;sl<st.swingLows.length;sl++){
                var p2=st.swingLows[sl];
                if(p2.index>=offset && p2.index<offset+count){
                    var px2=X(p2.index-offset),py2=Y(p2.price);
                    ctx.beginPath();ctx.arc(px2,py2,3,0,Math.PI*2);ctx.fill();
                }
            }
            ctx.restore();
        }

        // ==========================================
        // UCGEN FORMASYONU
        // ==========================================
        if(hasTriangle){
            var t=st.triangle;

            // UST KENAR
            if(t.resistance && t.resistance.p1){
                var rs=t.resistance.slope;
                var ri=t.resistance.p1.price - rs * t.resistance.p1.index;
                var startI=Math.max(t.resistance.p1.index, offset);
                var endI;
                if(t.apexIndex!=null && t.apexIndex > offset + count - 1){
                    endI=Math.min(t.apexIndex, offset + totalCount - 1);
                } else if(t.apexIndex!=null){
                    endI=Math.min(t.apexIndex, offset + count - 1);
                } else {
                    endI=offset + count - 1;
                }

                if(endI > startI){
                    var ax1=X(startI-offset);
                    var ay1=Y(rs * startI + ri);
                    var ax2=X(endI-offset);
                    var ay2=Y(rs * endI + ri);
                    ctx.save();
                    ctx.strokeStyle='#f6c453';ctx.lineWidth=2.5;
                    ctx.beginPath();ctx.moveTo(ax1,ay1);ctx.lineTo(ax2,ay2);ctx.stroke();
                    ctx.restore();
                }
            }

            // ALT KENAR
            if(t.support && t.support.p1){
                var ss=t.support.slope;
                var si=t.support.p1.price - ss * t.support.p1.index;
                var sStartI=Math.max(t.support.p1.index, offset);
                var sEndI;
                if(t.apexIndex!=null && t.apexIndex > offset + count - 1){
                    sEndI=Math.min(t.apexIndex, offset + totalCount - 1);
                } else if(t.apexIndex!=null){
                    sEndI=Math.min(t.apexIndex, offset + count - 1);
                } else {
                    sEndI=offset + count - 1;
                }

                if(sEndI > sStartI){
                    var bx1=X(sStartI-offset);
                    var by1=Y(ss * sStartI + si);
                    var bx2=X(sEndI-offset);
                    var by2=Y(ss * sEndI + si);
                    ctx.save();
                    ctx.strokeStyle='#f6c453';ctx.lineWidth=2.5;
                    ctx.beginPath();ctx.moveTo(bx1,by1);ctx.lineTo(bx2,by2);ctx.stroke();
                    ctx.restore();
                }
            }

            // APEX NOKTASI
            if(t.apexIndex!=null && t.apexPrice!=null){
                var apexI=t.apexIndex;
                if(apexI >= offset && apexI <= offset + totalCount - 1){
                    var apexX=X(apexI-offset);
                    var apexY=Y(t.apexPrice);

                    ctx.save();
                    ctx.fillStyle='rgba(246,196,83,0.25)';
                    ctx.beginPath();
                    ctx.arc(apexX, apexY, 12, 0, Math.PI*2);
                    ctx.fill();

                    ctx.fillStyle='#f6c453';
                    ctx.beginPath();
                    ctx.arc(apexX, apexY, 5, 0, Math.PI*2);
                    ctx.fill();

                    ctx.strokeStyle='#f6c453';
                    ctx.lineWidth=2;
                    ctx.beginPath();
                    ctx.arc(apexX, apexY, 8, 0, Math.PI*2);
                    ctx.stroke();

                    ctx.fillStyle='#f6c453';
                    ctx.font='bold 10px Arial';
                    ctx.fillText('APEX', apexX - 18, apexY - 15);
                    ctx.restore();
                }
            }

            // FORMASYON ETIKETI
            ctx.save();
            ctx.font='bold 11px Arial';
            var lbl='';
            if(t.type==='SYMMETRICAL') lbl='SIMETRIK UCGEN';
            else if(t.type==='ASCENDING') lbl='YUKSELEN UCGEN';
            else if(t.type==='DESCENDING') lbl='ALCALAN UCGEN';
            else lbl='UCGEN';

            lbl += '  -  Daralma: ' + t.convergencePct + '%';

            var textW=ctx.measureText(lbl).width + 16;
            ctx.fillStyle='rgba(246,196,83,0.15)';
            ctx.fillRect(LEFT+5, TOP+3, textW, 20);

            ctx.fillStyle='#f6c453';
            ctx.fillText(lbl, LEFT+13, TOP+17);
            ctx.restore();

            // HEDEF
            if(t.target != null){
                var targetY=Y(t.target);
                if(targetY > TOP && targetY < H - BOTTOM){
                    var tColor = (t.type==='DESCENDING') ? '#ff5c77' : '#17d7a0';
                    ctx.save();
                    ctx.strokeStyle=tColor;
                    ctx.lineWidth=1.5;
                    ctx.setLineDash([4,6]);
                    ctx.beginPath();
                    ctx.moveTo(LEFT, targetY);
                    ctx.lineTo(W - RIGHT + 30, targetY);
                    ctx.stroke();

                    ctx.fillStyle=tColor;
                    ctx.font='bold 10px Arial';
                    ctx.fillText('HEDEF ' + fmt(t.target), W-RIGHT+5, targetY+3);
                    ctx.restore();
                }
            }
        }

        // HORIZONTAL SEVIYELER (her zaman)
        ctx.save();
        ctx.font='bold 10px Arial';
        ctx.fillStyle='#ff5c77';
        ctx.fillText('DIR '+fmt(st.resistance),W-RIGHT+5,Y(st.resistance)+3);
        ctx.fillStyle='#17d7a0';
        ctx.fillText('DES '+fmt(st.support),W-RIGHT+5,Y(st.support)+3);
        ctx.restore();
    }

    // DETAY PANELI
    if(selected){
        var vv=[
            ['DURUM',selected.state],['YON',selected.direction],
            ['GIRIS',fmt(selected.trigger)],['STOP',fmt(selected.stop)],
            ['TP1',fmt(selected.tp1)],['TP2',fmt(selected.tp2)],
            ['RR',selected.rr],['SKOR',selected.score],
            ['VOL',selected.volumeRatio+'x'],['OI',selected.oiStatus],
            ['RETEST',selected.retestStatus],['REGIME',selected.regime]
        ];
        var dh='';
        for(var d=0;d<vv.length;d++){
            dh+='<div class="d"><span>'+vv[d][0]+'</span><b>'+esc(vv[d][1])+'</b></div>';
        }
        if(selected.triangle){
            var t2=selected.triangle;
            var tLbl = t2.type==='SYMMETRICAL'?'SIMETRIK':(t2.type==='ASCENDING'?'YUKSELEN':(t2.type==='DESCENDING'?'ALCALAN':'UCGEN'));
            dh+='<div class="d"><span>FORMASYON</span><b>'+tLbl+'</b></div>';
            dh+='<div class="d"><span>DARALMA</span><b>'+t2.convergencePct+'%</b></div>';
            dh+='<div class="d"><span>DIRE._DOKUNMA</span><b>'+t2.resistanceTouches+'</b></div>';
            dh+='<div class="d"><span>DESTEK_DOKUNMA</span><b>'+t2.supportTouches+'</b></div>';
            if(t2.apexIndex!=null){
                dh+='<div class="d"><span>APEX MUM</span><b>+' + t2.apexDistance + '</b></div>';
            }
            if(t2.target!=null){
                dh+='<div class="d"><span>FORMASYON HEDEFI</span><b>'+fmt(t2.target)+'</b></div>';
            }
        }
        document.getElementById('details').innerHTML=dh;
    }
}

async function loadChart(symbol){
    try{
        var r=await fetch('/api/chart?symbol='+encodeURIComponent(symbol)+'&timeframe=2h');
        var d=await r.json();
        if(d.success){
            chart=d;
            document.getElementById('title').textContent=
                symbol.replace(':USDT','')+' - 2H DESTEK / DIRENC / SIKISMA';
            draw();
        }
    }catch(e){console.error(e);}
}

function apply(data){
    setups=Array.isArray(data.setups)?data.setups:[];
    if(selected){
        var f=null;
        for(var i=0;i<setups.length;i++) if(setups[i].id===selected.id){f=setups[i];break;}
        selected=f||selected;
    }
    render();draw();
    var m=(data.scanStatus&&data.scanStatus.message)?data.scanStatus.message:'Hazir';
    document.getElementById('status').textContent=m+' | '+new Date().toLocaleTimeString('tr-TR');
}

function connect(){
    var proto=location.protocol==='https:'?'wss://':'ws://';
    ws=new WebSocket(proto+location.host);
    ws.onopen=function(){document.getElementById('status').textContent='CANLI';};
    ws.onmessage=function(ev){
        try{
            var m=JSON.parse(ev.data);
            if(m.type==='snapshot'||m.type==='update') apply(m.data);
        }catch(e){console.error(e);}
    };
    ws.onclose=function(){
        document.getElementById('status').textContent='Yenileniyor...';
        setTimeout(connect,3000);
    };
}

fetch('/api/setups').then(function(r){return r.json();}).then(apply).catch(function(){});
connect();
window.addEventListener('resize',draw);
</script>
</body>
</html>
`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// START
// ============================================================

async function start() {
    try {
        await exchange.loadMarkets();
        console.log(`Bitget marketleri yuklendi | ${Object.keys(exchange.markets).length} market`);
        await runPreScan();
        await run2HScan();

        setInterval(function(){ runAll(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ updateLivePricesAndRetests(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);

        console.log('SONNY 2H donguleri baslatildi.');
    } catch (err) {
        console.error(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} alindi; kapaniyor.`);
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function(){
        try { await exchange.close(); } catch (e) {}
        process.exit(0);
    });
    setTimeout(function(){ process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function(){ shutdown('SIGINT'); });
process.once('SIGTERM', function(){ shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function(){
    console.log(`SONNY 2H Breakout Engine PORT=${PORT}`);
    start();
});
