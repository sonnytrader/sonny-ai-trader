require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { RSI, MACD, SMA, ATR } = require('technicalindicators');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// SQLite Database
const db = new sqlite3.Database('./alphason.db');

// Database Setup
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        fullName TEXT,
        strategy TEXT DEFAULT 'breakout',
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        symbol TEXT,
        direction TEXT,
        entry REAL,
        tp REAL,
        sl REAL,
        confidence INTEGER,
        strategy TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
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
    
    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        symbol TEXT,
        direction TEXT,
        entry_price REAL,
        exit_price REAL,
        quantity REAL,
        pnl REAL,
        status TEXT DEFAULT 'open',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Admin kullanıcı oluştur
const createAdminUser = () => {
    const plainPassword = 'admin123';
    const hashedPassword = bcrypt.hashSync(plainPassword, 12);
    
    db.run(
        `INSERT OR REPLACE INTO users (email, password, fullName, role) 
         VALUES (?, ?, ?, ?)`,
        ['admin@alphason.com', hashedPassword, 'System Admin', 'admin'],
        function(err) {
            if (err) {
                console.error('Admin oluşturma hatası:', err);
            } else {
                console.log('🎉 ADMIN HESABI HAZIR!');
                console.log('📧 Email: admin@alphason.com');
                console.log('🔑 Şifre: admin123');
            }
        }
    );
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Erişim tokenı gereklidir' });
    }

    jwt.verify(token, 'alphason-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    });
};

// Şifreleme fonksiyonları
const encrypt = (text) => {
    const cipher = crypto.createCipher('aes-256-cbc', 'alphason-encryption-key');
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
};

const decrypt = (encryptedText) => {
    const decipher = crypto.createDecipher('aes-256-cbc', 'alphason-encryption-key');
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
};

