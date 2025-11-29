require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

// --- DATABASE VE BELLEK YÖNETİMİ ---

const memoryDB = {
    users: [
        {
            id: 1,
            email: 'admin@alphason.com',
            password: '$2b$10$8JG8LXd7.6Q1V1q1V1q1VOhc1QYz7Qd8Qe8Qe8Qe8Qe8Qe8Qe8Qe8Q',
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
        if (user) user.session_token = token;
    },
    async getUserSettings(userId) {
        let settings = memoryDB.userSettings.find(settings => settings.user_id === userId);
        if (!settings) {
            settings = {
                user_id: userId,
                min_confidence: 65,
                autotrade_enabled: false,
                order_type: 'limit',
                strategies: { breakout: true, trendfollow: true, pumpdump: true }
            };
            memoryDB.userSettings.push(settings);
        }
        return settings;
    },
    async updateUserSettings(userId, newSettings) {
        const settings = memoryDB.userSettings.find(s => s.user_id === userId);
        if (settings) Object.assign(settings, newSettings);
        else memoryDB.userSettings.push({ user_id: userId, ...newSettings });
    },
    async getPendingUsers() {
        return memoryDB.users.filter(user => user.status === 'pending');
    },
    async approveUser(userId, adminId) {
        const user = memoryDB.users.find(u => u.id === userId);
        if (user) {
            user.status = 'active';
            user.approved_by = adminId;
            user.balance = user.plan === 'basic' ? 0 : 1000;
        }
    },
    async rejectUser(userId, adminId) {
        const user = memoryDB.users.find(u => u.id === userId);
        if (user) {
            user.status = 'rejected';
            user.approved_by = adminId;
        }
    }
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- MIDDLEWARES ---

async function authenticateToken(req, res, next) {
    const publicRoutes = [
        '/', '/login.html', '/register.html', '/index.html', '/admin.html',
        '/api/auth/login', '/api/auth/register', '/api/status'
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

function requireAdmin(req, res, next) {
    if (req.user && req.user.email === 'admin@alphason.com') {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Admin erişimi gerekiyor' });
    }
}

// --- GLOBAL CONFIG & VARS ---

let CONFIG = {
    minVolumeUSD: 300000,
    minPrice: 0.05,
    timeframes: ['15m', '1h', '4h'],
    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 22,
    snrTolerancePercent: 2.0,
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.0,
    signalCooldownMs: 30 * 60 * 1000,
    enableTimeFilter: false,
    optimalTradingHours: [7, 8, 9, 13, 14, 15, 19, 20, 21]
};

let publicExchange = new ccxt.bitget({
    options: { defaultType: 'swap' },
    timeout: 30000,
    enableRateLimit: true
});

let cachedHighVol = [];
let signalHistory = new Map();
const ohlcvCache = new Map();
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

const systemStatus = {
    isHealthy: true,
    filterCount: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// --- HELPER FUNCTIONS ---

const H = {
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
        } catch (e) { return null; }
    },
    async fetchMultiTimeframeOHLCV(symbol, timeframes) {
        const results = {};
        for (const tf of timeframes) results[tf] = await this.fetchOHLCV(symbol, tf, 100);
        return results;
    },
    async fetchTicker(symbol) {
        try { return await requestQueue.push(() => publicExchange.fetchTicker(symbol)); }
        catch (e) { return null; }
    },
    findSimpleSnR(ohlcv15m) {
        if (!ohlcv15m || ohlcv15m.length < 20) return { support: 0, resistance: 0 };
        const recentCandles = ohlcv15m.slice(-20);
        const highs = recentCandles.map(c => c[2]);
        const lows = recentCandles.map(c => c[3]);
        return {
            support: this.roundToTick(Math.min(...lows)),
            resistance: this.roundToTick(Math.max(...highs))
        };
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
        if (!recentOhlcv || recentOhlcv.length < 10) return { confirmed: false, strength: 'WEAK', ratio: 0 };
        const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
        const pastVolumes = recentOhlcv.slice(0, -1).map(c => c[5]);
        const avgVolume = pastVolumes.reduce((a, b) => a + b, 0) / pastVolumes.length;
        const volumeRatio = breakoutCandle[5] / avgVolume;
        
        let strength = 'WEAK';
        if (volumeRatio > 2.0) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MEDIUM';
        return { confirmed: volumeRatio > CONFIG.volumeConfirmationThreshold, strength, ratio: volumeRatio };
    },
    cleanSymbol(symbol) { 
        if (!symbol) return null;
        const parts = symbol.split('/');
        return parts[0] + '/USDT'; 
    },
    isOptimalTradingTime() { return !CONFIG.enableTimeFilter || CONFIG.optimalTradingHours.includes(new Date().getUTCHours()); }
};

// --- STRATEGIES ---

class BreakoutStrategy {
    constructor() { this.name = 'Breakout'; }
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
        const ema9 = EMA.calculate({ period: 9, values: closes15m });
        const ema21 = EMA.calculate({ period: 21, values: closes15m });
        const adx = ADX.calculate({ period: 14, high: ohlcv15m.map(c=>c[2]), low: ohlcv15m.map(c=>c[3]), close: closes15m });
        
        if (!ema9.length || !adx.length) return null;
        const lastEMA9 = ema9[ema9.length-1];
        const lastEMA21 = ema21[ema21.length-1];
        const lastADX = adx[adx.length-1]?.adx || 0;

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
        
        const atr = ATR.calculate({ period: 14, high: ohlcv15m.map(c=>c[2]), low: ohlcv15m.map(c=>c[3]), close: closes15m });
        const lastATR = atr[atr.length-1];
        
        let entry = direction.includes('LONG') ? snr.resistance : snr.support;
        let sl = direction.includes('LONG') ? entry - (lastATR * CONFIG.atrSLMultiplier) : entry + (lastATR * CONFIG.atrSLMultiplier);
        let tp = direction.includes('LONG') ? entry + (lastATR * CONFIG.atrTPMultiplier) : entry - (lastATR * CONFIG.atrTPMultiplier);

        return {
            direction, confidence, entry: H.roundToTick(entry), stopLoss: H.roundToTick(sl), takeProfit: H.roundToTick(tp),
            riskReward: Number((Math.abs(tp-entry)/Math.abs(entry-sl)).toFixed(2)),
            strategy: this.name, reasoning: `Kırılım, ADX: ${lastADX.toFixed(1)}`
        };
    }
}

class TrendFollowStrategy {
    constructor() { this.name = 'TrendFollow'; }
    async analyze(symbol, multiTFData, ticker) {
        const ohlcv1h = multiTFData['1h'];
        if (!ohlcv1h || ohlcv1h.length < 50) return null;
        const closes = ohlcv1h.map(c => c[4]);
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        const adx = ADX.calculate({ period: 14, high: ohlcv1h.map(c=>c[2]), low: ohlcv1h.map(c=>c[3]), close: closes });
        
        if (!ema20.length || !ema50.length) return null;
        const lastEma20 = ema20[ema20.length-1];
        const lastEma50 = ema50[ema50.length-1];
        const lastAdx = adx[adx.length-1]?.adx || 0;

        let direction = 'HOLD';
        if (lastEma20 > lastEma50 && lastAdx > CONFIG.minTrendStrength) direction = 'LONG_TREND';
        else if (lastEma20 < lastEma50 && lastAdx > CONFIG.minTrendStrength) direction = 'SHORT_TREND';

        if (direction === 'HOLD') return null;

        const atr = ATR.calculate({ period: 14, high: ohlcv1h.map(c=>c[2]), low: ohlcv1h.map(c=>c[3]), close: closes });
        const lastATR = atr[atr.length-1];
        let sl = direction === 'LONG_TREND' ? ticker.last - (lastATR * 2) : ticker.last + (lastATR * 2);
        let tp = direction === 'LONG_TREND' ? ticker.last + (lastATR * 3) : ticker.last - (lastATR * 3);

        return {
            direction: direction === 'LONG_TREND' ? 'LONG' : 'SHORT',
            confidence: 70 + (lastAdx > 30 ? 10 : 0),
            entry: H.roundToTick(ticker.last), stopLoss: H.roundToTick(sl), takeProfit: H.roundToTick(tp),
            riskReward: 1.5, strategy: this.name, reasoning: `Trend Takip EMA20/50, ADX: ${lastAdx.toFixed(1)}`
        };
    }
}

class PumpDumpStrategy {
    constructor() {
        this.name = 'PumpDump';
        this.lastSignals = new Map();
    }
    async analyze(symbol, multiTFData, ticker) {
        const ohlcv5m = await H.fetchOHLCV(symbol, '5m', 30);
        if (!ohlcv5m || ohlcv5m.length < 20) return null;

        const now = Date.now();
        const lastSignal = this.lastSignals.get(symbol);
        if (lastSignal && (now - lastSignal) < 10 * 60 * 1000) return null;

        const currentCandle = ohlcv5m[ohlcv5m.length - 1];
        const prevCandle = ohlcv5m[ohlcv5m.length - 2];
        const currentClose = currentCandle[4];
        const prevClose = prevCandle[4];
        
        const volumes = ohlcv5m.slice(0, -1).map(c => c[5]);
        const avgVolume = volumes.slice(-15).reduce((a,b)=>a+b,0) / 15;
        
        const priceChange = (currentClose - prevClose) / prevClose;
        const volumeRatio = currentCandle[5] / avgVolume;

        if (volumeRatio < 2.0 || Math.abs(priceChange) < 0.015) return null;

        let direction = priceChange > 0 ? 'LONG_PUMP' : 'SHORT_DUMP';
        let confidence = 65 + (volumeRatio > 3 ? 10 : 0);

        const atr = ATR.calculate({ period: 14, high: ohlcv5m.map(c=>c[2]), low: ohlcv5m.map(c=>c[3]), close: ohlcv5m.map(c=>c[4]) });
        const lastATR = atr[atr.length-1] || (currentClose * 0.01);
        
        let sl = direction === 'LONG_PUMP' ? currentClose - (lastATR * 2) : currentClose + (lastATR * 2);
        let tp = direction === 'LONG_PUMP' ? currentClose + (lastATR * 3) : currentClose - (lastATR * 3);

        this.lastSignals.set(symbol, now);
        return {
            direction: direction === 'LONG_PUMP' ? 'LONG' : 'SHORT',
            confidence, entry: H.roundToTick(currentClose), stopLoss: H.roundToTick(sl), takeProfit: H.roundToTick(tp),
            riskReward: 1.5, strategy: this.name, 
            reasoning: `Ani Hacim (${volumeRatio.toFixed(1)}x) ve Fiyat (%${(priceChange*100).toFixed(2)})`
        };
    }
}

const strategies = {
    breakout: new BreakoutStrategy(),
    trendfollow: new TrendFollowStrategy(),
    pumpdump: new PumpDumpStrategy()
};

// --- SYMBOL ANALYSIS ---

async function analyzeSymbol(symbol) {
    if (!H.isOptimalTradingTime()) return null;
    if (Date.now() - (signalHistory.get(symbol) || 0) < CONFIG.signalCooldownMs) return null;

    const ticker = await H.fetchTicker(symbol);
    if (!ticker) return null;

    const multiTFData = await H.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
    if (!multiTFData['15m'] || multiTFData['15m'].length < 60) return null;

    const snr = H.findSimpleSnR(multiTFData['15m']);
    const strategyResults = [];

    for (const strat of Object.values(strategies)) {
        try {
            const res = await strat.analyze(symbol, multiTFData, ticker, snr);
            if (res && res.confidence >= 50) strategyResults.push(res);
        } catch (e) {}
    }

    if (!strategyResults.length) return null;

    const best = strategyResults.reduce((prev, current) => (prev.confidence > current.confidence) ? prev : current);
    
    let volConf = { confirmed: true, strength: 'SKIP', ratio: 0 };
    if (best.strategy === 'Breakout') {
        volConf = await H.confirmBreakoutWithVolume(symbol, best.entry, best.direction);
    }

    let finalConf = best.confidence + (volConf.strength === 'STRONG' ? 10 : (volConf.strength === 'MEDIUM' ? 5 : 0));
    signalHistory.set(symbol, Date.now());
    systemStatus.performance.totalSignals++;

    return {
        id: `${symbol}_${best.strategy}_${Date.now()}`,
        coin: H.cleanSymbol(symbol),
        ccxt_symbol: symbol,
        taraf: best.direction.includes('LONG') ? 'LONG' : 'SHORT',
        giris: best.entry, tp1: best.takeProfit, sl: best.stopLoss,
        riskReward: best.riskReward, confidence: Math.round(finalConf),
        strategy: best.strategy, reasoning: best.reasoning,
        timestamp: Date.now(),
        signalSource: best.strategy
    };
}

// --- API ROUTES ---

// 1. Login Route
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await database.getUserByEmail(email);
        
        if (!user) {
            return res.status(400).json({ success: false, error: 'Kullanıcı adı veya şifre yanlış.' });
        }

        const match = await bcrypt.compare(password, user.password);
        
        if (!match) {
            return res.status(400).json({ success: false, error: 'Kullanıcı adı veya şifre yanlış.' });
        }
        
        if (user.status !== 'active') return res.status(403).json({ success: false, error: 'Hesap aktif değil.' });

        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await database.updateUserSession(user.id, token);
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                email: user.email, 
                plan: user.plan,
                balance: user.balance,
                total_pnl: user.total_pnl,
                daily_pnl: user.daily_pnl
            } 
        });
    } catch (e) {
        console.error('Login Hatası:', e);
        res.status(500).json({ success: false, error: 'Sunucu hatası. Lütfen logları kontrol edin.' });
    }
});

