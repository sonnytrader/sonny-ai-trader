'use strict';

/*
=============================================================
 SONNY AI TRADER — RED TEAM V3
 MOMENTUM SCALPER / MANUEL GİRİŞ

 500 RADAR
   ↓
 50 CANLI
   ↓
 15M BAĞLAM
   ↓
 LIVE FİYAT + TRADE FLOW + OI + HACİM HIZI
   ↓
 🟡 İZLE → 🟠 HAREKET BAŞLADI → 🔵 BEKLE → 🟢 GİRİŞ → 🔴 ZAYIFLAMA

 AUTO TRADE: KAPALI
 GEÇMİŞ SİNYAL: UI'YA VERİLMEZ
=============================================================
*/

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const ccxt = require('ccxt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

const CFG = {
  RADAR: 500,
  LIVE_SYMBOLS: 50,
  CONTEXT_SYMBOLS: 50,

  MIN_VOLUME_USDT: Number(
    process.env.MIN_VOLUME_USDT || 1000000
  ),

  DISCOVERY_MS: 2 * 60 * 1000,
  CONTEXT_MS: 60 * 1000,
  CANDLE_CACHE_MS: 45 * 1000,

  MAX_SIGNALS: 8,
  MAX_ENTRY_SIGNALS: 3,

  COOLDOWN_MS: 25 * 60 * 1000,
  WATCH_TTL_MS: 4 * 60 * 1000,
  ENTRY_TTL_MS: 75 * 1000,

  WATCH_SCORE: 52,
  IGNITION_SCORE: 64,
  WAIT_SCORE: 72,
  ENTRY_SCORE: 82,

  VOLUME_WATCH: 1.25,
  VOLUME_IGNITION: 1.60,
  VOLUME_ENTRY: 2.00,

  FLOW_WATCH: 0.54,
  FLOW_IGNITION: 0.57,
  FLOW_ENTRY: 0.63,

  PRICE_10S_WATCH: 0.05,
  PRICE_15S_IGNITION: 0.10,
  PRICE_30S_ENTRY: 0.22,

  OI_CONFIRM_PCT: 0.08,
  OI_STRONG_PCT: 0.25,

  MAX_SPREAD_PCT: 0.12,

  MAX_EXTENSION_ATR: 1.20,
  MAX_EXTENSION_PCT: 0.75,

  EXHAUST_FLOW_DROP: 0.09,
  EXHAUST_PRICE_STALL: 0.03,
  EXHAUST_VOLUME_DROP: 0.35,

  EMA: 21,
  ATR: 10,
  BREAKOUT_LOOKBACK: 12,

  M15_LIMIT: 160,
  M5_LIMIT: 60,
  M1_LIMIT: 60,

  WS_URL: 'wss://ws.bitget.com/v2/ws/public',

  WS_GROUP_SIZE: 15,
  WS_PING_MS: 25 * 1000,
  WS_STALE_MS: 70 * 1000,

  BROADCAST_MS: 250,

  DEBUG: process.env.DEBUG === 'true'
};

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 25000,
  options: {
    defaultType: 'swap'
  }
});

const STATE = {
  markets: [],
  marketMap: new Map(),

  universe: [],
  liveUniverse: [],

  context: new Map(),
  live: new Map(),

  signals: new Map(),
  cooldowns: new Map(),

  selected: 'BTC/USDT:USDT',
  selectedTf: '15m',

  ws: [],
  wsConnected: false,
  wsLastMessage: 0,
  wsReconnects: 0,

  lastDiscovery: 0,
  lastContext: 0,

  scanning: false,
  lastError: '',

  market: {
    label: 'YATAY / KARIŞIK',
    direction: 'FLAT',
    breadth: 50,
    green: 0,
    red: 0,
    average: 0,
    btc: 'NÖTR',
    eth: 'NÖTR'
  },

  stats: {
    universe: 0,
    live: 0,
    watching: 0,
    ignition: 0,
    wait: 0,
    entries: 0,
    exhaustion: 0,
    errors: 0
  }
};

const candleCache = new Map();

let restBusy = false;
const restQueue = [];

let broadcastTimer = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function avg(arr) {
  return arr.length
    ? arr.reduce((x, y) => x + y, 0) / arr.length
    : 0;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function num(v, d = 6) {
  const n = Number(v);

  return Number.isFinite(n)
    ? Number(n.toFixed(d))
    : 0;
}

function pct(a, b) {
  return b
    ? ((a - b) / b) * 100
    : 0;
}

function fmt(v) {
  const n = Number(v);

  if (!Number.isFinite(n)) return '-';

  if (n >= 1000) return n.toFixed(2);
  if (n >= 100) return n.toFixed(3);
  if (n >= 1) return n.toFixed(5);
  if (n >= 0.01) return n.toFixed(7);
  if (n >= 0.0001) return n.toFixed(8);

  return n.toFixed(10);
}

function volumeFmt(v) {
  const n = Number(v) || 0;

  if (n >= 1e9) {
    return (n / 1e9).toFixed(2) + 'B';
  }

  if (n >= 1e6) {
    return (n / 1e6).toFixed(2) + 'M';
  }

  if (n >= 1e3) {
    return (n / 1e3).toFixed(1) + 'K';
  }

  return Math.round(n).toString();
}

function cleanSymbol(symbol) {
  let s = String(symbol || '')
    .toUpperCase()
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(':USDT', '');

  if (s.endsWith('USDT')) {
    s = s.slice(0, -4);
  }

  return s + 'USDT';
}

function ccxtSymbol(instId) {
  return `${instId.replace('USDT', '')}/USDT:USDT`;
}

function closed(candles) {
  if (!Array.isArray(candles)) {
    return [];
  }

  return candles.length > 1
    ? candles.slice(0, -1)
    : candles;
}


/* =========================================================
   REST QUEUE
========================================================= */

async function processRestQueue() {
  if (restBusy) return;

  restBusy = true;

  while (restQueue.length) {
    const task = restQueue.shift();

    try {
      task.resolve(await task.fn());
    } catch (e) {
      task.reject(e);
    }

    await sleep(350);
  }

  restBusy = false;
}

function rest(fn) {
  return new Promise((resolve, reject) => {
    restQueue.push({
      fn,
      resolve,
      reject
    });

    processRestQueue();
  });
}


/* =========================================================
   MARKET
========================================================= */

async function loadMarkets() {
  const markets = await exchange.loadMarkets(true);

  STATE.markets = Object.values(markets).filter(m =>
    m &&
    m.active !== false &&
    m.swap === true &&
    m.linear === true &&
    m.quote === 'USDT' &&
    m.settle === 'USDT'
  );

  STATE.marketMap = new Map(
    STATE.markets.map(m => [m.symbol, m])
  );

  console.log(
    `MARKETLER | USDT perpetual: ${STATE.markets.length}`
  );
}

async function loadMarketsRetry() {
  let last;

  for (let i = 0; i < 3; i++) {
    try {
      await loadMarkets();
      return;
    } catch (e) {
      last = e;

      console.error(
        `Market yükleme ${i + 1}/3:`,
        e.message
      );

      await sleep(2500);
    }
  }

  throw last;
}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
  symbol,
  timeframe = '15m',
  limit = 160
) {
  const key = `${symbol}|${timeframe}|${limit}`;

  const cached = candleCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < CFG.CANDLE_CACHE_MS
  ) {
    return cached.data;
  }

  try {
    const data = await rest(() =>
      exchange.fetchOHLCV(
        symbol,
        timeframe,
        undefined,
        limit
      )
    );

    const clean = Array.isArray(data)
      ? data
          .filter(
            x =>
              Array.isArray(x) &&
              x.length >= 6
          )
          .sort((a, b) => a[0] - b[0])
      : [];

    candleCache.set(key, {
      time: Date.now(),
      data: clean
    });

    return clean;
  } catch (e) {
    STATE.lastError = e.message;

    if (CFG.DEBUG) {
      console.error(
        `Mum alınamadı ${symbol} ${timeframe}:`,
        e.message
      );
    }

    return cached ? cached.data : [];
  }
}


/* =========================================================
   TECHNICALS
========================================================= */

