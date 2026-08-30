const express = require('express');
const ccxt = require('ccxt');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- YAPILANDIRMA VE DURUM (STATE) ---
const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = 60000; // 1 Dakika

let previousOI = {};
let activeSignals = [];
let isScanning = false;

// CCXT Bitget İstemcisi (OHLCV ve Fiyat takibi için)
const exchange = new ccxt.bitget({
    enableRateLimit: true,
    options: {
        defaultType: 'swap',
    }
});

// --- YARDIMCI MATEMATİK FONKSİYONLARI ---
// ATR (Average True Range) Hesaplama (14 Periyot)
function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    
    let trValues = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][2];
        const low = candles[i][3];
        const prevClose = candles[i - 1][4];
        
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trValues.push(tr);
    }
    
    // SMA of TR için son 'period' kadar değeri al
    const recentTR = trValues.slice(-period);
    const sumTR = recentTR.reduce((sum, val) => sum + val, 0);
    return sumTR / period;
}

// Hacim Ortalaması Hesaplama
function calculateAvgVolume(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const recentCandles = candles.slice(-(period + 1), -1); // Mevcut kapanmamış mumu hariç tut
    const sumVol = recentCandles.reduce((sum, candle) => sum + candle[5], 0);
    return sumVol / period;
}

// --- VERİ ÇEKME MODÜLLERİ ---

// Bitget Toplu OI Uç Noktası
async function fetchBulkOpenInterest() {
    try {
        const response = await axios.get('https://api.bitget.com/api/v2/mix/market/open-interest-all?productType=usdt-futures');
        if (response.data && response.data.code === '00000') {
            const oiData = {};
            response.data.data.forEach(item => {
                oiData[item.symbol] = parseFloat(item.openInterest);
            });
            return oiData;
        }
        throw new Error("OI verisi çekilemedi veya API yapısı değişti.");
    } catch (error) {
        console.error("🔴 Toplu OI Çekim Hatası:", error.message);
        return null;
    }
}

// Aktif Fiyatları Güncelleme (MFE/MAE İçin)
async function updateCurrentPrices() {
    try {
        const tickers = await exchange.fetchTickers();
        return tickers;
    } catch (error) {
        console.error("🔴 Ticker Çekim Hatası:", error.message);
        return null;
    }
}

// --- SİNYAL VE STATÜ YÖNETİMİ ---
function updateSignalLifecycle(tickers) {
    const now = Date.now();
    
    activeSignals = activeSignals.map(signal => {
        const ticker = tickers[signal.symbol];
        if (!ticker) return signal;

        const currentPrice = ticker.last;
        const ageMin = (now - signal.timestamp) / 60000;
        const distancePct = Math.abs(currentPrice - signal.entryPrice) / signal.entryPrice * 100;

        // Statü Güncellemesi
        let status = '🔴 MISSED / EXTENDED';
        if (ageMin <= 5 && distancePct <= 0.2) {
            status = '🟢 FRESH';
        } else if (ageMin <= 15 && distancePct <= 0.5) {
            status = '🟡 VALID - LATE';
        }

        // MFE / MAE Güncellemesi
        if (signal.type.includes('LONG')) {
            signal.maxPrice = Math.max(signal.maxPrice, currentPrice);
            signal.minPrice = Math.min(signal.minPrice, currentPrice);
            signal.mfe = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
            signal.mae = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
        } else { // SHORT
            signal.maxPrice = Math.max(signal.maxPrice, currentPrice);
            signal.minPrice = Math.min(signal.minPrice, currentPrice);
            signal.mfe = ((signal.entryPrice - signal.minPrice) / signal.entryPrice) * 100;
            signal.mae = ((signal.maxPrice - signal.entryPrice) / signal.entryPrice) * 100;
        }

        signal.currentPrice = currentPrice;
        signal.ageMin = ageMin.toFixed(2);
        signal.distancePct = distancePct.toFixed(3);
        signal.status = status;

        return signal;
    });

    // 60 dakikadan eski sinyalleri listeden temizle (Opsiyonel Memory Management)
    activeSignals = activeSignals.filter(s => parseFloat(s.ageMin) < 60);
}

