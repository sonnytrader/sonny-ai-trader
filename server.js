// ==========================================================
// Sonny AI Trader v6.3 - OTOMATİK TRADE DÜZELTİLMİŞ
// ==========================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const ti = require('technicalindicators');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ==========================================================
// ⚙️ KONFİGÜRASYON
// ==========================================================

let CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),
    orderRiskPercent: 2,
    leverage: 3,
    maxPositions: 3,
    useMachineLearning: true,
    adaptiveTrading: true,
    autoTradeEnabled: false,
    autoTradeMode: 'AI_DECISION',
    minAutoConfidence: 60,
    minVolumeUSD: 500000,
    blacklist: ['SHIBUSDT', 'DOGEUSDT', 'PEPEUSDT', 'BONKUSDT', 'FLOKIUSDT', 'ESPORTSUSDT'],
    scanInterval: 30000,
    preScanInterval: 300000,
    scanCoinsPerCycle: 25,
    debugMode: true
};

// ==========================================================
// 🤖 OTONOM AI TRADER
// ==========================================================

class AutonomousAITrader {
    constructor() {
        this.marketMemory = [];
        this.performanceHistory = [];
    }

    async makeTradingDecision(symbol, data, currentPositions) {
        try {
            const technicalScore = await this.calculateTechnicalScore(data);
            const riskAssessment = this.assessTradeRisk(data, currentPositions);
            
            const decisionMatrix = {
                technical: technicalScore,
                risk: riskAssessment.score,
                volume: this.calculateVolumeScore(data),
                trend: this.calculateTrendScore(data)
            };

            const decisionResult = this.calculateAutonomousDecision(decisionMatrix, symbol);
            
            return {
                execute: decisionResult.execute,
                direction: decisionResult.direction,
                confidence: decisionResult.confidence,
                positionSize: decisionResult.positionSize,
                reasoning: decisionResult.reasoning,
                matrix: decisionMatrix,
                riskLevel: decisionResult.riskLevel
            };

        } catch (error) {
            console.log(`❌ AI karar hatası (${symbol}):`, error.message);
            return this.getSafeDecision();
        }
    }

    calculateAutonomousDecision(matrix, symbol) {
        const totalScore = 
            (matrix.technical * 0.50) +
            (matrix.risk * 0.25) +
            (matrix.volume * 0.15) +
            (matrix.trend * 0.10);

        const confidence = Math.min(95, Math.max(5, Math.round(totalScore)));
        
        let execute = false;
        let direction = matrix.technical >= 50 ? 'LONG' : 'SHORT';
        let positionSize = 'NORMAL';
        let reasoning = "";
        let riskLevel = "MEDIUM";

        if (confidence >= 65 && matrix.risk >= 60) {
            execute = true;
            positionSize = 'NORMAL';
            reasoning = "🚀 YÜKSEK GÜVEN - Güçlü sinyal";
            riskLevel = "LOW";
        }
        else if (confidence >= 60 && matrix.risk >= 50) {
            execute = true;
            positionSize = 'SMALL';
            reasoning = "✅ İYİ FIRSAT - Kaliteli sinyal";
            riskLevel = "MEDIUM";
        }
        else {
            execute = false;
            reasoning = `❌ AI RED - Yetersiz güven (${confidence}%)`;
            riskLevel = "HIGH";
        }

        console.log(`🧠 ${symbol} ${direction} | Güven: ${confidence}% | Risk: ${matrix.risk} | Karar: ${execute}`);

        return { execute, direction, confidence, positionSize, reasoning, riskLevel };
    }

    async calculateTechnicalScore(data) {
        let score = 50;
        
        try {
            if (data.rsi < 25) score += 20;
            else if (data.rsi < 30) score += 15;
            else if (data.rsi > 75) score -= 20;
            else if (data.rsi > 70) score -= 15;

            if (data.macd > data.macdSignal) {
                if (data.macdHistogram > 0) score += 15;
                else score += 8;
            } else {
                if (data.macdHistogram < 0) score -= 15;
                else score -= 8;
            }

            if (data.bbUpper && data.bbLower) {
                const bbPosition = (data.currentPrice - data.bbLower) / (data.bbUpper - data.bbLower);
                if (bbPosition < 0.1) score += 12;
                else if (bbPosition > 0.9) score -= 12;
            }

        } catch (error) {
            console.log('❌ Teknik skor hatası:', error.message);
        }
        
        return Math.min(100, Math.max(0, score));
    }

    calculateVolumeScore(data) {
        return data.volumeRatio > 2 ? 80 : data.volumeRatio > 1 ? 60 : 40;
    }

    calculateTrendScore(data) {
        return data.trend === data.signalDirection ? 80 : 40;
    }

    assessTradeRisk(data, currentPositions) {
        let riskScore = 70;
        
        if (currentPositions.length >= CONFIG.maxPositions) {
            riskScore -= 30;
        }
        
        if (data.priceChange24h > 20 || data.priceChange24h < -20) {
            riskScore -= 15;
        }
        
        return {
            score: Math.max(0, riskScore),
            level: riskScore >= 70 ? 'LOW' : riskScore >= 50 ? 'MEDIUM' : 'HIGH'
        };
    }

    getSafeDecision() {
        return {
            execute: false,
            direction: 'NEUTRAL',
            confidence: 50,
            positionSize: 'NONE',
            reasoning: "⚠️ AI SİSTEM HATASI",
            riskLevel: "HIGH"
        };
    }
}

const autonomousAI = new AutonomousAITrader();

// ==========================================================
// 🧠 BASİT VE GÜVENLİ TP/SL SİSTEMİ
// ==========================================================

