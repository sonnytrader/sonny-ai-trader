'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

// ==================== KONFİGÜRASYON ====================
const CFG = {
    PRESCAN_INTERVAL_MS: 5 * 60 * 1000,
    SCAN_INTERVAL_MS: 5 * 60 * 1000,       // 2H tarama periyodu
    LIVE_UPDATE_INTERVAL_MS: 3 * 1000,     // canlı fiyat güncelleme
    CLOSED_CANDLE_CHECK_INTERVAL_MS: 60 * 1000, // kapanış kontrol periyodu

    TIMEFRAME: '2h',
    CANDLE_LIMIT: 80,
    LOOKBACK: 50,
    BREAKOUT_BUFFER: 0.001,
    ATR_PERIOD: 14,
    SL_ATR_MULTIPLIER: 2.0,
    MIN_RR: 1.5,
    RETEST_REQUIRED: true,
    RETEST_TOLERANCE_ATR_MULT: 0.3,
    RETEST_TIMEOUT_MS: 4 * 60 * 60 * 1000,
    WATCH_TTL_MS: 12 * 60 * 60 * 1000,
    SIGNAL_RETENTION_MS: 6 * 60 * 60 * 1000,
    CANCELED_RETENTION_MS: 2 * 60 * 60 * 1000,

    MIN_VOLUME_USDT: 500_000,
    MAX_CANDIDATES: 100,
    MAX_SETUPS: 30,

    MIN_VOLUME_RATIO: 1.20,
    TARGET_SPACE_MIN_PERCENT: 1.0,
    FIB_LEVEL_1: 0.618,
    FIB_LEVEL_2: 1.618,

    WATCH_DISTANCE_PCT: 0.5,
    COMPRESSION_ENABLED: true,
    OI_ENABLED: true,
    REGIME_FILTER_ENABLED: true,
    RSI_FILTER_ENABLED: false,
};

// ==================== DEBUG ====================
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    analyzed: 0,
    noData: 0,
    noLevel: 0,
    tooFarFromLevel: 0,
    alreadyBroken: 0,
    lowVolume: 0,
    targetTooClose: 0,
    rrTooLow: 0,
    duplicate: 0,
    watchCreated: 0,
    breakoutConfirmed: 0,
    retestPending: 0,
    retestConfirmed: 0,
    signalEmitted: 0,
    rejectedReasons: {}
};

function resetDebug() {
    Object.keys(DEBUG).forEach(k => {
        if (typeof DEBUG[k] === 'number') DEBUG[k] = 0;
        else if (typeof DEBUG[k] === 'object') DEBUG[k] = {};
    });
}

function logRejection(symbol, reason) {
    if (!DEBUG.rejectedReasons[reason]) DEBUG.rejectedReasons[reason] = [];
    DEBUG.rejectedReasons[reason].push(symbol);
}

function printDebugReport() {
    console.log('\n========== 📊 2H BREAKOUT TARAMA RAPORU ==========');
    console.log(`Ticker: ${DEBUG.totalTickers} | Hacim Filtresi: ${DEBUG.volumeFiltered} | Analiz: ${DEBUG.analyzed}`);
    console.log('--- ELENME NEDENLERİ ---');
    for (const [reason, symbols] of Object.entries(DEBUG.rejectedReasons)) {
        console.log(`${reason}: ${symbols.length} (${symbols.slice(0,3).join(', ')}${symbols.length>3?'...':''})`);
    }
    console.log('--- DURUM GEÇİŞLERİ ---');
    console.log(`WATCH oluşturuldu: ${DEBUG.watchCreated}`);
    console.log(`Breakout onaylandı: ${DEBUG.breakoutConfirmed}`);
    console.log(`Retest bekleniyor: ${DEBUG.retestPending}`);
    console.log(`Retest onaylandı: ${DEBUG.retestConfirmed}`);
    console.log(`Sinyal yayınlandı: ${DEBUG.signalEmitted}`);
    console.log('====================================================\n');
}

// ==================== EXCHANGE ====================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ==================== GLOBAL STATE ====================
let setups = [];
let isScanning = false;
let isUpdatingPrices = false;
let isCheckingClosedCandles = false;
let isShuttingDown = false;
let scanTimer, liveTimer, closeTimer;
let globalTargetList = [];
let signals = [];

const oiHistory = new Map();
const recentWarnings = new Map();

app.disable('x-powered-by');
app.use(express.json());
app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    next();
});

// ==================== YARDIMCI FONKSİYONLAR ====================
function number(value, decimals = 8) {
    const result = Number(value);
    return Number.isFinite(result) ? Number(result.toFixed(decimals)) : 0;
}

function average(values) {
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();
    if (now - (recentWarnings.get(key) || 0) < cooldownMs) return;
    recentWarnings.set(key, now);
    console.warn(`[${new Date(now).toISOString()}] ${key}: ${error.message}`);
}

function formatPrice(value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return '-';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(3);
    if (price >= 1) return price.toFixed(5);
    if (price >= 0.01) return price.toFixed(7);
    return price.toFixed(8);
}

function percentDistance(from, to) {
    if (!from) return 100;
    return Math.abs(to - from) / from * 100;
}

