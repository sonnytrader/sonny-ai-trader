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
// SCALP ENGINE v1.0 — Sıfırdan tasarım
// Felsefe: az parametre, sıkı risk, hızlı çıkış.
// 5 katman:
//   1) Piyasa Rejimi   — sürekli (continuous) skor, sert kapı değil
//   2) Setup           — Likidite Avı > Pullback > Klasik Kırılım
//   3) Risk            — pozisyon boyutlama, trailing stop, sert süre limiti,
//                         ardışık kayıp soğuması, günlük zarar limiti
//   4) Likidite/Spread — spread filtresi, funding saati kaçınma, min volatilite
//   5) Ölçme           — gölge takip (reddedilen setup'lar kazanır mıydı?),
//                         setup bazlı performans
// ============================================================

const CONFIG = {
    SCAN_TIMEFRAME: '5m',
    SCAN_TF_MS: 5 * 60 * 1000,
    CANDLE_LIMIT: 150,

    LEVEL_LOOKBACK: 80,
    LEVEL_PIVOT_SPAN: 2,
    LEVEL_STRENGTH_MIN: 2,
    LEVEL_TOLERANCE: 0.003,

    TREND_EMA_FAST: 21,
    TREND_EMA_SLOW: 50,
    TREND_CACHE_MS: 5 * 60 * 1000,

    MICRO_EMA_FAST: 9,
    MICRO_EMA_SLOW: 21,

    ATR_PERIOD: 14,
    RSI_PERIOD: 14,
    MIN_ATR_PCT: 0.12,          // coin bu kadar oynak değilse tarama (durgun/yatay)

    // ── Setup A: Likidite Avı + Dönüş (en güvenilir kabul edilen) ──
    SWEEP_WICK_MIN_ATR: 0.35,
    SWEEP_CLOSE_BACK_BUFFER_ATR: 0.05,
    SWEEP_VOLUME_MULT: 1.8,

    // ── Setup B: Trend Devamı (Pullback) ──
    PULLBACK_MAX_DIST_ATR: 0.6,
    PULLBACK_MIN_BODY_ATR: 0.35,
    PULLBACK_MIN_TREND_DIFF_PCT: 0.05,

    // ── Setup C: Klasik Kırılım (en düşük öncelik) ──
    BREAKOUT_BUFFER_ATR: 0.15,
    BREAKOUT_MIN_BODY_ATR: 0.55,
    BREAKOUT_VOLUME_MULT: 2.2,
    STOP_STRUCT_BUFFER_ATR_DEFAULT: 0.25,

    RSI_OVERBOUGHT: 72,
    RSI_OVERSOLD: 28,
    MAX_EXTENSION_ATR: 1.2,

    // ── Piyasa Rejimi (sürekli skor -10..+10, sert kapı DEĞİL) ──
    MARKET_REGIME_WEIGHT_5M: 0.5,
    MARKET_REGIME_WEIGHT_15M: 0.4,
    MARKET_REGIME_WEIGHT_SPIKE: 0.1,
    MARKET_REGIME_SCALE_5M: 0.25,     // bu % fark = o katmanda tam puan referansı
    MARKET_REGIME_SCALE_15M: 0.35,
    MARKET_REGIME_SCALE_SPIKE: 0.5,
    MARKET_REGIME_EXTREME_BLOCK: 6,   // sadece BU şiddette karşı yönü tamamen engelle
    MARKET_TREND_CACHE_MS: 45 * 1000,

    // ── Risk / Pozisyon Boyutlama ──
    ACCOUNT_EQUITY_USDT: Number(process.env.ACCOUNT_EQUITY_USDT || 1000),
    RISK_PER_TRADE_PCT: Number(process.env.RISK_PER_TRADE_PCT || 0.75),
    MAX_RISK_DISTANCE_PCT: 1.2,       // stop mesafesi fiyatın bu yüzdesinden büyükse iptal

    TP1_RR: 1.0,
    TP1_CLOSE_FRACTION: 0.5,
    TRAIL_ATR_MULT: 0.6,              // TP1 sonrası trailing stop mesafesi (ATR çarpanı)

    MAX_HOLD_MS: 25 * 60 * 1000,      // sert zaman aşımı — scalp'te pozisyon "çalışmıyorsa" çık
    ENTRY_MAX_AGE_MS: 90 * 1000,      // mum kapanışından bu kadar geç kaldıysa artık taze değil
    SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

    MIN_QUALITY_SCORE: 60,

    // ── Davranışsal Risk Koruması ──
    CONSECUTIVE_LOSS_LIMIT: 3,
    LOSS_COOLDOWN_MS: 45 * 60 * 1000,
    DAILY_LOSS_LIMIT_R: -6,

    // ── Likidite / Spread ──
    MAX_SPREAD_ATR_RATIO: 0.18,       // spread, ATR'nin bu oranından büyükse iptal

    // ── Funding Saati Kaçınma (Bitget: 00:00 / 08:00 / 16:00 UTC) ──
    FUNDING_HOURS_UTC: [0, 8, 16],
    FUNDING_AVOID_MINUTES: 4,

    MIN_24H_VOLUME_USDT: 3000000,
    MAX_TARGETS: 150,
    MAX_SIGNALS_PER_SCAN: 3,

    EXCLUDED_BASES: ['USDC','USDT','DAI','TUSD','BUSD','FDUSD','WBTC','WETH','WSTETH','STETH'],

    SCAN_CONCURRENCY: 4,
    SCAN_INTERVAL_MS: 20 * 1000,
    PRESCAN_INTERVAL_MS: 10 * 60 * 1000,
    MARKET_STATUS_INTERVAL_MS: 20 * 1000,
    LIVE_INTERVAL_MS: 4 * 1000,
    WICK_CHECK_MS: 20 * 1000,
    SAVE_INTERVAL_MS: 15 * 1000,
    LAST_SIGNAL_TIME_TRIM_MS: 24 * 60 * 60 * 1000,

    SHADOW_EVAL_AFTER_MS: 15 * 60 * 1000,
    SHADOW_CHECK_INTERVAL_MS: 60 * 1000,
    MAX_SHADOW_KEPT: 300,

    TRADE_COST_R: 0.05,

    MAX_SIGNALS_KEPT: 100,
    MAX_ESCAPED_KEPT: 50,
    MAX_HISTORY_KEPT: 500
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DUMP_FILE = path.join(DATA_DIR, 'dump.json');

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    rateLimit: 150,
    options: { defaultType: 'swap' }
});

// ============================================================
// STATE
// ============================================================

let targets = [];
let signals = [];
let escapedSignals = [];   // TP1 görmeden direkt stop olanlar
let history = [];
let shadowWatch = [];      // henüz değerlendirilmemiş reddedilen setup adayları
let shadowHistory = [];    // değerlendirilmiş sonuçlar (kazanır mıydı?)

let marketRegime = { btc: null, eth: null, score: 0, overall: 'BİLİNMİYOR', updatedAt: 0 };
let regimeCache = { btc: null, eth: null, at: 0 };

let scanRunning = false;
let liveRunning = false;
let isShuttingDown = false;
let lastPrescanAt = 0;
let lastScanAt = 0;
let stateDirty = false;

const lastSignalTime = new Map();
const trendCache = new Map();

let lossStreak = 0;
let lossCooldownUntil = 0;
let dailyR = 0;
let dailyResetAt = nextUtcMidnight();

const APP_STATE = { scanStatus: { message: 'Sunucu başlatılıyor...', isScanning: false }, updatedAt: Date.now() };

const DEBUG = {
    scanned: 0, setupsFound: 0, signals: 0, long: 0, short: 0,
    rejectedOpen: 0, rejectedStale: 0, rejectedFlat: 0, rejectedRSI: 0,
    rejectedCooldown: 0, rejectedRegime: 0, rejectedFunding: 0, rejectedSpread: 0,
    rejectedExtension: 0, rejectedRisk: 0, rejectedQuality: 0,
    errors: 0, totalErrors: 0
};

// ============================================================
// LOG + YARDIMCILAR
// ============================================================

