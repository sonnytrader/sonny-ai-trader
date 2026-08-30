'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const { randomUUID } = require('node:crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const VALID_CHART_TIMEFRAMES = new Set(['15m', '1h', '4h']);

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
    });
    next();
});

const CFG = {
    SCAN_INTERVAL_MS: 60 * 1000,
    SIGNAL_UPDATE_MS: 2000,

    SIGNAL_TTL_MS: 15 * 60 * 1000,
    FRESH_AGE_MS: 3 * 60 * 1000,
    ACTIONABLE_AGE_MS: 6 * 60 * 1000,
    LATE_AGE_MS: 10 * 60 * 1000,

    FRESH_DISTANCE_PCT: 0.3,
    ACTIONABLE_DISTANCE_PCT: 0.6,
    LATE_DISTANCE_PCT: 1.0,

    MIN_VOLUME_USDT: 1_000_000,
    MAX_CANDIDATES: 50,

    ATR_PERIOD: 14,
    COMPRESSION_BOX_CANDLES: 10,
    ATR_LOOKBACK_SHORT: 20,
    ATR_LOOKBACK_LONG: 40,
    COMPRESSION_RATIO: 0.6,
    MAX_BOX_WIDTH_PCT: 1.5,

    OI_HISTORY_MINUTES: 30,
    OI_ACCUMULATION_PCT: 2.0,
    OI_ZSCORE_THRESHOLD: 2.0,
    OI_FLOW_THRESHOLD_PCT: 0.5,

    BREAKOUT_BUFFER_PCT: 0.05,
    VOLUME_IGNITION_MULT: 3.0,

    SL_ATR_MULT: 1.0,
    TP1_ATR_MULT: 2.0,
    TP2_ATR_MULT: 3.5,

    MAX_ACTIVE_SIGNALS: 10,
    MAX_STORED_SIGNALS: 100,
    CANDLE_LIMIT: 100,
    CHART_LIMIT: 100,
    OI_QUERY_DELAY_MS: 150,

    CHART_RATE_LIMIT_WINDOW_MS: 60 * 1000,
    CHART_RATE_LIMIT_MAX: 30
};

let activeSignals = [];
let isScanning = false;
let isUpdatingSignals = false;
let isShuttingDown = false;
let scannerTimer;
let lifecycleTimer;

const oiHistoryBuffer = new Map();
const lastWarnings = new Map();
const chartRequestCounts = new Map();

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

function n(value, decimals = 6) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(decimals)) : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function avg(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

function stdDev(values) {
    if (!values.length) return 0;
    const mean = avg(values);
    return Math.sqrt(avg(values.map(value => Math.pow(value - mean, 2))));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();

    if (now - (lastWarnings.get(key) || 0) < cooldownMs) return;

    lastWarnings.set(key, now);
    console.warn(`[${new Date(now).toISOString()}] ${key}: ${error.message}`);
}

function fmtPrice(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) return '-';
    if (number >= 1000) return number.toFixed(2);
    if (number >= 100) return number.toFixed(3);
    if (number >= 1) return number.toFixed(5);
    if (number >= 0.01) return number.toFixed(7);

    return number.toFixed(8);
}

function getSnapshot() {
    return {
        signals: activeSignals,
        stats: {
            total: activeSignals.length,
            fresh: activeSignals.filter(signal => signal.cardState === 'FRESH').length,
            actionable: activeSignals.filter(signal => signal.cardState === 'VALID').length
        }
    };
}

function isRateLimited(req) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';

    const recentRequests = (chartRequestCounts.get(key) || [])
        .filter(timestamp => now - timestamp < CFG.CHART_RATE_LIMIT_WINDOW_MS);

    if (recentRequests.length >= CFG.CHART_RATE_LIMIT_MAX) {
        chartRequestCounts.set(key, recentRequests);
        return true;
    }

    recentRequests.push(now);
    chartRequestCounts.set(key, recentRequests);

    return false;
}

