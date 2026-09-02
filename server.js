'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const DATA_FILE = path.join(__dirname, 'breakout_data.json');

// ==================== JSON KALICILIK ====================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return {
                setups: data.setups || [],
                trades: data.trades || [],
                stats: data.stats || {}
            };
        }
    } catch (e) {
        console.warn('Veri dosyası okunamadı:', e.message);
    }
    return { setups: [], trades: [], stats: {} };
}

function saveData() {
    try {
        const data = {
            setups: setups.filter(s => ['WAITING','WATCH','BREAKOUT','RETEST_WAIT','CONFIRMED','SIGNAL'].includes(s.state)),
            trades: tradeHistory,
            stats: dailyStats,
            savedAt: Date.now()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn('Veri kaydedilemedi:', e.message);
    }
}

// ==================== KONFİGÜRASYON ====================
const CFG = {
    SCAN_INTERVAL_MS: 60 * 1000,
    LIVE_UPDATE_INTERVAL_MS: 3 * 1000,

    TIMEFRAME_4H: '4h',
    TIMEFRAME_1H: '1h',
    TIMEFRAME_15M: '15m',
    CANDLE_LIMIT: 100,

    MIN_VOLUME_USDT: 5_000_000,
    MAX_CANDIDATES: 80,

    LEVEL_MAX_DISTANCE_PCT: 0.3,
    LEVEL_MIN_QUALITY: 55,
    LEVEL_APPROACH_DISTANCE_PCT: 1.5,

    BREAKOUT_MIN_DISTANCE_PCT: 0.1,
    MIN_BODY_RATIO: 0.5,
    MIN_CLOSE_POSITION_LONG: 0.7,
    MIN_CLOSE_POSITION_SHORT: 0.7,
    MIN_RANGE_ATR: 0.8,
    MAX_RANGE_ATR: 2.5,
    MIN_BREAKOUT_VOLUME_RATIO: 1.5,
    MAX_WICK_RATIO: 0.3,

    RETEST_MAX_CANDLES: 5,
    RETEST_TOUCH_BUFFER_PCT: 0.1,
    RETEST_MAX_CLOSE_PENETRATION_PCT: 0.2,

    STOP_ATR_BUFFER: 0.25,

    MIN_RR: 2.0,

    WATCH_TTL_MS: 45 * 60 * 1000,
    BREAKOUT_TTL_MS: 30 * 60 * 1000,
    SIGNAL_TTL_MS: 15 * 60 * 1000,
    FINISHED_RETENTION_MS: 5 * 60 * 1000,

    ATR_PERIOD: 14,
    VOLUME_LOOKBACK: 20,
};

// ==================== DEBUG ====================
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    candidatesAnalyzed: 0,
    candle4hFailed: 0,
    candle1hFailed: 0,
    candle15mFailed: 0,
    noRegime: 0,
    regimeFlat: 0,
    noImportantLevel: 0,
    levelQualityLow: 0,
    tooFarFromLevel: 0,
    noBreakout: 0,
    breakoutInvalid: 0,
    retestFailed: 0,
    retestExpired: 0,
    targetTooClose: 0,
    rrTooLow: 0,
    duplicateSetup: 0,
    setupCreated: 0,
    signalGenerated: 0,
    // Yeni detay sayaçları
    watchChecked: 0,
    breakoutDetected: 0,
    breakoutAccepted: 0,
    retestChecked: 0,
    retestDetected: 0,
    targetMissing: 0,
    rrRejected: 0,
};

function resetDebug() {
    Object.keys(DEBUG).forEach(key => DEBUG[key] = 0);
}

function printDebugReport() {
    console.log('\n========== 📊 TARAMA RAPORU ==========');
    console.log('Toplam Ticker:', DEBUG.totalTickers);
    console.log('Hacim Filtresi Geçen:', DEBUG.volumeFiltered);
    console.log('Analiz Edilen:', DEBUG.candidatesAnalyzed);
    console.log('--- ELENME NEDENLERİ ---');
    console.log('4H Mum Yetersiz:', DEBUG.candle4hFailed);
    console.log('1H Mum Yetersiz:', DEBUG.candle1hFailed);
    console.log('15M Mum Yetersiz:', DEBUG.candle15mFailed);
    console.log('Rejim Tespit Edilemedi:', DEBUG.noRegime);
    console.log('Rejim Flat:', DEBUG.regimeFlat);
    console.log('Önemli Seviye Yok:', DEBUG.noImportantLevel);
    console.log('Seviye Kalitesi Düşük:', DEBUG.levelQualityLow);
    console.log('Seviyeden Uzak:', DEBUG.tooFarFromLevel);
    console.log('--- BREAKOUT/RETEST DETAY ---');
    console.log('WATCH Kontrol Edildi:', DEBUG.watchChecked);
    console.log('Breakout Tespit Edildi:', DEBUG.breakoutDetected);
    console.log('Breakout Geçersiz:', DEBUG.breakoutInvalid);
    console.log('Breakout Kabul Edildi:', DEBUG.breakoutAccepted);
    console.log('Retest Kontrol Edildi:', DEBUG.retestChecked);
    console.log('Retest Tespit Edildi:', DEBUG.retestDetected);
    console.log('Retest Başarısız:', DEBUG.retestFailed);
    console.log('Retest Süresi Doldu:', DEBUG.retestExpired);
    console.log('Hedef Yok:', DEBUG.targetMissing);
    console.log('R/R Reddedildi:', DEBUG.rrRejected);
    console.log('R/R Düşük:', DEBUG.rrTooLow);
    console.log('Duplicate Setup:', DEBUG.duplicateSetup);
    console.log('--- SONUÇ ---');
    console.log('Yeni Setup (WATCH):', DEBUG.setupCreated);
    console.log('Sinyal Üretildi:', DEBUG.signalGenerated);
    console.log('======================================\n');
}

// ==================== EXCHANGE ====================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ==================== STATE ====================
const initialData = loadData();
let setups = initialData.setups;
let tradeHistory = initialData.trades;
let dailyStats = initialData.stats;
let isScanning = false;
let isUpdatingPrices = false;
let isShuttingDown = false;
let scanTimer;
let liveTimer;
let gcTimer;

const recentWarnings = new Map();

// ==================== YARDIMCI FONKSİYONLAR ====================
function number(value, decimals = 8) {
    const result = Number(value);
    return Number.isFinite(result) ? Number(result.toFixed(decimals)) : 0;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();
    if (now - (recentWarnings.get(key) || 0) < cooldownMs) return;
    recentWarnings.set(key, now);
    console.warn('[' + new Date(now).toISOString() + '] ' + key + ': ' + error.message);
}

