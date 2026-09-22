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
// SONER TRADE v11.0 — SEVİYE + MUM ONAYI + ANLIK PİYASA
// ============================================================

const CONFIG = {
    TIMEFRAME: '15m',
    TF_MS: 15 * 60 * 1000,
    HTF1: '1h',
    HTF2: '4h',
    CANDLE_LIMIT: 200,

    LEVEL_LOOKBACK: 50,
    LEVEL_STRENGTH_MIN: 2,
    LEVEL_TOLERANCE: 0.004,
    LEVEL_APPROACH_DIST: 0.008,

    EMA_FAST: 21,
    EMA_SLOW: 50,

    MIN_BODY_ATR_RATIO: 0.4,
    MIN_VOLUME_MULTIPLIER: 1.5,

    ATR_PERIOD: 14,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 75,
    RSI_OVERSOLD: 25,

    STOP_ATR_MULT: 0.5,
    STOP_BUFFER_ATR: 0.15,
    TP1_RR: 1.5,
    TP2_RR: 3.0,
    TP1_CLOSE_FRACTION: 0.5,
    MAX_RISK_PCT: 4,

    MIN_QUALITY_SCORE: 70,

    SIGNAL_VALID_MS: 4 * 60 * 60 * 1000,
    SIGNAL_COOLDOWN_MS: 60 * 60 * 1000,
    MAX_SIGNAL_AGE_MS: 5 * 60 * 1000,

    TREND_CACHE_MS: 3 * 60 * 1000,
    MARKET_TREND_CACHE_MS: 60 * 1000,

    MIN_24H_VOLUME_USDT: 2000000,
    MAX_TARGETS: 200,
    MAX_SIGNALS_PER_SCAN: 5,

    EXCLUDED_BASES: ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','WBTC','WETH','WSTETH','STETH'],

    SCAN_INTERVAL_MS: 60 * 1000,
    SCAN_CONCURRENCY: 3,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    MARKET_STATUS_INTERVAL_MS: 15 * 1000,
    LIVE_INTERVAL_MS: 5 * 1000,
    WICK_CHECK_MS: 30 * 1000,
    SAVE_INTERVAL_MS: 15 * 1000,
    MAX_SIGNALS_KEPT: 100,
    MAX_ESCAPED_KEPT: 50,
    MAX_HISTORY_KEPT: 500,

    MIN_MARKET_SCORE: 2
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
    scanned: 0, approaches: 0, signals: 0, long: 0, short: 0,
    rejectedTrend: 0, rejectedSide: 0, rejectedVolume: 0, rejectedBody: 0,
    rejectedQuality: 0, rejectedCooldown: 0, rejectedMarket: 0, errors: 0
};

function logInfo(...a) { console.log('[INFO]', ...a); }
function logError(...a) { console.error('[ERROR]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v, d = 8) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function isOpen(s) { return s.status === 'ACTIVE' || s.status === 'TP1_HIT'; }
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

function fmtSignalMsg(s) {
    const icon = s.direction === 'LONG' ? '🟢' : '🔴';
    return `${icon} ${s.symbol.replace(':USDT', '')} ${s.direction} | Q${s.qualityScore}\n` +
        `Giris: ${s.entry}\nStop: ${s.stop}\nTP1: ${s.tp1} | TP2: ${s.tp2}\n` +
        `Seviye: ${s.level} (${s.levelStrength}x) | Hacim ${s.volumeRatio}x | Mum: ${s.candleType} | RSI ${s.rsi}`;
}

async function getTrends(symbol) {
    const c = trendCache.get(symbol);
    if (c && Date.now() - c.at < CONFIG.TREND_CACHE_MS) return c;
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

        const r = { trend1h, trend4h, at: Date.now() };
        trendCache.set(symbol, r);
        return r;
    } catch {
        return { trend1h: 'SIDEWAYS', trend4h: 'SIDEWAYS', at: 0 };
    }
}

// ============================================================
// MARKET STATUS — ANLIK (15 saniyede bir güncelleme)
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
        // BTC/ETH trend cache (1 dakika)
        if (Date.now() - marketTrendCache.at > CONFIG.MARKET_TREND_CACHE_MS) {
            const btc = await ema200Trend('BTC/USDT:USDT');
            const eth = await ema200Trend('ETH/USDT:USDT');
            marketTrendCache = { btc, eth, at: Date.now() };
        }
        const btcTrend = marketTrendCache.btc, ethTrend = marketTrendCache.eth;

        // ANLIK breadth + ticker (her 15 saniyede)
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
        // Breadth bonusu
        if (breadthTrend === 'BULLISH') score += 3; else if (breadthTrend === 'BEARISH') score -= 3;

        let overall;
        if (score >= 5) overall = 'BULLISH';
        else if (score >= 2) overall = 'BULLISH_WEAK';
        else if (score <= -5) overall = 'BEARISH';
        else if (score <= -2) overall = 'BEARISH_WEAK';
        else overall = 'MIXED';

        marketStatus = {
            btc: { trend: btcTrend, price: btcT ? num(btcT.last) : null, change24h: Number.isFinite(btcChg) ? num(btcChg, 2) : null },
            eth: { trend: ethTrend, price: ethT ? num(ethT.last) : null, change24h: Number.isFinite(ethChg) ? num(ethChg, 2) : null },
            breadth: { trend: breadthTrend, up, down, total, upRatio: num(upRatio * 100, 1), downRatio: num(downRatio * 100, 1) },
            overall, score, updatedAt: Date.now()
        };
        broadcast();
    } catch (err) { logError(`[marketStatus] ${err.message}`); }
}

// ============================================================
// SEVİYE TESPİTİ — Sadece "SEVİYE" (destek/direnç ayrımı YOK)
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

    // TÜM seviyeler (destek/direnç ayrımı yok, hepsi "LEVEL")
    const allLevels = [...cluster(highs), ...cluster(lows)]
        .filter(c => c.count >= CONFIG.LEVEL_STRENGTH_MIN)
        .sort((a, b) => b.count - a.count);  // en güçlü en başta

    return { levels: allLevels };
}

