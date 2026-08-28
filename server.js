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
    
    FOUR_H_HISTORY: 100,
    TWO_H_HISTORY: 100,
    M15_HISTORY: 150,
    
    MIN_VOLUME_USDT: Number(process.env.MIN_VOLUME_USDT || 1000000),
    HIGH_VOLUME_USDT: 5000000,
    MID_VOLUME_USDT: 2000000,
    
    LOOKBACK_4H: 30,
    LOOKBACK_2H: 30,
    RETEST_PERCENT: 0.80,
    RSI_PERIOD: 14,
    LONG_RSI_MIN: 48,
    LONG_RSI_MAX: 68,
    SHORT_RSI_MIN: 32,
    SHORT_RSI_MAX: 52,
    MIN_SIGNAL_SCORE: 65,
    MAX_SIGNALS: 20,
    
    SIGNAL_TTL: 45 * 60 * 1000,
    ENTRY_TTL: 20 * 60 * 1000,
    COOLDOWN: 2 * 60 * 60 * 1000,
    
    PAPER_MODE: true,
    AUTO_TRADE: false,
    DEBUG: false,
    
    SCAN_MS: 60000,
    LIVE_MS: 10000,
    CONCURRENCY: 3,
    REQUEST_DELAY: 150,
    CACHE_TTL: { '15m': 30 * 1000, '1h': 60 * 1000, '2h': 2 * 60 * 1000, '4h': 5 * 60 * 1000 },
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
    market: { label: 'YATAY / KARIŞIK', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' },
    stats: { universe: 0, candidates: 0, deep: 0, analyzed: 0, signals: 0, errors: 0, longSignals: 0, shortSignals: 0, activeTrades: 0 },
    signalHistory: [],
    performance: { wins: 0, losses: 0, winRate: 0, avgRR: 0, totalR: 0, grossProfitR: 0, grossLossR: 0 },
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
function percent(v, base) { return base ? (v / base) * 100 : 0; }

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
        catch (e) { console.error(`Market yüklenemedi (${i + 1}/${maxRetries}):`, e.message); if (i < maxRetries - 1) await sleep(delayMs); }
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
    const ttl = CFG.CACHE_TTL[tf] || 30 * 1000;
    if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
    try {
        const data = await queueRequest(() => exchange.fetchOHLCV(symbol, tf, undefined, limit));
        const cleaned = Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0]) : [];
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
            volumeTier: volume >= CFG.HIGH_VOLUME_USDT ? 'HIGH' : volume >= CFG.MID_VOLUME_USDT ? 'MID' : 'LOW'
        });
    }
    rows.sort((a, b) => b.volume - a.volume);
    return rows.slice(0, CFG.RADAR);
}

