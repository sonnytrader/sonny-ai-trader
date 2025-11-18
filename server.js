// server.js
// Sonny AI TRADER v25.12 - Enhanced MRV & Multi-Timeframe Analysis
// Geliştirmeler: MRV threshold optimization, multi-timeframe analysis, advanced confidence calculation
// @ts-nocheck

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { BollingerBands, ATR, RSI } = require('technicalindicators');

console.log('=== SERVER BOOT (pid=' + process.pid + ') ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ====================== CONFIG ======================
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET && process.env.BITGET_PASSPHRASE),

  leverage: 10,
  marginPercent: 3,
  fixedStopLossPercent: 1.0,
  maxPositions: 3,
  maxHoldTime: 7200,

  autoTradeMomentum: false,
  autoTradeMeanReversion: false,

  momentum_min_confidence: 70,
  autoTradeMomentumVolumeLevel: 'YÜKSEK',

  // OPTIMIZED MRV THRESHOLDS
  breakout_min_confidence: 40, // 45'ten 40'a düşürüldü - daha fazla quality sinyal
  breakout_1h_lookback: 50,
  breakout_4h_lookback: 40,

  mrv_trend_filter_enabled: true,
  mrv_ema_fast: 20,
  mrv_ema_slow: 50,
  mrv_min_bb_width_percent: 1.2, // 1.5'tan 1.2'ye düşürüldü

  orderbook_min_24h_explosion: 10.0,
  orderbook_depth: 15,
  orderbook_imbalance_ratio: 2.5,
  orderbook_min_usd_wall: 10000,
  orderbook_signal_cooldown: 300,

  minVolumeUSD: 100000,
  minVolatilityScore: 35,
  minVolatility: 0.06,
  maxVolatility: 0.25,
  dailyTradeLimit: 15,

  blacklist: [],

  scanBatchSize: 8,
  maxParallelScans: 3,

  hotCoinScanInterval: 30000,
  maxHotCoins: 10,

  debug_show_metrics: true,
  volumeScorePercentileWindow: 200,
  enhanced_tpsl_logging: true
};

// ====================== GLOBALS ======================
let allSwapSymbols = [];
let breakoutTargetList = [];
let activeBreakoutSignals = {};
let activeMomentumSignals = {};
let openPositions = [];
let dailyTradeCount = 0;
let dailyPL = 0;
let lastTradeTime = 0;

let performanceMetrics = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  totalPL: 0,
  maxDrawdown: 0,
  currentDrawdown: 0,
  lastUpdate: Date.now()
};

let systemStatus = {
  isHealthy: true,
  lastError: null,
  apiLatency: 0,
  lastScan: 0,
  activeSockets: 0
};

let hotCoins = new Set();
let lastPriceData = new Map();

// ====================== REQUEST QUEUE (adaptive) ======================
const requestQueue = {
  queue: [],
  running: 0,
  concurrency: 6,
  maxConcurrency: 12,
  minConcurrency: 1,
  push(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, priority });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.next();
    });
  },
  async next() {
    if (this.running >= this.concurrency) return;
    const item = this.queue.shift();
    if (!item) return;
    this.running++;
    try {
      const r = await item.fn();
      item.resolve(r);
    } catch (e) {
      item.reject(e);
    } finally {
      this.running--;
      if (this.queue.length > 50 && this.concurrency < this.maxConcurrency) this.concurrency++;
      if (this.queue.length === 0 && this.concurrency > this.minConcurrency) this.concurrency = Math.max(this.minConcurrency, this.concurrency - 1);
      setTimeout(() => this.next(), 100);
    }
  }
};

// ====================== COOLDOWN MANAGER ======================
const cooldownManager = {
  signals: new Map(),
  addCooldown(key, durationMs = 300000) {
    try {
      const k = EnhancedHelpers.normalizeKey(key);
      this.signals.set(k, Date.now() + durationMs);
    } catch (e) {}
  },
  isInCooldown(key) {
    try {
      const k = EnhancedHelpers.normalizeKey(key);
      const expiry = this.signals.get(k);
      return expiry && Date.now() < expiry;
    } catch (e) { return false; }
  },
  cleanup() {
    const now = Date.now();
    for (const [k, e] of this.signals.entries()) if (now >= e) this.signals.delete(k);
  }
};

// ====================== EXCHANGE ADAPTER ======================
let exchangeAdapter = null;

function createExchangeAdapter() {
  try {
    const ex = new ccxt.bitget({
      apiKey: CONFIG.apiKey,
      secret: CONFIG.secret,
      password: CONFIG.password,
      enableRateLimit: true,
      sandbox: false,
      timeout: 20000,
      verbose: false
    });

    const adapt = {
      raw: ex,
      async loadMarkets(force = false) {
        try { return await ex.loadMarkets(force); } catch (e) { throw e; }
      },
      async fetchTickers(symbols) {
        try { return await ex.fetchTickers(symbols); } catch (e) {
          if (Array.isArray(symbols)) {
            const out = {};
            for (const s of symbols) {
              try { out[s] = await ex.fetchTicker(s); } catch (_) { out[s] = null; }
              await EnhancedHelpers.delay(120);
            }
            return out;
          }
          throw e;
        }
      },
      async fetchTicker(s) { return await ex.fetchTicker(s); },
      async fetchOHLCV(symbol, timeframe, since, limit) { return await ex.fetchOHLCV(symbol, timeframe, since, limit); },
      async fetchOrderBook(symbol, depth) { return await ex.fetchOrderBook(symbol, depth); },
      async fetchBalance(opts) { return await ex.fetchBalance(opts); },
      async fetchPositions() {
        try { return await ex.fetchPositions(); } catch (e) {
          try { return await ex.privateGetPosition(); } catch (e2) { throw e; }
        }
      },
      async fetchOpenOrders(symbol) {
        try { return await ex.fetchOpenOrders(symbol); } catch (e) {
          try { return await ex.fetchOpenOrders(); } catch (e2) { return []; }
        }
      },
      async createOrder(symbol, type, side, amount, price, params = {}) {
        try { return await ex.createOrder(symbol, type, side, amount, price, params); } catch (e) { throw e; }
      },
      async cancelOrder(id, symbol) {
        try { return await ex.cancelOrder(id, symbol); } catch (e) { throw e; }
      },
      async setLeverage(leverage, symbol, params = {}) {
        try { if (ex.setLeverage) return await ex.setLeverage(leverage, symbol, params); } catch (e) {}
        try { if (ex.privateLinearPostPositionLeverageSave) return await ex.privateLinearPostPositionLeverageSave({ symbol, leverage }); } catch (e) {}
        return null;
      }
    };
    return adapt;
  } catch (error) {
    console.error('Exchange create error:', error && error.message);
    return null;
  }
}

exchangeAdapter = createExchangeAdapter();

function ensureExchange() {
  if (!exchangeAdapter || !exchangeAdapter.raw) throw new Error('Exchange not initialized');
}

// ====================== HELPERS ======================
async function safeFetchOHLCV(symbol, timeframe, limit = 20) {
  try {
    ensureExchange();
    return await requestQueue.push(() => exchangeAdapter.fetchOHLCV(symbol, timeframe, undefined, limit));
  } catch (err) {
    try {
      const alt = EnhancedHelpers.getOriginalSymbol(EnhancedHelpers.cleanSymbol(symbol));
      if (alt && alt !== symbol) return await requestQueue.push(() => exchangeAdapter.fetchOHLCV(alt, timeframe, undefined, limit));
    } catch (_) {}
    throw err;
  }
}

