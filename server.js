const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const BITGET_REST_URL = 'https://api.bitget.com';

// ---------------------------------------------------------------
// STATE & HUNİ BELLEĞİ
// ---------------------------------------------------------------
let allMarketSymbols = [];    // 500+ Coin Havuzu
let candidateList = [];       // 150 Aday Coin
let activeWatchlist = [];      // 20-40 Yakın Takipteki Coin
let activeSignals = new Map(); // Aktif Sinyaller (coin -> signal)
let cooldownMap = new Map();    // Spam Engeli (coin -> timestamp)

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
  // candles: [{high, low, close}, ...] son N mum
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
        .filter(m => m.volume24h >= 2000000); // Min $2M Hacim filtresi

      allMarketSymbols = markets;

      // 500 -> 150 Elemesi: En yüksek hacimli ve 15M momentuma uygun 150 coini süz
      candidateList = markets
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, 150)
        .map(m => m.symbol);
    }
  } catch (err) {
    console.error('[HUNİ AŞAMA 1 HATA]:', err.message);
  }
}

// Bitget Klines Veri Çekici
async function fetchCandles(symbol, granularity, limit = 50) {
  try {
    // granularity: 1m, 3m, 15m, 1H
    const res = await axios.get(`${BITGET_REST_URL}/api/v2/mix/market/candles`, {
      params: {
        symbol: symbol,
        productType: 'USDT-FUTURES',
        granularity: granularity,
        limit: limit
      }
    });
    if (res.data && res.data.data) {
      // Bitget format: [timestamp, open, high, low, close, volume, ...]
      return res.data.data.map(c => ({
        time: parseInt(c[0]),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5])
      })).reverse(); // Kronolojik sırala (eski -> yeni)
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------
// ADIM 2 & 3: ADAYLARDAN 3M/1M SCALP SİNYALİ ÜRETME ENGINE
// ---------------------------------------------------------------
async function processScalpEngine() {
  if (candidateList.length === 0) return;

  // 150 Aday arasından rastgele 30'lu gruplar halinde hızlı analiz yap (API limit aşmamak için)
  const batch = candidateList.slice(0, 35);

  for (const symbol of batch) {
    // Cooldown kontrolü (Aynı coine 15 dk içinde tekrar sinyal üretme)
    if (cooldownMap.has(symbol) && Date.now() - cooldownMap.get(symbol) < 15 * 60 * 1000) {
      continue;
    }

    const candles1H = await fetchCandles(symbol, '1H', 30);
    const candles15M = await fetchCandles(symbol, '15m', 30);
    const candles3M = await fetchCandles(symbol, '3m', 30);

    if (!candles1H || !candles15M || !candles3M || candles3M.length < 20) continue;

    const currentPrice = candles3M[candles3M.length - 1].close;

    // 1H Trend Filtresi (EMA 20 vs EMA 50)
    const closes1H = candles1H.map(c => c.close);
    const ema20_1H = calculateEMA(closes1H, 20);
    const ema50_1H = calculateEMA(closes1H, 50);
    const is1HTrendLong = ema20_1H > ema50_1H;

    // 15M Destek/Direnç Seviyesi (Pivot High/Low)
    const swing15M = findSwingHighLow(candles15M.slice(-15));
    const resistance15M = swing15M.highest;
    const support15M = swing15M.lowest;

    // 3M Breakout & Retest Kontrolü
    const last3M = candles3M[candles3M.length - 1];
    const prev3M = candles3M[candles3M.length - 2];
    const swing3M = findSwingHighLow(candles3M.slice(-10));

    // RSI & Volume Check
    const rsi3M = calculateRSI(candles3M.map(c => c.close), 14);
    const avgVolume3M = candles3M.slice(-10, -1).reduce((acc, c) => acc + c.volume, 0) / 9;
    const isVolumeSpike = last3M.volume > avgVolume3M * 1.8;

    let signalType = null;
    let entryMin = 0, entryMax = 0, stopLoss = 0, tp1 = 0, tp2 = 0;
    let score = 70;

    // LONG KURULUMU: 1H Trend Up + 15M/3M Direnç Kırılımı + Retest
    if (is1HTrendLong && prev3M.close > resistance15M * 0.998 && currentPrice <= resistance15M * 1.002) {
      signalType = 'LONG';
      entryMin = (resistance15M * 0.9995).toFixed(4);
      entryMax = (resistance15M * 1.0025).toFixed(4);
      stopLoss = (swing3M.lowest * 0.9985).toFixed(4); // Dar Swing Low Stop

      const riskRatio = parseFloat(entryMax) - parseFloat(stopLoss);
      if (riskRatio <= 0) continue;

      tp1 = (parseFloat(entryMax) + riskRatio * 1.1).toFixed(4);
      tp2 = (parseFloat(entryMax) + riskRatio * 2.1).toFixed(4);

      if (isVolumeSpike) score += 15;
      if (rsi3M > 50 && rsi3M < 70) score += 10;
    }
    // SHORT KURULUMU: 1H Trend Down + 15M/3M Destek Kırılımı + Retest
    else if (!is1HTrendLong && prev3M.close < support15M * 1.002 && currentPrice >= support15M * 0.998) {
      signalType = 'SHORT';
      entryMin = (support15M * 0.9975).toFixed(4);
      entryMax = (support15M * 1.0005).toFixed(4);
      stopLoss = (swing3M.highest * 1.0015).toFixed(4); // Dar Swing High Stop

      const riskRatio = parseFloat(stopLoss) - parseFloat(entryMin);
      if (riskRatio <= 0) continue;

      tp1 = (parseFloat(entryMin) - riskRatio * 1.1).toFixed(4);
      tp2 = (parseFloat(entryMin) - riskRatio * 2.1).toFixed(4);

      if (isVolumeSpike) score += 15;
      if (rsi3M < 50 && rsi3M > 30) score += 10;
    }

    // Sinyal Yayınlama (Skor ≥ 78 ise kabul et)
    if (signalType && score >= 78) {
      const signalPayload = {
        symbol: symbol,
        type: signalType,
        score: Math.min(score, 98),
        entryZone: `${entryMin} - ${entryMax}`,
        currentPrice: currentPrice,
        stopLoss: stopLoss,
        tp1: tp1,
        tp2: tp2,
        timeframe: '3M / 15M SCALP',
        status: 'ACTIVE',
        timestamp: Date.now(),
        ttlMinutes: 15
      };

      activeSignals.set(symbol, signalPayload);
      cooldownMap.set(symbol, Date.now());
      broadcastState();
    }
  }
}

// ---------------------------------------------------------------
// AKTİF SİNYAL DURUMU & GEÇERSİZLEŞTİRME (INVALIDATION/MISSED)
// ---------------------------------------------------------------
function monitorActiveSignals() {
  const now = Date.now();
  for (const [symbol, signal] of activeSignals.entries()) {
    // Zaman aşımı (15 dakikada işleme girmediyse kaldır)
    if (now - signal.timestamp > signal.ttlMinutes * 60 * 1000) {
      signal.status = 'MISSED (EXPIRED)';
      broadcastState();
      setTimeout(() => activeSignals.delete(symbol), 3000);
    }
  }
}

// Broadcast WebSocket
function broadcastState() {
  const payload = JSON.stringify({
    stats: {
      scanned: allMarketSymbols.length,
      candidates: candidateList.length,
      activeSignalsCount: activeSignals.size
    },
    signals: Array.from(activeSignals.values())
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ---------------------------------------------------------------
// DÖNGÜLER VE BAŞLATMA
// ---------------------------------------------------------------
setInterval(fetchTopBitgetFutures, 60000);  // Her 60 sn'de bir 500 coini tara
setInterval(processScalpEngine, 10000);     // Her 10 sn'de bir 3M Scalp Engine çalıştır
setInterval(monitorActiveSignals, 5000);    // Her 5 sn'de bir sinyal durumlarını denetle

fetchTopBitgetFutures();

// Express / Dashboard Endpoint
app.use(express.static('public'));
app.get('/api/signals', (req, res) => {
  res.json({
    stats: { scanned: allMarketSymbols.length, candidates: candidateList.length },
    signals: Array.from(activeSignals.values())
  });
});

server.listen(PORT, () => {
  console.log(`[SONNY AI SCALP V5] Sunucu http://localhost:${PORT} üzerinde aktif.`);
});
