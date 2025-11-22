require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV, Stochastic } = require('technicalindicators');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfa - Giriş
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

let CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: false,

    activeStrategy: 'breakout',
    strategies: {
        breakout: {
            name: "KIRILIM STRATEJİSİ",
            enabled: true,
            minConfidence: 65,
            timeframes: ['1h', '4h'],
            riskReward: 3.5,
            volumeThreshold: 1.3
        },
        scalp: {
            name: "SCALP STRATEJİSİ", 
            enabled: true,
            minConfidence: 75,
            timeframes: ['5m', '15m'],
            riskReward: 1.5,
            holdTimeMinutes: 5,
            useStochastic: true
        },
        trend: {
            name: "TREND TAKİP",
            enabled: true,
            minConfidence: 70,
            timeframes: ['4h', '1d'],
            riskReward: 4.0,
            trendConfirmation: true
        }
    },

    leverage: 10,
    marginPercent: 5,
    orderType: 'limit',
    minVolumeUSD: 500000,
    autoTrade: false,
    scanBatchSize: 8,
    focusedScanIntervalMs: 3 * 60 * 1000
};

let exchangeAdapter = null;
let focusedSymbols = [];
let signalCache = new Map();
let systemStatus = { 
    balance: 0, 
    marketSentiment: "ANALİZ EDİLİYOR",
    activeStrategy: CONFIG.activeStrategy,
    performance: { totalSignals: 0, executedTrades: 0 }
};

const requestQueue = {
    queue: [], running: 0, concurrency: 6,
    push(fn) { return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject }); this.next();
    }); },
    async next() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;
        const item = this.queue.shift(); this.running++;
        try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
        finally { this.running--; this.next(); }
    }
};

class Helpers {
    static roundToTick(price) {
        if (!price || isNaN(price)) return 0;
        if (price < 0.00001) return Number(price.toFixed(8));
        if (price < 0.001) return Number(price.toFixed(7));
        if (price < 1) return Number(price.toFixed(5));
        if (price < 10) return Number(price.toFixed(4));
        return Number(price.toFixed(2));
    }

