// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

// Modüler dosyaları dahil et
const db = require('./database'); // Veritabanı bağlantısı
const authRoutes = require('./routes/auth'); // Üyelik işlemleri

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ROTALAR ---
app.use('/api', authRoutes); // /api/register ve /api/login buradan yönetilir

// --- BOT KONFİGÜRASYONU (Orijinal Koddan) ---
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),
  leverage: 10,
  marginPercent: 5,
  minConfidenceForAuto: 60,
  minVolumeUSD: 300000,
  strategies: { breakout: true, trendfollow: true, pumpdump: true },
  timeframes: ['15m', '1h', '4h'],
  minPrice: 0.05,
  focusedScanIntervalMs: 5 * 60 * 1000,
  fullSymbolRefreshMs: 15 * 60 * 1000
};

// --- GLOBAL DEĞİŞKENLER ---
let exchangeAdapter = null;
let focusedSymbols = [];
let lastMarketRefresh = 0;
const ohlcvCache = new Map();

// --- YARDIMCI FONKSİYONLAR (Helpers) ---
const H = {
  async delay(ms) { return new Promise(r => setTimeout(r, ms)); },
  round(price) {
    if (!price) return 0;
    if (price < 1) return Number(price.toFixed(5));
    return Number(price.toFixed(2));
  },
  // Borsa isteği kuyruğu (Basitleştirilmiş)
  async fetchOHLCV(symbol, timeframe, limit = 100) {
      try {
          return await exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit);
      } catch (e) { return []; }
  },
  async fetchMulti(symbol) {
      const res = {};
      for (const tf of CONFIG.timeframes) { res[tf] = await this.fetchOHLCV(symbol, tf); }
      return res;
  },
  simpleSnR(ohlcv) {
      if (!ohlcv || ohlcv.length < 30) return { support: 0, resistance: 0 };
      const highs = ohlcv.slice(-30).map(c => c[2]);
      const lows = ohlcv.slice(-30).map(c => c[3]);
      return { support: Math.min(...lows), resistance: Math.max(...highs) };
  }
};

// --- ANALİZ MOTORU (Analyzer) ---
async function analyzeSymbol(symbol) {
  // Basitleştirilmiş strateji kontrolü (Orijinal mantığın özeti)
  const multi = await H.fetchMulti(symbol);
  const o15 = multi['15m'];
  if (!o15 || o15.length < 50) return null;

  const closes = o15.map(c => c[4]);
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });
  
  if (!ema9.length || !ema21.length) return null;

  const lastE9 = ema9[ema9.length - 1];
  const lastE21 = ema21[ema21.length - 1];
  const lastRSI = rsi[rsi.length - 1];
  const price = closes[closes.length - 1];

  let strategy = null;
  let direction = null;
  let confidence = 0;

  // Örnek: Trend Follow Stratejisi
  if (lastE9 > lastE21 && lastRSI < 70 && lastRSI > 50) {
      strategy = 'trendfollow';
      direction = 'LONG';
      confidence = 75;
  } else if (lastE9 < lastE21 && lastRSI > 30 && lastRSI < 50) {
      strategy = 'trendfollow';
      direction = 'SHORT';
      confidence = 75;
  }

  if (strategy) {
      const snr = H.simpleSnR(o15);
      const tp = direction === 'LONG' ? snr.resistance : snr.support;
      
      return {
          symbol: symbol.replace('/USDT', ''),
          strategy,
          direction,
          price: H.round(price),
          tp1: H.round(tp),
          confidence
      };
  }
  return null;
}

// --- TARAMA DÖNGÜSÜ (Scanner) ---
async function scanLoop() {
  console.log("Piyasa taranıyor...");
  if (focusedSymbols.length === 0) {
      await refreshMarkets();
  }

  const batch = focusedSymbols.slice(0, 10); // İlk 10 coini tara (Demo amaçlı limit)
  
  for (const sym of batch) {
      const signal = await analyzeSymbol(sym);
      if (signal) {
          saveAndBroadcast(signal);
      }
      await H.delay(500); // Rate limit koruması
  }
}

async function refreshMarkets() {
    try {
        const tickers = await exchangeAdapter.raw.fetchTickers();
        focusedSymbols = Object.keys(tickers).filter(s => s.includes('/USDT') && tickers[s].quoteVolume > CONFIG.minVolumeUSD);
        console.log(`${focusedSymbols.length} adet coin takibe alındı.`);
    } catch (e) { console.error("Market refresh hatası:", e.message); }
}

// --- SİNYAL YÖNETİMİ ---
function saveAndBroadcast(sig) {
    // 1. Veritabanına Kaydet
    const sql = `INSERT INTO signals (id, symbol, strategy, direction, price, confidence) VALUES (?, ?, ?, ?, ?, ?)`;
    const id = `${sig.symbol}_${Date.now()}`;
    
    db.run(sql, [id, sig.symbol, sig.strategy, sig.direction, sig.price, sig.confidence], (err) => {
        if (!err) {
            console.log(`YENİ SİNYAL: ${sig.symbol} ${sig.direction}`);
            // 2. WebSocket ile Frontend'e Gönder
            broadcast();
        }
    });
}

function broadcast() {
    // Son 10 sinyali çek ve herkese gönder
    db.all("SELECT * FROM signals ORDER BY timestamp DESC LIMIT 10", (err, rows) => {
        if (!err && rows) {
            const msg = JSON.stringify({ type: 'signal_list', data: rows });
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.send(msg);
            });
        }
    });
}

// --- BAŞLANGIÇ ---
async function start() {
  // CCXT Başlat
  exchangeAdapter = { 
      raw: new ccxt.bitget({ options: { defaultType: 'swap' } }) 
  };
  
  await refreshMarkets();
  
  // Tarama döngüsünü başlat
  setInterval(scanLoop, CONFIG.focusedScanIntervalMs);
}

// WebSocket Bağlantısı
wss.on('connection', (ws) => {
    console.log('Frontend bağlandı.');
    broadcast(); // Bağlanan kişiye mevcut listeyi at
});

// Sunucuyu Dinle
server.listen(PORT, () => {
    console.log(`Server http://localhost:${PORT} üzerinde çalışıyor`);
    start();
});
