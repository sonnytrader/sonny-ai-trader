/**
 * server.js - AlphaSon Crypto v1.0 - SAF TEKNİK ANALİZ
 * 3 Stratejili Trading Sistemi
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

/* ====================== BOOT ====================== */
console.log('=== ALPHASON CRYPTO v1.0 - 3 STRATEJİLİ TEKNİK ANALİZ ===');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

/* ====================== KONFİGURASYON ====================== */
let CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

    // Risk Yönetimi
    leverage: 10,
    marginPercent: 5,
    maxPositions: 5,
    dailyTradeLimit: 30,

    // Emir Tipi
    orderType: 'limit',
    limitOrderPriceOffset: 0.1,
    orderTimeoutMs: 30000,

    minConfidenceForAuto: 65,
    minVolumeUSD: 300000,
    
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.5,
    
    signalCooldownMs: 30 * 60 * 1000,
    minPrice: 0.05,
    
    timeframes: ['15m', '1h', '4h'],
    timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
    
    maxSlippagePercent: 1.5,
    autotradeMaster: false,

    scanBatchSize: 10,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,

    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 20,
    optimalTradingHours: [7,8,9,13,14,15,19,20,21],
    enableTimeFilter: false,
    
    snrTolerancePercent: 2.0,
    useSimpleSnR: true,

    // 🔥 YENİ: Strateji Seçimi
    activeStrategy: 'breakout' // breakout, pumpdetect, rsimacd
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

const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    balance: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

/* ====================== YARDIMCILAR ====================== */
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

/* ====================== 3 STRATEJİLİ SİSTEM ====================== */
class AlphaSonStrategyEngine {
    
    // 🔥 STRATEJİ 1: KIRILIM STRATEJİSİ
    async analyzeBreakout(symbol, multiTFData, currentPrice, snr, marketStructure) {
        console.log(`   🎯 ${symbol}: KIRILIM STRATEJİSİ analizi`);
        
        const ohlcv15m = multiTFData['15m'];
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
        const lastADX = adx[adx.length - 1].adx;
        const lastATR = atr[atr.length - 1];
        const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes15m, 20);

        // Kırılım mantığı
        const nearResistance = Math.abs(currentPrice - snr.resistance) <= currentPrice * 0.02;
        const nearSupport = Math.abs(currentPrice - snr.support) <= currentPrice * 0.02;

        let direction = 'HOLD';
        let confidence = 50;

        if (nearResistance && lastEMA9 > lastEMA21 && volumeRatio > 1.5) {
            direction = 'LONG_BREAKOUT';
            confidence = 70 + (volumeRatio * 5) + (lastADX > 25 ? 10 : 0);
        } else if (nearSupport && lastEMA9 < lastEMA21 && volumeRatio > 1.5) {
            direction = 'SHORT_BREAKOUT';
            confidence = 70 + (volumeRatio * 5) + (lastADX > 25 ? 10 : 0);
        }

        if (direction === 'HOLD' || confidence < CONFIG.minConfidenceForAuto) return null;

