const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

/* =========================================================
   SONNY AI TRADER V9

   4H DESTEK / DİRENÇ
        ↓
   2H DOĞRULAMA
        ↓
   15M YAPI TETİĞİ
        ↓
   LONG / SHORT
        ↓
   GİRİŞ / STOP / TP

   Canlı fiyat: 5 saniye
   Yeni tarama: 60 saniye
   TradingView: BINANCE

   Hazırlanan fırsatlar YOK
   Kaçan sinyaller YOK
   Performans paneli YOK
   ========================================================= */

const CFG = {
  SCAN_MS: 60000,
  LIVE_MS: 5000,

  MARKET_LIMIT: 762,
  FAST_RADAR: 600,
  ANALYZE_LIMIT: 250,

  MIN_VOLUME: 2000000,

  H4_LIMIT: 120,
  H2_LIMIT: 120,
  M15_LIMIT: 160,

  H4_LOOKBACK: 70,
  H2_LOOKBACK: 70,

  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,

  CLUSTER_PCT: 0.0045,
  ZONE_PCT: 0.006,

  ATR_PERIOD: 14,
  STOP_ATR_MULT: 0.65,

  MAX_SIGNALS: 8,

  SIGNAL_MAX_AGE_MS:
    2 * 60 * 60 * 1000,

  COOLDOWN_MS:
    20 * 60 * 1000,

  BATCH: 6,
  BATCH_DELAY_MS: 120
};


/* =========================================================
   STATE
   ========================================================= */

let market = [];
let resultCache = null;

let scanning = false;
let lastScan = null;
let lastError = null;

const activeSignals = new Map();
const cooldowns = new Map();


/* =========================================================
   GENERAL
   ========================================================= */

function log(message) {
  console.log(
    '[' +
    new Date().toISOString() +
    '] ' +
    message
  );
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function num(value, decimals = 6) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Number(
    n.toFixed(decimals)
  );
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function pctDistance(a, b) {
  if (!b) {
    return 999;
  }

  return Math.abs(
    (a - b) / b
  ) * 100;
}


/* =========================================================
   BITGET API
   ========================================================= */

async function api(
  path,
  params = {}
) {
  const url =
    new URL(BASE + path);

  Object.entries(params).forEach(
    ([key, value]) => {

      if (
        value !== undefined &&
        value !== null &&
        value !== ''
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }

    }
  );

  let lastError = null;

  for (
    let attempt = 0;
    attempt < 4;
    attempt++
  ) {

    try {

      const response =
        await fetch(url);

      const text =
        await response.text();

      if (!response.ok) {

        if (
          response.status === 429
        ) {

          await sleep(
            900 *
            (attempt + 1)
          );

          continue;
        }

        throw new Error(
          'Bitget HTTP ' +
          response.status +
          ' - ' +
          text.slice(0, 220)
        );
      }

      const json =
        JSON.parse(text);

      if (
        json.code !== '00000'
      ) {

        throw new Error(
          'Bitget ' +
          json.code +
          ' - ' +
          (
            json.msg ||
            'Unknown error'
          )
        );
      }

      return json.data;

    } catch (error) {

      lastError = error;

      if (
        attempt < 3
      ) {

        await sleep(
          350 *
          (attempt + 1)
        );
      }
    }
  }

  throw lastError;
}


/* =========================================================
   CANDLE PARSER
   ========================================================= */

function parseCandles(data) {

  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map(row => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }))
    .filter(
      x =>
        Number.isFinite(x.close) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low)
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}


async function getCandles(
  symbol,
  timeframe,
  limit
) {

  const data =
    await api(
      '/api/v2/mix/market/candles',
      {
        symbol,
        productType: PRODUCT,
        granularity: timeframe,
        limit
      }
    );

  return parseCandles(data);
}


/* =========================================================
   ATR
   ========================================================= */

function atr(
  candles,
  period = 14
) {

  if (
    !candles ||
    candles.length < period + 2
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    tr.push(
      Math.max(
        candles[i].high -
          candles[i].low,

        Math.abs(
          candles[i].high -
          candles[i - 1].close
        ),

        Math.abs(
          candles[i].low -
          candles[i - 1].close
        )
      )
    );
  }

  let value =
    tr
      .slice(0, period)
      .reduce(
        (a, b) =>
          a + b,
        0
      ) / period;

  for (
    let i = period;
    i < tr.length;
    i++
  ) {

    value =
      (
        value *
        (period - 1) +
        tr[i]
      ) /
      period;
  }

  return Number.isFinite(value)
    ? value
    : null;
}


/* =========================================================
   EMA
   ========================================================= */

function ema(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  let e =
    values
      .slice(0, period)
      .reduce(
        (a, b) =>
          a + b,
        0
      ) /
    period;

  const k =
    2 /
    (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    e =
      values[i] * k +
      e * (1 - k);
  }

  return e;
}


/* =========================================================
   VOLUME
   ========================================================= */

function volumeRatio(candles) {

  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 21
  ) {
    return 1;
  }

  const last =
    closed.at(-1);

  const average =
    closed
      .slice(-21, -1)
      .reduce(
        (sum, x) =>
          sum + x.volume,
        0
      ) /
    20;

  if (!average) {
    return 1;
  }

  return (
    last.volume /
    average
  );
}


/* =========================================================
   MARKET DIRECTION
   ========================================================= */

function marketDirection() {

  const btc =
    market.find(
      x =>
        x.symbol === 'BTCUSDT'
    );

  const eth =
    market.find(
      x =>
        x.symbol === 'ETHUSDT'
    );

  const list =
    [
      btc,
      eth
    ].filter(Boolean);

  if (!list.length) {

    return {
      direction: 'NEUTRAL',
      label: 'PİYASA BEKLENİYOR',
      reason: 'Piyasa verisi bekleniyor.'
    };
  }

  const average =
    list.reduce(
      (sum, x) =>
        sum + x.change24h,
      0
    ) /
    list.length;

  if (
    average > 0.75
  ) {

    return {
      direction: 'LONG',
      label: 'PİYASA YUKARI',
      reason: 'BTC / ETH pozitif.'
    };
  }

  if (
    average < -0.75
  ) {

    return {
      direction: 'SHORT',
      label: 'PİYASA AŞAĞI',
      reason: 'BTC / ETH negatif.'
    };
  }

  return {
    direction: 'NEUTRAL',
    label: 'PİYASA YATAY',
    reason: 'BTC / ETH yönü net değil.'
  };
}


