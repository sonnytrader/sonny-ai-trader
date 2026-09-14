'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const REST = 'https://api.bitget.com';
const WS_URL = 'wss://ws.bitget.com/v2/ws/public';

const PRODUCT = 'usdt-futures';

// ============================================================
// SONNY AI TRADER V6
// 2H PRE-BREAKOUT RADAR
// ============================================================

const CFG = {
  MIN_24H_TURNOVER: 3000000,
  MAX_SYMBOLS: 80,

  LEVEL_LOOKBACK: 36,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,

  WATCH_DISTANCE_PCT: 1.20,
  IGNITION_DISTANCE_PCT: 0.55,
  ENTRY_DISTANCE_PCT: 0.18,

  VOLUME_LOOKBACK: 20,
  WATCH_VOLUME_RATIO: 1.20,
  IGNITION_VOLUME_RATIO: 1.50,
  ENTRY_VOLUME_RATIO: 1.90,

  OI_WATCH_PCT: 0.03,
  OI_IGNITION_PCT: 0.08,
  OI_ENTRY_PCT: 0.15,

  FLOW_WATCH: 0.54,
  FLOW_IGNITION: 0.58,
  FLOW_ENTRY: 0.63,

  MOMENTUM_WATCH: 0.03,
  MOMENTUM_IGNITION: 0.08,
  MOMENTUM_ENTRY: 0.15,

  WATCH_SCORE: 50,
  IGNITION_SCORE: 65,
  ENTRY_SCORE: 80,

  SIGNAL_TTL_MS: 4 * 60 * 1000,

  SCAN_INTERVAL_MS: 30 * 1000,

  WS_BATCH_SIZE: 40,
  WS_PING_MS: 25 * 1000
};

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: Date.now(),

  symbols: new Map(),

  signals: [],

  ws: null,
  wsConnected: false,
  wsSubscriptions: [],

  stats: {
    tickerMessages: 0,
    candleMessages: 0,
    symbols: 0,
    scans: 0,
    signals: 0,
    lastScan: null
  }
};

// ============================================================
// HELPERS
// ============================================================

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function absPct(a, b) {
  return Math.abs(pct(a, b));
}

function now() {
  return Date.now();
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace(/[^A-Z0-9]/g, '');
}

function getSymbol(symbol) {
  if (!state.symbols.has(symbol)) {
    state.symbols.set(symbol, {
      symbol,

      price: 0,
      bid: 0,
      ask: 0,
      bidSize: 0,
      askSize: 0,

      turnover24h: 0,
      volume24h: 0,

      oi: 0,
      prevOi: 0,
      oiUpdatedAt: 0,

      priceHistory: [],
      flowHistory: [],

      minuteCandles: [],
      h1Candles: [],
      twoHCandles: [],

      level: null,
      signal: null
    });
  }

  return state.symbols.get(symbol);
}

// ============================================================
// REST
// ============================================================

async function rest(path, params = {}) {
  const url = new URL(REST + path);

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.code && json.code !== '00000') {
    throw new Error(`${json.code} ${json.msg || ''}`);
  }

  return json;
}

// ============================================================
// LOAD SYMBOLS
// ============================================================

async function loadSymbols() {
  const json = await rest('/api/v2/mix/market/contracts', {
    productType: PRODUCT
  });

  const contracts = Array.isArray(json.data)
    ? json.data
    : [];

  const valid = contracts
    .filter(x => {
      const symbol = normalizeSymbol(x.symbol);

      return (
        symbol &&
        x.symbolType !== 'delivery' &&
        String(x.quoteCoin).toUpperCase() === 'USDT'
      );
    })
    .map(x => normalizeSymbol(x.symbol));

  console.log(`Bitget marketleri: ${valid.length}`);

  for (const symbol of valid) {
    getSymbol(symbol);
  }

  state.stats.symbols = valid.length;
}

// ============================================================
// HISTORICAL 1H CANDLES
// ============================================================

async function load1HCandles(symbol) {
  try {
    const json = await rest('/api/v3/market/candles', {
      category: 'USDT-FUTURES',
      symbol,
      interval: '1H',
      limit: 120
    });

    const rows = Array.isArray(json.data)
      ? json.data
      : [];

    const candles = rows
      .map(r => ({
        ts: num(r[0]),
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5]),
        turnover: num(r[6])
      }))
      .filter(c => c.close > 0)
      .sort((a, b) => a.ts - b.ts);

    getSymbol(symbol).h1Candles = candles;

    build2HCandles(symbol);

  } catch (err) {
    console.error(
      `[${symbol}] 1H candle error: ${err.message}`
    );
  }
}

