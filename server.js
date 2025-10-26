// server.js (ANA PROJE - SÜPER HİBRİT V7.7 - MAKSİMUM SİNYAL)
// SÜRÜM: V7.7 (2M Ön Tarama, 0.5x Hacim, VWAP/MTF Puanlama, R/R 0.75) (26.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V7.7 - Süper Hibrit) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === AYARLAR ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 2000000; // 2 Milyon USDT
const SCAN_INTERVAL = 1 * 60 * 1000; 
const WATCHLIST_SCAN_INTERVAL = 1 * 1000; // 1 SANİYE (Anlık Takip)
const API_DELAY_MS = 100; 
const TIMEFRAME = '15m';
const TIMEFRAME_MTF = '1h';
const EMA_PERIOD = 50;
const BOLLINGER_PERIOD = 20; const BOLLINGER_STDDEV = 2; 
const RSI_PERIOD = 14; const STOCH_K = 14; const STOCH_D = 3; const STOCH_SMOOTH_K = 3;
const MIN_RR_RATIO = 0.75; // <<< KRİTİK DEĞİŞİKLİK: Minimum Risk/Kazanç Oranı 0.75
const REQUIRED_CANDLE_BUFFER = 50; 
const MIN_BB_WIDTH_PERCENT = 0.05;
const MAX_BB_WIDTH_PERCENT = 5.0;
const MIN_VOLUME_MULTIPLIER = 0.5; 
const BREAKOUT_TIMEFRAME = '2h'; const BREAKOUT_LOOKBACK_PERIOD = 50;
const BREAKOUT_SCAN_INTERVAL = 30 * 60 * 1000; const BREAKOUT_BUFFER_PERCENT = 0.1;
const BREAKOUT_VOLUME_MULTIPLIER = 1.5;
const BREAKOUT_TP_PERCENTAGE = 5.0; const BREAKOUT_SL_PERCENTAGE = 2.0;
const BREAKOUT_RR_RATIO = BREAKOUT_SL_PERCENTAGE > 0 ? BREAKOUT_TP_PERCENTAGE / BREAKOUT_SL_PERCENTAGE : 1.0; 
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
function calculateEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = calculateSMA(closes.slice(0, period), period);
    if (ema === null) return null;
    for (let i = period; i < closes.length; i++) {
        if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null;
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return isNaN(ema) ? null : ema;
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
        const ema1h = calculateEMA(closes1h, EMA_PERIOD);
        if (ema1h === null) return null;
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
function calculateFibonacciExtension(ohlcv, period, signalType) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevantOhlcv = ohlcv.slice(-period);
    let high = 0; let low = Infinity;
    for (const candle of relevantOhlcv) { if (candle[2] > high) high = candle[2]; if (candle[3] < low) low = candle[3]; }
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
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${globalTargetList.length} coin hedefe alındı (Hacim > 2M).\x1b[0m`);
    } catch (error) { console.error(`Kritik Ön Tarama Hatası: ${error.message}`); }
}


/**
 * STRATEJİ 1 (15m): Hibrit Stoch+EMA (VWAP Puanlama, R/R 0.75)
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
        
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < requiredCandleCount - REQUIRED_CANDLE_BUFFER + 10) return null;
        const mtfTrend = await checkMTF_EMA(ccxtSymbol);

        const closes = ohlcv.map(m => m[4]); const volumes = ohlcv.map(m => m[5]);
        const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null;

        // Göstergeleri Hesapla
        const ema = calculateEMA(closes, EMA_PERIOD);
        const bb = calculateBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STDDEV);
        const stochRSI = calculateStochasticRSI(closes, RSI_PERIOD, STOCH_K, STOCH_SMOOTH_K, STOCH_D);
        const vwap = calculateVWAP(ohlcv.slice(-BOLLINGER_PERIOD)); 

        const isMtfUptrend = mtfTrend ? mtfTrend.isUptrend : false;
        const isMtfDowntrend = mtfTrend ? mtfTrend.isDowntrend : false;
        const mtfStatus = mtfTrend?.trendStatus || 'Bilinmiyor';

        if (bb === null || stochRSI === null || ema === null || vwap === null) return null;

        const { upperBand, lowerBand, middleBand } = bb; const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        let signal = 'WAIT'; let reason = ''; let confidence = 50; let isFiltered = false;

        // Hacim Kontrolü (0.5x)
        const lastVolume = volumes[volumes.length - 1]; const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), BOLLINGER_PERIOD);
        let volumeStatus = 'Normal'; 
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * MIN_VOLUME_MULTIPLIER;
        if (isVolumeStrong) { volumeStatus = `Yeterli (${(lastVolume / avgVolume).toFixed(1)}x)`; } 
        else if (avgVolume) { volumeStatus = `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`; } 
        
        // Sinyal Tetikleyicileri
        const stochBullishCross = prevK <= prevD && stochK > stochD; const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversold = stochK < 30; const stochOverbought = stochK > 70;
        const is15mUptrend = lastClosePrice > ema; const is15mDowntrend = lastClosePrice < ema;
        const isVwapUptrend = lastClosePrice > vwap; const isVwapDowntrend = lastClosePrice < vwap;
        const touchedLowerBB = lastClosePrice <= lowerBand; const touchedUpperBB = lastClosePrice >= upperBand;
        let stochTriggerType = 'Yan'; let bbTriggerType = 'Bant İçi';

        // Sinyal Mantığı: SADECE 15m Trendini Baz Al (MTF ve VWAP Puanı Düşürecek)
        if (is15mUptrend) {
            if (stochBullishCross && stochK < 30 && touchedLowerBB) { signal = 'LONG'; stochTriggerType = 'Aşırı Satımdan Kesişim'; bbTriggerType = 'Alt BB Teması'; }
            else if (stochBullishCross && stochK < 50) { signal = 'LONG'; stochTriggerType = 'Orta Kesişim (50 Altı)'; }
        }
        else if (is15mDowntrend) {
            if (stochBearishCross && stochK > 70 && touchedUpperBB) { signal = 'SHORT'; stochTriggerType = 'Aşırı Alımdan Kesişim'; bbTriggerType = 'Üst BB Teması'; }
            else if (stochBearishCross && stochK > 50) { signal = 'SHORT'; stochTriggerType = 'Orta Kesişim (50 Üstü)'; }
        }

        let takeProfit = null, stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT') {
            if (signal === 'LONG') { takeProfit = upperBand; stopLoss = lowerBand; }
            else if (signal === 'SHORT') { takeProfit = lowerBand; stopLoss = upperBand; }
            const risk = Math.abs(lastClosePrice - stopLoss);
            const reward = Math.abs(takeProfit - lastClosePrice);
            rrRatio = risk > 0 ? reward / risk : 0;
        }

        // --- MUTLAK FİLTRELEME (Sadece R/R ve BB Genişliği Mutlak Kalır) ---
        if (signal !== 'WAIT') {
            
            // 1. R/R FİLTRESİ (MUTLAK)
            if (rrRatio < MIN_RR_RATIO) { // 0.75'ten düşükse reddet
                isFiltered = true; reason = `FİLTRELENDİ: Risk/Kazanç Oranı (${rrRatio.toFixed(2)}) çok düşük (Min: ${MIN_RR_RATIO}).`; signal = 'WAIT'; confidence = 55;
            }
            
            // 2. BB GENİŞLİĞİ KONTROLÜ (MUTLAK)
            if (!isFiltered) {
                const bbWidthPercent = ((upperBand - lowerBand) / middleBand) * 100;
                if (bbWidthPercent < MIN_BB_WIDTH_PERCENT || bbWidthPercent > MAX_BB_WIDTH_PERCENT) { isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${bbWidthPercent.toFixed(2)}) uygun değil.`; signal = 'WAIT'; confidence = 55; }
            }
            
            // 3. MTF, VWAP ve HACİM PUANLAMASI (Mutlak Filtre Değil, Puanlama Yapılır)
            if (!isFiltered) {
                let vwapStatusText = 'VWAP Uyumlu';
                let mtfTeyitText = 'MTF Uyumlu';
                
                // VWAP Puanlaması
                if (!((signal === 'LONG' && isVwapUptrend) || (signal === 'SHORT' && isVwapDowntrend))) {
                    vwapStatusText = `VWAP Ters`; // Çıktıyı düzelt
                    confidence -= 10; // Ciddi puan cezası
                }
                
                // MTF Puanlaması
                if (!((signal === 'LONG' && isMtfUptrend) || (signal === 'SHORT' && isMtfDowntrend))) {
                    mtfTeyitText = `MTF Ters (${mtfStatus})`;
                    confidence -= 10; // Ciddi puan cezası
                }

                // Hacim Puanlaması
                if (!isVolumeStrong) { reason += ` [Hacim Düşük: ${volumeStatus}]`; confidence -= 5; }
                else { reason += ` [Hacim Teyitli]`; confidence += 5; }

                // Sinyal Onaylandı (Confidence güncellenir)
                confidence = Math.min(60 + (rrRatio * 10) + (isVolumeStrong ? 5 : 0), 95); 
                reason = `ONAYLANDI (R/R: ${rrRatio.toFixed(2)}). Strateji: ${stochTriggerType} + ${bbTriggerType}. | MTF: ${mtfTeyitText}. | VWAP: ${vwapStatusText}`;
                if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
            }
        }

        // Fibonacci Öngörü Hesaplaması (Geri Eklendi)
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, BOLLINGER_PERIOD, signal) : null;
        let finalSignal = signal; let finalReason = reason;
        if (isManual || isWatchlist) { if (isFiltered) { finalSignal = 'REDDEDİLDİ'; } }

        // Final Sinyal Çıktısı
        const vwapStatusTextOutput = vwap !== null ? (lastClosePrice > vwap ? 'VWAP Üzerinde' : (lastClosePrice < vwap ? 'VWAP Altında' : 'VWAP Çevresinde')) : 'Bilinmiyor';
        resultData = {
            id: isManual ? Date.now() : fullSymbol + '-' + signal + '-' + Date.now() + '-STOCHEMA',
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: finalSignal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), 
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', reason: finalReason, 
            volume: lastVolume.toFixed(2), volumeStatus: volumeStatus, isFiltered: isFiltered, vwapStatus: vwapStatusTextOutput
        };

        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[32m>>> 15m HİBRİT SİNYAL: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { return null; }
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
        for (const candle of previousCandles) { const high = candle[2]; const low = candle[3]; const volume = candle[5]; if (high > highestHigh) highestHigh = high; if (low < lowestLow) lowestLow = low; if(typeof volume === 'number' && !isNaN(volume)) volumeSum += volume; }
        if (highestHigh === 0 || lowestLow === Infinity || previousCandles.length === 0) return null;
        const avgVolume = volumeSum / previousCandles.length; if(isNaN(avgVolume) || avgVolume <= 0) return null;

        const overallTrend = marketCondition.overallTrend;

        let signal = 'WAIT'; let reason = ''; let confidence = 75; let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + BREAKOUT_BUFFER_PERCENT / 100); const breakoutBufferLow = lowestLow * (1 - BREAKOUT_BUFFER_PERCENT / 100);
        const isVolumeConfirmed = lastVolume >= avgVolume * BREAKOUT_VOLUME_MULTIPLIER;
        if (lastClosePrice > breakoutBufferHigh) { signal = 'LONG'; reason = `2h Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`; }
        else if (lastClosePrice < breakoutBufferLow) { signal = 'SHORT'; reason = `2h Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`; }

        if (signal !== 'WAIT') {
            if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Düşüş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }
            else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Yükseliş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }
            if (!isFiltered) { if (!isVolumeConfirmed) { isFiltered = true; reason += ` - Hacim Teyidi Eksik`; signal = 'WAIT'; confidence = 60; } else { reason += ' - Hacim Teyitli'; confidence = 95; } }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            // Yüzde Bazlı TP/SL Hesaplaması
            if (signal === 'LONG') { takeProfit = lastClosePrice * (1 + BREAKOUT_TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 - BREAKOUT_SL_PERCENTAGE / 100); } 
            else if (signal === 'SHORT') { takeProfit = lastClosePrice * (1 - BREAKOUT_TP_PERCENTAGE / 100); stopLoss = lastClosePrice * (1 + BREAKOUT_SL_PERCENTAGE / 100); }
            rrRatio = BREAKOUT_RR_RATIO; // 2.5
            signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
        }

        // Fibonacci Öngörüsü (Geri Eklendi)
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, BREAKOUT_LOOKBACK_PERIOD, signal) : null;

        // Final Sinyal Çıktısı
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-BRK', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: confidence.toFixed(0), 
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', 
            reason: reason, volume: lastVolume.toFixed(2), volumeStatus: `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)}`, isFiltered: isFiltered
        };
        if (signal !== 'WAIT' && !isFiltered) { console.log(`\x1b[36m>>> KIRILIM SİNYALİ (2h): ${resultData.symbol} - ${resultData.signal}\x1b[0m`); return resultData; }
        else { return null; }
    } catch (error) { return null; }
}


