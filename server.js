// server.js (ANA PROJE - V14.12 UYUMLU - BITGET VERİ KAYNAĞI - SON HALİ)
// SÜRÜM: V14.12_Server (Borsa ccxt.bitget, rateLimit 200ms, 'market.swap' filtresi)
// (29.10.2025)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- server.js dosyası okunmaya başlandı (V14.12 Bitget - Son Hali) ---");

const app = express();
// ✅ Render için PORT ortam değişkenini veya yerel için 3000'i kullan
const PORT = process.env.PORT || 3000; 

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// === Strateji Ayarları ===
const PRESCAN_INTERVAL = 5 * 60 * 1000; // 5 dakika
const PRESCAN_MIN_24H_VOLUME_USDT = 500000; // Minimum 500k USDT hacim
const WATCHLIST_SCAN_INTERVAL = 30 * 1000; // 30 saniye
const API_DELAY_MS = 100; // Genel API istekleri arası bekleme süresi (ms)

// Zaman Dilimleri
const TIMEFRAME_1H = '1h';
const TIMEFRAME_2H = '2h';
const TIMEFRAME_4H = '4h';

// Kırılım Stratejileri (Genel Ayarlar)
const BREAKOUT_BASE_ATR_PERIOD = 14;
const BREAKOUT_BASE_RSI_PERIOD = 14;
const BREAKOUT_BASE_BB_PERIOD = 20;
const BREAKOUT_BASE_BB_STDDEV = 2;
const BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK = 5.0; // Fibonacci TP hesaplanamazsa % fallback

// Kırılım Ayarları - 1 Saat (BRK1H)
const BRK1H_LOOKBACK_PERIOD = 50; // Son 50 muma bak
const BRK1H_BUFFER_PERCENT = 0.1; // Kırılım için % tampon bölge
const BRK1H_VOLUME_MULTIPLIER = 1.2; // Hacim ortalamanın en az 1.2 katı olmalı
const BRK1H_SL_ATR_MULTIPLIER = 2.0; // Stop Loss = Giriş - (ATR * 2.0)
const BRK1H_RSI_LONG_THRESHOLD = 55; // LONG için RSI >= 55
const BRK1H_RSI_SHORT_THRESHOLD = 45; // SHORT için RSI <= 45
const BREAKOUT_SCAN_INTERVAL_1H = 15 * 60 * 1000; // 15 dakikada bir tara

// Kırılım Ayarları - 2 Saat (BRK2H)
const BRK2H_LOOKBACK_PERIOD = 50;
const BRK2H_BUFFER_PERCENT = 0.1;
const BRK2H_VOLUME_MULTIPLIER = 1.2;
const BRK2H_SL_ATR_MULTIPLIER = 2.0;
const BRK2H_RSI_LONG_THRESHOLD = 55;
const BRK2H_RSI_SHORT_THRESHOLD = 45;
const BREAKOUT_SCAN_INTERVAL_2H = 30 * 60 * 1000; // 30 dakikada bir tara

// Kırılım Ayarları - 4 Saat (BRK4H)
const BRK4H_LOOKBACK_PERIOD = 40; // Daha geniş zaman dilimi, daha az mum
const BRK4H_BUFFER_PERCENT = 0.15;
const BRK4H_VOLUME_MULTIPLIER = 1.1;
const BRK4H_SL_ATR_MULTIPLIER = 2.2;
const BRK4H_RSI_LONG_THRESHOLD = 55;
const BRK4H_RSI_SHORT_THRESHOLD = 45;
const BREAKOUT_SCAN_INTERVAL_4H = 60 * 60 * 1000; // Saatte bir tara

// 1H Hacim Momentumu (MOMENTUM1H)
const MOMENTUM_1H_TIMEFRAME = TIMEFRAME_1H;
const MOMENTUM_1H_LOOKBACK = 24; // Son 24 saate bak
const MOMENTUM_1H_SCAN_INTERVAL = 10 * 60 * 1000; // 10 dakikada bir tara
const MOMENTUM_1H_API_DELAY_MS = 250; // Momentum taraması daha yavaş olabilir
const MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER = 1.8; // Hacim ortalamanın en az 1.8 katı olmalı
const MOMENTUM_1H_PRICE_SPIKE_PERCENT = 0.8; // Fiyat en az %0.8 değişmeli
const MOMENTUM_1H_COOLDOWN_MS = 30 * 60 * 1000; // Aynı coin için 30dk sinyal verme

// Genel Ayarlar
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // Aynı strateji+coin için 30dk sinyal verme
const MARKET_FILTER_TIMEFRAME = TIMEFRAME_4H; // Ana trend için 4s'lik EMA'ya bak
const MARKET_FILTER_EMA_PERIOD = 200; // 4s EMA 200 periyodu

// Global Değişkenler
let signalCooldowns = {}; // Sinyal bekleme sürelerini tutar { 'BTCUSDT-BRK1H': { timestamp: ... } }
let globalWatchlist = {}; // İzleme listesini tutar { 'BTCUSDT': { signalData... } }
let globalTargetList = []; // Ön taramadan geçen coin listesi ['BTC/USDT:USDT', ...]
let momentumCooldowns = {}; // Momentum bekleme süreleri

// Uygulama Durumu (Arayüze gönderilecek)
global.APP_STATE = { 
    signals: [], // Aktif sinyaller listesi
    scanStatus: { message: 'Sunucu başlatılıyor...', isScanning: false } 
};

// Borsa Bağlantısı (Bitget)
const exchange = new ccxt.bitget({
    'enableRateLimit': true,
    'rateLimit': 200, // Bitget için 200ms genellikle yeterli
});

