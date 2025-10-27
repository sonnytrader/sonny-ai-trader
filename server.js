// server.js (ANA PROJE - V13.6 - TANIMLAMA HATALARI DÜZELTİLDİ)
// SÜRÜM: V13.6 (ReferenceError hataları giderildi) (28.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V13.6 - Hata Düzeltmeleri) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === V13.6 STRATEJİ AYARLARI ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;
const PRESCAN_MIN_24H_VOLUME_USDT = 500000; // Hacim filtresi (Düşük bırakıldı)
const SCAN_INTERVAL_15M = 1 * 60 * 1000; // 15m stratejileri için tarama sıklığı (Eski SCAN_INTERVAL)
const WATCHLIST_SCAN_INTERVAL = 5 * 1000;
const API_DELAY_MS = 100; // Genel API gecikmesi
const TIMEFRAME_1M = '1m'; const TIMEFRAME_5M = '5m'; const TIMEFRAME_15M = '15m'; const TIMEFRAME_1H = '1h'; const TIMEFRAME_2H = '2h'; const TIMEFRAME_4H = '4h';

// --- Strateji Ayarları ---

// Stoch+EMA (Strateji 1)
const STOCH_EMA_PERIOD = 50; const STOCH_BB_PERIOD = 20; const STOCH_BB_STDDEV = 2; // Bu genel BB stddev
const STOCH_RSI_PERIOD = 14; const STOCH_K = 14; const STOCH_D = 3; const STOCH_SMOOTH_K = 3;
const STOCH_MIN_RR_RATIO = 0.5; const STOCH_VOLUME_MULTIPLIER = 1.0;

// Kırılım Stratejileri (Genel ATR/RSI Periyotları)
const BREAKOUT_BASE_ATR_PERIOD = 14;
const BREAKOUT_BASE_RSI_PERIOD = 14;
const BREAKOUT_BASE_TP_PERCENTAGE = 5.0; // Sabit TP yüzdesi

// Kırılım Ayarları - 15 Dakika (Strateji 2)
// const BRK15M_TIMEFRAME = TIMEFRAME_15M; // Tanımlı zaten
const BRK15M_LOOKBACK_PERIOD = 40;
const BRK15M_BUFFER_PERCENT = 0.08;
const BRK15M_VOLUME_MULTIPLIER = 1.3;
const BRK15M_SL_ATR_MULTIPLIER = 1.8;
const BRK15M_RSI_LONG_THRESHOLD = 60;
const BRK15M_RSI_SHORT_THRESHOLD = 40;

// Kırılım Ayarları - 1 Saat (Strateji 3)
// const BRK1H_TIMEFRAME = TIMEFRAME_1H; // Tanımlı zaten
const BRK1H_LOOKBACK_PERIOD = 50;
const BRK1H_BUFFER_PERCENT = 0.1;
const BRK1H_VOLUME_MULTIPLIER = 1.2;
const BRK1H_SL_ATR_MULTIPLIER = 2.0;
const BRK1H_RSI_LONG_THRESHOLD = 55;
const BRK1H_RSI_SHORT_THRESHOLD = 45;
const BREAKOUT_SCAN_INTERVAL_1H = 15 * 60 * 1000;

// Kırılım Ayarları - 2 Saat (Strateji 4)
// const BRK2H_TIMEFRAME = TIMEFRAME_2H; // Tanımlı zaten
const BRK2H_LOOKBACK_PERIOD = 50;
const BRK2H_BUFFER_PERCENT = 0.1;
const BRK2H_VOLUME_MULTIPLIER = 1.2;
const BRK2H_SL_ATR_MULTIPLIER = 2.0;
const BRK2H_RSI_LONG_THRESHOLD = 55;
const BRK2H_RSI_SHORT_THRESHOLD = 45;
const BREAKOUT_SCAN_INTERVAL_2H = 30 * 60 * 1000;


// Momentum (Strateji 5)
const MOMENTUM_TIMEFRAME = TIMEFRAME_1M; const MOMENTUM_LOOKBACK = 20;
const MOMENTUM_SCAN_INTERVAL = 10 * 1000; const MOMENTUM_API_DELAY_MS = 250;
const VOLUME_SPIKE_MULTIPLIER = 5.0; const PRICE_SPIKE_PERCENT = 0.5;
const MOMENTUM_TREND_FILTER_EMA_PERIOD = 50; // 5m EMA 50
const MOMENTUM_BB_PERIOD = 20;
// ✅ DÜZELTME: Momentum için özel BB StdDev tanımla (veya global olanı kullan)
const MOMENTUM_BB_STDDEV = STOCH_BB_STDDEV; // Global BB stddev kullanılıyor
const MOMENTUM_COOLDOWN_MS = 10 * 60 * 1000;
const MOMENTUM_SIGNAL_LIFESPAN = 5 * 60 * 1000;

// EMA Bounce (Strateji 6)
const BOUNCE_LEVEL_TIMEFRAME = TIMEFRAME_1H; const BOUNCE_LEVEL_EMA_PERIOD = 50;
const BOUNCE_ENTRY_TIMEFRAME = TIMEFRAME_15M;
const BOUNCE_STOCH_RSI_PERIOD = 14; const BOUNCE_STOCH_K = 14; const BOUNCE_STOCH_D = 3; const BOUNCE_STOCH_SMOOTH_K = 3;
const BOUNCE_BB_PERIOD = 20; const BOUNCE_BB_STDDEV = 2;
const BOUNCE_SL_PERCENTAGE_FALLBACK = 1.5;

// Genel Ayarlar
const REQUIRED_CANDLE_BUFFER = 100;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const MARKET_FILTER_TIMEFRAME = TIMEFRAME_4H;
const MARKET_FILTER_EMA_PERIOD = 200;

let signalCooldowns = {};
let globalWatchlist = {};
let globalTargetList = [];
let momentumCooldowns = {};

global.APP_STATE = { signals: [], scanStatus: { message: '...', isScanning: false } };
const exchange = new ccxt.bitget({ 'enableRateLimit': true, 'rateLimit': 200 });

