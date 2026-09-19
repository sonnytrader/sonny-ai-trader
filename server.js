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
// SONER TRADE v7.1 — Wick Sweep Scalp
// ============================================================

const CONFIG = {
    TIMEFRAME: '5m',
    CANDLE_LIMIT: 60,

    SWING_LOOKBACK: 20,
    LEVEL_TOLERANCE: 0.003,

    MIN_WICK_BODY_RATIO: 2.0,
    MIN_WICK_SIZE_PCT: 0.15,

    MIN_VOLUME_MULTIPLIER: 1.5,

    MIN_QUALITY_SCORE: 55,

    ATR_PERIOD: 14,
    RSI_PERIOD: 14,

    STOP_BUFFER: 0.001,
    TP1_RR: 1.5,
    TP2_RR: 2.5,

    SIGNAL_VALID_MS: 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

    MIN_24H_VOLUME_USDT: 2000000,
    MAX_TARGETS: 250,

    EXCLUDED_BASES: [
        'USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD',
        'WBTC', 'WETH', 'WSTETH', 'STETH'
    ],

    SCAN_INTERVAL_MS: 60 * 1000,
    PRESCAN_INTERVAL_MS: 15 * 60 * 1000,
    LIVE_INTERVAL_MS: 5000,
    MARKET_STATUS_INTERVAL_MS: 60 * 1000,
    API_DELAY_MS: 80,

    MAX_SIGNALS_KEPT: 100,
    DEBUG: true
};

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 250,
    options: { defaultType: 'swap' }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let signals = [];
let marketStatus = { btc: null, eth: null, overall: 'UNKNOWN', score: 0, updatedAt: 0 };
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
    longWickFound: 0,
    shortWickFound: 0,
    rejectedVolume: 0,
    rejectedBody: 0,
    rejectedLevel: 0,
    rejectedQuality: 0,
    rejectedCooldown: 0,
    signals: 0,
    long: 0, short: 0,
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
// WICK ANALİZİ
// ============================================================

function analyzeWick(candle) {
    const open = Number(candle[1]);
    const high = Number(candle[2]);
    const low = Number(candle[3]);
    const close = Number(candle[4]);

    const body = Math.abs(close - open);
    const totalRange = high - low;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;

    const isBullish = close > open;
    const isBearish = close < open;

    const bodyPct = totalRange > 0 ? (body / totalRange) * 100 : 0;

    const lowerWickRatio = body > 0 ? lowerWick / body : 0;
    const lowerWickPct = totalRange > 0 ? (lowerWick / totalRange) * 100 : 0;
    const lowerWickPricePct = low > 0 ? (lowerWick / low) * 100 : 0;

    const upperWickRatio = body > 0 ? upperWick / body : 0;
    const upperWickPct = totalRange > 0 ? (upperWick / totalRange) * 100 : 0;
    const upperWickPricePct = high > 0 ? (upperWick / high) * 100 : 0;

    return {
        open, high, low, close,
        body, totalRange,
        upperWick, lowerWick,
        isBullish, isBearish,
        bodyPct,
        lowerWickRatio, lowerWickPct, lowerWickPricePct,
        upperWickRatio, upperWickPct, upperWickPricePct
    };
}

// ============================================================
// DESTEK / DİRENÇ
// ============================================================

function findSupportResistance(candles, lookback = 20) {
    const recent = candles.slice(-lookback);
    if (recent.length < lookback) return null;

    const lows = recent.map(c => Number(c[3]));
    const highs = recent.map(c => Number(c[2]));

    const support = Math.min(...lows);
    const resistance = Math.max(...highs);

    return { support, resistance };
}

// ============================================================
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
            overall, score,
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