// GERÇEK TEKNİK ANALİZ STRATEJİLERİ
const realStrategies = {
    // 1. GELİŞMİŞ KIRILIM STRATEJİSİ
    breakout: async (symbol) => {
        try {
            const exchange = new ccxt.binance();
            const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);
            
            if (!ohlcv || ohlcv.length < 50) return null;
            
            const highs = ohlcv.map(c => c[2]);
            const lows = ohlcv.map(c => c[3]);
            const closes = ohlcv.map(c => c[4]);
            const volumes = ohlcv.map(c => c[5]);
            
            // EMA'lar
            const ema20 = SMA.calculate({ period: 20, values: closes });
            const ema50 = SMA.calculate({ period: 50, values: closes });
            
            if (!ema20 || !ema50 || ema20.length < 2) return null;
            
            const currentEMA20 = ema20[ema20.length - 1];
            const currentEMA50 = ema50[ema50.length - 1];
            const prevEMA20 = ema20[ema20.length - 2];
            
            // Destek/Direnç
            const resistance = Math.max(...highs.slice(-20));
            const support = Math.min(...lows.slice(-20));
            const currentPrice = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];
            const avgVolume = volumes.slice(-20).reduce((a, b) => a + b) / 20;
            
            // Gelişmiş breakout kuralları
            const isUptrend = currentEMA20 > currentEMA50;
            const volumeSpike = currentVolume > avgVolume * 1.8;
            const emaBullish = currentEMA20 > prevEMA20;
            
            if (currentPrice > resistance * 0.998 && volumeSpike && isUptrend && emaBullish) {
                const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
                const currentATR = atr[atr.length - 1];
                
                return { 
                    direction: 'LONG', 
                    confidence: 78,
                    entry: currentPrice,
                    tp: currentPrice + (currentATR * 2),
                    sl: currentPrice - (currentATR * 1)
                };
            } else if (currentPrice < support * 1.002 && volumeSpike && !isUptrend) {
                const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
                const currentATR = atr[atr.length - 1];
                
                return { 
                    direction: 'SHORT', 
                    confidence: 72,
                    entry: currentPrice,
                    tp: currentPrice - (currentATR * 2),
                    sl: currentPrice + (currentATR * 1)
                };
            }
            
            return null;
        } catch (error) {
            console.error('Breakout strategy error:', error.message);
            return null;
        }
    },
    
    // 2. GELİŞMİŞ RSI+MACD STRATEJİSİ
    rsimacd: async (symbol) => {
        try {
            const exchange = new ccxt.binance();
            const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
            const closes = ohlcv.map(c => c[4]);
            
            if (closes.length < 50) return null;
            
            // RSI
            const rsi = RSI.calculate({ values: closes, period: 14 });
            const currentRSI = rsi[rsi.length - 1];
            const prevRSI = rsi[rsi.length - 2];
            
            // MACD
            const macd = MACD.calculate({
                values: closes,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            });
            
            const currentMACD = macd[macd.length - 1];
            const prevMACD = macd[macd.length - 2];
            const currentPrice = closes[closes.length - 1];
            
            // Gelişmiş RSI+MACD kuralları
            const rsiOversold = currentRSI < 35 && currentRSI > prevRSI;
            const rsiOverbought = currentRSI > 65 && currentRSI < prevRSI;
            const macdBullish = currentMACD?.MACD > currentMACD?.signal && currentMACD?.MACD > prevMACD?.MACD;
            const macdBearish = currentMACD?.MACD < currentMACD?.signal && currentMACD?.MACD < prevMACD?.MACD;
            
            if (rsiOversold && macdBullish) {
                const atr = ATR.calculate({ 
                    high: ohlcv.map(c => c[2]), 
                    low: ohlcv.map(c => c[3]), 
                    close: closes, 
                    period: 14 
                });
                const currentATR = atr[atr.length - 1];
                
                return { 
                    direction: 'LONG', 
                    confidence: 82,
                    entry: currentPrice,
                    tp: currentPrice + (currentATR * 2.5),
                    sl: currentPrice - (currentATR * 1.2)
                };
            } else if (rsiOverbought && macdBearish) {
                const atr = ATR.calculate({ 
                    high: ohlcv.map(c => c[2]), 
                    low: ohlcv.map(c => c[3]), 
                    close: closes, 
                    period: 14 
                });
                const currentATR = atr[atr.length - 1];
                
                return { 
                    direction: 'SHORT', 
                    confidence: 79,
                    entry: currentPrice,
                    tp: currentPrice - (currentATR * 2.5),
                    sl: currentPrice + (currentATR * 1.2)
                };
            }
            
            return null;
        } catch (error) {
            console.error('RSI+MACD strategy error:', error.message);
            return null;
        }
    },
    
    // 3. GELİŞMİŞ PUMP/DETECTOR
    pumpdetect: async (symbol) => {
        try {
            const exchange = new ccxt.binance();
            const ohlcv = await exchange.fetchOHLCV(symbol, '5m', undefined, 50);
            
            const volumes = ohlcv.map(c => c[5]);
            const closes = ohlcv.map(c => c[4]);
            const highs = ohlcv.map(c => c[2]);
            const lows = ohlcv.map(c => c[3]);
            
            if (volumes.length < 20) return null;
            
            const currentVolume = volumes[volumes.length - 1];
            const avgVolume = volumes.slice(-20).reduce((a, b) => a + b) / 20;
            const priceChange = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
            const priceRange = (highs[highs.length - 1] - lows[highs.length - 1]) / lows[highs.length - 1] * 100;
            
            // Gelişmiş pump detection
            const volumeSpike = currentVolume > avgVolume * 4;
            const significantMove = Math.abs(priceChange) > 3;
            const highVolatility = priceRange > 4;
            const consecutiveGreen = closes[closes.length - 1] > closes[closes.length - 2] && 
                                   closes[closes.length - 2] > closes[closes.length - 3];
            const consecutiveRed = closes[closes.length - 1] < closes[closes.length - 2] && 
                                 closes[closes.length - 2] < closes[closes.length - 3];
            
            if (volumeSpike && significantMove && highVolatility) {
                const direction = consecutiveGreen ? 'LONG' : consecutiveRed ? 'SHORT' : priceChange > 0 ? 'LONG' : 'SHORT';
                const currentPrice = closes[closes.length - 1];
                
                return { 
                    direction: direction, 
                    confidence: 85,
                    entry: currentPrice,
                    tp: direction === 'LONG' ? currentPrice * 1.04 : currentPrice * 0.96,
                    sl: direction === 'LONG' ? currentPrice * 0.96 : currentPrice * 1.04
                };
            }
            
            return null;
        } catch (error) {
            console.error('PumpDetect strategy error:', error.message);
            return null;
        }
    }
};

