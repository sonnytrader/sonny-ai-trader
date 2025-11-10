const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V46.0 - Geliştirilmiş Risk Yönetimi) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// === V46.1 GELİŞMİŞ AYARLAR ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 500000;
const WATCHLIST_SCAN_INTERVAL = 30 * 1000;
const API_DELAY_MS = 100;
const TIMEFRAME_1H = '1h'; const TIMEFRAME_2H = '2h'; const TIMEFRAME_4H = '4h';
const BREAKOUT_BASE_ATR_PERIOD = 14; const BREAKOUT_BASE_RSI_PERIOD = 14; const BREAKOUT_BASE_BB_PERIOD = 20; const BREAKOUT_BASE_BB_STDDEV = 2; const BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK = 5.0;

// V46.1 GÜNCELLEME: MIN R/R 1.0 OLARAK AYARLANDI
const MIN_RISK_REWARD_RATIO = 1.0; 

const BRK1H_LOOKBACK_PERIOD = 50; const BRK1H_BUFFER_PERCENT = 0.1; const BRK1H_VOLUME_MULTIPLIER = 1.5; const BRK1H_SL_ATR_MULTIPLIER = 2.0; const BRK1H_RSI_LONG_THRESHOLD = 55; const BRK1H_RSI_SHORT_THRESHOLD = 45; const BREAKOUT_SCAN_INTERVAL_1H = 5 * 60 * 1000;
const BRK2H_LOOKBACK_PERIOD = 50; const BRK2H_BUFFER_PERCENT = 0.1; const BRK2H_VOLUME_MULTIPLIER = 1.5; const BRK2H_SL_ATR_MULTIPLIER = 2.0; const BRK2H_RSI_LONG_THRESHOLD = 55; const BRK2H_RSI_SHORT_THRESHOLD = 45; const BREAKOUT_SCAN_INTERVAL_2H = 5 * 60 * 1000;
const BRK4H_LOOKBACK_PERIOD = 40; const BRK4H_BUFFER_PERCENT = 0.15; const BRK4H_VOLUME_MULTIPLIER = 1.3; const BRK4H_SL_ATR_MULTIPLIER = 2.2; const BRK4H_RSI_LONG_THRESHOLD = 55; const BRK4H_RSI_SHORT_THRESHOLD = 45; const BREAKOUT_SCAN_INTERVAL_4H = 5 * 60 * 1000;

const MOMENTUM_1H_TIMEFRAME = TIMEFRAME_1H; const MOMENTUM_1H_LOOKBACK = 24; const MOMENTUM_1H_SCAN_INTERVAL = 10 * 60 * 1000; const MOMENTUM_1H_API_DELAY_MS = 250; const MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER = 3.0; const MOMENTUM_1H_PRICE_SPIKE_PERCENT = 1.5; const MOMENTUM_1H_COOLDOWN_MS = 30 * 60 * 1000;
const MOMENTUM_1H_SL_PERCENT_FALLBACK = 1.0; // V46.1 Yeni SL/TP ayarları
const MOMENTUM_1H_TP_PERCENT_FALLBACK = 2.0;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; const MARKET_FILTER_TIMEFRAME = TIMEFRAME_4H; const MARKET_FILTER_EMA_PERIOD = 200;

let signalCooldowns = {}; let globalWatchlist = {}; let globalTargetList = []; let momentumCooldowns = {};
global.APP_STATE = { signals: [], scanStatus: { message: 'Sunucu başlatılıyor...', isScanning: false } };
const exchange = new ccxt.bitget({ 'enableRateLimit': true, 'rateLimit': 200 });

