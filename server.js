'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

// ============================================================
// FLOW IGNITION V1 - KONFİGÜRASYON
// ============================================================
const CFG = {
    // Döngüler
    OI_SCAN_INTERVAL_MS: 60 * 1000,      // 1 dakikada bir OI tara
    SIGNAL_UPDATE_MS: 2000,               // 2 saniyede bir sinyal durumunu güncelle
    
    // Sinyal Yaşam Döngüsü
    SIGNAL_TTL_MS: 15 * 60 * 1000,       // 15 dakika sonra sinyal ölür
    FRESH_AGE_MS: 5 * 60 * 1000,          // 5 dakikaya kadar FRESH
    FRESH_DISTANCE_PCT: 0.2,              // %0.2 sapmaya kadar FRESH
    VALID_DISTANCE_PCT: 0.5,              // %0.5 sapmaya kadar VALID-LATE
    
    // Filtreler
    MIN_VOLUME_USDT: 2000000,             // Minimum 24s hacim
    MIN_VOLUME_SURGE: 2.5,                // Hacim şoku: 2.5x
    ATR_PERIOD: 14,
    COMPRESSION_RATIO: 1.2,               // Mevcut mum ATR'nin 1.2 katından büyükse kırılım
    
    // OI Z-Score
    OI_ZSCORE_LOOKBACK_MINUTES: 30,       // Son 30 dakika OI geçmişi
    OI_ZSCORE_THRESHOLD: 1.5,             // Z-Score eşiği
    OI_CHANGE_THRESHOLD_PCT: 2.0,         // %2 OI değişimi
    
    // TP/SL
    SL_ATR_MULT: 1.5,
    TP1_ATR_MULT: 2.5,
    TP2_ATR_MULT: 4.0,
    
    // Limitler
    MAX_ACTIVE_SIGNALS: 10,
    SIGNAL_COOLDOWN_MS: 20 * 60 * 1000,   // Aynı coin 20 dk bekle
    CANDLE_LIMIT: 100,
    
    // Cache
    CANDLE_CACHE_TTL: 10 * 1000,          // 10 saniye
    OI_HISTORY_LIMIT: 60                   // 60 dakika OI geçmişi
};

// ============================================================
// STATE - GLOBAL DURUM
// ============================================================
const STATE = {
    signals: new Map(),
    cooldowns: new Map(),
    oiHistory: new Map(),      // symbol -> [{value, timestamp}]
    oiPrevious: new Map(),     // symbol -> previous OI value
    scanning: false,
    lastOIScan: 0,
    lastError: '',
    stats: {
        oiScanned: 0,
        candidates: 0,
        signals: 0,
        longSignals: 0,
        shortSignals: 0,
        totalSignalsProduced: 0
    },
    performance: {
        wins: 0,
        losses: 0,
        timeouts: 0,
        winRate: 0,
        totalR: 0,
        avgMFE: 0,
        avgMAE: 0
    },
    mfeMaeTracking: new Map() // signalId -> { maxProfitPct, maxLossPct }
};

// ============================================================
// CACHE
// ============================================================
const candleCache = new Map();

// ============================================================
// EXCHANGE & HTTP CLIENT
// ============================================================
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

const bitgetHttp = axios.create({
    baseURL: 'https://api.bitget.com',
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' }
});

// ============================================================
// YARDIMCI FONKSİYONLAR
// ============================================================
function n(v, d = 6) { 
    const x = Number(v); 
    return Number.isFinite(x) ? Number(x.toFixed(d)) : 0; 
}

function avg(arr) { 
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; 
}

function stdDev(arr) { 
    if (!arr.length) return 0; 
    const m = avg(arr); 
    return Math.sqrt(avg(arr.map(x => Math.pow(x - m, 2)))); 
}

function sleep(ms) { 
    return new Promise(r => setTimeout(r, ms)); 
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

function cleanSymbol(s) {
    return String(s || '').replace(':USDT', '').replace('/USDT', '');
}

// ============================================================
// İNDİKATÖRLER
// ============================================================
function calculateATR(candles, period = 14) {
    try {
        if (!candles || candles.length < period + 1) return 0;
        const trs = [];
        for (let i = 1; i < candles.length; i++) {
            const h = n(candles[i][2]);
            const l = n(candles[i][3]);
            const pc = n(candles[i-1][4]);
            trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
        }
        return avg(trs.slice(-period));
    } catch (e) {
        return 0;
    }
}

function calculateRSI(closes, period = 14) {
    try {
        if (!closes || closes.length <= period) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i-1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }
        let ag = gains/period, al = losses/period;
        for (let i = period+1; i < closes.length; i++) {
            const diff = closes[i] - closes[i-1];
            ag = (ag*(period-1) + Math.max(diff,0))/period;
            al = (al*(period-1) + Math.max(-diff,0))/period;
        }
        if (al === 0) return 100;
        return 100 - 100/(1 + ag/al);
    } catch (e) {
        return null;
    }
}