// API KEY YÖNETİMİ
app.post('/api/keys', authenticateToken, (req, res) => {
    const { exchange, apiKey, secret, passphrase = '' } = req.body;
    
    if (!exchange || !apiKey || !secret) {
        return res.status(400).json({ success: false, error: 'Tüm alanlar zorunludur' });
    }
    
    const encryptedApiKey = encrypt(apiKey);
    const encryptedSecret = encrypt(secret);
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : '';
    
    db.run(
        `INSERT INTO api_keys (user_id, exchange, api_key, secret, passphrase) 
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.userId, exchange, encryptedApiKey, encryptedSecret, encryptedPassphrase],
        function(err) {
            if (err) {
                console.error('API key kaydetme hatası:', err);
                return res.status(500).json({ success: false, error: 'API key kaydedilemedi' });
            }
            res.json({ success: true, message: 'API key başarıyla kaydedildi' });
        }
    );
});

app.get('/api/keys', authenticateToken, (req, res) => {
    db.all('SELECT id, exchange, created_at FROM api_keys WHERE user_id = ?', [req.user.userId], (err, keys) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'API keyler alınamadı' });
        }
        res.json({ success: true, keys });
    });
});

// GERÇEK SİNYALLER
app.get('/api/realsignals', authenticateToken, async (req, res) => {
    try {
        const userStrategy = req.user.strategy || 'breakout';
        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT', 'DOT/USDT', 'LINK/USDT', 'BNB/USDT', 'XRP/USDT', 'SOL/USDT'];
        const signals = [];

        for (let symbol of symbols) {
            try {
                const signal = await realStrategies[userStrategy](symbol);
                if (signal) {
                    const signalData = {
                        symbol,
                        strategy: userStrategy,
                        ...signal,
                        timestamp: new Date()
                    };
                    signals.push(signalData);

                    // Database'e kaydet
                    db.run(`INSERT INTO signals (user_id, symbol, direction, entry, tp, sl, confidence, strategy) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [req.user.userId, symbol, signal.direction, signal.entry, signal.tp, signal.sl, signal.confidence, userStrategy]);
                }
            } catch (symbolError) {
                console.error(`Sinyal hatası ${symbol}:`, symbolError.message);
            }
        }

        res.json({ success: true, signals });
    } catch (error) {
        console.error('Real signals error:', error);
        res.status(500).json({ success: false, error: 'Sinyaller alınamadı' });
    }
});

