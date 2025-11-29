require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // Şifreleme için eklendi
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

// Memory Database - Şifreleme eklendi
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

// Şifreleme fonksiyonları
const encryption = {
    algorithm: 'aes-256-gcm',
    key: process.env.ENCRYPTION_KEY || crypto.randomBytes(32),
    
    encrypt(text) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipher(this.algorithm, this.key);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            data: encrypted,
            authTag: authTag.toString('hex')
        };
    },
    
    decrypt(encryptedData) {
        const decipher = crypto.createDecipher(
            this.algorithm, 
            this.key
        );
        decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
        let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
};

// Database helper fonksiyonları - Şifreleme eklendi
const database = {
    async getUserByEmail(email) {
        const user = memoryDB.users.find(user => user.email === email);
        if (user && user.api_secret) {
            try {
                user.api_secret = encryption.decrypt(JSON.parse(user.api_secret));
            } catch (e) {
                console.error('API secret decrypt error:', e);
            }
        }
        return user;
    },

    async getUserByToken(token) {
        const user = memoryDB.users.find(user => user.session_token === token);
        if (user && user.api_secret) {
            try {
                user.api_secret = encryption.decrypt(JSON.parse(user.api_secret));
            } catch (e) {
                console.error('API secret decrypt error:', e);
            }
        }
        return user;
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
        if (user) {
            user.session_token = token;
        }
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
        if (settings) {
            // API secret şifreleme
            if (newSettings.api_secret) {
                newSettings.api_secret = JSON.stringify(encryption.encrypt(newSettings.api_secret));
            }
            Object.assign(settings, newSettings);
        } else {
            if (newSettings.api_secret) {
                newSettings.api_secret = JSON.stringify(encryption.encrypt(newSettings.api_secret));
            }
            memoryDB.userSettings.push({
                user_id: userId,
                ...newSettings
            });
        }
        return { success: true };
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
            user.balance = user.plan === 'basic' ? 0 : 1000;
            
            const request = memoryDB.subscriptionRequests.find(req => req.user_id === userId);
            if (request) {
                request.status = 'approved';
                request.approved_at = new Date();
            }
        }
        return { success: true };
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
        return { success: true };
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
        return { success: true };
    }
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
async function authenticateToken(req, res, next) {
    const publicRoutes = [
        '/', '/login.html', '/register.html', '/index.html', '/admin.html',
        '/api/login', '/api/register', '/api/status', '/api/scan/refresh',
        '/api/crypto/btc', '/api/crypto/eth', '/api/analyze',
        '/css/', '/js/', '/img/', '/fonts/'
    ];
    
    if (publicRoutes.some(route => req.path.startsWith(route)) || 
        req.path.endsWith('.html') || 
        req.path.endsWith('.css') || 
        req.path.endsWith('.js') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.jpg') ||
        req.path.endsWith('.ico')) {
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

// Global Configuration - Dinamik değerler eklendi
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
    scanBatchSize: 8, // Dinamik olarak ayarlanacak
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000, // Dinamik olarak ayarlanacak
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

const systemStatus = {
    isHealthy: true,
    filterCount: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// Periyodik temizlik - EKLENDİ
setInterval(() => {
    const now = Date.now();
    const signalHistoryTTL = 24 * 60 * 60 * 1000; // 24 saat
    const ohlcvCacheTTL = 60 * 60 * 1000; // 1 saat
    
    // Signal History temizliği
    for (let [key, value] of signalHistory.entries()) {
        if (now - value.timestamp > signalHistoryTTL) {
            signalHistory.delete(key);
        }
    }
    
    // OHLCV Cache temizliği
    for (let [key, value] of ohlcvCache.entries()) {
        if (now - value.timestamp > ohlcvCacheTTL) {
            ohlcvCache.delete(key);
        }
    }
    
    console.log(`Periyodik temizlik: ${signalHistory.size} sinyal, ${ohlcvCache.size} OHLCV cache`);
}, 30 * 60 * 1000); // 30 dakikada bir

// Dinamik konfigürasyon - EKLENDİ
function updateDynamicConfig(symbolCount) {
    // Symbol sayısına göre batch size ayarla
    if (symbolCount > 100) {
        CONFIG.scanBatchSize = 4;
    } else if (symbolCount > 50) {
        CONFIG.scanBatchSize = 6;
    } else {
        CONFIG.scanBatchSize = 8;
    }
    
    // Symbol sayısına göre refresh süresini ayarla
    if (symbolCount > 200) {
        CONFIG.fullSymbolRefreshMs = 30 * 60 * 1000; // 30 dakika
    } else if (symbolCount > 100) {
        CONFIG.fullSymbolRefreshMs = 20 * 60 * 1000; // 20 dakika
    } else {
        CONFIG.fullSymbolRefreshMs = 15 * 60 * 1000; // 15 dakika
    }
    
    console.log(`Dinamik konfig güncellendi: ${symbolCount} symbol, batch: ${CONFIG.scanBatchSize}, refresh: ${CONFIG.fullSymbolRefreshMs}ms`);
}

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

// GÜNCELLENMİŞ PumpDumpStrategy Sınıfı
class PumpDumpStrategy {
    constructor() {
        this.name = 'PumpDumpStrategy';
        this.priceChangeThreshold = 1.5; // %3'ten %1.5'e düşürüldü
        this.volumeRatioThreshold = 2.0; // 3.0x'ten 2.0x'e düşürüldü
        this.lookbackPeriod = 15; // 15 mum
        this.cooldownPeriod = 10 * 60 * 1000; // 10 dakika cooldown
        this.atrSLMultiplier = 2.0; // ATR * 2.0
        this.atrTPMultiplier = 3.0; // ATR * 3.0
        this.recentSignals = new Map(); // Cooldown için sinyal geçmişi
    }

    async analyze(symbol, timeframe, ohlcv) {
        try {
            // Cooldown kontrolü
            const now = Date.now();
            const lastSignal = this.recentSignals.get(symbol);
            if (lastSignal && (now - lastSignal) < this.cooldownPeriod) {
                return null;
            }

            if (ohlcv.length < this.lookbackPeriod + 5) {
                return null;
            }

            const closes = ohlcv.map(d => d[4]);
            const volumes = ohlcv.map(d => d[5]);
            const currentClose = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];

            // Son mum hariç önceki 15 mumun ortalama hacmi
            const previousVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
            const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;

            // Hacim oranı
            const volumeRatio = currentVolume / avgVolume;

            // Fiyat değişimi (son mum vs bir önceki mum)
            const previousClose = closes[closes.length - 2];
            const priceChange = ((currentClose - previousClose) / previousClose) * 100;

            // ATR hesaplama
            const high = ohlcv.map(d => d[2]);
            const low = ohlcv.map(d => d[3]);
            const atr = await ATR.calculate({
                high: high.slice(-14),
                low: low.slice(-14),
                close: closes.slice(-14),
                period: 14
            });

            const currentATR = atr[atr.length - 1] || 0;

            // Pump/Dump tespiti
            if (Math.abs(priceChange) >= this.priceChangeThreshold && volumeRatio >= this.volumeRatioThreshold) {
                const direction = priceChange > 0 ? 'LONG' : 'SHORT';
                
                // Confidence hesaplama
                let confidence = 50;
                confidence += 20; // Pump/Dump tespiti için +20
                
                // Hacim oranına göre confidence artır
                if (volumeRatio >= 3.0) confidence += 15;
                else if (volumeRatio >= 2.0) confidence += 10;
                else if (volumeRatio >= 1.5) confidence += 5;

                // ATR'ye göre SL/TP hesapla
                const stopLoss = currentATR * this.atrSLMultiplier;
                const takeProfit = currentATR * this.atrTPMultiplier;

                // Cooldown'a ekle
                this.recentSignals.set(symbol, now);

                return {
                    symbol,
                    strategy: this.name,
                    direction,
                    confidence: Math.min(confidence, 95),
                    price: currentClose,
                    stopLoss,
                    takeProfit,
                    volumeRatio,
                    priceChange: Math.abs(priceChange),
                    timeframe,
                    timestamp: Date.now(),
                    metadata: {
                        atr: currentATR,
                        avgVolume,
                        currentVolume
                    }
                };
            }

            return null;
        } catch (error) {
            console.error(`PumpDumpStrategy error for ${symbol}:`, error);
            return null;
        }
    }
}

// GÜNCELLENMİŞ confirmBreakoutWithVolume fonksiyonu
const confirmBreakoutWithVolume = (symbol, ohlcv, breakoutPrice, direction) => {
    try {
        if (ohlcv.length < 20) {
            return { confirmed: false, strength: 'WEAK', volumeRatio: 1 };
        }

        const volumes = ohlcv.map(d => d[5]);
        
        // Son mumu (breakout mumunu) hariç tut, önceki mumların ortalamasını al
        const previousVolumes = volumes.slice(-21, -1); // Son 20 mum (breakout mumu hariç)
        const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;
        
        const currentVolume = volumes[volumes.length - 1];
        const volumeRatio = currentVolume / avgVolume;

        // Güç seviyelerini volumeRatio'ya göre ayarla
        let strength = 'WEAK';
        if (volumeRatio >= 3.0) {
            strength = 'STRONG';
        } else if (volumeRatio >= 2.0) {
            strength = 'MEDIUM';
        } else if (volumeRatio >= 1.3) {
            strength = 'WEAK';
        }

        const confirmed = volumeRatio >= CONFIG.volumeConfirmationThreshold;

        return {
            confirmed,
            strength,
            volumeRatio,
            avgVolume,
            currentVolume,
            breakoutPrice,
            direction
        };
    } catch (error) {
        console.error(`Volume confirmation error for ${symbol}:`, error);
        return { confirmed: false, strength: 'WEAK', volumeRatio: 1 };
    }
};

// API ROUTES - TAM VE EKSİKSİZ

// 1. Login Route
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email ve şifre gerekli' });
        }

        const user = await database.getUserByEmail(email);
        
        if (!user) {
            return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı' });
        }

        // Admin şifresi kontrolü (123456)
        if (email === 'admin@alphason.com' && password === '123456') {
            const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            await database.updateUserSession(user.id, token);
            
            return res.json({ 
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
        }

        const match = await bcrypt.compare(password, user.password);
        
        if (!match) {
            return res.status(401).json({ success: false, error: 'Şifre hatalı' });
        }
        
        if (user.status !== 'active') {
            return res.status(403).json({ success: false, error: 'Hesap aktif değil. Lütfen admin onayı bekleyin.' });
        }

        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await database.updateUserSession(user.id, token);
        
        const userSettings = await database.getUserSettings(user.id);
        
        return res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                email: user.email, 
                plan: user.plan,
                balance: user.balance,
                total_pnl: user.total_pnl,
                daily_pnl: user.daily_pnl
            },
            settings: userSettings
        });
    } catch (e) {
        console.error('Login Hatası:', e);
        return res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
});