/* =========================================================
   DISCOVERY
   ========================================================= */

async function discover() {

  const [
    contracts,
    tickers
  ] =
    await Promise.all([
      api(
        '/api/v2/mix/market/contracts',
        {
          productType: PRODUCT
        }
      ),

      api(
        '/api/v2/mix/market/tickers',
        {
          productType: PRODUCT
        }
      )
    ]);

  const valid =
    new Set(
      (
        contracts ||
        []
      )
        .filter(
          c =>
            c.symbolType ===
              'perpetual' &&
            c.symbolStatus ===
              'normal' &&
            c.quoteCoin ===
              'USDT'
        )
        .map(
          c =>
            c.symbol
        )
    );

  market =
    (
      tickers ||
      []
    )
      .filter(
        t =>
          valid.has(
            t.symbol
          )
      )
      .map(t => {

        const raw =
          Number(
            t.change24h
          ) || 0;

        return {
          symbol:
            t.symbol,

          price:
            Number(
              t.lastPr
            ),

          volume24h:
            Number(
              t.quoteVolume
            ) || 0,

          change24h:
            Math.abs(raw) <= 1
              ? raw * 100
              : raw
        };
      })
      .filter(
        x =>
          Number.isFinite(
            x.price
          ) &&
          x.volume24h >=
            CFG.MIN_VOLUME
      )
      .sort(
        (a, b) =>
          b.volume24h -
          a.volume24h
      )
      .slice(
        0,
        CFG.MARKET_LIMIT
      );

  log(
    'Discovery tamamlandı | Universe=' +
    market.length
  );
}


/* =========================================================
   4H / 2H SUPPORT RESISTANCE
   ========================================================= */

function pivotLevels(
  candles,
  lookback
) {

  const c =
    candles
      .slice(0, -1)
      .slice(-lookback);

  const supports = [];
  const resistances = [];

  const L =
    CFG.PIVOT_LEFT;

  const R =
    CFG.PIVOT_RIGHT;

  for (
    let i = L;
    i < c.length - R;
    i++
  ) {

    let isLow = true;
    let isHigh = true;

    for (
      let j = i - L;
      j <= i + R;
      j++
    ) {

      if (j === i) {
        continue;
      }

      if (
        c[j].low <=
        c[i].low
      ) {
        isLow = false;
      }

      if (
        c[j].high >=
        c[i].high
      ) {
        isHigh = false;
      }
    }

    if (isLow) {

      supports.push({
        level:
          c[i].low,

        time:
          c[i].time
      });
    }

    if (isHigh) {

      resistances.push({
        level:
          c[i].high,

        time:
          c[i].time
      });
    }
  }


  function cluster(items) {

    const sorted =
      items
        .slice()
        .sort(
          (a, b) =>
            a.level -
            b.level
        );

    const groups = [];

    for (
      const item of sorted
    ) {

      const last =
        groups.at(-1);

      if (
        !last ||
        Math.abs(
          item.level -
          last.center
        ) /
          last.center >
          CFG.CLUSTER_PCT
      ) {

        groups.push({
          values: [item],
          center:
            item.level
        });

      } else {

        last.values.push(
          item
        );

        last.center =
          last.values.reduce(
            (sum, x) =>
              sum + x.level,
            0
          ) /
          last.values.length;
      }
    }

    return groups.map(
      g => ({
        level:
          g.center,

        touches:
          g.values.length,

        firstTime:
          g.values[0].time,

        lastTime:
          g.values.at(-1).time
      })
    );
  }

  return {
    supports:
      cluster(supports),

    resistances:
      cluster(resistances)
  };
}


/* =========================================================
   4H + 2H ZONE
   ========================================================= */

function mergeZone(
  h4,
  h2,
  direction,
  price
) {

  const a =
    direction === 'LONG'
      ? h4.supports
      : h4.resistances;

  const b =
    direction === 'LONG'
      ? h2.supports
      : h2.resistances;

  const candidates = [];


  /*
   4H + 2H ortak bölge
  */

  for (
    const x of a
  ) {

    for (
      const y of b
    ) {

      const distance =
        pctDistance(
          x.level,
          y.level
        );

      if (
        distance <= 0.8
      ) {

        const level =
          (
            x.level +
            y.level
          ) / 2;

        const half =
          Math.max(
            level *
              CFG.ZONE_PCT /
              2,

            Math.abs(
              x.level -
              y.level
            ) / 2
          );

        candidates.push({
          level,

          low:
            level - half,

          high:
            level + half,

          h4Touches:
            x.touches,

          h2Touches:
            y.touches,

          overlap:
            true,

          distance:
            pctDistance(
              price,
              level
            )
        });
      }
    }
  }


  /*
   Sadece 4H bölgesi
  */

  const oneTf =
    a.map(x => {

      const half =
        x.level *
        CFG.ZONE_PCT /
        2;

      return {
        level:
          x.level,

        low:
          x.level - half,

        high:
          x.level + half,

        h4Touches:
          x.touches,

        h2Touches:
          0,

        overlap:
          false,

        distance:
          pctDistance(
            price,
            x.level
          )
      };
    });


  const all =
    [
      ...candidates,
      ...oneTf
    ]
      .filter(z =>
        direction === 'LONG'
          ? z.level <=
            price * 1.008
          : z.level >=
            price * 0.992
      );

  if (!all.length) {
    return null;
  }

  all.sort(
    (x, y) =>
      x.distance -
      y.distance ||
      (
        y.h4Touches +
        y.h2Touches
      ) -
      (
        x.h4Touches +
        x.h2Touches
      )
  );

  return all[0];
}


