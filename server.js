'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json());

// ========================= CONFIG =========================
const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 100,
    
    // V14.3.3 Tarama Ayarları
    PRESCAN_INTERVAL: 5 * 60 * 1000,
    PRESCAN_MIN_24H_VOLUME_USDT: 500000,
    API_DELAY_MS: 100,
    
    TIMEFRAME_1H: '1h',
    TIMEFRAME_2H: '2h',
    TIMEFRAME_4H: '4h',
    
    BREAKOUT_BASE_ATR_PERIOD: 14,
    BREAKOUT_BASE_RSI_PERIOD: 14,
    BREAKOUT_BASE_BB_PERIOD: 20,
    BREAKOUT_BASE_BB_STDDEV: 2,
    BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK: 5.0,
    
    BRK1H_LOOKBACK_PERIOD: 50,
    BRK1H_BUFFER_PERCENT: 0.1,
    BRK1H_VOLUME_MULTIPLIER: 1.2,
    BRK1H_SL_ATR_MULTIPLIER: 2.0,
    BRK1H_RSI_LONG_THRESHOLD: 55,
    BRK1H_RSI_SHORT_THRESHOLD: 45,
    BREAKOUT_SCAN_INTERVAL_1H: 15 * 60 * 1000,
    
    BRK2H_LOOKBACK_PERIOD: 50,
    BRK2H_BUFFER_PERCENT: 0.1,
    BRK2H_VOLUME_MULTIPLIER: 1.2,
    BRK2H_SL_ATR_MULTIPLIER: 2.0,
    BRK2H_RSI_LONG_THRESHOLD: 55,
    BRK2H_RSI_SHORT_THRESHOLD: 45,
    BREAKOUT_SCAN_INTERVAL_2H: 30 * 60 * 1000,
    
    BRK4H_LOOKBACK_PERIOD: 40,
    BRK4H_BUFFER_PERCENT: 0.15,
    BRK4H_VOLUME_MULTIPLIER: 1.1,
    BRK4H_SL_ATR_MULTIPLIER: 2.2,
    BRK4H_RSI_LONG_THRESHOLD: 55,
    BRK4H_RSI_SHORT_THRESHOLD: 45,
    BREAKOUT_SCAN_INTERVAL_4H: 60 * 60 * 1000,
    
    MOMENTUM_1H_TIMEFRAME: '1h',
    MOMENTUM_1H_LOOKBACK: 24,
    MOMENTUM_1H_SCAN_INTERVAL: 10 * 60 * 1000,
    MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER: 3.0,
    MOMENTUM_1H_PRICE_SPIKE_PERCENT: 1.5,
    MOMENTUM_1H_COOLDOWN_MS: 30 * 60 * 1000,
    
    SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,
    MARKET_FILTER_TIMEFRAME: '4h',
    MARKET_FILTER_EMA_PERIOD: 200,
    
    // Frontend'e sinyal gönderme
    SIGNAL_TTL: 30 * 60 * 1000,
    MAX_SIGNALS: 50,
    
    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 3,
    REQUEST_DELAY: 150,
    CACHE_TTL: { '15m': 30 * 1000, '1h': 60 * 1000, '2h': 2 * 60 * 1000, '4h': 5 * 60 * 1000 },
    CHART: 160
};

// ========================= EXCHANGE =========================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ========================= STATE =========================
const STATE = {
    markets: [],
    marketMap: new Map(),
    universe: [],
    candidates: [],
    deep: [],
    signals: new Map(),
    cooldowns: new Map(),
    signalCooldowns: {},
    momentumCooldowns: {},
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: { label: 'YATAY / KARIŞIK', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' },
    stats: { universe: 0, candidates: 0, deep: 0, analyzed: 0, signals: 0, errors: 0, longSignals: 0, shortSignals: 0, activeTrades: 0 },
    signalHistory: [],
    performance: { wins: 0, losses: 0, winRate: 0, totalR: 0, grossProfitR: 0, grossLossR: 0 },
    paperTrades: []
};

// ========================= CACHE =========================
const candleCache = new Map();
const requestQueue = [];
let isProcessingQueue = false;

// ========================= HELPERS =========================
function n(v, d = 6) { const x = Number(v); return Number.isFinite(x) ? Number(x.toFixed(d)) : 0; }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function closed(c) { return Array.isArray(c) && c.length > 1 ? c.slice(0, -1) : (c || []); }
function cleanSymbol(s) {
    let x = String(s || '').toUpperCase().replace('/USDT:USDT', '').replace('/USDT', '').replace(':USDT', '');
    if (x.endsWith('USDT')) x = x.slice(0, -4);
    return x + 'USDT';
}
function fmt(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '-';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);
    return x.toFixed(10);
}
function formatVolume(volume) {
    if (volume >= 1000000000) return (volume / 1000000000).toFixed(2) + 'B';
    if (volume >= 1000000) return (volume / 1000000).toFixed(1) + 'M';
    if (volume >= 1000) return (volume / 1000).toFixed(1) + 'K';
    return volume.toFixed(0);
}
function percent(v, base) { return base ? (v / base) * 100 : 0; }

// ========================= MARKET =========================
function findMarket(symbol) {
    const wanted = cleanSymbol(symbol);
    if (!STATE.markets.length) return null;
    return STATE.markets.find(m => cleanSymbol(m.symbol) === wanted) || null;
}
async function loadMarkets() {
    const markets = await exchange.loadMarkets(true);
    STATE.markets = Object.values(markets).filter(m =>
        m && m.active !== false && m.swap === true && m.linear === true &&
        m.quote === 'USDT' && m.settle === 'USDT'
    );
    STATE.marketMap = new Map(STATE.markets.map(m => [m.symbol, m]));
}
async function loadMarketsWithRetry(maxRetries = 3, delayMs = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        try { await loadMarkets(); return; }
        catch (e) { console.error(`Market yüklenemedi (${i + 1}/${maxRetries}):`, e.message); if (i < maxRetries - 1) await sleep(delayMs); }
    }
    throw new Error('Marketler yüklenemedi');
}

