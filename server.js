require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware - SADECE GEREKLİ ROUTELAR İÇİN
async function authenticateToken(req, res, next) {
    const publicRoutes = [
        '/', '/login.html', '/register.html', '/index.html',
        '/api/login', '/api/register', '/api/status', '/api/scan/refresh'
    ];
    
    if (publicRoutes.includes(req.path) || req.path.startsWith('/public/')) {
        return next();
    }

    let token = req.headers['authorization'];
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    } else {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }

    try {
        const user = await db.getUserByToken(token);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
}

// Sadece protected routes için auth middleware kullan
app.use('/api/user', authenticateToken);
app.use('/api/trading', authenticateToken);
app.use('/api/settings', authenticateToken);

// Global Configuration
let CONFIG = {
    minVolumeUSD: 300000,
    minPrice: 0.05,
    timeframes: ['15m', '1h', '4h'],
    timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 22,
    snrTolerancePercent: 2.0,
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.0,
    signalCooldownMs: 30 * 60 * 1000,
    scanBatchSize: 8,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,
    enableTimeFilter: false,
    optimalTradingHours: [7, 8, 9, 13, 14, 15, 19, 20, 21]
};

// Global Variables
let publicExchange = new ccxt.bitget({
    options: { defaultType: 'swap' },
    timeout: 30000,
    enableRateLimit: true
});

let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const userConnections = new Map();
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
    isHealthy: true,
    filterCount: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// Request Queue for rate limiting
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

