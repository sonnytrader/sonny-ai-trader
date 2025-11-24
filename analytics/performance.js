// analytics/performance.js
class PerformanceTracker {
  constructor() {
    this.userStats = new Map();
  }

  recordTrade(userId, tradeData) {
    if (!this.userStats.has(userId)) {
      this.initializeUserStats(userId);
    }

    const stats = this.userStats.get(userId);
    
    stats.totalTrades++;
    
    if (tradeData.pnl > 0) {
      stats.winningTrades++;
    } else {
      stats.losingTrades++;
    }
    
    stats.totalProfit += tradeData.pnl;
    stats.equityCurve.push(stats.currentBalance + stats.totalProfit);
    
    // Update metrics
    this.updateMetrics(stats);
    
    // Save to database
    this.saveTradeToDB(userId, tradeData);
  }

  initializeUserStats(userId) {
    this.userStats.set(userId, {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      currentBalance: 1000, // Default balance
      equityCurve: [1000],
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      lastUpdated: new Date()
    });
  }

  updateMetrics(stats) {
    stats.winRate = stats.totalTrades > 0 ? (stats.winningTrades / stats.totalTrades) * 100 : 0;
    
    // Calculate max drawdown
    stats.maxDrawdown = this.calculateMaxDrawdown(stats.equityCurve);
    
    // Calculate Sharpe ratio (simplified)
    stats.sharpeRatio = this.calculateSharpeRatio(stats.equityCurve);
    
    stats.lastUpdated = new Date();
  }

  calculateMaxDrawdown(equityCurve) {
    let maxDrawdown = 0;
    let peak = equityCurve[0];
    
    for (let i = 1; i < equityCurve.length; i++) {
      if (equityCurve[i] > peak) {
        peak = equityCurve[i];
      }
      
      const drawdown = (peak - equityCurve[i]) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
    
    return maxDrawdown * 100;
  }

  calculateSharpeRatio(equityCurve) {
    if (equityCurve.length < 2) return 0;
    
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const dailyReturn = (equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1];
      returns.push(dailyReturn);
    }
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Assume 0% risk-free rate
    return stdDev !== 0 ? avgReturn / stdDev : 0;
  }

  async getUserReport(userId) {
    if (!this.userStats.has(userId)) {
      this.initializeUserStats(userId);
    }

    const stats = this.userStats.get(userId);
    
    // Get recent trades from database
    const recentTrades = await this.getRecentTrades(userId, 50);
    const strategyPerformance = await this.getStrategyPerformance(userId);
    const dailyPerformance = await this.getDailyPerformance(userId);

    return {
      summary: {
        totalTrades: stats.totalTrades,
        winningTrades: stats.winningTrades,
        losingTrades: stats.losingTrades,
        winRate: stats.winRate,
        totalProfit: stats.totalProfit,
        profitPercentage: (stats.totalProfit / stats.currentBalance) * 100,
        maxDrawdown: stats.maxDrawdown,
        sharpeRatio: stats.sharpeRatio,
        currentBalance: stats.currentBalance + stats.totalProfit
      },
      recentTrades,
      strategyPerformance,
      dailyPerformance,
      equityCurve: stats.equityCurve
    };
  }

  async getRecentTrades(userId, limit = 50) {
    const db = require('../database');
    
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM trades 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [userId, limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getStrategyPerformance(userId) {
    const db = require('../database');
    
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          strategy,
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
          SUM(pnl) as total_pnl,
          AVG(pnl) as avg_pnl
        FROM trades 
        WHERE user_id = ? 
        GROUP BY strategy
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getDailyPerformance(userId, days = 30) {
    const db = require('../database');
    
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
          SUM(pnl) as daily_pnl
        FROM trades 
        WHERE user_id = ? AND created_at >= date('now', '-' || ? || ' days')
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `, [userId, days], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async saveTradeToDB(userId, tradeData) {
    const db = require('../database');
    
    return new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO trades 
        (user_id, symbol, direction, strategy, entry_price, exit_price, amount, pnl, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        userId,
        tradeData.symbol,
        tradeData.direction,
        tradeData.strategy,
        tradeData.entryPrice,
        tradeData.exitPrice,
        tradeData.amount,
        tradeData.pnl,
        tradeData.status
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  // Advanced analytics
  async calculateMonthlyReturns(userId) {
    const db = require('../database');
    
    return new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          strftime('%Y-%m', created_at) as month,
          SUM(pnl) as monthly_pnl
        FROM trades 
        WHERE user_id = ? 
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month DESC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getWinLossStreaks(userId) {
    const db = require('../database');
    
    const trades = await new Promise((resolve, reject) => {
      db.all(`
        SELECT pnl FROM trades 
        WHERE user_id = ? 
        ORDER BY created_at ASC
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    let currentStreak = 0;
    let currentType = null;
    const streaks = [];

    trades.forEach(trade => {
      const type = trade.pnl > 0 ? 'win' : 'loss';
      
      if (type === currentType) {
        currentStreak++;
      } else {
        if (currentType) {
          streaks.push({
            type: currentType,
            length: currentStreak
          });
        }
        currentType = type;
        currentStreak = 1;
      }
    });

    // Add the last streak
    if (currentType) {
      streaks.push({
        type: currentType,
        length: currentStreak
      });
    }

    return streaks;
  }
}

module.exports = new PerformanceTracker();
