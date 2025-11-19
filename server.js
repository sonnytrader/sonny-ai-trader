/**
 * server.js - TrendMaster SNIPER AI v35.4 - DENGELİ
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

/* ====================== BOOT ====================== */
console.log('=== SERVER BOOT (TrendMaster v35.4 - DENGELİ) ===');
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

  // FİLTRELER - DENGELİ
  minConfidenceForAuto: 65,
  minVolumeUSD: 200000,
  volumeMultiplier: 1.2,
  adxThreshold: 25,
  minRR: 1.5,
  
  // DEĞİŞKEN RR SİSTEMİ
  atrSLMultiplier: 1.5,
  atrTPMultipliers: [2.5, 4.0, 6.0],
  
  // Spam Koruması
  signalCooldownMs: 30 * 60 * 1000,

  // YENİ FİLTRELER
  minPrice: 0.05,
  maxDailySignals: 15,
  requireAllTimeframes: false,

  // MUM FİLTRELERİ
  minCandleSizePercent: 0.0015,
  minAbsoluteVolume: 2000,

  // MULTI-TIMEFRAME AYARLARI
  timeframes: ['15m', '1h', '4h'],
  timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
  
  // SLİPAJ KONTROLÜ
  maxSlippagePercent: 1.5, 

  // OTOMATİK TRADE
  autotradeMaster: false,

  // ⚡ EKSİK TARAMA AYARLARI - EKLENDİ
  scanBatchSize: 50,
  focusedScanIntervalMs: 5000,
  fullSymbolRefreshMs: 20 * 60 * 1000
};

/* ====================== GLOBAL DEĞİŞKENLER ====================== */
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map(); 
const ohlcvCache = new Map();
const signalCache = new Map();
const SIGNAL_CACHE_DURATION = 15 * 60 * 1000;

const systemStatus = { 
    isHealthy: true, 
    filterCount: 0, 
    balance: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, dailySignals: 0, lastReset: Date.now() }
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
    const parts = symbol.split('/');
    return parts[0] + '/USDT';
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

  static resetDailySignals() {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (now - systemStatus.performance.lastReset > oneDay) {
      systemStatus.performance.dailySignals = 0;
      systemStatus.performance.lastReset = now;
    }
  }
}

/* ====================== AI CONFIDENCE LAYER ====================== */
class AIConfidenceEngine {
  calculateAIDecision(matrix, trendDirection) {
    const totalScore = 
        matrix.technical * 0.40 +
        matrix.market * 0.20 +
        matrix.risk * 0.15 +
        matrix.position * 0.15 +
        matrix.timing * 0.05 +
        matrix.performance * 0.05;
    const confidence = Math.min(100, Math.max(0, Math.round(totalScore)));
    
    let execute = false;
    let direction = trendDirection;
    let positionSize = 'NORMAL';
    let reasoning = "";
    let riskLevel = "MEDIUM";
    
    // DENGELİ GÜVEN FİLTRESİ
    if (confidence >= CONFIG.minConfidenceForAuto && matrix.risk >= 55) {
        execute = true;
        positionSize = confidence >= 82 ? 'LARGE' : 'NORMAL';
        reasoning = `✅ ${direction} SİNYAL`;
        riskLevel = confidence >= 78 ? "LOW" : "MEDIUM";
    }
    else {
        execute = false;
        reasoning = "❌ YETERSİZ GÜVEN";
        riskLevel = "HIGH";
    }

    return { execute, direction, confidence, positionSize, reasoning, riskLevel };
  }

  createDecisionMatrix(technicalScore, marketScore, riskScore, positionScore, timingScore, performanceScore) {
    return { technical: technicalScore, market: marketScore, risk: riskScore, position: positionScore, timing: timingScore, performance: performanceScore };
  }
}

const aiEngine = new AIConfidenceEngine();

