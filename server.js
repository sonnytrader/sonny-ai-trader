/**
 * server.js - SONNY TRADER PRO v2.0 - MULTI STRATEGY TRADING
 * 3 Strateji: KIRILIM + SCALP + TREND (Gemini AI olmadan)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV, Stochastic, BollingerBands } = require('technicalindicators');

/* ====================== BOOT ====================== */
console.log('=== SONNY TRADER PRO v2.0 - MULTI STRATEGY TRADING ===');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

/* ====================== GELİŞMİŞ KONFİGURASYON ====================== */
let CONFIG = {
    // API Configuration
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

    // 🔥 YENİ: Multi-Strategy Configuration
    activeStrategy: 'breakout', // 'breakout', 'scalp', 'trend'
    
    // Strategy Settings
    strategies: {
        breakout: {
            name: "KIRILIM STRATEJİSİ",
            enabled: true,
            minConfidence: 65,
            timeframes: ['1h', '4h'],
            riskReward: 3.5,
            maxDailySignals: 10,
            volumeThreshold: 1.3
        },
        scalp: {
            name: "SCALP STRATEJİSİ",
            enabled: true,
            minConfidence: 75,
            timeframes: ['5m', '15m'],
            riskReward: 1.5,
            maxDailySignals: 25,
            holdTimeMinutes: 5,
            maxDrawdown: 0.5
        },
        trend: {
            name: "TREND TAKİP",
            enabled: true,
            minConfidence: 70,
            timeframes: ['4h', '1d'],
            riskReward: 4.0,
            maxDailySignals: 5,
            trendConfirmation: true
        }
    },

    // Risk Management
    leverage: 10,
    marginPercent: 5,
    maxPositions: 5,
    dailyTradeLimit: 50,

    // Order Configuration
    orderType: 'limit',
    limitOrderPriceOffset: 0.1,
    orderTimeoutMs: 30000,

    // Market Filters
    minVolumeUSD: 500000,
    minPrice: 0.05,
    maxSlippagePercent: 1.0,

    // Technical Settings
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.5,
    signalCooldownMs: 30 * 60 * 1000,
    
    // System Settings
    scanBatchSize: 8,
    focusedScanIntervalMs: 3 * 60 * 1000,
    fullSymbolRefreshMs: 10 * 60 * 1000,

    // AI Settings (Basitleştirilmiş)
    enableTimeFilter: false
};

/* ====================== GLOBAL DEĞİŞKENLER ====================== */
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const userConfigs = new Map();

// Strategy Performance Tracking
const strategyPerformance = {
    breakout: { signals: 0, wins: 0, losses: 0, pnl: 0 },
    scalp: { signals: 0, wins: 0, losses: 0, pnl: 0 },
    trend: { signals: 0, wins: 0, losses: 0, pnl: 0 }
};

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    balance: 0,
    activeStrategy: CONFIG.activeStrategy,
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
        let volumeConfirmed = volumeRatio > CONFIG.strategies.breakout.volumeThreshold;
        let strength = 'WEAK';
        
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';
        else strength = 'WEAK';

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
        return [7,8,9,13,14,15,19,20,21].includes(hour);
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

/* ====================== KIRILIM STRATEJİSİ ====================== */
class BreakoutStrategy {
    constructor() {
        this.name = "BREAKOUT";
        this.minConfidence = CONFIG.strategies.breakout.minConfidence;
        this.timeframes = CONFIG.strategies.breakout.timeframes;
    }

    async analyze(symbol) {
        console.log(`\n🔍 [KIRILIM] ${symbol} analiz başlıyor...`);

        try {
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
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.timeframes);
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv1h || ohlcv1h.length < 60) {
                console.log(`   📊 ${symbol}: Yetersiz OHLCV verisi - Atlandı`);
                return null;
            }

            const snr = EnhancedHelpers.findSimpleSnR(ohlcv1h);
            const currentPrice = ticker.last;

