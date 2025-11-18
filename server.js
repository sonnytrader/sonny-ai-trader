// server.js - Sonny AI Trader - 1H Trend Kırılımı (DÜZELTİLMİŞ)
// CORS ve diğer bağımlılık hataları giderildi

const express = require('express');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { ATR, RSI, BollingerBands } = require('technicalindicators');

console.log("=== SONNY AI TRADER SERVER BAŞLATILIYOR ===");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// CORS middleware (basit)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// === KONFİGÜRASYON ===
const CONFIG = {
    // Exchange ayarları
    apiKey: process.env.BITGET_API_KEY || '',
    secret: process.env.BITGET_SECRET || '',
    password: process.env.BITGET_PASSPHRASE || '',
    
    // Tarama ayarları
    minVolumeUSD: 500000,
    scanInterval: 120000, // 2 dakika
    hotlistRefresh: 30 * 60 * 1000, // 30 dakika
    
    // Trading ayarları
    leverage: 10,
    marginPercent: 3,
    maxPositions: 3,
    
    // Strateji ayarları
    minRR: 1.4,
    maxSpread: 0.10,
    minConfidence: 60,
    
    // AI ayarları
    ai_enabled: false, // Ollama bağlantısı olmadığı için kapalı
    debug: true
};

// === GLOBAL DEĞİŞKENLER ===
let exchange = null;
let allSymbols = [];
let hotlist = [];
let activeSignals = {};
let openPositions = [];
let systemStatus = {
    isHealthy: true,
    lastError: null,
    lastScan: 0,
    activeSockets: 0
};

// === YARDIMCI FONKSİYONLAR ===
class Helpers {
    static delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    static cleanSymbol(symbol) {
        if (!symbol) return '';
        return symbol.toString().toUpperCase().replace('/', '').replace(':', '');
    }
    
    static toBitgetSymbol(symbol) {
        if (!symbol) return '';
        let s = symbol.toString().toUpperCase();
        if (s.includes('/')) {
            return s.split('/')[0] + 'USDT';
        }
        if (!s.endsWith('USDT')) {
            return s + 'USDT';
        }
        return s;
    }
    
    static fromBitgetSymbol(symbol) {
        if (!symbol) return '';
        let s = symbol.toString().toUpperCase();
        if (s.endsWith('USDT')) {
            return s.replace('USDT', '') + '/USDT';
        }
        return s;
    }
    
    static percentSpread(bid, ask) {
        if (!bid || !ask || bid <= 0 || ask <= 0) return 999;
        return ((ask - bid) / ((bid + ask) / 2)) * 100;
    }
    
    static roundPrice(price, precision = 6) {
        if (!price) return 0;
        const factor = Math.pow(10, precision);
        return Math.round(price * factor) / factor;
    }
    
    static calculateTrendStrength(closes, period = 20) {
        if (!closes || closes.length < period) return 0;
        try {
            const recentCloses = closes.slice(-period);
            const x = Array.from({length: recentCloses.length}, (_, i) => i);
            const n = x.length;
            const sumX = x.reduce((a, b) => a + b, 0);
            const sumY = recentCloses.reduce((a, b) => a + b, 0);
            const sumXY = x.reduce((a, _, i) => a + x[i] * recentCloses[i], 0);
            const sumXX = x.reduce((a, b) => a + b * b, 0);
            
            const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
            const avgY = sumY / n;
            const normalizedSlope = slope / avgY;
            
            return Math.max(-1, Math.min(1, normalizedSlope * 100));
        } catch {
            return 0;
        }
    }
}

// === EXCHANGE BAĞLANTISI ===
async function initializeExchange() {
    try {
        exchange = new ccxt.bitget({
            apiKey: CONFIG.apiKey,
            secret: CONFIG.secret,
            password: CONFIG.password,
            enableRateLimit: true,
            options: {
                defaultType: 'swap'
            }
        });
        
        await exchange.loadMarkets();
        console.log('✅ Exchange bağlantısı başarılı');
        
        // Tüm USDT sembollerini al
        allSymbols = Object.keys(exchange.markets).filter(symbol => {
            const market = exchange.markets[symbol];
            return market.active && 
                   market.type === 'swap' && 
                   market.quote === 'USDT' &&
                   !symbol.includes(':') &&
                   !symbol.includes('.');
        });
        
        console.log(`✅ ${allSymbols.length} adet USDT swap sembolü bulundu`);
        return true;
    } catch (error) {
        console.error('❌ Exchange bağlantı hatası:', error.message);
        return false;
    }
}

