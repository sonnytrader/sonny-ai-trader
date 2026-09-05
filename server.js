'use strict';

/*
=============================================================
 SONNY AI TRADER — RED TEAM V4
 MOMENTUM SCALPER / MANUEL GİRİŞ

 15M BAĞLAM
      ↓
 5M YAPI
      ↓
 1M TETİK
      ↓
 CANLI FİYAT + TRADE FLOW + OI
      ↓
 🟡 İZLE
 🟠 HAREKET BAŞLADI
 🔵 BEKLE
 🟢 GİRİŞ FIRSATI
 🔴 MOMENTUM ZAYIFLIYOR
      ↓
 ⚫ GEÇ KALINDI

 AUTO TRADE: KAPALI

 RED TEAM V4:
 - Ters yön sinyali tutulmaz.
 - Canlı momentum eski 15M yönünü ezebilir.
 - ENTRY geç kalma filtresi sıkılaştırıldı.
 - 5M + 1M teyidi taze olmalı.
 - 1M / 5M REST cache çok kısa.
 - Hacim burst'u son trade geçmişine göre hesaplanıyor.
 - WS yalnız ticker + trade.
 - 15 coin / WS bağlantısı.
 - Subscribe spam yok.
 - Chart REST her saniye çağrılmaz.
 - Geçmiş sinyal UI'ya verilmez.
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

  /* RADAR */
  RADAR: 500,

  /* CANLI WS */
  LIVE_SYMBOLS: 45,
  CONTEXT_SYMBOLS: 45,

  /* Minimum 24h USDT hacmi */
  MIN_VOLUME_USDT:
    Number(process.env.MIN_VOLUME_USDT || 1000000),

  /* Discovery */
  DISCOVERY_MS:
    120 * 1000,

  /* 15M context */
  CONTEXT_MS:
    60 * 1000,

  M15_CACHE_MS:
    55 * 1000,

  /* WAIT teyit cache */
  M5_CACHE_MS:
    12 * 1000,

  M1_CACHE_MS:
    6 * 1000,

  /* Sinyal kapasitesi */
  MAX_SIGNALS:
    8,

  MAX_ENTRY_SIGNALS:
    3,

  /* Aynı coin tekrar tekrar sinyal üretmesin */
  COOLDOWN_MS:
    20 * 60 * 1000,

  /* State süreleri */
  WATCH_TTL_MS:
    3 * 60 * 1000,

  WAIT_TTL_MS:
    90 * 1000,

  ENTRY_TTL_MS:
    45 * 1000,

  /* Skor eşikleri */
  WATCH_SCORE:
    55,

  IGNITION_SCORE:
    66,

  WAIT_SCORE:
    75,

  ENTRY_SCORE:
    84,

  /* Hacim */
  VOL_WATCH:
    1.15,

  VOL_IGNITION:
    1.45,

  VOL_ENTRY:
    1.80,

  /* Trade flow */
  FLOW_IGNITION:
    0.58,

  FLOW_ENTRY:
    0.64,

  /* Fiyat hareketi */
  MOVE_10S:
    0.04,

  MOVE_15S:
    0.08,

  MOVE_30S:
    0.16,

  /* Spread */
  MAX_SPREAD_PCT:
    0.10,

  /* ENTRY FOMO filtresi */
  MAX_ENTRY_EXTENSION_ATR:
    0.85,

  MAX_ENTRY_MOVE_10S:
    0.18,

  MAX_ENTRY_MOVE_30S:
    0.55,

  /* OI */
  OI_CONFIRM:
    0.06,

  OI_STRONG:
    0.18,

  /* Exhaustion */
  EXHAUST_FLOW_DROP:
    0.10,

  EXHAUST_STALL_15S:
    0.025,

  EXHAUST_VOL_DROP:
    0.30,

  /* 15M indikatör */
  EMA:
    21,

  ATR:
    10,

  BREAKOUT_LOOKBACK:
    12,

  M15_LIMIT:
    160,

  M5_LIMIT:
    50,

  M1_LIMIT:
    40,

  /* Bitget */
  WS_URL:
    'wss://ws.bitget.com/v2/ws/public',

  WS_GROUP_SIZE:
    15,

  WS_PING_MS:
    25 * 1000,

  WS_STALE_MS:
    70 * 1000,

  BROADCAST_MS:
    250
};


/* =========================================================
   BITGET REST
========================================================= */

const exchange = new ccxt.bitget({

  enableRateLimit: true,

  timeout:
    25000,

  options: {
    defaultType:
      'swap'
  }

});


/* =========================================================
   STATE
========================================================= */

const STATE = {

  markets: [],

  marketMap:
    new Map(),

  universe: [],

  liveUniverse: [],

  context:
    new Map(),

  live:
    new Map(),

  signals:
    new Map(),

  cooldowns:
    new Map(),

  ws: [],

  wsConnected:
    false,

  wsLastMessage:
    0,

  wsReconnects:
    0,

  lastDiscovery:
    0,

  lastContext:
    0,

  lastError:
    '',

  selected:
    'BTC/USDT:USDT',

  selectedTf:
    '15m',

  scanning:
    false,

  market: {

    label:
      'YATAY / KARIŞIK',

    direction:
      'FLAT',

    breadth:
      50,

    green:
      0,

    red:
      0,

    average:
      0,

    btc:
      'NÖTR',

    eth:
      'NÖTR'

  },

  stats: {

    universe:
      0,

    live:
      0,

    watching:
      0,

    ignition:
      0,

    wait:
      0,

    entries:
      0,

    errors:
      0

  }

};


/* =========================================================
   CACHE / QUEUE
========================================================= */

const candleCache =
  new Map();

const restQueue = [];

let restBusy =
  false;

let broadcastTimer =
  null;

let wsRebuildLock =
  false;

let lastWsKey =
  '';


/* =========================================================
   HELPERS
========================================================= */

const sleep =
  ms =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );


const avg =
  arr =>
    arr.length
      ? arr.reduce(
          (a, b) => a + b,
          0
        ) / arr.length
      : 0;


const clamp =
  (v, a, b) =>
    Math.max(
      a,
      Math.min(b, v)
    );


const num =
  (v, d = 6) => {

    const n =
      Number(v);

    return Number.isFinite(n)
      ? Number(
          n.toFixed(d)
        )
      : 0;

  };


const pct =
  (a, b) =>
    b
      ? ((a - b) / b) * 100
      : 0;


const fmt =
  v => {

    const n =
      Number(v);

    if (!Number.isFinite(n))
      return '-';

    if (n >= 1000)
      return n.toFixed(2);

    if (n >= 100)
      return n.toFixed(3);

    if (n >= 1)
      return n.toFixed(5);

    if (n >= 0.01)
      return n.toFixed(7);

    if (n >= 0.0001)
      return n.toFixed(8);

    return n.toFixed(10);

  };


const volumeFmt =
  v => {

    const n =
      Number(v) || 0;

    if (n >= 1e9)
      return (
        n / 1e9
      ).toFixed(2) + 'B';

    if (n >= 1e6)
      return (
        n / 1e6
      ).toFixed(2) + 'M';

    if (n >= 1e3)
      return (
        n / 1e3
      ).toFixed(1) + 'K';

    return Math.round(n)
      .toString();

  };


function cleanSymbol(symbol) {

  let s =
    String(symbol || '')
      .toUpperCase()
      .replace('/USDT:USDT', '')
      .replace('/USDT', '')
      .replace(':USDT', '');

  if (s.endsWith('USDT'))
    s =
      s.slice(0, -4);

  return s + 'USDT';

}


function ccxtSymbol(inst) {

  return (
    `${inst.replace(
      /USDT$/,
      ''
    )}/USDT:USDT`
  );

}


function closed(candles) {

  if (
    Array.isArray(candles) &&
    candles.length > 1
  ) {

    return candles.slice(
      0,
      -1
    );

  }

  return candles || [];

}


/* =========================================================
   REST QUEUE
========================================================= */

function rest(fn) {

  return new Promise(
    (resolve, reject) => {

      restQueue.push({
        fn,
        resolve,
        reject
      });

      pumpRest();

    }
  );

}


async function pumpRest() {

  if (restBusy)
    return;

  restBusy = true;

  while (
    restQueue.length
  ) {

    const task =
      restQueue.shift();

    try {

      task.resolve(
        await task.fn()
      );

    } catch (err) {

      task.reject(err);

    }

    /*
      REST çağrıları arasında
      güvenli boşluk.
    */

    await sleep(275);

  }

  restBusy = false;

}


/* =========================================================
   MARKETS
========================================================= */

async function loadMarkets() {

  const markets =
    await exchange.loadMarkets(
      true
    );

  STATE.markets =
    Object.values(markets)
      .filter(
        m =>
          m &&
          m.active !== false &&
          m.swap === true &&
          m.linear === true &&
          m.quote === 'USDT' &&
          m.settle === 'USDT'
      );

  STATE.marketMap =
    new Map(
      STATE.markets.map(
        m => [
          m.symbol,
          m
        ]
      )
    );

  console.log(
    `MARKETLER | USDT perpetual: ${STATE.markets.length}`
  );

}


