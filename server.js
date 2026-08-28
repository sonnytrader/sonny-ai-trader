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
    RADAR: 300,
    CANDIDATES: 100,
    DEEP: 60,
    
    PRESCAN_MIN_24H_VOLUME_USDT: 500000,
    
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
    
    BRK2H_LOOKBACK_PERIOD: 50,
    BRK2H_BUFFER_PERCENT: 0.1,
    BRK2H_VOLUME_MULTIPLIER: 1.2,
    BRK2H_SL_ATR_MULTIPLIER: 2.0,
    BRK2H_RSI_LONG_THRESHOLD: 55,
    BRK2H_RSI_SHORT_THRESHOLD: 45,
    
    BRK4H_LOOKBACK_PERIOD: 40,
    BRK4H_BUFFER_PERCENT: 0.15,
    BRK4H_VOLUME_MULTIPLIER: 1.1,
    BRK4H_SL_ATR_MULTIPLIER: 2.2,
    BRK4H_RSI_LONG_THRESHOLD: 55,
    BRK4H_RSI_SHORT_THRESHOLD: 45,
    
    MOMENTUM_1H_LOOKBACK: 24,
    MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER: 3.0,
    MOMENTUM_1H_PRICE_SPIKE_PERCENT: 1.5,
    
    SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,
    MARKET_FILTER_TIMEFRAME: '4h',
    MARKET_FILTER_EMA_PERIOD: 200,
    
    SIGNAL_TTL: 30 * 60 * 1000,
    MAX_SIGNALS: 30,
    
    SCAN_MS: 120000,
    LIVE_MS: 15000,
    CONCURRENCY: 1,
    REQUEST_DELAY: 300,
    CACHE_TTL: { '15m': 60 * 1000, '1h': 120 * 1000, '2h': 240 * 1000, '4h': 300 * 1000 },
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
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: { label: 'YATAY / KARIŞIK', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' },
    stats: { universe: 0, candidates: 0, deep: 0, analyzed: 0, signals: 0, errors: 0, longSignals: 0, shortSignals: 0 },
    signalHistory: [],
    performance: { wins: 0, losses: 0, winRate: 0, totalR: 0 },
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
    const ttl = CFG.CACHE_TTL[tf] || 60 * 1000;
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
    const relevant = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevant.length < period) return null;
    const sum = relevant.reduce((a, b) => a + b, 0);
    return sum / period;
}
function calculateEMA(closes, period) {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = calculateSMA(closes.slice(0, period), period);
    if (ema === null) return null;
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}
function calculateRSI(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        gains.push(diff >= 0 ? diff : 0);
        losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}
function calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return null;
    let trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const h = ohlcv[i][2], l = ohlcv[i][3], pc = ohlcv[i-1][4];
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return calculateSMA(trs.slice(-period), period);
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