// Helper Functions
const H = {
    async delay(ms) { return new Promise(r => setTimeout(r, ms)); },
    
    roundToTick(price) {
        if (!price || isNaN(price)) return 0;
        if (price < 0.00001) return Number(price.toFixed(8));
        if (price < 0.001) return Number(price.toFixed(7));
        if (price < 1) return Number(price.toFixed(5));
        if (price < 10) return Number(price.toFixed(4));
        return Number(price.toFixed(2));
    },

    async fetchOHLCV(symbol, timeframe, limit = 100) {
        const key = `${symbol}_${timeframe}`;
        const cached = ohlcvCache.get(key);
        if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
        
        try {
            const data = await requestQueue.push(() => publicExchange.fetchOHLCV(symbol, timeframe, undefined, limit));
            if (data && data.length) ohlcvCache.set(key, { data, ts: Date.now() });
            return data;
        } catch (e) {
            console.log(`   ❌ OHLCV hatası ${symbol}:`, e.message);
            return null;
        }
    },

    async fetchMultiTimeframeOHLCV(symbol, timeframes) {
        const results = {};
        for (const tf of timeframes) {
            results[tf] = await this.fetchOHLCV(symbol, tf, 100);
        }
        return results;
    },

    async fetchTicker(symbol) {
        try {
            return await requestQueue.push(() => publicExchange.fetchTicker(symbol));
        } catch (e) {
            console.log(`   ❌ Ticker hatası ${symbol}:`, e.message);
            return null;
        }
    },

    findSimpleSnR(ohlcv15m) {
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
    },

    calculateVolumeRatio(volumes, period = 20) {
        if (!volumes || volumes.length < period) return 1;
        const currentVolume = volumes[volumes.length - 1];
        const recentVolumes = volumes.slice(-period);
        const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
        return currentVolume / avgVolume;
    },

    analyzeMarketStructure(ohlcv1h) {
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
    },

    async confirmBreakoutWithVolume(symbol, breakoutLevel, direction) {
        const recentOhlcv = await this.fetchOHLCV(symbol, '5m', 15);
        if (!recentOhlcv || recentOhlcv.length < 10) {
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
        return { confirmed: volumeConfirmed, strength: strength, ratio: volumeRatio };
    },

    isOptimalTradingTime() {
        if (!CONFIG.enableTimeFilter) return true;
        const hour = new Date().getUTCHours();
        return CONFIG.optimalTradingHours.includes(hour);
    },

    cleanSymbol(symbol) {
        if (!symbol) return '';
        const parts = symbol.split('/');
        return parts[0] + '/USDT';
    },

    tvLink(symbol) {
        const base = symbol.replace(':USDT', '').replace('/USDT', '');
        return `https://www.tradingview.com/chart/?symbol=BITGET:${base}USDT.P`;
    }
};

// Trading Strategies
class BreakoutStrategy {
    constructor() {
        this.name = 'Breakout';
        this.description = 'Support/Resistance Breakout Strategy';
    }

    async analyze(symbol, multiTFData, ticker, snr) {
        const ohlcv15m = multiTFData['15m'];
        const ohlcv1h = multiTFData['1h'];
        const currentPrice = ticker.last;
        
        const snrTolerance = currentPrice * (CONFIG.snrTolerancePercent / 100);
        const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
        const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

        if (!nearSupport && !nearResistance) return null;

        const marketStructure = H.analyzeMarketStructure(ohlcv1h);
        const closes15m = ohlcv15m.map(c => c[4]);
        const highs15m = ohlcv15m.map(c => c[2]);
        const lows15m = ohlcv15m.map(c => c[3]);
        const volumes15m = ohlcv15m.map(c => c[5]);

        const ema9 = EMA.calculate({ period: 9, values: closes15m });
        const ema21 = EMA.calculate({ period: 21, values: closes15m });
        const rsi = RSI.calculate({ period: 14, values: closes15m });
        const adx = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
        const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });

        if (!ema9.length || !adx.length) return null;

        const lastEMA9 = ema9[ema9.length - 1];
        const lastEMA21 = ema21[ema21.length - 1];
        const lastRSI = rsi[rsi.length - 1];
        const lastADX = adx[adx.length - 1]?.adx || 0;
        const lastATR = atr[atr.length - 1];
        const volumeRatio = H.calculateVolumeRatio(volumes15m, 20);

        let direction = 'HOLD';
        let confidence = 60;

        if (nearResistance && lastEMA9 > lastEMA21 && marketStructure !== 'BEARISH') {
            direction = 'LONG_BREAKOUT';
            confidence += 15;
        } else if (nearSupport && lastEMA9 < lastEMA21 && marketStructure !== 'BULLISH') {
            direction = 'SHORT_BREAKOUT';
            confidence += 15;
        }

        if (direction === 'HOLD') return null;

        if (lastADX > CONFIG.minTrendStrength) confidence += 10;
        if (volumeRatio > 1.5) confidence += 8;
        if ((direction === 'LONG_BREAKOUT' && lastRSI < 65) || (direction === 'SHORT_BREAKOUT' && lastRSI > 35)) {
            confidence += 7;
        }

        const slDist = lastATR * CONFIG.atrSLMultiplier;
        const tpDist = lastATR * CONFIG.atrTPMultiplier;

        let entryPrice, sl_final, tp1_final;
        if (direction === 'LONG_BREAKOUT') {
            entryPrice = snr.resistance;
            sl_final = entryPrice - slDist;
            tp1_final = entryPrice + tpDist;
        } else {
            entryPrice = snr.support;
            sl_final = entryPrice + slDist;
            tp1_final = entryPrice - tpDist;
        }

        const risk = Math.abs(entryPrice - sl_final);
        const reward = Math.abs(tp1_final - entryPrice);
        const rr = reward / risk;

        return {
            direction: direction,
            confidence: Math.round(confidence),
            entry: H.roundToTick(entryPrice),
            stopLoss: H.roundToTick(sl_final),
            takeProfit: H.roundToTick(tp1_final),
            riskReward: Number(rr.toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_BREAKOUT' ? 'Direnç' : 'Destek'} kırılımı - ADX:${lastADX.toFixed(1)} Hacim:${volumeRatio.toFixed(1)}x`
        };
    }
}

class TrendFollowStrategy {
    constructor() {
        this.name = 'TrendFollow';
        this.description = 'Trend Following Strategy';
    }

