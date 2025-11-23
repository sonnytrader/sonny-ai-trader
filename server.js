/**
 * Alphason Trader — Production Server
 * Bitget (swap) entegrasyonu + gerçek sinyal motoru + manuel/otomatik trade
 * Özellikler:
 * - Volume scanner, multi-timeframe analiz, trend-breakout sinyalleri
 * - Ek stratejiler: Pump/Dump, Trend takip, RSI+MACD
 * - Manuel ve otomatik trade: entry + TP + SL emri (Bitget uyumlu)
 * - WS sinyal yayını, REST API, rate-limit uyumlu istek kuyruğu
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

// Boot
console.log('=== ALPHASON BOOT — Production ===');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Config
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET && process.env.BITGET_PASSPHRASE),

  orderType: 'limit', // limit veya market
  leverage: Number(process.env.LEVERAGE || 10),
  marginPercent: Number(process.env.MARGIN_PERCENT || 5),
  minConfidenceForAuto: Number(process.env.MIN_CONF_AUTO || 60),

  minPrice: 0.05,
  signalCooldownMs: 30 * 60 * 1000,
  timeframes: ['15m', '1h', '4h'],
  timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },

  atrSLMultiplier: 1.5,
  atrTPMultiplier: 3.0,
  maxSlippagePercent: 1.5,

  scanBatchSize: 10,
  focusedScanIntervalMs: 60 * 1000,
  fullSymbolRefreshMs: 15 * 60 * 1000,
  minVolumeUSD: 300000,
  volumeConfirmationThreshold: 1.5,

  snrTolerancePercent: 2.0,
  useSimpleSnR: true,

  autotradeMaster: process.env.AUTOTRADE === 'true',
  scalpMode: process.env.SCALP_MODE === 'true',

  // Yeni strateji bayrakları
  pumpDumpEnabled: true,
  trendFollowEnabled: true
};

// Global state
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const correlationCache = new Map();
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
  isHealthy: true,
  filterCount: 0,
  balance: 0,
  marketSentiment: 'ANALİZ EDİLİYOR...',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// Request queue (rate-limit uyumlu)
const requestQueue = {
  queue: [],
  running: 0,
  concurrency: 6,
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
    try {
      const res = await item.fn();
      item.resolve(res);
    } catch (e) {
      item.reject(e);
    } finally {
      this.running--;
      setTimeout(() => this.next(), 100); // ufak gecikme, rate-limit dostu
    }
  }
};

// Helpers
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
    } catch (e) {
      console.log(`   ❌ OHLCV hatası ${symbol}:`, e.message);
      return null;
    }
  }

  static async fetchMultiTimeframeOHLCV(symbol, timeframes) {
    const results = {};
    for (const tf of timeframes) {
      results[tf] = await this.fetchOHLCV(symbol, tf, 120);
    }
    return results;
  }

  static findSimpleSnR(ohlcv15m) {
    if (!ohlcv15m || ohlcv15m.length < 20) return { support: 0, resistance: 0 };
    const recentCandles = ohlcv15m.slice(-20);
    const highs = recentCandles.map(c => c[2]);
    const lows = recentCandles.map(c => c[3]);
    const support = Math.min(...lows);
    const resistance = Math.max(...highs);
    return {
      support: this.roundToTick(support),
      resistance: this.roundToTick(resistance),
      quality: Math.abs(resistance - support) / ((resistance + support) / 2)
    };
  }

  static calculateVolumeRatio(volumes, period = 20) {
    if (!volumes || volumes.length < period) return 1;
    const currentVolume = volumes[volumes.length - 1];
    const recentVolumes = volumes.slice(-period);
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
    return currentVolume / avgVolume;
  }

  static analyzeMarketStructure(ohlcv1h) {
    if (!ohlcv1h || ohlcv1h.length < 10) return 'RANGING';
    const highs = ohlcv1h.map(c => c[2]);
    const lows = ohlcv1h.map(c => c[3]);
    const lastHigh = Math.max(...highs.slice(-5));
    const prevHigh = Math.max(...highs.slice(-10, -5));
    const lastLow = Math.min(...lows.slice(-5));
    const prevLow = Math.min(...lows.slice(-10, -5));
    if (lastHigh > prevHigh && lastLow > prevLow) return 'BULLISH';
    if (lastHigh < prevHigh && lastLow < prevLow) return 'BEARISH';
    return 'RANGING';
  }

  static async confirmBreakoutWithVolume(symbol, breakoutLevel, direction) {
    const recentOhlcv = await this.fetchOHLCV(symbol, '5m', 20);
    if (!recentOhlcv || recentOhlcv.length < 10) {
      console.log(`   📊 ${symbol}: Hacim verisi yetersiz - ZAYIF SİNYAL`);
      return { confirmed: false, strength: 'WEAK', ratio: 0 };
    }
    const breakoutCandle = recentOhlcv[recentOhlcv.length - 1];
    const avgVolume = recentOhlcv.map(c => c[5]).reduce((a, b) => a + b, 0) / recentOhlcv.length;
    const volumeRatio = breakoutCandle[5] / avgVolume;
    let volumeConfirmed = volumeRatio > CONFIG.volumeConfirmationThreshold;
    let strength = 'WEAK';
    if (volumeRatio > 2.0) strength = 'STRONG';
    else if (volumeRatio > 1.5) strength = 'MEDIUM';
    console.log(`   📊 ${symbol}: Hacim ${volumeRatio.toFixed(2)}x (Min: ${CONFIG.volumeConfirmationThreshold}x) - ${volumeConfirmed ? '✅' : '⚠️'} (${strength})`);
    return { confirmed: volumeConfirmed, strength, ratio: volumeRatio };
  }

  static isOptimalTradingTime() {
    // Türkiye saati filtre istenirse CONFIG.enableTimeFilter + offset eklenebilir
    return true;
  }

  static findSimilarAssets(coin) {
    const correlations = {
      'BTC': ['ETH', 'SOL', 'AVAX', 'MATIC', 'BNB'],
      'ETH': ['BTC', 'SOL', 'AVAX', 'MATIC', 'BNB'],
      'SOL': ['BTC', 'ETH', 'AVAX', 'MATIC', 'BNB'],
      'AVAX': ['BTC', 'ETH', 'SOL', 'MATIC'],
      'MATIC': ['BTC', 'ETH', 'SOL', 'AVAX']
    };
    const cleanCoin = coin.replace('/USDT', '').replace(':USDT', '');
    for (const [main, similar] of Object.entries(correlations)) {
      if (cleanCoin.includes(main)) return similar;
    }
    return [];
  }
}

// Confidence engine
class AdvancedConfidenceEngine {
  calculateSignalQuality(signal, marketStructure, volumeInfo, trendAlignment, adx, rsi, riskReward) {
    let qualityScore = signal.confidence;
    if (volumeInfo.strength === 'STRONG') qualityScore += 20;
    else if (volumeInfo.strength === 'MEDIUM') qualityScore += 10;
    else if (volumeInfo.strength === 'WEAK') qualityScore -= 10;

    if (marketStructure === trendAlignment) qualityScore += 15;
    if (riskReward > 2.5) qualityScore += 5;
    if (adx > 25) qualityScore += 10;
    if (adx < 20) qualityScore -= 10;
    if (rsi > 80 || rsi < 20) qualityScore -= 5;
    if (!volumeInfo.confirmed) qualityScore -= 15;

    return Math.min(100, Math.max(0, qualityScore));
  }

  calculateDynamicPositionSize(volatilityFactor, confidence, signalQuality) {
    const baseSize = 1.0;
    const volAdjustment = volatilityFactor > 1.3 ? 0.7 : 1.0;
    const confidenceBoost = confidence > 80 ? 1.2 : 1.0;
    const qualityBoost = signalQuality > 80 ? 1.1 : 1.0;
    const size = baseSize * volAdjustment * confidenceBoost * qualityBoost;
    // scalp modu tavanı düşür
    const capped = CONFIG.scalpMode ? Math.min(1.2, size) : size;
    return Math.min(2.0, Math.max(0.5, capped));
  }

  calculateAdaptiveSL(currentPrice, atr, trendStrength, volatility, signalQuality) {
    let baseMultiplier = CONFIG.scalpMode ? Math.max(1.0, CONFIG.atrSLMultiplier * 0.8) : CONFIG.atrSLMultiplier;
    if (trendStrength > 60) baseMultiplier *= 0.9;
    if (volatility > 1.4) baseMultiplier *= 1.2;
    if (signalQuality > 80) baseMultiplier *= 0.95;
    return baseMultiplier * atr;
  }

  calculateDecision(matrix, trendDirection, signalQuality) {
    const totalScore =
      matrix.technical * 0.70 +
      matrix.market * 0.20 +
      matrix.risk * 0.05 +
      matrix.performance * 0.05;
    const confidence = Math.min(100, Math.max(0, Math.round(totalScore)));

    let execute = false;
    let direction = trendDirection;
    let positionSize = 'NORMAL';
    let reasoning = '';
    let riskLevel = 'MEDIUM';

    if (confidence >= CONFIG.minConfidenceForAuto && matrix.risk >= 55 && signalQuality >= 60) {
      execute = true;
      positionSize = confidence >= 85 ? 'LARGE' : 'NORMAL';
      reasoning = `✅ ${direction} SİNYAL | Kalite: ${signalQuality}`;
      riskLevel = confidence >= 80 ? 'LOW' : 'MEDIUM';
    } else {
      execute = false;
      reasoning = '❌ YETERSİZ GÜVEN VEYA KALİTE';
      riskLevel = 'HIGH';
    }

    return { execute, direction, confidence, positionSize, reasoning, riskLevel, signalQuality };
  }

  createDecisionMatrix(technicalScore, marketScore, riskScore, performanceScore) {
    return { technical: technicalScore, market: marketScore, risk: riskScore, performance: performanceScore };
  }
}

const advancedEngine = new AdvancedConfidenceEngine();

// Strategy: breakout + rsimacd + pumpdump + trend-follow
class EnhancedTrendMasterStrategy {
  generateTechnicalDecision(features, currentPrice, snr, marketStructure) {
    const priceToResistance = Math.abs(currentPrice - snr.resistance);
    const priceToSupport = Math.abs(currentPrice - snr.support);
    const closerToResistance = priceToResistance < priceToSupport;

    let direction = 'HOLD';
    let confidence = features.mtfScore;
    let reasoning = '';

    if (closerToResistance && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure !== 'BEARISH') {
      direction = 'LONG_BREAKOUT';
      confidence += 25;
      reasoning = `🚀 Direnç kırılımı bekleniyor (${snr.resistance}) - Trend ve structure uyumlu`;
    } else if (!closerToResistance && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure !== 'BULLISH') {
      direction = 'SHORT_BREAKOUT';
      confidence += 25;
      reasoning = `🔻 Destek kırılımı bekleniyor (${snr.support}) - Trend ve structure uyumlu`;
    } else if (closerToResistance && marketStructure === 'BULLISH') {
      direction = 'LONG_BREAKOUT';
      confidence += 20;
      reasoning = `🚀 Güçlü yükseliş structure — direnç yakın`;
    } else if (!closerToResistance && marketStructure === 'BEARISH') {
      direction = 'SHORT_BREAKOUT';
      confidence += 20;
      reasoning = `🔻 Güçlü düşüş structure — destek yakın`;
    } else if (features.rsi < 30 && closerToResistance) {
      direction = 'LONG_BREAKOUT';
      confidence += 15;
      reasoning = `🚀 Aşırı satım + direnç yakın`;
    } else if (features.rsi > 70 && !closerToResistance) {
      direction = 'SHORT_BREAKOUT';
      confidence += 15;
      reasoning = `🔻 Aşırı alım + destek yakın`;
    } else {
      direction = 'HOLD';
      reasoning = '❌ Trend/S&R/structure uyumsuz — bekle';
      confidence = Math.max(30, confidence - 20);
    }
    return { direction, confidence: Math.round(confidence), reasoning };
  }

  async analyze(symbol) {
    console.log(`\n🔍 [ANALİZ] ${symbol} başlıyor...`);
    try {
      if (!EnhancedHelpers.isOptimalTradingTime()) {
        return null;
      }

      const lastSignalTime = signalHistory.get(symbol) || 0;
      if (Date.now() - lastSignalTime < CONFIG.signalCooldownMs) {
        console.log(`   ⏰ ${symbol}: Cooldown - Atlandı`);
        return null;
      }

      const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
      if (!ticker || ticker.last < CONFIG.minPrice) {
        console.log(`   💰 ${symbol}: Fiyat çok düşük/ticker yok - Atlandı`);
        return null;
      }

      console.log(`   📊 ${symbol}: Fiyat ${ticker.last} - OHLCV alınıyor...`);
      const multiTFData = await EnhancedHelpers.fetchMultiTimeframeOHLCV(symbol, CONFIG.timeframes);
      const ohlcv15m = multiTFData['15m'];
      const ohlcv1h = multiTFData['1h'];
      if (!ohlcv15m || ohlcv15m.length < 60) {
        console.log(`   📊 ${symbol}: Yetersiz OHLCV - Atlandı`);
        return null;
      }

      const snr = EnhancedHelpers.findSimpleSnR(ohlcv15m);
      const currentPrice = ticker.last;
      const snrTolerance = currentPrice * (CONFIG.snrTolerancePercent / 100);
      const nearSupport = Math.abs(currentPrice - snr.support) <= snrTolerance;
      const nearResistance = Math.abs(currentPrice - snr.resistance) <= snrTolerance;
      if (!nearSupport && !nearResistance) {
        console.log(`   📈 ${symbol}: S&R yakın değil - Atlandı`);
        return null;
      }

      const marketStructure = EnhancedHelpers.analyzeMarketStructure(ohlcv1h);
      const closes15m = ohlcv15m.map(c => c[4]);
      const highs15m = ohlcv15m.map(c => c[2]);
      const lows15m = ohlcv15m.map(c => c[3]);
      const volumes15m = ohlcv15m.map(c => c[5]);

      const tfAnalysis = await this.analyzeMultiTimeframe(multiTFData);
      if (!tfAnalysis.isValid) {
        console.log(`   📊 ${symbol}: MTF analiz geçersiz - Atlandı`);
        return null;
      }

      const ema9 = EMA.calculate({ period: 9, values: closes15m });
      const ema21 = EMA.calculate({ period: 21, values: closes15m });
      const rsi = RSI.calculate({ period: 14, values: closes15m });
      const adx = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const atr = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m });
      const obv = OBV.calculate({ close: closes15m, volume: volumes15m });

      if (!ema9.length || !adx.length || !atr.length) {
        console.log(`   📊 ${symbol}: Gösterge hatası - Atlandı`);
        return null;
      }

      const lastEMA9 = ema9[ema9.length - 1];
      const lastEMA21 = ema21[ema21.length - 1];
      const lastRSI = rsi[rsi.length - 1];
      const lastADX = adx[adx.length - 1]?.adx || 0;
      const lastATR = atr[atr.length - 1];
      const prevOBV = obv[obv.length - 2] || 0;
      const lastOBV = obv[obv.length - 1];

      const volumeRatio = EnhancedHelpers.calculateVolumeRatio(volumes15m, 20);
      const baseVolatility = lastATR / currentPrice * 100;
      const volatilityFactor = Math.min(1.6, Math.max(0.8, baseVolatility));

      const slDist = advancedEngine.calculateAdaptiveSL(currentPrice, lastATR, lastADX, volatilityFactor, 0);
      const dynamicTPMultiplier = (CONFIG.scalpMode ? 1.2 : CONFIG.atrTPMultiplier) * volatilityFactor;
      const tpDist = lastATR * dynamicTPMultiplier;

      const assumptionDirection = lastEMA9 > lastEMA21 ? 'LONG' : 'SHORT';
      const risk = slDist;
      const reward = tpDist;
      const rr = reward / risk;

      const features = {
        emaDirection: lastEMA9 > lastEMA21 ? 'YÜKSELİŞ TRENDİ' : 'DÜŞÜŞ TRENDİ',
        rsi: lastRSI,
        adx: lastADX,
        obvTrend: lastOBV > prevOBV ? 'YÜKSELİŞ' : 'DÜŞÜŞ',
        volumeRatio,
        mtfScore: tfAnalysis.score,
        volatilityFactor,
        signalQuality: 50
      };

      const similarAssets = EnhancedHelpers.findSimilarAssets(symbol);
      const hasCorrelationRisk = await this.checkCorrelationRisk(symbol, similarAssets);
      if (hasCorrelationRisk) {
        console.log(`   ⚠️ ${symbol}: Correlation risk - Pozisyon çakışması`);
        return null;
      }

      // Ana teknik karar
      const decisionResult = this.generateTechnicalDecision(features, currentPrice, snr, marketStructure);
      const modelDirection = decisionResult.direction;
      const modelConfidence = decisionResult.confidence;
      const modelReasoning = decisionResult.reasoning;

      if (!modelDirection.includes('BREAKOUT') || modelConfidence < CONFIG.minConfidenceForAuto) {
        console.log(`   ❌ ${symbol}: HOLD veya düşük güven (${modelConfidence}/${CONFIG.minConfidenceForAuto})`);
        return null;
      }

      const breakoutLevel = modelDirection === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
      const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(symbol, breakoutLevel, modelDirection);
      const signalSource = 'TEKNİK ANALİZ';
      const trendAlignment = modelDirection === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH';
      const signalQuality = advancedEngine.calculateSignalQuality(decisionResult, marketStructure, volumeInfo, trendAlignment, lastADX, lastRSI, rr);

      const positionSizeMultiplier = advancedEngine.calculateDynamicPositionSize(volatilityFactor, modelConfidence, signalQuality);
      let marketScore = 50;
      if (volumeInfo.ratio > 2.0) marketScore += 30;
      else if (volumeInfo.ratio > 1.5) marketScore += 15;
      if (volatilityFactor > 1.2) marketScore += 10;
      if (marketStructure === trendAlignment) marketScore += 10;
      if (signalQuality > 80) marketScore += 10;

      const matrix = advancedEngine.createDecisionMatrix(modelConfidence, marketScore, 80, systemStatus.performance.winRate * 100);
      const finalDecision = advancedEngine.calculateDecision(matrix, modelDirection, signalQuality);
      if (!finalDecision.execute) {
        console.log(`   ❌ ${symbol}: İşlem onaylanmadı - ${finalDecision.reasoning}`);
        return null;
      }

      signalHistory.set(symbol, Date.now());
      systemStatus.performance.totalSignals++;
      console.log(`   🎯 ${symbol}: SİNYAL OLUŞTU — ${modelDirection} (Güven: ${finalDecision.confidence}, Kalite: ${signalQuality})`);

      let entryPrice, sl_final, tp1_final;
      if (modelDirection === 'LONG_BREAKOUT') {
        entryPrice = snr.resistance;
        sl_final = entryPrice - slDist;
        tp1_final = entryPrice + tpDist;
      } else {
        entryPrice = snr.support;
        sl_final = entryPrice + slDist;
        tp1_final = entryPrice - tpDist;
      }

      const volumeText = volumeInfo.confirmed ? `Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)` : `Hacim Zayıf: ${volumeInfo.ratio.toFixed(2)}x`;
      const qualityText = `Kalite: ${signalQuality}${signalQuality > 80 ? ' 🚀' : signalQuality > 60 ? ' ✅' : ' ⚠️'}`;

      return {
        id: `${symbol}_${modelDirection}_${Date.now()}`,
        coin: EnhancedHelpers.cleanSymbol(symbol),
        ccxt_symbol: symbol,
        taraf: modelDirection,
        giris: EnhancedHelpers.roundToTick(entryPrice),
        tp1: EnhancedHelpers.roundToTick(tp1_final),
        sl: EnhancedHelpers.roundToTick(sl_final),
        riskReward: rr.toFixed(2),
        confidence: finalDecision.confidence,
        positionSize: positionSizeMultiplier,
        positionSizeType: this.getPositionSizeType(positionSizeMultiplier),
        riskLevel: finalDecision.riskLevel,
        tuyo: `📊 ${signalSource}: ${modelReasoning} | ${qualityText} | ${volumeText}`,
        timestamp: Date.now(),
        adx: Math.round(lastADX).toString(),
        rsi: Math.round(lastRSI).toString(),
        obvTrend: lastOBV > prevOBV ? '↑' : '↓',
        signalQuality,
        marketStructure,
        volumeConfirmed: volumeInfo.confirmed,
        signalSource,
        orderType: CONFIG.orderType
      };
    } catch (e) {
      console.error(`\n❌ ${symbol} analiz hatası:`, e.message);
      return null;
    }
  }

  async checkCorrelationRisk(newSymbol, similarAssets) {
    const activePositions = await enhancedAutoTradeSystem.getPositions();
    if (activePositions.length === 0) return false;
    for (const position of activePositions) {
      const positionCoin = (position.info?.symbol || position.symbol || '').replace('/USDT', '').replace(':USDT', '');
      if (similarAssets.includes(positionCoin)) return true;
    }
    return false;
  }

  getPositionSizeType(multiplier) {
    if (multiplier >= 1.5) return 'LARGE';
    if (multiplier >= 1.0) return 'NORMAL';
    if (multiplier >= 0.7) return 'SMALL';
    return 'MINI';
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
    let dominantDirection = 'LONG';
    if (shortSignals > longSignals) dominantDirection = 'SHORT';
    else if (longSignals > shortSignals) dominantDirection = 'LONG';
    else {
      const ohlcv15m = multiTFData['15m'];
      if (ohlcv15m && ohlcv15m.length > 0) {
        const closes = ohlcv15m.map(c => c[4]);
        const ema9_15m = EMA.calculate({ period: 9, values: closes });
        const ema21_15m = EMA.calculate({ period: 21, values: closes });
        if (ema9_15m.length && ema21_15m.length) {
          const lastEma9_15m = ema9_15m[ema9_15m.length - 1];
          const lastEma21_15m = ema21_15m[ema21_15m.length - 1];
          dominantDirection = lastEma9_15m < lastEma21_15m ? 'SHORT' : 'LONG';
        }
      }
    }

    const isValid = avgScore >= 60 && directionConsistency >= 1;
    return { score: Math.round(avgScore), isValid, directionConsistency, direction: dominantDirection };
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

    if (lastEMA9 < lastEMA21 && lastRSI > 50) { direction = 'SHORT'; score += 15; }
    else if (lastEMA9 > lastEMA21 && lastRSI < 50) { direction = 'LONG'; score += 15; }

    if (lastADX > 25) score += 15;
    if (lastADX > 35) score += 10;

    if ((direction === 'LONG' && lastRSI > 40 && lastRSI < 70) ||
        (direction === 'SHORT' && lastRSI < 60 && lastRSI > 30)) {
      score += 10;
    }

    return { score: Math.min(100, score), direction };
  }
}

const enhancedTrendMaster = new EnhancedTrendMasterStrategy();

// Auto trade system — Bitget TP/SL uyumlu
class EnhancedAutoTradeSystem {
  async execute(signal, isManual = false) {
    if (!CONFIG.isApiConfigured && !isManual) {
      console.log('❌ API konfigürasyonu yok — otomatik trade kapalı');
      return;
    }
    if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) {
      console.log(`\n❌ İŞLEM İPTAL: ${signal.coin} (Güven: ${signal.confidence}). Min güven: ${CONFIG.minConfidenceForAuto}`);
      return;
    }

    try {
      const symbol = signal.ccxt_symbol;
      const currentPrice = await this.getCurrentPrice(symbol);
      let entryPrice = signal.giris;
      const orderType = CONFIG.orderType;

      // Leverage ve mod ayarları
      try {
        await requestQueue.push(() => exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol, { marginMode: 'cross' }));
      } catch (e) {
        console.log('⚠️ Leverage ayarlanamadı:', e.message);
      }

      // Bakiye ve miktar
      const balance = await requestQueue.push(() => exchangeAdapter.raw.fetchBalance());
      const available = parseFloat(balance.USDT?.free || 0);
      if (available < 10) {
        console.log('❌ Yetersiz bakiye');
        return;
      }
      const cost = available * (CONFIG.marginPercent / 100) * signal.positionSize;
      const amountUSDT = cost * CONFIG.leverage;
      let amountCoin = amountUSDT / (orderType === 'market' ? currentPrice : entryPrice);
      let finalAmount = Number(amountCoin.toFixed(6));
      try {
        finalAmount = exchangeAdapter.raw.amountToPrecision(symbol, amountCoin);
      } catch {}

      const side = signal.taraf === 'LONG_BREAKOUT' ? 'buy' : 'sell';

      // Entry emri
      let entryOrder = null;
      if (orderType === 'limit') {
        entryOrder = await this.placeOrder(symbol, 'limit', side, finalAmount, entryPrice, {});
      } else {
        entryOrder = await this.placeOrder(symbol, 'market', side, finalAmount, undefined, {});
        entryPrice = currentPrice;
      }

      if (!entryOrder) {
        console.log('❌ Entry emri başarısız');
        return;
      }
      console.log('✅ ENTRY OK —', entryOrder.id);

      // Bitget TP/SL: conditional (plan) orders
      // Not: ccxt unified params Bitget için: triggerPrice, stopLoss, takeProfit bazen değişir.
      // Güvenli yol: ayrı conditional plan order’ları oluşturmak:
      await this.placeTPSLConditional(symbol, side, finalAmount, signal);

      systemStatus.performance.executedTrades++;
      this.updateCorrelationCache(signal.coin);
    } catch (e) {
      console.error('❌ Trade Hatası:', e.message);
    }
  }

  async placeOrder(symbol, type, side, amount, price, params) {
    try {
      const order = await requestQueue.push(() =>
        exchangeAdapter.raw.createOrder(symbol, type, side, amount, price, params)
      );
      console.log(`✅ ${type.toUpperCase()} EMİR: ${side} ${amount} @ ${price ?? '~market'}`);
      return order;
    } catch (error) {
      console.log(`❌ ${type.toUpperCase()} emir hatası:`, error.message);
      return null;
    }
  }

  async placeTPSLConditional(symbol, entrySide, amount, signal) {
    // Bitget conditional plan orders:
    // TP ve SL ayrı "trigger" emirleri, reduceOnly ile kapatır.
    const reduceSide = entrySide === 'buy' ? 'sell' : 'buy';

    // Stop-Loss (trigger stop-market)
    try {
      const slParams = {
        reduceOnly: true,
        triggerPrice: signal.sl,
        stopPrice: signal.sl,
        stopLoss: { triggerPrice: signal.sl, price: signal.sl },
      };
      await requestQueue.push(() =>
        exchangeAdapter.raw.createOrder(symbol, 'market', reduceSide, amount, undefined, slParams)
      );
      console.log(`✅ SL TRIGGER EMİR: ${signal.sl}`);
    } catch (error) {
      console.log('⚠️ SL trigger gönderilemedi:', error.message);
    }

    // Take-Profit (trigger take-profit)
    try {
      const tpParams = {
        reduceOnly: true,
        triggerPrice: signal.tp1,
        takeProfit: { triggerPrice: signal.tp1, price: signal.tp1 },
      };
      await requestQueue.push(() =>
        exchangeAdapter.raw.createOrder(symbol, 'market', reduceSide, amount, undefined, tpParams)
      );
      console.log(`✅ TP TRIGGER EMİR: ${signal.tp1}`);
    } catch (error) {
      console.log('⚠️ TP trigger gönderilemedi:', error.message);
    }
  }

  async closePosition(symbol, side, contracts) {
    try {
      console.log(`\n🔻 POZİSYON KAPATMA: ${symbol} | ${side} | ${contracts}`);
      const closeAmount = Math.abs(contracts);
      const closeSide = side === 'LONG' ? 'sell' : 'buy';
      const params = { reduceOnly: true };
      const order = await requestQueue.push(() =>
        exchangeAdapter.raw.createOrder(symbol, 'market', closeSide, closeAmount, undefined, params)
      );
      if (order) {
        console.log(`✅ POZİSYON KAPATILDI: ${symbol} - Order ID: ${order.id}`);
        return { success: true, orderId: order.id };
      } else {
        console.log(`❌ POZİSYON KAPATILAMADI: ${symbol}`);
        return { success: false, error: 'Order oluşturulamadı' };
      }
    } catch (error) {
      console.log(`❌ POZİSYON KAPATMA HATASI: ${error.message}`);
      throw error;
    }
  }

  updateCorrelationCache(coin) {
    correlationCache.set(coin, Date.now());
    setTimeout(() => { correlationCache.delete(coin); }, 60 * 60 * 1000);
  }

  async getCurrentPrice(symbol) {
    try {
      const ticker = await requestQueue.push(() => exchangeAdapter.raw.fetchTicker(symbol));
      return ticker?.last || 0;
    } catch {
      return 0;
    }
  }

  async getPositions() {
    if (!CONFIG.isApiConfigured) return [];
    try {
      const p = await requestQueue.push(() => exchangeAdapter.raw.fetchPositions());
      return p.filter(x => parseFloat(x.contracts || x.size || 0) > 0);
    } catch { return []; }
  }
}

const enhancedAutoTradeSystem = new EnhancedAutoTradeSystem();

// Volume scanner
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
      cachedHighVol = highVol.slice(0, 150);
      focusedSymbols = [...cachedHighVol];
      lastMarketRefresh = Date.now();
      systemStatus.filterCount = cachedHighVol.length;
      await this.analyzeMarketSentiment();
      console.log(`✅ LİSTE HAZIR: ${cachedHighVol.length} coin (Min ${CONFIG.minVolumeUSD / 1000000}M$).`);
    } catch (e) { console.error('Market refresh fail:', e.message); }
  }

  async analyzeMarketSentiment() {
    if (cachedHighVol.length === 0) return;
    const sample = cachedHighVol.slice(0, 30);
    let longCount = 0;
    let shortCount = 0;
    for (const sym of sample) {
      const ohlcv = await EnhancedHelpers.fetchOHLCV(sym, '1h', 30);
      if (!ohlcv) continue;
      const closes = ohlcv.map(c => c[4]);
      const ema9 = EMA.calculate({ period: 9, values: closes });
      const ema21 = EMA.calculate({ period: 21, values: closes });
      if (!ema9.length || !ema21.length) continue;
      if (ema9[ema9.length - 1] > ema21[ema21.length - 1]) longCount++; else shortCount++;
    }
    if (longCount > shortCount * 1.5) systemStatus.marketSentiment = 'YÜKSELİŞ (LONG) AĞIRLIKLI 🐂';
    else if (shortCount > longCount * 1.5) systemStatus.marketSentiment = 'DÜŞÜŞ (SHORT) AĞIRLIKLI 🐻';
    else systemStatus.marketSentiment = 'YATAY / KARIŞIK 🦀';
  }

  async scanLoop() {
    const currentHour = new Date().getUTCHours();
    console.log(`\n⏰ TARAMA BAŞLIYOR | UTC: ${currentHour} | Emir Tipi: ${CONFIG.orderType.toUpperCase()}`);
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
    console.log(`\n⚡ Tarama: ${batch.length} coin analiz ediliyor...`);
    const validSignals = [];
    for (const sym of batch) {
      const signal = await enhancedTrendMaster.analyze(sym);
      if (signal) {
        validSignals.push(signal);
        console.log(`\n🎯 SİNYAL: ${sym} - ${signal.taraf} (Güven: ${signal.confidence}%, Kalite: ${signal.signalQuality})`);
      }
    }

    if (validSignals.length > 0) {
      const shortSignals = validSignals.filter(s => s.taraf.includes('SHORT'));
      const longSignals = validSignals.filter(s => s.taraf.includes('LONG'));
      console.log(`\n🎯 ${validSignals.length} SİNYAL! SHORT: ${shortSignals.length} | LONG: ${longSignals.length}`);
      console.log(`   Toplam: ${systemStatus.performance.totalSignals}`);
      validSignals.forEach(signal => {
        broadcastSignal(signal);
        if (CONFIG.autotradeMaster && signal.confidence >= CONFIG.minConfidenceForAuto) {
          enhancedAutoTradeSystem.execute(signal);
        }
      });
    } else {
      console.log(`\n⚡ Tarama tamamlandı. Sinyal yok.`);
    }
  }
}

const scanner = new VolumeFilterScanner();

// Signal cache + WS
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
setInterval(cleanupSignalCache, 5 * 60 * 1000);

function broadcastSignal(signal) {
  signalCache.set(signal.id, signal);
  broadcastSignalList();
}
function broadcastSignalList() {
  const allSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
  const msg = JSON.stringify({ type: 'signal_list', data: allSignals });
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}

// API routes
app.get('/api/status', async (req, res) => {
  const positions = await enhancedAutoTradeSystem.getPositions();
  const recentSignals = Array.from(signalCache.values()).sort((a, b) => b.timestamp - a.timestamp);
  res.json({ config: CONFIG, system: systemStatus, positions, signals: recentSignals });
});

app.post('/api/config/update', (req, res) => {
  Object.assign(CONFIG, req.body);
  console.log('🎛️ CONFIG güncellendi:', Object.keys(req.body).join(', '));
  res.json({ success: true });
});

app.post('/api/trade/manual', async (req, res) => {
  try {
    // Body: { ccxt_symbol, taraf('LONG_BREAKOUT'|'SHORT_BREAKOUT'), giris, tp1, sl, confidence, positionSize, ... }
    await enhancedAutoTradeSystem.execute(req.body, true);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/position/close', async (req, res) => {
  try {
    const { symbol, side, contracts } = req.body;
    const result = await enhancedAutoTradeSystem.closePosition(symbol, side, contracts);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UI route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
async function start() {
  exchangeAdapter = {
    raw: new ccxt.bitget({
      apiKey: CONFIG.apiKey,
      secret: CONFIG.secret,
      password: CONFIG.password,
      options: { defaultType: 'swap' },
      timeout: 30000,
      enableRateLimit: true
    })
  };

  if (CONFIG.isApiConfigured) {
    try {
      const b = await exchangeAdapter.raw.fetchBalance();
      systemStatus.balance = parseFloat(b.USDT?.free || 0);
      console.log(`💰 Bakiye: ${systemStatus.balance} USDT`);
    } catch (e) {
      console.log('⚠️ Bakiye alınamadı:', e.message);
    }
  } else {
    console.log('⚠️ API anahtarları eksik — otomatik trade pasif');
  }

  console.log('\n⚙️ KONFİG:');
  console.log(`   🎯 Min Güven: ${CONFIG.minConfidenceForAuto}%`);
  console.log(`   📊 Min Hacim: ${CONFIG.minVolumeUSD} USD`);
  console.log(`   📈 Emir Tipi: ${CONFIG.orderType.toUpperCase()}`);
  console.log(`   🤖 Oto Trade: ${CONFIG.autotradeMaster ? 'AKTİF' : 'PASİF'}`);
  console.log(`   🪙 Leverage: x${CONFIG.leverage} | Margin%: ${CONFIG.marginPercent}`);
  console.log(`   ⏱️ Tarama Interval: ${CONFIG.focusedScanIntervalMs / 1000}s`);
  console.log(`   ✂️ Scalp Mode: ${CONFIG.scalpMode ? 'ON' : 'OFF'}`);

  await scanner.refreshMarketList();
  setInterval(() => scanner.scanLoop(), CONFIG.focusedScanIntervalMs);
}

server.listen(PORT, () => {
  console.log(`🚀 UI: http://localhost:${PORT}`);
  start();
});