// ============================================================
// 1H -> 2H AGGREGATION
// ============================================================

function build2HCandles(symbol) {
  const s = getSymbol(symbol);
  const h1 = s.h1Candles;

  if (h1.length < 10) return;

  const buckets = new Map();

  for (const c of h1) {
    const bucket =
      Math.floor(
        c.ts / (2 * 60 * 60 * 1000)
      );

    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
    }

    buckets.get(bucket).push(c);
  }

  const result = [];

  for (const [bucket, rows] of buckets) {
    rows.sort((a, b) => a.ts - b.ts);

    if (!rows.length) continue;

    result.push({
      ts:
        bucket *
        2 *
        60 *
        60 *
        1000,

      open: rows[0].open,

      high: Math.max(
        ...rows.map(x => x.high)
      ),

      low: Math.min(
        ...rows.map(x => x.low)
      ),

      close:
        rows[rows.length - 1].close,

      volume:
        rows.reduce(
          (a, x) => a + x.volume,
          0
        ),

      turnover:
        rows.reduce(
          (a, x) => a + x.turnover,
          0
        )
    });
  }

  result.sort((a, b) => a.ts - b.ts);

  s.twoHCandles =
    result.slice(-CFG.LEVEL_LOOKBACK);

  detectLevels(symbol);
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function isPivotHigh(candles, i) {
  const c = candles[i];

  for (
    let x = 1;
    x <= CFG.PIVOT_LEFT;
    x++
  ) {
    if (
      !candles[i - x] ||
      candles[i - x].high >= c.high
    ) {
      return false;
    }
  }

  for (
    let x = 1;
    x <= CFG.PIVOT_RIGHT;
    x++
  ) {
    if (
      !candles[i + x] ||
      candles[i + x].high > c.high
    ) {
      return false;
    }
  }

  return true;
}

function isPivotLow(candles, i) {
  const c = candles[i];

  for (
    let x = 1;
    x <= CFG.PIVOT_LEFT;
    x++
  ) {
    if (
      !candles[i - x] ||
      candles[i - x].low <= c.low
    ) {
      return false;
    }
  }

  for (
    let x = 1;
    x <= CFG.PIVOT_RIGHT;
    x++
  ) {
    if (
      !candles[i + x] ||
      candles[i + x].low < c.low
    ) {
      return false;
    }
  }

  return true;
}

function detectLevels(symbol) {
  const s = getSymbol(symbol);
  const candles = s.twoHCandles;

  if (candles.length < 12) return;

  const price = s.price;

  if (!price) return;

  const resistance = [];
  const support = [];

  for (
    let i = CFG.PIVOT_LEFT;
    i < candles.length - CFG.PIVOT_RIGHT;
    i++
  ) {
    if (isPivotHigh(candles, i)) {
      resistance.push(
        candles[i].high
      );
    }

    if (isPivotLow(candles, i)) {
      support.push(
        candles[i].low
      );
    }
  }

  const nearestResistance =
    resistance
      .filter(x => x > price)
      .sort((a, b) => a - b)[0] || null;

  const nearestSupport =
    support
      .filter(x => x < price)
      .sort((a, b) => b - a)[0] || null;

  s.level = {
    resistance: nearestResistance,
    support: nearestSupport,
    updatedAt: now()
  };
}

// ============================================================
// VOLUME
// ============================================================

function calculateVolumeRatio(symbol) {
  const s = getSymbol(symbol);

  const candles = s.twoHCandles;

  if (
    candles.length <
    CFG.VOLUME_LOOKBACK + 1
  ) {
    return 1;
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      -CFG.VOLUME_LOOKBACK - 1,
      -1
    );

  const avg =
    previous.reduce(
      (sum, c) =>
        sum + c.turnover,
      0
    ) / previous.length;

  if (!avg) return 1;

  return last.turnover / avg;
}

// ============================================================
// LIVE PRICE MOMENTUM
// ============================================================

function priceMomentum(symbol) {
  const s = getSymbol(symbol);

  const h = s.priceHistory;

  if (h.length < 10) return 0;

  const current =
    h[h.length - 1];

  const old =
    h.find(
      x =>
        current.ts - x.ts >=
        60 * 1000
    ) || h[0];

  if (!old.price) return 0;

  return pct(
    current.price,
    old.price
  );
}

// ============================================================
// OI
// ============================================================

