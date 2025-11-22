/**
 * server.js - SONNY TRADER PRO v2.0 - MULTI STRATEGY AI TRADING
 * 3 Strateji: KIRILIM + SCALP + TREND
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV, Stochastic, BollingerBands } = require('technicalindicators');
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');

/* ====================== BOOT ====================== */
console.log('=== SONNY TRADER PRO v2.0 - MULTI STRATEGY AI TRADING ===');
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
    // API Configuration
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

    // AI Configuration
    geminiApiKey: process.env.GEMINI_API_KEY || '',

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

    // AI Settings
    geminiFallbackMode: true,
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

/* ====================== SCALP STRATEJİSİ ====================== */
class ScalpStrategy {
    constructor() {
        this.name = "SCALP";
        this.minConfidence = 75;
        this.timeframes = ['5m', '15m'];
    }

    async analyze(symbol) {
        console.log(`\n⚡ [SCALP] ${symbol} analiz başlıyor...`);
        
        try {
            const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, this.timeframes);
            const ohlcv5m = multiTFData['5m'];
            const ohlcv15m = multiTFData['15m'];
            
            if (!ohlcv5m || ohlcv5m.length < 50) return null;

            // Scalp için hızlı göstergeler
            const closes5m = ohlcv5m.map(c => c[4]);
            const highs5m = ohlcv5m.map(c => c[2]);
            const lows5m = ohlcv5m.map(c => c[3]);
            
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
            
            const lastEma9 = ema9[ema9.length - 1];
            const lastEma21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastStoch = stoch[stoch.length - 1];
            
            // Scalp sinyal koşulları
            const bullishScalp = lastEma9 > lastEma21 && lastRSI > 45 && lastRSI < 75 && lastStoch.k > 20;
            const bearishScalp = lastEma9 < lastEma21 && lastRSI < 55 && lastRSI > 25 && lastStoch.k < 80;
            
            if (!bullishScalp && !bearishScalp) return null;
            
            const direction = bullishScalp ? 'LONG_SCALP' : 'SHORT_SCALP';
            const confidence = this.calculateScalpConfidence(lastRSI, lastStoch, lastEma9, lastEma21);
            
            if (confidence < this.minConfidence) return null;
            
            // Scalp için hızlı TP/SL
            const currentPrice = closes5m[closes5m.length - 1];
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
                positionSize: 0.8, // Scalp için daha küçük pozisyon
                
                riskLevel: "HIGH",
                tuyo: `⚡ SCALP Sinyal | RSI: ${lastRSI.toFixed(1)} | Stoch: ${lastStoch.k.toFixed(1)}`,
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
        
        // RSI optimizasyonu
        if (rsi > 30 && rsi < 70) confidence += 10;
        if (rsi > 40 && rsi < 60) confidence += 15;
        
        // Stoch optimizasyonu
        if (stoch.k > 20 && stoch.k < 80) confidence += 10;
        if (stoch.k > 30 && stoch.k < 70) confidence += 10;
        
        // EMA gücü
        const emaDistance = Math.abs(ema9 - ema21) / ema21 * 100;
        if (emaDistance > 0.5) confidence += 15;
        
        return Math.min(95, confidence);
    }
}

