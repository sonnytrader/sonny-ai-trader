'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';

const CFG = {
  REFRESH_MS: 60000,
  MARKET_LIMIT: 100,
  ANALYZE_LIMIT: 70,
  MIN_VOLUME: 3000000,
  LOOKBACK_4H: 30,
  LOOKBACK_2H: 30,
  FOUR_H_LIMIT: 100,
  TWO_H_LIMIT: 100,
  M15_LIMIT: 150,
  RETEST_PERCENT: 0.80,
  RSI_PERIOD: 14,
  LONG_RSI_MIN: 48,
  LONG_RSI_MAX: 68,
  SHORT_RSI_MIN: 32,
  SHORT_RSI_MAX: 52,
  MIN_SIGNAL_SCORE: 75,
  MAX_SIGNALS: 8,
  MAX_PREPARING: 8,
  BATCH: 8,
  DELAY: 100
};

let market = [];
let resultCache = null;
let scanning = false;
let lastScan = null;
let lastError = null;

// WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function log(x) {
  console.log('[' + new Date().toISOString() + '] ' + x);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function n(v, d = 6) {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : 0;
}

function percent(v, base) {
  return base ? (v / base) * 100 : 0;
}

// ========================= BITGET API =========================
async function api(path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error('Bitget HTTP ' + r.status);
  const j = JSON.parse(text);
  if (j.code !== '00000') throw new Error('Bitget ' + j.code);
  return j.data;
}

// ========================= CANDLE PARSER =========================
function candles(data) {
  if (!Array.isArray(data)) return [];
  return data.map(x => ({
    time: +x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5]
  })).filter(x => Number.isFinite(x.close)).sort((a, b) => a.time - b.time);
}

// ========================= RSI =========================
function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change; else loss -= change;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ========================= MARKET DISCOVERY =========================
async function discover() {
  const [contracts, tickers] = await Promise.all([
    api('/api/v2/mix/market/contracts', { productType: PRODUCT }),
    api('/api/v2/mix/market/tickers', { productType: PRODUCT })
  ]);
  const valid = new Set(
    contracts.filter(c => c.symbolType === 'perpetual' && c.symbolStatus === 'normal' && c.quoteCoin === 'USDT').map(c => c.symbol)
  );
  market = tickers.filter(t => valid.has(t.symbol)).map(t => {
    const ch = +t.change24h || 0;
    return {
      symbol: t.symbol,
      price: +t.lastPr,
      volume24h: +t.quoteVolume || 0,
      change24h: Math.abs(ch) <= 1 ? ch * 100 : ch
    };
  }).filter(x => x.volume24h >= CFG.MIN_VOLUME).sort((a, b) => b.volume24h - a.volume24h).slice(0, CFG.MARKET_LIMIT);
  log('Discovery: ' + market.length + ' coin');
}

// ========================= CANDLES =========================
async function getCandles(symbol, tf, limit) {
  return candles(await api('/api/v2/mix/market/candles', { symbol, productType: PRODUCT, granularity: tf, limit }));
}

// ========================= BREAKOUT INFO =========================
function breakoutInfo(c, lookback) {
  if (c.length < lookback + 5) return null;
  const closed = c.slice(0, -1);
  const recent = Math.min(8, closed.length - lookback);
  let longBreak = false, shortBreak = false, longLevel = null, shortLevel = null;
  for (let i = closed.length - recent; i < closed.length; i++) {
    const history = closed.slice(i - lookback, i);
    if (history.length < lookback) continue;
    const resistance = Math.max(...history.map(x => x.high));
    const support = Math.min(...history.map(x => x.low));
    const current = closed[i];
    const previous = closed[i - 1];
    if (current.close > resistance && previous.close <= resistance) { longBreak = true; longLevel = resistance; }
    if (current.close < support && previous.close >= support) { shortBreak = true; shortLevel = support; }
  }
  const last = closed.slice(-lookback);
  return {
    current: closed.at(-1),
    resistance: longLevel || Math.max(...last.map(x => x.high)),
    support: shortLevel || Math.min(...last.map(x => x.low)),
    longBreak, shortBreak, longLevel, shortLevel
  };
}