class EnhancedHelpers {
  static cleanSymbol(symbol) {
    try {
      if (!symbol || typeof symbol !== 'string') return '';
      let s = symbol.trim();
      s = s.replace(/\s+/g, '');
      s = s.replace(':', '/').replace('//', '/').replace('\\', '/');
      if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length >= 2) {
          const base = parts[0].replace(/[:_]/g, '').toUpperCase();
          const quote = parts[1].replace(/[:_]/g, '').toUpperCase();
          return base + quote;
        }
      }
      return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    } catch (e) { return (symbol || '').toUpperCase(); }
  }

  static normalizeKey(key) {
    if (!key) return '';
    return EnhancedHelpers.cleanSymbol(String(key));
  }

  static getOriginalSymbol(cleanSymbol) {
    try {
      if (!cleanSymbol || typeof cleanSymbol !== 'string') return '';
      const c = cleanSymbol.toUpperCase();
      if (exchangeAdapter && exchangeAdapter.raw && exchangeAdapter.raw.markets) {
        const found = Object.keys(exchangeAdapter.raw.markets).find(k => {
          const mm = k.toUpperCase();
          const normalized = mm.replace(/[^A-Z0-9]/g, '');
          return normalized === c;
        });
        if (found) return found;
      }
      if (c.endsWith('USDT')) {
        const base = c.replace('USDT', '');
        return base + '/USDT';
      }
      if (!c.includes('/')) return c.replace('USDT', '') + '/USDT';
      return cleanSymbol;
    } catch (e) { return cleanSymbol; }
  }

  static getTradingViewLink(symbol) {
    try {
      if (!symbol) return 'https://www.tradingview.com/chart/';
      const clean = EnhancedHelpers.cleanSymbol(symbol).replace('USDT', '');
      return 'https://www.tradingview.com/chart/?symbol=BITGET%3A' + clean + 'USDT';
    } catch (e) { return 'https://www.tradingview.com/chart/'; }
  }

  static async delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  static getScoreLabel(score) {
    if (score >= 80) return 'YÜKSEK';
    if (score >= 60) return 'ORTA';
    if (score >= 40) return 'NORMAL';
    return 'DÜŞÜK';
  }

  static clampNumber(v, min, max) {
    if (typeof v !== 'number' || isNaN(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  static getMarketInfo(ccxtSymbol) {
    const fallback = { precision: { price: 8, amount: 3 }, limits: {} };
    try {
      if (!ccxtSymbol) return fallback;
      if (!exchangeAdapter || !exchangeAdapter.raw || !exchangeAdapter.raw.markets) return fallback;
      const m = exchangeAdapter.raw.markets[ccxtSymbol] || exchangeAdapter.raw.markets[EnhancedHelpers.getOriginalSymbol(EnhancedHelpers.cleanSymbol(ccxtSymbol))];
      if (!m) return fallback;
      return m;
    } catch (e) { return fallback; }
  }

  static roundToTick(p, market) {
    try {
      if (typeof p !== 'number' || !isFinite(p)) return 0;
      let safePr;
      if (market && market.precision && Number.isInteger(market.precision.price)) {
        safePr = Math.max(0, Math.min(12, market.precision.price));
      } else if (market && market.info && market.info.tickSize) {
        const ts = parseFloat(market.info.tickSize);
        if (!isNaN(ts) && ts > 0) {
          safePr = Math.max(0, Math.min(12, Math.round(-Math.log10(ts))));
        }
      }
      if (typeof safePr !== 'number') {
        if (p === 0) safePr = 8;
        else if (Math.abs(p) < 0.01) safePr = 8;
        else if (Math.abs(p) > 1) safePr = 4;
        else safePr = 6;
      }
      safePr = Math.max(0, Math.min(12, Math.floor(safePr)));
      const step = Math.pow(10, -safePr);
      const rounded = Math.round(p / step) * step;
      return Number(rounded.toFixed(safePr));
    } catch (e) {
      return Number(p);
    }
  }

  static percentSpread(bid, ask) {
    if (typeof bid !== 'number' || typeof ask !== 'number' || bid <= 0 || ask <= 0) return 999;
    const mid = (bid + ask) / 2;
    return ((ask - bid) / mid) * 100;
  }

  static async safeCancel(id, symbol, attempts = 3) {
    try {
      ensureExchange();
      for (let i = 0; i < attempts; i++) {
        try { return await requestQueue.push(() => exchangeAdapter.cancelOrder(id, symbol)); }
        catch (e) { if (i === attempts - 1) throw e; await EnhancedHelpers.delay(500 * (i + 1)); }
      }
    } catch (e) { throw e; }
    return false;
  }

  static async fetchATR(symbol, timeframe = '5m', lookback = 30) {
    try {
      const candles = await safeFetchOHLCV(symbol, timeframe, lookback);
      if (!candles || candles.length < 15) return null;
      const highs = candles.map(c => c[2]);
      const lows = candles.map(c => c[3]);
      const closes = candles.map(c => c[4]);
      const atrInputs = { high: highs, low: lows, close: closes, period: 14 };
      const atrResult = ATR.calculate(atrInputs);
      if (!atrResult || atrResult.length === 0) return null;
      const currentATR = atrResult[atrResult.length - 1];
      if (!Number.isFinite(currentATR) || currentATR <= 0) return null;
      return currentATR;
    } catch (e) { return null; }
  }

  static async calculateTPsFromATR(symbol, entryPrice, direction, rrRecommended) {
    try {
      const atr = await EnhancedHelpers.fetchATR(symbol, '5m', 30);
      if (!atr) return null;
      const slDistance = atr * 1.0;
      const tp1Distance = atr * rrRecommended;
      const tp2Distance = atr * rrRecommended * 1.8;
      if (direction === 'LONG') {
        return { tp1: entryPrice + tp1Distance, tp2: entryPrice + tp2Distance, sl: entryPrice - slDistance, atr };
      } else {
        return { tp1: entryPrice - tp1Distance, tp2: entryPrice - tp2Distance, sl: entryPrice + slDistance, atr };
      }
    } catch (e) { return null; }
  }

  static validatePositionSize(amount, market) {
    try {
      if (!market) return amount;
      const minAmount = (market.limits && market.limits.amount && market.limits.amount.min) ? market.limits.amount.min : 0.0001;
      const maxAmount = (market.limits && market.limits.amount && market.limits.amount.max) ? market.limits.amount.max : Infinity;
      let a = Math.max(minAmount, Math.min(maxAmount, amount));
      const precision = (market.precision && Number.isInteger(market.precision.amount)) ? market.precision.amount : 6;
      a = Math.floor(a * Math.pow(10, precision)) / Math.pow(10, precision);
      if (a < minAmount) a = minAmount;
      return a;
    } catch (e) { return amount; }
  }

  static logTPSLCalculation(symbol, entry, tp1, tp2, sl, direction, method) {
    if (!CONFIG.enhanced_tpsl_logging) return;
    try {
      const rrRatio = direction === 'LONG'
        ? ((tp1 - entry) / (entry - sl))
        : ((entry - tp1) / (sl - entry));
      console.log('TP/SL Analiz:', {
        symbol,
        direction,
        entry: (typeof entry === 'number' ? entry.toFixed(8) : entry),
        tp1: (typeof tp1 === 'number' ? tp1.toFixed(8) : tp1),
        tp2: (typeof tp2 === 'number' ? tp2.toFixed(8) : tp2),
        sl: (typeof sl === 'number' ? sl.toFixed(8) : sl),
        method,
        rrRatio: Number.isFinite(rrRatio) ? rrRatio.toFixed(3) : 'N/A'
      });
    } catch (e) {}
  }

  // GELİŞMİŞ CONFIDENCE HESAPLAMA - Advanced Scoring System
  static computeDynamicRRPolicy({ volScore = 50, bbWidth = 1.0, spreadPercent = 0.02, wallSize = 0, quoteVolume = 0, timeframe = '1h' }) {
    let baseRR = 1.2;
    
    // Timeframe-based RR adjustment - Multi-timeframe optimization
    const timeframeBoost = {
      '15m': 0.1,
      '1h': 0.0, 
      '4h': -0.1
    }[timeframe] || 0;
    baseRR += timeframeBoost;
    
    // Enhanced liquidity analysis
    const liquidityBoost = (volScore - 50) / 50;
    baseRR += Math.max(-0.4, Math.min(1.0, liquidityBoost * 0.8));
    
    // Smarter volatility adjustment
    const volPenalty = Math.min(1.5, Math.max(0, (bbWidth / 5)));
    baseRR = baseRR / (1 + volPenalty * 0.2);
    
    // Spread impact with diminishing returns
    baseRR -= Math.min(0.6, spreadPercent * 5);
    
    // Wall size impact - more aggressive for larger walls
    if (wallSize > 20000 || quoteVolume > 5000000) baseRR += 0.2;
    if (wallSize > 100000 || quoteVolume > 20000000) baseRR += 0.4;
    
    const recommendedRR = Math.max(0.8, Math.min(3.5, parseFloat(baseRR.toFixed(2))));
    const minAcceptRR = Math.max(0.6, Math.min(recommendedRR, recommendedRR - 0.3));
    
    return { recommendedRR, minAcceptRR };
  }

  // YENİ: Advanced Confidence Calculation
  static calculateAdvancedConfidence({ 
    baseConfidence = 50, 
    volScore = 50, 
    bbWidth = 1.0, 
    spreadPercent = 0.02, 
    trendStrength = 0,
    marketCondition = 'NORMAL',
    timeframe = '1h'
  }) {
    // Base components with optimized weights
    const components = {
      // Volume/Liquidity Score (25%)
      volumeComponent: Math.max(0, Math.min(25, (volScore / 100) * 25)),
      
      // Volatility Score (20%) - Narrower bands are better for MRV
      volatilityComponent: Math.max(0, Math.min(20, (Math.max(0.5, Math.min(3.0, bbWidth)) / 3.0) * 20)),
      
      // Spread Quality (15%) - Lower spread = higher confidence
      spreadComponent: Math.max(0, Math.min(15, (1 - Math.min(1, spreadPercent / 0.1)) * 15)),
      
      // Trend Strength (20%) - Stronger trends = higher confidence for momentum
      trendComponent: Math.max(0, Math.min(20, Math.abs(trendStrength) * 20)),
      
      // Market Condition (10%) - Adjust based on overall market
      marketComponent: {
        'HIGH_VOLATILITY': 6,
        'NORMAL': 8,
        'LOW_VOLATILITY': 10,
        'TRENDING': 12
      }[marketCondition] || 8,
      
      // Timeframe Factor (10%) - Multi-timeframe weighting
      timeframeComponent: {
        '15m': 6,  // Shorter TF = more noise
        '1h': 8,   // Optimal balance
        '4h': 10   // Longer TF = higher reliability
      }[timeframe] || 8
    };

    // Calculate total confidence
    let totalConfidence = Object.values(components).reduce((sum, val) => sum + val, 0);
    
    // Apply base confidence as multiplier
    totalConfidence = totalConfidence * (baseConfidence / 50);
    
    // Ensure within bounds
    return Math.max(10, Math.min(95, Math.round(totalConfidence)));
  }

  // YENİ: Trend Strength Calculation
  static calculateTrendStrength(closes, period = 20) {
    try {
      if (!closes || closes.length < period) return 0;
      
      const recentCloses = closes.slice(-period);
      const x = Array.from({length: recentCloses.length}, (_, i) => i);
      const y = recentCloses;
      
      // Simple linear regression for trend
      const n = x.length;
      const sumX = x.reduce((a, b) => a + b, 0);
      const sumY = y.reduce((a, b) => a + b, 0);
      const sumXY = x.reduce((a, _, i) => a + x[i] * y[i], 0);
      const sumXX = x.reduce((a, b) => a + b * b, 0);
      
      const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
      const avgY = sumY / n;
      
      // Normalize slope by average price
      const normalizedSlope = slope / avgY;
      
      return Math.max(-1, Math.min(1, normalizedSlope * 100));
    } catch (e) {
      return 0;
    }
  }
}

// ====================== MANIPULATION DETECTOR ======================
class ManipulationDetector {
  constructor(){
    this.recentSignals = new Map();
    this.suspiciousSymbols = new Set();
  }

  detectPumpDump(symbol, currentSignal) {
    try {
      const now = Date.now();
      const clean = EnhancedHelpers.normalizeKey(symbol);
      const prev = this.recentSignals.get(clean);
      if (prev) {
        const dt = now - prev.timestamp;
        if (dt < 300000 && prev.direction !== currentSignal.direction && prev.confidence > 70) {
          this.suspiciousSymbols.add(clean);
          return true;
        }
      }
      this.recentSignals.set(clean, {
        timestamp: now,
        direction: currentSignal.direction,
        confidence: currentSignal.confidence
      });
      return false;
    } catch (e) { return false; }
  }

  isSuspicious(symbol){
    return this.suspiciousSymbols.has(EnhancedHelpers.normalizeKey(symbol));
  }

  cleanup(){
    const now = Date.now();
    for (const [s, sig] of this.recentSignals.entries()) {
      if (now - sig.timestamp > 1800000) this.recentSignals.delete(s);
    }
    for (const s of Array.from(this.suspiciousSymbols)) {
      const ts = this.recentSignals.get(s)?.timestamp || 0;
      if (now - ts > 3600000) this.suspiciousSymbols.delete(s);
    }
  }
}

// ====================== FAST AI QUALITY FILTER ======================
class FastAiQualityFilter {
  constructor(){
    this.symbolCache = new Map();
    this.cacheTimeout = 30000;
  }

  async calculateVolumeScore(symbol) {
    try {
      ensureExchange();
      const ticker = await requestQueue.push(() => exchangeAdapter.fetchTicker(symbol));
      const dailyVolume = Number(ticker?.quoteVolume || ticker?.quote_volume || ticker?.baseVolume || ticker?.base_volume || ticker?.info?.quoteVol || 0) || 0;

      const sample = (breakoutTargetList && breakoutTargetList.length) ? breakoutTargetList.slice(0, CONFIG.volumeScorePercentileWindow) : [];
      if (sample.length > 20) {
        const vols = [];
        for (let i = 0; i < sample.length; i++) {
          try {
            const t = await requestQueue.push(() => exchangeAdapter.fetchTicker(sample[i]));
            vols.push(Number(t?.quoteVolume || t?.quote_volume || t?.info?.quoteVol || 0) || 0);
          } catch { vols.push(0); }
        }
        vols.sort((a,b)=>a-b);
        let rank = vols.findIndex(v => v >= dailyVolume);
        if (rank === -1) rank = vols.length;
        const percentile = Math.round((rank / Math.max(1, vols.length)) * 100);
        const score = Math.round(20 + (percentile / 100) * 75);
        return Math.max(0, Math.min(100, score));
      }

      if (dailyVolume < CONFIG.minVolumeUSD) return 20;
      let score = 50;
      if (dailyVolume > 1000000) score = 80;
      if (dailyVolume > 5000000) score = 90;
      if (dailyVolume > 10000000) score = 95;
      return score;
    } catch (e) {
      return 30;
    }
  }

  async preloadAllCoins() {
    try {
      ensureExchange();
      if (CONFIG.debug_show_metrics) console.log('preloadAllCoins: loading markets...');
      await requestQueue.push(() => exchangeAdapter.loadMarkets(true));
      allSwapSymbols = Object.keys(exchangeAdapter.raw.markets || {}).filter(symbol => {
        try {
          const m = exchangeAdapter.raw.markets[symbol];
          if (!m || m.active === false) return false;
          if (m && m.quote && m.quote !== 'USDT') return false;
          const cleaned = EnhancedHelpers.cleanSymbol(symbol);
          if (CONFIG.blacklist && Array.isArray(CONFIG.blacklist)) {
            if (CONFIG.blacklist.some(bl => bl && typeof bl === 'string' && cleaned.includes(bl.replace('USDT','').toUpperCase()))) return false;
          }
          return true;
        } catch { return false; }
      });
      if (CONFIG.debug_show_metrics) console.log('preloadAllCoins: allSwapSymbols=' + allSwapSymbols.length);
      const batchSize = 30;
      const high = [];
      for (let i = 0; i < allSwapSymbols.length; i += batchSize) {
        const batch = allSwapSymbols.slice(i, i + batchSize);
        try {
          const tickers = await requestQueue.push(() => exchangeAdapter.fetchTickers(batch));
          Object.values(tickers || {}).forEach(t => {
            try {
              const vol = Number(t?.quoteVolume || t?.quote_volume || t?.info?.quoteVol || 0) || 0;
              if (vol > CONFIG.minVolumeUSD) high.push(t.symbol || '');
            } catch {}
          });
        } catch (e) {}
        await EnhancedHelpers.delay(600);
      }
      breakoutTargetList = Array.from(new Set(high)).filter(Boolean);
      if (CONFIG.debug_show_metrics) console.log('preloadAllCoins: breakoutTargetList=' + breakoutTargetList.length);
    } catch (e) {
      console.error('preloadAllCoins error', e && e.message);
      allSwapSymbols = []; breakoutTargetList = [];
    }
  }

  cleanupCache(){
    const now = Date.now();
    for (const [k,v] of this.symbolCache.entries()) {
      if (now - v.timestamp > this.cacheTimeout * 5) this.symbolCache.delete(k);
    }
  }
}

// ====================== TP/SL ENSURE ======================
function ensureDistinctAndOrdered({ tp1, tp2, sl, entry, market, direction, rrFactor = 1.5 }) {
  try {
    let a = Number(tp1), b = Number(tp2), s = Number(sl), e = Number(entry);
    if (![a,b,s,e].every(Number.isFinite)) return null;
    if (!Number.isFinite(e) || e <= 0) return null;

    const toPrec = (v) => EnhancedHelpers.roundToTick(v, market);
    const rf = Math.max(1, Math.min(3, (typeof rrFactor === 'number' && isFinite(rrFactor)) ? rrFactor : 1.5));

    if (direction === 'LONG') {
      s = toPrec(Math.min(s, e * (1 - 0.005 * rf)));
      a = toPrec(Math.max(a, e * (1 + 0.002 * rf)));
      b = toPrec(Math.max(b, a * (1 + 0.001 * rf)));
    } else {
      s = toPrec(Math.max(s, e * (1 + 0.005 * rf)));
      a = toPrec(Math.min(a, e * (1 - 0.002 * rf)));
      b = toPrec(Math.min(b, a * (1 - 0.001 * rf)));
    }

    if (direction === 'LONG' && !(s < e && e < a && a < b)) return null;
    if (direction !== 'LONG' && !(b < a && a < e && e < s)) return null;

    return { tp1: a, tp2: b, sl: s };
  } catch (error) {
    console.error('TP/SL rounding error:', error);
    return null;
  }
}

// ====================== GELİŞMİŞ MEAN REVERSION PREDICTOR ======================
class FastMeanReversionPredictor {
  constructor(qf){ this.qf = qf; }

  // YENİ: Multi-timeframe Analysis
  async analyzeMultipleTimeframes(ccxtSymbol) {
    const timeframes = [
      { timeframe: '15m', bbPeriod: 20, stdDev: 2, strategyIdSuffix: 'MRV15M', weight: 0.3 },
      { timeframe: '1h', bbPeriod: 20, stdDev: 2, strategyIdSuffix: 'MRV1H', weight: 0.5 },
      { timeframe: '4h', bbPeriod: 20, stdDev: 2, strategyIdSuffix: 'MRV4H', weight: 0.2 }
    ];

    const signals = [];
    
    for (const config of timeframes) {
      try {
        const signal = await this.analyzeMeanReversion(ccxtSymbol, config);
        if (signal) {
          signal.timeframeWeight = config.weight;
          signals.push(signal);
        }
      } catch (e) {
        if (CONFIG.debug_show_metrics) console.log(`MRV ${config.timeframe} analysis error:`, e.message);
      }
    }

    // Timeframe consolidation - weighted average
    if (signals.length > 0) {
      return this.consolidateTimeframeSignals(signals);
    }
    
    return null;
  }

  // YENİ: Timeframe Signal Consolidation
  consolidateTimeframeSignals(signals) {
    if (signals.length === 0) return null;
    
    // Calculate weighted averages
    let totalWeight = 0;
    let weightedConfidence = 0;
    let weightedDirection = { LONG: 0, SHORT: 0 };
    let bestSignal = signals[0];
    let maxWeightedScore = 0;

    for (const signal of signals) {
      const weight = signal.timeframeWeight;
      totalWeight += weight;
      
      // Weighted confidence
      weightedConfidence += signal.confidence * weight;
      
      // Direction strength
      if (signal.taraf === 'LONG') {
        weightedDirection.LONG += weight * (signal.confidence / 100);
      } else {
        weightedDirection.SHORT += weight * (signal.confidence / 100);
      }
      
      // Find best signal based on weighted score
      const weightedScore = signal.confidence * weight;
      if (weightedScore > maxWeightedScore) {
        maxWeightedScore = weightedScore;
        bestSignal = signal;
      }
    }

    // Determine final direction
    const finalDirection = weightedDirection.LONG > weightedDirection.SHORT ? 'LONG' : 'SHORT';
    const directionStrength = Math.max(weightedDirection.LONG, weightedDirection.SHORT);
    
    // Adjust confidence based on direction strength and timeframe agreement
    const agreementBonus = signals.length > 1 ? Math.min(15, (signals.length - 1) * 5) : 0;
    const directionBonus = directionStrength * 10;
    
    const finalConfidence = Math.min(95, Math.round(
      (weightedConfidence / totalWeight) + agreementBonus + directionBonus
    ));

    // Only return if confidence meets threshold and direction is clear
    if (finalConfidence >= CONFIG.breakout_min_confidence && directionStrength > 0.3) {
      return {
        ...bestSignal,
        confidence: finalConfidence,
        taraf: finalDirection,
        timeframe: 'MULTI',
        strategy: 'MRV_MULTI_TF',
        analiz_notu: `Multi-TF: ${signals.length} timeframe uyumu`,
        raw_metrics: {
          ...bestSignal.raw_metrics,
          timeframeSignals: signals.length,
          directionStrength: parseFloat(directionStrength.toFixed(2)),
          agreementBonus
        }
      };
    }

    return null;
  }

  async analyzeMeanReversion(ccxtSymbol, config) {
    const { timeframe, bbPeriod, stdDev, strategyIdSuffix } = config;
    try {
      const marketInfo = EnhancedHelpers.getMarketInfo(ccxtSymbol);
      if (!marketInfo) return null;

      const fullSymbol = EnhancedHelpers.cleanSymbol(ccxtSymbol);
      const cooldownKey = fullSymbol + '-' + strategyIdSuffix;
      if (cooldownManager.isInCooldown(cooldownKey)) return null;

      let ohlcv;
      try { ohlcv = await safeFetchOHLCV(ccxtSymbol, timeframe, bbPeriod + 20); }
      catch (err) { return null; }

      if (!ohlcv || ohlcv.length < bbPeriod) return null;

      const closes = ohlcv.map(c => c[4]).filter(c => typeof c === 'number' && !isNaN(c));
      if (closes.length < bbPeriod) return null;

      const bb = BollingerBands.calculate({ values: closes, period: bbPeriod, stdDev });
      if (!bb || bb.length < 2) return null;

      const last = bb[bb.length - 1], prev = bb[bb.length - 2], lastClose = closes[closes.length - 1];
      if (!last || !prev || typeof lastClose !== 'number') return null;

      const mid = last.middle, upper = last.upper, lower = last.lower;
      if (!Number.isFinite(mid) || !Number.isFinite(upper) || !Number.isFinite(lower) || mid === upper || mid === lower) {
        return null;
      }

      let signal = 'WAIT';
      if (lastClose <= lower && prev.lower < prev.middle) signal = 'LONG';
      else if (lastClose >= upper && prev.upper > prev.middle) signal = 'SHORT';
      if (signal === 'WAIT') return null;

      const volScore = await this.qf.calculateVolumeScore(ccxtSymbol);
      const bbWidth = Math.abs((upper - lower) / (mid || 1)) * 100;
      
      // OPTIMIZED: Daha geniş BB width kabulü
      const widthBoost = Math.min(15, Math.max(0, (bbWidth - CONFIG.mrv_min_bb_width_percent) * 2)); // Boost artırıldı

      let ticker = null;
      try { ticker = await requestQueue.push(() => exchangeAdapter.fetchTicker(ccxtSymbol)); } catch (_) { ticker = null; }
      const spread = ticker ? EnhancedHelpers.percentSpread(Number(ticker.bid || 0), Number(ticker.ask || 0)) : 0;
      const quoteVol = Number(ticker?.quoteVolume || ticker?.quote_volume || ticker?.info?.quoteVol || 0) || 0;
      const wallSize = 0;

      // YENİ: Trend strength calculation
      const trendStrength = EnhancedHelpers.calculateTrendStrength(closes);
      
      // YENİ: Advanced confidence calculation
      const baseConfidence = 50 + (volScore - 50) * 0.6 + widthBoost * 1.0; // Boost multipliers optimized
      const advancedConfidence = EnhancedHelpers.calculateAdvancedConfidence({
        baseConfidence,
        volScore,
        bbWidth,
        spreadPercent: spread,
        trendStrength: Math.abs(trendStrength) / 100,
        marketCondition: bbWidth > 3 ? 'HIGH_VOLATILITY' : 'NORMAL',
        timeframe
      });

      // OPTIMIZED: Lower confidence threshold
      if (advancedConfidence < CONFIG.breakout_min_confidence) return null;

      const rrPolicy = EnhancedHelpers.computeDynamicRRPolicy({ 
        volScore: advancedConfidence, 
        bbWidth, 
        spreadPercent: spread, 
        wallSize, 
        quoteVolume: quoteVol,
        timeframe
      });

      const tpsl = await EnhancedHelpers.calculateTPsFromATR(ccxtSymbol, lastClose, signal, rrPolicy.recommendedRR);
      if (!tpsl) return null;
      let { tp1, tp2, sl, atr } = tpsl;

      const profitPercent1 = Math.abs((tp1 - lastClose) / lastClose) * 100;
      const actualRiskPercent = Math.abs((sl - lastClose) / lastClose) * 100;
      if (actualRiskPercent < 0.05 || actualRiskPercent > 6.0) return null;

      const rrReal = parseFloat((profitPercent1 / actualRiskPercent).toFixed(2));
      
      // OPTIMIZED: More flexible RR acceptance
      if (rrReal < rrPolicy.minAcceptRR * 0.9) return null; // 10% daha esnek

      let adjustedConfidence = advancedConfidence;
      if (rrReal < rrPolicy.recommendedRR) {
        adjustedConfidence = Math.round(adjustedConfidence * (0.9 + 0.1 * (rrReal / rrPolicy.recommendedRR))); // Daha az penalty
      } else {
        adjustedConfidence = Math.round(Math.min(100, adjustedConfidence + Math.min(15, (rrReal - rrPolicy.recommendedRR) * 2))); // Daha fazla bonus
      }

      // OPTIMIZED: Final confidence check with lower threshold
      if (adjustedConfidence < CONFIG.breakout_min_confidence) return null;

      const marketInfoForRounding = marketInfo;
      const rrf = rrPolicy.recommendedRR || 1.5;
      tp1 = EnhancedHelpers.roundToTick(tp1, marketInfoForRounding);
      tp2 = EnhancedHelpers.roundToTick(tp2, marketInfoForRounding);
      sl = EnhancedHelpers.roundToTick(sl, marketInfoForRounding);

      const fixed = ensureDistinctAndOrdered({
        tp1, tp2, sl, entry: lastClose, market: marketInfoForRounding, direction: signal, rrFactor: rrf
      });
      if (!fixed) return null;

      tp1 = fixed.tp1; tp2 = fixed.tp2; sl = fixed.sl;

      EnhancedHelpers.logTPSLCalculation(ccxtSymbol, lastClose, tp1, tp2, sl, signal, 'ATR_ANALYSIS_WITH_RR');

      const signalData = {
        coin: fullSymbol,
        ccxt_symbol: ccxtSymbol,
        taraf: signal,
        tip: strategyIdSuffix,
        zaman_araligi: timeframe,
        giris: lastClose,
        tp1, tp2, sl,
        profitPercent1: parseFloat(profitPercent1.toFixed(2)),
        profitPercent2: parseFloat(Math.abs((tp2 - lastClose) / lastClose * 100).toFixed(2)),
        riskPercent: parseFloat(actualRiskPercent.toFixed(2)),
        riskReward: rrReal.toString(),
        hacim_durumu: EnhancedHelpers.getScoreLabel(volScore),
        volatilite_durumu: bbWidth > 3 ? 'YÜKSEK' : 'NORMAL',
        mum_yapisi: 'ORTA',
        tuyo: timeframe + ' MRV | ' + signal + ' | R/R: ' + rrReal + ' | Conf: ' + adjustedConfidence,
        hacim_analizi: 'Skor: ' + advancedConfidence + ' | TF: ' + timeframe,
        sinyal_kategorisi: adjustedConfidence >= 70 ? 'YÜKSEK GÜVEN' : (adjustedConfidence >= 50 ? 'ORTA GÜVEN' : 'DÜŞÜK GÜVEN'),
        tv_link: EnhancedHelpers.getTradingViewLink(ccxtSymbol),
        timestamp: Date.now(),
        confidence: adjustedConfidence,
        strategy: strategyIdSuffix,
        ai_score: adjustedConfidence,
        isBreakoutSignal: true,
        isMomentumSignal: false,
        analiz_notu: 'TP/SL önerileri analiz amaçlıdır',
        raw_metrics: { 
          volScore, 
          bbWidth: parseFloat(bbWidth.toFixed(3)), 
          mid, upper, lower, atr,
          trendStrength: parseFloat(trendStrength.toFixed(2)),
          baseConfidence,
          advancedConfidence
        },
        rrReal, 
        rrPolicy
      };

      if (CONFIG.debug_show_metrics) {
        console.log('MRV Sinyal:', { 
          coin: signalData.coin, 
          confidence: signalData.confidence, 
          rrReal: signalData.rrReal,
          timeframe: timeframe,
          trendStrength: trendStrength
        });
      }

      cooldownManager.addCooldown(cooldownKey);
      return signalData;
    } catch (e) {
      if (CONFIG.debug_show_metrics) console.log('MRV Exception', e && e.message);
      return null;
    }
  }
}

// ====================== MOMENTUM PREDICTOR ======================
class UltraFastMomentumPredictor {
  constructor(qf, manip) {
    this.qf = qf;
    this.manip = manip;
    this.watchlist = new Set();
    this.maxWatchlistSize = 400;
  }

  updateWatchlist(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    for (const s of list) {
      if (this.watchlist.size >= this.maxWatchlistSize) break;
      this.watchlist.add(s);
    }
  }

  getShuffledWatchlist(limit = 200) {
    const arr = Array.from(this.watchlist);
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr.slice(0, Math.min(limit, arr.length));
  }

  analyzeImbalance(orderBook) {
    try {
      const depth = CONFIG.orderbook_depth;
      const bids = (orderBook.bids || []).slice(0, depth);
      const asks = (orderBook.asks || []).slice(0, depth);
      if (!bids.length || !asks.length) return { direction: 'WAIT', isSuspicious: false };

      const bestBid = parseFloat(bids[0][0]), bestAsk = parseFloat(asks[0][0]);
      const spreadPercent = EnhancedHelpers.percentSpread(bestBid, bestAsk);
      if (spreadPercent > 0.06) return { direction: 'WAIT', isSuspicious: false };

      const weightedUSD = (levels) => {
        let t = 0;
        for (let i = 0; i < Math.min(levels.length, 6); i++) {
          const price = parseFloat(levels[i][0]);
          const size = parseFloat(levels[i][1]);
          const w = 1 / (1 + i);
          if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
          t += price * size * w;
        }
        return t;
      };

      const bidWallUSD = weightedUSD(bids), askWallUSD = weightedUSD(asks);
      if (bidWallUSD === 0 || askWallUSD === 0) return { direction: 'WAIT', isSuspicious: false };

      let direction = 'WAIT', confidence = 0, ratio = 0, isSuspicious = false;
      if (bidWallUSD > askWallUSD * CONFIG.orderbook_imbalance_ratio && bidWallUSD >= CONFIG.orderbook_min_usd_wall) {
        direction = 'LONG'; ratio = bidWallUSD / askWallUSD;
      } else if (askWallUSD > bidWallUSD * CONFIG.orderbook_imbalance_ratio && askWallUSD >= CONFIG.orderbook_min_usd_wall) {
        direction = 'SHORT'; ratio = askWallUSD / bidWallUSD;
      }

      if (ratio === 0) return { direction: 'WAIT', isSuspicious: false };

      const rawRatio = Math.log10(1 + ratio);
      const wallNorm = Math.log10(1 + (Math.max(bidWallUSD, askWallUSD) / 1000));
      confidence = Math.round(Math.max(0, Math.min(100, 40 + rawRatio * 35 + Math.min(25, wallNorm * 6))));

      if (ratio > 4.0 || bidWallUSD > 20000 || askWallUSD > 20000) isSuspicious = true;
      const currentPrice = (bestBid + bestAsk) / 2;
      return { direction, currentPrice, confidence: parseFloat(confidence.toFixed(0)), ratio: parseFloat(ratio.toFixed(2)), wallSize: direction === 'LONG' ? bidWallUSD : askWallUSD, isSuspicious, spreadPercent: parseFloat(spreadPercent.toFixed(3)) };
    } catch (e) { return { direction: 'WAIT', isSuspicious: false }; }
  }

  async createSignalObject(ccxtSymbol, analysis) {
    try {
      const { direction, currentPrice, confidence, ratio, wallSize, isSuspicious, spreadPercent } = analysis;
      const normalized = EnhancedHelpers.cleanSymbol(ccxtSymbol);
      if (isSuspicious) {
        const s = { direction, confidence, timestamp: Date.now() };
        if (this.manip.detectPumpDump(ccxtSymbol, s)) return null;
      }
      if (confidence < CONFIG.momentum_min_confidence) return null;
      if (spreadPercent > 0.08) return null;

      let ticker = null;
      try { ticker = await requestQueue.push(() => exchangeAdapter.fetchTicker(ccxtSymbol)); } catch (_) { ticker = null; }
      const quoteVol = Number(ticker?.quoteVolume || ticker?.quote_volume || ticker?.info?.quoteVol || 0) || 0;

      const atr = await EnhancedHelpers.fetchATR(ccxtSymbol, '5m', 30);
      const bbWidthProxy = atr && currentPrice ? (atr / currentPrice * 100) : 1.0;

      // YENİ: Advanced confidence for momentum
      const advancedConfidence = EnhancedHelpers.calculateAdvancedConfidence({
        baseConfidence: confidence,
        volScore: confidence, // Use momentum confidence as volume proxy
        bbWidth: bbWidthProxy,
        spreadPercent: spreadPercent,
        trendStrength: direction === 'LONG' ? 0.3 : -0.3, // Momentum implies trend
        marketCondition: 'TRENDING',
        timeframe: '1s'
      });

      if (advancedConfidence < CONFIG.momentum_min_confidence) return null;

      const rrPolicy = EnhancedHelpers.computeDynamicRRPolicy({ 
        volScore: advancedConfidence, 
        bbWidth: bbWidthProxy, 
        spreadPercent: spreadPercent, 
        wallSize, 
        quoteVolume: quoteVol,
        timeframe: '1s'
      });

      const tpsl = await EnhancedHelpers.calculateTPsFromATR(ccxtSymbol, currentPrice, direction, rrPolicy.recommendedRR);
      if (!tpsl) return null;
      let { tp1, tp2, sl, atr: usedAtr } = tpsl;

      const profitPercent1 = Math.abs((tp1 - currentPrice) / currentPrice) * 100;
      const actualRiskPercent = Math.abs((sl - currentPrice) / currentPrice) * 100;
      if (actualRiskPercent < 0.1 || actualRiskPercent > 5.0) return null;

      const rrReal = parseFloat((profitPercent1 / actualRiskPercent).toFixed(2));
      if (rrReal < rrPolicy.minAcceptRR) return null;

      let adjustedConfidence = advancedConfidence;
      if (rrReal < rrPolicy.recommendedRR) {
        adjustedConfidence = Math.round(adjustedConfidence * (0.9 + 0.1 * (rrReal / rrPolicy.recommendedRR)));
      } else {
        adjustedConfidence = Math.round(Math.min(100, adjustedConfidence + Math.min(15, (rrReal - rrPolicy.recommendedRR) * 2)));
      }

      const marketInfo = EnhancedHelpers.getMarketInfo(ccxtSymbol);
      tp1 = EnhancedHelpers.roundToTick(tp1, marketInfo);
      tp2 = EnhancedHelpers.roundToTick(tp2, marketInfo);
      sl = EnhancedHelpers.roundToTick(sl, marketInfo);

      const fixed = ensureDistinctAndOrdered({
        tp1, tp2, sl, entry: currentPrice, market: marketInfo, direction, rrFactor: rrPolicy.recommendedRR
      });
      if (!fixed) return null;

      tp1 = fixed.tp1; tp2 = fixed.tp2; sl = fixed.sl;

      EnhancedHelpers.logTPSLCalculation(ccxtSymbol, currentPrice, tp1, tp2, sl, direction, 'MOM_ATR_RR');

      const volScore = await this.qf.calculateVolumeScore(ccxtSymbol);

      const signalData = {
        coin: EnhancedHelpers.cleanSymbol(ccxtSymbol),
        ccxt_symbol: ccxtSymbol,
        taraf: direction,
        tip: 'MOMENTUM',
        zaman_araligi: '1s',
        giris: currentPrice,
        tp1, tp2, sl,
        profitPercent1: parseFloat(profitPercent1.toFixed(2)),
        profitPercent2: parseFloat(Math.abs((tp2 - currentPrice) / currentPrice * 100).toFixed(2)),
        riskPercent: parseFloat(actualRiskPercent.toFixed(2)),
        riskReward: rrReal.toString(),
        hacim_durumu: EnhancedHelpers.getScoreLabel(adjustedConfidence),
        volatilite_durumu: 'YÜKSEK',
        mum_yapisi: 'ANLIK',
        ongoru: 'OB $' + Math.round(wallSize / 1000) + 'K' + (isSuspicious ? ' ⚠️' : ''),
        tuyo: 'MOMENTUM | ' + direction + ' | R/R: ' + rrReal + ' | Conf: ' + adjustedConfidence,
        hacim_analizi: 'Skor: ' + adjustedConfidence + '% | Denge: ' + ratio.toFixed(1) + 'x',
        sinyal_kategorisi: isSuspicious ? 'DİKKAT' : (adjustedConfidence >= 80 ? 'YÜKSEK GÜVEN' : 'ORTA GÜVEN'),
        tv_link: EnhancedHelpers.getTradingViewLink(ccxtSymbol),
        timestamp: Date.now(),
        confidence: adjustedConfidence,
        strategy: 'MOMENTUM',
        ai_score: adjustedConfidence,
        isScalpSignal: false,
        isBreakoutSignal: false,
        isMomentumSignal: true,
        analiz_notu: 'TP/SL önerileri analiz amaçlıdır',
        raw_metrics: { volScore, wallSize: parseFloat(wallSize.toFixed(2)), imbalanceRatio: ratio, spreadPercent, atr: usedAtr },
        rrReal, rrPolicy
      };

      if (CONFIG.debug_show_metrics) {
        console.log('MOM Sinyal:', { coin: signalData.coin, taraf: signalData.taraf, conf: signalData.confidence, rr: signalData.riskReward });
      }

      return signalData;
    } catch (e) {
      if (CONFIG.debug_show_metrics) console.error('MOM Exception', e && e.message);
      return null;
    }
  }
}

// ====================== RELIABLE AUTO TRADE SYSTEM ======================
class ReliableAutoTradeSystem {
  constructor(){
    this.openPositionMetadata = new Map();
    this.orderHistory = [];
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
  }

  async handleAutoTrading(signal) {
    if (!CONFIG.autoTradeMomentum && !CONFIG.autoTradeMeanReversion) return;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) return;
    if (!CONFIG.isApiConfigured) return;
    try {
      if (signal.isMomentumSignal && !CONFIG.autoTradeMomentum) return;
      if (signal.isBreakoutSignal && !CONFIG.autoTradeMeanReversion) return;
      await syncOpenPositions();
      if (openPositions.length >= CONFIG.maxPositions) return;
      if (dailyTradeCount >= CONFIG.dailyTradeLimit) return;
      const searchKey = EnhancedHelpers.cleanSymbol(signal.coin || signal.ccxt_symbol);
      const existing = openPositions.find(pos => EnhancedHelpers.cleanSymbol(pos.symbol).includes(searchKey));
      if (existing) return;
      const now = Date.now(); if (now - lastTradeTime < 30000) return;
      await this.placeTradeOrder(signal);
      this.consecutiveErrors = 0;
    } catch (e) { this.consecutiveErrors++; if (CONFIG.debug_show_metrics) console.error('AutoTrade error', e && e.message); }
  }

  async setLeverage(symbol, leverage) {
    try {
      ensureExchange();
      const safe = Math.min(leverage, 20);
      await requestQueue.push(() => exchangeAdapter.setLeverage(safe, symbol, { 'marginCoin': 'USDT', 'productType': 'UMCBL' }));
      await EnhancedHelpers.delay(500);
      return true;
    } catch (e) { throw e; }
  }

  async calculatePositionSize(signal) {
    try {
      ensureExchange();
      const balance = await requestQueue.push(() => exchangeAdapter.fetchBalance({ type: 'swap' }));
      const totalEquity = parseFloat(balance.total?.USDT ?? balance.USDT?.total ?? balance.free?.USDT ?? 0);
      if (totalEquity <= 0) throw new Error('Balance not found');
      let entryPrice = parseFloat(signal.giris);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error('Invalid entry price: ' + signal.giris);
      const market = EnhancedHelpers.getMarketInfo(signal.ccxt_symbol);
      if (!market) throw new Error('Market info not found: ' + signal.ccxt_symbol);
      entryPrice = EnhancedHelpers.roundToTick(entryPrice, market);
      const marginUsed = totalEquity * (CONFIG.marginPercent / 100);
      const totalPositionValue = marginUsed * CONFIG.leverage;
      if (totalPositionValue < 5) throw new Error('Position value too small: $' + totalPositionValue.toFixed(2));
      const coinAmount = totalPositionValue / entryPrice;
      const validated = EnhancedHelpers.validatePositionSize(coinAmount, market);
      if (validated <= 0) throw new Error('Position size zero or negative');
      const realPositionValue = validated * entryPrice;
      const realMarginUsed = realPositionValue / CONFIG.leverage;
      return { marginUsed: realMarginUsed, positionValue: realPositionValue, coinAmount: validated, entryPrice, leverage: CONFIG.leverage, riskPercent: signal.riskPercent };
    } catch (e) { if (CONFIG.debug_show_metrics) console.error('calculatePositionSize error', e && e.message); return null; }
  }

  async placeTradeOrder(signal) {
    const symbol = signal.ccxt_symbol;
    try {
      ensureExchange();
      await this.setLeverage(symbol, CONFIG.leverage);
      const positionSize = await this.calculatePositionSize(signal);
      if (!positionSize) throw new Error('Position size could not be calculated');
      if (positionSize.coinAmount <= 0) throw new Error('Position amount too small');
      const side = (String(signal.taraf).toLowerCase() === 'long') ? 'buy' : 'sell';
      const totalAmount = positionSize.coinAmount;
      const tp1Amount = Math.max(EnhancedHelpers.validatePositionSize(totalAmount * 0.6, EnhancedHelpers.getMarketInfo(symbol)), 0.0000001);
      const tp2Amount = Math.max(EnhancedHelpers.validatePositionSize(totalAmount * 0.4, EnhancedHelpers.getMarketInfo(symbol)), 0.0000001);

      let order = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          order = await requestQueue.push(() => exchangeAdapter.createOrder(symbol, 'market', side, totalAmount, undefined, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'tradeSide': 'open' }));
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await EnhancedHelpers.delay(500 * (attempt + 1));
        }
      }
      await EnhancedHelpers.delay(1500);

      const tpSlOrders = await this.placeTPnSLWithRetry(symbol, side, totalAmount, signal, tp1Amount, tp2Amount);
      const cleanSym = EnhancedHelpers.cleanSymbol(symbol);
      this.openPositionMetadata.set(cleanSym, {
        symbol: cleanSym,
        ccxt_symbol: symbol,
        entryPrice: positionSize.entryPrice,
        signal,
        orderId: order?.id || null,
        tp1_id: tpSlOrders.tp1Id,
        tp2_id: tpSlOrders.tp2Id,
        sl_id: tpSlOrders.slId,
        hasHitTP1: false,
        timestamp: Date.now(),
        size: totalAmount
      });
      dailyTradeCount++;
      lastTradeTime = Date.now();
      console.log('TRADE OPENED:', cleanSym, side, { entry: positionSize.entryPrice.toFixed(8), size: totalAmount });
      return order;
    } catch (e) {
      try {
        if (exchangeAdapter) {
          const openOrders = await requestQueue.push(() => exchangeAdapter.fetchOpenOrders(symbol));
          for (const o of openOrders || []) {
            try { await EnhancedHelpers.safeCancel(o.id, symbol); } catch (_) {}
          }
        }
      } catch (_) {}
      throw e;
    }
  }

  async placeTPnSLWithRetry(symbol, side, amount, signal, tp1Amount, tp2Amount) {
    ensureExchange();
    const market = EnhancedHelpers.getMarketInfo(symbol);
    const closeSide = side === 'buy' ? 'sell' : 'buy';
    let tp1Id = null, tp2Id = null, slId = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const slPrice = EnhancedHelpers.roundToTick(signal.sl, market);
        const slOrder = await requestQueue.push(() => exchangeAdapter.createOrder(symbol, 'stop_market', closeSide, amount, undefined, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'tradeSide': 'close', 'stopPrice': slPrice, 'triggerType': 'mark_price', 'reduceOnly': true }));
        slId = slOrder.id; break;
      } catch (stopError) {
        try {
          if (attempt < 2) {
            const slPrice = EnhancedHelpers.roundToTick(signal.sl, market);
            const slOrder = await requestQueue.push(() => exchangeAdapter.createOrder(symbol, 'limit', closeSide, amount, slPrice, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'tradeSide': 'close', 'reduceOnly': true }));
            slId = slOrder.id; break;
          }
        } catch (inner) {
          if (attempt === 2) throw new Error('SL order failed: ' + (inner && inner.message || stopError && stopError.message));
          await EnhancedHelpers.delay(500 * (attempt + 1));
        }
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tp1Price = EnhancedHelpers.roundToTick(signal.tp1, market);
        const tp1Order = await requestQueue.push(() => exchangeAdapter.createOrder(symbol, 'limit', closeSide, tp1Amount, tp1Price, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'tradeSide': 'close', 'reduceOnly': true }));
        tp1Id = tp1Order.id; break;
      } catch (e) { if (attempt === 2) throw new Error('TP1 order failed: ' + (e && e.message)); await EnhancedHelpers.delay(500 * (attempt + 1)); }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tp2Price = EnhancedHelpers.roundToTick(signal.tp2, market);
        const tp2Order = await requestQueue.push(() => exchangeAdapter.createOrder(symbol, 'limit', closeSide, tp2Amount, tp2Price, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'tradeSide': 'close', 'reduceOnly': true }));
        tp2Id = tp2Order.id; break;
      } catch (e) { if (attempt === 2) throw new Error('TP2 order failed: ' + (e && e.message)); await EnhancedHelpers.delay(500 * (attempt + 1)); }
    }

    return { tp1Id, tp2Id, slId };
  }

  async checkPositionsAndBreakeven() {
    if (!CONFIG.isApiConfigured) return;
    await syncOpenPositions();
    for (const pos of openPositions) {
      const metadata = this.openPositionMetadata.get(pos.symbol);
      if (!metadata) continue;
      try {
        const age = Date.now() - metadata.timestamp;
        if (age > CONFIG.maxHoldTime * 1000) {
          console.log('Max hold time reached for', pos.symbol, 'closing position');
          await closePosition(pos.ccxt_symbol);
        }
      } catch (e) { if (CONFIG.debug_show_metrics) console.error('checkPositions error', e && e.message); }
    }
  }
}

