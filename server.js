require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV, MACD, SMA } = require('technicalindicators');

const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

    leverage: 10,
    marginPercent: 5,
    maxPositions: 5,
    dailyTradeLimit: 30,
    orderType: 'limit',
    limitOrderPriceOffset: 0.1,
    orderTimeoutMs: 30000,
    minConfidenceForAuto: 65,
    minVolumeUSD: 300000,
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.0,
    signalCooldownMs: 30 * 60 * 1000,
    minPrice: 0.05,
    timeframes: ['15m', '1h', '4h'],
    timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
    maxSlippagePercent: 1.5,
    autotradeMaster: false,
    scanBatchSize: 8,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,
    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 22,
    optimalTradingHours: [7,8,9,13,14,15,19,20,21],
    enableTimeFilter: false,
    snrTolerancePercent: 2.0,
    strategies: {
        breakout: true,
        trendfollow: true,
        pumpdump: true
    }
};

let exchangeAdapter = null;
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
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
    isHealthy: true,
    filterCount: 0,
    balance: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

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
            let data;
            if (exchangeAdapter && CONFIG.isApiConfigured) {
                data = await requestQueue.push(() => exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
            } else {
                data = await requestQueue.push(() => publicExchange.fetchOHLCV(symbol, timeframe, undefined, limit));
            }
            
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

    findSimilarAssets(coin) {
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
    },

    cleanSymbol(symbol) {
        if (!symbol) return '';
        const parts = symbol.split('/');
        return parts[0] + '/USDT';
    }
};

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

        if (confidence < CONFIG.minConfidenceForAuto) return null;

        return {
            direction: direction,
            confidence: Math.round(confidence),
            entry: H.roundToTick(entryPrice),
            stopLoss: H.roundToTick(sl_final),
            takeProfit: H.roundToTick(tp1_final),
            riskReward: Number(rr.toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_BREAKOUT' ? 'Direnç' : 'Destek'} kırılımı bekleniyor - ADX: ${lastADX.toFixed(1)}, Hacim: ${volumeRatio.toFixed(2)}x`
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
            reasoning: `Trend takip - ${direction === 'LONG_TREND' ? 'Yükseliş' : 'Düşüş'} trendi, ADX: ${last.adx.toFixed(1)}`
        };
    }
}

class PumpDumpStrategy {
    constructor() {
        this.name = 'PumpDump';
        this.description = 'Pump and Detection Strategy';
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
            reasoning: `${direction === 'LONG_PUMP' ? 'Pump' : 'Dump'} tespiti - Hacim: ${volumeRatio.toFixed(1)}x, Fiyat: ${(priceChange * 100).toFixed(2)}%`
        };
    }
}

const strategies = {
    breakout: new BreakoutStrategy(),
    trendfollow: new TrendFollowStrategy(),
    pumpdump: new PumpDumpStrategy()
};

async function analyzeSymbol(symbol) {
    if (!H.isOptimalTradingTime()) return null;

    const lastSignalTime = signalHistory.get(symbol) || 0;
    if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) return null;

    const ticker = await requestQueue.push(() => publicExchange.fetchTicker(symbol));
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
        if (CONFIG.strategies[strategyName]) {
            try {
                const result = await strategy.analyze(symbol, multiTFData, ticker, snr);
                if (result && result.confidence >= CONFIG.minConfidenceForAuto) {
                    strategyResults.push(result);
                }
            } catch (error) {
                console.log(`   ❌ ${strategyName} analiz hatası:`, error.message);
            }
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
        orderType: CONFIG.orderType
    };
}

class AutoTradeSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) return;

        try {
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | ${signal.signalSource} | Güven: %${signal.confidence}`);
            
            const symbol = signal.ccxt_symbol;
            const currentPrice = await this.getCurrentPrice(symbol);
            let entryPrice = signal.giris;
            
            if (CONFIG.orderType === 'market') {
                entryPrice = currentPrice;
            }

            if (CONFIG.isApiConfigured) {
                await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
                const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
                const available = parseFloat(balance.USDT?.free || 0);
                
                if (available < 10) {
                    console.log('❌ Yetersiz bakiye');
                    return;
                }
                
                const cost = available * (CONFIG.marginPercent / 100) * signal.positionSize;
                const amountUSDT = cost * CONFIG.leverage;
                let amountCoin = amountUSDT / entryPrice;
                
                const side = signal.taraf === 'LONG_BREAKOUT' ? 'buy' : 'sell';
                console.log(`💰 ${amountCoin} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x`);
                
                const order = await this.placeOrder(symbol, side, amountCoin, entryPrice, CONFIG.orderType);
                
                if (order) {
                    console.log('✅ EMİR BAŞARILI');
                    systemStatus.performance.executedTrades++;
                }
            } else {
                console.log('📊 Sinyal oluşturuldu (API bağlantısı yok)');
            }
            
        } catch (e) {
            console.error('❌ Trade Hatası:', e.message);
        }
    }

    async placeOrder(symbol, side, amount, price, orderType) {
        if (!CONFIG.isApiConfigured) return null;
        
        try {
            if (orderType === 'limit') {
                const order = await requestQueue.push(() => 
                    exchangeAdapter.raw.createOrder(symbol, 'limit', side, amount, price)
                );
                return order;
            } else {
                const order = await requestQueue.push(() => 
                    exchangeAdapter.raw.createOrder(symbol, 'market', side, amount)
                );
                return order;
            }
        } catch (error) {
            console.log(`❌ ${orderType.toUpperCase()} emir hatası:`, error.message);
            return null;
        }
    }

    async getCurrentPrice(symbol) {
        try {
            const ticker = await requestQueue.push(() => 
                CONFIG.isApiConfigured ? exchangeAdapter.raw.fetchTicker(symbol) : publicExchange.fetchTicker(symbol)
            );
            return ticker?.last || 0;
        } catch {
            return 0;
        }
    }

    async getPositions() {
        if (!CONFIG.isApiConfigured) return [];
        try {
            const p = await requestQueue.push(() => exchangeAdapter.raw.fetchPositions());
            return p.filter(x => parseFloat(x.contracts) > 0);
        } catch {
            return [];
        }
    }

    async closePosition(symbol, side, contracts) {
        if (!CONFIG.isApiConfigured) return { success: false, error: 'API bağlantısı yok' };
        
        try {
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            const params = { reduceOnly: true };
            await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', closeSide, Math.abs(contracts), undefined, params)
            );
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

const autoTradeSystem = new AutoTradeSystem();

async function refreshMarketList() {
    try {
        console.log('🌍 LİSTE YENİLENİYOR...');
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

        const sample = cachedHighVol.slice(0, 20);
        let longCount = 0, shortCount = 0;
        
        for (const sym of sample) {
            const ohlcv = await H.fetchOHLCV(sym, '1h', 30);
            if (!ohlcv) continue;
            const closes = ohlcv.map(c => c[4]);
            const ema9 = EMA.calculate({ period: 9, values: closes });
            const ema21 = EMA.calculate({ period: 21, values: closes });
            if (!ema9.length) continue;
            if (ema9[ema9.length - 1] > ema21[ema9.length - 1]) longCount++; else shortCount++;
        }

        if (longCount > shortCount * 1.5) systemStatus.marketSentiment = "YÜKSELİŞ (LONG) AĞIRLIKLI 🐂";
        else if (shortCount > longCount * 1.5) systemStatus.marketSentiment = "DÜŞÜŞ (SHORT) AĞIRLIKLI 🐻";
        else systemStatus.marketSentiment = "YATAY / KARIŞIK 🦀";

        console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${CONFIG.minVolumeUSD / 1000000}M$).`);
    } catch (e) {
        console.error('Market refresh fail:', e.message);
    }
}