function logInfo(...a) { console.log('[INFO]', ...a); }
function logError(...a) { console.error('[ERROR]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v, d = 8) { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isOpen(s) { return s.status === 'ACTIVE' || s.status === 'TP1_HIT'; }
function markDirty() { stateDirty = true; }
function nextUtcMidnight() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }

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
// KALICILIK
// ============================================================

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (Array.isArray(d.signals)) signals = d.signals;
        if (Array.isArray(d.escapedSignals)) escapedSignals = d.escapedSignals;
        if (Array.isArray(d.history)) history = d.history;
        if (Array.isArray(d.shadowHistory)) shadowHistory = d.shadowHistory;
        if (Array.isArray(d.lastSignalTime)) for (const [k, v] of d.lastSignalTime) lastSignalTime.set(k, v);
        if (typeof d.lossStreak === 'number') lossStreak = d.lossStreak;
        if (typeof d.lossCooldownUntil === 'number') lossCooldownUntil = d.lossCooldownUntil;
        if (typeof d.dailyR === 'number') dailyR = d.dailyR;
        if (typeof d.dailyResetAt === 'number') dailyResetAt = d.dailyResetAt;

        const now = Date.now();
        let expired = 0;
        signals.forEach(s => {
            if (isOpen(s) && s.maxHoldUntil && now > s.maxHoldUntil) {
                finalizeSignal(s, 'TIME_EXIT', 'Süre doldu (restart)', now, Number(s.currentPrice) || Number(s.entry));
                expired++;
            }
        });
        if (expired) logInfo(`State: ${expired} sinyal TIME_EXIT işaretlendi (restart)`);
        logInfo(`State yüklendi | ${signals.length} sinyal, ${history.length} geçmiş, ${escapedSignals.length} kaçan, ${shadowHistory.length} gölge`);
    } catch (err) { logError(`[loadState] ${err.message}`); }
}

function saveState(force) {
    if (!stateDirty && !force) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            signals, escapedSignals, history, shadowHistory,
            lastSignalTime: Array.from(lastSignalTime.entries()),
            lossStreak, lossCooldownUntil, dailyR, dailyResetAt
        }));
        fs.renameSync(tmp, STATE_FILE);
        stateDirty = false;
    } catch (err) { logError(`[saveState] ${err.message}`); }
}

function dumpSnapshotToDisk() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DUMP_FILE, JSON.stringify({
            dumpedAt: Date.now(),
            config: {
                MIN_QUALITY_SCORE: CONFIG.MIN_QUALITY_SCORE,
                TP1_RR: CONFIG.TP1_RR,
                TRAIL_ATR_MULT: CONFIG.TRAIL_ATR_MULT,
                MAX_HOLD_MS: CONFIG.MAX_HOLD_MS,
                RISK_PER_TRADE_PCT: CONFIG.RISK_PER_TRADE_PCT
            },
            perf: perfStats(),
            shadow: shadowStats(),
            history
        }, null, 2));
    } catch (err) { logError(`[dumpSnapshotToDisk] ${err.message}`); }
}

function trimLastSignalTime() {
    const cutoff = Date.now() - CONFIG.LAST_SIGNAL_TIME_TRIM_MS;
    let removed = 0;
    for (const [k, v] of lastSignalTime) { if (v < cutoff) { lastSignalTime.delete(k); removed++; } }
    if (removed) { logInfo(`lastSignalTime budandı: ${removed} kayıt`); markDirty(); }
}

// ============================================================
// TELEGRAM
// ============================================================

async function notify(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    if (typeof fetch !== 'function') { logError('[telegram] fetch yok (Node 18+ gerekli)'); return; }
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
    return `${icon} ${s.symbol.replace(':USDT', '')} ${s.direction} | ${s.setupType} | Q${s.qualityScore}\n` +
        `Giriş: ${s.entry}\nStop: ${s.stop}\nTP1: ${s.tp1}\n` +
        `Miktar: ${s.sizing.qty} (~${s.sizing.notionalUSDT} USDT) | Risk: ${s.sizing.riskAmountUSDT} USDT\n` +
        `Hacim ${s.volumeRatio}x | RSI ${s.rsi} | Rejim ${s.regimeScore}`;
}

// ============================================================
// TREND BAĞLAMI (15m + 1h — coin bazlı, teyit amaçlı)
// ============================================================

async function getTrendContext(symbol) {
    const c = trendCache.get(symbol);
    if (c && Date.now() - c.at < CONFIG.TREND_CACHE_MS) return c;
    try {
        const raw15 = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);
        const closes15 = closedCandles(raw15).map(x => Number(x[4]));
        const f15 = ema(closes15, CONFIG.TREND_EMA_FAST), s15 = ema(closes15, CONFIG.TREND_EMA_SLOW);
        let trend15m = 'SIDEWAYS';
        if (f15 && s15) { if (f15 > s15 * 1.001) trend15m = 'BULLISH'; else if (f15 < s15 * 0.999) trend15m = 'BEARISH'; }

        const raw1h = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
        const closes1h = closedCandles(raw1h).map(x => Number(x[4]));
        const f1 = ema(closes1h, CONFIG.TREND_EMA_FAST), s1 = ema(closes1h, CONFIG.TREND_EMA_SLOW);
        let trend1h = 'SIDEWAYS';
        if (f1 && s1) { if (f1 > s1 * 1.001) trend1h = 'BULLISH'; else if (f1 < s1 * 0.999) trend1h = 'BEARISH'; }

        const r = { trend15m, trend1h, at: Date.now() };
        trendCache.set(symbol, r);
        return r;
    } catch {
        return { trend15m: 'SIDEWAYS', trend1h: 'SIDEWAYS', at: 0 };
    }
}

// ============================================================
// KATMAN 1 — PİYASA REJİMİ (sürekli skor)
// ============================================================
// Önceki sistemin hatası: eşik geçilince sabit puan / geçilmezse 0 (tri-state).
// Bu, skorun sürekli 0'da (dead zone) takılmasına ve TÜM taramanın durmasına
// yol açıyordu. Burada fark, referans ölçeğe (SCALE) oranlanarak -1..+1 arası
// SÜREKLİ bir katsayıya çevriliyor — ne "tam açık" ne "tam kapalı", ara
// değerler de anlamlı katkı veriyor. Ham yüzdeler de logluyoruz ki "piyasa
// gerçekten durgun mu yoksa veri mi bozuk" ayrımı her zaman yapılabilsin.
// ============================================================

async function analyzeRegimeSymbol(symbol) {
    try {
        const raw5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 40);
        const c5m = closedCandles(raw5m).map(c => Number(c[4]));
        const f5 = ema(c5m, CONFIG.MICRO_EMA_FAST), s5 = ema(c5m, CONFIG.MICRO_EMA_SLOW);
        let p5m = 0, diff5m = null;
        if (f5 && s5) { diff5m = (f5 - s5) / s5 * 100; p5m = clamp(diff5m / CONFIG.MARKET_REGIME_SCALE_5M, -1, 1); }

        const raw15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
        const c15m = closedCandles(raw15m).map(c => Number(c[4]));
        const f15 = ema(c15m, CONFIG.TREND_EMA_FAST), s15 = ema(c15m, CONFIG.TREND_EMA_SLOW);
        let p15m = 0, diff15m = null;
        if (f15 && s15) { diff15m = (f15 - s15) / s15 * 100; p15m = clamp(diff15m / CONFIG.MARKET_REGIME_SCALE_15M, -1, 1); }

        const rawSpike = await exchange.fetchOHLCV(symbol, '5m', undefined, 5);
        const csSpike = closedCandles(rawSpike);
        let pSpike = 0, diffSpike = null;
        if (csSpike.length >= 3) {
            const first = Number(csSpike[csSpike.length - 3][4]);
            const last = Number(csSpike[csSpike.length - 1][4]);
            diffSpike = (last - first) / first * 100;
            pSpike = clamp(diffSpike / CONFIG.MARKET_REGIME_SCALE_SPIKE, -1, 1);
        }

        const score10 = (p5m * CONFIG.MARKET_REGIME_WEIGHT_5M +
            p15m * CONFIG.MARKET_REGIME_WEIGHT_15M +
            pSpike * CONFIG.MARKET_REGIME_WEIGHT_SPIKE) * 10;

        return {
            score: Math.round(score10 * 10) / 10,
            diff5m: diff5m != null ? num(diff5m, 3) : null,
            diff15m: diff15m != null ? num(diff15m, 3) : null,
            diffSpike: diffSpike != null ? num(diffSpike, 3) : null
        };
    } catch (err) {
        logError(`[analyzeRegimeSymbol] ${symbol}: ${err.message}`);
        return { score: 0, diff5m: null, diff15m: null, diffSpike: null, error: true };
    }
}