function oiChange(symbol) {
  const s = getSymbol(symbol);

  if (!s.prevOi || !s.oi) {
    return 0;
  }

  return pct(
    s.oi,
    s.prevOi
  );
}

// ============================================================
// ORDERBOOK FLOW
// ============================================================

function orderbookFlow(symbol) {
  const s = getSymbol(symbol);

  if (
    !s.bidSize &&
    !s.askSize
  ) {
    return 0.5;
  }

  const total =
    s.bidSize +
    s.askSize;

  if (!total) return 0.5;

  return (
    s.bidSize /
    total
  );
}

// ============================================================
// FLOW SCORE
// ============================================================

function flowScore(symbol) {
  const s = getSymbol(symbol);

  const direct =
    orderbookFlow(symbol);

  if (!s.flowHistory.length) {
    return direct;
  }

  const recent =
    s.flowHistory.slice(-20);

  const avg =
    recent.reduce(
      (a, x) =>
        a + x.flow,
      0
    ) / recent.length;

  return clamp(
    avg * 0.65 +
    direct * 0.35,
    0,
    1
  );
}

// ============================================================
// LEVEL DISTANCE
// ============================================================

function levelDistance(
  symbol,
  direction
) {
  const s = getSymbol(symbol);

  if (
    !s.level ||
    !s.price
  ) {
    return Infinity;
  }

  const level =
    direction === 'LONG'
      ? s.level.resistance
      : s.level.support;

  if (!level) {
    return Infinity;
  }

  return absPct(
    s.price,
    level
  );
}

// ============================================================
// SCORE
// ============================================================

function calculateScore(
  symbol,
  direction
) {
  const s = getSymbol(symbol);

  const distance =
    levelDistance(
      symbol,
      direction
    );

  const volumeRatio =
    calculateVolumeRatio(symbol);

  const oi =
    oiChange(symbol);

  const flow =
    flowScore(symbol);

  const momentum =
    priceMomentum(symbol);

  let score = 0;

  // ----------------------------------------------------------
  // 2H LEVEL PROXIMITY - 20
  // ----------------------------------------------------------

  if (
    distance <=
    CFG.ENTRY_DISTANCE_PCT
  ) {
    score += 20;
  } else if (
    distance <=
    CFG.IGNITION_DISTANCE_PCT
  ) {
    score += 16;
  } else if (
    distance <=
    CFG.WATCH_DISTANCE_PCT
  ) {
    score += 10;
  }

  // ----------------------------------------------------------
  // VOLUME - 20
  // ----------------------------------------------------------

  if (
    volumeRatio >=
    CFG.ENTRY_VOLUME_RATIO
  ) {
    score += 20;
  } else if (
    volumeRatio >=
    CFG.IGNITION_VOLUME_RATIO
  ) {
    score += 16;
  } else if (
    volumeRatio >=
    CFG.WATCH_VOLUME_RATIO
  ) {
    score += 10;
  }

  // ----------------------------------------------------------
  // OI - 20
  // ----------------------------------------------------------

  if (oi >= CFG.OI_ENTRY_PCT) {
    score += 20;
  } else if (
    oi >= CFG.OI_IGNITION_PCT
  ) {
    score += 16;
  } else if (
    oi >= CFG.OI_WATCH_PCT
  ) {
    score += 10;
  }

  // ----------------------------------------------------------
  // FLOW - 20
  // ----------------------------------------------------------

  if (direction === 'LONG') {

    if (
      flow >=
      CFG.FLOW_ENTRY
    ) {
      score += 20;
    } else if (
      flow >=
      CFG.FLOW_IGNITION
    ) {
      score += 16;
    } else if (
      flow >=
      CFG.FLOW_WATCH
    ) {
      score += 10;
    }

  } else {

    const sellFlow =
      1 - flow;

    if (
      sellFlow >=
      CFG.FLOW_ENTRY
    ) {
      score += 20;
    } else if (
      sellFlow >=
      CFG.FLOW_IGNITION
    ) {
      score += 16;
    } else if (
      sellFlow >=
      CFG.FLOW_WATCH
    ) {
      score += 10;
    }
  }

  // ----------------------------------------------------------
  // MOMENTUM - 10
  // ----------------------------------------------------------

  const absMomentum =
    Math.abs(momentum);

  if (
    (
      direction === 'LONG' &&
      momentum > 0
    ) ||
    (
      direction === 'SHORT' &&
      momentum < 0
    )
  ) {

    if (
      absMomentum >=
      CFG.MOMENTUM_ENTRY
    ) {
      score += 10;
    } else if (
      absMomentum >=
      CFG.MOMENTUM_IGNITION
    ) {
      score += 8;
    } else if (
      absMomentum >=
      CFG.MOMENTUM_WATCH
    ) {
      score += 5;
    }
  }

  // ----------------------------------------------------------
  // PRICE DIRECTION QUALITY - 10
  // ----------------------------------------------------------

  if (
    direction === 'LONG' &&
    momentum > 0
  ) {
    score += 10;
  }

  if (
    direction === 'SHORT' &&
    momentum < 0
  ) {
    score += 10;
  }

  return Math.min(
    100,
    Math.round(score)
  );
}

