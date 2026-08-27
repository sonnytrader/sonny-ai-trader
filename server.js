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
    DEEP: 80, // 60 -> 80

    H1_HISTORY: 300,
    H4_HISTORY: 120,
    M15: 160,
    M5: 200,

    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 3000000),

    LEVEL_CLUSTER_PCT: 0.0035,
    MIN_TOUCHES: 2,

    BREAKOUT_VOL: 1.30,
    MIN_SCORE: 75,

    MIN_RR: 1.50,
    TP2_RR: 2.25,
    TP3_RR: 3.25,

    ATR_STOP: 1.00,
    SIGNAL_TTL: 45 * 60 * 1000,
    ENTRY_TTL: 20 * 60 * 1000,
    COOLDOWN: 4 * 60 * 60 * 1000,

    FIVE_MIN_REQUIRED: true,
    PAPER_MODE: true,
    AUTO_TRADE: false,
    DEBUG: false,

    MAX_ENTRY_DISTANCE_ATR: 0.75,
    MAX_BREAKOUT_EXTENSION_ATR: 1.5,

    MICRO_PIVOT_SPAN: 1,
    MAX_SLIPPAGE_ATR: 0.35,

    RETEST_MIN: 120 * 60 * 1000,
    RETEST_TOL: 0.0045,
    INVALIDATION_BUFFER_PCT: 0.0035,

    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 2,

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
    pending: new Map(),
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
        pending: 0,
        signals: 0,
        errors: 0,
        // yeni alanlar
        opportunityCount: 0,
        deepSelected: 0,
        breakoutCount: 0,
        retestedCount: 0,
        triggerConfirmedCount: 0,
        rejectedScore: 0,
        finalSignals: 0
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
        averageMAE: 0,
        averageMFE: 0,
        totalR: 0,
        grossProfitR: 0,
        grossLossR: 0
    },
    paperTrades: []
};

// ========================= CACHE =========================
const candleCache = new Map();

// ========================= HELPERS =========================
function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
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

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    const ttl = tf === '5m' ? 30 * 1000 :
                tf === '15m' ? 60 * 1000 :
                tf === '1h' ? 5 * 60 * 1000 :
                tf === '2h' ? 10 * 60 * 1000 :
                tf === '4h' ? 15 * 60 * 1000 : 60 * 1000;
    if (cached && Date.now() - cached.timestamp < ttl) {
        return cached.data;
    }
    try {
        const data = await exchange.fetchOHLCV(symbol, tf, undefined, limit);
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

// ========================= AGGREGATION =========================
function aggregateCandles(candles, hours) {
    const map = new Map();
    const bucketMs = hours * 60 * 60 * 1000;
    for (const candle of candles) {
        const bucket = Math.floor(n(candle[0]) / bucketMs) * bucketMs;
        if (!map.has(bucket)) {
            map.set(bucket, [bucket, n(candle[1]), n(candle[2]), n(candle[3]), n(candle[4]), n(candle[5])]);
        } else {
            const item = map.get(bucket);
            item[2] = Math.max(item[2], n(candle[2]));
            item[3] = Math.min(item[3], n(candle[3]));
            item[4] = n(candle[4]);
            item[5] += n(candle[5]);
        }
    }
    return [...map.values()].sort((a, b) => a[0] - b[0]);
}

// ========================= TICKERS =========================
async function getTickers() {
    let tickers;
    try {
        tickers = await exchange.fetchTickers();
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
        const high = n(t.high);
        const low = n(t.low);
        const spread = t.bid && t.ask ? (n(t.ask) - n(t.bid)) / last : null;
        rows.push({
            symbol: m.symbol,
            price: last,
            volume,
            change: n(t.percentage),
            range: low > 0 ? ((high - low) / low) * 100 : 0,
            spread
        });
    }
    rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, CFG.RADAR);
}

// ========================= INDICATORS =========================
function ema(candles, p) {
    const c = closed(candles);
    if (c.length < p) return null;
    let e = avg(c.slice(0, p).map(x => n(x[4])));
    const k = 2 / (p + 1);
    for (let i = p; i < c.length; i++) {
        e = n(c[i][4]) * k + e * (1 - k);
    }
    return e;
}

function rsi(candles, p = 14) {
    const c = closed(candles);
    if (c.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = c.length - p; i < c.length; i++) {
        const d = n(c[i][4]) - n(c[i - 1][4]);
        if (d > 0) g += d;
        else l -= d;
    }
    if (l === 0) return 100;
    const rs = (g / p) / (l / p);
    return 100 - 100 / (1 + rs);
}