// ============================================================
// MUM ONAYI
// ============================================================

function candleConfirmation(candle, prevCandle, direction, atrVal) {
    const o = Number(candle[1]), c = Number(candle[4]);
    const h = Number(candle[2]), l = Number(candle[3]);
    const body = Math.abs(c - o);
    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;
    const bodyRatio = body / atrVal;

    if (direction === 'LONG') {
        const isGreen = c > o;
        const longLowerWick = lowerWick > body * 1.5;
        const strongBody = bodyRatio >= CONFIG.MIN_BODY_ATR_RATIO && isGreen;
        return { ok: strongBody || (isGreen && longLowerWick), type: longLowerWick ? 'PIN' : (strongBody ? 'BODY' : 'NONE') };
    } else {
        const isRed = c < o;
        const longUpperWick = upperWick > body * 1.5;
        const strongBody = bodyRatio >= CONFIG.MIN_BODY_ATR_RATIO && isRed;
        return { ok: strongBody || (isRed && longUpperWick), type: longUpperWick ? 'PIN' : (strongBody ? 'BODY' : 'NONE') };
    }
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQuality({ direction, trend1h, trend4h, volumeRatio, rsiValue, bodyRatio, levelStrength, candleType }) {
    let score = 0;
    const breakdown = [];

    if (direction === 'LONG') {
        if (trend4h === 'BULLISH') { score += 20; breakdown.push('✅ 4h trend yukarı (+20)'); }
        else if (trend4h === 'SIDEWAYS') { score += 8; breakdown.push('⚪ 4h trend nötr (+8)'); }
        else { breakdown.push('❌ 4h trend ters'); }

        if (trend1h === 'BULLISH') { score += 20; breakdown.push('✅ 1h trend yukarı (+20)'); }
        else if (trend1h === 'SIDEWAYS') { score += 8; breakdown.push('⚪ 1h trend nötr (+8)'); }
        else { breakdown.push('❌ 1h trend ters'); }
    } else {
        if (trend4h === 'BEARISH') { score += 20; breakdown.push('✅ 4h trend aşağı (+20)'); }
        else if (trend4h === 'SIDEWAYS') { score += 8; breakdown.push('⚪ 4h trend nötr (+8)'); }
        else { breakdown.push('❌ 4h trend ters'); }

        if (trend1h === 'BEARISH') { score += 20; breakdown.push('✅ 1h trend aşağı (+20)'); }
        else if (trend1h === 'SIDEWAYS') { score += 8; breakdown.push('⚪ 1h trend nötr (+8)'); }
        else { breakdown.push('❌ 1h trend ters'); }
    }

    if (volumeRatio >= 3.0) { score += 20; breakdown.push(`✅ Çok güçlü hacim ${num(volumeRatio, 1)}x (+20)`); }
    else if (volumeRatio >= 2.0) { score += 15; breakdown.push(`✅ Güçlü hacim ${num(volumeRatio, 1)}x (+15)`); }
    else if (volumeRatio >= 1.5) { score += 10; breakdown.push(`🟡 Orta hacim ${num(volumeRatio, 1)}x (+10)`); }
    else { breakdown.push('❌ Düşük hacim'); }

    if (candleType === 'PIN') { score += 15; breakdown.push('✅ Pin bar onayı (+15)'); }
    else if (candleType === 'BODY') { score += 10; breakdown.push('✅ Güçlü gövde (+10)'); }
    else { breakdown.push('❌ Mum onayı yok'); }

    if (levelStrength >= 5) { score += 15; breakdown.push(`✅ Çok güçlü seviye (${levelStrength}x) (+15)`); }
    else if (levelStrength >= 3) { score += 12; breakdown.push(`✅ Güçlü seviye (${levelStrength}x) (+12)`); }
    else if (levelStrength >= 2) { score += 8; breakdown.push(`🟡 Normal seviye (${levelStrength}x) (+8)`); }
    else { breakdown.push('❌ Zayıf seviye'); }

    if (rsiValue != null) {
        if (direction === 'LONG') {
            if (rsiValue >= 50 && rsiValue <= 70) { score += 10; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+10)`); }
            else if (rsiValue >= 40 && rsiValue < 50) { score += 5; breakdown.push(`🟡 RSI nötr ${num(rsiValue, 0)} (+5)`); }
            else if (rsiValue > CONFIG.RSI_OVERBOUGHT) { breakdown.push(`⚠️ RSI aşırı alım`); }
            else { breakdown.push('❌ RSI uygun değil'); }
        } else {
            if (rsiValue >= 30 && rsiValue <= 50) { score += 10; breakdown.push(`✅ RSI ideal ${num(rsiValue, 0)} (+10)`); }
            else if (rsiValue > 50 && rsiValue <= 60) { score += 5; breakdown.push(`🟡 RSI nötr ${num(rsiValue, 0)} (+5)`); }
            else if (rsiValue < CONFIG.RSI_OVERSOLD) { breakdown.push(`⚠️ RSI aşırı satım`); }
            else { breakdown.push('❌ RSI uygun değil'); }
        }
    }

    return { score: Math.min(score, 100), breakdown };
}

// ============================================================
// ANA TARAMA
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (Math.abs(marketStatus.score) < CONFIG.MIN_MARKET_SCORE) { DEBUG.rejectedMarket++; return null; }
        if (isExcluded(symbol)) return null;
        if (signals.some(s => s.symbol === symbol && isOpen(s))) return null;

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.LEVEL_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const close = Number(last[4]), open = Number(last[1]);
        const volume = Number(last[5]);
        if (![close, open, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const closes = priorCandles.map(c => Number(c[4]));

        const volumes = priorCandles.slice(-30).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(30, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);
        const body = Math.abs(close - open);
        const bodyRatio = body / currentATR;

        const trends = await getTrends(symbol);
        const { levels } = findLevels(priorCandles);

        // TÜM seviyeleri kontrol et — en güçlüden zayıfa
        let direction = null, level = null, levelStrength = 0;
        let bestScore = 0;

        for (const lvl of levels) {
            const dist = (close - lvl.price) / lvl.price;
            const absDist = Math.abs(dist);

            // Seviyeye yakınlık kontrolü
            if (absDist > CONFIG.LEVEL_APPROACH_DIST) continue;

            // Fiyat seviyenin HANGİ tarafında?
            // LONG: fiyat seviyenin ÜSTÜNDE (veya çok yakın) → destek tutuyor
            // SHORT: fiyat seviyenin ALTINDA (veya çok yakın) → direnç tutuyor

            let candidateDir = null;
            if (dist >= -0.001) {
                // Fiyat seviyenin üstünde → LONG adayı (destek)
                if (trends.trend1h === 'BULLISH' || trends.trend4h === 'BULLISH') {
                    candidateDir = 'LONG';
                }
            }
            if (dist <= 0.001 && (trends.trend1h === 'BEARISH' || trends.trend4h === 'BEARISH')) {
                // Fiyat seviyenin altında → SHORT adayı (direnç)
                candidateDir = 'SHORT';
            }

            if (!candidateDir) continue;

            // Kalite puanı ile en iyi seviyeyi seç
            const score = lvl.count * 10 - absDist * 1000;
            if (score > bestScore) {
                bestScore = score;
                direction = candidateDir;
                level = lvl.price;
                levelStrength = lvl.count;
            }
        }

        if (!direction || !level) return null;
        DEBUG.approaches++;

        // FİYAT SEVİYENİN DOĞRU TARAFINDA MI?
        if (direction === 'LONG' && close < level * 0.998) { DEBUG.rejectedSide++; return null; }
        if (direction === 'SHORT' && close > level * 1.002) { DEBUG.rejectedSide++; return null; }

        // TREND ZORUNLU
        const trendOk =
            (direction === 'LONG' && trends.trend1h !== 'BEARISH' && trends.trend4h !== 'BEARISH') ||
            (direction === 'SHORT' && trends.trend1h !== 'BULLISH' && trends.trend4h !== 'BULLISH');
        if (!trendOk) { DEBUG.rejectedTrend++; return null; }

        // MUM ONAYI
        const conf = candleConfirmation(last, prev, direction, currentATR);
        if (!conf.ok) { DEBUG.rejectedBody++; return null; }

        // HACİM
        if (volumeRatio < CONFIG.MIN_VOLUME_MULTIPLIER) { DEBUG.rejectedVolume++; return null; }

        // KALİTE
        const quality = calculateQuality({
            direction, trend1h: trends.trend1h, trend4h: trends.trend4h,
            volumeRatio, rsiValue, bodyRatio, levelStrength, candleType: conf.type
        });
        if (quality.score < CONFIG.MIN_QUALITY_SCORE) { DEBUG.rejectedQuality++; return null; }

        // COOLDOWN
        const key = `${symbol}_${direction}`;
        const lastTime = lastSignalTime.get(key) || 0;
        if (Date.now() - lastTime < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejectedCooldown++; return null; }

        // STOP / TP — DÜZELTİLDİ
        let stop, tp1, tp2;
        if (direction === 'LONG') {
            // Stop: seviyenin ALTINDA (destek altı) VEYA mumun dibinin altı
            const levelStop = level - currentATR * CONFIG.STOP_BUFFER_ATR;
            const candleStop = Number(last[3]) - currentATR * CONFIG.STOP_BUFFER_ATR;
            stop = Math.min(levelStop, candleStop);
            // Giriş stop'un ÜSTÜNDE olmalı
            if (stop >= close) stop = close - currentATR * CONFIG.STOP_ATR_MULT;
            const risk = close - stop;
            if (risk <= 0) return null;
            tp1 = close + risk * CONFIG.TP1_RR;
            tp2 = close + risk * CONFIG.TP2_RR;
        } else {
            // Stop: seviyenin ÜSTÜNDE (direnç üstü) VEYA mumun tepesinin üstü
            const levelStop = level + currentATR * CONFIG.STOP_BUFFER_ATR;
            const candleStop = Number(last[2]) + currentATR * CONFIG.STOP_BUFFER_ATR;
            stop = Math.max(levelStop, candleStop);
            // Giriş stop'un ALTINDA olmalı
            if (stop <= close) stop = close + currentATR * CONFIG.STOP_ATR_MULT;
            const risk = stop - close;
            if (risk <= 0) return null;
            tp1 = close - risk * CONFIG.TP1_RR;
            tp2 = close - risk * CONFIG.TP2_RR;
        }

        // Risk kontrolü
        const riskPct = Math.abs((close - stop) / close) * 100;
        if (riskPct > CONFIG.MAX_RISK_PCT) return null;

        lastSignalTime.set(key, Date.now());
        DEBUG.signals++;
        if (direction === 'LONG') DEBUG.long++; else DEBUG.short++;

        logInfo(`🎯 ${direction} | ${symbol} | Seviye ${num(level)} (${levelStrength}x) | Q${quality.score} | Hacim ${num(volumeRatio,1)}x | Mum ${conf.type} | RSI ${num(rsiValue, 0)}`);

        const now = Date.now();
        return {
            id: `${symbol.replace(/[^A-Z0-9]/gi,'')}_${direction}_${now}`,
            symbol,
            symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction,
            signalType: direction === 'LONG' ? 'DESTEK' : 'DIRENC',
            timeframe: CONFIG.TIMEFRAME,
            status: 'ACTIVE',
            entry: num(close),
            currentPrice: num(close),
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
            riskPct: num(riskPct, 2),
            trend1h: trends.trend1h,
            trend4h: trends.trend4h,
            candleType: conf.type,
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
        bodyRatio: sig.bodyRatio, rsi: sig.rsi,
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
    const L = sig.direction === 'LONG';
    const stop = Number(sig.stop), tp1 = Number(sig.tp1), tp2 = Number(sig.tp2);

    const hitStop = L ? low <= stop : high >= stop;
    if (hitStop) {
        if (sig.tp1Hit) finalizeSignal(sig, 'BE_STOP', 'Giriş stopu (TP1 sonrası)', now, price);
        else finalizeSignal(sig, 'FAKEOUT', 'Stop', now, price);
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
                sig.pnlPct = num(((sig.direction === 'LONG' ? price - entry : entry - price) / entry) * 100, 2);
                sig.updatedAt = now;
                if (applyPriceWindow(sig, price, price, price, now)) changed = true;
                changed = true;
            }

            if (isOpen(sig) && now - (sig.wickCheckedAt || sig.timestamp) >= CONFIG.WICK_CHECK_MS) {
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
                finalizeSignal(sig, 'EXPIRED', 'Süre doldu', now, Number(sig.currentPrice) || Number(sig.entry));
                changed = true;
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

async function runScan(force) {
    if (scanRunning || isShuttingDown) return;

    if (!force) {
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
    }

    scanRunning = true;
    for (const k of Object.keys(DEBUG)) if (k !== 'errors') DEBUG[k] = 0;

    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0;
    let idx = 0;

    async function worker() {
        while (!isShuttingDown) {
            if (newSignals >= CONFIG.MAX_SIGNALS_PER_SCAN) return;
            const i = idx++;
            if (i >= targets.length) return;
            const signal = await scanForSignal(targets[i]);
            if (signal && newSignals < CONFIG.MAX_SIGNALS_PER_SCAN) {
                signals.unshift(signal);
                signals = signals.slice(0, CONFIG.MAX_SIGNALS_KEPT);
                newSignals++;
                markDirty();
                notify(fmtSignalMsg(signal));
                broadcast();
            }
        }
    }

    try {
        await Promise.all(Array.from({ length: CONFIG.SCAN_CONCURRENCY }, worker));
        lastScanAt = Date.now();
    } catch (err) { logError(`[runScan] ${err.message}`); }

    scanRunning = false;
    APP_STATE.scanStatus = { message: `Tarama bitti | ${newSignals} yeni`, isScanning: false };
    broadcast();
    logInfo(`[TARAMA] Tarandı=${DEBUG.scanned} | Yaklaşım=${DEBUG.approaches} | Yeni=${newSignals} | Trend=${DEBUG.rejectedTrend} | YanlışTaraf=${DEBUG.rejectedSide} | Hacim=${DEBUG.rejectedVolume} | Mum=${DEBUG.rejectedBody} | Kalite=${DEBUG.rejectedQuality} | Cooldown=${DEBUG.rejectedCooldown} | Hata=${DEBUG.errors}`);
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
    const active = signals.filter(isOpen);
    return {
        success: true,
        signals: signals.slice(0, 100),
        escaped: escapedSignals.slice(0, 50),
        marketStatus,
        scanStatus: APP_STATE.scanStatus,
        perf: perfStats(),
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
<title>SONER TRADE v11.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#05070d;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow-x:hidden}
.app{display:flex;flex-direction:column;min-height:100vh}
.header{background:#101522;border-bottom:1px solid rgba(173,216,230,.15);padding:12px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;position:sticky;top:0;z-index:100}
.logo{font-size:16px;font-weight:900}
.logo span{color:#00bfff}
.badge{font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(0,191,255,.2);color:#00bfff;margin-left:8px;border:1px solid rgba(0,191,255,.4)}
.header-right{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.market-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#05070d;border-radius:5px;font-size:11px;border:1px solid rgba(173,216,230,.1)}
.market-item .sym{font-weight:700;color:#708090}
.market-item .price{font-weight:700}
.market-item .chg{padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px}
.market-item .chg.up{background:rgba(0,255,170,.15);color:#00ffaa}
.market-item .chg.down{background:rgba(255,77,77,.15);color:#ff4d4d}
.breadth-item{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#05070d;border-radius:5px;font-size:11px;border:1px solid rgba(173,216,230,.15)}
.breadth-item.bull{border-color:rgba(0,255,170,.5)}
.breadth-item.bear{border-color:rgba(255,77,77,.5)}
.market-overall{padding:6px 14px;border-radius:5px;font-size:11px;font-weight:800}
.market-overall.bullish{background:rgba(0,255,170,.15);color:#00ffaa;border:1px solid rgba(0,255,170,.3)}
.market-overall.bearish{background:rgba(255,77,77,.15);color:#ff4d4d;border:1px solid rgba(255,77,77,.3)}
.market-overall.mixed{background:rgba(255,209,102,.15);color:#ffd166;border:1px solid rgba(255,209,102,.3)}
.conn{padding:4px 10px;border-radius:4px;font-size:10px;font-weight:700;background:#1a2235;color:#708090}
.conn.online{background:rgba(0,255,170,.15);color:#00ffaa}
.conn.offline{background:rgba(255,77,77,.15);color:#ff4d4d}
.container{max-width:1800px;margin:0 auto;padding:20px;width:100%}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.metric{background:#101522;border-radius:8px;padding:16px;border:1px solid rgba(173,216,230,.15);border-left:4px solid #00bfff}
.metric-lbl{color:#708090;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:1px}
.metric-val{font-size:20px;font-weight:900;margin-top:6px}
.tabs{display:flex;gap:4px;margin-bottom:16px;background:#101522;border-radius:8px;padding:4px;border:1px solid rgba(173,216,230,.15);width:fit-content;flex-wrap:wrap}
.tab{padding:8px 16px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:800;text-transform:uppercase;color:#708090;background:transparent;border:none;font-family:inherit;transition:all .15s}
.tab.active{background:#00bfff;color:#05070d}
.tab .count{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(0,0,0,.2);color:inherit;margin-left:4px}
.tab.active .count{background:rgba(0,0,0,.3)}
.panel{background:#101522;border:1px solid rgba(173,216,230,.15);border-radius:12px;overflow:hidden}
.panel-head{padding:14px 16px;background:#1a2235;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;border-bottom:1px solid rgba(173,216,230,.1)}
.panel-title{font-weight:900;font-size:13px;display:flex;align-items:center;gap:8px}
.panel-sub{font-size:10px;color:#708090}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{padding:12px;text-align:left;border-bottom:1px solid rgba(173,216,230,.08);font-size:12px;white-space:nowrap}
th{background:rgba(26,34,53,.6);color:#b0c4de;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:800}
tr:hover td{background:rgba(26,34,53,.4)}
tr.signal-row{cursor:pointer;transition:background .15s}
tr.signal-row:hover{background:rgba(0,191,255,.05)}
.dir-badge{display:inline-block;font-size:11px;font-weight:900;padding:4px 10px;border-radius:5px}
.dir-badge.long{background:#00ffaa;color:#05070d}
.dir-badge.short{background:#ff4d4d;color:#fff}
.status-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.status-badge.active{background:rgba(0,255,170,.2);color:#00ffaa;border:1px solid #00ffaa}
.status-badge.tp1{background:#2962ff;color:#fff}
.status-badge.tp2{background:#8a5cff;color:#fff}
.status-badge.be{background:#3a4a63;color:#fff}
.status-badge.stopped{background:#ff4d4d;color:#fff}
.status-badge.expired{background:#5e6b7c;color:#fff}
.status-badge.fakeout{background:#8b97a5;color:#05070d}
.q-badge{display:inline-block;font-size:11px;font-weight:800;padding:4px 10px;border-radius:5px}
.q-badge.high{background:rgba(0,255,170,.2);color:#00ffaa}
.q-badge.med{background:rgba(255,209,102,.2);color:#ffd166}
.q-badge.low{background:rgba(139,151,165,.2);color:#8b97a5}
.candle-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(41,98,255,.2);color:#4a7cff}
.pnl{font-weight:800}
.pnl.pos{color:#00ffaa}
.pnl.neg{color:#ff4d4d}
.btn{background:#1a2331;border:1px solid #2c3a4f;color:#e9eef5;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.btn:hover{background:#243044}
.btn.green{background:#00ffaa;color:#05070d;border-color:#00ffaa}
.empty{padding:40px 20px;text-align:center;color:#708090;font-size:12px;line-height:1.8}
.modal-backdrop{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-backdrop.show{display:flex}
.modal{background:#101522;border:1px solid rgba(173,216,230,.2);border-radius:12px;width:100%;max-width:1000px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal-head{padding:14px 20px;background:#1a2235;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(173,216,230,.15);flex-wrap:wrap;gap:10px}
.modal-title{font-size:16px;font-weight:900;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.modal-body{flex:1;overflow:hidden;position:relative;background:#070b11;min-height:400px}
#chartCanvas{width:100%;height:100%;display:block}
.modal-info{padding:14px 20px;background:#101522;border-top:1px solid rgba(173,216,230,.15);display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.info-item{display:flex;flex-direction:column;gap:3px;padding:10px;background:#05070d;border-radius:6px}
.info-lbl{color:#708090;text-transform:uppercase;font-size:9px;font-weight:800}
.info-val{font-weight:900;font-size:14px}
.close-x{background:none;border:none;color:#708090;font-size:24px;cursor:pointer;line-height:1;padding:0 8px}
.close-x:hover{color:#fff}
@media(max-width:768px){
  .header{padding:10px}
  .container{padding:12px}
  .metrics{grid-template-columns:1fr 1fr}
  .modal-info{grid-template-columns:repeat(2,1fr)}
  th,td{padding:8px;font-size:11px}
}
</style>
</head>
<body>
<div class="app">
<div class="header">
<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
<div class="logo">SONER <span>TRADE</span><span class="badge">v11.0 • SEVİYE+MUM</span></div>
<div class="market-item"><span class="sym">BTC</span><span class="price" id="btcPrice">-</span><span class="chg" id="btcChg">-</span></div>
<div class="market-item"><span class="sym">ETH</span><span class="price" id="ethPrice">-</span><span class="chg" id="ethChg">-</span></div>
<div class="breadth-item" id="breadthBox"><span class="sym">BREADTH</span><span class="price" id="breadthVal">-</span></div>
</div>
<div class="header-right">
<div class="market-overall mixed" id="marketOverall">-</div>
<div class="conn" id="connStatus">Bağlanıyor...</div>
</div>
</div>

<div class="container">
<div class="metrics">
<div class="metric"><div class="metric-lbl">Aktif Sinyal</div><div class="metric-val" id="mActive">0</div></div>
<div class="metric"><div class="metric-lbl">Kazanan</div><div class="metric-val" style="color:#00ffaa" id="mWins">0</div></div>
<div class="metric"><div class="metric-lbl">Kaybeden</div><div class="metric-val" style="color:#ff4d4d" id="mLosses">0</div></div>
<div class="metric"><div class="metric-lbl">Winrate</div><div class="metric-val" id="mWinrate">-</div></div>
<div class="metric"><div class="metric-lbl">Toplam R</div><div class="metric-val" id="mTotalR">0.0</div></div>
</div>

<div class="tabs">
<button class="tab active" data-tab="active" id="tabActive">🎯 AKTİF <span class="count" id="cActive">0</span></button>
<button class="tab" data-tab="long" id="tabLong">🟢 LONG <span class="count" id="cLong">0</span></button>
<button class="tab" data-tab="short" id="tabShort">🔴 SHORT <span class="count" id="cShort">0</span></button>
<button class="tab" data-tab="closed" id="tabClosed">📁 KAPANAN <span class="count" id="cClosed">0</span></button>
<button class="tab" data-tab="escaped" id="tabEscaped">✗ KAÇAN <span class="count" id="cEscaped">0</span></button>
</div>

<div class="panel">
<div class="panel-head">
<div class="panel-title">🎯 SİNYALLER</div>
<div class="panel-sub" id="scanStatus">Yükleniyor...</div>
</div>
<div class="tbl-wrap">
<table>
<thead>
<tr>
<th>Coin</th>
<th>Yön</th>
<th>Mum</th>
<th>Giriş</th>
<th>Anlık</th>
<th>P&L</th>
<th>TP1 / TP2</th>
<th>Stop</th>
<th>Q</th>
<th>Seviye</th>
<th>Durum</th>
<th>İşlem</th>
</tr>
</thead>
<tbody id="signalBody">
<tr><td colspan="12" class="empty">Yükleniyor...</td></tr>
</tbody>
</table>
</div>
</div>
</div>
</div>

<div class="modal-backdrop" id="chartModal">
<div class="modal">
<div class="modal-head">
<div class="modal-title">
<span id="modalCoin">-</span>
<span id="modalDir"></span>
<span id="modalCandle"></span>
<span id="modalStatus"></span>
</div>
<div style="display:flex;gap:6px;align-items:center">
<a class="btn" id="tvLink" target="_blank" style="background:#2962ff;border-color:#2962ff;color:#fff">📈 TradingView</a>
<button class="close-x" onclick="closeChart()">×</button>
</div>
</div>
<div class="modal-body">
<canvas id="chartCanvas"></canvas>
</div>
<div class="modal-info">
<div class="info-item"><div class="info-lbl">Giriş</div><div class="info-val" style="color:#4a7cff" id="iEntry">-</div></div>
<div class="info-item"><div class="info-lbl">Stop</div><div class="info-val" style="color:#ff4d4d" id="iStop">-</div></div>
<div class="info-item"><div class="info-lbl">TP1</div><div class="info-val" style="color:#00ffaa" id="iTp1">-</div></div>
<div class="info-item"><div class="info-lbl">TP2</div><div class="info-val" style="color:#8a5cff" id="iTp2">-</div></div>
<div class="info-item"><div class="info-lbl">Seviye</div><div class="info-val" style="color:#ffd166" id="iLevel">-</div></div>
</div>
</div>
</div>

<script>
var signals = [];
var escaped = [];
var selectedId = null;
var currentTab = 'active';
var ws = null;
var lastActiveCount = 0;
var audioCtx = null;
var reconnectTimer = null;
var pollTimer = null;

function isOpenS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT';}
function fmt(v){v=Number(v);if(!Number.isFinite(v))return'-';if(v>=1000)return v.toFixed(2);if(v>=100)return v.toFixed(3);if(v>=1)return v.toFixed(4);return v.toFixed(6);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function timeAgo(ts){if(!ts)return'-';var d=Date.now()-ts;var m=Math.floor(d/60000);if(m<1)return'az önce';if(m<60)return m+' dk';var h=Math.floor(m/60);return h+' sa';}

function playSound(){try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator();var g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=880;g.gain.setValueAtTime(0.15,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.4);o.start();o.stop(audioCtx.currentTime+0.4);}catch(e){}}

function setConn(s,t){var el=document.getElementById('connStatus');el.className='conn '+s;el.textContent=t;}

function renderMarketBar(ms){
if(!ms||!ms.btc||!ms.eth)return;
document.getElementById('btcPrice').textContent=fmt(ms.btc.price);
var bc=document.getElementById('btcChg');if(ms.btc.change24h!=null){bc.textContent=(ms.btc.change24h>=0?'+':'')+ms.btc.change24h+'%';bc.className='chg '+(ms.btc.change24h>=0?'up':'down');}
document.getElementById('ethPrice').textContent=fmt(ms.eth.price);
var ec=document.getElementById('ethChg');if(ms.eth.change24h!=null){ec.textContent=(ms.eth.change24h>=0?'+':'')+ms.eth.change24h+'%';ec.className='chg '+(ms.eth.change24h>=0?'up':'down');}
if(ms.breadth){var bb=document.getElementById('breadthBox');var bv=document.getElementById('breadthVal');bv.textContent='%'+ms.breadth.upRatio+' ↑ '+ms.breadth.up+'/'+ms.breadth.total;bb.className='breadth-item '+(ms.breadth.trend==='BULLISH'?'bull':ms.breadth.trend==='BEARISH'?'bear':'');}
var o=document.getElementById('marketOverall');var l='KARIŞIK',c='mixed';
if(ms.overall==='BULLISH'){l='PİYASA YUKARI';c='bullish';}
else if(ms.overall==='BEARISH'){l='PİYASA AŞAĞI';c='bearish';}
else if(ms.overall==='BULLISH_WEAK'){l='YUKARI (ZAYIF)';c='bullish';}
else if(ms.overall==='BEARISH_WEAK'){l='AŞAĞI (ZAYIF)';c='bearish';}
o.textContent=l+' (Skor: '+ms.score+')';o.className='market-overall '+c;
}

function statusBadge(s){
if(s.status==='ACTIVE')return'<span class="status-badge active">● AKTİF</span>';
if(s.status==='TP1_HIT')return'<span class="status-badge tp1">✓ TP1</span>';
if(s.status==='TP2_HIT')return'<span class="status-badge tp2">✓✓ TP2</span>';
if(s.status==='BE_STOP')return'<span class="status-badge be">↔ BE</span>';
if(s.status==='STOPPED')return'<span class="status-badge stopped">✗ STOP</span>';
if(s.status==='EXPIRED')return'<span class="status-badge expired">⏱ SÜRE</span>';
if(s.status==='FAKEOUT')return'<span class="status-badge fakeout">✗ KAÇAN</span>';
return'';
}
function qClass(q){if(q>=85)return'high';if(q>=70)return'med';return'low';}

function renderRow(s){
var dc=s.direction==='LONG'?'long':'short';
var candleLabel=s.candleType==='PIN'?'🕯 PIN':(s.candleType==='BODY'?'📊 GÖVDE':'-');
var pnl=(s.pnlPct||0)>=0?'pos':'neg';
var pnls=(s.pnlPct||0)>=0?'+':'';
var q=s.qualityScore||0;
var cur=s.currentPrice||s.entry;
var clickable=isOpenS(s)?'signal-row':'';
return '<tr class="'+clickable+'" data-id="'+esc(s.id)+'">'
+'<td><strong>'+esc(s.symbol.replace(':USDT',''))+'</strong><br><span style="font-size:10px;color:#708090">'+timeAgo(s.timestamp)+'</span></td>'
+'<td><span class="dir-badge '+dc+'">'+s.direction+'</span></td>'
+'<td><span class="candle-badge">'+candleLabel+'</span></td>'
+'<td>'+fmt(s.entry)+'</td>'
+'<td>'+fmt(cur)+'</td>'
+'<td class="pnl '+pnl+'">'+pnls+(s.pnlPct||0)+'%</td>'
+'<td><span style="color:#00ffaa">'+fmt(s.tp1)+'</span> / <span style="color:#8a5cff">'+fmt(s.tp2)+'</span></td>'
+'<td><span style="color:#ff4d4d">'+fmt(s.stop)+'</span></td>'
+'<td><span class="q-badge '+qClass(q)+'">Q'+q+'</span></td>'
+'<td>'+s.levelStrength+'x</td>'
+'<td>'+statusBadge(s)+'</td>'
+'<td>'+(isOpenS(s)?'<button class="btn green" onclick="openChart(\\''+esc(s.id)+'\\')">📊 Grafik</button>':'')+'</td>'
+'</tr>';
}

function renderTable(){
var tb=document.getElementById('signalBody');
var list=[];
if(currentTab==='active')list=signals.filter(isOpenS);
else if(currentTab==='long')list=signals.filter(function(s){return s.direction==='LONG'&&isOpenS(s);});
else if(currentTab==='short')list=signals.filter(function(s){return s.direction==='SHORT'&&isOpenS(s);});
else if(currentTab==='closed')list=signals.filter(function(s){return !isOpenS(s);});
else list=escaped;
if(!list.length){tb.innerHTML='<tr><td colspan="12" class="empty">Bu sekmede sinyal yok.</td></tr>';return;}
tb.innerHTML=list.map(renderRow).join('');
tb.querySelectorAll('tr[data-id]').forEach(function(r){r.onclick=function(e){if(e.target.tagName==='BUTTON')return;openChart(r.getAttribute('data-id'));};});
}

function switchTab(t){
currentTab=t;
document.querySelectorAll('.tab').forEach(function(el){if(el.getAttribute('data-tab')===t)el.classList.add('active');else el.classList.remove('active');});
renderTable();
}
document.getElementById('tabActive').onclick=function(){switchTab('active');};
document.getElementById('tabLong').onclick=function(){switchTab('long');};
document.getElementById('tabShort').onclick=function(){switchTab('short');};
document.getElementById('tabClosed').onclick=function(){switchTab('closed');};
document.getElementById('tabEscaped').onclick=function(){switchTab('escaped');};

function apply(data){
if(!data)return;
var ns=Array.isArray(data.signals)?data.signals:[];
var ac=ns.filter(isOpenS).length;
if(ac>lastActiveCount&&lastActiveCount>0)playSound();
lastActiveCount=ac;
signals=ns;
escaped=Array.isArray(data.escaped)?data.escaped:[];

if(data.marketStatus)renderMarketBar(data.marketStatus);

var closed=ns.filter(function(s){return !isOpenS(s);}).length;
document.getElementById('cActive').textContent=ac;
document.getElementById('cLong').textContent=ns.filter(function(s){return s.direction==='LONG'&&isOpenS(s);}).length;
document.getElementById('cShort').textContent=ns.filter(function(s){return s.direction==='SHORT'&&isOpenS(s);}).length;
document.getElementById('cClosed').textContent=closed;
document.getElementById('cEscaped').textContent=escaped.length;
document.getElementById('mActive').textContent=ac;

if(data.perf){
document.getElementById('mWins').textContent=data.perf.wins||0;
document.getElementById('mLosses').textContent=data.perf.losses||0;
document.getElementById('mWinrate').textContent=data.perf.winRate?('%'+data.perf.winRate):'-';
var tr=data.perf.totalR||0;
var trEl=document.getElementById('mTotalR');
trEl.textContent=(tr>=0?'+':'')+tr.toFixed(2)+'R';
trEl.style.color=tr>=0?'#00ffaa':'#ff4d4d';
}

if(data.scanStatus)document.getElementById('scanStatus').textContent=data.scanStatus.message||'';

document.title=(ac>0?'('+ac+') ':'')+'SONER TRADE v11.0';
renderTable();
}

function fetchSignals(){
fetch('/api/signals?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){apply(d);setConn('online','Bağlı');}).catch(function(){setConn('offline','Bağlantı Yok');});
}

function connect(){
if(reconnectTimer)clearTimeout(reconnectTimer);
try{
var proto=location.protocol==='https:'?'wss://':'ws://';
ws=new WebSocket(proto+location.host);
ws.onopen=function(){setConn('online','Canlı');};
ws.onmessage=function(ev){try{var m=JSON.parse(ev.data);if(m.type==='snapshot'||m.type==='update')apply(m.data);}catch(e){}};
ws.onclose=function(){setConn('offline','Yeniden Bağlanıyor');reconnectTimer=setTimeout(connect,3000);};
ws.onerror=function(){setConn('offline','Hata');};
}catch(e){reconnectTimer=setTimeout(connect,3000);}
}

function openChart(id){
var all=signals.concat(escaped);
var s=all.find(function(x){return x.id===id;});
if(!s)return;
selectedId=id;
document.getElementById('chartModal').classList.add('show');
document.getElementById('modalCoin').textContent=s.symbol.replace(':USDT','');
document.getElementById('modalDir').innerHTML='<span class="dir-badge '+(s.direction==='LONG'?'long':'short')+'">'+s.direction+'</span>';
document.getElementById('modalCandle').innerHTML='<span class="candle-badge">'+(s.candleType==='PIN'?'🕯 PIN':(s.candleType==='BODY'?'📊 GÖVDE':'-'))+'</span>';
document.getElementById('modalStatus').innerHTML=statusBadge(s);
document.getElementById('tvLink').href='https://www.tradingview.com/chart/?symbol=BITGET:'+s.symbolTV+'&interval=15';
document.getElementById('iEntry').textContent=fmt(s.entry);
document.getElementById('iStop').textContent=fmt(s.stop);
document.getElementById('iTp1').textContent=fmt(s.tp1);
document.getElementById('iTp2').textContent=fmt(s.tp2);
document.getElementById('iLevel').textContent=fmt(s.level)+' ('+s.levelStrength+'x)';
setTimeout(function(){drawChart(s);},50);
}

function closeChart(){
document.getElementById('chartModal').classList.remove('show');
selectedId=null;
}

document.getElementById('chartModal').addEventListener('click',function(e){
if(e.target===this)closeChart();
});
document.addEventListener('keydown',function(e){
if(e.key==='Escape')closeChart();
});

function drawChart(s){
var canvas=document.getElementById('chartCanvas');
var parent=canvas.parentElement;
var W=parent.clientWidth,H=parent.clientHeight;
var dpr=window.devicePixelRatio||1;
canvas.width=W*dpr;canvas.height=H*dpr;
canvas.style.width=W+'px';canvas.style.height=H+'px';
var ctx=canvas.getContext('2d');
ctx.setTransform(dpr,0,0,dpr,0,0);
ctx.fillStyle=s.direction==='LONG'?'#08120d':'#12080c';
ctx.fillRect(0,0,W,H);

var candles=s.candles;
if(!candles||!candles.length)return;
var count=candles.length;

var minP=Infinity,maxP=-Infinity;
for(var i=0;i<candles.length;i++){
var lo=Number(candles[i].l),hi=Number(candles[i].h);
if(lo<minP)minP=lo;if(hi>maxP)maxP=hi;
}
[s.entry,s.stop,s.tp1,s.tp2,s.currentPrice,s.level].forEach(function(v){
if(v==null)return;v=Number(v);
if(v<minP)minP=v;if(v>maxP)maxP=v;
});
var pad=(maxP-minP)*0.06||1;
minP-=pad;maxP+=pad;

var LEFT=130,RIGHT=20,TOP=30,BOTTOM=30;
var PW=W-LEFT-RIGHT,PH=H-TOP-BOTTOM;

function X(i){return LEFT+i*PW/(count-1||1);}
function Y(p){return TOP+(maxP-p)/(maxP-minP)*PH;}

ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;
for(var g=0;g<=5;g++){
var y=TOP+PH*g/5;
ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();
}

var lv=[];
function addLevel(price,color,label,dash){
if(price==null)return;
lv.push({price:Number(price),color:color,label:label,dash:dash,y:Y(Number(price))});
}
addLevel(s.tp2,'#8a5cff','TP2',[4,4]);
addLevel(s.tp1,'#00ffaa','TP1',[4,4]);
addLevel(s.initialStop||s.stop,'#ff4d4d','STOP',[6,3]);
addLevel(s.entry,'#2962ff','GİRİŞ',[]);
addLevel(s.level,'#ffd166','SEVİYE',[2,2]);

lv.forEach(function(o){
ctx.save();
ctx.strokeStyle=o.color;ctx.lineWidth=2;
if(o.dash.length)ctx.setLineDash(o.dash);
ctx.beginPath();ctx.moveTo(LEFT,o.y);ctx.lineTo(W-RIGHT,o.y);ctx.stroke();
ctx.restore();
});

lv.sort(function(a,b){return a.y-b.y;});
var prevY=-100;
lv.forEach(function(o){o.ly=Math.max(o.y,prevY+14);prevY=o.ly;});
lv.forEach(function(o){
ctx.save();
ctx.fillStyle=o.color;ctx.font='bold 12px Arial';ctx.textAlign='right';
ctx.fillText(o.label+' '+fmt(o.price),LEFT-10,o.ly+4);
ctx.restore();
});

var cw=Math.max(3,Math.min(16,PW/count*0.7));
for(var c=0;c<candles.length;c++){
var k=candles[c];var x=X(c);
var o=Number(k.o),cl=Number(k.c),h=Number(k.h),l=Number(k.l);
var bull=cl>=o;
var color=bull?'#00ffaa':'#ff4d4d';
ctx.strokeStyle=color;ctx.fillStyle=color;
ctx.beginPath();ctx.moveTo(x,Y(h));ctx.lineTo(x,Y(l));ctx.stroke();
var oY=Y(o),cY=Y(cl);
ctx.fillRect(x-cw/2,Math.min(oY,cY),cw,Math.max(1,Math.abs(cY-oY)));
}

var sx=X(count-1);
ctx.save();
ctx.strokeStyle='rgba(255,209,102,0.6)';ctx.lineWidth=1;ctx.setLineDash([3,3]);
ctx.beginPath();ctx.moveTo(sx,TOP-10);ctx.lineTo(sx,H-BOTTOM);ctx.stroke();
ctx.restore();
ctx.save();
ctx.fillStyle='#ffd166';ctx.font='bold 11px Arial';ctx.textAlign='right';
ctx.fillText('SİNYAL MUMU',sx-6,TOP-14);
ctx.restore();

if(s.currentPrice!=null){
var cy=Y(s.currentPrice);
ctx.save();
ctx.strokeStyle='#ffd166';ctx.lineWidth=2;
ctx.beginPath();ctx.moveTo(LEFT,cy);ctx.lineTo(W-RIGHT,cy);ctx.stroke();
ctx.restore();
}
}

window.addEventListener('resize',function(){
if(selectedId){
var all=signals.concat(escaped);
var s=all.find(function(x){return x.id===selectedId;});
if(s)drawChart(s);
}
});

setConn('offline','Bağlanıyor...');
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
        await runScan(true);
        setInterval(function () { runScan(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function () { updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function () { updateMarketStatus(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function () { runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        setInterval(function () { saveState(false); }, CONFIG.SAVE_INTERVAL_MS);
        logInfo('SONER TRADE v11.0 — SEVİYE + MUM + ANLIK PİYASA');
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
    logInfo(`SONER TRADE v11.0 PORT=${PORT}`);
    start();
});
