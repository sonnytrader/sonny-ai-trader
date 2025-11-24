// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV, Stochastic, MACD } = require('technicalindicators');

// Modüler sistemler
const db = require('./database');
const Backtester = require('./backtesting/backtester');
const RiskManager = require('./risk/risk_manager');
const StrategyManager = require('./strategies/strategy_manager');
const PerformanceTracker = require('./analytics/performance');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================== GLOBAL SYSTEMS ==================
const strategyManager = new StrategyManager();
const riskManager = new RiskManager();
const performanceTracker = new PerformanceTracker();

// User-specific configs
const userConfigs = new Map();
const userExchanges = new Map();

// ================== USER MANAGEMENT ==================
class UserManager {
  static async getUserConfig(userId) {
    return new Promise((resolve, reject) => {
      db.get(`
        SELECT u.*, 
               uc.leverage, uc.margin_percent, uc.risk_profile, uc.scalp_mode, 
               uc.autotrade, uc.min_confidence, uc.order_type,
               uc.strategies_breakout, uc.strategies_trendfollow, uc.strategies_pumpdump
        FROM users u 
        LEFT JOIN user_configs uc ON u.id = uc.user_id 
        WHERE u.id = ?
      `, [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  static async updateUserConfig(userId, config) {
    return new Promise((resolve, reject) => {
      db.run(`
        INSERT OR REPLACE INTO user_configs 
        (user_id, leverage, margin_percent, risk_profile, scalp_mode, autotrade, min_confidence, order_type, strategies_breakout, strategies_trendfollow, strategies_pumpdump)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        config.leverage || 10,
        config.marginPercent || 5,
        config.riskProfile || 'balanced',
        config.scalpMode ? 1 : 0,
        config.autotrade ? 1 : 0,
        config.minConfidence || 60,
        config.orderType || 'limit',
        config.strategies?.breakout ? 1 : 0,
        config.strategies?.trendfollow ? 1 : 0,
        config.strategies?.pumpdump ? 1 : 0
      ], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  static async getUserExchange(userId) {
    return new Promise((resolve, reject) => {
      db.get(`
        SELECT api_key, api_secret, api_passphrase 
        FROM users WHERE id = ?
      `, [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
}

// ================== AUTH MIDDLEWARE ==================
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const user = await new Promise((resolve, reject) => {
      db.get(`
        SELECT id, email, plan, verified 
        FROM users WHERE session_token = ? AND session_expiry > datetime('now')
      `, [token], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    req.user = user;
    
    // Load user config if not loaded
    if (!userConfigs.has(user.id)) {
      const userConfig = await UserManager.getUserConfig(user.id);
      userConfigs.set(user.id, userConfig);
      
      // Initialize user exchange
      const apiConfig = await UserManager.getUserExchange(user.id);
      if (apiConfig.api_key && apiConfig.api_secret) {
        userExchanges.set(user.id, new ccxt.bitget({
          apiKey: apiConfig.api_key,
          secret: apiConfig.api_secret,
          password: apiConfig.api_passphrase,
          options: { defaultType: 'swap' },
          timeout: 30000,
          enableRateLimit: true
        }));
      }
    }

    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Authentication failed' });
  }
};

// ================== ENHANCED ANALYZER ==================
class AdvancedAnalyzer {
  constructor() {
    this.signalHistory = new Map();
    this.ohlcvCache = new Map();
    this.signalCache = new Map();
    this.SIGNAL_CACHE_DURATION = 60 * 60 * 1000;
  }

  async analyzeSymbol(symbol, userId) {
    const userConfig = userConfigs.get(userId);
    if (!userConfig) return null;

    const lastTs = this.signalHistory.get(symbol) || 0;
    if (Date.now() - lastTs < (userConfig.signal_cooldown || 30 * 60 * 1000)) {
      return null;
    }

    try {
      const exchange = userExchanges.get(userId);
      if (!exchange) return null;

      const ticker = await exchange.fetchTicker(symbol);
      if (!ticker || ticker.last < 0.05) return null;

      const multiTimeframe = await this.fetchMultiTimeframe(symbol, exchange);
      if (!multiTimeframe['15m'] || multiTimeframe['15m'].length < 80) return null;

      // Multi-strategy analysis
      const strategySignals = await strategyManager.runMultiStrategyAnalysis(
        symbol, 
        multiTimeframe, 
        userConfig
      );

      const bestSignal = this.consolidateSignals(strategySignals, userConfig);
      if (!bestSignal || bestSignal.confidence < userConfig.min_confidence) return null;

      // Risk management check
      const riskAssessment = await riskManager.assessSignal(bestSignal, userId);
      if (!riskAssessment.approved) return null;

      this.signalHistory.set(symbol, Date.now());
      this.signalCache.set(bestSignal.id, bestSignal);

      return bestSignal;
    } catch (error) {
      console.error(`Analysis error for ${symbol}:`, error);
      return null;
    }
  }

  async fetchMultiTimeframe(symbol, exchange) {
    const timeframes = ['15m', '1h', '4h'];
    const result = {};
    
    for (const tf of timeframes) {
      try {
        const ohlcv = await exchange.fetchOHLCV(symbol, tf, undefined, 150);
        result[tf] = ohlcv;
      } catch (error) {
        result[tf] = null;
      }
    }
    
    return result;
  }

  consolidateSignals(strategySignals, userConfig) {
    let bestSignal = null;
    let maxScore = 0;

    for (const [strategyName, signals] of Object.entries(strategySignals)) {
      for (const signal of signals) {
        const score = this.calculateSignalScore(signal, userConfig);
        if (score > maxScore) {
          maxScore = score;
          bestSignal = signal;
        }
      }
    }

    return bestSignal;
  }

  calculateSignalScore(signal, userConfig) {
    let score = signal.confidence;
    
    // Strategy weighting
    const strategyWeights = {
      breakout: userConfig.strategies_breakout ? 1.0 : 0,
      trendfollow: userConfig.strategies_trendfollow ? 1.0 : 0,
      pumpdump: userConfig.strategies_pumpdump ? 1.0 : 0
    };
    
    score *= strategyWeights[signal.strategy] || 0.5;
    
    // Volume boost
    if (signal.volumeLevel === 'high') score += 15;
    else if (signal.volumeLevel === 'medium') score += 8;
    
    // Risk/Reward boost
    if (signal.riskReward > 2.0) score += 10;
    
    return Math.min(100, score);
  }
}

const analyzer = new AdvancedAnalyzer();

// ================== ENHANCED AUTOTRADE ==================
class EnhancedAutoTrade {
  async execute(signal, userId, isManual = false) {
    try {
      const userConfig = userConfigs.get(userId);
      const exchange = userExchanges.get(userId);
      
      if (!exchange && !isManual) return { success: false, error: 'Exchange not configured' };

      if (!isManual && userConfig.autotrade && signal.confidence < userConfig.min_confidence) {
        return { success: false, error: 'Confidence too low for auto trade' };
      }

      // Risk management
      const riskCheck = await riskManager.checkTradeConditions(userId, signal);
      if (!riskCheck.approved) {
        return { success: false, error: riskCheck.reason };
      }

      const symbol = signal.ccxt_symbol;
      const currentPrice = await this.getCurrentPrice(symbol, exchange);
      let entryPrice = signal.giris;
      
      if (userConfig.order_type === 'market') {
        entryPrice = currentPrice;
      }

      // Position sizing
      const positionSize = await riskManager.calculatePositionSize(userId, signal, userConfig);
      
      await exchange.setLeverage(userConfig.leverage, symbol);
      
      const balance = await exchange.fetchBalance();
      const freeBalance = parseFloat(balance.USDT?.free || 0);
      
      if (freeBalance < 10) {
        return { success: false, error: 'Insufficient balance' };
      }

      const side = signal.direction === 'LONG' ? 'buy' : 'sell';
      const amount = positionSize.amount;
      
      const order = await this.placeOrder(exchange, symbol, side, amount, entryPrice, userConfig.order_type);
      
      if (order) {
        await this.placeTPSL(exchange, symbol, side, amount, signal.tp1, signal.sl);
        
        // Record trade
        await this.recordTrade(userId, signal, order, positionSize);
        
        performanceTracker.recordTrade(userId, {
          symbol: signal.coin,
          strategy: signal.strategy,
          direction: signal.direction,
          entryPrice,
          exitPrice: null,
          amount,
          pnl: null,
          status: 'open'
        });

        return { success: true, orderId: order.id };
      }

      return { success: false, error: 'Order failed' };
    } catch (error) {
      console.error('Trade execution error:', error);
      return { success: false, error: error.message };
    }
  }

  async placeOrder(exchange, symbol, side, amount, price, orderType) {
    try {
      if (orderType === 'limit') {
        return await exchange.createOrder(symbol, 'limit', side, amount, price);
      } else {
        return await exchange.createOrder(symbol, 'market', side, amount);
      }
    } catch (error) {
      throw new Error(`Order placement failed: ${error.message}`);
    }
  }

  async recordTrade(userId, signal, order, positionSize) {
    return new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO trades (user_id, symbol, direction, strategy, entry_price, tp_price, sl_price, 
                          amount, confidence, order_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
      `, [
        userId,
        signal.coin,
        signal.direction,
        signal.strategy,
        signal.giris,
        signal.tp1,
        signal.sl,
        positionSize.amount,
        signal.confidence,
        order.id
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }
}

const autoTrade = new EnhancedAutoTrade();

// ================== SCANNER SYSTEM ==================
class ScannerSystem {
  constructor() {
    this.focusedSymbols = [];
    this.cachedHighVol = [];
    this.lastMarketRefresh = 0;
    this.isScanning = false;
  }

  async startUserScan(userId) {
    if (this.isScanning) return;
    
    this.isScanning = true;
    const userConfig = userConfigs.get(userId);
    
    try {
      await this.refreshMarkets(userId);
      
      setInterval(async () => {
        await this.scanBatch(userId);
      }, userConfig.scan_interval || 5 * 60 * 1000);
      
    } catch (error) {
      console.error('Scanner start error:', error);
      this.isScanning = false;
    }
  }

  async scanBatch(userId) {
    if (this.focusedSymbols.length === 0) {
      await this.refreshMarkets(userId);
      return;
    }

    const batch = this.focusedSymbols.splice(0, 10);
    
    for (const symbol of batch) {
      try {
        const signal = await analyzer.analyzeSymbol(symbol, userId);
        if (signal) {
          this.broadcastSignal(userId, signal);
          
          // Auto execute if enabled
          if (userConfigs.get(userId).autotrade) {
            await autoTrade.execute(signal, userId);
          }
        }
      } catch (error) {
        console.error(`Scan error for ${symbol}:`, error);
      }
    }
  }

  async refreshMarkets(userId) {
    try {
      const exchange = userExchanges.get(userId);
      if (!exchange) return;

      await exchange.loadMarkets();
      const tickers = await exchange.fetchTickers();
      
      const allSymbols = Object.keys(exchange.markets).filter(s => {
        const m = exchange.markets[s];
        return m.active && s.includes('USDT') && (m.swap || m.future);
      });

      const highVolSymbols = [];
      for (const s of allSymbols) {
        const t = tickers[s];
        if (t && (t.quoteVolume >= 300000)) {
          highVolSymbols.push(s);
        }
      }

      highVolSymbols.sort((a, b) => (tickers[b]?.quoteVolume || 0) - (tickers[a]?.quoteVolume || 0));
      
      this.cachedHighVol = highVolSymbols;
      this.focusedSymbols = [...highVolSymbols];
      this.lastMarketRefresh = Date.now();

    } catch (error) {
      console.error('Market refresh error:', error);
    }
  }

  broadcastSignal(userId, signal) {
    const msg = JSON.stringify({
      type: 'new_signal',
      data: signal,
      userId: userId
    });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.userId === userId) {
        client.send(msg);
      }
    });
  }
}

const scanner = new ScannerSystem();

// ================== API ROUTES ==================

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Geçersiz şifre' });
    }

    // Create session token
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET session_token = ?, session_expiry = ? WHERE id = ?",
        [sessionToken, sessionExpiry.toISOString(), user.id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Initialize user systems
    const userConfig = await UserManager.getUserConfig(user.id);
    userConfigs.set(user.id, userConfig);

    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        email: user.email, 
        plan: user.plan,
        verified: user.verified 
      },
      token: sessionToken
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, plan = 'basic' } = req.body;
  
  try {
    const existingUser = await new Promise((resolve, reject) => {
      db.get("SELECT id FROM users WHERE email = ?", [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Email zaten kullanımda' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (email, password, plan, created_at) 
         VALUES (?, ?, ?, datetime('now'))`,
        [email, hashedPassword, plan],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Create default config
    await UserManager.updateUserConfig(result, {
      leverage: 10,
      marginPercent: 5,
      riskProfile: 'balanced',
      scalpMode: false,
      autotrade: false,
      minConfidence: 60,
      orderType: 'limit',
      strategies: {
        breakout: true,
        trendfollow: true,
        pumpdump: true
      }
    });

    res.json({ 
      success: true, 
      message: 'Kayıt başarılı. Lütfen giriş yapın.',
      userId: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User Routes
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const userConfig = userConfigs.get(req.user.id);
    const apiConfig = await UserManager.getUserExchange(req.user.id);
    
    res.json({
      success: true,
      profile: {
        user: req.user,
        config: userConfig,
        apiConfigured: !!(apiConfig.api_key && apiConfig.api_secret)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
  try {
    await UserManager.updateUserConfig(req.user.id, req.body);
    
    // Reload config
    const updatedConfig = await UserManager.getUserConfig(req.user.id);
    userConfigs.set(req.user.id, updatedConfig);
    
    res.json({ success: true, message: 'Ayarlar kaydedildi', config: updatedConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/user/api-keys', authMiddleware, async (req, res) => {
  const { api_key, api_secret, api_passphrase } = req.body;
  
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET api_key = ?, api_secret = ?, api_passphrase = ? WHERE id = ?`,
        [api_key, api_secret, api_passphrase, req.user.id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Update exchange instance
    if (api_key && api_secret) {
      userExchanges.set(req.user.id, new ccxt.bitget({
        apiKey: api_key,
        secret: api_secret,
        password: api_passphrase,
        options: { defaultType: 'swap' },
        timeout: 30000,
        enableRateLimit: true
      }));
      
      // Start scanner for user
      scanner.startUserScan(req.user.id);
    }

    res.json({ success: true, message: 'API bilgileri güncellendi' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trading Routes
app.post('/api/trading/scan', authMiddleware, async (req, res) => {
  try {
    await scanner.refreshMarkets(req.user.id);
    res.json({ success: true, message: 'Market taraması başlatıldı' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/trading/manual', authMiddleware, async (req, res) => {
  try {
    const result = await autoTrade.execute(req.body, req.user.id, true);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/trading/signals', authMiddleware, async (req, res) => {
  try {
    const signals = Array.from(analyzer.signalCache.values())
      .filter(signal => signal.timestamp > Date.now() - 24 * 60 * 60 * 1000)
      .sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({ success: true, signals });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/trading/positions', authMiddleware, async (req, res) => {
  try {
    const exchange = userExchanges.get(req.user.id);
    if (!exchange) {
      return res.json({ success: true, positions: [] });
    }

    const positions = await exchange.fetchPositions();
    const openPositions = positions.filter(p => parseFloat(p.contracts) > 0);
    
    res.json({ success: true, positions: openPositions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Backtesting Routes
app.post('/api/backtest/run', authMiddleware, async (req, res) => {
  const { strategy, startDate, endDate, initialBalance, symbols } = req.body;
  
  try {
    const results = await Backtester.runBacktest({
      userId: req.user.id,
      strategy,
      startDate,
      endDate,
      initialBalance: initialBalance || 1000,
      symbols: symbols || ['BTC/USDT:USDT', 'ETH/USDT:USDT']
    });
    
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Analytics Routes
app.get('/api/analytics/performance', authMiddleware, async (req, res) => {
  try {
    const report = await performanceTracker.getUserReport(req.user.id);
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/trades', authMiddleware, async (req, res) => {
  try {
    const trades = await new Promise((resolve, reject) => {
      db.all(`
        SELECT * FROM trades 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 100
      `, [req.user.id], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    res.json({ success: true, trades });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket connection
wss.on('connection', (ws, req) => {
  ws.userId = null;
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'auth') {
        // Authenticate WebSocket connection
        const user = await new Promise((resolve, reject) => {
          db.get(`
            SELECT id FROM users WHERE session_token = ? AND session_expiry > datetime('now')
          `, [message.token], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
        
        if (user) {
          ws.userId = user.id;
          ws.send(JSON.stringify({ type: 'auth_success' }));
        } else {
          ws.close();
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/backtesting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'backtesting.html'));
});

// 404 handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'API endpoint bulunamadı',
    path: req.originalUrl 
  });
});

// ================== INITIALIZATION ==================
async function initializeSystem() {
  console.log('🚀 Alphason Trader başlatılıyor...');
  
  // Create default admin user
  await createDefaultUser();
  
  // Initialize strategy manager
  await strategyManager.initialize();
  
  console.log('✅ Sistem başlatma tamamlandı');
}

async function createDefaultUser() {
  const email = "admin@alphason.com";
  const password = "123";
  
  try {
    const existingUser = await new Promise((resolve, reject) => {
      db.get("SELECT id FROM users WHERE email = ?", [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!existingUser) {
      const hashedPassword = await bcrypt.hash(password, 10);
      
      await new Promise((resolve, reject) => {
        db.run(`
          INSERT INTO users (email, password, plan, verified, created_at) 
          VALUES (?, ?, ?, 1, datetime('now'))
        `, [email, hashedPassword, 'elite'], function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });
      
      console.log(`✅ Varsayılan kullanıcı: ${email} / ${password}`);
    }
  } catch (error) {
    console.error('Kullanıcı oluşturma hatası:', error);
  }
}

// Database schema
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  plan TEXT DEFAULT 'basic',
  api_key TEXT DEFAULT '',
  api_secret TEXT DEFAULT '',
  api_passphrase TEXT DEFAULT '',
  session_token TEXT,
  session_expiry DATETIME,
  verified BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_configs (
  user_id INTEGER PRIMARY KEY,
  leverage INTEGER DEFAULT 10,
  margin_percent INTEGER DEFAULT 5,
  risk_profile TEXT DEFAULT 'balanced',
  scalp_mode BOOLEAN DEFAULT 0,
  autotrade BOOLEAN DEFAULT 0,
  min_confidence INTEGER DEFAULT 60,
  order_type TEXT DEFAULT 'limit',
  strategies_breakout BOOLEAN DEFAULT 1,
  strategies_trendfollow BOOLEAN DEFAULT 1,
  strategies_pumpdump BOOLEAN DEFAULT 1,
  scan_interval INTEGER DEFAULT 300000,
  signal_cooldown INTEGER DEFAULT 1800000,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  strategy TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  tp_price REAL,
  sl_price REAL,
  amount REAL,
  pnl REAL,
  confidence INTEGER,
  order_id TEXT,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  strategy TEXT NOT NULL,
  entry_price REAL,
  tp_price REAL,
  sl_price REAL,
  confidence INTEGER,
  risk_reward REAL,
  volume_level TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  strategy_name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  initial_balance REAL,
  final_balance REAL,
  total_trades INTEGER,
  winning_trades INTEGER,
  win_rate REAL,
  max_drawdown REAL,
  sharpe_ratio REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
`;

// Start server
db.exec(schema, async (err) => {
  if (err) {
    console.error("Database schema hatası:", err);
  } else {
    console.log("✅ Database tabloları hazır");
    
    server.listen(PORT, async () => { 
      console.log(`🚀 Server ${PORT} portunda çalışıyor`);
      await initializeSystem();
    });
  }
});
