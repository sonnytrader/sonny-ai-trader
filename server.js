require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');
const winston = require('winston');
const cron = require('node-cron');
const { EMA, RSI, ADX, ATR, OBV, MACD } = require('technicalindicators');

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

// PostgreSQL Configuration
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'trading_bot',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Database initialization
async function initializeDatabase() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        plan VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        balance DECIMAL(15,2) DEFAULT 0,
        total_pnl DECIMAL(15,2) DEFAULT 0,
        daily_pnl DECIMAL(15,2) DEFAULT 0,
        api_key TEXT,
        api_secret TEXT,
        api_passphrase TEXT,
        leverage INTEGER DEFAULT 10,
        margin_percent DECIMAL(5,2) DEFAULT 5.0,
        risk_level VARCHAR(50) DEFAULT 'medium',
        daily_trade_limit INTEGER DEFAULT 50,
        max_positions INTEGER DEFAULT 10,
        session_token TEXT,
        subscription_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // User settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        min_confidence INTEGER DEFAULT 65,
        autotrade_enabled BOOLEAN DEFAULT false,
        order_type VARCHAR(50) DEFAULT 'limit',
        strategies JSONB DEFAULT '{"breakout": true, "trendfollow": true, "pumpdump": true}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Trades table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        symbol VARCHAR(50) NOT NULL,
        strategy VARCHAR(100) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        entry_price DECIMAL(15,8) NOT NULL,
        exit_price DECIMAL(15,8),
        quantity DECIMAL(15,8) NOT NULL,
        stop_loss DECIMAL(15,8),
        take_profit DECIMAL(15,8),
        confidence INTEGER,
        pnl DECIMAL(15,2),
        pnl_percentage DECIMAL(8,2),
        status VARCHAR(50) DEFAULT 'open',
        opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP,
        metadata JSONB
      )
    `);

    // Signals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(50) NOT NULL,
        strategy VARCHAR(100) NOT NULL,
        direction VARCHAR(10) NOT NULL,
        confidence INTEGER NOT NULL,
        price DECIMAL(15,8) NOT NULL,
        stop_loss DECIMAL(15,8),
        take_profit DECIMAL(15,8),
        volume_ratio DECIMAL(10,2),
        price_change DECIMAL(8,2),
        timeframe VARCHAR(20),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Risk management table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS risk_management (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        max_daily_loss DECIMAL(15,2) DEFAULT 500,
        max_position_size DECIMAL(15,2) DEFAULT 1000,
        daily_loss_so_far DECIMAL(15,2) DEFAULT 0,
        open_positions_count INTEGER DEFAULT 0,
        last_reset_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed:', error);
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

// Database helper fonksiyonları - PostgreSQL ile
const database = {
  async getUserByEmail(email) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );
      const user = result.rows[0];
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
      const result = await pool.query(
        'SELECT * FROM users WHERE session_token = $1',
        [token]
      );
      const user = result.rows[0];
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
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await pool.query(
        `INSERT INTO users (email, password, plan) 
         VALUES ($1, $2, $3) RETURNING *`,
        [email, hashedPassword, plan]
      );
      return result.rows[0].id;
    } catch (error) {
      logger.error('createUser error:', error);
      throw error;
    }
  },

  async updateUserSession(userId, token) {
    try {
      await pool.query(
        'UPDATE users SET session_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [token, userId]
      );
    } catch (error) {
      logger.error('updateUserSession error:', error);
    }
  },

  async getUserSettings(userId) {
    try {
      const result = await pool.query(
        'SELECT * FROM user_settings WHERE user_id = $1',
        [userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0];
      } else {
        // Default settings oluştur
        const insertResult = await pool.query(
          `INSERT INTO user_settings (user_id) VALUES ($1) RETURNING *`,
          [userId]
        );
        return insertResult.rows[0];
      }
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

      const existing = await pool.query(
        'SELECT id FROM user_settings WHERE user_id = $1',
        [userId]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE user_settings SET 
           min_confidence = $1, autotrade_enabled = $2, order_type = $3,
           strategies = $4, api_key = $5, api_secret = $6, api_passphrase = $7,
           updated_at = CURRENT_TIMESTAMP 
           WHERE user_id = $8`,
          [
            newSettings.min_confidence,
            newSettings.autotrade_enabled,
            newSettings.order_type,
            JSON.stringify(newSettings.strategies),
            newSettings.api_key,
            newSettings.api_secret,
            newSettings.api_passphrase,
            userId
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO user_settings 
           (user_id, min_confidence, autotrade_enabled, order_type, strategies, api_key, api_secret, api_passphrase)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId,
            newSettings.min_confidence,
            newSettings.autotrade_enabled,
            newSettings.order_type,
            JSON.stringify(newSettings.strategies),
            newSettings.api_key,
            newSettings.api_secret,
            newSettings.api_passphrase
          ]
        );
      }
      return { success: true };
    } catch (error) {
      logger.error('updateUserSettings error:', error);
      throw error;
    }
  },

  async createTrade(tradeData) {
    try {
      const result = await pool.query(
        `INSERT INTO trades 
         (user_id, symbol, strategy, direction, entry_price, quantity, stop_loss, take_profit, confidence, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          tradeData.user_id,
          tradeData.symbol,
          tradeData.strategy,
          tradeData.direction,
          tradeData.entry_price,
          tradeData.quantity,
          tradeData.stop_loss,
          tradeData.take_profit,
          tradeData.confidence,
          JSON.stringify(tradeData.metadata || {})
        ]
      );
      logger.info(`Trade created: ${tradeData.symbol} ${tradeData.direction}`);
      return result.rows[0];
    } catch (error) {
      logger.error('createTrade error:', error);
      throw error;
    }
  },

  async closeTrade(tradeId, exitPrice, pnl) {
    try {
      await pool.query(
        `UPDATE trades SET 
         exit_price = $1, pnl = $2, pnl_percentage = $3, status = 'closed', closed_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [exitPrice, pnl, ((pnl / exitPrice) * 100), tradeId]
      );
      logger.info(`Trade closed: ${tradeId}, PnL: ${pnl}`);
    } catch (error) {
      logger.error('closeTrade error:', error);
      throw error;
    }
  },

  async getOpenTrades(userId) {
    try {
      const result = await pool.query(
        'SELECT * FROM trades WHERE user_id = $1 AND status = $2',
        [userId, 'open']
      );
      return result.rows;
    } catch (error) {
      logger.error('getOpenTrades error:', error);
      return [];
    }
  },

  async getRiskManagement(userId) {
    try {
      const result = await pool.query(
        'SELECT * FROM risk_management WHERE user_id = $1',
        [userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0];
      } else {
        // Default risk management oluştur
        const insertResult = await pool.query(
          `INSERT INTO risk_management (user_id) VALUES ($1) RETURNING *`,
          [userId]
        );
        return insertResult.rows[0];
      }
    } catch (error) {
      logger.error('getRiskManagement error:', error);
      return null;
    }
  },

  async updateDailyLoss(userId, lossAmount) {
    try {
      await pool.query(
        `UPDATE risk_management SET 
         daily_loss_so_far = daily_loss_so_far + $1,
         updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [lossAmount, userId]
      );
    } catch (error) {
      logger.error('updateDailyLoss error:', error);
    }
  },

  async resetDailyLoss() {
    try {
      await pool.query(
        `UPDATE risk_management SET 
         daily_loss_so_far = 0,
         last_reset_date = CURRENT_DATE,
         updated_at = CURRENT_TIMESTAMP`
      );
      logger.info('Daily loss counters reset');
    } catch (error) {
      logger.error('resetDailyLoss error:', error);
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
        '/api/crypto/btc', '/api/crypto/eth', '/api/analyze',
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
    minVolumeUSD: 300000,
    minPrice: 0.05,
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
    options: { defaultType: 'swap' },
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
const userExchanges = new Map(); // Kullanıcı bazlı exchange instance'ları

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
      
      // Max position size kontrolü
      if (positionValue > risk.max_position_size) {
        logger.warn(`Position size too large for user ${userId}: ${positionValue} > ${risk.max_position_size}`);
        return false;
      }
      
      // Max open positions kontrolü
      if (openTrades.length >= risk.max_positions) {
        logger.warn(`Max open positions reached for user ${userId}`);
        return false;
      }
      
      // Daily loss limit kontrolü (basit versiyon)
      if (risk.daily_loss_so_far <= -risk.max_daily_loss) {
        logger.warn(`Daily loss limit reached for user ${userId}`);
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
      const user = await database.getUserByToken(userId); // Bu örnek için basitleştirildi
      if (!user || !user.api_key || !user.api_secret) {
        logger.warn(`User ${userId} has no API credentials`);
        return null;
      }
      
      // Risk kontrolü
      const quantity = this.calculatePositionSize(user, signal);
      const canTrade = await RiskManagementService.canOpenTrade(userId, signal.symbol, quantity, signal.price);
      
      if (!canTrade) {
        logger.warn(`Risk check failed for user ${userId}, symbol: ${signal.symbol}`);
        return null;
      }
      
      // Exchange instance oluştur
      const exchange = this.getUserExchange(user);
      
      // Trade oluştur
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
      
      // Gerçek trade execution (simüle edildi)
      logger.info(`Executing trade for user ${userId}: ${signal.symbol} ${signal.direction} at ${signal.price}`);
      
      // WebSocket ile real-time update
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
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'AUTHENTICATE':
          const user = await database.getUserByToken(data.token);
          if (user) {
            userConnections.set(user.id, ws);
            ws.userId = user.id;
            ws.send(JSON.stringify({
              type: 'AUTHENTICATED',
              user: { id: user.id, email: user.email }
            }));
            logger.info(`User ${user.email} authenticated via WebSocket`);
          } else {
            ws.send(JSON.stringify({
              type: 'AUTH_ERROR',
              error: 'Invalid token'
            }));
          }
          break;
          
        case 'GET_OPEN_TRADES':
          if (ws.userId) {
            const openTrades = await database.getOpenTrades(ws.userId);
            ws.send(JSON.stringify({
              type: 'OPEN_TRADES',
              trades: openTrades
            }));
          }
          break;
          
        case 'CLOSE_TRADE':
          if (ws.userId && data.tradeId) {
            // Burada gerçek exchange'de pozisyon kapatma işlemi yapılacak
            // Şimdilik simüle ediyoruz
            await database.closeTrade(data.tradeId, data.exitPrice, data.pnl);
            ws.send(JSON.stringify({
              type: 'TRADE_CLOSED',
              tradeId: data.tradeId
            }));
          }
          break;
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        error: 'Invalid message format'
      }));
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
cron.schedule('*/5 * * * *', async () => { // 5 dakikada bir
  logger.info('Running scheduled scan');
  await runMarketScan();
});

cron.schedule('0 0 * * *', async () => { // Her gün gece yarısı
  logger.info('Resetting daily counters');
  await database.resetDailyLoss();
});

// Market Scan Function - ORİJİNAL FİLTRELEME SİSTEMİ
async function runMarketScan() {
  try {
    logger.info('Starting market scan');
    
    // Symbol listesini al - ORİJİNAL FİLTRELEME
    const markets = await publicExchange.loadMarkets();
    const symbols = Object.keys(markets)
      .filter(symbol => symbol.endsWith('/USDT'))
      .filter(symbol => {
        const market = markets[symbol];
        const volumeUSD = (market.baseVolume || 0) * (market.info?.lastPrice || 1);
        const price = market.info?.lastPrice || 0;
        return volumeUSD >= CONFIG.minVolumeUSD && price >= CONFIG.minPrice;
      });
    
    logger.info(`Filtered ${symbols.length} symbols meeting volume and price criteria`);
    
    // Symbol'leri tarama
    for (const symbol of symbols) {
      for (const timeframe of CONFIG.timeframes) {
        const ohlcv = await publicExchange.fetchOHLCV(symbol, timeframe, undefined, 50);
        
        if (ohlcv.length > 20) {
          // Stratejileri çalıştır
          const pumpDumpStrategy = new PumpDumpStrategy();
          const signal = await pumpDumpStrategy.analyze(symbol, timeframe, ohlcv);
          
          if (signal && signal.confidence > 65) {
            logger.info(`Signal generated: ${symbol} ${signal.direction} Confidence: ${signal.confidence}`);
            
            // Signal'i database'e kaydet
            await pool.query(
              `INSERT INTO signals (symbol, strategy, direction, confidence, price, stop_loss, take_profit, volume_ratio, price_change, timeframe, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                signal.symbol,
                signal.strategy,
                signal.direction,
                signal.confidence,
                signal.price,
                signal.stopLoss,
                signal.takeProfit,
                signal.volumeRatio,
                signal.priceChange,
                signal.timeframe,
                JSON.stringify(signal.metadata)
              ]
            );
            
            // Auto-trade enabled kullanıcılar için trade aç
            await executeAutoTrades(signal);
            
            // WebSocket broadcast
            broadcastSignal(signal);
          }
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
    // Auto-trade enabled kullanıcıları bul
    const result = await pool.query(
      `SELECT u.id, u.balance, u.leverage, u.margin_percent, us.autotrade_enabled
       FROM users u
       JOIN user_settings us ON u.id = us.user_id
       WHERE u.status = 'active' AND us.autotrade_enabled = true`
    );
    
    for (const user of result.rows) {
      if (user.strategies && user.strategies[signal.strategy.toLowerCase()]) {
        await TradeExecutionService.executeTrade(user.id, signal);
      }
    }
  } catch (error) {
    logger.error('Auto trade execution error:', error);
  }
}