function calculateEMA(values, period) {
    try {
        if (!values || values.length < period) return null;
        const k = 2/(period+1);
        let ema = avg(values.slice(0, period));
        for (let i = period; i < values.length; i++) {
            ema = values[i]*k + ema*(1-k);
        }
        return ema;
    } catch (e) {
        return null;
    }
}

// ============================================================
// OPEN INTEREST VERİ YÖNETİMİ
// ============================================================
async function fetchAllOpenInterest() {
    try {
        const response = await bitgetHttp.get('/api/v2/mix/market/open-interest-all', {
            params: { productType: 'usdt-futures' }
        });
        
        if (response.data && response.data.code === '00000' && response.data.data) {
            return response.data.data;
        }
        
        console.error('OI API yanıtı beklenmeyen formatta:', response.data?.code, response.data?.msg);
        return [];
    } catch (e) {
        console.error('OI fetch hatası:', e.message);
        return [];
    }
}

function updateOIHistory(symbol, currentOI) {
    try {
        if (!STATE.oiHistory.has(symbol)) {
            STATE.oiHistory.set(symbol, []);
        }
        
        const history = STATE.oiHistory.get(symbol);
        const now = Date.now();
        
        history.push({ value: currentOI, timestamp: now });
        
        // Sadece son N dakikayı tut
        const cutoff = now - (CFG.OI_HISTORY_LIMIT * 60 * 1000);
        while (history.length > 0 && history[0].timestamp < cutoff) {
            history.shift();
        }
        
        // Previous OI'yi güncelle
        if (history.length >= 2) {
            STATE.oiPrevious.set(symbol, history[history.length - 2].value);
        }
        
        return history;
    } catch (e) {
        console.error('OI history güncelleme hatası:', e.message);
        return [];
    }
}

function calculateOIZScore(symbol, currentOI) {
    try {
        const history = updateOIHistory(symbol, currentOI);
        if (history.length < 5) return 0;
        
        const values = history.map(h => h.value);
        const mean = avg(values);
        const sd = stdDev(values);
        
        if (sd === 0) return 0;
        return (currentOI - mean) / sd;
    } catch (e) {
        return 0;
    }
}

function calculateOIChangePct(symbol) {
    try {
        const history = STATE.oiHistory.get(symbol);
        if (!history || history.length < 2) return 0;
        
        const first = history[0].value;
        const last = history[history.length - 1].value;
        
        if (first === 0) return 0;
        return ((last - first) / first) * 100;
    } catch (e) {
        return 0;
    }
}

function calculateOIChangeFromPrevious(symbol) {
    try {
        const history = STATE.oiHistory.get(symbol);
        if (!history || history.length < 2) return 0;
        
        const prev = history[history.length - 2].value;
        const current = history[history.length - 1].value;
        
        if (prev === 0) return 0;
        return ((current - prev) / prev) * 100;
    } catch (e) {
        return 0;
    }
}

// ============================================================
// CANDLE VERİ YÖNETİMİ
// ============================================================
async function getCandles(symbol, timeframe, limit) {
    const cacheKey = `${symbol}|${timeframe}|${limit}`;
    
    try {
        // Cache kontrolü
        const cached = candleCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CFG.CANDLE_CACHE_TTL) {
            return cached.data;
        }
        
        const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        const cleaned = Array.isArray(data) 
            ? data.filter(x => Array.isArray(x) && x.length >= 6).sort((a,b) => a[0]-b[0]) 
            : [];
        
        candleCache.set(cacheKey, { data: cleaned, timestamp: Date.now() });
        return cleaned;
    } catch (e) {
        // Cache'ten dön
        const cached = candleCache.get(cacheKey);
        if (cached) return cached.data;
        return [];
    }
}

// ============================================================
// TICKER VERİLERİ
// ============================================================
async function fetchAllTickers() {
    try {
        return await exchange.fetchTickers();
    } catch (e) {
        console.error('Ticker fetch hatası:', e.message);
        return {};
    }
}