function calculateQualityScore({ direction, wickRatio, wickPct, volumeRatio, rsiValue, distFromLevel }) {
    let score = 0;
    const breakdown = [];

    if (wickRatio >= 3.0) { score += 30; breakdown.push(`✅ Çok güçlü fitil ${wickRatio.toFixed(1)}x (+30)`); }
    else if (wickRatio >= 2.5) { score += 25; breakdown.push(`✅ Güçlü fitil ${wickRatio.toFixed(1)}x (+25)`); }
    else if (wickRatio >= 2.0) { score += 20; breakdown.push(`🟡 Orta fitil ${wickRatio.toFixed(1)}x (+20)`); }
    else { breakdown.push(`❌ Zayıf fitil (+0)`); }

    if (volumeRatio >= 3.0) { score += 25; breakdown.push(`✅ Çok güçlü hacim ${volumeRatio.toFixed(1)}x (+25)`); }
    else if (volumeRatio >= 2.0) { score += 18; breakdown.push(`✅ Güçlü hacim ${volumeRatio.toFixed(1)}x (+18)`); }
    else if (volumeRatio >= 1.5) { score += 12; breakdown.push(`🟡 Orta hacim ${volumeRatio.toFixed(1)}x (+12)`); }
    else { breakdown.push(`❌ Düşük hacim (+0)`); }

    if (rsiValue != null) {
        if (direction === 'LONG') {
            if (rsiValue >= 35 && rsiValue <= 55) { score += 20; breakdown.push(`✅ RSI ideal ${rsiValue.toFixed(0)} (+20)`); }
            else if (rsiValue > 55 && rsiValue <= 65) { score += 12; breakdown.push(`🟡 RSI yüksek ${rsiValue.toFixed(0)} (+12)`); }
            else if (rsiValue >= 25 && rsiValue < 35) { score += 10; breakdown.push(`🟡 RSI düşük ${rsiValue.toFixed(0)} (+10)`); }
            else { score += 3; breakdown.push(`⚠️ RSI uçta ${rsiValue.toFixed(0)} (+3)`); }
        } else {
            if (rsiValue >= 45 && rsiValue <= 65) { score += 20; breakdown.push(`✅ RSI ideal ${rsiValue.toFixed(0)} (+20)`); }
            else if (rsiValue >= 35 && rsiValue < 45) { score += 12; breakdown.push(`🟡 RSI düşük ${rsiValue.toFixed(0)} (+12)`); }
            else if (rsiValue > 65 && rsiValue <= 75) { score += 10; breakdown.push(`🟡 RSI yüksek ${rsiValue.toFixed(0)} (+10)`); }
            else { score += 3; breakdown.push(`⚠️ RSI uçta ${rsiValue.toFixed(0)} (+3)`); }
        }
    }

    if (distFromLevel <= 0.1) { score += 15; breakdown.push(`✅ Seviyeye çok yakın %${distFromLevel.toFixed(2)} (+15)`); }
    else if (distFromLevel <= 0.2) { score += 10; breakdown.push(`✅ Seviyeye yakın %${distFromLevel.toFixed(2)} (+10)`); }
    else if (distFromLevel <= 0.3) { score += 5; breakdown.push(`🟡 Seviyeye orta %${distFromLevel.toFixed(2)} (+5)`); }
    else { breakdown.push(`❌ Seviyeden uzak (+0)`); }

    if (direction === 'LONG' || direction === 'SHORT') { score += 10; breakdown.push(`✅ Kapanış yönü doğru (+10)`); }

    return { score: Math.min(score, 100), breakdown };
}

