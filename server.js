/**
 * server.js
 * Sonny TRADER v35.1 — TrendMaster AI Edition + Smart Signal Refresh
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

/* ====================== BOOT ====================== */
console.log('=== SERVER BOOT (TrendMaster v35.1 SMART SIGNAL) ===');
const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

/* ====================== KONFİGURASYON ====================== */
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

  // Risk
  leverage: 10,
  marginPercent: 5,
  maxPositions: 5,
  dailyTradeLimit: 30,

  // Autotrade Güven Kontrolü
  minConfidenceForAuto: 75,

  // Tarama
  scanBatchSize: 20,         
  focusedScanIntervalMs: 1500,
  fullSymbolRefreshMs: 900000,

  // FİLTRELER
  minVolumeUSD: 1000000,
  maxSpread: 0.15,
  
  // Strateji
  adxThreshold: 25,
  volumeMultiplier: 1.2,
  minRR: 1.5,
  
  // TP/SL
  atrSLMultiplier: 1.5,
  atrTPMultipliers: [2.5, 4.0, 6.0],
  
  // YENİ: AKILLI SİNYAL YÖNETİMİ
  signalLifetimeMinutes: 10, // Sinyal 10 dakika aktif kalsın
  signalRefreshMinutes: 2,   // 2 dakikada bir sinyali yenile
  maxSignalAgeMinutes: 30,   // Maksimum 30 dakika aynı sinyal

  // HACİMSİZ MUM FİLTRELERİ
  minCandleSizePercent: 0.001,
  minAbsoluteVolume: 1000,

  // MULTI-TIMEFRAME AYARLARI
  timeframes: ['15m', '1h', '4h'],
  timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
  
  // SLİPAJ KONTROLÜ
  maxSlippagePercent: 1.5,

  autotradeMaster: false
};

/* ====================== GLOBAL DEĞİŞKENLER ====================== */
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map(); 
const ohlcvCache = new Map();
const activeSignals = new Map(); // YENİ: Aktif sinyalleri takip

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    balance: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0 },
    activeSignalCount: 0 // YENİ: Aktif sinyal sayısı
};

