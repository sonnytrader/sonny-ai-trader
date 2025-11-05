// server.js (ANA PROJE - V16.0 - PROAKTİF TEYİTLİ GİRİŞ)
// SÜRÜM: V16.0_Server (Teyitli Giriş (Pending Orders) Mantığı)
// (05.11.2025)
// Değişiklikler:
// 1. [FIX-18] (PROAKTİF STRATEJİ) 'analyzeBreakoutStrategy' (2H) yeniden yazıldı.
//    Artık "kırıldıktan sonra" filtreleme yapmak yerine, "kırılmadan önce" kurulumu (setup) arar.
//    Filtreler (Trend, RSI, BBW) önceden geçerse, 'BEKLEYEN LONG/SHORT' sinyali ve 'Tetikleme Fiyatı' (direnç/destek) döner.
//    Bu, "filtreye takılıp sinyal kaçırma" sorununu çözer.
// 2. [FIX-19] (PROAKTİF STRATEJİ) 'analyzeDivergenceStrategy' (1H) yeniden yazıldı.
//    Artık uyuşmazlığı bulduğu an değil, uyuşmazlığın "teyit seviyesini" (son tepe/dip) hesaplar.
//    'BEKLEYEN LONG/SHORT' sinyali ve 'Tetikleme Fiyatı' (teyit seviyesi) döner.
// 3. [FIX-15/16] Hız optimizasyonları (İkili Tarama Kilidi, Trend Önbelleği, Top 100 Momentum) korundu.

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const { RSI, ATR, BollingerBands, EMA } = require('technicalindicators');

console.log("--- server.js dosyası okunmaya başlandı (V16.0 - Teyitli Giriş) ---");

const app = express();
const PORT = process.env.PORT || 3000; 

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// === Strateji Ayarları ===
const PRESCAN_INTERVAL = 5 * 60 * 1000; 
const PRESCAN_MIN_24H_VOLUME_USDT = 500000; 
const WATCHLIST_SCAN_INTERVAL = 30 * 1000; 
const API_DELAY_MS = 100; // 100ms Hızlı ve Güvenli

// Zaman Dilimleri
const TIMEFRAME_1H = '1h';
const TIMEFRAME_2H = '2h';
const TIMEFRAME_4H = '4h';

// Trend Önbelleği Ayarları
const TREND_CACHE_TIMEFRAME = TIMEFRAME_4H; 
const TREND_CACHE_EMA_PERIOD = 200; 
const TREND_CACHE_SCAN_INTERVAL = 30 * 60 * 1000; // 30 dakikada bir

// Kırılım Stratejileri (Genel Ayarlar)
const BREAKOUT_BASE_ATR_PERIOD = 14;
const BREAKOUT_BASE_RSI_PERIOD = 14;
const BREAKOUT_BASE_BB_PERIOD = 20;
const BREAKOUT_BASE_BB_STDDEV = 2;
const BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK = 5.0; 
const BREAKOUT_SQUEEZE_THRESHOLD = 4.0; 
// [FIX-18] Fiyatın tetikleme seviyesine ne kadar yakın olması gerektiğini belirler (% olarak)
const BREAKOUT_TRIGGER_PROXIMITY_PERCENT = 1.0; // Fiyat, dirence/desteğe %1 yaklaştığında sinyal üret

// Kırılım Ayarları - 2 Saat (BRK2H) - ANA KIRILIM STRATEJİSİ
const BRK2H_LOOKBACK_PERIOD = 50;
const BRK2H_BUFFER_PERCENT = 0.1; // Bu artık sadece seviyeyi belirlemek için kullanılır
const BRK2H_VOLUME_MULTIPLIER = 1.2; // [FIX-18] Bu filtre artık kullanılmıyor (proaktif olduğu için)
const BRK2H_SL_ATR_MULTIPLIER = 2.0;
const BRK2H_RSI_LONG_THRESHOLD = 50; // [FIX-18] Sinyal için >50 RSI yeterli
const BRK2H_RSI_SHORT_THRESHOLD = 50; // [FIX-18] Sinyal için <50 RSI yeterli
const BREAKOUT_SCAN_INTERVAL_2H = 30 * 60 * 1000; 

// YENİ STRATEJİ: 1H RSI UYUŞMAZLIK (DIVERGENCE)
const DIVERGENCE_TIMEFRAME = TIMEFRAME_1H; 
const DIVERGENCE_RSI_PERIOD = 14; 
const DIVERGENCE_LOOKBACK_PERIOD = 100; 
const DIVERGENCE_PIVOT_LOOKBACK = 5; 
const DIVERGENCE_SCAN_INTERVAL = 20 * 60 * 1000; 
const DIVERGENCE_SL_ATR_MULTIPLIER = 1.5; 
const DIVERGENCE_TP_FIB_LEVEL = 0.618; 

// 1M Momentum Stratejisi (Hızlı Sinyaller)
const MOMENTUM_TIMEFRAME = '1m'; 
const MOMENTUM_LOOKBACK = 120; 
const MOMENTUM_SCAN_INTERVAL = 1 * 60 * 1000; 
const MOMENTUM_VOLUME_SPIKE_MULTIPLIER = 4.0; 
const MOMENTUM_PRICE_SPIKE_PERCENT = 0.3; 
const MOMENTUM_COOLDOWN_MS = 15 * 60 * 1000; 
const TOP_N_MOMENTUM = 100; // 1M taraması sadece en yüksek hacimli 100 coini tarar

// Genel Ayarlar
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; 

// Global Değişkenler
let signalCooldowns = {}; 
let globalWatchlist = {}; 
let globalTargetList = []; 
let momentumCooldowns = {}; 
let isLongScanRunning = false; 
let isMomentumScanRunning = false;
let globalMarketTrends = {}; 

global.APP_STATE = { 
    signals: [], 
    scanStatus: { message: 'Sunucu başlatılıyor...', isScanning: false } 
};

const exchange = new ccxt.bitget({
    'enableRateLimit': true,
    'rateLimit': 200, 
});

// --- İNDİKATOR HESAPLAMA FONKSİYONLARI ---
async function checkMarketCondition(ccxtSymbol) { 
    const requiredCandleCount = TREND_CACHE_EMA_PERIOD + 50; 
    try { 
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, TREND_CACHE_TIMEFRAME, undefined, requiredCandleCount); 
        if (!ohlcv || ohlcv.length < TREND_CACHE_EMA_PERIOD) { 
            return 'UNKNOWN'; 
        } 
        const closes = ohlcv.map(m => m[4]); 
        
        const emaResult = EMA.calculate({ period: TREND_CACHE_EMA_PERIOD, values: closes });
        const lastEma200 = emaResult.length > 0 ? emaResult[emaResult.length - 1] : null;

        if (lastEma200 === null || isNaN(lastEma200)) { 
            return 'UNKNOWN'; 
        } 
        
        const lastClosePrice = closes[closes.length - 1]; 
        if (typeof lastClosePrice !== 'number' || isNaN(lastClosePrice)) { 
            return 'UNKNOWN'; 
        } 
        
        if (lastClosePrice > lastEma200) return 'UPTREND'; 
        else if (lastClosePrice < lastEma200) return 'DOWNTREND'; 
        else return 'SIDEWAYS'; 
    } catch (e) { 
        console.error(`[checkMarketCondition Hatası (${ccxtSymbol})]: ${e.message}`); 
        return 'UNKNOWN'; 
    } 
}

