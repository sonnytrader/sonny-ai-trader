/** 
 * server.js - TrendMaster SNIPER AI v37.4 - RENDER UYUMLU
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

/* ====================== BOOT ====================== */
console.log('=== SERVER BOOT (TrendMaster v37.4 - RENDER UYUMLU) ===');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

/* ====================== GELİŞMİŞ KONFİGURASYON ====================== */
let CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

    geminiApiKey: process.env.GEMINI_API_KEY || '',

    // Risk Yönetimi
    leverage: 10,
    marginPercent: 5,
    maxPositions: 5,
    dailyTradeLimit: 30,

    // Filtreler
    minConfidenceForAuto: 65,
    minVolumeUSD: 500000,
    
    // Dinamik RR
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 2.5,
    
    // Diğer
    signalCooldownMs: 30 * 60 * 1000,
    minPrice: 0.05,
    
    // Multi-timeframe
    timeframes: ['15m', '1h', '4h'],
    timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
    
    // Slippage
    maxSlippagePercent: 1.5,
    autotradeMaster: false,

    // Tarama Ayarları
    scanBatchSize: 8,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,

    // YENİ: Gelişmiş Özellikler
    volumeConfirmationThreshold: 1.2,
    minTrendStrength: 20,
    optimalTradingHours: [7,8,9,13,14,15,19,20,21],
    enableTimeFilter: false,
    
    // GEMINI AYARLARI
    enableGemini: false, // 🔥 Render için kapalı
    geminiFallbackMode: true,
    snrTolerancePercent: 1.5,
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
const geminiStatus = { 
    isActive: false,  // 🔥 Render için kapalı
    lastError: 0, 
    quotaExceeded: false,
    usedFallback: true
};
const SIGNAL_CACHE_DURATION = 15 * 60 * 1000;

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    balance: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