function broadcastSignal(signal) {
  const message = JSON.stringify({
    type: 'NEW_SIGNAL',
    signal: signal
  });
  
  userConnections.forEach((ws, userId) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// GÜNCELLENMİŞ PumpDumpStrategy
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
            // Cooldown kontrolü
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

            // Son mum hariç önceki 15 mumun ortalama hacmi
            const previousVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
            const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;

            // Hacim oranı
            const volumeRatio = currentVolume / avgVolume;

            // Fiyat değişimi
            const previousClose = closes[closes.length - 2];
            const priceChange = ((currentClose - previousClose) / previousClose) * 100;

            // ATR hesaplama
            const high = ohlcv.map(d => d[2]);
            const low = ohlcv.map(d => d[3]);
            const atr = await ATR.calculate({
                high: high.slice(-14),
                low: low.slice(-14),
                close: closes.slice(-14),
                period: 14
            });

            const currentATR = atr[atr.length - 1] || 0;

            // Pump/Dump tespiti
            if (Math.abs(priceChange) >= this.priceChangeThreshold && volumeRatio >= this.volumeRatioThreshold) {
                const direction = priceChange > 0 ? 'LONG' : 'SHORT';
                
                // Confidence hesaplama
                let confidence = 50;
                confidence += 20; // Pump/Dump tespiti için +20
                
                if (volumeRatio >= 3.0) confidence += 15;
                else if (volumeRatio >= 2.0) confidence += 10;
                else if (volumeRatio >= 1.5) confidence += 5;

                // ATR'ye göre SL/TP hesapla
                const stopLoss = currentATR * this.atrSLMultiplier;
                const takeProfit = currentATR * this.atrTPMultiplier;

                // Cooldown'a ekle
                this.recentSignals.set(symbol, now);

                return {
                    symbol,
                    strategy: this.name,
                    direction,
                    confidence: Math.min(confidence, 95),
                    price: currentClose,
                    stopLoss,
                    takeProfit,
                    volumeRatio,
                    priceChange: Math.abs(priceChange),
                    timeframe,
                    timestamp: Date.now(),
                    metadata: {
                        atr: currentATR,
                        avgVolume,
                        currentVolume
                    }
                };
            }

            return null;
        } catch (error) {
            logger.error(`PumpDumpStrategy error for ${symbol}:`, error);
            return null;
        }
    }
}

