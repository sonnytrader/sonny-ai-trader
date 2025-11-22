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

// PROFILE ROUTE
app.get('/api/auth/profile', authenticateToken, (req, res) => {
    db.get('SELECT id, email, fullName, strategy, role FROM users WHERE id = ?', 
        [req.user.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        }
        res.json({ success: true, user });
    });
});

// SIGNALS ROUTE
app.get('/api/signals', authenticateToken, (req, res) => {
    // Mock signals data
    const mockSignals = [
        {
            symbol: 'BTC/USDT',
            direction: 'LONG',
            entry: 45000.50,
            tp: 46000.00,
            sl: 44500.00,
            confidence: 75,
            strategy: 'breakout',
            timestamp: new Date()
        },
        {
            symbol: 'ETH/USDT',
            direction: 'SHORT', 
            entry: 2500.75,
            tp: 2450.00,
            sl: 2550.00,
            confidence: 80,
            strategy: 'pumpdetect',
            timestamp: new Date()
        }
    ];
    
    res.json({ success: true, signals: mockSignals });
});

// STRATEGY UPDATE ROUTE
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

// REGISTER ROUTE
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

        // Mock real-time signals
        const sendMockSignal = () => {
            const signals = [
                { symbol: 'BTC/USDT', direction: 'LONG', confidence: 75 },
                { symbol: 'ETH/USDT', direction: 'SHORT', confidence: 80 },
                { symbol: 'ADA/USDT', direction: 'LONG', confidence: 65 }
            ];
            
            const randomSignal = signals[Math.floor(Math.random() * signals.length)];
            
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({
                    type: 'signal',
                    ...randomSignal,
                    timestamp: new Date()
                }));
            }
        };

        // Her 30 saniyede bir mock sinyal gönder
        const interval = setInterval(sendMockSignal, 30000);
        
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
    console.log('🚀 AlphaSon Crypto Başlatılıyor...');
    createAdminUser();
    console.log(`📍 Port: ${PORT}`);
    console.log('🎯 Giriş Bilgileri: admin@alphason.com / admin123');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close();
    server.close(() => {
        console.log('Process terminated');
    });
});