// === HOTLIST OLUŞTURMA ===
async function buildHotlist() {
    try {
        console.log('🔥 Hotlist oluşturuluyor...');
        
        // Basit hotlist - en popüler coinler
        const popularSymbols = [
            'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT',
            'ADA/USDT', 'AVAX/USDT', 'DOT/USDT', 'LINK/USDT', 'DOGE/USDT',
            'MATIC/USDT', 'LTC/USDT', 'UNI/USDT', 'ATOM/USDT', 'FIL/USDT'
        ];
        
        // Sadece exchange'de mevcut olanları al
        const availableSymbols = popularSymbols.filter(symbol => {
            const bitgetSymbol = Helpers.toBitgetSymbol(symbol);
            return allSymbols.includes(bitgetSymbol);
        });
        
        hotlist = availableSymbols;
        console.log(`✅ Hotlist oluşturuldu: ${hotlist.length} coin`);
        
        return hotlist;
    } catch (error) {
        console.error('❌ Hotlist oluşturma hatası:', error.message);
        // Fallback hotlist
        hotlist = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT'];
        return hotlist;
    }
}

// === TEKNİK ANALİZ FONKSİYONLARI ===
async function fetchOHLCV(symbol, timeframe = '1h', limit = 50) {
    try {
        const bitgetSymbol = Helpers.toBitgetSymbol(symbol);
        const ohlcv = await exchange.fetchOHLCV(bitgetSymbol, timeframe, undefined, limit);
        return ohlcv;
    } catch (error) {
        if (CONFIG.debug) console.log(`OHLCV hatası ${symbol}:`, error.message);
        return null;
    }
}

async function calculateIndicators(symbol) {
    try {
        const ohlcv = await fetchOHLCV(symbol, '1h', 50);
        if (!ohlcv || ohlcv.length < 30) return null;
        
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        
        // RSI
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const rsi = rsiValues[rsiValues.length - 1];
        
        // Bollinger Bands
        const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        const bb = bbValues[bbValues.length - 1];
        
        // ATR
        const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const atr = atrValues[atrValues.length - 1];
        
        // Trend strength
        const trendStrength = Helpers.calculateTrendStrength(closes, 20);
        
        return {
            symbol,
            lastClose: closes[closes.length - 1],
            rsi,
            bbUpper: bb.upper,
            bbMiddle: bb.middle,
            bbLower: bb.lower,
            bbWidth: ((bb.upper - bb.lower) / bb.middle) * 100,
            atr,
            atrPercent: (atr / closes[closes.length - 1]) * 100,
            trendStrength,
            timestamp: Date.now()
        };
    } catch (error) {
        if (CONFIG.debug) console.log(`Indicator hatası ${symbol}:`, error.message);
        return null;
    }
}

