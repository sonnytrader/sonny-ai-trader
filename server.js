// server.js (ANA PROJE - V12.2-DEBUG - 15m Stratejiye Log Eklendi)
// SÜRÜM: V12.2-DEBUG (15m Debug Logları, 2h Hacim Puanlamada, R/R 0.5) (26.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V12.2-DEBUG - 15m Log Eklendi) ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors()); app.use(express.json());

// === V12.2 STRATEJİ AYARLARI ===
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

const MIN_RR_RATIO = 0.5; // <<< AYAR: Sinyal sıklığı için R/R 0.5 (Eski 0.75)
const STOCH_VOLUME_MULTIPLIER = 1.0; // Hacim Puanlaması için eşik (Filtre değil)

const REQUIRED_CANDLE_BUFFER = 100;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

// 2h KIRILIM AYARLARI (Hacim Filtresiz, Puanlamalı)
const BREAKOUT_TIMEFRAME = '2h'; const BREAKOUT_LOOKBACK_PERIOD = 50;
const BREAKOUT_SCAN_INTERVAL = 30 * 60 * 1000; const BREAKOUT_BUFFER_PERCENT = 0.1;
const BREAKOUT_VOLUME_MULTIPLIER = 1.2; // <<< AYAR: Bu artık FİLTRE DEĞİL, sadece 'Yüksek Hacim' sınırı. (Eski 1.5)
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
        if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null; // Veri hatası varsa null dön
        ema = (closes[i] * k) + (ema * (1 - k));
        emaArray.push(ema);
    }
    // Düzeltme: Son hesaplanan ema NaN ise tüm array null olmamalı, sadece null dönmeli.
    // Ancak array döndürmek daha tutarlı olabilir, bu yüzden array'i döndürelim ama NaN kontrolü yapalım.
     if (isNaN(emaArray[emaArray.length-1])) return null; // Eğer son EMA NaN ise null dön
    return emaArray; // Tüm EMA değerlerini içeren array'i döndür
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
        // Önceki kapanış da geçerli bir sayı olmalı
        if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) return null; // Hatalı veri varsa null dön
        const diff = currentClose - prevClose;
        gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0);
    }
    if (gains.length < rsiPeriod) return null; // Yeterli veri yoksa
    let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
    let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod;
    if(isNaN(avgGain) || isNaN(avgLoss)) return null; // İlk ortalamalar hesaplanamadıysa

    // Kalan veriler için Wilder's smoothing
    for (let i = rsiPeriod; i < gains.length; i++) {
        avgGain = (avgGain * (rsiPeriod - 1) + gains[i]) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]) / rsiPeriod;
    }
    const rs = avgLoss === 0 ? 10000 : avgGain / avgLoss; // avgLoss 0 ise RS çok büyük olmalı
    const rsi = 100 - (100 / (1 + rs));
    return isNaN(rsi) ? null : rsi;
}
function calculateStochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    try {
        if (!closes || closes.length < rsiPeriod + stochPeriod + kSmooth + dSmooth - 2 ) { // Gerekli minimum veri miktarını kontrol et
             // console.warn(`StochRSI için yetersiz veri: ${closes ? closes.length : 0} mum var.`);
             return null;
        }

        let rsiValues = [];
        // RSI değerlerini hesaplamak için yeterli uzunlukta bir dizi oluştur
        for(let i = rsiPeriod; i < closes.length; i++){
            const rsiSegment = closes.slice(i - rsiPeriod , i + 1);
            const rsiVal = calculateRSI(rsiSegment, rsiPeriod);
            if(rsiVal !== null) {
                rsiValues.push(rsiVal);
            } else {
               // Eğer herhangi bir RSI hesaplanamazsa devam etme
               // console.warn("Bir RSI değeri null döndü.");
               // return null; // Ya da hatayı görmezden gelip devam et? Şimdilik devam edelim.
            }
        }


        if (rsiValues.length < stochPeriod) {
            // console.warn(`Stoch için yetersiz RSI değeri: ${rsiValues.length} < ${stochPeriod}`);
            return null;
        }


        let stochKValues = []; // %K (fast %K değil, StochRSI'ın K'sı)
        for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
            const periodSlice = rsiValues.slice(i - stochPeriod + 1, i + 1);
             if (periodSlice.some(isNaN)) {
                 // console.warn("Stoch periyodunda NaN RSI değeri var.");
                 continue; // Hatalı dilimi atla
             };
            const lowestRSI = Math.min(...periodSlice);
            const highestRSI = Math.max(...periodSlice);
            const currentRSI = rsiValues[i];

             if (highestRSI === lowestRSI) {
                 stochKValues.push(50); // Genellikle 0 veya 100 yerine 50 tercih edilir
             } else {
                 const stochK = Math.max(0, Math.min(100, ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100));
                 if(!isNaN(stochK)) stochKValues.push(stochK);
                 // else { console.warn("Hesaplanan StochK NaN oldu."); }
             }
        }


        if (stochKValues.length < kSmooth) {
             // console.warn(`Slow %K için yetersiz StochK değeri: ${stochKValues.length} < ${kSmooth}`);
             return null;
        }


        let slowKValues = []; // Slow %K
        for (let i = kSmooth - 1; i < stochKValues.length; i++) {
            const kSlice = stochKValues.slice(i - kSmooth + 1, i + 1);
             if(kSlice.length < kSmooth) continue; // Ekstra kontrol
             const smaK = calculateSMA(kSlice, kSmooth);
            if (smaK !== null) slowKValues.push(smaK);
             // else { console.warn("SlowK için SMA null döndü."); }
        }


        if (slowKValues.length < dSmooth) {
            // console.warn(`Slow %D için yetersiz SlowK değeri: ${slowKValues.length} < ${dSmooth}`);
             return null;
        }


        let slowDValues = []; // Slow %D
        for (let i = dSmooth - 1; i < slowKValues.length; i++) {
            const dSlice = slowKValues.slice(i - dSmooth + 1, i + 1);
             if(dSlice.length < dSmooth) continue; // Ekstra kontrol
             const smaD = calculateSMA(dSlice, dSmooth);
            if (smaD !== null) slowDValues.push(smaD);
            // else { console.warn("SlowD için SMA null döndü."); }
        }


        const K = slowKValues.length > 0 ? slowKValues[slowKValues.length - 1] : null;
        const D = slowDValues.length > 0 ? slowDValues[slowDValues.length - 1] : null;
        const prevK = slowKValues.length > 1 ? slowKValues[slowKValues.length - 2] : null;
        const prevD = slowDValues.length > 1 ? slowDValues[slowDValues.length - 2] : null;


        if (K === null || D === null || isNaN(K) || isNaN(D) || prevK === null || prevD === null || isNaN(prevK) || isNaN(prevD)) {
             // console.warn(`Son StochRSI değerleri geçersiz: K=${K}, D=${D}, prevK=${prevK}, prevD=${prevD}`);
             return null;
        }

        return { K, D, prevK, prevD };
    } catch (e) {
         console.error(`calculateStochasticRSI içinde kritik hata: ${e.message}`);
        return null;
    }
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
        if (typeof lastClosePrice1h !== 'number' || isNaN(lastClosePrice1h) || typeof ema1h !== 'number' || isNaN(ema1h)) return null; // Son değerler geçerli mi?
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
         if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) return { overallTrend: 'UNKNOWN' };
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
        // Mum verisi [timestamp, open, high, low, close, volume]
        if (candle.length < 6 || typeof candle[2] !== 'number' || typeof candle[3] !== 'number' || typeof candle[4] !== 'number' || typeof candle[5] !== 'number' || candle[5] < 0) {
           // console.warn("VWAP için geçersiz mum verisi:", candle);
            continue; // Hatalı mumu atla
        }
        const high = candle[2];
        const low = candle[3];
        const close = candle[4];
        const volume = candle[5];
        const typicalPrice = (high + low + close) / 3;
        cumulativePriceVolume += typicalPrice * volume;
        cumulativeVolume += volume;
    }
    return cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
}

