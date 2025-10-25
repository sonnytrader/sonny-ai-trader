// server.js (ANA PROJE V5.4 - Hacim Filtresi Zorunlu - TAM SÜRÜM)
// SÜRÜM: V5.4 (Stabilite İçin API Gecikmesi 150ms ve Kritik StochRSI Hatası Giderildi) (26.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V5.4 - Kritik Hata Giderildi) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === ÖN TARAMA FİLTRELERİ (Aşama 1) ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 3000000; // 3 Milyon USDT

// === STOCH+EMA STRATEJİ AYARLARI (Aşama 2) ===
const SCAN_INTERVAL = 1 * 60 * 1000;
const WATCHLIST_SCAN_INTERVAL = 1 * 1000; // 1 Saniye Anlık Takip
const API_DELAY_MS = 150; // Stabilite için gecikme
const TIMEFRAME = '15m'; // 15 dakika
const TIMEFRAME_MTF = '1h';
const EMA_PERIOD = 50;
const BOLLINGER_PERIOD = 20; const BOLLINGER_STDDEV = 2;
const RSI_PERIOD = 14; const STOCH_K = 14; const STOCH_D = 3; const STOCH_SMOOTH_K = 3;

// R/R Ayarları (TP 5.0%, SL 2.0%)
const TP_PERCENTAGE = 5.0;
const SL_PERCENTAGE = 2.0;
const MIN_RR_RATIO = SL_PERCENTAGE > 0 ? TP_PERCENTAGE / SL_PERCENTAGE : 1.0;

// Hacim ve BB Genişlik Filtreleri (Güven Puanı için Kullanılacak)
const MIN_VOLUME_MULTIPLIER = 0.8; // Hacim eşiği (0.8x)
const MIN_BB_WIDTH_PERCENT = 0.05;
const MAX_BB_WIDTH_PERCENT = 5.0;

const REQUIRED_CANDLE_BUFFER = 50;
// ===========================================

// === 2 SAATLİK KIRILIM STRATEJİSİ AYARLARI (Aşama 2) ===
const BREAKOUT_TIMEFRAME = '2h'; const BREAKOUT_LOOKBACK_PERIOD = 50;
const BREAKOUT_SCAN_INTERVAL = 30 * 60 * 1000; const BREAKOUT_BUFFER_PERCENT = 0.1;
const BREAKOUT_VOLUME_MULTIPLIER = 1.5;

const BREAKOUT_TP_PERCENTAGE = 5.0;
const BREAKOUT_SL_PERCENTAGE = 2.0;
const BREAKOUT_RR_RATIO = BREAKOUT_SL_PERCENTAGE > 0 ? BREAKOUT_TP_PERCENTAGE / BREAKOUT_SL_PERCENTAGE : 1.0;

// === GENEL PİYASA FİLTRESİ AYARLARI (Sadece 2h için) ===
const MARKET_FILTER_TIMEFRAME = '4h'; const MARKET_FILTER_EMA_PERIOD = 200;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
let signalCooldowns = {};
let globalWatchlist = {};
let globalTargetList = [];

global.APP_STATE = { signals: [], scanStatus: { message: '...', isScanning: false } };
const exchange = new ccxt.bitget({ 'enableRateLimit': true, 'rateLimit': 100 });