async function updateMarketRegime() {
    try {
        if (!regimeCache.btc || Date.now() - regimeCache.at > CONFIG.MARKET_TREND_CACHE_MS) {
            const [btc, eth] = await Promise.all([
                analyzeRegimeSymbol('BTC/USDT:USDT'),
                analyzeRegimeSymbol('ETH/USDT:USDT')
            ]);
            regimeCache = { btc, eth, at: Date.now() };
        }
        const btcA = regimeCache.btc, ethA = regimeCache.eth;
        const score = clamp(Math.round((btcA.score * 0.6 + ethA.score * 0.4) * 10) / 10, -10, 10);

        let overall = 'NÖTR';
        if (score >= 5) overall = 'GÜÇLÜ BOĞA';
        else if (score >= 2) overall = 'BOĞA';
        else if (score <= -5) overall = 'GÜÇLÜ AYI';
        else if (score <= -2) overall = 'AYI';

        const tickers = await exchange.fetchTickers(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
        const btcT = tickers['BTC/USDT:USDT'], ethT = tickers['ETH/USDT:USDT'];

        marketRegime = {
            btc: { price: btcT ? num(btcT.last) : null, change24h: btcT ? num(btcT.percentage, 2) : null, score: btcA.score, diff5m: btcA.diff5m, diff15m: btcA.diff15m, diffSpike: btcA.diffSpike },
            eth: { price: ethT ? num(ethT.last) : null, change24h: ethT ? num(ethT.percentage, 2) : null, score: ethA.score, diff5m: ethA.diff5m, diff15m: ethA.diff15m, diffSpike: ethA.diffSpike },
            score, overall, updatedAt: Date.now()
        };

        logInfo(`[REJIM] Skor=${score} (${overall}) | BTC ${btcA.score} (5m:${btcA.diff5m}% 15m:${btcA.diff15m}% ani:${btcA.diffSpike}%) | ETH ${ethA.score} (5m:${ethA.diff5m}% 15m:${ethA.diff15m}% ani:${ethA.diffSpike}%)`);
        broadcast();
    } catch (err) { logError(`[updateMarketRegime] ${err.message}`); }
}

// ============================================================
// FUNDING SAATİ KAÇINMA
// ============================================================

function minutesToNearestFunding() {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    let best = Infinity;
    for (const h of CONFIG.FUNDING_HOURS_UTC) {
        const t = h * 60;
        let diff = Math.abs(nowMin - t);
        diff = Math.min(diff, 1440 - diff);
        if (diff < best) best = diff;
    }
    return best;
}
function isFundingBlackout() { return minutesToNearestFunding() <= CONFIG.FUNDING_AVOID_MINUTES; }

// ============================================================
// SEVİYE TESPİTİ (Setup A ve C için ortak)
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
        if (isHigh) highs.push(h);
        if (isLow) lows.push(l);
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
// KATMAN 2 — SETUP DEDEKTÖRLERİ (öncelik sırasıyla denenir)
// ============================================================

// Setup A: Likidite Avı + Dönüş — fiyat bir seviyeyi fitille kırıp geri
// içeri kapanıyorsa (stop avlama), ters yönde gir. Düz kırılımdan daha
// güvenilir kabul edilir çünkü zayıf elleri temizleyip gerçek yönü gösterir.
function detectLiquiditySweep(symbol, candles, levels, atrVal, volumeRatio) {
    const last = candles[candles.length - 1];
    const low = Number(last[3]), high = Number(last[2]), close = Number(last[4]);
    const wickBuf = CONFIG.SWEEP_WICK_MIN_ATR * atrVal;
    const closeBackBuf = CONFIG.SWEEP_CLOSE_BACK_BUFFER_ATR * atrVal;

    if (volumeRatio < CONFIG.SWEEP_VOLUME_MULT) return null;

    const sup = levels.supports.find(s => low < s.price - wickBuf && close > s.price + closeBackBuf);
    if (sup) {
        return {
            direction: 'LONG',
            stopBasis: () => low - closeBackBuf,
            meta: { setupType: 'LIKIDITE_AVI', level: sup.price, levelStrength: sup.count, wickAtr: num((sup.price - low) / atrVal, 2) }
        };
    }

    const res = levels.resistances.find(r => high > r.price + wickBuf && close < r.price - closeBackBuf);
    if (res) {
        return {
            direction: 'SHORT',
            stopBasis: () => high + closeBackBuf,
            meta: { setupType: 'LIKIDITE_AVI', level: res.price, levelStrength: res.count, wickAtr: num((high - res.price) / atrVal, 2) }
        };
    }
    return null;
}

// Setup B: Trend Devamı (Pullback) — mikro trend (5m EMA9/21) yönlüyken
// fiyat EMA9'a geri çekilip dönüş mumu veriyorsa, trend yönünde devam gir.
function detectPullback(symbol, candles, atrVal, volumeRatio) {
    const closes = candles.map(c => Number(c[4]));
    const ema9 = ema(closes, CONFIG.MICRO_EMA_FAST);
    const ema21 = ema(closes, CONFIG.MICRO_EMA_SLOW);
    if (!ema9 || !ema21) return null;

    const diffPct = (ema9 - ema21) / ema21 * 100;
    const last = candles[candles.length - 1];
    const open = Number(last[1]), high = Number(last[2]), low = Number(last[3]), close = Number(last[4]);
    const bodyRatio = Math.abs(close - open) / atrVal;
    if (bodyRatio < CONFIG.PULLBACK_MIN_BODY_ATR) return null;

    const distToEma9 = Math.abs(close - ema9) / atrVal;
    if (distToEma9 > CONFIG.PULLBACK_MAX_DIST_ATR) return null;

    const nearBuf = atrVal * 0.15;
    if (diffPct > CONFIG.PULLBACK_MIN_TREND_DIFF_PCT && close > open && low <= ema9 + nearBuf) {
        return {
            direction: 'LONG',
            stopBasis: () => Math.min(low, ema9) - CONFIG.SWEEP_CLOSE_BACK_BUFFER_ATR * atrVal,
            meta: { setupType: 'PULLBACK', level: ema9, levelStrength: null, microTrendDiffPct: num(diffPct, 3) }
        };
    }
    if (diffPct < -CONFIG.PULLBACK_MIN_TREND_DIFF_PCT && close < open && high >= ema9 - nearBuf) {
        return {
            direction: 'SHORT',
            stopBasis: () => Math.max(high, ema9) + CONFIG.SWEEP_CLOSE_BACK_BUFFER_ATR * atrVal,
            meta: { setupType: 'PULLBACK', level: ema9, levelStrength: null, microTrendDiffPct: num(diffPct, 3) }
        };
    }
    return null;
}

// Setup C: Klasik Kırılım — en düşük öncelik, çünkü scalp'te sahte kırılım riski yüksek.
function detectBreakout(symbol, candles, levels, atrVal, volumeRatio) {
    if (volumeRatio < CONFIG.BREAKOUT_VOLUME_MULT) return null;
    const priorCandles = candles.slice(0, -1);
    const prevClose = Number(priorCandles[priorCandles.length - 1][4]);
    const last = candles[candles.length - 1];
    const open = Number(last[1]), close = Number(last[4]);
    const bodyRatio = Math.abs(close - open) / atrVal;
    if (bodyRatio < CONFIG.BREAKOUT_MIN_BODY_ATR) return null;
    const buf = atrVal * CONFIG.BREAKOUT_BUFFER_ATR;

    const res = levels.resistances.filter(r => prevClose <= r.price && close > r.price + buf).sort((a, b) => b.price - a.price)[0];
    if (res && close > open) {
        return {
            direction: 'LONG',
            stopBasis: () => res.price - CONFIG.STOP_STRUCT_BUFFER_ATR_DEFAULT * atrVal,
            meta: { setupType: 'KIRILIM', level: res.price, levelStrength: res.count }
        };
    }
    const sup = levels.supports.filter(s => prevClose >= s.price && close < s.price - buf).sort((a, b) => a.price - b.price)[0];
    if (sup && close < open) {
        return {
            direction: 'SHORT',
            stopBasis: () => sup.price + CONFIG.STOP_STRUCT_BUFFER_ATR_DEFAULT * atrVal,
            meta: { setupType: 'KIRILIM', level: sup.price, levelStrength: sup.count }
        };
    }
    return null;
}

// ============================================================
// KALİTE SKORU
// ============================================================

function calculateQuality(p) {
    let score = 0;
    const long = p.direction === 'LONG';

    if (p.setupType === 'LIKIDITE_AVI') score += 25;
    else if (p.setupType === 'PULLBACK') score += 20;
    else score += 12;

    const aligned = long ? p.regimeScore : -p.regimeScore;
    score += clamp(aligned, -10, 10) * 1.5;

    const want = long ? 'BULLISH' : 'BEARISH';
    if (p.trend15m === want) score += 12;
    if (p.trend1h === want) score += 8;

    if (p.volumeRatio >= 3) score += 15;
    else if (p.volumeRatio >= 2) score += 10;
    else if (p.volumeRatio >= 1.5) score += 5;

    if (p.levelStrength != null) {
        if (p.levelStrength >= 5) score += 10;
        else if (p.levelStrength >= 3) score += 6;
        else score += 3;
    } else {
        score += 4;
    }

    if (p.rsiValue != null) {
        const distFromMid = Math.abs(p.rsiValue - 50);
        if (distFromMid <= 15) score += 8;
        else if (distFromMid <= 22) score += 4;
    }

    if (p.extensionATR <= 0.4) score += 8;
    else if (p.extensionATR <= 0.8) score += 4;

    if (p.spreadPct != null && p.atrPct > 0) {
        const spreadRatio = p.spreadPct / p.atrPct;
        if (spreadRatio <= 0.08) score += 5;
        else if (spreadRatio <= 0.15) score += 2;
    }

    return { score: Math.round(clamp(score, 0, 100)), breakdown: [] };
}

// ============================================================
// KATMAN 3 — RİSK: pozisyon boyutlama
// ============================================================

function computePositionSize(entry, stop) {
    const riskDistance = Math.abs(entry - stop);
    if (!(riskDistance > 0)) return null;
    const riskDistancePct = riskDistance / entry * 100;
    if (riskDistancePct > CONFIG.MAX_RISK_DISTANCE_PCT) return null;
    const riskAmountUSDT = CONFIG.ACCOUNT_EQUITY_USDT * CONFIG.RISK_PER_TRADE_PCT / 100;
    const qty = riskAmountUSDT / riskDistance;
    const notionalUSDT = qty * entry;
    return {
        riskAmountUSDT: num(riskAmountUSDT, 2),
        riskDistancePct: num(riskDistancePct, 3),
        qty: num(qty, 6),
        notionalUSDT: num(notionalUSDT, 2)
    };
}

// ============================================================
// DAVRANIŞSAL RİSK KORUMASI (ardışık kayıp + günlük limit)
// ============================================================

function checkDailyReset() {
    if (Date.now() >= dailyResetAt) {
        dailyR = 0;
        dailyResetAt = nextUtcMidnight();
        logInfo('Günlük R sıfırlandı.');
        markDirty();
    }
}

function isTradingPaused() {
    checkDailyReset();
    if (Date.now() < lossCooldownUntil) return `Ardışık kayıp soğuması (${Math.ceil((lossCooldownUntil - Date.now()) / 60000)} dk kaldı)`;
    if (dailyR <= CONFIG.DAILY_LOSS_LIMIT_R) return `Günlük zarar limiti doldu (${dailyR}R)`;
    return null;
}

// ============================================================
// KATMAN 5 — GÖLGE TAKİP (reddedilen setup'lar kazanır mıydı?)
// ============================================================

function addShadowCandidate(symbol, direction, entry, stop, tp1, setupType, qualityScore, reason) {
    shadowWatch.push({ symbol, direction, entry, stop, tp1, setupType, qualityScore, reason, createdAt: Date.now() });
    if (shadowWatch.length > CONFIG.MAX_SHADOW_KEPT) shadowWatch.shift();
}

async function evaluateShadowCandidates() {
    const now = Date.now();
    const due = shadowWatch.filter(c => now - c.createdAt >= CONFIG.SHADOW_EVAL_AFTER_MS);
    if (!due.length) return;
    shadowWatch = shadowWatch.filter(c => now - c.createdAt < CONFIG.SHADOW_EVAL_AFTER_MS);

    const symbols = Array.from(new Set(due.map(c => c.symbol)));
    let tickers = {};
    try { tickers = await exchange.fetchTickers(symbols); } catch { return; }

    for (const c of due) {
        const t = tickers[c.symbol];
        const price = t ? Number(t.last) : null;
        if (!Number.isFinite(price)) continue;
        const risk = Math.abs(c.entry - c.stop);
        const r = risk ? ((c.direction === 'LONG' ? price - c.entry : c.entry - price) / risk) : 0;
        shadowHistory.unshift({ ...c, evaluatedAt: now, resultR: num(r, 2), wouldWin: r > 0 });
    }
    shadowHistory = shadowHistory.slice(0, CONFIG.MAX_SHADOW_KEPT);
    markDirty();
}

function shadowStats() {
    if (!shadowHistory.length) return { count: 0 };
    const wins = shadowHistory.filter(s => s.wouldWin).length;
    return {
        count: shadowHistory.length,
        wouldWinRate: num(wins / shadowHistory.length * 100, 1),
        avgR: num(shadowHistory.reduce((a, s) => a + (s.resultR || 0), 0) / shadowHistory.length, 2)
    };
}

// ============================================================
// ANA TARAMA
// ============================================================

async function scanForSignal(symbol) {
    DEBUG.scanned++;
    try {
        if (isExcluded(symbol)) return null;
        if (signals.some(s => s.symbol === symbol && isOpen(s))) { DEBUG.rejectedOpen++; return null; }

        const raw = await exchange.fetchOHLCV(symbol, CONFIG.SCAN_TIMEFRAME, undefined, CONFIG.CANDLE_LIMIT);
        const candles = closedCandles(raw);
        if (candles.length < CONFIG.LEVEL_LOOKBACK + 10) return null;

        const last = candles[candles.length - 1];
        const closeTime = Number(last[0]) + CONFIG.SCAN_TF_MS;
        if (Date.now() - closeTime > CONFIG.ENTRY_MAX_AGE_MS) { DEBUG.rejectedStale++; return null; }

        const open = Number(last[1]), high = Number(last[2]), low = Number(last[3]), close = Number(last[4]);
        const volume = Number(last[5]);
        if (![open, high, low, close, volume].every(Number.isFinite)) return null;

        const priorCandles = candles.slice(0, -1);
        const closes = candles.map(c => Number(c[4]));
        const volumes = priorCandles.slice(-20).map(c => Number(c[5])).filter(Number.isFinite);
        const avgVolume = sma(volumes, Math.min(20, volumes.length));
        if (!avgVolume) return null;
        const volumeRatio = volume / avgVolume;

        const currentATR = atr(priorCandles, CONFIG.ATR_PERIOD);
        if (!currentATR || currentATR <= 0) return null;

        const atrPct = currentATR / close * 100;
        if (atrPct < CONFIG.MIN_ATR_PCT) { DEBUG.rejectedFlat++; return null; }

        const rsiValue = rsi(closes, CONFIG.RSI_PERIOD);
        const levels = findLevels(priorCandles);

        const setup =
            detectLiquiditySweep(symbol, candles, levels, currentATR, volumeRatio) ||
            detectPullback(symbol, candles, currentATR, volumeRatio) ||
            detectBreakout(symbol, candles, levels, currentATR, volumeRatio);

        if (!setup) return null;
        DEBUG.setupsFound++;

        const { direction, stopBasis, meta } = setup;

        if (direction === 'LONG' && rsiValue != null && rsiValue > CONFIG.RSI_OVERBOUGHT) { DEBUG.rejectedRSI++; return null; }
        if (direction === 'SHORT' && rsiValue != null && rsiValue < CONFIG.RSI_OVERSOLD) { DEBUG.rejectedRSI++; return null; }

        const key = `${symbol}_${direction}`;
        if (Date.now() - (lastSignalTime.get(key) || 0) < CONFIG.SIGNAL_COOLDOWN_MS) { DEBUG.rejectedCooldown++; return null; }

        // Piyasa rejimi: sadece aşırı ters rejimde tamamen engelle (dead-zone sorunu yok)
        if (direction === 'LONG' && marketRegime.score <= -CONFIG.MARKET_REGIME_EXTREME_BLOCK) { DEBUG.rejectedRegime++; return null; }
        if (direction === 'SHORT' && marketRegime.score >= CONFIG.MARKET_REGIME_EXTREME_BLOCK) { DEBUG.rejectedRegime++; return null; }

        if (isFundingBlackout()) { DEBUG.rejectedFunding++; return null; }

        const trend = await getTrendContext(symbol);

        let entry = close, spreadPct = null;
        try {
            const t = await exchange.fetchTicker(symbol);
            const p = Number(t && t.last);
            if (Number.isFinite(p) && p > 0) entry = p;
            if (t && Number.isFinite(t.bid) && Number.isFinite(t.ask) && t.bid > 0) {
                spreadPct = (t.ask - t.bid) / ((t.ask + t.bid) / 2) * 100;
            }
        } catch {}

        if (spreadPct != null && spreadPct > atrPct * CONFIG.MAX_SPREAD_ATR_RATIO) { DEBUG.rejectedSpread++; return null; }

        const extNow = meta.level != null ? Math.abs(entry - meta.level) / currentATR : 0;
        if (meta.level != null && extNow > CONFIG.MAX_EXTENSION_ATR) { DEBUG.rejectedExtension++; return null; }

        const stop = stopBasis(entry);
        const risk = direction === 'LONG' ? entry - stop : stop - entry;
        if (!(risk > 0)) return null;

        const sizing = computePositionSize(entry, stop);
        if (!sizing) { DEBUG.rejectedRisk++; return null; }

        const tp1 = direction === 'LONG' ? entry + risk * CONFIG.TP1_RR : entry - risk * CONFIG.TP1_RR;

        const quality = calculateQuality({
            setupType: meta.setupType, direction, trend15m: trend.trend15m, trend1h: trend.trend1h,
            volumeRatio, rsiValue, levelStrength: meta.levelStrength, extensionATR: extNow,
            regimeScore: marketRegime.score, spreadPct, atrPct
        });

        if (quality.score < CONFIG.MIN_QUALITY_SCORE) {
            DEBUG.rejectedQuality++;
            addShadowCandidate(symbol, direction, entry, stop, tp1, meta.setupType, quality.score, 'kalite');
            return null;
        }

        lastSignalTime.set(key, Date.now());
        DEBUG.signals++;
        if (direction === 'LONG') DEBUG.long++; else DEBUG.short++;

        const now = Date.now();
        const sig = {
            id: `${symbol.replace(/[^A-Z0-9]/gi, '')}_${direction}_${now}`,
            symbol, symbolTV: symbol.replace('/USDT:USDT', 'USDT.P'),
            direction, setupType: meta.setupType, timeframe: CONFIG.SCAN_TIMEFRAME,
            entry: num(entry), currentPrice: num(entry), pnlPct: 0,
            stop: num(stop), initialStop: num(stop), trailStop: num(stop),
            tp1: num(tp1), tp1Hit: false,
            resultR: null, grossR: null,
            level: meta.level != null ? num(meta.level) : null,
            levelStrength: meta.levelStrength != null ? meta.levelStrength : null,
            volumeRatio: num(volumeRatio, 2), rsi: num(rsiValue, 1), atr: num(currentATR),
            atrPct: num(atrPct, 3), extensionATR: num(extNow, 2),
            spreadPct: spreadPct != null ? num(spreadPct, 4) : null,
            trend15m: trend.trend15m, trend1h: trend.trend1h, regimeScore: marketRegime.score,
            qualityScore: quality.score,
            sizing,
            status: 'ACTIVE', closeReason: null,
            candles: candles.slice(-60).map(c => ({ t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]) })),
            timestamp: now, updatedAt: now, wickCheckedAt: now,
            maxHoldUntil: now + CONFIG.MAX_HOLD_MS
        };

        logInfo(`🎯 SETUP ${meta.setupType} ${direction} | ${symbol} | Q${quality.score} | Giriş ${num(entry)} Stop ${num(stop)} | Risk% ${num(sizing.riskDistancePct, 2)} | Hacim ${num(volumeRatio, 1)}x`);
        return sig;
    } catch (err) {
        DEBUG.errors++; DEBUG.totalErrors++;
        return null;
    }
}

