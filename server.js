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

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// ============================================================
// SONER TRADE v5.0 — Sağlam Kırılım Sistemi
// ============================================================

const CONFIG = {
    TIMEFRAME: '15m',
    HTF1: '1h',
    HTF2: '4h',
    CANDLE_LIMIT: 200,

    // KIRILIM
    BREAKOUT_LOOKBACK: 15,
    MIN_BREAKOUT_BUFFER: 0.002,
    MIN_VOLUME_MULTIPLIER: 2.0,
    MIN_BODY_ATR_RATIO: 0.5,

    // YAKLAŞIM
    APPROACH_DISTANCE: 0.005,
    APPROACH_MIN_VOLUME: 1.5,

    // TREND
    EMA_FAST: 21,
    EMA_SLOW: 50,

    // ATR / RSI
    ATR_PERIOD: 14,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 75,
    RSI_OVERSOLD: 25,

    // STOP / TP
    STOP_ATR_MULT: 0.3,
    TP1_RR: 1.5,
    TP2_RR: 3.0,

    // KALİTE
    MIN_QUALITY_SCORE: 70,

    // SİNYAL
    SIGNAL_VALID_MS: 4 * 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 60 * 60 * 1000,

    // LİKİDİTE
    MIN_24H_VOLUME_USDT: 2000000,
    MAX_TARGETS: 200,

    EXCLUDED_BASES: [
        'USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD',
        'WBTC', 'WETH', 'WSTETH', 'STETH'
    ],

    SCAN_INTERVAL_MS: 2 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    LIVE_INTERVAL_MS: 3000,
    MARKET_STATUS_INTERVAL_MS: 30 * 1000,
    API_DELAY_MS: 150,

    MAX_SIGNALS_KEPT: 100,
    DEBUG: true
};

// ============================================================
// BINANCE FUTURES
// ============================================================