// --- İNDİKATORLAR ---
function calculateSMA(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const sum = relevantData.reduce((a, b) => (a || 0) + (b || 0), 0); const sma = sum / period; return isNaN(sma) ? null : sma; }
function calculateEMA(closes, period) { if (!Array.isArray(closes) || closes.length < period) return null; const k = 2 / (period + 1); let emaArray = []; let firstSma = calculateSMA(closes.slice(0, period), period); if (firstSma === null) return null; emaArray.push(firstSma); for (let i = period; i < closes.length; i++) { if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null; const prevEma = emaArray[emaArray.length - 1]; let ema = (closes[i] * k) + (prevEma * (1 - k)); if (isNaN(ema)) return null; emaArray.push(ema); } return emaArray.length > 0 ? emaArray[emaArray.length - 1] : null; }
function calculateStdDev(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const mean = calculateSMA(relevantData, period); if (mean === null) return null; const squareDiffs = relevantData.map(value => Math.pow((value || 0) - mean, 2)); const sumSquareDiffs = squareDiffs.reduce((a, b) => a + b, 0); const variance = sumSquareDiffs / period; if (isNaN(variance) || variance < 0) return null; return Math.sqrt(variance); }
function calculateBollingerBands(closes, period, stdDevMultiplier) { if (!closes || closes.length < period) return null; let middleBandSmaArray = []; for (let i = period - 1; i < closes.length; i++) { const slice = closes.slice(i - period + 1, i + 1); const sma = calculateSMA(slice, period); if (sma === null) return null; middleBandSmaArray.push(sma); } if (middleBandSmaArray.length === 0) return null; const middleBand = middleBandSmaArray[middleBandSmaArray.length - 1]; const stdDev = calculateStdDev(closes.slice(-period), period); if (middleBand === null || stdDev === null || stdDev < 0) return null; const upperBand = middleBand + (stdDev * stdDevMultiplier); const lowerBand = middleBand - (stdDev * stdDevMultiplier); if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(middleBand)) return null; return { upperBand, middleBand, lowerBand }; }
function calculateRSI(closes, rsiPeriod = 14) { if (!Array.isArray(closes) || closes.length < rsiPeriod + 1) return null; let gains = []; let losses = []; for (let i = 1; i < closes.length; i++) { const currentClose = closes[i]; const prevClose = closes[i - 1]; if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) return null; const diff = currentClose - prevClose; gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0); } if (gains.length < rsiPeriod) return null; let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; for (let i = rsiPeriod; i < gains.length; i++) { avgGain = (avgGain * (rsiPeriod - 1) + gains[i]) / rsiPeriod; avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; const rsi = 100 - (100 / (1 + rs)); return isNaN(rsi) ? null : rsi; }
async function checkMarketCondition(ccxtSymbol) { const requiredCandleCount = MARKET_FILTER_EMA_PERIOD + 50; try { const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, MARKET_FILTER_TIMEFRAME, undefined, requiredCandleCount); if (!ohlcv || ohlcv.length < MARKET_FILTER_EMA_PERIOD) { return { overallTrend: 'UNKNOWN' }; } const closes = ohlcv.map(m => m[4]); const lastEma200 = calculateEMA(closes, MARKET_FILTER_EMA_PERIOD); if (lastEma200 === null) { return { overallTrend: 'UNKNOWN' }; } const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) { return { overallTrend: 'UNKNOWN' }; } if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' }; else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' }; else return { overallTrend: 'SIDEWAYS' }; } catch (e) { console.error(`\x1b[31m[checkMarketCondition Hatası (${ccxtSymbol})]: ${e.message}\x1b[0m`); return { overallTrend: 'UNKNOWN' }; } }
function calculateFibonacciExtension(ohlcv, period, signal) { if (!ohlcv || ohlcv.length < period) return null; const relevantData = ohlcv.slice(-period); const validLows = relevantData.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v)); const validHighs = relevantData.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v)); if (validLows.length === 0 || validHighs.length === 0) return null; const lowestLow = Math.min(...validLows); const highestHigh = Math.max(...validHighs); if (highestHigh <= lowestLow) return null; const range = highestHigh - lowestLow; let extensionLevel = null; if (signal === 'B. LONG' || signal === 'ANLIK LONG') { extensionLevel = highestHigh + (range * 0.618); } else if (signal === 'B. SHORT' || signal === 'ANLIK SHORT') { extensionLevel = lowestLow - (range * 0.618); } return isNaN(extensionLevel) ? null : extensionLevel; }
function calculateATR(ohlcv, period = 14) { if (!ohlcv || ohlcv.length < period + 1) return null; let trueRanges = []; for (let i = ohlcv.length - period -1; i < ohlcv.length -1; i++) { const currentCandle = ohlcv[i+1]; const prevCandle = ohlcv[i]; if (!currentCandle || currentCandle.length < 5 || !prevCandle || prevCandle.length < 5) continue; const high = currentCandle[2]; const low = currentCandle[3]; const prevClose = prevCandle[4]; if (typeof high !== 'number' || typeof low !== 'number' || typeof prevClose !== 'number') continue; const tr1 = high - low; const tr2 = Math.abs(high - prevClose); const tr3 = Math.abs(low - prevClose); const trueRange = Math.max(tr1, tr2, tr3); if (!isNaN(trueRange)) { trueRanges.push(trueRange); } } if (trueRanges.length < period) return null; const atr = calculateSMA(trueRanges, period); return isNaN(atr) ? null : atr; }
// --- İNDİKATOR FONKSİYONLARI SONU ---

/** AŞAMA 1 - HIZLI ÖN TARAYICI */
async function runPreScan() {
    const scanTime = new Date().toLocaleTimeString(); console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLANGICI (${scanTime}) ---`); let newTargetList = [];
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            console.warn("Ön tarama için marketler yüklenemedi, yeniden yükleniyor...");
            await exchange.loadMarkets(true);
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
                console.error("\x1b[31m[runPreScan HATA]: Marketler yeniden denemeye rağmen YÜKLENEMEDİ!\x1b[0m");
                globalTargetList = []; return;
            }
             console.log("[runPreScan] Marketler başarıyla yeniden yüklendi.");
        }
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) {
            console.warn("\x1b[33m[runPreScan UYARI]: Ön tarama ticker'ları alınamadı (API yanıtı boş olabilir).\x1b[0m");
            globalTargetList = []; return;
        }
        const allTickers = Object.values(tickers);
        let passedFilterCount = 0;
        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;
            if (market && market.active && market.swap && market.quote === 'USDT' && quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT) {
                newTargetList.push(ticker.symbol);
                passedFilterCount++;
            }
        }
        globalTargetList = newTargetList;
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${passedFilterCount} coin ${PRESCAN_MIN_24H_VOLUME_USDT} USDT hacim filtresini geçti. ${globalTargetList.length} coin hedefe alındı.\x1b[0m`);
    } catch (error) {
        console.error(`\x1b[31m[runPreScan KRİTİK HATA]: ${error.message}\x1b[0m`);
        globalTargetList = [];
    }
}