// GÜNCELLENMİŞ confirmBreakoutWithVolume
const confirmBreakoutWithVolume = (symbol, ohlcv, breakoutPrice, direction) => {
    try {
        if (ohlcv.length < 20) {
            return { confirmed: false, strength: 'WEAK', volumeRatio: 1 };
        }

        const volumes = ohlcv.map(d => d[5]);
        
        // Son mumu (breakout mumunu) hariç tut
        const previousVolumes = volumes.slice(-21, -1);
        const avgVolume = previousVolumes.reduce((sum, vol) => sum + vol, 0) / previousVolumes.length;
        
        const currentVolume = volumes[volumes.length - 1];
        const volumeRatio = currentVolume / avgVolume;

        // Güç seviyelerini volumeRatio'ya göre ayarla
        let strength = 'WEAK';
        if (volumeRatio >= 3.0) {
            strength = 'STRONG';
        } else if (volumeRatio >= 2.0) {
            strength = 'MEDIUM';
        } else if (volumeRatio >= 1.3) {
            strength = 'WEAK';
        }

        const confirmed = volumeRatio >= CONFIG.volumeConfirmationThreshold;

        return {
            confirmed,
            strength,
            volumeRatio,
            avgVolume,
            currentVolume,
            breakoutPrice,
            direction
        };
    } catch (error) {
        logger.error(`Volume confirmation error for ${symbol}:`, error);
        return { confirmed: false, strength: 'WEAK', volumeRatio: 1 };
    }
};

