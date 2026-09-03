const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");

console.log("--- 2H Breakout Signal Engine (Kesin Sürüm) başlatılıyor ---");

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// ==================== KONFİGÜRASYON ====================
const CONFIG = {
    // Genel
    PRESCAN_INTERVAL: 5 * 60 * 1000,          // Ön tarama periyodu
    PRESCAN_MIN_24H_VOLUME_USDT: 500000,      // Hacim filtresi
    API_DELAY_MS: 100,

    // 2H Breakout
    BREAKOUT_TIMEFRAME: '2h',
    LOOKBACK: 50,                             // 50 tamamlanmış mum
    BREAKOUT_BUFFER: 0.001,                   // %0.10
    MIN_VOLUME_RATIO: 1.20,                   // Hacim oranı
    ATR_PERIOD: 14,
    SL_ATR_MULTIPLIER: 2.0,
    MIN_RR: 1.5,                              // Minimum R/R
    RETEST_REQUIRED: true,                    // Retest zorunlu
    OI_ENABLED: true,
    COMPRESSION_ENABLED: true,
    REGIME_FILTER_ENABLED: true,

    // İsteğe bağlı RSI filtresi (varsayılan kapalı)
    RSI_FILTER_ENABLED: false,
    RSI_EXTREME_LONG: 80,
    RSI_EXTREME_SHORT: 20,

    // Hedef alanı
    TARGET_SPACE_MIN_PERCENT: 1.0,           // TP1 en az %1 uzakta olmalı
    FIB_LEVEL_1: 0.618,                      // TP1 için fib seviyesi
    FIB_LEVEL_2: 1.618,                      // TP2 için fib seviyesi

    // WATCH
    WATCH_DISTANCE_PERCENT: 0.5,              // Trigger'a %0.5 mesafede WATCH

    // Retest
    RETEST_TOLERANCE_ATR_MULT: 0.3,          // Seviyeye ne kadar yakın sayılır
    RETEST_TIMEOUT_MS: 4 * 60 * 60 * 1000,   // 4 saat içinde retest olmazsa expire

    // Temizlik
    WATCH_TTL_MS: 12 * 60 * 60 * 1000,       // 12 saat WATCH'ta kalabilir
    SIGNAL_RETENTION_MS: 6 * 60 * 60 * 1000, // Sinyal 6 saat saklanır
    CANCELED_RETENTION_MS: 2 * 60 * 60 * 1000,
};

// ==================== DEBUG ====================
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    analyzed: 0,
    noData: 0,
    noLevel: 0,
    tooFarFromLevel: 0,
    alreadyBroken: 0,
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
    const keys = Object.keys(DEBUG);
    keys.forEach(k => {
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
    console.log(`Ticker: ${DEBUG.totalTickers} | Hacim Filtresi: ${DEBUG.volumeFiltered} | Analiz: ${DEBUG.analyzed}`);
    console.log('--- ELENME NEDENLERİ ---');
    for (const [reason, symbols] of Object.entries(DEBUG.rejectionReasons)) {
        console.log(`${reason}: ${symbols.length} adet (${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? '...' : ''})`);
    }
    console.log('--- DURUM GEÇİŞLERİ ---');
    console.log(`WATCH oluşturuldu: ${DEBUG.watchCreated}`);
    console.log(`Breakout onaylandı: ${DEBUG.breakoutConfirmed}`);
    console.log(`Retest bekleniyor: ${DEBUG.retestPending}`);
    console.log(`Retest onaylandı: ${DEBUG.retestConfirmed}`);
    console.log(`Sinyal yayınlandı: ${DEBUG.signalEmitted}`);
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
    signals: [],
    scanStatus: { message: 'Başlatılıyor...', isScanning: false }
};

let globalTargetList = [];
let globalWatchlist = {};
let setups = [];
const oiHistory = new Map();

// Her setup için son işlenen mum timestamp'i
// setup.lastProcessedCandleTimestamp alanıyla takip edilecek

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
        const diff = closes[i] - closes[i - 1];
        if (typeof diff !== 'number' || isNaN(diff)) return null;
        gains.push(diff >= 0 ? diff : 0);
        losses.push(diff < 0 ? -diff : 0);
    }
    if (gains.length < period) return null;
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2], low = ohlcv[i][3], prevClose = ohlcv[i - 1][4];
        if ([high, low, prevClose].some(v => typeof v !== 'number' || isNaN(v))) continue;
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trueRanges.length < period) return null;
    return calculateSMA(trueRanges, period);
}

