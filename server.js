/** 
 * server.js - TrendMaster SNIPER AI v37.3 - KAYNAK BELİRGİN SÜRÜM
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');
const { GoogleGenAI } = require('@google/genai');

/* ====================== BOOT ====================== */
console.log('=== SERVER BOOT (TrendMaster v37.3 - KAYNAK BELİRGİN SÜRÜM) ===');
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

    // 🔥 GÜNCELLENDİ: Daha dengeli filtreler
    minConfidenceForAuto: 58,
    minVolumeUSD: 300000,
    
    // Dinamik RR
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.5,
    
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
    scanBatchSize: 10,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,

    // YENİ: Gelişmiş Özellikler
    volumeConfirmationThreshold: 1.3,    // 🔥 1.5'ten 1.3'e düşürüldü
    minTrendStrength: 20,
    optimalTradingHours: [7,8,9,13,14,15,19,20,21],
    enableTimeFilter: false,
    
    // GEMINI FALLBACK AYARLARI
    enableGemini: true,
    geminiFallbackMode: true,
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
const geminiStatus = { 
    isActive: true, 
    lastError: 0, 
    quotaExceeded: false,
    usedFallback: false  // 🔥 YENİ: Fallback kullanım takibi
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
    queue: [], running: 0, concurrency: 8,
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
            results[tf] = await this.fetchOHLCV(symbol, tf, 100);
        }
        return results;
    }
    
    // BASİT VE ETKİLİ S&R ALGORİTMASI
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

    // Hacim Hesaplamasını Düzelt
    static calculateVolumeRatio(volumes, period = 20) {
        if (!volumes || volumes.length < period) return 1;
        
        const currentVolume = volumes[volumes.length - 1];
        const recentVolumes = volumes.slice(-period);
        const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
        
        return currentVolume / avgVolume;
    }

    // Market Structure Analizi
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

    // 🔥 YENİ: GELİŞMİŞ HACİM DOĞRULAMA SİSTEMİ
    static async confirmBreakoutWithVolume(symbol, breakoutLevel, direction) {
        const recentOhlcv = await this.fetchOHLCV(symbol, '5m', 15);
        if (!recentOhlcv || recentOhlcv.length < 10) {
            console.log(`   📊 ${symbol}: Hacim verisi yetersiz - ZAYIF SİNYAL`);
            return { confirmed: false, strength: 'WEAK', ratio: 0 };
        }

        const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
        const volumes = recentOhlcv.map(c => c[5]);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

        const volumeRatio = breakoutCandle[5] / avgVolume;
        let volumeConfirmed = volumeRatio > CONFIG.volumeConfirmationThreshold;
        let strength = 'WEAK';
        
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';
        else strength = 'WEAK';

        console.log(`   📊 ${symbol}: Hacim ${volumeRatio.toFixed(2)}x (Min: ${CONFIG.volumeConfirmationThreshold}x) - ${volumeConfirmed ? '✅' : '⚠️'} (${strength})`);

        return { 
            confirmed: volumeConfirmed, 
            strength: strength,
            ratio: volumeRatio
        };
    }

    // Zaman Bazlı Filtreleme
    static isOptimalTradingTime() {
        if (!CONFIG.enableTimeFilter) return true;
        const hour = new Date().getUTCHours();
        return CONFIG.optimalTradingHours.includes(hour);
    }

    // Correlation Risk Kontrolü
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

/* ====================== GEMINI AI TRADER (GELİŞMİŞ FALLBACK) ====================== */
class GeminiAITrader {
    constructor(apiKey) {
        this.apiKey = apiKey;
        if (!apiKey) {
            console.log('⚠️ Gemini API Key eksik. AI tahminleri devre dışı.');
            this.ai = null;
            geminiStatus.isActive = false;
            return;
        }
        try {
            this.ai = new GoogleGenAI(apiKey);
            this.model = "gemini-2.5-flash";
            this.systemInstruction = "Sen, kripto vadeli işlem piyasaları için çalışan uzman bir yapay zekasın. Analiz sonucunda 1. satırda sadece 'SHORT_BREAKOUT', 'LONG_BREAKOUT' veya 'HOLD' kelimesinden birini yaz. 2. satırda ise bu kararı neden aldığını (örn: 'Direncin güçlü hacimle kırılması bekleniyor, sıçrama potansiyeli yüksek' veya 'Destek seviyesinde tutunamama riski var, sert düşüş bekleniyor') **tek bir kısa ve sade cümleyle** açıkla. Başka hiçbir şey söyleme.";
            geminiStatus.isActive = true;
        } catch(e) {
            console.error("Gemini Sınıfı Hata:", e.message);
            this.ai = null;
            geminiStatus.isActive = false;
        }
    }

