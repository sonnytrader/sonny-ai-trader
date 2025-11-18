// server.js - Sonny AI Trader - 1H Trend Kırılımı (TAM ve ÇALIŞAN)
const express = require('express');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { ATR } = require('technicalindicators');

console.log("=== SONNY AI TRADER SERVER BAŞLATILIYOR ===");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// CORS middleware
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
    // Tarama ayarları
    minVolumeUSD: 500000,
    scanInterval: 2 * 60 * 1000, // 2 dakika
    hotlistRefresh: 30 * 60 * 1000, // 30 dakika
    
    // Strateji ayarları
    minRR: 1.4,
    maxSpread: 0.10,
    minConfidence: 60,
    minAtrPercent: 0.3,
    
    // Debug
    debug: true
};

// === GLOBAL DEĞİŞKENLER ===
let exchange = null;
let allSymbols = [];
let hotlist = [];
let activeSignals = {};
let systemStatus = {
    isHealthy: true,
    lastError: null,
    lastScan: 0,
    activeSockets: 0,
    totalScans: 0
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
}

// === EXCHANGE BAĞLANTISI ===
async function initializeExchange() {
    try {
        exchange = new ccxt.bitget({
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
        console.log('📋 Coinler:', hotlist);
        
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

async function calculateATR(symbol, timeframe = '1h', period = 14) {
    try {
        const ohlcv = await fetchOHLCV(symbol, timeframe, period + 10);
        if (!ohlcv || ohlcv.length < period) return null;
        
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        const closes = ohlcv.map(c => c[4]);
        
        const atrValues = ATR.calculate({ 
            high: highs, 
            low: lows, 
            close: closes, 
            period: period 
        });
        
        const currentATR = atrValues[atrValues.length - 1];
        const lastClose = closes[closes.length - 1];
        const atrPercent = (currentATR / lastClose) * 100;
        
        return {
            value: currentATR,
            percent: atrPercent
        };
    } catch (error) {
        if (CONFIG.debug) console.log(`ATR hesap hatası ${symbol}:`, error.message);
        return null;
    }
}

function calculateEMA(values, period) {
    if (!values || values.length < period) return 0;
    
    const k = 2 / (period + 1);
    let ema = values[0];
    
    for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    
    return ema;
}

// === 1H TREND KIRILIM STRATEJİSİ ===
async function analyzeBreakout(symbol) {
    try {
        // 1H ve 4H verilerini al
        const ohlcv1h = await fetchOHLCV(symbol, '1h', 25); // 20 + buffer
        const ohlcv4h = await fetchOHLCV(symbol, '4h', 55); // 50 + buffer
        
        if (!ohlcv1h || !ohlcv4h || ohlcv1h.length < 20 || ohlcv4h.length < 50) {
            return null;
        }

        // 1. TREND ANALİZİ (4H EMA20/50)
        const closes4h = ohlcv4h.map(c => c[4]);
        const ema20_4h = calculateEMA(closes4h, 20);
        const ema50_4h = calculateEMA(closes4h, 50);
        
        const trendUp = ema20_4h > ema50_4h;
        const trendDown = ema20_4h < ema50_4h;
        
        if (!trendUp && !trendDown) return null;

        // 2. KIRILIM SEVİYELERİ (1H - 20 mum)
        const highs1h = ohlcv1h.map(c => c[2]);
        const lows1h = ohlcv1h.map(c => c[3]);
        const closes1h = ohlcv1h.map(c => c[4]);
        
        const lastClose = closes1h[closes1h.length - 1];
        const lookbackHighs = highs1h.slice(-20);
        const lookbackLows = lows1h.slice(-20);
        
        const resistanceLevel = Math.max(...lookbackHighs);
        const supportLevel = Math.min(...lookbackLows);

        // 3. VOLATİLİTE FİLTRESİ (ATR)
        const atrData = await calculateATR(symbol, '1h', 14);
        if (!atrData || atrData.percent < CONFIG.minAtrPercent) {
            return null;
        }

        // 4. SİNYAL KONTROLÜ
        let signal = null;
        let reason = '';
        let breakoutPrice = null;

        if (lastClose > resistanceLevel && trendUp) {
            signal = 'LONG';
            reason = `Direnç (${resistanceLevel.toFixed(6)}) yukarı kırıldı, 4H trend YUKARI`;
            breakoutPrice = resistanceLevel;
        } else if (lastClose < supportLevel && trendDown) {
            signal = 'SHORT';
            reason = `Destek (${supportLevel.toFixed(6)}) aşağı kırıldı, 4H trend AŞAĞI`;
            breakoutPrice = supportLevel;
        }

        if (!signal) return null;

        // 5. TP/SL HESAPLAMA (ATR bazlı)
        const atrValue = atrData.value;
        const risk = atrValue * 1.0;
        const reward = risk * CONFIG.minRR;
        
        let tp1, tp2, sl;
        
        if (signal === 'LONG') {
            sl = lastClose - risk;
            tp1 = lastClose + reward;
            tp2 = lastClose + (reward * 1.5);
        } else {
            sl = lastClose + risk;
            tp1 = lastClose - reward;
            tp2 = lastClose - (reward * 1.5);
        }

        // 6. GÜVEN HESAPLAMA
        let confidence = 70; // base confidence
        
        // Trend gücü
        const trendStrength = Math.abs((ema20_4h - ema50_4h) / ema50_4h * 100);
        confidence += Math.min(15, trendStrength * 2);
        
        // Volatilite bonusu
        confidence += Math.min(10, (atrData.percent - CONFIG.minAtrPercent) * 10);
        
        confidence = Math.min(95, Math.max(50, Math.round(confidence)));

        // 7. RİSK/REWARD HESAPLAMA
        const riskPercent = Math.abs((sl - lastClose) / lastClose) * 100;
        const rewardPercent1 = Math.abs((tp1 - lastClose) / lastClose) * 100;
        const rrRatio = rewardPercent1 / riskPercent;

        if (rrRatio < CONFIG.minRR) {
            if (CONFIG.debug) console.log(`RR oranı düşük: ${symbol} RR=${rrRatio.toFixed(2)}`);
            return null;
        }

        return {
            coin: Helpers.cleanSymbol(symbol),
            ccxt_symbol: symbol,
            taraf: signal,
            tip: 'BREAKOUT_1H',
            strategy: '1H_TREND_BREAKOUT',
            zaman_araligi: '1h',
            giris: Helpers.roundPrice(lastClose),
            breakoutPrice: Helpers.roundPrice(breakoutPrice),
            tp1: Helpers.roundPrice(tp1),
            tp2: Helpers.roundPrice(tp2),
            sl: Helpers.roundPrice(sl),
            profitPercent1: Helpers.roundPrice(rewardPercent1, 2),
            profitPercent2: Helpers.roundPrice(Math.abs((tp2 - lastClose) / lastClose * 100), 2),
            riskPercent: Helpers.roundPrice(riskPercent, 2),
            riskReward: rrRatio.toFixed(2),
            confidence: confidence,
            tuyo: reason,
            hacim_durumu: 'YÜKSEK',
            hacim_analizi: `ATR: ${atrData.percent.toFixed(2)}%, Trend: ${trendUp ? 'YUKARI' : 'AŞAĞI'}`,
            metrics: {
                ema20_4h: Helpers.roundPrice(ema20_4h),
                ema50_4h: Helpers.roundPrice(ema50_4h),
                trendStrength: Helpers.roundPrice(trendStrength, 2)
            },
            timestamp: Date.now()
        };

    } catch (error) {
        if (CONFIG.debug) console.log(`Breakout analiz hatası ${symbol}:`, error.message);
        return null;
    }
}

// === TARAMA FONKSİYONU ===
async function runScan() {
    if (!exchange || !hotlist.length) {
        console.log('⏳ Exchange veya hotlist hazır değil');
        return;
    }
    
    try {
        console.log(`\n🔍 [TARAMA] ${hotlist.length} coin taranıyor...`);
        const newSignals = [];
        
        for (const symbol of hotlist) {
            try {
                if (CONFIG.debug) console.log(`   📊 Analiz: ${symbol}`);
                
                // Ticker verisi ile hacim kontrolü
                const bitgetSymbol = Helpers.toBitgetSymbol(symbol);
                const ticker = await exchange.fetchTicker(bitgetSymbol);
                
                // Spread kontrolü
                const spread = Helpers.percentSpread(ticker.bid, ticker.ask);
                if (spread > CONFIG.maxSpread) {
                    if (CONFIG.debug) console.log(`      ❌ Spread yüksek: ${spread.toFixed(2)}%`);
                    continue;
                }
                
                // Hacim kontrolü
                const volume = ticker.quoteVolume || 0;
                if (volume < CONFIG.minVolumeUSD) {
                    if (CONFIG.debug) console.log(`      ❌ Hacim düşük: $${volume.toFixed(0)}`);
                    continue;
                }
                
                // Breakout analizi
                const signal = await analyzeBreakout(symbol);
                if (signal) {
                    newSignals.push(signal);
                    console.log(`      🎯 SİNYAL: ${signal.coin} ${signal.taraf} | Conf:${signal.confidence}% | RR:${signal.riskReward}`);
                } else {
                    if (CONFIG.debug) console.log(`      🔎 Sinyal yok`);
                }
                
                await Helpers.delay(200); // Rate limit
                
            } catch (error) {
                console.log(`      ❌ Hata: ${symbol} - ${error.message}`);
            }
        }
        
        // Sinyalleri yayınla
        if (newSignals.length > 0) {
            broadcastSignals(newSignals);
            console.log(`\n✅ [SONUÇ] ${newSignals.length} yeni sinyal bulundu ve yayınlandı`);
        } else {
            console.log(`\n🔎 [SONUÇ] Yeni sinyal bulunamadı`);
        }
        
        systemStatus.lastScan = Date.now();
        systemStatus.totalScans++;
        
    } catch (error) {
        console.error('❌ Tarama hatası:', error.message);
        systemStatus.lastError = error.message;
        systemStatus.isHealthy = false;
    }
}

// === WEBSOCKET YAYINI ===
function broadcastSignals(signals) {
    if (!signals || !signals.length) return;
    
    // Active signals güncelle
    signals.forEach(signal => {
        const key = Helpers.cleanSymbol(signal.coin);
        activeSignals[key] = { 
            ...signal, 
            broadcastTime: Date.now(),
            id: `${signal.coin}_${Date.now()}`
        };
    });
    
    // Eski sinyalleri temizle (2 saatten eski)
    const now = Date.now();
    Object.keys(activeSignals).forEach(key => {
        if (now - activeSignals[key].timestamp > 2 * 60 * 60 * 1000) {
            delete activeSignals[key];
        }
    });
    
    // WebSocket ile yayınla
    const payload = {
        type: 'breakout_signals',
        data: Object.values(activeSignals),
        timestamp: now,
        count: Object.keys(activeSignals).length
    };
    
    let sentCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(payload));
                sentCount++;
            } catch (error) {
                console.error('WS gönderme hatası:', error.message);
            }
        }
    });
    
    if (CONFIG.debug) {
        console.log(`📡 [WS] ${sentCount} client'a sinyal yayınlandı`);
    }
}

