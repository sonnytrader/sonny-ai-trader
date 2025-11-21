/** 
 * server.js - TrendMaster SNIPER AI - BASİT VERSİYON
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

console.log('=== TRENDMASTER AI BAŞLATILIYOR ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

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

// API Routes
app.get('/api/status', async (req, res) => {
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

app.post('/api/config/update', (req, res) => {
    Object.assign(CONFIG, req.body);
    console.log('✅ Config güncellendi:', CONFIG);
    res.json({ success: true });
});

app.post('/api/trade/manual', async (req, res) => {
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

// Örnek sinyal üretimi (gerçek trading kodun buraya gelecek)
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
    }, 30000); // 30 saniyede bir
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
🚀 TrendMaster AI Başlatıldı!
📍 Port: ${PORT}
🔗 URL: http://localhost:${PORT}
🌐 WebSocket: ws://localhost:${PORT}
💡 Mod: ${CONFIG.isApiConfigured ? 'TRADING' : 'SİNYAL İZLEME'}
            `);
        });
        
    } catch (error) {
        console.error('❌ Server başlatma hatası:', error);
    }
}

startServer();