// ============================================================
// ANA TARAMA
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (isExcluded(symbol)) return null;

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < 30) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]);
        const open = Number(last[1]);
        const high = Number(last[2]);
        const low = Number(last[3]);
        const volume = Number(last[5]);

        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        const wick = analyzeWick(last);

        const priorCandles = candles.slice(0, -1);
        const levels = findSupportResistance(priorCandles, CONFIG.SWING_LOOKBACK);
        if (!levels) return null;

        const volumes = priorCandles.slice(-20).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) {
            DEBUG.rejectedVolume++;
            return null;
        }

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const closes = priorCandles.map(c => Number(c[4]));
        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);

        let direction = null;
        let level = null;
        let wickRatio = 0;
        let distFromLevel = 0;

        const distToSupport = Math.abs(low - levels.support) / levels.support;
        if (
            wick.lowerWickRatio >= CONFIG.MIN_WICK_BODY_RATIO &&
            wick.lowerWickPricePct >= CONFIG.MIN_WICK_SIZE_PCT &&
            wick.isBullish &&
            distToSupport <= CONFIG.LEVEL_TOLERANCE
        ) {
            direction = 'LONG';
            level = levels.support;
            wickRatio = wick.lowerWickRatio;
            distFromLevel = distToSupport * 100;
            DEBUG.longWickFound++;
        }

        const distToResistance = Math.abs(high - levels.resistance) / levels.resistance;
        if (
            !direction &&
            wick.upperWickRatio >= CONFIG.MIN_WICK_BODY_RATIO &&
            wick.upperWickPricePct >= CONFIG.MIN_WICK_SIZE_PCT &&
            wick.isBearish &&
            distToResistance <= CONFIG.LEVEL_TOLERANCE
        ) {
            direction = 'SHORT';
            level = levels.resistance;
            wickRatio = wick.upperWickRatio;
            distFromLevel = distToResistance * 100;
            DEBUG.shortWickFound++;
        }

        if (!direction) return null;

        const quality = calculateQualityScore({
            direction, wickRatio,
            wickPct: direction === 'LONG' ? wick.lowerWickPct : wick.upperWickPct,
            volumeRatio, rsiValue, distFromLevel
        });

        if (quality.score < CONFIG.MIN_QUALITY_SCORE) {
            DEBUG.rejectedQuality++;
            return null;
        }

        const cooldownKey = `${symbol}_${direction}`;
        const lastTime = lastSignalTime.get(cooldownKey) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) {
            DEBUG.rejectedCooldown++;
            return null;
        }

        const entry = close;
        const stopBuffer = CONFIG.STOP_BUFFER;

        let stop, tp1, tp2;
        if (direction === 'LONG') {
            stop = low * (1 - stopBuffer);
            const risk = entry - stop;
            tp1 = entry + risk * CONFIG.TP1_RR;
            tp2 = entry + risk * CONFIG.TP2_RR;
        } else {
            stop = high * (1 + stopBuffer);
            const risk = stop - entry;
            tp1 = entry - risk * CONFIG.TP1_RR;
            tp2 = entry - risk * CONFIG.TP2_RR;
        }

        const risk = Math.abs(entry - stop);
        const rr1 = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
        const rr2 = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;

        const reasons = [
            direction === 'LONG' ? `🎯 Destek wick reddi` : `🎯 Direnç wick reddi`,
            `Wick oranı: ${wickRatio.toFixed(1)}x gövde`,
            `Hacim: ${volumeRatio.toFixed(2)}x ortalama`,
            `RSI: ${rsiValue ? rsiValue.toFixed(1) : '-'}`,
            `Seviyeye uzaklık: %${distFromLevel.toFixed(2)}`,
            `Kalite: ${quality.score}/100`,
            ...quality.breakdown
        ];

        lastSignalTime.set(cooldownKey, Date.now());
        DEBUG.signals++;
        DEBUG[direction === 'LONG' ? 'long' : 'short']++;

        logInfo(`[${direction}] ${symbol} @ ${entry.toFixed(6)} Wick=${wickRatio.toFixed(1)}x Vol=${volumeRatio.toFixed(2)}x Q=${quality.score}`);

        const lastCandles = candles.slice(-50).map(c => ({
            t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4])
        }));

        return {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${Date.now()}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            signalType: 'WICK_SWEEP',
            timeframe: '5m',
            entry: num(entry),
            currentPrice: num(entry),
            pnlPct: 0,
            stop: num(stop),
            tp1: num(tp1),
            tp2: num(tp2),
            rr1: num(rr1, 2),
            rr2: num(rr2, 2),
            level: num(level),
            wickRatio: num(wickRatio, 2),
            volumeRatio: num(volumeRatio, 2),
            rsi: num(rsiValue, 1),
            atr: num(currentATR),
            qualityScore: quality.score,
            qualityBreakdown: quality.breakdown,
            status: 'ACTIVE',
            closeReason: null,
            reasons,
            candles: lastCandles,
            candleTime: last[0],
            timestamp: Date.now(),
            updatedAt: Date.now(),
            expiresAt: Date.now() + CONFIG.SIGNAL_VALID_MS
        };

    } catch (err) {
        DEBUG.errors++;
        logError(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// LIVE PRICES
// ============================================================

async function updateLivePrices() {
    if (!signals.length) return;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const sig of signals) {
            if (sig.status !== 'ACTIVE') continue;
            const t = tickers[sig.symbol];
            if (!t || !Number(t.last)) continue;

            sig.currentPrice = num(t.last);
            sig.updatedAt = now;

            const entry = Number(sig.entry);
            const current = Number(t.last);
            const stop = Number(sig.stop);
            const tp1 = Number(sig.tp1);
            const tp2 = Number(sig.tp2);

            if (sig.direction === 'LONG') {
                sig.pnlPct = num(((current - entry) / entry) * 100, 2);
                if (current <= stop) { sig.status = 'STOPPED'; sig.closeReason = 'Stop oldu'; sig.closedAt = now; }
                else if (current >= tp2) { sig.status = 'TP2_HIT'; sig.closeReason = 'TP2 vurdu'; sig.closedAt = now; }
                else if (current >= tp1) { sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 vurdu'; sig.closedAt = now; }
            } else {
                sig.pnlPct = num(((entry - current) / entry) * 100, 2);
                if (current >= stop) { sig.status = 'STOPPED'; sig.closeReason = 'Stop oldu'; sig.closedAt = now; }
                else if (current <= tp2) { sig.status = 'TP2_HIT'; sig.closeReason = 'TP2 vurdu'; sig.closedAt = now; }
                else if (current <= tp1) { sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 vurdu'; sig.closedAt = now; }
            }

            if (sig.status === 'ACTIVE' && now > sig.expiresAt) {
                sig.status = 'EXPIRED'; sig.closeReason = 'Süre doldu'; sig.closedAt = now;
            }
            changed = true;
        }

        if (changed) broadcast();
    } catch (err) {}
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
            if (isExcluded(t.symbol)) continue;
            const v = Number(t.quoteVolume);
            if (Number.isFinite(v) && v >= CONFIG.MIN_24H_VOLUME_USDT) {
                list.push({ symbol: t.symbol, volume: v });
            }
        }
        list.sort((a, b) => b.volume - a.volume);
        targets = list.slice(0, CONFIG.MAX_TARGETS).map(i => i.symbol);
        lastPrescanAt = Date.now();
        logInfo(`RADAR | ${targets.length} coin tarandı (v7.1 - wick sweep)`);
    } catch (err) {
        logError(`[runPreScan] ${err.message}`);
    }
}

// ============================================================
// SCAN
// ============================================================

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;

    DEBUG.scanned = 0;
    DEBUG.longWickFound = 0;
    DEBUG.shortWickFound = 0;
    DEBUG.rejectedVolume = 0;
    DEBUG.rejectedBody = 0;
    DEBUG.rejectedLevel = 0;
    DEBUG.rejectedQuality = 0;
    DEBUG.rejectedCooldown = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;

    try {
        for (const symbol of targets) {
            if (isShuttingDown) break;
            const signal = await scanForSignal(symbol);
            if (signal) {
                signals.unshift(signal);
                signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                newSignals++;
                broadcast();
            }
            await sleep(CONFIG.API_DELAY_MS);
        }
        lastScanAt = Date.now();
    } catch (err) {
        logError(`[runScan] ${err.message}`);
    }

    scanRunning = false;
    APP_STATE.scanStatus = {
        message: `Tarama bitti | ${newSignals} yeni`,
        isScanning: false
    };
    broadcast();

    logInfo(`[TARAMA ÖZET] Tarandı=${DEBUG.scanned} | LongWick=${DEBUG.longWickFound} | ShortWick=${DEBUG.shortWickFound} | RedHacim=${DEBUG.rejectedVolume} | RedKalite=${DEBUG.rejectedQuality} | Yeni=${newSignals} | Toplam=${signals.length}`);
}

