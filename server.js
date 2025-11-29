require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

// Database ve modüller
const database = require('./database');
const { authenticateToken, requireAdmin } = require('./middleware/auth');
const { checkSubscription } = require('./middleware/subscription');

// Routelar
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const tradingRoutes = require('./routes/trading');
const signalsRoutes = require('./routes/signals');

// Trading sistemleri
const StrategyManager = require('./strategies/strategy_manager');
const RiskManager = require('./risk/risk_manager');
const AutoTradeSystem = require('./trading/auto_trade');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global Configuration
global.CONFIG = {
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
    optimalTradingHours: [7, 8, 9, 13, 14, 15, 19, 20, 21],
    pumpVolumeRatio: 2.0,
    pumpPriceChange: 0.015,
    pumpCooldownMs: 10 * 60 * 1000
};

// Global Variables
global.publicExchange = new (require('ccxt').bitget)({
    options: { defaultType: 'swap' },
    timeout: 30000,
    enableRateLimit: true
});

global.focusedSymbols = [];
global.cachedHighVol = [];
global.lastMarketRefresh = 0;
global.signalHistory = new Map();
global.ohlcvCache = new Map();
global.signalCache = new Map();
global.userConnections = new Map();
global.SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

global.systemStatus = {
    isHealthy: true,
    filterCount: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// Request Queue
global.requestQueue = {
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

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', authenticateToken, userRoutes);
app.use('/api/admin', authenticateToken, requireAdmin, adminRoutes);
app.use('/api/trading', authenticateToken, checkSubscription, tradingRoutes);
app.use('/api/signals', authenticateToken, checkSubscription, signalsRoutes);

// WebSocket connection
wss.on('connection', (ws, req) => {
    const token = new URLSearchParams(req.url.split('?')[1]).get('token');
    
    if (!token) {
        ws.close(1008, 'Token required');
        return;
    }

    // Kullanıcı doğrulama ve WS bağlantısını yönetme
    // (Mevcut WS kodunuz buraya gelecek)
});

// Cache temizleme
function cleanupOldCache() {
    const now = Date.now();
    const CACHE_MAX_AGE = 60 * 60 * 1000;
    
    for (const [key, value] of global.ohlcvCache.entries()) {
        if (now - value.ts > CACHE_MAX_AGE) {
            global.ohlcvCache.delete(key);
        }
    }
    
    for (const [symbol, timestamp] of global.signalHistory.entries()) {
        if (now - timestamp > 2 * 60 * 60 * 1000) {
            global.signalHistory.delete(symbol);
        }
    }
    
    for (const [key, value] of global.signalCache.entries()) {
        if (now - value.timestamp > global.SIGNAL_CACHE_DURATION) {
            global.signalCache.delete(key);
        }
    }
    
    console.log(`🧹 Cache temizlendi - OHLCV: ${global.ohlcvCache.size}, Sinyal Tarihçe: ${global.signalHistory.size}`);
}

setInterval(cleanupOldCache, 30 * 60 * 1000);

// Sunucuyu başlat
server.listen(PORT, () => {
    console.log(`🚀 AlphaSon Trade Bot ${PORT} portunda çalışıyor`);
    console.log(`📊 Modüler yapı aktif`);
});
