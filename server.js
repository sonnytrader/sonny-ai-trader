// server.js
// Alphason Trader — SaaS feel + Strategies (Breakout, TrendFollow, PumpDump)
// Signals enriched: strategy, volumeLevel, narrative, perf. Render-ready.

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors'); // CORS eklendi
const fs = require('fs');     // FS eklendi
const bcrypt = require('bcrypt'); // bcrypt eklendi
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

// Modüler dosyaları dahil et
const db = require('./database'); 
const authRoutes = require('./routes/auth'); 

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors()); // CORS aktif
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ROTALAR ---
app.use('/api', authRoutes); // Auth rotaları eklendi

// ================== CONFIG (SENİN GÖNDERDİĞİN) ==================
let CONFIG = {
  apiKey: process.empty.BITGET_API_KEY || '',
  secret: process.empty.BITGET_SECRET || '',
  password: process.empty.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.empty.BITGET_API_KEY && process.empty.BITGET_SECRET),

  leverage: 10,
  marginPercent: 5,
  maxPositions: 5,
  dailyTradeLimit: 40,
  riskProfile: 'balanced',
  scalpMode: false,

  orderType: 'limit',
  limitOrderPriceOffset: 0.1,
  maxSlippagePercent: 1.5,

  minConfidenceForAuto: 60,
  minVolumeUSD: 300000,
  volumeConfirmationThreshold: 1.3,
  minTrendStrength: 22,
  snrTolerancePercent: 2.0,

  enableTimeFilter: false,
  optimalTradingHours: [7,8,9,13,14,15,19,20,21],

  strategies: { breakout: true, trendfollow: true, pumpdump: true },

  timeframes: ['15m', '1h', '4h'],
  timeframeWeights: { '15m': 0.4, '1h': 0.35, '4h': 0.25 },

  atrSLMultiplier: 1.5,
  atrTPMultiplier: 3.0,

  signalCooldownMs: 30 * 60 * 1000,
  scanBatchSize: 10,
 
  focusedScanIntervalMs: 5 * 60 * 1000,
  fullSymbolRefreshMs: 15 * 60 * 1000,

  autotradeMaster: false,
  minPrice: 0.05
};
// ================== GLOBALS (SENİN GÖNDERDİĞİN) ==================
let exchangeAdapter = null;
let focusedSymbols = [];
let cachedHighVol = [];
let lastMarketRefresh = 0;
let signalHistory = new Map();
const ohlcvCache = new Map();
const signalCache = new Map();
const SIGNAL_CACHE_DURATION = 60 * 60 * 1000;

const systemStatus = {
  isHealthy: true,
  filterCount: 0,
  balance: 0,
  marketSentiment: 'Analiz ediliyor…',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};
const perfTracker = {
  history: [],
  avgGain(days = 7, strategy, direction) { /* ... logic ... */ return { value: null, count: 0 }; },
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
    try{
      const data = await requestQueue.push(()=> exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit));
      if (data?.length) ohlcvCache.set(key, { data, ts: Date.now() });
      return data;
    }catch(e){ return null; }
  },
  async fetchMulti(symbol){
    const res = {};
    for(const tf of CONFIG.timeframes){ res[tf] = await this.fetchOHLCV(symbol, tf, 150); }
    return res;
  },
  simpleSnR(ohlcv15m){ /* ... logic ... */ return { support:0, resistance:0, quality:0 }; },
  volRatio(vols, period=20){ /* ... logic ... */ return 1; },
  marketStructure(ohlcv1h){ /* ... logic ... */ return "RANGING"; },
  tvLink(symbol){
    const base = symbol.replace(':USDT','').replace('/USDT','USDT');
    return `https://www.tradingview.com/chart/?symbol=BITGET:${base}`;
  }
};
async function confirmBreakoutVolume(symbol){ /* ... logic ... */ return {confirmed:false,strength:'low',ratio:0}; }

