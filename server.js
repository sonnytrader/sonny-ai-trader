// server.js (ANA PROJE V3.7 - Otomatik Watchlist Kaldırıldı)
// SÜRÜM: V3.7 (Otomatik Watchlist Kaldırıldı, Sadece Manuel Takip) (25.10.2025)

const express = require('express');
const cors = require('cors'); 
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V3.7 - Manuel Watchlist) ---");

const app = express();
const PORT = process.env.PORT || 3000; 

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); 
app.use(express.json());

// === YENİ: ÖN TARAMA FİLTRELERİ (Aşama 1) ===
const PRESCAN_INTERVAL = 5 * 60 * 1000; 
const PRESCAN_MIN_24H_VOLUME_USDT = 5000000; 

// === TWIN RANGE FILTER STRATEJİ AYARLARI (Aşama 2) ===
const SCAN_INTERVAL = 1 * 60 * 1000; 
const WATCHLIST_SCAN_INTERVAL = 1 * 1000; // 1 saniye (Hızlı takip korundu)
const API_DELAY_MS = 100; 
const TIMEFRAME = '15m'; 

// TRF Pine Script Ayarları
const TRF_FAST_PERIOD = 27;    
const TRF_FAST_MULT = 1.6;     
const TRF_SLOW_PERIOD = 55;    
const TRF_SLOW_MULT = 2.0;     

// MTF ve Hacim Kontrolü için Gerekli Ayarlar
const TIMEFRAME_MTF = '1h'; 
const EMA_PERIOD_MTF = 50; 
const MIN_VOLUME_MULTIPLIER = 1.0; 

// R/R Ayarları (TP 5.0%, SL 2.0%)
const TP_PERCENTAGE = 5.0; 
const SL_PERCENTAGE = 2.0; 
const MIN_RR_RATIO = SL_PERCENTAGE > 0 ? TP_PERCENTAGE / SL_PERCENTAGE : 1.0; 

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

// --- İNDİKATOR HESAPLAMA FONKSİYONLARI (Hepsi korundu) ---

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

function calculateSmoothRange(closes, t, m) {
    if (!closes || closes.length < t * 2 - 1) return null;
    const wper = t * 2 - 1;
    let absDiffs = [];
    
    for (let i = 1; i < closes.length; i++) {
        absDiffs.push(Math.abs(closes[i] - closes[i - 1]));
    }
    
    const avrng = calculateEMA(absDiffs, t);
    if (!avrng) return null;

    const smoothRngArray = calculateEMA(avrng, wper);
    if (!smoothRngArray || smoothRngArray.length === 0) return null;
    
    const lastSmoothRng = smoothRngArray[smoothRngArray.length - 1];
    return lastSmoothRng * m;
}

function calculateRangeFilter(closes, smrng) {
    if (!closes || closes.length === 0 || smrng === null) return { filt: null, allFilt: [] };
    
    let filtValues = [];
    let filt = closes[0]; 
    filtValues.push(filt);

    for (let i = 1; i < closes.length; i++) {
        const x = closes[i];
        const prevFilt = filtValues[i - 1];
        
        let newFilt;
        
        if (x > prevFilt) {
            newFilt = (x - smrng < prevFilt) ? prevFilt : x - smrng;
        } else {
            newFilt = (x + smrng > prevFilt) ? prevFilt : x + smrng;
        }
        
        filtValues.push(newFilt);
    }
    
    return { filt: filtValues[filtValues.length - 1], allFilt: filtValues };
}

async function checkMTF_EMA_TRF(ccxtSymbol) {
    const requiredCandleCount = EMA_PERIOD_MTF + 5;
    try {
        const ohlcv1h = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME_MTF, undefined, requiredCandleCount);
        if (!ohlcv1h || ohlcv1h.length < EMA_PERIOD_MTF) return null;
        const closes1h = ohlcv1h.map(m => m[4]);
        const ema1hArray = calculateEMA(closes1h, EMA_PERIOD_MTF);
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
        if (!ema200Array || ema200Array.length === 0) return { overallTrend: 'UNKNOWN' };
        const lastClosePrice = closes[closes.length - 1]; const lastEma200 = ema200Array[ema200Array.length - 1];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) return { overallTrend: 'UNKNOWN' };
        if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' };
        else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' };
        else return { overallTrend: 'SIDEWAYS' };
    } catch (e) { return { overallTrend: 'UNKNOWN' }; }
}

/**
 * Fibonacci Uzantı Seviyesini Hesapla (Öngörü amaçlı)
 */
function calculateFibonacciExtension(ohlcv, period, signalType) {
    if (!ohlcv || ohlcv.length < period) return null;

    const relevantOhlcv = ohlcv.slice(-period);
    let high = 0;
    let low = Infinity;

    for (const candle of relevantOhlcv) {
        if (candle[2] > high) high = candle[2]; 
        if (candle[3] < low) low = candle[3];   
    }
    
    if (high <= low || high === 0 || low === Infinity) return null;

    const diff = high - low;
    const FIB_EXT_LEVEL = 1.618; 
    let forecast = null;

    if (signalType === 'LONG') {
        forecast = high + diff * (FIB_EXT_LEVEL - 1);
    } else if (signalType === 'SHORT') {
        forecast = low - diff * (FIB_EXT_LEVEL - 1);
    }

    if (forecast !== null && !isNaN(forecast)) {
        return forecast;
    }
    
    return null;
}
// --- BİTTİ: İNDİKATOR HESAPLAMA ---


