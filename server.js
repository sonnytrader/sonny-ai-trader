'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

const CFG = {
    SCAN_INTERVAL_MS: 30 * 1000,
    LIVE_UPDATE_INTERVAL_MS: 3 * 1000,
    TIMEFRAME: '5m',
    CANDLE_LIMIT: 100,

    MIN_VOLUME_USDT: 5_000_000,
    MAX_CANDIDATES: 30,
    MAX_SETUPS: 8,

    BOX_CANDLES: 12,
    ATR_PERIOD: 14,
    COMPRESSION_RATIO_MAX: 0.90,
    MAX_BOX_WIDTH_PCT: 1.50,
    WATCH_DISTANCE_PCT: 0.35,
    BREAKOUT_BUFFER_PCT: 0.03,

    MIN_VOLUME_RATIO: 0.50,
    MIN_OI_CHANGE_PCT: 0.05,
    
    WATCH_SCORE_MIN: 65,
    WATCH_TTL_MS: 20 * 60 * 1000,
    FIRED_TTL_MS: 10 * 60 * 1000,
    FINISHED_RETENTION_MS: 2 * 60 * 1000,

    OI_HISTORY_MS: 5 * 60 * 1000,
    OI_LOOKBACK_MS: 3 * 60 * 1000,
    OI_QUERY_DELAY_MS: 100,

    STOP_ATR_BUFFER: 0.25,
    TP1_R: 1.20,
    TP2_R: 2.00
};

// DEBUG SAYAÇLARI
const DEBUG = {
    totalTickers: 0,
    volumeFiltered: 0,
    candidatesAnalyzed: 0,
    candleFailed: 0,
    boxTooWide: 0,
    notCompressed: 0,
    volumeTooLow: 0,
    oiTooLow: 0,
    noDirection: 0,
    scoreTooLow: 0,
    setupCreated: 0,
    duplicateSkipped: 0
};

function resetDebug() {
    DEBUG.totalTickers = 0;
    DEBUG.volumeFiltered = 0;
    DEBUG.candidatesAnalyzed = 0;
    DEBUG.candleFailed = 0;
    DEBUG.boxTooWide = 0;
    DEBUG.notCompressed = 0;
    DEBUG.volumeTooLow = 0;
    DEBUG.oiTooLow = 0;
    DEBUG.noDirection = 0;
    DEBUG.scoreTooLow = 0;
    DEBUG.setupCreated = 0;
    DEBUG.duplicateSkipped = 0;
}

function printDebugReport() {
    console.log('\n========== 📊 TARAMA RAPORU ==========');
    console.log('Toplam Ticker:', DEBUG.totalTickers);
    console.log('Hacim Filtresi Geçen:', DEBUG.volumeFiltered);
    console.log('Analiz Edilen:', DEBUG.candidatesAnalyzed);
    console.log('--- ELENME NEDENLERİ ---');
    console.log('Mum Verisi Yetersiz:', DEBUG.candleFailed);
    console.log('Box Çok Geniş:', DEBUG.boxTooWide);
    console.log('Sıkışma Yok:', DEBUG.notCompressed);
    console.log('Hacim Düşük:', DEBUG.volumeTooLow);
    console.log('OI Değişimi Düşük:', DEBUG.oiTooLow);
    console.log('Yön Belirsiz:', DEBUG.noDirection);
    console.log('Skor Düşük:', DEBUG.scoreTooLow);
    console.log('--- SONUÇ ---');
    console.log('Setup Oluşturulan:', DEBUG.setupCreated);
    console.log('Duplicate (zaten var):', DEBUG.duplicateSkipped);
    console.log('======================================\n');
}

const exchange = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: { defaultType: 'swap' }
});

let setups = [];
let isScanning = false;
let isUpdatingPrices = false;
let isShuttingDown = false;
let scanTimer;
let liveTimer;

const oiHistory = new Map();
const recentWarnings = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
    });
    next();
});