/* =========================================================
   OPPOSITE LEVEL
   ========================================================= */

function nearestOppositeLevel(
  sr,
  direction,
  level
) {

  const list =
    direction === 'LONG'
      ? sr.resistances
      : sr.supports;

  const valid =
    list.filter(
      x =>
        direction === 'LONG'
          ? x.level > level
          : x.level < level
    );

  valid.sort(
    (a, b) =>
      direction === 'LONG'
        ? a.level - b.level
        : b.level - a.level
  );

  return (
    valid[0] ||
    null
  );
}


/* =========================================================
   15M MARKET STRUCTURE
   ========================================================= */

function structure15(candles) {

  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 30
  ) {

    return {
      direction:
        'NEUTRAL',

      level:
        null,

      strength:
        0
    };
  }

  const closes =
    closed.map(
      x =>
        x.close
    );

  const e9 =
    ema(
      closes,
      9
    );

  const e21 =
    ema(
      closes,
      21
    );

  const recent =
    closed.slice(-12);

  const previous =
    closed.slice(-24, -12);

  const recentHigh =
    Math.max(
      ...recent.map(
        x =>
          x.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x =>
          x.low
      )
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        x =>
          x.high
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        x =>
          x.low
      )
    );

  const last =
    closed.at(-1);


  /*
   Güçlü LONG
  */

  if (
    e9 &&
    e21 &&
    e9 > e21 &&
    last.close >
      previousHigh
  ) {

    return {
      direction:
        'LONG',

      level:
        previousHigh,

      strength:
        100
    };
  }


  /*
   Güçlü SHORT
  */

  if (
    e9 &&
    e21 &&
    e9 < e21 &&
    last.close <
      previousLow
  ) {

    return {
      direction:
        'SHORT',

      level:
        previousLow,

      strength:
        100
    };
  }


  /*
   Orta LONG
  */

  if (
    recentHigh >
      previousHigh &&
    e9 &&
    e9 > e21 &&
    last.close >
      e9
  ) {

    return {
      direction:
        'LONG',

      level:
        previousHigh,

      strength:
        75
    };
  }


  /*
   Orta SHORT
  */

  if (
    recentLow <
      previousLow &&
    e9 &&
    e9 < e21 &&
    last.close <
      e9
  ) {

    return {
      direction:
        'SHORT',

      level:
        previousLow,

      strength:
        75
    };
  }


  return {
    direction:
      'NEUTRAL',

    level:
      null,

    strength:
      0
  };
}


/* =========================================================
   TRADE PLAN
   ========================================================= */

function makeTrade(
  m,
  direction,
  zone,
  structure,
  c4,
  c2,
  c15,
  sr4,
  sr2
) {

  const price =
    m.price;

  const level =
    zone.level;

  const atr4 =
    atr(
      c4,
      CFG.ATR_PERIOD
    ) ||
    Math.abs(
      c4.at(-2).high -
      c4.at(-2).low
    );

  const atr2 =
    atr(
      c2,
      CFG.ATR_PERIOD
    ) ||
    atr4;

  const vol =
    volumeRatio(
      c15
    );

  const zoneWidth =
    Math.max(
      zone.high -
        zone.low,

      level *
        0.002
    );

  const stopDistance =
    Math.max(
      zoneWidth * 1.15,

      atr2 *
        CFG.STOP_ATR_MULT
    );


  let entryLow;
  let entryHigh;
  let stop;


  /*
   LONG
  */

  if (
    direction === 'LONG'
  ) {

    entryLow =
      zone.low;

    entryHigh =
      zone.high;

    stop =
      zone.low -
      stopDistance;

  } else {

    /*
     SHORT
    */

    entryLow =
      zone.low;

    entryHigh =
      zone.high;

    stop =
      zone.high +
      stopDistance;
  }


  const risk =
    direction === 'LONG'
      ? level - stop
      : stop - level;

  if (
    !(risk > 0)
  ) {

    return null;
  }


  /*
   Karşıdaki önemli seviye
  */

  const opposite =
    nearestOppositeLevel(
      sr4,
      direction,
      level
    ) ||
    nearestOppositeLevel(
      sr2,
      direction,
      level
    );


  /*
   Başlangıç TP
  */

  const r1 =
    risk * 1.5;

  const r2 =
    risk * 2.2;

  const r3 =
    risk * 3.0;


  let tp1 =
    direction === 'LONG'
      ? level + r1
      : level - r1;

  let tp2 =
    direction === 'LONG'
      ? level + r2
      : level - r2;

  let tp3 =
    direction === 'LONG'
      ? level + r3
      : level - r3;


  /*
   Karşıdaki yapısal seviye
  */

  if (opposite) {

    const gap =
      Math.abs(
        opposite.level -
        level
      );

    if (
      gap >
      risk * 1.35
    ) {

      if (
        direction === 'LONG'
      ) {

        tp1 =
          Math.min(
            tp1,
            opposite.level
          );

        tp2 =
          Math.min(
            tp2,
            opposite.level +
              risk * 0.4
          );

      } else {

        tp1 =
          Math.max(
            tp1,
            opposite.level
          );

        tp2 =
          Math.max(
            tp2,
            opposite.level -
              risk * 0.4
          );
      }
    }
  }


  const proximity =
    pctDistance(
      price,
      level
    );

  if (
    proximity > 0.85
  ) {

    return null;
  }


  /*
   Kalite puanı.
   Bu bir kazanma olasılığı değildir.
  */

  const h4Strength =
    clamp(
      (
        zone.h4Touches ||
        1
      ) * 7,

      7,
      28
    );

  const h2Strength =
    zone.overlap
      ? 25
      : clamp(
          (
            zone.h2Touches ||
            0
          ) * 7,

          0,
          14
        );

  const trigger =
    structure.strength >= 100
      ? 30
      : 24;

  const nearBonus =
    proximity <= 0.25
      ? 10
      : proximity <= 0.5
        ? 7
        : 4;

  const volumeBonus =
    vol >= 1.25
      ? 5
      : 0;

  const score =
    clamp(
      Math.round(
        h4Strength +
        h2Strength +
        trigger +
        nearBonus +
        volumeBonus
      ),
      55,
      98
    );


  const now =
    Date.now();


  const signal = {

    id:
      m.symbol +
      '_' +
      direction +
      '_' +
      Math.round(
        level *
        100000000
      ),

    symbol:
      m.symbol,

    direction,

    score,

    price:
      num(
        price,
        8
      ),

    currentPrice:
      num(
        price,
        8
      ),

    level:
      num(
        level,
        8
      ),

    zoneLow:
      num(
        zone.low,
        8
      ),

    zoneHigh:
      num(
        zone.high,
        8
      ),

    entryLow:
      num(
        entryLow,
        8
      ),

    entryHigh:
      num(
        entryHigh,
        8
      ),

    stop:
      num(
        stop,
        8
      ),

    tp1:
      num(
        tp1,
        8
      ),

    tp2:
      num(
        tp2,
        8
      ),

    tp3:
      num(
        tp3,
        8
      ),

    risk:
      num(
        risk,
        8
      ),

    distancePct:
      num(
        proximity,
        2
      ),

    h4Touches:
      zone.h4Touches ||
      0,

    h2Touches:
      zone.h2Touches ||
      0,

    overlap:
      !!zone.overlap,

    structure15:
      structure.direction,

    volumeRatio:
      num(
        vol,
        2
      ),

    createdAt:
      now,

    expiresAt:
      now +
      CFG.SIGNAL_MAX_AGE_MS,

    enteredAt:
      null,

    exitAt:
      null,

    status:
      'WAITING',

    tp1Hit:
      false,

    tp2Hit:
      false,

    tp3Hit:
      false,

    reason:
      (
        zone.overlap
          ? '4H + 2H ortak bölge'
          : '4H/2H güçlü bölge'
      ) +
      ' + ' +
      structure.direction +
      ' 15M yapı teyidi' +
      (
        zone.h4Touches +
        zone.h2Touches
          ? ' + ' +
            (
              zone.h4Touches +
              zone.h2Touches
            ) +
            ' temas'
          : ''
      ),

    tradingView:
      'https://www.tradingview.com/symbols/' +
      encodeURIComponent(
        m.symbol
      ) +
      '/?exchange=BINANCE'
  };


  /*
   Sinyal bölgeden çok uzaksa doğma.
  */

  const tolerance =
    Math.max(
      zoneWidth * 1.4,
      level * 0.004
    );

  if (
    price <
      entryLow -
      tolerance ||
    price >
      entryHigh +
      tolerance
  ) {

    return null;
  }


  return signal;
}