// ========================= KIRILIM ANALİZİ =========================
async function analyzeBreakout(symbol, config) {
    const { timeframe, lookbackPeriod, bufferPercent, volumeMultiplier, atrPeriod, rsiPeriod, rsiLongThreshold, rsiShortThreshold, strategyType } = config;
    
    try {
        const cleanSym = cleanSymbol(symbol);
        const cooldownKey = `${cleanSym}-${strategyType}`;
        
        const cooldownTime = STATE.cooldowns.get(cooldownKey);
        if (cooldownTime && Date.now() - cooldownTime < CFG.SIGNAL_COOLDOWN_MS) return null;
        
        const existingSignal = [...STATE.signals.values()].find(s => s.symbol === cleanSym && s.strategyType === strategyType);
        if (existingSignal) return null;
        
        const minCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1);
        const ohlcv = await getCandles(symbol, timeframe, minCandles + 10);
        if (!ohlcv || ohlcv.length < minCandles) return null;
        
        const overallTrend = await checkMarketCondition(symbol);
        
        const lastCandle = ohlcv[ohlcv.length - 1];
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1);
        
        const lastClose = lastCandle[4];
        const lastVolume = lastCandle[5];
        
        let highestHigh = 0, lowestLow = Infinity, volumeSum = 0, volCount = 0;
        for (const c of lookbackCandles) {
            if (c[2] > highestHigh) highestHigh = c[2];
            if (c[3] < lowestLow) lowestLow = c[3];
            volumeSum += c[5];
            volCount++;
        }
        
        if (highestHigh <= lowestLow || volCount === 0) return null;
        const avgVolume = volumeSum / volCount;
        
        const allCloses = ohlcv.map(c => c[4]);
        const atr = calculateATR(ohlcv, atrPeriod);
        const rsi = calculateRSI(allCloses, rsiPeriod);
        
        if (atr === null || rsi === null) return null;
        
        const breakoutHigh = highestHigh * (1 + bufferPercent / 100);
        const breakoutLow = lowestLow * (1 - bufferPercent / 100);
        
        let signal = null;
        if (lastClose > breakoutHigh) signal = 'LONG';
        else if (lastClose < breakoutLow) signal = 'SHORT';
        else return null;
        
        // Trend filtresi
        if (signal === 'LONG' && overallTrend === 'DOWNTREND') return null;
        if (signal === 'SHORT' && overallTrend === 'UPTREND') return null;
        
        // RSI filtresi
        if (signal === 'LONG' && rsi < rsiLongThreshold) return null;
        if (signal === 'SHORT' && rsi > rsiShortThreshold) return null;
        
        // Hacim filtresi
        const hacimMultiplier = lastVolume / avgVolume;
        if (hacimMultiplier < volumeMultiplier) return null;
        
        // TP/SL
        let tp, sl;
        if (signal === 'LONG') {
            tp = lastClose * (1 + CFG.BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100);
            sl = lastClose - (atr * 2.0);
        } else {
            tp = lastClose * (1 - CFG.BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100);
            sl = lastClose + (atr * 2.0);
        }
        
        const risk = Math.abs(lastClose - sl);
        const reward = Math.abs(tp - lastClose);
        const rr = risk > 0 ? reward / risk : 0;
        if (rr < 0.5) return null;
        
        // Güven skoru
        let confidence = 40;
        if (signal === 'LONG' && overallTrend === 'UPTREND') confidence += 20;
        if (signal === 'SHORT' && overallTrend === 'DOWNTREND') confidence += 20;
        if (hacimMultiplier > 3.5) confidence += 25;
        else if (hacimMultiplier > 1.8) confidence += 15;
        else confidence -= 10;
        if (signal === 'LONG' && rsi > 78) confidence -= 15;
        if (signal === 'SHORT' && rsi < 22) confidence -= 15;
        confidence = Math.min(95, Math.max(10, confidence));
        
        const reason = signal === 'LONG' 
            ? `${timeframe} Direnç Kırılımı (${highestHigh.toFixed(4)})`
            : `${timeframe} Destek Kırılımı (${lowestLow.toFixed(4)})`;
        
        return {
            id: `${cleanSym}-${signal}-${Date.now()}-${strategyType}`,
            symbol: cleanSym,
            marketSymbol: symbol,
            direction: signal,
            signal: signal,
            strategyType: strategyType,
            confidence: confidence,
            score: confidence,
            entry: lastClose,
            entryPrice: lastClose.toFixed(6),
            giris: lastClose,
            TP: tp.toFixed(6),
            tp1: tp,
            tp2: tp * 1.5,
            tp3: tp * 2,
            SL: sl.toFixed(6),
            stop: sl,
            stopLoss: sl,
            RR: rr.toFixed(2),
            rr: rr,
            riskReward: rr.toFixed(2),
            reason: `${reason} | R/R: ${rr.toFixed(2)}`,
            tacticalAnalysis: `${signal} sinyali | Hacim: ${hacimMultiplier.toFixed(1)}x | Trend: ${overallTrend} | RSI: ${rsi.toFixed(0)}`,
            volumeFormatted: formatVolume(lastVolume),
            volumeTier: lastVolume > 5000000 ? 'HIGH' : lastVolume > 1000000 ? 'MID' : 'LOW',
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: Date.now(),
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            cooldownKey: cooldownKey,
            timeframe: timeframe,
            overallTrend: overallTrend,
            rsi: rsi,
            atr: atr,
            hacimMultiplier: hacimMultiplier
        };
    } catch (error) {
        console.error(`[${strategyType} Analiz Hatası (${symbol})]:`, error.message);
        return null;
    }
}

