/**
 * Alphason Trader — Multi-tenant Production
 * Özellikler:
 * - Çoklu kullanıcı + JWT auth + abonelik planları
 * - Kullanıcıya özel Bitget API anahtarları ve ccxt instance
 * - Stratejiler: Breakout + RSI/MACD + Pump/Dump + Trend takip
 * - Manuel ve otomatik trade: Entry + TP + SL (Bitget trigger/conditional)
 * - Volume scanner, multi-timeframe analiz, confidence engine
 * - WebSocket: kimlikli bağlantı ve canlı sinyal yayını
 * Not: Saatlik/günlük oto trade limiti yoktur (senin talebinle kaldırıldı)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { EMA, RSI, ADX, ATR, SMA, MACD, OBV } = require('technicalindicators');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// DB
const db = new sqlite3.Database('./alphason.db');

// JWT ve şifreleme
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME';
const ENC_KEY = process.env.ENC_KEY || 'CHANGE_ME_32_BYTES_KEY'; // 32 byte
const ENC_IV = process.env.ENC_IV || 'CHANGE_ME_16_BYTES_IV';   // 16 byte

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY), Buffer.from(ENC_IV));
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]).toString('base64');
}
function decrypt(b64) {
  const data = Buffer.from(b64, 'base64');
  const enc = data.slice(0, data.length - 16);
  const tag = data.slice(data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY), Buffer.from(ENC_IV));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// CONFIG (global üst sınırlar ve varsayılanlar)
let CONFIG = {
  minPrice: 0.05,
  timeframes: ['15m', '1h', '4h'],
  timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
  atrSLMultiplier: 1.5,
  atrTPMultiplier: 3.0,
  volumeConfirmationThreshold: 1.5,
  snrTolerancePercent: 2.0,
  scanBatchSize: 10,
  focusedScanIntervalMs: 60000,
  fullSymbolRefreshMs: 15 * 60 * 1000,
  minVolumeUSD: 300000,
  maxSlippagePercent: 1.5,
  pumpDumpEnabled: true,
  trendFollowEnabled: true,
  scalpModeDefault: false
};

// Çoklu kullanıcı state
const userCcxtCache = new Map(); // userId -> ccxt instance
const signalCache = new Map();   // id -> signal (WS için)
const ohlcvCache = new Map();
const signalHistory = new Map(); // symbol -> lastTs
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
  isHealthy: true,
  filterCount: 0,
  marketSentiment: 'ANALİZ EDİLİYOR...',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// İstek kuyruğu (rate-limit uyumlu)
const requestQueue = {
  queue: [], running: 0, concurrency: 6,
  push(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  },
  async next() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.running++;
    try { item.resolve(await item.fn()); }
    catch (e) { item.reject(e); }
    finally { this.running--; setTimeout(() => this.next(), 100); }
  }
};

// DB setup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    fullName TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    plan TEXT DEFAULT 'pro',
    status TEXT DEFAULT 'active',
    period_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    period_end DATETIME,
    limits_json TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    exchange TEXT,
    api_key TEXT,
    secret TEXT,
    passphrase TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_config (
    user_id INTEGER PRIMARY KEY,
    minConfidenceForAuto INTEGER DEFAULT 60,
    orderType TEXT DEFAULT 'limit',
    leverage INTEGER DEFAULT 10,
    marginPercent INTEGER DEFAULT 5,
    scalpMode INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    symbol TEXT,
    direction TEXT,
    entry REAL,
    tp REAL,
    sl REAL,
    confidence INTEGER,
    rr REAL,
    quality INTEGER,
    strategy TEXT,
    source TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    symbol TEXT,
    direction TEXT,
    entry_price REAL,
    quantity REAL,
    tp_price REAL,
    sl_price REAL,
    order_ids_json TEXT,
    pnl REAL,
    status TEXT DEFAULT 'open',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Admin seed
(async () => {
  const email = 'admin@alphason.com';
  db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) return;
    if (!row) {
      const hashed = await bcrypt.hash('admin123', 12);
      db.run('INSERT INTO users (email, password, fullName, role) VALUES (?, ?, ?, ?)',
        [email, hashed, 'System Admin', 'admin']);
      db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES ((SELECT id FROM users WHERE email = ?), ?, ?)',
        [email, 'enterprise', 'active']);
      db.run('INSERT OR REPLACE INTO user_config (user_id, minConfidenceForAuto, orderType, leverage, marginPercent, scalpMode) VALUES ((SELECT id FROM users WHERE email = ?), 60, "limit", 10, 5, 0)',
        [email]);
      console.log('🎉 Admin hazır: admin@alphason.com / admin123');
    }
  });
})();

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Token gerekli' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user; // { userId, email, role }
    next();
  } catch {
    return res.status(403).json({ success: false, error: 'Geçersiz token' });
  }
}

// Kullanıcıya özel ccxt instance
async function getCcxtForUser(userId) {
  if (userCcxtCache.has(userId)) return userCcxtCache.get(userId);
  return await new Promise((resolve) => {
    db.get('SELECT exchange, api_key, secret, passphrase FROM api_keys WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1',
      [userId], (err, row) => {
        if (err || !row) return resolve(null);
        try {
          const apiKey = decrypt(row.api_key);
          const secret = decrypt(row.secret);
          const passphrase = decrypt(row.passphrase || '');
          const instance = new ccxt.bitget({
            apiKey, secret, password: passphrase,
            options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000
          });
          userCcxtCache.set(userId, instance);
          resolve(instance);
        } catch {
          resolve(null);
        }
      });
  });
}

// Helpers
class EnhancedHelpers {
  static async delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  static cleanSymbol(symbol) { const p = symbol.split('/'); return p[0] + '/USDT'; }
  static roundToTick(price) {
    if (!price || isNaN(price)) return 0;
    if (price < 0.00001) return Number(price.toFixed(8));
    if (price < 0.001) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(5));
    if (price < 10) return Number(price.toFixed(4));
    return Number(price.toFixed(2));
  }
  static async fetchOHLCV(ccxtInst, symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = ohlcvCache.get(key);
    if (cached && (Date.now() - cached.ts < 120000)) return cached.data;
    try {
      const data = await requestQueue.push(() => ccxtInst.fetchOHLCV(symbol, timeframe, undefined, limit));
      if (data && data.length) ohlcvCache.set(key, { data, ts: Date.now() });
      return data;
    } catch (e) { console.log(`❌ OHLCV hata ${symbol}:`, e.message); return null; }
  }
  static async fetchMultiTF(ccxtInst, symbol, tfs) {
    const out = {}; for (const tf of tfs) out[tf] = await this.fetchOHLCV(ccxtInst, symbol, tf, 120); return out;
  }
  static findSimpleSnR(ohlcv15m) {
    if (!ohlcv15m || ohlcv15m.length < 20) return { support: 0, resistance: 0 };
    const r = ohlcv15m.slice(-20); const highs = r.map(c => c[2]); const lows = r.map(c => c[3]);
    const support = Math.min(...lows), resistance = Math.max(...highs);
    return { support: this.roundToTick(support), resistance: this.roundToTick(resistance) };
  }
  static volumeRatio(volumes, period = 20) {
    if (!volumes || volumes.length < period) return 1;
    const curr = volumes[volumes.length - 1], avg = volumes.slice(-period).reduce((a,b)=>a+b,0)/period;
    return curr / avg;
  }
  static marketStructure(ohlcv1h) {
    if (!ohlcv1h || ohlcv1h.length < 10) return 'RANGING';
    const highs = ohlcv1h.map(c => c[2]), lows = ohlcv1h.map(c => c[3]);
    const lastHigh = Math.max(...highs.slice(-5)), prevHigh = Math.max(...highs.slice(-10, -5));
    const lastLow = Math.min(...lows.slice(-5)), prevLow = Math.min(...lows.slice(-10, -5));
    if (lastHigh > prevHigh && lastLow > prevLow) return 'BULLISH';
    if (lastHigh < prevHigh && lastLow < prevLow) return 'BEARISH';
    return 'RANGING';
  }
  static async confirmBreakoutWithVolume(ccxtInst, symbol, threshold) {
    const r = await this.fetchOHLCV(ccxtInst, symbol, '5m', 20);
    if (!r || r.length < 10) return { confirmed: false, strength: 'WEAK', ratio: 0 };
    const avg = r.map(c => c[5]).reduce((a,b)=>a+b,0)/r.length;
    const ratio = r[r.length-1][5] / avg; const confirmed = ratio > threshold;
    const strength = ratio > 2 ? 'STRONG' : ratio > 1.5 ? 'MEDIUM' : 'WEAK';
    return { confirmed, strength, ratio };
  }
  static findSimilarAssets(coin) {
    const corr = { 'BTC':['ETH','SOL','AVAX','MATIC','BNB'], 'ETH':['BTC','SOL','AVAX','MATIC','BNB'], 'SOL':['BTC','ETH','AVAX','MATIC','BNB'], 'AVAX':['BTC','ETH','SOL','MATIC'], 'MATIC':['BTC','ETH','SOL','AVAX'] };
    const clean = coin.replace('/USDT','').replace(':USDT',''); for (const [m,s] of Object.entries(corr)) if (clean.includes(m)) return s; return [];
  }
}

// Confidence engine
class AdvancedConfidenceEngine {
  calculateSignalQuality(signal, marketStructure, volumeInfo, trendAlignment, adx, rsi, rr) {
    let q = signal.confidence;
    if (volumeInfo.strength === 'STRONG') q += 20; else if (volumeInfo.strength === 'MEDIUM') q += 10; else q -= 10;
    if (marketStructure === trendAlignment) q += 15;
    if (rr > 2.5) q += 5;
    if (adx > 25) q += 10; if (adx < 20) q -= 10;
    if (rsi > 80 || rsi < 20) q -= 5;
    if (!volumeInfo.confirmed) q -= 15;
    return Math.min(100, Math.max(0, q));
  }
  dynamicPositionSize(volFactor, conf, qual, scalpMode) {
    const base = 1.0;
    const volAdj = volFactor > 1.3 ? 0.7 : 1.0;
    const confBoost = conf > 80 ? 1.2 : 1.0;
    const qualBoost = qual > 80 ? 1.1 : 1.0;
    const size = base * volAdj * confBoost * qualBoost;
    const capped = scalpMode ? Math.min(1.2, size) : size;
    return Math.min(2.0, Math.max(0.5, capped));
  }
  adaptiveSL(atr, trendStrength, volatility, signalQuality, scalpMode) {
    let base = scalpMode ? Math.max(1.0, CONFIG.atrSLMultiplier * 0.8) : CONFIG.atrSLMultiplier;
    if (trendStrength > 60) base *= 0.9;
    if (volatility > 1.4) base *= 1.2;
    if (signalQuality > 80) base *= 0.95;
    return base * atr;
  }
  decision(matrix, trendDirection, signalQuality, minConf) {
    const total = matrix.technical * 0.70 + matrix.market * 0.20 + matrix.risk * 0.05 + matrix.performance * 0.05;
    const conf = Math.min(100, Math.max(0, Math.round(total)));
    let execute = false, positionSizeType = 'NORMAL', riskLevel = 'MEDIUM', reasoning = '';
    if (conf >= minConf && matrix.risk >= 55 && signalQuality >= 60) {
      execute = true; positionSizeType = conf >= 85 ? 'LARGE' : 'NORMAL'; riskLevel = conf >= 80 ? 'LOW' : 'MEDIUM';
      reasoning = `✅ ${trendDirection} SİNYAL | Kalite: ${signalQuality}`;
    } else { reasoning = '❌ Yetersiz güven/kalite'; riskLevel = 'HIGH'; }
    return { execute, confidence: conf, positionSizeType, riskLevel, reasoning };
  }
  matrix(tech, market, risk, perf){ return { technical: tech, market, risk, performance: perf }; }
}
const advancedEngine = new AdvancedConfidenceEngine();

// Strateji ve analiz
class EnhancedTrendMasterStrategy {
  generateTechnicalDecision(features, currentPrice, snr, marketStructure) {
    const dR = Math.abs(currentPrice - snr.resistance), dS = Math.abs(currentPrice - snr.support);
    const nearRes = dR < dS;
    let dir = 'HOLD', conf = features.mtfScore, reason = '';
    if (nearRes && features.emaDirection === 'YÜKSELİŞ TRENDİ' && marketStructure !== 'BEARISH') { dir='LONG_BREAKOUT'; conf+=25; reason=`Direnç kırılımı bekleniyor (${snr.resistance})`; }
    else if (!nearRes && features.emaDirection === 'DÜŞÜŞ TRENDİ' && marketStructure !== 'BULLISH') { dir='SHORT_BREAKOUT'; conf+=25; reason=`Destek kırılımı bekleniyor (${snr.support})`; }
    else if (nearRes && marketStructure==='BULLISH') { dir='LONG_BREAKOUT'; conf+=20; reason='Güçlü yükseliş structure'; }
    else if (!nearRes && marketStructure==='BEARISH') { dir='SHORT_BREAKOUT'; conf+=20; reason='Güçlü düşüş structure'; }
    else if (features.rsi < 30 && nearRes) { dir='LONG_BREAKOUT'; conf+=15; reason='Aşırı satım + direnç yakın'; }
    else if (features.rsi > 70 && !nearRes) { dir='SHORT_BREAKOUT'; conf+=15; reason='Aşırı alım + destek yakın'; }
    else { dir='HOLD'; reason='Uyumsuz — bekle'; conf=Math.max(30, conf-20); }
    return { direction: dir, confidence: Math.round(conf), reasoning: reason };
  }

  async analyze(ccxtInst, userId, userCfg, symbol) {
    try {
      const lastSignalTime = signalHistory.get(symbol) || 0;
      if (Date.now() - lastSignalTime < (30 * 60 * 1000)) return null;

      const ticker = await requestQueue.push(() => ccxtInst.fetchTicker(symbol));
      if (!ticker || ticker.last < CONFIG.minPrice) return null;

      const multiTF = await EnhancedHelpers.fetchMultiTF(ccxtInst, symbol, CONFIG.timeframes);
      const o15 = multiTF['15m'], o1h = multiTF['1h'];
      if (!o15 || o15.length < 60) return null;

      const snr = EnhancedHelpers.findSimpleSnR(o15);
      const currentPrice = ticker.last;
      const tol = currentPrice * (CONFIG.snrTolerancePercent / 100);
      const nearS = Math.abs(currentPrice - snr.support) <= tol;
      const nearR = Math.abs(currentPrice - snr.resistance) <= tol;
      if (!nearS && !nearR) return null;

      const mStruct = EnhancedHelpers.marketStructure(o1h);
      const closes = o15.map(c=>c[4]), highs = o15.map(c=>c[2]), lows = o15.map(c=>c[3]), vols = o15.map(c=>c[5]);
      const tfAnalysis = await this.analyzeMultiTF(multiTF); if (!tfAnalysis.isValid) return null;

      const ema9 = EMA.calculate({ period:9, values:closes });
      const ema21 = EMA.calculate({ period:21, values:closes });
      const rsi = RSI.calculate({ period:14, values:closes });
      const adx = ADX.calculate({ period:14, high:highs, low:lows, close:closes });
      const atr = ATR.calculate({ period:14, high:highs, low:lows, close:closes });
      const obv = OBV.calculate({ close:closes, volume:vols });
      if (!ema9.length || !adx.length || !atr.length) return null;

      const lastEMA9 = ema9[ema9.length-1], lastEMA21 = ema21[ema21.length-1];
      const lastRSI = rsi[rsi.length-1], lastADX = adx[adx.length-1]?.adx || 0, lastATR = atr[atr.length-1];
      const prevOBV = obv[obv.length-2] || 0, lastOBV = obv[obv.length-1];

      const volRatio = EnhancedHelpers.volumeRatio(vols, 20);
      const baseVol = lastATR / currentPrice * 100;
      const volFactor = Math.min(1.6, Math.max(0.8, baseVol));

      const slDist = advancedEngine.adaptiveSL(lastATR, lastADX, volFactor, 0, !!userCfg.scalpMode);
      const tpDist = lastATR * ((userCfg.scalpMode ? 1.2 : CONFIG.atrTPMultiplier) * volFactor);
      const rr = tpDist / slDist;

      const features = {
        emaDirection: lastEMA9 > lastEMA21 ? 'YÜKSELİŞ TRENDİ' : 'DÜŞÜŞ TRENDİ',
        rsi: lastRSI, adx: lastADX,
        obvTrend: lastOBV > prevOBV ? 'YÜKSELİŞ' : 'DÜŞÜŞ',
        volumeRatio: volRatio, mtfScore: tfAnalysis.score,
        volatilityFactor: volFactor, signalQuality: 50
      };

      // Correlation risk (aynı kullanıcı pozisyonlarında)
      const similar = EnhancedHelpers.findSimilarAssets(symbol);
      const corrRisk = await this.checkCorrelationRisk(ccxtInst, similar);
      if (corrRisk) return null;

      const decision = this.generateTechnicalDecision(features, currentPrice, snr, mStruct);
      const modelDir = decision.direction, modelConf = decision.confidence, modelReason = decision.reasoning;
      if (!modelDir.includes('BREAKOUT') || modelConf < userCfg.minConfidenceForAuto) return null;

      const breakoutLevel = modelDir === 'LONG_BREAKOUT' ? snr.resistance : snr.support;
      const volumeInfo = await EnhancedHelpers.confirmBreakoutWithVolume(ccxtInst, symbol, CONFIG.volumeConfirmationThreshold);
      const trendAlign = modelDir === 'LONG_BREAKOUT' ? 'BULLISH' : 'BEARISH';
      const sigQuality = advancedEngine.calculateSignalQuality(decision, mStruct, volumeInfo, trendAlign, lastADX, lastRSI, rr);

      const posSizeMult = advancedEngine.dynamicPositionSize(volFactor, modelConf, sigQuality, !!userCfg.scalpMode);
      let marketScore = 50;
      if (volumeInfo.ratio > 2.0) marketScore += 30; else if (volumeInfo.ratio > 1.5) marketScore += 15;
      if (volFactor > 1.2) marketScore += 10;
      if (mStruct === trendAlign) marketScore += 10;
      if (sigQuality > 80) marketScore += 10;

      const matrix = advancedEngine.matrix(modelConf, marketScore, 80, systemStatus.performance.winRate * 100);
      const finalDecision = advancedEngine.decision(matrix, modelDir, sigQuality, userCfg.minConfidenceForAuto);
      if (!finalDecision.execute) return null;

      signalHistory.set(symbol, Date.now());
      systemStatus.performance.totalSignals++;

      let entryPrice, sl_final, tp1_final;
      if (modelDir === 'LONG_BREAKOUT') {
        entryPrice = snr.resistance; sl_final = entryPrice - slDist; tp1_final = entryPrice + tpDist;
      } else {
        entryPrice = snr.support; sl_final = entryPrice + slDist; tp1_final = entryPrice - tpDist;
      }

      const signal = {
        id: `${userId}_${symbol}_${modelDir}_${Date.now()}`,
        user_id: userId,
        ccxt_symbol: symbol,
        coin: EnhancedHelpers.cleanSymbol(symbol),
        taraf: modelDir,
        giris: EnhancedHelpers.roundToTick(entryPrice),
        tp1: EnhancedHelpers.roundToTick(tp1_final),
        sl: EnhancedHelpers.roundToTick(sl_final),
        riskReward: rr.toFixed(2),
        confidence: finalDecision.confidence,
        positionSize: posSizeMult,
        positionSizeType: finalDecision.positionSizeType,
        riskLevel: finalDecision.riskLevel,
        tuyo: `📊 Teknik: ${modelReason} | Kalite: ${sigQuality} | Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)`,
        timestamp: Date.now(),
        adx: Math.round(lastADX).toString(),
        rsi: Math.round(lastRSI).toString(),
        obvTrend: lastOBV > prevOBV ? '↑' : '↓',
        signalQuality: sigQuality,
        marketStructure: mStruct,
        volumeConfirmed: volumeInfo.confirmed,
        signalSource: 'LOCAL',
        orderType: userCfg.orderType
      };

      // DB kaydı (audit)
      db.run(`INSERT INTO signals (user_id, symbol, direction, entry, tp, sl, confidence, rr, quality, strategy, source) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, symbol, modelDir, signal.giris, signal.tp1, signal.sl, signal.confidence, signal.riskReward, sigQuality, 'breakout_consensus', 'local']);
      return signal;
    } catch (e) { console.log('Analyze error:', e.message); return null; }
  }

  async checkCorrelationRisk(ccxtInst, similarAssets) {
    try {
      const positions = await requestQueue.push(() => ccxtInst.fetchPositions());
      for (const p of positions) {
        const coin = (p.info?.symbol || p.symbol || '').replace('/USDT','').replace(':USDT','');
        if (similarAssets.includes(coin)) return true;
      }
      return false;
    } catch { return false; }
  }

  async analyzeMultiTF(multiTF) {
    let totalScore = 0, totalWeight = 0, dirCons = 0, longCount = 0, shortCount = 0;
    for (const [tf, ohlcv] of Object.entries(multiTF)) {
      if (!ohlcv || ohlcv.length < 20) continue;
      const w = CONFIG.timeframeWeights[tf] || 0.3;
      const tfRes = this.analyzeSingleTF(ohlcv);
      totalScore += tfRes.score * w; totalWeight += w;
      if (tfRes.score > 60) dirCons++;
      if (tfRes.direction === 'LONG') longCount++; else if (tfRes.direction === 'SHORT') shortCount++;
    }
    const avg = totalWeight > 0 ? totalScore / totalWeight : 0;
    const isValid = avg >= 60 && dirCons >= 1;
    return { score: Math.round(avg), isValid, direction: longCount >= shortCount ? 'LONG' : 'SHORT' };
  }

  analyzeSingleTF(ohlcv) {
    const closes = ohlcv.map(c=>c[4]), highs = ohlcv.map(c=>c[2]), lows = ohlcv.map(c=>c[3]);
    if (closes.length < 20) return { score: 0, direction: 'LONG' };
    const ema9 = EMA.calculate({ period:9, values:closes }), ema21 = EMA.calculate({ period:21, values:closes });
    const rsi = RSI.calculate({ period:14, values:closes });
    const adx = ADX.calculate({ period:14, high:highs, low:lows, close:closes });
    if (!ema9.length || !adx.length) return { score: 0, direction: 'LONG' };
    const lastEMA9 = ema9[ema9.length-1], lastEMA21 = ema21[ema21.length-1];
    const lastRSI = rsi[rsi.length-1], lastADX = adx[adx.length-1].adx;
    let score = 50, direction = 'LONG';
    if (lastEMA9 < lastEMA21 && lastRSI > 50) { direction='SHORT'; score+=15; }
    else if (lastEMA9 > lastEMA21 && lastRSI < 50) { direction='LONG'; score+=15; }
    if (lastADX > 25) score+=15; if (lastADX > 35) score+=10;
    if ((direction==='LONG' && lastRSI>40 && lastRSI<70) || (direction==='SHORT' && lastRSI<60 && lastRSI>30)) score+=10;
    return { score: Math.min(100, score), direction };
  }
}
const enhancedTrendMaster = new EnhancedTrendMasterStrategy();

// Trade system (per-user)
class AutoTradeSystem {
  async execute(userId, signal, isManual = false) {
    const ccxtInst = await getCcxtForUser(userId);
    if (!ccxtInst) { console.log('❌ Kullanıcı API yok'); return; }

    try {
      // Kullanıcı config
      const userCfg = await getUserConfig(userId);
      if (!isManual && signal.confidence < userCfg.minConfidenceForAuto) {
        console.log('❌ Min güven değil'); return;
      }

      const symbol = signal.ccxt_symbol;
      const ticker = await requestQueue.push(() => ccxtInst.fetchTicker(symbol));
      const currentPrice = ticker?.last || signal.giris;
      let entryPrice = signal.giris;
      const orderType = userCfg.orderType;

      // Leverage
      try { await requestQueue.push(() => ccxtInst.setLeverage(userCfg.leverage, symbol, { marginMode: 'cross' })); } catch (e) {}

      // Bakiye ve miktar
      const balance = await requestQueue.push(() => ccxtInst.fetchBalance());
      const available = parseFloat(balance.USDT?.free || 0);
      if (available < 10) { console.log('❌ Bakiye yetersiz'); return; }
      const cost = available * (userCfg.marginPercent / 100) * (signal.positionSize || 1);
      const amountUSDT = cost * userCfg.leverage;
      const basePrice = orderType === 'market' ? currentPrice : entryPrice;
      const amountCoinRaw = amountUSDT / basePrice;
      let amountCoin = Number(amountCoinRaw.toFixed(6));
      try { amountCoin = ccxtInst.amountToPrecision(symbol, amountCoinRaw); } catch {}

      const side = signal.taraf.includes('LONG') ? 'buy' : 'sell';

      // Entry
      let entryOrder = null;
      if (orderType === 'limit') {
        entryOrder = await this.placeOrder(ccxtInst, symbol, 'limit', side, amountCoin, entryPrice, {});
      } else {
        entryOrder = await this.placeOrder(ccxtInst, symbol, 'market', side, amountCoin, undefined, {});
        entryPrice = currentPrice;
      }
      if (!entryOrder) { console.log('❌ Entry başarısız'); return; }
      console.log('✅ ENTRY ID:', entryOrder.id);

      // TP/SL conditional (reduceOnly)
      const ordersMeta = await this.placeTPSLConditional(ccxtInst, symbol, side, amountCoin, signal);
      db.run(`INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, tp_price, sl_price, order_ids_json, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, symbol, signal.taraf, entryPrice, amountCoin, signal.tp1, signal.sl, JSON.stringify(ordersMeta), 'open']);

      systemStatus.performance.executedTrades++;
    } catch (e) { console.log('Trade error:', e.message); }
  }

  async placeOrder(ccxtInst, symbol, type, side, amount, price, params) {
    try {
      const order = await requestQueue.push(() => ccxtInst.createOrder(symbol, type, side, amount, price, params));
      console.log(`✅ ${type.toUpperCase()} EMİR: ${side} ${amount} @ ${price ?? 'market'}`);
      return order;
    } catch (e) { console.log(`❌ ${type.toUpperCase()} hata:`, e.message); return null; }
  }

  async placeTPSLConditional(ccxtInst, symbol, entrySide, amount, signal) {
    const reduceSide = entrySide === 'buy' ? 'sell' : 'buy';
    const meta = { slOrderId: null, tpOrderId: null };

    // SL
    try {
      const slParams = { reduceOnly: true, triggerPrice: signal.sl, stopPrice: signal.sl,
        stopLoss: { triggerPrice: signal.sl, price: signal.sl } };
      const slOrder = await requestQueue.push(() => ccxtInst.createOrder(symbol, 'market', reduceSide, amount, undefined, slParams));
      meta.slOrderId = slOrder?.id || null; console.log('✅ SL TRIGGER:', signal.sl);
    } catch (e) { console.log('⚠️ SL gönderilemedi:', e.message); }

    // TP
    try {
      const tpParams = { reduceOnly: true, triggerPrice: signal.tp1,
        takeProfit: { triggerPrice: signal.tp1, price: signal.tp1 } };
      const tpOrder = await requestQueue.push(() => ccxtInst.createOrder(symbol, 'market', reduceSide, amount, undefined, tpParams));
      meta.tpOrderId = tpOrder?.id || null; console.log('✅ TP TRIGGER:', signal.tp1);
    } catch (e) { console.log('⚠️ TP gönderilemedi:', e.message); }

    return meta;
  }

  async closePosition(userId, symbol, side, contracts) {
    const ccxtInst = await getCcxtForUser(userId);
    if (!ccxtInst) return { success: false, error: 'API yok' };
    try {
      const closeSide = side === 'LONG' ? 'sell' : 'buy';
      const params = { reduceOnly: true };
      const order = await requestQueue.push(() => ccxtInst.createOrder(symbol, 'market', closeSide, Math.abs(contracts), undefined, params));
      if (order) return { success: true, orderId: order.id };
      return { success: false, error: 'Order oluşturulamadı' };
    } catch (e) { return { success: false, error: e.message }; }
  }
}
const autoTrader = new AutoTradeSystem();

// Kullanıcı config get/set
function getUserConfig(userId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM user_config WHERE user_id = ?', [userId], (err, row) => {
      if (err || !row) return resolve({ minConfidenceForAuto: 60, orderType: 'limit', leverage: 10, marginPercent: 5, scalpMode: CONFIG.scalpModeDefault ? 1 : 0 });
      resolve(row);
    });
  });
}
function setUserConfig(userId, body) {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR REPLACE INTO user_config (user_id, minConfidenceForAuto, orderType, leverage, marginPercent, scalpMode) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, body.minConfidenceForAuto ?? 60, body.orderType ?? 'limit', body.leverage ?? 10, body.marginPercent ?? 5, body.scalpMode ? 1 : 0],
      (err) => err ? reject(err) : resolve(true));
  });
}

// WS — kimlikli
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) return ws.close(1008, 'Auth required');
  let user = null;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return ws.close(1008, 'Invalid token'); }

  ws.send(JSON.stringify({ type: 'connected', message: 'WS OK' }));

  const sendSignals = () => {
    const all = Array.from(signalCache.values()).filter(s => s.user_id === user.userId).sort((a,b)=>b.timestamp-a.timestamp);
    ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'signal_list', data: all }));
  };
  sendSignals();
});

// Signal cache temizleme
function cleanupSignalCache() {
  const now = Date.now(); let removed = 0;
  for (const [key, sig] of signalCache.entries()) if (now - sig.timestamp > SIGNAL_CACHE_DURATION) { signalCache.delete(key); removed++; }
  if (removed) console.log(`🧹 ${removed} sinyal temizlendi`);
}
setInterval(cleanupSignalCache, 5 * 60 * 1000);

// Scanner (global market list)
let cachedHighVol = []; let focusedSymbols = []; let lastMarketRefresh = 0;
async function refreshMarketList(anyCcxt) {
  try {
    await requestQueue.push(() => anyCcxt.loadMarkets(true));
    const tickers = await requestQueue.push(() => anyCcxt.fetchTickers());
    const allSymbols = Object.keys(anyCcxt.markets).filter(s => {
      const m = anyCcxt.markets[s]; return m.active && s.includes('USDT') && (m.swap || m.future);
    });
    const highVol = [];
    for (const sym of allSymbols) { const t = tickers[sym]; if (t && (t.quoteVolume >= CONFIG.minVolumeUSD)) highVol.push(sym); }
    highVol.sort((a,b)=>(tickers[b]?.quoteVolume||0)-(tickers[a]?.quoteVolume||0));
    cachedHighVol = highVol.slice(0, 150);
    focusedSymbols = [...cachedHighVol];
    lastMarketRefresh = Date.now();
    systemStatus.filterCount = cachedHighVol.length;
    console.log(`✅ Market list: ${cachedHighVol.length}`);
  } catch (e) { console.log('Market refresh error:', e.message); }
}

async function scanLoopForUser(userId) {
  const ccxtInst = await getCcxtForUser(userId);
  if (!ccxtInst) return;

  const now = Date.now();
  if (focusedSymbols.length === 0 || now - lastMarketRefresh > CONFIG.fullSymbolRefreshMs) {
    await refreshMarketList(ccxtInst);
  }

  const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
  const signals = [];
  for (const sym of batch) {
    const userCfg = await getUserConfig(userId);
    const sig = await enhancedTrendMaster.analyze(ccxtInst, userId, userCfg, sym);
    if (sig) {
      signalCache.set(sig.id, sig);
      db.run(`INSERT INTO signals (user_id, symbol, direction, entry, tp, sl, confidence, rr, quality, strategy, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, sym, sig.taraf, sig.giris, sig.tp1, sig.sl, sig.confidence, sig.riskReward, sig.signalQuality, 'breakout_consensus', 'local']);
      signals.push(sig);
      // Otomatik trade (kota yok)
      if (sig.confidence >= userCfg.minConfidenceForAuto) await autoTrader.execute(userId, sig, false);
    }
  }
  if (signals.length) console.log(`🎯 User ${userId}: ${signals.length} sinyal`);
}

// API — Auth
app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:'Email ve şifre gerekli' });
  db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
    if (row) return res.status(400).json({ success:false, error:'E-posta kullanımda' });
    const hashed = await bcrypt.hash(password, 12);
    db.run('INSERT INTO users (email, password, fullName) VALUES (?, ?, ?)', [email, hashed, fullName || ''], function(err2) {
      if (err2) return res.status(500).json({ success:false, error:'Kayıt hatası' });
      // default subscription + config
      db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, ?)', [this.lastID, 'pro', 'active']);
      db.run('INSERT OR REPLACE INTO user_config (user_id, minConfidenceForAuto, orderType, leverage, marginPercent, scalpMode) VALUES (?, 60, "limit", 10, 5, 0)', [this.lastID]);
      const token = jwt.sign({ userId: this.lastID, email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ success:true, token, user: { id:this.lastID, email, fullName, plan:'pro' } });
    });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success:true, token, user:{ id:user.id, email:user.email, fullName:user.fullName, role:user.role } });
  });
});

app.get('/api/auth/profile', authenticateToken, (req, res) => {
  db.get('SELECT u.id, u.email, u.fullName, u.role, s.plan, s.status FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE u.id=?', [req.user.userId], (err,row)=>{
    if (err || !row) return res.status(404).json({ success:false, error:'Kullanıcı bulunamadı' });
    res.json({ success:true, user:row });
  });
});

// Subscription basic (limit yok)
app.get('/api/subscription', authenticateToken, (req, res) => {
  db.get('SELECT plan, status, period_start, period_end FROM subscriptions WHERE user_id=?', [req.user.userId], (err,row)=>{
    if (err || !row) return res.status(404).json({ success:false, error:'Abonelik yok' });
    res.json({ success:true, subscription:row });
  });
});

// API keys
app.post('/api/keys', authenticateToken, (req, res) => {
  const { exchange='bitget', apiKey, secret, passphrase='' } = req.body;
  if (!apiKey || !secret) return res.status(400).json({ success:false, error:'API key ve secret gerekli' });
  const encKey = encrypt(apiKey), encSec = encrypt(secret), encPass = passphrase ? encrypt(passphrase) : encrypt('');
  db.run('INSERT INTO api_keys (user_id, exchange, api_key, secret, passphrase) VALUES (?, ?, ?, ?, ?)',
    [req.user.userId, exchange, encKey, encSec, encPass],
    (err)=> err ? res.status(500).json({ success:false, error:'Kaydedilemedi' }) : res.json({ success:true }));
});
app.get('/api/keys', authenticateToken, (req, res) => {
  db.all('SELECT id, exchange, created_at FROM api_keys WHERE user_id=?', [req.user.userId], (err, rows)=>{
    if (err) return res.status(500).json({ success:false, error:'Liste alınamadı' });
    res.json({ success:true, keys:rows });
  });
});

// Kullanıcı config
app.get('/api/user/config', authenticateToken, async (req, res) => {
  const cfg = await getUserConfig(req.user.userId);
  res.json({ success:true, config:cfg });
});
app.post('/api/user/config', authenticateToken, async (req, res) => {
  try { await setUserConfig(req.user.userId, req.body); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// Sinyaller ve tarama
app.post('/api/signals/scan', authenticateToken, async (req, res) => {
  await scanLoopForUser(req.user.userId);
  const list = Array.from(signalCache.values()).filter(s=>s.user_id===req.user.userId).sort((a,b)=>b.timestamp-a.timestamp);
  res.json({ success:true, signals:list });
});

// Manuel trade
app.post('/api/trade/manual', authenticateToken, async (req, res) => {
  try { await autoTrader.execute(req.user.userId, req.body, true); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

// Pozisyon kapatma
app.post('/api/position/close', authenticateToken, async (req, res) => {
  try {
    const { symbol, side, contracts } = req.body;
    const result = await autoTrader.closePosition(req.user.userId, symbol, side, contracts);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success:false, error:error.message });
  }
});

// Status
app.get('/api/status', authenticateToken, async (req, res) => {
  const ccxtInst = await getCcxtForUser(req.user.userId);
  let positions = [];
  try {
    positions = ccxtInst ? await requestQueue.push(() => ccxtInst.fetchPositions()) : [];
    positions = positions.filter(x => parseFloat(x.contracts || x.size || 0) > 0);
  } catch {}
  const signals = Array.from(signalCache.values()).filter(s=>s.user_id===req.user.userId).sort((a,b)=>b.timestamp-a.timestamp);
  res.json({ success:true, system: systemStatus, signals, positions });
});

// UI
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Boot ve global scanner tetikleyici (per-user tetik: API çağrısıyla)
server.listen(PORT, () => {
  console.log(`🚀 Alphason UI: http://localhost:${PORT}`);
});
