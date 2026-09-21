'use strict';

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const http = require('http');
const fs = require('fs');
const path = require('path');
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
// SONER TRADE v7.0 — 2H MOMENTUM + TREND LINES + ERKEN UYARI
// ============================================================

const CONFIG = {
    TIMEFRAME: '2h',
    TF_MS: 2 * 60 * 60 * 1000,
    HTF1: '4h',
    HTF2: '1d',
    CANDLE_LIMIT: 300,

    // Seviye tespiti
    LEVEL_LOOKBACK: 120,
    LEVEL_PIVOT_SPAN: 3,
    LEVEL_STRENGTH_MIN: 2,
    LEVEL_TOLERANCE: 0.004,

    // Trend Lines
    TREND_LINE_MIN_SLOPE_PCT: 0.05,
    TREND_LINE_MAX_SLOPE_PCT: 3.0,
    TREND_LINE_MIN_BARS: 3,

    // Momentum (patlama öncesi + patlama)
    VOLUME_SURGE_MULT: 3.0,       // Erken uyarı
    VOLUME_EXPLOSION_MULT: 6.0,   // Patlama
    BODY_SURGE_ATR: 1.0,          // Erken uyarı
    BODY_EXPLOSION_ATR: 2.5,      // Patlama
    MOMENTUM_LOOKBACK: 5,

    // Kırılım
    BREAKOUT_BUFFER_ATR: 0.3,
    MAX_EXTENSION_ATR: 1.5,

    // RSI
    RSI_OVERBOUGHT: 75,
    RSI_OVERSOLD: 25,
    ATR_PERIOD: 14,
    RSI_PERIOD: 14,

    // Trend
    EMA_FAST: 21,
    EMA_SLOW: 50,
    MIN_MARKET_SCORE: 2,

    // Stop / TP
    STOP_ATR_MULT: 1.0,
    STOP_CANDLE_BUFFER_ATR: 0.2,
    MAX_RISK_PCT: 6,
    TP1_RR: 1.5,
    TP2_RR: 3.5,
    TP1_CLOSE_FRACTION: 0.5,

    // Kalite
    MIN_QUALITY_SCORE: 60,

    // Sinyal
    SIGNAL_VALID_MS: 8 * 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 4 * 60 * 60 * 1000,
    MAX_SIGNAL_AGE_MS: 15 * 60 * 1000,

    // Cache
    TREND_CACHE_MS: 10 * 60 * 1000,
    MARKET_TREND_CACHE_MS: 5 * 60 * 1000,

    // Likidite
    MIN_24H_VOLUME_USDT: 3000000,
    MAX_TARGETS: 200,
    MAX_SIGNALS_PER_SCAN: 3,

    EXCLUDED_BASES: ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','WBTC','WETH','WSTETH','STETH'],

    SCAN_INTERVAL_MS: 60 * 1000,
    SCAN_CONCURRENCY: 3,
    PRESCAN_INTERVAL_MS: 15 * 60 * 1000,
    MARKET_STATUS_INTERVAL_MS: 60 * 1000,
    LIVE_INTERVAL_MS: 10 * 1000,
    WICK_CHECK_MS: 60 * 1000,
    SAVE_INTERVAL_MS: 20 * 1000,
    MAX_SIGNALS_KEPT: 100,
    MAX_ESCAPED_KEPT: 50,
    MAX_HISTORY_KEPT: 500
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 150,
    options: { defaultType: 'swap' }
});

let targets = [];
let signals = [];
let escapedSignals = [];
let history = [];
let marketStatus = { btc: null, eth: null, breadth: null, overall: 'UNKNOWN', score: 0, updatedAt: 0 };
let marketTrendCache = { btc: 'SIDEWAYS', eth: 'SIDEWAYS', at: 0 };
let scanRunning = false;
let liveRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;
let stateDirty = false;
const lastSignalTime = new Map();
const trendCache = new Map();

const APP_STATE = { scanStatus: { message: 'Sunucu baslatiliyor...', isScanning: false }, updatedAt: Date.now() };

const DEBUG = {
    scanned: 0, breakouts: 0, signals: 0, warnings: 0, long: 0, short: 0,
    rejectedTrend: 0, rejectedVolume: 0, rejectedBody: 0, rejectedExtension: 0,
    rejectedRSI: 0, rejectedMarket: 0, rejectedQuality: 0, rejectedCooldown: 0,
    rejectedStale: 0, rejectedRisk: 0, rejectedOpen: 0, errors: 0
};

function logInfo(...a) { console.log('[INFO]', ...a); }
function logError(...a) { console.error('[ERROR]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v, d = 8) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function isOpen(s) { return s.status === 'ACTIVE' || s.status === 'TP1_HIT' || s.status === 'WARNING'; }
function markDirty() { stateDirty = true; }

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

function emaTrend(closes, threshold = 0.001) {
    const f = ema(closes, CONFIG.EMA_FAST), s = ema(closes, CONFIG.EMA_SLOW);
    if (f && s) {
        if (f > s * (1 + threshold)) return 'BULLISH';
        if (f < s * (1 - threshold)) return 'BEARISH';
    }
    return 'SIDEWAYS';
}

// ============================================================
// KALICILIK
// ============================================================

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (Array.isArray(d.signals)) signals = d.signals;
        if (Array.isArray(d.escapedSignals)) escapedSignals = d.escapedSignals;
        if (Array.isArray(d.history)) history = d.history;
        if (Array.isArray(d.lastSignalTime)) {
            for (const [k, v] of d.lastSignalTime) lastSignalTime.set(k, v);
        }
        logInfo(`State yuklendi | ${signals.length} sinyal, ${history.length} gecmis`);
    } catch (err) { logError(`[loadState] ${err.message}`); }
}

function saveState(force) {
    if (!stateDirty && !force) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            signals, escapedSignals, history, lastSignalTime: Array.from(lastSignalTime.entries())
        }));
        fs.renameSync(tmp, STATE_FILE);
        stateDirty = false;
    } catch (err) { logError(`[saveState] ${err.message}`); }
}

// ============================================================
// TELEGRAM
// ============================================================

async function notify(text) {
    if (!TG_TOKEN || !TG_CHAT || typeof fetch !== 'function') return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
        });
    } catch (err) { logError(`[telegram] ${err.message}`); }
}

function fmtWarningMsg(s) {
    const icon = s.direction === 'LONG' ? '🟡' : '🟠';
    const emoji = s.momentumLevel === 'EXPLOSION' ? '🚀' : '⚠️';
    return `${emoji} ${icon} ${s.symbol.replace(':USDT', '')} ${s.direction} | ${s.momentumLevel}\n` +
        `KIRILIM YAKIN - MANUEL KONTROL ET!\n` +
        `Fiyat: ${s.currentPrice}\n` +
        `Seviye: ${s.level} (${s.levelStrength}x)\n` +
        `Hacim: ${s.volumeRatio}x | Gövde: ${s.bodyRatio} ATR\n` +
        `Trend: 4h ${s.trend4h} | 1d ${s.trend1d}\n` +
        `RSI: ${s.rsi}`;
}

function fmtSignalMsg(s) {
    const icon = s.direction === 'LONG' ? '🟢' : '🔴';
    return `${icon} ${s.symbol.replace(':USDT', '')} ${s.direction} | Q${s.qualityScore}\n` +
        `Giris: ${s.entry}\nStop: ${s.stop}\nTP1: ${s.tp1} | TP2: ${s.tp2}\n` +
        `Seviye: ${s.level} (${s.levelStrength}x) | Hacim ${s.volumeRatio}x | RSI ${s.rsi}`;
}

// ============================================================
// TREND (4h + 1d)
// ============================================================

async function getTrends(symbol) {
    const c = trendCache.get(symbol);
    if (c && Date.now() - c.at < CONFIG.TREND_CACHE_MS) return c;
    try {
        const raw4h = await exchange.fetchOHLCV(symbol, CONFIG.HTF1, undefined, 100);
        const trend4h = emaTrend(closedCandles(raw4h).map(x => Number(x[4])));
        const raw1d = await exchange.fetchOHLCV(symbol, CONFIG.HTF2, undefined, 100);
        const trend1d = emaTrend(closedCandles(raw1d).map(x => Number(x[4])));
        const r = { trend4h, trend1d, at: Date.now() };
        trendCache.set(symbol, r);
        return r;
    } catch {
        return { trend4h: 'SIDEWAYS', trend1d: 'SIDEWAYS', at: 0 };
    }
}

// ============================================================
// MARKET STATUS — BREADTH
// ============================================================

