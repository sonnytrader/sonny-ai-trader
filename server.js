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
    RADAR: 300,
    CANDIDATES: 100,
    DEEP: 60,
    M15_HISTORY: 100,
    H1_HISTORY: 60,
    H4_HISTORY: 100,
    H2_HISTORY: 100,
    
    MIN_VOLUME_USDT: 2000000,
    HIGH_VOLUME_USDT: 5000000,
    
    MIN_BODY_RATIO: 0.55,
    MIN_VOLUME_SURGE: 1.5,
    MIN_MOVE_PERCENT: 0.2,
    MAX_MOVE_PERCENT: 2.0,
    
    TP1_RR: 1.5,
    TP2_RR: 2.0,
    TP3_RR: 3.0,
    SL_ATR_MULT: 1.5,
    MIN_STOP_PERCENT: 0.3,
    
    SIGNAL_TTL: 30 * 60 * 1000,
    COOLDOWN_MS: 15 * 60 * 1000,
    
    SCAN_MS: 60000,
    LIVE_MS: 5000,
    CONCURRENCY: 2,
    REQUEST_DELAY: 200,
    CACHE_TTL: { '15m': 30000, '1h': 60000, '4h': 300000, '2h': 180000 },
    CHART: 160,
    
    // YENİ STRATEJİ PARAMETRELERİ
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
    BATCH: 8,
    DELAY: 100
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
    preparing: [],
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: { label: 'YATAY', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0 },
    stats: { universe: 0, candidates: 0, deep: 0, analyzed: 0, signals: 0, longSignals: 0, shortSignals: 0, preparing: 0 },
    signalHistory: [],
    performance: { wins: 0, losses: 0, timeouts: 0, winRate: 0, totalR: 0, avgRR: 0 },
    paperTrades: []
};

// ========================= CACHE =========================
const candleCache = new Map();
const requestQueue = [];
let isProcessingQueue = false;

// ========================= HELPERS =========================
function n(v, d = 6) { const x = Number(v); return Number.isFinite(x) ? Number(x.toFixed(d)) : 0; }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function closed(c) { return Array.isArray(c) && c.length > 1 ? c.slice(0, -1) : (c || []); }
function percent(v, base) { return base ? (v / base) * 100 : 0; }
function cleanSymbol(s) {
    let x = String(s || '').toUpperCase().replace('/USDT:USDT', '').replace('/USDT', '').replace(':USDT', '');
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
        try { await loadMarkets(); return; }
        catch (e) { console.error(`Market yüklenemedi:`, e.message); if (i < maxRetries - 1) await sleep(delayMs); }
    }
    throw new Error('Marketler yüklenemedi');
}

// ========================= RATE LIMIT QUEUE =========================
async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const task = requestQueue.shift();
        try { const result = await task.fn(); task.resolve(result); }
        catch (error) { task.reject(error); }
        await sleep(CFG.REQUEST_DELAY);
    }
    isProcessingQueue = false;
}
function queueRequest(fn) {
    return new Promise((resolve, reject) => { requestQueue.push({ fn, resolve, reject }); processQueue(); });
}

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    const ttl = CFG.CACHE_TTL[tf] || 60000;
    if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
    try {
        const data = await queueRequest(() => exchange.fetchOHLCV(symbol, tf, undefined, limit));
        const cleaned = Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0]) : [];
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (error) {
        if (cached) return cached.data;
        return [];
    }
}

// ========================= CACHE TEMİZLİK =========================
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of candleCache.entries()) {
        const tf = key.split('|')[1];
        const ttl = CFG.CACHE_TTL[tf] || 60000;
        if (now - value.timestamp > ttl * 2) {
            candleCache.delete(key);
        }
    }
}, 5 * 60 * 1000);

// ========================= TICKERS =========================
async function getTickers() {
    let tickers;
    try { tickers = await queueRequest(() => exchange.fetchTickers()); }
    catch (error) { if (!STATE.universe.length) throw error; return STATE.universe; }
    const rows = [];
    for (const m of STATE.markets) {
        const t = tickers[m.symbol];
        if (!t) continue;
        const last = n(t.last || t.close);
        const volume = n(t.quoteVolume);
        if (!(last > 0) || !(volume > 0)) continue;
        rows.push({
            symbol: m.symbol, price: last, volume, volumeFormatted: formatVolume(volume),
            change: n(t.percentage),
            volumeTier: volume >= CFG.HIGH_VOLUME_USDT ? 'HIGH' : volume >= CFG.MIN_VOLUME_USDT ? 'MID' : 'LOW'
        });
    }
    rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, CFG.RADAR);
}

// ========================= ATR =========================
function calculateATR(candles, period = 14) {
    const c = closed(candles);
    if (c.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) {
        const h = n(c[i][2]), lo = n(c[i][3]), pc = n(c[i - 1][4]);
        trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    return avg(trs.slice(-period));
}

// ========================= RSI =========================
function calculateRSI(values, period = 14) {
    if (!values || values.length <= period) return null;
    
    let gain = 0;
    let loss = 0;
    
    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];
        if (change >= 0) gain += change;
        else loss -= change;
    }
    
    let avgGain = gain / period;
    let avgLoss = loss / period;
    
    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

