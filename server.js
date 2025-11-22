/** 
 * server.js - TrendMaster SNIPER AI v38.0 - Çoklu Kullanıcı Sistemi
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/* ====================== BOOT ====================== */
console.log('=== SERVER BOOT (TrendMaster v38.0 - ÇOKLU KULLANICI) ===');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'trendmaster-super-secret-key-2024';

/* ====================== VERİTABANI (JSON Dosyası) ====================== */
const fs = require('fs');
const DB_FILE = './users.json';

// Veritabanını yükle
function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Veritabanı yükleme hatası:', error);
    }
    return { users: [], signals: [] };
}

// Veritabanını kaydet
function saveDatabase(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        return true;
    } catch (error) {
        console.error('Veritabanı kaydetme hatası:', error);
        return false;
    }
}

// İlk kullanıcıyı oluştur (admin)
function initializeDatabase() {
    let db = loadDatabase();
    if (db.users.length === 0) {
        const adminPassword = bcrypt.hashSync('admin123', 10);
        db.users.push({
            id: 1,
            email: 'admin@trendmaster.com',
            password: adminPassword,
            fullName: 'Sistem Yöneticisi',
            phone: '+905551234567',
            subscription: 'premium',
            status: 'approved',
            role: 'admin',
            apiKeys: {
                bitget: { apiKey: '', secret: '', password: '', isActive: false },
                binance: { apiKey: '', secret: '', isActive: false }
            },
            settings: {
                minConfidence: 70,
                leverage: 10,
                marginPercent: 5,
                orderType: 'limit',
                autotrade: false
            },
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString()
        });
        saveDatabase(db);
        console.log('✅ Admin kullanıcı oluşturuldu: admin@trendmaster.com / admin123');
    }
    return db;
}

let database = initializeDatabase();

/* ====================== AUTH MIDDLEWARE ====================== */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Erişim tokenı gerekli' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    });
}

function isAdmin(req, res, next) {
    const user = database.users.find(u => u.id === req.user.userId);
    if (user && user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin yetkisi gerekli' });
    }
}

/* ====================== GELİŞMİŞ KONFİGURASYON ====================== */
const DEFAULT_CONFIG = {
    leverage: 10,
    marginPercent: 5,
    maxPositions: 5,
    dailyTradeLimit: 30,
    orderType: 'limit',
    limitOrderPriceOffset: 0.1,
    orderTimeoutMs: 30000,
    minConfidenceForAuto: 70,
    minVolumeUSD: 300000,
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.5,
    signalCooldownMs: 30 * 60 * 1000,
    minPrice: 0.05,
    timeframes: ['1h', '4h'],
    timeframeWeights: { '1h': 0.6, '4h': 0.4 },
    maxSlippagePercent: 1.5,
    autotradeMaster: false,
    scanBatchSize: 8,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,
    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 20,
    optimalTradingHours: [7,8,9,13,14,15,19,20,21],
    enableTimeFilter: false,
    snrTolerancePercent: 2.0,
    useSimpleSnR: true
};

/* ====================== GLOBAL DEĞİŞKENLER ====================== */
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const correlationCache = new Map();

// Sinyal cache süresi 1 saat (60 dakika)
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

/* ====================== GELİŞMİŞ YARDIMCILAR ====================== */
const requestQueue = {
    queue: [], running: 0, concurrency: 6,
    push(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.next();
        });
    },
    async next() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        const item = this.queue.shift();
        this.running++;
        try { item.resolve(await item.fn()); } 
        catch (e) { item.reject(e); }
        finally { this.running--; this.next(); }
    }
};

class EnhancedHelpers {
    static async delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    static cleanSymbol(symbol) {
        if (!symbol) return '';
        const parts = symbol.split('/');
        return parts[0] + '/USDT';
    }

    static roundToTick(price) {
        if (!price || isNaN(price)) return 0;
        if (price < 0.00001) return Number(price.toFixed(8));
        if (price < 0.001) return Number(price.toFixed(7));
        if (price < 1) return Number(price.toFixed(5));
        if (price < 10) return Number(price.toFixed(4));
        return Number(price.toFixed(2));
    }

    static async fetchOHLCV(exchange, symbol, timeframe, limit = 100) {
        const key = `${symbol}_${timeframe}`;
        const cached = ohlcvCache.get(key);
        if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
        try {
            const data = await requestQueue.push(() => exchange.fetchOHLCV(symbol, timeframe, undefined, limit));
            if (data && data.length) ohlcvCache.set(key, { data, ts: Date.now() });
            return data;
        } catch (e) { 
            console.log(`   ❌ OHLCV hatası ${symbol}:`, e.message);
            return null; 
        }
    }

    static async fetchMultiTimeframeOHLCV(exchange, symbol, timeframes) {
        const results = {};
        for (const tf of timeframes) {
            results[tf] = await this.fetchOHLCV(exchange, symbol, tf, 100);
            await this.delay(100);
        }
        return results;
    }
    
    static findSimpleSnR(ohlcv1h) {
        if (!ohlcv1h || ohlcv1h.length < 20) return { support: 0, resistance: 0 };
        
        const recentCandles = ohlcv1h.slice(-20);
        const highs = recentCandles.map(c => c[2]);
        const lows = recentCandles.map(c => c[3]);
        
        const support = Math.min(...lows);
        const resistance = Math.max(...highs);
        
        return {
            support: this.roundToTick(support),
            resistance: this.roundToTick(resistance),
            quality: Math.abs(resistance - support) / ((resistance + support) / 2)
        };
    }

    static calculateVolumeRatio(volumes, period = 20) {
        if (!volumes || volumes.length < period) return 1;
        
        const currentVolume = volumes[volumes.length - 1];
        const recentVolumes = volumes.slice(-period);
        const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
        
        return currentVolume / avgVolume;
    }

    static analyzeMarketStructure(ohlcv1h) {
        if (!ohlcv1h || ohlcv1h.length < 10) return "RANGING";

        const highs = ohlcv1h.map(c => c[2]);
        const lows = ohlcv1h.map(c => c[3]);

        const lastHigh = Math.max(...highs.slice(-5));
        const prevHigh = Math.max(...highs.slice(-10, -5));
        const lastLow = Math.min(...lows.slice(-5));
        const prevLow = Math.min(...lows.slice(-10, -5));

        if (lastHigh > prevHigh && lastLow > prevLow) return "BULLISH";
        if (lastHigh < prevHigh && lastLow < prevLow) return "BEARISH";
        return "RANGING";
    }

