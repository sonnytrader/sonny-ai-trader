// server.js (ANA PROJE - V12.1 - NİHAİ ESNEK SÜRÜM)
// SÜRÜM: V12.1 (Tüm Yazım Hataları Düzeltildi, 15m Esnek Stoch+EMA, 2h 1.5x Kırılım) (26.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V12.1 - Nihai Esnek Sürüm) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === V12.1 STRATEJİ AYARLARI ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 1000000; // 1 Milyon USDT Hacim
const SCAN_INTERVAL = 1 * 60 * 1000; 
const WATCHLIST_SCAN_INTERVAL = 5 * 1000;
const API_DELAY_MS = 100; 
const TIMEFRAME = '15m'; 
const TIMEFRAME_MTF = '1h';
const EMA_PERIOD = 50;
const BOLLINGER_PERIOD = 20; const BOLLINGER_STDDEV = 2; 
const RSI_PERIOD = 14; const STOCH_K = 14; const STOCH_D = 3; const STOCH_SMOOTH_K = 3;

const MIN_RR_RATIO = 0.75; // Sinyal sıklığı için R/R 0.75
const STOCH_VOLUME_MULTIPLIER = 1.0; // Hacim Puanlaması için eşik (Filtre değil)

const REQUIRED_CANDLE_BUFFER = 100;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

// 2h KIRILIM AYARLARI (1.5x Teyitli)
const BREAKOUT_TIMEFRAME = '2h'; const BREAKOUT_LOOKBACK_PERIOD = 50;
const BREAKOUT_SCAN_INTERVAL = 30 * 60 * 1000; const BREAKOUT_BUFFER_PERCENT = 0.1;
const BREAKOUT_VOLUME_MULTIPLIER = 1.5; // <<< KRİTİK: 1.5x (Eski çalışan ayar)
const BREAKOUT_TP_PERCENTAGE = 5.0; const BREAKOUT_SL_PERCENTAGE = 2.0;
const BREAKOUT_RR_RATIO = 2.5; 
const MARKET_FILTER_TIMEFRAME = '4h'; const MARKET_FILTER_EMA_PERIOD = 200;


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
function calculateEMA(closes, period) {
    if (!Array.isArray(closes) || closes.length < period) return null; 
    const k = 2 / (period + 1);
    let initialData = closes.slice(0, period);
    if (initialData.length < period) return null; 
    let ema = calculateSMA(initialData, period);
    if (ema === null) return null;
    let emaArray = [ema]; 
    for (let i = period; i < closes.length; i++) {
        if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null;
        ema = (closes[i] * k) + (ema * (1 - k));
        emaArray.push(ema);
    }
    return isNaN(ema) ? emaArray : null; 
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
    const rs = avgLoss === 0 ? 10000 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return isNaN(rsi) ? null : rsi;
}
function calculateStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    try {
        if (!closes || closes.length < rsiPeriod + 1) return null;
        let rsiValues = []; let gains = [], losses = [];
        for (let i = 1; i < closes.length; i++) {
            const currentClose = closes[i]; const prevClose = closes[i-1];
            if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) continue;
            const diff = currentClose - prevClose;
            gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0);
        }
        if (gains.length < rsiPeriod) return null;
        let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
        let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
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
        for (let i = dSmooth - 1; i < slowKValues.length; i++) { const dSlice = slowKValues.slice(i - dSmooth + 1, i + 1); if(dSlice.length < dSmooth) continue; const smaD = calculateSMA(dSlice, dSmooth); if (smaD !== null) slowDValues.push(smaD); }
        const K = slowKValues.length > 0 ? slowKValues[slowKValues.length - 1] : null;
        const D = slowDValues.length > 0 ? slowDValues[slowDValues.length - 1] : null;
        const prevK = slowKValues.length > 1 ? slowKValues[slowKValues.length - 2] : null;
        const prevD = slowDValues.length > 1 ? slowDValues[slowDValues.length - 2] : null;
        if (K === null || D === null || isNaN(K) || isNaN(D)) return null;
        return { K, D, prevK, prevD };
    } catch (e) { return null; }
}
async function checkMTF_EMA(ccxtSymbol) {
    const requiredCandleCount = EMA_PERIOD + 5;
    try {
        const ohlcv1h = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME_MTF, undefined, requiredCandleCount);
        if (!ohlcv1h || ohlcv1h.length < EMA_PERIOD) return null;
        const closes1h = ohlcv1h.map(m => m[4]);
        const ema1hArray = calculateEMA(closes1h, EMA_PERIOD);
        if (ema1hArray === null) return null;
        const ema1h = ema1hArray[ema1hArray.length - 1];
        const lastClosePrice1h = closes1h[closes1h.length - 1];
        return {
            isUptrend: lastClosePrice1h > ema1h,
            isDowntrend: lastClosePrice1h < ema1h,
            trendStatus: lastClosePrice1h > ema1h ? 'YÜKSELİŞ' : (lastClosePrice1h < ema1h ? 'DÜŞÜŞ' : 'YAN'),
            emaValue: ema1h
        };
    } catch (e) { return null; }
}
async function checkMarketCondition(ccxtSymbol) {
    const requiredCandleCount = MARKET_FILTER_EMA_PERIOD + 50;
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, MARKET_FILTER_TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < MARKET_FILTER_EMA_PERIOD) return { overallTrend: 'UNKNOWN' };
        const closes = ohlcv.map(m => m[4]); const ema200Array = calculateEMA(closes, MARKET_FILTER_EMA_PERIOD);
        if (!ema200Array) return { overallTrend: 'UNKNOWN' };
        const lastClosePrice = closes[closes.length - 1]; const lastEma200 = ema200Array[ema200Array.length - 1];
        if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' };
        else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' };
        else return { overallTrend: 'SIDEWAYS' };
    } catch (e) { return { overallTrend: 'UNKNOWN' }; }
}
function calculateVWAP(ohlcv) {
    if (!ohlcv || ohlcv.length === 0) return null;
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;
    for (const candle of ohlcv) {
        const typicalPrice = (candle[2] + candle[3] + candle[4]) / 3;
        cumulativePriceVolume += typicalPrice * candle[5];
        cumulativeVolume += candle[5];
    }
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
}


