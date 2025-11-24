// strategies/trendfollow.js
const BaseStrategy = require('./base_strategy');

class TrendFollowStrategy extends BaseStrategy {
  constructor() {
    super();
    this.name = 'trendfollow';
    this.description = 'Trend Following with EMA Crossovers';
    this.timeframes = ['1h', '4h', '1d'];
  }

  async analyze(symbol, multiTimeframeData, userConfig) {
    const signals = [];
    
    try {
      const ohlcv1h = multiTimeframeData['1h'];
      const ohlcv4h = multiTimeframeData['4h'];
      
      if (!ohlcv1h || ohlcv1h.length < 50 || !ohlcv4h || ohlcv4h.length < 25) {
        return signals;
      }

      // Use 1h for main analysis, 4h for trend confirmation
      const closes1h = ohlcv1h.map(c => c[4]);
      const highs1h = ohlcv1h.map(c => c[2]);
      const lows1h = ohlcv1h.map(c => c[3]);
      const volumes1h = ohlcv1h.map(c => c[5]);
      
      const currentPrice = closes1h[closes1h.length - 1];
      
      // Calculate indicators for 1h
      const ema9_1h = this.calculateEMA(closes1h, 9);
      const ema21_1h = this.calculateEMA(closes1h, 21);
      const ema50_1h = this.calculateEMA(closes1h, 50);
      const rsi_1h = this.calculateRSI(closes1h, 14);
      const adx_1h = this.calculateADX(highs1h, lows1h, closes1h, 14);
      const atr_1h = this.calculateATR(highs1h, lows1h, closes1h, 14);
      const macd_1h = this.calculateMACD(closes1h);
      
      // Calculate indicators for 4h trend
      const closes4h = ohlcv4h.map(c => c[4]);
      const ema21_4h = this.calculateEMA(closes4h, 21);
      const ema50_4h = this.calculateEMA(closes4h, 50);
      
      if (!ema9_1h || !ema21_1h || !ema50_1h || !rsi_1h || !adx_1h || !atr_1h) {
        return signals;
      }

      const currentEma9 = ema9_1h[ema9_1h.length - 1];
      const currentEma21 = ema21_1h[ema21_1h.length - 1];
      const currentEma50 = ema50_1h[ema50_1h.length - 1];
      const currentRsi = rsi_1h[rsi_1h.length - 1];
      const currentAdx = adx_1h[adx_1h.length - 1]?.adx || 0;
      const currentAtr = atr_1h[atr_1h.length - 1];
      
      // 4h trend
      const currentEma21_4h = ema21_4h?.[ema21_4h.length - 1];
      const currentEma50_4h = ema50_4h?.[ema50_4h.length - 1];
      
      // Volume analysis
      const volumeAnalysis = this.analyzeVolume(volumes1h, 20);
      
      let signal = null;
      
      // Trend Follow Long conditions
      if (this.isUptrend(currentEma9, currentEma21, currentEma50, currentEma21_4h, currentEma50_4h)) {
        const confidence = this.calculateTrendConfidence(
          'LONG', currentRsi, currentAdx, volumeAnalysis, macd_1h
        );
        
        if (confidence >= (userConfig.min_confidence || 60)) {
          const entry = currentPrice;
          const sl = entry - (currentAtr * (userConfig.atr_sl_multiplier || 1.5));
          const tp = entry + (currentAtr * (userConfig.atr_tp_multiplier || 2.5));
          
          signal = this.createSignal(
            symbol, 'LONG', this.name, confidence, entry, tp, sl, {
              adx: currentAdx,
              rsi: currentRsi,
              obvTrend: '↑',
              volumeLevel: volumeAnalysis.level,
              atr: currentAtr,
              trendStrength: this.calculateTrendStrength(currentEma9, currentEma21, currentEma50)
            }
          );
        }
      }
      
      // Trend Follow Short conditions
      if (this.isDowntrend(currentEma9, currentEma21, currentEma50, currentEma21_4h, currentEma50_4h)) {
        const confidence = this.calculateTrendConfidence(
          'SHORT', currentRsi, currentAdx, volumeAnalysis, macd_1h
        );
        
        if (confidence >= (userConfig.min_confidence || 60)) {
          const entry = currentPrice;
          const sl = entry + (currentAtr * (userConfig.atr_sl_multiplier || 1.5));
          const tp = entry - (currentAtr * (userConfig.atr_tp_multiplier || 2.5));
          
          signal = this.createSignal(
            symbol, 'SHORT', this.name, confidence, entry, tp, sl, {
              adx: currentAdx,
              rsi: currentRsi,
              obvTrend: '↓',
              volumeLevel: volumeAnalysis.level,
              atr: currentAtr,
              trendStrength: this.calculateTrendStrength(currentEma9, currentEma21, currentEma50)
            }
          );
        }
      }
      
      if (signal) {
        signals.push(signal);
      }
      
    } catch (error) {
      console.error(`TrendFollow strategy error for ${symbol}:`, error);
    }
    
    return signals;
  }

  isUptrend(ema9, ema21, ema50, ema21_4h, ema50_4h) {
    // All EMAs aligned upwards
    const emaAlignment = ema9 > ema21 && ema21 > ema50;
    
    // Higher timeframe confirmation (if available)
    const htConfirmation = !ema21_4h || !ema50_4h || ema21_4h > ema50_4h;
    
    return emaAlignment && htConfirmation;
  }

  isDowntrend(ema9, ema21, ema50, ema21_4h, ema50_4h) {
    // All EMAs aligned downwards
    const emaAlignment = ema9 < ema21 && ema21 < ema50;
    
    // Higher timeframe confirmation (if available)
    const htConfirmation = !ema21_4h || !ema50_4h || ema21_4h < ema50_4h;
    
    return emaAlignment && htConfirmation;
  }

  calculateTrendConfidence(direction, rsi, adx, volumeAnalysis, macd) {
    let confidence = 70; // Base confidence for trend following
    
    // ADX strength (trend strength)
    if (adx > 30) confidence += 15;
    else if (adx > 20) confidence += 8;
    else if (adx < 15) confidence -= 10;
    
    // RSI not in extreme
    if ((direction === 'LONG' && rsi < 65) || (direction === 'SHORT' && rsi > 35)) {
      confidence += 5;
    }
    
    // Volume confirmation
    if (volumeAnalysis.level === 'high') confidence += 8;
    else if (volumeAnalysis.level === 'medium') confidence += 4;
    
    // MACD confirmation
    if (macd && macd.length > 1) {
      const currentMacd = macd[macd.length - 1];
      const prevMacd = macd[macd.length - 2];
      
      if ((direction === 'LONG' && currentMacd.histogram > prevMacd.histogram && currentMacd.histogram > 0) ||
          (direction === 'SHORT' && currentMacd.histogram < prevMacd.histogram && currentMacd.histogram < 0)) {
        confidence += 8;
      }
    }
    
    return Math.min(95, confidence);
  }

  calculateTrendStrength(ema9, ema21, ema50) {
    const distance1 = Math.abs(ema9 - ema21) / ((ema9 + ema21) / 2);
    const distance2 = Math.abs(ema21 - ema50) / ((ema21 + ema50) / 2);
    return Math.round((distance1 + distance2) * 1000); // Convert to basis points
  }
}

module.exports = TrendFollowStrategy;