// --- TÜM İNDİKATOR HESAPLAMA FONKSİYONLARI ---
function calculateSMA(data, period) {
    if (!data || data.length < period) return null;
    const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevantData.length < period) return null;
    const sum = relevantData.reduce((a, b) => (a || 0) + (b || 0), 0);
    const sma = sum / period;
    return isNaN(sma) ? null : sma;
}
function calculateEMA(closes, period, startingEMA = null) {
    if (!closes || closes.length < period) return null;
    let emaArray = []; const k = 2 / (period + 1);
    let currentEMA = startingEMA !== null ? startingEMA : calculateSMA(closes.slice(0, period), period);
    if (currentEMA === null) {
        let firstValidClose = null;
        for (let i = Math.min(period - 1, closes.length - 1); i >= 0; i--) { if (typeof closes[i] === 'number' && !isNaN(closes[i])) { firstValidClose = closes[i]; break; } }
        if (firstValidClose === null) return null; currentEMA = firstValidClose;
    }
    for(let i=0; i < closes.length; i++) {
        if (typeof closes[i] === 'number' && !isNaN(closes[i]) && i >= period) { currentEMA = (closes[i] * k) + (currentEMA * (1 - k)); }
        if(isNaN(currentEMA)){ return null; } emaArray.push(currentEMA);
    } return emaArray;
}
function calculateStdDev(data, period) {
    if (!data || data.length < period) return null;
    const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevantData.length < period) return null;
    const mean = calculateSMA(relevantData, period); if (mean === null) return null;
    const squareDiffs = relevantData.map(value => Math.pow((value || 0) - mean, 2));
    const variance = squareDiffs.reduce((a, b) => a + b, 0) / period;
    if (isNaN(variance) || variance < 0) return null; return Math.sqrt(variance);
}
function calculateBollingerBands(closes, period, stdDevMultiplier) {
    if (!closes || closes.length < period) return null;
    const middleBand = calculateSMA(closes, period); const stdDev = calculateStdDev(closes, period);
    if (middleBand === null || stdDev === null || stdDev <= 0) return null;
    const upperBand = middleBand + (stdDev * stdDevMultiplier); const lowerBand = middleBand - (stdDev * stdDevMultiplier);
    if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(middleBand)) return null;
    return { upperBand, middleBand, lowerBand };
}
function calculateRSI(closes, rsiPeriod = 14) {
    if (!closes || closes.length < rsiPeriod + 1) return null;
    let gains = []; let losses = [];
    for (let i = 1; i < closes.length; i++) {
        const currentClose = closes[i]; const prevClose = closes[i-1];
        if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) return null;
        const diff = currentClose - prevClose;
        gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    if (gains.length < rsiPeriod) return null;
    let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
    let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
    if(isNaN(avgGain) || isNaN(avgLoss)) return null;
    for (let i = rsiPeriod; i < gains.length; i++) {
        avgGain = (avgGain * (rsiPeriod - 1) + gains[i]) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]) / rsiPeriod;
    }
    if(isNaN(avgGain) || isNaN(avgLoss)) return null;
    const rs = avgLoss === 0 ? 10000 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return isNaN(rsi) ? null : rsi;
}
function calculateStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    try {
        const minRequiredCloses = rsiPeriod + stochPeriod + Math.max(kSmooth, dSmooth) + 5;
        if (!closes || closes.length < minRequiredCloses) return null;

        let rsiValues = []; let gains = [], losses = [];
        for (let i = 1; i < closes.length; i++) {
            const currentClose = closes[i]; const prevClose = closes[i-1];
            if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) { gains.push(NaN); losses.push(NaN); continue; }
            const diff = currentClose - prevClose;
            gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0);
        }

        const initialGains = gains.slice(0, rsiPeriod).filter(v => !isNaN(v));
        const initialLosses = losses.slice(0, rsiPeriod).filter(v => !isNaN(v));
        if (initialGains.length < rsiPeriod || initialLosses.length < rsiPeriod) return null;

        let avgGain = initialGains.reduce((a, b) => a + b, 0) / rsiPeriod;
        let avgLoss = initialLosses.reduce((a, b) => a + b, 0) / rsiPeriod;
        if(isNaN(avgGain) || isNaN(avgLoss)) return null;

        let tempRsiValues = [];
        for(let j=0; j < gains.length - rsiPeriod + 1; j++){
            if(j > 0){
                if (isNaN(gains[rsiPeriod + j -1]) || isNaN(losses[rsiPeriod + j -1])) continue;
                avgGain = (avgGain * (rsiPeriod - 1) + gains[rsiPeriod + j -1]) / rsiPeriod;
                avgLoss = (avgLoss * (rsiPeriod - 1) + losses[rsiPeriod + j -1]) / rsiPeriod;
            }
            if(isNaN(avgGain) || isNaN(avgLoss)) continue;
            let rs = avgLoss === 0 ? 10000 : avgGain / avgLoss;
            let rsi = 100 - (100 / (1 + rs));
            if(!isNaN(rsi)) tempRsiValues.push(rsi);
        }
        rsiValues = tempRsiValues;

        if (rsiValues.length < stochPeriod) return null;
        let stochValues = [];
        for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
            const periodSlice = rsiValues.slice(i - stochPeriod + 1, i + 1); if(periodSlice.length < stochPeriod) continue;
             if (periodSlice.some(isNaN)) continue;
            const lowestRSI = Math.min(...periodSlice); const highestRSI = Math.max(...periodSlice); const currentRSI = rsiValues[i];
            const stochK = (highestRSI === lowestRSI) ? 50 : Math.max(0, Math.min(100, ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100));
            if(!isNaN(stochK)) stochValues.push(stochK);
        }
        if (stochValues.length < kSmooth) return null;
        let slowKValues = [];
        for (let i = kSmooth - 1; i < stochValues.length; i++) { const kSlice = stochValues.slice(i - kSmooth + 1, i + 1); if(kSlice.length < kSmooth) continue; const smaK = calculateSMA(kSlice, kSmooth); if (smaK !== null) slowKValues.push(smaK); }
        if (slowKValues.length < dSmooth) return null;
        let slowDValues = [];
        for (let i = dSmooth - 1; i < slowKValues.length; i++) { 
            const dSlice = slowKValues.slice(i - dSmooth + 1, i + 1); // <<< DÜZELTME: dSlice değişkeni burada tanımlanır.
            if(dSlice.length < dSmooth) continue; 
            const smaD = calculateSMA(dSlice, dSmooth); 
            if (smaD !== null) slowDValues.push(smaD); 
        }

        if (slowKValues.length < 2 || slowDValues.length < 2) return null;

        const K = slowKValues[slowKValues.length - 1];
        const D = slowDValues[slowDValues.length - 1];
        const prevK = slowKValues[slowKValues.length - 2];
        const prevD = slowDValues[slowDValues.length - 2];

        if (K === null || D === null || isNaN(K) || isNaN(D) || prevK === null || prevD === null || isNaN(prevK) || isNaN(prevD)) return null;
        return { K, D, prevK, prevD };
    } catch (e) { console.error(`StochasticRSI hesaplama hatası (${closes?.length} mum)`, e); return null; }
}
async function checkMTF_EMA(ccxtSymbol) {
    const requiredCandleCount = EMA_PERIOD + 5;
    try {
        const ohlcv1h = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME_MTF, undefined, requiredCandleCount);
        if (!ohlcv1h || ohlcv1h.length < EMA_PERIOD) return null;
        const closes1h = ohlcv1h.map(m => m[4]);
        const ema1hArray = calculateEMA(closes1h, EMA_PERIOD);
        if (!ema1hArray || ema1hArray.length === 0) return null;
        const lastClosePrice1h = closes1h[closes1h.length - 1];
        const ema1h = ema1hArray[ema1hArray.length - 1];
        if (ema1h === null || isNaN(lastClosePrice1h) || isNaN(ema1h)) return null;
        return {
            isUptrend: lastClosePrice1h > ema1h,
            isDowntrend: lastClosePrice1h < ema1h,
            trendStatus: lastClosePrice1h > ema1h ? 'YÜKSELİŞ' : (lastClosePrice1h < ema1h ? 'DÜŞÜŞ' : 'YAN'),
            emaValue: ema1h
        };
    } catch (e) { return null; }
}
async function checkMarketCondition(ccxtSymbol) {
    const requiredCandleCount = MARKET_FILTER_EMA_PERIOD + REQUIRED_CANDLE_BUFFER;
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, MARKET_FILTER_TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < MARKET_FILTER_EMA_PERIOD + 5) return { overallTrend: 'UNKNOWN' };
        const closes = ohlcv.map(m => m[4]); const ema200Array = calculateEMA(closes, MARKET_FILTER_EMA_PERIOD);
        if (!ema200Array || ema200Array.length === 0) return null;
        const lastClosePrice = closes[closes.length - 1]; const lastEma200 = ema200Array[ema200Array.length - 1];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) return { overallTrend: 'UNKNOWN' };
        if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' };
        else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' };
        else return { overallTrend: 'SIDEWAYS' };
    } catch (e) { return { overallTrend: 'UNKNOWN' }; }
}