            console.log(`   📈 ${symbol}: 1h S&R - Destek: ${snr.support}, Direnç: ${snr.resistance}`);
            console.log(`   📈 ${symbol}: Mevcut: ${currentPrice}`);

            const snrTolerance = currentPrice * 0.02; // %2 tolerance
            const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

            console.log(`   📈 ${symbol}: Destek yakın: ${nearSupport}, Direnç yakın: ${nearResistance}`);

            if (!nearSupport && !nearResistance) {
                console.log(`   📈 ${symbol}: Hiçbir S&R seviyesine yakın değil - Atlandı`);
                return null;
            }

            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);
            console.log(`   🏗️ ${symbol}: Market Structure - ${marketStructure}`);

            const closes1h = ohlcv1h.map(c => c[4]);
            const highs1h = ohlcv1h.map(c => c[2]);
            const lows1h = ohlcv1h.map(c => c[3]);
            const volumes1h = ohlcv1h.map(c => c[5]);
            
            const ema9 = EMA.calculate({ period: 9, values: closes1h });
            const ema21 = EMA.calculate({ period: 21, values: closes1h });
            const rsi = RSI.calculate({ period: 14, values: closes1h });
            const adx = ADX.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            const atr = ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            
            if (!ema9.length || !adx.length) {
                console.log(`   📊 ${symbol}: Gösterge hesaplama hatası - Atlandı`);
                return null;
            }

            const lastEMA9 = ema9[ema9.length - 1];
            const lastEMA21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastATR = atr[atr.length - 1];

            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes1h, 20);

            // Sinyal güveni hesapla
            let confidence = 50;
            if (lastEMA9 > lastEMA21) confidence += 15;
            if (lastADX > 25) confidence += 15;
            if (volumeRatio > 1.5) confidence += 10;
            if (marketStructure === 'BULLISH' && nearResistance) confidence += 10;
            if (marketStructure === 'BEARISH' && nearSupport) confidence += 10;

            confidence = Math.min(95, confidence);

            if (confidence < this.minConfidence) {
                console.log(`   ❌ ${symbol}: Yetersiz güven (${confidence}/${this.minConfidence})`);
                return null;
            }

            const direction = (lastEMA9 > lastEMA21 && nearResistance) ? 'LONG_BREAKOUT' : 
                            (lastEMA9 < lastEMA21 && nearSupport) ? 'SHORT_BREAKOUT' : null;

            if (!direction) {
                console.log(`   ❌ ${symbol}: Uygun kırılım yönü bulunamadı`);
                return null;
            }

            console.log(`   ✅ ${symbol}: ${direction} sinyali (Güven: ${confidence})`);

            const breakoutLevel = direction === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
            const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(symbol, breakoutLevel, direction);

            if (!volumeInfo.confirmed && volumeInfo.ratio < 1.0) {
                console.log(`   ❌ ${symbol}: Hacim doğrulaması başarısız`);
                return null;
            }

            signalHistory.set(symbol, Date.now());
            systemStatus.performance.totalSignals++;

            // Pozisyon boyutu ve TP/SL hesapla
            const slDist = lastATR * CONFIG.atrSLMultiplier;
            const tpDist = lastATR * CONFIG.atrTPMultiplier;

            let entryPrice, sl_final, tp1_final;
            if (direction === 'LONG_BREAKOUT') {
                entryPrice = breakoutLevel;
                sl_final = entryPrice - slDist;
                tp1_final = entryPrice + tpDist;
            } else {
                entryPrice = breakoutLevel;
                sl_final = entryPrice + slDist;
                tp1_final = entryPrice - tpDist;
            }

            const risk = Math.abs(entryPrice - sl_final);
            const reward = Math.abs(tp1_final - entryPrice);
            const rr = reward / risk;

            const volumeText = volumeInfo.confirmed ? 
                `Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)` : 
                `Hacim Zayıf: ${volumeInfo.ratio.toFixed(2)}x`;

            return {
                id: `${symbol}_BREAKOUT_${Date.now()}`,
                coin: EnhancedHelpers.cleanSymbol(symbol),
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'breakout',
                
                giris: EnhancedHelpers.roundToTick(entryPrice),
                tp1: EnhancedHelpers.roundToTick(tp1_final),
                sl: EnhancedHelpers.roundToTick(sl_final),
                riskReward: rr.toFixed(2),
                confidence: confidence,
                positionSize: 1.0,
                
                riskLevel: confidence >= 80 ? "LOW" : "MEDIUM",
                tuyo: `🎯 KIRILIM Sinyal | RSI: ${lastRSI?.toFixed(1) || 'N/A'} | ADX: ${lastADX.toFixed(1)} | ${volumeText}`,
                timestamp: Date.now(),
                signalQuality: confidence
            };
            
        } catch (e) { 
            console.error(`\n❌ ${symbol} analiz hatası:`, e.message);
            return null; 
        }
    }
}

