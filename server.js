// server.js (ANA PROJE - V15.0 - SADECE 1H TREND KIRILIMI)
// SÜRÜM: V15.0 (Tüm stratejiler kaldırıldı, sadece 1H Trend Kırılımı ve hacim filtresi kaldı.)

const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const { ATR } = require('technicalindicators');

console.log("--- Sonny AI Trader - 1H Kırılımı Sunucusu başlatılıyor ---");

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// === GLOBAL DURUM DEĞİŞKENLERİ ===
let exchange;
let globalTargetList = []; // Hacim filtresinden geçen coinlerin listesi
let globalWatchlist = []; // Kullanıcının manuel takip listesi

// === SABİT VE AYARLAR ===
const PRESCAN_INTERVAL = 5 * 60 * 1000;          // 5 dakikada bir hacim taraması
const PRESCAN_MIN_24H_VOLUME_USDT = 500000;      // 500.000$ hacim barajı
const WATCHLIST_SCAN_INTERVAL = 30 * 1000;       // 30 saniyede bir Watchlist taraması
const BREAKOUT_SCAN_INTERVAL_1H = 10 * 60 * 1000; // 10 dakikada bir 1H kırılım taraması

// 1H Trend Kırılım Stratejisi Parametreleri
const CONFIG_1H = {
    tf_primary: '1h', // Kırılım zaman dilimi (1H)
    tf_trend: '4h',   // Trend zaman dilimi (4H)
    lookback: 20,     // Kırılım için geri bakılacak mum sayısı (20)
    minAtrPercent: 0.25, // Minimum volatilite %
    minConfidence: 80, // Minimum sinyal güveni
    minRiskReward: 1.5, // Minimum risk/kazanç oranı
    debug: true
};

// === STRATEJİ SINIFLARI ve BAĞIMLILIKLAR ===

/**
 * CCXT'den OHLCV verisini güvenli bir şekilde çeker.
 */
async function safeFetchOHLCV(symbol, timeframe, limit) {
    try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        return ohlcv;
    } catch (e) {
        if (CONFIG_1H.debug) console.warn(`[CCXT] ${symbol} ${timeframe} verisi çekilemedi:`, e.message);
        return null;
    }
}

/**
 * Trend Kırılımı (Destek/Direnç) stratejisi.
 * SADECE 1H kırılımına göre ayarlanmıştır.
 */
class BreakoutStrategy {
    constructor(config) { this.config = config; }

