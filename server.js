// server.js
// Sonny AI TRADER - Destek/Direnç Kırılım Stratejisi
// Geliştirme: 1H-2H timeframe destek/direnç analizi ve kırılım tespiti

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');

console.log('=== SERVER BOOT (pid=' + process.pid + ') ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ====================== YENİ KONFİGÜRASYON ======================
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET && process.env.BITGET_PASSPHRASE),

  // Pozisyon ayarları
  leverage: 10,
  marginPercent: 3,
  fixedStopLossPercent: 1.0,
  maxPositions: 3,
  maxHoldTime: 7200,

  // Otomatik trade ayarları
  autoTradeSupportResistance: false,

  // Destek/Direnç ayarları
  sr_min_confidence: 65,
  sr_lookback_periods: 50,
  sr_breakout_threshold: 0.002, // %0.2 kırılım threshold
  sr_volume_confirmation: true,
  sr_min_volume_multiplier: 1.5,
  
  // Sinyal filtreleri
  minVolumeUSD: 100000,
  blacklist: [],

  // Tarama ayarları
  scanBatchSize: 6,
  scanInterval: 60000, // 1 dakika

  debug_show_metrics: true
};

// ====================== GLOBALS ======================
let allSwapSymbols = [];
let activeSupportResistanceSignals = {};
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

// ====================== REQUEST QUEUE ======================
const requestQueue = {
  queue: [],
  running: 0,
  concurrency: 4,
  maxConcurrency: 8,
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
      if (this.queue.length > 30 && this.concurrency < this.maxConcurrency) this.concurrency++;
      if (this.queue.length === 0 && this.concurrency > this.minConcurrency) this.concurrency = Math.max(this.minConcurrency, this.concurrency - 1);
      setTimeout(() => this.next(), 100);
    }
  }
};

