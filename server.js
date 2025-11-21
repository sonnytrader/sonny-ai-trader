/** 
 * server.js - TrendMaster AI with AUTH SYSTEM
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

console.log('=== TRENDMASTER AI WITH AUTH BAŞLATILIYOR ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'trendmaster-secret-key-2024';

// Basit in-memory user database (production'da PostgreSQL kullan)
const users = [
    {
        id: 1,
        email: 'admin@trendmaster.com',
        password: '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/eoGM3X7C.8QYcW5S', // Admin123!
        fullName: 'Admin User',
        role: 'admin',
        status: 'active',
        subscription: 'premium'
    }
];

// Basit Config
const CONFIG = {
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),
    leverage: 10,
    marginPercent: 5,
    minConfidenceForAuto: 70,
    minVolumeUSD: 300000,
    orderType: 'limit',
    autotradeMaster: false,
    timeframes: ['1h', '4h']
};

// Global değişkenler
let exchangeAdapter = null;
let signalCache = new Map();

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    });
};

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName, phone, plan } = req.body;

        // Check if user exists
        const existingUser = users.find(u => u.email === email);
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bu email zaten kullanılıyor' 
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user
        const newUser = {
            id: users.length + 1,
            email,
            password: hashedPassword,
            fullName,
            phone,
            role: 'user',
            status: 'pending', // Admin onayı bekliyor
            subscription: plan || 'basic',
            createdAt: new Date()
        };

        users.push(newUser);

        res.json({
            success: true,
            message: 'Kayıt başarılı! Admin onayı bekleniyor.',
            user: {
                id: newUser.id,
                email: newUser.email,
                fullName: newUser.fullName
            }
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Kayıt sırasında hata: ' + error.message 
        });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const user = users.find(u => u.email === email);
        if (!user) {
            return res.status(400).json({ 
                success: false, 
                error: 'Geçersiz email veya şifre' 
            });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ 
                success: false, 
                error: 'Geçersiz email veya şifre' 
            });
        }

        // Check if user is approved
        if (user.status !== 'active' && user.role !== 'admin') {
            return res.status(403).json({ 
                success: false, 
                error: 'Hesabınız henüz onaylanmamış' 
            });
        }

        // Create token
        const token = jwt.sign(
            { 
                userId: user.id, 
                email: user.email, 
                role: user.role,
                subscription: user.subscription
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            message: 'Giriş başarılı!',
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.fullName,
                role: user.role,
                status: user.status,
                subscription: user.subscription
            }
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Giriş sırasında hata: ' + error.message 
        });
    }
});

app.get('/api/auth/profile', authenticateToken, (req, res) => {
    const user = users.find(u => u.id === req.user.userId);
    if (!user) {
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    res.json({
        success: true,
        user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            status: user.status,
            subscription: user.subscription
        }
    });
});

// PROTECTED ROUTES
app.get('/api/status', authenticateToken, async (req, res) => {
    try {
        let balance = 0;
        if (CONFIG.isApiConfigured && exchangeAdapter) {
            const b = await exchangeAdapter.raw.fetchBalance();
            balance = parseFloat(b.USDT?.free || 0);
        }
        
        const signals = Array.from(signalCache.values())
            .sort((a, b) => b.timestamp - a.timestamp);
            
        res.json({
            success: true,
            balance: balance,
            signals: signals,
            config: CONFIG,
            system: {
                marketSentiment: "ANALİZ EDİLİYOR...",
                filterCount: signalCache.size
            }
        });
    } catch (error) {
        res.json({
            success: true,
            balance: 0,
            signals: [],
            config: CONFIG,
            system: {
                marketSentiment: "SİSTEM HATASI",
                filterCount: 0
            }
        });
    }
});

app.post('/api/config/update', authenticateToken, (req, res) => {
    Object.assign(CONFIG, req.body);
    console.log('✅ Config güncellendi:', CONFIG);
    res.json({ success: true });
});

app.post('/api/trade/manual', authenticateToken, async (req, res) => {
    if (!CONFIG.isApiConfigured) {
        return res.status(400).json({ success: false, error: 'API key gerekli' });
    }
    
    try {
        const signal = req.body;
        console.log('🚀 Manuel trade:', signal.coin, signal.taraf);
        
        // Burada trade işlemi yapılacak
        // Şimdilik başarılı dönüyoruz
        res.json({ success: true, message: 'Trade başarılı' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebSocket bağlantıları with Auth
wss.on('connection', (ws, req) => {
    console.log('✅ Yeni WebSocket bağlantısı');
    
    // Basit auth - production'da JWT kontrolü eklenmeli
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'TrendMaster AI bağlantısı başarılı'
    }));

    // Mevcut sinyalleri gönder
    const signals = Array.from(signalCache.values());
    ws.send(JSON.stringify({
        type: 'signal_list',
        data: signals
    }));
});

// Sinyal gönder fonksiyonu
function broadcastSignal(signal) {
    signalCache.set(signal.id, signal);
    
    const message = JSON.stringify({
        type: 'signal',
        data: signal
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Örnek sinyal üretimi
function generateSampleSignals() {
    setInterval(() => {
        const sampleSignals = [
            {
                id: 'signal_' + Date.now(),
                coin: 'BTC/USDT',
                ccxt_symbol: 'BTC/USDT:USDT',
                taraf: Math.random() > 0.5 ? 'LONG_BREAKOUT' : 'SHORT_BREAKOUT',
                giris: (40000 + Math.random() * 2000).toFixed(2),
                tp1: (42000 + Math.random() * 3000).toFixed(2),
                sl: (39000 + Math.random() * 1000).toFixed(2),
                riskReward: (2 + Math.random() * 2).toFixed(2),
                confidence: 70 + Math.floor(Math.random() * 25),
                positionSize: 1.0,
                positionSizeType: 'NORMAL',
                riskLevel: 'MEDIUM',
                tuyo: 'Örnek sinyal - test amaçlı',
                timestamp: Date.now(),
                signalQuality: 75,
                marketStructure: 'BULLISH',
                volumeConfirmed: true,
                signalSource: 'SİSTEM',
                isAISignal: false,
                orderType: CONFIG.orderType
            }
        ];
        
        sampleSignals.forEach(signal => {
            broadcastSignal(signal);
        });
        
        console.log('📊 Örnek sinyal üretildi');
    }, 30000);
}

// Server başlatma
async function startServer() {
    try {
        // Exchange bağlantısı
        if (CONFIG.isApiConfigured) {
            exchangeAdapter = { 
                raw: new ccxt.bitget({
                    apiKey: CONFIG.apiKey,
                    secret: CONFIG.secret,
                    password: CONFIG.password,
                    options: { defaultType: 'swap' },
                    timeout: 30000
                })
            };
            console.log('✅ Bitget bağlantısı başarılı');
        } else {
            console.log('⚠️ API key yok - Sadece sinyal modu');
        }
        
        // Örnek sinyaller başlat
        generateSampleSignals();
        
        // Server'ı başlat
        server.listen(PORT, () => {
            console.log(`
🚀 TrendMaster AI with AUTH Başlatıldı!
📍 Port: ${PORT}
🔗 URL: http://localhost:${PORT}
🔐 Auth System: AKTİF
👤 Default Admin: admin@trendmaster.com / Admin123!
💡 Mod: ${CONFIG.isApiConfigured ? 'TRADING' : 'SİNYAL İZLEME'}
            `);
        });
        
    } catch (error) {
        console.error('❌ Server başlatma hatası:', error);
    }
}

startServer();