/* =========================================================
   ANALYZE
   ========================================================= */

async function analyze(m) {

  try {

    const [
      c4,
      c2,
      c15
    ] =
      await Promise.all([

        getCandles(
          m.symbol,
          '4H',
          CFG.H4_LIMIT
        ),

        getCandles(
          m.symbol,
          '2H',
          CFG.H2_LIMIT
        ),

        getCandles(
          m.symbol,
          '15m',
          CFG.M15_LIMIT
        )
      ]);


    if (
      c4.length < 60 ||
      c2.length < 60 ||
      c15.length < 50
    ) {

      return null;
    }


    const sr4 =
      pivotLevels(
        c4,
        CFG.H4_LOOKBACK
      );

    const sr2 =
      pivotLevels(
        c2,
        CFG.H2_LOOKBACK
      );

    const structure =
      structure15(
        c15
      );


    /*
     15M yön yoksa işlem yok.
    */

    if (
      structure.direction ===
      'NEUTRAL'
    ) {

      return null;
    }


    for (
      const direction of
      ['LONG', 'SHORT']
    ) {

      if (
        structure.direction !==
        direction
      ) {

        continue;
      }


      const zone =
        mergeZone(
          sr4,
          sr2,
          direction,
          m.price
        );


      if (!zone) {
        continue;
      }


      const distance =
        pctDistance(
          m.price,
          zone.level
        );


      if (
        distance > 0.85
      ) {

        continue;
      }


      /*
       LONG:
       fiyat destek çevresinde

       SHORT:
       fiyat direnç çevresinde
      */

      if (
        direction === 'LONG' &&
        m.price <
          zone.low *
          0.994
      ) {

        continue;
      }

      if (
        direction === 'SHORT' &&
        m.price >
          zone.high *
          1.006
      ) {

        continue;
      }


      const signal =
        makeTrade(
          m,
          direction,
          zone,
          structure,
          c4,
          c2,
          c15,
          sr4,
          sr2
        );


      if (signal) {
        return signal;
      }
    }


    return null;

  } catch (error) {

    log(
      'Analiz hatası ' +
      m.symbol +
      ': ' +
      error.message
    );

    return null;
  }
}


/* =========================================================
   LIVE SIGNAL
   ========================================================= */

function isInEntry(
  signal,
  price
) {

  return (
    price >=
      signal.entryLow &&
    price <=
      signal.entryHigh
  );
}


function removeSignal(
  id,
  reason
) {

  const signal =
    activeSignals.get(
      id
    );

  if (!signal) {
    return;
  }

  cooldowns.set(
    signal.symbol +
      '_' +
      signal.direction,

    Date.now() +
      CFG.COOLDOWN_MS
  );

  activeSignals.delete(
    id
  );

  log(
    reason +
    ' | ' +
    signal.symbol +
    ' ' +
    signal.direction
  );
}