/* ====================== SCALP STRATEJİSİ ====================== */
class ScalpStrategy {
    constructor() {
        this.name = "SCALP";
        this.minConfidence = CONFIG.strategies.scalp.minConfidence;
        this.timeframes = CONFIG.strategies.scalp.timeframes;
    }

    async analyze(symbol) {
        console.log(`\n⚡ [SCALP] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.timeframes);
            const ohlcv5m = multiTFData['5m'];
            const ohlcv15m = multiTFData['15m'];
            
            if (!ohlcv5m || ohlcv5m.length < 50) return null;

            const closes5m = ohlcv5m.map(c => c[4]);
            const highs5m = ohlcv5m.map(c => c[2]);
            const lows5m = ohlcv5m.map(c => c[3]);
            const volumes5m = ohlcv5m.map(c => c[5]);
            
            const ema9 = EMA.calculate({ period: 9, values: closes5m });
            const ema21 = EMA.calculate({ period: 21, values: closes5m });
            const rsi = RSI.calculate({ period: 14, values: closes5m });
            const stoch = Stochastic.calculate({
                high: highs5m,
                low: lows5m,
                close: closes5m,
                period: 14,
                signalPeriod: 3
            });
            
            if (!ema9.length || !stoch.length) return null;

            const lastEma9 = ema9[ema9.length - 1];
            const lastEma21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastStoch = stoch[stoch.length - 1];
            const currentPrice = closes5m[closes5m.length - 1];
            
            // Scalp sinyal koşulları
            const bullishScalp = lastEma9 > lastEma21 && lastRSI > 45 && lastRSI < 75 && lastStoch.k > 20;
            const bearishScalp = lastEma9 < lastEma21 && lastRSI < 55 && lastRSI > 25 && lastStoch.k < 80;
            
            if (!bullishScalp && !bearishScalp) return null;
            
            const direction = bullishScalp ? 'LONG_SCALP' : 'SHORT_SCALP';
            const confidence = this.calculateScalpConfidence(lastRSI, lastStoch, lastEma9, lastEma21);
            
            if (confidence < this.minConfidence) return null;
            
            // Scalp için hızlı TP/SL
            const atr = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m });
            const lastATR = atr[atr.length - 1];
            
            let entryPrice, sl, tp;
            if (direction === 'LONG_SCALP') {
                entryPrice = currentPrice;
                sl = entryPrice - (lastATR * 0.8);
                tp = entryPrice + (lastATR * 1.2);
            } else {
                entryPrice = currentPrice;
                sl = entryPrice + (lastATR * 0.8);
                tp = entryPrice - (lastATR * 1.2);
            }
            
            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes5m, 20);
            
            return {
                id: `${symbol}_SCALP_${Date.now()}`,
                coin: EnhancedHelpers.cleanSymbol(symbol),
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'scalp',
                
                giris: EnhancedHelpers.roundToTick(entryPrice),
                tp1: EnhancedHelpers.roundToTick(tp),
                sl: EnhancedHelpers.roundToTick(sl),
                riskReward: 1.5,
                confidence: confidence,
                positionSize: 0.8,
                
                riskLevel: "HIGH",
                tuyo: `⚡ SCALP Sinyal | RSI: ${lastRSI.toFixed(1)} | Stoch: ${lastStoch.k.toFixed(1)} | Hacim: ${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now(),
                holdTime: '5-15m',
                signalQuality: confidence - 10
            };
            
        } catch (e) {
            console.error(`Scalp analiz hatası ${symbol}:`, e.message);
            return null;
        }
    }

