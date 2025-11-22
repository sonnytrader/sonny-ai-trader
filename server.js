require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { EMA, RSI, MACD, SMA } = require('technicalindicators');

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
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        fullName TEXT,
        strategy TEXT DEFAULT 'breakout',
        subscription TEXT DEFAULT 'free',
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// ALPHASON CRYPTO - 3 TEKNİK STRATEJİ
const strategies = {
    // 1. KIRILIM STRATEJİSİ
    breakout: async (symbol) => {
        const exchange = new ccxt.binance();
        const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 100);
        
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        const closes = ohlcv.map(c => c[4]);
        
        // Destek/Direnç hesapla
        const resistance = Math.max(...highs.slice(-20));
        const support = Math.min(...lows.slice(-20));
        const currentPrice = closes[closes.length - 1];
        
        if (currentPrice > resistance * 0.998) {
            return { direction: 'LONG', confidence: 75 };
        } else if (currentPrice < support * 1.002) {
            return { direction: 'SHORT', confidence: 70 };
        }
        
        return null;
    },
    
    // 2. PUMP/DETECTOR  
    pumpdetect: async (symbol) => {
        const exchange = new ccxt.binance();
        const ohlcv = await exchange.fetchOHLCV(symbol, '5m', undefined, 50);
        
        const volumes = ohlcv.map(c => c[5]);
        const closes = ohlcv.map(c => c[4]);
        
        const currentVolume = volumes[volumes.length - 1];
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b) / 20;
        const priceChange = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
        
        // Ani hacim artışı + fiyat hareketi
        if (currentVolume > avgVolume * 3 && Math.abs(priceChange) > 2) {
            return { 
                direction: priceChange > 0 ? 'LONG' : 'SHORT', 
                confidence: 80 
            };
        }
        
        return null;
    },
    
    // 3. RSI+MACD KOMBO
    rsimacd: async (symbol) => {
        const exchange = new ccxt.binance();
        const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 100);
        const closes = ohlcv.map(c => c[4]);
        
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
        
        const currentMACD = macd[macd.length - 1];
        
        // Strateji kuralları
        if (currentRSI < 30 && currentMACD?.MACD > currentMACD?.signal) {
            return { direction: 'LONG', confidence: 85 };
        } else if (currentRSI > 70 && currentMACD?.MACD < currentMACD?.signal) {
            return { direction: 'SHORT', confidence: 80 };
        }
        
        return null;
    }
};

// WebSocket real-time signals
wss.on('connection', (ws) => {
    console.log('AlphaSon Crypto WebSocket connected');
    
    const sendSignals = async () => {
        const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT', 'DOT/USDT'];
        
        for (let symbol of symbols) {
            for (let strategyName in strategies) {
                const signal = await strategies[strategyName](symbol);
                if (signal) {
                    ws.send(JSON.stringify({
                        type: 'signal',
                        strategy: strategyName,
                        symbol: symbol,
                        direction: signal.direction,
                        confidence: signal.confidence,
                        timestamp: new Date()
                    }));
                }
            }
        }
    };
    
    // Her 30 saniyede bir sinyal taraması
    setInterval(sendSignals, 30000);
    sendSignals(); // İlk çalıştırma
});

// Routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/signals', async (req, res) => {
    const { strategy = 'breakout' } = req.query;
    
    const signals = [];
    const symbols = ['BTC/USDT', 'ETH/USDT', 'ADA/USDT'];
    
    for (let symbol of symbols) {
        const signal = await strategies[strategy](symbol);
        if (signal) {
            signals.push({
                symbol,
                strategy,
                ...signal,
                timestamp: new Date()
            });
        }
    }
    
    res.json({ success: true, signals });
});

// Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
🚀 ALPHASON CRYPTO - SAF TEKNİK ANALİZ SİSTEMİ
📍 Port: ${PORT}
🎯 Stratejiler: KIRILIM + PUMP/DETECTOR + RSI/MACD
💚 Renkler: Huba Yeşili + Klasik Kırmızı
    `);
});