    preparePrompt(symbol, features, rr, currentPrice, snr, marketStructure) {
        const prompt = `
            Sembol: ${symbol} (GELİŞMİŞ KIRILIM AVCISI MODU)
            Anlık Fiyat: ${currentPrice.toFixed(4)}
            
            KRİTİK SEVİYELER:
            - Direnç: ${snr.resistance.toFixed(4)}
            - Destek: ${snr.support.toFixed(4)}
            
            MARKET YAPISI: ${marketStructure}
            Risk/Reward Oranı: ${rr.toFixed(2)}
            Oynaklık Faktörü: ${features.volatilityFactor.toFixed(2)}
            15m RSI: ${features.rsi.toFixed(2)}, ADX (Trend Gücü): ${features.adx.toFixed(2)}
            EMA Kesit Durumu (9-21): ${features.emaDirection}
            OBV Trendi: ${features.obvTrend}
            Hacim Oranı: ${features.volumeRatio.toFixed(2)}
            MTF Skoru: ${features.mtfScore.toFixed(0)}
            
            DEĞERLENDİRME: Bu coin, kritik seviyelere yakın pozisyonda. Hacim, trend gücü, market structure ve fiyat seviyeleri göz önüne alındığında; hangi yönde kırılım bekleniyor?

            (Cevap 1. satırda YÖN (LONG_BREAKOUT/SHORT_BREAKOUT/HOLD), 2. satırda TEK CÜMLE ile BEKLENEN FİYAT VE GEREKÇE olmalıdır.)
        `;
        return prompt.trim();
    }