function calculateFibonacciExtension(ohlcv, period, signalType) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevantOhlcv = ohlcv.slice(-period);
    let high = 0; let low = Infinity;
    for (const candle of relevantOhlcv) {
        if (candle[2] > high) high = candle[2];
        if (candle[3] < low) low = candle[3];
    }
    if (high <= low || high === 0 || low === Infinity) return null;
    const diff = high - low; const FIB_EXT_LEVEL = 1.618; let forecast = null;
    if (signalType === 'LONG') forecast = high + diff * (FIB_EXT_LEVEL - 1);
    else if (signalType === 'SHORT') forecast = low - diff * (FIB_EXT_LEVEL - 1);
    return (forecast !== null && !isNaN(forecast)) ? forecast : null;
}
// --- BİTTİ: İNDİKATOR HESAPLAMA ---


/**
 * AŞAMA 1 - HIZLI ÖN TARAYICI
 */
async function runPreScan() {
    const scanTime = new Date().toLocaleTimeString();
    console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLADI (${scanTime}) ---`);
    let newTargetList = [];

    if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
        console.error("Ön Tarama Hatası: Market listesi (exchange.markets) yüklenmemiş.");
        return;
    }

    try {
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });

        if (!tickers) {
            console.error("Ön tarama 'fetchTickers' ile veri alamadı.");
            return;
        }

        const allTickers = Object.values(tickers);

        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol) continue;

            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;

            if (
                market && market.swap && market.active && market.quote === 'USDT' &&
                quoteVolume && quoteVolume > PRESCAN_MIN_24H_VOLUME_USDT // 3 Milyon Filtresi
            ) {
                newTargetList.push(ticker.symbol);
            }
        }

        globalTargetList = newTargetList;

        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${globalTargetList.length} coin hedefe alındı (Hacim > ${PRESCAN_MIN_24H_VOLUME_USDT/1000000}M).\x1b[0m`);

    } catch (error) {
        console.error(`Kritik Ön Tarama Hatası: ${error.message}`);
    }
}