// ========================= MOMENTUM ANALİZİ =========================
async function analyzeMomentum(symbol) {
    try {
        const cleanSym = cleanSymbol(symbol);
        const cooldownKey = `${cleanSym}-MOMENTUM`;
        
        const cooldownTime = STATE.cooldowns.get(cooldownKey);
        if (cooldownTime && Date.now() - cooldownTime < CFG.SIGNAL_COOLDOWN_MS) return null;
        
        const existing = [...STATE.signals.values()].find(s => s.symbol === cleanSym && s.strategyType === 'MOMENTUM');
        if (existing) return null;
        
        const overallTrend = await checkMarketCondition(symbol);
        const ohlcv = await getCandles(symbol, '1h', CFG.MOMENTUM_1H_LOOKBACK + 5);
        if (!ohlcv || ohlcv.length < CFG.MOMENTUM_1H_LOOKBACK + 2) return null;
        
        const last = ohlcv[ohlcv.length - 1];
        const prev = ohlcv[ohlcv.length - 2];
        
        const lastClose = last[4];
        const lastVolume = last[5];
        const prevClose = prev[4];
        
        const volLookback = ohlcv.slice(-(CFG.MOMENTUM_1H_LOOKBACK + 1), -1).map(c => c[5]);
        const avgVol = avg(volLookback);
        if (avgVol <= 0) return null;
        
        const priceChange = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
        const volMultiplier = lastVolume / avgVol;
        
        let signal = null;
        if (volMultiplier >= CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChange >= CFG.MOMENTUM_1H_PRICE_SPIKE_PERCENT && overallTrend !== 'DOWNTREND') {
            signal = 'LONG';
        } else if (volMultiplier >= CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChange <= -CFG.MOMENTUM_1H_PRICE_SPIKE_PERCENT && overallTrend !== 'UPTREND') {
            signal = 'SHORT';
        }
        
        if (!signal) return null;
        
        const confidence = Math.min(95, 65 + (volMultiplier - CFG.MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5);
        
        return {
            id: `${cleanSym}-${signal}-${Date.now()}-MOMENTUM`,
            symbol: cleanSym,
            marketSymbol: symbol,
            direction: signal,
            signal: signal,
            strategyType: 'MOMENTUM',
            confidence: Math.round(confidence),
            score: Math.round(confidence),
            entry: lastClose,
            entryPrice: lastClose.toFixed(6),
            giris: lastClose,
            TP: '---',
            tp1: lastClose,
            tp2: lastClose,
            tp3: lastClose,
            SL: '---',
            stop: lastClose,
            stopLoss: lastClose,
            RR: 'N/A',
            rr: 0,
            riskReward: 'N/A',
            reason: `Hacim: ${volMultiplier.toFixed(1)}x, Fiyat: ${priceChange.toFixed(2)}%`,
            tacticalAnalysis: `1H Momentum | Hacim: ${volMultiplier.toFixed(1)}x | Fiyat Değişimi: ${priceChange.toFixed(2)}%`,
            volumeFormatted: formatVolume(lastVolume),
            volumeTier: 'HIGH',
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: Date.now(),
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            cooldownKey: cooldownKey,
            timeframe: '1h',
            overallTrend: overallTrend,
            rsi: 0,
            atr: 0,
            hacimMultiplier: volMultiplier
        };
    } catch (error) {
        console.error(`[Momentum Hatası (${symbol})]:`, error.message);
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
        
        console.log(`\n📡 RADAR: ${rows.length} | CANDIDATES: ${candidates.length}`);
        
        const deepCandidates = candidates.slice(0, CFG.DEEP);
        STATE.deep = deepCandidates;
        STATE.stats.deep = deepCandidates.length;
        STATE.stats.analyzed = 0;
        
        const strategies = [
            { timeframe: '4h', lookbackPeriod: CFG.BRK4H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK4H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK4H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK4H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK4H_RSI_SHORT_THRESHOLD, strategyType: 'BRK4H' },
            { timeframe: '2h', lookbackPeriod: CFG.BRK2H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK2H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK2H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK2H_RSI_SHORT_THRESHOLD, strategyType: 'BRK2H' },
            { timeframe: '1h', lookbackPeriod: CFG.BRK1H_LOOKBACK_PERIOD, bufferPercent: CFG.BRK1H_BUFFER_PERCENT, volumeMultiplier: CFG.BRK1H_VOLUME_MULTIPLIER, atrPeriod: CFG.BREAKOUT_BASE_ATR_PERIOD, rsiPeriod: CFG.BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: CFG.BRK1H_RSI_LONG_THRESHOLD, rsiShortThreshold: CFG.BRK1H_RSI_SHORT_THRESHOLD, strategyType: 'BRK1H' }
        ];
        
        for (const row of deepCandidates) {
            try {
                // Önce 4h dene
                let foundSignal = null;
                
                for (const strat of strategies) {
                    const sig = await analyzeBreakout(row.symbol, strat);
                    if (sig) {
                        foundSignal = sig;
                        break;
                    }
                }
                
                // Kırılım yoksa momentum dene
                if (!foundSignal) {
                    foundSignal = await analyzeMomentum(row.symbol);
                }
                
                if (foundSignal) {
                    STATE.signals.set(foundSignal.id, foundSignal);
                    console.log(`✅ ${foundSignal.symbol} ${foundSignal.signal} (${foundSignal.strategyType}) Güven: ${foundSignal.confidence}%`);
                }
                
                STATE.stats.analyzed++;
            } catch (e) {
                STATE.stats.errors++;
            }
            await sleep(CFG.REQUEST_DELAY);
        }
        
        // Eski sinyalleri temizle
        const now = Date.now();
        for (const [id, signal] of STATE.signals) {
            if (now - signal.timestamp > CFG.SIGNAL_TTL) {
                STATE.signals.delete(id);
            }
        }
        
        STATE.lastScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        
        const activeSignals = [...STATE.signals.values()];
        STATE.stats.longSignals = activeSignals.filter(s => s.direction === 'LONG').length;
        STATE.stats.shortSignals = activeSignals.filter(s => s.direction === 'SHORT').length;
        
        console.log(`\n📊 Sinyaller: ${activeSignals.length} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
        
        broadcast();
    } catch (error) {
        STATE.lastError = error.message;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
    }
}

// ========================= LIVE =========================
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
                signal.status = 'İŞLEM AÇILDI';
            } else if (signal.direction === 'SHORT' && current >= signal.entry) {
                signal.paperEntry = current;
                signal.status = 'İŞLEM AÇILDI';
            }
        }
    }
    
    STATE.stats.signals = STATE.signals.size;
    broadcast();
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
<div class="sub">KIRILIM + MOMENTUM</div>
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
<div class="bt">SİNYALLER</div>
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
    $('mi').innerHTML = 'Breadth %' + esc(m.breadth);
    
    _signals = data.signals || [];
    var cards = $('cards');
    cards.innerHTML = '';
    if(!_signals.length){ cards.innerHTML = '<div class="empty">Sinyal yok</div>'; }
    
    _signals.forEach(function(s){
        var el = document.createElement('div');
        var isLong = s.direction === 'LONG';
        var cls = 'card ' + (isLong ? 'long' : 'short');
        if(s.marketSymbol === S.selected) cls += ' selected';
        
        el.className = cls;
        el.setAttribute('data-symbol', s.marketSymbol);
        el.style.cursor = 'pointer';
        el.innerHTML = '<div class="card-head"><div class="coin">' + esc(s.symbol) + '</div><div class="dir ' + (isLong ? 'long' : 'short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div></div>' +
        '<div class="price">' + p(s.currentPrice || s.entry) + '</div>' +
        '<div class="details">Güven: ' + esc(s.confidence) + '% • ' + esc(s.strategyType) + '</div>' +
        '<div class="details">' + esc(s.time || '') + '</div>' +
        '<span class="status-badge ' + (s.status === 'İŞLEM AÇILDI' ? 'status-active' : '') + '">' + esc(s.status || 'GİRİŞ BEKLENİYOR') + '</span>';
        
        el.onclick = (function(sym){ return function(){ selectSignal(sym); }; })(s.marketSymbol);
        cards.appendChild(el);
    });
    
    var selected = _signals.find(function(x){ return x.marketSymbol === S.selected; }) || _signals[0] || null;
    if(selected){ S.selected = selected.marketSymbol; S.signal = selected; setActive(selected); }
    else { setActive(null); }
    
    $('perf').innerHTML = '<div class="pi"><b>Sinyaller</b><br>Toplam: ' + esc(_signals.length) + '<br>LONG: ' + esc(st.longSignals || 0) + ' • SHORT: ' + esc(st.shortSignals || 0) + '</div>';
}

function setActive(s){
    if(!s){ $('active').innerHTML = '<div class="empty">Sinyal seçin</div>'; return; }
    var isLong = s.direction === 'LONG';
    var cls = isLong ? 'long' : 'short';
    var statusColor = '#8b9bb4', statusBg = '#101826';
    if(s.status === 'İŞLEM AÇILDI'){ statusColor = '#13dba0'; statusBg = '#0d1a15'; }
    
    $('active').innerHTML = '<div class="signal-title ' + cls + '">' + esc(s.symbol) + ' • ' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
    '<div class="signal-status" style="background:' + statusBg + ';color:' + statusColor + ';">' + esc(s.status || 'GİRİŞ BEKLENİYOR') + '</div>' +
    '<div class="levels">' +
    '<div class="lv entry"><span>GİRİŞ</span><b>' + p(s.entry) + '</b></div>' +
    '<div class="lv stop"><span>STOP</span><b>' + p(s.stop) + '</b></div>' +
    '<div class="lv tp"><span>TP</span><b>' + p(s.tp1) + '</b></div>' +
    '<div class="lv"><span>R:R</span><b>' + esc(s.RR || '-') + '</b></div></div>' +
    '<div class="mi" style="margin-top:5px;">Güven: ' + esc(s.confidence) + '%<br>Strateji: ' + esc(s.strategyType) + '<br>Trend: ' + esc(s.overallTrend || '-') + '<br>' + esc(s.tacticalAnalysis || s.reason || '') + '</div>';
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
    
    if(!S.candles.length) { x.fillStyle = '#718096'; x.font = '11px Arial'; x.fillText('Veri bekleniyor...', 15, 25); return; }
    
    var visible = S.candles.slice(-80);
    var candleMin = Math.min.apply(Math, visible.map(function(k){ return k.low; }));
    var candleMax = Math.max.apply(Math, visible.map(function(k){ return k.high; }));
    
    var s = S.signal;
    if(s) {
        if(Number(s.entry) < candleMin) candleMin = Number(s.entry);
        if(Number(s.entry) > candleMax) candleMax = Number(s.entry);
        if(Number(s.stop) < candleMin) candleMin = Number(s.stop);
        if(Number(s.stop) > candleMax) candleMax = Number(s.stop);
        if(Number(s.tp1) < candleMin) candleMin = Number(s.tp1);
        if(Number(s.tp1) > candleMax) candleMax = Number(s.tp1);
    }
    
    var pad = (candleMax - candleMin) * 0.08 || 1;
    candleMin -= pad;
    candleMax += pad;
    
    var L = 50, R = 70, T = 15, B = 15;
    var PW = w - L - R;
    var PH = h - T - B;
    
    function Y(q) { return T + (candleMax - q) / (candleMax - candleMin) * PH; }
    function X(i) { return L + i * PW / Math.max(1, visible.length - 1); }
    
    x.strokeStyle = '#182330';
    for(var g = 0; g <= 4; g++) {
        var gy = T + PH * g / 4;
        x.beginPath(); x.moveTo(L, gy); x.lineTo(w - R, gy); x.stroke();
        x.fillStyle = '#607083'; x.font = '8px Arial';
        x.fillText(p(candleMax - (candleMax - candleMin) * g / 4), 3, gy + 3);
    }
    
    var step = PW / Math.max(1, visible.length - 1);
    var bw = Math.max(2, Math.min(8, step * 0.6));
    
    visible.forEach(function(k, i) {
        var xx = X(i);
        var up = k.close >= k.open;
        var col = up ? '#13e0a2' : '#ff4d6d';
        x.strokeStyle = col; x.fillStyle = col;
        x.beginPath(); x.moveTo(xx, Y(k.high)); x.lineTo(xx, Y(k.low)); x.stroke();
        var yo = Y(k.open), yc = Y(k.close);
        x.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    
    if(s) {
        if(Number.isFinite(Number(s.stop))) level(Number(s.stop), '#ff4d6d', 'SL');
        if(Number.isFinite(Number(s.entry))) level(Number(s.entry), '#13dba0', 'GİRİŞ');
        if(Number.isFinite(Number(s.tp1))) level(Number(s.tp1), '#4da3ff', 'TP');
    }
    
    function level(q, col, label) {
        var yy = Y(q);
        x.strokeStyle = col; x.setLineDash([4, 4]);
        x.beginPath(); x.moveTo(L, yy); x.lineTo(w - R, yy); x.stroke();
        x.setLineDash([]); x.fillStyle = col; x.font = 'bold 8px Arial';
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
    console.log('🚀 SONNY AI TRADER (KIRILIM + MOMENTUM)');
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