// --- TÜM İNDİKATOR HESAPLAMA FONKSİYONLARI ---
function calculateSMA(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const sum = relevantData.reduce((a, b) => (a || 0) + (b || 0), 0); const sma = sum / period; return isNaN(sma) ? null : sma; }
function calculateEMA(closes, period) { if (!Array.isArray(closes) || closes.length < period) return null; const k = 2 / (period + 1); let emaArray = []; let firstSma = calculateSMA(closes.slice(0, period), period); if (firstSma === null) return null; emaArray.push(firstSma); for (let i = period; i < closes.length; i++) { if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null; const prevEma = emaArray[emaArray.length - 1]; let ema = (closes[i] * k) + (prevEma * (1 - k)); if (isNaN(ema)) return null; emaArray.push(ema); } return emaArray.length > 0 ? emaArray[emaArray.length - 1] : null; }
function calculateStdDev(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const mean = calculateSMA(relevantData, period); if (mean === null) return null; const squareDiffs = relevantData.map(value => Math.pow((value || 0) - mean, 2)); const sumSquareDiffs = squareDiffs.reduce((a, b) => a + b, 0); const variance = sumSquareDiffs / period; if (isNaN(variance) || variance < 0) return null; return Math.sqrt(variance); }
function calculateBollingerBands(closes, period, stdDevMultiplier) { if (!closes || closes.length < period) return null; let middleBandSmaArray = []; for (let i = period - 1; i < closes.length; i++) { const slice = closes.slice(i - period + 1, i + 1); const sma = calculateSMA(slice, period); if (sma === null) return null; middleBandSmaArray.push(sma); } if (middleBandSmaArray.length === 0) return null; const middleBand = middleBandSmaArray[middleBandSmaArray.length - 1]; const stdDev = calculateStdDev(closes.slice(-period), period); if (middleBand === null || stdDev === null || stdDev < 0) return null; const upperBand = middleBand + (stdDev * stdDevMultiplier); const lowerBand = middleBand - (stdDev * stdDevMultiplier); if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(middleBand)) return null; return { upperBand, middleBand, lowerBand }; }
function calculateRSI(closes, rsiPeriod = 14) { if (!Array.isArray(closes) || closes.length < rsiPeriod + 1) return null; let gains = []; let losses = []; for (let i = 1; i < closes.length; i++) { const currentClose = closes[i]; const prevClose = closes[i - 1]; if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) return null; const diff = currentClose - prevClose; gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0); } if (gains.length < rsiPeriod) return null; let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; for (let i = rsiPeriod; i < gains.length; i++) { avgGain = (avgGain * (rsiPeriod - 1) + gains[i]) / rsiPeriod; avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; const rsi = 100 - (100 / (1 + rs)); return isNaN(rsi) ? null : rsi; }
function calculateStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) { try { const minRequiredCandles = rsiPeriod + stochPeriod -1; if (!Array.isArray(closes) || closes.length < minRequiredCandles + 1 ) return null; let rsiValues = []; for (let i = rsiPeriod; i < closes.length; i++) { const rsiSegment = closes.slice(i - rsiPeriod, i + 1); const rsiVal = calculateRSI(rsiSegment, rsiPeriod); if (rsiVal !== null && !isNaN(rsiVal)) { rsiValues.push(rsiVal); } else { return null; } } if (rsiValues.length < stochPeriod) { return null; } let stochKValues = []; for (let i = stochPeriod - 1; i < rsiValues.length; i++) { const periodSlice = rsiValues.slice(i - stochPeriod + 1, i + 1); if (periodSlice.some(isNaN)) { return null; } const lowestRSI = Math.min(...periodSlice); const highestRSI = Math.max(...periodSlice); const currentRSI = rsiValues[i]; let stochK; if (highestRSI === lowestRSI) { stochK = 50; } else { stochK = Math.max(0, Math.min(100, ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100)); } if (!isNaN(stochK)) { stochKValues.push(stochK); } else { return null; } } if (stochKValues.length < kSmooth) { return null; } let slowKValues = []; for (let i = kSmooth - 1; i < stochKValues.length; i++) { const kSlice = stochKValues.slice(i - kSmooth + 1, i + 1); if (kSlice.length < kSmooth) continue; const smaK = calculateSMA(kSlice, kSmooth); if (smaK !== null && !isNaN(smaK)) { slowKValues.push(smaK); } else { return null; } } if (slowKValues.length < dSmooth) { return null; } let slowDValues = []; for (let i = dSmooth - 1; i < slowKValues.length; i++) { const dSlice = slowKValues.slice(i - dSmooth + 1, i + 1); if (dSlice.length < dSmooth) continue; const smaD = calculateSMA(dSlice, dSmooth); if (smaD !== null && !isNaN(smaD)) { slowDValues.push(smaD); } else { return null; } } const K = slowKValues.length > 0 ? slowKValues[slowKValues.length - 1] : null; const D = slowDValues.length > 0 ? slowDValues[slowDValues.length - 1] : null; const prevK = slowKValues.length > 1 ? slowKValues[slowKValues.length - 2] : null; const prevD = slowDValues.length > 1 ? slowDValues[slowDValues.length - 2] : null; if (K === null || D === null || isNaN(K) || isNaN(D) || prevK === null || prevD === null || isNaN(prevK) || isNaN(prevD)) { return null; } return { K, D, prevK, prevD }; } catch (e) { console.error(`[calculateStochasticRSI Hatası]: ${e.message}`); return null; } }
async function checkMTF_EMA(ccxtSymbol, timeframe = TIMEFRAME_1H, period = STOCH_EMA_PERIOD) { const requiredCandleCount = period + 5; try { const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, requiredCandleCount); if (!ohlcv || ohlcv.length < period) return null; const closes = ohlcv.map(m => m[4]); const emaValue = calculateEMA(closes, period); if (emaValue === null) return null; const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof emaValue !== 'number' || isNaN(emaValue)) return null; return { isUptrend: lastClosePrice > emaValue, isDowntrend: lastClosePrice < emaValue, trendStatus: lastClosePrice > emaValue ? 'YÜKSELİŞ' : (lastClosePrice < emaValue ? 'DÜŞÜŞ' : 'YAN'), emaValue: emaValue }; } catch (e) { return null; } }
async function checkMarketCondition(ccxtSymbol) { const requiredCandleCount = MARKET_FILTER_EMA_PERIOD + 50; try { const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, MARKET_FILTER_TIMEFRAME, undefined, requiredCandleCount); if (!ohlcv || ohlcv.length < MARKET_FILTER_EMA_PERIOD) { return { overallTrend: 'UNKNOWN' }; } const closes = ohlcv.map(m => m[4]); const lastEma200 = calculateEMA(closes, MARKET_FILTER_EMA_PERIOD); if (lastEma200 === null) { return { overallTrend: 'UNKNOWN' }; } const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) { return { overallTrend: 'UNKNOWN' }; } if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' }; else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' }; else return { overallTrend: 'SIDEWAYS' }; } catch (e) { console.error(`[checkMarketCondition Hatası (${ccxtSymbol})]: ${e.message}`); return { overallTrend: 'UNKNOWN' }; } }
function calculateVWAP(ohlcv) { if (!ohlcv || ohlcv.length === 0) return null; let cumulativePriceVolume = 0; let cumulativeVolume = 0; for (const candle of ohlcv) { if (!Array.isArray(candle) || candle.length < 6 || typeof candle[2] !== 'number' || isNaN(candle[2]) || typeof candle[3] !== 'number' || isNaN(candle[3]) || typeof candle[4] !== 'number' || isNaN(candle[4]) || typeof candle[5] !== 'number' || isNaN(candle[5]) || candle[5] < 0) { continue; } const high = candle[2]; const low = candle[3]; const close = candle[4]; const volume = candle[5]; const typicalPrice = (high + low + close) / 3; cumulativePriceVolume += typicalPrice * volume; cumulativeVolume += volume; } if (cumulativeVolume === 0) return null; const vwap = cumulativePriceVolume / cumulativeVolume; return isNaN(vwap) ? null : vwap; }
function calculateFibonacciExtension(ohlcv, period, signal) { if (!ohlcv || ohlcv.length < period) return null; const relevantData = ohlcv.slice(-period); const validLows = relevantData.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v)); const validHighs = relevantData.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v)); if (validLows.length === 0 || validHighs.length === 0) return null; const lowestLow = Math.min(...validLows); const highestHigh = Math.max(...validHighs); if (highestHigh <= lowestLow) return null; const range = highestHigh - lowestLow; let extensionLevel = null; if (signal === 'LONG') { extensionLevel = highestHigh + (range * 0.618); } else if (signal === 'SHORT') { extensionLevel = lowestLow - (range * 0.618); } return isNaN(extensionLevel) ? null : extensionLevel; }
function calculateATR(ohlcv, period = 14) { if (!ohlcv || ohlcv.length < period + 1) return null; let trueRanges = []; for (let i = ohlcv.length - period -1; i < ohlcv.length -1; i++) { const currentCandle = ohlcv[i+1]; const prevCandle = ohlcv[i]; if (!currentCandle || currentCandle.length < 5 || !prevCandle || prevCandle.length < 5) continue; const high = currentCandle[2]; const low = currentCandle[3]; const prevClose = prevCandle[4]; if (typeof high !== 'number' || typeof low !== 'number' || typeof prevClose !== 'number') continue; const tr1 = high - low; const tr2 = Math.abs(high - prevClose); const tr3 = Math.abs(low - prevClose); const trueRange = Math.max(tr1, tr2, tr3); if (!isNaN(trueRange)) { trueRanges.push(trueRange); } } if (trueRanges.length < period) return null; const atr = calculateSMA(trueRanges, period); return isNaN(atr) ? null : atr; }
// --- İNDİKATOR FONKSİYONLARI SONU ---