        return {
            direction,
            confidence: Math.min(95, confidence),
            reasoning: `🎯 KIRILIM | ${direction} | Hacim: ${volumeRatio.toFixed(2)}x | ADX: ${lastADX.toFixed(1)}`,
            strategy: 'breakout'
        };
    }

    // 🔥 STRATEJİ 2: PUMP/DETECTOR
    async analyzePumpDetect(symbol, multiTFData, currentPrice) {
        console.log(`   📈 ${symbol}: PUMP/DETECTOR analizi`);
        
        const ohlcv5m = await EnhancedHelpers.fetchOHLCV(symbol, '5m', 50);
        if (!ohlcv5m || ohlcv5m.length < 30) return null;

        const volumes = ohlcv5m.map(c => c[5]);
        const closes = ohlcv5m.map(c => c[4]);
        
        // Son 5 mumun hacim analizi
        const recentVolumes = volumes.slice(-5);
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const currentVolumeRatio = recentVolumes[recentVolumes.length - 1] / avgVolume;
        
        // Fiyat değişimi
        const recentCloses = closes.slice(-6);
        const priceChange = ((recentCloses[5] - recentCloses[0]) / recentCloses[0]) * 100;

        let direction = 'HOLD';
        let confidence = 50;

        // Pump tespiti
        if (currentVolumeRatio > 3.0 && priceChange > 5) {
            direction = 'LONG_BREAKOUT';
            confidence = 75 + (currentVolumeRatio * 3);
        } 
        // Dump tespiti
        else if (currentVolumeRatio > 3.0 && priceChange < -5) {
            direction = 'SHORT_BREAKOUT';
            confidence = 75 + (currentVolumeRatio * 3);
        }

        if (direction === 'HOLD' || confidence < CONFIG.minConfidenceForAuto) return null;

        return {
            direction,
            confidence: Math.min(95, confidence),
            reasoning: `📈 PUMP/DETECT | ${direction} | Hacim: ${currentVolumeRatio.toFixed(2)}x | Fiyat: ${priceChange.toFixed(2)}%`,
            strategy: 'pumpdetect'
        };
    }

    // 🔥 STRATEJİ 3: RSI+MACD+EMA KOMBO
    async analyzeRSIMACD(symbol, multiTFData, currentPrice) {
        console.log(`   🔄 ${symbol}: RSI+MACD+EMA KOMBO analizi`);
        
        const ohlcv15m = multiTFData['15m'];
        const closes15m = ohlcv15m.map(c => c[4]);
        const highs15m = ohlcv15m.map(c => c[2]);
        const lows15m = ohlcv15m.map(c => c[3]);

        // RSI
        const rsi = RSI.calculate({ period: 14, values: closes15m });
        const lastRSI = rsi[rsi.length - 1];

        // MACD
        const macd = MACD.calculate({
            values: closes15m,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });
        const lastMACD = macd[macd.length - 1];

        // EMA
        const ema9 = EMA.calculate({ period: 9, values: closes15m });
        const ema21 = EMA.calculate({ period: 21, values: closes15m });
        const lastEMA9 = ema9[ema9.length - 1];
        const lastEMA21 = ema21[ema9.length - 1];

        let direction = 'HOLD';
        let confidence = 50;
        let signalCount = 0;

        // RSI sinyali
        if (lastRSI < 30) { signalCount += 1; } // Oversold - LONG
        if (lastRSI > 70) { signalCount += 1; } // Overbought - SHORT

        // MACD sinyali
        if (lastMACD && lastMACD.MACD > lastMACD.signal) { signalCount += 1; } // LONG
        if (lastMACD && lastMACD.MACD < lastMACD.signal) { signalCount += 1; } // SHORT

        // EMA sinyali
        if (lastEMA9 > lastEMA21) { signalCount += 1; } // LONG
        if (lastEMA9 < lastEMA21) { signalCount += 1; } // SHORT

        // Karar mekanizması
        if (signalCount >= 2) {
            const longSignals = [lastRSI < 30, lastMACD?.MACD > lastMACD?.signal, lastEMA9 > lastEMA21].filter(Boolean).length;
            const shortSignals = [lastRSI > 70, lastMACD?.MACD < lastMACD?.signal, lastEMA9 < lastEMA21].filter(Boolean).length;

            if (longSignals > shortSignals) {
                direction = 'LONG_BREAKOUT';
                confidence = 60 + (longSignals * 10);
            } else if (shortSignals > longSignals) {
                direction = 'SHORT_BREAKOUT';
                confidence = 60 + (shortSignals * 10);
            }
        }

        if (direction === 'HOLD' || confidence < CONFIG.minConfidenceForAuto) return null;

        return {
            direction,
            confidence: Math.min(95, confidence),
            reasoning: `🔄 RSI+MACD+EMA | ${direction} | Sinyaller: ${signalCount}/3 | RSI: ${lastRSI.toFixed(1)}`,
            strategy: 'rsimacd'
        };
    }

    // ANA ANALİZ FONKSİYONU
    async analyze(symbol) {
        console.log(`\n🔍 [ALPHASON] ${symbol} analiz - Strateji: ${CONFIG.activeStrategy}`);

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

            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
            const ohlcv15m = multiTFData['15m'];
            const ohlcv1h = multiTFData['1h'];
            
            if (!ohlcv15m || ohlcv15m.length < 60) {
                console.log(`   📊 ${symbol}: Yetersiz OHLCV verisi - Atlandı`);
                return null;
            }

            const snr = EnhancedHelpers.findSimpleSnR(ohlcv15m);
            const currentPrice = ticker.last;
            const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);

            let strategyResult = null;

            // SEÇİLEN STRATEJİYE GÖRE ANALİZ
            switch(CONFIG.activeStrategy) {
                case 'breakout':
                    strategyResult = await this.analyzeBreakout(symbol, multiTFData, currentPrice, snr, marketStructure);
                    break;
                case 'pumpdetect':
                    strategyResult = await this.analyzePumpDetect(symbol, multiTFData, currentPrice);
                    break;
                case 'rsimacd':
                    strategyResult = await this.analyzeRSIMACD(symbol, multiTFData, currentPrice);
                    break;
                default:
                    strategyResult = await this.analyzeBreakout(symbol, multiTFData, currentPrice, snr, marketStructure);
            }

            if (!strategyResult) return null;

            // Sinyal kalitesi hesaplama
            const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(
                symbol, 
                strategyResult.direction === 'LONG_BREAKOUT' ? snr.resistance : snr.support, 
                strategyResult.direction
            );

            let signalQuality = strategyResult.confidence;
            if (volumeInfo.confirmed) signalQuality += 10;
            if (volumeInfo.strength === 'STRONG') signalQuality += 15;
            if (marketStructure === (strategyResult.direction === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH')) signalQuality += 10;

            signalQuality = Math.min(100, signalQuality);

            console.log(`   ✅ ${symbol}: ${strategyResult.direction} | Güven: ${strategyResult.confidence}% | Kalite: ${signalQuality}%`);

            // Pozisyon boyutu hesaplama
            let positionSize = 'NORMAL';
            if (signalQuality > 80) positionSize = 'LARGE';
            else if (signalQuality < 50) positionSize = 'SMALL';

            // SL/TP hesaplama
            const closes15m = ohlcv15m.map(c => c[4]);
            const highs15m = ohlcv15m.map(c => c[2]);
            const lows15m = ohlcv15m.map(c => c[3]);
            const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
            const lastATR = atr[atr.length - 1];

            let entryPrice, sl_final, tp1_final;
            const slDist = lastATR * CONFIG.atrSLMultiplier;
            const tpDist = lastATR * CONFIG.atrTPMultiplier;

            if (strategyResult.direction === 'LONG_BREAKOUT') {
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

            signalHistory.set(symbol, Date.now());
            systemStatus.performance.totalSignals++;

            return {
                id: `${symbol}_${strategyResult.direction}_${Date.now()}`,
                coin: EnhancedHelpers.cleanSymbol(symbol),
                ccxt_symbol: symbol,
                taraf: strategyResult.direction,
                
                giris: EnhancedHelpers.roundToTick(entryPrice),
                tp1: EnhancedHelpers.roundToTick(tp1_final),
                sl: EnhancedHelpers.roundToTick(sl_final),
                riskReward: rr.toFixed(2),
                confidence: strategyResult.confidence,
                positionSize: positionSize,
                
                riskLevel: signalQuality > 80 ? "LOW" : signalQuality > 60 ? "MEDIUM" : "HIGH",
                tuyo: strategyResult.reasoning,
                timestamp: Date.now(),
                signalQuality: signalQuality,
                marketStructure: marketStructure,
                volumeConfirmed: volumeInfo.confirmed,
                strategy: strategyResult.strategy,
                orderType: CONFIG.orderType
            };

        } catch (e) { 
            console.error(`\n❌ ${symbol} analiz hatası:`, e.message);
            return null; 
        }
    }
}

