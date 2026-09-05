'use strict';

/*
=============================================================
 SONNY AI TRADER — RED TEAM V4
 MOMENTUM SCALPER / MANUEL GİRİŞ

 500 RADAR
    ↓
 50 CANLI
    ↓
 15M BAĞLAM
    ↓
 CANLI FİYAT + TRADE FLOW + OI + HACİM
    ↓
 🟡 İZLE
    ↓
 🟠 HAREKET BAŞLADI
    ↓
 🔵 BEKLE
    ↓
 🟢 GİRİŞ FIRSATI
    ↓
 🔴 MOMENTUM ZAYIFLIYOR

 ÖNEMLİ:
 - AUTO TRADE KAPALI
 - GEÇMİŞ SİNYAL UI'YA VERİLMEZ
 - GEÇ KALINMIŞ PUMP KOVALANMAZ
 - ENTRY sadece WAIT + 5M + 1M teyidi ile oluşur
 - WS 4 bağlantıya bölünür
 - WS subscribe spamı yok
 - UI içinde nested template literal yok
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

/* =========================================================
   CONFIG
========================================================= */

const CFG = {

  RADAR: 500,

  LIVE_SYMBOLS: 50,

  CONTEXT_SYMBOLS: 50,

  MIN_VOLUME_USDT:
    Number(process.env.MIN_VOLUME_USDT || 1000000),

  DISCOVERY_MS:
    2 * 60 * 1000,

  CONTEXT_MS:
    60 * 1000,

  CANDLE_CACHE_MS:
    45 * 1000,

  /* -----------------------------
     SIGNAL CAPACITY
  ----------------------------- */

  MAX_SIGNALS: 8,

  MAX_ENTRY_SIGNALS: 3,

  COOLDOWN_MS:
    25 * 60 * 1000,

  WATCH_TTL_MS:
    4 * 60 * 1000,

  ENTRY_TTL_MS:
    75 * 1000,

  /* -----------------------------
     SCORE
  ----------------------------- */

  WATCH_SCORE: 52,

  IGNITION_SCORE: 64,

  WAIT_SCORE: 72,

  ENTRY_SCORE: 82,

  /* -----------------------------
     VOLUME
  ----------------------------- */

  VOLUME_WATCH: 1.25,

  VOLUME_IGNITION: 1.60,

  VOLUME_ENTRY: 2.00,

  /* -----------------------------
     FLOW
  ----------------------------- */

  FLOW_WATCH: 0.54,

  FLOW_IGNITION: 0.57,

  FLOW_ENTRY: 0.63,

  /* -----------------------------
     PRICE MOMENTUM
  ----------------------------- */

  PRICE_10S_WATCH: 0.05,

  PRICE_15S_IGNITION: 0.10,

  PRICE_30S_ENTRY: 0.22,

  /* -----------------------------
     OI
  ----------------------------- */

  OI_CONFIRM_PCT: 0.08,

  OI_STRONG_PCT: 0.25,

  /* -----------------------------
     SPREAD
  ----------------------------- */

  MAX_SPREAD_PCT: 0.12,

  /* -----------------------------
     TOO LATE
  ----------------------------- */

  MAX_EXTENSION_ATR: 0.80,

  MAX_EXTENSION_PCT: 0.35,

  MAX_ENTRY_AGE_MS:
    90 * 1000,

  MAX_WAIT_AGE_MS:
    120 * 1000,

  /* -----------------------------
     EXHAUSTION
  ----------------------------- */

  EXHAUST_FLOW_DROP: 0.09,

  EXHAUST_PRICE_STALL: 0.03,

  EXHAUST_VOLUME_DROP: 0.35,

  /* -----------------------------
     TECHNICAL
  ----------------------------- */

  EMA: 21,

  ATR: 10,

  BREAKOUT_LOOKBACK: 12,

  M15_LIMIT: 160,

  M5_LIMIT: 60,

  M1_LIMIT: 60,

  /* -----------------------------
     BITGET WS
  ----------------------------- */

  WS_URL:
    'wss://ws.bitget.com/v2/ws/public',

  WS_GROUP_SIZE: 15,

  WS_PING_MS:
    25 * 1000,

  WS_STALE_MS:
    70 * 1000,

  /* -----------------------------
     UI
  ----------------------------- */

  BROADCAST_MS:
    250,

  DEBUG:
    process.env.DEBUG === 'true'
};


/* =========================================================
   BITGET
========================================================= */

const exchange = new ccxt.bitget({

  enableRateLimit: true,

  timeout: 25000,

  options: {
    defaultType: 'swap'
  }

});


/* =========================================================
   STATE
========================================================= */