    async analyze(symbol, multiTFData, ticker) {
        const ohlcv1h = multiTFData['1h'];
        if (!ohlcv1h || ohlcv1h.length < 50) return null;

        const closes = ohlcv1h.map(c => c[4]);
        const highs = ohlcv1h.map(c => c[2]);
        const lows = ohlcv1h.map(c => c[3]);

        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        const rsi = RSI.calculate({ period: 14, values: closes });
        const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
        const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

        if (!ema20.length || !ema50.length) return null;

        const last = {
            ema20: ema20[ema20.length - 1],
            ema50: ema50[ema50.length - 1],
            rsi: rsi[rsi.length - 1],
            adx: adx[adx.length - 1]?.adx || 0,
            macd: macd[macd.length - 1],
            price: ticker.last
        };

        let direction = 'HOLD';
        let confidence = 55;

        if (last.ema20 > last.ema50 && last.adx > CONFIG.minTrendStrength && last.rsi < 70) {
            direction = 'LONG_TREND';
            confidence = 70;
        } else if (last.ema20 < last.ema50 && last.adx > CONFIG.minTrendStrength && last.rsi > 30) {
            direction = 'SHORT_TREND';
            confidence = 70;
        }

        if (direction === 'HOLD') return null;

        if (last.adx > 35) confidence += 10;
        if (last.macd && last.macd.MACD > last.macd.signal && direction === 'LONG_TREND') confidence += 8;
        if (last.macd && last.macd.MACD < last.macd.signal && direction === 'SHORT_TREND') confidence += 8;

        const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const lastATR = atr[atr.length - 1];
        const slDist = lastATR * 2.0;
        const tpDist = lastATR * 3.0;

        let sl, tp;
        if (direction === 'LONG_TREND') {
            sl = last.price - slDist;
            tp = last.price + tpDist;
        } else {
            sl = last.price + slDist;
            tp = last.price - tpDist;
        }

        const risk = Math.abs(last.price - sl);
        const reward = Math.abs(tp - last.price);
        const rr = reward / risk;

        return {
            direction: direction === 'LONG_TREND' ? 'LONG' : 'SHORT',
            confidence: Math.round(confidence),
            entry: H.roundToTick(last.price),
            stopLoss: H.roundToTick(sl),
            takeProfit: H.roundToTick(tp),
            riskReward: Number(rr.toFixed(2)),
            strategy: this.name,
            reasoning: `Trend takip - ${direction === 'LONG_TREND' ? 'Yükseliş' : 'Düşüş'} trendi, ADX:${last.adx.toFixed(1)}`
        };
    }
}

class PumpDumpStrategy {
    constructor() {
        this.name = 'PumpDump';
        this.description = 'Pump and Dump Detection Strategy';
        this.lastSignals = new Map();
    }