function atr(candles, p = 14) {
    const c = closed(candles);
    if (c.length < p + 1) return 0;
    const a = [];
    for (let i = 1; i < c.length; i++) {
        const h = n(c[i][2]), lo = n(c[i][3]), pc = n(c[i - 1][4]);
        a.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    return avg(a.slice(-p));
}

function trueRangeAvg(candles, p = 14) {
    if (!Array.isArray(candles) || candles.length < p + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = n(candles[i][2]), lo = n(candles[i][3]), pc = n(candles[i - 1][4]);
        trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    return avg(trs.slice(-p));
}

function trend(candles) {
    const c = closed(candles);
    if (c.length < 55) return 'NEUTRAL';
    const e21 = ema(candles, 21);
    const e50 = ema(candles, 50);
    const last = n(c[c.length - 1][4]);
    if (e21 === null || e50 === null) return 'NEUTRAL';
    if (last > e21 && e21 > e50) return 'LONG';
    if (last < e21 && e21 < e50) return 'SHORT';
    return 'NEUTRAL';
}

function structure(candles, lookback = 20) {
    const c = closed(candles).slice(-lookback);
    if (c.length < 8) return 'NEUTRAL';
    const h = Math.floor(c.length / 2);
    const a = c.slice(0, h);
    const b = c.slice(h);
    const ah = Math.max(...a.map(x => n(x[2])));
    const al = Math.min(...a.map(x => n(x[3])));
    const bh = Math.max(...b.map(x => n(x[2])));
    const bl = Math.min(...b.map(x => n(x[3])));
    if (bh > ah && bl > al) return 'LONG';
    if (bh < ah && bl < al) return 'SHORT';
    return 'NEUTRAL';
}

function volumeRatio(candles, p = 20) {
    const x = closed(candles);
    if (x.length < p + 1) return 1;
    const cur = n(x[x.length - 1][5]);
    const base = x.slice(-p - 1, -1).map(z => n(z[5])).filter(Boolean);
    const a = avg(base);
    return a > 0 ? cur / a : 1;
}

// ========================= PIVOTS / LEVELS =========================
function pivots(candles, span = 2) {
    const c = closed(candles);
    const out = [];
    if (c.length < span * 2 + 8) return out;
    for (let i = span; i < c.length - span; i++) {
        const hi = n(c[i][2]), lo = n(c[i][3]);
        let isH = true, isL = true;
        for (let j = 1; j <= span; j++) {
            if (hi <= n(c[i - j][2]) || hi <= n(c[i + j][2])) isH = false;
            if (lo >= n(c[i - j][3]) || lo >= n(c[i + j][3])) isL = false;
        }
        if (isH) out.push({ price: hi, type: 'resistance', time: c[i][0] });
        if (isL) out.push({ price: lo, type: 'support', time: c[i][0] });
    }
    return out;
}

function getLevels(candles, timeframe) {
    const raw = pivots(candles);
    const groups = [];
    for (const point of raw) {
        let group = groups.find(g => g.type === point.type &&
            Math.abs(point.price - g.price) / Math.max(g.price, 1e-12) <= CFG.LEVEL_CLUSTER_PCT);
        if (!group) {
            group = { type: point.type, price: point.price, items: [] };
            groups.push(group);
        }
        group.items.push(point);
        group.price = avg(group.items.map(x => x.price));
    }
    return groups.map(g => {
        const touches = g.items.length;
        let strength = 'zayıf';
        if (touches >= 4) strength = 'çok güçlü';
        else if (touches === 3) strength = 'güçlü';
        else if (touches === 2) strength = 'normal';
        return {
            type: g.type,
            price: g.price,
            timeframe,
            touches,
            strength,
            lastTouch: Math.max(...g.items.map(x => x.time)),
            age: Date.now() - Math.max(...g.items.map(x => x.time))
        };
    }).filter(g => g.touches >= CFG.MIN_TOUCHES);
}

// ========================= LEVEL CLUSTER =========================
function clusterLevels(levels4h, levels2h) {
    const resistanceClusters = [];
    const supportClusters = [];

    const allResistance = [...levels4h.filter(l => l.type === 'resistance'), ...levels2h.filter(l => l.type === 'resistance')];
    const allSupport = [...levels4h.filter(l => l.type === 'support'), ...levels2h.filter(l => l.type === 'support')];

    for (const lv of allResistance) {
        let cluster = resistanceClusters.find(c =>
            Math.abs(lv.price - c.price) / Math.max(c.price, 1e-12) <= CFG.LEVEL_CLUSTER_PCT);
        if (!cluster) {
            cluster = { price: lv.price, type: 'resistance', levels: [] };
            resistanceClusters.push(cluster);
        }
        cluster.levels.push(lv);
        cluster.price = avg(cluster.levels.map(l => l.price));
    }

    for (const lv of allSupport) {
        let cluster = supportClusters.find(c =>
            Math.abs(lv.price - c.price) / Math.max(c.price, 1e-12) <= CFG.LEVEL_CLUSTER_PCT);
        if (!cluster) {
            cluster = { price: lv.price, type: 'support', levels: [] };
            supportClusters.push(cluster);
        }
        cluster.levels.push(lv);
        cluster.price = avg(cluster.levels.map(l => l.price));
    }

    return [...resistanceClusters, ...supportClusters].map(c => ({
        price: c.price,
        type: c.type,
        levels4h: c.levels.filter(l => l.timeframe === '4H'),
        levels2h: c.levels.filter(l => l.timeframe === '2H'),
        combinedTouches: c.levels.reduce((s, l) => s + l.touches, 0),
        maxStrength: c.levels.some(l => l.strength === 'çok güçlü') ? 'çok güçlü' :
                     c.levels.some(l => l.strength === 'güçlü') ? 'güçlü' :
                     c.levels.some(l => l.strength === 'normal') ? 'normal' : 'zayıf',
        timeframeSource: c.levels.some(l => l.timeframe === '4H') ? '4H' : '2H'
    }));
}

// ========================= BREAKOUT =========================
function detectBreakouts(candles, levels, currentTime) {
    const c = closed(candles);
    const out = [];
    if (c.length < 30) return out;
    const lastClosedIndex = c.length - 1;
    const start = Math.max(1, lastClosedIndex - 8);
    for (let i = start; i <= lastClosedIndex; i++) {
        const candle = c[i];
        const prev = c[i - 1];
        if (!candle || !prev) continue;
        if (currentTime && n(candle[0]) > currentTime) continue;
        const history = c.slice(Math.max(0, i - 20), i);
        const avgVol = avg(history.map(x => n(x[5])).filter(Boolean));
        const vr = avgVol > 0 ? n(candle[5]) / avgVol : 1;
        const body = Math.abs(n(candle[4]) - n(candle[1]));
        const range = Math.max(n(candle[2]) - n(candle[3]), 1e-12);
        const bodyRatio = body / range;
        const atrValue = atr(c.slice(0, i + 1), 14) || n(candle[4]) * 0.003;
        const bodyAtr = body / Math.max(atrValue, 1e-12);
        const closeLocation = (n(candle[4]) - n(candle[3])) / range;
        const upperWick = (n(candle[2]) - Math.max(n(candle[1]), n(candle[4]))) / range;
        const lowerWick = (Math.min(n(candle[1]), n(candle[4])) - n(candle[3])) / range;
        if (vr < CFG.BREAKOUT_VOL) continue;
        if (bodyRatio < 0.30) continue;
        if (bodyAtr < 0.35) continue;
        for (const level of levels) {
            const proximity = Math.abs(n(prev[4]) - level.price) / Math.max(level.price, 1e-12);
            if (proximity > 0.006) continue;
            const buffer = level.price * 0.0012;
            if (level.type === 'resistance' &&
                n(prev[4]) <= level.price &&
                n(candle[4]) > level.price + buffer &&
                closeLocation >= 0.6 &&
                upperWick < 0.35) {
                const distanceFromLevel = n(candle[4]) - level.price;
                const distanceATR = distanceFromLevel / (atrValue || 1e-9);
                if (distanceATR > CFG.MAX_BREAKOUT_EXTENSION_ATR) continue;
                out.push({
                    direction: 'LONG',
                    level,
                    time: n(candle[0]),
                    breakoutVolumeRatio: vr,
                    breakoutBodyAtr: bodyAtr,
                    bodyRatio,
                    closeLocation,
                    upperWick,
                    lowerWick,
                    distanceATR
                });
            }
            if (level.type === 'support' &&
                n(prev[4]) >= level.price &&
                n(candle[4]) < level.price - buffer &&
                closeLocation <= 0.4 &&
                lowerWick < 0.35) {
                const distanceFromLevel = level.price - n(candle[4]);
                const distanceATR = distanceFromLevel / (atrValue || 1e-9);
                if (distanceATR > CFG.MAX_BREAKOUT_EXTENSION_ATR) continue;
                out.push({
                    direction: 'SHORT',
                    level,
                    time: n(candle[0]),
                    breakoutVolumeRatio: vr,
                    breakoutBodyAtr: bodyAtr,
                    bodyRatio,
                    closeLocation,
                    upperWick,
                    lowerWick,
                    distanceATR
                });
            }
        }
    }
    return out.sort((a, b) => b.time - a.time);
}

// ========================= RETEST =========================
function retest(candles, p, currentTime = Date.now()) {
    const c = closed(candles);
    const levelPrice = p.level.price;
    const tol = levelPrice * CFG.RETEST_TOL;
    const invalidationBuffer = levelPrice * CFG.INVALIDATION_BUFFER_PCT;
    const atrValue = atr(candles) || levelPrice * 0.005;

    const after = c.filter(x => n(x[0]) > p.breakoutTime);
    if (!after.length) return { status: 'WAITING_RETEST', quality: 0 };

    if (currentTime - p.breakoutTime > CFG.RETEST_MIN) {
        return { status: 'EXPIRED', quality: 0 };
    }

    for (let i = 0; i < after.length; i++) {
        const x = after[i];
        const open = n(x[1]), high = n(x[2]), low = n(x[3]), close = n(x[4]);
        const range = Math.max(high - low, 1e-12);
        const touched = high >= levelPrice - tol && low <= levelPrice + tol;

        if (touched) {
            const body = Math.abs(close - open);
            const lowerWick = Math.min(open, close) - low;
            const upperWick = high - Math.max(open, close);

            if (p.direction === 'LONG') {
                const recovered = close >= levelPrice;
                const rejection = lowerWick / range >= 0.30;
                const healthy = close > open || rejection || body / range >= 0.45;
                if (recovered && healthy) {
                    let quality = 60;
                    if (rejection) quality += 15;
                    if (close > open) quality += 15;
                    if (body / range > 0.5) quality += 10;
                    return {
                        status: 'RETESTED',
                        quality: Math.min(100, quality),
                        candle: x,
                        retestTime: n(x[0])
                    };
                }
            } else {
                const recovered = close <= levelPrice;
                const rejection = upperWick / range >= 0.30;
                const healthy = close < open || rejection || body / range >= 0.45;
                if (recovered && healthy) {
                    let quality = 60;
                    if (rejection) quality += 15;
                    if (close < open) quality += 15;
                    if (body / range > 0.5) quality += 10;
                    return {
                        status: 'RETESTED',
                        quality: Math.min(100, quality),
                        candle: x,
                        retestTime: n(x[0])
                    };
                }
            }
        }

        if (p.direction === 'LONG' && close < levelPrice - invalidationBuffer) {
            return { status: 'INVALIDATED', quality: 0 };
        }
        if (p.direction === 'SHORT' && close > levelPrice + invalidationBuffer) {
            return { status: 'INVALIDATED', quality: 0 };
        }
    }

    const latestClose = n(after[after.length - 1][4]);
    const distanceATR = Math.abs(latestClose - levelPrice) / atrValue;
    if (distanceATR > CFG.MAX_BREAKOUT_EXTENSION_ATR) {
        return { status: 'MISSED_RETEST', quality: 0 };
    }

    return { status: 'WAITING_RETEST', quality: 0 };
}

// ========================= 5M TRIGGER =========================
function get5mTriggerPrice(closedCandles5m, direction, retestTime) {
    const c = Array.isArray(closedCandles5m) ? closedCandles5m : [];
    const after = c.filter(x => n(x[0]) > retestTime);
    if (after.length < 5) return null;

    const atr5m = trueRangeAvg(c, 14) || avg(after.map(x => n(x[2]) - n(x[3]))) * 0.5 || 0;

    const span = CFG.MICRO_PIVOT_SPAN;
    const pivotHighs = [];
    const pivotLows = [];
    for (let i = span; i < after.length - span; i++) {
        const hi = n(after[i][2]), lo = n(after[i][3]);
        let isH = true, isL = true;
        for (let j = 1; j <= span; j++) {
            if (hi <= n(after[i - j][2]) || hi <= n(after[i + j][2])) isH = false;
            if (lo >= n(after[i - j][3]) || lo >= n(after[i + j][3])) isL = false;
        }
        if (isH) pivotHighs.push({ price: hi, time: n(after[i][0]) });
        if (isL) pivotLows.push({ price: lo, time: n(after[i][0]) });
    }

    const lastCandleTime = n(after[after.length - 1][0]);

    if (direction === 'LONG') {
        const basis = pivotHighs.length
            ? pivotHighs[pivotHighs.length - 1].price
            : Math.max(...after.slice(-5).map(x => n(x[2])));
        return { price: basis + atr5m * 0.1, basisTime: lastCandleTime, micro: pivotHighs.length > 0 };
    }
    const basis = pivotLows.length
        ? pivotLows[pivotLows.length - 1].price
        : Math.min(...after.slice(-5).map(x => n(x[3])));
    return { price: basis - atr5m * 0.1, basisTime: lastCandleTime, micro: pivotLows.length > 0 };
}

// ========================= TRADE PLAN =========================
function createTradePlan(direction, levelPrice, theoreticalTrigger, executionPrice, candles) {
    const c = closed(candles);
    if (c.length < 20) return null;
    const volatility = atr(candles, 14) || n(c[c.length - 1][4]) * 0.005;

    const slippageATR = Math.abs(executionPrice - theoreticalTrigger) / Math.max(volatility, 1e-12);
    if (slippageATR > CFG.MAX_SLIPPAGE_ATR) return null;

    const recent = c.slice(-8);
    const swingLow = Math.min(...recent.map(x => n(x[3])));
    const swingHigh = Math.max(...recent.map(x => n(x[2])));

    let entry, stop;
    if (direction === 'LONG') {
        entry = executionPrice;
        stop = Math.min(swingLow, levelPrice - volatility * CFG.ATR_STOP);
        if (stop >= entry) stop = entry - volatility * CFG.ATR_STOP;
    } else {
        entry = executionPrice;
        stop = Math.max(swingHigh, levelPrice + volatility * CFG.ATR_STOP);
        if (stop <= entry) stop = entry + volatility * CFG.ATR_STOP;
    }

    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;

    let tp1, tp2, tp3;
    if (direction === 'LONG') {
        tp1 = entry + risk * CFG.MIN_RR;
        tp2 = entry + risk * CFG.TP2_RR;
        tp3 = entry + risk * CFG.TP3_RR;
    } else {
        tp1 = entry - risk * CFG.MIN_RR;
        tp2 = entry - risk * CFG.TP2_RR;
        tp3 = entry - risk * CFG.TP3_RR;
    }

    const rr = Math.abs(tp1 - entry) / risk;
    if (rr < CFG.MIN_RR) return null;

    const entryLow = executionPrice - volatility * 0.1;
    const entryHigh = executionPrice + volatility * 0.1;
    const entryZoneWidth = entryHigh - entryLow;
    const entryZoneWidthATR = entryZoneWidth / volatility;
    if (entryZoneWidthATR > CFG.MAX_ENTRY_DISTANCE_ATR) return null;

    return {
        entry,
        entryLow,
        entryHigh,
        stop,
        tp1,
        tp2,
        tp3,
        rr,
        entryZoneWidthATR,
        slippageATR
    };
}

// ========================= SCORE =========================
function calculateScore(data) {
    let score = 20;
    const breakdown = {
        base: 20, h4: 0, h2: 0, m15: 0, m5: 0,
        volume: 0, breakout: 0, retest: 0, level: 0,
        liquidity: 0, market: 0, contradiction: 0
    };
    const reasons = [];
    const { direction, h4Trend, h2Trend, m15Trend, m5Trend, volumeRatio, retestQuality,
            breakoutBodyAtr, bodyRatio, levelTouches, liquidityQuality, marketAlignment } = data;

    if (h4Trend === direction) { breakdown.h4 = 6; score += 6; reasons.push('4H uyumlu'); }
    else if (h4Trend !== 'NEUTRAL' && h4Trend !== direction) { breakdown.contradiction += 4; score -= 4; reasons.push('4H ters'); }
    if (h2Trend === direction) { breakdown.h2 = 5; score += 5; reasons.push('2H uyumlu'); }
    else if (h2Trend !== 'NEUTRAL' && h2Trend !== direction) { breakdown.contradiction += 3; score -= 3; reasons.push('2H ters'); }

    if (m15Trend === direction) { breakdown.m15 = 18; score += 18; reasons.push('15M yapı uyumlu'); }
    else if (m15Trend !== 'NEUTRAL') { breakdown.contradiction += 6; score -= 6; reasons.push('15M yapı ters'); }

    if (m5Trend === direction) { breakdown.m5 = 14; score += 14; reasons.push('5M teyit güçlü'); }

    if (volumeRatio >= 2.5) { breakdown.volume = 8; score += 8; reasons.push('hacim çok güçlü'); }
    else if (volumeRatio >= 1.7) { breakdown.volume = 6; score += 6; reasons.push('hacim güçlü'); }
    else if (volumeRatio >= 1.3) { breakdown.volume = 4; score += 4; reasons.push('hacim iyi'); }
    else if (volumeRatio >= 1.1) { breakdown.volume = 2; score += 2; reasons.push('hacim normal'); }

    if (breakoutBodyAtr >= 0.6 && bodyRatio >= 0.6) { breakdown.breakout += 8; score += 8; reasons.push('güçlü breakout mumu'); }
    else if (breakoutBodyAtr >= 0.45 && bodyRatio >= 0.4) { breakdown.breakout += 5; score += 5; reasons.push('iyi breakout'); }
    else { breakdown.breakout += 2; score += 2; reasons.push('zayıf breakout'); }

    if (retestQuality >= 80) { breakdown.retest = 20; score += 20; reasons.push('mükemmel retest'); }
    else if (retestQuality >= 60) { breakdown.retest = 13; score += 13; reasons.push('iyi retest'); }
    else { breakdown.retest += 6; score += 6; reasons.push('orta retest'); }

    if (levelTouches >= 4) { breakdown.level = 5; score += 5; reasons.push('çok güçlü seviye'); }
    else if (levelTouches >= 3) { breakdown.level = 3; score += 3; reasons.push('güçlü seviye'); }
    else { breakdown.level = 1; score += 1; reasons.push('normal seviye'); }

    if (liquidityQuality === 'high') { breakdown.liquidity = 4; score += 4; reasons.push('yüksek likidite'); }
    else if (liquidityQuality === 'medium') { breakdown.liquidity = 2; score += 2; reasons.push('orta likidite'); }
    else { breakdown.liquidity = 0; breakdown.contradiction += 4; score -= 4; reasons.push('düşük likidite'); }

    if (marketAlignment === 'aligned') { breakdown.market = 4; score += 4; reasons.push('piyasa uyumlu'); }
    else if (marketAlignment === 'neutral') { breakdown.market = 1; score += 1; reasons.push('piyasa nötr'); }
    else { breakdown.contradiction += 4; score -= 4; reasons.push('piyasa ters'); }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, breakdown, reasons };
}

// ========================= SETUP ENGINE =========================
function processSetup(setup, context) {
    const { h4Trend, h2Trend, m15Trend, m5Trend, rsiValue, liquidityQuality, marketAlignment } = context;

    const trendAlignment = getAlignmentScore(h4Trend, h2Trend, m15Trend, setup.direction);
    if (trendAlignment === 'FULL_CONTRADICTION') {
        if (CFG.DEBUG) console.log(`[${setup.symbol || '?'}] REJECTED_ALIGNMENT`);
        return { status: 'REJECTED_ALIGNMENT', rejectReason: 'FULL_CONTRADICTION' };
    }

    const current = n(setup.candles[setup.candles.length - 1][4]);
    const volatility = atr(setup.candles, 14);
    const distanceATR = Math.abs(current - setup.executionPrice) / volatility;
    if (distanceATR > CFG.MAX_ENTRY_DISTANCE_ATR) {
        if (CFG.DEBUG) console.log(`[${setup.symbol || '?'}] MISSED_ENTRY (distance ${distanceATR.toFixed(2)} ATR)`);
        return { status: 'MISSED_ENTRY', rejectReason: 'ENTRY_DISTANCE' };
    }

    const scored = calculateScore({
        direction: setup.direction,
        h4Trend,
        h2Trend,
        m15Trend,
        m5Trend,
        volumeRatio: setup.breakoutVolumeRatio,
        retestQuality: setup.retestQuality,
        breakoutBodyAtr: setup.breakoutBodyATR,
        bodyRatio: setup.breakoutBodyRatio,
        levelTouches: setup.levelTouches,
        liquidityQuality,
        marketAlignment
    });

    if (scored.score < CFG.MIN_SCORE) {
        if (CFG.DEBUG) console.log(`[${setup.symbol || '?'}] REJECTED_SCORE ${scored.score}`);
        return { status: 'REJECTED_SCORE', rejectReason: `SCORE_${scored.score}`, score: scored.score };
    }

    const plan = createTradePlan(setup.direction, setup.level, setup.triggerPrice, setup.executionPrice, setup.candles);
    if (!plan) {
        if (CFG.DEBUG) console.log(`[${setup.symbol || '?'}] REJECTED_RR`);
        return { status: 'REJECTED_RR', rejectReason: 'RR_OR_SLIPPAGE_OR_ENTRY_DISTANCE' };
    }

    if (CFG.DEBUG) console.log(`[${setup.symbol || '?'}] CONFIRMED -> SCORE ${scored.score} -> SIGNAL_CREATED`);
    return {
        status: 'SIGNAL_CREATED',
        score: scored.score,
        breakdown: scored.breakdown,
        reasons: scored.reasons,
        plan,
        trendAlignment,
        rsiValue,
        triggerPrice: setup.triggerPrice,
        executionPrice: setup.executionPrice
    };
}

function getAlignmentScore(h4, h2, m15, direction) {
    if (h4 === direction && h2 === direction && m15 === direction) return 'STRONG_ALIGNMENT';
    if ((h4 === direction || h4 === 'NEUTRAL') && (h2 === direction || h2 === 'NEUTRAL')) return 'PARTIAL_ALIGNMENT';
    if (h4 !== direction && h2 !== direction && h4 !== 'NEUTRAL' && h2 !== 'NEUTRAL') return 'FULL_CONTRADICTION';
    return 'CONTRADICTION';
}

// ========================= PENDING STATE =========================
function createPending(symbol, direction, tf, breakout, cluster, currentTime = Date.now()) {
    const clean = cleanSymbol(symbol);
    const existing = [...STATE.pending.values()].find(p =>
        p.symbol === clean && p.direction === direction);
    if (existing) {
        if (cluster.combinedTouches > (existing.levelTouches || 0) ||
            breakout.breakoutBodyAtr > (existing.breakoutBodyATR || 0)) {
            STATE.pending.delete(existing.key);
        } else {
            return;
        }
    }
    const key = [clean, direction, tf, fmt(cluster.price)].join('|');
    const cooldown = STATE.cooldowns.get(key);
    if (cooldown && currentTime - cooldown < CFG.COOLDOWN) return;

    STATE.pending.set(key, {
        key,
        symbol: clean,
        direction,
        timeframeLevel: tf,
        level: cluster.price,
        cluster: cluster,
        breakoutTime: breakout.time,
        breakoutVolumeRatio: breakout.breakoutVolumeRatio,
        breakoutBodyATR: breakout.breakoutBodyAtr,
        breakoutBodyRatio: breakout.bodyRatio,
        levelTouches: cluster.combinedTouches,
        state: 'BREAKOUT_DETECTED',
        createdAt: currentTime,
        updatedAt: currentTime,
        retestTime: null,
        retestQuality: 0,
        candles: null,
        candles5m: null,
        triggerPrice: null,
        triggerBasisTime: null,
        triggerCalculatedAt: null,
        triggerIsMicroStructure: false,
        lastEvaluatedCandleTime: null,
        executionPrice: null,
        triggerTime: null,
        triggerCandle: null,
        triggerConfirmed: false
    });
    // breakout sayacını artır
    STATE.stats.breakoutCount++;
    if (CFG.DEBUG) console.log(`[${clean}] BREAKOUT_DETECTED ${direction} @ ${fmt(cluster.price)} (${tf})`);
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    const symbol = row.symbol;
    try {
        const [h1, m15, m5, h4] = await Promise.all([
            getCandles(symbol, '1h', CFG.H1_HISTORY),
            getCandles(symbol, '15m', CFG.M15),
            getCandles(symbol, '5m', CFG.M5),
            getCandles(symbol, '4h', CFG.H4_HISTORY)
        ]);
        if (h1.length < 220 || h4.length < 55 || m15.length < 35 || m5.length < 15) return null;
        const h2 = aggregateCandles(h1, 2);
        if (h2.length < 55) return null;

        const h4Trend = trend(h4);
        const h2Trend = trend(h2);
        const m15Trend = structure(m15);
        const m5Trend = trend(m5);

        const l4 = getLevels(h4, '4H');
        const l2 = getLevels(h2, '2H');
        if (!l4.length && !l2.length) return null;
        const clusters = clusterLevels(l4, l2);
        if (!clusters.length) return null;

        const currentTime = Date.now();
        const breakouts = detectBreakouts(m15, clusters, currentTime);
        for (const breakout of breakouts) {
            const cluster = clusters.find(c =>
                c.type === (breakout.direction === 'LONG' ? 'resistance' : 'support') &&
                Math.abs(c.price - breakout.level.price) / c.price < 0.0035);
            if (!cluster) continue;
            createPending(symbol, breakout.direction, cluster.timeframeSource, breakout, cluster, currentTime);
        }

        const currentRsi = rsi(m15);
        const pendings = [...STATE.pending.values()].filter(p => p.symbol === cleanSymbol(symbol));
        for (const pending of pendings) {
            pending.candles = m15;
            pending.candles5m = m5;

            if (pending.state === 'BREAKOUT_DETECTED' || pending.state === 'WAITING_RETEST') {
                const rt = retest(m15, pending, currentTime);
                pending.state = rt.status;
                pending.updatedAt = currentTime;

                if (rt.status === 'EXPIRED') {
                    STATE.pending.delete(pending.key);
                    STATE.cooldowns.set(pending.key, currentTime);
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] EXPIRED`);
                    continue;
                }
                if (rt.status === 'INVALIDATED') {
                    STATE.pending.delete(pending.key);
                    STATE.cooldowns.set(pending.key, currentTime);
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] INVALIDATED`);
                    continue;
                }
                if (rt.status === 'MISSED_RETEST') {
                    STATE.pending.delete(pending.key);
                    STATE.cooldowns.set(pending.key, currentTime);
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] MISSED_RETEST`);
                    continue;
                }
                if (rt.status === 'RETESTED') {
                    pending.retestQuality = rt.quality;
                    pending.retestTime = rt.retestTime;
                    pending.state = 'RETESTED';
                    pending.lastEvaluatedCandleTime = rt.retestTime;
                    STATE.stats.retestedCount++;
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] RETESTED quality=${rt.quality}`);
                }
            }

            if (pending.state === 'RETESTED' || pending.state === 'WAITING_5M') {
                if (!pending.retestTime) continue;
                if (!pending.lastEvaluatedCandleTime) pending.lastEvaluatedCandleTime = pending.retestTime;

                if (!pending.triggerPrice) {
                    const trig = get5mTriggerPrice(closed(m5), pending.direction, pending.retestTime);
                    if (!trig) {
                        pending.state = 'WAITING_5M';
                        if (CFG.DEBUG) console.log(`[${pending.symbol}] WAITING_5M (trigger hesaplanamadı)`);
                        continue;
                    }
                    pending.triggerPrice = trig.price;
                    pending.triggerBasisTime = trig.basisTime;
                    pending.triggerCalculatedAt = currentTime;
                    pending.triggerIsMicroStructure = trig.micro;
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] Trigger fiyatı: ${fmt(pending.triggerPrice)} (micro=${trig.micro})`);
                }

                const newCandles = closed(m5).filter(x => n(x[0]) > pending.lastEvaluatedCandleTime);
                if (!newCandles.length) {
                    pending.state = 'WAITING_5M';
                    continue;
                }

                let triggered = false;
                let triggerCandle = null;
                for (const candle of newCandles) {
                    pending.lastEvaluatedCandleTime = n(candle[0]);
                    if (pending.direction === 'LONG' && n(candle[4]) >= pending.triggerPrice) {
                        triggered = true;
                        triggerCandle = candle;
                        break;
                    }
                    if (pending.direction === 'SHORT' && n(candle[4]) <= pending.triggerPrice) {
                        triggered = true;
                        triggerCandle = candle;
                        break;
                    }
                }

                if (!triggered) {
                    pending.state = 'WAITING_5M';
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] WAITING_5M (trigger kırılmadı, hedef: ${fmt(pending.triggerPrice)})`);
                    continue;
                }

                pending.triggerConfirmed = true;
                pending.triggerTime = n(triggerCandle[0]);
                pending.triggerCandle = triggerCandle;
                pending.executionPrice = n(triggerCandle[4]);
                pending.state = 'CONFIRMED';
                STATE.stats.triggerConfirmedCount++;
                if (CFG.DEBUG) console.log(`[${pending.symbol}] 5M TRIGGER KIRILDI @ ${fmt(pending.triggerPrice)} / execution ${fmt(pending.executionPrice)} (time ${new Date(pending.triggerTime).toISOString()})`);

                const liquidityQuality = row.spread && row.spread < 0.0005 ? 'high' :
                                        row.spread && row.spread < 0.001 ? 'medium' : 'low';
                const marketDirection = STATE.market.direction;
                const marketAlignment = marketDirection === pending.direction ? 'aligned' :
                                       marketDirection === 'FLAT' ? 'neutral' : 'contradiction';

                const result = processSetup(pending, {
                    h4Trend, h2Trend, m15Trend, m5Trend,
                    rsiValue: currentRsi,
                    liquidityQuality,
                    marketAlignment
                });

                if (result.status === 'REJECTED_ALIGNMENT' || result.status === 'REJECTED_SCORE' ||
                    result.status === 'REJECTED_RR' || result.status === 'MISSED_ENTRY') {
                    if (result.status === 'REJECTED_SCORE') STATE.stats.rejectedScore++;
                    STATE.pending.delete(pending.key);
                    if (CFG.DEBUG) console.log(`[${pending.symbol}] ${result.status}`);
                    continue;
                }

                const duplicate = [...STATE.signals.values()].some(sig =>
                    sig.symbol === pending.symbol && sig.direction === pending.direction);
                if (duplicate) continue;

                const now = Date.now();
                STATE.pending.delete(pending.key);
                const signal = {
                    id: [pending.symbol, pending.direction, now].join('|'),
                    symbol: pending.symbol,
                    marketSymbol: symbol,
                    direction: pending.direction,
                    score: result.score,
                    confidence: result.score,
                    currentPrice: row.price,
                    entry: result.plan.entry,
                    entryLow: result.plan.entryLow,
                    entryHigh: result.plan.entryHigh,
                    stop: result.plan.stop,
                    stopLoss: result.plan.stop,
                    tp1: result.plan.tp1,
                    tp2: result.plan.tp2,
                    tp3: result.plan.tp3,
                    rr: Number(result.plan.rr.toFixed(2)),
                    rsi: Number(currentRsi.toFixed(1)),
                    volumeRatio: Number(pending.breakoutVolumeRatio.toFixed(2)),
                    breakoutLevel: pending.level,
                    timeframeLevel: pending.timeframeLevel,
                    h4Trend, h2Trend, m15Trend, m5Trend,
                    retestQuality: pending.retestQuality,
                    fiveMinuteConfirmed: true,
                    status: 'GİRİŞ BEKLENİYOR',
                    entryReady: false,
                    reason: result.reasons.join(' + '),
                    reasons: result.reasons,
                    scoreBreakdown: result.breakdown,
                    quality: {
                        levelStrength: pending.levelTouches >= 4 ? 'çok güçlü' : pending.levelTouches >= 3 ? 'güçlü' : 'normal',
                        breakoutQuality: pending.breakoutBodyATR >= 0.6 ? 'yüksek' : 'orta',
                        volumeQuality: pending.breakoutVolumeRatio >= 1.7 ? 'güçlü' : pending.breakoutVolumeRatio >= 1.3 ? 'iyi' : 'normal',
                        retestQuality: pending.retestQuality >= 70 ? 'yüksek' : 'orta',
                        trendAlignment: result.trendAlignment,
                        marketAlignment,
                        liquidityQuality,
                        microStructureTrigger: pending.triggerIsMicroStructure
                    },
                    breakoutTime: pending.breakoutTime,
                    retestTime: pending.retestTime,
                    triggerPrice: result.triggerPrice,
                    triggerBasisTime: pending.triggerBasisTime,
                    triggerCalculatedAt: pending.triggerCalculatedAt,
                    executionPrice: result.executionPrice,
                    slippageATR: result.plan.slippageATR,
                    triggerTime: pending.triggerTime,
                    signalAt: now,
                    cooldownKey: pending.key,
                    paperEntry: null,
                    entryTime: null,
                    maeR: null,
                    mfeR: null
                };
                STATE.signals.set(signal.id, signal);
                STATE.performance.signalsToday++;
                STATE.stats.finalSignals++;
                if (CFG.DEBUG) {
                    console.log(`[${pending.symbol}] SIGNAL CREATED SCORE ${result.score} ${pending.direction}`);
                    console.log(`  Score Breakdown:`, result.breakdown);
                }
                while (STATE.signals.size > 15) {
                    const first = STATE.signals.keys().next().value;
                    STATE.signals.delete(first);
                }
            }
        }
    } catch (error) {
        console.error(`Analiz hatası (${symbol}):`, error.message);
        STATE.stats.errors++;
    }
    return null;
}

