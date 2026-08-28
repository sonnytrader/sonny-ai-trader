'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json());

// ========================= CONFIG =========================
const CFG = {
    RADAR: 500,
    CANDIDATES: 150,
    DEEP: 100,

    H1_HISTORY: 80,
    M15_HISTORY: 200,

    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 1000000),
    HIGH_VOLUME_USDT: 5000000,
    MID_VOLUME_USDT: 2000000,

    MIN_SIGNAL_SCORE: 70,
    MAX_SIGNALS: 5,

    ENTRY_ZONE_PERCENT: 0.004,
    MIN_VOLUME_SURGE: 1.0,
    MAX_VOLUME_SURGE: 5.0,
    MAX_BODY_ATR: 2.5,

    UT_ATR_PERIOD: 10,
    UT_KEY_VALUE: 1,

    SIGNAL_TTL: 45 * 60 * 1000,
    ENTRY_TTL: 25 * 60 * 1000,
    COOLDOWN: 2 * 60 * 60 * 1000,

    PAPER_MODE: true,
    AUTO_TRADE: false,
    DEBUG: true,

    SCAN_MS: 30000,
    LIVE_MS: 5000,
    CONCURRENCY: 3,
    
    REQUEST_DELAY: 150,
    CACHE_TTL: {
        '5m': 15 * 1000,
        '15m': 30 * 1000,
        '1h': 60 * 1000,
        '2h': 2 * 60 * 1000,
        '4h': 5 * 60 * 1000
    },

    CHART: 160
};

// ========================= EXCHANGE =========================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ========================= STATE =========================
const STATE = {
    markets: [],
    marketMap: new Map(),
    universe: [],
    candidates: [],
    deep: [],
    signals: new Map(),
    cooldowns: new Map(),
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: {
        label: 'YATAY / KARIŞIK',
        direction: 'FLAT',
        breadth: 50,
        green: 0,
        red: 0,
        average: 0,
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    },
    stats: {
        universe: 0,
        candidates: 0,
        deep: 0,
        analyzed: 0,
        signals: 0,
        errors: 0,
        finalSignals: 0,
        longSignals: 0,
        shortSignals: 0,
        rejectedExhaustion: 0,
        rejectedNoBreakout: 0,
        rejectedVolume: 0,
        rejectedScore: 0
    },
    signalHistory: [],
    performance: {
        signalsToday: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgRR: 0,
        profitFactor: 0,
        averageScore: 0,
        totalR: 0,
        grossProfitR: 0,
        grossLossR: 0
    },
    paperTrades: []
};

// ========================= CACHE =========================
const candleCache = new Map();
const requestQueue = [];
let isProcessingQueue = false;

// ========================= HELPERS =========================
function n(v, d = 6) {
    const x = Number(v);
    return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

function avg(a) {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function closed(c) {
    return Array.isArray(c) && c.length > 1 ? c.slice(0, -1) : (c || []);
}

function cleanSymbol(s) {
    let x = String(s || '').toUpperCase()
        .replace('/USDT:USDT', '')
        .replace('/USDT', '')
        .replace(':USDT', '');
    if (x.endsWith('USDT')) x = x.slice(0, -4);
    return x + 'USDT';
}

function fmt(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '-';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    if (x >= 0.0001) return x.toFixed(8);
    return x.toFixed(10);
}

function formatVolume(volume) {
    if (volume >= 1000000000) return (volume / 1000000000).toFixed(2) + 'B';
    if (volume >= 1000000) return (volume / 1000000).toFixed(1) + 'M';
    if (volume >= 1000) return (volume / 1000).toFixed(1) + 'K';
    return volume.toFixed(0);
}

// ========================= MARKET =========================
function findMarket(symbol) {
    const wanted = cleanSymbol(symbol);
    if (!STATE.markets.length) return null;
    return STATE.markets.find(m => cleanSymbol(m.symbol) === wanted) || null;
}

async function loadMarkets() {
    const markets = await exchange.loadMarkets(true);
    STATE.markets = Object.values(markets).filter(m =>
        m && m.active !== false && m.swap === true && m.linear === true &&
        m.quote === 'USDT' && m.settle === 'USDT'
    );
    STATE.marketMap = new Map(STATE.markets.map(m => [m.symbol, m]));
}

async function loadMarketsWithRetry(maxRetries = 3, delayMs = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await loadMarkets();
            return;
        } catch (e) {
            console.error(`Market yüklenemedi (${i + 1}/${maxRetries}):`, e.message);
            if (i < maxRetries - 1) await sleep(delayMs);
        }
    }
    throw new Error('Marketler yüklenemedi');
}

// ========================= RATE LIMIT QUEUE =========================
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    
    while (requestQueue.length > 0) {
        const task = requestQueue.shift();
        try {
            const result = await task.fn();
            task.resolve(result);
        } catch (error) {
            task.reject(error);
        }
        await sleep(CFG.REQUEST_DELAY);
    }
    
    isProcessingQueue = false;
}

function queueRequest(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processQueue();
    });
}

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    const ttl = CFG.CACHE_TTL[tf] || 30 * 1000;
    
    if (cached && Date.now() - cached.timestamp < ttl) {
        return cached.data;
    }
    
    try {
        const data = await queueRequest(() => exchange.fetchOHLCV(symbol, tf, undefined, limit));
        const cleaned = Array.isArray(data)
            ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0])
            : [];
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (error) {
        console.error(`Mum verisi alınamadı: ${symbol} ${tf} - ${error.message}`);
        if (cached) return cached.data;
        return [];
    }
}

// ========================= MOMENTUM SCORE =========================
function calculateMomentumScore(row) {
    let score = 0;
    const absChange = Math.abs(row.change);
    if (absChange >= 15) score += 40;
    else if (absChange >= 10) score += 35;
    else if (absChange >= 7) score += 28;
    else if (absChange >= 5) score += 20;
    else if (absChange >= 3) score += 12;
    else if (absChange >= 2) score += 8;
    else score += 3;
    
    if (row.volumeTier === 'HIGH') score += 25;
    else if (row.volumeTier === 'MID') score += 15;
    else score += 0;
    
    return score;
}