function calculateATR(candles, period = CFG.ATR_PERIOD) {
    if (candles.length < period + 1) return null;

    const trValues = [];

    for (let index = 1; index < candles.length; index++) {
        const high = candles[index][2];
        const low = candles[index][3];
        const previousClose = candles[index - 1][4];

        trValues.push(
            Math.max(
                high - low,
                Math.abs(high - previousClose),
                Math.abs(low - previousClose)
            )
        );
    }

    return trValues.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function calculateAvgVolume(candles, period = 20) {
    if (candles.length < period + 1) return null;

    return candles
        .slice(-(period + 1), -1)
        .reduce((sum, candle) => sum + candle[5], 0) / period;
}

function calculateLiveVolumeSurge(candles, timeframe) {
    const avgVolume = calculateAvgVolume(candles);
    const currentCandle = candles[candles.length - 1];

    const intervalMs = {
        '15m': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000
    }[timeframe];

    if (!avgVolume || !currentCandle || !intervalMs) return null;

    const candleTimestamp = Number(currentCandle[0]);
    const currentVolume = Number(currentCandle[5]);

    if (
        !Number.isFinite(candleTimestamp) ||
        !Number.isFinite(currentVolume) ||
        currentVolume <= 0
    ) {
        return null;
    }

    const elapsed = Date.now() - candleTimestamp;
    const progress = elapsed < intervalMs
        ? clamp(elapsed / intervalMs, 0.15, 1)
        : 1;

    const projectedVolume = currentVolume / progress;

    return {
        avgVolume,
        currentVolume,
        projectedVolume,
        ratio: projectedVolume / avgVolume
    };
}

async function getOI(symbol) {
    try {
        const oi = await exchange.fetchOpenInterest(symbol);

        if (oi) {
            if (typeof oi === 'object') {
                const value = parseFloat(
                    oi.openInterestAmount ||
                    oi.openInterest ||
                    oi.amount ||
                    0
                );

                if (value > 0) return value;
            }

            if (typeof oi === 'number' && oi > 0) {
                return oi;
            }
        }
    } catch (error) {
        warnOnce('CCXT open-interest sorgusu başarısız', error);
    }

    try {
        const cleanSymbol = symbol
            .replace(':USDT', '')
            .replace('/', '')
            .replace('USDT', '') + 'USDT';

        const url = `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${cleanSymbol}&productType=usdt-futures`;

        const response = await fetch(url, {
            signal: AbortSignal.timeout(8000)
        });

        if (response.ok) {
            const data = await response.json();

            if (data?.code === '00000' && data.data) {
                const value = parseFloat(
                    data.data.amount ||
                    data.data.openInterest ||
                    0
                );

                if (value > 0) return value;
            }
        }
    } catch (error) {
        warnOnce('Bitget open-interest yedek sorgusu başarısız', error);
    }

    return 0;
}

function updateOIHistory(symbol, oiValue) {
    if (!Number.isFinite(oiValue) || oiValue <= 0) return [];

    if (!oiHistoryBuffer.has(symbol)) {
        oiHistoryBuffer.set(symbol, []);
    }

    const history = oiHistoryBuffer.get(symbol);
    const now = Date.now();

    let changePct = 0;

    if (history.length > 0) {
        const previousOI = history[history.length - 1].value;

        if (previousOI > 0) {
            changePct = ((oiValue - previousOI) / previousOI) * 100;
        }
    }

    history.push({
        value: oiValue,
        timestamp: now,
        changePct
    });

    const cutoff = now - (CFG.OI_HISTORY_MINUTES * 60 * 1000);

    while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
    }

    return history;
}

function pruneOIHistory() {
    const cutoff = Date.now() - (CFG.OI_HISTORY_MINUTES * 60 * 1000);

    for (const [symbol, history] of oiHistoryBuffer.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);

        if (retained.length) {
            oiHistoryBuffer.set(symbol, retained);
        } else {
            oiHistoryBuffer.delete(symbol);
        }
    }
}

function calculateOIChangeZScore(symbol) {
    const history = oiHistoryBuffer.get(symbol) || [];

    if (history.length < 5) {
        return {
            zScore: 0,
            currentChangePct: 0
        };
    }

    const currentChangePct = history[history.length - 1].changePct;
    const historicalChanges = history.slice(0, -1).map(item => item.changePct);

    const mean = avg(historicalChanges);
    const deviation = stdDev(historicalChanges);

    if (deviation === 0) {
        return {
            zScore: 0,
            currentChangePct
        };
    }

    return {
        zScore: (currentChangePct - mean) / deviation,
        currentChangePct
    };
}

function calculateOIAccumulation(symbol) {
    const history = oiHistoryBuffer.get(symbol) || [];

    if (history.length < 3) return 0;

    const first = history[0];
    const last = history[history.length - 1];

    const timeDiffMinutes = (last.timestamp - first.timestamp) / 60000;

    if (timeDiffMinutes < 10 || first.value === 0) return 0;

    return ((last.value - first.value) / first.value) * 100;
}

function detectCompression(candles) {
    const closedCandles = candles.slice(0, -1);

    if (closedCandles.length < CFG.ATR_LOOKBACK_LONG) return null;

    const boxCandles = closedCandles.slice(-CFG.COMPRESSION_BOX_CANDLES);

    if (boxCandles.length < CFG.COMPRESSION_BOX_CANDLES) return null;

    const compressionHigh = Math.max(...boxCandles.map(candle => candle[2]));
    const compressionLow = Math.min(...boxCandles.map(candle => candle[3]));
    const boxWidth = compressionHigh - compressionLow;

    const boxWidthPct = compressionHigh > 0
        ? (boxWidth / compressionHigh) * 100
        : 100;

    if (boxWidthPct > CFG.MAX_BOX_WIDTH_PCT) {
        return {
            isCompressed: false,
            reason: 'BOX_ÇOK_GENİŞ',
            boxWidthPct,
            compressionHigh,
            compressionLow
        };
    }

    const recentATR = calculateATR(
        closedCandles.slice(-CFG.ATR_LOOKBACK_SHORT),
        CFG.ATR_PERIOD
    );

    const olderATR = calculateATR(
        closedCandles.slice(
            -CFG.ATR_LOOKBACK_LONG,
            -CFG.ATR_LOOKBACK_SHORT
        ),
        CFG.ATR_PERIOD
    );

    if (!recentATR || !olderATR || olderATR === 0) return null;

    const compressionRatio = recentATR / olderATR;

    return {
        isCompressed: compressionRatio < CFG.COMPRESSION_RATIO,
        compressionRatio,
        compressionHigh,
        compressionLow,
        boxWidthPct,
        recentATR,
        olderATR
    };
}