// ============================================================
// 1. ADIM: TOPLU OI TARAMASI
// ============================================================
async function scanOIForCandidates() {
    console.log('\n📡 [1. ADIM] Toplu OI Taraması Başladı...');
    
    try {
        const allOI = await fetchAllOpenInterest();
        if (!allOI.length) {
            console.log('❌ OI verisi alınamadı');
            return [];
        }
        
        console.log(`✅ ${allOI.length} coin OI verisi alındı`);
        
        const tickers = await fetchAllTickers();
        const candidates = [];
        
        for (const oiItem of allOI) {
            try {
                const symbol = oiItem.symbol;
                if (!symbol || !symbol.endsWith('USDT')) continue;
                
                const ccxtSymbol = symbol + ':USDT';
                const ticker = tickers[ccxtSymbol];
                if (!ticker) continue;
                
                const volume = n(ticker.quoteVolume);
                if (volume < CFG.MIN_VOLUME_USDT) continue;
                
                const currentOI = n(oiItem.amount || oiItem.openInterest || 0);
                if (currentOI <= 0) continue;
                
                // OI metrikleri
                const oiZScore = calculateOIZScore(symbol, currentOI);
                const oiChangePct = calculateOIChangePct(symbol);
                const oiChangeFromPrev = calculateOIChangeFromPrevious(symbol);
                
                candidates.push({
                    symbol,
                    ccxtSymbol,
                    price: n(ticker.last),
                    volume,
                    volumeFormatted: formatVolume(volume),
                    currentOI,
                    oiZScore: n(oiZScore, 2),
                    oiChangePct: n(oiChangePct, 2),
                    oiChangeFromPrev: n(oiChangeFromPrev, 2),
                    change24h: n(ticker.percentage)
                });
            } catch (itemError) {
                // Tek coin hatası döngüyü kırmasın
                continue;
            }
        }
        
        // OI anomalisi olanları filtrele
        const anomalyCandidates = candidates
            .filter(c => 
                Math.abs(c.oiZScore) > CFG.OI_ZSCORE_THRESHOLD || 
                Math.abs(c.oiChangeFromPrev) > CFG.OI_CHANGE_THRESHOLD_PCT
            )
            .sort((a, b) => Math.abs(b.oiZScore) - Math.abs(a.oiZScore))
            .slice(0, 20);
        
        console.log(`🎯 OI Anomalisi Tespit Edilen Aday: ${anomalyCandidates.length}`);
        
        STATE.stats.oiScanned = candidates.length;
        STATE.stats.candidates = anomalyCandidates.length;
        
        return anomalyCandidates;
        
    } catch (e) {
        console.error('OI tarama hatası:', e.message);
        return [];
    }
}

// ============================================================
// 2. ADIM: 15M SIKIŞMA + HACİM ŞOKU ANALİZİ
// ============================================================
async function analyzeCandidate(candidate) {
    try {
        const candles = await getCandles(candidate.ccxtSymbol, '15m', CFG.CANDLE_LIMIT);
        if (candles.length < 50) return null;
        
        const closed = candles.slice(0, -1);
        const last = closed[closed.length - 1];
        const prev = closed[closed.length - 2];
        
        // ATR hesaplamaları
        const atr = calculateATR(closed, CFG.ATR_PERIOD);
        if (atr <= 0) return null;
        
        const recentATR = calculateATR(closed.slice(-10), CFG.ATR_PERIOD);
        const olderATR = calculateATR(closed.slice(-30, -10), CFG.ATR_PERIOD);
        const compressionRatio = olderATR > 0 ? recentATR / olderATR : 1;
        
        // Mevcut mum boyutu
        const candleRange = n(last[2]) - n(last[3]);
        const isBreakoutCandle = candleRange > atr * CFG.COMPRESSION_RATIO;
        
        // Hacim şoku
        const lastVolume = n(last[5]);
        const volHistory = closed.slice(-20, -1).map(x => n(x[5]));
        const avgVol = avg(volHistory);
        const volumeSurge = avgVol > 0 ? lastVolume / avgVol : 1;
        const hasVolumeShock = volumeSurge >= CFG.MIN_VOLUME_SURGE;
        
        // Fiyat hareketi
        const lastOpen = n(last[1]);
        const lastClose = n(last[4]);
        const lastHigh = n(last[2]);
        const lastLow = n(last[3]);
        const prevClose = n(prev[4]);
        
        const body = Math.abs(lastClose - lastOpen);
        const range = lastHigh - lastLow;
        const bodyRatio = range > 0 ? body / range : 0;
        const movePercent = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
        
        // İndikatörler
        const closes = closed.map(x => n(x[4]));
        const rsi = calculateRSI(closes, CFG.ATR_PERIOD);
        const emaFast = calculateEMA(closes, 9);
        const emaSlow = calculateEMA(closes, 21);
        
        if (rsi === null || emaFast === null || emaSlow === null) return null;
        
        // OI davranışı
        const oiChangeFromPrev = candidate.oiChangeFromPrev;
        const oiZScore = candidate.oiZScore;
        
        // ============================================
        // A, B, C, D SENARYO MATRİSİ
        // ============================================
        let signal = null;
        
        // --- LONG SENARYOLARI ---
        const isLongPriceAction = lastClose > lastOpen && lastClose > prevClose;
        
        if (isLongPriceAction && hasVolumeShock && isBreakoutCandle) {
            // A) Short Squeeze: Fiyat ↑ + Hacim ↑ + OI ↓
            const isShortSqueeze = oiChangeFromPrev < -CFG.OI_CHANGE_THRESHOLD_PCT;
            
            // B) Expansion LONG: Fiyat ↑ + Hacim ↑ + OI ↑
            const isExpansionLong = oiChangeFromPrev > CFG.OI_CHANGE_THRESHOLD_PCT && oiZScore > 0;
            
            if (isShortSqueeze || isExpansionLong) {
                const entry = lastClose;
                const stop = lastLow - (atr * CFG.SL_ATR_MULT);
                const tp1 = entry + (atr * CFG.TP1_ATR_MULT);
                const tp2 = entry + (atr * CFG.TP2_ATR_MULT);
                
                const risk = entry - stop;
                if (risk > 0) {
                    const scenario = isShortSqueeze ? 'A-SHORT_SQUEEZE' : 'B-EXPANSION_LONG';
                    
                    signal = {
                        direction: 'LONG',
                        scenario,
                        entry, stop, tp1, tp2,
                        rsi: n(rsi, 1),
                        volumeSurge: n(volumeSurge, 1),
                        compressionRatio: n(compressionRatio, 2),
                        movePercent: n(movePercent, 2),
                        bodyRatio: n(bodyRatio, 2),
                        atr: n(atr),
                        risk: n(risk),
                        rr1: n((tp1-entry)/risk, 1),
                        rr2: n((tp2-entry)/risk, 1),
                        oiZScore,
                        oiChangeFromPrev,
                        score: Math.min(95, Math.round(
                            50 + 
                            volumeSurge * 8 + 
                            (isShortSqueeze ? 25 : 20) + 
                            (compressionRatio < 0.7 ? 10 : 0)
                        ))
                    };
                }
            }
        }
        
        // --- SHORT SENARYOLARI ---
        const isShortPriceAction = lastClose < lastOpen && lastClose < prevClose;
        
        if (!signal && isShortPriceAction && hasVolumeShock && isBreakoutCandle) {
            // C) Long Squeeze: Fiyat ↓ + Hacim ↑ + OI ↓
            const isLongSqueeze = oiChangeFromPrev < -CFG.OI_CHANGE_THRESHOLD_PCT;
            
            // D) Expansion SHORT: Fiyat ↓ + Hacim ↑ + OI ↑
            const isExpansionShort = oiChangeFromPrev > CFG.OI_CHANGE_THRESHOLD_PCT && oiZScore < 0;
            
            if (isLongSqueeze || isExpansionShort) {
                const entry = lastClose;
                const stop = lastHigh + (atr * CFG.SL_ATR_MULT);
                const tp1 = entry - (atr * CFG.TP1_ATR_MULT);
                const tp2 = entry - (atr * CFG.TP2_ATR_MULT);
                
                const risk = stop - entry;
                if (risk > 0) {
                    const scenario = isLongSqueeze ? 'C-LONG_SQUEEZE' : 'D-EXPANSION_SHORT';
                    
                    signal = {
                        direction: 'SHORT',
                        scenario,
                        entry, stop, tp1, tp2,
                        rsi: n(rsi, 1),
                        volumeSurge: n(volumeSurge, 1),
                        compressionRatio: n(compressionRatio, 2),
                        movePercent: n(movePercent, 2),
                        bodyRatio: n(bodyRatio, 2),
                        atr: n(atr),
                        risk: n(risk),
                        rr1: n((entry-tp1)/risk, 1),
                        rr2: n((entry-tp2)/risk, 1),
                        oiZScore,
                        oiChangeFromPrev,
                        score: Math.min(95, Math.round(
                            50 + 
                            volumeSurge * 8 + 
                            (isLongSqueeze ? 25 : 20) + 
                            (compressionRatio < 0.7 ? 10 : 0)
                        ))
                    };
                }
            }
        }
        
        return signal;
        
    } catch (e) {
        console.error(`Analiz hatası (${candidate.symbol}):`, e.message);
        return null;
    }
}