    static async confirmBreakoutWithVolume(exchange, symbol, breakoutLevel, direction) {
        const recentOhlcv = await this.fetchOHLCV(exchange, symbol, '5m', 15);
        if (!recentOhlcv || recentOhlcv.length < 10) {
            console.log(`   📊 ${symbol}: Hacim verisi yetersiz - ZAYIF SİNYAL`);
            return { confirmed: false, strength: 'WEAK', ratio: 0 };
        }

        const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
        const volumes = recentOhlcv.map(c => c[5]);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

        const volumeRatio = breakoutCandle[5] / avgVolume;
        let volumeConfirmed = volumeRatio > DEFAULT_CONFIG.volumeConfirmationThreshold;
        let strength = 'WEAK';
        
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';
        else strength = 'WEAK';

        console.log(`   📊 ${symbol}: Hacim ${volumeRatio.toFixed(2)}x (Min: ${DEFAULT_CONFIG.volumeConfirmationThreshold}x) - ${volumeConfirmed ? '✅' : '⚠️'} (${strength})`);

        return { 
            confirmed: volumeConfirmed, 
            strength: strength,
            ratio: volumeRatio
        };
    }

    static isOptimalTradingTime() {
        if (!DEFAULT_CONFIG.enableTimeFilter) return true;
        const hour = new Date().getUTCHours();
        return DEFAULT_CONFIG.optimalTradingHours.includes(hour);
    }

    static findSimilarAssets(coin) {
        const correlations = {
            'BTC': ['ETH', 'SOL', 'AVAX', 'MATIC', 'BNB'],
            'ETH': ['BTC', 'SOL', 'AVAX', 'MATIC', 'BNB'],
            'SOL': ['BTC', 'ETH', 'AVAX', 'MATIC', 'BNB'],
            'AVAX': ['BTC', 'ETH', 'SOL', 'MATIC'],
            'MATIC': ['BTC', 'ETH', 'SOL', 'AVAX']
        };

        const cleanCoin = coin.replace('/USDT', '').replace(':USDT', '');
        for (const [main, similar] of Object.entries(correlations)) {
            if (cleanCoin.includes(main)) return similar;
        }
        return [];
    }
}

/* ====================== TEKNİK ANALİZ TRADER ====================== */
class TechnicalAnalysisTrader {
    
    getPrediction(symbol, features, rr, currentPrice, snr, marketStructure) {
        console.log(`   🤖 ${symbol}: Teknik Analiz modu aktif...`);

        const priceToResistance = Math.abs(currentPrice - snr.resistance);
        const priceToSupport = Math.abs(currentPrice - snr.support);
        
        const closerToResistance = priceToResistance < priceToSupport;
        
        let direction = 'HOLD';
        let confidence = features.mtfScore;
        let reasoning = "";

        // GÜÇLÜ SİNYAL KOŞULLARI
        if (closerToResistance && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure === 'BULLISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 35;
            reasoning = `🚀 GÜÇLÜ SİNYAL: Direnç kırılımı bekleniyor (${snr.resistance}) - Tüm göstergeler uyumlu`;
        } 
        else if (!closerToResistance && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure === 'BEARISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 35;
            reasoning = `🔻 GÜÇLÜ SİNYAL: Destek kırılımı bekleniyor (${snr.support}) - Tüm göstergeler uyumlu`;
        }
        // ORTA SİNYAL KOŞULLARI
        else if (closerToResistance && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure !== 'BEARISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 25;
            reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance}) - Yükseliş trendi aktif`;
        }
        else if (!closerToResistance && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure !== 'BULLISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 25;
            reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support}) - Düşüş trendi aktif`;
        }
        // ZAYIF SİNYAL KOŞULLARI
        else if (features.rsi < 35 && closerToResistance && features.volumeRatio > 1.5) {
            direction = 'LONG_BREAKOUT';
            confidence += 20;
            reasoning = `📈 Aşırı satım + hacim - Potansiyel yükseliş`;
        }
        else if (features.rsi > 65 && !closerToResistance && features.volumeRatio > 1.5) {
            direction = 'SHORT_BREAKOUT';
            confidence += 20;
            reasoning = `📉 Aşırı alım + hacim - Potansiyel düşüş`;
        }
        else {
            direction = 'HOLD';
            reasoning = "❌ Yetersiz sinyal kalitesi - Trend, S&R veya hacim uyumsuz";
            confidence = Math.max(30, confidence - 15);
        }

        console.log(`   🤖 [TEKNİK ANALİZ] ${direction} (Güven: ${confidence}) - ${reasoning}`);
        return { direction, confidence: Math.round(confidence), reasoning };
    }
}

const technicalTrader = new TechnicalAnalysisTrader();

/* ====================== GELİŞMİŞ AI CONFIDENCE ENGINE ====================== */
class AdvancedAIConfidenceEngine {
    
    calculateSignalQuality(signal, marketStructure, volumeInfo, trendAlignment, adx, rsi, riskReward) {
        let qualityScore = signal.confidence;
        
        if (volumeInfo.strength === 'STRONG') qualityScore += 20;
        else if (volumeInfo.strength === 'MEDIUM') qualityScore += 10;
        else if (volumeInfo.strength === 'WEAK') qualityScore -= 10;

        if (marketStructure === trendAlignment) qualityScore += 15;
        if (riskReward > 2.5) qualityScore += 5;
        if (adx > DEFAULT_CONFIG.minTrendStrength) qualityScore += 10;

        if (adx < 20) qualityScore -= 10;
        if (rsi > 80 || rsi < 20) qualityScore -= 5;
        if (!volumeInfo.confirmed) qualityScore -= 15;

        return Math.min(100, Math.max(0, qualityScore));
    }

    calculateDynamicPositionSize(volatilityFactor, confidence, signalQuality) {
        const baseSize = 1.0;
        const volAdjustment = volatilityFactor > 1.3 ? 0.7 : 1.0;
        const confidenceBoost = confidence > 80 ? 1.2 : 1.0;
        const qualityBoost = signalQuality > 80 ? 1.1 : 1.0;
        
        const size = baseSize * volAdjustment * confidenceBoost * qualityBoost;
        return Math.min(2.0, Math.max(0.5, size));
    }

    calculateAdaptiveSL(currentPrice, atr, trendStrength, volatility, signalQuality) {
        let baseMultiplier = DEFAULT_CONFIG.atrSLMultiplier;
        
        if (trendStrength > 60) baseMultiplier *= 0.8;
        if (volatility > 1.4) baseMultiplier *= 1.3;
        if (signalQuality > 80) baseMultiplier *= 0.9;
        
        return baseMultiplier * atr;
    }