function formatPrice(value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return '-';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(3);
    if (price >= 1) return price.toFixed(5);
    if (price >= 0.01) return price.toFixed(7);
    return price.toFixed(8);
}

function percentDistance(from, to) {
    if (!from) return 100;
    return Math.abs(to - from) / from * 100;
}

function calculateEMA(values, period) {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = average(values.slice(0, period));
    for (let index = period; index < values.length; index++) {
        ema = (values[index] - ema) * multiplier + ema;
    }
    return ema;
}

function calculateATR(candles, period = CFG.ATR_PERIOD) {
    if (candles.length < period + 1) return null;
    const trueRanges = [];
    for (let index = 1; index < candles.length; index++) {
        const high = Number(candles[index][2]);
        const low = Number(candles[index][3]);
        const previousClose = Number(candles[index - 1][4]);
        trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
    return average(trueRanges.slice(-period));
}

function getCandles(symbol, timeframe, limit = CFG.CANDLE_LIMIT) {
    return exchange.fetchOHLCV(symbol, timeframe, undefined, limit)
        .then(candles => Array.isArray(candles) ? candles.filter(c => Array.isArray(c) && c.length >= 6).sort((a, b) => a[0] - b[0]) : [])
        .catch(error => {
            warnOnce('Mum verisi (' + symbol + ' ' + timeframe + ')', error);
            return [];
        });
}

// ==================== 4H REGIME TESPİTİ (YAPI ÖNCELİKLİ) ====================
function detectMarketRegime(candles4h) {
    if (candles4h.length < 30) return null;

    const highs = candles4h.map(c => Number(c[2]));
    const lows = candles4h.map(c => Number(c[3]));
    const closes = candles4h.map(c => Number(c[4]));

    const pivotHighs = [];
    const pivotLows = [];
    for (let i = 2; i < candles4h.length - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i+1] && highs[i] > highs[i-2] && highs[i] > highs[i+2]) {
            pivotHighs.push({ index: i, price: highs[i] });
        }
        if (lows[i] < lows[i-1] && lows[i] < lows[i+1] && lows[i] < lows[i-2] && lows[i] < lows[i+2]) {
            pivotLows.push({ index: i, price: lows[i] });
        }
    }

    if (pivotHighs.length < 2 || pivotLows.length < 2) return null;

    const last2Highs = pivotHighs.slice(-2);
    const last2Lows = pivotLows.slice(-2);

    const hh1 = last2Highs[1].price, hh2 = last2Highs[0].price;
    const ll1 = last2Lows[1].price, ll2 = last2Lows[0].price;

    let regime = 'TRANSITION';
    let direction = 'FLAT';

    // Net yapı: yüksek tepe ve yüksek dip = BULLISH, düşük tepe ve düşük dip = BEARISH
    if (hh1 > hh2 && ll1 > ll2) {
        regime = 'BULLISH';
        direction = 'LONG';
    } else if (hh1 < hh2 && ll1 < ll2) {
        regime = 'BEARISH';
        direction = 'SHORT';
    } else {
        // Yapı karışık, net bir eğilim yok
        // Aşırı hareket varsa yine de yön verilebilir ama şimdilik FLAT bırak
        const avgPrice = average(closes.slice(-20));
        const currentPrice = closes[closes.length - 1];
        const deviation = percentDistance(avgPrice, currentPrice);
        if (deviation > 5) {
            // Güçlü sapma varsa yön ver
            if (currentPrice > avgPrice) {
                regime = 'BULLISH';
                direction = 'LONG';
            } else {
                regime = 'BEARISH';
                direction = 'SHORT';
            }
        } else {
            regime = 'RANGE';
            direction = 'FLAT';
        }
    }

    return {
        regime,
        direction,
        description: `4H Regime: ${regime}`,
        pivotHighs: last2Highs.map(p => p.price),
        pivotLows: last2Lows.map(p => p.price)
    };
}

// ==================== 1H ÖNEMLİ SEVİYELER ====================
function detectImportantLevels(candles1h) {
    if (candles1h.length < 30) return [];

    const highs = candles1h.map(c => Number(c[2]));
    const lows = candles1h.map(c => Number(c[3]));
    const opens = candles1h.map(c => Number(c[1]));
    const closes = candles1h.map(c => Number(c[4]));

    const pivotHighs = [];
    const pivotLows = [];
    for (let i = 2; i < candles1h.length - 2; i++) {
        if (highs[i] > highs[i-1] && highs[i] > highs[i+1] && highs[i] > highs[i-2] && highs[i] > highs[i+2]) {
            pivotHighs.push({ index: i, price: highs[i] });
        }
        if (lows[i] < lows[i-1] && lows[i] < lows[i+1] && lows[i] < lows[i-2] && lows[i] < lows[i+2]) {
            pivotLows.push({ index: i, price: lows[i] });
        }
    }

    function clusterPivots(pivots, type) {
        const clusters = [];
        for (const pivot of pivots) {
            let found = false;
            for (const cluster of clusters) {
                const avgPrice = cluster.prices.reduce((a,b)=>a+b,0) / cluster.prices.length;
                if (Math.abs(pivot.price - avgPrice) / avgPrice * 100 <= CFG.LEVEL_MAX_DISTANCE_PCT) {
                    cluster.prices.push(pivot.price);
                    cluster.indices.push(pivot.index);
                    cluster.reactions.push({
                        index: pivot.index,
                        price: pivot.price,
                        bodyRatio: Math.abs(closes[pivot.index] - opens[pivot.index]) / (highs[pivot.index] - lows[pivot.index]),
                        wickTop: (highs[pivot.index] - Math.max(opens[pivot.index], closes[pivot.index])) / (highs[pivot.index] - lows[pivot.index]),
                        wickBottom: (Math.min(opens[pivot.index], closes[pivot.index]) - lows[pivot.index]) / (highs[pivot.index] - lows[pivot.index])
                    });
                    found = true;
                    break;
                }
            }
            if (!found) {
                clusters.push({
                    type: type,
                    prices: [pivot.price],
                    indices: [pivot.index],
                    reactions: [{
                        index: pivot.index,
                        price: pivot.price,
                        bodyRatio: Math.abs(closes[pivot.index] - opens[pivot.index]) / (highs[pivot.index] - lows[pivot.index]),
                        wickTop: (highs[pivot.index] - Math.max(opens[pivot.index], closes[pivot.index])) / (highs[pivot.index] - lows[pivot.index]),
                        wickBottom: (Math.min(opens[pivot.index], closes[pivot.index]) - lows[pivot.index]) / (highs[pivot.index] - lows[pivot.index])
                    }]
                });
            }
        }
        return clusters;
    }

    const resistanceClusters = clusterPivots(pivotHighs, 'RESISTANCE');
    const supportClusters = clusterPivots(pivotLows, 'SUPPORT');

    function calculateClusterQuality(cluster) {
        const reactionCount = cluster.reactions.length;
        const lastIndex = Math.max(...cluster.indices);
        const recencyScore = (candles1h.length - 1 - lastIndex) <= 20 ? 20 : (candles1h.length - 1 - lastIndex) <= 40 ? 10 : 0;

        let strengthScore = 0;
        for (const reaction of cluster.reactions) {
            const wickRatio = cluster.type === 'RESISTANCE' ? reaction.wickTop : reaction.wickBottom;
            if (reaction.bodyRatio < 0.3) strengthScore += 10;
            else if (reaction.bodyRatio < 0.6) strengthScore += 5;
        }
        strengthScore = Math.min(20, strengthScore);

        let distanceScore = 0;
        if (cluster.prices.length > 1) {
            const avgDistance = average(cluster.prices.map((p, i) => i > 0 ? Math.abs(p - cluster.prices[i-1]) / p * 100 : 0).filter(v => v > 0));
            distanceScore = Math.max(0, 20 - avgDistance * 10);
        } else {
            distanceScore = 10;
        }
        distanceScore = Math.min(20, distanceScore);

        const reactionScore = Math.min(60, reactionCount * 20);
        const total = reactionScore + recencyScore + strengthScore + distanceScore;
        return Math.min(100, Math.round(total));
    }

    const levels = [];
    for (const cluster of [...resistanceClusters, ...supportClusters]) {
        const avgPrice = average(cluster.prices);
        const quality = calculateClusterQuality(cluster);
        if (quality >= CFG.LEVEL_MIN_QUALITY) {
            levels.push({
                price: number(avgPrice),
                type: cluster.type,
                quality,
                reactionCount: cluster.reactions.length,
                lastReactionIndex: Math.max(...cluster.indices),
                description: `${cluster.type} (${quality})`
            });
        }
    }

    levels.sort((a, b) => b.quality - a.quality);
    return levels;
}

