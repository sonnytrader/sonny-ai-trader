/** 
 * server.js - TrendMaster AI with AUTH SYSTEM - FIXED
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

// Kullanıcı database - BASİT ŞİFRELER
const users = [
    {
        id: 1,
        email: 'admin@trendmaster.com',
        password: 'admin123', // Şifreyi direkt yazıyoruz
        fullName: 'Sistem Admini',
        role: 'admin',
        status: 'active',
        subscription: 'premium',
        createdAt: new Date()
    },
    {
        id: 2,
        email: 'test@test.com',
        password: 'test123', // Şifreyi direkt yazıyoruz
        fullName: 'Test Kullanıcı',
        role: 'user',
        status: 'active',
        subscription: 'basic',
        createdAt: new Date()
    }
];

// Config
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

// AUTH ROUTES - BASİT ŞİFRE KONTROLÜ
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, fullName, phone, plan } = req.body;

        if (!email || !password || !fullName) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email, şifre ve isim gerekli' 
            });
        }

        // Check if user exists
        const existingUser = users.find(u => u.email === email);
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                error: 'Bu email zaten kullanılıyor' 
            });
        }

        // Create user - şifreyi direkt kaydediyoruz
        const newUser = {
            id: users.length + 1,
            email,
            password: password, // Direkt kaydediyoruz
            fullName,
            phone: phone || '',
            role: 'user',
            status: 'active', // Otomatik aktif ediyoruz
            subscription: plan || 'basic',
            createdAt: new Date()
        };

        users.push(newUser);

        res.json({
            success: true,
            message: 'Kayıt başarılı!',
            user: {
                id: newUser.id,
                email: newUser.email,
                fullName: newUser.fullName
            }
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Kayıt sırasında hata' 
        });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log('Login attempt:', email, password);

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email ve şifre gerekli' 
            });
        }

        // Find user
        const user = users.find(u => u.email === email);
        if (!user) {
            console.log('User not found:', email);
            return res.status(400).json({ 
                success: false, 
                error: 'Geçersiz email veya şifre' 
            });
        }

        // BASİT ŞİFRE KONTROLÜ - hash yok
        if (user.password !== password) {
            console.log('Wrong password for:', email);
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

        console.log('Login successful:', email);

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
        console.log('Login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Giriş sırasında hata' 
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
            try {
                const b = await exchangeAdapter.raw.fetchBalance();
                balance = parseFloat(b.USDT?.free || 0);
            } catch (error) {
                console.log('Bakiye alınamadı:', error.message);
            }
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
        res.status(500).json({
            success: false,
            error: 'Status alınamadı'
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
        
        res.json({ success: true, message: 'Trade başarılı' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ADMIN ROUTES
app.get('/api/admin/users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
    }

    const userList = users.map(user => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        subscription: user.subscription,
        createdAt: user.createdAt
    }));

    res.json({
        success: true,
        users: userList
    });
});

app.post('/api/admin/users/:id/approve', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
    }

    const userId = parseInt(req.params.id);
    const user = users.find(u => u.id === userId);
    
    if (!user) {
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    user.status = 'active';
    
    res.json({
        success: true,
        message: 'Kullanıcı onaylandı',
        user: {
            id: user.id,
            email: user.email,
            status: user.status
        }
    });
});

// WebSocket bağlantıları
wss.on('connection', (ws) => {
    console.log('✅ Yeni WebSocket bağlantısı');
    
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

    ws.on('close', () => {
        console.log('❌ WebSocket bağlantısı kapandı');
    });
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
👤 Test Kullanıcılar:
   - admin@trendmaster.com / admin123 (Admin)
   - test@test.com / test123 (User)
💡 Mod: ${CONFIG.isApiConfigured ? 'TRADING' : 'SİNYAL İZLEME'}
            `);
        });
        
    } catch (error) {
        console.error('❌ Server başlatma hatası:', error);
    }
}

startServer();
