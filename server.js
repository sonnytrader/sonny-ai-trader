const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- 2H Breakout Signal Engine başlatılıyor ---");

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// ==================== CONFIG ====================
const CONFIG = {
    PRESCAN_INTERVAL: 5 * 60 * 1000,
    PRESCAN_MIN_24H_VOLUME_USDT: 500000,
    WATCHLIST_SCAN_INTERVAL: 30 * 1000,
    API_DELAY_MS: 100,

    BREAKOUT_TIMEFRAME: '2h',
    LOOKBACK: 50,
    BREAKOUT_BUFFER: 0.001,          // %0.10
    MIN_VOLUME_RATIO: 1.20,
    ATR_PERIOD: 14,
    SL_ATR_MULTIPLIER: 2.0,
    MIN_RR: 1.5,
    RETEST_REQUIRED: true,
    OI_ENABLED: true,
    COMPRESSION_ENABLED: true,
    REGIME_FILTER_ENABLED: true,
    RSI_FILTER_ENABLED: false,       // RSI ana filtre değil, opsiyonel
    RSI_EXTREME_LONG: 80,            // LONG için aşırı alım
    RSI_EXTREME_SHORT: 20,           // SHORT için aşırı satım

    TARGET_SPACE_MIN_PERCENT: 1.0,   // Hedef en az %1 uzakta olmalı

    WATCH_DISTANCE_PERCENT: 0.5,     // Trigger'a %0.5 mesafede WATCH'a al
    RETEST_TIMEOUT_MS: 4 * 60 * 60 * 1000, // 4 saat içinde retest olmazsa expire
    SIGNAL_COOLDOWN_MS: 0,           // Artık state machine ile yönetiliyor

    COMPRESSION_LOOKBACK: 20,
    COMPRESSION_ATR_RATIO_MAX: 0.85  // ATR daralması eşiği
};

// ==================== DEBUG ====================
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    analyzed: 0,
    noData: 0,
    noLevel: 0,
    tooFarFromLevel: 0,
    falseBreakout: 0,
    lowVolume: 0,
    oiNotSupportive: 0,
    compressionMissing: 0,
    targetTooClose: 0,
    rrTooLow: 0,
    duplicate: 0,
    watchCreated: 0,
    breakoutConfirmed: 0,
    retestPending: 0,
    retestConfirmed: 0,
    signalEmitted: 0,
    rejectionReasons: {}
};

function resetDebug() {
    Object.keys(DEBUG).forEach(k => {
        if (typeof DEBUG[k] === 'number') DEBUG[k] = 0;
        else if (typeof DEBUG[k] === 'object') DEBUG[k] = {};
    });
}

function logRejection(symbol, reason) {
    if (!DEBUG.rejectionReasons[reason]) DEBUG.rejectionReasons[reason] = [];
    DEBUG.rejectionReasons[reason].push(symbol);
}

function printDebugReport() {
    console.log('\n========== 📊 2H BREAKOUT ENGINE RAPORU ==========');
    console.log('Ticker:', DEBUG.totalTickers, '| Hacim Filtresi Geçen:', DEBUG.volumeFiltered, '| Analiz Edilen:', DEBUG.analyzed);
    console.log('--- ELENME NEDENLERİ ---');
    for (const [reason, symbols] of Object.entries(DEBUG.rejectionReasons)) {
        console.log(`${reason}: ${symbols.length} (${symbols.slice(0,5).join(', ')}${symbols.length > 5 ? '...' : ''})`);
    }
    console.log('--- DURUM GEÇİŞLERİ ---');
    console.log('WATCH oluşturuldu:', DEBUG.watchCreated);
    console.log('Breakout onaylandı:', DEBUG.breakoutConfirmed);
    console.log('Retest bekleniyor:', DEBUG.retestPending);
    console.log('Retest onaylandı:', DEBUG.retestConfirmed);
    console.log('Sinyal yayınlandı:', DEBUG.signalEmitted);
    console.log('====================================================\n');
}