function number(value, decimals = 8) {
    const result = Number(value);
    return Number.isFinite(result) ? Number(result.toFixed(decimals)) : 0;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function warnOnce(key, error, cooldownMs = 60 * 1000) {
    const now = Date.now();
    if (now - (recentWarnings.get(key) || 0) < cooldownMs) return;
    recentWarnings.set(key, now);
    console.warn('[' + new Date(now).toISOString() + '] ' + key + ': ' + error.message);
}

function formatPrice(value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return '-';
    if (price >= 1000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(3);
    if (price >= 1) return price.toFixed(5);
    if (price >= 0.01) return price.toFixed(7);
    return price.toFixed(8);
}

function percentDistance(from, to) {
    if (!from) return 100;
    return Math.abs(to - from) / from * 100;
}

function calculateATR(candles, period = CFG.ATR_PERIOD) {
    if (candles.length < period + 1) return null;
    const trueRanges = [];
    for (let index = 1; index < candles.length; index++) {
        const high = Number(candles[index][2]);
        const low = Number(candles[index][3]);
        const previousClose = Number(candles[index - 1][4]);
        trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
    }
    return average(trueRanges.slice(-period));
}

function calculateEMA(values, period) {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = average(values.slice(0, period));
    for (let index = period; index < values.length; index++) {
        ema = (values[index] - ema) * multiplier + ema;
    }
    return ema;
}

function calculateVolumeRatio(candles, timeframeMs) {
    if (candles.length < 22) return 0;
    const current = candles[candles.length - 1];
    const previous = candles.slice(-21, -1);
    const averageVolume = average(previous.map(candle => Number(candle[5])));
    if (!averageVolume) return 0;
    const elapsed = Date.now() - Number(current[0]);
    const progress = elapsed < timeframeMs ? Math.max(0.25, Math.min(1, elapsed / timeframeMs)) : 1;
    return Number(current[5]) / progress / averageVolume;
}

function getSnapshot() {
    const active = setups.filter(setup => setup.state === 'WATCH' || setup.state === 'FIRE');
    return {
        setups,
        stats: {
            total: active.length,
            watch: active.filter(setup => setup.state === 'WATCH').length,
            fire: active.filter(setup => setup.state === 'FIRE').length
        },
        scanning: isScanning,
        updatedAt: Date.now()
    };
}

function broadcast() {
    const payload = JSON.stringify({ type: 'snapshot', data: getSnapshot() });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch {}
        }
    });
}

async function getCandles(symbol, timeframe, limit) {
    try {
        const tf = timeframe || CFG.TIMEFRAME;
        const lim = limit || CFG.CANDLE_LIMIT;
        const candles = await exchange.fetchOHLCV(symbol, tf, undefined, lim);
        return Array.isArray(candles)
            ? candles.filter(candle => Array.isArray(candle) && candle.length >= 6).sort((left, right) => left[0] - right[0])
            : [];
    } catch (error) {
        warnOnce('Mum verisi alınamadı (' + symbol + ')', error);
        return [];
    }
}

