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

// ============================================================
// FLOW IGNITION V1 - GRAFİKLİ SİSTEM
// ============================================================
const CFG = {
    SCAN_INTERVAL_MS: 45 * 1000,
    SIGNAL_UPDATE_MS: 2000,
    SIGNAL_TTL_MS: 15 * 60 * 1000,
    FRESH_AGE_MS: 5 * 60 * 1000,
    FRESH_DISTANCE_PCT: 0.2,
    VALID_DISTANCE_PCT: 0.5,
    
    MIN_VOLUME_USDT: 500000,
    MIN_PRICE: 0.0001,
    MIN_CHANGE_PCT: 1.0,
    MAX_CANDIDATES: 200,
    
    OI_CHANGE_THRESHOLD_PCT: 0.3,
    OI_QUERY_DELAY_MS: 25,
    
    MIN_VOLUME_SURGE: 1.5,
    MIN_SIGNAL_SCORE: 60,
    SL_ATR_MULT: 1.5,
    TP1_ATR_MULT: 2.5,
    TP2_ATR_MULT: 4.0,
    
    MAX_ACTIVE_SIGNALS: 15,
    CANDLE_LIMIT: 80,
    CHART_LIMIT: 100
};

let previousOI = {};
let currentOI = {};
let activeSignals = [];
let isScanning = false;

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

// ============================================================
// YARDIMCI FONKSİYONLAR
// ============================================================
function n(v, d = 6) { const x = Number(v); return Number.isFinite(x) ? Number(x.toFixed(d)) : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPrice(v) { 
    const x = Number(v); 
    if (!Number.isFinite(x)) return '-'; 
    if (x >= 1000) return x.toFixed(2); 
    if (x >= 100) return x.toFixed(3); 
    if (x >= 1) return x.toFixed(5); 
    if (x >= 0.01) return x.toFixed(7); 
    return x.toFixed(8); 
}

function formatVolume(v) { 
    if (v >= 1e9) return (v/1e9).toFixed(2)+'B'; 
    if (v >= 1e6) return (v/1e6).toFixed(1)+'M'; 
    if (v >= 1e3) return (v/1e3).toFixed(1)+'K'; 
    return v.toFixed(0); 
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    let trValues = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][2];
        const low = candles[i][3];
        const prevClose = candles[i-1][4];
        const tr = Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
        trValues.push(tr);
    }
    const recentTR = trValues.slice(-period);
    return recentTR.reduce((s, v) => s+v, 0) / period;
}

function calculateAvgVolume(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const recentCandles = candles.slice(-(period+1), -1);
    return recentCandles.reduce((s, c) => s + c[5], 0) / period;
}

