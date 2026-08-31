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

// ==================== SLEEP FONKSİYONU ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== JSON KALICILIK (ASENKRON) ====================
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
            setups: setups.filter(s => s.state === 'WATCH' || s.state === 'FIRE'),
            trades: tradeHistory,
            stats: dailyStats,
            savedAt: Date.now()
        };
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
            if (err) console.warn('Veri kayıt hatası:', err.message);
        });
    } catch (e) {
        console.warn('Veri hazırlama hatası:', e.message);
    }
}

// ==================== KONFİGÜRASYON (GÜÇLÜ SİNYAL ODAKLI) ====================
const CFG = {
    SCAN_INTERVAL_MS: 30 * 1000,
    LIVE_UPDATE_INTERVAL_MS: 3 * 1000,
    TIMEFRAME: '5m',
    CANDLE_LIMIT: 100,
    MIN_VOLUME_USDT: 5_000_000,
    MAX_CANDIDATES: 50,
    MAX_SETUPS: 8,
    BOX_CANDLES: 12,
    ATR_PERIOD: 14,
    COMPRESSION_RATIO_MAX: 999,
    MAX_BOX_WIDTH_PCT: 4.0,
    WATCH_DISTANCE_PCT: 1.00,
    BREAKOUT_BUFFER_PCT: 0.02,
    MIN_VOLUME_RATIO: 1.00,       // GÜÇLÜ: 1.0x hacim şart
    MIN_OI_CHANGE_PCT: 1.00,      // GÜÇLÜ: %1 OI değişimi şart
    WATCH_SCORE_MIN: 70,          // GÜÇLÜ: Minimum skor 70
    WATCH_TTL_MS: 20 * 60 * 1000,
    FIRED_TTL_MS: 15 * 60 * 1000,
    FINISHED_RETENTION_MS: 5 * 60 * 1000,
    OI_HISTORY_MS: 15 * 60 * 1000,
    OI_LOOKBACK_MS: 10 * 60 * 1000,
    STOP_ATR_BUFFER: 1.0,
    TP1_R: 1.50,
    TP2_R: 2.50,
    BTC_TREND: {
        TIMEFRAME: '15m',
        EMA_PERIOD: 50,
        STRICT_MODE: true          // GÜÇLÜ: BTC trendine tam uyum
    },
    RETEST: {
        ENABLED: false,
        MAX_WAIT_MS: 15 * 60 * 1000,
        BOUNCE_CONFIRMATION_PCT: 0.15,
        MIN_BOUNCE_CANDLES: 2
    }
};

// ==================== DEBUG ====================
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    candidatesAnalyzed: 0,
    candleFailed: 0,
    boxTooWide: 0,
    notCompressed: 0,
    volumeTooLow: 0,
    oiTooLow: 0,
    noDirection: 0,
    scoreTooLow: 0,
    setupCreated: 0,
    btcTrendBlocked: 0,
    supertrendBlocked: 0,
    nwBlocked: 0,
    emaBlocked: 0
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
    console.log('Mum Verisi Yetersiz:', DEBUG.candleFailed);
    console.log('Box Çok Geniş:', DEBUG.boxTooWide);
    console.log('Hacim Düşük:', DEBUG.volumeTooLow);
    console.log('OI Değişimi Düşük:', DEBUG.oiTooLow);
    console.log('Yön Belirsiz:', DEBUG.noDirection);
    console.log('Skor Düşük:', DEBUG.scoreTooLow);
    console.log('BTC Trend Engeli:', DEBUG.btcTrendBlocked);
    console.log('Supertrend Engeli:', DEBUG.supertrendBlocked);
    console.log('NW Engeli:', DEBUG.nwBlocked);
    console.log('EMA Engeli:', DEBUG.emaBlocked);
    console.log('--- SONUÇ ---');
    console.log('Setup Oluşturulan:', DEBUG.setupCreated);
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

const oiHistory = new Map();
const recentWarnings = new Map();
let btcTrendCache = { direction: null, updatedAt: 0, ttl: 5 * 60 * 1000 };

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