async function calculateSmartTPnSL(coin, direction, currentPrice) {
    try {
        // ÖNCE FİYAT KONTROLÜ
        if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
            console.log(`❌ Geçersiz fiyat: ${coin} - ${currentPrice}`);
            return getConservativeTPnSL(currentPrice || 1, direction);
        }

        const originalSymbol = getOriginalSymbol(coin);
        
        // BASİT VOLATİLİTE HESAPLA
        const candles = await bitget.fetchOHLCV(originalSymbol, '1h', undefined, 24);
        if (candles.length < 10) {
            return getConservativeTPnSL(currentPrice, direction);
        }

        const highs = candles.map(c => parseFloat(c[2]));
        const lows = candles.map(c => parseFloat(c[3]));
        const maxHigh = Math.max(...highs);
        const minLow = Math.min(...lows);
        
        const volatility = (maxHigh - minLow) / currentPrice;
        
        // DYNAMIC TP/SL HESAPLA
        if (direction === 'LONG') {
            return calculateDynamicLongTPnSL(currentPrice, volatility);
        } else {
            return calculateDynamicShortTPnSL(currentPrice, volatility);
        }
        
    } catch (error) {
        console.log(`❌ TP/SL hatası (${coin}):`, error.message);
        return getConservativeTPnSL(currentPrice || 1, direction);
    }
}

function calculateDynamicLongTPnSL(currentPrice, volatility) {
    // VOLATİLİTEYE GÖRE TP/SL AYARLA
    const baseTP = 3 + (volatility * 50); // %3-8 arası
    const baseSL = 2 + (volatility * 20); // %2-6 arası
    
    const tpPercent = Math.min(15, Math.max(3, baseTP));  // Min %3, Max %15
    const slPercent = Math.min(6, Math.max(1.5, baseSL)); // Min %1.5, Max %6

    const tp1 = currentPrice * (1 + (tpPercent * 0.01));
    const tp2 = currentPrice * (1 + (tpPercent * 1.5 * 0.01));
    const tp3 = currentPrice * (1 + (tpPercent * 2 * 0.01));
    const sl = currentPrice * (1 - (slPercent * 0.01));

    const profitPercent1 = ((tp1 - currentPrice) / currentPrice * 100);
    const profitPercent2 = ((tp2 - currentPrice) / currentPrice * 100);
    const profitPercent3 = ((tp3 - currentPrice) / currentPrice * 100);
    const riskPercent = ((currentPrice - sl) / currentPrice * 100);

    // NAN KONTROLÜ
    if (isNaN(profitPercent1) || isNaN(riskPercent)) {
        return getConservativeTPnSL(currentPrice, 'LONG');
    }

    return {
        tp1: parseFloat(tp1.toFixed(6)),
        tp2: parseFloat(tp2.toFixed(6)),
        tp3: parseFloat(tp3.toFixed(6)),
        sl: parseFloat(sl.toFixed(6)),
        profitPercent1: parseFloat(profitPercent1.toFixed(2)),
        profitPercent2: parseFloat(profitPercent2.toFixed(2)),
        profitPercent3: parseFloat(profitPercent3.toFixed(2)),
        riskPercent: parseFloat(riskPercent.toFixed(2)),
        reasoning: `🎯 TP: %${profitPercent1.toFixed(2)} → %${profitPercent2.toFixed(2)} → %${profitPercent3.toFixed(2)} | SL: %${riskPercent.toFixed(2)}`
    };
}

function calculateDynamicShortTPnSL(currentPrice, volatility) {
    // VOLATİLİTEYE GÖRE TP/SL AYARLA
    const baseTP = 3 + (volatility * 50); // %3-8 arası
    const baseSL = 2 + (volatility * 20); // %2-6 arası
    
    const tpPercent = Math.min(15, Math.max(3, baseTP));  // Min %3, Max %15
    const slPercent = Math.min(6, Math.max(1.5, baseSL)); // Min %1.5, Max %6

    const tp1 = currentPrice * (1 - (tpPercent * 0.01));
    const tp2 = currentPrice * (1 - (tpPercent * 1.5 * 0.01));
    const tp3 = currentPrice * (1 - (tpPercent * 2 * 0.01));
    const sl = currentPrice * (1 + (slPercent * 0.01));

    const profitPercent1 = ((currentPrice - tp1) / currentPrice * 100);
    const profitPercent2 = ((currentPrice - tp2) / currentPrice * 100);
    const profitPercent3 = ((currentPrice - tp3) / currentPrice * 100);
    const riskPercent = ((sl - currentPrice) / currentPrice * 100);

    // NAN KONTROLÜ
    if (isNaN(profitPercent1) || isNaN(riskPercent)) {
        return getConservativeTPnSL(currentPrice, 'SHORT');
    }

    return {
        tp1: parseFloat(tp1.toFixed(6)),
        tp2: parseFloat(tp2.toFixed(6)),
        tp3: parseFloat(tp3.toFixed(6)),
        sl: parseFloat(sl.toFixed(6)),
        profitPercent1: parseFloat(profitPercent1.toFixed(2)),
        profitPercent2: parseFloat(profitPercent2.toFixed(2)),
        profitPercent3: parseFloat(profitPercent3.toFixed(2)),
        riskPercent: parseFloat(riskPercent.toFixed(2)),
        reasoning: `🎯 TP: %${profitPercent1.toFixed(2)} → %${profitPercent2.toFixed(2)} → %${profitPercent3.toFixed(2)} | SL: %${riskPercent.toFixed(2)}`
    };
}

function getConservativeTPnSL(currentPrice, direction) {
    // GÜVENLİ FALLBACK DEĞERLER
    if (direction === 'LONG') {
        const tp1 = currentPrice * 1.03;
        const tp2 = currentPrice * 1.06;
        const tp3 = currentPrice * 1.10;
        const sl = currentPrice * 0.98;
        return {
            tp1: tp1,
            tp2: tp2,
            tp3: tp3,
            sl: sl,
            profitPercent1: 3.0,
            profitPercent2: 6.0,
            profitPercent3: 10.0,
            riskPercent: 2.0,
            reasoning: "🛡️ Güvenli TP/SL: %3 → %6 → %10 KAR | %2 RİSK"
        };
    } else {
        const tp1 = currentPrice * 0.97;
        const tp2 = currentPrice * 0.94;
        const tp3 = currentPrice * 0.90;
        const sl = currentPrice * 1.02;
        return {
            tp1: tp1,
            tp2: tp2,
            tp3: tp3,
            sl: sl,
            profitPercent1: 3.0,
            profitPercent2: 6.0,
            profitPercent3: 10.0,
            riskPercent: 2.0,
            reasoning: "🛡️ Güvenli TP/SL: %3 → %6 → %10 KAR | %2 RİSK"
        };
    }
}