    calculateScalpConfidence(rsi, stoch, ema9, ema21) {
        let confidence = 60;
        
        if (rsi > 30 && rsi < 70) confidence += 10;
        if (rsi > 40 && rsi < 60) confidence += 15;
        
        if (stoch.k > 20 && stoch.k < 80) confidence += 10;
        if (stoch.k > 30 && stoch.k < 70) confidence += 10;
        
        const emaDistance = Math.abs(ema9 - ema21) / ema21 * 100;
        if (emaDistance > 0.5) confidence += 15;
        
        return Math.min(95, confidence);
    }
}

/* ====================== TREND TAKİP STRATEJİSİ ====================== */
class TrendStrategy {
    constructor() {
        this.name = "TREND";
        this.minConfidence = CONFIG.strategies.trend.minConfidence;
        this.timeframes = CONFIG.strategies.trend.timeframes;
    }

    async analyze(symbol) {
        console.log(`\n📈 [TREND] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.timeframes);
            const ohlcv4h = multiTFData['4h'];
            const ohlcv1d = multiTFData['1d'];
            
            if (!ohlcv4h || ohlcv4h.length < 100) return null;

            const closes4h = ohlcv4h.map(c => c[4]);
            const highs4h = ohlcv4h.map(c => c[2]);
            const lows4h = ohlcv4h.map(c => c[3]);
            const volumes4h = ohlcv4h.map(c => c[5]);
            
            const ema50 = EMA.calculate({ period: 50, values: closes4h });
            const ema200 = EMA.calculate({ period: 200, values: closes4h });
            const adx = ADX.calculate({ period: 14, high: highs4h, low: lows4h, close: closes4h });
            const macd = MACD.calculate({
                values: closes4h,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            });
            
            if (!ema50.length || !macd.length) return null;

            const lastEma50 = ema50[ema50.length - 1];
            const lastEma200 = ema200[ema200.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastMACD = macd[macd.length - 1];
            const currentPrice = closes4h[closes4h.length - 1];
            
            const bullishTrend = lastEma50 > lastEma200 && lastMACD?.MACD > lastMACD?.signal;
            const bearishTrend = lastEma50 < lastEma200 && lastMACD?.MACD < lastMACD?.signal;
            
            if (!bullishTrend && !bearishTrend) return null;
            
            const direction = bullishTrend ? 'LONG_TREND' : 'SHORT_TREND';
            const confidence = this.calculateTrendConfidence(lastADX, lastEma50, lastEma200, lastMACD);
            
            if (confidence < this.minConfidence) return null;
            
            const atr = ATR.calculate({ period: 14, high: highs4h, low: lows4h, close: closes4h });
            const lastATR = atr[atr.length - 1];
            
            let entryPrice, sl, tp;
            if (direction === 'LONG_TREND') {
                entryPrice = currentPrice;
                sl = entryPrice - (lastATR * 2.0);
                tp = entryPrice + (lastATR * 4.0);
            } else {
                entryPrice = currentPrice;
                sl = entryPrice + (lastATR * 2.0);
                tp = entryPrice - (lastATR * 4.0);
            }
            
            const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes4h, 20);
            
            return {
                id: `${symbol}_TREND_${Date.now()}`,
                coin: EnhancedHelpers.cleanSymbol(symbol),
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'trend',
                
                giris: EnhancedHelpers.roundToTick(entryPrice),
                tp1: EnhancedHelpers.roundToTick(tp),
                sl: EnhancedHelpers.roundToTick(sl),
                riskReward: 4.0,
                confidence: confidence,
                positionSize: 1.2,
                
                riskLevel: "MEDIUM",
                tuyo: `📈 TREND Sinyal | ADX: ${lastADX.toFixed(1)} | EMA50/200: ${lastEma50 > lastEma200 ? 'BULL' : 'BEAR'} | Hacim: ${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now(),
                holdTime: '1-7gün',
                signalQuality: confidence
            };
            
        } catch (e) {
            console.error(`Trend analiz hatası ${symbol}:`, e.message);
            return null;
        }
    }

