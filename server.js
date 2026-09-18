'use strict';

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ============================================================
// SONER TRADE v1.2
// Breakout + Retest + Açık Türkçe Arayüz
// ============================================================

const CONFIG = {
    TIMEFRAME: '15m',
    HTF_TREND: '1h',
    HTF_BIAS: '4h',
    CANDLE_LIMIT: 200,

    BREAKOUT_LOOKBACK: 20,
    MIN_VOLUME_MULTIPLIER: 2.0,
    MIN_BREAKOUT_BUFFER: 0.001,
    MIN_BODY_ATR_RATIO: 0.40,

    RETEST_MAX_CANDLES: 8,
    RETEST_TOLERANCE: 0.004,
    RETEST_MIN_VOLUME: 1.0,
    RETEST_MIN_BODY_ATR: 0.20,

    VOLUME_LOOKBACK: 5,
    VOLUME_AVG_PERIOD: 30,
    VOLUME_SPIKE_MULT: 3.0,
    PRICE_FLAT_THRESHOLD: 0.8,
    MIN_EARLY_WARNINGS: 2,
    MIN_EARLY_VOLUME: 1.8,
    MIN_DIRECTION_CONFIDENCE: 65,

    BB_PERIOD: 20,
    BB_STDDEV: 2,

    FUNDING_EXTREME: 0.001,

    RSI_PERIOD: 14,
    EMA_FAST: 21,
    EMA_SLOW: 50,
    EMA_TREND: 200,

    ATR_PERIOD: 14,
    STOP_ATR_MULT: 1.0,
    TP1_RR: 1.5,
    TP2_RR: 3.0,

    SIGNAL_VALID_MS: 4 * 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 45 * 60 * 1000,

    MIN_QUALITY_SCORE: 60,

    MIN_24H_VOLUME_USDT: 3000000,
    MAX_TARGETS: 200,

    EXCLUDED_BASES: [
        'USDC', 'USDT', 'DAI', 'TUSD', 'BUSD', 'FDUSD',
        'WBTC', 'WETH', 'WSTETH', 'STETH'
    ],

    SCAN_INTERVAL_MS: 2 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    LIVE_INTERVAL_MS: 5000,
    MARKET_STATUS_INTERVAL_MS: 60 * 1000,
    API_DELAY_MS: 120,

    MAX_SIGNALS_KEPT: 100,
    DEBUG: true
};

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 250,
    options: { defaultType: 'swap' }
});

let targets = [];
let signals = [];
let pendingBreakouts = [];
let marketStatus = { btc: null, eth: null, overall: 'UNKNOWN', score: 0, updatedAt: 0 };
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;

const lastSignalTime = new Map();

const APP_STATE = {
    scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false },
    updatedAt: Date.now()
};

const DEBUG = {
    scanned: 0, signals: 0,
    earlyWarnings: 0, retestSignals: 0,
    long: 0, short: 0,
    rejectedQuality: 0,
    fakeouts: 0,
    timeouts: 0,
    rejected: 0, errors: 0
};

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d = 8) {
    const n = Number(v);
    return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function sma(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    return arr.reduce((a, b) => a + b, 0) / period;
}

function stddev(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / period;
    const variance = arr.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / period;
    return Math.sqrt(variance);
}

function ema(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.map(Number);
    if (arr.some(v => !Number.isFinite(v))) return null;
    let r = sma(arr.slice(0, period), period);
    if (r == null) return null;
    const k = 2 / (period + 1);
    for (let i = period; i < arr.length; i++) r = arr[i] * k + r * (1 - k);
    return r;
}

function atr(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i][2]);
        const l = Number(candles[i][3]);
        const pc = Number(candles[i - 1][4]);
        if (![h, l, pc].every(Number.isFinite)) continue;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return sma(trs, period);
}

function rsi(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        g = (g * (period - 1) + Math.max(0, d)) / period;
        l = (l * (period - 1) + Math.max(0, -d)) / period;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
}

function closedCandles(ohlcv) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return [];
    return ohlcv.slice(0, -1).filter(c => Array.isArray(c) && c.length >= 6);
}

function isExcluded(symbol) {
    const base = symbol.split('/')[0].toUpperCase();
    for (const ex of CONFIG.EXCLUDED_BASES) {
        if (base === ex) return true;
    }
    return false;
}

function bollingerBands(closes, period, mult) {
    if (closes.length < period) return null;
    const mid = sma(closes, period);
    if (!mid) return null;
    const sd = stddev(closes, period);
    if (!sd) return null;
    return {
        upper: mid + sd * mult,
        middle: mid,
        lower: mid - sd * mult,
        width: (mid + sd * mult) - (mid - sd * mult),
        widthPercent: ((mid + sd * mult) - (mid - sd * mult)) / mid * 100
    };
}

// ============================================================
// HTF TREND
// ============================================================

async function getHTFTrend(symbol) {
    try {
        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.HTF_TREND, undefined, CONFIG.EMA_TREND + 30
        );
        const candles = closedCandles(raw);
        const closes = candles.map(c => Number(c[4]));
        if (closes.length < CONFIG.EMA_TREND) return { trend: 'UNKNOWN', ema200: null, price: null };
        const ema200 = ema(closes, CONFIG.EMA_TREND);
        const last = closes[closes.length - 1];
        let trend = 'SIDEWAYS';
        if (last > ema200 * 1.002) trend = 'BULLISH';
        else if (last < ema200 * 0.998) trend = 'BEARISH';
        return { trend, ema200: num(ema200), price: num(last) };
    } catch {
        return { trend: 'UNKNOWN', ema200: null, price: null };
    }
}

async function getBias(symbol) {
    try {
        const raw = await exchange.fetchOHLCV(symbol, CONFIG.HTF_BIAS, undefined, 60);
        const candles = closedCandles(raw);
        const closes = candles.map(c => Number(c[4]));
        const ema21 = ema(closes, 21);
        const ema50 = ema(closes, 50);
        if (!ema21 || !ema50) return 'UNKNOWN';
        if (ema21 > ema50 * 1.001) return 'BULLISH';
        if (ema21 < ema50 * 0.999) return 'BEARISH';
        return 'SIDEWAYS';
    } catch {
        return 'UNKNOWN';
    }
}

// ============================================================
// MARKET STATUS
// ============================================================

async function updateMarketStatus() {
    try {
        const btc = await getHTFTrend('BTC/USDT:USDT');
        const eth = await getHTFTrend('ETH/USDT:USDT');

        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'];
        const ethT = tickers['ETH/USDT:USDT'];

        const btcChg = btcT ? Number(btcT.percentage) : 0;
        const ethChg = ethT ? Number(ethT.percentage) : 0;

        let score = 0;
        if (btc.trend === 'BULLISH') score += 2;
        else if (btc.trend === 'BEARISH') score -= 2;
        if (eth.trend === 'BULLISH') score += 2;
        else if (eth.trend === 'BEARISH') score -= 2;

        if (Number.isFinite(btcChg)) {
            if (btcChg > 2) score += 2;
            else if (btcChg > 0.5) score += 1;
            else if (btcChg < -2) score -= 2;
            else if (btcChg < -0.5) score -= 1;
        }
        if (Number.isFinite(ethChg)) {
            if (ethChg > 2) score += 2;
            else if (ethChg > 0.5) score += 1;
            else if (ethChg < -2) score -= 2;
            else if (ethChg < -0.5) score -= 1;
        }

        let overall;
        if (score >= 5) overall = 'BULLISH';
        else if (score >= 2) overall = 'BULLISH_WEAK';
        else if (score <= -5) overall = 'BEARISH';
        else if (score <= -2) overall = 'BEARISH_WEAK';
        else overall = 'MIXED';

        marketStatus = {
            btc: {
                trend: btc.trend,
                price: btcT ? num(btcT.last) : null,
                change24h: Number.isFinite(btcChg) ? num(btcChg, 2) : null
            },
            eth: {
                trend: eth.trend,
                price: ethT ? num(ethT.last) : null,
                change24h: Number.isFinite(ethChg) ? num(ethChg, 2) : null
            },
            overall,
            score,
            updatedAt: Date.now()
        };

        broadcast();
    } catch (err) {
        console.error(`[marketStatus] ${err.message}`);
    }
}

// ============================================================
// ERKEN UYARI
// ============================================================

function detectEarlyWarning(candles, closes, currentPrice, volumeRatio) {
    const warnings = [];

    const recent = candles.slice(-CONFIG.VOLUME_LOOKBACK);
    if (recent.length >= 2) {
        const recentHigh = Math.max(...recent.map(c => Number(c[2])));
        const recentLow = Math.min(...recent.map(c => Number(c[3])));
        const priceRange = ((recentHigh - recentLow) / recentLow) * 100;

        if (volumeRatio >= CONFIG.VOLUME_SPIKE_MULT && priceRange < CONFIG.PRICE_FLAT_THRESHOLD) {
            warnings.push({
                type: 'VOLUME_SPIKE',
                strength: volumeRatio,
                desc: `Hacim ${volumeRatio.toFixed(1)}x patladi (fiyat yatay)`
            });
        }
    }

    const bb = bollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STDDEV);
    if (bb) {
        const bbWidths = [];
        for (let i = CONFIG.BB_PERIOD; i < closes.length; i++) {
            const slice = closes.slice(0, i + 1);
            const b = bollingerBands(slice, CONFIG.BB_PERIOD, CONFIG.BB_STDDEV);
            if (b) bbWidths.push(b.widthPercent);
        }
        if (bbWidths.length >= 20) {
            const sorted = bbWidths.slice().sort((a, b) => a - b);
            const threshold = sorted[Math.floor(sorted.length * 0.2)];
            if (bb.widthPercent <= threshold) {
                warnings.push({
                    type: 'BB_SQUEEZE',
                    strength: 1,
                    desc: `Fiyat çok sıkıştı (büyük hareket yakın)`
                });
            }
        }
    }

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    if (ema20 && ema50) {
        const dist20 = Math.abs(currentPrice - ema20) / currentPrice * 100;
        if (dist20 < 0.5 && Math.abs(ema20 - ema50) / ema50 < 0.3) {
            warnings.push({
                type: 'EMA_COIL',
                strength: 1,
                desc: `Fiyat ortalamaya yapıştı (hareket hazır)`
            });
        }
    }

    return warnings;
}