function ATR(
  candles,
  period = CFG.ATR
) {
  const c = closed(candles);

  if (c.length < period + 1) {
    return 0;
  }

  const tr = [];

  for (let i = 1; i < c.length; i++) {
    const high = +c[i][2];
    const low = +c[i][3];
    const previousClose = +c[i - 1][4];

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  return avg(tr.slice(-period));
}

function EMA(
  candles,
  period = CFG.EMA
) {
  const c = closed(candles);

  if (c.length < period) {
    return 0;
  }

  const closes = c.map(x => +x[4]);
  const k = 2 / (period + 1);

  let e = avg(
    closes.slice(0, period)
  );

  for (
    let i = period;
    i < closes.length;
    i++
  ) {
    e =
      closes[i] * k +
      e * (1 - k);
  }

  return e;
}

function VWAP(
  candles,
  lookback = 80
) {
  const c = closed(candles)
    .slice(-lookback);

  let pv = 0;
  let volume = 0;

  for (const x of c) {
    const typicalPrice =
      (+x[2] + +x[3] + +x[4]) / 3;

    const vol = +x[5] || 0;

    pv += typicalPrice * vol;
    volume += vol;
  }

  return volume
    ? pv / volume
    : 0;
}


/* =========================================================
   15M CONTEXT
========================================================= */

function buildContext(candles) {
  const c = closed(candles);

  if (c.length < 60) {
    return null;
  }

  const last = c[c.length - 1];
  const close = +last[4];

  const ema = EMA(candles);
  const vwap = VWAP(candles);
  const atr = ATR(candles);

  if (!ema || !vwap || !atr) {
    return null;
  }

  const recent = c.slice(
    -CFG.BREAKOUT_LOOKBACK - 1,
    -1
  );

  const recentHigh = Math.max(
    ...recent.map(x => +x[2])
  );

  const recentLow = Math.min(
    ...recent.map(x => +x[3])
  );

  const ranges = c
    .slice(-16)
    .map(x => +x[2] - +x[3]);

  const recentRange = avg(
    ranges.slice(-4)
  );

  const oldRange = avg(
    ranges.slice(0, 12)
  );

  const compression =
    oldRange > 0
      ? recentRange / oldRange
      : 1;

  let direction = 'FLAT';

  if (
    close > ema &&
    close > vwap
  ) {
    direction = 'LONG';
  } else if (
    close < ema &&
    close < vwap
  ) {
    direction = 'SHORT';
  }

  return {
    direction,
    close,
    ema,
    vwap,
    atr,
    recentHigh,
    recentLow,
    compression,
    updatedAt: Date.now()
  };
}


/* =========================================================
   RADAR
========================================================= */

async function discoverUniverse() {
  try {
    const tickers = await rest(() =>
      exchange.fetchTickers()
    );

    const rows = [];

    for (const market of STATE.markets) {
      const ticker = tickers[market.symbol];

      if (!ticker) {
        continue;
      }

      const price = Number(
        ticker.last || ticker.close
      );

      const volume = Number(
        ticker.quoteVolume || 0
      );

      const change = Number(
        ticker.percentage || 0
      );

      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        volume < CFG.MIN_VOLUME_USDT
      ) {
        continue;
      }

      rows.push({
        symbol: market.symbol,
        instId: cleanSymbol(market.symbol),
        price,
        volume,
        volumeFormatted: volumeFmt(volume),
        change
      });
    }

    rows.sort((a, b) => {
      const sa =
        Math.abs(a.change) * 0.70 +
        Math.log10(a.volume + 1) * 0.30;

      const sb =
        Math.abs(b.change) * 0.70 +
        Math.log10(b.volume + 1) * 0.30;

      return sb - sa;
    });

    STATE.universe =
      rows.slice(0, CFG.RADAR);

    STATE.liveUniverse =
      STATE.universe.slice(
        0,
        CFG.LIVE_SYMBOLS
      );

    STATE.stats.universe =
      STATE.universe.length;

    STATE.stats.live =
      STATE.liveUniverse.length;

    calculateMarketRegime(
      STATE.universe
    );

    STATE.lastDiscovery =
      Date.now();

    console.log(
      `RADAR | ${STATE.universe.length} coin | LIVE ${STATE.liveUniverse.length}`
    );

    return true;
  } catch (e) {
    STATE.lastError = e.message;
    STATE.stats.errors++;

    console.error(
      'RADAR HATASI:',
      e.message
    );

    return false;
  }
}


/* =========================================================
   MARKET REGIME
========================================================= */

function calculateMarketRegime(rows) {
  if (!rows.length) {
    return;
  }

  let green = 0;
  let red = 0;
  let total = 0;

  for (const r of rows) {
    if (r.change > 0.5) {
      green++;
    }

    if (r.change < -0.5) {
      red++;
    }

    total += r.change;
  }

  const breadth =
    green /
    Math.max(green + red, 1) *
    100;

  const average =
    total / rows.length;

  const btc = rows.find(
    r => r.symbol.includes('BTC')
  );

  const eth = rows.find(
    r => r.symbol.includes('ETH')
  );

  let direction = 'FLAT';
  let label = 'YATAY / KARIŞIK';

  if (
    breadth >= 55 &&
    average >= 0.5
  ) {
    direction = 'LONG';
    label = 'POZİTİF / YÜKSELİŞ';
  } else if (
    breadth <= 45 &&
    average <= -0.5
  ) {
    direction = 'SHORT';
    label = 'NEGATİF / DÜŞÜŞ';
  }

  STATE.market = {
    label,
    direction,
    breadth: num(breadth, 1),
    green,
    red,
    average: num(average, 2),

    btc:
      btc?.change > 1
        ? 'LONG'
        : btc?.change < -1
          ? 'SHORT'
          : 'NÖTR',

    eth:
      eth?.change > 1
        ? 'LONG'
        : eth?.change < -1
          ? 'SHORT'
          : 'NÖTR'
  };
}


/* =========================================================
   LIVE DATA
========================================================= */

function getLive(instId) {
  if (!STATE.live.has(instId)) {
    STATE.live.set(instId, {
      symbol: ccxtSymbol(instId),

      price: 0,
      bid: 0,
      ask: 0,

      volume24h: 0,
      oi: 0,

      prices: [],
      trades: [],
      oiSamples: [],

      buyNotional: 0,
      sellNotional: 0,

      lastUpdate: 0,

      lastMomentum: null,

      localMinute: null,
      local5m: null
    });
  }

  return STATE.live.get(instId);
}

function trimLive(
  live,
  now = Date.now()
) {
  while (
    live.prices.length &&
    live.prices[0].time <
      now - 120000
  ) {
    live.prices.shift();
  }

  while (
    live.trades.length &&
    live.trades[0].time <
      now - 120000
  ) {
    live.trades.shift();
  }

  while (
    live.oiSamples.length &&
    live.oiSamples[0].time <
      now - 120000
  ) {
    live.oiSamples.shift();
  }
}

function addTicker(
  instId,
  data
) {
  const live = getLive(instId);

  const price = Number(
    data.lastPr ||
    data.last ||
    data.close ||
    0
  );

  if (!price) {
    return;
  }

  const now = Date.now();

  live.price = price;

  live.bid = Number(
    data.bidPr || 0
  );

  live.ask = Number(
    data.askPr || 0
  );

  live.volume24h = Number(
    data.quoteVolume || 0
  );

  const oi = Number(
    data.holdingAmount ||
    data.openInterest ||
    0
  );

  if (oi > 0) {
    live.oi = oi;

    live.oiSamples.push({
      time: now,
      value: oi
    });
  }

  live.prices.push({
    time: now,
    value: price
  });

  live.lastUpdate = now;

  trimLive(
    live,
    now
  );

  evaluateLive(instId);
}

function addTrade(
  instId,
  data
) {
  const live = getLive(instId);

  const price = Number(data.price);
  const size = Number(data.size);

  if (!price || !size) {
    return;
  }

  const notional =
    price * size;

  const now = Date.now();

  const side =
    String(data.side || '')
      .toLowerCase();

  if (side === 'buy') {
    live.buyNotional +=
      notional;
  } else {
    live.sellNotional +=
      notional;
  }

  live.trades.push({
    time: now,
    side,
    notional
  });

  live.lastUpdate = now;

  trimLive(
    live,
    now
  );

  evaluateLive(instId);
}

function windowTrades(
  live,
  ms
) {
  const cut =
    Date.now() - ms;

  return live.trades.filter(
    t => t.time >= cut
  );
}

function flowRatio(
  live,
  ms = 30000
) {
  const trades =
    windowTrades(live, ms);

  let buy = 0;
  let sell = 0;

  for (const t of trades) {
    if (t.side === 'buy') {
      buy += t.notional;
    } else {
      sell += t.notional;
    }
  }

  return buy + sell
    ? buy / (buy + sell)
    : 0.5;
}

function priceMove(
  live,
  ms
) {
  const cut =
    Date.now() - ms;

  let base = null;

  for (const p of live.prices) {
    if (p.time >= cut) {
      base = p;
      break;
    }
  }

  return base
    ? pct(live.price, base.value)
    : 0;
}

function oiMove(
  live,
  ms = 30000
) {
  const cut =
    Date.now() - ms;

  let base = null;

  for (const x of live.oiSamples) {
    if (x.time >= cut) {
      base = x;
      break;
    }
  }

  return (
    base &&
    base.value
  )
    ? (
        (live.oi - base.value) /
        Math.abs(base.value)
      ) * 100
    : 0;
}

function liveVolumeRatio(
  live,
  ms = 30000
) {
  if (!live.volume24h) {
    return 1;
  }

  const expected =
    live.volume24h /
    (24 * 60 * 60 * 1000) *
    ms;

  const actual =
    windowTrades(
      live,
      ms
    ).reduce(
      (sum, t) =>
        sum + t.notional,
      0
    );

  return expected > 0
    ? actual / expected
    : 1;
}

function spreadPct(live) {
  return (
    live.bid &&
    live.ask
  )
    ? (
        (live.ask - live.bid) /
        ((live.ask + live.bid) / 2)
      ) * 100
    : 0;
}


/* =========================================================
   MOMENTUM ENGINE
========================================================= */

function calculateMomentum(
  instId,
  context
) {
  const live = getLive(instId);

  if (
    !live.price ||
    !context
  ) {
    return null;
  }

  const p10 =
    priceMove(live, 10000);

  const p15 =
    priceMove(live, 15000);

  const p30 =
    priceMove(live, 30000);

  const p60 =
    priceMove(live, 60000);

  const flow =
    flowRatio(live);

  const volume =
    liveVolumeRatio(
      live,
      30000
    );

  const oi =
    oiMove(live, 30000);

  const spread =
    spreadPct(live);

  let direction = null;

  if (
    context.direction === 'LONG' &&
    p10 > 0
  ) {
    direction = 'LONG';
  }

  if (
    context.direction === 'SHORT' &&
    p10 < 0
  ) {
    direction = 'SHORT';
  }

  if (
    !direction &&
    p30 > 0.12 &&
    flow > 0.60
  ) {
    direction = 'LONG';
  }

  if (
    !direction &&
    p30 < -0.12 &&
    flow < 0.40
  ) {
    direction = 'SHORT';
  }

  if (!direction) {
    return null;
  }

  const strengthFlow =
    direction === 'LONG'
      ? flow
      : 1 - flow;

  const priceAbs =
    Math.abs(p30);

  let score = 0;

  score += clamp(
    priceAbs / 0.45 * 25,
    0,
    25
  );

  score += clamp(
    (strengthFlow - 0.50) /
      0.28 *
      25,
    0,
    25
  );

  score += clamp(
    (volume - 1) /
      3 *
      20,
    0,
    20
  );

  /*
   * PRICE + OI ALIGNMENT
   */
  const oiAligned =
    (direction === 'LONG' && oi > 0) ||
    (direction === 'SHORT' && oi > 0);

  const oiDivergence =
    (direction === 'LONG' && oi < -0.15) ||
    (direction === 'SHORT' && oi < -0.15);

  if (oiAligned) {
    score += clamp(
      Math.abs(oi) / 1.5 * 15,
      0,
      15
    );
  } else if (oiDivergence) {
    score += 3;
  } else {
    score += 6;
  }

  /*
   * BREAKOUT
   */
  const breakout =
    direction === 'LONG'
      ? live.price > context.recentHigh
      : live.price < context.recentLow;

  if (breakout) {
    score += 10;
  }

  /*
   * COMPRESSION
   */
  if (context.compression < 0.80) {
    score += 5;
  } else if (
    context.compression < 1
  ) {
    score += 2;
  }

  /*
   * SPREAD PENALTY
   */
  if (
    spread >
    CFG.MAX_SPREAD_PCT
  ) {
    score -= 12;
  }

  return {
    direction,

    score: Math.round(
      clamp(score, 0, 100)
    ),

    price: live.price,

    priceMove10s:
      num(p10, 3),

    priceMove15s:
      num(p15, 3),

    priceMove30s:
      num(p30, 3),

    priceMove60s:
      num(p60, 3),

    flow:
      num(flow * 100, 1),

    volumeRatio:
      num(volume, 2),

    oiChange:
      num(oi, 3),

    spread:
      num(spread, 4),

    breakout,

    compression:
      num(
        context.compression,
        2
      )
  };
}


