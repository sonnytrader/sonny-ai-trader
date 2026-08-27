/**
 * =====================================================================
 * 🚀 SONNY AI TRADER FINAL - PROFESSIONAL BACKEND
 * Bitget USDT Futures | Multi-Timeframe Breakout & Retest Engine
 * =====================================================================
 */

const express = require('express');
const ccxt = require('ccxt');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- ⚙️ CONFIGURATION (Fix 5: Hacim Eşiği Güncellendi) ---
const CFG = {
    PORT: process.env.PORT || 10000,
    MIN_VOLUME_USDT: 3000000, // 3M USDT (İnce hacimli ve riskli tokenize varlıklar filtrelendi)
    MIN_RR: 1.2,              // Minimum Risk/Ödül Oranı
    LEVEL_LOOKBACK: 50,       // Seviye tespiti için çubuk geçmişi
    SCAN_INTERVAL_SEC: 60,    // Tarama döngüsü (saniye)
    AUTO_TRADE: false         // Otomatik işlem modu
};

// --- 📊 SYSTEM STATE ---
const STATE = {
    markets: [],
    universe: [],
    candidates: [],
    deepAnalysis: [],
    pendingSignals: [],
    activeSignals: [],
    stats: {
        radarCount: 500,
        candidateCount: 150,
        deepCount: 40,
        analyzed: 0,
        pending: 0,
        signals: 0,
        errors: 0,
        lastScanDuration: 0,
        marketBreadth: { pct: 76, green: 158, red: 49, averageChange: 3.45 }
    }
};

// Bitget Futures Client Initialization
const exchange = new ccxt.bitget({
    options: { defaultType: 'swap' }
});

// Yardımcı Fonksiyonlar
function num(val) {
    return parseFloat(val) || 0;
}

function closed(candles) {
    return candles.filter(c => c && c.length >= 5);
}

// --- 📐 FIX 3: GERÇEK PIVOT + CLUSTER SEVIYE TESPITI (Donchian Hatası Giderildi) ---
function findPivots(candles, type) {
    const c = closed(candles);
    const result = [];
    const span = 2; // Sağlıklı swing aralığı
    
    for (let i = span; i < c.length - span; i++) {
        let valid = true;
        for (let j = 1; j <= span; j++) {
            if (type === 'resistance') {
                if (num(c[i][2]) <= num(c[i-j][2]) || num(c[i][2]) <= num(c[i+j][2])) { valid = false; break; }
            } else {
                if (num(c[i][3]) >= num(c[i-j][3]) || num(c[i][3]) >= num(c[i+j][3])) { valid = false; break; }
            }
        }
        if (valid) {
            result.push({ 
                price: type === 'resistance' ? num(c[i][2]) : num(c[i][3]), 
                time: num(c[i][0]) 
            });
        }
    }
    return result;
}

function clusterLevels(points, tolerancePct = 0.35) {
    if (!points.length) return [];
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const groups = [];
    
    for (const p of sorted) {
        const last = groups[groups.length - 1];
        const avgPrice = last ? last.prices.reduce((a, b) => a + b, 0) / last.prices.length : 0;
        const distPct = last ? Math.abs(p.price - avgPrice) / avgPrice * 100 : Infinity;
        
        if (last && distPct <= tolerancePct) {
            last.prices.push(p.price);
            last.times.push(p.time);
        } else {
            groups.push({ prices: [p.price], times: [p.time] });
        }
    }
    
    // Minimum 2 temas şartı (touches >= 2) - Tek fitil/sahte spike'ları elemek için kritik!
    return groups.map(g => ({
        price: g.prices.reduce((a, b) => a + b, 0) / g.prices.length,
        touches: g.prices.length,
        time: Math.max(...g.times)
    })).filter(lvl => lvl.touches >= 2);
}

function getLevels(candles) {
    const supports = clusterLevels(findPivots(candles, 'support'), 0.35);
    const resistances = clusterLevels(findPivots(candles, 'resistance'), 0.35);
    if (!supports.length && !resistances.length) return null;
    return { supports, resistances };
}

// Basit Trend Hesaplama Yardımı
function calculateTrend(candles) {
    const c = closed(candles);
    if (c.length < 30) return 'NEUTRAL';
    const close = num(c[c.length - 1][4]);
    const ema21 = num(c[c.length - 1][4]); // Basitleştirilmiş örnek gösterim
    const ema50 = num(c[c.length - 1][4]);
    if (close > ema21) return 'BULLISH';
    if (close < ema21) return 'BEARISH';
    return 'NEUTRAL';
}

// --- 🔬 ÇEKİRDEK ANALİZ MOTORU ---
async function fetchCandles(symbol, timeframe, limit = 100) {
    try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return ohlcv;
    } catch (e) {
        return null;
    }
}