// ============================================================
// 3. ADIM: SİNYAL ÜRETİMİ
// ============================================================
function generateSignal(candidate, sig) {
    try {
        const now = Date.now();
        
        const signalObj = {
            id: `${candidate.symbol}-${sig.direction}-${now}`,
            symbol: candidate.symbol,
            marketSymbol: candidate.ccxtSymbol,
            direction: sig.direction,
            scenario: sig.scenario,
            
            // Fiyat seviyeleri
            entry: sig.entry,
            entryPrice: fmtPrice(sig.entry),
            stop: sig.stop,
            stopPrice: fmtPrice(sig.stop),
            tp1: sig.tp1,
            tp1Price: fmtPrice(sig.tp1),
            tp2: sig.tp2,
            tp2Price: fmtPrice(sig.tp2),
            
            // Metrikler
            rsi: sig.rsi,
            volumeSurge: sig.volumeSurge,
            compressionRatio: sig.compressionRatio,
            movePercent: sig.movePercent,
            bodyRatio: sig.bodyRatio,
            atr: sig.atr,
            risk: sig.risk,
            rr1: sig.rr1,
            rr2: sig.rr2,
            oiZScore: sig.oiZScore,
            oiChangeFromPrev: sig.oiChangeFromPrev,
            score: sig.score,
            
            // Piyasa verisi
            currentPrice: candidate.price,
            volumeFormatted: candidate.volumeFormatted,
            change24h: candidate.change24h,
            
            // Zaman damgası
            timestamp: now,
            signalAt: now,
            time: new Date().toLocaleTimeString('tr-TR'),
            ageDisplay: '0 sn',
            ageMin: 0,
            remainingDisplay: '15:00',
            
            // Durum
            distancePct: 0,
            status: '🟢 FRESH',
            statusClass: 'status-fresh',
            cardState: 'FRESH',
            
            // MFE/MAE takibi
            maxFavorablePct: 0,
            maxAdversePct: 0
        };
        
        return signalObj;
    } catch (e) {
        console.error('Sinyal üretim hatası:', e.message);
        return null;
    }
}

