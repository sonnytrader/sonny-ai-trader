const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const ccxt = require('ccxt'); 
const { RSI, ATR, BollingerBands, EMA } = require('technicalindicators'); 

console.log("--- server.js dosyası okunmaya başlandı (V35.1 - Tarama Hatası Düzeltmesi) ---");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = 3000;

const exchange = new ccxt.bitget({
    'enableRateLimit': true,
    'rateLimit': 200, 
});

// --- V35.1 GLOBAL SABİTLER ---
const PRESCAN_MIN_24H_VOLUME_USDT = 3000000; 
const PRESCAN_INTERVAL = 120 * 60 * 1000; 
const API_DELAY_MS = 50; 
const MAX_LEVERAGE_FACTOR = 5.0; 

// Kırılım (BRK2H) Ayarları
const TIMEFRAME_2H = '2h';
const TIMEFRAME_4H = '4h'; 
const BRK2H_LOOKBACK_PERIOD = 50;
const BRK2H_BUFFER_PERCENT = 0.1; 
const BRK2H_SL_ATR_MULTIPLIER = 2.0; 
const BRK2H_RSI_LONG_THRESHOLD = 55; // Yumuşatılmış
const BRK2H_RSI_SHORT_THRESHOLD = 45; // Yumuşatılmış
const BRK2H_VOLUME_MULTIPLIER = 1.0; 

// İndikatör Ayarları
const EMA_PERIOD = 200; 
const BBW_MAX_PERCENT = 6.0; 
const BBW_BOOST_MAX_PERCENT = 1.5; 
const ATR_PERIOD = 14; 
const RSI_PERIOD = 14;
const BREAKOUT_BASE_BB_PERIOD = 20; 
const BREAKOUT_BASE_BB_STDDEV = 2;
const R_R_RATIO_MIN = 1.5; 
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; 
const STRATEGY_TYPE_BRK = 'BRK2H'; 

// Duyarlılık Ayarları
const SENTIMENT_SYMBOL = 'BTC/USDT:USDT'; 
const SENTIMENT_TIMEFRAME = TIMEFRAME_4H;
const SENTIMENT_RSI_THRESHOLD_BULL = 55; 
const SENTIMENT_RSI_THRESHOLD_BEAR = 45; 

// --- Sinyal ve Durum Yönetimi ---
let availableSymbols = []; 
let globalTargetSymbols = []; 
let allSignals = {}; 
let momentumSignals = [];
let watchlist = {};
let scanStatus = { isScanning: false, message: 'Sunucu başlatılıyor...' };
let signalCooldowns = {};
let globalSentiment = { status: 'UNKNOWN', value: 'N/A' };
let WATCHLIST_MAX_AGE_MS = 1 * 60 * 60 * 1000; 


// --- Yardımcı Fonksiyonlar (İndikatörler) ---
async function fetchCandles(ccxtSymbol, interval, limit) { 
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, interval, undefined, limit);
        return ohlcv; 
    } catch (error) {
        return null;
    }
}

function extractCloses(candles) { return candles.map(c => parseFloat(c[4])); }
function extractHighs(candles) { return candles.map(c => parseFloat(c[2])); }
function extractLows(candles) { return candles.map(c => parseFloat(c[3])); }


function calculateBBW(candles, period = BREAKOUT_BASE_BB_PERIOD) { 
    if (candles.length < period) return null;
    const closes = extractCloses(candles);

    try {
        const bbResult = BollingerBands.calculate({ values: closes, period: period, stdDev: BREAKOUT_BASE_BB_STDDEV });
        const bb = bbResult[bbResult.length - 1];
        if (!bb || !bb.middle || bb.middle === 0) return 0;
        const bbw = ((bb.upper - bb.lower) / bb.middle) * 100;
        return bbw;
    } catch(e) { return 0; }
}


function calculateATR(candles, period = ATR_PERIOD) { 
    const high = extractHighs(candles);
    const low = extractLows(candles);
    const close = extractCloses(candles);

    try {
        const atrResult = ATR.calculate({ high, low, close, period });
        return atrResult.length > 0 ? atrResult[atrResult.length - 1] : null;
    } catch(e) { return null; }
}

