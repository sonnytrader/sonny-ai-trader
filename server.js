'use strict';

/*
===========================================================
 SONNY AI TRADER V6.1
 BITGET USDT FUTURES SCALP ENGINE
===========================================================

 500 RADAR
 150 CANDIDATE
 40 DEEP ANALYSIS

 4H + 2H TREND
      ↓
 15M BREAKOUT
      ↓
 RETEST
      ↓
 5M SCALP CONFIRMATION
      ↓
 SIGNAL

 IMPORTANT:
 - Auto trade KAPALI
 - Direct Bitget market API
 - Embedded frontend
 - No public/index.html dependency
 - Responsive/mobile
 - Native Canvas chart
===========================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

const BITGET = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';

/* =========================================================
   CONFIG
========================================================= */

const CFG = {
  RADAR_LIMIT: 500,
  CANDIDATE_LIMIT: 150,
  DEEP_LIMIT: 40,

  SCAN_MS: 60 * 1000,

  MIN_TURNOVER_24H: 750000,
  MIN_MOVE_24H: 1.0,

  RETEST_MINUTES: 90,
  RETEST_CANDLES: 6,

  BREAKOUT_LOOKBACK_15M: 20,

  BREAKOUT_VOLUME_MIN: 1.05,
  STRONG_VOLUME: 1.50,

  MIN_SCORE: 68,
  STRONG_SCORE: 80,

  MIN_RR: 1.15,

  ATR_STOP_MULT: 0.75,
  SWING_LOOKBACK: 8,

  SIGNAL_TTL: 4 * 60 * 60 * 1000,

  MAX_PENDING: 100,

  CANDLE_LIMIT: 120,

  REQUEST_TIMEOUT: 12000
};

/* =========================================================
   STATE
========================================================= */

const STATE = {
  markets: [],
  tickers: new Map(),

  candidates: [],
  deep: [],

  pending: new Map(),
  signals: new Map(),

  selectedSymbol: null,
  selectedTimeframe: '15m',

  market: {
    regime: 'YATAY',
    breadth: 50,
    green: 0,
    red: 0,
    averageChange: 0
  },

  stats: {
    scanned: 0,
    candidates: 0,
    deep: 0,
    analyzed: 0,
    pending: 0,
    signals: 0,
    lastScan: null,
    errors: 0
  },

  lastScanStarted: null,
  scanning: false
};

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, decimals = 6) {
  const n = num(v);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(decimals));
}