/** 🧠 V46.0 TAKTİKSEL ANALİZ MOTORU */
function generateTacticalAnalysis(data) {
    const { signal, anaTrend, rsi, hacimMultiplier, bbWidth, timeframe } = data;
    let analysis = "";
    let confidenceLevel = 40;

    // 1. Trend
    if (signal.includes('LONG') && anaTrend === 'UPTREND') { analysis += "✅ Ana Trend (4H) Yükselişte. "; confidenceLevel += 20; }
    else if (signal.includes('SHORT') && anaTrend === 'DOWNTREND') { analysis += "✅ Ana Trend (4H) Düşüşte. "; confidenceLevel += 20; }
    else if ((signal.includes('LONG') && anaTrend === 'DOWNTREND') || (signal.includes('SHORT') && anaTrend === 'UPTREND')) { analysis += `⚠️ Yüksek Risk (Ters Trend)! 4H Trend: ${anaTrend}. `; confidenceLevel -= 30; }
    else { analysis += "ℹ️ Yatay Piyasa (4H Trend). "; confidenceLevel += 0; }
    
    // 2. Hacim
    const hacimText = (hacimMultiplier || 0).toFixed(1);
    if (hacimMultiplier > 3.5) { analysis += `🐋 Balina Teyitli (${hacimText}x). `; confidenceLevel += 25; }
    else if (hacimMultiplier > 1.8) { analysis += `👍 Hacim Teyitli (${hacimText}x). `; confidenceLevel += 15; }
    else { analysis += `👎 Zayıf Hacim (${hacimText}x). `; confidenceLevel -= 20; }
    
    // 3. RSI
    const rsiText = (rsi || 0).toFixed(0);
    if (signal.includes('LONG') && rsi > 78) { analysis += `🥵 Aşırı Şişmiş (RSI ${rsiText}). `; confidenceLevel -= 15; }
    else if (signal.includes('SHORT') && rsi < 22) { analysis += `🥶 Aşırı Satılmış (RSI ${rsiText}). `; confidenceLevel -= 15; }
    else { analysis += `💪 Momentum İyi (RSI ${rsiText}). `; confidenceLevel += 5; }
    
    // 4. BBW
    const bbWidthText = (bbWidth || 0).toFixed(1);
    if (bbWidth < 2.5) { analysis += `⏳ Sıkışma Patlaması (%${bbWidthText}).`; confidenceLevel += 5; }
    
    const finalConfidence = Math.min(Math.max(confidenceLevel, 10), 99);
    return { text: analysis, confidence: finalConfidence.toFixed(0) };
}


