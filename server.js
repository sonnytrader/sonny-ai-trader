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

    M15_HISTORY: 200,

    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 1000000),
    HIGH_VOLUME_USDT: 5000000,
    MID_VOLUME_USDT: 2000000,

    MIN_SIGNAL_SCORE: 60,
    MAX_SIGNALS: 5,

    EMA_PERIOD: 21,
    VWAP_LOOKBACK: 200,
    BREAKOUT_LOOKBACK: 10,
    MIN_VOLUME_SURGE: 1.2,
    MAX_VOLUME_SURGE: 6.0,
    MAX_BODY_ATR: 2.5,
    ATR_PERIOD: 10,
    RETEST_TOLERANCE: 0.0015,
    ENTRY_ZONE_PERCENT: 0.0015,

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
        rejectedTrend: 0,
        rejectedScore: 0,
        activeTrades: 0
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
function calculateATR(candles, period = 10) {
    const c = closed(candles);
    if (c.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) {
        const h = n(c[i][2]);
        const lo = n(c[i][3]);
        const pc = n(c[i - 1][4]);
        trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    if (trs.length < period) return avg(trs);
    let atrValue = avg(trs.slice(0, period));
    for (let i = period; i < trs.length; i++) {
        atrValue = (atrValue * (period - 1) + trs[i]) / period;
    }
    return atrValue;
}

// ========================= EMA =========================
function calculateEMA(candles, period = 21) {
    const c = closed(candles);
    if (c.length < period) return null;
    const closes = c.map(x => n(x[4]));
    const k = 2 / (period + 1);
    let ema = avg(closes.slice(0, period));
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
}

// ========================= VWAP =========================
function calculateVWAP(candles, lookback = 200) {
    const c = closed(candles).slice(-lookback);
    if (c.length < 10) return 0;
    
    let totalPV = 0;
    let totalVol = 0;
    
    for (const candle of c) {
        const typicalPrice = (n(candle[2]) + n(candle[3]) + n(candle[4])) / 3;
        const vol = n(candle[5]);
        totalPV += typicalPrice * vol;
        totalVol += vol;
    }
    
    return totalVol > 0 ? totalPV / totalVol : 0;
}

// ========================= MK-VR SİNYAL TESPİTİ =========================
function detectMKVRSignal(candles15m, row) {
    const c15 = closed(candles15m);
    if (c15.length < 50) return { status: 'NO_DATA' };
    
    const last = c15[c15.length - 1];
    const prev = c15[c15.length - 2];
    
    const lastClose = n(last[4]);
    const lastOpen = n(last[1]);
    const lastHigh = n(last[2]);
    const lastLow = n(last[3]);
    const prevClose = n(prev[4]);
    
    const ema21 = calculateEMA(candles15m, CFG.EMA_PERIOD);
    if (ema21 === null) return { status: 'NO_DATA' };
    
    const vwap = calculateVWAP(candles15m, CFG.VWAP_LOOKBACK);
    if (vwap === 0) return { status: 'NO_DATA' };
    
    const atrValue = calculateATR(candles15m, CFG.ATR_PERIOD);
    if (atrValue === 0) return { status: 'NO_DATA' };
    
    let trend = 'NEUTRAL';
    if (lastClose > ema21 && lastClose > vwap) {
        trend = 'LONG';
    } else if (lastClose < ema21 && lastClose < vwap) {
        trend = 'SHORT';
    } else {
        return { status: 'TREND_NEUTRAL' };
    }
    
    const lookback = CFG.BREAKOUT_LOOKBACK;
    const recent = c15.slice(-lookback - 1, -1);
    
    const recentHigh = Math.max(...recent.map(x => n(x[2])));
    const recentLow = Math.min(...recent.map(x => n(x[3])));
    
    const body = Math.abs(lastClose - lastOpen);
    const range = lastHigh - lastLow;
    const bodyRatio = range > 0 ? body / range : 0;
    const bodyATR = atrValue > 0 ? body / atrValue : 0;
    
    const volHistory = c15.slice(-15).map(x => n(x[5]));
    const avgVol = avg(volHistory.slice(0, -1));
    const lastVol = n(last[5]);
    const volumeSurge = avgVol > 0 ? lastVol / avgVol : 1;
    
    if (bodyATR > CFG.MAX_BODY_ATR) {
        return { status: 'EXHAUSTION', reason: `Body ${bodyATR.toFixed(1)}x ATR` };
    }
    
    if (volumeSurge < CFG.MIN_VOLUME_SURGE || volumeSurge > CFG.MAX_VOLUME_SURGE) {
        return { status: 'VOLUME_INVALID', reason: `Vol ${volumeSurge.toFixed(1)}x` };
    }
    
    if (trend === 'LONG') {
        if (lastClose > recentHigh && prevClose <= recentHigh && bodyRatio >= 0.4) {
            return {
                status: 'BREAKOUT',
                direction: 'LONG',
                level: recentHigh,
                bodyRatio,
                volumeSurge,
                bodyATR,
                price: lastClose,
                time: n(last[0]),
                ema21: ema21,
                vwap: vwap,
                vwapDistance: Math.abs(lastClose - vwap) / vwap * 100
            };
        }
    }
    
    if (trend === 'SHORT') {
        if (lastClose < recentLow && prevClose >= recentLow && bodyRatio >= 0.4) {
            return {
                status: 'BREAKOUT',
                direction: 'SHORT',
                level: recentLow,
                bodyRatio,
                volumeSurge,
                bodyATR,
                price: lastClose,
                time: n(last[0]),
                ema21: ema21,
                vwap: vwap,
                vwapDistance: Math.abs(vwap - lastClose) / vwap * 100
            };
        }
    }
    
    return { status: 'NO_BREAKOUT' };
}

// ========================= RETEST KONTROLÜ =========================
function checkRetest(candles15m, breakout, atrValue) {
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
            if (high >= level - tol && high <= level + tol) {
                if (close < level) {
                    return { retested: true, quality: 80, time: n(candle[0]) };
                }
            }
        } else {
            if (low <= level + tol && low >= level - tol) {
                if (close > level) {
                    return { retested: true, quality: 80, time: n(candle[0]) };
                }
            }
        }
    }
    
    return { retested: false };
}