// ==================== 15M BREAKOUT TESPİTİ ====================
function detectBreakout(candles15m, level, direction, atr15m) {
    if (candles15m.length < 5) return null;
    const lastClosed = candles15m[candles15m.length - 2];
    const prevClosed = candles15m[candles15m.length - 3];

    const open = Number(lastClosed[1]);
    const high = Number(lastClosed[2]);
    const low = Number(lastClosed[3]);
    const close = Number(lastClosed[4]);
    const volume = Number(lastClosed[5]);
    const prevClose = Number(prevClosed[4]);

    const volumes = candles15m.slice(-CFG.VOLUME_LOOKBACK - 2, -2).map(c => Number(c[5]));
    const avgVolume = average(volumes);
    if (!avgVolume) return null;

    let breakout = false;
    if (direction === 'LONG') {
        if (prevClose < level.price && close > level.price * (1 + CFG.BREAKOUT_MIN_DISTANCE_PCT / 100)) {
            breakout = true;
        }
    } else {
        if (prevClose > level.price && close < level.price * (1 - CFG.BREAKOUT_MIN_DISTANCE_PCT / 100)) {
            breakout = true;
        }
    }

    if (!breakout) return null;

    const bodyRatio = Math.abs(close - open) / (high - low);
    const closePosition = direction === 'LONG' ? (close - low) / (high - low) : (high - close) / (high - low);
    const rangeATR = (high - low) / atr15m;
    const volumeRatio = volume / avgVolume;
    const wickRatio = direction === 'LONG' ? (high - Math.max(open, close)) / (high - low) : (Math.min(open, close) - low) / (high - low);

    if (bodyRatio < CFG.MIN_BODY_RATIO) return null;
    if (closePosition < (direction === 'LONG' ? CFG.MIN_CLOSE_POSITION_LONG : CFG.MIN_CLOSE_POSITION_SHORT)) return null;
    if (rangeATR < CFG.MIN_RANGE_ATR || rangeATR > CFG.MAX_RANGE_ATR) return null;
    if (volumeRatio < CFG.MIN_BREAKOUT_VOLUME_RATIO) return null;
    if (wickRatio > CFG.MAX_WICK_RATIO) return null;

    const breakoutQuality = Math.round(
        (bodyRatio / 0.7 * 25) +
        (closePosition / 0.9 * 25) +
        (Math.min(volumeRatio / 3, 1) * 25) +
        (Math.min(rangeATR / 1.5, 1) * 25)
    );

    return {
        breakout: true,
        direction,
        levelPrice: level.price,
        candleIndex: candles15m.length - 2,
        candleTime: lastClosed[0],
        close,
        high,
        low,
        volume,
        avgVolume,
        volumeRatio,
        bodyRatio,
        closePosition,
        rangeATR,
        wickRatio,
        breakoutQuality: Math.min(100, breakoutQuality),
        atr: atr15m
    };
}