// API Routes
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

        // Admin şifresi kontrolü
        if (email === 'admin@alphason.com' && password === '123456') {
            const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
            await database.updateUserSession(user.id, token);
            
            return res.json({ 
                success: true, 
                token, 
                user: { 
                    id: user.id, 
                    email: user.email, 
                    plan: user.plan,
                    balance: user.balance,
                    total_pnl: user.total_pnl,
                    daily_pnl: user.daily_pnl
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
                plan: user.plan,
                balance: user.balance,
                total_pnl: user.total_pnl,
                daily_pnl: user.daily_pnl
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
        
        if (!email || !password || !plan) {
            return res.status(400).json({ success: false, error: 'Email, şifre ve plan gerekli' });
        }

        if (await database.getUserByEmail(email)) {
            return res.status(400).json({ success: false, error: 'Email kullanımda' });
        }
        
        await database.createUser(email, password, plan);
        return res.json({ success: true, message: 'Kayıt başarılı, admin onayı bekleniyor' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/status', (req, res) => {
    return res.json(systemStatus);
});

app.get('/api/crypto/:symbol', async (req, res) => {
    try {
        const baseSymbol = req.params.symbol?.toUpperCase();
        if (!baseSymbol) {
             return res.status(400).json({ success: false, error: 'Geçersiz sembol.' });
        }

        const symbol = baseSymbol + '/USDT';
        const ticker = await publicExchange.fetchTicker(symbol);

        if (ticker) {
            return res.json({ 
                success: true, 
                price: ticker.last, 
                change24h: ticker.percentage, 
                volume: ticker.baseVolume || 0,
                signal: 'NEUTRAL'
            });
        } else {
            return res.status(404).json({ success: false, error: 'Veri yok' });
        }
    } catch (e) {
        console.error('Crypto Veri Hatası:', e.message);
        return res.status(500).json({ success: false, error: 'Sunucu hatası.' });
    }
});

app.get('/api/user/info', authenticateToken, (req, res) => {
    return res.json({ success: true, user: req.user });
});

app.post('/api/logout', authenticateToken, async (req, res) => {
    try {
        if (req.user) {
            await database.updateUserSession(req.user.id, null);
        }
        return res.json({ success: true, message: 'Çıkış başarılı' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        const settings = await database.getUserSettings(req.user.id);
        return res.json({ success: true, settings });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
    try {
        await database.updateUserSettings(req.user.id, req.body);
        return res.json({ success: true, message: 'Ayarlar güncellendi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/pending-users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const pendingUsers = await database.getPendingUsers();
        return res.json({ success: true, users: pendingUsers });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/all-users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const allUsers = await database.getAllUsers();
        return res.json({ success: true, users: allUsers });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/approve-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.approveUser(parseInt(req.params.userId), req.user.id);
        return res.json({ success: true, message: 'Kullanıcı onaylandı' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/reject-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.rejectUser(parseInt(req.params.userId), req.user.id);
        return res.json({ success: true, message: 'Kullanıcı reddedildi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/admin/delete-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await database.deleteUser(parseInt(req.params.userId));
        return res.json({ success: true, message: 'Kullanıcı silindi' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// 404 Handler
app.use('*', (req, res) => {
    return res.status(404).json({ success: false, error: 'Route bulunamadı' });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error('Sunucu Hatası:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// Server başlatma
async function startServer() {
  try {
    await initializeDatabase();
    
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Sunucu Port ${PORT} üzerinde çalışıyor.`);
      logger.info(`✅ SQLite veritabanı bağlantısı aktif`); // 👈 BURASI DÜZELTİLDİ
      logger.info(`🔗 WebSocket server aktif`);
      logger.info(`⏰ Scheduler aktif (5 dakikada bir tarama)`);
      logger.info(`🔑 Admin Giriş Bilgileri: admin@alphason.com / 123456`);
    });
  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
}

startServer();

module.exports = {
    app,
    PumpDumpStrategy,
    confirmBreakoutWithVolume,
    TradeExecutionService,
    RiskManagementService
};