function calculateRSI(closes, period) { 
    try {
        const rsiResult = RSI.calculate({ values: closes, period: period });
        return rsiResult.length > 0 ? rsiResult[rsiResult.length - 1] : null;
    } catch(e) { return null; }
}

function calculateEMA(closes, period) {
    try {
        const emaResult = EMA.calculate({ values: closes, period: period });
        return emaResult.length > 0 ? emaResult[emaResult.length - 1] : null;
    } catch(e) { return null; }
}

async function getTrendDirection(ccxtSymbol) {
    const minRequiredCandles = EMA_PERIOD + 2;
    const candles4H = await fetchCandles(ccxtSymbol, TIMEFRAME_4H, minRequiredCandles);
    
    if (!candles4H || candles4H.length < minRequiredCandles) {
        return { status: 'UNKNOWN', ema: 'N/A' };
    }
    
    const closes4H = extractCloses(candles4H);
    const lastClose = closes4H[closes4H.length - 1];
    const ema200 = calculateEMA(closes4H, EMA_PERIOD);
    
    let status = 'NEUTRAL';
    if (ema200 !== null) {
        if (lastClose > ema200) { status = 'BULLISH'; } 
        else if (lastClose < ema200) { status = 'BEARISH'; }
    }
    
    return { status: status, ema: ema200 ? ema200.toFixed(4) : 'N/A' };
}


function analyzeVolume(candles, currentCandleIndex, period = 20) { 
    if (candles.length < period) return { ratio: 0, avg: 0 };
    const currentVolume = parseFloat(candles[currentCandleIndex][5]);
    const recentVolumes = candles.slice(currentCandleIndex - period, currentCandleIndex).map(c => parseFloat(c[5]));
    if (recentVolumes.length === 0) return { ratio: 0, avg: 0 };
    const averageVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
    const volumeRatio = currentVolume / averageVolume;
    return { ratio: volumeRatio, avg: averageVolume };
}

function calculateTP_SL_ATR(entryPrice, atr, signalDirection) { 
    const SL_MULTIPLIER = BRK2H_SL_ATR_MULTIPLIER; 
    const TP_MULTIPLIER = SL_MULTIPLIER * R_R_RATIO_MIN; 
    const TICK_SIZE_DECIMAL = 4;

    let SL, TP;

    if (signalDirection === 'LONG') {
        SL = entryPrice - (atr * SL_MULTIPLIER);
        TP = entryPrice + (atr * TP_MULTIPLIER);
    } else if (signalDirection === 'SHORT') {
        SL = entryPrice + (atr * SL_MULTIPLIER);
        TP = entryPrice - (atr * TP_MULTIPLIER);
    } else {
        return { SL: '---', TP: '---', RR: 'N/A' };
    }

    SL = parseFloat(SL.toFixed(TICK_SIZE_DECIMAL));
    TP = parseFloat(TP.toFixed(TICK_SIZE_DECIMAL));
    
    const risk = Math.abs(entryPrice - SL);
    const reward = Math.abs(entryPrice - TP);
    const rr = risk > 0 ? (reward / risk).toFixed(2) : 'N/A';

    return { SL, TP, RR: rr };
}

// --- Duyarlılık Kontrolü ---

async function runSentimentAnalysis() {
    try {
        const candles = await fetchCandles(SENTIMENT_SYMBOL, SENTIMENT_TIMEFRAME, RSI_PERIOD + 2);
        if (!candles || candles.length < RSI_PERIOD + 1) {
            globalSentiment = { status: 'UNKNOWN', value: 'N/A' };
            return;
        }

        const closes = extractCloses(candles);
        const rsi4H = calculateRSI(closes, RSI_PERIOD);

        let status = 'NEUTRAL';
        if (rsi4H >= SENTIMENT_RSI_THRESHOLD_BULL) { status = 'BULLISH'; } 
        else if (rsi4H <= SENTIMENT_RSI_THRESHOLD_BEAR) { status = 'BEARISH'; }

        globalSentiment = { status: status, value: rsi4H ? rsi4H.toFixed(2) : 'N/A' };
    } catch (e) {
        console.error(`[DUYARLILIK HATASI]: ${e.message}`);
        globalSentiment = { status: 'UNKNOWN', value: 'N/A' };
    }
}