/**
 * ANA STRATEJİ: Geliştirilmiş Stoch+EMA (15m) - Hacim Filtresi Zorunlu
 */
async function analyzeStochEMACoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = fullSymbol + '-STOCHEMA';
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredStochCandles = RSI_PERIOD + STOCH_K + Math.max(STOCH_SMOOTH_K, STOCH_D) + 10;
        const requiredCandleCount = Math.max(EMA_PERIOD, BOLLINGER_PERIOD, requiredStochCandles) + REQUIRED_CANDLE_BUFFER;

        // API İstekleri: Mumlar ve MTF Trend
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        const mtfTrend = await checkMTF_EMA(ccxtSymbol);

        if (!ohlcv || ohlcv.length < requiredCandleCount - REQUIRED_CANDLE_BUFFER + 10 || mtfTrend === null) return null;

        const closes = ohlcv.map(m => m[4]); const volumes = ohlcv.map(m => m[5]);
        const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null;

        // Göstergeleri Hesapla
        const emaArray = calculateEMA(closes, EMA_PERIOD); const ema = emaArray ? emaArray[emaArray.length - 1] : null;
        const bb = calculateBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STDDEV);
        const stochRSI = calculateStochasticRSI(closes, RSI_PERIOD, STOCH_K, STOCH_SMOOTH_K, STOCH_D);

        if (bb === null || stochRSI === null || ema === null) {
            let missing = []; if(bb === null) missing.push("BB"); if(stochRSI === null) missing.push("StochRSI"); if(ema === null) missing.push("EMA");
            if (isManual) return { error: `Gerekli indikatörler hesaplanamadı (${missing.join('/')} Eksik).` }; return null;
        }

        const { upperBand, lowerBand, middleBand } = bb; const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        let signal = 'WAIT'; let reason = 'Bekle (15m Stoch+EMA)';
        let baseConfidence = 60;
        let confidenceScore = baseConfidence;
        let isFiltered = false;

        // Hacim Kontrolü
        const lastVolume = volumes[volumes.length - 1];
        const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), BOLLINGER_PERIOD);
        let volumeStatus = 'Hacim Hesaplanamadı';
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * MIN_VOLUME_MULTIPLIER; // <<< 0.8x Hacim Teyit Kontrolü
        if (avgVolume && lastVolume) { volumeStatus = `Hacim: ${(lastVolume / avgVolume).toFixed(1)}x`; }

        // Stoch Koşulları
        const stochBullishCross = prevK <= prevD && stochK > stochD;
        const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversold = stochK < 30;
        const stochOverbought = stochK > 70;

        // Trend Koşulları
        const is15mUptrend = lastClosePrice > ema;
        const is15mDowntrend = lastClosePrice < ema;
        const isMtfUptrend = mtfTrend.isUptrend;
        const isMtfDowntrend = mtfTrend.isDowntrend;

        // BB Teması
        const touchedLowerBB = lastClosePrice <= lowerBand;
        const touchedUpperBB = lastClosePrice >= upperBand;

        // Sinyal Mantığı (15m EMA + 1h EMA)
        if (is15mUptrend && isMtfUptrend) {
            if (stochBullishCross && stochOversold && touchedLowerBB) { signal = 'LONG'; reason = 'Stoch Aşırı Satım Kesişimi + BB Teması'; }
            else if (stochBullishCross && stochK < 50) { signal = 'LONG'; reason = 'Stoch Orta Kesişim (15m+1h Teyitli)'; }
        }
        else if (is15mDowntrend && isMtfDowntrend) {
            if (stochBearishCross && stochOverbought && touchedUpperBB) { signal = 'SHORT'; reason = 'Stoch Aşırı Alım Kesişimi + BB Teması'; }
            else if (stochBearishCross && stochK > 50) { signal = 'SHORT'; reason = 'Stoch Orta Kesişim (15m+1h Teyitli)'; }
        }

        // --- KRİTİK FİLTRE: HACİM ZORUNLULUĞU ---
        if (signal !== 'WAIT' && !isFiltered) {
             if (!isVolumeStrong) {
                 isFiltered = true;
                 reason = `FİLTRELENDİ: Hacim Teyidi Eksik (${volumeStatus}). Minimum eşik 0.8x.`;
                 signal = 'WAIT';
                 confidenceScore = 50;
             }
        }

        // --- DİNAMİK GÜVEN PUANLAMASI ---
        if (signal !== 'WAIT' && !isFiltered) { // Eğer hacim filtresinden geçtiyse puanlamaya devam et

             // 1H Trend Teyidi ve Cezası
             if ((signal === 'LONG' && isMtfUptrend) || (signal === 'SHORT' && isMtfDowntrend)) { confidenceScore += 10; reason += ' [1H Trend Teyitli]'; }
             else { reason += ` [1H Trend: ${mtfTrend.trendStatus}]`; confidenceScore -= 5; }

            // Hacim Puanı (Filtreden geçtiği için +10)
            if (isVolumeStrong) { confidenceScore += 10; reason += ' [Hacim Yüksek]'; }

            // Stoch Aşırı Bölge Bonusu
            if ((signal === 'LONG' && stochOversold) || (signal === 'SHORT' && stochOverbought)) { confidenceScore += 5; reason += ' [Stoch Aşırı Bölge]'; }

            // BB GENİŞLİK BONUSU
            if (middleBand > 0) {
                 const bbWidthPercent = ((upperBand - lowerBand) / middleBand) * 100;
                 if (bbWidthPercent >= MIN_BB_WIDTH_PERCENT && bbWidthPercent <= MAX_BB_WIDTH_PERCENT) { confidenceScore += 5; reason += ' [BB Genişlik Normal]'; }
            }
        }

        // R/R 2.5'u uygula ve BB Genişlik Kontrolü (Filtre)
        let takeProfit = null, stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            if (signal === 'LONG') { takeProfit = lastClosePrice * (1 + TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 - SL_PERCENTAGE / 100); }
            else if (signal === 'SHORT') { takeProfit = lastClosePrice * (1 - TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 + SL_PERCENTAGE / 100); }
            rrRatio = MIN_RR_RATIO;

            // BB Genişlik Kontrolü (İkinci Filtre)
            if(middleBand <= 0) { isFiltered = true; reason = `FİLTRELENDİ: Geçersiz BB Orta Bandı`; signal = 'WAIT'; confidenceScore = 50; }
            else {
                 const bbWidth = upperBand - lowerBand; const bbWidthPercent = (bbWidth / middleBand) * 100;
                 if (bbWidthPercent < MIN_BB_WIDTH_PERCENT) { isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${bbWidthPercent.toFixed(2)}) çok dar.`; signal = 'WAIT'; confidenceScore = 50; }
                 else if (bbWidthPercent > MAX_BB_WIDTH_PERCENT) { isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${bbWidthPercent.toFixed(2)}) çok geniş.`; signal = 'WAIT'; confidenceScore = 50; }
            }

            if (!isFiltered) {
                 if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
                 reason += `. R/R: ${rrRatio.toFixed(2)}.`;
            }
        } else if (isFiltered) {
            confidenceScore = 50;
        }

        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, BOLLINGER_PERIOD, signal) : null;

        resultData = {
            id: isManual ? Date.now() : fullSymbol + '-' + signal + '-' + Date.now() + '-STOCHEMA',
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: Math.min(95, confidenceScore).toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION),
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
            RR: rrRatio.toFixed(2), timestamp: Date.now(),
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---',
            reason: reason, volume: lastVolume ? lastVolume.toFixed(2) : '---', volumeStatus: volumeStatus, isFiltered: isFiltered
        };

        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[32m>>> 15m STOCH+EMA SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }

    } catch (error) {
        if (isManual || isWatchlist) return { error: `Stoch+EMA Analiz Hatası: ${error.message}` };
        console.error(`[Stoch+EMA Analiz Hatası (${ccxtSymbol})]: ${error.message}`);
        return null;
    }
}