async function getOpenInterest(symbol) {
    try {
        const result = await exchange.fetchOpenInterest(symbol);
        const value = Number(result?.openInterestAmount || result?.openInterest || result?.amount || 0);
        if (Number.isFinite(value) && value > 0) return value;
    } catch (error) {
        warnOnce('CCXT OI sorgusu başarısız', error);
    }
    try {
        const marketSymbol = symbol.replace(':USDT', '').replace('/', '').replace('USDT', '') + 'USDT';
        const url = 'https://api.bitget.com/api/v2/mix/market/open-interest?symbol=' + encodeURIComponent(marketSymbol) + '&productType=usdt-futures';
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return 0;
        const data = await response.json();
        const item = data?.data?.openInterestList?.[0];
        const value = Number(item?.size || 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
        warnOnce('Bitget OI yedek sorgusu başarısız', error);
        return 0;
    }
}

function updateOIHistory(symbol, value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const now = Date.now();
    const history = oiHistory.get(symbol) || [];
    history.push({ value, timestamp: now });
    const retained = history.filter(item => now - item.timestamp <= CFG.OI_HISTORY_MS);
    oiHistory.set(symbol, retained);
    const reference = retained.filter(item => now - item.timestamp >= CFG.OI_LOOKBACK_MS).at(-1);
    if (!reference?.value) return 0;
    return number(((value - reference.value) / reference.value) * 100, 2);
}

function cleanOIHistory() {
    const cutoff = Date.now() - CFG.OI_HISTORY_MS;
    for (const [symbol, history] of oiHistory.entries()) {
        const retained = history.filter(item => item.timestamp >= cutoff);
        if (retained.length) oiHistory.set(symbol, retained);
        else oiHistory.delete(symbol);
    }
}

function buildSetup(direction, symbol, price, data) {
    const isLong = direction === 'LONG';
    const trigger = isLong ? data.boxHigh * (1 + CFG.BREAKOUT_BUFFER_PCT / 100) : data.boxLow * (1 - CFG.BREAKOUT_BUFFER_PCT / 100);
    const stop = isLong ? data.boxLow - data.atr * CFG.STOP_ATR_BUFFER : data.boxHigh + data.atr * CFG.STOP_ATR_BUFFER;
    const risk = Math.abs(trigger - stop);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const tp1 = isLong ? trigger + risk * CFG.TP1_R : trigger - risk * CFG.TP1_R;
    const tp2 = isLong ? trigger + risk * CFG.TP2_R : trigger - risk * CFG.TP2_R;

    return {
        id: symbol + ':' + direction,
        symbol,
        direction,
        state: 'WATCH',
        currentPrice: price,
        trigger,
        stop,
        tp1,
        tp2,
        boxHigh: data.boxHigh,
        boxLow: data.boxLow,
        boxWidthPct: number(data.boxWidthPct, 2),
        compressionRatio: number(data.compressionRatio, 2),
        volumeRatio: number(data.volumeRatio, 2),
        oiChangePct: data.oiChangePct,
        score: data.score,
        reason: data.reason,
        strengthLabel: data.strengthLabel,
        strengthClass: data.strengthClass,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    };
}

async function analyzeCandidate(candidate) {
    DEBUG.candidatesAnalyzed++;
    
    const candles = await getCandles(candidate.symbol);
    if (candles.length < 70) {
        DEBUG.candleFailed++;
        return [];
    }
    
    const closed = candles.slice(0, -1);
    const currentPrice = number(candidate.ticker.last);
    if (!currentPrice || closed.length < 60) {
        DEBUG.candleFailed++;
        return [];
    }

    const box = closed.slice(-CFG.BOX_CANDLES);
    const boxHigh = Math.max(...box.map(candle => Number(candle[2])));
    const boxLow = Math.min(...box.map(candle => Number(candle[3])));
    const boxWidthPct = (boxHigh - boxLow) / boxHigh * 100;
    
    if (boxWidthPct > CFG.MAX_BOX_WIDTH_PCT) {
        DEBUG.boxTooWide++;
        return [];
    }

    const recentATR = calculateATR(closed.slice(-20));
    const olderATR = calculateATR(closed.slice(-40, -20));
    if (!recentATR || !olderATR || olderATR <= 0) {
        DEBUG.candleFailed++;
        return [];
    }
    
    const compressionRatio = recentATR / olderATR;
    if (compressionRatio > CFG.COMPRESSION_RATIO_MAX) {
        DEBUG.notCompressed++;
        return [];
    }

    const closes = closed.map(candle => Number(candle[4]));
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const volumeRatio = calculateVolumeRatio(candles, 5 * 60 * 1000);

    if (volumeRatio < CFG.MIN_VOLUME_RATIO) {
        DEBUG.volumeTooLow++;
        return [];
    }

    const longDistance = (boxHigh - currentPrice) / boxHigh * 100;
    const shortDistance = (currentPrice - boxLow) / boxLow * 100;

    const candidates = [];
    if (longDistance >= 0 && longDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'LONG', distancePct: longDistance, trendAligned: ema20 > ema50 });
    }
    if (shortDistance >= 0 && shortDistance <= CFG.WATCH_DISTANCE_PCT) {
        candidates.push({ direction: 'SHORT', distancePct: shortDistance, trendAligned: ema20 < ema50 });
    }
    
    if (!candidates.length) {
        DEBUG.noDirection++;
        return [];
    }

    const oi = await getOpenInterest(candidate.symbol);
    const oiChangePct = updateOIHistory(candidate.symbol, oi);

    if (Math.abs(oiChangePct) < CFG.MIN_OI_CHANGE_PCT) {
        DEBUG.oiTooLow++;
        return [];
    }

    const results = [];
    for (const item of candidates) {
        let score = 0;
        if (boxWidthPct < 0.80) score += 20;
        else if (boxWidthPct < 1.20) score += 15;
        else score += 10;

        if (compressionRatio < 0.70) score += 20;
        else score += 12;

        if (item.distancePct < 0.10) score += 20;
        else if (item.distancePct < 0.25) score += 15;
        else score += 10;

        if (volumeRatio >= 1.50) score += 15;
        else if (volumeRatio >= 1.00) score += 10;
        else score += 5;

        if (item.trendAligned) score += 15;
        if (Math.abs(oiChangePct) >= 0.30) score += 15;
        else if (Math.abs(oiChangePct) >= 0.15) score += 10;
        else score += 5;

        if (score < CFG.WATCH_SCORE_MIN) {
            DEBUG.scoreTooLow++;
            continue;
        }

        let strengthLabel, strengthClass;
        if (score >= 85) {
            strengthLabel = '🔥🔥 ULTRA';
            strengthClass = 'strength-ultra';
        } else if (score >= 78) {
            strengthLabel = '🔥 GÜÇLÜ';
            strengthClass = 'strength-high';
        } else if (score >= 68) {
            strengthLabel = '💪 İYİ';
            strengthClass = 'strength-good';
        } else {
            strengthLabel = '⚡ NORMAL';
            strengthClass = 'strength-normal';
        }

        const reason = [
            'sıkışma',
            'banda yakın',
            item.trendAligned ? 'trend uyumu' : 'nötr',
            'hacim ' + volumeRatio.toFixed(1) + 'x',
            'OI ' + oiChangePct.toFixed(2) + '%'
        ].join(' · ');

        const setup = buildSetup(item.direction, candidate.symbol, currentPrice, {
            boxHigh, boxLow, boxWidthPct, compressionRatio, volumeRatio, oiChangePct,
            score: Math.min(score, 100), atr: recentATR, reason,
            strengthLabel, strengthClass
        });
        
        if (setup) {
            DEBUG.setupCreated++;
            results.push(setup);
        }
    }
    
    // Düzeltme: Sadece en yüksek puanlı yön
    if (results.length > 1) {
        results.sort((a, b) => b.score - a.score);
        return [results[0]];
    }
    
    return results;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index]);
        }
    });
    await Promise.all(workers);
    return results.flat();
}

