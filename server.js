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
    DEEP: 80,

    H1_HISTORY: 100,
    H4_HISTORY: 100,
    M15: 150,
    M5: 100,

    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 3000000),
    
    LOOKBACK_4H: 30,
    LOOKBACK_2H: 30,
    
    RETEST_PERCENT: 0.80,
    
    RSI_PERIOD: 14,
    LONG_RSI_MIN: 48,
    LONG_RSI_MAX: 68,
    SHORT_RSI_MIN: 32,
    SHORT_RSI_MAX: 52,
    
    MIN_SIGNAL_SCORE: 75,
    MAX_SIGNALS: 8,
    MAX_PREPARING: 8,

    MIN_RR: 1.50,
    TP2_RR: 2.0,
    TP3_RR: 3.0,
    ATR_STOP: 1.00,

    SIGNAL_TTL: 45 * 60 * 1000,
    ENTRY_TTL: 20 * 60 * 1000,
    COOLDOWN: 4 * 60 * 60 * 1000,

    PAPER_MODE: true,
    AUTO_TRADE: false,
    DEBUG: false,

    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 3,
    
    REQUEST_DELAY: 150,
    CACHE_TTL: {
        '5m': 30 * 1000,
        '15m': 60 * 1000,
        '1h': 5 * 60 * 1000,
        '2h': 10 * 60 * 1000,
        '4h': 15 * 60 * 1000
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
    preparing: new Map(),
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
        preparing: 0,
        errors: 0,
        finalSignals: 0,
        rejectedScore: 0,
        rejectedRSI: 0,
        rejectedRetest: 0,
        rejectedBreakout: 0
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

function percent(v, base) {
    return base ? (v / base) * 100 : 0;
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
    const ttl = CFG.CACHE_TTL[tf] || 60 * 1000;
    
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

// ========================= RSI =========================
function rsi(candles, period = 14) {
    const c = closed(candles);
    if (c.length <= period) return null;
    
    const closes = c.map(x => n(x[4]));
    let gain = 0, loss = 0;
    
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gain += change;
        else loss -= change;
    }
    
    let avgGain = gain / period;
    let avgLoss = loss / period;
    
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

// ========================= BREAKOUT INFO (ESKİ SİSTEM) =========================
function breakoutInfo(c, lookback) {
    if (c.length < lookback + 5) return null;
    
    const closedCandles = c.slice(0, -1);
    const recent = Math.min(8, closedCandles.length - lookback);
    
    let longBreak = false;
    let shortBreak = false;
    let longLevel = null;
    let shortLevel = null;
    
    for (let i = closedCandles.length - recent; i < closedCandles.length; i++) {
        const history = closedCandles.slice(i - lookback, i);
        if (history.length < lookback) continue;
        
        const resistance = Math.max(...history.map(x => n(x[2])));
        const support = Math.min(...history.map(x => n(x[3])));
        
        const current = closedCandles[i];
        const previous = closedCandles[i - 1];
        
        if (n(current[4]) > resistance && n(previous[4]) <= resistance) {
            longBreak = true;
            longLevel = resistance;
        }
        
        if (n(current[4]) < support && n(previous[4]) >= support) {
            shortBreak = true;
            shortLevel = support;
        }
    }
    
    const last = closedCandles.slice(-lookback);
    
    return {
        current: closedCandles[closedCandles.length - 1],
        resistance: longLevel || Math.max(...last.map(x => n(x[2]))),
        support: shortLevel || Math.min(...last.map(x => n(x[3]))),
        longBreak,
        shortBreak,
        longLevel,
        shortLevel
    };
}

// ========================= RETEST (ESKİ SİSTEM) =========================
function near(price, level) {
    return Math.abs(percent(price - level, level)) <= CFG.RETEST_PERCENT;
}

// ========================= SCORE (ESKİ SİSTEM) =========================
function score(breakout4H, breakout2H, retest, rsiOk, rv, direction) {
    let s = 0;
    
    if (breakout4H) s += 35;
    if (breakout2H) s += 30;
    else if (breakout4H) s += 15;
    
    if (retest) s += 20;
    if (rsiOk) s += 10;
    
    if (direction === 'LONG' && rv >= 52 && rv <= 63) s += 5;
    if (direction === 'SHORT' && rv >= 37 && rv <= 48) s += 5;
    
    return Math.min(100, s);
}

// ========================= TRADE PLAN (ESKİ SİSTEM) =========================
function plan(row, dir, level, rv, sc, reason) {
    const entryLow = dir === 'LONG' ? level * 0.998 : level * 1.002;
    const entryHigh = dir === 'LONG' ? level * 1.004 : level * 0.996;
    const stop = dir === 'LONG' ? level * 0.982 : level * 1.018;
    const risk = Math.abs(level - stop);
    
    const tp1 = dir === 'LONG' ? level + risk * 1.5 : level - risk * 1.5;
    const tp2 = dir === 'LONG' ? level + risk * 2 : level - risk * 2;
    const tp3 = dir === 'LONG' ? level + risk * 3 : level - risk * 3;
    
    return {
        symbol: row.symbol,
        marketSymbol: row.symbol,
        direction: dir,
        strategy: '4H / 2H BREAKOUT + RETEST + RSI',
        score: sc,
        confidence: sc,
        currentPrice: n(row.price, 8),
        entry: n(level, 8),
        entryLow: n(entryLow, 8),
        entryHigh: n(entryHigh, 8),
        stop: n(stop, 8),
        stopLoss: n(stop, 8),
        tp1: n(tp1, 8),
        tp2: n(tp2, 8),
        tp3: n(tp3, 8),
        rr: 1.5,
        rsi: n(rv, 1),
        level: n(level, 8),
        breakoutLevel: n(level, 8),
        timeframeLevel: '4H/2H',
        change24h: n(row.change, 2),
        reason,
        reasons: [reason],
        status: 'GİRİŞ BEKLENİYOR',
        entryReady: false,
        paperEntry: null,
        entryTime: null,
        maeR: null,
        mfeR: null
    };
}

// ========================= MAKE SIGNAL (ESKİ SİSTEM) =========================
function makeSignal(row, h4, h2, m15) {
    const rv = rsi(m15, CFG.RSI_PERIOD);
    if (rv === null) return null;
    
    const price = row.price;
    const h2Price = n(h2.current[4]);
    
    // LONG
    if (h4.longBreak || h2.longBreak) {
        const level = h4.longBreak ? (h4.longLevel || h4.resistance) : (h2.longLevel || h2.resistance);
        
        const h4ok = h4.longBreak || price >= h4.resistance * 0.997;
        const h2ok = h2.longBreak || h2Price >= h2.resistance * 0.997;
        const rsiOk = rv >= CFG.LONG_RSI_MIN && rv <= CFG.LONG_RSI_MAX;
        const retest = near(price, level);
        
        if (h4ok && h2ok && retest && rsiOk) {
            const sc = score(h4.longBreak, h2.longBreak, true, true, rv, 'LONG');
            
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.longBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' +
                    (h2.longBreak ? '2H kırılım onayı' : '2H yapı onayı') +
                    ' + retest + RSI LONG giriş bölgesi.';
                
                return plan(row, 'LONG', level, rv, sc, reason);
            }
        }
    }
    
    // SHORT
    if (h4.shortBreak || h2.shortBreak) {
        const level = h4.shortBreak ? (h4.shortLevel || h4.support) : (h2.shortLevel || h2.support);
        
        const h4ok = h4.shortBreak || price <= h4.support * 1.003;
        const h2ok = h2.shortBreak || h2Price <= h2.support * 1.003;
        const rsiOk = rv >= CFG.SHORT_RSI_MIN && rv <= CFG.SHORT_RSI_MAX;
        const retest = near(price, level);
        
        if (h4ok && h2ok && retest && rsiOk) {
            const sc = score(h4.shortBreak, h2.shortBreak, true, true, rv, 'SHORT');
            
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.shortBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' +
                    (h2.shortBreak ? '2H kırılım onayı' : '2H yapı onayı') +
                    ' + retest + RSI SHORT giriş bölgesi.';
                
                return plan(row, 'SHORT', level, rv, sc, reason);
            }
        }
    }
    
    return null;
}