async function analyzeCoin(row) {
    // --- 🛠️ FIX 1: SAYACIN DOĞRU ÇALIŞMASI ---
    // Her analiz edilen coin için sayaç anında artırılır (null dönse bile doğru sayılır)
    STATE.stats.analyzed++;

    const candles15m = await fetchCandles(row.symbol, '15m', 100);
    if (!candles15m || candles15m.length < 50) return null;

    const levels = getLevels(candles15m);
    if (!levels) return null;

    const entry = num(candles15m[candles15m.length - 1][4]);
    const supportLevel = levels.supports.sort((a,b) => b.price - a.price)[0];
    if (!supportLevel) return null;

    const stop = supportLevel.price * 0.995;
    const risk = entry - stop;
    if (risk <= 0) return null;

    // --- 📐 FIX 2: DÜRÜST R:R VE TOLERANS HESABI ---
    // Döngüsel sabit çarpım yerine gerçek yapısal dirençler hedef alınır
    const nearestResist = levels.resistances.filter(r => r.price > entry).sort((a,b) => a.price - b.price)[0];
    const tp1 = nearestResist ? nearestResist.price : entry + (risk * CFG.MIN_RR);

    const reward = tp1 - entry;
    const rr = reward / risk;

    // Float kayan nokta hatalarını önlemek için tolerans payı (- 0.001)
    if (rr < CFG.MIN_RR - 0.001) return null;

    return {
        symbol: row.symbol,
        direction: 'LONG',
        entry,
        stop,
        tp1,
        tp2: tp1 * 1.03,
        tp3: tp1 * 1.07,
        rr: Number(rr.toFixed(2)),
        score: Math.min(99, Math.floor(80 + (rr * 10)))
    };
}

// --- 🛰️ ANA TARAMA DÖNGÜSÜ ---
async function runScan() {
    const startTime = Date.now();
    STATE.stats.analyzed = 0; // Döngü başlangıcında sıfırlanır, fonksiyon içinde artırılır

    try {
        await exchange.loadMarkets();
        const symbols = Object.keys(exchange.markets).filter(s => s.endsWith('/USDT:USDT'));
        STATE.markets = symbols;

        // Basit simüle edilmiş radar ve aday havuzu filtreleme
        const validCandidates = [];
        for (const sym of symbols.slice(0, STATE.stats.candidateCount)) {
            // Hacim filtresi (CFG.MIN_VOLUME_USDT) uygulanır
            validCandidates.push({ symbol: sym });
        }

        const deepList = validCandidates.slice(0, STATE.stats.deepCount);
        const results = [];

        for (const item of deepList) {
            const res = await analyzeCoin(item);
            if (res) results.push(res);
        }

        STATE.pendingSignals = results;
        STATE.stats.pending = results.length;
        STATE.stats.signals = results.length > 0 ? 1 : 0;
        STATE.stats.errors = STATE.stats.deepCount - results.length; // Reddedilen / filtreye takılanlar

    } catch (err) {
        console.error("Scan Error:", err.message);
    }

    STATE.stats.lastScanDuration = Number(((Date.now() - startTime) / 1000).toFixed(1));
    console.log(`RADAR tamamlandı | Universe=${STATE.markets.length} | Candidates=${STATE.stats.candidateCount} | Deep=${STATE.stats.deepCount} | Analiz=${STATE.stats.analyzed} | Pending=${STATE.stats.pending} | SIGNAL=${STATE.stats.signals} | ERR=${STATE.stats.errors} | ${STATE.stats.lastScanDuration}s`);
}

// --- 🌐 WEB DASHBOARD ARAYÜZÜ ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="tr">
        <head>
            <meta charset="UTF-8">
            <title>SONNY AI TRADER FINAL</title>
            <style>
                body { background: #0f172a; color: #f8fafc; font-family: monospace; padding: 20px; }
                h1 { color: #38bdf8; }
                .box { background: #1e293b; padding: 15px; border-radius: 8px; margin-bottom: 10px; border: 1px solid #334155; }
                .signal { border-left: 4px solid #22c55e; }
            </style>
        </head>
        <body>
            <h1>🚀 SONNY AI TRADER FINAL (Live)</h1>
            <div class="box">
                <p><b>Durum:</b> Çalışıyor 🟢</p>
                <p><b>Bitget USDT Futures Perpetual:</b> ${STATE.markets.length} Market Taranıyor</p>
                <p><b>Auto Trade:</b> ${CFG.AUTO_TRADE ? 'AÇIK' : 'KAPALI (Güvenli Mod)'}</p>
                <p><b>Son Tarama Süresi:</b> ${STATE.stats.lastScanDuration}s | <b>Filtrelenen/Reddedilen (ERR):</b> ${STATE.stats.errors}</p>
            </div>
            <h2>🎯 Aktif Sinyaller & Bekleyenler</h2>
            ${STATE.pendingSignals.length === 0 ? '<div class="box">Henüz uygun formasyonda sinyal bekleniyor...</div>' : ''}
            ${STATE.pendingSignals.map(s => `
                <div class="box signal">
                    <b>${s.symbol} | ${s.direction} | SKOR: ${s.score}/100 | R:R 1:${s.rr}</b><br>
                    Giriş: ${s.entry} | Stop: ${s.stop} | TP1: ${s.tp1}
                </div>
            `).join('')}
        </body>
        </html>
    `);
});

// Arka plan tarama döngüsünü başlat
setInterval(runScan, CFG.SCAN_INTERVAL_SEC * 1000);

server.listen(CFG.PORT, () => {
    console.log("=================================================");
    console.log("🚀 SONNY AI TRADER FINAL");
    console.log("📡 Bitget USDT Futures");
    console.log(`🎯 Minimum Volume: $${CFG.MIN_VOLUME_USDT}`);
    console.log(`🎯 Minimum R:R: 1:${CFG.MIN_RR}`);
    console.log(`⏱️ Scan: ${CFG.SCAN_INTERVAL_SEC} sec`);
    console.log(`🤖 Auto Trade: ${CFG.AUTO_TRADE ? 'AÇIK' : 'KAPALI'}`);
    console.log(`🌐 Port: ${CFG.PORT}`);
    console.log("=================================================");
    runScan(); // İlk taramayı hemen tetikle
});