function calculateFibonacciExtension(ohlcv, period, direction) {
    if (!ohlcv || ohlcv.length < period) return null;
    const relevant = ohlcv.slice(-period);
    const lows = relevant.map(c => c[3]).filter(v => typeof v === 'number' && !isNaN(v));
    const highs = relevant.map(c => c[2]).filter(v => typeof v === 'number' && !isNaN(v));
    if (!lows.length || !highs.length) return null;
    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    if (highest <= lowest) return null;
    const range = highest - lowest;
    if (direction === 'LONG') return highest + range * CONFIG.FIB_LEVEL_1;
    if (direction === 'SHORT') return lowest - range * CONFIG.FIB_LEVEL_1;
    return null;
}

function calculateCompressionRatio(ohlcv, lookback = 20) {
    if (ohlcv.length < lookback + CONFIG.ATR_PERIOD + 10) return null;
    const recent = ohlcv.slice(-lookback);
    const older = ohlcv.slice(-lookback * 2, -lookback);
    const recentATR = calculateATR(recent, CONFIG.ATR_PERIOD);
    const olderATR = calculateATR(older, CONFIG.ATR_PERIOD);
    if (!recentATR || !olderATR || olderATR <= 0) return null;
    return recentATR / olderATR;
}

// ==================== PİYASA REJİMİ (4H) ====================
async function checkMarketCondition(ccxtSymbol) {
    try {
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, '4h', undefined, 250);
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
        // fallback
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

// ==================== SETUP YÖNETİMİ ====================
let setupIdCounter = 0;

function createSetupObject(symbol, direction, data) {
    const id = `${symbol}:${direction}:${++setupIdCounter}`;
    const trigger = data.trigger;
    const stop = data.stop;
    const risk = Math.abs(trigger - stop);
    const tp1 = data.tp1;
    const tp2 = data.tp2;
    const rr = Math.abs(tp1 - trigger) / risk;

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
        rr,
        score: data.score,
        breakoutLevel: data.breakoutLevel,
        volumeRatio: data.volumeRatio,
        oiStatus: data.oiStatus,
        retestStatus: null,
        regime: data.regime,
        compressionRatio: data.compressionRatio,
        atr: data.atr,
        reason: data.reason,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.WATCH_TTL_MS,
        lastProcessedCandleTimestamp: null,
        breakoutConfirmedAt: null,
        retestPendingSince: null,
        retestConfirmedAt: null,
        retestLowHigh: null,     // Retest sırasında görülen en düşük/yüksek fiyat (LONG için düşük, SHORT için yüksek)
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

function updateSetup(id, updates) {
    const setup = getSetupById(id);
    if (setup) Object.assign(setup, updates, { updatedAt: Date.now() });
    return setup;
}

// ==================== 2H BREAKOUT ANALİZİ (TARAMA) ====================
async function analyze2HBreakout(ccxtSymbol, isManual = false, isWatchlist = false) {
    DEBUG.analyzed++;
    const symbol = ccxtSymbol;
    try {
        // --- 1. VERİ ÇEK (son 60 tamamlanmış 2H mum) ---
        const limit = CONFIG.LOOKBACK + 10;
        const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, CONFIG.BREAKOUT_TIMEFRAME, undefined, limit);
        if (!ohlcv || ohlcv.length < CONFIG.LOOKBACK + 1) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        // Son mum kapanmamış olabilir, çıkar
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

        const lastClose = closedCandles[closedCandles.length - 1][4];
        if (typeof lastClose !== 'number' || isNaN(lastClose)) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        // --- 2. WATCH ADAYI YÖNÜ BELİRLE ---
        // Fiyatın hangi seviyeye yakın olduğunu bul
        const longDistancePct = ((longTrigger - lastClose) / lastClose) * 100;
        const shortDistancePct = ((lastClose - shortTrigger) / lastClose) * 100;

        let direction = null;
        let trigger = null;
        let breakoutLevel = null;
        let distancePct = null;

        if (lastClose < longTrigger && longDistancePct >= 0 && longDistancePct <= CONFIG.WATCH_DISTANCE_PERCENT) {
            direction = 'LONG';
            trigger = longTrigger;
            breakoutLevel = resistance;
            distancePct = longDistancePct;
        } else if (lastClose > shortTrigger && shortDistancePct >= 0 && shortDistancePct <= CONFIG.WATCH_DISTANCE_PERCENT) {
            direction = 'SHORT';
            trigger = shortTrigger;
            breakoutLevel = support;
            distancePct = shortDistancePct;
        }

        // Eğer son kapanış trigger'ı zaten geçmişse, bu yeni bir WATCH oluşturmak için uygun değil.
        // Bu durumda, zaten var olan bir setup'ı güncellemek gerekir, yeni setup oluşturulmaz.
        if (!direction) {
            if (lastClose >= longTrigger || lastClose <= shortTrigger) {
                logRejection(symbol, 'ALREADY_BROKEN');
                DEBUG.alreadyBroken++;
            } else {
                logRejection(symbol, 'TOO_FAR_FROM_LEVEL');
                DEBUG.tooFarFromLevel++;
            }
            return null;
        }

        // --- 3. ATR VE STOP ---
        const atr = calculateATR(closedCandles, CONFIG.ATR_PERIOD);
        if (!atr || atr <= 0) {
            logRejection(symbol, 'NO_2H_DATA');
            DEBUG.noData++;
            return null;
        }

        let stop;
        if (direction === 'LONG') {
            stop = support - atr * CONFIG.SL_ATR_MULTIPLIER;
        } else {
            stop = resistance + atr * CONFIG.SL_ATR_MULTIPLIER;
        }

        // --- 4. HACİM ORANI ---
        const lastVolume = closedCandles[closedCandles.length - 1][5];
        const avgVolume = lookback.reduce((sum, c) => sum + c[5], 0) / CONFIG.LOOKBACK;
        const volumeRatio = lastVolume / avgVolume;

        // --- 5. OI ---
        let oiChangePct = 0;
        let oiStatus = 'NOT_AVAILABLE';
        if (CONFIG.OI_ENABLED) {
            const oi = await getOpenInterest(ccxtSymbol);
            if (oi > 0) {
                oiChangePct = updateOIHistory(ccxtSymbol, oi);
                if (direction === 'LONG' && oiChangePct > 0.1) oiStatus = 'SUPPORTIVE';
                else if (direction === 'SHORT' && oiChangePct < -0.1) oiStatus = 'SUPPORTIVE';
                else if (Math.abs(oiChangePct) > 0.05) oiStatus = 'NEUTRAL';
                else oiStatus = 'NOT_SUPPORTIVE';
            }
        }

        // --- 6. COMPRESSION ---
        let compressionRatio = null;
        if (CONFIG.COMPRESSION_ENABLED) {
            compressionRatio = calculateCompressionRatio(closedCandles);
        }

        // --- 7. PİYASA REJİMİ ---
        let regime = 'UNKNOWN';
        if (CONFIG.REGIME_FILTER_ENABLED) {
            const market = await checkMarketCondition(ccxtSymbol);
            regime = market.overallTrend;
        }

        // --- 8. SKOR HESAPLA ---
        let score = 50;
        if (volumeRatio >= 2.0) score += 15;
        else if (volumeRatio >= 1.5) score += 10;
        else if (volumeRatio >= CONFIG.MIN_VOLUME_RATIO) score += 5;
        else score -= 15;

        if (compressionRatio !== null) {
            if (compressionRatio < 0.7) score += 10;
            else if (compressionRatio < 0.9) score += 5;
            else score -= 5;
        }

        if (oiStatus === 'SUPPORTIVE') score += 10;
        else if (oiStatus === 'NOT_SUPPORTIVE') score -= 10;

        if (regime === 'UPTREND' && direction === 'LONG') score += 10;
        else if (regime === 'DOWNTREND' && direction === 'SHORT') score += 10;
        else if (regime !== 'UNKNOWN') score -= 5;

        if (CONFIG.RSI_FILTER_ENABLED) {
            const closes = closedCandles.map(c => c[4]);
            const rsi = calculateRSI(closes, 14);
            if (rsi !== null) {
                if (direction === 'LONG' && rsi > CONFIG.RSI_EXTREME_LONG) score -= 10;
                if (direction === 'SHORT' && rsi < CONFIG.RSI_EXTREME_SHORT) score -= 10;
            }
        }

        score = Math.max(0, Math.min(100, score));

        // --- 9. HEDEF (TP) HESAPLA ---
        const risk = Math.abs(trigger - stop);
        const fibTarget = calculateFibonacciExtension(closedCandles, CONFIG.LOOKBACK, direction);
        const minRRTarget = direction === 'LONG' ? trigger + risk * CONFIG.MIN_RR : trigger - risk * CONFIG.MIN_RR;

        let tp1 = fibTarget;
        if (!tp1 || (direction === 'LONG' && tp1 < minRRTarget) || (direction === 'SHORT' && tp1 > minRRTarget)) {
            tp1 = minRRTarget;
        }
        const tp2 = direction === 'LONG' ? trigger + risk * (CONFIG.MIN_RR * 2) : trigger - risk * (CONFIG.MIN_RR * 2);

        // --- 10. TARGET SPACE KONTROLÜ ---
        const targetDistancePct = (Math.abs(tp1 - trigger) / trigger) * 100;
        if (targetDistancePct < CONFIG.TARGET_SPACE_MIN_PERCENT) {
            logRejection(symbol, 'TARGET_TOO_CLOSE');
            DEBUG.targetTooClose++;
            return null;
        }

        // --- 11. R/R KONTROLÜ ---
        const reward = Math.abs(tp1 - trigger);
        const rr = reward / risk;
        if (rr < CONFIG.MIN_RR) {
            logRejection(symbol, 'RR_TOO_LOW');
            DEBUG.rrTooLow++;
            return null;
        }

        // --- 12. SETUP OLUŞTUR VEYA GÜNCELLE ---
        // Aynı sembol+yön için aktif setup var mı?
        const existing = setups.find(s =>
            s.symbol === ccxtSymbol &&
            s.direction === direction &&
            ['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING', 'RETEST_CONFIRMED'].includes(s.state)
        );

        if (existing) {
            // Mevcut setup'ı güncelle
            Object.assign(existing, {
                currentPrice: lastClose,
                trigger,
                stop,
                tp1,
                tp2,
                rr,
                score,
                breakoutLevel,
                volumeRatio,
                oiStatus,
                regime,
                compressionRatio,
                atr,
                reason: `${direction} breakout watch - R:${resistance.toFixed(4)} S:${support.toFixed(4)}`,
                updatedAt: Date.now(),
                expiresAt: Date.now() + CONFIG.WATCH_TTL_MS
            });
            DEBUG.duplicate++;
            return null;
        }

        // Yeni setup oluştur
        const setup = createSetupObject(ccxtSymbol, direction, {
            currentPrice: lastClose,
            trigger,
            stop,
            tp1,
            tp2,
            breakoutLevel,
            volumeRatio,
            oiStatus,
            regime,
            compressionRatio,
            atr,
            score,
            reason: `${direction} breakout watch - R:${resistance.toFixed(4)} S:${support.toFixed(4)}`
        });

        // Son işlenen mum timestamp'ini ayarla: son kapanmış mumun timestamp'i
        setup.lastProcessedCandleTimestamp = closedCandles[closedCandles.length - 1][0];

        setups.push(setup);
        DEBUG.watchCreated++;
        logRejection(symbol, 'WATCH_CREATED');

        if (isManual || isWatchlist) return setup;
        return null;
    } catch (error) {
        console.error(`[analyze2HBreakout HATA] ${ccxtSymbol}: ${error.message}`);
        logRejection(symbol, 'INTERNAL_ERROR');
        return null;
    }
}

// ==================== KAPANIŞ KONTROLÜ (BREAKOUT TESPİTİ) ====================
async function checkClosedCandlesForSetups() {
    try {
        for (const setup of setups) {
            if (!['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(setup.state)) continue;

            // Son 2H mumlarını al (sadece son 2 tane yeterli)
            const ohlcv = await exchange.fetchOHLCV(setup.symbol, CONFIG.BREAKOUT_TIMEFRAME, undefined, 3);
            if (!ohlcv || ohlcv.length < 2) continue;

            // Son kapanmış mum (sonuncusu hariç)
            const closedCandle = ohlcv[ohlcv.length - 2];
            const closedTimestamp = closedCandle[0];
            const closedClose = closedCandle[4];

            // Eğer bu mum zaten işlenmişse atla
            if (setup.lastProcessedCandleTimestamp === closedTimestamp) continue;

            // Yeni kapanmış mum var, işle
            setup.lastProcessedCandleTimestamp = closedTimestamp;

            // --- WATCH durumunda breakout kontrolü ---
            if (setup.state === 'WATCH') {
                if (setup.direction === 'LONG' && closedClose >= setup.trigger) {
                    setup.state = 'BREAKOUT_CONFIRMED';
                    setup.breakoutConfirmedAt = Date.now();
                    setup.retestPendingSince = Date.now();
                    setup.retestLowHigh = null;
                    DEBUG.breakoutConfirmed++;
                    console.log(`🔓 BREAKOUT CONFIRMED (LONG): ${setup.symbol} @ ${closedClose}`);
                } else if (setup.direction === 'SHORT' && closedClose <= setup.trigger) {
                    setup.state = 'BREAKOUT_CONFIRMED';
                    setup.breakoutConfirmedAt = Date.now();
                    setup.retestPendingSince = Date.now();
                    setup.retestLowHigh = null;
                    DEBUG.breakoutConfirmed++;
                    console.log(`🔓 BREAKOUT CONFIRMED (SHORT): ${setup.symbol} @ ${closedClose}`);
                } else if (setup.direction === 'LONG' && closedClose < setup.breakoutLevel) {
                    // Fitil kırıp geri kapattı veya hiç kırmadı, setup hâlâ WATCH ama belki uzaklaştı
                    const distance = (setup.trigger - closedClose) / closedClose * 100;
                    if (distance > CONFIG.WATCH_DISTANCE_PERCENT * 2) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = Date.now();
                        DEBUG.falseBreakout++;
                    }
                } else if (setup.direction === 'SHORT' && closedClose > setup.breakoutLevel) {
                    const distance = (closedClose - setup.trigger) / closedClose * 100;
                    if (distance > CONFIG.WATCH_DISTANCE_PERCENT * 2) {
                        setup.state = 'CANCELED';
                        setup.invalidReason = 'Fiyat hedeften uzaklaştı';
                        setup.finishedAt = Date.now();
                        DEBUG.falseBreakout++;
                    }
                }
            }
            // --- BREAKOUT_CONFIRMED veya RETEST_PENDING durumunda retest izle ---
            else if (setup.state === 'BREAKOUT_CONFIRMED' || setup.state === 'RETEST_PENDING') {
                // Retest mantığı burada kapanmış mumlarla değil, canlı fiyatlarla takip edilecek.
                // Fakat mum kapanışı da retest için sinyal olabilir.
                // Biz retest takibini ayrı bir fonksiyonda canlı fiyatla yapacağız.
                // Burada sadece zaman aşımını kontrol et.
                if (Date.now() - setup.retestPendingSince > CONFIG.RETEST_TIMEOUT_MS) {
                    setup.state = 'EXPIRED';
                    setup.invalidReason = 'Retest zaman aşımı';
                    setup.finishedAt = Date.now();
                    DEBUG.retestPending++;
                }
            }
        }
    } catch (error) {
        console.error('Kapanış kontrolü hatası:', error.message);
    }
}

// ==================== CANLI FİYAT İZLEME (RETEST VE TERS HAREKET) ====================
async function updateLivePricesForRetest() {
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();

        for (const setup of setups) {
            if (!['WATCH', 'BREAKOUT_CONFIRMED', 'RETEST_PENDING'].includes(setup.state)) continue;

            const ticker = tickers[setup.symbol];
            if (!ticker?.last) continue;
            const price = Number(ticker.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;

            // WATCH durumunda ters hareket kontrolü
            if (setup.state === 'WATCH') {
                if (setup.direction === 'LONG' && price < setup.breakoutLevel - setup.atr * 0.5) {
                    setup.state = 'CANCELED';
                    setup.invalidReason = 'Ters yöne güçlü hareket';
                    setup.finishedAt = now;
                } else if (setup.direction === 'SHORT' && price > setup.breakoutLevel + setup.atr * 0.5) {
                    setup.state = 'CANCELED';
                    setup.invalidReason = 'Ters yöne güçlü hareket';
                    setup.finishedAt = now;
                }
            }
            // BREAKOUT_CONFIRMED veya RETEST_PENDING durumunda retest kontrolü
            else if (setup.state === 'BREAKOUT_CONFIRMED' || setup.state === 'RETEST_PENDING') {
                if (setup.direction === 'LONG') {
                    // Retest: Fiyat kırılan seviyeye (breakoutLevel) yaklaşmalı ve tutunmalı
                    if (price <= setup.breakoutLevel + setup.atr * CONFIG.RETEST_TOLERANCE_ATR_MULT) {
                        // Retest bölgesine girdi
                        setup.state = 'RETEST_PENDING';
                        if (setup.retestLowHigh === null) {
                            setup.retestLowHigh = price; // İlk dokunuşta düşük kaydı
                        } else {
                            setup.retestLowHigh = Math.min(setup.retestLowHigh, price);
                        }
                    }
                    // Retest tamamlandı mı? Fiyat seviyeden yukarı döndü ve belli bir mesafe katetti
                    if (setup.state === 'RETEST_PENDING' && setup.retestLowHigh !== null) {
                        if (price > setup.breakoutLevel && price > setup.retestLowHigh + setup.atr * 0.5) {
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = now;
                            setup.retestStatus = 'CONFIRMED';
                            DEBUG.retestConfirmed++;
                            emitSignal(setup);
                        } else if (price < setup.breakoutLevel - setup.atr * 0.8) {
                            // Retest başarısız, range içine düştü
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = now;
                        }
                    }
                } else { // SHORT
                    if (price >= setup.breakoutLevel - setup.atr * CONFIG.RETEST_TOLERANCE_ATR_MULT) {
                        setup.state = 'RETEST_PENDING';
                        if (setup.retestLowHigh === null) {
                            setup.retestLowHigh = price;
                        } else {
                            setup.retestLowHigh = Math.max(setup.retestLowHigh, price);
                        }
                    }
                    if (setup.state === 'RETEST_PENDING' && setup.retestLowHigh !== null) {
                        if (price < setup.breakoutLevel && price < setup.retestLowHigh - setup.atr * 0.5) {
                            setup.state = 'RETEST_CONFIRMED';
                            setup.retestConfirmedAt = now;
                            setup.retestStatus = 'CONFIRMED';
                            DEBUG.retestConfirmed++;
                            emitSignal(setup);
                        } else if (price > setup.breakoutLevel + setup.atr * 0.8) {
                            setup.state = 'BREAKOUT_INVALID';
                            setup.invalidReason = 'Retest başarısız, fiyat range içine döndü';
                            setup.finishedAt = now;
                        }
                    }
                }

                // Zaman aşımı
                if (Date.now() - setup.retestPendingSince > CONFIG.RETEST_TIMEOUT_MS) {
                    setup.state = 'EXPIRED';
                    setup.invalidReason = 'Retest zaman aşımı';
                    setup.finishedAt = now;
                }
            }
        }

        // Temizlik
        cleanOldSetups();
    } catch (error) {
        console.error('Canlı fiyat güncelleme hatası:', error.message);
    }
}

function cleanOldSetups() {
    const now = Date.now();
    setups = setups.filter(setup => {
        if (['CANCELED', 'EXPIRED', 'BREAKOUT_INVALID'].includes(setup.state)) {
            return now - setup.finishedAt < CONFIG.CANCELED_RETENTION_MS;
        }
        if (setup.state === 'SIGNAL_READY') {
            return now - setup.retestConfirmedAt < CONFIG.SIGNAL_RETENTION_MS;
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

    global.APP_STATE.signals.unshift(signalData);
    io.emit('yeni_sinyal', signalData);
    io.emit('setups_update', setups);
    DEBUG.signalEmitted++;
    setup.state = 'SIGNAL_READY';
    console.log(`\x1b[32m>>> 2H BREAKOUT SİNYALİ: ${setup.symbol} ${setup.direction} @ ${setup.trigger.toFixed(4)} (Skor: ${setup.score})\x1b[0m`);
}

// ==================== TARAMA DÖNGÜLERİ ====================
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
            if (!ticker?.symbol || typeof ticker.quoteVolume === 'undefined' || ticker.quoteVolume === null) continue;
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
    res.type('html').send(`
        <!DOCTYPE html>
        <html>
        <head><title>2H Breakout Signal Engine</title></head>
        <body style="background:#0b111b;color:#dbe4ee;font-family:sans-serif;text-align:center;padding-top:50px;">
            <h1 style="color:#13dba0;">🚀 2H Breakout Signal Engine</h1>
            <p>API çalışıyor. Sinyaller için <code>/api/setups</code> endpoint'ini kullanın.</p>
            <p>Debug raporu: <code>/api/debug</code></p>
        </body>
        </html>
    `);
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
        if (globalTargetList.length > 0) {
            await run2HBreakoutScan();
        }

        // Periyodik görevler
        setInterval(runPreScan, CONFIG.PRESCAN_INTERVAL);
        setInterval(run2HBreakoutScan, 5 * 60 * 1000);          // 5 dakikada bir tarama
        setInterval(checkClosedCandlesForSetups, 60 * 1000);   // 1 dakikada bir kapanış kontrolü
        setInterval(updateLivePricesForRetest, 3000);          // 3 saniyede bir canlı fiyat/retest kontrolü
        setInterval(cleanOIHistory, 10 * 60 * 1000);           // OI geçmişi temizliği

        console.log('Döngüler başlatıldı.');
    } catch (error) {
        console.error('Başlangıç hatası:', error);
    }
});
