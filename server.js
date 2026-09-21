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
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
});

// ============================================================
// SONER TRADE v6.1 — ANLIK KIRILIM (5 KRİTİK HATA DÜZELTİLDİ)
// ============================================================

const CONFIG = {
    TIMEFRAME: '15m',
    HTF1: '1h',
    HTF2: '4h',
    CANDLE_LIMIT: 200,

    // Seviye tespiti
    LEVEL_LOOKBACK: 50,
    LEVEL_STRENGTH_MIN: 3,
    LEVEL_TOLERANCE: 0.003,

    // Trend
    EMA_FAST: 21,
    EMA_SLOW: 50,
    TREND_CACHE_MS: 5 * 60 * 1000,   // DÜZELTME 5: trend cache 5 dk

    // Kırılım filtreleri
    MIN_VOLUME_MULTIPLIER: 3.0,
    MIN_BODY_ATR_RATIO: 0.7,
    BREAKOUT_BUFFER_ATR: 0.2,        // DÜZELTME 1: buffer artık ATR cinsinden
    MAX_ENTRY_DISTANCE_ATR: 1.5,     // DÜZELTME 1: aşırı uzamış girişi engelle
    FRESH_CANDLE_MS: 2 * 60 * 1000,  // DÜZELTME 4: sadece taze mum
    RSI_OVERBOUGHT: 72,
    RSI_OVERSOLD: 28,
    MIN_MARKET_SCORE: 3,

    // ATR / RSI
    ATR_PERIOD: 14,
    RSI_PERIOD: 14,

    // Stop / TP
    STOP_ATR_MULT: 0.5,
    TP1_RR: 1.5,
    TP2_RR: 3.0,

    // Kalite
    MIN_QUALITY_SCORE: 80,

    // Sinyal
    SIGNAL_VALID_MS: 4 * 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 2 * 60 * 60 * 1000,

    // Likidite
    MIN_24H_VOLUME_USDT: 2000000,
    MAX_TARGETS: 200,
    MAX_SIGNALS_PER_SCAN: 3,

    EXCLUDED_BASES: ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','WBTC','WETH','WSTETH','STETH'],

    SCAN_INTERVAL_MS: 2 * 60 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    MARKET_STATUS_INTERVAL_MS: 30 * 1000,
    LIVE_UPDATE_MS: 3000,
    API_DELAY_MS: 120,
    MAX_SIGNALS_KEPT: 100,
    MAX_ESCAPED_KEPT: 50,
    DEBUG: true
};

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 250,
    options: { defaultType: 'swap' }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let signals = [];
let escapedSignals = [];
let marketStatus = { btc: null, eth: null, overall: 'UNKNOWN', score: 0, updatedAt: 0 };
let scanRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;
const lastSignalTime = new Map();
const trendCache = new Map();   // DÜZELTME 5

const APP_STATE = { scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false }, updatedAt: Date.now() };

const DEBUG = {
    scanned: 0, breakouts: 0, signals: 0, long: 0, short: 0,
    rejectedFresh: 0, rejectedDistance: 0, rejectedTrend: 0,
    rejectedVolume: 0, rejectedBody: 0, rejectedRSI: 0,
    rejectedMarket: 0, rejectedQuality: 0, rejectedCooldown: 0, errors: 0
};

// ============================================================
// LOG + YARDIMCILAR
// ============================================================