    calculateTrendConfidence(adx, ema50, ema200, macd) {
        let confidence = 50;
        
        if (adx > 25) confidence += 15;
        if (adx > 35) confidence += 15;
        
        const emaDistance = Math.abs(ema50 - ema200) / ema200 * 100;
        if (emaDistance > 2) confidence += 20;
        if (emaDistance > 5) confidence += 10;
        
        if (macd && Math.abs(macd.MACD - macd.signal) > macd.signal * 0.1) confidence += 10;
        
        return Math.min(95, confidence);
    }
}

/* ====================== STRATEGY MANAGER ====================== */
class StrategyManager {
    constructor() {
        this.strategies = {
            breakout: new BreakoutStrategy(),
            scalp: new ScalpStrategy(),
            trend: new TrendStrategy()
        };
    }

    async analyzeWithStrategy(symbol, strategyName) {
        const strategy = this.strategies[strategyName];
        if (!strategy || !CONFIG.strategies[strategyName].enabled) {
            return null;
        }
        
        return await strategy.analyze(symbol);
    }

    getAllStrategies() {
        return Object.keys(this.strategies).map(key => ({
            name: key,
            config: CONFIG.strategies[key],
            performance: strategyPerformance[key]
        }));
    }
}

const strategyManager = new StrategyManager();

/* ====================== TRADE SİSTEMİ ====================== */
class EnhancedAutoTradeSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        
        try {
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | Güven: %${signal.confidence} | Strateji: ${signal.strategy}`);
            
            const symbol = signal.ccxt_symbol;
            await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
            
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            systemStatus.balance = available;
            
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
            
            const side = signal.taraf.includes('LONG') ? 'buy' : 'sell';
            
            console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x`);
            
            const order = await this.placeOrder(symbol, side, finalAmount, signal.giris, CONFIG.orderType);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
                systemStatus.performance.executedTrades++;
                
                // Bakiye güncelle
                const newBalance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
                systemStatus.balance = parseFloat(newBalance.USDT?.free || 0);
                console.log(`💰 Bakiye güncellendi: ${systemStatus.balance} USDT`);
            }
            
        } catch (e) { 
            console.error('❌ Trade Hatası:', e.message);
        }
    }

    async placeOrder(symbol, side, amount, price, orderType) {
        try {
            if (orderType === 'limit') {
                const order = await requestQueue.push(() => 
                    exchangeAdapter.raw.createOrder(symbol, 'limit', side, amount, price)
                );
                console.log(`✅ LİMİT EMİR GÖNDERİLDİ: ${side} ${amount} @ ${price}`);
                return order;
            } else {
                const order = await requestQueue.push(() => 
                    exchangeAdapter.raw.createOrder(symbol, 'market', side, amount)
                );
                console.log(`✅ MARKET EMİR GÖNDERİLDİ: ${side} ${amount}`);
                return order;
            }
        } catch (error) {
            console.log(`❌ ${orderType.toUpperCase()} emir hatası:`, error.message);
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

    async closePosition(symbol, side, contracts) {
        try {
            console.log(`\n🔻 POZİSYON KAPATMA: ${symbol} | ${side} | ${contracts}`);
            
            const closeAmount = Math.abs(contracts);
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            
            const order = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', closeSide, closeAmount, undefined, {
                    reduceOnly: true
                })
            );
            
            if (order) {
                console.log(`✅ POZİSYON KAPATILDI: ${symbol}`);
                return { success: true, orderId: order.id };
            }
            
        } catch (error) {
            console.log(`❌ POZİSYON KAPATMA HATASI: ${error.message}`);
            throw error;
        }
    }
}

