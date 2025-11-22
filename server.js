require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { RSI, MACD } = require('technicalindicators');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ALPHASON CRYPTO - SQLITE KALICI
const dbPath = process.env.NODE_ENV === 'production'
    ? '/opt/render/project/src/alphason.db'
    : './alphason.db';

const db = new sqlite3.Database(dbPath);

// Database initialization
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        fullName TEXT,
        strategy TEXT DEFAULT 'breakout',
        subscription TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Signals table
    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        symbol TEXT,
        direction TEXT,
        entry REAL,
        tp REAL,
        sl REAL,
        confidence REAL,
        strategy TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // API Keys table
    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        exchange TEXT,
        api_key TEXT,
        secret TEXT,
        passphrase TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Create admin user if not exists
const createAdminUser = async () => {
    return new Promise((resolve, reject) => {
        db.get('SELECT id FROM users WHERE email = ?', [process.env.ADMIN_EMAIL || 'admin@alphason.com'], async (err, row) => {
            if (err) {
                console.error('Admin kontrol hatası:', err);
                return reject(err);
            }

            if (!row) {
                try {
                    const adminPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
                    db.run(`INSERT INTO users (email, password, fullName, role, subscription) VALUES (?, ?, ?, ?, ?)`,
                        [process.env.ADMIN_EMAIL || 'admin@alphason.com', adminPassword, 'System Admin', 'admin', 'elite'],
                        function(err) {
                            if (err) {
                                console.error('Admin oluşturma hatası:', err);
                                return reject(err);
                            }
                            console.log('✅ Admin kullanıcısı oluşturuldu');
                            resolve();
                        }
                    );
                } catch (e) {
                    console.error('Admin oluşturma sırasında hata:', e);
                    reject(e);
                }
            } else {
                console.log('ℹ️ Admin kullanıcısı zaten mevcut');
                resolve();
            }
        });
    });
};

// CSP ile Helmet middleware - TAM DÜZELTME
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "wss:"],
            imgSrc: ["'self'", "data:", "https:"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(cors());
// Body parsers - ensure before routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Erişim tokenı gereklidir' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'alphason-crypto-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    });
};

