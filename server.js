'use strict';

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
   SONNY AI TRADER V5.3
   500 RADAR
   150 ADAY
   40 DERİN
   4H + 2H
      ↓
   15M BREAKOUT
      ↓
   RETEST
      ↓
   5M BONUS
      ↓
   SIGNAL

   FRONTEND server.js İÇİNDE
   AUTO TRADE KAPALI
========================================================= */

const CFG = {
  RADAR: 500,
  CANDIDATES: 150,
  DEEP: 40,
  MAX_SIGNALS: 15,

  MIN_VOLUME_USDT:
    Number(process.env.MIN_VOLUME_USDT || 750000),

  SCAN_MS: 60000,
  LIVE_MS: 10000,

  CONCURRENCY: 6,

  H4: 100,
  H2: 100,
  M15: 160,
  M5: 80,

  CHART: 160,

  LEVEL_LOOKBACK: 20,
  BREAKOUT_LOOKBACK: 12,
  BREAKOUT_VOL: 1.15,

  RETEST_TOL: 0.0045,
  RETEST_MIN: 90 * 60 * 1000,

  MIN_SCORE: 70,

  MIN_RR: 1.50,
  TP2_RR: 2.25,
  TP3_RR: 3.25,

  ATR_STOP: 0.90,

  SIGNAL_TTL:
    45 * 60 * 1000,

  COOLDOWN:
    4 * 60 * 60 * 1000,

  FIVE_MIN_REQUIRED: false,

  AUTO_TRADE: false
};


/* =========================================================
   EXCHANGE
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
  candidates: [],
  deep: [],

  signals: new Map(),
  pending: new Map(),
  cooldowns: new Map(),

  selected: 'BTC/USDT:USDT',
  selectedTf: '15m',

  scanning: false,

  lastScan: 0,
  lastError: '',

  market: {
    label: 'YATAY / KARIŞIK',
    direction: 'FLAT',
    breadth: 50,
    green: 0,
    red: 0,
    average: 0,
    btc: 'NEUTRAL',
    eth: 'NEUTRAL'
  },

  chart: {
    symbol: 'BTC/USDT:USDT',
    timeframe: '15m',
    candles: [],
    signal: null
  },

  stats: {
    universe: 0,
    candidates: 0,
    deep: 0,
    analyzed: 0,
    pending: 0,
    signals: 0,
    errors: 0
  }
};


/* =========================================================
   HELPERS
========================================================= */

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function avg(values) {
  if (!values.length) return 0;

  return values.reduce(
    (sum, value) => sum + value,
    0
  ) / values.length;
}