    async getPrediction(symbol, features, rr, currentPrice, snr, marketStructure) {
        // 🔥 YENİ: Fallback durumunu sıfırla
        geminiStatus.usedFallback = false;

        if (!this.ai || !geminiStatus.isActive || !CONFIG.enableGemini) {
            console.log(`   🤖 ${symbol}: Gemini devre dışı - Fallback mod`);
            geminiStatus.usedFallback = true;
            return this.improvedFallbackPrediction(features, currentPrice, snr, marketStructure);
        }

        if (geminiStatus.quotaExceeded) {
            const timeSinceError = Date.now() - geminiStatus.lastError;
            if (timeSinceError < 3600000) {
                console.log(`   🤖 ${symbol}: Kota aşımı - Fallback mod`);
                geminiStatus.usedFallback = true;
                return this.improvedFallbackPrediction(features, currentPrice, snr, marketStructure);
            } else {
                geminiStatus.quotaExceeded = false;
            }
        }

        await EnhancedHelpers.delay(8000);
        const prompt = this.preparePrompt(symbol, features, rr, currentPrice, snr, marketStructure);
        
        console.log(`   🤖 [GEMINI] ${symbol} için AI analizi...`);
        try {
            const response = await this.ai.models.generateContent({
                model: this.model,
                contents: prompt,
                config: {
                    systemInstruction: this.systemInstruction,
                    temperature: 0.1,
                }
            });

            const lines = response.text.trim().toUpperCase().split('\n').filter(line => line.trim() !== '');
            const direction = lines[0] || 'HOLD';
            const reasoning = lines.slice(1).join(' ').trim();

            let confidence = features.mtfScore;

            if (direction === 'LONG_BREAKOUT' || direction === 'SHORT_BREAKOUT') {
                let bonus = 15;
                if (features.volumeRatio > 2.0) bonus += 7;
                if (features.adx > 35) bonus += 7;
                if (marketStructure === (direction === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH')) bonus += 5;
                
                confidence = Math.min(98, confidence + bonus);
                console.log(`   🤖 [GEMINI] ${symbol}: ${direction} (Güven: ${confidence})`);
            } else {
                console.log(`   🤖 [GEMINI] ${symbol}: HOLD (Güven: ${confidence})`);
                return { direction: 'HOLD', confidence: Math.round(confidence), reasoning: reasoning };
            }

            return { direction: direction, confidence: Math.round(confidence), reasoning: reasoning };
        } catch (e) {
            if (e.message.includes("code:429") || e.message.includes("quota")) {
                console.log(`   ❌ ${symbol}: GEMINI KOTA AŞIMI - Fallback moda geçiliyor`);
                geminiStatus.quotaExceeded = true;
                geminiStatus.lastError = Date.now();
                geminiStatus.isActive = false;
                geminiStatus.usedFallback = true;
                
                setTimeout(() => {
                    geminiStatus.isActive = true;
                    console.log('   🔄 Gemini tekrar aktif edildi');
                }, 300000);
                
                return this.improvedFallbackPrediction(features, currentPrice, snr, marketStructure);
            }

            console.error(`\n❌ Gemini API Hatası (${symbol}):`, e.message.substring(0, 100));
            geminiStatus.usedFallback = true;
            return this.improvedFallbackPrediction(features, currentPrice, snr, marketStructure);
        }
    }

    // 🔥 YENİ: GELİŞMİŞ FALLBACK PREDICTION (ÇİFT YÖNLÜ)
    improvedFallbackPrediction(features, currentPrice, snr, marketStructure) {
        const priceToResistance = Math.abs(currentPrice - snr.resistance);
        const priceToSupport = Math.abs(currentPrice - snr.support);
        
        // Hangi seviyeye daha yakın?
        const closerToResistance = priceToResistance < priceToSupport;
        const distanceRatio = priceToResistance / priceToSupport;
        
        let direction = 'HOLD';
        let confidence = features.mtfScore;
        let reasoning = "";

        // 🔥 AKILLI KARAR MEKANİZMASI: Trend + S&R + Market Structure
        if (closerToResistance && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure !== 'BEARISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 25;
            reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance}) - Yükseliş trendi ve uyumlu market structure`;
        } 
        else if (!closerToResistance && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure !== 'BULLISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 25;
            reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support}) - Düşüş trendi ve uyumlu market structure`;
        }
        else if (closerToResistance && marketStructure === 'BULLISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 20;
            reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance}) - Güçlü yükseliş market structure`;
        }
        else if (!closerToResistance && marketStructure === 'BEARISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 20;
            reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support}) - Güçlü düşüş market structure`;
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
            reasoning = "❌ Trend, S&R ve market structure uyumsuz - Bekleme tavsiye";
            confidence = Math.max(30, confidence - 20);
        }

        console.log(`   🤖 [FALLBACK] ${direction} (Güven: ${confidence}) - ${reasoning}`);
        return { direction, confidence: Math.round(confidence), reasoning };
    }
}

const geminiAITrader = new GeminiAITrader(CONFIG.geminiApiKey);

/* ====================== GELİŞMİŞ AI CONFIDENCE ENGINE ====================== */
class AdvancedAIConfidenceEngine {
    
