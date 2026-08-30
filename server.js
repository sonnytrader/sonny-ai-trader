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
// FLOW IGNITION V3 - DÜZELTİLMİŞ TAM SİSTEM
// ============================================================
const CFG = {
    SCAN_INTERVAL_MS: 30 * 1000,       // 30 saniyede bir
    SIGNAL_UPDATE_MS: 2000,             // 2 saniyede bir
    
    // Sinyal ömrü
    SIGNAL_TTL_MS: 15 * 60 * 1000,      // 15 dakika
    GIRIS_PENCERE_MS: 10 * 60 * 1000,   // 10 dakika giriş penceresi
    MAX_DISTANCE_PCT: 0.5,              // %0.5 sapmaya kadar girilebilir
    
    // Ön tarama
    MIN_VOLUME_USDT: 1000000,
    MIN_PRICE: 0.0001,
    MAX_CANDIDATES: 150,
    
    // OI filtreleri
    MIN_OI_CHANGE_PCT: 0.3,             // OI en az %0.3 değişmeli
    OI_QUERY_DELAY_MS: 20,
    
    // Sinyal filtreleri - DENGELİ
    MIN_VOLUME_SURGE: 1.5,
    MIN_SIGNAL_SCORE: 50,               // 50 üstü sinyal üretir
    
    // TP/SL
    SL_ATR_MULT: 1.2,
    TP1_ATR_MULT: 2.0,
    TP2_ATR_MULT: 3.5,
    
    MAX_ACTIVE_SIGNALS: 12,
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
    return trValues.slice(-period).reduce((s, v) => s+v, 0) / period;
}

function calculateAvgVolume(candles, period = 20) {
    if (candles.length < period + 1) return null;
    return candles.slice(-(period+1), -1).reduce((s, c) => s + c[5], 0) / period;
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
            } else if (typeof oi === 'number' && oi > 0) return oi;
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

async function getCandles(symbol, timeframe, limit) {
    try {
        const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a,b) => a[0]-b[0]) : [];
    } catch (e) {
        return [];
    }
}

// ============================================================
// DENGELİ SKOR HESABI
// ============================================================
function calculateBalancedScore(oiChangePct, volumeSurge) {
    const absOI = Math.abs(oiChangePct);
    
    // OI Skoru (0-100)
    let oiScore = 0;
    if (absOI >= 5) oiScore = 100;
    else if (absOI >= 3) oiScore = 85;
    else if (absOI >= 2) oiScore = 70;
    else if (absOI >= 1) oiScore = 55;
    else if (absOI >= 0.5) oiScore = 40;
    else if (absOI >= 0.3) oiScore = 25;
    else oiScore = 10;
    
    // Hacim Skoru (0-100)
    let volumeScore = 0;
    if (volumeSurge >= 10) volumeScore = 100;
    else if (volumeSurge >= 5) volumeScore = 85;
    else if (volumeSurge >= 3) volumeScore = 70;
    else if (volumeSurge >= 2) volumeScore = 55;
    else if (volumeSurge >= 1.5) volumeScore = 40;
    else volumeScore = 25;
    
    // Dengeli skor (ortalama)
    return Math.round((oiScore + volumeScore) / 2);
}

function getStrengthLabel(score) {
    if (score >= 80) return { label: '🔥🔥 ULTRA GÜÇLÜ', class: 'strength-ultra' };
    if (score >= 65) return { label: '🔥 GÜÇLÜ', class: 'strength-high' };
    if (score >= 50) return { label: '💪 İYİ', class: 'strength-good' };
    return { label: '⚡ NORMAL', class: 'strength-normal' };
}

// ============================================================
// AŞAMA 1: ÖN TARAMA
// ============================================================
async function preScan() {
    try {
        const tickers = await exchange.fetchTickers();
        const candidates = [];
        
        for (const [symbol, ticker] of Object.entries(tickers)) {
            try {
                if (!symbol.endsWith(':USDT')) continue;
                const volume = n(ticker.quoteVolume);
                const price = n(ticker.last);
                
                if (volume < CFG.MIN_VOLUME_USDT) continue;
                if (price < CFG.MIN_PRICE) continue;
                
                candidates.push({ symbol, volume, price });
            } catch (e) { continue; }
        }
        
        candidates.sort((a, b) => b.volume - a.volume);
        return candidates.slice(0, CFG.MAX_CANDIDATES);
    } catch (e) {
        return [];
    }
}