// --- Ana Strateji: Momentum Teyitli Kırılım (BRK2H) ---

async function analyzeBreakoutStrategy(ccxtSymbol, isManual = false) {
    try {
        const timeframe = TIMEFRAME_2H;
        
        const cooldownKey = `${ccxtSymbol}-${STRATEGY_TYPE_BRK}`;
        if (!isManual && signalCooldowns[cooldownKey] && signalCooldowns[cooldownKey].timestamp > Date.now() - SIGNAL_COOLDOWN_MS) { return null; }
        
        const minRequiredCandles2H = BRK2H_LOOKBACK_PERIOD + ATR_PERIOD + 20;
        const candles2H = await fetchCandles(ccxtSymbol, timeframe, minRequiredCandles2H);
        if (!candles2H || candles2H.length < minRequiredCandles2H) { return null; }

        const market = exchange.markets[ccxtSymbol];
        const arayuzSymbol = market.symbol.toUpperCase().replace('/', '').replace(':USDT', '');
        
        const allCloses = extractCloses(candles2H); 
        const lastCandle = candles2H[candles2H.length - 1]; 
        const lastClosePrice = parseFloat(lastCandle[4]);

        // 1. Kırılım Seviyesi Tespiti
        const lookbackCandles = candles2H.slice(-(BRK2H_LOOKBACK_PERIOD + 1), -1); 
        let highestHigh = 0; let lowestLow = Infinity;
        for (const candle of lookbackCandles) { 
            const high = parseFloat(candle[2]); const low = parseFloat(candle[3]);
            if (high > highestHigh) highestHigh = high; 
            if (low < lowestLow) lowestLow = low; 
        }
        
        const triggerPriceLong = highestHigh * (1 + BRK2H_BUFFER_PERCENT / 100); 
        const triggerPriceShort = lowestLow * (1 - BRK2H_BUFFER_PERCENT / 100);

        let signal = 'WAIT';
        if (lastClosePrice > triggerPriceLong) { signal = 'BEKLEYEN LONG'; }
        else if (lastClosePrice < triggerPriceShort) { signal = 'BEKLEYEN SHORT'; }

        if (signal === 'WAIT') { return null; }


        // 2. Teyitçi Analizleri (Momentum, Hacim, Trend, BBW ve Duyarlılık)
        
        const rsi = calculateRSI(allCloses, RSI_PERIOD);
        if (rsi === null) return null;

        const volumeAnalysis = analyzeVolume(candles2H, candles2H.length - 1, 20); 
        const atr = calculateATR(candles2H, ATR_PERIOD);
        if (atr === null) return null;
        
        const bbwValue = calculateBBW(candles2H, BREAKOUT_BASE_BB_PERIOD);
        if (bbwValue === null) return null;
        
        const trendAnalysis = await getTrendDirection(ccxtSymbol);
        await new Promise(resolve => setTimeout(resolve, API_DELAY_MS)); 
        
        let confidence = 50; 
        let teyitReason = `${timeframe} Kırılımı Tespit Edildi.`;
        let isFiltered = false;
        let finalSignalDirection = signal.replace('BEKLEYEN ', '');

        // A. 4H Ana Trend Kontrolü (V24.0 SERT FİLTRE)
        if (trendAnalysis.status !== 'UNKNOWN') {
            if (finalSignalDirection === 'LONG' && trendAnalysis.status === 'BEARISH') {
                isFiltered = true; 
                teyitReason = `FİLTRELENDİ: 4H Ana Trend (${trendAnalysis.status}). Long sinyali trendin tersine.`;
            } else if (finalSignalDirection === 'SHORT' && trendAnalysis.status === 'BULLISH') {
                isFiltered = true; 
                teyitReason = `FİLTRELENDİ: 4H Ana Trend (${trendAnalysis.status}). Short sinyali trendin tersine.`;
            } else {
                 teyitReason += ` ✅ Trend Uyumlu: 4H (${trendAnalysis.status}).`;
                 confidence += 10;
            }
        }

        if (isFiltered) { return null; }
        
        // B. BBW Sıkışma Kontrolü (V24.0 ÜST EŞİK FİLTRESİ)
        if (bbwValue > BBW_MAX_PERCENT) {
            isFiltered = true;
            teyitReason = `FİLTRELENDİ: BBW (${bbwValue.toFixed(1)}%) çok geniş. Sinyale geç kalınmış. (Maks: ${BBW_MAX_PERCENT}%)`;
        } else {
            if (bbwValue < BBW_BOOST_MAX_PERCENT) {
                 confidence += 15;
                 teyitReason += ` 💡 Sıkışma Potansiyeli: BBW (${bbwValue.toFixed(1)}%) dar. Büyük hareket bekleniyor.`;
            } else {
                 teyitReason += ` 👍 BBW (${bbwValue.toFixed(1)}%) normal aralıkta.`;
            }
        }

        if (isFiltered) { return null; }
        
        // C. RSI Teyidi (Yumuşatılmış Momentum - SADECE GÜVENİ ETKİLER)
        if (finalSignalDirection === 'LONG' && rsi < BRK2H_RSI_LONG_THRESHOLD) {
            teyitReason += ` ⚠️ RSI Düşük: (${rsi.toFixed(1)}), Alım momentumu zayıf.`;
            confidence -= 15;
        } else if (finalSignalDirection === 'SHORT' && rsi > BRK2H_RSI_SHORT_THRESHOLD) {
            teyitReason += ` ⚠️ RSI Yüksek: (${rsi.toFixed(1)}), Satım momentumu zayıf.`;
            confidence -= 15;
        }
        
        // D. Hacim Teyidi (V35.0: YUMUŞATILDI)
        if (volumeAnalysis.ratio < BRK2H_VOLUME_MULTIPLIER) {
             // isFiltered = true; // Sinyali engelleme, sadece güveni düşür
             teyitReason += ` 👎 Hacim Yetersiz: (${volumeAnalysis.ratio.toFixed(1)}x) (Min: ${BRK2H_VOLUME_MULTIPLIER}x).`;
             confidence -= 25;
        } else {
            confidence += 25; teyitReason += ` 👍 Hacim Teyitli: ${volumeAnalysis.ratio.toFixed(1)}x Hacim patlaması.`;
        }
        
        // E. Duyarlılık Teyidi (BTC/Piyasa)
        if (globalSentiment.status !== 'UNKNOWN') {
            if (finalSignalDirection === 'LONG' && globalSentiment.status === 'BULLISH') {
                confidence += 25; teyitReason += ` 📰 Duyarlılık Onayı: Piyasa Boğa (${globalSentiment.value}).`;
            } else if (finalSignalDirection === 'SHORT' && globalSentiment.status === 'BEARISH') {
                confidence += 25; teyitReason += ` 📰 Duyarlılık Onayı: Piyasa Ayı (${globalSentiment.value}).`;
            } else if (globalSentiment.status !== 'NEUTRAL') {
                confidence -= 15; teyitReason += ` ⚠️ Ters Duyarlılık: Piyasa yönü (${globalSentiment.status}).`;
            }
        }
        
        // 3. Giriş Tüyo ve R/R Hesaplama
        
        const entryPrice = (signal === 'BEKLEYEN LONG') ? triggerPriceLong : triggerPriceShort;
        const tpSl = calculateTP_SL_ATR(entryPrice, atr, finalSignalDirection); 
        
        if (tpSl.RR === 'N/A' || parseFloat(tpSl.RR) < R_R_RATIO_MIN) { return null; } 

        if (!isManual) { signalCooldowns[cooldownKey] = { signalType: signal, timestamp: Date.now() }; }

        // 4. Eylem Odaklı Taktiksel Analiz
        const formattedEntryPrice = parseFloat(entryPrice.toFixed(4));
        const formattedSL = tpSl.SL !== '---' ? parseFloat(tpSl.SL).toFixed(4) : '---';
        const formattedTP = tpSl.TP !== '---' ? parseFloat(tpSl.TP).toFixed(4) : '---';
        const formattedRR = tpSl.RR;

        const bbwValueFixed = bbwValue.toFixed(2);
        const atrDistance = atr * BRK2H_SL_ATR_MULTIPLIER;
        
        const slRisk = Math.abs(entryPrice - parseFloat(formattedSL));
        const entryRiskPercentage = slRisk / entryPrice;
        let leverageRecommendation = '1x';
        
        if (entryRiskPercentage > 0) {
            // V35.0 FIX: Kaldıraç hesabını 2% portföy riskine göre ayarla
            let calculatedLeverage = 0.02 / entryRiskPercentage;
            calculatedLeverage = Math.min(calculatedLeverage, MAX_LEVERAGE_FACTOR);
            leverageRecommendation = Math.max(1, Math.floor(calculatedLeverage)) + 'x';
        }

        let tacticalAnalysis;
        if (signal === 'BEKLEYEN LONG') {
            tacticalAnalysis = `${teyitReason} | **TETİKLEME FİYATI: ${formattedEntryPrice}**. LONG emri girin. SL: ${formattedSL}, TP: ${formattedTP} (R/R: ${formattedRR}). Önerilen Kaldıraç: ${leverageRecommendation}.`;
        } else {
            tacticalAnalysis = `${teyitReason} | **TETİKLEME FİYATI: ${formattedEntryPrice}**. SHORT emri girin. SL: ${formattedSL}, TP: ${formattedTP} (R/R: ${formattedRR}). Önerilen Kaldıraç: ${leverageRecommendation}.`;
        }

        console.log(`\x1b[36m>>> V35.0 KIRILIM SİNYALİ (${arayuzSymbol}): ${signal} (Güven: ${confidence}%) ${tacticalAnalysis}\x1b[0m`);

        return {
            id: `${arayuzSymbol}-${STRATEGY_TYPE_BRK}-${Date.now()}`,
            timestamp: Date.now(),
            symbol: arayuzSymbol,
            signal: signal,
            strategyType: STRATEGY_TYPE_BRK,
            entryPrice: formattedEntryPrice,
            SL: formattedSL,
            TP: formattedTP,
            RR: formattedRR,
            confidence: Math.min(100, Math.max(0, confidence)),
            isFiltered: isFiltered,
            reason: teyitReason,
            bbWidth: bbwValueFixed, 
            volumeStatus: volumeAnalysis.ratio.toFixed(1) + 'x',
            tacticalAnalysis: tacticalAnalysis,
            initialSL: formattedSL, 
            atrDistance: atr * BRK2H_SL_ATR_MULTIPLIER, 
            breakevenMoved: false,
            leverage: leverageRecommendation 
        };
    } catch (e) {
        console.error(`[BRK2H KRİTİK HATA] ${ccxtSymbol}: ${e.message}`);
        return null;
    }
}


