const axios = require('axios');
const ccxt = require('ccxt');
const express = require('express');
const app = express();

const bitget = new ccxt.bitget({ enableRateLimit: true });
const activeSignals = new Map();
const signalHistory = []; // MFE/MAE testleri için veri tabanı taslağı

// 1. Bitget Toplu OI Verisi Çekimi
async function fetchAllOI() {
    try {
        const response = await axios.get('https://api.bitget.com/api/v2/mix/market/open-interest-all?productType=usdt-futures');
        return response.data.data.symbolList; // [{ symbol: 'BTCUSDT', openInterest: '...', ... }]
    } catch (error) {
        console.error('OI Verisi çekilemedi:', error.message);
        return [];
    }
}

// 2. Flow Ignition Sinyal Motoru
async function analyzeFlow(symbol, currentOI, prevOI) {
    const ohlcv = await bitget.fetchOHLCV(symbol, '15m', undefined, 20);
    if (ohlcv.length < 20) return null;

    const currentCandle = ohlcv[ohlcv.length - 1];
    const prevCandles = ohlcv.slice(0, -1);
    
    // Basit Volatilite & Hacim Hesaplaması
    const avgVolume = prevCandles.reduce((sum, c) => sum + c[5], 0) / prevCandles.length;
    const isVolumeSurge = currentCandle[5] > avgVolume * 2.5; // Hacim Şoku
    
    const oiChangePct = ((currentOI - prevOI) / prevOI) * 100;
    const priceChangePct = ((currentCandle[4] - currentCandle[1]) / currentCandle[1]) * 100;

    let scenario = null;
    let type = null;

    // Senaryo A/B/C/D Matrisi
    if (priceChangePct > 0.5 && isVolumeSurge) {
        if (oiChangePct < -1.5) {
            scenario = 'Short Squeeze / Tasfiye';
            type = 'LONG';
        } else if (oiChangePct > 2.0) {
            scenario = 'Expansion / Yeni Yakıt';
            type = 'LONG';
        }
    } else if (priceChangePct < -0.5 && isVolumeSurge) {
        if (oiChangePct < -1.5) {
            scenario = 'Long Squeeze / Tasfiye';
            type = 'SHORT';
        } else if (oiChangePct > 2.0) {
            scenario = 'Expansion / Yeni Yakıt';
            type = 'SHORT';
        }
    }

    if (scenario) {
        return {
            id: `${symbol}-${Date.now()}`,
            symbol,
            type,
            scenario,
            entryPrice: currentCandle[4],
            oiChangePct: oiChangePct.toFixed(2),
            volSurge: (currentCandle[5] / avgVolume).toFixed(1),
            timestamp: Date.now(),
            mfe: 0,
            mae: 0
        };
    }
    return null;
}

// 3. Sinyal Yaşı ve Durum Güncelleyici
function updateSignalStates(currentPrices) {
    const now = Date.now();
    activeSignals.forEach((signal, key) => {
        const currentPrice = currentPrices[signal.symbol];
        if (!currentPrice) return;

        const ageMs = now - signal.timestamp;
        const ageMin = Math.floor(ageMs / 60000);
        const distancePct = Math.abs((currentPrice - signal.entryPrice) / signal.entryPrice) * 100;

        // MFE / MAE Kaydı
        if (signal.type === 'LONG') {
            if (currentPrice > signal.entryPrice) signal.mfe = Math.max(signal.mfe, distancePct);
            if (currentPrice < signal.entryPrice) signal.mae = Math.max(signal.mae, distancePct);
        } else {
            if (currentPrice < signal.entryPrice) signal.mfe = Math.max(signal.mfe, distancePct);
            if (currentPrice > signal.entryPrice) signal.mae = Math.max(signal.mae, distancePct);
        }

        // Dinamik UI Statüsü
        if (distancePct < 0.2 && ageMin < 5) signal.status = '🟢 FRESH';
        else if (distancePct < 0.4 && ageMin >= 5) signal.status = '🟡 VALID - LATE';
        else signal.status = '🔴 MISSED';

        if (ageMin > 60) {
            signalHistory.push(signal); // İstatistiki veritabanına aktar
            activeSignals.delete(key);
        }
    });
}

// Ana Döngü
let previousOIState = {};
setInterval(async () => {
    const oiData = await fetchAllOI();
    const currentPrices = {}; // Güncel fiyatları API'den beslemek için

    for (const item of oiData) {
        const symbol = item.symbol;
        const currentOI = parseFloat(item.openInterest);
        
        if (previousOIState[symbol]) {
            const signal = await analyzeFlow(symbol, currentOI, previousOIState[symbol]);
            if (signal && !activeSignals.has(symbol)) {
                activeSignals.set(symbol, signal);
                console.log(`[YENİ SİNYAL] ${symbol} | ${signal.type} | ${signal.scenario}`);
            }
        }
        previousOIState[symbol] = currentOI;
    }
    
    updateSignalStates(currentPrices);
}, 60000); // 1 Dakikada Bir Tarama

app.get('/api/signals', (req, res) => {
    res.json(Array.from(activeSignals.values()));
});

app.listen(3000, () => console.log('Flow Ignition V1 Devrede (Port 3000)'));