// ============================================================
// SIGNAL CLASSIFICATION
// ============================================================

function classifySignal(
  symbol,
  direction,
  score
) {
  const s = getSymbol(symbol);

  const distance =
    levelDistance(
      symbol,
      direction
    );

  if (
    distance <
    0.001
  ) {
    return null;
  }

  if (
    distance >
    CFG.WATCH_DISTANCE_PCT
  ) {
    return null;
  }

  let stateName = null;

  if (
    score >=
    CFG.ENTRY_SCORE
  ) {
    stateName =
      'GİRİŞ FIRSATI';
  } else if (
    score >=
    CFG.IGNITION_SCORE
  ) {
    stateName =
      'HAREKET BAŞLADI';
  } else if (
    score >=
    CFG.WATCH_SCORE
  ) {
    stateName =
      'İZLE';
  }

  if (!stateName) {
    return null;
  }

  const volumeRatio =
    calculateVolumeRatio(symbol);

  const oi =
    oiChange(symbol);

  const flow =
    flowScore(symbol);

  const momentum =
    priceMomentum(symbol);

  const level =
    direction === 'LONG'
      ? s.level?.resistance
      : s.level?.support;

  return {
    symbol,
    direction,
    state: stateName,

    score,

    price: s.price,
    level,

    distancePct: distance,

    volumeRatio,
    oiChangePct: oi,
    flow,
    momentum,

    createdAt: now(),

    expiresAt:
      now() +
      CFG.SIGNAL_TTL_MS
  };
}

// ============================================================
// EVALUATE SYMBOL
// ============================================================

function evaluateSymbol(symbol) {
  const s = getSymbol(symbol);

  if (!s.price) return;

  if (
    s.turnover24h <
    CFG.MIN_24H_TURNOVER
  ) {
    return;
  }

  if (!s.level) {
    detectLevels(symbol);
  }

  if (!s.level) return;

  const candidates = [];

  // ----------------------------------------------------------
  // LONG
  // ----------------------------------------------------------

  if (
    s.level.resistance &&
    s.price <
    s.level.resistance
  ) {

    const score =
      calculateScore(
        symbol,
        'LONG'
      );

    const signal =
      classifySignal(
        symbol,
        'LONG',
        score
      );

    if (signal) {
      candidates.push(signal);
    }
  }

  // ----------------------------------------------------------
  // SHORT
  // ----------------------------------------------------------

  if (
    s.level.support &&
    s.price >
    s.level.support
  ) {

    const score =
      calculateScore(
        symbol,
        'SHORT'
      );

    const signal =
      classifySignal(
        symbol,
        'SHORT',
        score
      );

    if (signal) {
      candidates.push(signal);
    }
  }

  if (!candidates.length) {
    s.signal = null;
    return;
  }

  candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );

  const best =
    candidates[0];

  const previous =
    s.signal;

  if (
    !previous ||
    previous.state !==
      best.state ||
    previous.direction !==
      best.direction ||
    Math.abs(
      previous.score -
      best.score
    ) >= 5
  ) {

    s.signal = best;

    state.stats.signals++;

    console.log(
      `[${best.state}] ` +
      `${best.direction} ` +
      `${best.symbol} ` +
      `score=${best.score} ` +
      `distance=${best.distancePct.toFixed(2)}% ` +
      `VOL=${best.volumeRatio.toFixed(2)}x ` +
      `OI=${best.oiChangePct.toFixed(2)}% ` +
      `FLOW=${best.flow.toFixed(2)}`
    );

  } else {

    s.signal = {
      ...previous,

      price:
        best.price,

      level:
        best.level,

      distancePct:
        best.distancePct,

      volumeRatio:
        best.volumeRatio,

      oiChangePct:
        best.oiChangePct,

      flow:
        best.flow,

      momentum:
        best.momentum,

      score:
        best.score
    };
  }
}

// ============================================================
// SCAN
// ============================================================