// === SİNYAL TESPİTİ ===
async function analyzeBreakout(indicators) {
    if (!indicators) return null;
    
    const { symbol, lastClose, bbUpper, bbLower, rsi, atr, atrPercent, trendStrength } = indicators;
    
    // Minimum volatilite kontrolü
    if (atrPercent < 0.3) return null;
    
    let signal = null;
    let reason = '';
    
    // Yukarı kırılım - BB üst bandının üzerinde ve trend yukarı
    if (lastClose > bbUpper && trendStrength > 0.1 && rsi < 80) {
        signal = 'LONG';
        reason = `BB üst bandı (${bbUpper.toFixed(4)}) yukarı kırıldı, trend güçlü (${trendStrength.toFixed(2)})`;
    }
    // Aşağı kırılım - BB alt bandının altında ve trend aşağı
    else if (lastClose < bbLower && trendStrength < -0.1 && rsi > 20) {
        signal = 'SHORT';
        reason = `BB alt bandı (${bbLower.toFixed(4)}) aşağı kırıldı, trend zayıf (${trendStrength.toFixed(2)})`;
    }
    
    if (!signal) return null;
    
    // TP/SL hesaplama
    const entryPrice = lastClose;
    let tp1, tp2, sl;
    
    if (signal === 'LONG') {
        const risk = atr * 1.0;
        sl = entryPrice - risk;
        tp1 = entryPrice + (risk * 1.4);
        tp2 = entryPrice + (risk * 2.0);
    } else {
        const risk = atr * 1.0;
        sl = entryPrice + risk;
        tp1 = entryPrice - (risk * 1.4);
        tp2 = entryPrice - (risk * 2.0);
    }
    
    const riskPercent = Math.abs((sl - entryPrice) / entryPrice) * 100;
    const rewardPercent1 = Math.abs((tp1 - entryPrice) / entryPrice) * 100;
    const rrRatio = rewardPercent1 / riskPercent;
    
    if (rrRatio < CONFIG.minRR) {
        if (CONFIG.debug) console.log(`RR oranı düşük: ${symbol} RR=${rrRatio.toFixed(2)}`);
        return null;
    }
    
    // Confidence hesaplama
    let confidence = 60; // base confidence
    confidence += Math.min(20, trendStrength * 10); // trend gücü
    confidence += Math.min(10, (atrPercent - 0.3) * 10); // volatilite
    confidence = Math.min(95, Math.max(40, confidence));
    
    return {
        coin: Helpers.cleanSymbol(symbol),
        ccxt_symbol: symbol,
        taraf: signal,
        tip: 'BREAKOUT',
        strategy: '1H_BREAKOUT',
        zaman_araligi: '1h',
        giris: Helpers.roundPrice(entryPrice),
        tp1: Helpers.roundPrice(tp1),
        tp2: Helpers.roundPrice(tp2),
        sl: Helpers.roundPrice(sl),
        profitPercent1: Helpers.roundPrice(rewardPercent1, 2),
        profitPercent2: Helpers.roundPrice(Math.abs((tp2 - entryPrice) / entryPrice * 100), 2),
        riskPercent: Helpers.roundPrice(riskPercent, 2),
        riskReward: rrRatio.toFixed(2),
        confidence: Math.round(confidence),
        tuyo: reason,
        hacim_durumu: 'YÜKSEK',
        hacim_analizi: `ATR: ${atrPercent.toFixed(2)}%, Trend: ${trendStrength.toFixed(2)}`,
        timestamp: Date.now()
    };
}

// === TARAMA FONKSİYONU ===
async function runScan() {
    if (!exchange || !hotlist.length) {
        console.log('⏳ Exchange veya hotlist hazır değil');
        return;
    }
    
    try {
        console.log(`🔍 ${hotlist.length} coin taranıyor...`);
        const signals = [];
        
        for (const symbol of hotlist) {
            try {
                // Ticker verisi
                const bitgetSymbol = Helpers.toBitgetSymbol(symbol);
                const ticker = await exchange.fetchTicker(bitgetSymbol);
                
                // Spread kontrolü
                const spread = Helpers.percentSpread(ticker.bid, ticker.ask);
                if (spread > CONFIG.maxSpread) continue;
                
                // Hacim kontrolü
                const volume = ticker.quoteVolume || 0;
                if (volume < CONFIG.minVolumeUSD) continue;
                
                // Teknik göstergeler
                const indicators = await calculateIndicators(symbol);
                if (!indicators) continue;
                
                // Sinyal analizi
                const signal = await analyzeBreakout(indicators);
                if (signal) {
                    signals.push(signal);
                    console.log(`🎯 Sinyal bulundu: ${signal.coin} ${signal.taraf} (Conf: ${signal.confidence}%)`);
                }
                
                await Helpers.delay(100); // Rate limit
            } catch (error) {
                if (CONFIG.debug) console.log(`Tarama hatası ${symbol}:`, error.message);
            }
        }
        
        // Sinyalleri yayınla
        if (signals.length > 0) {
            broadcastSignals(signals);
            console.log(`✅ ${signals.length} sinyal yayınlandı`);
        } else {
            console.log('🔎 Yeni sinyal bulunamadı');
        }
        
        systemStatus.lastScan = Date.now();
        
    } catch (error) {
        console.error('❌ Tarama hatası:', error.message);
        systemStatus.lastError = error.message;
    }
}

// === WEBSOCKET YAYINI ===
function broadcastSignals(signals) {
    if (!signals || !signals.length) return;
    
    // Active signals güncelle
    signals.forEach(signal => {
        const key = Helpers.cleanSymbol(signal.coin);
        activeSignals[key] = { ...signal, timestamp: Date.now() };
    });
    
    // Eski sinyalleri temizle (30 dakikadan eski)
    const now = Date.now();
    Object.keys(activeSignals).forEach(key => {
        if (now - activeSignals[key].timestamp > 30 * 60 * 1000) {
            delete activeSignals[key];
        }
    });
    
    // WebSocket ile yayınla
    const payload = {
        type: 'breakout_signals',
        data: Object.values(activeSignals),
        timestamp: now
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(payload));
            } catch (error) {
                console.error('WS gönderme hatası:', error.message);
            }
        }
    });
}