function calculateFibonacciExtension(ohlcv, period, signal) { 
    if (!ohlcv || ohlcv.length < period) return null; 
    const relevantData = ohlcv.slice(-period); 
    const validLows = relevantData.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v)); 
    const validHighs = relevantData.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v)); 
    if (validLows.length === 0 || validHighs.length === 0) return null; 
    const lowestLow = Math.min(...validLows); 
    const highestHigh = Math.max(...validHighs); 
    if (highestHigh <= lowestLow) return null; 
    const range = highestHigh - lowestLow; 
    let extensionLevel = null; 
    if (signal === 'BEKLEYEN LONG') { 
        extensionLevel = highestHigh + (range * 0.618); 
    } else if (signal === 'BEKLEYEN SHORT') { 
        extensionLevel = lowestLow - (range * 0.618); 
    } 
    return isNaN(extensionLevel) ? null : extensionLevel; 
}

function calculateFibRetracement(startPrice, endPrice, level) {
    try {
        const range = Math.abs(endPrice - startPrice);
        if (endPrice > startPrice) { 
            return endPrice - (range * level);
        } else { 
            return endPrice + (range * level);
        }
    } catch (e) {
        return null;
    }
}

function findPivots(data, lookback, isHigh = true) {
    let pivots = [];
    if (!data || data.length < (lookback * 2) + 1) {
        return []; 
    }
    
    // [FIX-19] Teyit seviyesini bulmak için, son pivotu değil, son 2 pivotu arayacağız.
    // lookback*2+1'den başladık ki hem sağını hem solunu kontrol edebilelim
    for (let i = data.length - lookback - 1; i >= lookback; i--) {
        let isPivot = true;
        const currentVal = data[i];

        // Solundaki 'lookback' kadar muma bak
        for (let j = 1; j <= lookback; j++) {
            if (isHigh && data[i - j] > currentVal) { isPivot = false; break; }
            if (!isHigh && data[i - j] < currentVal) { isPivot = false; break; }
        }
        if (!isPivot) continue;

        // Sağındaki 'lookback' kadar muma bak
        for (let j = 1; j <= lookback; j++) {
            if (isHigh && data[i + j] > currentVal) { isPivot = false; break; }
            if (!isHigh && data[i + j] < currentVal) { isPivot = false; break; }
        }

        if (isPivot) {
            pivots.push({ index: i, value: data[i] });
            // [FIX-19] Uyuşmazlık için 2, teyit için 3 pivot gerekli olabilir. 3 tane bulalım.
            if (pivots.length >= 3) {
                break;
            }
        }
    }
    return pivots.reverse(); // [en_yeni, orta, en_eski]
}
// --- İNDİKATOR FONKSİYONLARI SONU ---


/** AŞAMA 1 - HIZLI ÖN TARAYICI (BITGET SWAP) */
async function runPreScan() {
    if (isLongScanRunning) {
        console.log(`\n--- AŞAMA 1: ÖN TARAMA ATLANDI (Başka bir 'Yavaş' tarama çalışıyor) ---`);
        return;
    }
    isLongScanRunning = true;
    const scanTime = new Date().toLocaleTimeString(); 
    console.log(`\n--- AŞAMA 1: ÖN TARAMA BAŞLANGICI (${scanTime}) ---`); 
    let newTargetList = [];
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            console.warn("Ön tarama için marketler yüklenemedi, yeniden yükleniyor...");
            await exchange.loadMarkets(true);
            if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
                console.error("\x1b[31m[runPreScan HATA]: Marketler yeniden denemeye rağmen YÜKLENEMEDİ!\x1b[0m");
                globalTargetList = []; 
                isLongScanRunning = false; 
                return;
            }
             console.log("[runPreScan] Marketler başarıyla yeniden yüklendi.");
        }

        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' }); 
        
        if (!tickers) {
            console.warn("\x1b[33m[runPreScan UYARI]: Ön tarama ticker'ları alınamadı (API yanıtı boş olabilir).\x1b[0m");
            globalTargetList = []; 
            isLongScanRunning = false; 
            return;
        }
        
        const allTickers = Object.values(tickers);
        let passedFilterCount = 0;
        
        for (const ticker of allTickers) {
            if (!ticker || !ticker.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
            
            const market = exchange.markets[ticker.symbol];
            const quoteVolume = ticker.quoteVolume;
            
            if (market && market.active && market.swap && market.quote === 'USDT' && quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT) {
                // [FIX-17] Liste artık { symbol, quoteVolume } objeleri tutuyor
                newTargetList.push({ symbol: ticker.symbol, quoteVolume: quoteVolume }); 
                passedFilterCount++;
            }
        }
        
        // [FIX-17] Listeyi hacme göre sıralı kaydet
        newTargetList.sort((a, b) => b.quoteVolume - a.quoteVolume);
        globalTargetList = newTargetList;

        console.log(`\x1b[35m--- AŞAMA 1: ÖN TARAMA TAMAMLANDI. ${allTickers.length} SWAP coin tarandı. ${passedFilterCount} coin ${PRESCAN_MIN_24H_VOLUME_USDT} USDT hacim filtresini geçti. ${globalTargetList.length} coin hedefe alındı.\x1b[0m`);
    
    } catch (error) {
        console.error(`\x1b[31m[runPreScan KRİTİK HATA]: ${error.message}\x1b[0m`);
        globalTargetList = []; 
    } finally {
        isLongScanRunning = false; 
    }
}

/** 🧠 TAKTİKSEL ANALİZ MOTORU 🧠 - [FIX-18] Artık Kırılım Stratejisi tarafından kullanılmıyor */
// ... (generateTacticalAnalysis fonksiyonu Momentum stratejisi için korundu) ...
function generateTacticalAnalysis(data) {
    // ... (içerik aynı) ...
}