    async analyze(symbol, multiTFData, ticker) {
        const ohlcv5m = await H.fetchOHLCV(symbol, '5m', 20);
        if (!ohlcv5m || ohlcv5m.length < 10) return null;

        const now = Date.now();
        const lastSignal = this.lastSignals.get(symbol);
        if (lastSignal && (now - lastSignal) < 600000) return null;

        const volumes = ohlcv5m.map(c => c[5]);
        const closes = ohlcv5m.map(c => c[4]);
        const currentVolume = volumes[volumes.length - 1];
        const avgVolume = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
        const volumeRatio = currentVolume / avgVolume;

        const currentPrice = closes[closes.length - 1];
        const previousPrice = closes[closes.length - 2];
        const priceChange = (currentPrice - previousPrice) / previousPrice;

        if (volumeRatio < 2.5 || Math.abs(priceChange) < 0.03) return null;

        let direction = 'HOLD';
        let confidence = 65;

        if (priceChange > 0.03 && volumeRatio > 3.0) {
            direction = 'LONG_PUMP';
            confidence += 15;
        } else if (priceChange < -0.03 && volumeRatio > 3.0) {
            direction = 'SHORT_DUMP';
            confidence += 15;
        }

        if (direction === 'HOLD') return null;

        const atr = ATR.calculate({ period: 14, high: ohlcv5m.map(c => c[2]), low: ohlcv5m.map(c => c[3]), close: closes });
        const lastATR = atr[atr.length - 1];
        const slDist = lastATR * 2.5;
        const tpDist = lastATR * 4.0;

        let sl, tp;
        if (direction === 'LONG_PUMP') {
            sl = currentPrice - slDist;
            tp = currentPrice + tpDist;
        } else {
            sl = currentPrice + slDist;
            tp = currentPrice - tpDist;
        }

        this.lastSignals.set(symbol, now);

        return {
            direction: direction === 'LONG_PUMP' ? 'LONG' : 'SHORT',
            confidence: Math.round(confidence),
            entry: H.roundToTick(currentPrice),
            stopLoss: H.roundToTick(sl),
            takeProfit: H.roundToTick(tp),
            riskReward: Number((tpDist / slDist).toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_PUMP' ? 'Pump' : 'Dump'} - Hacim:${volumeRatio.toFixed(1)}x Fiyat:${(priceChange * 100).toFixed(2)}%`
        };
    }
}

const strategies = {
    breakout: new BreakoutStrategy(),
    trendfollow: new TrendFollowStrategy(),
    pumpdump: new PumpDumpStrategy()
};

// Enhanced Market Sentiment Analysis
async function analyzeMarketSentiment() {
    if (cachedHighVol.length === 0) return "ANALİZ EDİLİYOR...";

    const sample = cachedHighVol.slice(0, 30);
    let bullSignals = 0;
    let bearSignals = 0;
    let totalAnalyzed = 0;

    for (const sym of sample) {
        try {
            const ohlcv1h = await H.fetchOHLCV(sym, '1h', 50);
            if (!ohlcv1h || ohlcv1h.length < 20) continue;

            const closes = ohlcv1h.map(c => c[4]);
            const ema9 = EMA.calculate({ period: 9, values: closes });
            const ema21 = EMA.calculate({ period: 21, values: closes });
            
            if (!ema9.length || !ema21.length) continue;

            const lastEma9 = ema9[ema9.length - 1];
            const lastEma21 = ema21[ema21.length - 1];
            
            // Price action analysis
            const recentPrices = closes.slice(-10);
            const priceTrend = recentPrices[recentPrices.length - 1] > recentPrices[0] ? 'BULL' : 'BEAR';
            
            // Volume analysis
            const volumes = ohlcv1h.map(c => c[5]);
            const volumeTrend = volumes[volumes.length - 1] > volumes[volumes.length - 2] ? 'BULL' : 'BEAR';
            
            // Combined analysis
            if (lastEma9 > lastEma21 && priceTrend === 'BULL' && volumeTrend === 'BULL') {
                bullSignals++;
            } else if (lastEma9 < lastEma21 && priceTrend === 'BEAR' && volumeTrend === 'BEAR') {
                bearSignals++;
            }
            
            totalAnalyzed++;
        } catch (error) {
            console.log(`Market sentiment analiz hatası ${sym}:`, error.message);
        }
    }

    if (totalAnalyzed === 0) return "YETERSİZ VERİ";

    const bullRatio = bullSignals / totalAnalyzed;
    const bearRatio = bearSignals / totalAnalyzed;

    if (bullRatio > 0.6) return "GÜÇLÜ YÜKSELİŞ 🟢";
    if (bearRatio > 0.6) return "GÜÇLÜ DÜŞÜŞ 🔴";
    if (bullRatio > bearRatio) return "YÜKSELİŞ AĞIRLIKLI 🟡";
    if (bearRatio > bullRatio) return "DÜŞÜŞ AĞIRLIKLI 🟠";
    
    return "YATAY/DENGELİ ⚪️";
}

// Symbol Analysis
async function analyzeSymbol(symbol) {
    if (!H.isOptimalTradingTime()) return null;

    const lastSignalTime = signalHistory.get(symbol) || 0;
    if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) return null;

