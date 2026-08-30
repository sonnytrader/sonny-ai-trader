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
// FLOW IGNITION V5 - DÜZELTİLMİŞ GERÇEK SİSTEM
// ============================================================
const CFG = {
    SCAN_INTERVAL_MS: 60 * 1000,
    SIGNAL_UPDATE_MS: 2000,
    
    SIGNAL_TTL_MS: 15 * 60 * 1000,
    FRESH_AGE_MS: 3 * 60 * 1000,
    ACTIONABLE_AGE_MS: 6 * 60 * 1000,
    LATE_AGE_MS: 10 * 60 * 1000,
    
    FRESH_DISTANCE_PCT: 0.3,
    ACTIONABLE_DISTANCE_PCT: 0.6,
    LATE_DISTANCE_PCT: 1.0,
    
    // Likidite
    MIN_VOLUME_USDT: 1000000,
    MAX_CANDIDATES: 100,
    
    // Sıkışma - DÜZELTİLDİ
    ATR_PERIOD: 14,
    COMPRESSION_BOX_CANDLES: 10,       // 10 KAPALI mum
    ATR_LOOKBACK_SHORT: 20,            // ATR için YETERLİ mum (14+)
    ATR_LOOKBACK_LONG: 40,             // Karşılaştırma için
    COMPRESSION_RATIO: 0.6,            // ATR %40 düşmüş
    MAX_BOX_WIDTH_PCT: 1.5,            // Box genişliği fiyatın %1.5'inden az
    
    // OI
    OI_HISTORY_MINUTES: 30,
    OI_ACCUMULATION_PCT: 2.0,          // %2 birikim (3'ten düşürüldü)
    OI_ZSCORE_THRESHOLD: 2.0,
    OI_FLOW_THRESHOLD_PCT: 0.5,        // %0.5 yeterli (1'den düşürüldü)
    
    // Breakout
    BREAKOUT_BUFFER_PCT: 0.05,         // %0.05 buffer (0.1'den düşürüldü)
    
    // Hacim
    VOLUME_IGNITION_MULT: 3.0,         // 3x = %200 artış
    
    // TP/SL
    SL_ATR_MULT: 1.0,
    TP1_ATR_MULT: 2.0,
    TP2_ATR_MULT: 3.5,
    
    MAX_ACTIVE_SIGNALS: 10,
    CANDLE_LIMIT: 100,
    CHART_LIMIT: 100,
    OI_QUERY_DELAY_MS: 30
};

let activeSignals = [];
let isScanning = false;
const oiHistoryBuffer = new Map(); // symbol -> [{value, timestamp, changePct}]

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
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function stdDev(arr) { if (!arr.length) return 0; const m = avg(arr); return Math.sqrt(avg(arr.map(x => Math.pow(x - m, 2)))); }

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
// OI VERİ YÖNETİMİ
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

// DÜZELTİLDİ: OI değişim serisi tutulur
function updateOIHistory(symbol, oiValue) {
    if (!oiHistoryBuffer.has(symbol)) {
        oiHistoryBuffer.set(symbol, []);
    }
    
    const history = oiHistoryBuffer.get(symbol);
    const now = Date.now();
    
    // Önceki OI değerinden değişim yüzdesini hesapla
    let changePct = 0;
    if (history.length > 0) {
        const prevOI = history[history.length - 1].value;
        if (prevOI > 0) {
            changePct = ((oiValue - prevOI) / prevOI) * 100;
        }
    }
    
    history.push({ value: oiValue, timestamp: now, changePct });
    
    // Son 30 dakikayı tut
    const cutoff = now - (CFG.OI_HISTORY_MINUTES * 60 * 1000);
    while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
    }
    
    return history;
}

// DÜZELTİLDİ: OI DEĞİŞİMİNİN Z-Score'u (seviye değil)
function calculateOIChangeZScore(symbol) {
    const history = oiHistoryBuffer.get(symbol) || [];
    
    // Son değişim hariç, önceki değişimlerin istatistiği
    if (history.length < 5) return { zScore: 0, currentChangePct: 0 };
    
    const currentChangePct = history[history.length - 1].changePct;
    const historicalChanges = history.slice(0, -1).map(h => h.changePct);
    
    const mean = avg(historicalChanges);
    const sd = stdDev(historicalChanges);
    
    if (sd === 0) return { zScore: 0, currentChangePct };
    
    const zScore = (currentChangePct - mean) / sd;
    
    return { zScore, currentChangePct };
}