// ============================================================
// ANA TARAMA DÖNGÜSÜ
// ============================================================
async function runScan() {
    if (STATE.scanning) return;
    STATE.scanning = true;
    
    try {
        // Eski sinyalleri temizle
        cleanupExpiredSignals();
        
        // 1. ADIM: OI Taraması
        const candidates = await scanOIForCandidates();
        
        // 2. ADIM: Adayları analiz et
        for (const candidate of candidates) {
            try {
                // Cooldown kontrolü
                const cooldownTime = STATE.cooldowns.get(candidate.symbol);
                if (cooldownTime && Date.now() - cooldownTime < CFG.SIGNAL_COOLDOWN_MS) continue;
                
                // Aktif sinyal kontrolü
                const existing = [...STATE.signals.values()].find(s => s.symbol === candidate.symbol);
                if (existing) continue;
                
                // Sinyal limiti
                if (STATE.signals.size >= CFG.MAX_ACTIVE_SIGNALS) break;
                
                const sig = await analyzeCandidate(candidate);
                
                if (sig && sig.score >= 60) {
                    const signalObj = generateSignal(candidate, sig);
                    
                    if (signalObj) {
                        STATE.signals.set(signalObj.id, signalObj);
                        STATE.mfeMaeTracking.set(signalObj.id, {
                            maxProfitPct: 0,
                            maxLossPct: 0
                        });
                        
                        if (sig.direction === 'LONG') STATE.stats.longSignals++;
                        else STATE.stats.shortSignals++;
                        
                        STATE.stats.totalSignalsProduced++;
                        
                        console.log(`✅ ${candidate.symbol} ${sig.direction} | Senaryo: ${sig.scenario} | Skor: ${signalObj.score} | Hacim: ${sig.volumeSurge}x | OI Δ: %${sig.oiChangeFromPrev} | Giriş: ${signalObj.entryPrice}`);
                    }
                }
                
                await sleep(20);
            } catch (itemError) {
                console.error(`Aday analiz hatası (${candidate.symbol}):`, itemError.message);
                continue;
            }
        }
        
        STATE.lastOIScan = Date.now();
        STATE.stats.signals = STATE.signals.size;
        
        // Performans güncelle
        updatePerformanceStats();
        
        broadcast();
        
    } catch (e) {
        STATE.lastError = e.message;
        console.error('SCAN ERROR:', e.message);
    } finally {
        STATE.scanning = false;
    }
}