// ==================== İNDİKATÖRLER ====================
function calculateSMA(data, period) {
    if (!data || data.length < period) return null;
    const relevant = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevant.length < period) return null;
    return relevant.reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = calculateSMA(values.slice(0, period), period);
    if (ema === null) return null;
    for (let i = period; i < values.length; i++) {
        if (typeof values[i] !== 'number' || isNaN(values[i])) return null;
        ema = (values[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (typeof diff !== 'number' || isNaN(diff)) return null;
        gains.push(diff >= 0 ? diff : 0);
        losses.push(diff < 0 ? -diff : 0);
    }
    if (gains.length < period) return null;
    let avgGain = gains.slice(0, period).reduce((a,b)=>a+b,0) / period;
    let avgLoss = losses.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period-1) + gains[i]) / period;
        avgLoss = (avgLoss * (period-1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2], low = ohlcv[i][3], prevClose = ohlcv[i-1][4];
        if ([high, low, prevClose].some(v => typeof v !== 'number' || isNaN(v))) continue;
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trueRanges.length < period) return null;
    return calculateSMA(trueRanges, period);
}

function calculateFibonacciExtension(ohlcv, period, direction) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevant = ohlcv.slice(-period);
    const lows = relevant.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v));
    const highs = relevant.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v));
    if (!lows.length || !highs.length) return null;
    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    if (highest <= lowest) return null;
    const range = highest - lowest;
    if (direction === 'LONG') return highest + range * CFG.FIB_LEVEL_1;
    if (direction === 'SHORT') return lowest - range * CFG.FIB_LEVEL_1;
    return null;
}

function calculateCompressionRatio(ohlcv, lookback = 20) {
    if (ohlcv.length < lookback + CFG.ATR_PERIOD + 10) return null;
    const recent = ohlcv.slice(-lookback);
    const older = ohlcv.slice(-lookback * 2, -lookback);
    const recentATR = calculateATR(recent, CFG.ATR_PERIOD);
    const olderATR = calculateATR(older, CFG.ATR_PERIOD);
    if (!recentATR || !olderATR || olderATR <= 0) return null;
    return recentATR / olderATR;
}

// ==================== PİYASA REJİMİ (4H) ====================
async function checkMarketCondition(ccxtSymbol) {
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, '4h', undefined, 250);
        if (!ohlcv || ohlcv.length < 200) return { overallTrend: 'UNKNOWN' };
        const closes = ohlcv.map(c => c[4]);
        const ema200 = calculateEMA(closes, 200);
        if (ema200 === null) return { overallTrend: 'UNKNOWN' };
        const lastClose = closes[closes.length - 1];
        if (lastClose > ema200) return { overallTrend: 'UPTREND' };
        else if (lastClose < ema200) return { overallTrend: 'DOWNTREND' };
        else return { overallTrend: 'SIDEWAYS' };
    } catch (e) {
        console.error(`[checkMarketCondition HATA] ${ccxtSymbol}: ${e.message}`);
        return { overallTrend: 'UNKNOWN' };
    }
}