function updateSignal(
  signal,
  price
) {

  signal.currentPrice =
    num(
      price,
      8
    );


  /*
   Henüz giriş yok
  */

  if (
    !signal.enteredAt
  ) {

    /*
     Fiyat girişte
    */

    if (
      isInEntry(
        signal,
        price
      )
    ) {

      signal.enteredAt =
        Date.now();

      signal.status =
        'ENTERED';

      log(
        'GİRİŞ AKTİF | ' +
        signal.symbol +
        ' | ' +
        signal.direction +
        ' | ' +
        price
      );

      return true;
    }


    /*
     Sinyal çok yaşlandı
    */

    if (
      Date.now() >
      signal.expiresAt
    ) {

      removeSignal(
        signal.id,
        'SİNYAL SÜRESİ DOLDU'
      );

      return false;
    }


    /*
     LONG:
     giriş üstünden kaçtıysa
     işlem artık yok.

     SHORT:
     giriş altından kaçtıysa
     işlem artık yok.
    */

    const missed =
      signal.direction === 'LONG'
        ? price >
          signal.entryHigh
        : price <
          signal.entryLow;


    if (missed) {

      removeSignal(
        signal.id,
        'GİRİŞ KAÇTI'
      );

      return false;
    }


    return true;
  }


  /*
   LONG
  */

  if (
    signal.direction ===
    'LONG'
  ) {

    if (
      price <=
      signal.stop
    ) {

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      removeSignal(
        signal.id,
        'STOP | ' +
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price >=
        signal.tp1
    ) {

      signal.tp1Hit =
        true;

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price >=
        signal.tp2
    ) {

      signal.tp2Hit =
        true;

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price >=
        signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      removeSignal(
        signal.id,
        'TP3 | ' +
        price
      );

      return false;
    }

  } else {

    /*
     SHORT
    */

    if (
      price >=
      signal.stop
    ) {

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      removeSignal(
        signal.id,
        'STOP | ' +
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price <=
        signal.tp1
    ) {

      signal.tp1Hit =
        true;

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price <=
        signal.tp2
    ) {

      signal.tp2Hit =
        true;

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price <=
        signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      removeSignal(
        signal.id,
        'TP3 | ' +
        price
      );

      return false;
    }
  }


  return true;
}


/* =========================================================
   LIVE PRICE LOOP
   ========================================================= */

async function updateLiveSignals() {

  if (
    activeSignals.size === 0
  ) {

    return;
  }


  try {

    const tickers =
      await api(
        '/api/v2/mix/market/tickers',
        {
          productType:
            PRODUCT
        }
      );


    const prices =
      new Map();


    for (
      const ticker of
      (
        tickers ||
        []
      )
    ) {

      const price =
        Number(
          ticker.lastPr
        );

      if (
        Number.isFinite(
          price
        )
      ) {

        prices.set(
          ticker.symbol,
          price
        );
      }
    }


    for (
      const [
        id,
        signal
      ]
      of
      Array.from(
        activeSignals.entries()
      )
    ) {

      const price =
        prices.get(
          signal.symbol
        );

      if (
        Number.isFinite(
          price
        )
      ) {

        updateSignal(
          signal,
          price
        );
      }
    }


    rebuildCacheSignals();

  } catch (error) {

    log(
      'Canlı fiyat hatası: ' +
      error.message
    );
  }
}


/* =========================================================
   REGISTER
   ========================================================= */

function registerSignal(
  signal
) {

  const key =
    signal.symbol +
    '_' +
    signal.direction;

  const cooldownUntil =
    cooldowns.get(
      key
    ) || 0;

  if (
    Date.now() <
    cooldownUntil
  ) {

    return;
  }


  /*
   Aynı coin/yön zaten varsa
   daha güçlü sinyal gelirse
   yenile.
  */

  for (
    const existing
    of activeSignals.values()
  ) {

    if (
      existing.symbol ===
        signal.symbol &&
      existing.direction ===
        signal.direction
    ) {

      if (
        signal.score >
        existing.score + 3
      ) {

        activeSignals.delete(
          existing.id
        );

        activeSignals.set(
          signal.id,
          signal
        );
      }

      return;
    }
  }


  /*
   Maksimum sinyal sayısı
  */

  if (
    activeSignals.size >=
    CFG.MAX_SIGNALS
  ) {

    const waiting =
      [
        ...activeSignals.values()
      ]
        .filter(
          x =>
            !x.enteredAt
        )
        .sort(
          (a, b) =>
            a.score -
            b.score
        );


    if (
      !waiting.length ||
      signal.score <=
        waiting[0].score
    ) {

      return;
    }


    activeSignals.delete(
      waiting[0].id
    );

    log(
      'ROTASYON | ' +
      waiting[0].symbol +
      ' çıkarıldı | ' +
      signal.symbol +
      ' eklendi'
    );
  }


  activeSignals.set(
    signal.id,
    signal
  );


  log(
    'YENİ SİNYAL | ' +
    signal.symbol +
    ' | ' +
    signal.direction +
    ' | ' +
    signal.score +
    '/100'
  );
}


/* =========================================================
   CACHE
   ========================================================= */

function rebuildCacheSignals() {

  if (!resultCache) {
    return;
  }


  resultCache.signals =
    [
      ...activeSignals.values()
    ]
      .sort(
        (a, b) => {

          if (
            a.status ===
              'ENTERED' &&
            b.status !==
              'ENTERED'
          ) {

            return -1;
          }

          if (
            b.status ===
              'ENTERED' &&
            a.status !==
              'ENTERED'
          ) {

            return 1;
          }

          return (
            b.score -
            a.score
          );
        }
      )
      .slice(
        0,
        CFG.MAX_SIGNALS
      );


  resultCache.stats.signals =
    resultCache.signals.length;

  resultCache.timestamp =
    new Date().toISOString();
}


/* =========================================================
   RADAR
   ========================================================= */

async function runRadar() {

  if (scanning) {
    return resultCache;
  }

  scanning = true;
  lastError = null;

  const started =
    Date.now();


  try {

    await discover();


    const fast =
      market.slice(
        0,
        Math.min(
          CFG.FAST_RADAR,
          market.length
        )
      );


    const candidates =
      fast.slice(
        0,
        Math.min(
          CFG.ANALYZE_LIMIT,
          fast.length
        )
      );


    log(
      'RADAR başladı | ' +
      'Universe=' +
      market.length +
      ' | FastRadar=' +
      fast.length +
      ' | DeepAnalysis=' +
      candidates.length
    );


    const found = [];


    for (
      let i = 0;
      i < candidates.length;
      i += CFG.BATCH
    ) {

      const batch =
        candidates.slice(
          i,
          i + CFG.BATCH
        );


      const rows =
        await Promise.all(
          batch.map(
            analyze
          )
        );


      for (
        const signal
        of rows
      ) {

        if (signal) {
          found.push(
            signal
          );
        }
      }


      if (
        i +
          CFG.BATCH <
        candidates.length
      ) {

        await sleep(
          CFG.BATCH_DELAY_MS
        );
      }
    }


    found.sort(
      (a, b) =>
        b.score -
        a.score
    );


    for (
      const signal
      of found
    ) {

      registerSignal(
        signal
      );
    }


    await updateLiveSignals();


    resultCache = {

      success:
        true,

      system:
        'Sonny AI Signal Scanner V9',

      timestamp:
        new Date().toISOString(),

      market:
        marketDirection(),

      stats: {

        market:
          market.length,

        fastRadar:
          fast.length,

        analyzed:
          candidates.length,

        signals:
          activeSignals.size,

        scanSeconds:
          num(
            (
              Date.now() -
              started
            ) / 1000,
            1
          )
      },

      signals: [],

      strategy:
        '4H DESTEK/DİRENÇ + 2H DOĞRULAMA + 15M YAPI TETİĞİ',

      refresh:
        '60 SANİYE',

      liveRefresh:
        '5 SANİYE'
    };


    rebuildCacheSignals();


    lastScan =
      resultCache.timestamp;


    log(
      'RADAR tamamlandı | ' +
      'Universe=' +
      market.length +
      ' | FastRadar=' +
      fast.length +
      ' | OHLCV=' +
      candidates.length +
      ' | SIGNAL=' +
      activeSignals.size
    );


    return resultCache;

  } catch (error) {

    lastError =
      error.message;

    log(
      'RADAR ERROR: ' +
      error.message
    );


    return {
      success:
        false,

      error:
        error.message
    };

  } finally {

    scanning =
      false;
  }
}


/* =========================================================
   WEB UI
   ========================================================= */

const HTML = `<!doctype html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Sonny AI Trader V9</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#070a10;
  color:#f4f7fb;
  font-family:Inter,Arial,sans-serif;
}

.wrap{
  width:min(1180px,94%);
  margin:24px auto 60px;
}

.head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:15px;
  margin-bottom:18px;
}

.brand{
  font-size:28px;
  font-weight:950;
  letter-spacing:-.7px;
}

.sub{
  color:#7f8da3;
  margin-top:5px;
  font-size:13px;
}

.live{
  border:1px solid #1c5a3b;
  background:#0b2016;
  color:#4be58f;
  border-radius:999px;
  padding:9px 14px;
  font-weight:900;
  font-size:12px;
}

.market{
  border:1px solid #1d2939;
  background:linear-gradient(
    135deg,
    #101722,
    #0c111a
  );
  border-radius:18px;
  padding:22px;
  margin-bottom:14px;
}

.mrow{
  display:flex;
  justify-content:space-between;
  align-items:end;
  gap:15px;
}

.mlabel{
  font-size:11px;
  color:#738198;
  font-weight:900;
  letter-spacing:.8px;
}

.mdir{
  font-size:30px;
  font-weight:950;
  margin-top:5px;
}

.reason{
  color:#8b99ad;
  font-size:13px;
}

.stats{
  display:grid;
  grid-template-columns:
    repeat(4,1fr);
  gap:10px;
  margin-bottom:16px;
}

.stat{
  background:#0e141e;
  border:1px solid #1c2736;
  border-radius:15px;
  padding:15px;
}

.stat b{
  display:block;
  color:#6f7d91;
  font-size:10px;
  letter-spacing:.7px;
}

.stat strong{
  display:block;
  font-size:21px;
  margin-top:7px;
}

.section{
  margin-top:20px;
}

.sectionTitle{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:9px;
}

.sectionTitle h2{
  margin:0;
  font-size:18px;
}

.muted{
  color:#78869a;
  font-size:12px;
}

.signal{
  background:#0d141e;
  border:1px solid #243246;
  border-radius:18px;
  padding:18px;
  margin:11px 0;
  box-shadow:
    0 10px 30px
    rgba(0,0,0,.16);
}

.sigTop{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
}

.coin{
  font-size:21px;
  font-weight:950;
}

.long{
  color:#46e58d;
}

.short{
  color:#ff6278;
}

.neutral{
  color:#f1c85b;
}

.score{
  font-size:12px;
  font-weight:950;
  padding:7px 10px;
  border-radius:9px;
  background:#182333;
}

.status{
  display:inline-flex;
  margin-top:10px;
  padding:7px 10px;
  border-radius:8px;
  font-size:11px;
  font-weight:950;
}

.wait{
  background:#2b2410;
  color:#f1c85b;
}

.entered{
  background:#0d2b1c;
  color:#4be58f;
}

.liveprice{
  margin-top:13px;
  font-size:14px;
  color:#8997aa;
}

.liveprice strong{
  font-size:23px;
  color:#fff;
  margin-left:4px;
}

.age{
  float:right;
  color:#7e8ca0;
  font-size:11px;
}

.levels{
  display:grid;
  grid-template-columns:
    1.4fr 1fr 1fr 1fr 1fr;
  gap:8px;
  margin-top:14px;
}

.box{
  background:#121b28;
  border:1px solid #1b293a;
  border-radius:10px;
  padding:10px;
}

.box small{
  display:block;
  color:#6e7c90;
  font-size:9px;
  font-weight:900;
  margin-bottom:5px;
}

.box b{
  font-size:14px;
}

.entry{
  border-color:#355a48;
}

.stop{
  border-color:#57313a;
}

.why{
  margin-top:12px;
  padding:11px 12px;
  background:#0a111a;
  border-radius:10px;
  color:#9aa8ba;
  font-size:12px;
  line-height:1.5;
}

.tv{
  display:inline-block;
  margin-top:12px;
  padding:9px 12px;
  border-radius:9px;
  background:#e9edf4;
  color:#080c12;
  text-decoration:none;
  font-size:11px;
  font-weight:950;
}

.empty{
  background:#0d141e;
  border:1px dashed #253246;
  border-radius:15px;
  padding:24px;
  text-align:center;
  color:#718095;
}

.footer{
  margin-top:22px;
  color:#66758b;
  font-size:11px;
  text-align:center;
}

@media(max-width:760px){

  .stats{
    grid-template-columns:
      repeat(2,1fr);
  }

  .levels{
    grid-template-columns:
      repeat(2,1fr);
  }

  .head{
    align-items:flex-start;
  }

  .brand{
    font-size:23px;
  }

  .mrow{
    display:block;
  }

  .live{
    margin-top:8px;
    display:inline-block;
  }

  .age{
    float:none;
    display:block;
    margin-top:6px;
  }
}

</style>

</head>

<body>

<div class="wrap">

  <div class="head">

    <div>

      <div class="brand">
        ⚡ SONNY AI TRADER
        <span style="color:#687890">
          V9
        </span>
      </div>

      <div class="sub">
        4H Destek/Direnç ·
        2H Doğrulama ·
        15M Yapı ·
        Canlı Giriş Takibi
      </div>

    </div>

    <div class="live">
      ● CANLI
    </div>

  </div>


  <div class="market">

    <div class="mrow">

      <div>

        <div class="mlabel">
          GENEL PİYASA
        </div>

        <div
          id="md"
          class="mdir"
        >
          VERİ BEKLENİYOR
        </div>

      </div>

      <div
        id="mr"
        class="reason"
      >
        Piyasa hesaplanıyor...
      </div>

    </div>

  </div>


  <div class="stats">

    <div class="stat">

      <b>
        COIN EVRENİ
      </b>

      <strong id="mc">
        -
      </strong>

    </div>


    <div class="stat">

      <b>
        ANALİZ
      </b>

      <strong id="an">
        -
      </strong>

    </div>


    <div class="stat">

      <b>
        AKTİF SİNYAL
      </b>

      <strong id="sc">
        0
      </strong>

    </div>


    <div class="stat">

      <b>
        SON TARAMA
      </b>

      <strong id="ls">
        -
      </strong>

    </div>

  </div>


  <div class="section">

    <div class="sectionTitle">

      <h2>
        🚨 İŞLEM FIRSATLARI
      </h2>

      <span class="muted">
        Güncel durum canlı takip edilir
      </span>

    </div>


    <div id="signals">

      <div class="empty">
        İlk tarama yapılıyor...
      </div>

    </div>

  </div>


  <div class="footer">
    Bitget veri kaynağı ·
    Radar 60 sn ·
    Canlı fiyat 5 sn ·
    TradingView Binance grafiği
  </div>

</div>


<script>

function price(v){

  v=Number(v);

  if(!Number.isFinite(v)){
    return '-';
  }

  if(v>=100){
    return v.toFixed(2);
  }

  if(v>=1){
    return v.toFixed(4);
  }

  if(v>=.01){
    return v.toFixed(6);
  }

  return v.toFixed(8);
}


function age(t){

  let s =
    Math.max(
      0,
      Math.floor(
        (
          Date.now() -
          Number(t)
        ) / 1000
      )
    );

  let h =
    Math.floor(
      s / 3600
    );

  let m =
    Math.floor(
      (s % 3600) / 60
    );

  let x =
    s % 60;

  if(h){
    return h +
      's ' +
      m +
      'dk';
  }

  if(m){
    return m +
      'dk ' +
      x +
      'sn';
  }

  return x +
    'sn';
}


function render(d){

  const m =
    d.market ||
    {};

  const md =
    document.getElementById(
      'md'
    );


  md.textContent =
    m.label ||
    'VERİ BEKLENİYOR';


  md.className =
    'mdir ' +
    (
      m.direction ===
      'LONG'
        ? 'long'
        : m.direction ===
          'SHORT'
          ? 'short'
          : 'neutral'
    );


  document
    .getElementById(
      'mr'
    )
    .textContent =
    m.reason ||
    '';


  if(d.stats){

    document
      .getElementById(
        'mc'
      )
      .textContent =
      d.stats.market ??
      '-';


    document
      .getElementById(
        'an'
      )
      .textContent =
      d.stats.analyzed ??
      '-';


    document
      .getElementById(
        'sc'
      )
      .textContent =
      d.stats.signals ??
      0;
  }


  if(d.timestamp){

    document
      .getElementById(
        'ls'
      )
      .textContent =
      new Date(
        d.timestamp
      )
        .toLocaleTimeString(
          'tr-TR'
        );
  }


  const box =
    document.getElementById(
      'signals'
    );


  const list =
    d.signals ||
    [];


  if(!list.length){

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda işlem fırsatı yok.' +
      '<br>' +
      '<span style="font-size:11px">' +
      'Sonraki tarama piyasayı yeniden kontrol edecek.' +
      '</span>' +
      '</div>';

    return;
  }


  box.innerHTML =
    list
      .map(
        function(x){

          const cls =
            x.direction ===
            'LONG'
              ? 'long'
              : 'short';


          const entered =
            !!x.enteredAt;


          const status =
            entered
              ? 'GİRİŞ AKTİF'
              : 'GİRİŞ BEKLENİYOR';


          const statusClass =
            entered
              ? 'entered'
              : 'wait';


          return (

            '<div class="signal">' +

              '<div class="sigTop">' +

                '<div class="coin ' +
                cls +
                '">' +

                  x.symbol +
                  ' · ' +
                  x.direction +

                '</div>' +

                '<div class="score">' +

                  'KALİTE ' +
                  x.score +
                  '/100' +

                '</div>' +

              '</div>' +


              '<div class="status ' +
              statusClass +
              '">' +

                (
                  entered
                    ? '🟢'
                    : '🟡'
                ) +

                ' ' +
                status +

              '</div>' +


              '<div class="liveprice">' +

                'CANLI FİYAT ' +

                '<strong>' +
                price(
                  x.currentPrice
                ) +
                '</strong>' +

                '<span class="age">' +

                  'Sinyal: ' +

                  new Date(
                    x.createdAt
                  )
                    .toLocaleTimeString(
                      'tr-TR'
                    ) +

                  ' · Yaş: ' +

                  age(
                    x.createdAt
                  ) +

                '</span>' +

              '</div>' +


              '<div class="levels">' +

                '<div class="box entry">' +

                  '<small>GİRİŞ</small>' +

                  '<b>' +

                    price(
                      x.entryLow
                    ) +

                    ' – ' +

                    price(
                      x.entryHigh
                    ) +

                  '</b>' +

                '</div>' +


                '<div class="box stop">' +

                  '<small>STOP</small>' +

                  '<b>' +

                    price(
                      x.stop
                    ) +

                  '</b>' +

                '</div>' +


                '<div class="box">' +

                  '<small>TP1</small>' +

                  '<b>' +

                    price(
                      x.tp1
                    ) +

                  '</b>' +

                '</div>' +


                '<div class="box">' +

                  '<small>TP2</small>' +

                  '<b>' +

                    price(
                      x.tp2
                    ) +

                  '</b>' +

                '</div>' +


                '<div class="box">' +

                  '<small>TP3</small>' +

                  '<b>' +

                    price(
                      x.tp3
                    ) +

                  '</b>' +

                '</div>' +

              '</div>' +


              '<div class="why">' +

                '<b>Neden?</b> ' +

                x.reason +

                '<br>' +

                '<span>' +

                  '4H temas: ' +
                  x.h4Touches +

                  ' · 2H temas: ' +
                  x.h2Touches +

                  ' · 15M: ' +
                  x.structure15 +

                  ' · Bölge uzaklığı: %' +
                  x.distancePct +

                '</span>' +

              '</div>' +


              '<a ' +

                'class="tv" ' +

                'target="_blank" ' +

                'rel="noopener" ' +

                'href="' +
                x.tradingView +
                '">' +

                '📊 BINANCE TRADINGVIEW AÇ' +

              '</a>' +


            '</div>'

          );
        }
      )
      .join('');
}


async function load(){

  try{

    const response =
      await fetch(
        '/api/result?_=' +
        Date.now(),
        {
          cache:
            'no-store'
        }
      );


    const data =
      await response.json();


    if(
      data.result
    ){

      render(
        data.result
      );
    }

  } catch(error){

    // Sessiz bırakılır.
  }
}


load();

setInterval(
  load,
  5000
);

</script>

</body>

</html>`;


/* =========================================================
   ROUTES
   ========================================================= */

app.get(
  '/',
  (req, res) => {

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.send(
      HTML
    );
  }
);


app.get(
  '/health',
  (req, res) => {

    res.json({
      success:
        true,

      status:
        'healthy',

      system:
        'Sonny AI Signal Scanner V9'
    });
  }
);


app.get(
  '/api/status',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        scanning
          ? 'SCANNING'
          : 'ONLINE',

      system:
        'Sonny AI Signal Scanner V9',

      strategy:
        '4H DESTEK/DİRENÇ + 2H DOĞRULAMA + 15M YAPI',

      refresh:
        '60 SECONDS',

      liveRefresh:
        '5 SECONDS',

      lastScan,

      market:
        market.length,

      activeSignals:
        activeSignals.size,

      error:
        lastError
    });
  }
);