// ==================== 1. BTC TREND ====================
async function getBTCTrend() {
    const now = Date.now();
    if (btcTrendCache.direction && now - btcTrendCache.updatedAt < btcTrendCache.ttl) {
        return btcTrendCache.direction;
    }
    
    try {
        const candles = await getCandles('BTC/USDT:USDT', CFG.BTC_TREND.TIMEFRAME, 100);
        if (candles.length < 60) return 'NEUTRAL';
        
        const closes = candles.map(c => Number(c[4]));
        const ema50 = calculateEMA(closes, CFG.BTC_TREND.EMA_PERIOD);
        const currentPrice = closes[closes.length - 1];
        
        const direction = currentPrice > ema50 ? 'LONG' : currentPrice < ema50 ? 'SHORT' : 'NEUTRAL';
        btcTrendCache = { direction, updatedAt: now, ttl: btcTrendCache.ttl };
        return direction;
    } catch (error) {
        warnOnce('BTC trend', error);
        return 'NEUTRAL';
    }
}

// ==================== 2. SUPERTREND ====================
function calculateSupertrend(candles, period = 10, multiplier = 3.0) {
    if (candles.length < period + 10) return null;
    
    const closes = candles.map(c => Number(c[4]));
    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));
    
    const atrValues = [];
    for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
        atrValues.push(tr);
    }
    
    let atr = atrValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const atrSeries = [atr];
    for (let i = period; i < atrValues.length; i++) {
        atr = (atr * (period - 1) + atrValues[i]) / period;
        atrSeries.push(atr);
    }
    
    const currentATR = atrSeries[atrSeries.length - 1];
    const src = (highs[highs.length - 1] + lows[lows.length - 1]) / 2;
    
    let up = src - multiplier * currentATR;
    let dn = src + multiplier * currentATR;
    let trend = 1;
    
    for (let i = Math.max(1, candles.length - 3); i < candles.length; i++) {
        const prevUp = up;
        const prevDn = dn;
        const prevClose = closes[i - 1];
        const currentClose = closes[i];
        const srcI = (highs[i] + lows[i]) / 2;
        
        up = currentClose > prevUp ? Math.max(up, srcI - multiplier * currentATR) : srcI - multiplier * currentATR;
        dn = currentClose < prevDn ? Math.min(dn, srcI + multiplier * currentATR) : srcI + multiplier * currentATR;
        
        if (trend === -1 && currentClose > prevDn) trend = 1;
        else if (trend === 1 && currentClose < prevUp) trend = -1;
    }
    
    return {
        trend,
        direction: trend === 1 ? 'LONG' : 'SHORT',
        line: trend === 1 ? up : dn,
        atr: currentATR
    };
}

// ==================== 3. WAVETREND ====================
function calculateWaveTrend(candles, n1 = 10, n2 = 21) {
    if (candles.length < n1 + n2 + 10) return null;
    
    const closes = candles.map(c => Number(c[4]));
    const highs = candles.map(c => Number(c[2]));
    const lows = candles.map(c => Number(c[3]));
    
    const hlc3 = candles.map((c, i) => (highs[i] + lows[i] + closes[i]) / 3);
    
    function ema(values, period) {
        const multiplier = 2 / (period + 1);
        let result = values[0];
        for (let i = 1; i < values.length; i++) result = (values[i] - result) * multiplier + result;
        return result;
    }
    
    const esa = ema(hlc3, n1);
    const absDiff = hlc3.map((v, i) => Math.abs(v - esa));
    const d = ema(absDiff, n1);
    const ci = hlc3.map((v, i) => (v - esa) / (0.015 * d));
    
    const wt1Array = [];
    for (let i = n1 + n2 - 1; i < hlc3.length; i++) {
        const tempEsa = ema(hlc3.slice(0, i + 1), n1);
        const tempAbs = hlc3.slice(0, i + 1).map((v, j) => Math.abs(v - tempEsa));
        const tempD = ema(tempAbs, n1);
        const tempCi = (hlc3[i] - tempEsa) / (0.015 * tempD);
        if (wt1Array.length < n2 - 1) {
            wt1Array.push(tempCi);
        } else {
            const tempTciArray = [...wt1Array.slice(-n2 + 1), tempCi];
            wt1Array.push(ema(tempTciArray, n2));
        }
    }
    
    const currentWt1 = wt1Array[wt1Array.length - 1];
    const previousWt1 = wt1Array[wt1Array.length - 2];
    const wt2 = wt1Array.slice(-4).reduce((a, b) => a + b, 0) / 4;
    const previousWt2 = wt1Array.slice(-5, -1).reduce((a, b) => a + b, 0) / 4;
    
    return {
        wt1: currentWt1,
        wt2,
        crossUp: previousWt1 <= previousWt2 && currentWt1 > wt2,
        crossDown: previousWt1 >= previousWt2 && currentWt1 < wt2,
        overbought: currentWt1 > 60,
        oversold: currentWt1 < -60
    };
}