/** STRATEJİ 1, 2, 3 (1h, 2h, 4h): Genel Kırılım Stratejisi */
async function analyzeBreakoutStrategy(ccxtSymbol, config, isManual = false, isWatchlist = false) {
    const { timeframe, lookbackPeriod, bufferPercent, volumeMultiplier, atrPeriod, slAtrMultiplier, rsiPeriod, rsiLongThreshold, rsiShortThreshold, strategyIdSuffix, strategyDisplayName } = config;
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = `${fullSymbol}-${strategyIdSuffix}`;
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const minRequiredCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1, BREAKOUT_BASE_BB_PERIOD + 1);
        const candlesToFetch = minRequiredCandles + 10;

        let ohlcv;
        try {
            const fetchLimit = Number.isInteger(candlesToFetch) && candlesToFetch > 0 ? candlesToFetch : 150;
            ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, fetchLimit);
        } catch (fetchError) {
            console.error(`\x1b[31m[${strategyDisplayName} fetchOHLCV Hatası (${ccxtSymbol}, ${timeframe})]: ${fetchError.message}\x1b[0m`); 
            return null;
        }

        if (!ohlcv || ohlcv.length < minRequiredCandles) { return null; }

        const marketCondition = await checkMarketCondition(ccxtSymbol);
        const overallTrend = marketCondition?.overallTrend || 'UNKNOWN';

        const lastCandle = ohlcv[ohlcv.length - 1];
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1);
        if(!lastCandle || lookbackCandles.length < lookbackPeriod) return null;
        const lastClosePrice = lastCandle[4]; const lastVolume = lastCandle[5];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastVolume !== 'number' || isNaN(lastVolume) || lastVolume < 0) return null;
        let highestHigh = 0; let lowestLow = Infinity; let volumeSum = 0; let validVolumeCount = 0;
        for (const candle of lookbackCandles) { if(candle.length < 6) continue; const high = candle[2]; const low = candle[3]; const volume = candle[5]; if (typeof high !== 'number' || isNaN(high) || typeof low !== 'number' || isNaN(low) ) continue; if (high > highestHigh) highestHigh = high; if (low < lowestLow) lowestLow = low; if(typeof volume === 'number' && !isNaN(volume) && volume >= 0) { volumeSum += volume; validVolumeCount++; } }
        if (highestHigh === 0 || lowestLow === Infinity || validVolumeCount === 0 || highestHigh <= lowestLow) return null;
        const avgVolume = volumeSum / validVolumeCount; if(isNaN(avgVolume) || avgVolume <= 0) return null;
        const allCloses = ohlcv.map(c => c[4]); const atr = calculateATR(ohlcv, atrPeriod); const rsi = calculateRSI(allCloses, rsiPeriod); const bb = calculateBollingerBands(allCloses, BREAKOUT_BASE_BB_PERIOD, BREAKOUT_BASE_BB_STDDEV);
        if (atr === null || rsi === null || bb === null) { return null; }
        const bbWidth = (bb.middleBand > 0) ? ((bb.upperBand - bb.lowerBand) / bb.middleBand) * 100 : 0;
        let signal = 'WAIT'; let reason = ''; let isFiltered = false;
        
        // V46.1: TETİKLEME FİYATI MANTIĞI
        const triggerPriceLong = highestHigh * (1 + bufferPercent / 100); 
        const triggerPriceShort = lowestLow * (1 - bufferPercent / 100);
        
        // Fiyat kırılımı geçtiyse (LONG) 
        if (lastClosePrice > triggerPriceLong) { 
            signal = 'B. LONG'; 
            reason = `${strategyDisplayName} Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`;
        } 
        // Fiyat kırılımı geçtiyse (SHORT)
        else if (lastClosePrice < triggerPriceShort) { 
            signal = 'B. SHORT'; 
            reason = `${strategyDisplayName} Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`;
        }

        let tacticalAnalysis = "Koşullar sağlanmadı."; let confidence = "0";

        if (signal !== 'WAIT') {
            // Trend Filtresi
            if (overallTrend === 'UPTREND' && signal === 'B. SHORT') { isFiltered = true; reason = `FİLTRELENDİ: 4h Ana Trend Yükselişte.`; signal = 'WAIT'; }
            else if (overallTrend === 'DOWNTREND' && signal === 'B. LONG') { isFiltered = true; reason = `FİLTRELENDİ: 4h Ana Trend Düşüşte.`; signal = 'WAIT'; }
            
            // RSI Filtresi
            if (!isFiltered) { if (signal === 'B. LONG' && rsi < rsiLongThreshold) { isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) < ${rsiLongThreshold}. Momentum zayıf. ${reason}`; signal = 'WAIT'; } else if (signal === 'B. SHORT' && rsi > rsiShortThreshold) { isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) > ${rsiShortThreshold}. Momentum zayıf. ${reason}`; signal = 'WAIT'; } }
            
            // Hacim Filtresi
            const hacimMultiplier = (avgVolume > 0 ? lastVolume / avgVolume : 0);
            if (!isFiltered) { if (hacimMultiplier < volumeMultiplier) { isFiltered = true; reason = `FİLTRELENDİ: Hacim (${hacimMultiplier.toFixed(1)}x) yetersiz (Min: ${volumeMultiplier}x). ${reason}`; signal = 'WAIT'; } }

            // Taktiksel Analiz ve Güven Hesabı
            if (signal !== 'WAIT' && !isFiltered) {
                const analysisData = { signal, anaTrend: overallTrend, rsi, hacimMultiplier, bbWidth, timeframe };
                const tacticalResult = generateTacticalAnalysis(analysisData);
                tacticalAnalysis = tacticalResult.text;
                confidence = tacticalResult.confidence;
            }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        let entryPrice = lastClosePrice; // Kırılım sinyali mevcut mumda yakalandığı için girişi anlık fiyattan alalım

        if (signal !== 'WAIT' && !isFiltered) {
            const dynamicTP = calculateFibonacciExtension(ohlcv, lookbackPeriod, signal);
            if (signal === 'B. LONG') { 
                takeProfit = dynamicTP ? dynamicTP : entryPrice * (1 + BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
                stopLoss = entryPrice - (atr * slAtrMultiplier); 
            } else if (signal === 'B. SHORT') { 
                takeProfit = dynamicTP ? dynamicTP : entryPrice * (1 - BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
                stopLoss = entryPrice + (atr * slAtrMultiplier); 
            }
            
            if (takeProfit && stopLoss && takeProfit !== entryPrice && stopLoss !== entryPrice && ( (signal === 'B. LONG' && takeProfit > stopLoss) || (signal === 'B. SHORT' && takeProfit < stopLoss) ) ) { 
                const risk = Math.abs(entryPrice - stopLoss); 
                const reward = Math.abs(takeProfit - entryPrice); 
                rrRatio = risk > 0 ? reward / risk : 0; 
                
                // V46.1 GÜNCELLEME: MIN R/R KONTROLÜ
                if(rrRatio < MIN_RISK_REWARD_RATIO) { 
                    signal = 'WAIT'; tacticalAnalysis = `FİLTRELENDİ (Düşük R/R): ${rrRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO.toFixed(1)}.`; confidence = "0"; 
                } else { 
                    reason += ` | R/R: ${rrRatio.toFixed(2)}`; 
                    if (!isManual && !isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; } 
                } 
            }
            else { signal = 'WAIT'; confidence = "0"; tacticalAnalysis = "FİLTRELENDİ: TP/SL hesaplaması başarısız."; }
        }
        
        // Taktiksel Analizi Tetikleme Fiyatı ile birleştir
        if(signal !== 'WAIT' && !isFiltered) {
            tacticalAnalysis = `**GİRİŞ FİYATI: ${entryPrice.toFixed(PRICE_PRECISION)}**. | ${tacticalAnalysis}`;
        }
        
        const volumeStatusText = `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)}`;
        resultData = { id: `${fullSymbol}-${signal}-${Date.now()}-${strategyIdSuffix}`, ccxtSymbol, symbol: fullSymbol, signal, confidence, entryPrice: entryPrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), reason, tacticalAnalysis, volume: lastVolume.toFixed(2), volumeStatus: volumeStatusText, isFiltered: (signal === 'WAIT' && isFiltered), strategyType: strategyIdSuffix };
        
        if (signal !== 'WAIT') { 
            if(!isManual && !isWatchlist) { console.log(`\x1b[36m>>> V46.1 KIRILIM SİNYALİ (${strategyDisplayName}): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`); } 
            return resultData; 
        }
        else { return (isWatchlist || isManual) ? resultData : null; }
    } catch (error) {
        console.error(`\x1b[31m[${strategyDisplayName} KRİTİK ANALİZ HATASI (${ccxtSymbol}, ${timeframe})]: ${error.message}\x1b[0m`, error.stack);
        return null;
    }
}


