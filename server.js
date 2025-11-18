// server.js
// Sonny AI TRADER — Trend Breakout (Single-Strategy) Edition
// Tek ve sağlam strateji: Trend + Destek/Direnç kırılımı (1h ana TF, 4h trend filtresi)
// @ts-nocheck

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');

// Teknik indikatörler (EMA, ATR için)
const { ATR } = require('technicalindicators');

console.log('=== SERVER BOOT (pid=' + process.pid + ') ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname))); // app.html için
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ====================== CONFIG ======================
let CONFIG = {
  // Çoklu kullanıcı senaryosu için process.env zorunlu değil — sadece sinyal üretir
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET && process.env.BITGET_PASSPHRASE),

  // Strateji ayarları
  tf_primary: '1h',           // Ana zaman dilimi
  tf_trend: '4h',             // Trend filtresi zaman dilimi
  lookback: 20,               // Destek/direnç için bakılacak mum sayısı
  minAtrPercent: 0.25,        // ATR/Price % olarak minimum volatilite filtresi
  minVolumeUSD: 100000,       // Minimum hacim filtresi

  // Tarama
  scanBatchSize: 8,
  hotCoinScanInterval: 30000,
  maxHotCoins: 12,
  signalScanIntervalMs: 20000,

  // Sistem
  debug: true
};

// ====================== GLOBALS ======================
let allSymbols = [];
let tradableSymbols = [];
let lastPriceMap = new Map();

let systemStatus = {
  isHealthy: true,
  lastError: null,
  activeSockets: 0,
  lastScan: 0
};

// Aktif trend sinyalleri (WS yayını için)
let activeTrendSignals = {}; // key: CLEAN_SYMBOL -> signal object

// ====================== UTILITIES ======================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function roundTo(n, digits = 2) {
  if (typeof n !== 'number' || !isFinite(n)) return n;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function percent(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return (a / b) * 100;
}

function cleanSymbol(s) {
  try {
    if (!s || typeof s !== 'string') return '';
    let x = s.trim().toUpperCase();
    x = x.replace(':', '/').replace('\\', '/');
    if (x.includes('/')) {
      const base = x.split('/')[0].replace(/[^A-Z0-9]/g, '');
      const quote = x.split('/')[1].replace(/[^A-Z0-9]/g, '');
      return base + quote;
    }
    return x.replace(/[^A-Z0-9]/g, '');
  } catch (e) { return (s || '').toUpperCase(); }
}

function getOriginalSymbol(clean) {
  try {
    if (!clean || typeof clean !== 'string') return '';
    const c = clean.toUpperCase();
    if (exchange && exchange.markets) {
      const found = Object.keys(exchange.markets).find(k => {
        const norm = k.toUpperCase().replace(/[^A-Z0-9]/g, '');
        return norm === c;
      });
      if (found) return found;
    }
    // fallback
    const base = c.replace('USDT', '');
    return base + '/USDT';
  } catch (e) { return clean; }
}

// ====================== EXCHANGE ======================
let exchange = null;

function createExchangeAdapter() {
  try {
    const ex = new ccxt.bitget({
      apiKey: CONFIG.apiKey,
      secret: CONFIG.secret,
      password: CONFIG.password,
      enableRateLimit: true,
      options: { defaultType: 'swap' },
      timeout: 20000
    });
    return ex;
  } catch (error) {
    console.error('Exchange create error:', error && error.message);
    return null;
  }
}

exchange = createExchangeAdapter();

async function ensureExchange() {
  if (!exchange) {
    exchange = createExchangeAdapter();
    if (!exchange) throw new Error('Exchange not initialized');
  }
}

async function safeFetchOHLCV(symbol, timeframe, limit = 100) {
  await ensureExchange();
  try {
    return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  } catch (err) {
    // normalized fallback
    const alt = getOriginalSymbol(cleanSymbol(symbol));
    if (alt && alt !== symbol) {
      return await exchange.fetchOHLCV(alt, timeframe, undefined, limit);
    }
    throw err;
  }
}

async function fetchTickerSafe(symbol) {
  await ensureExchange();
  try { return await exchange.fetchTicker(symbol); }
  catch (e) {
    const alt = getOriginalSymbol(cleanSymbol(symbol));
    try { return await exchange.fetchTicker(alt); } catch (e2) { return null; }
  }
}

function getMarketInfo(symbol) {
  const fallback = { precision: { price: 6, amount: 3 }, limits: {} };
  try {
    if (!symbol || !exchange || !exchange.markets) return fallback;
    const m = exchange.markets[symbol] || exchange.markets[getOriginalSymbol(cleanSymbol(symbol))];
    return m || fallback;
  } catch (e) { return fallback; }
}

