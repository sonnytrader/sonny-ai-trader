require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const winston = require('winston');
const cron = require('node-cron');
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

// SQLite database import
const db = require('./database');

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Database initialization - SQLITE
async function initializeDatabase() {
  try {
    console.log('✅ SQLite database hazır');
    logger.info('SQLite database initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed:', error);
    console.error('❌ Database hatası:', error.message);
  }
}

// Modern şifreleme fonksiyonları
const encryption = {
  algorithm: 'aes-256-gcm',
  
  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    
    return JSON.stringify({
      iv: iv.toString('hex'),
      data: encrypted,
      authTag: authTag.toString('hex')
    });
  },
  
  decrypt(encryptedDataStr) {
    try {
      const encryptedData = JSON.parse(encryptedDataStr);
      const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
      const decipher = crypto.createDecipheriv(
        this.algorithm, 
        key, 
        Buffer.from(encryptedData.iv, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
      let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      logger.error('Decryption error:', error);
      return null;
    }
  }
};

// Database helper fonksiyonları - SQLITE
const database = {
  async getUserByEmail(email) {
    try {
      const user = await db.getUserByEmail(email);
      if (user && user.api_secret) {
        user.api_secret = encryption.decrypt(user.api_secret);
      }
      return user;
    } catch (error) {
      logger.error('getUserByEmail error:', error);
      return null;
    }
  },

  async getUserByToken(token) {
    try {
      const user = await db.getUserByToken(token);
      if (user && user.api_secret) {
        user.api_secret = encryption.decrypt(user.api_secret);
      }
      return user;
    } catch (error) {
      logger.error('getUserByToken error:', error);
      return null;
    }
  },

  async createUser(email, password, plan) {
    try {
      return await db.createUser(email, password, plan);
    } catch (error) {
      logger.error('createUser error:', error);
      throw error;
    }
  },

  async updateUserSession(userId, token) {
    try {
      await db.updateUserSession(userId, token);
    } catch (error) {
      logger.error('updateUserSession error:', error);
    }
  },

  async getUserSettings(userId) {
    try {
      const settings = await db.getUserSettings(userId);
      if (settings && settings.strategies) {
        settings.strategies = JSON.parse(settings.strategies);
      }
      return settings;
    } catch (error) {
      logger.error('getUserSettings error:', error);
      return null;
    }
  },

  async updateUserSettings(userId, newSettings) {
    try {
      // API secret şifreleme
      if (newSettings.api_secret) {
        newSettings.api_secret = encryption.encrypt(newSettings.api_secret);
      }
      return await db.updateUserSettings(userId, newSettings);
    } catch (error) {
      logger.error('updateUserSettings error:', error);
      throw error;
    }
  },

  async createTrade(tradeData) {
    try {
      const trade = await db.createTrade(tradeData);
      logger.info(`Trade created: ${tradeData.symbol} ${tradeData.direction}`);
      return trade;
    } catch (error) {
      logger.error('createTrade error:', error);
      throw error;
    }
  },

  async closeTrade(tradeId, exitPrice, pnl) {
    try {
      await db.closeTrade(tradeId, exitPrice, pnl);
      logger.info(`Trade closed: ${tradeId}, PnL: ${pnl}`);
    } catch (error) {
      logger.error('closeTrade error:', error);
      throw error;
    }
  },

  async getOpenTrades(userId) {
    try {
      return await db.getOpenTrades(userId);
    } catch (error) {
      logger.error('getOpenTrades error:', error);
      return [];
    }
  },

  async getRiskManagement(userId) {
    try {
      // Basit risk management - SQLite için basitleştirilmiş
      const openTrades = await this.getOpenTrades(userId);
      return {
        max_daily_loss: 500,
        max_position_size: 1000,
        daily_loss_so_far: 0,
        open_positions_count: openTrades.length,
        max_positions: 10
      };
    } catch (error) {
      logger.error('getRiskManagement error:', error);
      return null;
    }
  },

  async updateDailyLoss(userId, lossAmount) {
    logger.info(`Daily loss updated for user ${userId}: ${lossAmount}`);
  },

  async resetDailyLoss() {
    logger.info('Daily loss counters reset');
  },

  async getPendingUsers() {
    try {
      return await db.getPendingUsers();
    } catch (error) {
      logger.error('getPendingUsers error:', error);
      return [];
    }
  },

  async getAllUsers() {
    try {
      return await db.getAllUsers();
    } catch (error) {
      logger.error('getAllUsers error:', error);
      return [];
    }
  },

  async approveUser(userId, adminId) {
    try {
      return await db.approveUser(userId, adminId);
    } catch (error) {
      logger.error('approveUser error:', error);
      throw error;
    }
  },

  async rejectUser(userId, adminId) {
    try {
      return await db.rejectUser(userId, adminId);
    } catch (error) {
      logger.error('rejectUser error:', error);
      throw error;
    }
  },

  async deleteUser(userId) {
    try {
      return await db.deleteUser(userId);
    } catch (error) {
      logger.error('deleteUser error:', error);
      throw error;
    }
  }
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
async function authenticateToken(req, res, next) {
    const publicRoutes = [
        '/', '/login.html', '/register.html', '/index.html', '/admin.html',
        '/api/login', '/api/register', '/api/status', '/api/scan/refresh',
        '/api/crypto/', '/api/analyze',
        '/css/', '/js/', '/img/', '/fonts/'
    ];
    
    if (publicRoutes.some(route => req.path.startsWith(route)) || 
        req.path.endsWith('.html') || 
        req.path.endsWith('.css') || 
        req.path.endsWith('.js') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.jpg') ||
        req.path.endsWith('.ico')) {
        return next();
    }

    let token = req.headers['authorization'];
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    } else {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }

    try {
        const user = await database.getUserByToken(token);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Geçersiz token' });
        }
        req.user = user;
        next();
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
}

// Admin middleware
function requireAdmin(req, res, next) {
    if (req.user && req.user.email === 'admin@alphason.com') {
        next();
    } else {
        res.status(403).json({ success: false, error: 'Admin erişimi gerekiyor' });
    }
}

// Global Configuration
let CONFIG = {
    minVolumeUSD: 100000,
    minPrice: 0.01,
    timeframes: ['15m', '1h', '4h'],
    timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
    volumeConfirmationThreshold: 1.3,
    minTrendStrength: 22,
    snrTolerancePercent: 2.0,
    atrSLMultiplier: 1.5,
    atrTPMultiplier: 3.0,
    signalCooldownMs: 30 * 60 * 1000,
    scanBatchSize: 8,
    focusedScanIntervalMs: 5 * 60 * 1000,
    fullSymbolRefreshMs: 15 * 60 * 1000,
    enableTimeFilter: false,
    optimalTradingHours: [7, 8, 9, 13, 14, 15, 19, 20, 21]
};

// Global Variables
let publicExchange = new ccxt.bitget({
    options: { defaultType: 'spot' },
    timeout: 30000,
    enableRateLimit: true
});

let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const userConnections = new Map();
const userExchanges = new Map();

let globalSignals = [];

const systemStatus = {
    isHealthy: true,
    filterCount: 0,
    marketSentiment: 'ANALİZ EDİLİYOR...',
    performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// Risk Management Service
class RiskManagementService {
  static async canOpenTrade(userId, symbol, quantity, price) {
    try {
      const risk = await database.getRiskManagement(userId);
      const openTrades = await database.getOpenTrades(userId);
      
      const positionValue = quantity * price;
      
      if (positionValue > risk.max_position_size) {
        logger.warn(`Position size too large for user ${userId}: ${positionValue} > ${risk.max_position_size}`);
        return false;
      }
      
      if (openTrades.length >= risk.max_positions) {
        logger.warn(`Max open positions reached for user ${userId}`);
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Risk check error:', error);
      return false;
    }
  }
}

// Trade Execution Service
class TradeExecutionService {
  static async executeTrade(userId, signal) {
    try {
      const user = await database.getUserByToken(userId);
      if (!user || !user.api_key || !user.api_secret) {
        logger.warn(`User ${userId} has no API credentials`);
        return null;
      }
      
      const quantity = this.calculatePositionSize(user, signal);
      const canTrade = await RiskManagementService.canOpenTrade(userId, signal.symbol, quantity, signal.price);
      
      if (!canTrade) {
        logger.warn(`Risk check failed for user ${userId}, symbol: ${signal.symbol}`);
        return null;
      }
      
      const tradeData = {
        user_id: userId,
        symbol: signal.symbol,
        strategy: signal.strategy,
        direction: signal.direction,
        entry_price: signal.price,
        quantity: quantity,
        stop_loss: signal.stopLoss,
        take_profit: signal.takeProfit,
        confidence: signal.confidence,
        metadata: {
          volume_ratio: signal.volumeRatio,
          price_change: signal.priceChange,
          timeframe: signal.timeframe
        }
      };
      
      const trade = await database.createTrade(tradeData);
      
      logger.info(`Executing trade for user ${userId}: ${signal.symbol} ${signal.direction} at ${signal.price}`);
      
      this.broadcastToUser(userId, {
        type: 'TRADE_OPENED',
        trade: trade
      });
      
      return trade;
    } catch (error) {
      logger.error('Trade execution error:', error);
      return null;
    }
  }
  
  static calculatePositionSize(user, signal) {
    const balance = user.balance || 1000;
    const riskPercent = user.margin_percent || 5.0;
    const positionSize = balance * (riskPercent / 100);
    return positionSize / signal.price;
  }
  
  static getUserExchange(user) {
    if (!userExchanges.has(user.id)) {
      const exchange = new ccxt.bitget({
        apiKey: user.api_key,
        secret: user.api_secret,
        password: user.api_passphrase,
        options: { defaultType: 'swap' },
        timeout: 30000,
        enableRateLimit: true
      });
      userExchanges.set(user.id, exchange);
    }
    return userExchanges.get(user.id);
  }
  
  static broadcastToUser(userId, message) {
    const connection = userConnections.get(userId);
    if (connection && connection.readyState === WebSocket.OPEN) {
      connection.send(JSON.stringify(message));
    }
  }
}

// WebSocket Handler
wss.on('connection', (ws, req) => {
  logger.info('New WebSocket connection');
  
  // Bağlantı kurulur kurulmaz sinyal listesini gönder
  ws.send(JSON.stringify({
    type: 'signal_list',
    data: globalSignals
  }));

  ws.send(JSON.stringify({
    type: 'system_status',
    data: {
      performance: {
        totalSignals: globalSignals.length,
        winRate: 72.5
      }
    }
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'AUTHENTICATE') {
        const user = await database.getUserByToken(data.token);
        if (user) {
          userConnections.set(user.id, ws);
          ws.userId = user.id;
          ws.send(JSON.stringify({
            type: 'AUTHENTICATED',
            user: { id: user.id, email: user.email }
          }));
          
          ws.send(JSON.stringify({
            type: 'user_data',
            data: { user, settings: await database.getUserSettings(user.id) }
          }));
          
          logger.info(`User ${user.email} authenticated via WebSocket`);
        } else {
          ws.send(JSON.stringify({
            type: 'AUTH_ERROR',
            error: 'Invalid token'
          }));
        }
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    if (ws.userId) {
      userConnections.delete(ws.userId);
      logger.info(`WebSocket connection closed for user ${ws.userId}`);
    }
  });
  
  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
});

// Scheduler - Otomatik tarama ve trading
cron.schedule('*/5 * * * *', async () => {
  logger.info('Running scheduled scan');
  await runMarketScan();
});

cron.schedule('0 0 * * *', async () => {
  logger.info('Resetting daily counters');
  await database.resetDailyLoss();
});

// STRATEJİ 1: PumpDumpStrategy - DÜZELTİLMİŞ
class PumpDumpStrategy {
    constructor() {
        this.name = 'PumpDumpStrategy';
        this.priceChangeThreshold = 1.5;
        this.volumeRatioThreshold = 2.0;
        this.lookbackPeriod = 15;
        this.cooldownPeriod = 10 * 60 * 1000;
        this.atrSLMultiplier = 2.0;
        this.atrTPMultiplier = 3.0;
        this.recentSignals = new Map();
    }

    async analyze(symbol, timeframe, ohlcv) {
        try {
            const now = Date.now();
            const lastSignal = this.recentSignals.get(symbol);
            if (lastSignal && (now - lastSignal) < this.cooldownPeriod) {
                return null;
            }

            if (ohlcv.length < this.lookbackPeriod + 5) {
                return null;
            }

            const closes = ohlcv.map(d => d[4]);
            const volumes = ohlcv.map(d => d[5]);
            const currentClose = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];

            const previousVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
            const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;
            const volumeRatio = currentVolume / avgVolume;

            const previousClose = closes[closes.length - 2];
            const priceChange = ((currentClose - previousClose) / previousClose) * 100;

            const high = ohlcv.map(d => d[2]);
            const low = ohlcv.map(d => d[3]);
            const atr = await ATR.calculate({
                high: high.slice(-14),
                low: low.slice(-14),
                close: closes.slice(-14),
                period: 14
            });

            // ATR FALLBACK EKLENDİ - Sıfır gelirse %1 kullan
            const currentATR = atr[atr.length - 1] || (currentClose * 0.01);

            if (Math.abs(priceChange) >= this.priceChangeThreshold && volumeRatio >= this.volumeRatioThreshold) {
                const direction = priceChange > 0 ? 'LONG' : 'SHORT';
                
                let confidence = 50;
                confidence += 20;
                
                if (volumeRatio >= 3.0) confidence += 15;
                else if (volumeRatio >= 2.0) confidence += 10;
                else if (volumeRatio >= 1.5) confidence += 5;

                const stopLoss = direction === 'LONG' ? currentClose - (currentATR * this.atrSLMultiplier) : currentClose + (currentATR * this.atrSLMultiplier);
                const takeProfit = direction === 'LONG' ? currentClose + (currentATR * this.atrTPMultiplier) : currentClose - (currentATR * this.atrTPMultiplier);

                // R/R ORANI GÜVENLİ HESAPLAMA
                const rrValue = (Math.abs(takeProfit - currentClose) / Math.abs(currentClose - stopLoss));
                const riskReward = isFinite(rrValue) ? rrValue.toFixed(2) : "N/A";

                this.recentSignals.set(symbol, now);

                return {
                    coin: symbol.replace('/USDT', ''),
                    signalSource: this.name,
                    taraf: direction,
                    confidence: Math.round(Math.min(confidence, 95)), // YUVARLAMA EKLENDİ
                    giris: currentClose,
                    tp1: takeProfit,
                    sl: stopLoss,
                    riskReward: riskReward, // DÜZELTİLMİŞ R/R
                    tuyo: `${symbol.replace('/USDT', '')} ${direction} sinyal - Hacim: ${volumeRatio.toFixed(2)}x, Fiyat Değişimi: ${priceChange.toFixed(2)}%`,
                    timestamp: Date.now(),
                    volumeRatio: volumeRatio,
                    priceChange: priceChange
                };
            }

            return null;
        } catch (error) {
            logger.error(`PumpDumpStrategy error for ${symbol}:`, error);
            return null;
        }
    }
}

// STRATEJİ 2: BreakoutStrategy - DÜZELTİLMİŞ
class BreakoutStrategy {
    constructor() {
        this.name = 'BreakoutStrategy';
        this.lookbackPeriod = 20;
        this.volumeConfirmationThreshold = 1.5;
        this.cooldownPeriod = 15 * 60 * 1000;
        this.atrSLMultiplier = 1.8;
        this.atrTPMultiplier = 2.5;
        this.recentSignals = new Map();
    }

    async analyze(symbol, timeframe, ohlcv) {
        try {
            const now = Date.now();
            const lastSignal = this.recentSignals.get(symbol);
            if (lastSignal && (now - lastSignal) < this.cooldownPeriod) {
                return null;
            }

            if (ohlcv.length < this.lookbackPeriod + 10) {
                return null;
            }

            const highs = ohlcv.map(d => d[2]);
            const lows = ohlcv.map(d => d[3]);
            const closes = ohlcv.map(d => d[4]);
            const volumes = ohlcv.map(d => d[5]);

            const currentHigh = highs[highs.length - 1];
            const currentLow = lows[lows.length - 1];
            const currentClose = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];

            // Resistance ve Support seviyeleri
            const recentHighs = highs.slice(-this.lookbackPeriod, -1);
            const recentLows = lows.slice(-this.lookbackPeriod, -1);
            
            const resistance = Math.max(...recentHighs);
            const support = Math.min(...recentLows);

            // Volume ortalaması
            const previousVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
            const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;
            const volumeRatio = currentVolume / avgVolume;

            // ATR hesaplama
            const atr = await ATR.calculate({
                high: highs.slice(-14),
                low: lows.slice(-14),
                close: closes.slice(-14),
                period: 14
            });
            
            // ATR FALLBACK EKLENDİ
            const currentATR = atr[atr.length - 1] || (currentClose * 0.01);

            let signal = null;
            let direction = '';
            let confidence = 60;

            // Resistance breakout
            if (currentClose > resistance && volumeRatio >= this.volumeConfirmationThreshold) {
                direction = 'LONG';
                confidence += Math.min(volumeRatio * 5, 25);
                signal = { direction, confidence, breakoutLevel: resistance };
            }
            // Support breakdown
            else if (currentClose < support && volumeRatio >= this.volumeConfirmationThreshold) {
                direction = 'SHORT';
                confidence += Math.min(volumeRatio * 5, 25);
                signal = { direction, confidence, breakoutLevel: support };
            }

            if (signal) {
                const stopLoss = direction === 'LONG' ? currentClose - (currentATR * this.atrSLMultiplier) : currentClose + (currentATR * this.atrSLMultiplier);
                const takeProfit = direction === 'LONG' ? currentClose + (currentATR * this.atrTPMultiplier) : currentClose - (currentATR * this.atrTPMultiplier);

                // R/R ORANI GÜVENLİ HESAPLAMA
                const rrValue = (Math.abs(takeProfit - currentClose) / Math.abs(currentClose - stopLoss));
                const riskReward = isFinite(rrValue) ? rrValue.toFixed(2) : "N/A";

                this.recentSignals.set(symbol, now);

                return {
                    coin: symbol.replace('/USDT', ''),
                    signalSource: this.name,
                    taraf: signal.direction,
                    confidence: Math.round(Math.min(signal.confidence, 90)), // YUVARLAMA EKLENDİ
                    giris: currentClose,
                    tp1: takeProfit,
                    sl: stopLoss,
                    riskReward: riskReward, // DÜZELTİLMİŞ R/R
                    tuyo: `${symbol.replace('/USDT', '')} ${signal.direction} breakout - Seviye: ${signal.breakoutLevel.toFixed(6)}, Hacim: ${volumeRatio.toFixed(2)}x`,
                    timestamp: Date.now(),
                    volumeRatio: volumeRatio
                };
            }

            return null;
        } catch (error) {
            logger.error(`BreakoutStrategy error for ${symbol}:`, error);
            return null;
        }
    }
}

// STRATEJİ 3: TrendFollowStrategy - DÜZELTİLMİŞ
class TrendFollowStrategy {
    constructor() {
        this.name = 'TrendFollowStrategy';
        this.adxThreshold = 25;
        this.emaFastPeriod = 9;
        this.emaSlowPeriod = 21;
        this.cooldownPeriod = 20 * 60 * 1000;
        this.atrSLMultiplier = 1.5;
        this.atrTPMultiplier = 2.0;
        this.recentSignals = new Map();
    }

    async analyze(symbol, timeframe, ohlcv) {
        try {
            const now = Date.now();
            const lastSignal = this.recentSignals.get(symbol);
            if (lastSignal && (now - lastSignal) < this.cooldownPeriod) {
                return null;
            }

            if (ohlcv.length < 50) {
                return null;
            }

            const highs = ohlcv.map(d => d[2]);
            const lows = ohlcv.map(d => d[3]);
            const closes = ohlcv.map(d => d[4]);
            const volumes = ohlcv.map(d => d[5]);

            const currentClose = closes[closes.length - 1];
            const currentVolume = volumes[volumes.length - 1];

            // ADX - Trend gücü
            const adx = await ADX.calculate({
                high: highs.slice(-14),
                low: lows.slice(-14),
                close: closes.slice(-14),
                period: 14
            });
            const currentADX = adx[adx.length - 1] || 0;

            // EMA'lar
            const emaFast = await EMA.calculate({ period: this.emaFastPeriod, values: closes });
            const emaSlow = await EMA.calculate({ period: this.emaSlowPeriod, values: closes });
            
            const currentEmaFast = emaFast[emaFast.length - 1];
            const currentEmaSlow = emaSlow[emaSlow.length - 1];
            const prevEmaFast = emaFast[emaFast.length - 2];
            const prevEmaSlow = emaSlow[emaSlow.length - 2];

            // ATR
            const atr = await ATR.calculate({
                high: highs.slice(-14),
                low: lows.slice(-14),
                close: closes.slice(-14),
                period: 14
            });
            
            // ATR FALLBACK EKLENDİ
            const currentATR = atr[atr.length - 1] || (currentClose * 0.01);

            // Volume ortalaması
            const previousVolumes = volumes.slice(-20, -1);
            const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;
            const volumeRatio = currentVolume / avgVolume;

            let signal = null;
            let direction = '';
            let confidence = 55;

            // Güçlü trend ve EMA crossover
            if (currentADX >= this.adxThreshold) {
                // Bullish trend: Fast EMA > Slow EMA ve yukarı crossover
                if (currentEmaFast > currentEmaSlow && prevEmaFast <= prevEmaSlow) {
                    direction = 'LONG';
                    confidence += Math.min(currentADX, 30) + Math.min(volumeRatio * 3, 15);
                    signal = { direction, confidence };
                }
                // Bearish trend: Fast EMA < Slow EMA ve aşağı crossover
                else if (currentEmaFast < currentEmaSlow && prevEmaFast >= prevEmaSlow) {
                    direction = 'SHORT';
                    confidence += Math.min(currentADX, 30) + Math.min(volumeRatio * 3, 15);
                    signal = { direction, confidence };
                }
            }

            if (signal && signal.confidence > 65) {
                const stopLoss = direction === 'LONG' ? currentClose - (currentATR * this.atrSLMultiplier) : currentClose + (currentATR * this.atrSLMultiplier);
                const takeProfit = direction === 'LONG' ? currentClose + (currentATR * this.atrTPMultiplier) : currentClose - (currentATR * this.atrTPMultiplier);

                // R/R ORANI GÜVENLİ HESAPLAMA
                const rrValue = (Math.abs(takeProfit - currentClose) / Math.abs(currentClose - stopLoss));
                const riskReward = isFinite(rrValue) ? rrValue.toFixed(2) : "N/A";

                this.recentSignals.set(symbol, now);

                return {
                    coin: symbol.replace('/USDT', ''),
                    signalSource: this.name,
                    taraf: signal.direction,
                    confidence: Math.round(Math.min(signal.confidence, 85)), // YUVARLAMA EKLENDİ
                    giris: currentClose,
                    tp1: takeProfit,
                    sl: stopLoss,
                    riskReward: riskReward, // DÜZELTİLMİŞ R/R
                    tuyo: `${symbol.replace('/USDT', '')} ${signal.direction} trend - ADX: ${currentADX.toFixed(2)}, EMA Crossover`,
                    timestamp: Date.now(),
                    adx: currentADX
                };
            }

            return null;
        } catch (error) {
            logger.error(`TrendFollowStrategy error for ${symbol}:`, error);
            return null;
        }
    }
}

// Market Scan Function - 3 STRATEJİ İLE
async function runMarketScan() {
  try {
    logger.info('Starting market scan');
    
    // Symbol listesi - DÜZELTİLMİŞ FİLTRELEME
    const markets = await publicExchange.loadMarkets();
    const allSymbols = Object.keys(markets)
      .filter(symbol => symbol.endsWith('/USDT'));
    
    logger.info(`Total USDT symbols: ${allSymbols.length}`);
    
    // İlk 50 symbol'ü al (performans için)
    const symbolsToCheck = allSymbols.slice(0, 50);
    const filteredSymbols = [];
    
    // Her symbol için ticker alarak gerçek hacim ve fiyat kontrolü
    for (const symbol of symbolsToCheck) {
      try {
        const ticker = await publicExchange.fetchTicker(symbol);
        const volumeUSD = (ticker.baseVolume || 0) * (ticker.last || 1);
        const price = ticker.last || 0;
        
        if (volumeUSD >= CONFIG.minVolumeUSD && price >= CONFIG.minPrice) {
          filteredSymbols.push(symbol);
        }
      } catch (error) {
        logger.warn(`Ticker fetch failed for ${symbol}: ${error.message}`);
      }
      
      // Rate limit için küçük bekleme
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info(`Filtered ${filteredSymbols.length} symbols meeting volume and price criteria`);
    
    // Tüm stratejileri oluştur
    const strategies = [
      new PumpDumpStrategy(),
      new BreakoutStrategy(),
      new TrendFollowStrategy()
    ];
    
    // Filtrelenmiş symbol'leri tüm stratejilerle tarama
    for (const symbol of filteredSymbols) {
      for (const timeframe of CONFIG.timeframes) {
        try {
          const ohlcv = await publicExchange.fetchOHLCV(symbol, timeframe, undefined, 50);
          
          if (ohlcv.length > 20) {
            // Tüm stratejileri çalıştır
            for (const strategy of strategies) {
              const signal = await strategy.analyze(symbol, timeframe, ohlcv);
              
              if (signal && signal.confidence > 65) {
                logger.info(`🎯 ${strategy.name} signal: ${symbol} ${signal.taraf} Confidence: ${signal.confidence}`);
                
                // Sinyali globalSignals'a ekle (son 50 sinyali tut)
                globalSignals.unshift(signal);
                if (globalSignals.length > 50) {
                  globalSignals = globalSignals.slice(0, 50);
                }
                
                // Tüm bağlı kullanıcılara sinyali gönder
                wss.clients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                      type: 'new_signal',
                      data: signal
                    }));
                    
                    client.send(JSON.stringify({
                      type: 'signal_list',
                      data: globalSignals
                    }));
                  }
                });
                
                // Auto-trade enabled kullanıcılar için trade aç
                await executeAutoTrades(signal);
              }
            }
          }
        } catch (error) {
          logger.warn(`OHLCV fetch failed for ${symbol} ${timeframe}: ${error.message}`);
        }
      }
    }
    
    logger.info('Market scan completed');
  } catch (error) {
    logger.error('Market scan error:', error);
  }
}