const exchange = new ccxt.binance({
    enableRateLimit: true,
    rateLimit: 200,
    options: {
        defaultType: 'future',
        adjustForTimeDifference: true
    }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let signals = [];
let marketStatus = {
    btc: null,
    eth: null,
    overall: 'UNKNOWN',
    score: 0,
    updatedAt: 0
};
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;

const lastSignalTime = new Map();

const APP_STATE = {
    scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false },
    updatedAt: Date.now()
};

const DEBUG = {
    scanned: 0,
    breakoutsDetected: 0,
    approachesDetected: 0,
    signals: 0,
    long: 0, short: 0,
    rejectedVolume: 0,
    rejectedBody: 0,
    rejectedTrend: 0,
    rejectedQuality: 0,
    rejectedCooldown: 0,
    errors: 0
};

// ============================================================
// LOG
// ============================================================

function logDebug(...args) { if (CONFIG.DEBUG) console.log('[DEBUG]', ...args); }
function logInfo(...args) { console.log('[INFO]', ...args); }
function logError(...args) { console.error('[ERROR]', ...args); }

// ============================================================
// YARDIMCILAR
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
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

function closedCandles(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return [];
    return ohlcv.slice(0, -1).filter(c => Array.isArray(c) && c.length >= 6);
}

function isExcluded(symbol) {
    const base = symbol.split('/')[0].toUpperCase();
    for (const ex of CONFIG.EXCLUDED_BASES) {
        if (base === ex) return true;
    }
    return false;
}

// ============================================================
// TREND TESPİTİ (1h + 4h)
// ============================================================

async function getTrends(symbol) {
    try {
        const raw1h = await exchange.fetchOHLCV(symbol, CONFIG.HTF1, undefined, 100);
        const closes1h = closedCandles(raw1h).map(c => Number(c[4]));
        const ema21_1h = ema(closes1h, CONFIG.EMA_FAST);
        const ema50_1h = ema(closes1h, CONFIG.EMA_SLOW);
        let trend1h = 'SIDEWAYS';
        if (ema21_1h && ema50_1h) {
            if (ema21_1h > ema50_1h * 1.001) trend1h = 'BULLISH';
            else if (ema21_1h < ema50_1h * 0.999) trend1h = 'BEARISH';
        }

        const raw4h = await exchange.fetchOHLCV(symbol, CONFIG.HTF2, undefined, 100);
        const closes4h = closedCandles(raw4h).map(c => Number(c[4]));
        const ema21_4h = ema(closes4h, CONFIG.EMA_FAST);
        const ema50_4h = ema(closes4h, CONFIG.EMA_SLOW);
        let trend4h = 'SIDEWAYS';
        if (ema21_4h && ema50_4h) {
            if (ema21_4h > ema50_4h * 1.001) trend4h = 'BULLISH';
            else if (ema21_4h < ema50_4h * 0.999) trend4h = 'BEARISH';
        }

        return { trend1h, trend4h };
    } catch {
        return { trend1h: 'SIDEWAYS', trend4h: 'SIDEWAYS' };
    }
}// ============================================================
// MARKET STATUS
// ============================================================

async function updateMarketStatus() {
    try {
        const rawBTC = await exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 250);
        const closesBTC = closedCandles(rawBTC).map(c => Number(c[4]));
        const ema200BTC = ema(closesBTC, 200);
        const lastBTC = closesBTC[closesBTC.length - 1];
        let btcTrend = 'SIDEWAYS';
        if (ema200BTC && lastBTC > ema200BTC * 1.002) btcTrend = 'BULLISH';
        else if (ema200BTC && lastBTC < ema200BTC * 0.998) btcTrend = 'BEARISH';

        const rawETH = await exchange.fetchOHLCV('ETH/USDT:USDT', '1h', undefined, 250);
        const closesETH = closedCandles(rawETH).map(c => Number(c[4]));
        const ema200ETH = ema(closesETH, 200);
        const lastETH = closesETH[closesETH.length - 1];
        let ethTrend = 'SIDEWAYS';
        if (ema200ETH && lastETH > ema200ETH * 1.002) ethTrend = 'BULLISH';
        else if (ema200ETH && lastETH < ema200ETH * 0.998) ethTrend = 'BEARISH';

        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'];
        const ethT = tickers['ETH/USDT:USDT'];

        const btcChg = btcT ? Number(btcT.percentage) : 0;
        const ethChg = ethT ? Number(ethT.percentage) : 0;

        let score = 0;
        if (btcTrend === 'BULLISH') score += 2;
        else if (btcTrend === 'BEARISH') score -= 2;
        if (ethTrend === 'BULLISH') score += 2;
        else if (ethTrend === 'BEARISH') score -= 2;

        if (Number.isFinite(btcChg)) {
            if (btcChg > 2) score += 2;
            else if (btcChg > 0.5) score += 1;
            else if (btcChg < -2) score -= 2;
            else if (btcChg < -0.5) score -= 1;
        }
        if (Number.isFinite(ethChg)) {
            if (ethChg > 2) score += 2;
            else if (ethChg > 0.5) score += 1;
            else if (ethChg < -2) score -= 2;
            else if (ethChg < -0.5) score -= 1;
        }

        let overall;
        if (score >= 5) overall = 'BULLISH';
        else if (score >= 2) overall = 'BULLISH_WEAK';
        else if (score <= -5) overall = 'BEARISH';
        else if (score <= -2) overall = 'BEARISH_WEAK';
        else overall = 'MIXED';

        marketStatus = {
            btc: {
                trend: btcTrend,
                price: btcT ? num(btcT.last) : null,
                change24h: Number.isFinite(btcChg) ? num(btcChg, 2) : null
            },
            eth: {
                trend: ethTrend,
                price: ethT ? num(ethT.last) : null,
                change24h: Number.isFinite(ethChg) ? num(ethChg, 2) : null
            },
            overall,
            score,
            updatedAt: Date.now()
        };

        broadcast();
    } catch (err) {
        logError(`[marketStatus] ${err.message}`);
    }
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQuality({ trend4h, trend1h, volumeRatio, rsiValue, bodyRatio, direction }) {
    let score = 0;
    const breakdown = [];

    if (direction === 'LONG') {
        if (trend4h === 'BULLISH') { score += 25; breakdown.push('✅ 4h trend yukarı (+25)'); }
        else if (trend4h === 'SIDEWAYS') { score += 10; breakdown.push('⚪ 4h trend nötr (+10)'); }
        else { breakdown.push('❌ 4h trend ters'); }

        if (trend1h === 'BULLISH') { score += 25; breakdown.push('✅ 1h trend yukarı (+25)'); }
        else if (trend1h === 'SIDEWAYS') { score += 10; breakdown.push('⚪ 1h trend nötr (+10)'); }
        else { breakdown.push('❌ 1h trend ters'); }
    } else {
        if (trend4h === 'BEARISH') { score += 25; breakdown.push('✅ 4h trend aşağı (+25)'); }
        else if (trend4h === 'SIDEWAYS') { score += 10; breakdown.push('⚪ 4h trend nötr (+10)'); }
        else { breakdown.push('❌ 4h trend ters'); }

        if (trend1h === 'BEARISH') { score += 25; breakdown.push('✅ 1h trend aşağı (+25)'); }
        else if (trend1h === 'SIDEWAYS') { score += 10; breakdown.push('⚪ 1h trend nötr (+10)'); }
        else { breakdown.push('❌ 1h trend ters'); }
    }

    if (volumeRatio >= 3.0) { score += 20; breakdown.push(`✅ Çok güçlü hacim ${num(volumeRatio, 1)}x (+20)`); }
    else if (volumeRatio >= 2.5) { score += 15; breakdown.push(`✅ Güçlü hacim ${num(volumeRatio, 1)}x (+15)`); }
    else if (volumeRatio >= 2.0) { score += 10; breakdown.push(`🟡 Orta hacim ${num(volumeRatio, 1)}x (+10)`); }
    else { breakdown.push(`❌ Düşük hacim`); }

    if (bodyRatio >= 0.8) { score += 15; breakdown.push(`✅ Güçlü mum ${num(bodyRatio, 2)}x (+15)`); }
    else if (bodyRatio >= 0.5) { score += 10; breakdown.push(`✅ İyi mum ${num(bodyRatio, 2)}x (+10)`); }
    else { breakdown.push(`❌ Zayıf mum`); }

    if (rsiValue != null) {
        if (direction === 'LONG') {
            if (rsiValue >= 50 && rsiValue <= 70) { score += 15; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+15)`); }
            else if (rsiValue >= 45 && rsiValue < 50) { score += 8; breakdown.push(`🟡 RSI nötr (+8)`); }
            else if (rsiValue > CONFIG.RSI_OVERBOUGHT) { breakdown.push(`⚠️ RSI aşırı alım`); }
            else { breakdown.push(`❌ RSI uygun değil`); }
        } else {
            if (rsiValue >= 30 && rsiValue <= 50) { score += 15; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+15)`); }
            else if (rsiValue > 50 && rsiValue <= 55) { score += 8; breakdown.push(`🟡 RSI nötr (+8)`); }
            else if (rsiValue < CONFIG.RSI_OVERSOLD) { breakdown.push(`⚠️ RSI aşırı satım`); }
            else { breakdown.push(`❌ RSI uygun değil`); }
        }
    }

    return { score: Math.min(score, 100), breakdown };
}