function logInfo(...a) { console.log('[INFO]', ...a); }
function logError(...a) { console.error('[ERROR]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v, d = 8) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }

function sma(values, period) {
    if (!values || values.length < period) return null;
    const arr = values.slice(-period).map(Number).filter(Number.isFinite);
    if (arr.length !== period) return null;
    return arr.reduce((a, b) => a + b, 0) / period;
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
        const h = Number(candles[i][2]), l = Number(candles[i][3]), pc = Number(candles[i - 1][4]);
        if (![h, l, pc].every(Number.isFinite)) continue;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return sma(trs, period);
}

function rsi(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
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
    return CONFIG.EXCLUDED_BASES.includes(base);
}

// ============================================================
// DÜZELTME 5: TREND CACHE
// ============================================================

async function getTrends(symbol) {
    const cached = trendCache.get(symbol);
    if (cached && Date.now() - cached.ts < CONFIG.TREND_CACHE_MS) {
        return cached.value;
    }
    try {
        const raw1h = await exchange.fetchOHLCV(symbol, CONFIG.HTF1, undefined, 100);
        const c1h = closedCandles(raw1h).map(c => Number(c[4]));
        const e21_1h = ema(c1h, CONFIG.EMA_FAST), e50_1h = ema(c1h, CONFIG.EMA_SLOW);
        let trend1h = 'SIDEWAYS';
        if (e21_1h && e50_1h) {
            if (e21_1h > e50_1h * 1.001) trend1h = 'BULLISH';
            else if (e21_1h < e50_1h * 0.999) trend1h = 'BEARISH';
        }
        const raw4h = await exchange.fetchOHLCV(symbol, CONFIG.HTF2, undefined, 100);
        const c4h = closedCandles(raw4h).map(c => Number(c[4]));
        const e21_4h = ema(c4h, CONFIG.EMA_FAST), e50_4h = ema(c4h, CONFIG.EMA_SLOW);
        let trend4h = 'SIDEWAYS';
        if (e21_4h && e50_4h) {
            if (e21_4h > e50_4h * 1.001) trend4h = 'BULLISH';
            else if (e21_4h < e50_4h * 0.999) trend4h = 'BEARISH';
        }
        const value = { trend1h, trend4h };
        trendCache.set(symbol, { ts: Date.now(), value });
        return value;
    } catch {
        return { trend1h: 'SIDEWAYS', trend4h: 'SIDEWAYS' };
    }
}

// ============================================================
// MARKET STATUS
// ============================================================

async function updateMarketStatus() {
    try {
        const rawBTC = await exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 250);
        const cBTC = closedCandles(rawBTC).map(c => Number(c[4]));
        const e200BTC = ema(cBTC, 200), lastBTC = cBTC[cBTC.length - 1];
        let btcTrend = 'SIDEWAYS';
        if (e200BTC && lastBTC > e200BTC * 1.002) btcTrend = 'BULLISH';
        else if (e200BTC && lastBTC < e200BTC * 0.998) btcTrend = 'BEARISH';

        const rawETH = await exchange.fetchOHLCV('ETH/USDT:USDT', '1h', undefined, 250);
        const cETH = closedCandles(rawETH).map(c => Number(c[4]));
        const e200ETH = ema(cETH, 200), lastETH = cETH[cETH.length - 1];
        let ethTrend = 'SIDEWAYS';
        if (e200ETH && lastETH > e200ETH * 1.002) ethTrend = 'BULLISH';
        else if (e200ETH && lastETH < e200ETH * 0.998) ethTrend = 'BEARISH';

        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'], ethT = tickers['ETH/USDT:USDT'];
        const btcChg = btcT ? Number(btcT.percentage) : 0;
        const ethChg = ethT ? Number(ethT.percentage) : 0;

        let score = 0;
        if (btcTrend === 'BULLISH') score += 2; else if (btcTrend === 'BEARISH') score -= 2;
        if (ethTrend === 'BULLISH') score += 2; else if (ethTrend === 'BEARISH') score -= 2;
        if (Number.isFinite(btcChg)) {
            if (btcChg > 2) score += 2; else if (btcChg > 0.5) score += 1;
            else if (btcChg < -2) score -= 2; else if (btcChg < -0.5) score -= 1;
        }
        if (Number.isFinite(ethChg)) {
            if (ethChg > 2) score += 2; else if (ethChg > 0.5) score += 1;
            else if (ethChg < -2) score -= 2; else if (ethChg < -0.5) score -= 1;
        }

        let overall;
        if (score >= 5) overall = 'BULLISH';
        else if (score >= 2) overall = 'BULLISH_WEAK';
        else if (score <= -5) overall = 'BEARISH';
        else if (score <= -2) overall = 'BEARISH_WEAK';
        else overall = 'MIXED';

        marketStatus = {
            btc: { trend: btcTrend, price: btcT ? num(btcT.last) : null, change24h: Number.isFinite(btcChg) ? num(btcChg, 2) : null },
            eth: { trend: ethTrend, price: ethT ? num(ethT.last) : null, change24h: Number.isFinite(ethChg) ? num(ethChg, 2) : null },
            overall, score, updatedAt: Date.now()
        };
        broadcast();
    } catch (err) { logError(`[marketStatus] ${err.message}`); }
}

// ============================================================
// SEVİYE TESPİTİ
// ============================================================

function findLevels(candles) {
    const slice = candles.slice(-CONFIG.LEVEL_LOOKBACK);
    const highs = [], lows = [];
    for (let i = 2; i < slice.length - 2; i++) {
        const h = Number(slice[i][2]), l = Number(slice[i][3]);
        const hL = Number(slice[i-1][2]), hR = Number(slice[i+1][2]);
        const lL = Number(slice[i-1][3]), lR = Number(slice[i+1][3]);
        if (h > hL && h > hR) highs.push(h);
        if (l < lL && l < lR) lows.push(l);
    }

    function cluster(levels) {
        if (!levels.length) return [];
        const sorted = [...levels].sort((a, b) => a - b);
        const clusters = [];
        let group = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            if ((sorted[i] - group[group.length - 1]) / group[group.length - 1] < CONFIG.LEVEL_TOLERANCE * 2) {
                group.push(sorted[i]);
            } else {
                clusters.push({ price: group.reduce((a, b) => a + b, 0) / group.length, count: group.length });
                group = [sorted[i]];
            }
        }
        clusters.push({ price: group.reduce((a, b) => a + b, 0) / group.length, count: group.length });
        return clusters;
    }

    return {
        resistances: cluster(highs).filter(c => c.count >= CONFIG.LEVEL_STRENGTH_MIN).sort((a, b) => a.price - b.price),
        supports: cluster(lows).filter(c => c.count >= CONFIG.LEVEL_STRENGTH_MIN).sort((a, b) => b.price - a.price)
    };
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQuality({ direction, trend1h, trend4h, volumeRatio, rsiValue, bodyRatio, levelStrength }) {
    let score = 0;
    const breakdown = [];

    if (direction === 'LONG') {
        if (trend4h === 'BULLISH') { score += 20; breakdown.push('✅ 4h trend yukarı (+20)'); }
        if (trend1h === 'BULLISH') { score += 20; breakdown.push('✅ 1h trend yukarı (+20)'); }
    } else {
        if (trend4h === 'BEARISH') { score += 20; breakdown.push('✅ 4h trend aşağı (+20)'); }
        if (trend1h === 'BEARISH') { score += 20; breakdown.push('✅ 1h trend aşağı (+20)'); }
    }

    if (volumeRatio >= 4.0) { score += 20; breakdown.push(`✅ Çok güçlü hacim ${num(volumeRatio, 1)}x (+20)`); }
    else if (volumeRatio >= 3.0) { score += 15; breakdown.push(`✅ Güçlü hacim ${num(volumeRatio, 1)}x (+15)`); }

    if (bodyRatio >= 1.0) { score += 15; breakdown.push(`✅ Çok güçlü mum ${num(bodyRatio, 2)}x (+15)`); }
    else if (bodyRatio >= 0.7) { score += 10; breakdown.push(`✅ Güçlü mum ${num(bodyRatio, 2)}x (+10)`); }

    if (levelStrength >= 5) { score += 15; breakdown.push(`✅ Çok güçlü seviye (${levelStrength}x) (+15)`); }
    else if (levelStrength >= 4) { score += 10; breakdown.push(`✅ Güçlü seviye (${levelStrength}x) (+10)`); }
    else if (levelStrength >= 3) { score += 5; breakdown.push(`🟡 Normal seviye (${levelStrength}x) (+5)`); }

    if (rsiValue != null) {
        if (direction === 'LONG') {
            if (rsiValue >= 50 && rsiValue <= 65) { score += 10; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+10)`); }
            else if (rsiValue >= 45 && rsiValue < 50) { score += 5; breakdown.push(`🟡 RSI nötr (+5)`); }
        } else {
            if (rsiValue >= 35 && rsiValue <= 50) { score += 10; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+10)`); }
            else if (rsiValue > 50 && rsiValue <= 55) { score += 5; breakdown.push(`🟡 RSI nötr (+5)`); }
        }
    }

    return { score: Math.min(score, 100), breakdown };
}

