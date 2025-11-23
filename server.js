/**
 * Alphason Trader — Multi-tenant + Email Verification + Package Selection + Admin Panel
 * - Kayıt ve e-posta doğrulama (6 haneli kod)
 * - Doğrulama sonrası paket seçimi zorunlu (Basic/Pro/Elite)
 * - Admin seed: admin@alphason.com / admin123 (doğrulama atlar)
 * - Çoklu kullanıcı, kullanıcıya özel Bitget ccxt instance
 * - Manuel/oto trade: Entry + TP + SL (Bitget trigger/conditional)
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
const nodemailer = require('nodemailer');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database('./alphason.db');

const JWT_SECRET = process.env.JWT_SECRET;
const ENC_KEY = process.env.ENC_KEY;
const ENC_IV = process.env.ENC_IV;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
const SMTP_FROM = process.env.SMTP_FROM;

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

// Global config
const CONFIG = {
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
};

const userCcxtCache = new Map();
const signalCache = new Map();
const ohlcvCache = new Map();
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
  isHealthy: true,
  filterCount: 0,
  marketSentiment: 'ANALİZ EDİLİYOR...',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

const requestQueue = {
  queue: [], running: 0, concurrency: 6,
  push(fn) {
    return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.next(); });
  },
  async next() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    const item = this.queue.shift(); this.running++;
    try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
    finally { this.running--; setTimeout(() => this.next(), 100); }
  }
};

// DB schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE, password TEXT, fullName TEXT,
    role TEXT DEFAULT 'user',
    verified INTEGER DEFAULT 0,
    verify_code TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, plan TEXT, status TEXT,
    period_start DATETIME DEFAULT CURRENT_TIMESTAMP, period_end DATETIME
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, exchange TEXT, api_key TEXT, secret TEXT, passphrase TEXT,
    is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_config (
    user_id INTEGER PRIMARY KEY,
    minConfidenceForAuto INTEGER DEFAULT 60,
    orderType TEXT DEFAULT 'limit',
    leverage INTEGER DEFAULT 10,
    marginPercent INTEGER DEFAULT 5,
    scalpMode INTEGER DEFAULT 0,
    allowedStrategies TEXT DEFAULT 'breakout' -- CSV: breakout,pumpdump,trendfollow,manual
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, symbol TEXT, direction TEXT,
    entry REAL, tp REAL, sl REAL,
    confidence INTEGER, rr REAL, quality INTEGER,
    strategy TEXT, source TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, symbol TEXT, direction TEXT,
    entry_price REAL, quantity REAL,
    tp_price REAL, sl_price REAL,
    order_ids_json TEXT, pnl REAL,
    status TEXT DEFAULT 'open',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Admin seed (bypass verification)
(async () => {
  const email = 'admin@alphason.com';
  db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
    if (err) return;
    if (!row) {
      const hash = await bcrypt.hash('admin123', 12);
      const code = ''; // admin doğrulama kodu yok
      db.run('INSERT INTO users (email, password, fullName, role, verified, verify_code) VALUES (?, ?, ?, ?, ?, ?)',
        [email, hash, 'System Admin', 'admin', 1, code]);
      db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES ((SELECT id FROM users WHERE email=?), ?, ?)',
        [email, 'elite', 'active']);
      db.run('INSERT OR REPLACE INTO user_config (user_id, allowedStrategies) VALUES ((SELECT id FROM users WHERE email=?), ?)',
        [email, 'breakout,pumpdump,trendfollow,manual']);
      console.log('👑 Admin hazır: admin@alphason.com / admin123');
    }
  });
})();

// Auth helpers
function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success:false, error:'Token gerekli' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(403).json({ success:false, error:'Geçersiz token' }); }
}
function requireVerified(req, res, next) {
  db.get('SELECT verified FROM users WHERE id=?', [req.user.userId], (err, row) => {
    if (err || !row) return res.status(404).json({ success:false, error:'Kullanıcı yok' });
    if (row.verified !== 1) return res.status(403).json({ success:false, error:'Doğrulama gerekli' });
    next();
  });
}
function requireActivePlan(req, res, next) {
  db.get('SELECT plan, status FROM subscriptions WHERE user_id=?', [req.user.userId], (err, row) => {
    if (err || !row || row.status !== 'active') return res.status(403).json({ success:false, error:'Aktif paket gerekli' });
    req.subscription = row; next();
  });
}

// SMTP send
async function sendVerifyEmail(email, code) {
  const mail = {
    from: SMTP_FROM,
    to: email,
    subject: 'Alphason doğrulama kodu',
    text: `Doğrulama kodunuz: ${code}`,
    html: `<p>Doğrulama kodunuz: <b>${code}</b></p>`
  };
  await transporter.sendMail(mail);
}

// Register: create user + send code
app.post('/api/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:'Email/şifre gerekli' });
  db.get('SELECT id FROM users WHERE email=?', [email], async (err, row) => {
    if (row) return res.status(400).json({ success:false, error:'E-posta kullanımda' });
    const hash = await bcrypt.hash(password, 12);
    const code = Math.floor(100000 + Math.random()*900000).toString();
    db.run('INSERT INTO users (email, password, fullName, role, verified, verify_code) VALUES (?, ?, ?, ?, ?, ?)',
      [email, hash, fullName || '', 'user', 0, code],
      async function(err2) {
        if (err2) return res.status(500).json({ success:false, error:'Kayıt hatası' });
        try { await sendVerifyEmail(email, code); } catch(e){ console.log('Mail hata:', e.message); }
        // Geçici token (sadece verify endpoint için)
        const token = jwt.sign({ userId: this.lastID, email, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ success:true, token, message:'Doğrulama kodu gönderildi' });
      });
  });
});

// Verify: check code -> verified=1, redirect to package selection
app.post('/api/auth/verify', authenticateToken, (req, res) => {
  const { code } = req.body;
  db.get('SELECT verify_code FROM users WHERE id=?', [req.user.userId], (err, row) => {
    if (err || !row) return res.status(404).json({ success:false, error:'Kullanıcı yok' });
    if (row.verify_code !== code) return res.status(400).json({ success:false, error:'Kod hatalı' });
    db.run('UPDATE users SET verified=1, verify_code=NULL WHERE id=?', [req.user.userId], (err2) => {
      if (err2) return res.status(500).json({ success:false, error:'Doğrulama güncellenemedi' });
      res.json({ success:true, message:'Doğrulama başarılı. Paket seçimine yönlendiriliyorsunuz.' });
    });
  });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], async (err, user) => {
    if (!user) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ success:false, error:'Geçersiz email/şifre' });
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success:true, token, user:{ id:user.id, email:user.email, role:user.role, verified:user.verified } });
  });
});

// Package selection (required)
app.post('/api/subscription/select', authenticateToken, requireVerified, (req, res) => {
  const { plan } = req.body; // basic | pro | elite
  if (!['basic','pro','elite'].includes(plan)) return res.status(400).json({ success:false, error:'Geçersiz plan' });

  // Plan -> allowed strategies
  const allowed =
    plan === 'basic' ? 'breakout' :
    plan === 'pro' ? 'breakout,pumpdump,manual' :
    'breakout,pumpdump,trendfollow,manual';

  db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, ?)', [req.user.userId, plan, 'active'], (err) => {
    if (err) return res.status(500).json({ success:false, error:'Paket atanamadı' });
    db.run('INSERT OR REPLACE INTO user_config (user_id, allowedStrategies) VALUES (?, ?)', [req.user.userId, allowed], (err2) => {
      if (err2) return res.status(500).json({ success:false, error:'Config güncellenemedi' });
      res.json({ success:true, message:'Paket aktif edildi', allowedStrategies: allowed });
    });
  });
});

// API keys (Bitget)
app.post('/api/keys', authenticateToken, requireVerified, requireActivePlan, (req, res) => {
  const { exchange='bitget', apiKey, secret, passphrase='' } = req.body;
  if (!apiKey || !secret) return res.status(400).json({ success:false, error:'API key ve secret gerekli' });
  db.run('INSERT INTO api_keys (user_id, exchange, api_key, secret, passphrase) VALUES (?, ?, ?, ?, ?)',
    [req.user.userId, exchange, encrypt(apiKey), encrypt(secret), encrypt(passphrase)],
    (err)=> err ? res.status(500).json({ success:false, error:'Kaydedilemedi' }) : res.json({ success:true }));
});

// User config
app.get('/api/user/config', authenticateToken, requireVerified, requireActivePlan, (req, res) => {
  db.get('SELECT * FROM user_config WHERE user_id=?', [req.user.userId], (err, row)=>{
    if (err || !row) return res.status(404).json({ success:false, error:'Config yok' });
    res.json({ success:true, config:row });
  });
});

// CCXT instance per user
async function getCcxtForUser(userId) {
  if (userCcxtCache.has(userId)) return userCcxtCache.get(userId);
  return await new Promise((resolve) => {
    db.get('SELECT * FROM api_keys WHERE user_id=? AND is_active=1 ORDER BY id DESC LIMIT 1', [userId], (err, row) => {
      if (err || !row) return resolve(null);
      try {
        const inst = new ccxt.bitget({
          apiKey: decrypt(row.api_key), secret: decrypt(row.secret), password: decrypt(row.passphrase || encrypt('')),
          options: { defaultType: 'swap' }, enableRateLimit: true, timeout: 30000
        });
        userCcxtCache.set(userId, inst);
        resolve(inst);
      } catch { resolve(null); }
    });
  });
}

// Helpers
class H {
  static async fetchOHLCV(ex, symbol, tf, limit=120){
    const k = `${symbol}_${tf}`; const c = ohlcvCache.get(k);
    if (c && Date.now()-c.ts<120000) return c.data;
    const d = await requestQueue.push(()=>ex.fetchOHLCV(symbol, tf, undefined, limit));
    if (d && d.length) ohlcvCache.set(k,{data:d,ts:Date.now()}); return d;
  }
  static async fetchMultiTF(ex, symbol, tfs){ const r={}; for (const tf of tfs) r[tf]=await this.fetchOHLCV(ex,symbol,tf,120); return r; }
  static snr(ohlcv){ if(!ohlcv||ohlcv.length<20) return {support:0,resistance:0};
    const r=ohlcv.slice(-20); const highs=r.map(c=>c[2]), lows=r.map(c=>c[3]);
    const s=Math.min(...lows), res=Math.max(...highs); return { support:Number(s.toFixed(4)), resistance:Number(res.toFixed(4))}; }
  static volRatio(vols,p=20){ if(!vols||vols.length<p) return 1; const curr=vols[vols.length-1], avg=vols.slice(-p).reduce((a,b)=>a+b,0)/p; return curr/avg; }
  static marketStruct(o1h){ if(!o1h||o1h.length<10) return 'RANGING'; const highs=o1h.map(c=>c[2]), lows=o1h.map(c=>c[3]);
    const lh=Math.max(...highs.slice(-5)), ph=Math.max(...highs.slice(-10,-5)); const ll=Math.min(...lows.slice(-5)), pl=Math.min(...lows.slice(-10,-5));
    if(lh>ph && ll>pl) return 'BULLISH'; if(lh<ph && ll<pl) return 'BEARISH'; return 'RANGING'; }
  static async volConfirm(ex,symbol,thr){ const r=await this.fetchOHLCV(ex,symbol,'5m',20); if(!r||r.length<10) return {confirmed:false,strength:'WEAK',ratio:0};
    const avg=r.map(c=>c[5]).reduce((a,b)=>a+b,0)/r.length; const ratio=r[r.length-1][5]/avg; const conf=ratio>thr; const str=ratio>2?'STRONG':ratio>1.5?'MEDIUM':'WEAK';
    return {confirmed:conf,strength:str,ratio}; }
}

// Strategy (breakout core)
async function analyzeSymbol(ex, userId, cfg, symbol){
  const ticker = await requestQueue.push(()=>ex.fetchTicker(symbol)); if(!ticker||ticker.last<CONFIG.minPrice) return null;
  const multi = await H.fetchMultiTF(ex, symbol, CONFIG.timeframes); const o15=multi['15m'], o1h=multi['1h']; if(!o15||o15.length<60) return null;
  const snr = H.snr(o15); const price=ticker.last; const tol=price*(CONFIG.snrTolerancePercent/100);
  const nearS=Math.abs(price-snr.support)<=tol, nearR=Math.abs(price-snr.resistance)<=tol; if(!nearS && !nearR) return null;
  const mStruct = H.marketStruct(o1h);
  const closes=o15.map(c=>c[4]), highs=o15.map(c=>c[2]), lows=o15.map(c=>c[3]), vols=o15.map(c=>c[5]);
  const ema9 = EMA.calculate({period:9, values:closes}), ema21=EMA.calculate({period:21, values:closes});
  const rsi = RSI.calculate({period:14, values:closes}), adx=ADX.calculate({period:14, high:highs, low:lows, close:closes});
  const atr = ATR.calculate({period:14, high:highs, low:lows, close:closes}), obv=OBV.calculate({close:closes, volume:vols});
  if(!ema9.length||!ema21.length||!adx.length||!atr.length) return null;
  const lastEMA9=ema9[ema9.length-1], lastEMA21=ema21[ema21.length-1], lastRSI=rsi[rsi.length-1], lastADX=adx[adx.length-1]?.adx||0, lastATR=atr[atr.length-1];
  const prevOBV=obv[obv.length-2]||0, lastOBV=obv[obv.length-1];
  const volRatio=H.volRatio(vols,20), baseVol=lastATR/price*100, volFactor=Math.min(1.6,Math.max(0.8,baseVol));
  const slDist = (CONFIG.atrSLMultiplier * lastATR), tpDist = (CONFIG.atrTPMultiplier * lastATR * volFactor);
  const rr = tpDist / slDist;
  let dir='HOLD', conf=60, reason=''; const closerRes=Math.abs(price-snr.resistance)<Math.abs(price-snr.support);
  if(closerRes && lastEMA9>lastEMA21 && mStruct!=='BEARISH'){ dir='LONG_BREAKOUT'; conf+=25; reason=`Direnç kırılımı (${snr.resistance})`; }
  else if(!closerRes && lastEMA9<lastEMA21 && mStruct!=='BULLISH'){ dir='SHORT_BREAKOUT'; conf+=25; reason=`Destek kırılımı (${snr.support})`; }
  else { return null; }
  if (conf < cfg.minConfidenceForAuto) return null;
  const volumeInfo = await H.volConfirm(ex, symbol, CONFIG.volumeConfirmationThreshold);
  const trendAlign = dir==='LONG_BREAKOUT'?'BULLISH':'BEARISH';
  let quality = conf + (volumeInfo.strength==='STRONG'?20:volumeInfo.strength==='MEDIUM'?10:-10);
  if(mStruct===trendAlign) quality+=15; if(rr>2.5) quality+=5; if(lastADX>25) quality+=10; if(!volumeInfo.confirmed) quality-=15;
  const entry = dir==='LONG_BREAKOUT'?snr.resistance:snr.support;
  const sl = dir==='LONG_BREAKOUT'? entry - slDist : entry + slDist;
  const tp = dir==='LONG_BREAKOUT'? entry + tpDist : entry - tpDist;

  const sig = {
    id:`${userId}_${symbol}_${Date.now()}`,
    user_id:userId, ccxt_symbol:symbol, taraf:dir,
    giris:Number(entry.toFixed(4)), tp1:Number(tp.toFixed(4)), sl:Number(sl.toFixed(4)),
    confidence:conf, riskReward:rr.toFixed(2), signalQuality:Math.min(100,Math.max(0,Math.round(quality))),
    adx:Math.round(lastADX).toString(), rsi:Math.round(lastRSI).toString(), obvTrend:lastOBV>prevOBV?'↑':'↓',
    tuyo:`📊 ${reason} | Hacim: ${volumeInfo.strength} (${volumeInfo.ratio.toFixed(2)}x)`, timestamp:Date.now(), orderType:cfg.orderType
  };
  signalCache.set(sig.id, sig);
  db.run('INSERT INTO signals (user_id, symbol, direction, entry, tp, sl, confidence, rr, quality, strategy, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, symbol, dir, sig.giris, sig.tp1, sig.sl, sig.confidence, sig.riskReward, sig.signalQuality, 'breakout', 'local']);
  return sig;
}

// Trading
class Trader {
  async execute(userId, signal, isManual=false){
    const ex = await getCcxtForUser(userId); if(!ex) return;
    const cfg = await new Promise(r=>db.get('SELECT * FROM user_config WHERE user_id=?',[userId],(e,row)=>r(row||{minConfidenceForAuto:60,orderType:'limit',leverage:10,marginPercent:5})));
    if(!isManual && signal.confidence < cfg.minConfidenceForAuto) return;
    const symbol = signal.ccxt_symbol;
    const ticker = await requestQueue.push(()=>ex.fetchTicker(symbol));
    const currentPrice = ticker?.last || signal.giris;
    let entryPrice = signal.giris;
    try { await requestQueue.push(()=>ex.setLeverage(cfg.leverage, symbol, { marginMode:'cross' })); } catch(e){}
    const balance = await requestQueue.push(()=>ex.fetchBalance()); const available = parseFloat(balance.USDT?.free||0);
    if(available<10) return;
    const cost = available * (cfg.marginPercent/100) * (signal.positionSize || 1.0);
    const amountUSDT = cost * cfg.leverage; const basePrice = cfg.orderType==='market'?currentPrice:entryPrice;
    let qty = amountUSDT / basePrice; try { qty = ex.amountToPrecision(symbol, qty); } catch {}
    const side = signal.taraf.includes('LONG')?'buy':'sell';
    let entryOrder=null;
    if(cfg.orderType==='limit') entryOrder = await requestQueue.push(()=>ex.createOrder(symbol,'limit',side,qty,entryPrice));
    else { entryOrder = await requestQueue.push(()=>ex.createOrder(symbol,'market',side,qty)); entryPrice=currentPrice; }
    if(!entryOrder) return;

    // TP/SL conditional reduceOnly
    const reduceSide = side==='buy'?'sell':'buy';
    let slId=null, tpId=null;
    try {
      const slParams={ reduceOnly:true, triggerPrice:signal.sl, stopPrice:signal.sl, stopLoss:{ triggerPrice:signal.sl, price:signal.sl } };
      const sl = await requestQueue.push(()=>ex.createOrder(symbol,'market',reduceSide,qty,undefined,slParams)); slId = sl?.id || null;
    } catch(e){}
    try {
      const tpParams={ reduceOnly:true, triggerPrice:signal.tp1, takeProfit:{ triggerPrice:signal.tp1, price:signal.tp1 } };
      const tp = await requestQueue.push(()=>ex.createOrder(symbol,'market',reduceSide,qty,undefined,tpParams)); tpId = tp?.id || null;
    } catch(e){}
    db.run('INSERT INTO trades (user_id, symbol, direction, entry_price, quantity, tp_price, sl_price, order_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, symbol, signal.taraf, entryPrice, qty, signal.tp1, signal.sl, JSON.stringify({ entryId:entryOrder.id, slId, tpId })]);
    systemStatus.performance.executedTrades++;
  }
  async close(userId, symbol, side, contracts){
    const ex = await getCcxtForUser(userId); if(!ex) return { success:false, error:'API yok' };
    const reduceSide = side==='LONG'?'sell':'buy';
    try {
      const o = await requestQueue.push(()=>ex.createOrder(symbol,'market',reduceSide,Math.abs(contracts),undefined,{ reduceOnly:true }));
      return { success:true, orderId:o.id };
    } catch(e){ return { success:false, error:e.message }; }
  }
}
const trader = new Trader();

// Scan per user
async function scanForUser(userId){
  const ex = await getCcxtForUser(userId); if(!ex) return [];
  await requestQueue.push(()=>ex.loadMarkets(true));
  const tickers = await requestQueue.push(()=>ex.fetchTickers());
  const symbols = Object.keys(ex.markets).filter(s=>ex.markets[s].active && s.includes('USDT') && (ex.markets[s].swap || ex.markets[s].future));
  const hv = symbols.filter(s => (tickers[s]?.quoteVolume || 0) >= CONFIG.minVolumeUSD).slice(0,150);
  const batch = hv.slice(0, CONFIG.scanBatchSize);
  const cfg = await new Promise(r=>db.get('SELECT * FROM user_config WHERE user_id=?',[userId],(e,row)=>r(row)));
  const signals=[];
  for(const sym of batch){
    const sig = await analyzeSymbol(ex, userId, cfg, sym);
    if(sig) { signals.push(sig); if(sig.confidence >= cfg.minConfidenceForAuto) await trader.execute(userId, sig, false); }
  }
  return signals;
}

// API: scan, trade manual, position close, status
app.post('/api/signals/scan', authenticateToken, requireVerified, requireActivePlan, async (req,res)=>{
  const signals = await scanForUser(req.user.userId);
  res.json({ success:true, signals });
});
app.post('/api/trade/manual', authenticateToken, requireVerified, requireActivePlan, async (req,res)=>{
  try { await trader.execute(req.user.userId, req.body, true); res.json({ success:true }); }
  catch(e){ res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/position/close', authenticateToken, requireVerified, requireActivePlan, async (req,res)=>{
  const { symbol, side, contracts } = req.body;
  const r = await trader.close(req.user.userId, symbol, side, contracts);
  res.json(r);
});
app.get('/api/status', authenticateToken, requireVerified, async (req,res)=>{
  const ex = await getCcxtForUser(req.user.userId);
  let positions=[]; try { positions = ex ? await requestQueue.push(()=>ex.fetchPositions()) : []; } catch{}
  positions = positions.filter(x=>parseFloat(x.contracts || x.size || 0) > 0);
  const signals = Array.from(signalCache.values()).filter(s=>s.user_id===req.user.userId).sort((a,b)=>b.timestamp-a.timestamp);
  res.json({ success:true, system:systemStatus, signals, positions });
});

// Admin panel APIs
function requireAdmin(req,res,next){ if(req.user.role!=='admin') return res.status(403).json({ success:false, error:'Admin gerekli' }); next(); }
app.get('/api/admin/users', authenticateToken, requireAdmin, (req,res)=>{
  db.all('SELECT id,email,role,verified,created_at FROM users', [], (err, rows)=> res.json({ success:!err, users:rows }));
});
app.get('/api/admin/subscriptions', authenticateToken, requireAdmin, (req,res)=>{
  db.all('SELECT * FROM subscriptions', [], (err, rows)=> res.json({ success:!err, subscriptions:rows }));
});
app.get('/api/admin/api-keys', authenticateToken, requireAdmin, (req,res)=>{
  db.all('SELECT id,user_id,exchange,created_at FROM api_keys', [], (err, rows)=> res.json({ success:!err, keys:rows }));
});
app.get('/api/admin/trades', authenticateToken, requireAdmin, (req,res)=>{
  db.all('SELECT * FROM trades ORDER BY timestamp DESC', [], (err, rows)=> res.json({ success:!err, trades:rows }));
});
app.post('/api/admin/subscription/set', authenticateToken, requireAdmin, (req,res)=>{
  const { userId, plan, status } = req.body;
  db.run('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, ?)', [userId, plan, status], (err)=>{
    if (err) return res.status(500).json({ success:false, error:'Atama hata' });
    res.json({ success:true });
  });
});

// WebSocket (token required)
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) return ws.close(1008, 'Auth required');
  let user=null; try { user = jwt.verify(token, JWT_SECRET); } catch { return ws.close(1008, 'Invalid token'); }
  const send = () => {
    const list = Array.from(signalCache.values()).filter(s=>s.user_id===user.userId).sort((a,b)=>b.timestamp-a.timestamp);
    ws.readyState===ws.OPEN && ws.send(JSON.stringify({ type:'signal_list', data:list }));
  };
  send();
});
setInterval(()=>{ // cleanup
  const now=Date.now(); for(const [k,v] of signalCache.entries()) if(now-v.timestamp>SIGNAL_CACHE_DURATION) signalCache.delete(k);
}, 5*60*1000);

// UI routes
app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

// Start
server.listen(PORT, () => {
  console.log(`🚀 Alphason UI: http://localhost:${PORT}`);
});