// ====================== COOLDOWN MANAGER ======================
const cooldownManager = {
  signals: new Map(),
  addCooldown(key, durationMs = 600000) { // 10 dakika cooldown
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

// ====================== YARDIMCI FONKSİYONLAR ======================
async function safeFetchOHLCV(symbol, timeframe, limit = 100) {
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

  // Destek ve Direnç Seviyelerini Hesapla
  static calculateSupportResistance(highs, lows, closes, period = 20) {
    try {
      const levels = [];
      const merged = [...highs, ...lows];
      
      // Yüksek ve düşük seviyeleri bul
      for (let i = period; i < merged.length - period; i++) {
        const windowStart = Math.max(0, i - period);
        const windowEnd = Math.min(merged.length - 1, i + period);
        
        let isHigh = true;
        let isLow = true;
        
        // Yüksek nokta kontrolü
        for (let j = windowStart; j <= windowEnd; j++) {
          if (j !== i && merged[j] > merged[i]) {
            isHigh = false;
            break;
          }
        }
        
        // Düşük nokta kontrolü
        for (let j = windowStart; j <= windowEnd; j++) {
          if (j !== i && merged[j] < merged[i]) {
            isLow = false;
            break;
          }
        }
        
        if (isHigh || isLow) {
          levels.push({
            price: merged[i],
            type: isHigh ? 'RESISTANCE' : 'SUPPORT',
            strength: this.calculateLevelStrength(merged, i, period),
            timestamp: i
          });
        }
      }
      
      // Benzer seviyeleri birleştir
      return this.mergeSimilarLevels(levels, 0.002); // %0.2 tolerance
    } catch (e) {
      return [];
    }
  }

  static calculateLevelStrength(prices, index, period) {
    try {
      const windowStart = Math.max(0, index - period);
      const windowEnd = Math.min(prices.length - 1, index + period);
      let touches = 0;
      
      for (let i = windowStart; i <= windowEnd; i++) {
        if (Math.abs(prices[i] - prices[index]) / prices[index] < 0.005) { // %0.5 tolerance
          touches++;
        }
      }
      
      return Math.min(100, (touches / (windowEnd - windowStart + 1)) * 200);
    } catch (e) {
      return 50;
    }
  }

  static mergeSimilarLevels(levels, tolerance) {
    const merged = [];
    
    for (const level of levels) {
      let foundSimilar = false;
      
      for (const existing of merged) {
        if (Math.abs(level.price - existing.price) / existing.price < tolerance) {
          // Ortalama fiyatı al ve strength'i güncelle
          existing.price = (existing.price + level.price) / 2;
          existing.strength = Math.max(existing.strength, level.strength);
          foundSimilar = true;
          break;
        }
      }
      
      if (!foundSimilar) {
        merged.push({...level});
      }
    }
    
    return merged.sort((a, b) => a.price - b.price);
  }

  // Kırılım Tespiti
  static detectBreakout(currentPrice, levels, volume, avgVolume, threshold = 0.002) {
    try {
      let closestLevel = null;
      let minDistance = Infinity;
      let levelType = null;
      
      for (const level of levels) {
        const distance = Math.abs(currentPrice - level.price) / level.price;
        if (distance < minDistance) {
          minDistance = distance;
          closestLevel = level;
          levelType = level.type;
        }
      }
      
      if (!closestLevel || minDistance > threshold * 2) {
        return null; // Yakın seviye yok
      }
      
      const isBreakout = currentPrice > closestLevel.price && levelType === 'RESISTANCE' ||
                        currentPrice < closestLevel.price && levelType === 'SUPPORT';
      
      if (!isBreakout) {
        return null;
      }
      
      // Volume confirmation
      const volumeConfirmed = !CONFIG.sr_volume_confirmation || volume > avgVolume * CONFIG.sr_min_volume_multiplier;
      
      if (!volumeConfirmed) {
        return null;
      }
      
      return {
        level: closestLevel,
        breakoutDirection: levelType === 'RESISTANCE' ? 'LONG' : 'SHORT',
        distance: minDistance,
        volumeConfirmed,
        confidence: Math.min(100, closestLevel.strength * (volumeConfirmed ? 1.2 : 1.0))
      };
    } catch (e) {
      return null;
    }
  }

  // Hedef Fiyat Hesaplama
  static calculateTargets(breakoutInfo, currentPrice, atr) {
    try {
      const { level, breakoutDirection } = breakoutInfo;
      
      if (breakoutDirection === 'LONG') {
        // Direnç kırılımı - bir sonraki direnç veya ATR-based target
        const target1 = currentPrice + (atr || currentPrice * 0.02);
        const target2 = currentPrice + (atr ? atr * 1.8 : currentPrice * 0.035);
        const stopLoss = currentPrice - (atr ? atr * 0.8 : currentPrice * 0.01);
        
        return {
          tp1: target1,
          tp2: target2,
          sl: stopLoss,
          method: 'RESISTANCE_BREAKOUT'
        };
      } else {
        // Destek kırılımı - bir sonraki destek veya ATR-based target
        const target1 = currentPrice - (atr || currentPrice * 0.02);
        const target2 = currentPrice - (atr ? atr * 1.8 : currentPrice * 0.035);
        const stopLoss = currentPrice + (atr ? atr * 0.8 : currentPrice * 0.01);
        
        return {
          tp1: target1,
          tp2: target2,
          sl: stopLoss,
          method: 'SUPPORT_BREAKOUT'
        };
      }
    } catch (e) {
      return null;
    }
  }

  static async fetchATR(symbol, timeframe = '1h', lookback = 30) {
    try {
      const candles = await safeFetchOHLCV(symbol, timeframe, lookback);
      if (!candles || candles.length < 15) return null;
      const highs = candles.map(c => c[2]);
      const lows = candles.map(c => c[3]);
      const closes = candles.map(c => c[4]);
      
      // Basit ATR hesaplama
      let trSum = 0;
      for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i-1]),
          Math.abs(lows[i] - closes[i-1])
        );
        trSum += tr;
      }
      
      const atr = trSum / (highs.length - 1);
      return Number.isFinite(atr) && atr > 0 ? atr : null;
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
}

// ====================== DESTEK/DİRENÇ PREDICTOR ======================
class SupportResistancePredictor {
  constructor(qf) { 
    this.qf = qf;
    this.symbolLevels = new Map(); // Symbol -> levels cache
  }