function scan() {
  state.stats.scans++;

  state.stats.lastScan =
    now();

  for (
    const symbol of
    state.symbols.keys()
  ) {
    evaluateSymbol(symbol);
  }

  cleanupSignals();
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupSignals() {
  const t = now();

  for (
    const s of
    state.symbols.values()
  ) {

    if (
      s.signal &&
      s.signal.expiresAt <
      t
    ) {
      s.signal = null;
    }
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

function connectWS() {

  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
  }

  const ws =
    new WebSocket(
      WS_URL
    );

  state.ws = ws;

  ws.on(
    'open',
    () => {

      console.log(
        'Bitget WebSocket bağlandı.'
      );

      state.wsConnected =
        true;

      subscribeTickerAndCandles();
    }
  );

  ws.on(
    'message',
    raw => {

      try {

        const msg =
          JSON.parse(
            raw.toString()
          );

        if (
          msg.event ===
          'subscribe'
        ) {
          return;
        }

        if (
          !msg.data ||
          !msg.arg
        ) {
          return;
        }

        const channel =
          msg.arg.channel;

        if (
          channel ===
          'ticker'
        ) {
          processTicker(msg);
        }

        if (
          channel ===
            'candle1m' ||
          channel ===
            'candle1H'
        ) {
          processCandle(msg);
        }

      } catch (err) {

        console.error(
          'WS parse error:',
          err.message
        );
      }
    }
  );

  ws.on(
    'close',
    () => {

      console.log(
        'Bitget WebSocket kapandı.'
      );

      state.wsConnected =
        false;

      setTimeout(
        connectWS,
        3000
      );
    }
  );

  ws.on(
    'error',
    err => {

      console.error(
        'WS error:',
        err.message
      );
    }
  );
}

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function subscribeTickerAndCandles() {

  if (
    !state.ws ||
    state.ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const symbols =
    Array.from(
      state.symbols.keys()
    );

  const selected =
    symbols.slice(
      0,
      CFG.MAX_SYMBOLS
    );

  const args = [];

  for (
    const symbol of selected
  ) {

    args.push({
      instType:
        'USDT-FUTURES',

      channel:
        'ticker',

      instId:
        symbol
    });
  }

  for (
    const symbol of selected
  ) {

    args.push({
      instType:
        'USDT-FUTURES',

      channel:
        'candle1H',

      instId:
        symbol
    });
  }

  for (
    const symbol of selected
  ) {

    args.push({
      instType:
        'USDT-FUTURES',

      channel:
        'candle1m',

      instId:
        symbol
    });
  }

  const batches = [];

  for (
    let i = 0;
    i < args.length;
    i += CFG.WS_BATCH_SIZE
  ) {

    batches.push(
      args.slice(
        i,
        i +
        CFG.WS_BATCH_SIZE
      )
    );
  }

  state.wsSubscriptions =
    batches;

  for (
    const batch of batches
  ) {

    state.ws.send(
      JSON.stringify({
        op:
          'subscribe',

        args:
          batch
      })
    );
  }

  console.log(
    `WS abonelikleri: ` +
    `${args.length} kanal / ` +
    `${batches.length} paket`
  );
}

// ============================================================
// TICKER
// ============================================================

function processTicker(msg) {

  const rows =
    Array.isArray(msg.data)
      ? msg.data
      : [];

  state.stats.tickerMessages +=
    rows.length;

  for (
    const row of rows
  ) {

    const symbol =
      normalizeSymbol(
        row.instId ||
        row.symbol
      );

    if (!symbol) continue;

    const s =
      getSymbol(symbol);

    const price =
      num(
        row.lastPr ??
        row.lastPrice
      );

    if (!price) continue;

    s.price =
      price;

    s.bid =
      num(
        row.bidPr ??
        row.bid1Price
      );

    s.ask =
      num(
        row.askPr ??
        row.ask1Price
      );

    s.bidSize =
      num(
        row.bidSz ??
        row.bid1Size
      );

    s.askSize =
      num(
        row.askSz ??
        row.ask1Size
      );

    s.turnover24h =
      num(
        row.quoteVolume ??
        row.turnover24h
      );

    s.volume24h =
      num(
        row.baseVolume ??
        row.volume24h
      );

    const newOI =
      num(
        row.holdingAmount ??
        row.openInterest
      );

    if (newOI > 0) {

      if (s.oi > 0) {
        s.prevOi =
          s.oi;
      }

      s.oi =
        newOI;

      s.oiUpdatedAt =
        now();
    }

    s.priceHistory.push({
      ts: now(),
      price
    });

    const cutoff =
      now() -
      10 *
      60 *
      1000;

    s.priceHistory =
      s.priceHistory.filter(
        x =>
          x.ts >=
          cutoff
      );

    const flow =
      orderbookFlow(
        symbol
      );

    s.flowHistory.push({
      ts: now(),
      flow
    });

    s.flowHistory =
      s.flowHistory.filter(
        x =>
          x.ts >=
          cutoff
      );

    detectLevels(symbol);
  }
}

// ============================================================
// CANDLE
// ============================================================

function processCandle(msg) {

  const symbol =
    normalizeSymbol(
      msg.arg?.instId
    );

  if (!symbol) return;

  const s =
    getSymbol(symbol);

  const rows =
    Array.isArray(msg.data)
      ? msg.data
      : [];

  state.stats.candleMessages +=
    rows.length;

  for (
    const r of rows
  ) {

    const candle = {
      ts: num(r[0]),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      volume: num(r[5]),
      turnover: num(r[6])
    };

    if (!candle.close) {
      continue;
    }

    if (
      msg.arg.channel ===
      'candle1H'
    ) {

      upsertCandle(
        s.h1Candles,
        candle,
        120
      );

      build2HCandles(
        symbol
      );
    }

    if (
      msg.arg.channel ===
      'candle1m'
    ) {

      upsertCandle(
        s.minuteCandles,
        candle,
        120
      );
    }
  }
}

// ============================================================
// UPSERT CANDLE
// ============================================================

function upsertCandle(
  arr,
  candle,
  max
) {

  const existing =
    arr.findIndex(
      x =>
        x.ts ===
        candle.ts
    );

  if (
    existing >= 0
  ) {

    arr[existing] =
      candle;

  } else {

    arr.push(
      candle
    );
  }

  arr.sort(
    (a, b) =>
      a.ts -
      b.ts
  );

  while (
    arr.length >
    max
  ) {
    arr.shift();
  }
}

// ============================================================
// KEEPALIVE
// ============================================================

setInterval(
  () => {

    if (
      state.ws &&
      state.ws.readyState ===
        WebSocket.OPEN
    ) {

      try {
        state.ws.send(
          'ping'
        );
      } catch {}
    }

  },
  CFG.WS_PING_MS
);

// ============================================================
// API STATUS
// ============================================================

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      ok: true,

      system:
        'SONNY AI TRADER V6',

      mode:
        '2H PRE-BREAKOUT RADAR',

      wsConnected:
        state.wsConnected,

      symbols:
        state.symbols.size,

      signals:
        state.stats.signals,

      scans:
        state.stats.scans,

      lastScan:
        state.stats.lastScan,

      uptime:
        now() -
        state.startedAt
    });
  }
);