// ========================= SKOR HESAPLAMA =========================
function calculateScore(breakout, retestInfo, row) {
    let score = 0;
    const breakdown = {};
    
    score += 30;
    breakdown.breakout = 30;
    
    if (breakout.bodyRatio >= 0.6) {
        score += 15;
        breakdown.bodyQuality = 15;
    } else if (breakout.bodyRatio >= 0.4) {
        score += 10;
        breakdown.bodyQuality = 10;
    } else {
        score += 5;
        breakdown.bodyQuality = 5;
    }
    
    if (breakout.volumeSurge >= 2.0 && breakout.volumeSurge <= 3.5) {
        score += 20;
        breakdown.volume = 20;
    } else if (breakout.volumeSurge >= 1.5) {
        score += 12;
        breakdown.volume = 12;
    } else {
        score += 5;
        breakdown.volume = 5;
    }
    
    if (breakout.vwapDistance <= 0.3) {
        score += 15;
        breakdown.vwap = 15;
    } else if (breakout.vwapDistance <= 0.6) {
        score += 10;
        breakdown.vwap = 10;
    } else {
        score += 5;
        breakdown.vwap = 5;
    }
    
    if (retestInfo.retested) {
        score += 15;
        breakdown.retest = 15;
    } else {
        score += 5;
        breakdown.retest = 5;
    }
    
    if (breakout.bodyATR >= 0.5 && breakout.bodyATR <= 1.5) {
        score += 10;
        breakdown.atr = 10;
    } else {
        score += 5;
        breakdown.atr = 5;
    }
    
    score = Math.min(100, score);
    return { score, breakdown };
}