  async analyzeSupportResistance(ccxtSymbol) {
    try {
      const marketInfo = EnhancedHelpers.getMarketInfo(ccxtSymbol);
      if (!marketInfo) return null;

      const fullSymbol = EnhancedHelpers.cleanSymbol(ccxtSymbol);
      const cooldownKey = fullSymbol + '-SR';
      if (cooldownManager.isInCooldown(cooldownKey)) return null;

      // 1H ve 2H verilerini al
      const [ohlcv1h, ohlcv2h] = await Promise.all([
        safeFetchOHLCV(ccxtSymbol, '1h', CONFIG.sr_lookback_periods),
        safeFetchOHLCV(ccxtSymbol, '2h', Math.floor(CONFIG.sr_lookback_periods / 2))
      ]);

      if (!ohlcv1h || ohlcv1h.length < 20 || !ohlcv2h || ohlcv2h.length < 10) {
        return null;
      }

      // Mevcut fiyat ve volume bilgisi
      let currentTicker;
      try {
        currentTicker = await requestQueue.push(() => exchangeAdapter.fetchTicker(ccxtSymbol));
      } catch (_) {
        return null;
      }

      const currentPrice = currentTicker.last;
      const currentVolume = currentTicker.quoteVolume || 0;

      if (!currentPrice || currentPrice <= 0) return null;

      // Destek/direnç seviyelerini hesapla (1H)
      const highs1h = ohlcv1h.map(c => c[2]);
      const lows1h = ohlcv1h.map(c => c[3]);
      const closes1h = ohlcv1h.map(c => c[4]);
      const volumes1h = ohlcv1h.map(c => c[5]);

      const levels1h = EnhancedHelpers.calculateSupportResistance(highs1h, lows1h, closes1h, 10);
      
      // 2H seviyeleri (daha güçlü seviyeler)
      const highs2h = ohlcv2h.map(c => c[2]);
      const lows2h = ohlcv2h.map(c => c[3]);
      const closes2h = ohlcv2h.map(c => c[4]);

      const levels2h = EnhancedHelpers.calculateSupportResistance(highs2h, lows2h, closes2h, 5);

      // Seviyeleri birleştir (2H seviyeleri daha önemli)
      const allLevels = [...levels2h.map(l => ({...l, strength: l.strength * 1.5})), ...levels1h];
      
      // Ortalama volume hesapla
      const avgVolume = volumes1h.reduce((sum, vol) => sum + vol, 0) / volumes1h.length;

      // Kırılım tespiti
      const breakoutInfo = EnhancedHelpers.detectBreakout(
        currentPrice, 
        allLevels, 
        currentVolume, 
        avgVolume, 
        CONFIG.sr_breakout_threshold
      );

      if (!breakoutInfo || breakoutInfo.confidence < CONFIG.sr_min_confidence) {
        return null;
      }

      // ATR ile TP/SL hesapla
      const atr = await EnhancedHelpers.fetchATR(ccxtSymbol, '1h', 20);
      const targets = EnhancedHelpers.calculateTargets(breakoutInfo, currentPrice, atr);

      if (!targets) return null;

      // Volume score hesapla
      const volScore = await this.qf.calculateVolumeScore(ccxtSymbol);

      // Market info for rounding
      const marketInfoForRounding = marketInfo;
      const tp1 = EnhancedHelpers.roundToTick(targets.tp1, marketInfoForRounding);
      const tp2 = EnhancedHelpers.roundToTick(targets.tp2, marketInfoForRounding);
      const sl = EnhancedHelpers.roundToTick(targets.sl, marketInfoForRounding);

      // Risk/Reward hesapla
      const risk = Math.abs(currentPrice - sl);
      const reward1 = Math.abs(tp1 - currentPrice);
      const reward2 = Math.abs(tp2 - currentPrice);
      const rr1 = reward1 / risk;
      const rr2 = reward2 / risk;

      if (rr1 < 1.2) return null; // Minimum R/R

      // Öngörü ve analiz metni oluştur
      const analysis = this.generateAnalysis(
        breakoutInfo, 
        currentPrice, 
        targets, 
        allLevels,
        rr1,
        rr2
      );

      const signalData = {
        coin: fullSymbol,
        ccxt_symbol: ccxtSymbol,
        taraf: breakoutInfo.breakoutDirection,
        tip: 'SUPPORT_RESISTANCE',
        zaman_araligi: '1H-2H',
        giris: currentPrice,
        tp1: tp1,
        tp2: tp2,
        sl: sl,
        profitPercent1: parseFloat(((reward1 / currentPrice) * 100).toFixed(2)),
        profitPercent2: parseFloat(((reward2 / currentPrice) * 100).toFixed(2)),
        riskPercent: parseFloat(((risk / currentPrice) * 100).toFixed(2)),
        riskReward: rr1.toFixed(2),
        hacim_durumu: EnhancedHelpers.getScoreLabel(volScore),
        volatilite_durumu: atr && atr > currentPrice * 0.02 ? 'YÜKSEK' : 'NORMAL',
        mum_yapisi: 'KIRILIM',
        ongoru: analysis.forecast,
        tuyo: analysis.analysis,
        hacim_analizi: `Volume: ${(currentVolume/avgVolume).toFixed(1)}x avg | Conf: ${breakoutInfo.confidence.toFixed(0)}%`,
        sinyal_kategorisi: breakoutInfo.confidence >= 75 ? 'YÜKSEK GÜVEN' : 'ORTA GÜVEN',
        tv_link: EnhancedHelpers.getTradingViewLink(ccxtSymbol),
        timestamp: Date.now(),
        confidence: Math.round(breakoutInfo.confidence),
        strategy: 'SR_BREAKOUT',
        ai_score: Math.round(breakoutInfo.confidence),
        isSupportResistanceSignal: true,
        analiz_notu: analysis.notes.join(' | '),
        raw_metrics: {
          volScore,
          atr: atr || 0,
          levelStrength: breakoutInfo.level.strength,
          volumeRatio: parseFloat((currentVolume / avgVolume).toFixed(2)),
          breakoutDistance: parseFloat((breakoutInfo.distance * 100).toFixed(3)),
          rr1: parseFloat(rr1.toFixed(2)),
          rr2: parseFloat(rr2.toFixed(2))
        }
      };

      if (CONFIG.debug_show_metrics) {
        console.log('SR Sinyal:', { 
          coin: signalData.coin, 
          direction: signalData.taraf,
          confidence: signalData.confidence,
          level: breakoutInfo.level.type,
          price: currentPrice,
          rr: signalData.riskReward
        });
      }

      cooldownManager.addCooldown(cooldownKey);
      return signalData;
    } catch (e) {
      if (CONFIG.debug_show_metrics) console.log('SR Analysis Exception', e && e.message);
      return null;
    }
  }