// ==================== 4. NADARAYA-WATSON ====================
function calculateNW(candles, bandwidth = 8, mult = 3) {
    if (candles.length < 50) return null;
    
    const closes = candles.map(c => Number(c[4]));
    
    function gauss(x, h) {
        return Math.exp(-(x * x) / (h * h * 2));
    }
    
    const lookback = Math.min(50, closes.length);
    const nweValues = [];
    
    for (let i = closes.length - lookback; i < closes.length; i++) {
        let sum = 0, sumw = 0;
        for (let j = Math.max(0, i - lookback); j < i; j++) {
            const w = gauss(i - j, bandwidth);
            sum += closes[j] * w;
            sumw += w;
        }
        nweValues.push(sum / sumw);
    }
    
    let sae = 0;
    for (let i = 0; i < lookback; i++) {
        sae += Math.abs(closes[closes.length - lookback + i] - nweValues[i]);
    }
    sae = sae / lookback * mult;
    
    const currentNWE = nweValues[nweValues.length - 1];
    const previousNWE = nweValues[nweValues.length - 2];
    const currentPrice = closes[closes.length - 1];
    const previousPrice = closes[closes.length - 2];
    
    return {
        nwe: currentNWE,
        upperBand: currentNWE + sae,
        lowerBand: currentNWE - sae,
        buySignal: currentPrice > (currentNWE - sae) && previousPrice <= (previousNWE - sae),
        sellSignal: currentPrice < (currentNWE + sae) && previousPrice >= (previousNWE + sae),
        trendUp: currentNWE > previousNWE,
        trendDown: currentNWE < previousNWE
    };
}

// ==================== 5. EMA CROSS ====================
function calculateEMACross(candles, fastPeriod = 9, slowPeriod = 21) {
    if (candles.length < slowPeriod + 10) return null;
    
    const closes = candles.map(c => Number(c[4]));
    const fastEMA = calculateEMA(closes, fastPeriod);
    const slowEMA = calculateEMA(closes, slowPeriod);
    
    const prevCloses = closes.slice(0, -1);
    const prevFastEMA = calculateEMA(prevCloses, fastPeriod);
    const prevSlowEMA = calculateEMA(prevCloses, slowPeriod);
    
    return {
        fastEMA,
        slowEMA,
        longCross: prevFastEMA <= prevSlowEMA && fastEMA > slowEMA,
        shortCross: prevFastEMA >= prevSlowEMA && fastEMA < slowEMA,
        trendUp: fastEMA > slowEMA,
        trendDown: fastEMA < slowEMA
    };
}

// ==================== HACİM ORANI ====================
function calculateVolumeRatio(candles) {
    if (candles.length < 22) return 0;
    const current = candles[candles.length - 1];
    const previous = candles.slice(-21, -1);
    const avgVolume = average(previous.map(c => Number(c[5])));
    if (!avgVolume) return 0;
    const elapsed = Date.now() - Number(current[0]);
    const progress = elapsed < 300000 ? Math.max(0.25, Math.min(1, elapsed / 300000)) : 1;
    return Number(current[5]) / progress / avgVolume;
}