// ====================== HOT COIN MANAGER ======================
class HotCoinManager {
  constructor(){
    this.hotCoins = new Set();
    this.lastPriceData = new Map();
    this.lastScan = 0;
  }

  async updateHotCoins() {
    try {
      if (allSwapSymbols.length === 0) return;
      const now = Date.now();
      if (now - this.lastScan < CONFIG.hotCoinScanInterval) return;
      const batchSize = 50;
      const newHot = new Set();
      for (let i = 0; i < Math.min(allSwapSymbols.length, 200); i += batchSize) {
        const batch = allSwapSymbols.slice(i, i + batchSize);
        try {
          const tickers = await requestQueue.push(() => exchangeAdapter.fetchTickers(batch));
          for (const [symbol, ticker] of Object.entries(tickers || {})) {
            try {
              if (!ticker || typeof ticker.last !== 'number') continue;
              const cur = ticker.last;
              const last = this.lastPriceData.get(symbol);
              if (last && cur) {
                const change = Math.abs((cur - last) / last * 100);
                if (change > 2.0) newHot.add(symbol);
              }
              this.lastPriceData.set(symbol, cur);
            } catch {}
          }
        } catch (e) {}
        await EnhancedHelpers.delay(800);
      }
      this.hotCoins = new Set(Array.from(newHot).slice(0, CONFIG.maxHotCoins));
      this.lastScan = now;
    } catch (e) { if (CONFIG.debug_show_metrics) console.error('updateHotCoins error', e && e.message); }
  }