/* =========================================================
   TOO LATE / FOMO
========================================================= */

function tooLate(
  momentum,
  context
) {
  if (
    !momentum ||
    !context
  ) {
    return false;
  }

  const level =
    momentum.direction === 'LONG'
      ? context.recentHigh
      : context.recentLow;

  const distance =
    Math.abs(
      momentum.price - level
    );

  const atrExtension =
    context.atr
      ? distance / context.atr
      : 0;

  return (
    atrExtension >
      CFG.MAX_EXTENSION_ATR ||
    Math.abs(
      momentum.priceMove30s
    ) >
      CFG.MAX_EXTENSION_PCT
  );
}


/* =========================================================
   EXHAUSTION
========================================================= */

function exhaustion(
  signal,
  momentum
) {
  if (
    !signal ||
    !momentum
  ) {
    return false;
  }

  const flowNow =
    momentum.direction === 'LONG'
      ? momentum.flow / 100
      : 1 - momentum.flow / 100;

  const flowDrop =
    (signal.lastFlow ?? flowNow) -
    flowNow;

  const volumeDrop =
    signal.lastVolume
      ? signal.lastVolume -
        momentum.volumeRatio
      : 0;

  const stall =
    Math.abs(
      momentum.priceMove15s
    ) <
    CFG.EXHAUST_PRICE_STALL;

  const weakFlow =
    flowDrop >=
    CFG.EXHAUST_FLOW_DROP;

  const weakVolume =
    volumeDrop >=
    CFG.EXHAUST_VOLUME_DROP;

  signal.lastFlow =
    flowNow;

  signal.lastVolume =
    momentum.volumeRatio;

  return (
    (weakFlow && stall) ||
    (weakVolume && stall)
  );
}


/* =========================================================
   TRADE PLAN
========================================================= */

function makePlan(
  direction,
  price,
  context
) {
  const risk =
    Math.max(
      context.atr * 0.65,
      price * 0.0025
    );

  if (!risk) {
    return null;
  }

  if (
    direction === 'LONG'
  ) {
    return {
      entry: price,
      stop: price - risk,
      tp1: price + risk,
      tp2: price + risk * 1.7,
      tp3: price + risk * 2.5,
      risk
    };
  }

  return {
    entry: price,
    stop: price + risk,
    tp1: price - risk,
    tp2: price - risk * 1.7,
    tp3: price - risk * 2.5,
    risk
  };
}


/* =========================================================
   REASON
========================================================= */

function reasonFor(
  momentum,
  context
) {
  const reasons = [];

  if (momentum.breakout) {
    reasons.push('kırılım');
  }

  if (
    momentum.volumeRatio >=
    CFG.VOLUME_ENTRY
  ) {
    reasons.push(
      'hacim patlaması'
    );
  } else if (
    momentum.volumeRatio >=
    CFG.VOLUME_IGNITION
  ) {
    reasons.push(
      'hacim artışı'
    );
  }

  if (
    momentum.direction === 'LONG' &&
    momentum.flow >= 63
  ) {
    reasons.push(
      'alış baskısı'
    );
  }

  if (
    momentum.direction === 'SHORT' &&
    momentum.flow <= 37
  ) {
    reasons.push(
      'satış baskısı'
    );
  }

  if (
    momentum.oiChange >=
    CFG.OI_CONFIRM_PCT
  ) {
    reasons.push(
      'OI destekli'
    );
  }

  if (
    context.compression < 0.8
  ) {
    reasons.push(
      'sıkışma sonrası'
    );
  }

  return reasons.length
    ? reasons.join(' + ')
    : 'momentum oluşuyor';
}


/* =========================================================
   STAGES
========================================================= */

function stageStatus(stage) {
  return {
    WATCH: 'İZLE',
    IGNITION: 'HAREKET BAŞLADI',
    WAIT: 'BEKLE',
    ENTRY: 'GİRİŞ FIRSATI',
    EXHAUSTION:
      'MOMENTUM ZAYIFLIYOR',
    TOO_LATE: 'GEÇ KALINDI'
  }[stage] || stage;
}

function stageClass(stage) {
  if (stage === 'WATCH') {
    return 'watch';
  }

  if (stage === 'IGNITION') {
    return 'ignition';
  }

  if (stage === 'WAIT') {
    return 'wait';
  }

  if (stage === 'ENTRY') {
    return 'entry';
  }

  return 'bad';
}


/* =========================================================
   SIGNAL
========================================================= */

function createSignal(
  instId,
  momentum,
  context,
  stage
) {
  const plan =
    makePlan(
      momentum.direction,
      momentum.price,
      context
    );

  if (!plan) {
    return null;
  }

  const now = Date.now();

  return {
    id:
      `${instId}|${momentum.direction}`,

    symbol:
      ccxtSymbol(instId),

    marketSymbol:
      ccxtSymbol(instId),

    instId,

    direction:
      momentum.direction,

    stage,

    status:
      stageStatus(stage),

    stageClass:
      stageClass(stage),

    signalAt:
      now,

    lastUpdate:
      now,

    ageSeconds:
      0,

    entry:
      num(plan.entry),

    entryLow:
      num(
        momentum.direction === 'LONG'
          ? plan.entry * 0.998
          : plan.entry * 1.002
      ),

    entryHigh:
      num(
        momentum.direction === 'LONG'
          ? plan.entry * 1.002
          : plan.entry * 0.998
      ),

    stop:
      num(plan.stop),

    tp1:
      num(plan.tp1),

    tp2:
      num(plan.tp2),

    tp3:
      num(plan.tp3),

    rr: 1,

    currentPrice:
      num(momentum.price),

    score:
      momentum.score,

    momentumScore:
      momentum.score,

    priceMove10s:
      momentum.priceMove10s,

    priceMove15s:
      momentum.priceMove15s,

    priceMove30s:
      momentum.priceMove30s,

    priceMove60s:
      momentum.priceMove60s,

    flow:
      momentum.flow,

    volumeRatio:
      momentum.volumeRatio,

    oiChange:
      momentum.oiChange,

    spread:
      momentum.spread,

    breakout:
      momentum.breakout,

    compression:
      momentum.compression,

    contextDirection:
      context.direction,

    ema:
      num(context.ema),

    vwap:
      num(context.vwap),

    atr:
      num(context.atr),

    reason:
      reasonFor(
        momentum,
        context
      ),

    entryWindowEnds:
      null,

    lastFlow:
      momentum.direction === 'LONG'
        ? momentum.flow / 100
        : 1 - momentum.flow / 100,

    lastVolume:
      momentum.volumeRatio,

    lastReason:
      'Yeni canlı hareket',

    stageAt:
      now,

    tf5Confirm:
      false,

    tf1Confirm:
      false,

    tfConfirmAt:
      0,

    tfConfirmPending:
      false
  };
}

function activeSignalFor(
  instId
) {
  return [
    ...STATE.signals.values()
  ].find(
    s => s.instId === instId
  );
}

function entryCount() {
  return [
    ...STATE.signals.values()
  ].filter(
    s => s.stage === 'ENTRY'
  ).length;
}

function setStage(
  signal,
  stage,
  reason
) {
  signal.stage = stage;

  signal.status =
    stageStatus(stage);

  signal.stageClass =
    stageClass(stage);

  signal.stageAt =
    Date.now();

  if (reason) {
    signal.lastReason =
      reason;
  }
}


/* =========================================================
   LOWER TIMEFRAME CONFIRMATION
========================================================= */

async function confirmLowerTimeframes(
  signal
) {
  if (
    !signal ||
    signal.tfConfirmPending
  ) {
    return;
  }

  signal.tfConfirmPending = true;

  try {
    const m5 =
      await getCandles(
        signal.symbol,
        '5m',
        CFG.M5_LIMIT
      );

    const m1 =
      await getCandles(
        signal.symbol,
        '1m',
        CFG.M1_LIMIT
      );

    const c5 =
      closed(m5);

    const c1 =
      closed(m1);

    if (c5.length >= 8) {
      const last =
        c5[c5.length - 1];

      const prev =
        c5[c5.length - 2];

      const avgVol =
        avg(
          c5
            .slice(-8, -1)
            .map(
              x => +x[5] || 0
            )
        );

      const volume =
        +last[5] || 0;

      signal.tf5Confirm =
        signal.direction === 'LONG'
          ? (
              +last[4] >
                +prev[4] &&
              volume >=
                avgVol * 0.9
            )
          : (
              +last[4] <
                +prev[4] &&
              volume >=
                avgVol * 0.9
            );
    }

    if (c1.length >= 6) {
      const last =
        c1[c1.length - 1];

      const prev =
        c1[c1.length - 2];

      const body =
        Math.abs(
          +last[4] -
          +last[1]
        );

      const range =
        Math.max(
          +last[2] -
            +last[3],
          1e-12
        );

      signal.tf1Confirm =
        signal.direction === 'LONG'
          ? (
              +last[4] >
                +prev[4] &&
              +last[4] >
                +last[1] &&
              body / range >= 0.25
            )
          : (
              +last[4] <
                +prev[4] &&
              +last[4] <
                +last[1] &&
              body / range >= 0.25
            );
    }

    signal.tfConfirmAt =
      Date.now();

  } catch (e) {
    signal.tf5Confirm = false;
    signal.tf1Confirm = false;

    signal.lastReason =
      'Alt zaman dilimi teyidi alınamadı';

  } finally {
    signal.tfConfirmPending =
      false;

    scheduleBroadcast();
  }
}