    calculateAIDecision(matrix, trendDirection, signalQuality) {
        const totalScore = 
            matrix.technical * 0.70 + 
            matrix.market * 0.20 +    
            matrix.risk * 0.05 +      
            matrix.performance * 0.05;
            
        const confidence = Math.min(100, Math.max(0, Math.round(totalScore)));
        
        let execute = false;
        let direction = trendDirection;
        let positionSize = 'NORMAL';
        let reasoning = "";
        let riskLevel = "MEDIUM";
        
        if (confidence >= DEFAULT_CONFIG.minConfidenceForAuto && matrix.risk >= 55 && signalQuality >= 60) {
            execute = true;
            positionSize = confidence >= 85 ? 'LARGE' : 'NORMAL';
            reasoning = `✅ ${direction} SİNYAL | Kalite: ${signalQuality}`;
            riskLevel = confidence >= 80 ? "LOW" : "MEDIUM";
        }
        else {
            execute = false;
            reasoning = "❌ YETERSİZ GÜVEN VEYA KALİTE";
            riskLevel = "HIGH";
        }

        return { execute, direction, confidence, positionSize, reasoning, riskLevel, signalQuality };
    }

    createDecisionMatrix(technicalScore, marketScore, riskScore, performanceScore) {
        return { technical: technicalScore, market: marketScore, risk: riskScore, performance: performanceScore };
    }
}

const advancedAIEngine = new AdvancedAIConfidenceEngine();

/* ====================== GELİŞMİŞ STRATEJİ ====================== */
class EnhancedTrendMasterAIStrategy {
    async analyze(exchange, symbol) {
        console.log(`\n🔍 [ANALİZ] ${symbol} başlıyor...`);

        try {
            if (!EnhancedHelpers.isOptimalTradingTime()) {
                const hour = new Date().getUTCHours();
                console.log(`   ⏰ ${symbol}: Optimal zaman değil (UTC: ${hour}) - Atlandı`);
                return null;
            }

            const lastSignalTime = signalHistory.get(symbol) || 0;
            if (Date.now() - lastSignalTime < DEFAULT_CONFIG.signalCooldownMs) {
                console.log(`   ⏰ ${symbol}: Cooldown süresinde - Atlandı`);
                return null;
            }

            const ticker = await requestQueue.push(() => exchange.fetchTicker(symbol));
            if (!ticker || ticker.last < DEFAULT_CONFIG.minPrice) {
                console.log(`   💰 ${symbol}: Fiyat çok düşük veya ticker yok - Atlandı`);
                return null;
            }

            console.log(`   📊 ${symbol}: Fiyat ${ticker.last} - OHLCV verileri alınıyor...`);
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(exchange, symbol, DEFAULT_CONFIG.timeframes);
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv1h || ohlcv1h.length < 60) {
                console.log(`   📊 ${symbol}: Yetersiz OHLCV verisi - Atlandı`);
                return null;
            }

            // S&R 1h verileri ile hesaplanıyor
            const snr = EnhancedHelpers.findSimpleSnR(ohlcv1h);
            const currentPrice = ticker.last;

            console.log(`   📈 ${symbol}: 1h S&R - Destek: ${snr.support}, Direnç: ${snr.resistance}`);
            console.log(`   📈 ${symbol}: Mevcut: ${currentPrice}`);

            const snrTolerance = currentPrice * (DEFAULT_CONFIG.snrTolerancePercent / 100);
            const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

            console.log(`   📈 ${symbol}: Destek yakın: ${nearSupport}, Direnç yakın: ${nearResistance}`);

            if (!nearSupport && !nearResistance) {
                console.log(`   📈 ${symbol}: Hiçbir S&R seviyesine yakın değil - Atlandı`);
                return null;
            }

            console.log(`   📈 ${symbol}: S&R seviyelerine yakın - Devam ediliyor...`);

            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);
            console.log(`   🏗️ ${symbol}: Market Structure - ${marketStructure}`);

            const closes1h = ohlcv1h.map(c => c[4]);
            const highs1h = ohlcv1h.map(c => c[2]);
            const lows1h = ohlcv1h.map(c => c[3]);
            const volumes1h = ohlcv1h.map(c => c[5]);
            
            console.log(`   📊 ${symbol}: Teknik göstergeler hesaplanıyor...`);
            const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
            if (!tfAnalysis.isValid) {
                console.log(`   📊 ${symbol}: Multi-timeframe analiz geçersiz - Atlandı`);
                return null;
            }

            const ema9 = EMA.calculate({ period: 9, values: closes1h });
            const ema21 = EMA.calculate({ period: 21, values: closes1h });
            const rsi = RSI.calculate({ period: 14, values: closes1h });
            const adx = ADX.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            const atr = ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            const obv = OBV.calculate({ close: closes1h, volume: volumes1h });
            
            if (!ema9.length || !adx.length) {
                console.log(`   📊 ${symbol}: Gösterge hesaplama hatası - Atlandı`);
                return null;
            }