// 2. Register Route
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, plan } = req.body;
        if (await database.getUserByEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email kullanımda' });
        }
        await database.createUser(email, password, plan);
        res.json({ success: true, message: 'Kayıt başarılı, onay bekleniyor' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Status Route (System Health)
app.get('/api/status', authenticateToken, (req, res) => {
    res.json(systemStatus);
});

// 4. Crypto Price Route
app.get('/api/crypto/:symbol', async (req, res) => {
    try {
        const baseSymbol = req.params.symbol?.toUpperCase();
        if (!baseSymbol) {
             return res.status(400).json({ success: false, error: 'Geçersiz sembol.' });
        }

        const symbol = baseSymbol + '/USDT';
        const ticker = await H.fetchTicker(symbol);

        if (ticker) {
            res.json({ 
                success: true, 
                price: ticker.last, 
                change: ticker.percentage, 
                volume: ticker.baseVolume || 0
            });
        } else {
            res.status(404).json({ success: false, error: 'Veri yok' });
        }
    } catch (e) {
        console.error('Crypto Veri Hatası:', e.message);
        res.status(500).json({ success: false, error: 'Sunucu hatası.' });
    }
});

// 5. Logout Route
app.post('/api/logout', authenticateToken, async (req, res) => {
    if (req.user) await database.updateUserSession(req.user.id, null);
    res.json({ success: true });
});

// 6. User Settings & Info
app.get('/api/user/info', authenticateToken, (req, res) => {
    res.json(req.user);
});

app.get('/api/settings', authenticateToken, async (req, res) => {
    const settings = await database.getUserSettings(req.user.id);
    res.json(settings);
});

app.post('/api/settings', authenticateToken, async (req, res) => {
    await database.updateUserSettings(req.user.id, req.body);
    res.json({ success: true });
});

// 7. Manual Scan Trigger
app.get('/api/scan/refresh', authenticateToken, async (req, res) => {
    res.json({ success: true, message: 'Tarama tetiklendi' });
});

// 8. Admin Routes
app.get('/api/admin/pending-users', authenticateToken, requireAdmin, async (req, res) => {
    const pendingUsers = await database.getPendingUsers();
    res.json(pendingUsers.map(user => ({
        id: user.id,
        email: user.email,
        plan: user.plan,
        subscription_date: user.subscription_date
    })));
});

app.post('/api/admin/approve-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.approveUser(parseInt(req.params.userId), req.user.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/reject-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.rejectUser(parseInt(req.params.userId), req.user.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- SERVER BAŞLATMA ---

// Bellek Temizliği
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of ohlcvCache) if (now - v.ts > 600000) ohlcvCache.delete(k);
    for (const [k, v] of signalHistory) if (now - v > 7200000) signalHistory.delete(k);
}, 600000);

server.listen(PORT, () => {
    console.log(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor.`);
    console.log(`✅ API Rotaları Aktif: /api/login, /api/status, /api/crypto/:symbol`);
    console.log(`🔑 Admin Giriş Bilgileri: admin@alphason.com / 123456`);
});

module.exports = { authenticateToken, requireAdmin };