function predictDirection(closes, currentPrice, trend, htfTrend, fundingRate) {
    let upScore = 0;
    let downScore = 0;
    const reasons = [];

    if (trend === 'BULLISH') { upScore += 2; reasons.push('1 saatlik yön YUKARI'); }
    else if (trend === 'BEARISH') { downScore += 2; reasons.push('1 saatlik yön AŞAĞI'); }

    if (htfTrend === 'BULLISH') { upScore += 2; reasons.push('4 saatlik yön YUKARI'); }
    else if (htfTrend === 'BEARISH') { downScore += 2; reasons.push('4 saatlik yön AŞAĞI'); }

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    if (ema20 && ema50) {
        if (ema20 > ema50) { upScore += 1; reasons.push('Kısa ortalama uzunu geçmiş (yukarı)'); }
        else if (ema20 < ema50) { downScore += 1; reasons.push('Kısa ortalama uzunun altında (aşağı)'); }
    }

    if (ema20) {
        if (currentPrice > ema20) { upScore += 1; reasons.push('Fiyat ortalamanın üstünde'); }
        else { downScore += 1; reasons.push('Fiyat ortalamanın altında'); }
    }

    const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);
    if (rsiValue != null) {
        if (rsiValue > 55) { upScore += 1; reasons.push(`Momentum güçlü (RSI ${rsiValue.toFixed(0)})`); }
        else if (rsiValue < 45) { downScore += 1; reasons.push(`Momentum zayıf (RSI ${rsiValue.toFixed(0)})`); }
    }

    if (fundingRate != null) {
        if (fundingRate > CONFIG.FUNDING_EXTREME) {
            downScore += 2;
            reasons.push(`Long'cular çok fazla (düşüş riski)`);
        } else if (fundingRate < -CONFIG.FUNDING_EXTREME) {
            upScore += 2;
            reasons.push(`Short'çular çok fazla (yükseliş riski)`);
        }
    }

    const total = upScore + downScore;
    if (total === 0) return { direction: 'UNCERTAIN', confidence: 0, reasons };

    const upPct = Math.round((upScore / total) * 100);
    const downPct = 100 - upPct;

    if (upPct > downPct) return { direction: 'UP', confidence: upPct, reasons };
    return { direction: 'DOWN', confidence: downPct, reasons };
}

async function getFundingRate(symbol) {
    try {
        if (typeof exchange.fetchFundingRate !== 'function') return null;
        const data = await exchange.fetchFundingRate(symbol);
        if (data && Number.isFinite(data.fundingRate)) return data.fundingRate;
        return null;
    } catch {
        return null;
    }
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQualityScore({ direction, trend, htfTrend, volumeRatio, rsiValue, fundingRate, distFromLevel, bodyRatio }) {
    let score = 0;
    const breakdown = [];

    // 1) Trend uyumu (20)
    if (direction === 'LONG') {
        if (htfTrend === 'BULLISH' && trend === 'BULLISH') { score += 20; breakdown.push('✅ Piyasa yönü yukarı (+20)'); }
        else if (htfTrend === 'BULLISH' || trend === 'BULLISH') { score += 12; breakdown.push('🟡 Yön kısmen yukarı (+12)'); }
        else if (htfTrend === 'SIDEWAYS' || trend === 'SIDEWAYS') { score += 6; breakdown.push('⚪ Yön belirsiz (+6)'); }
        else { breakdown.push('❌ Yön aşağı (ters) (+0)'); }
    } else {
        if (htfTrend === 'BEARISH' && trend === 'BEARISH') { score += 20; breakdown.push('✅ Piyasa yönü aşağı (+20)'); }
        else if (htfTrend === 'BEARISH' || trend === 'BEARISH') { score += 12; breakdown.push('🟡 Yön kısmen aşağı (+12)'); }
        else if (htfTrend === 'SIDEWAYS' || trend === 'SIDEWAYS') { score += 6; breakdown.push('⚪ Yön belirsiz (+6)'); }
        else { breakdown.push('❌ Yön yukarı (ters) (+0)'); }
    }

    // 2) Hacim (20)
    if (volumeRatio >= 3.5) { score += 20; breakdown.push(`✅ Çok güçlü hacim ${volumeRatio.toFixed(1)}x (+20)`); }
    else if (volumeRatio >= 2.5) { score += 15; breakdown.push(`✅ Güçlü hacim ${volumeRatio.toFixed(1)}x (+15)`); }
    else if (volumeRatio >= 2.0) { score += 10; breakdown.push(`🟡 Orta hacim ${volumeRatio.toFixed(1)}x (+10)`); }
    else if (volumeRatio >= 1.5) { score += 5; breakdown.push(`🟠 Zayıf hacim ${volumeRatio.toFixed(1)}x (+5)`); }
    else { breakdown.push(`❌ Düşük hacim ${volumeRatio.toFixed(1)}x (+0)`); }

    // 3) RSI (15)
    if (rsiValue != null) {
        if (direction === 'LONG') {
            if (rsiValue >= 50 && rsiValue <= 65) { score += 15; breakdown.push(`✅ RSI ideal ${rsiValue.toFixed(0)} (+15)`); }
            else if (rsiValue > 65 && rsiValue <= 72) { score += 8; breakdown.push(`🟡 RSI yüksek ${rsiValue.toFixed(0)} (+8)`); }
            else if (rsiValue >= 45 && rsiValue < 50) { score += 8; breakdown.push(`🟡 RSI nötr ${rsiValue.toFixed(0)} (+8)`); }
            else if (rsiValue > 72) { score += 2; breakdown.push(`⚠️ RSI aşırı alım ${rsiValue.toFixed(0)} (+2)`); }
            else { breakdown.push(`❌ RSI uygun değil ${rsiValue.toFixed(0)} (+0)`); }
        } else {
            if (rsiValue >= 35 && rsiValue <= 50) { score += 15; breakdown.push(`✅ RSI ideal ${rsiValue.toFixed(0)} (+15)`); }
            else if (rsiValue >= 28 && rsiValue < 35) { score += 8; breakdown.push(`🟡 RSI düşük ${rsiValue.toFixed(0)} (+8)`); }
            else if (rsiValue > 50 && rsiValue <= 55) { score += 8; breakdown.push(`🟡 RSI nötr ${rsiValue.toFixed(0)} (+8)`); }
            else if (rsiValue < 28) { score += 2; breakdown.push(`⚠️ RSI aşırı satım ${rsiValue.toFixed(0)} (+2)`); }
            else { breakdown.push(`❌ RSI uygun değil ${rsiValue.toFixed(0)} (+0)`); }
        }
    }

    // 4) Funding (15)
    if (fundingRate != null) {
        const absFunding = Math.abs(fundingRate);
        if (direction === 'LONG') {
            if (fundingRate <= 0 && absFunding >= 0.0001) { score += 15; breakdown.push(`✅ Long'cular az (yükseliş için iyi) (+15)`); }
            else if (absFunding < 0.0005) { score += 10; breakdown.push(`✅ Funding nötr (+10)`); }
            else if (absFunding < 0.001) { score += 5; breakdown.push(`🟡 Funding yüksek (+5)`); }
            else { breakdown.push(`⚠️ Long'cular çok fazla (+0)`); }
        } else {
            if (fundingRate >= 0 && absFunding >= 0.0001) { score += 15; breakdown.push(`✅ Short'çular az (düşüş için iyi) (+15)`); }
            else if (absFunding < 0.0005) { score += 10; breakdown.push(`✅ Funding nötr (+10)`); }
            else if (absFunding < 0.001) { score += 5; breakdown.push(`🟡 Funding yüksek (+5)`); }
            else { breakdown.push(`⚠️ Short'çular çok fazla (+0)`); }
        }
    } else {
        score += 7;
        breakdown.push('⚪ Funding verisi yok (+7)');
    }

    // 5) Seviyeye yakınlık (15)
    if (distFromLevel <= 0.3) { score += 15; breakdown.push(`✅ Seviyeye çok yakın %${distFromLevel.toFixed(2)} (+15)`); }
    else if (distFromLevel <= 0.5) { score += 10; breakdown.push(`✅ Seviyeye yakın %${distFromLevel.toFixed(2)} (+10)`); }
    else if (distFromLevel <= 0.8) { score += 5; breakdown.push(`🟡 Seviyeden uzak %${distFromLevel.toFixed(2)} (+5)`); }
    else { breakdown.push(`❌ Seviyeden çok uzak %${distFromLevel.toFixed(2)} (+0)`); }

    // 6) Mum gövdesi (15)
    if (bodyRatio >= 0.7) { score += 15; breakdown.push(`✅ Güçlü mum ${bodyRatio.toFixed(2)}x (+15)`); }
    else if (bodyRatio >= 0.5) { score += 10; breakdown.push(`✅ İyi mum ${bodyRatio.toFixed(2)}x (+10)`); }
    else if (bodyRatio >= 0.3) { score += 5; breakdown.push(`🟡 Orta mum ${bodyRatio.toFixed(2)}x (+5)`); }
    else { breakdown.push(`❌ Zayıf mum ${bodyRatio.toFixed(2)}x (+0)`); }

    return { score: Math.min(score, 100), breakdown };
}

// ============================================================
// ANA TARAMA
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (isExcluded(symbol)) return null;

        const raw = await exchange.fetchOHLCV(
            symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT
        );
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.BREAKOUT_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]);
        const open = Number(last[1]);
        const volume = Number(last[5]);
        if (![close, open, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const closes = priorCandles.map(c => Number(c[4]));

        const volumes = priorCandles.slice(-CONFIG.VOLUME_AVG_PERIOD).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(CONFIG.VOLUME_AVG_PERIOD, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;
        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);

        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        const htfInfo = await getHTFTrend(symbol);
        const trend = htfInfo.trend;
        const bias = await getBias(symbol);
        const fundingRate = await getFundingRate(symbol);

        // RETEST KONTROL
        const pendingResult = checkPendingRetests(symbol, candles, currentATR, rsiValue, trend, bias, fundingRate);
        if (pendingResult) return pendingResult;

        // YENİ KIRILIM
        const highestHigh = Math.max(...priorCandles.slice(-CONFIG.BREAKOUT_LOOKBACK).map(c => Number(c[2])));
        const lowestLow = Math.min(...priorCandles.slice(-CONFIG.BREAKOUT_LOOKBACK).map(c => Number(c[3])));

        let direction = null;
        let level = null;

        if (close > highestHigh * (1 + CONFIG.MIN_BREAKOUT_BUFFER)) {
            direction = 'LONG';
            level = highestHigh;
        } else if (close < lowestLow * (1 - CONFIG.MIN_BREAKOUT_BUFFER)) {
            direction = 'SHORT';
            level = lowestLow;
        }

        if (direction && volumeRatio >= CONFIG.MIN_VOLUME_MULTIPLIER && bodyRatio >= CONFIG.MIN_BODY_ATR_RATIO) {
            const trendOk =
                (direction === 'LONG' && trend !== 'BEARISH') ||
                (direction === 'SHORT' && trend !== 'BULLISH');

            if (trendOk) {
                const exists = pendingBreakouts.find(p => p.symbol === symbol && p.direction === direction);
                if (!exists) {
                    pendingBreakouts.push({
                        symbol,
                        symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
                        direction,
                        level,
                        breakoutTime: last[0],
                        breakoutPrice: close,
                        candleCount: 0,
                        volumeRatio,
                        rsi: rsiValue,
                        trend,
                        bias,
                        startPrice: close,
                        currentPrice: close,
                        distToLevel: ((close - level) / level) * 100 * (direction === 'LONG' ? 1 : -1),
                        candles: candles.slice(-60).map(c => ({
                            t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5])
                        }))
                    });
                    console.log(`\x1b[33m[KIRILIM] ${symbol} ${direction} @ ${level.toFixed(6)} (Vol=${volumeRatio.toFixed(2)}x) → geri çekilme bekleniyor\x1b[0m`);
                }
                return null;
            }
        }

        // ERKEN UYARI
        const warnings = detectEarlyWarning(candles, closes, close, volumeRatio);
        if (warnings.length >= CONFIG.MIN_EARLY_WARNINGS && volumeRatio >= CONFIG.MIN_EARLY_VOLUME) {
            const pred = predictDirection(closes, close, trend, bias, fundingRate);

            if (pred.direction !== 'UNCERTAIN' && pred.confidence >= CONFIG.MIN_DIRECTION_CONFIDENCE) {
                const direction2 = pred.direction === 'UP' ? 'LONG' : 'SHORT';
                const cooldownKey = `${symbol}_EARLY_${direction2}`;
                const lastTime = lastSignalTime.get(cooldownKey) || 0;
                if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) return null;

                const quality = calculateQualityScore({
                    direction: direction2,
                    trend, htfTrend: bias, volumeRatio, rsiValue, fundingRate,
                    distFromLevel: 0.5, bodyRatio
                });

                if (quality.score < CONFIG.MIN_QUALITY_SCORE) {
                    DEBUG.rejectedQuality++;
                    return null;
                }

                const entry = close;
                const stopDistance = currentATR * 1.2;
                let stop, tp1, tp2;

                if (direction2 === 'LONG') {
                    stop = entry - stopDistance;
                    tp1 = entry + stopDistance * CONFIG.TP1_RR;
                    tp2 = entry + stopDistance * CONFIG.TP2_RR;
                } else {
                    stop = entry + stopDistance;
                    tp1 = entry - stopDistance * CONFIG.TP1_RR;
                    tp2 = entry - stopDistance * CONFIG.TP2_RR;
                }

                const reasons = [
                    `⚡ HAZIRLIK UYARISI — Fiyat sıkıştı, hareket yakın`,
                    `Güven: ${quality.score}/100`,
                    ...quality.breakdown,
                    ...warnings.map(w => w.desc),
                    `Yön: ${pred.direction === 'UP' ? 'YUKARI ⬆' : 'AŞAĞI ⬇'} (%${pred.confidence})`,
                    ...pred.reasons
                ];

                lastSignalTime.set(cooldownKey, Date.now());
                DEBUG.signals++;
                DEBUG.earlyWarnings++;
                DEBUG[direction2 === 'LONG' ? 'long' : 'short']++;

                return buildSignal({
                    symbol, direction: direction2, signalType: 'EARLY',
                    entry, stop, tp1, tp2,
                    level: close, volumeRatio, bodyRatio, rsiValue,
                    atr: currentATR, trend, bias, fundingRate,
                    quality, reasons, earlyWarning: { warnings, prediction: pred }, candles
                });
            }
        }

        DEBUG.rejected++;
        return null;

    } catch (err) {
        DEBUG.errors++;
        console.error(`[scanForSignal] ${symbol}: ${err.message}`);
        return null;
    }
}