/** STRATEJİ 4 (1h): 1H HACİM MOMENTUMU (V46.1 SL/TP Eklendi) */
async function analyzeVolumeMomentum1H(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-MOMENTUM1H';
        if (!isManual && !isWatchlist && momentumCooldowns[cooldownKey] && momentumCooldowns[cooldownKey].timestamp > Date.now() - MOMENTUM_1H_COOLDOWN_MS) { return null; }

        const marketCondition = await checkMarketCondition(ccxtSymbol);
        const overallTrend = marketCondition?.overallTrend || 'UNKNOWN';

        const minRequiredCandles = MOMENTUM_1H_LOOKBACK + BREAKOUT_BASE_ATR_PERIOD + 5;
        const candlesToFetch = minRequiredCandles + 5;

        let ohlcv1h;
        try {
            const fetchLimit = Number.isInteger(candlesToFetch) && candlesToFetch > 0 ? candlesToFetch : 50;
            ohlcv1h = await exchange.fetchOHLCV(ccxtSymbol, MOMENTUM_1H_TIMEFRAME, undefined, fetchLimit);
        } catch (fetchError) {
            console.error(`\x1b[31m[Momentum 1H fetchOHLCV Hatası (${ccxtSymbol})]: ${fetchError.message}\x1b[0m`);
            return null;
        }

        if (!ohlcv1h || ohlcv1h.length < minRequiredCandles) { return null; }

        const lastCandle = ohlcv1h[ohlcv1h.length - 1]; const prevCandle = ohlcv1h[ohlcv1h.length - 2];
        if (!lastCandle || !prevCandle || typeof lastCandle[4] !== 'number' || typeof prevCandle[4] !== 'number' || typeof lastCandle[5] !== 'number' || lastCandle[5] < 0) return null;
        
        const lastClose1h = lastCandle[4]; const lastVolume1h = lastCandle[5]; const prevClose1h = prevCandle[4];
        
        // ATR hesapla
        const atr = calculateATR(ohlcv1h, BREAKOUT_BASE_ATR_PERIOD);
        if (atr === null || atr === 0) return null;
        
        const volumeLookbackData = ohlcv1h.slice(-(MOMENTUM_1H_LOOKBACK + 1), -1).map(c => c[5]).filter(v => typeof v === 'number' && v >= 0);
        if (volumeLookbackData.length < MOMENTUM_1H_LOOKBACK / 2) return null;
        const avgVolume = volumeLookbackData.reduce((a, b) => a + b, 0) / volumeLookbackData.length;
        if (isNaN(avgVolume) || avgVolume <= 0) return null;
        const priceChangePercent = prevClose1h === 0 ? 0 : ((lastClose1h - prevClose1h) / prevClose1h) * 100;
        const hacimMultiplier = lastVolume1h / avgVolume;
        let signal = 'WAIT'; let tacticalAnalysis = "Koşullar sağlanmadı."; let confidence = "0";
        const isPumpCondition = hacimMultiplier >= MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent >= MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        const isDumpCondition = hacimMultiplier >= MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent <= -MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        let baseConfidence = 65;
        
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        
        if (isPumpCondition && overallTrend !== 'DOWNTREND') { 
            signal = 'ANLIK LONG'; // V46.1 Değişiklik
            if (overallTrend === 'UPTREND') baseConfidence += 15; 
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0); 
            tacticalAnalysis = `📈 **ANLIK GİRİŞ:** 1H Hacim Patlaması (${hacimMultiplier.toFixed(1)}x) ve Fiyat Artışı (%${priceChangePercent.toFixed(2)}). 4H Trend: ${overallTrend}.`; 
            
            // V46.1: SL/TP HESAPLAMA
            stopLoss = lastClose1h - (atr * 2.5); // Momentum SL'si ATR bazlı
            takeProfit = lastClose1h * (1 + MOMENTUM_1H_TP_PERCENT_FALLBACK / 100); // Yüzde bazlı TP

        }
        else if (isDumpCondition && overallTrend !== 'UPTREND') { 
            signal = 'ANLIK SHORT'; // V46.1 Değişiklik
            if (overallTrend === 'DOWNTREND') baseConfidence += 15; 
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0); 
            tacticalAnalysis = `📉 **ANLIK GİRİŞ:** 1H Hacim Patlaması (${hacimMultiplier.toFixed(1)}x) ve Fiyat Düşüşü (%${priceChangePercent.toFixed(2)}). 4H Trend: ${overallTrend}.`; 
            
            // V46.1: SL/TP HESAPLAMA
            stopLoss = lastClose1h + (atr * 2.5); // Momentum SL'si ATR bazlı
            takeProfit = lastClose1h * (1 - MOMENTUM_1H_TP_PERCENT_FALLBACK / 100); // Yüzde bazlı TP
        }
        
        if (signal !== 'WAIT') {
            const risk = Math.abs(lastClose1h - stopLoss); 
            const reward = Math.abs(takeProfit - lastClose1h); 
            rrRatio = risk > 0 ? reward / risk : 0;
            
            // R/R KONTROLÜ
            if (rrRatio < MIN_RISK_REWARD_RATIO) {
                signal = 'WAIT';
                tacticalAnalysis = `FİLTRELENDİ (Düşük R/R): ${rrRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO.toFixed(1)}.`;
                confidence = "0";
            } else {
                tacticalAnalysis += ` | R/R: ${rrRatio.toFixed(2)}`;
                if (!isManual && !isWatchlist) { 
                    momentumCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; 
                } 
            }
        }
        
        resultData = { id: fullSymbol + '-' + signal + '-' + Date.now() + '-MOMENTUM1H', ccxtSymbol, symbol: fullSymbol, signal, confidence, entryPrice: lastClose1h.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), reason: `Hacim: ${hacimMultiplier.toFixed(1)}x, Fiyat Değ: ${priceChangePercent.toFixed(2)}%`, tacticalAnalysis, strategyType: 'MOMENTUM1H' };
        
        if (signal !== 'WAIT') { 
            if (!isManual && !isWatchlist) { 
                const colorCode = signal.includes('LONG') ? '\x1b[32m' : '\x1b[31m'; console.log(`${colorCode}>>> V46.1 MOMENTUM SİNYALİ (1H): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`); 
            } 
            return resultData; 
        }
        else { return (isWatchlist || isManual) ? resultData : null; }
    } catch (error) {
         console.error(`\x1b[31m[Momentum 1H KRİTİK ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack);
         return null;
    }
}


// --- AKILLI MANUEL ANALİZ VE TARAMA FONKSİYONLARI ---
async function runAllAnalysesForSymbol(ccxtSymbol, isManual = false, isWatchlist = false) {
    let results = [];
    const brk4hConfig = { timeframe: TIMEFRAME_4H, lookbackPeriod: BRK4H_LOOKBACK_PERIOD, bufferPercent: BRK4H_BUFFER_PERCENT, volumeMultiplier: BRK4H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK4H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK4H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK4H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK4H', strategyDisplayName: '4h' };
    const brk2hConfig = { timeframe: TIMEFRAME_2H, lookbackPeriod: BRK2H_LOOKBACK_PERIOD, bufferPercent: BRK2H_BUFFER_PERCENT, volumeMultiplier: BRK2H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' };
    const brk1hConfig = { timeframe: TIMEFRAME_1H, lookbackPeriod: BRK1H_LOOKBACK_PERIOD, bufferPercent: BRK1H_BUFFER_PERCENT, volumeMultiplier: BRK1H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK1H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK1H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK1H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' };
    results.push(await analyzeBreakoutStrategy(ccxtSymbol, brk4hConfig, isManual, isWatchlist));
    results.push(await analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, isManual, isWatchlist));
    results.push(await analyzeBreakoutStrategy(ccxtSymbol, brk1hConfig, isManual, isWatchlist));
    results.push(await analyzeVolumeMomentum1H(ccxtSymbol, isManual, isWatchlist));
    const activeSignals = results.filter(r => r !== null && r.signal !== 'WAIT' && r.signal !== 'HATA/YOK');
    const waitSignals = results.filter(r => r !== null && (r.signal === 'WAIT' || r.signal === 'HATA/YOK'));
    return { activeSignals, waitSignals };
}
function prioritizeAnalysis(activeSignals) {
    if (!activeSignals || activeSignals.length === 0) return null;
    const priority = ['BRK4H', 'BRK2H', 'BRK1H', 'MOMENTUM1H'];
    for (const p of priority) { const found = activeSignals.find(r => r.strategyType === p); if (found) return found; }
    return activeSignals[0];
}
async function runWatchlistScan() {
    if (Object.keys(globalWatchlist).length === 0) return;
    let updatedWatchlist = {};
    for (const [symbol, item] of Object.entries(globalWatchlist)) {
        try { if (!item || !item.ccxtSymbol) { updatedWatchlist[symbol] = item; continue; }
            const { activeSignals, waitSignals } = await runAllAnalysesForSymbol(item.ccxtSymbol, false, true);
            const bestAnalysis = prioritizeAnalysis(activeSignals);
            if (bestAnalysis) { updatedWatchlist[symbol] = { ...item, ...bestAnalysis, statusClass: bestAnalysis.signal.includes('LONG') ? 'bg-long' : 'bg-short' }; }
            else if (waitSignals.length > 0) { const waitResult = waitSignals[0]; updatedWatchlist[symbol] = { ...item, ...waitResult, signal: 'WAIT', tacticalAnalysis: waitResult.tacticalAnalysis || 'Aktif sinyal yok.', statusClass: waitResult.isFiltered ? 'status-reddet' : 'bg-wait' }; }
            else { updatedWatchlist[symbol] = {...item, signal: 'HATA', tacticalAnalysis:`Analiz başarısız/veri yetersiz`, statusClass:'bg-wait'}; }
        } catch (e) { updatedWatchlist[symbol] = {...item, signal: 'HATA', tacticalAnalysis:`Tarama Hatası: ${e.message}`, statusClass:'bg-wait'}; }
    }
    if(Object.keys(updatedWatchlist).length > 0) { globalWatchlist = updatedWatchlist; io.emit('watchlist_update', globalWatchlist); }
}

// --- ANA TARAMA DÖNGÜLERİ ---
async function runBreakoutScan1h() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); try { if (globalTargetList.length === 0) return; const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 1h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef) ---`); const brk1hConfig = { timeframe: TIMEFRAME_1H, lookbackPeriod: BRK1H_LOOKBACK_PERIOD, bufferPercent: BRK1H_BUFFER_PERCENT, volumeMultiplier: BRK1H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK1H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK1H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK1H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk1hConfig, false, false); if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); } catch (loopError) { console.error(`\x1b[31m[1h Döngü Hatası (${ccxtSymbol})]: ${loopError.message}\x1b[0m`); } } } catch (error) { console.error("\x1b[31mKritik 1h Tarama Hatası:\x1b[0m", error.message); } finally { console.log(`--- 1h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS); const momentumTemizlemeZamani = Date.now() - (MOMENTUM_1H_COOLDOWN_MS); global.APP_STATE.signals = global.APP_STATE.signals.filter(s => { if (!s || !s.timestamp) return false; if (s.strategyType === 'MOMENTUM1H') { return s.timestamp > momentumTemizlemeZamani; } else { return s.timestamp > temizelemeZamani; } }); global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; io.emit('scan_status', global.APP_STATE.scanStatus); }
}
async function runBreakoutScan2h() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); try { if (globalTargetList.length === 0) return; const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef) ---`); const brk2hConfig = { timeframe: TIMEFRAME_2H, lookbackPeriod: BRK2H_LOOKBACK_PERIOD, bufferPercent: BRK2H_BUFFER_PERCENT, volumeMultiplier: BRK2H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, false, false); if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); } catch (loopError) { console.error(`\x1b[31m[2h Döngü Hatası (${ccxtSymbol})]: ${loopError.message}\x1b[0m`); } } } catch (error) { console.error("\x1b[31mKritik 2h Tarama Hatası:\x1b[0m", error.message); } finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}
async function runBreakoutScan4h() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); try { if (globalTargetList.length === 0) return; const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 4h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef) ---`); const brk4hConfig = { timeframe: TIMEFRAME_4H, lookbackPeriod: BRK4H_LOOKBACK_PERIOD, bufferPercent: BRK4H_BUFFER_PERCENT, volumeMultiplier: BRK4H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK4H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK4H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK4H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK4H', strategyDisplayName: '4h' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk4hConfig, false, false); if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); } catch (loopError) { console.error(`\x1b[31m[4h Döngü Hatası (${ccxtSymbol})]: ${loopError.message}\x1b[0m`); } } } catch (error) { console.error("\x1b[31mKritik 4h Tarama Hatası:\x1b[0m", error.message); } finally { console.log(`--- 4h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}
async function runVolumeMomentum1HScan() {
    if (globalTargetList.length === 0) return; const allSwapSymbols = [...globalTargetList]; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeVolumeMomentum1H(ccxtSymbol, false, false); if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, MOMENTUM_1H_API_DELAY_MS)); } catch (loopError) { console.error(`\x1b[31m[Momentum 1H HATA - ${ccxtSymbol}]: ${loopError.message}\x1b[0m`); } }
}