// --- YARDIMCI FONKSİYONLAR VE SERVER BAŞLANGICI ---

async function runWatchlistScan() {
    if (Object.keys(globalWatchlist).length === 0) return; let updatedWatchlist = {};
    for (const [symbol, item] of Object.entries(globalWatchlist)) {
        try {
            const analysisResult = await analyzeStochEMACoin(item.ccxtSymbol, false, true); 
            if (analysisResult) { 
                updatedWatchlist[symbol] = { 
                    ...item, ...analysisResult, 
                    statusClass: analysisResult.signal === 'LONG' ? 'bg-long' : (analysisResult.signal === 'SHORT' ? 'bg-short' : (analysisResult.isFiltered ? 'status-reddet' : 'bg-wait'))
                }; 
            }
            else { updatedWatchlist[symbol] = item; }
        } catch (e) { updatedWatchlist[symbol] = item; }
    } globalWatchlist = updatedWatchlist; io.emit('watchlist_update', globalWatchlist);
}


async function runScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    global.APP_STATE.scanStatus = { message: `15m Hibrit Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);
    
    try {
        if (globalTargetList.length === 0) return;
        const allSwapSymbols = globalTargetList; 

        console.log(`\n--- 15m HİBRİT TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeStochEMACoin(ccxtSymbol, false, false);
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { }
        }
    } catch (error) { console.error("Kritik 15m Tarama Hatası:", error.message); }
    finally {
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             let cooldownKey = s.symbol + (s.id?.endsWith('-BRK') ? '-BREAKOUT' : '-STOCHEMA');
             const cooldownEntry = signalCooldowns[cooldownKey];
             return cooldownEntry && cooldownEntry.timestamp > temizelemeZamani;
        });
        
        global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; 
        io.emit('scan_status', global.APP_STATE.scanStatus);
        console.log(`--- 15m HİBRİT TARAMA TAMAMLANDI (${scanTimeStr}). ---`);
    }
}

async function runBreakoutScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    try {
        if (globalTargetList.length === 0) return;
        const allSwapSymbols = globalTargetList; 

        console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
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
    // HTML'i metin olarak okuma sorununu çözmek için Content-Type zorunluluğu
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
            const result = await analyzeStochEMACoin(targetCcxtSymbol, true, true); 
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
    console.log(`🚀 Sonny AI Trader (V7.6 - Süper Hibrit) http://localhost:${PORT}`);
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