// ====================== TREND BREAKOUT STRATEGY ======================
class TrendBreakoutStrategy {
  constructor(config) {
    this.tfPrimary = config.tf_primary || '1h';
    this.tfTrend = config.tf_trend || '4h';
    this.lookback = config.lookback || 20;
    this.minAtrPercent = config.minAtrPercent || 0.25;
  }

  // Basit EMA hesaplama
  calcEMA(values, period) {
    if (!values || values.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  async analyzeSymbol(symbol) {
    try {
      const primaryOhlcv = await safeFetchOHLCV(symbol, this.tfPrimary, this.lookback + 50);
      const trendOhlcv = await safeFetchOHLCV(symbol, this.tfTrend, 60);

      if (!primaryOhlcv || primaryOhlcv.length < this.lookback + 5) return null;
      if (!trendOhlcv || trendOhlcv.length < 20) return null;

      const closesP = primaryOhlcv.map(c => c[4]); // 1h closes
      const highsP  = primaryOhlcv.map(c => c[2]);
      const lowsP   = primaryOhlcv.map(c => c[3]);

      const lastClose = closesP.at(-1);
      const breakoutHigh = Math.max(...highsP.slice(-this.lookback));
      const breakoutLow  = Math.min(...lowsP.slice(-this.lookback));

      // 4h trend filtresi
      const closesT = trendOhlcv.map(c => c[4]);
      const emaFastTrend = this.calcEMA(closesT, 20);
      const emaSlowTrend = this.calcEMA(closesT, 50);
      const trendUp = emaFastTrend > emaSlowTrend;
      const trendDown = emaFastTrend < emaSlowTrend;

      // Volatilite filtresi (ATR/Price %)
      const atr = await this.fetchATRPercent(symbol, this.tfPrimary, 14);
      if (atr === null || atr < this.minAtrPercent) {
        if (CONFIG.debug) console.log('Volatilite düşük, sinyal yok:', symbol, 'ATR%=', atr);
        return null;
      }

      // Hacim filtresi (günlük quoteVolume)
      const t = await fetchTickerSafe(symbol);
      const quoteVol = Number(t?.quoteVolume || t?.quote_volume || t?.info?.quoteVol || 0) || 0;
      if (quoteVol < CONFIG.minVolumeUSD) {
        if (CONFIG.debug) console.log('Hacim yetersiz, sinyal yok:', symbol, 'vol=', quoteVol);
        return null;
      }

      let signal = null;
      let reason = '';
      let breakoutPrice = null;

      // Sade ve net: kırılım + trend yönü aynıysa sinyal
      if (lastClose > breakoutHigh && trendUp) {
        signal = 'LONG';
        reason = 'Direnç kırıldı, trend yukarı';
        breakoutPrice = breakoutHigh;
      } else if (lastClose < breakoutLow && trendDown) {
        signal = 'SHORT';
        reason = 'Destek kırıldı, trend aşağı';
        breakoutPrice = breakoutLow;
      }

      if (!signal) return null;

      // Confidence basit: trend + kırılım + volatilite (normalize)
      const confidenceBase = 80;
      const confidenceVolBoost = Math.min(15, Math.max(0, (atr - this.minAtrPercent) * 30));
      const confidence = Math.max(60, Math.min(95, Math.round(confidenceBase + confidenceVolBoost)));

      return {
        symbol,
        signal,
        reason,
        breakoutPrice: roundTo(breakoutPrice, 6),
        entryPrice: roundTo(lastClose, 6),
        confidence
      };
    } catch (err) {
      if (CONFIG.debug) console.error('TrendBreakoutStrategy error:', symbol, err && err.message);
      return null;
    }
  }

  async fetchATRPercent(symbol, timeframe = '1h', period = 14) {
    try {
      const ohlcv = await safeFetchOHLCV(symbol, timeframe, period + 30);
      if (!ohlcv || ohlcv.length < period + 5) return null;
      const highs = ohlcv.map(c => c[2]);
      const lows  = ohlcv.map(c => c[3]);
      const closes= ohlcv.map(c => c[4]);
      const atrVals = ATR.calculate({ high: highs, low: lows, close: closes, period });
      if (!atrVals || atrVals.length === 0) return null;
      const currentATR = atrVals.at(-1);
      const lastClose = closes.at(-1);
      if (!Number.isFinite(currentATR) || !Number.isFinite(lastClose) || lastClose <= 0) return null;
      return percent(currentATR, lastClose); // ATR / Price * 100
    } catch { return null; }
  }
}

// ====================== WATCHLIST / HOT COINS ======================
class HotCoinManager {
  constructor() {
    this.hotCoins = new Set();
    this.lastScan = 0;
  }

  async preloadMarkets() {
    try {
      await ensureExchange();
      await exchange.loadMarkets(true);
      const symbols = Object.keys(exchange.markets || {});
      allSymbols = symbols.filter(s => {
        const m = exchange.markets[s];
        if (!m || m.active === false) return false;
        if (m.quote !== 'USDT') return false;
        return true;
      });
      if (CONFIG.debug) console.log('Markets loaded, USDT symbols:', allSymbols.length);
    } catch (e) {
      console.error('preloadMarkets error:', e && e.message);
      allSymbols = [];
    }
  }

  async buildTradableUniverse() {
    try {
      const batchSize = 40;
      const good = [];
      for (let i = 0; i < allSymbols.length; i += batchSize) {
        const batch = allSymbols.slice(i, i + batchSize);
        try {
          const tickers = await exchange.fetchTickers(batch);
          for (const [sym, tk] of Object.entries(tickers || {})) {
            const vol = Number(tk?.quoteVolume || tk?.quote_volume || tk?.info?.quoteVol || 0) || 0;
            if (vol >= CONFIG.minVolumeUSD) good.push(sym);
            const last = tk?.last;
            if (Number.isFinite(last)) lastPriceMap.set(sym, last);
          }
        } catch (e) {}
        await delay(400);
      }
      tradableSymbols = Array.from(new Set(good));
      if (CONFIG.debug) console.log('Tradable symbols:', tradableSymbols.length);
    } catch (e) {
      console.error('buildTradableUniverse error:', e && e.message);
      tradableSymbols = [];
    }
  }

  async updateHotCoins() {
    try {
      const now = Date.now();
      if (now - this.lastScan < CONFIG.hotCoinScanInterval) return;
      if (allSymbols.length === 0) return;

      const batchSize = 50;
      const hot = new Set();
      for (let i = 0; i < Math.min(allSymbols.length, 300); i += batchSize) {
        const batch = allSymbols.slice(i, i + batchSize);
        try {
          const tickers = await exchange.fetchTickers(batch);
          for (const [symbol, tk] of Object.entries(tickers || {})) {
            const last = tk?.last;
            const prev = lastPriceMap.get(symbol);
            if (Number.isFinite(last)) {
              if (Number.isFinite(prev)) {
                const changePct = Math.abs(((last - prev) / prev) * 100);
                if (changePct >= 1.5) hot.add(symbol);
              }
              lastPriceMap.set(symbol, last);
            }
          }
        } catch (e) {}
        await delay(600);
      }
      this.hotCoins = new Set(Array.from(hot).slice(0, CONFIG.maxHotCoins));
      this.lastScan = now;
      if (CONFIG.debug) console.log('Hot coins updated:', this.hotCoins.size);
    } catch (e) {
      if (CONFIG.debug) console.error('updateHotCoins error:', e && e.message);
    }
  }

  getHotCoins() { return Array.from(this.hotCoins); }
}

const hotCoinManager = new HotCoinManager();
const trendStrategy = new TrendBreakoutStrategy(CONFIG);

// ====================== WS BROADCAST ======================
function broadcastTrendSignals(signals) {
  try {
    const payload = signals.map(s => ({
      symbol: s.symbol,
      signal: s.signal,
      reason: s.reason,
      breakoutPrice: s.breakoutPrice,
      entryPrice: s.entryPrice,
      confidence: s.confidence
    }));

    // cache (son 100)
    for (const s of payload) {
      const key = cleanSymbol(s.symbol);
      activeTrendSignals[key] = Object.assign({ timestamp: Date.now() }, s);
    }
    const sorted = Object.values(activeTrendSignals).sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);

    const msg = JSON.stringify({ type: 'trend_signals', data: sorted });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch (e) { try { client.terminate(); } catch {} }
      }
    });
  } catch (e) {
    if (CONFIG.debug) console.error('broadcastTrendSignals error:', e && e.message);
  }
}