/* ====================== GELİŞMİŞ YARDIMCILAR ====================== */
const requestQueue = {
    queue: [], running: 0, concurrency: 6,  // 🔥 Render için düşürüldü
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

    static async fetchOHLCV(symbol, timeframe, limit = 100) {
        const key = `${symbol}_${timeframe}`;
        const cached = ohlcvCache.get(key);
        if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
        try {
            const data = await requestQueue.push(() => exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
            if (data && data.length) ohlcvCache.set(key, { data, ts: Date.now() });
            return data;
        } catch (e) { 
            console.log(`   ❌ OHLCV hatası ${symbol}:`, e.message);
            return null; 
        }
    }

    static async fetchMultiTimeframeOHLCV(symbol, timeframes) {
        const results = {};
        for (const tf of timeframes) {
            results[tf] = await this.fetchOHLCV(symbol, tf, 80);  // 🔥 Limit düşürüldü
        }
        return results;
    }
    
    static findSimpleSnR(ohlcv15m) {
        if (!ohlcv15m || ohlcv15m.length < 20) return { support: 0, resistance: 0 };
        
        const recentCandles = ohlcv15m.slice(-20);
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

    static async confirmBreakoutWithVolume(symbol, breakoutLevel, direction) {
        const recentOhlcv = await this.fetchOHLCV(symbol, '5m', 10);
        if (!recentOhlcv || recentOhlcv.length < 8) {
            console.log(`   📊 ${symbol}: Hacim verisi yetersiz`);
            return { confirmed: false, strength: 'WEAK', ratio: 0 };
        }

        const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
        const volumes = recentOhlcv.map(c => c[5]);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

        const volumeRatio = breakoutCandle[5] / avgVolume;
        const volumeConfirmed = volumeRatio > CONFIG.volumeConfirmationThreshold;
        
        let strength = 'WEAK';
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';

        console.log(`   📊 ${symbol}: Hacim ${volumeRatio.toFixed(2)}x - ${volumeConfirmed ? '✅' : '⚠️'} (${strength})`);

        return { 
            confirmed: volumeConfirmed, 
            strength: strength,
            ratio: volumeRatio
        };
    }

    static isOptimalTradingTime() {
        if (!CONFIG.enableTimeFilter) return true;
        const hour = new Date().getUTCHours();
        return CONFIG.optimalTradingHours.includes(hour);
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

/* ====================== GEMINI AI TRADER (RENDER UYUMLU) ====================== */
class GeminiAITrader {
    constructor(apiKey) {
        this.apiKey = apiKey;
        console.log('⚠️ Gemini AI Render ortamında devre dışı. Sadece teknik analiz kullanılıyor.');
        this.ai = null;
        geminiStatus.isActive = false;
        geminiStatus.usedFallback = true;
    }

    async getPrediction(symbol, features, rr, currentPrice, snr, marketStructure) {
        // 🔥 Render'da her zaman fallback kullan
        console.log(`   🤖 ${symbol}: Gemini devre dışı - Teknik analiz kullanılıyor`);
        geminiStatus.usedFallback = true;
        return this.improvedFallbackPrediction(features, currentPrice, snr, marketStructure);
    }

    // GELİŞMİŞ FALLBACK PREDICTION
    improvedFallbackPrediction(features, currentPrice, snr, marketStructure) {
        const priceToResistance = Math.abs(currentPrice - snr.resistance);
        const priceToSupport = Math.abs(currentPrice - snr.support);
        
        const closerToResistance = priceToResistance < priceToSupport;
        const distanceRatio = priceToResistance / priceToSupport;
        
        let direction = 'HOLD';
        let confidence = features.mtfScore;
        let reasoning = "";

        // AKILLI KARAR MEKANİZMASI
        if (closerToResistance && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure !== 'BEARISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 25;
            reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance.toFixed(2)}) - Yükseliş trendi`;
        } 
        else if (!closerToResistance && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure !== 'BULLISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 25;
            reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support.toFixed(2)}) - Düşüş trendi`;
        }
        else if (closerToResistance && marketStructure === 'BULLISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 20;
            reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance.toFixed(2)}) - Güçlü yükseliş yapısı`;
        }
        else if (!closerToResistance && marketStructure === 'BEARISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 20;
            reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support.toFixed(2)}) - Güçlü düşüş yapısı`;
        }
        else if (features.rsi < 30 && closerToResistance) {
            direction = 'LONG_BREAKOUT';
            confidence += 15;
            reasoning = `🚀 Aşırı satım + direnç yakın - Potansiyel yükseliş`;
        }
        else if (features.rsi > 70 && !closerToResistance) {
            direction = 'SHORT_BREAKOUT';
            confidence += 15;
            reasoning = `🔻 Aşırı alım + destek yakın - Potansiyel düşüş`;
        }
        else {
            direction = 'HOLD';
            reasoning = "❌ Trend, S&R ve piyasa yapısı uyumsuz - Bekleme tavsiye";
            confidence = Math.max(30, confidence - 20);
        }

        console.log(`   🤖 [TEKNİK ANALİZ] ${direction} (Güven: ${confidence})`);
        return { direction, confidence: Math.round(confidence), reasoning };
    }
}

const geminiAITrader = new GeminiAITrader(CONFIG.geminiApiKey);

/* ====================== GELİŞMİŞ AI CONFIDENCE ENGINE ====================== */
class AdvancedAIConfidenceEngine {
    