// ========================= RETEST =========================
function near(price, level) {
  return Math.abs(percent(price - level, level)) <= CFG.RETEST_PERCENT;
}

// ========================= SCORE =========================
function score(breakout4H, breakout2H, retest, rsiOk, rv, direction) {
  let s = 0;
  if (breakout4H) s += 35;
  if (breakout2H) s += 30;
  else if (breakout4H) s += 15;
  if (retest) s += 20;
  if (rsiOk) s += 10;
  if (direction === 'LONG' && rv >= 52 && rv <= 63) s += 5;
  if (direction === 'SHORT' && rv >= 37 && rv <= 48) s += 5;
  return Math.min(100, s);
}

// ========================= PLAN =========================
function plan(m, dir, level, rv, sc, reason) {
  const entryLow = dir === 'LONG' ? level * 0.998 : level * 1.002;
  const entryHigh = dir === 'LONG' ? level * 1.004 : level * 0.996;
  const stop = dir === 'LONG' ? level * 0.982 : level * 1.018;
  const risk = Math.abs(level - stop);
  const tp1 = dir === 'LONG' ? level + risk * 1.5 : level - risk * 1.5;
  const tp2 = dir === 'LONG' ? level + risk * 2 : level - risk * 2;
  const tp3 = dir === 'LONG' ? level + risk * 3 : level - risk * 3;
  const rr = risk > 0 ? Math.abs(tp1 - level) / risk : 0;

  return {
    symbol: m.symbol,
    direction: dir,
    strategy: '4H/2H BREAKOUT + RETEST + RSI',
    score: sc,
    price: n(m.price, 8),
    entry: n(level, 8),
    entryLow: n(entryLow, 8),
    entryHigh: n(entryHigh, 8),
    stop: n(stop, 8),
    tp1: n(tp1, 8),
    tp2: n(tp2, 8),
    tp3: n(tp3, 8),
    rr: Number(rr.toFixed(2)),
    rsi: n(rv, 1),
    level: n(level, 8),
    change24h: n(m.change24h, 2),
    volume24h: m.volume24h,
    volumeFormatted: m.volume24h >= 1000000000 ? (m.volume24h / 1000000000).toFixed(2) + 'B' : m.volume24h >= 1000000 ? (m.volume24h / 1000000).toFixed(1) + 'M' : (m.volume24h / 1000).toFixed(1) + 'K',
    reason,
    tradingView: 'https://www.tradingview.com/chart/?symbol=BITGET:' + m.symbol,
    status: 'GİRİŞ BEKLENİYOR',
    paperEntry: null,
    entryTime: null,
    signalAt: Date.now()
  };
}