  generateAnalysis(breakoutInfo, currentPrice, targets, allLevels, rr1, rr2) {
    const { level, breakoutDirection } = breakoutInfo;
    const isLong = breakoutDirection === 'LONG';
    
    // Mevcut seviyeden sonraki seviyeleri bul
    const nextLevels = allLevels.filter(l => 
      isLong ? l.price > currentPrice : l.price < currentPrice
    ).sort((a, b) => 
      isLong ? a.price - b.price : b.price - a.price
    );

    const nextMajorLevel = nextLevels[0];
    const analysis = {
      forecast: '',
      analysis: '',
      notes: []
    };

    // Temel forecast
    if (isLong) {
      analysis.forecast = `Direnç kırılımı - ${targets.tp1.toFixed(6)} hedef 1, ${targets.tp2.toFixed(6)} hedef 2`;
      analysis.analysis = `YUKARI KIRILIM | ${level.price.toFixed(6)} direnci aşıldı | R/R: ${rr1.toFixed(1)}`;
    } else {
      analysis.forecast = `Destek kırılımı - ${targets.tp1.toFixed(6)} hedef 1, ${targets.tp2.toFixed(6)} hedef 2`;
      analysis.analysis = `AŞAĞI KIRILIM | ${level.price.toFixed(6)} desteği kırıldı | R/R: ${rr1.toFixed(1)}`;
    }

    // Detaylı notlar
    analysis.notes.push(`${level.type} kırılımı (Güç: ${breakoutInfo.level.strength.toFixed(0)}%)`);
    
    if (nextMajorLevel) {
      const distancePercent = Math.abs(nextMajorLevel.price - currentPrice) / currentPrice * 100;
      analysis.notes.push(`Sonraki major seviye: ${nextMajorLevel.price.toFixed(6)} (%${distancePercent.toFixed(1)})`);
    }

    analysis.notes.push(`Hedef 1: ${targets.tp1.toFixed(6)} (R/R: ${rr1.toFixed(1)})`);
    analysis.notes.push(`Hedef 2: ${targets.tp2.toFixed(6)} (R/R: ${rr2.toFixed(1)})`);
    analysis.notes.push(`Stop: ${targets.sl.toFixed(6)}`);

    // Zaman tahmini (basit)
    if (rr1 >= 2) {
      analysis.notes.push('Beklenti: Hızlı hareket (1-4 saat)');
    } else if (rr1 >= 1.5) {
      analysis.notes.push('Beklenti: Orta tempo (4-12 saat)');
    } else {
      analysis.notes.push('Beklenti: Yavaş hareket (12-24 saat)');
    }

    return analysis;
  }
}