/* ====================== TREND TAKİP STRATEJİSİ ====================== */
class TrendStrategy {
    constructor() {
        this.name = "TREND";
        this.minConfidence = 70;
        this.timeframes = ['4h', '1d'];
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
            
            // Trend göstergeleri
            const ema50 = EMA.calculate({ period: 50, values: closes4h });
            const ema200 = EMA.calculate({ period: 200, values: closes4h });
            const adx = ADX.calculate({ period: 14, high: highs4h, low: lows4h, close: closes4h });
            const macd = MACD.calculate({
                values: closes4h,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            });
            
            const lastEma50 = ema50[ema50.length - 1];
            const lastEma200 = ema200[ema200.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastMACD = macd[macd.length - 1];
            
            // Trend yönü
            const bullishTrend = lastEma50 > lastEma200 && lastMACD?.MACD > lastMACD?.signal;
            const bearishTrend = lastEma50 < lastEma200 && lastMACD?.MACD < lastMACD?.signal;
            
            if (!bullishTrend && !bearishTrend) return null;
            
            const direction = bullishTrend ? 'LONG_TREND' : 'SHORT_TREND';
            const confidence = this.calculateTrendConfidence(lastADX, lastEma50, lastEma200, lastMACD);
            
            if (confidence < this.minConfidence) return null;
            
            const currentPrice = closes4h[closes4h.length - 1];
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
                positionSize: 1.2, // Trend için daha büyük pozisyon
                
                riskLevel: "MEDIUM",
                tuyo: `📈 TREND Sinyal | ADX: ${lastADX.toFixed(1)} | EMA50/200: ${lastEma50 > lastEma200 ? 'BULL' : 'BEAR'}`,
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
        
        // ADX trend gücü
        if (adx > 25) confidence += 15;
        if (adx > 35) confidence += 15;
        
        // EMA trend gücü
        const emaDistance = Math.abs(ema50 - ema200) / ema200 * 100;
        if (emaDistance > 2) confidence += 20;
        if (emaDistance > 5) confidence += 10;
        
        // MACD momentum
        if (macd && Math.abs(macd.MACD - macd.signal) > macd.signal * 0.1) confidence += 10;
        
        return Math.min(95, confidence);
    }
}

/* ====================== STRATEGY MANAGER ====================== */
class StrategyManager {
    constructor() {
        this.strategies = {
            breakout: enhancedTrendMaster,
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

/* ====================== USER CONFIG MANAGEMENT ====================== */
class UserConfigManager {
    constructor() {
        this.configs = new Map();
    }

    saveUserConfig(userId, config) {
        const encryptedConfig = this.encryptConfig(JSON.stringify(config));
        this.configs.set(userId, encryptedConfig);
        
        // Burada database'e kaydedilebilir
        console.log(`✅ ${userId} kullanıcı ayarları kaydedildi`);
    }

    getUserConfig(userId) {
        const encrypted = this.configs.get(userId);
        if (!encrypted) return null;
        
        return JSON.parse(this.decryptConfig(encrypted));
    }

    encryptConfig(data) {
        // Basit encryption - production'da daha güçlü encryption kullan
        return Buffer.from(data).toString('base64');
    }

    decryptConfig(encrypted) {
        return Buffer.from(encrypted, 'base64').toString('utf8');
    }
}

const userConfigManager = new UserConfigManager();

/* ====================== ENHANCED API ROUTES ====================== */
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

app.post('/api/config/user', (req, res) => {
    const { userId, apiKey, secret, password, strategySettings } = req.body;
    
    try {
        const userConfig = {
            apiKey,
            secret, 
            password,
            strategySettings,
            updatedAt: Date.now()
        };
        
        userConfigManager.saveUserConfig(userId, userConfig);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/config/user/:userId', (req, res) => {
    const config = userConfigManager.getUserConfig(req.params.userId);
    if (config) {
        res.json({ success: true, config });
    } else {
        res.json({ success: false, config: null });
    }
});

app.get('/api/signal/tradingview/:symbol', (req, res) => {
    const symbol = req.params.symbol.replace(':', '').replace('/', '');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BITGET:${symbol}`;
    res.redirect(tvUrl);
});

/* ====================== ENHANCED SCANNER ====================== */
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
                
                // Strategy performance tracking
                strategyPerformance[signal.strategy].signals++;
                
                const riskEmoji = signal.riskLevel === "HIGH" ? "🔴" : signal.riskLevel === "MEDIUM" ? "🟡" : "🟢";
                console.log(`\n🎯 ${riskEmoji} ${signal.strategy.toUpperCase()} Sinyal: ${sym} - ${signal.taraf} | Güven: ${signal.confidence}%`);
            }
        }
        
        if (validSignals.length > 0) {
            console.log(`\n🎯 TOPLAM ${validSignals.length} SİNYAL BULUNDU!`);
            
            validSignals.forEach(signal => {
                this.broadcastEnhancedSignal(signal);
                
                if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.strategies[signal.strategy].minConfidence) {
                    enhancedAutoTradeSystem.execute(signal);
                }
            });
        }
    }

    broadcastEnhancedSignal(signal) {
        // TradingView link ekle
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

/* ====================== ENHANCED STATUS ENDPOINT ====================== */
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

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
    exchangeAdapter = { raw: new ccxt.bitget({
        apiKey: CONFIG.apiKey, 
        secret: CONFIG.secret, 
        password: CONFIG.password,
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
    
    console.log('\n⚙️  SONNY TRADER PRO KONFİGURASYONU:');
    console.log(`   🎯 Aktif Strateji: ${CONFIG.activeStrategy.toUpperCase()}`);
    console.log(`   📊 Kırılım: ${CONFIG.strategies.breakout.enabled ? 'AKTİF' : 'PASİF'}`);
    console.log(`   ⚡ Scalp: ${CONFIG.strategies.scalp.enabled ? 'AKTİF' : 'PASİF'}`);
    console.log(`   📈 Trend: ${CONFIG.strategies.trend.enabled ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🤖 Gemini AI: ${CONFIG.geminiApiKey ? 'AKTİF' : 'PASİF'}`);
    console.log(`   🔑 API: ${CONFIG.isApiConfigured ? 'KONFİGURE' : 'BEKLİYOR'}`);
    
    await enhancedScanner.refreshMarketList();
    setInterval(() => enhancedScanner.scanLoop(), CONFIG.focusedScanIntervalMs);
    
    // Strategy rotation (opsiyonel)
    setInterval(() => {
        this.rotateStrategy();
    }, 60 * 60 * 1000);
}

function rotateStrategy() {
    const strategies = Object.keys(CONFIG.strategies).filter(s => CONFIG.strategies[s].enabled);
    if (strategies.length > 1) {
        const currentIndex = strategies.indexOf(CONFIG.activeStrategy);
        const nextIndex = (currentIndex + 1) % strategies.length;
        CONFIG.activeStrategy = strategies[nextIndex];
        systemStatus.activeStrategy = CONFIG.activeStrategy;
        console.log(`🔄 Strateji rotasyonu: ${CONFIG.activeStrategy.toUpperCase()}`);
    }
}

server.listen(PORT, () => { 
    console.log(`🚀 SONNY TRADER PRO: http://localhost:${PORT}`); 
    start(); 
});