// --- Geri Dönüş Stratejisi KALDIRILDI ---
// analyzeReversalStrategy ve findPivots fonksiyonları V34.0'da kaldırılmıştır.


// --- Momentum Analizi (Aynı) ---
function analyzeMomentum(symbol, candles1M) { 
    if (!candles1M || candles1M.length < 15) return null;

    const currentCandle = candles1M[candles1M.length - 1];
    const currentClose = parseFloat(currentCandle[4]);
    const currentOpen = parseFloat(currentCandle[1]);
    const currentHigh = parseFloat(currentCandle[2]);
    const currentLow = parseFloat(currentCandle[3]);
    const currentVolume = parseFloat(currentCandle[5]);

    if (currentVolume === 0) return null; 

    const recentVolumes = candles1M.slice(-10, -1).map(c => parseFloat(c[5]));
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;

    const volumeRatio = currentVolume / avgVolume;

    const MIN_VOLUME_RATIO = 5.0; 
    const MIN_BODY_PERCENTAGE = 0.50; 

    if (volumeRatio >= MIN_VOLUME_RATIO) {
        const totalMovement = currentHigh - currentLow;
        const bodySize = Math.abs(currentClose - currentOpen);
        
        if (totalMovement > 0 && (bodySize / totalMovement) >= MIN_BODY_PERCENTAGE) {
            
            let signal = (currentClose > currentOpen) ? 'PUMP' : 'DUMP';
            let reason = `Hacim: ${volumeRatio.toFixed(1)}x. Güçlü ${signal === 'PUMP' ? 'YEŞİL' : 'KIRMIZI'} mum.`;

            return {
                id: `${symbol}-MOMENTUM-${Date.now()}`,
                timestamp: Date.now(),
                symbol: symbol,
                signal: signal,
                strategyType: 'MOMENTUM5M',
                entryPrice: currentClose.toFixed(4),
                reason: reason,
                tacticalAnalysis: `📈 **1M Hacim Patlaması:** Hacim ${volumeRatio.toFixed(1)}x. Anında giriş için hazır.`,
            };
        }
    }
    return null;
}

