// server.js
// Alphason Trader — SaaS feel + Strategies (Breakout, TrendFollow, PumpDump)
// Signals enriched: strategy, volumeLevel, narrative, perf. Render-ready.

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { EMA, RSI, ADX, ATR, OBV } = require('technicalindicators');

// Modüler dosyaları dahil et
const db = require('./database'); 
const authRoutes = require('./routes/auth'); 

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ROTALAR ---
app.use('/api', authRoutes);

// ================== CONFIG ==================
let CONFIG = {
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  isApiConfigured: !!(process.env.BITGET_API_KEY && process.env.BITGET_SECRET),
  // ... senin diğer config ayarların ...
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
  isHealthy: true, filterCount: 0, balance: 0, marketSentiment: 'Analiz ediliyor…',
  performance: { totalSignals: 0, executedTrades: 0, winRate: 0, lastReset: Date.now() }
};

// ... H, perfTracker, requestQueue ve Analiz fonksiyonları buraya geliyor (Değişmedi) ...
const perfTracker = { history: [], avgGain(days = 7, strategy, direction) { return { value: null, count: 0 }; }, recordTradeResult(coin, strategy, direction, gainPct){ this.history.push({ ts: Date.now(), coin, strategy, direction, gainPct }); const last30 = this.history.slice(-100); const wins = last30.filter(x=> x.gainPct > 0).length; systemStatus.performance.winRate = last30.length ? wins / last30.length : 0; } };
const requestQueue = { queue: [], running: 0, concurrency: 8, push(fn) { return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.next(); }); }, async next() { if (this.running >= this.concurrency || this.queue.length === 0) return; const item = this.queue.shift(); this.running++; try { item.resolve(await item.fn()); } catch (e) { item.reject(e); } finally { this.running--; this.next(); } } };
const H = { async delay(ms){ return new Promise(r=>setTimeout(r,ms)); }, round(price){ if (!price || isNaN(price)) return 0; if (price < 0.00001) return Number(price.toFixed(8)); if (price < 0.001) return Number(price.toFixed(7)); if (price < 1) return Number(price.toFixed(5)); if (price < 10) return Number(price.toFixed(4)); return Number(price.toFixed(2)); }, async fetchOHLCV(symbol, timeframe, limit=150){ const key = `${symbol}_${timeframe}`; const cached = ohlcvCache.get(key); if (cached && (Date.now()-cached.ts < 120000)) return cached.data; try{ const data = await requestQueue.push(()=> exchangeAdapter.raw.fetchOHLCV(symbol, timeframe, undefined, limit)); if (data?.length) ohlcvCache.set(key, { data, ts: Date.now() }); return data; }catch(e){ return null; } }, async fetchMulti(symbol){ const res = {}; for(const tf of CONFIG.timeframes){ res[tf] = await this.fetchOHLCV(symbol, tf, 150); } return res; }, simpleSnR(ohlcv15m){ return { support:0, resistance:0, quality:0 }; }, volRatio(vols, period=20){ return 1; }, marketStructure(ohlcv1h){ return "RANGING"; }, tvLink(symbol){ const base = symbol.replace(':USDT','').replace('/USDT','USDT'); return `https://www.tradingview.com/chart/?symbol=BITGET:${base}`; } };
async function confirmBreakoutVolume(symbol){ return {confirmed:false,strength:'low',ratio:0}; }
async function analyzeSymbol(symbol){ /* ... senin uzun analiz mantığın ... */ return null; }
const AutoTrade = { async getCurrentPrice(symbol){ return 0; }, async getPositions(){ return []; }, async placeOrder(symbol, side, amount, price, orderType){ return null; }, async placeTPSL(symbol, side, amount, tp, sl){ }, async execute(signal, isManual=false){ }, async closePosition(symbol, side, contracts){ return { success:false, error: 'Hata' }; } };
async function refreshMarkets(){ /* ... senin market yenileme mantığın ... */ return; }
async function scanLoop(){ /* ... senin tarama mantığın ... */ return; }
function cleanupSignalCache(){ /* ... senin cache temizleme mantığın ... */ }
setInterval(cleanupSignalCache, 5*60*1000);
function broadcastSignalList(){ /* ... senin broadcast mantığın ... */ }


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

// --- DÜZELTİLDİ: OTOMATİK ADMİN OLUŞTURMA (Promise Eklendi) ---
async function createDefaultUser() {
    const email = "admin@alphason.com";
    const password = "123"; 
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // İşlemi Promise içine alarak sonucun beklenmesini sağlıyoruz.
    return new Promise((resolve, reject) => {
        // 1. Kullanıcıyı bulmaya çalış
        db.get("SELECT * FROM users WHERE email = ?", [email], (err, row) => {
            if (err) {
                console.error("Admin kontrol DB hatası:", err.message);
                return reject(err);
            }

            if (!row) {
                // 2. Kullanıcı yoksa ekle
                const sql = `INSERT INTO users (email, password, plan, api_key, api_secret, api_passphrase) VALUES (?, ?, ?, ?, ?, ?)`;
                db.run(sql, [email, hashedPassword, 'elite', '', '', ''], function(err) {
                    if (err) {
                        console.error("Admin oluşturma hatası:", err.message);
                        return reject(err);
                    }
                    console.log(`>>> Varsayılan kullanıcı oluşturuldu: ${email} / Şifre: ${password}`);
                    resolve(); // İşlem bitti, devam et.
                });
            } else {
                console.log(`>>> Varsayılan kullanıcı (${email}) zaten mevcut.`);
                resolve(); // Kullanıcı zaten var, devam et.
            }
        });
    });
}
// ================== START ==================
async function start(){
  exchangeAdapter = { raw: new ccxt.bitget({
    apiKey: CONFIG.apiKey, secret: CONFIG.secret, password: CONFIG.password,
    options: { defaultType: 'swap' }, timeout: 30000, enableRateLimit: true
  })};
  
  // BURADA BEKLEME GARANTİLENDİ.
  await createDefaultUser(); 

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
