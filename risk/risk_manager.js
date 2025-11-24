// risk/risk_manager.js
class RiskManager {
  constructor() {
    this.userRiskProfiles = new Map();
    this.maxOpenTrades = 5;
    this.maxDailyLoss = 0.1; // 10% max daily loss
    this.maxPositionSize = 0.1; // 10% max position size
  }

  async assessSignal(signal, userId) {
    const riskProfile = await this.getUserRiskProfile(userId);
    
    const checks = [
      this.checkConfidence(signal, riskProfile),
      this.checkVolume(signal),
      this.checkMarketHours(),
      await this.checkOpenTrades(userId),
      await this.checkDailyLoss(userId)
    ];

    const failedChecks = checks.filter(check => !check.approved);
    
    if (failedChecks.length > 0) {
      return {
        approved: false,
        reason: failedChecks.map(check => check.reason).join(', '),
        details: failedChecks
      };
    }

    return {
      approved: true,
      positionSize: await this.calculatePositionSize(userId, signal, riskProfile),
      riskScore: this.calculateRiskScore(signal, riskProfile)
    };
  }

  async checkTradeConditions(userId, signal) {
    return this.assessSignal(signal, userId);
  }

  async calculatePositionSize(userId, signal, riskProfile) {
    const userBalance = await this.getUserBalance(userId);
    if (!userBalance || userBalance <= 0) {
      return { amount: 0, usdValue: 0, riskPercent: 0 };
    }

    const baseRisk = riskProfile.positionSize || 0.02; // 2% base risk
    
    // Adjust based on signal confidence
    let riskMultiplier = 1.0;
    if (signal.confidence >= 80) riskMultiplier = 1.2;
    else if (signal.confidence >= 70) riskMultiplier = 1.0;
    else if (signal.confidence >= 60) riskMultiplier = 0.8;
    else riskMultiplier = 0.5;

    // Adjust based on strategy
    const strategyMultipliers = {
      breakout: 1.0,
      trendfollow: 1.1,
      pumpdump: 0.7
    };

    const strategyMultiplier = strategyMultipliers[signal.strategy] || 1.0;
    
    const finalRiskPercent = Math.min(
      this.maxPositionSize,
      baseRisk * riskMultiplier * strategyMultiplier
    );

    const usdValue = userBalance * finalRiskPercent;
    const amount = usdValue / signal.giris;

    return {
      amount: this.roundAmount(amount, signal.ccxt_symbol),
      usdValue,
      riskPercent: finalRiskPercent * 100
    };
  }

  checkConfidence(signal, riskProfile) {
    const minConfidence = riskProfile.minConfidence || 60;
    
    if (signal.confidence < minConfidence) {
      return {
        approved: false,
        reason: `Güven seviyesi yetersiz: ${signal.confidence}% < ${minConfidence}%`
      };
    }

    return { approved: true };
  }

  checkVolume(signal) {
    if (signal.volumeLevel === 'low') {
      return {
        approved: false,
        reason: 'Hacim seviyesi çok düşük'
      };
    }

    return { approved: true };
  }

  checkMarketHours() {
    const now = new Date();
    const hour = now.getHours();
    
    // Avoid trading during low liquidity hours (optional)
    if (hour >= 0 && hour <= 4) {
      return {
        approved: false,
        reason: 'Düşük likidite saatleri'
      };
    }

    return { approved: true };
  }

  async checkOpenTrades(userId) {
    const db = require('../database');
    
    const openTrades = await new Promise((resolve, reject) => {
      db.get(`
        SELECT COUNT(*) as count FROM trades 
        WHERE user_id = ? AND status = 'open'
      `, [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row?.count || 0);
      });
    });

    if (openTrades >= this.maxOpenTrades) {
      return {
        approved: false,
        reason: `Maksimum açık işlem sayısına ulaşıldı: ${openTrades}`
      };
    }