    calculateSignalQuality(signal, marketStructure, volumeInfo, trendAlignment, adx, rsi, riskReward) {
        let qualityScore = signal.confidence;
        
        // HACİM BONUSU
        if (volumeInfo.strength === 'STRONG') qualityScore += 20;
        else if (volumeInfo.strength === 'MEDIUM') qualityScore += 10;
        else if (volumeInfo.strength === 'WEAK') qualityScore -= 5;

        // DİĞER FAKTÖRLER
        if (marketStructure === trendAlignment) qualityScore += 15;
        if (riskReward > 2.0) qualityScore += 10;
        if (riskReward > 3.0) qualityScore += 5;
        if (adx > CONFIG.minTrendStrength) qualityScore += 10;

        // CEZA PUANLARI
        if (adx < 15) qualityScore -= 10;
        if (rsi > 80 || rsi < 20) qualityScore -= 5;
        if (!volumeInfo.confirmed) qualityScore -= 10;

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
        let baseMultiplier = CONFIG.atrSLMultiplier;
        
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
        
        if (confidence >= CONFIG.minConfidenceForAuto && matrix.risk >= 55 && signalQuality >= 60) {
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

/* ====================== GELİŞMİŞ STRATEJİ - RENDER UYUMLU ====================== */
class EnhancedTrendMasterAIStrategy {
    async analyze(symbol) {
        console.log(`\n🔍 [ANALİZ] ${symbol} başlıyor...`);

        try {
            if (!EnhancedHelpers.isOptimalTradingTime()) {
                return null;
            }

            const lastSignalTime = signalHistory.get(symbol) || 0;
            if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) {
                return null;
            }

            const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
            if (!ticker || ticker.last < CONFIG.minPrice) {
                return null;
            }

            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
            const ohlcv15m = multiTFData['15m'];
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv15m || ohlcv15m.length < 50) {
                return null;
            }

            // S&R HESAPLAMA
            const snr = EnhancedHelpers.findSimpleSnR(ohlcv15m);
            const currentPrice = ticker.last;

            // TOLERANS KONTROLÜ
            const snrTolerance = currentPrice * (CONFIG.snrTolerancePercent / 100);
            const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

            if (!nearSupport && !nearResistance) {
                return null;
            }

            // MARKET STRUCTURE
            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);

            const closes15m = ohlcv15m.map(c => c[4]);
            const highs15m = ohlcv15m.map(c => c[2]);
            const lows15m = ohlcv15m.map(c => c[3]);
            const volumes15m = ohlcv15m.map(c => c[5]);
            
            const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
            if (!tfAnalysis.isValid) {
                return null;
            }

            // TEKNİK GÖSTERGELER
            const ema9 = EMA.calculate({ period: 9, values: closes15m });
            const ema21 = EMA.calculate({ period: 21, values: closes15m });
            const rsi = RSI.calculate({ period: 14, values: closes15m });
            const adx = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
            const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
            const obv = OBV.calculate({ close: closes15m, volume: volumes15m });
            
            if (!ema9.length || !adx.length) {
                return null;
            }

            const lastEMA9 = ema9[ema9.length - 1];
            const lastEMA21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastATR = atr[atr.length - 1];
            const prevOBV = obv[obv.length - 2] || 0;
            const lastOBV = obv[obv.length - 1];

            // HACİM HESAPLAMA
            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes15m, 20);

            // 🔥 DÜZELTİLMİŞ VOLATİLİTE HESAPLAMA
            const baseVolatility = lastATR / currentPrice * 100; // 800 → 100
            const volatilityFactor = Math.min(2.5, Math.max(0.5, baseVolatility));

            // SL/TP HESAPLAMA
            const slDist = advancedAIEngine.calculateAdaptiveSL(
                currentPrice, lastATR, lastADX, volatilityFactor, 0
            );
            const dynamicTPMultiplier = CONFIG.atrTPMultiplier * volatilityFactor;
            const tpDist = lastATR * dynamicTPMultiplier;

            // RR HESAPLAMA
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

            console.log(`   📊 ${symbol}: Fiyat ${currentPrice} | S&R: ${snr.support}-${snr.resistance}`);
            console.log(`   📊 ${symbol}: RSI: ${lastRSI?.toFixed(1)} | ADX: ${lastADX?.toFixed(1)} | Hacim: ${volumeRatio.toFixed(2)}x`);
            console.log(`   📊 ${symbol}: RR: ${rr.toFixed(2)} | Volatilite: ${volatilityFactor.toFixed(2)}`);

            // AI İÇİN ÖZELLİKLER
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

            // CORRELATION KONTROL
            const similarAssets = EnhancedHelpers.findSimilarAssets(symbol);
            const hasCorrelationRisk = await this.checkCorrelationRisk(symbol, similarAssets);
            if (hasCorrelationRisk) {
                return null;
            }

            // AI TAHMİNİ
            const aiResult = await geminiAITrader.getPrediction(
                symbol, featuresForAI, rr, currentPrice, snr, marketStructure
            );

            const modelDirection = aiResult.direction;
            const modelConfidence = aiResult.confidence;
            const modelReasoning = aiResult.reasoning;

            if (!modelDirection.includes('BREAKOUT') || modelConfidence < CONFIG.minConfidenceForAuto) {
                return null;
            }

            // HACİM DOĞRULAMA
            const breakoutLevel = modelDirection === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
            const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(
                symbol, breakoutLevel, modelDirection
            );

            // SİNYAL KAYNAĞI
            const signalSource = 'TEKNİK ANALİZ';
            const sourceEmoji = '📊';

            // SİNYAL KALİTE SKORU
            const trendAlignment = modelDirection === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH';
            const signalQuality = advancedAIEngine.calculateSignalQuality(
                aiResult, marketStructure, volumeInfo, trendAlignment, 
                lastADX, lastRSI, rr
            );

            // POZİSYON BÜYÜKLÜĞÜ
            const positionSizeMultiplier = advancedAIEngine.calculateDynamicPositionSize(
                volatilityFactor, modelConfidence, signalQuality
            );

            // MARKET SKORU
            let marketScore = 50;
            if (volumeInfo.ratio > 2.0) marketScore += 30;
            else if (volumeInfo.ratio > 1.5) marketScore += 15;
            if (volatilityFactor > 1.2) marketScore += 10;
            if (marketStructure === trendAlignment) marketScore += 10;
            if (signalQuality > 80) marketScore += 10;

            // AI KARAR MATRİSİ
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
                return null;
            }

