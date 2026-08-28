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
    M15_HISTORY: 100,
    
    MIN_VOLUME_USDT: 2000000,
    HIGH_VOLUME_USDT: 5000000,
    
    MIN_BODY_RATIO: 0.5,
    MIN_VOLUME_SURGE: 2.0,
    MIN_MOVE_PERCENT: 0.2,
    MAX_MOVE_PERCENT: 2.0,
    
    TP1_RR: 1.5,
    TP2_RR: 2.5,
    SL_ATR_MULT: 0.8,
    
    SIGNAL_TTL: 30 * 60 * 1000,
    MAX_SIGNALS: 30,
    
    SCAN_MS: 30000,
    LIVE_MS: 5000,
    CONCURRENCY: 3,
    REQUEST_DELAY: 200,
    CACHE_TTL: { '15m': 30 * 1000 },
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
    selected: 'BTC/USDT:USDT',
    selectedTf: '15m',
    scanning: false,
    lastScan: 0,
    lastError: '',
    market: { label: 'YATAY', direction: 'FLAT', breadth: 50, green: 0, red: 0, average: 0 },
    stats: { universe: 0, candidates: 0, deep: 0, analyzed: 0, signals: 0, longSignals: 0, shortSignals: 0 },
    signalHistory: [],
    performance: { wins: 0, losses: 0, winRate: 0, totalR: 0, avgRR: 0 },
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
    if (cached && Date.now() - cached.timestamp < CFG.CACHE_TTL[tf]) return cached.data;
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

// ========================= SCALP SİNYAL =========================
function detectScalpSignal(candles15m) {
    const c15 = closed(candles15m);
    if (c15.length < 30) return null;
    
    const last = c15[c15.length - 1];
    const prev = c15[c15.length - 2];
    
    const lastOpen = n(last[1]);
    const lastClose = n(last[4]);
    const lastHigh = n(last[2]);
    const lastLow = n(last[3]);
    const lastVolume = n(last[5]);
    const prevClose = n(prev[4]);
    
    const body = Math.abs(lastClose - lastOpen);
    const range = lastHigh - lastLow;
    const bodyRatio = range > 0 ? body / range : 0;
    const movePercent = prevClose > 0 ? Math.abs((lastClose - prevClose) / prevClose) * 100 : 0;
    
    const volHistory = c15.slice(-15, -1).map(x => n(x[5]));
    const avgVol = avg(volHistory.filter(Boolean));
    const volumeSurge = avgVol > 0 ? lastVolume / avgVol : 1;
    const atrValue = calculateATR(candles15m, 14);
    
    if (bodyRatio < CFG.MIN_BODY_RATIO) return null;
    if (volumeSurge < CFG.MIN_VOLUME_SURGE) return null;
    if (movePercent < CFG.MIN_MOVE_PERCENT) return null;
    if (movePercent > CFG.MAX_MOVE_PERCENT) return null;
    if (atrValue <= 0) return null;
    
    let direction = null;
    let stop = 0;
    
    if (lastClose > lastOpen && lastClose > prevClose) {
        direction = 'LONG';
        stop = lastClose - atrValue * CFG.SL_ATR_MULT;
    } else if (lastClose < lastOpen && lastClose < prevClose) {
        direction = 'SHORT';
        stop = lastClose + atrValue * CFG.SL_ATR_MULT;
    }
    
    if (!direction) return null;
    
    const entry = lastClose;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    
    let tp1, tp2;
    if (direction === 'LONG') {
        tp1 = entry + risk * CFG.TP1_RR;
        tp2 = entry + risk * CFG.TP2_RR;
    } else {
        tp1 = entry - risk * CFG.TP1_RR;
        tp2 = entry - risk * CFG.TP2_RR;
    }
    
    let score = 40;
    if (bodyRatio >= 0.7) score += 10;
    if (volumeSurge >= 4.0) score += 25;
    else if (volumeSurge >= 3.0) score += 15;
    else if (volumeSurge >= 2.0) score += 5;
    if (movePercent >= 0.4) score += 10;
    score = Math.min(95, score);
    
    if (score < 55) return null;
    
    return { direction, entry, stop, tp1, tp2, score, bodyRatio, volumeSurge, movePercent, atr: atrValue, time: n(last[0]) };
}