/* =========================================================
   SIGNAL UPDATE
========================================================= */

function updateSignal(
  signal,
  momentum,
  context
) {
  const now = Date.now();

  signal.lastUpdate = now;

  signal.ageSeconds =
    Math.floor(
      (now - signal.signalAt) /
      1000
    );

  Object.assign(
    signal,
    {
      currentPrice:
        num(momentum.price),

      score:
        momentum.score,

      momentumScore:
        momentum.score,

      priceMove10s:
        momentum.priceMove10s,

      priceMove15s:
        momentum.priceMove15s,

      priceMove30s:
        momentum.priceMove30s,

      priceMove60s:
        momentum.priceMove60s,

      flow:
        momentum.flow,

      volumeRatio:
        momentum.volumeRatio,

      oiChange:
        momentum.oiChange,

      spread:
        momentum.spread,

      breakout:
        momentum.breakout,

      compression:
        momentum.compression,

      reason:
        reasonFor(
          momentum,
          context
        )
    }
  );

  /*
   * SPREAD
   */
  if (
    momentum.spread >
    CFG.MAX_SPREAD_PCT
  ) {
    setStage(
      signal,
      'EXHAUSTION',
      'Spread fazla'
    );

    return;
  }

  /*
   * ENTRY -> TOO LATE
   */
  if (
    signal.stage === 'ENTRY' &&
    tooLate(
      momentum,
      context
    )
  ) {
    setStage(
      signal,
      'TOO_LATE',
      'Fiyat giriş bölgesinden uzaklaştı'
    );

    return;
  }

  /*
   * ENTRY -> EXHAUSTION
   */
  if (
    signal.stage === 'ENTRY' &&
    exhaustion(
      signal,
      momentum
    )
  ) {
    setStage(
      signal,
      'EXHAUSTION',
      'Alış/satış baskısı zayıfladı'
    );

    return;
  }

  /*
   * WATCH -> IGNITION
   */
  if (
    signal.stage === 'WATCH' &&
    momentum.score >=
      CFG.IGNITION_SCORE &&
    momentum.volumeRatio >=
      CFG.VOLUME_IGNITION
  ) {
    setStage(
      signal,
      'IGNITION',
      'Hacim ve fiyat hızlandı'
    );

    return;
  }

  /*
   * IGNITION / WATCH -> WAIT
   */
  if (
    (
      signal.stage === 'WATCH' ||
      signal.stage === 'IGNITION'
    ) &&
    momentum.score >=
      CFG.WAIT_SCORE &&
    momentum.breakout &&
    !tooLate(
      momentum,
      context
    )
  ) {
    setStage(
      signal,
      'WAIT',
      'Kırılım oluştu; 5M + 1M teyidi bekleniyor'
    );

    confirmLowerTimeframes(
      signal
    );

    return;
  }

  /*
   * WAIT -> REFRESH CONFIRMATION
   */
  if (
    signal.stage === 'WAIT' &&
    momentum.score >=
      CFG.WAIT_SCORE &&
    momentum.breakout &&
    !tooLate(
      momentum,
      context
    ) &&
    !signal.tfConfirmPending &&
    (
      !signal.tfConfirmAt ||
      now -
        signal.tfConfirmAt >
        30000
    )
  ) {
    confirmLowerTimeframes(
      signal
    );
  }

  /*
   * WAIT / IGNITION -> ENTRY
   */
  if (
    (
      signal.stage === 'WAIT' ||
      signal.stage === 'IGNITION'
    ) &&
    momentum.score >=
      CFG.ENTRY_SCORE &&
    momentum.volumeRatio >=
      CFG.VOLUME_ENTRY &&
    momentum.breakout &&
    !tooLate(
      momentum,
      context
    ) &&
    signal.tf5Confirm &&
    signal.tf1Confirm &&
    entryCount() <
      CFG.MAX_ENTRY_SIGNALS
  ) {
    const plan =
      makePlan(
        momentum.direction,
        momentum.price,
        context
      );

    if (plan) {
      signal.entry =
        num(plan.entry);

      signal.entryLow =
        num(
          momentum.direction === 'LONG'
            ? plan.entry * 0.998
            : plan.entry * 1.002
        );

      signal.entryHigh =
        num(
          momentum.direction === 'LONG'
            ? plan.entry * 1.002
            : plan.entry * 0.998
        );

      signal.stop =
        num(plan.stop);

      signal.tp1 =
        num(plan.tp1);

      signal.tp2 =
        num(plan.tp2);

      signal.tp3 =
        num(plan.tp3);
    }

    signal.entryWindowEnds =
      now +
      CFG.ENTRY_TTL_MS;

    setStage(
      signal,
      'ENTRY',
      'Giriş şartları tamamlandı'
    );

    return;
  }

  /*
   * WATCH / IGNITION / WAIT TTL
   */
  if (
    (
      signal.stage === 'WATCH' ||
      signal.stage === 'IGNITION' ||
      signal.stage === 'WAIT'
    ) &&
    now -
      signal.signalAt >
      CFG.WATCH_TTL_MS
  ) {
    setStage(
      signal,
      'EXHAUSTION',
      'Bekleme süresi doldu'
    );

    return;
  }
}


/* =========================================================
   LIVE EVALUATION
========================================================= */

function evaluateLive(instId) {
  const context =
    STATE.context.get(
      ccxtSymbol(instId)
    );

  if (!context) {
    return;
  }

  const momentum =
    calculateMomentum(
      instId,
      context
    );

  if (!momentum) {
    return;
  }

  let signal =
    activeSignalFor(instId);

  /*
   * YENİ SİNYAL
   */
  if (!signal) {
    if (
      momentum.score <
      CFG.WATCH_SCORE
    ) {
      return;
    }

    const key =
      `${instId}|${momentum.direction}`;

    const last =
      STATE.cooldowns.get(key);

    if (
      last &&
      Date.now() - last <
        CFG.COOLDOWN_MS
    ) {
      return;
    }

    if (
      STATE.signals.size >=
      CFG.MAX_SIGNALS
    ) {
      return;
    }

    let initialStage =
      'WATCH';

    if (
      momentum.score >=
        CFG.WAIT_SCORE &&
      momentum.breakout &&
      !tooLate(
        momentum,
        context
      )
    ) {
      initialStage =
        'WAIT';

    } else if (
      momentum.score >=
        CFG.IGNITION_SCORE &&
      momentum.volumeRatio >=
        CFG.VOLUME_IGNITION
    ) {
      initialStage =
        'IGNITION';
    }

    signal =
      createSignal(
        instId,
        momentum,
        context,
        initialStage
      );

    if (!signal) {
      return;
    }

    if (
      initialStage === 'WAIT'
    ) {
      signal.lastReason =
        'Kırılım oluştu; 5M + 1M teyidi bekleniyor';

      confirmLowerTimeframes(
        signal
      );
    }

    STATE.signals.set(
      signal.id,
      signal
    );

    console.log(
      `🟡 İZLE | ${signal.symbol} | ${signal.direction} | ${signal.score}`
    );

  } else {
    updateSignal(
      signal,
      momentum,
      context
    );
  }

  scheduleBroadcast();
}


/* =========================================================
   CLEANUP
========================================================= */

function closeSignal(
  signal,
  reason
) {
  STATE.signals.delete(
    signal.id
  );

  STATE.cooldowns.set(
    `${signal.instId}|${signal.direction}`,
    Date.now()
  );

  console.log(
    `FIRSAT KAPANDI | ${signal.symbol} | ${signal.status} | ${reason}`
  );

  scheduleBroadcast();
}

function cleanup() {
  const now = Date.now();

  for (
    const [id, signal]
    of STATE.signals
  ) {
    signal.ageSeconds =
      Math.floor(
        (now - signal.signalAt) /
        1000
      );

    signal.stageClass =
      stageClass(
        signal.stage
      );

    if (
      signal.stage === 'ENTRY' &&
      signal.entryWindowEnds &&
      now >
        signal.entryWindowEnds
    ) {
      setStage(
        signal,
        'EXHAUSTION',
        'Giriş penceresi kapandı'
      );
    }

    if (
      signal.stage === 'TOO_LATE' ||
      signal.stage === 'EXHAUSTION'
    ) {
      if (
        now -
          signal.lastUpdate >
        12000
      ) {
        closeSignal(
          signal,
          signal.lastReason ||
            'Durum sona erdi'
        );
      }
    }
  }

  for (
    const [key, timestamp]
    of STATE.cooldowns
  ) {
    if (
      now - timestamp >
      CFG.COOLDOWN_MS
    ) {
      STATE.cooldowns.delete(
        key
      );
    }
  }
}


/* =========================================================
   CONTEXT REFRESH
========================================================= */

async function refreshContexts() {
  if (STATE.scanning) {
    return;
  }

  STATE.scanning = true;

  try {
    const candidates =
      STATE.liveUniverse.slice(
        0,
        CFG.CONTEXT_SYMBOLS
      );

    for (const row of candidates) {
      const candles =
        await getCandles(
          row.symbol,
          '15m',
          CFG.M15_LIMIT
        );

      const context =
        buildContext(
          candles
        );

      if (context) {
        STATE.context.set(
          row.symbol,
          context
        );
      }
    }

    STATE.lastContext =
      Date.now();

  } catch (e) {
    STATE.lastError =
      e.message;

    STATE.stats.errors++;

  } finally {
    STATE.scanning = false;
  }
}


/* =========================================================
   BITGET WEBSOCKET
========================================================= */