function detectBreakout(currentPrice, compression) {
    if (!compression?.isCompressed) return null;

    const highBuffer = compression.compressionHigh *
        (1 + CFG.BREAKOUT_BUFFER_PCT / 100);

    const lowBuffer = compression.compressionLow *
        (1 - CFG.BREAKOUT_BUFFER_PCT / 100);

    if (currentPrice > highBuffer) {
        return {
            direction: 'LONG',
            level: compression.compressionHigh,
            strength: (
                (currentPrice - compression.compressionHigh) /
                compression.compressionHigh
            ) * 100
        };
    }

    if (currentPrice < lowBuffer) {
        return {
            direction: 'SHORT',
            level: compression.compressionLow,
            strength: (
                (compression.compressionLow - currentPrice) /
                compression.compressionLow
            ) * 100
        };
    }

    return null;
}

function determineFlowType(priceDirection, oiChangePct) {
    const threshold = CFG.OI_FLOW_THRESHOLD_PCT;

    if (priceDirection === 'LONG' && oiChangePct < -threshold) {
        return {
            type: 'A',
            label: 'SHORT SQUEEZE BASKISI',
            description: 'Kısa pozisyonlar kapanıyor, yukarı baskı var'
        };
    }

    if (priceDirection === 'LONG' && oiChangePct > threshold) {
        return {
            type: 'B',
            label: 'EXPANSION LONG',
            description: 'Yeni alıcılar pozisyon açıyor'
        };
    }

    if (priceDirection === 'SHORT' && oiChangePct < -threshold) {
        return {
            type: 'C',
            label: 'LONG SQUEEZE BASKISI',
            description: 'Uzun pozisyonlar kapanıyor, aşağı baskı var'
        };
    }

    if (priceDirection === 'SHORT' && oiChangePct > threshold) {
        return {
            type: 'D',
            label: 'EXPANSION SHORT',
            description: 'Yeni satıcılar pozisyon açıyor'
        };
    }

    return null;
}

function calculateSignalScore(
    compressionRatio,
    oiZScore,
    oiAccumulation,
    volumeSurge,
    breakoutStrength
) {
    let score = 0;

    if (compressionRatio < 0.4) score += 25;
    else if (compressionRatio < 0.5) score += 20;
    else if (compressionRatio < 0.6) score += 15;
    else score += 10;

    if (Math.abs(oiZScore) > 4) score += 25;
    else if (Math.abs(oiZScore) > 3) score += 20;
    else if (Math.abs(oiZScore) > 2.5) score += 15;
    else if (Math.abs(oiZScore) > 2) score += 10;
    else score += 5;

    if (Math.abs(oiAccumulation) > 8) score += 20;
    else if (Math.abs(oiAccumulation) > 5) score += 15;
    else if (Math.abs(oiAccumulation) > 3) score += 10;
    else if (Math.abs(oiAccumulation) > 2) score += 5;

    if (volumeSurge > 8) score += 20;
    else if (volumeSurge > 5) score += 15;
    else if (volumeSurge > 3) score += 10;
    else score += 5;

    if (breakoutStrength > 1) score += 10;
    else if (breakoutStrength > 0.5) score += 7;
    else if (breakoutStrength > 0.2) score += 4;

    return Math.min(100, score);
}

async function getCandles(symbol, timeframe, limit) {
    try {
        const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

        return Array.isArray(data)
            ? data
                .filter(item => Array.isArray(item) && item.length >= 6)
                .sort((a, b) => a[0] - b[0])
            : [];
    } catch (error) {
        warnOnce(`Mum verisi alınamadı (${symbol}, ${timeframe})`, error);
        return [];
    }
}

async function preScan() {
    try {
        const tickers = await exchange.fetchTickers();
        const candidates = [];

        for (const [symbol, ticker] of Object.entries(tickers)) {
            if (!symbol.endsWith(':USDT')) continue;

            const volume = n(ticker.quoteVolume);
            const price = n(ticker.last);

            if (volume < CFG.MIN_VOLUME_USDT) continue;
            if (price < 0.0001) continue;

            candidates.push({ symbol, volume, price });
        }

        candidates.sort((a, b) => b.volume - a.volume);

        return candidates.slice(0, CFG.MAX_CANDIDATES);
    } catch (error) {
        warnOnce('Piyasa ön taraması başarısız', error);
        return [];
    }
}