// ============================================================
// SİNYAL TAKİBİ (trailing stop + sert süre limiti)
// ============================================================

function currentR(sig, price) {
    const risk = Math.abs(Number(sig.entry) - Number(sig.initialStop));
    if (!risk) return 0;
    return (sig.direction === 'LONG' ? price - Number(sig.entry) : Number(sig.entry) - price) / risk;
}
function netR(grossR) { return grossR - CONFIG.TRADE_COST_R; }

function updateTrailingStop(sig, price) {
    const trailDist = CONFIG.TRAIL_ATR_MULT * Number(sig.atr);
    if (sig.direction === 'LONG') {
        const candidate = price - trailDist;
        if (candidate > Number(sig.trailStop)) sig.trailStop = num(candidate);
    } else {
        const candidate = price + trailDist;
        if (candidate < Number(sig.trailStop)) sig.trailStop = num(candidate);
    }
}

function finalizeSignal(sig, status, reason, now, price) {
    const cr = currentR(sig, price);
    const grossR = status === 'STOP' ? -1 : (sig.tp1Hit ? CONFIG.TP1_CLOSE_FRACTION * CONFIG.TP1_RR + (1 - CONFIG.TP1_CLOSE_FRACTION) * cr : cr);
    const r = netR(grossR);

    sig.resultR = num(r, 2);
    sig.grossR = num(grossR, 2);
    sig.status = status;
    sig.closeReason = reason;
    sig.closedAt = now;
    sig.updatedAt = now;

    dailyR = num(dailyR + r, 2);
    if (r < 0) {
        lossStreak++;
        if (lossStreak >= CONFIG.CONSECUTIVE_LOSS_LIMIT) {
            lossCooldownUntil = Date.now() + CONFIG.LOSS_COOLDOWN_MS;
            logInfo(`⚠️ ${lossStreak} ardışık kayıp — ${Math.round(CONFIG.LOSS_COOLDOWN_MS / 60000)} dk soğumaya giriliyor.`);
        }
    } else {
        lossStreak = 0;
    }

    history.unshift({
        id: sig.id, symbol: sig.symbol, direction: sig.direction, setupType: sig.setupType, status,
        resultR: sig.resultR, grossR: sig.grossR,
        entry: sig.entry, stop: sig.initialStop, tp1: sig.tp1, level: sig.level,
        levelStrength: sig.levelStrength, qualityScore: sig.qualityScore, volumeRatio: sig.volumeRatio,
        rsi: sig.rsi, extensionATR: sig.extensionATR, regimeScore: sig.regimeScore,
        openedAt: sig.timestamp, closedAt: now
    });
    history = history.slice(0, CONFIG.MAX_HISTORY_KEPT);

    if (status === 'STOP' && !sig.tp1Hit) {
        signals = signals.filter(s => s !== sig);
        escapedSignals.unshift(sig);
        escapedSignals = escapedSignals.slice(0, CONFIG.MAX_ESCAPED_KEPT);
    }

    const nm = sig.symbol.replace(':USDT', '');
    const rTxt = sig.resultR >= 0 ? `+${sig.resultR}R` : `${sig.resultR}R`;
    const icon = sig.resultR > 0 ? '🎉' : status === 'STOP' ? '✗' : 'ℹ️';
    notify(`${icon} ${nm} ${sig.direction} kapandı: ${reason} (${rTxt})`);
    markDirty();
}