    static async fetchOHLCV(symbol, timeframe, limit = 100) {
        try {
            const data = await requestQueue.push(() => exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
            return data;
        } catch (e) { return null; }
    }

    static calculateVolumeRatio(volumes, period = 20) {
        if (!volumes || volumes.length < period) return 1;
        const currentVolume = volumes[volumes.length - 1];
        const recentVolumes = volumes.slice(-period);
        const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
        return currentVolume / avgVolume;
    }
}

class BreakoutStrategy {
    async analyze(symbol) {
        try {
            const ohlcv1h = await Helpers.fetchOHLCV(symbol, '1h', 60);
            if (!ohlcv1h) return null;

            const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
            const currentPrice = ticker.last;

            const highs = ohlcv1h.map(c => c[2]);
            const lows = ohlcv1h.map(c => c[3]);
            const resistance = Math.max(...highs.slice(-20));
            const support = Math.min(...lows.slice(-20));

            const snrTolerance = currentPrice * 0.02;
            const nearSupport = Math.abs(currentPrice - support) <= snrTolerance;
            const nearResistance = Math.abs(currentPrice - resistance) <= snrTolerance;
            if (!nearSupport && !nearResistance) return null;

            const closes = ohlcv1h.map(c => c[4]);
            const volumes = ohlcv1h.map(c => c[5]);
            const ema9 = EMA.calculate({ period: 9, values: closes });
            const ema21 = EMA.calculate({ period: 21, values: closes });
            const rsi = RSI.calculate({ period: 14, values: closes });
            const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
            
            if (!ema9.length) return null;

            const lastEMA9 = ema9[ema9.length - 1];
            const lastEMA21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastATR = atr[atr.length - 1];
            const volumeRatio = Helpers.calculateVolumeRatio(volumes, 20);

            let confidence = 50;
            if (lastEMA9 > lastEMA21) confidence += 15;
            if (volumeRatio > 1.5) confidence += 10;
            if ((lastEMA9 > lastEMA21 && nearResistance) || (lastEMA9 < lastEMA21 && nearSupport)) confidence += 15;

            if (confidence < CONFIG.strategies.breakout.minConfidence) return null;

            const direction = (lastEMA9 > lastEMA21 && nearResistance) ? 'LONG_BREAKOUT' : 'SHORT_BREAKOUT';
            const entryPrice = direction === 'LONG_BREAKOUT' ? resistance : support;
            const slDist = lastATR * 1.5;
            const tpDist = lastATR * 3.5;

            let sl, tp;
            if (direction === 'LONG_BREAKOUT') {
                sl = entryPrice - slDist;
                tp = entryPrice + tpDist;
            } else {
                sl = entryPrice + slDist;
                tp = entryPrice - tpDist;
            }

            return {
                id: `${symbol}_BREAKOUT_${Date.now()}`,
                coin: symbol.replace('/USDT', '').replace(':USDT', '') + '/USDT',
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'breakout',
                giris: Helpers.roundToTick(entryPrice),
                tp1: Helpers.roundToTick(tp),
                sl: Helpers.roundToTick(sl),
                riskReward: 3.5,
                confidence: confidence,
                positionSize: 1.0,
                riskLevel: confidence >= 80 ? "LOW" : "MEDIUM",
                tuyo: `🎯 KIRILIM | RSI:${lastRSI?.toFixed(1)} | Hacim:${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now()
            };
        } catch (e) { return null; }
    }
}

class ScalpStrategy {
    async analyze(symbol) {
        try {
            const ohlcv5m = await Helpers.fetchOHLCV(symbol, '5m', 50);
            if (!ohlcv5m) return null;

            const closes = ohlcv5m.map(c => c[4]);
            const highs = ohlcv5m.map(c => c[2]);
            const lows = ohlcv5m.map(c => c[3]);
            const volumes = ohlcv5m.map(c => c[5]);

            const ema9 = EMA.calculate({ period: 9, values: closes });
            const ema21 = EMA.calculate({ period: 21, values: closes });
            const rsi = RSI.calculate({ period: 14, values: closes });
            const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
            const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
            
            if (!ema9.length) return null;

            const lastEma9 = ema9[ema9.length - 1];
            const lastEma21 = ema21[ema21.length - 1];
            const lastRSI = rsi[rsi.length - 1];
            const lastStoch = stoch[stoch.length - 1];
            const lastATR = atr[atr.length - 1];
            const currentPrice = closes[closes.length - 1];
            const volumeRatio = Helpers.calculateVolumeRatio(volumes, 20);

            const bullishScalp = lastEma9 > lastEma21 && lastRSI > 45 && lastRSI < 75 && lastStoch.k > 20;
            const bearishScalp = lastEma9 < lastEma21 && lastRSI < 55 && lastRSI > 25 && lastStoch.k < 80;
            if (!bullishScalp && !bearishScalp) return null;

            let confidence = 60;
            if (lastRSI > 40 && lastRSI < 60) confidence += 15;
            if (lastStoch.k > 30 && lastStoch.k < 70) confidence += 10;
            if (volumeRatio > 1.5) confidence += 10;

            if (confidence < CONFIG.strategies.scalp.minConfidence) return null;

            const direction = bullishScalp ? 'LONG_SCALP' : 'SHORT_SCALP';
            const slDist = lastATR * 0.8;
            const tpDist = lastATR * 1.2;

            let sl, tp;
            if (direction === 'LONG_SCALP') {
                sl = currentPrice - slDist;
                tp = currentPrice + tpDist;
            } else {
                sl = currentPrice + slDist;
                tp = currentPrice - tpDist;
            }

            return {
                id: `${symbol}_SCALP_${Date.now()}`,
                coin: symbol.replace('/USDT', '').replace(':USDT', '') + '/USDT',
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'scalp',
                giris: Helpers.roundToTick(currentPrice),
                tp1: Helpers.roundToTick(tp),
                sl: Helpers.roundToTick(sl),
                riskReward: 1.5,
                confidence: confidence,
                positionSize: 0.8,
                riskLevel: "HIGH",
                tuyo: `⚡ SCALP | RSI:${lastRSI.toFixed(1)} | Stoch:${lastStoch.k.toFixed(1)} | Hacim:${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now()
            };
        } catch (e) { return null; }
    }
}

class TrendStrategy {
    async analyze(symbol) {
        try {
            const ohlcv4h = await Helpers.fetchOHLCV(symbol, '4h', 100);
            if (!ohlcv4h) return null;

            const closes = ohlcv4h.map(c => c[4]);
            const highs = ohlcv4h.map(c => c[2]);
            const lows = ohlcv4h.map(c => c[3]);
            const volumes = ohlcv4h.map(c => c[5]);

            const ema50 = EMA.calculate({ period: 50, values: closes });
            const ema200 = EMA.calculate({ period: 200, values: closes });
            const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
            const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
            const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
            
            if (!ema50.length) return null;

            const lastEma50 = ema50[ema50.length - 1];
            const lastEma200 = ema200[ema200.length - 1];
            const lastADX = adx[adx.length - 1]?.adx || 0;
            const lastMACD = macd[macd.length - 1];
            const lastATR = atr[atr.length - 1];
            const currentPrice = closes[closes.length - 1];
            const volumeRatio = Helpers.calculateVolumeRatio(volumes, 20);

            const bullishTrend = lastEma50 > lastEma200 && lastMACD?.MACD > lastMACD?.signal;
            const bearishTrend = lastEma50 < lastEma200 && lastMACD?.MACD < lastMACD?.signal;
            if (!bullishTrend && !bearishTrend) return null;

            let confidence = 50;
            if (lastADX > 25) confidence += 15;
            if (Math.abs(lastEma50 - lastEma200) / lastEma200 * 100 > 2) confidence += 20;
            if (volumeRatio > 1.3) confidence += 10;

            if (confidence < CONFIG.strategies.trend.minConfidence) return null;

            const direction = bullishTrend ? 'LONG_TREND' : 'SHORT_TREND';
            const slDist = lastATR * 2.0;
            const tpDist = lastATR * 4.0;

            let sl, tp;
            if (direction === 'LONG_TREND') {
                sl = currentPrice - slDist;
                tp = currentPrice + tpDist;
            } else {
                sl = currentPrice + slDist;
                tp = currentPrice - tpDist;
            }

            return {
                id: `${symbol}_TREND_${Date.now()}`,
                coin: symbol.replace('/USDT', '').replace(':USDT', '') + '/USDT',
                ccxt_symbol: symbol,
                taraf: direction,
                strategy: 'trend',
                giris: Helpers.roundToTick(currentPrice),
                tp1: Helpers.roundToTick(tp),
                sl: Helpers.roundToTick(sl),
                riskReward: 4.0,
                confidence: confidence,
                positionSize: 1.2,
                riskLevel: "MEDIUM",
                tuyo: `📈 TREND | ADX:${lastADX.toFixed(1)} | Trend:${lastEma50 > lastEma200 ? 'BULL' : 'BEAR'} | Hacim:${volumeRatio.toFixed(2)}x`,
                timestamp: Date.now()
            };
        } catch (e) { return null; }
    }
}

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
        if (!strategy || !CONFIG.strategies[strategyName].enabled) return null;
        return await strategy.analyze(symbol);
    }
}