// ============================================================
// SİNYAL DURUM GÜNCELLEME (MFE/MAE Takibi)
// ============================================================
async function updateSignalStatus() {
    if (!STATE.signals.size) return;
    
    try {
        const tickers = await fetchAllTickers();
        const now = Date.now();
        
        for (const [id, signal] of STATE.signals) {
            try {
                const age = now - signal.timestamp;
                
                // TTL kontrolü
                if (age > CFG.SIGNAL_TTL_MS) {
                    STATE.signals.delete(id);
                    STATE.cooldowns.set(signal.symbol, now);
                    STATE.performance.timeouts++;
                    continue;
                }
                
                // Yaş güncelle
                const ageMin = Math.floor(age / 60000);
                const ageSec = Math.floor((age % 60000) / 1000);
                signal.ageMin = ageMin;
                signal.ageDisplay = ageMin > 0 ? `${ageMin}:${ageSec < 10 ? '0' : ''}${ageSec}` : `${ageSec} sn`;
                
                // Kalan süre
                const remaining = CFG.SIGNAL_TTL_MS - age;
                const remMin = Math.floor(remaining / 60000);
                const remSec = Math.floor((remaining % 60000) / 1000);
                signal.remainingDisplay = `${remMin}:${remSec < 10 ? '0' : ''}${remSec}`;
                
                // Fiyat güncelle
                const ticker = tickers[signal.marketSymbol];
                if (!ticker) continue;
                const current = n(ticker.last);
                signal.currentPrice = current;
                
                // Fiyat sapması
                const distancePct = Math.abs(((current - signal.entry) / signal.entry) * 100);
                signal.distancePct = n(distancePct, 3);
                
                // MFE/MAE takibi
                const tracking = STATE.mfeMaeTracking.get(id);
                if (tracking) {
                    if (signal.direction === 'LONG') {
                        const profitPct = ((current - signal.entry) / signal.entry) * 100;
                        const lossPct = ((signal.entry - current) / signal.entry) * 100;
                        
                        if (profitPct > tracking.maxProfitPct) tracking.maxProfitPct = profitPct;
                        if (lossPct > tracking.maxLossPct) tracking.maxLossPct = lossPct;
                    } else {
                        const profitPct = ((signal.entry - current) / signal.entry) * 100;
                        const lossPct = ((current - signal.entry) / signal.entry) * 100;
                        
                        if (profitPct > tracking.maxProfitPct) tracking.maxProfitPct = profitPct;
                        if (lossPct > tracking.maxLossPct) tracking.maxLossPct = lossPct;
                    }
                    
                    signal.maxFavorablePct = n(tracking.maxProfitPct, 3);
                    signal.maxAdversePct = n(tracking.maxLossPct, 3);
                }
                
                // Kart durumu belirle
                if (age <= CFG.FRESH_AGE_MS && distancePct <= CFG.FRESH_DISTANCE_PCT) {
                    signal.cardState = 'FRESH';
                    signal.status = '🟢 FRESH';
                    signal.statusClass = 'status-fresh';
                } else if (distancePct <= CFG.VALID_DISTANCE_PCT) {
                    signal.cardState = 'VALID';
                    signal.status = '🟡 VALID - LATE';
                    signal.statusClass = 'status-warning';
                } else {
                    signal.cardState = 'MISSED';
                    signal.status = '🔴 MISSED / EXTENDED';
                    signal.statusClass = 'status-missed';
                }
                
                // TP/SL kontrolü
                if (signal.direction === 'LONG') {
                    if (current <= signal.stop) {
                        signal.status = '🛑 STOP';
                        signal.statusClass = 'status-stop';
                        signal.cardState = 'CLOSED';
                    } else if (current >= signal.tp2) {
                        signal.status = '✅ TP2 HEDEF';
                        signal.statusClass = 'status-tp';
                        signal.cardState = 'CLOSED';
                    } else if (current >= signal.tp1) {
                        signal.status = '✅ TP1 HEDEF';
                        signal.statusClass = 'status-tp';
                        signal.cardState = 'CLOSED';
                    }
                } else {
                    if (current >= signal.stop) {
                        signal.status = '🛑 STOP';
                        signal.statusClass = 'status-stop';
                        signal.cardState = 'CLOSED';
                    } else if (current <= signal.tp2) {
                        signal.status = '✅ TP2 HEDEF';
                        signal.statusClass = 'status-tp';
                        signal.cardState = 'CLOSED';
                    } else if (current <= signal.tp1) {
                        signal.status = '✅ TP1 HEDEF';
                        signal.statusClass = 'status-tp';
                        signal.cardState = 'CLOSED';
                    }
                }
            } catch (signalError) {
                continue;
            }
        }
        
        STATE.stats.signals = STATE.signals.size;
        broadcast();
        
    } catch (e) {
        // Sessiz hata
    }
}

// ============================================================
// PERFORMANS İSTATİSTİKLERİ
// ============================================================
function updatePerformanceStats() {
    try {
        const allMFE = [];
        const allMAE = [];
        
        for (const tracking of STATE.mfeMaeTracking.values()) {
            if (tracking.maxProfitPct > 0) allMFE.push(tracking.maxProfitPct);
            if (tracking.maxLossPct > 0) allMAE.push(tracking.maxLossPct);
        }
        
        if (allMFE.length) STATE.performance.avgMFE = n(avg(allMFE), 3);
        if (allMAE.length) STATE.performance.avgMAE = n(avg(allMAE), 3);
        
        const total = STATE.performance.wins + STATE.performance.losses;
        STATE.performance.winRate = total ? (STATE.performance.wins / total) * 100 : 0;
    } catch (e) {
        // Sessiz
    }
}

function cleanupExpiredSignals() {
    try {
        const now = Date.now();
        for (const [id, signal] of STATE.signals) {
            if (now - signal.timestamp > CFG.SIGNAL_TTL_MS) {
                STATE.signals.delete(id);
                STATE.cooldowns.set(signal.symbol, now);
                STATE.performance.timeouts++;
            }
        }
    } catch (e) {
        // Sessiz
    }
}

// ============================================================
// WEBSOCKET BROADCAST
// ============================================================
function broadcast() {
    try {
        const payload = JSON.stringify({
            type: 'snapshot',
            data: {
                signals: [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp),
                stats: STATE.stats,
                performance: STATE.performance,
                lastOIScan: STATE.lastOIScan,
                error: STATE.lastError
            }
        });
        
        for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(payload); } catch (e) {}
            }
        }
    } catch (e) {
        // Sessiz
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
                lastOIScan: STATE.lastOIScan,
                error: STATE.lastError
            }
        }));
    } catch (e) {}
});