// OI Birikimi - timestamp bazlı
function calculateOIAccumulation(symbol) {
    const history = oiHistoryBuffer.get(symbol) || [];
    if (history.length < 3) return 0;
    
    const first = history[0];
    const last = history[history.length - 1];
    
    const timeDiff = (last.timestamp - first.timestamp) / 60000; // dakika
    
    // En az 10 dakika veri olmalı
    if (timeDiff < 10) return 0;
    
    if (first.value === 0) return 0;
    return ((last.value - first.value) / first.value) * 100;
}

// ============================================================
// SIKIŞMA TESPİTİ - DÜZELTİLDİ
// ============================================================
function detectCompression(candles) {
    // Yeterli mum kontrolü
    if (candles.length < CFG.ATR_LOOKBACK_LONG + CFG.ATR_PERIOD + 1) return null;
    
    // SON 10 KAPANMIŞ MUM (mevcut mum HARİÇ)
    const closedCandles = candles.slice(0, -1);
    const boxCandles = closedCandles.slice(-CFG.COMPRESSION_BOX_CANDLES);
    
    if (boxCandles.length < CFG.COMPRESSION_BOX_CANDLES) return null;
    
    // Sıkışma kutusu
    const compressionHigh = Math.max(...boxCandles.map(c => c[2]));
    const compressionLow = Math.min(...boxCandles.map(c => c[3]));
    const boxWidth = compressionHigh - compressionLow;
    const boxWidthPct = compressionHigh > 0 ? (boxWidth / compressionHigh) * 100 : 100;
    
    // Box genişliği kontrolü - gerçekten yatay sıkışma mı?
    if (boxWidthPct > CFG.MAX_BOX_WIDTH_PCT) {
        return {
            isCompressed: false,
            reason: 'BOX_ÇOK_GENİŞ',
            boxWidthPct,
            compressionHigh,
            compressionLow
        };
    }
    
    // ATR hesaplama - DÜZELTİLDİ
    const recentATR = calculateATR(candles.slice(-CFG.ATR_LOOKBACK_SHORT), CFG.ATR_PERIOD);
    const olderATR = calculateATR(candles.slice(-CFG.ATR_LOOKBACK_LONG, -CFG.ATR_LOOKBACK_SHORT), CFG.ATR_PERIOD);
    
    if (!recentATR || !olderATR || olderATR === 0) return null;
    
    const compressionRatio = recentATR / olderATR;
    const isCompressed = compressionRatio < CFG.COMPRESSION_RATIO;
    
    return {
        isCompressed,
        compressionRatio,
        compressionHigh,
        compressionLow,
        boxWidthPct,
        recentATR,
        olderATR
    };
}

// ============================================================
// BREAKOUT TESPİTİ - DÜZELTİLDİ
// ============================================================
function detectBreakout(currentPrice, compression) {
    if (!compression || !compression.isCompressed) return null;
    
    const highBuffer = compression.compressionHigh * (1 + CFG.BREAKOUT_BUFFER_PCT / 100);
    const lowBuffer = compression.compressionLow * (1 - CFG.BREAKOUT_BUFFER_PCT / 100);
    
    if (currentPrice > highBuffer) {
        const strength = ((currentPrice - compression.compressionHigh) / compression.compressionHigh) * 100;
        return { direction: 'LONG', level: compression.compressionHigh, strength };
    }
    
    if (currentPrice < lowBuffer) {
        const strength = ((compression.compressionLow - currentPrice) / compression.compressionLow) * 100;
        return { direction: 'SHORT', level: compression.compressionLow, strength };
    }
    
    return null;
}

// ============================================================
// AKIŞ TİPİ BELİRLEME - DÜZELTİLDİ
// ============================================================
function determineFlowType(priceDirection, oiChangePct) {
    // Daha toleranslı eşik: %0.5
    const threshold = CFG.OI_FLOW_THRESHOLD_PCT;
    
    if (priceDirection === 'LONG' && oiChangePct < -threshold) {
        return { type: 'A', label: 'SHORT SQUEEZE BASKISI', description: 'Kısa pozisyonlar kapanıyor, yukarı baskı var' };
    }
    if (priceDirection === 'LONG' && oiChangePct > threshold) {
        return { type: 'B', label: 'EXPANSION LONG', description: 'Yeni alıcılar pozisyon açıyor' };
    }
    if (priceDirection === 'SHORT' && oiChangePct < -threshold) {
        return { type: 'C', label: 'LONG SQUEEZE BASKISI', description: 'Uzun pozisyonlar kapanıyor, aşağı baskı var' };
    }
    if (priceDirection === 'SHORT' && oiChangePct > threshold) {
        return { type: 'D', label: 'EXPANSION SHORT', description: 'Yeni satıcılar pozisyon açıyor' };
    }
    
    return null;
}

