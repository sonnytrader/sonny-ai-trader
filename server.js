'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ============================================================
// FLOW IGNITION V1 - TAM SİSTEM
// ============================================================
const PORT = process.env.PORT || 10000;
const SCAN_INTERVAL_MS = 60 * 1000; // 1 dakika
const SIGNAL_UPDATE_MS = 2000; // 2 saniye
const SIGNAL_TTL_MS = 15 * 60 * 1000; // 15 dakika

let previousOI = {};
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

function formatVolume(v) { 
    if (v >= 1e9) return (v/1e9).toFixed(2)+'B'; 
    if (v >= 1e6) return (v/1e6).toFixed(1)+'M'; 
    if (v >= 1e3) return (v/1e3).toFixed(1)+'K'; 
    return v.toFixed(0); 
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

// ============================================================
// OI VERİSİ - ÇOKLU YÖNTEM
// ============================================================
async function fetchBulkOpenInterest() {
    // Yöntem 1: Bitget toplu endpoint
    try {
        const response = await fetch('https://api.bitget.com/api/v2/mix/market/open-interest-all?productType=usdt-futures', {
            signal: AbortSignal.timeout(10000)
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.code === '00000' && data.data) {
                const oiData = {};
                data.data.forEach(item => {
                    oiData[item.symbol] = parseFloat(item.amount || item.openInterest || item.size || 0);
                });
                return oiData;
            }
        }
    } catch (e) {
        console.log('⚠️ Toplu OI endpoint çalışmadı, alternatif deneniyor...');
    }
    
    // Yöntem 2: Ticker'dan OI oku
    try {
        const tickers = await exchange.fetchTickers();
        const oiData = {};
        
        for (const [symbol, ticker] of Object.entries(tickers)) {
            if (!symbol.endsWith(':USDT')) continue;
            const cleanSym = symbol.replace(':USDT', '');
            const oi = ticker.info?.openInterest || ticker.info?.amount || 0;
            if (oi > 0) {
                oiData[cleanSym] = parseFloat(oi);
            }
        }
        
        return oiData;
    } catch (e) {
        console.error('🔴 OI verisi alınamadı:', e.message);
        return {};
    }
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
            
            // TTL kontrolü
            if (age > SIGNAL_TTL_MS) return false;
            
            const ticker = tickers[signal.symbol];
            if (!ticker) return true;
            
            const currentPrice = n(ticker.last);
            const ageMin = age / 60000;
            const distancePct = Math.abs(currentPrice - signal.entryPrice) / signal.entryPrice * 100;
            
            // Statü
            let status = '🔴 MISSED / EXTENDED';
            let statusClass = 'status-missed';
            let cardState = 'MISSED';
            
            if (ageMin <= 5 && distancePct <= 0.2) {
                status = '🟢 FRESH';
                statusClass = 'status-fresh';
                cardState = 'FRESH';
            } else if (ageMin <= 15 && distancePct <= 0.5) {
                status = '🟡 VALID - LATE';
                statusClass = 'status-warning';
                cardState = 'VALID';
            }
            
            // MFE/MAE
            if (signal.type === 'LONG') {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                
                // TP/SL kontrolü
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
            signal.ageMin = ageMin.toFixed(2);
            signal.distancePct = distancePct.toFixed(3);
            signal.status = status;
            signal.statusClass = statusClass;
            signal.cardState = cardState;
            
            return true;
        });
    } catch (e) {
        // Sessiz
    }
}