// ====================== QUALITY FILTER ======================
class FastAiQualityFilter {
  constructor(){
    this.symbolCache = new Map();
    this.cacheTimeout = 30000;
  }

  async calculateVolumeScore(symbol) {
    try {
      ensureExchange();
      const ticker = await requestQueue.push(() => exchangeAdapter.fetchTicker(symbol));
      const dailyVolume = Number(ticker?.quoteVolume || ticker?.quote_volume || 0) || 0;

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
    } catch (e) {
      console.error('preloadAllCoins error', e && e.message);
      allSwapSymbols = [];
    }
  }

  cleanupCache(){
    const now = Date.now();
    for (const [k,v] of this.symbolCache.entries()) {
      if (now - v.timestamp > this.cacheTimeout * 5) this.symbolCache.delete(k);
    }
  }
}

// ====================== AUTO TRADE SYSTEM ======================
class ReliableAutoTradeSystem {
  constructor(){
    this.openPositionMetadata = new Map();
    this.orderHistory = [];
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
  }

  async handleAutoTrading(signal) {
    if (!CONFIG.autoTradeSupportResistance) return;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) return;
    if (!CONFIG.isApiConfigured) return;
    try {
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

  // ... (Diğer auto trade metodları aynı kalacak, kısaltma için buraya eklemedim)
  // Tam implementasyon için önceki koddaki auto trade metodlarını kullanabilirsiniz
}

// ====================== SİNYAL YAYINI ======================
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
    const formattedSignal = Object.assign({}, signal, { 
      tp1: fmt(signal.tp1), 
      tp2: fmt(signal.tp2), 
      sl: fmt(signal.sl), 
      giris: fmt(signal.giris) 
    });
    
    const coinKey = EnhancedHelpers.normalizeKey(signal.coin || signal.ccxt_symbol);
    activeSupportResistanceSignals[coinKey] = Object.assign({ timestamp: Date.now() }, formattedSignal);
    
    // Eski sinyalleri temizle
    pruneActiveSignals(activeSupportResistanceSignals, 50);

    const payload = Object.values(activeSupportResistanceSignals)
      .sort((a,b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map(s => sanitizeForWS(s));

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify({ type: 'support_resistance_signals', data: payload }));
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

// ====================== SİSTEM DÖNGÜLERİ ======================
let shouldStopLoops = false;
async function loopWithInterval(fn, intervalMs) {
  while (!shouldStopLoops) {
    try { await fn(); } catch (e) { if (CONFIG.debug_show_metrics) console.error('loop error', e && e.message); }
    await EnhancedHelpers.delay(intervalMs);
  }
}

let scanFlags = { srRunning: false };

async function runSupportResistanceScan() {
  if (scanFlags.srRunning || allSwapSymbols.length === 0) return;
  scanFlags.srRunning = true;
  try {
    let newSignals = 0;
    const batchSize = CONFIG.scanBatchSize;
    
    for (let i = 0; i < allSwapSymbols.length; i += batchSize) {
      const batch = allSwapSymbols.slice(i, i + batchSize);
      const promises = batch.map(async symbol => {
        try {
          const signal = await supportResistancePredictor.analyzeSupportResistance(symbol);
          return signal ? [signal] : [];
        } catch (e) { 
          if (CONFIG.debug_show_metrics) console.error('SR symbol error', symbol, e && e.message); 
          return []; 
        }
      });
      
      const results = await Promise.allSettled(promises);
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value && res.value.length) {
          for (const signal of res.value) {
            broadcastSignal(signal);
            await autoTradeSystem.handleAutoTrading(signal);
            newSignals++;
          }
        }
      }
      
      if (i + batchSize < allSwapSymbols.length) await EnhancedHelpers.delay(1000);
    }
    
    if (CONFIG.debug_show_metrics) console.log('SupportResistanceScan done - newSignals=' + newSignals);
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('SupportResistanceScan error', e && e.message); }
  finally { scanFlags.srRunning = false; }
}

// ====================== API ROUTES ======================
app.get('/api/metrics', async (req, res) => {
  // ... (Önceki metrics endpoint aynı kalacak)
});