            const lastEMA9 = ema9[ema9.length - 1];
            const lastEMA21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastATR = atr[atr.length - 1];
            const prevOBV = obv[obv.length - 2] || 0;
            const lastOBV = obv[obv.length - 1];

            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes1h, 20);

            const baseVolatility = lastATR / currentPrice * 100;
            const volatilityFactor = Math.min(1.6, Math.max(0.8, baseVolatility));

            const slDist = advancedAIEngine.calculateAdaptiveSL(
                currentPrice, lastATR, lastADX, volatilityFactor, 0
            );
            const dynamicTPMultiplier = DEFAULT_CONFIG.atrTPMultiplier * volatilityFactor;
            const tpDist = lastATR * dynamicTPMultiplier;

            const assumptionDirection = lastEMA9 > lastEMA21 ? 'LONG' : 'SHORT';
            let slTemp, tp1Temp;
            if (assumptionDirection === 'LONG') {
                slTemp = currentPrice - slDist;
                tp1Temp = currentPrice + tpDist;
            } else {
                slTemp = currentPrice + slDist;
                tp1Temp = currentPrice - tpDist;
            }

            const risk = Math.abs(currentPrice - slTemp);
            const reward = Math.abs(tp1Temp - currentPrice);
            const rr = reward / risk;

            console.log(`   📊 ${symbol}: Teknik Değerler:`);
            console.log(`      📈 EMA9: ${lastEMA9?.toFixed(4)} | EMA21: ${lastEMA21?.toFixed(4)}`);
            console.log(`      🔄 RSI: ${lastRSI?.toFixed(1)} | ADX: ${lastADX?.toFixed(1)}`);
            console.log(`      📊 ATR: ${lastATR?.toFixed(4)} | Hacim Oranı: ${volumeRatio.toFixed(2)}x`);
            console.log(`      📊 Risk/Reward: ${rr.toFixed(2)} | Volatilite: ${volatilityFactor.toFixed(2)}`);

            const featuresForAI = {
                emaDirection: lastEMA9 > lastEMA21 ? 'YÜKSELİŞ TRENDİ' : 'DÜŞÜŞ TRENDİ',
                rsi: lastRSI,
                adx: lastADX,
                obvTrend: lastOBV > prevOBV ? 'YÜKSELİŞ' : 'DÜŞÜŞ',
                volumeRatio: volumeRatio,
                mtfScore: tfAnalysis.score,
                volatilityFactor: volatilityFactor,
                signalQuality: 50
            };

            const similarAssets = EnhancedHelpers.findSimilarAssets(symbol);
            const hasCorrelationRisk = await this.checkCorrelationRisk(symbol, similarAssets);
            if (hasCorrelationRisk) {
                console.log(`   ⚠️ ${symbol}: Correlation risk - Benzer coinlerle pozisyon var`);
                return null;
            }

            console.log(`   🤖 ${symbol}: Teknik analiz başlatılıyor...`);
            const aiResult = technicalTrader.getPrediction(
                symbol, featuresForAI, rr, currentPrice, snr, marketStructure
            );

            const modelDirection = aiResult.direction;
            const modelConfidence = aiResult.confidence;
            const modelReasoning = aiResult.reasoning;

            if (!modelDirection.includes('BREAKOUT') || modelConfidence < DEFAULT_CONFIG.minConfidenceForAuto) {
                console.log(`   ❌ ${symbol}: HOLD kararı veya yetersiz güven (${modelConfidence}/${DEFAULT_CONFIG.minConfidenceForAuto})`);
                return null;
            }

            console.log(`   ✅ ${symbol}: ${modelDirection} kararı (Güven: ${modelConfidence})`);

            const breakoutLevel = modelDirection === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
            console.log(`   📊 ${symbol}: Hacim doğrulaması kontrol ediliyor...`);
            const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(
                exchange, symbol, breakoutLevel, modelDirection
            );

            const signalSource = 'TEKNİK ANALİZ';
            const sourceEmoji = '📊';

            const trendAlignment = modelDirection === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH';
            const signalQuality = advancedAIEngine.calculateSignalQuality(
                aiResult, marketStructure, volumeInfo, trendAlignment, 
                lastADX, lastRSI, rr
            );

            console.log(`   📊 ${symbol}: Sinyal Kalite Skoru: ${signalQuality}`);

            const positionSizeMultiplier = advancedAIEngine.calculateDynamicPositionSize(
                volatilityFactor, modelConfidence, signalQuality
            );

            let marketScore = 50;
            if (volumeInfo.ratio > 2.0) marketScore += 30;
            else if (volumeInfo.ratio > 1.5) marketScore += 15;
            if (volatilityFactor > 1.2) marketScore += 10;
            if (marketStructure === trendAlignment) marketScore += 10;
            if (signalQuality > 80) marketScore += 10;

            const matrix = advancedAIEngine.createDecisionMatrix(
                modelConfidence, 
                marketScore, 
                80,
                systemStatus.performance.winRate * 100
            );

            const decision = advancedAIEngine.calculateAIDecision(
                matrix, modelDirection, signalQuality
            );

            if (!decision.execute) {
                console.log(`   ❌ AI Motoru işlem onaylamadı - ${decision.reasoning}`);
                return null;
            }

            signalHistory.set(symbol, Date.now());
            systemStatus.performance.totalSignals++;

            console.log(`   🎯 ${symbol}: SİNYAL OLUŞTURULDU! ${modelDirection} (Güven: ${decision.confidence}, Kalite: ${signalQuality})`);

            let entryPrice, sl_final, tp1_final;
            if (modelDirection === 'LONG_BREAKOUT') {
                entryPrice = snr.resistance;
                sl_final = entryPrice - slDist;
                tp1_final = entryPrice + tpDist;
            } else {
                entryPrice = snr.support;
                sl_final = entryPrice + slDist;
                tp1_final = entryPrice - tpDist;
            }

            const volumeText = volumeInfo.confirmed ? 
                `Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)` : 
                `Hacim Zayıf: ${volumeInfo.ratio.toFixed(2)}x`;

            const qualityText = `Kalite: ${signalQuality}${signalQuality > 80 ? ' 🚀' : signalQuality > 60 ? ' ✅' : ' ⚠️'}`;

            return {
                id: `${symbol}_${modelDirection}_${Date.now()}`,
                coin: EnhancedHelpers.cleanSymbol(symbol),
                ccxt_symbol: symbol,
                taraf: modelDirection,
                
                giris: EnhancedHelpers.roundToTick(entryPrice),
                tp1: EnhancedHelpers.roundToTick(tp1_final),
                sl: EnhancedHelpers.roundToTick(sl_final),
                riskReward: rr.toFixed(2),
                confidence: decision.confidence,
                positionSize: positionSizeMultiplier,
                positionSizeType: this.getPositionSizeType(positionSizeMultiplier),
                
                riskLevel: decision.riskLevel,
                tuyo: `${sourceEmoji} ${signalSource}: ${modelReasoning} | ${qualityText} | ${volumeText}`,
                timestamp: Date.now(),
                adx: lastADX.toFixed(0),
                rsi: lastRSI.toFixed(0),
                obvTrend: lastOBV > prevOBV ? '↑' : '↓',
                signalQuality: signalQuality,
                marketStructure: marketStructure,
                volumeConfirmed: volumeInfo.confirmed,
                signalSource: signalSource,
                isAISignal: false,
                orderType: DEFAULT_CONFIG.orderType
            };
        } catch (e) { 
            console.error(`\n❌ ${symbol} analiz hatası:`, e.message);
            return null; 
        }
    }

    async checkCorrelationRisk(newSymbol, similarAssets) {
        // Global pozisyon kontrolü - kullanıcı bazlı değil
        return false;
    }

    getPositionSizeType(multiplier) {
        if (multiplier >= 1.5) return 'LARGE';
        if (multiplier >= 1.0) return 'NORMAL';
        if (multiplier >= 0.7) return 'SMALL';
        return 'MINI';
    }

    async analyzeMultiTimeframe(multiTFData) {
        let totalScore = 0;
        let totalWeight = 0;
        let directionConsistency = 0;
        let longSignals = 0;
        let shortSignals = 0;
        
        for (const [tf, ohlcv] of Object.entries(multiTFData)) {
            if (!ohlcv || ohlcv.length < 20) continue;
            const weight = DEFAULT_CONFIG.timeframeWeights[tf] || 0.3;
            const tfAnalysis = this.analyzeSingleTimeframe(ohlcv);
            totalScore += tfAnalysis.score * weight;
            totalWeight += weight;
            if (tfAnalysis.score > 60) directionConsistency++;
            if (tfAnalysis.direction === 'LONG') longSignals++;
            if (tfAnalysis.direction === 'SHORT') shortSignals++;
        }

        const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;
        let dominantDirection = 'LONG';
        
        if (shortSignals > longSignals) {
            dominantDirection = 'SHORT';
        } else if (longSignals > shortSignals) {
            dominantDirection = 'LONG';
        } else {
            const ohlcv1h = multiTFData['1h'];
            if (ohlcv1h && ohlcv1h.length > 0) {
                const closes = ohlcv1h.map(c => c[4]);
                const ema9_1h = EMA.calculate({ period: 9, values: closes });
                const ema21_1h = EMA.calculate({ period: 21, values: closes });
                if (ema9_1h.length && ema21_1h.length) {
                    const lastEma9_1h = ema9_1h[ema9_1h.length - 1];
                    const lastEma21_1h = ema21_1h[ema21_1h.length - 1];
                    dominantDirection = lastEma9_1h < lastEma21_1h ? 'SHORT' : 'LONG';
                }
            }
        }
        
        const isValid = avgScore >= 60 && directionConsistency >= 1;
        return { 
            score: Math.round(avgScore), 
            isValid, 
            directionConsistency,
            direction: dominantDirection 
        };
    }

    analyzeSingleTimeframe(ohlcv) {
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        if (closes.length < 20) return { score: 0, direction: 'LONG' };
        
        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });
        const rsi = RSI.calculate({ period: 14, values: closes });
        const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
        
        if (!ema9.length || !adx.length) return { score: 0, direction: 'LONG' };

        const lastEMA9 = ema9[ema9.length - 1];
        const lastEMA21 = ema21[ema21.length - 1];
        const lastRSI = rsi[rsi.length - 1];
        const lastADX = adx[adx.length - 1].adx;
        
        let score = 50;
        let direction = 'LONG';

        if (lastEMA9 < lastEMA21 && lastRSI > 50) { 
            direction = 'SHORT';
            score += 15;
        } else if (lastEMA9 > lastEMA21 && lastRSI < 50) { 
            direction = 'LONG';
            score += 15;
        }

        if (lastADX > 25) score += 15;
        if (lastADX > 35) score += 10;

        if ((direction === 'LONG' && lastRSI > 40 && lastRSI < 70) ||
            (direction === 'SHORT' && lastRSI < 60 && lastRSI > 30)) {
            score += 10;
        }

        return { score: Math.min(100, score), direction };
    }
}