    // 🔥 YENİ: HACİM GÜCÜNE GÖRE SİNYAL KALİTESİ
    calculateSignalQuality(signal, marketStructure, volumeInfo, trendAlignment, adx, rsi, riskReward) {
        let qualityScore = signal.confidence;
        
        // HACİM BONUSU
        if (volumeInfo.strength === 'STRONG') qualityScore += 20;
        else if (volumeInfo.strength === 'MEDIUM') qualityScore += 10;
        else if (volumeInfo.strength === 'WEAK') qualityScore -= 10;

        // DİĞER FAKTÖRLER
        if (marketStructure === trendAlignment) qualityScore += 15;
        if (riskReward > 2.5) qualityScore += 5;
        if (adx > CONFIG.minTrendStrength) qualityScore += 10;

        // CEZA PUANLARI
        if (adx < 20) qualityScore -= 10;
        if (rsi > 80 || rsi < 20) qualityScore -= 5;
        if (!volumeInfo.confirmed) qualityScore -= 15; // Hacim doğrulanmamışsa ceza

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

/* ====================== GELİŞMİŞ STRATEJİ - KAYNAK BELİRGİN ====================== */
class EnhancedTrendMasterAIStrategy {
    async analyze(symbol) {
        console.log(`\n🔍 [ANALİZ] ${symbol} başlıyor...`);

        try {
            if (!EnhancedHelpers.isOptimalTradingTime()) {
                const hour = new Date().getUTCHours();
                console.log(`   ⏰ ${symbol}: Optimal zaman değil (UTC: ${hour}) - Atlandı`);
                return null;
            }

            const lastSignalTime = signalHistory.get(symbol) || 0;
            if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) {
                console.log(`   ⏰ ${symbol}: Cooldown süresinde - Atlandı`);
                return null;
            }

            const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
            if (!ticker || ticker.last < CONFIG.minPrice) {
                console.log(`   💰 ${symbol}: Fiyat çok düşük veya ticker yok - Atlandı`);
                return null;
            }

            console.log(`   📊 ${symbol}: Fiyat ${ticker.last} - OHLCV verileri alınıyor...`);
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
            const ohlcv15m = multiTFData['15m'];
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv15m || ohlcv15m.length < 60) {
                console.log(`   📊 ${symbol}: Yetersiz OHLCV verisi - Atlandı`);
                return null;
            }

            // S&R HESAPLAMA
            const snr = EnhancedHelpers.findSimpleSnR(ohlcv15m);
            const currentPrice = ticker.last;

            console.log(`   📈 ${symbol}: BASİT S&R - Destek: ${snr.support}, Direnç: ${snr.resistance}`);
            console.log(`   📈 ${symbol}: Mevcut: ${currentPrice}`);

            // TOLERANS KONTROLÜ
            const snrTolerance = currentPrice * (CONFIG.snrTolerancePercent / 100);
            const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

            console.log(`   📈 ${symbol}: Destek yakın: ${nearSupport}, Direnç yakın: ${nearResistance}`);

            if (!nearSupport && !nearResistance) {
                console.log(`   📈 ${symbol}: Hiçbir S&R seviyesine yakın değil - Atlandı`);
                return null;
            }

            console.log(`   📈 ${symbol}: S&R seviyelerine yakın - Devam ediliyor...`);

            // MARKET STRUCTURE
            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);
            console.log(`   🏗️ ${symbol}: Market Structure - ${marketStructure}`);

            const closes15m = ohlcv15m.map(c => c[4]);
            const highs15m = ohlcv15m.map(c => c[2]);
            const lows15m = ohlcv15m.map(c => c[3]);
            const volumes15m = ohlcv15m.map(c => c[5]);
            
            console.log(`   📊 ${symbol}: Teknik göstergeler hesaplanıyor...`);
            const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
            if (!tfAnalysis.isValid) {
                console.log(`   📊 ${symbol}: Multi-timeframe analiz geçersiz - Atlandı`);
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
                console.log(`   📊 ${symbol}: Gösterge hesaplama hatası - Atlandı`);
                return null;
            }

            const lastEMA9 = ema9[ema9.length - 1];
            const lastEMA21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastATR = atr[atr.length - 1];
            const prevOBV = obv[obv.length - 2] || 0;
            const currentVol = volumes15m[volumes15m.length - 1];
            const lastOBV = obv[obv.length - 1];

            // HACİM HESAPLAMA
            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes15m, 20);

            // VOLATİLİTE
            const baseVolatility = lastATR / currentPrice * 100;
            const volatilityFactor = Math.min(1.6, Math.max(0.8, baseVolatility));

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

