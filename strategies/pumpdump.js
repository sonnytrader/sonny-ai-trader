// strategies/pumpdump.js
const BaseStrategy = require('./base_strategy');

class PumpDumpStrategy extends BaseStrategy {
  constructor() {
    super();
    this.name = 'pumpdump';
    this.description = 'Pump and Dump Detection Strategy';
    this.timeframes = ['5m', '15m', '1h'];
  }

  async analyze(symbol, multiTimeframeData, userConfig) {
    const signals = [];
    
    try {
      const ohlcv5m = multiTimeframeData['5m'];
      const ohlcv15m = multiTimeframeData['15m'];
      
      if (!ohlcv5m || ohlcv5m.length < 20 || !ohlcv15m || ohlcv15m.length < 10) {
        return signals;
      }

      // Use 5m for quick detection, 15m for confirmation
      const closes5m = ohlcv5m.map(c => c[4]);
      const volumes5m = ohlcv5m.map(c => c[5]);
      
      const closes15m = ohlcv15m.map(c => c[4]);
      const volumes15m = ohlcv15m.map(c => c[5]);
      
      const currentPrice5m = closes5m[closes5m.length - 1];
      const prevPrice5m = closes5m[closes5m.length - 2];
      const currentVolume5m = volumes5m[volumes5m.length - 1];
      
      // Calculate volume indicators
      const volumeAnalysis5m = this.analyzeVolume(volumes5m, 10);
      const volumeAnalysis15m = this.analyzeVolume(volumes15m, 20);
      
      // Price movement analysis
      const priceChange5m = ((currentPrice5m - prevPrice5m) / prevPrice5m) * 100;
      const volatility5m = this.calculateVolatility(closes5m, 10);
      
      // RSI for overbought/oversold
      const rsi5m = this.calculateRSI(closes5m, 14);
      const currentRsi = rsi5m?.[rsi5m.length - 1] || 50;
      
      let signal = null;
      
      // Pump detection (abnormal volume + price spike)
      if (this.isPumpSignal(priceChange5m, volumeAnalysis5m, volumeAnalysis15m, currentRsi)) {
        const confidence = this.calculatePumpConfidence(priceChange5m, volumeAnalysis5m, volatility5m);
        
        if (confidence >= (userConfig.min_confidence || 65)) {
          const entry = currentPrice5m;
          const sl = entry * 0.97; // 3% stop loss
          const tp = entry * 1.06; // 6% take profit for quick scalp
          
          signal = this.createSignal(
            symbol, 'LONG', this.name, confidence, entry, tp, sl, {
              adx: 0,
              rsi: currentRsi,
              obvTrend: '↑',
              volumeLevel: volumeAnalysis5m.level,
              atr: volatility5m,
              priceChange: priceChange5m,
              volumeRatio: volumeAnalysis5m.ratio
            }
          );
        }
      }
      
      // Dump detection (abnormal volume + price drop)
      if (this.isDumpSignal(priceChange5m, volumeAnalysis5m, volumeAnalysis15m, currentRsi)) {
        const confidence = this.calculateDumpConfidence(priceChange5m, volumeAnalysis5m, volatility5m);
        
        if (confidence >= (userConfig.min_confidence || 65)) {
          const entry = currentPrice5m;
          const sl = entry * 1.03; // 3% stop loss
          const tp = entry * 0.94; // 6% take profit for quick scalp
          
          signal = this.createSignal(
            symbol, 'SHORT', this.name, confidence, entry, tp, sl, {
              adx: 0,
              rsi: currentRsi,
              obvTrend: '↓',
              volumeLevel: volumeAnalysis5m.level,
              atr: volatility5m,
              priceChange: priceChange5m,
              volumeRatio: volumeAnalysis5m.ratio
            }
          );
        }
      }
      
      if (signal) {
        signals.push(signal);
      }
      
    } catch (error) {
      console.error(`PumpDump strategy error for ${symbol}:`, error);
    }
    
    return signals;
  }

  isPumpSignal(priceChange, volumeAnalysis5m, volumeAnalysis15m, rsi) {
    const minPriceChange = 2.0; // Minimum 2% price increase
    const minVolumeRatio = 3.0; // Minimum 3x volume
    
    return priceChange >= minPriceChange && 
           volumeAnalysis5m.ratio >= minVolumeRatio &&
           volumeAnalysis15m.ratio >= 2.0 && // Confirm with 15m volume
           rsi < 85; // Not extremely overbought
  }

  isDumpSignal(priceChange, volumeAnalysis5m, volumeAnalysis15m, rsi) {
    const minPriceChange = -2.0; // Minimum 2% price decrease
    const minVolumeRatio = 3.0; // Minimum 3x volume
    
    return priceChange <= minPriceChange && 
           volumeAnalysis5m.ratio >= minVolumeRatio &&
           volumeAnalysis15m.ratio >= 2.0 && // Confirm with 15m volume
           rsi > 15; // Not extremely oversold
  }

  calculatePumpConfidence(priceChange, volumeAnalysis, volatility) {
    let confidence = 60; // Base confidence
    
    // Price change strength
    if (priceChange >= 5.0) confidence += 20;
    else if (priceChange >= 3.0) confidence += 15;
    else if (priceChange >= 2.0) confidence += 10;
    
    // Volume strength
    if (volumeAnalysis.ratio >= 5.0) confidence += 20;
    else if (volumeAnalysis.ratio >= 3.0) confidence += 15;
    else if (volumeAnalysis.ratio >= 2.0) confidence += 10;
    
    // Volatility adjustment (high volatility reduces confidence)
    if (volatility > 0.05) confidence -= 10;
    
    return Math.min(90, confidence);
  }

  calculateDumpConfidence(priceChange, volumeAnalysis, volatility) {
    let confidence = 60; // Base confidence
    
    // Price change strength (negative)
    if (priceChange <= -5.0) confidence += 20;
    else if (priceChange <= -3.0) confidence += 15;
    else if (priceChange <= -2.0) confidence += 10;
    
    // Volume strength
    if (volumeAnalysis.ratio >= 5.0) confidence += 20;
    else if (volumeAnalysis.ratio >= 3.0) confidence += 15;
    else if (volumeAnalysis.ratio >= 2.0) confidence += 10;
    
    // Volatility adjustment (high volatility reduces confidence)
    if (volatility > 0.05) confidence -= 10;
    
    return Math.min(90, confidence);
  }

  calculateVolatility(prices, period) {
    if (!prices || prices.length < period) return 0;
    
    const recentPrices = prices.slice(-period);
    const returns = [];
    
    for (let i = 1; i < recentPrices.length; i++) {
      const returnVal = (recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
      returns.push(returnVal);
    }
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }
}

module.exports = PumpDumpStrategy;