/** AŞAMA 1 - HIZLI ÖN TARAYICI (GELİŞTİRİLMİŞ LOGLAMA İLE) */
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
        console.log("[runPreScan] Ticker verileri çekiliyor...");
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) {
            console.warn("\x1b[33m[runPreScan UYARI]: Ön tarama ticker'ları alınamadı (API yanıtı boş olabilir).\x1b[0m");
            globalTargetList = []; return;
        }
        const allTickers = Object.values(tickers);
        console.log(`[runPreScan] ${allTickers.length} adet ticker bilgisi alındı.`);
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
        if (globalTargetList.length === 0 && allTickers.length > 0) {
             console.warn(`\x1b[33m[runPreScan UYARI]: Hedef listesi boş! Hacim filtresi (${PRESCAN_MIN_24H_VOLUME_USDT} USDT) çok yüksek olabilir veya aktif/swap/usdt coini bulunamadı.\x1b[0m`);
        }
    } catch (error) {
        console.error(`\x1b[31m[runPreScan KRİTİK HATA]: ${error.message}\x1b[0m`);
        globalTargetList = [];
    }
}


/** STRATEJİ 1 (15m): V12.6 - Stoch+EMA */
async function analyzeStochEMACoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    // console.log(`[StochEMA DEBUG] ${ccxtSymbol} analizi başlıyor...`);
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null; const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-STOCHEMA'; if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;
        const requiredCandleCount = REQUIRED_CANDLE_BUFFER + 50; const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME_15M, undefined, requiredCandleCount);
        if (!ohlcv || ohlcv.length < 50) return null; const mtfTrend = await checkMTF_EMA(ccxtSymbol, TIMEFRAME_1H, STOCH_EMA_PERIOD);
        const closes = ohlcv.map(m => m[4]).filter(v => typeof v === 'number' && !isNaN(v)); const volumes = ohlcv.map(m => m[5]).filter(v => typeof v === 'number' && !isNaN(v) && v >= 0);
        if (closes.length < 50 || volumes.length < 50) return null; const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null;
        const ema = calculateEMA(closes, STOCH_EMA_PERIOD);
        const bb = calculateBollingerBands(closes, STOCH_BB_PERIOD, STOCH_BB_STDDEV);
        const stochRSI = calculateStochasticRSI(closes, STOCH_RSI_PERIOD, STOCH_K, STOCH_SMOOTH_K, STOCH_D);
        const vwap = calculateVWAP(ohlcv.slice(-STOCH_BB_PERIOD));
        const isMtfUptrend = mtfTrend ? mtfTrend.isUptrend : false; const isMtfDowntrend = mtfTrend ? mtfTrend.isDowntrend : false; const mtfStatus = mtfTrend?.trendStatus || 'Bilinmiyor';
        if (bb === null || stochRSI === null || ema === null || vwap === null) return null;
        const { upperBand, lowerBand, middleBand } = bb; const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        let signal = 'WAIT'; let reason = ''; let confidence = 50; let isFiltered = false;
        const lastVolume = volumes[volumes.length - 1]; const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), STOCH_BB_PERIOD); let volumeStatus = 'Normal';
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * STOCH_VOLUME_MULTIPLIER; if (isVolumeStrong) { volumeStatus = `Yeterli (${(lastVolume / avgVolume).toFixed(1)}x)`; } else if (avgVolume) { volumeStatus = `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`; }
        const stochBullishCross = prevK <= prevD && stochK > stochD; const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversold = stochK < 30; const stochOverbought = stochK > 70; const is15mUptrend = lastClosePrice > ema; const is15mDowntrend = lastClosePrice < ema;
        const isVwapUptrend = lastClosePrice > vwap; const isVwapDowntrend = lastClosePrice < vwap; const touchedLowerBB = lastClosePrice <= lowerBand; const touchedUpperBB = lastClosePrice >= upperBand;
        if (stochBullishCross && stochOversold && touchedLowerBB) { signal = 'LONG'; } else if (stochBullishCross && stochK < 50) { signal = 'LONG'; } else if (stochBearishCross && stochOverbought && touchedUpperBB) { signal = 'SHORT'; } else if (stochBearishCross && stochK > 50) { signal = 'SHORT'; }
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT') { if (signal === 'LONG') { takeProfit = upperBand; stopLoss = lowerBand; } else if (signal === 'SHORT') { takeProfit = lowerBand; stopLoss = upperBand; } if (!takeProfit || !stopLoss || takeProfit === lastClosePrice || stopLoss === lastClosePrice) { signal = 'WAIT'; } else { const risk = Math.abs(lastClosePrice - stopLoss); const reward = Math.abs(takeProfit - lastClosePrice); rrRatio = risk > 0 ? reward / risk : 0; } }
        const bbWidthPercentValue = (middleBand && upperBand && lowerBand && middleBand !== 0) ? (((upperBand - lowerBand) / middleBand) * 100) : 0;
        if (signal !== 'WAIT') {
             if (rrRatio < STOCH_MIN_RR_RATIO) { isFiltered = true; reason = `FİLTRELENDİ: R/R Oranı (${rrRatio.toFixed(2)}) çok düşük (Min: ${STOCH_MIN_RR_RATIO}).`; signal = 'WAIT'; confidence = 55; if (!isWatchlist) { console.log(`\x1b[31m[STOCH RED]: ${fullSymbol} R/R filtresine takıldı. R/R: ${rrRatio.toFixed(2)} (Min: ${STOCH_MIN_RR_RATIO})\x1b[0m`); } }
             if (!isFiltered && (isNaN(bbWidthPercentValue) || bbWidthPercentValue < 0.05)) { isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${isNaN(bbWidthPercentValue)? 'Hesaplanamadı':bbWidthPercentValue.toFixed(2)}) çok düşük/hatalı.`; signal = 'WAIT'; confidence = 55; }
             if (!isFiltered) {
                  let vwapStatusText = 'VWAP Uyumlu'; let mtfTeyitText = '1h Uyumlu'; let trend15mText = '15m Uyumlu'; confidence = 70;
                  if (!((signal === 'LONG' && is15mUptrend) || (signal === 'SHORT' && is15mDowntrend))) { trend15mText = `15m EMA Ters`; confidence -= 10; }
                  if (!((signal === 'LONG' && isVwapUptrend) || (signal === 'SHORT' && isVwapDowntrend))) { vwapStatusText = `VWAP Ters`; confidence -= 10; }
                  if (mtfTrend && !((signal === 'LONG' && isMtfUptrend) || (signal === 'SHORT' && isMtfDowntrend))) { mtfTeyitText = `1h Ters (${mtfStatus})`; confidence -= 10; }
                  if (!isVolumeStrong) { reason += ` [Hacim Düşük: ${volumeStatus}]`; confidence -= 10; } else { reason += ` [Hacim Teyitli]`; confidence += 10; }
                  confidence += (rrRatio * 1);
                  confidence = Math.min(Math.max(confidence, 0), 95);
                  reason = `ONAYLANDI (R/R: ${rrRatio.toFixed(2)}). | 15m: ${trend15mText} | 1h: ${mtfTeyitText} | VWAP: ${vwapStatusText}`;
                  if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
             }
        }
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, 50, signal) : null; let finalSignal = signal; let finalReason = reason;
        if (isManual || isWatchlist) { if (isFiltered) { finalSignal = 'REDDEDİLDİ'; } }
        const vwapStatusTextOutput = vwap !== null ? (lastClosePrice > vwap ? 'VWAP Üzerinde' : (lastClosePrice < vwap ? 'VWAP Altında' : 'VWAP Çevresinde')) : 'Bilinmiyor';
        resultData = {
             id: fullSymbol + '-' + signal + '-' + Date.now() + '-STOCHEMA', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: finalSignal, confidence: confidence.toFixed(0),
             entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
             RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---', reason: finalReason,
             volume: typeof lastVolume === 'number' ? lastVolume.toFixed(2) : '---', volumeStatus: volumeStatus, isFiltered: isFiltered, vwapStatus: vwapStatusTextOutput,
             bbWidth: bbWidthPercentValue.toFixed(2), strategyType: 'StochEMA'
        };
        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
             console.log(`\x1b[32m>>> V12.6 STOCH+EMA SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%, BBW: ${resultData.bbWidth}%)\x1b[0m`);
             return resultData;
        } else { return null; }
    } catch (error) { console.error(`[Stoch+EMA Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


/** STRATEJİ 2, 3, 4 (15m, 1h, 2h): Genel Kırılım Stratejisi Fonksiyonu */
async function analyzeBreakoutStrategy(ccxtSymbol, config) {
    const {
        timeframe, lookbackPeriod, bufferPercent, volumeMultiplier,
        atrPeriod, slAtrMultiplier, rsiPeriod, rsiLongThreshold, rsiShortThreshold,
        tpPercentage, strategyIdSuffix, strategyDisplayName
    } = config;

    let resultData = null; const PRICE_PRECISION = 4;
    // console.log(`[${strategyDisplayName} DEBUG] ${ccxtSymbol} analizi başlıyor...`);
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = `${fullSymbol}-${strategyIdSuffix}`;
        if (signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1);
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, requiredCandles);
        if (!ohlcv || ohlcv.length < requiredCandles) return null;

        const marketCondition = await checkMarketCondition(ccxtSymbol);
        const overallTrend = marketCondition?.overallTrend || 'UNKNOWN';

        const lastCandle = ohlcv[ohlcv.length - 1];
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1);

        if(!lastCandle || lookbackCandles.length < lookbackPeriod) return null;

        const lastClosePrice = lastCandle[4];
        const lastVolume = lastCandle[5];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastVolume !== 'number' || isNaN(lastVolume) || lastVolume < 0) return null;

        let highestHigh = 0; let lowestLow = Infinity; let volumeSum = 0; let validVolumeCount = 0;
        for (const candle of lookbackCandles) {
             if(candle.length < 6) continue;
             const high = candle[2]; const low = candle[3]; const volume = candle[5];
             if (typeof high !== 'number' || isNaN(high) || typeof low !== 'number' || isNaN(low) ) continue;
             if (high > highestHigh) highestHigh = high;
             if (low < lowestLow) lowestLow = low;
             if(typeof volume === 'number' && !isNaN(volume) && volume >= 0) { volumeSum += volume; validVolumeCount++; }
        }
        if (highestHigh === 0 || lowestLow === Infinity || validVolumeCount === 0 || highestHigh <= lowestLow) return null;

        const avgVolume = volumeSum / validVolumeCount; if(isNaN(avgVolume) || avgVolume <= 0) return null;

        const atr = calculateATR(ohlcv, atrPeriod);
        const rsi = calculateRSI(ohlcv.map(c => c[4]), rsiPeriod);
        if (atr === null || rsi === null) { return null; }

        let signal = 'WAIT'; let reason = ''; let confidence = 75; let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + bufferPercent / 100);
        const breakoutBufferLow = lowestLow * (1 - bufferPercent / 100);

        if (lastClosePrice > breakoutBufferHigh) { signal = 'LONG'; reason = `${strategyDisplayName} Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`; }
        else if (lastClosePrice < breakoutBufferLow) { signal = 'SHORT'; reason = `${strategyDisplayName} Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`; }

        if (signal !== 'WAIT') {
             if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: 4h Trendi Yükselişte.`; signal = 'WAIT'; confidence = 60; }
             else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: 4h Trendi Düşüşte.`; signal = 'WAIT'; confidence = 60; }

             if (!isFiltered) {
                  if (signal === 'LONG' && rsi < rsiLongThreshold) {
                       isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) < ${rsiLongThreshold}. Momentum zayıf. ${reason}`; signal = 'WAIT'; confidence = 55;
                  } else if (signal === 'SHORT' && rsi > rsiShortThreshold) {
                       isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) > ${rsiShortThreshold}. Momentum zayıf. ${reason}`; signal = 'WAIT'; confidence = 55;
                  }
             }

             if (!isFiltered) {
                  const isVolumeConfirmed = lastVolume >= avgVolume * volumeMultiplier;
                  const isBalinaConfirmed = lastVolume >= avgVolume * 2.0;
                  if (isBalinaConfirmed) { reason += ` | BALİNA TEYİTLİ (${(lastVolume / avgVolume).toFixed(1)}x)`; confidence = 98; }
                  else if (isVolumeConfirmed) { reason += ` | Hacim Teyitli (${(lastVolume / avgVolume).toFixed(1)}x)`; confidence = 90; }
                  else { reason += ` | DÜŞÜK HACİM (${(lastVolume / avgVolume).toFixed(1)}x)`; confidence -= 15; }

                  if (signal === 'LONG') confidence += Math.max(0, (rsi - rsiLongThreshold) / 2);
                  else if (signal === 'SHORT') confidence += Math.max(0, (rsiShortThreshold - rsi) / 2);
             }
        }

        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            if (signal === 'LONG') {
                takeProfit = lastClosePrice * (1 + tpPercentage / 100);
                stopLoss = lastClosePrice - (atr * slAtrMultiplier);
            } else if (signal === 'SHORT') {
                takeProfit = lastClosePrice * (1 - tpPercentage / 100);
                stopLoss = lastClosePrice + (atr * slAtrMultiplier);
            }

            if (takeProfit && stopLoss && takeProfit !== lastClosePrice && stopLoss !== lastClosePrice && ( (signal === 'LONG' && takeProfit > stopLoss) || (signal === 'SHORT' && takeProfit < stopLoss) ) ) {
                const risk = Math.abs(lastClosePrice - stopLoss);
                const reward = Math.abs(takeProfit - lastClosePrice);
                rrRatio = risk > 0 ? reward / risk : 0;
                confidence = Math.round(Math.min(Math.max(confidence, 0), 99));
                reason += ` | R/R: ${rrRatio.toFixed(2)}`;
                signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
            } else { signal = 'WAIT'; confidence = 0; }
        }

        const volumeStatusText = `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)}`;

        resultData = {
            id: `${fullSymbol}-${signal}-${Date.now()}-${strategyIdSuffix}`, ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
            RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(),
            reason: reason, volume: lastVolume.toFixed(2), volumeStatus: volumeStatusText, isFiltered: (signal === 'WAIT' && isFiltered),
            strategyType: strategyIdSuffix // Strateji tipini ID'den alıyoruz (BRK15M, BRK1H, BRK2H)
        };

        if (signal !== 'WAIT') {
             console.log(`\x1b[36m>>> ${strategyDisplayName} KIRILIM SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%, R/R: ${resultData.RR})\x1b[0m`);
             return resultData;
        } else {
             return null;
        }
    } catch (error) { console.error(`[${strategyDisplayName} Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


/** STRATEJİ 5 (1m): Momentum Patlaması */
async function analyzeMomentumSpike(ccxtSymbol) {
    let resultData = null; const PRICE_PRECISION = 6;
    // console.log(`[Momentum DEBUG] ${ccxtSymbol} analizi başlıyor...`);
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-MOMENTUM';
        if (momentumCooldowns[cooldownKey] && momentumCooldowns[cooldownKey].timestamp > Date.now() - MOMENTUM_COOLDOWN_MS) { return null; }
        const requiredTrendCandles = MOMENTUM_TREND_FILTER_EMA_PERIOD + 5;
        const ohlcv5m = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME_5M, undefined, requiredTrendCandles);
        if (!ohlcv5m || ohlcv5m.length < MOMENTUM_TREND_FILTER_EMA_PERIOD) return null;
        const closes5m = ohlcv5m.map(c => c[4]);
        const lastEma5m = calculateEMA(closes5m, MOMENTUM_TREND_FILTER_EMA_PERIOD);
        if (lastEma5m === null) return null;
        const lastClose5m = closes5m[closes5m.length - 1];
        const requiredCandleCount = MOMENTUM_LOOKBACK + MOMENTUM_BB_PERIOD + 2;
        const ohlcv1m = await exchange.fetchOHLCV(ccxtSymbol, MOMENTUM_TIMEFRAME, undefined, requiredCandleCount);
        if (!ohlcv1m || ohlcv1m.length < MOMENTUM_LOOKBACK + 2) return null;
        const lastCandle = ohlcv1m[ohlcv1m.length - 1]; const prevCandle = ohlcv1m[ohlcv1m.length - 2];
        if (!lastCandle || !prevCandle || typeof lastCandle[4] !== 'number' || typeof prevCandle[4] !== 'number' || typeof lastCandle[5] !== 'number' || lastCandle[5] < 0) return null;
        const lastClose1m = lastCandle[4]; const lastVolume1m = lastCandle[5]; const prevClose1m = prevCandle[4];
        const volumeLookbackData = ohlcv1m.slice(-(MOMENTUM_LOOKBACK + 1), -1).map(c => c[5]).filter(v => typeof v === 'number' && v >= 0);
        if (volumeLookbackData.length < MOMENTUM_LOOKBACK / 2) return null;
        const avgVolume = volumeLookbackData.reduce((a, b) => a + b, 0) / volumeLookbackData.length;
        if (isNaN(avgVolume) || avgVolume <= 0) return null;
        const priceChangePercent = prevClose1m === 0 ? 0 : ((lastClose1m - prevClose1m) / prevClose1m) * 100;
        const volumeMultiplier = lastVolume1m / avgVolume;
        let signal = 'WAIT'; let trendFilterPassed = false;
        const isPumpCondition = volumeMultiplier >= VOLUME_SPIKE_MULTIPLIER && priceChangePercent >= PRICE_SPIKE_PERCENT;
        const isDumpCondition = volumeMultiplier >= VOLUME_SPIKE_MULTIPLIER && priceChangePercent <= -PRICE_SPIKE_PERCENT;
        if (isPumpCondition && lastClose5m > lastEma5m) { signal = 'PUMP'; trendFilterPassed = true; }
        else if (isDumpCondition && lastClose5m < lastEma5m) { signal = 'DUMP'; trendFilterPassed = true; }
        const bbCloses = ohlcv1m.slice(-MOMENTUM_BB_PERIOD).map(m => m[4]);
        const bbMomentum = calculateBollingerBands(bbCloses, MOMENTUM_BB_PERIOD, MOMENTUM_BB_STDDEV); // MOMENTUM_BB_STDDEV kullanıldı
        let bbWidthPercentValue = 0; if (bbMomentum && typeof bbMomentum.middleBand === 'number' && bbMomentum.middleBand !== 0) { bbWidthPercentValue = (((bbMomentum.upperBand - bbMomentum.lowerBand) / bbMomentum.middleBand) * 100); }
        if (signal !== 'WAIT' && trendFilterPassed) {
            momentumCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
            resultData = {
                id: fullSymbol + '-' + signal + '-' + Date.now() + '-MOMENTUM', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, entryPrice: lastClose1m.toFixed(PRICE_PRECISION),
                timestamp: Date.now(), time: new Date().toLocaleTimeString(), volumeMultiplier: volumeMultiplier.toFixed(1) + 'x', priceChangePercent: priceChangePercent.toFixed(2) + '%',
                bbWidth: bbWidthPercentValue.toFixed(2), reason: `Hacim: ${volumeMultiplier.toFixed(1)}x, Fiyat Değ: ${priceChangePercent.toFixed(2)}% | 5m EMA ${lastClose5m > lastEma5m ? 'Üstü' : 'Altı'}`,
                strategyType: 'Momentum'
            };
            const colorCode = signal === 'PUMP' ? '\x1b[32m' : '\x1b[31m';
            console.log(`${colorCode}>>> V1.0 MOMENTUM SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Hacim: ${resultData.volumeMultiplier}, Fiyat: ${resultData.priceChangePercent}, BBW: ${resultData.bbWidth}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { console.error(`[Momentum Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


/** STRATEJİ 6 (15m): EMA Bounce (Esnek Güven Puanı) */
async function analyzeEMABounce(ccxtSymbol) {
    let resultData = null; const PRICE_PRECISION = 4;
    // console.log(`[EMABounce DEBUG] ${ccxtSymbol} analizi başlıyor...`);
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-EMABOUNCE';
        if (signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;
        const requiredLevelCandles = BOUNCE_LEVEL_EMA_PERIOD + 5;
        const ohlcvLevel = await exchange.fetchOHLCV(ccxtSymbol, BOUNCE_LEVEL_TIMEFRAME, undefined, requiredLevelCandles);
        if (!ohlcvLevel || ohlcvLevel.length < BOUNCE_LEVEL_EMA_PERIOD) return null;
        const closesLevel = ohlcvLevel.map(c => c[4]);
        const currentEmaLevel = calculateEMA(closesLevel, BOUNCE_LEVEL_EMA_PERIOD);
        if (currentEmaLevel === null) return null;
        const requiredEntryCandles = REQUIRED_CANDLE_BUFFER + 50;
        const ohlcvEntry = await exchange.fetchOHLCV(ccxtSymbol, BOUNCE_ENTRY_TIMEFRAME, undefined, requiredEntryCandles);
        if (!ohlcvEntry || ohlcvEntry.length < 50) return null;
        const closesEntry = ohlcvEntry.map(m => m[4]).filter(v => typeof v === 'number' && !isNaN(v));
        if (closesEntry.length < 50) return null;
        const lastClosePrice = closesEntry[closesEntry.length - 1];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null;
        const stochRSI = calculateStochasticRSI(closesEntry, BOUNCE_STOCH_RSI_PERIOD, BOUNCE_STOCH_K, BOUNCE_STOCH_SMOOTH_K, BOUNCE_STOCH_D);
        if (stochRSI === null) return null;
        const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        const bb = calculateBollingerBands(closesEntry, BOUNCE_BB_PERIOD, BOUNCE_BB_STDDEV);
        if (bb === null) return null;
        const { upperBand, lowerBand } = bb;
        let signal = 'WAIT'; let reason = ''; let confidence = 0;
        const stochBullishCross = prevK <= prevD && stochK > stochD;
        const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversoldValue = 30;
        const stochOverboughtValue = 70;
        if (lastClosePrice <= currentEmaLevel && stochBullishCross && prevK < stochOversoldValue) {
            signal = 'LONG';
            reason = `1s EMA ${BOUNCE_LEVEL_EMA_PERIOD} desteği (${currentEmaLevel.toFixed(PRICE_PRECISION)}) civarı + 15m Stoch Aşırı Satımdan Kesişim.`;
            confidence = 60;
            confidence += Math.max(0, (stochOversoldValue - prevK) * 0.5);
        }
        else if (lastClosePrice >= currentEmaLevel && stochBearishCross && prevK > stochOverboughtValue) {
            signal = 'SHORT';
            reason = `1s EMA ${BOUNCE_LEVEL_EMA_PERIOD} direnci (${currentEmaLevel.toFixed(PRICE_PRECISION)}) civarı + 15m Stoch Aşırı Alımdan Kesişim.`;
            confidence = 60;
            confidence += Math.max(0, (prevK - stochOverboughtValue) * 0.5);
        }
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT') {
            if (signal === 'LONG') { takeProfit = upperBand; stopLoss = Math.min(lowerBand, lastClosePrice * (1 - (BOUNCE_SL_PERCENTAGE_FALLBACK / 100))); }
            else if (signal === 'SHORT') { takeProfit = lowerBand; stopLoss = Math.max(upperBand, lastClosePrice * (1 + (BOUNCE_SL_PERCENTAGE_FALLBACK / 100))); }
            if (takeProfit && stopLoss && takeProfit !== lastClosePrice && stopLoss !== lastClosePrice && ( (signal === 'LONG' && takeProfit > stopLoss) || (signal === 'SHORT' && takeProfit < stopLoss) ) ) {
                const risk = Math.abs(lastClosePrice - stopLoss);
                const reward = Math.abs(takeProfit - lastClosePrice);
                rrRatio = risk > 0 ? reward / risk : 0;
                confidence += Math.max(0, (rrRatio - 0.5) * 10);
                const priceDistancePercent = Math.abs(lastClosePrice - currentEmaLevel) / currentEmaLevel * 100;
                if (priceDistancePercent < 0.1) confidence += 10;
                else if (priceDistancePercent < 0.3) confidence += 5;
                confidence = Math.round(Math.min(Math.max(confidence, 0), 99));
                reason += ` | R/R: ${rrRatio.toFixed(2)}`;
                signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
            } else { signal = 'WAIT'; confidence = 0; }
        }
        if (signal !== 'WAIT') {
            resultData = {
                id: fullSymbol + '-' + signal + '-' + Date.now() + '-BOUNCE', ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: signal, confidence: confidence.toFixed(0),
                entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
                RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(), reason: reason,
                strategyType: 'EMABounce'
            };
            console.log(`\x1b[34m>>> YENİ STRATEJİ SİNYALİ (EMA Bounce): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { console.error(`[EMA Bounce Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


// --- ANA TARAMA VE YARDIMCI FONKSİYONLAR ---
async function runWatchlistScan() { if (Object.keys(globalWatchlist).length === 0) return; let updatedWatchlist = {}; for (const [symbol, item] of Object.entries(globalWatchlist)) { try { if (!item || !item.ccxtSymbol) { updatedWatchlist[symbol] = item; continue; } const analysisResult = await analyzeStochEMACoin(item.ccxtSymbol, false, true); if (analysisResult) { updatedWatchlist[symbol] = { ...item, ...analysisResult, statusClass: analysisResult.signal === 'LONG' ? 'bg-long' : (analysisResult.signal === 'SHORT' ? 'bg-short' : (analysisResult.isFiltered ? 'status-reddet' : 'bg-wait')) }; } else { updatedWatchlist[symbol] = {...item, signal: 'HATA/YOK', reason:`Analiz başarısız`, statusClass:'bg-wait'}; }} catch (e) { updatedWatchlist[symbol] = {...item, signal: 'HATA', reason:`Tarama Hatası: ${e.message}`, statusClass:'bg-wait'}; }} if(Object.keys(updatedWatchlist).length > 0) { globalWatchlist = updatedWatchlist; io.emit('watchlist_update', globalWatchlist); } }
async function runScan15m() { const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); global.APP_STATE.scanStatus = { message: `15m Stratejileri Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus); try { if (globalTargetList.length === 0) { console.log("15m tarama için hedef liste boş."); global.APP_STATE.scanStatus = { message: `Tarama Atlandı (Hedef Liste Boş) - ${scanTimeStr}`, isScanning: false }; io.emit('scan_status', global.APP_STATE.scanStatus); return; }; const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 15m STRATEJİLERİ TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); const brk15mConfig = { timeframe: TIMEFRAME_15M, lookbackPeriod: BRK15M_LOOKBACK_PERIOD, bufferPercent: BRK15M_BUFFER_PERCENT, volumeMultiplier: BRK15M_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK15M_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK15M_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK15M_RSI_SHORT_THRESHOLD, tpPercentage: BREAKOUT_BASE_TP_PERCENTAGE, strategyIdSuffix: 'BRK15M', strategyDisplayName: '15m' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; let signalFound = false; try { const stochResult = await analyzeStochEMACoin(ccxtSymbol, false, false); if (stochResult && stochResult.signal !== 'WAIT' && !stochResult.isFiltered) { global.APP_STATE.signals.unshift(stochResult); io.emit('yeni_sinyal', stochResult); signalFound = true; } } catch (loopError) { console.error(`[15m Stoch Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 3)); if (!signalFound) { try { const bounceResult = await analyzeEMABounce(ccxtSymbol); if (bounceResult && bounceResult.signal !== 'WAIT') { global.APP_STATE.signals.unshift(bounceResult); io.emit('yeni_sinyal', bounceResult); signalFound = true; } } catch (loopError) { console.error(`[15m Bounce Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 3)); if (!signalFound) { try { const breakout15mResult = await analyzeBreakoutStrategy(ccxtSymbol, brk15mConfig); if (breakout15mResult && breakout15mResult.signal !== 'WAIT') { global.APP_STATE.signals.unshift(breakout15mResult); io.emit('yeni_sinyal', breakout15mResult); } } catch (loopError) { console.error(`[15m Breakout Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 3)); } } catch (error) { console.error("Kritik 15m Tarama Hatası:", error.message); } finally { const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS); const momentumTemizlemeZamani = Date.now() - (MOMENTUM_SIGNAL_LIFESPAN); global.APP_STATE.signals = global.APP_STATE.signals.filter(s => { if (!s || !s.timestamp) return false; if (s.strategyType === 'Momentum') { return s.timestamp > momentumTemizlemeZamani; } else { return s.timestamp > temizelemeZamani; } }); global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; io.emit('scan_status', global.APP_STATE.scanStatus); console.log(`--- 15m STRATEJİLERİ TARAMA TAMAMLANDI (${scanTimeStr}). ---`); } }
async function runBreakoutScan1h() { const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); try { if (globalTargetList.length === 0) { console.log("1h Kırılım tarama için hedef liste boş."); return; } const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 1h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); const brk1hConfig = { timeframe: TIMEFRAME_1H, lookbackPeriod: BRK1H_LOOKBACK_PERIOD, bufferPercent: BRK1H_BUFFER_PERCENT, volumeMultiplier: BRK1H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK1H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK1H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK1H_RSI_SHORT_THRESHOLD, tpPercentage: BREAKOUT_BASE_TP_PERCENTAGE, strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk1hConfig); if (analysisResult && analysisResult.signal !== 'WAIT') { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); } catch (loopError) { console.error(`[1h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } } } catch (error) { console.error("Kritik 1h Kırılım Tarama Hatası:", error.message); } finally { console.log(`--- 1h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); } }
async function runBreakoutScan2h() { const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); try { if (globalTargetList.length === 0) { console.log("2h Kırılım tarama için hedef liste boş."); return; } const allSwapSymbols = [...globalTargetList]; console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); const brk2hConfig = { timeframe: TIMEFRAME_2H, lookbackPeriod: BRK2H_LOOKBACK_PERIOD, bufferPercent: BRK2H_BUFFER_PERCENT, volumeMultiplier: BRK2H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, tpPercentage: BREAKOUT_BASE_TP_PERCENTAGE, strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' }; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig); if (analysisResult && analysisResult.signal !== 'WAIT') { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); } catch (loopError) { console.error(`[2h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } } } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); } finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); } }
async function runMomentumScan() { if (globalTargetList.length === 0) { return; } const allSwapSymbols = [...globalTargetList]; for (const ccxtSymbol of allSwapSymbols) { if (!ccxtSymbol) continue; try { const analysisResult = await analyzeMomentumSpike(ccxtSymbol); if (analysisResult) { global.APP_STATE.signals.unshift(analysisResult); io.emit('yeni_sinyal', analysisResult); } await new Promise(resolve => setTimeout(resolve, MOMENTUM_API_DELAY_MS)); } catch (loopError) { console.error(`[Momentum HATA - ${ccxtSymbol}]: ${loopError.message}`); } } }

// --- Express Rotaları ve Socket.IO Bağlantısı ---
app.get('/', (req, res) => { console.log(`[Express] Ana sayfa isteği geldi: ${req.url}`); const filePath = path.join(__dirname, 'app.html'); res.sendFile(filePath, { headers: { 'Content-Type': 'text/html' } }, (err) => { if (err) { console.error(`\x1b[31m[Express HATA] app.html gönderme hatası: ${err.message}.\x1b[0m`); res.status(500).send(`<!DOCTYPE html><html><head><title>Sunucu Hatası</title></head><body><h1>Sunucu Hatası</h1><p>Ana sayfa yüklenemedi. Sunucu loglarını kontrol edin.</p><pre>${err.message}</pre></body></html>`); } else { console.log("[Express] app.html başarıyla gönderildi."); } }); });
io.on('connection', (socket) => { console.log('Bir istemci bağlandı:', socket.id); socket.emit('initial_state', global.APP_STATE); socket.emit('watchlist_update', globalWatchlist); socket.on('disconnect', () => { console.log('İstemci bağlantısı kesildi:', socket.id); }); });
app.post('/api/remove-watchlist', (req, res) => { const symbol = req.body.symbol; if (typeof symbol !== 'string' || !symbol) { return res.status(400).json({ error: 'Geçersiz sembol formatı.'}); } if (globalWatchlist[symbol]) { delete globalWatchlist[symbol]; io.emit('watchlist_update', globalWatchlist); console.log(`${symbol} izleme listesinden kaldırıldı.`); res.json({ success: true, message: `${symbol} izleme listesinden kaldırıldı.` }); } else { res.status(404).json({ error: 'Sembol izleme listesinde bulunamadı.' }); } });
app.post('/api/analyze-coin', async (req, res) => { const userSymbolInput = req.body.symbol; if (!userSymbolInput || typeof userSymbolInput !== 'string') return res.status(400).json({ error: 'Geçersiz sembol formatı.' }); const cleanBaseSymbol = userSymbolInput.toUpperCase().replace('/USDT', '').replace(':USDT', '').replace('USDT', '').replace('PERP', '').trim(); const fullSymbol = cleanBaseSymbol + 'USDT'; try { if (!exchange.markets || Object.keys(exchange.markets).length === 0) { await exchange.loadMarkets(true); if (!exchange.markets || Object.keys(exchange.markets).length === 0) { return res.status(503).json({ error: 'Borsa marketleri yüklenemedi.' }); }} const foundMarket = Object.values(exchange.markets).find(m => m.active && m.swap && m.quote === 'USDT' && m.base === cleanBaseSymbol); if (foundMarket && foundMarket.symbol) { const targetCcxtSymbol = foundMarket.symbol; console.log(`Manuel analiz isteği: ${userSymbolInput} -> ${targetCcxtSymbol}`); const result = await analyzeStochEMACoin(targetCcxtSymbol, true, true); if (result) { console.log(`${fullSymbol} izleme listesine ekleniyor/güncelleniyor.`); globalWatchlist[fullSymbol] = { ccxtSymbol: targetCcxtSymbol, ...result, statusClass: result.statusClass || (result.signal === 'LONG' ? 'bg-long' : (result.signal === 'SHORT' ? 'bg-short' : (result.isFiltered ? 'status-reddet' : 'bg-wait'))) }; io.emit('watchlist_update', globalWatchlist); res.json(result); } else { console.log(`${fullSymbol} izleme listesine eklendi (analiz sonucu null).`); globalWatchlist[fullSymbol] = { ccxtSymbol: targetCcxtSymbol, symbol: fullSymbol, signal: 'HATA/YOK', reason: 'İlk analiz başarısız/veri yetersiz.', statusClass: 'bg-wait', timestamp: Date.now(), time: new Date().toLocaleTimeString() }; io.emit('watchlist_update', globalWatchlist); res.json({ symbol: fullSymbol, signal: 'HATA/YOK', reason: 'Analiz başarısız/veri yetersiz.' }); } } else { res.status(404).json({ error: `'${cleanBaseSymbol}' için Bitget'te aktif USDT Perpetual Swap marketi bulunamadı.` }); } } catch(err) { console.error("Manuel analiz API hatası:", err.message, err.stack); res.status(500).json({ error: `Sunucu hatası: ${err.message}` }); } });

// --- Sunucu Başlatma ve Döngüler (İLK TARAMALAR AKTİF) ---
server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V13.5 - Multi-TF Breakout) BAŞLATILIYOR - Port: ${PORT}`); // Sürüm V13.5
    console.log(`Node.js Sürümü: ${process.version}`);
    console.log("==============================================");
    console.log("[Başlangıç] Borsa marketleri yükleniyor...");
    try {
        await exchange.loadMarkets(true);
        console.log("[Başlangıç] Marketler yüklendi. İlk ön tarama başlatılıyor...");
        await runPreScan();
        console.log(`[Başlangıç] İlk ön tarama tamamlandı. Hedef liste boyutu: ${globalTargetList.length}`);

        console.log("[Başlangıç] İlk taramalar başlatılıyor...");
        if (globalTargetList.length > 0) {
            runScan15m(); // 15m Stoch/Bounce/Breakout
            runBreakoutScan1h(); // 1h Breakout
            runBreakoutScan2h(); // 2h Breakout
            runMomentumScan(); // 1m Momentum
        } else {
             console.warn("[Başlangıç] Hedef liste boş olduğu için ilk taramalar atlandı.");
        }

        console.log("[Başlangıç] Periyodik tarama döngüleri ayarlanıyor...");
        setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
        setInterval(runPreScan, PRESCAN_INTERVAL);
        // Ana 15m döngüsü
        setInterval(async () => { if (globalTargetList.length > 0 && !global.APP_STATE.scanStatus.isScanning) await runScan15m(); }, SCAN_INTERVAL_15M); // Değişken adı düzeltildi
        // 1h Kırılım döngüsü
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan1h(); }, BREAKOUT_SCAN_INTERVAL_1H);
        // 2h Kırılım döngüsü
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan2h(); }, BREAKOUT_SCAN_INTERVAL_2H);
        // Momentum döngüsü
        setInterval(async () => { if (globalTargetList.length > 0) await runMomentumScan(); }, MOMENTUM_SCAN_INTERVAL);

        console.log(`\n✅ SUNUCU BAŞARIYLA BAŞLATILDI ve http://localhost:${PORT} adresinde dinlemede.`);
        console.log("==============================================");

    } catch (loadError) {
        console.error("\x1b[31m[KRİTİK BAŞLANGIÇ HATASI]: Market/ön-tarama yüklenemedi! Sunucu düzgün çalışmayabilir.\x1b[0m");
        console.error(`Hata Detayı: ${loadError.message}`);
    }
});
console.log("--- server.js dosyası okunması tamamlandı ---");

