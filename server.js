require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

// Database import
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(path.join(__dirname, 'public/videos')));

// ================== AUTH MIDDLEWARE ==================
async function authenticateToken(req, res, next) {
    // Public routes - do not require authentication
    const publicRoutes = ['/', '/login.html', '/register.html', '/verify.html', '/api/login', '/api/register'];
    if (publicRoutes.includes(req.path)) {
        return next();
    }

    // Check for token in Authorization header or query parameter
    let token = req.headers['authorization'];
    if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
    } else {
        token = req.query.token;
    }

    if (!token) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, error: 'Erişim reddedildi. Token gerekli.' });
        } else {
            return res.redirect('/login.html');
        }
    }

    try {
        const user = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE session_token = ?", [token], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ success: false, error: 'Geçersiz token' });
            } else {
                return res.redirect('/login.html');
            }
        }

        req.user = user;
        next();
    } catch (error) {
        if (req.path.startsWith('/api/')) {
            return res.status(500).json({ success: false, error: 'Sunucu hatası' });
        } else {
            return res.redirect('/login.html');
        }
    }
}

// Apply authentication middleware to all routes
app.use(authenticateToken);

// ================== CONFIG ==================
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),

  leverage: 10, marginPercent: 5, maxPositions: 5, dailyTradeLimit: 40, riskProfile: 'balanced', scalpMode: false,
  orderType: 'limit', limitOrderPriceOffset: 0.1, maxSlippagePercent: 1.5,
  minConfidenceForAuto: 60, minVolumeUSD: 300000, volumeConfirmationThreshold: 1.3, minTrendStrength: 22, snrTolerancePercent: 2.0,
  enableTimeFilter: false, optimalTradingHours: [7,8,9,13,14,15,19,20,21],
  strategies: { breakout: true, trendfollow: true, pumpdump: true },
  timeframes: ['15m', '1h', '4h'], timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },
  atrSLMultiplier: 1.5, atrTPMultiplier: 3.0,
  signalCooldownMs: 30 * 60 * 1000, scanBatchSize: 10,
  focusedScanIntervalMs: 5 * 60 * 1000, fullSymbolRefreshMs: 15 * 60 * 1000,
  autotradeMaster: false, minPrice: 0.05
};

// ================== GLOBALS ==================
let exchangeAdapter = null;
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
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
  isHealthy: true, filterCount: 0, balance: 0, marketSentiment: 'Analiz ediliyor…',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

const perfTracker = {
  history: [],
  avgGain(days = 7, strategy, direction) {
    const since = Date.now() - days*24*60*60*1000;
    const sample = this.history.filter(h => h.ts >= since && (!strategy || h.strategy === strategy) && (!direction || h.direction === direction));
    if (sample.length === 0) return { value: null, count: 0 };
    const avg = sample.reduce((a,b)=> a + (b.gainPct||0), 0) / sample.length;
    return { value: Number(avg.toFixed(2)), count: sample.length };
  },
  recordTradeResult(coin, strategy, direction, gainPct){
    this.history.push({ ts: Date.now(), coin, strategy, direction, gainPct });
    const last30 = this.history.slice(-100);
    const wins = last30.filter(x=> x.gainPct > 0).length;
    systemStatus.performance.winRate = last30.length ? wins / last30.length : 0;
  }
};

const requestQueue = {
  queue: [], running: 0, concurrency: 8,
  push(fn) {
    return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.next(); });
  },
  async next() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.running++;
    try { item.resolve(await item.fn()); }
    catch (e) { item.reject(e); }
    finally { this.running--; this.next(); }
  }
};