/* ====================== STRATEJİ - DENGELİ ====================== */
class TrendMasterAIStrategy {
  async analyze(symbol) {
    try {
      // Günlük sinyal limiti
      EnhancedHelpers.resetDailySignals();
      if (systemStatus.performance.dailySignals >= CONFIG.maxDailySignals) {
        return null;
      }

      const lastSignalTime = signalHistory.get(symbol) || 0;
      if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) return null;

      // Fiyat filtreleme
      const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
      if (!ticker || ticker.last < CONFIG.minPrice) return null;

      const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
      const ohlcv15m = multiTFData['15m'];
      if (!ohlcv15m || ohlcv15m.length < 60) return null;

      const closes15m = ohlcv15m.map(c => c[4]);
      const highs15m = ohlcv15m.map(c => c[2]);
      const lows15m = ohlcv15m.map(c => c[3]);
      const volumes15m = ohlcv15m.map(c => c[5]);
      const lastClose = closes15m[closes15m.length - 1];

      // Mum filtreleri
      const lastCandleSize = highs15m[highs15m.length - 1] - lows15m[lows15m.length - 1];
      const minCandleSize = lastClose * CONFIG.minCandleSizePercent;
      const lastVolume = volumes15m[volumes15m.length - 1];
      if (lastCandleSize < minCandleSize || lastVolume < CONFIG.minAbsoluteVolume) {
        return null;
      }

      const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
      if (!tfAnalysis.isValid) return null;

      const ema9 = EMA.calculate({ period: 9, values: closes15m });
      const ema21 = EMA.calculate({ period: 21, values: closes15m });
      const rsi = RSI.calculate({ period: 14, values: closes15m });
      const adx = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const volSma = SMA.calculate({ period: 20, values: volumes15m });
      const macd = MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
      const obv = OBV.calculate({ close: closes15m, volume: volumes15m });

      if (!ema9.length || !adx.length || !volSma.length || !macd.length) return null;
      
      const lastEMA9 = ema9[ema9.length - 1];
      const lastEMA21 = ema21[ema21.length - 1];
      const lastRSI = rsi[rsi.length - 1];
      const lastADX = adx[adx.length - 1].adx;
      const lastATR = atr[atr.length - 1];
      const lastMACD = macd[macd.length - 1];
      const lastOBV = obv[obv.length - 1];
      const prevOBV = obv[obv.length - 2] || 0;
      const currentVol = volumes15m[volumes15m.length - 1];
      const avgVol = volSma[volSma.length - 1] || 1;
      
      // VOLUME FİLTRESİ
      const isVolumeOK = currentVol > (avgVol * CONFIG.volumeMultiplier);
      if (!isVolumeOK) return null;

      // ADX FİLTRESİ
      if (lastADX < CONFIG.adxThreshold) return null;

      // DOĞRU TREND YÖNÜ - Hem LONG hem SHORT için
      let trendDirection = 'LONG';
      if (lastEMA9 < lastEMA21 && lastRSI > 45) {
          trendDirection = 'SHORT';
      } else if (lastEMA9 > lastEMA21 && lastRSI < 65) {
          trendDirection = 'LONG';
      } else {
          return null; // Trend belirsiz
      }

      // RSI FİLTRESİ - Aşırı uçları ele
      if (lastRSI > 75 || lastRSI < 25) return null;

      const decision = this.calculateAISignal(
        tfAnalysis, lastEMA9, lastEMA21, lastRSI, lastADX, lastMACD, lastOBV, prevOBV, isVolumeOK, trendDirection
      );
      
      if (!decision.execute) return null;

      // DEĞİŞKEN RR SİSTEMİ
      const volatilityFactor = Math.min(1.6, Math.max(0.8, lastATR / lastClose * 800));
      const slDist = lastATR * CONFIG.atrSLMultiplier * volatilityFactor;
      const tpDist1 = lastATR * CONFIG.atrTPMultipliers[0] * volatilityFactor;
      
      let sl, tp1;
      if (decision.direction === 'LONG') {
          sl = lastClose - slDist;
          tp1 = lastClose + tpDist1;
      } else {
          sl = lastClose + slDist;
          tp1 = lastClose - tpDist1;
      }
      
      const risk = Math.abs(lastClose - sl);
      const reward = Math.abs(tp1 - lastClose);
      const rr = reward / risk;
      
      if (rr < CONFIG.minRR) return null;

      signalHistory.set(symbol, Date.now());
      systemStatus.performance.totalSignals++;
      systemStatus.performance.dailySignals++;

      // ANALİZ METNİ
      const volumeAnalysis = currentVol > (avgVol * 2.5) ? "🔥 AŞIRI HACİM" :
                           currentVol > (avgVol * 1.8) ? "📈 YÜKSEK HACİM" :
                           "✅ NORMAL HACİM";

      let trendAnalysis = "";
      if (lastADX > 40) trendAnalysis = "🚀 GÜÇLÜ TREND";
      else if (lastADX > 28) trendAnalysis = "📊 ORTA TREND"; 
      else trendAnalysis = "🔄 ZAYIF TREND";

      let rsiAnalysis = "";
      if (lastRSI > 70) rsiAnalysis = "⚡ AŞIRI ALIM";
      else if (lastRSI > 55) rsiAnalysis = "📈 ALIM";
      else if (lastRSI < 30) rsiAnalysis = "💧 AŞIRI SATIM";
      else if (lastRSI < 45) rsiAnalysis = "📉 SATIM";
      else rsiAnalysis = "⚖️ NÖTR";

      const analysis = `${volumeAnalysis} | ${trendAnalysis} | RSI: ${rsiAnalysis} | MTF: ${tfAnalysis.score}/100`;

      return {
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
        tuyo: analysis,
        timestamp: Date.now(),
        adx: lastADX.toFixed(0),
        rsi: lastRSI.toFixed(0),
        macd: lastMACD?.MACD?.toFixed(4) || '0',
        obvTrend: lastOBV > prevOBV ? '↑' : '↓'
      };

    } catch (e) { 
      console.error(`Analyze error for ${symbol}:`, e.message);
      return null; 
    }
  }

  async analyzeMultiTimeframe(multiTFData) {
    let totalScore = 0;
    let totalWeight = 0;
    let directionConsistency = 0;
    let longSignals = 0;
    let shortSignals = 0;

    for (const [tf, ohlcv] of Object.entries(multiTFData)) {
      if (!ohlcv || ohlcv.length < 20) continue;
      const weight = CONFIG.timeframeWeights[tf] || 0.3;
      const tfAnalysis = this.analyzeSingleTimeframe(ohlcv);
      totalScore += tfAnalysis.score * weight;
      totalWeight += weight;
      
      if (tfAnalysis.score > 60) directionConsistency++;
      if (tfAnalysis.direction === 'LONG') longSignals++;
      if (tfAnalysis.direction === 'SHORT') shortSignals++;
    }

    const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    
    // TREND YÖNÜ BELİRLE
    let dominantDirection = 'LONG';
    if (shortSignals > longSignals) {
        dominantDirection = 'SHORT';
    }
    
    const isValid = avgScore >= 65 && directionConsistency >= 2;
    
    return { 
        score: Math.round(avgScore), 
        isValid, 
        directionConsistency,
        direction: dominantDirection 
    };
  }

  analyzeSingleTimeframe(ohlcv) {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);

    if (closes.length < 20) return { score: 0, direction: 'LONG' };
    
    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

    if (!ema9.length || !adx.length) return { score: 0, direction: 'LONG' };

    const lastEMA9 = ema9[ema9.length - 1];
    const lastEMA21 = ema21[ema21.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastADX = adx[adx.length - 1].adx;

    let score = 50;
    let direction = 'LONG';

    // TREND YÖNÜ BELİRLE
    if (lastEMA9 < lastEMA21 && lastRSI > 45) {
        direction = 'SHORT';
        score += 15;
    } else if (lastEMA9 > lastEMA21 && lastRSI < 65) {
        direction = 'LONG';
        score += 15;
    }

    if (lastADX > 25) score += 15;
    if (lastADX > 35) score += 10;

    if ((direction === 'LONG' && lastRSI > 40 && lastRSI < 70) ||
        (direction === 'SHORT' && lastRSI < 60 && lastRSI > 30)) {
      score += 10;
    }

    return { score: Math.min(100, score), direction };
  }

  calculateAISignal(tfAnalysis, ema9, ema21, rsi, adx, macd, obv, prevOBV, isVolumeOK, trendDirection) {
    let technicalScore = tfAnalysis.score;
    let marketScore = 50;
    if (isVolumeOK) marketScore += 20;
    if (obv > prevOBV && trendDirection === 'LONG') marketScore += 15;
    if (obv < prevOBV && trendDirection === 'SHORT') marketScore += 15;
    if (macd?.MACD > macd?.signal && trendDirection === 'LONG') marketScore += 10;
    if (macd?.MACD < macd?.signal && trendDirection === 'SHORT') marketScore += 10;
    
    let riskScore = 65;
    if (adx > 25) riskScore += 10;
    if (adx > 35) riskScore += 10;
    if (rsi > 35 && rsi < 65) riskScore += 10;
    
    let positionScore = 60;
    const trendStrength = Math.min(100, adx * 2);
    positionScore += (trendStrength - 50) * 0.3;

    let timingScore = 50;
    if (macd?.MACD > 0 && macd?.MACD > macd?.signal && trendDirection === 'LONG') timingScore += 20;
    if (macd?.MACD < 0 && macd?.MACD < macd?.signal && trendDirection === 'SHORT') timingScore += 20;
    
    const performanceScore = systemStatus.performance.winRate * 100;
    
    const matrix = aiEngine.createDecisionMatrix(
      technicalScore, marketScore, riskScore, positionScore, timingScore, performanceScore
    );
    
    return aiEngine.calculateAIDecision(matrix, trendDirection);
  }
}