// ============================================================
// SİNYAL SKORU
// ============================================================
function calculateSignalScore(compressionRatio, oiZScore, oiAccumulation, volumeSurge, breakoutStrength) {
    let score = 0;
    
    // Sıkışma kalitesi (0-25)
    if (compressionRatio < 0.4) score += 25;
    else if (compressionRatio < 0.5) score += 20;
    else if (compressionRatio < 0.6) score += 15;
    else score += 10;
    
    // OI Şoku (0-25)
    if (Math.abs(oiZScore) > 4) score += 25;
    else if (Math.abs(oiZScore) > 3) score += 20;
    else if (Math.abs(oiZScore) > 2.5) score += 15;
    else if (Math.abs(oiZScore) > 2) score += 10;
    else score += 5;
    
    // OI Birikimi (0-20)
    if (Math.abs(oiAccumulation) > 8) score += 20;
    else if (Math.abs(oiAccumulation) > 5) score += 15;
    else if (Math.abs(oiAccumulation) > 3) score += 10;
    else if (Math.abs(oiAccumulation) > 2) score += 5;
    
    // Hacim Ateşlemesi (0-20)
    if (volumeSurge > 8) score += 20;
    else if (volumeSurge > 5) score += 15;
    else if (volumeSurge > 3) score += 10;
    else score += 5;
    
    // Breakout gücü (0-10)
    if (breakoutStrength > 1) score += 10;
    else if (breakoutStrength > 0.5) score += 7;
    else if (breakoutStrength > 0.2) score += 4;
    
    return Math.min(100, score);
}

