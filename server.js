require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

// Memory Database - Render için
const memoryDB = {
    users: [
        {
            id: 1,
            email: 'admin@alphason.com',
            password: '$2b$10$8JG8LXd7.6Q1V1q1V1q1VO',
            plan: 'elite',
            status: 'active',
            balance: 10000.00,
            total_pnl: 156.78,
            daily_pnl: 23.45,
            api_key: '',
            api_secret: '',
            api_passphrase: '',
            leverage: 10,
            margin_percent: 5.0,
            risk_level: 'medium',
            daily_trade_limit: 50,
            max_positions: 10,
            session_token: null,
            subscription_date: new Date(),
            approved_by: 'system'
        }
    ],
    userSettings: [
        {
            user_id: 1,
            min_confidence: 65,
            autotrade_enabled: false,
            order_type: 'limit',
            strategies: { breakout: true, trendfollow: true, pumpdump: true }
        }
    ],
    trades: [],
    subscriptionRequests: []
};

// Database helper fonksiyonları
const database = {
    async getUserByEmail(email) {
        return memoryDB.users.find(user => user.email === email);
    },

    async getUserByToken(token) {
        return memoryDB.users.find(user => user.session_token === token);
    },

    async createUser(email, password, plan) {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: memoryDB.users.length + 1,
            email,
            password: hashedPassword,
            plan,
            status: 'pending',
            balance: 0,
            total_pnl: 0,
            daily_pnl: 0,
            api_key: '',
            api_secret: '',
            api_passphrase: '',
            leverage: 10,
            margin_percent: 5.0,
            risk_level: 'medium',
            daily_trade_limit: 50,
            max_positions: 10,
            session_token: null,
            subscription_date: new Date(),
            approved_by: null
        };
        memoryDB.users.push(newUser);
        
        // Abonelik talebi oluştur
        memoryDB.subscriptionRequests.push({
            user_id: newUser.id,
            requested_plan: plan,
            status: 'pending',
            created_at: new Date(),
            approved_at: null
        });
        
        return newUser.id;
    },

    async updateUserSession(userId, token) {
        const user = memoryDB.users.find(u => u.id === userId);
        if (user) {
            user.session_token = token;
        }
    },

    async getUserSettings(userId) {
        return memoryDB.userSettings.find(settings => settings.user_id === userId);
    },

    async updateUserSettings(userId, newSettings) {
        const settings = memoryDB.userSettings.find(s => s.user_id === userId);
        if (settings) {
            Object.assign(settings, newSettings);
        } else {
            memoryDB.userSettings.push({
                user_id: userId,
                ...newSettings
            });
        }
    },

    async getPendingUsers() {
        const pendingUsers = memoryDB.users.filter(user => user.status === 'pending');
        return pendingUsers.map(user => {
            const request = memoryDB.subscriptionRequests.find(req => req.user_id === user.id);
            return {
                id: user.id,
                email: user.email,
                plan: user.plan,
                subscription_date: user.subscription_date,
                request_date: request ? request.created_at : user.subscription_date
            };
        });
    },

    async getAllUsers() {
        return memoryDB.users.map(user => {
            const request = memoryDB.subscriptionRequests.find(req => req.user_id === user.id);
            return {
                id: user.id,
                email: user.email,
                plan: user.plan,
                status: user.status,
                balance: user.balance,
                total_pnl: user.total_pnl,
                daily_pnl: user.daily_pnl,
                subscription_date: user.subscription_date,
                approved_by: user.approved_by,
                request_date: request ? request.created_at : user.subscription_date
            };
        });
    },

    async approveUser(userId, adminId) {
        const user = memoryDB.users.find(u => u.id === userId);
        if (user) {
            user.status = 'active';
            user.approved_by = adminId;
            user.balance = user.plan === 'basic' ? 0 : 1000; // Basic'te bakiye yok
            
            const request = memoryDB.subscriptionRequests.find(req => req.user_id === userId);
            if (request) {
                request.status = 'approved';
                request.approved_at = new Date();
            }
        }
    },

    async rejectUser(userId, adminId) {
        const user = memoryDB.users.find(u => u.id === userId);
        if (user) {
            user.status = 'rejected';
            user.approved_by = adminId;
            
            const request = memoryDB.subscriptionRequests.find(req => req.user_id === userId);
            if (request) {
                request.status = 'rejected';
                request.approved_at = new Date();
            }
        }
    },

    async deleteUser(userId) {
        const userIndex = memoryDB.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
            memoryDB.users.splice(userIndex, 1);
        }
        
        const requestIndex = memoryDB.subscriptionRequests.findIndex(req => req.user_id === userId);
        if (requestIndex !== -1) {
            memoryDB.subscriptionRequests.splice(requestIndex, 1);
        }
        
        const settingsIndex = memoryDB.userSettings.findIndex(s => s.user_id === userId);
        if (settingsIndex !== -1) {
            memoryDB.userSettings.splice(settingsIndex, 1);
        }
    }
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
async function authenticateToken(req, res, next) {
    const publicRoutes = [
        '/', '/login.html', '/register.html', '/index.html', '/admin.html',
        '/api/login', '/api/register', '/api/status', '/api/scan/refresh',
        '/api/crypto/btc', '/api/crypto/eth', '/api/analyze'
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
        const user = await database.getUserByToken(token);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
}

// Admin middleware
function requireAdmin(req, res, next) {
    if (req.user && req.user.email === 'admin@alphason.com') {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Admin erişimi gerekiyor' });
    }
}

// Sadece protected routes için auth middleware kullan
app.use('/api/user', authenticateToken);
app.use('/api/trading', authenticateToken);
app.use('/api/settings', authenticateToken);
app.use('/api/admin', authenticateToken, requireAdmin);

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
        
        // DÜZELTME: Son mumu (breakout mumunu) ortalamaya dahil etmiyoruz
        const previousVolumes = recentOhlcv.slice(0, -1).map(c => c[5]); 
        const avgVolume = previousVolumes.reduce((a, b) => a + b, 0) / previousVolumes.length;
        
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
        this.description = 'Ani Hacim ve Fiyat Hareketi Tespiti';
        this.lastSignals = new Map();
    }

    async analyze(symbol, multiTFData, ticker) {
        // 5 dakikalık veriyi al
        const ohlcv5m = await H.fetchOHLCV(symbol, '5m', 30);
        if (!ohlcv5m || ohlcv5m.length < 20) return null;

        const now = Date.now();
        const lastSignal = this.lastSignals.get(symbol);
        // Aynı coine 10 dakika içinde tekrar pump sinyali verme
        if (lastSignal && (now - lastSignal) < 10 * 60 * 1000) return null;

        const currentCandle = ohlcv5m[ohlcv5m.length - 1];
        const prevCandle = ohlcv5m[ohlcv5m.length - 2];
        
        const currentClose = currentCandle[4];
        const prevClose = prevCandle[4];
        const currentVolume = currentCandle[5];

        // Son 20 mumun (son mum hariç) ortalama hacmini al
        const volumes = ohlcv5m.slice(0, -1).map(c => c[5]);
        const avgVolume = volumes.slice(-15).reduce((a, b) => a + b, 0) / 15;

        // Fiyat değişim yüzdesi
        const priceChange = (currentClose - prevClose) / prevClose;
        const volumeRatio = currentVolume / avgVolume;

        // Eşik değerleri optimize edildi
        if (volumeRatio < 2.0 || Math.abs(priceChange) < 0.015) return null;

        let direction = 'HOLD';
        let confidence = 60;

        // Pump (Yükseliş)
        if (priceChange > 0.015 && volumeRatio > 2.5) {
            direction = 'LONG_PUMP';
            confidence += 20;
        } 
        // Dump (Düşüş)
        else if (priceChange < -0.015 && volumeRatio > 2.5) {
            direction = 'SHORT_DUMP';
            confidence += 20;
        }

        if (direction === 'HOLD') return null;

        // ATR ile Stop Loss ve Take Profit
        const atr = ATR.calculate({ 
            period: 14, 
            high: ohlcv5m.map(c => c[2]), 
            low: ohlcv5m.map(c => c[3]), 
            close: ohlcv5m.map(c => c[4]) 
        });
        const lastATR = atr[atr.length - 1] || (currentClose * 0.01);
        
        // Pump/Dump volatil olduğu için SL geniş, TP yakın
        const slDist = lastATR * 2.0;
        const tpDist = lastATR * 3.0;

        let sl, tp;
        if (direction === 'LONG_PUMP') {
            sl = currentClose - slDist;
            tp = currentClose + tpDist;
        } else {
            sl = currentClose + slDist;
            tp = currentClose - tpDist;
        }

        this.lastSignals.set(symbol, now);

        return {
            direction: direction === 'LONG_PUMP' ? 'LONG' : 'SHORT',
            confidence: Math.round(confidence),
            entry: H.roundToTick(currentClose),
            stopLoss: H.roundToTick(sl),
            takeProfit: H.roundToTick(tp),
            riskReward: Number((tpDist / slDist).toFixed(2)),
            strategy: this.name,
            reasoning: `${direction === 'LONG_PUMP' ? 'Pump' : 'Dump'} Tespit! Değişim: %${(priceChange * 100).toFixed(2)} | Hacim: ${volumeRatio.toFixed(1)}x`
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
                
                return { success: true, orderId: order.id };
            }
            
            return { success: false, error: 'Order oluşturulamadı' };
            
        } catch (e) {
            console.error(`❌ Trade Hatası (${user.email}):`, e.message);
            return { success: false, error: e.message };
        }
    }

    async getCurrentPrice(symbol, exchange) {
        try {
            const ticker = await requestQueue.push(() => exchange.fetchTicker(symbol));
            return ticker.last;
        } catch (error) {
            console.log(`❌ Fiyat alma hatası:`, error.message);
            return 0;
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
}

const autoTradeSystem = new AutoTradeSystem();

// Cache temizleme fonksiyonu
function cleanupOldCache() {
    const now = Date.now();
    const CACHE_MAX_AGE = 60 * 60 * 1000; // 1 saat
    
    // OHLCV cache temizleme
    for (const [key, value] of ohlcvCache.entries()) {
        if (now - value.ts > CACHE_MAX_AGE) {
            ohlcvCache.delete(key);
        }
    }
    
    // Signal history temizleme (2 saatten eski sinyaller)
    for (const [symbol, timestamp] of signalHistory.entries()) {
        if (now - timestamp > 2 * 60 * 60 * 1000) {
            signalHistory.delete(symbol);
        }
    }
    
    // Signal cache temizleme
    for (const [key, value] of signalCache.entries()) {
        if (now - value.timestamp > SIGNAL_CACHE_DURATION) {
            signalCache.delete(key);
        }
    }
    
    console.log(`🧹 Cache temizlendi - OHLCV: ${ohlcvCache.size}, Sinyal Tarihçe: ${signalHistory.size}`);
}

// 30 dakikada bir temizleme çalıştır
setInterval(cleanupOldCache, 30 * 60 * 1000);

// API Routes (mevcut kodunuz burada devam ediyor...)
// ... diğer API route'ları aynı kalacak

// Sunucuyu başlat
server.listen(PORT, () => {
    console.log(`🚀 AlphaSon Trade Bot ${PORT} portunda çalışıyor`);
    console.log(`📊 Stratejiler: Breakout, TrendFollow, PumpDump aktif`);
    console.log(`⏰ Cache temizleyici aktif (30 dakika)`);
});