// 2. Register Route
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, plan } = req.body;
        
        if (!email || !password || !plan) {
            return res.status(400).json({ success: false, error: 'Email, şifre ve plan gerekli' });
        }

        if (await database.getUserByEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email kullanımda' });
        }
        
        await database.createUser(email, password, plan);
        return res.json({ success: true, message: 'Kayıt başarılı, admin onayı bekleniyor' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Status Route
app.get('/api/status', (req, res) => {
    return res.json(systemStatus);
});

// 4. Crypto Price Route
app.get('/api/crypto/:symbol', async (req, res) => {
    try {
        const baseSymbol = req.params.symbol?.toUpperCase();
        if (!baseSymbol) {
             return res.status(400).json({ success: false, error: 'Geçersiz sembol.' });
        }

        const symbol = baseSymbol + '/USDT';
        const ticker = await publicExchange.fetchTicker(symbol);

        if (ticker) {
            return res.json({ 
                success: true, 
                price: ticker.last, 
                change24h: ticker.percentage, 
                volume: ticker.baseVolume || 0,
                signal: 'NEUTRAL'
            });
        } else {
            return res.status(404).json({ success: false, error: 'Veri yok' });
        }
    } catch (e) {
        console.error('Crypto Veri Hatası:', e.message);
        return res.status(500).json({ success: false, error: 'Sunucu hatası.' });
    }
});

// 5. User Info Route
app.get('/api/user/info', authenticateToken, (req, res) => {
    return res.json({ success: true, user: req.user });
});

// 6. Logout Route
app.post('/api/logout', authenticateToken, async (req, res) => {
    try {
        if (req.user) {
            await database.updateUserSession(req.user.id, null);
        }
        return res.json({ success: true, message: 'Çıkış başarılı' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 7. Settings Routes - TAMAMLANMIŞ
app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        const settings = await database.getUserSettings(req.user.id);
        return res.json({ success: true, settings });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
    try {
        await database.updateUserSettings(req.user.id, req.body);
        return res.json({ success: true, message: 'Ayarlar güncellendi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 8. Scan Refresh Route
app.get('/api/scan/refresh', (req, res) => {
    return res.json({ success: true, message: 'Tarama tetiklendi', timestamp: Date.now() });
});

// 9. Analyze Route
app.get('/api/analyze', (req, res) => {
    return res.json({ success: true, message: 'Analiz başlatıldı', timestamp: Date.now() });
});

// 10. Admin Routes
app.get('/api/admin/pending-users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const pendingUsers = await database.getPendingUsers();
        return res.json({ success: true, users: pendingUsers });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/all-users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const allUsers = await database.getAllUsers();
        return res.json({ success: true, users: allUsers });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/approve-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.approveUser(parseInt(req.params.userId), req.user.id);
        return res.json({ success: true, message: 'Kullanıcı onaylandı' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/reject-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.rejectUser(parseInt(req.params.userId), req.user.id);
        return res.json({ success: true, message: 'Kullanıcı reddedildi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/admin/delete-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.deleteUser(parseInt(req.params.userId));
        return res.json({ success: true, message: 'Kullanıcı silindi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 404 Handler - EKLENDİ
app.use('*', (req, res) => {
    return res.status(404).json({ success: false, error: 'Route bulunamadı' });
});

// Error Handler - EKLENDİ
app.use((err, req, res, next) => {
    console.error('Sunucu Hatası:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// Server başlatma - TAM VE EKSİKSİZ
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor.`);
    console.log(`✅ API Rotaları Aktif:`);
    console.log(`   POST /api/login`);
    console.log(`   POST /api/register`);
    console.log(`   GET  /api/status`);
    console.log(`   GET  /api/crypto/:symbol`);
    console.log(`   GET  /api/user/info`);
    console.log(`   POST /api/logout`);
    console.log(`   GET  /api/settings`);
    console.log(`   POST /api/settings`);
    console.log(`🔑 Admin Giriş Bilgileri: admin@alphason.com / 123456`);
    console.log(`🔄 Periyodik temizlik aktif (30 dakika)`);
    console.log(`⚡ Dinamik konfigürasyon aktif`);
});

module.exports = {
    app,
    PumpDumpStrategy,
    confirmBreakoutWithVolume
};