// ==========================================================
// 📊 VERİ YÖNETİMİ
// ==========================================================

let availableSymbols = [];
let activeSignals = {};
let openPositions = [];
let currentScanIndex = 0;
let tradeMetrics = {
    totalEquity: 0,
    availableMargin: 0,
    totalUnrealizedPnl: 0,
    positionsCount: 0,
    lastUpdate: 'N/A'
};

let bitget = new ccxt.bitget({
    apiKey: CONFIG.apiKey,
    secret: CONFIG.secret,
    password: CONFIG.password,
    enableRateLimit: true,
    sandbox: false
});

// ==========================================================
// 🛠️ YARDIMCI FONKSİYONLAR
// ==========================================================

function cleanSymbol(symbol) {
    try {
        if (symbol.includes('/') && symbol.includes(':')) {
            return symbol.split('/')[0] + 'USDT';
        } else if (symbol.includes(':')) {
            return symbol.split(':')[0];
        }
        return symbol.replace('/', '');
    } catch (error) {
        return symbol;
    }
}

function getOriginalSymbol(cleanSymbol) {
    try {
        if (cleanSymbol.endsWith('USDT') && !cleanSymbol.includes('/')) {
            const base = cleanSymbol.replace('USDT', '');
            return `${base}/USDT:USDT`;
        }
        return cleanSymbol;
    } catch (error) {
        return cleanSymbol;
    }
}

function getTradingViewLink(symbol) {
    try {
        let tvSymbol = symbol
            .replace('/USDT:USDT', '')
            .replace('USDT', '')
            .replace('1000', '');
        
        return `https://www.tradingview.com/chart/?symbol=BITGET%3A${tvSymbol}USDT`;
    } catch (error) {
        return `https://www.tradingview.com/chart/`;
    }
}

async function getVolumeInfo(symbol) {
    try {
        const ticker = await bitget.fetchTicker(symbol);
        const dailyVolume = ticker.quoteVolume || 0;
        
        let volumeRating = 'DÜŞÜK';
        if (dailyVolume > 5000000) volumeRating = 'ÇOK YÜKSEK';
        else if (dailyVolume > 2000000) volumeRating = 'YÜKSEK';
        else if (dailyVolume > 1000000) volumeRating = 'ORTA';
        
        return {
            dailyVolume: dailyVolume,
            rating: volumeRating
        };
    } catch (error) {
        return { dailyVolume: 0, rating: 'BİLİNMİYOR' };
    }
}

// ==========================================================
// 🔄 SİNYAL OLUŞTURMA - DÜZELTİLMİŞ
// ==========================================================

async function createAutonomousAISignal(coin, aiDecision, currentPrice, originalSymbol, volumeInfo) {
    try {
        // AKILLI TP/SL HESAPLA
        const smartTPnSL = await calculateSmartTPnSL(coin, aiDecision.direction, currentPrice);
        
        const cleanCoin = coin;
        const tvLink = getTradingViewLink(originalSymbol);

        // NAN KONTROLÜ
        if (isNaN(smartTPnSL.profitPercent1) || isNaN(smartTPnSL.riskPercent)) {
            console.log(`❌ TP/SL NaN hatası: ${coin}`);
            return;
        }

        const signal = {
            coin: cleanCoin,
            ccxt_symbol: originalSymbol,
            taraf: aiDecision.direction,
            tip: 'AKILLI_AI',
            zaman_araligi: '15m',
            giris: parseFloat(currentPrice.toFixed(6)),
            tp1: smartTPnSL.tp1,
            tp2: smartTPnSL.tp2,
            tp3: smartTPnSL.tp3,
            sl: smartTPnSL.sl,
            profitPercent1: smartTPnSL.profitPercent1,
            profitPercent2: smartTPnSL.profitPercent2,
            profitPercent3: smartTPnSL.profitPercent3,
            riskPercent: smartTPnSL.riskPercent,
            riskReward: (smartTPnSL.profitPercent1 / smartTPnSL.riskPercent).toFixed(2),
            tuyo: `🤖 ${aiDecision.reasoning} | ${smartTPnSL.reasoning}`,
            hacim_analizi: `Güven: ${aiDecision.confidence}% | ${volumeInfo.rating} hacim`,
            sinyal_kategorisi: aiDecision.confidence >= 65 ? 'YÜKSEK GÜVEN' : 'ORTA GÜVEN',
            tv_link: tvLink,
            timestamp: Date.now(),
            confidence: aiDecision.confidence,
            ai_decision: aiDecision
        };

        console.log(`🎯 ${signal.coin} ${signal.taraf} | Kar: %${signal.profitPercent1} → %${signal.profitPercent2} → %${signal.profitPercent3} | Risk: %${signal.riskPercent}`);
        broadcastSignal(signal);

        // OTOMATİK TİCARET - DÜZELTİLMİŞ
        if (CONFIG.autoTradeEnabled && 
            CONFIG.isApiConfigured && 
            aiDecision.execute &&
            openPositions.length < CONFIG.maxPositions) {
            
            if (CONFIG.autoTradeMode === 'MANUAL_CONFIRM' && aiDecision.confidence < CONFIG.minAutoConfidence) {
                console.log(`⏳ Manuel onay bekleniyor: ${signal.coin} (Güven: ${aiDecision.confidence}% < ${CONFIG.minAutoConfidence}%)`);
                return;
            }
            
            console.log(`🤖 OTONOM İŞLEM: ${signal.coin} ${signal.taraf} (${aiDecision.positionSize}) | Mod: ${CONFIG.autoTradeMode}`);
            try {
                await placeDynamicOrder(signal, aiDecision.positionSize);
            } catch (e) {
                console.error(`❌ Otonom işlem hatası: ${e.message}`);
                
                // Hata detaylı log
                if (e.message.includes('40774') || e.message.includes('unilateral')) {
                    console.log(`🛠️ Unilateral position hatası - Manuel işlem gerekli`);
                    console.log(`💡 Çözüm: Bitget app'te "Pozisyon Modu"nu "Tek Taraflı" yapın`);
                }
            }
        }

    } catch (error) {
        console.error(`❌ Sinyal oluşturma hatası (${coin}):`, error.message);
    }
}