function makeWsGroups() {
  const symbols =
    STATE.liveUniverse
      .slice(
        0,
        CFG.LIVE_SYMBOLS
      )
      .map(
        x => x.instId
      );

  const groups = [];

  for (
    let i = 0;
    i < symbols.length;
    i += CFG.WS_GROUP_SIZE
  ) {
    groups.push(
      symbols.slice(
        i,
        i + CFG.WS_GROUP_SIZE
      )
    );
  }

  return groups;
}

function subArgs(symbols) {
  const args = [];

  for (const instId of symbols) {
    args.push({
      instType:
        'USDT-FUTURES',

      channel:
        'ticker',

      instId
    });

    args.push({
      instType:
        'USDT-FUTURES',

      channel:
        'trade',

      instId
    });
  }

  return args;
}

function closeWsConnections() {
  for (
    const holder
    of STATE.ws
  ) {
    try {
      holder.manualClose =
        true;

      holder.ws.close();
    } catch (_) {}
  }

  STATE.ws = [];
  STATE.wsConnected =
    false;
}

function connectWsGroup(
  symbols,
  index
) {
  const ws =
    new WebSocket(
      CFG.WS_URL
    );

  const holder = {
    ws,
    symbols,
    index,
    manualClose: false,
    lastPong: Date.now()
  };

  STATE.ws.push(
    holder
  );

  ws.on('open', () => {
    holder.lastPong =
      Date.now();

    ws.send(
      JSON.stringify({
        op: 'subscribe',
        args: subArgs(symbols)
      })
    );

    console.log(
      `WS${index + 1} ABONELİK | ${symbols.length} coin | ${symbols.length * 2} kanal`
    );

    scheduleBroadcast();
  });

  ws.on('message', raw => {
    STATE.wsLastMessage =
      Date.now();

    holder.lastPong =
      Date.now();

    try {
      const text =
        raw.toString();

      if (text === 'pong') {
        return;
      }

      const msg =
        JSON.parse(text);

      if (
        msg.event === 'error'
      ) {
        STATE.lastError =
          `WS${index + 1}: ${
            msg.msg ||
            'subscribe error'
          }`;

        return;
      }

      const arg =
        msg.arg || {};

      const channel =
        arg.channel;

      const instId =
        arg.instId;

      const data =
        Array.isArray(msg.data)
          ? msg.data
          : [];

      if (
        !instId ||
        !data.length
      ) {
        return;
      }

      if (
        channel === 'ticker'
      ) {
        addTicker(
          instId,
          data[0]
        );
      } else if (
        channel === 'trade'
      ) {
        for (
          const trade
          of data
        ) {
          addTrade(
            instId,
            {
              price:
                trade.price,

              size:
                trade.size,

              side:
                trade.side
            }
          );
        }
      }

    } catch (e) {
      if (CFG.DEBUG) {
        console.error(
          'WS parse:',
          e.message
        );
      }
    }
  });

  ws.on('error', e => {
    STATE.lastError =
      `WS${index + 1}: ${e.message}`;

    console.error(
      `BITGET WS${index + 1} ERROR:`,
      e.message
    );
  });

  ws.on('close', () => {
    holder.closedAt =
      Date.now();

    STATE.wsReconnects++;

    STATE.wsConnected =
      STATE.ws.some(
        x =>
          x.ws.readyState ===
          WebSocket.OPEN
      );

    scheduleBroadcast();

    if (
      !holder.manualClose
    ) {
      setTimeout(
        () => rebuildWs(),
        Math.min(
          15000,
          2500 +
            STATE.wsReconnects *
              500
        )
      );
    }
  });
}

let wsRebuildLock = false;

function rebuildWs() {
  if (wsRebuildLock) {
    return;
  }

  wsRebuildLock = true;

  try {
    closeWsConnections();

    const groups =
      makeWsGroups();

    groups.forEach(
      (group, index) =>
        connectWsGroup(
          group,
          index
        )
    );

  } finally {
    setTimeout(
      () => {
        wsRebuildLock = false;
      },
      1000
    );
  }
}

function startWs() {
  rebuildWs();
}

function wsHealth() {
  const open =
    STATE.ws.filter(
      x =>
        x.ws.readyState ===
        WebSocket.OPEN
    ).length;

  STATE.wsConnected =
    open > 0;

  if (
    open === 0 &&
    STATE.liveUniverse.length
  ) {
    rebuildWs();
  }
}

setInterval(() => {
  for (
    const holder
    of STATE.ws
  ) {
    if (
      holder.ws.readyState ===
      WebSocket.OPEN
    ) {
      try {
        holder.ws.send(
          'ping'
        );
      } catch (_) {}
    }
  }

  wsHealth();

}, CFG.WS_PING_MS);

let lastWsSymbols = '';

function maybeRefreshWsSubscriptions() {
  const key =
    STATE.liveUniverse
      .map(
        x => x.instId
      )
      .join(',');

  if (
    key !==
    lastWsSymbols
  ) {
    lastWsSymbols =
      key;

    rebuildWs();
  }
}


/* =========================================================
   STATUS
========================================================= */

function getSignals() {
  const order = {
    ENTRY: 5,
    WAIT: 4,
    IGNITION: 3,
    WATCH: 2,
    EXHAUSTION: 1,
    TOO_LATE: 1
  };

  return [
    ...STATE.signals.values()
  ].sort(
    (a, b) =>
      (
        order[b.stage] -
        order[a.stage]
      ) ||
      (
        b.score -
        a.score
      )
  );
}

function status() {
  cleanup();

  const signals =
    getSignals();

  STATE.stats.watching =
    signals.filter(
      s =>
        s.stage === 'WATCH'
    ).length;

  STATE.stats.ignition =
    signals.filter(
      s =>
        s.stage === 'IGNITION'
    ).length;

  STATE.stats.wait =
    signals.filter(
      s =>
        s.stage === 'WAIT'
    ).length;

  STATE.stats.entries =
    signals.filter(
      s =>
        s.stage === 'ENTRY'
    ).length;

  STATE.stats.exhaustion =
    signals.filter(
      s =>
        s.stage === 'EXHAUSTION' ||
        s.stage === 'TOO_LATE'
    ).length;

  return {
    ok: true,

    now: Date.now(),

    lastDiscovery:
      STATE.lastDiscovery,

    lastContext:
      STATE.lastContext,

    error:
      STATE.lastError,

    ws: {
      connected:
        STATE.wsConnected,

      lastMessage:
        STATE.wsLastMessage,

      reconnects:
        STATE.wsReconnects,

      connections:
        STATE.ws.length,

      open:
        STATE.ws.filter(
          x =>
            x.ws.readyState ===
            WebSocket.OPEN
        ).length
    },

    market:
      STATE.market,

    stats: {
      ...STATE.stats,
      signals:
        signals.length
    },

    signals,

    selected:
      STATE.selected,

    selectedTf:
      STATE.selectedTf
  };
}


/* =========================================================
   BROADCAST
========================================================= */

function scheduleBroadcast() {
  if (broadcastTimer) {
    return;
  }

  broadcastTimer =
    setTimeout(() => {
      broadcastTimer =
        null;

      const payload =
        JSON.stringify({
          type:
            'snapshot',

          data:
            status()
        });

      for (
        const client
        of wss.clients
      ) {
        if (
          client.readyState ===
          WebSocket.OPEN
        ) {
          try {
            client.send(
              payload
            );
          } catch (_) {}
        }
      }
    }, CFG.BROADCAST_MS);
}


/* =========================================================
   API AUTH
========================================================= */

async function apiAuth(
  req,
  res,
  next
) {
  const token =
    process.env.API_TOKEN;

  if (!token) {
    return next();
  }

  const supplied =
    req.headers[
      'x-api-token'
    ] ||
    req.query.token;

  if (
    supplied !== token
  ) {
    return res
      .status(401)
      .json({
        error:
          'Unauthorized'
      });
  }

  next();
}


/* =========================================================
   API
========================================================= */

app.get(
  '/api/status',
  (req, res) =>
    res.json(
      status()
    )
);

app.get(
  '/api/health',
  (req, res) =>
    res.json({
      status: 'ok',

      uptime:
        process.uptime(),

      ws:
        STATE.wsConnected,

      lastError:
        STATE.lastError,

      connections:
        STATE.ws.length
    })
);

app.get(
  '/api/scan',
  apiAuth,
  async (req, res) => {
    try {
      await discoverUniverse();

      maybeRefreshWsSubscriptions();

      await refreshContexts();

      scheduleBroadcast();

      res.json({
        success: true,
        data: status()
      });

    } catch (e) {
      res
        .status(500)
        .json({
          success: false,
          error: e.message
        });
    }
  }
);

app.get(
  '/api/chart',
  apiAuth,
  async (req, res) => {
    try {
      const symbol =
        req.query.symbol ||
        'BTC/USDT:USDT';

      const timeframe =
        req.query.timeframe ||
        '15m';

      if (
        !STATE.marketMap.has(
          symbol
        )
      ) {
        return res.json({
          success: false,
          error:
            'Market bulunamadı'
        });
      }

      const limit =
        timeframe === '1m'
          ? 180
          : timeframe === '5m'
            ? 180
            : 160;

      const candles =
        await getCandles(
          symbol,
          timeframe,
          limit
        );

      const signal =
        getSignals().find(
          s =>
            s.marketSymbol ===
            symbol
        ) || null;

      res.json({
        success: true,
        symbol,
        timeframe,
        candles,
        signal
      });

    } catch (e) {
      res
        .status(500)
        .json({
          success: false,
          error: e.message
        });
    }
  }
);

app.get(
  '/api/history',
  apiAuth,
  (req, res) =>
    res.json({
      success: true,
      history: []
    })
);


/* =========================================================
   UI WS
========================================================= */

wss.on(
  'connection',
  ws => {
    try {
      ws.send(
        JSON.stringify({
          type:
            'snapshot',

          data:
            status()
        })
      );
    } catch (_) {}
  }
);


/* =========================================================
   FRONTEND
========================================================= */