// ============================================================
// AŞAMA 2: OI TARAMASI
// ============================================================
async function scanOI(candidates) {
    const oiAnomalies = [];
    currentOI = {};
    
    for (const candidate of candidates) {
        try {
            const oi = await getOI(candidate.symbol);
            const cleanSym = candidate.symbol.replace(':USDT', '');
            
            if (oi > 0) {
                currentOI[cleanSym] = oi;
                
                const prevOi = previousOI[cleanSym];
                if (prevOi > 0) {
                    const oiChangePct = ((oi - prevOi) / prevOi) * 100;
                    if (Math.abs(oiChangePct) >= CFG.MIN_OI_CHANGE_PCT) {
                        candidate.oi = oi;
                        candidate.oiChangePct = oiChangePct;
                        oiAnomalies.push(candidate);
                    }
                }
            }
            await sleep(CFG.OI_QUERY_DELAY_MS);
        } catch (e) { continue; }
    }
    
    return oiAnomalies;
}

// ============================================================
// AŞAMA 3: ERKEN SİNYAL TESPİTİ
// ============================================================
async function deepAnalysis(oiAnomalies) {
    for (const candidate of oiAnomalies) {
        try {
            // Sadece FRESH durumda aktif sinyal varsa atla
            const existing = activeSignals.find(s => s.symbol === candidate.symbol && s.cardState === 'FRESH');
            if (existing) continue;
            
            if (activeSignals.filter(s => s.cardState === 'FRESH').length >= CFG.MAX_ACTIVE_SIGNALS) break;
            
            const candles = await getCandles(candidate.symbol, '15m', CFG.CANDLE_LIMIT);
            if (candles.length < 30) continue;
            
            // ============================================
            // ERKEN TESPİT: Kapanmamış mumu analiz et
            // ============================================
            const currentCandle = candles[candles.length - 1];
            const open = currentCandle[1];
            const currentPrice = currentCandle[4];
            const volume = currentCandle[5];
            const high = currentCandle[2];
            const low = currentCandle[3];
            
            // Mum ilerlemesi (0-1 arası)
            const candleAge = Date.now() - currentCandle[0];
            const candleProgress = candleAge / (15 * 60 * 1000);
            
            // Mum %20'den az veya %80'den fazla ilerlediyse sinyal verme
            if (candleProgress < 0.15 || candleProgress > 0.75) continue;
            
            const atr = calculateATR(candles);
            const avgVolume = calculateAvgVolume(candles);
            if (!atr || !avgVolume) continue;
            
            const volumeSurge = volume / avgVolume;
            const priceMovePct = ((currentPrice - open) / open) * 100;
            
            // Yön belirle
            const isPriceUp = currentPrice > open;
            
            let signalType = null;
            let scenario = "";
            
            if (isPriceUp && candidate.oiChangePct < 0) {
                signalType = "LONG";
                scenario = "SHORT SQUEEZE";
            } else if (isPriceUp && candidate.oiChangePct > 0) {
                signalType = "LONG";
                scenario = "EXPANSION LONG";
            } else if (!isPriceUp && candidate.oiChangePct < 0) {
                signalType = "SHORT";
                scenario = "LONG SQUEEZE";
            } else if (!isPriceUp && candidate.oiChangePct > 0) {
                signalType = "SHORT";
                scenario = "EXPANSION SHORT";
            }
            
            if (!signalType) continue;
            
            // Dengeli skor hesapla
            const score = calculateBalancedScore(candidate.oiChangePct, volumeSurge);
            
            // Filtreler
            if (score < CFG.MIN_SIGNAL_SCORE) continue;
            if (volumeSurge < CFG.MIN_VOLUME_SURGE) continue;
            if (Math.abs(priceMovePct) < 0.1) continue; // Fiyat hareket etmiyorsa sinyal yok
            
            // TP/SL hesapla
            const stop = signalType === 'LONG' ? low - (atr * CFG.SL_ATR_MULT) : high + (atr * CFG.SL_ATR_MULT);
            const risk = Math.abs(currentPrice - stop);
            const tp1 = signalType === 'LONG' ? currentPrice + (risk * CFG.TP1_ATR_MULT) : currentPrice - (risk * CFG.TP1_ATR_MULT);
            const tp2 = signalType === 'LONG' ? currentPrice + (risk * CFG.TP2_ATR_MULT) : currentPrice - (risk * CFG.TP2_ATR_MULT);
            
            const strength = getStrengthLabel(score);
            
            activeSignals.unshift({
                id: Math.random().toString(36).substr(2, 9),
                symbol: candidate.symbol,
                type: signalType,
                scenario: scenario,
                entryPrice: currentPrice,
                entryPriceFormatted: fmtPrice(currentPrice),
                stop: stop,
                stopFormatted: fmtPrice(stop),
                tp1: tp1,
                tp1Formatted: fmtPrice(tp1),
                tp2: tp2,
                tp2Formatted: fmtPrice(tp2),
                currentPrice: currentPrice,
                maxPrice: currentPrice,
                minPrice: currentPrice,
                timestamp: Date.now(),
                time: new Date().toLocaleTimeString('tr-TR'),
                oiChangePct: candidate.oiChangePct.toFixed(2),
                volumeSurgeRatio: volumeSurge.toFixed(2),
                score: score,
                strength: strength.label,
                strengthClass: strength.class,
                candleProgress: (candleProgress * 100).toFixed(0) + '%',
                status: '✅ GİRİLEBİLİR',
                statusClass: 'status-fresh',
                cardState: 'FRESH',
                distancePct: "0.000",
                ageMin: "0",
                mfe: 0,
                mae: 0,
                atr: atr
            });
            
            console.log(`🚀 ${candidate.symbol} ${signalType} | ${scenario} | OI: %${candidate.oiChangePct.toFixed(2)} | Hacim: ${volumeSurge.toFixed(1)}x | Skor: ${score} | Mum: %${(candleProgress*100).toFixed(0)} | ${strength.label}`);
            
        } catch (e) { continue; }
    }
}