const H = {
  async delay(ms){ return new Promise(r=>setTimeout(r,ms)); },
  round(price){
    if (!price || isNaN(price)) return 0;
    if (price < 0.00001) return Number(price.toFixed(8));
    if (price < 0.001) return Number(price.toFixed(7));
    if (price < 1) return Number(price.toFixed(5));
    if (price < 10) return Number(price.toFixed(4));
    return Number(price.toFixed(2));
  },
  async fetchOHLCV(symbol, timeframe, limit=150){
    const key = `${symbol}_${timeframe}`;
    const cached = ohlcvCache.get(key);
    if (cached && (Date.now()-cached.ts < 120000)) return cached.data;
    
    try {
      let data;
      if (exchangeAdapter && CONFIG.isApiConfigured) {
        data = await requestQueue.push(()=> exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
      } else {
        data = await requestQueue.push(()=> publicExchange.fetchOHLCV(symbol, timeframe, undefined, limit));
      }
      
      if (data?.length) ohlcvCache.set(key, { data, ts: Date.now() });
      return data;
    } catch(e){ 
      console.error(`OHLCV fetch error for ${symbol}:`, e.message);
      return null; 
    }
  },
  async fetchMulti(symbol){
    const res = {};
    for(const tf of CONFIG.timeframes){ 
      res[tf] = await this.fetchOHLCV(symbol, tf, 150); 
    }
    return res;
  },
  async fetchTicker(symbol){
    try {
      if (exchangeAdapter && CONFIG.isApiConfigured) {
        return await requestQueue.push(()=> exchangeAdapter.raw.fetchTicker(symbol));
      } else {
        return await requestQueue.push(()=> publicExchange.fetchTicker(symbol));
      }
    } catch(e) {
      console.error(`Ticker fetch error for ${symbol}:`, e.message);
      return null;
    }
  },
  simpleSnR(ohlcv15m){
    if (!ohlcv15m || ohlcv15m.length < 30) return { support:0, resistance:0, quality:0 };
    const recent = ohlcv15m.slice(-30);
    const highs = recent.map(c=>c[2]), lows = recent.map(c=>c[3]);
    const s = Math.min(...lows), r = Math.max(...highs);
    return { support: this.round(s), resistance: this.round(r), quality: Math.abs(r-s)/((r+s)/2) };
  },
  volRatio(vols, period=20){
    if (!vols || vols.length < period) return 1;
    const cur = vols[vols.length-1];
    const avg = vols.slice(-period).reduce((a,b)=>a+b,0)/period;
    return cur/avg;
  },
  marketStructure(ohlcv1h){
    if (!ohlcv1h || ohlcv1h.length < 10) return "RANGING";
    const highs = ohlcv1h.map(c=>c[2]), lows = ohlcv1h.map(c=>c[3]);
    const lh = Math.max(...highs.slice(-5)), ph = Math.max(...highs.slice(-10,-5));
    const ll = Math.min(...lows.slice(-5)), pl = Math.min(...lows.slice(-10,-5));
    if (lh>ph && ll>pl) return "BULLISH";
    if (lh<ph && ll<pl) return "BEARISH";
    return "RANGING";
  },
  tvLink(symbol){
    const base = symbol.replace(':USDT','').replace('/USDT','USDT');
    return `https://www.tradingview.com/chart/?symbol=BITGET:${base}`;
  }
};

async function confirmBreakoutVolume(symbol){
  const o = await H.fetchOHLCV(symbol,'5m',18);
  if (!o || o.length<10) return {confirmed:false,strength:'low',ratio:0};
  const avg = o.map(c=>c[5]).reduce((a,b)=>a+b,0)/o.length;
  const last = o[o.length-1][5];
  const ratio = last/avg;
  let level='low';
  if (ratio>2.0) level='high'; else if (ratio>1.5) level='medium';
  return {confirmed: ratio>CONFIG.volumeConfirmationThreshold, strength: level, ratio};
}

// ================== ANALYZER ==================
async function analyzeSymbol(symbol){
  const lastTs = signalHistory.get(symbol)||0;
  if (Date.now()-lastTs < CONFIG.signalCooldownMs) return null;

  const ticker = await H.fetchTicker(symbol);
  if (!ticker || ticker.last < CONFIG.minPrice) return null;
  const multi = await H.fetchMulti(symbol);
  const o15 = multi['15m'], o1h = multi['1h'];
  if (!o15 || o15.length<80) return null;
  const snr = H.simpleSnR(o15);
  const price = ticker.last;
  const tol = price*(CONFIG.snrTolerancePercent/100);
  const nearSupport = Math.abs(price - snr.support) <= tol;
  const nearResistance = Math.abs(price - snr.resistance) <= tol;
  const mStruct = H.marketStructure(o1h);

  const closes = o15.map(c=>c[4]), highs=o15.map(c=>c[2]), lows=o15.map(c=>c[3]), vols=o15.map(c=>c[5]);
  const ema9 = EMA.calculate({period:9,values:closes});
  const ema21 = EMA.calculate({period:21,values:closes});
  const rsi = RSI.calculate({period:14,values:closes});
  const adx = ADX.calculate({period:14,high:highs,low:lows,close:closes});
  const atr = ATR.calculate({period:14,high:highs,low:lows,close:closes});
  if (!ema9.length || !ema21.length || !rsi.length || !adx.length || !atr.length) return null;

  const e9=ema9[ema9.length-1], e21=ema21[ema21.length-1];
  const rsiLast=rsi[rsi.length-1];
  const adxLast=adx[adx.length-1]?.adx || 0;
  const atrLast=atr[atr.length-1];
  const obv = OBV.calculate({close:closes,volume:vols});
  const obvTrend = (obv[obv.length-1] > (obv[obv.length-2]||0)) ? 'UP' : 'DOWN';
  const volRatio = H.volRatio(vols,20);
  const baseVolPct = atrLast/price*100;
  const volFactor = Math.min(1.6, Math.max(0.8, baseVolPct));
  const slDist = (CONFIG.atrSLMultiplier * (CONFIG.scalpMode?0.7:1.0)) * atrLast;
  const tpDist = (CONFIG.atrTPMultiplier * (CONFIG.scalpMode?0.7:1.0) * volFactor) * atrLast;
  const rr = tpDist / slDist;

  // Candidates
  let candidates = [];
  
  // Breakout
  if (CONFIG.strategies.breakout && (nearSupport || nearResistance)){
    const dir = (nearResistance && e9>=e21 && mStruct!=='BEARISH') ? 'LONG' :
                (nearSupport && e9<=e21 && mStruct!=='BULLISH') ? 'SHORT' : 'HOLD';
    let conf = 60;
    if (dir==='LONG' && mStruct==='BULLISH') conf+=10;
    if (dir==='SHORT' && mStruct==='BEARISH') conf+=10;
    if (obvTrend==='UP' && dir==='LONG') conf+=6;
    if (obvTrend==='DOWN' && dir==='SHORT') conf+=6;
    candidates.push({strategy:'breakout', dir, conf});
  }

  // TrendFollow
  if (CONFIG.strategies.trendfollow){
    let dir='HOLD', conf=55;
    if (e9>e21 && adxLast>CONFIG.minTrendStrength && rsiLast<72){ dir='LONG'; conf=70; }
    else if (e9<e21 && adxLast>CONFIG.minTrendStrength && rsiLast>28){ dir='SHORT'; conf=70; }
    candidates.push({strategy:'trendfollow', dir, conf});
  }

  // PumpDump
  if (CONFIG.strategies.pumpdump){
    const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
    const lastVol = vols[vols.length-1];
    const last = closes[closes.length-1], prev = closes[closes.length-2];
    let dir='HOLD', conf=60;
    if (lastVol > avgVol*3 && last > prev*1.045){ dir='LONG'; conf=75; }
    else if (lastVol > avgVol*3 && last < prev*0.955){ dir='SHORT'; conf=75; }
    candidates.push({strategy:'pumpdump', dir, conf});
  }

  candidates = candidates.filter(c=> c.dir!=='HOLD');
  if (candidates.length===0) return null;
  
  const prefOrder = ['breakout','trendfollow','pumpdump'];
  candidates.sort((a,b)=> prefOrder.indexOf(a.strategy)-prefOrder.indexOf(b.strategy) || b.conf-a.conf);
  const chosen = candidates[0];
  
  // Volume info
  const vinfo = await confirmBreakoutVolume(symbol);
  const volumeLevel = vinfo.strength; 

  // Quality check
  let quality = chosen.conf;
  if (volumeLevel==='high') quality+=15; else if (volumeLevel==='medium') quality+=8; else quality-=6;
  if (rr>2.0) quality+=6;
  if (adxLast>CONFIG.minTrendStrength) quality+=6; else quality-=4;
  if (rsiLast>80 || rsiLast<20) quality-=4;
  quality = Math.min(100, Math.max(0, quality));
  
  if (chosen.conf < CONFIG.minConfidenceForAuto || quality < 55) return null;
  
  // Entry at level (breakout) or market (others)
  const entry = chosen.dir==='LONG' ? (nearResistance ? snr.resistance : price) : (nearSupport ? snr.support : price);
  const sl = chosen.dir==='LONG' ? entry - slDist : entry + slDist;
  const tp1 = chosen.dir==='LONG' ? entry + tpDist : entry - tpDist;
  
  signalHistory.set(symbol, Date.now());
  systemStatus.performance.totalSignals++;

  // Narrative
  const whyParts = [];
  if (chosen.strategy==='breakout'){
    whyParts.push('Fiyat kritik seviyeye yakın');
    if (chosen.dir==='LONG') whyParts.push('yükseliş yönünde kırılım bekleniyor');
    else whyParts.push('düşüş yönünde kırılım bekleniyor');
  } else if (chosen.strategy==='trendfollow'){
    whyParts.push('Kısa ortalama uzun ortalamayı geçti');
    whyParts.push(adxLast > CONFIG.minTrendStrength ? 'trend gücü yeterli' : 'trend gücü sınırlı');
  } else {
    whyParts.push(vinfo.ratio>2.0 ? 'Hacim olağanüstü yüksek' : 'Hacim artışı var');
    whyParts.push(chosen.dir==='LONG' ? 'yukarı yönlü ivme' : 'aşağı yönlü ivme');
  }
  
  const narrative = {
    why: whyParts.join(', '),
    outlook: chosen.dir==='LONG' ? 'Kırılım sonrası hızlanma beklenir, risk orta.' : 'Destek altı kırılımda düşüş hızlanabilir, risk orta.'
  };
  
  // Position size multiplier
  const baseSize = CONFIG.riskProfile==='aggressive' ? 1.3 : CONFIG.riskProfile==='conservative' ? 0.8 : 1.0;
  const posMult = Math.min(2.2, Math.max(0.5, baseSize * (quality>80?1.1:1.0) * (volFactor>1.3?0.8:1.0)));

  const tv = H.tvLink(symbol);
  
  return {
    id: `${symbol}_${chosen.strategy}_${chosen.dir}_${Date.now()}`,
    coin: symbol.replace(':USDT','').replace('/USDT','')+'/USDT',
    ccxt_symbol: symbol,
    direction: chosen.dir,             
    strategy: chosen.strategy,         
    giris: H.round(entry),
    tp1: H.round(tp1),
    sl: H.round(sl),
    riskReward: Number((rr).toFixed(2)),
    confidence: Math.round(chosen.conf),
    signalQuality: Math.round(quality),
    volumeLevel: volumeLevel,                      
    narrative: narrative,
    positionSize: Number(posMult.toFixed(2)),
    positionSizeType: posMult>=1.5?'LARGE':posMult>=1.0?'NORMAL':posMult>=0.75?'SMALL':'MINI',
    riskLevel: chosen.conf>=80?'LOW':'MEDIUM',
    adx: Math.round(adxLast),
    rsi: Math.round(rsiLast),
    obvTrend: (obvTrend==='UP'?'↑':'↓'),
    tvLink: tv,
    orderType: CONFIG.orderType,
    timestamp: Date.now()
  };
}

// ================== AUTOTRADE ==================
const AutoTrade = {
  async getCurrentPrice(symbol){
    try{ 
      const t = await H.fetchTicker(symbol);
      return t?.last || 0; 
    }catch{ return 0; }
  },
  async getPositions(){
    if (!CONFIG.isApiConfigured || !exchangeAdapter) return [];
    try{ 
      const p = await requestQueue.push(()=> exchangeAdapter.raw.fetchPositions()); 
      return p.filter(x=> parseFloat(x.contracts)>0); 
    }catch{ return []; }
  },
  async placeOrder(symbol, side, amount, price, orderType){
    if (!CONFIG.isApiConfigured || !exchangeAdapter) {
      return { success: false, error: 'API bağlantısı yok' };
    }
    
    try{
      if (orderType==='limit'){
        const o = await requestQueue.push(()=> exchangeAdapter.raw.createOrder(symbol,'limit',side,amount,price));
        return o;
      }else{
        const o = await requestQueue.push(()=> exchangeAdapter.raw.createOrder(symbol,'market',side,amount));
        return o;
      }
    }catch(e){ 
      console.error('Order error:', e);
      return null; 
    }
  },
  async placeTPSL(symbol, side, amount, tp, sl){
    if (!CONFIG.isApiConfigured || !exchangeAdapter) return;
    
    try{
      const stopSide = side==='buy'?'sell':'buy';
      await requestQueue.push(()=> exchangeAdapter.raw.createOrder(symbol,'market',stopSide,amount,undefined,{ stopLoss:{ triggerPrice: sl, price: sl } }));
      await requestQueue.push(()=> exchangeAdapter.raw.createOrder(symbol,'market',stopSide,amount,undefined,{ takeProfit:{ triggerPrice: tp, price: tp } }));
    }catch(e){
      console.error('TPSL error:', e);
    }
  },
  async execute(signal, isManual=false){
    // API yoksa sadece sinyal göster, işlem yapma
    if (!CONFIG.isApiConfigured && !isManual) {
      console.log('Sinyal oluşturuldu (API yok):', signal);
      return { success: true, signalOnly: true, message: 'Sinyal oluşturuldu - API bağlantısı yok' };
    }
    
    if (!CONFIG.isApiConfigured && isManual) {
      return { success: false, error: 'Manuel işlem için API bağlantısı gerekli' };
    }
    
    if (!isManual && CONFIG.autotradeMaster && signal.confidence < CONFIG.minConfidenceForAuto) return;
    
    try{
      const symbol = signal.ccxt_symbol;
      const current = await this.getCurrentPrice(symbol);
      let entry = signal.giris;
      if (CONFIG.orderType==='market') entry = current;

      await requestQueue.push(()=> exchangeAdapter.raw.setLeverage(CONFIG.leverage, symbol));
      const bal = await requestQueue.push(()=> exchangeAdapter.raw.fetchBalance());
      const free = parseFloat(bal.USDT?.free || 0);
      if (free < 10) return { success: false, error: 'Yetersiz bakiye' };
      const cost = free * (CONFIG.marginPercent/100) * signal.positionSize;
      const amtUSDT = cost * CONFIG.leverage;
      let amountCoin = amtUSDT/entry;
      
      try{
        const market = exchangeAdapter.raw.markets[symbol];
        if (market?.precision?.amount) amountCoin = exchangeAdapter.raw.amountToPrecision(symbol, amountCoin);
        else amountCoin = Number(amountCoin.toFixed(6));
      }catch{ amountCoin = Number(amountCoin.toFixed(6)); }

      const side = signal.direction==='LONG' ? 'buy' : 'sell';
      const order = await this.placeOrder(symbol, side, amountCoin, entry, CONFIG.orderType);
      
      if (order && order.success !== false){
        await this.placeTPSL(symbol, side, amountCoin, signal.tp1, signal.sl);
        systemStatus.performance.executedTrades++;
        const simulatedGain = side==='buy' ? 1.2 : -0.8;
        perfTracker.recordTradeResult(signal.coin, signal.strategy, signal.direction, simulatedGain);
        
        return { success: true, orderId: order.id };
      } else {
        return { success: false, error: order?.error || 'Order failed' };
      }
    }catch(e){
      console.error('Trade execution error:', e);
      return { success: false, error: e.message };
    }
  },
  async closePosition(symbol, side, contracts){
    if (!CONFIG.isApiConfigured || !exchangeAdapter) {
      return { success: false, error: 'API bağlantısı yok' };
    }
    
    try{
      const closeSide = side==='LONG'?'sell':'buy';
      const params = { reduceOnly:true };
      await requestQueue.push(()=> exchangeAdapter.raw.createOrder(symbol,'market',closeSide,Math.abs(contracts),undefined,params));
      return { success:true };
    }catch(e){ 
      return { success:false, error:e.message }; 
    }
  }
};

// ================== SCANNER ==================
async function refreshMarkets(){
  try{
    // Public exchange ile piyasa verilerini al
    await requestQueue.push(()=> publicExchange.loadMarkets());
    const tickers = await requestQueue.push(()=> publicExchange.fetchTickers());
    const all = Object.keys(publicExchange.markets).filter(s=>{
      const m = publicExchange.markets[s];
      return m.active && s.includes('USDT') && (m.swap || m.future);
    });
    const high = [];
    for (const s of all){
      const t = tickers[s];
      if (t && (t.quoteVolume >= CONFIG.minVolumeUSD)) high.push(s);
    }
    high.sort((a,b)=> (tickers[b]?.quoteVolume||0)-(tickers[a]?.quoteVolume||0));
    cachedHighVol = high;
    focusedSymbols = [...high];
    lastMarketRefresh = Date.now();
    systemStatus.filterCount = high.length;

    // Market sentiment analizi
    const sample = high.slice(0,30);
    let L=0,S=0;
    for (const s of sample){
      const o = await H.fetchOHLCV(s,'1h',40); if (!o) continue;
      const cls = o.map(c=>c[4]);
      const e9 = EMA.calculate({period:9,values:cls});
      const e21 = EMA.calculate({period:21,values:cls});
      if (!e9.length || !e21.length) continue;
      if (e9[e9.length-1] > e21[e21.length-1]) L++; else S++;
    }
    systemStatus.marketSentiment = L>S*1.5 ? 'YÜKSELİŞ 🟢' : S>L*1.5 ? 'DÜŞÜŞ 🔴' : 'YATAY ⚪️';
  }catch(e){
    console.error('Market refresh error:', e);
  }
}

async function scanLoop(){
  if (focusedSymbols.length===0){
    const now = Date.now();
    if (now-lastMarketRefresh > CONFIG.fullSymbolRefreshMs || cachedHighVol.length===0){
      await refreshMarkets();
    }else{
      focusedSymbols = [...cachedHighVol];
      await H.delay(800);
    }
    return;
  }
  const batch = focusedSymbols.splice(0, CONFIG.scanBatchSize);
  for (const s of batch){
    const sig = await analyzeSymbol(s);
    if (sig){
      signalCache.set(sig.id, sig);
      broadcastSignalList();
      if (CONFIG.autotradeMaster && sig.confidence >= CONFIG.minConfidenceForAuto){
        AutoTrade.execute(sig);
      }
    }
  }
}

function cleanupSignalCache(){
  const now = Date.now();
  for (const [id, sig] of signalCache.entries()){
    if (now - sig.timestamp > SIGNAL_CACHE_DURATION){
      signalCache.delete(id);
    }
  }
  broadcastSignalList();
}
setInterval(cleanupSignalCache, 5*60*1000);

// ================== WS BROADCAST ==================
function broadcastSignalList(){
  const list = Array.from(signalCache.values()).sort((a,b)=> b.timestamp-a.timestamp);
  const msg = JSON.stringify({ type:'signal_list', data:list });
  wss.clients.forEach(c=>{ if (c.readyState===WebSocket.OPEN) c.send(msg); });
}

function broadcastSystemStatus(){
  const msg = JSON.stringify({ type:'system_status', data:systemStatus });
  wss.clients.forEach(c=>{ if (c.readyState===WebSocket.OPEN) c.send(msg); });
}

// ================== API ROUTES ==================

// Giriş endpoint'i
app.post('/api/login', async (req, res) => {
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

    // Session token oluştur
    const sessionToken = `token-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET session_token = ? WHERE id = ?",
        [sessionToken, user.id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        email: user.email, 
        plan: user.plan
      },
      token: sessionToken
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Kayıt endpoint'i
app.post('/api/register', async (req, res) => {
  const { email, password, plan = 'basic', apiKey, apiSecret, apiPass } = req.body;
  
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
        `INSERT INTO users (email, password, plan, api_key, api_secret, api_passphrase) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [email, hashedPassword, plan, apiKey || '', apiSecret || '', apiPass || ''],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    res.json({ 
      success: true, 
      message: 'Kayıt başarılı',
      userId: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Kullanıcı bilgilerini getir
app.get('/api/user', async (req, res) => {
  try {
    const user = await new Promise((resolve, reject) => {
      db.get("SELECT id, email, plan, created_at FROM users WHERE id = ?", [req.user.id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Çıkış yap
app.post('/api/logout', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE users SET session_token = NULL WHERE id = ?",
        [req.user.id],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true, message: 'Çıkış başarılı' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sinyal listesi
app.get('/api/signals', (req, res) => {
  const signals = Array.from(signalCache.values())
    .sort((a,b)=> b.timestamp-a.timestamp)
    .slice(0, 50);
  
  res.json({ success: true, signals });
});

// Sistem durumu
app.get('/api/system/status', (req, res) => {
  res.json({
    success: true,
    status: systemStatus,
    config: CONFIG
  });
});

// Manuel tarama
app.post('/api/scan/:symbol', async (req, res) => {
  const symbol = req.params.symbol + ':USDT';
  
  try {
    const signal = await analyzeSymbol(symbol);
    if (signal) {
      signalCache.set(signal.id, signal);
      broadcastSignalList();
      res.json({ success: true, signal });
    } else {
      res.json({ success: false, error: 'Sinyal bulunamadı' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Dashboard route - token kontrolü yapılıyor
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// Diğer protected routes
app.get('/backtesting.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/backtesting.html'));
});

app.get('/settings.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/settings.html'));
});

app.get('/package.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/package.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// ================== BAŞLANGIÇ ==================
async function initializeSystem(){
  try {
    console.log('🤖 Sinyal Sistemi Başlatılıyor...');
    
    // Public exchange başlat
    await publicExchange.loadMarkets();
    console.log('✅ Public API bağlantısı hazır');
    
    // İlk market verilerini yükle
    await refreshMarkets();
    console.log('✅ Piyasa verileri yüklendi');
    
    // Scanner loop başlat
    setInterval(scanLoop, 5000);
    console.log('✅ Scanner aktif');
    
    // Cache temizleme
    setInterval(cleanupSignalCache, 5*60*1000);
    
    // System status broadcast
    setInterval(broadcastSystemStatus, 10000);
    
    console.log('🚀 SİSTEM HAZIR - API Keysiz Gerçek Sinyal Modu');
    console.log('📊 İşlem çiftleri:', systemStatus.filterCount);
    console.log('📈 Market sentiment:', systemStatus.marketSentiment);
    
  } catch(e) {
    console.error('❌ Sistem başlatma hatası:', e);
  }
}

// Sunucuyu başlat
server.listen(PORT, () => {
  console.log(`📍 Server http://localhost:${PORT} adresinde çalışıyor`);
  initializeSystem();
});