// ==================== OI TAKİBİ ====================
async function getOpenInterest(symbol) {
    try {
        const result = await exchange.fetchOpenInterest(symbol);
        const value = Number(result?.openInterestAmount || result?.openInterest || 0);
        if (Number.isFinite(value) && value > 0) return value;
    } catch {}
    
    try {
        const marketSymbol = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = 'https://api.bitget.com/api/v2/mix/market/open-interest?symbol=' + encodeURIComponent(marketSymbol) + '&productType=usdt-futures';
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return 0;
        const data = await response.json();
        const item = data?.data?.openInterestList?.[0];
        const value = Number(item?.size || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

function updateOIHistory(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const now = Date.now();
    const history = oiHistory.get(symbol) || [];
    history.push({ value, timestamp: now });
    const retained = history.filter(item => now - item.timestamp <= CFG.OI_HISTORY_MS);
    oiHistory.set(symbol, retained);
    const reference = retained.filter(item => now - item.timestamp >= CFG.OI_LOOKBACK_MS).at(-1);
    if (!reference?.value) return 0;
    return number(((value - reference.value) / reference.value) * 100, 2);
}

function cleanOIHistory() {
    const cutoff = Date.now() - CFG.OI_HISTORY_MS;
    for (const [symbol, history] of oiHistory.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);
        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

// ==================== MUM VERİSİ ====================
async function getCandles(symbol, timeframe = CFG.TIMEFRAME, limit = CFG.CANDLE_LIMIT) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return Array.isArray(candles)
            ? candles.filter(c => Array.isArray(c) && c.length >= 6).sort((a, b) => a[0] - b[0])
            : [];
    } catch (error) {
        warnOnce('Mum verisi (' + symbol + ')', error);
        return [];
    }
}

// ==================== SETUP OLUŞTURMA ====================
function buildSetup(direction, symbol, price, data) {
    const isLong = direction === 'LONG';
    const trigger = isLong ? data.boxHigh * (1 + CFG.BREAKOUT_BUFFER_PCT / 100) : data.boxLow * (1 - CFG.BREAKOUT_BUFFER_PCT / 100);
    const stop = isLong ? data.boxLow - data.atr * CFG.STOP_ATR_BUFFER : data.boxHigh + data.atr * CFG.STOP_ATR_BUFFER;
    const risk = Math.abs(trigger - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    
    const tp1 = isLong ? trigger + risk * CFG.TP1_R : trigger - risk * CFG.TP1_R;
    const tp2 = isLong ? trigger + risk * CFG.TP2_R : trigger - risk * CFG.TP2_R;

    return {
        id: symbol + ':' + direction,
        symbol,
        direction,
        state: 'WATCH',
        currentPrice: price,
        trigger,
        stop,
        tp1,
        tp2,
        boxHigh: data.boxHigh,
        boxLow: data.boxLow,
        boxWidthPct: number(data.boxWidthPct, 2),
        compressionRatio: number(data.compressionRatio || 1, 2),
        volumeRatio: number(data.volumeRatio, 2),
        oiChangePct: data.oiChangePct,
        score: data.score,
        reason: data.reason,
        strengthLabel: data.strengthLabel,
        strengthClass: data.strengthClass,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    };
}

// ==================== ANALİZ ====================
async function analyzeCandidate(candidate) {
    await sleep(200);
    
    DEBUG.candidatesAnalyzed++;
    
    const candles = await getCandles(candidate.symbol);
    if (candles.length < 50) {
        DEBUG.candleFailed++;
        return [];
    }
    
    const closed = candles.slice(0, -1);
    const currentPrice = number(candidate.ticker.last);
    if (!currentPrice || closed.length < 40) {
        DEBUG.candleFailed++;
        return [];
    }

    const box = closed.slice(-CFG.BOX_CANDLES);
    const boxHigh = Math.max(...box.map(c => Number(c[2])));
    const boxLow = Math.min(...box.map(c => Number(c[3])));
    const boxWidthPct = (boxHigh - boxLow) / boxHigh * 100;
    
    if (boxWidthPct > CFG.MAX_BOX_WIDTH_PCT) {
        DEBUG.boxTooWide++;
        return [];
    }

    const recentATR = calculateATR(closed.slice(-20)) || calculateATR(closed.slice(-14)) || 0;
    const compressionRatio = 1;

    const closes = closed.map(c => Number(c[4]));
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const volumeRatio = calculateVolumeRatio(candles);

    if (volumeRatio < CFG.MIN_VOLUME_RATIO) {
        DEBUG.volumeTooLow++;
        return [];
    }

    const longDistance = (boxHigh - currentPrice) / boxHigh * 100;
    const shortDistance = (currentPrice - boxLow) / boxLow * 100;

    const candidates = [];
    if (longDistance >= 0 && longDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'LONG', distancePct: longDistance, trendAligned: ema20 > ema50 });
    }
    if (shortDistance >= 0 && shortDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'SHORT', distancePct: shortDistance, trendAligned: ema20 < ema50 });
    }
    
    if (!candidates.length) {
        DEBUG.noDirection++;
        return [];
    }

    const oi = await getOpenInterest(candidate.symbol);
    const oiChangePct = updateOIHistory(candidate.symbol, oi);

    if (Math.abs(oiChangePct) < CFG.MIN_OI_CHANGE_PCT) {
        DEBUG.oiTooLow++;
        return [];
    }

    const btcTrend = await getBTCTrend();
    const supertrend = calculateSupertrend(candles);
    const waveTrend = calculateWaveTrend(candles);
    const nw = calculateNW(candles);
    const emaCross = calculateEMACross(candles);

    if (!supertrend || !waveTrend || !nw || !emaCross) {
        DEBUG.candleFailed++;
        return [];
    }

    const results = [];
    for (const item of candidates) {
        let score = 0;
        const reasons = [];

        // BTC TREND FİLTRESİ - STRICT MODE
        if (CFG.BTC_TREND.STRICT_MODE && btcTrend !== 'NEUTRAL' && item.direction !== btcTrend) {
            DEBUG.btcTrendBlocked++;
            continue;
        }

        // Supertrend - ZORUNLU
        if (supertrend.direction !== item.direction) {
            DEBUG.supertrendBlocked++;
            continue;
        }
        score += 25;
        reasons.push('Supertrend');

        // WaveTrend - ZORUNLU
        if (item.direction === 'LONG' && (waveTrend.crossUp || waveTrend.wt1 > 0)) {
            score += 20;
            reasons.push('WaveTrend LONG');
        } else if (item.direction === 'SHORT' && (waveTrend.crossDown || waveTrend.wt1 < 0)) {
            score += 20;
            reasons.push('WaveTrend SHORT');
        } else {
            continue;
        }

        // Nadaraya-Watson - ZORUNLU
        if (item.direction === 'LONG' && (nw.buySignal || nw.trendUp)) {
            score += 20;
            reasons.push('NW LONG');
        } else if (item.direction === 'SHORT' && (nw.sellSignal || nw.trendDown)) {
            score += 20;
            reasons.push('NW SHORT');
        } else {
            DEBUG.nwBlocked++;
            continue;
        }

        // EMA Cross - ZORUNLU
        if (item.direction === 'LONG' && (emaCross.longCross || emaCross.trendUp)) {
            score += 15;
            reasons.push('EMA LONG');
        } else if (item.direction === 'SHORT' && (emaCross.shortCross || emaCross.trendDown)) {
            score += 15;
            reasons.push('EMA SHORT');
        } else {
            DEBUG.emaBlocked++;
            continue;
        }

        // Hacim - ZATEN FİLTRELENDİ
        if (volumeRatio >= 2.0) {
            score += 15;
            reasons.push('Hacim ' + volumeRatio.toFixed(1) + 'x');
        } else {
            score += 10;
            reasons.push('Hacim ' + volumeRatio.toFixed(1) + 'x');
        }

        // OI - ZATEN FİLTRELENDİ
        if (Math.abs(oiChangePct) >= 2.0) {
            score += 10;
            reasons.push('OI ' + oiChangePct.toFixed(2) + '%');
        } else {
            score += 5;
            reasons.push('OI ' + oiChangePct.toFixed(2) + '%');
        }

        if (item.trendAligned) {
            score += 5;
            reasons.push('Trend uyumu');
        }

        if (score < CFG.WATCH_SCORE_MIN) {
            DEBUG.scoreTooLow++;
            continue;
        }

        let strengthLabel, strengthClass;
        if (score >= 90) {
            strengthLabel = '🔥🔥🔥 ULTRA';
            strengthClass = 'strength-ultra';
        } else if (score >= 80) {
            strengthLabel = '🔥🔥 GÜÇLÜ';
            strengthClass = 'strength-high';
        } else {
            strengthLabel = '💪 İYİ';
            strengthClass = 'strength-good';
        }

        const setup = buildSetup(item.direction, candidate.symbol, currentPrice, {
            boxHigh, boxLow, boxWidthPct, compressionRatio, volumeRatio, oiChangePct,
            score: Math.min(score, 100), atr: recentATR,
            reason: reasons.join(' · '),
            strengthLabel, strengthClass
        });
        
        if (setup) {
            DEBUG.setupCreated++;
            results.push(setup);
        }
    }
    
    if (results.length > 1) {
        results.sort((a, b) => b.score - a.score);
        return [results[0]];
    }
    
    return results;
}