// MANUEL TRADE AÇMA
app.post('/api/trades', authenticateToken, async (req, res) => {
    const { symbol, direction, quantity, entryPrice, tp, sl } = req.body;
    
    try {
        db.run(`INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, status) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.userId, symbol, direction, entryPrice, quantity, 'open'],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Trade açılamadı' });
                }
                res.json({ 
                    success: true, 
                    message: 'Trade başarıyla açıldı',
                    tradeId: this.lastID 
                });
            }
        );
    } catch (error) {
        res.status(500).json({ success: false, error: 'Trade hatası' });
    }
});

// AÇIK TRADELER
app.get('/api/trades/open', authenticateToken, (req, res) => {
    db.all('SELECT * FROM trades WHERE user_id = ? AND status = "open" ORDER BY timestamp DESC', 
        [req.user.userId], (err, trades) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Tradeler alınamadı' });
        }
        res.json({ success: true, trades });
    });
});

// MEVCUT BAKİYE (Mock)
app.get('/api/balance', authenticateToken, (req, res) => {
    const mockBalance = {
        total: 1250.50,
        available: 980.25,
        inTrades: 270.25,
        pnl: 45.75
    };
    res.json({ success: true, balance: mockBalance });
});

// LOGIN ROUTE
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    console.log('Login attempt:', email);
    
    if (!email || !password) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email ve şifre gereklidir' 
        });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ 
                success: false, 
                error: 'Database hatası' 
            });
        }
        
        if (!user) {
            console.log('Kullanıcı bulunamadı:', email);
            return res.status(400).json({ 
                success: false, 
                error: 'Geçersiz email veya şifre' 
            });
        }

        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) {
                console.error('Şifre karşılaştırma hatası:', err);
                return res.status(500).json({ 
                    success: false, 
                    error: 'Şifre kontrol hatası' 
                });
            }
            
            if (!isMatch) {
                console.log('Şifre yanlış:', email);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Geçersiz email veya şifre' 
                });
            }

            const token = jwt.sign(
                { 
                    userId: user.id, 
                    email: user.email,
                    role: user.role 
                },
                'alphason-secret-key',
                { expiresIn: '7d' }
            );

            console.log('✅ BAŞARILI GİRİŞ:', email);
            
            res.json({
                success: true,
                message: 'Giriş başarılı!',
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    fullName: user.fullName,
                    strategy: user.strategy,
                    role: user.role
                }
            });
        });
    });
});

// DİĞER ROUTELAR...
app.get('/api/auth/profile', authenticateToken, (req, res) => {
    db.get('SELECT id, email, fullName, strategy, role FROM users WHERE id = ?', 
        [req.user.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        }
        res.json({ success: true, user });
    });
});

app.put('/api/user/strategy', authenticateToken, (req, res) => {
    const { strategy } = req.body;
    
    const validStrategies = ['breakout', 'pumpdetect', 'rsimacd'];
    if (!validStrategies.includes(strategy)) {
        return res.status(400).json({ success: false, error: 'Geçersiz strateji' });
    }

    db.run('UPDATE users SET strategy = ? WHERE id = ?', [strategy, req.user.userId], function(err) {
        if (err) {
            return res.status(500).json({ success: false, error: 'Strateji güncellenemedi' });
        }
        res.json({ success: true, message: 'Strateji güncellendi', strategy });
    });
});

app.post('/api/auth/register', (req, res) => {
    const { email, password, fullName, strategy = 'breakout' } = req.body;

    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        
        if (row) {
            return res.status(400).json({ success: false, error: 'Bu e-posta zaten kullanılıyor' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        db.run('INSERT INTO users (email, password, fullName, strategy) VALUES (?, ?, ?, ?)',
            [email, hashedPassword, fullName, strategy],
            function(err) {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Kullanıcı oluşturulamadı' });
                }

                const token = jwt.sign(
                    { userId: this.lastID, email, strategy },
                    'alphason-secret-key',
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
    });
});

// WebSocket connection
wss.on('connection', (ws, req) => {
    console.log('WebSocket connected');
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
        ws.close(1008, 'Authentication required');
        return;
    }

    try {
        const user = jwt.verify(token, 'alphason-secret-key');
        console.log('WebSocket authenticated for user:', user.email);
        
        ws.send(JSON.stringify({
            type: 'connected',
            message: 'WebSocket bağlantısı başarılı'
        }));

        // Gerçek sinyal gönderimi
        const sendRealSignals = async () => {
            try {
                const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
                const userStrategy = user.strategy || 'breakout';

                for (let symbol of symbols) {
                    const signal = await realStrategies[userStrategy](symbol);
                    if (signal && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'signal',
                            symbol: symbol,
                            strategy: userStrategy,
                            ...signal,
                            timestamp: new Date()
                        }));
                    }
                }
            } catch (error) {
                console.error('WebSocket signal error:', error);
            }
        };

        // Her 60 saniyede bir gerçek sinyal taraması
        const interval = setInterval(sendRealSignals, 60000);
        sendRealSignals(); // İlk çalıştırma
        
        ws.on('close', () => {
            clearInterval(interval);
            console.log('WebSocket disconnected');
        });

    } catch (error) {
        ws.close(1008, 'Invalid token');
    }
});

// Frontend route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server başlatma
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🚀 ALPHASON CRYPTO - GERÇEK TRADING SİSTEMİ');
    createAdminUser();
    console.log(`📍 Port: ${PORT}`);
    console.log('🎯 Gerçek Stratejiler: KIRILIM + PUMP/DETECTOR + RSI/MACD');
    console.log('💼 Özellikler: API Key Yönetimi + Manuel Trading + Real Sinyaller');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close();
    server.close(() => {
        console.log('Process terminated');
    });
});