function broadcastSystemStatus() {
    const payload = {
        type: 'system_status',
        data: {
            ...systemStatus,
            activeSignals: Object.keys(activeSignals).length,
            openPositions: openPositions.length,
            hotlistCount: hotlist.length,
            serverTime: new Date().toISOString()
        }
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(payload));
            } catch (error) {
                console.error('WS status gönderme hatası:', error.message);
            }
        }
    });
}

// === WEB SOCKET BAĞLANTI YÖNETİMİ ===
wss.on('connection', (ws) => {
    console.log('🔗 Yeni WebSocket bağlantısı');
    systemStatus.activeSockets = wss.clients.size;
    
    // İlk verileri gönder
    try {
        // Aktif sinyaller
        ws.send(JSON.stringify({
            type: 'breakout_signals',
            data: Object.values(activeSignals),
            timestamp: Date.now()
        }));
        
        // Sistem durumu
        broadcastSystemStatus();
        
        // Pozisyonlar (boş)
        ws.send(JSON.stringify({
            type: 'open_positions',
            data: openPositions,
            timestamp: Date.now()
        }));
        
    } catch (error) {
        console.error('WS ilk veri gönderme hatası:', error.message);
    }
    
    ws.on('close', () => {
        console.log('🔒 WebSocket bağlantısı kapandı');
        systemStatus.activeSockets = wss.clients.size;
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket hatası:', error.message);
    });
});

// === API ROUTES ===
app.get('/api/health', (req, res) => {
    res.json({
        status: 'running',
        exchange: exchange ? 'connected' : 'disconnected',
        symbols: allSymbols.length,
        hotlist: hotlist.length,
        activeSignals: Object.keys(activeSignals).length,
        ...systemStatus
    });
});

app.get('/api/signals', (req, res) => {
    res.json({
        success: true,
        data: Object.values(activeSignals),
        count: Object.keys(activeSignals).length
    });
});

app.get('/api/hotlist', (req, res) => {
    res.json({
        success: true,
        data: hotlist,
        count: hotlist.length
    });
});

app.post('/api/scan', async (req, res) => {
    try {
        await runScan();
        res.json({ 
            success: true, 
            message: 'Tarama tamamlandı',
            signalsFound: Object.keys(activeSignals).length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Tarama hatası: ' + error.message
        });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        data: CONFIG
    });
});

// === SUNUCU BAŞLATMA ===
async function startServer() {
    console.log('🚀 Sunucu başlatılıyor...');
    
    // Exchange bağlantısı
    const exchangeReady = await initializeExchange();
    if (!exchangeReady) {
        console.error('❌ Exchange bağlantısı olmadan devam ediliyor (demo mod)');
    }
    
    // Hotlist oluştur
    await buildHotlist();
    
    // İlk taramayı çalıştır
    if (exchangeReady && hotlist.length > 0) {
        await runScan();
    }
    
    // Periyodik taramayı başlat
    setInterval(async () => {
        if (exchange && hotlist.length > 0) {
            await runScan();
        }
    }, CONFIG.scanInterval);
    
    // Hotlist yenileme
    setInterval(async () => {
        await buildHotlist();
    }, CONFIG.hotlistRefresh);
    
    // Sistem durumu yayını
    setInterval(() => {
        broadcastSystemStatus();
    }, 10000);
    
    // HTTP sunucusunu başlat
    server.listen(PORT, () => {
        console.log('\n=========================================');
        console.log(`✅ SONNY AI TRADER BAŞLATILDI`);
        console.log(`📍 Port: ${PORT}`);
        console.log(`🔥 Hotlist: ${hotlist.length} coin`);
        console.log(`🔍 Tarama Aralığı: ${CONFIG.scanInterval / 1000}s`);
        console.log(`🤖 AI Mod: ${CONFIG.ai_enabled ? 'AÇIK' : 'KAPALI'}`);
        console.log('=========================================\n');
    });
}

// Hata yönetimi
process.on('uncaughtException', (error) => {
    console.error('❌ Beklenmeyen hata:', error);
    systemStatus.isHealthy = false;
    systemStatus.lastError = error.message;
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ İşlenmemiş promise:', reason);
});

// Sunucuyu başlat
startServer().catch(error => {
    console.error('❌ Sunucu başlatma hatası:', error);
    process.exit(1);
});