    return { approved: true };
  }

  async checkDailyLoss(userId) {
    const db = require('../database');
    
    const today = new Date().toISOString().split('T')[0];
    
    const dailyLoss = await new Promise((resolve, reject) => {
      db.get(`
        SELECT SUM(pnl) as total FROM trades 
        WHERE user_id = ? AND DATE(closed_at) = ? AND pnl < 0
      `, [userId, today], (err, row) => {
        if (err) reject(err);
        else resolve(row?.total || 0);
      });
    });

    const userBalance = await this.getUserBalance(userId);
    const lossPercent = Math.abs(dailyLoss) / userBalance;

    if (lossPercent >= this.maxDailyLoss) {
      return {
        approved: false,
        reason: `Günlük maksimum kayıp limiti aşıldı: ${(lossPercent * 100).toFixed(1)}%`
      };
    }

    return { approved: true };
  }

  async getUserRiskProfile(userId) {
    if (this.userRiskProfiles.has(userId)) {
      return this.userRiskProfiles.get(userId);
    }

    const db = require('../database');
    
    const profile = await new Promise((resolve, reject) => {
      db.get(`
        SELECT risk_profile, min_confidence FROM user_configs WHERE user_id = ?
      `, [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row || {});
      });
    });

    const riskSettings = {
      conservative: { positionSize: 0.01, minConfidence: 70 },
      balanced: { positionSize: 0.02, minConfidence: 60 },
      aggressive: { positionSize: 0.04, minConfidence: 50 }
    };

    const riskLevel = profile.risk_profile || 'balanced';
    const userProfile = {
      ...riskSettings[riskLevel],
      minConfidence: profile.min_confidence || riskSettings[riskLevel].minConfidence
    };

    this.userRiskProfiles.set(userId, userProfile);
    return userProfile;
  }

  async getUserBalance(userId) {
    // In real implementation, fetch from exchange
    // For demo, return a fixed balance
    return 1000;
  }

  calculateRiskScore(signal, riskProfile) {
    let score = 100; // Start with perfect score
    
    // Confidence adjustment
    score -= (100 - signal.confidence) * 0.5;
    
    // Volume adjustment
    if (signal.volumeLevel === 'medium') score -= 10;
    if (signal.volumeLevel === 'low') score -= 30;
    
    // Strategy risk adjustment
    const strategyRisks = {
      breakout: 0,
      trendfollow: -5,
      pumpdump: -20
    };
    
    score += strategyRisks[signal.strategy] || 0;
    
    // Risk profile adjustment
    if (riskProfile.positionSize <= 0.01) score += 10; // Conservative bonus
    if (riskProfile.positionSize >= 0.04) score -= 15; // Aggressive penalty
    
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  roundAmount(amount, symbol) {
    // Basic rounding - in real implementation, use exchange precision
    if (amount < 0.001) return Number(amount.toFixed(8));
    if (amount < 0.01) return Number(amount.toFixed(6));
    if (amount < 1) return Number(amount.toFixed(4));
    return Number(amount.toFixed(2));
  }

  // Position management
  async updatePositionRisk(userId, symbol, newRisk) {
    // Update risk for specific position
    console.log(`Updating risk for ${userId} - ${symbol}: ${newRisk}`);
  }

  // Portfolio risk analysis
  async analyzePortfolioRisk(userId) {
    const db = require('../database');
    
    const openTrades = await new Promise((resolve, reject) => {
      db.all(`
        SELECT symbol, direction, amount, entry_price FROM trades 
        WHERE user_id = ? AND status = 'open'
      `, [userId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const analysis = {
      totalExposure: 0,
      symbolExposure: {},
      directionExposure: { LONG: 0, SHORT: 0 },
      diversificationScore: 100
    };

    openTrades.forEach(trade => {
      const exposure = trade.amount * trade.entry_price;
      analysis.totalExposure += exposure;
      
      // Symbol exposure
      analysis.symbolExposure[trade.symbol] = (analysis.symbolExposure[trade.symbol] || 0) + exposure;
      
      // Direction exposure
      analysis.directionExposure[trade.direction] += exposure;
    });

    // Calculate diversification score
    const symbolCount = Object.keys(analysis.symbolExposure).length;
    if (symbolCount > 0) {
      const avgExposure = analysis.totalExposure / symbolCount;
      let variance = 0;
      
      Object.values(analysis.symbolExposure).forEach(exposure => {
        variance += Math.pow(exposure - avgExposure, 2);
      });
      
      analysis.diversificationScore = Math.max(0, 100 - (variance / analysis.totalExposure) * 100);
    }

    return analysis;
  }
}

module.exports = new RiskManager();