// ============================================================
// ANA TARAMA — KIRILIM
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (isExcluded(symbol)) return null;

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.BREAKOUT_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]);
        const open = Number(last[1]);
        const high = Number(last[2]);
        const low = Number(last[3]);
        const volume = Number(last[5]);

        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const closes = priorCandles.map(c => Number(c[4]));

        const volumes = priorCandles.slice(-30).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(30, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);

        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        // TREND KONTROLÜ
        const trends = await getTrends(symbol);

        // KIRILIM TESPİTİ
        const highestHigh = Math.max(...priorCandles.slice(-CONFIG.BREAKOUT_LOOKBACK).map(c => Number(c[2])));
        const lowestLow = Math.min(...priorCandles.slice(-CONFIG.BREAKOUT_LOOKBACK).map(c => Number(c[3])));

        let direction = null;
        let level = null;
        let signalType = null;

        // KIRILIM (Breakout)
        if (close > highestHigh * (1 + CONFIG.MIN_BREAKOUT_BUFFER) && close > open) {
            direction = 'LONG';
            level = highestHigh;
            signalType = 'KIRILIM';
        } else if (close < lowestLow * (1 - CONFIG.MIN_BREAKOUT_BUFFER) && close < open) {
            direction = 'SHORT';
            level = lowestLow;
            signalType = 'KIRILIM';
        }

        // YAKLAŞIM (Approach)
        if (!signalType) {
            const distToResistance = Math.abs(close - highestHigh) / highestHigh;
            const distToSupport = Math.abs(close - lowestLow) / lowestLow;

            if (distToResistance < CONFIG.APPROACH_DISTANCE &&
                close < highestHigh &&
                volumeRatio >= CONFIG.APPROACH_MIN_VOLUME) {
                direction = 'LONG';
                level = highestHigh;
                signalType = 'YAKLASIM';
            } else if (distToSupport < CONFIG.APPROACH_DISTANCE &&
                       close > lowestLow &&
                       volumeRatio >= CONFIG.APPROACH_MIN_VOLUME) {
                direction = 'SHORT';
                level = lowestLow;
                signalType = 'YAKLASIM';
            }
        }

        if (!signalType || !direction) return null;

        // TREND KONTROLÜ — ZORUNLU
        const trendOk =
            (direction === 'LONG' && trends.trend1h === 'BULLISH' && trends.trend4h !== 'BEARISH') ||
            (direction === 'SHORT' && trends.trend1h === 'BEARISH' && trends.trend4h !== 'BULLISH');

        if (!trendOk) {
            DEBUG.rejectedTrend++;
            return null;
        }

        // HACİM KONTROLÜ
        if (signalType === 'KIRILIM' && volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) {
            DEBUG.rejectedVolume++;
            return null;
        }

        // BODY KONTROLÜ (Kırılım)
        if (signalType === 'KIRILIM' && bodyRatio < CONFIG.MIN_BODY_ATR_RATIO) {
            DEBUG.rejected
