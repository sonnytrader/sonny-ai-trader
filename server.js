'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

// ========================= CONFIG =========================
const CFG = {
    // Tarama
    SCAN_INTERVAL_MS: 30 * 1000, // 30 saniyede bir tara
    RADAR_LIMIT: 100, // En yüksek hacimli 100 coin
    DEEP_LIMIT: 40, // Derin analiz için ilk 40
    
    // Sinyal
    SIGNAL_TTL_MS: 10 * 60 * 1000, // Sinyal 10 dakika geçerli
    SIGNAL_COOLDOWN_MS: 20 * 60 * 1000, // Aynı coin için 20 dk bekle
    MAX_ACTIVE_SIGNALS: 10, // Maksimum aktif sinyal
    
    // 15M Scalping Parametreleri
    TIMEFRAME: '15m',
    CANDLE_LIMIT: 100,
    
    // Filtreler
    MIN_VOLUME_USDT: 1000000, // 1M USDT
    MIN_MOVE_PERCENT: 0.3, // En az %0.3 hareket
    MAX_MOVE_PERCENT: 2.5, // En fazla %2.5 (aşırı hareket = riskli)
    MIN_VOLUME_SURGE: 1.8, // Hacim en az 1.8x artmalı
    MIN_BODY_RATIO: 0.6, // Mum gövdesi en az %60 olmalı
    
    // RSI
    RSI_PERIOD: 14,
    RSI_OVERSOLD: 30,
    RSI_OVERBOUGHT: 70,
    
    // EMA Trend
    EMA_FAST: 9,
    EMA_SLOW: 21,
    
    // TP/SL
    SL_ATR_MULT: 1.5,
    TP1_ATR_MULT: 2.0,
    TP2_ATR_MULT: 3.5,
    
    // ATR
    ATR_PERIOD: 14
};

// ========================= STATE =========================
const STATE = {
    signals: new Map(),
    cooldowns: new Map(),
    scanning: false,
    lastScan: 0,
    lastError: '',
    stats: { scanned: 0, analyzed: 0, signals: 0, longSignals: 0, shortSignals: 0 },
    performance: { wins: 0, losses: 0, timeouts: 0, winRate: 0, totalR: 0 }
};

// ========================= EXCHANGE =========================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ========================= CACHE =========================
const candleCache = new Map();
const CACHE_TTL = 15 * 1000; // 15 saniye cache

// ========================= HELPERS =========================
function n(v, d = 6) { const x = Number(v); return Number.isFinite(x) ? Number(x.toFixed(d)) : 0; }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatVolume(volume) {
    if (volume >= 1000000000) return (volume / 1000000000).toFixed(2) + 'B';
    if (volume >= 1000000) return (volume / 1000000).toFixed(1) + 'M';
    if (volume >= 1000) return (volume / 1000).toFixed(1) + 'K';
    return volume.toFixed(0);
}
function fmtPrice(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '-';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 100) return x.toFixed(3);
    if (x >= 1) return x.toFixed(5);
    if (x >= 0.01) return x.toFixed(7);
    return x.toFixed(8);
}