const enhancedAutoTradeSystem = new EnhancedAutoTradeSystem();

/* ====================== SCANNER ====================== */
class EnhancedScanner {
    async scanLoop() {
        const currentHour = new Date().getUTCHours();
        console.log(`\n⏰ TARAMA BAŞLIYOR | Strateji: ${CONFIG.activeStrategy.toUpperCase()} | UTC: ${currentHour}`);

        if (focusedSymbols.length === 0) {
            await this.refreshMarketList();
            return;
        }

        const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
        console.log(`\n⚡ ${batch.length} coin ${CONFIG.activeStrategy} stratejisi ile taranıyor...`);
        
        const validSignals = [];
        for (const sym of batch) {
            const signal = await strategyManager.analyzeWithStrategy(sym, CONFIG.activeStrategy);
            if (signal) {
                validSignals.push(signal);
                strategyPerformance[signal.strategy].signals++;
                
                const riskEmoji = signal.riskLevel === "HIGH" ? "🔴" : signal.riskLevel === "MEDIUM" ? "🟡" : "🟢";
                console.log(`\n🎯 ${riskEmoji} ${signal.strategy.toUpperCase()} Sinyal: ${sym} - ${signal.taraf} | Güven: ${signal.confidence}%`);
            }
        }
        
        if (validSignals.length > 0) {
            console.log(`\n🎯 TOPLAM ${validSignals.length} SİNYAL BULUNDU!`);
            
            validSignals.forEach(signal => {
                this.broadcastEnhancedSignal(signal);
            });
        }
    }

    broadcastEnhancedSignal(signal) {
        signal.tradingViewLink = `/api/signal/tradingview/${signal.ccxt_symbol}`;
        signal.strategyName = CONFIG.strategies[signal.strategy].name;
        
        signalCache.set(signal.id, signal);
        this.broadcastSignalList();
    }