// ========================= PREPARING (ESKİ SİSTEM) =========================
function preparing(row, h4, h2, m15) {
    const rv = rsi(m15, CFG.RSI_PERIOD);
    if (rv === null) return null;
    
    const price = row.price;
    const longDistance = percent(h4.resistance - price, price);
    const shortDistance = percent(price - h4.support, price);
    
    // LONG hazırlık
    if (longDistance >= 0 && longDistance <= 1 &&
        percent(h2.resistance - price, price) <= 1.5 &&
        rv >= 45 && rv <= 70) {
        return {
            symbol: row.symbol,
            direction: 'LONG',
            price: n(price, 8),
            trigger: n(h4.resistance, 8),
            distance: n(longDistance, 3),
            rsi: n(rv, 1)
        };
    }
    
    // SHORT hazırlık
    if (shortDistance >= 0 && shortDistance <= 1 &&
        percent(price - h2.support, price) <= 1.5 &&
        rv >= 30 && rv <= 55) {
        return {
            symbol: row.symbol,
            direction: 'SHORT',
            price: n(price, 8),
            trigger: n(h4.support, 8),
            distance: n(shortDistance, 3),
            rsi: n(rv, 1)
        };
    }
    
    return null;
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        const [c4, c2, c15] = await Promise.all([
            getCandles(row.symbol, '4h', CFG.H4_HISTORY),
            getCandles(row.symbol, '2h', CFG.H4_HISTORY),
            getCandles(row.symbol, '15m', CFG.M15)
        ]);
        
        if (c4.length < 40 || c2.length < 40 || c15.length < 50) return null;
        
        const h4 = breakoutInfo(c4, CFG.LOOKBACK_4H);
        const h2 = breakoutInfo(c2, CFG.LOOKBACK_2H);
        
        if (!h4 || !h2) return null;
        
        // Sinyal üret
        const signal = makeSignal(row, h4, h2, c15);
        
        if (signal) {
            const now = Date.now();
            const id = [signal.symbol, signal.direction, now].join('|');
            
            // Duplicate kontrol
            const duplicate = [...STATE.signals.values()].some(s =>
                s.symbol === signal.symbol && s.direction === signal.direction);
            
            if (!duplicate) {
                signal.id = id;
                signal.signalAt = now;
                signal.cooldownKey = id;
                
                STATE.signals.set(id, signal);
                STATE.stats.finalSignals++;
                STATE.performance.signalsToday++;
                
                if (CFG.DEBUG) {
                    console.log(`[${signal.symbol}] SIGNAL_CREATED ${signal.direction} SCORE=${signal.score}`);
                    console.log(`  Entry: ${fmt(signal.entry)} SL: ${fmt(signal.stop)} TP1: ${fmt(signal.tp1)}`);
                }
                
                while (STATE.signals.size > CFG.MAX_SIGNALS) {
                    const first = STATE.signals.keys().next().value;
                    STATE.signals.delete(first);
                }
            }
        }
        
        // Preparing
        const prep = preparing(row, h4, h2, c15);
        if (prep) {
            STATE.preparing.set(prep.symbol + '|' + prep.direction, prep);
            STATE.stats.preparing++;
            
            while (STATE.preparing.size > CFG.MAX_PREPARING) {
                const first = STATE.preparing.keys().next().value;
                STATE.preparing.delete(first);
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
    STATE.stats.preparing = 0;
    STATE.preparing.clear();
    
    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);
        
        let candidates = rows.filter(r => r.volume >= CFG.MIN_VOLUME_USDT)
            .sort((a, b) => b.volume - a.volume)
            .slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        
        console.log(`RADAR: ${STATE.stats.universe}`);
        console.log(`CANDIDATES: ${candidates.length}`);
        
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
            await sleep(50);
        }
        
        STATE.lastScan = Date.now();
        console.log(`SIGNALS: ${STATE.stats.finalSignals}`);
        console.log(`PREPARING: ${STATE.stats.preparing}`);
        console.log(`Tarama tamamlandı. Analiz: ${STATE.stats.analyzed}, Sinyal: ${STATE.signals.size}`);
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
    else if (result === 'TP2') rMultiple = 2.0;
    else if (result === 'TP3') rMultiple = 3.0;
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

// ========================= STATUS =========================
function status() {
    cleanup();
    const signals = [...STATE.signals.values()].sort((a, b) => b.score - a.score);
    const preparing = [...STATE.preparing.values()].sort((a, b) => a.distance - b.distance);
    
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals,
        preparing,
        pending: preparing,
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
<div class="sub">4H/2H BREAKOUT + RETEST + RSI</div>
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
<div class="bt">HAZIRLANAN FIRSATLAR</div>
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
$('pending').innerHTML=(data.preparing&&data.preparing.length)?data.preparing.map(function(x){return '<div class="pi"><b>'+esc(x.symbol)+' '+esc(x.direction)+'</b><br>Tetik '+esc(x.trigger)+' • '+esc(x.distance)+'% uzakta</div>';}).join(''):'<div class="empty">Bekleyen setup yok.</div>';
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
'<div class="mi">'+esc(s.status||'GİRİŞ ALANI')+' • SKOR '+esc(s.score)+'/100<br>RSI '+esc(s.rsi)+' • '+esc(s.reason||'')+'</div>';
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
    console.log('🚀 SONNY AI TRADER (4H/2H BREAKOUT + RETEST + RSI)');
    console.log('📡 Bitget USDT Futures');
    console.log('🛰️ Radar: ' + CFG.RADAR + ' Coin');
    console.log('🎯 Candidate: ' + CFG.CANDIDATES);
    console.log('🔬 Deep: ' + CFG.DEEP);
    console.log('📊 4H/2H Breakout → Retest → RSI → Signal');
    console.log('💰 Minimum Volume: $' + CFG.MIN_VOLUME_USDT);
    console.log('🎯 Minimum Score: ' + CFG.MIN_SIGNAL_SCORE);
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