async function ema200Trend(symbol) {
    const raw = await exchange.fetchOHLCV(symbol, '1h', undefined, 250);
    const closes = closedCandles(raw).map(c => Number(c[4]));
    const e200 = ema(closes, 200), last = closes[closes.length - 1];
    if (e200 && last > e200 * 1.002) return 'BULLISH';
    if (e200 && last < e200 * 0.998) return 'BEARISH';
    return 'SIDEWAYS';
}

async function updateMarketStatus() {
    try {
        if (Date.now() - marketTrendCache.at > CONFIG.MARKET_TREND_CACHE_MS) {
            const btc = await ema200Trend('BTC/USDT:USDT');
            const eth = await ema200Trend('ETH/USDT:USDT');
            marketTrendCache = { btc, eth, at: Date.now() };
        }
        const btcTrend = marketTrendCache.btc, ethTrend = marketTrendCache.eth;
        const tickers = await exchange.fetchTickers();
        let up = 0, down = 0, total = 0;
        for (const [symbol, t] of Object.entries(tickers)) {
            if (!symbol.endsWith('/USDT:USDT')) continue;
            const base = symbol.split('/')[0].toUpperCase();
            if (CONFIG.EXCLUDED_BASES.includes(base)) continue;
            const chg = Number(t.percentage);
            if (!Number.isFinite(chg)) continue;
            total++;
            if (chg > 1) up++;
            else if (chg < -1) down++;
        }
        const upRatio = total > 0 ? up / total : 0.5;
        const downRatio = total > 0 ? down / total : 0.5;

        let breadthTrend = 'SIDEWAYS';
        if (upRatio > 0.6) breadthTrend = 'BULLISH';
        else if (downRatio > 0.6) breadthTrend = 'BEARISH';

        const btcT = tickers['BTC/USDT:USDT'], ethT = tickers['ETH/USDT:USDT'];
        const btcChg = btcT ? Number(btcT.percentage) : 0;
        const ethChg = ethT ? Number(ethT.percentage) : 0;

        let score = 0;
        if (breadthTrend === 'BULLISH') score += 6;
        else if (breadthTrend === 'BEARISH') score -= 6;
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
            breadth: {
                trend: breadthTrend,
                up, down, total,
                upRatio: num(upRatio * 100, 1),
                downRatio: num(downRatio * 100, 1)
            },
            overall, score, updatedAt: Date.now()
        };
        broadcast();
    } catch (err) { logError(`[marketStatus] ${err.message}`); }
}

// ============================================================
// SEVİYE TESPİTİ (YATAY + EĞİMLİ)
// ============================================================

function findLevels(candles) {
    const slice = candles.slice(-CONFIG.LEVEL_LOOKBACK);
    const span = CONFIG.LEVEL_PIVOT_SPAN;
    const highs = [], lows = [];

    for (let i = span; i < slice.length - span; i++) {
        const h = Number(slice[i][2]), l = Number(slice[i][3]);
        let isHigh = true, isLow = true;
        for (let k = 1; k <= span; k++) {
            if (!(h > Number(slice[i - k][2]) && h > Number(slice[i + k][2]))) isHigh = false;
            if (!(l < Number(slice[i - k][3]) && l < Number(slice[i + k][3]))) isLow = false;
        }
        if (isHigh) highs.push({ price: h, index: i });
        if (isLow) lows.push({ price: l, index: i });
    }

    function cluster(points) {
        if (!points.length) return [];
        const sorted = [...points].sort((a, b) => a.price - b.price);
        const clusters = [];
        let group = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            if ((sorted[i].price - group[group.length - 1].price) / group[group.length - 1].price < CONFIG.LEVEL_TOLERANCE * 2) {
                group.push(sorted[i]);
            } else {
                clusters.push({
                    price: group.reduce((a, b) => a + b.price, 0) / group.length,
                    count: group.length,
                    lastIndex: group[group.length - 1].index
                });
                group = [sorted[i]];
            }
        }
        clusters.push({
            price: group.reduce((a, b) => a + b.price, 0) / group.length,
            count: group.length,
            lastIndex: group[group.length - 1].index
        });
        return clusters;
    }

    const resistancePts = highs;
    const supportPts = lows;

    // Yatay seviyeler
    const resistances = cluster(resistancePts).filter(c => c.count >= CONFIG.LEVEL_STRENGTH_MIN).sort((a, b) => a.price - b.price);
    const supports = cluster(supportPts).filter(c => c.count >= CONFIG.LEVEL_STRENGTH_MIN).sort((a, b) => b.price - a.price);

    // Eğimli trend çizgileri
    const trendRes = buildTrendLine(resistancePts.slice(-3), candles.length - 1, 'high');
    const trendSup = buildTrendLine(supportPts.slice(-3), candles.length - 1, 'low');

    return { resistances, supports, trendRes, trendSup };
}

function buildTrendLine(pivots, currentIndex, type) {
    if (!pivots || pivots.length < CONFIG.TREND_LINE_MIN_BARS) return null;

    const sorted = [...pivots].sort((a, b) => a.index - b.index);
    const p1 = sorted[0], p2 = sorted[sorted.length - 1];
    if (p2.index === p1.index) return null;

    const slope = (p2.price - p1.price) / (p2.index - p1.index);
    const price = p2.price + slope * (currentIndex - p2.index);

    // Eğim filtresi
    const slopePct = Math.abs(slope / p1.price * 100);
    if (slopePct < CONFIG.TREND_LINE_MIN_SLOPE_PCT || slopePct > CONFIG.TREND_LINE_MAX_SLOPE_PCT) return null;

    return { price, slope, p1, p2, type };
}

// ============================================================
// MOMENTUM KONTROLÜ
// ============================================================