async function scanAndAnalyze(candidates) {
    let signalCount = 0;
    let compressionCount = 0;
    let oiBuildCount = 0;
    let breakoutCount = 0;
    let volumeCount = 0;

    for (const candidate of candidates) {
        try {
            const existing = activeSignals.find(
                signal =>
                    signal.symbol === candidate.symbol &&
                    signal.cardState !== 'CLOSED'
            );

            if (existing) continue;

            const activeCount = activeSignals.filter(
                signal => signal.cardState !== 'CLOSED'
            ).length;

            if (activeCount >= CFG.MAX_ACTIVE_SIGNALS) break;

            const oi = await getOI(candidate.symbol);

            if (oi <= 0) continue;

            const cleanSymbol = candidate.symbol.replace(':USDT', '');

            updateOIHistory(cleanSymbol, oi);

            const oiResult = calculateOIChangeZScore(cleanSymbol);
            const oiZScore = oiResult.zScore;
            const oiAccumulation = calculateOIAccumulation(cleanSymbol);

            if (Math.abs(oiZScore) < CFG.OI_ZSCORE_THRESHOLD) continue;
            if (Math.abs(oiAccumulation) < CFG.OI_ACCUMULATION_PCT) continue;

            oiBuildCount++;

            const candles = await getCandles(
                candidate.symbol,
                '15m',
                CFG.CANDLE_LIMIT
            );

            if (candles.length < 50) continue;

            const compression = detectCompression(candles);

            if (!compression?.isCompressed) continue;

            compressionCount++;

            const currentCandle = candles[candles.length - 1];
            const currentPrice = n(currentCandle[4]);

            if (currentPrice <= 0) continue;

            const breakout = detectBreakout(currentPrice, compression);

            if (!breakout) continue;

            breakoutCount++;

            const volumeMetrics = calculateLiveVolumeSurge(candles, '15m');

            if (!volumeMetrics) continue;

            const volumeSurge = volumeMetrics.ratio;

            if (volumeSurge < CFG.VOLUME_IGNITION_MULT) continue;

            volumeCount++;

            const flowType = determineFlowType(
                breakout.direction,
                oiResult.currentChangePct
            );

            if (!flowType) continue;

            const score = calculateSignalScore(
                compression.compressionRatio,
                oiZScore,
                oiAccumulation,
                volumeSurge,
                breakout.strength
            );

            if (score < 50) continue;

            const atr = compression.recentATR;

            const stop = breakout.direction === 'LONG'
                ? compression.compressionLow - (atr * CFG.SL_ATR_MULT)
                : compression.compressionHigh + (atr * CFG.SL_ATR_MULT);

            const risk = Math.abs(currentPrice - stop);

            const tp1 = breakout.direction === 'LONG'
                ? currentPrice + (risk * CFG.TP1_ATR_MULT)
                : currentPrice - (risk * CFG.TP1_ATR_MULT);

            const tp2 = breakout.direction === 'LONG'
                ? currentPrice + (risk * CFG.TP2_ATR_MULT)
                : currentPrice - (risk * CFG.TP2_ATR_MULT);

            let strengthLabel;
            let strengthClass;

            if (score >= 85) {
                strengthLabel = '🔥🔥 ULTRA';
                strengthClass = 'strength-ultra';
            } else if (score >= 70) {
                strengthLabel = '🔥 GÜÇLÜ';
                strengthClass = 'strength-high';
            } else if (score >= 55) {
                strengthLabel = '💪 İYİ';
                strengthClass = 'strength-good';
            } else {
                strengthLabel = '⚡ NORMAL';
                strengthClass = 'strength-normal';
            }

            activeSignals.unshift({
                id: randomUUID(),
                symbol: candidate.symbol,
                type: breakout.direction,
                flowType: flowType.type,
                scenario: flowType.label,
                scenarioDesc: flowType.description,

                entryPrice: currentPrice,
                entryPriceFormatted: fmtPrice(currentPrice),

                stop,
                stopFormatted: fmtPrice(stop),

                tp1,
                tp1Formatted: fmtPrice(tp1),

                tp2,
                tp2Formatted: fmtPrice(tp2),

                currentPrice,
                maxPrice: currentPrice,
                minPrice: currentPrice,

                timestamp: Date.now(),
                time: new Date().toLocaleTimeString('tr-TR'),

                oiZScore: oiZScore.toFixed(2),
                oiChangePct: oiResult.currentChangePct.toFixed(2),
                oiAccumulation: oiAccumulation.toFixed(2),

                volumeSurgeRatio: volumeSurge.toFixed(2),
                compressionRatio: compression.compressionRatio.toFixed(2),
                boxWidthPct: compression.boxWidthPct.toFixed(2),

                score,
                strength: strengthLabel,
                strengthClass,

                status: '🟢 FRESH',
                statusClass: 'status-fresh',
                cardState: 'FRESH',

                distancePct: '0.000',
                ageMin: '0',
                mfe: 0,
                mae: 0,
                atr
            });

            signalCount++;

            console.log(
                `🚀 ${candidate.symbol} ${breakout.direction} | ${flowType.label} | ` +
                `OI Z: ${oiZScore.toFixed(1)} | ` +
                `ΔOI: %${oiResult.currentChangePct.toFixed(2)} | ` +
                `Birikim: %${oiAccumulation.toFixed(1)} | ` +
                `Hacim: ${volumeSurge.toFixed(1)}x | ` +
                `Box: %${compression.boxWidthPct.toFixed(1)} | ` +
                `Skor: ${score}`
            );
        } catch (error) {
            warnOnce(
                `Sinyal analizi başarısız (${candidate.symbol})`,
                error
            );
        }

        await sleep(CFG.OI_QUERY_DELAY_MS);
    }

    console.log(
        `📊 OI birikimi: ${oiBuildCount} | ` +
        `Sıkışma: ${compressionCount} | ` +
        `Breakout: ${breakoutCount} | ` +
        `Hacim: ${volumeCount} | ` +
        `Sinyal: ${signalCount}`
    );

    return signalCount;
}