const HTML = `
<!DOCTYPE html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER
</title>

<style>

:root{
  --bg:#070b10;
  --panel:#0d141d;
  --panel2:#111b27;
  --line:#1d2a38;
  --text:#e8eef5;
  --muted:#738296;
  --green:#16e0a1;
  --red:#ff4f70;
  --orange:#ff9e43;
  --yellow:#f2cf3d;
  --blue:#55a8ff;
  --purple:#a98bff;
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font:13px Arial,sans-serif;
}

.app{
  display:grid;
  grid-template-columns:
    310px
    minmax(0,1fr)
    350px;

  min-height:100vh;
}

.left,
.right{
  background:#0a1119;
  padding:14px;
  overflow:auto;
}

.left{
  border-right:
    1px solid var(--line);
}

.right{
  border-left:
    1px solid var(--line);
}

.brand{
  font-weight:800;
  font-size:17px;
  color:var(--green);
}

.sub{
  font-size:9px;
  color:var(--muted);
  margin:4px 0 14px;
}

.livebar{
  display:flex;
  align-items:center;
  gap:7px;
  color:var(--green);
  font-size:10px;
  margin-bottom:12px;
}

.pulse{
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:
    0 0 12px var(--green);
}

.pulse.off{
  background:var(--red);
  box-shadow:
    0 0 12px var(--red);
}

.section{
  margin:14px 0;
}

.sectionHead{
  display:flex;
  justify-content:space-between;
  align-items:center;

  font-size:10px;
  font-weight:800;

  color:var(--muted);

  margin-bottom:7px;
}

.count{
  background:#172333;
  border-radius:12px;
  padding:2px 7px;
  color:#dce5ef;
}

.card{
  background:var(--panel);

  border:
    1px solid var(--line);

  border-left:
    4px solid var(--yellow);

  border-radius:8px;

  padding:10px;
  margin:6px 0;

  cursor:pointer;
}

.card:hover{
  border-color:#3a5067;
}

.card.long{
  border-left-color:var(--green);
}

.card.short{
  border-left-color:var(--red);
}

.card.ignition{
  border-left-color:var(--orange);
}

.card.wait{
  border-left-color:var(--blue);
}

.card.bad{
  border-left-color:var(--red);
  opacity:.85;
}

.row{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:8px;
}

.coin{
  font-weight:800;
  font-size:13px;
}

.dir{
  font-size:9px;
  font-weight:800;

  padding:3px 6px;

  border-radius:4px;
}

.dir.long{
  background:#09362c;
  color:var(--green);
}

.dir.short{
  background:#3a1722;
  color:var(--red);
}

.stage{
  font-size:9px;
  font-weight:800;
  margin-top:7px;
}

.stage.watch{
  color:var(--yellow);
}

.stage.ignition{
  color:var(--orange);
}

.stage.wait{
  color:var(--blue);
}

.stage.entry{
  color:var(--green);
}

.stage.bad{
  color:var(--red);
}

.price{
  font-size:16px;
  font-weight:800;
  margin-top:5px;
}

.mini{
  font-size:9px;
  line-height:1.55;
  color:var(--muted);
  margin-top:5px;
}

.timer{
  font-size:9px;
  color:#dce5ef;
  margin-top:5px;
}

.main{
  padding:12px;
  min-width:0;
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:10px;
}

.title{
  font-weight:800;
  font-size:17px;
}

.conn{
  font-size:10px;
  font-weight:800;
  color:var(--green);
}

.chart{
  height:
    calc(100vh - 70px);

  min-height:520px;

  background:var(--panel);

  border:
    1px solid var(--line);

  border-radius:8px;

  position:relative;
}

.chartHeader{
  position:absolute;
  top:10px;
  left:12px;
  right:12px;

  display:flex;
  justify-content:space-between;
  align-items:center;

  z-index:2;
}

.chartTitle{
  font-weight:800;
}

.tfButtons{
  display:flex;
  gap:5px;
}

.tfButtons button{
  border:
    1px solid var(--line);

  background:#0b121a;
  color:var(--muted);

  border-radius:5px;

  padding:5px 8px;

  font-size:9px;
  font-weight:800;

  cursor:pointer;
}

.tfButtons button.active{
  color:var(--text);
  background:#172333;
}

#chart{
  width:100%;
  height:100%;
  display:block;
}

.box{
  background:var(--panel);

  border:
    1px solid var(--line);

  border-radius:8px;

  padding:11px;

  margin-bottom:10px;
}

.boxTitle{
  font-size:10px;
  font-weight:800;
  color:var(--muted);
  margin-bottom:8px;
}

.regime{
  font-size:16px;
  font-weight:800;
}

.regime.long{
  color:var(--green);
}

.regime.short{
  color:var(--red);
}

.metrics{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:5px;
  margin-top:8px;
}

.metric{
  display:flex;
  justify-content:space-between;
  gap:6px;

  padding:7px;

  background:#0a1119;

  border:
    1px solid var(--line);

  border-radius:5px;

  font-size:9px;
}

.metric span{
  color:var(--muted);
}

.metric b{
  color:var(--text);
}

.big{
  font-size:22px;
  font-weight:900;
  margin-bottom:5px;
}

.big.watch{
  color:var(--yellow);
}

.big.ignition{
  color:var(--orange);
}

.big.wait{
  color:var(--blue);
}

.big.entry{
  color:var(--green);
}

.big.bad{
  color:var(--red);
}

.signalTime{
  font-size:10px;
  color:var(--muted);
  line-height:1.6;
}

.score{
  height:6px;
  background:#16212d;
  border-radius:10px;
  overflow:hidden;
  margin-top:9px;
}

.score i{
  display:block;
  height:100%;
  background:var(--green);
}

.levels{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:5px;
  margin-top:10px;
}

.level{
  padding:7px;
  background:#0a1119;
  border:1px solid var(--line);
  border-radius:5px;
}

.level span{
  display:block;
  color:var(--muted);
  font-size:8px;
  margin-bottom:3px;
}

.level b{
  font-size:10px;
}

.level.entry b{
  color:var(--green);
}

.level.stop b{
  color:var(--red);
}

.level.tp b{
  color:var(--blue);
}

.notice{
  font-size:10px;
  color:var(--muted);
  line-height:1.7;
}

.notice strong{
  color:var(--text);
}

.empty{
  padding:12px;
  color:var(--muted);
  background:var(--panel);
  border:1px dashed var(--line);
  border-radius:6px;
  font-size:10px;
}

@media(max-width:1100px){
  .app{
    grid-template-columns:
      260px
      minmax(0,1fr);
  }

  .right{
    display:none;
  }
}

@media(max-width:760px){
  .app{
    display:block;
  }

  .left{
    border-right:0;
    border-bottom:
      1px solid var(--line);
  }

  .chart{
    height:70vh;
    min-height:420px;
  }
}

</style>

</head>

<body>

<div class="app">

<aside class="left">

<div class="brand">
SONNY AI TRADER
</div>

<div class="sub">
MOMENTUM SCALPER V2 • MANUEL GİRİŞ
</div>

<div class="livebar">
<span id="pulse" class="pulse"></span>
<span id="connection">
● BAĞLANIYOR
</span>
</div>


<div class="section">

<div class="sectionHead">
<span>🟢 GİRİŞ FIRSATLARI</span>
<span id="entryCount" class="count">0</span>
</div>

<div id="entries">
<div class="empty">
Giriş bekleniyor
</div>
</div>

</div>


<div class="section">

<div class="sectionHead">
<span>🔵 BEKLE</span>
<span id="waitCount" class="count">0</span>
</div>

<div id="wait">
<div class="empty">
Bekleyen kurulum yok
</div>
</div>

</div>


<div class="section">

<div class="sectionHead">
<span>🟠 HAREKET BAŞLADI</span>
<span id="ignitionCount" class="count">0</span>
</div>

<div id="ignitions">
<div class="empty">
Hareket yok
</div>
</div>

</div>


<div class="section">

<div class="sectionHead">
<span>🟡 İZLE</span>
<span id="watchCount" class="count">0</span>
</div>

<div id="watch">
<div class="empty">
İzlenecek coin yok
</div>
</div>

</div>

</aside>


<main class="main">

<div class="top">

<div>
<div class="title">
<span id="selectedTitle">
BTC/USDT:USDT
</span>
</div>
</div>

<div
  id="connText"
  class="conn"
>
CANLI BAĞLANTI
</div>

</div>


<div class="chart">

<div class="chartHeader">

<div id="chartTitle">
BTC/USDT:USDT • 15M
</div>

<div class="tfButtons">

<button
  data-tf="15m"
  class="active"
>
15M
</button>

<button
  data-tf="5m"
>
5M
</button>

<button
  data-tf="1m"
>
1M
</button>

</div>

</div>

<canvas id="chart"></canvas>

</div>

</main>


<aside class="right">


<div class="box">

<div class="boxTitle">
GENEL PİYASA
</div>

<div
  id="regime"
  class="regime"
>
YATAY / KARIŞIK
</div>

<div class="metrics">

<div class="metric">
<span>Genişlik</span>
<b id="breadth">-%</b>
</div>

<div class="metric">
<span>Ortalama</span>
<b id="average">-%</b>
</div>

<div class="metric">
<span>Yükselen</span>
<b id="green">-</b>
</div>

<div class="metric">
<span>Düşen</span>
<b id="red">-</b>
</div>

</div>

<div
  id="btceth"
  class="mini"
>
BTC: NÖTR • ETH: NÖTR
</div>

</div>


<div class="box">

<div class="boxTitle">
CANLI FIRSAT
</div>

<div id="signalDetail">

<div class="empty">
Henüz aktif fırsat yok.
</div>

</div>

</div>


<div class="box">

<div class="boxTitle">
SİSTEM DURUMU
</div>

<div
  id="systemInfo"
  class="mini"
>
Hazırlanıyor...
</div>

</div>


<div class="box">

<div class="boxTitle">
NASIL OKUNUR?
</div>

<div class="notice">

<strong>İZLE</strong>
= erken radar.

<br>

<strong>HAREKET BAŞLADI</strong>
= momentum hızlanıyor.

<br>

<strong>BEKLE</strong>
= kırılım var, manuel giriş için fiyat/akış teyidi bekleniyor.

<br>

<strong>GİRİŞ FIRSATI</strong>
= giriş şartları tamamlandı.

<br>

<strong>MOMENTUM ZAYIFLIYOR</strong>
= momentum bozuldu, yeni giriş kovalanmaz.

<br>

<strong>GEÇ KALINDI</strong>
= fiyat hareketin fazla uzadığı bölgeye girdi.

</div>

</div>

</aside>

</div>


<script>

(() => {

let selected =
  'BTC/USDT:USDT';

let timeframe =
  '15m';

let signals = [];

let candles = [];

let lastChartKey = '';


const $ =
  id =>
    document.getElementById(id);


function esc(v) {

  return String(
    v ?? ''
  ).replace(
    /[&<>"']/g,
    c =>
      ({
        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#39;'
      }[c])
  );
}


function p(v) {

  const n =
    Number(v);

  if (
    !Number.isFinite(n)
  ) {
    return '-';
  }

  if (n >= 1000)
    return n.toFixed(2);

  if (n >= 100)
    return n.toFixed(3);

  if (n >= 1)
    return n.toFixed(5);

  if (n >= .01)
    return n.toFixed(7);

  if (n >= .0001)
    return n.toFixed(8);

  return n.toFixed(10);
}


function age(seconds) {

  seconds =
    Number(seconds || 0);

  if (
    seconds < 60
  ) {
    return seconds + ' sn';
  }

  return (
    Math.floor(
      seconds / 60
    ) +
    ' dk ' +
    String(
      seconds % 60
    ).padStart(2,'0') +
    ' sn'
  );
}


function remain(ms) {

  if (ms <= 0) {
    return '0 sn';
  }

  return age(
    Math.floor(
      ms / 1000
    )
  );
}


function card(signal) {

  const cls =
    signal.stage === 'ENTRY'
      ? 'entry'
      : signal.stage === 'WAIT'
        ? 'wait'
        : signal.stage === 'IGNITION'
          ? 'ignition'
          : (
              signal.stage === 'EXHAUSTION' ||
              signal.stage === 'TOO_LATE'
            )
              ? 'bad'
              : 'watch';

  const coin =
    signal.symbol
      .replace(
        '/USDT:USDT',
        ''
      )
      .replace(
        '/USDT',
        ''
      );

  let timer = '';

  if (
    signal.stage === 'ENTRY' &&
    signal.entryWindowEnds
  ) {
    timer =
      '<div class="timer">' +
      '⏱ Giriş penceresi: ' +
      remain(
        signal.entryWindowEnds -
        Date.now()
      ) +
      '</div>';
  }

  return \`
    <div
      class="card \${signal.direction.toLowerCase()} \${cls}"
      data-symbol="\${esc(signal.marketSymbol)}"
    >

      <div class="row">

        <b class="coin">
          \${esc(coin)}
        </b>

        <span
          class="dir \${signal.direction.toLowerCase()}"
        >
          \${esc(signal.direction)}
        </span>

      </div>

      <div class="stage \${cls}">
        \${esc(signal.status)}
      </div>

      <div class="price">
        \${p(signal.currentPrice)}
      </div>

      <div class="mini">
        Momentum \${esc(signal.score)}/100
        • Hacim \${esc(signal.volumeRatio)}x
        <br>
        Akış \${esc(signal.flow)}%
        • OI \${esc(signal.oiChange)}%
      </div>

      <div class="timer">
        Sinyal:
        \${new Date(
          signal.signalAt
        ).toLocaleTimeString(
          'tr-TR'
        )}
      </div>

      \${timer}

    </div>
  \`;
}


function metric(a,b) {

  return \`
    <div class="metric">
      <span>\${esc(a)}</span>
      <b>\${esc(b)}</b>
    </div>
  \`;
}


function render(data) {

  signals =
    data.signals || [];

  const market =
    data.market || {};

  const set =
    (id,value) =>
      $(id).textContent =
        value;


  set(
    'regime',
    market.label ||
      'YATAY / KARIŞIK'
  );

  $('regime').className =
    'regime ' +
    (
      market.direction === 'LONG'
        ? 'long'
        : market.direction === 'SHORT'
          ? 'short'
          : ''
    );


  set(
    'breadth',
    '%' +
      (
        market.breadth ??
        '-'
      )
  );

  set(
    'average',
    (
      market.average ??
      '-'
    ) +
    '%'
  );

  set(
    'green',
    market.green ??
      '-'
  );

  set(
    'red',
    market.red ??
      '-'
  );

  set(
    'btceth',
    'BTC: ' +
      (
        market.btc ||
        '-'
      ) +
      ' • ETH: ' +
      (
        market.eth ||
        '-'
      )
  );


  const entries =
    signals.filter(
      s =>
        s.stage === 'ENTRY'
    );

  const waits =
    signals.filter(
      s =>
        s.stage === 'WAIT'
    );

  const ignitions =
    signals.filter(
      s =>
        s.stage === 'IGNITION'
    );

  const watches =
    signals.filter(
      s =>
        s.stage === 'WATCH'
    );


  set(
    'entryCount',
    entries.length
  );

  set(
    'waitCount',
    waits.length
  );

  set(
    'ignitionCount',
    ignitions.length
  );

  set(
    'watchCount',
    watches.length
  );


  $('entries').innerHTML =
    entries.length
      ? entries
          .map(card)
          .join('')
      : '<div class="empty">Giriş bekleniyor</div>';


  $('wait').innerHTML =
    waits.length
      ? waits
          .map(card)
          .join('')
      : '<div class="empty">Bekleyen kurulum yok</div>';


  $('ignitions').innerHTML =
    ignitions.length
      ? ignitions
          .map(card)
          .join('')
      : '<div class="empty">Hareket yok</div>';


  $('watch').innerHTML =
    watches.length
      ? watches
          .map(card)
          .join('')
      : '<div class="empty">İzlenecek coin yok</div>';


  const connected =
    !!(
      data.ws &&
      data.ws.connected
    );


  $('pulse').className =
    'pulse' +
    (
      connected
        ? ''
        : ' off'
    );


  set(
    'connection',
    connected
      ? '● CANLI'
      : '● BAĞLANTI YOK'
  );


  $('connection').style.color =
    connected
      ? 'var(--green)'
      : 'var(--red)';


  set(
    'connText',
    connected
      ? 'CANLI BAĞLANTI'
      : 'BAĞLANTI KESİLDİ'
  );


  $('systemInfo').innerHTML = \`
    Radar:
    \${data.stats?.universe || 0}
    • Canlı:
    \${data.stats?.live || 0}

    <br>

    İzle:
    \${data.stats?.watching || 0}
    • Hareket:
    \${data.stats?.ignition || 0}

    <br>

    Bekle:
    \${data.stats?.wait || 0}
    • Giriş:
    \${data.stats?.entries || 0}

    <br>

    WS:
    \${data.ws?.open || 0}
    bağlantı
    • Yeniden bağlanma:
    \${data.ws?.reconnects || 0}
  \`;


  const chosen =
    signals.find(
      s =>
        s.marketSymbol ===
        selected
    ) ||
    entries[0] ||
    waits[0] ||
    ignitions[0] ||
    watches[0];


  if (chosen) {

    selected =
      chosen.marketSymbol;

    show(chosen);

    if (
      lastChartKey !==
      selected +
      '|' +
      timeframe
    ) {

      lastChartKey =
        selected +
        '|' +
        timeframe;

      loadChart();
    }
  }

  bind();
}


function show(signal) {

  const cls =
    signal.stage === 'ENTRY'
      ? 'entry'
      : signal.stage === 'WAIT'
        ? 'wait'
        : signal.stage === 'IGNITION'
          ? 'ignition'
          : (
              signal.stage === 'EXHAUSTION' ||
              signal.stage === 'TOO_LATE'
            )
              ? 'bad'
              : 'watch';


  $('selectedTitle')
    .textContent =
      signal.symbol;


  $('chartTitle')
    .textContent =
      signal.symbol +
      ' • ' +
      timeframe.toUpperCase();


  const timer =
    signal.stage === 'ENTRY' &&
    signal.entryWindowEnds

      ? \`
        <div class="signalTime">
          ⏱ Giriş penceresi:
          <b>
            \${remain(
              signal.entryWindowEnds -
              Date.now()
            )}
          </b>
        </div>
      \`

      : '';


  $('signalDetail').innerHTML = \`

    <div class="big \${cls}">
      \${esc(signal.status)}
    </div>

    <div class="signalTime">
      \${esc(signal.symbol)}
      •
      \${esc(signal.direction)}

      <br>

      Sinyal:
      \${new Date(
        signal.signalAt
      ).toLocaleTimeString(
        'tr-TR'
      )}

      • Yaş:
      \${age(
        signal.ageSeconds
      )}
    </div>

    \${timer}

    <div class="score">
      <i
        style="width:\${Math.min(
          100,
          Number(signal.score) || 0
        )}%"
      ></i>
    </div>

    <div class="mini">
      Momentum
      \${signal.score}/100
    </div>

    <div class="levels">

      <div class="level entry">
        <span>GİRİŞ</span>
        <b>
          \${p(signal.entryLow)}
          -
          \${p(signal.entryHigh)}
        </b>
      </div>

      <div class="level stop">
        <span>STOP</span>
        <b>
          \${p(signal.stop)}
        </b>
      </div>

      <div class="level tp">
        <span>HEDEF 1</span>
        <b>
          \${p(signal.tp1)}
        </b>
      </div>

      <div class="level tp">
        <span>HEDEF 2</span>
        <b>
          \${p(signal.tp2)}
        </b>
      </div>

    </div>

    <div style="margin-top:8px">

      \${metric(
        'Fiyat 10 sn',
        signal.priceMove10s + '%'
      )}

      \${metric(
        'Fiyat 30 sn',
        signal.priceMove30s + '%'
      )}

      \${metric(
        'İşlem akışı',
        signal.flow + '%'
      )}

      \${metric(
        'Hacim',
        signal.volumeRatio + 'x'
      )}

      \${metric(
        'OI',
        signal.oiChange + '%'
      )}

      \${metric(
        'Spread',
        signal.spread + '%'
      )}

      \${metric(
        '15M yön',
        signal.contextDirection
      )}

      \${metric(
        'Kırılım',
        signal.breakout
          ? 'EVET'
          : 'HAYIR'
      )}

      \${metric(
        '5M teyit',
        signal.tf5Confirm
          ? 'EVET'
          : 'BEKLİYOR'
      )}

      \${metric(
        '1M teyit',
        signal.tf1Confirm
          ? 'EVET'
          : 'BEKLİYOR'
      )}

      \${metric(
        'Neden',
        signal.reason
      )}

    </div>
  \`;
}


function bind() {

  document
    .querySelectorAll(
      '.card'
    )
    .forEach(
      element => {

        element.onclick =
          () => {

            selected =
              element.dataset.symbol;

            const signal =
              signals.find(
                x =>
                  x.marketSymbol ===
                  selected
              );

            if (signal) {

              show(signal);

              lastChartKey =
                '';

              loadChart();
            }
          };
      }
    );
}


function normalize(array) {

  return (
    array || []
  )
    .map(
      x =>
        Array.isArray(x)
          ? {
              time:+x[0],
              open:+x[1],
              high:+x[2],
              low:+x[3],
              close:+x[4]
            }
          : x
    )
    .filter(
      x =>
        Number.isFinite(
          x.time
        )
    );
}


async function loadChart() {

  try {

    const response =
      await fetch(
        '/api/chart?symbol=' +
        encodeURIComponent(
          selected
        ) +
        '&timeframe=' +
        encodeURIComponent(
          timeframe
        ),
        {
          cache:
            'no-store'
        }
      );

    const data =
      await response.json();

    if (
      data.success
    ) {

      candles =
        normalize(
          data.candles
        );

      draw();
    }

  } catch (e) {

    draw();
  }
}


function draw() {

  const canvas =
    $('chart');

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    devicePixelRatio || 1;

  const width =
    Math.max(
      300,
      Math.floor(
        rect.width
      )
    );

  const height =
    Math.max(
      300,
      Math.floor(
        rect.height
      )
    );

  canvas.width =
    width * dpr;

  canvas.height =
    height * dpr;

  const ctx =
    canvas.getContext(
      '2d'
    );

  ctx.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  ctx.fillStyle =
    '#070b10';

  ctx.fillRect(
    0,
    0,
    width,
    height
  );


  if (
    !candles.length
  ) {

    ctx.fillStyle =
      '#738296';

    ctx.font =
      '12px Arial';

    ctx.fillText(
      'Grafik verisi bekleniyor...',
      16,
      25
    );

    return;
  }


  const visible =
    candles.slice(-100);


  let min =
    Math.min(
      ...visible.map(
        z => z.low
      )
    );

  let max =
    Math.max(
      ...visible.map(
        z => z.high
      )
    );


  const signal =
    signals.find(
      z =>
        z.marketSymbol ===
        selected
    );


  if (signal) {

    [
      signal.entry,
      signal.stop,
      signal.tp1,
      signal.tp2
    ].forEach(
      value => {

        if (
          Number.isFinite(
            +value
          )
        ) {

          min =
            Math.min(
              min,
              +value
            );

          max =
            Math.max(
              max,
              +value
            );
        }
      }
    );
  }


  const padding =
    (max - min) *
    .08 || 1;

  min -= padding;
  max += padding;


  const left = 48;
  const right = 72;
  const top = 12;
  const bottom = 12;

  const plotWidth =
    width -
    left -
    right;

  const plotHeight =
    height -
    top -
    bottom;


  const Y =
    value =>
      top +
      (
        max - value
      ) /
      (
        max - min
      ) *
      plotHeight;


  const X =
    index =>
      left +
      index *
      plotWidth /
      Math.max(
        1,
        visible.length - 1
      );


  ctx.strokeStyle =
    '#172331';


  for (
    let i = 0;
    i <= 5;
    i++
  ) {

    const y =
      top +
      plotHeight *
      i / 5;

    ctx.beginPath();

    ctx.moveTo(
      left,
      y
    );

    ctx.lineTo(
      width - right,
      y
    );

    ctx.stroke();
  }


  const step =
    plotWidth /
    Math.max(
      1,
      visible.length - 1
    );

  const candleWidth =
    Math.max(
      2,
      Math.min(
        9,
        step * .62
      )
    );


  visible.forEach(
    (candle, index) => {

      const x =
        X(index);

      const up =
        candle.close >=
        candle.open;

      const color =
        up
          ? '#16e0a1'
          : '#ff4f70';

      ctx.strokeStyle =
        color;

      ctx.fillStyle =
        color;


      ctx.beginPath();

      ctx.moveTo(
        x,
        Y(candle.high)
      );

      ctx.lineTo(
        x,
        Y(candle.low)
      );

      ctx.stroke();


      const openY =
        Y(candle.open);

      const closeY =
        Y(candle.close);


      ctx.fillRect(
        x -
          candleWidth / 2,

        Math.min(
          openY,
          closeY
        ),

        candleWidth,

        Math.max(
          1,
          Math.abs(
            closeY -
            openY
          )
        )
      );

    }
  );


  if (signal) {

    line(
      signal.entry,
      '#16e0a1',
      'GİRİŞ'
    );

    line(
      signal.stop,
      '#ff4f70',
      'STOP'
    );

    line(
      signal.tp1,
      '#55a8ff',
      'HEDEF 1'
    );

    line(
      signal.tp2,
      '#55a8ff',
      'HEDEF 2'
    );
  }


  function line(
    value,
    color,
    label
  ) {

    if (
      !Number.isFinite(
        +value
      )
    ) {
      return;
    }

    const y =
      Y(+value);

    ctx.strokeStyle =
      color;

    ctx.setLineDash([
      5,
      5
    ]);

    ctx.beginPath();

    ctx.moveTo(
      left,
      y
    );

    ctx.lineTo(
      width - right,
      y
    );

    ctx.stroke();

    ctx.setLineDash([]);

    ctx.fillStyle =
      color;

    ctx.font =
      'bold 9px Arial';

    ctx.fillText(
      label +
      ' ' +
      p(value),
      width - right + 4,
      y + 3
    );
  }
}


/*
 * SADECE UI YAŞ SAYACI.
 * SERVER'I POLL ETMİYOR.
 */

setInterval(
  () => {

    signals.forEach(
      signal => {

        signal.ageSeconds =
          Math.floor(
            (
              Date.now() -
              signal.signalAt
            ) /
            1000
          );
      }
    );

    const signal =
      signals.find(
        x =>
          x.marketSymbol ===
          selected
      );

    if (signal) {
      show(signal);
    }

  },
  1000
);


/*
 * TIMEFRAME
 */

document
  .querySelectorAll(
    '[data-tf]'
  )
  .forEach(
    button => {

      button.onclick =
        () => {

          document
            .querySelectorAll(
              '[data-tf]'
            )
            .forEach(
              x =>
                x.classList.remove(
                  'active'
                )
            );

          button.classList.add(
            'active'
          );

          timeframe =
            button.dataset.tf;

          lastChartKey =
            '';

          loadChart();
        };
    }
  );


/*
 * UI WEBSOCKET
 */

function connect() {

  const protocol =
    location.protocol ===
    'https:'
      ? 'wss://'
      : 'ws://';

  const ws =
    new WebSocket(
      protocol +
      location.host
    );


  ws.onmessage =
    event => {

      try {

        const message =
          JSON.parse(
            event.data
          );

        if (
          message.type ===
          'snapshot'
        ) {
          render(
            message.data
          );
        }

      } catch (_) {}
    };


  ws.onclose =
    () => {

      setTimeout(
        connect,
        1500
      );
    };
}


connect();

loadChart();

addEventListener(
  'resize',
  draw
);

})();

</script>

</body>

</html>
`;


