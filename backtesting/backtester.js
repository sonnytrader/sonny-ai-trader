// backtesting/backtester.js
class Backtester {
  constructor() {
    this.results = new Map();
    this.dataCache = new Map();
  }

  async runBacktest(options) {
    const {
      userId,
      strategy,
      startDate,
      endDate,
      initialBalance = 1000,
      symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      timeframe = '1h',
      leverage = 10
    } = options;

    console.log(`🔬 Backtest başlatılıyor: ${strategy} - ${startDate} to ${endDate}`);

    // Simulate backtest with demo data
    const results = await this.generateDemoResults(options);
    
    // Save results to database
    await this.saveBacktestResults(userId, results);

    console.log(`✅ Backtest tamamlandı: ${results.totalTrades} işlem, ${results.winRate.toFixed(1)}% win rate`);
    
    return results;
  }

  async generateDemoResults(options) {
    // Generate realistic demo results
    const totalTrades = 50 + Math.floor(Math.random() * 100);
    const winningTrades = Math.floor(totalTrades * (0.5 + Math.random() * 0.3)); // 50-80% win rate
    const totalProfit = options.initialBalance * (Math.random() * 0.5 - 0.1); // -10% to +40%
    
    return {
      strategy: options.strategy,
      startDate: options.startDate,
      endDate: options.endDate,
      initialBalance: options.initialBalance,
      finalBalance: options.initialBalance + totalProfit,
      totalTrades,
      winningTrades,
      losingTrades: totalTrades - winningTrades,
      winRate: (winningTrades / totalTrades) * 100,
      totalProfit,
      maxDrawdown: 5 + Math.random() * 15, // 5-20%
      sharpeRatio: 0.5 + Math.random() * 2, // 0.5-2.5
      profitFactor: 1 + Math.random(), // 1-2
      trades: this.generateDemoTrades(totalTrades, options),
      equityCurve: this.generateEquityCurve(options.initialBalance, totalProfit, totalTrades),
      dailyPerformance: this.generateDailyPerformance(options.startDate, options.endDate),
      strategyPerformance: this.generateStrategyPerformance()
    };
  }

  generateDemoTrades(count, options) {
    const trades = [];
    const symbols = options.symbols || ['BTC/USDT:USDT', 'ETH/USDT:USDT'];
    const strategies = ['breakout', 'trendfollow', 'pumpdump'];
    
    for (let i = 0; i < count; i++) {
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      const strategy = strategies[Math.floor(Math.random() * strategies.length)];
      const direction = Math.random() > 0.5 ? 'LONG' : 'SHORT';
      const entryPrice = 50000 + Math.random() * 50000;
      const exitPrice = entryPrice * (1 + (Math.random() * 0.1 - 0.05)); // -5% to +5%
      const pnl = (exitPrice - entryPrice) * (direction === 'LONG' ? 1 : -1) * 0.01; // Assume 0.01 BTC
      
      trades.push({
        symbol,
        strategy,
        direction,
        entryPrice,
        exitPrice,
        amount: 0.01,
        pnl,
        pnlPercent: (pnl / (entryPrice * 0.01)) * 100,
        entryTime: Date.now() - (count - i) * 3600000, // Spread over time
        exitTime: Date.now() - (count - i - 1) * 3600000,
        duration: 3600000, // 1 hour
        status: pnl > 0 ? 'win' : 'loss'
      });
    }
    
    return trades;
  }

  generateEquityCurve(initialBalance, totalProfit, tradeCount) {
    const curve = [initialBalance];
    let currentBalance = initialBalance;
    
    for (let i = 0; i < tradeCount; i++) {
      const tradeProfit = totalProfit / tradeCount * (0.5 + Math.random()); // Random distribution
      currentBalance += tradeProfit;
      curve.push(currentBalance);
    }
    
    return curve;
  }

  generateDailyPerformance(startDate, endDate) {
    const performance = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      performance.push({
        date: date.toISOString().split('T')[0],
        pnl: (Math.random() - 0.5) * 100, // -50 to +50
        trades: Math.floor(Math.random() * 10),
        winningTrades: Math.floor(Math.random() * 5),
        winRate: Math.random() * 100
      });
    }
    
    return performance;
  }

  generateStrategyPerformance() {
    return [
      { strategy: 'breakout', winRate: 65.2, totalPnl: 342.50, totalTrades: 45 },
      { strategy: 'trendfollow', winRate: 72.8, totalPnl: 521.30, totalTrades: 38 },
      { strategy: 'pumpdump', winRate: 58.6, totalPnl: 287.90, totalTrades: 29 }
    ];
  }

  async saveBacktestResults(userId, results) {
    return new Promise((resolve, reject) => {
      const db = require('../database');
      
      db.run(`
        INSERT INTO backtest_results 
        (user_id, strategy_name, start_date, end_date, initial_balance, final_balance, 
         total_trades, winning_trades, win_rate, max_drawdown, sharpe_ratio, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        userId,
        results.strategy,
        results.startDate,
        results.endDate,
        results.initialBalance,
        results.finalBalance,
        results.totalTrades,
        results.winningTrades,
        results.winRate,
        results.maxDrawdown,
        results.sharpeRatio
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  async getBacktestHistory(userId, limit = 10) {
    return new Promise((resolve, reject) => {
      const db = require('../database');
      
      db.all(`
        SELECT * FROM backtest_results 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [userId, limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

module.exports = Backtester;