// ============================================================
// API SIGNALS
// ============================================================

app.get(
  '/api/signals',
  (req, res) => {

    const result = [];

    for (
      const s of
      state.symbols.values()
    ) {

      if (!s.signal) {
        continue;
      }

      if (
        s.signal.expiresAt <
        now()
      ) {
        continue;
      }

      result.push({

        ...s.signal,

        oi:
          s.oi,

        bid:
          s.bid,

        ask:
          s.ask,

        bidSize:
          s.bidSize,

        askSize:
          s.askSize,

        turnover24h:
          s.turnover24h
      });
    }

    result.sort(
      (a, b) =>
        b.score -
        a.score
    );

    res.json({

      ok: true,

      serverTime:
        now(),

      signals:
        result.slice(
          0,
          20
        )
    });
  }
);

// ============================================================
// API RADAR
// ============================================================

app.get(
  '/api/radar',
  (req, res) => {

    const rows = [];

    for (
      const s of
      state.symbols.values()
    ) {

      if (
        !s.price ||
        !s.level
      ) {
        continue;
      }

      const candidates = [];

      if (
        s.level.resistance &&
        s.price <
          s.level.resistance
      ) {

        const distance =
          absPct(
            s.price,
            s.level.resistance
          );

        if (
          distance <=
          CFG.WATCH_DISTANCE_PCT
        ) {

          candidates.push({

            direction:
              'LONG',

            level:
              s.level.resistance,

            distance
          });
        }
      }

      if (
        s.level.support &&
        s.price >
          s.level.support
      ) {

        const distance =
          absPct(
            s.price,
            s.level.support
          );

        if (
          distance <=
          CFG.WATCH_DISTANCE_PCT
        ) {

          candidates.push({

            direction:
              'SHORT',

            level:
              s.level.support,

            distance
          });
        }
      }

      for (
        const c of
        candidates
      ) {

        rows.push({

          symbol:
            s.symbol,

          direction:
            c.direction,

          price:
            s.price,

          level:
            c.level,

          distancePct:
            c.distance,

          volumeRatio:
            calculateVolumeRatio(
              s.symbol
            ),

          oiChangePct:
            oiChange(
              s.symbol
            ),

          flow:
            flowScore(
              s.symbol
            ),

          momentum:
            priceMomentum(
              s.symbol
            )
        });
      }
    }

    rows.sort(
      (a, b) =>
        a.distancePct -
        b.distancePct
    );

    res.json({

      ok: true,

      radar:
        rows.slice(
          0,
          50
        )
    });
  }
);