function applyPriceWindow(sig, high, low, open, close, now) {
    if (!isOpen(sig)) return false;
    const L = sig.direction === 'LONG';

    if (now > sig.maxHoldUntil) {
        finalizeSignal(sig, 'TIME_EXIT', 'Süre doldu (sert limit)', now, Number(sig.currentPrice) || Number(sig.entry));
        return true;
    }

    const o = Number.isFinite(open) ? open : (L ? low : high);
    const c = Number.isFinite(close) ? close : (L ? high : low);
    const upBar = c >= o;
    const firstPrice = upBar ? low : high;
    const secondPrice = upBar ? high : low;

    const activeStop = () => sig.tp1Hit ? Number(sig.trailStop) : Number(sig.stop);
    const hitStop = p => L ? p <= activeStop() : p >= activeStop();
    const hitTp1 = p => L ? p >= Number(sig.tp1) : p <= Number(sig.tp1);

    if (hitStop(firstPrice)) {
        finalizeSignal(sig, sig.tp1Hit ? 'TRAIL_STOP' : 'STOP', sig.tp1Hit ? 'Trailing stop' : 'İlk stop', now, Number(sig.currentPrice) || activeStop());
        return true;
    }

    let changed = false;
    if (!sig.tp1Hit && hitTp1(firstPrice)) {
        sig.tp1Hit = true;
        sig.status = 'TP1_HIT';
        sig.trailStop = sig.entry;
        sig.tp1At = now;
        sig.updatedAt = now;
        changed = true;
        notify(`💰 ${sig.symbol.replace(':USDT', '')} ${sig.direction} TP1 vurdu — yarısını sat, trailing stop devrede`);
        markDirty();
    }

    if (sig.tp1Hit) {
        updateTrailingStop(sig, secondPrice);
        if (hitStop(secondPrice)) {
            finalizeSignal(sig, 'TRAIL_STOP', 'Trailing stop (mum içi)', now, Number(sig.currentPrice) || activeStop());
            return true;
        }
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
                if (applyPriceWindow(sig, price, price, price, price, now)) changed = true;
                changed = true;
            }

            if (isOpen(sig) && now - (sig.wickCheckedAt || sig.timestamp) >= CONFIG.WICK_CHECK_MS) {
                try {
                    const since = (sig.wickCheckedAt || sig.timestamp) - 60 * 1000;
                    const raw = await exchange.fetchOHLCV(sig.symbol, '1m', since, 60);
                    for (const c of raw || []) {
                        if (!isOpen(sig)) break;
                        if (Number(c[0]) < sig.timestamp) continue;
                        if (applyPriceWindow(sig, Number(c[2]), Number(c[3]), Number(c[1]), Number(c[4]), now)) changed = true;
                    }
                    sig.wickCheckedAt = now;
                } catch {}
            }
        }
        if (changed) { markDirty(); broadcast(); }
    } catch (err) {
        // sessiz geç
    } finally {
        liveRunning = false;
    }
}

// ============================================================
// PRESCAN + TARAMA DÖNGÜSÜ
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
            if (Number.isFinite(v) && v >= CONFIG.MIN_24H_VOLUME_USDT) list.push({ symbol: t.symbol, volume: v });
        }
        list.sort((a, b) => b.volume - a.volume);
        const newTargets = list.slice(0, CONFIG.MAX_TARGETS).map(i => i.symbol);

        const newSet = new Set(newTargets);
        for (const k of trendCache.keys()) if (!newSet.has(k)) trendCache.delete(k);

        targets = newTargets;
        lastPrescanAt = Date.now();
        logInfo(`RADAR | ${targets.length} coin`);
    } catch (err) { logError(`[runPreScan] ${err.message}`); }
}