function checkMomentum(candles, atrVal) {
    const recent = candles.slice(-CONFIG.MOMENTUM_LOOKBACK);
    let maxBodyRatio = 0, maxVolumeRatio = 0, lastBodyRatio = 0, lastVolumeRatio = 0;

    const priorCandles = candles.slice(0, -CONFIG.MOMENTUM_LOOKBACK);
    const avgVol = sma(priorCandles.map(c => Number(c[5])), Math.min(30, priorCandles.length)) || 1;

    for (let i = 0; i < recent.length; i++) {
        const c = recent[i];
        const body = Math.abs(Number(c[4]) - Number(c[1])) / atrVal;
        const vol = Number(c[5]) / avgVol;
        if (body > maxBodyRatio) maxBodyRatio = body;
        if (vol > maxVolumeRatio) maxVolumeRatio = vol;
        if (i === recent.length - 1) {
            lastBodyRatio = body;
            lastVolumeRatio = vol;
        }
    }

    let level = 'NONE';
    if (lastVolumeRatio >= CONFIG.VOLUME_EXPLOSION_MULT && lastBodyRatio >= CONFIG.BODY_EXPLOSION_ATR) {
        level = 'EXPLOSION';
    } else if (lastVolumeRatio >= CONFIG.VOLUME_SURGE_MULT || lastBodyRatio >= CONFIG.BODY_SURGE_ATR) {
        level = 'SURGE';
    }

    return { level, maxBodyRatio: num(maxBodyRatio, 2), maxVolumeRatio: num(maxVolumeRatio, 2), lastBodyRatio: num(lastBodyRatio, 2), lastVolumeRatio: num(lastVolumeRatio, 2) };
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQuality(p) {
    let score = 0;
    const b = [];
    const long = p.direction === 'LONG';
    const want = long ? 'BULLISH' : 'BEARISH';

    if (p.trend1d === want) { score += 20; b.push('✅ 1d trend uyumlu (+20)'); } else b.push('❌ 1d trend uyumsuz');
    if (p.trend4h === want) { score += 15; b.push('✅ 4h trend uyumlu (+15)'); } else b.push('❌ 4h trend uyumsuz');

    if (p.momentumLevel === 'EXPLOSION') { score += 15; b.push('🚀 Momentum PATLAMA (+15)'); }
    else if (p.momentumLevel === 'SURGE') { score += 10; b.push('⚠️ Momentum artıyor (+10)'); }

    if (p.volumeRatio >= 5.0) { score += 15; b.push(`✅ Çok güçlü hacim ${num(p.volumeRatio, 1)}x (+15)`); }
    else if (p.volumeRatio >= 3.0) { score += 10; b.push(`✅ Güçlü hacim ${num(p.volumeRatio, 1)}x (+10)`); }
    else b.push('❌ Düşük hacim');

    if (p.bodyRatio >= 2.0) { score += 10; b.push(`✅ Çok güçlü mum ${num(p.bodyRatio, 2)}x (+10)`); }
    else if (p.bodyRatio >= 1.0) { score += 5; b.push(`✅ Güçlü mum ${num(p.bodyRatio, 2)}x (+5)`); }
    else b.push('❌ Zayıf mum');

    if (p.levelStrength >= 4) { score += 10; b.push(`✅ Çok güçlü seviye ${p.levelStrength}x (+10)`); }
    else if (p.levelStrength >= 2) { score += 5; b.push(`🟡 Normal seviye ${p.levelStrength}x (+5)`); }
    else { score += 2; b.push(`🟡 Zayıf seviye (+2)`); }

    if (p.isTrendLine) { score += 5; b.push('📈 Eğimli trend kırılımı (+5)'); }

    if (p.rsiValue != null) {
        const r = p.rsiValue;
        if (long) {
            if (r >= 50 && r <= 70) { score += 10; b.push(`✅ RSI ideal ${num(r, 0)} (+10)`); }
            else if (r >= 40 && r < 50) { score += 5; b.push(`🟡 RSI kabul ${num(r, 0)} (+5)`); }
            else b.push('❌ RSI uygun değil');
        } else {
            if (r >= 30 && r <= 50) { score += 10; b.push(`✅ RSI ideal ${num(r, 0)} (+10)`); }
            else if (r > 50 && r <= 60) { score += 5; b.push(`🟡 RSI kabul ${num(r, 0)} (+5)`); }
            else b.push('❌ RSI uygun değil');
        }
    }

    if (p.extensionATR <= 0.5) { score += 10; b.push(`✅ Girişe yakın (${num(p.extensionATR, 2)} ATR) (+10)`); }
    else if (p.extensionATR <= 1.0) { score += 5; b.push(`🟡 Biraz uzamış (${num(p.extensionATR, 2)} ATR) (+5)`); }

    const aligned = long ? p.marketScore : -p.marketScore;
    if (aligned >= 5) { score += 5; b.push('✅ Piyasa güçlü uyumlu (+5)'); }

    return { score: Math.min(score, 100), breakdown: b };
}

// ============================================================
// ERKEN UYARI (Kırılım yaklaşıyor)
// ============================================================

async function checkWarning(symbol) {
    try {
        if (isExcluded(symbol)) return null;
        if (signals.some(s => s.symbol === symbol && isOpen(s))) return null;

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.LEVEL_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const close = Number(last[4]), open = Number(last[1]);
        const high = Number(last[2]), low = Number(last[3]);
        const volume = Number(last[5]);
        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const closes = candles.map(c => Number(c[4]));

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const volumes = priorCandles.slice(-30).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(30, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const bodyRatio = Math.abs(close - open) / currentATR;
        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);

        // Sadece hacim patlaması varsa uyarı ver
        if (volumeRatio < CONFIG.VOLUME_SURGE_MULT) return null;

        const levels = findLevels(priorCandles);
        const buf = currentATR * CONFIG.BREAKOUT_BUFFER_ATR;

        // Yaklaşan kırılım tespiti (kırılmadı ama yaklaşıyor)
        let direction = null, level = null, levelStrength = 0, isTrendLine = false;

        for (const res of levels.resistances.slice(0, 3)) {
            const dist = (res.price - close) / currentATR;
            if (dist > 0 && dist < 0.8) {
                direction = 'LONG';
                level = res.price;
                levelStrength = res.count;
                break;
            }
        }
        if (!direction) {
            for (const sup of levels.supports.slice(0, 3)) {
                const dist = (close - sup.price) / currentATR;
                if (dist > 0 && dist < 0.8) {
                    direction = 'SHORT';
                    level = sup.price;
                    levelStrength = sup.count;
                    break;
                }
            }
        }
        if (!direction) return null;

        const trends = await getTrends(symbol);
        const trendOk = direction === 'LONG'
            ? (trends.trend4h !== 'BEARISH' && trends.trend1d !== 'BEARISH')
            : (trends.trend4h !== 'BULLISH' && trends.trend1d !== 'BULLISH');
        if (!trendOk) return null;

        const momentum = checkMomentum(candles, currentATR);

        if (momentum.level === 'NONE') return null;

        logInfo(`⚠️ UYARI ${direction} | ${symbol} | Seviye ${num(level)} (${levelStrength}x) | Hacim ${num(volumeRatio, 1)}x | Gövde ${num(bodyRatio, 2)}x | ${momentum.level}`);

        const now = Date.now();
        const warning = {
            id: `WARN_${symbol.replace(/[^A-Z0-9]/gi, '')}_${now}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            signalType: 'UYARI',
            timeframe: CONFIG.TIMEFRAME,
            status: 'WARNING',
            momentumLevel: momentum.level,
            entry: num(close),
            currentPrice: num(close),
            pnlPct: 0,
            stop: null,
            initialStop: null,
            tp1: null,
            tp2: null,
            level: num(level),
            levelStrength,
            volumeRatio: num(volumeRatio, 2),
            bodyRatio: num(bodyRatio, 2),
            rsi: num(rsiValue, 1),
            atr: num(currentATR),
            distanceATR: num(((direction === 'LONG' ? level - close : close - level) / currentATR), 2),
            extensionATR: num(Math.abs(close - level) / currentATR, 2),
            trend4h: trends.trend4h,
            trend1d: trends.trend1d,
            qualityScore: 0,
            qualityBreakdown: [],
            isTrendLine: false,
            candles: candles.slice(-60).map(c => ({ t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]) })),
            timestamp: now,
            updatedAt: now,
            expiresAt: now + CONFIG.SIGNAL_VALID_MS
        };

        return warning;
    } catch (err) {
        return null;
    }
}

// ============================================================
// ANA TARAMA
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (Math.abs(marketStatus.score) < CONFIG.MIN_MARKET_SCORE) { DEBUG.rejectedMarket++; return null; }
        if (isExcluded(symbol)) return null;
        if (signals.some(s => s.symbol === symbol && isOpen(s))) { DEBUG.rejectedOpen++; return null; }

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.LEVEL_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const closeTime = Number(last[0]) + CONFIG.TF_MS;
        if (Date.now() - closeTime > CONFIG.MAX_SIGNAL_AGE_MS) { DEBUG.rejectedStale++; return null; }

        const open = Number(last[1]), high = Number(last[2]), low = Number(last[3]), close = Number(last[4]);
        const volume = Number(last[5]);
        if (![close, open, high, low, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const prevClose = Number(priorCandles[priorCandles.length - 1][4]);
        const closes = candles.map(c => Number(c[4]));

        const volumes = priorCandles.slice(-30).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(30, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const bodyRatio = Math.abs(close - open) / currentATR;
        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);

        const levels = findLevels(priorCandles);
        const buf = currentATR * CONFIG.BREAKOUT_BUFFER_ATR;

        // Yatay kırılım
        const res = levels.resistances
            .filter(r => prevClose <= r.price && close > r.price + buf)
            .sort((a, b) => b.price - a.price)[0];
        const sup = levels.supports
            .filter(s => prevClose >= s.price && close < s.price - buf)
            .sort((a, b) => a.price - b.price)[0];

        // Eğimli trend kırılım
        const trendResBreak = levels.trendRes && prevClose <= levels.trendRes.price && close > levels.trendRes.price + buf;
        const trendSupBreak = levels.trendSup && prevClose >= levels.trendSup.price && close < levels.trendSup.price - buf;

        let direction = null, lvl = null, isTrendLine = false;

        if (res && (!sup || close >= open)) { direction = 'LONG'; lvl = res; }
        else if (sup) { direction = 'SHORT'; lvl = sup; }
        else if (trendResBreak && (!trendSupBreak || close >= open)) {
            direction = 'LONG'; lvl = { price: levels.trendRes.price, count: 1 }; isTrendLine = true;
        }
        else if (trendSupBreak) {
            direction = 'SHORT'; lvl = { price: levels.trendSup.price, count: 1 }; isTrendLine = true;
        }

        if (!direction) return null;
        if (direction === 'LONG' && close <= open) return null;
        if (direction === 'SHORT' && close >= open) return null;

        const level = lvl.price, levelStrength = lvl.count;
        DEBUG.breakouts++;

        if ((direction === 'LONG' && marketStatus.score < CONFIG.MIN_MARKET_SCORE) ||
            (direction === 'SHORT' && marketStatus.score > -CONFIG.MIN_MARKET_SCORE)) {
            DEBUG.rejectedMarket++; return null;
        }

        if (volumeRatio < CONFIG.VOLUME_SURGE_MULT) { DEBUG.rejectedVolume++; return null; }
        if (bodyRatio < CONFIG.BODY_SURGE_ATR) { DEBUG.rejectedBody++; return null; }

        if (rsiValue != null) {
            if (direction === 'LONG' && rsiValue > CONFIG.RSI_OVERBOUGHT) { DEBUG.rejectedRSI++; return null; }
            if (direction === 'SHORT' && rsiValue < CONFIG.RSI_OVERSOLD) { DEBUG.rejectedRSI++; return null; }
        }

        const extClose = Math.abs(close - level) / currentATR;
        if (extClose > CONFIG.MAX_EXTENSION_ATR) { DEBUG.rejectedExtension++; return null; }

        const key = `${symbol}_${direction}`;
        if (Date.now() - (lastSignalTime.get(key) || 0) < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejectedCooldown++; return null; }

        const trends = await getTrends(symbol);
        const trendOk =
            (direction === 'LONG' && trends.trend4h === 'BULLISH' && trends.trend1d === 'BULLISH') ||
            (direction === 'SHORT' && trends.trend4h === 'BEARISH' && trends.trend1d === 'BEARISH');
        if (!trendOk) { DEBUG.rejectedTrend++; return null; }

        let entry = close;
        try {
            const t = await exchange.fetchTicker(symbol);
            const p = Number(t && t.last);
            if (Number.isFinite(p) && p > 0) entry = p;
        } catch {}

        const extNow = (direction === 'LONG' ? entry - level : level - entry) / currentATR;
        if (extNow < 0 || extNow > CONFIG.MAX_EXTENSION_ATR) { DEBUG.rejectedExtension++; return null; }

        let stop, risk;
        if (direction === 'LONG') {
            stop = Math.min(level - CONFIG.STOP_ATR_MULT * currentATR, low - CONFIG.STOP_CANDLE_BUFFER_ATR * currentATR);
            risk = entry - stop;
        } else {
            stop = Math.max(level + CONFIG.STOP_ATR_MULT * currentATR, high + CONFIG.STOP_CANDLE_BUFFER_ATR * currentATR);
            risk = stop - entry;
        }
        if (!(risk > 0)) return null;
        if (risk / entry * 100 > CONFIG.MAX_RISK_PCT) { DEBUG.rejectedRisk++; return null; }

        const tp1 = direction === 'LONG' ? entry + risk * CONFIG.TP1_RR : entry - risk * CONFIG.TP1_RR;
        const tp2 = direction === 'LONG' ? entry + risk * CONFIG.TP2_RR : entry - risk * CONFIG.TP2_RR;

        const momentum = checkMomentum(candles, currentATR);

        const quality = calculateQuality({
            direction, trend4h: trends.trend4h, trend1d: trends.trend1d,
            volumeRatio, rsiValue, bodyRatio, levelStrength,
            extensionATR: extNow, isTrendLine,
            momentumLevel: momentum.level,
            marketScore: marketStatus.score
        });
        if (quality.score < CONFIG.MIN_QUALITY_SCORE) { DEBUG.rejectedQuality++; return null; }

        lastSignalTime.set(key, Date.now());
        DEBUG.signals++;
        if (direction === 'LONG') DEBUG.long++; else DEBUG.short++;

        logInfo(`🎯 KIRILIM ${direction} | ${symbol} | Seviye ${num(level)} (${levelStrength}x) | Q${quality.score} | Hacim ${num(volumeRatio, 1)}x | Gövde ${num(bodyRatio, 2)}x | ${momentum.level}${isTrendLine ? ' | TREND' : ''}`);

        const now = Date.now();
        return {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${now}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            signalType: isTrendLine ? 'TREND_KIRILIM' : (direction === 'LONG' ? 'DIRENC_KIRILIM' : 'DESTEK_KIRILIM'),
            timeframe: CONFIG.TIMEFRAME,
            status: 'ACTIVE',
            momentumLevel: momentum.level,
            isTrendLine,
            entry: num(entry),
            currentPrice: num(entry),
            pnlPct: 0,
            stop: num(stop),
            initialStop: num(stop),
            tp1: num(tp1),
            tp2: num(tp2),
            tp1Hit: false,
            resultR: null,
            level: num(level),
            levelStrength,
            volumeRatio: num(volumeRatio, 2),
            bodyRatio: num(bodyRatio, 2),
            rsi: num(rsiValue, 1),
            atr: num(currentATR),
            extensionATR: num(extNow, 2),
            distanceATR: num(extNow, 2),
            trend4h: trends.trend4h,
            trend1d: trends.trend1d,
            qualityScore: quality.score,
            qualityBreakdown: quality.breakdown,
            candles: candles.slice(-60).map(c => ({ t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]) })),
            timestamp: now,
            updatedAt: now,
            wickCheckedAt: now,
            expiresAt: now + CONFIG.SIGNAL_VALID_MS
        };
    } catch (err) {
        DEBUG.errors++;
        return null;
    }
}

// ============================================================
// SİNYAL TAKİBİ
// ============================================================

function currentR(sig, price) {
    const risk = Math.abs(Number(sig.entry) - Number(sig.initialStop));
    if (!risk) return 0;
    return (sig.direction === 'LONG' ? price - Number(sig.entry) : Number(sig.entry) - price) / risk;
}

function finalizeSignal(sig, status, reason, now, price) {
    const f = CONFIG.TP1_CLOSE_FRACTION;
    let r;
    if (status === 'TP2_HIT') r = f * CONFIG.TP1_RR + (1 - f) * CONFIG.TP2_RR;
    else if (status === 'BE_STOP') r = f * CONFIG.TP1_RR;
    else if (status === 'FAKEOUT') r = -1;
    else {
        const cr = currentR(sig, price);
        r = sig.tp1Hit ? f * CONFIG.TP1_RR + (1 - f) * cr : cr;
    }
    sig.resultR = num(r, 2);
    sig.status = status;
    sig.closeReason = reason;
    sig.closedAt = now;
    sig.updatedAt = now;

    history.unshift({
        id: sig.id, symbol: sig.symbol, direction: sig.direction, status, resultR: sig.resultR,
        entry: sig.entry, stop: sig.initialStop, tp1: sig.tp1, tp2: sig.tp2, level: sig.level,
        levelStrength: sig.levelStrength, qualityScore: sig.qualityScore, volumeRatio: sig.volumeRatio,
        bodyRatio: sig.bodyRatio, rsi: sig.rsi, extensionATR: sig.extensionATR,
        openedAt: sig.timestamp, closedAt: now
    });
    history = history.slice(0, CONFIG.MAX_HISTORY_KEPT);

    if (status === 'FAKEOUT') {
        signals = signals.filter(s => s !== sig);
        escapedSignals.unshift(sig);
        escapedSignals = escapedSignals.slice(0, CONFIG.MAX_ESCAPED_KEPT);
    }

    const nm = sig.symbol.replace(':USDT', '');
    const rTxt = sig.resultR >= 0 ? `+${sig.resultR}R` : `${sig.resultR}R`;
    notify(`${status === 'TP2_HIT' ? '🎉' : status === 'FAKEOUT' ? '✗' : 'ℹ️'} ${nm} ${sig.direction} kapandı: ${reason} (${rTxt})`);
    markDirty();
}

function applyPriceWindow(sig, high, low, price, now) {
    if (!isOpen(sig)) return false;
    if (sig.status === 'WARNING') return false;
    const L = sig.direction === 'LONG';
    const stop = Number(sig.stop), tp1 = Number(sig.tp1), tp2 = Number(sig.tp2);

    const hitStop = L ? low <= stop : high >= stop;
    if (hitStop) {
        if (sig.tp1Hit) finalizeSignal(sig, 'BE_STOP', 'Giriş stopu (TP1 sonrası)', now, price);
        else finalizeSignal(sig, 'FAKEOUT', 'Sahte kırılım — stop', now, price);
        return true;
    }

    let changed = false;
    const hitTp1 = L ? high >= tp1 : low <= tp1;
    const hitTp2 = L ? high >= tp2 : low <= tp2;

    if (!sig.tp1Hit && hitTp1) {
        sig.tp1Hit = true;
        sig.status = 'TP1_HIT';
        sig.stop = sig.entry;
        sig.tp1At = now;
        sig.updatedAt = now;
        changed = true;
        notify(`💰 ${sig.symbol.replace(':USDT', '')} ${sig.direction} TP1 vurdu — yarısını sat, stop girişe çekildi`);
        markDirty();
    }
    if (sig.tp1Hit && hitTp2) {
        finalizeSignal(sig, 'TP2_HIT', 'TP2', now, price);
        return true;
    }
    return changed;
}

async function updateLivePrices() {
    if (liveRunning) return;
    const open = signals.filter(isOpen);
    if (!open.length) return;
    liveRunning = true;
    let changed = false;
    try {
        const now = Date.now();
        const symbols = Array.from(new Set(open.map(s => s.symbol)));
        const tickers = await exchange.fetchTickers(symbols);

        for (const sig of open) {
            const t = tickers[sig.symbol];
            const price = t ? Number(t.last) : NaN;
            if (Number.isFinite(price) && price > 0) {
                const entry = Number(sig.entry);
                sig.currentPrice = num(price);
                if (sig.status !== 'WARNING') {
                    sig.pnlPct = num(((sig.direction === 'LONG' ? price - entry : entry - price) / entry) * 100, 2);
                }
                sig.updatedAt = now;
                if (applyPriceWindow(sig, price, price, price, now)) changed = true;
                changed = true;
            }

            if (sig.status !== 'WARNING' && isOpen(sig) && now - (sig.wickCheckedAt || sig.timestamp) >= CONFIG.WICK_CHECK_MS) {
                try {
                    const since = (sig.wickCheckedAt || sig.timestamp) - 60 * 1000;
                    const raw = await exchange.fetchOHLCV(sig.symbol, '1m', since, 60);
                    for (const c of raw || []) {
                        if (!isOpen(sig)) break;
                        if (Number(c[0]) < sig.timestamp) continue;
                        if (applyPriceWindow(sig, Number(c[2]), Number(c[3]), Number(c[4]), now)) changed = true;
                    }
                    sig.wickCheckedAt = now;
                } catch {}
            }

            if (isOpen(sig) && now > sig.expiresAt) {
                if (sig.status === 'WARNING') {
                    signals = signals.filter(s => s !== sig);
                    changed = true;
                } else {
                    finalizeSignal(sig, 'EXPIRED', 'Süre doldu', now, Number(sig.currentPrice) || Number(sig.entry));
                    changed = true;
                }
            }
        }
        if (changed) { markDirty(); broadcast(); }
    } catch (err) {
    } finally {
        liveRunning = false;
    }
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
    if (scanRunning || isShuttingDown) return;

    const sinceClose = Date.now() % CONFIG.TF_MS;
    if (sinceClose > CONFIG.MAX_SIGNAL_AGE_MS) {
        const minsLeft = Math.ceil((CONFIG.TF_MS - sinceClose) / 60000);
        const msg = `Mum kapanışı bekleniyor (~${minsLeft} dk)`;
        if (APP_STATE.scanStatus.message !== msg) {
            APP_STATE.scanStatus = { message: msg, isScanning: false };
            broadcast();
        }
        return;
    }

    scanRunning = true;
    for (const k of Object.keys(DEBUG)) if (k !== 'errors') DEBUG[k] = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;
    let newWarnings = 0;
    let idx = 0;

    async function worker() {
        while (!isShuttingDown) {
            if (newSignals >= CONFIG.MAX_SIGNALS_PER_SCAN) return;
            const i = idx++;
            if (i >= targets.length) return;
            const symbol = targets[i];

            // Önce kesin sinyal kontrol
            const signal = await scanForSignal(symbol);
            if (signal && newSignals < CONFIG.MAX_SIGNALS_PER_SCAN) {
                signals.unshift(signal);
                signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                newSignals++;
                markDirty();
                notify(fmtSignalMsg(signal));
                broadcast();
                continue;
            }

            // Sonra uyarı kontrol (erken haber)
            if (newWarnings < 5) {
                const warning = await checkWarning(symbol);
                if (warning) {
                    const exists = signals.some(s => s.symbol === warning.symbol && s.status === 'WARNING');
                    if (!exists) {
                        signals.unshift(warning);
                        signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                        newWarnings++;
                        DEBUG.warnings++;
                        markDirty();
                        notify(fmtWarningMsg(warning));
                        broadcast();
                    }
                }
            }
        }
    }

    try {
        await Promise.all(Array.from({ length: CONFIG.SCAN_CONCURRENCY }, worker));
        lastScanAt = Date.now();
    } catch (err) { logError(`[runScan] ${err.message}`); }

    scanRunning = false;
    APP_STATE.scanStatus = { message: `Tarama bitti | ${newSignals} sinyal, ${newWarnings} uyarı`, isScanning: false };
    broadcast();
    logInfo(`[TARAMA] Tarandı=${DEBUG.scanned} | Kırılım=${DEBUG.breakouts} | Sinyal=${newSignals} | Uyarı=${newWarnings} | Piyasa=${DEBUG.rejectedMarket} | Hacim=${DEBUG.rejectedVolume} | Mum=${DEBUG.rejectedBody} | RSI=${DEBUG.rejectedRSI} | Uzama=${DEBUG.rejectedExtension} | Trend=${DEBUG.rejectedTrend} | Risk=${DEBUG.rejectedRisk} | Kalite=${DEBUG.rejectedQuality} | Cooldown=${DEBUG.rejectedCooldown} | Hata=${DEBUG.errors}`);
}

// ============================================================
// API + WS
// ============================================================

function perfStats() {
    const closed = history.length;
    const wins = history.filter(x => Number(x.resultR) > 0).length;
    const totalR = history.reduce((a, x) => a + (Number(x.resultR) || 0), 0);
    return {
        closed, wins, losses: closed - wins,
        winRate: closed ? num(wins / closed * 100, 1) : null,
        totalR: num(totalR, 2)
    };
}

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    const active = signals.filter(s => s.status === 'ACTIVE' || s.status === 'TP1_HIT');
    const warnings = signals.filter(s => s.status === 'WARNING');
    return {
        success: true,
        signals: signals.slice(0, 100),
        escaped: escapedSignals.slice(0, 50),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        perf: perfStats(),
        stats: {
            total: signals.length,
            active: active.length,
            warnings: warnings.length,
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

function requireAdmin(req, res, next) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return res.status(403).json({ success: false, error: 'ADMIN_TOKEN tanimli degil' });
    const given = req.get('x-admin-token') || req.query.token;
    if (given !== token) return res.status(401).json({ success: false, error: 'yetkisiz' });
    next();
}

app.get('/api/signals', (req, res) => res.json(snapshot()));
app.get('/api/market-status', (req, res) => res.json({ success: true, marketStatus }));
app.get('/api/stats', (req, res) => res.json({ success: true, perf: perfStats() }));
app.get('/api/history', (req, res) => res.json({ success: true, history }));
app.get('/api/health', (req, res) => res.json({
    ok: true, targets: targets.length, signals: signals.length,
    lastScanAt, lastPrescanAt, marketUpdatedAt: marketStatus.updatedAt
}));
app.delete('/api/signals', requireAdmin, (req, res) => { signals = []; markDirty(); broadcast(); res.json({ success: true }); });
app.delete('/api/escaped', requireAdmin, (req, res) => { escapedSignals = []; markDirty(); broadcast(); res.json({ success: true }); });

// ============================================================
// FRONTEND
// ============================================================

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONER TRADE v7.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.market-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#0d1219;border-bottom:1px solid #1c2634;flex-shrink:0;gap:12px;flex-wrap:wrap}
.market-brand{font-size:14px;font-weight:900}
.market-brand span{color:#17d7a0}
.market-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:#2a2410;color:#f6c453;margin-left:6px}
.market-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0e14;border-radius:5px;font-size:11px}
.market-item .sym{font-weight:700;color:#8b97a5}
.market-item .price{font-weight:700}
.market-item .chg{padding:1px 5px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,157,0.15);color:#00ff9d}
.market-item .chg.down{background:rgba(255,56,96,0.15);color:#ff3860}
.breadth-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0e14;border-radius:5px;font-size:11px;border:1px solid #1c2634}
.breadth-item.bull{border-color:rgba(0,255,157,0.4)}
.breadth-item.bear{border-color:rgba(255,56,96,0.4)}
.market-overall{padding:6px 14px;border-radius:5px;font-size:11px;font-weight:800}
.market-overall.bullish{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.3)}
.market-overall.bearish{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.3)}
.market-overall.mixed{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.3)}
.conn-status{padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;background:#1c2634;color:#8b97a5}
.conn-status.online{background:rgba(0,255,157,0.15);color:#00ff9d}
.conn-status.offline{background:rgba(255,56,96,0.15);color:#ff3860}
.content{display:flex;flex:1;overflow:hidden}
.sidebar{width:420px;background:#0d1219;border-right:1px solid #1c2634;display:flex;flex-direction:column;flex-shrink:0}
.side-tabs{display:flex;background:#0a0e14;border-bottom:1px solid #1c2634}
.side-tab{flex:1;padding:12px 4px;text-align:center;cursor:pointer;font-size:10px;font-weight:800;text-transform:uppercase;color:#5e6b7c;border-bottom:2px solid transparent;background:transparent;border:none;font-family:inherit}
.side-tab.active{color:#00ff9d;border-bottom-color:#00ff9d}
.side-tab .count{display:inline-block;font-size:9px;padding:1px 5px;border-radius:10px;background:#1c2634;color:#c5cfdd;margin-left:3px}
.side-tab.active .count{background:#00ff9d;color:#0a0e14}
.side-list{flex:1;overflow-y:auto;padding:8px}
.side-list::-webkit-scrollbar{width:6px}
.side-list::-webkit-scrollbar-thumb{background:#2c3a4f;border-radius:3px}
.sig-card{margin-bottom:10px;padding:12px;border-radius:10px;cursor:pointer;background:#0f1620;border:1px solid #1c2634;transition:all .15s}
.sig-card:hover{background:#141d28}
.sig-card.selected{background:#141d28;border-color:#17d7a0;box-shadow:0 0 0 2px rgba(23,215,160,0.4)}
.sig-card.long{border-left:4px solid #00ff9d}
.sig-card.short{border-left:4px solid #ff3860}
.sig-card.warning{border-left:4px solid #f6c453;background:#1a1608}
.sig-card.explosion{border-left:4px solid #ff3860;background:#1a0808;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,56,96,0.5)}50%{box-shadow:0 0 0 8px rgba(255,56,96,0)}}
.sig-card.closed{opacity:0.5}
.sig-card.fakeout{border-left:4px solid #8b97a5;background:#0f1216;opacity:0.75}
.dir-badge{display:inline-block;font-size:13px;font-weight:900;padding:5px 14px;border-radius:6px}
.dir-badge.long{background:#00ff9d;color:#0a0e14}
.dir-badge.short{background:#ff3860;color:#fff}
.status-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.status-badge.active{background:rgba(0,255,157,0.2);color:#00ff9d;border:1px solid #00ff9d}
.status-badge.warning{background:rgba(246,196,83,0.2);color:#f6c453;border:1px solid #f6c453}
.status-badge.explosion{background:rgba(255,56,96,0.2);color:#ff3860;border:1px solid #ff3860}
.status-badge.tp1{background:#2962ff;color:#fff}
.status-badge.tp2{background:#8a5cff;color:#fff}
.status-badge.be{background:#3a4a63;color:#fff}
.status-badge.stopped{background:#ff3860;color:#fff}
.status-badge.expired{background:#5e6b7c;color:#fff}
.status-badge.fakeout{background:#8b97a5;color:#0a0e14}
.type-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.type-badge.destek{background:rgba(255,56,96,0.15);color:#ff3860;border:1px solid rgba(255,56,96,0.4)}
.type-badge.direnc{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}
.type-badge.trend{background:rgba(138,92,255,0.15);color:#8a5cff;border:1px solid rgba(138,92,255,0.4)}
.type-badge.warning{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.4)}
.trend-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.trend-badge.bullish{background:rgba(0,255,157,0.2);color:#00ff9d}
.trend-badge.bearish{background:rgba(255,56,96,0.2);color:#ff3860}
.trend-badge.sideways{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.quality-badge.high{background:rgba(0,255,157,0.2);color:#00ff9d}
.quality-badge.med{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge.low{background:rgba(139,151,165,0.2);color:#8b97a5}
.momentum-badge{display:inline-block;font-size:9px;font-weight:900;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.momentum-badge.surge{background:rgba(246,196,83,0.2);color:#f6c453;border:1px solid #f6c453}
.momentum-badge.explosion{background:rgba(255,56,96,0.2);color:#ff3860;border:1px solid #ff3860}
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
.action-hint.warning{background:rgba(246,196,83,0.15);color:#f6c453;border-left:3px solid #f6c453}
.action-hint.explosion{background:rgba(255,56,96,0.15);color:#ff3860;border-left:3px solid #ff3860}
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
.chart-info{padding:12px 16px;background:#0d1219;border-top:1px solid #1c2634;display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.chart-info-item{display:flex;flex-direction:column;gap:3px;padding:10px;background:#0a0e14;border-radius:6px}
.chart-info-lbl{color:#5e6b7c;text-transform:uppercase;font-size:9px;font-weight:700}
.chart-info-val{font-weight:800;font-size:14px}
.empty-msg{padding:30px 16px;text-align:center;color:#5e6b7c;font-size:11px;line-height:1.8}
.q-breakdown{padding:12px 16px;background:#0d1219;border-top:1px solid #1c2634;max-height:180px;overflow-y:auto;font-size:11px}
.q-breakdown-title{font-size:10px;font-weight:800;color:#5e6b7c;letter-spacing:1px;margin-bottom:6px}
.q-item{padding:3px 0;color:#c5cfdd}
</style>
</head>
<body>
<div class="app">
<div class="market-bar">
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
<div class="market-brand">SONER <span>TRADE</span> <span class="market-badge">v7.0 • 2H MOMENTUM</span></div>
<div class="market-item"><span class="sym">BTC</span><span class="price" id="btcPrice">-</span><span class="chg" id="btcChg">-</span></div>
<div class="market-item"><span class="sym">ETH</span><span class="price" id="ethPrice">-</span><span class="chg" id="ethChg">-</span></div>
<div class="breadth-item" id="breadthBox"><span class="lbl">BREADTH</span><span class="val" id="breadthVal">-</span></div>
<div class="market-item" id="perfBox"><span class="sym">SONUÇ</span><span class="price" id="perfTxt">-</span></div>
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
<button class="side-tab" data-tab="warnings" id="tabWarnings">⚠️ UYARI <span class="count" id="cWarnings">0</span></button>
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
<div id="chartMomentum"></div>
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
<div class="chart-info-item"><div class="chart-info-lbl">Uzaklık</div><div class="chart-info-val" id="infoDistance">-</div></div>
</div>
<div class="q-breakdown" id="qBreakdown" style="display:none">
<div class="q-breakdown-title">KALİTE DETAYI</div>
<div id="qList"></div>
</div>
</div>
</div>
</div>
</div>
<script>
var signals=[];var escaped=[];var selectedId=null;var currentTab='signals';var ws=null;var lastActiveCount=0;var audioCtx=null;var reconnectTimer=null;var pollTimer=null;
function isOpenS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT';}
function isWarning(s){return s.status==='WARNING';}
function fmt(v){v=Number(v);if(!Number.isFinite(v))return'-';if(v>=1000)return v.toFixed(2);if(v>=100)return v.toFixed(3);if(v>=1)return v.toFixed(4);return v.toFixed(6);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function timeAgo(ts){if(!ts)return'-';var d=Date.now()-ts;var m=Math.floor(d/60000);if(m<1)return'az önce';if(m<60)return m+' dk';var h=Math.floor(m/60);return h+' sa';}
function playSound(){try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator();var g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=880;g.gain.setValueAtTime(0.15,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.4);o.start();o.stop(audioCtx.currentTime+0.4);}catch(e){}}
function setConnStatus(s,t){var el=document.getElementById('connStatus');el.className='conn-status '+s;el.textContent=t;}
function renderPerf(p){var el=document.getElementById('perfTxt');if(!p||!p.closed){el.textContent='-';return;}el.textContent=p.wins+'K / '+p.losses+'Z • '+(p.totalR>=0?'+':'')+p.totalR+'R';}
function renderBreadth(b){if(!b)return;var el=document.getElementById('breadthBox');var val=document.getElementById('breadthVal');val.textContent='%'+b.upRatio+' ↑ / '+b.up+'/'+b.total;el.className='breadth-item '+(b.trend==='BULLISH'?'bull':b.trend==='BEARISH'?'bear':'');}
function renderMarketBar(ms){if(!ms||!ms.btc||!ms.eth)return;
document.getElementById('btcPrice').textContent=fmt(ms.btc.price);
var bc=document.getElementById('btcChg');if(ms.btc.change24h!=null){bc.textContent=(ms.btc.change24h>=0?'+':'')+ms.btc.change24h+'%';bc.className='chg '+(ms.btc.change24h>=0?'up':'down');}
document.getElementById('ethPrice').textContent=fmt(ms.eth.price);
var ec=document.getElementById('ethChg');if(ms.eth.change24h!=null){ec.textContent=(ms.eth.change24h>=0?'+':'')+ms.eth.change24h+'%';ec.className='chg '+(ms.eth.change24h>=0?'up':'down');}
renderBreadth(ms.breadth);
var o=document.getElementById('marketOverall');var l='KARIŞIK',c='mixed';
if(ms.overall==='BULLISH'){l='PİYASA YUKARI';c='bullish';}
else if(ms.overall==='BEARISH'){l='PİYASA AŞAĞI';c='bearish';}
else if(ms.overall==='BULLISH_WEAK'){l='YUKARI (ZAYIF)';c='bullish';}
else if(ms.overall==='BEARISH_WEAK'){l='AŞAĞI (ZAYIF)';c='bearish';}
o.textContent=l+' (Skor: '+ms.score+')';o.className='market-overall '+c;}
function statusBadge(s){if(s.status==='WARNING')return'<span class="status-badge warning">⚠️ UYARI</span>';if(s.status==='ACTIVE')return'<span class="status-badge active">● AKTİF</span>';if(s.status==='TP1_HIT')return'<span class="status-badge tp1">✓ TP1 • AÇIK</span>';if(s.status==='TP2_HIT')return'<span class="status-badge tp2">✓✓ TP2</span>';if(s.status==='BE_STOP')return'<span class="status-badge be">↔ GİRİŞTE KAPANDI</span>';if(s.status==='STOPPED')return'<span class="status-badge stopped">✗ STOP</span>';if(s.status==='EXPIRED')return'<span class="status-badge expired">⏱ SÜRE</span>';if(s.status==='FAKEOUT')return'<span class="status-badge fakeout">✗ SAHTE</span>';return'';}
function qClass(q){if(q>=80)return'high';if(q>=65)return'med';return'low';}
function trendBadge(t,label){var l=label||'4h';if(t==='BULLISH')return'<span class="trend-badge bullish">'+l+' ⬆</span>';if(t==='BEARISH')return'<span class="trend-badge bearish">'+l+' ⬇</span>';return'<span class="trend-badge sideways">'+l+' ⬌</span>';}
function momentumBadge(m){if(m==='EXPLOSION')return'<span class="momentum-badge explosion">🚀 PATLAMA</span>';if(m==='SURGE')return'<span class="momentum-badge surge">⚠️ ARTAN</span>';return'';}
function typeBadge(s){if(s.signalType==='TREND_KIRILIM')return'<span class="type-badge trend">📈 TREND KIRILDI</span>';if(s.signalType==='UYARI')return'<span class="type-badge warning">⚠️ KIRILIM YAKIN</span>';if(s.signalType==='DIRENC_KIRILIM')return'<span class="type-badge direnc">🟢 DİRENÇ KIRILDI</span>';if(s.signalType==='DESTEK_KIRILIM')return'<span class="type-badge destek">🔴 DESTEK KIRILDI</span>';return'';}
function actionHint(s){if(s.status==='WARNING')return'<div class="action-hint warning">⚠️ Kırılım YAKIN — Manuel kontrol et!</div>';if(s.status==='ACTIVE')return'<div class="action-hint buy">✅ Taze kırılım — stop '+fmt(s.stop)+'</div>';if(s.status==='TP1_HIT')return'<div class="action-hint sell">💰 Yarısını sat • stop girişe çekildi</div>';if(s.status==='TP2_HIT')return'<div class="action-hint sell">🎉 Tamamını sat • '+(s.resultR!=null?('+'+s.resultR+'R'):'')+'</div>';if(s.status==='BE_STOP')return'<div class="action-hint neutral">↔ Girişte kapandı • '+(s.resultR!=null?('+'+s.resultR+'R'):'')+'</div>';if(s.status==='STOPPED')return'<div class="action-hint exit">❌ Çık — stop</div>';if(s.status==='EXPIRED')return'<div class="action-hint neutral">⏱ Süre doldu</div>';if(s.status==='FAKEOUT')return'<div class="action-hint neutral">✗ Sahte kırılım • -1R</div>';return'';}
function renderCard(s,fakeout){var dc=s.direction==='LONG'?'long':'short';var sel=s.id===selectedId?'selected':'';var cl=(!isOpenS(s)&&!isWarning(s))?'closed':'';var fo=fakeout?'fakeout':'';var warn=isWarning(s)?'warning':'';var ex=(s.momentumLevel==='EXPLOSION')?'explosion':'';var pnl=(s.pnlPct||0)>=0?'pos':'neg';var pnls=(s.pnlPct||0)>=0?'+':'';var q=s.qualityScore||0;
var trendLine=(s.isTrendLine)?'<span class="type-badge trend">📈</span>':'';
return'<div class="sig-card '+dc+' '+sel+' '+cl+' '+fo+' '+warn+' '+ex+'" data-id="'+esc(s.id)+'">'
+'<div class="sig-row"><div class="sig-sym">'+esc(s.symbol.replace(':USDT',''))+'</div><div class="dir-badge '+dc+'">'+s.direction+'</div></div>'
+'<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px">'
+statusBadge(s)
+typeBadge(s)
+momentumBadge(s.momentumLevel)
+trendBadge(s.trend4h,'4h')+trendBadge(s.trend1d,'1d')
+(s.status==='WARNING'?'':('<span class="quality-badge '+qClass(q)+'">Q'+q+'</span>'))
+'</div>'
+ (s.status==='WARNING'
   ? '<div class="levels-grid">'
     +'<div class="level-item entry"><span class="k">Fiyat</span><span class="v">'+fmt(s.currentPrice||s.entry)+'</span></div>'
     +'<div class="level-item tp1"><span class="k">Seviye</span><span class="v">'+fmt(s.level)+'</span></div>'
     +'<div class="level-item stop"><span class="k">Uzaklık</span><span class="v">'+(s.distanceATR!=null?s.distanceATR+' ATR':'-')+'</span></div>'
     +'<div class="level-item tp2"><span class="k">Seviye</span><span class="v">'+s.levelStrength+'x</span></div>'
     +'</div>'
   : '<div class="levels-grid">'
     +'<div class="level-item entry"><span class="k">Giriş</span><span class="v">'+fmt(s.entry)+'</span></div>'
     +'<div class="level-item stop"><span class="k">Stop</span><span class="v">'+fmt(s.stop)+'</span></div>'
     +'<div class="level-item tp1"><span class="k">TP1</span><span class="v">'+fmt(s.tp1)+'</span></div>'
     +'<div class="level-item tp2"><span class="k">TP2</span><span class="v">'+fmt(s.tp2)+'</span></div>'
     +'</div>')
+'<div class="sig-price"><span class="cur">'+fmt(s.currentPrice||s.entry)+'</span>'+(s.pnlPct!=null&&s.status!=='WARNING'?'<span class="pnl '+pnl+'">'+pnls+s.pnlPct+'%</span>':'')+'</div>'
+actionHint(s)
+'<div class="sig-meta"><span>📊 '+s.volumeRatio+'x</span><span>📏 '+s.bodyRatio+' ATR</span><span>🎯 RSI '+s.rsi+'</span><span>📍 '+s.levelStrength+'x</span><span>⏱ '+timeAgo(s.timestamp)+'</span></div>'
+'</div>';}
function renderList(){var el=document.getElementById('sideList');var st=el.scrollTop;var html='';
if(currentTab==='signals'){
var active=signals.filter(isOpenS);var closed=signals.filter(function(s){return !isOpenS(s)&&!isWarning(s);});
if(active.length>0)html+=active.map(function(s){return renderCard(s,false);}).join('');
if(closed.length>0){html+='<div style="padding:14px 8px 6px;font-size:10px;font-weight:800;color:#5e6b7c;letter-spacing:1px">📁 KAPANANLAR</div>';html+=closed.slice(0,20).map(function(s){return renderCard(s,false);}).join('');}
if(!html)html='<div class="empty-msg">🎯 Henüz sinyal yok.<br><br>2h kırılım + momentum<br>onayı olunca burada görünecek.</div>';
}else if(currentTab==='warnings'){
var warnings=signals.filter(isWarning);
if(warnings.length>0)html+=warnings.map(function(s){return renderCard(s,false);}).join('');
else html='<div class="empty-msg">⚠️ Şu an uyarı yok.<br><br>Hacim artıyor ama kırılım<br>henüz olmadığında burada listelenir.</div>';
}else{
if(escaped.length>0)html+=escaped.slice(0,30).map(function(s){return renderCard(s,true);}).join('');
else html='<div class="empty-msg">📁 Henüz kaçan sinyal yok.<br><br>Stop olan sahte kırılımlar burada listelenir.</div>';
}
el.innerHTML=html;el.scrollTop=st;
el.querySelectorAll('.sig-card[data-id]').forEach(function(c){c.onclick=function(){selectedId=c.getAttribute('data-id');renderList();renderMain();};});}
function renderMain(){if(!selectedId){document.getElementById('mainEmpty').style.display='flex';document.getElementById('mainContent').style.display='none';return;}
var all=signals.concat(escaped);var s=all.find(function(x){return x.id===selectedId;});
if(!s){document.getElementById('mainEmpty').style.display='flex';document.getElementById('mainContent').style.display='none';return;}
document.getElementById('mainEmpty').style.display='none';
document.getElementById('mainContent').style.display='flex';
document.getElementById('chartSym').textContent=s.symbol.replace(':USDT','');
document.getElementById('chartDir').innerHTML='<div class="dir-badge '+(s.direction==='LONG'?'long':'short')+'">'+s.direction+'</div>';
document.getElementById('chartType').innerHTML=typeBadge(s);
document.getElementById('chartMomentum').innerHTML=momentumBadge(s.momentumLevel);
document.getElementById('chartTrend').innerHTML=trendBadge(s.trend4h,'4h')+trendBadge(s.trend1d,'1d');
document.getElementById('chartQuality').innerHTML=s.status==='WARNING'?'':'<span class="quality-badge '+qClass(s.qualityScore)+'">Kalite '+s.qualityScore+'/100</span>';
document.getElementById('chartStatus').innerHTML=statusBadge(s);
document.getElementById('tvLink').href='https://www.tradingview.com/chart/?symbol=BITGET:'+s.symbolTV+'&interval=120';
document.getElementById('infoEntry').textContent=fmt(s.entry);
document.getElementById('infoStop').textContent=s.stop?fmt(s.stop):'-';
document.getElementById('infoTp1').textContent=s.tp1?fmt(s.tp1):'-';
document.getElementById('infoTp2').textContent=s.tp2?fmt(s.tp2):'-';
document.getElementById('infoLevel').textContent=fmt(s.level)+' ('+s.levelStrength+'x)';
document.getElementById('infoDistance').textContent=s.distanceATR!=null?s.distanceATR+' ATR':'-';
if(s.qualityBreakdown&&s.qualityBreakdown.length>0){
document.getElementById('qBreakdown').style.display='block';
document.getElementById('qList').innerHTML=s.qualityBreakdown.map(function(x){return'<div class="q-item">'+esc(x)+'</div>';}).join('');
}else{
document.getElementById('qBreakdown').style.display='none';
}
setTimeout(function(){drawChart(s);},30);}
function drawChart(s){var canvas=document.getElementById('mainCanvas');var parent=canvas.parentElement;var W=parent.clientWidth,H=parent.clientHeight;var dpr=window.devicePixelRatio||1;canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=s.direction==='LONG'?'#08120d':'#12080c';ctx.fillRect(0,0,W,H);
var candles=s.candles;if(!candles||!candles.length)return;var count=candles.length;
var minP=Infinity,maxP=-Infinity;for(var i=0;i<candles.length;i++){var lo=Number(candles[i].l),hi=Number(candles[i].h);if(lo<minP)minP=lo;if(hi>maxP)maxP=hi;}
[s.entry,s.initialStop||s.stop,s.tp1,s.tp2,s.currentPrice,s.level].forEach(function(v){if(v==null)return;v=Number(v);if(v<minP)minP=v;if(v>maxP)maxP=v;});
var pad=(maxP-minP)*0.06||1;minP-=pad;maxP+=pad;
var LEFT=130,RIGHT=20,TOP=30,BOTTOM=30;var PW=W-LEFT-RIGHT,PH=H-TOP-BOTTOM;
function X(i){return LEFT+i*PW/(count-1||1);}function Y(p){return TOP+(maxP-p)/(maxP-minP)*PH;}
ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;for(var g=0;g<=5;g++){var y=TOP+PH*g/5;ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();}
var lv=[];
function addLevel(price,color,label,dash){if(price==null)return;lv.push({price:Number(price),color:color,label:label,dash:dash,y:Y(Number(price))});}
addLevel(s.tp2,'#8a5cff','TP2',[4,4]);addLevel(s.tp1,'#00ff9d','TP1',[4,4]);addLevel(s.initialStop||s.stop,'#ff3860','STOP',[6,3]);addLevel(s.entry,'#2962ff','GİRİŞ',[]);addLevel(s.level,'#f6c453','SEVİYE',[2,2]);
lv.forEach(function(o){ctx.save();ctx.strokeStyle=o.color;ctx.lineWidth=2;if(o.dash.length)ctx.setLineDash(o.dash);ctx.beginPath();ctx.moveTo(LEFT,o.y);ctx.lineTo(W-RIGHT,o.y);ctx.stroke();ctx.restore();});
lv.sort(function(a,b){return a.y-b.y;});var prevY=-100;lv.forEach(function(o){o.ly=Math.max(o.y,prevY+14);prevY=o.ly;});
lv.forEach(function(o){ctx.save();ctx.fillStyle=o.color;ctx.font='bold 12px Arial';ctx.textAlign='right';ctx.fillText(o.label+' '+fmt(o.price),LEFT-10,o.ly+4);ctx.restore();});
var cw=Math.max(3,Math.min(16,PW/count*0.7));for(var c=0;c<candles.length;c++){var k=candles[c];var x=X(c);var o=Number(k.o),cl=Number(k.c),h=Number(k.h),l=Number(k.l);var bull=cl>=o;var color=bull?'#00ff9d':'#ff3860';ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(x,Y(h));ctx.lineTo(x,Y(l));ctx.stroke();var oY=Y(o),cY=Y(cl);ctx.fillRect(x-cw/2,Math.min(oY,cY),cw,Math.max(1,Math.abs(cY-oY)));}
var sx=X(count-1);ctx.save();ctx.strokeStyle='rgba(246,196,83,0.6)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(sx,TOP-10);ctx.lineTo(sx,H-BOTTOM);ctx.stroke();ctx.restore();
ctx.save();ctx.fillStyle='#f6c453';ctx.font='bold 11px Arial';ctx.textAlign='right';ctx.fillText('KIRILIM MUMU',sx-6,TOP-14);ctx.restore();
if(s.currentPrice!=null){var cy=Y(s.currentPrice);ctx.save();ctx.strokeStyle='#f6c453';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(LEFT,cy);ctx.lineTo(W-RIGHT,cy);ctx.stroke();ctx.restore();}}
function switchTab(t){currentTab=t;document.querySelectorAll('.side-tab').forEach(function(el){if(el.getAttribute('data-tab')===t)el.classList.add('active');else el.classList.remove('active');});selectedId=null;renderList();renderMain();}
document.getElementById('tabSignals').onclick=function(){switchTab('signals');};
document.getElementById('tabWarnings').onclick=function(){switchTab('warnings');};
document.getElementById('tabEscaped').onclick=function(){switchTab('escaped');};
function apply(data){if(!data)return;var ns=Array.isArray(data.signals)?data.signals:[];var ac=ns.filter(isOpenS).length;if(ac>lastActiveCount&&lastActiveCount>0)playSound();lastActiveCount=ac;signals=ns;escaped=Array.isArray(data.escaped)?data.escaped:[];
if(data.marketStatus)renderMarketBar(data.marketStatus);
renderPerf(data.perf);
if(!selectedId&&signals.length>0)selectedId=signals[0].id;
var wc=ns.filter(isWarning).length;
document.getElementById('cSignals').textContent=ac;
document.getElementById('cWarnings').textContent=wc;
document.getElementById('cEscaped').textContent=escaped.length;
document.title=(ac>0?'('+ac+') ':'')+'SONER TRADE v7.0';
var ei=document.getElementById('emptyInfo');if(ei)ei.textContent='Aktif: '+ac+' / Uyarı: '+wc+' / Kaçan: '+escaped.length+(data.scanStatus?' • '+data.scanStatus.message:'');
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

app.get('/', (req, res) => res.type('html').send(HTML));

async function start() {
    try {
        loadState();
        await exchange.loadMarkets();
        logInfo(`Bitget marketleri | ${Object.keys(exchange.markets).length} market`);
        await updateMarketStatus();
        await runPreScan();
        await runScan();
        setInterval(function () { runScan(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function () { updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function () { updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function () { runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        setInterval(function () { saveState(false); }, CONFIG.SAVE_INTERVAL_MS);
        logInfo('SONER TRADE v7.0 — 2H MOMENTUM + TREND LINES');
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
    saveState(true);
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function () { try { await exchange.close(); } catch (e) {} process.exit(0); });
    setTimeout(function () { process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function () { shutdown('SIGINT'); });
process.once('SIGTERM', function () { shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function () {
    logInfo(`SONER TRADE v7.0 PORT=${PORT}`);
    start();
});