// ==========================================================
// 📊 EKSİK API ENDPOINT'LERİ - EKLENMİŞ
// ==========================================================

// Metrikler endpoint'i
app.get('/api/metrics', async (req, res) => {
    try {
        let totalEquity = 0;
        let availableMargin = 0;
        let totalUnrealizedPnl = 0;

        if (CONFIG.isApiConfigured) {
            try {
                const balance = await bitget.fetchBalance({ type: 'swap' });
                totalEquity = balance.total?.USDT || 0;
                availableMargin = balance.free?.USDT || 0;
                
                // Pozisyon PNL hesapla
                await syncOpenPositions();
                totalUnrealizedPnl = openPositions.reduce((sum, pos) => sum + (pos.unrealizedPnl || 0), 0);
            } catch (error) {
                console.log('❌ Bakiye çekme hatası:', error.message);
            }
        }

        res.json({
            totalEquity: totalEquity.toFixed(2),
            availableMargin: availableMargin.toFixed(2),
            totalUnrealizedPnl: totalUnrealizedPnl.toFixed(2),
            positionsCount: openPositions.length,
            lastUpdate: new Date().toLocaleTimeString('tr-TR')
        });
    } catch (error) {
        console.error('❌ Metrikler endpoint hatası:', error);
        res.status(500).json({ 
            error: 'Metrikler alınamadı',
            details: error.message 
        });
    }
});

// Config durumu endpoint'i
app.get('/api/config/status', async (req, res) => {
    try {
        let balanceInfo = {};
        
        if (CONFIG.isApiConfigured) {
            try {
                const balance = await bitget.fetchBalance({ type: 'swap' });
                balanceInfo = {
                    totalBalance: balance.total?.USDT || 0,
                    availableBalance: balance.free?.USDT || 0
                };
            } catch (error) {
                console.log('❌ Config balance hatası:', error.message);
            }
        }

        res.json({
            ...CONFIG,
            ...balanceInfo,
            serverTime: new Date().toLocaleTimeString('tr-TR'),
            activeSignals: Object.keys(activeSignals).length,
            openPositions: openPositions.length
        });
    } catch (error) {
        console.error('❌ Config status hatası:', error);
        res.status(500).json({ 
            error: 'Config alınamadı',
            details: error.message 
        });
    }
});

// Risk ayarları endpoint'i
app.get('/api/risk-settings', (req, res) => {
    try {
        res.json({
            orderRiskPercent: CONFIG.orderRiskPercent,
            leverage: CONFIG.leverage,
            maxPositions: CONFIG.maxPositions,
            autoTradeMode: CONFIG.autoTradeMode,
            minAutoConfidence: CONFIG.minAutoConfidence,
            minVolumeUSD: CONFIG.minVolumeUSD,
            scanInterval: CONFIG.scanInterval,
            blacklist: CONFIG.blacklist
        });
    } catch (error) {
        console.error('❌ Risk settings hatası:', error);
        res.status(500).json({ error: 'Ayarlar alınamadı' });
    }
});

// Risk ayarları güncelleme endpoint'i
app.post('/api/risk-settings/update', (req, res) => {
    try {
        const {
            orderRiskPercent,
            leverage,
            maxPositions,
            autoTradeMode,
            minAutoConfidence
        } = req.body;

        // Validasyon
        if (orderRiskPercent && orderRiskPercent >= 0.1 && orderRiskPercent <= 50) {
            CONFIG.orderRiskPercent = parseFloat(orderRiskPercent);
        }
        
        if (leverage && leverage >= 1 && leverage <= 100) {
            CONFIG.leverage = parseInt(leverage);
        }
        
        if (maxPositions && maxPositions >= 1 && maxPositions <= 10) {
            CONFIG.maxPositions = parseInt(maxPositions);
        }
        
        if (autoTradeMode) {
            CONFIG.autoTradeMode = autoTradeMode;
        }
        
        if (minAutoConfidence && minAutoConfidence >= 50 && minAutoConfidence <= 95) {
            CONFIG.minAutoConfidence = parseInt(minAutoConfidence);
        }

        console.log('✅ Ayarlar güncellendi:', CONFIG);

        res.json({ 
            success: true, 
            message: 'Ayarlar başarıyla güncellendi!',
            config: CONFIG 
        });
    } catch (error) {
        console.error('❌ Risk settings update hatası:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Ayarlar güncellenemedi: ' + error.message 
        });
    }
});

// Otomatik trade endpoint'leri
app.post('/api/autotrade/enable', (req, res) => {
    try {
        CONFIG.autoTradeEnabled = true;
        console.log('✅ Otomatik trade AKTİF');
        
        res.json({ 
            success: true, 
            message: 'Otomatik trade modu AKTİF edildi!',
            autoTradeEnabled: true 
        });
    } catch (error) {
        console.error('❌ Auto trade enable hatası:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Otomatik mod açılamadı' 
        });
    }
});