function closed(candles) {
  if (!Array.isArray(candles)) {
    return [];
  }

  if (candles.length <= 1) {
    return candles;
  }

  return candles.slice(0, -1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanSymbol(symbol) {
  let x = String(symbol || '')
    .toUpperCase()
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(':USDT', '');

  if (x.endsWith('USDT')) {
    x = x.slice(0, -4);
  }

  return x + 'USDT';
}

function symbolToCcxt(symbol) {
  const s = String(symbol || '').toUpperCase();

  if (s.includes('/USDT:USDT')) {
    return s;
  }

  if (s.includes('/USDT')) {
    return s.replace(
      '/USDT',
      '/USDT:USDT'
    );
  }

  if (s.endsWith('USDT')) {
    return (
      s.slice(0, -4) +
      '/USDT:USDT'
    );
  }

  return s + '/USDT:USDT';
}

function findMarket(symbol) {
  const wanted = cleanSymbol(symbol);

  if (!STATE.markets.length) {
    return null;
  }

  return (
    STATE.markets.find(
      market =>
        cleanSymbol(
          market.symbol
        ) === wanted
    ) ||
    null
  );
}

function fmtPrice(value) {
  const x = Number(value);

  if (!Number.isFinite(x)) {
    return null;
  }

  if (x >= 1000) {
    return Number(x.toFixed(2));
  }

  if (x >= 100) {
    return Number(x.toFixed(3));
  }

  if (x >= 1) {
    return Number(x.toFixed(5));
  }

  if (x >= 0.01) {
    return Number(x.toFixed(7));
  }

  if (x >= 0.0001) {
    return Number(x.toFixed(8));
  }

  return Number(x.toFixed(10));
}

function percentDistance(a, b) {
  if (!b) {
    return 999;
  }

  return (
    Math.abs(a - b) /
    b
  ) * 100;
}


/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(
  items,
  limit,
  worker
) {
  const result =
    new Array(items.length);

  let cursor = 0;

  async function runner() {

    while (true) {

      const index =
        cursor++;

      if (
        index >= items.length
      ) {
        return;
      }

      try {

        result[index] =
          await worker(
            items[index]
          );

      } catch (error) {

        STATE.stats.errors += 1;

        console.error(
          'ANALİZ ERROR:',
          items[index] &&
          items[index].symbol
            ? items[index].symbol
            : 'UNKNOWN',
          '|',
          error.message
        );

        result[index] = null;
      }

    }

  }

  const workers =
    Math.min(
      limit,
      items.length
    );

  await Promise.all(
    Array.from(
      {
        length:
          workers
      },
      runner
    )
  );

  return result.filter(Boolean);
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
    Object.values(
      markets
    ).filter(
      market =>

        market &&
        market.active !== false &&
        market.swap === true &&
        market.linear === true &&
        market.quote === 'USDT' &&
        market.settle === 'USDT'
    );

  STATE.marketMap =
    new Map(
      STATE.markets.map(
        market => [
          market.symbol,
          market
        ]
      )
    );

  return STATE.markets;
}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
  symbol,
  timeframe,
  limit
) {

  try {

    const data =
      await exchange.fetchOHLCV(
        symbol,
        timeframe,
        undefined,
        limit
      );

    if (
      !Array.isArray(data)
    ) {
      return [];
    }

    return data
      .filter(
        candle =>
          Array.isArray(candle) &&
          candle.length >= 6
      )
      .sort(
        (a, b) =>
          Number(a[0]) -
          Number(b[0])
      );

  } catch (error) {

    if (
      process.env.DEBUG ===
      'true'
    ) {

      console.error(
        `CANDLE ERROR ${symbol} ${timeframe}:`,
        error.message
      );

    }

    return [];
  }
}


/* =========================================================
   TICKERS
========================================================= */

async function getTickers() {

  const tickers =
    await exchange.fetchTickers();

  const rows = [];

  for (
    const market
    of STATE.markets
  ) {

    const ticker =
      tickers[
        market.symbol
      ];

    if (!ticker) {
      continue;
    }

    const last =
      n(
        ticker.last ||
        ticker.close
      );

    const volume =
      n(
        ticker.quoteVolume
      );

    const change =
      n(
        ticker.percentage
      );

    if (
      !(last > 0) ||
      !(volume > 0)
    ) {
      continue;
    }

    const high =
      n(
        ticker.high
      );

    const low =
      n(
        ticker.low
      );

    const range =
      low > 0
        ? (
            (
              high -
              low
            ) /
            low
          ) * 100
        : 0;

    rows.push({

      symbol:
        market.symbol,

      coin:
        cleanSymbol(
          market.symbol
        ),

      price:
        last,

      volume,

      change,

      range
    });
  }

  rows.sort(
    (
      a,
      b
    ) => {

      const scoreA =
        a.volume *
        (
          1 +
          Math.min(
            Math.abs(
              a.change
            ),
            30
          ) /
          100
        );

      const scoreB =
        b.volume *
        (
          1 +
          Math.min(
            Math.abs(
              b.change
            ),
            30
          ) /
          100
        );

      return scoreB - scoreA;
    }
  );

  return rows.slice(
    0,
    CFG.RADAR
  );
}


/* =========================================================
   INDICATORS
========================================================= */

function ema(
  candles,
  period
) {

  const c =
    closed(candles);

  if (
    c.length <
    period
  ) {

    return null;
  }

  let value =
    avg(
      c
        .slice(
          0,
          period
        )
        .map(
          candle =>
            n(
              candle[4]
            )
        )
    );

  const k =
    2 /
    (
      period +
      1
    );

  for (
    let i = period;
    i < c.length;
    i++
  ) {

    value =
      n(
        c[i][4]
      ) * k +

      value *
      (
        1 -
        k
      );
  }

  return value;
}

function rsi(
  candles,
  period = 14
) {

  const c =
    closed(candles);

  if (
    c.length <
    period + 1
  ) {

    return 50;
  }

  let gains = 0;
  let losses = 0;

  const start =
    c.length -
    period;

  for (
    let i = start;
    i < c.length;
    i++
  ) {

    const diff =
      n(
        c[i][4]
      ) -
      n(
        c[i - 1][4]
      );

    if (
      diff > 0
    ) {

      gains += diff;

    } else {

      losses +=
        Math.abs(
          diff
        );
    }
  }

  if (
    losses === 0
  ) {

    return 100;
  }

  const rs =
    (
      gains /
      period
    ) /
    (
      losses /
      period
    );

  return (
    100 -
    (
      100 /
      (
        1 +
        rs
      )
    )
  );
}

function atr(
  candles,
  period = 14
) {

  const c =
    closed(candles);

  if (
    c.length <
    period + 1
  ) {

    return 0;
  }

  const values = [];

  for (
    let i = 1;
    i < c.length;
    i++
  ) {

    const high =
      n(
        c[i][2]
      );

    const low =
      n(
        c[i][3]
      );

    const previousClose =
      n(
        c[i - 1][4]
      );

    values.push(
      Math.max(
        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
      )
    );
  }

  return avg(
    values.slice(
      -period
    )
  );
}

function trend(
  candles
) {

  const c =
    closed(candles);

  if (
    c.length < 55
  ) {

    return 'NEUTRAL';
  }

  const e21 =
    ema(
      candles,
      21
    );

  const e50 =
    ema(
      candles,
      50
    );

  const last =
    n(
      c[
        c.length - 1
      ][4]
    );

  if (
    e21 === null ||
    e50 === null
  ) {

    return 'NEUTRAL';
  }

  if (
    last > e21 &&
    e21 > e50
  ) {

    return 'LONG';
  }

  if (
    last < e21 &&
    e21 < e50
  ) {

    return 'SHORT';
  }

  return 'NEUTRAL';
}

function structure15m(
  candles
) {

  const c =
    closed(candles)
      .slice(
        -20
      );

  if (
    c.length < 8
  ) {

    return 'NEUTRAL';
  }

  const half =
    Math.floor(
      c.length /
      2
    );

  const first =
    c.slice(
      0,
      half
    );

  const second =
    c.slice(
      half
    );

  const firstHigh =
    Math.max(
      ...first.map(
        x =>
          n(x[2])
      )
    );

  const firstLow =
    Math.min(
      ...first.map(
        x =>
          n(x[3])
      )
    );

  const secondHigh =
    Math.max(
      ...second.map(
        x =>
          n(x[2])
      )
    );

  const secondLow =
    Math.min(
      ...second.map(
        x =>
          n(x[3])
      )
    );

  if (
    secondHigh >
      firstHigh &&
    secondLow >
      firstLow
  ) {

    return 'LONG';
  }

  if (
    secondHigh <
      firstHigh &&
    secondLow <
      firstLow
  ) {

    return 'SHORT';
  }

  return 'NEUTRAL';
}


/* =========================================================
   PIVOT / LEVEL
========================================================= */

function pivots(
  candles,
  lookback = 3
) {

  const c =
    closed(candles);

  const result = [];

  for (
    let i = lookback;
    i <
      c.length -
      lookback;
    i++
  ) {

    const high =
      n(
        c[i][2]
      );

    const low =
      n(
        c[i][3]
      );

    let isHigh =
      true;

    let isLow =
      true;

    for (
      let j = 1;
      j <= lookback;
      j++
    ) {

      if (
        high <=
        n(
          c[i - j][2]
        ) ||
        high <=
        n(
          c[i + j][2]
        )
      ) {

        isHigh =
          false;
      }

      if (
        low >=
        n(
          c[i - j][3]
        ) ||
        low >=
        n(
          c[i + j][3]
        )
      ) {

        isLow =
          false;
      }
    }

    if (
      isHigh
    ) {

      result.push({

        price:
          high,

        type:
          'resistance',

        time:
          c[i][0]
      });
    }

    if (
      isLow
    ) {

      result.push({

        price:
          low,

        type:
          'support',

        time:
          c[i][0]
      });
    }
  }

  return result;
}

function getLevels(
  candles
) {

  const raw =
    pivots(
      candles
    );

  const groups = [];

  for (
    const level
    of raw
  ) {

    const group =
      groups.find(
        item =>
          item.type ===
            level.type &&
          Math.abs(
            level.price -
            item.price
          ) /
            item.price <=
            0.004
      );

    if (
      group
    ) {

      group.items.push(
        level
      );

      group.price =
        avg(
          group.items.map(
            item =>
              item.price
          )
        );

    } else {

      groups.push({

        type:
          level.type,

        price:
          level.price,

        items:
          [
            level
          ]
      });
    }
  }

  return groups.map(
    group => ({

      type:
        group.type,

      price:
        group.price,

      touches:
        group.items.length,

      lastTouch:
        Math.max(
          ...group.items.map(
            item =>
              item.time
          )
        )
    })
  );
}


/* =========================================================
   BREAKOUT
========================================================= */

function detectBreakouts(
  candles,
  levels
) {

  const c =
    closed(candles);

  const result = [];

  if (
    c.length <
    CFG.BREAKOUT_LOOKBACK + 2
  ) {

    return result;
  }

  const start =
    Math.max(
      CFG.BREAKOUT_LOOKBACK,
      c.length - 4
    );

  for (
    let i = start;
    i < c.length;
    i++
  ) {

    const candle =
      c[i];

    const previous =
      c[i - 1];

    const before =
      c.slice(
        Math.max(
          0,
          i - 20
        ),
        i
      );

    const averageVolume =
      avg(
        before
          .map(
            x =>
              n(x[5])
          )
          .filter(
            x =>
              x > 0
          )
      );

    const currentVolume =
      n(
        candle[5]
      );

    const volumeRatio =
      averageVolume > 0
        ? currentVolume /
          averageVolume
        : 1;

    const range =
      Math.max(
        n(candle[2]) -
        n(candle[3]),
        1e-12
      );

    const body =
      Math.abs(
        n(candle[4]) -
        n(candle[1])
      );

    const bodyRatio =
      body /
      range;

    if (
      volumeRatio <
        CFG.BREAKOUT_VOL ||
      bodyRatio <
        0.20
    ) {

      continue;
    }

    for (
      const level
      of levels
    ) {

      if (
        level.type ===
          'resistance' &&

        n(previous[4]) <=
          level.price &&

        n(candle[4]) >
          level.price
      ) {

        result.push({

          direction:
            'LONG',

          level,

          time:
            n(
              candle[0]
            ),

          breakoutVolumeRatio:
            volumeRatio,

          breakoutBodyAtr:
            body /
            (
              atr(
                candles
              ) ||
              n(
                candle[4]
              ) *
              0.003
            ),

          breakoutBodyRatio:
            bodyRatio
        });
      }

      if (
        level.type ===
          'support' &&

        n(previous[4]) >=
          level.price &&

        n(candle[4]) <
          level.price
      ) {

        result.push({

          direction:
            'SHORT',

          level,

          time:
            n(
              candle[0]
            ),

          breakoutVolumeRatio:
            volumeRatio,

          breakoutBodyAtr:
            body /
            (
              atr(
                candles
              ) ||
              n(
                candle[4]
              ) *
              0.003
            ),

          breakoutBodyRatio:
            bodyRatio
        });
      }

    }
  }

  return result;
}

function saveBreakouts(
  symbol,
  breakouts
) {

  for (
    const breakout
    of breakouts
  ) {

    const key =
      [
        symbol,
        breakout.direction,
        fmtPrice(
          breakout.level.price
        )
      ].join('|');

    const old =
      STATE.pending.get(
        key
      );

    if (
      old
    ) {

      old.lastSeen =
        Date.now();

      continue;
    }

    STATE.pending.set(
      key,
      {

        key,

        symbol,

        direction:
          breakout.direction,

        level:
          breakout.level,

        breakoutTime:
          breakout.time,

        breakoutVolumeRatio:
          breakout.breakoutVolumeRatio,

        breakoutBodyAtr:
          breakout.breakoutBodyAtr,

        breakoutBodyRatio:
          breakout.breakoutBodyRatio,

        status:
          'WAITING_RETEST',

        lastSeen:
          Date.now(),

        createdAt:
          Date.now()
      }
    );

    console.log(
      'BREAKOUT |',
      cleanSymbol(symbol),
      '|',
      breakout.direction,
      '|',
      fmtPrice(
        breakout.level.price
      ),
      '| VOL',
      breakout.breakoutVolumeRatio.toFixed(2) + 'x'
    );
  }
}


/* =========================================================
   RETEST
========================================================= */

function detectRetest(
  candles,
  pending
) {

  const age =
    Date.now() -
    pending.breakoutTime;

  if (
    age >
    CFG.RETEST_MIN
  ) {

    return {
      status:
        'EXPIRED'
    };
  }

  const c =
    closed(candles);

  const after =
    c.filter(
      candle =>
        n(
          candle[0]
        ) >
        pending.breakoutTime
    );

  if (
    !after.length
  ) {

    return {
      status:
        'WAITING_RETEST'
    };
  }

  let touched =
    false;

  let recovered =
    false;

  const tolerance =
    pending.level.price *
    CFG.RETEST_TOL;

  for (
    const candle
    of after.slice(
      0,
      8
    )
  ) {

    const high =
      n(
        candle[2]
      );

    const low =
      n(
        candle[3]
      );

    const close =
      n(
        candle[4]
      );

    const touch =
      high >=
        pending.level.price -
        tolerance &&
      low <=
        pending.level.price +
        tolerance;

    if (
      touch
    ) {

      touched =
        true;

      if (
        pending.direction ===
        'LONG'
      ) {

        if (
          close >=
          pending.level.price *
          0.995
        ) {

          recovered =
            true;
        }

      } else {

        if (
          close <=
          pending.level.price *
          1.005
        ) {

          recovered =
            true;
        }
      }
    }
  }

  if (
    touched &&
    recovered
  ) {

    return {

      status:
        'RETESTED',

      candle:
        after[
          after.length - 1
        ]
    };
  }

  return {

    status:
      'WAITING_RETEST'
  };
}


/* =========================================================
   5M CONFIRM
========================================================= */

function confirm5M(
  candles,
  direction
) {

  const c =
    closed(candles);

  if (
    c.length < 3
  ) {

    return {

      confirmed:
        false,

      candle:
        null
    };
  }

  const last =
    c[
      c.length - 1
    ];

  const previous =
    c[
      c.length - 2
    ];

  let confirmed =
    false;

  if (
    direction ===
    'LONG'
  ) {

    confirmed =
      n(last[4]) >
        n(last[1]) &&
      n(last[4]) >=
        n(previous[4]);

  } else {

    confirmed =
      n(last[4]) <
        n(last[1]) &&
      n(last[4]) <=
        n(previous[4]);
  }

  return {

    confirmed,

    candle:
      last
  };
}


/* =========================================================
   TRADE PLAN
========================================================= */

function buildTradePlan(
  direction,
  level,
  candles,
  oppositeLevels
) {

  const c =
    closed(candles);

  if (
    c.length < 20
  ) {

    return null;
  }

  const price =
    n(
      c[
        c.length - 1
      ][4]
    );

  const currentATR =
    atr(
      candles,
      14
    ) ||
    price *
    0.005;

  const recent =
    c.slice(
      -6
    );

  const swingLow =
    Math.min(
      ...recent.map(
        x =>
          n(x[3])
      )
    );

  const swingHigh =
    Math.max(
      ...recent.map(
        x =>
          n(x[2])
      )
    );

  let entry;
  let stop;

  if (
    direction ===
    'LONG'
  ) {

    entry =
      Math.max(
        price,
        level.price
      );

    stop =
      Math.min(
        swingLow,
        level.price -
        currentATR *
        CFG.ATR_STOP
      );

    if (
      stop >=
      entry
    ) {

      stop =
        entry -
        currentATR *
        CFG.ATR_STOP;
    }

  } else {

    entry =
      Math.min(
        price,
        level.price
      );

    stop =
      Math.max(
        swingHigh,
        level.price +
        currentATR *
        CFG.ATR_STOP
      );

    if (
      stop <=
      entry
    ) {

      stop =
        entry +
        currentATR *
        CFG.ATR_STOP;
    }
  }

  const risk =
    Math.abs(
      entry -
      stop
    );

  if (
    !(risk > 0)
  ) {

    return null;
  }

  let tp1;
  let tp2;
  let tp3;

  if (
    direction ===
    'LONG'
  ) {

    tp1 =
      entry +
      risk *
      CFG.MIN_RR;

    tp2 =
      entry +
      risk *
      CFG.TP2_RR;

    tp3 =
      entry +
      risk *
      CFG.TP3_RR;

    const resistance =
      oppositeLevels
        .filter(
          item =>
            item.price >
            entry
        )
        .sort(
          (
            a,
            b
          ) =>
            a.price -
            b.price
        );

    if (
      resistance.length &&
      resistance[0].price >
        tp1
    ) {

      tp3 =
        Math.min(
          tp3,
          resistance[0].price
        );
    }

    if (
      !(
        stop <
        entry &&
        entry <
        tp1 &&
        tp1 <
        tp2 &&
        tp2 <
        tp3
      )
    ) {

      return null;
    }

  } else {

    tp1 =
      entry -
      risk *
      CFG.MIN_RR;

    tp2 =
      entry -
      risk *
      CFG.TP2_RR;

    tp3 =
      entry -
      risk *
      CFG.TP3_RR;

    const support =
      oppositeLevels
        .filter(
          item =>
            item.price <
            entry
        )
        .sort(
          (
            a,
            b
          ) =>
            b.price -
            a.price
        );

    if (
      support.length &&
      support[0].price <
        tp1
    ) {

      tp3 =
        Math.max(
          tp3,
          support[0].price
        );
    }

    if (
      !(
        tp3 <
        tp2 &&
        tp2 <
        tp1 &&
        tp1 <
        entry &&
        entry <
        stop
      )
    ) {

      return null;
    }
  }

  const rr =
    Math.abs(
      tp1 -
      entry
    ) /
    risk;

  if (
    rr <
    CFG.MIN_RR
  ) {

    return null;
  }

  return {

    entryLow:
      direction ===
      'LONG'
        ? Math.min(
            level.price,
            entry
          )
        : Math.min(
            entry,
            level.price
          ),

    entryHigh:
      direction ===
      'LONG'
        ? Math.max(
            level.price,
            entry
          )
        : Math.max(
            entry,
            level.price
          ),

    entry,

    stop,

    tp1,

    tp2,

    tp3,

    rr:
      Number(
        rr.toFixed(2)
      )
  };
}


/* =========================================================
   SCORE
========================================================= */

function calculateScore(
  direction,
  h4,
  h2,
  m15,
  m5,
  breakoutVolume,
  confluence,
  rsiValue
) {

  let score =
    45;

  const reasons =
    [];


  if (
    h4 ===
    direction
  ) {

    score +=
      15;

    reasons.push(
      '4H uyumlu'
    );
  }


  if (
    h2 ===
    direction
  ) {

    score +=
      12;

    reasons.push(
      '2H uyumlu'
    );
  }


  if (
    m15 ===
    direction
  ) {

    score +=
      8;

    reasons.push(
      '15M yapı uyumlu'
    );
  }


  if (
    m5 ===
    direction
  ) {

    score +=
      8;

    reasons.push(
      '5M teyit'
    );
  }


  if (
    breakoutVolume >=
    1.5
  ) {

    score +=
      8;

    reasons.push(
      'yüksek breakout hacmi'
    );
  }


  if (
    breakoutVolume >=
    2
  ) {

    score +=
      5;

    reasons.push(
      'çok güçlü hacim'
    );
  }


  if (
    confluence
  ) {

    score +=
      8;

    reasons.push(
      '4H + 2H seviye birleşimi'
    );
  }


  if (
    direction ===
      'LONG' &&
    rsiValue >=
      48 &&
    rsiValue <=
      75
  ) {

    score +=
      5;

    reasons.push(
      'RSI uygun'
    );
  }


  if (
    direction ===
      'SHORT' &&
    rsiValue >=
      25 &&
    rsiValue <=
      52
  ) {

    score +=
      5;

    reasons.push(
      'RSI uygun'
    );
  }


  return {

    score:
      Math.min(
        100,
        Math.round(
          score
        )
      ),

    reasons
  };
}


/* =========================================================
   DEEP ANALYSIS
========================================================= */

async function analyzeDeep(
  coin
) {

  const symbol =
    coin.symbol;

  try {

    const [
      h4,
      h2,
      m15,
      m5
    ] =
      await Promise.all([

        getCandles(
          symbol,
          '4h',
          CFG.H4
        ),

        getCandles(
          symbol,
          '2h',
          CFG.H2
        ),

        getCandles(
          symbol,
          '15m',
          CFG.M15
        ),

        getCandles(
          symbol,
          '5m',
          CFG.M5
        )

      ]);


    if (
      h4.length < 55 ||
      h2.length < 55 ||
      m15.length < 35 ||
      m5.length < 12
    ) {

      return {

        analyzed:
          false,

        signals:
          []

      };
    }


    const price =
      n(
        coin.price
      );


    const levels4 =
      getLevels(
        h4
      );


    const levels2 =
      getLevels(
        h2
      );


    const allLevels =
      [
        ...levels4.map(
          level => ({
            ...level,
            tf:
              '4H'
          })
        ),

        ...levels2.map(
          level => ({
            ...level,
            tf:
              '2H'
          })
        )
      ];


    /*
       Breakout state
    */

    const breakouts =
      detectBreakouts(
        m15,
        allLevels
      );


    saveBreakouts(
      symbol,
      breakouts
    );


    const h4Trend =
      trend(
        h4
      );


    const h2Trend =
      trend(
        h2
      );


    const m15Structure =
      structure15m(
        m15
      );


    const m5Trend =
      trend(
        m5
      );


    const signals =
      [];


    /*
       Pending yalnızca bu coin.
    */

    const coinPending =
      [
        ...STATE.pending.values()
      ]
      .filter(
        item =>
          item.symbol ===
          symbol
      );


    for (
      const pending
      of coinPending
    ) {

      const retest =
        detectRetest(
          m15,
          pending
        );


      pending.status =
        retest.status;


      if (
        retest.status ===
        'EXPIRED'
      ) {

        STATE.pending.delete(
          pending.key
        );

        continue;
      }


      if (
        retest.status !==
        'RETESTED'
      ) {

        continue;
      }


      /*
         H4 + H2 trend filtresi
      */

      if (
        h4Trend !==
          'NEUTRAL' &&
        h2Trend !==
          'NEUTRAL' &&
        h4Trend !==
          pending.direction &&
        h2Trend !==
          pending.direction
      ) {

        pending.status =
          'REJECTED_TREND';

        continue;
      }


      const five =
        confirm5M(
          m5,
          pending.direction
        );


      /*
         5M zorunlu değil.
         Bonus olarak kullanılıyor.
      */

      if (
        CFG.FIVE_MIN_REQUIRED &&
        !five.confirmed
      ) {

        pending.status =
          'WAITING_5M_CONFIRM';

        continue;
      }


      const oppositeLevels =
        pending.direction ===
          'LONG'

          ?

          [
            ...allLevels.filter(
              level =>
                level.type ===
                'resistance'
            )
          ]

          :

          [
            ...allLevels.filter(
              level =>
                level.type ===
                'support'
            )
          ];


      const trade =
        buildTradePlan(
          pending.direction,
          pending.level,
          m15,
          oppositeLevels
        );


      if (
        !trade
      ) {

        pending.status =
          'REJECTED_RR';

        continue;
      }


      const sameZone =
        allLevels.filter(
          level =>
            level.type ===
              pending.level.type &&

            percentDistance(
              level.price,
              pending.level.price
            ) <=
              0.4
        );


      const has4 =
        sameZone.some(
          level =>
            level.tf ===
            '4H'
        );


      const has2 =
        sameZone.some(
          level =>
            level.tf ===
            '2H'
        );


      const confluence =
        has4 &&
        has2;


      const currentRsi =
        rsi(
          m15
        );


      const score =
        calculateScore(
          pending.direction,
          h4Trend,
          h2Trend,
          m15Structure,
          m5Trend,
          pending.breakoutVolumeRatio,
          confluence,
          currentRsi
        );


      if (
        score.score <
        CFG.MIN_SCORE
      ) {

        pending.status =
          'REJECTED_SCORE';

        continue;
      }


      const cooldownKey =
        `${pending.symbol}|${pending.direction}|${fmtPrice(
          pending.level.price
        )}`;


      const cooldown =
        STATE.cooldowns.get(
          cooldownKey
        );


      if (
        cooldown &&
        Date.now() -
          cooldown <
          CFG.COOLDOWN
      ) {

        continue;
      }


      const timestamp =
        Date.now();


      const signal = {

        id:
          pending.symbol +
          '|' +
          pending.direction,

        symbol:
          pending.symbol,

        ccxt_symbol:
          pending.symbol,

        coin:
          cleanSymbol(
            pending.symbol
          ),

        direction:
          pending.direction,

        score:
          score.score,

        confidence:
          score.score,

        price,

        currentPrice:
          price,

        livePrice:
          fmtPrice(
            price
          ),

        entry:
          trade.entry,

        giris:
          trade.entry,

        entryLow:
          trade.entryLow,

        entryHigh:
          trade.entryHigh,

        stop:
          trade.stop,

        sl:
          trade.stop,

        stopLoss:
          trade.stop,

        tp1:
          trade.tp1,

        tp2:
          trade.tp2,

        tp3:
          trade.tp3,

        rr:
          trade.rr,

        riskReward:
          '1:' +
          trade.rr.toFixed(2),

        rsi:
          Number(
            currentRsi.toFixed(1)
          ),

        volumeRatio:
          Number(
            pending.breakoutVolumeRatio.toFixed(2)
          ),

        level:
          fmtPrice(
            pending.level.price
          ),

        levelType:
          pending.direction ===
          'LONG'
            ? 'KIRILAN DİRENÇ'
            : 'KIRILAN DESTEK',

        timeframeLevel:
          has4 && has2
            ? '4H + 2H'
            : has4
              ? '4H'
              : '2H',

        trendBias:
          h4Trend,

        structure15m:
          m15Structure,

        h4Trend,

        h2Trend,

        m5Trend,

        breakoutTime:
          pending.breakoutTime,

        retestTime:
          retest.candle
            ? n(
                retest.candle[0]
              )
            : 0,

        confirmation5mTime:
          five.candle
            ? n(
                five.candle[0]
              )
            : 0,

        breakoutVolumeRatio:
          Number(
            pending
              .breakoutVolumeRatio
              .toFixed(2)
          ),

        reason:
          score.reasons
            .join(
              ' + '
            ),

        reasons:
          score.reasons,

        status:
          'GİRİŞ BEKLENİYOR',

        entryReady:
          false,

        signalSource:
          '4H + 2H BREAKOUT + 15M RETEST + 5M BONUS',

        signalAt:
          timestamp,

        timestamp,

        signalAge:
          0,

        ageSeconds:
          0,

        cooldownKey
      };


      signals.push(
        signal
      );


      pending.status =
        'SIGNAL_CREATED';


      STATE.pending.delete(
        pending.key
      );
    }


    return {

      analyzed:
        true,

      signals,

      watch: {

        symbol,

        score:
          coin.radarScore,

        price,

        h4Trend,

        nearbyLevel:
          allLevels.length
            ? fmtPrice(
                allLevels
                  .sort(
                    (
                      a,
                      b
                    ) =>
                      Math.abs(
                        price -
                        a.price
                      ) -
                      Math.abs(
                        price -
                        b.price
                      )
                  )[0]
                  .price
              )
            : null

      }

    };

  }
  catch (
    error
  ) {

    console.error(
      'ANALİZ HATASI',
      cleanSymbol(
        symbol
      ),
      error.message
    );


    return {

      analyzed:
        false,

      signals:
        []
    };
  }

}


/* =========================================================
   CANDIDATE BUILD
========================================================= */

function buildCandidates(
  rows
) {

  STATE.candidates =
    [...rows]
      .map(
        row => {

          const volumeScore =
            Math.min(
              35,
              Math.log10(
                Math.max(
                  row.volume,
                  1
                )
              ) * 4
            );

          const rangeScore =
            Math.min(
              25,
              row.range * 5
            );

          const momentumScore =
            Math.min(
              25,
              Math.abs(
                row.change
              ) * 5
            );

          const activityScore =
            Math.abs(
              row.change
            ) >= 2
              ? 15
              : 7;

          const radarScore =
            Math.round(
              Math.min(
                100,
                volumeScore +
                rangeScore +
                momentumScore +
                activityScore
              )
            );

          return {

            ...row,

            radarScore
          };
        }
      )
      .sort(
        (
          a,
          b
        ) =>
          b.radarScore -
          a.radarScore
      )
      .slice(
        0,
        CFG.CANDIDATES
      );


  STATE.stats.candidates =
    STATE.candidates.length;


  return STATE.candidates;

}


/* =========================================================
   MARKET
========================================================= */

async function calculateMarket(
  rows
) {

  const valid =
    rows.filter(
      row =>
        Number.isFinite(
          row.change
        )
    );


  const green =
    valid.filter(
      row =>
        row.change >
        0
    ).length;


  const red =
    valid.filter(
      row =>
        row.change <
        0
    ).length;


  const average =
    valid.length
      ? avg(
          valid.map(
            row =>
              row.change
          )
        )
      : 0;


  const breadth =
    valid.length
      ? (
          green /
          valid.length
        ) *
        100
      : 50;


  let btc =
    'NEUTRAL';


  let eth =
    'NEUTRAL';


  try {

    const btcMarket =
      findMarket(
        'BTCUSDT'
      );


    if (
      btcMarket
    ) {

      btc =
        trend(
          await getCandles(
            btcMarket.symbol,
            '1h',
            100
          )
        );
    }

  }
  catch (_) {}


  try {

    const ethMarket =
      findMarket(
        'ETHUSDT'
      );


    if (
      ethMarket
    ) {

      eth =
        trend(
          await getCandles(
            ethMarket.symbol,
            '1h',
            100
          )
        );
    }

  }
  catch (_) {}


  let label =
    'YATAY / KARIŞIK';


  let direction =
    'FLAT';


  if (
    breadth >= 62 &&
    average >= 0.35
  ) {

    label =
      'YÜKSELİŞ';

    direction =
      'LONG';

  }
  else if (
    breadth <= 38 &&
    average <= -0.35
  ) {

    label =
      'DÜŞÜŞ';

    direction =
      'SHORT';

  }


  STATE.market = {

    label,

    direction,

    breadth:
      Number(
        breadth.toFixed(1)
      ),

    green,

    red,

    average:
      Number(
        average.toFixed(2)
      ),

    btc,

    eth
  };

}


/* =========================================================
   RADAR
========================================================= */

async function runScan() {

  if (
    STATE.scanning
  ) {

    return;
  }


  STATE.scanning =
    true;


  STATE.lastError =
    '';


  STATE.stats.analyzed =
    0;


  STATE.stats.errors =
    0;


  const started =
    Date.now();


  try {

    if (
      !STATE.markets.length
    ) {

      await loadMarkets();

      console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
      );
    }


    /*
       500
    */

    STATE.universe =
      await getTickers();


    STATE.stats.universe =
      STATE.universe.length;


    /*
       MARKET
    */

    await calculateMarket(
      STATE.universe
    );


    /*
       500 → 150
    */

    buildCandidates(
      STATE.universe
    );


    /*
       150 → 40

       İlk 40 her tur analiz edilir.
       Böylece pending sinyaller zamanla
       kaybolmaz.
    */

    STATE.deep =
      STATE.candidates.slice(
        0,
        CFG.DEEP
      );


    STATE.stats.deep =
      STATE.deep.length;


    /*
       40 ANALİZ
    */

    const results =
      await mapLimit(
        STATE.deep,
        CFG.CONCURRENCY,
        async coin => {

          const result =
            await analyzeDeep(
              coin
            );

          STATE.stats.analyzed++;

          return result;

        }
      );


    /*
       WATCH bilgisi
    */

    for (
      const result
      of results
    ) {

      if (
        !result ||
        !result.watch
      ) {

        continue;
      }


      const item =
        STATE.deep.find(
          coin =>
            coin.symbol ===
            result.watch.symbol
        );


      if (
        item
      ) {

        item.nearbyLevel =
          result.watch.nearbyLevel;

        item.h4Trend =
          result.watch.h4Trend;
      }
    }


    /*
       SIGNAL
    */

    for (
      const result
      of results
    ) {

      if (
        !result ||
        !result.signals
      ) {

        continue;
      }


      for (
        const signal
        of result.signals
      ) {

        /*
           Aynı coin + yön
           tekrar tekrar oluşturulmasın.
        */

        const existing =
          [...STATE.signals.values()]
            .find(
              item =>
                item.symbol ===
                  signal.symbol &&
                item.direction ===
                  signal.direction
            );


        if (
          existing
        ) {

          continue;
        }


        if (
          STATE.signals.size >=
          CFG.MAX_SIGNALS
        ) {

          break;
        }


        STATE.signals.set(
          signal.id,
          signal
        );


        STATE.selected =
          signal.symbol;


        console.log(
          'SIGNAL |',
          cleanSymbol(
            signal.symbol
          ),
          '|',
          signal.direction,
          '| SCORE',
          signal.score,
          '|',
          signal.riskReward
        );
      }
    }


    cleanup();


    STATE.lastScan =
      Date.now();


    console.log(

      'RADAR tamamlandı | ' +

      'Universe=' +
      STATE.stats.universe +

      ' | Candidates=' +
      STATE.stats.candidates +

      ' | Deep=' +
      STATE.stats.deep +

      ' | Analiz=' +
      STATE.stats.analyzed +

      ' | Pending=' +
      STATE.pending.size +

      ' | SIGNAL=' +
      STATE.signals.size +

      ' | ERR=' +
      STATE.stats.errors +

      ' | ' +

      (
        (
          Date.now() -
          started
        ) /
        1000
      ).toFixed(1) +
      's'
    );


    /*
       Seçili coin için grafiği yenile.
    */

    try {

      await refreshChart(
        STATE.selected,
        STATE.selectedTf
      );

    } catch (
      error
    ) {

      console.error(
        'CHART REFRESH:',
        error.message
      );
    }


  }
  catch (
    error
  ) {

    STATE.lastError =
      error.message;


    console.error(
      'RADAR ERROR:',
      error.message
    );

  }
  finally {

    STATE.scanning =
      false;


    broadcast();
  }

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
    ]
    of STATE.signals
  ) {

    if (
      now -
      signal.signalAt >
      CFG.SIGNAL_TTL
    ) {

      STATE.signals.delete(
        id
      );
    }
  }


  for (
    const [
      key,
      pending
    ]
    of STATE.pending
  ) {

    if (
      now -
      pending.breakoutTime >
      CFG.RETEST_MIN
    ) {

      STATE.pending.delete(
        key
      );
    }
  }


  for (
    const [
      key,
      time
    ]
    of STATE.cooldowns
  ) {

    if (
      now -
      time >
      CFG.COOLDOWN
    ) {

      STATE.cooldowns.delete(
        key
      );
    }
  }


  STATE.stats.pending =
    STATE.pending.size;


  STATE.stats.signals =
    STATE.signals.size;

}