// ALPHASON CRYPTO - 3 TEKNİK STRATEJİ
const strategies = {
    // 1. KIRILIM STRATEJİSİ
    breakout: async (symbol) => {
        try {
            const exchange = new ccxt.binance({ enableRateLimit: true });
            await exchange.loadMarkets();
            const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);

            const highs = ohlcv.map(c => c[2]);
            const lows = ohlcv.map(c => c[3]);
            const closes = ohlcv.map(c => c[4]);
            const volumes = ohlcv.map(c => c[5]);

            if (volumes.length < 5 || closes.length < 5) return null;

            // Destek/Direnç hesapla
            const last20Highs = highs.slice(-20);
            const last20Lows = lows.slice(-20);
            const resistance = Math.max(...last20Highs);
            const support = Math.min(...last20Lows);
            const currentPrice = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];
            const volSlice = volumes.slice(-20);
            const avgVolume = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;

            // Volume onayı ile kırılım tespiti
            if (currentPrice > resistance * 0.998 && currentVolume > avgVolume * 1.5) {
                return {
                    direction: 'LONG',
                    confidence: 75,
                    entry: currentPrice,
                    tp: currentPrice * 1.02,
                    sl: currentPrice * 0.98
                };
            } else if (currentPrice < support * 1.002 && currentVolume > avgVolume * 1.5) {
                return {
                    direction: 'SHORT',
                    confidence: 70,
                    entry: currentPrice,
                    tp: currentPrice * 0.98,
                    sl: currentPrice * 1.02
                };
            }

            return null;
        } catch (error) {
            console.error('Breakout strategy error:', error);
            return null;
        }
    },

    // 2. PUMP/DETECTOR
    pumpdetect: async (symbol) => {
        try {
            const exchange = new ccxt.binance({ enableRateLimit: true });
            await exchange.loadMarkets();
            const ohlcv = await exchange.fetchOHLCV(symbol, '5m', undefined, 50);

            const volumes = ohlcv.map(c => c[5]);
            const closes = ohlcv.map(c => c[4]);
            const highs = ohlcv.map(c => c[2]);
            const lows = ohlcv.map(c => c[3]);

            if (volumes.length < 5 || closes.length < 2) return null;

            const currentVolume = volumes[volumes.length - 1];
            const volSlice = volumes.slice(-20);
            const avgVolume = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
            const priceChange = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
            const priceRange = (highs[highs.length - 1] - lows[lows.length - 1]) / lows[lows.length - 1] * 100;

            // Ani hacim artışı + fiyat hareketi + yüksek volatilite
            if (currentVolume > avgVolume * 3 && Math.abs(priceChange) > 2 && priceRange > 3) {
                const direction = priceChange > 0 ? 'LONG' : 'SHORT';
                const currentPrice = closes[closes.length - 1];

                return {
                    direction: direction,
                    confidence: 80,
                    entry: currentPrice,
                    tp: direction === 'LONG' ? currentPrice * 1.03 : currentPrice * 0.97,
                    sl: direction === 'LONG' ? currentPrice * 0.97 : currentPrice * 1.03
                };
            }

            return null;
        } catch (error) {
            console.error('PumpDetect strategy error:', error);
            return null;
        }
    },

    // 3. RSI+MACD KOMBO
    rsimacd: async (symbol) => {
        try {
            const exchange = new ccxt.binance({ enableRateLimit: true });
            await exchange.loadMarkets();
            const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
            const closes = ohlcv.map(c => c[4]);

            if (closes.length < 30) return null;

            // RSI hesapla
            const rsi = RSI.calculate({ values: closes, period: 14 });
            const currentRSI = rsi[rsi.length - 1];

            // MACD hesapla
            const macd = MACD.calculate({
                values: closes,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            });

            if (!macd || macd.length === 0) return null;
            const currentMACD = macd[macd.length - 1];
            const currentPrice = closes[closes.length - 1];

            // Strateji kuralları
            if (currentRSI < 30 && currentMACD?.MACD > currentMACD?.signal) {
                return {
                    direction: 'LONG',
                    confidence: 85,
                    entry: currentPrice,
                    tp: currentPrice * 1.015,
                    sl: currentPrice * 0.985
                };
            } else if (currentRSI > 70 && currentMACD?.MACD < currentMACD?.signal) {
                return {
                    direction: 'SHORT',
                    confidence: 80,
                    entry: currentPrice,
                    tp: currentPrice * 0.985,
                    sl: currentPrice * 1.015
                };
            }

            return null;
        } catch (error) {
            console.error('RSI+MACD strategy error:', error);
            return null;
        }
    }
};

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName, strategy = 'breakout' } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email ve password gereklidir' });
        }

        // Check if user exists
        db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
            if (err) {
                console.error('DB error on register:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (row) {
                return res.status(400).json({ success: false, error: 'Bu e-posta zaten kullanılıyor' });
            }

            // Create user
            try {
                const hashedPassword = await bcrypt.hash(password, 12);
                db.run('INSERT INTO users (email, password, fullName, strategy) VALUES (?, ?, ?, ?)',
                    [email, hashedPassword, fullName, strategy],
                    function(err) {
                        if (err) {
                            console.error('DB insert error on register:', err);
                            return res.status(500).json({ success: false, error: 'Kullanıcı oluşturulamadı' });
                        }

                        // Generate token
                        const token = jwt.sign(
                            { userId: this.lastID, email, strategy },
                            process.env.JWT_SECRET || 'alphason-crypto-secret-key',
                            { expiresIn: '7d' }
                        );

                        res.json({
                            success: true,
                            message: 'Kayıt başarılı',
                            token,
                            user: { id: this.lastID, email, fullName, strategy }
                        });
                    }
                );
            } catch (e) {
                console.error('Register hashing error:', e);
                return res.status(500).json({ success: false, error: 'Kayıt sırasında hata oluştu' });
            }
        });
    } catch (error) {
        console.error('Unhandled register error:', error);
        res.status(500).json({ success: false, error: 'Kayıt sırasında hata oluştu' });
    }
});

// UPDATED LOGIN HANDLER - daha açıklayıcı log + validation
app.post('/api/auth/login', async (req, res) => {
    try {
        console.log('LOGIN attempt, body keys:', Object.keys(req.body || {}));
        const { email, password } = req.body || {};

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email ve password gereklidir' });
        }

        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                console.error('DB error on login:', err);
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            if (!user) {
                console.log('Login failed - user not found:', email);
                return res.status(400).json({ success: false, error: 'Geçersiz e-posta veya şifre' });
            }

            // Ensure password field exists
            if (!user.password) {
                console.error('Login failed - user.password missing for:', email);
                return res.status(500).json({ success: false, error: 'Server configuration error' });
            }

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                console.log('Login failed - invalid password for:', email);
                return res.status(400).json({ success: false, error: 'Geçersiz e-posta veya şifre' });
            }

            const token = jwt.sign(
                {
                    userId: user.id,
                    email: user.email,
                    strategy: user.strategy,
                    role: user.role
                },
                process.env.JWT_SECRET || 'alphason-crypto-secret-key',
                { expiresIn: '7d' }
            );

            res.json({
                success: true,
                message: 'Giriş başarılı',
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    fullName: user.fullName,
                    strategy: user.strategy,
                    subscription: user.subscription,
                    role: user.role
                }
            });
        });
    } catch (error) {
        console.error('Unhandled login error:', error);
        res.status(500).json({ success: false, error: 'Giriş sırasında hata oluştu' });
    }
});