// ========================= TICKERS =========================
async function getTickers() {
    let tickers;
    try {
        tickers = await queueRequest(() => exchange.fetchTickers());
    } catch (error) {
        console.error('Tickers alınamadı:', error.message);
        if (!STATE.universe.length) throw error;
        return STATE.universe;
    }
    
    const rows = [];
    for (const m of STATE.markets) {
        const t = tickers[m.symbol];
        if (!t) continue;
        const last = n(t.last || t.close);
        const volume = n(t.quoteVolume);
        if (!(last > 0) || !(volume > 0)) continue;
        const change = n(t.percentage);
        
        rows.push({
            symbol: m.symbol,
            price: last,
            volume,
            volumeFormatted: formatVolume(volume),
            change,
            volumeTier: volume >= CFG.HIGH_VOLUME_USDT ? 'HIGH' :
                       volume >= CFG.MID_VOLUME_USDT ? 'MID' : 'LOW',
            momentumScore: 0
        });
    }
    
    for (const row of rows) {
        row.momentumScore = calculateMomentumScore(row);
    }
    
    rows.sort((a, b) => {
        if (b.momentumScore !== a.momentumScore) return b.momentumScore - a.momentumScore;
        return b.volume - a.volume;
    });
    
    return rows.slice(0, CFG.RADAR);
}