async function runScan() {
    if (scanRunning || isShuttingDown) return;

    const pauseReason = isTradingPaused();
    if (pauseReason) {
        APP_STATE.scanStatus = { message: `Duraklatıldı: ${pauseReason}`, isScanning: false };
        broadcast();
        return;
    }
    if (isFundingBlackout()) {
        APP_STATE.scanStatus = { message: 'Funding saatine yakın — yeni giriş açılmıyor', isScanning: false };
        broadcast();
        return;
    }

    scanRunning = true;
    for (const k of Object.keys(DEBUG)) if (k !== 'totalErrors') DEBUG[k] = 0;
    APP_STATE.scanStatus = { message: `Tarama: ${targets.length} coin`, isScanning: true };
    broadcast();

    let newSignals = 0, idx = 0;

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

    logInfo(`[TARAMA] Tarandı=${DEBUG.scanned} | SetupBulundu=${DEBUG.setupsFound} | Yeni=${newSignals} | L/S=${DEBUG.long}/${DEBUG.short} | Rejim=${marketRegime.score} | Açık=${DEBUG.rejectedOpen} Bayat=${DEBUG.rejectedStale} Durgun=${DEBUG.rejectedFlat} RSI=${DEBUG.rejectedRSI} Cooldown=${DEBUG.rejectedCooldown} Rejim=${DEBUG.rejectedRegime} Funding=${DEBUG.rejectedFunding} Spread=${DEBUG.rejectedSpread} Uzama=${DEBUG.rejectedExtension} Risk=${DEBUG.rejectedRisk} Kalite=${DEBUG.rejectedQuality} Hata=${DEBUG.errors}`);
}

// ============================================================
// API + WS
// ============================================================

function perfStats() {
    const closed = history.length;
    const wins = history.filter(x => Number(x.resultR) > 0).length;
    const totalR = history.reduce((a, x) => a + (Number(x.resultR) || 0), 0);
    const bySetup = {};
    for (const s of ['LIKIDITE_AVI', 'PULLBACK', 'KIRILIM']) {
        const trades = history.filter(x => x.setupType === s);
        const w = trades.filter(x => Number(x.resultR) > 0).length;
        bySetup[s] = {
            count: trades.length, wins: w,
            winRate: trades.length ? num(w / trades.length * 100, 1) : null,
            totalR: num(trades.reduce((a, x) => a + (Number(x.resultR) || 0), 0), 2)
        };
    }
    return {
        closed, wins, losses: closed - wins,
        winRate: closed ? num(wins / closed * 100, 1) : null,
        totalR: num(totalR, 2), tradeCostR: CONFIG.TRADE_COST_R,
        bySetup
    };
}

function riskState() {
    return { lossStreak, dailyR, cooldownUntil: lossCooldownUntil, pauseReason: isTradingPaused() };
}