  getHotCoins() { return Array.from(this.hotCoins); }
}

// ====================== POSITION MANAGEMENT ======================
async function syncOpenPositions() {
  if (!CONFIG.isApiConfigured) return;
  try {
    ensureExchange();
    const positions = await requestQueue.push(() => exchangeAdapter.fetchPositions());
    const active = (positions || []).filter(p => Math.abs(parseFloat(p.contracts || p.amount || 0)) > 0);
    openPositions = active.map(pos => {
      const contracts = parseFloat(pos.contracts || pos.amount || 0);
      const side = contracts > 0 ? 'long' : 'short';
      const rawSymbol = pos.symbol || pos.contract || pos.info?.symbol || '';
      const clean = EnhancedHelpers.cleanSymbol(rawSymbol);
      const meta = autoTradeSystem.openPositionMetadata.get(clean);
      return {
        symbol: clean,
        ccxt_symbol: rawSymbol,
        side,
        amount: Math.abs(contracts),
        entryPrice: parseFloat(pos.entryPrice || pos.entry || pos.price || 0),
        markPrice: parseFloat(pos.markPrice || pos.mark || pos.info?.markPrice || 0),
        unrealizedPnl: parseFloat(pos.unrealizedPnl || pos.info?.unrealizedPnl || 0),
        leverage: pos.leverage || CONFIG.leverage,
        liquidationPrice: pos.liquidationPrice || pos.info?.liquidationPrice,
        timestamp: meta ? meta.timestamp : Date.now(),
        tp1: meta ? meta.signal.tp1 : null,
        sl: meta ? meta.signal.sl : null,
        hasHitTP1: meta ? meta.hasHitTP1 : false,
        signal: meta ? meta.signal : null,
        tp1_id: meta ? meta.tp1_id : null,
        tp2_id: meta ? meta.tp2_id : null,
        sl_id: meta ? meta.sl_id : null
      };
    });
    const act = new Set(openPositions.map(p => p.symbol));
    for (const [k] of autoTradeSystem.openPositionMetadata.entries()) {
      if (!act.has(k)) autoTradeSystem.openPositionMetadata.delete(k);
    }
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('syncOpenPositions error', e && e.message); }
}