// ========================= TRADE PLAN =========================
function createTradePlan(breakout, atrValue) {
    const direction = breakout.direction;
    const level = breakout.level;
    const entryPrice = breakout.price;
    
    let stop, tp1, tp2, tp3;
    
    if (direction === 'SHORT') {
        stop = level + atrValue * 1.0;
        const risk = Math.abs(stop - entryPrice);
        tp1 = entryPrice - risk * 1.0;
        tp2 = entryPrice - risk * 2.0;
        tp3 = entryPrice - risk * 3.0;
    } else {
        stop = level - atrValue * 1.0;
        const risk = Math.abs(entryPrice - stop);
        tp1 = entryPrice + risk * 1.0;
        tp2 = entryPrice + risk * 2.0;
        tp3 = entryPrice + risk * 3.0;
    }
    
    const risk = Math.abs(entryPrice - stop);
    const rr = risk > 0 ? Math.abs(tp1 - entryPrice) / risk : 0;
    
    return { stop, tp1, tp2, tp3, rr };
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        const c15 = await getCandles(row.symbol, '15m', CFG.M15_HISTORY);
        
        if (c15.length < 50) return null;
        
        const breakout = detectMKVRSignal(c15, row);
        
        if (!breakout || breakout.status === 'NO_DATA') return null;
        
        if (breakout.status === 'TREND_NEUTRAL') {
            STATE.stats.rejectedTrend++;
            return null;
        }
        
        if (breakout.status === 'EXHAUSTION') {
            STATE.stats.rejectedExhaustion++;
            return null;
        }
        
        if (breakout.status === 'VOLUME_INVALID') {
            STATE.stats.rejectedVolume++;
            return null;
        }
        
        if (breakout.status !== 'BREAKOUT') {
            STATE.stats.rejectedNoBreakout++;
            return null;
        }
        
        const atrValue = calculateATR(c15, CFG.ATR_PERIOD);
        const retestInfo = checkRetest(c15, breakout, atrValue);
        const scoreResult = calculateScore(breakout, retestInfo, row);
        
        if (scoreResult.score < CFG.MIN_SIGNAL_SCORE) {
            STATE.stats.rejectedScore++;
            return null;
        }
        
        const plan = createTradePlan(breakout, atrValue);
        
        const entryPercent = CFG.ENTRY_ZONE_PERCENT;
        const entryLow = breakout.direction === 'SHORT' ? breakout.price * (1 + entryPercent/2) : breakout.price * (1 - entryPercent/2);
        const entryHigh = breakout.direction === 'SHORT' ? breakout.price * (1 - entryPercent/2) : breakout.price * (1 + entryPercent/2);
        
        const signal = {
            symbol: row.symbol,
            marketSymbol: row.symbol,
            direction: breakout.direction,
            strategy: 'MK-VR SCALP',
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
            reason: `${breakout.direction} kırılım + ${retestInfo.retested ? 'retest' : 'devam'}`,
            reasons: [
                `15M ${breakout.direction} breakout`,
                `Hacim: ${breakout.volumeSurge.toFixed(1)}x`,
                retestInfo.retested ? 'Retest başarılı' : 'Breakout devamı'
            ],
            scoreBreakdown: scoreResult.breakdown,
            volumeTier: row.volumeTier,
            volumeFormatted: row.volumeFormatted,
            momentumScore: row.momentumScore,
            volumeSurge: Number(breakout.volumeSurge.toFixed(2)),
            bodyRatio: Number(breakout.bodyRatio.toFixed(2)),
            bodyATR: Number(breakout.bodyATR.toFixed(2)),
            vwapDistance: Number(breakout.vwapDistance.toFixed(2)),
            retested: retestInfo.retested,
            status: 'GİRİŞ BEKLENİYOR',
            entryReady: false,
            paperEntry: null,
            entryTime: null,
            maeR: null,
            mfeR: null,
            lastCandleTime: breakout.time
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
                console.log(`✅ [${signal.symbol}] MK-VR ${signal.direction} SCORE=${scoreResult.score}`);
                console.log(`   Entry: ${fmt(signal.entry)} SL: ${fmt(signal.stop)}`);
                console.log(`   TP1: ${fmt(signal.tp1)} TP2: ${fmt(signal.tp2)} TP3: ${fmt(signal.tp3)}`);
                console.log(`   Hacim: ${row.volumeFormatted} | VolSurge: ${breakout.volumeSurge.toFixed(2)}x | VWAP: ${breakout.vwapDistance.toFixed(2)}%`);
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
    STATE.stats.rejectedTrend = 0;
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
        
        // Sadece mum kapanışında durum güncelle
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
            
            // Kırılım başarısız - sadece kapanış bazlı
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
                if (current >= signal.tp2) signal.status = 'TP2 HEDEF';
                else if (current >= signal.tp1) signal.status = 'TP1 HEDEF';
                else if (current < signal.paperEntry) {
                    signal.status = 'TERS BÖLGEDE';
                } else {
                    signal.status = 'KARDA';
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
                if (current <= signal.tp2) signal.status = 'TP2 HEDEF';
                else if (current <= signal.tp1) signal.status = 'TP1 HEDEF';
                else if (current > signal.paperEntry) {
                    signal.status = 'TERS BÖLGEDE';
                } else {
                    signal.status = 'KARDA';
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
    STATE.stats.activeTrades = [...STATE.signals.values()].filter(s => s.paperEntry).length;
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
    else if (result === 'TP1') rMultiple = 1;
    else if (result === 'TP2') rMultiple = 2;
    else if (result === 'TP3') rMultiple = 3;
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
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;min-height:100vh;}
.app{display:grid;grid-template-columns:1fr;gap:10px;padding:10px;max-width:1200px;margin:0 auto;}
@media(min-width:768px){.app{grid-template-columns:280px 1fr;gap:15px;padding:15px;}}
@media(min-width:1024px){.app{grid-template-columns:300px 1fr 300px;}}

.left{background:#0b111b;border:1px solid #1a2533;border-radius:10px;padding:12px;}
.brand{font-size:16px;font-weight:bold;color:#13dba0;}
.sub{color:#718096;font-size:10px;margin-bottom:10px;}

.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;}
.st{background:#101826;border:1px solid #1b2939;padding:8px 4px;text-align:center;border-radius:6px;}
.st b{display:block;font-size:14px;color:#13dba0;}
.st span{color:#64748b;font-size:8px;}

.cards{display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 200px);overflow-y:auto;}
.card{background:#101826;border:1px solid #1c2938;border-radius:8px;padding:10px;cursor:pointer;transition:.15s;position:relative;}
.card:hover{border-color:#13dba0;}
.card.selected{border:2px solid #13dba0;background:#111d2a;}
.card.long{border-left:4px solid #13dba0;}
.card.short{border-left:4px solid #ff5570;}
.card.active{border-right:2px solid #13dba0;}
.card.failed{border-left:4px solid #ff9500;opacity:0.7;}

.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.coin{font-size:12px;font-weight:bold;}
.dir{font-size:10px;padding:3px 8px;border-radius:4px;font-weight:bold;}
.dir.long{background:#123c31;color:#13dba0;}
.dir.short{background:#421d28;color:#ff5570;}

.price{font-size:14px;font-weight:bold;margin:4px 0;}
.details{font-size:9px;color:#8b9bb4;line-height:1.5;}
.score-bar{height:4px;background:#1c2938;border-radius:2px;margin-top:5px;overflow:hidden;}
.score-fill{height:100%;border-radius:2px;}

.status-badge{display:inline-block;font-size:8px;padding:2px 6px;border-radius:3px;margin-top:5px;font-weight:bold;}
.status-entry{background:#123c31;color:#13dba0;}
.status-active{background:#0d3d2a;color:#13dba0;}
.status-failed{background:#421d1d;color:#ff5570;}
.status-ters{background:#421d1d;color:#ff5570;}
.status-kar{background:#0d3d2a;color:#13dba0;}
.status-tp{background:#123c31;color:#55a7ff;}

.main{min-width:0;display:flex;flex-direction:column;background:#0b111b;border:1px solid #1a2533;border-radius:10px;padding:10px;}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:5px;}
.title{font-weight:bold;font-size:14px;color:#13dba0;}
.info{color:#64748b;font-size:9px;}

.charthead{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;flex-wrap:wrap;gap:5px;}
.chart-title{font-size:11px;font-weight:bold;color:#dbe4ee;}
.tf{display:flex;gap:3px;flex-wrap:wrap;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:4px 8px;font-size:8px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}

.chart{flex:1;min-height:250px;position:relative;}
canvas{width:100%;height:100%;display:block;}

.right{background:#0b111b;border:1px solid #1a2533;border-radius:10px;padding:12px;display:none;}
@media(min-width:1024px){.right{display:block;}}

.box{background:#101826;border:1px solid #1a2938;border-radius:8px;padding:10px;margin-bottom:8px;}
.bt{color:#64748b;font-size:8px;font-weight:bold;letter-spacing:.5px;}
.reg{font-size:13px;font-weight:bold;margin-top:5px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:9px;line-height:1.6;margin-top:5px;}

.signal-detail{margin-top:8px;}
.signal-title{font-size:13px;font-weight:bold;}
.signal-title.long{color:#13dba0;}
.signal-title.short{color:#ff5570;}
.signal-status{font-size:10px;font-weight:bold;margin:5px 0;padding:5px 8px;border-radius:4px;display:inline-block;}

.levels{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:5px;padding:6px;}
.lv span{display:block;color:#64748b;font-size:7px;margin-bottom:2px;}
.lv b{font-size:10px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}

.pending{display:flex;flex-direction:column;gap:5px;}
.pi{border:1px solid #1b2938;border-radius:5px;padding:6px;font-size:8px;color:#718096;}
.pi b{color:#dbe4ee;font-size:9px;}
.empty{color:#64748b;font-size:9px;padding:8px 4px;text-align:center;}
</style>
</head>
<body>
<div class="app">
<aside class="left">
<div class="brand">⚡ SONNY AI TRADER</div>
<div class="sub">MK-VR SCALP • 15M</div>
<div class="stats">
<div class="st"><b id="u">0</b><span>RADAR</span></div>
<div class="st"><b id="c">0</b><span>ADAY</span></div>
<div class="st"><b id="d">0</b><span>DERİN</span></div>
</div>
<div class="cards" id="cards"><div class="empty">Sinyal bekleniyor...</div></div>
</aside>

<main class="main">
<div class="head">
<div class="title" id="ps">BTCUSDT</div>
<div class="info" id="info">Sistem hazırlanıyor...</div>
</div>
<div class="charthead">
<div class="chart-title" id="cn">BTCUSDT • 15M</div>
<div class="tf">
<button data-t="15m" class="active">15M</button>
<button data-t="1h">1H</button>
<button data-t="2h">2H</button>
<button data-t="4h">4H</button>
</div>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
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
$('info').textContent=data.lastScan?'Son: '+new Date(data.lastScan).toLocaleTimeString('tr-TR'):'Tarama bekleniyor...';
var m=data.market||{};
$('reg').textContent=m.label||'YATAY';
$('reg').className='reg '+(m.direction==='LONG'?'long':m.direction==='SHORT'?'short':'');
$('mi').innerHTML='Breadth %'+esc(m.breadth)+'<br>Yeşil '+esc(m.green)+' • Kırmızı '+esc(m.red)+'<br>BTC '+esc(m.btc)+' • ETH '+esc(m.eth);
var cards=$('cards');cards.innerHTML='';
var arr=data.signals||[];
if(!arr.length){cards.innerHTML='<div class="empty">Sinyal yok</div>';}
arr.forEach(function(s){
var el=document.createElement('div');
var isActive=s.paperEntry!==null;
var isFailed=s.status==='KIRILIM BAŞARISIZ';
var cls='card '+(s.direction==='LONG'?'long ':'short ')+(s.marketSymbol===S.selected?'selected ':'')+(isActive?'active ':'')+(isFailed?'failed ':'');
var scorePct=s.score||0;
var scoreColor=scorePct>=80?'#13dba0':scorePct>=60?'#55a7ff':'#ff9500';
var statusText=s.status||'GİRİŞ BEKLENİYOR';
var statusCls='status-entry';
if(s.status==='İŞLEM AÇILDI'){statusCls='status-active';}
else if(s.status==='KIRILIM BAŞARISIZ'){statusCls='status-failed';}
else if(s.status==='TERS BÖLGEDE'){statusCls='status-ters';}
else if(s.status==='KARDA'){statusCls='status-kar';}
else if(s.status&&s.status.startsWith('TP')){statusCls='status-tp';}
el.innerHTML='<div class="card-head"><div class="coin">'+esc(s.symbol)+'</div><div class="dir '+(s.direction==='LONG'?'long':'short')+'">'+esc(s.direction)+'</div></div>'+
'<div class="price">'+p(s.currentPrice||s.entry)+'</div>'+
'<div class="details">Güç: '+esc(s.score)+'/100 • Hacim: '+esc(s.volumeFormatted||'?')+'</div>'+
'<div class="score-bar"><div class="score-fill" style="width:'+scorePct+'%;background:'+scoreColor+';"></div></div>'+
'<span class="status-badge '+statusCls+'">'+esc(statusText)+'</span>';
el.onclick=function(){
S.selected=s.marketSymbol;S.signal=s;
document.querySelectorAll('.card').forEach(function(c){c.classList.remove('selected');});
el.classList.add('selected');
loadChart();
};
cards.appendChild(el);
});
var selected=arr.find(function(x){return x.marketSymbol===S.selected;})||arr[0]||null;
if(selected){S.selected=selected.marketSymbol;S.signal=selected;setActive(selected);}else{setActive(null);}
$('pending').innerHTML='<div class="pi"><b>📊 Performans</b><br>Win: '+esc(data.performance?data.performance.wins:0)+' • Loss: '+esc(data.performance?data.performance.losses:0)+'<br>WinRate: %'+esc(data.performance?data.performance.winRate:0)+'<br>ToplamR: '+esc(data.performance?data.performance.totalR:0)+'</div>';
if(data.chart){S.candles=normalize(data.chart.candles);S.signal=data.chart.signal||S.signal;S.selected=data.chart.symbol||S.selected;S.tf=data.chart.timeframe||S.tf;updateHeader();draw();}
if(data.error){$('info').textContent='HATA: '+data.error;}
}
function setActive(s){
if(!s){$('active').innerHTML='<div class="empty">Sinyal yok</div>';return;}
var cls=s.direction==='LONG'?'long':'short';
var statusColor='#718096';
if(s.status==='KIRILIM BAŞARISIZ')statusColor='#ff5570';
else if(s.status==='TERS BÖLGEDE')statusColor='#ff5570';
else if(s.status==='KARDA')statusColor='#13dba0';
else if(s.status==='İŞLEM AÇILDI')statusColor='#13dba0';
else if(s.status&&s.status.startsWith('TP'))statusColor='#55a7ff';
$('active').innerHTML='<div class="signal-title '+cls+'">'+esc(s.symbol)+' • '+esc(s.direction)+'</div>'+
'<div class="signal-status" style="background:'+(statusColor==='#ff5570'?'#1a1015':statusColor==='#13dba0'?'#0d1a15':'#101826')+';color:'+statusColor+';">'+esc(s.status||'GİRİŞ BEKLENİYOR')+'</div>'+
'<div class="levels">'+
'<div class="lv entry"><span>GİRİŞ</span><b>'+p(s.entryLow)+' — '+p(s.entryHigh)+'</b></div>'+
'<div class="lv stop"><span>STOP</span><b>'+p(s.stop)+'</b></div>'+
'<div class="lv tp"><span>TP1</span><b>'+p(s.tp1)+'</b></div>'+
'<div class="lv tp"><span>TP2</span><b>'+p(s.tp2)+'</b></div>'+
'<div class="lv tp"><span>TP3</span><b>'+p(s.tp3)+'</b></div>'+
'<div class="lv"><span>R:R</span><b>1:'+esc(s.rr)+'</b></div></div>'+
'<div class="mi" style="margin-top:5px;">SKOR '+esc(s.score)+'/100<br>Hacim: '+esc(s.volumeFormatted||'?')+' ('+esc(s.volumeTier||'?')+')<br>'+esc(s.reason||'')+'</div>';
}
function updateHeader(){var sym=String(S.selected||'BTCUSDT').replace('/USDT:USDT','USDT');$('ps').textContent=sym;$('cn').textContent=sym+' • '+String(S.tf).toUpperCase();}
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
var w=Math.max(250,Math.floor(r.width));var h=Math.max(200,Math.floor(r.height));
c.width=w*dpr;c.height=h*dpr;
var x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);
x.fillStyle='#070b11';x.fillRect(0,0,w,h);
if(!S.candles.length){x.fillStyle='#718096';x.font='11px Arial';x.fillText('Grafik verisi bekleniyor...',15,25);return;}
var visible=S.candles.slice(-100);
var values=[];visible.forEach(function(k){values.push(k.high,k.low);});
var s=S.signal;
if(s){[s.entryLow,s.entryHigh,s.entry,s.stop,s.tp1,s.tp2,s.tp3].forEach(function(q){if(Number.isFinite(Number(q)))values.push(Number(q));});}
var min=Math.min.apply(Math,values);var max=Math.max.apply(Math,values);
var pad=(max-min)*.08||1;min-=pad;max+=pad;
var L=45,R=60,T=15,B=15;
var PW=w-L-R;var PH=h-T-B;
function Y(q){return T+(max-q)/(max-min)*PH;}
function X(i){return L+i*PW/Math.max(1,visible.length-1);}
x.strokeStyle='#182330';x.lineWidth=1;
for(var g=0;g<=4;g++){var gy=T+PH*g/4;x.beginPath();x.moveTo(L,gy);x.lineTo(w-R,gy);x.stroke();x.fillStyle='#607083';x.font='8px Arial';x.fillText(p(max-(max-min)*g/4),3,gy+3);}
var step=PW/Math.max(1,visible.length-1);var bw=Math.max(2,Math.min(7,step*.6));
visible.forEach(function(k,i){
var xx=X(i);var up=k.close>=k.open;var col=up?'#13e0a2':'#ff4d6d';
x.strokeStyle=col;x.fillStyle=col;
x.beginPath();x.moveTo(xx,Y(k.high));x.lineTo(xx,Y(k.low));x.stroke();
var yo=Y(k.open);var yc=Y(k.close);
x.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)));
});
if(s){
level(s.stop,'#ff4d6d','SL');
level(s.entry,'#13e0a2','GİRİŞ');
level(s.tp1,'#4da3ff','TP1');
level(s.tp2,'#4da3ff','TP2');
level(s.tp3,'#4da3ff','TP3');
}
function level(q,col,label){
if(!Number.isFinite(Number(q)))return;
var yy=Y(Number(q));
x.strokeStyle=col;x.setLineDash([4,4]);
x.beginPath();x.moveTo(L,yy);x.lineTo(w-R,yy);x.stroke();
x.setLineDash([]);x.fillStyle=col;x.font='bold 8px Arial';
x.fillText(label+' '+p(q),w-R+3,yy+3);
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
    console.log('🚀 SONNY AI TRADER (MK-VR SCALP)');
    console.log('📡 Bitget USDT Futures');
    console.log('📊 EMA21 + VWAP → 15M Breakout → Retest');
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