// ============================================================
// ANA TARAMA — DÜZELTİLMİŞ
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (isExcluded(symbol)) return null;

        // 1. MUM VERİSİ
        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.LEVEL_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]), open = Number(last[1]);
        const volume = Number(last[5]);
        if (![close, open, volume].every(Number.isFinite)) return null;

        // DÜZELTME 4: TAZE MUM KONTROLÜ
        const candleCloseTime = Number(last[0]) + 15 * 60 * 1000;
        if (Date.now() - candleCloseTime > CONFIG.FRESH_CANDLE_MS) {
            DEBUG.rejectedFresh++;
            return null;
        }

        const priorCandles = candles.slice(0, -1);
        const prevClose = Number(priorCandles[priorCandles.length - 1][4]);
        const closes = candles.map(c => Number(c[4]));  // RSI için tüm mumlar

        const volumes = priorCandles.slice(-30).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(30, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);
        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        // 2. SEVİYE TESPİTİ
        const levels = findLevels(priorCandles);
        const buf = currentATR * CONFIG.BREAKOUT_BUFFER_ATR;

        // DÜZELTME 1 + 2: GEÇİŞ KONTROLÜ + EN YAKIN SEVİYE
        let direction = null, level = null, levelStrength = 0;

        // Direnç kırılımı → LONG
        const brokenRes = levels.resistances
            .filter(r => prevClose <= r.price && close > r.price + buf)
            .sort((a, b) => b.price - a.price)[0];   // en yakın = en yüksek

        if (brokenRes) {
            direction = 'LONG';
            level = brokenRes.price;
            levelStrength = brokenRes.count;
        }

        // Destek kırılımı → SHORT
        if (!direction) {
            const brokenSup = levels.supports
                .filter(s => prevClose >= s.price && close < s.price - buf)
                .sort((a, b) => a.price - b.price)[0];   // en yakın = en düşük
            if (brokenSup) {
                direction = 'SHORT';
                level = brokenSup.price;
                levelStrength = brokenSup.count;
            }
        }

        if (!direction || !level) return null;
        DEBUG.breakouts++;

        // 3. HACİM FİLTRESİ (erken)
        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) { DEBUG.rejectedVolume++; return null; }

        // 4. GÖVDE FİLTRESİ (erken)
        if (bodyRatio < CONFIG.MIN_BODY_ATR_RATIO) { DEBUG.rejectedBody++; return null; }

        // DÜZELTME 1: AŞIRI UZAMIŞ GİRİŞ KONTROLÜ
        const entryDistanceATR = Math.abs(close - level) / currentATR;
        if (entryDistanceATR > CONFIG.MAX_ENTRY_DISTANCE_ATR) {
            DEBUG.rejectedDistance++;
            return null;
        }

        // 5. RSI FİLTRESİ (erken)
        if (rsiValue != null) {
            if (direction === 'LONG' && rsiValue > CONFIG.RSI_OVERBOUGHT) { DEBUG.rejectedRSI++; return null; }
            if (direction === 'SHORT' && rsiValue < CONFIG.RSI_OVERSOLD) { DEBUG.rejectedRSI++; return null; }
        }

        // 6. PİYASA YÖNÜ (DÜZELTME 3)
        if (direction === 'LONG' && marketStatus.score < CONFIG.MIN_MARKET_SCORE) { DEBUG.rejectedMarket++; return null; }
        if (direction === 'SHORT' && marketStatus.score > -CONFIG.MIN_MARKET_SCORE) { DEBUG.rejectedMarket++; return null; }

        // 7. TREND FİLTRESİ (en son — cache'li)
        const trends = await getTrends(symbol);
        const trendOk =
            (direction === 'LONG' && trends.trend1h === 'BULLISH' && trends.trend4h === 'BULLISH') ||
            (direction === 'SHORT' && trends.trend1h === 'BEARISH' && trends.trend4h === 'BEARISH');
        if (!trendOk) { DEBUG.rejectedTrend++; return null; }

        // KALİTE
        const quality = calculateQuality({
            direction, trend1h: trends.trend1h, trend4h: trends.trend4h,
            volumeRatio, rsiValue, bodyRatio, levelStrength
        });
        if (quality.score < CONFIG.MIN_QUALITY_SCORE) { DEBUG.rejectedQuality++; return null; }

        // COOLDOWN
        const key = `${symbol}_${direction}`;
        const lastTime = lastSignalTime.get(key) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejectedCooldown++; return null; }

        // STOP / TP
        let stop, tp1, tp2;
        const stopDist = currentATR * CONFIG.STOP_ATR_MULT;
        if (direction === 'LONG') {
            stop = Math.min(level - stopDist * 0.5, Number(last[3]));
            const risk = close - stop;
            tp1 = close + risk * CONFIG.TP1_RR;
            tp2 = close + risk * CONFIG.TP2_RR;
        } else {
            stop = Math.max(level + stopDist * 0.5, Number(last[2]));
            const risk = stop - close;
            tp1 = close - risk * CONFIG.TP1_RR;
            tp2 = close - risk * CONFIG.TP2_RR;
        }

        lastSignalTime.set(key, Date.now());
        DEBUG.signals++;
        if (direction === 'LONG') DEBUG.long++; else DEBUG.short++;

        logInfo(`🎯 KIRILIM ${direction} | ${symbol} | Seviye ${num(level)} (${levelStrength}x) | Q${quality.score} | Hacim ${num(volumeRatio,1)}x | Mum ${num(bodyRatio,2)}x | Mesafe ${num(entryDistanceATR,2)} ATR`);

        return {
            id: `${symbol.replace(/[^A-Z0-9]/gi,'')}_${direction}_${Date.now()}`,
            symbol, symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            signalType: direction === 'LONG' ? 'DIRENC_KIRILIM' : 'DESTEK_KIRILIM',
            timeframe: '15m',
            entry: num(close), currentPrice: num(close), pnlPct: 0,
            stop: num(stop), tp1: num(tp1), tp2: num(tp2),
            level: num(level), levelStrength,
            volumeRatio: num(volumeRatio, 2), bodyRatio: num(bodyRatio, 2),
            rsi: num(rsiValue, 1), atr: num(currentATR),
            entryDistanceATR: num(entryDistanceATR, 2),
            trend1h: trends.trend1h, trend4h: trends.trend4h,
            qualityScore: quality.score, qualityBreakdown: quality.breakdown,
            status: 'ACTIVE', closeReason: null,
            candles: candles.slice(-60).map(c => ({ t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]) })),
            timestamp: Date.now(), updatedAt: Date.now(),
            expiresAt: Date.now() + CONFIG.SIGNAL_VALID_MS
        };
    } catch (err) {
        DEBUG.errors++;
        return null;
    }
}