/* =========================================================
   LIVE SIGNAL
========================================================= */

async function updateLiveSignals() {

  if (
    !STATE.signals.size
  ) {

    return;
  }


  const tickers =
    await getTickers();


  const map =
    new Map(
      tickers.map(
        item =>
          [
            item.symbol,
            item.price
          ]
      )
    );


  const now =
    Date.now();


  for (
    const [
      id,
      signal
    ]
    of STATE.signals
  ) {

    const current =
      map.get(
        signal.symbol
      );


    if (
      current
    ) {

      signal.currentPrice =
        current;

      signal.livePrice =
        fmtPrice(
          current
        );

      signal.ageSeconds =
        Math.floor(
          (
            now -
            signal.signalAt
          ) /
          1000
        );


      signal.signalAge =
        signal.ageSeconds;


      if (
        signal.direction ===
        'LONG'
      ) {

        if (
          current <=
          signal.stop
        ) {

          signal.status =
            'STOP';

          STATE.cooldowns.set(
            signal.cooldownKey,
            now
          );

        }
        else if (
          current >=
          signal.tp3
        ) {

          signal.status =
            'TP3';

        }
        else if (
          current >=
          signal.tp2
        ) {

          signal.status =
            'TP2';

        }
        else if (
          current >=
          signal.tp1
        ) {

          signal.status =
            'TP1';

        }
        else if (
          current >=
            signal.entryLow &&
          current <=
            signal.entryHigh
        ) {

          signal.status =
            'GİRİŞ ALANI';

          signal.entryReady =
            true;

        }
        else {

          signal.status =
            'GİRİŞ BEKLENİYOR';
        }

      }
      else {

        if (
          current >=
          signal.stop
        ) {

          signal.status =
            'STOP';

          STATE.cooldowns.set(
            signal.cooldownKey,
            now
          );

        }
        else if (
          current <=
          signal.tp3
        ) {

          signal.status =
            'TP3';

        }
        else if (
          current <=
          signal.tp2
        ) {

          signal.status =
            'TP2';

        }
        else if (
          current <=
          signal.tp1
        ) {

          signal.status =
            'TP1';

        }
        else if (
          current >=
            signal.entryLow &&
          current <=
            signal.entryHigh
        ) {

          signal.status =
            'GİRİŞ ALANI';

          signal.entryReady =
            true;

        }
        else {

          signal.status =
            'GİRİŞ BEKLENİYOR';
        }
      }
    }


    if (
      signal.status ===
        'STOP' ||
      signal.status ===
        'TP3' ||
      now -
        signal.signalAt >
        CFG.SIGNAL_TTL
    ) {

      STATE.signals.delete(
        id
      );
    }
  }


  cleanup();

}