// ========================= RATE LIMIT QUEUE =========================
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const task = requestQueue.shift();
        try { const result = await task.fn(); task.resolve(result); }
        catch (error) { task.reject(error); }
        await sleep(CFG.REQUEST_DELAY);
    }
    isProcessingQueue = false;
}
function queueRequest(fn) {
    return new Promise((resolve, reject) => { requestQueue.push({ fn, resolve, reject }); processQueue(); });
}

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    const ttl = CFG.CACHE_TTL[tf] || 30 * 1000;
    if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
    try {
        const data = await queueRequest(() => exchange.fetchOHLCV(symbol, tf, undefined, limit));
        const cleaned = Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0]) : [];
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (error) {
        console.error(`Mum verisi alınamadı: ${symbol} ${tf} - ${error.message}`);
        if (cached) return cached.data;
        return [];
    }
}

// ========================= TICKERS =========================
async function getTickers() {
    let tickers;
    try { tickers = await queueRequest(() => exchange.fetchTickers()); }
    catch (error) { if (!STATE.universe.length) throw error; return STATE.universe; }
    const rows = [];
    for (const m of STATE.markets) {
        const t = tickers[m.symbol];
        if (!t) continue;
        const last = n(t.last || t.close);
        const volume = n(t.quoteVolume);
        if (!(last > 0) || !(volume > 0)) continue;
        rows.push({
            symbol: m.symbol, price: last, volume, volumeFormatted: formatVolume(volume),
            change: n(t.percentage),
            volumeTier: volume >= 5000000 ? 'HIGH' : volume >= 1000000 ? 'MID' : 'LOW'
        });
    }
    rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, CFG.RADAR);
}

// ========================= İNDİKATÖRLER =========================
function calculateSMA(data, period) {
    if (!data || data.length < period) return null;
    const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevantData.length < period) return null;
    const sum = relevantData.reduce((a, b) => a + b, 0);
    const sma = sum / period;
    return isNaN(sma) ? null : sma;
}

function calculateEMA(closes, period) {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const k = 2 / (period + 1);
    let emaArray = [];
    let firstSma = calculateSMA(closes.slice(0, period), period);
    if (firstSma === null) return null;
    emaArray.push(firstSma);
    for (let i = period; i < closes.length; i++) {
        if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null;
        const prevEma = emaArray[emaArray.length - 1];
        let ema = (closes[i] * k) + (prevEma * (1 - k));
        if (isNaN(ema)) return null;
        emaArray.push(ema);
    }
    return emaArray[emaArray.length - 1];
}

function calculateStdDev(data, period) {
    if (!data || data.length < period) return null;
    const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevantData.length < period) return null;
    const mean = calculateSMA(relevantData, period);
    if (mean === null) return null;
    const squareDiffs = relevantData.map(value => Math.pow(value - mean, 2));
    const sumSquareDiffs = squareDiffs.reduce((a, b) => a + b, 0);
    const variance = sumSquareDiffs / period;
    if (isNaN(variance) || variance < 0) return null;
    return Math.sqrt(variance);
}

function calculateBollingerBands(closes, period, stdDevMultiplier) {
    if (!closes || closes.length < period) return null;
    const middleBand = calculateSMA(closes.slice(-period), period);
    const stdDev = calculateStdDev(closes.slice(-period), period);
    if (middleBand === null || stdDev === null || stdDev < 0) return null;
    const upperBand = middleBand + (stdDev * stdDevMultiplier);
    const lowerBand = middleBand - (stdDev * stdDevMultiplier);
    if (isNaN(upperBand) || isNaN(lowerBand)) return null;
    return { upperBand, middleBand, lowerBand };
}

function calculateRSI(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        gains.push(diff >= 0 ? diff : 0);
        losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    if (gains.length < period) return null;
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return null;
    let trueRanges = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2], low = ohlcv[i][3], prevClose = ohlcv[i-1][4];
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trueRanges.push(tr);
    }
    if (trueRanges.length < period) return null;
    return calculateSMA(trueRanges.slice(-period), period);
}

function calculateFibonacciExtension(ohlcv, period, signal) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevantData = ohlcv.slice(-period);
    const lows = relevantData.map(c => c[3]).filter(v => Number.isFinite(v));
    const highs = relevantData.map(c => c[2]).filter(v => Number.isFinite(v));
    if (!lows.length || !highs.length) return null;
    const lowestLow = Math.min(...lows);
    const highestHigh = Math.max(...highs);
    const range = highestHigh - lowestLow;
    if (range <= 0) return null;
    return signal === 'LONG' ? highestHigh + (range * 0.618) : lowestLow - (range * 0.618);
}

// ========================= MARKET CONDITION =========================
async function checkMarketCondition(symbol) {
    const ohlcv = await getCandles(symbol, CFG.MARKET_FILTER_TIMEFRAME, CFG.MARKET_FILTER_EMA_PERIOD + 50);
    if (!ohlcv || ohlcv.length < CFG.MARKET_FILTER_EMA_PERIOD) return 'UNKNOWN';
    const closes = ohlcv.map(c => c[4]);
    const ema200 = calculateEMA(closes, CFG.MARKET_FILTER_EMA_PERIOD);
    if (ema200 === null) return 'UNKNOWN';
    const lastClose = closes[closes.length - 1];
    if (lastClose > ema200) return 'UPTREND';
    if (lastClose < ema200) return 'DOWNTREND';
    return 'SIDEWAYS';
}