function calculateFibonacciExtension(ohlcv, period, signal) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevantData = ohlcv.slice(-period);
    // Veri geçerliliğini kontrol et
    const validLows = relevantData.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v));
    const validHighs = relevantData.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v));
    if(validLows.length === 0 || validHighs.length === 0) return null;

    const lowestLow = Math.min(...validLows);
    const highestHigh = Math.max(...validHighs);

    if (highestHigh <= lowestLow) return null; // Geçersiz aralık

    if (signal === 'LONG') {
        const range = highestHigh - lowestLow;
        return highestHigh + (range * 0.618);
    } else if (signal === 'SHORT') {
        const range = highestHigh - lowestLow;
        return lowestLow - (range * 0.618);
    }
    return null;
}


/**
 * AŞAMA 1 - HIZLI ÖN TARAYICI
 */
async function runPreScan() {
    const scanTime = new Date().toLocaleTimeString();
    console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLANGICI (${scanTime}) ---`);
    let newTargetList = [];
    try {
        // Marketleri her ön taramada yeniden yüklemek API limitlerini zorlayabilir,
        // ama market listesi değiştiyse güncel olmak için gerekli olabilir.
        // Şimdilik başlangıçta yüklendiğini varsayalım.
        // await exchange.loadMarkets(true); // Gerekirse açılabilir.
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
             console.warn("Ön tarama için marketler yüklenemedi.");
             return;
        }

        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) {
             console.warn("Ön tarama ticker'ları alınamadı.");
             return;
        }
        const allTickers = Object.values(tickers);
        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol || !ticker.quoteVolume) continue; // quoteVolume kontrolü eklendi
            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;
            if (market && market.swap && market.active && market.quote === 'USDT' &&
                quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT
            ) {
                newTargetList.push(ticker.symbol);
            }
        }
        globalTargetList = newTargetList;
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${globalTargetList.length} coin hedefe alındı (Hacim > 1M).\x1b[0m`);
    } catch (error) { console.error(`Kritik Ön Tarama Hatası: ${error.message}`); }
}