// ============================================================
// RETEST KONTROL
// ============================================================

function checkPendingRetests(symbol, candles, currentATR, rsiValue, trend, bias, fundingRate) {
    const last = candles[candles.length - 1];
    const close = Number(last[4]);
    const open = Number(last[1]);
    const high = Number(last[2]);
    const low = Number(last[3]);
    const volume = Number(last[5]);

    const priorCandles = candles.slice(0, -1);
    const volumes = priorCandles.slice(-CONFIG.VOLUME_AVG_PERIOD).map(c => Number(c[5])).filter(Number.isFinite);
    const avgVolume = sma(volumes, Math.min(CONFIG.VOLUME_AVG_PERIOD, volumes.length));
    if (!avgVolume) return null;
    const volumeRatio = volume / avgVolume;

    const body = Math.abs(close - open);
    const bodyRatio = body / currentATR;

    const stillPending = [];

    for (const pb of pendingBreakouts) {
        if (pb.symbol !== symbol) {
            stillPending.push(pb);
            continue;
        }

        pb.candleCount++;
        pb.currentPrice = close;
        if (pb.direction === 'LONG') {
            pb.distToLevel = ((close - pb.level) / pb.level) * 100;
        } else {
            pb.distToLevel = ((pb.level - close) / pb.level) * 100;
        }
        // Mumları güncelle
        pb.candles = candles.slice(-60).map(c => ({
            t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5])
        }));

        if (pb.candleCount > CONFIG.RETEST_MAX_CANDLES) {
            console.log(`\x1b[90m[İPTAL] ${symbol} ${pb.direction} — ${pb.candleCount} mum geçti\x1b[0m`);
            DEBUG.timeouts++;
            continue;
        }

        if (pb.direction === 'LONG') {
            if (close < pb.level * 0.998) {
                console.log(`\x1b[31m[SAHTE] ${symbol} LONG — seviye kırıldı\x1b[0m`);
                DEBUG.fakeouts++;
                continue;
            }

            const distToLevel = Math.abs(low - pb.level) / pb.level;
            const nearLevel = distToLevel < CONFIG.RETEST_TOLERANCE;
            const isGreen = close > open;
            const aboveLevel = close > pb.level;
            const volumeOk = volumeRatio >= CONFIG.RETEST_MIN_VOLUME;
            const bodyOk = bodyRatio >= CONFIG.RETEST_MIN_BODY_ATR;

            if (nearLevel && isGreen && aboveLevel && volumeOk && bodyOk) {
                const quality = calculateQualityScore({
                    direction: 'LONG',
                    trend, htfTrend: bias, volumeRatio, rsiValue, fundingRate,
                    distFromLevel: distToLevel * 100, bodyRatio
                });

                if (quality.score < CONFIG.MIN_QUALITY_SCORE) {
                    DEBUG.rejectedQuality++;
                    continue;
                }

                const cooldownKey = `${symbol}_RETEST_LONG`;
                const lastTime = lastSignalTime.get(cooldownKey) || 0;
                if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) continue;

                const entry = close;
                const stopDistance = currentATR * CONFIG.STOP_ATR_MULT;
                const stop = pb.level - stopDistance * 0.5;
                const risk = entry - stop;
                const tp1 = entry + risk * CONFIG.TP1_RR;
                const tp2 = entry + risk * CONFIG.TP2_RR;

                const reasons = [
                    `🎯 FIRSAT SİNYALİ — Seviye test edildi, giriş zamanı`,
                    `Güven: ${quality.score}/100`,
                    `Seviye: ${num(pb.level)} kırıldı → geri test edildi`,
                    `Hacim: ${volumeRatio.toFixed(2)}x ortalama`,
                    `Yön: ${trend === 'BULLISH' ? 'YUKARI' : trend === 'BEARISH' ? 'AŞAĞI' : 'BELİRSİZ'}`,
                    `Bekleme: ${pb.candleCount} mum sonra teyit geldi`,
                    ...quality.breakdown
                ];

                lastSignalTime.set(cooldownKey, Date.now());
                DEBUG.signals++;
                DEBUG.retestSignals++;
                DEBUG.long++;

                console.log(`\x1b[32m[FIRSAT LONG] ${symbol} @ ${entry.toFixed(6)} Güven=${quality.score}\x1b[0m`);

                return buildSignal({
                    symbol, direction: 'LONG', signalType: 'RETEST',
                    entry, stop, tp1, tp2,
                    level: pb.level, volumeRatio, bodyRatio, rsiValue,
                    atr: currentATR, trend, bias, fundingRate,
                    quality, reasons, candles,
                    retestInfo: { candleCount: pb.candleCount, breakoutPrice: pb.breakoutPrice }
                });
            }
        } else {
            if (close > pb.level * 1.002) {
                console.log(`\x1b[31m[SAHTE] ${symbol} SHORT — seviye kırıldı\x1b[0m`);
                DEBUG.fakeouts++;
                continue;
            }

            const distToLevel = Math.abs(high - pb.level) / pb.level;
            const nearLevel = distToLevel < CONFIG.RETEST_TOLERANCE;
            const isRed = close < open;
            const belowLevel = close < pb.level;
            const volumeOk = volumeRatio >= CONFIG.RETEST_MIN_VOLUME;
            const bodyOk = bodyRatio >= CONFIG.RETEST_MIN_BODY_ATR;

            if (nearLevel && isRed && belowLevel && volumeOk && bodyOk) {
                const quality = calculateQualityScore({
                    direction: 'SHORT',
                    trend, htfTrend: bias, volumeRatio, rsiValue, fundingRate,
                    distFromLevel: distToLevel * 100, bodyRatio
                });

                if (quality.score < CONFIG.MIN_QUALITY_SCORE) {
                    DEBUG.rejectedQuality++;
                    continue;
                }

                const cooldownKey = `${symbol}_RETEST_SHORT`;
                const lastTime = lastSignalTime.get(cooldownKey) || 0;
                if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) continue;

                const entry = close;
                const stopDistance = currentATR * CONFIG.STOP_ATR_MULT;
                const stop = pb.level + stopDistance * 0.5;
                const risk = stop - entry;
                const tp1 = entry - risk * CONFIG.TP1_RR;
                const tp2 = entry - risk * CONFIG.TP2_RR;

                const reasons = [
                    `🎯 FIRSAT SİNYALİ — Seviye test edildi, giriş zamanı`,
                    `Güven: ${quality.score}/100`,
                    `Seviye: ${num(pb.level)} kırıldı → geri test edildi`,
                    `Hacim: ${volumeRatio.toFixed(2)}x ortalama`,
                    `Yön: ${trend === 'BULLISH' ? 'YUKARI' : trend === 'BEARISH' ? 'AŞAĞI' : 'BELİRSİZ'}`,
                    `Bekleme: ${pb.candleCount} mum sonra teyit geldi`,
                    ...quality.breakdown
                ];

                lastSignalTime.set(cooldownKey, Date.now());
                DEBUG.signals++;
                DEBUG.retestSignals++;
                DEBUG.short++;

                console.log(`\x1b[32m[FIRSAT SHORT] ${symbol} @ ${entry.toFixed(6)} Güven=${quality.score}\x1b[0m`);

                return buildSignal({
                    symbol, direction: 'SHORT', signalType: 'RETEST',
                    entry, stop, tp1, tp2,
                    level: pb.level, volumeRatio, bodyRatio, rsiValue,
                    atr: currentATR, trend, bias, fundingRate,
                    quality, reasons, candles,
                    retestInfo: { candleCount: pb.candleCount, breakoutPrice: pb.breakoutPrice }
                });
            }
        }

        stillPending.push(pb);
    }

    pendingBreakouts = stillPending;
    return null;
}