// ==================== TOPLU TARAMA ====================
async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index]);
        }
    });
    await Promise.all(workers);
    return results.flat();
}

function upsertSetup(nextSetup) {
    const existingIndex = setups.findIndex(s => s.id === nextSetup.id);
    
    if (existingIndex === -1) {
        setups.unshift(nextSetup);
        return;
    }
    
    const existing = setups[existingIndex];
    if (existing.state === 'FIRE') return;
    
    setups[existingIndex] = {
        ...existing,
        ...nextSetup,
        state: 'WATCH',
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    };
}

function expireOldSetups() {
    const now = Date.now();
    setups.forEach(setup => {
        if (setup.state === 'WATCH' && now > setup.expiresAt) {
            setup.state = 'CANCEL';
            setup.cancelReason = 'Süre doldu';
            setup.finishedAt = now;
        }
        if (setup.state === 'FIRE' && setup.firedAt && now - setup.firedAt > CFG.FIRED_TTL_MS) {
            setup.state = 'EXPIRED';
            setup.cancelReason = 'FIRE süresi doldu';
            setup.finishedAt = now;
        }
    });
    
    setups = setups
        .filter(s => !s.finishedAt || now - s.finishedAt < CFG.FINISHED_RETENTION_MS)
        .sort((a, b) => {
            const order = { FIRE: 0, WATCH: 1, CANCEL: 2, EXPIRED: 3 };
            return order[a.state] - order[b.state];
        })
        .slice(0, CFG.MAX_SETUPS);
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
        
        const discovered = await mapWithConcurrency(candidates, 2, analyzeCandidate);
        discovered.sort((a, b) => b.score - a.score).slice(0, CFG.MAX_SETUPS).forEach(upsertSetup);

        cleanOIHistory();
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
        let changed = false;

        for (const setup of setups) {
            if (setup.state !== 'WATCH' && setup.state !== 'FIRE') continue;
            
            const price = number(tickers[setup.symbol]?.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;

            if (setup.state === 'WATCH') {
                const fired = setup.direction === 'LONG' ? price >= setup.trigger : price <= setup.trigger;
                
                if (fired) {
                    setup.state = 'FIRE';
                    setup.firedAt = now;
                    setup.firePrice = price;
                    changed = true;
                    console.log('🔥 FIRE ' + setup.direction + ' | ' + setup.symbol + ' | ' + formatPrice(price));
                }
            }
        }
        
        expireOldSetups();
        if (changed) {
            saveData();
            broadcast();
        }
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
        cleanOIHistory();
        recentWarnings.forEach((timestamp, key) => {
            if (now - timestamp > 30 * 60 * 1000) recentWarnings.delete(key);
        });
        if (now - btcTrendCache.updatedAt > btcTrendCache.ttl * 2) {
            btcTrendCache.direction = null;
        }
        saveData();
    }, 5 * 60 * 1000);
}

