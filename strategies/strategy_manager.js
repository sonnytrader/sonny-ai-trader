// strategies/strategy_manager.js
const BreakoutStrategy = require('./breakout');
const TrendFollowStrategy = require('./trendfollow');
const PumpDumpStrategy = require('./pumpdump');

class StrategyManager {
  constructor() {
    this.strategies = new Map();
  }

  async initialize() {
    console.log('🔄 Strateji yöneticisi başlatılıyor...');
    
    this.strategies.set('breakout', new BreakoutStrategy());
    this.strategies.set('trendfollow', new TrendFollowStrategy());
    this.strategies.set('pumpdump', new PumpDumpStrategy());
    
    console.log('✅ Strateji yöneticisi hazır');
  }

  async runMultiStrategyAnalysis(symbol, multiTimeframeData, userConfig) {
    const results = {};
    
    for (const [strategyName, strategy] of this.strategies) {
      try {
        // Check if strategy is enabled for user
        const strategyKey = `strategies_${strategyName}`;
        if (userConfig[strategyKey] !== undefined && !userConfig[strategyKey]) {
          continue;
        }

        const signals = await strategy.analyze(symbol, multiTimeframeData, userConfig);
        results[strategyName] = signals;
      } catch (error) {
        console.error(`Strategy ${strategyName} error:`, error);
        results[strategyName] = [];
      }
    }
    
    return results;
  }

  getStrategy(strategyName) {
    return this.strategies.get(strategyName);
  }

  listStrategies() {
    return Array.from(this.strategies.keys()).map(name => ({
      name,
      description: this.strategies.get(name).description,
      timeframes: this.strategies.get(name).timeframes
    }));
  }
}

module.exports = StrategyManager;