app.get('/api/config/status', async (req, res) => {
  try {
    await syncOpenPositions();
    res.json(Object.assign({}, CONFIG, {
      serverTime: new Date().toLocaleTimeString('tr-TR'),
      activeSignals: { support_resistance: Object.keys(activeSupportResistanceSignals).length },
      openPositionsCount: openPositions.length,
      dailyTrades: dailyTradeCount,
      systemHealth: systemStatus,
      openPositions: openPositions.map(p => Object.assign({}, p, { 
        entryPrice: p.entryPrice?.toFixed(8), 
        markPrice: p.markPrice?.toFixed(8), 
        tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1, 
        sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl 
      }))
    }));
  } catch (e) { res.status(500).json({ error: 'Config alınamadı' }); }
});

app.post('/api/config/update', (req, res) => {
  try {
    const allowed = ['leverage','marginPercent','autoTradeSupportResistance','sr_min_confidence','sr_lookback_periods','sr_breakout_threshold','sr_volume_confirmation','sr_min_volume_multiplier','minVolumeUSD','scanBatchSize','scanInterval','debug_show_metrics'];
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

// ====================== WEBSOCKET ======================
wss.on('connection', ws => {
  console.log('WS: client connected');
  systemStatus.activeSockets = wss.clients.size;
  try {
    const signalsPayload = Object.values(activeSupportResistanceSignals)
      .sort((a,b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map(s => sanitizeForWS(s));
    
    const positionsPayload = openPositions.map(p => Object.assign({}, p, { 
      entryPrice: p.entryPrice?.toFixed(8), 
      markPrice: p.markPrice?.toFixed(8), 
      tp1: p.tp1?.toFixed ? p.tp1?.toFixed(8) : p.tp1, 
      sl: p.sl?.toFixed ? p.sl?.toFixed(8) : p.sl 
    }));
    
    ws.send(JSON.stringify({ type: 'support_resistance_signals', data: signalsPayload }));
    ws.send(JSON.stringify({ type: 'open_positions', data: positionsPayload }));
    ws.send(JSON.stringify({ type: 'system_status', data: systemStatus }));
  } catch (e) { if (CONFIG.debug_show_metrics) console.error('WS init send error', e && e.message); }
  ws.on('close', () => { systemStatus.activeSockets = wss.clients.size; });
});

// ====================== INIT ======================
const qualityFilter = new FastAiQualityFilter();
const supportResistancePredictor = new SupportResistancePredictor(qualityFilter);
const autoTradeSystem = new ReliableAutoTradeSystem();

// ====================== BAŞLANGIÇ ======================
async function startScreener() {
  try {
    console.log('startScreener: initializing Support/Resistance strategy...');
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

    // Sistem döngülerini başlat
    loopWithInterval(runSupportResistanceScan, CONFIG.scanInterval);
    loopWithInterval(() => { cooldownManager.cleanup(); qualityFilter.cleanupCache(); return Promise.resolve(); }, 60 * 1000);
    
    console.log('🎯 Destek/Direnç Kırılım Stratejisi Aktif');
    console.log('✅ 1H-2H Timeframe Analizi');
    console.log('✅ Dinamik Seviye Tespiti');
    console.log('✅ Volume Onaylı Kırılım Sinyalleri');
    console.log('✅ Hedef ve Zaman Tahmini');
    
  } catch (e) {
    console.error('startScreener error', e && e.message);
    systemStatus.isHealthy = false;
    systemStatus.lastError = e && e.message;
    setTimeout(startScreener, 10000);
  }
}

// ====================== ERROR HANDLING ======================
process.on('SIGINT', async () => { console.log('SIGINT'); shouldStopLoops = true; process.exit(0); });
process.on('uncaughtException', err => {
  console.error('UNCAUGHT', err && err.message);
  systemStatus.isHealthy = false;
  systemStatus.lastError = err && err.message;
});
process.on('unhandledRejection', (r) => { console.error('UNHANDLED REJ', r); });

server.listen(PORT, () => {
  console.log('🚀 Sonny AI TRADER - Destek/Direnç Stratejisi listening on port ' + PORT);
  console.log('📊 1H-2H Kırılım Analizi: AKTİF');
  startScreener();
});

// Diğer gerekli fonksiyonlar (syncOpenPositions, closePosition vb.) önceki koddan aynen alınacak
// Kısaltma nedeniyle buraya eklenmedi, ancak çalışması için gerekli