// ==================== RETEST TESPİTİ (GÜÇLENDİRİLMİŞ) ====================
function detectRetest(candles15m, breakoutInfo, levelPrice, direction, breakoutIndex) {
    if (breakoutIndex === undefined || breakoutIndex === null || breakoutIndex < 0) return null;
    const retestCandles = candles15m.slice(breakoutIndex + 1, breakoutIndex + 1 + CFG.RETEST_MAX_CANDLES);
    if (retestCandles.length === 0) return null;

    for (let i = 0; i < retestCandles.length; i++) {
        const candle = retestCandles[i];
        const open = Number(candle[1]);
        const high = Number(candle[2]);
        const low = Number(candle[3]);
        const close = Number(candle[4]);

        if (direction === 'LONG') {
            const touchThreshold = levelPrice * (1 + CFG.RETEST_TOUCH_BUFFER_PCT / 100);
            if (low <= touchThreshold) {
                const maxPenetration = levelPrice * (1 - CFG.RETEST_MAX_CLOSE_PENETRATION_PCT / 100);
                // Kapanış seviyenin altına çok fazla inmemeli veya üstünde olmalı
                if (close >= maxPenetration) {
                    // Ek kalite: kapanış seviyenin üstündeyse ve yukarı kapanışsa daha iyi
                    const qualityBoost = close > levelPrice && close > open ? 10 : 0;
                    const retestQuality = Math.round(
                        (1 - (levelPrice - low) / (levelPrice * 0.01)) * 35 +
                        (close > levelPrice ? 35 : 20) +
                        (close > open ? 10 : 0) +
                        qualityBoost
                    );
                    return {
                        retest: true,
                        quality: Math.min(100, retestQuality),
                        retestIndex: breakoutIndex + 1 + i,
                        retestLow: low,
                        retestHigh: high,
                        retestClose: close
                    };
                } else {
                    return { retest: false, invalid: true, reason: 'Retest kapanışı seviyenin altında' };
                }
            }
        } else { // SHORT
            const touchThreshold = levelPrice * (1 - CFG.RETEST_TOUCH_BUFFER_PCT / 100);
            if (high >= touchThreshold) {
                const maxPenetration = levelPrice * (1 + CFG.RETEST_MAX_CLOSE_PENETRATION_PCT / 100);
                if (close <= maxPenetration) {
                    const qualityBoost = close < levelPrice && close < open ? 10 : 0;
                    const retestQuality = Math.round(
                        (1 - (high - levelPrice) / (levelPrice * 0.01)) * 35 +
                        (close < levelPrice ? 35 : 20) +
                        (close < open ? 10 : 0) +
                        qualityBoost
                    );
                    return {
                        retest: true,
                        quality: Math.min(100, retestQuality),
                        retestIndex: breakoutIndex + 1 + i,
                        retestLow: low,
                        retestHigh: high,
                        retestClose: close
                    };
                } else {
                    return { retest: false, invalid: true, reason: 'Retest kapanışı seviyenin üzerinde' };
                }
            }
        }
    }

    return { retest: false, invalid: false, reason: 'Retest bulunamadı (süre doldu)' };
}

// ==================== HEDEF BULMA ====================
function findTargets(levels, direction, entryPrice, stopPrice, risk) {
    let targets = [];
    if (direction === 'LONG') {
        targets = levels
            .filter(l => l.type === 'RESISTANCE' && l.price > entryPrice)
            .sort((a, b) => a.price - b.price)
            .slice(0, 2)
            .map(l => ({ price: l.price, quality: l.quality }));
    } else {
        targets = levels
            .filter(l => l.type === 'SUPPORT' && l.price < entryPrice)
            .sort((a, b) => b.price - a.price)
            .slice(0, 2)
            .map(l => ({ price: l.price, quality: l.quality }));
    }

    if (targets.length === 0) {
        return { tp1: null, tp2: null, targetLevels: [] };
    }

    const tp1 = targets[0].price;
    const tp2 = targets[1] ? targets[1].price : null;

    return { tp1, tp2, targetLevels: targets };
}

// ==================== SETUP OLUŞTURMA (ID SABİT) ====================
function createSetup(symbol, direction, currentPrice, data) {
    const levelPriceFixed = number(data.levelPrice, 8).toFixed(8);
    const id = `${symbol}:${direction}:${levelPriceFixed}`;

    const setup = {
        id,
        symbol,
        direction,
        state: data.state || 'WATCH',
        currentPrice,
        levelPrice: data.levelPrice,
        levelType: data.levelType,
        levelQuality: data.levelQuality,
        trigger: data.trigger || null,
        entry: data.entry || null,
        stop: data.stop || null,
        tp1: data.tp1 || null,
        tp2: data.tp2 || null,
        risk: data.risk || null,
        rr: data.rr || null,
        breakoutQuality: data.breakoutQuality || null,
        retestQuality: data.retestQuality || null,
        score: data.score || 0,
        volumeRatio: data.volumeRatio || null,
        reason: data.reason || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + (data.state === 'WATCH' ? CFG.WATCH_TTL_MS : data.state === 'SIGNAL' ? CFG.SIGNAL_TTL_MS : CFG.BREAKOUT_TTL_MS),
        breakoutTime: data.breakoutTime || null,
        breakoutIndex: data.breakoutIndex !== undefined ? data.breakoutIndex : null,
        retestTime: data.retestTime || null,
    };
    return setup;
}

function upsertSetup(nextSetup) {
    const existingIndex = setups.findIndex(s => s.id === nextSetup.id);
    if (existingIndex === -1) {
        setups.unshift(nextSetup);
    } else {
        const existing = setups[existingIndex];
        if (existing.state === 'SIGNAL') return; // sinyal üretilmişse dokunma
        setups[existingIndex] = {
            ...existing,
            ...nextSetup,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
        };
    }
}