const STATE = {

  markets: [],

  marketMap: new Map(),

  universe: [],

  liveUniverse: [],

  context: new Map(),

  live: new Map(),

  signals: new Map(),

  cooldowns: new Map(),

  selected:
    'BTC/USDT:USDT',

  selectedTf:
    '15m',

  ws: [],

  wsConnected: false,

  wsLastMessage: 0,

  wsReconnects: 0,

  lastDiscovery: 0,

  lastContext: 0,

  scanning: false,

  lastError: '',

  market: {

    label:
      'YATAY / KARIŞIK',

    direction:
      'FLAT',

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


/* =========================================================
   CACHE / QUEUE
========================================================= */

const candleCache =
  new Map();

let restBusy = false;

const restQueue = [];

let broadcastTimer = null;


/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

  return new Promise(function(resolve) {

    setTimeout(resolve, ms);

  });

}


function avg(a) {

  if (!a.length) return 0;

  return a.reduce(
    function(x, y) {
      return x + y;
    },
    0
  ) / a.length;

}


function clamp(v, a, b) {

  return Math.max(
    a,
    Math.min(b, v)
  );

}


function num(v, d) {

  if (d === undefined) d = 6;

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

  if (!Number.isFinite(n)) {
    return '-';
  }

  if (n >= 1000) {
    return n.toFixed(2);
  }

  if (n >= 100) {
    return n.toFixed(3);
  }

  if (n >= 1) {
    return n.toFixed(5);
  }

  if (n >= 0.01) {
    return n.toFixed(7);
  }

  if (n >= 0.0001) {
    return n.toFixed(8);
  }

  return n.toFixed(10);

}


function volumeFmt(v) {

  const n = Number(v) || 0;

  if (n >= 1e9) {
    return (
      n / 1e9
    ).toFixed(2) + 'B';
  }

  if (n >= 1e6) {
    return (
      n / 1e6
    ).toFixed(2) + 'M';
  }

  if (n >= 1e3) {
    return (
      n / 1e3
    ).toFixed(1) + 'K';
  }

  return Math.round(n).toString();

}


function cleanSymbol(symbol) {

  let s =
    String(symbol || '')
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

  return (
    instId.replace('USDT', '')
    + '/USDT:USDT'
  );

}


function closed(c) {

  if (!Array.isArray(c)) {
    return [];
  }

  if (c.length <= 1) {
    return c;
  }

  return c.slice(0, -1);

}


/* =========================================================
   REST QUEUE
========================================================= */

async function processRestQueue() {

  if (restBusy) {
    return;
  }

  restBusy = true;

  while (restQueue.length) {

    const task =
      restQueue.shift();

    try {

      task.resolve(
        await task.fn()
      );

    } catch (e) {

      task.reject(e);

    }

    await sleep(350);

  }

  restBusy = false;

}


function rest(fn) {

  return new Promise(
    function(resolve, reject) {

      restQueue.push({
        fn: fn,
        resolve: resolve,
        reject: reject
      });

      processRestQueue();

    }
  );

}


/* =========================================================
   MARKET LOAD
========================================================= */

async function loadMarkets() {

  const markets =
    await exchange.loadMarkets(true);

  STATE.markets =
    Object.values(markets)
      .filter(function(m) {

        return (
          m &&
          m.active !== false &&
          m.swap === true &&
          m.linear === true &&
          m.quote === 'USDT' &&
          m.settle === 'USDT'
        );

      });

  STATE.marketMap =
    new Map(
      STATE.markets.map(
        function(m) {
          return [
            m.symbol,
            m
          ];
        }
      )
    );

  console.log(
    'MARKETLER | USDT perpetual: '
    + STATE.markets.length
  );

}


async function loadMarketsRetry() {

  let last;

  for (
    let i = 0;
    i < 3;
    i++
  ) {

    try {

      await loadMarkets();

      return;

    } catch (e) {

      last = e;

      console.error(
        'Market yükleme '
        + (i + 1)
        + '/3:',
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
  timeframe,
  limit
) {

  if (!timeframe) {
    timeframe = '15m';
  }

  if (!limit) {
    limit = 160;
  }

  const key =
    symbol
    + '|'
    + timeframe
    + '|'
    + limit;

  const cached =
    candleCache.get(key);

  if (
    cached &&
    Date.now() - cached.time
      < CFG.CANDLE_CACHE_MS
  ) {

    return cached.data;

  }

  try {

    const data =
      await rest(
        function() {
          return exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
          );
        }
      );

    const clean =
      Array.isArray(data)
        ? data
            .filter(function(x) {
              return (
                Array.isArray(x) &&
                x.length >= 6
              );
            })
            .sort(function(a, b) {
              return a[0] - b[0];
            })
        : [];

    candleCache.set(
      key,
      {
        time: Date.now(),
        data: clean
      }
    );

    return clean;

  } catch (e) {

    STATE.lastError =
      e.message;

    if (CFG.DEBUG) {

      console.error(
        'Mum alınamadı '
        + symbol
        + ' '
        + timeframe
        + ':',
        e.message
      );

    }

    return cached
      ? cached.data
      : [];

  }

}


/* =========================================================
   INDICATORS
========================================================= */

function ATR(
  candles,
  period
) {

  if (!period) {
    period = CFG.ATR;
  }

  const c =
    closed(candles);

  if (
    c.length <
    period + 1
  ) {
    return 0;
  }

  const tr = [];

  for (
    let i = 1;
    i < c.length;
    i++
  ) {

    const h = +c[i][2];

    const l = +c[i][3];

    const pc = +c[i - 1][4];

    tr.push(
      Math.max(
        h - l,
        Math.abs(h - pc),
        Math.abs(l - pc)
      )
    );

  }

  return avg(
    tr.slice(-period)
  );

}


function EMA(
  candles,
  period
) {

  if (!period) {
    period = CFG.EMA;
  }

  const c =
    closed(candles);

  if (
    c.length <
    period
  ) {
    return 0;
  }

  const closes =
    c.map(function(x) {
      return +x[4];
    });

  const k =
    2 / (period + 1);

  let e =
    avg(
      closes.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < closes.length;
    i++
  ) {

    e =
      closes[i] * k
      +
      e * (1 - k);

  }

  return e;

}


function VWAP(
  candles,
  lookback
) {

  if (!lookback) {
    lookback = 80;
  }

  const c =
    closed(candles)
      .slice(-lookback);

  let pv = 0;

  let v = 0;

  for (
    const x of c
  ) {

    const tp =
      (
        +x[2]
        +
        +x[3]
        +
        +x[4]
      ) / 3;

    const vol =
      +x[5] || 0;

    pv +=
      tp * vol;

    v += vol;

  }

  return v
    ? pv / v
    : 0;

}


/* =========================================================
   15M CONTEXT
========================================================= */

function buildContext(candles) {

  const c =
    closed(candles);

  if (c.length < 60) {
    return null;
  }

  const last =
    c[c.length - 1];

  const close =
    +last[4];

  const ema =
    EMA(candles);

  const vwap =
    VWAP(candles);

  const atr =
    ATR(candles);

  if (
    !ema ||
    !vwap ||
    !atr
  ) {
    return null;
  }

  const recent =
    c.slice(
      -CFG.BREAKOUT_LOOKBACK - 1,
      -1
    );

  if (!recent.length) {
    return null;
  }

  const high =
    Math.max.apply(
      null,
      recent.map(function(x) {
        return +x[2];
      })
    );

  const low =
    Math.min.apply(
      null,
      recent.map(function(x) {
        return +x[3];
      })
    );

  const ranges =
    c.slice(-16).map(
      function(x) {
        return (
          +x[2] - +x[3]
        );
      }
    );

  const recentRange =
    avg(
      ranges.slice(-4)
    );

  const oldRange =
    avg(
      ranges.slice(0, 12)
    );

  const compression =
    oldRange > 0
      ? recentRange / oldRange
      : 1;

  let direction =
    'FLAT';

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

    direction: direction,

    close: close,

    ema: ema,

    vwap: vwap,

    atr: atr,

    recentHigh: high,

    recentLow: low,

    compression:
      compression,

    updatedAt:
      Date.now()

  };

}


/* =========================================================
   DISCOVERY
========================================================= */

async function discoverUniverse() {

  try {

    const tickers =
      await rest(
        function() {
          return exchange.fetchTickers();
        }
      );

    const rows = [];

    for (
      const market of STATE.markets
    ) {

      const t =
        tickers[market.symbol];

      if (!t) {
        continue;
      }

      const price =
        Number(
          t.last ||
          t.close
        );

      const volume =
        Number(
          t.quoteVolume ||
          0
        );

      const change =
        Number(
          t.percentage ||
          0
        );

      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        volume <
          CFG.MIN_VOLUME_USDT
      ) {

        continue;

      }

      rows.push({

        symbol:
          market.symbol,

        instId:
          cleanSymbol(
            market.symbol
          ),

        price: price,

        volume: volume,

        volumeFormatted:
          volumeFmt(volume),

        change: change

      });

    }

    rows.sort(
      function(a, b) {

        const sa =
          Math.abs(a.change)
          * 0.70
          +
          Math.log10(
            a.volume + 1
          )
          * 0.30;

        const sb =
          Math.abs(b.change)
          * 0.70
          +
          Math.log10(
            b.volume + 1
          )
          * 0.30;

        return sb - sa;

      }
    );

    STATE.universe =
      rows.slice(
        0,
        CFG.RADAR
      );

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
      'RADAR | '
      + STATE.universe.length
      + ' coin | LIVE '
      + STATE.liveUniverse.length
    );

    return true;

  } catch (e) {

    STATE.lastError =
      e.message;

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

  for (
    const r of rows
  ) {

    if (r.change > 0.5) {
      green++;
    }

    if (r.change < -0.5) {
      red++;
    }

    total +=
      r.change;

  }

  const breadth =
    green /
    Math.max(
      green + red,
      1
    ) *
    100;

  const average =
    total /
    rows.length;

  const btc =
    rows.find(
      function(r) {
        return r.symbol.includes(
          'BTC'
        );
      }
    );

  const eth =
    rows.find(
      function(r) {
        return r.symbol.includes(
          'ETH'
        );
      }
    );

  let direction =
    'FLAT';

  let label =
    'YATAY / KARIŞIK';

  if (
    breadth >= 55 &&
    average >= 0.5
  ) {

    direction = 'LONG';

    label =
      'POZİTİF / YÜKSELİŞ';

  } else if (
    breadth <= 45 &&
    average <= -0.5
  ) {

    direction = 'SHORT';

    label =
      'NEGATİF / DÜŞÜŞ';

  }

  STATE.market = {

    label: label,

    direction: direction,

    breadth:
      num(breadth, 1),

    green: green,

    red: red,

    average:
      num(average, 2),

    btc:
      btc && btc.change > 1
        ? 'LONG'
        : btc && btc.change < -1
          ? 'SHORT'
          : 'NÖTR',

    eth:
      eth && eth.change > 1
        ? 'LONG'
        : eth && eth.change < -1
          ? 'SHORT'
          : 'NÖTR'

  };

}


/* =========================================================
   LIVE DATA
========================================================= */

function getLive(instId) {

  if (
    !STATE.live.has(instId)
  ) {

    STATE.live.set(
      instId,
      {

        symbol:
          ccxtSymbol(instId),

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

        lastMomentum: null

      }
    );

  }

  return STATE.live.get(
    instId
  );

}


function trimLive(
  l,
  now
) {

  if (!now) {
    now = Date.now();
  }

  while (
    l.prices.length &&
    l.prices[0].time <
      now - 120000
  ) {

    l.prices.shift();

  }

  while (
    l.trades.length &&
    l.trades[0].time <
      now - 120000
  ) {

    l.trades.shift();

  }

  while (
    l.oiSamples.length &&
    l.oiSamples[0].time <
      now - 120000
  ) {

    l.oiSamples.shift();

  }

}


function addTicker(
  instId,
  data
) {

  const l =
    getLive(instId);

  const price =
    Number(
      data.lastPr ||
      data.last ||
      data.close ||
      0
    );

  if (!price) {
    return;
  }

  const now =
    Date.now();

  l.price =
    price;

  l.bid =
    Number(
      data.bidPr ||
      0
    );

  l.ask =
    Number(
      data.askPr ||
      0
    );

  l.volume24h =
    Number(
      data.quoteVolume ||
      0
    );

  const oi =
    Number(
      data.holdingAmount ||
      data.openInterest ||
      0
    );

  if (oi > 0) {

    l.oi =
      oi;

    l.oiSamples.push({
      time: now,
      value: oi
    });

  }

  l.prices.push({
    time: now,
    value: price
  });

  l.lastUpdate =
    now;

  trimLive(
    l,
    now
  );

  evaluateLive(
    instId
  );

}


function addTrade(
  instId,
  data
) {

  const l =
    getLive(instId);

  const price =
    Number(
      data.price
    );

  const size =
    Number(
      data.size
    );

  if (
    !price ||
    !size
  ) {
    return;
  }

  const notional =
    price * size;

  const now =
    Date.now();

  const side =
    String(
      data.side || ''
    ).toLowerCase();

  if (
    side === 'buy'
  ) {

    l.buyNotional +=
      notional;

  } else {

    l.sellNotional +=
      notional;

  }

  l.trades.push({

    time: now,

    side: side,

    notional:
      notional

  });

  l.lastUpdate =
    now;

  trimLive(
    l,
    now
  );

  evaluateLive(
    instId
  );

}


/* =========================================================
   LIVE METRICS
========================================================= */

function windowTrades(
  l,
  ms
) {

  const cut =
    Date.now() - ms;

  return l.trades.filter(
    function(t) {
      return t.time >= cut;
    }
  );

}


function flowRatio(
  l,
  ms
) {

  if (!ms) {
    ms = 30000;
  }

  const t =
    windowTrades(
      l,
      ms
    );

  let b = 0;

  let s = 0;

  for (
    const x of t
  ) {

    if (
      x.side === 'buy'
    ) {

      b +=
        x.notional;

    } else {

      s +=
        x.notional;

    }

  }

  return (
    b + s
  )
    ? b / (b + s)
    : 0.5;

}


function priceMove(
  l,
  ms
) {

  const cut =
    Date.now() - ms;

  let base =
    null;

  for (
    const p of l.prices
  ) {

    if (
      p.time >= cut
    ) {

      base = p;

      break;

    }

  }

  return base
    ? pct(
        l.price,
        base.value
      )
    : 0;

}


function oiMove(
  l,
  ms
) {

  if (!ms) {
    ms = 30000;
  }

  const cut =
    Date.now() - ms;

  let base =
    null;

  for (
    const x of l.oiSamples
  ) {

    if (
      x.time >= cut
    ) {

      base = x;

      break;

    }

  }

  return (
    base &&
    base.value
  )
    ? (
        (l.oi - base.value)
        /
        Math.abs(base.value)
      ) * 100
    : 0;

}


function liveVolumeRatio(
  l,
  ms
) {

  if (!ms) {
    ms = 30000;
  }

  if (!l.volume24h) {
    return 1;
  }

  const expected =
    l.volume24h
    /
    (24 * 60 * 60 * 1000)
    *
    ms;

  const actual =
    windowTrades(
      l,
      ms
    ).reduce(
      function(sum, t) {
        return sum + t.notional;
      },
      0
    );

  return expected > 0
    ? actual / expected
    : 1;

}


function spreadPct(l) {

  if (
    !l.bid ||
    !l.ask
  ) {

    return 0;

  }

  return (
    (l.ask - l.bid)
    /
    ((l.ask + l.bid) / 2)
  ) * 100;

}


/* =========================================================
   MOMENTUM ENGINE
========================================================= */

function calculateMomentum(
  instId,
  context
) {

  const l =
    getLive(instId);

  if (
    !l.price ||
    !context
  ) {

    return null;

  }

  const p10 =
    priceMove(
      l,
      10000
    );

  const p15 =
    priceMove(
      l,
      15000
    );

  const p30 =
    priceMove(
      l,
      30000
    );

  const p60 =
    priceMove(
      l,
      60000
    );

  const flow =
    flowRatio(
      l,
      30000
    );

  const vol =
    liveVolumeRatio(
      l,
      30000
    );

  const oi =
    oiMove(
      l,
      30000
    );

  const spread =
    spreadPct(l);

  let direction =
    null;

  /*
   * Öncelik:
   * 15M yön + canlı fiyat
   */

  if (
    context.direction === 'LONG' &&
    p10 > 0
  ) {

    direction =
      'LONG';

  }

  if (
    context.direction === 'SHORT' &&
    p10 < 0
  ) {

    direction =
      'SHORT';

  }

  /*
   * Fallback:
   * 30 saniyelik güçlü hareket
   */

  if (
    !direction &&
    p30 > 0.12 &&
    flow > 0.60
  ) {

    direction =
      'LONG';

  }

  if (
    !direction &&
    p30 < -0.12 &&
    flow < 0.40
  ) {

    direction =
      'SHORT';

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

  /*
   * Fiyat
   */

  score += clamp(
    priceAbs / 0.45 * 25,
    0,
    25
  );

  /*
   * Flow
   */

  score += clamp(
    (strengthFlow - 0.50)
    /
    0.28
    * 25,
    0,
    25
  );

  /*
   * Hacim
   */

  score += clamp(
    (vol - 1)
    /
    3
    * 20,
    0,
    20
  );

  /*
   * OI
   *
   * Fiyat yönü + OI artışı
   * continuation için olumlu.
   */

  const oiAligned =
    oi > 0;

  const oiDivergence =
    oi < -0.15;

  if (oiAligned) {

    score += clamp(
      Math.abs(oi)
      /
      1.5
      * 15,
      0,
      15
    );

  } else if (
    oiDivergence
  ) {

    score += 3;

  } else {

    score += 6;

  }

  /*
   * Breakout
   */

  const breakout =
    direction === 'LONG'
      ? l.price > context.recentHigh
      : l.price < context.recentLow;

  if (breakout) {
    score += 10;
  }

  /*
   * Compression
   */

  if (
    context.compression < 0.80
  ) {

    score += 5;

  } else if (
    context.compression < 1
  ) {

    score += 2;

  }

  /*
   * Spread
   */

  if (
    spread >
    CFG.MAX_SPREAD_PCT
  ) {

    score -= 12;

  }

  return {

    direction:
      direction,

    score:
      Math.round(
        clamp(
          score,
          0,
          100
        )
      ),

    price:
      l.price,

    priceMove10s:
      num(p10, 3),

    priceMove15s:
      num(p15, 3),

    priceMove30s:
      num(p30, 3),

    priceMove60s:
      num(p60, 3),

    flow:
      num(
        flow * 100,
        1
      ),

    volumeRatio:
      num(vol, 2),

    oiChange:
      num(oi, 3),

    spread:
      num(spread, 4),

    breakout:
      breakout,

    compression:
      num(
        context.compression,
        2
      )

  };

}


/* =========================================================
   TOO LATE
========================================================= */

function tooLate(
  m,
  context
) {

  if (
    !m ||
    !context ||
    !m.price ||
    !context.atr
  ) {

    return false;

  }

  const level =
    m.direction === 'LONG'
      ? context.recentHigh
      : context.recentLow;

  if (
    !Number.isFinite(level) ||
    level <= 0
  ) {

    return false;

  }

  const distance =
    Math.abs(
      m.price - level
    );

  const atrExt =
    distance /
    context.atr;

  const pctExt =
    Math.abs(
      (m.price - level)
      /
      level
    ) * 100;

  /*
   * Kırılım seviyesinden
   * fazla uzaklaştıysa kovalamıyoruz.
   */

  if (
    atrExt >
    CFG.MAX_EXTENSION_ATR
  ) {

    return true;

  }

  if (
    pctExt >
    CFG.MAX_EXTENSION_PCT
  ) {

    return true;

  }

  /*
   * Son 10 saniyede
   * dikey hareket
   */

  if (
    Math.abs(
      m.priceMove10s
    ) > 0.55
  ) {

    return true;

  }

  /*
   * Son 30 saniyede
   * aşırı hareket
   */

  if (
    Math.abs(
      m.priceMove30s
    ) > 0.60
  ) {

    return true;

  }

  return false;

}


/* =========================================================
   EXHAUSTION
========================================================= */

function exhaustion(
  signal,
  m
) {

  if (
    !signal ||
    !m
  ) {

    return false;

  }

  const flowNow =
    m.direction === 'LONG'
      ? m.flow / 100
      : 1 - m.flow / 100;

  const previousFlow =
    signal.lastFlow ??
    flowNow;

  const flowDrop =
    previousFlow -
    flowNow;

  const previousVolume =
    signal.lastVolume || 0;

  const volumeDrop =
    previousVolume
    ? previousVolume -
      m.volumeRatio
    : 0;

  const stall =
    Math.abs(
      m.priceMove15s
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
    m.volumeRatio;

  return (
    weakFlow &&
    stall
  ) || (
    weakVolume &&
    stall
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

  if (
    !context ||
    !context.atr ||
    !price
  ) {

    return null;

  }

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

      entry:
        price,

      stop:
        price - risk,

      tp1:
        price + risk,

      tp2:
        price + risk * 1.7,

      tp3:
        price + risk * 2.5,

      risk:
        risk

    };

  }

  return {

    entry:
      price,

    stop:
      price + risk,

    tp1:
      price - risk,

    tp2:
      price - risk * 1.7,

    tp3:
      price - risk * 2.5,

    risk:
      risk

  };

}


/* =========================================================
   REASON
========================================================= */

function reasonFor(
  m,
  context
) {

  const a = [];

  if (
    m.breakout
  ) {

    a.push(
      'kırılım'
    );

  }

  if (
    m.volumeRatio >=
    CFG.VOLUME_ENTRY
  ) {

    a.push(
      'hacim patlaması'
    );

  } else if (
    m.volumeRatio >=
    CFG.VOLUME_IGNITION
  ) {

    a.push(
      'hacim artışı'
    );

  }

  if (
    m.direction === 'LONG' &&
    m.flow >= 63
  ) {

    a.push(
      'alış baskısı'
    );

  }

  if (
    m.direction === 'SHORT' &&
    m.flow <= 37
  ) {

    a.push(
      'satış baskısı'
    );

  }

  if (
    m.oiChange >=
    CFG.OI_CONFIRM_PCT
  ) {

    a.push(
      'OI destekli'
    );

  }

  if (
    context.compression < 0.8
  ) {

    a.push(
      'sıkışma sonrası'
    );

  }

  return a.length
    ? a.join(' + ')
    : 'momentum oluşuyor';

}


/* =========================================================
   STAGE
========================================================= */

function stageStatus(
  stage
) {

  const map = {

    WATCH:
      'İZLE',

    IGNITION:
      'HAREKET BAŞLADI',

    WAIT:
      'BEKLE',

    ENTRY:
      'GİRİŞ FIRSATI',

    EXHAUSTION:
      'MOMENTUM ZAYIFLIYOR',

    TOO_LATE:
      'GEÇ KALINDI'

  };

  return (
    map[stage] ||
    stage
  );

}


function stageClass(
  stage
) {

  if (
    stage === 'WATCH'
  ) {
    return 'watch';
  }

  if (
    stage === 'IGNITION'
  ) {
    return 'ignition';
  }

  if (
    stage === 'WAIT'
  ) {
    return 'wait';
  }

  if (
    stage === 'ENTRY'
  ) {
    return 'entry';
  }

  return 'bad';

}


/* =========================================================
   CREATE SIGNAL
========================================================= */

function createSignal(
  instId,
  m,
  context,
  stage
) {

  const plan =
    makePlan(
      m.direction,
      m.price,
      context
    );

  if (!plan) {
    return null;
  }

  const now =
    Date.now();

  return {

    id:
      instId +
      '|' +
      m.direction,

    symbol:
      ccxtSymbol(instId),

    marketSymbol:
      ccxtSymbol(instId),

    instId:
      instId,

    direction:
      m.direction,

    stage:
      stage,

    status:
      stageStatus(stage),

    stageClass:
      stageClass(stage),

    signalAt:
      now,

    stageAt:
      now,

    lastUpdate:
      now,

    ageSeconds:
      0,

    entry:
      num(
        plan.entry
      ),

    entryLow:
      num(
        m.direction === 'LONG'
          ? plan.entry * 0.998
          : plan.entry * 1.002
      ),

    entryHigh:
      num(
        m.direction === 'LONG'
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

    rr:
      1,

    currentPrice:
      num(m.price),

    score:
      m.score,

    momentumScore:
      m.score,

    priceMove10s:
      m.priceMove10s,

    priceMove15s:
      m.priceMove15s,

    priceMove30s:
      m.priceMove30s,

    priceMove60s:
      m.priceMove60s,

    flow:
      m.flow,

    volumeRatio:
      m.volumeRatio,

    oiChange:
      m.oiChange,

    spread:
      m.spread,

    breakout:
      m.breakout,

    compression:
      m.compression,

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
        m,
        context
      ),

    entryWindowEnds:
      null,

    lastFlow:
      m.direction === 'LONG'
        ? m.flow / 100
        : 1 - m.flow / 100,

    lastVolume:
      m.volumeRatio,

    lastReason:
      'Yeni canlı hareket',

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


/* =========================================================
   ACTIVE SIGNAL
========================================================= */

function activeSignalFor(
  instId
) {

  for (
    const s of STATE.signals.values()
  ) {

    if (
      s.instId === instId
    ) {

      return s;

    }

  }

  return null;

}


function entryCount() {

  let count = 0;

  for (
    const s of STATE.signals.values()
  ) {

    if (
      s.stage === 'ENTRY'
    ) {

      count++;

    }

  }

  return count;

}


function setStage(
  s,
  stage,
  reason
) {

  s.stage =
    stage;

  s.status =
    stageStatus(stage);

  s.stageClass =
    stageClass(stage);

  s.stageAt =
    Date.now();

  if (reason) {

    s.lastReason =
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

  signal.tfConfirmPending =
    true;

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

    /*
     * 5M
     */

    if (
      c5.length >= 8
    ) {

      const last =
        c5[c5.length - 1];

      const prev =
        c5[c5.length - 2];

      const avgVol =
        avg(
          c5
            .slice(-8, -1)
            .map(function(x) {
              return +x[5] || 0;
            })
        );

      const vol =
        +last[5] || 0;

      if (
        signal.direction ===
        'LONG'
      ) {

        signal.tf5Confirm =
          +last[4] >
          +prev[4] &&
          vol >=
          avgVol * 0.9;

      } else {

        signal.tf5Confirm =
          +last[4] <
          +prev[4] &&
          vol >=
          avgVol * 0.9;

      }

    }

    /*
     * 1M
     */

    if (
      c1.length >= 6
    ) {

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

      if (
        signal.direction ===
        'LONG'
      ) {

        signal.tf1Confirm =
          +last[4] >
          +prev[4] &&
          +last[4] >
          +last[1] &&
          body / range >= 0.25;

      } else {

        signal.tf1Confirm =
          +last[4] <
          +prev[4] &&
          +last[4] <
          +last[1] &&
          body / range >= 0.25;

      }

    }

    signal.tfConfirmAt =
      Date.now();

  } catch (e) {

    signal.tf5Confirm =
      false;

    signal.tf1Confirm =
      false;

    signal.lastReason =
      'Alt zaman dilimi teyidi alınamadı';

  } finally {

    signal.tfConfirmPending =
      false;

    scheduleBroadcast();

  }

}


/* =========================================================
   UPDATE SIGNAL
========================================================= */

function updateSignal(
  signal,
  m,
  context
) {

  const now =
    Date.now();

  signal.lastUpdate =
    now;

  signal.ageSeconds =
    Math.floor(
      (
        now -
        signal.signalAt
      ) / 1000
    );

  Object.assign(
    signal,
    {

      currentPrice:
        num(m.price),

      score:
        m.score,

      momentumScore:
        m.score,

      priceMove10s:
        m.priceMove10s,

      priceMove15s:
        m.priceMove15s,

      priceMove30s:
        m.priceMove30s,

      priceMove60s:
        m.priceMove60s,

      flow:
        m.flow,

      volumeRatio:
        m.volumeRatio,

      oiChange:
        m.oiChange,

      spread:
        m.spread,

      breakout:
        m.breakout,

      compression:
        m.compression,

      reason:
        reasonFor(
          m,
          context
        )

    }
  );

  /*
   * SPREAD
   */

  if (
    m.spread >
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
   * TOO LATE
   *
   * WAIT ve ENTRY'de
   * hareket fazla uzadıysa
   * artık giriş yok.
   */

  if (
    (
      signal.stage === 'ENTRY' ||
      signal.stage === 'WAIT'
    ) &&
    tooLate(
      m,
      context
    )
  ) {

    setStage(
      signal,
      'TOO_LATE',
      'Fiyat kırılımın fazla uzağına gitti'
    );

    return;

  }

  /*
   * ENTRY AGE
   */

  if (
    signal.stage === 'ENTRY' &&
    now -
      signal.stageAt >
      CFG.MAX_ENTRY_AGE_MS
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Giriş penceresi zaman aşımına uğradı'
    );

    return;

  }

  /*
   * EXHAUSTION
   */

  if (
    signal.stage === 'ENTRY' &&
    exhaustion(
      signal,
      m
    )
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Momentum zayıfladı'
    );

    return;

  }

  /*
   * FLOW DÖNÜŞÜ
   */

  const alignedFlow =
    m.direction === 'LONG'
      ? m.flow / 100
      : 1 - m.flow / 100;

  if (
    (
      signal.stage === 'IGNITION' ||
      signal.stage === 'WAIT'
    ) &&
    alignedFlow < 0.50 &&
    Math.abs(
      m.priceMove30s
    ) < 0.03
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Fiyat ilerlemiyor, akış zayıf'
    );

    return;

  }

  /*
   * WATCH → IGNITION
   */

  if (
    signal.stage === 'WATCH' &&
    m.score >=
      CFG.IGNITION_SCORE &&
    m.volumeRatio >=
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
   * WATCH / IGNITION → WAIT
   *
   * Sadece erken kırılım.
   */

  if (
    (
      signal.stage === 'WATCH' ||
      signal.stage === 'IGNITION'
    ) &&
    m.score >=
      CFG.WAIT_SCORE &&
    m.breakout &&
    !tooLate(
      m,
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
   * WAIT TIMEOUT
   */

  if (
    signal.stage === 'WAIT' &&
    now -
      signal.stageAt >
      CFG.MAX_WAIT_AGE_MS
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Teyit çok uzun sürdü'
    );

    return;

  }

  /*
   * WAIT → CONFIRM REFRESH
   */

  if (
    signal.stage === 'WAIT' &&
    m.score >=
      CFG.WAIT_SCORE &&
    m.breakout &&
    !tooLate(
      m,
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
   * WAIT → ENTRY
   *
   * ARTIK ENTRY:
   *
   * 1. WAIT
   * 2. score
   * 3. volume
   * 4. breakout
   * 5. tooLate değil
   * 6. 5M teyit
   * 7. 1M teyit
   * 8. entry limit
   */

  if (
    signal.stage === 'WAIT' &&
    m.score >=
      CFG.ENTRY_SCORE &&
    m.volumeRatio >=
      CFG.VOLUME_ENTRY &&
    m.breakout &&
    !tooLate(
      m,
      context
    ) &&
    signal.tf5Confirm &&
    signal.tf1Confirm &&
    entryCount() <
      CFG.MAX_ENTRY_SIGNALS
  ) {

    const plan =
      makePlan(
        m.direction,
        m.price,
        context
      );

    if (plan) {

      signal.entry =
        num(plan.entry);

      signal.entryLow =
        num(
          m.direction === 'LONG'
            ? plan.entry * 0.998
            : plan.entry * 1.002
        );

      signal.entryHigh =
        num(
          m.direction === 'LONG'
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
      '5M + 1M teyidi tamamlandı'
    );

    return;

  }

  /*
   * GENEL TIMEOUT
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
      'Kurulum süresi doldu'
    );

    return;

  }

}


/* =========================================================
   EVALUATE LIVE
========================================================= */

function evaluateLive(
  instId
) {

  const context =
    STATE.context.get(
      ccxtSymbol(instId)
    );

  if (!context) {
    return;
  }

  const m =
    calculateMomentum(
      instId,
      context
    );

  if (!m) {
    return;
  }

  let signal =
    activeSignalFor(
      instId
    );

  /*
   * YENİ SİNYAL
   */

  if (!signal) {

    if (
      m.score <
      CFG.WATCH_SCORE
    ) {

      return;

    }

    const key =
      instId +
      '|' +
      m.direction;

    const last =
      STATE.cooldowns.get(
        key
      );

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

    /*
     * ÖNEMLİ:
     *
     * İlk anda ENTRY YOK.
     *
     * En fazla WAIT.
     */

    let initialStage =
      'WATCH';

    /*
     * Erken kırılım ise WAIT.
     */

    if (
      m.score >=
        CFG.WAIT_SCORE &&
      m.breakout &&
      !tooLate(
        m,
        context
      ) &&
      Math.abs(
        m.priceMove30s
      ) <= 0.35
    ) {

      initialStage =
        'WAIT';

    } else if (
      m.score >=
        CFG.IGNITION_SCORE &&
      m.volumeRatio >=
        CFG.VOLUME_IGNITION &&
      Math.abs(
        m.priceMove30s
      ) <= 0.45
    ) {

      initialStage =
        'IGNITION';

    }

    signal =
      createSignal(
        instId,
        m,
        context,
        initialStage
      );

    if (!signal) {
      return;
    }

    STATE.signals.set(
      signal.id,
      signal
    );

    if (
      initialStage ===
      'WAIT'
    ) {

      signal.lastReason =
        'Erken kırılım; 5M + 1M teyidi bekleniyor';

      confirmLowerTimeframes(
        signal
      );

    }

    const prefix =
      initialStage === 'WAIT'
        ? '🔵 BEKLE'
        : initialStage === 'IGNITION'
          ? '🟠 HAREKET BAŞLADI'
          : '🟡 İZLE';

    console.log(
      prefix +
      ' | ' +
      signal.symbol +
      ' | ' +
      signal.direction +
      ' | ' +
      signal.score
    );

  } else {

    updateSignal(
      signal,
      m,
      context
    );

  }

  scheduleBroadcast();

}


/* =========================================================
   CLOSE / CLEANUP
========================================================= */

function closeSignal(
  signal,
  reason
) {

  STATE.signals.delete(
    signal.id
  );

  STATE.cooldowns.set(
    signal.instId +
    '|' +
    signal.direction,
    Date.now()
  );

  console.log(
    'FIRSAT KAPANDI | ' +
    signal.symbol +
    ' | ' +
    signal.status +
    ' | ' +
    reason
  );

  scheduleBroadcast();

}


function cleanup() {

  const now =
    Date.now();

  for (
    const [
      id,
      s
    ] of STATE.signals
  ) {

    s.ageSeconds =
      Math.floor(
        (
          now -
          s.signalAt
        ) / 1000
      );

    s.stageClass =
      stageClass(
        s.stage
      );

    /*
     * ENTRY WINDOW
     */

    if (
      s.stage === 'ENTRY' &&
      s.entryWindowEnds &&
      now >
        s.entryWindowEnds
    ) {

      setStage(
        s,
        'EXHAUSTION',
        'Giriş penceresi kapandı'
      );

    }

    /*
     * KAPANAN SİNYALLER
     */

    if (
      s.stage === 'TOO_LATE' ||
      s.stage === 'EXHAUSTION'
    ) {

      if (
        now -
          s.lastUpdate >
          12000
      ) {

        closeSignal(
          s,
          s.lastReason ||
            'Durum sona erdi'
        );

      }

    }

  }

  /*
   * COOLDOWN TEMİZLİĞİ
   */

  for (
    const [
      k,
      t
    ] of STATE.cooldowns
  ) {

    if (
      now - t >
      CFG.COOLDOWN_MS
    ) {

      STATE.cooldowns.delete(
        k
      );

    }

  }

}


/* =========================================================
   CONTEXT REFRESH
========================================================= */

async function refreshContexts() {

  if (
    STATE.scanning
  ) {

    return;

  }

  STATE.scanning =
    true;

  try {

    const candidates =
      STATE.liveUniverse.slice(
        0,
        CFG.CONTEXT_SYMBOLS
      );

    for (
      const row of candidates
    ) {

      const candles =
        await getCandles(
          row.symbol,
          '15m',
          CFG.M15_LIMIT
        );

      const c =
        buildContext(
          candles
        );

      if (c) {

        STATE.context.set(
          row.symbol,
          c
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

    STATE.scanning =
      false;

  }

}


/* =========================================================
   BITGET WS
========================================================= */

function makeWsGroups() {

  const syms =
    STATE.liveUniverse
      .slice(
        0,
        CFG.LIVE_SYMBOLS
      )
      .map(
        function(x) {
          return x.instId;
        }
      );

  const groups = [];

  for (
    let i = 0;
    i < syms.length;
    i +=
      CFG.WS_GROUP_SIZE
  ) {

    groups.push(
      syms.slice(
        i,
        i +
          CFG.WS_GROUP_SIZE
      )
    );

  }

  return groups;

}


function subArgs(
  symbols
) {

  const args = [];

  for (
    const instId of symbols
  ) {

    args.push({

      instType:
        'USDT-FUTURES',

      channel:
        'ticker',

      instId:
        instId

    });

    args.push({

      instType:
        'USDT-FUTURES',

      channel:
        'trade',

      instId:
        instId

    });

  }

  return args;

}


function closeWsConnections() {

  for (
    const x of STATE.ws
  ) {

    try {

      x.manualClose =
        true;

      x.ws.close();

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

    ws: ws,

    symbols:
      symbols,

    index:
      index,

    manualClose:
      false,

    lastPong:
      Date.now()

  };

  STATE.ws.push(
    holder
  );

  ws.on(
    'open',
    function() {

      holder.lastPong =
        Date.now();

      ws.send(
        JSON.stringify({

          op:
            'subscribe',

          args:
            subArgs(
              symbols
            )

        })
      );

      console.log(
        'WS'
        +
        (index + 1)
        +
        ' ABONELİK | '
        +
        symbols.length
        +
        ' coin | '
        +
        (
          symbols.length * 2
        )
        +
        ' kanal'
      );

      scheduleBroadcast();

    }
  );


  ws.on(
    'message',
    function(raw) {

      STATE.wsLastMessage =
        Date.now();

      holder.lastPong =
        Date.now();

      try {

        const text =
          raw.toString();

        if (
          text === 'pong'
        ) {

          return;

        }

        const msg =
          JSON.parse(
            text
          );

        if (
          msg.event ===
          'error'
        ) {

          STATE.lastError =
            'WS'
            +
            (index + 1)
            +
            ': '
            +
            (
              msg.msg ||
              'subscribe error'
            );

          return;

        }

        const arg =
          msg.arg || {};

        const channel =
          arg.channel;

        const instId =
          arg.instId;

        const data =
          Array.isArray(
            msg.data
          )
            ? msg.data
            : [];

        if (
          !instId ||
          !data.length
        ) {

          return;

        }

        if (
          channel ===
          'ticker'
        ) {

          addTicker(
            instId,
            data[0]
          );

        } else if (
          channel ===
          'trade'
        ) {

          for (
            const t of data
          ) {

            addTrade(
              instId,
              {

                price:
                  t.price,

                size:
                  t.size,

                side:
                  t.side

              }
            );

          }

        }

      } catch (e) {

        if (
          CFG.DEBUG
        ) {

          console.error(
            'WS parse:',
            e.message
          );

        }

      }

    }
  );


  ws.on(
    'error',
    function(e) {

      STATE.lastError =
        'WS'
        +
        (index + 1)
        +
        ': '
        +
        e.message;

      console.error(
        'BITGET WS'
        +
        (index + 1)
        +
        ' ERROR:',
        e.message
      );

    }
  );


  ws.on(
    'close',
    function() {

      holder.closedAt =
        Date.now();

      STATE.wsReconnects++;

      STATE.wsConnected =
        STATE.ws.some(
          function(x) {
            return (
              x.ws.readyState ===
              WebSocket.OPEN
            );
          }
        );

      scheduleBroadcast();

      if (
        !holder.manualClose
      ) {

        setTimeout(
          function() {

            rebuildWs();

          },
          Math.min(
            15000,
            2500 +
              STATE.wsReconnects *
              500
          )
        );

      }

    }
  );

}


let wsRebuildLock =
  false;


function rebuildWs() {

  if (
    wsRebuildLock
  ) {

    return;

  }

  wsRebuildLock =
    true;

  try {

    closeWsConnections();

    const groups =
      makeWsGroups();

    groups.forEach(
      function(g, i) {

        connectWsGroup(
          g,
          i
        );

      }
    );

  } finally {

    setTimeout(
      function() {

        wsRebuildLock =
          false;

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
      function(x) {
        return (
          x.ws.readyState ===
          WebSocket.OPEN
        );
      }
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


let lastWsSymbols =
  '';


function maybeRefreshWsSubscriptions() {

  const key =
    STATE.liveUniverse
      .map(
        function(x) {
          return x.instId;
        }
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
   WS HEARTBEAT
========================================================= */

setInterval(
  function() {

    for (
      const h of STATE.ws
    ) {

      if (
        h.ws.readyState ===
        WebSocket.OPEN
      ) {

        try {

          h.ws.send(
            'ping'
          );

        } catch (_) {}

      }

    }

    wsHealth();

  },
  CFG.WS_PING_MS
);


/* =========================================================
   SIGNAL SORT
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
    function(a, b) {

      return (
        order[b.stage] -
        order[a.stage]
      )
      ||
      (
        b.score -
        a.score
      );

    }
  );

}


/* =========================================================
   STATUS
========================================================= */

function status() {

  cleanup();

  const signals =
    getSignals();

  STATE.stats.watching =
    signals.filter(
      function(s) {
        return (
          s.stage ===
          'WATCH'
        );
      }
    ).length;

  STATE.stats.ignition =
    signals.filter(
      function(s) {
        return (
          s.stage ===
          'IGNITION'
        );
      }
    ).length;

  STATE.stats.wait =
    signals.filter(
      function(s) {
        return (
          s.stage ===
          'WAIT'
        );
      }
    ).length;

  STATE.stats.entries =
    signals.filter(
      function(s) {
        return (
          s.stage ===
          'ENTRY'
        );
      }
    ).length;

  STATE.stats.exhaustion =
    signals.filter(
      function(s) {
        return (
          s.stage ===
          'EXHAUSTION' ||
          s.stage ===
          'TOO_LATE'
        );
      }
    ).length;

  return {

    ok:
      true,

    now:
      Date.now(),

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
          function(x) {
            return (
              x.ws.readyState ===
              WebSocket.OPEN
            );
          }
        ).length

    },

    market:
      STATE.market,

    stats: {

      ...STATE.stats,

      signals:
        signals.length

    },

    signals:
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

  if (
    broadcastTimer
  ) {

    return;

  }

  broadcastTimer =
    setTimeout(
      function() {

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
          const c of wss.clients
        ) {

          if (
            c.readyState ===
            WebSocket.OPEN
          ) {

            try {

              c.send(
                payload
              );

            } catch (_) {}

          }

        }

      },
      CFG.BROADCAST_MS
    );

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

  const incoming =
    req.headers[
      'x-api-token'
    ] ||
    req.query.token;

  if (
    incoming !==
    token
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
  function(req, res) {

    res.json(
      status()
    );

  }
);


app.get(
  '/api/health',
  function(req, res) {

    res.json({

      status:
        'ok',

      uptime:
        process.uptime(),

      ws:
        STATE.wsConnected,

      lastError:
        STATE.lastError,

      connections:
        STATE.ws.length

    });

  }
);


app.get(
  '/api/scan',
  apiAuth,
  async function(req, res) {

    try {

      await discoverUniverse();

      maybeRefreshWsSubscriptions();

      await refreshContexts();

      scheduleBroadcast();

      res.json({

        success:
          true,

        data:
          status()

      });

    } catch (e) {

      res
        .status(500)
        .json({

          success:
            false,

          error:
            e.message

        });

    }

  }
);


/* =========================================================
   CHART API
========================================================= */

app.get(
  '/api/chart',
  apiAuth,
  async function(req, res) {

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

          success:
            false,

          error:
            'Market bulunamadı'

        });

      }

      let limit =
        160;

      if (
        timeframe ===
        '1m'
      ) {

        limit =
          180;

      } else if (
        timeframe ===
        '5m'
      ) {

        limit =
          180;

      }

      const candles =
        await getCandles(
          symbol,
          timeframe,
          limit
        );

      const signal =
        getSignals().find(
          function(s) {
            return (
              s.marketSymbol ===
              symbol
            );
          }
        ) ||
        null;

      res.json({

        success:
          true,

        symbol:
          symbol,

        timeframe:
          timeframe,

        candles:
          candles,

        signal:
          signal

      });

    } catch (e) {

      res
        .status(500)
        .json({

          success:
            false,

          error:
            e.message

        });

    }

  }
);


/* =========================================================
   NO HISTORY
========================================================= */

app.get(
  '/api/history',
  apiAuth,
  function(req, res) {

    res.json({

      success:
        true,

      history:
        []

    });

  }
);


/* =========================================================
   UI WS
========================================================= */

wss.on(
  'connection',
  function(ws) {

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

const HTML =
`<!DOCTYPE html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>SONNY AI TRADER</title>

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
  border:1px solid var(--line);
  border-left:4px solid var(--yellow);
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
  border:1px solid var(--line);
  border-radius:10px;
  overflow:hidden;
}

.chartHead{
  height:42px;
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding:0 11px;
  border-bottom:1px solid var(--line);
}

.tf button{
  background:#111b27;
  color:var(--muted);
  border:1px solid var(--line);
  border-radius:5px;
  padding:5px 8px;
  font-size:9px;
}

.tf button.active{
  color:var(--green);
  border-color:var(--green);
}

canvas{
  width:100%;
  height:
    calc(100% - 42px);
  display:block;
}

.box{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:9px;
  padding:12px;
  margin-bottom:10px;
}

.boxTitle{
  font-size:9px;
  font-weight:800;
  color:var(--muted);
  margin-bottom:8px;
}

.regime{
  font-size:16px;
  font-weight:900;
}

.regime.long{
  color:var(--green);
}

.regime.short{
  color:var(--red);
}

.marketGrid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px;
  margin-top:9px;
}

.stat{
  background:#0a1119;
  border:1px solid #182534;
  border-radius:6px;
  padding:7px;
}

.stat span{
  display:block;
  color:var(--muted);
  font-size:8px;
}

.stat b{
  font-size:11px;
}

.big{
  font-size:19px;
  font-weight:900;
  margin-bottom:4px;
}

.big.entry{
  color:var(--green);
}

.big.ignition{
  color:var(--orange);
}

.big.wait{
  color:var(--blue);
}

.big.watch{
  color:var(--yellow);
}

.big.bad{
  color:var(--red);
}

.signalTime{
  color:var(--muted);
  font-size:9px;
  line-height:1.7;
}

.score{
  height:7px;
  background:#1a2633;
  border-radius:8px;
  overflow:hidden;
  margin:9px 0;
}

.score i{
  display:block;
  height:100%;
  background:var(--green);
}

.levels{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px;
  margin-top:9px;
}

.level{
  background:#0a1119;
  border:1px solid #182534;
  border-radius:6px;
  padding:7px;
}

.level span{
  display:block;
  font-size:8px;
  color:var(--muted);
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

.metric{
  display:flex;
  justify-content:space-between;
  border-bottom:1px solid #17222e;
  padding:7px 0;
  font-size:9px;
}

.metric span{
  color:var(--muted);
}

.metric b{
  color:#e6edf5;
}

.empty{
  text-align:center;
  color:#617086;
  padding:14px 5px;
  font-size:10px;
}

.notice{
  background:#0a1119;
  border:1px solid #1a2938;
  border-radius:7px;
  padding:9px;
  color:#a9b6c6;
  font-size:9px;
  line-height:1.6;
}

.notice strong{
  color:#fff;
}

.legend{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  font-size:8px;
  color:var(--muted);
}

.legend span{
  display:flex;
  align-items:center;
  gap:4px;
}

.legend i{
  width:7px;
  height:7px;
  border-radius:50%;
}

.green{
  background:var(--green);
}

.yellow{
  background:var(--yellow);
}

.orange{
  background:var(--orange);
}

.blue{
  background:var(--blue);
}

.red{
  background:var(--red);
}

@media(max-width:1150px){

  .app{
    grid-template-columns:
      270px
      minmax(0,1fr);
  }

  .right{
    display:none;
  }

}

@media(max-width:720px){

  .app{
    grid-template-columns:1fr;
  }

  .left{
    display:none;
  }

  .main{
    padding:6px;
  }

  .chart{
    min-height:500px;
  }

}

</style>

</head>

<body>

<div class="app">

<aside class="left">

<div class="brand">
⚡ SONNY AI TRADER
</div>

<div class="sub">
MOMENTUM SCALPER • 15M / CANLI FLOW
</div>

<div class="livebar">

<i
  id="pulse"
  class="pulse"
></i>

<span id="connText">
CANLI BAĞLANTI
</span>

</div>


<div class="section">

<div class="sectionHead">

<span>
🟢 GİRİŞ FIRSATLARI
</span>

<b
  id="entryCount"
  class="count"
>
0
</b>

</div>

<div id="entries">

<div class="empty">
Giriş bekleniyor
</div>

</div>

</div>


<div class="section">

<div class="sectionHead">

<span>
🔵 BEKLE
</span>

<b
  id="waitCount"
  class="count"
>
0
</b>

</div>

<div id="wait">

<div class="empty">
Bekleyen kurulum yok
</div>

</div>

</div>


<div class="section">

<div class="sectionHead">

<span>
🟠 HAREKET BAŞLADI
</span>

<b
  id="ignitionCount"
  class="count"
>
0
</b>

</div>

<div id="ignitions">

<div class="empty">
Hareket yok
</div>

</div>

</div>


<div class="section">

<div class="sectionHead">

<span>
🟡 İZLE
</span>

<b
  id="watchCount"
  class="count"
>
0
</b>

</div>

<div id="watch">

<div class="empty">
İzlenecek coin yok
</div>

</div>

</div>


<div class="legend">

<span>
<i class="yellow"></i>
İZLE
</span>

<span>
<i class="orange"></i>
HAREKET
</span>

<span>
<i class="blue"></i>
BEKLE
</span>

<span>
<i class="green"></i>
GİRİŞ
</span>

<span>
<i class="red"></i>
ZAYIF
</span>

</div>

</aside>


<main class="main">

<div class="top">

<div
  class="title"
  id="selectedTitle"
>
BTCUSDT
</div>

<div
  class="conn"
  id="connection"
>
● BAĞLANIYOR
</div>

</div>


<div class="chart">

<div class="chartHead">

<b id="chartTitle">
BTCUSDT • 15M
</b>

<div class="tf">

<button
  class="active"
  data-tf="15m"
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

<canvas
  id="chart"
></canvas>

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

<div class="marketGrid">

<div class="stat">

<span>
Genişlik
</span>

<b id="breadth">
-
</b>

</div>

<div class="stat">

<span>
Ortalama
</span>

<b id="average">
-
</b>

</div>

<div class="stat">

<span>
Yükselen
</span>

<b id="green">
-
</b>

</div>

<div class="stat">

<span>
Düşen
</span>

<b id="red">
-
</b>

</div>

</div>

<div
  class="mini"
  id="btceth"
>
BTC: - • ETH: -
</div>

</div>


<div class="box">

<div class="boxTitle">
CANLI FIRSAT
</div>

<div id="signalDetail">

<div class="empty">
Bir fırsat seçin
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

<strong>
İZLE
</strong>
= erken radar.

<br>

<strong>
HAREKET BAŞLADI
</strong>
= momentum hızlanıyor.

<br>

<strong>
BEKLE
</strong>
= kırılım var; manuel giriş için 5M + 1M teyidi bekleniyor.

<br>

<strong>
GİRİŞ
</strong>
= teyit tamamlandı ve giriş penceresi açık.

<br>

<strong>
ZAYIFLAMA
</strong>
= momentum bozuldu; yeni giriş kovalanmaz.

<br>

<strong>
GEÇ KALINDI
</strong>
= hareket fazla uzadı; fiyat kovalanmaz.

</div>

</div>

</aside>

</div>


<script>

(function(){

let selected =
  'BTC/USDT:USDT';

let timeframe =
  '15m';

let signals =
  [];

let candles =
  [];

let lastChartKey =
  '';


function $(id){

  return document.getElementById(
    id
  );

}


function esc(v){

  return String(
    v == null
      ? ''
      : v
  )
  .replace(
    /[&<>"']/g,
    function(c){

      return {

        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#39;'

      }[c];

    }
  );

}


function p(v){

  const n =
    Number(v);

  if (
    !Number.isFinite(n)
  ) {

    return '-';

  }

  if (
    n >= 1000
  ) {

    return n.toFixed(2);

  }

  if (
    n >= 100
  ) {

    return n.toFixed(3);

  }

  if (
    n >= 1
  ) {

    return n.toFixed(5);

  }

  if (
    n >= 0.01
  ) {

    return n.toFixed(7);

  }

  if (
    n >= 0.0001
  ) {

    return n.toFixed(8);

  }

  return n.toFixed(10);

}


function age(s){

  s =
    Number(s || 0);

  if (
    s < 60
  ) {

    return s + ' sn';

  }

  return (
    Math.floor(
      s / 60
    )
    +
    ' dk '
    +
    String(
      s % 60
    ).padStart(
      2,
      '0'
    )
    +
    ' sn'
  );

}


function stageAge(t){

  if (!t) {

    return '0 sn';

  }

  return age(
    Math.floor(
      (
        Date.now() -
        Number(t)
      ) / 1000
    )
  );

}


function remain(ms){

  if (
    ms <= 0
  ) {

    return '0 sn';

  }

  return age(
    Math.floor(
      ms / 1000
    )
  );

}


/* =========================================================
   CARD
========================================================= */

function card(s){

  let cls =
    'watch';

  if (
    s.stage ===
    'ENTRY'
  ) {

    cls =
      'entry';

  } else if (
    s.stage ===
    'WAIT'
  ) {

    cls =
      'wait';

  } else if (
    s.stage ===
    'IGNITION'
  ) {

    cls =
      'ignition';

  } else if (
    s.stage ===
      'EXHAUSTION' ||
    s.stage ===
      'TOO_LATE'
  ) {

    cls =
      'bad';

  }

  const coin =
    String(
      s.symbol || ''
    )
    .replace(
      '/USDT:USDT',
      ''
    )
    .replace(
      '/USDT',
      ''
    );

  let html =
    '';

  html +=
    '<div class="card '
    +
    String(
      s.direction || ''
    ).toLowerCase()
    +
    ' '
    +
    cls
    +
    '" data-symbol="'
    +
    esc(
      s.marketSymbol
    )
    +
    '">';

  html +=
    '<div class="row">';

  html +=
    '<b class="coin">'
    +
    esc(coin)
    +
    '</b>';

  html +=
    '<span class="dir '
    +
    String(
      s.direction || ''
    ).toLowerCase()
    +
    '">'
    +
    esc(
      s.direction
    )
    +
    '</span>';

  html +=
    '</div>';

  html +=
    '<div class="stage '
    +
    cls
    +
    '">'
    +
    esc(
      s.status
    )
    +
    '</div>';

  html +=
    '<div class="price">'
    +
    p(
      s.currentPrice
    )
    +
    '</div>';

  html +=
    '<div class="mini">';

  html +=
    'Momentum '
    +
    esc(
      s.score
    )
    +
    '/100 • Hacim '
    +
    esc(
      s.volumeRatio
    )
    +
    'x';

  html +=
    '<br>';

  html +=
    'Akış '
    +
    esc(
      s.flow
    )
    +
    '% • OI '
    +
    esc(
      s.oiChange
    )
    +
    '%';

  html +=
    '</div>';

  html +=
    '<div class="timer">';

  html +=
    'Sinyal: '
    +
    new Date(
      s.signalAt
    ).toLocaleTimeString(
      'tr-TR'
    );

  html +=
    '<br>';

  html +=
    'Aşama: '
    +
    stageAge(
      s.stageAt
    );

  html +=
    '</div>';

  if (
    s.stage ===
      'ENTRY' &&
    s.entryWindowEnds
  ) {

    html +=
      '<div class="timer">';

    html +=
      '⏱ Giriş penceresi: '
      +
      remain(
        s.entryWindowEnds -
        Date.now()
      );

    html +=
      '</div>';

  }

  html +=
    '</div>';

  return html;

}


/* =========================================================
   METRIC
========================================================= */

function metric(
  a,
  b
){

  return (
    '<div class="metric">'
    +
    '<span>'
    +
    esc(a)
    +
    '</span>'
    +
    '<b>'
    +
    esc(b)
    +
    '</b>'
    +
    '</div>'
  );

}


/* =========================================================
   RENDER
========================================================= */

function render(d){

  signals =
    d.signals || [];

  const m =
    d.market || {};

  function set(
    id,
    v
  ){

    $(id).textContent =
      v;

  }


  set(
    'regime',
    m.label ||
      'YATAY / KARIŞIK'
  );

  $('regime').className =
    'regime '
    +
    (
      m.direction ===
      'LONG'
        ? 'long'
        : m.direction ===
          'SHORT'
            ? 'short'
            : ''
    );


  set(
    'breadth',
    '%'
    +
    (
      m.breadth ??
      '-'
    )
  );

  set(
    'average',
    (
      m.average ??
      '-'
    )
    +
    '%'
  );

  set(
    'green',
    m.green ??
      '-'
  );

  set(
    'red',
    m.red ??
      '-'
  );

  set(
    'btceth',
    'BTC: '
    +
    (
      m.btc ||
      '-'
    )
    +
    ' • ETH: '
    +
    (
      m.eth ||
      '-'
    )
  );


  const entries =
    signals.filter(
      function(s){
        return (
          s.stage ===
          'ENTRY'
        );
      }
    );

  const wait =
    signals.filter(
      function(s){
        return (
          s.stage ===
          'WAIT'
        );
      }
    );

  const ign =
    signals.filter(
      function(s){
        return (
          s.stage ===
          'IGNITION'
        );
      }
    );

  const watch =
    signals.filter(
      function(s){
        return (
          s.stage ===
          'WATCH'
        );
      }
    );


  set(
    'entryCount',
    entries.length
  );

  set(
    'waitCount',
    wait.length
  );

  set(
    'ignitionCount',
    ign.length
  );

  set(
    'watchCount',
    watch.length
  );


  $('entries').innerHTML =
    entries.length
      ? entries
          .map(card)
          .join('')
      : '<div class="empty">Giriş bekleniyor</div>';

  $('wait').innerHTML =
    wait.length
      ? wait
          .map(card)
          .join('')
      : '<div class="empty">Bekleyen kurulum yok</div>';

  $('ignitions').innerHTML =
    ign.length
      ? ign
          .map(card)
          .join('')
      : '<div class="empty">Hareket yok</div>';

  $('watch').innerHTML =
    watch.length
      ? watch
          .map(card)
          .join('')
      : '<div class="empty">İzlenecek coin yok</div>';


  const connected =
    !!(
      d.ws &&
      d.ws.connected
    );


  $('pulse').className =
    'pulse'
    +
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


  let sys =
    '';

  sys +=
    'Radar: '
    +
    (
      d.stats &&
      d.stats.universe
        ? d.stats.universe
        : 0
    )
    +
    ' • Canlı: '
    +
    (
      d.stats &&
      d.stats.live
        ? d.stats.live
        : 0
    )
    +
    '<br>';

  sys +=
    'İzle: '
    +
    (
      d.stats &&
      d.stats.watching
        ? d.stats.watching
        : 0
    )
    +
    ' • Hareket: '
    +
    (
      d.stats &&
      d.stats.ignition
        ? d.stats.ignition
        : 0
    )
    +
    '<br>';

  sys +=
    'Bekle: '
    +
    (
      d.stats &&
      d.stats.wait
        ? d.stats.wait
        : 0
    )
    +
    ' • Giriş: '
    +
    (
      d.stats &&
      d.stats.entries
        ? d.stats.entries
        : 0
    )
    +
    '<br>';

  sys +=
    'WS: '
    +
    (
      d.ws &&
      d.ws.open
        ? d.ws.open
        : 0
    )
    +
    ' bağlantı • Yeniden bağlanma: '
    +
    (
      d.ws &&
      d.ws.reconnects
        ? d.ws.reconnects
        : 0
    );


  $('systemInfo').innerHTML =
    sys;


  const chosen =
    signals.find(
      function(s){
        return (
          s.marketSymbol ===
          selected
        );
      }
    )
    ||
    entries[0]
    ||
    wait[0]
    ||
    ign[0]
    ||
    watch[0];


  if (
    chosen
  ) {

    selected =
      chosen.marketSymbol;

    show(
      chosen
    );

    const key =
      selected
      +
      '|'
      +
      timeframe;

    if (
      lastChartKey !==
      key
    ) {

      lastChartKey =
        key;

      loadChart();

    }

  } else {

    $('signalDetail').innerHTML =
      '<div class="empty">Şu anda aktif fırsat yok</div>';

  }


  bind();

}


/* =========================================================
   SHOW DETAIL
========================================================= */

function show(s){

  let cls =
    'watch';

  if (
    s.stage ===
    'ENTRY'
  ) {

    cls =
      'entry';

  } else if (
    s.stage ===
    'WAIT'
  ) {

    cls =
      'wait';

  } else if (
    s.stage ===
    'IGNITION'
  ) {

    cls =
      'ignition';

  } else if (
    s.stage ===
      'EXHAUSTION' ||
    s.stage ===
      'TOO_LATE'
  ) {

    cls =
      'bad';

  }


  $('selectedTitle').textContent =
    s.symbol;

  $('chartTitle').textContent =
    s.symbol
    +
    ' • '
    +
    timeframe.toUpperCase();


  let html =
    '';


  html +=
    '<div class="big '
    +
    cls
    +
    '">'
    +
    esc(
      s.status
    )
    +
    '</div>';


  html +=
    '<div class="signalTime">';

  html +=
    esc(
      s.symbol
    )
    +
    ' • '
    +
    esc(
      s.direction
    )
    +
    '<br>';

  html +=
    'Sinyal: '
    +
    new Date(
      s.signalAt
    ).toLocaleTimeString(
      'tr-TR'
    )
    +
    ' • Yaş: '
    +
    age(
      s.ageSeconds
    )
    +
    '<br>';

  html +=
    'Aşama yaşı: '
    +
    stageAge(
      s.stageAt
    );

  html +=
    '</div>';


  if (
    s.stage ===
      'ENTRY' &&
    s.entryWindowEnds
  ) {

    html +=
      '<div class="signalTime">';

    html +=
      '⏱ Giriş penceresi: <b>'
      +
      remain(
        s.entryWindowEnds -
        Date.now()
      )
      +
      '</b>';

    html +=
      '</div>';

  }


  html +=
    '<div class="score">';

  html +=
    '<i style="width:'
    +
    Math.min(
      100,
      Number(
        s.score
      ) || 0
    )
    +
    '%"></i>';

  html +=
    '</div>';


  html +=
    '<div class="mini">';

  html +=
    'Momentum '
    +
    s.score
    +
    '/100';

  html +=
    '</div>';


  html +=
    '<div class="levels">';


  html +=
    '<div class="level entry">';

  html +=
    '<span>GİRİŞ</span>';

  html +=
    '<b>'
    +
    p(s.entryLow)
    +
    ' - '
    +
    p(s.entryHigh)
    +
    '</b>';

  html +=
    '</div>';


  html +=
    '<div class="level stop">';

  html +=
    '<span>STOP</span>';

  html +=
    '<b>'
    +
    p(s.stop)
    +
    '</b>';

  html +=
    '</div>';


  html +=
    '<div class="level tp">';

  html +=
    '<span>HEDEF 1</span>';

  html +=
    '<b>'
    +
    p(s.tp1)
    +
    '</b>';

  html +=
    '</div>';


  html +=
    '<div class="level tp">';

  html +=
    '<span>HEDEF 2</span>';

  html +=
    '<b>'
    +
    p(s.tp2)
    +
    '</b>';

  html +=
    '</div>';


  html +=
    '</div>';


  html +=
    '<div style="margin-top:8px">';


  html +=
    metric(
      'Fiyat 10 sn',
      s.priceMove10s
      +
      '%'
    );

  html +=
    metric(
      'Fiyat 30 sn',
      s.priceMove30s
      +
      '%'
    );

  html +=
    metric(
      'İşlem akışı',
      s.flow
      +
      '%'
    );

  html +=
    metric(
      'Hacim',
      s.volumeRatio
      +
      'x'
    );

  html +=
    metric(
      'OI',
      s.oiChange
      +
      '%'
    );

  html +=
    metric(
      'Spread',
      s.spread
      +
      '%'
    );

  html +=
    metric(
      '15M yön',
      s.contextDirection
    );

  html +=
    metric(
      'Kırılım',
      s.breakout
        ? 'EVET'
        : 'HAYIR'
    );

  html +=
    metric(
      '5M teyit',
      s.tf5Confirm
        ? 'EVET'
        : 'BEKLİYOR'
    );

  html +=
    metric(
      '1M teyit',
      s.tf1Confirm
        ? 'EVET'
        : 'BEKLİYOR'
    );

  html +=
    metric(
      'Neden',
      s.reason
    );

  html +=
    '</div>';


  $('signalDetail').innerHTML =
    html;

}


/* =========================================================
   CARD BIND
========================================================= */

function bind(){

  document
    .querySelectorAll(
      '.card'
    )
    .forEach(
      function(el){

        el.onclick =
          function(){

            selected =
              el.dataset.symbol;

            const s =
              signals.find(
                function(x){
                  return (
                    x.marketSymbol ===
                    selected
                  );
                }
              );

            if (s) {

              show(s);

              lastChartKey =
                '';

              loadChart();

            }

          };

      }
    );

}


/* =========================================================
   CHART NORMALIZE
========================================================= */

function normalize(a){

  return (
    a || []
  )
  .map(
    function(x){

      if (
        Array.isArray(x)
      ) {

        return {

          time:
            +x[0],

          open:
            +x[1],

          high:
            +x[2],

          low:
            +x[3],

          close:
            +x[4]

        };

      }

      return x;

    }
  )
  .filter(
    function(x){

      return Number.isFinite(
        x.time
      );

    }
  );

}


/* =========================================================
   CHART LOAD
========================================================= */

async function loadChart(){

  try {

    const r =
      await fetch(
        '/api/chart?symbol='
        +
        encodeURIComponent(
          selected
        )
        +
        '&timeframe='
        +
        encodeURIComponent(
          timeframe
        ),
        {
          cache:
            'no-store'
        }
      );

    const d =
      await r.json();

    if (
      d.success
    ) {

      candles =
        normalize(
          d.candles
        );

      draw();

    }

  } catch (e) {

    draw();

  }

}


/* =========================================================
   CHART DRAW
========================================================= */

function draw(){

  const c =
    $('chart');

  const r =
    c.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio ||
    1;

  const w =
    Math.max(
      300,
      Math.floor(
        r.width
      )
    );

  const h =
    Math.max(
      300,
      Math.floor(
        r.height
      )
    );

  c.width =
    w * dpr;

  c.height =
    h * dpr;

  const x =
    c.getContext(
      '2d'
    );

  x.setTransform(
    dpr,
    0,
    0,
    dpr,
    0,
    0
  );

  x.fillStyle =
    '#070b10';

  x.fillRect(
    0,
    0,
    w,
    h
  );


  if (
    !candles.length
  ) {

    x.fillStyle =
      '#738296';

    x.font =
      '12px Arial';

    x.fillText(
      'Grafik verisi bekleniyor...',
      16,
      25
    );

    return;

  }


  const v =
    candles.slice(
      -100
    );


  let min =
    Math.min.apply(
      null,
      v.map(
        function(z){
          return z.low;
        }
      )
    );

  let max =
    Math.max.apply(
      null,
      v.map(
        function(z){
          return z.high;
        }
      )
    );


  const s =
    signals.find(
      function(z){
        return (
          z.marketSymbol ===
          selected
        );
      }
    );


  if (s) {

    const levels = [

      s.entry,

      s.stop,

      s.tp1,

      s.tp2

    ];

    levels.forEach(
      function(q){

        if (
          Number.isFinite(
            Number(q)
          )
        ) {

          min =
            Math.min(
              min,
              Number(q)
            );

          max =
            Math.max(
              max,
              Number(q)
            );

        }

      }
    );

  }


  const pad =
    (
      max - min
    ) * 0.08 ||
    1;

  min -=
    pad;

  max +=
    pad;


  const L =
    48;

  const R =
    72;

  const T =
    12;

  const B =
    12;

  const PW =
    w - L - R;

  const PH =
    h - T - B;


  const Y =
    function(q){

      return (
        T
        +
        (
          max - q
        )
        /
        (
          max - min
        )
        *
        PH
      );

    };


  const X =
    function(i){

      return (
        L
        +
        i *
        PW
        /
        Math.max(
          1,
          v.length - 1
        )
      );

    };


  x.strokeStyle =
    '#172331';


  for (
    let i = 0;
    i <= 5;
    i++
  ) {

    const y =
      T +
      PH *
      i /
      5;

    x.beginPath();

    x.moveTo(
      L,
      y
    );

    x.lineTo(
      w - R,
      y
    );

    x.stroke();

  }


  const step =
    PW /
    Math.max(
      1,
      v.length - 1
    );

  const bw =
    Math.max(
      2,
      Math.min(
        9,
        step * 0.62
      )
    );


  v.forEach(
    function(z, i){

      const xx =
        X(i);

      const up =
        z.close >=
        z.open;

      const col =
        up
          ? '#16e0a1'
          : '#ff4f70';

      x.strokeStyle =
        col;

      x.fillStyle =
        col;


      x.beginPath();

      x.moveTo(
        xx,
        Y(z.high)
      );

      x.lineTo(
        xx,
        Y(z.low)
      );

      x.stroke();


      const oy =
        Y(z.open);

      const cy =
        Y(z.close);

      x.fillRect(
        xx - bw / 2,
        Math.min(
          oy,
          cy
        ),
        bw,
        Math.max(
          1,
          Math.abs(
            cy - oy
          )
        )
      );

    }
  );


  if (s) {

    line(
      s.entry,
      '#16e0a1',
      'GİRİŞ'
    );

    line(
      s.stop,
      '#ff4f70',
      'STOP'
    );

    line(
      s.tp1,
      '#55a8ff',
      'HEDEF 1'
    );

    line(
      s.tp2,
      '#55a8ff',
      'HEDEF 2'
    );

  }


  function line(
    q,
    col,
    label
  ){

    if (
      !Number.isFinite(
        Number(q)
      )
    ) {

      return;

    }

    const y =
      Y(
        Number(q)
      );

    x.strokeStyle =
      col;

    x.setLineDash([
      5,
      5
    ]);

    x.beginPath();

    x.moveTo(
      L,
      y
    );

    x.lineTo(
      w - R,
      y
    );

    x.stroke();

    x.setLineDash([]);

    x.fillStyle =
      col;

    x.font =
      'bold 9px Arial';

    x.fillText(
      label
      +
      ' '
      +
      p(q),
      w - R + 4,
      y + 3
    );

  }

}


/* =========================================================
   CLOCK
========================================================= */

setInterval(
  function(){

    signals.forEach(
      function(s){

        s.ageSeconds =
          Math.floor(
            (
              Date.now() -
              s.signalAt
            ) / 1000
          );

      }
    );

    const s =
      signals.find(
        function(x){
          return (
            x.marketSymbol ===
            selected
          );
        }
      );

    if (s) {

      show(s);

    }

  },
  1000
);


/* =========================================================
   TIMEFRAME BUTTONS
========================================================= */

document
  .querySelectorAll(
    '[data-tf]'
  )
  .forEach(
    function(b){

      b.onclick =
        function(){

          document
            .querySelectorAll(
              '[data-tf]'
            )
            .forEach(
              function(x){

                x.classList.remove(
                  'active'
                );

              }
            );

          b.classList.add(
            'active'
          );

          timeframe =
            b.dataset.tf;

          lastChartKey =
            '';

          loadChart();

        };

    }
  );


/* =========================================================
   UI WS
========================================================= */

function connect(){

  const proto =
    location.protocol ===
    'https:'
      ? 'wss://'
      : 'ws://';

  const ws =
    new WebSocket(
      proto +
      location.host
    );


  ws.onmessage =
    function(e){

      try {

        const m =
          JSON.parse(
            e.data
          );

        if (
          m.type ===
          'snapshot'
        ) {

          render(
            m.data
          );

        }

      } catch (_) {}

    };


  ws.onclose =
    function(){

      setTimeout(
        connect,
        1500
      );

    };

}


connect();

loadChart();

window.addEventListener(
  'resize',
  draw
);

})();

</script>

</body>

</html>`;


/* =========================================================
   ROUTES
========================================================= */

app.get(
  '/',
  function(req, res){

    res
      .type('html')
      .send(
        HTML
      );

  }
);


/* =========================================================
   ERRORS
========================================================= */

process.on(
  'unhandledRejection',
  function(e){

    STATE.lastError =
      e &&
      e.message
        ? e.message
        : String(e);

    console.error(
      'UNHANDLED:',
      e
    );

  }
);


process.on(
  'uncaughtException',
  function(e){

    STATE.lastError =
      e &&
      e.message
        ? e.message
        : String(e);

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
  async function(){

    console.log(
      '=============================================='
    );

    console.log(
      '🚀 SONNY AI TRADER — RED TEAM V4'
    );

    console.log(
      '🔥 MOMENTUM SCALPER'
    );

    console.log(
      '🟡 İZLE → 🟠 HAREKET BAŞLADI → 🔵 BEKLE → 🟢 GİRİŞ → 🔴 ZAYIFLAMA'
    );

    console.log(
      '🤖 AUTO TRADE: KAPALI'
    );

    console.log(
      '🚫 GEÇ KALINMIŞ HAREKET KOVALANMIYOR'
    );

    console.log(
      '=============================================='
    );


    try {

      await loadMarketsRetry();

      await discoverUniverse();

      await refreshContexts();

      startWs();


      lastWsSymbols =
        STATE.liveUniverse
          .map(
            function(x) {
              return x.instId;
            }
          )
          .join(',');


      /*
       * RADAR
       */

      setInterval(
        async function(){

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
        async function(){

          await refreshContexts();

        },
        CFG.CONTEXT_MS
      );


      /*
       * CLEANUP + BROADCAST
       */

      setInterval(
        function(){

          cleanup();

          scheduleBroadcast();

        },
        1000
      );


      /*
       * WS HEALTH
       */

      setInterval(
        function(){

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