function classifySignal(signal, currentPrice, ageMs) {
    const isLong = signal.type === 'LONG';

    signal.maxPrice = Math.max(
        signal.maxPrice || signal.entryPrice,
        currentPrice
    );

    signal.minPrice = Math.min(
        signal.minPrice || signal.entryPrice,
        currentPrice
    );

    signal.mfe = isLong
        ? ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100
        : ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;

    signal.mae = isLong
        ? ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100
        : ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;

    const hitStop = isLong
        ? currentPrice <= signal.stop
        : currentPrice >= signal.stop;

    const hitTp2 = isLong
        ? currentPrice >= signal.tp2
        : currentPrice <= signal.tp2;

    const hitTp1 = isLong
        ? currentPrice >= signal.tp1
        : currentPrice <= signal.tp1;

    const distancePct = (
        Math.abs(currentPrice - signal.entryPrice) /
        signal.entryPrice
    ) * 100;

    if (hitStop) {
        return {
            status: '🛑 STOP',
            statusClass: 'status-stop',
            cardState: 'CLOSED',
            distancePct
        };
    }

    if (hitTp2) {
        return {
            status: '✅ TP2',
            statusClass: 'status-tp',
            cardState: 'CLOSED',
            distancePct
        };
    }

    if (hitTp1) {
        return {
            status: '✅ TP1',
            statusClass: 'status-tp',
            cardState: 'CLOSED',
            distancePct
        };
    }

    if (
        ageMs <= CFG.FRESH_AGE_MS &&
        distancePct <= CFG.FRESH_DISTANCE_PCT
    ) {
        return {
            status: '🟢 FRESH',
            statusClass: 'status-fresh',
            cardState: 'FRESH',
            distancePct
        };
    }

    if (
        ageMs <= CFG.ACTIONABLE_AGE_MS &&
        distancePct <= CFG.ACTIONABLE_DISTANCE_PCT
    ) {
        return {
            status: '🟡 ACTIONABLE',
            statusClass: 'status-warning',
            cardState: 'VALID',
            distancePct
        };
    }

    if (
        ageMs <= CFG.LATE_AGE_MS &&
        distancePct <= CFG.LATE_DISTANCE_PCT
    ) {
        return {
            status: '🟠 LATE',
            statusClass: 'status-late',
            cardState: 'MISSED',
            distancePct
        };
    }

    return {
        status: '🔴 EXTENDED',
        statusClass: 'status-missed',
        cardState: 'MISSED',
        distancePct
    };
}

async function updateSignalLifecycle() {
    if (isUpdatingSignals) return false;

    isUpdatingSignals = true;

    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        const retainedSignals = [];

        for (const signal of activeSignals) {
            const ageMs = now - signal.timestamp;

            if (ageMs > CFG.SIGNAL_TTL_MS) continue;

            if (signal.cardState === 'CLOSED') {
                retainedSignals.push(signal);
                continue;
            }

            const currentPrice = n(tickers[signal.symbol]?.last);

            if (currentPrice <= 0) {
                retainedSignals.push(signal);
                continue;
            }

            const state = classifySignal(signal, currentPrice, ageMs);

            signal.currentPrice = currentPrice;
            signal.ageMin = (ageMs / 60000).toFixed(1);
            signal.distancePct = state.distancePct.toFixed(3);
            signal.status = state.status;
            signal.statusClass = state.statusClass;
            signal.cardState = state.cardState;

            retainedSignals.push(signal);
        }

        activeSignals = retainedSignals.slice(0, CFG.MAX_STORED_SIGNALS);

        return true;
    } catch (error) {
        warnOnce('Sinyal yaşam döngüsü güncellenemedi', error);
        return false;
    } finally {
        isUpdatingSignals = false;
    }
}

async function runScanner() {
    if (isScanning) return;

    isScanning = true;

    console.log(
        `\n[${new Date().toLocaleTimeString()}] FLOW IGNITION V5 Tarama...`
    );

    try {
        await updateSignalLifecycle();
        pruneOIHistory();

        const candidates = await preScan();

        if (candidates.length > 0) {
            await scanAndAnalyze(candidates);
        }
    } catch (error) {
        console.error('Tarama Hatası:', error.message);
    } finally {
        isScanning = false;
        broadcast();
    }
}

function broadcast() {
    const payload = JSON.stringify({
        type: 'snapshot',
        data: getSnapshot()
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(payload);
            } catch {}
        }
    });
}

wss.on('connection', ws => {
    ws.on('error', error => {
        warnOnce('WebSocket istemcisi hata verdi', error);
    });

    try {
        ws.send(JSON.stringify({
            type: 'snapshot',
            data: getSnapshot()
        }));
    } catch (error) {
        warnOnce('WebSocket ilk görüntüsü gönderilemedi', error);
    }
});

app.get('/api/signals', (req, res) => {
    res.json({
        success: true,
        count: activeSignals.length,
        ...getSnapshot()
    });
});