            console.log(`   📊 ${symbol}: Teknik Değerler:`);
            console.log(`      📈 EMA9: ${lastEMA9?.toFixed(4)} | EMA21: ${lastEMA21?.toFixed(4)}`);
            console.log(`      🔄 RSI: ${lastRSI?.toFixed(1)} | ADX: ${lastADX?.toFixed(1)}`);
            console.log(`      📊 ATR: ${lastATR?.toFixed(4)} | Hacim Oranı: ${volumeRatio.toFixed(2)}x`);
            console.log(`      📊 Risk/Reward: ${rr.toFixed(2)} | Volatilite: ${volatilityFactor.toFixed(2)}`);

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
                console.log(`   ⚠️ ${symbol}: Correlation risk - Benzer coinlerle pozisyon var`);
                return null;
            }

            // AI TAHMİNİ
            console.log(`   🤖 ${symbol}: AI analizi başlatılıyor...`);
            const aiResult = await geminiAITrader.getPrediction(
                symbol, featuresForAI, rr, currentPrice, snr, marketStructure
            );

            const modelDirection = aiResult.direction;
            const modelConfidence = aiResult.confidence;
            const modelReasoning = aiResult.reasoning;

            if (!modelDirection.includes('BREAKOUT') || modelConfidence < CONFIG.minConfidenceForAuto) {
                console.log(`   ❌ ${symbol}: AI HOLD kararı veya yetersiz güven (${modelConfidence}/${CONFIG.minConfidenceForAuto})`);
                return null;
            }

            console.log(`   ✅ ${symbol}: AI ${modelDirection} kararı (Güven: ${modelConfidence})`);

            // HACİM DOĞRULAMA
            const breakoutLevel = modelDirection === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
            console.log(`   📊 ${symbol}: Hacim doğrulaması kontrol ediliyor...`);
            const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(
                symbol, breakoutLevel, modelDirection
            );

            // 🔥 YENİ: SİNYAL KAYNAĞI BELİRLEME
            const signalSource = geminiStatus.usedFallback ? 'TEKNİK ANALİZ' : 'GEMINI AI';
            const sourceEmoji = geminiStatus.usedFallback ? '📊' : '🤖';

            // SİNYAL KALİTE SKORU
            const trendAlignment = modelDirection === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH';
            const signalQuality = advancedAIEngine.calculateSignalQuality(
                aiResult, marketStructure, volumeInfo, trendAlignment, 
                lastADX, lastRSI, rr
            );

            console.log(`   📊 ${symbol}: Sinyal Kalite Skoru: ${signalQuality}`);

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
                console.log(`   ❌ ${symbol}: AI Motoru işlem onaylamadı - ${decision.reasoning}`);
                return null;
            }

            signalHistory.set(symbol, Date.now());
            systemStatus.performance.totalSignals++;

            console.log(`   🎯 ${symbol}: SİNYAL OLUŞTURULDU! ${modelDirection} (Güven: ${decision.confidence}, Kalite: ${signalQuality})`);

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

            // 🔥 YENİ: ZENGİN AÇIKLAMA SİSTEMİ
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
                // 🔥 YENİ: NET KAYNAK BİLGİSİ
                tuyo: `${sourceEmoji} ${signalSource}: ${modelReasoning} | ${qualityText} | ${volumeText}`,
                timestamp: Date.now(),
                adx: lastADX.toFixed(0),
                rsi: lastRSI.toFixed(0),
                obvTrend: lastOBV > prevOBV ? '↑' : '↓',
                signalQuality: signalQuality,
                marketStructure: marketStructure,
                volumeConfirmed: volumeInfo.confirmed,
                signalSource: signalSource, // 🔥 YENİ: Kaynak bilgisi
                isAISignal: !geminiStatus.usedFallback // 🔥 YENİ: AI onayı
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

/* ====================== KALAN KODLAR AYNI ====================== */
// [EnhancedAutoTradeSystem, VolumeFilterScanner, signal management, routing kısımları aynı kalacak]
// Sadece küçük iyileştirmeler yapıldı

class EnhancedAutoTradeSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) {
            console.log(`\n❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Min güven: ${CONFIG.minConfidenceForAuto} isteniyor.`);
            return; 
        }
        
        try {
            // 🔥 YENİ: Sinyal kaynağını logla
            const sourceInfo = signal.isAISignal ? 'GEMINI AI ONAYLI' : 'TEKNİK ANALİZ';
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | ${sourceInfo} | Güven: %${signal.confidence} | Kalite: ${signal.signalQuality}`);
            
            const symbol = signal.ccxt_symbol;
            
            const currentPrice = await this.getCurrentPrice(symbol);
            const maxSlippage = currentPrice * (CONFIG.maxSlippagePercent / 100);
            
            if (signal.taraf === 'LONG_BREAKOUT' && currentPrice > signal.giris + maxSlippage) {
                console.log(`❌ SLİPAJ FAZLA: Giriş: ${signal.giris}, Mevcut: ${currentPrice}, Limit: %${CONFIG.maxSlippagePercent} aşıldı.`);
                return;
            }
            if (signal.taraf === 'SHORT_BREAKOUT' && currentPrice < signal.giris - maxSlippage) {
                console.log(`❌ SLİPAJ FAZLA: Giriş: ${signal.giris}, Mevcut: ${currentPrice}, Limit: %${CONFIG.maxSlippagePercent} aşıldı.`);
                return;
            }

            console.log(`✅ SLİPAJ UYGUN: Giriş: ${signal.giris}, Mevcut: ${currentPrice}`);
            await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
            
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            if (available < 10) {
                console.log('❌ Yetersiz bakiye');
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
            
            console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x | Risk: ${signal.riskLevel}`);
            const order = await this.safeOrder(symbol, side, finalAmount, signal);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
                systemStatus.performance.executedTrades++;
                this.updateCorrelationCache(signal.coin);
            } else {
                console.log('❌ EMİR BAŞARISIZ - Order null döndü');
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
            console.log(`📡 Order Parametreleri: Yön=${side}, Miktar=${amount}, Boyut=${signal.positionSize}x`);
            const order = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', side, amount, undefined, params)
            );
            if (!order) {
                console.log('⛔ API boş sonuç döndürdü!');
                return null;
            }
            if (!order.id) {
                console.log('⛔ Order oluşturuldu ama ID dönmedi!');
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

class VolumeFilterScanner {
    async refreshMarketList() {
        try {
            console.log('🌍 LİSTE YENİLENİYOR...');
            await requestQueue.push(() => exchangeAdapter.raw.loadMarkets(true));
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
            
            console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${CONFIG.minVolumeUSD/1000000}M$).`);
        } catch (e) { console.error('Market refresh fail:', e.message); }
    }

    async analyzeMarketSentiment() {
        if (cachedHighVol.length === 0) return;
        const sample = cachedHighVol.slice(0, 30);
        let longCount = 0;
        let shortCount = 0;
        for(const sym of sample) {
            const ohlcv = await EnhancedHelpers.fetchOHLCV(sym, '1h', 30);
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
        console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Gemini: ${geminiStatus.isActive ? 'AKTİF' : 'PASİF'} | Fallback: ${geminiStatus.usedFallback ? 'AKTİF' : 'PASİF'}`);

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
        console.log(`\n⚡ Tarama: ${batch.length} coin analiz ediliyor...`);
        
        const validSignals = [];
        for (const sym of batch) {
            const signal = await enhancedTrendMaster.analyze(sym);
            if (signal) {
                validSignals.push(signal);
                const source = signal.isAISignal ? 'GEMINI AI' : 'TEKNİK ANALİZ';
                console.log(`\n🎯 SİNYAL BULUNDU: ${sym} - ${signal.taraf} | ${source} (Güven: ${signal.confidence}%, Kalite: ${signal.signalQuality})`);
            }
        }
        
        if (validSignals.length > 0) {
            const shortSignals = validSignals.filter(s => s.taraf.includes('SHORT'));
            const longSignals = validSignals.filter(s => s.taraf.includes('LONG'));
            const aiSignals = validSignals.filter(s => s.isAISignal).length;
            const techSignals = validSignals.filter(s => !s.isAISignal).length;
            
            console.log(`\n🎯 ${validSignals.length} SİNYAL BULUNDU!`);
            console.log(`   SHORT: ${shortSignals.length} | LONG: ${longSignals.length}`);
            console.log(`   GEMINI AI: ${aiSignals} | TEKNİK ANALİZ: ${techSignals}`);
            console.log(`   Toplam: ${systemStatus.performance.totalSignals}`);
            
            validSignals.forEach(signal => {
                broadcastSignal(signal);
                if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
                    enhancedAutoTradeSystem.execute(signal);
                }
            });
        } else {
            console.log(`\n⚡ Tarama tamamlandı. Sinyal bulunamadı.`);
        }
    }
}

const scanner = new VolumeFilterScanner();

// Signal management ve routing fonksiyonları
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
        console.log(`🎯 Güven filtresi güncellendi: ${CONFIG.minConfidenceForAuto}`);
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
        options: { defaultType: 'swap' }
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
    console.log(`   📈 S&R Tolerans: %${CONFIG.snrTolerancePercent}`);
    console.log(`   🤖 Gemini AI: ${CONFIG.enableGemini ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🛡️  Fallback Mod: ${CONFIG.geminiFallbackMode ? 'AKTİF' : 'PASİF'}`);
    console.log(`   📊 Hacim Eşiği: ${CONFIG.volumeConfirmationThreshold}x`);
    console.log(`   🤖 Oto Trade: ${CONFIG.autotradeMaster ? 'AKTİF' : 'PASİF'}`);
    
    await scanner.refreshMarketList(); 
    setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, () => { 
    console.log(`🚀 UI: http://localhost:${PORT}`); 
    start(); 
});