            signalHistory.set(symbol, Date.now());
            systemStatus.performance.totalSignals++;

            console.log(`   🎯 ${symbol}: SİNYAL! ${modelDirection} (Güven: ${decision.confidence}, Kalite: ${signalQuality})`);

            // SL/TP HESAPLAMA
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

            // ZENGİN AÇIKLAMA
            const volumeText = volumeInfo.confirmed ? 
                `Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)` : 
                `Hacim Zayıf: ${volumeInfo.ratio.toFixed(2)}x`;

            const qualityText = `Kalite: ${signalQuality}${signalQuality > 80 ? ' 🚀' : signalQuality > 60 ? ' ✅' : ' ⚠️'}`;

            // SİNYAL OLUŞTURMA
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
                isAISignal: false
            };
        } catch (e) { 
            console.error(`\n❌ ${symbol} analiz hatası:`, e.message);
            return null; 
        }
    }

    async checkCorrelationRisk(newSymbol, similarAssets) {
        const activePositions = await enhancedAutoTradeSystem.getPositions();
        if (activePositions.length === 0) return false;

        for (const position of activePositions) {
            const positionCoin = position.info.symbol.replace('/USDT', '').replace(':USDT', '');
            if (similarAssets.includes(positionCoin)) {
                return true;
            }
        }
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
            const weight = CONFIG.timeframeWeights[tf] || 0.3;
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
            const ohlcv15m = multiTFData['15m'];
            if (ohlcv15m && ohlcv15m.length > 0) {
                const closes = ohlcv15m.map(c => c[4]);
                const ema9_15m = EMA.calculate({ period: 9, values: closes });
                const ema21_15m = EMA.calculate({ period: 21, values: closes });
                if (ema9_15m.length && ema21_15m.length) {
                    const lastEma9_15m = ema9_15m[ema9_15m.length - 1];
                    const lastEma21_15m = ema21_15m[ema21_15m.length - 1];
                    dominantDirection = lastEma9_15m < lastEma21_15m ? 'SHORT' : 'LONG';
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

/* ====================== AUTO TRADE SYSTEM ====================== */
class EnhancedAutoTradeSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) {
            return; 
        }
        
        try {
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | ${signal.signalSource} | Güven: %${signal.confidence}`);
            const symbol = signal.ccxt_symbol;
            
            const currentPrice = await this.getCurrentPrice(symbol);
            const maxSlippage = currentPrice * (CONFIG.maxSlippagePercent / 100);
            
            if (signal.taraf === 'LONG_BREAKOUT' && currentPrice > signal.giris + maxSlippage) {
                return;
            }
            if (signal.taraf === 'SHORT_BREAKOUT' && currentPrice < signal.giris - maxSlippage) {
                return;
            }

            await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
            
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            if (available < 10) {
                return;
            }
            
            const cost = available * (CONFIG.marginPercent / 100) * signal.positionSize;
            const amountUSDT = cost * CONFIG.leverage;
            let amountCoin = amountUSDT / signal.giris;
            
            let finalAmount = amountCoin;
            try {
                const market = exchangeAdapter.raw.markets[symbol];
                if (market && market.precision && market.precision.amount) {
                    finalAmount = exchangeAdapter.raw.amountToPrecision(symbol, amountCoin);
                } else {
                    finalAmount = Number(amountCoin.toFixed(6));
                }
            } catch (e) {
                finalAmount = Number(amountCoin.toFixed(6));
            }
            
            const side = signal.taraf === 'LONG_BREAKOUT' ? 'buy' : 'sell';
            
            console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x`);
            const order = await this.safeOrder(symbol, side, finalAmount, signal);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI');
                systemStatus.performance.executedTrades++;
                this.updateCorrelationCache(signal.coin);
            }
            
        } catch (e) { 
            console.error('❌ Trade Hatası:', e.message);
        }
    }

    updateCorrelationCache(coin) {
        correlationCache.set(coin, Date.now());
        setTimeout(() => {
            correlationCache.delete(coin);
        }, 60 * 60 * 1000);
    }

    async getCurrentPrice(symbol) {
        try {
            const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
            return ticker?.last || 0;
        } catch {
            return 0;
        }
    }

    async safeOrder(symbol, side, amount, signal) {
        try {
            const params = {};
            const order = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', side, amount, undefined, params)
            );
            if (!order || !order.id) {
                return null;
            }
            return order;
        } catch (err) {
            console.log('❌ Order API Hatası:', err.message);
            return null;
        }
    }

    async getPositions() {
        if(!CONFIG.isApiConfigured) return [];
        try {
            const p = await requestQueue.push(() => exchangeAdapter.raw.fetchPositions());
            return p.filter(x => parseFloat(x.contracts) > 0);
        } catch { return []; }
    }
}