// ========================= TAKTİKSEL ANALİZ =========================
function generateTacticalAnalysis(data) {
    const { signal, anaTrend, rsi, hacimMultiplier, bbWidth, timeframe } = data;
    let analysis = "";
    let confidenceLevel = 40;

    if (signal === 'LONG' && anaTrend === 'UPTREND') { analysis += "✅ Trend Dostu: Fiyat ana yükseliş trendinde. "; confidenceLevel += 20; }
    else if (signal === 'SHORT' && anaTrend === 'DOWNTREND') { analysis += "✅ Trend Dostu: Fiyat ana düşüş trendinde. "; confidenceLevel += 20; }
    else if ((signal === 'LONG' && anaTrend === 'DOWNTREND') || (signal === 'SHORT' && anaTrend === 'UPTREND')) { analysis += "⚠️ Yüksek Risk (Ters Trend): Akıntıya karşı. "; confidenceLevel -= 30; }
    else { analysis += "ℹ️ Yatay Piyasa: Yön belirsiz. "; }

    if (hacimMultiplier > 3.5) { analysis += "🐋 Balina Teyitli. "; confidenceLevel += 25; }
    else if (hacimMultiplier > 1.8) { analysis += "👍 Hacim Teyitli. "; confidenceLevel += 15; }
    else { analysis += "👎 Zayıf Hacim. "; confidenceLevel -= 20; }

    if (signal === 'LONG' && rsi > 78) { analysis += "🥵 Aşırı Şişmiş. "; confidenceLevel -= 15; }
    else if (signal === 'SHORT' && rsi < 22) { analysis += "🥶 Aşırı Satılmış. "; confidenceLevel -= 15; }
    else { analysis += "💪 Momentum İyi. "; confidenceLevel += 5; }

    if (bbWidth < 2.5) { analysis += "⏳ Sıkışma Patlaması. "; confidenceLevel += 5; }

    const finalConfidence = Math.min(Math.max(confidenceLevel, 10), 99);
    return { text: analysis, confidence: finalConfidence.toFixed(0) };
}

// ========================= KIRILIM STRATEJİSİ =========================
async function analyzeBreakoutStrategy(symbol, config, isManual = false) {
    const { timeframe, lookbackPeriod, bufferPercent, volumeMultiplier, atrPeriod, slAtrMultiplier, rsiPeriod, rsiLongThreshold, rsiShortThreshold, strategyIdSuffix, strategyDisplayName } = config;
    
    try {
        const cleanSym = cleanSymbol(symbol);
        const cooldownKey = `${cleanSym}-${strategyIdSuffix}`;
        
        const cooldownTime = STATE.cooldowns.get(cooldownKey);
        if (cooldownTime && Date.now() - cooldownTime < CFG.SIGNAL_COOLDOWN_MS) return null;
        
        const existingSignal = [...STATE.signals.values()].find(s => s.symbol === cleanSym && s.strategyType === strategyIdSuffix);
        if (existingSignal && !isManual) return null;
        
        const minRequiredCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1, CFG.BREAKOUT_BASE_BB_PERIOD + 1);
        const candlesToFetch = minRequiredCandles + 10;
        
        const ohlcv = await getCandles(symbol, timeframe, candlesToFetch);
        if (!ohlcv || ohlcv.length < minRequiredCandles) return null;
        
        const overallTrend = await checkMarketCondition(symbol);
        
        const lastCandle = ohlcv[ohlcv.length - 1];
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1);
        if (!lastCandle || lookbackCandles.length < lookbackPeriod) return null;
        
        const lastClosePrice = lastCandle[4];
        const lastVolume = lastCandle[5];
        
        let highestHigh = 0, lowestLow = Infinity, volumeSum = 0, validVolumeCount = 0;
        for (const candle of lookbackCandles) {
            const high = candle[2], low = candle[3], volume = candle[5];
            if (high > highestHigh) highestHigh = high;
            if (low < lowestLow) lowestLow = low;
            if (typeof volume === 'number' && !isNaN(volume) && volume >= 0) {
                volumeSum += volume;
                validVolumeCount++;
            }
        }
        
        if (highestHigh <= lowestLow || validVolumeCount === 0) return null;
        const avgVolume = volumeSum / validVolumeCount;
        
        const allCloses = ohlcv.map(c => c[4]);
        const atr = calculateATR(ohlcv, atrPeriod);
        const rsi = calculateRSI(allCloses, rsiPeriod);
        const bb = calculateBollingerBands(allCloses, CFG.BREAKOUT_BASE_BB_PERIOD, CFG.BREAKOUT_BASE_BB_STDDEV);
        
        if (atr === null || rsi === null || bb === null) return null;
        
        const bbWidth = (bb.middleBand > 0) ? ((bb.upperBand - bb.lowerBand) / bb.middleBand) * 100 : 0;
        
        let signal = 'WAIT';
        let reason = '';
        let isFiltered = false;
        
        const breakoutBufferHigh = highestHigh * (1 + bufferPercent / 100);
        const breakoutBufferLow = lowestLow * (1 - bufferPercent / 100);
        
        if (lastClosePrice > breakoutBufferHigh) {
            signal = 'LONG';
            reason = `${strategyDisplayName} Direnç Kırılımı`;
        } else if (lastClosePrice < breakoutBufferLow) {
            signal = 'SHORT';
            reason = `${strategyDisplayName} Destek Kırılımı`;
        }
        
        if (signal === 'WAIT') return null;
        
        // Trend Filtresi
        if (overallTrend === 'UPTREND' && signal === 'SHORT') return null;
        if (overallTrend === 'DOWNTREND' && signal === 'LONG') return null;
        
        // RSI Filtresi
        if (signal === 'LONG' && rsi < rsiLongThreshold) return null;
        if (signal === 'SHORT' && rsi > rsiShortThreshold) return null;
        
        // Hacim Filtresi
        const hacimMultiplier = avgVolume > 0 ? lastVolume / avgVolume : 0;
        if (hacimMultiplier < volumeMultiplier) return null;
        
        // Taktiksel Analiz
        const analysisData = { signal, anaTrend: overallTrend, rsi, hacimMultiplier, bbWidth, timeframe };
        const tacticalResult = generateTacticalAnalysis(analysisData);
        
        // TP/SL
        let takeProfit, stopLoss;
        const dynamicTP = calculateFibonacciExtension(ohlcv, lookbackPeriod, signal);
        
        if (signal === 'LONG') {
            takeProfit = dynamicTP || lastClosePrice * (1 + CFG.BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100);
            stopLoss = lastClosePrice - (atr * slAtrMultiplier);
        } else {
            takeProfit = dynamicTP || lastClosePrice * (1 - CFG.BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100);
            stopLoss = lastClosePrice + (atr * slAtrMultiplier);
        }
        
        const risk = Math.abs(lastClosePrice - stopLoss);
        const reward = Math.abs(takeProfit - lastClosePrice);
        const rrRatio = risk > 0 ? reward / risk : 0;
        
        if (rrRatio < 0.5) return null;
        
        const signalObj = {
            id: `${cleanSym}-${signal}-${Date.now()}-${strategyIdSuffix}`,
            symbol: cleanSym,
            marketSymbol: symbol,
            direction: signal,
            signal: signal,
            strategyType: strategyIdSuffix,
            strategyDisplayName: strategyDisplayName,
            confidence: parseInt(tacticalResult.confidence),
            score: parseInt(tacticalResult.confidence),
            entry: lastClosePrice,
            entryPrice: lastClosePrice.toFixed(4),
            giris: lastClosePrice,
            TP: takeProfit.toFixed(4),
            tp1: takeProfit,
            tp2: takeProfit * 1.5,
            tp3: takeProfit * 2,
            SL: stopLoss.toFixed(4),
            stop: stopLoss,
            stopLoss: stopLoss,
            RR: rrRatio.toFixed(2),
            rr: rrRatio,
            riskReward: rrRatio.toFixed(2),
            reason: `${reason} | R/R: ${rrRatio.toFixed(2)}`,
            tacticalAnalysis: tacticalResult.text,
            tuyo: tacticalResult.text,
            volumeStatus: `Hacim: ${hacimMultiplier.toFixed(1)}x`,
            volumeFormatted: formatVolume(lastVolume),
            volumeTier: lastVolume > 5000000 ? 'HIGH' : lastVolume > 1000000 ? 'MID' : 'LOW',
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: Date.now(),
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            maeR: null,
            mfeR: null,
            cooldownKey: cooldownKey,
            timeframe: timeframe,
            overallTrend: overallTrend,
            rsi: rsi,
            atr: atr,
            bbWidth: bbWidth,
            hacimMultiplier: hacimMultiplier
        };
        
        STATE.cooldowns.set(cooldownKey, Date.now());
        
        return signalObj;
    } catch (error) {
        console.error(`[${strategyDisplayName} Analiz Hatası (${symbol})]:`, error.message);
        return null;
    }
}