function upsertSetup(nextSetup) {
    const existingIndex = setups.findIndex(setup => setup.id === nextSetup.id);
    
    if (existingIndex === -1) {
        setups.unshift(nextSetup);
        return;
    }
    
    const existing = setups[existingIndex];
    
    if (existing.state === 'FIRE') {
        DEBUG.duplicateSkipped++;
        return;
    }
    
    // Güncelle
    setups[existingIndex] = {
        ...existing,
        ...nextSetup,
        state: 'WATCH',
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        expiresAt: Date.now() + CFG.WATCH_TTL_MS
    };
}

function expireOldSetups() {
    const now = Date.now();
    setups.forEach(setup => {
        if (setup.state === 'WATCH' && now > setup.expiresAt) {
            setup.state = 'CANCEL';
            setup.cancelReason = 'Süre doldu';
            setup.finishedAt = now;
        }
        if (setup.state === 'FIRE' && now - setup.firedAt > CFG.FIRED_TTL_MS) {
            setup.state = 'EXPIRED';
            setup.cancelReason = 'FIRE süresi doldu';
            setup.finishedAt = now;
        }
    });
    setups = setups
        .filter(setup => !setup.finishedAt || now - setup.finishedAt < CFG.FINISHED_RETENTION_MS)
        .sort((left, right) => {
            const stateOrder = { FIRE: 0, WATCH: 1, CANCEL: 2, EXPIRED: 3 };
            return stateOrder[left.state] - stateOrder[right.state];
        })
        .slice(0, CFG.MAX_SETUPS);
}

async function runScan() {
    if (isScanning || isShuttingDown) return;
    isScanning = true;
    resetDebug();
    
    console.log('\n[' + new Date().toLocaleTimeString('tr-TR') + '] TARAMA BAŞLADI');
    console.log('-----------------------------------');
    
    try {
        const tickers = await exchange.fetchTickers();
        DEBUG.totalTickers = Object.keys(tickers).length;
        
        const candidates = Object.entries(tickers)
            .filter(([symbol, ticker]) => symbol.endsWith(':USDT') && number(ticker.quoteVolume) >= CFG.MIN_VOLUME_USDT && number(ticker.last) > 0)
            .map(([symbol, ticker]) => ({ symbol, ticker }))
            .sort((left, right) => number(right.ticker.quoteVolume) - number(left.ticker.quoteVolume))
            .slice(0, CFG.MAX_CANDIDATES);
        
        DEBUG.volumeFiltered = candidates.length;
        
        console.log('Ticker: ' + DEBUG.totalTickers + ' | Hacim filtresi: ' + DEBUG.volumeFiltered + ' aday');

        const discovered = await mapWithConcurrency(candidates, 3, analyzeCandidate);
        
        discovered.sort((left, right) => right.score - left.score).slice(0, CFG.MAX_SETUPS).forEach(upsertSetup);

        cleanOIHistory();
        expireOldSetups();
        broadcast();
        
        printDebugReport();

    } catch (error) {
        warnOnce('Tarama başarısız', error);
    } finally {
        isScanning = false;
    }
}