// --- Genel Döngüler ve Yönetim Fonksiyonları ---

async function runPreScan() { 
    try {
        const symbolsToFetch = availableSymbols.map(m => m.symbol);
        const tickers = await exchange.fetchTickers(symbolsToFetch);
        if (!tickers) { console.warn("[runPreScan] Ticker verisi alınamadı."); return; }

        let newTargetList = [];
        for (const market of availableSymbols) {
            const ticker = tickers[market.symbol];
            if (ticker && ticker.quoteVolume && ticker.quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT) {
                newTargetList.push(market.symbol); 
            }
        }
        newTargetList.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
        globalTargetSymbols = newTargetList;
        console.log(`[ÖN TARAMA] ${availableSymbols.length} coinden ${globalTargetSymbols.length} tanesi ${PRESCAN_MIN_24H_VOLUME_USDT} USDT filtreyi geçti ve taranacak.`);

    } catch (error) { console.error("[runPreScan HATA]:", error.message); }
}

async function scanSymbols() { 
    scanStatus = { isScanning: true, message: `Tarama başlatıldı. ${globalTargetSymbols.length} sembol kontrol ediliyor...` };
    io.emit('scan_status', scanStatus);
    
    await runSentimentAnalysis();
    
    const symbolsToScan = globalTargetSymbols;
    let scanCount = 0;

    for (const symbol of symbolsToScan) {
        scanCount++;
        scanStatus.message = `Taranıyor: ${symbol} (${scanCount}/${symbolsToScan.length}) - Duyarlılık: ${globalSentiment.status}`;
        io.emit('scan_status', scanStatus);
        
        try {
            const ccxtSymbol = symbol; 
            const candles2H = await fetchCandles(ccxtSymbol, TIMEFRAME_2H, 100); 
            const candles1M = await fetchCandles(ccxtSymbol, '1m', 15);
            
            await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));

            if (!candles2H || !candles1M) continue;

            const arayuzSymbol = ccxtSymbol.toUpperCase().replace('/', '').replace(':USDT', '');

            const breakoutSignal = await analyzeBreakoutStrategy(ccxtSymbol, false);
            if (breakoutSignal) { processNewSignal(breakoutSignal); }
            
            // Geri Dönüş Stratejisi Çağrısı KALDIRILDI
            
            const momentumSignal = analyzeMomentum(arayuzSymbol, candles1M);
            if (momentumSignal) { processNewSignal(momentumSignal); }

            await updateWatchlist(arayuzSymbol);

        } catch (error) { console.error(`Tarama hatası ${symbol}:`, error.message); }
    }

    cleanupWatchlist();

    scanStatus = { isScanning: false, message: `Tarama tamamlandı. ${Object.keys(allSignals).length} kurulum sinyali aktif. Duyarlılık: ${globalSentiment.status}` };
    io.emit('scan_status', scanStatus);
}