/* ====================== YARDIMCILAR ====================== */
const requestQueue = {
  queue: [], running: 0, concurrency: 8,
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

class EnhancedHelpers {
  static async delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  
  static cleanSymbol(symbol) {
    if (!symbol) return '';
    return symbol.replace(/[:_]/g, '').replace('USDT', '').replace('PERP', '') + '/USDT';
  }

  static roundToTick(price) {
    if (!price || isNaN(price)) return 0;
    if (price < 0.00001) return Number(price.toFixed(8));
    if (price < 0.001) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(5));
    if (price < 10) return Number(price.toFixed(4));
    return Number(price.toFixed(2));
  }

  static async fetchOHLCV(symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = ohlcvCache.get(key);
    if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
    try {
      const data = await requestQueue.push(() => exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
      if (data && data.length) ohlcvCache.set(key, { data, ts: Date.now() });
      return data;
    } catch (e) { return null; }
  }

  static async fetchMultiTimeframeOHLCV(symbol, timeframes) {
    const results = {};
    for (const tf of timeframes) {
      results[tf] = await this.fetchOHLCV(symbol, tf, 100);
    }
    return results;
  }

  // YENİ: Sinyal durumu kontrolü
  static getSignalStatus(signal) {
    const now = Date.now();
    const signalAge = now - signal.timestamp;
    const signalAgeMinutes = signalAge / (1000 * 60);
    
    if (signalAgeMinutes > CONFIG.maxSignalAgeMinutes) {
      return 'EXPIRED';
    } else if (signalAgeMinutes > CONFIG.signalLifetimeMinutes) {
      return 'OLD';
    } else {
      return 'ACTIVE';
    }
  }
}

/* ====================== AI CONFIDENCE LAYER ====================== */
class AIConfidenceEngine {
  calculateAIDecision(matrix) {
    const totalScore = 
        matrix.technical * 0.40 +
        matrix.market * 0.20 +
        matrix.risk * 0.15 +
        matrix.position * 0.15 +
        matrix.timing * 0.05 +
        matrix.performance * 0.05;

    const confidence = Math.min(100, Math.max(0, Math.round(totalScore)));
    
    let execute = false;
    let direction = 'LONG';
    let positionSize = 'NORMAL';
    let reasoning = "";
    let riskLevel = "MEDIUM";

    direction = matrix.technical >= 55 ? 'LONG' : 'SHORT';

    if (confidence >= 75 && matrix.risk >= 70 && matrix.position >= 80) {
        execute = true;
        positionSize = 'LARGE';
        reasoning = "🚀 YÜKSEK GÜVEN - Tüm kriterler uygun";
        riskLevel = "LOW";
    }
    else if (confidence >= 68 && matrix.risk >= 60 && matrix.position >= 60) {
        execute = true;
        positionSize = 'NORMAL';
        reasoning = "✅ ORTA GÜVEN - İyi fırsat";
        riskLevel = "MEDIUM";
    }
    else if (confidence >= 62 && matrix.risk >= 50 && matrix.position >= 40) {
        execute = true;
        positionSize = 'SMALL';
        reasoning = "⚠️ DÜŞÜK GÜVEN - Küçük pozisyon";
        riskLevel = "HIGH";
    }
    else {
        execute = false;
        reasoning = "❌ RİSKLİ - Yetersiz kriter";
        riskLevel = "HIGH";
    }

    if (matrix.risk < 40) {
        execute = false;
        reasoning = "❌ YÜKSEK RİSK - İşlem engellendi";
    }

    return {
        execute,
        direction,
        confidence,
        positionSize,
        reasoning,
        riskLevel
    };
  }

  createDecisionMatrix(technicalScore, marketScore, riskScore, positionScore, timingScore, performanceScore) {
    return {
      technical: technicalScore,
      market: marketScore,
      risk: riskScore,
      position: positionScore,
      timing: timingScore,
      performance: performanceScore
    };
  }
}

const aiEngine = new AIConfidenceEngine();

/* ====================== STRATEJİ: TRENDMASTER AI SNIPER ====================== */
class TrendMasterAIStrategy {
  async analyze(symbol) {
    try {
      const lastSignalTime = signalHistory.get(symbol) || 0;
      
      // YENİ: Eski sinyali yenileme kontrolü
      const existingSignal = activeSignals.get(symbol);
      if (existingSignal) {
        const signalAge = Date.now() - existingSignal.timestamp;
        const signalAgeMinutes = signalAge / (1000 * 60);
        
        // Eğer sinyal hala aktif ve yenileme zamanı geldiyse
        if (signalAgeMinutes < CONFIG.maxSignalAgeMinutes && 
            signalAgeMinutes > CONFIG.signalRefreshMinutes) {
          // Sinyali yenile (yeni analiz yap)
          console.log(`🔄 Sinyal yenileniyor: ${symbol}`);
        } else if (signalAgeMinutes < CONFIG.signalRefreshMinutes) {
          // Henüz yenileme zamanı gelmedi, eski sinyali döndür
          return this.refreshExistingSignal(existingSignal);
        }
      }

      if (Date.now() - lastSignalTime < (CONFIG.signalCooldownMs || 1800000)) return null;

      const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
      const ohlcv15m = multiTFData['15m'];
      if (!ohlcv15m || ohlcv15m.length < 60) return null;

      const closes15m = ohlcv15m.map(c => c[4]);
      const highs15m = ohlcv15m.map(c => c[2]);
      const lows15m = ohlcv15m.map(c => c[3]);
      const volumes15m = ohlcv15m.map(c => c[5]);
      const lastClose = closes15m[closes15m.length - 1];

      // HACİMSİZ MUM KONTROLÜ
      const lastCandleSize = highs15m[highs15m.length - 1] - lows15m[lows15m.length - 1];
      const minCandleSize = lastClose * CONFIG.minCandleSizePercent;
      const lastVolume = volumes15m[volumes15m.length - 1];
      
      if (lastCandleSize < minCandleSize || lastVolume < CONFIG.minAbsoluteVolume) {
        return null;
      }

      const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
      if (!tfAnalysis.isValid) return null;

      // Ana indikatörler
      const ema9 = EMA.calculate({ period: 9, values: closes15m });
      const ema21 = EMA.calculate({ period: 21, values: closes15m });
      const rsi = RSI.calculate({ period: 14, values: closes15m });
      const adx = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const volSma = SMA.calculate({ period: 20, values: volumes15m });
      const macd = MACD.calculate({ 
        values: closes15m, 
        fastPeriod: 12, 
        slowPeriod: 26, 
        signalPeriod: 9 
      });
      const obv = OBV.calculate({ close: closes15m, volume: volumes15m });

      if (!ema9.length || !adx.length || !volSma.length || !macd.length) return null;

      const lastEMA9 = ema9[ema9.length - 1];
      const lastEMA21 = ema21[ema21.length - 1];
      const lastRSI = rsi[rsi.length - 1];
      const lastADX = adx[adx.length - 1].adx;
      const lastATR = atr[atr.length - 1];
      const lastMACD = macd[macd.length - 1];
      const lastOBV = obv[obv.length - 1];
      const prevOBV = obv[obv.length - 2];
      
      const currentVol = volumes15m[volumes15m.length - 1];
      const avgVol = volSma[volSma.length - 1];

      const isVolumeOK = currentVol > (avgVol * CONFIG.volumeMultiplier);
      if (!isVolumeOK && lastADX < 40) return null; 

      // AI Decision Matrix
      const decision = this.calculateAISignal(
        tfAnalysis, lastEMA9, lastEMA21, lastRSI, lastADX, lastMACD, lastOBV, prevOBV, isVolumeOK
      );

      if (!decision.execute) return null;

      // TP/SL Hesaplama
      const slDist = lastATR * CONFIG.atrSLMultiplier;
      const tpDist1 = lastATR * CONFIG.atrTPMultipliers[0];
      
      let sl, tp1;
      if (decision.direction === 'LONG') {
          sl = lastClose - slDist; tp1 = lastClose + tpDist1;
      } else {
          sl = lastClose + slDist; tp1 = lastClose - tpDist1;
      }
      
      const risk = Math.abs(lastClose - sl);
      const reward = Math.abs(tp1 - lastClose);
      const rr = reward / risk;
      
      if (rr < CONFIG.minRR) return null;

      signalHistory.set(symbol, Date.now());
      systemStatus.performance.totalSignals++;

      const signal = {
        id: `${symbol}_${decision.direction}_${Date.now()}`,
        coin: EnhancedHelpers.cleanSymbol(symbol),
        ccxt_symbol: symbol,
        taraf: decision.direction,
        giris: EnhancedHelpers.roundToTick(lastClose),
        tp1: EnhancedHelpers.roundToTick(tp1),
        sl: EnhancedHelpers.roundToTick(sl),
        riskReward: rr.toFixed(2),
        confidence: decision.confidence,
        positionSize: decision.positionSize,
        riskLevel: decision.riskLevel,
        tuyo: `${decision.reasoning} | MTF: ${tfAnalysis.score}/100`,
        timestamp: Date.now(),
        adx: lastADX.toFixed(0),
        rsi: lastRSI.toFixed(0),
        macd: lastMACD?.MACD?.toFixed(4) || '0',
        obvTrend: lastOBV > prevOBV ? '↑' : '↓',
        status: 'ACTIVE',
        refreshCount: existingSignal ? existingSignal.refreshCount + 1 : 0
      };

      // YENİ: Sinyali aktif sinyallere ekle
      activeSignals.set(symbol, signal);
      systemStatus.activeSignalCount = activeSignals.size;

      return signal;

    } catch (e) { 
      console.error(`Analyze error for ${symbol}:`, e.message);
      return null; 
    }
  }

  // YENİ: Mevcut sinyali yenile
  refreshExistingSignal(existingSignal) {
    const now = Date.now();
    const signalAge = now - existingSignal.timestamp;
    const signalAgeMinutes = signalAge / (1000 * 60);
    
    // Sinyal hala geçerli mi kontrol et
    if (signalAgeMinutes < CONFIG.signalLifetimeMinutes) {
      const refreshedSignal = {
        ...existingSignal,
        timestamp: now, // Zaman damgasını güncelle
        status: 'ACTIVE',
        refreshCount: existingSignal.refreshCount + 1
      };
      
      activeSignals.set(existingSignal.ccxt_symbol, refreshedSignal);
      return refreshedSignal;
    }
    
    return null;
  }

  async analyzeMultiTimeframe(multiTFData) {
    let totalScore = 0;
    let totalWeight = 0;
    let directionConsistency = 0;

    for (const [tf, ohlcv] of Object.entries(multiTFData)) {
      if (!ohlcv || ohlcv.length < 20) continue;
      
      const weight = CONFIG.timeframeWeights[tf] || 0.3;
      const tfScore = this.analyzeSingleTimeframe(ohlcv, tf);
      
      totalScore += tfScore * weight;
      totalWeight += weight;
      
      if (tfScore > 60) directionConsistency++;
    }

    const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const isValid = avgScore >= 65 && directionConsistency >= 2;

    return {
      score: Math.round(avgScore),
      isValid,
      directionConsistency
    };
  }

  analyzeSingleTimeframe(ohlcv, timeframe) {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);

    if (closes.length < 20) return 0;

    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

    if (!ema9.length || !adx.length) return 0;

    const lastEMA9 = ema9[ema9.length - 1];
    const lastEMA21 = ema21[ema21.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastADX = adx[adx.length - 1].adx;

    let score = 50;

    if (lastADX > 25) score += 20;
    if (lastADX > 40) score += 10;

    if (lastEMA9 > lastEMA21) {
      score += 15;
      if (lastRSI > 50 && lastRSI < 70) score += 10;
    } else if (lastEMA9 < lastEMA21) {
      score += 15;
      if (lastRSI < 50 && lastRSI > 30) score += 10;
    }

    if ((lastEMA9 > lastEMA21 && lastRSI > 45 && lastRSI < 75) ||
        (lastEMA9 < lastEMA21 && lastRSI < 55 && lastRSI > 25)) {
      score += 10;
    }

    return Math.min(100, score);
  }

  calculateAISignal(tfAnalysis, ema9, ema21, rsi, adx, macd, obv, prevOBV, isVolumeOK) {
    let technicalScore = tfAnalysis.score;
    
    let marketScore = 50;
    if (isVolumeOK) marketScore += 25;
    if (obv > prevOBV) marketScore += 15;
    if (macd?.MACD > macd?.signal) marketScore += 10;

    let riskScore = 70;
    if (adx < 20) riskScore -= 20;
    if (rsi > 80 || rsi < 20) riskScore -= 15;
    if (!isVolumeOK) riskScore -= 10;

    let positionScore = 60;
    const trendStrength = Math.min(100, adx * 2);
    positionScore += (trendStrength - 50) * 0.4;

    let timingScore = 50;
    if (macd?.MACD > 0 && macd?.MACD > macd?.signal) timingScore += 20;
    if (macd?.MACD < 0 && macd?.MACD < macd?.signal) timingScore += 20;

    const performanceScore = systemStatus.performance.winRate * 100;

    const matrix = aiEngine.createDecisionMatrix(
      technicalScore, marketScore, riskScore, positionScore, timingScore, performanceScore
    );

    return aiEngine.calculateAIDecision(matrix);
  }
}

const trendMaster = new TrendMasterAIStrategy();

/* ====================== TARAMA & SERVER ====================== */
class VolumeFilterScanner {
  async refreshMarketList() {
    try {
      console.log('🌍 LİSTE YENİLENİYOR...');
      await requestQueue.push(() => exchangeAdapter.raw.loadMarkets(true));
      const tickers = await requestQueue.push(() => exchangeAdapter.raw.fetchTickers());
      const allSymbols = Object.keys(exchangeAdapter.raw.markets).filter(s => s.includes('USDT') && (exchangeAdapter.raw.markets[s].swap || exchangeAdapter.raw.markets[s].future));
      
      const highVol = [];
      for (const sym of allSymbols) {
        const t = tickers[sym];
        if (t && (t.quoteVolume >= CONFIG.minVolumeUSD)) highVol.push(sym);
      }
      highVol.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));

      cachedHighVol = highVol;
      focusedSymbols = [...cachedHighVol];
      lastMarketRefresh = Date.now();
      systemStatus.filterCount = cachedHighVol.length;
      
      console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min 1M$).`);
    } catch (e) { console.error('Market refresh fail:', e.message); }
  }

  async scanLoop() {
    if (focusedSymbols.length === 0) {
        const now = Date.now();
        if (now - lastMarketRefresh > CONFIG.fullSymbolRefreshMs || cachedHighVol.length === 0) {
            await this.refreshMarketList();
        } else {
            focusedSymbols = [...cachedHighVol];
            await EnhancedHelpers.delay(1000);
        }
        return;
    }

    const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
    process.stdout.write(`\r⚡ Tarama: ${batch.length} coin... `);
    
    const results = await Promise.all(batch.map(sym => trendMaster.analyze(sym)));
    const validSignals = results.filter(s => s);
    
    if (validSignals.length > 0) {
      console.log(`\n🎯 ${validSignals.length} sinyal bulundu! (Aktif: ${systemStatus.activeSignalCount})`);
    }
    
    validSignals.forEach(signal => {
        broadcastSignal(signal);
        if (CONFIG.autotradeMaster) autoTradeSystem.execute(signal);
    });

    // YENİ: Eski sinyalleri temizle
    this.cleanupOldSignals();
  }

  // YENİ: Eski sinyalleri temizle
  cleanupOldSignals() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [symbol, signal] of activeSignals.entries()) {
      const signalAge = now - signal.timestamp;
      const signalAgeMinutes = signalAge / (1000 * 60);
      
      if (signalAgeMinutes > CONFIG.maxSignalAgeMinutes) {
        activeSignals.delete(symbol);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      systemStatus.activeSignalCount = activeSignals.size;
      console.log(`🧹 ${cleanedCount} eski sinyal temizlendi. Aktif: ${systemStatus.activeSignalCount}`);
    }
  }
}
const scanner = new VolumeFilterScanner();

/* ====================== AUTO TRADE ====================== */
class AutoTradeSystem {
  async execute(signal, isManual = false) {
    if (!CONFIG.isApiConfigured && !isManual) return;
    
    if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) {
        console.log(`\n❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Min güven: ${CONFIG.minConfidenceForAuto} isteniyor.`);
        return; 
    }
    
    try {
      console.log(`\n🚀 İŞLEM: ${signal.coin} ${signal.taraf} | Güven: %${signal.confidence} | Boyut: ${signal.positionSize}`);
      
      const symbol = signal.ccxt_symbol;
      
      // Slipaj kontrolü
      const currentPrice = await this.getCurrentPrice(symbol);
      const maxSlippage = currentPrice * (CONFIG.maxSlippagePercent / 100);
      
      if (signal.taraf === 'LONG' && signal.giris > currentPrice + maxSlippage) {
        console.log(`❌ SLİPAJ FAZLA: Giriş: ${signal.giris}, Mevcut: ${currentPrice}, Limit: %${CONFIG.maxSlippagePercent}`);
        return;
      }
      if (signal.taraf === 'SHORT' && signal.giris < currentPrice - maxSlippage) {
        console.log(`❌ SLİPAJ FAZLA: Giriş: ${signal.giris}, Mevcut: ${currentPrice}, Limit: %${CONFIG.maxSlippagePercent}`);
        return;
      }

      console.log(`✅ SLİPAJ UYGUN: Giriş: ${signal.giris}, Mevcut: ${currentPrice}`);

      // Kaldıraç ayarla
      await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
      
      // Bakiye kontrolü
      const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
      const available = parseFloat(balance.USDT?.free || 0);
      if (available < 10) {
          console.log('❌ Yetersiz bakiye');
          return;
      }
      
      // Pozisyon büyüklüğü
      let positionMultiplier = 1.0;
      if (signal.positionSize === 'LARGE') positionMultiplier = 1.5;
      if (signal.positionSize === 'SMALL') positionMultiplier = 0.5;
      
      const cost = available * (CONFIG.marginPercent / 100) * positionMultiplier;
      const amountUSDT = cost * CONFIG.leverage;
      let amountCoin = amountUSDT / signal.giris;
      
      // Precision ayarı
      let finalAmount = amountCoin;
      try {
        const market = exchangeAdapter.raw.markets[symbol];
        if (market && market.precision && market.precision.amount) {
          finalAmount = exchangeAdapter.raw.amountToPrecision(symbol, amountCoin);
        } else {
          finalAmount = Number(amountCoin.toFixed(6));
        }
      } catch (e) {
        finalAmount = Number(amountCoin.toFixed(6));
      }
      
      const side = signal.taraf === 'LONG' ? 'buy' : 'sell';
      
      console.log(`💰 ${finalAmount} ${signal.coin} | ${side.toUpperCase()} | Entry: ${signal.giris} | Risk: ${signal.riskLevel}`);
      
      // Güvenli order
      const order = await this.safeOrder(symbol, side, finalAmount, signal);
      
      if (order) {
        console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
        systemStatus.performance.executedTrades++;
        
        // YENİ: İşlem yapılan sinyali aktif listeden kaldır
        activeSignals.delete(symbol);
        systemStatus.activeSignalCount = activeSignals.size;
      } else {
        console.log('❌ EMİR BAŞARISIZ - Order null döndü');
      }
      
    } catch (e) { 
        console.error('❌ Trade Hatası:', e.message);
    }
  }

  async getCurrentPrice(symbol) {
    try {
      const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
      return ticker?.last || 0;
    } catch {
      return 0;
    }
  }

  async safeOrder(symbol, side, amount, signal) {
    try {
      const order = await requestQueue.push(() => 
        exchangeAdapter.raw.createOrder(symbol, 'market', side, amount)
      );

      if (!order) {
        console.log('⛔ API boş sonuç döndürdü!');
        return null;
      }

      if (!order.id) {
        console.log('⛔ Order ID yok!');
        return null;
      }

      console.log('✔ Order başarılı - ID:', order.id);
      return order;

    } catch (err) {
      console.log('❌ Order Hatası:', err.message);
      return null;
    }
  }

  async getPositions() {
     if(!CONFIG.isApiConfigured) return [];
     try {
         const p = await requestQueue.push(() => exchangeAdapter.raw.fetchPositions());
         return p.filter(x => parseFloat(x.contracts) > 0);
     } catch { return []; }
  }
}
const autoTradeSystem = new AutoTradeSystem();

/* ====================== ROUTING ====================== */
function broadcastSignal(signal) {
  // YENİ: Sinyal durumunu güncelle
  signal.status = EnhancedHelpers.getSignalStatus(signal);
  const msg = JSON.stringify({ type: 'signal', data: signal });
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// YENİ: Aktif sinyalleri gönder
function broadcastActiveSignals() {
  const now = Date.now();
  for (const [symbol, signal] of activeSignals.entries()) {
    signal.status = EnhancedHelpers.getSignalStatus(signal);
    const msg = JSON.stringify({ type: 'signal', data: signal });
    wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
  }
}

app.get('/api/status', async (req, res) => {
  const pos = await autoTradeSystem.getPositions();
  res.json({ 
    config: CONFIG, 
    system: systemStatus, 
    positions: pos,
    activeSignals: Array.from(activeSignals.values()) // YENİ: Aktif sinyalleri gönder
  });
});

app.post('/api/config/update', (req, res) => { Object.assign(CONFIG, req.body); res.json({ success: true }); });
app.post('/api/trade/manual', async (req, res) => { await autoTradeSystem.execute(req.body, true); res.json({ success: true }); });

async function start() {
  exchangeAdapter = { raw: new ccxt.bitget({
     apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
     options: { defaultType: 'swap' }
  })};
  if (CONFIG.isApiConfigured) {
      try {
        const b = await exchangeAdapter.raw.fetchBalance();
        systemStatus.balance = parseFloat(b.USDT?.free || 0);
      } catch(e) {}
  }
  await scanner.refreshMarketList();
  setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
  // YENİ: Aktif sinyalleri düzenli güncelle
  setInterval(() => broadcastActiveSignals(), 30000); // 30 saniyede bir
}
server.listen(PORT, () => { console.log(`🚀 UI: http://localhost:${PORT}`); start(); });