/* =========================================================
   CHART
========================================================= */

async function refreshChart(
  symbol,
  timeframe
) {

  const market =
    findMarket(
      symbol
    );


  if (
    !market
  ) {

    return;
  }


  let candles;


  if (
    timeframe ===
    '2h'
  ) {

    const h1 =
      await getCandles(
        market.symbol,
        '1h',
        CFG.CHART * 2
      );


    candles =
      aggregateCandles(
        h1,
        2
      );

  }
  else if (
    timeframe ===
    '4h'
  ) {

    const h1 =
      await getCandles(
        market.symbol,
        '1h',
        CFG.CHART * 4
      );


    candles =
      aggregateCandles(
        h1,
        4
      );

  }
  else {

    candles =
      await getCandles(
        market.symbol,
        timeframe,
        CFG.CHART
      );
  }


  const signal =
    [...STATE.signals.values()]
      .find(
        item =>
          item.symbol ===
          market.symbol
      ) ||
    null;


  STATE.selected =
    market.symbol;


  STATE.selectedTf =
    timeframe;


  STATE.chart = {

    symbol:
      market.symbol,

    timeframe,

    candles:
      candles || [],

    signal

  };

}


function aggregateCandles(
  candles,
  hours
) {

  if (
    !Array.isArray(candles)
  ) {

    return [];
  }


  const ms =
    hours *
    60 *
    60 *
    1000;


  const buckets =
    new Map();


  for (
    const candle
    of candles
  ) {

    const timestamp =
      n(
        candle[0]
      );


    if (
      !timestamp
    ) {

      continue;
    }


    const bucket =
      Math.floor(
        timestamp /
        ms
      ) *
      ms;


    if (
      !buckets.has(
        bucket
      )
    ) {

      buckets.set(
        bucket,
        [

          bucket,

          n(candle[1]),
          n(candle[2]),
          n(candle[3]),
          n(candle[4]),
          n(candle[5])

        ]
      );

    }
    else {

      const current =
        buckets.get(
          bucket
        );


      current[2] =
        Math.max(
          current[2],
          n(candle[2])
        );


      current[3] =
        Math.min(
          current[3],
          n(candle[3])
        );


      current[4] =
        n(
          candle[4]
        );


      current[5] +=
        n(
          candle[5]
        );
    }
  }


  return [
    ...buckets.values()
  ].sort(
    (
      a,
      b
    ) =>
      a[0] -
      b[0]
  );
}