async function scanLoop() {
    const currentHour = new Date().getUTCHours();
    console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Stratejiler: ${Object.keys(strategies).filter(s => CONFIG.strategies[s]).join(', ')}`);

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
    console.log(`\n⚡ Tarama: ${batch.length} coin analiz ediliyor...`);

    const validSignals = [];
    for (const sym of batch) {
        const signal = await analyzeSymbol(sym);
        if (signal) {
            validSignals.push(signal);
            console.log(`\n🎯 SİNYAL BULUNDU: ${sym} - ${signal.taraf} | ${signal.signalSource} (Güven: ${signal.confidence}%)`);
        }
    }

    if (validSignals.length > 0) {
        validSignals.forEach(signal => {
            signalCache.set(signal.id, signal);
            if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
                autoTradeSystem.execute(signal);
            }
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
        console.log(`🧹 ${removedCount} eski sinyal temizlendi (1 saat)`);
        broadcastSignalList();
    }
}

function broadcastSignalList() {
    const allSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    const msg = JSON.stringify({ type: 'signal_list', data: allSignals });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (req, res) => {
    const positions = await autoTradeSystem.getPositions();
    const recentSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({
        config: CONFIG,
        system: systemStatus,
        positions: positions,
        signals: recentSignals,
        strategies: Object.keys(strategies).reduce((acc, key) => {
            acc[key] = { name: strategies[key].name, enabled: CONFIG.strategies[key] };
            return acc;
        }, {})
    });
});

app.post('/api/config/update', (req, res) => {
    if (req.body.minConfidenceForAuto !== undefined) {
        CONFIG.minConfidenceForAuto = parseInt(req.body.minConfidenceForAuto);
    }
    if (req.body.orderType !== undefined) {
        CONFIG.orderType = req.body.orderType;
    }
    if (req.body.strategies !== undefined) {
        CONFIG.strategies = { ...CONFIG.strategies, ...req.body.strategies };
    }
    
    Object.assign(CONFIG, req.body);
    console.log('🎯 Config güncellendi:', CONFIG);
    res.json({ success: true });
});

app.post('/api/trade/manual', async (req, res) => {
    await autoTradeSystem.execute(req.body, true);
    res.json({ success: true });
});

app.post('/api/position/close', async (req, res) => {
    try {
        const { symbol, side, contracts } = req.body;
        const result = await autoTradeSystem.closePosition(symbol, side, contracts);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/scan/refresh', async (req, res) => {
    await refreshMarketList();
    res.json({ success: true, count: cachedHighVol.length });
});

async function start() {
    if (CONFIG.isApiConfigured) {
        exchangeAdapter = {
            raw: new ccxt.bitget({
                apiKey: CONFIG.apiKey,
                secret: CONFIG.secret,
                password: CONFIG.password,
                options: { defaultType: 'swap' },
                timeout: 30000,
                enableRateLimit: true
            })
        };
        
        try {
            const b = await exchangeAdapter.raw.fetchBalance();
            systemStatus.balance = parseFloat(b.USDT?.free || 0);
            console.log(`💰 Bakiye: ${systemStatus.balance} USDT`);
        } catch (e) {
            console.log("Bakiye alınamadı:", e.message);
        }
    }
    
    console.log('\n⚙️  SİSTEM KONFİGURASYONU:');
    console.log(`   🎯 Min Güven: ${CONFIG.minConfidenceForAuto}%`);
    console.log(`   📊 Min Hacim: ${CONFIG.minVolumeUSD} USD`);
    console.log(`   📈 Emir Tipi: ${CONFIG.orderType.toUpperCase()}`);
    console.log(`   🤖 Oto Trade: ${CONFIG.autotradeMaster ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🎯 Stratejiler: ${Object.keys(strategies).filter(s => CONFIG.strategies[s]).join(', ')}`);
    console.log(`   ⏰ Sinyal Saklama: 1 SAAT`);
    
    await refreshMarketList();
    setInterval(() => scanLoop(), CONFIG.focusedScanIntervalMs);
    setInterval(cleanupSignalCache, 5 * 60 * 1000);
}

server.listen(PORT, () => {
    console.log(`🚀 TrendMaster AI Trader: http://localhost:${PORT}`);
    start();
});