/**
 * STRATEJİ 2 (2h): Kırılım Stratejisi
 */
async function analyzeBreakoutCoin(ccxtSymbol) {
     let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = fullSymbol + '-BREAKOUT'; if (signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredCandles = BREAKOUT_LOOKBACK_PERIOD + 1; const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, BREAKOUT_TIMEFRAME, undefined, requiredCandles);
        if (!ohlcv || ohlcv.length < requiredCandles) return null;
        const marketCondition = await checkMarketCondition(ccxtSymbol);

        const lastCandle = ohlcv[ohlcv.length - 1]; const previousCandles = ohlcv.slice(0, ohlcv.length - 1);
        const lastClosePrice = lastCandle[4]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null; const lastVolume = lastCandle[5];
        let highestHigh = 0; let lowestLow = Infinity; let volumeSum = 0;
        for (const candle of previousCandles) { const high = candle[2]; const low = candle[3]; const volume = candle[5]; if (high > highestHigh) high = high; if (low < lowestLow) low = low; if(typeof volume === 'number' && !isNaN(volume)) volumeSum += volume; }
        if (highestHigh === 0 || lowestLow === Infinity || previousCandles.length === 0) return null;
        const avgVolume = volumeSum / previousCandles.length; if(isNaN(avgVolume) || avgVolume <= 0) return null;

        const overallTrend = marketCondition.overallTrend;

        let signal = 'WAIT'; let reason = ''; let confidence = 75; let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + BREAKOUT_BUFFER_PERCENT / 100); const breakoutBufferLow = lowestLow * (1 - BREAKOUT_BUFFER_PERCENT / 100);
        const isVolumeConfirmed = lastVolume >= avgVolume * BREAKOUT_VOLUME_MULTIPLIER;
        if (lastClosePrice > breakoutBufferHigh) { signal = 'LONG'; reason = `2h Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`; }
        else if (lastClosePrice < breakoutBufferLow) { signal = 'SHORT'; reason = `2h Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`; }

        if (signal !== 'WAIT') {
            if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi (${MARKET_FILTER_TIMEFRAME}) Yükselişte.`; signal = 'WAIT'; confidence = 60; }
            else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi (${MARKET_FILTER_TIMEFRAME}) Düşüşte.`; signal = 'WAIT'; confidence = 60; }
            if (!isFiltered) { if (!isVolumeConfirmed) { isFiltered = true; reason += ` - Hacim Teyidi Eksik`; signal = 'WAIT'; confidence = 60; } else { reason += ' - Hacim Teyitli'; confidence = 95; } }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            // Yüzde Bazlı TP/SL Hesaplaması
            if (signal === 'LONG') {
                takeProfit = lastClosePrice * (1 + BREAKOUT_TP_PERCENTAGE / 100);
                stopLoss = lastClosePrice * (1 - BREAKOUT_SL_PERCENTAGE / 100);
            } else if (signal === 'SHORT') {
                takeProfit = lastClosePrice * (1 - BREAKOUT_TP_PERCENTAGE / 100);
                stopLoss = lastClosePrice * (1 + BREAKOUT_SL_PERCENTAGE / 100);
            }
            rrRatio = BREAKOUT_RR_RATIO; // 2.5
            signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
        }

        // Fibonacci Öngörüsü
        const forecastLevel = signal !== 'WAIT'
            ? calculateFibonacciExtension(ohlcv, BREAKOUT_LOOKBACK_PERIOD, signal)
            : null;

        // Final Sinyal Çıktısı
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-BRK', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), // Giriş Fiyatı
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
            RR: rrRatio.toFixed(2),
            timestamp: Date.now(), // Zaman damgası kullanılıyor
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---',
            reason: reason, volume: lastVolume.toFixed(2), volumeStatus: `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)}`, isFiltered: isFiltered
        };
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[36m>>> KIRILIM SİNYALİ (2h): ${resultData.symbol} - ${resultData.signal}\x1b[0m`);
            return resultData;
        }
        else { return null; }
    } catch (error) { return null; }
}

// --- YARDIMCI FONKSİYONLAR VE SERVER BAŞLANGICI ---

async function runWatchlistScan() {
    if (Object.keys(globalWatchlist).length === 0) return; let updatedWatchlist = {};
    for (const [symbol, item] of Object.entries(globalWatchlist)) {
        try {
            const analysisResult = await analyzeStochEMACoin(item.ccxtSymbol, false, true); // Stoch+EMA kullanılır
            if (analysisResult) {
                updatedWatchlist[symbol] = {
                    ...item, ...analysisResult,
                    statusClass: analysisResult.signal === 'LONG' ? 'bg-long' : (analysisResult.signal === 'SHORT' ? 'bg-short' : 'bg-wait')
                };
            }
            else { updatedWatchlist[symbol] = item; }
        } catch (e) { console.error(`Watchlist Analiz Hatası (${symbol})`, e.message); updatedWatchlist[symbol] = item; }
    } globalWatchlist = updatedWatchlist; io.emit('watchlist_update', globalWatchlist);
}

async function runScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    global.APP_STATE.scanStatus = { message: `15m Stoch+EMA Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);

    try {
        if (globalTargetList.length === 0) {
            console.log(`\x1b[33m--- 15m TARAMA ATLANDI: Hedef liste boş.\x1b[0m`);
            return;
        }
        const allSwapSymbols = globalTargetList;

        console.log(`\n--- 15m STOCH+EMA TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeStochEMACoin(ccxtSymbol, false, false);
                if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { }
        }
    } catch (error) { console.error("Kritik 15m Stoch+EMA Tarama Hatası:", error.message); exchange.markets = {}; }
    finally {
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             let cooldownKey;
             if(s.id?.endsWith('-BRK')) cooldownKey = s.symbol + '-BREAKOUT';
             else if(s.id?.endsWith('-STOCHEMA')) cooldownKey = s.symbol + '-STOCHEMA';
             else cooldownKey = s.symbol;
             const cooldownEntry = signalCooldowns[cooldownKey];
             return cooldownEntry && cooldownEntry.timestamp > temizelemeZamani;
        });

        global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false };
        io.emit('scan_status', global.APP_STATE.scanStatus);
        console.log(`--- 15m STOCH+EMA TARAMA TAMAMLANDI (${scanTimeStr}). ---`);
    }
}

async function runBreakoutScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();

    try {
        if (globalTargetList.length === 0) {
            console.log(`\x1b[33m--- 2h TARAMA ATLANDI: Hedef liste boş.\x1b[0m`);
            return;
        }
        const allSwapSymbols = globalTargetList;

        console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeBreakoutCoin(ccxtSymbol);
                if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2));
            } catch (loopError) { }
        }
    } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); exchange.markets = {}; }
    finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}

app.get('/', (req, res) => {
    console.log("==========================================");
    console.log(`[${new Date().toLocaleTimeString()}] Ana sayfa '/' isteği geldi.`);
    const filePath = path.join(__dirname, 'app.html');
    console.log(`[${new Date().toLocaleTimeString()}] app.html dosya yolu kontrol ediliyor: ${filePath}`);

    res.sendFile(filePath, (err) => {
        if (err) {
            console.error(`[${new Date().toLocaleTimeString()}] KRİTİK HATA: app.html GÖNDERİLEMEDİ:`, err.message);
            res.status(500).send("Sunucu Hatası: Ana sayfa yüklenemedi. Lütfen logları kontrol edin.");
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] app.html başarıyla gönderildi.`);
        }
    });
    console.log("==========================================");
});
io.on('connection', (socket) => {
    socket.emit('initial_state', global.APP_STATE);
    socket.emit('watchlist_update', globalWatchlist);
    // Sıcak Liste kaldırıldı
});

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol; if (!userSymbolInput) return res.status(400).json({ error: 'Sembol gönderilmedi.' });
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace('USDT', '').replace('PERP', '').trim(); const fullSymbol = cleanBaseSymbol + 'USDT';
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) { await exchange.loadMarkets(true); }
        const foundMarket = Object.values(exchange.markets).find(m => m.base === cleanBaseSymbol && m.quote === 'USDT' && m.swap && m.active);
        if (foundMarket) {
            const targetCcxtSymbol = foundMarket.symbol;
            const result = await analyzeStochEMACoin(targetCcxtSymbol, true, true);
            if (result && !result.error) {
                globalWatchlist[fullSymbol] = {
                    ccxtSymbol: targetCcxtSymbol, ...result,
                    statusClass: result.signal === 'LONG' ? 'bg-long' : (result.signal === 'SHORT' ? 'bg-short' : 'bg-wait')
                };
                io.emit('watchlist_update', globalWatchlist);
            }
            res.json(result);
        } else {
            res.json({ error: `'${userSymbolInput}' için Bitget'te aktif USDT Perpetual Swap marketi bulunamadı.` });
        }
    } catch(err) { console.error("Manuel analiz API hatası:", err); res.status(500).json({ error: `Sunucu hatası: ${err.message}` }); }
});