const enhancedAutoTradeSystem = new EnhancedAutoTradeSystem();

/* ====================== VOLUME FILTER SCANNER ====================== */
class VolumeFilterScanner {
    async refreshMarketList() {
        try {
            console.log('🌍 LİSTE YENİLENİYOR...');
            await requestQueue.push(() => exchangeAdapter.raw.loadMarkets());
            const tickers = await requestQueue.push(() => exchangeAdapter.raw.fetchTickers());
            const allSymbols = Object.keys(exchangeAdapter.raw.markets).filter(s => {
                const market = exchangeAdapter.raw.markets[s];
                return market.active && s.includes('USDT') && (market.swap || market.future);
            });
            const highVol = [];
            for (const sym of allSymbols) {
                const t = tickers[sym];
                if (t && (t.quoteVolume >= CONFIG.minVolumeUSD)) highVol.push(sym);
            }
            highVol.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
            cachedHighVol = highVol;
            focusedSymbols = [...cachedHighVol];
            lastMarketRefresh = Date.now();
            systemStatus.filterCount = cachedHighVol.length;
            
            this.analyzeMarketSentiment();
            
            console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin`);
        } catch (e) { console.error('Market refresh fail:', e.message); }
    }

    async analyzeMarketSentiment() {
        if (cachedHighVol.length === 0) return;
        const sample = cachedHighVol.slice(0, 20);
        let longCount = 0;
        let shortCount = 0;
        for(const sym of sample) {
            const ohlcv = await EnhancedHelpers.fetchOHLCV(sym, '1h', 20);
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
        console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Coin: ${focusedSymbols.length}`);

        if (focusedSymbols.length === 0) {
            const now = Date.now();
            if (now - lastMarketRefresh > CONFIG.fullSymbolRefreshMs || cachedHighVol.length === 0) {
                await this.refreshMarketList();
            } else {
                focusedSymbols = [...cachedHighVol];
                await EnhancedHelpers.delay(1000); 
            }
            return;
        }

        const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize); 
        console.log(`\n⚡ Tarama: ${batch.length} coin`);
        
