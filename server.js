'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

// ============================================================
// FLOW IGNITION V1 - KESİN OI ÇÖZÜMÜ
// ============================================================
const CFG = {
    SCAN_INTERVAL_MS: 60 * 1000,
    SIGNAL_UPDATE_MS: 2000,
    SIGNAL_TTL_MS: 15 * 60 * 1000,
    FRESH_AGE_MS: 5 * 60 * 1000,
    FRESH_DISTANCE_PCT: 0.2,
    VALID_DISTANCE_PCT: 0.5,
    MIN_VOLUME_USDT: 1000000,
    MIN_VOLUME_SURGE: 2.5,
    ATR_PERIOD: 14,
    COMPRESSION_RATIO: 0.8,
    OI_CHANGE_THRESHOLD_PCT: 0.5,
    SL_ATR_MULT: 1.5,
    TP1_ATR_MULT: 2.5,
    TP2_ATR_MULT: 4.0,
    MAX_ACTIVE_SIGNALS: 10,
    CANDLE_LIMIT: 30,
    RADAR_LIMIT: 30
};

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtPrice(v) { const x = Number(v); if (!Number.isFinite(x)) return '-'; if (x >= 1000) return x.toFixed(2); if (x >= 100) return x.toFixed(3); if (x >= 1) return x.toFixed(5); if (x >= 0.01) return x.toFixed(7); return x.toFixed(8); }

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
// KESİN OI ÇÖZÜMÜ - 4 FARKLI YÖNTEM
// ============================================================
async function fetchOIWithMethod1(symbol) {
    // Yöntem 1: ccxt fetchOpenInterest
    try {
        const oi = await exchange.fetchOpenInterest(symbol);
        if (oi) {
            if (typeof oi === 'object') {
                const val = parseFloat(oi.openInterestAmount || oi.openInterest || oi.amount || oi.size || 0);
                if (val > 0) return val;
            } else if (typeof oi === 'number' && oi > 0) {
                return oi;
            }
        }
    } catch (e) {
        // Sessiz
    }
    return 0;
}

async function fetchOIWithMethod2(symbol) {
    // Yöntem 2: Direct REST API - tek endpoint
    try {
        const cleanSym = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = `https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${cleanSym}&productType=usdt-futures`;
        
        const response = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data && data.code === '00000' && data.data) {
                const val = parseFloat(data.data.amount || data.data.openInterest || data.data.size || 0);
                if (val > 0) return val;
            }
        }
    } catch (e) {
        // Sessiz
    }
    return 0;
}

async function fetchOIWithMethod3(symbol) {
    // Yöntem 3: Ticker info alanı
    try {
        const ticker = await exchange.fetchTicker(symbol);
        const info = ticker.info || {};
        const val = parseFloat(info.openInterest || info.amount || info.size || info.oi || 0);
        if (val > 0) return val;
    } catch (e) {
        // Sessiz
    }
    return 0;
}

async function fetchOIWithMethod4(symbol) {
    // Yöntem 4: fetchOpenInterestHistory
    try {
        const history = await exchange.fetchOpenInterestHistory(symbol, '5m', undefined, 2);
        if (history && history.length > 0) {
            const latest = history[history.length - 1];
            const val = parseFloat(latest.openInterestAmount || latest.openInterest || latest.amount || 0);
            if (val > 0) return val;
        }
    } catch (e) {
        // Sessiz
    }
    return 0;
}