async function updateLivePrices() {
    if (isUpdatingPrices || isShuttingDown) return;
    isUpdatingPrices = true;
    try {
        const tickers = await exchange.fetchTickers();
        const now = Date.now();
        let changed = false;

        for (const setup of setups) {
            if (setup.state !== 'WATCH' && setup.state !== 'FIRE') continue;
            const price = number(tickers[setup.symbol]?.last);
            if (price <= 0) continue;
            setup.currentPrice = price;
            setup.updatedAt = now;

            if (setup.state === 'WATCH') {
                const fired = setup.direction === 'LONG' ? price >= setup.trigger : price <= setup.trigger;
                const invalidated = setup.direction === 'LONG' ? price < setup.boxLow : price > setup.boxHigh;
                const movedAway = setup.direction === 'LONG' ? percentDistance(setup.boxHigh, price) > CFG.WATCH_DISTANCE_PCT * 1.5 : percentDistance(setup.boxLow, price) > CFG.WATCH_DISTANCE_PCT * 1.5;

                if (fired) {
                    setup.state = 'FIRE';
                    setup.firedAt = now;
                    changed = true;
                    console.log('🔥 FIRE ' + setup.direction + ' | ' + setup.symbol + ' | Fiyat: ' + formatPrice(price) + ' | Tetik: ' + formatPrice(setup.trigger));
                } else if (invalidated) {
                    setup.state = 'CANCEL';
                    setup.cancelReason = 'Ters tarafa geçti';
                    setup.finishedAt = now;
                    changed = true;
                    console.log('❌ CANCEL ' + setup.symbol + ' | Ters tarafa geçti');
                } else if (movedAway) {
                    setup.state = 'CANCEL';
                    setup.cancelReason = 'Banttan uzaklaştı';
                    setup.finishedAt = now;
                    changed = true;
                    console.log('❌ CANCEL ' + setup.symbol + ' | Banttan uzaklaştı');
                }
            }
        }
        expireOldSetups();
        if (changed) broadcast();
    } catch (error) {
        warnOnce('Fiyat güncelleme başarısız', error);
    } finally {
        isUpdatingPrices = false;
    }
}

app.get('/api/setups', (req, res) => {
    res.json({ success: true, ...getSnapshot() });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, scanning: isScanning, setupCount: setups.length });
});