// ========================= ANALYZE COIN =========================
async function analyzeCoin(row) {
    try {
        if (row.volumeTier === 'LOW') return null;
        
        const existing = [...STATE.signals.values()].find(s => s.symbol === cleanSymbol(row.symbol));
        if (existing) return null;
        
        const c15 = await getCandles(row.symbol, '15m', CFG.M15_HISTORY);
        if (c15.length < 30) return null;
        
        const sig = detectScalpSignal(c15);
        if (!sig) return null;
        
        const cleanSym = cleanSymbol(row.symbol);
        const now = Date.now();
        
        const signal = {
            id: `${cleanSym}-${sig.direction}-${now}`,
            symbol: cleanSym,
            marketSymbol: row.symbol,
            direction: sig.direction,
            strategy: '15M SCALP',
            score: sig.score,
            confidence: sig.score,
            currentPrice: row.price,
            entry: sig.entry,
            entryPrice: sig.entry.toFixed(8),
            giris: sig.entry,
            stop: sig.stop,
            stopLoss: sig.stop,
            SL: sig.stop.toFixed(8),
            tp1: sig.tp1,
            TP1: sig.tp1.toFixed(8),
            tp2: sig.tp2,
            TP2: sig.tp2.toFixed(8),
            RR: CFG.TP1_RR.toFixed(2),
            rr: CFG.TP1_RR,
            reason: `${sig.direction} | Hacim: ${sig.volumeSurge.toFixed(1)}x | Gövde: ${(sig.bodyRatio * 100).toFixed(0)}%`,
            tacticalAnalysis: `Hacim ${sig.volumeSurge.toFixed(1)}x | Hareket %${sig.movePercent.toFixed(2)}`,
            volumeFormatted: row.volumeFormatted,
            volumeTier: row.volumeTier,
            volumeSurge: Number(sig.volumeSurge.toFixed(2)),
            bodyRatio: Number(sig.bodyRatio.toFixed(2)),
            movePercent: Number(sig.movePercent.toFixed(2)),
            timestamp: now,
            time: new Date().toLocaleTimeString('tr-TR'),
            signalAt: now,
            status: 'AKTİF',
            paperEntry: sig.entry,
            entryTime: now,
            cooldownKey: cleanSym
        };
        
        STATE.signals.set(signal.id, signal);
        
        if (sig.direction === 'LONG') STATE.stats.longSignals++;
        else STATE.stats.shortSignals++;
        
        console.log(`✅ ${cleanSym} ${sig.direction} | Giriş: ${sig.entry.toFixed(6)} | SL: ${sig.stop.toFixed(6)} | TP1: ${sig.tp1.toFixed(6)} | Hacim: ${sig.volumeSurge.toFixed(1)}x`);
        
        return signal;
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
            }
        }
        
        STATE.lastScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        
        console.log(`\n📊 Aktif: ${STATE.signals.size} (LONG: ${STATE.stats.longSignals}, SHORT: ${STATE.stats.shortSignals})`);
        
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
        result: result,
        rMultiple: rMultiple,
        score: signal.score,
        volumeSurge: signal.volumeSurge,
        closedAt: Date.now()
    };
    
    STATE.signalHistory.push(trade);
    
    const perf = STATE.performance;
    perf.totalR += rMultiple;
    
    if (rMultiple > 0) {
        perf.wins++;
    } else if (rMultiple < 0) {
        perf.losses++;
    }
    
    const total = perf.wins + perf.losses;
    perf.winRate = total ? (perf.wins / total) * 100 : 0;
    perf.avgRR = total ? perf.totalR / total : 0;
    
    console.log(`📊 ${signal.symbol} ${result} | R: ${rMultiple > 0 ? '+' : ''}${rMultiple.toFixed(2)}R | Win: ${perf.wins} Loss: ${perf.losses} WinRate: %${perf.winRate.toFixed(0)}`);
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
        preparing: [],
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
<title>SONNY SCALP</title>
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
<div class="brand">⚡ SONNY SCALP</div>
<div class="sub">15M MOMENTUM</div>
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
var S = {selected:'BTC/USDT:USDT', tf:'15m', candles:[], signal:null};
var _signals = [];
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
    $('c').textContent = st.candidates || 0;
    $('d').textContent = st.deep || 0;
    $('info').textContent = data.lastScan ? 'Son: ' + new Date(data.lastScan).toLocaleTimeString('tr-TR') : '-';
    var m = data.market || {};
    $('reg').textContent = m.label || 'YATAY';
    $('reg').className = 'reg ' + (m.direction === 'LONG' ? 'long' : m.direction === 'SHORT' ? 'short' : '');
    $('mi').innerHTML = 'Breadth %' + esc(m.breadth);
    
    _signals = data.signals || [];
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
        '<div class="details">Giriş: ' + p(s.entry) + ' | SL: ' + p(s.stop) + '</div>' +
        '<div class="details">TP1: ' + p(s.tp1) + ' | TP2: ' + p(s.tp2) + '</div>' +
        '<span class="status-badge ' + statusCls + '">' + esc(s.status || 'AKTİF') + '</span>';
        
        el.onclick = (function(sym){ return function(){ selectSignal(sym); }; })(s.marketSymbol);
        cards.appendChild(el);
    });
    
    var selected = _signals.find(function(x){ return x.marketSymbol === S.selected; }) || _signals[0] || null;
    if(selected){ S.selected = selected.marketSymbol; S.signal = selected; setActive(selected); }
    else { setActive(null); }
    
    var perf = data.performance || {};
    $('perf').innerHTML = '<div class="pi"><b>📊 Performans</b><br>Win: ' + esc(perf.wins || 0) + ' • Loss: ' + esc(perf.losses || 0) + '<br>WinRate: %' + esc(perf.winRate || 0) + '<br>ToplamR: ' + esc(perf.totalR || 0) + '</div>';
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
    '<div class="lv entry"><span>GİRİŞ</span><b>' + p(s.entry) + '</b></div>' +
    '<div class="lv stop"><span>STOP</span><b>' + p(s.stop) + '</b></div>' +
    '<div class="lv tp"><span>TP1</span><b>' + p(s.tp1) + '</b></div>' +
    '<div class="lv tp"><span>TP2</span><b>' + p(s.tp2) + '</b></div></div>' +
    '<div class="mi" style="margin-top:5px;">Skor: ' + esc(s.score) + '/100<br>Hacim: ' + esc(s.volumeFormatted || '?') + '<br>' + esc(s.reason || '') + '</div>';
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
        [s.entry, s.stop, s.tp1, s.tp2].forEach(function(q) {
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
}, 5000);

fetch('/api/status', {cache:'no-store'}).then(function(r) { return r.json(); }).then(render).catch(function(){});
window.addEventListener('resize', draw);
setInterval(loadChart, 5000);
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
    console.log('🚀 SONNY SCALP (15M MOMENTUM)');
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