// ========================= RSI =========================
function calculateRSI(candles, period = 14) {
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

// ========================= BREAKOUT INFO =========================
function breakoutInfo(c, lookback) {
    if (c.length < lookback + 5) return null;
    const closedC = c.slice(0, -1);
    const recent = Math.min(8, closedC.length - lookback);
    let longBreak = false, shortBreak = false, longLevel = null, shortLevel = null;
    
    for (let i = closedC.length - recent; i < closedC.length; i++) {
        const history = closedC.slice(i - lookback, i);
        if (history.length < lookback) continue;
        const resistance = Math.max(...history.map(x => n(x[2])));
        const support = Math.min(...history.map(x => n(x[3])));
        const current = closedC[i];
        const previous = closedC[i - 1];
        
        if (n(current[4]) > resistance && n(previous[4]) <= resistance) {
            longBreak = true;
            longLevel = resistance;
        }
        if (n(current[4]) < support && n(previous[4]) >= support) {
            shortBreak = true;
            shortLevel = support;
        }
    }
    
    const last = closedC.slice(-lookback);
    return {
        current: closedC[closedC.length - 1],
        resistance: longLevel || Math.max(...last.map(x => n(x[2]))),
        support: shortLevel || Math.min(...last.map(x => n(x[3]))),
        longBreak, shortBreak, longLevel, shortLevel
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

// ========================= TRADE PLAN =========================
function createPlan(row, dir, level, rv, sc, reason) {
    const entryLow = dir === 'LONG' ? level * 0.998 : level * 1.002;
    const entryHigh = dir === 'LONG' ? level * 1.004 : level * 0.996;
    const stop = dir === 'LONG' ? level * 0.982 : level * 1.018;
    const risk = Math.abs(level - stop);
    const tp1 = dir === 'LONG' ? level + risk * 1.5 : level - risk * 1.5;
    const tp2 = dir === 'LONG' ? level + risk * 2 : level - risk * 2;
    const tp3 = dir === 'LONG' ? level + risk * 3 : level - risk * 3;
    const rr = risk > 0 ? Math.abs(tp1 - level) / risk : 0;
    
    return {
        symbol: cleanSymbol(row.symbol),
        marketSymbol: row.symbol,
        direction: dir,
        strategy: '4H/2H BREAKOUT + RETEST + RSI',
        score: sc,
        confidence: sc,
        currentPrice: row.price,
        entry: n(level, 8),
        entryLow: n(entryLow, 8),
        entryHigh: n(entryHigh, 8),
        stop: n(stop, 8),
        stopLoss: n(stop, 8),
        tp1: n(tp1, 8),
        tp2: n(tp2, 8),
        tp3: n(tp3, 8),
        rr: Number(rr.toFixed(2)),
        rsi: n(rv, 1),
        level: n(level, 8),
        breakoutLevel: n(level, 8),
        timeframeLevel: '4H/2H',
        change24h: row.change,
        reason: reason,
        volumeTier: row.volumeTier,
        volumeFormatted: row.volumeFormatted,
        status: 'GİRİŞ BEKLENİYOR',
        entryReady: false,
        paperEntry: null,
        entryTime: null,
        maeR: null,
        mfeR: null,
        signalAt: Date.now(),
        cooldownKey: cleanSymbol(row.symbol)
    };
}

// ========================= MAKE SIGNAL =========================
function makeSignal(row, h4, h2, m15) {
    const rv = calculateRSI(m15, CFG.RSI_PERIOD);
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
            const sc = calculateScore(h4.longBreak, h2.longBreak, true, true, rv, 'LONG');
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.longBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' + (h2.longBreak ? '2H onay' : '2H yapı') + ' + retest + RSI';
                return createPlan(row, 'LONG', level, rv, sc, reason);
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
            const sc = calculateScore(h4.shortBreak, h2.shortBreak, true, true, rv, 'SHORT');
            if (sc >= CFG.MIN_SIGNAL_SCORE) {
                const reason = (h4.shortBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' + (h2.shortBreak ? '2H onay' : '2H yapı') + ' + retest + RSI';
                return createPlan(row, 'SHORT', level, rv, sc, reason);
            }
        }
    }
    
    return null;
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        const cleanSym = cleanSymbol(row.symbol);
        
        // Cooldown
        const cooldownTime = STATE.cooldowns.get(cleanSym);
        if (cooldownTime && Date.now() - cooldownTime < CFG.COOLDOWN) return null;
        
        // Aktif sinyal
        const existing = [...STATE.signals.values()].find(s => s.symbol === cleanSym);
        if (existing) return null;
        
        const [c4, c2, c15] = await Promise.all([
            getCandles(row.symbol, '4h', CFG.FOUR_H_HISTORY),
            getCandles(row.symbol, '2h', CFG.TWO_H_HISTORY),
            getCandles(row.symbol, '15m', CFG.M15_HISTORY)
        ]);
        
        if (c4.length < 40 || c2.length < 40 || c15.length < 50) return null;
        
        const h4 = breakoutInfo(c4, CFG.LOOKBACK_4H);
        const h2 = breakoutInfo(c2, CFG.LOOKBACK_2H);
        if (!h4 || !h2) return null;
        
        const signal = makeSignal(row, h4, h2, c15);
        if (!signal) return null;
        
        signal.id = `${cleanSym}|${signal.direction}`;
        STATE.signals.set(signal.id, signal);
        
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
    
    try {
        const rows = await getTickers();
        STATE.universe = rows;
        STATE.stats.universe = rows.length;
        calculateMarketRegime(rows);
        
        const candidates = rows.filter(r => r.volumeTier !== 'LOW').slice(0, CFG.CANDIDATES);
        STATE.candidates = candidates;
        STATE.stats.candidates = candidates.length;
        
        const deepCandidates = candidates.slice(0, CFG.DEEP);
        STATE.deep = deepCandidates;
        STATE.stats.deep = deepCandidates.length;
        STATE.stats.analyzed = 0;
        
        for (let i = 0; i < deepCandidates.length; i += CFG.CONCURRENCY) {
            const batch = deepCandidates.slice(i, i + CFG.CONCURRENCY);
            await Promise.all(batch.map(async row => { await analyzeCoin(row); STATE.stats.analyzed++; }));
            await sleep(50);
        }
        
        STATE.lastScan = Date.now();
        
        const active = [...STATE.signals.values()];
        STATE.stats.signals = active.length;
        STATE.stats.longSignals = active.filter(s => s.direction === 'LONG').length;
        STATE.stats.shortSignals = active.filter(s => s.direction === 'SHORT').length;
        STATE.stats.activeTrades = active.filter(s => s.paperEntry).length;
        
        console.log(`📊 Aktif: ${active.length} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
    } catch (error) {
        STATE.lastError = error.message;
        console.error('SCAN ERROR:', error.message);
    } finally {
        STATE.scanning = false;
        broadcast();
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
            recordResult(signal, 'MISSED_ENTRY');
            continue;
        }
        
        const ticker = tickers[signal.marketSymbol];
        if (!ticker) continue;
        const current = n(ticker.last || ticker.close);
        if (!(current > 0)) continue;
        signal.currentPrice = current;
        
        if (!signal.paperEntry) {
            const inZone = current >= signal.entryLow && current <= signal.entryHigh;
            if (inZone && CFG.PAPER_MODE) {
                signal.paperEntry = current;
                signal.entryTime = now;
                signal.entryReady = true;
                signal.status = 'İŞLEM AÇILDI';
            }
            
            if (signal.direction === 'LONG' && current > signal.entryHigh) signal.status = 'FİYAT YUKARIDA';
            else if (signal.direction === 'SHORT' && current < signal.entryLow) signal.status = 'FİYAT AŞAĞIDA';
        }
        
        if (signal.paperEntry) {
            if (signal.direction === 'LONG') {
                if (current <= signal.stop) { STATE.signals.delete(id); recordResult(signal, 'STOP'); continue; }
                if (current >= signal.tp3) { STATE.signals.delete(id); recordResult(signal, 'TP3'); continue; }
                if (current >= signal.tp2) signal.status = 'TP2 HEDEF';
                else if (current >= signal.tp1) signal.status = 'TP1 HEDEF';
                else if (current < signal.paperEntry) signal.status = 'TERS';
                else signal.status = 'KARDA';
            } else {
                if (current >= signal.stop) { STATE.signals.delete(id); recordResult(signal, 'STOP'); continue; }
                if (current <= signal.tp3) { STATE.signals.delete(id); recordResult(signal, 'TP3'); continue; }
                if (current <= signal.tp2) signal.status = 'TP2 HEDEF';
                else if (current <= signal.tp1) signal.status = 'TP1 HEDEF';
                else if (current > signal.paperEntry) signal.status = 'TERS';
                else signal.status = 'KARDA';
            }
        }
        
        if (!signal.paperEntry && now - signal.signalAt > CFG.ENTRY_TTL) {
            STATE.signals.delete(id);
            recordResult(signal, 'MISSED_ENTRY');
        }
    }
    
    cleanup();
    const active = [...STATE.signals.values()];
    STATE.stats.signals = active.length;
    STATE.stats.longSignals = active.filter(s => s.direction === 'LONG').length;
    STATE.stats.shortSignals = active.filter(s => s.direction === 'SHORT').length;
    STATE.stats.activeTrades = active.filter(s => s.paperEntry).length;
    broadcast();
}

function recordResult(signal, result) {
    signal.result = result;
    signal.closedAt = Date.now();
    STATE.signalHistory.push({ ...signal });
    
    const perf = STATE.performance;
    const risk = Math.abs(signal.entry - signal.stop);
    if (risk > 0) {
        let r = 0;
        if (result === 'STOP') r = -1;
        else if (result === 'TP1') r = 1.5;
        else if (result === 'TP2') r = 2;
        else if (result === 'TP3') r = 3;
        perf.totalR += r;
        if (r > 0) { perf.wins++; perf.grossProfitR += r; }
        else if (r < 0) { perf.losses++; perf.grossLossR += Math.abs(r); }
        const total = perf.wins + perf.losses;
        perf.winRate = total ? (perf.wins / total) * 100 : 0;
        perf.avgRR = total ? perf.totalR / total : 0;
        perf.profitFactor = perf.grossLossR > 0 ? perf.grossProfitR / perf.grossLossR : (perf.grossProfitR > 0 ? Infinity : 0);
    }
    
    if (CFG.PAPER_MODE) STATE.paperTrades.push({ ...signal, paperResult: result });
    if (result === 'STOP' || result === 'MISSED_ENTRY') STATE.cooldowns.set(signal.symbol, Date.now());
}

// ========================= CLEANUP =========================
function cleanup() {
    const now = Date.now();
    for (const [id, signal] of STATE.signals) { if (now - signal.signalAt > CFG.SIGNAL_TTL) STATE.signals.delete(id); }
    for (const [key, time] of STATE.cooldowns) { if (now - time > CFG.COOLDOWN) STATE.cooldowns.delete(key); }
    STATE.stats.signals = STATE.signals.size;
}

// ========================= MARKET REGIME =========================
function calculateMarketRegime(rows) {
    if (!rows.length) { STATE.market = { label: 'YATAY', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0, btc: 'NEUTRAL', eth: 'NEUTRAL' }; return; }
    let green = 0, red = 0, total = 0;
    for (const r of rows) { if (r.change > 0.5) green++; else if (r.change < -0.5) red++; total += r.change; }
    const breadth = (green / Math.max(green + red, 1)) * 100;
    const average = total / rows.length;
    let direction = 'FLAT', label = 'YATAY';
    if (breadth >= 55 && average >= 0.5) { direction = 'LONG'; label = 'POZİTİF'; }
    else if (breadth <= 45 && average <= -0.5) { direction = 'SHORT'; label = 'NEGATİF'; }
    STATE.market = { label, direction, breadth: Number(breadth.toFixed(1)), green, red, average: Number(average.toFixed(2)), btc: 'NEUTRAL', eth: 'NEUTRAL' };
}

// ========================= STATUS =========================
function status() {
    cleanup();
    const signals = [...STATE.signals.values()].sort((a, b) => b.score - a.score);
    return { ok: true, lastScan: STATE.lastScan, error: STATE.lastError, stats: { ...STATE.stats }, signals, preparing: [], pending: [], market: STATE.market, signalHistoryCount: STATE.signalHistory.length, performance: STATE.performance, paperTrades: STATE.paperTrades.slice(-20) };
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
app.get('/api/history', auth, (req, res) => res.json({ success: true, history: STATE.signalHistory.slice(-100) }));

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
<title>SONNY AI TRADER</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.app{display:grid;grid-template-columns:280px 1fr 300px;height:100vh;}
@media(max-width:1000px){.app{grid-template-columns:220px 1fr;}.right{display:none;}}
.left{background:#0b111b;border-right:1px solid #1a2533;overflow-y:auto;padding:15px;}
.brand{font-size:16px;font-weight:bold;color:#13dba0;margin-bottom:3px;}
.sub{color:#718096;font-size:9px;margin-bottom:12px;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:12px;}
.st{background:#101826;border:1px solid #1b2939;padding:8px 3px;text-align:center;border-radius:5px;}
.st b{display:block;font-size:16px;color:#13dba0;}
.st span{color:#64748b;font-size:8px;}
.cards{display:flex;flex-direction:column;gap:7px;overflow-y:auto;height:calc(100vh - 180px);}
.card{background:#101826;border:1px solid #1c2938;border-radius:7px;padding:10px;cursor:pointer;transition:.15s;}
.card:hover{border-color:#13dba0;}
.card.selected{border:2px solid #13dba0;background:#0d1a15;}
.card.long{border-left:4px solid #13dba0;}
.card.short{border-left:4px solid #ff5570;}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
.coin{font-size:13px;font-weight:bold;}
.dir{font-size:9px;padding:2px 6px;border-radius:3px;font-weight:bold;}
.dir.long{background:#123c31;color:#13dba0;}
.dir.short{background:#421d28;color:#ff5570;}
.price{font-size:14px;font-weight:bold;margin:3px 0;}
.details{font-size:9px;color:#8b9bb4;}
.status-badge{display:inline-block;font-size:8px;padding:2px 6px;border-radius:3px;margin-top:4px;font-weight:bold;}
.status-entry{background:#101826;color:#8b9bb4;}
.status-active{background:#0d3d2a;color:#13dba0;}
.status-warn{background:#421d1d;color:#ff5570;}
.status-kar{background:#0d3d2a;color:#13dba0;}
.status-tp{background:#123c31;color:#55a7ff;}
.main{min-width:0;display:flex;flex-direction:column;background:#0b111b;padding:12px;}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.title{font-weight:bold;font-size:14px;color:#13dba0;}
.info{color:#64748b;font-size:9px;}
.charthead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.chart-title{font-size:11px;font-weight:bold;}
.tf{display:flex;gap:3px;}
.tf button{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:4px 8px;font-size:8px;cursor:pointer;}
.tf button.active{color:#13dba0;border-color:#13dba0;}
.chart{flex:1;min-height:0;}
canvas{width:100%;height:100%;display:block;}
.right{background:#0b111b;border-left:1px solid #1a2533;overflow-y:auto;padding:12px;}
.box{background:#101826;border:1px solid #1a2938;border-radius:7px;padding:10px;margin-bottom:8px;}
.bt{color:#64748b;font-size:8px;font-weight:bold;}
.reg{font-size:14px;font-weight:bold;margin-top:4px;}
.reg.long{color:#13dba0;}
.reg.short{color:#ff5570;}
.mi{color:#718096;font-size:9px;line-height:1.5;margin-top:3px;}
.signal-title{font-size:13px;font-weight:bold;}
.signal-title.long{color:#13dba0;}
.signal-title.short{color:#ff5570;}
.signal-status{font-size:10px;font-weight:bold;margin:4px 0;padding:4px 8px;border-radius:3px;display:inline-block;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px;}
.lv{background:#0b111b;border:1px solid #1b2938;border-radius:4px;padding:5px;}
.lv span{display:block;color:#64748b;font-size:7px;margin-bottom:1px;}
.lv b{font-size:10px;}
.lv.entry b{color:#13dba0;}
.lv.stop b{color:#ff5570;}
.lv.tp b{color:#55a7ff;}
.pi{border:1px solid #1b2938;border-radius:4px;padding:5px;font-size:8px;color:#718096;}
.pi b{color:#dbe4ee;font-size:9px;}
.empty{color:#64748b;font-size:9px;padding:8px 4px;text-align:center;}
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
<div class="bt">PERFORMANS</div>
<div id="perf"><div class="empty">-</div></div>
</div>
</aside>
</div>
<script>
(function(){
var S={selected:'BTC/USDT:USDT',tf:'15m',candles:[],signal:null};
var _signals=[];
function $(id){return document.getElementById(id);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function p(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);if(x>=.01)return x.toFixed(7);if(x>=.0001)return x.toFixed(8);return x.toFixed(10);}
function normalize(a){return (a||[]).map(function(x){return Array.isArray(x)?{time:+x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{time:+x.time,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)};}).filter(function(x){return Number.isFinite(x.time)&&Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close);}).sort(function(a,b){return a.time-b.time;});}

// Event delegation - TIKLAMA
document.getElementById('cards').addEventListener('click', function(e) {
    var card = e.target.closest('.card');
    if (card) {
        var symbol = card.getAttribute('data-symbol');
        selectSignal(symbol);
    }
});

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
    $('c').textContent = st.candidates || 0;
    $('d').textContent = st.deep || 0;
    $('info').textContent = data.lastScan ? 'Son: ' + new Date(data.lastScan).toLocaleTimeString('tr-TR') : '-';
    var m = data.market || {};
    $('reg').textContent = m.label || 'YATAY';
    $('reg').className = 'reg ' + (m.direction === 'LONG' ? 'long' : m.direction === 'SHORT' ? 'short' : '');
    $('mi').innerHTML = 'Breadth %' + esc(m.breadth) + '<br>Yeşil ' + esc(m.green) + ' • Kırmızı ' + esc(m.red);
    
    _signals = data.signals || [];
    var cards = $('cards');
    cards.innerHTML = '';
    if(!_signals.length){ cards.innerHTML = '<div class="empty">Sinyal yok</div>'; }
    
    _signals.forEach(function(s){
        var el = document.createElement('div');
        var cls = 'card ' + (s.direction === 'LONG' ? 'long ' : 'short ') + (s.marketSymbol === S.selected ? 'selected ' : '');
        var statusText = s.status || 'GİRİŞ BEKLENİYOR';
        var statusCls = 'status-entry';
        if(s.status === 'İŞLEM AÇILDI'){ statusCls = 'status-active'; statusText = 'İŞLEM AÇILDI'; }
        else if(s.status === 'KARDA'){ statusCls = 'status-kar'; statusText = 'KARDA'; }
        else if(s.status === 'TERS'){ statusCls = 'status-warn'; statusText = 'TERS'; }
        else if(s.status === 'FİYAT YUKARIDA' || s.status === 'FİYAT AŞAĞIDA'){ statusCls = 'status-warn'; }
        else if(s.status && s.status.startsWith('TP')){ statusCls = 'status-tp'; }
        
        el.setAttribute('data-symbol', s.marketSymbol);
        el.innerHTML = '<div class="card-head"><div class="coin">' + esc(s.symbol) + '</div><div class="dir ' + (s.direction === 'LONG' ? 'long' : 'short') + '">' + esc(s.direction) + '</div></div>' +
        '<div class="price">' + p(s.currentPrice || s.entry) + '</div>' +
        '<div class="details">Güç: ' + esc(s.score) + '/100 • ' + esc(s.volumeFormatted || '?') + '</div>' +
        '<span class="status-badge ' + statusCls + '">' + esc(statusText) + '</span>';
        
        cards.appendChild(el);
    });
    
    var selected = _signals.find(function(x){ return x.marketSymbol === S.selected; }) || _signals[0] || null;
    if(selected){ S.selected = selected.marketSymbol; S.signal = selected; setActive(selected); }
    else { setActive(null); }
    
    $('perf').innerHTML = '<div class="pi"><b>📊 Performans</b><br>Win: ' + esc(data.performance ? data.performance.wins : 0) + ' • Loss: ' + esc(data.performance ? data.performance.losses : 0) + '<br>WinRate: %' + esc(data.performance ? data.performance.winRate : 0) + '</div>';
}

function setActive(s){
    if(!s){ $('active').innerHTML = '<div class="empty">Sinyal seçin</div>'; return; }
    var cls = s.direction === 'LONG' ? 'long' : 'short';
    var statusColor = '#718096', statusBg = '#101826';
    if(s.status === 'TERS' || s.status === 'FİYAT YUKARIDA' || s.status === 'FİYAT AŞAĞIDA'){ statusColor = '#ff5570'; statusBg = '#1a1015'; }
    else if(s.status === 'KARDA' || s.status === 'İŞLEM AÇILDI'){ statusColor = '#13dba0'; statusBg = '#0d1a15'; }
    else if(s.status && s.status.startsWith('TP')){ statusColor = '#55a7ff'; statusBg = '#101826'; }
    
    $('active').innerHTML = '<div class="signal-title ' + cls + '">' + esc(s.symbol) + ' • ' + esc(s.direction) + '</div>' +
    '<div class="signal-status" style="background:' + statusBg + ';color:' + statusColor + ';">' + esc(s.status || 'GİRİŞ BEKLENİYOR') + '</div>' +
    '<div class="levels">' +
    '<div class="lv entry"><span>GİRİŞ</span><b>' + p(s.entryLow) + ' — ' + p(s.entryHigh) + '</b></div>' +
    '<div class="lv stop"><span>STOP</span><b>' + p(s.stop) + '</b></div>' +
    '<div class="lv tp"><span>TP1</span><b>' + p(s.tp1) + '</b></div>' +
    '<div class="lv tp"><span>TP2</span><b>' + p(s.tp2) + '</b></div>' +
    '<div class="lv tp"><span>TP3</span><b>' + p(s.tp3) + '</b></div>' +
    '<div class="lv"><span>R:R</span><b>1:' + esc(s.rr) + '</b></div></div>' +
    '<div class="mi" style="margin-top:5px;">RSI: ' + esc(s.rsi) + '<br>' + esc(s.reason || '') + '</div>';
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
        S.selected = d.symbol || S.selected;
        S.tf = d.timeframe || S.tf;
        updateHeader();
        draw();
    } catch(e) { console.error('chart', e); }
}

function draw(){
    var c = $('cv');
    var r = c.getBoundingClientRect();
    var dpr = devicePixelRatio || 1;
    var w = Math.max(250, Math.floor(r.width));
    var h = Math.max(250, Math.floor(r.height));
    c.width = w * dpr;
    c.height = h * dpr;
    var x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#070b11';
    x.fillRect(0, 0, w, h);
    
    if(!S.candles.length) {
        x.fillStyle = '#718096';
        x.font = '11px Arial';
        x.fillText('Veri bekleniyor...', 15, 25);
        return;
    }
    
    var visible = S.candles.slice(-100);
    var candleMin = Math.min.apply(Math, visible.map(function(k){ return k.low; }));
    var candleMax = Math.max.apply(Math, visible.map(function(k){ return k.high; }));
    
    var s = S.signal;
    var signalLevels = [];
    if(s) {
        [s.entryLow, s.entryHigh, s.stop, s.tp1, s.tp2, s.tp3].forEach(function(q) {
            if(Number.isFinite(Number(q))) signalLevels.push(Number(q));
        });
    }
    
    var min = candleMin, max = candleMax;
    if(signalLevels.length) {
        var sigMin = Math.min.apply(Math, signalLevels);
        var sigMax = Math.max.apply(Math, signalLevels);
        if(sigMin < candleMin) min = sigMin;
        if(sigMax > candleMax) max = sigMax;
    }
    
    var pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;
    
    var L = 50, R = 70, T = 15, B = 15;
    var PW = w - L - R;
    var PH = h - T - B;
    
    function Y(q) { return T + (max - q) / (max - min) * PH; }
    function X(i) { return L + i * PW / Math.max(1, visible.length - 1); }
    
    x.strokeStyle = '#182330';
    x.lineWidth = 1;
    for(var g = 0; g <= 4; g++) {
        var gy = T + PH * g / 4;
        x.beginPath();
        x.moveTo(L, gy);
        x.lineTo(w - R, gy);
        x.stroke();
        x.fillStyle = '#607083';
        x.font = '8px Arial';
        x.fillText(p(max - (max - min) * g / 4), 3, gy + 3);
    }
    
    var step = PW / Math.max(1, visible.length - 1);
    var bw = Math.max(2, Math.min(8, step * 0.6));
    
    visible.forEach(function(k, i) {
        var xx = X(i);
        var up = k.close >= k.open;
        var col = up ? '#13e0a2' : '#ff4d6d';
        x.strokeStyle = col;
        x.fillStyle = col;
        x.beginPath();
        x.moveTo(xx, Y(k.high));
        x.lineTo(xx, Y(k.low));
        x.stroke();
        var yo = Y(k.open);
        var yc = Y(k.close);
        x.fillRect(xx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    
    if(s) {
        var et = Y(s.entryHigh);
        var eb = Y(s.entryLow);
        x.fillStyle = 'rgba(19,224,162,0.12)';
        x.fillRect(L, Math.min(et, eb), PW, Math.abs(et - eb));
        
        level(s.stop, '#ff4d6d', 'SL');
        level(s.entry, '#13dba0', 'GİRİŞ');
        level(s.tp1, '#4da3ff', 'TP1');
        level(s.tp2, '#4da3ff', 'TP2');
        level(s.tp3, '#4da3ff', 'TP3');
    }
    
    function level(q, col, label) {
        if(!Number.isFinite(Number(q))) return;
        var yy = Y(Number(q));
        x.strokeStyle = col;
        x.setLineDash([4, 4]);
        x.beginPath();
        x.moveTo(L, yy);
        x.lineTo(w - R, yy);
        x.stroke();
        x.setLineDash([]);
        x.fillStyle = col;
        x.font = 'bold 8px Arial';
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
fetch('/api/status', {cache:'no-store'}).then(function(r) { return r.json(); }).then(render).catch(function(){});
window.addEventListener('resize', draw);
setInterval(loadChart, 5000);
})();
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
    console.log('🚀 SONNY AI TRADER (4H/2H BREAKOUT + RETEST + RSI)');
    console.log('==============================================');
    try {
        await loadMarketsWithRetry();
        console.log('MARKETS | ' + STATE.markets.length);
    } catch (e) {
        STATE.lastError = e.message;
        console.error('BOOT ERROR:', e.message);
    }
    setTimeout(() => { runScan().catch(e => console.error('SCAN:', e.message)); }, 1000);
    setInterval(() => { if (!STATE.scanning) runScan().catch(e => console.error('SCAN:', e.message)); }, CFG.SCAN_MS);
    setInterval(() => updateLiveSignals().catch(e => console.error('LIVE:', e.message)), CFG.LIVE_MS);
});