async function closePosition(symbol) {
  if (!CONFIG.isApiConfigured) return;
  try {
    ensureExchange();
    const ccxtSym = EnhancedHelpers.getOriginalSymbol(EnhancedHelpers.cleanSymbol(symbol)) || symbol;
    const openOrders = await requestQueue.push(() => exchangeAdapter.fetchOpenOrders(ccxtSym));
    for (const o of openOrders || []) if ((o.symbol || '').toString() === (ccxtSym || '').toString()) await EnhancedHelpers.safeCancel(o.id, ccxtSym);
    const positions = await requestQueue.push(() => exchangeAdapter.fetchPositions());
    const pos = (positions || []).find(p => (p.symbol || '').toString() === (ccxtSym || '').toString() && Math.abs(parseFloat(p.contracts || p.amount || 0)) > 0);
    if (pos) {
      const closeSide = parseFloat(pos.contracts || pos.amount) > 0 ? 'sell' : 'buy';
      const amount = Math.abs(parseFloat(pos.contracts || pos.amount));
      await requestQueue.push(() => exchangeAdapter.createOrder(pos.symbol, 'market', closeSide, amount, undefined, { 'marginCoin': 'USDT', 'productType': 'USDT-FUTURES', 'reduceOnly': true, 'tradeSide': 'close' }));
    }
    const clean = EnhancedHelpers.cleanSymbol(symbol);
    autoTradeSystem.openPositionMetadata.delete(clean);
    await syncOpenPositions();
    console.log('POSITION CLOSED:', clean);
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('closePosition error', e && e.message); throw e; }
}