    broadcastSignalList() {
        const allSignals = Array.from(signalCache.values())
            .sort((a, b) => b.timestamp - a.timestamp);
        
        const msg = JSON.stringify({ 
            type: 'signal_list', 
            data: allSignals,
            strategy: CONFIG.activeStrategy
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    }

    async refreshMarketList() {
        try {
            console.log('🌍 PIYASA VERISI YENILENIYOR...');
            await requestQueue.push(() => exchangeAdapter.raw.loadMarkets(true));
            const tickers = await requestQueue.push(() => exchangeAdapter.raw.fetchTickers());
            
            const allSymbols = Object.keys(exchangeAdapter.raw.markets).filter(s => {
                const market = exchangeAdapter.raw.markets[s];
                return market.active && s.includes('USDT') && (market.swap || market.future);
            });

            const highVol = allSymbols.filter(sym => {
                const t = tickers[sym];
                return t && (t.quoteVolume >= CONFIG.minVolumeUSD);
            });

            highVol.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
            cachedHighVol = highVol;
            focusedSymbols = [...cachedHighVol];
            lastMarketRefresh = Date.now();
            systemStatus.filterCount = cachedHighVol.length;
            
            console.log(`✅ ${cachedHighVol.length} coin yüklendi (Min ${CONFIG.minVolumeUSD/1000000}M$)`);
        } catch (e) { 
            console.error('Market refresh error:', e.message); 
        }
    }
}

const enhancedScanner = new EnhancedScanner();

/* ====================== API ROUTES ====================== */
app.get('/api/status/pro', async (req, res) => {
    if (CONFIG.isApiConfigured) {
        try {
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            systemStatus.balance = parseFloat(balance.USDT?.free || 0);
        } catch (e) {
            console.log("Bakiye güncelleme hatası:", e.message);
        }
    }
    
    const positions = await enhancedAutoTradeSystem.getPositions();
    const recentSignals = Array.from(signalCache.values())
        .sort((a, b) => b.timestamp - a.timestamp);

    res.json({ 
        config: CONFIG,
        system: systemStatus,
        positions: positions,
        signals: recentSignals,
        strategies: strategyManager.getAllStrategies(),
        performance: strategyPerformance
    });
});

app.get('/api/strategies', (req, res) => {
    res.json({
        active: CONFIG.activeStrategy,
        all: strategyManager.getAllStrategies(),
        performance: strategyPerformance
    });
});

app.post('/api/strategy/switch', (req, res) => {
    const { strategy } = req.body;
    if (CONFIG.strategies[strategy]) {
        CONFIG.activeStrategy = strategy;
        systemStatus.activeStrategy = strategy;
        console.log(`🎯 Strateji değiştirildi: ${strategy}`);
        res.json({ success: true, newStrategy: strategy });
    } else {
        res.status(400).json({ success: false, error: 'Geçersiz strateji' });
    }
});

app.get('/api/signal/tradingview/:symbol', (req, res) => {
    const symbol = req.params.symbol.replace(':', '').replace('/', '');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BITGET:${symbol}`;
    res.redirect(tvUrl);
});

app.post('/api/trade/manual', async (req, res) => { 
    await enhancedAutoTradeSystem.execute(req.body, true); 
    res.json({ success: true }); 
});

app.post('/api/position/close', async (req, res) => { 
    try {
        const { symbol, side, contracts } = req.body;
        const result = await enhancedAutoTradeSystem.closePosition(symbol, side, contracts);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    try {
        exchangeAdapter = { raw: new ccxt.bitget({
            apiKey: CONFIG.apiKey, 
            secret: CONFIG.secret, 
            password: CONFIG.password,
            options: { defaultType: 'swap' },
            timeout: 30000,
            enableRateLimit: true
        })};
        
        if (CONFIG.isApiConfigured) {
            const b = await exchangeAdapter.raw.fetchBalance();
            systemStatus.balance = parseFloat(b.USDT?.free || 0);
            console.log(`💰 Bakiye: ${systemStatus.balance} USDT`);
        }
        
        console.log('\n⚙️  SONNY TRADER PRO KONFİGURASYONU:');
        console.log(`   🎯 Aktif Strateji: ${CONFIG.activeStrategy.toUpperCase()}`);
        console.log(`   📊 Kırılım: ${CONFIG.strategies.breakout.enabled ? 'AKTİF' : 'PASİF'}`);
        console.log(`   ⚡ Scalp: ${CONFIG.strategies.scalp.enabled ? 'AKTİF' : 'PASİF'}`);
        console.log(`   📈 Trend: ${CONFIG.strategies.trend.enabled ? 'AKTİF' : 'PASİF'}`);
        console.log(`   🔑 API: ${CONFIG.isApiConfigured ? 'KONFİGURE' : 'BEKLİYOR'}`);
        
        await enhancedScanner.refreshMarketList();
        setInterval(() => enhancedScanner.scanLoop(), CONFIG.focusedScanIntervalMs);
        
        console.log('\n✅ SONNY TRADER PRO BAŞARIYLA BAŞLATILDI!');
        
    } catch (error) {
        console.error('❌ Başlangıç hatası:', error.message);
    }
}

server.listen(PORT, () => { 
    console.log(`🚀 SONNY TRADER PRO: http://localhost:${PORT}`); 
    start(); 
});