const enhancedTrendMaster = new EnhancedTrendMasterAIStrategy();

/* ====================== GELİŞMİŞ OTOMATİK TRADE SİSTEMİ ====================== */
class EnhancedAutoTradeSystem {
    async execute(userId, signal, isManual = false) {
        const user = database.users.find(u => u.id === userId);
        if (!user) {
            console.log(`❌ Kullanıcı bulunamadı: ${userId}`);
            return;
        }

        // Kullanıcının API key'leri var mı kontrol et
        const bitgetKeys = user.apiKeys.bitget;
        if (!bitgetKeys.isActive || !bitgetKeys.apiKey) {
            console.log(`❌ ${user.email}: API key bulunamadı veya aktif değil`);
            return;
        }

        if (!isManual && user.settings.autotrade && signal.confidence < user.settings.minConfidence) {
            console.log(`\n❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Kullanıcı min güven: ${user.settings.minConfidence} isteniyor.`);
            return; 
        }
        
        try {
            // Kullanıcıya özel exchange instance'ı oluştur
            const userExchange = new ccxt.bitget({
                apiKey: bitgetKeys.apiKey,
                secret: bitgetKeys.secret,
                password: bitgetKeys.password,
                options: { defaultType: 'swap' },
                timeout: 30000,
                enableRateLimit: true
            });

            const sourceInfo = 'TEKNİK ANALİZ';
            console.log(`\n🚀 ${user.email} İŞLEM: ${signal.coin} ${signal.taraf} | Güven: %${signal.confidence} | Kalite: ${signal.signalQuality}`);
            
            const symbol = signal.ccxt_symbol;
            
            const currentPrice = await this.getCurrentPrice(userExchange, symbol);
            
            let entryPrice = signal.giris;
            let orderType = user.settings.orderType || 'limit';
            
            if (orderType === 'limit') {
                console.log(`🎯 LİMİT EMİR: ${signal.taraf} - Giriş: ${entryPrice}`);
            } else {
                entryPrice = currentPrice;
                console.log(`⚡ MARKET EMİR: Giriş ~${entryPrice}`);
            }

            await requestQueue.push(() => userExchange.setLeverage(user.settings.leverage || 10, symbol));
            
            // Kullanıcı bakiyesi
            const balance = await requestQueue.push(() => userExchange.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            
            if (available < 10) {
                console.log('❌ Yetersiz bakiye');
                return;
            }
            
            const cost = available * ((user.settings.marginPercent || 5) / 100) * signal.positionSize;
            const amountUSDT = cost * (user.settings.leverage || 10);
            let amountCoin = amountUSDT / entryPrice;
            
            let finalAmount = amountCoin;
            try {
                const market = userExchange.markets[symbol];
                if (market && market.precision && market.precision.amount) {
                    finalAmount = userExchange.amountToPrecision(symbol, amountCoin);
                } else {
                    finalAmount = Number(amountCoin.toFixed(6));
                }
            } catch (e) {
                finalAmount = Number(amountCoin.toFixed(6));
            }
            
            const side = signal.taraf === 'LONG_BREAKOUT' ? 'buy' : 'sell';
            
            console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x`);
            
            const order = await this.placeOrder(userExchange, symbol, side, finalAmount, entryPrice, orderType);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
                
                try {
                    await this.placeTPSLOrders(userExchange, symbol, side, finalAmount, signal);
                } catch (tpslError) {
                    console.log('⚠️ TP/SL emirleri gönderilemedi:', tpslError.message);
                }
                
                systemStatus.performance.executedTrades++;
                this.updateCorrelationCache(signal.coin);
                
                console.log(`✅ ${user.email} işlem tamamlandı: ${signal.coin} ${signal.taraf}`);
            } else {
                console.log('❌ EMİR BAŞARISIZ - Order null döndü');
            }
            
        } catch (e) { 
            console.error(`❌ ${user.email} Trade Hatası:`, e.message);
        }
    }

    async placeOrder(exchange, symbol, side, amount, price, orderType) {
        try {
            if (orderType === 'limit') {
                const order = await requestQueue.push(() => 
                    exchange.createOrder(symbol, 'limit', side, amount, price)
                );
                console.log(`✅ LİMİT EMİR GÖNDERİLDİ: ${side} ${amount} @ ${price}`);
                return order;
            } else {
                const order = await requestQueue.push(() => 
                    exchange.createOrder(symbol, 'market', side, amount)
                );
                console.log(`✅ MARKET EMİR GÖNDERİLDİ: ${side} ${amount}`);
                return order;
            }
        } catch (error) {
            console.log(`❌ ${orderType.toUpperCase()} emir hatası:`, error.message);
            return null;
        }
    }

    async placeTPSLOrders(exchange, symbol, side, amount, signal) {
        try {
            const stopSide = side === 'buy' ? 'sell' : 'buy';
            
            console.log(`🎯 TP/SL AYARLANIYOR: ${symbol} | TP: ${signal.tp1} | SL: ${signal.sl}`);
            
            const slOrder = await requestQueue.push(() => 
                exchange.createOrder(symbol, 'market', stopSide, amount, undefined, {
                    stopLoss: {
                        triggerPrice: signal.sl,
                        price: signal.sl
                    }
                })
            );
            console.log(`✅ SL EMİR GÖNDERİLDİ: ${signal.sl}`);
            
            const tpOrder = await requestQueue.push(() =>
                exchange.createOrder(symbol, 'market', stopSide, amount, undefined, {
                    takeProfit: {
                        triggerPrice: signal.tp1,
                        price: signal.tp1
                    }
                })
            );
            console.log(`✅ TP EMİR GÖNDERİLDİ: ${signal.tp1}`);
            
            return { slOrder, tpOrder };
        } catch (error) {
            console.log('❌ TP/SL emir hatası:', error.message);
            throw error;
        }
    }

    async closePosition(userId, symbol, side, contracts) {
        const user = database.users.find(u => u.id === userId);
        if (!user || !user.apiKeys.bitget.isActive) {
            throw new Error('Kullanıcı veya API key bulunamadı');
        }

        try {
            const userExchange = new ccxt.bitget({
                apiKey: user.apiKeys.bitget.apiKey,
                secret: user.apiKeys.bitget.secret,
                password: user.apiKeys.bitget.password,
                options: { defaultType: 'swap' }
            });

            console.log(`\n🔻 ${user.email} POZİSYON KAPATMA: ${symbol} | ${side} | ${contracts}`);
            
            const closeAmount = Math.abs(contracts);
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            
            console.log(`💰 KAPATMA: ${closeSide} ${closeAmount} ${symbol}`);
            
            const params = {
                reduceOnly: true
            };
            
            const order = await requestQueue.push(() => 
                userExchange.createOrder(symbol, 'market', closeSide, closeAmount, undefined, params)
            );
            
            if (order) {
                console.log(`✅ ${user.email} POZİSYON KAPATILDI: ${symbol} - Order ID: ${order.id}`);
                return { success: true, orderId: order.id };
            } else {
                console.log(`❌ ${user.email} POZİSYON KAPATILAMADI: ${symbol}`);
                return { success: false, error: 'Order oluşturulamadı' };
            }
        } catch (error) {
            console.log(`❌ ${user.email} POZİSYON KAPATMA HATASI: ${error.message}`);
            throw error;
        }
    }

    updateCorrelationCache(coin) {
        correlationCache.set(coin, Date.now());
        setTimeout(() => {
            correlationCache.delete(coin);
        }, 60 * 60 * 1000);
    }

    async getCurrentPrice(exchange, symbol) {
        try {
            const ticker = await requestQueue.push(() => exchange.fetchTicker(symbol));
            return ticker?.last || 0;
        } catch {
            return 0;
        }
    }

    async getPositions(userId) {
        const user = database.users.find(u => u.id === userId);
        if (!user || !user.apiKeys.bitget.isActive) return [];

        try {
            const userExchange = new ccxt.bitget({
                apiKey: user.apiKeys.bitget.apiKey,
                secret: user.apiKeys.bitget.secret,
                password: user.apiKeys.bitget.password,
                options: { defaultType: 'swap' }
            });

            const p = await requestQueue.push(() => userExchange.fetchPositions());
            return p.filter(x => parseFloat(x.contracts) > 0);
        } catch { return []; }
    }
}

const enhancedAutoTradeSystem = new EnhancedAutoTradeSystem();

/* ====================== VOLUME SCANNER ====================== */
class VolumeFilterScanner {
    async refreshMarketList() {
        try {
            console.log('🌍 LİSTE YENİLENİYOR...');
            
            // Demo exchange için markets yükle
            const demoExchange = new ccxt.bitget({
                options: { defaultType: 'swap' },
                timeout: 30000,
                enableRateLimit: true
            });
            
            await requestQueue.push(() => demoExchange.loadMarkets(true));
            const tickers = await requestQueue.push(() => demoExchange.fetchTickers());
            const allSymbols = Object.keys(demoExchange.markets).filter(s => {
                const market = demoExchange.markets[s];
                return market.active && s.includes('USDT') && (market.swap || market.future);
            });
            const highVol = [];
            for (const sym of allSymbols) {
                const t = tickers[sym];
                if (t && (t.quoteVolume >= DEFAULT_CONFIG.minVolumeUSD)) highVol.push(sym);
            }
            highVol.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
            cachedHighVol = highVol;
            focusedSymbols = [...cachedHighVol];
            lastMarketRefresh = Date.now();
            systemStatus.filterCount = cachedHighVol.length;
            
            this.analyzeMarketSentiment(demoExchange);
            
            console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${DEFAULT_CONFIG.minVolumeUSD/1000000}M$).`);
        } catch (e) { console.error('Market refresh fail:', e.message); }
    }

