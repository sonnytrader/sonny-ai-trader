// strategies/breakout.js
const BaseStrategy = require('./base_strategy');

class BreakoutStrategy extends BaseStrategy {
  constructor() {
    super();
    this.name = 'breakout';
    this.description = 'Support/Resistance Breakout Strategy';
    this.timeframes = ['15m', '1h', '4h'];
  }

  async analyze(symbol, multiTimeframeData, userConfig) {
    const signals = [];
    
    try {
      const ohlcv15m = multiTimeframeData['15m'];
      const ohlcv1h = multiTimeframeData['1h'];
      
      if (!ohlcv15m || ohlcv15m.length < 50 || !ohlcv1h || ohlcv1h.length < 20) {
        return signals;
      }

      // Extract price data
      const closes15m = ohlcv15m.map(c => c[4]);
      const highs15m = ohlcv15m.map(c => c[2]);
      const lows15m = ohlcv15m.map(c => c[3]);
      const volumes15m = ohlcv15m.map(c => c[5]);
      
      const currentPrice = closes15m[closes15m.length - 1];
      
      // Calculate indicators
      const ema9 = this.calculateEMA(closes15m, 9);
      const ema21 = this.calculateEMA(closes15m, 21);
      const rsi = this.calculateRSI(closes15m, 14);
      const adx = this.calculateADX(highs15m, lows15m, closes15m, 14);
      const atr = this.calculateATR(highs15m, lows15m, closes15m, 14);
      const obv = this.calculateOBV(closes15m, volumes15m);
      
      if (!ema9 || !ema21 || !rsi || !adx || !atr) {
        return signals;
      }

      const currentEma9 = ema9[ema9.length - 1];
      const currentEma21 = ema21[ema21.length - 1];
      const currentRsi = rsi[rsi.length - 1];
      const currentAdx = adx[adx.length - 1]?.adx || 0;
      const currentAtr = atr[atr.length - 1];
      const obvTrend = obv[obv.length - 1] > obv[obv.length - 2] ? '↑' : '↓';
      
      // Calculate Support/Resistance
      const snr = this.calculateSupportResistance(highs15m, lows15m, 30);
      const tolerance = currentPrice * (userConfig.snr_tolerance_percent || 2.0) / 100;
      
      const nearResistance = Math.abs(currentPrice - snr.resistance) <= tolerance;
      const nearSupport = Math.abs(currentPrice - snr.support) <= tolerance;
      
      // Volume analysis
      const volumeAnalysis = this.analyzeVolume(volumes15m, 20);
      
      // Market structure
      const marketStructure = this.analyzeMarketStructure(ohlcv1h);
      
      let signal = null;
      
      // Breakout Long conditions
      if (nearResistance && currentEma9 >= currentEma21 && marketStructure !== 'BEARISH') {
        const confidence = this.calculateBreakoutConfidence(
          'LONG', currentRsi, currentAdx, volumeAnalysis, marketStructure, obvTrend
        );
        
        if (confidence >= (userConfig.min_confidence || 60)) {
          const entry = snr.resistance;
          const sl = entry - (currentAtr * (userConfig.atr_sl_multiplier || 1.5));
          const tp = entry + (currentAtr * (userConfig.atr_tp_multiplier || 3.0));
          
          signal = this.createSignal(
            symbol, 'LONG', this.name, confidence, entry, tp, sl, {
              adx: currentAdx,
              rsi: currentRsi,
              obvTrend,
              volumeLevel: volumeAnalysis.level,
              atr: currentAtr,
              snr
            }
          );
        }
      }
      
      // Breakout Short conditions
      if (nearSupport && currentEma9 <= currentEma21 && marketStructure !== 'BULLISH') {
        const confidence = this.calculateBreakoutConfidence(
          'SHORT', currentRsi, currentAdx, volumeAnalysis, marketStructure, obvTrend
        );
        
        if (confidence >= (userConfig.min_confidence || 60)) {
          const entry = snr.support;
          const sl = entry + (currentAtr * (userConfig.atr_sl_multiplier || 1.5));
          const tp = entry - (currentAtr * (userConfig.atr_tp_multiplier || 3.0));
          
          signal = this.createSignal(
            symbol, 'SHORT', this.name, confidence, entry, tp, sl, {
              adx: currentAdx,
              rsi: currentRsi,
              obvTrend,
              volumeLevel: volumeAnalysis.level,
              atr: currentAtr,
              snr
            }
          );
        }
      }
      
      if (signal) {
        signals.push(signal);
      }
      
    } catch (error) {
      console.error(`Breakout strategy error for ${symbol}:`, error);
    }
    
    return signals;
  }

  calculateBreakoutConfidence(direction, rsi, adx, volumeAnalysis, marketStructure, obvTrend) {
    let confidence = 65; // Base confidence
    
    // RSI adjustment
    if (direction === 'LONG' && rsi < 70) confidence += 5;
    if (direction === 'SHORT' && rsi > 30) confidence += 5;
    
    // ADX strength
    if (adx > 25) confidence += 10;
    else if (adx < 15) confidence -= 5;
    
    // Volume confirmation
    if (volumeAnalysis.level === 'high') confidence += 15;
    else if (volumeAnalysis.level === 'medium') confidence += 8;
    else confidence -= 5;
    
    // Market structure alignment
    if ((direction === 'LONG' && marketStructure === 'BULLISH') ||
        (direction === 'SHORT' && marketStructure === 'BEARISH')) {
      confidence += 10;
    }
    
    // OBV confirmation
    if ((direction === 'LONG' && obvTrend === '↑') ||
        (direction === 'SHORT' && obvTrend === '↓')) {
      confidence += 5;
    }
    
    return Math.min(95, confidence);
  }

  analyzeMarketStructure(ohlcv1h) {
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
}

module.exports = BreakoutStrategy;