function processNewSignal(signal) { 
    const fullSymbol = signal.symbol.toUpperCase(); 

    if (signal.strategyType === 'MOMENTUM5M') {
        momentumSignals.unshift({ ...signal, symbol: fullSymbol });
        if (momentumSignals.length > 50) { momentumSignals.pop(); }
    } else {
        allSignals[fullSymbol] = { ...signal, symbol: fullSymbol }; 
    }
    
    if (watchlist[fullSymbol]) {
        const currentPrice = watchlist[fullSymbol].currentPrice || 'N/A';
        watchlist[fullSymbol] = { ...watchlist[fullSymbol], ...signal, currentPrice: currentPrice, timestamp: Date.now() };
    }
    io.emit('yeni_sinyal', signal);
}

async function updateWatchlist(arayuzSymbol) { 
    const fullSymbol = arayuzSymbol.toUpperCase();
    if (watchlist[fullSymbol]) {
        try {
            const market = availableSymbols.find(m => m.symbol.toUpperCase().includes(fullSymbol));
            if (!market) return;
            
            const candles1M = await fetchCandles(market.symbol, '1m', 2);
            await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));

            if (!candles1M || candles1M.length < 2) return;

            const currentPrice = parseFloat(candles1M[candles1M.length - 1][4]);
            
            const activeSignal = allSignals[fullSymbol];
            let updatedItem = { ...watchlist[fullSymbol] };

            if (activeSignal) {
                updatedItem = { 
                    ...activeSignal, 
                    currentPrice: currentPrice.toFixed(4), 
                    timestamp: Date.now() 
                };

                const signalDirection = updatedItem.signal.replace('BEKLEYEN ', '');
                const entry = parseFloat(updatedItem.entryPrice);
                const atrDist = updatedItem.atrDistance;
                const breakeven = parseFloat(updatedItem.entryPrice);

                if (atrDist && !updatedItem.breakevenMoved && !isNaN(entry) && !isNaN(currentPrice)) {
                    const isLongProfitable = signalDirection === 'LONG' && currentPrice >= (entry + atrDist);
                    const isShortProfitable = signalDirection === 'SHORT' && currentPrice <= (entry - atrDist);

                    if (parseFloat(updatedItem.SL) !== breakeven && (isLongProfitable || isShortProfitable)) {
                        updatedItem.SL = updatedItem.entryPrice; 
                        updatedItem.breakevenMoved = true;
                        updatedItem.tacticalAnalysis = `🚨 SL GÜNCELLENDİ: Riske girmeden kâr kilitlendi (Breakeven). TP'ye doğru ilerliyor!`;
                        console.log(`\x1b[32m[BREAKEVEN AKTİF]: ${fullSymbol} SL, Giriş Fiyatına Çekildi!\x1b[0m`);
                    }
                }
            } else {
                updatedItem = {
                    ...updatedItem,
                    signal: 'BEKLEMEDE', 
                    reason: 'Aktif kurulum bulunamadı. Takip ediliyor...', 
                    currentPrice: currentPrice.toFixed(4), 
                    timestamp: Date.now(), 
                    strategyType: 'WATCHLIST_WAIT'
                };
            }
            
            watchlist[fullSymbol] = updatedItem;
            io.emit('watchlist_update', watchlist);

        } catch (error) { 
            // console.error(`Watchlist güncelleme hatası ${fullSymbol}:`, error.message); 
        }
    }
}