// ==================== ANALİZ ====================
async function analyzeCandidate(candidate) {
    DEBUG.candidatesAnalyzed++;
    const symbol = candidate.symbol;
    const currentPrice = number(candidate.ticker.last);
    if (!currentPrice) return;

    // 4H
    const candles4h = await getCandles(symbol, CFG.TIMEFRAME_4H);
    if (candles4h.length < 30) {
        DEBUG.candle4hFailed++;
        return;
    }
    const regime = detectMarketRegime(candles4h);
    if (!regime) {
        DEBUG.noRegime++;
        return;
    }
    if (regime.direction === 'FLAT') {
        DEBUG.regimeFlat++;
        return;
    }

    // 1H
    const candles1h = await getCandles(symbol, CFG.TIMEFRAME_1H);
    if (candles1h.length < 30) {
        DEBUG.candle1hFailed++;
        return;
    }
    const levels = detectImportantLevels(candles1h);
    if (levels.length === 0) {
        DEBUG.noImportantLevel++;
        return;
    }

    // 15M
    const candles15m = await getCandles(symbol, CFG.TIMEFRAME_15M);
    if (candles15m.length < 30) {
        DEBUG.candle15mFailed++;
        return;
    }
    const atr15m = calculateATR(candles15m, CFG.ATR_PERIOD);
    if (!atr15m) {
        DEBUG.candle15mFailed++;
        return;
    }

    const direction = regime.direction;
    const relevantLevels = direction === 'LONG' ? levels.filter(l => l.type === 'RESISTANCE') : levels.filter(l => l.type === 'SUPPORT');
    if (relevantLevels.length === 0) {
        DEBUG.noImportantLevel++;
        return;
    }

    // ==== MEVCUT SETUP KONTROLÜ ====
    // Önce bu sembol+yön için aktif bir setup var mı kontrol et
    const activeSetups = setups.filter(s => 
        s.symbol === symbol && 
        s.direction === direction && 
        ['WATCH','BREAKOUT','RETEST_WAIT','CONFIRMED'].includes(s.state)
    );

    if (activeSetups.length > 0) {
        // Mevcut setup'ı seç (en güncel olanı)
        const existingSetup = activeSetups[0]; // İlk eşleşen yeterli, aynı sembol+yön için genelde tek setup olur

        // ==== STATE'E GÖRE İŞLE ====
        if (existingSetup.state === 'WATCH') {
            DEBUG.watchChecked++;
            const breakoutInfo = detectBreakout(candles15m, { price: existingSetup.levelPrice }, direction, atr15m);
            if (breakoutInfo) {
                DEBUG.breakoutDetected++;
                // Breakout geçerli, state'i güncelle
                existingSetup.state = 'BREAKOUT';
                existingSetup.breakoutQuality = breakoutInfo.breakoutQuality;
                existingSetup.volumeRatio = breakoutInfo.volumeRatio;
                existingSetup.breakoutTime = breakoutInfo.candleTime;
                existingSetup.breakoutIndex = breakoutInfo.candleIndex;
                existingSetup.updatedAt = Date.now();
                existingSetup.expiresAt = Date.now() + CFG.BREAKOUT_TTL_MS; // TTL yenilendi
                existingSetup.reason += ` | Breakout kalitesi: ${breakoutInfo.breakoutQuality}`;
                DEBUG.breakoutAccepted++;
                console.log(`✅ BREAKOUT ${direction} ${symbol} @ ${formatPrice(existingSetup.levelPrice)} | Kalite: ${breakoutInfo.breakoutQuality}`);
            } else {
                DEBUG.noBreakout++;
            }
        } else if (existingSetup.state === 'BREAKOUT' || existingSetup.state === 'RETEST_WAIT') {
            DEBUG.retestChecked++;
            const breakoutIndex = existingSetup.breakoutIndex;
            if (breakoutIndex !== null && breakoutIndex !== undefined) {
                const retestInfo = detectRetest(candles15m, { direction, levelPrice: existingSetup.levelPrice }, existingSetup.levelPrice, direction, breakoutIndex);
                if (retestInfo) {
                    if (retestInfo.retest) {
                        DEBUG.retestDetected++;
                        existingSetup.state = 'CONFIRMED';
                        existingSetup.retestQuality = retestInfo.quality;
                        existingSetup.retestTime = Date.now();
                        existingSetup.updatedAt = Date.now();
                        existingSetup.reason += ` | Retest başarılı (${retestInfo.quality})`;

                        const entryPrice = currentPrice;
                        const stopPrice = direction === 'LONG' 
                            ? retestInfo.retestLow - atr15m * CFG.STOP_ATR_BUFFER 
                            : retestInfo.retestHigh + atr15m * CFG.STOP_ATR_BUFFER;
                        const risk = Math.abs(entryPrice - stopPrice);
                        if (risk > 0) {
                            const targets = findTargets(levels, direction, entryPrice, stopPrice, risk);
                            if (!targets.tp1) {
                                DEBUG.targetMissing++;
                                existingSetup.state = 'CANCELLED';
                                existingSetup.cancelReason = 'Gerçek hedef yok';
                                existingSetup.finishedAt = Date.now();
                            } else {
                                const rr = Math.abs(targets.tp1 - entryPrice) / risk;
                                if (rr >= CFG.MIN_RR) {
                                    existingSetup.state = 'SIGNAL';
                                    existingSetup.entry = number(entryPrice);
                                    existingSetup.stop = number(stopPrice);
                                    existingSetup.tp1 = number(targets.tp1);
                                    existingSetup.tp2 = targets.tp2 ? number(targets.tp2) : null;
                                    existingSetup.risk = number(risk);
                                    existingSetup.rr = number(rr);
                                    existingSetup.score = calculateScore(existingSetup);
                                    existingSetup.reason += ` | RR: ${existingSetup.rr.toFixed(2)}`;
                                    existingSetup.expiresAt = Date.now() + CFG.SIGNAL_TTL_MS;
                                    DEBUG.signalGenerated++;
                                    console.log(`🔥 SIGNAL ${direction} ${symbol} | Giriş: ${formatPrice(entryPrice)} | Stop: ${formatPrice(stopPrice)} | TP1: ${formatPrice(targets.tp1)} | RR: ${existingSetup.rr.toFixed(2)}`);
                                } else {
                                    DEBUG.rrRejected++;
                                    DEBUG.rrTooLow++;
                                    existingSetup.state = 'CANCELLED';
                                    existingSetup.cancelReason = 'R/R yetersiz';
                                    existingSetup.finishedAt = Date.now();
                                }
                            }
                        }
                    } else if (retestInfo.invalid) {
                        DEBUG.retestFailed++;
                        existingSetup.state = 'CANCELLED';
                        existingSetup.cancelReason = retestInfo.reason;
                        existingSetup.finishedAt = Date.now();
                    }
                } else {
                    // Retest henüz bulunamadı, süre kontrolü
                    if (Date.now() - existingSetup.breakoutTime > CFG.BREAKOUT_TTL_MS) {
                        DEBUG.retestExpired++;
                        existingSetup.state = 'EXPIRED';
                        existingSetup.cancelReason = 'Retest süresi doldu';
                        existingSetup.finishedAt = Date.now();
                    }
                }
            }
        } else if (existingSetup.state === 'CONFIRMED') {
            // Zaten doğrulandı, signal'e geçiş önceki adımlarda yapıldı, burada ekstra bir şey gerekmez
        }
    } else {
        // ==== YENİ SETUP İÇİN YAKINLIK KONTROLÜ ====
        const nearbyLevels = relevantLevels.filter(l => percentDistance(currentPrice, l.price) <= CFG.LEVEL_APPROACH_DISTANCE_PCT);
        if (nearbyLevels.length === 0) {
            DEBUG.tooFarFromLevel++;
            return;
        }
        const selectedLevel = nearbyLevels.sort((a, b) => b.quality - a.quality)[0];

        const setupData = {
            state: 'WATCH',
            levelPrice: selectedLevel.price,
            levelType: selectedLevel.type,
            levelQuality: selectedLevel.quality,
            direction,
            score: 0,
            reason: `Seviyeye yaklaşıyor (${formatPrice(selectedLevel.price)})`
        };
        const newSetup = createSetup(symbol, direction, currentPrice, setupData);
        upsertSetup(newSetup);
        DEBUG.setupCreated++;
        console.log(`👀 WATCH ${direction} ${symbol} @ ${formatPrice(selectedLevel.price)} (mesafe: ${percentDistance(currentPrice, selectedLevel.price).toFixed(2)}%)`);
    }
}