// ========================= OPPORTUNITY SCORE =========================
function computeOpportunityScore(candles, ticker) {
    const c = closed(candles);
    if (c.length < 30) return 0;
    const last = c[c.length - 1];
    const price = n(last[4]);
    if (!price) return 0;

    let score = 0;

    // 1. Range compression (son 20 vs son 5)
    const ranges = c.map(x => n(x[2]) - n(x[3]));
    const avgRange20 = avg(ranges.slice(-20));
    const avgRange5 = avg(ranges.slice(-5));
    const compression = avgRange5 > 0 ? avgRange20 / avgRange5 : 1;
    if (compression >= 1.5) score += 15;
    else if (compression >= 1.2) score += 8;

    // 2. Volume ratio
    const vols = c.map(x => n(x[5]));
    const avgVol = avg(vols.slice(-20));
    const volRatio = avgVol > 0 ? n(last[5]) / avgVol : 1;
    if (volRatio >= 2.0) score += 15;
    else if (volRatio >= 1.4) score += 8;

    // 3. ATR expansion
    const atr14 = atr(candles, 14);
    const atr7 = atr(candles, 7);
    const atrExpansion = atr7 > 0 ? atr14 / atr7 : 1;
    if (atrExpansion >= 1.3) score += 10;

    // 4. Momentum
    const price5 = n(c[c.length - 5][4]);
    const mom = price5 > 0 ? (price - price5) / price5 * 100 : 0;
    if (Math.abs(mom) >= 1.5) score += 10;
    else if (Math.abs(mom) >= 0.8) score += 5;

    // 5. Breakout proximity: local pivot seviyelerine yakınlık
    const piv = pivots(candles);
    const resistances = piv.filter(p => p.type === 'resistance').map(p => p.price);
    const supports = piv.filter(p => p.type === 'support').map(p => p.price);
    let closestRes = Infinity, closestSup = Infinity;
    if (resistances.length) closestRes = resistances.reduce((a, b) => Math.abs(a - price) < Math.abs(b - price) ? a : b);
    if (supports.length) closestSup = supports.reduce((a, b) => Math.abs(a - price) < Math.abs(b - price) ? a : b);
    const distToLevel = Math.min(Math.abs(closestRes - price), Math.abs(closestSup - price)) / price;
    if (distToLevel < 0.005) score += 15;
    else if (distToLevel < 0.01) score += 8;

    // 6. Breakout candle quality (son mum)
    const body = Math.abs(n(last[4]) - n(last[1]));
    const range = n(last[2]) - n(last[3]);
    const bodyRatio = range > 0 ? body / range : 0;
    const upperWick = (n(last[2]) - Math.max(n(last[1]), n(last[4]))) / range;
    const lowerWick = (Math.min(n(last[1]), n(last[4])) - n(last[3])) / range;
    if (bodyRatio >= 0.6) score += 10;
    else if (bodyRatio >= 0.4) score += 5;
    if (upperWick < 0.2 && lowerWick < 0.2) score += 5;

    // 7. Price level distance (fiyatın seviyelere göre pozisyonu)
    if (closestRes < Infinity && price > closestRes * 0.995 && price < closestRes * 1.005) {
        score += 10;
    } else if (closestSup < Infinity && price < closestSup * 1.005 && price > closestSup * 0.995) {
        score += 10;
    }

    score = Math.min(100, Math.round(score));
    return score;
}