function fmtPrice(v) {
  v = num(v);

  if (!v) return '0';

  if (v >= 1000) return v.toFixed(2);
  if (v >= 100) return v.toFixed(3);
  if (v >= 10) return v.toFixed(4);
  if (v >= 1) return v.toFixed(5);
  if (v >= 0.1) return v.toFixed(6);
  if (v >= 0.01) return v.toFixed(7);
  return v.toFixed(9);
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SonnyAITrader/6.1'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json && json.code && json.code !== '00000') {
      throw new Error(json.msg || `Bitget ${json.code}`);
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   BITGET MARKET DATA
========================================================= */

async function loadMarkets() {
  const url =
    `${BITGET}/api/v2/mix/market/contracts` +
    `?productType=${PRODUCT}`;

  const json = await fetchJson(url);

  const list = Array.isArray(json.data) ? json.data : [];

  STATE.markets = list
    .filter(x => {
      const symbol = String(x.symbol || '').toUpperCase();

      return (
        symbol.endsWith('USDT') &&
        x.symbolStatus !== 'offline' &&
        x.symbolStatus !== 'halt' &&
        x.symbolStatus !== 'delisted'
      );
    })
    .map(x => ({
      symbol: String(x.symbol).toUpperCase(),
      baseCoin: x.baseCoin || '',
      quoteCoin: x.quoteCoin || 'USDT',
      pricePrecision: num(x.pricePlace, 8),
      quantityPrecision: num(x.volumePlace, 4)
    }));

  console.log(`MARKETS | Gerçek USDT perpetual=${STATE.markets.length}`);
}

async function loadTickers() {
  const url =
    `${BITGET}/api/v2/mix/market/tickers` +
    `?productType=${PRODUCT}`;

  const json = await fetchJson(url);

  const list = Array.isArray(json.data) ? json.data : [];

  STATE.tickers.clear();

  for (const t of list) {
    const symbol = String(t.symbol || '').toUpperCase();

    if (!symbol.endsWith('USDT')) continue;

    STATE.tickers.set(symbol, {
      symbol,
      last: num(t.lastPr),
      bid: num(t.bidPr),
      ask: num(t.askPr),
      high: num(t.high24h),
      low: num(t.low24h),
      change: num(t.change24h),
      turnover: num(t.usdtVolume || t.quoteVolume || t.volume24h),
      baseVolume: num(t.baseVolume)
    });
  }
}

async function getCandles(symbol, timeframe, limit = CFG.CANDLE_LIMIT) {
  const url =
    `${BITGET}/api/v2/mix/market/candles` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&granularity=${encodeURIComponent(timeframe)}` +
    `&limit=${limit}` +
    `&productType=${PRODUCT}`;

  const json = await fetchJson(url);

  const raw = Array.isArray(json.data) ? json.data : [];

  /*
    Bitget candle:
    [timestamp, open, high, low, close, volume, quoteVolume]
  */

  return raw
    .map(c => ({
      time: num(c[0]),
      open: num(c[1]),
      high: num(c[2]),
      low: num(c[3]),
      close: num(c[4]),
      volume: num(c[5]),
      quoteVolume: num(c[6])
    }))
    .filter(c =>
      c.time &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;

    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  const recent = trs.slice(-period);

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function averageVolume(candles, period = 20) {
  const arr = candles.slice(-period);

  if (!arr.length) return 0;

  return arr.reduce((sum, c) => sum + c.volume, 0) / arr.length;
}

function volumeRatio(candles) {
  if (candles.length < 21) return 1;

  const current = candles[candles.length - 1];

  const avg = averageVolume(
    candles.slice(0, -1),
    20
  );

  if (!avg) return 1;

  return current.volume / avg;
}

function highest(candles, n) {
  const arr = candles.slice(-n);

  return Math.max(...arr.map(x => x.high));
}

function lowest(candles, n) {
  const arr = candles.slice(-n);

  return Math.min(...arr.map(x => x.low));
}

/* =========================================================
   TREND
========================================================= */

function trendFromCandles(candles) {
  if (candles.length < 55) {
    return {
      direction: 'NEUTRAL',
      strength: 0,
      ema21: 0,
      ema50: 0
    };
  }

  const closes = candles.map(c => c.close);

  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  const distance = ((e21 - e50) / e50) * 100;

  let direction = 'NEUTRAL';

  if (distance > 0.25) direction = 'LONG';
  if (distance < -0.25) direction = 'SHORT';

  return {
    direction,
    strength: Math.abs(distance),
    ema21: e21,
    ema50: e50
  };
}

/* =========================================================
   MARKET REGIME
========================================================= */

function calculateMarketRegime() {
  const values = [...STATE.tickers.values()]
    .filter(x => x.last > 0);

  if (!values.length) return;

  let green = 0;
  let red = 0;
  let totalChange = 0;

  for (const t of values) {
    if (t.change > 0) green++;
    if (t.change < 0) red++;

    totalChange += t.change;
  }

  const breadth =
    ((green / Math.max(1, green + red)) * 100);

  const averageChange =
    totalChange / values.length;

  let regime = 'YATAY';

  if (
    breadth >= 62 &&
    averageChange >= 0.45
  ) {
    regime = 'YÜKSELİŞ';
  } else if (
    breadth <= 38 &&
    averageChange <= -0.45
  ) {
    regime = 'DÜŞÜŞ';
  } else if (
    breadth >= 55 &&
    averageChange > 0.15
  ) {
    regime = 'HAFİF YÜKSELİŞ';
  } else if (
    breadth <= 45 &&
    averageChange < -0.15
  ) {
    regime = 'HAFİF DÜŞÜŞ';
  }

  STATE.market = {
    regime,
    breadth: round(breadth, 1),
    green,
    red,
    averageChange: round(averageChange, 2)
  };
}

/* =========================================================
   RADAR
========================================================= */

function buildRadar() {
  const marketSymbols = new Set(
    STATE.markets.map(x => x.symbol)
  );

  const list = [...STATE.tickers.values()]
    .filter(t => marketSymbols.has(t.symbol))
    .filter(t => t.last > 0)
    .filter(t =>
      t.turnover >= CFG.MIN_TURNOVER_24H
    )
    .filter(t =>
      Math.abs(t.change) >= CFG.MIN_MOVE_24H
    )
    .sort((a, b) => {
      const scoreA =
        Math.log10(Math.max(a.turnover, 1)) * 2 +
        Math.abs(a.change);

      const scoreB =
        Math.log10(Math.max(b.turnover, 1)) * 2 +
        Math.abs(b.change);

      return scoreB - scoreA;
    });

  STATE.candidates =
    list.slice(0, CFG.CANDIDATE_LIMIT);

  return STATE.candidates;
}

/* =========================================================
   DEEP RANKING
========================================================= */

async function quickRank(symbol) {
  try {
    const candles15 = await getCandles(
      symbol,
      '15m',
      60
    );

    if (candles15.length < 30) return null;

    const t = STATE.tickers.get(symbol);

    if (!t) return null;

    const a = atr(candles15, 14);
    const vol = volumeRatio(candles15);

    const move =
      Math.abs(pct(
        candles15[candles15.length - 1].close,
        candles15[Math.max(0, candles15.length - 12)].close
      ));

    const volatilityPct =
      t.last ? (a / t.last) * 100 : 0;

    const score =
      Math.min(
        100,
        Math.abs(t.change) * 2 +
        Math.min(move, 10) * 2 +
        Math.min(vol, 5) * 7 +
        Math.min(volatilityPct, 5) * 3
      );

    return {
      symbol,
      score,
      turnover: t.turnover,
      change: t.change,
      volumeRatio: vol
    };

  } catch (err) {
    return null;
  }
}

async function buildDeepList() {
  const ranked = [];

  /*
    Candidate sayısı 150.
    Deep ranking'i kontrollü şekilde yapıyoruz.
  */

  for (const c of STATE.candidates) {
    const result = await quickRank(c.symbol);

    if (result) ranked.push(result);

    /*
      Bitget rate-limit'e gereksiz yüklenmemesi için
      küçük batch arası.
    */
    if (ranked.length % 10 === 0) {
      await sleep(100);
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  STATE.deep =
    ranked.slice(0, CFG.DEEP_LIMIT);

  return STATE.deep;
}

/* =========================================================
   BREAKOUT DETECTION
========================================================= */

function detectBreakout(candles15, trend4h, trend2h) {
  if (candles15.length < 30) return null;

  /*
    Son kapanmış mum.
    En son mum halen oluşuyor olabilir.
    Bu nedenle son kapanmış candle olarak
    candles[length - 2] kullanıyoruz.
  */

  const last =
    candles15[candles15.length - 2];

  const previous =
    candles15[candles15.length - 3];

  const history =
    candles15.slice(
      Math.max(0, candles15.length - 2 - CFG.BREAKOUT_LOOKBACK_15M),
      candles15.length - 2
    );

  if (!history.length) return null;

  const resistance =
    Math.max(...history.map(c => c.high));

  const support =
    Math.min(...history.map(c => c.low));

  const avgVol =
    averageVolume(history, Math.min(20, history.length));

  const volRatio =
    avgVol > 0
      ? last.volume / avgVol
      : 1;

  const longBreak =
    last.close > resistance &&
    previous.close <= resistance;

  const shortBreak =
    last.close < support &&
    previous.close >= support;

  let direction = null;

  if (
    longBreak &&
    trend4h.direction !== 'SHORT' &&
    trend2h.direction !== 'SHORT'
  ) {
    direction = 'LONG';
  }

  if (
    shortBreak &&
    trend4h.direction !== 'LONG' &&
    trend2h.direction !== 'LONG'
  ) {
    direction = 'SHORT';
  }

  if (!direction) return null;

  if (volRatio < CFG.BREAKOUT_VOLUME_MIN) {
    return null;
  }

  const level =
    direction === 'LONG'
      ? resistance
      : support;

  return {
    direction,
    level,
    breakoutTime: last.time,
    breakoutClose: last.close,
    volumeRatio: volRatio
  };
}

/* =========================================================
   RETEST
========================================================= */

function findRetest(
  candles15,
  breakout
) {
  if (!breakout) return null;

  const after =
    candles15.filter(
      c => c.time > breakout.breakoutTime
    );

  if (!after.length) return null;

  const maxCandles =
    Math.min(
      CFG.RETEST_CANDLES,
      after.length
    );

  const candles =
    after.slice(0, maxCandles);

  const tolerance =
    Math.abs(breakout.level) * 0.0025;

  for (const c of candles) {

    const touched =
      breakout.direction === 'LONG'
        ? c.low <= breakout.level + tolerance
        : c.high >= breakout.level - tolerance;

    if (!touched) continue;

    const held =
      breakout.direction === 'LONG'
        ? c.close >= breakout.level
        : c.close <= breakout.level;

    if (!held) continue;

    return {
      retestTime: c.time,
      retestPrice: c.close
    };
  }

  return null;
}

/* =========================================================
   5M ENTRY CONFIRMATION
========================================================= */

function fiveMinuteConfirmation(
  candles5,
  direction
) {
  if (!candles5 || candles5.length < 25) {
    return {
      ok: true,
      soft: true,
      rsi: 50
    };
  }

  const closed =
    candles5.slice(0, -1);

  const last =
    closed[closed.length - 1];

  const prev =
    closed[closed.length - 2];

  const r = rsi(closed, 14);

  const bullish =
    last.close > last.open &&
    last.close >= prev.close;

  const bearish =
    last.close < last.open &&
    last.close <= prev.close;

  if (direction === 'LONG') {
    return {
      ok:
        bullish &&
        r >= 45 &&
        r <= 78,
      soft: false,
      rsi: round(r, 1)
    };
  }

  return {
    ok:
      bearish &&
      r >= 22 &&
      r <= 55,
    soft: false,
    rsi: round(r, 1)
  };
}

/* =========================================================
   TARGET / STOP
========================================================= */

function buildTradePlan(
  candles15,
  direction,
  entry,
  breakoutLevel
) {
  const recent =
    candles15.slice(-CFG.SWING_LOOKBACK);

  const a =
    atr(candles15, 14);

  if (!a) return null;

  let stop;

  if (direction === 'LONG') {
    const swingLow =
      Math.min(...recent.map(c => c.low));

    stop =
      Math.min(
        swingLow,
        breakoutLevel - a * CFG.ATR_STOP_MULT
      );

    if (stop >= entry) {
      stop = entry - a * 0.65;
    }
  } else {
    const swingHigh =
      Math.max(...recent.map(c => c.high));

    stop =
      Math.max(
        swingHigh,
        breakoutLevel + a * CFG.ATR_STOP_MULT
      );

    if (stop <= entry) {
      stop = entry + a * 0.65;
    }
  }

  const risk =
    Math.abs(entry - stop);

  if (!risk || risk <= 0) return null;

  /*
    Scalp hedefleri:
    TP1 = 1.20R
    TP2 = 1.80R
    TP3 = 2.40R
  */

  let tp1;
  let tp2;
  let tp3;

  if (direction === 'LONG') {
    tp1 = entry + risk * 1.20;
    tp2 = entry + risk * 1.80;
    tp3 = entry + risk * 2.40;
  } else {
    tp1 = entry - risk * 1.20;
    tp2 = entry - risk * 1.80;
    tp3 = entry - risk * 2.40;
  }

  /*
    Sıralama garantisi.
  */

  if (direction === 'LONG') {
    tp1 = Math.max(tp1, entry + risk);
    tp2 = Math.max(tp2, tp1 + risk * 0.25);
    tp3 = Math.max(tp3, tp2 + risk * 0.25);
  } else {
    tp1 = Math.min(tp1, entry - risk);
    tp2 = Math.min(tp2, tp1 - risk * 0.25);
    tp3 = Math.min(tp3, tp2 - risk * 0.25);
  }

  const rr =
    Math.abs(tp1 - entry) / risk;

  if (rr < CFG.MIN_RR) return null;

  return {
    entry,
    stop,
    tp1,
    tp2,
    tp3,
    risk,
    rr
  };
}

/* =========================================================
   SCORE
========================================================= */

function calculateScore({
  direction,
  trend4h,
  trend2h,
  volumeRatio: vol,
  breakout,
  confirmation,
  rsiValue,
  ticker
}) {
  let score = 50;

  /*
    4H trend
  */

  if (trend4h.direction === direction) {
    score += 15;
  } else if (
    trend4h.direction !== 'NEUTRAL'
  ) {
    score -= 12;
  }

  /*
    2H trend
  */

  if (trend2h.direction === direction) {
    score += 12;
  } else if (
    trend2h.direction !== 'NEUTRAL'
  ) {
    score -= 8;
  }

  /*
    Breakout volume
  */

  if (vol >= 2) score += 12;
  else if (vol >= 1.5) score += 9;
  else if (vol >= 1.2) score += 6;
  else score += 2;

  /*
    5M
  */

  if (confirmation.ok) {
    score += 12;
  } else {
    score -= 4;
  }

  /*
    RSI
  */

  if (direction === 'LONG') {
    if (rsiValue >= 48 && rsiValue <= 72) {
      score += 6;
    }

    if (rsiValue > 82) {
      score -= 8;
    }
  } else {
    if (rsiValue >= 28 && rsiValue <= 52) {
      score += 6;
    }

    if (rsiValue < 18) {
      score -= 8;
    }
  }

  /*
    24H momentum
  */

  if (ticker) {
    if (
      direction === 'LONG' &&
      ticker.change > 0
    ) score += 4;

    if (
      direction === 'SHORT' &&
      ticker.change < 0
    ) score += 4;
  }

  /*
    Çok aşırı hacim patlaması
    fakeout ihtimalini biraz düşürür.
  */

  if (vol > 10) {
    score -= 5;
  }

  return clamp(Math.round(score), 0, 100);
}

/* =========================================================
   PROCESS ONE COIN
========================================================= */

async function analyzeCoin(symbol) {
  try {

    const ticker =
      STATE.tickers.get(symbol);

    if (!ticker) return null;

    /*
      Paralel veri çekimi.
    */

    const [
      candles4h,
      candles2h,
      candles15,
      candles5
    ] = await Promise.all([
      getCandles(symbol, '4H', 80),
      getCandles(symbol, '2H', 80),
      getCandles(symbol, '15m', 120),
      getCandles(symbol, '5m', 80)
    ]);

    if (
      candles4h.length < 55 ||
      candles2h.length < 55 ||
      candles15.length < 30
    ) {
      return null;
    }

    const trend4h =
      trendFromCandles(candles4h);

    const trend2h =
      trendFromCandles(candles2h);

    /*
      Mevcut pending breakout
    */

    let pending =
      STATE.pending.get(symbol);

    /*
      Eğer pending yoksa yeni breakout ara.
    */

    if (!pending) {

      const breakout =
        detectBreakout(
          candles15,
          trend4h,
          trend2h
        );

      if (breakout) {

        /*
          Aynı coin için tek breakout.
        */

        pending = {
          symbol,
          direction: breakout.direction,
          level: breakout.level,
          breakoutTime: breakout.breakoutTime,
          breakoutClose: breakout.breakoutClose,
          volumeRatio: breakout.volumeRatio,
          createdAt: Date.now(),
          status: 'WAITING_RETEST'
        };

        STATE.pending.set(
          symbol,
          pending
        );

        console.log(
          `BREAKOUT | ${symbol} | ` +
          `${pending.direction} | ` +
          `${fmtPrice(pending.level)} | ` +
          `VOL ${round(pending.volumeRatio, 2)}x`
        );
      }
    }

    /*
      Pending breakout süresi.
    */

    if (pending) {

      const age =
        Date.now() - pending.createdAt;

      if (
        age >
        CFG.RETEST_MINUTES * 60 * 1000
      ) {
        pending.status = 'EXPIRED';
        STATE.pending.delete(symbol);
        pending = null;
      }
    }

    if (!pending) return null;

    /*
      Retest
    */

    const retest =
      findRetest(
        candles15,
        pending
      );

    if (!retest) {
      pending.status = 'WAITING_RETEST';
      return null;
    }

    /*
      5M teyidi.
      Çok sıkı değil.
      Teyit yoksa doğrudan çöpe atmıyoruz.
      Score'a küçük ceza veriyoruz.
    */

    const confirmation =
      fiveMinuteConfirmation(
        candles5,
        pending.direction
      );

    const rsiValue =
      confirmation.rsi ||
      rsi(candles5, 14);

    /*
      5M ters yönde çok güçlü ise
      sinyal verme.
    */

    if (
      !confirmation.ok &&
      !confirmation.soft
    ) {

      const last5 =
        candles5[candles5.length - 2];

      const body =
        Math.abs(
          last5.close - last5.open
        );

      const range =
        last5.high - last5.low;

      const strongOpposite =
        range > 0 &&
        body / range > 0.65 &&
        (
          pending.direction === 'LONG'
            ? last5.close < last5.open
            : last5.close > last5.open
        );

      if (strongOpposite) {
        pending.status = 'WAITING_5M';
        return null;
      }
    }

    /*
      Giriş fiyatı:
      retest close + küçük buffer.
    */

    const lastPrice =
      ticker.last;

    let entry;

    if (pending.direction === 'LONG') {
      entry =
        Math.max(
          retest.retestPrice,
          pending.level
        );
    } else {
      entry =
        Math.min(
          retest.retestPrice,
          pending.level
        );
    }

    /*
      Güncel fiyat çok uzaklaşmışsa
      FOMO girişini engelle.
    */

    const distancePct =
      Math.abs(
        pct(lastPrice, entry)
      );

    if (distancePct > 0.65) {
      pending.status = 'MISSED_ENTRY';
      return null;
    }

    const plan =
      buildTradePlan(
        candles15,
        pending.direction,
        entry,
        pending.level
      );

    if (!plan) {
      pending.status = 'INVALID_PLAN';
      return null;
    }

    const score =
      calculateScore({
        direction: pending.direction,
        trend4h,
        trend2h,
        volumeRatio: pending.volumeRatio,
        breakout: pending,
        confirmation,
        rsiValue,
        ticker
      });

    if (score < CFG.MIN_SCORE) {
      pending.status = 'LOW_SCORE';
      return null;
    }

    /*
      Market karşı yön filtresi.
      Aşırı piyasa durumunda ters sinyalin
      skorunu azaltıyoruz ama tamamen kapatmıyoruz.
      Böylece altcoin fırsatları kaçmıyor.
    */

    let finalScore = score;

    if (
      STATE.market.regime === 'YÜKSELİŞ' &&
      pending.direction === 'SHORT'
    ) {
      finalScore -= 8;
    }

    if (
      STATE.market.regime === 'DÜŞÜŞ' &&
      pending.direction === 'LONG'
    ) {
      finalScore -= 8;
    }

    finalScore =
      clamp(Math.round(finalScore), 0, 100);

    if (finalScore < CFG.MIN_SCORE) {
      pending.status = 'MARKET_FILTER';
      return null;
    }

    /*
      Signal
    */

    const signal = {
      id:
        `${symbol}-${pending.direction}-${pending.breakoutTime}`,

      symbol,
      type: pending.direction,

      status: 'SCALP GİRİŞİ',

      score: finalScore,

      entry: plan.entry,
      entryZone:
        `${fmtPrice(plan.entry * 0.999)} - ` +
        `${fmtPrice(plan.entry * 1.001)}`,

      stopLoss: plan.stop,

      tp1: plan.tp1,
      tp2: plan.tp2,
      tp3: plan.tp3,

      rr: plan.rr,

      rsi: round(rsiValue, 1),

      volumeRatio:
        pending.volumeRatio,

      timeframeLevel:
        '4H + 2H',

      breakoutLevel:
        pending.level,

      breakoutTime:
        pending.breakoutTime,

      retestTime:
        retest.retestTime,

      currentPrice:
        lastPrice,

      trend4h:
        trend4h.direction,

      trend2h:
        trend2h.direction,

      createdAt:
        Date.now(),

      expiresAt:
        Date.now() + CFG.SIGNAL_TTL
    };

    STATE.signals.set(
      symbol,
      signal
    );

    STATE.pending.delete(symbol);

    console.log(
      `SIGNAL | ${symbol} | ` +
      `${signal.type} | ` +
      `SCORE ${signal.score} | ` +
      `RR 1:${round(signal.rr, 2)}`
    );

    return signal;

  } catch (err) {

    STATE.stats.errors++;

    console.error(
      `ANALYZE ERROR | ${symbol} | ${err.message}`
    );

    return null;
  }
}

/* =========================================================
   CLEANUP
========================================================= */

function cleanupState() {

  const now = Date.now();

  for (
    const [symbol, signal]
    of STATE.signals
  ) {
    if (
      signal.expiresAt &&
      signal.expiresAt < now
    ) {
      STATE.signals.delete(symbol);
    }
  }

  for (
    const [symbol, pending]
    of STATE.pending
  ) {
    if (
      now - pending.createdAt >
      CFG.RETEST_MINUTES * 60 * 1000
    ) {
      STATE.pending.delete(symbol);
    }
  }

  /*
    Pending üst sınırı.
  */

  if (
    STATE.pending.size >
    CFG.MAX_PENDING
  ) {

    const entries =
      [...STATE.pending.entries()]
        .sort(
          (a, b) =>
            a[1].createdAt -
            b[1].createdAt
        );

    const removeCount =
      STATE.pending.size -
      CFG.MAX_PENDING;

    for (
      let i = 0;
      i < removeCount;
      i++
    ) {
      STATE.pending.delete(
        entries[i][0]
      );
    }
  }
}

/* =========================================================
   RADAR SCAN
========================================================= */

async function scan() {

  if (STATE.scanning) return;

  STATE.scanning = true;
  STATE.lastScanStarted = Date.now();

  try {

    console.log('');
    console.log('==============================================');
    console.log('SONNY AI TRADER V6.1 RADAR');
    console.log('==============================================');

    /*
      Ticker + market list.
    */

    if (!STATE.markets.length) {
      await loadMarkets();
    }

    await loadTickers();

    calculateMarketRegime();

    /*
      500 RADAR
    */

    const candidates =
      buildRadar();

    /*
      Deep ranking.
    */

    await buildDeepList();

    /*
      Analyze 40.
    */

    STATE.stats.analyzed = 0;

    /*
      5'er batch.
      Aynı anda çok fazla request atıp
      Bitget'i boğmuyoruz.
    */

    for (
      let i = 0;
      i < STATE.deep.length;
      i += 5
    ) {

      const batch =
        STATE.deep.slice(i, i + 5);

      await Promise.all(
        batch.map(async x => {
          await analyzeCoin(x.symbol);
          STATE.stats.analyzed++;
        })
      );

      await sleep(150);
    }

    cleanupState();

    STATE.stats.scanned =
      Math.min(
        STATE.markets.length,
        CFG.RADAR_LIMIT
      );

    STATE.stats.candidates =
      candidates.length;

    STATE.stats.deep =
      STATE.deep.length;

    STATE.stats.pending =
      STATE.pending.size;

    STATE.stats.signals =
      STATE.signals.size;

    STATE.stats.lastScan =
      Date.now();

    console.log(
      `RADAR tamamlandı | ` +
      `Universe=${STATE.stats.scanned} | ` +
      `Candidates=${STATE.stats.candidates} | ` +
      `Deep=${STATE.stats.deep} | ` +
      `Analiz=${STATE.stats.analyzed} | ` +
      `Pending=${STATE.stats.pending} | ` +
      `SIGNAL=${STATE.stats.signals}`
    );

    broadcastState();

  } catch (err) {

    STATE.stats.errors++;

    console.error(
      'RADAR ERROR:',
      err.message
    );

    broadcastState();

  } finally {

    STATE.scanning = false;
  }
}

/* =========================================================
   CHART API
   DIRECT BITGET
========================================================= */

app.get('/api/chart', async (req, res) => {

  try {

    let symbol =
      String(
        req.query.symbol ||
        STATE.selectedSymbol ||
        'BTCUSDT'
      ).toUpperCase();

    let timeframe =
      String(
        req.query.timeframe ||
        '15m'
      );

    const allowed = [
      '5m',
      '15m',
      '1H',
      '2H',
      '4H'
    ];

    if (!allowed.includes(timeframe)) {
      timeframe = '15m';
    }

    /*
      Güvenlik:
      Gerçek Bitget market listesinde olmayan
      sembol için veri döndürme.
    */

    if (
      STATE.markets.length &&
      !STATE.markets.some(
        x => x.symbol === symbol
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Geçersiz Bitget Futures sembolü',
        symbol
      });
    }

    const candles =
      await getCandles(
        symbol,
        timeframe,
        150
      );

    STATE.selectedSymbol = symbol;
    STATE.selectedTimeframe = timeframe;

    res.json({
      ok: true,
      symbol,
      timeframe,
      candles
    });

  } catch (err) {

    console.error(
      `CHART ERROR | ${req.query.symbol} | ${err.message}`
    );

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* =========================================================
   STATUS API
========================================================= */

app.get('/api/status', (req, res) => {

  res.json({
    ok: true,

    version: '6.1',

    config: {
      radar: CFG.RADAR_LIMIT,
      candidates: CFG.CANDIDATE_LIMIT,
      deep: CFG.DEEP_LIMIT,
      minVolume: CFG.MIN_TURNOVER_24H,
      minRR: CFG.MIN_RR,
      retestMinutes: CFG.RETEST_MINUTES
    },

    stats: {
      ...STATE.stats,
      pending: STATE.pending.size,
      signals: STATE.signals.size
    },

    market: STATE.market,

    signals:
      [...STATE.signals.values()]
        .sort(
          (a, b) =>
            b.score - a.score
        ),

    pending:
      [...STATE.pending.values()]
        .sort(
          (a, b) =>
            b.createdAt -
            a.createdAt
        )
        .slice(0, 20),

    selected: {
      symbol: STATE.selectedSymbol,
      timeframe: STATE.selectedTimeframe
    }
  });
});

/* =========================================================
   MANUAL REFRESH
========================================================= */

app.post('/api/scan', async (req, res) => {

  if (STATE.scanning) {
    return res.json({
      ok: false,
      message: 'Radar zaten çalışıyor'
    });
  }

  scan();

  res.json({
    ok: true,
    message: 'Radar yenileniyor'
  });
});

/* =========================================================
   ROOT
   EMBEDDED FRONTEND
========================================================= */

app.get('/', (req, res) => {

  res.type('html').send(`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1,maximum-scale=1">

<title>Sonny AI Trader V6.1</title>

<style>

*{
  box-sizing:border-box;
}

html,
body{
  margin:0;
  padding:0;
  width:100%;
  height:100%;
  overflow:hidden;
  background:#070b11;
  color:#e8edf5;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    Arial,
    sans-serif;
}

button{
  font:inherit;
}

.app{
  width:100%;
  height:100vh;
  display:grid;
  grid-template-columns:245px minmax(0,1fr) 275px;
  background:#070b11;
}

/* LEFT */

.left{
  border-right:1px solid #182232;
  background:#090e16;
  overflow:hidden;
  display:flex;
  flex-direction:column;
}

.brand{
  padding:18px 15px 12px;
  border-bottom:1px solid #182232;
}

.brand-title{
  font-size:18px;
  font-weight:900;
  color:#fff;
}

.brand-sub{
  font-size:9px;
  color:#64748b;
  margin-top:5px;
}

.radar-list{
  flex:1;
  overflow:auto;
  padding:10px;
}

.coin{
  border:1px solid #1d293a;
  background:#0e151f;
  border-radius:10px;
  padding:10px;
  margin-bottom:8px;
  cursor:pointer;
  transition:.15s;
}

.coin:hover{
  border-color:#355173;
  transform:translateY(-1px);
}

.coin.active{
  border-color:#00d9ff;
  box-shadow:
    0 0 0 1px rgba(0,217,255,.12);
}

.coin-top{
  display:flex;
  justify-content:space-between;
  gap:8px;
}

.coin-symbol{
  font-size:13px;
  font-weight:900;
}

.coin-change{
  font-size:10px;
  padding:3px 5px;
  border-radius:4px;
  background:#142238;
}

.coin-price{
  font-size:16px;
  font-weight:800;
  margin-top:7px;
}

.coin-meta{
  font-size:9px;
  color:#65758a;
  margin-top:5px;
}

.refresh{
  margin:10px;
  padding:11px;
  border:0;
  border-radius:8px;
  background:#172845;
  color:#fff;
  cursor:pointer;
  font-weight:800;
}

/* CENTER */

.center{
  min-width:0;
  display:flex;
  flex-direction:column;
}

.header{
  height:74px;
  flex:none;
  border-bottom:1px solid #182232;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:12px 18px;
}

.header-title{
  font-size:18px;
  font-weight:900;
}

.header-sub{
  font-size:9px;
  color:#68788e;
  margin-top:5px;
}

.stats{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  justify-content:flex-end;
}

.stat{
  font-size:10px;
  color:#718197;
}

.stat b{
  color:#dbe5f1;
}

.chart-toolbar{
  height:48px;
  flex:none;
  display:flex;
  align-items:center;
  gap:6px;
  padding:7px 14px;
  border-bottom:1px solid #182232;
}

.tf{
  border:1px solid #26364d;
  background:#0d1520;
  color:#8293a9;
  border-radius:6px;
  padding:5px 9px;
  font-size:10px;
  cursor:pointer;
}

.tf.active{
  background:#142b50;
  border-color:#3786ff;
  color:#fff;
}

.chart-wrap{
  position:relative;
  flex:1;
  min-height:0;
  background:#070b11;
}

#chart{
  display:block;
  width:100%;
  height:100%;
}

.chart-error{
  position:absolute;
  left:50%;
  top:50%;
  transform:translate(-50%,-50%);
  background:#101823;
  border:1px solid #29394d;
  border-radius:10px;
  padding:16px 20px;
  color:#ff7180;
  font-size:12px;
  display:none;
  max-width:80%;
  text-align:center;
}

.chart-loading{
  position:absolute;
  left:50%;
  top:50%;
  transform:translate(-50%,-50%);
  color:#63748a;
  font-size:12px;
}

/* RIGHT */

.right{
  border-left:1px solid #182232;
  background:#090e16;
  overflow:auto;
  padding:10px;
}

.panel{
  border:1px solid #1d2939;
  background:#0d141e;
  border-radius:10px;
  padding:12px;
  margin-bottom:10px;
}

.panel-title{
  font-size:9px;
  color:#73839a;
  font-weight:900;
  letter-spacing:.5px;
  margin-bottom:10px;
}

.regime{
  font-size:20px;
  font-weight:900;
  color:#19e5a0;
}

.market-row{
  display:flex;
  justify-content:space-between;
  margin-top:6px;
  font-size:10px;
  color:#748399;
}

.market-row b{
  color:#dbe4ef;
}

.signal{
  border:1px solid #253349;
  border-radius:8px;
  padding:10px;
  margin-bottom:8px;
}

.signal.long{
  border-left:3px solid #00e5a0;
}

.signal.short{
  border-left:3px solid #ff4f69;
}

.signal-head{
  display:flex;
  justify-content:space-between;
}

.signal-symbol{
  font-size:12px;
  font-weight:900;
}

.signal-type{
  font-size:9px;
  font-weight:900;
}

.long .signal-type{
  color:#00e5a0;
}

.short .signal-type{
  color:#ff4f69;
}

.signal-price{
  font-size:15px;
  font-weight:900;
  margin-top:7px;
}

.signal-line{
  display:flex;
  justify-content:space-between;
  font-size:9px;
  margin-top:5px;
  color:#6e7e92;
}

.signal-line b{
  color:#dce6f0;
}

.pending{
  border-left:2px solid #ffbf42;
  padding:7px 8px;
  background:#0b121b;
  margin-bottom:6px;
  border-radius:4px;
}

.pending-title{
  font-size:10px;
  font-weight:900;
}

.pending-meta{
  font-size:8px;
  color:#68788d;
  margin-top:3px;
}

/* MOBILE */

@media(max-width:900px){

  html,
  body{
    overflow:auto;
  }

  .app{
    height:auto;
    min-height:100vh;
    grid-template-columns:1fr;
    overflow:visible;
  }

  .left{
    border-right:0;
    border-bottom:1px solid #182232;
    max-height:280px;
  }

  .brand{
    padding:10px 12px;
  }

  .radar-list{
    display:flex;
    overflow-x:auto;
    overflow-y:hidden;
    gap:7px;
    padding:8px;
  }

  .coin{
    min-width:145px;
    margin:0;
  }

  .refresh{
    margin:7px;
  }

  .center{
    min-height:520px;
  }

  .header{
    height:auto;
    min-height:65px;
    padding:10px;
    align-items:flex-start;
  }

  .header-title{
    font-size:15px;
  }

  .stats{
    display:none;
  }

  .chart-toolbar{
    overflow-x:auto;
    white-space:nowrap;
  }

  .chart-wrap{
    height:480px;
    flex:none;
  }

  .right{
    border-left:0;
    border-top:1px solid #182232;
    max-height:none;
  }

}

</style>
</head>

<body>

<div class="app">

  <aside class="left">

    <div class="brand">
      <div class="brand-title">
        ⚡ SONNY AI TRADER
      </div>

      <div class="brand-sub">
        V6.1 • BITGET USDT FUTURES • SCALP ENGINE
      </div>
    </div>

    <div
      id="radarList"
      class="radar-list">
    </div>

    <button
      id="refreshBtn"
      class="refresh">
      RADARI YENİLE
    </button>

  </aside>

  <main class="center">

    <div class="header">

      <div>
        <div
          id="headerTitle"
          class="header-title">
          SONNY AI TRADER
        </div>

        <div class="header-sub">
          500 RADAR → 150 ADAY → 40 DERİN
          → 4H + 2H → 15M → RETEST → 5M
        </div>
      </div>

      <div
        id="stats"
        class="stats">
      </div>

    </div>

    <div class="chart-toolbar">

      <button
        class="tf"
        data-tf="5m">
        5M
      </button>

      <button
        class="tf active"
        data-tf="15m">
        15M
      </button>

      <button
        class="tf"
        data-tf="1H">
        1H
      </button>

      <button
        class="tf"
        data-tf="2H">
        2H
      </button>

      <button
        class="tf"
        data-tf="4H">
        4H
      </button>

    </div>

    <div class="chart-wrap">

      <canvas id="chart"></canvas>

      <div
        id="chartLoading"
        class="chart-loading">
        Grafik yükleniyor...
      </div>

      <div
        id="chartError"
        class="chart-error">
      </div>

    </div>

  </main>

  <aside class="right">

    <div class="panel">

      <div class="panel-title">
        GENEL PİYASA
      </div>

      <div
        id="regime"
        class="regime">
        -
      </div>

      <div class="market-row">
        <span>BREADTH</span>
        <b id="breadth">-</b>
      </div>

      <div class="market-row">
        <span>YEŞİL</span>
        <b id="green">-</b>
      </div>

      <div class="market-row">
        <span>KIRMIZI</span>
        <b id="red">-</b>
      </div>

      <div class="market-row">
        <span>ORTALAMA</span>
        <b id="avg">-</b>
      </div>

    </div>

    <div class="panel">

      <div class="panel-title">
        AKTİF SCALP SİNYALLERİ
      </div>

      <div id="signals">
        Sinyal bekleniyor...
      </div>

    </div>

    <div class="panel">

      <div class="panel-title">
        BEKLEYEN BREAKOUT / RETEST
      </div>

      <div id="pending">
        Bekleyen setup yok.
      </div>

    </div>

  </aside>

</div>

<script>

const state = {
  symbol: null,
  timeframe: '15m',
  candles: [],
  signals: [],
  pending: [],
  radar: []
};

const canvas =
  document.getElementById('chart');

const ctx =
  canvas.getContext('2d');

function esc(value){

  return String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function price(v){

  v = Number(v);

  if(!Number.isFinite(v))
    return '-';

  if(v >= 1000) return v.toFixed(2);
  if(v >= 100) return v.toFixed(3);
  if(v >= 10) return v.toFixed(4);
  if(v >= 1) return v.toFixed(5);
  if(v >= .1) return v.toFixed(6);
  if(v >= .01) return v.toFixed(7);

  return v.toFixed(9);
}

function resizeCanvas(){

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio || 1;

  canvas.width =
    Math.max(1, Math.floor(rect.width * dpr));

  canvas.height =
    Math.max(1, Math.floor(rect.height * dpr));

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  drawChart();
}

window.addEventListener(
  'resize',
  resizeCanvas
);

function showChartError(message){

  document
    .getElementById('chartError')
    .style.display = 'block';

  document
    .getElementById('chartError')
    .textContent =
      'Grafik verisi alınamadı: ' +
      message;
}

function drawChart(){

  const rect =
    canvas.getBoundingClientRect();

  const width =
    rect.width;

  const height =
    rect.height;

  ctx.clearRect(
    0,
    0,
    width,
    height
  );

  if(!state.candles.length){

    ctx.fillStyle =
      '#63748a';

    ctx.font =
      '12px Arial';

    ctx.textAlign =
      'center';

    ctx.fillText(
      'Grafik verisi yok',
      width / 2,
      height / 2
    );

    return;
  }

  const candles =
    state.candles;

  const padLeft = 55;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;

  const chartW =
    width -
    padLeft -
    padRight;

  const chartH =
    height -
    padTop -
    padBottom;

  const highs =
    candles.map(c => Number(c.high));

  const lows =
    candles.map(c => Number(c.low));

  let max =
    Math.max(...highs);

  let min =
    Math.min(...lows);

  const range =
    Math.max(max - min, max * .000001);

  max += range * .05;
  min -= range * .05;

  function y(value){

    return padTop +
      (max - value) /
      (max - min) *
      chartH;
  }

  function x(index){

    return padLeft +
      (index + .5) /
      candles.length *
      chartW;
  }

  /*
    Background
  */

  ctx.fillStyle =
    '#070b11';

  ctx.fillRect(
    0,
    0,
    width,
    height
  );

  /*
    Grid
  */

  ctx.strokeStyle =
    '#121c29';

  ctx.lineWidth = 1;

  for(let i=0;i<=5;i++){

    const yy =
      padTop +
      chartH * i / 5;

    ctx.beginPath();
    ctx.moveTo(
      padLeft,
      yy
    );

    ctx.lineTo(
      width - padRight,
      yy
    );

    ctx.stroke();

    const value =
      max -
      (max-min) *
      i / 5;

    ctx.fillStyle =
      '#516176';

    ctx.font =
      '9px Arial';

    ctx.textAlign =
      'right';

    ctx.fillText(
      price(value),
      padLeft - 6,
      yy + 3
    );
  }

  /*
    Candles
  */

  const candleWidth =
    Math.max(
      2,
      Math.min(
        12,
        chartW /
        candles.length *
        .65
      )
    );

  candles.forEach((c,i)=>{

    const xx = x(i);

    const open =
      Number(c.open);

    const close =
      Number(c.close);

    const high =
      Number(c.high);

    const low =
      Number(c.low);

    const up =
      close >= open;

    ctx.strokeStyle =
      up ? '#18e5a0' : '#ff4f69';

    ctx.fillStyle =
      up ? '#18e5a0' : '#ff4f69';

    /*
      Wick
    */

    ctx.beginPath();

    ctx.moveTo(
      xx,
      y(high)
    );

    ctx.lineTo(
      xx,
      y(low)
    );

    ctx.stroke();

    /*
      Body
    */

    const top =
      y(Math.max(open,close));

    const bottom =
      y(Math.min(open,close));

    const bodyH =
      Math.max(
        1,
        bottom - top
      );

    ctx.fillRect(
      xx - candleWidth/2,
      top,
      candleWidth,
      bodyH
    );

  });

  /*
    Last price
  */

  const last =
    candles[candles.length - 1];

  const lastPrice =
    Number(last.close);

  const ly =
    y(lastPrice);

  ctx.strokeStyle =
    '#00d9ff';

  ctx.setLineDash([4,4]);

  ctx.beginPath();

  ctx.moveTo(
    padLeft,
    ly
  );

  ctx.lineTo(
    width - padRight,
    ly
  );

  ctx.stroke();

  ctx.setLineDash([]);

  ctx.fillStyle =
    '#00d9ff';

  ctx.font =
    '10px Arial';

  ctx.textAlign =
    'right';

  ctx.fillText(
    price(lastPrice),
    width - padRight,
    ly - 5
  );

  /*
    Time labels
  */

  ctx.fillStyle =
    '#4d5e73';

  ctx.font =
    '9px Arial';

  ctx.textAlign =
    'center';

  const labels = 5;

  for(let i=0;i<labels;i++){

    const idx =
      Math.floor(
        i *
        (candles.length-1) /
        (labels-1)
      );

    const c =
      candles[idx];

    if(!c) continue;

    const date =
      new Date(Number(c.time));

    const text =
      date.toLocaleTimeString(
        'tr-TR',
        {
          hour:'2-digit',
          minute:'2-digit'
        }
      );

    ctx.fillText(
      text,
      x(idx),
      height - 12
    );
  }
}

async function loadChart(){

  if(!state.symbol){

    if(state.radar.length){

      state.symbol =
        state.radar[0].symbol;

    } else {

      state.symbol =
        'BTCUSDT';
    }
  }

  document
    .getElementById('chartLoading')
    .style.display = 'block';

  document
    .getElementById('chartError')
    .style.display = 'none';

  try{

    const url =
      '/api/chart?symbol=' +
      encodeURIComponent(state.symbol) +
      '&timeframe=' +
      encodeURIComponent(state.timeframe);

    const response =
      await fetch(url);

    const data =
      await response.json();

    if(!response.ok || !data.ok){

      throw new Error(
        data.error ||
        'Bilinmeyen grafik hatası'
      );
    }

    state.candles =
      Array.isArray(data.candles)
        ? data.candles
        : [];

    document
      .getElementById('headerTitle')
      .textContent =
        state.symbol +
        ' • ' +
        state.timeframe;

    document
      .getElementById('chartLoading')
      .style.display = 'none';

    resizeCanvas();

  }catch(err){

    document
      .getElementById('chartLoading')
      .style.display = 'none';

    showChartError(
      err.message
    );
  }
}

function renderRadar(){

  const el =
    document.getElementById(
      'radarList'
    );

  el.innerHTML = '';

  state.radar
    .slice(0,50)
    .forEach(item=>{

      const div =
        document.createElement('div');

      div.className =
        'coin' +
        (
          item.symbol === state.symbol
            ? ' active'
            : ''
        );

      const change =
        Number(item.change || 0);

      div.innerHTML = \`
        <div class="coin-top">
          <div class="coin-symbol">
            \${esc(item.symbol)}
          </div>

          <div class="coin-change">
            \${change >= 0 ? '+' : ''}
            \${change.toFixed(2)}%
          </div>
        </div>

        <div class="coin-price">
          \${price(item.last)}
        </div>

        <div class="coin-meta">
          24H HACİM:
          \${formatVolume(item.turnover)}
        </div>
      \`;

      div.onclick = ()=>{

        state.symbol =
          item.symbol;

        renderRadar();
        loadChart();

      };

      el.appendChild(div);
    });
}

function formatVolume(v){

  v = Number(v || 0);

  if(v >= 1e9)
    return (v/1e9).toFixed(1)+'B';

  if(v >= 1e6)
    return (v/1e6).toFixed(1)+'M';

  if(v >= 1e3)
    return (v/1e3).toFixed(1)+'K';

  return v.toFixed(0);
}

function renderMarket(data){

  const m =
    data.market || {};

  document
    .getElementById('regime')
    .textContent =
      m.regime || '-';

  document
    .getElementById('breadth')
    .textContent =
      (m.breadth ?? '-') + '%';

  document
    .getElementById('green')
    .textContent =
      m.green ?? '-';

  document
    .getElementById('red')
    .textContent =
      m.red ?? '-';

  document
    .getElementById('avg')
    .textContent =
      (m.averageChange ?? '-') + '%';
}

function renderSignals(signals){

  const el =
    document.getElementById(
      'signals'
    );

  if(!signals.length){

    el.innerHTML =
      '<div style="font-size:10px;color:#65758a;">' +
      'Şu anda teyit edilmiş scalp sinyali yok.' +
      '</div>';

    return;
  }

  el.innerHTML = '';

  signals.forEach(sig=>{

    const div =
      document.createElement('div');

    const typeClass =
      sig.type === 'LONG'
        ? 'long'
        : 'short';

    div.className =
      'signal ' +
      typeClass;

    div.innerHTML = \`
      <div class="signal-head">
        <div class="signal-symbol">
          \${esc(sig.symbol)}
        </div>

        <div class="signal-type">
          \${esc(sig.type)}
        </div>
      </div>

      <div class="signal-price">
        \${price(sig.entry)}
      </div>

      <div class="signal-line">
        <span>SKOR</span>
        <b>\${esc(sig.score)}/100</b>
      </div>

      <div class="signal-line">
        <span>STOP</span>
        <b>\${price(sig.stopLoss)}</b>
      </div>

      <div class="signal-line">
        <span>TP1</span>
        <b>\${price(sig.tp1)}</b>
      </div>

      <div class="signal-line">
        <span>TP2</span>
        <b>\${price(sig.tp2)}</b>
      </div>

      <div class="signal-line">
        <span>TP3</span>
        <b>\${price(sig.tp3)}</b>
      </div>

      <div class="signal-line">
        <span>R:R</span>
        <b>1:\${Number(sig.rr || 0).toFixed(2)}</b>
      </div>

      <div class="signal-line">
        <span>RSI</span>
        <b>\${esc(sig.rsi)}</b>
      </div>

      <div class="signal-line">
        <span>HACİM</span>
        <b>\${Number(sig.volumeRatio || 0).toFixed(2)}x</b>
      </div>
    \`;

    div.onclick = ()=>{

      state.symbol =
        sig.symbol;

      renderRadar();
      loadChart();

    };

    el.appendChild(div);
  });
}

function renderPending(pending){

  const el =
    document.getElementById(
      'pending'
    );

  if(!pending.length){

    el.innerHTML =
      '<div style="font-size:10px;color:#65758a;">' +
      'Bekleyen breakout/retest yok.' +
      '</div>';

    return;
  }

  el.innerHTML = '';

  pending.forEach(p=>{

    const div =
      document.createElement('div');

    div.className =
      'pending';

    div.innerHTML = \`
      <div class="pending-title">
        \${esc(p.symbol)}
        \${esc(p.direction)}
      </div>

      <div class="pending-meta">
        Level: \${price(p.level)}
        • VOL: \${Number(p.volumeRatio || 0).toFixed(2)}x
      </div>

      <div class="pending-meta">
        \${esc(p.status)}
      </div>
    \`;

    div.onclick = ()=>{

      state.symbol =
        p.symbol;

      renderRadar();
      loadChart();

    };

    el.appendChild(div);
  });
}

function renderStats(data){

  const s =
    data.stats || {};

  document
    .getElementById('stats')
    .innerHTML = \`
      <div class="stat">
        RADAR <b>\${s.scanned || 0}</b>
      </div>

      <div class="stat">
        ADAY <b>\${s.candidates || 0}</b>
      </div>

      <div class="stat">
        DERİN <b>\${s.deep || 0}</b>
      </div>

      <div class="stat">
        ANALİZ <b>\${s.analyzed || 0}</b>
      </div>

      <div class="stat">
        BEKLEYEN <b>\${s.pending || 0}</b>
      </div>

      <div class="stat">
        SİNYAL <b>\${s.signals || 0}</b>
      </div>
    \`;
}

async function refresh(){

  try{

    const response =
      await fetch('/api/status');

    const data =
      await response.json();

    state.signals =
      data.signals || [];

    state.pending =
      data.pending || [];

    /*
      Radar:
      ticker verisinden frontend'e gelen
      gerçek adaylar.
    */

    if(data.radar){

      state.radar =
        data.radar;

    } else if(
      state.radar.length === 0 &&
      state.signals.length
    ){

      state.radar =
        state.signals.map(s=>({
          symbol:s.symbol,
          last:s.currentPrice,
          change:0,
          turnover:0
        }));
    }

    renderStats(data);
    renderMarket(data);
    renderSignals(state.signals);
    renderPending(state.pending);

  }catch(err){

    console.error(err);
  }
}

/*
  WebSocket
*/

let ws;

function connectWS(){

  const protocol =
    location.protocol === 'https:'
      ? 'wss:'
      : 'ws:';

  ws =
    new WebSocket(
      protocol +
      '//' +
      location.host
    );

  ws.onmessage =
    event => {

      try{

        const data =
          JSON.parse(
            event.data
          );

        if(data.type === 'state'){

          if(data.radar){
            state.radar =
              data.radar;
          }

          state.signals =
            data.signals || [];

          state.pending =
            data.pending || [];

          renderStats(data);
          renderMarket(data);
          renderRadar();
          renderSignals(
            state.signals
          );
          renderPending(
            state.pending
          );

        }

      }catch(err){

        console.error(err);
      }
    };

  ws.onclose =
    () => {

      setTimeout(
        connectWS,
        3000
      );
    };
}

/*
  Timeframe buttons
*/

document
  .querySelectorAll('.tf')
  .forEach(btn=>{

    btn.onclick = ()=>{

      document
        .querySelectorAll('.tf')
        .forEach(x =>
          x.classList.remove('active')
        );

      btn.classList.add('active');

      state.timeframe =
        btn.dataset.tf;

      loadChart();
    };
  });

document
  .getElementById('refreshBtn')
  .onclick = async ()=>{

    try{

      await fetch(
        '/api/scan',
        {
          method:'POST'
        }
      );

    }catch(err){

      console.error(err);
    }
  };

/*
  Initial
*/

(async function(){

  await refresh();

  /*
    Status'tan radar gelmediyse
    ilk grafik BTC yerine aktif sinyal
    veya fallback olarak BTC.
  */

  if(!state.symbol){

    if(state.signals.length){
      state.symbol =
        state.signals[0].symbol;
    }else{
      state.symbol =
        'BTCUSDT';
    }
  }

  renderRadar();

  await loadChart();

  connectWS();

  setInterval(
    refresh,
    15000
  );

  setInterval(
    loadChart,
    30000
  );

})();

</script>

</body>
</html>`);
});

/* =========================================================
   WEBSOCKET STATE
========================================================= */

function buildClientState() {

  const radar =
    STATE.candidates.map(c => {

      const ticker =
        STATE.tickers.get(c.symbol);

      return {
        symbol: c.symbol,
        last: ticker ? ticker.last : 0,
        change: ticker ? ticker.change : 0,
        turnover: ticker ? ticker.turnover : 0
      };
    });

  return {

    type: 'state',

    stats: {
      ...STATE.stats,
      pending: STATE.pending.size,
      signals: STATE.signals.size
    },

    market: STATE.market,

    radar,

    signals:
      [...STATE.signals.values()]
        .sort(
          (a,b) =>
            b.score - a.score
        ),

    pending:
      [...STATE.pending.values()]
        .sort(
          (a,b) =>
            b.createdAt -
            a.createdAt
        )
        .slice(0, 20)
  };
}

function broadcastState(){

  const payload =
    safeJson(
      buildClientState()
    );

  wss.clients.forEach(client => {

    if(
      client.readyState ===
      WebSocket.OPEN
    ){
      client.send(payload);
    }

  });
}

wss.on('connection', ws => {

  ws.send(
    safeJson(
      buildClientState()
    )
  );

});

/* =========================================================
   ERROR HANDLERS
========================================================= */

process.on('unhandledRejection', err => {

  console.error(
    'UNHANDLED REJECTION:',
    err
  );

});

process.on('uncaughtException', err => {

  console.error(
    'UNCAUGHT EXCEPTION:',
    err
  );

});

/* =========================================================
   START
========================================================= */

async function start(){

  console.log('');
  console.log('==============================================');
  console.log('🚀 SONNY AI TRADER V6.1');
  console.log('📡 Bitget USDT Futures');
  console.log('🛰️ Radar:', CFG.RADAR_LIMIT, 'Coin');
  console.log('🎯 Candidate:', CFG.CANDIDATE_LIMIT);
  console.log('🔬 Deep:', CFG.DEEP_LIMIT);
  console.log('📊 4H + 2H → 15M Breakout → Retest → 5M');
  console.log('💰 Minimum Volume:', '$' + CFG.MIN_TURNOVER_24H);
  console.log('🎯 Minimum R:R:', '1:' + CFG.MIN_RR);
  console.log('⏱️ Scan:', CFG.SCAN_MS / 1000, 'sec');
  console.log('🤖 Auto Trade: KAPALI');
  console.log('==============================================');

  try{

    await loadMarkets();

  }catch(err){

    console.error(
      'MARKET LOAD ERROR:',
      err.message
    );

  }

  server.listen(
    PORT,
    '0.0.0.0',
    () => {

      console.log(
        `🌐 Server listening on ${PORT}`
      );

      /*
        İlk tarama.
      */

      scan();

      /*
        Düzenli tarama.
      */

      setInterval(
        scan,
        CFG.SCAN_MS
      );

    }
  );
}

start();