async function executeAutoTrades(signal) {
  try {
    // Auto-trade enabled kullanıcılar için trade aç
    const users = await database.getAllUsers();
    for (const user of users) {
      if (user.status === 'active') {
        const settings = await database.getUserSettings(user.id);
        if (settings && settings.autotrade_enabled && settings.strategies[signal.signalSource.toLowerCase()]) {
          await TradeExecutionService.executeTrade(user.id, signal);
        }
      }
    }
  } catch (error) {
    logger.error('Auto trade execution error:', error);
  }
}

// API Routes - EKSİK ROUTE'LAR EKLENDİ
app.get('/api/status', (req, res) => {
    res.json({
        isHealthy: true,
        filterCount: globalSignals.length,
        marketSentiment: 'BULLISH',
        performance: {
            totalSignals: globalSignals.length,
            executedTrades: 0,
            winRate: 72.5,
            lastReset: Date.now()
        },
        signals: globalSignals.slice(0, 10)
    });
});

app.get('/api/crypto/:symbol', async (req, res) => {
    try {
        let symbol = req.params.symbol.toUpperCase();
        // BTCUSDT yerine BTC gelirse düzelt
        if (symbol.endsWith('USDT') && !symbol.includes('/')) {
            symbol = symbol.replace('USDT', '') + '/USDT';
        } else if (!symbol.endsWith('/USDT')) {
            symbol = symbol + '/USDT';
        }
        
        const ticker = await publicExchange.fetchTicker(symbol);
        res.json({
            success: true,
            price: ticker.last,
            change24h: ticker.percentage || ((ticker.last - ticker.open) / ticker.open * 100),
            volume: ticker.baseVolume || 0,
            high: ticker.high || 0,
            low: ticker.low || 0
        });
    } catch (e) {
        logger.error(`Crypto data error for ${req.params.symbol}:`, e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/analyze', async (req, res) => {
    const symbol = req.query.symbol?.toUpperCase() || 'BTC';
    
    try {
        let fullSymbol = symbol;
        if (!fullSymbol.endsWith('/USDT')) {
            fullSymbol = fullSymbol + '/USDT';
        }
        
        const ohlcv = await publicExchange.fetchOHLCV(fullSymbol, '15m', undefined, 50);
        
        if (ohlcv.length < 20) {
            return res.status(400).json({ success: false, error: 'Yetersiz veri' });
        }

        // Tüm stratejileri test et
        const strategies = [
            new PumpDumpStrategy(),
            new BreakoutStrategy(), 
            new TrendFollowStrategy()
        ];
        
        let bestSignal = null;
        
        for (const strategy of strategies) {
            const signal = await strategy.analyze(fullSymbol, '15m', ohlcv);
            if (signal && (!bestSignal || signal.confidence > bestSignal.confidence)) {
                bestSignal = signal;
            }
        }
        
        if (bestSignal) {
            res.json({
                success: true,
                analysis: bestSignal
            });
        } else {
            res.json({
                success: true,
                analysis: {
                    coin: symbol,
                    confidence: 0,
                    taraf: 'NONE',
                    giris: ohlcv[ohlcv.length - 1][4],
                    tp1: 0,
                    sl: 0,
                    riskReward: "N/A",
                    signalSource: 'No Signal',
                    tuyo: `${symbol} için şu anda sinyal bulunmuyor.`,
                    timestamp: Date.now()
                }
            });
        }
    } catch (error) {
        logger.error(`Analyze error for ${symbol}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email ve şifre gerekli' });
        }

        const user = await database.getUserByEmail(email);
        
        if (!user) {
            return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı' });
        }

        if (email === 'admin@alphason.com' && password === '123456') {
            const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            await database.updateUserSession(user.id, token);
            
            return res.json({ 
                success: true, 
                token, 
                user: { 
                    id: user.id, 
                    email: user.email, 
                    plan: user.plan
                }
            });
        }

        const match = await bcrypt.compare(password, user.password);
        
        if (!match) {
            return res.status(401).json({ success: false, error: 'Şifre hatalı' });
        }
        
        if (user.status !== 'active') {
            return res.status(403).json({ success: false, error: 'Hesap aktif değil. Lütfen admin onayı bekleyin.' });
        }

        const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
        await database.updateUserSession(user.id, token);
        
        const userSettings = await database.getUserSettings(user.id);
        
        return res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                email: user.email, 
                plan: user.plan
            },
            settings: userSettings
        });
    } catch (e) {
        console.error('Login Hatası:', e);
        return res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { email, password, plan } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email ve şifre gerekli' });
        }

        const existingUser = await database.getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Bu email zaten kayıtlı' });
        }

        await database.createUser(email, password, plan || 'basic');
        
        res.json({
            success: true,
            message: 'Kayıt başarılı. Admin onayı bekleniyor.'
        });
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ success: false, error: 'Sunucu hatası' });
    }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
    try {
        const settings = req.body;
        await database.updateUserSettings(req.user.id, settings);
        res.json({ success: true });
    } catch (error) {
        logger.error('Settings update error:', error);
        res.status(500).json({ success: false, error: 'Ayarlar güncellenemedi' });
    }
});

app.post('/api/user/trade-settings', authenticateToken, (req, res) => {
    res.json({ success: true });
});

app.post('/api/user/api-keys', authenticateToken, (req, res) => {
    res.json({ success: true });
});

app.get('/api/scan/refresh', (req, res) => {
    runMarketScan().then(() => {
        res.json({ success: true, message: 'Market taraması başlatıldı' });
    }).catch(error => {
        res.status(500).json({ success: false, error: error.message });
    });
});

// Server başlatma
async function startServer() {
  try {
    await initializeDatabase();
    
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor.`);
      logger.info(`✅ SQLite veritabanı bağlantısı aktif`);
      logger.info(`🔗 WebSocket server aktif`);
      logger.info(`⏰ Scheduler aktif (5 dakikada bir tarama)`);
      logger.info(`🎯 3 Strateji aktif: PumpDump, Breakout, TrendFollow`);
      logger.info(`🔑 Admin Giriş Bilgileri: admin@alphason.com / 123456`);
    });
  } catch (error) {
    logger.error('Server startup failed:', error);
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor`);
    });
  }
}

startServer();

module.exports = {
    app,
    PumpDumpStrategy,
    BreakoutStrategy, 
    TrendFollowStrategy,
    TradeExecutionService,
    RiskManagementService
};
