// strategies/strategy_manager.js
class StrategyManager {
  constructor() {
    this.strategies = new Map();
  }

  async initialize() {
    console.log('🔄 Strateji yöneticisi başlatılıyor...');
    
    // Strategies will be loaded dynamically
    console.log('✅ Strateji yöneticisi hazır');
  }

  async runMultiStrategyAnalysis(symbol, multiTimeframeData, userConfig) {
    const results = {};
    
    // Demo strategies - in real implementation, load actual strategy classes
    const demoStrategies = ['breakout', 'trendfollow', 'pumpdump'];
    
    for (const strategyName of demoStrategies) {
      try {
        // Check if strategy is enabled for user
        const strategyKey = `strategies_${strategyName}`;
        if (userConfig[strategyKey] !== undefined && !userConfig[strategyKey]) {
          continue;
        }

        // Generate demo signals
        const signals = this.generateDemoSignals(strategyName, symbol);
        results[strategyName] = signals;
      } catch (error) {
        console.error(`Strategy ${strategyName} error:`, error);
        results[strategyName] = [];
      }
    }
    
    return results;
  }

  generateDemoSignals(strategyName, symbol) {
    const signals = [];
    const directions = ['LONG', 'SHORT'];
    const direction = directions[Math.floor(Math.random() * directions.length)];
    
    // Generate random but realistic signal
    const confidence = 60 + Math.floor(Math.random() * 30); // 60-90%
    const price = 50000 + Math.random() * 50000;
    
    const signal = {
      id: `${symbol}_${strategyName}_${direction}_${Date.now()}`,
      coin: symbol.replace(':USDT', '').replace('/USDT', '') + '/USDT',
      ccxt_symbol: symbol,
      direction,
      strategy: strategyName,
      giris: this.roundPrice(price),
      tp1: this.roundPrice(price * (direction === 'LONG' ? 1.03 : 0.97)),
      sl: this.roundPrice(price * (direction === 'LONG' ? 0.98 : 1.02)),
      riskReward: 2.0 + Math.random(),
      confidence,
      signalQuality: confidence + Math.floor(Math.random() * 10),
      volumeLevel: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
      narrative: {
        why: `${strategyName} stratejisi ${direction} sinyali`,
        outlook: 'Potansiyel kazanç bekleniyor'
      },
      positionSize: 1.0,
      positionSizeType: 'NORMAL',
      riskLevel: confidence >= 80 ? 'LOW' : 'MEDIUM',
      adx: 20 + Math.floor(Math.random() * 30),
      rsi: 30 + Math.floor(Math.random() * 50),
      obvTrend: Math.random() > 0.5 ? '↑' : '↓',
      timestamp: Date.now()
    };
    
    signals.push(signal);
    return signals;
  }

  roundPrice(price) {
    if (!price || isNaN(price)) return 0;
    if (price < 0.00001) return Number(price.toFixed(8));
    if (price < 0.001) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(5));
    if (price < 10) return Number(price.toFixed(4));
    return Number(price.toFixed(2));
  }

  getStrategy(strategyName) {
    return this.strategies.get(strategyName);
  }

  listStrategies() {
    return [
      { name: 'breakout', description: 'Breakout Strategy', timeframes: ['15m', '1h', '4h'] },
      { name: 'trendfollow', description: 'Trend Follow Strategy', timeframes: ['1h', '4h', '1d'] },
      { name: 'pumpdump', description: 'Pump & Dump Strategy', timeframes: ['5m', '15m', '1h'] }
    ];
  }
}

module.exports = StrategyManager;