// ========================= SCAN =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.errors = 0;
    STATE.stats.opportunityCount = 0;
    STATE.stats.deepSelected = 0;
    STATE.stats.breakoutCount = 0;
    STATE.stats.retestedCount = 0;
    STATE.stats.triggerConfirmedCount = 0;
    STATE.stats.rejectedScore = 0;
    STATE.stats.finalSignals = 0;

    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);

        // candidates: volume filtresi ve volume sıralaması (24H change/volume kaldırıldı)
        let candidates = rows.filter(r => r.volume >= CFG.MIN_VOLUME_USDT)
            .sort((a, b) => b.volume - a.volume)
            .slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;

        console.log(`RADAR: ${STATE.stats.universe}`);
        console.log(`CANDIDATES: ${candidates.length}`);

        // 15M OPPORTUNITY SCAN
        const opportunityResults = [];
        for (let i = 0; i < candidates.length; i += CFG.CONCURRENCY) {
            const batch = candidates.slice(i, i + CFG.CONCURRENCY);
            const results = await Promise.all(batch.map(async row => {
                try {
                    const candles15m = await getCandles(row.symbol, '15m', CFG.M15);
                    const score = computeOpportunityScore(candles15m, row);
                    return { row, score, candles15m };
                } catch (e) {
                    console.error(`Opportunity scan error ${row.symbol}:`, e.message);
                    return { row, score: 0, candles15m: [] };
                }
            }));
            opportunityResults.push(...results);
            await sleep(250);
        }

        opportunityResults.sort((a, b) => b.score - a.score);
        const deepCandidates = opportunityResults.slice(0, CFG.DEEP).map(r => r.row);
        STATE.deep = deepCandidates;
        STATE.stats.deep = deepCandidates.length;
        STATE.stats.opportunityCount = opportunityResults.length;
        STATE.stats.deepSelected = deepCandidates.length;

        console.log(`15M OPPORTUNITIES: ${opportunityResults.length}`);
        console.log(`DEEP SELECTED: ${deepCandidates.length}`);

        // Ağır analiz: sadece deepCandidates için
        STATE.stats.analyzed = 0;
        for (let i = 0; i < deepCandidates.length; i += CFG.CONCURRENCY) {
            const batch = deepCandidates.slice(i, i + CFG.CONCURRENCY);
            await Promise.all(batch.map(async row => {
                await analyzeCoin(row);
                STATE.stats.analyzed++;
            }));
            await sleep(250);
        }

        STATE.lastScan = Date.now();
        console.log(`BREAKOUTS: ${STATE.stats.breakoutCount}`);
        console.log(`RETESTED: ${STATE.stats.retestedCount}`);
        console.log(`5M CONFIRMED: ${STATE.stats.triggerConfirmedCount}`);
        console.log(`REJECTED_SCORE: ${STATE.stats.rejectedScore}`);
        console.log(`FINAL SIGNALS: ${STATE.stats.finalSignals}`);
        console.log(`Tarama tamamlandı. Analiz: ${STATE.stats.analyzed}, Sinyal: ${STATE.signals.size}, Pending: ${STATE.pending.size}`);
    } catch (error) {
        STATE.lastError = error.message;
        STATE.stats.errors++;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
        STATE.stats.pending = STATE.pending.size;
        STATE.stats.signals = STATE.signals.size;
        broadcast();
    }
}