// ========================= 1H TREND =========================
async function get1hTrend(symbol) {
    const c1h = await getCandles(symbol, '1h', CFG.H1_HISTORY);
    if (c1h.length < 30) return 'NEUTRAL';
    const closes = c1h.map(c => n(c[4]));
    const ema50 = calculateEMA(closes, 50);
    const lastClose = closes[closes.length - 1];
    if (ema50 === null) return 'NEUTRAL';
    if (lastClose > ema50) return 'LONG';
    if (lastClose < ema50) return 'SHORT';
    return 'NEUTRAL';
}

// ========================= EMA =========================
function calculateEMA(closes, period = 50) {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = avg(closes.slice(0, period));
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// ========================= BREAKOUT INFO =========================
function breakoutInfo(candles, lookback) {
    const c = closed(candles);
    if (c.length < lookback + 5) return null;
    
    const recent = Math.min(8, c.length - lookback);
    let longBreak = false;
    let shortBreak = false;
    let longLevel = null;
    let shortLevel = null;
    
    for (let i = c.length - recent; i < c.length; i++) {
        const history = c.slice(i - lookback, i);
        if (history.length < lookback) continue;
        
        const resistance = Math.max(...history.map(x => n(x[2])));
        const support = Math.min(...history.map(x => n(x[3])));
        
        const current = c[i];
        const previous = c[i - 1];
        
        if (current[4] > resistance && previous[4] <= resistance) {
            longBreak = true;
            longLevel = resistance;
        }
        
        if (current[4] < support && previous[4] >= support) {
            shortBreak = true;
            shortLevel = support;
        }
    }
    
    const last = c.slice(-lookback);
    const current = c[c.length - 1];
    
    return {
        current: current,
        resistance: longLevel || Math.max(...last.map(x => n(x[2]))),
        support: shortLevel || Math.min(...last.map(x => n(x[3]))),
        longBreak,
        shortBreak,
        longLevel,
        shortLevel
    };
}

// ========================= RETEST =========================
function near(price, level) {
    return Math.abs(percent(price - level, level)) <= CFG.RETEST_PERCENT;
}

// ========================= SCORE =========================
function calculateScore(breakout4H, breakout2H, retest, rsiOk, rv, direction) {
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

// ========================= PLAN =========================
function createPlan(m, dir, level, rv, sc, reason) {
    const entryLow = dir === 'LONG' ? level * 0.998 : level * 1.002;
    const entryHigh = dir === 'LONG' ? level * 1.004 : level * 0.996;
    const stop = dir === 'LONG' ? level * 0.982 : level * 1.018;
    const risk = Math.abs(level - stop);
    const tp1 = dir === 'LONG' ? level + risk * 1.5 : level - risk * 1.5;
    const tp2 = dir === 'LONG' ? level + risk * 2 : level - risk * 2;
    const tp3 = dir === 'LONG' ? level + risk * 3 : level - risk * 3;
    
    return {
        symbol: m.symbol,
        direction: dir,
        strategy: '4H / 2H BREAKOUT + RETEST + RSI',
        score: sc,
        price: n(m.price, 8),
        entryLow: n(entryLow, 8),
        entryHigh: n(entryHigh, 8),
        stop: n(stop, 8),
        tp1: n(tp1, 8),
        tp2: n(tp2, 8),
        tp3: n(tp3, 8),
        rsi: n(rv, 1),
        level: n(level, 8),
        change24h: n(m.change, 2),
        reason
    };
}

// ========================= PREPARING =========================
function createPreparing(m, h4, h2, m15) {
    const rv = calculateRSI(m15.slice(0, -1).map(x => n(x[4])), CFG.RSI_PERIOD);
    if (rv === null) return null;
    
    const price = m.price;
    const longDistance = percent(h4.resistance - price, price);
    const shortDistance = percent(price - h4.support, price);
    
    if (longDistance >= 0 && longDistance <= 1 &&
        percent(h2.resistance - price, price) <= 1.5 &&
        rv >= 45 && rv <= 70) {
        return {
            symbol: m.symbol,
            direction: 'LONG',
            price: n(price, 8),
            trigger: n(h4.resistance, 8),
            distance: n(longDistance, 3),
            rsi: n(rv, 1),
            marketSymbol: m.symbol
        };
    }
    
    if (shortDistance >= 0 && shortDistance <= 1 &&
        percent(price - h2.support, price) <= 1.5 &&
        rv >= 30 && rv <= 55) {
        return {
            symbol: m.symbol,
            direction: 'SHORT',
            price: n(price, 8),
            trigger: n(h4.support, 8),
            distance: n(shortDistance, 3),
            rsi: n(rv, 1),
            marketSymbol: m.symbol
        };
    }
    
    return null;
}

// ========================= MAKE SIGNAL =========================
function makeSignal(m, h4, h2, m15) {
    const rv = calculateRSI(m15.slice(0, -1).map(x => n(x[4])), CFG.RSI_PERIOD);
    if (rv === null) return null;
    
    const price = m.price;
    const h2Price = n(h2.current[4]);
    
    // LONG SİNYAL
    if (h4.longBreak || h2.longBreak) {
        const level = h4.longBreak ? (h4.longLevel || h4.resistance) : (h2.longLevel || h2.resistance);
        const h4ok = h4.longBreak || price >= h4.resistance * 0.997;
        const h2ok = h2.longBreak || h2Price >= h2.resistance * 0.997;
        const rsiOk = rv >= CFG.LONG_RSI_MIN && rv <= CFG.LONG_RSI_MAX;
        const retest = near(price, level);
        
        if (h4ok && h2ok && retest && rsiOk) {
            const sc = calculateScore(h4.longBreak, h2.longBreak, true, true, rv, 'LONG');
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.longBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' +
                    (h2.longBreak ? '2H kırılım onayı' : '2H yapı onayı') +
                    ' + retest + RSI LONG giriş bölgesi.';
                return createPlan(m, 'LONG', level, rv, sc, reason);
            }
        }
    }
    
    // SHORT SİNYAL
    if (h4.shortBreak || h2.shortBreak) {
        const level = h4.shortBreak ? (h4.shortLevel || h4.support) : (h2.shortLevel || h2.support);
        const h4ok = h4.shortBreak || price <= h4.support * 1.003;
        const h2ok = h2.shortBreak || h2Price <= h2.support * 1.003;
        const rsiOk = rv >= CFG.SHORT_RSI_MIN && rv <= CFG.SHORT_RSI_MAX;
        const retest = near(price, level);
        
        if (h4ok && h2ok && retest && rsiOk) {
            const sc = calculateScore(h4.shortBreak, h2.shortBreak, true, true, rv, 'SHORT');
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.shortBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' +
                    (h2.shortBreak ? '2H kırılım onayı' : '2H yapı onayı') +
                    ' + retest + RSI SHORT giriş bölgesi.';
                return createPlan(m, 'SHORT', level, rv, sc, reason);
            }
        }
    }
    
    return null;
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        if (row.volumeTier === 'LOW') return null;
        
        const cleanSym = cleanSymbol(row.symbol);
        
        const cooldownTime = STATE.cooldowns.get(cleanSym);
        if (cooldownTime && Date.now() - cooldownTime < CFG.COOLDOWN_MS) return null;
        
        const existing = [...STATE.signals.values()].find(s => s.symbol === cleanSym);
        if (existing) return null;
        
        const [c4, c2, c15] = await Promise.all([
            getCandles(row.symbol, '4h', CFG.H4_HISTORY),
            getCandles(row.symbol, '2h', CFG.H2_HISTORY),
            getCandles(row.symbol, '15m', CFG.M15_HISTORY)
        ]);
        
        if (c4.length < 35 || c2.length < 35 || c15.length < 50) return null;
        
        const h4 = breakoutInfo(c4, CFG.LOOKBACK_4H);
        const h2 = breakoutInfo(c2, CFG.LOOKBACK_2H);
        
        if (!h4 || !h2) return null;
        
        const sig = makeSignal(row, h4, h2, c15);
        
        if (sig) {
            const now = Date.now();
            const signal = {
                id: `${cleanSym}-${sig.direction}-${now}`,
                symbol: cleanSym,
                marketSymbol: row.symbol,
                direction: sig.direction,
                strategy: sig.strategy,
                score: sig.score,
                confidence: sig.score,
                currentPrice: row.price,
                entry: n((sig.entryLow + sig.entryHigh) / 2),
                entryPrice: n((sig.entryLow + sig.entryHigh) / 2, 8),
                giris: n((sig.entryLow + sig.entryHigh) / 2),
                entryLow: sig.entryLow,
                entryHigh: sig.entryHigh,
                stop: sig.stop,
                stopLoss: sig.stop,
                SL: sig.stop,
                tp1: sig.tp1,
                TP1: sig.tp1,
                tp2: sig.tp2,
                TP2: sig.tp2,
                tp3: sig.tp3,
                TP3: sig.tp3,
                RR: '1.5',
                rr: 1.5,
                rsi: sig.rsi,
                reason: sig.reason,
                tacticalAnalysis: sig.reason,
                volumeFormatted: row.volumeFormatted,
                volumeTier: row.volumeTier,
                timestamp: now,
                time: new Date().toLocaleTimeString('tr-TR'),
                signalAt: now,
                status: 'AKTİF',
                paperEntry: n((sig.entryLow + sig.entryHigh) / 2),
                entryTime: now,
                cooldownKey: cleanSym
            };
            
            STATE.signals.set(signal.id, signal);
            
            if (sig.direction === 'LONG') STATE.stats.longSignals++;
            else STATE.stats.shortSignals++;
            
            console.log(`✅ ${cleanSym} ${sig.direction} | Skor: ${sig.score} | Giriş: ${sig.entryLow}-${sig.entryHigh} | SL: ${sig.stop} | TP1: ${sig.tp1} | TP2: ${sig.tp2} | TP3: ${sig.tp3}`);
            
            return signal;
        }
        
        // PREPARING kontrolü
        const prep = createPreparing(row, h4, h2, c15);
        if (prep && STATE.preparing.length < CFG.MAX_PREPARING) {
            STATE.preparing.push(prep);
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

// ========================= SCAN =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.longSignals = 0;
    STATE.stats.shortSignals = 0;
    STATE.preparing = [];
    
    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);
        
        const candidates = rows.filter(r => r.volumeTier !== 'LOW').slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        
        console.log(`\n📡 RADAR: ${rows.length} | CANDIDATES: ${candidates.length}`);
        
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
        
        const now = Date.now();
        for (const [id, signal] of STATE.signals) {
            if (now - signal.timestamp > CFG.SIGNAL_TTL) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TIMEOUT', 0);
            }
        }
        
        STATE.lastScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        STATE.stats.preparing = STATE.preparing.length;
        
        console.log(`\n📊 Aktif: ${STATE.signals.size} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
        console.log(`📊 Hazırlanan: ${STATE.preparing.length}`);
        console.log(`📊 Performans: Win: ${STATE.performance.wins} | Loss: ${STATE.performance.losses} | Timeout: ${STATE.performance.timeouts} | WinRate: %${STATE.performance.winRate.toFixed(0)} | TotalR: ${STATE.performance.totalR.toFixed(2)}`);
        
        broadcast();
    } catch (error) {
        STATE.lastError = error.message;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
    }
}

// ========================= LIVE =========================
async function updateLiveSignals() {
    if (!STATE.signals.size) return;
    let tickers;
    try { tickers = await queueRequest(() => exchange.fetchTickers()); }
    catch (e) { return; }
    
    const now = Date.now();
    for (const [id, signal] of STATE.signals) {
        if (now - signal.signalAt > CFG.SIGNAL_TTL) {
            STATE.signals.delete(id);
            recordTrade(signal, 'TIMEOUT', 0);
            continue;
        }
        const ticker = tickers[signal.marketSymbol];
        if (!ticker) continue;
        const current = n(ticker.last || ticker.close);
        if (!(current > 0)) continue;
        signal.currentPrice = current;
        
        const entry = signal.paperEntry;
        const risk = Math.abs(entry - signal.stop);
        
        if (signal.direction === 'LONG') {
            if (current <= signal.stop) {
                STATE.signals.delete(id);
                recordTrade(signal, 'STOP', -1);
                STATE.cooldowns.set(signal.symbol, Date.now());
                continue;
            }
            if (current >= signal.tp3) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP3', CFG.TP3_RR);
                continue;
            }
            if (current >= signal.tp2) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP2', CFG.TP2_RR);
                continue;
            }
            if (current >= signal.tp1) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP1', CFG.TP1_RR);
                continue;
            }
            if (current > entry) {
                const profit = ((current - entry) / risk);
                signal.status = 'KARDA +' + profit.toFixed(2) + 'R';
            } else {
                const loss = ((entry - current) / risk);
                signal.status = 'TERS -' + loss.toFixed(2) + 'R';
            }
        } else {
            if (current >= signal.stop) {
                STATE.signals.delete(id);
                recordTrade(signal, 'STOP', -1);
                STATE.cooldowns.set(signal.symbol, Date.now());
                continue;
            }
            if (current <= signal.tp3) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP3', CFG.TP3_RR);
                continue;
            }
            if (current <= signal.tp2) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP2', CFG.TP2_RR);
                continue;
            }
            if (current <= signal.tp1) {
                STATE.signals.delete(id);
                recordTrade(signal, 'TP1', CFG.TP1_RR);
                continue;
            }
            if (current < entry) {
                const profit = ((entry - current) / risk);
                signal.status = 'KARDA +' + profit.toFixed(2) + 'R';
            } else {
                const loss = ((current - entry) / risk);
                signal.status = 'TERS -' + loss.toFixed(2) + 'R';
            }
        }
    }
    
    STATE.stats.signals = STATE.signals.size;
    broadcast();
}

// ========================= TRADE KAYDI =========================
function recordTrade(signal, result, rMultiple) {
    const trade = {
        symbol: signal.symbol,
        direction: signal.direction,
        entry: signal.paperEntry,
        stop: signal.stop,
        tp1: signal.tp1,
        tp2: signal.tp2,
        tp3: signal.tp3,
        result: result,
        rMultiple: rMultiple,
        score: signal.score,
        rsi: signal.rsi,
        closedAt: Date.now()
    };
    
    STATE.signalHistory.push(trade);
    
    const perf = STATE.performance;
    
    if (result === 'TIMEOUT') {
        perf.timeouts++;
    } else {
        perf.totalR += rMultiple;
        if (rMultiple > 0) perf.wins++;
        else if (rMultiple < 0) perf.losses++;
    }
    
    const total = perf.wins + perf.losses;
    perf.winRate = total ? (perf.wins / total) * 100 : 0;
    perf.avgRR = total ? perf.totalR / total : 0;
    
    console.log(`📊 ${signal.symbol} ${result} | R: ${rMultiple > 0 ? '+' : ''}${rMultiple.toFixed(2)}R | Win: ${perf.wins} | Loss: ${perf.losses} | Timeout: ${perf.timeouts} | WinRate: %${perf.winRate.toFixed(0)}`);
}

// ========================= MARKET REGIME =========================
function calculateMarketRegime(rows) {
    if (!rows.length) { STATE.market = { label: 'YATAY', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0 }; return; }
    let green = 0, red = 0, total = 0;
    for (const r of rows) { if (r.change > 0.5) green++; else if (r.change < -0.5) red++; total += r.change; }
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / rows.length;
    let direction = 'FLAT', label = 'YATAY';
    if (breadth >= 55 && average >= 0.5) { direction = 'LONG'; label = 'POZİTİF'; }
    else if (breadth <= 45 && average <= -0.5) { direction = 'SHORT'; label = 'NEGATİF'; }
    STATE.market = { label, direction, breadth: Number(breadth.toFixed(1)), green, red, average: Number(average.toFixed(2)) };
}

// ========================= STATUS =========================
function status() {
    const signals = [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp);
    return {
        ok: true,
        lastScan: STATE.lastScan,
        error: STATE.lastError,
        stats: { ...STATE.stats },
        signals: signals,
        preparing: STATE.preparing,
        pending: [],
        market: STATE.market,
        signalHistoryCount: STATE.signalHistory.length,
        performance: STATE.performance,
        paperTrades: STATE.signalHistory.slice(-20)
    };
}

// ========================= API =========================
function auth(req, res, next) { if (!API_TOKEN) return next(); const token = req.headers['x-api-token'] || req.query.token; if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' }); next(); }
app.get('/api/status', (req, res) => res.json(status()));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), lastScan: STATE.lastScan }));
app.get('/api/scan', auth, async (req, res) => { try { await runScan(); res.json({ success: true, data: status() }); } catch (error) { res.status(500).json({ success: false, error: error.message }); } });
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

// ========================= WEBSOCKET =========================
function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: status() });
    for (const ws of wss.clients) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch (error) {} } }
}
wss.on('connection', ws => { try { ws.send(JSON.stringify({ type: 'snapshot', data: status() })); } catch (_) {} });

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONNY AI SIGNAL SCANNER V5.2</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.app{display:grid;grid-template-columns:300px 1fr 320px;height:100vh;}
@media(max-width:1000px){.app{grid-template-columns:250px 1fr;}.right{display:none;}}
.left{background:#0b111b;border-right:1px solid #1a2533;overflow-y:auto;padding:15px;}
.brand{font-size:18px;font-weight:bold;color:#13dba0;margin-bottom:3px;}
.sub{color:#718096;font-size:10px;margin-bottom:12px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px;}
.st{background:#101826;border:1px solid #1b2939;padding:8px 3px;text-align:center;border-radius:5px;}
.st b{display:block;font-size:18px;color:#13dba0;}
.st span{color:#64748b;font-size:8px;}
.cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;height:calc(100vh - 180px);}
.card{background:#101826;border:1px solid #1c2938;border-radius:8px;padding:12px;cursor:pointer;}
.card:hover{border-color:#13dba0;}
.card.selected{border:2px solid #13dba0;background:#0d1a15;}
.card.long{border-left:4px solid #13dba0;}
.card.short{border-left:4px solid #ff5570;}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;}
.coin{font-size:14px;font-weight:bold;}
.dir{font-size:10px;padding:3px 8px;border-radius:4px;font-weight:bold;}
.dir.long{background:#123c31;color:#13dba0;}
.dir.short{background:#421d28;color:#ff5570;}
.price{font-size:16px;font-weight:bold;margin:4px 0;}
.details{font-size:9px;color:#8b9bb4;line-height:1.4;}
.status-badge{display:inline-block;font-size:8px;padding:2px 6px;border-radius:3px;margin-top:4px;font-weight:bold;background:#101826;color:#8b9bb4;}
.status-kar{background:#0d3d2a;color:#13dba0;}
.status-ters{background:#3d2d1d;color:#ff9500;}
.main{min-width:0;display:flex;flex-direction:column;background:#0b111b;padding:12px;}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.title{font-weight:bold;font-size:14px;color:#13dba0;}
.info{color:#64748b;font-size:9px;}
.charthead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.chart-title{font-size:11px;font-weight:bold;}
.tf{display:flex;gap:3px;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:4px 8px;font-size:8px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}
.chart{flex:1;min-height:0;position:relative;}
canvas{width:100%;height:100%;display:block;}
.right{background:#0b111b;border-left:1px solid #1a2533;overflow-y:auto;padding:12px;}
.box{background:#101826;border:1px solid #1a2938;border-radius:8px;padding:10px;margin-bottom:8px;}
.bt{color:#64748b;font-size:8px;font-weight:bold;}
.reg{font-size:14px;font-weight:bold;margin-top:4px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:9px;line-height:1.5;margin-top:3px;}
.signal-title{font-size:14px;font-weight:bold;}
.signal-title.long{color:#13dba0;}
.signal-title.short{color:#ff5570;}
.signal-status{font-size:10px;font-weight:bold;margin:4px 0;padding:4px 8px;border-radius:3px;display:inline-block;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:4px;padding:6px;}
.lv span{display:block;color:#64748b;font-size:7px;margin-bottom:1px;}
.lv b{font-size:11px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}
.pi{border:1px solid #1b2938;border-radius:4px;padding:5px;font-size:8px;color:#718096;}
.pi b{color:#dbe4ee;font-size:9px;}
.empty{color:#64748b;font-size:10px;padding:10px 4px;text-align:center;}
</style>
</head>
<body>
<div class="app">
<aside class="left">
<div class="brand">🚀 SONNY AI SCANNER</div>
<div class="sub">4H/2H BREAKOUT + RETEST + RSI</div>
<div class="stats">
<div class="st"><b id="u">0</b><span>RADAR</span></div>
<div class="st"><b id="c">0</b><span>ANALİZ</span></div>
<div class="st"><b id="d">0</b><span>SİNYAL</span></div>
</div>
<div class="cards" id="cards"><div class="empty">Sinyal bekleniyor...</div></div>
</aside>
<main class="main">
<div class="head">
<div class="title" id="ps">BTCUSDT</div>
<div class="info" id="info">-</div>
</div>
<div class="charthead">
<div class="chart-title" id="cn">BTCUSDT • 15M</div>
<div class="tf">
<button data-t="15m" class="active">15M</button>
<button data-t="1h">1H</button>
<button data-t="4h">4H</button>
</div>
</div>
<div class="chart"><canvas id="cv"></canvas></div>
</main>
<aside class="right">
<div class="box">
<div class="bt">GENEL PİYASA</div>
<div id="reg" class="reg">YATAY</div>
<div id="mi" class="mi">-</div>
</div>
<div class="box">
<div class="bt">SİNYAL DETAY</div>
<div id="active"><div class="empty">Sinyal seçin</div></div>
</div>
<div class="box">
<div class="bt">HAZIRLANAN FIRSATLAR</div>
<div id="prep"><div class="empty">-</div></div>
</div>
<div class="box">
<div class="bt">PERFORMANS</div>
<div id="perf"><div class="empty">-</div></div>
</div>
</aside>
</div>
<script>
var S = {selected:'BTC/USDT:USDT', tf:'15m', candles:[], signal:null};
var _signals = [];
var _preparing = [];
function $(id){ return document.getElementById(id); }
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function p(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); if(x>=.01) return x.toFixed(7); if(x>=.0001) return x.toFixed(8); return x.toFixed(10); }
function normalize(a){ return (a||[]).map(function(x){ return Array.isArray(x)?{time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{time:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)}; }).filter(function(x){ return Number.isFinite(x.time)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close); }).sort(function(a,b){ return a.time-b.time; }); }

function selectSignal(marketSymbol){
    var s = _signals.find(function(x){ return x.marketSymbol === marketSymbol; });
    if(!s) return;
    S.selected = s.marketSymbol;
    S.signal = s;
    document.querySelectorAll('.card').forEach(function(c){ c.classList.remove('selected'); });
    var card = document.querySelector('.card[data-symbol="' + marketSymbol + '"]');
    if(card) card.classList.add('selected');
    setActive(s);
    loadChart();
}

function render(data){
    var st = data.stats || {};
    $('u').textContent = st.universe || 0;
    $('c').textContent = st.analyzed || 0;
    $('d').textContent = st.signals || 0;
    $('info').textContent = data.lastScan ? 'Son: ' + new Date(data.lastScan).toLocaleTimeString('tr-TR') : '-';
    var m = data.market || {};
    $('reg').textContent = m.label || 'YATAY';
    $('reg').className = 'reg ' + (m.direction === 'LONG' ? 'long' : m.direction === 'SHORT' ? 'short' : '');
    $('mi').innerHTML = 'Breadth %' + esc(m.breadth);
    
    _signals = data.signals || [];
    _preparing = data.preparing || [];
    
    var cards = $('cards');
    cards.innerHTML = '';
    if(!_signals.length){ cards.innerHTML = '<div class="empty">Sinyal yok</div>'; }
    
    _signals.forEach(function(s){
        var el = document.createElement('div');
        var isLong = s.direction === 'LONG';
        var cls = 'card ' + (isLong ? 'long' : 'short');
        if(s.marketSymbol === S.selected) cls += ' selected';
        
        var statusCls = '';
        if(s.status && s.status.startsWith('KARDA')) statusCls = 'status-kar';
        else if(s.status && s.status.startsWith('TERS')) statusCls = 'status-ters';
        
        el.className = cls;
        el.setAttribute('data-symbol', s.marketSymbol);
        el.style.cursor = 'pointer';
        el.innerHTML = '<div class="card-head"><div class="coin">' + esc(s.symbol) + '</div><div class="dir ' + (isLong ? 'long' : 'short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div></div>' +
        '<div class="price">' + p(s.currentPrice || s.entry) + '</div>' +
        '<div class="details">Giriş: ' + p(s.entryLow) + ' - ' + p(s.entryHigh) + '</div>' +
        '<div class="details">SL: ' + p(s.stop) + ' | TP1: ' + p(s.tp1) + '</div>' +
        '<div class="details">TP2: ' + p(s.tp2) + ' | TP3: ' + p(s.tp3) + '</div>' +
        '<div class="details">RSI: ' + esc(s.rsi) + ' | Skor: ' + esc(s.score) + '</div>' +
        '<span class="status-badge ' + statusCls + '">' + esc(s.status || 'AKTİF') + '</span>';
        
        el.onclick = (function(sym){ return function(){ selectSignal(sym); }; })(s.marketSymbol);
        cards.appendChild(el);
    });
    
    // Hazırlanan fırsatlar
    var prepDiv = $('prep');
    if(!_preparing.length){
        prepDiv.innerHTML = '<div class="empty">Hazırlanan fırsat yok</div>';
    } else {
        prepDiv.innerHTML = _preparing.map(function(x){
            return '<div class="mi" style="padding:4px 0;">' + esc(x.symbol) + ' • ' + esc(x.direction) + 
                   '<br>Tetik: ' + p(x.trigger) + ' (%' + esc(x.distance) + ' uzakta)' +
                   '<br>RSI: ' + esc(x.rsi) + '</div>';
        }).join('');
    }
    
    var selected = _signals.find(function(x){ return x.marketSymbol === S.selected; }) || _signals[0] || null;
    if(selected){ S.selected = selected.marketSymbol; S.signal = selected; setActive(selected); }
    else { setActive(null); }
    
    var perf = data.performance || {};
    $('perf').innerHTML = '<div class="pi"><b>📊 Performans</b><br>Win: ' + esc(perf.wins || 0) + ' • Loss: ' + esc(perf.losses || 0) + '<br>Timeout: ' + esc(perf.timeouts || 0) + '<br>WinRate: %' + esc(perf.winRate || 0) + '<br>ToplamR: ' + esc(perf.totalR || 0) + '</div>';
}

function setActive(s){
    if(!s){ $('active').innerHTML = '<div class="empty">Sinyal seçin</div>'; return; }
    var isLong = s.direction === 'LONG';
    var cls = isLong ? 'long' : 'short';
    var statusColor = '#8b9bb4', statusBg = '#101826';
    if(s.status && s.status.startsWith('KARDA')){ statusColor = '#13dba0'; statusBg = '#0d1a15'; }
    else if(s.status && s.status.startsWith('TERS')){ statusColor = '#ff9500'; statusBg = '#2d1d0d'; }
    
    $('active').innerHTML = '<div class="signal-title ' + cls + '">' + esc(s.symbol) + ' • ' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
    '<div class="signal-status" style="background:' + statusBg + ';color:' + statusColor + ';">' + esc(s.status || 'AKTİF') + '</div>' +
    '<div class="levels">' +
    '<div class="lv entry"><span>GİRİŞ</span><b>' + p(s.entryLow) + ' - ' + p(s.entryHigh) + '</b></div>' +
    '<div class="lv stop"><span>STOP</span><b>' + p(s.stop) + '</b></div>' +
    '<div class="lv tp"><span>TP1</span><b>' + p(s.tp1) + '</b></div>' +
    '<div class="lv tp"><span>TP2</span><b>' + p(s.tp2) + '</b></div>' +
    '<div class="lv tp"><span>TP3</span><b>' + p(s.tp3) + '</b></div></div>' +
    '<div class="mi" style="margin-top:5px;">Skor: ' + esc(s.score) + '/100 | RSI: ' + esc(s.rsi) + '<br>' + esc(s.reason || '') + '</div>';
}

function updateHeader(){
    var sym = String(S.selected || 'BTCUSDT').replace('/USDT:USDT', 'USDT');
    $('ps').textContent = sym;
    $('cn').textContent = sym + ' • ' + String(S.tf).toUpperCase();
}

async function loadChart(){
    try {
        var r = await fetch('/api/chart?symbol=' + encodeURIComponent(S.selected) + '&timeframe=' + encodeURIComponent(S.tf), {cache:'no-store'});
        var d = await r.json();
        if(!d.success) return;
        S.candles = normalize(d.candles);
        S.signal = d.signal || S.signal;
        updateHeader();
        draw();
    } catch(e) { console.error('chart', e); }
}

function draw(){
    var c = $('cv');
    if(!c) return;
    var parent = c.parentElement;
    var w = Math.max(300, parent.clientWidth);
    var h = Math.max(300, parent.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    var x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#070b11';
    x.fillRect(0, 0, w, h);
    
    if(!S.candles.length) { x.fillStyle = '#718096'; x.font = '11px Arial'; x.fillText('Veri bekleniyor...', 15, 25); return; }
    
    var visible = S.candles.slice(-80);
    var candleMin = Math.min.apply(Math, visible.map(function(k){ return k.low; }));
    var candleMax = Math.max.apply(Math, visible.map(function(k){ return k.high; }));
    
    var s = S.signal;
    if(s) {
        [s.entry, s.stop, s.tp1, s.tp2, s.tp3].forEach(function(q) {
            if(Number.isFinite(Number(q))) {
                if(Number(q) < candleMin) candleMin = Number(q);
                if(Number(q) > candleMax) candleMax = Number(q);
            }
        });
    }
    
    var pad = (candleMax - candleMin) * 0.08 || 1;
    candleMin -= pad;
    candleMax += pad;
    
    var L = 50, R = 70, T = 15, B = 15;
    var PW = w - L - R;
    var PH = h - T - B;
    
    function Y(q) { return T + (candleMax - q) / (candleMax - candleMin) * PH; }
    function X(i) { return L + i * PW / Math.max(1, visible.length - 1); }
    
    x.strokeStyle = '#182330';
    for(var g = 0; g <= 4; g++) {
        var gy = T + PH * g / 4;
        x.beginPath(); x.moveTo(L, gy); x.lineTo(w - R, gy); x.stroke();
        x.fillStyle = '#607083'; x.font = '8px Arial';
        x.fillText(p(candleMax - (candleMax - candleMin) * g / 4), 3, gy + 3);
    }
    
    var step = PW / Math.max(1, visible.length - 1);
    var bw = Math.max(2, Math.min(8, step * 0.6));
    
    visible.forEach(function(k, i) {
        var xx = X(i);
        var up = k.close >= k.open;
        var col = up ? '#13e0a2' : '#ff4d6d';
        x.strokeStyle = col; x.fillStyle = col;
        x.beginPath(); x.moveTo(xx, Y(k.high)); x.lineTo(xx, Y(k.low)); x.stroke();
        var yo = Y(k.open), yc = Y(k.close);
        x.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    
    if(s) {
        if(Number.isFinite(Number(s.stop))) level(Number(s.stop), '#ff4d6d', 'SL');
        if(Number.isFinite(Number(s.entry))) level(Number(s.entry), '#13dba0', 'GİRİŞ');
        if(Number.isFinite(Number(s.tp1))) level(Number(s.tp1), '#4da3ff', 'TP1');
        if(Number.isFinite(Number(s.tp2))) level(Number(s.tp2), '#4da3ff', 'TP2');
        if(Number.isFinite(Number(s.tp3))) level(Number(s.tp3), '#4da3ff', 'TP3');
    }
    
    function level(q, col, label) {
        var yy = Y(q);
        x.strokeStyle = col; x.setLineDash([4, 4]);
        x.beginPath(); x.moveTo(L, yy); x.lineTo(w - R, yy); x.stroke();
        x.setLineDash([]); x.fillStyle = col; x.font = 'bold 8px Arial';
        x.fillText(label + ' ' + p(q), w - R + 3, yy + 3);
    }
}

document.querySelectorAll('[data-t]').forEach(function(b) {
    b.onclick = function() {
        document.querySelectorAll('[data-t]').forEach(function(z) { z.classList.remove('active'); });
        b.classList.add('active');
        S.tf = b.getAttribute('data-t');
        loadChart();
    };
});

function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host);
    ws.onmessage = function(e) {
        try { var m = JSON.parse(e.data); if(m.type === 'snapshot') render(m.data); } catch(_) {}
    };
    ws.onclose = function() { setTimeout(connect, 2500); };
}
connect();

setInterval(function() {
    fetch('/api/status', {cache:'no-store'}).then(function(r) { return r.json(); }).then(render).catch(function(){});
}, 10000);

fetch('/api/status', {cache:'no-store'}).then(function(r) { return r.json(); }).then(render).catch(function(){});
window.addEventListener('resize', draw);
setInterval(loadChart, 10000);
</script>
</body>
</html>`;

// ========================= SERVER START =========================
app.get('/', (req, res) => res.type('html').send(HTML));

process.on('unhandledRejection', e => { STATE.lastError = e?.message || String(e); console.error('UNHANDLED', e); });
process.on('uncaughtException', e => { STATE.lastError = e?.message || String(e); console.error('UNCAUGHT', e); });
server.on('error', (err) => { console.error('SERVER BIND ERROR:', err.message); process.exit(1); });

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🚀 SONNY AI SIGNAL SCANNER V5.2');
    console.log('📊 4H/2H BREAKOUT + RETEST + RSI');
    console.log('==============================================');
    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | ' + STATE.markets.length);
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR:', e.message);
    }
    setTimeout(() => { runScan().catch(e => console.error('SCAN:', e.message)); }, 3000);
    setInterval(() => { if (!STATE.scanning) runScan().catch(e => console.error('SCAN:', e.message)); }, CFG.SCAN_MS);
    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE:', e.message)), CFG.LIVE_MS);
});