// ============================================================
// MAIN PAGE
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Sonny AI Trader V6
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #090d12;
  color: #e8edf3;
  font-family: Arial, sans-serif;
}

header {
  padding: 20px;
  border-bottom: 1px solid #1d2630;
}

h1 {
  margin: 0 0 6px;
  font-size: 24px;
}

.subtitle {
  color: #8995a3;
  font-size: 13px;
}

.status {
  margin-top: 10px;
  font-size: 13px;
}

.container {
  padding: 18px;
  max-width: 1400px;
  margin: auto;
}

.section {
  margin-bottom: 25px;
}

.section h2 {
  font-size: 16px;
  margin-bottom: 12px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fill, minmax(310px, 1fr));
  gap: 12px;
}

.card {
  background: #10161e;
  border: 1px solid #202a35;
  border-radius: 12px;
  padding: 15px;
}

.card.long {
  border-left: 4px solid #19c37d;
}

.card.short {
  border-left: 4px solid #ff5964;
}

.symbol {
  font-size: 18px;
  font-weight: bold;
}

.direction {
  font-size: 12px;
  margin-left: 8px;
  padding: 4px 7px;
  border-radius: 5px;
}

.long .direction {
  background: #123d2e;
  color: #35e09a;
}

.short .direction {
  background: #441d23;
  color: #ff737d;
}

.state {
  margin-top: 12px;
  font-weight: bold;
  font-size: 15px;
}

.score {
  font-size: 28px;
  font-weight: bold;
  margin: 10px 0;
}

.metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  color: #aeb8c4;
  font-size: 12px;
}

.metric {
  background: #0b1016;
  padding: 8px;
  border-radius: 6px;
}

.metric b {
  display: block;
  color: #f0f3f6;
  margin-top: 3px;
}

.empty {
  color: #687583;
  padding: 30px;
  text-align: center;
}

small {
  color: #697684;
}

</style>

</head>

<body>

<header>

<h1>
SONNY AI TRADER V6
</h1>

<div class="subtitle">
2H PRE-BREAKOUT RADAR
</div>

<div
  class="status"
  id="status"
>
Bağlanıyor...
</div>

</header>

<div class="container">

<div class="section">

<h2>
🔥 AKTİF SİNYALLER
</h2>

<div
  id="signals"
  class="grid"
>

<div class="empty">
Sinyal aranıyor...
</div>

</div>

</div>

<div class="section">

<h2>
📡 2H SEVİYE RADARI
</h2>

<div
  id="radar"
  class="grid"
>

<div class="empty">
Radar hazırlanıyor...
</div>

</div>

</div>

</div>

<script>