app.post('/api/autotrade/disable', (req, res) => {
    try {
        CONFIG.autoTradeEnabled = false;
        console.log('❌ Otomatik trade PASİF');
        
        res.json({ 
            success: true, 
            message: 'Otomatik trade modu PASİF edildi!',
            autoTradeEnabled: false 
        });
    } catch (error) {
        console.error('❌ Auto trade disable hatası:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Otomatik mod kapatılamadı' 
        });
    }
});

// Pozisyon temizleme endpoint'i
app.post('/api/force-remove-position', (req, res) => {
    try {
        const { symbol } = req.body;
        
        if (!symbol) {
            return res.status(400).json({ 
                success: false, 
                message: 'Symbol gereklidir' 
            });
        }

        const initialCount = openPositions.length;
        openPositions = openPositions.filter(pos => pos.symbol !== symbol);
        const removedCount = initialCount - openPositions.length;

        console.log(`🗑️ Local pozisyon temizlendi: ${symbol} (${removedCount} adet)`);

        res.json({ 
            success: true, 
            message: `${removedCount} pozisyon localden temizlendi`,
            removedCount: removedCount
        });
    } catch (error) {
        console.error('❌ Force remove position hatası:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Pozisyon temizlenemedi: ' + error.message 
        });
    }
});

// Health check endpoint'i (geliştirilmiş)
app.get('/api/health', async (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toLocaleTimeString('tr-TR'),
        apiConfigured: CONFIG.isApiConfigured,
        autoTrade: CONFIG.autoTradeEnabled,
        activeSignals: Object.keys(activeSignals).length,
        openPositions: openPositions.length,
        availableCoins: availableSymbols.length,
        minVolume: CONFIG.minVolumeUSD,
        serverUptime: process.uptime().toFixed(0) + 's'
    };

    if (CONFIG.isApiConfigured) {
        try {
            const balance = await bitget.fetchBalance({ type: 'swap' });
            healthStatus.balance = balance.total?.USDT || 0;
            healthStatus.available = balance.free?.USDT || 0;
        } catch (e) {
            healthStatus.balanceError = e.message;
        }
    }

    res.json(healthStatus);
});

// ==========================================================
// 🌐 WEB SOCKET & API ROUTES
// ==========================================================

async function syncOpenPositions() {
    if (!CONFIG.isApiConfigured) return;
    
    try {
        const positions = await bitget.fetchPositions();
        const activePositions = positions.filter(pos => {
            const contracts = parseFloat(pos.contracts || 0);
            return contracts > 0;
        });
        
        openPositions = activePositions.map(pos => ({
            symbol: pos.symbol,
            side: pos.side,
            amount: parseFloat(pos.contracts),
            entryPrice: parseFloat(pos.entryPrice),
            markPrice: parseFloat(pos.markPrice),
            unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
            leverage: pos.leverage,
            liquidationPrice: pos.liquidationPrice,
            timestamp: Date.now()
        }));
        
        console.log(`🔍 Pozisyon senkronize: ${openPositions.length} aktif`);
        
    } catch (e) {
        console.error('❌ Pozisyon senkronizasyon hatası:', e.message);
    }
}

wss.on('connection', (ws) => {
    console.log('✅ Yeni istemci bağlandı');
    
    ws.send(JSON.stringify({
        type: 'signals',
        data: Object.values(activeSignals).sort((a, b) => b.timestamp - a.timestamp)
    }));
    
    ws.on('close', () => {
        console.log('❌ İstemci bağlantısı kesildi');
    });
});

