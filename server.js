/**
 * server.js - SONNY TRADER PRO v3.0 - TAM PROFESYONEL SİSTEM
 * Tüm eksikler giderildi: Scalp ayarları, Manuel/Oto trade, Piyasa durumu, Çoklu kullanıcı
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV, Stochastic, BollingerBands } = require('technicalindicators');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* ====================== BOOT ====================== */
console.log('=== SONNY TRADER PRO v3.0 - TAM PROFESYONEL SİSTEM ===');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfa - Giriş ekranı
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sonny_trader_pro_secret_key';

/* ====================== ÇOKLU KULLANICI SİSTEMİ ====================== */
const users = new Map();
const userSessions = new Map();

// Varsayılan admin kullanıcısı
const defaultUser = {
    id: 'admin',
    email: 'admin@sonnytrader.com',
    password: bcrypt.hashSync('admin123', 10),
    apiKeys: {},
    settings: {},
    createdAt: new Date()
};

users.set('admin', defaultUser);

/* ====================== GELİŞMİŞ KONFİGURASYON ====================== */
const DEFAULT_CONFIG = {
    // Strategy Settings
    activeStrategy: 'breakout',
    
    strategies: {
        breakout: {
            name: "KIRILIM STRATEJİSİ",
            enabled: true,
            minConfidence: 65,
            timeframes: ['1h', '4h'],
            riskReward: 3.5,
            maxDailySignals: 10,
            volumeThreshold: 1.3,
            atrMultiplier: 1.5
        },
        scalp: {
            name: "SCALP STRATEJİSİ",
            enabled: true,
            minConfidence: 75,
            timeframes: ['5m', '15m'],
            riskReward: 1.5,
            maxDailySignals: 25,
            holdTimeMinutes: 5,
            maxDrawdown: 0.5,
            atrMultiplier: 0.8,
            useStochastic: true,
            useBollinger: true
        },
        trend: {
            name: "TREND TAKİP",
            enabled: true,
            minConfidence: 70,
            timeframes: ['4h', '1d'],
            riskReward: 4.0,
            maxDailySignals: 5,
            trendConfirmation: true,
            atrMultiplier: 2.0
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

    // System Settings
    scanBatchSize: 8,
    focusedScanIntervalMs: 3 * 60 * 1000,
    fullSymbolRefreshMs: 10 * 60 * 1000,
    enableTimeFilter: false,

    // Trade Settings
    autoTrade: false,
    manualTrade: true
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

// Kullanıcı bazlı sistem durumu
const userSystemStatus = new Map();

// Strategy Performance Tracking
const strategyPerformance = {
    breakout: { signals: 0, wins: 0, losses: 0, pnl: 0 },
    scalp: { signals: 0, wins: 0, losses: 0, pnl: 0 },
    trend: { signals: 0, wins: 0, losses: 0, pnl: 0 }
};

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

/* ====================== YARDIMCI FONKSİYONLAR ====================== */
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

    static async getMarketSentiment() {
        if (cachedHighVol.length === 0) return "ANALİZ EDİLİYOR";
        
        const sample = cachedHighVol.slice(0, 30);
        let longCount = 0;
        let shortCount = 0;
        
        for(const sym of sample) {
            const ohlcv = await this.fetchOHLCV(sym, '1h', 30);
            if(!ohlcv) continue;
            const closes = ohlcv.map(c=>c[4]);
            const ema9 = EMA.calculate({period:9, values:closes});
            const ema21 = EMA.calculate({period:21, values:closes});
            if(!ema9.length) continue;
            if(ema9[ema9.length - 1] > ema21[ema9.length - 1]) longCount++; else shortCount++;
        }

        if (longCount > shortCount * 1.5) return "YÜKSELİŞ (LONG) AĞIRLIKLI 🐂";
        else if (shortCount > longCount * 1.5) return "DÜŞÜŞ (SHORT) AĞIRLIKLI 🐻";
        else return "YATAY / KARIŞIK 🦀";
    }
}

/* ====================== STRATEJİ SINIFLARI ====================== */
class BreakoutStrategy {
    constructor(config) {
        this.config = config;
        this.name = "BREAKOUT";
    }

    async analyze(symbol) {
        console.log(`\n🔍 [KIRILIM] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.config.timeframes);
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv1h || ohlcv1h.length < 60) return null;

            const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
            const currentPrice = ticker.last;

            const snr = EnhancedHelpers.findSimpleSnR(ohlcv1h);
            const snrTolerance = currentPrice * 0.02;
            const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

            if (!nearSupport && !nearResistance) return null;

            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);
            const closes1h = ohlcv1h.map(c => c[4]);
            const highs1h = ohlcv1h.map(c => c[2]);
            const lows1h = ohlcv1h.map(c => c[3]);
            const volumes1h = ohlcv1h.map(c => c[5]);
            
            const ema9 = EMA.calculate({ period: 9, values: closes1h });
            const ema21 = EMA.calculate({ period: 21, values: closes1h });
            const rsi = RSI.calculate({ period: 14, values: closes1h });
            const adx = ADX.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            const atr = ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h });
            
            if (!ema9.length || !adx.length) return null;

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

            if (confidence < this.config.minConfidence) return null;

            const direction = (lastEMA9 > lastEMA21 && nearResistance) ? 'LONG_BREAKOUT' : 
                            (lastEMA9 < lastEMA21 && nearSupport) ? 'SHORT_BREAKOUT' : null;

            if (!direction) return null;

            // Pozisyon boyutu ve TP/SL hesapla
            const slDist = lastATR * this.config.atrMultiplier;
            const tpDist = lastATR * (this.config.atrMultiplier * this.config.riskReward);

            let entryPrice, sl_final, tp1_final;
            const breakoutLevel = direction === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
            
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
                tuyo: `🎯 KIRILIM | RSI:${lastRSI?.toFixed(1)} | ADX:${lastADX.toFixed(1)} | Hacim:${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now(),
                signalQuality: confidence
            };
            
        } catch (e) { 
            console.error(`❌ ${symbol} analiz hatası:`, e.message);
            return null; 
        }
    }
}

class ScalpStrategy {
    constructor(config) {
        this.config = config;
        this.name = "SCALP";
    }

    async analyze(symbol) {
        console.log(`\n⚡ [SCALP] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.config.timeframes);
            const ohlcv5m = multiTFData['5m'];
            
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
            
            if (confidence < this.config.minConfidence) return null;
            
            // Scalp için hızlı TP/SL
            const atr = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m });
            const lastATR = atr[atr.length - 1];
            
            let entryPrice, sl, tp;
            if (direction === 'LONG_SCALP') {
                entryPrice = currentPrice;
                sl = entryPrice - (lastATR * this.config.atrMultiplier);
                tp = entryPrice + (lastATR * this.config.atrMultiplier * this.config.riskReward);
            } else {
                entryPrice = currentPrice;
                sl = entryPrice + (lastATR * this.config.atrMultiplier);
                tp = entryPrice - (lastATR * this.config.atrMultiplier * this.config.riskReward);
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
                riskReward: this.config.riskReward,
                confidence: confidence,
                positionSize: 0.8,
                
                riskLevel: "HIGH",
                tuyo: `⚡ SCALP | RSI:${lastRSI.toFixed(1)} | Stoch:${lastStoch.k.toFixed(1)} | Hacim:${volumeRatio.toFixed(2)}x`,
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

class TrendStrategy {
    constructor(config) {
        this.config = config;
        this.name = "TREND";
    }

    async analyze(symbol) {
        console.log(`\n📈 [TREND] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.config.timeframes);
            const ohlcv4h = multiTFData['4h'];
            
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
            
            if (confidence < this.config.minConfidence) return null;
            
            const atr = ATR.calculate({ period: 14, high: highs4h, low: lows4h, close: closes4h });
            const lastATR = atr[atr.length - 1];
            
            let entryPrice, sl, tp;
            if (direction === 'LONG_TREND') {
                entryPrice = currentPrice;
                sl = entryPrice - (lastATR * this.config.atrMultiplier);
                tp = entryPrice + (lastATR * this.config.atrMultiplier * this.config.riskReward);
            } else {
                entryPrice = currentPrice;
                sl = entryPrice + (lastATR * this.config.atrMultiplier);
                tp = entryPrice - (lastATR * this.config.atrMultiplier * this.config.riskReward);
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
                riskReward: this.config.riskReward,
                confidence: confidence,
                positionSize: 1.2,
                
                riskLevel: "MEDIUM",
                tuyo: `📈 TREND | ADX:${lastADX.toFixed(1)} | EMA50/200:${lastEma50 > lastEma200 ? 'BULL' : 'BEAR'} | Hacim:${volumeRatio.toFixed(2)}x`,
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
    constructor(userConfig) {
        this.userConfig = userConfig;
        this.strategies = {
            breakout: new BreakoutStrategy(userConfig.strategies.breakout),
            scalp: new ScalpStrategy(userConfig.strategies.scalp),
            trend: new TrendStrategy(userConfig.strategies.trend)
        };
    }

    async analyzeWithStrategy(symbol, strategyName) {
        const strategy = this.strategies[strategyName];
        if (!strategy || !this.userConfig.strategies[strategyName].enabled) {
            return null;
        }
        
        return await strategy.analyze(symbol);
    }

    getAllStrategies() {
        return Object.keys(this.strategies).map(key => ({
            name: key,
            config: this.userConfig.strategies[key],
            performance: strategyPerformance[key]
        }));
    }

    updateStrategyConfig(strategyName, newConfig) {
        if (this.userConfig.strategies[strategyName]) {
            Object.assign(this.userConfig.strategies[strategyName], newConfig);
            this.strategies[strategyName] = this.createStrategy(strategyName, this.userConfig.strategies[strategyName]);
            return true;
        }
        return false;
    }

    createStrategy(name, config) {
        switch(name) {
            case 'breakout': return new BreakoutStrategy(config);
            case 'scalp': return new ScalpStrategy(config);
            case 'trend': return new TrendStrategy(config);
            default: return null;
        }
    }
}

/* ====================== TRADE SİSTEMİ ====================== */
class EnhancedAutoTradeSystem {
    constructor(userId) {
        this.userId = userId;
        this.userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
    }

    async execute(signal, isManual = false) {
        const userConfig = this.userConfig;
        
        if (!userConfig.apiKeys?.apiKey && !isManual) {
            console.log('❌ API key konfigure edilmemiş');
            return;
        }

        if (!isManual && userConfig.autoTrade && signal.confidence < userConfig.strategies[signal.strategy].minConfidence) {
            console.log(`❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Min güven: ${userConfig.strategies[signal.strategy].minConfidence} isteniyor.`);
            return; 
        }
        
        try {
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | ${isManual ? 'MANUEL' : 'OTO'} | Güven: %${signal.confidence}`);
            
            const symbol = signal.ccxt_symbol;
            
            // Exchange adapter'ı güncelle
            this.updateExchangeAdapter();
            
            await requestQueue.push(() => exchangeAdapter.raw.setLeverage(userConfig.leverage, symbol));
            
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            
            if (available < 10) {
                console.log('❌ Yetersiz bakiye');
                return;
            }
            
            const cost = available * (userConfig.marginPercent / 100) * signal.positionSize;
            const amountUSDT = cost * userConfig.leverage;
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
            
            const order = await this.placeOrder(symbol, side, finalAmount, signal.giris, userConfig.orderType);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
                strategyPerformance[signal.strategy].signals++;
                
                // Sinyal durumunu güncelle
                signal.executed = true;
                signal.orderId = order.id;
                signal.executedAt = new Date();
                
                this.broadcastSignalUpdate(signal);
            }
            
        } catch (e) { 
            console.error('❌ Trade Hatası:', e.message);
        }
    }

    updateExchangeAdapter() {
        const userConfig = this.userConfig;
        if (userConfig.apiKeys?.apiKey) {
            exchangeAdapter = { raw: new ccxt.bitget({
                apiKey: userConfig.apiKeys.apiKey,
                secret: userConfig.apiKeys.secret,
                password: userConfig.apiKeys.password,
                options: { defaultType: 'swap' },
                timeout: 30000,
                enableRateLimit: true
            })};
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

    broadcastSignalUpdate(signal) {
        const msg = JSON.stringify({ 
            type: 'signal_update', 
            data: signal
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === this.userId) {
                client.send(msg);
            }
        });
    }
}

/* ====================== SCANNER ====================== */
class EnhancedScanner {
    constructor(userId) {
        this.userId = userId;
        this.userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
        this.strategyManager = new StrategyManager(this.userConfig);
    }

    async scanLoop() {
        const currentHour = new Date().getUTCHours();
        console.log(`\n⏰ [${this.userId}] TARAMA BAŞLIYOR | Strateji: ${this.userConfig.activeStrategy.toUpperCase()}`);

        if (focusedSymbols.length === 0) {
            await this.refreshMarketList();
            return;
        }

        const batch = focusedSymbols.splice(0, this.userConfig.scanBatchSize);
        console.log(`\n⚡ ${batch.length} coin ${this.userConfig.activeStrategy} stratejisi ile taranıyor...`);
        
        const validSignals = [];
        for (const sym of batch) {
            const signal = await this.strategyManager.analyzeWithStrategy(sym, this.userConfig.activeStrategy);
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
                
                // Otomatik trade
                if (this.userConfig.autoTrade) {
                    const tradeSystem = new EnhancedAutoTradeSystem(this.userId);
                    tradeSystem.execute(signal, false);
                }
            });
        }
    }

    broadcastEnhancedSignal(signal) {
        signal.tradingViewLink = `/api/signal/tradingview/${signal.ccxt_symbol}`;
        signal.strategyName = this.userConfig.strategies[signal.strategy].name;
        
        // Kullanıcı bazlı sinyal cache
        const userSignals = signalCache.get(this.userId) || new Map();
        userSignals.set(signal.id, signal);
        signalCache.set(this.userId, userSignals);
        
        this.broadcastSignalList();
    }

    broadcastSignalList() {
        const userSignals = signalCache.get(this.userId) || new Map();
        const allSignals = Array.from(userSignals.values())
            .sort((a, b) => b.timestamp - a.timestamp);
        
        const msg = JSON.stringify({ 
            type: 'signal_list', 
            data: allSignals,
            strategy: this.userConfig.activeStrategy
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === this.userId) {
                client.send(msg);
            }
        });
    }

    async refreshMarketList() {
        try {
            console.log('🌍 PIYASA VERISI YENILENIYOR...');
            
            // Exchange adapter'ı güncelle
            const tradeSystem = new EnhancedAutoTradeSystem(this.userId);
            tradeSystem.updateExchangeAdapter();
            
            if (!exchangeAdapter) {
                console.log('❌ Exchange adapter oluşturulamadı');
                return;
            }
            
            await requestQueue.push(() => exchangeAdapter.raw.loadMarkets(true));
            const tickers = await requestQueue.push(() => exchangeAdapter.raw.fetchTickers());
            
            const allSymbols = Object.keys(exchangeAdapter.raw.markets).filter(s => {
                const market = exchangeAdapter.raw.markets[s];
                return market.active && s.includes('USDT') && (market.swap || market.future);
            });

            const highVol = allSymbols.filter(sym => {
                const t = tickers[sym];
                return t && (t.quoteVolume >= this.userConfig.minVolumeUSD);
            });

            highVol.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
            cachedHighVol = highVol;
            focusedSymbols = [...cachedHighVol];
            lastMarketRefresh = Date.now();
            
            console.log(`✅ ${cachedHighVol.length} coin yüklendi (Min ${this.userConfig.minVolumeUSD/1000000}M$)`);
        } catch (e) { 
            console.error('Market refresh error:', e.message); 
        }
    }
}

// Kullanıcı scanner'larını yönet
const userScanners = new Map();

/* ====================== WEB SOCKET AUTH ====================== */
wss.on('connection', (ws, req) => {
    console.log('🔗 Yeni WebSocket bağlantısı');
    
    // URL'den token al
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
        ws.close(1008, 'Token gerekli');
        return;
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        ws.userId = decoded.userId;
        userSessions.set(decoded.userId, ws);
        
        console.log(`✅ Kullanıcı bağlandı: ${decoded.userId}`);
        
        // Kullanıcı scanner'ını başlat
        if (!userScanners.has(decoded.userId)) {
            const scanner = new EnhancedScanner(decoded.userId);
            userScanners.set(decoded.userId, scanner);
            
            // İlk taramayı başlat
            setTimeout(() => scanner.scanLoop(), 5000);
            // Periyodik tarama
            setInterval(() => scanner.scanLoop(), scanner.userConfig.focusedScanIntervalMs);
        }
        
        // Mevcut sinyalleri gönder
        const scanner = userScanners.get(decoded.userId);
        if (scanner) {
            scanner.broadcastSignalList();
        }
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                handleWebSocketMessage(decoded.userId, data);
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        });
        
        ws.on('close', () => {
            console.log(`❌ Kullanıcı ayrıldı: ${decoded.userId}`);
            userSessions.delete(decoded.userId);
        });
        
    } catch (error) {
        console.error('WebSocket auth error:', error);
        ws.close(1008, 'Geçersiz token');
    }
});

function handleWebSocketMessage(userId, data) {
    switch (data.type) {
        case 'switch_strategy':
            const userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
            userConfig.activeStrategy = data.strategy;
            userConfigs.set(userId, userConfig);
            console.log(`🎯 ${userId} strateji değiştirdi: ${data.strategy}`);
            break;
    }
}

/* ====================== API ROUTES ====================== */

// Giriş endpoint'i
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // Basit authentication - production'da database kullanın
        let user = null;
        for (let [userId, userData] of users) {
            if (userData.email === email) {
                user = userData;
                break;
            }
        }
        
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Geçersiz email veya şifre' });
        }
        
        const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
        
        // Kullanıcı config'ini yükle veya oluştur
        if (!userConfigs.has(user.id)) {
            userConfigs.set(user.id, { ...DEFAULT_CONFIG, ...user.settings });
        }
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Kullanıcı config kaydetme
app.post('/api/user/config', authenticateToken, (req, res) => {
    const { settings, apiKeys } = req.body;
    const userId = req.user.userId;
    
    try {
        let userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
        
        if (settings) {
            Object.assign(userConfig, settings);
        }
        
        if (apiKeys) {
            userConfig.apiKeys = apiKeys;
        }
        
        userConfigs.set(userId, userConfig);
        
        // Kullanıcıyı güncelle
        const user = users.get(userId);
        if (user) {
            user.settings = userConfig;
            users.set(userId, user);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Config save error:', error);
        res.status(500).json({ error: 'Config kaydedilemedi' });
    }
});

// Kullanıcı config okuma
app.get('/api/user/config', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
    
    res.json({
        success: true,
        config: userConfig
    });
});

// Strateji ayarlarını güncelleme
app.post('/api/strategy/config', authenticateToken, (req, res) => {
    const { strategy, settings } = req.body;
    const userId = req.user.userId;
    
    try {
        const userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
        
        if (userConfig.strategies[strategy]) {
            Object.assign(userConfig.strategies[strategy], settings);
            userConfigs.set(userId, userConfig);
            
            // Scanner'ı güncelle
            const scanner = userScanners.get(userId);
            if (scanner) {
                scanner.userConfig = userConfig;
                scanner.strategyManager.updateStrategyConfig(strategy, settings);
            }
            
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Geçersiz strateji' });
        }
        
    } catch (error) {
        console.error('Strategy config error:', error);
        res.status(500).json({ error: 'Ayarlar kaydedilemedi' });
    }
});

// Manuel trade
app.post('/api/trade/manual', authenticateToken, async (req, res) => {
    const { signal } = req.body;
    const userId = req.user.userId;
    
    try {
        const tradeSystem = new EnhancedAutoTradeSystem(userId);
        await tradeSystem.execute(signal, true);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Manual trade error:', error);
        res.status(500).json({ error: 'Trade başlatılamadı' });
    }
});

// Sistem durumu
app.get('/api/system/status', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    
    try {
        const userConfig = userConfigs.get(userId) || DEFAULT_CONFIG;
        const marketSentiment = await EnhancedHelpers.getMarketSentiment();
        const userSignals = signalCache.get(userId) || new Map();
        const signals = Array.from(userSignals.values());
        
        const systemStatus = {
            balance: 0,
            marketSentiment: marketSentiment,
            activeStrategy: userConfig.activeStrategy,
            performance: {
                totalSignals: signals.length,
                executedTrades: signals.filter(s => s.executed).length,
                winRate: 0
            },
            config: userConfig
        };
        
        // Bakiye bilgisini al
        if (userConfig.apiKeys?.apiKey) {
            try {
                const tradeSystem = new EnhancedAutoTradeSystem(userId);
                tradeSystem.updateExchangeAdapter();
                
                if (exchangeAdapter) {
                    const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
                    systemStatus.balance = parseFloat(balance.USDT?.free || 0);
                }
            } catch (error) {
                console.error('Balance fetch error:', error);
            }
        }
        
        res.json({
            success: true,
            system: systemStatus,
            strategies: userConfig.strategies,
            performance: strategyPerformance
        });
        
    } catch (error) {
        console.error('System status error:', error);
        res.status(500).json({ error: 'Sistem durumu alınamadı' });
    }
});

// TradingView link
app.get('/api/signal/tradingview/:symbol', (req, res) => {
    const symbol = req.params.symbol.replace(':', '').replace('/', '');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BITGET:${symbol}`;
    res.redirect(tvUrl);
});

// Kullanıcı kayıt (demo için)
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // Email kontrolü
        for (let user of users.values()) {
            if (user.email === email) {
                return res.status(400).json({ error: 'Bu email zaten kullanılıyor' });
            }
        }
        
        const userId = 'user_' + Date.now();
        const hashedPassword = bcrypt.hashSync(password, 10);
        
        const newUser = {
            id: userId,
            email: email,
            password: hashedPassword,
            apiKeys: {},
            settings: {},
            createdAt: new Date()
        };
        
        users.set(userId, newUser);
        userConfigs.set(userId, { ...DEFAULT_CONFIG });
        
        const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '24h' });
        
        res.json({
            success: true,
            token,
            user: {
                id: newUser.id,
                email: newUser.email
            }
        });
        
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Kayıt başarısız' });
    }
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    console.log('\n⚙️  SONNY TRADER PRO v3.0 - TAM PROFESYONEL SİSTEM');
    console.log('   🎯 3 Strateji: Kırılım, Scalp, Trend');
    console.log('   👥 Çoklu Kullanıcı Desteği');
    console.log('   ⚡ Manuel & Oto Trade');
    console.log('   📊 Piyasa Durumu Analizi');
    console.log('   🔧 Scalp Ayarları ve Daha Fazlası');
    
    // Varsayılan kullanıcıyı başlat
    userConfigs.set('admin', DEFAULT_CONFIG);
    
    console.log('\n✅ SİSTEM HAZIR!');
    console.log('   📧 Varsayılan Giriş: admin@sonnytrader.com / admin123');
    console.log('   🔗 Giriş Sayfası: http://localhost:' + PORT);
}

server.listen(PORT, () => { 
    console.log(`🚀 SONNY TRADER PRO: http://localhost:${PORT}`); 
    start(); 
});