app.post('/api/remove-watchlist', (req, res) => {
    const symbol = req.body.symbol;
    if (globalWatchlist[symbol]) {
        delete globalWatchlist[symbol];
        io.emit('watchlist_update', globalWatchlist);
        res.json({ success: true, message: `${symbol} izleme listesinden kaldırıldı.` });
    } else {
        res.status(404).json({ error: 'Sembol izleme listesinde bulunamadı.' });
    }
});

server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V5.4 - Hacim Eşiği 0.8x) http://localhost:${PORT}`);
    console.log(`OTOMATİK TARAMA BAŞLIYOR...`);
    try {
        console.log("Market listesi yükleniyor...");
        exchange.markets = await exchange.loadMarkets(true);
        console.log(`Market listesi yüklendi (${Object.keys(exchange.markets).length} market).`);

        await runPreScan(); // Hedef Listeyi oluştur

    } catch (loadError) {
        console.error("Başlangıçta market/ön-tarama yüklenemedi! Hata:", loadError.message);
        exchange.markets = {};
    }

    runScan();
    runBreakoutScan();

    setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);

    setInterval(runPreScan, PRESCAN_INTERVAL); // Hedef Listeyi 5dk'da bir günceller

    setInterval(async () => {
        if (global.APP_STATE.scanStatus.isScanning) {
            console.log(`\x1b[33m--- 15m DERİN TARAMA ATLANDI: Önceki tarama hala sürüyor. \x1b[0m`);
            return;
        }
        await runScan();
    }, SCAN_INTERVAL);

    setInterval(runBreakoutScan, BREAKOUT_SCAN_INTERVAL);
});

console.log("--- server.js dosyası okunması tamamlandı ---");