/**
 * STRATEJİ 1 (15m): V12.2 - Stoch+EMA (TÜM EMA'lar Puanlamada, R/R 0.5)
 */
async function analyzeStochEMACoin(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-STOCHEMA';
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;

        const requiredCandleCount = REQUIRED_CANDLE_BUFFER + 50; // StochRSI için daha fazla gerekebilir
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TIMEFRAME, undefined, requiredCandleCount);
        // Gelen veri gerçekten beklenen uzunlukta mı?
        if (!ohlcv || ohlcv.length < 50) { // Daha güvenli bir alt sınır
             // console.warn(`[${fullSymbol}] ${TIMEFRAME} için yetersiz OHLCV verisi: ${ohlcv ? ohlcv.length : 0}`);
             return null;
        }
        const mtfTrend = await checkMTF_EMA(ccxtSymbol); // 1h EMA verisi

        const closes = ohlcv.map(m => m[4]).filter(v => typeof v === 'number' && !isNaN(v));
        const volumes = ohlcv.map(m => m[5]).filter(v => typeof v === 'number' && !isNaN(v) && v >= 0); // Hacim >= 0 olmalı
        if (closes.length < 50 || volumes.length < 50) return null; // Filtrelemeden sonra kontrol

        const lastClosePrice = closes[closes.length - 1];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) return null;


        // Göstergeleri Hesapla
        const emaArray = calculateEMA(closes, EMA_PERIOD);
        const ema = emaArray ? emaArray[emaArray.length - 1] : null; // 15m 50-EMA
        const bb = calculateBollingerBands(closes, BOLLINGER_PERIOD, BOLLINGER_STDDEV);
        const stochRSI = calculateStochasticRSI(closes, RSI_PERIOD, STOCH_K, STOCH_SMOOTH_K, STOCH_D);
        const vwap = calculateVWAP(ohlcv.slice(-BOLLINGER_PERIOD));

        // <<< DEBUG: StochRSI değerlerini kontrol et >>>
        if (stochRSI && !isManual && !isWatchlist) {
            console.log(`[STOCH DEBUG ${fullSymbol}]: K=${stochRSI.K?.toFixed(2)}, D=${stochRSI.D?.toFixed(2)}, PrevK=${stochRSI.prevK?.toFixed(2)}, PrevD=${stochRSI.prevD?.toFixed(2)}`);
        } else if (!stochRSI && !isManual && !isWatchlist) {
            console.log(`\x1b[33m[STOCH DEBUG ${fullSymbol}]: StochRSI hesaplanamadı (null).\x1b[0m`); // Sarı renkte log
        }
        // <<< DEBUG SONU >>>

        // 1h EMA Trend Verisi
        const isMtfUptrend = mtfTrend ? mtfTrend.isUptrend : false;
        const isMtfDowntrend = mtfTrend ? mtfTrend.isDowntrend : false;
        const mtfStatus = mtfTrend?.trendStatus || 'Bilinmiyor';

        // StochRSI hesaplanamadıysa veya diğer indikatörler null ise devam etme
        if (bb === null || stochRSI === null || ema === null || vwap === null) {
             // if (!stochRSI) console.warn(`[${fullSymbol}] StochRSI null olduğu için analiz durdu.`); // Zaten loglanıyor
             return null;
        }


        const { upperBand, lowerBand, middleBand } = bb; const { K: stochK, D: stochD, prevK, prevD } = stochRSI;
        let signal = 'WAIT'; let reason = ''; let confidence = 50; let isFiltered = false;

        // Hacim Kontrolü (1.0x)
        const lastVolume = volumes[volumes.length - 1]; const avgVolume = calculateSMA(volumes.slice(0, volumes.length - 1), BOLLINGER_PERIOD);
        let volumeStatus = 'Normal';
        const isVolumeStrong = avgVolume && lastVolume >= avgVolume * STOCH_VOLUME_MULTIPLIER;
        if (isVolumeStrong) { volumeStatus = `Yeterli (${(lastVolume / avgVolume).toFixed(1)}x)`; }
        else if (avgVolume) { volumeStatus = `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`; }

        // Sinyal Tetikleyicileri
        const stochBullishCross = prevK <= prevD && stochK > stochD;
        const stochBearishCross = prevK >= prevD && stochK < stochD;
        const stochOversold = stochK < 30; const stochOverbought = stochK > 70;
        const is15mUptrend = lastClosePrice > ema; // 15m 50-EMA (Artık puanlama için)
        const is15mDowntrend = lastClosePrice < ema; // 15m 50-EMA (Artık puanlama için)
        const isVwapUptrend = lastClosePrice > vwap; const isVwapDowntrend = lastClosePrice < vwap;
        const touchedLowerBB = lastClosePrice <= lowerBand; const touchedUpperBB = lastClosePrice >= upperBand;
        let stochTriggerType = 'Yan'; let bbTriggerType = 'Bant İçi';

        // <<< DEBUG: Kesişimleri kontrol et >>>
        if (stochBullishCross && !isManual && !isWatchlist) {
            console.log(`\x1b[34m[STOCH DEBUG ${fullSymbol}]: Bullish Cross Detected (K=${stochK.toFixed(2)}, D=${stochD.toFixed(2)})\x1b[0m`);
        }
        if (stochBearishCross && !isManual && !isWatchlist) {
            console.log(`\x1b[34m[STOCH DEBUG ${fullSymbol}]: Bearish Cross Detected (K=${stochK.toFixed(2)}, D=${stochD.toFixed(2)})\x1b[0m`);
        }
        // <<< DEBUG SONU >>>


        // <<< DÜZENLEME (V12.2): Sinyal Mantığı 15m EMA trendinden bağımsız hale getirildi.
        if (stochBullishCross && stochOversold && touchedLowerBB) {
            signal = 'LONG'; stochTriggerType = 'Aşırı Satımdan Kesişim'; bbTriggerType = 'Alt BB Teması';
        }
        else if (stochBullishCross && stochK < 50) {
            signal = 'LONG'; stochTriggerType = 'Orta Kesişim (50 Altı)';
        }
        else if (stochBearishCross && stochOverbought && touchedUpperBB) {
            signal = 'SHORT'; stochTriggerType = 'Aşırı Alımdan Kesişim'; bbTriggerType = 'Üst BB Teması';
        }
        else if (stochBearishCross && stochK > 50) {
            signal = 'SHORT'; stochTriggerType = 'Orta Kesişim (50 Üstü)';
        }


        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT') {
            // TP/SL belirlenirken bantların geçerli olduğundan emin ol
            if (typeof upperBand !== 'number' || typeof lowerBand !== 'number' || isNaN(upperBand) || isNaN(lowerBand) || upperBand <= lowerBand) return null; // Geçersiz BB
            if (signal === 'LONG') { takeProfit = upperBand; stopLoss = lowerBand; }
            else if (signal === 'SHORT') { takeProfit = lowerBand; stopLoss = upperBand; }

             // Risk ve Reward hesaplamadan önce TP/SL'in fiyattan farklı olduğundan emin ol
             if (takeProfit === lastClosePrice || stopLoss === lastClosePrice) return null; // Anlamsız R/R

            const risk = Math.abs(lastClosePrice - stopLoss);
            const reward = Math.abs(takeProfit - lastClosePrice);
            rrRatio = risk > 0 ? reward / risk : 0; // Risk 0 ise R/R 0
        }

        // --- FİLTRELEME (ESNEK) ---
        if (signal !== 'WAIT') {

            // 1. R/R FİLTRESİ (MUTLAK)
            if (rrRatio < MIN_RR_RATIO) { // 0.5'ten düşükse reddet
                isFiltered = true; reason = `FİLTRELENDİ: R/R Oranı (${rrRatio.toFixed(2)}) çok düşük (Min: ${MIN_RR_RATIO}).`; signal = 'WAIT'; confidence = 55;
                if (!isWatchlist) { console.log(`\x1b[31m[STOCH RED]: ${fullSymbol} R/R filtresine takıldı. R/R: ${rrRatio.toFixed(2)} (Min: ${MIN_RR_RATIO})\x1b[0m`); }
            }

            // 2. BB GENİŞLİĞİ KONTROLÜ (MUTLAK)
            if (!isFiltered) {
                 // Middle band 0 veya negatif olamaz
                 if(typeof middleBand !== 'number' || isNaN(middleBand) || middleBand <= 0) return null;
                const bbWidthPercent = ((upperBand - lowerBand) / middleBand) * 100;
                if (isNaN(bbWidthPercent) || bbWidthPercent < 0.05 || bbWidthPercent > 5.0) { // NaN kontrolü eklendi
                     isFiltered = true; reason = `FİLTRELENDİ: BB Genişliği (%${isNaN(bbWidthPercent)? 'Hesaplanamadı':bbWidthPercent.toFixed(2)}) uygun değil.`; signal = 'WAIT'; confidence = 55;
                 }
            }

            // 3. 15m-EMA, 1h-EMA, VWAP ve HACİM PUANLAMASI
            if (!isFiltered) {
                let vwapStatusText = 'VWAP Uyumlu';
                let mtfTeyitText = '1h Uyumlu';
                let trend15mText = '15m Uyumlu'; // <<< DÜZENLEME (V12.2): Eklendi
                confidence = 70; // Temel puan

                // <<< DÜZENLEME (V12.2): 15m EMA Puanlaması (Eskiden giriş şartıydı)
                if (!((signal === 'LONG' && is15mUptrend) || (signal === 'SHORT' && is15mDowntrend))) {
                    trend15mText = `15m EMA Ters`;
                    confidence -= 10;
                }

                // VWAP Puanlaması
                if (!((signal === 'LONG' && isVwapUptrend) || (signal === 'SHORT' && isVwapDowntrend))) {
                    vwapStatusText = `VWAP Ters`;
                    confidence -= 10;
                }

                // MTF (1h) Puanlaması
                if (mtfTrend && !((signal === 'LONG' && isMtfUptrend) || (signal === 'SHORT' && isMtfDowntrend))) {
                    mtfTeyitText = `1h Ters (${mtfStatus})`;
                    confidence -= 10;
                }

                // Hacim Puanlaması
                if (!isVolumeStrong) { reason += ` [Hacim Düşük: ${volumeStatus}]`; confidence -= 10; } // Düşük hacim ciddi ceza
                else { reason += ` [Hacim Teyitli]`; confidence += 10; } // Güçlü hacim bonusu

                // Sinyal Onaylandı
                confidence += (rrRatio * 2); // R/R bonusu
                confidence = Math.min(Math.max(confidence, 0), 95); // 0-95 arası

                // <<< DÜZENLEME (V12.2): Reason (Sebep) metni güncellendi
                reason = `ONAYLANDI (R/R: ${rrRatio.toFixed(2)}). | 15m: ${trend15mText} | 1h: ${mtfTeyitText} | VWAP: ${vwapStatusText}`;
                if(!isWatchlist) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }
            }
        }

        // Fibonacci Öngörüsü
        const forecastLevel = signal !== 'WAIT' ? calculateFibonacciExtension(ohlcv, 50, signal) : null;
        let finalSignal = signal; let finalReason = reason;
        if (isManual || isWatchlist) { if (isFiltered) { finalSignal = 'REDDEDİLDİ'; } }

        // Final Sinyal Çıktısı
        const vwapStatusTextOutput = vwap !== null ? (lastClosePrice > vwap ? 'VWAP Üzerinde' : (lastClosePrice < vwap ? 'VWAP Altında' : 'VWAP Çevresinde')) : 'Bilinmiyor';
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-STOCHEMA',
            ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: finalSignal, confidence: confidence.toFixed(0),
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION),
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
            RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(),
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---',
            reason: finalReason,
            volume: typeof lastVolume === 'number' ? lastVolume.toFixed(2) : '---', // lastVolume kontrolü
            volumeStatus: volumeStatus, isFiltered: isFiltered, vwapStatus: vwapStatusTextOutput
        };

        if (isManual || isWatchlist) return resultData;
        if (signal !== 'WAIT' && !isFiltered) {
            console.log(`\x1b[32m>>> V12.2 STOCH+EMA SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            return resultData;
        } else { return null; }
    } catch (error) { console.error(`[Stoch+EMA Analiz Hatası (${ccxtSymbol})]: ${error.message}`); return null; }
}


/**
 * STRATEJİ 2 (2h): Kırılım Stratejisi (Hacim Puanlamalı)
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
        if(!lastCandle || previousCandles.length === 0) return null; // Ekstra kontrol

        const lastClosePrice = lastCandle[4];
        const lastVolume = lastCandle[5];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastVolume !== 'number' || isNaN(lastVolume) || lastVolume < 0) return null;

        let highestHigh = 0; let lowestLow = Infinity; let volumeSum = 0;
        let validVolumeCount = 0; // Ortalama hacim için geçerli mum sayısı
        for (const candle of previousCandles) {
             // Mum verisi [timestamp, open, high, low, close, volume]
             if(candle.length < 6) continue;
             const high = candle[2]; const low = candle[3]; const volume = candle[5];
             if (typeof high !== 'number' || isNaN(high) || typeof low !== 'number' || isNaN(low) ) continue; // High/Low kontrolü

            if (high > highestHigh) highestHigh = high;
            if (low < lowestLow) lowestLow = low;
            if(typeof volume === 'number' && !isNaN(volume) && volume >= 0) {
                 volumeSum += volume;
                 validVolumeCount++;
            }
         }
        // Eğer hiç geçerli mum bulunamadıysa veya high/low hatalıysa
        if (highestHigh === 0 || lowestLow === Infinity || validVolumeCount === 0 || highestHigh <= lowestLow) return null;

        const avgVolume = volumeSum / validVolumeCount;
        if(isNaN(avgVolume) || avgVolume <= 0) return null;

        const overallTrend = marketCondition.overallTrend;

        let signal = 'WAIT'; let reason = ''; let confidence = 75; // Temel güven puanı
        let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + BREAKOUT_BUFFER_PERCENT / 100); const breakoutBufferLow = lowestLow * (1 - BREAKOUT_BUFFER_PERCENT / 100);
        const isVolumeConfirmed = lastVolume >= avgVolume * BREAKOUT_VOLUME_MULTIPLIER; // 1.2x (Yüksek Hacim sınırı)
        const isBalinaConfirmed = lastVolume >= avgVolume * 2.0; // Balina bonusu için 2.0x
        const volumeStatusText = isBalinaConfirmed ? `BALİNA TEYİTLİ (${(lastVolume / avgVolume).toFixed(1)}x)` : (isVolumeConfirmed ? `Yüksek (${(lastVolume / avgVolume).toFixed(1)}x)` : `Düşük (${(lastVolume / avgVolume).toFixed(1)}x)`);

        if (lastClosePrice > breakoutBufferHigh) { signal = 'LONG'; reason = `2h Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`; }
        else if (lastClosePrice < breakoutBufferLow) { signal = 'SHORT'; reason = `2h Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`; }

        if (signal !== 'WAIT') {
            // 1. Piyasa Filtresi (Hala Aktif)
            if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Düşüş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }
            else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: Genel Piyasa Trendi Yükseliş Sinyalini Engelledi.`; signal = 'WAIT'; confidence = 60; }

            // <<< DÜZENLEME (V12.2): Hacim filtresi kaldırıldı, puanlamaya dönüştü.
            if (!isFiltered) {
                if (isBalinaConfirmed) { // 2.0x üzerinde ise Balina Teyidi
                    reason += ` - BALİNA TEYİTLİ (${(lastVolume / avgVolume).toFixed(1)}x)`;
                    confidence = 98;
                } else if (isVolumeConfirmed) { // 1.2x ile 2.0x arasında ise
                    reason += ` - Hacim Teyitli (${(lastVolume / avgVolume).toFixed(1)}x)`;
                    confidence = 90; // Normal yüksek güven
                } else { // Hacim 1.2x altında ise (Eskiden filtrelenirdi)
                    reason += ` - DÜŞÜK HACİM (${(lastVolume / avgVolume).toFixed(1)}x)`;
                    confidence -= 15; // Düşük hacim için ceza puanı (Hala sinyal gelir)
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
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION),
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---',
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---',
            RR: rrRatio.toFixed(2), timestamp: Date.now(), time: new Date().toLocaleTimeString(),
            forecast: forecastLevel ? forecastLevel.toFixed(PRICE_PRECISION) : '---',
            reason: reason,
            volume: lastVolume.toFixed(2), // lastVolume zaten number kontrolünden geçti
            volumeStatus: volumeStatusFinal, isFiltered: isFiltered
        };
        if (signal !== 'WAIT' && !isFiltered) { console.log(`\x1b[36m>>> V12.2 2h KIRILIM SİNYALİ: ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`); return resultData; }
        else { return null; }
    } catch (error) {
        console.error(`[Breakout Analiz Hatası (${ccxtSymbol})]: ${error.message}`); // Hata loglaması eklendi
        return null;
    }
}