// ========================= İNDİKATÖRLER =========================
function calculateEMA(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = avg(values.slice(0, period));
    for (let i = period; i < values.length; i++) {
        ema = (values[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return avg(trs.slice(-period));
}

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
    const cacheKey = `${symbol}|${tf}|${limit}`;
    const cached = candleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
    
    try {
        const data = await exchange.fetchOHLCV(symbol, tf, undefined, limit);
        const cleaned = Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a, b) => a[0] - b[0]) : [];
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (e) {
        if (cached) return cached.data;
        return [];
    }
}

// ========================= PİYASA TARAMA =========================
async function getTopCoins() {
    try {
        const tickers = await exchange.fetchTickers();
        const rows = [];
        
        for (const [symbol, ticker] of Object.entries(tickers)) {
            if (!symbol.endsWith('/USDT:USDT')) continue;
            const volume = n(ticker.quoteVolume);
            const price = n(ticker.last);
            
            if (volume >= CFG.MIN_VOLUME_USDT && price > 0) {
                rows.push({
                    symbol,
                    cleanSymbol: symbol.replace('/USDT:USDT', ''),
                    price,
                    volume,
                    volumeFormatted: formatVolume(volume),
                    change: n(ticker.percentage)
                });
            }
        }
        
        rows.sort((a, b) => b.volume - a.volume);
        return rows.slice(0, CFG.RADAR_LIMIT);
    } catch (e) {
        console.error('Ticker hatası:', e.message);
        return [];
    }
}

// ========================= SİNYAL TESPİTİ =========================
function detectSignal(candles, row) {
    if (candles.length < 50) return null;
    
    // Kapanmış mumlar
    const closed = candles.slice(0, -1);
    const last = closed[closed.length - 1];
    const prev = closed[closed.length - 2];
    
    const lastOpen = n(last[1]);
    const lastClose = n(last[4]);
    const lastHigh = n(last[2]);
    const lastLow = n(last[3]);
    const lastVolume = n(last[5]);
    
    const prevClose = n(prev[4]);
    
    // Temel hesaplamalar
    const body = Math.abs(lastClose - lastOpen);
    const range = lastHigh - lastLow;
    const bodyRatio = range > 0 ? body / range : 0;
    const movePercent = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
    
    // Hacim kontrolü
    const volHistory = closed.slice(-20, -1).map(x => n(x[5]));
    const avgVol = avg(volHistory);
    const volumeSurge = avgVol > 0 ? lastVolume / avgVol : 1;
    
    // İndikatörler
    const closes = closed.map(x => n(x[4]));
    const rsi = calculateRSI(closes, CFG.RSI_PERIOD);
    const emaFast = calculateEMA(closes, CFG.EMA_FAST);
    const emaSlow = calculateEMA(closes, CFG.EMA_SLOW);
    const atr = calculateATR(closed, CFG.ATR_PERIOD);
    
    if (rsi === null || emaFast === null || emaSlow === null || atr <= 0) return null;
    
    // ============ FİLTRELER ============
    // 1. Hareket kontrolü
    if (Math.abs(movePercent) < CFG.MIN_MOVE_PERCENT) return null;
    if (Math.abs(movePercent) > CFG.MAX_MOVE_PERCENT) return null;
    
    // 2. Hacim kontrolü
    if (volumeSurge < CFG.MIN_VOLUME_SURGE) return null;
    
    // 3. Gövde kontrolü
    if (bodyRatio < CFG.MIN_BODY_RATIO) return null;
    
    let signal = null;
    
    // ============ LONG SİNYAL ============
    if (lastClose > lastOpen && // Yeşil mum
        lastClose > prevClose && // Yükseliş
        lastClose > emaFast && // EMA9 üstü
        emaFast > emaSlow && // EMA9 EMA21 üstü (yükseliş trendi)
        rsi > CFG.RSI_OVERSOLD && rsi < 65 && // RSI ne aşırı satım ne aşırı alım
        lastLow > n(prev[3])) { // Yükselen dip
        
        const entry = lastClose;
        const stop = lastLow - (atr * CFG.SL_ATR_MULT);
        const tp1 = entry + (atr * CFG.TP1_ATR_MULT);
        const tp2 = entry + (atr * CFG.TP2_ATR_MULT);
        
        const risk = entry - stop;
        const reward1 = tp1 - entry;
        const reward2 = tp2 - entry;
        
        if (risk > 0 && reward1 / risk >= 1.5) {
            signal = {
                direction: 'LONG',
                entry,
                stop,
                tp1,
                tp2,
                rsi: n(rsi, 1),
                volumeSurge: n(volumeSurge, 1),
                movePercent: n(movePercent, 2),
                bodyRatio: n(bodyRatio, 2),
                atr: n(atr),
                risk: n(risk),
                rr1: n(reward1 / risk, 1),
                rr2: n(reward2 / risk, 1),
                score: Math.min(95, 50 + volumeSurge * 10 + bodyRatio * 20 + (rsi > 40 && rsi < 60 ? 10 : 0))
            };
        }
    }
    
    // ============ SHORT SİNYAL ============
    if (!signal &&
        lastClose < lastOpen && // Kırmızı mum
        lastClose < prevClose && // Düşüş
        lastClose < emaFast && // EMA9 altı
        emaFast < emaSlow && // EMA9 EMA21 altı (düşüş trendi)
        rsi < CFG.RSI_OVERBOUGHT && rsi > 35 && // RSI ne aşırı alım ne aşırı satım
        lastHigh < n(prev[2])) { // Alçalan tepe
        
        const entry = lastClose;
        const stop = lastHigh + (atr * CFG.SL_ATR_MULT);
        const tp1 = entry - (atr * CFG.TP1_ATR_MULT);
        const tp2 = entry - (atr * CFG.TP2_ATR_MULT);
        
        const risk = stop - entry;
        const reward1 = entry - tp1;
        const reward2 = entry - tp2;
        
        if (risk > 0 && reward1 / risk >= 1.5) {
            signal = {
                direction: 'SHORT',
                entry,
                stop,
                tp1,
                tp2,
                rsi: n(rsi, 1),
                volumeSurge: n(volumeSurge, 1),
                movePercent: n(movePercent, 2),
                bodyRatio: n(bodyRatio, 2),
                atr: n(atr),
                risk: n(risk),
                rr1: n(reward1 / risk, 1),
                rr2: n(reward2 / risk, 1),
                score: Math.min(95, 50 + volumeSurge * 10 + bodyRatio * 20 + (rsi > 40 && rsi < 60 ? 10 : 0))
            };
        }
    }
    
    return signal;
}

// ========================= ANA TARAMA =========================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    STATE.stats.scanned = 0;
    STATE.stats.analyzed = 0;
    
    try {
        const coins = await getTopCoins();
        STATE.stats.scanned = coins.length;
        
        const deepCoins = coins.slice(0, CFG.DEEP_LIMIT);
        
        for (const row of deepCoins) {
            // Cooldown kontrolü
            const cooldownTime = STATE.cooldowns.get(row.cleanSymbol);
            if (cooldownTime && Date.now() - cooldownTime < CFG.SIGNAL_COOLDOWN_MS) continue;
            
            // Aktif sinyal kontrolü
            const existing = [...STATE.signals.values()].find(s => s.symbol === row.cleanSymbol);
            if (existing) continue;
            
            const candles = await getCandles(row.symbol, CFG.TIMEFRAME, CFG.CANDLE_LIMIT);
            if (candles.length < 50) continue;
            
            STATE.stats.analyzed++;
            
            const sig = detectSignal(candles, row);
            
            if (sig && sig.score >= 60 && STATE.signals.size < CFG.MAX_ACTIVE_SIGNALS) {
                const now = Date.now();
                const signalObj = {
                    id: `${row.cleanSymbol}-${sig.direction}-${now}`,
                    symbol: row.cleanSymbol,
                    marketSymbol: row.symbol,
                    direction: sig.direction,
                    entry: sig.entry,
                    entryPrice: fmtPrice(sig.entry),
                    stop: sig.stop,
                    stopPrice: fmtPrice(sig.stop),
                    tp1: sig.tp1,
                    tp1Price: fmtPrice(sig.tp1),
                    tp2: sig.tp2,
                    tp2Price: fmtPrice(sig.tp2),
                    rsi: sig.rsi,
                    volumeSurge: sig.volumeSurge,
                    movePercent: sig.movePercent,
                    bodyRatio: sig.bodyRatio,
                    atr: sig.atr,
                    risk: sig.risk,
                    rr1: sig.rr1,
                    rr2: sig.rr2,
                    score: Math.round(sig.score),
                    currentPrice: row.price,
                    volumeFormatted: row.volumeFormatted,
                    change24h: row.change,
                    timestamp: now,
                    signalAt: now,
                    time: new Date().toLocaleTimeString('tr-TR'),
                    ageDisplay: '0 sn önce',
                    remainingDisplay: '10:00 kaldı',
                    status: 'AKTİF'
                };
                
                STATE.signals.set(signalObj.id, signalObj);
                
                if (sig.direction === 'LONG') STATE.stats.longSignals++;
                else STATE.stats.shortSignals++;
                
                console.log(`✅ ${row.cleanSymbol} ${sig.direction} | Skor: ${signalObj.score} | Giriş: ${signalObj.entryPrice} | SL: ${signalObj.stopPrice} | TP1: ${signalObj.tp1Price} | TP2: ${signalObj.tp2Price} | Saat: ${signalObj.time}`);
            }
            
            await sleep(50);
        }
        
        // Eski sinyalleri temizle
        const now = Date.now();
        for (const [id, signal] of STATE.signals) {
            const age = now - signal.timestamp;
            if (age > CFG.SIGNAL_TTL_MS) {
                STATE.signals.delete(id);
                STATE.cooldowns.set(signal.symbol, now);
                STATE.performance.timeouts++;
                console.log(`⏰ ${signal.symbol} TIMEOUT - 10 dakika doldu`);
            }
        }
        
        STATE.lastScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        
        // Performans güncelle
        const total = STATE.performance.wins + STATE.performance.losses;
        STATE.performance.winRate = total ? (STATE.performance.wins / total) * 100 : 0;
        
        broadcast();
        
    } catch (e) {
        STATE.lastError = e.message;
        console.error('SCAN ERROR:', e.message);
    } finally {
        STATE.scanning = false;
    }
}