// ==================== EXCHANGE ====================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 200,
    options: { defaultType: 'swap' }
});

// ==================== GLOBAL STATE ====================
global.APP_STATE = {
    signals: [],          // Üretilen sinyaller (eski sinyaller tutulur, frontend için)
    scanStatus: { message: 'Başlatılıyor...', isScanning: false }
};

let globalTargetList = [];      // Hacim filtresinden geçen semboller
let globalWatchlist = {};       // Kullanıcı watchlist (manuel analiz için)
let setups = [];                // 2H Breakout setup'ları (state machine)

const oiHistory = new Map();    // OI geçmişi

// ==================== İNDİKATÖRLER ====================
function calculateSMA(data, period) {
    if (!data || data.length < period) return null;
    const relevant = data.slice(-period).filter(v => typeof v === 'number' && !isNaN(v));
    if (relevant.length < period) return null;
    return relevant.reduce((a, b) => a + b, 0) / period;
}

function calculateEMA(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = calculateSMA(values.slice(0, period), period);
    if (ema === null) return null;
    for (let i = period; i < values.length; i++) {
        if (typeof values[i] !== 'number' || isNaN(values[i])) return null;
        ema = (values[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    let gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (typeof diff !== 'number' || isNaN(diff)) return null;
        gains.push(diff >= 0 ? diff : 0);
        losses.push(diff < 0 ? -diff : 0);
    }
    if (gains.length < period) return null;
    let avgGain = gains.slice(0, period).reduce((a,b)=>a+b,0) / period;
    let avgLoss = losses.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period-1) + gains[i]) / period;
        avgLoss = (avgLoss * (period-1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2], low = ohlcv[i][3], prevClose = ohlcv[i-1][4];
        if ([high, low, prevClose].some(v => typeof v !== 'number' || isNaN(v))) continue;
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trueRanges.length < period) return null;
    return calculateSMA(trueRanges, period);
}

function calculateBollingerBands(closes, period = 20, stdDevMultiplier = 2) {
    if (!closes || closes.length < period) return null;
    const middle = calculateSMA(closes, period);
    if (middle === null) return null;
    const relevant = closes.slice(-period);
    const mean = calculateSMA(relevant, period);
    const variance = relevant.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        upper: middle + stdDev * stdDevMultiplier,
        middle,
        lower: middle - stdDev * stdDevMultiplier,
        width: (stdDev * 2 * stdDevMultiplier) / middle * 100
    };
}

function calculateFibonacciExtension(ohlcv, period, signal) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevant = ohlcv.slice(-period);
    const lows = relevant.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v));
    const highs = relevant.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v));
    if (!lows.length || !highs.length) return null;
    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    if (highest <= lowest) return null;
    const range = highest - lowest;
    if (signal === 'LONG') return highest + range * 0.618;
    if (signal === 'SHORT') return lowest - range * 0.618;
    return null;
}

// ==================== PİYASA DURUMU (4H REJİM) ====================
async function checkMarketCondition(ccxtSymbol) {
    const requiredCandles = 250; // EMA200 + tampon
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, '4h', undefined, requiredCandles);
        if (!ohlcv || ohlcv.length < 200) return { overallTrend: 'UNKNOWN' };
        const closes = ohlcv.map(c => c[4]);
        const ema200 = calculateEMA(closes, 200);
        if (ema200 === null) return { overallTrend: 'UNKNOWN' };
        const lastClose = closes[closes.length - 1];
        if (lastClose > ema200) return { overallTrend: 'UPTREND' };
        else if (lastClose < ema200) return { overallTrend: 'DOWNTREND' };
        else return { overallTrend: 'SIDEWAYS' };
    } catch (e) {
        console.error(`[checkMarketCondition HATA] ${ccxtSymbol}: ${e.message}`);
        return { overallTrend: 'UNKNOWN' };
    }
}