// --- İNDİKATOR HESAPLAMA FONKSİYONLARI ---
function calculateSMA(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const sum = relevantData.reduce((a, b) => (a || 0) + (b || 0), 0); const sma = sum / period; return isNaN(sma) ? null : sma; }
function calculateEMA(closes, period) { if (!Array.isArray(closes) || closes.length < period) return null; const k = 2 / (period + 1); let emaArray = []; let firstSma = calculateSMA(closes.slice(0, period), period); if (firstSma === null) return null; emaArray.push(firstSma); for (let i = period; i < closes.length; i++) { if (typeof closes[i] !== 'number' || isNaN(closes[i])) return null; const prevEma = emaArray[emaArray.length - 1]; let ema = (closes[i] * k) + (prevEma * (1 - k)); if (isNaN(ema)) return null; emaArray.push(ema); } return emaArray.length > 0 ? emaArray[emaArray.length - 1] : null; }
function calculateStdDev(data, period) { if (!data || data.length < period) return null; const relevantData = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v)); if (relevantData.length < period) return null; const mean = calculateSMA(relevantData, period); if (mean === null) return null; const squareDiffs = relevantData.map(value => Math.pow((value || 0) - mean, 2)); const sumSquareDiffs = squareDiffs.reduce((a, b) => a + b, 0); const variance = sumSquareDiffs / period; if (isNaN(variance) || variance < 0) return null; return Math.sqrt(variance); }
function calculateBollingerBands(closes, period, stdDevMultiplier) { if (!closes || closes.length < period) return null; let middleBandSmaArray = []; for (let i = period - 1; i < closes.length; i++) { const slice = closes.slice(i - period + 1, i + 1); const sma = calculateSMA(slice, period); if (sma === null) return null; middleBandSmaArray.push(sma); } if (middleBandSmaArray.length === 0) return null; const middleBand = middleBandSmaArray[middleBandSmaArray.length - 1]; const stdDev = calculateStdDev(closes.slice(-period), period); if (middleBand === null || stdDev === null || stdDev < 0) return null; const upperBand = middleBand + (stdDev * stdDevMultiplier); const lowerBand = middleBand - (stdDev * stdDevMultiplier); if (isNaN(upperBand) || isNaN(lowerBand) || isNaN(middleBand)) return null; return { upperBand, middleBand, lowerBand }; }
function calculateRSI(closes, rsiPeriod = 14) { if (!Array.isArray(closes) || closes.length < rsiPeriod + 1) return null; let gains = []; let losses = []; for (let i = 1; i < closes.length; i++) { const currentClose = closes[i]; const prevClose = closes[i - 1]; if (typeof currentClose !== 'number' || isNaN(currentClose) || typeof prevClose !== 'number' || isNaN(prevClose)) return null; const diff = currentClose - prevClose; gains.push(diff >= 0 ? diff : 0); losses.push(diff < 0 ? Math.abs(diff) : 0); } if (gains.length < rsiPeriod) return null; let avgGain = gains.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; let avgLoss = losses.slice(0, rsiPeriod).reduce((a, b) => a + b, 0) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; for (let i = rsiPeriod; i < gains.length; i++) { avgGain = (avgGain * (rsiPeriod - 1) + gains[i]) / rsiPeriod; avgLoss = (avgLoss * (rsiPeriod - 1) + losses[i]) / rsiPeriod; if (isNaN(avgGain) || isNaN(avgLoss)) return null; } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; const rsi = 100 - (100 / (1 + rs)); return isNaN(rsi) ? null : rsi; }
async function checkMarketCondition(ccxtSymbol) { const requiredCandleCount = MARKET_FILTER_EMA_PERIOD + 50; try { const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, MARKET_FILTER_TIMEFRAME, undefined, requiredCandleCount); if (!ohlcv || ohlcv.length < MARKET_FILTER_EMA_PERIOD) { return { overallTrend: 'UNKNOWN' }; } const closes = ohlcv.map(m => m[4]); const lastEma200 = calculateEMA(closes, MARKET_FILTER_EMA_PERIOD); if (lastEma200 === null) { return { overallTrend: 'UNKNOWN' }; } const lastClosePrice = closes[closes.length - 1]; if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastEma200 !== 'number' || isNaN(lastEma200)) { return { overallTrend: 'UNKNOWN' }; } if (lastClosePrice > lastEma200) return { overallTrend: 'UPTREND' }; else if (lastClosePrice < lastEma200) return { overallTrend: 'DOWNTREND' }; else return { overallTrend: 'SIDEWAYS' }; } catch (e) { console.error(`[checkMarketCondition Hatası (${ccxtSymbol})]: ${e.message}`); return { overallTrend: 'UNKNOWN' }; } }
function calculateFibonacciExtension(ohlcv, period, signal) { if (!ohlcv || ohlcv.length < period) return null; const relevantData = ohlcv.slice(-period); const validLows = relevantData.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v)); const validHighs = relevantData.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v)); if (validLows.length === 0 || validHighs.length === 0) return null; const lowestLow = Math.min(...validLows); const highestHigh = Math.max(...validHighs); if (highestHigh <= lowestLow) return null; const range = highestHigh - lowestLow; let extensionLevel = null; if (signal === 'LONG') { extensionLevel = highestHigh + (range * 0.618); } else if (signal === 'SHORT') { extensionLevel = lowestLow - (range * 0.618); } return isNaN(extensionLevel) ? null : extensionLevel; }
function calculateATR(ohlcv, period = 14) { if (!ohlcv || ohlcv.length < period + 1) return null; let trueRanges = []; for (let i = ohlcv.length - period -1; i < ohlcv.length -1; i++) { const currentCandle = ohlcv[i+1]; const prevCandle = ohlcv[i]; if (!currentCandle || currentCandle.length < 5 || !prevCandle || prevCandle.length < 5) continue; const high = currentCandle[2]; const low = currentCandle[3]; const prevClose = prevCandle[4]; if (typeof high !== 'number' || typeof low !== 'number' || typeof prevClose !== 'number') continue; const tr1 = high - low; const tr2 = Math.abs(high - prevClose); const tr3 = Math.abs(low - prevClose); const trueRange = Math.max(tr1, tr2, tr3); if (!isNaN(trueRange)) { trueRanges.push(trueRange); } } if (trueRanges.length < period) return null; const atr = calculateSMA(trueRanges, period); return isNaN(atr) ? null : atr; }
// --- İNDİKATOR FONKSİYONLARI SONU ---


/** AŞAMA 1 - HIZLI ÖN TARAYICI (BITGET SWAP) */
async function runPreScan() {
    const scanTime = new Date().toLocaleTimeString(); 
    console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLANGICI (${scanTime}) ---`); 
    let newTargetList = [];
    try {
        // Marketleri yükle (eğer yüklü değilse)
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            console.warn("Ön tarama için marketler yüklenemedi, yeniden yükleniyor...");
            await exchange.loadMarkets(true);
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
                console.error("\x1b[31m[runPreScan HATA]: Marketler yeniden denemeye rağmen YÜKLENEMEDİ!\x1b[0m");
                globalTargetList = []; return;
            }
             console.log("[runPreScan] Marketler başarıyla yeniden yüklendi.");
        }

        // Bitget SWAP ticker'larını çek
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' }); 
        
        if (!tickers) {
            console.warn("\x1b[33m[runPreScan UYARI]: Ön tarama ticker'ları alınamadı (API yanıtı boş olabilir).\x1b[0m");
            globalTargetList = []; return;
        }
        
        const allTickers = Object.values(tickers);
        let passedFilterCount = 0;
        
        // Ticker'ları filtrele
        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
            
            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;
            
            // Filtre: Aktif, SWAP, USDT tabanlı ve minimum hacimli
            if (market && market.active && market.swap && market.quote === 'USDT' && quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT) {
                newTargetList.push(ticker.symbol); // ccxt sembolünü (örn: 'BTC/USDT:USDT') listeye ekle
                passedFilterCount++;
            }
        }
        
        globalTargetList = newTargetList;
        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${passedFilterCount} coin ${PRESCAN_MIN_24H_VOLUME_USDT} USDT hacim filtresini geçti. ${globalTargetList.length} coin hedefe alındı.\x1b[0m`);
    
    } catch (error) {
        console.error(`\x1b[31m[runPreScan KRİTİK HATA]: ${error.message}\x1b[0m`);
        globalTargetList = []; // Hata durumunda hedef listeyi boşalt
    }
}