    async analyzeMarketSentiment(exchange) {
        if (cachedHighVol.length === 0) return;
        const sample = cachedHighVol.slice(0, 20);
        let longCount = 0;
        let shortCount = 0;
        for(const sym of sample) {
            const ohlcv = await EnhancedHelpers.fetchOHLCV(exchange, sym, '1h', 30);
            if(!ohlcv) continue;
            const closes = ohlcv.map(c=>c[4]);
            const ema9 = EMA.calculate({period:9, values:closes});
            const ema21 = EMA.calculate({period:21, values:closes});
            if(!ema9.length) continue;
            if(ema9[ema9.length - 1] > ema21[ema9.length - 1]) longCount++; else shortCount++;
        }

        if (longCount > shortCount * 1.5) systemStatus.marketSentiment = "YÜKSELİŞ (LONG) AĞIRLIKLI 🐂";
        else if (shortCount > longCount * 1.5) systemStatus.marketSentiment = "DÜŞÜŞ (SHORT) AĞIRLIKLI 🐻";
        else systemStatus.marketSentiment = "YATAY / KARIŞIK 🦀";
    }

    async scanLoop() {
        const currentHour = new Date().getUTCHours();
        console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Mod: TEKNİK ANALİZ`);

        if (focusedSymbols.length === 0) {
            const now = Date.now();
            if (now - lastMarketRefresh > DEFAULT_CONFIG.fullSymbolRefreshMs || cachedHighVol.length === 0) {
                await this.refreshMarketList();
            } else {
                focusedSymbols = [...cachedHighVol];
                await EnhancedHelpers.delay(1000); 
            }
            return;
        }

        const batch = focusedSymbols.splice(0, DEFAULT_CONFIG.scanBatchSize); 
        console.log(`\n⚡ Tarama: ${batch.length} coin analiz ediliyor...`);
        
        // Demo exchange kullan
        const demoExchange = new ccxt.bitget({
            options: { defaultType: 'swap' },
            timeout: 30000,
            enableRateLimit: true
        });

        const validSignals = [];
        for (const sym of batch) {
            const signal = await enhancedTrendMaster.analyze(demoExchange, sym);
            if (signal) {
                validSignals.push(signal);
                console.log(`\n🎯 SİNYAL BULUNDU: ${sym} - ${signal.taraf} | TEKNİK ANALİZ (Güven: ${signal.confidence}%, Kalite: ${signal.signalQuality})`);
            }
        }
        
        if (validSignals.length > 0) {
            const shortSignals = validSignals.filter(s => s.taraf.includes('SHORT'));
            const longSignals = validSignals.filter(s => s.taraf.includes('LONG'));
            
            console.log(`\n🎯 ${validSignals.length} SİNYAL BULUNDU!`);
            console.log(`   SHORT: ${shortSignals.length} | LONG: ${longSignals.length}`);
            console.log(`   Toplam: ${systemStatus.performance.totalSignals}`);
            
            validSignals.forEach(signal => {
                broadcastSignal(signal);
                
                // Onaylı ve otomatik trade açık kullanıcılar için işlem yap
                database.users.forEach(user => {
                    if (user.status === 'approved' && user.settings.autotrade && 
                        signal.confidence >= user.settings.minConfidence) {
                        enhancedAutoTradeSystem.execute(user.id, signal);
                    }
                });
            });
        } else {
            console.log(`\n⚡ Tarama tamamlandı. Sinyal bulunamadı.`);
        }
    }
}

const scanner = new VolumeFilterScanner();

/* ====================== SİNYAL YÖNETİMİ ====================== */
function cleanupSignalCache() {
    const now = Date.now();
    let removedCount = 0;
    for (const [key, signal] of signalCache.entries()) {
        if (now - signal.timestamp > SIGNAL_CACHE_DURATION) {
            signalCache.delete(key);
            removedCount++;
        }
    }
    if (removedCount > 0) {
        console.log(`🧹 ${removedCount} eski sinyal temizlendi (1 saat)`);
        broadcastSignalList();
    }
}

setInterval(cleanupSignalCache, 5 * 60 * 1000);

function broadcastSignal(signal) {
    signalCache.set(signal.id, signal);
    broadcastSignalList();
}

function broadcastSignalList() {
    const allSignals = Array.from(signalCache.values())
        .sort((a, b) => b.timestamp - a.timestamp);
    const msg = JSON.stringify({ 
        type: 'signal_list', 
        data: allSignals 
    });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

/* ====================== AUTH API ROUTES ====================== */
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName, phone } = req.body;
        
        if (!email || !password || !fullName) {
            return res.status(400).json({ error: 'Email, şifre ve ad soyad zorunludur' });
        }

        // Email kontrolü
        const existingUser = database.users.find(u => u.email === email);
        if (existingUser) {
            return res.status(400).json({ error: 'Bu email adresi zaten kayıtlı' });
        }

        // Şifreyi hash'le
        const hashedPassword = await bcrypt.hash(password, 10);

        // Yeni kullanıcı oluştur
        const newUser = {
            id: database.users.length + 1,
            email,
            password: hashedPassword,
            fullName,
            phone: phone || '',
            subscription: 'free',
            status: 'pending',
            role: 'user',
            apiKeys: {
                bitget: { apiKey: '', secret: '', password: '', isActive: false },
                binance: { apiKey: '', secret: '', isActive: false }
            },
            settings: {
                minConfidence: 70,
                leverage: 10,
                marginPercent: 5,
                orderType: 'limit',
                autotrade: false
            },
            createdAt: new Date().toISOString(),
            approvedAt: null
        };

        database.users.push(newUser);
        saveDatabase(database);

        console.log(`✅ Yeni kullanıcı kaydı: ${email} - Onay bekliyor`);

        res.json({ 
            success: true, 
            message: 'Kayıt başarılı! Hesabınız admin onayından sonra aktif olacaktır.' 
        });

    } catch (error) {
        console.error('Kayıt hatası:', error);
        res.status(500).json({ error: 'Kayıt sırasında bir hata oluştu' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email ve şifre zorunludur' });
        }

        const user = database.users.find(u => u.email === email);
        if (!user) {
            return res.status(400).json({ error: 'Kullanıcı bulunamadı' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Geçersiz şifre' });
        }

        if (user.status !== 'approved') {
            return res.status(400).json({ error: 'Hesabınız henüz onaylanmamış' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.fullName,
                role: user.role,
                subscription: user.subscription,
                settings: user.settings
            }
        });

    } catch (error) {
        console.error('Giriş hatası:', error);
        res.status(500).json({ error: 'Giriş sırasında bir hata oluştu' });
    }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    const user = database.users.find(u => u.id === req.user.userId);
    if (!user) {
        return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    res.json({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        subscription: user.subscription,
        status: user.status,
        settings: user.settings,
        apiKeys: {
            bitget: { isActive: user.apiKeys.bitget.isActive },
            binance: { isActive: user.apiKeys.binance.isActive }
        }
    });
});

/* ====================== USER API ROUTES ====================== */
app.post('/api/user/api-keys', authenticateToken, async (req, res) => {
    try {
        const { exchange, apiKey, secret, password } = req.body;
        const userId = req.user.userId;

        if (!['bitget', 'binance'].includes(exchange)) {
            return res.status(400).json({ error: 'Geçersiz exchange' });
        }

        const user = database.users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        }

        // API key'leri doğrula
        try {
            let testExchange;
            if (exchange === 'bitget') {
                testExchange = new ccxt.bitget({
                    apiKey,
                    secret,
                    password,
                    options: { defaultType: 'swap' }
                });
            } else {
                testExchange = new ccxt.binance({
                    apiKey,
                    secret,
                    options: { defaultType: 'future' }
                });
            }

            await testExchange.fetchBalance();
            
            // API key'leri kaydet
            user.apiKeys[exchange] = {
                apiKey,
                secret,
                password: password || '',
                isActive: true
            };

            saveDatabase(database);

            res.json({ 
                success: true, 
                message: `${exchange} API key'leri başarıyla kaydedildi ve doğrulandı` 
            });

        } catch (error) {
            console.error('API key doğrulama hatası:', error);
            res.status(400).json({ error: 'API key doğrulanamadı. Lütfen bilgilerinizi kontrol edin.' });
        }

    } catch (error) {
        console.error('API key kaydetme hatası:', error);
        res.status(500).json({ error: 'API key kaydedilirken bir hata oluştu' });
    }
});