/**
 * AŞAMA 1 - HIZLI ÖN TARAYICI (Değişiklik yok)
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
                quoteVolume && quoteVolume > PRESCAN_MIN_24H_VOLUME_USDT     
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
 * YENİ ANA STRATEJİ: TWIN RANGE FILTER (15m) - DİNAMİK GÜVEN PUANI
 */
async function analyzeTwinRangeCoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = fullSymbol + '-TRF'; 

        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const maxPeriod = Math.max(TRF_FAST_PERIOD * 2 - 1, TRF_SLOW_PERIOD * 2 - 1);
        const requiredCandleCount = maxPeriod + 180; 
        
        // API İSTEKLERİ: TRF Mumları ve MTF Trend
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        const mtfTrend = await checkMTF_EMA_TRF(ccxtSymbol); 
        
        if (!ohlcv || ohlcv.length < requiredCandleCount || mtfTrend === null) return null;
        
        const closes = ohlcv.map(m => m[4]); 
        const volumes = ohlcv.map(m => m[5]);
        const lastClosePrice = closes[closes.length - 1]; 
        const prevClosePrice = closes[closes.length - 2];
        
        // TRF Filtre Hesaplaması
        const smrng = (calculateSmoothRange(closes, TRF_FAST_PERIOD, TRF_FAST_MULT) + calculateSmoothRange(closes, TRF_SLOW_PERIOD, TRF_SLOW_MULT)) / 2;
        const lastFilt = calculateRangeFilter(closes, smrng).filt;
        const prevFilt = calculateRangeFilter(closes.slice(0, -1), (calculateSmoothRange(closes.slice(0, -1), TRF_FAST_PERIOD, TRF_FAST_MULT) + calculateSmoothRange(closes.slice(0, -1), TRF_SLOW_PERIOD, TRF_SLOW_MULT)) / 2).filt;

        if (lastFilt === null || prevFilt === null || typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) { if (isManual) return { error: `TRF Filtre hesaplanamadı.` }; return null; }

        // Sinyal Mantığı: Filtre Kesişimi
        const isFilterCrossedUp = lastClosePrice > lastFilt && prevClosePrice <= prevFilt;
        const isFilterCrossedDown = lastClosePrice < lastFilt && prevClosePrice >= prevFilt;

        let signal = 'WAIT';
        let reason = 'Bekle (TRF)';
        let baseConfidence = 60; // Temel Güven Puanı
        let confidenceScore = baseConfidence;
        let isFiltered = false;

        // Hacim Kontrolü
        const lastVolume = volumes[volumes.length - 1]; 
        const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), 20); 
        let volumeStatus = 'TRF: Hacim Kontrolü Yok'; 
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * MIN_VOLUME_MULTIPLIER; // 1.0x ve üstü
        if (avgVolume && lastVolume) {
             volumeStatus = `TRF: ${(lastVolume / avgVolume).toFixed(1)}x`;
        }

        // Sinyal Tetikleyici: Filtre Kesişimi
        if (isFilterCrossedUp) { 
            signal = 'LONG';
            reason = 'TRF Yükseliş Kesişimi (Hız Odaklı)';
        } else if (isFilterCrossedDown) { 
            signal = 'SHORT';
            reason = 'TRF Düşüş Kesişimi (Hız Odaklı)';
        }
        
        // --- KRİTİK GÜVEN PUANLAMASI ---
        if (signal !== 'WAIT') {
             // Başlangıç Hızı Puanı
             confidenceScore += 5; // TRF hızlı olduğu için temel 5 puan

             // 1. MTF Trend Puanı
            if (signal === 'LONG' && mtfTrend.isUptrend) {
                 confidenceScore += 10;
                 reason += ' [1H Trend Teyitli]';
            } else if (signal === 'SHORT' && mtfTrend.isDowntrend) {
                 confidenceScore += 10;
                 reason += ' [1H Trend Teyitli]';
            } else {
                 reason += ` [1H Trend: ${mtfTrend.trendStatus}]`;
                 confidenceScore -= 5; // Trend tersse puan düşür
            }

            // 2. Hacim Puanı
            if (isVolumeStrong) {
                 confidenceScore += 10;
                 reason += ' [Hacim Yüksek]';
            } else {
                 reason += ' [Hacim Düşük]';
                 confidenceScore -= 5; // Hacim düşükse puan düşür
            }
        }
        
        // R/R 2.5'u uygula
        let takeProfit = null, stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            if (signal === 'LONG') {
                takeProfit = lastClosePrice * (1 + TP_PERCENTAGE / 100); 
                stopLoss = lastClosePrice * (1 - SL_PERCENTAGE / 100);  
            } else if (signal === 'SHORT') {
                takeProfit = lastClosePrice * (1 - TP_PERCENTAGE / 100); 
                stopLoss = lastClosePrice * (1 + SL_PERCENTAGE / 100);  
            }
            rrRatio = MIN_RR_RATIO;
            if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
            reason += `. R/R: ${rrRatio.toFixed(2)}.`;
        } else if (isFiltered) {
            confidenceScore = 50;
        }

        // Fibo Öngörüsü
        const forecastLevel = signal !== 'WAIT' 
            ? calculateFibonacciExtension(ohlcv, 50, signal) 
            : null;

        // Final Sinyal Çıktısı
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-TRF', 
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: Math.min(95, confidenceScore).toFixed(0), // Max 95%
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), 
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio.toFixed(2), time: new Date().toLocaleTimeString(), 
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', 
            reason: reason, volume: lastVolume ? lastVolume.toFixed(2) : '---', volumeStatus: volumeStatus, isFiltered: isFiltered
        };

        if (isManual || isWatchlist) return resultData;

        // --- KRİTİK OTOMATİK WATCHLIST EKLEME MANTIĞI (KALDIRILDI) ---

        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[34m>>> TRF SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }

    } catch (error) {
        if (isManual || isWatchlist) return { error: `TRF Analiz Hatası: ${error.message}` };
        console.error(`[TRF Analiz Hatası (${ccxtSymbol})]: ${error.message}`); 
        return null; 
    }
}