// ============================================================
// ANA TARAMA
// ============================================================
async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    
    console.log(`\n📡 [${new Date().toLocaleTimeString()}] Flow Ignition V1 Tarama Başladı...`);
    
    try {
        const currentOI = await fetchBulkOpenInterest();
        
        if (Object.keys(currentOI).length === 0) {
            console.log('❌ OI verisi alınamadı, tarama atlandı');
            isScanning = false;
            return;
        }
        
        console.log(`✅ ${Object.keys(currentOI).length} coin OI verisi alındı`);
        
        // Sinyal yaşam döngüsünü güncelle
        await updateSignalLifecycle();
        
        // OI değişimi olan coinleri bul
        if (Object.keys(previousOI).length > 0) {
            const markets = await exchange.loadMarkets();
            const usdtMarkets = Object.keys(markets).filter(s => s.endsWith(':USDT'));
            
            let analyzedCount = 0;
            
            for (const symbol of usdtMarkets) {
                try {
                    const apiSymbol = symbol.replace(':USDT', '');
                    const currOiVal = currentOI[apiSymbol];
                    const prevOiVal = previousOI[apiSymbol];
                    
                    if (!currOiVal || !prevOiVal) continue;
                    
                    const oiChangePct = ((currOiVal - prevOiVal) / prevOiVal) * 100;
                    
                    // Sadece anlamlı OI değişimi olanları analiz et
                    if (Math.abs(oiChangePct) < 0.5) continue;
                    
                    // Aktif sinyal kontrolü
                    const existing = activeSignals.find(s => s.symbol === symbol);
                    if (existing) continue;
                    
                    // Sinyal limiti
                    if (activeSignals.filter(s => s.cardState === 'FRESH' || s.cardState === 'VALID').length >= 10) break;
                    
                    const candles = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
                    if (candles.length < 20) continue;
                    
                    analyzedCount++;
                    
                    const currentCandle = candles[candles.length - 1];
                    const open = currentCandle[1];
                    const close = currentCandle[4];
                    const volume = currentCandle[5];
                    const high = currentCandle[2];
                    const low = currentCandle[3];
                    
                    const atr = calculateATR(candles);
                    const avgVolume = calculateAvgVolume(candles);
                    
                    if (!atr || !avgVolume) continue;
                    
                    const candleSize = Math.abs(close - open);
                    const isCompression = candleSize < (atr * 0.8);
                    const isVolumeSurge = volume > (avgVolume * 2.5);
                    
                    if (isVolumeSurge) {
                        const isPriceUp = close > open;
                        let signalType = null;
                        let scenario = "";
                        
                        if (isPriceUp) {
                            if (oiChangePct < 0) { signalType = "LONG"; scenario = "A-SHORT_SQUEEZE"; }
                            else if (oiChangePct > 0) { signalType = "LONG"; scenario = "B-EXPANSION_LONG"; }
                        } else {
                            if (oiChangePct < 0) { signalType = "SHORT"; scenario = "C-LONG_SQUEEZE"; }
                            else if (oiChangePct > 0) { signalType = "SHORT"; scenario = "D-EXPANSION_SHORT"; }
                        }
                        
                        if (signalType) {
                            // TP/SL hesapla
                            const stop = signalType === 'LONG' ? low - (atr * 1.5) : high + (atr * 1.5);
                            const risk = Math.abs(close - stop);
                            const tp1 = signalType === 'LONG' ? close + (risk * 2.5) : close - (risk * 2.5);
                            const tp2 = signalType === 'LONG' ? close + (risk * 4) : close - (risk * 4);
                            
                            activeSignals.unshift({
                                id: Math.random().toString(36).substr(2, 9),
                                symbol: symbol,
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
                                oiChangePct: oiChangePct.toFixed(2),
                                volumeSurgeRatio: (volume / avgVolume).toFixed(2),
                                isCompression: isCompression,
                                status: '🟢 FRESH',
                                statusClass: 'status-fresh',
                                cardState: 'FRESH',
                                distancePct: "0.000",
                                ageMin: "0.00",
                                mfe: 0,
                                mae: 0,
                                rr1: '2.5',
                                rr2: '4.0'
                            });
                            
                            console.log(`🚀 ${symbol} ${signalType} | ${scenario} | OI Δ: %${oiChangePct.toFixed(2)} | Giriş: ${fmtPrice(close)}`);
                        }
                    }
                    
                    await new Promise(r => setTimeout(r, 50));
                    
                } catch (err) {
                    // Tekil hata döngüyü kırmasın
                }
            }
            
            console.log(`📊 Analiz edilen: ${analyzedCount} coin | Aktif sinyal: ${activeSignals.filter(s => s.cardState === 'FRESH' || s.cardState === 'VALID').length}`);
        }
        
        previousOI = currentOI;
        
    } catch (error) {
        console.error('🔴 Tarama Hatası:', error.message);
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
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
                    valid: activeSignals.filter(s => s.cardState === 'VALID').length
                },
                lastScan: Date.now()
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
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
                    valid: activeSignals.filter(s => s.cardState === 'VALID').length
                },
                lastScan: Date.now()
            }
        }));
    } catch (e) {}
});