// ========================= ATR =========================
function atrUT(candles, period = 10) {
    if (!Array.isArray(candles) || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = n(candles[i][2]);
        const lo = n(candles[i][3]);
        const pc = n(candles[i - 1][4]);
        trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    if (trs.length < period) return avg(trs);
    let atrValue = avg(trs.slice(0, period));
    for (let i = period; i < trs.length; i++) {
        atrValue = (atrValue * (period - 1) + trs[i]) / period;
    }
    return atrValue;
}

// ========================= UT BOT =========================
function computeUT(candles) {
    const c = closed(candles);
    if (c.length < 20) return { buy: false, sell: false, stop: 0, pos: 0 };
    
    const a = CFG.UT_KEY_VALUE;
    const c_period = CFG.UT_ATR_PERIOD;
    
    let xATRTrailingStop = 0;
    let pos = 0;
    let prevSrc = 0;
    let prevTrailingStop = 0;
    let buy = false;
    let sell = false;
    
    for (let i = 0; i < c.length; i++) {
        const src = n(c[i][4]);
        const atrSlice = c.slice(Math.max(0, i - c_period), i + 1);
        const xATR = atrUT(atrSlice, c_period);
        const nLoss = a * xATR;
        
        if (i === 0) {
            xATRTrailingStop = src - nLoss;
            prevSrc = src;
            prevTrailingStop = xATRTrailingStop;
            continue;
        }
        
        const prevStop = prevTrailingStop;
        
        if (src > prevStop && prevSrc > prevStop) {
            xATRTrailingStop = Math.max(prevStop, src - nLoss);
        } else if (src < prevStop && prevSrc < prevStop) {
            xATRTrailingStop = Math.min(prevStop, src + nLoss);
        } else if (src > prevStop) {
            xATRTrailingStop = src - nLoss;
        } else {
            xATRTrailingStop = src + nLoss;
        }
        
        if (prevSrc < prevStop && src > prevStop) pos = 1;
        else if (prevSrc > prevStop && src < prevStop) pos = -1;
        
        buy = src > xATRTrailingStop && prevSrc <= prevStop;
        sell = src < xATRTrailingStop && prevSrc >= prevStop;
        
        prevSrc = src;
        prevTrailingStop = xATRTrailingStop;
    }
    
    return { buy, sell, stop: xATRTrailingStop, pos, src: prevSrc };
}

// ========================= 1H MARKET BIAS =========================
function get1hBias(candles1h) {
    const c = closed(candles1h);
    if (c.length < 30) return 'NEUTRAL';
    
    const closes = c.map(x => n(x[4]));
    const recent10 = avg(closes.slice(-10));
    const previous10 = avg(closes.slice(-20, -10));
    const lastClose = closes[closes.length - 1];
    
    // Swing yapısı
    const recentHigh = Math.max(...c.slice(-15).map(x => n(x[2])));
    const recentLow = Math.min(...c.slice(-15).map(x => n(x[3])));
    
    if (lastClose > recent10 && recent10 > previous10 && lastClose > recentLow) {
        return 'LONG';
    } else if (lastClose < recent10 && recent10 < previous10 && lastClose < recentHigh) {
        return 'SHORT';
    }
    
    return 'NEUTRAL';
}

// ========================= BREAKOUT TESPİTİ =========================
function detectBreakout(candles15m, bias1h) {
    const c = closed(candles15m);
    if (c.length < 40) return null;
    
    const lookback = 20;
    const recent = c.slice(-lookback);
    const last = c[c.length - 1];
    const prev = c[c.length - 2];
    
    const lastClose = n(last[4]);
    const lastOpen = n(last[1]);
    const lastHigh = n(last[2]);
    const lastLow = n(last[3]);
    const prevClose = n(prev[4]);
    
    // Seviyeler
    const resistance = Math.max(...recent.slice(0, -1).map(x => n(x[2])));
    const support = Math.min(...recent.slice(0, -1).map(x => n(x[3])));
    
    // Mum özellikleri
    const body = Math.abs(lastClose - lastOpen);
    const range = lastHigh - lastLow;
    const bodyRatio = range > 0 ? body / range : 0;
    
    // Hacim
    const volHistory = recent.map(x => n(x[5]));
    const avgVol = avg(volHistory.slice(0, -1));
    const lastVol = n(last[5]);
    const volumeSurge = avgVol > 0 ? lastVol / avgVol : 1;
    
    // ATR
    const atrValue = atrUT(c, 10);
    const bodyATR = atrValue > 0 ? body / atrValue : 0;
    
    // Tükeniş kontrolü
    if (bodyATR > CFG.MAX_BODY_ATR) {
        return { status: 'EXHAUSTION', reason: `Body ${bodyATR.toFixed(1)}x ATR` };
    }
    
    // Hacim kontrolü
    if (volumeSurge < CFG.MIN_VOLUME_SURGE || volumeSurge > CFG.MAX_VOLUME_SURGE) {
        return { status: 'VOLUME_INVALID', reason: `Vol ${volumeSurge.toFixed(1)}x` };
    }
    
    // SHORT BREAKOUT
    if (bias1h === 'SHORT' || bias1h === 'NEUTRAL') {
        if (lastClose < support && prevClose >= support && bodyRatio >= 0.4) {
            return {
                status: 'BREAKOUT',
                direction: 'SHORT',
                level: support,
                bodyRatio,
                volumeSurge,
                bodyATR,
                price: lastClose,
                time: n(last[0])
            };
        }
    }
    
    // LONG BREAKOUT
    if (bias1h === 'LONG' || bias1h === 'NEUTRAL') {
        if (lastClose > resistance && prevClose <= resistance && bodyRatio >= 0.4) {
            return {
                status: 'BREAKOUT',
                direction: 'LONG',
                level: resistance,
                bodyRatio,
                volumeSurge,
                bodyATR,
                price: lastClose,
                time: n(last[0])
            };
        }
    }
    
    return { status: 'NO_BREAKOUT' };
}

// ========================= RETEST TESPİTİ =========================
function detectRetest(candles15m, breakout, atrValue) {
    const c = closed(candles15m);
    const after = c.filter(x => n(x[0]) > breakout.time);
    
    if (after.length < 1) return { retested: false };
    
    const level = breakout.level;
    const tol = atrValue * 0.5;
    
    for (const candle of after) {
        const high = n(candle[2]);
        const low = n(candle[3]);
        const close = n(candle[4]);
        
        if (breakout.direction === 'SHORT') {
            // SHORT: Fiyat kırılan seviyeye geri döndü (direnç oldu)
            if (high >= level - tol && high <= level + tol) {
                // Reddedilme kontrolü
                if (close < level) {
                    return { retested: true, quality: 80, time: n(candle[0]) };
                }
            }
        } else {
            // LONG: Fiyat kırılan seviyeye geri döndü (destek oldu)
            if (low <= level + tol && low >= level - tol) {
                if (close > level) {
                    return { retested: true, quality: 80, time: n(candle[0]) };
                }
            }
        }
    }
    
    return { retested: false };
}

// ========================= SCORE HESAPLAMA =========================
function calculateScore(breakout, retestInfo, utResult, bias1h, row) {
    let score = 0;
    const breakdown = {};
    
    // Breakout taban puan
    score += 30;
    breakdown.breakout = 30;
    
    // Kapanış teyidi
    if (breakout.bodyRatio >= 0.5) {
        score += 15;
        breakdown.bodyConfirmation = 15;
    } else {
        score += 8;
        breakdown.bodyConfirmation = 8;
    }
    
    // Hacim kalitesi
    if (breakout.volumeSurge >= 1.5 && breakout.volumeSurge <= 3.0) {
        score += 15;
        breakdown.volume = 15;
    } else {
        score += 8;
        breakdown.volume = 8;
    }
    
    // ATR uygunluğu
    if (breakout.bodyATR >= 0.5 && breakout.bodyATR <= 1.5) {
        score += 15;
        breakdown.atrQuality = 15;
    } else {
        score += 8;
        breakdown.atrQuality = 8;
    }
    
    // Retest bonusu
    if (retestInfo.retested) {
        score += 15;
        breakdown.retest = 15;
    } else {
        score += 5;
        breakdown.retest = 5;
    }
    
    // UT Bot teyidi
    if (breakout.direction === 'SHORT' && utResult.pos === -1) {
        score += 10;
        breakdown.utConfirm = 10;
    } else if (breakout.direction === 'LONG' && utResult.pos === 1) {
        score += 10;
        breakdown.utConfirm = 10;
    } else {
        score += 0;
        breakdown.utConfirm = 0;
    }
    
    // 1H Bias uyumu
    if (bias1h === breakout.direction) {
        score += 10;
        breakdown.biasAlign = 10;
    } else {
        score += 3;
        breakdown.biasAlign = 3;
    }
    
    score = Math.min(100, score);
    
    return { score, breakdown };
}

// ========================= TRADE PLAN =========================
function createTradePlan(breakout, retestInfo, atrValue) {
    const direction = breakout.direction;
    const level = breakout.level;
    const entryPrice = breakout.price;
    
    let stop, tp1, tp2, tp3;
    
    if (direction === 'SHORT') {
        // Stop: Kırılan seviyenin üzeri + ATR tampon
        stop = level + atrValue * 0.5;
        const risk = Math.abs(stop - entryPrice);
        tp1 = entryPrice - risk * 1.5;
        tp2 = entryPrice - risk * 2.5;
        tp3 = entryPrice - risk * 4;
    } else {
        stop = level - atrValue * 0.5;
        const risk = Math.abs(entryPrice - stop);
        tp1 = entryPrice + risk * 1.5;
        tp2 = entryPrice + risk * 2.5;
        tp3 = entryPrice + risk * 4;
    }
    
    const risk = Math.abs(entryPrice - stop);
    const rr = risk > 0 ? Math.abs(tp1 - entryPrice) / risk : 0;
    
    return { stop, tp1, tp2, tp3, rr };
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        const [c1h, c15] = await Promise.all([
            getCandles(row.symbol, '1h', CFG.H1_HISTORY),
            getCandles(row.symbol, '15m', CFG.M15_HISTORY)
        ]);
        
        if (c1h.length < 30 || c15.length < 40) return null;
        
        // 1H Bias
        const bias1h = get1hBias(c1h);
        if (bias1h === 'NEUTRAL') return null;
        
        // Breakout tespiti
        const breakout = detectBreakout(c15, bias1h);
        
        if (breakout.status === 'EXHAUSTION') {
            STATE.stats.rejectedExhaustion++;
            if (CFG.DEBUG) console.log(`[${row.symbol}] TÜKENİŞ - ${breakout.reason}`);
            return null;
        }
        
        if (breakout.status === 'VOLUME_INVALID') {
            STATE.stats.rejectedVolume++;
            if (CFG.DEBUG) console.log(`[${row.symbol}] HACİM_GEÇERSİZ - ${breakout.reason}`);
            return null;
        }
        
        if (breakout.status !== 'BREAKOUT') {
            STATE.stats.rejectedNoBreakout++;
            return null;
        }
        
        // UT Bot teyidi
        const utResult = computeUT(c15);
        
        // ATR
        const atrValue = atrUT(closed(c15), 10);
        
        // Retest
        const retestInfo = detectRetest(c15, breakout, atrValue);
        
        // Skor
        const scoreResult = calculateScore(breakout, retestInfo, utResult, bias1h, row);
        
        if (scoreResult.score < CFG.MIN_SIGNAL_SCORE) {
            STATE.stats.rejectedScore++;
            if (CFG.DEBUG) console.log(`[${row.symbol}] SKOR_YETERSİZ ${scoreResult.score}`);
            return null;
        }
        
        // Trade plan
        const plan = createTradePlan(breakout, retestInfo, atrValue);
        
        const entryPercent = CFG.ENTRY_ZONE_PERCENT;
        const entryLow = breakout.direction === 'SHORT' ? breakout.price * (1 + entryPercent/2) : breakout.price * (1 - entryPercent/2);
        const entryHigh = breakout.direction === 'SHORT' ? breakout.price * (1 - entryPercent/2) : breakout.price * (1 + entryPercent/2);
        
        const signal = {
            symbol: row.symbol,
            marketSymbol: row.symbol,
            direction: breakout.direction,
            strategy: 'BREAKOUT + RETEST + UT TEYİT',
            score: scoreResult.score,
            confidence: scoreResult.score,
            currentPrice: row.price,
            entry: breakout.price,
            entryLow: n(entryLow, 8),
            entryHigh: n(entryHigh, 8),
            stop: n(plan.stop, 8),
            stopLoss: n(plan.stop, 8),
            tp1: n(plan.tp1, 8),
            tp2: n(plan.tp2, 8),
            tp3: n(plan.tp3, 8),
            rr: Number(plan.rr.toFixed(2)),
            rsi: 0,
            level: n(breakout.level, 8),
            breakoutLevel: n(breakout.level, 8),
            timeframeLevel: '15M',
            change24h: row.change,
            reason: `${breakout.direction} breakout + ${retestInfo.retested ? 'retest' : 'devam'} + UT ${utResult.pos === -1 ? 'SHORT' : utResult.pos === 1 ? 'LONG' : 'NÖTR'}`,
            reasons: [
                `15M ${breakout.direction} breakout`,
                `Hacim: ${breakout.volumeSurge.toFixed(1)}x`,
                `Body: ${breakout.bodyATR.toFixed(1)}x ATR`,
                retestInfo.retested ? 'Retest başarılı' : 'Breakout devamı'
            ],
            scoreBreakdown: scoreResult.breakdown,
            volumeTier: row.volumeTier,
            volumeFormatted: row.volumeFormatted,
            momentumScore: row.momentumScore,
            volumeSurge: Number(breakout.volumeSurge.toFixed(2)),
            bodyRatio: Number(breakout.bodyRatio.toFixed(2)),
            bodyATR: Number(breakout.bodyATR.toFixed(2)),
            retested: retestInfo.retested,
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            maeR: null,
            mfeR: null
        };
        
        const now = Date.now();
        signal.id = [signal.symbol, signal.direction, now].join('|');
        signal.signalAt = now;
        signal.cooldownKey = signal.id;
        
        const duplicate = [...STATE.signals.values()].some(s =>
            s.symbol === signal.symbol && s.direction === signal.direction);
        
        if (!duplicate && STATE.signals.size < CFG.MAX_SIGNALS) {
            STATE.signals.set(signal.id, signal);
            STATE.stats.finalSignals++;
            STATE.stats.signals++;
            
            if (signal.direction === 'LONG') STATE.stats.longSignals++;
            else STATE.stats.shortSignals++;
            
            if (CFG.DEBUG) {
                console.log(`✅ [${signal.symbol}] ${signal.direction} BREAKOUT SCORE=${scoreResult.score}`);
                console.log(`   Entry: ${fmt(signal.entry)} SL: ${fmt(signal.stop)}`);
                console.log(`   TP1: ${fmt(signal.tp1)} TP2: ${fmt(signal.tp2)} TP3: ${fmt(signal.tp3)}`);
                console.log(`   Hacim: ${row.volumeFormatted} | VolSurge: ${breakout.volumeSurge.toFixed(2)}x | BodyATR: ${breakout.bodyATR.toFixed(2)}x | Retest: ${retestInfo.retested}`);
            }
        }
        
    } catch (error) {
        console.error(`Analiz hatası (${row.symbol}):`, error.message);
        STATE.stats.errors++;
    }
    
    return null;
}