/** 🧠 TAKTİKSEL ANALİZ MOTORU 🧠 */
function generateTacticalAnalysis(data) {
    const { signal, anaTrend, rsi, hacimMultiplier, bbWidth, timeframe } = data;
    let analysis = ""; let confidenceLevel = 40; 
    
    // 1. Ana Trend Uyumu
    if (signal === 'LONG' && anaTrend === 'UPTREND') { analysis += "✅ **Trend Dostu Sinyal:** Fiyat zaten ana yükseliş trendinde (4s EMA200 üstü). "; confidenceLevel += 20; }
    else if (signal === 'SHORT' && anaTrend === 'DOWNTREND') { analysis += "✅ **Trend Dostu Sinyal:** Fiyat zaten ana düşüş trendinde (4s EMA200 altı). "; confidenceLevel += 20; }
    else if ((signal === 'LONG' && anaTrend === 'DOWNTREND') || (signal === 'SHORT' && anaTrend === 'UPTREND')) { analysis += `⚠️ **Yüksek Risk (Ters Trend):** Akıntıya karşı yüzüyoruz. Ana yön (${anaTrend}) ters. `; confidenceLevel -= 30; }
    else { analysis += "ℹ️ **Yatay Piyasa:** Ana trend desteği yok. "; } // 'UNKNOWN' or 'SIDEWAYS'

    // 2. Hacim Teyidi
    const hacimText = (hacimMultiplier || 0).toFixed(1);
    if (hacimMultiplier > 3.5) { analysis += `🐋 **'Balina Teyitli':** Hacim patlaması (ortalamanın ${hacimText} katı). Güven A+. `; confidenceLevel += 25; }
    else if (hacimMultiplier > 1.8) { analysis += `👍 **Hacim Teyitli:** Hacim (ortalamanın ${hacimText} katı) destekliyor. `; confidenceLevel += 15; }
    else { analysis += `👎 **Zayıf Hacim:** Hacim (ortalamanın ${hacimText} katı) zayıf. Fakeout riski var. `; confidenceLevel -= 20; }

    // 3. RSI Aşırı Alım/Satım Kontrolü
    const rsiText = (rsi || 0).toFixed(0);
    if (signal === 'LONG' && rsi > 78) { analysis += `🥵 **Aşırı Şişmiş:** Fiyat 'balon gibi şişmiş' (RSI ${rsiText}). Geri çekilme beklenebilir. `; confidenceLevel -= 15; }
    else if (signal === 'SHORT' && rsi < 22) { analysis += `🥶 **Aşırı Satılmış:** Fiyat 'dipte' (RSI ${rsiText}). Tepki alımı yaklaşıyor olabilir. `; confidenceLevel -= 15; }
    else { analysis += `💪 **Momentum İyi:** Fiyatın gücü (RSI ${rsiText}) sağlıklı. `; confidenceLevel += 5; }
    
    // 4. Bollinger Bandı Genişliği (Sıkışma)
    const bbWidthText = (bbWidth || 0).toFixed(1);
    if (bbWidth < 2.5) { analysis += `⏳ **Sıkışma Patlaması:** Fiyat dar alanda sıkışmış (BB Genişliği: %${bbWidthText}). Sert hareket gelebilir.`; confidenceLevel += 5; }

    // Final Güven Puanı (10-99 arası)
    const finalConfidence = Math.min(Math.max(confidenceLevel, 10), 99);
    return { text: analysis, confidence: finalConfidence.toFixed(0) };
}