// ============================================================
// SİNYAL OLUŞTUR
// ============================================================

function buildSignal({
    symbol, direction, signalType,
    entry, stop, tp1, tp2,
    level, volumeRatio, bodyRatio, rsiValue,
    atr, trend, bias, fundingRate,
    quality, reasons, earlyWarning, candles, retestInfo
}) {
    const risk = Math.abs(entry - stop);
    const rr1 = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
    const rr2 = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;

    const lastCandles = candles.slice(-60).map(c => ({
        t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4])
    }));

    const last = candles[candles.length - 1];

    return {
        id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${signalType}_${Date.now()}`,
        symbol,
        symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
        direction,
        signalType,
        entry: num(entry),
        currentPrice: num(entry),
        pnlPct: 0,
        stop: num(stop),
        tp1: num(tp1),
        tp2: num(tp2),
        rr1: num(rr1, 2),
        rr2: num(rr2, 2),
        level: num(level),
        volumeRatio: num(volumeRatio, 2),
        bodyRatio: num(bodyRatio, 2),
        rsi: num(rsiValue, 1),
        atr: num(atr),
        trend,
        bias,
        fundingRate: fundingRate != null ? num(fundingRate * 100, 4) : null,
        qualityScore: quality.score,
        qualityBreakdown: quality.breakdown,
        status: 'ACTIVE',
        closeReason: null,
        reasons,
        earlyWarning: earlyWarning || null,
        retestInfo: retestInfo || null,
        candles: lastCandles,
        candleTime: last[0],
        timestamp: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CONFIG.SIGNAL_VALID_MS
    };
}

// ============================================================
// LIVE PRICES
// ============================================================

async function updateLivePrices() {
    if (!signals.length && !pendingBreakouts.length) return;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const sig of signals) {
            if (sig.status !== 'ACTIVE') continue;
            const t = tickers[sig.symbol];
            if (!t || !Number(t.last)) continue;

            sig.currentPrice = num(t.last);
            sig.updatedAt = now;

            const entry = Number(sig.entry);
            const current = Number(t.last);
            const stop = Number(sig.stop);
            const tp1 = Number(sig.tp1);
            const tp2 = Number(sig.tp2);

            if (sig.direction === 'LONG') {
                sig.pnlPct = num(((current - entry) / entry) * 100, 2);
                if (current <= stop) {
                    sig.status = 'STOPPED'; sig.closeReason = 'Stop oldu — zarar'; sig.closedAt = now;
                } else if (current >= tp2) {
                    sig.status = 'TP2_HIT'; sig.closeReason = 'TP2 hedefine ulaştı — tam kâr'; sig.closedAt = now;
                } else if (current >= tp1) {
                    sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 hedefine ulaştı — kısmi kâr'; sig.closedAt = now;
                }
            } else {
                sig.pnlPct = num(((entry - current) / entry) * 100, 2);
                if (current >= stop) {
                    sig.status = 'STOPPED'; sig.closeReason = 'Stop oldu — zarar'; sig.closedAt = now;
                } else if (current <= tp2) {
                    sig.status = 'TP2_HIT'; sig.closeReason = 'TP2 hedefine ulaştı — tam kâr'; sig.closedAt = now;
                } else if (current <= tp1) {
                    sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 hedefine ulaştı — kısmi kâr'; sig.closedAt = now;
                }
            }

            if (sig.status === 'ACTIVE' && now > sig.expiresAt) {
                sig.status = 'EXPIRED'; sig.closeReason = 'Süre doldu'; sig.closedAt = now;
            }
            changed = true;
        }

        for (const pb of pendingBreakouts) {
            const t = tickers[pb.symbol];
            if (!t || !Number(t.last)) continue;
            pb.currentPrice = num(t.last);
            if (pb.direction === 'LONG') {
                pb.distToLevel = num(((t.last - pb.level) / pb.level) * 100, 2);
            } else {
                pb.distToLevel = num(((pb.level - t.last) / pb.level) * 100, 2);
            }
            if (pb.candles && pb.candles.length > 0) {
                const lastC = pb.candles[pb.candles.length - 1];
                lastC.c = num(t.last);
                if (Number(t.last) > Number(lastC.h)) lastC.h = num(t.last);
                if (Number(t.last) < Number(lastC.l)) lastC.l = num(t.last);
            }
            changed = true;
        }

        if (changed) broadcast();
    } catch (err) {}
}

// ============================================================
// PRESCAN
// ============================================================

async function runPreScan() {
    try {
        if (!exchange.markets || !Object.keys(exchange.markets).length) {
            await exchange.loadMarkets(true);
        }
        const tickers = await exchange.fetchTickers(undefined, { type: 'swap' });
        const list = [];
        for (const t of Object.values(tickers || {})) {
            if (!t || !t.symbol) continue;
            const m = exchange.markets[t.symbol];
            if (!m || !m.active || !m.swap || m.quote !== 'USDT') continue;
            if (isExcluded(t.symbol)) continue;
            const v = Number(t.quoteVolume);
            if (Number.isFinite(v) && v >= CONFIG.MIN_24H_VOLUME_USDT) {
                list.push({ symbol: t.symbol, volume: v });
            }
        }
        list.sort((a, b) => b.volume - a.volume);
        targets = list.slice(0, CONFIG.MAX_TARGETS).map(i => i.symbol);
        lastPrescanAt = Date.now();
        console.log(`RADAR | ${targets.length} coin tarandı`);
    } catch (err) {
        console.error(`[runPreScan] ${err.message}`);
    }
}

// ============================================================
// SCAN
// ============================================================

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;
    DEBUG.scanned = 0;
    DEBUG.rejected = 0;
    DEBUG.rejectedQuality = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;

    try {
        for (const symbol of targets) {
            if (isShuttingDown) break;
            const signal = await scanForSignal(symbol);
            if (signal) {
                signals.unshift(signal);
                signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                newSignals++;
                broadcast();
            }
            await sleep(CONFIG.API_DELAY_MS);
        }
        lastScanAt = Date.now();
    } catch (err) {
        console.error(`[runScan] ${err.message}`);
    }

    scanRunning = false;
    APP_STATE.scanStatus = {
        message: `Tarama bitti | ${newSignals} yeni`,
        isScanning: false
    };
    broadcast();

    console.log(`[TARAMA] ${DEBUG.scanned} coin | ${newSignals} yeni sinyal | ${signals.length} toplam | ${pendingBreakouts.length} bekleyen`);
}

async function runAll() {
    if (Date.now() - lastPrescanAt > CONFIG.PRESCAN_INTERVAL_MS || !targets.length) {
        await runPreScan();
    }
    await runScan();
}

// ============================================================
// API
// ============================================================

app.get('/api/signals', (req, res) => res.json(snapshot()));
app.get('/api/market-status', (req, res) => res.json({ success: true, marketStatus }));
app.get('/api/pending', (req, res) => res.json({ success: true, pending: pendingBreakouts }));
app.get('/api/debug', (req, res) => res.json({
    success: true, debug: DEBUG, config: CONFIG, targets: targets.length, pending: pendingBreakouts.length
}));
app.get('/api/health', (req, res) => res.json({
    ok: true, time: Date.now(), targets: targets.length, signals: signals.length, pending: pendingBreakouts.length
}));
app.delete('/api/signals', (req, res) => {
    signals = [];
    broadcast();
    res.json({ success: true });
});

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    const active = signals.filter(s => s.status === 'ACTIVE');
    return {
        success: true,
        signals: signals.slice(0, 100),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        pending: pendingBreakouts.slice(0, 50),
        stats: {
            total: signals.length,
            active: active.length,
            long: active.filter(s => s.direction === 'LONG').length,
            short: active.filter(s => s.direction === 'SHORT').length,
            early: active.filter(s => s.signalType === 'EARLY').length,
            retest: active.filter(s => s.signalType === 'RETEST').length,
            pendingCount: pendingBreakouts.length
        },
        updatedAt: APP_STATE.updatedAt
    };
}

function broadcast() {
    const msg = JSON.stringify({ type: 'update', data: snapshot() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', sock => {
    sock.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
});

// ============================================================
// FRONTEND
// ============================================================

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:16px}
.market-left{display:flex;align-items:center;gap:16px}
.market-brand{font-size:15px;font-weight:800;letter-spacing:0.5px}
.market-brand span{color:#17d7a0}
.market-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.market-item{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#0a0e14;border-radius:6px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700;color:#e9eef5}
.market-item .chg{padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend{font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px}
.market-item .trend.bullish{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .trend.bearish{background:rgba(255,56,96,0.15);color:#ff3860}
.market-item .trend.sideways{background:rgba(246,196,83,0.15);color:#f6c453}
.market-overall{padding:8px 16px;border-radius:6px;font-size:12px;font-weight:800;letter-spacing:0.5px;display:flex;align-items:center;gap:8px}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}
.market-score{font-size:10px;opacity:0.7}
.content{display:flex;flex:1;overflow:hidden}
.sidebar{width:420px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:10px 12px;border-bottom:1px solid #1c2634}
.side-stat{background:#0a0e14;border-radius:6px;padding:8px 6px;text-align:center}
.side-stat .lbl{font-size:9px;color:#5e6b7c;text-transform:uppercase;letter-spacing:0.3px}
.side-stat .val{font-size:16px;font-weight:700;margin-top:2px}
.side-stat.early .val{color:#f6c453}
.side-stat.retest .val{color:#00ff9d}
.side-stat.long .val{color:#00ff9d}
.side-stat.short .val{color:#ff3860}
.side-actions{padding:10px 14px;border-bottom:1px solid #1c2634}
.btn{width:100%;background:#2a0f14;border:1px solid #5c1a26;color:#ff5c77;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600}
.btn:hover{background:#3a1520}
.side-list{flex:1;overflow-y:auto;padding:6px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}
.section-label{padding:12px 12px 8px;font-size:11px;font-weight:800;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px}
.sig-card{margin-bottom:8px;padding:12px;border-radius:10px;cursor:pointer;background:#0f1620;border:1px solid #1c2634;border-left:4px solid #2c3a4f;transition:all .15s;position:relative}
.sig-card:hover{background:#141d28}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 2px #17d7a0}
.sig-card.long{border-left-color:#00ff9d}
.sig-card.short{border-left-color:#ff3860}
.sig-card.closed{opacity:0.5}
.sig-card.pending-card{border-left-color:#f6c453;background:#14120a}

/* BÜYÜK LONG/SHORT ROZET */
.dir-badge{display:inline-block;font-size:13px;font-weight:900;padding:5px 14px;border-radius:6px;letter-spacing:1px}
.dir-badge.long{background:#00ff9d;color:#0a0e14}
.dir-badge.short{background:#ff3860;color:#ffffff}

/* DURUM ROZETİ */
.status-badge{display:inline-block;font-size:10px;font-weight:800;padding:4px 10px;border-radius:5px;letter-spacing:0.5px;text-transform:uppercase}
.status-badge.active{background:rgba(0,255,157,0.2);color:#00ff9d;border:1px solid #00ff9d}
.status-badge.tp1{background:#2962ff;color:#fff;border:1px solid #4a7cff}
.status-badge.tp2{background:#8a5cff;color:#fff;border:1px solid #a87cff}
.status-badge.stopped{background:#ff3860;color:#fff;border:1px solid #ff6080}
.status-badge.expired{background:#5e6b7c;color:#fff;border:1px solid #7e8b9c}
.status-badge.pending{background:#f6c453;color:#0a0e14;border:1px solid #f6c453}

/* EYLEM ÖNERİSİ */
.action-hint{margin-top:8px;padding:8px 10px;border-radius:6px;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}
.action-hint.buy{background:rgba(0,255,157,0.1);color:#00ff9d;border-left:3px solid #00ff9d}
.action-hint.wait{background:rgba(246,196,83,0.1);color:#f6c453;border-left:3px solid #f6c453}
.action-hint.sell{background:rgba(41,98,255,0.1);color:#4a7cff;border-left:3px solid #2962ff}
.action-hint.exit{background:rgba(255,56,96,0.1);color:#ff3860;border-left:3px solid #ff3860}
.action-hint.neutral{background:rgba(139,151,165,0.1);color:#8b97a5;border-left:3px solid #5e6b7c}

.sig-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
.sig-sym{font-size:16px;font-weight:900;letter-spacing:0.5px}
.sig-price{margin-top:10px;display:flex;justify-content:space-between;align-items:center}
.sig-price .cur{font-weight:700;color:#e9eef5;font-size:15px}
.sig-price .pnl{padding:3px 8px;border-radius:4px;font-weight:800;font-size:12px}
.sig-price .pnl.pos{background:rgba(0,255,157,0.15);color:#00ff9d}
.sig-price .pnl.neg{background:rgba(255,56,96,0.15);color:#ff3860}

.sig-meta{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:10px}
.sig-meta-item{display:flex;justify-content:space-between;padding:4px 8px;background:#0a0e14;border-radius:4px}
.sig-meta-item .k{color:#5e6b7c}
.sig-meta-item .v{font-weight:700;color:#c5cfdd}

.quality-badge{display:inline-block;font-size:10px;font-weight:800;padding:3px 8px;border-radius:4px}
.quality-badge.high{background:rgba(0,255,157,0.2);color:#00ff9d}
.quality-badge.med{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge.low{background:rgba(255,56,96,0.2);color:#ff3860}

/* SİNYAL TİPİ */
.type-badge{display:inline-block;font-size:10px;font-weight:800;padding:3px 8px;border-radius:4px;margin-left:6px}
.type-badge.early{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.4)}
.type-badge.retest{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}

.pending-row{margin-top:8px;padding:6px 8px;background:#0a0e14;border-radius:5px;font-size:11px;display:flex;justify-content:space-between}
.pending-row .k{color:#5e6b7c}
.pending-row .v{font-weight:700;color:#f6c453}

.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:14px;flex-direction:column;gap:12px}
.main-empty-icon{font-size:48px;opacity:0.3}
.chart-head{padding:14px 20px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219;flex-wrap:wrap;gap:10px}
.chart-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chart-sym{font-size:22px;font-weight:900;letter-spacing:0.5px}
.chart-quality{padding:4px 10px;border-radius:5px;font-size:11px;font-weight:800}
.chart-quality.high{background:rgba(0,255,157,0.15);color:#00ff9d}
.chart-quality.med{background:rgba(246,196,83,0.15);color:#f6c453}
.chart-quality.low{background:rgba(255,56,96,0.15);color:#ff3860}
.chart-actions{display:flex;gap:8px}
.btn-sm{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-decoration:none;display:inline-block}
.btn-sm:hover{background:#243044}
.btn-sm.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.btn-sm.tv:hover{background:#1e4fd9}
.chart-wrap{flex:1;position:relative;padding:0;background:#070b11}
#mainCanvas{width:100%;height:100%;display:block}
.chart-info{padding:14px 20px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(5,1fr);gap:12px;font-size:11px}
.chart-info-item{display:flex;flex-direction:column;gap:4px;padding:8px;background:#0a0e14;border-radius:6px}
.chart-info-lbl{color:#5e6b7c;text-transform:uppercase;font-size:9px;letter-spacing:0.5px;font-weight:700}
.chart-info-val{font-weight:800;font-size:14px;color:#e9eef5}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:100;align-items:center;justify-content:center;padding:20px}
.modal.open{display:flex}
.modal-content{background:#0f1620;border:1px solid #2c3a4f;border-radius:12px;max-width:720px;width:100%;max-height:90vh;overflow:auto}
.modal-head{padding:16px 20px;border-bottom:1px solid #1a2331;display:flex;justify-content:space-between;align-items:center}
.modal-title{font-size:16px;font-weight:800}
.modal-close{background:transparent;border:none;color:#7f8b98;font-size:24px;cursor:pointer;padding:0;line-height:1}
.modal-body{padding:20px}
.reasons{list-style:none;margin:0}
.reasons li{padding:10px 0;border-bottom:1px solid #1a2331;color:#c5cfdd;font-size:12px;display:flex;gap:10px;line-height:1.5}
.reasons li:before{content:'→';color:#00ff9d;font-weight:800;flex-shrink:0}
.quality-bar{height:10px;background:#1a2331;border-radius:5px;overflow:hidden;margin-top:10px}
.quality-bar-fill{height:100%;background:linear-gradient(90deg,#ff3860,#f6c453,#00ff9d);transition:width .3s}
.legend{padding:16px 20px;background:#0a0e14;border-radius:8px;margin-top:16px;font-size:12px}
.legend-title{font-size:11px;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;font-weight:700}
.legend-item{display:flex;gap:10px;padding:6px 0;align-items:flex-start}
.legend-badge{flex-shrink:0;font-size:10px;font-weight:800;padding:3px 8px;border-radius:4px}
</style>
</head>
<body>
<div class="app">
<div class="market-bar">
<div class="market-left">
<div class="market-brand">SONER <span>TRADE</span> <span class="market-badge">15 DAKİKA</span></div>
<div class="market-item">
<span class="sym">BTC</span>
<span class="price" id="btcPrice">-</span>
<span class="chg" id="btcChg">-</span>
<span class="trend" id="btcTrend">-</span>
</div>
<div class="market-item">
<span class="sym">ETH</span>
<span class="price" id="ethPrice">-</span>
<span class="chg" id="ethChg">-</span>
<span class="trend" id="ethTrend">-</span>
</div>
</div>
<div class="market-overall mixed" id="marketOverall">-</div>
</div>

<div class="content">
<div class="sidebar">
<div class="side-stats">
<div class="side-stat early"><div class="lbl">Hazırlık</div><div class="val" id="statEarly">0</div></div>
<div class="side-stat retest"><div class="lbl">Fırsat</div><div class="val" id="statRetest">0</div></div>
<div class="side-stat long"><div class="lbl">Long</div><div class="val" id="statLong">0</div></div>
<div class="side-stat short"><div class="lbl">Short</div><div class="val" id="statShort">0</div></div>
</div>
<div class="side-actions">
<button class="btn" onclick="clearSignals()">Tüm Sinyalleri Temizle</button>
</div>
<div class="side-list" id="signalList"></div>
</div>

<div class="main">
<div id="mainEmpty" class="main-empty">
<div class="main-empty-icon">📊</div>
<div>Soldan bir sinyal seç</div>
<div style="font-size:11px;color:#5e6b7c;margin-top:8px">Bekleyen veya aktif sinyallere tıkla</div>
</div>

<div id="mainContent" style="display:none;flex-direction:column;flex:1">
<div class="chart-head">
<div class="chart-title">
<div class="chart-sym" id="chartSym">-</div>
<div id="chartDir"></div>
<div id="chartType"></div>
<div id="chartQuality" class="chart-quality">-</div>
<div id="chartStatus"></div>
</div>
<div class="chart-actions">
<a class="btn-sm tv" id="tvLink" target="_blank">📈 TradingView'de Aç</a>
<button class="btn-sm" onclick="showDetail()">📋 Detaylı Bilgi</button>
</div>
</div>

<div class="chart-wrap">
<canvas id="mainCanvas"></canvas>
</div>

<div class="chart-info">
<div class="chart-info-item">
<div class="chart-info-lbl">Giriş Fiyatı</div>
<div class="chart-info-val" id="infoEntry">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">Zarar Durdur</div>
<div class="chart-info-val" style="color:#ff3860" id="infoStop">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">Kâr Al (1 & 2)</div>
<div class="chart-info-val" id="infoTps">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">Risk/Ödül</div>
<div class="chart-info-val" id="infoRr">-</div>
</div>
<div class="chart-info-item">
<div class="chart-info-lbl">Güven Skoru</div>
<div class="chart-info-val" id="infoQuality">-</div>
</div>
</div>
</div>
</div>
</div>
</div>

<div class="modal" id="detailModal">
<div class="modal-content">
<div class="modal-head">
<div class="modal-title" id="modalTitle">Detay</div>
<button class="modal-close" onclick="closeModal()">×</button>
</div>
<div class="modal-body" id="modalBody"></div>
</div>
</div>

<script>
var signals = [];
var pending = [];
var selectedId = null;
var selectedPending = null;
var ws = null;
var lastActiveCount = 0;
var audioCtx = null;

function fmt(v){
    v = Number(v);
    if(!Number.isFinite(v)) return '-';
    if(v >= 1000) return v.toFixed(2);
    if(v >= 100) return v.toFixed(3);
    if(v >= 1) return v.toFixed(4);
    return v.toFixed(6);
}
function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function timeAgo(ts){ var d = Date.now() - ts; var m = Math.floor(d / 60000); if(m < 1) return 'az önce'; if(m < 60) return m + ' dk önce'; var h = Math.floor(m / 60); return h + ' sa önce'; }
function playSound(){ try{ if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); var o = audioCtx.createOscillator(); var g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.1, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35); o.start(); o.stop(audioCtx.currentTime + 0.35); }catch(e){} }

function renderMarketBar(ms){
    if(!ms || !ms.btc || !ms.eth) return;
    var btc = ms.btc, eth = ms.eth;
    document.getElementById('btcPrice').textContent = fmt(btc.price);
    var btcChg = document.getElementById('btcChg');
    if(btc.change24h != null){ btcChg.textContent = (btc.change24h >= 0 ? '+' : '') + btc.change24h + '%'; btcChg.className = 'chg ' + (btc.change24h >= 0 ? 'up' : 'down'); }
    var btcT = document.getElementById('btcTrend');
    btcT.textContent = btc.trend === 'BULLISH' ? 'YUKARI' : btc.trend === 'BEARISH' ? 'AŞAĞI' : 'YATAY';
    btcT.className = 'trend ' + (btc.trend === 'BULLISH' ? 'bullish' : btc.trend === 'BEARISH' ? 'bearish' : 'sideways');
    document.getElementById('ethPrice').textContent = fmt(eth.price);
    var ethChg = document.getElementById('ethChg');
    if(eth.change24h != null){ ethChg.textContent = (eth.change24h >= 0 ? '+' : '') + eth.change24h + '%'; ethChg.className = 'chg ' + (eth.change24h >= 0 ? 'up' : 'down'); }
    var ethT = document.getElementById('ethTrend');
    ethT.textContent = eth.trend === 'BULLISH' ? 'YUKARI' : eth.trend === 'BEARISH' ? 'AŞAĞI' : 'YATAY';
    ethT.className = 'trend ' + (eth.trend === 'BULLISH' ? 'bullish' : eth.trend === 'BEARISH' ? 'bearish' : 'sideways');
    var overall = document.getElementById('marketOverall');
    var label = 'KARIŞIK PİYASA', cls = 'mixed';
    if(ms.overall === 'BULLISH'){ label = 'PİYASA YUKARI'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH'){ label = 'PİYASA AŞAĞI'; cls = 'bearish'; }
    else if(ms.overall === 'BULLISH_WEAK'){ label = 'YUKARI (ZAYIF)'; cls = 'bullish'; }
    else if(ms.overall === 'BEARISH_WEAK'){ label = 'AŞAĞI (ZAYIF)'; cls = 'bearish'; }
    overall.innerHTML = label + '<span class="market-score">Skor ' + (ms.score >= 0 ? '+' : '') + ms.score + '</span>';
    overall.className = 'market-overall ' + cls;
}

function getStatusBadge(status){
    if(status === 'ACTIVE') return '<span class="status-badge active">● AKTİF</span>';
    if(status === 'TP1_HIT') return '<span class="status-badge tp1">✓ TP1 VURDU</span>';
    if(status === 'TP2_HIT') return '<span class="status-badge tp2">✓✓ TP2 VURDU</span>';
    if(status === 'TARGET_HIT') return '<span class="status-badge tp1">✓ HEDEF VURDU</span>';
    if(status === 'STOPPED') return '<span class="status-badge stopped">✗ ZARAR DURDU</span>';
    if(status === 'EXPIRED') return '<span class="status-badge expired">⏱ SÜRE DOLDU</span>';
    return '';
}

function getActionHint(s){
    if(s.status === 'ACTIVE'){
        return '<div class="action-hint buy">✅ Şimdi girebilirsin — Fiyat uygun</div>';
    }
    if(s.status === 'TP1_HIT'){
        return '<div class="action-hint sell">💰 Yarısını sat — Kalanı bekle</div>';
    }
    if(s.status === 'TP2_HIT' || s.status === 'TARGET_HIT'){
        return '<div class="action-hint sell">🎉 Tamamını sat — Hedef tamam</div>';
    }
    if(s.status === 'STOPPED'){
        return '<div class="action-hint exit">❌ Çık — Zararı kabullen</div>';
    }
    if(s.status === 'EXPIRED'){
        return '<div class="action-hint neutral">⏱ Süre doldu — Yeni sinyal bekle</div>';
    }
    return '';
}

function getQualityClass(q){
    if(q >= 75) return 'high';
    if(q >= 60) return 'med';
    return 'low';
}

function renderSigCard(s){
    var dirCls = s.direction === 'LONG' ? 'long' : 'short';
    var selected = s.id === selectedId ? 'selected' : '';
    var closed = (s.status !== 'ACTIVE') ? 'closed' : '';
    var pnlCls = (s.pnlPct || 0) >= 0 ? 'pos' : 'neg';
    var pnlSign = (s.pnlPct || 0) >= 0 ? '+' : '';

    var typeLabel = s.signalType === 'EARLY' ? '⚡ HAZIRLIK' : '🎯 FIRSAT';
    var typeCls = s.signalType === 'EARLY' ? 'early' : 'retest';

    var q = s.qualityScore || 0;
    var qCls = getQualityClass(q);

    return '<div class="sig-card ' + dirCls + ' ' + selected + ' ' + closed + '" data-id="' + esc(s.id) + '">'
        + '<div class="sig-row">'
        + '<div class="sig-sym">' + esc(s.symbol.replace(':USDT','')) + '</div>'
        + '<div class="dir-badge ' + dirCls + '">' + s.direction + '</div>'
        + '</div>'
        + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
        + getStatusBadge(s.status)
        + '<span class="type-badge ' + typeCls + '">' + typeLabel + '</span>'
        + '<span class="quality-badge ' + qCls + '">Güven ' + q + '/100</span>'
        + '</div>'
        + '<div class="sig-price">'
        + '<span class="cur">' + fmt(s.currentPrice || s.entry) + '</span>'
        + (s.pnlPct != null ? '<span class="pnl ' + pnlCls + '">' + pnlSign + s.pnlPct + '%</span>' : '')
        + '</div>'
        + getActionHint(s)
        + '<div class="sig-meta">'
        + '<div class="sig-meta-item"><span class="k">Giriş</span><span class="v">' + fmt(s.entry) + '</span></div>'
        + '<div class="sig-meta-item"><span class="k">Hacim</span><span class="v">' + s.volumeRatio + 'x</span></div>'
        + '</div>'
        + '</div>';
}

function renderPendingCard(p, idx){
    var dirCls = p.direction === 'LONG' ? 'long' : 'short';
    var selected = selectedPending === idx ? 'selected' : '';
    var candlesLeft = Math.max(0, 8 - (p.candleCount || 0));
    var pnlPct = p.distToLevel != null ? p.distToLevel : 0;
    var pnlCls = pnlPct >= 0 ? 'pos' : 'neg';

    return '<div class="sig-card pending-card ' + selected + '" data-pending-idx="' + idx + '">'
        + '<div class="sig-row">'
        + '<div class="sig-sym">' + esc(p.symbol.replace(':USDT','')) + '</div>'
        + '<div class="dir-badge ' + dirCls + '">' + p.direction + '</div>'
        + '</div>'
        + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
        + '<span class="status-badge pending">⏳ BEKLİYOR</span>'
        + '<span class="type-badge early">Kırılım Oldu</span>'
        + '</div>'
        + '<div class="action-hint wait">⏳ Geri çekilme bekleniyor — ' + candlesLeft + ' mum kaldı</div>'
        + '<div class="pending-row"><span class="k">Seviye</span><span class="v">' + fmt(p.level) + '</span></div>'
        + '<div class="pending-row"><span class="k">Şimdi</span><span class="v">' + fmt(p.currentPrice || p.breakoutPrice) + '</span></div>'
        + '<div class="pending-row"><span class="k">Fark</span><span class="v ' + pnlCls + '">' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%</span></div>'
        + '</div>';
}

function renderList(){
    var el = document.getElementById('signalList');
    var html = '';

    var active = signals.filter(s => s.status === 'ACTIVE');
    if(active.length > 0){
        html += '<div class="section-label">🎯 AKTİF SİNYALLER (' + active.length + ')</div>';
        html += active.map(renderSigCard).join('');
    }

    var closed = signals.filter(s => s.status !== 'ACTIVE');
    if(closed.length > 0){
        html += '<div class="section-label">📁 SONUÇLANMIŞ (' + closed.length + ')</div>';
        html += closed.slice(0, 20).map(renderSigCard).join('');
    }

    if(pending.length > 0){
        html += '<div class="section-label">⏳ BEKLEYEN KIRILIMLAR (' + pending.length + ')</div>';
        html += pending.map(function(p, i){ return renderPendingCard(p, i); }).join('');
    }

    if(!html){
        html = '<div style="padding:40px 16px;text-align:center;color:#5e6b7c;font-size:12px">Sinyal bekleniyor...<br><br>Kırılım olduğunda burada görünecek</div>';
    }

    el.innerHTML = html;

    el.querySelectorAll('.sig-card[data-id]').forEach(function(card){
        card.onclick = function(){
            selectedId = card.getAttribute('data-id');
            selectedPending = null;
            renderList();
            renderMain();
        };
    });

    el.querySelectorAll('.sig-card[data-pending-idx]').forEach(function(card){
        card.onclick = function(){
            var idx = parseInt(card.getAttribute('data-pending-idx'));
            selectedPending = idx;
            selectedId = null;
            renderList();
            renderPendingMain(idx);
        };
    });
}

function renderPendingMain(idx){
    var p = pending[idx];
    if(!p){ return; }

    document.getElementById('mainEmpty').style.display = 'none';
    document.getElementById('mainContent').style.display = 'flex';

    document.getElementById('chartSym').textContent = p.symbol.replace(':USDT','');

    var dirHtml = '<div class="dir-badge ' + (p.direction === 'LONG' ? 'long' : 'short') + '">' + p.direction + '</div>';
    document.getElementById('chartDir').innerHTML = dirHtml;

    var typeEl = document.getElementById('chartType');
    typeEl.innerHTML = '<span class="type-badge early">⏳ KIRILIM BEKLİYOR</span>';

    var qEl = document.getElementById('chartQuality');
    qEl.textContent = (p.candleCount || 0) + ' / 8 mum';
    qEl.className = 'chart-quality med';

    var statusEl = document.getElementById('chartStatus');
    statusEl.innerHTML = '<span class="status-badge pending">BEKLİYOR</span>';

    document.getElementById('tvLink').href = 'https://www.tradingview.com/chart/?symbol=BITGET:' + p.symbolTV + '&interval=15';
    document.getElementById('infoEntry').textContent = fmt(p.breakoutPrice);
    document.getElementById('infoStop').textContent = '-';
    document.getElementById('infoTps').textContent = '-';
    document.getElementById('infoRr').textContent = '-';
    document.getElementById('infoQuality').textContent = 'Seviye ' + fmt(p.level);

    drawPendingChart(p);
}

function drawPendingChart(p){
    var canvas = document.getElementById('mainCanvas');
    var parent = canvas.parentElement;
    var W = parent.clientWidth, H = parent.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, W, H);

    var candles = p.candles;
    if(!candles || !candles.length){
        ctx.fillStyle = '#f6c453';
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('⏳ Veri yükleniyor...', W/2, H/2);
        return;
    }

    var count = candles.length;
    var minP = Infinity, maxP = -Infinity;
    for(var i = 0; i < candles.length; i++){
        var lo = Number(candles[i].l);
        var hi = Number(candles[i].h);
        if(lo < minP) minP = lo;
        if(hi > maxP) maxP = hi;
    }
    if(p.level != null){ if(p.level < minP) minP = p.level; if(p.level > maxP) maxP = p.level; }
    if(p.currentPrice != null){ if(p.currentPrice < minP) minP = p.currentPrice; if(p.currentPrice > maxP) maxP = p.currentPrice; }

    var pad = (maxP - minP) * 0.08 || 1;
    minP -= pad; maxP += pad;

    var LEFT = 130, RIGHT = 80, TOP = 40, BOTTOM = 60;
    var PW = W - LEFT - RIGHT;
    var PH = H - TOP - BOTTOM;

    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(pr){ return TOP + (maxP - pr) / (maxP - minP) * PH; }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for(var g = 0; g <= 5; g++){
        var y = TOP + PH * g / 5;
        ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(W - RIGHT, y); ctx.stroke();
        var price = maxP - (maxP - minP) * g / 5;
        ctx.fillStyle = 'rgba(139,151,165,0.6)';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(fmt(price), LEFT - 8, y + 3);
        ctx.textAlign = 'left';
        ctx.fillText(fmt(price), W - RIGHT + 3, y + 3);
    }

    if(p.level != null){
        var tolTop = p.level * (1 + 0.004);
        var tolBot = p.level * (1 - 0.004);
        var yTop = Y(tolTop);
        var yBot = Y(tolBot);
        ctx.save();
        ctx.fillStyle = 'rgba(246,196,83,0.08)';
        ctx.fillRect(LEFT, yTop, PW, yBot - yTop);
        ctx.restore();

        var yLevel = Y(p.level);
        ctx.save();
        ctx.strokeStyle = '#f6c453';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(LEFT, yLevel);
        ctx.lineTo(W - RIGHT, yLevel);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = '#f6c453';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('📍 SEVİYE ' + fmt(p.level), LEFT + 8, yLevel - 8);
        ctx.restore();
    }

    var cw = Math.max(2, Math.min(14, PW / count * 0.7));
    for(var c = 0; c < candles.length; c++){
        var k = candles[c];
        var x = X(c);
        var o = Number(k.o), cl = Number(k.c), h = Number(k.h), l = Number(k.l);
        var bull = cl >= o;
        var color = bull ? '#00ff9d' : '#ff3860';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, Y(h));
        ctx.lineTo(x, Y(l));
        ctx.stroke();
        var oY = Y(o), cY = Y(cl);
        ctx.fillRect(x - cw/2, Math.min(oY, cY), cw, Math.max(1, Math.abs(cY - oY)));
    }

    if(p.currentPrice != null){
        var curY = Y(p.currentPrice);
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(LEFT, curY);
        ctx.lineTo(W - RIGHT, curY);
        ctx.stroke();
        ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = '#f6c453';
    ctx.font = 'bold 13px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('⏳ ' + p.symbol.replace(':USDT','') + ' — KIRILIM BEKLİYOR', LEFT, 24);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#5e6b7c';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    var beklemeText = 'Bekleme: ' + (p.candleCount || 0) + ' / 8 mum';
    var farkText = 'Seviyeye: ' + (p.distToLevel != null ? p.distToLevel.toFixed(2) : '0.00') + '%';
    ctx.fillText(beklemeText + '  •  ' + farkText + '  •  Hacim: ' + (p.volumeRatio || 0) + 'x', W/2, H - 25);
    ctx.restore();
}

function renderMain(){
    if(!selectedId && selectedPending === null){
        document.getElementById('mainEmpty').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'none';
        return;
    }

    if(selectedPending !== null){
        renderPendingMain(selectedPending);
        return;
    }

    var s = signals.find(function(x){ return x.id === selectedId; });
    if(!s){
        document.getElementById('mainEmpty').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'none';
        return;
    }

    document.getElementById('mainEmpty').style.display = 'none';
    document.getElementById('mainContent').style.display = 'flex';

    document.getElementById('chartSym').textContent = s.symbol.replace(':USDT','');

    var dirHtml = '<div class="dir-badge ' + (s.direction === 'LONG' ? 'long' : 'short') + '">' + s.direction + '</div>';
    document.getElementById('chartDir').innerHTML = dirHtml;

    var typeEl = document.getElementById('chartType');
    typeEl.innerHTML = s.signalType === 'EARLY'
        ? '<span class="type-badge early">⚡ HAZIRLIK UYARISI</span>'
        : '<span class="type-badge retest">🎯 FIRSAT SİNYALİ</span>';

    var q = s.qualityScore || 0;
    var qEl = document.getElementById('chartQuality');
    qEl.textContent = 'Güven ' + q + '/100';
    qEl.className = 'chart-quality ' + getQualityClass(q);

    document.getElementById('chartStatus').innerHTML = getStatusBadge(s.status);

    document.getElementById('tvLink').href = 'https://www.tradingview.com/chart/?symbol=BITGET:' + s.symbolTV + '&interval=15';
    document.getElementById('infoEntry').textContent = fmt(s.entry);
    document.getElementById('infoStop').textContent = fmt(s.stop);
    document.getElementById('infoTps').textContent = fmt(s.tp1) + ' / ' + fmt(s.tp2);
    document.getElementById('infoRr').textContent = '1:' + s.rr1 + ' / 1:' + s.rr2;
    document.getElementById('infoQuality').textContent = q + '/100';

    setTimeout(function(){ drawBigChart(s); }, 30);
}

function drawBigChart(s){
    var canvas = document.getElementById('mainCanvas');
    var parent = canvas.parentElement;
    var W = parent.clientWidth, H = parent.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = s.direction === 'LONG' ? '#08120d' : '#12080c';
    ctx.fillRect(0, 0, W, H);
    var candles = s.candles; if(!candles || !candles.length) return;
    var count = candles.length;
    var minP = Infinity, maxP = -Infinity;
    for(var i = 0; i < candles.length; i++){ var lo = Number(candles[i].l); var hi = Number(candles[i].h); if(lo < minP) minP = lo; if(hi > maxP) maxP = hi; }
    [s.entry, s.stop, s.tp1, s.tp2, s.currentPrice, s.level].forEach(function(v){ if(v == null) return; v = Number(v); if(v < minP) minP = v; if(v > maxP) maxP = v; });
    var pad = (maxP - minP) * 0.06 || 1; minP -= pad; maxP += pad;
    var LEFT = 130, RIGHT = 20, TOP = 30, BOTTOM = 30;
    var PW = W - LEFT - RIGHT, PH = H - TOP - BOTTOM;
    function X(i){ return LEFT + i * PW / (count - 1 || 1); }
    function Y(p){ return TOP + (maxP - p) / (maxP - minP) * PH; }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for(var g = 0; g <= 5; g++){ var y = TOP + PH * g / 5; ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(W - RIGHT, y); ctx.stroke(); }
    function drawLevel(price, color, label, dash){
        if(price == null) return;
        var y = Y(price);
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; if(dash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(W - RIGHT, y); ctx.stroke(); ctx.restore();
        ctx.save(); ctx.fillStyle = color; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'right';
        ctx.fillText(label + ' ' + fmt(price), LEFT - 10, y + 4); ctx.textAlign = 'left';
        ctx.fillText(fmt(price), W - RIGHT + 3, y + 3); ctx.restore();
    }
    drawLevel(s.tp2, '#8a5cff', 'KÂR 2', [4,4]);
    drawLevel(s.tp1, '#00ff9d', 'KÂR 1', [4,4]);
    drawLevel(s.stop, '#ff3860', 'ZARAR DUR', [6,3]);
    drawLevel(s.entry, '#2962ff', 'GİRİŞ', []);
    if(s.level != null) drawLevel(s.level, '#f6c453', 'SEVİYE', [2,2]);
    var cw = Math.max(2, Math.min(12, PW / count * 0.7));
    for(var c = 0; c < candles.length; c++){
        var k = candles[c]; var x = X(c);
        var o = Number(k.o), cl = Number(k.c), h = Number(k.h), l = Number(k.l);
        var bull = cl >= o; var color = bull ? '#00ff9d' : '#ff3860';
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.stroke();
        var oY = Y(o), cY = Y(cl);
        ctx.fillRect(x - cw/2, Math.min(oY, cY), cw, Math.max(1, Math.abs(cY - oY)));
    }
    if(s.currentPrice != null){
        var curY = Y(s.currentPrice);
        ctx.save(); ctx.strokeStyle = '#f6c453'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(LEFT, curY); ctx.lineTo(W - RIGHT, curY); ctx.stroke();
        ctx.fillStyle = '#f6c453'; ctx.beginPath(); ctx.arc(W - RIGHT - 5, curY, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f6c453'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'right';
        ctx.fillText('ŞİMDİ', LEFT - 10, curY + 4); ctx.restore();
    }
}

function showDetail(){
    if(!selectedId) return;
    var s = signals.find(function(x){ return x.id === selectedId; }); if(!s) return;
    document.getElementById('modalTitle').textContent = s.symbol.replace(':USDT','') + ' — ' + s.direction;
    var q = s.qualityScore || 0;
    var body = '';
    body += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">';
    body += '<div style="background:#0a0e14;padding:12px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px">Sinyal Tipi</div><div style="font-size:14px;font-weight:700;margin-top:4px">' + (s.signalType === 'EARLY' ? '⚡ Hazırlık' : '🎯 Fırsat') + '</div></div>';
    body += '<div style="background:#0a0e14;padding:12px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px">Yön</div><div style="font-size:14px;font-weight:700;margin-top:4px;color:' + (s.direction === 'LONG' ? '#00ff9d' : '#ff3860') + '">' + s.direction + '</div></div>';
    body += '<div style="background:#0a0e14;padding:12px;border-radius:6px"><div style="font-size:10px;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px">Durum</div><div style="font-size:14px;font-weight:700;margin-top:4px">' + getStatusBadge(s.status) + '</div></div>';
    body += '</div>';

    body += '<div style="margin-bottom:16px;padding:14px;background:#0a0e14;border-radius:8px">';
    body += '<div style="font-size:11px;color:#5e6b7c;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700">Güven Skoru</div>';
    body += '<div style="font-size:28px;font-weight:900;color:' + (q >= 75 ? '#00ff9d' : q >= 60 ? '#f6c453' : '#ff3860') + '">' + q + '<span style="font-size:16px;opacity:0.5">/100</span></div>';
    body += '<div class="quality-bar"><div class="quality-bar-fill" style="width:' + q + '%"></div></div>';
    body += '</div>';

    body += '<h3 style="font-size:12px;color:#7f8b98;text-transform:uppercase;letter-spacing:1px;margin:16px 0 10px">Sinyal Detayları</h3>';
    body += '<ul class="reasons">';
    s.reasons.forEach(function(r){ body += '<li>' + esc(r) + '</li>'; });
    body += '</ul>';

    if(s.closeReason){
        body += '<div style="margin-top:16px;padding:12px;background:#0a0e14;border-radius:6px;color:#c5cfdd;font-size:12px"><b style="color:#e9eef5">Sonuç:</b> ' + esc(s.closeReason) + '</div>';
    }

    body += '<div class="legend">';
    body += '<div class="legend-title">Sinyal Tipleri Ne Anlama Geliyor?</div>';
    body += '<div class="legend-item"><span class="type-badge early">⚡ HAZIRLIK</span><span>Fiyat sıkıştı, büyük hareket hazırlanıyor. <b>Dikkatli ol, hazır bekle.</b> Fiyat hareket etmeye başladığında gir.</span></div>';
    body += '<div class="legend-item"><span class="type-badge retest">🎯 FIRSAT</span><span>Seviye kırıldı ve geri test edildi. <b>En güvenli giriş noktası.</b> Stop yakın, risk az.</span></div>';
    body += '<div class="legend-item"><span class="status-badge active">AKTİF</span><span>Sinyal geçerli. <b>Şimdi girebilirsin.</b></span></div>';
    body += '<div class="legend-item"><span class="status-badge tp1">TP1 VURDU</span><span>Birinci hedefe ulaştı. <b>Yarısını sat, kalanı bekle.</b></span></div>';
    body += '<div class="legend-item"><span class="status-badge tp2">TP2 VURDU</span><span>İkinci hedefe ulaştı. <b>Tamamını sat.</b></span></div>';
    body += '<div class="legend-item"><span class="status-badge stopped">ZARAR DURDU</span><span>Fiyat zarar durdur seviyesine düştü. <b>Pozisyon kapandı, çık.</b></span></div>';
    body += '</div>';

    document.getElementById('modalBody').innerHTML = body;
    document.getElementById('detailModal').classList.add('open');
}

function closeModal(){ document.getElementById('detailModal').classList.remove('open'); }
document.getElementById('detailModal').addEventListener('click', function(e){ if(e.target.id === 'detailModal') closeModal(); });

function apply(data){
    var newSignals = Array.isArray(data.signals) ? data.signals : [];
    var newPending = Array.isArray(data.pending) ? data.pending : [];

    var activeCount = newSignals.filter(function(s){ return s.status === 'ACTIVE'; }).length;
    if(activeCount > lastActiveCount && lastActiveCount > 0){ playSound(); }
    lastActiveCount = activeCount;

    signals = newSignals;
    pending = newPending;

    if(data.marketStatus){ renderMarketBar(data.marketStatus); }

    if(selectedPending !== null && !pending[selectedPending]){
        selectedPending = pending.length > 0 ? 0 : null;
    }
    if(!selectedId && selectedPending === null && signals.length > 0){
        selectedId = signals[0].id;
    }

    document.getElementById('statEarly').textContent = data.stats.early;
    document.getElementById('statRetest').textContent = data.stats.retest;
    document.getElementById('statLong').textContent = data.stats.long;
    document.getElementById('statShort').textContent = data.stats.short;
    document.title = (data.stats.active > 0 ? '(' + data.stats.active + ') ' : '') + 'SONER TRADE';

    renderList();
    renderMain();
}

function connect(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = function(){};
    ws.onmessage = function(ev){ try{ var m = JSON.parse(ev.data); if(m.type === 'snapshot' || m.type === 'update') apply(m.data); }catch(e){console.error(e);} };
    ws.onclose = function(){ setTimeout(connect, 3000); };
}

async function clearSignals(){ if(!confirm('Tüm sinyalleri silmek istediğinden emin misin?')) return; await fetch('/api/signals', { method: 'DELETE' }); selectedId = null; selectedPending = null; renderList(); renderMain(); }

window.addEventListener('resize', function(){ if(selectedId || selectedPending !== null) renderMain(); });
fetch('/api/signals').then(function(r){return r.json();}).then(apply).catch(function(){});
connect();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// START
// ============================================================

async function start() {
    try {
        await exchange.loadMarkets();
        console.log(`Bitget marketleri yuklendi | ${Object.keys(exchange.markets).length} market`);
        await updateMarketStatus();
        await runPreScan();
        await runScan();
        setInterval(function(){ runAll(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function(){ updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        console.log('SONER TRADE v1.2 baslatildi.');
    } catch (err) {
        console.error(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} alindi; kapaniyor.`);
    if (scanRunning) {
        const startTime = Date.now();
        while (scanRunning && Date.now() - startTime < 15000) { await sleep(500); }
    }
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function(){ try { await exchange.close(); } catch (e) {} process.exit(0); });
    setTimeout(function(){ process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function(){ shutdown('SIGINT'); });
process.once('SIGTERM', function(){ shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function(){
    console.log(`SONER TRADE v1.2 PORT=${PORT}`);
    start();
});