app.get('/api/chart', async (req, res) => {
    try {
        if (isRateLimited(req)) {
            return res.status(429).json({
                success: false,
                error: 'Çok fazla grafik isteği. Lütfen bir dakika bekleyin.'
            });
        }

        const symbol = typeof req.query.symbol === 'string'
            ? req.query.symbol.trim()
            : 'BTC/USDT:USDT';

        const timeframe = typeof req.query.timeframe === 'string'
            ? req.query.timeframe
            : '15m';

        const market = exchange.markets?.[symbol];

        if (!VALID_CHART_TIMEFRAMES.has(timeframe)) {
            return res.status(400).json({
                success: false,
                error: 'Desteklenmeyen zaman aralığı.'
            });
        }

        if (!market || !market.swap || market.quote !== 'USDT') {
            return res.status(400).json({
                success: false,
                error: 'Geçersiz veya desteklenmeyen sembol.'
            });
        }

        const candles = await getCandles(
            symbol,
            timeframe,
            CFG.CHART_LIMIT
        );

        if (!candles.length) {
            return res.status(502).json({
                success: false,
                error: 'Grafik verisi şu anda alınamadı.'
            });
        }

        const signal = activeSignals.find(item => item.symbol === symbol) || null;

        res.json({
            success: true,
            symbol,
            timeframe,
            candles,
            signal
        });
    } catch (error) {
        warnOnce('Grafik API isteği başarısız', error);

        res.status(500).json({
            success: false,
            error: 'Beklenmeyen bir sunucu hatası oluştu.'
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        scanning: isScanning,
        signals: activeSignals.length,
        now: new Date().toISOString()
    });
});

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FLOW IGNITION V5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh}
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
.signal-card.long{border-left:4px solid #13dba0}
.signal-card.short{border-left:4px solid #ff5570}
.signal-card.fresh{box-shadow:0 0 20px rgba(19,219,160,.15)}
.signal-card.missed{opacity:.35;filter:grayscale(60%)}
.signal-card.closed{opacity:.5}
.signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.signal-coin{font-size:15px;font-weight:900;color:#e2e8f0}
.signal-badge{font-size:9px;padding:3px 10px;border-radius:15px;font-weight:900}
.badge-long{background:#0d3d2a;color:#13dba0}
.badge-short{background:#421d28;color:#ff5570}
.strength-badge{display:inline-block;font-size:8px;padding:2px 8px;border-radius:4px;margin-top:4px;font-weight:bold}
.strength-ultra{background:#1a0d3d;color:#a78bfa;border:1px solid #a78bfa;animation:pulse 1s infinite}
.strength-high{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.strength-good{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee}
.strength-normal{background:#1e293b;color:#94a3b8;border:1px solid #64748b}
.signal-price{font-size:18px;font-weight:900;margin:5px 0;color:#f1f5f9}
.signal-scenario{font-size:9px;color:#94a3b8;margin-top:4px}
.signal-info{display:flex;gap:8px;font-size:8px;color:#94a3b8;margin-top:5px;flex-wrap:wrap}
.signal-info b{color:#e2e8f0}
.signal-status{margin-top:8px;padding:6px;border-radius:5px;font-size:10px;font-weight:bold;text-align:center}
.status-fresh{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.status-warning{background:#3d2d0d;color:#fbbf24;border:1px solid #fbbf24}
.status-late{background:#3d1d0d;color:#fb923c;border:1px solid #fb923c}
.status-missed{background:#2d1d1d;color:#ff5570;border:1px solid #ff5570}
.status-stop{background:#421d28;color:#ff5570;border:1px solid #ff5570}
.status-tp{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee}
.chart-panel{background:#0b111b;display:flex;flex-direction:column;padding:15px;min-width:0}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.chart-title{font-size:16px;font-weight:900;color:#13dba0}
.tf-buttons{display:flex;gap:5px}
.tf-btn{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 10px;font-size:9px;cursor:pointer}
.tf-btn.active{color:#13dba0;border-color:#13dba0}
.chart-container{flex:1;min-height:0;position:relative}
canvas{width:100%;height:100%;display:block}
.empty{text-align:center;color:#64748b;font-size:14px;padding:40px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@media(max-width:800px){
body{overflow:auto}
.app{grid-template-columns:1fr;grid-template-rows:minmax(280px,45vh) minmax(420px,55vh)}
.signal-panel{height:auto;border-right:0;border-bottom:1px solid #1a2533}
.chart-panel{min-height:420px;padding:10px}
}
</style>
</head>
<body>
<div class="app">
    <div class="signal-panel">
        <div class="panel-header">
            <div class="panel-title">FLOW IGNITION V5</div>
            <div class="panel-sub">Sıkışma + OI Şoku + Ateşleme</div>
        </div>

        <div class="panel-stats">
            <div class="panel-stat"><b id="st-total">0</b><span>Sinyal</span></div>
            <div class="panel-stat"><b id="st-fresh">0</b><span>Fresh</span></div>
            <div class="panel-stat"><b id="st-actionable">0</b><span>Uygun</span></div>
        </div>

        <div class="signal-list" id="signals">
            <div class="empty">Taranıyor...</div>
        </div>
    </div>

    <div class="chart-panel">
        <div class="chart-header">
            <div class="chart-title" id="chartTitle">Sinyal seçin</div>

            <div class="tf-buttons">
                <button class="tf-btn active" data-tf="15m">15M</button>
                <button class="tf-btn" data-tf="1h">1H</button>
                <button class="tf-btn" data-tf="4h">4H</button>
            </div>
        </div>

        <div class="chart-container">
            <canvas id="chartCanvas"></canvas>
        </div>
    </div>
</div>

<script>
var allSignals = [];
var selectedSymbol = null;
var selectedTf = '15m';
var chartCandles = [];
var currentSignal = null;
var chartRequestId = 0;
var socketConnected = false;

function fmtPrice(value) {
    var number = Number(value);

    if (!Number.isFinite(number)) return '-';
    if (number >= 1000) return number.toFixed(2);
    if (number >= 100) return number.toFixed(3);
    if (number >= 1) return number.toFixed(5);

    return number.toFixed(8);
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(character) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character];
    });
}

function selectSignal(symbol) {
    selectedSymbol = symbol;

    currentSignal = allSignals.find(function(signal) {
        return signal.symbol === symbol;
    }) || null;

    document.querySelectorAll('.signal-card').forEach(function(card) {
        card.classList.remove('selected');

        if (card.getAttribute('data-symbol') === symbol) {
            card.classList.add('selected');
        }
    });

    document.getElementById('chartTitle').textContent =
        symbol.replace(':USDT', '') + ' - ' + selectedTf.toUpperCase();

    loadChart();
}

function render(data) {
    allSignals = Array.isArray(data.signals) ? data.signals : [];

    document.getElementById('st-total').textContent = allSignals.length;
    document.getElementById('st-fresh').textContent = allSignals.filter(function(signal) {
        return signal.cardState === 'FRESH';
    }).length;

    document.getElementById('st-actionable').textContent = allSignals.filter(function(signal) {
        return signal.cardState === 'VALID';
    }).length;

    var container = document.getElementById('signals');

    if (!allSignals.length) {
        selectedSymbol = null;
        currentSignal = null;
        chartCandles = [];
        chartRequestId++;

        container.innerHTML = '<div class="empty">Aktif sinyal yok...</div>';

        drawChart();
        return;
    }

    container.innerHTML = allSignals.map(function(signal) {
        var isLong = signal.type === 'LONG';

        var cardClass = signal.cardState === 'FRESH'
            ? 'fresh'
            : signal.cardState === 'MISSED'
                ? 'missed'
                : signal.cardState === 'CLOSED'
                    ? 'closed'
                    : '';

        var strengthClass = [
            'strength-ultra',
            'strength-high',
            'strength-good',
            'strength-normal'
        ].indexOf(signal.strengthClass) !== -1
            ? signal.strengthClass
            : 'strength-normal';

        var statusClass = [
            'status-fresh',
            'status-warning',
            'status-late',
            'status-missed',
            'status-stop',
            'status-tp'
        ].indexOf(signal.statusClass) !== -1
            ? signal.statusClass
            : 'status-missed';

        var symbol = escapeHtml(signal.symbol);

        if (selectedSymbol === signal.symbol) {
            cardClass += ' selected';
        }

        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '" data-symbol="' + symbol + '">' +
            '<div class="signal-top">' +
                '<div class="signal-coin">' + symbol.replace(':USDT', '') + '</div>' +
                '<div class="signal-badge ' + (isLong ? 'badge-long' : 'badge-short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
            '</div>' +
            '<div class="strength-badge ' + strengthClass + '">' + escapeHtml(signal.strength) + '</div>' +
            '<div class="signal-price">' + escapeHtml(fmtPrice(signal.currentPrice)) + '</div>' +
            '<div class="signal-scenario">' + escapeHtml(signal.scenario) + ' - ' + escapeHtml(signal.scenarioDesc) + '</div>' +
            '<div class="signal-info">' +
                '<span>OI Z: <b>' + escapeHtml(signal.oiZScore) + '</b></span>' +
                '<span>ΔOI: <b>%' + escapeHtml(signal.oiChangePct) + '</b></span>' +
                '<span>Birikim: <b>%' + escapeHtml(signal.oiAccumulation) + '</b></span>' +
                '<span>Hacim: <b>' + escapeHtml(signal.volumeSurgeRatio) + 'x</b></span>' +
                '<span>Box: <b>%' + escapeHtml(signal.boxWidthPct) + '</b></span>' +
                '<span>' + escapeHtml(signal.ageMin) + ' dk</span>' +
            '</div>' +
            '<div class="signal-status ' + statusClass + '">' + escapeHtml(signal.status) + '</div>' +
        '</div>';
    }).join('');

    document.querySelectorAll('.signal-card').forEach(function(card) {
        card.addEventListener('click', function() {
            var symbol = this.getAttribute('data-symbol');

            if (symbol) {
                selectSignal(symbol);
            }
        });
    });

    if (selectedSymbol) {
        currentSignal = allSignals.find(function(signal) {
            return signal.symbol === selectedSymbol;
        }) || null;
    }
}

async function loadChart() {
    if (!selectedSymbol) return;

    var requestId = ++chartRequestId;
    var requestedSymbol = selectedSymbol;
    var requestedTf = selectedTf;

    try {
        var response = await fetch(
            '/api/chart?symbol=' + encodeURIComponent(requestedSymbol) +
            '&timeframe=' + encodeURIComponent(requestedTf)
        );

        var data = await response.json();

        if (
            requestId === chartRequestId &&
            requestedSymbol === selectedSymbol &&
            requestedTf === selectedTf &&
            data.success
        ) {
            chartCandles = data.candles || [];
            drawChart();
        }
    } catch {}
}

function drawChart() {
    var canvas = document.getElementById('chartCanvas');

    if (!canvas) return;

    var parent = canvas.parentElement;
    var width = Math.max(300, parent.clientWidth);
    var height = Math.max(300, parent.clientHeight);
    var dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    var context = canvas.getContext('2d');

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = '#070b11';
    context.fillRect(0, 0, width, height);

    var visible = chartCandles.slice(-60);

    if (visible.length < 2) {
        context.fillStyle = '#64748b';
        context.font = '14px Arial';
        context.fillText('Grafik verisi bekleniyor...', 20, 40);
        return;
    }

    var minPrice = Math.min.apply(Math, visible.map(function(candle) {
        return candle[3];
    }));

    var maxPrice = Math.max.apply(Math, visible.map(function(candle) {
        return candle[2];
    }));

    if (currentSignal) {
        [
            currentSignal.entryPrice,
            currentSignal.stop,
            currentSignal.tp1,
            currentSignal.tp2
        ].forEach(function(price) {
            if (price && price < minPrice) minPrice = price;
            if (price && price > maxPrice) maxPrice = price;
        });
    }

    if (maxPrice === minPrice) {
        var spread = maxPrice === 0 ? 1 : Math.abs(maxPrice) * 0.01;

        minPrice -= spread;
        maxPrice += spread;
    }

    var padding = (maxPrice - minPrice) * 0.08;

    minPrice -= padding;
    maxPrice += padding;

    var left = 40;
    var right = 100;
    var top = 15;
    var bottom = 15;

    var plotWidth = width - left - right;
    var plotHeight = height - top - bottom;

    function Y(price) {
        return top + (maxPrice - price) / (maxPrice - minPrice) * plotHeight;
    }

    function X(index) {
        return left + index * plotWidth / (visible.length - 1);
    }

    context.strokeStyle = '#182330';

    for (var grid = 0; grid <= 4; grid++) {
        var gridY = top + plotHeight * grid / 4;

        context.beginPath();
        context.moveTo(left, gridY);
        context.lineTo(width - right, gridY);
        context.stroke();

        context.fillStyle = '#607083';
        context.font = '8px Arial';

        context.fillText(
            fmtPrice(maxPrice - (maxPrice - minPrice) * grid / 4),
            3,
            gridY + 3
        );
    }

    var step = plotWidth / (visible.length - 1);
    var bodyWidth = Math.max(2, Math.min(8, step * 0.6));

    visible.forEach(function(candle, index) {
        var x = X(index);
        var isUp = candle[4] >= candle[1];
        var color = isUp ? '#13e0a2' : '#ff4d6d';

        context.strokeStyle = color;
        context.fillStyle = color;

        context.beginPath();
        context.moveTo(x, Y(candle[2]));
        context.lineTo(x, Y(candle[3]));
        context.stroke();

        var openY = Y(candle[1]);
        var closeY = Y(candle[4]);

        context.fillRect(
            x - bodyWidth / 2,
            Math.min(openY, closeY),
            bodyWidth,
            Math.max(1, Math.abs(closeY - openY))
        );
    });

    if (currentSignal) {
        drawLevel(context, currentSignal.entryPrice, '#13dba0', 'GİRİŞ', left, width - right, Y);
        drawLevel(context, currentSignal.stop, '#ff5570', 'STOP', left, width - right, Y);
        drawLevel(context, currentSignal.tp1, '#55a7ff', 'TP1', left, width - right, Y);
        drawLevel(context, currentSignal.tp2, '#55a7ff', 'TP2', left, width - right, Y);
    }
}

function drawLevel(context, price, color, label, left, right, Y) {
    if (!price) return;

    var y = Y(price);

    context.strokeStyle = color;
    context.setLineDash([5, 5]);
    context.lineWidth = 1.5;

    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();

    context.setLineDash([]);
    context.fillStyle = color;
    context.font = 'bold 9px Arial';
    context.fillText(label + ' ' + fmtPrice(price), right + 5, y + 3);
}

document.querySelectorAll('.tf-btn').forEach(function(button) {
    button.addEventListener('click', function() {
        document.querySelectorAll('.tf-btn').forEach(function(item) {
            item.classList.remove('active');
        });

        button.classList.add('active');
        selectedTf = button.getAttribute('data-tf');

        if (selectedSymbol) {
            document.getElementById('chartTitle').textContent =
                selectedSymbol.replace(':USDT', '') +
                ' - ' +
                selectedTf.toUpperCase();

            loadChart();
        }
    });
});

function connect() {
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket = new WebSocket(protocol + location.host);

    socket.onopen = function() {
        socketConnected = true;
    };

    socket.onmessage = function(event) {
        try {
            var message = JSON.parse(event.data);

            if (message.type === 'snapshot') {
                render(message.data);
            }
        } catch {}
    };

    socket.onerror = function() {
        socket.close();
    };

    socket.onclose = function() {
        socketConnected = false;
        setTimeout(connect, 3000);
    };
}

connect();

setInterval(function() {
    if (socketConnected) return;

    fetch('/api/signals', { cache: 'no-store' })
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.success) {
                render({ signals: data.signals });
            }
        })
        .catch(function() {});
}, 3000);

window.addEventListener('resize', drawChart);
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

async function startScanner() {
    if (isShuttingDown || scannerTimer) return;

    try {
        await exchange.loadMarkets();
        console.log('MARKETLER YÜKLENDİ');
    } catch (error) {
        console.error(
            'Marketler yüklenemedi; 30 saniye sonra yeniden denenecek:',
            error.message
        );

        setTimeout(startScanner, 30 * 1000);
        return;
    }

    void runScanner();

    scannerTimer = setInterval(
        runScanner,
        CFG.SCAN_INTERVAL_MS
    );

    lifecycleTimer = setInterval(async () => {
        if (await updateSignalLifecycle()) {
            broadcast();
        }
    }, CFG.SIGNAL_UPDATE_MS);
}

async function shutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;

    console.log(`${signal} alındı; servis güvenle kapatılıyor...`);

    clearInterval(scannerTimer);
    clearInterval(lifecycleTimer);

    wss.clients.forEach(client => {
        client.close(1001, 'Sunucu kapanıyor');
    });

    wss.close();

    server.close(async () => {
        try {
            await exchange.close();
        } catch (error) {
            warnOnce('Borsa bağlantısı kapatılamadı', error);
        }

        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10 * 1000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================');
    console.log('FLOW IGNITION V5');
    console.log('Sıkışma + OI Şoku + Ateşleme');
    console.log('==============================================');

    void startScanner();
});

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});