/* =========================================================
   STATUS
========================================================= */

function publicSignal(
  signal
) {

  return {

    ...signal,

    symbol:
      cleanSymbol(
        signal.symbol
      ),

    marketSymbol:
      signal.symbol,

    ageSeconds:
      Math.floor(
        (
          Date.now() -
          signal.signalAt
        ) /
        1000
      )
  };

}


function getStatus() {

  return {

    success:
      true,

    engine:
      'SONNY AI TRADER FINAL v5.3',

    autoTrade:
      CFG.AUTO_TRADE,

    scanning:
      STATE.scanning,

    lastScan:
      STATE.lastScan,

    error:
      STATE.lastError,

    stats: {

      universe:
        STATE.stats.universe,

      candidates:
        STATE.stats.candidates,

      deep:
        STATE.stats.deep,

      analyzed:
        STATE.stats.analyzed,

      pending:
        STATE.pending.size,

      signals:
        STATE.signals.size,

      errors:
        STATE.stats.errors
    },

    market:
      STATE.market,

    signals:
      [
        ...STATE.signals.values()
      ]
      .sort(
        (
          a,
          b
        ) =>
          b.score -
          a.score
      )
      .slice(
        0,
        CFG.MAX_SIGNALS
      )
      .map(
        publicSignal
      ),

    pending:
      [
        ...STATE.pending.values()
      ]
      .slice(
        0,
        20
      )
      .map(
        pending => ({

          symbol:
            cleanSymbol(
              pending.symbol
            ),

          direction:
            pending.direction,

          level:
            fmtPrice(
              pending.level.price
            ),

          breakoutTime:
            pending.breakoutTime,

          breakoutVolume:
            pending.breakoutVolumeRatio,

          status:
            pending.status
        })
      ),

    watchlist:
      STATE.deep.map(
        coin => ({

          symbol:
            cleanSymbol(
              coin.symbol
            ),

          score:
            coin.radarScore,

          price:
            coin.price,

          volume24h:
            coin.volume,

          change24h:
            coin.change,

          level:
            coin.nearbyLevel ||
            null,

          trend:
            coin.h4Trend ||
            'NEUTRAL'
        })
      ),

    chart: {

      symbol:
        STATE.chart.symbol,

      timeframe:
        STATE.chart.timeframe,

      candles:
        STATE.chart.candles,

      signal:
        STATE.chart.signal
          ? publicSignal(
              STATE.chart.signal
            )
          : null
    }
  };

}


/* =========================================================
   BROADCAST
========================================================= */