async function runAll() {
    if (Date.now() - lastPrescanAt > CONFIG.PRESCAN_INTERVAL_MS || !targets.length) {
        await runPreScan();
    }
    await runScan();
}

// ============================================================
// API
// ============================================================

app.get('/api/signals', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(snapshot());
});
app.get('/api/market-status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, marketStatus });
});
app.get('/api/debug', (req, res) => {
    res.json({ success: true, debug: DEBUG, config: CONFIG, targets: targets.length, signals: signals.length });
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now(), targets: targets.length, signals: signals.length }));
app.delete('/api/signals', (req, res) => { signals = []; broadcast(); res.json({ success: true }); });

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    const active = signals.filter(s => s.status === 'ACTIVE');
    return {
        success: true,
        signals: signals.slice(0, 100),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: signals.length,
            active: active.length,
            long: active.filter(s => s.direction === 'LONG').length,
            short: active.filter(s => s.direction === 'SHORT').length
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

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache, no-store">
<title>SONER TRADE v7.1</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:12px}
.market-left{display:flex;align-items:center;gap:12px}
.market-brand{font-size:14px;font-weight:900;letter-spacing:0.5px}
.market-brand span{color:#17d7a0}
.market-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.market-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0e14;border-radius:5px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700;color:#e9eef5}
.market-item .chg{padding:1px 5px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend{font-size:9px;font-weight:800;padding:2px 5px;border-radius:3px}
.market-item .trend.bullish{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .trend.bearish{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend.sideways{background:rgba(246,196,83,0.15);color:#f6c453}
.market-overall{padding:6px 14px;border-radius:5px;font-size:11px;font-weight:800;display:flex;align-items:center;gap:6px}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}
.market-score{font-size:10px;opacity:0.7}
.conn-status{padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;background:#1c2634;color:#8b97a5}
.conn-status.online{background:rgba(0,255,157,0.15);color:#00ff9d}
.conn-status.offline{background:rgba(255,56,96,0.15);color:#ff3860}
.content{display:flex;flex:1;overflow:hidden}
.sidebar{width:380px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-header{padding:12px;border-bottom:1px solid #1c2634;display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:space-between}
.side-header-title{font-size:11px;font-weight:800;color:#5e6b7c;letter-spacing:1px;text-transform:uppercase}
.clear-btn{background:#2a0f14;border:1px solid #5c1a26;color:#ff5c77;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit}
.side-list{flex:1;overflow-y:auto;padding:8px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}
.sig-card{margin-bottom:10px;padding:12px;border-radius:10px;cursor:pointer;background:#0f1620;border:1px solid #1c2634;transition:all .15s}
.sig-card:hover{background:#141d28}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 2px rgba(23,215,160,0.4)}
.sig-card.long{border-left:4px solid #00ff9d}
.sig-card.short{border-left:4px solid #ff3860}
.sig-card.closed{opacity:0.5}
.dir-badge{display:inline-block;font-size:13px;font-weight:900;padding:5px 14px;border-radius:6px}
.dir-badge.long{background:#00ff9d;color:#0a0e14}
.dir-badge.short{background:#ff3860;color:#fff}
.type-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(138,92,255,0.2);color:#a87cff;border:1px solid rgba(138,92,255,0.4)}
.status-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.status-badge.active{background:rgba(0,255,157,0.2);color:#00ff9d;border:1px solid #00ff9d}
.status-badge.tp1{background:#2962ff;color:#fff}
.status-badge.tp2{background:#8a5cff;color:#fff}
.status-badge.stopped{background:#ff3860;color:#fff}
.status-badge.expired{background:#5e6b7c;color:#fff}
.quality-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.quality-badge.high{background:rgba(0,255,157,0.2);color:#00ff9d}
.quality-badge.med{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge.low{background:rgba(255,56,96,0.2);color:#ff3860}
.sig-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.sig-sym{font-size:16px;font-weight:900}
.levels-grid{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px}
.level-item{display:flex;justify-content:space-between;padding:5px 8px;background:#0a0e14;border-radius:4px}
.level-item .k{color:#5e6b7c}
.level-item .v{font-weight:700;color:#c5cfdd}
.level-item.entry .v{color:#4a7cff}
.level-item.stop .v{color:#ff3860}
.level-item.tp1 .v{color:#00ff9d}
.level-item.tp2 .v{color:#8a5cff}
.sig-price{margin-top:10px;display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #1c2634}
.sig-price .cur{font-weight:700;color:#e9eef5;font-size:15px}
.sig-price .pnl{padding:3px 8px;border-radius:4px;font-weight:800;font-size:12px}
.sig-price .pnl.pos{background:rgba(0,255,157,0.15);color:#00ff9d}
.sig-price .pnl.neg{background:rgba(255,56,96,0.15);color:#ff3860}
.action-hint{margin-top:8px;padding:8px 10px;border-radius:5px;font-size:11px;font-weight:600}
.action-hint.buy{background:rgba(0,255,157,0.1);color:#00ff9d;border-left:3px solid #00ff9d}
.action-hint.sell{background:rgba(41,98,255,0.1);color:#4a7cff;border-left:3px solid #2962ff}
.action-hint.exit{background:rgba(255,56,96,0.1);color:#ff3860;border-left:3px solid #ff3860}
.action-hint.neutral{background:rgba(139,151,165,0.1);color:#8b97a5;border-left:3px solid #5e6b7c}
.sig-meta{margin-top:8px;font-size:10px;color:#5e6b7c;display:flex;gap:10px;flex-wrap:wrap}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:13px;flex-direction:column;gap:10px}
.main-empty-icon{font-size:40px;opacity:0.3}
.chart-head{padding:12px 16px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219;flex-wrap:wrap;gap:10px}
.chart-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chart-sym{font-size:20px;font-weight:900}
.chart-actions{display:flex;gap:6px}
.btn-sm{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-decoration:none;display:inline-block}
.btn-sm:hover{background:#243044}
.btn-sm.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.chart-wrap{flex:1;position:relative;background:#070b11;min-height:200px}
#mainCanvas{width:100%;height:100%;display:block}
.chart-info{padding:12px 16px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.chart-info-item{display:flex;flex-direction:column;gap:3px;padding:10px;background:#0a0e14;border-radius:6px}
.chart-info-lbl{color:#5e6b7c;text-transform:uppercase;font-size:9px;font-weight:700}
.chart-info-val{font-weight:800;font-size:14px;color:#e9eef5}
.empty-msg{padding:30px 16px;text-align:center;color:#5e6b7c;font-size:11px;line-height:1.8}
</style>
</head>
<body>
<div class="app">
<div class="market-bar">
<div class="market-left">
<div class="market-brand">SONER <span>TRADE</span> <span class="market-badge">v7.1 • SCALP</span></div>
<div class="market-item"><span class="sym">BTC</span><span class="price" id="btcPrice">-</span><span class="chg" id="btcChg">-</span><span class="trend" id="btcTrend">-</span></div>
<div class="market-item"><span class="sym">ETH</span><span class="price" id="ethPrice">-</span><span class="chg" id="ethChg">-</span><span class="trend" id="ethTrend">-</span></div>
</div>
<div style="display:flex;gap:10px;align-items:center">
<div class="market-overall mixed" id="marketOverall">-</div>
<div class="conn-status" id="connStatus">Bağlanıyor...</div>
</div>
</div>
<div class="content">
<div class="sidebar">
<div class="side-header">
<div class="side-header-title">🎯 Wick Sweep</div>
<button class="clear-btn" onclick="clearSignals()">Temizle</button>
</div>
<div class="side-list" id="sideList"></div>
</div>
<div class="main">
<div id="mainEmpty" class="main-empty">
<div class="main-empty-icon">🎯</div>
<div>Soldan bir sinyal seç</div>
<div style="font-size:10px;color:#5e6b7c;margin-top:6px" id="emptyInfo">Yükleniyor...</div>
</div>
<div id="mainContent" style="display:none;flex-direction:column;flex:1">
<div class="chart-head">
<div class="chart-title">
<div class="chart-sym" id="chartSym">-</div>
<div id="chartDir"></div>
<div id="chartType"></div>
<div id="chartQuality"></div>
<div id="chartStatus"></div>
</div>
<div class="chart-actions">
<a class="btn-sm tv" id="tvLink" target="_blank">📈 TradingView</a>
</div>
</div>
<div class="chart-wrap"><canvas id="mainCanvas"></canvas></div>
<div class="chart-info">
<div class="chart-info-item"><div class="chart-info-lbl">Giriş</div><div class="chart-info-val" style="color:#4a7cff" id="infoEntry">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">Stop</div><div class="chart-info-val" style="color:#ff3860" id="infoStop">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">TP1</div><div class="chart-info-val" style="color:#00ff9d" id="infoTp1">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">TP2</div><div class="chart-info-val" style="color:#8a5cff" id="infoTp2">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">Kalite</div><div class="chart-info-val" id="infoQuality">-</div></div>
</div>
</div>
</div>
</div>
</div>
<script>
var signals = [];
var selectedId = null;
var ws = null;
var lastActiveCount = 0;
var audioCtx = null;
var reconnectTimer = null;
var pollTimer = null;

function fmt(v){ v = Number(v); if(!Number.isFinite(v)) return '-'; if(v>=1000) return v.toFixed(2); if(v>=100) return v.toFixed(3); if(v>=1) return v.toFixed(4); return v.toFixed(6); }
function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function timeAgo(ts){ if(!ts) return '-'; var d = Date.now() - ts; var m = Math.floor(d / 60000); if(m < 1) return 'az önce'; if(m < 60) return m + ' dk'; var h = Math.floor(m / 60); return h + ' sa'; }
function playSound(){ try{ if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); var o = audioCtx.createOscillator(); var g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.15, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4); o.start(); o.stop(audioCtx.currentTime + 0.4); }catch(e){} }

function setConnStatus(status, text){
    var el = document.getElementById('connStatus');
    el.className = 'conn-status ' + status;
    el.textContent = text;
}

function renderMarketBar(ms){
    if(!ms || !ms.btc || !ms.eth) return;
    var btc = ms.btc, eth = ms.eth;
    document.getElementById('btcPrice').textContent = fmt(btc.price);
    var btcChg = document.getElementById('btcChg');
    if(btc.change24h != null){ btcChg.textContent = (btc.change24h >= 0 ? '+' : '') + btc.change24h + '%'; btcChg.className = 'chg ' + (btc.change24h >= 0 ? 'up' : 'down'); }
    var btcT = document.getElementById('btcTrend');
    btcT.textContent = btc.trend === 'BULLISH' ? 'YUKARI' : btc.trend === 'BEARISH' ? 'AŞAĞI' : 'YATAY';
    btcT.className = 'trend ' + (btc.trend === 'BULLISH' ? 'bullish' : btc.trend === 'BEARISH' ? 'bearish' : 'sideways');
    document.getElementById('ethPrice').textContent = fmt(eth.price);
    var ethChg = document.getElementById('ethChg');
    if(eth.change24h != null){ ethChg.textContent = (eth.change24h >= 0 ? '+' : '') + eth.change24h + '%'; ethChg.className = 'chg ' + (eth.change24h >= 0 ? 'up' : 'down'); }
    var ethT = document.getElementById('ethTrend');
    ethT.textContent = eth.trend === 'BULLISH' ? 'YUKARI' : eth.trend === 'BEARISH' ? 'AŞAĞI' : 'YATAY';
    ethT.className = 'trend ' + (eth.trend === 'BULLISH' ? 'bullish' : eth.trend === 'BEARISH' ? 'bearish' : 'sideways');
    var overall = document.getElementById('marketOverall');
    var label = 'KARIŞIK', cls = 'mixed';
    if(ms.overall === 'BULLISH'){ label = 'PİYASA YUKARI'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH'){ label = 'PİYASA AŞAĞI'; cls = 'bearish'; }
    else if(ms.overall === 'BULLISH_WEAK'){ label = 'YUKARI (ZAYIF)'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH_WEAK'){ label = 'AŞAĞI (ZAYIF)'; cls = 'bearish'; }
    overall.innerHTML = label + '<span class="market-score">Skor ' + (ms.score >= 0 ? '+' : '') + ms.score + '</span>';
    overall.className = 'market-overall ' + cls;
}

function getStatusBadge(s){
    if(s.status === 'ACTIVE') return '<span class="status-badge active">● AKTİF</span>';
    if(s.status === 'TP1_HIT') return '<span class="status-badge tp1">✓ TP1</span>';
    if(s.status === 'TP2_HIT') return '<span class="status-badge tp2">✓✓ TP2</span>';
    if(s.status === 'STOPPED') return '<span class="status-badge stopped">✗ STOP</span>';
    if(s.status === 'EXPIRED') return '<span class="status-badge expired">⏱ SÜRE</span>';
    return '';
}

function getQualityClass(q){ if(q >= 75) return 'high'; if(q >= 55) return 'med'; return 'low'; }

function getActionHint(s){
    if(s.status === 'ACTIVE') return '<div class="action-hint buy">✅ Şimdi gir</div>';
    if(s.status === 'TP1_HIT') return '<div class="action-hint sell">💰 Yarısını sat</div>';
    if(s.status === 'TP2_HIT') return '<div class="action-hint sell">🎉 Tamamını sat</div>';
    if(s.status === 'STOPPED') return '<div class="action-hint exit">❌ Çık — stop</div>';
    if(s.status === 'EXPIRED') return '<div class="action-hint neutral">⏱ Süre doldu</div>';
    return '';
}

function renderSigCard(s){
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';
    var selected = s.id === selectedId ? 'selected' : '';
    var closed = (s.status !== 'ACTIVE') ? 'closed' : '';
    var pnlCls = (s.pnlPct || 0) >= 0 ? 'pos' : 'neg';
    var pnlSign = (s.pnlPct || 0) >= 0 ? '+' : '';
    var q = s.qualityScore || 0;

    return '<div class="sig-card ' + dirCls + ' ' + selected + ' ' + closed + '" data-id="' + esc(s.id) + '">'
        + '<div class="sig-row"><div class="sig-sym">' + esc(s.symbol.replace(':USDT','')) + '</div><div class="dir-badge ' + dirCls + '">' + s.direction + '</div></div>'
        + '<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px">'
        + getStatusBadge(s)
        + '<span class="type-badge">🎯 WICK</span>'
        + '<span class="quality-badge ' + getQualityClass(q) + '">Q' + q + '</span>'
        + '</div>'
        + '<div class="levels-grid">'
        + '<div class="level-item entry"><span class="k">Giriş</span><span class="v">' + fmt(s.entry) + '</span></div>'
        + '<div class="level-item stop"><span class="k">Stop</span><span class="v">' + fmt(s.stop) + '</span></div>'
        + '<div class="level-item tp1"><span class="k">TP1</span><span class="v">' + fmt(s.tp1) + '</span></div>'
        + '<div class="level-item tp2"><span class="k">TP2</span><span class="v">' + fmt(s.tp2) + '</span></div>'
        + '</div>'
        + '<div class="sig-price"><span class="cur">' + fmt(s.currentPrice || s.entry) + '</span>' + (s.pnlPct != null ? '<span class="pnl ' + pnlCls + '">' + pnlSign + s.pnlPct + '%</span>' : '') + '</div>'
        + getActionHint(s)
        + '<div class="sig-meta">'
        + '<span>🕯 Wick ' + s.wickRatio + 'x</span>'
        + '<span>📊 Hacim ' + s.volumeRatio + 'x</span>'
        + '<span>🎯 RSI ' + (s.rsi || '-') + '</span>'
        + '<span>⏱ ' + timeAgo(s.timestamp) + '</span>'
        + '</div>'
        + '</div>';
}

function renderList(){
    var el = document.getElementById('sideList');
    var active = signals.filter(s => s.status === 'ACTIVE');
    var closed = signals.filter(s => s.status !== 'ACTIVE');

    var html = '';
    if(active.length > 0){ html += active.map(renderSigCard).join(''); }
    if(closed.length > 0){
        html += '<div style="padding:14px 8px 6px;font-size:10px;font-weight:800;color:#5e6b7c;letter-spacing:1px">📁 KAPANANLAR</div>';
        html += closed.slice(0, 20).map(renderSigCard).join('');
    }
    if(!html){
        html = '<div class="empty-msg">🎯 Henüz sinyal yok.<br><br>5m mumlarda wick reddi olduğunda<br>burada görünecek.</div>';
    }
    el.innerHTML = html;

    el.querySelectorAll('.sig-card[data-id]').forEach(function(card){
        card.onclick = function(){
            selectedId = card.getAttribute('data-id');
            renderList();
            renderMain();
        };
    });
}

function renderMain(){
    if(!selectedId){ document.getElementById('mainEmpty').style.display = 'flex'; document.getElementById('mainContent').style.display = 'none'; return; }
    var s = signals.find(function(x){ return x.id === selectedId; });
    if(!s){ document.getElementById('mainEmpty').style.display = 'flex'; document.getElementById('mainContent').style.display = 'none'; return; }
    document.getElementById('mainEmpty').style.display = 'none';
    document.getElementById('mainContent').style.display = 'flex';
    document.getElementById('chartSym').textContent = s.symbol.replace(':USDT','');
    document.getElementById('chartDir').innerHTML = '<div class="dir-badge ' + (s.direction === 'LONG' ? 'long' : 'short') + '">' + s.direction + '</div>';
    document.getElementById('chartType').innerHTML = '<span class="type-badge">🎯 WICK SWEEP</span>';
    document.getElementById('chartQuality').innerHTML = '<span class="quality-badge ' + getQualityClass(s.qualityScore) + '">Kalite ' + s.qualityScore + '/100</span>';
    document.getElementById('chartStatus').innerHTML = getStatusBadge(s);
    document.getElementById('tvLink').href = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.symbolTV + '&interval=5';
    document.getElementById('infoEntry').textContent = fmt(s.entry);
    document.getElementById('infoStop').textContent = fmt(s.stop);
    document.getElementById('infoTp1').textContent = fmt(s.tp1);
    document.getElementById('infoTp2').textContent = fmt(s.tp2);
    document.getElementById('infoQuality').textContent = s.qualityScore + '/100';
    setTimeout(function(){ drawBigChart(s); }, 30);
}

function drawBigChart(s){
    var canvas = document.getElementById('mainCanvas');
    var parent = canvas.parentElement;
    var W = parent.clientWidth, H = parent.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = s.direction === 'LONG' ? '#08120d' : '#12080c';
    ctx.fillRect(0, 0, W, H);
    var candles = s.candles; if(!candles || !candles.length) return;
    var count = candles.length;
    var minP = Infinity, maxP = -Infinity;
    for(var i = 0; i < candles.length; i++){ var lo = Number(candles[i].l); var hi = Number(candles[i].h); if(lo < minP) minP = lo; if(hi > maxP) maxP = hi; }
    [s.entry, s.stop, s.tp1, s.tp2, s.currentPrice, s.level].forEach(function(v){ if(v == null) return; v = Number(v); if(v < minP) minP = v; if(v > maxP) maxP = v; });
    var pad = (maxP - minP) * 0.06 || 1; minP -= pad; maxP += pad;
    var LEFT = 130, RIGHT = 20, TOP = 30, BOTTOM = 30;
    var PW = W - LEFT - RIGHT, PH = H - TOP - BOTTOM;
    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(p){ return TOP + (maxP - p) / (maxP - minP) * PH; }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for(var g = 0; g <= 5; g++){ var y = TOP + PH * g / 5; ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(W - RIGHT, y); ctx.stroke(); }
    function drawLevel(price, color, label, dash){
        if(price == null) return;
        var y = Y(price);
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; if(dash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(W - RIGHT, y); ctx.stroke(); ctx.restore();
        ctx.save(); ctx.fillStyle = color; ctx.font = 'bold 12px Arial'; ctx.textAlign = 'right';
        ctx.fillText(label + ' ' + fmt(price), LEFT - 10, y + 4); ctx.textAlign = 'left';
        ctx.fillText(fmt(price), W - RIGHT + 3, y + 3); ctx.restore();
    }
    drawLevel(s.tp2, '#8a5cff', 'TP2', [4,4]);
    drawLevel(s.tp1, '#00ff9d', 'TP1', [4,4]);
    drawLevel(s.stop, '#ff3860', 'STOP', [6,3]);
    drawLevel(s.entry, '#2962ff', 'GİRİŞ', []);
    if(s.level != null) drawLevel(s.level, '#f6c453', 'SEVİYE', [2,2]);
    var cw = Math.max(3, Math.min(16, PW / count * 0.7));
    for(var c = 0; c < candles.length; c++){
        var k = candles[c]; var x = X(c);
        var o = Number(k.o), cl = Number(k.c), h = Number(k.h), l = Number(k.l);
        var bull = cl >= o; var color = bull ? '#00ff9d' : '#ff3860';
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.stroke();
        var oY = Y(o), cY = Y(cl);
        ctx.fillRect(x - cw/2, Math.min(oY, cY), cw, Math.max(1, Math.abs(cY - oY)));
    }
    if(s.currentPrice != null){
        var curY = Y(s.currentPrice);
        ctx.save(); ctx.strokeStyle = '#f6c453'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(LEFT, curY); ctx.lineTo(W - RIGHT, curY); ctx.stroke();
        ctx.fillStyle = '#f6c453'; ctx.beginPath(); ctx.arc(W - RIGHT - 5, curY, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f6c453'; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'right';
        ctx.fillText('ŞİMDİ', LEFT - 10, curY + 4); ctx.restore();
    }
}

function apply(data){
    if(!data) return;
    var newSignals = Array.isArray(data.signals) ? data.signals : [];
    var activeCount = newSignals.filter(function(s){ return s.status === 'ACTIVE'; }).length;
    if(activeCount > lastActiveCount && lastActiveCount > 0){ playSound(); }
    lastActiveCount = activeCount;
    signals = newSignals;
    if(data.marketStatus){ renderMarketBar(data.marketStatus); }
    if(!selectedId && signals.length > 0){ selectedId = signals[0].id; }
    if(selectedId && !signals.find(function(x){ return x.id === selectedId; })){ selectedId = signals.length > 0 ? signals[0].id : null; }
    document.title = (activeCount > 0 ? '(' + activeCount + ') ' : '') + 'SONER TRADE v7.1';
    var emptyInfo = document.getElementById('emptyInfo');
    if(emptyInfo){ emptyInfo.textContent = 'Aktif sinyal: ' + activeCount; }
    renderList();
    renderMain();
}

function fetchSignals(){
    fetch('/api/signals?t=' + Date.now(), { cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(data){ apply(data); setConnStatus('online', 'Bağlı'); })
        .catch(function(){ setConnStatus('offline', 'Bağlantı Yok'); });
}

function connect(){
    if(reconnectTimer){ clearTimeout(reconnectTimer); }
    try {
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        ws = new WebSocket(proto + location.host);
        ws.onopen = function(){ setConnStatus('online', 'Canlı'); };
        ws.onmessage = function(ev){ try{ var m = JSON.parse(ev.data); if(m.type === 'snapshot' || m.type === 'update'){ apply(m.data); } }catch(e){} };
        ws.onclose = function(){ setConnStatus('offline', 'Yeniden Bağlanıyor'); reconnectTimer = setTimeout(connect, 3000); };
        ws.onerror = function(){ setConnStatus('offline', 'Hata'); };
    } catch(e){ reconnectTimer = setTimeout(connect, 3000); }
}

async function clearSignals(){ if(!confirm('Tüm sinyalleri sil?')) return; await fetch('/api/signals', { method: 'DELETE' }); selectedId = null; renderList(); renderMain(); }

window.addEventListener('resize', function(){ if(selectedId) renderMain(); });

setConnStatus('offline', 'Bağlanıyor...');
fetchSignals();
connect();
pollTimer = setInterval(fetchSignals, 3000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// START
// ============================================================

async function start() {
    try {
        await exchange.loadMarkets();
        logInfo(`Bitget marketleri | ${Object.keys(exchange.markets).length} market`);
        await updateMarketStatus();
        await runPreScan();
        await runScan();
        setInterval(function(){ runAll(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function(){ updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        logInfo('SONER TRADE v7.1 — Wick Sweep Scalp');
    } catch (err) {
        logError(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logInfo(`${signal} alindi; kapaniyor.`);
    if (scanRunning) {
        const startTime = Date.now();
        while (scanRunning && Date.now() - startTime < 15000) { await sleep(500); }
    }
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function(){ try { await exchange.close(); } catch (e) {} process.exit(0); });
    setTimeout(function(){ process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function(){ shutdown('SIGINT'); });
process.once('SIGTERM', function(){ shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function(){
    logInfo(`SONER TRADE v7.1 PORT=${PORT}`);
    start();
});