// ========================= MOMENTUM STRATEJİSİ =========================
async function analyzeMomentum1H(symbol, isManual = false) {
    try {
        const cleanSym = cleanSymbol(symbol);
        const cooldownKey = `${cleanSym}-MOMENTUM1H`;
        
        const cooldownTime = STATE.cooldowns.get(cooldownKey);
        if (cooldownTime && Date.now() - cooldownTime < CFG.MOMENTUM_1H_COOLDOWN_MS) return null;
        
        const existingSignal = [...STATE.signals.values()].find(s => s.symbol === cleanSym && s.strategyType === 'MOMENTUM1H');
        if (existingSignal && !isManual) return null;
        
        const overallTrend = await checkMarketCondition(symbol);
        
        const minRequiredCandles = CFG.MOMENTUM_1H_LOOKBACK + 2;
        const ohlcv = await getCandles(symbol, CFG.MOMENTUM_1H_TIMEFRAME, minRequiredCandles + 5);
        if (!ohlcv || ohlcv.length < minRequiredCandles) return null;
        
        const lastCandle = ohlcv[ohlcv.length - 1];
        const prevCandle = ohlcv[ohlcv.length - 2];
        
        const lastClose1h = lastCandle[4];
        const lastVolume1h = lastCandle[5];
        const prevClose1h = prevCandle[4];
        
        const volumeLookback = ohlcv.slice(-(CFG.MOMENTUM_1H_LOOKBACK + 1), -1).map(c => c[5]);
        const avgVolume = avg(volumeLookback);
        if (avgVolume <= 0) return null;
        
        const priceChangePercent = prevClose1h === 0 ? 0 : ((lastClose1h - prevClose1h) / prevClose1h) * 100;
        const hacimMultiplier = lastVolume1h / avgVolume;
        
        let signal = 'WAIT';
        let tacticalAnalysis = '';
        let confidence = '0';
        
        const isPumpCondition = hacimMultiplier >= CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent >= CFG.MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        const isDumpCondition = hacimMultiplier >= CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent <= -CFG.MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        
        if (isPumpCondition && overallTrend !== 'DOWNTREND') {
            signal = 'PUMP';
            confidence = Math.min(95, 65 + (hacimMultiplier - CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5).toFixed(0);
            tacticalAnalysis = `📈 1H Hacim Patlaması: Ortalamanın ${hacimMultiplier.toFixed(1)} katı alım hacmi. Fiyat %${priceChangePercent.toFixed(2)} yükseldi.`;
        } else if (isDumpCondition && overallTrend !== 'UPTREND') {
            signal = 'DUMP';
            confidence = Math.min(95, 65 + (hacimMultiplier - CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5).toFixed(0);
            tacticalAnalysis = `📉 1H Hacim Patlaması: Ortalamanın ${hacimMultiplier.toFixed(1)} katı satım hacmi. Fiyat %${priceChangePercent.toFixed(2)} düştü.`;
        }
        
        if (signal === 'WAIT') return null;
        
        const signalObj = {
            id: `${cleanSym}-${signal}-${Date.now()}-MOMENTUM1H`,
            symbol: cleanSym,
            marketSymbol: symbol,
            direction: signal === 'PUMP' ? 'LONG' : 'SHORT',
            signal: signal,
            strategyType: 'MOMENTUM1H',
            strategyDisplayName: 'Momentum 1H',
            confidence: parseInt(confidence),
            score: parseInt(confidence),
            entry: lastClose1h,
            entryPrice: lastClose1h.toFixed(4),
            giris: lastClose1h,
            TP: '---',
            tp1: lastClose1h,
            tp2: lastClose1h,
            tp3: lastClose1h,
            SL: '---',
            stop: lastClose1h,
            stopLoss: lastClose1h,
            RR: 'N/A',
            rr: 0,
            riskReward: 'N/A',
            reason: `Hacim: ${hacimMultiplier.toFixed(1)}x, Fiyat Değ: ${priceChangePercent.toFixed(2)}%`,
            tacticalAnalysis: tacticalAnalysis,
            tuyo: tacticalAnalysis,
            volumeStatus: `Hacim: ${hacimMultiplier.toFixed(1)}x`,
            volumeFormatted: formatVolume(lastVolume1h),
            volumeTier: lastVolume1h > 5000000 ? 'HIGH' : lastVolume1h > 1000000 ? 'MID' : 'LOW',
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: Date.now(),
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            maeR: null,
            mfeR: null,
            cooldownKey: cooldownKey,
            timeframe: '1h',
            overallTrend: overallTrend,
            rsi: 0,
            atr: 0,
            bbWidth: 0,
            hacimMultiplier: hacimMultiplier
        };
        
        STATE.cooldowns.set(cooldownKey, Date.now());
        
        return signalObj;
    } catch (error) {
        console.error(`[Momentum 1H Analiz Hatası (${symbol})]:`, error.message);
        return null;
    }
}

// ========================= SCAN =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.errors = 0;
    
    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);
        
        const candidates = rows.filter(r => r.volume >= CFG.PRESCAN_MIN_24H_VOLUME_USDT).slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        
        console.log(`\n📡 RADAR: ${STATE.stats.universe} | CANDIDATES: ${candidates.length}`);
        
        const brk4hConfig = { timeframe: CFG.TIMEFRAME_4H, lookbackPeriod: CFG.BRK4H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK4H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK4H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: CFG.BRK4H_SL_ATR_MULTIPLIER, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK4H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK4H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK4H', strategyDisplayName: '4h' };
        const brk2hConfig = { timeframe: CFG.TIMEFRAME_2H, lookbackPeriod: CFG.BRK2H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK2H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK2H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: CFG.BRK2H_SL_ATR_MULTIPLIER, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK2H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' };
        const brk1hConfig = { timeframe: CFG.TIMEFRAME_1H, lookbackPeriod: CFG.BRK1H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK1H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK1H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: CFG.BRK1H_SL_ATR_MULTIPLIER, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK1H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK1H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' };
        
        const deepCandidates = candidates.slice(0, CFG.DEEP);
        STATE.deep = deepCandidates;
        STATE.stats.deep = deepCandidates.length;
        STATE.stats.analyzed = 0;
        
        for (let i = 0; i < deepCandidates.length; i += CFG.CONCURRENCY) {
            const batch = deepCandidates.slice(i, i + CFG.CONCURRENCY);
            await Promise.all(batch.map(async row => {
                try {
                    const signals = [];
                    
                    const s4h = await analyzeBreakoutStrategy(row.symbol, brk4hConfig);
                    if (s4h) signals.push(s4h);
                    
                    const s2h = await analyzeBreakoutStrategy(row.symbol, brk2hConfig);
                    if (s2h) signals.push(s2h);
                    
                    const s1h = await analyzeBreakoutStrategy(row.symbol, brk1hConfig);
                    if (s1h) signals.push(s1h);
                    
                    const sMom = await analyzeMomentum1H(row.symbol);
                    if (sMom) signals.push(sMom);
                    
                    for (const sig of signals) {
                        const existing = STATE.signals.get(sig.id.split('-').slice(0, -1).join('-'));
                        if (!existing) {
                            STATE.signals.set(sig.id, sig);
                        }
                    }
                } catch (e) {
                    STATE.stats.errors++;
                }
                STATE.stats.analyzed++;
            }));
            await sleep(50);
        }
        
        // Sinyal temizliği
        const now = Date.now();
        for (const [id, signal] of STATE.signals) {
            if (now - signal.timestamp > CFG.SIGNAL_TTL) {
                STATE.signals.delete(id);
            }
        }
        
        STATE.lastScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        
        const activeSignals = [...STATE.signals.values()];
        STATE.stats.longSignals = activeSignals.filter(s => s.direction === 'LONG' || s.signal === 'LONG' || s.signal === 'PUMP').length;
        STATE.stats.shortSignals = activeSignals.filter(s => s.direction === 'SHORT' || s.signal === 'SHORT' || s.signal === 'DUMP').length;
        
        console.log(`\n📊 Sinyaller: ${activeSignals.length} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
        
        broadcast();
    } catch (error) {
        STATE.lastError = error.message;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
    }
}

// ========================= MARKET REGIME =========================
function calculateMarketRegime(rows) {
    if (!rows.length) { STATE.market = { label: 'YATAY', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' }; return; }
    let green = 0, red = 0, total = 0;
    for (const r of rows) { if (r.change > 0.5) green++; else if (r.change < -0.5) red++; total += r.change; }
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / rows.length;
    let direction = 'FLAT', label = 'YATAY';
    if (breadth >= 55 && average >= 0.5) { direction = 'LONG'; label = 'POZİTİF'; }
    else if (breadth <= 45 && average <= -0.5) { direction = 'SHORT'; label = 'NEGATİF'; }
    STATE.market = { label, direction, breadth: Number(breadth.toFixed(1)), green, red, average: Number(average.toFixed(2)), btc: 'NEUTRAL', eth: 'NEUTRAL' };
}

// ========================= LIVE SIGNALS =========================
async function updateLiveSignals() {
    if (!STATE.signals.size) return;
    let tickers;
    try { tickers = await queueRequest(() => exchange.fetchTickers()); }
    catch (e) { return; }
    
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) {
            STATE.signals.delete(id);
            continue;
        }
        
        const ticker = tickers[signal.marketSymbol];
        if (!ticker) continue;
        const current = n(ticker.last || ticker.close);
        if (!(current > 0)) continue;
        signal.currentPrice = current;
        
        if (!signal.paperEntry) {
            if (signal.direction === 'LONG' && current <= signal.entry) {
                signal.paperEntry = current;
                signal.entryTime = now;
                signal.entryReady = true;
                signal.status = 'İŞLEM AÇILDI';
            } else if (signal.direction === 'SHORT' && current >= signal.entry) {
                signal.paperEntry = current;
                signal.entryTime = now;
                signal.entryReady = true;
                signal.status = 'İŞLEM AÇILDI';
            } else {
                signal.status = 'GİRİŞ BEKLENİYOR';
            }
        }
        
        if (signal.paperEntry) {
            const entry = signal.paperEntry;
            if (signal.direction === 'LONG') {
                if (current <= signal.stop) { STATE.signals.delete(id); continue; }
                if (current >= signal.tp1) { signal.status = 'TP1 HEDEF'; }
                else if (current < entry) { signal.status = 'TERS'; }
                else { signal.status = 'KARDA'; }
            } else {
                if (current >= signal.stop) { STATE.signals.delete(id); continue; }
                if (current <= signal.tp1) { signal.status = 'TP1 HEDEF'; }
                else if (current > entry) { signal.status = 'TERS'; }
                else { signal.status = 'KARDA'; }
            }
        }
    }
    
    STATE.stats.signals = STATE.signals.size;
    broadcast();
}

// ========================= STATUS =========================
function status() {
    const signals = [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp);
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals: signals,
        preparing: [],
        pending: [],
        market: STATE.market,
        signalHistoryCount: STATE.signalHistory.length,
        performance: STATE.performance,
        paperTrades: STATE.paperTrades.slice(-20)
    };
}

// ========================= API =========================
function auth(req, res, next) { if (!API_TOKEN) return next(); const token = req.headers['x-api-token'] || req.query.token; if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' }); next(); }
app.get('/api/status', (req, res) => res.json(status()));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), lastScan: STATE.lastScan }));
app.get('/api/scan', auth, async (req, res) => { try { await runScan(); res.json({ success: true, data: status() }); } catch (error) { res.status(500).json({ success: false, error: error.message }); } });
app.get('/api/chart', auth, async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '15m';
        const market = findMarket(symbol);
        if (!market) return res.json({ success: false, error: 'Market yok' });
        const candles = await getCandles(market.symbol, timeframe, CFG.CHART);
        const signal = [...STATE.signals.values()].find(s => s.marketSymbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/history', auth, (req, res) => res.json({ success: true, history: STATE.signalHistory.slice(-100) }));

// ========================= WEBSOCKET =========================
function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: status() });
    for (const ws of wss.clients) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch (error) {} } }
}
wss.on('connection', ws => { try { ws.send(JSON.stringify({ type: 'snapshot', data: status() })); } catch (_) {} });

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI TRADER</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;height:100vh;overflow:hidden;}
.app{display:grid;grid-template-columns:300px 1fr 320px;height:100vh;}
@media(max-width:1000px){.app{grid-template-columns:250px 1fr;}.right{display:none;}}
@media(max-width:700px){.app{grid-template-columns:1fr;}.left{display:none;}}
.left{background:#0b111b;border-right:1px solid #1a2533;overflow-y:auto;padding:15px;}
.brand{font-size:16px;font-weight:bold;color:#13dba0;margin-bottom:3px;}
.sub{color:#718096;font-size:9px;margin-bottom:10px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:10px;}
.st{background:#101826;border:1px solid #1b2939;padding:8px 3px;text-align:center;border-radius:5px;}
.st b{display:block;font-size:16px;color:#13dba0;}
.st span{color:#64748b;font-size:8px;}
.cards{display:flex;flex-direction:column;gap:7px;overflow-y:auto;height:calc(100vh - 160px);}
.card{background:#101826;border:1px solid #1c2938;border-radius:8px;padding:10px;cursor:pointer;}
.card:hover{border-color:#13dba0;}
.card.selected{border:2px solid #13dba0;background:#0d1a15;}
.card.long{border-left:4px solid #13dba0;}
.card.short{border-left:4px solid #ff5570;}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
.coin{font-size:13px;font-weight:bold;}
.dir{font-size:9px;padding:2px 6px;border-radius:3px;font-weight:bold;}
.dir.long{background:#123c31;color:#13dba0;}
.dir.short{background:#421d28;color:#ff5570;}
.price{font-size:14px;font-weight:bold;margin:3px 0;}
.details{font-size:9px;color:#8b9bb4;}
.status-badge{display:inline-block;font-size:8px;padding:2px 6px;border-radius:3px;margin-top:4px;font-weight:bold;background:#101826;color:#8b9bb4;}
.status-active{background:#0d3d2a;color:#13dba0;}
.status-warn{background:#3d2d1d;color:#ff9500;}
.status-kar{background:#0d3d2a;color:#13dba0;}
.status-tp{background:#123c31;color:#55a7ff;}
.main{min-width:0;display:flex;flex-direction:column;background:#0b111b;padding:12px;}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.title{font-weight:bold;font-size:14px;color:#13dba0;}
.info{color:#64748b;font-size:9px;}
.charthead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.chart-title{font-size:11px;font-weight:bold;}
.tf{display:flex;gap:3px;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:4px 8px;font-size:8px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}
.chart{flex:1;min-height:0;position:relative;}
canvas{width:100%;height:100%;display:block;}
.right{background:#0b111b;border-left:1px solid #1a2533;overflow-y:auto;padding:12px;}
.box{background:#101826;border:1px solid #1a2938;border-radius:8px;padding:10px;margin-bottom:8px;}
.bt{color:#64748b;font-size:8px;font-weight:bold;}
.reg{font-size:14px;font-weight:bold;margin-top:4px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:9px;line-height:1.5;margin-top:3px;}
.signal-title{font-size:13px;font-weight:bold;}
.signal-title.long{color:#13dba0;}
.signal-title.short{color:#ff5570;}
.signal-status{font-size:10px;font-weight:bold;margin:4px 0;padding:4px 8px;border-radius:3px;display:inline-block;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:4px;padding:5px;}
.lv span{display:block;color:#64748b;font-size:7px;margin-bottom:1px;}
.lv b{font-size:10px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}
.pi{border:1px solid #1b2938;border-radius:4px;padding:5px;font-size:8px;color:#718096;}
.pi b{color:#dbe4ee;font-size:9px;}
.empty{color:#64748b;font-size:9px;padding:8px 4px;text-align:center;}
</style>
</head>
<body>
<div class="app">
<aside class="left">
<div class="brand">⚡ SONNY AI TRADER</div>
<div class="sub">4H/2H/1H KIRILIM + MOMENTUM</div>
<div class="stats">
<div class="st"><b id="u">0</b><span>RADAR</span></div>
<div class="st"><b id="c">0</b><span>ADAY</span></div>
<div class="st"><b id="d">0</b><span>DERİN</span></div>
</div>
<div class="cards" id="cards"><div class="empty">Sinyal bekleniyor...</div></div>
</aside>
<main class="main">
<div class="head">
<div class="title" id="ps">BTCUSDT</div>
<div class="info" id="info">-</div>
</div>
<div class="charthead">
<div class="chart-title" id="cn">BTCUSDT • 15M</div>
<div class="tf">
<button data-t="15m" class="active">15M</button>
<button data-t="1h">1H</button>
<button data-t="4h">4H</button>
</div>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
</main>
<aside class="right">
<div class="box">
<div class="bt">GENEL PİYASA</div>
<div id="reg" class="reg">YATAY</div>
<div id="mi" class="mi">-</div>
</div>
<div class="box">
<div class="bt">SİNYAL DETAY</div>
<div id="active"><div class="empty">Sinyal seçin</div></div>
</div>
<div class="box">
<div class="bt">PERFORMANS</div>
<div id="perf"><div class="empty">-</div></div>
</div>
</aside>
</div>
<script>
var S = {selected:'BTC/USDT:USDT', tf:'15m', candles:[], signal:null};
var _signals = [];
function $(id){ return document.getElementById(id); }
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function p(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); if(x>=.01) return x.toFixed(7); if(x>=.0001) return x.toFixed(8); return x.toFixed(10); }
function normalize(a){ return (a||[]).map(function(x){ return Array.isArray(x)?{time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{time:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)}; }).filter(function(x){ return Number.isFinite(x.time)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close); }).sort(function(a,b){ return a.time-b.time; }); }

function selectSignal(marketSymbol){
    var s = _signals.find(function(x){ return x.marketSymbol === marketSymbol; });
    if(!s) return;
    S.selected = s.marketSymbol;
    S.signal = s;
    document.querySelectorAll('.card').forEach(function(c){ c.classList.remove('selected'); });
    var card = document.querySelector('.card[data-symbol="' + marketSymbol + '"]');
    if(card) card.classList.add('selected');
    setActive(s);
    loadChart();
}

function render(data){
    var st = data.stats || {};
    $('u').textContent = st.universe || 0;
    $('c').textContent = st.candidates || 0;
    $('d').textContent = st.deep || 0;
    $('info').textContent = data.lastScan ? 'Son: ' + new Date(data.lastScan).toLocaleTimeString('tr-TR') : '-';
    var m = data.market || {};
    $('reg').textContent = m.label || 'YATAY';
    $('reg').className = 'reg ' + (m.direction === 'LONG' ? 'long' : m.direction === 'SHORT' ? 'short' : '');
    $('mi').innerHTML = 'Breadth %' + esc(m.breadth) + '<br>Yeşil ' + esc(m.green) + ' • Kırmızı ' + esc(m.red);
    
    _signals = data.signals || [];
    var cards = $('cards');
    cards.innerHTML = '';
    if(!_signals.length){ cards.innerHTML = '<div class="empty">Sinyal yok</div>'; }
    
    _signals.forEach(function(s){
        var el = document.createElement('div');
        var isLong = s.direction === 'LONG' || s.signal === 'LONG' || s.signal === 'PUMP';
        var cls = 'card ' + (isLong ? 'long' : 'short');
        if(s.marketSymbol === S.selected) cls += ' selected';
        
        var statusText = s.status || 'GİRİŞ BEKLENİYOR';
        var statusCls = '';
        if(s.status === 'İŞLEM AÇILDI'){ statusCls = 'status-active'; }
        else if(s.status === 'KARDA'){ statusCls = 'status-kar'; }
        else if(s.status === 'TERS'){ statusCls = 'status-warn'; }
        else if(s.status && s.status.startsWith('TP')){ statusCls = 'status-tp'; }
        
        el.className = cls;
        el.setAttribute('data-symbol', s.marketSymbol);
        el.style.cursor = 'pointer';
        el.innerHTML = '<div class="card-head"><div class="coin">' + esc(s.symbol) + '</div><div class="dir ' + (isLong ? 'long' : 'short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div></div>' +
        '<div class="price">' + p(s.currentPrice || s.entry) + '</div>' +
        '<div class="details">Güven: ' + esc(s.confidence) + '% • ' + esc(s.strategyType) + '</div>' +
        '<div class="details">' + esc(s.time || '') + ' • Hacim: ' + esc(s.volumeFormatted || '?') + '</div>' +
        '<span class="status-badge ' + statusCls + '">' + esc(statusText) + '</span>';
        
        el.onclick = (function(sym){ return function(){ selectSignal(sym); }; })(s.marketSymbol);
        cards.appendChild(el);
    });
    
    var selected = _signals.find(function(x){ return x.marketSymbol === S.selected; }) || _signals[0] || null;
    if(selected){ S.selected = selected.marketSymbol; S.signal = selected; setActive(selected); }
    else { setActive(null); }
    
    $('perf').innerHTML = '<div class="pi"><b>📊 Sinyaller</b><br>Toplam: ' + esc(_signals.length) + '<br>LONG: ' + esc(st.longSignals || 0) + ' • SHORT: ' + esc(st.shortSignals || 0) + '</div>';
}

function setActive(s){
    if(!s){ $('active').innerHTML = '<div class="empty">Sinyal seçin</div>'; return; }
    var isLong = s.direction === 'LONG' || s.signal === 'LONG' || s.signal === 'PUMP';
    var cls = isLong ? 'long' : 'short';
    var statusColor = '#8b9bb4', statusBg = '#101826';
    if(s.status === 'KARDA'){ statusColor = '#13dba0'; statusBg = '#0d1a15'; }
    else if(s.status === 'TERS'){ statusColor = '#ff9500'; statusBg = '#2d1d0d'; }
    else if(s.status === 'İŞLEM AÇILDI'){ statusColor = '#13dba0'; statusBg = '#0d1a15'; }
    else if(s.status && s.status.startsWith('TP')){ statusColor = '#55a7ff'; statusBg = '#101826'; }
    
    $('active').innerHTML = '<div class="signal-title ' + cls + '">' + esc(s.symbol) + ' • ' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
    '<div class="signal-status" style="background:' + statusBg + ';color:' + statusColor + ';">' + esc(s.status || 'GİRİŞ BEKLENİYOR') + '</div>' +
    '<div class="levels">' +
    '<div class="lv entry"><span>GİRİŞ</span><b>' + p(s.entry) + '</b></div>' +
    '<div class="lv stop"><span>STOP</span><b>' + p(s.stop) + '</b></div>' +
    '<div class="lv tp"><span>TP</span><b>' + p(s.tp1) + '</b></div>' +
    '<div class="lv"><span>R:R</span><b>' + esc(s.RR || s.riskReward || '-') + '</b></div></div>' +
    '<div class="mi" style="margin-top:5px;">Güven: ' + esc(s.confidence) + '%<br>Strateji: ' + esc(s.strategyType) + ' (' + esc(s.timeframe || '') + ')<br>Trend: ' + esc(s.overallTrend || '-') + '<br>' + esc(s.tacticalAnalysis || s.reason || '') + '</div>';
}

function updateHeader(){
    var sym = String(S.selected || 'BTCUSDT').replace('/USDT:USDT', 'USDT');
    $('ps').textContent = sym;
    $('cn').textContent = sym + ' • ' + String(S.tf).toUpperCase();
}

async function loadChart(){
    try {
        var r = await fetch('/api/chart?symbol=' + encodeURIComponent(S.selected) + '&timeframe=' + encodeURIComponent(S.tf), {cache:'no-store'});
        var d = await r.json();
        if(!d.success) return;
        S.candles = normalize(d.candles);
        S.signal = d.signal || S.signal;
        S.selected = d.symbol || S.selected;
        S.tf = d.timeframe || S.tf;
        updateHeader();
        draw();
    } catch(e) { console.error('chart', e); }
}

function draw(){
    var c = $('cv');
    if(!c) return;
    var parent = c.parentElement;
    var w = Math.max(300, parent.clientWidth);
    var h = Math.max(300, parent.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    var x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#070b11';
    x.fillRect(0, 0, w, h);
    
    if(!S.candles.length) {
        x.fillStyle = '#718096';
        x.font = '11px Arial';
        x.fillText('Veri bekleniyor...', 15, 25);
        return;
    }
    
    var visible = S.candles.slice(-80);
    var candleMin = Math.min.apply(Math, visible.map(function(k){ return k.low; }));
    var candleMax = Math.max.apply(Math, visible.map(function(k){ return k.high; }));
    
    var s = S.signal;
    var allLevels = [];
    if(s) {
        [s.entry, s.stop, s.tp1].forEach(function(q) {
            if(Number.isFinite(Number(q))) allLevels.push(Number(q));
        });
    }
    
    var min = candleMin, max = candleMax;
    if(allLevels.length) {
        var sigMin = Math.min.apply(Math, allLevels);
        var sigMax = Math.max.apply(Math, allLevels);
        if(sigMin < candleMin) min = sigMin;
        if(sigMax > candleMax) max = sigMax;
    }
    
    var pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;
    
    var L = 50, R = 70, T = 15, B = 15;
    var PW = w - L - R;
    var PH = h - T - B;
    
    function Y(q) { return T + (max - q) / (max - min) * PH; }
    function X(i) { return L + i * PW / Math.max(1, visible.length - 1); }
    
    x.strokeStyle = '#182330';
    x.lineWidth = 1;
    for(var g = 0; g <= 4; g++) {
        var gy = T + PH * g / 4;
        x.beginPath();
        x.moveTo(L, gy);
        x.lineTo(w - R, gy);
        x.stroke();
        x.fillStyle = '#607083';
        x.font = '8px Arial';
        x.fillText(p(max - (max - min) * g / 4), 3, gy + 3);
    }
    
    var step = PW / Math.max(1, visible.length - 1);
    var bw = Math.max(2, Math.min(8, step * 0.6));
    
    visible.forEach(function(k, i) {
        var xx = X(i);
        var up = k.close >= k.open;
        var col = up ? '#13e0a2' : '#ff4d6d';
        x.strokeStyle = col;
        x.fillStyle = col;
        x.beginPath();
        x.moveTo(xx, Y(k.high));
        x.lineTo(xx, Y(k.low));
        x.stroke();
        var yo = Y(k.open);
        var yc = Y(k.close);
        x.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    
    if(s) {
        level(s.stop, '#ff4d6d', 'SL');
        level(s.entry, '#13dba0', 'GİRİŞ');
        level(s.tp1, '#4da3ff', 'TP');
    }
    
    function level(q, col, label) {
        if(!Number.isFinite(Number(q))) return;
        var yy = Y(Number(q));
        x.strokeStyle = col;
        x.setLineDash([4, 4]);
        x.beginPath();
        x.moveTo(L, yy);
        x.lineTo(w - R, yy);
        x.stroke();
        x.setLineDash([]);
        x.fillStyle = col;
        x.font = 'bold 8px Arial';
        x.fillText(label + ' ' + p(q), w - R + 3, yy + 3);
    }
}

document.querySelectorAll('[data-t]').forEach(function(b) {
    b.onclick = function() {
        document.querySelectorAll('[data-t]').forEach(function(z) { z.classList.remove('active'); });
        b.classList.add('active');
        S.tf = b.getAttribute('data-t');
        loadChart();
    };
});

function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host);
    ws.onmessage = function(e) {
        try { var m = JSON.parse(e.data); if(m.type === 'snapshot') render(m.data); } catch(_) {}
    };
    ws.onclose = function() { setTimeout(connect, 2500); };
}
connect();
fetch('/api/status', {cache:'no-store'}).then(function(r) { return r.json(); }).then(render).catch(function(){});
window.addEventListener('resize', draw);
setInterval(loadChart, 5000);
</script>
</body>
</html>`;

// ========================= SERVER START =========================
app.get('/', (req, res) => res.type('html').send(HTML));

process.on('unhandledRejection', e => { STATE.lastError = e?.message || String(e); console.error('UNHANDLED', e); });
process.on('uncaughtException', e => { STATE.lastError = e?.message || String(e); console.error('UNCAUGHT', e); });
server.on('error', (err) => { console.error('SERVER BIND ERROR:', err.message); process.exit(1); });

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🚀 SONNY AI TRADER (4H/2H/1H KIRILIM + MOMENTUM)');
    console.log('📡 Bitget USDT Futures');
    console.log('==============================================');
    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | ' + STATE.markets.length);
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR:', e.message);
    }
    setTimeout(() => { runScan().catch(e => console.error('SCAN:', e.message)); }, 1000);
    setInterval(() => { if (!STATE.scanning) runScan().catch(e => console.error('SCAN:', e.message)); }, CFG.SCAN_MS);
    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE:', e.message)), CFG.LIVE_MS);
});