// ============================================================
// LIVE PRICES
// ============================================================

async function updateLivePrices() {
    if (!signals.length) return;
    try {
        const activeSymbols = signals.filter(s => s.status === 'ACTIVE').map(s => s.symbol);
        if (!activeSymbols.length) return;
        const tickers = await exchange.fetchTickers(activeSymbols);
        const now = Date.now();
        let changed = false;

        for (const sig of signals) {
            if (sig.status !== 'ACTIVE') continue;
            const t = tickers[sig.symbol];
            if (!t || !Number(t.last)) continue;

            sig.currentPrice = num(t.last);
            sig.updatedAt = now;

            const entry = Number(sig.entry), current = Number(t.last);
            const stop = Number(sig.stop), tp1 = Number(sig.tp1), tp2 = Number(sig.tp2);

            if (sig.direction === 'LONG' && current < Number(sig.level) * 0.997) {
                sig.status = 'FAKEOUT'; sig.closeReason = 'Sahte kırılım'; sig.closedAt = now;
                escapedSignals.unshift({ ...sig });
                escapedSignals = escapedSignals.slice(0, CONFIG.MAX_ESCAPED_KEPT);
                changed = true; continue;
            }
            if (sig.direction === 'SHORT' && current > Number(sig.level) * 1.003) {
                sig.status = 'FAKEOUT'; sig.closeReason = 'Sahte kırılım'; sig.closedAt = now;
                escapedSignals.unshift({ ...sig });
                escapedSignals = escapedSignals.slice(0, CONFIG.MAX_ESCAPED_KEPT);
                changed = true; continue;
            }

            if (sig.direction === 'LONG') {
                sig.pnlPct = num(((current - entry) / entry) * 100, 2);
                if (current <= stop) { sig.status = 'STOPPED'; sig.closeReason = 'Stop'; sig.closedAt = now; }
                else if (current >= tp2) { sig.status = 'TP2_HIT'; sig.closeReason = 'TP2'; sig.closedAt = now; }
                else if (current >= tp1 && sig.status === 'ACTIVE') { sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 (izlemeye devam)'; sig.closedAt = null; }
            } else {
                sig.pnlPct = num(((entry - current) / entry) * 100, 2);
                if (current >= stop) { sig.status = 'STOPPED'; sig.closeReason = 'Stop'; sig.closedAt = now; }
                else if (current <= tp2) { sig.status = 'TP2_HIT'; sig.closeReason = 'TP2'; sig.closedAt = now; }
                else if (current <= tp1 && sig.status === 'ACTIVE') { sig.status = 'TP1_HIT'; sig.closeReason = 'TP1 (izlemeye devam)'; sig.closedAt = null; }
            }

            if (sig.status === 'ACTIVE' && now > sig.expiresAt) {
                sig.status = 'EXPIRED'; sig.closeReason = 'Süre doldu'; sig.closedAt = now;
            }
            changed = true;
        }

        if (changed) broadcast();
    } catch (err) {}
}

// ============================================================
// PRESCAN + SCAN
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
        logInfo(`RADAR | ${targets.length} coin`);
    } catch (err) { logError(`[runPreScan] ${err.message}`); }
}