// ========================= MAKE SIGNAL =========================
function makeSignal(m, h4, h2, m15) {
  const rv = rsi(m15.slice(0, -1).map(x => x.close), CFG.RSI_PERIOD);
  if (rv === null) return null;
  const price = m.price;
  const h2Price = h2.current.close;

  if (h4.longBreak || h2.longBreak) {
    const level = h4.longBreak ? (h4.longLevel || h4.resistance) : (h2.longLevel || h2.resistance);
    const h4ok = h4.longBreak || price >= h4.resistance * 0.997;
    const h2ok = h2.longBreak || h2Price >= h2.resistance * 0.997;
    const rsiOk = rv >= CFG.LONG_RSI_MIN && rv <= CFG.LONG_RSI_MAX;
    const retest = near(price, level);

    if (h4ok && h2ok && retest && rsiOk) {
      const sc = score(h4.longBreak, h2.longBreak, true, true, rv, 'LONG');
      if (sc >= CFG.MIN_SIGNAL_SCORE) {
        const reason = (h4.longBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' + (h2.longBreak ? '2H onay' : '2H yapı') + ' + retest + RSI';
        return plan(m, 'LONG', level, rv, sc, reason);
      }
    }
  }

  if (h4.shortBreak || h2.shortBreak) {
    const level = h4.shortBreak ? (h4.shortLevel || h4.support) : (h2.shortLevel || h2.support);
    const h4ok = h4.shortBreak || price <= h4.support * 1.003;
    const h2ok = h2.shortBreak || h2Price <= h2.support * 1.003;
    const rsiOk = rv >= CFG.SHORT_RSI_MIN && rv <= CFG.SHORT_RSI_MAX;
    const retest = near(price, level);

    if (h4ok && h2ok && retest && rsiOk) {
      const sc = score(h4.shortBreak, h2.shortBreak, true, true, rv, 'SHORT');
      if (sc >= CFG.MIN_SIGNAL_SCORE) {
        const reason = (h4.shortBreak ? '4H kırılımı' : '2H kırılımı') + ' + ' + (h2.shortBreak ? '2H onay' : '2H yapı') + ' + retest + RSI';
        return plan(m, 'SHORT', level, rv, sc, reason);
      }
    }
  }

  return null;
}

// ========================= PREPARING =========================
function preparing(m, h4, h2, m15) {
  const rv = rsi(m15.slice(0, -1).map(x => x.close), CFG.RSI_PERIOD);
  if (rv === null) return null;
  const price = m.price;
  const longDistance = percent(h4.resistance - price, price);
  const shortDistance = percent(price - h4.support, price);

  if (longDistance >= 0 && longDistance <= 1 && percent(h2.resistance - price, price) <= 1.5 && rv >= 45 && rv <= 70) {
    return { symbol: m.symbol, direction: 'LONG', price: n(price, 8), trigger: n(h4.resistance, 8), distance: n(longDistance, 3), rsi: n(rv, 1) };
  }
  if (shortDistance >= 0 && shortDistance <= 1 && percent(price - h2.support, price) <= 1.5 && rv >= 30 && rv <= 55) {
    return { symbol: m.symbol, direction: 'SHORT', price: n(price, 8), trigger: n(h4.support, 8), distance: n(shortDistance, 3), rsi: n(rv, 1) };
  }
  return null;
}

// ========================= ANALYZE =========================
async function analyze(m) {
  try {
    const [c4, c2, c15] = await Promise.all([
      getCandles(m.symbol, '4H', CFG.FOUR_H_LIMIT),
      getCandles(m.symbol, '2H', CFG.TWO_H_LIMIT),
      getCandles(m.symbol, '15m', CFG.M15_LIMIT)
    ]);
    const h4 = breakoutInfo(c4, CFG.LOOKBACK_4H);
    const h2 = breakoutInfo(c2, CFG.LOOKBACK_2H);
    if (!h4 || !h2 || c15.length < 50) return null;

    const signal = makeSignal(m, h4, h2, c15);
    if (signal) return { type: 'SIGNAL', data: signal };

    const p = preparing(m, h4, h2, c15);
    if (p) return { type: 'PREPARING', data: p };
    return null;
  } catch (e) {
    log('Analiz hatası ' + m.symbol + ': ' + e.message);
    return null;
  }
}

// ========================= MARKET DIRECTION =========================
function marketDirection() {
  const btc = market.find(x => x.symbol === 'BTCUSDT');
  const eth = market.find(x => x.symbol === 'ETHUSDT');
  const list = [btc, eth].filter(Boolean);
  if (!list.length) return { direction: 'YATAY', label: 'PİYASA YATAY', reason: 'Veri bekleniyor.' };
  const up = list.filter(x => x.change24h > 1).length;
  const down = list.filter(x => x.change24h < -1).length;
  if (up > down) return { direction: 'LONG', label: 'PİYASA YUKARI', reason: 'BTC/ETH yükseliş ağırlıklı.' };
  if (down > up) return { direction: 'SHORT', label: 'PİYASA AŞAĞI', reason: 'BTC/ETH düşüş ağırlıklı.' };
  return { direction: 'YATAY', label: 'PİYASA YATAY', reason: 'Yön net değil.' };
}

// ========================= RUN RADAR =========================
async function runRadar() {
  if (scanning) return resultCache;
  scanning = true;
  lastError = null;
  const started = Date.now();

  try {
    await discover();
    const candidates = market.slice(0, CFG.ANALYZE_LIMIT);
    const signals = [];
    const prep = [];

    for (let i = 0; i < candidates.length; i += CFG.BATCH) {
      const batch = candidates.slice(i, i + CFG.BATCH);
      const rows = await Promise.all(batch.map(analyze));
      rows.forEach(r => {
        if (!r) return;
        if (r.type === 'SIGNAL') signals.push(r.data);
        if (r.type === 'PREPARING') prep.push(r.data);
      });
      await sleep(CFG.DELAY);
    }

    signals.sort((a, b) => b.score - a.score);
    prep.sort((a, b) => a.distance - b.distance);

    resultCache = {
      success: true,
      system: 'Sonny AI Signal Scanner',
      timestamp: new Date().toISOString(),
      market: marketDirection(),
      stats: {
        market: market.length,
        analyzed: candidates.length,
        signals: Math.min(signals.length, CFG.MAX_SIGNALS),
        preparing: Math.min(prep.length, CFG.MAX_PREPARING),
        seconds: n((Date.now() - started) / 1000, 1)
      },
      signals: signals.slice(0, CFG.MAX_SIGNALS),
      preparing: prep.slice(0, CFG.MAX_PREPARING),
      strategy: '4H / 2H BREAKOUT + RETEST + RSI',
      refresh: '60 SECONDS'
    };

    lastScan = resultCache.timestamp;
    log('RADAR | Market: ' + market.length + ' | Sinyal: ' + resultCache.stats.signals + ' | Hazırlanan: ' + resultCache.stats.preparing);

    // WebSocket broadcast
    broadcast();

    return resultCache;
  } catch (e) {
    lastError = e.message;
    log('RADAR ERROR: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    scanning = false;
  }
}

// ========================= WEBSOCKET =========================
function broadcast() {
  if (!resultCache) return;
  const payload = JSON.stringify({ type: 'snapshot', data: resultCache });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (e) {}
    }
  }
}