const alphaSonEngine = new AlphaSonStrategyEngine();

/* ====================== TRADE SİSTEMİ ====================== */
class AlphaSonTradeSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) {
            console.log(`\n❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Min güven: ${CONFIG.minConfidenceForAuto} isteniyor.`);
            return; 
        }
        
        try {
            console.log(`\n🚀 ALPHASON İŞLEM: ${signal.coin} ${signal.taraf} | ${signal.strategy} | Güven: %${signal.confidence} | Kalite: ${signal.signalQuality}`);
            
            const symbol = signal.ccxt_symbol;
            const currentPrice = await this.getCurrentPrice(symbol);
            
            let entryPrice = signal.giris;
            let orderType = CONFIG.orderType;
            
            if (orderType === 'limit') {
                console.log(`🎯 LİMİT EMİR: ${signal.taraf} - Giriş: ${entryPrice}`);
            } else {
                entryPrice = currentPrice;
                console.log(`⚡ MARKET EMİR: Giriş ~${entryPrice}`);
            }

            await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
            
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            const available = parseFloat(balance.USDT?.free || 0);
            if (available < 10) {
                console.log('❌ Yetersiz bakiye');
                return;
            }
            
            const cost = available * (CONFIG.marginPercent / 100);
            const amountUSDT = cost * CONFIG.leverage;
            let amountCoin = amountUSDT / entryPrice;
            
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
            
            console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize} | Risk: ${signal.riskLevel}`);
            
            const order = await this.placeOrder(symbol, side, finalAmount, entryPrice, orderType);
            
            if (order) {
                console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
                
                try {
                    await this.placeTPSLOrders(symbol, side, finalAmount, signal);
                } catch (tpslError) {
                    console.log('⚠️ TP/SL emirleri gönderilemedi:', tpslError.message);
                }
                
                systemStatus.performance.executedTrades++;
                this.updateCorrelationCache(signal.coin);
            } else {
                console.log('❌ EMİR BAŞARISIZ - Order null döndü');
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

    async placeTPSLOrders(symbol, side, amount, signal) {
        try {
            const stopSide = side === 'buy' ? 'sell' : 'buy';
            
            console.log(`🎯 TP/SL AYARLANIYOR: ${symbol} | TP: ${signal.tp1} | SL: ${signal.sl}`);
            
            const slOrder = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', stopSide, amount, undefined, {
                    stopLoss: {
                        triggerPrice: signal.sl,
                        price: signal.sl
                    }
                })
            );
            console.log(`✅ SL EMİR GÖNDERİLDİ: ${signal.sl}`);
            
            const tpOrder = await requestQueue.push(() =>
                exchangeAdapter.raw.createOrder(symbol, 'market', stopSide, amount, undefined, {
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

    async closePosition(symbol, side, contracts) {
        try {
            console.log(`\n🔻 POZİSYON KAPATMA: ${symbol} | ${side} | ${contracts}`);
            
            const closeAmount = Math.abs(contracts);
            const closeSide = side === 'LONG' ? 'sell' : 'buy';
            
            console.log(`💰 KAPATMA: ${closeSide} ${closeAmount} ${symbol}`);
            
            const params = {
                reduceOnly: true
            };
            
            const order = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, 'market', closeSide, closeAmount, undefined, params)
            );
            
            if (order) {
                console.log(`✅ POZİSYON KAPATILDI: ${symbol} - Order ID: ${order.id}`);
                return { success: true, orderId: order.id };
            } else {
                console.log(`❌ POZİSYON KAPATILAMADI: ${symbol}`);
                return { success: false, error: 'Order oluşturulamadı' };
            }
        } catch (error) {
            console.log(`❌ POZİSYON KAPATMA HATASI: ${error.message}`);
            throw error;
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

    async getPositions() {
        if(!CONFIG.isApiConfigured) return [];
        try {
            const p = await requestQueue.push(() => exchangeAdapter.raw.fetchPositions());
            return p.filter(x => parseFloat(x.contracts) > 0);
        } catch { return []; }
    }
}

const alphaSonTradeSystem = new AlphaSonTradeSystem();

/* ====================== SCANNER ====================== */
class VolumeFilterScanner {
    async refreshMarketList() {
        try {
            console.log('🌍 ALPHASON - LİSTE YENİLENİYOR...');
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
            
            console.log(`✅ ALPHASON LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${CONFIG.minVolumeUSD/1000000}M$).`);
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
        console.log(`\n⏰ ALPHASON TARAMA | UTC: ${currentHour} | Strateji: ${CONFIG.activeStrategy} | Emir: ${CONFIG.orderType.toUpperCase()}`);

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
        console.log(`\n⚡ Alphason Tarama: ${batch.length} coin analiz ediliyor...`);
        
        const validSignals = [];
        for (const sym of batch) {
            const signal = await alphaSonEngine.analyze(sym);
            if (signal) {
                validSignals.push(signal);
                console.log(`\n🎯 ALPHASON SİNYAL: ${sym} - ${signal.taraf} | ${signal.strategy} (Güven: ${signal.confidence}%, Kalite: ${signal.signalQuality})`);
            }
        }
        
        if (validSignals.length > 0) {
            const shortSignals = validSignals.filter(s => s.taraf.includes('SHORT'));
            const longSignals = validSignals.filter(s => s.taraf.includes('LONG'));
            
            console.log(`\n🎯 ${validSignals.length} ALPHASON SİNYAL BULUNDU!`);
            console.log(`   SHORT: ${shortSignals.length} | LONG: ${longSignals.length}`);
            console.log(`   Stratejiler: ${[...new Set(validSignals.map(s => s.strategy))].join(', ')}`);
            console.log(`   Toplam: ${systemStatus.performance.totalSignals}`);
            
            validSignals.forEach(signal => {
                broadcastSignal(signal);
                if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
                    alphaSonTradeSystem.execute(signal);
                }
            });
        } else {
            console.log(`\n⚡ Alphason tarama tamamlandı. Sinyal bulunamadı.`);
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

/* ====================== API ROUTES ====================== */
app.get('/api/status', async (req, res) => {
    const positions = await alphaSonTradeSystem.getPositions();
    const recentSignals = Array.from(signalCache.values())
        .sort((a, b) => b.timestamp - a.timestamp);
        
    res.json({ 
        config: CONFIG, 
        system: systemStatus, 
        positions: positions,
        signals: recentSignals
    });
});

app.post('/api/config/update', (req, res) => { 
    if (req.body.minConfidenceForAuto !== undefined) {
        CONFIG.minConfidenceForAuto = parseInt(req.body.minConfidenceForAuto);
        console.log(`🎯 Güven filtresi güncellendi: ${CONFIG.minConfidenceForAuto}`);
    }
    if (req.body.orderType !== undefined) {
        CONFIG.orderType = req.body.orderType;
        console.log(`🎯 Emir tipi güncellendi: ${CONFIG.orderType.toUpperCase()}`);
    }
    if (req.body.activeStrategy !== undefined) {
        CONFIG.activeStrategy = req.body.activeStrategy;
        console.log(`🎯 Strateji güncellendi: ${CONFIG.activeStrategy}`);
    }
    Object.assign(CONFIG, req.body); 
    res.json({ success: true }); 
});

app.post('/api/trade/manual', async (req, res) => { 
    await alphaSonTradeSystem.execute(req.body, true); 
    res.json({ success: true }); 
});

app.post('/api/position/close', async (req, res) => { 
    try {
        const { symbol, side, contracts } = req.body;
        const result = await alphaSonTradeSystem.closePosition(symbol, side, contracts);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    exchangeAdapter = { raw: new ccxt.bitget({
        apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
        options: { defaultType: 'swap' },
        timeout: 30000,
        enableRateLimit: true
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
    
    console.log('\n⚙️  ALPHASON CRYPTO KONFİGURASYONU:');
    console.log(`   🎯 Aktif Strateji: ${CONFIG.activeStrategy}`);
    console.log(`   🎯 Min Güven: ${CONFIG.minConfidenceForAuto}%`);
    console.log(`   📊 Min Hacim: ${CONFIG.minVolumeUSD} USD`);
    console.log(`   📈 Emir Tipi: ${CONFIG.orderType.toUpperCase()}`);
    console.log(`   🤖 Oto Trade: ${CONFIG.autotradeMaster ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🎯 3 Strateji: KIRILIM, PUMP/DETECT, RSI+MACD`);
    
    await scanner.refreshMarketList(); 
    setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, () => { 
    console.log(`🚀 ALPHASON CRYPTO UI: http://localhost:${PORT}`); 
    start(); 
});