// ========================= SCAN =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.errors = 0;
    STATE.stats.finalSignals = 0;
    STATE.stats.longSignals = 0;
    STATE.stats.shortSignals = 0;
    STATE.stats.rejectedExhaustion = 0;
    STATE.stats.rejectedNoBreakout = 0;
    STATE.stats.rejectedVolume = 0;
    STATE.stats.rejectedScore = 0;
    
    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);
        
        const candidates = rows
            .filter(r => r.volumeTier !== 'LOW')
            .slice(0, CFG.CANDIDATES);
        
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        
        console.log(`\n📡 RADAR: ${STATE.stats.universe} | CANDIDATES: ${candidates.length}`);
        
        const deepCandidates = candidates.slice(0, CFG.DEEP);
        STATE.deep = deepCandidates;
        STATE.stats.deep = deepCandidates.length;
        STATE.stats.analyzed = 0;
        
        for (let i = 0; i < deepCandidates.length; i += CFG.CONCURRENCY) {
            const batch = deepCandidates.slice(i, i + CFG.CONCURRENCY);
            await Promise.all(batch.map(async row => {
                await analyzeCoin(row);
                STATE.stats.analyzed++;
            }));
            await sleep(30);
        }
        
        STATE.lastScan = Date.now();
        
        console.log(`\n📊 SONUÇ:`);
        console.log(`   Sinyaller: ${STATE.stats.finalSignals} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
        console.log(`   Reddedilen - Tükeniş: ${STATE.stats.rejectedExhaustion}, Hacim: ${STATE.stats.rejectedVolume}, Breakout: ${STATE.stats.rejectedNoBreakout}, Skor: ${STATE.stats.rejectedScore}`);
        console.log(`   Aktif Sinyal: ${STATE.signals.size} | Analiz: ${STATE.stats.analyzed}\n`);
    } catch (error) {
        STATE.lastError = error.message;
        STATE.stats.errors++;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
        STATE.stats.signals = STATE.signals.size;
        broadcast();
    }
}

// ========================= LIVE SIGNALS =========================
async function updateLiveSignals() {
    if (!STATE.signals.size) return;
    
    let tickers;
    try {
        tickers = await queueRequest(() => exchange.fetchTickers());
    } catch (e) {
        console.error('LIVE tickers alınamadı:', e.message);
        return;
    }
    
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) {
            STATE.signals.delete(id);
            recordSignalResult(signal, 'MISSED_ENTRY');
            continue;
        }
        
        const ticker = tickers[signal.marketSymbol];
        if (!ticker) continue;
        const current = n(ticker.last || ticker.close);
        if (!(current > 0)) continue;
        signal.currentPrice = current;
        
        if (!signal.paperEntry) {
            const inZone = current >= signal.entryLow && current <= signal.entryHigh;
            
            if (inZone) {
                if (CFG.PAPER_MODE) {
                    signal.paperEntry = current;
                    signal.entryTime = now;
                    signal.entryReady = true;
                    signal.status = 'İŞLEM AÇILDI';
                }
            }
            
            // Invalidation kontrolü
            if (signal.direction === 'LONG' && current < signal.breakoutLevel) {
                signal.status = 'KIRILIM BAŞARISIZ';
            } else if (signal.direction === 'SHORT' && current > signal.breakoutLevel) {
                signal.status = 'KIRILIM BAŞARISIZ';
            }
        }
        
        if (signal.paperEntry) {
            const risk = Math.abs(signal.entry - signal.stop);
            if (risk > 0) {
                if (signal.direction === 'LONG') {
                    const mfe = (current - signal.paperEntry) / risk;
                    const mae = (signal.paperEntry - Math.min(current, signal.paperEntry)) / risk;
                    signal.mfeR = signal.mfeR !== null ? Math.max(signal.mfeR, mfe) : mfe;
                    signal.maeR = signal.maeR !== null ? Math.min(signal.maeR, -mae) : -mae;
                } else {
                    const mfe = (signal.paperEntry - current) / risk;
                    const mae = (Math.max(current, signal.paperEntry) - signal.paperEntry) / risk;
                    signal.mfeR = signal.mfeR !== null ? Math.max(signal.mfeR, mfe) : mfe;
                    signal.maeR = signal.maeR !== null ? Math.min(signal.maeR, -mae) : -mae;
                }
            }
            
            if (signal.direction === 'LONG') {
                if (current <= signal.stop) {
                    STATE.signals.delete(id);
                    recordSignalResult(signal, 'STOP');
                    continue;
                }
                if (current >= signal.tp3) {
                    STATE.signals.delete(id);
                    recordSignalResult(signal, 'TP3');
                    continue;
                }
                if (current >= signal.tp2) signal.status = 'TP2';
                else if (current >= signal.tp1) signal.status = 'TP1';
                else if (current < signal.paperEntry) {
                    const lossPct = ((signal.paperEntry - current) / signal.paperEntry) * 100;
                    signal.status = 'TERS -%' + lossPct.toFixed(2);
                } else {
                    const profitPct = ((current - signal.paperEntry) / signal.paperEntry) * 100;
                    signal.status = 'KAR +%' + profitPct.toFixed(2);
                }
            } else {
                if (current >= signal.stop) {
                    STATE.signals.delete(id);
                    recordSignalResult(signal, 'STOP');
                    continue;
                }
                if (current <= signal.tp3) {
                    STATE.signals.delete(id);
                    recordSignalResult(signal, 'TP3');
                    continue;
                }
                if (current <= signal.tp2) signal.status = 'TP2';
                else if (current <= signal.tp1) signal.status = 'TP1';
                else if (current > signal.paperEntry) {
                    const lossPct = ((current - signal.paperEntry) / signal.paperEntry) * 100;
                    signal.status = 'TERS -%' + lossPct.toFixed(2);
                } else {
                    const profitPct = ((signal.paperEntry - current) / signal.paperEntry) * 100;
                    signal.status = 'KAR +%' + profitPct.toFixed(2);
                }
            }
        }
        
        signal.ageSeconds = Math.floor((now - signal.signalAt) / 1000);
        
        if (!signal.paperEntry && now - signal.signalAt > CFG.ENTRY_TTL) {
            STATE.signals.delete(id);
            recordSignalResult(signal, 'MISSED_ENTRY');
        }
    }
    
    cleanup();
    STATE.stats.signals = STATE.signals.size;
    broadcast();
}

function recordSignalResult(signal, result) {
    signal.result = result;
    signal.closedAt = Date.now();
    STATE.signalHistory.push({ ...signal });
    updatePerformance(signal, result);
    if (CFG.PAPER_MODE) {
        STATE.paperTrades.push({ ...signal, paperResult: result });
    }
    if (result === 'STOP' || result === 'MISSED_ENTRY') {
        STATE.cooldowns.set(signal.cooldownKey, Date.now());
    }
}

function updatePerformance(signal, result) {
    const perf = STATE.performance;
    const risk = Math.abs(signal.entry - signal.stop);
    if (risk <= 0) return;
    
    let rMultiple = 0;
    if (result === 'STOP') rMultiple = -1;
    else if (result === 'TP1') rMultiple = 1.5;
    else if (result === 'TP2') rMultiple = 2.5;
    else if (result === 'TP3') rMultiple = 4;
    else if (result === 'MISSED_ENTRY') rMultiple = 0;
    
    perf.totalR += rMultiple;
    if (rMultiple > 0) {
        perf.wins++;
        perf.grossProfitR += rMultiple;
    } else if (rMultiple < 0) {
        perf.losses++;
        perf.grossLossR += Math.abs(rMultiple);
    }
    
    const total = perf.wins + perf.losses;
    perf.winRate = total ? (perf.wins / total) * 100 : 0;
    perf.avgRR = total ? perf.totalR / total : 0;
    perf.profitFactor = perf.grossLossR > 0 ? perf.grossProfitR / perf.grossLossR : (perf.grossProfitR > 0 ? Infinity : 0);
    perf.averageScore = STATE.signalHistory.length ? avg(STATE.signalHistory.map(s => s.score)) : 0;
}

// ========================= CLEANUP =========================
function cleanup() {
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) STATE.signals.delete(id);
    }
    for (const [key, time] of STATE.cooldowns) {
        if (now - time > CFG.COOLDOWN) STATE.cooldowns.delete(key);
    }
    STATE.stats.signals = STATE.signals.size;
}

// ========================= MARKET REGIME =========================
function calculateMarketRegime(rows) {
    if (!rows.length) {
        STATE.market = { label: 'YATAY / KARIŞIK', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' };
        return;
    }
    
    let green = 0, red = 0, total = 0;
    for (const r of rows) {
        if (r.change > 0.5) green++;
        else if (r.change < -0.5) red++;
        total += r.change;
    }
    
    const totalCoins = rows.length;
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / totalCoins;
    
    const btc = rows.find(r => r.symbol.includes('BTC'));
    const eth = rows.find(r => r.symbol.includes('ETH'));
    
    let btcTrend = 'NEUTRAL';
    let ethTrend = 'NEUTRAL';
    
    if (btc) {
        if (btc.change > 1) btcTrend = 'LONG';
        else if (btc.change < -1) btcTrend = 'SHORT';
    }
    if (eth) {
        if (eth.change > 1) ethTrend = 'LONG';
        else if (eth.change < -1) ethTrend = 'SHORT';
    }
    
    let direction = 'FLAT';
    let label = 'YATAY / KARIŞIK';
    
    if (breadth >= 55 && average >= 0.5) {
        direction = 'LONG';
        label = 'POZİTİF / YÜKSELİŞ';
    } else if (breadth <= 45 && average <= -0.5) {
        direction = 'SHORT';
        label = 'NEGATİF / DÜŞÜŞ';
    } else if (breadth >= 52 && average >= 0.3) {
        direction = 'LONG';
        label = 'HAFİF POZİTİF';
    } else if (breadth <= 48 && average <= -0.3) {
        direction = 'SHORT';
        label = 'HAFİF NEGATİF';
    }
    
    STATE.market = {
        label,
        direction,
        breadth: Number(breadth.toFixed(1)),
        green,
        red,
        average: Number(average.toFixed(2)),
        btc: btcTrend,
        eth: ethTrend
    };
}

// ========================= STATUS =========================
function status() {
    cleanup();
    const signals = [...STATE.signals.values()].sort((a, b) => {
        if (a.paperEntry && !b.paperEntry) return -1;
        if (!a.paperEntry && b.paperEntry) return 1;
        return b.score - a.score;
    });
    
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals,
        preparing: [],
        pending: [],
        market: STATE.market,
        signalHistoryCount: STATE.signalHistory.length,
        performance: STATE.performance,
        paperTrades: STATE.paperTrades.slice(-20)
    };
}

// ========================= API ENDPOINTS =========================
function auth(req, res, next) {
    if (!API_TOKEN) return next();
    const token = req.headers['x-api-token'] || req.query.token;
    if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/api/status', (req, res) => res.json(status()));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), lastScan: STATE.lastScan, lastError: STATE.lastError }));
app.get('/api/scan', auth, async (req, res) => {
    try { await runScan(); res.json({ success: true, data: status() }); }
    catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/chart', auth, async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '15m';
        const market = findMarket(symbol);
        if (!market) return res.json({ success: false, error: 'Market yok' });
        const candles = await getCandles(market.symbol, timeframe, CFG.CHART);
        const signal = [...STATE.signals.values()].find(s => s.marketSymbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get('/api/history', auth, (req, res) => res.json({ success: true, history: STATE.signalHistory.slice(-100) }));

// ========================= WEBSOCKET =========================
function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: status() });
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload); } catch (error) {}
        }
    }
}

wss.on('connection', ws => {
    try { ws.send(JSON.stringify({ type: 'snapshot', data: status() })); } catch (_) {}
});

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI TRADER</title>
<style>
*{box-sizing:border-box;}
body{margin:0;background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;}
.app{display:grid;grid-template-columns:275px 1fr 310px;height:100vh;}
.left{background:#0b111b;border-right:1px solid #1a2533;overflow:auto;padding:18px;}
.brand{font-size:18px;font-weight:bold;margin-bottom:5px;}
.sub{color:#718096;font-size:11px;margin-bottom:18px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px;}
.st{background:#101826;border:1px solid #1b2939;padding:9px 5px;text-align:center;border-radius:6px;}
.st b{display:block;font-size:17px;}
.st span{color:#64748b;font-size:9px;}
.cards{display:flex;flex-direction:column;gap:7px;}
.card{background:#101826;border:1px solid #1c2938;border-radius:7px;padding:11px;cursor:pointer;transition:.15s;}
.card:hover,.card.active{border-color:#13dba0;background:#111d2a;}
.card.short{border-left:3px solid #ff5570;}
.card.kar{border-left:3px solid #13dba0;background:#0d1a15;}
.card.ters{border-left:3px solid #ff5570;background:#1a1015;}
.top{display:flex;align-items:center;justify-content:space-between;}
.coin{font-size:14px;font-weight:bold;}
.badge{font-size:9px;padding:3px 6px;border-radius:4px;background:#123c31;color:#13dba0;}
.badge.short{background:#421d28;color:#ff5570;}
.badge.kar{background:#0d3d2a;color:#13dba0;font-weight:bold;}
.badge.ters{background:#421d1d;color:#ff5570;font-weight:bold;}
.cp{font-size:15px;margin-top:8px;}
.meta{color:#718096;font-size:9px;margin-top:6px;}
.vol{font-size:8px;color:#8b9bb4;margin-top:3px;}
.main{min-width:0;display:flex;flex-direction:column;}
.head{height:70px;padding:15px 20px;border-bottom:1px solid #182330;display:flex;align-items:center;justify-content:space-between;}
.title{font-weight:bold;font-size:16px;}
.title small{display:block;color:#64748b;font-size:10px;margin-top:4px;}
.pill{font-size:10px;color:#13dba0;}
.chartbox{flex:1;min-height:0;display:flex;flex-direction:column;}
.charthead{height:45px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #182330;}
.charthead b{font-size:12px;}
.tf{display:flex;gap:4px;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 8px;font-size:9px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}
.chart{flex:1;min-height:0;}
canvas{width:100%;height:100%;display:block;}
.right{background:#0b111b;border-left:1px solid #1a2533;overflow:auto;padding:15px;}
.box{background:#101826;border:1px solid #1a2938;border-radius:7px;padding:13px;margin-bottom:10px;}
.bt{color:#64748b;font-size:9px;font-weight:bold;letter-spacing:.5px;}
.reg{font-size:16px;font-weight:bold;margin-top:7px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:10px;line-height:1.7;margin-top:7px;}
.an{font-size:16px;font-weight:bold;margin-top:9px;margin-bottom:10px;}
.longtxt{color:#13dba0;}
.shorttxt{color:#ff5570;}
.kar-txt{color:#13dba0;}
.ters-txt{color:#ff5570;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:5px;padding:8px;}
.lv span{display:block;color:#64748b;font-size:8px;margin-bottom:4px;}
.lv b{font-size:11px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}
.pending{display:flex;flex-direction:column;gap:6px;}
.pi{border:1px solid #1b2938;border-radius:5px;padding:8px;font-size:9px;color:#718096;}
.pi b{color:#dbe4ee;}
.empty{color:#64748b;font-size:10px;padding:12px 4px;}
@media(max-width:1000px){.app{grid-template-columns:230px 1fr;}.right{display:none;}}
</style>
</head>
<body>
<div class="app">
<aside class="left">
<div class="brand">⚡ SONNY AI TRADER</div>
<div class="sub">BREAKOUT + RETEST + UT TEYİT</div>
<div class="stats">
<div class="st"><b id="u">0</b><span>RADAR</span></div>
<div class="st"><b id="c">0</b><span>ADAY</span></div>
<div class="st"><b id="d">0</b><span>DERİN</span></div>
</div>
<div class="cards" id="cards"><div class="empty">Sinyal bekleniyor...</div></div>
</aside>
<main class="main">
<div class="head">
<div class="title">
<span id="ps">BTCUSDT</span> • <span id="pt">15M</span>
<small id="info">Sistem hazırlanıyor...</small>
</div>
<div class="pill">● BREAKOUT MODU</div>
</div>
<section class="chartbox">
<div class="charthead">
<b id="cn">BTCUSDT • 15M</b>
<div class="tf">
<button data-t="15m" class="active">15M</button>
<button data-t="1h">1H</button>
<button data-t="2h">2H</button>
<button data-t="4h">4H</button>
</div>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
</section>
</main>
<aside class="right">
<div class="box">
<div class="bt">GENEL PİYASA</div>
<div id="reg" class="reg">YATAY / KARIŞIK</div>
<div id="mi" class="mi">Analiz ediliyor...</div>
</div>
<div class="box">
<div class="bt">AKTİF SİNYAL</div>
<div id="active"><div class="empty">Henüz sinyal yok.</div></div>
</div>
<div class="box">
<div class="bt">PERFORMANS</div>
<div id="pending" class="pending"><div class="empty">-</div></div>
</div>
</aside>
</div>
<script>
(function(){
var S={selected:'BTC/USDT:USDT',tf:'15m',candles:[],signal:null};
function $(id){return document.getElementById(id);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function p(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);if(x>=.01)return x.toFixed(7);if(x>=.0001)return x.toFixed(8);return x.toFixed(10);}
function normalize(a){return (a||[]).map(function(x){return Array.isArray(x)?{time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{time:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)};}).filter(function(x){return Number.isFinite(x.time)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close);}).sort(function(a,b){return a.time-b.time;});}
function render(data){
var st=data.stats||{};
$('u').textContent=st.universe||0;$('c').textContent=st.candidates||0;$('d').textContent=st.deep||0;
$('info').textContent=data.lastScan?'Son tarama: '+new Date(data.lastScan).toLocaleTimeString('tr-TR'):'Tarama bekleniyor...';
var m=data.market||{};
$('reg').textContent=m.label||'YATAY / KARIŞIK';
$('reg').className='reg '+(m.direction==='LONG'?'long':m.direction==='SHORT'?'short':'');
$('mi').innerHTML='Breadth %'+esc(m.breadth)+' • Yeşil '+esc(m.green)+' • Kırmızı '+esc(m.red)+'<br>Ortalama '+esc(m.average)+'%<br>BTC '+esc(m.btc)+' • ETH '+esc(m.eth);
var cards=$('cards');cards.innerHTML='';
var arr=data.signals||[];
if(!arr.length){cards.innerHTML='<div class="empty">Teyit edilmiş sinyal yok.</div>';}
arr.forEach(function(s){
var el=document.createElement('div');
var cls='card ';
if(s.direction==='SHORT')cls+='short ';
if(s.marketSymbol===S.selected)cls+='active ';
if(s.status&&s.status.startsWith('KAR'))cls+='kar ';
else if(s.status&&s.status.startsWith('TERS'))cls+='ters ';
var statusBadge='';
if(s.status&&s.status.startsWith('KAR')){statusBadge='<div class="badge kar" style="margin-top:4px;font-size:11px;">● KARDA</div>';}
else if(s.status&&s.status.startsWith('TERS')){statusBadge='<div class="badge ters" style="margin-top:4px;font-size:11px;">⚠️ TERSE GİRDİ</div>';}
else if(s.status==='KIRILIM BAŞARISIZ'){statusBadge='<div class="badge ters" style="margin-top:4px;font-size:11px;">⚠️ KIRILIM BAŞARISIZ</div>';}
else if(s.status==='İŞLEM AÇILDI'){statusBadge='<div class="badge kar" style="margin-top:4px;">● AÇILDI</div>';}
else{statusBadge='<div class="badge" style="margin-top:4px;">GİRİŞ BEKLİYOR</div>';}
el.innerHTML='<div class="top"><div class="coin">'+esc(s.symbol)+'</div><div class="badge '+(s.direction==='LONG'?'long':'short')+'">'+esc(s.direction)+'</div></div>'+
'<div class="cp">'+p(s.currentPrice||s.entry)+'</div>'+
'<div class="meta">● GÜÇ '+esc(s.score)+'/100 • Breakout</div>'+
'<div class="vol">Hacim: '+esc(s.volumeFormatted||'?')+' ('+esc(s.volumeTier||'?')+')'+(s.retested?' • Retest ✓':'')+'</div>'+
statusBadge;
el.onclick=function(){S.selected=s.marketSymbol;S.signal=s;loadChart();};
cards.appendChild(el);
});
var selected=arr.find(function(x){return x.marketSymbol===S.selected;})||arr[0]||null;
if(selected){S.selected=selected.marketSymbol;S.signal=selected;setActive(selected);}else{setActive(null);}
$('pending').innerHTML='<div class="pi"><b>📊 Performans</b><br>Win: '+esc(data.performance?data.performance.wins:0)+' • Loss: '+esc(data.performance?data.performance.losses:0)+'<br>WinRate: %'+esc(data.performance?data.performance.winRate:0)+' • ToplamR: '+esc(data.performance?data.performance.totalR:0)+'</div>';
if(data.chart){S.candles=normalize(data.chart.candles);S.signal=data.chart.signal||S.signal;S.selected=data.chart.symbol||S.selected;S.tf=data.chart.timeframe||S.tf;updateHeader();draw();}
if(data.error){$('info').textContent='HATA: '+data.error;}
}
function setActive(s){
if(!s){$('active').innerHTML='<div class="empty">Henüz sinyal yok.</div>';return;}
var cl='';
if(s.status&&s.status.startsWith('KAR'))cl='kar-txt';
else if(s.status&&s.status.startsWith('TERS'))cl='ters-txt';
else cl=s.direction==='LONG'?'longtxt':'shorttxt';
var statusText=s.status||'GİRİŞ BEKLENİYOR';
var statusColor='#718096';
if(s.status&&s.status.startsWith('KAR')){statusColor='#13dba0';}
else if(s.status&&s.status.startsWith('TERS')){statusColor='#ff5570';}
else if(s.status==='KIRILIM BAŞARISIZ'){statusColor='#ff5570';}
$('active').innerHTML='<div class="an '+cl+'">'+esc(s.symbol)+' • '+esc(s.direction)+'</div>'+
'<div style="color:'+statusColor+';font-weight:bold;margin:8px 0;font-size:12px;">'+esc(statusText)+'</div>'+
'<div class="grid">'+
'<div class="lv entry"><span>GİRİŞ</span><b>'+p(s.entryLow)+' — '+p(s.entryHigh)+'</b></div>'+
'<div class="lv stop"><span>STOP</span><b>'+p(s.stop)+'</b></div>'+
'<div class="lv tp"><span>TP1</span><b>'+p(s.tp1)+'</b></div>'+
'<div class="lv tp"><span>TP2</span><b>'+p(s.tp2)+'</b></div>'+
'<div class="lv tp"><span>TP3</span><b>'+p(s.tp3)+'</b></div>'+
'<div class="lv"><span>R:R</span><b>1:'+esc(s.rr)+'</b></div></div>'+
'<div class="mi">SKOR '+esc(s.score)+'/100<br>Hacim: '+esc(s.volumeFormatted||'?')+' ('+esc(s.volumeTier||'?')+')'+(s.retested?'<br>✓ Retest başarılı':'')+'<br>'+esc(s.reason||'')+'</div>';
}
function updateHeader(){var sym=String(S.selected||'BTCUSDT').replace('/USDT:USDT','USDT');$('ps').textContent=sym;$('pt').textContent=String(S.tf).toUpperCase();$('cn').textContent=sym+' • '+String(S.tf).toUpperCase();}
async function loadChart(){
try{
var r=await fetch('/api/chart?symbol='+encodeURIComponent(S.selected)+'&timeframe='+encodeURIComponent(S.tf),{cache:'no-store'});
var d=await r.json();
if(!d.success)return;
S.candles=normalize(d.candles);S.signal=d.signal||S.signal;S.selected=d.symbol||S.selected;S.tf=d.timeframe||S.tf;updateHeader();draw();
}catch(e){console.error('chart',e);}
}
function draw(){
var c=$('cv');var r=c.getBoundingClientRect();var dpr=devicePixelRatio||1;
var w=Math.max(300,Math.floor(r.width));var h=Math.max(300,Math.floor(r.height));
c.width=w*dpr;c.height=h*dpr;
var x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);
x.fillStyle='#070b11';x.fillRect(0,0,w,h);
if(!S.candles.length){x.fillStyle='#718096';x.font='13px Arial';x.fillText('Grafik verisi bekleniyor...',18,30);return;}
var visible=S.candles.slice(-140);
var values=[];visible.forEach(function(k){values.push(k.high,k.low);});
var s=S.signal;
if(s){[s.entryLow,s.entryHigh,s.entry,s.stop,s.tp1,s.tp2,s.tp3].forEach(function(q){if(Number.isFinite(Number(q)))values.push(Number(q));});}
var min=Math.min.apply(Math,values);var max=Math.max.apply(Math,values);
var pad=(max-min)*.07||1;min-=pad;max+=pad;
var L=55,R=85,T=20,B=22;
var volumeHeight=50;
var chartBottom=h-B-volumeHeight-10;
var PW=w-L-R;var PH=chartBottom-T;
function Y(q){return T+(max-q)/(max-min)*PH;}
function X(i){return L+i*PW/Math.max(1,visible.length-1);}
x.strokeStyle='#182330';x.lineWidth=1;
for(var g=0;g<=5;g++){var gy=T+PH*g/5;x.beginPath();x.moveTo(L,gy);x.lineTo(w-R,gy);x.stroke();x.fillStyle='#607083';x.font='9px Arial';x.fillText(p(max-(max-min)*g/5),5,gy+3);}
var step=PW/Math.max(1,visible.length-1);var bw=Math.max(2,Math.min(9,step*.62));
visible.forEach(function(k,i){
var xx=X(i);var up=k.close>=k.open;var col=up?'#13e0a2':'#ff4d6d';
x.strokeStyle=col;x.fillStyle=col;
x.beginPath();x.moveTo(xx,Y(k.high));x.lineTo(xx,Y(k.low));x.stroke();
var yo=Y(k.open);var yc=Y(k.close);
x.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)));
});
var maxVol=Math.max.apply(Math,visible.map(function(k){return k.volume;}))||1;
x.fillStyle='#101826';x.fillRect(L,chartBottom+10,PW,volumeHeight);
x.strokeStyle='#182330';x.strokeRect(L,chartBottom+10,PW,volumeHeight);
visible.forEach(function(k,i){
var vh=(k.volume/maxVol)*volumeHeight;
x.fillStyle=k.close>=k.open?'rgba(19,224,162,0.6)':'rgba(255,77,109,0.6)';
x.fillRect(X(i)-bw/2,chartBottom+10+volumeHeight-vh,bw,vh);
});
if(s){
level(s.stop,'#ff4d6d','STOP');
level(s.entry,'#13e0a2','GİRİŞ');
level(s.tp1,'#4da3ff','TP1');
level(s.tp2,'#4da3ff','TP2');
level(s.tp3,'#4da3ff','TP3');
if(s.entryLow!==s.entryHigh){x.fillStyle='rgba(19,224,162,.10)';var a=Y(s.entryLow);var b=Y(s.entryHigh);x.fillRect(L,Math.min(a,b),PW,Math.abs(a-b));}
}
function level(q,col,label){
if(!Number.isFinite(Number(q)))return;
var yy=Y(Number(q));
x.strokeStyle=col;x.setLineDash([6,5]);
x.beginPath();x.moveTo(L,yy);x.lineTo(w-R,yy);x.stroke();
x.setLineDash([]);x.fillStyle=col;x.font='bold 9px Arial';
x.fillText(label+' '+p(q),w-R+5,yy+3);
}
}
Array.prototype.forEach.call(document.querySelectorAll('[data-t]'),function(b){
b.onclick=function(){Array.prototype.forEach.call(document.querySelectorAll('[data-t]'),function(z){z.classList.remove('active');});b.classList.add('active');S.tf=b.getAttribute('data-t');loadChart();};
});
function connect(){
var proto=location.protocol==='https:'?'wss://':'ws://';
var ws=new WebSocket(proto+location.host);
ws.onmessage=function(e){try{var m=JSON.parse(e.data);if(m.type==='snapshot')render(m.data);}catch(_){}};
ws.onclose=function(){setTimeout(connect,2500);};
}
connect();
fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(render).catch(function(){});
window.addEventListener('resize',draw);
setInterval(loadChart,5000);
})();
</script>
</body>
</html>`;

// ========================= SERVER START =========================
app.get('/', (req, res) => res.type('html').send(HTML));

process.on('unhandledRejection', e => {
    STATE.lastError = e?.message || String(e);
    console.error('UNHANDLED', e);
});

process.on('uncaughtException', e => {
    STATE.lastError = e?.message || String(e);
    console.error('UNCAUGHT', e);
});

server.on('error', (err) => {
    console.error('SERVER BIND ERROR:', err.message);
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🚀 SONNY AI TRADER (BREAKOUT + RETEST + UT TEYİT)');
    console.log('📡 Bitget USDT Futures');
    console.log('📊 1H Bias → 15M Breakout → Retest → UT Teyit');
    console.log('💰 Min Volume: $' + CFG.MIN_VOLUME_USDT);
    console.log('🎯 Min Score: ' + CFG.MIN_SIGNAL_SCORE);
    console.log('⏱️ Scan: 30 sec');
    console.log('==============================================');

    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | Gerçek USDT perpetual=' + STATE.markets.length);
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR (marketler):', e.message);
    }

    setTimeout(() => {
        runScan().catch(e => {
            STATE.lastError = e.message;
            console.error('SCAN LOOP HATASI:', e.message);
        });
    }, 1000);

    setInterval(() => {
        if (!STATE.scanning) {
            runScan().catch(e => {
                STATE.lastError = e.message;
                console.error('SCAN LOOP HATASI:', e.message);
            });
        }
    }, CFG.SCAN_MS);

    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE LOOP', e.message)), CFG.LIVE_MS);
});