wss.on('connection', ws => {
  if (resultCache) {
    try { ws.send(JSON.stringify({ type: 'snapshot', data: resultCache })); } catch (e) {}
  }
});

// ========================= FRONTEND =========================
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sonny AI Signal Scanner</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#080b12;color:#f5f7fb;font-family:Arial,sans-serif;}
.wrap{width:min(1200px,94%);margin:25px auto 50px;}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:10px;}
.title{font-size:24px;font-weight:900;color:#43e58b;}
.sub{color:#7d8799;font-size:12px;margin-top:3px;}
.online{padding:9px 14px;border-radius:20px;background:#0d2118;color:#43e58b;border:1px solid #174d31;font-weight:800;font-size:12px;}
.market{background:#111722;border:1px solid #202b3b;border-radius:15px;padding:18px;margin-bottom:15px;}
.marketLabel{color:#748095;font-size:11px;font-weight:800;}
.marketDir{font-size:24px;font-weight:900;margin-top:5px;}
.marketDir.long{color:#45e58d;}
.marketDir.short{color:#ff647a;}
.muted{color:#7d8799;font-size:11px;margin-top:3px;}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:15px;}
.stat{background:#111722;border:1px solid #202b3b;border-radius:12px;padding:15px;text-align:center;}
.label{color:#748095;font-size:10px;font-weight:800;}
.value{font-size:20px;font-weight:900;margin-top:5px;color:#f5f7fb;}
.panel{background:#111722;border:1px solid #202b3b;border-radius:15px;padding:18px;margin-bottom:15px;}
.panel h2{margin:0 0 6px;font-size:18px;color:#f5f7fb;}
.signal{background:#0c121d;border:1px solid #26354a;border-radius:12px;padding:16px;margin-top:12px;}
.signal.long{border-left:4px solid #45e58d;}
.signal.short{border-left:4px solid #ff647a;}
.top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:5px;}
.coin{font-size:18px;font-weight:900;cursor:pointer;}
.coin.long{color:#45e58d;}
.coin.short{color:#ff647a;}
.score{background:#1c2635;padding:6px 9px;border-radius:7px;font-weight:900;font-size:12px;}
.plan{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px;}
.box{background:#151d2a;border-radius:8px;padding:9px;}
.box b{display:block;color:#68758a;font-size:9px;margin-bottom:3px;}
.box span{font-size:11px;font-weight:bold;}
.reason{margin-top:10px;background:#121a27;padding:10px;border-radius:8px;color:#a8b3c5;font-size:11px;}
.tv{display:inline-block;margin-top:10px;padding:8px 12px;background:#e9edf4;color:#0b1018;border-radius:8px;text-decoration:none;font-size:11px;font-weight:900;}
.prep{display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid #202a39;flex-wrap:wrap;gap:5px;}
.prep:last-child{border:0;}
.prep b{font-size:13px;}
.prep .long{color:#45e58d;}
.prep .short{color:#ff647a;}
.trigger{text-align:right;}
.yellow{color:#e8c55d;font-size:11px;}
.status{margin-top:10px;color:#7e8b9e;font-size:11px;}
@media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr);}.plan{grid-template-columns:repeat(2,1fr);}}
</style>
</head>
<body>
<div class="wrap">
<div class="head">
<div>
<div class="title">🚀 Sonny AI Signal Scanner</div>
<div class="sub">4H / 2H Kırılım · Retest · RSI · Her Dakika Tarama</div>
</div>
<div class="online">● SÜREKLİ AKTİF</div>
</div>

<div class="market">
<div class="marketLabel">GENEL PİYASA DURUMU</div>
<div id="md" class="marketDir">YÜKLENİYOR...</div>
<div id="mr" class="muted">Piyasa analiz ediliyor.</div>
</div>

<div class="stats">
<div class="stat"><div class="label">PİYASA</div><div id="mc" class="value">-</div></div>
<div class="stat"><div class="label">ANALİZ</div><div id="an" class="value">-</div></div>
<div class="stat"><div class="label">SİNYAL</div><div id="sc" class="value">0</div></div>
<div class="stat"><div class="label">SON TARAMA</div><div id="ls" class="value">-</div></div>
</div>

<div class="panel">
<h2>🚨 AKTİF SİNYALLER</h2>
<div class="muted">4H/2H kırılım + retest + RSI şartları oluştuğunda burada görünür.</div>
<div id="signals"><div class="muted" style="margin-top:18px">Tarama yapılıyor...</div></div>
</div>

<div class="panel">
<h2>🟡 HAZIRLANAN FIRSATLAR</h2>
<div class="muted">Kırılıma yaklaşan güçlü coinler burada görünür.</div>
<div id="prep"><div class="muted" style="margin-top:18px">Henüz hazırlanan fırsat yok.</div></div>
</div>

<div class="panel"><div id="status" class="status">Sistem başlatılıyor...</div></div>
</div>

<script>
function price(v){v=Number(v);if(!Number.isFinite(v))return "-";if(v>=100)return v.toFixed(2);if(v>=1)return v.toFixed(4);if(v>=.01)return v.toFixed(6);return v.toFixed(8);}
function tv(s){window.open("https://www.tradingview.com/chart/?symbol=BITGET:"+encodeURIComponent(s),"_blank");}

function render(d){
if(d.market){
var md=document.getElementById("md");
md.textContent=d.market.label;
md.className="marketDir "+(d.market.direction==="LONG"?"long":d.market.direction==="SHORT"?"short":"");
document.getElementById("mr").textContent=d.market.reason;
}
if(d.stats){
document.getElementById("mc").textContent=d.stats.market;
document.getElementById("an").textContent=d.stats.analyzed;
document.getElementById("sc").textContent=d.stats.signals;
}
if(d.timestamp)document.getElementById("ls").textContent=new Date(d.timestamp).toLocaleTimeString("tr-TR");

var s=document.getElementById("signals");
if(!d.signals||!d.signals.length){
s.innerHTML='<div class="muted" style="margin-top:18px">Şu anda güçlü sinyal yok.</div>';
}else{
s.innerHTML=d.signals.map(function(x){
return '<div class="signal '+(x.direction==="LONG"?"long":"short")+'">'+
'<div class="top"><div class="coin '+(x.direction==="LONG"?"long":"short")+'" onclick="tv(\''+x.symbol+'\')">'+x.symbol+' · '+x.direction+'</div>'+
'<div class="score">GÜÇ '+x.score+'/100</div></div>'+
'<div class="muted" style="margin-top:5px">'+x.strategy+' · Fiyat: <b>'+price(x.price)+'</b> · RSI: <b>'+x.rsi+'</b> · Hacim: <b>'+x.volumeFormatted+'</b></div>'+
'<div class="plan">'+
'<div class="box"><b>GİRİŞ</b><span>'+price(x.entryLow)+' - '+price(x.entryHigh)+'</span></div>'+
'<div class="box"><b>STOP</b><span>'+price(x.stop)+'</span></div>'+
'<div class="box"><b>TP1</b><span>'+price(x.tp1)+'</span></div>'+
'<div class="box"><b>TP2</b><span>'+price(x.tp2)+'</span></div>'+
'<div class="box"><b>TP3</b><span>'+price(x.tp3)+'</span></div>'+
'</div>'+
'<div class="reason"><b>Neden?</b> '+x.reason+'</div>'+
'<a class="tv" target="_blank" href="'+x.tradingView+'">📊 TRADINGVIEW AÇ</a>'+
'</div>';
}).join("");
}

var p=document.getElementById("prep");
if(!d.preparing||!d.preparing.length){
p.innerHTML='<div class="muted" style="margin-top:18px">Şu anda hazırlanan güçlü fırsat yok.</div>';
}else{
p.innerHTML=d.preparing.map(function(x){
return '<div class="prep"><div><b class="'+(x.direction==="LONG"?"long":"short")+'" onclick="tv(\''+x.symbol+'\')">'+x.symbol+' · '+x.direction+'</b>'+
'<div class="muted" style="margin-top:3px">Anlık: '+price(x.price)+' · RSI: '+x.rsi+'</div></div>'+
'<div class="trigger"><b>Tetik: '+price(x.trigger)+'</b><div class="yellow">'+x.distance+'% uzakta</div></div></div>';
}).join("");
}
}

async function load(){
try{
document.getElementById("status").textContent="Yeni veriler kontrol ediliyor...";
var r=await fetch("/api/result?_="+Date.now(),{cache:"no-store"});
var d=await r.json();
if(d.result){
render(d.result);
document.getElementById("status").textContent="Sistem aktif. Her dakika tarama yapılıyor.";
}
}catch(e){
document.getElementById("status").textContent="Bağlantı hatası: "+e.message;
}
}

// WebSocket
function connect(){
var proto=location.protocol==='https:'?'wss://':'ws://';
var ws=new WebSocket(proto+location.host);
ws.onmessage=function(e){
try{
var m=JSON.parse(e.data);
if(m.type==='snapshot')render(m.data);
}catch(_){}
};
ws.onclose=function(){setTimeout(connect,5000);};
}
connect();
load();
setInterval(load,10000);
</script>
</body>
</html>`;

// ========================= ROUTES =========================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(HTML);
});

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'healthy', system: 'Sonny AI Signal Scanner' });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    status: scanning ? 'SCANNING' : 'ONLINE',
    strategy: '4H / 2H BREAKOUT + RETEST + RSI',
    refresh: '60 SECONDS',
    lastScan,
    market: market.length,
    error: lastError
  });
});

app.get('/api/scan', async (req, res) => {
  res.json(await runRadar());
});

app.get('/api/result', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!resultCache && !scanning) {
    runRadar().catch(e => log('İlk tarama hatası: ' + e.message));
  }

  if (!resultCache) {
    return res.json({ success: true, scanning: true, result: null });
  }

  try {
    const tickers = await api('/api/v2/mix/market/tickers', { productType: PRODUCT });
    const prices = new Map((Array.isArray(tickers) ? tickers : []).map(x => [x.symbol, +x.lastPr]));

    resultCache.signals = resultCache.signals.map(x =>
      prices.has(x.symbol) ? { ...x, price: n(prices.get(x.symbol), 8) } : x
    );
    resultCache.preparing = resultCache.preparing.map(x =>
      prices.has(x.symbol) ? { ...x, price: n(prices.get(x.symbol), 8) } : x
    );
  } catch (e) {
    log('Fiyat güncelleme hatası: ' + e.message);
  }

  res.json({ success: true, scanning, result: resultCache });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ========================= SERVER START =========================
server.listen(PORT, '0.0.0.0', () => {
  log('Sonny AI Signal Scanner started');
  log('Strategy: 4H / 2H BREAKOUT + RETEST + RSI');
  log('Port: ' + PORT);

  setTimeout(() => { runRadar(); }, 3000);
  setInterval(() => { runRadar(); }, CFG.REFRESH_MS);
});