function broadcast() {

  const payload =
    JSON.stringify({

      type:
        'snapshot',

      data:
        getStatus()

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

      }
      catch (_) {}
    }
  }
}


wss.on(
  'connection',
  ws => {

    try {

      ws.send(
        JSON.stringify({

          type:
            'snapshot',

          data:
            getStatus()

        })
      );

    }
    catch (_) {}

  }
);


/* =========================================================
   API
========================================================= */

app.get(
  '/api/status',
  (
    req,
    res
  ) => {

    res.json(
      getStatus()
    );

  }
);


app.get(
  '/api/signals',
  (
    req,
    res
  ) => {

    const data =
      getStatus();


    res.json({

      success:
        true,

      signals:
        data.signals,

      pending:
        data.pending,

      stats:
        data.stats,

      market:
        data.market

    });

  }
);


app.get(
  '/api/scalp-radar',
  (
    req,
    res
  ) => {

    res.json(
      getStatus()
    );

  }
);


app.get(
  '/api/scan',
  (
    req,
    res
  ) => {

    if (
      STATE.scanning
    ) {

      return res.json({

        success:
          false,

        message:
          'Tarama zaten devam ediyor.'

      });
    }


    runScan();


    res.json({

      success:
        true,

      message:
        'Tarama başlatıldı.'

    });

  }
);


app.get(
  '/health',
  (
    req,
    res
  ) => {

    res.json({

      ok:
        true,

      service:
        'Sonny AI Trader FINAL v5.3',

      uptime:
        process.uptime(),

      scanning:
        STATE.scanning,

      lastScan:
        STATE.lastScan,

      stats:
        getStatus().stats,

      error:
        STATE.lastError

    });

  }
);


/* =========================================================
   CHART API
========================================================= */

app.get(
  '/api/chart',
  async (
    req,
    res
  ) => {

    try {

      const requestedSymbol =
        req.query.symbol ||
        STATE.selected;


      const market =
        findMarket(
          requestedSymbol
        );


      if (
        !market
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              'Coin bulunamadı.'

          });
      }


      const allowed = [

        '5m',
        '15m',
        '1h',
        '2h',
        '4h'

      ];


      const requestedTimeframe =
        String(
          req.query.timeframe ||
          '15m'
        );


      const timeframe =
        allowed.includes(
          requestedTimeframe
        )
          ? requestedTimeframe
          : '15m';


      await refreshChart(
        market.symbol,
        timeframe
      );


      const chart =
        STATE.chart;


      res.json({

        success:
          true,

        symbol:
          cleanSymbol(
            chart.symbol
          ),

        ccxtSymbol:
          chart.symbol,

        timeframe:
          chart.timeframe,

        price:
          chart.candles.length
            ? n(
                chart.candles[
                  chart.candles.length -
                  1
                ][4]
              )
            : 0,

        candles:
          chart.candles.map(
            candle => ({

              time:
                n(
                  candle[0]
                ),

              open:
                n(
                  candle[1]
                ),

              high:
                n(
                  candle[2]
                ),

              low:
                n(
                  candle[3]
                ),

              close:
                n(
                  candle[4]
                ),

              volume:
                n(
                  candle[5]
                )

            })
          ),

        signal:
          chart.signal
            ? publicSignal(
                chart.signal
              )
            : null

      });

    }
    catch (
      error
    ) {

      console.error(
        'CHART ERROR:',
        error.message
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message

        });
    }
  }
);


/* =========================================================
   EMBEDDED FRONTEND
========================================================= */