function calculateScore(setup) {
    let score = 0;
    score += Math.min(20, setup.levelQuality * 0.2);
    score += Math.min(20, setup.breakoutQuality || 0);
    score += Math.min(20, setup.retestQuality || 0);
    score += 15; // trend alignment
    if (setup.volumeRatio >= 2) score += 10;
    else if (setup.volumeRatio >= 1.5) score += 7;
    else if (setup.volumeRatio >= 1) score += 4;
    if (setup.rr >= 3) score += 15;
    else if (setup.rr >= 2.5) score += 12;
    else if (setup.rr >= 2) score += 9;
    return Math.min(100, Math.round(score));
}

function expireOldSetups() {
    const now = Date.now();
    setups.forEach(setup => {
        if (now > setup.expiresAt && ['WATCH','BREAKOUT','RETEST_WAIT','CONFIRMED'].includes(setup.state)) {
            setup.state = 'EXPIRED';
            setup.cancelReason = 'Süre doldu';
            setup.finishedAt = now;
        }
        if (setup.state === 'SIGNAL' && setup.firedAt && now - setup.firedAt > CFG.SIGNAL_TTL_MS) {
            setup.state = 'EXPIRED';
            setup.cancelReason = 'Sinyal süresi doldu';
            setup.finishedAt = now;
        }
    });

    setups = setups
        .filter(s => !s.finishedAt || now - s.finishedAt < CFG.FINISHED_RETENTION_MS)
        .sort((a, b) => {
            const order = { SIGNAL: 0, CONFIRMED: 1, RETEST_WAIT: 2, BREAKOUT: 3, WATCH: 4, WAITING: 5, CANCELLED: 6, EXPIRED: 7 };
            return (order[a.state] || 99) - (order[b.state] || 99);
        })
        .slice(0, 20);
}

// ==================== TARAMA ====================
async function runScan() {
    if (isScanning || isShuttingDown) return;
    isScanning = true;
    resetDebug();

    console.log('\n[' + new Date().toLocaleTimeString('tr-TR') + '] TARAMA BAŞLADI');

    try {
        const tickers = await exchange.fetchTickers();
        DEBUG.totalTickers = Object.keys(tickers).length;

        const candidates = Object.entries(tickers)
            .filter(([symbol, ticker]) => symbol.endsWith(':USDT') && number(ticker.quoteVolume) >= CFG.MIN_VOLUME_USDT && number(ticker.last) > 0)
            .map(([symbol, ticker]) => ({ symbol, ticker }))
            .sort((a, b) => number(b.ticker.quoteVolume) - number(a.ticker.quoteVolume))
            .slice(0, CFG.MAX_CANDIDATES);

        DEBUG.volumeFiltered = candidates.length;

        for (const candidate of candidates) {
            await analyzeCandidate(candidate);
        }

        expireOldSetups();
        saveData();
        broadcast();
        printDebugReport();
    } catch (error) {
        warnOnce('Tarama', error);
    } finally {
        isScanning = false;
    }
}

// ==================== CANLI FİYAT GÜNCELLEME ====================
async function updateLivePrices() {
    if (isUpdatingPrices || isShuttingDown) return;
    isUpdatingPrices = true;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();

        for (const setup of setups) {
            if (!['WATCH','BREAKOUT','RETEST_WAIT','CONFIRMED','SIGNAL'].includes(setup.state)) continue;
            const price = number(tickers[setup.symbol]?.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;
        }

        expireOldSetups();
        saveData();
        broadcast();
    } catch (error) {
        warnOnce('Fiyat güncelleme', error);
    } finally {
        isUpdatingPrices = false;
    }
}

// ==================== GARBAGE COLLECTOR ====================
function startGarbageCollector() {
    gcTimer = setInterval(() => {
        const now = Date.now();
        recentWarnings.forEach((timestamp, key) => {
            if (now - timestamp > 30 * 60 * 1000) recentWarnings.delete(key);
        });
        saveData();
    }, 5 * 60 * 1000);
}

// ==================== API & WEBSOCKET ====================
function getSnapshot() {
    const active = setups.filter(s => ['WATCH','BREAKOUT','RETEST_WAIT','CONFIRMED','SIGNAL'].includes(s.state));
    return {
        setups,
        stats: {
            total: active.length,
            watch: active.filter(s => s.state === 'WATCH').length,
            breakout: active.filter(s => s.state === 'BREAKOUT' || s.state === 'RETEST_WAIT').length,
            signal: active.filter(s => s.state === 'SIGNAL').length
        },
        scanning: isScanning,
        updatedAt: Date.now()
    };
}

function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: getSnapshot() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch {}
        }
    });
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    next();
});

app.get('/api/setups', (req, res) => {
    res.json({ success: true, ...getSnapshot() });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, scanning: isScanning, setupCount: setups.length });
});