function snapshot() {
    APP_STATE.updatedAt = Date.now();
    const active = signals.filter(isOpen);
    return {
        success: true,
        signals: signals.slice(0, 100),
        escaped: escapedSignals.slice(0, 50),
        marketRegime,
        scanStatus: APP_STATE.scanStatus,
        perf: perfStats(),
        shadow: shadowStats(),
        risk: riskState(),
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

wss.on('connection', sock => { sock.send(JSON.stringify({ type: 'snapshot', data: snapshot() })); });

function requireAdmin(req, res, next) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return res.status(403).json({ success: false, error: 'ADMIN_TOKEN tanımlı değil; işlem kapalı' });
    const given = req.get('x-admin-token') || req.query.token;
    if (given !== token) return res.status(401).json({ success: false, error: 'yetkisiz' });
    next();
}

app.get('/api/signals', (req, res) => res.json(snapshot()));
app.get('/api/regime', (req, res) => res.json({ success: true, marketRegime }));
app.get('/api/stats', (req, res) => res.json({ success: true, perf: perfStats(), shadow: shadowStats(), risk: riskState() }));
app.get('/api/history', (req, res) => res.json({ success: true, history }));
app.get('/api/shadow', (req, res) => res.json({ success: true, shadow: shadowHistory.slice(0, 100), stats: shadowStats() }));
app.get('/api/health', (req, res) => res.json({
    ok: true, targets: targets.length, signals: signals.length,
    lastScanAt, lastPrescanAt, regimeUpdatedAt: marketRegime.updatedAt,
    totalErrors: DEBUG.totalErrors, version: 'scalp-engine-v1.0'
}));
app.delete('/api/signals', requireAdmin, (req, res) => { signals = []; markDirty(); broadcast(); res.json({ success: true }); });
app.delete('/api/escaped', requireAdmin, (req, res) => { escapedSignals = []; markDirty(); broadcast(); res.json({ success: true }); });
app.delete('/api/shadow', requireAdmin, (req, res) => { shadowHistory = []; markDirty(); broadcast(); res.json({ success: true }); });
app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// FRONTEND
// ============================================================

const HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SCALP ENGINE v1.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e14;color:#e9eef5;font-family:-apple-system,Arial,sans-serif;font-size:13px;line-height:1.4;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;width:100vw}
.pause-banner{background:#3a1414;color:#ff8a8a;padding:6px 16px;font-size:12px;font-weight:700;text-align:center;display:none}
.pause-banner.show{display:block}
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
.market-item .score{padding:1px 5px;border-radius:3px;font-weight:800;font-size:10px;background:#1c2634}
.market-item .score.pos{background:rgba(0,255,157,0.2);color:#00ff9d}
.market-item .score.neg{background:rgba(255,56,96,0.2);color:#ff3860}
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
.status-badge.stopped{background:#ff3860;color:#fff}
.status-badge.trail{background:#8a5cff;color:#fff}
.status-badge.timeexit{background:#5e6b7c;color:#fff}
.status-badge.fakeout{background:#8b97a5;color:#0a0e14}
.setup-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.setup-badge.sweep{background:rgba(0,255,157,0.15);color:#00ff9d;border:1px solid rgba(0,255,157,0.4)}
.setup-badge.pullback{background:rgba(41,98,255,0.15);color:#4a7cff;border:1px solid rgba(41,98,255,0.4)}
.setup-badge.breakout{background:rgba(246,196,83,0.15);color:#f6c453;border:1px solid rgba(246,196,83,0.4)}
.trend-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.trend-badge.bullish{background:rgba(0,255,157,0.2);color:#00ff9d}
.trend-badge.bearish{background:rgba(255,56,96,0.2);color:#ff3860}
.trend-badge.sideways{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge{display:inline-block;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px}
.quality-badge.high{background:rgba(0,255,157,0.2);color:#00ff9d}
.quality-badge.med{background:rgba(246,196,83,0.2);color:#f6c453}
.quality-badge.low{background:rgba(139,151,165,0.2);color:#8b97a5}
.sig-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.sig-sym{font-size:16px;font-weight:900}
.levels-grid{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px}
.level-item{display:flex;justify-content:space-between;padding:5px 8px;background:#0a0e14;border-radius:4px}
.level-item .k{color:#5e6b7c}
.level-item .v{font-weight:700;color:#c5cfdd}
.level-item.entry .v{color:#4a7cff}
.level-item.stop .v{color:#ff3860}
.level-item.tp1 .v{color:#00ff9d}
.level-item.trail .v{color:#8a5cff}
.sig-price{margin-top:10px;display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #1c2634}
.sig-price .cur{font-weight:700;font-size:15px}
.sig-price .pnl{padding:3px 8px;border-radius:4px;font-weight:800;font-size:12px}
.sig-price .pnl.pos{background:rgba(0,255,157,0.15);color:#00ff9d}
.sig-price .pnl.neg{background:rgba(255,56,96,0.15);color:#ff3860}
.sig-meta{margin-top:8px;font-size:10px;color:#5e6b7c;display:flex;gap:10px;flex-wrap:wrap}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0a0e14}
.main-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#5e6b7c;font-size:13px;flex-direction:column;gap:10px}
.main-empty-icon{font-size:40px;opacity:0.3}
.chart-head{padding:12px 16px;border-bottom:1px solid #1c2634;display:flex;justify-content:space-between;align-items:center;background:#0d1219;flex-wrap:wrap;gap:10px}
.chart-sym{font-size:20px;font-weight:900}
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
<div class="pause-banner" id="pauseBanner"></div>
<div class="market-bar">
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<div class="market-brand">SCALP <span>ENGINE</span> <span class="market-badge">v1.0</span></div>
<div class="market-item"><span class="sym">BTC</span><span class="price" id="btcPrice">-</span><span class="chg" id="btcChg">-</span><span class="score" id="btcScore">0</span></div>
<div class="market-item"><span class="sym">ETH</span><span class="price" id="ethPrice">-</span><span class="chg" id="ethChg">-</span><span class="score" id="ethScore">0</span></div>
<div class="market-item" id="perfBox"><span class="sym">SONUÇ</span><span class="price" id="perfTxt">-</span></div>
<div class="market-item"><span class="sym">GÖLGE</span><span class="price" id="shadowTxt">-</span></div>
<div class="market-item"><span class="sym">GÜNLÜK</span><span class="price" id="dailyTxt">-</span></div>
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
<div id="chartSetup"></div>
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
<div class="chart-info-item"><div class="chart-info-lbl">Trailing</div><div class="chart-info-val" style="color:#8a5cff" id="infoTrail">-</div></div>
<div class="chart-info-item"><div class="chart-info-lbl">Miktar</div><div class="chart-info-val" style="color:#f6c453" id="infoQty">-</div></div>
</div>
</div>
</div>
</div>
</div>
<script>
var signals=[];var escaped=[];var selectedId=null;var currentTab='signals';var ws=null;var lastActiveCount=0;var audioCtx=null;var reconnectTimer=null;var pollTimer=null;
function isOpenS(s){return s.status==='ACTIVE'||s.status==='TP1_HIT';}
function fmt(v){v=Number(v);if(!Number.isFinite(v))return'-';if(v>=1000)return v.toFixed(2);if(v>=100)return v.toFixed(3);if(v>=1)return v.toFixed(4);return v.toFixed(6);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function timeAgo(ts){if(!ts)return'-';var d=Date.now()-ts;var m=Math.floor(d/60000);if(m<1)return'az önce';if(m<60)return m+' dk';var h=Math.floor(m/60);return h+' sa';}
function playSound(){try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator();var g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=880;g.gain.setValueAtTime(0.15,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.4);o.start();o.stop(audioCtx.currentTime+0.4);}catch(e){}}
function setConnStatus(s,t){var el=document.getElementById('connStatus');el.className='conn-status '+s;el.textContent=t;}
function renderPerf(p,shadow,risk){
var el=document.getElementById('perfTxt');
if(!p||!p.closed){el.textContent='-';}else{el.textContent=p.wins+'K / '+p.losses+'Z • '+(p.totalR>=0?'+':'')+p.totalR+'R';}
var sh=document.getElementById('shadowTxt');
if(!shadow||!shadow.count){sh.textContent='-';}else{sh.textContent=shadow.wouldWinRate+'% (n='+shadow.count+')';}
var dl=document.getElementById('dailyTxt');
if(risk){dl.textContent=(risk.dailyR>=0?'+':'')+risk.dailyR+'R';dl.parentElement.querySelector('.price').style.color=risk.dailyR<0?'#ff3860':'#00ff9d';}
var pb=document.getElementById('pauseBanner');
if(risk&&risk.pauseReason){pb.textContent='⏸ TARAMA DURAKLATILDI: '+risk.pauseReason;pb.className='pause-banner show';}else{pb.className='pause-banner';}
}
function renderMarketBar(ms){if(!ms||!ms.btc||!ms.eth)return;
document.getElementById('btcPrice').textContent=fmt(ms.btc.price);
var bc=document.getElementById('btcChg');if(ms.btc.change24h!=null){bc.textContent=(ms.btc.change24h>=0?'+':'')+ms.btc.change24h+'%';bc.className='chg '+(ms.btc.change24h>=0?'up':'down');}
var bs=document.getElementById('btcScore');bs.textContent=(ms.btc.score>=0?'+':'')+ms.btc.score;bs.className='score '+(ms.btc.score>0?'pos':ms.btc.score<0?'neg':'');
document.getElementById('ethPrice').textContent=fmt(ms.eth.price);
var ec=document.getElementById('ethChg');if(ms.eth.change24h!=null){ec.textContent=(ms.eth.change24h>=0?'+':'')+ms.eth.change24h+'%';ec.className='chg '+(ms.eth.change24h>=0?'up':'down');}
var es=document.getElementById('ethScore');es.textContent=(ms.eth.score>=0?'+':'')+ms.eth.score;es.className='score '+(ms.eth.score>0?'pos':ms.eth.score<0?'neg':'');
var o=document.getElementById('marketOverall');var l=ms.overall||'NÖTR',c='mixed';
if(l.indexOf('BOĞA')>=0)c='bullish';else if(l.indexOf('AYI')>=0)c='bearish';
o.textContent=l+' (Skor: '+ms.score+')';o.className='market-overall '+c;}
function statusBadge(s){if(s.status==='ACTIVE')return'<span class="status-badge active">● AKTİF</span>';if(s.status==='TP1_HIT')return'<span class="status-badge tp1">✓ TP1 • AÇIK</span>';if(s.status==='TRAIL_STOP')return'<span class="status-badge trail">↗ TRAILING KAPANDI</span>';if(s.status==='STOP')return'<span class="status-badge stopped">✗ STOP</span>';if(s.status==='TIME_EXIT')return'<span class="status-badge timeexit">⏱ SÜRE</span>';return'';}
function qClass(q){if(q>=80)return'high';if(q>=65)return'med';return'low';}
function setupBadge(t){if(t==='LIKIDITE_AVI')return'<span class="setup-badge sweep">🎯 LİKİDİTE AVI</span>';if(t==='PULLBACK')return'<span class="setup-badge pullback">📈 PULLBACK</span>';return'<span class="setup-badge breakout">🚀 KIRILIM</span>';}
function trendBadge(t,label){if(t==='BULLISH')return'<span class="trend-badge bullish">'+label+' ⬆</span>';if(t==='BEARISH')return'<span class="trend-badge bearish">'+label+' ⬇</span>';return'<span class="trend-badge sideways">'+label+' ⬌</span>';}
function renderCard(s,fakeout){var dc=s.direction==='LONG'?'long':'short';var sel=s.id===selectedId?'selected':'';var cl=(!isOpenS(s))?'closed':'';var fo=fakeout?'fakeout':'';var pnl=(s.pnlPct||0)>=0?'pos':'neg';var pnls=(s.pnlPct||0)>=0?'+':'';var q=s.qualityScore||0;
return'<div class="sig-card '+dc+' '+sel+' '+cl+' '+fo+'" data-id="'+esc(s.id)+'">'
+'<div class="sig-row"><div class="sig-sym">'+esc(s.symbol.replace(':USDT',''))+'</div><div class="dir-badge '+dc+'">'+s.direction+'</div></div>'
+'<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:6px">'
+statusBadge(s)+setupBadge(s.setupType)+trendBadge(s.trend15m,'15m')+trendBadge(s.trend1h,'1h')
+'<span class="quality-badge '+qClass(q)+'">Q'+q+'</span>'
+'</div>'
+'<div class="levels-grid">'
+'<div class="level-item entry"><span class="k">Giriş</span><span class="v">'+fmt(s.entry)+'</span></div>'
+'<div class="level-item stop"><span class="k">Stop</span><span class="v">'+fmt(s.tp1Hit?s.trailStop:s.stop)+'</span></div>'
+'<div class="level-item tp1"><span class="k">TP1</span><span class="v">'+fmt(s.tp1)+'</span></div>'
+'<div class="level-item trail"><span class="k">Trailing</span><span class="v">'+(s.tp1Hit?fmt(s.trailStop):'-')+'</span></div>'
+'</div>'
+'<div class="sig-price"><span class="cur">'+fmt(s.currentPrice||s.entry)+'</span>'+(s.pnlPct!=null?'<span class="pnl '+pnl+'">'+pnls+s.pnlPct+'%</span>':'')+'</div>'
+'<div class="sig-meta"><span>📊 '+s.volumeRatio+'x</span><span>🎯 RSI '+s.rsi+'</span><span>💰 '+(s.sizing?s.sizing.qty:'-')+'</span><span>⏱ '+timeAgo(s.timestamp)+'</span></div>'
+'</div>';}
function renderList(){var el=document.getElementById('sideList');var st=el.scrollTop;var html='';
if(currentTab==='signals'){
var active=signals.filter(isOpenS);var closed=signals.filter(function(s){return !isOpenS(s);});
if(active.length>0)html+=active.map(function(s){return renderCard(s,false);}).join('');
if(closed.length>0){html+='<div style="padding:14px 8px 6px;font-size:10px;font-weight:800;color:#5e6b7c;letter-spacing:1px">📁 KAPANANLAR</div>';html+=closed.slice(0,20).map(function(s){return renderCard(s,false);}).join('');}
if(!html)html='<div class="empty-msg">🎯 Henüz sinyal yok.<br><br>Setup + kalite onayı<br>olunca burada görünecek.</div>';
}else{
if(escaped.length>0)html+=escaped.slice(0,30).map(function(s){return renderCard(s,true);}).join('');
else html='<div class="empty-msg">📁 Henüz kaçan sinyal yok.<br><br>TP1 görmeden stop olanlar burada listelenir.</div>';
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
document.getElementById('chartSetup').innerHTML=setupBadge(s.setupType);
document.getElementById('chartTrend').innerHTML=trendBadge(s.trend15m,'15m')+trendBadge(s.trend1h,'1h');
document.getElementById('chartQuality').innerHTML='<span class="quality-badge '+qClass(s.qualityScore)+'">Kalite '+s.qualityScore+'/100</span>';
document.getElementById('chartStatus').innerHTML=statusBadge(s);
document.getElementById('tvLink').href='https://www.tradingview.com/chart/?symbol=BITGET:'+s.symbolTV+'&interval=5';
document.getElementById('infoEntry').textContent=fmt(s.entry);
document.getElementById('infoStop').textContent=fmt(s.tp1Hit?s.trailStop:s.stop);
document.getElementById('infoTp1').textContent=fmt(s.tp1);
document.getElementById('infoTrail').textContent=s.tp1Hit?fmt(s.trailStop):'-';
document.getElementById('infoQty').textContent=s.sizing?s.sizing.qty:'-';
setTimeout(function(){drawChart(s);},30);}
function drawChart(s){var canvas=document.getElementById('mainCanvas');var parent=canvas.parentElement;var W=parent.clientWidth,H=parent.clientHeight;var dpr=window.devicePixelRatio||1;canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=s.direction==='LONG'?'#08120d':'#12080c';ctx.fillRect(0,0,W,H);
var candles=s.candles;if(!candles||!candles.length)return;var count=candles.length;
var minP=Infinity,maxP=-Infinity;for(var i=0;i<candles.length;i++){var lo=Number(candles[i].l),hi=Number(candles[i].h);if(lo<minP)minP=lo;if(hi>maxP)maxP=hi;}
[s.entry,s.initialStop,s.tp1,s.trailStop,s.currentPrice,s.level].forEach(function(v){if(v==null)return;v=Number(v);if(v<minP)minP=v;if(v>maxP)maxP=v;});
var pad=(maxP-minP)*0.06||1;minP-=pad;maxP+=pad;
var LEFT=130,RIGHT=20,TOP=30,BOTTOM=30;var PW=W-LEFT-RIGHT,PH=H-TOP-BOTTOM;
function X(i){return LEFT+i*PW/(count-1||1);}function Y(p){return TOP+(maxP-p)/(maxP-minP)*PH;}
ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;for(var g=0;g<=5;g++){var y=TOP+PH*g/5;ctx.beginPath();ctx.moveTo(LEFT,y);ctx.lineTo(W-RIGHT,y);ctx.stroke();}
var lv=[];
function addLevel(price,color,label,dash){if(price==null)return;lv.push({price:Number(price),color:color,label:label,dash:dash,y:Y(Number(price))});}
addLevel(s.tp1Hit?s.trailStop:null,'#8a5cff','TRAIL',[4,4]);addLevel(s.tp1,'#00ff9d','TP1',[4,4]);addLevel(s.initialStop,'#ff3860','STOP',[6,3]);addLevel(s.entry,'#2962ff','GİRİŞ',[]);if(s.level!=null)addLevel(s.level,'#f6c453','SEVİYE',[2,2]);
lv.forEach(function(o){ctx.save();ctx.strokeStyle=o.color;ctx.lineWidth=2;if(o.dash.length)ctx.setLineDash(o.dash);ctx.beginPath();ctx.moveTo(LEFT,o.y);ctx.lineTo(W-RIGHT,o.y);ctx.stroke();ctx.restore();});
lv.sort(function(a,b){return a.y-b.y;});var prevY=-100;lv.forEach(function(o){o.ly=Math.max(o.y,prevY+14);prevY=o.ly;});
lv.forEach(function(o){ctx.save();ctx.fillStyle=o.color;ctx.font='bold 12px Arial';ctx.textAlign='right';ctx.fillText(o.label+' '+fmt(o.price),LEFT-10,o.ly+4);ctx.restore();});
var cw=Math.max(3,Math.min(16,PW/count*0.7));for(var c=0;c<candles.length;c++){var k=candles[c];var x=X(c);var o=Number(k.o),cl=Number(k.c),h=Number(k.h),l=Number(k.l);var bull=cl>=o;var color=bull?'#00ff9d':'#ff3860';ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(x,Y(h));ctx.lineTo(x,Y(l));ctx.stroke();var oY=Y(o),cY=Y(cl);ctx.fillRect(x-cw/2,Math.min(oY,cY),cw,Math.max(1,Math.abs(cY-oY)));}
var sx=X(count-1);ctx.save();ctx.strokeStyle='rgba(246,196,83,0.6)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(sx,TOP-10);ctx.lineTo(sx,H-BOTTOM);ctx.stroke();ctx.restore();
if(s.currentPrice!=null){var cy=Y(s.currentPrice);ctx.save();ctx.strokeStyle='#f6c453';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(LEFT,cy);ctx.lineTo(W-RIGHT,cy);ctx.stroke();ctx.restore();}}
function switchTab(t){currentTab=t;document.querySelectorAll('.side-tab').forEach(function(el){if(el.getAttribute('data-tab')===t)el.classList.add('active');else el.classList.remove('active');});selectedId=null;renderList();renderMain();}
document.getElementById('tabSignals').onclick=function(){switchTab('signals');};
document.getElementById('tabEscaped').onclick=function(){switchTab('escaped');};
function apply(data){if(!data)return;var ns=Array.isArray(data.signals)?data.signals:[];var ac=ns.filter(isOpenS).length;if(ac>lastActiveCount&&lastActiveCount>0)playSound();lastActiveCount=ac;signals=ns;escaped=Array.isArray(data.escaped)?data.escaped:[];
if(data.marketRegime)renderMarketBar(data.marketRegime);
renderPerf(data.perf,data.shadow,data.risk);
if(!selectedId&&signals.length>0)selectedId=signals[0].id;
document.getElementById('cSignals').textContent=ac;
document.getElementById('cEscaped').textContent=escaped.length;
document.title=(ac>0?'('+ac+') ':'')+'SCALP ENGINE';
var ei=document.getElementById('emptyInfo');if(ei)ei.textContent='Aktif: '+ac+' / Kaçan: '+escaped.length+(data.scanStatus?' • '+data.scanStatus.message:'');
renderList();renderMain();}
function fetchSignals(){fetch('/api/signals?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){apply(d);setConnStatus('online','Bağlı');}).catch(function(){setConnStatus('offline','Bağlantı Yok');});}
function connect(){if(reconnectTimer)clearTimeout(reconnectTimer);try{var proto=location.protocol==='https:'?'wss://':'ws://';ws=new WebSocket(proto+location.host);ws.onopen=function(){setConnStatus('online','Canlı');};ws.onmessage=function(ev){try{var m=JSON.parse(ev.data);if(m.type==='snapshot'||m.type==='update')apply(m.data);}catch(e){}};ws.onclose=function(){setConnStatus('offline','Yeniden Bağlanıyor');reconnectTimer=setTimeout(connect,3000);};ws.onerror=function(){setConnStatus('offline','Hata');};}catch(e){reconnectTimer=setTimeout(connect,3000);}}
window.addEventListener('resize',function(){if(selectedId)renderMain();});
setConnStatus('offline','Bağlanıyor...');
fetchSignals();
connect();
pollTimer=setInterval(fetchSignals,60000);
</script>
</body>
</html>`;

// ============================================================
// START
// ============================================================

async function start() {
    try {
        loadState();
        await exchange.loadMarkets();
        logInfo(`Bitget marketleri | ${Object.keys(exchange.markets).length} market`);
        await updateMarketRegime();
        await runPreScan();
        setInterval(function () { runScan(); }, CONFIG.SCAN_INTERVAL_MS);
        setInterval(function () { updateLivePrices(); }, CONFIG.LIVE_INTERVAL_MS);
        setInterval(function () { updateMarketRegime(); }, CONFIG.MARKET_STATUS_INTERVAL_MS);
        setInterval(function () { runPreScan(); }, CONFIG.PRESCAN_INTERVAL_MS);
        setInterval(function () { saveState(false); }, CONFIG.SAVE_INTERVAL_MS);
        setInterval(function () { trimLastSignalTime(); }, 60 * 60 * 1000);
        setInterval(function () { dumpSnapshotToDisk(); }, 5 * 60 * 1000);
        setInterval(function () { evaluateShadowCandidates(); }, CONFIG.SHADOW_CHECK_INTERVAL_MS);
        logInfo('SCALP ENGINE v1.0 başlatıldı — Rejim + Setup + Risk + Likidite + Gölge Takip');
    } catch (err) {
        logError(`[START] ${err.message}`);
        setTimeout(start, 30000);
    }
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logInfo(`${signal} alındı; kapanıyor.`);
    if (scanRunning) {
        const startTime = Date.now();
        while (scanRunning && Date.now() - startTime < 15000) { await sleep(500); }
    }
    saveState(true);
    dumpSnapshotToDisk();
    wss.clients.forEach(c => c.close());
    wss.close();
    server.close(async function () {
        try { await exchange.close(); } catch (e) {}
        process.exit(0);
    });
    setTimeout(function () { process.exit(1); }, 10000).unref();
}

process.once('SIGINT', function () { shutdown('SIGINT'); });
process.once('SIGTERM', function () { shutdown('SIGTERM'); });

server.listen(PORT, '0.0.0.0', function () {
    logInfo(`SCALP ENGINE v1.0 PORT=${PORT}`);
    start();
});