class TradingSystem {
    async execute(signal, isManual = false) {
        if (!CONFIG.isApiConfigured && !isManual) return;
        
        try {
            console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | ${isManual ? 'MANUEL' : 'OTO'} | Güven: %${signal.confidence}`);
            
            const symbol = signal.ccxt_symbol;
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
            
            const side = signal.taraf.includes('LONG') ? 'buy' : 'sell';
            
            console.log(`💰 ${amountCoin.toFixed(6)} ${signal.coin} | ${side.toUpperCase()} | Boyut: ${signal.positionSize}x`);
            
            const order = await requestQueue.push(() => 
                exchangeAdapter.raw.createOrder(symbol, CONFIG.orderType, side, amountCoin, signal.giris)
            );
            
            if (order) {
                console.log('✅ EMİR BAŞARILI');
                systemStatus.performance.executedTrades++;
                systemStatus.balance = parseFloat(balance.USDT?.free || 0);
                
                signal.executed = true;
                signal.orderId = order.id;
                this.broadcastSignalUpdate(signal);
            }
        } catch (e) { 
            console.error('❌ Trade Hatası:', e.message);
        }
    }

    broadcastSignalUpdate(signal) {
        const msg = JSON.stringify({ type: 'signal_update', data: signal });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    }
}

class Scanner {
    constructor() {
        this.strategyManager = new StrategyManager();
        this.tradingSystem = new TradingSystem();
    }

    async scanLoop() {
        if (focusedSymbols.length === 0) {
            await this.refreshMarketList();
            return;
        }

        const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
        const validSignals = [];
        
        for (const sym of batch) {
            const signal = await this.strategyManager.analyzeWithStrategy(sym, CONFIG.activeStrategy);
            if (signal) {
                validSignals.push(signal);
                console.log(`\n🎯 ${signal.strategy.toUpperCase()} Sinyal: ${sym} - ${signal.taraf} | Güven: ${signal.confidence}%`);
            }
        }
        
        if (validSignals.length > 0) {
            validSignals.forEach(signal => {
                this.broadcastSignal(signal);
                if (CONFIG.autoTrade) {
                    this.tradingSystem.execute(signal, false);
                }
            });
        }
    }

    broadcastSignal(signal) {
        signal.tradingViewLink = `/api/signal/tradingview/${signal.ccxt_symbol}`;
        signal.strategyName = CONFIG.strategies[signal.strategy].name;
        
        signalCache.set(signal.id, signal);
        systemStatus.performance.totalSignals++;
        this.broadcastSignalList();
    }

    broadcastSignalList() {
        const allSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
        const msg = JSON.stringify({ type: 'signal_list', data: allSignals });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    }

    async refreshMarketList() {
        try {
            if (!exchangeAdapter) {
                exchangeAdapter = { raw: new ccxt.bitget({
                    apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
                    options: { defaultType: 'swap' }, timeout: 30000, enableRateLimit: true
                })};
            }
            
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
            focusedSymbols = [...highVol];
            
            console.log(`✅ ${focusedSymbols.length} coin yüklendi`);
        } catch (e) { 
            console.error('Market refresh error:', e.message); 
        }
    }
}

const scanner = new Scanner();

wss.on('connection', (ws) => {
    console.log('🔗 WebSocket bağlantısı kuruldu');
    
    // Mevcut sinyalleri gönder
    scanner.broadcastSignalList();
    
    // Sistem durumunu gönder
    const statusMsg = JSON.stringify({ type: 'system_status', data: systemStatus });
    ws.send(statusMsg);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(data);
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
});

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'switch_strategy':
            CONFIG.activeStrategy = data.strategy;
            systemStatus.activeStrategy = data.strategy;
            console.log(`🎯 Strateji değiştirildi: ${data.strategy}`);
            break;
        case 'update_config':
            Object.assign(CONFIG, data.config);
            if (data.config.apiKey) {
                CONFIG.isApiConfigured = true;
                exchangeAdapter = { raw: new ccxt.bitget({
                    apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
                    options: { defaultType: 'swap' }, timeout: 30000, enableRateLimit: true
                })};
            }
            break;
        case 'manual_trade':
            const tradingSystem = new TradingSystem();
            tradingSystem.execute(data.signal, true);
            break;
    }
}

// API Routes
app.post('/api/config/update', (req, res) => {
    Object.assign(CONFIG, req.body);
    if (req.body.apiKey) {
        CONFIG.isApiConfigured = true;
        exchangeAdapter = { raw: new ccxt.bitget({
            apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
            options: { defaultType: 'swap' }, timeout: 30000, enableRateLimit: true
        })};
    }
    res.json({ success: true });
});

app.get('/api/status', async (req, res) => {
    if (CONFIG.isApiConfigured) {
        try {
            const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
            systemStatus.balance = parseFloat(balance.USDT?.free || 0);
        } catch (e) {}
    }
    
    const recentSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
    res.json({ config: CONFIG, system: systemStatus, signals: recentSignals });
});

app.post('/api/trade/manual', async (req, res) => {
    const tradingSystem = new TradingSystem();
    await tradingSystem.execute(req.body, true);
    res.json({ success: true });
});

app.get('/api/signal/tradingview/:symbol', (req, res) => {
    const symbol = req.params.symbol.replace(':', '').replace('/', '');
    const tvUrl = `https://www.tradingview.com/chart/?symbol=BITGET:${symbol}`;
    res.redirect(tvUrl);
});

// Taramayı başlat
setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);

server.listen(PORT, () => { 
    console.log(`🚀 ALPHASON AI TRADER: http://localhost:${PORT}`); 
    setTimeout(() => scanner.refreshMarketList(), 5000);
});