// --- ANA TARAMA MOTORU (FLOW IGNITION V1) ---
async function runScanner() {
    if (isScanning) return;
    isScanning = true;

    console.log(`[${new Date().toISOString()}] 🔍 Flow Ignition V1 Tarama Başladı...`);

    try {
        // 1. OI ve Ticker Verilerini Çek
        const currentOI = await fetchBulkOpenInterest();
        const tickers = await updateCurrentPrices();
        
        if (!currentOI || !tickers) {
            isScanning = false;
            return;
        }

        // Sinyal yaşam döngüsü güncelle
        updateSignalLifecycle(tickers);

        // 2. Önceki OI ile Kıyaslama ve Filtreleme
        if (Object.keys(previousOI).length > 0) {
            const markets = await exchange.loadMarkets();
            const usdtMarkets = Object.keys(markets).filter(s => s.endsWith(':USDT'));

            // Hızlandırmak ve rate-limit koruması için sadece OI değişimi %0.5'ten büyük olanları analiz et
            for (const symbol of usdtMarkets) {
                const apiSymbol = symbol.replace('/', '').replace(':USDT', 'USDT');
                const currOiVal = currentOI[apiSymbol];
                const prevOiVal = previousOI[apiSymbol];

                if (!currOiVal || !prevOiVal) continue;

                const oiChangePct = ((currOiVal - prevOiVal) / prevOiVal) * 100;

                // Anlamlı bir OI değişimi yoksa CCXT üzerinden mum isteği atarak limiti zorlama
                if (Math.abs(oiChangePct) < 0.5) continue; 

                try {
                    // 15 Dakikalık Mumları Çek
                    const candles = await exchange.fetchOHLCV(symbol, '15m', undefined, 20);
                    if (candles.length < 15) continue;

                    const currentCandle = candles[candles.length - 1];
                    const open = currentCandle[1];
                    const close = currentCandle[4];
                    const volume = currentCandle[5];
                    
                    const atr = calculateATR(candles);
                    const avgVolume = calculateAvgVolume(candles);
                    
                    if (!atr || !avgVolume) continue;

                    const candleSize = Math.abs(close - open);
                    const isCompression = candleSize < (atr * 0.8); // Mum boyu ATR'den küçükse sıkışma
                    const isVolumeSurge = volume > (avgVolume * 2.5); // Hacim şoku

                    if (isVolumeSurge) {
                        const isPriceUp = close > open;
                        let signalType = null;
                        let scenario = "";

                        // A, B, C, D SENARYO MATRİSİ
                        if (isPriceUp) {
                            if (oiChangePct < 0) {
                                signalType = "LONG";
                                scenario = "Short Squeeze";
                            } else if (oiChangePct > 0) {
                                signalType = "LONG";
                                scenario = "Expansion LONG";
                            }
                        } else {
                            if (oiChangePct < 0) {
                                signalType = "SHORT";
                                scenario = "Long Squeeze";
                            } else if (oiChangePct > 0) {
                                signalType = "SHORT";
                                scenario = "Expansion SHORT";
                            }
                        }

                        if (signalType) {
                            activeSignals.unshift({
                                id: Math.random().toString(36).substr(2, 9),
                                symbol: symbol,
                                type: signalType,
                                scenario: scenario,
                                entryPrice: close,
                                currentPrice: close,
                                maxPrice: close,
                                minPrice: close,
                                timestamp: Date.now(),
                                oiChangePct: oiChangePct.toFixed(2),
                                volumeSurgeRatio: (volume / avgVolume).toFixed(2),
                                isCompression: isCompression,
                                status: '🟢 FRESH',
                                distancePct: "0.000",
                                ageMin: "0.00",
                                mfe: 0,
                                mae: 0
                            });
                            console.log(`🚀 YENİ SİNYAL: ${symbol} | ${signalType} | ${scenario}`);
                        }
                    }
                } catch (err) {
                    // Tekil coin hatası taramayı durdurmasın
                    console.log(`⚠️ ${symbol} analiz hatası:`, err.message);
                }
            }
        }

        // Mevcut OI'yi bir sonraki döngü için sakla
        previousOI = currentOI;

    } catch (error) {
        console.error("🔴 Tarama Döngüsü Hatası:", error);
    } finally {
        isScanning = false;
    }
}

// --- API UÇ NOKTALARI (FRONTEND İÇİN) ---

// Aktif sinyalleri getir
app.get('/api/signals', (req, res) => {
    res.json({
        success: true,
        count: activeSignals.length,
        signals: activeSignals
    });
});

// Sistem metriklerini ve istatistiklerini getir
app.get('/api/stats', (req, res) => {
    const total = activeSignals.length;
    const freshCount = activeSignals.filter(s => s.status === '🟢 FRESH').length;
    
    // Genel MFE / MAE ortalaması (Sistemin genel başarısı)
    const avgMfe = total > 0 ? (activeSignals.reduce((acc, s) => acc + s.mfe, 0) / total).toFixed(2) : 0;
    const avgMae = total > 0 ? (activeSignals.reduce((acc, s) => acc + s.mae, 0) / total).toFixed(2) : 0;

    res.json({
        success: true,
        metrics: {
            totalSignalsTracker: total,
            freshOpportunities: freshCount,
            averageMFE: `%${avgMfe}`,
            averageMAE: `%${avgMae}`,
            uptimeMinutes: Math.floor(process.uptime() / 60)
        }
    });
});

// --- BAŞLATMA ---
app.listen(PORT, async () => {
    console.log(`🔥 Flow Ignition V1 API çalışıyor: http://localhost:${PORT}`);
    
    // CCXT Market Verilerini önden yükle
    await exchange.loadMarkets();
    
    // İlk taramayı başlat ve döngüye al
    runScanner();
    setInterval(runScanner, SCAN_INTERVAL_MS);
});