// ============================================================
// VERİ ÇEKME
// ============================================================
async function getCandles(symbol, timeframe, limit) {
    try {
        const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return Array.isArray(data) ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a,b) => a[0]-b[0]) : [];
    } catch (e) {
        return [];
    }
}

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
                if (price < 0.0001) continue;
                
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
// ANA ANALİZ
// ============================================================
async function scanAndAnalyze(candidates) {
    let signalCount = 0;
    let compressionCount = 0;
    let oiBuildCount = 0;
    let breakoutCount = 0;
    let volumeCount = 0;
    
    for (const candidate of candidates) {
        try {
            const existing = activeSignals.find(s => s.symbol === candidate.symbol && s.cardState !== 'CLOSED');
            if (existing) continue;
            
            if (activeSignals.filter(s => s.cardState !== 'CLOSED').length >= CFG.MAX_ACTIVE_SIGNALS) break;
            
            // 1. OI sorgula ve history güncelle
            const oi = await getOI(candidate.symbol);
            if (oi <= 0) continue;
            
            const cleanSym = candidate.symbol.replace(':USDT', '');
            updateOIHistory(cleanSym, oi);
            
            // 2. OI metrikleri
            const oiResult = calculateOIChangeZScore(cleanSym);
            const oiZScore = oiResult.zScore;
            const oiAccumulation = calculateOIAccumulation(cleanSym);
            
            // OI şoku kontrolü
            if (Math.abs(oiZScore) < CFG.OI_ZSCORE_THRESHOLD) continue;
            
            // 3. Mumları al
            const candles = await getCandles(candidate.symbol, '15m', CFG.CANDLE_LIMIT);
            if (candles.length < 50) continue;
            
            // 4. Sıkışma tespiti
            const compression = detectCompression(candles);
            if (!compression || !compression.isCompressed) continue;
            compressionCount++;
            
            // 5. Güncel fiyat (mevcut mum)
            const currentCandle = candles[candles.length - 1];
            const currentPrice = n(currentCandle[4]);
            const volume = n(currentCandle[5]);
            
            // 6. Breakout tespiti
            const breakout = detectBreakout(currentPrice, compression);
            if (!breakout) continue;
            breakoutCount++;
            
            // 7. Hacim ateşlemesi
            const avgVolume = calculateAvgVolume(candles);
            if (!avgVolume) continue;
            const volumeSurge = volume / avgVolume;
            
            if (volumeSurge < CFG.VOLUME_IGNITION_MULT) continue;
            volumeCount++;
            
            // 8. Akış tipi
            const flowType = determineFlowType(breakout.direction, oiResult.currentChangePct);
            if (!flowType) continue;
            
            // 9. Skor
            const score = calculateSignalScore(
                compression.compressionRatio,
                oiZScore,
                oiAccumulation,
                volumeSurge,
                breakout.strength
            );
            
            if (score < 50) continue;
            
            // 10. TP/SL
            const atr = compression.recentATR;
            const stop = breakout.direction === 'LONG'
                ? compression.compressionLow - (atr * CFG.SL_ATR_MULT)
                : compression.compressionHigh + (atr * CFG.SL_ATR_MULT);
            const risk = Math.abs(currentPrice - stop);
            const tp1 = breakout.direction === 'LONG'
                ? currentPrice + (risk * CFG.TP1_ATR_MULT)
                : currentPrice - (risk * CFG.TP1_ATR_MULT);
            const tp2 = breakout.direction === 'LONG'
                ? currentPrice + (risk * CFG.TP2_ATR_MULT)
                : currentPrice - (risk * CFG.TP2_ATR_MULT);
            
            // 11. Güç seviyesi
            let strengthLabel, strengthClass;
            if (score >= 85) {
                strengthLabel = '🔥🔥 ULTRA';
                strengthClass = 'strength-ultra';
            } else if (score >= 70) {
                strengthLabel = '🔥 GÜÇLÜ';
                strengthClass = 'strength-high';
            } else if (score >= 55) {
                strengthLabel = '💪 İYİ';
                strengthClass = 'strength-good';
            } else {
                strengthLabel = '⚡ NORMAL';
                strengthClass = 'strength-normal';
            }
            
            // 12. Sinyal üret
            activeSignals.unshift({
                id: Math.random().toString(36).substr(2, 9),
                symbol: candidate.symbol,
                type: breakout.direction,
                flowType: flowType.type,
                scenario: flowType.label,
                scenarioDesc: flowType.description,
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
                oiZScore: oiZScore.toFixed(2),
                oiChangePct: oiResult.currentChangePct.toFixed(2),
                oiAccumulation: oiAccumulation.toFixed(2),
                volumeSurgeRatio: volumeSurge.toFixed(2),
                compressionRatio: compression.compressionRatio.toFixed(2),
                boxWidthPct: compression.boxWidthPct.toFixed(2),
                score: score,
                strength: strengthLabel,
                strengthClass: strengthClass,
                status: '🟢 FRESH',
                statusClass: 'status-fresh',
                cardState: 'FRESH',
                distancePct: "0.000",
                ageMin: "0",
                mfe: 0,
                mae: 0,
                atr: atr
            });
            
            signalCount++;
            console.log(`🚀 ${candidate.symbol} ${breakout.direction} | ${flowType.label} | OI Z: ${oiZScore.toFixed(1)} | ΔOI: %${oiResult.currentChangePct.toFixed(2)} | Birikim: %${oiAccumulation.toFixed(1)} | Hacim: ${volumeSurge.toFixed(1)}x | Box: %${compression.boxWidthPct.toFixed(1)} | Skor: ${score}`);
        } catch (e) {
            continue;
        }
        
        await sleep(CFG.OI_QUERY_DELAY_MS);
    }
    
    console.log(`📊 Sıkışma: ${compressionCount} | Breakout: ${breakoutCount} | Hacim: ${volumeCount} | Sinyal: ${signalCount}`);
    return signalCount;
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
            
            let status, statusClass, cardState;
            
            if (signal.type === 'LONG') {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                
                if (currentPrice <= signal.stop) {
                    status = '🛑 STOP';
                    statusClass = 'status-stop';
                    cardState = 'CLOSED';
                } else if (currentPrice >= signal.tp2) {
                    status = '✅ TP2';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                } else if (currentPrice >= signal.tp1) {
                    status = '✅ TP1';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                } else if (ageMin <= 3 && distancePct <= 0.3) {
                    status = '🟢 FRESH';
                    statusClass = 'status-fresh';
                    cardState = 'FRESH';
                } else if (ageMin <= 6 && distancePct <= 0.6) {
                    status = '🟡 ACTIONABLE';
                    statusClass = 'status-warning';
                    cardState = 'VALID';
                } else if (ageMin <= 10 && distancePct <= 1.0) {
                    status = '🟠 LATE';
                    statusClass = 'status-late';
                    cardState = 'MISSED';
                } else {
                    status = '🔴 EXTENDED';
                    statusClass = 'status-missed';
                    cardState = 'MISSED';
                }
            } else {
                signal.maxPrice = Math.max(signal.maxPrice || signal.entryPrice, currentPrice);
                signal.minPrice = Math.min(signal.minPrice || signal.entryPrice, currentPrice);
                signal.mfe = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
                signal.mae = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
                
                if (currentPrice >= signal.stop) {
                    status = '🛑 STOP';
                    statusClass = 'status-stop';
                    cardState = 'CLOSED';
                } else if (currentPrice <= signal.tp2) {
                    status = '✅ TP2';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                } else if (currentPrice <= signal.tp1) {
                    status = '✅ TP1';
                    statusClass = 'status-tp';
                    cardState = 'CLOSED';
                } else if (ageMin <= 3 && distancePct <= 0.3) {
                    status = '🟢 FRESH';
                    statusClass = 'status-fresh';
                    cardState = 'FRESH';
                } else if (ageMin <= 6 && distancePct <= 0.6) {
                    status = '🟡 ACTIONABLE';
                    statusClass = 'status-warning';
                    cardState = 'VALID';
                } else if (ageMin <= 10 && distancePct <= 1.0) {
                    status = '🟠 LATE';
                    statusClass = 'status-late';
                    cardState = 'MISSED';
                } else {
                    status = '🔴 EXTENDED';
                    statusClass = 'status-missed';
                    cardState = 'MISSED';
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
    
    console.log(`\n[${new Date().toLocaleTimeString()}] FLOW IGNITION V5 Tarama...`);
    
    try {
        await updateSignalLifecycle();
        
        const candidates = await preScan();
        if (candidates.length > 0) {
            await scanAndAnalyze(candidates);
        }
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
            fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
            actionable: activeSignals.filter(s => s.cardState === 'VALID').length
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
            fresh: activeSignals.filter(s => s.cardState === 'FRESH').length,
            actionable: activeSignals.filter(s => s.cardState === 'VALID').length
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
<title>FLOW IGNITION V5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh;}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh;}
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
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer;transition:all 0.2s;}
.signal-card:hover{border-color:#13dba0;}
.signal-card.selected{border:2px solid #13dba0;background:#0d1a15;}
.signal-card.long{border-left:4px solid #13dba0;}
.signal-card.short{border-left:4px solid #ff5570;}
.signal-card.fresh{box-shadow:0 0 20px rgba(19,219,160,0.15);}
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
.signal-scenario{font-size:9px;color:#94a3b8;margin-top:4px;}
.signal-info{display:flex;gap:8px;font-size:8px;color:#94a3b8;margin-top:5px;flex-wrap:wrap;}
.signal-info b{color:#e2e8f0;}
.signal-status{margin-top:8px;padding:6px;border-radius:5px;font-size:10px;font-weight:bold;text-align:center;}
.status-fresh{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.status-warning{background:#3d2d0d;color:#fbbf24;border:1px solid #fbbf24;}
.status-late{background:#3d1d0d;color:#fb923c;border:1px solid #fb923c;}
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
<div class="panel-title">FLOW IGNITION V5</div>
<div class="panel-sub">Sıkışma + OI Şoku + Ateşleme</div>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Sinyal</span></div>
<div class="panel-stat"><b id="st-fresh">0</b><span>Fresh</span></div>
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
        var cardClass = s.cardState === 'FRESH' ? 'fresh' : s.cardState === 'MISSED' ? 'missed' : s.cardState === 'CLOSED' ? 'closed' : '';
        if(selectedSymbol === s.symbol) cardClass += ' selected';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '" data-symbol="' + s.symbol + '">' +
            '<div class="signal-top">' +
                '<div class="signal-coin">' + s.symbol.replace(':USDT','') + '</div>' +
                '<div class="signal-badge ' + (isLong ? 'badge-long' : 'badge-short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</div>' +
            '</div>' +
            '<div class="strength-badge ' + s.strengthClass + '">' + s.strength + '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice) + '</div>' +
            '<div class="signal-scenario">' + s.scenario + ' - ' + s.scenarioDesc + '</div>' +
            '<div class="signal-info">' +
                '<span>OI Z: <b>' + s.oiZScore + '</b></span>' +
                '<span>ΔOI: <b>%' + s.oiChangePct + '</b></span>' +
                '<span>Birikim: <b>%' + s.oiAccumulation + '</b></span>' +
                '<span>Hacim: <b>' + s.volumeSurgeRatio + 'x</b></span>' +
                '<span>Box: <b>%' + s.boxWidthPct + '</b></span>' +
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
    console.log('FLOW IGNITION V5');
    console.log('Düzeltilmiş: Sıkışma + OI Şoku + Ateşleme');
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
