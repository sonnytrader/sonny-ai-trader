// strategies/base_strategy.js
const { EMA, RSI, ADX, ATR, OBV, MACD, Stochastic } = require('technicalindicators');

class BaseStrategy {
  constructor() {
    this.name = 'base';
    this.description = 'Base strategy class';
    this.timeframes = ['15m', '1h', '4h'];
  }

  // Common indicator calculations
  calculateEMA(data, period) {
    return EMA.calculate({ period, values: data });
  }

  calculateRSI(data, period = 14) {
    return RSI.calculate({ period, values: data });
  }

  calculateADX(highs, lows, closes, period = 14) {
    return ADX.calculate({ period, high: highs, low: lows, close: closes });
  }

  calculateATR(highs, lows, closes, period = 14) {
    return ATR.calculate({ period, high: highs, low: lows, close: closes });
  }

  calculateOBV(closes, volumes) {
    return OBV.calculate({ close: closes, volume: volumes });
  }

  calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    return MACD.calculate({
      values: closes,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
  }

  calculateStochastic(highs, lows, closes, period = 14, signalPeriod = 3) {
    return Stochastic.calculate({
      high: highs,
      low: lows,
      close: closes,
      period,
      signalPeriod
    });
  }

  // Common signal formatting
  createSignal(symbol, direction, strategy, confidence, entry, tp, sl, indicators) {
    return {
      id: `${symbol}_${strategy}_${direction}_${Date.now()}`,
      coin: symbol.replace(':USDT', '').replace('/USDT', '') + '/USDT',
      ccxt_symbol: symbol,
      direction,
      strategy,
      giris: this.roundPrice(entry),
      tp1: this.roundPrice(tp),
      sl: this.roundPrice(sl),
      riskReward: Math.abs((tp - entry) / (entry - sl)),
      confidence: Math.min(100, Math.max(0, Math.round(confidence))),
      signalQuality: this.calculateSignalQuality(confidence, indicators),
      volumeLevel: indicators.volumeLevel || 'medium',
      narrative: this.generateNarrative(direction, strategy, indicators),
      positionSize: 1.0,
      positionSizeType: 'NORMAL',
      riskLevel: confidence >= 80 ? 'LOW' : confidence >= 60 ? 'MEDIUM' : 'HIGH',
      adx: indicators.adx ? Math.round(indicators.adx) : 0,
      rsi: indicators.rsi ? Math.round(indicators.rsi) : 0,
      obvTrend: indicators.obvTrend || '→',
      timestamp: Date.now(),
      indicators: indicators
    };
  }

  roundPrice(price) {
    if (!price || isNaN(price)) return 0;
    if (price < 0.00001) return Number(price.toFixed(8));
    if (price < 0.001) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(5));
    if (price < 10) return Number(price.toFixed(4));
    return Number(price.toFixed(2));
  }

  calculateSignalQuality(confidence, indicators) {
    let quality = confidence;
    
    // ADX strength
    if (indicators.adx > 25) quality += 10;
    else if (indicators.adx < 15) quality -= 5;
    
    // Volume confirmation
    if (indicators.volumeLevel === 'high') quality += 15;
    else if (indicators.volumeLevel === 'medium') quality += 8;
    else quality -= 5;
    
    // RSI extremes
    if (indicators.rsi > 80 || indicators.rsi < 20) quality -= 10;
    
    return Math.min(100, Math.max(0, Math.round(quality)));
  }

  generateNarrative(direction, strategy, indicators) {
    const narratives = {
      breakout: {
        LONG: `Fiyat direnç seviyesini kırmak üzere. ${indicators.adx > 25 ? 'Güçlü trend' : 'Trend oluşuyor'}.`,
        SHORT: `Fiyat destek seviyesini kırmak üzere. ${indicators.adx > 25 ? 'Güçlü trend' : 'Trend oluşuyor'}.`
      },
      trendfollow: {
        LONG: `EMA crossover yukarı yönlü. ${indicators.adx > 25 ? 'Trend güçlü' : 'Trend başlangıcı'}.`,
        SHORT: `EMA crossover aşağı yönlü. ${indicators.adx > 25 ? 'Trend güçlü' : 'Trend başlangıcı'}.`
      },
      pumpdump: {
        LONG: `Anormal hacim artışı ile yukarı hareket. ${indicators.volumeLevel === 'high' ? 'Güçlü hacim' : 'Orta hacim'}.`,
        SHORT: `Anormal hacim artışı ile aşağı hareket. ${indicators.volumeLevel === 'high' ? 'Güçlü hacim' : 'Orta hacim'}.`
      }
    };
    
    return narratives[strategy]?.[direction] || `${direction} sinyali - ${strategy} stratejisi`;
  }

  // Volume analysis
  analyzeVolume(volumes, period = 20) {
    if (!volumes || volumes.length < period) return { ratio: 1, level: 'low' };
    
    const currentVolume = volumes[volumes.length - 1];
    const averageVolume = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const ratio = currentVolume / averageVolume;
    
    let level = 'low';
    if (ratio > 3.0) level = 'high';
    else if (ratio > 1.8) level = 'medium';
    
    return { ratio, level };
  }

  // Support Resistance calculation
  calculateSupportResistance(highs, lows, lookback = 30) {
    if (!highs || !lows || highs.length < lookback) {
      return { support: 0, resistance: 0, quality: 0 };
    }
    
    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);
    
    const support = Math.min(...recentLows);
    const resistance = Math.max(...recentHighs);
    const quality = (resistance - support) / ((resistance + support) / 2);
    
    return {
      support: this.roundPrice(support),
      resistance: this.roundPrice(resistance),
      quality
    };
  }

  // Abstract method - to be implemented by child classes
  async analyze(symbol, multiTimeframeData, userConfig) {
    throw new Error('Analyze method must be implemented by child class');
  }
}

module.exports = BaseStrategy;