// ============================================================
// SİNYAL YAŞAM DÖNGÜSÜ - DİNAMİK STOP
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
            
            let status = '❌ GEÇTİ';
            let statusClass = 'status-missed';
            let cardState = 'MISSED';
            
            if (ageMin <= 10 && distancePct <= CFG.MAX_DISTANCE_PCT) {
                status = '✅ GİRİLEBİLİR';
                statusClass = 'status-fresh';
                cardState = 'FRESH';
            }
            
            // MFE/MAE
            if (signal.type === 'LONG') {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                
                // DİNAMİK STOP: Ters giderse stopu daralt
                if (currentPrice < signal.entryPrice * 0.997 && signal.atr) {
                    const newStop = Math.max(signal.stop, currentPrice - (signal.atr * 0.3));
                    if (newStop > signal.stop && newStop < signal.entryPrice) {
                        signal.stop = newStop;
                        signal.stopFormatted = fmtPrice(newStop);
                    }
                }
                
                if (signal.tp1 && currentPrice >= signal.tp1) {
                    status = '✅ TP1 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice >= signal.tp2) {
                    status = '✅ TP2 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.stop && currentPrice <= signal.stop) {
                    status = '🛑 STOP';
                    statusClass = 'status-stop';
                    cardState = 'CLOSED';
                }
            } else {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                
                if (currentPrice > signal.entryPrice * 1.003 && signal.atr) {
                    const newStop = Math.min(signal.stop, currentPrice + (signal.atr * 0.3));
                    if (newStop < signal.stop && newStop > signal.entryPrice) {
                        signal.stop = newStop;
                        signal.stopFormatted = fmtPrice(newStop);
                    }
                }
                
                if (signal.tp1 && currentPrice <= signal.tp1) {
                    status = '✅ TP1 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice <= signal.tp2) {
                    status = '✅ TP2 HEDEF';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.stop && currentPrice >= signal.stop) {
                    status = '🛑 STOP';
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
    
    console.log(`\n[${new Date().toLocaleTimeString()}] Tarama...`);
    
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
        console.error('Tarama Hatası:', e.message);
    } finally {
        isScanning = false;
        broadcast();
    }
}