// ====================== SIGNAL BROADCAST ======================
function sanitizeForWS(obj) {
  try {
    const clone = JSON.parse(JSON.stringify(obj, (k, v) => {
      if (k === 'raw_metrics') return undefined;
      if (typeof v === 'function') return undefined;
      return v;
    }));
    return clone;
  } catch (e) {
    return null;
  }
}

function broadcastSignal(signal) {
  try {
    if (!signal) return;
    const fmt = v => (typeof v === 'number' && isFinite(v)) ? Number(v.toFixed(8)) : null;
    const formattedSignal = Object.assign({}, signal, { tp1: fmt(signal.tp1), tp2: fmt(signal.tp2), sl: fmt(signal.sl), giris: fmt(signal.giris) });
    const coinKey = EnhancedHelpers.normalizeKey(signal.coin || signal.ccxt_symbol);
    if (signal.isMomentumSignal) {
      activeMomentumSignals[coinKey] = Object.assign({ timestamp: Date.now() }, formattedSignal);
      pruneActiveSignals(activeMomentumSignals, 200);
    } else if (signal.isBreakoutSignal) {
      activeBreakoutSignals[coinKey] = Object.assign({ timestamp: Date.now() }, formattedSignal);
      pruneActiveSignals(activeBreakoutSignals, 200);
    } else return;

    const momentumPayload = Object.values(activeMomentumSignals).sort((a,b)=>b.timestamp-a.timestamp).slice(0,30).map(s => sanitizeForWS(s));
    const breakoutPayload = Object.values(activeBreakoutSignals).sort((a,b)=>b.timestamp-a.timestamp).slice(0,30).map(s => sanitizeForWS(s));

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify({ type: 'momentum_signals', data: momentumPayload }));
          client.send(JSON.stringify({ type: 'breakout_signals', data: breakoutPayload }));
        } catch (e) {
          if (CONFIG.debug_show_metrics) console.error('WS send error', e && e.message);
          try { client.terminate(); } catch {}
        }
      }
    });
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('broadcastSignal error', e && e.message); }
}