async function runScan() {
    if (scanRunning) return;
    scanRunning = true;

    DEBUG.scanned = 0; DEBUG.breakouts = 0; DEBUG.signals = 0; DEBUG.long = 0; DEBUG.short = 0;
    DEBUG.rejectedFresh = 0; DEBUG.rejectedDistance = 0; DEBUG.rejectedTrend = 0;
    DEBUG.rejectedVolume = 0; DEBUG.rejectedBody = 0; DEBUG.rejectedRSI = 0;
    DEBUG.rejectedMarket = 0; DEBUG.rejectedQuality = 0; DEBUG.rejectedCooldown = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;
    try {
        for (const symbol of targets) {
            if (isShuttingDown) break;
            if (newSignals >= CONFIG.MAX_SIGNALS_PER_SCAN) break;
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
    } catch (err) { logError(`[runScan] ${err.message}`); }

    scanRunning = false;
    APP_STATE.scanStatus = { message: `Tarama bitti | ${newSignals} yeni`, isScanning: false };
    broadcast();
    logInfo(`[TARAMA] Tarandı=${DEBUG.scanned} | Kırılım=${DEBUG.breakouts} | Yeni=${newSignals} | Taze=${DEBUG.rejectedFresh} | Mesafe=${DEBUG.rejectedDistance} | Trend=${DEBUG.rejectedTrend} | Hacim=${DEBUG.rejectedVolume} | Mum=${DEBUG.rejectedBody} | RSI=${DEBUG.rejectedRSI} | Piyasa=${DEBUG.rejectedMarket} | Kalite=${DEBUG.rejectedQuality}`);
}

// ============================================================
// API + WS
// ============================================================

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    const active = signals.filter(s => s.status === 'ACTIVE' || s.status === 'TP1_HIT');
    return {
        success: true,
        signals: signals.slice(0, 100),
        escaped: escapedSignals.slice(0, 50),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        stats: {
            total: signals.length, active: active.length,
            long: active.filter(s => s.direction === 'LONG').length,
            short: active.filter(s => s.direction === 'SHORT').length,
            escaped: escapedSignals.length
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

app.get('/api/signals', (req, res) => { res.set('Cache-Control','no-store'); res.json(snapshot()); });
app.get('/api/market-status', (req, res) => res.json({ success: true, marketStatus }));
app.get('/api/health', (req, res) => res.json({ ok: true, targets: targets.length, signals: signals.length }));
app.delete('/api/signals', (req, res) => { signals = []; broadcast(); res.json({ success: true }); });
app.delete('/api/escaped', (req, res) => { escapedSignals = []; broadcast(); res.json({ success: true }); });

// ============================================================
// FRONTEND
// ============================================================

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v6.1</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:12px}
.market-brand{font-size:14px;font-weight:900}
.market-brand span{color:#17d7a0}
.market-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.market-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0e14;border-radius:5px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700}
.market-item .chg{padding:1px 5px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.market-overall{padding:6px 14px;border-radius:5px;font-size:11px;font-weight:800}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}
.conn-status{padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;background:#1c2634;color:#8b97a5}
.conn-status.online{background:rgba(0,255,157,0.15);color:#00ff9d}
.conn-status.offline{background:rgba(255,56,96,0.15);color:#ff3860}
.content{display:flex;flex:1;overflow:hidden}
.sidebar{width:400px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-tabs{display:flex;background:#0a0e14;border-bottom:1px solid #1c2634}
.side-tab{flex:1;padding:12px 4px;text-align:center;cursor:pointer;font-size:10px;font-weight:800;text-transform:uppercase;color:#5e6b7c;border-bottom:2px solid transparent;background:transparent;border:none;font-family:inherit}
.side-tab.active{color:#00ff9d;border-bottom-color:#00ff9d}
.side-tab .count{display:inline-block;font-size:9px;padding:1px 5px;border-radius:10px;background:#1c2634;color:#c5cfdd;margin-left:3px}
.side-tab.active .count{background:#00ff9d;color:#0a0e14}
.side-list{flex:1;overflow-y:auto;padding:8px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}
.sig-card{margin-bottom:10px;padding:12px;border-radius:10px;cursor:pointer;background:#0f1620;border:1px solid #1c2634}
.sig-card:hover{background:#141d28}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 2px rgba(23,215,160,0.4)}
.sig-card.long{border-left:4px solid #00ff9d}
.sig-card.short{border-left:4px solid #ff3860}
.sig-card.closed{opacity:0.5}
.sig-card.fakeout{border-left:4px solid #8b97a5;background:#0f1216;opacity:0.75}
.dir-badge{display:inline-block;font-size:13px;font-weight:900;padding:5px 14px;border-radius:6px}
.dir-badge.long{background:#00ff9d;color:#0a0e14}
.dir-badge.short{background:#ff3860;color:#fff}
.status-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.status-badge.active{background:rgba(0,255,157,0.2);color:#00ff9d;border:1px solid #00ff9d}
.status-badge.tp1{background:#2962ff;color:#fff}
.status-badge.tp2{background:#8a5cff;color:#fff}
.status-badge.stopped{background:#ff3860;color:#fff}
.status-badge.expired{background:#5e6b7c;color:#fff}
.status-badge.fakeout{background:#8b97a5;color:#0a0e14}
.type-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.type-badge.destek{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.4)}
.type-badge.direnc{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}
.trend-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.trend-badge.bullish{background:rgba(0,255,157,0.2);color:#00ff9d}
.trend-badge.bearish{background:rgba(255,56,96,0.2);color:#ff3860}
.trend-badge.sideways{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.quality-badge.high{background:rgba(0,255,157,0.2);color:#00ff9d}
.quality-badge.med{background:rgba(246,196,83,0.2);color:#f6c453}
.sig-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.sig-sym{font-size:16px;font-weight:900}
.levels-grid{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px}
.level-item{display:flex;justify-content:space-between;padding:5px 8px;background:#0a0e14;border-radius:4px}
.level-item .k{color:#5e6b7c}
.level-item .v{font-weight:700;color:#c5cfdd}
.level-item.entry .v{color:#4a7cff}
.level-item.stop .v{color:#ff3860}
.level-item.tp1 .v{color:#00ff9d}
.level-item.tp2 .v{color:#8a5cff}
.sig-price{margin-top:10px;display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #1c2634}
.sig-price .cur{font-weight:700;font-size:15px}
.sig-price .pnl{padding:3px 8px;border-radius:4px;font-weight:800;font-size:12px}
.sig-price .pnl.pos{background:rgba(0,255,157,0.15);color:#00ff9d}
.sig-price .pnl.neg{background:rgba(255,56,96,0.15);color:#ff3860}
.action-hint{margin-top:8px;padding:8px 10px;border-radius:5px;font-size:11px;font-weight:600}
.action-hint.buy{background:rgba(0,255,157,0.1);color:#00ff9d;border-left:3px solid #00ff9d}
.action-hint.sell{background:rgba(41,98,255,0.1);color:#4a7cff;border-left:3px solid #2962ff}
.action-hint.exit{background:rgba(255,56,96,0.1);color:#ff3860;border-left:3px solid #ff3860}
.action-hint.neutral{background:rgba(139,151,165,0.1);color:#8b97a5;border-left:3px solid #5e6b7c}
.sig-meta{margin-top:8px;font-size:10px;color:#5e6b7c;display:flex;gap:10px;flex-wrap:wrap}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:13px;flex-direction:column;gap:10px}
.main-empty-icon{font-size:40px;opacity:0.3}
.chart-head{padding:12px 16px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219;flex-wrap:wrap;gap:10px}
.chart-sym{font-size:20px;font-weight:900}
.chart-actions{display:flex;gap:6px}
.btn-sm{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;text-decoration:none}
.btn-sm.tv{background:#2962ff;border-color:#2962ff;color:#fff}
.chart-wrap{flex:1;position:relative;background:#070b11;min-height:200px}
#mainCanvas{width:100%;height:100%;display:block}
.chart-info{padding:12px 16px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.chart-info-item{display:flex;flex-direction:column;gap:3px;padding:10px;background:#0a0e14;border-radius:6px}
.chart-info-lbl{color:#5e6b7c;text-transform:uppercase;font-size:9px;font-weight:700}
.chart-info-val{font-weight:800;font-size:14px}
.empty-msg{padding:30px 16px;text-align:center;color:#5e6b7c;font-size:11px;line-height:1.8}
</style>
</head>
<body>
<div class="app">
<div class="market-bar">
<div style="display:flex;gap:12px;align-items:center">
<div class="market-brand">SONER <span>TRADE</span> <span class="market-badge">v6.1 • DÜZELTİLDİ</span></div>
<div class="market-item"><span class="sym">BTC</span><span class="price" id="btcPrice">-</span><span class="chg" id="btcChg">-</span></div>
<div class="market-item"><span class="sym">ETH</span><span class="price" id="ethPrice">-</span><span class="chg" id="ethChg">-</span></div>
</div>
<div style="display:flex;gap:10px;align-items:center">
<div class="market-overall mixed" id="marketOverall">-</div>
<div class="conn-status" id="connStatus">Bağlanıyor...</div>
</div>
</div>
<div class="content">
<div class="sidebar">
<div class="side-tabs">
<button class="side-tab active" data-tab="signals" id="tabSignals">🎯 SİNYAL <span class="count" id="cSignals">0</span></button>
<button class="side-tab" data-tab="escaped" id="tabEscaped">📁 KAÇAN <span class="count" id="cEscaped">0</span></button>
</div>
<div class="side-list" id="sideList"></div>
</div>
<div class="main">
<div id="mainEmpty" class="main-empty">
<div class="main-empty-icon">🎯</div>
<div>Soldan bir kart seç</div>
<div style="font-size:10px;color:#5e6b7c;margin-top:6px" id="emptyInfo">Yükleniyor...</div>
</div>
<div id="mainContent" style="display:none;flex-direction:column;flex:1">
<div class="chart-head">
<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
<div class="chart-sym" id="chartSym">-</div>
<div id="chartDir"></div>
<div id="chartType"></div>
<div id="chartTrend"></div>
<div id="chartQuality"></div>
<div id="chartStatus"></div>
</div>
<div class="chart-actions"><a class="btn-sm tv" id="tvLink" target="_blank">📈 TradingView</a></div>
</div>
<div class="chart-wrap"><canvas id="mainCanvas"></canvas></div>
<div class="chart-info">
<div class="chart-info-item"><div class="chart-info-lbl">Giriş</div><div class="chart-info-val" style="color:#4a7cff" id="infoEntry">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">Stop</div><div class="chart-info-val" style="color:#ff3860" id="infoStop">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">TP1</div><div class="chart-info-val" style="color:#00ff9d" id="infoTp1">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">TP2</div><div class="chart-info-val" style="color:#8a5cff" id="infoTp2">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">Seviye</div><div class="chart-info-val" style="color:#f6c453" id="infoLevel">-</div></div>
</div>
</div>
</div>
</div>
</div>
<script>
var signals=[];var escaped=[];var selectedId=null;var currentTab='signals';var ws=null;var lastActiveCount=0;var audioCtx=null;var reconnectTimer=null;var pollTimer=null;
function fmt(v){v=Number(v);if(!Number.isFinite(v))return'-';if(v>=1000)return v.toFixed(2);if(v>=100)return v.toFixed(3);if(v>=1)return v.toFixed(4);return v.toFixed(6);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function timeAgo(ts){if(!ts)return'-';var d=Date.now()-ts;var m=Math.floor(d/60000);if(m<1)return'az önce';if(m<60)return m+' dk';var h=Math.floor(m/60);return h+' sa';}
function playSound(){try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator();var g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=880;g.gain.setValueAtTime(0.15,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.4);o.start();o.stop(audioCtx.currentTime+0.4);}catch(e){}}
function setConnStatus(s,t){var el=document.getElementById('connStatus');el.className='conn-status '+s;el.textContent=t;}
function renderMarketBar(ms){if(!ms||!ms.btc||!ms.eth)return;
document.getElementById('btcPrice').textContent=fmt(ms.btc.price);
var bc=document.getElementById('btcChg');if(ms.btc.change24h!=null){bc.textContent=(ms.btc.change24h>=0?'+':'')+ms.btc.change24h+'%';bc.className='chg '+(ms.btc.change24h>=0?'up':'down');}
document.getElementById('ethPrice').textContent=fmt(ms.eth.price);
var ec=document.getElementById('ethChg');if(ms.eth.change24h!=null){ec.textContent=(ms.eth.change24h>=0?'+':'')+ms.eth.change24h+'%';ec.className='chg '+(ms.eth.change24h>=0?'up':'down');}
var o=document.getElementById('marketOverall');var l='KARIŞIK',c='mixed';
if(ms.overall==='BULLISH'){l='PİYASA YUKARI';c='bullish';}
else if(ms.overall==='BEARISH'){l='PİYASA AŞAĞI';c='bearish';}
else if(ms.overall==='BULLISH_WEAK'){l='YUKARI (ZAYIF)';c='bullish';}
else if(ms.overall==='BEARISH_WEAK'){l='AŞAĞI (ZAYIF)';c='bearish';}
o.textContent=l+' (Skor: '+ms.score+')';o.className='market-overall '+c;}
function statusBadge(s){if(s.status==='ACTIVE')return'<span class="status-badge active">● AKTİF</span>';if(s.status==='TP1_HIT')return'<span class="status-badge tp1">✓ TP1</span>';if(s.status==='TP2_HIT')return'<span class="status-badge tp2">✓✓ TP2</span>';if(s.status==='STOPPED')return'<span class="status-badge stopped">✗ STOP</span>';if(s.status==='EXPIRED')return'<span class="status-badge expired">⏱ SÜRE</span>';if(s.status==='FAKEOUT')return'<span class="status-badge fakeout">✗ SAHTE</span>';return'';}
function qClass(q){if(q>=90)return'high';if(q>=80)return'med';return'low';}
function trendBadge(t){if(t==='BULLISH')return'<span class="trend-badge bullish">4h ⬆</span>';if(t==='BEARISH')return'<span class="trend-badge bearish">4h ⬇</span>';return'<span class="trend-badge sideways">4h ⬌</span>';}
function trendBadge1(t){if(t==='BULLISH')return'<span class="trend-badge bullish">1h ⬆</span>';if(t==='BEARISH')return'<span class="trend-badge bearish">1h ⬇</span>';return'<span class="trend-badge sideways">1h ⬌</span>';}
function actionHint(s){if(s.status==='ACTIVE')return'<div class="action-hint buy">✅ Gir — kırılım onaylı</div>';if(s.status==='TP1_HIT')return'<div class="action-hint sell">💰 Yarısını sat — TP2 bekle</div>';if(s.status==='TP2_HIT')return'<div class="action-hint sell">🎉 Tamamını sat</div>';if(s.status==='STOPPED')return'<div class="action-hint exit">❌ Çık — stop</div>';if(s.status==='EXPIRED')return'<div class="action-hint neutral">⏱ Süre doldu</div>';if(s.status==='FAKEOUT')return'<div class="action-hint neutral">✗ Sahte kırılım</div>';return'';}
function renderCard(s,fakeout){var dc=s.direction==='LONG'?'long':'short';var sel=s.id===selectedId?'selected':'';var cl=(s.status!=='ACTIVE'&&s.status!=='TP1_HIT')?'closed':'';var fo=fakeout?'fakeout':'';var pnl=(s.pnlPct||0)>=0?'pos':'neg';var pnls=(s.pnlPct||0)>=0?'+':'';var q=s.qualityScore||0;
var typeLabel=s.signalType==='DIRENC_KIRILIM'?'🟢 DİRENÇ KIRILDI':'🔴 DESTEK KIRILDI';
var typeCls=s.signalType==='DIRENC_KIRILIM'?'direnc':'destek';
return'<div class="sig-card '+dc+' '+sel+' '+cl+' '+fo+'" data-id="'+esc(s.id)+'">'
+'<div class="sig-row"><div class="sig-sym">'+esc(s.symbol.replace(':USDT',''))+'</div><div class="dir-badge '+dc+'">'+s.direction+'</div></div>'
+'<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px">'
+statusBadge(s)
+'<span class="type-badge '+typeCls+'">'+typeLabel+'</span>'
+trendBadge1(s.trend1h)+trendBadge(s.trend4h)
+'<span class="quality-badge '+qClass(q)+'">Q'+q+'</span>'
+'</div>'
+'<div class="levels-grid">'
+'<div class="level-item entry"><span class="k">Giriş</span><span class="v">'+fmt(s.entry)+'</span></div>'
+'<div class="level-item stop"><span class="k">Stop</span><span class="v">'+fmt(s.stop)+'</span></div>'
+'<div class="level-item tp1"><span class="k">TP1</span><span class="v">'+fmt(s.tp1)+'</span></div>'
+'<div class="level-item tp2"><span class="k">TP2</span><span class="v">'+fmt(s.tp2)+'</span></div>'
+'</div>'
+'<div class="sig-price"><span class="cur">'+fmt(s.currentPrice||s.entry)+'</span>'+(s.pnlPct!=null?'<span class="pnl '+pnl+'">'+pnls+s.pnlPct+'%</span>':'')+'</div>'
+actionHint(s)
+'<div class="sig-meta"><span>📊 '+s.volumeRatio+'x</span><span>🎯 RSI '+s.rsi+'</span><span>📍 Seviye '+s.levelStrength+'x</span><span>📏 '+s.entryDistanceATR+' ATR</span><span>⏱ '+timeAgo(s.timestamp)+'</span></div>'
+'</div>';}
function renderList(){var el=document.getElementById('sideList');var html='';
if(currentTab==='signals'){
var active=signals.filter(s=>s.status==='ACTIVE'||s.status==='TP1_HIT');
var closed=signals.filter(s=>s.status!=='ACTIVE'&&s.status!=='TP1_HIT');
if(active.length>0)html+=active.map(function(s){return renderCard(s,false);}).join('');
if(closed.length>0){html+='<div style="padding:14px 8px 6px;font-size:10px;font-weight:800;color:#5e6b7c;letter-spacing:1px">📁 KAPANANLAR</div>';html+=closed.slice(0,20).map(function(s){return renderCard(s,false);}).join('');}
if(!html)html='<div class="empty-msg">🎯 Henüz sinyal yok.<br><br>Kırılım + 7 filtre onayı<br>olunca burada görünecek.</div>';
}else{
if(escaped.length>0)html+=escaped.slice(0,30).map(function(s){return renderCard(s,true);}).join('');
else html='<div class="empty-msg">📁 Henüz kaçan sinyal yok.<br><br>Sahte kırılımlar burada listelenir.</div>';
}
el.innerHTML=html;
el.querySelectorAll('.sig-card[data-id]').forEach(function(c){c.onclick=function(){selectedId=c.getAttribute('data-id');renderList();renderMain();};});}
function renderMain(){if(!selectedId){document.getElementById('mainEmpty').style.display='flex';document.getElementById('mainContent').style.display='none';return;}
var all=signals.concat(escaped);var s=all.find(function(x){return x.id===selectedId;});
if(!s){document.getElementById('mainEmpty').style.display='flex';document.getElementById('mainContent').style.display='none';return;}
document.getElementById('mainEmpty').style.display='none';
document.getElementById('mainContent').style.display='flex';
document.getElementById('chartSym').textContent=s.symbol.replace(':USDT','');
document.getElementById('chartDir').innerHTML='<div class="dir-badge '+(s.direction==='LONG'?'long':'short')+'">'+s.direction+'</div>';
document.getElementById('chartType').innerHTML='<span class="type-badge '+(s.signalType==='DIRENC_KIRILIM'?'direnc':'destek')+'">'+(s.signalType==='DIRENC_KIRILIM'?'🟢 DİRENÇ KIRILDI':'🔴 DESTEK KIRILDI')+'</span>';
document.getElementById('chartTrend').innerHTML=trendBadge1(s.trend1h)+trendBadge(s.trend4h);
document.getElementById('chartQuality').innerHTML='<span class="quality-badge '+qClass(s.qualityScore)+'">Kalite '+s.qualityScore+'/100</span>';
document.getElementById('chartStatus').innerHTML=statusBadge(s);
document.getElementById('tvLink').href='https://www.tradingview.com/chart/?symbol=BITGET:'+s.symbolTV+'&interval=15';
document.getElementById('infoEntry').textContent=fmt(s.entry);
document.getElementById('infoStop').textContent=fmt(s.stop);
document.getElementById('infoTp1').textContent=fmt(s.tp1);
document.getElementById('infoTp2').textContent=fmt(s.tp2);
document.getElementById('infoLevel').textContent=fmt(s.level)+' ('+s.levelStrength+'x)';
setTimeout(function(){drawChart(s);},30);}
function drawChart(s){var canvas=document.getElementById('mainCanvas');var parent=canvas.parentElement;var W=parent.clientWidth,H=parent.clientHeight;var dpr=window.devicePixelRatio||1;canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=s.direction==='LONG'?'#08120d':'#12080c';ctx.fillRect(0,0,W,H);
var candles=s.candles;if(!candles||!candles.length)return;var count=candles.length;
var minP=Infinity,maxP=-Infinity;for(var i=0;i<candles.length;i++){var lo=Number(candles[i].l),hi=Number(candles[i].h);if(lo<minP)minP=lo;if(hi>maxP)maxP=hi;}
[s.entry,s.stop,s.tp1,s.tp2,s.currentPrice,s.level].forEach(function(v){if(v==null)return;v=Number(v);if(v<minP)minP=v;if(v>maxP)maxP=v;});
var pad=(maxP-minP)*0.06||1;minP-=pad;maxP+=pad;
var LEFT=130,RIGHT=20,TOP=30,BOTTOM=30;var PW=W-LEFT-RIGHT,PH=H-TOP-BOTTOM;
function X(i){return LEFT+i*PW/(count-1||1);}function Y(p){return TOP+(maxP-p)/(maxP-minP)*PH;}
ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;for(var g=0;g<=5;g++){var y=TOP+PH*g/5;ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();}
function drawLevel(price,color,label,dash,offsetY){if(price==null)return;var y=Y(price)+(offsetY||0);ctx.save();ctx.strokeStyle=color;ctx.lineWidth=2;if(dash)ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();ctx.restore();ctx.save();ctx.fillStyle=color;ctx.font='bold 12px Arial';ctx.textAlign='right';ctx.fillText(label+' '+fmt(price),LEFT-10,y+4);ctx.restore();}
drawLevel(s.tp2,'#8a5cff','TP2',[4,4],0);drawLevel(s.tp1,'#00ff9d','TP1',[4,4],0);drawLevel(s.entry,'#2962ff','GİRİŞ',[],0);drawLevel(s.stop,'#ff3860','STOP',[6,3],14);drawLevel(s.level,'#f6c453','SEVİYE',[2,2],-14);
var cw=Math.max(3,Math.min(16,PW/count*0.7));for(var c=0;c<candles.length;c++){var k=candles[c];var x=X(c);var o=Number(k.o),cl=Number(k.c),h=Number(k.h),l=Number(k.l);var bull=cl>=o;var color=bull?'#00ff9d':'#ff3860';ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(x,Y(h));ctx.lineTo(x,Y(l));ctx.stroke();var oY=Y(o),cY=Y(cl);ctx.fillRect(x-cw/2,Math.min(oY,cY),cw,Math.max(1,Math.abs(cY-oY)));}
if(s.currentPrice!=null){var cy=Y(s.currentPrice);ctx.save();ctx.strokeStyle='#f6c453';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(LEFT,cy);ctx.lineTo(W-RIGHT,cy);ctx.stroke();ctx.restore();}}
function switchTab(t){currentTab=t;document.querySelectorAll('.side-tab').forEach(function(el){if(el.getAttribute('data-tab')===t)el.classList.add('active');else el.classList.remove('active');});selectedId=null;renderList();renderMain();}
document.getElementById('tabSignals').onclick=function(){switchTab('signals');};
document.getElementById('tabEscaped').onclick=function(){switchTab('escaped');};
function apply(data){if(!data)return;var ns=Array.isArray(data.signals)?data.signals:[];var ac=ns.filter(function(s){return s.status==='ACTIVE'||s.status==='TP1_HIT';}).length;if(ac>lastActiveCount&&lastActiveCount>0)playSound();lastActiveCount=ac;signals=ns;escaped=Array.isArray(data.escaped)?data.escaped:[];
if(data.marketStatus)renderMarketBar(data.marketStatus);
if(!selectedId&&signals.length>0)selectedId=signals[0].id;
document.getElementById('cSignals').textContent=ac;
document.getElementById('cEscaped').textContent=escaped.length;
document.title=(ac>0?'('+ac+') ':'')+'SONER TRADE v6.1';
var ei=document.getElementById('emptyInfo');if(ei)ei.textContent='Aktif: '+ac+' / Kaçan: '+escaped.length;
renderList();renderMain();}
function fetchSignals(){fetch('/api/signals?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){apply(d);setConnStatus('online','Bağlı');}).catch(function(){setConnStatus('offline','Bağlantı Yok');});}
function connect(){if(reconnectTimer)clearTimeout(reconnectTimer);try{var proto=location.protocol==='https:'?'wss://':'ws://';ws=new WebSocket(proto+location.host);ws.onopen=function(){setConnStatus('online','Canlı');};ws.onmessage=function(ev){try{var m=JSON.parse(ev.data);if(m.type==='snapshot'||m.type==='update')apply(m.data);}catch(e){}};ws.onclose=function(){setConnStatus('offline','Yeniden Bağlanıyor');reconnectTimer=setTimeout(connect,3000);};ws.onerror=function(){setConnStatus('offline','Hata');};}catch(e){reconnectTimer=setTimeout(connect,3000);}}
window.addEventListener('resize',function(){if(selectedId)renderMain();});
setConnStatus('offline','Bağlanıyor...');
fetchSignals();
connect();
pollTimer=setInterval(fetchSignals,30000);
</script>
</body>
</html>`;

// ============================================================
// START
// ============================================================

async function start() {
    try {
        await exchange.loadMarkets();
        logInfo(`Bitget marketleri | ${Object.keys(exchange.markets).length} market`);
        await updateMarketStatus();
        await runPreScan();
        await runScan();
        setInterval(function(){ runScan(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function(){ updateLivePrices(); }, CONFIG.LIVE_UPDATE_MS);
        setInterval(function(){ updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function(){ runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        logInfo('SONER TRADE v6.1 — 5 kritik hata düzeltildi');
    } catch (err) {
        logError(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logInfo(`${signal} alindi; kapaniyor.`);
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
    logInfo(`SONER TRADE v6.1 PORT=${PORT}`);
    start();
});
