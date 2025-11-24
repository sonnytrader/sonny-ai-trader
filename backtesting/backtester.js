// backtesting/backtester.js
const path = require('path');
const fs = require('fs');
const { EMA, RSI, ADX, ATR, MACD } = require('technicalindicators');

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

    const results = {
      strategy,
      startDate,
      endDate,
      initialBalance,
      finalBalance: initialBalance,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalProfit: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      trades: [],
      equityCurve: [],
      dailyPerformance: []
    };

    try {
      // Simulate trading for each symbol
      for (const symbol of symbols) {
        const symbolResults = await this.backtestSymbol(
          symbol, strategy, startDate, endDate, timeframe, initialBalance, leverage
        );
        
        results.trades.push(...symbolResults.trades);
        results.totalTrades += symbolResults.totalTrades;
        results.winningTrades += symbolResults.winningTrades;
        results.losingTrades += symbolResults.losingTrades;
        results.totalProfit += symbolResults.totalProfit;
      }

      // Calculate final metrics
      results.finalBalance = initialBalance + results.totalProfit;
      results.winRate = results.totalTrades > 0 ? (results.winningTrades / results.totalTrades) * 100 : 0;
      results.maxDrawdown = this.calculateMaxDrawdown(results.equityCurve);
      results.sharpeRatio = this.calculateSharpeRatio(results.trades);
      
      // Generate daily performance
      results.dailyPerformance = this.calculateDailyPerformance(results.trades, startDate, endDate);

      // Save results to database
      await this.saveBacktestResults(userId, results);

      console.log(`✅ Backtest tamamlandı: ${results.totalTrades} işlem, ${results.winRate.toFixed(1)}% win rate`);
      
      return results;

    } catch (error) {
      console.error('Backtest hatası:', error);
      throw error;
    }
  }

  async backtestSymbol(symbol, strategy, startDate, endDate, timeframe, initialBalance, leverage) {
    const results = {
      symbol,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      trades: []
    };

    try {
      // Load historical data
      const historicalData = await this.loadHistoricalData(symbol, timeframe, startDate, endDate);
      if (!historicalData || historicalData.length === 0) {
        return results;
      }

      let balance = initialBalance;
      let position = null;
      const equityCurve = [balance];
      let maxBalance = balance;

      // Process each candle
      for (let i = 50; i < historicalData.length; i++) {
        const currentData = historicalData.slice(0, i + 1);
        const currentCandle = historicalData[i];
        const currentPrice = currentCandle[4]; // Close price
        const currentTime = currentCandle[0];

        // Check for exit conditions first
        if (position) {
          const exitSignal = this.checkExitConditions(position, currentData, currentPrice);
          
          if (exitSignal) {
            const tradeResult = this.closePosition(position, currentPrice, currentTime);
            results.trades.push(tradeResult);
            results.totalTrades++;
            
            if (tradeResult.pnl > 0) results.winningTrades++;
            else results.losingTrades++;
            
            results.totalProfit += tradeResult.pnl;
            balance += tradeResult.pnl;
            position = null;
            
            equityCurve.push(balance);
            maxBalance = Math.max(maxBalance, balance);
          }
        }

        // Check for entry conditions if no position
        if (!position) {
          const entrySignal = this.generateSignal(strategy, currentData, symbol);
          
          if (entrySignal && entrySignal.confidence >= 60) {
            position = this.openPosition(entrySignal, currentPrice, currentTime, balance, leverage);
          }
        }
      }

      // Close any open position at the end
      if (position) {
        const lastPrice = historicalData[historicalData.length - 1][4];
        const tradeResult = this.closePosition(position, lastPrice, Date.now());
        results.trades.push(tradeResult);
        results.totalTrades++;
        
        if (tradeResult.pnl > 0) results.winningTrades++;
        else results.losingTrades++;
        
        results.totalProfit += tradeResult.pnl;
      }

      return results;

    } catch (error) {
      console.error(`Backtest error for ${symbol}:`, error);
      return results;
    }
  }

  generateSignal(strategy, data, symbol) {
    const closes = data.map(c => c[4]);
    const highs = data.map(c => c[2]);
    const lows = data.map(c => c[3]);
    const volumes = data.map(c => c[5]);
    
    const currentPrice = closes[closes.length - 1];
    
    // Calculate basic indicators
    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const adx = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    
    if (!ema9 || !ema21 || !rsi || !adx || !atr) return null;

    const currentEma9 = ema9[ema9.length - 1];
    const currentEma21 = ema21[ema21.length - 1];
    const currentRsi = rsi[rsi.length - 1];
    const currentAdx = adx[adx.length - 1]?.adx || 0;
    const currentAtr = atr[atr.length - 1];

    let signal = null;

    // Strategy-specific logic
    switch (strategy) {
      case 'breakout':
        signal = this.breakoutStrategy(symbol, currentPrice, currentEma9, currentEma21, currentRsi, currentAdx, currentAtr, highs, lows);
        break;
      case 'trendfollow':
        signal = this.trendFollowStrategy(symbol, currentPrice, currentEma9, currentEma21, currentRsi, currentAdx, currentAtr);
        break;
      case 'pumpdump':
        signal = this.pumpDumpStrategy(symbol, currentPrice, volumes, closes);
        break;
    }

    return signal;
  }

  breakoutStrategy(symbol, price, ema9, ema21, rsi, adx, atr, highs, lows) {
    // Simple support/resistance levels
    const resistance = Math.max(...highs.slice(-20));
    const support = Math.min(...lows.slice(-20));
    const tolerance = price * 0.02; // 2% tolerance

    const nearResistance = Math.abs(price - resistance) <= tolerance;
    const nearSupport = Math.abs(price - support) <= tolerance;

    if (nearResistance && ema9 > ema21 && rsi < 70) {
      return {
        symbol,
        direction: 'LONG',
        strategy: 'breakout',
        confidence: 65 + (adx > 25 ? 10 : 0),
        entry: resistance,
        tp: resistance + (atr * 2),
        sl: resistance - (atr * 1)
      };
    }

    if (nearSupport && ema9 < ema21 && rsi > 30) {
      return {
        symbol,
        direction: 'SHORT',
        strategy: 'breakout',
        confidence: 65 + (adx > 25 ? 10 : 0),
        entry: support,
        tp: support - (atr * 2),
        sl: support + (atr * 1)
      };
    }

    return null;
  }

  trendFollowStrategy(symbol, price, ema9, ema21, rsi, adx, atr) {
    if (ema9 > ema21 && adx > 20 && rsi < 70) {
      return {
        symbol,
        direction: 'LONG',
        strategy: 'trendfollow',
        confidence: 70 + (adx > 30 ? 10 : 0),
        entry: price,
        tp: price + (atr * 2.5),
        sl: price - (atr * 1.5)
      };
    }

    if (ema9 < ema21 && adx > 20 && rsi > 30) {
      return {
        symbol,
        direction: 'SHORT',
        strategy: 'trendfollow',
        confidence: 70 + (adx > 30 ? 10 : 0),
        entry: price,
        tp: price - (atr * 2.5),
        sl: price + (atr * 1.5)
      };
    }

    return null;
  }

  pumpDumpStrategy(symbol, price, volumes, closes) {
    const currentVolume = volumes[volumes.length - 1];
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volumeRatio = currentVolume / avgVolume;

    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;

    if (volumeRatio > 3 && priceChange > 2) {
      return {
        symbol,
        direction: 'LONG',
        strategy: 'pumpdump',
        confidence: 75,
        entry: price,
        tp: price * 1.06,
        sl: price * 0.97
      };
    }

    if (volumeRatio > 3 && priceChange < -2) {
      return {
        symbol,
        direction: 'SHORT',
        strategy: 'pumpdump',
        confidence: 75,
        entry: price,
        tp: price * 0.94,
        sl: price * 1.03
      };
    }

    return null;
  }

  openPosition(signal, price, timestamp, balance, leverage) {
    const positionSize = balance * 0.02; // 2% risk per trade
    const usdAmount = positionSize * leverage;
    const coinAmount = usdAmount / price;

    return {
      symbol: signal.symbol,
      direction: signal.direction,
      strategy: signal.strategy,
      entryPrice: price,
      entryTime: timestamp,
      amount: coinAmount,
      usdValue: usdAmount,
      tpPrice: signal.tp,
      slPrice: signal.sl,
      leverage
    };
  }

  checkExitConditions(position, data, currentPrice) {
    const { direction, tpPrice, slPrice } = position;
    
    // Take Profit hit
    if ((direction === 'LONG' && currentPrice >= tpPrice) ||
        (direction === 'SHORT' && currentPrice <= tpPrice)) {
      return 'TP';
    }
    
    // Stop Loss hit
    if ((direction === 'LONG' && currentPrice <= slPrice) ||
        (direction === 'SHORT' && currentPrice >= slPrice)) {
      return 'SL';
    }
    
    // Trailing stop (optional)
    // Time-based exit (optional)
    
    return null;
  }

  closePosition(position, exitPrice, exitTime) {
    const { direction, entryPrice, amount, usdValue, strategy, symbol } = position;
    
    let pnl;
    if (direction === 'LONG') {
      pnl = (exitPrice - entryPrice) * amount;
    } else {
      pnl = (entryPrice - exitPrice) * amount;
    }
    
    const pnlPercent = (pnl / usdValue) * 100;
    
    return {
      symbol,
      strategy,
      direction,
      entryPrice,
      exitPrice,
      amount,
      pnl,
      pnlPercent,
      entryTime: position.entryTime,
      exitTime,
      duration: exitTime - position.entryTime,
      status: pnl > 0 ? 'win' : 'loss'
    };
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
    
    return maxDrawdown * 100; // Return as percentage
  }

  calculateSharpeRatio(trades) {
    if (trades.length === 0) return 0;
    
    const returns = trades.map(t => t.pnlPercent);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    // Assume 0% risk-free rate for simplicity
    return stdDev !== 0 ? avgReturn / stdDev : 0;
  }

  calculateDailyPerformance(trades, startDate, endDate) {
    const dailyPerformance = {};
    
    trades.forEach(trade => {
      const date = new Date(trade.exitTime).toISOString().split('T')[0];
      
      if (!dailyPerformance[date]) {
        dailyPerformance[date] = {
          date,
          pnl: 0,
          trades: 0,
          winningTrades: 0
        };
      }
      
      dailyPerformance[date].pnl += trade.pnl;
      dailyPerformance[date].trades++;
      
      if (trade.pnl > 0) {
        dailyPerformance[date].winningTrades++;
      }
    });
    
    // Convert to array and fill missing dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    const result = [];
    
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const dayData = dailyPerformance[dateStr] || {
        date: dateStr,
        pnl: 0,
        trades: 0,
        winningTrades: 0
      };
      
      dayData.winRate = dayData.trades > 0 ? (dayData.winningTrades / dayData.trades) * 100 : 0;
      result.push(dayData);
    }
    
    return result;
  }

  async loadHistoricalData(symbol, timeframe, startDate, endDate) {
    const cacheKey = `${symbol}_${timeframe}_${startDate}_${endDate}`;
    
    if (this.dataCache.has(cacheKey)) {
      return this.dataCache.get(cacheKey);
    }

    try {
      // In a real implementation, you would fetch from:
      // - CCXT (limited historical data)
      // - External API (CoinAPI, Cryptodatadownload, etc.)
      // - Local database
      
      // For demo purposes, generate synthetic data
      const syntheticData = this.generateSyntheticData(symbol, startDate, endDate, timeframe);
      this.dataCache.set(cacheKey, syntheticData);
      
      return syntheticData;
      
    } catch (error) {
      console.error(`Historical data load error for ${symbol}:`, error);
      return [];
    }
  }

  generateSyntheticData(symbol, startDate, endDate, timeframe) {
    const data = [];
    const startTime = new Date(startDate).getTime();
    const endTime = new Date(endDate).getTime();
    
    // Timeframe in milliseconds
    const tfMs = this.timeframeToMs(timeframe);
    let basePrice = 50000; // Starting price for BTC
    
    for (let time = startTime; time <= endTime; time += tfMs) {
      // Random price movement
      const change = (Math.random() - 0.5) * 0.02; // ±1% change
      basePrice = basePrice * (1 + change);
      
      const open = basePrice;
      const high = basePrice * (1 + Math.random() * 0.01);
      const low = basePrice * (1 - Math.random() * 0.01);
      const close = (high + low) / 2;
      const volume = 1000 + Math.random() * 5000;
      
      data.push([time, open, high, low, close, volume]);
    }
    
    return data;
  }

  timeframeToMs(timeframe) {
    const units = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000
    };
    
    return units[timeframe] || 60 * 60 * 1000;
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

module.exports = new Backtester();