function pruneActiveSignals(obj, maxItems = 100) {
  const keys = Object.keys(obj).sort((a,b) => obj[b].timestamp - obj[a].timestamp);
  if (keys.length <= maxItems) return;
  for (let i = maxItems; i < keys.length; i++) delete obj[keys[i]];
}

// ====================== SYSTEM LOOPS ======================
let shouldStopLoops = false;
async function loopWithInterval(fn, intervalMs) {
  while (!shouldStopLoops) {
    try { await fn(); } catch (e) { if (CONFIG.debug_show_metrics) console.error('loop error', e && e.message); }
    await EnhancedHelpers.delay(intervalMs);
  }
}

let scanFlags = { momentumRunning: false, breakoutRunning: false, hotRunning: false };

async function runFastMomentumScan() {
  if (scanFlags.momentumRunning) return;
  scanFlags.momentumRunning = true;
  try {
    if (!momentumPredictor || momentumPredictor.watchlist.size === 0) return;
    const coins = momentumPredictor.getShuffledWatchlist(200);
    let newSignals = 0;
    const batchSize = 8;
    for (let i = 0; i < coins.length; i += batchSize) {
      const batch = coins.slice(i, i + batchSize);
      const promises = batch.map(async ccxtSymbol => {
        const clean = EnhancedHelpers.cleanSymbol(ccxtSymbol);
        if (cooldownManager.isInCooldown(clean) || manipulationDetector.isSuspicious(clean)) return null;
        try {
          const ob = await requestQueue.push(() => exchangeAdapter.fetchOrderBook(ccxtSymbol, CONFIG.orderbook_depth));
          const analysis = momentumPredictor.analyzeImbalance(ob);
          if (analysis.direction !== 'WAIT' && analysis.confidence >= CONFIG.momentum_min_confidence) {
            const signal = await momentumPredictor.createSignalObject(ccxtSymbol, analysis);
            if (signal) {
              cooldownManager.addCooldown(clean, CONFIG.orderbook_signal_cooldown * 1000);
              return signal;
            }
          }
        } catch (e) { if (CONFIG.debug_show_metrics) console.error('momentum symbol error', ccxtSymbol, e && e.message); }
        return null;
      });
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          broadcastSignal(r.value);
          await autoTradeSystem.handleAutoTrading(r.value);
          newSignals++;
        }
      }
      if (i + batchSize < coins.length) await EnhancedHelpers.delay(800);
    }
    if (CONFIG.debug_show_metrics) console.log('runFastMomentumScan done - newSignals=' + newSignals);
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('runFastMomentumScan error', e && e.message); }
  finally { scanFlags.momentumRunning = false; }
}

async function runFastMeanReversionScan() {
  if (scanFlags.breakoutRunning) return;
  scanFlags.breakoutRunning = true;
  try {
    if (breakoutTargetList.length === 0) return;
    
    // YENİ: Multi-timeframe MRV analysis
    let totalSignals = 0;
    const batchSize = CONFIG.scanBatchSize;
    
    for (let i = 0; i < breakoutTargetList.length; i += batchSize) {
      const batch = breakoutTargetList.slice(i, i + batchSize);
      const promises = batch.map(async s => {
        try { 
          // YENİ: Multi-timeframe analysis kullan
          const signal = await meanReversionPredictor.analyzeMultipleTimeframes(s);
          return signal ? [signal] : [];
        }
        catch (e) { if (CONFIG.debug_show_metrics) console.error('MRV symbol error', s, e && e.message); return []; }
      });
      const results = await Promise.allSettled(promises);
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value && res.value.length) {
          for (const signal of res.value) {
            broadcastSignal(signal);
            await autoTradeSystem.handleAutoTrading(signal);
            totalSignals++;
          }
        }
      }
      if (i + batchSize < breakoutTargetList.length) await EnhancedHelpers.delay(1000);
    }
    if (CONFIG.debug_show_metrics) console.log('runFastMeanReversionScan done - totalSignals=' + totalSignals);
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('runFastMeanReversionScan error', e && e.message); }
  finally { scanFlags.breakoutRunning = false; }
}

async function runHotCoinScan() {
  if (scanFlags.hotRunning) return;
  scanFlags.hotRunning = true;
  try {
    await hotCoinManager.updateHotCoins();
    const hc = hotCoinManager.getHotCoins();
    if (hc.length > 0) {
      const toAdd = hc.filter(s => !momentumPredictor.watchlist.has(s)).slice(0, CONFIG.maxHotCoins);
      if (toAdd.length) momentumPredictor.updateWatchlist(toAdd);
    }
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('runHotCoinScan error', e && e.message); }
  finally { scanFlags.hotRunning = false; }
}

async function runExplosionWatcher() {
  try {
    if (allSwapSymbols.length === 0) return;
    const batchSize = 100;
    let hotList = [];
    for (let i = 0; i < Math.min(allSwapSymbols.length, 300); i += batchSize) {
      const batch = allSwapSymbols.slice(i, i + batchSize);
      try {
        const tickers = await requestQueue.push(() => exchangeAdapter.fetchTickers(batch));
        const batchHot = Object.values(tickers || {}).filter(t => (t?.quoteVolume || t?.quote_volume || 0) > CONFIG.minVolumeUSD && Number.isFinite(t.percentage) && Math.abs(t.percentage) > CONFIG.orderbook_min_24h_explosion).map(t => t.symbol);
        hotList.push(...batchHot);
      } catch (e) { if (CONFIG.debug_show_metrics) console.error('explosion fetch error', e && e.message); }
      await EnhancedHelpers.delay(500);
    }
    if (hotList.length > 0) momentumPredictor.updateWatchlist(hotList);
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('runExplosionWatcher error', e && e.message); }
}

async function manageOpenPositions() {
  try {
    await autoTradeSystem.checkPositionsAndBreakeven();
    const positionsPayload = openPositions.map(p => Object.assign({}, p, {
      entryPrice: p.entryPrice?.toFixed(8),
      markPrice: p.markPrice?.toFixed(8),
      tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1,
      sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl,
      liquidationPrice: p.liquidationPrice?.toFixed ? p.liquidationPrice?.toFixed(8) : p.liquidationPrice
    }));
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(JSON.stringify({ type: 'open_positions', data: positionsPayload })); }
        catch (e) { if (CONFIG.debug_show_metrics) console.error('WS open_positions send error', e && e.message); try { client.terminate(); } catch {} }
      }
    });
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('manageOpenPositions error', e && e.message); }
}

async function runSystemLoops() {
  loopWithInterval(runFastMomentumScan, 15000);
  loopWithInterval(runHotCoinScan, CONFIG.hotCoinScanInterval);
  loopWithInterval(runFastMeanReversionScan, 8 * 60 * 1000);
  loopWithInterval(manageOpenPositions, 20 * 1000);
  loopWithInterval(runExplosionWatcher, 3 * 60 * 1000);
  loopWithInterval(() => { cooldownManager.cleanup(); qualityFilter.cleanupCache(); manipulationDetector.cleanup(); return Promise.resolve(); }, 60 * 1000);
  console.log('System loops started');
}