// --- Express Rotaları ve Socket.IO Bağlantısı ---
app.get('/', (req, res) => { const filePath = path.join(__dirname, 'app.html'); res.sendFile(filePath, err => { if(err) console.error("HTML gönderme hatası:", err); }); });

io.on('connection', (socket) => {
    console.log('Bir istemci bağlandı:', socket.id);
    try {
        const signalsToSend = Array.isArray(global.APP_STATE.signals) ? global.APP_STATE.signals : [];
        const initialStateCopy = JSON.parse(JSON.stringify({ signals: signalsToSend, scanStatus: global.APP_STATE.scanStatus }));
        socket.emit('initial_state', initialStateCopy);
    }
    catch (e) { console.error("\x1b[31mInitial state gönderilirken hata:\x1b[0m", e); socket.emit('initial_state', { signals: [] }); }
    socket.emit('watchlist_update', globalWatchlist);
    socket.on('disconnect', () => { console.log('İstemci bağlantısı kesildi:', socket.id); });
});

app.post('/api/remove-watchlist', (req, res) => { const symbol = req.body.symbol; if (globalWatchlist[symbol]) { delete globalWatchlist[symbol]; io.emit('watchlist_update', globalWatchlist); res.json({ success: true }); } else { res.status(404).json({ error: 'Bulunamadı.' }); } });
app.post('/api/analyze-coin', async (req, res) => { const userSymbolInput = req.body.symbol; if (!userSymbolInput) return res.status(400).json({ error: 'Sembol eksik.' }); const cleanBaseSymbol = userSymbolInput.toUpperCase().replace(/[\/:USDT PERP]/g, '').trim(); const fullSymbol = cleanBaseSymbol + 'USDT'; try { if (!exchange.markets) await exchange.loadMarkets(true); const foundMarket = Object.values(exchange.markets).find(m => m.active && m.swap && m.quote === 'USDT' && m.base === cleanBaseSymbol); if (foundMarket && foundMarket.symbol) { const targetCcxtSymbol = foundMarket.symbol; console.log(`Manuel analiz: ${userSymbolInput} -> ${targetCcxtSymbol}`); const { activeSignals, waitSignals } = await runAllAnalysesForSymbol(targetCcxtSymbol, true, true); const bestAnalysis = prioritizeAnalysis(activeSignals); let finalResult; if (bestAnalysis) { finalResult = { ...bestAnalysis, statusClass: bestAnalysis.signal.includes('LONG') || bestAnalysis.signal.includes('PUMP') ? 'bg-long' : 'bg-short' }; } else if (waitSignals.length > 0) { const waitResult = waitSignals[0]; finalResult = { ...waitResult, signal: 'WAIT', tacticalAnalysis: waitResult.tacticalAnalysis || 'Aktif sinyal yok.', statusClass: waitResult.isFiltered ? 'status-reddet' : 'bg-wait' }; } else { finalResult = { ccxtSymbol: targetCcxtSymbol, symbol: fullSymbol, signal: 'HATA/YOK', reason: 'Analiz başarısız.', tacticalAnalysis: 'Veri çekilemedi.', statusClass: 'bg-wait', timestamp: Date.now(), time: new Date().toLocaleTimeString() }; } globalWatchlist[fullSymbol] = finalResult; io.emit('watchlist_update', globalWatchlist); res.json(finalResult); } else { res.status(404).json({ error: `'${cleanBaseSymbol}' marketi bulunamadı.` }); } } catch(err) { console.error("\x1b[31mManuel analiz API hatası:\x1b[0m", err); res.status(500).json({ error: `Sunucu hatası: ${err.message}` }); } });