// USER PROFILE ROUTE
app.get('/api/auth/profile', authenticateToken, (req, res) => {
    db.get('SELECT id, email, fullName, strategy, subscription, role FROM users WHERE id = ?',
        [req.user.userId], (err, user) => {
            if (err || !user) {
                return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
            }
            res.json({ success: true, user });
        });
});

// SIGNALS ROUTES
app.get('/api/signals', authenticateToken, async (req, res) => {
    try {
        const userStrategy = req.user.strategy || 'breakout';
        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT', 'DOT/USDT', 'LINK/USDT'];
        const signals = [];

        for (let symbol of symbols) {
            const signal = await strategies[userStrategy](symbol);
            if (signal) {
                const signalData = {
                    symbol,
                    strategy: userStrategy,
                    ...signal,
                    timestamp: new Date()
                };
                signals.push(signalData);

                // Save to database
                db.run(`INSERT INTO signals (user_id, symbol, direction, entry, tp, sl, confidence, strategy)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [req.user.userId, symbol, signal.direction, signal.entry, signal.tp, signal.sl, signal.confidence, userStrategy],
                    function(err) {
                        if (err) {
                            console.error('DB insert error for signal:', err);
                        }
                    });
            }
        }

        res.json({ success: true, signals });
    } catch (error) {
        console.error('Signals route error:', error);
        res.status(500).json({ success: false, error: 'Sinyaller alınamadı' });
    }
});

// UPDATE STRATEGY
app.put('/api/user/strategy', authenticateToken, (req, res) => {
    const { strategy } = req.body;

    if (!strategies[strategy]) {
        return res.status(400).json({ success: false, error: 'Geçersiz strateji' });
    }

    db.run('UPDATE users SET strategy = ? WHERE id = ?', [strategy, req.user.userId], function(err) {
        if (err) {
            console.error('DB error on update strategy:', err);
            return res.status(500).json({ success: false, error: 'Strateji güncellenemedi' });
        }
        res.json({ success: true, message: 'Strateji güncellendi', strategy });
    });
});

// WebSocket for real-time signals
wss.on('connection', (ws, req) => {
    console.log('AlphaSon Crypto WebSocket connected');

    const authenticateWebSocket = () => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (!token) {
            ws.close(1008, 'Authentication required');
            return null;
        }

        try {
            const user = jwt.verify(token, process.env.JWT_SECRET || 'alphason-crypto-secret-key');
            return user;
        } catch (error) {
            ws.close(1008, 'Invalid token');
            return null;
        }
    };

    const user = authenticateWebSocket();
    if (!user) return;

    ws.send(JSON.stringify({
        type: 'connected',
        message: 'AlphaSon Crypto WebSocket bağlantısı başarılı',
        user: { email: user.email, strategy: user.strategy }
    }));

    let running = false;
    const sendSignals = async () => {
        if (running) return;
        running = true;
        try {
            const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
            const userStrategy = user.strategy || 'breakout';

            for (let symbol of symbols) {
                const signal = await strategies[userStrategy](symbol);
                if (signal && ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'signal',
                        strategy: userStrategy,
                        symbol: symbol,
                        direction: signal.direction,
                        entry: signal.entry,
                        tp: signal.tp,
                        sl: signal.sl,
                        confidence: signal.confidence,
                        timestamp: new Date()
                    }));
                }
            }
        } catch (error) {
            console.error('WebSocket signal error:', error);
        } finally {
            running = false;
        }
    };

    // Her 30 saniyede bir sinyal taraması
    const interval = setInterval(sendSignals, 30000);
    sendSignals(); // İlk çalıştırma

    ws.on('close', () => {
        clearInterval(interval);
        console.log('AlphaSon Crypto WebSocket disconnected');
    });
});

// Frontend route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server
async function startServer() {
    try {
        console.log('✅ SQLite bağlantısı başarılı');
        console.log('✅ SQLite database synchronized');

        // Admin kullanıcısını oluştur
        await createAdminUser();

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`
🚀 ALPHASON CRYPTO - SAF TEKNIK ANALIZ SISTEMI
📍 Port: ${PORT}
🎯 Stratejiler: KIRILIM + PUMP/DETECTOR + RSI/MACD
💚 Renkler: Huba Yeşili (#10B981) + Klasik Kırmızı (#EF4444)
🗄️  Database: SQLite
🌐  WebSocket: Aktif
🔐  Authentication: JWT
            `);
        });
    } catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close();
    server.close(() => {
        console.log('Process terminated');
    });
});

startServer();