// ====================== API ======================
app.get('/api/metrics', async (req, res) => {
  if (!CONFIG.isApiConfigured) return res.json({ totalEquity: 0, availableMargin: 0, unrealizedPnl: 0, riskRatio: 0, dailyTrades: 0, positionsCount: 0, dailyPL: 0 });
  try {
    ensureExchange();
    const balance = await requestQueue.push(() => exchangeAdapter.fetchBalance({ type: 'swap' }));
    const usdt = balance.info?.data?.find(a => a.marginCoin === 'USDT') || {};
    const totalEquity = parseFloat(balance.total?.USDT || usdt.equity || usdt.total || 0);
    const availableMargin = parseFloat(balance.free?.USDT || usdt.available || usdt.free || 0);
    const unrealizedPnl = parseFloat(usdt.unrealizedPL || 0);
    await syncOpenPositions();
    res.json({
      totalEquity: parseFloat(totalEquity.toFixed(2)),
      availableMargin: parseFloat(availableMargin.toFixed(2)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
      riskRatio: 0,
      dailyTrades: dailyTradeCount,
      positionsCount: openPositions.length,
      dailyPL: parseFloat(dailyPL.toFixed(2)),
      systemStatus,
      performanceMetrics
    });
  } catch (e) { res.status(500).json({ error: 'Metrikler alınamadı' }); }
});

app.get('/api/config/status', async (req, res) => {
  try {
    await syncOpenPositions();
    res.json(Object.assign({}, CONFIG, {
      serverTime: new Date().toLocaleTimeString('tr-TR'),
      activeSignals: { breakout: Object.keys(activeBreakoutSignals).length, momentum: Object.keys(activeMomentumSignals).length },
      openPositionsCount: openPositions.length,
      dailyTrades: dailyTradeCount,
      hotCoins: hotCoinManager.getHotCoins().length,
      systemHealth: systemStatus,
      openPositions: openPositions.map(p => Object.assign({}, p, { entryPrice: p.entryPrice?.toFixed(8), markPrice: p.markPrice?.toFixed(8), tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1, sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl }))
    }));
  } catch (e) { res.status(500).json({ error: 'Config alınamadı' }); }
});

app.post('/api/config/update', (req, res) => {
  try {
    const allowed = ['leverage','marginPercent','fixedStopLossPercent','maxPositions','autoTradeMomentum','momentum_min_confidence','autoTradeMomentumVolumeLevel','orderbook_min_24h_explosion','orderbook_depth','orderbook_imbalance_ratio','orderbook_min_usd_wall','orderbook_signal_cooldown','autoTradeMeanReversion','breakout_min_confidence','scanBatchSize','hotCoinScanInterval','maxHotCoins','minVolumeUSD','debug_show_metrics','volumeScorePercentileWindow','mrv_min_bb_width_percent','enhanced_tpsl_logging'];
    const updates = {};
    Object.keys(req.body).forEach(k => {
      if (allowed.includes(k) && CONFIG.hasOwnProperty(k)) {
        const v = req.body[k];
        const t = typeof CONFIG[k];
        if (t === 'number') CONFIG[k] = EnhancedHelpers.clampNumber(parseFloat(v), 0, 10000000);
        else if (t === 'string') CONFIG[k] = String(v);
        else if (t === 'boolean') CONFIG[k] = (v === true || v === 'true');
        else CONFIG[k] = v;
        updates[k] = CONFIG[k];
      }
    });
    res.json({ success: true, message: 'Ayarlar güncellendi', updates });
  } catch (e) { res.status(500).json({ success: false, message: 'Ayarlar güncellenemedi' }); }
});

app.post('/api/autotrade/manual', async (req, res) => {
  const signal = req.body;
  if (!signal || !signal.coin) return res.status(400).json({ success: false, message: 'Geçersiz sinyal' });
  const cooldownKey = signal.coin + '-' + (signal.strategy || signal.tip);
  if (cooldownManager.isInCooldown(cooldownKey)) return res.status(429).json({ success: false, message: 'Cooldown aktif: ' + signal.coin });
  try {
    await autoTradeSystem.placeTradeOrder(signal);
    cooldownManager.addCooldown(cooldownKey);
    res.json({ success: true, message: signal.coin + ' için emir verildi.' });
  } catch (e) { res.status(500).json({ success: false, message: 'Emir hatası: ' + (e && e.message) }); }
});

app.post('/api/force-remove-position', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ success: false, message: 'Symbol gerekli' });
  try {
    const original = EnhancedHelpers.getOriginalSymbol(symbol);
    await closePosition(original);
    res.json({ success: true, message: 'Pozisyon kapatıldı: ' + symbol });
  } catch (e) { res.status(500).json({ success: false, message: 'Pozisyon kapatılamadı: ' + (e && e.message) }); }
});

app.get('/api/positions/tpsl-details', async (req, res) => {
  try {
    await syncOpenPositions();
    const details = openPositions.map(p => {
      const meta = autoTradeSystem.openPositionMetadata.get(p.symbol);
      return {
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice?.toFixed(8),
        markPrice: p.markPrice?.toFixed(8),
        tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1,
        tp2: p.tp2?.toFixed ? p.tp2?.toFixed(8) : p.tp2,
        sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl,
        hasHitTP1: p.hasHitTP1,
        unrealizedPnl: p.unrealizedPnl?.toFixed(2),
        pnlPercent: p.entryPrice ? ((p.unrealizedPnl / (p.entryPrice * p.amount)) * 100).toFixed(2) : '0.00'
      };
    });
    res.json({ success: true, data: details });
  } catch (e) { res.status(500).json({ success: false, error: e && e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));

// ====================== WEBSOCKET (basic auth placeholder) ======================
wss.on('connection', ws => {
  console.log('WS: client connected');
  systemStatus.activeSockets = wss.clients.size;
  try {
    const momentumPayload = Object.values(activeMomentumSignals).sort((a,b)=>b.timestamp-a.timestamp).slice(0,20).map(s => sanitizeForWS(s));
    const breakoutPayload = Object.values(activeBreakoutSignals).sort((a,b)=>b.timestamp-a.timestamp).slice(0,20).map(s => sanitizeForWS(s));
    const positionsPayload = openPositions.map(p => Object.assign({}, p, { entryPrice: p.entryPrice?.toFixed(8), markPrice: p.markPrice?.toFixed(8), tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1, sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl }));
    ws.send(JSON.stringify({ type: 'breakout_signals', data: breakoutPayload }));
    ws.send(JSON.stringify({ type: 'momentum_signals', data: momentumPayload }));
    ws.send(JSON.stringify({ type: 'open_positions', data: positionsPayload }));
    ws.send(JSON.stringify({ type: 'system_status', data: systemStatus }));
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('WS init send error', e && e.message); }
  ws.on('close', () => { systemStatus.activeSockets = wss.clients.size; });
});

// ====================== INIT ======================
const qualityFilter = new FastAiQualityFilter();
const manipulationDetector = new ManipulationDetector();
const meanReversionPredictor = new FastMeanReversionPredictor(qualityFilter);
const autoTradeSystem = new ReliableAutoTradeSystem();
const momentumPredictor = new UltraFastMomentumPredictor(qualityFilter, manipulationDetector);
const hotCoinManager = new HotCoinManager();

app.post('/api/chat/ask', async (req, res) => {
  try {
    const { userMessage } = req.body || {};
    if (!userMessage) return res.status(400).json({ success: false, error: 'userMessage gerekli' });
    res.json({
      success: true,
      result: {
        intent: 'review_only',
        confidence: 70,
        actions: [],
        recommendations: ['v25.12 - Enhanced MRV & Multi-Timeframe Analysis Aktif'],
        notes: [
          '✅ MRV Threshold Optimization: breakout_min_confidence=40, mrv_min_bb_width_percent=1.2',
          '✅ Multi-Timeframe Analysis: 15m, 1h, 4h timeframe konsolidasyonu',
          '✅ Advanced Confidence Calculation: Volume, volatility, trend, spread weighted scoring',
          '🎯 Daha fazla quality MRV sinyali + daha iyi timing'
        ]
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e && e.message }); }
});

// ====================== START/SCREENER ======================
async function startScreener() {
  try {
    console.log('startScreener: initializing...');
    if (!exchangeAdapter || !exchangeAdapter.raw) {
      exchangeAdapter = createExchangeAdapter();
      if (!exchangeAdapter) { console.error('Exchange adapter not available'); return; }
    }
    await qualityFilter.preloadAllCoins();
    if (CONFIG.isApiConfigured) {
      try {
        const bal = await requestQueue.push(() => exchangeAdapter.fetchBalance({ type: 'swap' }));
        console.log('Balance detected: $' + parseFloat(bal.total?.USDT || 0).toFixed(2));
      } catch (e) { if (CONFIG.debug_show_metrics) console.error('Balance fetch error', e && e.message); }
      await syncOpenPositions();
    } else {
      console.log('API keys not configured, running in signal-only mode');
    }
    if (breakoutTargetList && breakoutTargetList.length) {
      const shuffled = [...breakoutTargetList].sort(() => 0.5 - Math.random());
      momentumPredictor.updateWatchlist(shuffled.slice(0, 150));
      console.log('startScreener: seeded momentum watchlist size=', momentumPredictor.watchlist.size);
    }
    runSystemLoops();
    setTimeout(() => {
      runFastMeanReversionScan().catch(e => console.error("Initial MRV Scan Error", e));
      runExplosionWatcher().catch(e => console.error("Initial ExplosionWatcher Error", e));
      runHotCoinScan().catch(e => console.error("Initial HotCoinScan Error", e));
    }, 3000);
    console.log('🎯 TP/SL Analiz Sistemi Aktif - v25.12 Enhanced');
    console.log('✅ MRV Optimization: Lower thresholds + Multi-timeframe');
    console.log('✅ Advanced Confidence: Multi-factor weighted scoring');
    console.log('📊 Mod: Daha fazla quality sinyal + daha iyi timing');
  } catch (e) {
    console.error('startScreener error', e && e.message);
    systemStatus.isHealthy = false;
    systemStatus.lastError = e && e.message;
    setTimeout(startScreener, 10000);
  }
}

// ====================== ERRORS & START ======================
process.on('SIGINT', async () => { console.log('SIGINT'); shouldStopLoops = true; process.exit(0); });
process.on('uncaughtException', err => {
  console.error('UNCAUGHT', err && err.message);
  systemStatus.isHealthy = false;
  systemStatus.lastError = err && err.message;
});
process.on('unhandledRejection', (r) => { console.error('UNHANDLED REJ', r); });

server.listen(PORT, () => {
  console.log('🚀 Sonny AI TRADER v25.12 listening on port ' + PORT);
  console.log('📊 Enhanced MRV & Multi-Timeframe Analysis: AKTİF');
  startScreener();
});