function broadcastSignal(sinyal) {
    try {
        const uniqueKey = `${sinyal.coin}_${sinyal.tip}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        activeSignals[uniqueKey] = { 
            timestamp: Date.now(), 
            ...sinyal 
        };

        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        
        Object.keys(activeSignals).forEach(key => {
            if (activeSignals[key].timestamp < oneHourAgo) {
                delete activeSignals[key];
            }
        });

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(JSON.stringify({
                        type: 'signals',
                        data: Object.values(activeSignals)
                            .sort((a, b) => b.timestamp - a.timestamp)
                            .slice(0, 50)
                    }));
                } catch (error) {
                    console.log('❌ WebSocket gönderme hatası:', error.message);
                }
            }
        });

    } catch (error) {
        console.error('❌ Broadcast hatası:', error.message);
    }
}

app.post('/api/close-position', async (req, res) => {
    if (!CONFIG.isApiConfigured) {
        return res.status(503).json({ success: false, message: "API yapılandırılmamış" });
    }

    const { symbol } = req.body;
    console.log(`🔧 Pozisyon kapatma isteği: ${symbol}`);

    try {
        await syncOpenPositions();
        
        const positions = await bitget.fetchPositions();
        const activePositions = positions.filter(pos => parseFloat(pos.contracts || 0) > 0);
        
        const position = activePositions.find(pos => 
            pos.symbol === symbol || 
            cleanSymbol(pos.symbol) === cleanSymbol(symbol)
        );
        
        if (!position) {
            openPositions = openPositions.filter(p => p.symbol !== symbol);
            return res.json({ 
                success: true, 
                message: "Pozisyon zaten kapalı",
                alreadyClosed: true 
            });
        }

        const side = position.side.toLowerCase() === 'long' ? 'sell' : 'buy';
        const amount = Math.abs(parseFloat(position.contracts));

        const orderParams = {
            'marginCoin': 'USDT',
            'productType': 'USDT-FUTURES',
            'reduceOnly': true
        };

        const order = await bitget.createOrder(
            position.symbol, 
            'market', 
            side, 
            amount, 
            undefined, 
            orderParams
        );

        openPositions = openPositions.filter(p => p.symbol !== symbol);
        
        console.log(`✅ Pozisyon kapatıldı: ${position.symbol} | Order: ${order.id}`);
        
        res.json({ 
            success: true, 
            message: `Pozisyon kapatıldı (${position.symbol})`,
            orderId: order.id 
        });

    } catch (e) {
        console.error(`❌ Pozisyon kapatma hatası (${symbol}):`, e.message);
        
        openPositions = openPositions.filter(p => p.symbol !== symbol);
        
        res.status(500).json({ 
            success: false, 
            message: `Hata: ${e.message}`
        });
    }
});

app.get('/api/positions', async (req, res) => {
    if (!CONFIG.isApiConfigured) return res.json([]);

    try {
        await syncOpenPositions();
        
        const enrichedPositions = openPositions.map(position => {
            const entryPrice = parseFloat(position.entryPrice);
            const currentPrice = parseFloat(position.markPrice);
            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
            const leverage = position.leverage || CONFIG.leverage;
            
            return {
                ...position,
                entryPrice: entryPrice,
                currentPrice: currentPrice,
                pnlPercent: pnlPercent * (position.side === 'long' ? 1 : -1),
                leverage: leverage,
                openTime: position.timestamp ? new Date(position.timestamp).toLocaleTimeString('tr-TR') : 'Bilinmiyor'
            };
        });
        
        res.json(enrichedPositions);
    } catch (e) {
        console.error('❌ Pozisyon çekme hatası:', e.message);
        res.json([]);
    }
});

app.post('/execute-trade', async (req, res) => {
    if (!CONFIG.isApiConfigured) {
        return res.status(503).json({ success: false, message: "API yapılandırılmamış" });
    }

    const sinyal = req.body;

    try {
        await syncOpenPositions();
        
        if (openPositions.length >= CONFIG.maxPositions) {
            return res.status(409).json({ 
                success: false, 
                message: `Maksimum ${CONFIG.maxPositions} pozisyon açılabilir!` 
            });
        }

        await placeDynamicOrder(sinyal, 'NORMAL');
        res.json({ success: true, message: "İşlem gönderildi!" });

    } catch (e) {
        console.error('❌ İşlem hatası:', e.message);
        res.status(500).json({ success: false, message: `Hata: ${e.message}` });
    }
});

app.get('/health', async (req, res) => {
    const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toLocaleTimeString('tr-TR'),
        apiConfigured: CONFIG.isApiConfigured,
        autoTrade: CONFIG.autoTradeEnabled,
        activeSignals: Object.keys(activeSignals).length,
        openPositions: openPositions.length,
        availableCoins: availableSymbols.length,
        minVolume: CONFIG.minVolumeUSD
    };

    if (CONFIG.isApiConfigured) {
        try {
            const balance = await bitget.fetchBalance({ type: 'swap' });
            healthStatus.balance = balance.total?.USDT || 0;
        } catch (e) {
            healthStatus.balanceError = e.message;
        }
    }

    res.json(healthStatus);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/app.html');
});

// ==========================================================
// 🔍 ÖN TARAMA
// ==========================================================

async function runPreScan() {
    console.log(`\n💰 DYNAMIC ÖN TARAMA BAŞLADI (${new Date().toLocaleTimeString('tr-TR')})`);
    
    try {
        if (!bitget.markets || Object.keys(bitget.markets).length === 0) {
            await bitget.loadMarkets();
        }

        const allSymbols = Object.keys(bitget.markets)
            .filter(symbol => {
                const market = bitget.markets[symbol];
                const isUSDTFuture = symbol.includes('USDT') && 
                                   (symbol.includes(':') || market.swap);
                const isActive = market.active;
                const notBlacklisted = !CONFIG.blacklist.some(bl => symbol.includes(bl));
                
                return isUSDTFuture && isActive && notBlacklisted;
            });

        console.log(`📊 ${allSymbols.length} futures coin bulundu, volume kontrolü yapılıyor...`);

        const volumeFilteredSymbols = [];
        const batchSize = 20;
        
        for (let i = 0; i < allSymbols.length; i += batchSize) {
            const batch = allSymbols.slice(i, i + batchSize);
            const promises = batch.map(async (symbol) => {
                try {
                    const ticker = await bitget.fetchTicker(symbol);
                    const dailyVolume = ticker.quoteVolume || 0;
                    
                    if (dailyVolume >= CONFIG.minVolumeUSD) {
                        return {
                            symbol: symbol,
                            volume: dailyVolume,
                            price: ticker.last
                        };
                    }
                } catch (error) {
                    return null;
                }
                return null;
            });

            const results = await Promise.all(promises);
            const validSymbols = results.filter(item => item !== null);
            volumeFilteredSymbols.push(...validSymbols);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            console.log(`✅ Batch ${Math.floor(i/batchSize) + 1} tamamlandı: ${validSymbols.length} coin geçti`);
        }

        volumeFilteredSymbols.sort((a, b) => b.volume - a.volume);
        availableSymbols = volumeFilteredSymbols.map(item => cleanSymbol(item.symbol));

        console.log(`🎯 ${availableSymbols.length} coin ${CONFIG.minVolumeUSD.toLocaleString()}+ volume barajını geçti`);
        
        if (volumeFilteredSymbols.length > 0) {
            const totalVolume = volumeFilteredSymbols.reduce((sum, item) => sum + item.volume, 0);
            const avgVolume = totalVolume / volumeFilteredSymbols.length;
            const maxVolume = Math.max(...volumeFilteredSymbols.map(item => item.volume));
            
            console.log(`💰 Volume Stats: Avg: $${(avgVolume/1000000).toFixed(2)}M | Max: $${(maxVolume/1000000).toFixed(2)}M`);
            console.log(`📈 İlk 10 yüksek hacimli coin:`, availableSymbols.slice(0, 10));
        }

    } catch (error) {
        console.error('❌ Dynamic ön tarama hatası:', error);
    }
}

// ==========================================================
// 🔄 TARAMA SİSTEMİ
// ==========================================================

async function scanMarkets() {
    if (availableSymbols.length === 0 || currentScanIndex >= availableSymbols.length) {
        await runPreScan();
        return;
    }
    
    console.log(`\n🔍 ${availableSymbols.length} coin AI analizi... (${new Date().toLocaleTimeString('tr-TR')})`);
    
    let newSignals = 0;
    const endIndex = Math.min(currentScanIndex + CONFIG.scanCoinsPerCycle, availableSymbols.length);
    const coinsToScan = availableSymbols.slice(currentScanIndex, endIndex);
    
    for (const coin of coinsToScan) {
        try {
            const hasSignal = await checkAutonomousAIStrategy(coin);
            if (hasSignal) newSignals++;
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
            if (!e.message.includes('404') && !e.message.includes('No market symbol')) {
                console.error(`❌ Tarama hatası (${coin}):`, e.message);
            }
        }
    }

    currentScanIndex = endIndex;
    if (currentScanIndex >= availableSymbols.length) {
        currentScanIndex = 0;
    }

    console.log(`🎯 ${newSignals} yeni sinyal | Toplam: ${Object.keys(activeSignals).length} | Sonraki: ${currentScanIndex}`);
}

async function checkAutonomousAIStrategy(coin) {
    let originalSymbol;
    
    try {
        originalSymbol = getOriginalSymbol(coin);

        const ltfCandles = await bitget.fetchOHLCV(originalSymbol, '15m', undefined, 35);
        if (ltfCandles.length < 26) return false;

        const ltfCloses = ltfCandles.map(c => parseFloat(c[4])).filter(price => !isNaN(price) && price > 0);
        if (ltfCloses.length < 26) return false;

        const currentPrice = ltfCloses[ltfCloses.length - 1];

        let rsi, bb, macd;
        try {
            const rsiValues = ltfCloses.slice(-15);
            rsi = ti.RSI.calculate({ period: 14, values: rsiValues });
        } catch (e) {
            return false;
        }
        
        try {
            const bbValues = ltfCloses.slice(-21);
            bb = ti.BollingerBands.calculate({ period: 20, stdDev: 2, values: bbValues });
        } catch (e) {
            return false;
        }
        
        try {
            macd = ti.MACD.calculate({ 
                fastPeriod: 12, 
                slowPeriod: 26, 
                signalPeriod: 9, 
                values: ltfCloses 
            });
        } catch (e) {
            return false;
        }

        if (!rsi || rsi.length < 1 || !bb || bb.length < 1 || !macd || macd.length < 1) {
            return false;
        }

        const lastRsi = rsi[rsi.length - 1];
        const lastBB = bb[bb.length - 1];
        const lastMACD = macd[macd.length - 1];

        if (!lastMACD || lastMACD.MACD === undefined) {
            return false;
        }

        const volumeInfo = await getVolumeInfo(originalSymbol);

        const technicalData = {
            rsi: lastRsi,
            macd: lastMACD.MACD,
            macdSignal: lastMACD.signal,
            macdHistogram: lastMACD.histogram,
            bbUpper: lastBB.upper,
            bbLower: lastBB.lower,
            currentPrice: currentPrice,
            volumeRatio: volumeInfo.dailyVolume > 1000000 ? 2 : 1,
            priceChange24h: 0,
            trend: currentPrice >= lastBB.middle ? 'LONG' : 'SHORT',
            signalDirection: currentPrice <= lastBB.lower ? 'LONG' : 
                           currentPrice >= lastBB.upper ? 'SHORT' : 'NEUTRAL'
        };

        const aiDecision = await autonomousAI.makeTradingDecision(
            coin, 
            technicalData, 
            openPositions
        );

        if (aiDecision.execute) {
            console.log(`🎯 ${coin} ${aiDecision.direction} SİNYAL! Güven: ${aiDecision.confidence}%`);
            await createAutonomousAISignal(coin, aiDecision, currentPrice, originalSymbol, volumeInfo);
            return true;
        }

        return false;

    } catch (e) {
        console.error(`❌ Analiz hatası (${coin}):`, e.message);
        return false;
    }
}

// ==========================================================
// 💰 İŞLEM SİSTEMİ - DÜZELTİLMİŞ OTOMATİK TRADE
// ==========================================================

async function placeDynamicOrder(sinyal, positionSize) {
    const logPrefix = "[OTONOM AI]";
    
    if (!CONFIG.isApiConfigured) {
        throw new Error("API yapılandırılmamış");
    }

    const symbol = sinyal.ccxt_symbol;

    try {
        console.log(`${logPrefix} ${symbol} işlem hazırlığı...`);

        await syncOpenPositions();
        
        const balance = await bitget.fetchBalance({ type: 'swap' });
        const totalEquity = balance.total?.USDT || 0;
        
        let riskMultiplier = 1.0;
        switch (positionSize) {
            case 'LARGE':
                riskMultiplier = 1.2;
                break;
            case 'SMALL':
                riskMultiplier = 0.6;
                break;
            default:
                riskMultiplier = 1.0;
        }
        
        const marginAmountUSD = (totalEquity * CONFIG.orderRiskPercent * riskMultiplier) / 100;

        const side = sinyal.taraf.toLowerCase() === 'long' ? 'buy' : 'sell';
        const ticker = await bitget.fetchTicker(symbol);
        const lastPrice = ticker.last;

        if (!lastPrice || lastPrice <= 0) {
            throw new Error('Fiyat alınamadı');
        }

        const positionValueUSD = marginAmountUSD * CONFIG.leverage;
        const orderAmountInCoins = positionValueUSD / lastPrice;
        const market = bitget.markets[symbol];
        const precision = market?.precision?.amount || 3;
        let amount = Math.floor(orderAmountInCoins * Math.pow(10, precision)) / Math.pow(10, precision);

        const minAmount = market?.limits?.amount?.min || 0.001;
        if (amount < minAmount) {
            console.log(`📏 Miktar ayarı: ${amount} → ${minAmount}`);
            amount = minAmount;
        }

        if (amount <= 0) {
            throw new Error('Hesaplanan miktar çok düşük');
        }

        console.log(`${logPrefix} Emir: ${side} ${amount} ${symbol} ~ $${positionValueUSD.toFixed(2)} | Marjin: $${marginAmountUSD.toFixed(2)}`);

        // 🎯 DÜZELTİLDİ: ESKİ ÇALIŞAN ORDER PARAMETRELERİ
        const orderParams = {
            'marginCoin': 'USDT',
            'productType': 'USDT-FUTURES',
            'tradeSide': 'open'  // Yeni pozisyon açmak için 'open' kullan
        };

        // Mevcut pozisyon kontrolü
        const existingPosition = openPositions.find(pos => pos.symbol === symbol);
        
        if (existingPosition) {
            console.log(`⚠️ Mevcut pozisyon tespit edildi: ${existingPosition.symbol} - ${existingPosition.side}`);
            
            // Eğer aynı sembolde pozisyon varsa ve ters yönde işlem yapılıyorsa
            if (existingPosition.side !== side) {
                console.log(`🔄 Ters yönde işlem tespit edildi: ${existingPosition.side} → ${side}`);
                // Önce mevcut pozisyonu kapat
                await closeExistingPosition(existingPosition);
            } else {
                // Aynı yönde pozisyon varsa, işlemi iptal et
                console.log(`❌ Aynı yönde pozisyon mevcut: ${existingPosition.side}`);
                throw new Error(`Zaten ${existingPosition.side} pozisyonunuz var`);
            }
        }

        // 🎯 YENİ POZİSYON AÇ
        const order = await bitget.createOrder(symbol, 'market', side, amount, undefined, orderParams);

        // Pozisyon listesini güncelle
        const newPosition = {
            symbol: symbol,
            side: side,
            amount: amount,
            entryPrice: lastPrice,
            openTime: new Date().toLocaleTimeString('tr-TR'),
            signal: sinyal,
            orderId: order.id,
            timestamp: Date.now()
        };

        openPositions.push(newPosition);

        console.log(`✅ ${logPrefix} İşlem açıldı: ${order.id}`);

        return order;

    } catch (e) {
        console.error(`❌ ${logPrefix} Hata (${symbol}):`, e.message);
        
        if (e.message.includes('insufficient balance')) {
            throw new Error(`Yetersiz bakiye! Mevcut: $${(balance?.total?.USDT || 0).toFixed(2)}`);
        }
        
        // Unilateral position hatası durumunda
        if (e.message.includes('40774') || e.message.includes('unilateral position')) {
            console.log(`🔄 Unilateral position hatası, pozisyon senkronizasyonu yapılıyor...`);
            await syncOpenPositions();
            throw new Error(`Unilateral position hatası. Lütfen manuel olarak kontrol edin.`);
        }
        
        throw e;
    }
}

// 🎯 YENİ FONKSİYON: Mevcut pozisyonu kapat
async function closeExistingPosition(position) {
    try {
        console.log(`🔧 Mevcut pozisyon kapatılıyor: ${position.symbol} - ${position.side}`);
        
        const closeSide = position.side.toLowerCase() === 'long' ? 'sell' : 'buy';
        const amount = Math.abs(position.amount);

        const closeParams = {
            'marginCoin': 'USDT',
            'productType': 'USDT-FUTURES',
            'tradeSide': 'close'  // Pozisyon kapatma için 'close' kullan
        };

        const closeOrder = await bitget.createOrder(
            position.symbol, 
            'market', 
            closeSide, 
            amount, 
            undefined, 
            closeParams
        );

        // Pozisyon listesinden kaldır
        openPositions = openPositions.filter(p => p.symbol !== position.symbol);
        
        console.log(`✅ Mevcut pozisyon kapatıldı: ${position.symbol} | Order: ${closeOrder.id}`);
        
        return closeOrder;
        
    } catch (error) {
        console.error(`❌ Mevcut pozisyon kapatma hatası:`, error.message);
        throw error;
    }
}

// ==========================================================
// 🔄 OTOMATİK SİSTEM
// ==========================================================

async function runScanLoop() {
    try {
        await scanMarkets();
    } catch (e) {
        console.error("❌ Tarama döngüsü hatası:", e.message);
    } finally {
        setTimeout(runScanLoop, CONFIG.scanInterval);
    }
}

async function runPreScanLoop() {
    try {
        await runPreScan();
    } catch (e) {
        console.error("❌ Ön tarama döngüsü hatası:", e.message);
    } finally {
        setTimeout(runPreScanLoop, CONFIG.preScanInterval);
    }
}

async function startScreener() {
    console.log(`\n🤖 SONNY AI TRADER v6.3 - OTOMATİK TRADE DÜZELTİLMİŞ`);
    console.log(`🎯 Dynamic Volume Filter: $${CONFIG.minVolumeUSD.toLocaleString()}+ USD`);
    console.log(`⚡ Risk: %${CONFIG.orderRiskPercent} | Kaldıraç: ${CONFIG.leverage}x | Min Güven: ${CONFIG.minAutoConfidence}%`);
    console.log(`🔗 http://localhost:${PORT}\n`);
    
    try {
        await bitget.loadMarkets();
        console.log("✅ Bitget bağlantısı kuruldu");

        if (CONFIG.isApiConfigured) {
            const balance = await bitget.fetchBalance({ type: 'swap' });
            const totalBalance = balance.total?.USDT || 0;
            console.log(`💰 Bakiye: $${totalBalance.toFixed(2)}`);
            
            await syncOpenPositions();
            console.log(`📊 Başlangıç pozisyonları: ${openPositions.length}`);
        }

    } catch (e) {
        console.error("❌ Başlangıç hatası:", e.message);
        return;
    }

    await runPreScan();
    runScanLoop();
    runPreScanLoop();
    
    setInterval(syncOpenPositions, 10000);
}

// ==========================================================
// 🚀 SUNUCU BAŞLATMA
// ==========================================================

server.listen(PORT, () => {
    console.log(`🚀 Sonny AI Trader sunucusu ${PORT} portunda başlatıldı`);
    startScreener();
});

process.on('SIGINT', () => {
    console.log('\n\n🛑 Sonny AI Trader kapatılıyor...');
    process.exit(0);
});