app.post('/api/user/settings', authenticateToken, (req, res) => {
    try {
        const userId = req.user.userId;
        const settings = req.body;

        const user = database.users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        }

        user.settings = { ...user.settings, ...settings };
        saveDatabase(database);

        res.json({ success: true, message: 'Ayarlar kaydedildi' });

    } catch (error) {
        console.error('Ayarlar kaydetme hatası:', error);
        res.status(500).json({ error: 'Ayarlar kaydedilirken bir hata oluştu' });
    }
});

/* ====================== ADMIN API ROUTES ====================== */
app.get('/api/admin/pending-users', authenticateToken, isAdmin, (req, res) => {
    const pendingUsers = database.users.filter(u => u.status === 'pending');
    res.json(pendingUsers.map(user => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        createdAt: user.createdAt
    })));
});

app.post('/api/admin/approve-user', authenticateToken, isAdmin, (req, res) => {
    try {
        const { userId } = req.body;
        
        const user = database.users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        }

        user.status = 'approved';
        user.approvedAt = new Date().toISOString();
        saveDatabase(database);

        console.log(`✅ Kullanıcı onaylandı: ${user.email}`);

        res.json({ success: true, message: 'Kullanıcı başarıyla onaylandı' });

    } catch (error) {
        console.error('Kullanıcı onaylama hatası:', error);
        res.status(500).json({ error: 'Kullanıcı onaylanırken bir hata oluştu' });
    }
});