// --- YARDIMCI FONKSİYONLAR VE SERVER BAŞLANGICI ---

async function runWatchlistScan() {
    // <<< DEBUG: İzleme listesi taramasının çalıştığını görmek için log >>>
    // console.log(`--- İZLEME LİSTESİ TARANIYOR (${new Date().toLocaleTimeString()}) ---`);
    // <<< DEBUG SONU >>>
    if (Object.keys(globalWatchlist).length === 0) return; let updatedWatchlist = {};
    for (const [symbol, item] of Object.entries(globalWatchlist)) {
        try {
             // İzleme listesindeki her coin için CCXT sembolünün geçerli olduğundan emin ol
             if (!item || !item.ccxtSymbol) {
                 console.warn(`İzleme listesindeki ${symbol} için ccxtSymbol eksik.`);
                 updatedWatchlist[symbol] = item; // Öğeyi koru ama güncelleme
                 continue;
             }
            const analysisResult = await analyzeStochEMACoin(item.ccxtSymbol, false, true); // Stoch+EMA çağrısı
            if (analysisResult) {
                updatedWatchlist[symbol] = {
                    ...item, ...analysisResult,
                    statusClass: analysisResult.signal === 'LONG' ? 'bg-long' : (analysisResult.signal === 'SHORT' ? 'bg-short' : (analysisResult.isFiltered ? 'status-reddet' : 'bg-wait'))
                };
            } else {
                 // Analiz null dönerse, mevcut durumu koru ama belki bir 'hata' durumu ekle?
                updatedWatchlist[symbol] = {...item, signal: 'HATA/YOK', reason:'Analiz başarısız', statusClass:'bg-wait'}; // Eski item yerine bunu koyalım
            }
        } catch (e) {
             console.error(`İzleme listesi tarama hatası (${symbol}): ${e.message}`);
             updatedWatchlist[symbol] = {...item, signal: 'HATA', reason:`Tarama Hatası: ${e.message}`, statusClass:'bg-wait'}; // Hata durumunu belirt
         }
    }
     // Sadece gerçekten değişiklik varsa emit yapalım mı? Şimdilik her zaman yapalım.
     if(Object.keys(updatedWatchlist).length > 0) {
         globalWatchlist = updatedWatchlist;
         io.emit('watchlist_update', globalWatchlist);
         // console.log("İzleme listesi güncellendi ve gönderildi."); // Debug için
     }
}