// ========================= CANLI FİYAT TAKİBİ =========================
async function updateLivePrices() {
    if (!STATE.signals.size) return;
    
    try {
        const tickers = await exchange.fetchTickers();
        
        const now = Date.now();
        
        for (const [id, signal] of STATE.signals) {
            const age = now - signal.timestamp;
            
            // TTL kontrolü
            if (age > CFG.SIGNAL_TTL_MS) {
                STATE.signals.delete(id);
                STATE.cooldowns.set(signal.symbol, now);
                STATE.performance.timeouts++;
                continue;
            }
            
            // Yaş güncelle
            const ageMinutes = Math.floor(age / 60000);
            const ageSeconds = Math.floor((age % 60000) / 1000);
            signal.ageDisplay = ageMinutes > 0 ? `${ageMinutes} dk ${ageSeconds} sn önce` : `${ageSeconds} sn önce`;
            
            // Kalan süre
            const remainingMs = CFG.SIGNAL_TTL_MS - age;
            const remMinutes = Math.floor(remainingMs / 60000);
            const remSeconds = Math.floor((remainingMs % 60000) / 1000);
            signal.remainingDisplay = `${remMinutes}:${remSeconds < 10 ? '0' : ''}${remSeconds} kaldı`;
            
            // Fiyat güncelle
            const ticker = tickers[signal.marketSymbol];
            if (ticker) {
                const current = n(ticker.last);
                signal.currentPrice = current;
                
                const entry = signal.entry;
                const risk = signal.risk;
                
                if (signal.direction === 'LONG') {
                    if (current <= signal.stop) {
                        signal.status = 'STOP';
                        signal.statusClass = 'status-stop';
                    } else if (current >= signal.tp2) {
                        signal.status = 'TP2 ✓';
                        signal.statusClass = 'status-tp';
                    } else if (current >= signal.tp1) {
                        signal.status = 'TP1 ✓';
                        signal.statusClass = 'status-tp';
                    } else if (current > entry) {
                        const profit = ((current - entry) / risk);
                        signal.status = 'KARDA +' + profit.toFixed(2) + 'R';
                        signal.statusClass = 'status-profit';
                    } else {
                        const loss = ((entry - current) / risk);
                        signal.status = 'TERS -' + loss.toFixed(2) + 'R';
                        signal.statusClass = 'status-loss';
                    }
                } else {
                    if (current >= signal.stop) {
                        signal.status = 'STOP';
                        signal.statusClass = 'status-stop';
                    } else if (current <= signal.tp2) {
                        signal.status = 'TP2 ✓';
                        signal.statusClass = 'status-tp';
                    } else if (current <= signal.tp1) {
                        signal.status = 'TP1 ✓';
                        signal.statusClass = 'status-tp';
                    } else if (current < entry) {
                        const profit = ((entry - current) / risk);
                        signal.status = 'KARDA +' + profit.toFixed(2) + 'R';
                        signal.statusClass = 'status-profit';
                    } else {
                        const loss = ((current - entry) / risk);
                        signal.status = 'TERS -' + loss.toFixed(2) + 'R';
                        signal.statusClass = 'status-loss';
                    }
                }
            }
        }
        
        STATE.stats.signals = STATE.signals.size;
        broadcast();
        
    } catch (e) {
        // Sessiz hata
    }
}