    const ticker = await H.fetchTicker(symbol);
    if (!ticker || ticker.last < CONFIG.minPrice) return null;

    const multiTFData = await H.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
    const ohlcv15m = multiTFData['15m'];
    if (!ohlcv15m || ohlcv15m.length < 60) return null;

    const snr = H.findSimpleSnR(ohlcv15m);
    const currentPrice = ticker.last;

    const snrTolerance = currentPrice * (CONFIG.snrTolerancePercent / 100);
    const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
    const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;

    const strategyResults = [];

    for (const [strategyName, strategy] of Object.entries(strategies)) {
        try {
            const result = await strategy.analyze(symbol, multiTFData, ticker, snr);
            if (result && result.confidence >= 50) {
                strategyResults.push(result);
            }
        } catch (error) {
            console.log(`   ❌ ${strategyName} analiz hatası:`, error.message);
        }
    }

    if (strategyResults.length === 0) return null;

    const bestResult = strategyResults.reduce((best, current) => 
        current.confidence > best.confidence ? current : best
    );

    const volumeInfo = await H.confirmBreakoutWithVolume(symbol, bestResult.entry, bestResult.direction);

    let finalConfidence = bestResult.confidence;
    if (volumeInfo.strength === 'STRONG') finalConfidence += 10;
    else if (volumeInfo.strength === 'MEDIUM') finalConfidence += 5;

    signalHistory.set(symbol, Date.now());
    systemStatus.performance.totalSignals++;

    return {
        id: `${symbol}_${bestResult.strategy}_${Date.now()}`,
        coin: H.cleanSymbol(symbol),
        ccxt_symbol: symbol,
        taraf: bestResult.direction.includes('LONG') ? 'LONG_BREAKOUT' : 'SHORT_BREAKOUT',
        giris: bestResult.entry,
        tp1: bestResult.takeProfit,
        sl: bestResult.stopLoss,
        riskReward: bestResult.riskReward,
        confidence: Math.round(finalConfidence),
        positionSize: 1.0,
        positionSizeType: 'NORMAL',
        riskLevel: finalConfidence >= 75 ? 'LOW' : 'MEDIUM',
        tuyo: `${bestResult.strategy}: ${bestResult.reasoning} | Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)`,
        timestamp: Date.now(),
        adx: 0,
        rsi: 0,
        obvTrend: '→',
        signalQuality: Math.round(finalConfidence),
        marketStructure: 'ANALYZED',
        volumeConfirmed: volumeInfo.confirmed,
        signalSource: bestResult.strategy,
        isAISignal: false,
        orderType: 'limit'
    };
}

// Auto Trade System
class AutoTradeSystem {
    constructor() {
        this.userExchanges = new Map();
    }

    getExchange(user) {
        if (!user.api_key || !user.api_secret) return null;
        
        if (!this.userExchanges.has(user.id)) {
            this.userExchanges.set(user.id, new ccxt.bitget({
                apiKey: user.api_key,
                secret: user.api_secret,
                password: user.api_passphrase || '',
                options: { defaultType: 'swap' },
                timeout: 30000,
                enableRateLimit: true
            }));
        }
        return this.userExchanges.get(user.id);
    }