// ==================== OI YÖNETİMİ ====================
async function getOpenInterest(symbol) {
    try {
        const result = await exchange.fetchOpenInterest(symbol);
        const value = Number(result?.openInterestAmount || result?.openInterest || 0);
        if (Number.isFinite(value) && value > 0) return value;
    } catch (e) {
        // fallback
    }
    try {
        const marketSymbol = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${marketSymbol}&productType=usdt-futures`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return 0;
        const data = await response.json();
        const value = Number(data?.data?.openInterestList?.[0]?.size || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (e) {
        return 0;
    }
}

function updateOIHistory(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const now = Date.now();
    const history = oiHistory.get(symbol) || [];
    history.push({ value, timestamp: now });
    const retained = history.filter(item => now - item.timestamp <= 5 * 60 * 1000);
    oiHistory.set(symbol, retained);
    const reference = retained.find(item => now - item.timestamp >= 3 * 60 * 1000);
    if (!reference?.value) return 0;
    return number(((value - reference.value) / reference.value) * 100, 2);
}

function cleanOIHistory() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [symbol, history] of oiHistory.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);
        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

// ==================== SETUP YÖNETİMİ ====================
let setupIdCounter = 0;

function createSetupObject(symbol, direction, data) {
    const id = `${symbol}:${direction}:${++setupIdCounter}`;
    const trigger = data.trigger;
    const stop = data.stop;
    const risk = Math.abs(trigger - stop);
    const tp1 = data.tp1;
    const tp2 = data.tp2;
    const rr = Math.abs(tp1 - trigger) / risk;

    return {
        id,
        symbol,
        direction,
        state: 'WATCH',
        currentPrice: data.currentPrice,
        trigger,
        stop,
        tp1,
        tp2,
        rr,
        score: data.score,
        breakoutLevel: data.breakoutLevel,
        volumeRatio: data.volumeRatio,
        oiChangePct: data.oiChangePct || 0,
        oiStatus: data.oiStatus || 'NOT_AVAILABLE',
        retestStatus: null,
        regime: data.regime || 'UNKNOWN',
        compressionRatio: data.compressionRatio,
        atr: data.atr,
        reason: data.reason,
        strengthLabel: data.strengthLabel || '⚡ NORMAL',
        strengthClass: data.strengthClass || 'strength-normal',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS,
        lastProcessedCandleTimestamp: null,
        breakoutConfirmedAt: null,
        retestPendingSince: null,
        retestConfirmedAt: null,
        retestLowHigh: null,
        breakoutCandle: null,
        invalidReason: null,
        finishedAt: null
    };
}

function getSetupById(id) {
    return setups.find(s => s.id === id);
}

function updateSetup(id, updates) {
    const setup = getSetupById(id);
    if (setup) Object.assign(setup, updates, { updatedAt: Date.now() });
    return setup;
}

// ==================== 2H BREAKOUT ANALİZİ ====================
async function analyze2HBreakout(ccxtSymbol, isManual = false) {
    DEBUG.analyzed++;
    const symbol = ccxtSymbol;
    try {
        const limit = CFG.LOOKBACK + 10;
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, CFG.TIMEFRAME, undefined, limit);
        if (!ohlcv || ohlcv.length < CFG.LOOKBACK + 1) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        const closedCandles = ohlcv.slice(0, -1);
        if (closedCandles.length < CFG.LOOKBACK) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        const lookback = closedCandles.slice(-CFG.LOOKBACK);
        const resistance = Math.max(...lookback.map(c => c[2]));
        const support = Math.min(...lookback.map(c => c[3]));
        if (resistance <= support) {
            logRejection(symbol, 'NO_IMPORTANT_LEVEL');
            DEBUG.noLevel++;
            return null;
        }

        const longTrigger = resistance * (1 + CFG.BREAKOUT_BUFFER);
        const shortTrigger = support * (1 - CFG.BREAKOUT_BUFFER);

        const lastClose = closedCandles[closedCandles.length - 1][4];
        if (typeof lastClose !== 'number' || isNaN(lastClose)) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        const longDistancePct = ((longTrigger - lastClose) / lastClose) * 100;
        const shortDistancePct = ((lastClose - shortTrigger) / lastClose) * 100;

        let direction = null;
        let trigger = null;
        let breakoutLevel = null;
        let distancePct = null;

        if (lastClose < longTrigger && longDistancePct >= 0 && longDistancePct <= CFG.WATCH_DISTANCE_PCT) {
            direction = 'LONG';
            trigger = longTrigger;
            breakoutLevel = resistance;
            distancePct = longDistancePct;
        } else if (lastClose > shortTrigger && shortDistancePct >= 0 && shortDistancePct <= CFG.WATCH_DISTANCE_PCT) {
            direction = 'SHORT';
            trigger = shortTrigger;
            breakoutLevel = support;
            distancePct = shortDistancePct;
        }

        if (!direction) {
            if (lastClose >= longTrigger || lastClose <= shortTrigger) {
                logRejection(symbol, 'ALREADY_BROKEN');
                DEBUG.alreadyBroken++;
            } else {
                logRejection(symbol, 'TOO_FAR_FROM_LEVEL');
                DEBUG.tooFarFromLevel++;
            }
            return null;
        }

        const atr = calculateATR(closedCandles, CFG.ATR_PERIOD);
        if (!atr || atr <= 0) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        let stop;
        if (direction === 'LONG') {
            stop = support - atr * CFG.SL_ATR_MULTIPLIER;
        } else {
            stop = resistance + atr * CFG.SL_ATR_MULTIPLIER;
        }

        // Breakout mumu hariç önceki 20 mum ortalaması
        const baseline = lookback.slice(-21, -1);
        const avgVolume = baseline.reduce((sum, c) => sum + c[5], 0) / baseline.length;
        const lastVolume = closedCandles[closedCandles.length - 1][5];
        const volumeRatio = lastVolume / avgVolume;

        let oiChangePct = 0;
        let oiStatus = 'NOT_AVAILABLE';
        if (CFG.OI_ENABLED) {
            const oi = await getOpenInterest(ccxtSymbol);
            if (oi > 0) {
                oiChangePct = updateOIHistory(ccxtSymbol, oi);
                if (direction === 'LONG' && oiChangePct > 0.1) oiStatus = 'SUPPORTIVE';
                else if (direction === 'SHORT' && oiChangePct < -0.1) oiStatus = 'SUPPORTIVE';
                else if (Math.abs(oiChangePct) > 0.05) oiStatus = 'NEUTRAL';
                else oiStatus = 'NOT_SUPPORTIVE';
            }
        }

        let compressionRatio = null;
        if (CFG.COMPRESSION_ENABLED) {
            compressionRatio = calculateCompressionRatio(closedCandles);
        }

        let regime = 'UNKNOWN';
        if (CFG.REGIME_FILTER_ENABLED) {
            const market = await checkMarketCondition(ccxtSymbol);
            regime = market.overallTrend;
        }

        let score = 50;
        if (volumeRatio >= 2.0) score += 15;
        else if (volumeRatio >= 1.5) score += 10;
        else if (volumeRatio >= CFG.MIN_VOLUME_RATIO) score += 5;
        else score -= 15;

        if (compressionRatio !== null) {
            if (compressionRatio < 0.7) score += 10;
            else if (compressionRatio < 0.9) score += 5;
            else score -= 5;
        }

        if (oiStatus === 'SUPPORTIVE') score += 10;
        else if (oiStatus === 'NOT_SUPPORTIVE') score -= 10;

        if (regime === 'UPTREND' && direction === 'LONG') score += 10;
        else if (regime === 'DOWNTREND' && direction === 'SHORT') score += 10;
        else if (regime !== 'UNKNOWN') score -= 5;

        if (CFG.RSI_FILTER_ENABLED) {
            const closes = closedCandles.map(c => c[4]);
            const rsi = calculateRSI(closes, 14);
            if (rsi !== null) {
                if (direction === 'LONG' && rsi > 80) score -= 10;
                if (direction === 'SHORT' && rsi < 20) score -= 10;
            }
        }

        score = Math.max(0, Math.min(100, score));

        const risk = Math.abs(trigger - stop);
        const fibTarget = calculateFibonacciExtension(closedCandles, CFG.LOOKBACK, direction);
        const minRRTarget = direction === 'LONG' ? trigger + risk * CFG.MIN_RR : trigger - risk * CFG.MIN_RR;

        let tp1 = fibTarget;
        if (!tp1 || (direction === 'LONG' && tp1 < minRRTarget) || (direction === 'SHORT' && tp1 > minRRTarget)) {
            tp1 = minRRTarget;
        }
        const tp2 = direction === 'LONG' ? trigger + risk * (CFG.MIN_RR * 2) : trigger - risk * (CFG.MIN_RR * 2);

        const targetDistancePct = (Math.abs(tp1 - trigger) / trigger) * 100;
        if (targetDistancePct < CFG.TARGET_SPACE_MIN_PERCENT) {
            logRejection(symbol, 'TARGET_TOO_CLOSE');
            DEBUG.targetTooClose++;
            return null;
        }

        const reward = Math.abs(tp1 - trigger);
        const rr = reward / risk;
        if (rr < CFG.MIN_RR) {
            logRejection(symbol, 'RR_TOO_LOW');
            DEBUG.rrTooLow++;
            return null;
        }

        // Güç etiketi
        let strengthLabel, strengthClass;
        if (score >= 85) { strengthLabel = '🔥🔥 ULTRA'; strengthClass = 'strength-ultra'; }
        else if (score >= 78) { strengthLabel = '🔥 GÜÇLÜ'; strengthClass = 'strength-high'; }
        else if (score >= 68) { strengthLabel = '💪 İYİ'; strengthClass = 'strength-good'; }
        else { strengthLabel = '⚡ NORMAL'; strengthClass = 'strength-normal'; }

        const existing = setups.find(s =>
            s.symbol === ccxtSymbol &&
            s.direction === direction &&
            ['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING', 'RETEST_CONFIRMED'].includes(s.state)
        );

        if (existing) {
            // Mevcut setup'ı güncelle ama seviyeleri kilitle (değiştirme)
            // Sadece fiyat, skor gibi dinamik alanları güncelle
            existing.currentPrice = lastClose;
            existing.volumeRatio = volumeRatio;
            existing.oiChangePct = oiChangePct;
            existing.oiStatus = oiStatus;
            existing.regime = regime;
            existing.compressionRatio = compressionRatio;
            existing.score = score;
            existing.strengthLabel = strengthLabel;
            existing.strengthClass = strengthClass;
            existing.updatedAt = Date.now();
            DEBUG.duplicate++;
            return null;
        }

        const setup = createSetupObject(ccxtSymbol, direction, {
            currentPrice: lastClose,
            trigger,
            stop,
            tp1,
            tp2,
            breakoutLevel,
            volumeRatio,
            oiChangePct,
            oiStatus,
            regime,
            compressionRatio,
            atr,
            score,
            reason: `${direction} breakout watch - R:${resistance.toFixed(4)} S:${support.toFixed(4)}`,
            strengthLabel,
            strengthClass
        });

        setup.lastProcessedCandleTimestamp = closedCandles[closedCandles.length - 1][0];
        setups.push(setup);
        DEBUG.watchCreated++;
        logRejection(symbol, 'WATCH_CREATED');

        if (isManual) return setup;
        return null;
    } catch (error) {
        console.error(`[analyze2HBreakout HATA] ${ccxtSymbol}: ${error.message}`);
        logRejection(symbol, 'INTERNAL_ERROR');
        return null;
    }
}

// ==================== KAPANIŞ KONTROLÜ ====================
async function checkClosedCandlesForSetups() {
    if (isCheckingClosedCandles || isShuttingDown) return;
    isCheckingClosedCandles = true;
    try {
        for (const setup of setups) {
            if (!['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(setup.state)) continue;

            const ohlcv = await exchange.fetchOHLCV(setup.symbol, CFG.TIMEFRAME, undefined, 3);
            if (!ohlcv || ohlcv.length < 2) continue;

            const closedCandle = ohlcv[ohlcv.length - 2];
            const closedTimestamp = closedCandle[0];
            const closedClose = closedCandle[4];
            const closedHigh = closedCandle[2];
            const closedLow = closedCandle[3];
            const closedVolume = closedCandle[5];

            if (setup.lastProcessedCandleTimestamp === closedTimestamp) continue;
            setup.lastProcessedCandleTimestamp = closedTimestamp;

            if (setup.state === 'WATCH') {
                if (setup.direction === 'LONG' && closedClose >= setup.trigger) {
                    setup.state = 'BREAKOUT_CONFIRMED';
                    setup.breakoutConfirmedAt = Date.now();
                    setup.retestPendingSince = Date.now();
                    setup.breakoutCandle = {
                        timestamp: closedTimestamp,
                        open: closedCandle[1],
                        high: closedHigh,
                        low: closedLow,
                        close: closedClose,
                        volume: closedVolume,
                        volumeRatio: setup.volumeRatio
                    };
                    DEBUG.breakoutConfirmed++;
                    console.log(`[BREAKOUT] ${setup.symbol} LONG | 2H Close: ${closedClose}`);
                } else if (setup.direction === 'SHORT' && closedClose <= setup.trigger) {
                    setup.state = 'BREAKOUT_CONFIRMED';
                    setup.breakoutConfirmedAt = Date.now();
                    setup.retestPendingSince = Date.now();
                    setup.breakoutCandle = {
                        timestamp: closedTimestamp,
                        open: closedCandle[1],
                        high: closedHigh,
                        low: closedLow,
                        close: closedClose,
                        volume: closedVolume,
                        volumeRatio: setup.volumeRatio
                    };
                    DEBUG.breakoutConfirmed++;
                    console.log(`[BREAKOUT] ${setup.symbol} SHORT | 2H Close: ${closedClose}`);
                } else if (setup.direction === 'LONG' && closedClose < setup.breakoutLevel) {
                    const distance = (setup.trigger - closedClose) / closedClose * 100;
                    if (distance > CFG.WATCH_DISTANCE_PCT * 2) {
                        setup.state = 'CANCEL';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = Date.now();
                    }
                } else if (setup.direction === 'SHORT' && closedClose > setup.breakoutLevel) {
                    const distance = (closedClose - setup.trigger) / closedClose * 100;
                    if (distance > CFG.WATCH_DISTANCE_PCT * 2) {
                        setup.state = 'CANCEL';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = Date.now();
                    }
                }
            } else if (setup.state === 'BREAKOUT_CONFIRMED' || setup.state === 'RETEST_PENDING') {
                if (Date.now() - setup.retestPendingSince > CFG.RETEST_TIMEOUT_MS) {
                    setup.state = 'EXPIRED';
                    setup.invalidReason = 'Retest zaman aşımı';
                    setup.finishedAt = Date.now();
                    continue;
                }

                if (setup.retestLowHigh !== null) {
                    if (setup.direction === 'LONG') {
                        if (closedClose > setup.breakoutLevel) {
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = Date.now();
                            setup.retestStatus = 'CONFIRMED';
                            DEBUG.retestConfirmed++;
                            emitSignal(setup);
                        } else if (closedClose < setup.breakoutLevel - setup.atr * 0.8) {
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = Date.now();
                        }
                    } else { // SHORT
                        if (closedClose < setup.breakoutLevel) {
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = Date.now();
                            setup.retestStatus = 'CONFIRMED';
                            DEBUG.retestConfirmed++;
                            emitSignal(setup);
                        } else if (closedClose > setup.breakoutLevel + setup.atr * 0.8) {
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = Date.now();
                        }
                    }
                }
            }
        }
        cleanOldSetups();
        broadcast();
    } catch (error) {
        console.error('Kapanış kontrolü hatası:', error.message);
    } finally {
        isCheckingClosedCandles = false;
    }
}

// ==================== CANLI FİYAT İZLEME ====================
async function updateLivePrices() {
    if (isUpdatingPrices || isShuttingDown) return;
    isUpdatingPrices = true;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();

        for (const setup of setups) {
            if (!['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(setup.state)) continue;

            const ticker = tickers[setup.symbol];
            if (!ticker?.last) continue;
            const price = Number(ticker.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;

            if (setup.state === 'WATCH') {
                if (setup.direction === 'LONG' && price < setup.breakoutLevel - setup.atr * 0.5) {
                    setup.state = 'CANCEL';
                    setup.invalidReason = 'Ters yöne güçlü hareket';
                    setup.finishedAt = now;
                } else if (setup.direction === 'SHORT' && price > setup.breakoutLevel + setup.atr * 0.5) {
                    setup.state = 'CANCEL';
                    setup.invalidReason = 'Ters yöne güçlü hareket';
                    setup.finishedAt = now;
                }
            } else if (setup.state === 'BREAKOUT_CONFIRMED' || setup.state === 'RETEST_PENDING') {
                if (setup.direction === 'LONG') {
                    if (price <= setup.breakoutLevel + setup.atr * CFG.RETEST_TOLERANCE_ATR_MULT) {
                        setup.state = 'RETEST_PENDING';
                        if (setup.retestLowHigh === null) {
                            setup.retestLowHigh = price;
                        } else {
                            setup.retestLowHigh = Math.min(setup.retestLowHigh, price);
                        }
                    }
                } else { // SHORT
                    if (price >= setup.breakoutLevel - setup.atr * CFG.RETEST_TOLERANCE_ATR_MULT) {
                        setup.state = 'RETEST_PENDING';
                        if (setup.retestLowHigh === null) {
                            setup.retestLowHigh = price;
                        } else {
                            setup.retestLowHigh = Math.max(setup.retestLowHigh, price);
                        }
                    }
                }
            }
        }
        cleanOldSetups();
        broadcast();
    } catch (error) {
        warnOnce('Fiyat güncelleme başarısız', error);
    } finally {
        isUpdatingPrices = false;
    }
}

function cleanOldSetups() {
    const now = Date.now();
    setups = setups.filter(setup => {
        if (['CANCEL', 'EXPIRED', 'BREAKOUT_INVALID'].includes(setup.state)) {
            return now - setup.finishedAt < CFG.CANCELED_RETENTION_MS;
        }
        if (setup.state === 'FIRE') {
            return now - setup.retestConfirmedAt < CFG.SIGNAL_RETENTION_MS;
        }
        return true;
    });
}

function emitSignal(setup) {
    const signalData = {
        symbol: setup.symbol,
        timeframe: CFG.TIMEFRAME,
        direction: setup.direction,
        signalType: '2H_BREAKOUT',
        entry: setup.trigger,
        stop: setup.stop,
        tp1: setup.tp1,
        tp2: setup.tp2,
        rr: setup.rr,
        breakoutLevel: setup.breakoutLevel,
        breakoutCandleTimestamp: setup.breakoutCandle?.timestamp,
        breakoutCandleClose: setup.breakoutCandle?.close,
        volumeRatio: setup.volumeRatio,
        compressionRatio: setup.compressionRatio,
        oiStatus: setup.oiStatus,
        regime: setup.regime,
        retestStatus: setup.retestStatus,
        score: setup.score,
        timestamp: Date.now()
    };

    signals.unshift(signalData);
    setup.state = 'FIRE'; // frontend uyumu
    setup.retestConfirmedAt = Date.now();
    DEBUG.signalEmitted++;
    broadcast();
    console.log(`\x1b[32m[SIGNAL] ${setup.symbol} ${setup.direction} | Entry: ${setup.trigger.toFixed(4)} | SL: ${setup.stop.toFixed(4)} | TP1: ${setup.tp1.toFixed(4)} | RR: ${setup.rr.toFixed(2)} | Score: ${setup.score}\x1b[0m`);
}

// ==================== TARAMA DÖNGÜLERİ ====================
async function runPreScan() {
    console.log(`\n--- ÖN TARAMA BAŞLADI (${new Date().toLocaleTimeString()}) ---`);
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            await exchange.loadMarkets(true);
        }
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) {
            console.warn('Ön tarama ticker alınamadı');
            return;
        }
        const filtered = [];
        for (const ticker of Object.values(tickers)) {
            if (!ticker?.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
            const market = exchange.markets[ticker.symbol];
            if (market && market.active && market.swap && market.quote === 'USDT' && ticker.quoteVolume >= CFG.MIN_VOLUME_USDT) {
                filtered.push(ticker.symbol);
            }
        }
        globalTargetList = filtered;
        DEBUG.totalTickers = Object.keys(tickers).length;
        DEBUG.volumeFiltered = filtered.length;
        console.log(`Ön tarama tamamlandı: ${filtered.length} coin hedefte.`);
    } catch (e) {
        console.error('Ön tarama hatası:', e.message);
    }
}

async function run2HBreakoutScan() {
    if (isScanning || isShuttingDown || globalTargetList.length === 0) return;
    isScanning = true;
    console.log(`\n--- 2H BREAKOUT TARAMA BAŞLADI (${globalTargetList.length} hedef) ---`);

    const candidates = globalTargetList.slice(0, CFG.MAX_CANDIDATES);
    for (const symbol of candidates) {
        try {
            await analyze2HBreakout(symbol, false);
            await sleep(100);
        } catch (e) {
            console.error(`Tarama hatası ${symbol}:`, e.message);
        }
    }

    cleanOIHistory();
    cleanOldSetups();
    broadcast();
    printDebugReport();
    resetDebug();
    isScanning = false;
}

// ==================== API ENDPOINTLERİ ====================
function getSnapshot() {
    const active = setups.filter(s => ['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING', 'RETEST_CONFIRMED', 'FIRE'].includes(s.state));
    return {
        setups,
        stats: {
            total: active.length,
            watch: active.filter(s => s.state === 'WATCH').length,
            fire: active.filter(s => s.state === 'FIRE').length
        },
        signals: signals.slice(0, 50),
        scanning: isScanning,
        updatedAt: Date.now()
    };
}

function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: getSnapshot() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch {}
        }
    });
}

app.get('/api/setups', (req, res) => {
    res.json({ success: true, ...getSnapshot() });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, scanning: isScanning, setupCount: setups.length });
});

app.get('/api/chart', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '2h';
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        const signal = setups.find(s => s.symbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol;
    if (!userSymbolInput) return res.status(400).json({ error: 'Sembol eksik.' });
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace(/[\/:USDT PERP]/g, '').trim();
    try {
        if (!exchange.markets) await exchange.loadMarkets(true);
        const foundMarket = Object.values(exchange.markets).find(m => m.active && m.swap && m.quote === 'USDT' && m.base === cleanBaseSymbol);
        if (!foundMarket) return res.status(404).json({ error: `'${cleanBaseSymbol}' marketi bulunamadı.` });
        const setup = await analyze2HBreakout(foundMarket.symbol, true);
        if (setup) {
            res.json({ success: true, setup });
        } else {
            res.json({ success: false, message: 'Uygun 2H breakout setup bulunamadı.' });
        }
    } catch (err) {
        res.status(500).json({ error: `Sunucu hatası: ${err.message}` });
    }
});

// ==================== FRONTEND (REFERANS) ====================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MANUAL BREAKOUT RADAR - 2H</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh}
@media(max-width:800px){.app{grid-template-columns:1fr}.signal-panel{display:none}}
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh}
.panel-header{padding:15px;border-bottom:1px solid #1a2533}
.panel-title{font-size:18px;font-weight:900;color:#13dba0}
.panel-sub{font-size:9px;color:#718096;margin-top:2px}
.panel-stats{display:flex;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533}
.panel-stat{flex:1;text-align:center;background:#101826;border-radius:6px;padding:6px}
.panel-stat b{display:block;font-size:18px;color:#13dba0}
.panel-stat span{font-size:8px;color:#64748b}
.signal-list{flex:1;overflow-y:auto;padding:10px}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer;transition:all .2s}
.signal-card:hover{border-color:#13dba0}
.signal-card.selected{border:2px solid #13dba0;background:#0d1a15}
.signal-card.long{border-left:5px solid #13dba0}
.signal-card.short{border-left:5px solid #ff5570}
.signal-card.fire{box-shadow:0 0 30px rgba(251,191,36,.4);border-color:#fbbf24;animation:fireGlow 1s infinite}
.signal-card.cancel,.signal-card.expired{opacity:.35;filter:grayscale(60%)}
@keyframes fireGlow{0%,100%{box-shadow:0 0 30px rgba(251,191,36,.4)}50%{box-shadow:0 0 55px rgba(251,191,36,.6)}}
.signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.signal-coin{font-size:15px;font-weight:900;color:#e2e8f0}
.signal-direction{font-size:10px;padding:4px 12px;border-radius:15px;font-weight:900;letter-spacing:1px}
.dir-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.dir-short{background:#421d28;color:#ff5570;border:1px solid #ff5570}
.strength-badge{display:inline-block;font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold;margin-top:4px}
.strength-ultra{background:#1a0d3d;color:#a78bfa;border:1px solid #a78bfa;animation:pulse 1s infinite}
.strength-high{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.strength-good{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee}
.strength-normal{background:#1e293b;color:#94a3b8;border:1px solid #64748b}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.signal-price{font-size:18px;font-weight:900;margin:5px 0;color:#f1f5f9}
.signal-info{display:flex;gap:8px;font-size:9px;color:#94a3b8;margin-top:5px;flex-wrap:wrap}
.signal-info b{color:#e2e8f0}
.state-badge{font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold}
.state-watch{background:#0d3d2a;color:#13dba0}
.state-fire{background:#3d2d0d;color:#fbbf24}
.chart-panel{background:#0b111b;display:flex;flex-direction:column;padding:15px;min-width:0}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.chart-title{font-size:16px;font-weight:900;color:#13dba0}
.tf-buttons{display:flex;gap:5px}
.tf-btn{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 10px;font-size:9px;cursor:pointer}
.tf-btn.active{color:#13dba0;border-color:#13dba0}
.chart-container{flex:1;min-height:0;position:relative}
canvas{width:100%;height:100%;display:block}
.empty{text-align:center;color:#64748b;font-size:14px;padding:40px}
.detail-panel{margin-top:10px;background:#101826;border:1px solid #1c2938;border-radius:8px;padding:12px}
.detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:10px;color:#94a3b8;border-bottom:1px solid #1a2533}
.detail-row:last-child{border-bottom:0}
.detail-row b{color:#e2e8f0}
</style>
</head>
<body>
<div class="app">
<div class="signal-panel">
<div class="panel-header">
<div class="panel-title">MANUAL BREAKOUT RADAR</div>
<div class="panel-sub">2H Breakout Engine - WATCH ile hazırlan, FIRE gelince karar ver</div>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Aktif</span></div>
<div class="panel-stat"><b id="st-watch">0</b><span>WATCH</span></div>
<div class="panel-stat"><b id="st-fire">0</b><span>FIRE</span></div>
</div>
<div class="signal-list" id="signals"><div class="empty">Tarama başlıyor...</div></div>
</div>
<div class="chart-panel">
<div class="chart-header">
<div class="chart-title" id="chartTitle">Sinyal seçin</div>
<div class="tf-buttons">
<button class="tf-btn active" data-tf="2h">2H</button>
<button class="tf-btn" data-tf="1h">1H</button>
<button class="tf-btn" data-tf="15m">15M</button>
<button class="tf-btn" data-tf="5m">5M</button>
</div>
</div>
<div class="chart-container"><canvas id="chartCanvas"></canvas></div>
<div class="detail-panel" id="details"><div class="empty">Soldan bir kurulum seçin</div></div>
</div>
</div>
<script>
var setups=[],selectedId=null,selectedTf='2h',chartCandles=[],currentSetup=null,connected=false;
function fmtPrice(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);return x.toFixed(8)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function selectSetup(id){selectedId=id;currentSetup=setups.find(function(s){return s.id===id})||null;document.querySelectorAll('.signal-card').forEach(function(c){c.classList.remove('selected');if(c.getAttribute('data-id')===id)c.classList.add('selected')});var sym=currentSetup?currentSetup.symbol:'BTC/USDT:USDT';document.getElementById('chartTitle').textContent=sym.replace(':USDT','')+' - '+selectedTf.toUpperCase();showDetails();loadChart(sym)}
function showDetails(){if(!currentSetup){document.getElementById('details').innerHTML='<div class="empty">Soldan bir kurulum seçin</div>';return}var s=currentSetup;var st=s.state==='FIRE'?'🔥 FIRE - KIRILIM!':s.state==='WATCH'?'👀 WATCH - HAZIRLAN':s.state;document.getElementById('details').innerHTML='<div class="detail-row"><span>DURUM</span><b>'+esc(st)+'</b></div><div class="detail-row"><span>YÖN</span><b style="color:'+(s.direction==='LONG'?'#13dba0':'#ff5570')+'">'+esc(s.direction)+'</b></div><div class="detail-row"><span>GÜÇ</span><b>'+esc(s.strengthLabel)+'</b></div><div class="detail-row"><span>GİRİŞ TETİĞİ</span><b style="color:#13dba0">'+fmtPrice(s.trigger)+'</b></div><div class="detail-row"><span>STOP</span><b style="color:#ff5570">'+fmtPrice(s.stop)+'</b></div><div class="detail-row"><span>TP1</span><b style="color:#55a7ff">'+fmtPrice(s.tp1)+'</b></div><div class="detail-row"><span>TP2</span><b style="color:#55a7ff">'+fmtPrice(s.tp2)+'</b></div><div class="detail-row"><span>SKOR</span><b style="color:#fbbf24">'+esc(s.score)+'/100</b></div><div class="detail-row"><span>NEDEN</span><b style="font-size:9px">'+esc(s.reason)+'</b></div>'}
async function loadChart(symbol){if(!symbol)return;try{var r=await fetch('/api/chart?symbol='+encodeURIComponent(symbol)+'&timeframe='+encodeURIComponent(selectedTf));var d=await r.json();if(d.success){chartCandles=d.candles||[];drawChart()}}catch(e){}}
function drawChart(){var canvas=document.getElementById('chartCanvas');if(!canvas||!chartCandles.length)return;var parent=canvas.parentElement;var w=Math.max(300,parent.clientWidth);var h=Math.max(300,parent.clientHeight);var dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#070b11';ctx.fillRect(0,0,w,h);var visible=chartCandles.slice(-60);var minPrice=Math.min.apply(Math,visible.map(function(c){return c[3]}));var maxPrice=Math.max.apply(Math,visible.map(function(c){return c[2]}));if(currentSetup){[currentSetup.trigger,currentSetup.stop,currentSetup.tp1,currentSetup.tp2].forEach(function(p){if(p&&p<minPrice)minPrice=p;if(p&&p>maxPrice)maxPrice=p})}var pad=(maxPrice-minPrice)*0.08;minPrice-=pad;maxPrice+=pad;var L=40,R=100,T=15,B=15;var PW=w-L-R;var PH=h-T-B;function Y(price){return T+(maxPrice-price)/(maxPrice-minPrice)*PH}function X(i){return L+i*PW/(visible.length-1)}ctx.strokeStyle='#182330';for(var g=0;g<=4;g++){var gy=T+PH*g/4;ctx.beginPath();ctx.moveTo(L,gy);ctx.lineTo(w-R,gy);ctx.stroke();ctx.fillStyle='#607083';ctx.font='8px Arial';ctx.fillText(fmtPrice(maxPrice-(maxPrice-minPrice)*g/4),3,gy+3)}var step=PW/(visible.length-1);var bw=Math.max(2,Math.min(8,step*0.6));visible.forEach(function(candle,i){var xx=X(i);var up=candle[4]>=candle[1];var col=up?'#13e0a2':'#ff4d6d';ctx.strokeStyle=col;ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(xx,Y(candle[2]));ctx.lineTo(xx,Y(candle[3]));ctx.stroke();var yo=Y(candle[1]),yc=Y(candle[4]);ctx.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)))});if(currentSetup){drawLevel(ctx,currentSetup.trigger,'#13dba0','TETIK',L,w-R,Y);drawLevel(ctx,currentSetup.stop,'#ff5570','STOP',L,w-R,Y);drawLevel(ctx,currentSetup.tp1,'#55a7ff','TP1',L,w-R,Y);drawLevel(ctx,currentSetup.tp2,'#55a7ff','TP2',L,w-R,Y)}}
function drawLevel(ctx,price,color,label,L,R,Y){if(!price)return;var yy=Y(price);ctx.strokeStyle=color;ctx.setLineDash([5,5]);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(L,yy);ctx.lineTo(R,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='bold 9px Arial';ctx.fillText(label+' '+fmtPrice(price),R+5,yy+3)}
function render(data){setups=Array.isArray(data.setups)?data.setups:[];var stats=data.stats||{};document.getElementById('st-total').textContent=stats.total||0;document.getElementById('st-watch').textContent=stats.watch||0;document.getElementById('st-fire').textContent=stats.fire||0;var container=document.getElementById('signals');if(!setups.length){container.innerHTML='<div class="empty">Şu an hazırlanacak kurulum yok.</div>';return}container.innerHTML=setups.map(function(s){var state=s.state.toLowerCase();var dir=s.direction==='LONG'?'long':'short';var cardClass=dir+' '+state;if(selectedId===s.id)cardClass+=' selected';return '<div class="signal-card '+cardClass+'" data-id="'+esc(s.id)+'"><div class="signal-top"><span class="signal-coin">'+esc(s.symbol.replace(':USDT',''))+'</span><span class="signal-direction '+(s.direction==='LONG'?'dir-long':'dir-short')+'">'+esc(s.direction)+'</span></div><div class="strength-badge '+esc(s.strengthClass)+'">'+esc(s.strengthLabel)+'</div><div class="signal-price">'+fmtPrice(s.currentPrice)+'</div><div class="signal-info"><span>Skor: <b>'+esc(s.score)+'</b></span><span>Hacim: <b>'+esc(s.volumeRatio)+'x</b></span><span>OI: <b>%'+esc(s.oiChangePct)+'</b></span><span class="state-badge state-'+state+'">'+esc(s.state)+'</span></div></div>'}).join('');document.querySelectorAll('.signal-card').forEach(function(card){card.addEventListener('click',function(){var id=this.getAttribute('data-id');if(id)selectSetup(id)})});if(selectedId){currentSetup=setups.find(function(s){return s.id===selectedId})||null;if(currentSetup)showDetails()}}
document.querySelectorAll('.tf-btn').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('.tf-btn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');selectedTf=btn.getAttribute('data-tf');if(currentSetup){document.getElementById('chartTitle').textContent=currentSetup.symbol.replace(':USDT','')+' - '+selectedTf.toUpperCase();loadChart(currentSetup.symbol)}})});
function connect(){var proto=location.protocol==='https:'?'wss://':'ws://';var ws=new WebSocket(proto+location.host);ws.onopen=function(){connected=true};ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='snapshot')render(msg.data)}catch(_){}};ws.onclose=function(){connected=false;setTimeout(connect,3000)}}connect();
setInterval(function(){if(connected)return;fetch('/api/setups',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.success)render(d)}).catch(function(){})},4000);
window.addEventListener('resize',drawChart);
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

wss.on('connection', ws => {
    ws.on('error', error => warnOnce('WebSocket hatası', error));
    try {
        ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() }));
    } catch {}
});

// ==================== BAŞLATMA ====================
async function start() {
    try {
        await exchange.loadMarkets();
        console.log('Bitget marketleri yüklendi.');
    } catch (error) {
        console.error('Marketler yüklenemedi:', error.message);
        setTimeout(start, 30 * 1000);
        return;
    }
    await runPreScan();
    if (globalTargetList.length > 0) {
        await run2HBreakoutScan();
    }
    scanTimer = setInterval(runPreScan, CFG.PRESCAN_INTERVAL_MS);
    liveTimer = setInterval(updateLivePrices, CFG.LIVE_UPDATE_INTERVAL_MS);
    closeTimer = setInterval(checkClosedCandlesForSetups, CFG.CLOSED_CANDLE_CHECK_INTERVAL_MS);
    setInterval(run2HBreakoutScan, CFG.SCAN_INTERVAL_MS);
    console.log('Döngüler başlatıldı.');
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(scanTimer);
    clearInterval(liveTimer);
    clearInterval(closeTimer);
    console.log(signal + ' alındı; kapanıyor.');
    wss.clients.forEach(client => client.close(1001, 'Sunucu kapanıyor'));
    wss.close();
    server.close(async () => {
        try { await exchange.close(); } catch {}
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10 * 1000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('2H Breakout Engine: http://0.0.0.0:' + PORT);
    void start();
});

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
