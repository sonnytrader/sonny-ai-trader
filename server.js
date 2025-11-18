// server.js
// Sonny AI TRADER — Trend Breakout Edition (Geliştirilmiş)
// Tek strateji: Trend (EMA20/EMA50, 4h) + Destek/Direnç kırılımı (1h)

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { ATR } = require('technicalindicators');

console.log('=== SONNY AI TRADER SERVER BOOT (pid=' + process.pid + ') ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ====================== CONFIG ======================
const CONFIG = {
    tf_primary: '1h', // Kırılım zaman dilimi
    tf_trend: '4h',   // Trend zaman dilimi
    lookback: 20,     // Kırılım için geri bakılacak mum sayısı
    minAtrPercent: 0.25, // Minimum volatilite %
    minVolumeUSD: 100000, // Minimum günlük hacim
    scanBatchSize: 8, // Şu an kullanılmıyor, ileride paralel tarama için
    signalScanIntervalMs: 20000, // Tarama aralığı (20 saniye)
    debug: true
};

// ====================== EXCHANGE ======================
const exchange = new ccxt.bitget({ enableRateLimit: true });

/**
 * OHLCV verilerini güvenli bir şekilde çeker.
 */
async function safeFetchOHLCV(symbol, timeframe, limit = 100) {
    try {
        return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    } catch (e) {
        if (CONFIG.debug) console.error(`[ERROR] OHLCV çekilemedi: ${symbol} ${timeframe}`, e.message.slice(0, 50));
        return null;
    }
}

/**
 * Ticker verilerini güvenli bir şekilde çeker.
 */
async function fetchTickerSafe(symbol) {
    try {
        return await exchange.fetchTicker(symbol);
    } catch (e) {
        if (CONFIG.debug) console.error(`[ERROR] Ticker çekilemedi: ${symbol}`, e.message.slice(0, 50));
        return null;
    }
}

// ====================== STRATEGY (GELİŞTİRİLMİŞ) ======================
class TrendBreakoutStrategy {
    constructor(config) { this.config = config; }

    calcEMA(values, period) {
        if (!values || values.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = values[0];
        for (let i = 1; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }
        return ema;
    }

    async fetchATRPercent(symbol, timeframe = '1h', period = 14) {
        const ohlcv = await safeFetchOHLCV(symbol, timeframe, period + 30);
        if (!ohlcv || ohlcv.length < period + 5) return null;

        const highs = ohlcv.map(c => c[2]);
        const lows  = ohlcv.map(c => c[3]);
        const closes= ohlcv.map(c => c[4]);

        const atrVals = ATR.calculate({ high: highs, low: lows, close: closes, period });
        if (!atrVals || atrVals.length === 0) return null;

        const currentATR = atrVals.at(-1);
        const lastClose = closes.at(-1);

        return { value: currentATR, percent: (currentATR / lastClose) * 100 };
    }

    async analyzeSymbol(symbol) {
        const { tf_primary, tf_trend, lookback } = this.config;
        const primaryOhlcv = await safeFetchOHLCV(symbol, tf_primary, lookback + 5);
        const trendOhlcv = await safeFetchOHLCV(symbol, tf_trend, 60);

        if (!primaryOhlcv || !trendOhlcv || primaryOhlcv.length < lookback || trendOhlcv.length < 50) return null;

        // 1. Trend Analizi (4h)
        const closesT = trendOhlcv.map(c => c[4]);
        const emaFastTrend = this.calcEMA(closesT, 20);
        const emaSlowTrend = this.calcEMA(closesT, 50);

        const trendUp = emaFastTrend > emaSlowTrend;
        const trendDown = emaFastTrend < emaSlowTrend;

        if (!trendUp && !trendDown) return null; // Yatay piyasa filtresi

        // 2. Kırılım Seviyeleri (1h)
        const closesP = primaryOhlcv.map(c => c[4]);
        const highsP = primaryOhlcv.map(c => c[2]);
        const lowsP = primaryOhlcv.map(c => c[3]);

        const lastClose = closesP.at(-1);
        const breakoutHigh = Math.max(...highsP.slice(-lookback)); // Direnç
        const breakoutLow = Math.min(...lowsP.slice(-lookback)); // Destek

        // 3. Volatilite ve Likidite Filtreleri
        const atrData = await this.fetchATRPercent(symbol, tf_primary, 14);
        if (!atrData || atrData.percent < this.config.minAtrPercent) return null;

        const t = await fetchTickerSafe(symbol);
        const vol = Number(t?.quoteVolume || 0);
        if (vol < this.config.minVolumeUSD) return null;

        // 4. Sinyal Kontrolü (Trend + Kırılım)
        let signal = null, reason = '', breakoutPrice = null;

        // LONG Koşulu: 1H Direnç Kırılımı + 4H Trend Yukarı
        if (lastClose > breakoutHigh && trendUp) {
            signal = 'LONG';
            reason = 'Direnç kırıldı, trend yukarı';
            breakoutPrice = breakoutHigh;
        }
        // SHORT Koşulu: 1H Destek Kırılımı + 4H Trend Aşağı
        else if (lastClose < breakoutLow && trendDown) {
            signal = 'SHORT';
            reason = 'Destek kırıldı, trend aşağı';
            breakoutPrice = breakoutLow;
        }

        if (!signal) return null;

        // 5. Sinyal Objesi Oluşturma
        return {
            symbol,
            signal,
            reason,
            confidence: 90, // Yüksek güven seviyesi
            entryPrice: lastClose.toFixed(8),
            breakoutPrice: breakoutPrice.toFixed(8),
            metrics: {
                trend: trendUp ? 'YUKARI' : 'AŞAĞI',
                ema20: emaFastTrend.toFixed(5),
                ema50: emaSlowTrend.toFixed(5),
                atrPercent: atrData.percent.toFixed(2) + '%',
                volumeUSD: vol.toFixed(0),
                tf_primary: tf_primary,
                tf_trend: tf_trend
            }
        };
    }
}

const strategy = new TrendBreakoutStrategy(CONFIG);

// ====================== WS BROADCAST ======================
/**
 * WebSocket üzerinden sinyalleri yayınlar.
 */
function broadcastTrendSignals(signals) {
    const msg = JSON.stringify({ type: 'trend_signals', data: signals });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
    if (signals.length > 0 && CONFIG.debug) {
        console.log(`[SIGNAL] ${signals.length} adet sinyal bulundu.`);
    }
}

// ====================== LOOP ======================
/**
 * Belirlenen sembolleri tarar ve sinyal yayınlar.
 */
async function runTrendScan() {
    try {
        const markets = await exchange.loadMarkets();
        // Sadece ilk 30 USDT çiftini tarar (Örn: BTC/USDT, ETH/USDT, vb.)
        const symbols = Object.keys(markets).filter(s => s.endsWith('/USDT')).slice(0, 30);
        const found = [];
        
        // Sembolleri teker teker analiz et
        for (const sym of symbols) {
            const sig = await strategy.analyzeSymbol(sym);
            if (sig) found.push(sig);
        }
        
        if (found.length) broadcastTrendSignals(found);
    } catch (e) {
        console.error('Scan error:', e.message);
    }
}

// Tarama döngüsünü başlat
setInterval(runTrendScan, CONFIG.signalScanIntervalMs);

// ====================== API ======================
app.get('/api/metrics', (req, res) => res.json({ 
    system: 'Trend Breakout V1.0', 
    marketCount: Object.keys(exchange.markets || {}).length,
    scanInterval: CONFIG.signalScanIntervalMs / 1000 + 's'
}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'app.html'))); // İstemci arayüzü varsayılır

// ====================== START ======================
server.listen(PORT, () => {
    console.log('📡 Sonny AI TRADER dinleniyor, Port: ' + PORT);
    // Sunucu başlarken ilk taramayı yap
    runTrendScan();
});