// ====================== SCANNER LOOP ======================
let scanning = false;

async function runTrendScan() {
  if (scanning) return;
  scanning = true;
  try {
    if (tradableSymbols.length === 0) return;

    const hot = hotCoinManager.getHotCoins();
    const universe = (hot.length ? hot : tradableSymbols).slice(0, 200);

    const batchSize = CONFIG.scanBatchSize;
    const foundSignals = [];

    for (let i = 0; i < universe.length; i += batchSize) {
      const batch = universe.slice(i, i + batchSize);
      const promises = batch.map(async symbol => {
        try {
          const sig = await trendStrategy.analyzeSymbol(symbol);
          return sig || null;
        } catch (e) { return null; }
      });
      const results = await Promise.allSettled(promises);
      for (const r of results) if (r.status === 'fulfilled' && r.value) foundSignals.push(r.value);
      if (i + batchSize < universe.length) await delay(500);
    }

    if (foundSignals.length) {
      if (CONFIG.debug) console.log('TrendScan: signals=', foundSignals.length);
      broadcastTrendSignals(foundSignals);
    }
    systemStatus.lastScan = Date.now();
  } catch (e) {
    if (CONFIG.debug) console.error('runTrendScan error:', e && e.message);
  } finally {
    scanning = false;
  }
}