// ============================================================
// OI VERİSİ
// ============================================================
async function getOI(symbol) {
    try {
        const oi = await exchange.fetchOpenInterest(symbol);
        if (oi) {
            if (typeof oi === 'object') {
                const val = parseFloat(oi.openInterestAmount || oi.openInterest || oi.amount || 0);
                if (val > 0) return val;
            } else if (typeof oi === 'number' && oi > 0) {
                return oi;
            }
        }
    } catch (e) {}
    
    try {
        const cleanSym = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${cleanSym}&productType=usdt-futures`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (response.ok) {
            const data = await response.json();
            if (data && data.code === '00000' && data.data) {
                const val = parseFloat(data.data.amount || data.data.openInterest || 0);
                if (val > 0) return val;
            }
        }
    } catch (e) {}
    
    return 0;
}

// ============================================================
// CANDLE VERİLERİ
// ============================================================
async function getCandles(symbol, timeframe, limit) {
    try {
        const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a,b) => a[0]-b[0]) : [];
    } catch (e) {
        return [];
    }
}

// ============================================================
// AŞAMA 1: ÖN TARAMA
// ============================================================
async function preScan() {
    console.log('📡 AŞAMA 1: Ön Tarama...');
    try {
        const tickers = await exchange.fetchTickers();
        const candidates = [];
        
        for (const [symbol, ticker] of Object.entries(tickers)) {
            try {
                if (!symbol.endsWith(':USDT')) continue;
                const volume = n(ticker.quoteVolume);
                const price = n(ticker.last);
                const change = n(ticker.percentage);
                
                if (volume < CFG.MIN_VOLUME_USDT) continue;
                if (price < CFG.MIN_PRICE) continue;
                if (Math.abs(change) < CFG.MIN_CHANGE_PCT) continue;
                
                candidates.push({ symbol, volume, price, change, volumeFormatted: formatVolume(volume) });
            } catch (e) { continue; }
        }
        
        candidates.sort((a, b) => b.volume - a.volume);
        console.log(`✅ Aday: ${candidates.length}`);
        return candidates.slice(0, CFG.MAX_CANDIDATES);
    } catch (e) {
        console.error('Ön tarama hatası:', e.message);
        return [];
    }
}

// ============================================================
// AŞAMA 2: OI TARAMASI
// ============================================================
async function scanOI(candidates) {
    console.log('📡 AŞAMA 2: OI Taraması...');
    const oiAnomalies = [];
    currentOI = {};
    let oiSuccessCount = 0;
    
    for (const candidate of candidates) {
        try {
            const oi = await getOI(candidate.symbol);
            const cleanSym = candidate.symbol.replace(':USDT', '');
            
            if (oi > 0) {
                oiSuccessCount++;
                currentOI[cleanSym] = oi;
                
                const prevOi = previousOI[cleanSym];
                if (prevOi > 0) {
                    const oiChangePct = ((oi - prevOi) / prevOi) * 100;
                    if (Math.abs(oiChangePct) >= CFG.OI_CHANGE_THRESHOLD_PCT) {
                        candidate.oi = oi;
                        candidate.oiChangePct = oiChangePct;
                        oiAnomalies.push(candidate);
                    }
                }
            }
            await sleep(CFG.OI_QUERY_DELAY_MS);
        } catch (e) { continue; }
    }
    
    console.log(`✅ OI: ${oiSuccessCount}/${candidates.length} | Anomali: ${oiAnomalies.length}`);
    return oiAnomalies;
}

// ============================================================
// AŞAMA 3: DERİN ANALİZ
// ============================================================
async function deepAnalysis(oiAnomalies) {
    console.log('📡 AŞAMA 3: Derin Analiz...');
    let signalCount = 0;
    
    for (const candidate of oiAnomalies) {
        try {
            const existing = activeSignals.find(s => s.symbol === candidate.symbol);
            if (existing) continue;
            if (activeSignals.length >= CFG.MAX_ACTIVE_SIGNALS) break;
            
            const candles = await getCandles(candidate.symbol, '15m', CFG.CANDLE_LIMIT);
            if (candles.length < 20) continue;
            
            const currentCandle = candles[candles.length - 1];
            const open = currentCandle[1];
            const close = currentCandle[4];
            const volume = currentCandle[5];
            const high = currentCandle[2];
            const low = currentCandle[3];
            
            const atr = calculateATR(candles);
            const avgVolume = calculateAvgVolume(candles);
            if (!atr || !avgVolume) continue;
            
            const volumeSurge = volume / avgVolume;
            const candleSize = Math.abs(close - open);
            const isCompression = candleSize < (atr * 1.0);
            const isPriceUp = close > open;
            
            let signalType = null;
            let scenario = "";
            let score = 0;
            
            if (isPriceUp && candidate.oiChangePct < 0) {
                signalType = "LONG"; scenario = "SHORT SQUEEZE";
                score = 50 + Math.abs(candidate.oiChangePct) * 10 + volumeSurge * 5;
            } else if (isPriceUp && candidate.oiChangePct > 0) {
                signalType = "LONG"; scenario = "EXPANSION LONG";
                score = 45 + candidate.oiChangePct * 10 + volumeSurge * 5;
            } else if (!isPriceUp && candidate.oiChangePct < 0) {
                signalType = "SHORT"; scenario = "LONG SQUEEZE";
                score = 50 + Math.abs(candidate.oiChangePct) * 10 + volumeSurge * 5;
            } else if (!isPriceUp && candidate.oiChangePct > 0) {
                signalType = "SHORT"; scenario = "EXPANSION SHORT";
                score = 45 + Math.abs(candidate.oiChangePct) * 10 + volumeSurge * 5;
            }
            
            if (isCompression) score += 10;
            
            if (signalType && volumeSurge >= CFG.MIN_VOLUME_SURGE && score >= CFG.MIN_SIGNAL_SCORE) {
                const stop = signalType === 'LONG' ? low - (atr * CFG.SL_ATR_MULT) : high + (atr * CFG.SL_ATR_MULT);
                const risk = Math.abs(close - stop);
                const tp1 = signalType === 'LONG' ? close + (risk * CFG.TP1_ATR_MULT) : close - (risk * CFG.TP1_ATR_MULT);
                const tp2 = signalType === 'LONG' ? close + (risk * CFG.TP2_ATR_MULT) : close - (risk * CFG.TP2_ATR_MULT);
                
                // Güç seviyesi belirle
                let strength = 'NORMAL';
                let strengthClass = 'strength-normal';
                let strengthLabel = '⚡ NORMAL';
                
                if (score >= 100) {
                    strength = 'ULTRA';
                    strengthClass = 'strength-ultra';
                    strengthLabel = '🔥🔥 ULTRA GÜÇLÜ';
                } else if (score >= 80) {
                    strength = 'HIGH';
                    strengthClass = 'strength-high';
                    strengthLabel = '🔥 GÜÇLÜ';
                } else if (score >= 70) {
                    strength = 'GOOD';
                    strengthClass = 'strength-good';
                    strengthLabel = '💪 İYİ';
                }
                
                activeSignals.unshift({
                    id: Math.random().toString(36).substr(2, 9),
                    symbol: candidate.symbol,
                    type: signalType,
                    scenario: scenario,
                    entryPrice: close,
                    entryPriceFormatted: fmtPrice(close),
                    stop: stop,
                    stopFormatted: fmtPrice(stop),
                    tp1: tp1,
                    tp1Formatted: fmtPrice(tp1),
                    tp2: tp2,
                    tp2Formatted: fmtPrice(tp2),
                    currentPrice: close,
                    maxPrice: close,
                    minPrice: close,
                    timestamp: Date.now(),
                    time: new Date().toLocaleTimeString('tr-TR'),
                    oiChangePct: candidate.oiChangePct.toFixed(2),
                    volumeSurgeRatio: volumeSurge.toFixed(2),
                    score: Math.round(score),
                    strength: strength,
                    strengthClass: strengthClass,
                    strengthLabel: strengthLabel,
                    isCompression: isCompression,
                    status: 'GİRİLEBİLİR',
                    statusClass: 'status-fresh',
                    cardState: 'FRESH',
                    distancePct: "0.000",
                    ageMin: "0.00",
                    mfe: 0,
                    mae: 0
                });
                
                signalCount++;
                console.log(`🚀 ${candidate.symbol} ${signalType} | ${scenario} | OI: %${candidate.oiChangePct.toFixed(2)} | Hacim: ${volumeSurge.toFixed(1)}x | Skor: ${Math.round(score)} | ${strengthLabel}`);
            }
            await sleep(20);
        } catch (e) { continue; }
    }
    
    console.log(`✅ Sinyal: ${signalCount}`);
}

// ============================================================
// SİNYAL YAŞAM DÖNGÜSÜ
// ============================================================
async function updateSignalLifecycle() {
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        
        activeSignals = activeSignals.filter(signal => {
            const age = now - signal.timestamp;
            if (age > CFG.SIGNAL_TTL_MS) return false;
            
            const ticker = tickers[signal.symbol];
            if (!ticker) return true;
            
            const currentPrice = n(ticker.last);
            const ageMin = age / 60000;
            const distancePct = Math.abs(currentPrice - signal.entryPrice) / signal.entryPrice * 100;
            
            // Durum: Sadece 2 durum - GİRİLEBİLİR veya GEÇTİ
            let status = 'GEÇTİ';
            let statusClass = 'status-missed';
            let cardState = 'MISSED';
            
            if (ageMin <= 10 && distancePct <= 0.5) {
                status = 'GİRİLEBİLİR';
                statusClass = 'status-fresh';
                cardState = 'FRESH';
            }
            
            // TP/SL kontrolü
            if (signal.type === 'LONG') {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                
                if (signal.tp1 && currentPrice >= signal.tp1) {
                    status = 'TP1 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice >= signal.tp2) {
                    status = 'TP2 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.stop && currentPrice <= signal.stop) {
                    status = 'STOP';
                    statusClass = 'status-stop';
                    cardState = 'CLOSED';
                }
            } else {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                
                if (signal.tp1 && currentPrice <= signal.tp1) {
                    status = 'TP1 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice <= signal.tp2) {
                    status = 'TP2 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.stop && currentPrice >= signal.stop) {
                    status = 'STOP';
                    statusClass = 'status-stop';
                    cardState = 'CLOSED';
                }
            }
            
            signal.currentPrice = currentPrice;
            signal.ageMin = ageMin.toFixed(1);
            signal.distancePct = distancePct.toFixed(3);
            signal.status = status;
            signal.statusClass = statusClass;
            signal.cardState = cardState;
            
            return true;
        });
    } catch (e) {}
}

// ============================================================
// ANA TARAMA
// ============================================================
async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    
    console.log(`\n📡 [${new Date().toLocaleTimeString()}] Tarama Başladı...`);
    
    try {
        await updateSignalLifecycle();
        const candidates = await preScan();
        
        if (candidates.length > 0) {
            const oiAnomalies = await scanOI(candidates);
            if (oiAnomalies.length > 0) {
                await deepAnalysis(oiAnomalies);
            }
        }
        
        previousOI = { ...currentOI };
    } catch (e) {
        console.error('🔴 Tarama Hatası:', e.message);
    } finally {
        isScanning = false;
        broadcast();
    }
}

// ============================================================
// WEBSOCKET
// ============================================================
function broadcast() {
    try {
        const payload = JSON.stringify({
            type: 'snapshot',
            data: {
                signals: activeSignals,
                stats: {
                    total: activeSignals.length,
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length
                }
            }
        });
        
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(payload); } catch (e) {}
            }
        }
    } catch (e) {}
}

wss.on('connection', ws => {
    try {
        ws.send(JSON.stringify({
            type: 'snapshot',
            data: {
                signals: activeSignals,
                stats: {
                    total: activeSignals.length,
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length
                }
            }
        }));
    } catch (e) {}
});

// ============================================================
// API
// ============================================================
app.get('/api/signals', (req, res) => {
    res.json({ success: true, count: activeSignals.length, signals: activeSignals });
});

app.get('/api/chart', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '15m';
        const candles = await getCandles(symbol, timeframe, CFG.CHART_LIMIT);
        const signal = activeSignals.find(s => s.symbol === symbol) || null;
        res.json({ success: true, symbol, timeframe, candles, signal });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================================
// FRONTEND - GRAFİKLİ
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔥 FLOW IGNITION V1</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.app{display:grid;grid-template-columns:350px 1fr;height:100vh;}
@media(max-width:800px){.app{grid-template-columns:1fr;}.signal-panel{display:none;}}

/* SOL PANEL - SİNYALLER */
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh;}
.panel-header{padding:15px;border-bottom:1px solid #1a2533;}
.panel-title{font-size:18px;font-weight:900;color:#13dba0;}
.panel-sub{font-size:9px;color:#718096;margin-top:2px;}
.panel-stats{display:flex;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533;}
.panel-stat{flex:1;text-align:center;background:#101826;border-radius:6px;padding:6px;}
.panel-stat b{display:block;font-size:18px;color:#13dba0;}
.panel-stat span{font-size:8px;color:#64748b;}
.signal-list{flex:1;overflow-y:auto;padding:10px;}

/* SİNYAL KARTI */
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;transition:all 0.2s;}
.signal-card:hover{border-color:#13dba0;}
.signal-card.selected{border:2px solid #13dba0;background:#0d1a15;}
.signal-card.long{border-left:4px solid #13dba0;}
.signal-card.short{border-left:4px solid #ff5570;}
.signal-card.fresh{box-shadow:0 0 15px rgba(19,219,160,0.1);}
.signal-card.missed{opacity:0.35;filter:grayscale(60%);}
.signal-card.closed{opacity:0.5;}

.signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
.signal-coin{font-size:15px;font-weight:900;color:#e2e8f0;}
.signal-badge{font-size:9px;padding:3px 10px;border-radius:15px;font-weight:900;}
.badge-long{background:#0d3d2a;color:#13dba0;}
.badge-short{background:#421d28;color:#ff5570;}

/* GÜÇ ETİKETİ */
.strength-badge{display:inline-block;font-size:8px;padding:2px 8px;border-radius:4px;margin-top:4px;font-weight:bold;}
.strength-ultra{background:#1a0d3d;color:#a78bfa;border:1px solid #a78bfa;animation:pulse 1s infinite;}
.strength-high{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.strength-good{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee;}
.strength-normal{background:#1e293b;color:#94a3b8;border:1px solid #64748b;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}

.signal-price{font-size:18px;font-weight:900;margin:5px 0;color:#f1f5f9;}
.signal-info{display:flex;gap:8px;font-size:9px;color:#94a3b8;margin-top:5px;flex-wrap:wrap;}
.signal-status{margin-top:8px;padding:5px;border-radius:5px;font-size:10px;font-weight:bold;text-align:center;}
.status-fresh{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.status-missed{background:#2d1d1d;color:#ff5570;border:1px solid #ff5570;}
.status-stop{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.status-tp{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee;}

/* SAĞ PANEL - GRAFİK */
.chart-panel{background:#0b111b;display:flex;flex-direction:column;padding:15px;min-width:0;}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;}
.chart-title{font-size:16px;font-weight:900;color:#13dba0;}
.tf-buttons{display:flex;gap:5px;}
.tf-btn{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 10px;font-size:9px;cursor:pointer;}
.tf-btn.active{color:#13dba0;border-color:#13dba0;}
.chart-container{flex:1;min-height:0;position:relative;}
canvas{width:100%;height:100%;display:block;}
.empty{text-align:center;color:#64748b;font-size:14px;padding:40px;}
</style>
</head>
<body>
<div class="app">
    <!-- SOL PANEL -->
    <div class="signal-panel">
        <div class="panel-header">
            <div class="panel-title">🔥 FLOW IGNITION</div>
            <div class="panel-sub">OI + Hacim + Sıkışma</div>
        </div>
        <div class="panel-stats">
            <div class="panel-stat"><b id="st-total">0</b><span>Sinyal</span></div>
            <div class="panel-stat"><b id="st-fresh">0</b><span>Girilebilir</span></div>
        </div>
        <div class="signal-list" id="signals">
            <div class="empty">⏳ Taranıyor...</div>
        </div>
    </div>
    
    <!-- SAĞ PANEL - GRAFİK -->
    <div class="chart-panel">
        <div class="chart-header">
            <div class="chart-title" id="chartTitle">Grafik için sinyal seçin</div>
            <div class="tf-buttons">
                <button class="tf-btn active" data-tf="15m">15M</button>
                <button class="tf-btn" data-tf="1h">1H</button>
                <button class="tf-btn" data-tf="4h">4H</button>
            </div>
        </div>
        <div class="chart-container">
            <canvas id="chartCanvas"></canvas>
        </div>
    </div>
</div>

<script>
var selectedSymbol = null;
var selectedTf = '15m';
var chartCandles = [];
var currentSignal = null;

function fmtPrice(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); return x.toFixed(8); }

function selectSignal(symbol){
    selectedSymbol = symbol;
    var signal = window._signals.find(function(s){ return s.symbol === symbol; });
    currentSignal = signal || null;
    
    document.querySelectorAll('.signal-card').forEach(function(c){
        c.classList.remove('selected');
        if(c.getAttribute('data-symbol') === symbol) c.classList.add('selected');
    });
    
    document.getElementById('chartTitle').textContent = symbol.replace(':USDT','') + ' • ' + selectedTf.toUpperCase();
    loadChart();
}

function render(data){
    var stats = data.stats || {};
    document.getElementById('st-total').textContent = stats.total || 0;
    document.getElementById('st-fresh').textContent = stats.fresh || 0;
    
    window._signals = data.signals || [];
    var container = document.getElementById('signals');
    
    if(!window._signals.length){
        container.innerHTML = '<div class="empty">⏳ Aktif sinyal yok...</div>';
        return;
    }
    
    container.innerHTML = window._signals.map(function(s){
        var isLong = s.type === 'LONG';
        var cardClass = s.cardState === 'FRESH' ? 'fresh' : s.cardState === 'MISSED' ? 'missed' : 'closed';
        if(selectedSymbol === s.symbol) cardClass += ' selected';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '" data-symbol="' + s.symbol + '" onclick="selectSignal(\'' + s.symbol + '\')">' +
            '<div class="signal-top">' +
                '<div class="signal-coin">' + s.symbol.replace(':USDT','') + '</div>' +
                '<div class="signal-badge ' + (isLong ? 'badge-long' : 'badge-short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
            '</div>' +
            '<div class="strength-badge ' + s.strengthClass + '">' + s.strengthLabel + '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice) + '</div>' +
            '<div class="signal-info">' +
                '<span>OI: %' + s.oiChangePct + '</span>' +
                '<span>Hacim: ' + s.volumeSurgeRatio + 'x</span>' +
                '<span>' + s.ageMin + ' dk</span>' +
                '<span>Skor: ' + s.score + '</span>' +
            '</div>' +
            '<div class="signal-status ' + s.statusClass + '">' + s.status + '</div>' +
        '</div>';
    }).join('');
    
    // Seçili sinyali güncelle
    if(selectedSymbol && currentSignal){
        var updated = window._signals.find(function(s){ return s.symbol === selectedSymbol; });
        if(updated) currentSignal = updated;
    }
}

async function loadChart(){
    if(!selectedSymbol) return;
    
    try {
        var r = await fetch('/api/chart?symbol=' + encodeURIComponent(selectedSymbol) + '&timeframe=' + encodeURIComponent(selectedTf));
        var d = await r.json();
        if(d.success){
            chartCandles = d.candles || [];
            currentSignal = d.signal || currentSignal;
            drawChart();
        }
    } catch(e) {}
}

function drawChart(){
    var canvas = document.getElementById('chartCanvas');
    if(!canvas || !chartCandles.length) return;
    
    var parent = canvas.parentElement;
    var w = Math.max(300, parent.clientWidth);
    var h = Math.max(300, parent.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b11';
    ctx.fillRect(0, 0, w, h);
    
    var visible = chartCandles.slice(-60);
    var minPrice = Math.min.apply(Math, visible.map(function(c){ return c[3]; }));
    var maxPrice = Math.max.apply(Math, visible.map(function(c){ return c[2]; }));
    
    // Sinyal seviyelerini dahil et
    if(currentSignal){
        [currentSignal.entryPrice, currentSignal.stop, currentSignal.tp1, currentSignal.tp2].forEach(function(p){
            if(p < minPrice) minPrice = p;
            if(p > maxPrice) maxPrice = p;
        });
    }
    
    var pad = (maxPrice - minPrice) * 0.08;
    minPrice -= pad;
    maxPrice += pad;
    
    var L = 40, R = 100, T = 15, B = 15;
    var PW = w - L - R;
    var PH = h - T - B;
    
    function Y(price){ return T + (maxPrice - price) / (maxPrice - minPrice) * PH; }
    function X(i){ return L + i * PW / (visible.length - 1); }
    
    // Grid
    ctx.strokeStyle = '#182330';
    for(var g = 0; g <= 4; g++){
        var gy = T + PH * g / 4;
        ctx.beginPath(); ctx.moveTo(L, gy); ctx.lineTo(w - R, gy); ctx.stroke();
        ctx.fillStyle = '#607083'; ctx.font = '8px Arial';
        ctx.fillText(fmtPrice(maxPrice - (maxPrice - minPrice) * g / 4), 3, gy + 3);
    }
    
    // Mumlar
    var step = PW / (visible.length - 1);
    var bw = Math.max(2, Math.min(8, step * 0.6));
    
    visible.forEach(function(candle, i){
        var xx = X(i);
        var up = candle[4] >= candle[1];
        var col = up ? '#13e0a2' : '#ff4d6d';
        
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(xx, Y(candle[2]));
        ctx.lineTo(xx, Y(candle[3]));
        ctx.stroke();
        
        var yo = Y(candle[1]), yc = Y(candle[4]);
        ctx.fillRect(xx - bw/2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    
    // Sinyal seviyeleri
    if(currentSignal){
        drawLevel(ctx, currentSignal.entryPrice, '#13dba0', 'GİRİŞ ' + currentSignal.entryPriceFormatted, L, w-R, Y);
        drawLevel(ctx, currentSignal.stop, '#ff5570', 'STOP ' + currentSignal.stopFormatted, L, w-R, Y);
        drawLevel(ctx, currentSignal.tp1, '#55a7ff', 'TP1 ' + currentSignal.tp1Formatted, L, w-R, Y);
        drawLevel(ctx, currentSignal.tp2, '#55a7ff', 'TP2 ' + currentSignal.tp2Formatted, L, w-R, Y);
    }
}

function drawLevel(ctx, price, color, label, L, R, Y){
    var yy = Y(price);
    ctx.strokeStyle = color;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(L, yy);
    ctx.lineTo(R, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = 'bold 9px Arial';
    ctx.fillText(label, R + 5, yy + 3);
}

document.querySelectorAll('.tf-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
        document.querySelectorAll('.tf-btn').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        selectedTf = btn.getAttribute('data-tf');
        if(selectedSymbol){
            document.getElementById('chartTitle').textContent = selectedSymbol.replace(':USDT','') + ' • ' + selectedTf.toUpperCase();
            loadChart();
        }
    });
});

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
    fetch('/api/signals').then(function(r){ return r.json(); }).then(function(d){
        if(d.success) render({signals: d.signals, stats: {total: d.count, fresh: d.signals.filter(function(s){return s.cardState==='FRESH';}).length}});
    }).catch(function(){});
}, 3000);

window.addEventListener('resize', drawChart);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// BAŞLATMA
// ============================================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🔥 FLOW IGNITION V1 - GRAFİKLİ SİSTEM');
    console.log('📊 OI + Hacim + Sıkışma');
    console.log('==============================================');
    
    try {
        await exchange.loadMarkets();
        console.log('✅ MARKETLER YÜKLENDİ');
        const testOI = await getOI('BTC/USDT:USDT');
        console.log('🧪 BTC OI TEST:', testOI > 0 ? `✅ ${testOI}` : '❌');
    } catch (e) {
        console.error('❌ HATA:', e.message);
    }
    
    runScanner();
    setInterval(runScanner, CFG.SCAN_INTERVAL_MS);
    setInterval(updateSignalLifecycle, CFG.SIGNAL_UPDATE_MS);
});