// ==================== OI (AÇIK POZİSYON) ====================
async function getOpenInterest(symbol) {
    try {
        const result = await exchange.fetchOpenInterest(symbol);
        const value = Number(result?.openInterestAmount || result?.openInterest || 0);
        if (Number.isFinite(value) && value > 0) return value;
    } catch (e) {
        // fallback API
    }
    try {
        const marketSymbol = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${marketSymbol}&productType=usdt-futures`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return 0;
        const data = await response.json();
        const value = Number(data?.data?.openInterestList?.[0]?.size || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (e) {
        return 0;
    }
}

function updateOIHistory(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const now = Date.now();
    const history = oiHistory.get(symbol) || [];
    history.push({ value, timestamp: now });
    const retained = history.filter(item => now - item.timestamp <= 5 * 60 * 1000);
    oiHistory.set(symbol, retained);
    const reference = retained.find(item => now - item.timestamp >= 3 * 60 * 1000);
    if (!reference?.value) return 0;
    return Number((((value - reference.value) / reference.value) * 100).toFixed(2));
}

function cleanOIHistory() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [symbol, history] of oiHistory.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);
        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

// ==================== COMPRESSION (SIKIŞMA) ====================
function calculateCompressionRatio(ohlcv, lookback = CONFIG.COMPRESSION_LOOKBACK) {
    if (ohlcv.length < lookback + CONFIG.ATR_PERIOD + 10) return null;
    const recent = ohlcv.slice(-lookback);
    const older = ohlcv.slice(-lookback * 2, -lookback);
    const recentATR = calculateATR(recent, CONFIG.ATR_PERIOD);
    const olderATR = calculateATR(older, CONFIG.ATR_PERIOD);
    if (!recentATR || !olderATR || olderATR <= 0) return null;
    return recentATR / olderATR;
}

// ==================== 2H BREAKOUT SETUP ====================
let setupIdCounter = 0;

function createSetupObject(symbol, direction, data) {
    const id = `${symbol}:${direction}:${++setupIdCounter}`;
    const trigger = data.trigger;
    const stop = data.stop;
    const risk = Math.abs(trigger - stop);
    const tp1 = direction === 'LONG' ? trigger + risk * CONFIG.MIN_RR : trigger - risk * CONFIG.MIN_RR;
    const tp2 = direction === 'LONG' ? trigger + risk * (CONFIG.MIN_RR * 2) : trigger - risk * (CONFIG.MIN_RR * 2);

    return {
        id,
        symbol,
        direction,
        state: 'WATCH',
        currentPrice: data.currentPrice,
        trigger,
        stop,
        tp1,
        tp2,
        rr: CONFIG.MIN_RR,
        score: data.score,
        breakoutLevel: data.breakoutLevel,
        volumeRatio: data.volumeRatio,
        oiStatus: data.oiStatus,
        retestStatus: null,
        regime: data.regime,
        compressionRatio: data.compressionRatio,
        reason: data.reason,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000, // 12 saat WATCH TTL
        breakoutConfirmedAt: null,
        retestPendingSince: null,
        retestConfirmedAt: null,
        invalidReason: null,
        finishedAt: null
    };
}

function getSetupById(id) {
    return setups.find(s => s.id === id);
}

function removeSetup(id) {
    setups = setups.filter(s => s.id !== id);
}

// ==================== 2H TARAMA ANA FONKSİYONU ====================
async function analyze2HBreakout(ccxtSymbol, isManual = false, isWatchlist = false) {
    DEBUG.analyzed++;
    const symbol = ccxtSymbol;
    try {
        // 1. Veri çek (son 60 tamamlanmış 2H mumu, kapanmış)
        const limit = CONFIG.LOOKBACK + 10;
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, CONFIG.BREAKOUT_TIMEFRAME, undefined, limit);
        if (!ohlcv || ohlcv.length < CONFIG.LOOKBACK + 1) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        // Son mum kapanmamış olabilir, onu hariç tut
        const closedCandles = ohlcv.slice(0, -1);
        if (closedCandles.length < CONFIG.LOOKBACK) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        const lookback = closedCandles.slice(-CONFIG.LOOKBACK);
        const resistance = Math.max(...lookback.map(c => c[2]));
        const support = Math.min(...lookback.map(c => c[3]));
        if (resistance <= support) {
            logRejection(symbol, 'NO_IMPORTANT_LEVEL');
            DEBUG.noLevel++;
            return null;
        }

        const longTrigger = resistance * (1 + CONFIG.BREAKOUT_BUFFER);
        const shortTrigger = support * (1 - CONFIG.BREAKOUT_BUFFER);

        // Güncel fiyat (son kapanmış mumun kapanışı)
        const currentPrice = closedCandles[closedCandles.length - 1][4];
        if (typeof currentPrice !== 'number' || isNaN(currentPrice)) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        // Piyasa rejimi
        let regime = 'UNKNOWN';
        if (CONFIG.REGIME_FILTER_ENABLED) {
            const market = await checkMarketCondition(ccxtSymbol);
            regime = market.overallTrend;
        }

        // Sinyal yönü adayları (fiyat hangi seviyeye yakın?)
        const longDistancePct = ((longTrigger - currentPrice) / currentPrice) * 100;
        const shortDistancePct = ((currentPrice - shortTrigger) / currentPrice) * 100;

        let direction = null;
        let trigger = null;
        let breakoutLevel = null;
        let distancePct = null;

        if (longDistancePct >= 0 && longDistancePct <= CONFIG.WATCH_DISTANCE_PERCENT) {
            direction = 'LONG';
            trigger = longTrigger;
            breakoutLevel = resistance;
            distancePct = longDistancePct;
        } else if (shortDistancePct >= 0 && shortDistancePct <= CONFIG.WATCH_DISTANCE_PERCENT) {
            direction = 'SHORT';
            trigger = shortTrigger;
            breakoutLevel = support;
            distancePct = shortDistancePct;
        }

        if (!direction) {
            logRejection(symbol, 'TOO_FAR_FROM_LEVEL');
            DEBUG.tooFarFromLevel++;
            return null;
        }

        // ATR hesapla
        const atr = calculateATR(closedCandles, CONFIG.ATR_PERIOD);
        if (!atr || atr <= 0) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        // Stop loss
        let stop;
        if (direction === 'LONG') {
            stop = support - atr * CONFIG.SL_ATR_MULTIPLIER;
        } else {
            stop = resistance + atr * CONFIG.SL_ATR_MULTIPLIER;
        }

        // Hacim oranı (son kapanmış mum hacmi / ortalama hacim)
        const lastVolume = closedCandles[closedCandles.length - 1][5];
        const avgVolume = lookback.reduce((sum, c) => sum + c[5], 0) / CONFIG.LOOKBACK;
        const volumeRatio = lastVolume / avgVolume;

        // OI değişimi
        let oiChangePct = 0;
        let oiStatus = 'NOT_AVAILABLE';
        if (CONFIG.OI_ENABLED) {
            const oi = await getOpenInterest(ccxtSymbol);
            if (oi > 0) {
                oiChangePct = updateOIHistory(ccxtSymbol, oi);
                if (direction === 'LONG' && oiChangePct > 0.1) oiStatus = 'SUPPORTIVE';
                else if (direction === 'SHORT' && oiChangePct < -0.1) oiStatus = 'SUPPORTIVE';
                else if (oiChangePct > 0.05 || oiChangePct < -0.05) oiStatus = 'NEUTRAL';
                else oiStatus = 'NOT_SUPPORTIVE';
            }
        }

        // Compression
        let compressionRatio = null;
        if (CONFIG.COMPRESSION_ENABLED) {
            compressionRatio = calculateCompressionRatio(closedCandles);
        }

        // Score hesapla
        let score = 50; // Başlangıç
        if (volumeRatio >= 2.0) score += 15;
        else if (volumeRatio >= 1.5) score += 10;
        else if (volumeRatio >= CONFIG.MIN_VOLUME_RATIO) score += 5;
        else score -= 15;

        if (compressionRatio !== null && compressionRatio < CONFIG.COMPRESSION_ATR_RATIO_MAX) {
            score += 10; // Sıkışma var
        } else if (compressionRatio !== null) {
            score -= 5;
        }

        if (oiStatus === 'SUPPORTIVE') score += 10;
        else if (oiStatus === 'NOT_SUPPORTIVE') score -= 10;

        if (regime === 'UPTREND' && direction === 'LONG') score += 10;
        else if (regime === 'DOWNTREND' && direction === 'SHORT') score += 10;
        else if (regime !== 'UNKNOWN') score -= 5; // Ters trend

        // RSI aşırı uç kontrolü (opsiyonel filtre)
        if (CONFIG.RSI_FILTER_ENABLED) {
            const closes = closedCandles.map(c => c[4]);
            const rsi = calculateRSI(closes, 14);
            if (rsi !== null) {
                if (direction === 'LONG' && rsi > CONFIG.RSI_EXTREME_LONG) score -= 10;
                if (direction === 'SHORT' && rsi < CONFIG.RSI_EXTREME_SHORT) score -= 10;
            }
        }

        score = Math.max(0, Math.min(100, score));

        // Target space ve R/R kontrolü
        const risk = Math.abs(trigger - stop);
        const tp1 = direction === 'LONG' ? trigger + risk * CONFIG.MIN_RR : trigger - risk * CONFIG.MIN_RR;
        const targetDistancePct = Math.abs(tp1 - trigger) / trigger * 100;
        if (targetDistancePct < CONFIG.TARGET_SPACE_MIN_PERCENT) {
            logRejection(symbol, 'TARGET_TOO_CLOSE');
            DEBUG.targetTooClose++;
            return null;
        }
        const rr = CONFIG.MIN_RR;
        if (rr < CONFIG.MIN_RR) { // Aslında her zaman eşit olacak, ama kontrol
            logRejection(symbol, 'RR_TOO_LOW');
            DEBUG.rrTooLow++;
            return null;
        }

        // Setup oluştur
        const setup = createSetupObject(ccxtSymbol, direction, {
            currentPrice,
            trigger,
            stop,
            breakoutLevel,
            volumeRatio,
            oiStatus,
            regime,
            compressionRatio,
            score,
            reason: `${direction} breakout watch - R:${resistance.toFixed(4)} S:${support.toFixed(4)}`
        });

        // Duplicate kontrolü: Aynı sembol için zaten aktif bir setup var mı?
        const existing = setups.find(s => s.symbol === ccxtSymbol && s.direction === direction && (s.state === 'WATCH' || s.state === 'BREAKOUT_CONFIRMED' || s.state === 'RETEST_PENDING' || s.state === 'RETEST_CONFIRMED'));
        if (existing) {
            // Mevcut setup'ı güncelle (fiyat, skor vs.)
            Object.assign(existing, {
                currentPrice: setup.currentPrice,
                trigger: setup.trigger,
                stop: setup.stop,
                tp1: setup.tp1,
                tp2: setup.tp2,
                score: setup.score,
                volumeRatio: setup.volumeRatio,
                oiStatus: setup.oiStatus,
                regime: setup.regime,
                compressionRatio: setup.compressionRatio,
                reason: setup.reason,
                updatedAt: Date.now(),
                expiresAt: Date.now() + 12 * 60 * 60 * 1000
            });
            DEBUG.duplicate++;
            if (!isManual && !isWatchlist) {
                // Yeni setup eklenmedi, ama güncellendi
            }
            return null;
        }

        // Yeni setup ekle
        setups.push(setup);
        DEBUG.watchCreated++;
        logRejection(symbol, 'WATCH_CREATED'); // Debug için not düş

        if (isManual || isWatchlist) {
            return setup;
        }
        // Otomatik taramada sinyal üretmeyiz, sadece WATCH aşamasına alırız.
        return null;
    } catch (error) {
        console.error(`[analyze2HBreakout HATA] ${ccxtSymbol}: ${error.message}`);
        logRejection(symbol, 'INTERNAL_ERROR');
        return null;
    }
}

// ==================== CANLI FİYAT İZLEME ve STATE MACHINE İLERLETME ====================
async function updateLivePricesAndStates() {
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const setup of setups) {
            if (setup.state === 'SIGNAL_READY' || setup.state === 'CANCELED' || setup.state === 'EXPIRED' || setup.state === 'BREAKOUT_INVALID') continue;

            const ticker = tickers[setup.symbol];
            if (!ticker || !ticker.last) continue;
            const price = Number(ticker.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;

            switch (setup.state) {
                case 'WATCH':
                    // Breakout kontrolü: Kapanış fiyatı değil, canlı fiyat trigger'ı geçti mi?
                    // Talimata göre sadece kapanmış mumun kapanışı kullanılmalı.
                    // Bu nedenle burada canlı fiyat ile breakout kararı vermeyiz.
                    // Bunun yerine, yeni bir 2H mumu kapandığında kontrol yapılır.
                    // Ancak canlı fiyat aşırı ters giderse setup iptal edilebilir.
                    if (setup.direction === 'LONG' && price < setup.breakoutLevel - setup.atr * 0.5) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Ters yöne güçlü hareket';
                        setup.finishedAt = now;
                        changed = true;
                    } else if (setup.direction === 'SHORT' && price > setup.breakoutLevel + setup.atr * 0.5) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Ters yöne güçlü hareket';
                        setup.finishedAt = now;
                        changed = true;
                    }
                    // Ayrıca uzaklaştıysa iptal et
                    if (setup.direction === 'LONG' && setup.trigger > 0 && (setup.trigger - price) / price * 100 > CONFIG.WATCH_DISTANCE_PERCENT * 2) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = now;
                        changed = true;
                    }
                    if (setup.direction === 'SHORT' && setup.trigger > 0 && (price - setup.trigger) / price * 100 > CONFIG.WATCH_DISTANCE_PERCENT * 2) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = now;
                        changed = true;
                    }
                    break;

                case 'BREAKOUT_CONFIRMED':
                    // Retest bekleme aşaması
                    if (setup.retestPendingSince === null) {
                        // İlk kez bu durumda, retest başlangıç zamanını işaretle
                        setup.retestPendingSince = now;
                    }
                    // Retest kontrolü: Fiyat eski kırılan seviyeye geri döndü mü?
                    if (setup.direction === 'LONG') {
                        // Fiyat eski dirence (breakoutLevel) kadar geri çekildi ve orada tutundu mu?
                        if (price <= setup.breakoutLevel && price >= setup.breakoutLevel - setup.atr * 0.3) {
                            // Retest başarılı say
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = now;
                            setup.retestStatus = 'CONFIRMED';
                            changed = true;
                            DEBUG.retestConfirmed++;
                            // Sinyal üret (aşağıda ortak fonksiyon ile)
                            emitSignal(setup);
                        } else if (price < setup.breakoutLevel - setup.atr * 0.5) {
                            // Retest başarısız, range içine girdi
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = now;
                            changed = true;
                        }
                    } else { // SHORT
                        if (price >= setup.breakoutLevel && price <= setup.breakoutLevel + setup.atr * 0.3) {
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = now;
                            setup.retestStatus = 'CONFIRMED';
                            changed = true;
                            DEBUG.retestConfirmed++;
                            emitSignal(setup);
                        } else if (price > setup.breakoutLevel + setup.atr * 0.5) {
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = now;
                            changed = true;
                        }
                    }
                    // Zaman aşımı kontrolü
                    if (now - setup.retestPendingSince > CONFIG.RETEST_TIMEOUT_MS) {
                        setup.state = 'EXPIRED';
                        setup.invalidReason = 'Retest zaman aşımı';
                        setup.finishedAt = now;
                        changed = true;
                    }
                    break;
            }
        }

        // Temizlik
        cleanOldSetups();

        if (changed) {
            broadcastSignals();
        }
    } catch (error) {
        console.error('Canlı fiyat güncelleme hatası:', error.message);
    }
}

function cleanOldSetups() {
    const now = Date.now();
    setups = setups.filter(setup => {
        if (setup.state === 'CANCELED' || setup.state === 'EXPIRED' || setup.state === 'BREAKOUT_INVALID') {
            return now - setup.finishedAt < 2 * 60 * 60 * 1000; // 2 saat tut
        }
        if (setup.state === 'SIGNAL_READY') {
            return now - setup.retestConfirmedAt < 6 * 60 * 60 * 1000; // 6 saat tut
        }
        return true;
    });
}

function emitSignal(setup) {
    const signalData = {
        symbol: setup.symbol,
        timeframe: CONFIG.BREAKOUT_TIMEFRAME,
        direction: setup.direction,
        signalType: '2H_BREAKOUT',
        entry: setup.trigger,
        stop: setup.stop,
        tp1: setup.tp1,
        tp2: setup.tp2,
        rr: setup.rr,
        score: setup.score,
        breakoutLevel: setup.breakoutLevel,
        volumeRatio: setup.volumeRatio,
        oiStatus: setup.oiStatus,
        retestStatus: setup.retestStatus,
        regime: setup.regime,
        timestamp: Date.now()
    };

    // Frontend'e ekle ve yayınla
    global.APP_STATE.signals.unshift(signalData);
    io.emit('yeni_sinyal', signalData);
    DEBUG.signalEmitted++;
    setup.state = 'SIGNAL_READY';
    console.log(`\x1b[32m>>> 2H BREAKOUT SİNYALİ: ${setup.symbol} ${setup.direction} @ ${setup.trigger.toFixed(4)} (Skor: ${setup.score})\x1b[0m`);
}

// ==================== 2H BREAKOUT TARAMA DÖNGÜSÜ ====================
async function run2HBreakoutScan() {
    if (globalTargetList.length === 0) return;
    console.log(`\n--- 2H BREAKOUT TARAMA BAŞLADI (${globalTargetList.length} hedef) ---`);
    global.APP_STATE.scanStatus = { message: '2H Breakout taraması çalışıyor...', isScanning: true };
    io.emit('scan_status', global.APP_STATE.scanStatus);

    for (const symbol of globalTargetList) {
        try {
            await analyze2HBreakout(symbol, false, false);
            await new Promise(resolve => setTimeout(resolve, CONFIG.API_DELAY_MS / 2));
        } catch (e) {
            console.error(`Tarama hatası ${symbol}:`, e.message);
        }
    }

    global.APP_STATE.scanStatus = { message: `Tarama tamamlandı. ${setups.length} aktif setup.`, isScanning: false };
    io.emit('scan_status', global.APP_STATE.scanStatus);
    printDebugReport();
    resetDebug();
}

// ==================== ÖN TARAMA (HACİM FİLTRESİ) ====================
async function runPreScan() {
    console.log(`\n--- ÖN TARAMA BAŞLADI (${new Date().toLocaleTimeString()}) ---`);
    try {
        if (!exchange.markets || Object.keys(exchange.markets).length === 0) {
            await exchange.loadMarkets(true);
        }
        const tickers = await exchange.fetchTickers(undefined, { 'type': 'swap' });
        if (!tickers) {
            console.warn('Ön tarama ticker alınamadı');
            return;
        }
        const filtered = [];
        for (const ticker of Object.values(tickers)) {
            if (!ticker || !ticker.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
            const market = exchange.markets[ticker.symbol];
            if (market && market.active && market.swap && market.quote === 'USDT' && ticker.quoteVolume >= CONFIG.PRESCAN_MIN_24H_VOLUME_USDT) {
                filtered.push(ticker.symbol);
            }
        }
        globalTargetList = filtered;
        DEBUG.totalTickers = Object.keys(tickers).length;
        DEBUG.volumeFiltered = filtered.length;
        console.log(`Ön tarama tamamlandı: ${filtered.length} coin hedefte.`);
    } catch (e) {
        console.error('Ön tarama hatası:', e.message);
    }
}

// ==================== MANUEL ANALİZ ====================
async function manualAnalyzeSymbol(ccxtSymbol) {
    try {
        const setup = await analyze2HBreakout(ccxtSymbol, true, true);
        if (setup) {
            // Manuel analizde doğrudan watchlist'e ekle
            globalWatchlist[ccxtSymbol] = setup;
            io.emit('watchlist_update', globalWatchlist);
        }
        return setup;
    } catch (e) {
        console.error('Manuel analiz hatası:', e.message);
        return null;
    }
}

// ==================== EXPRESS ROTALARI ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app.html'));
});

app.get('/api/setups', (req, res) => {
    res.json({ success: true, setups, scanning: global.APP_STATE.scanStatus.isScanning });
});

app.get('/api/debug', (req, res) => {
    res.json({ success: true, debug: DEBUG, rejectionReasons: DEBUG.rejectionReasons });
});

app.post('/api/analyze-coin', async (req, res) => {
    const userSymbolInput = req.body.symbol;
    if (!userSymbolInput) return res.status(400).json({ error: 'Sembol eksik.' });
    const cleanBaseSymbol = userSymbolInput.toUpperCase().replace(/[\/:USDT PERP]/g, '').trim();
    const fullSymbol = cleanBaseSymbol + 'USDT';
    try {
        if (!exchange.markets) await exchange.loadMarkets(true);
        const foundMarket = Object.values(exchange.markets).find(m => m.active && m.swap && m.quote === 'USDT' && m.base === cleanBaseSymbol);
        if (!foundMarket) return res.status(404).json({ error: `'${cleanBaseSymbol}' marketi bulunamadı.` });
        const setup = await manualAnalyzeSymbol(foundMarket.symbol);
        if (setup) {
            res.json({ success: true, setup });
        } else {
            res.json({ success: false, message: 'Uygun 2H breakout setup bulunamadı.' });
        }
    } catch (err) {
        res.status(500).json({ error: `Sunucu hatası: ${err.message}` });
    }
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('İstemci bağlandı:', socket.id);
    socket.emit('initial_state', {
        signals: global.APP_STATE.signals,
        scanStatus: global.APP_STATE.scanStatus,
        setups
    });
    socket.emit('watchlist_update', globalWatchlist);
    socket.on('disconnect', () => {
        console.log('İstemci ayrıldı:', socket.id);
    });
});

function broadcastSignals() {
    io.emit('setups_update', setups);
}

// ==================== SUNUCU BAŞLATMA ====================
server.listen(PORT, async () => {
    console.log(`2H Breakout Signal Engine başlatıldı - Port: ${PORT}`);
    try {
        await exchange.loadMarkets(true);
        console.log('Marketler yüklendi.');
        await runPreScan();
        // İlk tarama
        if (globalTargetList.length > 0) {
            await run2HBreakoutScan();
        }
        // Periyodik görevler
        setInterval(runPreScan, CONFIG.PRESCAN_INTERVAL);
        setInterval(run2HBreakoutScan, 5 * 60 * 1000); // 5 dakikada bir 2H tarama
        setInterval(updateLivePricesAndStates, 3000);   // 3 saniyede bir canlı fiyat ve state kontrol
        setInterval(cleanOIHistory, 10 * 60 * 1000);
        console.log('Döngüler başlatıldı.');
    } catch (error) {
        console.error('Başlangıç hatası:', error);
    }
});