// ========================= LIVE SIGNALS =========================
async function updateLiveSignals() {
    if (!STATE.signals.size) return;
    let tickers;
    try {
        tickers = await exchange.fetchTickers();
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

        if (CFG.PAPER_MODE && !signal.paperEntry && !signal.entryReady) {
            const inZone = current >= signal.entryLow && current <= signal.entryHigh;
            if (inZone) {
                signal.paperEntry = current;
                signal.entryTime = now;
                signal.entryReady = true;
                signal.status = 'PAPER_ENTRY';
            }
        }

        if (signal.paperEntry || !CFG.PAPER_MODE) {
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
                else if (signal.paperEntry) signal.status = 'PAPER_ACTIVE';
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
                else if (signal.paperEntry) signal.status = 'PAPER_ACTIVE';
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
    STATE.stats.pending = STATE.pending.size;
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
    else if (result === 'TP1') rMultiple = CFG.MIN_RR;
    else if (result === 'TP2') rMultiple = CFG.TP2_RR;
    else if (result === 'TP3') rMultiple = CFG.TP3_RR;
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

    const closedTrades = STATE.signalHistory.filter(s => s.maeR !== null && s.mfeR !== null);
    if (closedTrades.length) {
        perf.averageMAE = avg(closedTrades.map(s => s.maeR));
        perf.averageMFE = avg(closedTrades.map(s => s.mfeR));
    }
}

// ========================= CLEANUP =========================
function cleanup() {
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) STATE.signals.delete(id);
    }
    for (const [key, pending] of STATE.pending) {
        if (now - pending.breakoutTime > CFG.RETEST_MIN) STATE.pending.delete(key);
    }
    for (const [key, time] of STATE.cooldowns) {
        if (now - time > CFG.COOLDOWN) STATE.cooldowns.delete(key);
    }
    STATE.stats.pending = STATE.pending.size;
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
        if (r.change > 0) green++;
        else if (r.change < 0) red++;
        total += r.change;
    }
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / rows.length;
    let direction = 'FLAT', label = 'YATAY / KARIŞIK';
    if (breadth >= 60 && average >= 0.35) { direction = 'LONG'; label = 'POZİTİF / YÜKSELİŞ'; }
    else if (breadth <= 40 && average <= -0.35) { direction = 'SHORT'; label = 'NEGATİF / DÜŞÜŞ'; }
    STATE.market = {
        label,
        direction,
        breadth: Number(breadth.toFixed(1)),
        green,
        red,
        average: Number(average.toFixed(2)),
        btc: 'NEUTRAL',
        eth: 'NEUTRAL'
    };
}