async function runScan() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    global.APP_STATE.scanStatus = { message: `15m Stoch+EMA Tarama Sürüyor... (${scanTimeStr})`, isScanning: true }; io.emit('scan_status', global.APP_STATE.scanStatus);

    try {
        if (globalTargetList.length === 0) {
            console.log("15m tarama için hedef liste boş.");
            return;
        };
        const allSwapSymbols = [...globalTargetList]; // Kopyasını alalım

        console.log(`\n--- 15m STOCH+EMA TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
             if (!ccxtSymbol) continue; // Geçersiz sembolleri atla
            try {
                const analysisResult = await analyzeStochEMACoin(ccxtSymbol, false, false); // Stoch+EMA çağrısı
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) {
                     // Aynı sinyal zaten listede var mı kontrolü eklenebilir
                    global.APP_STATE.signals.unshift(analysisResult);
                     io.emit('yeni_sinyal', analysisResult);
                 }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
            } catch (loopError) { console.error(`[15m Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); }
        }
    } catch (error) { console.error("Kritik 15m Tarama Hatası:", error.message); }
    finally {
        // Eski sinyalleri temizle (Cooldown süresi dolanları)
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => {
             // Sinyal objesinde timestamp olmalı
             return s.timestamp && s.timestamp > temizelemeZamani;
             /* // Cooldown'a göre temizleme daha karmaşık, şimdilik zamana göre yapalım
             let cooldownKey = s.symbol + (s.id?.endsWith('-BRK') ? '-BREAKOUT' : '-STOCHEMA');
             const cooldownEntry = signalCooldowns[cooldownKey];
             // Hem sinyal zamanı hem de cooldown zamanı geçerli olmalı
             return s.timestamp > temizelemeZamani && cooldownEntry && cooldownEntry.timestamp > temizelemeZamani;
             */
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
            console.log("2h tarama için hedef liste boş.");
            return;
        }
        const allSwapSymbols = [...globalTargetList]; // Kopyasını alalım
        console.log(`\n--- 2h (Hacim Puanlamalı) KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        for (const ccxtSymbol of allSwapSymbols) {
             if (!ccxtSymbol) continue; // Geçersiz sembolleri atla
            try {
                const analysisResult = await analyzeBreakoutCoin(ccxtSymbol);
                if (analysisResult && analysisResult.signal !== 'WAIT' && !analysisResult.isFiltered) {
                    global.APP_STATE.signals.unshift(analysisResult);
                    io.emit('yeni_sinyal', analysisResult);
                }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); // Daha kısa bekleme?
            } catch (loopError) { console.error(`[2h Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); }
        }
    } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); }
    finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}