function esc(v) {

  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function n(v, d = 2) {

  const x =
    Number(v);

  if (
    !Number.isFinite(x)
  ) {
    return '-';
  }

  return x.toFixed(d);
}

async function load() {

  try {

    const [
      statusRes,
      signalRes,
      radarRes
    ] =
      await Promise.all([

        fetch('/api/status'),

        fetch('/api/signals'),

        fetch('/api/radar')

      ]);

    const status =
      await statusRes.json();

    const signalData =
      await signalRes.json();

    const radarData =
      await radarRes.json();

    document.getElementById(
      'status'
    ).innerHTML =

      status.wsConnected

        ? '🟢 LIVE · ' +
          status.symbols +
          ' market · ' +
          signalData.signals.length +
          ' aktif sinyal'

        : '🔴 WebSocket bağlantısı bekleniyor';

    renderSignals(
      signalData.signals
    );

    renderRadar(
      radarData.radar
    );

  } catch (err) {

    document.getElementById(
      'status'
    ).innerHTML =
      '🔴 Sunucu bağlantı hatası';

  }
}

function renderSignals(rows) {

  const el =
    document.getElementById(
      'signals'
    );

  if (!rows.length) {

    el.innerHTML =
      '<div class="empty">' +
      'Şu anda erken kırılım adayı yok.' +
      '</div>';

    return;
  }

  el.innerHTML =
    rows.map(
      function(s) {

        const cls =
          s.direction === 'LONG'
            ? 'long'
            : 'short';

        return (

          '<div class="card ' +
          cls +
          '">' +

          '<div>' +

          '<span class="symbol">' +
          esc(s.symbol) +
          '</span>' +

          '<span class="direction">' +
          esc(s.direction) +
          '</span>' +

          '</div>' +

          '<div class="state">' +
          esc(s.state) +
          '</div>' +

          '<div class="score">' +
          n(s.score, 0) +
          '/100' +
          '</div>' +

          '<div class="metrics">' +

          '<div class="metric">' +
          'Fiyat' +
          '<b>' +
          n(s.price, 6) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          '2H Seviye' +
          '<b>' +
          n(s.level, 6) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Seviyeye uzaklık' +
          '<b>%' +
          n(s.distancePct) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Hacim' +
          '<b>' +
          n(s.volumeRatio) +
          'x' +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'OI' +
          '<b>%' +
          n(s.oiChangePct) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Flow' +
          '<b>' +
          n(s.flow * 100, 1) +
          '%' +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Momentum' +
          '<b>%' +
          n(s.momentum) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Zaman' +
          '<b>' +
          new Date(
            s.createdAt
          ).toLocaleTimeString(
            'tr-TR'
          ) +
          '</b>' +
          '</div>' +

          '</div>' +

          '</div>'

        );

      }
    ).join('');
}

function renderRadar(rows) {

  const el =
    document.getElementById(
      'radar'
    );

  if (!rows.length) {

    el.innerHTML =
      '<div class="empty">' +
      '2H seviyesine yaklaşan coin yok.' +
      '</div>';

    return;
  }

  el.innerHTML =
    rows.map(
      function(s) {

        const cls =
          s.direction === 'LONG'
            ? 'long'
            : 'short';

        return (

          '<div class="card ' +
          cls +
          '">' +

          '<div>' +

          '<span class="symbol">' +
          esc(s.symbol) +
          '</span>' +

          '<span class="direction">' +
          esc(s.direction) +
          '</span>' +

          '</div>' +

          '<div class="state">' +
          '2H seviyesine yaklaşıyor' +
          '</div>' +

          '<div class="score">%' +
          n(s.distancePct) +
          '</div>' +

          '<div class="metrics">' +

          '<div class="metric">' +
          'Fiyat' +
          '<b>' +
          n(s.price, 6) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Seviye' +
          '<b>' +
          n(s.level, 6) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Hacim' +
          '<b>' +
          n(s.volumeRatio) +
          'x' +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'OI' +
          '<b>%' +
          n(s.oiChangePct) +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Flow' +
          '<b>' +
          n(s.flow * 100, 1) +
          '%' +
          '</b>' +
          '</div>' +

          '<div class="metric">' +
          'Momentum' +
          '<b>%' +
          n(s.momentum) +
          '</b>' +
          '</div>' +

          '</div>' +

          '</div>'

        );

      }
    ).join('');
}

load();

setInterval(
  load,
  5000
);

</script>

</body>

</html>
    `);
}

// ============================================================
// START
// ============================================================

async function boot() {

  console.log('');
  console.log(
    '=========================================='
  );
  console.log(
    ' SONNY AI TRADER V6'
  );
  console.log(
    ' 2H PRE-BREAKOUT RADAR'
  );
  console.log(
    '=========================================='
  );
  console.log('');

  try {

    await loadSymbols();

    console.log(
      'İlk historical candle yüklemesi başlıyor...'
    );

    const symbols =
      Array.from(
        state.symbols.keys()
      ).slice(
        0,
        CFG.MAX_SYMBOLS
      );

    for (
      let i = 0;
      i < symbols.length;
      i++
    ) {

      await load1HCandles(
        symbols[i]
      );

      await new Promise(
        r =>
          setTimeout(
            r,
            80
          )
      );
    }

    console.log(
      'Historical seviyeler hazır.'
    );

    connectWS();

    setInterval(
      scan,
      CFG.SCAN_INTERVAL_MS
    );

    scan();

  } catch (err) {

    console.error(
      'BOOT ERROR:',
      err
    );

    process.exit(1);
  }
}

// ============================================================
// SERVER
// ============================================================

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Server listening on ${PORT}`
    );

    boot();
  }
);
