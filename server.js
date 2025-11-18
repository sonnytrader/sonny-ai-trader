// server.js
// Sonny AI TRADER — Trend Breakout Edition
// Tek strateji: Trend (EMA20/EMA50, 4h) + Destek/Direnç kırılımı (1h)
// @ts-nocheck

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');
const path = require('path');
const { ATR } = require('technicalindicators');

console.log('=== SERVER BOOT (pid=' + process.pid + ') ===');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ====================== CONFIG ======================
let CONFIG = {
  tf_primary: '1h',
  tf_trend: '4h',
  lookback: 20,
  minAtrPercent: 0.25,
  minVolumeUSD: 100000,
  scanBatchSize: 8,
  signalScanIntervalMs: 20000,
  debug: true
};

// ====================== EXCHANGE ======================
let exchange = new ccxt.bitget({ enableRateLimit: true });

async function safeFetchOHLCV(symbol, timeframe, limit = 100) {
  try { return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit); }
  catch { return null; }
}

async function fetchTickerSafe(symbol) {
  try { return await exchange.fetchTicker(symbol); }
  catch { return null; }
}

// ====================== STRATEGY ======================
class TrendBreakoutStrategy {
  constructor(config) { this.config = config; }

  calcEMA(values, period) {
    if (!values || values.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  async fetchATRPercent(symbol, timeframe = '1h', period = 14) {
    const ohlcv = await safeFetchOHLCV(symbol, timeframe, period + 30);
    if (!ohlcv || ohlcv.length < period + 5) return null;
    const highs = ohlcv.map(c => c[2]);
    const lows  = ohlcv.map(c => c[3]);
    const closes= ohlcv.map(c => c[4]);
    const atrVals = ATR.calculate({ high: highs, low: lows, close: closes, period });
    if (!atrVals || atrVals.length === 0) return null;
    const currentATR = atrVals.at(-1);
    const lastClose = closes.at(-1);
    return (currentATR / lastClose) * 100;
  }

  async analyzeSymbol(symbol) {
    const primaryOhlcv = await safeFetchOHLCV(symbol, this.config.tf_primary, this.config.lookback + 50);
    const trendOhlcv   = await safeFetchOHLCV(symbol, this.config.tf_trend, 60);
    if (!primaryOhlcv || !trendOhlcv) return null;

    const closesP = primaryOhlcv.map(c => c[4]);
    const highsP  = primaryOhlcv.map(c => c[2]);
    const lowsP   = primaryOhlcv.map(c => c[3]);
    const lastClose = closesP.at(-1);
    const breakoutHigh = Math.max(...highsP.slice(-this.config.lookback));
    const breakoutLow  = Math.min(...lowsP.slice(-this.config.lookback));

    const closesT = trendOhlcv.map(c => c[4]);
    const emaFastTrend = this.calcEMA(closesT, 20);
    const emaSlowTrend = this.calcEMA(closesT, 50);
    const trendUp = emaFastTrend > emaSlowTrend;
    const trendDown = emaFastTrend < emaSlowTrend;

    const atr = await this.fetchATRPercent(symbol, this.config.tf_primary, 14);
    if (!atr || atr < this.config.minAtrPercent) return null;

    const t = await fetchTickerSafe(symbol);
    const vol = Number(t?.quoteVolume || 0);
    if (vol < this.config.minVolumeUSD) return null;

    let signal = null, reason = '', breakoutPrice = null;
    if (lastClose > breakoutHigh && trendUp) {
      signal = 'LONG'; reason = 'Direnç kırıldı, trend yukarı'; breakoutPrice = breakoutHigh;
    } else if (lastClose < breakoutLow && trendDown) {
      signal = 'SHORT'; reason = 'Destek kırıldı, trend aşağı'; breakoutPrice = breakoutLow;
    }
    if (!signal) return null;

    return {
      symbol,
      signal,
      reason,
      breakoutPrice: breakoutPrice.toFixed(2),
      entryPrice: lastClose.toFixed(2),
      confidence: 85
    };
  }
}

const strategy = new TrendBreakoutStrategy(CONFIG);

// ====================== WS BROADCAST ======================
function broadcastTrendSignals(signals) {
  const msg = JSON.stringify({ type: 'trend_signals', data: signals });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ====================== LOOP ======================
async function runTrendScan() {
  try {
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets).filter(s => s.endsWith('/USDT')).slice(0, 30);
    const found = [];
    for (const sym of symbols) {
      const sig = await strategy.analyzeSymbol(sym);
      if (sig) found.push(sig);
    }
    if (found.length) broadcastTrendSignals(found);
  } catch (e) { console.error('Scan error', e.message); }
}

setInterval(runTrendScan, CONFIG.signalScanIntervalMs);

// ====================== API ======================
app.get('/api/metrics', (req, res) => res.json({ system: 'Trend Breakout', signals: Object.keys(exchange.markets || {}).length }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));

// ====================== START ======================
server.listen(PORT, () => {
  console.log('📡 Listening on port ' + PORT);
  runTrendScan();
});