app.get('/api/chart', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTC/USDT:USDT';
        const timeframe = req.query.timeframe || '5m';
        const candles = await getCandles(symbol, timeframe, 100);
        const signal = setups.find(s => s.symbol === symbol) || null;
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
<title>MANUAL BREAKOUT RADAR</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070b11;color:#dbe4ee;font-family:Arial,sans-serif;overflow:hidden;height:100vh}
.app{display:grid;grid-template-columns:380px 1fr;height:100vh}
@media(max-width:800px){.app{grid-template-columns:1fr}.signal-panel{display:none}}
.signal-panel{background:#0b111b;border-right:1px solid #1a2533;display:flex;flex-direction:column;height:100vh}
.panel-header{padding:15px;border-bottom:1px solid #1a2533}
.panel-title{font-size:18px;font-weight:900;color:#13dba0}
.panel-sub{font-size:9px;color:#718096;margin-top:2px}
.panel-stats{display:flex;gap:8px;padding:10px 15px;border-bottom:1px solid #1a2533}
.panel-stat{flex:1;text-align:center;background:#101826;border-radius:6px;padding:6px}
.panel-stat b{display:block;font-size:18px;color:#13dba0}
.panel-stat span{font-size:8px;color:#64748b}
.signal-list{flex:1;overflow-y:auto;padding:10px}
.signal-card{background:#101826;border:1px solid #1c2938;border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer;transition:all .2s}
.signal-card:hover{border-color:#13dba0}
.signal-card.selected{border:2px solid #13dba0;background:#0d1a15}
.signal-card.long{border-left:5px solid #13dba0}
.signal-card.short{border-left:5px solid #ff5570}
.signal-card.fire{box-shadow:0 0 30px rgba(251,191,36,.4);border-color:#fbbf24;animation:fireGlow 1s infinite}
.signal-card.cancel,.signal-card.expired{opacity:.35;filter:grayscale(60%)}
@keyframes fireGlow{0%,100%{box-shadow:0 0 30px rgba(251,191,36,.4)}50%{box-shadow:0 0 55px rgba(251,191,36,.6)}}
.signal-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.signal-coin{font-size:15px;font-weight:900;color:#e2e8f0}
.signal-direction{font-size:10px;padding:4px 12px;border-radius:15px;font-weight:900;letter-spacing:1px}
.dir-long{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.dir-short{background:#421d28;color:#ff5570;border:1px solid #ff5570}
.strength-badge{display:inline-block;font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold;margin-top:4px}
.strength-ultra{background:#1a0d3d;color:#a78bfa;border:1px solid #a78bfa;animation:pulse 1s infinite}
.strength-high{background:#0d3d2a;color:#13dba0;border:1px solid #13dba0}
.strength-good{background:#0d3d3d;color:#22d3ee;border:1px solid #22d3ee}
.strength-normal{background:#1e293b;color:#94a3b8;border:1px solid #64748b}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.signal-price{font-size:18px;font-weight:900;margin:5px 0;color:#f1f5f9}
.signal-info{display:flex;gap:8px;font-size:9px;color:#94a3b8;margin-top:5px;flex-wrap:wrap}
.signal-info b{color:#e2e8f0}
.state-badge{font-size:9px;padding:3px 10px;border-radius:4px;font-weight:bold}
.state-watch{background:#0d3d2a;color:#13dba0}
.state-fire{background:#3d2d0d;color:#fbbf24}
.chart-panel{background:#0b111b;display:flex;flex-direction:column;padding:15px;min-width:0}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.chart-title{font-size:16px;font-weight:900;color:#13dba0}
.tf-buttons{display:flex;gap:5px}
.tf-btn{background:#101826;border:1px solid #1d2b3a;color:#718096;border-radius:4px;padding:5px 10px;font-size:9px;cursor:pointer}
.tf-btn.active{color:#13dba0;border-color:#13dba0}
.chart-container{flex:1;min-height:0;position:relative}
canvas{width:100%;height:100%;display:block}
.empty{text-align:center;color:#64748b;font-size:14px;padding:40px}
.detail-panel{margin-top:10px;background:#101826;border:1px solid #1c2938;border-radius:8px;padding:12px}
.detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:10px;color:#94a3b8;border-bottom:1px solid #1a2533}
.detail-row:last-child{border-bottom:0}
.detail-row b{color:#e2e8f0}
</style>
</head>
<body>
<div class="app">
<div class="signal-panel">
<div class="panel-header">
<div class="panel-title">MANUAL BREAKOUT RADAR</div>
<div class="panel-sub">WATCH ile hazırlan, FIRE gelince karar ver</div>
</div>
<div class="panel-stats">
<div class="panel-stat"><b id="st-total">0</b><span>Aktif</span></div>
<div class="panel-stat"><b id="st-watch">0</b><span>WATCH</span></div>
<div class="panel-stat"><b id="st-fire">0</b><span>FIRE</span></div>
</div>
<div class="signal-list" id="signals"><div class="empty">Tarama başlıyor...</div></div>
</div>
<div class="chart-panel">
<div class="chart-header">
<div class="chart-title" id="chartTitle">Sinyal seçin</div>
<div class="tf-buttons">
<button class="tf-btn active" data-tf="5m">5M</button>
<button class="tf-btn" data-tf="15m">15M</button>
<button class="tf-btn" data-tf="1h">1H</button>
</div>
</div>
<div class="chart-container"><canvas id="chartCanvas"></canvas></div>
<div class="detail-panel" id="details"><div class="empty">Soldan bir kurulum seçin</div></div>
</div>
</div>
<script>
var setups=[],selectedId=null,selectedTf='5m',chartCandles=[],currentSetup=null,connected=false;
function fmtPrice(v){var x=Number(v);if(!Number.isFinite(x))return '-';if(x>=1000)return x.toFixed(2);if(x>=100)return x.toFixed(3);if(x>=1)return x.toFixed(5);return x.toFixed(8)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function selectSetup(id){selectedId=id;currentSetup=setups.find(function(s){return s.id===id})||null;document.querySelectorAll('.signal-card').forEach(function(c){c.classList.remove('selected');if(c.getAttribute('data-id')===id)c.classList.add('selected')});var sym=currentSetup?currentSetup.symbol:'BTC/USDT:USDT';document.getElementById('chartTitle').textContent=sym.replace(':USDT','')+' - '+selectedTf.toUpperCase();showDetails();loadChart(sym)}
function showDetails(){if(!currentSetup){document.getElementById('details').innerHTML='<div class="empty">Soldan bir kurulum seçin</div>';return}var s=currentSetup;var st=s.state==='FIRE'?'🔥 FIRE - KIRILIM!':s.state==='WATCH'?'👀 WATCH - HAZIRLAN':s.state;document.getElementById('details').innerHTML='<div class="detail-row"><span>DURUM</span><b>'+esc(st)+'</b></div><div class="detail-row"><span>YÖN</span><b style="color:'+(s.direction==='LONG'?'#13dba0':'#ff5570')+'">'+esc(s.direction)+'</b></div><div class="detail-row"><span>GÜÇ</span><b>'+esc(s.strengthLabel)+'</b></div><div class="detail-row"><span>GİRİŞ TETİĞİ</span><b style="color:#13dba0">'+fmtPrice(s.trigger)+'</b></div><div class="detail-row"><span>STOP</span><b style="color:#ff5570">'+fmtPrice(s.stop)+'</b></div><div class="detail-row"><span>TP1</span><b style="color:#55a7ff">'+fmtPrice(s.tp1)+'</b></div><div class="detail-row"><span>TP2</span><b style="color:#55a7ff">'+fmtPrice(s.tp2)+'</b></div><div class="detail-row"><span>SKOR</span><b style="color:#fbbf24">'+esc(s.score)+'/100</b></div><div class="detail-row"><span>NEDEN</span><b style="font-size:9px">'+esc(s.reason)+'</b></div>'}
async function loadChart(symbol){if(!symbol)return;try{var r=await fetch('/api/chart?symbol='+encodeURIComponent(symbol)+'&timeframe='+encodeURIComponent(selectedTf));var d=await r.json();if(d.success){chartCandles=d.candles||[];drawChart()}}catch(e){}}
function drawChart(){var canvas=document.getElementById('chartCanvas');if(!canvas||!chartCandles.length)return;var parent=canvas.parentElement;var w=Math.max(300,parent.clientWidth);var h=Math.max(300,parent.clientHeight);var dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';var ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#070b11';ctx.fillRect(0,0,w,h);var visible=chartCandles.slice(-60);var minPrice=Math.min.apply(Math,visible.map(function(c){return c[3]}));var maxPrice=Math.max.apply(Math,visible.map(function(c){return c[2]}));if(currentSetup){[currentSetup.trigger,currentSetup.stop,currentSetup.tp1,currentSetup.tp2].forEach(function(p){if(p&&p<minPrice)minPrice=p;if(p&&p>maxPrice)maxPrice=p})}var pad=(maxPrice-minPrice)*0.08;minPrice-=pad;maxPrice+=pad;var L=40,R=100,T=15,B=15;var PW=w-L-R;var PH=h-T-B;function Y(price){return T+(maxPrice-price)/(maxPrice-minPrice)*PH}function X(i){return L+i*PW/(visible.length-1)}ctx.strokeStyle='#182330';for(var g=0;g<=4;g++){var gy=T+PH*g/4;ctx.beginPath();ctx.moveTo(L,gy);ctx.lineTo(w-R,gy);ctx.stroke();ctx.fillStyle='#607083';ctx.font='8px Arial';ctx.fillText(fmtPrice(maxPrice-(maxPrice-minPrice)*g/4),3,gy+3)}var step=PW/(visible.length-1);var bw=Math.max(2,Math.min(8,step*0.6));visible.forEach(function(candle,i){var xx=X(i);var up=candle[4]>=candle[1];var col=up?'#13e0a2':'#ff4d6d';ctx.strokeStyle=col;ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(xx,Y(candle[2]));ctx.lineTo(xx,Y(candle[3]));ctx.stroke();var yo=Y(candle[1]),yc=Y(candle[4]);ctx.fillRect(xx-bw/2,Math.min(yo,yc),bw,Math.max(1,Math.abs(yc-yo)))});if(currentSetup){drawLevel(ctx,currentSetup.trigger,'#13dba0','TETIK',L,w-R,Y);drawLevel(ctx,currentSetup.stop,'#ff5570','STOP',L,w-R,Y);drawLevel(ctx,currentSetup.tp1,'#55a7ff','TP1',L,w-R,Y);drawLevel(ctx,currentSetup.tp2,'#55a7ff','TP2',L,w-R,Y)}}
function drawLevel(ctx,price,color,label,L,R,Y){if(!price)return;var yy=Y(price);ctx.strokeStyle=color;ctx.setLineDash([5,5]);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(L,yy);ctx.lineTo(R,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='bold 9px Arial';ctx.fillText(label+' '+fmtPrice(price),R+5,yy+3)}
function render(data){setups=Array.isArray(data.setups)?data.setups:[];var stats=data.stats||{};document.getElementById('st-total').textContent=stats.total||0;document.getElementById('st-watch').textContent=stats.watch||0;document.getElementById('st-fire').textContent=stats.fire||0;var container=document.getElementById('signals');if(!setups.length){container.innerHTML='<div class="empty">Şu an hazırlanacak kurulum yok.</div>';return}container.innerHTML=setups.map(function(s){var state=s.state.toLowerCase();var dir=s.direction==='LONG'?'long':'short';var cardClass=dir+' '+state;if(selectedId===s.id)cardClass+=' selected';return '<div class="signal-card '+cardClass+'" data-id="'+esc(s.id)+'"><div class="signal-top"><span class="signal-coin">'+esc(s.symbol.replace(':USDT',''))+'</span><span class="signal-direction '+(s.direction==='LONG'?'dir-long':'dir-short')+'">'+esc(s.direction)+'</span></div><div class="strength-badge '+esc(s.strengthClass)+'">'+esc(s.strengthLabel)+'</div><div class="signal-price">'+fmtPrice(s.currentPrice)+'</div><div class="signal-info"><span>Skor: <b>'+esc(s.score)+'</b></span><span>Hacim: <b>'+esc(s.volumeRatio)+'x</b></span><span>OI: <b>%'+esc(s.oiChangePct)+'</b></span><span class="state-badge state-'+state+'">'+esc(s.state)+'</span></div></div>'}).join('');document.querySelectorAll('.signal-card').forEach(function(card){card.addEventListener('click',function(){var id=this.getAttribute('data-id');if(id)selectSetup(id)})});if(selectedId){currentSetup=setups.find(function(s){return s.id===selectedId})||null;if(currentSetup)showDetails()}}
document.querySelectorAll('.tf-btn').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('.tf-btn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');selectedTf=btn.getAttribute('data-tf');if(currentSetup){document.getElementById('chartTitle').textContent=currentSetup.symbol.replace(':USDT','')+' - '+selectedTf.toUpperCase();loadChart(currentSetup.symbol)}})});
function connect(){var proto=location.protocol==='https:'?'wss://':'ws://';var ws=new WebSocket(proto+location.host);ws.onopen=function(){connected=true};ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='snapshot')render(msg.data)}catch(_){}};ws.onclose=function(){connected=false;setTimeout(connect,3000)}}connect();
setInterval(function(){if(connected)return;fetch('/api/setups',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.success)render(d)}).catch(function(){})},4000);
window.addEventListener('resize',drawChart);
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.type('html').send(HTML);
});

wss.on('connection', ws => {
    ws.on('error', error => warnOnce('WebSocket hatası', error));
    try {
        ws.send(JSON.stringify({ type: 'snapshot', data: getSnapshot() }));
    } catch {}
});

async function start() {
    try {
        await exchange.loadMarkets();
        console.log('Bitget marketleri yüklendi.');
    } catch (error) {
        console.error('Marketler yüklenemedi:', error.message);
        setTimeout(start, 30 * 1000);
        return;
    }
    void runScan();
    scanTimer = setInterval(runScan, CFG.SCAN_INTERVAL_MS);
    liveTimer = setInterval(() => { void updateLivePrices(); }, CFG.LIVE_UPDATE_INTERVAL_MS);
}

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(scanTimer);
    clearInterval(liveTimer);
    console.log(signal + ' alındı; kapanıyor.');
    wss.clients.forEach(client => client.close(1001, 'Sunucu kapanıyor'));
    wss.close();
    server.close(async () => {
        try { await exchange.close(); } catch {}
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10 * 1000).unref();
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('Manual Breakout Radar: http://0.0.0.0:' + PORT);
    void start();
});

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