/**
 * STRATEJİ 2 (2h): Kırılım Stratejisi (Korunur)
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
            RR: rrRatio.toFixed(2), time: new Date().toLocaleTimeString(), // Anlık sunucu zamanı
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
            // Watchlist sadece manuel eklenen coinleri 1s hızında tarar.
            const analysisResult = await analyzeTwinRangeCoin(item.ccxtSymbol, false, true); 
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
    global.APP_STATE.scanStatus = { message: `15m TRF Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);
    
    try {
        if (globalTargetList.length === 0) {
            console.log(`\x1b[33m--- 15m TARAMA ATLANDI: Hedef liste boş. Ön tarama bekleniyor olabilir.\x1b[0m`);
            return;
        }
        const allSwapSymbols = globalTargetList; 

        console.log(`\n--- 15m TWIN RANGE FILTER TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const trfResult = await analyzeTwinRangeCoin(ccxtSymbol, false, false);
                if (trfResult) { global.APP_STATE.signals.unshift(trfResult); io.emit('yeni_sinyal', trfResult); }
                
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { }
        }
    } catch (error) { console.error("Kritik TRF Tarama Hatası:", error.message); exchange.markets = {}; }
    finally {
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             let cooldownKey;
             if(s.id?.endsWith('-BRK')) cooldownKey = s.symbol + '-BREAKOUT';
             else if(s.id?.endsWith('-TRF')) cooldownKey = s.symbol + '-TRF'; 
             else cooldownKey = s.symbol;
             const cooldownEntry = signalCooldowns[cooldownKey];
             return cooldownEntry && cooldownEntry.timestamp > temizelemeZamani;
        });
        
        global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; 
        io.emit('scan_status', global.APP_STATE.scanStatus);
        console.log(`--- 15m TRF TARAMA TAMAMLANDI (${scanTimeStr}). ---`);
    }
}

async function runBreakoutScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();

    try {
        if (globalTargetList.length === 0) {
            console.log(`\x1b[33m--- 2h TARAMA ATLANDI: Hedef liste boş. Ön tarama bekleniyor olabilir.\x1b[0m`);
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

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'app.html')); });
io.on('connection', (socket) => { socket.emit('initial_state', global.APP_STATE); socket.emit('watchlist_update', globalWatchlist); });

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol; if (!userSymbolInput) return res.status(400).json({ error: 'Sembol gönderilmedi.' });
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace('USDT', '').replace('PERP', '').trim(); const fullSymbol = cleanBaseSymbol + 'USDT';
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) { await exchange.loadMarkets(true); }
        const foundMarket = Object.values(exchange.markets).find(m => m.base === cleanBaseSymbol && m.quote === 'USDT' && m.swap && m.active);
        if (foundMarket) {
            const targetCcxtSymbol = foundMarket.symbol;
            const result = await analyzeTwinRangeCoin(targetCcxtSymbol, true, true); 
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
    console.log(`🚀 Sonny AI Trader (V3.7 - Sadece Manuel Takip) http://localhost:${PORT}`);
    console.log(`OTOMATİK TARAMA BAŞLIYOR...`);
    try {
        console.log("Market listesi yükleniyor...");
        exchange.markets = await exchange.loadMarkets(true);
        console.log(`Market listesi yüklendi (${Object.keys(exchange.markets).length} market).`);

        await runPreScan(); 

    } catch (loadError) {
        console.error("Başlangıçta market/ön-tarama yüklenemedi! Hata:", loadError.message);
        exchange.markets = {}; 
    }
    
    runScan(); 
    runBreakoutScan(); 

    setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL); 

    setInterval(runPreScan, PRESCAN_INTERVAL); 

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