// ============================================================
// WEBSOCKET
// ============================================================
function broadcast() {
    const data = {
        signals: activeSignals,
        stats: {
            total: activeSignals.length,
            fresh: activeSignals.filter(s => s.cardState === 'FRESH').length
        }
    };
    
    const payload = JSON.stringify({ type: 'snapshot', data });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch (e) {}
        }
    });
}

wss.on('connection', ws => {
    const data = {
        signals: activeSignals,
        stats: {
            total: activeSignals.length,
            fresh: activeSignals.filter(s => s.cardState === 'FRESH').length
        }
    };
    
    try { ws.send(JSON.stringify({ type: 'snapshot', data })); } catch (e) {}
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

// ============================================================
// FRONTEND
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FLOW IGNITION V3</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.app{display:grid;grid-template-columns:350px 1fr;height:100vh;}
@media(max-width:800px){.app{grid-template-columns:1fr;}.signal-panel{display:none;}}
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh;}
.panel-header{padding:15px;border-bottom:1px solid #1a2533;}
.panel-title{font-size:18px;font-weight:900;color:#13dba0;}
.panel-sub{font-size:9px;color:#718096;margin-top:2px;}
.panel-stats{display:flex;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533;}
.panel-stat{flex:1;text-align:center;background:#101826;border-radius:6px;padding:6px;}
.panel-stat b{display:block;font-size:18px;color:#13dba0;}
.panel-stat span{font-size:8px;color:#64748b;}
.signal-list{flex:1;overflow-y:auto;padding:10px;}
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
<div class="signal-panel">
<div class="panel-header">
<div class="panel-title">FLOW IGNITION V3</div>
<div class="panel-sub">OI + Likidasyon Takibi</div>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Sinyal</span></div>
<div class="panel-stat"><b id="st-fresh">0</b><span>Aktif</span></div>
</div>
<div class="signal-list" id="signals"><div class="empty">Taranıyor...</div></div>
</div>
<div class="chart-panel">
<div class="chart-header">
<div class="chart-title" id="chartTitle">Sinyal seçin</div>
<div class="tf-buttons">
<button class="tf-btn active" data-tf="15m">15M</button>
<button class="tf-btn" data-tf="1h">1H</button>
<button class="tf-btn" data-tf="4h">4H</button>
</div>
</div>
<div class="chart-container"><canvas id="chartCanvas"></canvas></div>
</div>
</div>
<script>
var allSignals = [];
var selectedSymbol = null;
var selectedTf = '15m';
var chartCandles = [];
var currentSignal = null;

function fmtPrice(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); return x.toFixed(8); }

function selectSignal(symbol){
    selectedSymbol = symbol;
    currentSignal = allSignals.find(function(s){ return s.symbol === symbol; }) || null;
    document.querySelectorAll('.signal-card').forEach(function(c){
        c.classList.remove('selected');
        if(c.getAttribute('data-symbol') === symbol) c.classList.add('selected');
    });
    document.getElementById('chartTitle').textContent = symbol.replace(':USDT','') + ' - ' + selectedTf.toUpperCase();
    loadChart();
}

function render(data){
    allSignals = data.signals || [];
    document.getElementById('st-total').textContent = allSignals.length;
    document.getElementById('st-fresh').textContent = allSignals.filter(function(s){ return s.cardState === 'FRESH'; }).length;
    
    var container = document.getElementById('signals');
    if(!allSignals.length){
        container.innerHTML = '<div class="empty">Aktif sinyal yok...</div>';
        return;
    }
    
    container.innerHTML = allSignals.map(function(s){
        var isLong = s.type === 'LONG';
        var cardClass = s.cardState === 'FRESH' ? 'fresh' : s.cardState === 'MISSED' ? 'missed' : 'closed';
        if(selectedSymbol === s.symbol) cardClass += ' selected';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '" data-symbol="' + s.symbol + '">' +
            '<div class="signal-top">' +
                '<div class="signal-coin">' + s.symbol.replace(':USDT','') + '</div>' +
                '<div class="signal-badge ' + (isLong ? 'badge-long' : 'badge-short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
            '</div>' +
            '<div class="strength-badge ' + s.strengthClass + '">' + s.strength + '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice) + '</div>' +
            '<div class="signal-info">' +
                '<span>OI: %' + s.oiChangePct + '</span>' +
                '<span>Hacim: ' + s.volumeSurgeRatio + 'x</span>' +
                '<span>Mum: ' + s.candleProgress + '</span>' +
                '<span>' + s.ageMin + ' dk</span>' +
            '</div>' +
            '<div class="signal-status ' + s.statusClass + '">' + s.status + '</div>' +
        '</div>';
    }).join('');
    
    document.querySelectorAll('.signal-card').forEach(function(card){
        card.addEventListener('click', function(){
            var sym = this.getAttribute('data-symbol');
            if(sym) selectSignal(sym);
        });
    });
    
    if(selectedSymbol){
        currentSignal = allSignals.find(function(s){ return s.symbol === selectedSymbol; }) || null;
    }
}

async function loadChart(){
    if(!selectedSymbol) return;
    try {
        var r = await fetch('/api/chart?symbol=' + encodeURIComponent(selectedSymbol) + '&timeframe=' + encodeURIComponent(selectedTf));
        var d = await r.json();
        if(d.success){
            chartCandles = d.candles || [];
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
    
    if(currentSignal){
        [currentSignal.entryPrice, currentSignal.stop, currentSignal.tp1, currentSignal.tp2].forEach(function(p){
            if(p && p < minPrice) minPrice = p;
            if(p && p > maxPrice) maxPrice = p;
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
    
    ctx.strokeStyle = '#182330';
    for(var g = 0; g <= 4; g++){
        var gy = T + PH * g / 4;
        ctx.beginPath(); ctx.moveTo(L, gy); ctx.lineTo(w - R, gy); ctx.stroke();
        ctx.fillStyle = '#607083'; ctx.font = '8px Arial';
        ctx.fillText(fmtPrice(maxPrice - (maxPrice - minPrice) * g / 4), 3, gy + 3);
    }
    
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
    
    if(currentSignal){
        drawLevel(ctx, currentSignal.entryPrice, '#13dba0', 'GIRIS', L, w-R, Y);
        drawLevel(ctx, currentSignal.stop, '#ff5570', 'STOP', L, w-R, Y);
        drawLevel(ctx, currentSignal.tp1, '#55a7ff', 'TP1', L, w-R, Y);
        drawLevel(ctx, currentSignal.tp2, '#55a7ff', 'TP2', L, w-R, Y);
    }
}

function drawLevel(ctx, price, color, label, L, R, Y){
    if(!price) return;
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
    ctx.fillText(label + ' ' + fmtPrice(price), R + 5, yy + 3);
}

document.querySelectorAll('.tf-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
        document.querySelectorAll('.tf-btn').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        selectedTf = btn.getAttribute('data-tf');
        if(selectedSymbol){
            document.getElementById('chartTitle').textContent = selectedSymbol.replace(':USDT','') + ' - ' + selectedTf.toUpperCase();
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
    fetch('/api/signals', {cache:'no-store'})
        .then(function(r){ return r.json(); })
        .then(function(d){
            if(d.success) render({signals: d.signals});
        })
        .catch(function(){});
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
    console.log('FLOW IGNITION V3');
    console.log('OI + Likidasyon + Erken Tespit');
    console.log('==============================================');
    
    try {
        await exchange.loadMarkets();
        console.log('MARKETLER YUKLENDI');
    } catch (e) {
        console.error('HATA:', e.message);
    }
    
    runScanner();
    setInterval(runScanner, CFG.SCAN_INTERVAL_MS);
    setInterval(updateSignalLifecycle, CFG.SIGNAL_UPDATE_MS);
});