/** [FIX-18] YENİDEN YAZILDI: STRATEJİ 1: (2H) PROAKTİF Kırılım Kurulumu */
async function analyzeBreakoutStrategy(ccxtSymbol, config, isManual = false, isWatchlist = false) {
    const { timeframe, lookbackPeriod, bufferPercent, slAtrMultiplier, rsiLongThreshold, rsiShortThreshold, strategyIdSuffix, strategyDisplayName } = config;
    const atrPeriod = BREAKOUT_BASE_ATR_PERIOD;
    const rsiPeriod = BREAKOUT_BASE_RSI_PERIOD;

    let resultData = null; const PRICE_PRECISION = 4; 
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const cleanSymbol = market.base; const fullSymbol = cleanSymbol + 'USDT';
        
        // Sinyal "Kurulum" sinyali olduğu için, aynı kurulumu tekrar tekrar göndermemek için cooldown'u kontrol et
        const cooldownKey = `${fullSymbol}-${strategyIdSuffix}`;
        if (!isManual && !isWatchlist && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) {
            return null; 
        }
        
        const minRequiredCandles = Math.max(lookbackPeriod + 1, atrPeriod + 1, rsiPeriod + 1, BREAKOUT_BASE_BB_PERIOD + 1);
        const candlesToFetch = minRequiredCandles + 50; 

        let ohlcv;
        try {
            const fetchLimit = Number.isInteger(candlesToFetch) && candlesToFetch > 0 ? candlesToFetch : 200; 
            ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, fetchLimit);
        } catch (fetchError) {
             console.error(`\x1b[31m[${strategyDisplayName} fetchOHLCV Hatası (${ccxtSymbol}, ${timeframe})]: ${fetchError.message}\x1b[0m`); 
            return null; 
        }

        if (!ohlcv || ohlcv.length < minRequiredCandles) { return null; }

        // --- İndikatörleri Hesapla ---
        const allCloses = ohlcv.map(c => c[4]); 
        const allHighs = ohlcv.map(c => c[2]);
        const allLows = ohlcv.map(c => c[3]);
        const lastClosePrice = allCloses[allCloses.length - 1];

        let atr, rsi, bb;
        try {
            const atrInput = { high: allHighs, low: allLows, close: allCloses, period: atrPeriod };
            const atrResult = ATR.calculate(atrInput);
            atr = atrResult.length > 0 ? atrResult[atrResult.length - 1] : null;

            const rsiResult = RSI.calculate({ values: allCloses, period: rsiPeriod });
            rsi = rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : null;
            
            const bbInput = { values: allCloses, period: BREAKOUT_BASE_BB_PERIOD, stdDev: BREAKOUT_BASE_BB_STDDEV };
            const bbResult = BollingerBands.calculate(bbInput);
            bb = bbResult.length > 0 ? bbResult[bbResult.length - 1] : null; 

            if (!atr || !rsi || !bb || !bb.middle || isNaN(atr) || isNaN(rsi) || isNaN(bb.middle)) {
                 console.error(`\x1b[33m[Indikator Hatası (${ccxtSymbol}, ${timeframe})]: ATR, RSI veya BB 'null'/'NaN' döndü.\x1b[0m`);
                 return null; 
            }
        } catch (e) {
            console.error(`\x1b[31m[Indikator Kritik Hata (${ccxtSymbol}, ${timeframe})]: ${e.message}\x1b[0m`);
            return null;
        }

        // --- Direnç/Destek Seviyelerini Bul ---
        const lookbackCandles = ohlcv.slice(-(lookbackPeriod + 1), -1); // Son mumu hariç tut
        if(lookbackCandles.length < lookbackPeriod) return null;

        let highestHigh = 0; let lowestLow = Infinity;
        for (const candle of lookbackCandles) { 
            if(candle.length < 6) continue; 
            const high = candle[2]; const low = candle[3];
            if (typeof high !== 'number' || isNaN(high) || typeof low !== 'number' || isNaN(low) ) continue; 
            if (high > highestHigh) highestHigh = high; 
            if (low < lowestLow) lowestLow = low; 
        }
        if (highestHigh === 0 || lowestLow === Infinity || highestHigh <= lowestLow) return null;
        
        const triggerPriceLong = highestHigh * (1 + bufferPercent / 100); 
        const triggerPriceShort = lowestLow * (1 - bufferPercent / 100);

        // --- Sinyal Kurulumunu (Setup) Ara ---
        let signal = 'WAIT';
        let triggerPrice = 0;
        let confidence = 50; // Temel güven puanı
        let reason = "";

        // [FIX-12] Trend Önbellekten OKUNDU.
        const overallTrend = globalMarketTrends[fullSymbol] || 'UNKNOWN';

        // 1. Kurulum Filtreleri (Tüm sinyaller için ortak)
        const bbWidth = (bb.middle > 0) ? ((bb.upper - bb.lower) / bb.middle) * 100 : 0;
        if (bbWidth > BREAKOUT_SQUEEZE_THRESHOLD) {
            if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: Sıkışma Yok (BBW > ${BREAKOUT_SQUEEZE_THRESHOLD}%)`);
            return null; // Sıkışma yoksa (piyasa zaten volatilse), kurulum arama
        }
        confidence += 15; // Sıkışma teyidi
        reason = `2H Sıkışma (BBW: ${bbWidth.toFixed(1)}%) + `;

        // 2. LONG Kurulumu Ara
        // Fiyat dirence %X yakın mı? VE Trend/RSI destekliyor mu?
        const isNearResistance = lastClosePrice > (triggerPriceLong * (1 - BREAKOUT_TRIGGER_PROXIMITY_PERCENT / 100)) && lastClosePrice < triggerPriceLong;
        
        if (isNearResistance && overallTrend !== 'DOWNTREND' && rsi > rsiLongThreshold) {
            signal = 'BEKLEYEN LONG';
            triggerPrice = triggerPriceLong;
            reason += `Trend (${overallTrend}) + RSI (${rsi.toFixed(0)}) > ${rsiLongThreshold}`;
            if(overallTrend === 'UPTREND') confidence += 20;
        } 
        // 3. SHORT Kurulumu Ara (Eğer LONG bulunmadıysa)
        else {
            const isNearSupport = lastClosePrice < (triggerPriceShort * (1 + BREAKOUT_TRIGGER_PROXIMITY_PERCENT / 100)) && lastClosePrice > triggerPriceShort;
            
            if (isNearSupport && overallTrend !== 'UPTREND' && rsi < rsiShortThreshold) {
                signal = 'BEKLEYEN SHORT';
                triggerPrice = triggerPriceShort;
                reason += `Trend (${overallTrend}) + RSI (${rsi.toFixed(0)}) < ${rsiShortThreshold}`;
                if(overallTrend === 'DOWNTREND') confidence += 20;
            }
        }
        
        // Kurulum bulunamadıysa çık
        if (signal === 'WAIT') {
            return null;
        }

        // --- Kurulum Bulundu, TP/SL Hesapla ---
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        
        if (signal === 'BEKLEYEN LONG') { 
            takeProfit = calculateFibonacciExtension(ohlcv, lookbackPeriod, signal);
            if (!takeProfit) takeProfit = triggerPrice * (1 + BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
            stopLoss = triggerPrice - (atr * slAtrMultiplier); 
        }
        else if (signal === 'BEKLEYEN SHORT') { 
            takeProfit = calculateFibonacciExtension(ohlcv, lookbackPeriod, signal);
            if (!takeProfit) takeProfit = triggerPrice * (1 - BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 100); 
            stopLoss = triggerPrice + (atr * slAtrMultiplier); 
        }
        
        if (takeProfit && stopLoss) { 
            const risk = Math.abs(triggerPrice - stopLoss); 
            const reward = Math.abs(takeProfit - triggerPrice); 
            rrRatio = risk > 0 ? reward / risk : 0; 
            if(rrRatio < 0.5) { 
                if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: Kurulum Düşük R/R (${rrRatio.toFixed(1)})`);
                return null; // Düşük R/R kurulumu gönderme
            }
        } else {
             if(!isManual) console.log(`[${strategyDisplayName} Filtre (${ccxtSymbol})]: TP/SL Hesaplama Hatası`);
             return null;
        }
        
        if (!isManual && !isWatchlist) { 
            signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; 
        } 

        const colorCode = signal === 'BEKLEYEN LONG' ? '\x1b[32m' : '\x1b[31m';
        console.log(`${colorCode}>>> V16.0 KIRILIM KURULUMU (${strategyDisplayName}): ${fullSymbol} - ${signal} (Tetikleme: ${triggerPrice.toFixed(PRICE_PRECISION)})\x1b[0m`);

        resultData = { 
            id: `${fullSymbol}-${signal}-${Date.now()}-${strategyIdSuffix}`, 
            ccxtSymbol, 
            symbol: fullSymbol, 
            signal, 
            confidence: confidence.toFixed(0), 
            entryPrice: triggerPrice.toFixed(PRICE_PRECISION), // [FIX-18] GİRİŞ FİYATI = TETİKLEME FİYATI
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', 
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio > 0 ? rrRatio.toFixed(2) : '---', 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString(), 
            reason, 
            tacticalAnalysis: reason, // Kurulum sinyalinde sebep, analizin kendisidir
            volume: 'N/A', 
            volumeStatus: 'N/A', 
            isFiltered: false, 
            strategyType: strategyIdSuffix,
            bbWidth: bbWidth ? bbWidth : null 
        };
        
        return resultData;

    } catch (error) { 
        console.error(`\x1b[31m[${strategyDisplayName} ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack); 
        return null; 
    }
}


/** STRATEJİ 2: (1M) Hacim Momentumu Stratejisi (ANLIK SİNYAL - Değişiklik Yok) */
async function analyzeVolumeMomentum(ccxtSymbol, isManual = false, isWatchlist = false) {
    let resultData = null; const PRICE_PRECISION = 4;
    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        const cooldownKey = fullSymbol + '-MOMENTUM5M'; 
        
        if (!isManual && !isWatchlist && momentumCooldowns[cooldownKey] && momentumCooldowns[cooldownKey].timestamp > Date.now() - MOMENTUM_COOLDOWN_MS) { 
            return null; 
        }
        
        const overallTrend = globalMarketTrends[fullSymbol] || 'UNKNOWN';
        
        const minRequiredCandles = MOMENTUM_LOOKBACK + 5; 
        let ohlcv_1m; 
        try {
            const fetchLimit = Number.isInteger(minRequiredCandles) && minRequiredCandles > 0 ? minRequiredCandles : 50; 
            ohlcv_1m = await exchange.fetchOHLCV(ccxtSymbol, MOMENTUM_TIMEFRAME, undefined, fetchLimit); 
        } catch (fetchError) {
             console.error(`\x1b[31m[Momentum 1m fetchOHLCV Hatası (${ccxtSymbol})]: ${fetchError.message}\x1b[0m`); 
            return null;
        }

        if (!ohlcv_1m || ohlcv_1m.length < MOMENTUM_LOOKBACK + 2) return null; 
        
        const lastCandle = ohlcv_1m[ohlcv_1m.length - 1]; 
        const prevCandle = ohlcv_1m[ohlcv_1m.length - 2]; 
        if (!lastCandle || !prevCandle || typeof lastCandle[4] !== 'number' || typeof prevCandle[4] !== 'number' || typeof lastCandle[5] !== 'number' || lastCandle[5] < 0) return null;
        const lastClose = lastCandle[4]; const lastVolume = lastCandle[5]; const prevClose = prevCandle[4]; 
        
        const volumeLookbackData = ohlcv_1m.slice(-(MOMENTUM_LOOKBACK + 1), -1).map(c => c[5]).filter(v => typeof v === 'number' && v >= 0); 
        if (volumeLookbackData.length < MOMENTUM_LOOKBACK / 2) return null; 
        const avgVolume = volumeLookbackData.reduce((a, b) => a + b, 0) / volumeLookbackData.length;
        if (isNaN(avgVolume) || avgVolume <= 0) return null;
        
        const priceChangePercent = prevClose === 0 ? 0 : ((lastClose - prevClose) / prevClose) * 100; 
        const hacimMultiplier = lastVolume / avgVolume; 
        
        let signal = 'WAIT'; let tacticalAnalysis = "Koşullar sağlanmadı."; let confidence = "0"; let isFiltered = false;
        const isPumpCondition = hacimMultiplier >= MOMENTUM_VOLUME_SPIKE_MULTIPLIER && priceChangePercent >= MOMENTUM_PRICE_SPIKE_PERCENT;
        const isDumpCondition = hacimMultiplier >= MOMENTUM_VOLUME_SPIKE_MULTIPLIER && priceChangePercent <= -MOMENTUM_PRICE_SPIKE_PERCENT;
        let baseConfidence = 65; 
        
        if (isPumpCondition && overallTrend !== 'DOWNTREND') { 
            signal = 'PUMP';
            if (overallTrend === 'UPTREND') baseConfidence += 15;
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0); 
            tacticalAnalysis = `📈 **1M Hacim Patlaması (PUMP):** Son 1 dakikada ortalamanın **${hacimMultiplier.toFixed(1)} katı** alım hacmi...`; 
        }
        else if (isDumpCondition && overallTrend !== 'UPTREND') { 
            signal = 'DUMP';
            if (overallTrend === 'DOWNTREND') baseConfidence += 15;
            confidence = Math.min(baseConfidence + (hacimMultiplier - MOMENTUM_VOLUME_SPIKE_MULTIPLIER) * 5, 95).toFixed(0); 
            tacticalAnalysis = `📉 **1M Hacim Patlaması (DUMP):** Son 1 dakikada ortalamanın **${hacimMultiplier.toFixed(1)} katı** satım hacmi...`; 
        } else {
             isFiltered = true; 
             // if(!isManual && !isWatchlist) console.log(`[Momentum 1m Filtre (${ccxtSymbol})]: Koşul/Trend`); 
        }

        if (signal === 'WAIT' || isFiltered) {
            return null; // Sadece PUMP/DUMP sinyallerini döndür
        }

        resultData = {
            id: fullSymbol + '-' + signal + '-' + Date.now() + '-MOMENTUM5M', 
            ccxtSymbol: ccxtSymbol, 
            symbol: fullSymbol, 
            signal: signal, 
            confidence: confidence,
            entryPrice: lastClose.toFixed(PRICE_PRECISION), 
            TP: '---', SL: '---', RR: 'N/A', 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString(),
            reason: `Hacim: ${hacimMultiplier.toFixed(1)}x, Fiyat Değ: ${priceChangePercent.toFixed(2)}%`, 
            tacticalAnalysis: tacticalAnalysis, 
            isFiltered: isFiltered, 
            strategyType: 'MOMENTUM5M' 
        };
        
        if (signal !== 'WAIT' && !isFiltered) {
            if (!isManual && !isWatchlist) { 
                momentumCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() };
                const colorCode = signal === 'PUMP' ? '\x1b[32m' : '\x1b[31m';
                console.log(`${colorCode}>>> V16.0 MOMENTUM SİNYALİ (1M): ${resultData.symbol} - ${resultData.signal} (Güven: ${resultData.confidence}%)\x1b[0m`); 
            }
            return resultData;
        } else {
            return (isWatchlist || isManual) ? resultData : null; 
        }
    } catch (error) { 
        console.error(`\x1b[31m[Momentum 1m ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack); 
        return null; 
    }
}

/** [FIX-19] YENİDEN YAZILDI: STRATEJİ 3: (1H) PROAKTİF RSI Uyuşmazlık Kurulumu */
async function analyzeDivergenceStrategy(ccxtSymbol, isManual = false, isWatchlist = false) {
    const timeframe = DIVERGENCE_TIMEFRAME;
    const rsiPeriod = DIVERGENCE_RSI_PERIOD;
    const lookbackPeriod = DIVERGENCE_LOOKBACK_PERIOD;
    const pivotLookback = DIVERGENCE_PIVOT_LOOKBACK;
    const strategyIdSuffix_Bull = 'DIV_1H_BULL';
    const strategyIdSuffix_Bear = 'DIV_1H_BEAR';
    const PRICE_PRECISION = 4;

    try {
        const market = exchange.markets[ccxtSymbol]; if (!market) return null;
        const fullSymbol = market.base + 'USDT';
        
        const cooldownKeyBull = `${fullSymbol}-${strategyIdSuffix_Bull}`;
        const cooldownKeyBear = `${fullSymbol}-${strategyIdSuffix_Bear}`;
        if (!isManual && !isWatchlist) {
            if (signalCooldowns[cooldownKeyBull] && signalCooldowns[cooldownKeyBull].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;
            if (signalCooldowns[cooldownKeyBear] && signalCooldowns[cooldownKeyBear].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) return null;
        }

        const candlesToFetch = lookbackPeriod + 50;
        let ohlcv;
        try {
            ohlcv = await exchange.fetchOHLCV(ccxtSymbol, timeframe, undefined, candlesToFetch);
        } catch (fetchError) {
            console.error(`\x1b[31m[Divergence fetchOHLCV Hatası (${ccxtSymbol}, ${timeframe})]: ${fetchError.message}\x1b[0m`);
            return null;
        }

        if (!ohlcv || ohlcv.length < lookbackPeriod) return null;

        const allCloses = ohlcv.map(c => c[4]);
        const allHighs = ohlcv.map(c => c[2]);
        const allLows = ohlcv.map(c => c[3]);
        
        let rsiResult, atrResult;
        try {
            rsiResult = RSI.calculate({ values: allCloses, period: rsiPeriod });
            const atrInput = { high: allHighs, low: allLows, close: allCloses, period: BREAKOUT_BASE_ATR_PERIOD };
            atrResult = ATR.calculate(atrInput);
        } catch (e) {
            console.error(`\x1b[31m[Divergence Indikator Kritik Hata (${ccxtSymbol}, ${timeframe})]: ${e.message}\x1b[0m`);
            return null;
        }
        
        const rsiValues = rsiResult;
        const priceValues = allCloses.slice(allCloses.length - rsiValues.length); 
        if (rsiValues.length < (pivotLookback * 2) + 3) return null; 
        
        const lastAtr = atrResult.length > 0 ? atrResult[atrResult.length - 1] : null;
        const lastClosePrice = allCloses[allCloses.length - 1];
        if (!lastAtr || isNaN(lastAtr) || !lastClosePrice || isNaN(lastClosePrice)) return null;

        const overallTrend = globalMarketTrends[fullSymbol] || 'UNKNOWN';

        let signal = 'WAIT';
        let reason = 'Uyuşmazlık bulunamadı.';
        let strategyIdSuffix = 'DIV_1H';
        let confidence = 0;
        let triggerPrice = 0;
        let uyuşmazlıkBaşlangıçFiyatı = 0; // TP/SL hesaplaması için
        
        // 1. Pozitif (Bullish) Uyuşmazlık Ara (DİPLERE BAK)
        const priceLows = findPivots(priceValues, pivotLookback, false); 
        const rsiLows = findPivots(rsiValues, pivotLookback, false);     

        if (priceLows.length >= 2 && rsiLows.length >= 2) {
            const pL1 = priceLows[priceLows.length - 2];
            const pL2 = priceLows[priceLows.length - 1]; 
            const rL1 = rsiLows[rsiLows.length - 2];
            const rL2 = rsiLows[rsiLows.length - 1]; 

            if (pL2.value < pL1.value && rL2.value > rL1.value) {
                // Pozitif uyuşmazlık TEYİT EDİLDİ. Şimdi teyit seviyesini (son direnci) bul.
                // İki dip arasındaki tepeyi (pL1.index ve pL2.index arasındaki) bul
                const highsBetweenLows = findPivots(priceValues.slice(pL1.index, pL2.index + 1), pivotLookback, true);
                
                if (highsBetweenLows.length > 0) {
                    const confirmationPivot = highsBetweenLows[highsBetweenLows.length - 1]; // En son tepe
                    
                    signal = 'BEKLEYEN LONG';
                    strategyIdSuffix = strategyIdSuffix_Bull;
                    triggerPrice = confirmationPivot.value; // Teyit fiyatı = son direnç
                    uyuşmazlıkBaşlangıçFiyatı = pL1.value; // TP hesabı için
                    reason = `1H POZİTİF UYUŞMAZLIK KURULUMU`;
                    confidence = 60; 
                    if(overallTrend === 'UPTREND') confidence += 20; 
                    if(overallTrend === 'DOWNTREND') confidence -= 20; 
                    if(!isManual) console.log(`\x1b[35m!!! DIVERGENCE KURULUMU (1h, ${ccxtSymbol}): ${signal} @ ${triggerPrice}\x1b[0m`);
                }
            }
        }
        
        // 2. Negatif (Bearish) Uyuşmazlık Ara (TEPELERE BAK)
        if (signal === 'WAIT') {
            const priceHighs = findPivots(priceValues, pivotLookback, true); 
            const rsiHighs = findPivots(rsiValues, pivotLookback, true);     

            if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
                const pH1 = priceHighs[priceHighs.length - 2];
                const pH2 = priceHighs[priceHighs.length - 1]; 
                const rH1 = rsiHighs[rsiHighs.length - 2];
                const rH2 = rsiHighs[rsiHighs.length - 1]; 

                if (pH2.value > pH1.value && rH2.value < rH1.value) {
                    // Negatif uyuşmazlık TEYİT EDİLDİ. Şimdi teyit seviyesini (son desteği) bul.
                    // İki tepe arasındaki dibi (pH1.index ve pH2.index arasındaki) bul
                    const lowsBetweenHighs = findPivots(priceValues.slice(pH1.index, pH2.index + 1), pivotLookback, false);
                    
                    if (lowsBetweenHighs.length > 0) {
                        const confirmationPivot = lowsBetweenHighs[lowsBetweenHighs.length - 1]; // En son dip
                        
                        signal = 'BEKLEYEN SHORT';
                        strategyIdSuffix = strategyIdSuffix_Bear;
                        triggerPrice = confirmationPivot.value; // Teyit fiyatı = son destek
                        uyuşmazlıkBaşlangıçFiyatı = pH1.value; // TP hesabı için
                        reason = `1H NEGATİF UYUŞMAZLIK KURULUMU`;
                        confidence = 60;
                        if(overallTrend === 'DOWNTREND') confidence += 20; 
                        if(overallTrend === 'UPTREND') confidence -= 20; 
                        if(!isManual) console.log(`\x1b[35m!!! DIVERGENCE KURULUMU (1h, ${ccxtSymbol}): ${signal} @ ${triggerPrice}\x1b[0m`);
                    }
                }
            }
        }

        if (signal === 'WAIT' || confidence < 50) { 
            return null;
        }

        // --- Kurulum Bulundu, TP/SL Hesapla ---
        let takeProfit = null; let stopLoss = null; let rrRatio = 0;
        
        if (signal === 'BEKLEYEN LONG') { 
            // SL = Son dibin altına
            stopLoss = (priceLows.length > 0 ? priceLows[priceLows.length - 1].value : lastClosePrice) - (lastAtr * DIVERGENCE_SL_ATR_MULTIPLIER); 
            // TP = Fib seviyesi
            takeProfit = calculateFibRetracement(uyuşmazlıkBaşlangıçFiyatı, triggerPrice, DIVERGENCE_TP_FIB_LEVEL);
        }
        else if (signal === 'BEKLEYEN SHORT') { 
            // SL = Son tepenin üstüne
            stopLoss = (priceHighs.length > 0 ? priceHighs[priceHighs.length - 1].value : lastClosePrice) + (lastAtr * DIVERGENCE_SL_ATR_MULTIPLIER); 
            // TP = Fib seviyesi
            takeProfit = calculateFibRetracement(uyuşmazlıkBaşlangıçFiyatı, triggerPrice, DIVERGENCE_TP_FIB_LEVEL);
        }
        
        if (takeProfit === null) {
             if (signal === 'BEKLEYEN LONG') takeProfit = triggerPrice * (1 + (BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 2) / 100); 
             if (signal === 'BEKLEYEN SHORT') takeProfit = triggerPrice * (1 - (BREAKOUT_BASE_TP_PERCENTAGE_FALLBACK / 2) / 100);
        }

        if (takeProfit && stopLoss) { 
            const risk = Math.abs(triggerPrice - stopLoss); 
            const reward = Math.abs(takeProfit - triggerPrice); 
            rrRatio = risk > 0 ? reward / risk : 0; 
            if(rrRatio < 0.5) { 
                if(!isManual) console.log(`[Divergence Filtre (${ccxtSymbol})]: Kurulum Düşük R/R (${rrRatio.toFixed(1)})`);
                return null; 
            }
        } else {
             if(!isManual) console.log(`[Divergence Filtre (${ccxtSymbol})]: TP/SL Hesaplama Hatası`);
             return null; 
        }
        
        if (!isManual && !isWatchlist) { 
            signalCooldowns[signal === 'BEKLEYEN LONG' ? cooldownKeyBull : cooldownKeyBear] = { signalType: signal, timestamp: Date.now() }; 
        } 

        const colorCode = signal === 'BEKLEYEN LONG' ? '\x1b[32m' : '\x1b[31m';
        console.log(`${colorCode}>>> V16.0 UYUŞMAZLIK SİNYALİ (1H): ${fullSymbol} - ${signal} (Güven: ${confidence}%)\x1b[0m`);

        return { 
            id: `${fullSymbol}-${signal}-${Date.now()}-${strategyIdSuffix}`, 
            ccxtSymbol, 
            symbol: fullSymbol, 
            signal, 
            confidence: confidence.toFixed(0), 
            entryPrice: triggerPrice.toFixed(PRICE_PRECISION), // [FIX-19] GİRİŞ FİYATI = TETİKLEME FİYATI
            TP: takeProfit ? takeProfit.toFixed(PRICE_PRECISION) : '---', 
            SL: stopLoss ? stopLoss.toFixed(PRICE_PRECISION) : '---', 
            RR: rrRatio > 0 ? rrRatio.toFixed(2) : '---', 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString(), 
            reason, 
            tacticalAnalysis: reason, 
            volume: 'N/A', 
            volumeStatus: 'N/A', 
            isFiltered: false, 
            strategyType: strategyIdSuffix,
            bbWidth: null 
        };
    } catch (error) { 
        console.error(`\x1b[31m[Divergence ANALİZ HATASI (${ccxtSymbol})]: ${error.message}\x1b[0m`, error.stack); 
        return null; 
    }
}


// --- AKILLI MANUEL ANALİZ VE TARAMA FONKSİYONLARI ---
async function runAllAnalysesForSymbol(ccxtSymbol, isManual = false, isWatchlist = false) {
    if(isWatchlist) console.log(`[Watchlist Analiz Başladı] -> ${ccxtSymbol}`);
    let activeSignals = [];
    
    const brk2hConfig = { 
        timeframe: TIMEFRAME_2H, 
        lookbackPeriod: BRK2H_LOOKBACK_PERIOD, 
        bufferPercent: BRK2H_BUFFER_PERCENT, 
        slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, 
        rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, 
        rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, 
        strategyIdSuffix: 'BRK2H', 
        strategyDisplayName: '2h' 
    };

    try {
        const analyses = await Promise.all([
            analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, isManual, isWatchlist),
            analyzeVolumeMomentum(ccxtSymbol, isManual, isWatchlist),
            analyzeDivergenceStrategy(ccxtSymbol, isManual, isWatchlist) 
        ]);
        
        activeSignals = analyses.filter(signal => signal !== null);
    } catch (error) {
        console.error(`[runAllAnalysesForSymbol Hata (${ccxtSymbol})]: ${error.message}`);
    }
    
    if(isWatchlist) console.log(`[Watchlist Analiz Bitti] -> ${ccxtSymbol}. Bulunan sinyal/durum sayısı: ${activeSignals.length}`);
    return activeSignals; 
}

function prioritizeAnalysis(activeSignals) {
    if (!activeSignals || activeSignals.length === 0) return null; 

    // [FIX-19] Sinyal adları güncellendi
    const validDivergenceSignals = activeSignals.filter(s => s.signal !== 'WAIT' && !s.isFiltered && (s.strategyType === 'DIV_1H_BULL' || s.strategyType === 'DIV_1H_BEAR'));
    const validBreakoutSignals = activeSignals.filter(s => s.signal !== 'WAIT' && !s.isFiltered && s.strategyType === 'BRK2H');
    const validMomentumSignal = activeSignals.find(s => s.signal !== 'WAIT' && !s.isFiltered && s.strategyType === 'MOMENTUM5M'); 
    
    // ÖNCELİK 1: UYUŞMAZLIK SİNYALLERİ (En erken uyarı)
    if (validDivergenceSignals.length > 0) {
        return validDivergenceSignals[0]; 
    }

    // ÖNCELİK 2: KIRILIM SİNYALLERİ
    if (validBreakoutSignals.length > 0) {
        return validBreakoutSignals[0]; 
    }
    
    // ÖNCELİK 3: MOMENTUM SİNYALİ
    if (validMomentumSignal) {
        return validMomentumSignal;
    }

    const allResultsSorted = [...activeSignals]; 
    const priorityMap = { 'DIV_1H_BULL': 1, 'DIV_1H_BEAR': 1, 'BRK2H': 2, 'MOMENTUM5M': 3 }; 
    allResultsSorted.sort((a, b) => {
        const priorityA = priorityMap[a.strategyType] || 5;
        const priorityB = priorityMap[b.strategyType] || 5;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return (b.timestamp || 0) - (a.timestamp || 0); 
    });
    
    return allResultsSorted.length > 0 ? allResultsSorted[0] : null; 
}

async function runWatchlistScan() {
    // [FIX-15] Yavaş Şerit Kilidi
    if (isLongScanRunning) {
        console.log(`\n--- IZLEME LISTESI TARAMASI ATLANDI (Başka bir 'Yavaş' tarama çalışıyor) ---`);
        return;
    }
    isLongScanRunning = true;
    const scanTimeStr = new Date().toLocaleTimeString();
    const watchlistSymbols = Object.keys(globalWatchlist);
    if (watchlistSymbols.length === 0) { 
        isLongScanRunning = false; 
        return; 
    }

    console.log(`\n--- IZLEME LISTESI TARAMASI BAŞLADI (${scanTimeStr}) ---`);
    let anythingChanged = false;

    try {
        for (const fullSymbol of watchlistSymbols) {
            const ccxtSymbol = globalWatchlist[fullSymbol]?.ccxtSymbol;
            if (!ccxtSymbol) continue;
            
            try {
                const allAnalyses = await runAllAnalysesForSymbol(ccxtSymbol, false, true); 
                const prioritizedResult = prioritizeAnalysis(allAnalyses); 
                
                if (prioritizedResult) {
                    if (!globalWatchlist[fullSymbol] || 
                        globalWatchlist[fullSymbol].signal !== prioritizedResult.signal || 
                        globalWatchlist[fullSymbol].confidence !== prioritizedResult.confidence ||
                        globalWatchlist[fullSymbol].strategyType !== prioritizedResult.strategyType || 
                        globalWatchlist[fullSymbol].isFiltered !== prioritizedResult.isFiltered) { 
                        anythingChanged = true;
                    }
                    globalWatchlist[fullSymbol] = prioritizedResult; 
                } else {
                    if (globalWatchlist[fullSymbol].signal !== 'HATA/YOK') {
                        globalWatchlist[fullSymbol].signal = 'HATA/YOK';
                        globalWatchlist[fullSymbol].tacticalAnalysis = "Analiz sırasında veri alınamadı.";
                        globalWatchlist[fullSymbol].confidence = "0";
                        anythingChanged = true;
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS * 2)); 
            } catch (error) {
                console.error(`[runWatchlistScan Hatası (${ccxtSymbol})]: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`[runWatchlistScan Genel Hata]: ${error.message}`);
    } finally {
        if (anythingChanged) {
            console.log(`[Watchlist] Değişiklikler algılandı, güncelleme gönderiliyor.`);
            io.emit('watchlist_update', globalWatchlist);
        }
        console.log(`--- IZLEME LISTESI TARAMASI TAMAMLANDI (${scanTimeStr}) ---`);
        isLongScanRunning = false; 
    }
}

// --- ANA TARAMA DÖNGÜLERİ ---

// [FIX 7] 1H ve 4H TARAMA FONKSİYONLARI DEVRE DIŞI
async function runBreakoutScan1h() { return; }
async function runBreakoutScan4h() { return; }

// [FIX-11] YENİ TREND ÖNBELLEĞİ TARAMASI
async function runTrendCacheScan() {
    // [FIX-15] Yavaş Şerit Kilidi
    if (isLongScanRunning) {
        console.log(`\n--- 4H TREND ÖNBELLEK TARAMASI ATLANDI (Başka bir 'Yavaş' tarama çalışıyor) ---`);
        return;
    }
    isLongScanRunning = true;
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    let updatedCount = 0;
    try {
        if (globalTargetList.length === 0) { console.log("4H Trend Önbellek taraması için hedef liste boş."); isLongScanRunning = false; return; } 
        
        const allSwapSymbols = globalTargetList.map(item => item.symbol); 
        console.log(`\n--- 4H TREND ÖNBELLEK TARAMASI BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        
        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            const market = exchange.markets[ccxtSymbol];
            if (!market) continue;
            const fullSymbol = market.base + 'USDT';

            try { 
                const trend = await checkMarketCondition(ccxtSymbol);
                if (globalMarketTrends[fullSymbol] !== trend) {
                    globalMarketTrends[fullSymbol] = trend;
                    updatedCount++;
                }
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS)); 
            } catch (loopError) { console.error(`[4H Trend Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik 4H Trend Tarama Hatası:", error.message); } 
    finally { 
        const endTimeStr = new Date().toLocaleTimeString();
        console.log(`--- 4H TREND ÖNBELLEK TARAMASI TAMAMLANDI (${endTimeStr}). ${updatedCount} trend güncellendi. ---`); 
        isLongScanRunning = false; 
    } 
}


// [FIX 7] Sadece 2H Kırılım Taraması Aktif
async function runBreakoutScan2h() { 
    // [FIX-15] Yavaş Şerit Kilidi
    if (isLongScanRunning) {
        console.log(`\n--- 2h KIRILIM TARAMA ATLANDI (Başka bir 'Yavaş' tarama çalışıyor) ---`);
        return;
    }
    isLongScanRunning = true;
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try { 
        if (globalTargetList.length === 0) { console.log("2h Kırılım tarama için hedef liste boş."); isLongScanRunning = false; return; } 
        
        const allSwapSymbols = globalTargetList.map(item => item.symbol);
        console.log(`\n--- 2h KIRILIM TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        
        const brk2hConfig = { 
            timeframe: TIMEFRAME_2H, 
            lookbackPeriod: BRK2H_LOOKBACK_PERIOD, 
            bufferPercent: BRK2H_BUFFER_PERCENT, 
            slAtrMultiplier: BRK2H_SL_ATR_MULTIPLIER, 
            rsiLongThreshold: BRK2H_RSI_LONG_THRESHOLD, 
            rsiShortThreshold: BRK2H_RSI_SHORT_THRESHOLD, 
            strategyIdSuffix: 'BRK2H', 
            strategyDisplayName: '2h' 
        };

        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                const analysisResult = await analyzeBreakoutStrategy(ccxtSymbol, brk2hConfig, false, false); 
                if (analysisResult) { 
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS)); 
            } catch (loopError) { console.error(`[2h Kırılım Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik 2h Kırılım Tarama Hatası:", error.message); } 
    finally { 
        const endTimeStr = new Date().toLocaleTimeString(); 
        console.log(`--- 2h KIRILIM TARAMA TAMAMLANDI (${endTimeStr}). ---`); 
        
        const temizelemeZamani = Date.now() - (SIGNAL_COOLDOWN_MS);
        const momentumTemizlemeZamani = Date.now() - (MOMENTUM_COOLDOWN_MS); 
        global.APP_STATE.signals = global.APP_STATE.signals.filter(s => { 
            if (!s || !s.timestamp) return false; 
            if (s.strategyType === 'MOMENTUM5M') { return s.timestamp > momentumTemizlemeZamani; } 
            else { return s.timestamp > temizelemeZamani; } 
        });
        global.APP_STATE.scanStatus = { message: `2H Tarama Tamamlandı (${endTimeStr}). ${global.APP_STATE.signals.length} sinyal aktif.`, isScanning: false }; 
        io.emit('scan_status', global.APP_STATE.scanStatus);

        isLongScanRunning = false; 
    } 
}

async function runMomentumScan1m() { 
    // [FIX-15] Hızlı Şerit Kilidi
    if (isMomentumScanRunning) {
        console.log(`\n--- 1M MOMENTUM TARAMA ATLANDI (Önceki 1M taraması hala çalışıyor) ---`);
        return;
    }
    isMomentumScanRunning = true;
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try {
        if (globalTargetList.length === 0) { console.log("1M Momentum tarama için hedef liste boş."); isMomentumScanRunning = false; return; } 
        
        // [FIX-16] Hacme göre sıralı olan listeden (prescan'de sıralandı) Top N coini al
        const topSymbols = globalTargetList.slice(0, TOP_N_MOMENTUM).map(item => item.symbol); 

        console.log(`\n--- 1M MOMENTUM TARAMA BAŞLADI: ${scanTimeStr} (En hacimli ${topSymbols.length} coin taranıyor) ---`); 
        
        for (const ccxtSymbol of topSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                const analysisResult = await analyzeVolumeMomentum(ccxtSymbol, false, false); 
                if (analysisResult) { 
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS)); 
            } catch (loopError) { console.error(`[Momentum 1m Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik Momentum 1m Tarama Hatası:", error.message); } 
    finally { 
        const endTimeStr = new Date().toLocaleTimeString(); 
        console.log(`--- 1M MOMENTUM TARAMA TAMAMLANDI (${endTimeStr}). ---`); 
        isMomentumScanRunning = false; 
    } 
}

async function runDivergenceScan1h() { 
    // [FIX-15] Yavaş Şerit Kilidi
    if (isLongScanRunning) {
        console.log(`\n--- 1H UYUŞMAZLIK TARAMA ATLANDI (Başka bir 'Yavaş' tarama çalışıyor) ---`);
        return;
    }
    isLongScanRunning = true;
    const scanTime = new Date(); const scanTimeStr = scanTime.toLocaleTimeString(); 
    try {
        if (globalTargetList.length === 0) { console.log("1H Uyuşmazlık tarama için hedef liste boş."); isLongScanRunning = false; return; } 
        
        const allSwapSymbols = globalTargetList.map(item => item.symbol);
        console.log(`\n--- 1H UYUŞMAZLIK TARAMA BAŞLADI: ${scanTimeStr} (${allSwapSymbols.length} hedef coin taranıyor) ---`); 
        
        for (const ccxtSymbol of allSwapSymbols) { 
            if (!ccxtSymbol) continue; 
            try { 
                const analysisResult = await analyzeDivergenceStrategy(ccxtSymbol, false, false); 
                if (analysisResult) { 
                    global.APP_STATE.signals.unshift(analysisResult); 
                    console.log(`--> YENI SINYAL GONDERILIYOR: ${analysisResult.symbol} (${analysisResult.strategyType})`);
                    io.emit('yeni_sinyal', analysisResult); 
                } 
                await new Promise(resolve => setTimeout(resolve, API_DELAY_MS)); 
            } catch (loopError) { console.error(`[1H Uyuşmazlık Tarama Döngü Hatası (${ccxtSymbol})]: ${loopError.message}`); } 
        } 
    } catch (error) { console.error("Kritik 1H Uyuşmazlık Tarama Hatası:", error.message); } 
    finally { 
        const endTimeStr = new Date().toLocaleTimeString(); 
        console.log(`--- 1H UYUŞMAZLIK TARAMA TAMAMLANDI (${endTimeStr}). ---`); 
        isLongScanRunning = false; 
    } 
}


// --- Express Rotaları ve Socket.IO Bağlantısı ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'app.html')); });

io.on('connection', (socket) => { 
    console.log('Bir istemci bağlandı:', socket.id); 
    console.log(`Initial state gönderiliyor (${socket.id}), signals toplam sayı:`, global.APP_STATE.signals.length);
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
        io.emit('watchlist_update', globalWatchlist); 
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
        const allAnalyses = await runAllAnalysesForSymbol(ccxtSymbol, true, true); 
        const prioritizedResult = prioritizeAnalysis(allAnalyses); 
        
        if (prioritizedResult) {
            globalWatchlist[fullSymbol] = prioritizedResult; 
            console.log(`[Watchlist] Eklendi/Güncellendi: ${fullSymbol}`);
            io.emit('watchlist_update', globalWatchlist); 
            res.status(200).json(prioritizedResult); 
        } else {
            const errorData = {
                ccxtSymbol: ccxtSymbol, symbol: fullSymbol, signal: 'HATA/YOK', confidence: "0",
                entryPrice: '0', TP: '---', SL: '---', RR: 'N/A', 
                timestamp: Date.now(), time: new Date().toLocaleTimeString(),
                reason: 'Analizden geçerli veri alınamadı.', tacticalAnalysis: 'Veri yok veya sembol hatalı.', 
                strategyType: 'MANUAL', isFiltered: true
            };
            globalWatchlist[fullSymbol] = errorData; 
            io.emit('watchlist_update', globalWatchlist);
            res.status(200).json(errorData); 
        }
    } catch (error) {
        console.error(`[/api/analyze-coin Hata (${symbol})]: ${error.message}`);
        res.status(500).json({ error: 'Coin analizi sırasında sunucu hatası: ' + error.message });
    }
});


// --- Sunucu Başlatma ve Döngüler ---
server.listen(PORT, async () => {
    console.log("==============================================");
    console.log(`🚀 Sonny AI Trader (V16.0 - Teyitli Giriş) BAŞLATILIYOR - Port: ${PORT}`); 
    console.log(`Node.js Sürümü: ${process.version}`);
    console.log("==============================================");
    console.log("[Başlangıç] Borsa (Bitget) marketleri yükleniyor..."); 
    try {
        await exchange.loadMarkets(true);
        console.log("[Başlangıç] Marketler yüklendi. İlk ön tarama başlatılıyor...");
        await runPreScan();
        console.log(`[Başlangıç] İlk ön tarama tamamlandı. Hedef liste boyutu: ${globalTargetList.length}`);
        
        console.log(`[Başlangıç] Ana trend önbelleği (4H) ilk kez dolduruluyor... (${globalTargetList.length} coin)`);
        await runTrendCacheScan(); 
        console.log("[Başlangıç] Trend önbelleği dolduruldu. İlk sinyal taramaları (hızlı) başlıyor...");

        if (globalTargetList.length > 0) {
            await runBreakoutScan2h(); 
            await runMomentumScan1m(); 
            await runDivergenceScan1h(); 
        } else { 
            console.warn("[Başlangıç] Hedef liste boş olduğu için ilk taramalar atlandı."); 
        }
        
        console.log("[Başlangıç] Periyodik tarama döngüleri ayarlanıyor...");
        
        // Yavaş Şerit Döngüleri
        setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL); 
        setInterval(runPreScan, PRESCAN_INTERVAL);
        setInterval(runTrendCacheScan, TREND_CACHE_SCAN_INTERVAL); 
        setInterval(async () => { if (globalTargetList.length > 0) await runBreakoutScan2h(); }, BREAKOUT_SCAN_INTERVAL_2H);
        setInterval(async () => { if (globalTargetList.length > 0) await runDivergenceScan1h(); }, DIVERGENCE_SCAN_INTERVAL); 
        
        // Hızlı Şerit Döngüsü
        setInterval(async () => { if (globalTargetList.length > 0) await runMomentumScan1m(); }, MOMENTUM_SCAN_INTERVAL); 

        
        const isRender = process.env.RENDER === 'true'; 
        const listenAddress = isRender ? 'Render URL üzerinden' : `http://localhost:${PORT}`;
        console.log(`\n✅ SUNUCU BAŞARIYLA BAŞLATILDI ve ${listenAddress} adresinde dinlemede.`);
        console.log("==============================================");
    } catch (loadError) {
        console.error("\x1b[31m[KRİTİK BAŞLANGIÇ HATASI]: Market/ön-tarama yüklenemedi! Sunucu düzgün çalışmayabilir.\x1b[0m");
        console.error(`Hata Detayı: ${loadError.message}`);
        if (process.env.RENDER === 'true') {
           console.error("Render üzerinde kritik başlangıç hatası, çıkılıyor...");
           process.exit(1); 
        }
    }
});

console.log("--- server.js dosyası okunması tamamlandı ---");