async function loadMarketsRetry() {

  let last;

  for (
    let i = 1;
    i <= 3;
    i++
  ) {

    try {

      await loadMarkets();

      return;

    } catch (err) {

      last = err;

      console.error(
        `Market yükleme ${i}/3:`,
        err.message
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
  limit,
  ttl
) {

  const key =
    `${symbol}|${timeframe}|${limit}`;

  const old =
    candleCache.get(key);

  const now =
    Date.now();

  if (
    old &&
    now - old.time < ttl
  ) {

    return old.data;

  }

  try {

    const data =
      await rest(
        () =>
          exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            limit
          )
      );

    const clean =
      Array.isArray(data)
        ? data
            .filter(
              x =>
                Array.isArray(x) &&
                x.length >= 6
            )
            .sort(
              (a, b) =>
                a[0] - b[0]
            )
        : [];

    candleCache.set(
      key,
      {
        time: Date.now(),
        data: clean
      }
    );

    return clean;

  } catch (err) {

    STATE.lastError =
      err.message;

    return old
      ? old.data
      : [];

  }

}


/* =========================================================
   INDICATORS
========================================================= */

function ATR(
  candles,
  period = CFG.ATR
) {

  const c =
    closed(candles);

  if (
    c.length <
    period + 1
  )
    return 0;

  const tr = [];

  for (
    let i = 1;
    i < c.length;
    i++
  ) {

    const high =
      +c[i][2];

    const low =
      +c[i][3];

    const prevClose =
      +c[i - 1][4];

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high -
          prevClose
        ),
        Math.abs(
          low -
          prevClose
        )
      )
    );

  }

  return avg(
    tr.slice(-period)
  );

}


function EMA(
  candles,
  period = CFG.EMA
) {

  const c =
    closed(candles);

  if (
    c.length < period
  )
    return 0;

  const closes =
    c.map(
      x => +x[4]
    );

  const k =
    2 /
    (period + 1);

  let ema =
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

    ema =
      closes[i] * k +
      ema * (1 - k);

  }

  return ema;

}


function VWAP(
  candles,
  lookback = 80
) {

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
        +x[2] +
        +x[3] +
        +x[4]
      ) / 3;

    const vol =
      +x[5] || 0;

    pv +=
      tp * vol;

    v +=
      vol;

  }

  return v
    ? pv / v
    : 0;

}


/* =========================================================
   15M CONTEXT
========================================================= */

function buildContext(
  candles
) {

  const c =
    closed(candles);

  if (
    c.length < 60
  )
    return null;

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
  )
    return null;

  const recent =
    c.slice(
      -CFG.BREAKOUT_LOOKBACK - 1,
      -1
    );

  const recentHigh =
    Math.max(
      ...recent.map(
        x => +x[2]
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x => +x[3]
      )
    );

  const ranges =
    c.slice(-16)
      .map(
        x =>
          +x[2] -
          +x[3]
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
      ? recentRange /
        oldRange
      : 1;

  let direction =
    'FLAT';

  if (
    close > ema &&
    close > vwap
  ) {

    direction =
      'LONG';

  } else if (
    close < ema &&
    close < vwap
  ) {

    direction =
      'SHORT';

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

    updatedAt:
      Date.now()

  };

}


/* =========================================================
   RADAR
========================================================= */