// ============================================================
// API
// ============================================================
app.get('/api/signals', (req, res) => {
    res.json({
        success: true,
        count: activeSignals.length,
        signals: activeSignals
    });
});

app.get('/api/stats', (req, res) => {
    const total = activeSignals.length;
    const freshCount = activeSignals.filter(s => s.cardState === 'FRESH').length;
    const validCount = activeSignals.filter(s => s.cardState === 'VALID').length;
    const avgMfe = total > 0 ? (activeSignals.reduce((acc, s) => acc + s.mfe, 0) / total).toFixed(2) : 0;
    const avgMae = total > 0 ? (activeSignals.reduce((acc, s) => acc + s.mae, 0) / total).toFixed(2) : 0;
    
    res.json({
        success: true,
        metrics: {
            totalSignals: total,
            freshOpportunities: freshCount,
            validOpportunities: validCount,
            averageMFE: `%${avgMfe}`,
            averageMAE: `%${avgMae}`,
            uptimeMinutes: Math.floor(process.uptime() / 60)
        }
    });
});

// ============================================================
// FRONTEND
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
.header{background:#0b111b;border-bottom:1px solid #1a2533;padding:15px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;}
.brand{font-size:22px;font-weight:900;color:#13dba0;}
.brand-sub{font-size:10px;color:#718096;margin-top:2px;}
.stats{display:flex;gap:10px;flex-wrap:wrap;}
.stat{text-align:center;background:#101826;border:1px solid #1b2939;padding:8px 12px;border-radius:8px;}
.stat b{display:block;font-size:20px;color:#13dba0;font-weight:900;}
.stat span{color:#64748b;font-size:8px;text-transform:uppercase;}
.content{padding:20px;height:calc(100vh - 80px);overflow-y:auto;}
.signal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:15px;}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:14px;padding:18px;transition:all 0.3s;}
.signal-card.long{border-left:5px solid #13dba0;}
.signal-card.short{border-left:5px solid #ff5570;}
.signal-card.fresh{box-shadow:0 0 25px rgba(19,219,160,0.2);animation:glow 2s infinite;}
.signal-card.valid{opacity:0.85;}
.signal-card.missed{opacity:0.4;filter:grayscale(60%);pointer-events:none;}
.signal-card.closed{opacity:0.6;}
@keyframes glow{0%,100%{box-shadow:0 0 25px rgba(19,219,160,0.2);}50%{box-shadow:0 0 40px rgba(19,219,160,0.4);}}
.signal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.signal-coin{font-size:18px;font-weight:900;}
.signal-badge{font-size:10px;padding:5px 14px;border-radius:20px;font-weight:900;}
.badge-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.badge-short{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.scenario{font-size:9px;color:#94a3b8;margin-bottom:8px;}
.signal-price{font-size:22px;font-weight:900;margin:8px 0;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;}
.level{background:#0b111b;border:1px solid #1b2938;border-radius:8px;padding:10px;}
.level span{display:block;color:#64748b;font-size:8px;margin-bottom:3px;}
.level b{font-size:14px;}
.level.entry b{color:#13dba0;}
.level.stop b{color:#ff5570;}
.level.tp b{color:#55a7ff;}
.signal-status{margin-top:12px;padding:8px;border-radius:8px;font-size:12px;font-weight:bold;text-align:center;}
.status-fresh{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.status-warning{background:#3d2d0d;color:#fbbf24;border:1px solid #fbbf24;}
.status-missed{background:#2d1d1d;color:#ff5570;border:1px solid #ff5570;}
.status-stop{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.status-tp{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee;}
.empty{text-align:center;color:#64748b;font-size:14px;padding:60px;}
@media(max-width:600px){.signal-grid{grid-template-columns:1fr;}.stats{display:none;}}
</style>
</head>
<body>
<div class="header">
<div>
<div class="brand">🔥 FLOW IGNITION V1</div>
<div class="brand-sub">OI + Hacim Şoku + Sıkışma • 15M Scalping</div>
</div>
<div class="stats">
<div class="stat"><b id="st-total">0</b><span>Toplam</span></div>
<div class="stat"><b id="st-fresh">0</b><span>Fresh</span></div>
<div class="stat"><b id="st-valid">0</b><span>Valid</span></div>
</div>
</div>
<div class="content">
<div class="signal-grid" id="signals">
<div class="empty">⏳ OI verisi taranıyor...</div>
</div>
</div>
<script>
function fmtPrice(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); return x.toFixed(8); }

function render(data){
    var stats = data.stats || {};
    document.getElementById('st-total').textContent = stats.total || 0;
    document.getElementById('st-fresh').textContent = stats.fresh || 0;
    document.getElementById('st-valid').textContent = stats.valid || 0;
    
    var signals = data.signals || [];
    var container = document.getElementById('signals');
    
    if(!signals.length){
        container.innerHTML = '<div class="empty">⏳ Aktif sinyal yok. Sistem OI verisini tarıyor...</div>';
        return;
    }
    
    container.innerHTML = signals.map(function(s){
        var isLong = s.type === 'LONG';
        var badgeClass = isLong ? 'badge-long' : 'badge-short';
        var cardClass = s.cardState === 'FRESH' ? 'fresh' : s.cardState === 'VALID' ? 'valid' : s.cardState === 'MISSED' ? 'missed' : 'closed';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '">' +
            '<div class="signal-head">' +
                '<div class="signal-coin">' + s.symbol + '</div>' +
                '<div class="signal-badge ' + badgeClass + '">' + s.type + '</div>' +
            '</div>' +
            '<div class="scenario">' + s.scenario + ' | OI Δ: %' + s.oiChangePct + '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice) + '</div>' +
            '<div class="levels">' +
                '<div class="level entry"><span>GİRİŞ</span><b>' + s.entryPriceFormatted + '</b></div>' +
                '<div class="level stop"><span>STOP</span><b>' + s.stopFormatted + '</b></div>' +
                '<div class="level tp"><span>TP1 (' + s.rr1 + 'R)</span><b>' + s.tp1Formatted + '</b></div>' +
                '<div class="level tp"><span>TP2 (' + s.rr2 + 'R)</span><b>' + s.tp2Formatted + '</b></div>' +
            '</div>' +
            '<div class="signal-status ' + s.statusClass + '">' + s.status + '</div>' +
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
    fetch('/api/signals').then(function(r){ return r.json(); }).then(function(d){
        if(d.success) render({signals: d.signals, stats: {total: d.count, fresh: d.signals.filter(function(s){return s.cardState==='FRESH';}).length, valid: d.signals.filter(function(s){return s.cardState==='VALID';}).length}});
    }).catch(function(){});
}, 3000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

// ============================================================
// BAŞLATMA
// ============================================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🔥 FLOW IGNITION V1 BAŞLATILIYOR');
    console.log('📊 OI + Hacim Şoku + Sıkışma');
    console.log('==============================================');
    
    try {
        await exchange.loadMarkets();
        console.log('✅ MARKETLER YÜKLENDİ');
    } catch (e) {
        console.error('❌ MARKET HATASI:', e.message);
    }
    
    runScanner();
    setInterval(runScanner, SCAN_INTERVAL_MS);
    setInterval(updateSignalLifecycle, SIGNAL_UPDATE_MS);
});