        const validSignals = [];
        for (const sym of batch) {
            const signal = await enhancedTrendMaster.analyze(sym);
            if (signal) {
                validSignals.push(signal);
                console.log(`\n🎯 SİNYAL: ${sym} - ${signal.taraf} | ${signal.signalSource} (Güven: ${signal.confidence}%)`);
            }
        }
        
        if (validSignals.length > 0) {
            const shortSignals = validSignals.filter(s => s.taraf.includes('SHORT'));
            const longSignals = validSignals.filter(s => s.taraf.includes('LONG'));
            
            console.log(`\n🎯 ${validSignals.length} SİNYAL! SHORT: ${shortSignals.length} | LONG: ${longSignals.length}`);
            
            validSignals.forEach(signal => {
                broadcastSignal(signal);
                if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
                    enhancedAutoTradeSystem.execute(signal);
                }
            });
        } else {
            console.log(`\n⚡ Tarama tamamlandı. Sinyal yok.`);
        }
    }
}

const scanner = new VolumeFilterScanner();

// Signal management
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
        console.log(`🧹 ${removedCount} eski sinyal temizlendi`);
        broadcastSignalList();
    }
}

setInterval(cleanupSignalCache, 60000);

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

// API Routes
app.get('/api/status', async (req, res) => {
    const positions = await enhancedAutoTradeSystem.getPositions();
    const recentSignals = Array.from(signalCache.values())
        .sort((a, b) => b.timestamp - a.timestamp);
        
    res.json({ 
        config: CONFIG, 
        system: systemStatus, 
        positions: positions,
        signals: recentSignals,
        geminiStatus: geminiStatus
    });
});

app.post('/api/config/update', (req, res) => { 
    if (req.body.minConfidenceForAuto !== undefined) {
        CONFIG.minConfidenceForAuto = parseInt(req.body.minConfidenceForAuto);
    }
    Object.assign(CONFIG, req.body); 
    res.json({ success: true }); 
});

app.post('/api/trade/manual', async (req, res) => { 
    await enhancedAutoTradeSystem.execute(req.body, true); 
    res.json({ success: true }); 
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    exchangeAdapter = { raw: new ccxt.bitget({
        apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
        options: { defaultType: 'swap' },
        timeout: 30000  // 🔥 Timeout eklendi
    })};
    
    if (CONFIG.isApiConfigured) {
        try {
            const b = await exchangeAdapter.raw.fetchBalance();
            systemStatus.balance = parseFloat(b.USDT?.free || 0);
            console.log(`💰 Bakiye: ${systemStatus.balance} USDT`);
        } catch(e) {
            console.log("Bakiye alınamadı:", e.message);
        }
    }
    
    console.log('\n⚙️  SİSTEM KONFİGURASYONU:');
    console.log(`   🎯 Min Güven: ${CONFIG.minConfidenceForAuto}%`);
    console.log(`   📊 Min Hacim: ${CONFIG.minVolumeUSD} USD`);
    console.log(`   🤖 Gemini AI: ${CONFIG.enableGemini ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🤖 Oto Trade: ${CONFIG.autotradeMaster ? 'AKTİF' : 'PASİF'}`);
    
    await scanner.refreshMarketList(); 
    setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, '0.0.0.0', () => {  // 🔥 '0.0.0.0' eklendi
    console.log(`🚀 Server: http://localhost:${PORT}`); 
    start(); 
});