async function discoverUniverse() {

  try {

    const tickers =
      await rest(
        () =>
          exchange.fetchTickers()
      );

    const rows = [];

    for (
      const market of
        STATE.markets
    ) {

      const t =
        tickers[
          market.symbol
        ];

      if (!t)
        continue;

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
        !price ||
        !Number.isFinite(
          price
        ) ||
        volume <
          CFG.MIN_VOLUME_USDT
      )
        continue;

      rows.push({

        symbol:
          market.symbol,

        instId:
          cleanSymbol(
            market.symbol
          ),

        price,

        volume,

        volumeFormatted:
          volumeFmt(volume),

        change

      });

    }


    /*
      Radar yalnızca başlangıç
      adaylarını seçiyor.

      Asıl karar LIVE katmanında.
    */

    rows.sort(
      (a, b) => {

        const rank =
          r =>
            Math.abs(
              r.change
            ) * 0.50 +

            Math.log10(
              r.volume + 1
            ) * 0.20 +

            Math.min(
              Math.abs(
                r.change
              ),
              12
            ) * 0.30;

        return (
          rank(b) -
          rank(a)
        );

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

    STATE.lastDiscovery =
      Date.now();

    calculateMarketRegime(
      rows
    );

    console.log(
      `RADAR | ${STATE.universe.length} coin | LIVE ${STATE.liveUniverse.length}`
    );

    return true;

  } catch (err) {

    STATE.lastError =
      err.message;

    STATE.stats.errors++;

    console.error(
      'RADAR HATASI:',
      err.message
    );

    return false;

  }

}


/* =========================================================
   MARKET REGIME
========================================================= */

function calculateMarketRegime(
  rows
) {

  let green = 0;
  let red = 0;
  let total = 0;

  for (
    const r of rows
  ) {

    if (
      r.change > 0.5
    )
      green++;

    if (
      r.change < -0.5
    )
      red++;

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
    Math.max(
      rows.length,
      1
    );

  const btc =
    rows.find(
      r =>
        r.symbol.includes(
          'BTC'
        )
    );

  const eth =
    rows.find(
      r =>
        r.symbol.includes(
          'ETH'
        )
    );

  let direction =
    'FLAT';

  let label =
    'YATAY / KARIŞIK';

  if (
    breadth >= 55 &&
    average >= 0.5
  ) {

    direction =
      'LONG';

    label =
      'POZİTİF / YÜKSELİŞ';

  } else if (
    breadth <= 45 &&
    average <= -0.5
  ) {

    direction =
      'SHORT';

    label =
      'NEGATİF / DÜŞÜŞ';

  }

  STATE.market = {

    label,

    direction,

    breadth:
      num(breadth, 1),

    green,

    red,

    average:
      num(average, 2),

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

function getLive(
  inst
) {

  if (
    !STATE.live.has(
      inst
    )
  ) {

    STATE.live.set(
      inst,
      {

        symbol:
          ccxtSymbol(inst),

        price:
          0,

        bid:
          0,

        ask:
          0,

        volume24h:
          0,

        oi:
          0,

        prices: [],

        trades: [],

        oiSamples: [],

        lastUpdate:
          0

      }
    );

  }

  return STATE.live.get(
    inst
  );

}


function trimLive(
  live
) {

  /*
    5 dakika tutuyoruz.
    Burst hesaplaması için
    son 2 dakika yeterli ama
    biraz daha buffer bırakıyoruz.
  */

  const cut =
    Date.now() -
    300000;

  while (
    live.prices.length &&
    live.prices[0].time <
      cut
  ) {

    live.prices.shift();

  }

  while (
    live.trades.length &&
    live.trades[0].time <
      cut
  ) {

    live.trades.shift();

  }

  while (
    live.oiSamples.length &&
    live.oiSamples[0].time <
      cut
  ) {

    live.oiSamples.shift();

  }

}


/* =========================================================
   TICKER
========================================================= */

function addTicker(
  inst,
  data
) {

  const live =
    getLive(inst);

  const price =
    Number(
      data.lastPr ||
      data.last ||
      data.close
    );

  if (!price)
    return;

  const now =
    Date.now();

  live.price =
    price;

  live.bid =
    Number(
      data.bidPr ||
      0
    );

  live.ask =
    Number(
      data.askPr ||
      0
    );

  live.volume24h =
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

    live.oi =
      oi;

    live.oiSamples.push({

      time:
        now,

      value:
        oi

    });

  }

  live.prices.push({

    time:
      now,

    value:
      price

  });

  live.lastUpdate =
    now;

  trimLive(live);

  evaluateLive(
    inst
  );

}


/* =========================================================
   TRADE
========================================================= */

function addTrade(
  inst,
  data
) {

  const live =
    getLive(inst);

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
  )
    return;

  const now =
    Date.now();

  const notional =
    price *
    size;

  const side =
    String(
      data.side ||
      ''
    ).toLowerCase();

  live.trades.push({

    time:
      now,

    notional,

    side:
      side === 'buy'
        ? 'buy'
        : 'sell'

  });

  live.lastUpdate =
    now;

  trimLive(live);

  evaluateLive(
    inst
  );

}


/* =========================================================
   FLOW
========================================================= */

function tradesWindow(
  live,
  ms
) {

  const cut =
    Date.now() -
    ms;

  return live.trades
    .filter(
      x =>
        x.time >= cut
    );

}


function flowRatio(
  live,
  ms = 30000
) {

  const trades =
    tradesWindow(
      live,
      ms
    );

  let buy = 0;
  let sell = 0;

  for (
    const t of trades
  ) {

    if (
      t.side === 'buy'
    )
      buy +=
        t.notional;
    else
      sell +=
        t.notional;

  }

  return (
    buy + sell
  )
    ? buy /
      (buy + sell)
    : 0.5;

}


/* =========================================================
   PRICE MOVE
========================================================= */

function priceMove(
  live,
  ms
) {

  const cut =
    Date.now() -
    ms;

  let base =
    null;

  for (
    const p of
      live.prices
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
        live.price,
        base.value
      )
    : 0;

}


/* =========================================================
   OI MOVE
========================================================= */

function oiMove(
  live,
  ms = 30000
) {

  const cut =
    Date.now() -
    ms;

  let base =
    null;

  for (
    const x of
      live.oiSamples
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
        (
          live.oi -
          base.value
        ) /
        Math.abs(
          base.value
        )
      ) *
      100
    : 0;

}


/* =========================================================
   GERÇEK TRADE BURST

   Eski V3:
   24h hacim / 24h zaman

   Yeni V4:
   Son 30 sn /
   önceki 30 sn bloklarının ortalaması
========================================================= */

function volumeBurst(
  live,
  ms = 30000
) {

  const now =
    Date.now();

  const current =
    tradesWindow(
      live,
      ms
    )
      .reduce(
        (sum, t) =>
          sum +
          t.notional,
        0
      );

  if (
    current <= 0
  )
    return 0;

  const baselines = [];

  for (
    let i = 1;
    i <= 4;
    i++
  ) {

    const low =
      now -
      ms *
        (i + 1);

    const high =
      now -
      ms * i;

    const value =
      live.trades
        .filter(
          t =>
            t.time >= low &&
            t.time < high
        )
        .reduce(
          (sum, t) =>
            sum +
            t.notional,
          0
        );

    if (
      value > 0
    )
      baselines.push(
        value
      );

  }

  /*
    Sistem yeni açıldıysa
    geçmiş baseline yoktur.
    Bu durumda hacim patlaması
    iddiasında bulunmuyoruz.
  */

  if (
    baselines.length < 2
  )
    return 1;

  const baseline =
    avg(
      baselines
    );

  return baseline > 0
    ? current /
      baseline
    : 1;

}


/* =========================================================
   SPREAD
========================================================= */

function spreadPct(
  live
) {

  if (
    !live.bid ||
    !live.ask
  )
    return 0;

  return (
    (
      live.ask -
      live.bid
    ) /
    (
      (
        live.ask +
        live.bid
      ) / 2
    )
  ) *
  100;

}


/* =========================================================
   MOMENTUM ENGINE
========================================================= */

function calculateMomentum(
  inst,
  context
) {

  const live =
    getLive(inst);

  if (
    !live.price ||
    !context ||
    live.prices.length < 4
  )
    return null;

  const p10 =
    priceMove(
      live,
      10000
    );

  const p15 =
    priceMove(
      live,
      15000
    );

  const p30 =
    priceMove(
      live,
      30000
    );

  const p60 =
    priceMove(
      live,
      60000
    );

  const flow =
    flowRatio(
      live
    );

  const volume =
    volumeBurst(
      live
    );

  const oi =
    oiMove(
      live
    );

  const spread =
    spreadPct(
      live
    );


  /* =====================================================
     YÖN BELİRLEME

     KRİTİK DEĞİŞİKLİK:

     Önce LIVE fiyat hareketine bakıyoruz.

     Böylece:
       15M SHORT
       ama canlıda pump
     ise SHORT üretmeye devam etmiyoruz.
  ===================================================== */

  let direction =
    null;


  /*
    Güçlü canlı yukarı hareket
  */

  if (
    p30 >=
      CFG.MOVE_30S &&
    flow >= 0.56
  ) {

    direction =
      'LONG';

  }


  /*
    Güçlü canlı aşağı hareket
  */

  else if (
    p30 <=
      -CFG.MOVE_30S &&
    flow <= 0.44
  ) {

    direction =
      'SHORT';

  }


  /*
    Daha erken hareket:
    15M bağlamı kullan.
  */

  else if (
    context.direction ===
      'LONG' &&
    p10 >
      CFG.MOVE_10S
  ) {

    direction =
      'LONG';

  }


  else if (
    context.direction ===
      'SHORT' &&
    p10 <
      -CFG.MOVE_10S
  ) {

    direction =
      'SHORT';

  }


  if (!direction)
    return null;


  const directionalFlow =
    direction === 'LONG'
      ? flow
      : 1 - flow;

  const priceAbs =
    Math.abs(
      p30
    );


  /*
    Skor:

    18 taban
    + fiyat hızlanması
    + trade flow
    + volume burst
    + OI
    + breakout
    + compression
  */

  let score =
    18;


  score +=
    clamp(
      priceAbs /
        0.50 *
        25,
      0,
      25
    );


  score +=
    clamp(
      (
        directionalFlow -
        0.50
      ) /
      0.22 *
      25,
      0,
      25
    );


  score +=
    clamp(
      (
        volume -
        1
      ) /
      2.5 *
      17,
      0,
      17
    );


  /*
    OI:
    Fiyat + OI birlikte
    hareket ediyorsa destek.
  */

  if (
    oi >
    CFG.OI_CONFIRM
  ) {

    score +=
      clamp(
        oi /
          CFG.OI_STRONG *
          8,
        0,
        8
      );

  }

  else if (
    oi < -0.15
  ) {

    score -=
      4;

  }

  else {

    score +=
      2;

  }


  const breakout =
    direction === 'LONG'
      ? live.price >
        context.recentHigh
      : live.price <
        context.recentLow;


  if (
    breakout
  )
    score +=
      7;


  if (
    context.compression <
    0.80
  ) {

    score +=
      5;

  } else if (
    context.compression <
    1
  ) {

    score +=
      2;

  }


  /*
    Spread fazla ise
    skor kır.
  */

  if (
    spread >
    CFG.MAX_SPREAD_PCT
  ) {

    score -=
      15;

  }


  return {

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
      live.price,

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
      num(
        volume,
        2
      ),

    oiChange:
      num(
        oi,
        3
      ),

    spread:
      num(
        spread,
        4
      ),

    breakout,

    compression:
      num(
        context.compression,
        2
      )

  };

}


/* =========================================================
   FOMO / TOO LATE
========================================================= */

function tooLate(
  momentum,
  context
) {

  if (
    !momentum ||
    !context
  )
    return true;


  const level =
    momentum.direction ===
      'LONG'
      ? context.recentHigh
      : context.recentLow;


  const extension =
    context.atr
      ? Math.abs(
          momentum.price -
          level
        ) /
        context.atr
      : 999;


  /*
    Üç ayrı koruma:

    1) ATR'den fazla uzaklaşma
    2) 10 saniyede fazla sıçrama
    3) 30 saniyede fazla sıçrama
  */

  if (
    extension >
    CFG.MAX_ENTRY_EXTENSION_ATR
  )
    return true;


  if (
    Math.abs(
      momentum.priceMove10s
    ) >
    CFG.MAX_ENTRY_MOVE_10S
  )
    return true;


  if (
    Math.abs(
      momentum.priceMove30s
    ) >
    CFG.MAX_ENTRY_MOVE_30S
  )
    return true;


  return false;

}


/* =========================================================
   EXHAUSTION
========================================================= */

function exhaustion(
  signal,
  momentum
) {

  const currentFlow =
    momentum.direction ===
      'LONG'
      ? momentum.flow / 100
      : 1 -
        momentum.flow / 100;


  const oldFlow =
    signal.lastFlow ??
    currentFlow;


  const flowDrop =
    oldFlow -
    currentFlow;


  const volumeDrop =
    (
      signal.lastVolume ||
      momentum.volumeRatio
    ) -
    momentum.volumeRatio;


  const stall =
    Math.abs(
      momentum.priceMove15s
    ) <
    CFG.EXHAUST_STALL_15S;


  signal.lastFlow =
    currentFlow;

  signal.lastVolume =
    momentum.volumeRatio;


  return (
    stall &&
    (
      flowDrop >=
        CFG.EXHAUST_FLOW_DROP ||
      volumeDrop >=
        CFG.EXHAUST_VOL_DROP
    )
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
      context.atr * 0.55,
      price * 0.002
    );


  if (!risk)
    return null;


  if (
    direction === 'LONG'
  ) {

    return {

      entry:
        price,

      stop:
        price -
        risk,

      tp1:
        price +
        risk,

      tp2:
        price +
        risk * 1.7,

      tp3:
        price +
        risk * 2.4

    };

  }


  return {

    entry:
      price,

    stop:
      price +
      risk,

    tp1:
      price -
      risk,

    tp2:
      price -
      risk * 1.7,

    tp3:
      price -
      risk * 2.4

  };

}


/* =========================================================
   REASON
========================================================= */

function reasonFor(
  momentum,
  context
) {

  const reasons =
    [];


  if (
    momentum.breakout
  )
    reasons.push(
      'kırılım'
    );


  if (
    momentum.volumeRatio >=
    CFG.VOL_ENTRY
  ) {

    reasons.push(
      'hacim patlaması'
    );

  } else if (
    momentum.volumeRatio >=
    CFG.VOL_IGNITION
  ) {

    reasons.push(
      'hacim artışı'
    );

  }


  if (
    momentum.direction ===
      'LONG' &&
    momentum.flow >= 60
  ) {

    reasons.push(
      'alış baskısı'
    );

  }


  if (
    momentum.direction ===
      'SHORT' &&
    momentum.flow <= 40
  ) {

    reasons.push(
      'satış baskısı'
    );

  }


  if (
    momentum.oiChange >=
    CFG.OI_CONFIRM
  ) {

    reasons.push(
      'OI destekli'
    );

  }


  if (
    context.compression <
    0.8
  ) {

    reasons.push(
      'sıkışma sonrası'
    );

  }


  return reasons.length
    ? reasons.join(
        ' + '
      )
    : 'canlı momentum';

}


/* =========================================================
   STAGES
========================================================= */

function stageStatus(
  stage
) {

  return {

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

  }[stage] || stage;

}


function stageClass(
  stage
) {

  if (
    stage ===
    'WATCH'
  )
    return 'watch';

  if (
    stage ===
    'IGNITION'
  )
    return 'ignition';

  if (
    stage ===
    'WAIT'
  )
    return 'wait';

  if (
    stage ===
    'ENTRY'
  )
    return 'entry';

  return 'bad';

}


/* =========================================================
   CREATE SIGNAL
========================================================= */

function createSignal(
  inst,
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


  if (!plan)
    return null;


  const now =
    Date.now();


  return {

    id:
      `${inst}|${momentum.direction}`,

    symbol:
      ccxtSymbol(inst),

    marketSymbol:
      ccxtSymbol(inst),

    instId:
      inst,

    direction:
      momentum.direction,

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

    currentPrice:
      num(
        momentum.price
      ),

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

    entry:
      num(plan.entry),

    entryLow:
      num(
        momentum.direction ===
          'LONG'
          ? plan.entry *
            0.998
          : plan.entry *
            1.002
      ),

    entryHigh:
      num(
        momentum.direction ===
          'LONG'
          ? plan.entry *
            1.002
          : plan.entry *
            0.998
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

    entryWindowEnds:
      null,

    lastFlow:
      momentum.direction ===
        'LONG'
        ? momentum.flow /
          100
        : 1 -
          momentum.flow /
          100,

    lastVolume:
      momentum.volumeRatio,

    lastReason:
      'Yeni canlı hareket',

    tf5Confirm:
      false,

    tf1Confirm:
      false,

    tfConfirmAt:
      0,

    tfConfirmPending:
      false,

    tf5Age:
      0,

    tf1Age:
      0

  };

}


/* =========================================================
   ACTIVE SIGNAL
========================================================= */

function activeSignalFor(
  inst
) {

  return [
    ...STATE.signals.values()
  ].find(
    s =>
      s.instId ===
      inst
  );

}


function entryCount() {

  return [
    ...STATE.signals.values()
  ]
    .filter(
      s =>
        s.stage ===
        'ENTRY'
    )
    .length;

}


function setStage(
  signal,
  stage,
  reason
) {

  signal.stage =
    stage;

  signal.status =
    stageStatus(stage);

  signal.stageClass =
    stageClass(stage);

  signal.stageAt =
    Date.now();

  if (reason)
    signal.lastReason =
      reason;

}


/* =========================================================
   5M + 1M CONFIRMATION
========================================================= */

async function confirmLowerTimeframes(
  signal
) {

  if (
    !signal ||
    signal.tfConfirmPending
  )
    return;


  signal.tfConfirmPending =
    true;


  try {

    /*
      Promise.all:
      ikisini paralel başlatıyoruz.
    */

    const [
      m5,
      m1
    ] =
      await Promise.all([

        getCandles(
          signal.symbol,
          '5m',
          CFG.M5_LIMIT,
          CFG.M5_CACHE_MS
        ),

        getCandles(
          signal.symbol,
          '1m',
          CFG.M1_LIMIT,
          CFG.M1_CACHE_MS
        )

      ]);


    const c5 =
      closed(m5);

    const c1 =
      closed(m1);

    const now =
      Date.now();


    signal.tf5Confirm =
      false;

    signal.tf1Confirm =
      false;


    /* =====================================================
       5M
    ===================================================== */

    if (
      c5.length >= 8
    ) {

      const last =
        c5[c5.length - 1];

      const prev =
        c5[c5.length - 2];

      const candleAge =
        now -
        Number(
          last[0]
        );

      const averageVolume =
        avg(
          c5
            .slice(
              -8,
              -1
            )
            .map(
              x =>
                +x[5] || 0
            )
        );

      const volume =
        +last[5] || 0;


      signal.tf5Age =
        Math.round(
          candleAge /
          1000
        );


      /*
        5M candle çok eskiyse
        teyit kabul etmiyoruz.
      */

      const freshEnough =
        candleAge <=
        7 * 60 * 1000;


      const directional =
        signal.direction ===
          'LONG'
          ? +last[4] >
              +prev[4]
          : +last[4] <
              +prev[4];


      signal.tf5Confirm =
        freshEnough &&
        directional &&
        volume >=
          averageVolume *
            0.90;

    }


    /* =====================================================
       1M
    ===================================================== */

    if (
      c1.length >= 6
    ) {

      const last =
        c1[c1.length - 1];

      const prev =
        c1[c1.length - 2];

      const candleAge =
        now -
        Number(
          last[0]
        );

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


      signal.tf1Age =
        Math.round(
          candleAge /
          1000
        );


      const freshEnough =
        candleAge <=
        90 * 1000;


      const directional =
        signal.direction ===
          'LONG'
          ? (
              +last[4] >
                +prev[4] &&
              +last[4] >
                +last[1]
            )
          : (
              +last[4] <
                +prev[4] &&
              +last[4] <
                +last[1]
            );


      const bodyStrong =
        body /
          range >=
        0.25;


      signal.tf1Confirm =
        freshEnough &&
        directional &&
        bodyStrong;

    }


    signal.tfConfirmAt =
      now;


  } catch (err) {

    signal.tf5Confirm =
      false;

    signal.tf1Confirm =
      false;

    signal.lastReason =
      '5M / 1M teyidi alınamadı';

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
  momentum,
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
        num(
          momentum.price
        ),

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


  /* =====================================================
     KRİTİK RED TEAM KONTROL

     Örneğin:

       ASTER SHORT

     ama canlı fiyat:

       +0.5%
       +0.8%
       +1.2%

     ve flow LONG oldu.

     Eski sinyal artık geçersiz.
  ===================================================== */

  if (
    momentum.direction !==
    signal.direction
  ) {

    closeSignal(
      signal,
      'Canlı momentum yön değiştirdi'
    );

    return;

  }


  /* =====================================================
     SPREAD
  ===================================================== */

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


  /* =====================================================
     ENTRY SONRASI
  ===================================================== */

  if (
    signal.stage ===
    'ENTRY'
  ) {

    if (
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


    if (
      exhaustion(
        signal,
        momentum
      )
    ) {

      setStage(
        signal,
        'EXHAUSTION',
        'Momentum zayıfladı'
      );

      return;

    }

  }


  /* =====================================================
     WATCH -> IGNITION
  ===================================================== */

  if (
    signal.stage ===
      'WATCH' &&

    momentum.score >=
      CFG.IGNITION_SCORE &&

    momentum.volumeRatio >=
      CFG.VOL_IGNITION &&

    Math.abs(
      momentum.priceMove15s
    ) >=
      CFG.MOVE_15S
  ) {

    setStage(
      signal,
      'IGNITION',
      'Fiyat ve hacim hızlandı'
    );

    return;

  }


  /* =====================================================
     IGNITION -> WAIT
  ===================================================== */

  if (
    (
      signal.stage ===
        'WATCH' ||
      signal.stage ===
        'IGNITION'
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


  /* =====================================================
     WAIT -> TEYİT YENİLE
  ===================================================== */

  if (
    signal.stage ===
      'WAIT' &&

    !signal.tfConfirmPending &&

    (
      !signal.tfConfirmAt ||
      now -
        signal.tfConfirmAt >
      15000
    )
  ) {

    confirmLowerTimeframes(
      signal
    );

  }


  /* =====================================================
     WAIT / IGNITION -> ENTRY
  ===================================================== */

  if (
    (
      signal.stage ===
        'WAIT' ||
      signal.stage ===
        'IGNITION'
    ) &&

    momentum.score >=
      CFG.ENTRY_SCORE &&

    momentum.volumeRatio >=
      CFG.VOL_ENTRY &&

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
          momentum.direction ===
            'LONG'
            ? plan.entry *
              0.998
            : plan.entry *
              1.002
        );

      signal.entryHigh =
        num(
          momentum.direction ===
            'LONG'
            ? plan.entry *
              1.002
            : plan.entry *
              0.998
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

    console.log(
      `🟢 GİRİŞ FIRSATI | ${signal.symbol} | ${signal.direction} | ${signal.score}`
    );

    return;

  }


  /* =====================================================
     WATCH TIMEOUT
  ===================================================== */

  if (
    signal.stage ===
      'WATCH' &&

    now -
      signal.signalAt >
    CFG.WATCH_TTL_MS
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'İZLE süresi doldu'
    );

    return;

  }


  /* =====================================================
     IGNITION TIMEOUT
  ===================================================== */

  if (
    signal.stage ===
      'IGNITION' &&

    now -
      signal.signalAt >
    CFG.WATCH_TTL_MS
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Hareket teyit edilemedi'
    );

    return;

  }


  /* =====================================================
     WAIT TIMEOUT
  ===================================================== */

  if (
    signal.stage ===
      'WAIT' &&

    now -
      signal.stageAt >
    CFG.WAIT_TTL_MS
  ) {

    setStage(
      signal,
      'EXHAUSTION',
      'Teyit süresi doldu'
    );

  }

}


/* =========================================================
   EVALUATE
========================================================= */

function evaluateLive(
  inst
) {

  const context =
    STATE.context.get(
      ccxtSymbol(inst)
    );

  if (!context)
    return;


  const momentum =
    calculateMomentum(
      inst,
      context
    );

  if (!momentum)
    return;


  let signal =
    activeSignalFor(
      inst
    );


  /* =====================================================
     YENİ SİNYAL
  ===================================================== */

  if (!signal) {

    if (
      momentum.score <
      CFG.WATCH_SCORE
    )
      return;


    const key =
      `${inst}|${momentum.direction}`;


    const last =
      STATE.cooldowns.get(
        key
      );


    if (
      last &&
      Date.now() -
        last <
        CFG.COOLDOWN_MS
    )
      return;


    if (
      STATE.signals.size >=
      CFG.MAX_SIGNALS
    )
      return;


    let stage =
      'WATCH';


    /*
      Kırılım zaten gerçekleşmiş
      ama hâlâ geç kalınmamışsa
      doğrudan WAIT.
    */

    if (
      momentum.score >=
        CFG.WAIT_SCORE &&

      momentum.breakout &&

      !tooLate(
        momentum,
        context
      )
    ) {

      stage =
        'WAIT';

    }

    else if (
      momentum.score >=
        CFG.IGNITION_SCORE &&

      momentum.volumeRatio >=
        CFG.VOL_IGNITION
    ) {

      stage =
        'IGNITION';

    }


    signal =
      createSignal(
        inst,
        momentum,
        context,
        stage
      );


    if (!signal)
      return;


    STATE.signals.set(
      signal.id,
      signal
    );


    if (
      stage ===
      'WAIT'
    ) {

      signal.lastReason =
        'Kırılım oluştu; 5M + 1M teyidi bekleniyor';

      confirmLowerTimeframes(
        signal
      );

    }


    console.log(
      `${stageStatus(stage)} | ${signal.symbol} | ${signal.direction} | ${signal.score}`
    );

  }

  else {

    updateSignal(
      signal,
      momentum,
      context
    );

  }


  scheduleBroadcast();

}


/* =========================================================
   CLOSE SIGNAL
========================================================= */

function closeSignal(
  signal,
  reason
) {

  if (
    !STATE.signals.has(
      signal.id
    )
  )
    return;


  STATE.signals.delete(
    signal.id
  );


  STATE.cooldowns.set(
    `${signal.instId}|${signal.direction}`,
    Date.now()
  );


  console.log(
    `FIRSAT KAPANDI | ${signal.symbol} | ${signal.direction} | ${reason}`
  );


  scheduleBroadcast();

}


/* =========================================================
   CLEANUP
========================================================= */

function cleanup() {

  const now =
    Date.now();


  for (
    const [
      id,
      signal
    ] of
      STATE.signals
  ) {

    signal.ageSeconds =
      Math.floor(
        (
          now -
          signal.signalAt
        ) / 1000
      );


    if (
      signal.stage ===
        'ENTRY' &&

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


    /*
      Zayıflama / geç kalındı
      kısa süre görünür.
    */

    if (
      (
        signal.stage ===
          'EXHAUSTION' ||
        signal.stage ===
          'TOO_LATE'
      ) &&

      now -
        signal.stageAt >
      8000
    ) {

      closeSignal(
        signal,
        signal.lastReason ||
          'Durum sona erdi'
      );

    }

  }


  for (
    const [
      key,
      timestamp
    ] of
      STATE.cooldowns
  ) {

    if (
      now -
        timestamp >
      CFG.COOLDOWN_MS
    ) {

      STATE.cooldowns.delete(
        key
      );

    }

  }

}


/* =========================================================
   REFRESH 15M CONTEXT
========================================================= */

async function refreshContexts() {

  if (
    STATE.scanning
  )
    return;


  STATE.scanning =
    true;


  try {

    const candidates =
      STATE.liveUniverse.slice(
        0,
        CFG.CONTEXT_SYMBOLS
      );


    for (
      const row of
        candidates
    ) {

      const candles =
        await getCandles(
          row.symbol,
          '15m',
          CFG.M15_LIMIT,
          CFG.M15_CACHE_MS
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


  } catch (err) {

    STATE.lastError =
      err.message;

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

  const symbols =
    STATE.liveUniverse
      .slice(
        0,
        CFG.LIVE_SYMBOLS
      )
      .map(
        x =>
          x.instId
      );


  const groups =
    [];


  for (
    let i = 0;
    i < symbols.length;
    i +=
      CFG.WS_GROUP_SIZE
  ) {

    groups.push(
      symbols.slice(
        i,
        i +
          CFG.WS_GROUP_SIZE
      )
    );

  }


  return groups;

}


/* =========================================================
   SUBSCRIBE
========================================================= */

function subscriptionArgs(
  symbols
) {

  const args =
    [];


  for (
    const instId of
      symbols
  ) {

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


/* =========================================================
   CLOSE WS
========================================================= */

function closeWsConnections() {

  for (
    const holder of
      STATE.ws
  ) {

    try {

      holder.manual =
        true;

      holder.ws.close();

    } catch (_) {}

  }


  STATE.ws =
    [];

  STATE.wsConnected =
    false;

}


/* =========================================================
   CONNECT WS GROUP
========================================================= */

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

    manual:
      false

  };


  STATE.ws.push(
    holder
  );


  ws.on(
    'open',
    () => {

      const args =
        subscriptionArgs(
          symbols
        );


      ws.send(
        JSON.stringify({
          op:
            'subscribe',
          args
        })
      );


      console.log(
        `WS${index + 1} ABONELİK | ${symbols.length} coin | ${symbols.length * 2} kanal`
      );


      scheduleBroadcast();

    }
  );


  ws.on(
    'message',
    raw => {

      STATE.wsLastMessage =
        Date.now();


      try {

        const text =
          raw.toString();


        if (
          text ===
          'pong'
        )
          return;


        const msg =
          JSON.parse(
            text
          );


        if (
          msg.event ===
          'error'
        ) {

          STATE.lastError =
            `WS${index + 1}: ${
              msg.msg ||
              'subscribe error'
            }`;

          return;

        }


        const arg =
          msg.arg ||
          {};


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
        )
          return;


        if (
          channel ===
          'ticker'
        ) {

          addTicker(
            instId,
            data[0]
          );

        }


        else if (
          channel ===
          'trade'
        ) {

          for (
            const trade of
              data
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


      } catch (err) {

        STATE.lastError =
          err.message;

      }

    }
  );


  ws.on(
    'error',
    err => {

      STATE.lastError =
        `WS${index + 1}: ${err.message}`;

      console.error(
        `BITGET WS${index + 1} ERROR:`,
        err.message
      );

    }
  );


  ws.on(
    'close',
    () => {

      STATE.wsReconnects++;

      STATE.wsConnected =
        STATE.ws.some(
          x =>
            x.ws.readyState ===
            WebSocket.OPEN
        );


      if (
        !holder.manual
      ) {

        setTimeout(
          () =>
            rebuildWs(),
          3000
        );

      }


      scheduleBroadcast();

    }
  );

}


/* =========================================================
   REBUILD WS
========================================================= */

function rebuildWs() {

  if (
    wsRebuildLock
  )
    return;


  wsRebuildLock =
    true;


  try {

    closeWsConnections();


    const groups =
      makeWsGroups();


    groups.forEach(
      (
        group,
        index
      ) => {

        connectWsGroup(
          group,
          index
        );

      }
    );


    lastWsKey =
      STATE.liveUniverse
        .map(
          x =>
            x.instId
        )
        .join(',');


  } finally {

    setTimeout(
      () => {

        wsRebuildLock =
          false;

      },
      1000
    );

  }

}


/* =========================================================
   WS HEALTH
========================================================= */

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

    return;

  }


  if (
    STATE.wsLastMessage &&
    Date.now() -
      STATE.wsLastMessage >
      CFG.WS_STALE_MS
  ) {

    rebuildWs();

  }

}


/* =========================================================
   PING
========================================================= */

setInterval(
  () => {

    for (
      const holder of
        STATE.ws
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

  },
  CFG.WS_PING_MS
);


/* =========================================================
   WS SUBSCRIPTION CHANGE
========================================================= */

function maybeRefreshWsSubscriptions() {

  const key =
    STATE.liveUniverse
      .map(
        x =>
          x.instId
      )
      .join(',');


  if (
    key !==
    lastWsKey
  ) {

    rebuildWs();

  }

}


/* =========================================================
   SIGNAL LIST
========================================================= */

function getSignals() {

  const order = {

    ENTRY:
      5,

    WAIT:
      4,

    IGNITION:
      3,

    WATCH:
      2

  };


  return [
    ...STATE.signals.values()
  ]
    .sort(
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


/* =========================================================
   STATUS
========================================================= */

function status() {

  cleanup();


  const signals =
    getSignals();


  STATE.stats.watching =
    signals.filter(
      s =>
        s.stage ===
        'WATCH'
    ).length;


  STATE.stats.ignition =
    signals.filter(
      s =>
        s.stage ===
        'IGNITION'
    ).length;


  STATE.stats.wait =
    signals.filter(
      s =>
        s.stage ===
        'WAIT'
    ).length;


  STATE.stats.entries =
    signals.filter(
      s =>
        s.stage ===
        'ENTRY'
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

  if (
    broadcastTimer
  )
    return;


  broadcastTimer =
    setTimeout(
      () => {

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
          const client of
            wss.clients
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

      },
      CFG.BROADCAST_MS
    );

}


/* =========================================================
   AUTH
========================================================= */

function apiAuth(
  req,
  res,
  next
) {

  const token =
    process.env.API_TOKEN;


  if (!token)
    return next();


  const supplied =
    req.headers[
      'x-api-token'
    ] ||
    req.query.token;


  if (
    supplied !==
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
   ROUTES
========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json(
      status()
    );

  }
);


app.get(
  '/api/health',
  (req, res) => {

    res.json({

      status:
        'ok',

      uptime:
        process.uptime(),

      ws:
        STATE.wsConnected,

      connections:
        STATE.ws.length,

      lastError:
        STATE.lastError

    });

  }
);


app.get(
  '/api/scan',
  apiAuth,
  async (
    req,
    res
  ) => {

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

    } catch (err) {

      res
        .status(500)
        .json({

          success:
            false,

          error:
            err.message

        });

    }

  }
);


/* =========================================================
   HISTORY
   KASITLI OLARAK BOŞ
========================================================= */

app.get(
  '/api/history',
  apiAuth,
  (
    req,
    res
  ) => {

    res.json({

      success:
        true,

      history:
        []

    });

  }
);


/* =========================================================
   CHART
========================================================= */

app.get(
  '/api/chart',
  apiAuth,
  async (
    req,
    res
  ) => {

    try {

      const symbol =
        req.query.symbol ||
        'BTC/USDT:USDT';


      const timeframe =
        [
          '1m',
          '5m',
          '15m'
        ].includes(
          req.query.timeframe
        )
          ? req.query.timeframe
          : '15m';


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


      const limit =
        timeframe === '1m'
          ? 180
          : timeframe === '5m'
          ? 180
          : 160;


      const ttl =
        timeframe === '1m'
          ? CFG.M1_CACHE_MS
          : timeframe === '5m'
          ? CFG.M5_CACHE_MS
          : CFG.M15_CACHE_MS;


      const candles =
        await getCandles(
          symbol,
          timeframe,
          limit,
          ttl
        );


      const signal =
        getSignals()
          .find(
            s =>
              s.marketSymbol ===
              symbol
          ) ||
        null;


      res.json({

        success:
          true,

        symbol,

        timeframe,

        candles,

        signal

      });


    } catch (err) {

      res
        .status(500)
        .json({

          success:
            false,

          error:
            err.message

        });

    }

  }
);


/* =========================================================
   FRONTEND WS
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
<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER
</title>


<style>

:root{

  --bg:#060a0f;
  --panel:#0d141d;
  --panel2:#111b27;
  --line:#203044;
  --txt:#edf3f8;
  --muted:#7e8da0;

  --g:#16e0a1;
  --r:#ff4f70;
  --o:#ff9e43;
  --y:#f2cf3d;
  --b:#55a8ff;

}


*{
  box-sizing:border-box;
}


body{

  margin:0;

  background:
    var(--bg);

  color:
    var(--txt);

  font:
    13px Arial,sans-serif;

}


.app{

  display:grid;

  grid-template-columns:
    300px
    minmax(0,1fr)
    340px;

  min-height:100vh;

}


.side{

  background:
    #091019;

  padding:12px;

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

  font-size:17px;

  font-weight:900;

  color:
    var(--g);

}


.sub{

  font-size:9px;

  color:
    var(--muted);

  margin:
    4px 0 12px;

}


.live{

  font-size:10px;

  color:
    var(--g);

  margin-bottom:10px;

}


.dot{

  display:inline-block;

  width:7px;

  height:7px;

  border-radius:50%;

  background:
    var(--g);

  margin-right:6px;

}


.dot.off{

  background:
    var(--r);

}


.sec{

  margin:
    13px 0;

}


.head{

  display:flex;

  justify-content:space-between;

  color:
    var(--muted);

  font-size:10px;

  font-weight:800;

  margin-bottom:6px;

}


.count{

  background:
    #172434;

  border-radius:
    10px;

  padding:
    2px 7px;

  color:
    #fff;

}


.card{

  background:
    var(--panel);

  border:
    1px solid var(--line);

  border-left:
    4px solid var(--y);

  border-radius:
    8px;

  padding:
    9px;

  margin:
    5px 0;

  cursor:pointer;

}


.card.long{

  border-left-color:
    var(--g);

}


.card.short{

  border-left-color:
    var(--r);

}


.card.ignition{

  border-left-color:
    var(--o);

}


.card.wait{

  border-left-color:
    var(--b);

}


.coin{

  font-weight:900;

}


.dir{

  font-size:9px;

  font-weight:900;

}


.stage{

  font-size:9px;

  font-weight:900;

  margin-top:6px;

}


.watch{

  color:
    var(--y);

}


.ignition{

  color:
    var(--o);

}


.wait{

  color:
    var(--b);

}


.entry{

  color:
    var(--g);

}


.bad{

  color:
    var(--r);

}


.price{

  font-size:15px;

  font-weight:900;

  margin-top:4px;

}


.mini{

  font-size:9px;

  color:
    var(--muted);

  line-height:1.55;

}


.time{

  font-size:9px;

  color:#c6d0da;

  margin-top:4px;

}


.main{

  padding:10px;

  min-width:0;

}


.top{

  display:flex;

  justify-content:space-between;

  align-items:center;

  margin-bottom:8px;

}


.title{

  font-size:17px;

  font-weight:900;

}


.conn{

  font-size:10px;

  color:
    var(--g);

  font-weight:900;

}


.chart{

  height:
    calc(100vh - 65px);

  min-height:520px;

  background:
    var(--panel);

  border:
    1px solid var(--line);

  border-radius:
    9px;

  overflow:hidden;

}


.chartHead{

  height:42px;

  display:flex;

  justify-content:space-between;

  align-items:center;

  padding:
    0 10px;

  border-bottom:
    1px solid var(--line);

}


.tf button{

  background:
    #101a26;

  color:
    var(--muted);

  border:
    1px solid var(--line);

  border-radius:
    5px;

  padding:
    5px 8px;

  font-size:9px;

}


.tf .active{

  color:
    var(--g);

  border-color:
    var(--g);

}


canvas{

  display:block;

  width:100%;

  height:
    calc(100% - 42px);

}


.box{

  background:
    var(--panel);

  border:
    1px solid var(--line);

  border-radius:
    8px;

  padding:
    11px;

  margin-bottom:9px;

}


.bt{

  font-size:9px;

  font-weight:900;

  color:
    var(--muted);

  margin-bottom:7px;

}


.reg{

  font-size:16px;

  font-weight:900;

}


.grid{

  display:grid;

  grid-template-columns:
    1fr 1fr;

  gap:5px;

  margin-top:8px;

}


.stat{

  background:
    #091019;

  border:
    1px solid #182536;

  border-radius:
    5px;

  padding:6px;

}


.stat span{

  display:block;

  color:
    var(--muted);

  font-size:8px;

}


.stat b{

  font-size:11px;

}


.big{

  font-size:19px;

  font-weight:900;

}


.bar{

  height:6px;

  background:
    #1a2633;

  border-radius:6px;

  overflow:hidden;

  margin:8px 0;

}


.bar i{

  display:block;

  height:100%;

  background:
    var(--g);

}


.levels{

  display:grid;

  grid-template-columns:
    1fr 1fr;

  gap:5px;

}


.lev{

  background:
    #091019;

  border:
    1px solid #182536;

  border-radius:5px;

  padding:6px;

}


.lev span{

  display:block;

  color:
    var(--muted);

  font-size:8px;

}


.lev b{

  font-size:10px;

}


.metric{

  display:flex;

  justify-content:space-between;

  padding:6px 0;

  border-bottom:
    1px solid #182331;

  font-size:9px;

}


.metric span{

  color:
    var(--muted);

}


.empty{

  text-align:center;

  color:#647488;

  font-size:10px;

  padding:12px;

}


.notice{

  font-size:9px;

  color:#aebac7;

  line-height:1.6;

}


.notice b{

  color:#fff;

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

    grid-template-columns:
      1fr;

  }

  .left{

    display:none;

  }

  .chart{

    min-height:500px;

  }

}

</style>

</head>


<body>


<div class="app">


<!-- LEFT -->

<aside class="side left">

  <div class="brand">
    ⚡ SONNY AI TRADER
  </div>

  <div class="sub">
    RED TEAM V4 • 15M / 5M / 1M / CANLI
  </div>

  <div class="live">

    <i
      id="dot"
      class="dot"
    ></i>

    <span id="conn">
      CANLI BAĞLANTI
    </span>

  </div>


  <section class="sec">

    <div class="head">

      <span>
        🟢 GİRİŞ FIRSATLARI
      </span>

      <b
        id="ec"
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

  </section>


  <section class="sec">

    <div class="head">

      <span>
        🔵 BEKLE
      </span>

      <b
        id="wc"
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

  </section>


  <section class="sec">

    <div class="head">

      <span>
        🟠 HAREKET BAŞLADI
      </span>

      <b
        id="ic"
        class="count"
      >
        0
      </b>

    </div>

    <div id="ign">

      <div class="empty">
        Hareket yok
      </div>

    </div>

  </section>


  <section class="sec">

    <div class="head">

      <span>
        🟡 İZLE
      </span>

      <b
        id="xc"
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

  </section>


</aside>


<!-- CENTER -->

<main class="main">

  <div class="top">

    <div
      id="title"
      class="title"
    >
      BTC/USDT:USDT
    </div>

    <div
      id="status"
      class="conn"
    >
      ● BAĞLANIYOR
    </div>

  </div>


  <div class="chart">

    <div class="chartHead">

      <b id="chartTitle">
        BTC/USDT:USDT • 15M
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


    <canvas id="cv"></canvas>

  </div>

</main>


<!-- RIGHT -->

<aside class="side right">


  <div class="box">

    <div class="bt">
      GENEL PİYASA
    </div>

    <div
      id="reg"
      class="reg"
    >
      YATAY / KARIŞIK
    </div>

    <div class="grid">

      <div class="stat">

        <span>
          Genişlik
        </span>

        <b id="bread">
          -
        </b>

      </div>


      <div class="stat">

        <span>
          Ortalama
        </span>

        <b id="avg">
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
      id="be"
      class="mini"
    >
      BTC: - • ETH: -
    </div>

  </div>


  <div class="box">

    <div class="bt">
      CANLI FIRSAT
    </div>

    <div id="detail">

      <div class="empty">
        Bir fırsat seçin
      </div>

    </div>

  </div>


  <div class="box">

    <div class="bt">
      SİSTEM DURUMU
    </div>

    <div
      id="sys"
      class="mini"
    >
      Hazırlanıyor...
    </div>

  </div>


  <div class="box">

    <div class="bt">
      NASIL OKUNUR?
    </div>

    <div class="notice">

      <b>İZLE</b>
      =
      erken hareket.

      <br>

      <b>HAREKET BAŞLADI</b>
      =
      momentum hızlanıyor.

      <br>

      <b>BEKLE</b>
      =
      kırılım oluştu,
      5M + 1M teyidi bekleniyor.

      <br>

      <b>GİRİŞ FIRSATI</b>
      =
      teyit tamamlandı ve
      giriş penceresi açık.

      <br>

      <b>GEÇ KALINDI</b>
      =
      fiyat fazla uzadı.

      <br>

      <b>ZAYIFLAMA</b>
      =
      canlı momentum bozuldu.

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


let signals =
  [];


let candles =
  [];


/* =====================================================
   HELPERS
===================================================== */

const $ =
  id =>
    document.getElementById(id);


const esc =
  value =>
    String(
      value ?? ''
    )
    .replace(
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


function price(
  value
) {

  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  )
    return '-';

  if (
    n >= 1000
  )
    return n.toFixed(2);

  if (
    n >= 100
  )
    return n.toFixed(3);

  if (
    n >= 1
  )
    return n.toFixed(5);

  if (
    n >= .01
  )
    return n.toFixed(7);

  if (
    n >= .0001
  )
    return n.toFixed(8);

  return n.toFixed(10);

}


function age(
  seconds
) {

  seconds =
    Number(
      seconds || 0
    );


  if (
    seconds < 60
  )
    return (
      seconds +
      ' sn'
    );


  return (
    Math.floor(
      seconds / 60
    ) +
    ' dk ' +
    String(
      seconds % 60
    ).padStart(
      2,
      '0'
    ) +
    ' sn'
  );

}


function remaining(
  ms
) {

  if (
    ms <= 0
  )
    return '0 sn';


  return age(
    Math.floor(
      ms / 1000
    )
  );

}


/* =====================================================
   CARD
===================================================== */

function card(
  signal
) {

  const cls =
    signal.stage ===
      'ENTRY'
      ? 'entry'
      : signal.stage ===
        'WAIT'
      ? 'wait'
      : signal.stage ===
        'IGNITION'
      ? 'ignition'
      : 'watch';


  const coin =
    signal.symbol
      .replace(
        '/USDT:USDT',
        ''
      );


  let timer =
    '';


  if (
    signal.stage ===
      'ENTRY' &&
    signal.entryWindowEnds
  ) {

    timer =
      `
      <div class="time">
        ⏱ Giriş:
        ${remaining(
          signal.entryWindowEnds -
          Date.now()
        )}
      </div>
      `;

  }


  return `

    <div
      class="card
        ${signal.direction.toLowerCase()}
        ${cls}"
      data-s="${esc(
        signal.marketSymbol
      )}"
    >

      <div
        style="
          display:flex;
          justify-content:space-between
        "
      >

        <b class="coin">
          ${esc(coin)}
        </b>

        <span class="dir">
          ${esc(
            signal.direction
          )}
        </span>

      </div>


      <div
        class="stage ${cls}"
      >
        ${esc(
          signal.status
        )}
      </div>


      <div class="price">
        ${price(
          signal.currentPrice
        )}
      </div>


      <div class="mini">

        Momentum
        ${signal.score}/100

        • Hacim
        ${signal.volumeRatio}x

        <br>

        Akış
        ${signal.flow}%

        • OI
        ${signal.oiChange}%

      </div>


      <div class="time">

        Sinyal:
        ${new Date(
          signal.signalAt
        ).toLocaleTimeString(
          'tr-TR'
        )}

      </div>


      ${timer}

    </div>

  `;

}


/* =====================================================
   METRIC
===================================================== */

function metric(
  name,
  value
) {

  return `

    <div class="metric">

      <span>
        ${esc(name)}
      </span>

      <b>
        ${esc(value)}
      </b>

    </div>

  `;

}


/* =====================================================
   RENDER
===================================================== */

function render(
  data
) {

  signals =
    data.signals ||
    [];


  const market =
    data.market ||
    {};


  $('reg')
    .textContent =
      market.label ||
      'YATAY / KARIŞIK';


  $('bread')
    .textContent =
      '%' +
      (
        market.breadth ??
        '-'
      );


  $('avg')
    .textContent =
      (
        market.average ??
        '-'
      ) +
      '%';


  $('green')
    .textContent =
      market.green ??
      '-';


  $('red')
    .textContent =
      market.red ??
      '-';


  $('be')
    .textContent =
      'BTC: ' +
      (
        market.btc ||
        '-'
      ) +
      ' • ETH: ' +
      (
        market.eth ||
        '-'
      );


  const entries =
    signals.filter(
      s =>
        s.stage ===
        'ENTRY'
    );


  const waits =
    signals.filter(
      s =>
        s.stage ===
        'WAIT'
    );


  const ignitions =
    signals.filter(
      s =>
        s.stage ===
        'IGNITION'
    );


  const watches =
    signals.filter(
      s =>
        s.stage ===
        'WATCH'
    );


  $('ec')
    .textContent =
      entries.length;


  $('wc')
    .textContent =
      waits.length;


  $('ic')
    .textContent =
      ignitions.length;


  $('xc')
    .textContent =
      watches.length;


  $('entries')
    .innerHTML =
      entries.length
        ? entries
            .map(card)
            .join('')
        : `
          <div class="empty">
            Giriş bekleniyor
          </div>
        `;


  $('wait')
    .innerHTML =
      waits.length
        ? waits
            .map(card)
            .join('')
        : `
          <div class="empty">
            Bekleyen kurulum yok
          </div>
        `;


  $('ign')
    .innerHTML =
      ignitions.length
        ? ignitions
            .map(card)
            .join('')
        : `
          <div class="empty">
            Hareket yok
          </div>
        `;


  $('watch')
    .innerHTML =
      watches.length
        ? watches
            .map(card)
            .join('')
        : `
          <div class="empty">
            İzlenecek coin yok
          </div>
        `;


  const connected =
    !!data.ws?.connected;


  $('dot').className =
    'dot' +
    (
      connected
        ? ''
        : ' off'
    );


  $('conn')
    .textContent =
      connected
        ? 'CANLI BAĞLANTI'
        : 'BAĞLANTI KESİLDİ';


  $('status')
    .textContent =
      connected
        ? '● CANLI'
        : '● KESİLDİ';


  $('status')
    .style.color =
      connected
        ? 'var(--g)'
        : 'var(--r)';


  $('sys')
    .innerHTML =

      'Radar: ' +
      (
        data.stats?.universe ||
        0
      ) +

      ' • Canlı: ' +
      (
        data.stats?.live ||
        0
      ) +

      '<br>İzle: ' +
      (
        data.stats?.watching ||
        0
      ) +

      ' • Hareket: ' +
      (
        data.stats?.ignition ||
        0
      ) +

      '<br>Bekle: ' +
      (
        data.stats?.wait ||
        0
      ) +

      ' • Giriş: ' +
      (
        data.stats?.entries ||
        0
      ) +

      '<br>WS: ' +
      (
        data.ws?.open ||
        0
      ) +

      ' bağlantı • Reconnect: ' +
      (
        data.ws?.reconnects ||
        0
      );


  /*
    Seçili coin hâlâ varsa onu göster.
    Yoksa en güçlü canlı fırsata geç.
  */

  let chosen =
    signals.find(
      s =>
        s.marketSymbol ===
        selected
    );


  if (!chosen) {

    chosen =
      entries[0] ||
      waits[0] ||
      ignitions[0] ||
      watches[0];

  }


  if (chosen) {

    const changed =
      chosen.marketSymbol !==
      selected;


    selected =
      chosen.marketSymbol;


    showSignal(
      chosen
    );


    if (
      changed
    )
      loadChart();

  }


  bindCards();

}


/* =====================================================
   SHOW SIGNAL
===================================================== */

function showSignal(
  signal
) {

  $('title')
    .textContent =
      signal.symbol;


  $('chartTitle')
    .textContent =
      signal.symbol +
      ' • ' +
      timeframe.toUpperCase();


  const cls =
    signal.stage ===
      'ENTRY'
      ? 'entry'
      : signal.stage ===
        'WAIT'
      ? 'wait'
      : signal.stage ===
        'IGNITION'
      ? 'ignition'
      : 'watch';


  let timer =
    '';


  if (
    signal.stage ===
      'ENTRY' &&
    signal.entryWindowEnds
  ) {

    timer =
      `

      <div class="time">

        ⏱ Giriş penceresi:

        <b>
          ${remaining(
            signal.entryWindowEnds -
            Date.now()
          )}
        </b>

      </div>

      `;

  }


  $('detail')
    .innerHTML = `

      <div
        class="big ${cls}"
      >
        ${esc(
          signal.status
        )}
      </div>


      <div class="mini">

        ${esc(
          signal.symbol
        )}

        •
        ${esc(
          signal.direction
        )}

        <br>

        Sinyal:
        ${new Date(
          signal.signalAt
        ).toLocaleTimeString(
          'tr-TR'
        )}

        • Yaş:
        ${age(
          signal.ageSeconds
        )}

      </div>


      ${timer}


      <div class="bar">

        <i
          style="
            width:
              ${Math.min(
                100,
                Number(
                  signal.score
                ) || 0
              )}%
          "
        ></i>

      </div>


      <div class="mini">

        Momentum
        ${signal.score}/100

      </div>


      <div class="levels">


        <div class="lev">

          <span>
            GİRİŞ
          </span>

          <b>
            ${price(
              signal.entryLow
            )}

            -

            ${price(
              signal.entryHigh
            )}

          </b>

        </div>


        <div class="lev">

          <span>
            STOP
          </span>

          <b>
            ${price(
              signal.stop
            )}
          </b>

        </div>


        <div class="lev">

          <span>
            HEDEF 1
          </span>

          <b>
            ${price(
              signal.tp1
            )}
          </b>

        </div>


        <div class="lev">

          <span>
            HEDEF 2
          </span>

          <b>
            ${price(
              signal.tp2
            )}
          </b>

        </div>


      </div>


      <div
        style="margin-top:6px"
      >

        ${metric(
          'Fiyat 10 sn',
          signal.priceMove10s +
          '%'
        )}

        ${metric(
          'Fiyat 30 sn',
          signal.priceMove30s +
          '%'
        )}

        ${metric(
          'İşlem akışı',
          signal.flow +
          '%'
        )}

        ${metric(
          'Hacim patlaması',
          signal.volumeRatio +
          'x'
        )}

        ${metric(
          'OI',
          signal.oiChange +
          '%'
        )}

        ${metric(
          'Spread',
          signal.spread +
          '%'
        )}

        ${metric(
          '15M yön',
          signal.contextDirection
        )}

        ${metric(
          'Kırılım',
          signal.breakout
            ? 'EVET'
            : 'HAYIR'
        )}

        ${metric(
          '5M teyit',
          signal.tf5Confirm
            ? 'EVET'
            : 'BEKLİYOR'
        )}

        ${metric(
          '1M teyit',
          signal.tf1Confirm
            ? 'EVET'
            : 'BEKLİYOR'
        )}

        ${metric(
          'Neden',
          signal.reason
        )}

      </div>

    `;

}


/* =====================================================
   CARD BIND
===================================================== */

function bindCards() {

  document
    .querySelectorAll(
      '.card'
    )
    .forEach(
      element => {

        element.onclick =
          () => {

            selected =
              element.dataset.s;


            const signal =
              signals.find(
                s =>
                  s.marketSymbol ===
                  selected
              );


            if (
              signal
            ) {

              showSignal(
                signal
              );

              loadChart();

            }

          };

      }
    );

}


/* =====================================================
   NORMALIZE CHART
===================================================== */

function normalize(
  array
) {

  return (
    array || []
  )
    .map(
      x =>
        Array.isArray(x)
          ? {

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


/* =====================================================
   LOAD CHART
===================================================== */

async function loadChart() {

  try {

    const response =
      await fetch(

        '/api/chart?' +

        'symbol=' +
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

  } catch (_) {

    draw();

  }

}


/* =====================================================
   DRAW
===================================================== */

function draw() {

  const canvas =
    $('cv');


  const rect =
    canvas.getBoundingClientRect();


  const dpr =
    devicePixelRatio ||
    1;


  const width =
    Math.max(
      300,
      rect.width | 0
    );


  const height =
    Math.max(
      300,
      rect.height | 0
    );


  canvas.width =
    width *
    dpr;


  canvas.height =
    height *
    dpr;


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
    '#060a0f';


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
      '#7e8da0';

    ctx.font =
      '12px Arial';

    ctx.fillText(
      'Grafik verisi bekleniyor...',
      15,
      25
    );

    return;

  }


  const visible =
    candles.slice(
      -100
    );


  const signal =
    signals.find(
      s =>
        s.marketSymbol ===
        selected
    );


  let min =
    Math.min(
      ...visible.map(
        x =>
          x.low
      )
    );


  let max =
    Math.max(
      ...visible.map(
        x =>
          x.high
      )
    );


  if (
    signal
  ) {

    [
      signal.entry,
      signal.stop,
      signal.tp1,
      signal.tp2
    ]
      .forEach(
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
    (
      max -
      min
    ) *
    0.08 ||
    1;


  min -=
    padding;

  max +=
    padding;


  const L =
    45;

  const R =
    75;

  const T =
    10;

  const B =
    10;


  const plotWidth =
    width -
    L -
    R;

  const plotHeight =
    height -
    T -
    B;


  const Y =
    value =>
      T +
      (
        max -
        value
      ) /
      (
        max -
        min
      ) *
      plotHeight;


  const X =
    index =>
      L +
      index *
      plotWidth /
      Math.max(
        1,
        visible.length -
        1
      );


  ctx.strokeStyle =
    '#172433';


  for (
    let i = 0;
    i <= 5;
    i++
  ) {

    const y =
      T +
      plotHeight *
      i /
      5;


    ctx.beginPath();

    ctx.moveTo(
      L,
      y
    );

    ctx.lineTo(
      width - R,
      y
    );

    ctx.stroke();

  }


  const step =
    plotWidth /
    Math.max(
      1,
      visible.length -
      1
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
    (candle, i) => {

      const x =
        X(i);


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
        Y(
          candle.high
        )
      );

      ctx.lineTo(
        x,
        Y(
          candle.low
        )
      );

      ctx.stroke();


      const openY =
        Y(
          candle.open
        );

      const closeY =
        Y(
          candle.close
        );


      ctx.fillRect(

        x -
          candleWidth /
          2,

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


  if (
    signal
  ) {

    drawLine(
      signal.entry,
      '#16e0a1',
      'GİRİŞ'
    );


    drawLine(
      signal.stop,
      '#ff4f70',
      'STOP'
    );


    drawLine(
      signal.tp1,
      '#55a8ff',
      'HEDEF 1'
    );


    drawLine(
      signal.tp2,
      '#55a8ff',
      'HEDEF 2'
    );

  }


  function drawLine(
    value,
    color,
    label
  ) {

    if (
      !Number.isFinite(
        +value
      )
    )
      return;


    const y =
      Y(
        +value
      );


    ctx.strokeStyle =
      color;


    ctx.setLineDash(
      [5,5]
    );


    ctx.beginPath();

    ctx.moveTo(
      L,
      y
    );

    ctx.lineTo(
      width - R,
      y
    );

    ctx.stroke();


    ctx.setLineDash(
      []
    );


    ctx.fillStyle =
      color;

    ctx.font =
      'bold 9px Arial';


    ctx.fillText(

      label +
      ' ' +
      price(value),

      width -
        R +
        3,

      y + 3

    );

  }

}


/* =====================================================
   CLOCK
===================================================== */

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
        s =>
          s.marketSymbol ===
          selected
      );


    if (
      signal
    )
      showSignal(
        signal
      );

  },
  1000
);


/* =====================================================
   CHART REFRESH
===================================================== */

setInterval(
  () => {

    if (
      selected
    )
      loadChart();

  },
  5000
);


/* =====================================================
   TIMEFRAME
===================================================== */

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
                x.classList
                  .remove(
                    'active'
                  )
            );


          button.classList.add(
            'active'
          );


          timeframe =
            button.dataset.tf;


          loadChart();

        };

    }
  );


/* =====================================================
   FRONTEND WS
===================================================== */

function connectFrontend() {

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
        connectFrontend,
        1500
      );

    };

}


connectFrontend();


loadChart();


window.addEventListener(
  'resize',
  draw
);


})();
</script>


</body>
</html>
`;


/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  (req, res) => {

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
  err => {

    STATE.lastError =
      err?.message ||
      String(err);

    console.error(
      'UNHANDLED:',
      err
    );

  }
);


process.on(
  'uncaughtException',
  err => {

    STATE.lastError =
      err?.message ||
      String(err);

    console.error(
      'UNCAUGHT:',
      err
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
      '🚀 SONNY AI TRADER — RED TEAM V4'
    );

    console.log(
      '🔥 MOMENTUM SCALPER / MANUEL GİRİŞ'
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


      rebuildWs();


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


      setInterval(
        () => {

          refreshContexts();

        },
        CFG.CONTEXT_MS
      );


      setInterval(
        () => {

          cleanup();

          scheduleBroadcast();

        },
        1000
      );


      setInterval(
        () => {

          wsHealth();

        },
        15000
      );


      console.log(
        '🟢 SİSTEM BAŞLADI'
      );


    } catch (err) {

      STATE.lastError =
        err.message;

      console.error(
        'BOOT ERROR:',
        err
      );

    }

  }
);