    // Basit EMA hesaplaması
    calcEMA(values, period) {
        if (!values || values.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = values[0];
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    }

    // Volatilite (ATR) hesaplaması
    async fetchATRPercent(symbol, timeframe = '1h', period = 14) {
        const ohlcv = await safeFetchOHLCV(symbol, timeframe, period + 30);
        if (!ohlcv || ohlcv.length < period + 5) return null;

        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        const closes = ohlcv.map(c => c[4]);

        const atrVals = ATR.calculate({ high: highs, low: lows, close: closes, period });
        if (!atrVals || atrVals.length === 0) return null;

        const currentATR = atrVals.at(-1);
        const lastClose = closes.at(-1);

        return { value: currentATR, percent: (currentATR / lastClose) * 100 };
    }
    
    // Ana analiz fonksiyonu
    async analyzeSymbol(symbol, config, ticker) {
        const { tf_primary, tf_trend, lookback, minAtrPercent } = config;
        const primaryOhlcv = await safeFetchOHLCV(symbol, tf_primary, lookback + 5);
        const trendOhlcv = await safeFetchOHLCV(symbol, tf_trend, 60);

        if (!primaryOhlcv || !trendOhlcv || primaryOhlcv.length < lookback || trendOhlcv.length < 50) return null;

        // 1. Trend Analizi (4h EMA20/50)
        const closesT = trendOhlcv.map(c => c[4]);
        const emaFastTrend = this.calcEMA(closesT, 20);
        const emaSlowTrend = this.calcEMA(closesT, 50);

        const trendUp = emaFastTrend > emaSlowTrend;
        const trendDown = emaFastTrend < emaSlowTrend;

        if (!trendUp && !trendDown) return null;

        // 2. Kırılım Seviyeleri (1h Lookback)
        const closesP = primaryOhlcv.map(c => c[4]);
        const highsP = primaryOhlcv.map(c => c[2]);
        const lowsP = primaryOhlcv.map(c => c[3]);

        const lastClose = closesP.at(-1);
        const breakoutHigh = Math.max(...highsP.slice(-lookback));
        const breakoutLow = Math.min(...lowsP.slice(-lookback));

        // 3. Volatilite Filtresi
        const atrData = await this.fetchATRPercent(symbol, tf_primary, 14);
        if (!atrData || atrData.percent < minAtrPercent) return null;

        const vol = Number(ticker?.quoteVolume || 0);

        // 4. Sinyal Kontrolü (Trend + Kırılım)
        let signal = null, reason = '', breakoutPrice = null;

        if (lastClose > breakoutHigh && trendUp) {
            signal = 'LONG';
            reason = `Direnç (${breakoutHigh.toFixed(8)}) yukarı kırıldı, trend ${tf_trend} grafikte YUKARI.`;
            breakoutPrice = breakoutHigh;
        }
        else if (lastClose < breakoutLow && trendDown) {
            signal = 'SHORT';
            reason = `Destek (${breakoutLow.toFixed(8)}) aşağı kırıldı, trend ${tf_trend} grafikte AŞAĞI.`;
            breakoutPrice = breakoutLow;
        }

        if (!signal) return null;
        
        // 5. Basitleştirilmiş TP/SL Hesaplaması (Risk/Reward için ATR kullan)
        const atrValue = atrData.value;
        const slMultiplier = 1.0; // SL'yi 1 ATR uzaklığa koy
        const tpMultiplier = config.minRiskReward; // TP'yi R/R'ye göre koy

        const risk = atrValue * slMultiplier;
        const reward = risk * tpMultiplier;
        
        let sl, tp;
        if (signal === 'LONG') {
            sl = lastClose - risk;
            tp = lastClose + reward;
        } else { // SHORT
            sl = lastClose + risk;
            tp = lastClose - reward;
        }

        // 6. Sinyal Objesi Oluşturma
        return {
            symbol,
            signal,
            strategy: 'BREAKOUT_1H',
            reason,
            confidence: config.minConfidence, // Basit versiyonda sabit güven
            riskReward: tpMultiplier.toFixed(1),
            entryPrice: lastClose.toFixed(8),
            breakoutPrice: breakoutPrice.toFixed(8),
            sl: sl.toFixed(8),
            tp: tp.toFixed(8),
            metrics: {
                trend: trendUp ? 'YUKARI' : 'AŞAĞI',
                ema20: emaFastTrend.toFixed(5),
                ema50: emaSlowTrend.toFixed(5),
                atrPercent: atrData.percent.toFixed(2),
                volumeUSD: vol.toFixed(0),
                tf_primary: tf_primary,
                tf_trend: tf_trend
            }
        };
    }
}

const strategy_1h = new BreakoutStrategy(CONFIG_1H);


// === TARAMA FONKSİYONLARI ===

/**
 * Hacim filtresini uygulayıp globalTargetList'i günceller.
 */
async function runPreScan() {
    try {
        const allTickers = await exchange.fetchTickers();
        if (!allTickers) return console.error('[PRESCAN] Ticker listesi çekilemedi.');

        const allSymbols = Object.keys(allTickers);
        const newTargetList = allSymbols.filter(symbol => {
            const ticker = allTickers[symbol];
            return symbol.endsWith('/USDT') &&          // Sadece USDT çiftleri
                   ticker && 
                   ticker.quoteVolume && 
                   ticker.quoteVolume >= PRESCAN_MIN_24H_VOLUME_USDT; // 500k Barajı
        });

        globalTargetList = newTargetList;
        
        if (CONFIG_1H.debug) {
            console.log(`[PRESCAN] Toplam ${allSymbols.length} coin bulundu.`);
            console.log(`[PRESCAN] Hacim filtresinden (${PRESCAN_MIN_24H_VOLUME_USDT}$) geçen: ${globalTargetList.length} coin.`);
        }
        
    } catch (e) {
        console.error('[PRESCAN] Hata:', e.message);
    }
}

/**
 * 1H Trend Kırılım Taraması
 */
async function runBreakoutScan1h() {
    if (CONFIG_1H.debug) console.log(`\n[SCAN 1H] ${globalTargetList.length} coin üzerinde 1H Kırılım taraması başlıyor...`);
    const foundSignals = [];
    
    // Tickerları tekrar çek (Hacim verisi için gerekli)
    const allTickers = await exchange.fetchTickers();
    
    for (const symbol of globalTargetList) {
        const ticker = allTickers[symbol];
        if (!ticker) continue;

        const sig = await strategy_1h.analyzeSymbol(symbol, CONFIG_1H, ticker);
        if (sig) foundSignals.push(sig);
    }
    
    if (foundSignals.length > 0) {
        if (CONFIG_1H.debug) console.log(`[SCAN 1H] ✅ ${foundSignals.length} adet yeni 1H sinyali bulundu.`);
        broadcastTrendSignals(foundSignals);
    } else {
        if (CONFIG_1H.debug) console.log(`[SCAN 1H] 🔎 Yeni 1H sinyali bulunamadı.`);
    }
}

// Watchlist taraması (Özel takip listesi) bu versiyonda sadece boş bir döngü olarak kalacaktır.
async function runWatchlistScan() {
    // Bu versiyonda aktif olarak kullanılmıyor, ancak yapıyı korumak için bırakıldı.
}

// === SOCKET IO VE YAYIN FONKSİYONLARI ===

/**
 * Yeni sinyalleri arayüze yayınlar.
 * (Tüm Breakout stratejileri tek bir kanaldan yayınlanır)
 */
function broadcastTrendSignals(signals) {
    const payload = { type: 'trend_signals', data: signals, timestamp: Date.now() };
    io.emit('signals', payload); 
    if (CONFIG_1H.debug) console.log(`[SOCKET] ${signals.length} adet sinyal arayüze yayınlandı.`);
}

// === EXPRESS ENDPOINTS (Arayüz API'leri) ===

// Statik dosyaları (app.html, css, js) sunar
app.use(express.static(path.join(__dirname)));

// === SUNUCU BAŞLANGICI ===

async function startServer() {
    // CCXT'yi başlat
    exchange = new ccxt.bitget({
        'enableRateLimit': true,
        'options': {
            'defaultType': 'swap',
        }
    });

    // Piyasaları bir kez yükle
    try {
        await exchange.loadMarkets();
    } catch (e) {
        console.error("❌ CCXT Piyasaları yüklenemedi. İnternet bağlantınızı kontrol edin. Hata:", e.message);
        process.exit(1);
    }
    
    // 1. Önce Hacim Taramasını Yap ve Hedef Listesini Doldur
    await runPreScan();

    // İlk çalıştırmada 1H taramasını yap
    if (globalTargetList.length > 0) {
        await runBreakoutScan1h();
    } else {
         console.warn("[Başlangıç] Hedef liste boş olduğu için ilk taramalar atlandı. (Piyasa hacmi düşük olabilir.)");
    }

    console.log("[Başlangıç] Periyodik tarama döngüleri ayarlanıyor...");
    
    // Sabit izleme listesi (Watchlist) ve ön tarama (PreScan) döngüleri
    setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL); 
    setInterval(runPreScan, PRESCAN_INTERVAL);
    
    // ✅ SADECE 1H Kırılım döngüsü bırakıldı
    setInterval(async () => { 
        if (globalTargetList.length > 0) await runBreakoutScan1h(); 
    }, BREAKOUT_SCAN_INTERVAL_1H);
    
    // Diğer tarama döngüleri (2H, 4H, Momentum) kaldırıldı!

    // HTTP sunucusunu başlat
    server.listen(PORT, () => {
        console.log(`\n=== SONNY AI TRADER SERVER BOOT ===`);
        console.log(`📡 Sonny AI TRADER dinleniyor, Port: ${PORT}`);
        console.log("===============================================");
        console.log(`✅ SUNUCU BAŞARIYLA BAŞLATILDI ve sadece 1H Trend Kırılımı modunda çalışıyor.`);
    });
}

startServer().catch(err => {
    console.error("ANA BAŞLANGIÇ HATASI:", err.message);
    process.exit(1);
});