/** STRATEJİ 1, 2, 3 (1h, 2h, 4h): Genel Kırılım Stratejisi */
async function analyzeBreakoutStrategy(ccxtSymbol, config, isManual = false, isWatchlist = false) {
    const { timeframe, lookbackPeriod, bufferPercent, volumeMultiplier, atrPeriod, slAtrMultiplier, rsiPeriod, rsiLongThreshold, rsiShortThreshold, strategyIdSuffix, strategyDisplayName } = config;
    let resultData = null; const PRICE_PRECISION = 4; // Fiyat hassasiyeti
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        const cooldownKey = `${fullSymbol}-${strategyIdSuffix}`;
        
        // Cooldown kontrolü (manuel veya watchlist değilse)
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) {
            return null; // Hala bekleme süresinde
        }
        
        // Gerekli mum sayısı hesaplama
        const minRequiredCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1, BREAKOUT_BASE_BB_PERIOD + 1);
        const candlesToFetch = minRequiredCandles + 10; // Güvenlik marjı

        // OHLCV verisini çek
        let ohlcv;
        try {
            const fetchLimit = Number.isInteger(candlesToFetch) && candlesToFetch > 0 ? candlesToFetch : 150; 
            ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, fetchLimit);
        } catch (fetchError) {
             if (fetchError instanceof ccxt.ExchangeError && (fetchError.message.includes('40017') || fetchError.message.includes('Invalid limit'))) { 
                 console.error(`\x1b[31m[${strategyDisplayName} fetchOHLCV Parametre Hatası (${ccxtSymbol}, ${timeframe})]: Hata: ${fetchError.message}\x1b[0m`); 
             } else { 
                 console.error(`\x1b[31m[${strategyDisplayName} fetchOHLCV Hatası (${ccxtSymbol}, ${timeframe})]: ${fetchError.message}\x1b[0m`); 
             }
            return null; // Veri çekilemezse analiz yapma
        }

        // Yeterli veri var mı kontrol et
        if (!ohlcv || ohlcv.length < minRequiredCandles) { return null; }

        // Ana piyasa trendini kontrol et (4s EMA200)
        const marketCondition = await checkMarketCondition(ccxtSymbol);
        const overallTrend = marketCondition?.overallTrend || 'UNKNOWN'; 

        // Son ve önceki mumları al
        const lastCandle = ohlcv[ohlcv.length - 1];
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1); // Son mumu hariç tut
        if(!lastCandle || lookbackCandles.length < lookbackPeriod) return null;
        
        // Gerekli verileri çıkar
        const lastClosePrice = lastCandle[4]; const lastVolume = lastCandle[5];
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice) || typeof lastVolume !== 'number' || isNaN(lastVolume) || lastVolume < 0) return null;
        
        // Lookback periyodundaki en yüksek/düşük ve ortalama hacmi hesapla
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
        
        // İndikatörleri hesapla
        const allCloses = ohlcv.map(c => c[4]); 
        const atr = calculateATR(ohlcv, atrPeriod); 
        const rsi = calculateRSI(allCloses, rsiPeriod); 
        const bb = calculateBollingerBands(allCloses, BREAKOUT_BASE_BB_PERIOD, BREAKOUT_BASE_BB_STDDEV);
        if (atr === null || rsi === null || bb === null) { return null; } // İndikatör hesaplanamazsa çık
        const bbWidth = (bb.middleBand > 0) ? ((bb.upperBand - bb.lowerBand) / bb.middleBand) * 100 : 0;
        
        // Kırılım sinyalini kontrol et
        let signal = 'WAIT'; let reason = ''; let isFiltered = false;
        const breakoutBufferHigh = highestHigh * (1 + bufferPercent / 100); 
        const breakoutBufferLow = lowestLow * (1 - bufferPercent / 100);

        if (lastClosePrice > breakoutBufferHigh) {
            signal = 'LONG'; reason = `${strategyDisplayName} Direnç Kırılımı (${highestHigh.toFixed(PRICE_PRECISION)})`;
            if(!isManual && !isWatchlist) console.log(`\x1b[33m!!! KIRILIM POTANSİYELİ (${strategyDisplayName}, ${ccxtSymbol}): LONG\x1b[0m`);
        } else if (lastClosePrice < breakoutBufferLow) {
            signal = 'SHORT'; reason = `${strategyDisplayName} Destek Kırılımı (${lowestLow.toFixed(PRICE_PRECISION)})`;
            if(!isManual && !isWatchlist) console.log(`\x1b[33m!!! KIRILIM POTANSİYELİ (${strategyDisplayName}, ${ccxtSymbol}): SHORT\x1b[0m`);
        }

        // Sinyal varsa filtreleri uygula
        let tacticalAnalysis = "Koşullar sağlanmadı."; let confidence = "0";
        if (signal !== 'WAIT') {
            // 1. Ana Trend Filtresi
            if (overallTrend === 'UPTREND' && signal === 'SHORT') { isFiltered = true; reason = `FİLTRELENDİ: 4h Trend UP.`; signal = 'WAIT'; if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: Trend`);}
            else if (overallTrend === 'DOWNTREND' && signal === 'LONG') { isFiltered = true; reason = `FİLTRELENDİ: 4h Trend DOWN.`; signal = 'WAIT'; if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: Trend`);}
            
            // 2. RSI Filtresi
            if (!isFiltered) { 
                if (signal === 'LONG' && rsi < rsiLongThreshold) { isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) Low.`; signal = 'WAIT'; if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: RSI`);} 
                else if (signal === 'SHORT' && rsi > rsiShortThreshold) { isFiltered = true; reason = `FİLTRELENDİ: RSI (${rsi.toFixed(1)}) High.`; signal = 'WAIT'; if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: RSI`);} 
            }
            
            // 3. Hacim Filtresi
            const hacimMultiplier = (avgVolume > 0 ? lastVolume / avgVolume : 0);
            if (!isFiltered) { 
                if (hacimMultiplier < volumeMultiplier) { isFiltered = true; reason = `FİLTRELENDİ: Hacim (${hacimMultiplier.toFixed(1)}x) Low.`; signal = 'WAIT'; if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: Hacim`);} 
            }
            
            // Filtrelerden geçtiyse taktiksel analizi yap
            if (signal !== 'WAIT' && !isFiltered) {
                const analysisData = { signal, anaTrend: overallTrend, rsi, hacimMultiplier, bbWidth, timeframe };
                const tacticalResult = generateTacticalAnalysis(analysisData);
                tacticalAnalysis = tacticalResult.text;
                confidence = tacticalResult.confidence;
            }
        }
        
        // TP/SL ve R/R hesapla (sadece filtrelenmemiş sinyaller için)
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        if (signal !== 'WAIT' && !isFiltered) {
            const dynamicTP = calculateFibonacciExtension(ohlcv, lookbackPeriod, signal);
            if (signal === 'LONG') { 
                takeProfit = dynamicTP ? dynamicTP : lastClosePrice * (1 + BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
                stopLoss = lastClosePrice - (atr * slAtrMultiplier); 
            }
            else if (signal === 'SHORT') { 
                takeProfit = dynamicTP ? dynamicTP : lastClosePrice * (1 - BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
                stopLoss = lastClosePrice + (atr * slAtrMultiplier); 
            }
            
            // R/R kontrolü
            if (takeProfit && stopLoss && takeProfit !== lastClosePrice && stopLoss !== lastClosePrice && ( (signal === 'LONG' && takeProfit > stopLoss) || (signal === 'SHORT' && takeProfit < stopLoss) ) ) { 
                const risk = Math.abs(lastClosePrice - stopLoss); 
                const reward = Math.abs(takeProfit - lastClosePrice); 
                rrRatio = risk > 0 ? reward / risk : 0; 
                if(rrRatio < 0.5) { // R/R 0.5'ten küçükse filtrele
                    signal = 'WAIT'; tacticalAnalysis = "FİLTRELENDİ (Düşük R/R)"; confidence = "0"; isFiltered = true; // isFiltered'ı true yap
                    if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: R/R`);
                } else { 
                    reason += ` | R/R: ${rrRatio.toFixed(2)}`; 
                    if (!isManual && !isWatchlist) { // Cooldown'u sadece otomatik taramada ayarla
                        signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; 
                    } 
                } 
            }
            else { // TP/SL hesaplanamazsa veya geçersizse filtrele
                signal = 'WAIT'; confidence = "0"; tacticalAnalysis = "FİLTRELENDİ: TP/SL Calc"; isFiltered = true; // isFiltered'ı true yap
                if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: TP/SL Calc`);
            }
        }
        
        // Sonuç objesini oluştur
        const volumeStatusText = `Ort: ${avgVolume.toFixed(0)}, Son: ${lastVolume.toFixed(0)}`;
        resultData = { 
            id: `${fullSymbol}-${signal}-${Date.now()}-${strategyIdSuffix}`, 
            ccxtSymbol, 
            symbol: fullSymbol, 
            signal, 
            confidence, 
            entryPrice: lastClosePrice.toFixed(PRICE_PRECISION), 
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', 
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio > 0 ? rrRatio.toFixed(2) : '---', // RR 0 ise --- göster
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString(), 
            reason, // Ham reason metni
            tacticalAnalysis, // Ayrıntılı analiz metni
            volume: lastVolume.toFixed(2), 
            volumeStatus: volumeStatusText, 
            isFiltered: isFiltered, // Filtrelenip filtrelenmediği bilgisi
            strategyType: strategyIdSuffix // 'BRK1H', 'BRK2H', 'BRK4H'
        };
        
        // Sadece geçerli, filtrelenmemiş sinyalleri veya manuel/watchlist analizlerini döndür
        if (signal !== 'WAIT' && !isFiltered) { 
            if(!isManual && !isWatchlist) {
                console.log(`\x1b[36m>>> V14.12 KIRILIM SİNYALİ (${strategyDisplayName}): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            }
            return resultData;
        } else {
            // Eğer manuel analiz veya watchlist taraması ise, filtrelenmiş olsa bile sonucu döndür (arayüzde göstermek için)
            return (isWatchlist || isManual) ? resultData : null; 
        }
    } catch (error) { 
        console.error(`\x1b[31m[${strategyDisplayName} ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack); 
        return null; // Hata durumunda null döndür
    }
}


/** STRATEJİ 4 (1h): 1H HACİM MOMENTUMU */
async function analyzeVolumeMomentum1H(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-MOMENTUM1H';
        
        // Cooldown kontrolü
        if (!isManual && !isWatchlist && momentumCooldowns[cooldownKey] && momentumCooldowns[cooldownKey].timestamp > Date.now() - MOMENTUM_1H_COOLDOWN_MS) { 
            return null; 
        }
        
        // Ana trendi kontrol et
        const marketCondition = await checkMarketCondition(ccxtSymbol);
        const overallTrend = marketCondition?.overallTrend || 'UNKNOWN';
        
        // Gerekli mum sayısı
        const minRequiredCandles = MOMENTUM_1H_LOOKBACK + 5; 
        let ohlcv1h;
        try {
            const fetchLimit = Number.isInteger(minRequiredCandles) && minRequiredCandles > 0 ? minRequiredCandles : 50; 
            ohlcv1h = await exchange.fetchOHLCV(ccxtSymbol, MOMENTUM_1H_TIMEFRAME, undefined, fetchLimit);
        } catch (fetchError) {
             if (fetchError instanceof ccxt.ExchangeError && (fetchError.message.includes('40017') || fetchError.message.includes('Invalid limit'))) { console.error(`\x1b[31m[Momentum 1H fetchOHLCV Parametre Hatası (${ccxtSymbol})]: Hata: ${fetchError.message}\x1b[0m`); }
             else { console.error(`\x1b[31m[Momentum 1H fetchOHLCV Hatası (${ccxtSymbol})]: ${fetchError.message}\x1b[0m`); }
            return null;
        }

        // Yeterli veri kontrolü
        if (!ohlcv1h || ohlcv1h.length < MOMENTUM_1H_LOOKBACK + 2) return null; 
        
        // Son ve önceki mum verileri
        const lastCandle = ohlcv1h[ohlcv1h.length - 1]; 
        const prevCandle = ohlcv1h[ohlcv1h.length - 2];
        if (!lastCandle || !prevCandle || typeof lastCandle[4] !== 'number' || typeof prevCandle[4] !== 'number' || typeof lastCandle[5] !== 'number' || lastCandle[5] < 0) return null;
        const lastClose1h = lastCandle[4]; const lastVolume1h = lastCandle[5]; const prevClose1h = prevCandle[4];
        
        // Ortalama hacim hesapla
        const volumeLookbackData = ohlcv1h.slice(-(MOMENTUM_1H_LOOKBACK + 1), -1).map(c => c[5]).filter(v => typeof v === 'number' && v >= 0);
        if (volumeLookbackData.length < MOMENTUM_1H_LOOKBACK / 2) return null; // Yeterli hacim verisi yoksa çık
        const avgVolume = volumeLookbackData.reduce((a, b) => a + b, 0) / volumeLookbackData.length;
        if (isNaN(avgVolume) || avgVolume <= 0) return null;
        
        // Fiyat değişimi ve hacim katını hesapla
        const priceChangePercent = prevClose1h === 0 ? 0 : ((lastClose1h - prevClose1h) / prevClose1h) * 100;
        const hacimMultiplier = lastVolume1h / avgVolume;
        
        // Sinyal koşullarını kontrol et
        let signal = 'WAIT'; let tacticalAnalysis = "Koşullar sağlanmadı."; let confidence = "0"; let isFiltered = false;
        const isPumpCondition = hacimMultiplier >= MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent >= MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        const isDumpCondition = hacimMultiplier >= MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER && priceChangePercent <= -MOMENTUM_1H_PRICE_SPIKE_PERCENT;
        let baseConfidence = 65; 
        
        if (isPumpCondition && overallTrend !== 'DOWNTREND') { // Ana trend DOWNTREND ise PUMP sinyalini filtrele
            signal = 'PUMP';
            if (overallTrend === 'UPTREND') baseConfidence += 15;
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0);
            tacticalAnalysis = `📈 **1H Hacim Patlaması (PUMP):** Son 1 saatte ortalamanın **${hacimMultiplier.toFixed(1)} katı** alım hacmi...`;
        }
        else if (isDumpCondition && overallTrend !== 'UPTREND') { // Ana trend UPTREND ise DUMP sinyalini filtrele
            signal = 'DUMP';
            if (overallTrend === 'DOWNTREND') baseConfidence += 15;
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_1H_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0);
            tacticalAnalysis = `📉 **1H Hacim Patlaması (DUMP):** Son 1 saatte ortalamanın **${hacimMultiplier.toFixed(1)} katı** satım hacmi...`;
        } else {
            // Koşul sağlanmadı veya trend filtresine takıldı
             isFiltered = true; // Filtrelendi olarak işaretle
             if(!isManual) console.log(`[Momentum 1H Filtre (${ccxtSymbol})]: Koşul/Trend`); 
        }

        // Sonuç objesini oluştur
        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-MOMENTUM1H', 
            ccxtSymbol: ccxtSymbol, 
            symbol: fullSymbol, 
            signal: signal, 
            confidence: confidence,
            entryPrice: lastClose1h.toFixed(PRICE_PRECISION),
            TP: '---', SL: '---', RR: 'N/A', // Momentum için TP/SL/RR yok
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString(),
            reason: `Hacim: ${hacimMultiplier.toFixed(1)}x, Fiyat Değ: ${priceChangePercent.toFixed(2)}%`, // Kısa açıklama
            tacticalAnalysis: tacticalAnalysis, // Uzun analiz metni
            isFiltered: isFiltered, // Filtrelendi mi?
            strategyType: 'MOMENTUM1H'
        };
        
        // Sinyal geçerliyse (filtrelenmemişse) veya manuel/watchlist ise döndür
        if (signal !== 'WAIT' && !isFiltered) {
            if (!isManual && !isWatchlist) { // Cooldown'u ayarla
                momentumCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
                const colorCode = signal === 'PUMP' ? '\x1b[32m' : '\x1b[31m';
                console.log(`${colorCode}>>> V14.12 MOMENTUM SİNYALİ (1H): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`);
            }
            return resultData;
        } else {
            // Manuel veya watchlist ise, filtrelenmiş olsa bile döndür
            return (isWatchlist || isManual) ? resultData : null; 
        }
    } catch (error) { 
        console.error(`\x1b[31m[Momentum 1H ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack); 
        return null; 
    }
}


// --- AKILLI MANUEL ANALİZ VE TARAMA FONKSİYONLARI ---
async function runAllAnalysesForSymbol(ccxtSymbol, isManual = false, isWatchlist = false) {
    if(isWatchlist) console.log(`[Watchlist Analiz Başladı] -> ${ccxtSymbol}`);
    let activeSignals = [];
    // Strateji konfigürasyonları (öncekiyle aynı)
    const brk1hConfig = { timeframe: TIMEFRAME_1H, lookbackPeriod: BRK1H_LOOKBACK_PERIOD, /* ... */ strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' };
    const brk2hConfig = { timeframe: TIMEFRAME_2H, lookbackPeriod: BRK2H_LOOKBACK_PERIOD, /* ... */ strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' };
    const brk4hConfig = { timeframe: TIMEFRAME_4H, lookbackPeriod: BRK4H_LOOKBACK_PERIOD, /* ... */ strategyIdSuffix: 'BRK4H', strategyDisplayName: '4h' };

    try {
        // Tüm analizleri paralel olarak çalıştır
        const analyses = await Promise.all([
            analyzeBreakoutStrategy(ccxtSymbol, brk1hConfig, isManual, isWatchlist),
            analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, isManual, isWatchlist),
            analyzeBreakoutStrategy(ccxtSymbol, brk4hConfig, isManual, isWatchlist),
            analyzeVolumeMomentum1H(ccxtSymbol, isManual, isWatchlist)
        ]);
        
        // Sadece null olmayan sonuçları al (aktif sinyal, WAIT veya filtrelenmiş durumu gösterir)
        activeSignals = analyses.filter(signal => signal !== null);
        
    } catch (error) {
        console.error(`[runAllAnalysesForSymbol Hata (${ccxtSymbol})]: ${error.message}`);
    }
    
    if(isWatchlist) console.log(`[Watchlist Analiz Bitti] -> ${ccxtSymbol}. Bulunan sinyal/durum sayısı: ${activeSignals.length}`);
    return activeSignals; // Tüm (filtrelenmiş dahil) sonuçları döndür
}

function prioritizeAnalysis(activeSignals) {
    if (!activeSignals || activeSignals.length === 0) return null; // Hiç sonuç yoksa null döndür

    // 1. Geçerli (WAIT olmayan, filtrelenmemiş) sinyalleri ayır
    const validBreakoutSignals = activeSignals.filter(s => s.signal !== 'WAIT' && !s.isFiltered && s.strategyType !== 'MOMENTUM1H');
    const validMomentumSignal = activeSignals.find(s => s.signal !== 'WAIT' && !s.isFiltered && s.strategyType === 'MOMENTUM1H');
    
    // 2. Eğer geçerli kırılım sinyali varsa:
    if (validBreakoutSignals.length > 0) {
        // Kırılım sinyallerini önceliğe göre sırala (BRK4H > BRK2H > BRK1H)
        const strategyPriority = ['BRK4H', 'BRK2H', 'BRK1H'];
        validBreakoutSignals.sort((a, b) => { 
            const priorityA = strategyPriority.indexOf(a.strategyType); 
            const priorityB = strategyPriority.indexOf(b.strategyType); 
            return priorityA - priorityB; 
        });
        
        const bestSignal = validBreakoutSignals[0]; // En yüksek öncelikli sinyal
        
        // Çatışma Kontrolü: Farklı zaman dilimlerinde ters sinyal var mı?
        if (validBreakoutSignals.length > 1) {
            const secondSignal = validBreakoutSignals[1];
            if ((bestSignal.signal === 'LONG' && secondSignal.signal === 'SHORT') || (bestSignal.signal === 'SHORT' && secondSignal.signal === 'LONG')) {
                console.warn(`[ÇATIŞMA TESPİT EDİLDİ] (${bestSignal.symbol}): ${bestSignal.strategyType} ${bestSignal.signal} vs ${secondSignal.strategyType} ${secondSignal.signal}. WAIT olarak ayarlandı.`);
                let waitSignal = { ...bestSignal }; // Klonla
                waitSignal.signal = 'WAIT'; waitSignal.confidence = '0';
                waitSignal.tacticalAnalysis = `ÇATIŞMA: ${bestSignal.strategyType} (${bestSignal.signal}) ile ${secondSignal.strategyType} (${secondSignal.signal}) çakışıyor.`;
                waitSignal.isFiltered = true; // Filtrelendi olarak işaretle
                return waitSignal; // Çatışma durumunda WAIT döndür
            }
        }
        return bestSignal; // Çatışma yoksa en iyi kırılım sinyalini döndür
    }
    
    // 3. Geçerli kırılım yoksa, geçerli momentum sinyali varsa onu döndür
    if (validMomentumSignal) {
        return validMomentumSignal;
    }

    // 4. Hiç geçerli sinyal yoksa, filtrelenmiş veya WAIT durumlarından en önceliklisini (varsa) döndür
    // (Örn: 4H filtrelenmiş > 2H filtrelenmiş > 1H filtrelenmiş > 4H WAIT vb.)
    const allResultsSorted = [...activeSignals]; // Kopyala
    const priorityMap = { 'BRK4H': 1, 'BRK2H': 2, 'BRK1H': 3, 'MOMENTUM1H': 4 };
    allResultsSorted.sort((a, b) => {
        const priorityA = priorityMap[a.strategyType] || 5;
        const priorityB = priorityMap[b.strategyType] || 5;
        if (priorityA !== priorityB) return priorityA - priorityB;
        // Aynı stratejideyse, timestamp'e göre sırala (isteğe bağlı)
        return (b.timestamp || 0) - (a.timestamp || 0); 
    });
    
    return allResultsSorted.length > 0 ? allResultsSorted[0] : null; // En öncelikli durumu (WAIT veya filtrelenmiş) döndür
}

async function runWatchlistScan() {
    const scanTimeStr = new Date().toLocaleTimeString();
    const watchlistSymbols = Object.keys(globalWatchlist);
    if (watchlistSymbols.length === 0) { return; }

    console.log(`\n--- IZLEME LISTESI TARAMASI BAŞLADI (${scanTimeStr}) ---`);
    let anythingChanged = false;

    for (const fullSymbol of watchlistSymbols) {
        const ccxtSymbol = globalWatchlist[fullSymbol]?.ccxtSymbol;
        if (!ccxtSymbol) continue;
        
        try {
            // Coin için tüm analizleri (filtrelenmişler dahil) al
            const allAnalyses = await runAllAnalysesForSymbol(ccxtSymbol, false, true); 
            // Gösterilecek en öncelikli sinyali/durumu seç
            const prioritizedResult = prioritizeAnalysis(allAnalyses); 
            
            if (prioritizedResult) {
                // Mevcut durumla karşılaştırıp değişiklik var mı kontrol et
                if (!globalWatchlist[fullSymbol] || 
                    globalWatchlist[fullSymbol].signal !== prioritizedResult.signal || 
                    globalWatchlist[fullSymbol].confidence !== prioritizedResult.confidence ||
                    globalWatchlist[fullSymbol].strategyType !== prioritizedResult.strategyType || // Strateji değişmiş olabilir
                    globalWatchlist[fullSymbol].isFiltered !== prioritizedResult.isFiltered) { // Filtre durumu değişmiş olabilir
                    anythingChanged = true;
                }
                // Watchlist'i en son öncelikli durumla güncelle
                globalWatchlist[fullSymbol] = prioritizedResult; 
            } else {
                // Eğer hiçbir analiz sonucu gelmediyse (API hatası vb.), durumu koru veya HATA olarak işaretle
                if (globalWatchlist[fullSymbol].signal !== 'HATA/YOK') {
                    // Belki geçici HATA durumu eklenmeli? Şimdilik mevcut durumu koru.
                    // globalWatchlist[fullSymbol].signal = 'HATA/YOK'; anythingChanged = true; 
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, API_DELAY_MS * 2)); // Watchlist taraması daha yavaş
        } catch (error) {
            console.error(`[runWatchlistScan Hatası (${ccxtSymbol})]: ${error.message}`);
        }
    }
    
    // Sadece değişiklik varsa arayüze güncelleme gönder
    if (anythingChanged) {
        console.log(`[Watchlist] Değişiklikler algılandı, güncelleme gönderiliyor.`);
        io.emit('watchlist_update', globalWatchlist);
    }
    console.log(`--- IZLEME LISTESI TARAMASI TAMAMLANDI (${scanTimeStr}) ---`);
}


// --- ANA TARAMA DÖNGÜLERİ ---
async function runBreakoutScan1h() { 
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try { 
        if (globalTargetList.length === 0) { console.log("1h Kırılım tarama için hedef liste boş."); return; } 
        const allSwapSymbols = [...globalTargetList]; 
        console.log(`\n--- 1h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        const brk1hConfig = { timeframe: TIMEFRAME_1H, /* ... */ strategyIdSuffix: 'BRK1H', strategyDisplayName: '1h' }; 
        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                // Sadece geçerli (filtrelenmemiş) sinyalleri al
                const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk1hConfig, false, false); 
                if (analysisResult) { // analyzeBreakoutStrategy artık sadece geçerli sinyali döndürüyor
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); 
            } catch (loopError) { console.error(`[1h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik 1h Kırılım Tarama Hatası:", error.message); } 
    finally { 
        console.log(`--- 1h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`);
        // Sinyal temizleme (Cooldown süresi dolanları kaldır)
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        const momentumTemizlemeZamani = Date.now() - (MOMENTUM_1H_COOLDOWN_MS); 
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => { 
            if (!s || !s.timestamp) return false; 
            if (s.strategyType === 'MOMENTUM1H') { return s.timestamp > momentumTemizlemeZamani; } 
            else { return s.timestamp > temizelemeZamani; } 
        });
        // Tarama durumu güncellemesi
        global.APP_STATE.scanStatus = { message: `Tarama Tamamlandı (${scanTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; 
        io.emit('scan_status', global.APP_STATE.scanStatus);
    } 
}
async function runBreakoutScan2h() { /* ... runBreakoutScan1h ile benzer mantık ... */ }
async function runBreakoutScan4h() { /* ... runBreakoutScan1h ile benzer mantık ... */ }
async function runVolumeMomentum1HScan() { /* ... runBreakoutScan1h ile benzer mantık (analyzeVolumeMomentum1H kullanarak) ... */ }

// --- Express Rotaları ve Socket.IO Bağlantısı ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'app.html')); });

io.on('connection', (socket) => { 
    console.log('Bir istemci bağlandı:', socket.id); 
    console.log(`Initial state gönderiliyor (${socket.id}), signals toplam sayı:`, global.APP_STATE.signals.length);
    // Bağlantıda mevcut tüm aktif sinyalleri ve watchlist'i gönder
    socket.emit('initial_state', { signals: global.APP_STATE.signals || [] }); 
    socket.emit('watchlist_update', globalWatchlist); 
    socket.on('disconnect', () => { console.log('İstemci bağlantısı kesildi:', socket.id); }); 
});

app.post('/api/remove-watchlist', (req, res) => {
    const { symbol } = req.body;
    if (!symbol) { return res.status(400).json({ error: 'Symbol gerekli' }); }
    const fullSymbol = symbol.toUpperCase().replace(/USDT$/, '') + 'USDT'; 
    if (globalWatchlist[fullSymbol]) {
        delete globalWatchlist[fullSymbol];
        console.log(`[Watchlist] Kaldırıldı: ${fullSymbol}`);
        io.emit('watchlist_update', globalWatchlist); // Herkese güncelleme gönder
        res.status(200).json({ message: `${fullSymbol} kaldırıldı` });
    } else {
        res.status(404).json({ error: 'Sembol watchlistte bulunamadı' });
    }
});

app.post('/api/analyze-coin', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) { return res.status(400).json({ error: 'Symbol gerekli' }); }
    let ccxtSymbol, fullSymbol;
    try {
        const cleanSymbol = symbol.toUpperCase().replace(/USDT$/, '').replace(/PERP$/, ''); 
        fullSymbol = cleanSymbol + 'USDT';
        // Bitget 'swap' marketini bul
        const market = Object.values(exchange.markets).find(m => m.base === cleanSymbol && m.quote === 'USDT' && m.swap);
        if (!market) {
            if (Object.keys(exchange.markets).length === 0) await exchange.loadMarkets();
            const fallbackMarket = Object.values(exchange.markets).find(m => m.base === cleanSymbol && m.quote === 'USDT' && m.swap);
            if(!fallbackMarket) {
                console.error(`[/api/analyze-coin] Market bulunamadı: ${symbol}`);
                return res.status(404).json({ error: 'Geçerli bir (USDT-M) SWAP marketi bulunamadı (Örn: BTC)' });
            }
            ccxtSymbol = fallbackMarket.symbol;
        } else {
             ccxtSymbol = market.symbol;
        }
    } catch (e) { return res.status(500).json({ error: 'Market sembolü işlenirken hata oluştu' }); }

    try {
        // Coin için tüm analizleri (filtrelenmişler dahil) al
        const allAnalyses = await runAllAnalysesForSymbol(ccxtSymbol, true, true); 
        // Gösterilecek en öncelikli sinyali/durumu seç
        const prioritizedResult = prioritizeAnalysis(allAnalyses); 
        
        if (prioritizedResult) {
            globalWatchlist[fullSymbol] = prioritizedResult; // Watchlist'i güncelle
            console.log(`[Watchlist] Eklendi/Güncellendi: ${fullSymbol}`);
            io.emit('watchlist_update', globalWatchlist); // Arayüze güncelleme gönder
            res.status(200).json(prioritizedResult); // Manuel analiz sonucunu döndür
        } else {
            // Analiz başarısız olduysa HATA durumu oluştur
            const errorData = {
                ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: 'HATA/YOK', confidence: "0",
                entryPrice: '0', TP: '---', SL: '---', RR: 'N/A', 
                timestamp: Date.now(), time: new Date().toLocaleTimeString(),
                reason: 'Analizden geçerli veri alınamadı.', tacticalAnalysis: 'Veri yok veya sembol hatalı.', 
                strategyType: 'MANUAL', isFiltered: true
            };
            globalWatchlist[fullSymbol] = errorData; // Hata durumunu watchlist'e ekle
            io.emit('watchlist_update', globalWatchlist);
            res.status(200).json(errorData); // Hata durumunu döndür
        }
    } catch (error) {
        console.error(`[/api/analyze-coin Hata (${symbol})]: ${error.message}`);
        res.status(500).json({ error: 'Coin analizi sırasında sunucu hatası: ' + error.message });
    }
});


// --- Sunucu Başlatma ve Döngüler ---
server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V14.12 Bitget) BAŞLATILIYOR - Port: ${PORT}`); 
    console.log(`Node.js Sürümü: ${process.version}`);
    console.log("==============================================");
    console.log("[Başlangıç] Borsa (Bitget) marketleri yükleniyor..."); 
    try {
        await exchange.loadMarkets(true);
        console.log("[Başlangıç] Marketler yüklendi. İlk ön tarama başlatılıyor...");
        await runPreScan();
        console.log(`[Başlangıç] İlk ön tarama tamamlandı. Hedef liste boyutu: ${globalTargetList.length}`);
        console.log("[Başlangıç] İlk taramalar başlatılıyor...");
        if (globalTargetList.length > 0) {
            runBreakoutScan1h(); 
            runBreakoutScan2h(); 
            runBreakoutScan4h(); 
            runVolumeMomentum1HScan();
        } else { console.warn("[Başlangıç] Hedef liste boş olduğu için ilk taramalar atlandı."); }
        
        console.log("[Başlangıç] Periyodik tarama döngüleri ayarlanıyor...");
        setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL); 
        setInterval(runPreScan, PRESCAN_INTERVAL);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan1h(); }, BREAKOUT_SCAN_INTERVAL_1H);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan2h(); }, BREAKOUT_SCAN_INTERVAL_2H);
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan4h(); }, BREAKOUT_SCAN_INTERVAL_4H);
        setInterval(async () => { if (globalTargetList.length > 0) await runVolumeMomentum1HScan(); }, MOMENTUM_1H_SCAN_INTERVAL);
        
        // Render için URL kontrolü
        const isRender = process.env.RENDER === 'true'; // Render ortam değişkeni varsa
        const listenAddress = isRender ? 'Render URL üzerinden' : `http://localhost:${PORT}`;
        console.log(`\n✅ SUNUCU BAŞARIYLA BAŞLATILDI ve ${listenAddress} adresinde dinlemede.`);
        console.log("==============================================");
    } catch (loadError) {
        console.error("\x1b[31m[KRİTİK BAŞLANGIÇ HATASI]: Market/ön-tarama yüklenemedi! Sunucu düzgün çalışmayabilir.\x1b[0m");
        console.error(`Hata Detayı: ${loadError.message}`);
        // Render üzerinde başlangıç hatası olursa süreci sonlandırabiliriz
        if (process.env.RENDER === 'true') {
           console.error("Render üzerinde kritik başlangıç hatası, çıkılıyor...");
           process.exit(1); 
        }
    }
});