// --- Sunucu Başlatma ve Döngüler ---
server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V46.1) BAŞLATILIYOR - Port: ${PORT}`);
    console.log(`Node.js Sürümü: ${process.version}`);
    console.log(`🎯 MIN RISK/REWARD: ${MIN_RISK_REWARD_RATIO.toFixed(1)}`);
    console.log("==============================================");
    try {
        await exchange.loadMarkets(true); console.log("[Başlangıç] Marketler yüklendi.");
        await runPreScan(); console.log(`[Başlangıç] İlk ön tarama tamamlandı. Hedef: ${globalTargetList.length}`);
        if (globalTargetList.length > 0) { console.log("[Başlangıç] İlk taramalar başlatılıyor..."); runBreakoutScan1h(); runBreakoutScan2h(); runBreakoutScan4h(); runVolumeMomentum1HScan(); }
        else { console.warn("[Başlangıç] Hedef liste boş, ilk taramalar atlandı."); }
        console.log("[Başlangıç] Periyodik döngüler ayarlanıyor...");
        setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL); setInterval(runPreScan, PRESCAN_INTERVAL);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan1h(); }, BREAKOUT_SCAN_INTERVAL_1H);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan2h(); }, BREAKOUT_SCAN_INTERVAL_2H);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan4h(); }, BREAKOUT_SCAN_INTERVAL_4H);
        setInterval(async () => { if (globalTargetList.length > 0) await runVolumeMomentum1HScan(); }, MOMENTUM_1H_SCAN_INTERVAL);
        console.log(`\n✅ SUNUCU BAŞARIYLA BAŞLATILDI: http://localhost:${PORT}`);
        console.log("==============================================");
    } catch (loadError) { console.error("\x1b[31m[KRİTİK BAŞLANGIÇ HATASI]:\x1b[0m", loadError); }
});
console.log("--- server.js dosyası okunması tamamlandı ---");