// ========================= BACKTEST =========================
async function runBacktest(symbol) {
    const market = findMarket(symbol);
    if (!market) return { error: 'Market bulunamadı' };

    const [h1, m15, m5, h4] = await Promise.all([
        getCandles(market.symbol, '1h', CFG.H1_HISTORY),
        getCandles(market.symbol, '15m', CFG.M15),
        getCandles(market.symbol, '5m', CFG.M5),
        getCandles(market.symbol, '4h', CFG.H4_HISTORY)
    ]);
    if (h1.length < 220 || h4.length < 55 || m15.length < 35 || m5.length < 15) {
        return { error: 'Yetersiz veri' };
    }

    const h2 = aggregateCandles(h1, 2);
    const closed5m = closed(m5);
    const results = [];

    for (let i = 60; i < closed5m.length - 1; i++) {
        const currentTime = n(closed5m[i][0]);

        if (currentTime % 900000 !== 0) continue;

        const h4Slice = h4.filter(c => n(c[0]) <= currentTime);
        const h2Slice = h2.filter(c => n(c[0]) <= currentTime);
        const m15Slice = m15.filter(c => n(c[0]) <= currentTime);
        const m5Slice = closed5m.slice(0, i + 1);

        if (h4Slice.length < 55 || h2Slice.length < 55 || m15Slice.length < 35 || m5Slice.length < 15) continue;

        const h4Trend = trend(h4Slice);
        const h2Trend = trend(h2Slice);
        const m15Trend = structure(m15Slice);
        const m5Trend = trend(m5Slice);

        const l4 = getLevels(h4Slice, '4H');
        const l2 = getLevels(h2Slice, '2H');
        if (!l4.length && !l2.length) continue;
        const clusters = clusterLevels(l4, l2);

        const breakouts = detectBreakouts(m15Slice, clusters, currentTime);

        for (const breakout of breakouts) {
            const cluster = clusters.find(c =>
                c.type === (breakout.direction === 'LONG' ? 'resistance' : 'support') &&
                Math.abs(c.price - breakout.level.price) / c.price < 0.0035);
            if (!cluster) continue;

            const rt = retest(m15Slice, {
                level: { price: cluster.price },
                direction: breakout.direction,
                breakoutTime: breakout.time
            }, currentTime);

            if (rt.status !== 'RETESTED') continue;

            const basisSlice = closed5m.slice(0, i);
            const trig = get5mTriggerPrice(basisSlice, breakout.direction, rt.retestTime);
            if (!trig) continue;
            const triggerPrice = trig.price;

            const current5mCandle = closed5m[i];
            let triggerBroken = false;
            if (breakout.direction === 'LONG' && n(current5mCandle[4]) >= triggerPrice) {
                triggerBroken = true;
            } else if (breakout.direction === 'SHORT' && n(current5mCandle[4]) <= triggerPrice) {
                triggerBroken = true;
            }

            if (triggerBroken) {
                const executionPrice = n(current5mCandle[4]);
                const setupResult = processSetup({
                    direction: breakout.direction,
                    level: cluster.price,
                    breakoutVolumeRatio: breakout.breakoutVolumeRatio,
                    breakoutBodyATR: breakout.breakoutBodyAtr,
                    breakoutBodyRatio: breakout.bodyRatio,
                    levelTouches: cluster.combinedTouches,
                    retestQuality: rt.quality,
                    candles: m15Slice,
                    candles5m: m5Slice,
                    retestTime: rt.retestTime,
                    triggerPrice: triggerPrice,
                    executionPrice: executionPrice,
                    symbol: cleanSymbol(symbol)
                }, {
                    h4Trend,
                    h2Trend,
                    m15Trend,
                    m5Trend,
                    rsiValue: rsi(m15Slice),
                    liquidityQuality: 'unknown',
                    marketAlignment: 'neutral'
                });

                if (setupResult.status === 'SIGNAL_CREATED') {
                    const plan = setupResult.plan;
                    const entryPrice = plan.entry;
                    const risk = Math.abs(entryPrice - plan.stop);
                    let exit = null;
                    let exitPrice = null;
                    let maeR = null, mfeR = null;

                    const high = n(current5mCandle[2]);
                    const low = n(current5mCandle[3]);
                    if (breakout.direction === 'LONG') {
                        if (low <= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; }
                        else if (high >= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; }
                        else if (high >= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; }
                        else if (high >= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; }
                    } else {
                        if (high >= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; }
                        else if (low <= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; }
                        else if (low <= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; }
                        else if (low <= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; }
                    }

                    if (!exit) {
                        for (let j = i + 1; j < closed5m.length; j++) {
                            const h = n(closed5m[j][2]);
                            const l = n(closed5m[j][3]);
                            if (breakout.direction === 'LONG') {
                                const mfe = (h - entryPrice) / risk;
                                const mae = (entryPrice - l) / risk;
                                if (mfeR === null || mfe > mfeR) mfeR = mfe;
                                if (maeR === null || -mae < maeR) maeR = -mae;
                            } else {
                                const mfe = (entryPrice - l) / risk;
                                const mae = (h - entryPrice) / risk;
                                if (mfeR === null || mfe > mfeR) mfeR = mfe;
                                if (maeR === null || -mae < maeR) maeR = -mae;
                            }
                            if (breakout.direction === 'LONG') {
                                if (l <= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; break; }
                                if (h >= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; break; }
                                if (h >= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; break; }
                                if (h >= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; break; }
                            } else {
                                if (h >= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; break; }
                                if (l <= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; break; }
                                if (l <= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; break; }
                                if (l <= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; break; }
                            }
                        }
                    }

                    if (exit) {
                        results.push({
                            key: `${cleanSymbol(symbol)}|${breakout.direction}|${breakout.time}`,
                            direction: breakout.direction,
                            entry: entryPrice,
                            stop: plan.stop,
                            tp1: plan.tp1,
                            tp2: plan.tp2,
                            tp3: plan.tp3,
                            exit,
                            exitPrice,
                            score: setupResult.score,
                            breakoutTime: breakout.time,
                            retestTime: rt.retestTime,
                            triggerTime: currentTime,
                            slippageATR: plan.slippageATR,
                            maeR,
                            mfeR
                        });
                    }
                }
            } else {
                for (let j = i + 1; j < closed5m.length; j++) {
                    const h = n(closed5m[j][2]);
                    const l = n(closed5m[j][3]);
                    const c5 = n(closed5m[j][4]);

                    let broken = false;
                    if (breakout.direction === 'LONG' && c5 >= triggerPrice) broken = true;
                    if (breakout.direction === 'SHORT' && c5 <= triggerPrice) broken = true;

                    if (broken) {
                        const executionPrice = c5;
                        const setupResult = processSetup({
                            direction: breakout.direction,
                            level: cluster.price,
                            breakoutVolumeRatio: breakout.breakoutVolumeRatio,
                            breakoutBodyATR: breakout.breakoutBodyAtr,
                            breakoutBodyRatio: breakout.bodyRatio,
                            levelTouches: cluster.combinedTouches,
                            retestQuality: rt.quality,
                            candles: m15Slice,
                            candles5m: m5Slice,
                            retestTime: rt.retestTime,
                            triggerPrice: triggerPrice,
                            executionPrice: executionPrice,
                            symbol: cleanSymbol(symbol)
                        }, {
                            h4Trend,
                            h2Trend,
                            m15Trend,
                            m5Trend,
                            rsiValue: rsi(m15Slice),
                            liquidityQuality: 'unknown',
                            marketAlignment: 'neutral'
                        });

                        if (setupResult.status === 'SIGNAL_CREATED') {
                            const plan = setupResult.plan;
                            const entryPrice = plan.entry;
                            const risk = Math.abs(entryPrice - plan.stop);
                            let exit = null;
                            let exitPrice = null;
                            let maeR = null, mfeR = null;

                            const high = h;
                            const low = l;
                            if (breakout.direction === 'LONG') {
                                if (low <= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; }
                                else if (high >= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; }
                                else if (high >= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; }
                                else if (high >= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; }
                            } else {
                                if (high >= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; }
                                else if (low <= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; }
                                else if (low <= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; }
                                else if (low <= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; }
                            }

                            if (!exit) {
                                for (let k = j + 1; k < closed5m.length; k++) {
                                    const h2 = n(closed5m[k][2]);
                                    const l2 = n(closed5m[k][3]);
                                    if (breakout.direction === 'LONG') {
                                        const mfe = (h2 - entryPrice) / risk;
                                        const mae = (entryPrice - l2) / risk;
                                        if (mfeR === null || mfe > mfeR) mfeR = mfe;
                                        if (maeR === null || -mae < maeR) maeR = -mae;
                                    } else {
                                        const mfe = (entryPrice - l2) / risk;
                                        const mae = (h2 - entryPrice) / risk;
                                        if (mfeR === null || mfe > mfeR) mfeR = mfe;
                                        if (maeR === null || -mae < maeR) maeR = -mae;
                                    }
                                    if (breakout.direction === 'LONG') {
                                        if (l2 <= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; break; }
                                        if (h2 >= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; break; }
                                        if (h2 >= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; break; }
                                        if (h2 >= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; break; }
                                    } else {
                                        if (h2 >= plan.stop) { exit = 'STOP'; exitPrice = plan.stop; break; }
                                        if (l2 <= plan.tp3) { exit = 'TP3'; exitPrice = plan.tp3; break; }
                                        if (l2 <= plan.tp2) { exit = 'TP2'; exitPrice = plan.tp2; break; }
                                        if (l2 <= plan.tp1) { exit = 'TP1'; exitPrice = plan.tp1; break; }
                                    }
                                }
                            }

                            if (exit) {
                                results.push({
                                    key: `${cleanSymbol(symbol)}|${breakout.direction}|${breakout.time}`,
                                    direction: breakout.direction,
                                    entry: entryPrice,
                                    stop: plan.stop,
                                    tp1: plan.tp1,
                                    tp2: plan.tp2,
                                    tp3: plan.tp3,
                                    exit,
                                    exitPrice,
                                    score: setupResult.score,
                                    breakoutTime: breakout.time,
                                    retestTime: rt.retestTime,
                                    triggerTime: n(closed5m[j][0]),
                                    slippageATR: plan.slippageATR,
                                    maeR,
                                    mfeR
                                });
                            }
                        }
                        break;
                    }
                    if (n(closed5m[j][0]) - currentTime > 3600000) break;
                }
            }
        }
    }

    let wins = 0, losses = 0, totalR = 0, grossProfitR = 0, grossLossR = 0;
    let sumMAE = 0, sumMFE = 0, validCount = 0;
    let maxDrawdown = 0, peakR = 0, cumR = 0;
    let bestTrade = null, worstTrade = null;
    for (const r of results) {
        let rMultiple = 0;
        if (r.exit === 'STOP') { losses++; rMultiple = -1; grossLossR += 1; }
        else if (r.exit === 'TP1') { wins++; rMultiple = CFG.MIN_RR; grossProfitR += CFG.MIN_RR; }
        else if (r.exit === 'TP2') { wins++; rMultiple = CFG.TP2_RR; grossProfitR += CFG.TP2_RR; }
        else if (r.exit === 'TP3') { wins++; rMultiple = CFG.TP3_RR; grossProfitR += CFG.TP3_RR; }
        totalR += rMultiple;
        if (r.maeR !== null) { sumMAE += r.maeR; sumMFE += r.mfeR; validCount++; }
        cumR += rMultiple;
        if (cumR > peakR) peakR = cumR;
        const dd = peakR - cumR;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (!bestTrade || rMultiple > bestTrade.r) bestTrade = { ...r, r: rMultiple };
        if (!worstTrade || rMultiple < worstTrade.r) worstTrade = { ...r, r: rMultiple };
    }

    const total = wins + losses;
    const winRate = total ? (wins / total) * 100 : 0;
    const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : (grossProfitR > 0 ? Infinity : 0);
    const avgR = total ? totalR / total : 0;
    const averageScore = results.length ? avg(results.map(r => r.score)) : 0;
    const averageMAE = validCount ? sumMAE / validCount : 0;
    const averageMFE = validCount ? sumMFE / validCount : 0;

    return {
        totalTrades: total,
        wins,
        losses,
        winRate,
        totalR,
        avgR,
        profitFactor,
        averageScore,
        maxDrawdown,
        bestTrade,
        worstTrade,
        averageMAE,
        averageMFE,
        sample: results.slice(0, 20)
    };
}