const trendMaster = new TrendMasterAIStrategy();

/* ====================== PİYASA ANALİZİ ====================== */
async function analyzeMarketSentiment() {
    if (cachedHighVol.length === 0) return;
    const sample = cachedHighVol.slice(0, 30);
    let longCount = 0;
    let shortCount = 0;
    for(const sym of sample) {
        const ohlcv = await EnhancedHelpers.fetchOHLCV(sym, '1h', 30);
        if(!ohlcv) continue;
        const closes = ohlcv.map(c=>c[4]);
        const ema9 = EMA.calculate({period:9, values:closes});
        const ema21 = EMA.calculate({period:21, values:closes});
        if(!ema9.length) continue;
        if(ema9[ema9.length - 1] > ema21[ema9.length - 1]) longCount++; else shortCount++;
    }

    if (longCount > shortCount * 1.5) systemStatus.marketSentiment = "YÜKSELİŞ (LONG) AĞIRLIKLI 🐂";
    else if (shortCount > longCount * 1.5) systemStatus.marketSentiment = "DÜŞÜŞ (SHORT) AĞIRLIKLI 🐻";
    else systemStatus.marketSentiment = "YATAY / KARIŞIK 🦀";
}

/* ====================== TARAMA & SERVER ====================== */
class VolumeFilterScanner {
  async refreshMarketList() {
    try {
      console.log('🌍 LİSTE YENİLENİYOR...');
      await requestQueue.push(() => exchangeAdapter.raw.loadMarkets(true));
      const tickers = await requestQueue.push(() => exchangeAdapter.raw.fetchTickers());
      
      const allSymbols = Object.keys(exchangeAdapter.raw.markets).filter(s => {
          const market = exchangeAdapter.raw.markets[s];
          return market.active && s.includes('USDT') && (market.swap || market.future);
      });
      
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
      
      analyzeMarketSentiment();
      
      console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${CONFIG.minVolumeUSD/1000000}M$).`);
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
      const shortSignals = validSignals.filter(s => s.taraf === 'SHORT');
      const longSignals = validSignals.filter(s => s.taraf === 'LONG');
      
      console.log(`\n🎯 ${validSignals.length} sinyal (SHORT: ${shortSignals.length}, LONG: ${longSignals.length}) Günlük: ${systemStatus.performance.dailySignals}/${CONFIG.maxDailySignals}`);
      
      validSignals.forEach(signal => {
          broadcastSignal(signal);
          if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
              autoTradeSystem.execute(signal);
          }
      });
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
      
      await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
      const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
      const available = parseFloat(balance.USDT?.free || 0);
      if (available < 10) {
          console.log('❌ Yetersiz bakiye');
          return;
      }
      
      let positionMultiplier = 1.0;
      if (signal.positionSize === 'LARGE') positionMultiplier = 1.5;
      if (signal.positionSize === 'SMALL') positionMultiplier = 0.5;
      const cost = available * (CONFIG.marginPercent / 100) * positionMultiplier;
      const amountUSDT = cost * CONFIG.leverage;
      let amountCoin = amountUSDT / signal.giris;
      
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
      
      const order = await this.safeOrder(symbol, side, finalAmount, signal);
      if (order) {
        console.log('✅ EMİR BAŞARILI - Order ID:', order.id);
        systemStatus.performance.executedTrades++;
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
      const params = {};
      console.log(`📡 Order Parametreleri (One-Way Safe): Yön=${side}, Miktar=${amount}`);
      const order = await requestQueue.push(() => 
        exchangeAdapter.raw.createOrder(symbol, 'market', side, amount, undefined, params)
      );
      if (!order) {
        console.log('⛔ API boş sonuç döndürdü!');
        return null;
      }
      if (!order.id) {
        console.log('⛔ Order oluşturuldu ama ID dönmedi!');
        return null;
      }
      return order;
    } catch (err) {
      console.log('❌ Order API Hatası:', err.message);
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

/* ====================== SİNYAL YÖNETİMİ ====================== */
function cleanupSignalCache() {
    const now = Date.now();
    let removedCount = 0;
    for (const [key, signal] of signalCache.entries()) {
        if (now - signal.timestamp > SIGNAL_CACHE_DURATION) {
            signalCache.delete(key);
            removedCount++;
        }
    }
    if (removedCount > 0) {
        console.log(`🧹 ${removedCount} eski sinyal temizlendi`);
        broadcastSignalList();
    }
}

setInterval(cleanupSignalCache, 60000);

/* ====================== ROUTING & WEBSOCKET ====================== */
function broadcastSignal(signal) {
    signalCache.set(signal.id, signal);
    broadcastSignalList();
}

function broadcastSignalList() {
    const allSignals = Array.from(signalCache.values())
        .sort((a, b) => b.timestamp - a.timestamp);
    
    const msg = JSON.stringify({ 
        type: 'signal_list', 
        data: allSignals 
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

app.get('/api/status', async (req, res) => {
  const positions = await autoTradeSystem.getPositions();
  const recentSignals = Array.from(signalCache.values())
      .sort((a, b) => b.timestamp - a.timestamp);
      
  res.json({ 
      config: CONFIG, 
      system: systemStatus, 
      positions: positions,
      signals: recentSignals
  });
});

app.post('/api/config/update', (req, res) => { 
    if (req.body.minConfidenceForAuto !== undefined) {
        CONFIG.minConfidenceForAuto = parseInt(req.body.minConfidenceForAuto);
        console.log(`🎯 Güven filtresi güncellendi: ${CONFIG.minConfidenceForAuto}`);
    }
    Object.assign(CONFIG, req.body); 
    res.json({ success: true }); 
});

app.post('/api/trade/manual', async (req, res) => { 
    await autoTradeSystem.execute(req.body, true); 
    res.json({ success: true }); 
});

/* ====================== BAŞLANGIÇ ====================== */
async function start() {
  exchangeAdapter = { raw: new ccxt.bitget({
     apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
     options: { defaultType: 'swap' }
  })};
  
  if (CONFIG.isApiConfigured) {
      try {
        const b = await exchangeAdapter.raw.fetchBalance();
        systemStatus.balance = parseFloat(b.USDT?.free || 0);
        console.log(`💰 Bakiye: ${systemStatus.balance} USDT`);
      } catch(e) {
         console.log("Bakiye alınamadı:", e.message);
      }
  }
  await scanner.refreshMarketList();
  setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, () => { 
    console.log(`🚀 UI: http://localhost:${PORT}`); 
    start(); 
});