// ========================= WEBSOCKET =========================
function broadcast() {
    const payload = JSON.stringify({
        type: 'snapshot',
        data: {
            signals: [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp),
            stats: STATE.stats,
            performance: STATE.performance,
            lastScan: STATE.lastScan,
            error: STATE.lastError
        }
    });
    
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload); } catch (e) {}
        }
    }
}

wss.on('connection', ws => {
    try {
        ws.send(JSON.stringify({
            type: 'snapshot',
            data: {
                signals: [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp),
                stats: STATE.stats,
                performance: STATE.performance,
                lastScan: STATE.lastScan,
                error: STATE.lastError
            }
        }));
    } catch (e) {}
});

// ========================= API =========================
app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        signals: [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp),
        stats: STATE.stats,
        performance: STATE.performance,
        lastScan: STATE.lastScan,
        error: STATE.lastError
    });
});

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡ SONNY 15M SCALPING</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.header{background:#0b111b;border-bottom:1px solid #1a2533;padding:15px 20px;display:flex;justify-content:space-between;align-items:center;}
.brand{font-size:22px;font-weight:900;color:#13dba0;}
.brand-sub{font-size:10px;color:#718096;}
.stats{display:flex;gap:20px;}
.stat{text-align:center;}
.stat b{display:block;font-size:24px;color:#13dba0;font-weight:900;}
.stat span{color:#64748b;font-size:9px;text-transform:uppercase;}
.content{display:grid;grid-template-columns:1fr;gap:15px;padding:20px;height:calc(100vh - 80px);overflow-y:auto;}
.signal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:12px;}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:12px;padding:16px;position:relative;transition:all 0.3s;}
.signal-card.long{border-left:4px solid #13dba0;}
.signal-card.short{border-left:4px solid #ff5570;}
.signal-card:hover{border-color:#13dba0;transform:translateY(-2px);box-shadow:0 4px 20px rgba(19,219,160,0.1);}
.signal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.signal-coin{font-size:16px;font-weight:900;color:#e2e8f0;}
.signal-badge{font-size:10px;padding:4px 12px;border-radius:20px;font-weight:900;letter-spacing:0.5px;}
.badge-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.badge-short{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.signal-time{font-size:9px;color:#94a3b8;margin-bottom:8px;}
.signal-time .age{color:#fbbf24;font-weight:bold;}
.signal-time .remaining{color:#60a5fa;font-weight:bold;}
.signal-price{font-size:22px;font-weight:900;margin:8px 0;color:#f1f5f9;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;}
.level{background:#0b111b;border:1px solid #1b2938;border-radius:6px;padding:8px;}
.level span{display:block;color:#64748b;font-size:8px;margin-bottom:2px;text-transform:uppercase;}
.level b{font-size:13px;font-weight:bold;}
.level.entry b{color:#13dba0;}
.level.stop b{color:#ff5570;}
.level.tp b{color:#55a7ff;}
.signal-stats{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;}
.signal-stat{background:#0b111b;border-radius:5px;padding:5px 10px;font-size:9px;color:#94a3b8;}
.signal-stat b{color:#e2e8f0;}
.signal-status{margin-top:10px;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:bold;text-align:center;}
.status-aktif{background:#1e293b;color:#94a3b8;}
.status-profit{background:#0d3d2a;color:#13dba0;}
.status-loss{background:#3d2d1d;color:#fb923c;}
.status-stop{background:#421d28;color:#ff5570;}
.status-tp{background:#0d3d3d;color:#22d3ee;}
.empty{text-align:center;color:#64748b;font-size:14px;padding:50px;}
.perf-bar{background:#0b111b;border:1px solid #1a2533;border-radius:10px;padding:15px;margin-bottom:15px;}
.perf-bar h3{color:#13dba0;font-size:14px;margin-bottom:10px;}
.perf-stats{display:flex;gap:15px;flex-wrap:wrap;}
.perf-stat{background:#101826;border:1px solid #1c2938;border-radius:8px;padding:10px 15px;text-align:center;}
.perf-stat b{display:block;font-size:20px;color:#13dba0;}
.perf-stat span{color:#64748b;font-size:9px;}
@media(max-width:600px){.signal-grid{grid-template-columns:1fr;}.stats{display:none;}}
</style>
</head>
<body>
<div class="header">
<div>
<div class="brand">⚡ SONNY 15M SCALPING</div>
<div class="brand-sub">Hızlı LONG/SHORT Sinyalleri • 10 Dakika Geçerli</div>
</div>
<div class="stats">
<div class="stat"><b id="st-scanned">0</b><span>Taranan</span></div>
<div class="stat"><b id="st-analyzed">0</b><span>Analiz</span></div>
<div class="stat"><b id="st-signals">0</b><span>Aktif Sinyal</span></div>
<div class="stat"><b id="st-winrate">%0</b><span>Başarı</span></div>
</div>
</div>
<div class="content">
<div class="perf-bar">
<h3>📊 Performans</h3>
<div class="perf-stats">
<div class="perf-stat"><b id="pf-wins">0</b><span>Kazanç</span></div>
<div class="perf-stat"><b id="pf-losses">0</b><span>Kayıp</span></div>
<div class="perf-stat"><b id="pf-timeouts">0</b><span>Timeout</span></div>
<div class="perf-stat"><b id="pf-totalr">0R</b><span>Toplam R</span></div>
</div>
</div>
<div class="signal-grid" id="signals">
<div class="empty">⏳ Sinyal aranıyor...</div>
</div>
</div>
<script>
var _signals = [];

function fmtPrice(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); if(x>=0.01) return x.toFixed(7); return x.toFixed(8); }

function render(data){
    var st = data.stats || {};
    document.getElementById('st-scanned').textContent = st.scanned || 0;
    document.getElementById('st-analyzed').textContent = st.analyzed || 0;
    document.getElementById('st-signals').textContent = st.signals || 0;
    
    var perf = data.performance || {};
    document.getElementById('pf-wins').textContent = perf.wins || 0;
    document.getElementById('pf-losses').textContent = perf.losses || 0;
    document.getElementById('pf-timeouts').textContent = perf.timeouts || 0;
    document.getElementById('pf-totalr').textContent = (perf.totalR || 0).toFixed(1) + 'R';
    document.getElementById('st-winrate').textContent = '%' + (perf.winRate || 0).toFixed(0);
    
    _signals = data.signals || [];
    var container = document.getElementById('signals');
    
    if(!_signals.length){
        container.innerHTML = '<div class="empty">⏳ Aktif sinyal yok. Sistem 30 saniyede bir tarıyor...</div>';
        return;
    }
    
    container.innerHTML = _signals.map(function(s){
        var isLong = s.direction === 'LONG';
        var badgeClass = isLong ? 'badge-long' : 'badge-short';
        var statusClass = s.statusClass || 'status-aktif';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + '">' +
            '<div class="signal-head">' +
                '<div class="signal-coin">' + s.symbol + '</div>' +
                '<div class="signal-badge ' + badgeClass + '">' + s.direction + '</div>' +
            '</div>' +
            '<div class="signal-time">' +
                '🕐 <b>' + s.time + '</b> • ' +
                '<span class="age">⏰ ' + s.ageDisplay + '</span> • ' +
                '<span class="remaining">⏳ ' + s.remainingDisplay + '</span>' +
            '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice || s.entry) + '</div>' +
            '<div class="levels">' +
                '<div class="level entry"><span>GİRİŞ</span><b>' + s.entryPrice + '</b></div>' +
                '<div class="level stop"><span>STOP</span><b>' + s.stopPrice + '</b></div>' +
                '<div class="level tp"><span>TP1</span><b>' + s.tp1Price + '</b></div>' +
                '<div class="level tp"><span>TP2</span><b>' + s.tp2Price + '</b></div>' +
            '</div>' +
            '<div class="signal-stats">' +
                '<div class="signal-stat">RSI: <b>' + s.rsi + '</b></div>' +
                '<div class="signal-stat">Hacim: <b>' + s.volumeSurge + 'x</b></div>' +
                '<div class="signal-stat">Hareket: <b>%' + s.movePercent + '</b></div>' +
                '<div class="signal-stat">R/R: <b>' + s.rr1 + '/' + s.rr2 + '</b></div>' +
                '<div class="signal-stat">Skor: <b>' + s.score + '/100</b></div>' +
            '</div>' +
            '<div class="signal-status ' + statusClass + '">' + (s.status || 'AKTİF') + '</div>' +
        '</div>';
    }).join('');
}

function connect(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host);
    ws.onmessage = function(e){
        try {
            var msg = JSON.parse(e.data);
            if(msg.type === 'snapshot') render(msg.data);
        } catch(_) {}
    };
    ws.onclose = function(){ setTimeout(connect, 3000); };
}
connect();

setInterval(function(){
    fetch('/api/status', {cache:'no-store'})
        .then(function(r){ return r.json(); })
        .then(render)
        .catch(function(){});
}, 5000);

fetch('/api/status', {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(render)
    .catch(function(){});
</script>
</body>
</html>`;

// ========================= SERVER START =========================
app.get('/', (req, res) => res.type('html').send(HTML));

process.on('unhandledRejection', e => { console.error('UNHANDLED', e); });
process.on('uncaughtException', e => { console.error('UNCAUGHT', e); });

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('⚡ SONNY 15M SCALPING SİSTEMİ');
    console.log('📊 15 Dakikalık Hızlı Sinyaller');
    console.log('⏰ Sinyal TTL: 10 dakika');
    console.log('🔄 Tarama: 30 saniyede bir');
    console.log('==============================================');
    
    try {
        await exchange.loadMarkets(true);
        console.log('MARKETS | ' + Object.keys(exchange.markets).length);
    } catch (e) {
        console.error('MARKET ERROR:', e.message);
    }
    
    setTimeout(() => { runScan().catch(e => console.error('SCAN:', e.message)); }, 2000);
    setInterval(() => { if (!STATE.scanning) runScan().catch(e => console.error('SCAN:', e.message)); }, CFG.SCAN_INTERVAL_MS);
    setInterval(() => updateLivePrices().catch(e => {}), 3000);
});