function broadcastSystemStatus() {
    const payload = {
        type: 'system_status',
        data: {
            ...systemStatus,
            serverTime: new Date().toISOString(),
            activeSignalsCount: Object.keys(activeSignals).length,
            hotlistCount: hotlist.length,
            totalSymbols: allSymbols.length
        },
        timestamp: Date.now()
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
            timestamp: Date.now(),
            count: Object.keys(activeSignals).length
        }));
        
        // Sistem durumu
        broadcastSystemStatus();
        
        console.log(`📊 [WS] İlk veriler gönderildi: ${Object.keys(activeSignals).length} sinyal`);
        
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
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'running',
        version: '1.0.0',
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
        count: Object.keys(activeSignals).length,
        timestamp: Date.now()
    });
});

app.get('/api/signals/:symbol', (req, res) => {
    const symbol = Helpers.cleanSymbol(req.params.symbol);
    const signal = activeSignals[symbol];
    
    if (signal) {
        res.json({
            success: true,
            data: signal
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'Sinyal bulunamadı'
        });
    }
});

app.get('/api/hotlist', (req, res) => {
    res.json({
        success: true,
        data: hotlist,
        count: hotlist.length,
        timestamp: Date.now()
    });
});

app.post('/api/scan/now', async (req, res) => {
    try {
        console.log('🔄 Manuel tarama isteği');
        await runScan();
        res.json({ 
            success: true, 
            message: 'Manuel tarama tamamlandı',
            signalsFound: Object.keys(activeSignals).length,
            timestamp: Date.now()
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
        data: CONFIG,
        timestamp: Date.now()
    });
});

// === SUNUCU BAŞLATMA ===
async function startServer() {
    console.log('🚀 Sunucu başlatılıyor...');
    
    // Exchange bağlantısı
    const exchangeReady = await initializeExchange();
    if (!exchangeReady) {
        console.log('⚠️  Exchange bağlantısı olmadan devam ediliyor (demo mod)');
    }
    
    // Hotlist oluştur
    await buildHotlist();
    
    // İlk taramayı çalıştır
    if (exchangeReady && hotlist.length > 0) {
        setTimeout(() => {
            runScan();
        }, 3000);
    }
    
    // Periyodik taramayı başlat
    const scanInterval = setInterval(async () => {
        if (exchange && hotlist.length > 0) {
            await runScan();
        }
    }, CONFIG.scanInterval);
    
    // Hotlist yenileme
    const hotlistInterval = setInterval(async () => {
        await buildHotlist();
    }, CONFIG.hotlistRefresh);
    
    // Sistem durumu yayını
    const statusInterval = setInterval(() => {
        broadcastSystemStatus();
    }, 10000);
    
    // Temizlik
    process.on('SIGINT', () => {
        console.log('\n🛑 Sunucu kapatılıyor...');
        clearInterval(scanInterval);
        clearInterval(hotlistInterval);
        clearInterval(statusInterval);
        process.exit(0);
    });
    
    // HTTP sunucusunu başlat
    server.listen(PORT, () => {
        console.log('\n=========================================');
        console.log(`✅ SONNY AI TRADER BAŞLATILDI`);
        console.log(`📍 Port: ${PORT}`);
        console.log(`🔥 Hotlist: ${hotlist.length} coin`);
        console.log(`🔍 Tarama Aralığı: ${CONFIG.scanInterval / 1000}s`);
        console.log(`📈 Strateji: 1H Trend Kırılımı`);
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
