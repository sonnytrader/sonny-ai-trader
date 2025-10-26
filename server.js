// server.js (ANA PROJE - V9.1 - UT BOT + FIBO FIX)
// SÜRÜM: V9.1 (UT Bot Fibo Tahmin Fix) (26.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V9.1 - UT Bot Fibo Fix) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === V9.1 STANDART SİSTEM AYARLARI ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 2000000; 
const SCAN_INTERVAL = 1 * 60 * 1000; 
const WATCHLIST_SCAN_INTERVAL = 5 * 1000; 
const API_DELAY_MS = 100; 
const TIMEFRAME = '15m'; 
const RSI_PERIOD = 14; 
const VOLUME_PERIOD = 20;
const VOLUME_MULTIPLIER = 1.2; 
const UT_ATR_KEY_VALUE = 1.0; 
const UT_ATR_PERIOD = 10; 
const MIN_RR_RATIO = 2.0; 

const REQUIRED_CANDLE_BUFFER = 100;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

// 2h KIRILIM AYARLARI (Korundu)
const BREAKOUT_TIMEFRAME = '2h'; const BREAKOUT_LOOKBACK_PERIOD = 50;
const BREAKOUT_SCAN_INTERVAL = 30 * 60 * 1000; const BREAKOUT_BUFFER_PERCENT = 0.1;
const BREAKOUT_VOLUME_MULTIPLIER = 1.5;
const BREAKOUT_TP_PERCENTAGE = 5.0; const BREAKOUT_SL_PERCENTAGE = 2.0;
const BREAKOUT_RR_RATIO = BREAKOUT_SL_PERCENTAGE > 0 ? BREAKOUT_TP_PERCENTAGE / BREAKOUT_SL_PERCENTAGE : 1.0; 
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
function calculateATR(ohlcv, period) {
    if (!ohlcv || ohlcv.length < period) return null;
    let trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2];
        const low = ohlcv[i][3];
        const prevClose = ohlcv[i - 1][4];
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    if (trs.length < period) return null;
    return calculateSMA(trs, period);
}
function calculateUTBotSignals(ohlcv, key, atrPeriod) {
    if (!ohlcv || ohlcv.length < atrPeriod + 1) return null;

    const prices = ohlcv.map(m => m[4]);
    const highs = ohlcv.map(m => m[2]);
    const lows = ohlcv.map(m => m[3]);

    const xATR = calculateATR(ohlcv, atrPeriod);
    if (xATR === null) return null;
    const nLoss = key * xATR;

    let xATRTrailingStop = prices[0]; 
    let pos = 0;
    let signals = [];

    for (let i = 1; i < prices.length; i++) {
        const src = prices[i];
        const src_prev = prices[i - 1];
        const prev_stop = signals.length > 0 ? signals[signals.length - 1].stop : xATRTrailingStop;

        let current_stop;
        let current_pos = pos;

        if (src > prev_stop && src_prev > prev_stop) {
            current_stop = Math.max(prev_stop, src - nLoss);
        } else if (src < prev_stop && src_prev < prev_stop) {
            current_stop = Math.min(prev_stop, src + nLoss);
        } else if (src > prev_stop) {
            current_stop = src - nLoss;
        } else {
            current_stop = src + nLoss;
        }

        if (src_prev < prev_stop && src > prev_stop) {
            current_pos = 1; 
        } else if (src_prev > prev_stop && src < prev_stop) {
            current_pos = -1; 
        } else {
            current_pos = pos;
        }

        const buySignal = (current_pos === 1 && pos === -1); 
        const sellSignal = (current_pos === -1 && pos === 1);

        signals.push({
            stop: current_stop,
            pos: current_pos,
            buy: buySignal,
            sell: sellSignal,
            close: src,
            high: highs[i],
            low: lows[i]
        });

        xATRTrailingStop = current_stop;
        pos = current_pos;
    }

    const lastSignal = signals[signals.length - 1];
    if (!lastSignal) return null;

    return {
        isBuy: lastSignal.buy,
        isSell: lastSignal.sell,
        trailingStop: lastSignal.stop,
        currentPos: lastSignal.pos,
        signals
    };
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
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${globalTargetList.length} coin hedefe alındı (Hacim > 2M).\x1b[0m`);
    } catch (error) { console.error(`Kritik Ön Tarama Hatası: ${error.message}`); }
}


/**
 * STRATEJİ 1 (15m): V9.1 - UT BOT ALERTS
 */
async function analyzeUTBotCoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-UTBOT';
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredCandleCount = REQUIRED_CANDLE_BUFFER + UT_ATR_PERIOD + 5;
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < requiredCandleCount) return null;

        // Veri Temizleme ve Hazırlama (KRİTİK GÜVENLİK DÜZELTMESİ)
        const closes = ohlcv.map(m => m[4]).filter(v => typeof v === 'number' && !isNaN(v));
        const volumes = ohlcv.map(m => m[5]).filter(v => typeof v === 'number' && !isNaN(v));
        if (closes.length < requiredCandleCount || volumes.length < requiredCandleCount) return null;

        const lastClosePrice = closes[closes.length - 1]; 

        // --- 1. UT Bot Hesaplaması ---
        const utResult = calculateUTBotSignals(ohlcv, UT_ATR_KEY_VALUE, UT_ATR_PERIOD);
        if (!utResult) return null;

        let signal = 'WAIT';
        if (utResult.isBuy) { signal = 'LONG'; }
        if (utResult.isSell) { signal = 'SHORT'; }

        let confidence = 70;
        let isFiltered = false;
        let reason = 'Bekle (UT Bot)';
        
        // --- 2. Hacim & RSI Teyidi (MUTLAK FİLTRE) ---
        const rsi = calculateRSI(closes, RSI_PERIOD);
        if (rsi === null) return null;

        const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), VOLUME_PERIOD);
        const lastVolume = volumes[volumes.length - 1];
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * VOLUME_MULTIPLIER;
        const volumeStatus = isVolumeStrong ? `Yüksek (${(lastVolume / avgVolume).toFixed(1)}x)` : `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`;

        if (signal !== 'WAIT') {
            // FİLTRE 1: Hacim Teyidi
            if (!isVolumeStrong) {
                isFiltered = true; 
                reason = `FİLTRELENDİ: Hacim Teyidi Eksik (${volumeStatus}). Min ${VOLUME_MULTIPLIER}x gerekli.`; 
                signal = 'WAIT';
            }
            
            // FİLTRE 2: RSI Filtresi (Gürültü Kontrolü)
            const isRSIValid = (signal === 'LONG' && rsi < 70) || (signal === 'SHORT' && rsi > 30);
            if (!isFiltered && !isRSIValid) {
                isFiltered = true; 
                reason = `FİLTRELENDİ: RSI Aşırı Bölge (${rsi.toFixed(2)}). Gürültü Riski.`; 
                signal = 'WAIT';
            }
        }
        
        // --- 3. R/R ve Final Kontrolü ---
        let takeProfit = null, stopLoss = null; let rrRatio = 0;
        
        if (signal !== 'WAIT') {
            // TP/SL HESAPLAMA: UT Bot Trailing Stop'a göre SL ve R/R 2.0 TP
            const stopValue = utResult.trailingStop;
            const risk = Math.abs(lastClosePrice - stopValue);
            
            if (risk > 0) {
                const reward = risk * MIN_RR_RATIO;
                if (signal === 'LONG') {
                    stopLoss = stopValue;
                    takeProfit = lastClosePrice + reward;
                } else {
                    stopLoss = stopValue;
                    takeProfit = lastClosePrice - reward;
                }
                rrRatio = MIN_RR_RATIO;
            } else {
                // Risk sıfırsa veya negatifse sinyal geçersiz
                isFiltered = true;
                signal = 'WAIT';
            }
            
            // Sinyal Onaylandı (Puanlama)
            if (!isFiltered) {
                confidence = Math.min(85, 95); 
                reason = `ONAYLANDI (R/R: ${MIN_RR_RATIO.toFixed(2)}). Strateji: UT Bot Buy/Sell. | Hacim Teyitli. | RSI: ${rsi.toFixed(2)}`;
                if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
            }
        }

        let finalSignal = signal; let finalReason = reason;
        if (isManual || isWatchlist) { if (isFiltered) { finalSignal = 'REDDEDİLDİ'; } }

        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-UTBOT',
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: finalSignal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), 
            forecast: '---', reason: finalReason, 
            volume: lastVolume ? lastVolume.toFixed(2) : '---', volumeStatus: volumeStatus, isFiltered: isFiltered
        };

        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[36m>>> V9.1 UT BOT SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { return null; }
}


/**
 * STRATEJİ 2 (2h): Kırılım Stratejisi (Korundu)
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
            const analysisResult = await analyzeUTBotCoin(item.ccxtSymbol, false, true);  // UT Bot çağrısı
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
    global.APP_STATE.scanStatus = { message: `15m UT BOT Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);
    
    try {
        if (globalTargetList.length === 0) return;
        const allSwapSymbols = globalTargetList; 

        console.log(`\n--- 15m UT BOT TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
            try {
                const analysisResult = await analyzeUTBotCoin(ccxtSymbol, false, false); // UT Bot çağrısı
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { console.error(`[Döngü Hatası]: ${loopError.message}`); } 
        }
    } catch (error) { console.error("Kritik 15m Tarama Hatası:", error.message); }
    finally {
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             let cooldownKey = s.symbol + (s.id?.endsWith('-BRK') ? '-BREAKOUT' : '-UTBOT'); // UTBOT etiketi
             const cooldownEntry = signalCooldowns[cooldownKey];
             return cooldownEntry && cooldownEntry.timestamp > temizelemeZamani;
        });
        
        global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; 
        io.emit('scan_status', global.APP_STATE.scanStatus);
        console.log(`--- 15m UT BOT TARAMA TAMAMLANDI (${scanTimeStr}). ---`);
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
            const result = await analyzeUTBotCoin(targetCcxtSymbol, true, true);  // UT Bot çağrısı
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
    console.log(`🚀 Sonny AI Trader (V9.1 - UT BOT + KIRILIM) http://localhost:${PORT}`);
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