async function runSystemLoops() {
  setInterval(runTrendScan, CONFIG.signalScanIntervalMs);
  setInterval(() => hotCoinManager.updateHotCoins(), CONFIG.hotCoinScanInterval);
  console.log('System loops started');
}

// ====================== API ======================
app.get('/api/metrics', async (req, res) => {
  try {
    // Bu sürümde işlem açma yok; temel metrik stub
    res.json({
      totalEquity: 0,
      availableMargin: 0,
      unrealizedPnl: 0,
      riskRatio: 0,
      dailyTrades: 0,
      positionsCount: 0,
      dailyPL: 0,
      systemStatus
    });
  } catch (e) {
    res.status(500).json({ error: 'Metrikler alınamadı' });
  }
});

app.get('/api/config/status', async (req, res) => {
  try {
    res.json(Object.assign({}, CONFIG, {
      serverTime: new Date().toLocaleTimeString('tr-TR'),
      activeSignals: Object.keys(activeTrendSignals).length,
      hotCoins: hotCoinManager.getHotCoins().length,
      systemHealth: systemStatus
    }));
  } catch (e) {
    res.status(500).json({ error: 'Config alınamadı' });
  }
});

app.post('/api/config/update', (req, res) => {
  try {
    const allowed = ['tf_primary','tf_trend','lookback','minAtrPercent','minVolumeUSD','scanBatchSize','hotCoinScanInterval','maxHotCoins','signalScanIntervalMs','debug'];
    const updates = {};
    Object.keys(req.body || {}).forEach(k => {
      if (allowed.includes(k) && CONFIG.hasOwnProperty(k)) {
        const v = req.body[k];
        const t = typeof CONFIG[k];
        if (t === 'number') CONFIG[k] = Math.max(0, Math.min(10000000, parseFloat(v)));
        else if (t === 'string') CONFIG[k] = String(v);
        else if (t === 'boolean') CONFIG[k] = (v === true || v === 'true');
        else CONFIG[k] = v;
        updates[k] = CONFIG[k];
      }
    });
    res.json({ success: true, message: 'Ayarlar güncellendi', updates });
  } catch (e) { res.status(500).json({ success: false, message: 'Ayarlar güncellenemedi' }); }
});

// Basit ana sayfa
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));

// ====================== WEBSOCKET ======================
wss.on('connection', ws => {
  console.log('WS: client connected');
  systemStatus.activeSockets = wss.clients.size;

  try {
    const sorted = Object.values(activeTrendSignals).sort((a,b)=>b.timestamp-a.timestamp).slice(0,50);
    ws.send(JSON.stringify({ type: 'trend_signals', data: sorted }));
    ws.send(JSON.stringify({ type: 'system_status', data: systemStatus }));
  } catch (e) {
    if (CONFIG.debug) console.error('WS init send error', e && e.message);
  }

  ws.on('close', () => { systemStatus.activeSockets = wss.clients.size; });
});

// ====================== STARTUP ======================
async function start() {
  try {
    await ensureExchange();
    await hotCoinManager.preloadMarkets();
    await hotCoinManager.buildTradableUniverse();

    runSystemLoops();

    // İlk tarama
    setTimeout(() => {
      runTrendScan().catch(e => console.error('Initial TrendScan Error', e));
      hotCoinManager.updateHotCoins().catch(e => console.error('Initial HotCoin Error', e));
    }, 3000);

    console.log('🚀 Sonny AI Trader — Trend Breakout Edition aktif');
    console.log('✅ Strateji: Trend(4h EMA) + Destek/Direnç Kırılımı (1h)');
    console.log('📊 Çıkış: LONG/SHORT + Kırılım Fiyatı + Giriş Fiyatı + Confidence');
  } catch (e) {
    console.error('Startup error', e && e.message);
    systemStatus.isHealthy = false;
    systemStatus.lastError = e && e.message;
    setTimeout(start, 10000);
  }
}

// Hata yakalama
process.on('SIGINT', async () => { console.log('SIGINT'); process.exit(0); });
process.on('uncaughtException', err => {
  console.error('UNCAUGHT', err && err.message);
  systemStatus.isHealthy = false;
  systemStatus.lastError = err && err.message;
});
process.on('unhandledRejection', r => { console.error('UNHANDLED REJ', r); });

server.listen(PORT, () => {
  console.log('📡 Listening on port ' + PORT);
  start();
});