// ========================= STATUS =========================
function status() {
    cleanup();
    const signals = [...STATE.signals.values()].sort((a, b) => b.score - a.score);
    const pending = [...STATE.pending.values()].sort((a, b) => b.breakoutTime - a.breakoutTime);
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals,
        pending,
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
app.get('/api/backtest', auth, async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const result = await runBacktest(symbol);
        res.json({ success: true, ...result });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

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
.top{display:flex;align-items:center;justify-content:space-between;}
.coin{font-size:14px;font-weight:bold;}
.badge{font-size:9px;padding:3px 6px;border-radius:4px;background:#123c31;color:#13dba0;}
.badge.short{background:#421d28;color:#ff5570;}
.cp{font-size:15px;margin-top:8px;}
.meta{color:#718096;font-size:9px;margin-top:6px;}
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
<div class="sub">SADECE TEYİTLİ SİNYALLER</div>
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
<div class="pill">● AUTO TRADE KAPALI</div>
</div>
<section class="chartbox">
<div class="charthead">
<b id="cn">BTCUSDT • 15M</b>
<div class="tf">
<button data-t="5m">5M</button>
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
<div class="bt">AKTİF SCALP SİNYALİ</div>
<div id="active"><div class="empty">Henüz teyit edilmiş sinyal yok.</div></div>
</div>
<div class="box">
<div class="bt">BEKLEYEN KIRILIM / RETEST</div>
<div id="pending" class="pending"><div class="empty">Bekleyen setup yok.</div></div>
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
$('mi').innerHTML='Breadth %'+esc(m.breadth)+' • Yeşil '+esc(m.green)+' • Kırmızı '+esc(m.red)+'<br>Ortalama '+esc(m.average)+'%<br>BTC 1H '+esc(m.btc)+' • ETH 1H '+esc(m.eth);
var cards=$('cards');cards.innerHTML='';
var arr=data.signals||[];
if(!arr.length){cards.innerHTML='<div class="empty">Teyit edilmiş sinyal yok.</div>';}
arr.forEach(function(s){
var el=document.createElement('div');
el.className='card '+(s.direction==='SHORT'?'short':'')+(s.marketSymbol===S.selected?' active':'');
el.innerHTML='<div class="top"><div class="coin">'+esc(s.symbol)+'</div><div class="badge '+(s.direction==='LONG'?'long':'short')+'">'+esc(s.direction)+'</div></div><div class="cp">'+p(s.currentPrice||s.entry)+'</div><div class="meta">● GİRİŞ ALANI • GÜÇ '+esc(s.score)+'/100</div>';
el.onclick=function(){S.selected=s.marketSymbol;S.signal=s;loadChart();};
cards.appendChild(el);
});
var selected=arr.find(function(x){return x.marketSymbol===S.selected;})||arr[0]||null;
if(selected){S.selected=selected.marketSymbol;S.signal=selected;setActive(selected);}else{setActive(null);}
$('pending').innerHTML=(data.pending&&data.pending.length)?data.pending.map(function(x){return '<div class="pi"><b>'+esc(x.symbol)+' '+esc(x.direction)+'</b><br>Seviye '+esc(x.level)+' • '+esc(x.state)+'</div>';}).join(''):'<div class="empty">Bekleyen setup yok.</div>';
if(data.chart){S.candles=normalize(data.chart.candles);S.signal=data.chart.signal||S.signal;S.selected=data.chart.symbol||S.selected;S.tf=data.chart.timeframe||S.tf;updateHeader();draw();}
if(data.error){$('info').textContent='HATA: '+data.error;}
}
function setActive(s){
if(!s){$('active').innerHTML='<div class="empty">Henüz teyit edilmiş sinyal yok.</div>';return;}
var cl=s.direction==='LONG'?'longtxt':'shorttxt';
$('active').innerHTML='<div class="an '+cl+'">'+esc(s.symbol)+' • '+esc(s.direction)+'</div><div class="grid">'+
'<div class="lv entry"><span>GİRİŞ</span><b>'+p(s.entryLow)+' — '+p(s.entryHigh)+'</b></div>'+
'<div class="lv stop"><span>STOP</span><b>'+p(s.stop)+'</b></div>'+
'<div class="lv tp"><span>TP1</span><b>'+p(s.tp1)+'</b></div>'+
'<div class="lv tp"><span>TP2</span><b>'+p(s.tp2)+'</b></div>'+
'<div class="lv tp"><span>TP3</span><b>'+p(s.tp3)+'</b></div>'+
'<div class="lv"><span>R:R</span><b>1:'+esc(s.rr)+'</b></div></div>'+
'<div class="mi">'+esc(s.status||'GİRİŞ ALANI')+' • SKOR '+esc(s.score)+'/100<br>RSI '+esc(s.rsi)+' • VOL '+esc(s.volumeRatio)+'x<br>'+esc(s.reason||'')+'</div>';
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

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🚀 SONNY AI TRADER FINAL (DÜZELTİLMİŞ)');
    console.log('📡 Bitget USDT Futures');
    console.log('🛰️ Radar: ' + CFG.RADAR + ' Coin');
    console.log('🎯 Candidate: ' + CFG.CANDIDATES);
    console.log('🔬 Deep: ' + CFG.DEEP);
    console.log('📊 4H + 2H → 15M Breakout → Retest → 5M Micro-Structure Trigger');
    console.log('💰 Minimum Volume: $' + CFG.MIN_VOLUME_USDT);
    console.log('🎯 Minimum R:R: 1:' + CFG.MIN_RR);
    console.log('⏱️ Scan: 60 sec');
    console.log('🤖 Auto Trade: ' + (CFG.AUTO_TRADE ? 'AÇIK' : 'KAPALI'));
    console.log('📝 Paper Mode: ' + (CFG.PAPER_MODE ? 'AÇIK' : 'KAPALI'));
    console.log('🐞 Debug: ' + (CFG.DEBUG ? 'AÇIK' : 'KAPALI'));
    console.log('🌐 Port: ' + PORT);
    if (API_TOKEN) console.log('🔑 API Token koruması aktif');
    console.log('==============================================');

    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | Gerçek USDT perpetual=' + STATE.markets.length);
        await runScan();
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR', e.message);
    }

    setTimeout(() => {
        setInterval(() => runScan().catch(e => {
            STATE.lastError = e.message;
            console.error('SCAN LOOP', e.message);
        }), CFG.SCAN_MS);
    }, 5000);

    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE LOOP', e.message)), CFG.LIVE_MS);
});