const HTML =
String.raw`<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
SONNY AI TRADER FINAL
</title>

<style>

*{
box-sizing:border-box;
}

html,
body{
margin:0;
width:100%;
height:100%;
background:#070a0f;
color:#eef3f8;
font-family:
Arial,
Helvetica,
sans-serif;
}

body{
overflow:hidden;
}

.app{
width:100%;
height:100vh;
display:grid;
grid-template-columns:
245px
minmax(0,1fr)
285px;
}

.side{
background:#0b0f16;
border-right:
1px solid #202936;
overflow:auto;
padding:12px;
}

.brand{
font-size:19px;
font-weight:900;
}

.brand small{
display:block;
color:#718096;
font-size:9px;
margin-top:4px;
}

.stats{
display:flex;
gap:7px;
margin-top:10px;
}

.k{
flex:1;
background:#0f151e;
border:1px solid #202b39;
border-radius:6px;
padding:7px;
text-align:center;
}

.k b{
display:block;
font-size:14px;
}

.k span{
color:#718096;
font-size:8px;
}

.cards{
display:flex;
flex-direction:column;
gap:7px;
margin-top:10px;
}

.card{
background:#0f151e;
border:1px solid #202b39;
border-left:3px solid #13e0a2;
border-radius:8px;
padding:10px;
cursor:pointer;
}

.card.short{
border-left-color:#ff5d6d;
}

.card.active{
border-color:#4776ff;
box-shadow:
0 0 0 1px #244a9c;
}

.top{
display:flex;
justify-content:space-between;
align-items:center;
}

.coin{
font-size:13px;
font-weight:900;
}

.badge{
font-size:9px;
font-weight:900;
padding:3px 6px;
border-radius:4px;
}

.badge.long{
color:#13e0a2;
background:#103425;
}

.badge.short{
color:#ff5d6d;
background:#35131b;
}

.cp{
font-size:18px;
font-weight:900;
margin-top:7px;
}

.meta{
font-size:9px;
color:#718096;
margin-top:6px;
}

.main{
min-width:0;
display:flex;
flex-direction:column;
}

.head{
height:68px;
border-bottom:
1px solid #202936;
padding:
0 15px;
display:flex;
align-items:center;
justify-content:space-between;
gap:10px;
}

.title{
font-size:18px;
font-weight:900;
}

.sub{
font-size:9px;
color:#718096;
margin-top:4px;
}

.pill{
font-size:9px;
color:#13e0a2;
border:1px solid #0b684a;
background:#073323;
padding:7px 10px;
border-radius:18px;
}

.work{
flex:1;
min-height:0;
display:grid;
grid-template-columns:
minmax(0,1fr)
270px;
}

.chartwrap{
position:relative;
min-width:0;
min-height:0;
}

.toolbar{
position:absolute;
left:15px;
right:15px;
top:12px;
display:flex;
justify-content:space-between;
align-items:center;
z-index:5;
pointer-events:none;
}

.chartname{
font-size:12px;
font-weight:900;
}

.tf{
display:flex;
gap:4px;
pointer-events:auto;
}

.tf button{
background:#101722;
color:#8995a6;
border:
1px solid #273241;
border-radius:5px;
padding:5px 8px;
font-size:9px;
cursor:pointer;
}

.tf button.active{
color:#fff;
background:#17233b;
border-color:#4776ff;
}

canvas{
width:100%;
height:100%;
display:block;
}

.right{
background:#0b0f16;
border-left:
1px solid #202936;
padding:12px;
overflow:auto;
}

.box{
background:#0f151e;
border:
1px solid #202b39;
border-radius:8px;
padding:12px;
margin-bottom:10px;
}

.label{
font-size:9px;
font-weight:900;
color:#7e899a;
}

.market{
font-size:20px;
font-weight:900;
margin-top:6px;
color:#d5dce5;
}

.market.up{
color:#13e0a2;
}

.market.down{
color:#ff5d6d;
}

.kpi{
display:grid;
grid-template-columns:
1fr
1fr;
gap:6px;
margin-top:9px;
}

.kpi div{
background:#0a1017;
padding:8px;
border-radius:6px;
}

.kpi span{
display:block;
font-size:8px;
color:#6e7b8e;
}

.kpi b{
font-size:12px;
}

.signalTitle{
font-size:14px;
font-weight:900;
margin-top:6px;
}

.longtxt{
color:#13e0a2;
}

.shorttxt{
color:#ff5d6d;
}

.detailGrid{
display:grid;
grid-template-columns:
1fr
1fr;
gap:6px;
margin-top:9px;
}

.detail{
background:#0a1017;
padding:8px;
border-radius:6px;
}

.detail span{
display:block;
font-size:8px;
color:#69778a;
}

.detail b{
display:block;
margin-top:3px;
font-size:11px;
}

.green{
color:#13e0a2;
}

.red{
color:#ff5d6d;
}

.blue{
color:#55a6ff;
}

.pending{
font-size:9px;
}

.pendingItem{
background:#0a1017;
border-left:
2px solid #f4c84a;
padding:7px;
margin-bottom:5px;
border-radius:4px;
}

.empty{
color:#69778a;
font-size:10px;
line-height:1.5;
}

.scan{
width:100%;
border:0;
background:#17233b;
color:#fff;
padding:9px;
border-radius:7px;
cursor:pointer;
margin-top:10px;
font-weight:800;
}

@media(max-width:900px){

.app{
grid-template-columns:
200px
minmax(0,1fr);
}

.right{
display:none;
}

}

@media(max-width:650px){

body{
overflow:auto;
}

.app{
display:block;
height:auto;
min-height:100vh;
}

.side{
border-right:0;
border-bottom:
1px solid #202936;
max-height:220px;
}

.cards{
flex-direction:row;
overflow-x:auto;
}

.card{
min-width:165px;
}

.main{
min-height:
calc(100vh - 220px);
}

.head{
height:50px;
padding:0 9px;
}

.title{
font-size:15px;
}

.pill{
font-size:8px;
padding:6px;
}

.work{
display:block;
}

.chartwrap{
height:58vh;
min-height:340px;
}

}

</style>

</head>

<body>

<div class="app">


<!-- SOL -->

<aside class="side">

<div class="brand">

⚡ SONNY AI TRADER

<small>
FINAL v5.3 • BITGET FUTURES
</small>

</div>


<button
id="scan"
class="scan"
>
RADARI YENİLE
</button>


<div class="stats">

<div class="k">
<b id="radar">
0
</b>
<span>
RADAR
</span>
</div>

<div class="k">
<b id="candidate">
0
</b>
<span>
ADAY
</span>
</div>

<div class="k">
<b id="deep">
0
</b>
<span>
DERİN
</span>
</div>

</div>


<div
id="cards"
class="cards"
>

<div class="empty">
Teyit edilmiş sinyal yok.
</div>

</div>

</aside>


<!-- ORTA -->

<main class="main">


<header class="head">

<div>

<div class="title">

<span id="symbol">
BTCUSDT
</span>

•

<span id="tfText">
15M
</span>

</div>

<div
id="scanText"
class="sub"
>
Sistem hazırlanıyor...
</div>

</div>


<div class="pill">

● AUTO TRADE KAPALI

</div>

</header>


<section class="work">


<div class="chartwrap">


<div class="toolbar">

<div
id="chartName"
class="chartname"
>
BTCUSDT • 15M
</div>


<div class="tf">

<button
data-tf="5m"
>
5M
</button>

<button
data-tf="15m"
class="active"
>
15M
</button>

<button
data-tf="1h"
>
1H
</button>

<button
data-tf="2h"
>
2H
</button>

<button
data-tf="4h"
>
4H
</button>

</div>

</div>


<canvas
id="chart"
>
</canvas>


</div>


<!-- SAĞ -->

<aside class="right">


<div class="box">

<div class="label">
GENEL PİYASA
</div>


<div
id="market"
class="market"
>
YATAY / KARIŞIK
</div>


<div
id="marketInfo"
class="sub"
>
Analiz ediliyor...
</div>

</div>


<div class="box">

<div class="label">
AKTİF SCALP SİNYALİ
</div>


<div
id="active"
>
<div class="empty">
Henüz teyit edilmiş sinyal yok.
</div>
</div>

</div>


<div class="box">

<div class="label">
BEKLEYEN KIRILIM / RETEST
</div>


<div
id="pending"
class="pending"
>
<div class="empty">
Bekleyen setup yok.
</div>
</div>

</div>


</aside>

</section>

</main>

</div>


<script>

(function(){

'use strict';


const state = {

selected:
'BTC/USDT:USDT',

timeframe:
'15m',

candles:
[],

signal:
null

};


function $(id){

return document.getElementById(
id
);

}


function esc(value){

return String(
value == null
? ''
: value
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


function price(value){

const x =
Number(value);

if(
!Number.isFinite(x)
){

return '-';

}

if(
x >= 1000
){

return x.toFixed(2);

}

if(
x >= 100
){

return x.toFixed(3);

}

if(
x >= 1
){

return x.toFixed(5);

}

if(
x >= 0.01
){

return x.toFixed(7);

}

if(
x >= 0.0001
){

return x.toFixed(8);

}

return x.toFixed(10);

}


function normalizeCandles(
items
){

return (items || [])

.map(
function(item){

if(
Array.isArray(item)
){

return {

time:
Number(item[0]),

open:
Number(item[1]),

high:
Number(item[2]),

low:
Number(item[3]),

close:
Number(item[4]),

volume:
Number(item[5] || 0)

};

}


return {

time:
Number(item.time),

open:
Number(item.open),

high:
Number(item.high),

low:
Number(item.low),

close:
Number(item.close),

volume:
Number(item.volume || 0)

};

}
)

.filter(
function(item){

return (

Number.isFinite(
item.time
)

&&
Number.isFinite(
item.open
)

&&
Number.isFinite(
item.high
)

&&
Number.isFinite(
item.low
)

&&
Number.isFinite(
item.close
)

);

}
)

.sort(
function(a,b){

return a.time-b.time;

}
);

}


/* =====================================================
   STATUS
===================================================== */

function render(
data
){

const stats =
data.stats || {};


$('radar')
.textContent =
stats.universe || 0;


$('candidate')
.textContent =
stats.candidates || 0;


$('deep')
.textContent =
stats.deep || 0;


$('scanText')
.textContent =

data.lastScan

?

'Son tarama: ' +
new Date(
data.lastScan
)
.toLocaleTimeString(
'tr-TR'
)

:

'Tarama bekleniyor...';


const market =
data.market || {};


$('market')
.textContent =
market.label ||
'YATAY / KARIŞIK';


$('market')
.className =
'market ' +

(
market.direction ===
'LONG'
?
'up'
:
market.direction ===
'SHORT'
?
'down'
:
''
);


$('marketInfo')
.innerHTML =

'Breadth %' +
esc(
market.breadth
) +

' • Yeşil ' +
esc(
market.green
) +

' • Kırmızı ' +
esc(
market.red
) +

'<br>Ortalama ' +
esc(
market.average
) +
'%' +

'<br>BTC 1H ' +
esc(
market.btc
) +

' • ETH 1H ' +
esc(
market.eth
);


/* SIGNAL */

const signals =
data.signals || [];


const cards =
$('cards');


cards.innerHTML =
'';


if(
!signals.length
){

cards.innerHTML =

'<div class="empty">'+
'Teyit edilmiş sinyal yok.'+
'</div>';

}
else{

signals.forEach(
function(signal){

const card =
document.createElement(
'div'
);


card.className =

'card ' +

(
signal.direction ===
'SHORT'
?
'short'
:
''
) +

(
signal.marketSymbol ===
state.selected
?
' active'
:
''
);


card.innerHTML =

'<div class="top">'+

'<div class="coin">'+
esc(
signal.symbol
)+
'</div>'+

'<div class="badge '+
(
signal.direction ===
'LONG'
?
'long'
:
'short'
)+
'">'+
esc(
signal.direction
)+
'</div>'+

'</div>'+

'<div class="cp">'+
price(
signal.currentPrice ||
signal.entry
)+
'</div>'+

'<div class="meta">'+
'● GİRİŞ ALANI • GÜÇ '+
esc(
signal.score
)+
'/100'+
'</div>';


card.onclick =
function(){

state.selected =
signal.marketSymbol;

state.signal =
signal;

renderActive(
signal
);

loadChart();

};


cards.appendChild(
card
);

}
);


}


/* SEÇİLİ */

const selected =
signals.find(
function(signal){

return (
signal.marketSymbol ===
state.selected
);

}
)
||
signals[0]
||
null;


if(
selected
){

state.selected =
selected.marketSymbol;

state.signal =
selected;

renderActive(
selected
);

}


renderPending(
data.pending || []
);


if(
data.chart
){

state.candles =
normalizeCandles(
data.chart.candles
);


if(
data.chart.symbol
){

state.selected =
data.chart.symbol;

}


if(
data.chart.timeframe
){

state.timeframe =
data.chart.timeframe;

}


if(
data.chart.signal
){

state.signal =
data.chart.signal;

}


updateHeader();

drawChart();

}

}


/* =====================================================
   ACTIVE
===================================================== */

function renderActive(
signal
){

if(
!signal
){

$('active').innerHTML =

'<div class="empty">'+
'Henüz teyit edilmiş sinyal yok.'+
'</div>';

return;

}


const cls =
signal.direction ===
'LONG'
?
'longtxt'
:
'shorttxt';


$('active').innerHTML =

'<div class="signalTitle '+
cls+
'">'+

esc(
signal.symbol
)+

' • '+

esc(
signal.direction
)+

'</div>'+

'<div class="detailGrid">'+

detail(
'GİRİŞ',
price(
signal.entryLow
)+
' — '+
price(
signal.entryHigh
),
'green'
)+

detail(
'STOP',
price(
signal.stop
),
'red'
)+

detail(
'TP1',
price(
signal.tp1
),
'blue'
)+

detail(
'TP2',
price(
signal.tp2
),
'blue'
)+

detail(
'TP3',
price(
signal.tp3
),
'blue'
)+

detail(
'R:R',
'1:'+
esc(
signal.rr
),
''
)+

'</div>'+

'<div class="sub" style="margin-top:9px">'+

esc(
signal.status ||
'GİRİŞ BEKLENİYOR'
)+

' • SKOR '+
esc(
signal.score
)+
'/100'+

'<br>RSI '+
esc(
signal.rsi
)+

' • VOL '+
esc(
signal.volumeRatio
)+
'x'+

'<br>'+
esc(
signal.reason ||
''
)+

'</div>';

}


function detail(
label,
value,
color
){

return (

'<div class="detail">'+

'<span>'+
label+
'</span>'+

'<b class="'+
color+
'">'+
esc(
value
)+
'</b>'+

'</div>'

);

}


/* =====================================================
   PENDING
===================================================== */

function renderPending(
items
){

const box =
$('pending');


if(
!items.length
){

box.innerHTML =

'<div class="empty">'+
'Bekleyen setup yok.'+
'</div>';

return;

}


box.innerHTML =
items.map(
function(item){

return (

'<div class="pendingItem">'+

'<b>'+
esc(
item.symbol
)+
' '+
esc(
item.direction
)+
'</b>'+

'<br>Seviye '+
esc(
item.level
)+

' • '+
esc(
item.status
)+

'</div>'

);

}
).join('');

}


/* =====================================================
   HEADER
===================================================== */

function updateHeader(){

const sym =
String(
state.selected
)
.replace(
'/USDT:USDT',
'USDT'
);


$('symbol')
.textContent =
sym;


$('tfText')
.textContent =
state.timeframe.toUpperCase();


$('chartName')
.textContent =
sym +
' • '+
state.timeframe.toUpperCase();

}


/* =====================================================
   CHART
===================================================== */

async function loadChart(){

try{

const response =
await fetch(

'/api/chart?symbol='+
encodeURIComponent(
state.selected
)+

'&timeframe='+
encodeURIComponent(
state.timeframe
),

{
cache:
'no-store'
}

);


if(
!response.ok
){

throw new Error(
'CHART '+
response.status
);

}


const data =
await response.json();


if(
!data.success
){

return;

}


state.candles =
normalizeCandles(
data.candles
);


state.signal =
data.signal ||
state.signal ||
null;


state.selected =
data.ccxtSymbol ||
state.selected;


state.timeframe =
data.timeframe ||
state.timeframe;


updateHeader();


drawChart();

}
catch(error){

console.error(
'Chart API hatası:',
error
);

}

}


/* =====================================================
   CANVAS
===================================================== */

function drawChart(){

const canvas =
$('chart');


const rect =
canvas.getBoundingClientRect();


const dpr =
window.devicePixelRatio ||
1;


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
'#070b11';


ctx.fillRect(
0,
0,
width,
height
);


if(
!state.candles.length
){

ctx.fillStyle =
'#657286';

ctx.font =
'12px Arial';

ctx.fillText(
'Grafik verisi bekleniyor...',
20,
50
);

return;

}


const candles =
state.candles;


const signal =
state.signal;


const values =
[];


candles.forEach(
function(
candle
){

values.push(
Number(
candle.high
)
);

values.push(
Number(
candle.low
)
);

});


if(
signal
){

[
signal.entryLow,
signal.entryHigh,
signal.entry,
signal.stop,
signal.tp1,
signal.tp2,
signal.tp3
]
.forEach(
function(value){

if(
Number.isFinite(
Number(value)
)
){

values.push(
Number(value)
);

}

}
);

}


let min =
Math.min(
...values
);


let max =
Math.max(
...values
);


const range =
max -
min;


const pad =
range *
0.07 ||
1;


min -=
pad;


max +=
pad;


const left =
55;


const right =
85;


const top =
20;


const bottom =
25;


const plotWidth =
Math.max(
1,
width -
left -
right
);


const plotHeight =
Math.max(
1,
height -
top -
bottom
);


function y(
value
){

return (

top +

(
max -
Number(value)
) /
(
max -
min
) *
plotHeight

);

}


function x(
index
){

return (

left +

index *
plotWidth /
Math.max(
1,
candles.length -
1
)

);

}


/* GRID */

ctx.strokeStyle =
'#182330';


ctx.lineWidth =
1;


for(
let i=0;
i<=5;
i++
){

const gy =
top +
plotHeight *
i /
5;


ctx.beginPath();

ctx.moveTo(
left,
gy
);

ctx.lineTo(
width -
right,
gy
);

ctx.stroke();


const pv =
max -
(
max -
min
) *
i /
5;


ctx.fillStyle =
'#607083';


ctx.font =
'9px Arial';


ctx.fillText(
price(pv),
5,
gy+3
);

}


/* CANDLES */

const step =
plotWidth /
Math.max(
1,
candles.length -
1
);


const body =
Math.max(
2,
Math.min(
10,
step *
0.65
)
);


candles.forEach(
function(
candle,
index
){

const xx =
x(index);


const open =
Number(
candle.open
);


const high =
Number(
candle.high
);


const low =
Number(
candle.low
);


const close =
Number(
candle.close
);


const up =
close >=
open;


const color =
up
?
'#13e0a2'
:
'#ff4d6d';


ctx.strokeStyle =
color;


ctx.fillStyle =
color;


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


const yo =
y(open);


const yc =
y(close);


ctx.fillRect(

xx -
body /
2,

Math.min(
yo,
yc
),

body,

Math.max(
1,
Math.abs(
yc -
yo
)
)

);

}
);


/* ENTRY ZONE */

if(
signal &&
Number.isFinite(
Number(
signal.entryLow
)
) &&
Number.isFinite(
Number(
signal.entryHigh
)
)
){

const a =
y(
signal.entryLow
);


const b =
y(
signal.entryHigh
);


ctx.fillStyle =
'rgba(19,224,162,.10)';


ctx.fillRect(

left,

Math.min(
a,
b
),

plotWidth,

Math.abs(
a -
b
)

);

}


/* LEVEL */

if(
signal
){

drawLevel(
signal.stop,
'#ff5d6d',
'STOP'
);


drawLevel(
signal.entry,
'#13e0a2',
'GİRİŞ'
);


drawLevel(
signal.tp1,
'#4da3ff',
'TP1'
);


drawLevel(
signal.tp2,
'#4da3ff',
'TP2'
);


drawLevel(
signal.tp3,
'#4da3ff',
'TP3'
);

}


function drawLevel(
value,
color,
label
){

const v =
Number(value);


if(
!Number.isFinite(v)
){

return;

}


const yy =
y(v);


ctx.strokeStyle =
color;


ctx.setLineDash(
[
6,
5
]
);


ctx.beginPath();

ctx.moveTo(
left,
yy
);

ctx.lineTo(
width -
right,
yy
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
price(v),

width -
right +
5,

yy +
3

);

}

}


/* =====================================================
   TIMEFRAME
===================================================== */

document
.querySelectorAll(
'[data-tf]'
)
.forEach(
function(
button
){

button.onclick =
function(){

document
.querySelectorAll(
'[data-tf]'
)
.forEach(
function(
item
){

item.classList.remove(
'active'
);

}
);


button.classList.add(
'active'
);


state.timeframe =
button.dataset.tf;


loadChart();

};

}
);


/* =====================================================
   MANUAL SCAN
===================================================== */

$('scan')
.onclick =
function(){

fetch(
'/api/scan'
)
.catch(
function(){}
);

};


/* =====================================================
   WEBSOCKET
===================================================== */

function connect(){

const protocol =
location.protocol ===
'https:'
?
'wss://'
:
'ws://';


const socket =
new WebSocket(
protocol +
location.host
);


socket.onopen =
function(){

$('scanText')
.textContent =
'Sistem aktif • canlı bağlantı';

};


socket.onmessage =
function(
event
){

try{

const message =
JSON.parse(
event.data
);


if(
message.type ===
'snapshot'
){

render(
message.data
);

}

}
catch(error){

console.error(
'WS parse:',
error
);

}

};


socket.onclose =
function(){

setTimeout(
connect,
2500
);

};


socket.onerror =
function(){

socket.close();

};

}


connect();


/* =====================================================
   INITIAL
===================================================== */

fetch(
'/api/status',
{
cache:
'no-store'
}
)
.then(
function(
response
){

return response.json();

}
)
.then(
function(
data
){

render(
data
);

}
)
.catch(
function(
error
){

console.error(
'STATUS:',
error
);

});


/* =====================================================
   REFRESH
===================================================== */

setInterval(
function(){

loadChart();

},
15000
);


window.addEventListener(
'resize',
function(){

drawChart();

}
);

})();

</script>

</body>

</html>`;