function cleanupWatchlist() { 
    const now = Date.now();
    for (const symbol in watchlist) {
        if (watchlist[symbol].timestamp && now - watchlist[symbol].timestamp > WATCHLIST_MAX_AGE_MS) { delete watchlist[symbol]; }
    }
    io.emit('watchlist_update', watchlist);
}


async function loadSymbolsAndStartScan() { 
    try {
        console.log("Bitget marketleri yükleniyor...");
        const markets = await exchange.loadMarkets();
        availableSymbols = Object.values(markets).filter(m => m.active && m.swap && m.quote === 'USDT');
        
        console.log(`Toplam ${availableSymbols.length} aktif USDT-M SWAP sembolü yüklendi. Şimdi ön tarama yapılıyor...`);
        
        await runPreScan();
        
        await runSentimentAnalysis();
        
        scanSymbols(); 
        setInterval(scanSymbols, 5 * 60 * 1000); 

        setInterval(runPreScan, PRESCAN_INTERVAL);
        setInterval(runSentimentAnalysis, 30 * 60 * 1000);

    } catch (error) {
        console.error('\x1b[31m[KRİTİK HATA]: CCXT ile Bitget marketleri yüklenemedi.\x1b[0m');
        console.error(error.message);
        scanStatus.message = 'Hata: Marketler yüklenemedi. CCXT hatası.';
        io.emit('scan_status', scanStatus);
    }
}