async function getOI(symbol) {
    // Tüm yöntemleri dene, ilk çalışanı kullan
    const methods = [
        fetchOIWithMethod1,
        fetchOIWithMethod2,
        fetchOIWithMethod3,
        fetchOIWithMethod4
    ];
    
    for (const method of methods) {
        try {
            const oi = await method(symbol);
            if (oi > 0) return oi;
        } catch (e) {
            continue;
        }
    }
    
    return 0;
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
            
            let status = '🔴 MISSED';
            let statusClass = 'status-missed';
            let cardState = 'MISSED';
            
            if (ageMin <= 5 && distancePct <= 0.2) {
                status = '🟢 FRESH';
                statusClass = 'status-fresh';
                cardState = 'FRESH';
            } else if (ageMin <= 15 && distancePct <= 0.5) {
                status = '🟡 VALID';
                statusClass = 'status-warning';
                cardState = 'VALID';
            }
            
            // MFE/MAE
            if (signal.type === 'LONG') {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                
                if (signal.tp1 && currentPrice >= signal.tp1) {
                    status = '✅ TP1';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice >= signal.tp2) {
                    status = '✅ TP2';
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
                    status = '✅ TP1';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                }
                if (signal.tp2 && currentPrice <= signal.tp2) {
                    status = '✅ TP2';
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
        await updateSignalLifecycle();
        
        // Yüksek hacimli coinleri al
        const tickers = await exchange.fetchTickers();
        const highVolumeSymbols = [];
        
        for (const [symbol, ticker] of Object.entries(tickers)) {
            if (!symbol.endsWith(':USDT')) continue;
            const volume = n(ticker.quoteVolume);
            if (volume >= CFG.MIN_VOLUME_USDT) {
                highVolumeSymbols.push({ symbol, volume, price: n(ticker.last) });
            }
        }
        
        highVolumeSymbols.sort((a, b) => b.volume - a.volume);
        const topSymbols = highVolumeSymbols.slice(0, CFG.RADAR_LIMIT);
        
        console.log(`✅ ${topSymbols.length} yüksek hacimli coin`);
        
        // OI verilerini topla
        const currentOI = {};
        let oiSuccessCount = 0;
        
        for (const item of topSymbols) {
            const oi = await getOI(item.symbol);
            const cleanSym = item.symbol.replace(':USDT', '');
            currentOI[cleanSym] = oi;
            if (oi > 0) oiSuccessCount++;
            await sleep(30);
        }
        
        console.log(`✅ ${oiSuccessCount}/${topSymbols.length} coin OI verisi alındı`);
        
        // OI değişimi analizi
        if (oiSuccessCount > 0 && Object.keys(previousOI).length > 0) {
            let analyzedCount = 0;
            
            for (const item of topSymbols) {
                try {
                    const cleanSym = item.symbol.replace(':USDT', '');
                    const currOi = currentOI[cleanSym];
                    const prevOi = previousOI[cleanSym];
                    
                    if (!currOi || !prevOi || prevOi === 0) continue;
                    
                    const oiChangePct = ((currOi - prevOi) / prevOi) * 100;
                    
                    if (Math.abs(oiChangePct) < CFG.OI_CHANGE_THRESHOLD_PCT) continue;
                    
                    const existing = activeSignals.find(s => s.symbol === item.symbol);
                    if (existing) continue;
                    
                    if (activeSignals.length >= CFG.MAX_ACTIVE_SIGNALS) break;
                    
                    const candles = await exchange.fetchOHLCV(item.symbol, '15m', undefined, CFG.CANDLE_LIMIT);
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
                    const isCompression = candleSize < (atr * CFG.COMPRESSION_RATIO);
                    const isVolumeSurge = volume > (avgVolume * CFG.MIN_VOLUME_SURGE);
                    
                    if (isVolumeSurge && isCompression) {
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
                            const stop = signalType === 'LONG' ? low - (atr * CFG.SL_ATR_MULT) : high + (atr * CFG.SL_ATR_MULT);
                            const risk = Math.abs(close - stop);
                            const tp1 = signalType === 'LONG' ? close + (risk * CFG.TP1_ATR_MULT) : close - (risk * CFG.TP1_ATR_MULT);
                            const tp2 = signalType === 'LONG' ? close + (risk * CFG.TP2_ATR_MULT) : close - (risk * CFG.TP2_ATR_MULT);
                            
                            activeSignals.unshift({
                                id: Math.random().toString(36).substr(2, 9),
                                symbol: item.symbol,
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
                                status: '🟢 FRESH',
                                statusClass: 'status-fresh',
                                cardState: 'FRESH',
                                distancePct: "0.000",
                                ageMin: "0.00",
                                mfe: 0,
                                mae: 0
                            });
                            
                            console.log(`🚀 ${item.symbol} ${signalType} | ${scenario} | OI Δ: %${oiChangePct.toFixed(2)} | Giriş: ${fmtPrice(close)}`);
                        }
                    }
                    
                    await sleep(20);
                } catch (err) {
                    continue;
                }
            }
            
            console.log(`📊 Analiz: ${analyzedCount} | Sinyal: ${activeSignals.length}`);
        }
        
        previousOI = currentOI;
        
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
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
                    valid: activeSignals.filter(s => s.cardState === 'VALID').length
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
                    fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
                    valid: activeSignals.filter(s => s.cardState === 'VALID').length
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

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
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
.brand-sub{font-size:10px;color:#718096;}
.stats{display:flex;gap:10px;flex-wrap:wrap;}
.stat{text-align:center;background:#101826;border:1px solid #1b2939;padding:8px 12px;border-radius:8px;}
.stat b{display:block;font-size:20px;color:#13dba0;font-weight:900;}
.stat span{color:#64748b;font-size:8px;}
.content{padding:20px;height:calc(100vh - 80px);overflow-y:auto;}
.signal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:15px;}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:14px;padding:18px;transition:all 0.3s;}
.signal-card.long{border-left:5px solid #13dba0;}
.signal-card.short{border-left:5px solid #ff5570;}
.signal-card.fresh{box-shadow:0 0 25px rgba(19,219,160,0.2);animation:glow 2s infinite;}
.signal-card.valid{opacity:0.85;}
.signal-card.missed{opacity:0.4;filter:grayscale(60%);}
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
                '<div class="level tp"><span>TP1</span><b>' + s.tp1Formatted + '</b></div>' +
                '<div class="level tp"><span>TP2</span><b>' + s.tp2Formatted + '</b></div>' +
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
        if(d.success) render({signals: d.signals, stats: {total: d.count, fresh: d.signals.filter(function(s){return s.cardState==='FRESH';}).length}});
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
        
        // OI testi
        const testOI = await getOI('BTC/USDT:USDT');
        console.log('🧪 BTC OI TEST:', testOI > 0 ? `✅ ${testOI}` : '❌ OI ALINAMADI');
        
    } catch (e) {
        console.error('❌ MARKET HATASI:', e.message);
    }
    
    runScanner();
    setInterval(runScanner, CFG.SCAN_INTERVAL_MS);
    setInterval(updateSignalLifecycle, CFG.SIGNAL_UPDATE_MS);
});