// ============================================================
// API ROUTES
// ============================================================
app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        signals: [...STATE.signals.values()].sort((a, b) => b.timestamp - a.timestamp),
        stats: STATE.stats,
        performance: STATE.performance,
        lastOIScan: STATE.lastOIScan,
        error: STATE.lastError
    });
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
.brand-sub{font-size:10px;color:#718096;margin-top:2px;}
.stats{display:flex;gap:10px;flex-wrap:wrap;}
.stat{text-align:center;background:#101826;border:1px solid #1b2939;padding:8px 12px;border-radius:8px;}
.stat b{display:block;font-size:20px;color:#13dba0;font-weight:900;}
.stat span{color:#64748b;font-size:8px;text-transform:uppercase;letter-spacing:0.5px;}
.content{padding:20px;height:calc(100vh - 80px);overflow-y:auto;}
.signal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:15px;}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:14px;padding:18px;transition:all 0.3s;position:relative;overflow:hidden;}
.signal-card.long{border-left:5px solid #13dba0;}
.signal-card.short{border-left:5px solid #ff5570;}
.signal-card.fresh{box-shadow:0 0 25px rgba(19,219,160,0.2);animation:glow 2s infinite;}
.signal-card.valid{opacity:0.85;}
.signal-card.missed{opacity:0.4;filter:grayscale(60%);pointer-events:none;}
.signal-card.closed{opacity:0.6;}
@keyframes glow{0%,100%{box-shadow:0 0 25px rgba(19,219,160,0.2);}50%{box-shadow:0 0 40px rgba(19,219,160,0.4);}}
.signal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.signal-coin{font-size:18px;font-weight:900;color:#e2e8f0;}
.signal-badge{font-size:10px;padding:5px 14px;border-radius:20px;font-weight:900;letter-spacing:1px;}
.badge-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.badge-short{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.scenario-badge{font-size:8px;padding:3px 8px;border-radius:4px;background:#1e293b;color:#94a3b8;margin-top:4px;display:inline-block;}
.signal-time-bar{display:flex;gap:12px;margin-bottom:10px;font-size:10px;color:#94a3b8;flex-wrap:wrap;}
.signal-time-bar .age{color:#fbbf24;font-weight:bold;}
.signal-time-bar .remaining{color:#60a5fa;font-weight:bold;}
.signal-price{font-size:24px;font-weight:900;margin:8px 0;color:#f1f5f9;}
.levels{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;}
.level{background:#0b111b;border:1px solid #1b2938;border-radius:8px;padding:10px;}
.level span{display:block;color:#64748b;font-size:8px;margin-bottom:3px;text-transform:uppercase;}
.level b{font-size:14px;font-weight:bold;}
.level.entry b{color:#13dba0;}
.level.stop b{color:#ff5570;}
.level.tp b{color:#55a7ff;}
.signal-stats{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.signal-stat{background:#0b111b;border:1px solid #1b2938;border-radius:6px;padding:6px 10px;font-size:9px;color:#94a3b8;}
.signal-stat b{color:#e2e8f0;font-weight:bold;}
.mfe-mae{display:flex;gap:8px;margin-top:8px;}
.mfe{color:#13dba0;font-size:9px;font-weight:bold;}
.mae{color:#ff5570;font-size:9px;font-weight:bold;}
.signal-status{margin-top:12px;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:bold;text-align:center;}
.status-fresh{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0;}
.status-warning{background:#3d2d0d;color:#fbbf24;border:1px solid #fbbf24;}
.status-missed{background:#2d1d1d;color:#ff5570;border:1px solid #ff5570;}
.status-stop{background:#421d28;color:#ff5570;border:1px solid #ff5570;}
.status-tp{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee;}
.empty{text-align:center;color:#64748b;font-size:14px;padding:60px 20px;}
.flow-score{background:#0b111b;border:1px solid #fbbf24;border-radius:8px;padding:6px 10px;font-size:10px;color:#fbbf24;font-weight:bold;display:inline-block;}
@media(max-width:600px){.signal-grid{grid-template-columns:1fr;}.stats{display:none;}}
</style>
</head>
<body>
<div class="header">
<div>
<div class="brand">🔥 FLOW IGNITION V1</div>
<div class="brand-sub">Kurumsal Pozisyonlanma + Likidite Akışı • 15M Scalping</div>
</div>
<div class="stats">
<div class="stat"><b id="st-oi">0</b><span>OI Tarandı</span></div>
<div class="stat"><b id="st-cand">0</b><span>Aday</span></div>
<div class="stat"><b id="st-sig">0</b><span>Aktif</span></div>
<div class="stat"><b id="st-mfe">0</b><span>Ort MFE</span></div>
</div>
</div>
<div class="content">
<div class="signal-grid" id="signals">
<div class="empty">⏳ OI verisi taranıyor... İlk sinyaller 1-2 dakika içinde gelecek.</div>
</div>
</div>
<script>
var _signals = [];

function fmtPrice(v){ var x=Number(v); if(!Number.isFinite(x)) return '-'; if(x>=1000) return x.toFixed(2); if(x>=100) return x.toFixed(3); if(x>=1) return x.toFixed(5); if(x>=0.01) return x.toFixed(7); return x.toFixed(8); }

function render(data){
    var st = data.stats || {};
    document.getElementById('st-oi').textContent = st.oiScanned || 0;
    document.getElementById('st-cand').textContent = st.candidates || 0;
    document.getElementById('st-sig').textContent = st.signals || 0;
    
    var perf = data.performance || {};
    document.getElementById('st-mfe').textContent = '%' + (perf.avgMFE || 0).toFixed(2);
    
    _signals = data.signals || [];
    var container = document.getElementById('signals');
    
    if(!_signals.length){
        container.innerHTML = '<div class="empty">⏳ Aktif sinyal yok. Sistem OI verisini tarıyor...</div>';
        return;
    }
    
    container.innerHTML = _signals.map(function(s){
        var isLong = s.direction === 'LONG';
        var badgeClass = isLong ? 'badge-long' : 'badge-short';
        var cardClass = s.cardState === 'FRESH' ? 'fresh' : s.cardState === 'VALID' ? 'valid' : s.cardState === 'MISSED' ? 'missed' : 'closed';
        
        return '<div class="signal-card ' + (isLong ? 'long' : 'short') + ' ' + cardClass + '">' +
            '<div class="signal-head">' +
                '<div class="signal-coin">' + s.symbol + '</div>' +
                '<div class="signal-badge ' + badgeClass + '">' + s.direction + '</div>' +
            '</div>' +
            '<div class="scenario-badge">' + s.scenario + '</div>' +
            '<div class="signal-time-bar">' +
                '<span>🕐 <b>' + s.time + '</b></span>' +
                '<span>⏰ <b class="age">' + s.ageDisplay + '</b></span>' +
                '<span>⏳ <b class="remaining">' + s.remainingDisplay + '</b></span>' +
                '<span>📏 %' + s.distancePct + '</span>' +
            '</div>' +
            '<div class="flow-score">⚡ Flow Score: ' + s.score + '/100 | OI Δ: %' + s.oiChangeFromPrev + '</div>' +
            '<div class="signal-price">' + fmtPrice(s.currentPrice || s.entry) + '</div>' +
            '<div class="levels">' +
                '<div class="level entry"><span>GİRİŞ</span><b>' + s.entryPrice + '</b></div>' +
                '<div class="level stop"><span>STOP</span><b>' + s.stopPrice + '</b></div>' +
                '<div class="level tp"><span>TP1 (' + s.rr1 + 'R)</span><b>' + s.tp1Price + '</b></div>' +
                '<div class="level tp"><span>TP2 (' + s.rr2 + 'R)</span><b>' + s.tp2Price + '</b></div>' +
            '</div>' +
            '<div class="signal-stats">' +
                '<div class="signal-stat">Hacim: <b>' + s.volumeSurge + 'x</b></div>' +
                '<div class="signal-stat">Sıkışma: <b>' + s.compressionRatio + '</b></div>' +
                '<div class="signal-stat">RSI: <b>' + s.rsi + '</b></div>' +
                '<div class="signal-stat">Hareket: <b>%' + s.movePercent + '</b></div>' +
            '</div>' +
            '<div class="mfe-mae">' +
                '<span class="mfe">📈 MFE: %' + (s.maxFavorablePct || 0).toFixed(3) + '</span>' +
                '<span class="mae">📉 MAE: %' + (s.maxAdversePct || 0).toFixed(3) + '</span>' +
            '</div>' +
            '<div class="signal-status ' + s.statusClass + '">' + (s.status || 'AKTİF') + '</div>' +
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
}, 2000);

fetch('/api/status', {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(render)
    .catch(function(){});
</script>
</body>
</html>`;

// ============================================================
// SERVER BAŞLATMA
// ============================================================
app.get('/', (req, res) => res.type('html').send(HTML));

process.on('unhandledRejection', e => { 
    console.error('UNHANDLED REJECTION:', e?.message || e); 
});

process.on('uncaughtException', e => { 
    console.error('UNCAUGHT EXCEPTION:', e?.message || e); 
});

server.on('error', err => {
    console.error('SERVER BIND ERROR:', err.message);
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log('==============================================');
    console.log('🔥 FLOW IGNITION V1 BAŞLATILIYOR');
    console.log('📊 Kurumsal Pozisyonlanma + Likidite Akışı');
    console.log('⏰ Sinyal TTL: 15 dakika');
    console.log('🔄 OI Tarama: 1 dakikada bir');
    console.log('==============================================');
    
    try {
        await exchange.loadMarkets(true);
        console.log('✅ MARKETLER YÜKLENDİ | ' + Object.keys(exchange.markets).length + ' coin');
    } catch (e) {
        console.error('❌ MARKET YÜKLEME HATASI:', e.message);
    }
    
    // İlk tarama
    setTimeout(() => { 
        runScan().catch(e => console.error('İLK SCAN HATASI:', e.message)); 
    }, 3000);
    
    // Periyodik döngüler
    setInterval(() => { 
        if (!STATE.scanning) runScan().catch(e => console.error('SCAN HATASI:', e.message)); 
    }, CFG.OI_SCAN_INTERVAL_MS);
    
    setInterval(() => { 
        updateSignalStatus().catch(e => {}); 
    }, CFG.SIGNAL_UPDATE_MS);
    
    console.log('✅ SİSTEM HAZIR');
});