app.post('/api/admin/reject-user', authenticateToken, isAdmin, (req, res) => {
    try {
        const { userId } = req.body;
        
        const user = database.users.find(u => u.id === userId);
        if (!user) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        }

        user.status = 'rejected';
        saveDatabase(database);

        console.log(`❌ Kullanıcı reddedildi: ${user.email}`);

        res.json({ success: true, message: 'Kullanıcı reddedildi' });

    } catch (error) {
        console.error('Kullanıcı reddetme hatası:', error);
        res.status(500).json({ error: 'Kullanıcı reddedilirken bir hata oluştu' });
    }
});

/* ====================== TRADING API ROUTES ====================== */
app.get('/api/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = database.users.find(u => u.id === userId);
        
        let balance = 0;
        let positions = [];

        if (user && user.apiKeys.bitget.isActive) {
            try {
                const userExchange = new ccxt.bitget({
                    apiKey: user.apiKeys.bitget.apiKey,
                    secret: user.apiKeys.bitget.secret,
                    password: user.apiKeys.bitget.password,
                    options: { defaultType: 'swap' }
                });

                const balanceData = await requestQueue.push(() => userExchange.fetchBalance());
                balance = parseFloat(balanceData.USDT?.free || 0);

                positions = await enhancedAutoTradeSystem.getPositions(userId);
            } catch (error) {
                console.error(`Bakiye/pozisyon getirme hatası (${user.email}):`, error.message);
            }
        }

        const recentSignals = Array.from(signalCache.values())
            .sort((a, b) => b.timestamp - a.timestamp);

        res.json({ 
            system: systemStatus,
            user: {
                balance,
                positions,
                settings: user.settings
            },
            signals: recentSignals
        });

    } catch (error) {
        console.error('Status getirme hatası:', error);
        res.status(500).json({ error: 'Status getirilirken bir hata oluştu' });
    }
});

app.post('/api/trade/manual', authenticateToken, async (req, res) => { 
    try {
        await enhancedAutoTradeSystem.execute(req.user.userId, req.body, true);
        res.json({ success: true });
    } catch (error) {
        console.error('Manuel trade hatası:', error);
        res.status(500).json({ error: 'Trade sırasında bir hata oluştu' });
    }
});

app.post('/api/position/close', authenticateToken, async (req, res) => { 
    try {
        const { symbol, side, contracts } = req.body;
        const result = await enhancedAutoTradeSystem.closePosition(req.user.userId, symbol, side, contracts);
        res.json(result);
    } catch (error) {
        console.error('Pozisyon kapatma hatası:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    console.log('\n⚙️  SİSTEM KONFİGURASYONU:');
    console.log(`   🎯 Min Güven: ${DEFAULT_CONFIG.minConfidenceForAuto}%`);
    console.log(`   📊 Min Hacim: ${DEFAULT_CONFIG.minVolumeUSD} USD`);
    console.log(`   🤖 AI Modu: TEKNİK ANALİZ`);
    console.log(`   👥 Çoklu Kullanıcı: AKTİF`);
    console.log(`   🔐 JWT Auth: AKTİF`);
    console.log(`   ⏰ Sinyal Saklama: 1 SAAT`);
    console.log(`   📊 Zaman Dilimleri: 1h, 4h`);
    
    console.log('\n👑 Admin Giriş Bilgileri:');
    console.log(`   📧 Email: admin@trendmaster.com`);
    console.log(`   🔑 Şifre: admin123`);
    
    await scanner.refreshMarketList(); 
    setInterval(() => scanner.scanLoop(), DEFAULT_CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, () => { 
    console.log(`🚀 UI: http://localhost:${PORT}`); 
    start(); 
});