app.get('/api/chart', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '15m';
        const candles = await getCandles(symbol, timeframe, 100);
        const signal = setups.find(s => s.symbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ==================== FRONTEND ====================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MARKET STRUCTURE RADAR v1.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh}
@media(max-width:800px){.app{grid-template-columns:1fr}.signal-panel{display:none}}
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh}
.panel-header{padding:15px;border-bottom:1px solid #1a2533}
.panel-title{font-size:18px;font-weight:900;color:#13dba0}
.panel-sub{font-size:9px;color:#718096;margin-top:2px}
.panel-stats{display:flex;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533}
.panel-stat{flex:1;text-align:center;background:#101826;border-radius:6px;padding:6px}
.panel-stat b{display:block;font-size:18px;color:#13dba0}
.panel-stat span{font-size:8px;color:#64748b}
.signal-list{flex:1;overflow-y:auto;padding:10px}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer;transition:all .2s}
.signal-card:hover{border-color:#13dba0}
.signal-card.selected{border:2px solid #13dba0;background:#0d1a15}
.signal-card.long{border-left:5px solid #13dba0}
.signal-card.short{border-left:5px solid #ff5570}
.signal-card.signal{box-shadow:0 0 30px rgba(251,191,36,.4);border-color:#fbbf24;animation:fireGlow 1s infinite}
.signal-card.cancelled,.signal-card.expired{opacity:.35;filter:grayscale(60%)}
@keyframes fireGlow{0%,100%{box-shadow:0 0 30px rgba(251,191,36,.4)}50%{box-shadow:0 0 55px rgba(251,191,36,.6)}}
.signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.signal-coin{font-size:15px;font-weight:900;color:#e2e8f0}
.signal-direction{font-size:10px;padding:4px 12px;border-radius:15px;font-weight:900;letter-spacing:1px}
.dir-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.dir-short{background:#421d28;color:#ff5570;border:1px solid #ff5570}
.strength-badge{display:inline-block;font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold;margin-top:4px}
.strength-ultra{background:#1a0d3d;color:#a78bfa;border:1px solid #a78bfa;animation:pulse 1s infinite}
.strength-high{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.strength-good{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.signal-price{font-size:18px;font-weight:900;margin:5px 0;color:#f1f5f9}
.signal-info{display:flex;gap:8px;font-size:9px;color:#94a3b8;margin-top:5px;flex-wrap:wrap}
.signal-info b{color:#e2e8f0}
.state-badge{font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold}
.state-watch{background:#0d3d2a;color:#13dba0}
.state-breakout{background:#3d2d0d;color:#fbbf24}
.state-retest_wait{background:#3d2d0d;color:#fbbf24}
.state-confirmed{background:#0d3d2a;color:#13dba0}
.state-signal{background:#3d0d0d;color:#ff5570}
.chart-panel{background:#0b111b;display:flex;flex-direction:column;padding:15px;min-width:0}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.chart-title{font-size:16px;font-weight:900;color:#13dba0}
.tf-buttons{display:flex;gap:5px}
.tf-btn{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 10px;font-size:9px;cursor:pointer}
.tf-btn.active{color:#13dba0;border-color:#13dba0}
.chart-container{flex:1;min-height:0;position:relative}
canvas{width:100%;height:100%;display:block}
.empty{text-align:center;color:#64748b;font-size:14px;padding:40px}
.detail-panel{margin-top:10px;background:#101826;border:1px solid #1c2938;border-radius:8px;padding:12px}
.detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:10px;color:#94a3b8;border-bottom:1px solid #1a2533}
.detail-row:last-child{border-bottom:0}
.detail-row b{color:#e2e8f0}
</style>
</head>
<body>
<div class="app">
<div class="signal-panel">
<div class="panel-header">
<div class="panel-title">MARKET STRUCTURE RADAR v1.0</div>
<div class="panel-sub">4H Rejim + 1H Seviye + 15M Breakout/Retest</div>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Aktif</span></div>
<div class="panel-stat"><b id="st-watch">0</b><span>WATCH</span></div>
<div class="panel-stat"><b id="st-breakout">0</b><span>BREAKOUT</span></div>
<div class="panel-stat"><b id="st-signal">0</b><span>SIGNAL</span></div>
</div>
<div class="signal-list" id="signals"><div class="empty">Tarama başlıyor...</div></div>
</div>
<div class="chart-panel">
<div class="chart-header">
<div class="chart-title" id="chartTitle">Sinyal seçin</div>
<div class="tf-buttons">
<button class="tf-btn active" data-tf="15m">15M</button>
<button class="tf-btn" data-tf="1h">1H</button>
<button class="tf-btn" data-tf="4h">4H</button>
</div>
</div>
<div class="chart-container"><canvas id="chartCanvas"></canvas></div>
<div class="detail-panel" id="details"><div class="empty">Soldan bir kurulum seçin</div></div>
</div>
</div>
<script>
var setups=[],selectedId=null,selectedTf='15m',chartCandles=[],currentSetup=null;
function fmtPrice(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);if(x>=0.01)return x.toFixed(7);return x.toFixed(8)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function selectSetup(id){selectedId=id;currentSetup=setups.find(function(s){return s.id===id})||null;document.querySelectorAll('.signal-card').forEach(function(c){c.classList.remove('selected');if(c.getAttribute('data-id')===id)c.classList.add('selected')});var sym=currentSetup?currentSetup.symbol:'BTC/USDT:USDT';document.getElementById('chartTitle').textContent=sym.replace(':USDT','')+' - '+selectedTf.toUpperCase();showDetails();loadChart(sym)}
function showDetails(){if(!currentSetup){document.getElementById('details').innerHTML='<div class="empty">Soldan bir kurulum seçin</div>';return}var s=currentSetup;var stateNames={WATCH:'WATCH',BREAKOUT:'BREAKOUT',RETEST_WAIT:'RETEST_WAIT',CONFIRMED:'CONFIRMED',SIGNAL:'SIGNAL',CANCELLED:'CANCELLED',EXPIRED:'EXPIRED'};var st=stateNames[s.state]||s.state;document.getElementById('details').innerHTML='<div class="detail-row"><span>DURUM</span><b>'+esc(st)+'</b></div><div class="detail-row"><span>YÖN</span><b style="color:'+(s.direction==='LONG'?'#13dba0':'#ff5570')+'">'+esc(s.direction)+'</b></div><div class="detail-row"><span>SEVİYE</span><b>'+fmtPrice(s.levelPrice)+'</b></div><div class="detail-row"><span>SEVİYE KALİTESİ</span><b>'+esc(s.levelQuality)+'/100</b></div>'+(s.entry?'<div class="detail-row"><span>GİRİŞ</span><b style="color:#13dba0">'+fmtPrice(s.entry)+'</b></div>':'')+(s.stop?'<div class="detail-row"><span>STOP</span><b style="color:#ff5570">'+fmtPrice(s.stop)+'</b></div>':'')+(s.tp1?'<div class="detail-row"><span>TP1</span><b style="color:#55a7ff">'+fmtPrice(s.tp1)+'</b></div>':'')+(s.tp2?'<div class="detail-row"><span>TP2</span><b style="color:#55a7ff">'+fmtPrice(s.tp2)+'</b></div>':'')+(s.rr?'<div class="detail-row"><span>R/R</span><b style="color:#fbbf24">'+esc(s.rr.toFixed(2))+'</b></div>':'')+'<div class="detail-row"><span>SKOR</span><b style="color:#fbbf24">'+esc(s.score)+'/100</b></div><div class="detail-row"><span>NEDEN</span><b style="font-size:9px">'+esc(s.reason)+'</b></div>'}
async function loadChart(symbol){if(!symbol)return;try{var r=await fetch('/api/chart?symbol='+encodeURIComponent(symbol)+'&timeframe='+encodeURIComponent(selectedTf));var d=await r.json();if(d.success){chartCandles=d.candles||[];drawChart()}}catch(e){}}
function drawChart(){var canvas=document.getElementById('chartCanvas');if(!canvas||!chartCandles.length)return;var parent=canvas.parentElement;var w=Math.max(300,parent.clientWidth);var h=Math.max(400,parent.clientHeight);var dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#070b11';ctx.fillRect(0,0,w,h);var visible=chartCandles.slice(-60);var minPrice=Math.min.apply(Math,visible.map(function(c){return c[3]}));var maxPrice=Math.max.apply(Math,visible.map(function(c){return c[2]}));if(currentSetup){[currentSetup.levelPrice,currentSetup.entry,currentSetup.stop,currentSetup.tp1,currentSetup.tp2].forEach(function(p){if(p&&p<minPrice)minPrice=p;if(p&&p>maxPrice)maxPrice=p})}var pad=(maxPrice-minPrice)*0.08;minPrice-=pad;maxPrice+=pad;var L=50,R=120,T=15,B=15;var PW=w-L-R;var PH=h-T-B;function Y(price){return T+(maxPrice-price)/(maxPrice-minPrice)*PH}function X(i){return L+(i+0.5)*(PW/visible.length)}ctx.strokeStyle='#182330';ctx.lineWidth=1;for(var g=0;g<=4;g++){var gy=T+PH*g/4;ctx.beginPath();ctx.moveTo(L,gy);ctx.lineTo(w-R,gy);ctx.stroke();ctx.fillStyle='#607083';ctx.font='8px Arial';ctx.fillText(fmtPrice(maxPrice-(maxPrice-minPrice)*g/4),3,gy+3)}if(currentSetup){drawLevel(ctx,currentSetup.levelPrice,'#fbbf24','SEVİYE',L,w-R,Y);if(currentSetup.entry)drawLevel(ctx,currentSetup.entry,'#13dba0','GİRİŞ',L,w-R,Y);if(currentSetup.stop)drawLevel(ctx,currentSetup.stop,'#ff5570','STOP',L,w-R,Y);if(currentSetup.tp1)drawLevel(ctx,currentSetup.tp1,'#55a7ff','TP1',L,w-R,Y);if(currentSetup.tp2)drawLevel(ctx,currentSetup.tp2,'#55a7ff','TP2',L,w-R,Y)}var step=PW/visible.length;var bw=Math.max(3,Math.min(10,step*0.7));visible.forEach(function(candle,i){var xx=X(i);var up=candle[4]>=candle[1];var col=up?'#13e0a2':'#ff4d6d';ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,Y(candle[2]));ctx.lineTo(xx,Y(candle[3]));ctx.stroke();var yo=Y(candle[1]),yc=Y(candle[4]);ctx.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)))});}
function drawLevel(ctx,price,color,label,L,R,Y){if(!price)return;var yy=Y(price);ctx.strokeStyle=color;ctx.setLineDash([5,5]);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(L,yy);ctx.lineTo(R,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='bold 9px Arial';ctx.fillText(label+' '+fmtPrice(price),R+5,yy+3)}
function render(data){setups=Array.isArray(data.setups)?data.setups:[];var stats=data.stats||{};document.getElementById('st-total').textContent=stats.total||0;document.getElementById('st-watch').textContent=stats.watch||0;document.getElementById('st-breakout').textContent=stats.breakout||0;document.getElementById('st-signal').textContent=stats.signal||0;var container=document.getElementById('signals');if(!setups.length){container.innerHTML='<div class="empty">Şu an hazırlanacak kurulum yok.</div>';return}container.innerHTML=setups.map(function(s){var state=s.state.toLowerCase();var dir=s.direction==='LONG'?'long':'short';var cardClass=dir+' '+state;if(selectedId===s.id)cardClass+=' selected';return '<div class="signal-card '+cardClass+'" data-id="'+esc(s.id)+'"><div class="signal-top"><span class="signal-coin">'+esc(s.symbol.replace(':USDT',''))+'</span><span class="signal-direction '+(s.direction==='LONG'?'dir-long':'dir-short')+'">'+esc(s.direction)+'</span></div><div class="signal-price">'+fmtPrice(s.currentPrice)+'</div><div class="signal-info"><span>Seviye: <b>'+fmtPrice(s.levelPrice)+'</b></span><span>Kalite: <b>'+esc(s.levelQuality)+'</b></span><span class="state-badge state-'+state+'">'+esc(s.state)+'</span></div></div>'}).join('');document.querySelectorAll('.signal-card').forEach(function(card){card.addEventListener('click',function(){var id=this.getAttribute('data-id');if(id)selectSetup(id)})});if(selectedId){currentSetup=setups.find(function(s){return s.id===selectedId})||null;if(currentSetup)showDetails()}}
document.querySelectorAll('.tf-btn').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('.tf-btn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');selectedTf=btn.getAttribute('data-tf');if(currentSetup){document.getElementById('chartTitle').textContent=currentSetup.symbol.replace(':USDT','')+' - '+selectedTf.toUpperCase();loadChart(currentSetup.symbol)}})});
function connect(){var proto=location.protocol==='https:'?'wss://':'ws://';var ws=new WebSocket(proto+location.host);ws.onopen=function(){};ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='snapshot')render(msg.data)}catch(_){}};ws.onclose=function(){setTimeout(connect,3000)}}connect();
setInterval(function(){fetch('/api/setups',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.success)render(d)}).catch(function(){})},5000);
window.addEventListener('resize',drawChart);
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

wss.on('connection', ws => {
    ws.on('error', error => warnOnce('WebSocket', error));
    try {
        ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() }));
    } catch {}
});

// ==================== BAŞLATMA ====================
async function start() {
    try {
        await exchange.loadMarkets();
        console.log('✅ Bitget marketleri yüklendi.');
        
        if (setups.length > 0) {
            console.log('💾 ' + setups.length + ' setup yüklendi.');
        }
        
        startGarbageCollector();
        
        void runScan();
        scanTimer = setInterval(runScan, CFG.SCAN_INTERVAL_MS);
        liveTimer = setInterval(() => { void updateLivePrices(); }, CFG.LIVE_UPDATE_INTERVAL_MS);
        
        console.log('🚀 Sistem başlatıldı. Yeni strateji aktif.');
    } catch (error) {
        console.error('❌ Marketler yüklenemedi:', error.message);
        setTimeout(start, 30 * 1000);
        return;
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(scanTimer);
    clearInterval(liveTimer);
    clearInterval(gcTimer);
    console.log(signal + ' alındı; kapanıyor...');
    saveData();
    wss.clients.forEach(client => client.close(1001, 'Sunucu kapanıyor'));
    wss.close();
    server.close(async () => {
        try { await exchange.close(); } catch {}
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10 * 1000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('🌐 Market Structure Radar v1.0: http://0.0.0.0:' + PORT);
    void start();
});

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