// ==================== API & WEBSOCKET ====================
function getSnapshot() {
    const active = setups.filter(s => s.state === 'WATCH' || s.state === 'FIRE');
    return {
        setups,
        stats: {
            total: active.length,
            watch: active.filter(s => s.state === 'WATCH').length,
            fire: active.filter(s => s.state === 'FIRE').length
        },
        btcTrend: btcTrendCache.direction || 'NEUTRAL',
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
        const timeframe = req.query.timeframe || '5m';
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
<title>MANUAL BREAKOUT RADAR v3.3</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh}
@media(max-width:800px){.app{grid-template-columns:1fr}.signal-panel{display:none}}
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh}
.panel-header{padding:15px;border-bottom:1px solid #1a2533}
.panel-title{font-size:18px;font-weight:900;color:#13dba0}
.panel-sub{font-size:9px;color:#718096;margin-top:2px}
.panel-btc{display:flex;align-items:center;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533;background:#0d1520}
.panel-btc .btc-label{font-size:10px;color:#64748b}
.panel-btc .btc-trend{font-size:12px;font-weight:900;padding:4px 12px;border-radius:15px}
.btc-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.btc-short{background:#421d28;color:#ff5570;border:1px solid #ff5570}
.btc-neutral{background:#1e293b;color:#94a3b8;border:1px solid #64748b}
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
.signal-card.fire{box-shadow:0 0 30px rgba(251,191,36,.4);border-color:#fbbf24;animation:fireGlow 1s infinite}
.signal-card.cancel,.signal-card.expired{opacity:.35;filter:grayscale(60%)}
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
.state-fire{background:#3d2d0d;color:#fbbf24}
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
<div class="panel-title">MANUAL BREAKOUT RADAR v3.3</div>
<div class="panel-sub">GÜÇLÜ SİNYAL MODU | BTC Trend Uyumlu</div>
</div>
<div class="panel-btc">
<span class="btc-label">BTC TREND:</span>
<span class="btc-trend btc-neutral" id="btcTrend">BEKLENİYOR</span>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Aktif</span></div>
<div class="panel-stat"><b id="st-watch">0</b><span>WATCH</span></div>
<div class="panel-stat"><b id="st-fire">0</b><span>FIRE</span></div>
</div>
<div class="signal-list" id="signals"><div class="empty">Tarama başlıyor...</div></div>
</div>
<div class="chart-panel">
<div class="chart-header">
<div class="chart-title" id="chartTitle">Sinyal seçin</div>
<div class="tf-buttons">
<button class="tf-btn active" data-tf="5m">5M</button>
<button class="tf-btn" data-tf="15m">15M</button>
<button class="tf-btn" data-tf="1h">1H</button>
</div>
</div>
<div class="chart-container"><canvas id="chartCanvas"></canvas></div>
<div class="detail-panel" id="details"><div class="empty">Soldan bir kurulum seçin</div></div>
</div>
</div>
<script>
var setups=[],selectedId=null,selectedTf='5m',chartCandles=[],currentSetup=null;
function fmtPrice(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);if(x>=0.01)return x.toFixed(7);return x.toFixed(8)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function selectSetup(id){selectedId=id;currentSetup=setups.find(function(s){return s.id===id})||null;document.querySelectorAll('.signal-card').forEach(function(c){c.classList.remove('selected');if(c.getAttribute('data-id')===id)c.classList.add('selected')});var sym=currentSetup?currentSetup.symbol:'BTC/USDT:USDT';document.getElementById('chartTitle').textContent=sym.replace(':USDT','')+' - '+selectedTf.toUpperCase();showDetails();loadChart(sym)}
function showDetails(){if(!currentSetup){document.getElementById('details').innerHTML='<div class="empty">Soldan bir kurulum seçin</div>';return}var s=currentSetup;var st=s.state==='FIRE'?'🔥 FIRE - GİRİŞ!':s.state==='WATCH'?'👀 WATCH - HAZIR':s.state;document.getElementById('details').innerHTML='<div class="detail-row"><span>DURUM</span><b>'+esc(st)+'</b></div><div class="detail-row"><span>YÖN</span><b style="color:'+(s.direction==='LONG'?'#13dba0':'#ff5570')+'">'+esc(s.direction)+'</b></div><div class="detail-row"><span>GÜÇ</span><b>'+esc(s.strengthLabel)+'</b></div><div class="detail-row"><span>GİRİŞ TETİĞİ</span><b style="color:#13dba0">'+fmtPrice(s.trigger)+'</b></div><div class="detail-row"><span>STOP</span><b style="color:#ff5570">'+fmtPrice(s.stop)+'</b></div><div class="detail-row"><span>TP1</span><b style="color:#55a7ff">'+fmtPrice(s.tp1)+'</b></div><div class="detail-row"><span>TP2</span><b style="color:#55a7ff">'+fmtPrice(s.tp2)+'</b></div><div class="detail-row"><span>SKOR</span><b style="color:#fbbf24">'+esc(s.score)+'/100</b></div><div class="detail-row"><span>NEDEN</span><b style="font-size:9px">'+esc(s.reason)+'</b></div>'}
async function loadChart(symbol){if(!symbol)return;try{var r=await fetch('/api/chart?symbol='+encodeURIComponent(symbol)+'&timeframe='+encodeURIComponent(selectedTf));var d=await r.json();if(d.success){chartCandles=d.candles||[];drawChart()}}catch(e){}}
function drawChart(){var canvas=document.getElementById('chartCanvas');if(!canvas||!chartCandles.length)return;var parent=canvas.parentElement;var w=Math.max(300,parent.clientWidth);var h=Math.max(400,parent.clientHeight);var dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#070b11';ctx.fillRect(0,0,w,h);var visible=chartCandles.slice(-60);var minPrice=Math.min.apply(Math,visible.map(function(c){return c[3]}));var maxPrice=Math.max.apply(Math,visible.map(function(c){return c[2]}));if(currentSetup){[currentSetup.trigger,currentSetup.stop,currentSetup.tp1,currentSetup.tp2,currentSetup.boxHigh,currentSetup.boxLow].forEach(function(p){if(p&&p<minPrice)minPrice=p;if(p&&p>maxPrice)maxPrice=p})}var pad=(maxPrice-minPrice)*0.08;minPrice-=pad;maxPrice+=pad;var L=50,R=120,T=15,B=15;var PW=w-L-R;var PH=h-T-B;function Y(price){return T+(maxPrice-price)/(maxPrice-minPrice)*PH}function X(i){return L+(i+0.5)*(PW/visible.length)}ctx.strokeStyle='#182330';ctx.lineWidth=1;for(var g=0;g<=4;g++){var gy=T+PH*g/4;ctx.beginPath();ctx.moveTo(L,gy);ctx.lineTo(w-R,gy);ctx.stroke();ctx.fillStyle='#607083';ctx.font='8px Arial';ctx.fillText(fmtPrice(maxPrice-(maxPrice-minPrice)*g/4),3,gy+3)}if(currentSetup){ctx.fillStyle='rgba(251,191,36,0.05)';ctx.fillRect(X(visible.length-12),Y(currentSetup.boxHigh),(X(visible.length-1)-X(visible.length-12)),Y(currentSetup.boxLow)-Y(currentSetup.boxHigh));ctx.strokeStyle='rgba(251,191,36,0.8)';ctx.lineWidth=2;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(X(visible.length-12),Y(currentSetup.boxHigh));ctx.lineTo(X(visible.length-1),Y(currentSetup.boxHigh));ctx.stroke();ctx.beginPath();ctx.moveTo(X(visible.length-12),Y(currentSetup.boxLow));ctx.lineTo(X(visible.length-1),Y(currentSetup.boxLow));ctx.stroke();ctx.setLineDash([])}var step=PW/visible.length;var bw=Math.max(3,Math.min(10,step*0.7));visible.forEach(function(candle,i){var xx=X(i);var up=candle[4]>=candle[1];var col=up?'#13e0a2':'#ff4d6d';ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(xx,Y(candle[2]));ctx.lineTo(xx,Y(candle[3]));ctx.stroke();var yo=Y(candle[1]),yc=Y(candle[4]);ctx.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)))});if(currentSetup){drawLevel(ctx,currentSetup.trigger,'#13dba0','TETIK',L,w-R,Y);drawLevel(ctx,currentSetup.stop,'#ff5570','STOP',L,w-R,Y);drawLevel(ctx,currentSetup.tp1,'#55a7ff','TP1',L,w-R,Y);drawLevel(ctx,currentSetup.tp2,'#55a7ff','TP2',L,w-R,Y)}}
function drawLevel(ctx,price,color,label,L,R,Y){if(!price)return;var yy=Y(price);ctx.strokeStyle=color;ctx.setLineDash([5,5]);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(L,yy);ctx.lineTo(R,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='bold 9px Arial';ctx.fillText(label+' '+fmtPrice(price),R+5,yy+3)}
function render(data){setups=Array.isArray(data.setups)?data.setups:[];var stats=data.stats||{};document.getElementById('st-total').textContent=stats.total||0;document.getElementById('st-watch').textContent=stats.watch||0;document.getElementById('st-fire').textContent=stats.fire||0;var btcEl=document.getElementById('btcTrend');var btcTrend=data.btcTrend||'NEUTRAL';btcEl.textContent=btcTrend==='LONG'?'🟢 LONG MODU':btcTrend==='SHORT'?'🔴 SHORT MODU':'⚪ NÖTR';btcEl.className='btc-trend '+(btcTrend==='LONG'?'btc-long':btcTrend==='SHORT'?'btc-short':'btc-neutral');var container=document.getElementById('signals');if(!setups.length){container.innerHTML='<div class="empty">Şu an güçlü kurulum yok.</div>';return}container.innerHTML=setups.map(function(s){var state=s.state.toLowerCase();var dir=s.direction==='LONG'?'long':'short';var cardClass=dir+' '+state;if(selectedId===s.id)cardClass+=' selected';return '<div class="signal-card '+cardClass+'" data-id="'+esc(s.id)+'"><div class="signal-top"><span class="signal-coin">'+esc(s.symbol.replace(':USDT',''))+'</span><span class="signal-direction '+(s.direction==='LONG'?'dir-long':'dir-short')+'">'+esc(s.direction)+'</span></div><div class="strength-badge '+esc(s.strengthClass)+'">'+esc(s.strengthLabel)+'</div><div class="signal-price">'+fmtPrice(s.currentPrice)+'</div><div class="signal-info"><span>Skor: <b>'+esc(s.score)+'</b></span><span>Hacim: <b>'+esc(s.volumeRatio)+'x</b></span><span>OI: <b>%'+esc(s.oiChangePct)+'</b></span><span class="state-badge state-'+state+'">'+esc(s.state)+'</span></div></div>'}).join('');document.querySelectorAll('.signal-card').forEach(function(card){card.addEventListener('click',function(){var id=this.getAttribute('data-id');if(id)selectSetup(id)})});if(selectedId){currentSetup=setups.find(function(s){return s.id===selectedId})||null;if(currentSetup)showDetails()}}
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
        
        console.log('🚀 Sistem başlatıldı. GÜÇLÜ SİNYAL MODU aktif.');
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
    console.log('🌐 Manual Breakout Radar v3.3: http://0.0.0.0:' + PORT);
    void start();
});

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
