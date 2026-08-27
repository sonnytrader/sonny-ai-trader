const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const BITGET_REST_URL = 'https://api.bitget.com';

// ---------------------------------------------------------------
// STATE & HUNİ BELLEĞİ
// ---------------------------------------------------------------
let allMarketSymbols = [];    // 500+ Coin Havuzu
let candidateList = [];       // 150 Aday Coin
let activeSignals = new Map(); // Aktif Sinyaller
let cooldownMap = new Map();   // Spam Engeli

// ---------------------------------------------------------------
// YARDIMCI HESAPLAMA FONKSİYONLARI
// ---------------------------------------------------------------
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function findSwingHighLow(candles) {
  let highest = -Infinity;
  let lowest = Infinity;
  candles.forEach(c => {
    if (c.high > highest) highest = c.high;
    if (c.low < lowest) lowest = c.low;
  });
  return { highest, lowest };
}

// ---------------------------------------------------------------
// ADIM 1: 500 COIN TARAMA (24H Hacim & Momentum Filtresi)
// ---------------------------------------------------------------
async function fetchTopBitgetFutures() {
  try {
    const res = await axios.get(`${BITGET_REST_URL}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
    if (res.data && res.data.data) {
      const markets = res.data.data
        .filter(m => m.symbol.endsWith('USDT'))
        .map(m => ({
          symbol: m.symbol,
          volume24h: parseFloat(m.usdtVolume || 0),
          lastPrice: parseFloat(m.lastPr),
          priceChangePercent: parseFloat(m.change24h || 0) * 100
        }))
        .filter(m => m.volume24h >= 1500000); 

      allMarketSymbols = markets;

      candidateList = markets
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, 150)
        .map(m => m.symbol);
    }
  } catch (err) {
    console.error('[HUNİ AŞAMA 1 HATA]:', err.message);
  }
}

async function fetchCandles(symbol, granularity, limit = 40) {
  try {
    const res = await axios.get(`${BITGET_REST_URL}/api/v2/mix/market/candles`, {
      params: { symbol: symbol, productType: 'USDT-FUTURES', granularity: granularity, limit: limit }
    });
    if (res.data && res.data.data) {
      return res.data.data.map(c => ({
        time: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
      })).reverse(); 
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------
// ADIM 2 & 3: SCALP SİNYALİ ÜRETME ENGINE
// ---------------------------------------------------------------
async function processScalpEngine() {
  if (candidateList.length === 0) return;

  const batch = candidateList.slice(0, 35);

  for (const symbol of batch) {
    if (cooldownMap.has(symbol) && Date.now() - cooldownMap.get(symbol) < 15 * 60 * 1000) {
      continue;
    }

    const candles1H = await fetchCandles(symbol, '1H', 30);
    const candles15M = await fetchCandles(symbol, '15m', 30);
    const candles3M = await fetchCandles(symbol, '3m', 30);

    if (!candles1H || !candles15M || !candles3M || candles3M.length < 20) continue;

    const currentPrice = candles3M[candles3M.length - 1].close;
    const closes1H = candles1H.map(c => c.close);
    const is1HTrendLong = calculateEMA(closes1H, 20) > calculateEMA(closes1H, 50);

    const swing15M = findSwingHighLow(candles15M.slice(-15));
    const resistance15M = swing15M.highest;
    const support15M = swing15M.lowest;

    const last3M = candles3M[candles3M.length - 1];
    const prev3M = candles3M[candles3M.length - 2];
    const swing3M = findSwingHighLow(candles3M.slice(-10));

    const rsi3M = calculateRSI(candles3M.map(c => c.close), 14);
    const avgVolume3M = candles3M.slice(-10, -1).reduce((acc, c) => acc + c.volume, 0) / 9;
    const isVolumeSpike = last3M.volume > avgVolume3M * 1.5;

    let signalType = null;
    let entryMin = 0, entryMax = 0, stopLoss = 0, tp1 = 0, tp2 = 0, score = 70;

    if (is1HTrendLong && prev3M.close > resistance15M * 0.998 && currentPrice <= resistance15M * 1.002) {
      signalType = 'LONG';
      entryMin = (resistance15M * 0.9995).toFixed(4);
      entryMax = (resistance15M * 1.0025).toFixed(4);
      stopLoss = (swing3M.lowest * 0.9985).toFixed(4); 

      const riskRatio = parseFloat(entryMax) - parseFloat(stopLoss);
      if (riskRatio > 0) {
        tp1 = (parseFloat(entryMax) + riskRatio * 1.1).toFixed(4);
        tp2 = (parseFloat(entryMax) + riskRatio * 2.1).toFixed(4);
        if (isVolumeSpike) score += 15;
        if (rsi3M > 50 && rsi3M < 70) score += 10;
      } else signalType = null;
    }
    else if (!is1HTrendLong && prev3M.close < support15M * 1.002 && currentPrice >= support15M * 0.998) {
      signalType = 'SHORT';
      entryMin = (support15M * 0.9975).toFixed(4);
      entryMax = (support15M * 1.0005).toFixed(4);
      stopLoss = (swing3M.highest * 1.0015).toFixed(4); 

      const riskRatio = parseFloat(stopLoss) - parseFloat(entryMin);
      if (riskRatio > 0) {
        tp1 = (parseFloat(entryMin) - riskRatio * 1.1).toFixed(4);
        tp2 = (parseFloat(entryMin) - riskRatio * 2.1).toFixed(4);
        if (isVolumeSpike) score += 15;
        if (rsi3M < 50 && rsi3M > 30) score += 10;
      } else signalType = null;
    }

    if (signalType && score >= 75) {
      activeSignals.set(symbol, {
        symbol, type: signalType, score: Math.min(score, 98),
        entryZone: `${entryMin} - ${entryMax}`, currentPrice, stopLoss, tp1, tp2,
        status: 'ACTIVE', timestamp: Date.now(), ttlMinutes: 15
      });
      cooldownMap.set(symbol, Date.now());
      broadcastState();
    }
  }
}

function monitorActiveSignals() {
  const now = Date.now();
  for (const [symbol, signal] of activeSignals.entries()) {
    if (now - signal.timestamp > signal.ttlMinutes * 60 * 1000) {
      signal.status = 'MISSED (EXPIRED)';
      broadcastState();
      setTimeout(() => activeSignals.delete(symbol), 3000);
    }
  }
}

function getSystemPayload() {
  return JSON.stringify({
    stats: { scanned: allMarketSymbols.length, candidates: candidateList.length, activeSignalsCount: activeSignals.size },
    signals: Array.from(activeSignals.values())
  });
}

function broadcastState() {
  const payload = getSystemPayload();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

setInterval(fetchTopBitgetFutures, 60000);  
setInterval(processScalpEngine, 10000);     
setInterval(monitorActiveSignals, 5000);    

fetchTopBitgetFutures();

// API Endpoint (Yedek REST uç noktası)
app.get('/api/signals', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(getSystemPayload());
});

// ---------------------------------------------------------------
// GÖMÜLÜ HTML DASHBOARD (RENDER SSL & WEBSOCKET UYUMLU)
// ---------------------------------------------------------------
const dashboardHTML = `
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SONNY AI V5 — SCALP ENGINE</title>
  <style>
    body { background-color: #0b0e14; color: #e1e6ed; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 15px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e2638; padding-bottom: 10px; margin-bottom: 15px; }
    .title { font-size: 1.2rem; font-weight: bold; color: #00f2fe; }
    .stats { font-size: 0.85rem; color: #8a99ad; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
    .card { background: #131a29; border-radius: 8px; padding: 15px; border-left: 5px solid #334155; position: relative; }
    .card.LONG { border-left-color: #10b981; }
    .card.SHORT { border-left-color: #ef4444; }
    .badge { position: absolute; top: 15px; right: 15px; font-weight: bold; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; }
    .LONG .badge { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .SHORT .badge { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .symbol { font-size: 1.1rem; font-weight: bold; margin-bottom: 8px; }
    .data-row { display: flex; justify-content: space-between; margin: 4px 0; font-size: 0.9rem; }
    .label { color: #64748b; }
    .val { font-weight: 600; }
    .score-bar { height: 4px; background: #1e293b; margin-top: 10px; border-radius: 2px; overflow: hidden; }
    .score-fill { height: 100%; background: #00f2fe; width: 0%; }
    .empty-state { text-align: center; color: #64748b; margin-top: 50px; grid-column: 1/-1; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">⚡ SONNY AI V5 SCALP ENGINE</div>
    <div class="stats" id="stats">Tarama Başlatılıyor...</div>
  </div>
  <div class="grid" id="signalContainer">
    <div class="empty-state">Sinyaller ve piyasa verisi taranıyor...</div>
  </div>

  <script>
    function updateUI(data) {
      document.getElementById('stats').innerText = \`\${data.stats.scanned} Tarandı • \${data.stats.candidates} Aday • \${data.stats.activeSignalsCount} Aktif Sinyal\`;
      const container = document.getElementById('signalContainer');
      
      if (!data.signals || data.signals.length === 0) {
        container.innerHTML = '<div class="empty-state">Şu anda kriterlere uygun aktif scalp sinyali yok. Radar talamaya devam ediyor...</div>';
        return;
      }

      container.innerHTML = '';
      data.signals.forEach(sig => {
        const card = document.createElement('div');
        card.className = \`card \${sig.type}\`;
        card.innerHTML = \`
          <div class="badge">\${sig.status} • SKOR \${sig.score}</div>
          <div class="symbol">\${sig.symbol} <span style="font-size:0.8rem; color:#64748b;">\${sig.type}</span></div>
          <div class="data-row"><span class="label">Giriş Bölgesi:</span><span class="val">\${sig.entryZone}</span></div>
          <div class="data-row"><span class="label">Stop (Dar Swing):</span><span class="val" style="color:#ef4444">\${sig.stopLoss}</span></div>
          <div class="data-row"><span class="label">TP1 (Scalp %50):</span><span class="val" style="color:#10b981">\${sig.tp1}</span></div>
          <div class="data-row"><span class="label">TP2 (Scalp %30):</span><span class="val" style="color:#10b981">\${sig.tp2}</span></div>
          <div class="score-bar"><div class="score-fill" style="width: \${sig.score}%"></div></div>
        \`;
        container.appendChild(card);
      });
    }

    // İlk açılışta REST ile veri çek
    fetch('/api/signals').then(r => r.json()).then(data => updateUI(data)).catch(e => console.error(e));

    // WebSocket Bağlantısı (WSS Uyumlu)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = \`\${protocol}//\${window.location.host}\`;
    let ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      updateUI(data);
    };

    ws.onclose = () => {
      // Bağlantı koparsa her 3 sn'de bir REST üzerinden canlı veriyi çekmeye devam et
      setInterval(() => {
        fetch('/api/signals').then(r => r.json()).then(data => updateUI(data)).catch(e => {});
      }, 3000);
    };
  </script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.send(dashboardHTML);
});

server.listen(PORT, () => {
  console.log(`[SONNY AI SCALP V5] Sunucu port ${PORT} üzerinde aktif.`);
});