/* =========================================================
   HTTP
========================================================= */

app.get(
  '/',
  (req, res) =>
    res
      .type('html')
      .send(HTML)
);


/* =========================================================
   ERROR HANDLING
========================================================= */

process.on(
  'unhandledRejection',
  e => {

    STATE.lastError =
      e?.message ||
      String(e);

    console.error(
      'UNHANDLED:',
      e
    );
  }
);

process.on(
  'uncaughtException',
  e => {

    STATE.lastError =
      e?.message ||
      String(e);

    console.error(
      'UNCAUGHT:',
      e
    );
  }
);


/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  async () => {

    console.log(
      '=============================================='
    );

    console.log(
      '🚀 SONNY AI TRADER — RED TEAM V3'
    );

    console.log(
      '🔥 MOMENTUM SCALPER'
    );

    console.log(
      '🟡 İZLE → 🟠 HAREKET → 🔵 BEKLE → 🟢 GİRİŞ → 🔴 ZAYIFLAMA'
    );

    console.log(
      '🤖 AUTO TRADE: KAPALI'
    );

    console.log(
      '=============================================='
    );


    try {

      await loadMarketsRetry();

      await discoverUniverse();

      await refreshContexts();

      startWs();

      /*
       * İlk WS açılışında ikinci rebuild
       * yapılmasını engelle.
       */
      lastWsSymbols =
        STATE.liveUniverse
          .map(
            x => x.instId
          )
          .join(',');


      /*
       * RADAR
       */
      setInterval(
        async () => {

          if (
            await discoverUniverse()
          ) {
            maybeRefreshWsSubscriptions();
          }

        },
        CFG.DISCOVERY_MS
      );


      /*
       * 15M CONTEXT
       */
      setInterval(
        async () => {
          await refreshContexts();
        },
        CFG.CONTEXT_MS
      );


      /*
       * CLEANUP + UI
       */
      setInterval(
        () => {

          cleanup();

          scheduleBroadcast();

        },
        1000
      );


      /*
       * WS HEALTH
       */
      setInterval(
        () => {
          wsHealth();
        },
        15000
      );


      console.log(
        '🟢 SİSTEM BAŞLADI'
      );

    } catch (e) {

      STATE.lastError =
        e.message;

      console.error(
        'BOOT ERROR:',
        e
      );
    }
  }
);