/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  (
    req,
    res
  ) => {

    res
      .type(
        'html'
      )
      .send(
        HTML
      );
  }
);


/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
  'unhandledRejection',
  error => {

    STATE.lastError =
      error?.message ||
      String(error);

    console.error(
      'UNHANDLED:',
      error
    );

  }
);


process.on(
  'uncaughtException',
  error => {

    STATE.lastError =
      error?.message ||
      String(error);

    console.error(
      'UNCAUGHT:',
      error
    );

  }
);


/* =========================================================
   SERVER
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  async () => {

    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      '🚀 SONNY AI TRADER FINAL v5.3'
    );

    console.log(
      '📡 Bitget USDT Futures'
    );

    console.log(
      '🛰️ Radar: ' +
      CFG.RADAR +
      ' Coin'
    );

    console.log(
      '🎯 Candidate: ' +
      CFG.CANDIDATES
    );

    console.log(
      '🔬 Deep: ' +
      CFG.DEEP
    );

    console.log(
      '📊 4H + 2H → 15M Breakout → Retest → 5M'
    );

    console.log(
      '💰 Minimum Volume: $' +
      CFG.MIN_VOLUME_USDT
    );

    console.log(
      '🎯 Minimum R:R: 1:' +
      CFG.MIN_RR
    );

    console.log(
      '⏱️ Scan: 60 sec'
    );

    console.log(
      '🤖 Auto Trade: KAPALI'
    );

    console.log(
      '🌐 Port: ' +
      PORT
    );

    console.log(
      '=============================================='
    );


    try {

      await loadMarkets();


      console.log(
        'MARKETS | Gerçek USDT perpetual=' +
        STATE.markets.length
      );


      await runScan();

    }
    catch (
      error
    ) {

      STATE.lastError =
        error.message;


      console.error(
        'BOOT ERROR:',
        error.message
      );

    }


    setInterval(
      function(){

        runScan()
          .catch(
            error => {

              STATE.lastError =
                error.message;

              console.error(
                'SCAN LOOP:',
                error.message
              );

            }
          );

      },
      CFG.SCAN_MS
    );


    setInterval(
      function(){

        updateLiveSignals()
          .then(
            broadcast
          )
          .catch(
            error => {

              console.error(
                'LIVE LOOP:',
                error.message
              );

            }
          );

      },
      CFG.LIVE_MS
    );


    setInterval(
      function(){

        cleanup();

        broadcast();

      },
      5000
    );

  }
);