// ================== ANALYZER (SENİN GÖNDERDİĞİN) ==================
async function analyzeSymbol(symbol){
  const lastTs = signalHistory.get(symbol)||0;
  if (Date.now()-lastTs < CONFIG.signalCooldownMs) return null;

  const ticker = await requestQueue.push(()=> exchangeAdapter.raw.fetchTicker(symbol));
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

  let candidates = [];
  // Breakout
  if (CONFIG.strategies.breakout && (nearSupport || nearResistance)){
    const dir = (nearResistance && e9>=e21 && mStruct!=='BEARISH') ? 'LONG' : (nearSupport && e9<=e21 && mStruct!=='BULLISH') ? 'SHORT' : 'HOLD';
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
    volumeLevel,                       
    narrative,
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

// ================== AUTOTRADE (SENİN GÖNDERDİĞİN) ==================
const AutoTrade = {
  async getCurrentPrice(symbol){ /* ... logic ... */ return 0; },
  async getPositions(){ /* ... logic ... */ return []; },
  async placeOrder(symbol, side, amount, price, orderType){ /* ... logic ... */ return null; },
  async placeTPSL(symbol, side, amount, tp, sl){ /* ... logic ... */ },
  async execute(signal, isManual=false){ /* ... logic ... */ },
  async closePosition(symbol, side, contracts){ /* ... logic ... */ return { success:false, error: 'Hata' }; }
};

// ================== SCANNER (SENİN GÖNDERDİĞİN) ==================
async function refreshMarkets(){
  // ... senin refreshMarkets logic ...
  try{
    await requestQueue.push(()=> exchangeAdapter.raw.loadMarkets(true));
    const tickers = await requestQueue.push(()=> exchangeAdapter.raw.fetchTickers());
    const all = Object.keys(exchangeAdapter.raw.markets).filter(s=>{
      const m = exchangeAdapter.raw.markets[s];
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
  }catch(e){console.error("Market refresh hatası:", e.message)}
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

// ================== API (SENİN GÖNDERDİĞİN) ==================
app.get('/api/status', async (req,res)=>{
  const positions = await AutoTrade.getPositions();
  const signals = Array.from(signalCache.values()).sort((a,b)=> b.timestamp-a.timestamp);
  res.json({ config: CONFIG, system: systemStatus, positions, signals });
});
app.post('/api/config/update', (req,res)=>{
  const allowed = ['minConfidenceForAuto','orderType','leverage','marginPercent','riskProfile','scalpMode','autotradeMaster'];
  for (const k of allowed){ if (req.body[k]!==undefined) CONFIG[k]=req.body[k]; }
  if (req.body.strategies) CONFIG.strategies = { ...CONFIG.strategies, ...req.body.strategies };
  res.json({ success:true, config: CONFIG });
});
app.post('/api/trade/manual', async (req,res)=>{
  await AutoTrade.execute(req.body, true);
  res.json({ success:true });
});
app.post('/api/position/close', async (req,res)=>{
  const { symbol, side, contracts } = req.body;
  const r = await AutoTrade.closePosition(symbol, side, contracts);
  res.json(r);
});

// --- YENİ EKLENEN: OTOMATİK ADMİN OLUŞTURMA ---
async function createDefaultUser() {
    const email = "admin@alphason.com";
    const password = "123"; 
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
        if (!row) {
            const sql = `INSERT INTO users (email, password, plan, api_key, api_secret, api_passphrase) VALUES (?, ?, ?, ?, ?, ?)`;
            db.run(sql, [email, hashedPassword, 'elite', '', '', ''], (err) => {
                if (!err) console.log(`>>> Varsayılan kullanıcı oluşturuldu: ${email} / Şifre: ${password}`);
            });
        }
    });
}
// ================== START ==================
async function start(){
  exchangeAdapter = { raw: new ccxt.bitget({
    apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
    options: { defaultType: 'swap' }, timeout: 30000, enableRateLimit: true
  })};
  
  await createDefaultUser(); // Admini başlat

  if (CONFIG.isApiConfigured){
    try{
      const b = await exchangeAdapter.raw.fetchBalance();
      systemStatus.balance = parseFloat(b.USDT?.free || 0);
    }catch(e){}
  }
  await refreshMarkets();
  setInterval(()=> scanLoop(), CONFIG.focusedScanIntervalMs);
}

// Sunucuyu başlatmadan önce DB şemasını çalıştır
const schema = fs.readFileSync('./schema.sql', 'utf8');
db.exec(schema, (err) => {
    if (err) console.error("Tablo hatası:", err);
    else {
        console.log("Tablolar hazır.");
        server.listen(PORT, ()=>{ 
          console.log(`Server on ${PORT}`); 
          start(); 
        });
    }
});