app.get(
  '/api/scan',
  async (req, res) => {

    if (
      ADMIN_SECRET &&
      req.query.secret !==
        ADMIN_SECRET
    ) {

      return res
        .status(401)
        .json({
          success:
            false,

          error:
            'Yetkisiz'
        });
    }


    res.json(
      await runRadar()
    );
  }
);


app.get(
  '/api/result',
  (req, res) => {

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );


    if(!resultCache){

      if(!scanning){

        runRadar()
          .catch(
            e =>
              log(
                'İlk tarama: ' +
                e.message
              )
          );
      }


      return res.json({

        success:
          true,

        scanning:
          true,

        result:
          null
      });
    }


    rebuildCacheSignals();


    res.json({

      success:
        true,

      scanning,

      result:
        resultCache
    });
  }
);


/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        success:
          false,

        error:
          'Endpoint not found'
      });
  }
);


/* =========================================================
   SERVER
   ========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    log(
      'Sonny AI Signal Scanner V9 started'
    );

    log(
      'Data source: BITGET'
    );

    log(
      'Strategy: 4H S/R + 2H CONFIRMATION + 15M STRUCTURE TRIGGER'
    );

    log(
      'Universe=' +
      CFG.MARKET_LIMIT +
      ' | FastRadar=' +
      CFG.FAST_RADAR +
      ' | DeepAnalysis=' +
      CFG.ANALYZE_LIMIT
    );

    log(
      'Radar=' +
      (
        CFG.SCAN_MS /
        1000
      ) +
      's | Live=' +
      (
        CFG.LIVE_MS /
        1000
      ) +
      's'
    );

    log(
      'Server listening on port ' +
      PORT
    );


    setTimeout(
      () =>
        runRadar(),
      2500
    );


    setInterval(
      () =>
        runRadar(),
      CFG.SCAN_MS
    );


    setInterval(
      () =>
        updateLiveSignals(),
      CFG.LIVE_MS
    );

  }
);