console.log("--- server.js dosyası okunması tamamlandı ---");

// Eksik Ana Tarama Döngüleri Dolduruldu (runBreakoutScan1h mantığına benzer şekilde)

async function runBreakoutScan2h() { 
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try { 
        if (globalTargetList.length === 0) { console.log("2h Kırılım tarama için hedef liste boş."); return; } 
        const allSwapSymbols = [...globalTargetList]; 
        console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        const brk2hConfig = { timeframe: TIMEFRAME_2H, lookbackPeriod: BRK2H_LOOKBACK_PERIOD, bufferPercent: BRK2H_BUFFER_PERCENT, volumeMultiplier: BRK2H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK2H', strategyDisplayName: '2h' }; 
        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, false, false); 
                if (analysisResult) { 
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2)); 
            } catch (loopError) { console.error(`[2h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); } 
    finally { console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); } 
}

async function runBreakoutScan4h() {
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString();
    try {
        if (globalTargetList.length === 0) { console.log("4h Kırılım tarama için hedef liste boş."); return; }
        const allSwapSymbols = [...globalTargetList];
        console.log(`\n--- 4h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`);
        const brk4hConfig = { timeframe: TIMEFRAME_4H, lookbackPeriod: BRK4H_LOOKBACK_PERIOD, bufferPercent: BRK4H_BUFFER_PERCENT, volumeMultiplier: BRK4H_VOLUME_MULTIPLIER, atrPeriod: BREAKOUT_BASE_ATR_PERIOD, slAtrMultiplier: BRK4H_SL_ATR_MULTIPLIER, rsiPeriod: BREAKOUT_BASE_RSI_PERIOD, rsiLongThreshold: BRK4H_RSI_LONG_THRESHOLD, rsiShortThreshold: BRK4H_RSI_SHORT_THRESHOLD, strategyIdSuffix: 'BRK4H', strategyDisplayName: '4h' };
        for (const ccxtSymbol of allSwapSymbols) {
            if (!ccxtSymbol) continue;
            try {
                const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk4hConfig, false, false);
                if (analysisResult) {
                    global.APP_STATE.signals.unshift(analysisResult);
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS / 2));
            } catch (loopError) { console.error(`[4h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); }
        }
    } catch (error) { console.error("Kritik 4h Kırılım Tarama Hatası:", error.message); }
    finally { console.log(`--- 4h KIRILIM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}

async function runVolumeMomentum1HScan() { 
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try {
        if (globalTargetList.length === 0) { console.log("1H Momentum tarama için hedef liste boş."); return; } 
        const allSwapSymbols = [...globalTargetList]; 
        console.log(`\n--- 1H MOMENTUM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                const analysisResult = await analyzeVolumeMomentum1H(ccxtSymbol, false, false); 
                if (analysisResult) { 
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, MOMENTUM_1H_API_DELAY_MS)); 
            } catch (loopError) { console.error(`[Momentum 1H Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik Momentum 1H Tarama Hatası:", error.message); } 
    finally { console.log(`--- 1H MOMENTUM TARAMA TAMAMLANDI (${scanTimeStr}). ---`); }
}