// --- Express ve Socket.IO Rotaları ---

app.use(express.json());

app.post('/api/analyze-coin', async (req, res) => {
    const { symbol } = req.body;
    
    if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
        return res.status(400).json({ error: 'Geçerli bir sembol (örn: BTC) girmelisiniz.' });
    }
    
    const cleanSymbol = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();
    const market = availableSymbols.find(m => m.symbol.toUpperCase().includes(`${cleanSymbol}/USDT:USDT`));

    if (!market) { return res.status(400).json({ error: `Geçersiz sembol (${cleanSymbol}USDT) veya Bitget USDT-M SWAP marketi değil.` }); }
    
    try {
        const candles1M = await fetchCandles(market.symbol, '1m', 15);
        
        const arayuzSymbol = market.symbol.toUpperCase().replace('/', '').replace(':USDT', '');
        const currentPrice = (candles1M && candles1M.length > 0) ? parseFloat(candles1M[candles1M.length - 1][4]).toFixed(4) : '---';

        const breakoutSignal = await analyzeBreakoutStrategy(market.symbol, true);
        
        let result = breakoutSignal;
        
        if (result) {
            watchlist[arayuzSymbol] = { ...result, symbol: arayuzSymbol, currentPrice: currentPrice, timestamp: Date.now(), strategyType: result.strategyType };
            io.emit('watchlist_update', watchlist);
        } else {
             const trendInfo = await getTrendDirection(market.symbol);
             let reasonDetail = `4H Trend: ${trendInfo.status}. EMA200: ${trendInfo.ema}. Aktif kurulum yok.`;
             
             result = { id: `${arayuzSymbol}-MANUAL-${Date.now()}`, timestamp: Date.now(), symbol: arayuzSymbol, signal: 'BEKLEMEDE', strategyType: 'MANUAL', entryPrice: '---', tacticalAnalysis: reasonDetail, confidence: 0, reason: 'Aktif kurulum yok.', SL: '---', TP: '---', RR: 'N/A', bbWidth: '---', volumeStatus: 'N/A' };
             
             watchlist[arayuzSymbol] = { ...watchlist[arayuzSymbol] || {}, ...result, currentPrice: currentPrice, timestamp: Date.now(), strategyType: 'WATCHLIST_WAIT' };
             io.emit('watchlist_update', watchlist);
        }

        res.json(result);

    } catch (error) {
        console.error(`[/api/analyze-coin KRİTİK HATA] Manuel analiz hatası ${market.symbol}:`, error.message);
        res.status(500).json({ error: 'İç sunucu hatası: ' + error.message });
    }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'app.html')); });
app.post('/api/remove-watchlist', (req, res) => {
    const { symbol } = req.body;
    const upperSymbol = symbol.toUpperCase();
    
    if (watchlist[upperSymbol]) { delete watchlist[upperSymbol]; io.emit('watchlist_update', watchlist); res.json({ success: true, message: `${upperSymbol} takip listesinden kaldırıldı.` }); } else { res.status(404).json({ error: 'Sembol takip listesinde bulunamadı.' }); }
});

io.on('connection', (socket) => {
    console.log('Yeni kullanıcı bağlandı');
    socket.emit('initial_state', { signals: Object.values(allSignals).concat(momentumSignals), scanStatus: scanStatus });
    socket.emit('watchlist_update', watchlist);
});


server.listen(PORT, () => {
    console.log(`Sonny AI Trader (V34.0) http://localhost:${PORT} adresinde çalışıyor`);
    loadSymbolsAndStartScan();
});