    async execute(signal, user, userSettings) {
        const exchange = this.getExchange(user);
        if (!exchange) {
            console.log(`❌ ${user.email} için API key bulunamadı`);
            return { success: false, error: 'API key gerekli' };
        }

        if (userSettings.autotrade_enabled && signal.confidence < userSettings.min_confidence) {
            console.log(`❌ Güven filtresi: ${signal.confidence} < ${userSettings.min_confidence}`);
            return { success: false, error: 'Güven filtresi' };
        }

        try {
            const symbol = signal.ccxt_symbol;
            const currentPrice = await this.getCurrentPrice(symbol, exchange);
            let entryPrice = signal.giris;
            
            if (userSettings.order_type === 'market') {
                entryPrice = currentPrice;
            }

            await requestQueue.push(() => exchange.setLeverage(user.leverage || 10, symbol));
            const balance = await requestQueue.push(() => exchange.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            
            if (available < 10) {
                return { success: false, error: 'Yetersiz bakiye' };
            }
            
            const cost = available * ((user.margin_percent || 5) / 100);
            const amountUSDT = cost * (user.leverage || 10);
            let amountCoin = amountUSDT / entryPrice;
            
            const side = signal.taraf === 'LONG_BREAKOUT' ? 'buy' : 'sell';
            
            const order = await this.placeOrder(symbol, side, amountCoin, entryPrice, userSettings.order_type, exchange);
            
            if (order) {
                console.log(`✅ ${user.email} - ${symbol} ${side} emri başarılı`);
                systemStatus.performance.executedTrades++;
                
                // Save trade to database
                db.run(
                    `INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, leverage, margin_percent, status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [user.id, symbol, side, entryPrice, amountCoin, user.leverage, user.margin_percent, 'open']
                );
                
                return { success: true, orderId: order.id };
            }
            
            return { success: false, error: 'Order oluşturulamadı' };
            
        } catch (e) {
            console.error(`❌ Trade Hatası (${user.email}):`, e.message);
            return { success: false, error: e.message };
        }
    }

    async placeOrder(symbol, side, amount, price, orderType, exchange) {
        try {
            if (orderType === 'limit') {
                return await requestQueue.push(() => exchange.createOrder(symbol, 'limit', side, amount, price));
            } else {
                return await requestQueue.push(() => exchange.createOrder(symbol, 'market', side, amount));
            }
        } catch (error) {
            console.log(`❌ ${orderType.toUpperCase()} emir hatası:`, error.message);
            return null;
        }
    }

    async getCurrentPrice(symbol, exchange) {
        try {
            const ticker = await requestQueue.push(() => exchange.fetchTicker(symbol));
            return ticker?.last || 0;
        } catch {
            return 0;
        }
    }

    async getPositions(user) {
        const exchange = this.getExchange(user);
        if (!exchange) return [];
        
        try {
            const positions = await requestQueue.push(() => exchange.fetchPositions());
            return positions.filter(x => parseFloat(x.contracts) > 0);
        } catch {
            return [];
        }
    }

    async closePosition(user, symbol, side, contracts) {
        const exchange = this.getExchange(user);
        if (!exchange) return { success: false, error: 'API bağlantısı yok' };
        
        try {
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            const params = { reduceOnly: true };
            await requestQueue.push(() => 
                exchange.createOrder(symbol, 'market', closeSide, Math.abs(contracts), undefined, params)
            );
            
            // Update trade status in database
            db.run(
                "UPDATE trades SET status = 'closed', exit_price = ? WHERE user_id = ? AND symbol = ? AND status = 'open'",
                [Date.now(), user.id, symbol]
            );
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

const autoTradeSystem = new AutoTradeSystem();

// Market Scanner
async function refreshMarketList() {
    try {
        console.log('🌍 PİYASA LİSTESİ YENİLENİYOR...');
        await requestQueue.push(() => publicExchange.loadMarkets());
        const tickers = await requestQueue.push(() => publicExchange.fetchTickers());
        const allSymbols = Object.keys(publicExchange.markets).filter(s => {
            const market = publicExchange.markets[s];
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

        // Enhanced market sentiment analysis
        systemStatus.marketSentiment = await analyzeMarketSentiment();

        console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin | Piyasa: ${systemStatus.marketSentiment}`);
    } catch (e) {
        console.error('Market refresh hatası:', e.message);
    }
}

async function scanLoop() {
    const currentHour = new Date().getUTCHours();
    console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Piyasa: ${systemStatus.marketSentiment}`);

    if (focusedSymbols.length === 0) {
        const now = Date.now();
        if (now - lastMarketRefresh > CONFIG.fullSymbolRefreshMs || cachedHighVol.length === 0) {
            await refreshMarketList();
        } else {
            focusedSymbols = [...cachedHighVol];
            await H.delay(1000);
        }
        return;
    }

    const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
    console.log(`\n⚡ ${batch.length} coin analiz ediliyor...`);

    const validSignals = [];
    for (const sym of batch) {
        const signal = await analyzeSymbol(sym);
        if (signal) {
            validSignals.push(signal);
            console.log(`\n🎯 SİNYAL: ${sym} - ${signal.taraf} | ${signal.signalSource} (%${signal.confidence})`);
        }
    }

    if (validSignals.length > 0) {
        validSignals.forEach(signal => {
            signalCache.set(signal.id, signal);
            
            // Auto trade for users with enabled autotrade
            userConnections.forEach((userData, userId) => {
                if (userData.settings.autotrade_enabled && signal.confidence >= userData.settings.min_confidence) {
                    autoTradeSystem.execute(signal, userData.user, userData.settings);
                }
            });
        });
        broadcastSignalList();
    }
}

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

// WebSocket Broadcasting
function broadcastToUser(userId, message) {
    const userData = userConnections.get(userId);
    if (userData && userData.ws.readyState === WebSocket.OPEN) {
        userData.ws.send(JSON.stringify(message));
    }
}

function broadcastSignalList() {
    const allSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    const publicMsg = JSON.stringify({ type: 'signal_list', data: allSignals });
    
    console.log(`📤 Sinyal yayınlanıyor: ${allSignals.length} sinyal`);
    
    // Public broadcast
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(publicMsg);
        }
    });
}

function broadcastSystemStatus() {
    const statusMsg = JSON.stringify({ type: 'system_status', data: systemStatus });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(statusMsg);
        }
    });
}

// WebSocket Connection Handling - DÜZELTİLDİ
wss.on('connection', (ws) => {
    console.log('🔗 Yeni WebSocket bağlantısı');
    
    // Hemen sistem durumunu gönder
    ws.send(JSON.stringify({ 
        type: 'system_status', 
        data: systemStatus 
    }));
    
    // Mevcut sinyalleri gönder
    const allSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    ws.send(JSON.stringify({ 
        type: 'signal_list', 
        data: allSignals 
    }));
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'auth') {
                const user = await db.getUserByToken(message.token);
                if (user) {
                    ws.userId = user.id;
                    const settings = await db.getUserSettings(user.id);
                    
                    userConnections.set(user.id, {
                        ws: ws,
                        user: user,
                        settings: settings || {
                            min_confidence: 65,
                            autotrade_enabled: false,
                            order_type: 'limit',
                            strategies: { breakout: true, trendfollow: true, pumpdump: true }
                        }
                    });
                    
                    console.log(`✅ Kullanıcı girişi: ${user.email}`);
                    
                    // Send initial data
                    ws.send(JSON.stringify({ 
                        type: 'user_data', 
                        data: { user, settings } 
                    }));
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        if (ws.userId) {
            userConnections.delete(ws.userId);
            console.log(`🔴 Kullanıcı bağlantısı kapandı: ${ws.userId}`);
        }
    });
});

// PUBLIC ROUTES - Authentication GEREKTİRMEYEN
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// PUBLIC API ROUTES
app.get('/api/status', async (req, res) => {
    let positions = [];
    
    // Eğer kullanıcı giriş yapmışsa pozisyonlarını getir
    if (req.user) {
        positions = await autoTradeSystem.getPositions(req.user);
    }
    
    const recentSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({
        success: true,
        system: systemStatus,
        signals: recentSignals,
        positions: positions,
        strategies: Object.keys(strategies).reduce((acc, key) => {
            acc[key] = { name: strategies[key].name, description: strategies[key].description };
            return acc;
        }, {})
    });
});

app.post('/api/scan/refresh', async (req, res) => {
    await refreshMarketList();
    res.json({ success: true, count: cachedHighVol.length, sentiment: systemStatus.marketSentiment });
});

// AUTHENTICATION ROUTES
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const user = await db.getUserByEmail(email);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, error: 'Geçersiz şifre' });
        }

        const sessionToken = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await db.updateUserSession(user.id, sessionToken);

        const settings = await db.getUserSettings(user.id);

        res.json({ 
            success: true, 
            user: { 
                id: user.id,
                email: user.email, 
                plan: user.plan,
                leverage: user.leverage,
                margin_percent: user.margin_percent,
                risk_level: user.risk_level,
                daily_trade_limit: user.daily_trade_limit,
                max_positions: user.max_positions
            },
            settings: settings,
            token: sessionToken
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const existingUser = await db.getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email zaten kullanımda' });
        }

        const userId = await db.createUser(email, password, 'basic');
        
        res.json({ 
            success: true, 
            message: 'Kayıt başarılı',
            userId: userId
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PROTECTED ROUTES - Authentication GEREKTİREN
app.post('/api/logout', authenticateToken, async (req, res) => {
    try {
        await db.updateUserSession(req.user.id, null);
        userConnections.delete(req.user.id);
        res.json({ success: true, message: 'Çıkış başarılı' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// User settings routes
app.get('/api/user/settings', authenticateToken, async (req, res) => {
    try {
        const settings = await db.getUserSettings(req.user.id);
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/settings', authenticateToken, async (req, res) => {
    try {
        await db.updateUserSettings(req.user.id, req.body);
        res.json({ success: true, message: 'Ayarlar kaydedildi' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/api-keys', authenticateToken, async (req, res) => {
    const { api_key, api_secret, api_passphrase } = req.body;
    
    try {
        db.run(
            "UPDATE users SET api_key = ?, api_secret = ?, api_passphrase = ? WHERE id = ?",
            [api_key, api_secret, api_passphrase, req.user.id]
        );
        res.json({ success: true, message: 'API keyler kaydedildi' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/user/trade-settings', authenticateToken, async (req, res) => {
    const { leverage, margin_percent, risk_level, daily_trade_limit, max_positions } = req.body;
    
    try {
        db.run(
            "UPDATE users SET leverage = ?, margin_percent = ?, risk_level = ?, daily_trade_limit = ?, max_positions = ? WHERE id = ?",
            [leverage, margin_percent, risk_level, daily_trade_limit, max_positions, req.user.id]
        );
        res.json({ success: true, message: 'Trade ayarları kaydedildi' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trading routes
app.get('/api/trading/positions', authenticateToken, async (req, res) => {
    try {
        const positions = await autoTradeSystem.getPositions(req.user);
        res.json({ success: true, positions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/trading/manual', authenticateToken, async (req, res) => {
    try {
        const userSettings = await db.getUserSettings(req.user.id);
        const result = await autoTradeSystem.execute(req.body, req.user, userSettings);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/trading/close-position', authenticateToken, async (req, res) => {
    try {
        const { symbol, side, contracts } = req.body;
        const result = await autoTradeSystem.closePosition(req.user, symbol, side, contracts);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start system
async function start() {
    console.log('\n🚀 ALPHASON AI TRADER BAŞLATILIYOR');
    console.log('⚙️  SİSTEM KONFİGURASYONU:');
    console.log(`   📊 Min Hacim: ${CONFIG.minVolumeUSD} USD`);
    console.log(`   🎯 Stratejiler: ${Object.keys(strategies).join(', ')}`);
    console.log(`   ⏰ Sinyal Saklama: 1 SAAT`);
    console.log(`   🔗 API Key: GEREKMEZ (Public tarama)`);
    console.log(`   👤 Admin Kullanıcı: admin@alphason.com / 123`);
    
    await refreshMarketList();
    setInterval(() => scanLoop(), CONFIG.focusedScanIntervalMs);
    setInterval(cleanupSignalCache, 5 * 60 * 1000);
    setInterval(broadcastSystemStatus, 10000);
    setInterval(refreshMarketList, CONFIG.fullSymbolRefreshMs);
}

server.listen(PORT, () => {
    console.log(`📍 AlphaSon AI Trader: http://localhost:${PORT}`);
    start();
});