app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'app.html');
    res.sendFile(filePath, { headers: { 'Content-Type': 'text/html' } }, (err) => {
        if (err) {
            console.error(`app.html gönderme hatası: ${err.message}. Lütfen dosyanın varlığını ve '${__dirname}' yolunun doğruluğunu kontrol edin.`);
            res.status(500).send("Sunucu Hatası: Ana sayfa yüklenemedi. Dosya yolu hatası olabilir.");
        }
    });
});
io.on('connection', (socket) => {
     console.log('Bir istemci bağlandı:', socket.id);
     socket.emit('initial_state', global.APP_STATE);
     socket.emit('watchlist_update', globalWatchlist);
     socket.on('disconnect', () => {
         console.log('İstemci bağlantısı kesildi:', socket.id);
     });
 });

app.post('/api/remove-watchlist', (req, res) => {
    const symbol = req.body.symbol;
    if (typeof symbol !== 'string' || !symbol) { // Gelen veriyi kontrol et
        return res.status(400).json({ error: 'Geçersiz sembol formatı.'});
    }
    if (globalWatchlist[symbol]) {
        delete globalWatchlist[symbol];
        io.emit('watchlist_update', globalWatchlist); // Güncel listeyi gönder
        console.log(`${symbol} izleme listesinden kaldırıldı.`);
        res.json({ success: true, message: `${symbol} izleme listesinden kaldırıldı.` });
    }
    else { res.status(404).json({ error: 'Sembol izleme listesinde bulunamadı.' }); }
});

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol; if (!userSymbolInput || typeof userSymbolInput !== 'string') return res.status(400).json({ error: 'Geçersiz sembol formatı.' });

    // Sembolü temizlerken daha dikkatli olalım
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace('/USDT', '').replace(':USDT', '').replace('USDT', '').replace('PERP', '').trim();
    const fullSymbol = cleanBaseSymbol + 'USDT'; // Arayüzde gösterilecek sembol

    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
             console.log("Manuel analiz için marketler yükleniyor...");
             await exchange.loadMarkets(true);
             if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
                  return res.status(503).json({ error: 'Borsa marketleri yüklenemedi, lütfen tekrar deneyin.' });
             }
        }

        // CCXT market listesinde tam eşleşme ara (örn: BTC/USDT:USDT)
        const foundMarket = Object.values(exchange.markets).find(m =>
             m.active && m.swap && m.quote === 'USDT' && m.base === cleanBaseSymbol
         );


        if (foundMarket && foundMarket.symbol) { // foundMarket.symbol var mı?
            const targetCcxtSymbol = foundMarket.symbol; // CCXT'nin kullandığı sembol (örn: BTC/USDT:USDT)
             console.log(`Manuel analiz isteği: ${userSymbolInput} -> ${targetCcxtSymbol}`);
            const result = await analyzeStochEMACoin(targetCcxtSymbol, true, true); // isManual=true, isWatchlist=true

             if (result) { // Sinyal olsun ya da olmasın, listeye ekle
                 console.log(`${fullSymbol} izleme listesine ekleniyor/güncelleniyor.`);
                 globalWatchlist[fullSymbol] = { // Anahtar olarak cleanSymbol+USDT kullan
                     ccxtSymbol: targetCcxtSymbol, // Analiz için CCXT sembolü
                     ...result, // Analiz sonucunu ekle (sinyal, reason vb içerir)
                     // statusClass zaten result içinde olmalı, ama yoksa varsayılan ekleyelim
                     statusClass: result.statusClass || (result.signal === 'LONG' ? 'bg-long' : (result.signal === 'SHORT' ? 'bg-short' : (result.isFiltered ? 'status-reddet' : 'bg-wait')))
                 };
                 io.emit('watchlist_update', globalWatchlist); // Tüm istemcilere güncel listeyi gönder
                 res.json(result); // Analiz sonucunu API yanıtı olarak döndür
             } else {
                 // Analiz null döndüyse, yine de listeye ekleyip durumu belirtelim
                  console.log(`${fullSymbol} izleme listesine eklendi (analiz sonucu null).`);
                  globalWatchlist[fullSymbol] = {
                      ccxtSymbol: targetCcxtSymbol,
                      symbol: fullSymbol,
                      signal: 'HATA/YOK',
                      reason: 'İlk analiz başarısız oldu veya veri yetersiz.',
                      statusClass: 'bg-wait',
                      timestamp: Date.now(),
                      time: new Date().toLocaleTimeString()
                  };
                  io.emit('watchlist_update', globalWatchlist);
                  // Kullanıcıya analiz sonucunun neden null olduğunu belirten bir mesaj döndürelim
                  res.json({ symbol: fullSymbol, signal: 'HATA/YOK', reason: 'Analiz başarısız oldu veya veri yetersiz.' });
             }

        } else { res.status(404).json({ error: `'${cleanBaseSymbol}' için Bitget'te aktif USDT Perpetual Swap marketi bulunamadı.` }); }
    } catch(err) { console.error("Manuel analiz API hatası:", err); res.status(500).json({ error: `Sunucu hatası: ${err.message}` }); }
});


server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V12.2 - Gevşetilmiş Sürüm) http://localhost:${PORT}`);
    console.log(`OTOMATİK TARAMA BAŞLIYOR...`);
    try {
         console.log("Borsa marketleri yükleniyor...");
        await exchange.loadMarkets(true);
         console.log("Marketler yüklendi. Ön tarama başlatılıyor...");
        await runPreScan();
    } catch (loadError) { console.error("Başlangıçta market/ön-tarama yüklenemedi! Hata:", loadError.message); }

    // İlk taramaları hemen başlat
    runScan(); runBreakoutScan();

    // Periyodik görevleri ayarla
    setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
    setInterval(runPreScan, PRESCAN_INTERVAL);
    setInterval(async () => {
         // Eğer önceki tarama hala sürüyorsa yenisini başlatma
         if (!global.APP_STATE.scanStatus.isScanning) {
             await runScan();
         } else {
             // console.log("Önceki 15m tarama hala sürüyor, bu döngü atlanıyor.");
         }
     }, SCAN_INTERVAL);
    setInterval(runBreakoutScan, BREAKOUT_SCAN_INTERVAL);
});

console.log("--- server.js dosyası okunması tamamlandı ---");