/**
 * AŞAMA 1 - HIZLI ÖN TARAYICI
 */
async function runPreScan() {
    const scanTime = new Date().toLocaleTimeString();
    console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLANGICI (${scanTime}) ---`);
    let newTargetList = [];
    if (!exchange.markets || Object.keys(exchange.markets).length === 0) return;

    try {
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) return;
        const allTickers = Object.values(tickers);
        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol) continue;
            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;
            if (market && market.swap && market.active && market.quote === 'USDT' &&
                quoteVolume && quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT
            ) {
                newTargetList.push(ticker.symbol);
            }
        }
        globalTargetList = newTargetList;
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${globalTargetList.length} coin hedefe alındı (Hacim > 1M).\x1b[0m`);
    } catch (error) { console.error(`Kritik Ön Tarama Hatası: ${error.message}`); }
}


/**
 * STRATEJİ 1 (15m): V12.0 - Stoch+EMA (VWAP Puanlama, R/R 0.75, ESNEK HACİM/MTF)
 */
async function analyzeStochEMACoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-STOCHEMA';
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredCandleCount = REQUIRED_CANDLE_BUFFER + 50;
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < 50) return null;
        const mtfTrend = await checkMTF_EMA(ccxtSymbol);

        const closes = ohlcv.map(m => m[4]).filter(v => typeof v === 'number' && !isNaN(v));
        const volumes = ohlcv.map(m => m[5]).filter(v => typeof v === 'number' && !isNaN(v));
        if (closes.length < 50 || volumes.length < 50) return null;

        const lastClosePrice = closes[closes.length - 1]; 

        // Göstergeleri Hesapla
        const emaArray = calculateEMA(closes, EMA_PERIOD); const ema = emaArray ? emaArray[emaArray.length - 1] : null;
        const bb = calculateBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STDDEV);
        const stochRSI = calculateStochasticRSI(closes, RSI_PERIOD, STOCH_K, STOCH_SMOOTH_K, STOCH_D);
        const vwap = calculateVWAP(ohlcv.slice(-BOLLINGER_PERIOD)); 

        const isMtfUptrend = mtfTrend ? mtfTrend.isUptrend : false;
        const isMtfDowntrend = mtfTrend ? mtfTrend.isDowntrend : false;
        const mtfStatus = mtfTrend?.trendStatus || 'Bilinmiyor';

        if (bb === null || stochRSI === null || ema === null || vwap === null) return null;

        const { upperBand, lowerBand, middleBand } = bb; const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        let signal = 'WAIT'; let reason = ''; let confidence = 50; let isFiltered = false;

        // Hacim Kontrolü (1.0x)
        const lastVolume = volumes[volumes.length - 1]; const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), BOLLINGER_PERIOD);
        let volumeStatus = 'Normal'; 
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * STOCH_VOLUME_MULTIPLIER;
        if (isVolumeStrong) { volumeStatus = `Yeterli (${(lastVolume / avgVolume).toFixed(1)}x)`; } 
        else if (avgVolume) { volumeStatus = `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`; } 
        
        // Sinyal Tetikleyicileri
        const stochBullishCross = prevK <= prevD && stochK > stochD; const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversold = stochK < 30; const stochOverbought = stochK > 70;
        const is15mUptrend = lastClosePrice > ema; const is15mDowntrend = lastClosePrice < ema;
        const isVwapUptrend = lastClosePrice > vwap; const isVwapDowntrend = lastClosePrice < vwap;
        const touchedLowerBB = lastClosePrice <= lowerBand; const touchedUpperBB = lastClosePrice >= upperBand;
        let stochTriggerType = 'Yan'; let bbTriggerType = 'Bant İçi';

        // Sinyal Mantığı: 15m Trendini Baz Al
        if (is15mUptrend) {
            if (stochBullishCross && stochOversold && touchedLowerBB) { signal = 'LONG'; stochTriggerType = 'Aşırı Satımdan Kesişim'; bbTriggerType = 'Alt BB Teması'; }
            else if (stochBullishCross && stochK < 50) { signal = 'LONG'; stochTriggerType = 'Orta Kesişim (50 Altı)'; }
        }
        else if (is15mDowntrend) {
            if (stochBearishCross && stochOverbought && touchedUpperBB) { signal = 'SHORT'; stochTriggerType = 'Aşırı Alımdan Kesişim'; bbTriggerType = 'Üst BB Teması'; }
            else if (stochBearishCross && stochK > 50) { signal = 'SHORT'; stochTriggerType = 'Orta Kesişim (50 Üstü)'; }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT') {
            if (signal === 'LONG') { takeProfit = upperBand; stopLoss = lowerBand; }
            else if (signal === 'SHORT') { takeProfit = lowerBand; stopLoss = upperBand; }
            const risk = Math.abs(lastClosePrice - stopLoss);
            const reward = Math.abs(takeProfit - lastClosePrice);
            rrRatio = risk > 0 ? reward / risk : 0;
        }

        // --- FİLTRELEME (ESNEK) ---
        if (signal !== 'WAIT') {
            
            // 1. R/R FİLTRESİ (MUTLAK)
            if (rrRatio < MIN_RR_RATIO) { // 0.75'ten düşükse reddet
                isFiltered = true; reason = `FİLTRELENDİ: R/R Oranı (${rrRatio.toFixed(2)}) çok düşük (Min: ${MIN_RR_RATIO}).`; signal = 'WAIT'; confidence = 55;
            }
            
            // 2. BB GENİŞLİĞİ KONTROLÜ (MUTLAK)
            if (!isFiltered) {
                const bbWidthPercent = ((upperBand - lowerBand) / middleBand) * 100;
                if (bbWidthPercent < 0.05 || bbWidthPercent > 5.0) { isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${bbWidthPercent.toFixed(2)}) uygun değil.`; signal = 'WAIT'; confidence = 55; }
            }
            
            // 3. MTF, VWAP ve HACİM PUANLAMASI (Sadece puanlama)
            if (!isFiltered) {
                let vwapStatusText = 'VWAP Uyumlu';
                let mtfTeyitText = 'MTF Uyumlu';
                confidence = 70; // Temel puan

                // VWAP Puanlaması
                if (!((signal === 'LONG' && isVwapUptrend) || (signal === 'SHORT' && isVwapDowntrend))) {
                    vwapStatusText = `VWAP Ters`; 
                    confidence -= 10; 
                }
                
                // MTF Puanlaması
                if (mtfTrend && !((signal === 'LONG' && isMtfUptrend) || (signal === 'SHORT' && isMtfDowntrend))) {
                    mtfTeyitText = `MTF Ters (${mtfStatus})`;
                    confidence -= 10; 
                }

                // Hacim Puanlaması
                if (!isVolumeStrong) { reason += ` [Hacim Düşük: ${volumeStatus}]`; confidence -= 10; } // Düşük hacim ciddi ceza
                else { reason += ` [Hacim Teyitli]`; confidence += 10; } // Güçlü hacim bonusu

                // Sinyal Onaylandı
                confidence += (rrRatio * 5); // R/R bonusu
                confidence = Math.min(Math.max(confidence, 0), 95); // 0-95 arası
                
                reason = `ONAYLANDI (R/R: ${rrRatio.toFixed(2)}). Strateji: ${stochTriggerType} + ${bbTriggerType}. | MTF: ${mtfTeyitText}. | VWAP: ${vwapStatusText}`;
                if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
            }
        }

        // Fibonacci Öngörüsü (Geri Eklendi)
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, 50, signal) : null; 
        let finalSignal = signal; let finalReason = reason;
        if (isManual || isWatchlist) { if (isFiltered) { finalSignal = 'REDDEDİLDİ'; } }

        // Final Sinyal Çıktısı
        const vwapStatusTextOutput = vwap !== null ? (lastClosePrice > vwap ? 'VWAP Üzerinde' : (lastClosePrice < vwap ? 'VWAP Altında' : 'VWAP Çevresinde')) : 'Bilinmiyor';
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-STOCHEMA',
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: finalSignal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), 
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', 
            reason: finalReason, 
            volume: lastVolume ? lastVolume.toFixed(2) : '---', volumeStatus: volumeStatus, isFiltered: isFiltered, vwapStatus: vwapStatusTextOutput
        };

        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[32m>>> V12.0 STOCH+EMA SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { console.error(`[Stoch+EMA Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


/**
 * STRATEJİ 2 (2h): Kırılım Stratejisi (1.5x Teyitli)
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
        for (const candle of previousCandles) { const high = candle[2]; const low = candle[3]; const volume = candle[5]; if (high > highestHigh) highestHigh = high; if (low < lowestLow) lowestLow = low; if(typeof volume === 'number' && !isNaN(volume)) volumeSum += volume; }
        if (highestHigh === 0 || lowestLow === Infinity || previousCandles.length === 0) return null;
        const avgVolume = volumeSum / previousCandles.length; if(isNaN(avgVolume) || avgVolume <= 0) return null;

        const overallTrend = marketCondition.overallTrend;

        let signal = 'WAIT'; let reason = ''; let confidence = 75; let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + BREAKOUT_BUFFER_PERCENT / 100); const breakoutBufferLow = lowestLow * (1 - BREAKOUT_BUFFER_PERCENT / 100);
        const isVolumeConfirmed = lastVolume >= avgVolume * BREAKOUT_VOLUME_MULTIPLIER; // 1.5x Kontrolü
        const isBalinaConfirmed = lastVolume >= avgVolume * 2.0; // Balina bonusu için 2.0x
        const volumeStatusText = isBalinaConfirmed ? `BALİNA TEYİTLİ (${(lastVolume / avgVolume).toFixed(1)}x)` : (isVolumeConfirmed ? `Yüksek (${(lastVolume / avgVolume).toFixed(1)}x)` : `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`);
        
        if (lastClosePrice > breakoutBufferHigh) { signal = 'LONG'; reason = `2h Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`; }
        else if (lastClosePrice < breakoutBufferLow) { signal = 'SHORT'; reason = `2h Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`; }

        if (signal !== 'WAIT') {
            if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Düşüş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }
            else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Yükseliş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }
            if (!isFiltered) { 
                if (!isVolumeConfirmed) { // 1.5x altında ise reddet
                    isFiltered = true; 
                    reason += ` - Hacim Teyidi Eksik (${(lastVolume / avgVolume).toFixed(1)}x). Min ${BREAKOUT_VOLUME_MULTIPLIER}x gerekli.`; 
                    signal = 'WAIT'; confidence = 60; 
                } else if (isBalinaConfirmed) { // 2.0x üzerinde ise Balina Teyidi
                    reason += ` - BALİNA TEYİTLİ (${(lastVolume / avgVolume).toFixed(1)}x)`; 
                    confidence = 98; 
                } else { // 1.5x ile 2.0x arasında ise
                    reason += ` - Hacim Teyitli (${(lastVolume / avgVolume).toFixed(1)}x)`; 
                    confidence = 90; // Normal yüksek güven
                }
            }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            // Yüzde Bazlı TP/SL Hesaplaması
            if (signal === 'LONG') { takeProfit = lastClosePrice * (1 + BREAKOUT_TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 - BREAKOUT_SL_PERCENTAGE / 100); } 
            else if (signal === 'SHORT') { takeProfit = lastClosePrice * (1 - BREAKOUT_TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 + BREAKOUT_SL_PERCENTAGE / 100); }
            rrRatio = BREAKOUT_RR_RATIO; // 2.5
            signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
        }

        // Fibonacci Öngörüsü
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, BREAKOUT_LOOKBACK_PERIOD, signal) : null;

        // Final Sinyal Çıktısı
        const volumeStatusFinal = `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)} (${volumeStatusText})`;
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-BRK', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: confidence.toFixed(0), 
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', 
            reason: reason, volume: lastVolume.toFixed(2), volumeStatus: volumeStatusFinal, isFiltered: isFiltered
        };
        if (signal !== 'WAIT' && !isFiltered) { console.log(`\x1b[36m>>> 2h KIRILIM SİNYALİ: ${resultData.symbol} - ${resultData.signal}\x1b[0m`); return resultData; }
        else { return null; }
    } catch (error) { return null; }
}


// --- YARDIMCI FONKSİYONLAR VE SERVER BAŞLANGICI ---

async function runWatchlistScan() {
    if (Object.keys(globalWatchlist).length === 0) return; let updatedWatchlist = {};
    for (const [symbol, item] of Object.entries(globalWatchlist)) {
        try {
            const analysisResult = await analyzeStochEMACoin(item.ccxtSymbol, false, true);  // Stoch+EMA çağrısı
            if (analysisResult) { 
                updatedWatchlist[symbol] = { 
                    ...item, ...analysisResult, 
                    statusClass: analysisResult.signal === 'LONG' ? 'bg-long' : (analysisResult.signal === 'SHORT' ? 'bg-short' : (analysisResult.isFiltered ? 'status-reddet' : 'bg-wait'))
                }; 
            } else { 
                updatedWatchlist[symbol] = item; 
            }
        } catch (e) { updatedWatchlist[symbol] = item; }
    } globalWatchlist = updatedWatchlist; io.emit('watchlist_update', globalWatchlist);
}


async function runScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    global.APP_STATE.scanStatus = { message: `15m Stoch+EMA Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);
    
    try {
        if (globalTargetList.length === 0) return;
        const allSwapSymbols = globalTargetList; 

        console.log(`\n--- 15m STOCH+EMA TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeStochEMACoin(ccxtSymbol, false, false); // Stoch+EMA çağrısı
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { console.error(`[Döngü Hatası]: ${loopError.message}`); } 
        }
    } catch (error) { console.error("Kritik 15m Tarama Hatası:", error.message); }
    finally {
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             let cooldownKey = s.symbol + (s.id?.endsWith('-BRK') ? '-BREAKOUT' : '-STOCHEMA'); // Stoch+EMA etiketi
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
        if (globalTargetList.length === 0) return;
        const allSwapSymbols = globalTargetList;
        console.log(`\n--- 2h (1.5x) KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeBreakoutCoin(ccxtSymbol);
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2));
            } catch (loopError) { }
        }
    } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); }
    finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}

app.get('/', (req, res) => { 
    const filePath = path.join(__dirname, 'app.html');
    res.sendFile(filePath, { headers: { 'Content-Type': 'text/html' } }, (err) => {
        if (err) {
            console.error(`app.html gönderme hatası: ${err.message}. Lütfen dosyanın varlığını kontrol edin.`);
            res.status(500).send("Sunucu Hatası: Ana sayfa yüklenemedi. Dosya yolu hatası olabilir.");
        }
    });
});
io.on('connection', (socket) => { socket.emit('initial_state', global.APP_STATE); socket.emit('watchlist_update', globalWatchlist); });
app.post('/api/remove-watchlist', (req, res) => {
    const symbol = req.body.symbol;
    if (globalWatchlist[symbol]) { delete globalWatchlist[symbol]; io.emit('watchlist_update', globalWatchlist); res.json({ success: true, message: `${symbol} izleme listesinden kaldırıldı.` }); } 
    else { res.status(404).json({ error: 'Sembol izleme listesinde bulunamadı.' }); }
});

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol; if (!userSymbolInput) return res.status(400).json({ error: 'Sembol gönderilmedi.' });
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace('USDT', '').replace('PERP', '').trim(); const fullSymbol = cleanBaseSymbol + 'USDT';
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) { await exchange.loadMarkets(true); }
        const foundMarket = Object.values(exchange.markets).find(m => m.base === cleanBaseSymbol && m.quote === 'USDT' && m.swap && m.active);
        if (foundMarket) {
            const targetCcxtSymbol = foundMarket.symbol;
            const result = await analyzeStochEMACoin(targetCcxtSymbol, true, true);  // Stoch+EMA çağrısı
            if (result && !result.error && !result.isFiltered) {
                globalWatchlist[fullSymbol] = {
                    ccxtSymbol: targetCcxtSymbol, ...result, statusClass: result.signal === 'LONG' ? 'bg-long' : (result.signal === 'SHORT' ? 'bg-short' : (result.isFiltered ? 'status-reddet' : 'bg-wait'))
                };
                io.emit('watchlist_update', globalWatchlist);
            }
            res.json(result);
        } else { res.json({ error: `'${userSymbolInput}' için Bitget'te aktif USDT Perpetual Swap marketi bulunamadı.` }); }
    } catch(err) { console.error("Manuel analiz API hatası:", err); res.status(500).json({ error: `Sunucu hatası: ${err.message}` }); }
});


server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V12.0 - Nihai Esnek Sürüm) http://localhost:${PORT}`);
    console.log(`OTOMATİK TARAMA BAŞLIYOR...`);
    try {
        await exchange.loadMarkets(true);
        await runPreScan(); 
    } catch (loadError) { console.error("Başlangıçta market/ön-tarama yüklenemedi! Hata:", loadError.message); }
    
    runScan(); runBreakoutScan();
    setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
    setInterval(runPreScan, PRESCAN_INTERVAL);
    setInterval(async () => { if (!global.APP_STATE.scanStatus.isScanning) { await runScan(); } }, SCAN_INTERVAL); 
    setInterval(runBreakoutScan, BREAKOUT_SCAN_INTERVAL); 
});

console.log("--- server.js dosyası okunması tamamlandı ---");