const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';

/*
=========================================================
SONNY AI SIGNAL SCANNER V6.3
=========================================================

4H BREAKOUT
2H CONFIRMATION
RETEST
15M RSI
5M RSI
VOLUME
BOLLINGER WIDTH
LIVE ENTRY TRACKING
TP1 / TP2 / TP3 / STOP
REAL PERFORMANCE

ÖNEMLİ:
PREPARING YOK
MISSED YOK
AKTİF SİNYAL SADECE GİRİŞ BÖLGESİNDEYKEN GÖRÜNÜR
=========================================================
*/

const CFG = {

  REFRESH_MS: 60000,

  /*
  Bitget'ten gelen uygun perpetual marketlerin
  tamamına yakınını universe olarak tut.
  */
  MARKET_LIMIT: 762,

  /*
  İlk hızlı tarama.
  */
  FAST_RADAR: 500,

  /*
  Derin OHLCV analizi.
  250 yerine 120 kullanıyoruz.
  Çünkü her coin için 4H + 2H + 15M + 5M
  çağrısı yapılması Bitget 429 riskini artırıyor.
  */
  ANALYZE_LIMIT: 120,

  MIN_VOLUME: 3000000,

  LOOKBACK_4H: 30,
  LOOKBACK_2H: 30,

  FOUR_H_LIMIT: 100,
  TWO_H_LIMIT: 100,
  M15_LIMIT: 150,
  M5_LIMIT: 100,

  /*
  Eski çalışan sistemdeki retest toleransı.
  */
  RETEST_PERCENT: 0.80,

  RSI_PERIOD: 14,

  LONG_RSI_MIN: 48,
  LONG_RSI_MAX: 68,

  SHORT_RSI_MIN: 32,
  SHORT_RSI_MAX: 52,

  /*
  Eski çalışan eşik.
  */
  MIN_SIGNAL_SCORE: 75,

  MAX_SIGNALS: 8,

  /*
  API güvenliği
  */
  BATCH: 5,
  DELAY: 350,

  /*
  Aynı sinyalin tekrar tekrar
  üretilmesini önler.
  */
  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

  /*
  Performans geçmişi.
  */
  MAX_HISTORY: 50
};


/*
=========================================================
STATE
=========================================================
*/

let market = [];

let resultCache = null;

let scanning = false;

let lastScan = null;

let lastError = null;

/*
Aktif sinyaller burada tutulur.
Radar yeni sinyal üretmese bile
fiyat takibi devam eder.
*/
const activeSignals = new Map();

/*
Gerçekleşmiş işlemler.
*/
let performanceHistory = [];


/*
=========================================================
GENEL
=========================================================
*/

function log(message) {

  console.log(
    '[' +
    new Date().toISOString() +
    '] ' +
    message
  );
}


function sleep(ms) {

  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function n(value, decimals = 6) {

  return Number.isFinite(value)
    ? Number(value.toFixed(decimals))
    : 0;
}


function pct(value, base) {

  if (!base) {
    return 0;
  }

  return (value / base) * 100;
}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}


/*
=========================================================
BITGET API
=========================================================
*/

async function api(path, params = {}) {

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


  let lastErrorLocal = null;


  for (let attempt = 0; attempt < 3; attempt++) {

    try {

      const response =
        await fetch(url);


      const text =
        await response.text();


      if (!response.ok) {

        if (
          response.status === 429 &&
          attempt < 2
        ) {

          await sleep(
            1200 * (attempt + 1)
          );

          continue;
        }


        throw new Error(
          'Bitget HTTP ' +
          response.status +
          ' - ' +
          text.slice(0, 250)
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

      lastErrorLocal = error;


      if (
        attempt < 2
      ) {

        await sleep(
          500 * (attempt + 1)
        );

      }

    }
  }


  throw lastErrorLocal;
}


/*
=========================================================
CANDLE PARSER
=========================================================
*/

function candles(data) {

  if (!Array.isArray(data)) {
    return [];
  }


  return data
    .map(row => ({

      time: +row[0],

      open: +row[1],

      high: +row[2],

      low: +row[3],

      close: +row[4],

      volume: +row[5]

    }))


    .filter(
      x =>
        Number.isFinite(x.close)
    )


    .sort(
      (a, b) =>
        a.time - b.time
    );
}


/*
=========================================================
RSI
=========================================================
*/

function rsi(
  values,
  period = 14
) {

  if (
    !values ||
    values.length <= period
  ) {

    return null;
  }


  let gain = 0;
  let loss = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    if (change >= 0) {

      gain += change;

    } else {

      loss -= change;
    }
  }


  let avgGain =
    gain / period;


  let avgLoss =
    loss / period;


  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    avgGain =
      (
        avgGain * (period - 1) +
        Math.max(change, 0)
      ) / period;


    avgLoss =
      (
        avgLoss * (period - 1) +
        Math.max(-change, 0)
      ) / period;
  }


  if (avgLoss === 0) {
    return 100;
  }


  return (
    100 -
    100 /
    (
      1 +
      avgGain / avgLoss
    )
  );
}


/*
=========================================================
BOLLINGER WIDTH
=========================================================
*/

function bollingerWidth(
  values,
  period = 20
) {

  if (
    !values ||
    values.length < period
  ) {

    return null;
  }


  const data =
    values.slice(-period);


  const mean =
    data.reduce(
      (sum, x) =>
        sum + x,
      0
    ) / period;


  const variance =
    data.reduce(
      (sum, x) =>
        sum +
        Math.pow(x - mean, 2),
      0
    ) / period;


  const deviation =
    Math.sqrt(variance);


  if (!mean) {
    return null;
  }


  return (
    ((deviation * 4) / mean) *
    100
  );
}


/*
=========================================================
VOLUME RATIO
=========================================================
*/

function volumeRatio(c) {

  if (
    !c ||
    c.length < 21
  ) {

    return 1;
  }


  const closed =
    c.slice(0, -1);


  const recent =
    closed.at(-1);


  const previous =
    closed.slice(-21, -1);


  if (
    !recent ||
    !previous.length
  ) {

    return 1;
  }


  const average =
    previous.reduce(
      (sum, x) =>
        sum + x.volume,
      0
    ) / previous.length;


  if (!average) {
    return 1;
  }


  return recent.volume / average;
}


/*
=========================================================
MARKET DISCOVERY
=========================================================
*/

async function discover() {

  const [
    contracts,
    tickers
  ] = await Promise.all([

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

      contracts

        .filter(
          c =>
            c.symbolType === 'perpetual' &&
            c.symbolStatus === 'normal' &&
            c.quoteCoin === 'USDT'
        )

        .map(
          c =>
            c.symbol
        )
    );


  market =

    tickers

      .filter(
        t =>
          valid.has(t.symbol)
      )


      .map(
        t => {

          const rawChange =
            Number(t.change24h) || 0;


          const change =
            Math.abs(rawChange) <= 1
              ? rawChange * 100
              : rawChange;


          return {

            symbol:
              t.symbol,

            price:
              Number(t.lastPr),

            volume24h:
              Number(t.quoteVolume) || 0,

            change24h:
              change
          };
        }
      )


      .filter(
        x =>
          Number.isFinite(x.price) &&
          x.volume24h >= CFG.MIN_VOLUME
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
    'Discovery tamamlandı. ' +
    market.length +
    ' uygun coin bulundu.'
  );
}


/*
=========================================================
CANDLES
=========================================================
*/

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

        productType:
          PRODUCT,

        granularity:
          timeframe,

        limit
      }
    );


  return candles(data);
}


/*
=========================================================
BREAKOUT
=========================================================
*/

function breakoutInfo(
  c,
  lookback
) {

  if (
    c.length <
    lookback + 5
  ) {

    return null;
  }


  /*
  Açık mumu çıkar.
  */
  const closed =
    c.slice(0, -1);


  /*
  Eski çalışan sistem:
  son 8 kapanmış mum içerisinde
  kırılım ara.
  */
  const recent =
    Math.min(
      8,
      closed.length - lookback
    );


  let longBreak = false;

  let shortBreak = false;

  let longLevel = null;

  let shortLevel = null;


  for (
    let i =
      closed.length - recent;

    i <
      closed.length;

    i++
  ) {

    const history =
      closed.slice(
        i - lookback,
        i
      );


    if (
      history.length <
      lookback
    ) {

      continue;
    }


    const resistance =
      Math.max(
        ...history.map(
          x => x.high
        )
      );


    const support =
      Math.min(
        ...history.map(
          x => x.low
        )
      );


    const current =
      closed[i];


    const previous =
      closed[i - 1];


    if (
      current.close >
        resistance &&
      previous.close <=
        resistance
    ) {

      longBreak = true;

      longLevel =
        resistance;
    }


    if (
      current.close <
        support &&
      previous.close >=
        support
    ) {

      shortBreak = true;

      shortLevel =
        support;
    }
  }


  const last =
    closed.slice(-lookback);


  return {

    current:
      closed.at(-1),

    resistance:
      longLevel ||
      Math.max(
        ...last.map(
          x => x.high
        )
      ),

    support:
      shortLevel ||
      Math.min(
        ...last.map(
          x => x.low
        )
      ),

    longBreak,

    shortBreak,

    longLevel,

    shortLevel
  };
}


/*
=========================================================
RETEST
=========================================================
*/

function near(
  price,
  level
) {

  if (!level) {
    return false;
  }


  return (
    Math.abs(
      pct(
        price - level,
        level
      )
    ) <=
    CFG.RETEST_PERCENT
  );
}


/*
=========================================================
SCORE
=========================================================
*/

function score(
  breakout4H,
  breakout2H,
  retest,
  rsiOk,
  rv,
  direction,
  rv5,
  volumeRatioValue,
  bbWidth
) {

  let s = 0;


  if (breakout4H) {
    s += 35;
  }


  if (breakout2H) {

    s += 30;

  } else if (breakout4H) {

    /*
    Eski sistemde 2H kırılmadıysa
    ama yapı 4H'ı destekliyorsa
    15 puan.
    */
    s += 15;
  }


  if (retest) {
    s += 20;
  }


  if (rsiOk) {
    s += 10;
  }


  if (
    direction === 'LONG' &&
    rv >= 52 &&
    rv <= 63
  ) {

    s += 5;
  }


  if (
    direction === 'SHORT' &&
    rv >= 37 &&
    rv <= 48
  ) {

    s += 5;
  }


  /*
  5M RSI destek puanı.
  Sinyali öldürmez.
  */

  if (
    direction === 'LONG' &&
    Number.isFinite(rv5) &&
    rv5 >= 45 &&
    rv5 <= 70
  ) {

    s += 3;
  }


  if (
    direction === 'SHORT' &&
    Number.isFinite(rv5) &&
    rv5 >= 30 &&
    rv5 <= 55
  ) {

    s += 3;
  }


  /*
  Hacim bonusu.
  */
  if (
    Number.isFinite(volumeRatioValue) &&
    volumeRatioValue >= 1.2
  ) {

    s += 5;
  }


  /*
  Bollinger genişliği.
  Squeeze tamamen engellemez.
  Sadece kalite bonusu.
  */
  if (
    Number.isFinite(bbWidth) &&
    bbWidth >= 1
  ) {

    s += 3;
  }


  return Math.min(
    100,
    s
  );
}


/*
=========================================================
TRADE PLAN
=========================================================
*/

function plan(
  m,
  direction,
  level,
  rv,
  rv5,
  sc,
  volumeRatioValue,
  bbWidth,
  reason
) {

  let entryLow;
  let entryHigh;


  if (
    direction === 'LONG'
  ) {

    entryLow =
      level * 0.998;

    entryHigh =
      level * 1.004;

  } else {

    entryLow =
      level * 1.002;

    entryHigh =
      level * 0.996;
  }


  /*
  Entry sınırlarını normalize et.
  */
  const low =
    Math.min(
      entryLow,
      entryHigh
    );


  const high =
    Math.max(
      entryLow,
      entryHigh
    );


  const stop =
    direction === 'LONG'
      ? level * 0.982
      : level * 1.018;


  const risk =
    Math.abs(
      level - stop
    );


  const tp1 =
    direction === 'LONG'
      ? level + risk * 1.5
      : level - risk * 1.5;


  const tp2 =
    direction === 'LONG'
      ? level + risk * 2
      : level - risk * 2;


  const tp3 =
    direction === 'LONG'
      ? level + risk * 3
      : level - risk * 3;


  return {

    id:
      m.symbol +
      '_' +
      direction +
      '_' +
      Math.round(level * 1000000),

    symbol:
      m.symbol,

    direction,

    strategy:
      '4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI',

    score:
      sc,

    price:
      n(m.price, 8),

    entryLow:
      n(low, 8),

    entryHigh:
      n(high, 8),

    stop:
      n(stop, 8),

    tp1:
      n(tp1, 8),

    tp2:
      n(tp2, 8),

    tp3:
      n(tp3, 8),

    rsi:
      n(rv, 1),

    rsi5:
      n(rv5, 1),

    volumeRatio:
      n(volumeRatioValue, 2),

    bbWidth:
      n(bbWidth, 2),

    level:
      n(level, 8),

    change24h:
      n(m.change24h, 2),

    reason,

    createdAt:
      Date.now(),

    enteredAt:
      null,

    exitAt:
      null,

    status:
      'ACTIVE',

    tp1Hit:
      false,

    tp2Hit:
      false,

    tp3Hit:
      false,

    stopHit:
      false,

    currentPrice:
      n(m.price, 8),

    tradingView:
      'https://www.tradingview.com/symbols/' +
      encodeURIComponent(m.symbol) +
      '/?exchange=BITGET'
  };
}


/*
=========================================================
MAKE SIGNAL
=========================================================
*/

function makeSignal(
  m,
  h4,
  h2,
  m15,
  m5
) {

  const rv =
    rsi(
      m15
        .slice(0, -1)
        .map(
          x => x.close
        ),
      CFG.RSI_PERIOD
    );


  const rv5 =
    rsi(
      m5
        .slice(0, -1)
        .map(
          x => x.close
        ),
      CFG.RSI_PERIOD
    );


  if (rv === null) {
    return null;
  }


  const price =
    m.price;


  const h2Price =
    h2.current.close;


  const volumeRatioValue =
    volumeRatio(m15);


  const bbWidth =
    bollingerWidth(
      m15
        .slice(0, -1)
        .map(
          x => x.close
        )
    );


  /*
  ========================================================
  LONG
  ========================================================
  */

  if (
    h4.longBreak ||
    h2.longBreak
  ) {

    const level =
      h4.longBreak
        ? (
            h4.longLevel ||
            h4.resistance
          )
        : (
            h2.longLevel ||
            h2.resistance
          );


    const h4ok =
      h4.longBreak ||
      price >=
      h4.resistance * 0.997;


    const h2ok =
      h2.longBreak ||
      h2Price >=
      h2.resistance * 0.997;


    const rsiOk =
      rv >= CFG.LONG_RSI_MIN &&
      rv <= CFG.LONG_RSI_MAX;


    const retest =
      near(
        price,
        level
      );


    if (
      h4ok &&
      h2ok &&
      retest &&
      rsiOk
    ) {

      const sc =
        score(
          h4.longBreak,
          h2.longBreak,
          true,
          true,
          rv,
          'LONG',
          rv5,
          volumeRatioValue,
          bbWidth
        );


      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        return plan(

          m,

          'LONG',

          level,

          rv,

          rv5,

          sc,

          volumeRatioValue,

          bbWidth,

          (
            h4.longBreak
              ? '4H kırılımı'
              : '4H yapı onayı'
          ) +
          ' + ' +
          (
            h2.longBreak
              ? '2H kırılım onayı'
              : '2H yapı onayı'
          ) +
          ' + retest + RSI LONG giriş bölgesi.'
        );
      }
    }
  }


  /*
  ========================================================
  SHORT
  ========================================================
  */

  if (
    h4.shortBreak ||
    h2.shortBreak
  ) {

    const level =
      h4.shortBreak
        ? (
            h4.shortLevel ||
            h4.support
          )
        : (
            h2.shortLevel ||
            h2.support
          );


    const h4ok =
      h4.shortBreak ||
      price <=
      h4.support * 1.003;


    const h2ok =
      h2.shortBreak ||
      h2Price <=
      h2.support * 1.003;


    const rsiOk =
      rv >= CFG.SHORT_RSI_MIN &&
      rv <= CFG.SHORT_RSI_MAX;


    const retest =
      near(
        price,
        level
      );


    if (
      h4ok &&
      h2ok &&
      retest &&
      rsiOk
    ) {

      const sc =
        score(
          h4.shortBreak,
          h2.shortBreak,
          true,
          true,
          rv,
          'SHORT',
          rv5,
          volumeRatioValue,
          bbWidth
        );


      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        return plan(

          m,

          'SHORT',

          level,

          rv,

          rv5,

          sc,

          volumeRatioValue,

          bbWidth,

          (
            h4.shortBreak
              ? '4H kırılımı'
              : '4H yapı onayı'
          ) +
          ' + ' +
          (
            h2.shortBreak
              ? '2H kırılım onayı'
              : '2H yapı onayı'
          ) +
          ' + retest + RSI SHORT giriş bölgesi.'
        );
      }
    }
  }


  return null;
}


/*
=========================================================
ANALYZE
=========================================================
*/

async function analyze(m) {

  try {

    const [
      c4,
      c2,
      c15,
      c5
    ] =
      await Promise.all([

        getCandles(
          m.symbol,
          '4H',
          CFG.FOUR_H_LIMIT
        ),

        getCandles(
          m.symbol,
          '2H',
          CFG.TWO_H_LIMIT
        ),

        getCandles(
          m.symbol,
          '15m',
          CFG.M15_LIMIT
        ),

        getCandles(
          m.symbol,
          '5m',
          CFG.M5_LIMIT
        )

      ]);


    if (
      c4.length < 40 ||
      c2.length < 40 ||
      c15.length < 50 ||
      c5.length < 30
    ) {

      return null;
    }


    const h4 =
      breakoutInfo(
        c4,
        CFG.LOOKBACK_4H
      );


    const h2 =
      breakoutInfo(
        c2,
        CFG.LOOKBACK_2H
      );


    if (!h4 || !h2) {
      return null;
    }


    const signal =
      makeSignal(
        m,
        h4,
        h2,
        c15,
        c5
      );


    if (!signal) {
      return null;
    }


    return {
      type: 'SIGNAL',
      data: signal
    };


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


/*
=========================================================
MARKET DIRECTION
=========================================================
*/

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

      direction:
        'YATAY',

      label:
        'PİYASA YATAY',

      reason:
        'Piyasa verisi bekleniyor.'
    };
  }


  const up =
    list.filter(
      x =>
        x.change24h > 1
    ).length;


  const down =
    list.filter(
      x =>
        x.change24h < -1
    ).length;


  if (up > down) {

    return {

      direction:
        'LONG',

      label:
        'PİYASA YUKARI',

      reason:
        'BTC / ETH yükseliş ağırlıklı.'
    };
  }


  if (down > up) {

    return {

      direction:
        'SHORT',

      label:
        'PİYASA AŞAĞI',

      reason:
        'BTC / ETH düşüş ağırlıklı.'
    };
  }


  return {

    direction:
      'YATAY',

    label:
      'PİYASA YATAY',

    reason:
      'Genel piyasa yönü net değil.'
  };
}


/*
=========================================================
PERFORMANCE
=========================================================
*/

function addPerformance(
  signal,
  result,
  exitPrice
) {

  const item = {

    symbol:
      signal.symbol,

    direction:
      signal.direction,

    result,

    entry:
      n(
        signal.level,
        8
      ),

    exit:
      n(
        exitPrice,
        8
      ),

    r:
      calculateR(
        signal,
        result,
        exitPrice
      ),

    time:
      new Date().toISOString()
  };


  performanceHistory.unshift(
    item
  );


  if (
    performanceHistory.length >
    CFG.MAX_HISTORY
  ) {

    performanceHistory =
      performanceHistory.slice(
        0,
        CFG.MAX_HISTORY
      );
  }
}


function calculateR(
  signal,
  result,
  exitPrice
) {

  const risk =
    Math.abs(
      signal.level -
      signal.stop
    );


  if (!risk) {
    return 0;
  }


  if (
    signal.direction ===
    'LONG'
  ) {

    return n(
      (
        exitPrice -
        signal.level
      ) / risk,
      2
    );
  }


  return n(
    (
      signal.level -
      exitPrice
    ) / risk,
    2
  );
}


function performanceStats() {

  const resolved =
    performanceHistory.filter(
      x =>
        x.result === 'TP1' ||
        x.result === 'TP2' ||
        x.result === 'TP3' ||
        x.result === 'STOP'
    );


  const tp1 =
    resolved.filter(
      x =>
        x.result === 'TP1' ||
        x.result === 'TP2' ||
        x.result === 'TP3'
    ).length;


  const stop =
    resolved.filter(
      x =>
        x.result === 'STOP'
    ).length;


  const totalR =
    resolved.reduce(
      (sum, x) =>
        sum + x.r,
      0
    );


  const tp1Rate =
    resolved.length
      ? (tp1 / resolved.length) * 100
      : 0;


  const stopRate =
    resolved.length
      ? (stop / resolved.length) * 100
      : 0;


  return {

    tp1Rate:
      n(tp1Rate, 1),

    stopRate:
      n(stopRate, 1),

    totalR:
      n(totalR, 2),

    resolved:
      resolved.length,

    total:
      performanceHistory.length,

    history:
      performanceHistory.slice(
        0,
        CFG.MAX_HISTORY
      )
  };
}


/*
=========================================================
LIVE SIGNAL TRACKING
=========================================================
*/

function isLongEntry(
  signal,
  price
) {

  return (
    price >= signal.entryLow &&
    price <= signal.entryHigh
  );
}


function isShortEntry(
  signal,
  price
) {

  return (
    price <= signal.entryHigh &&
    price >= signal.entryLow
  );
}


function isEntry(
  signal,
  price
) {

  if (
    signal.direction === 'LONG'
  ) {

    return isLongEntry(
      signal,
      price
    );
  }


  return isShortEntry(
    signal,
    price
  );
}


function updateActiveSignal(
  signal,
  price
) {

  signal.currentPrice =
    n(price, 8);


  /*
  Henüz giriş yapılmadı.
  */

  if (!signal.enteredAt) {

    if (
      isEntry(
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
    Giriş bölgesinden tamamen çıktıysa
    sinyal ekrandan silinir.
    */

    const missedLong =
      signal.direction === 'LONG' &&
      price > signal.entryHigh;


    const missedShort =
      signal.direction === 'SHORT' &&
      price < signal.entryLow;


    if (
      missedLong ||
      missedShort
    ) {

      signal.status =
        'EXPIRED';

      log(
        'GİRİŞ KAÇTI | ' +
        signal.symbol
      );


      return false;
    }


    /*
    Fiyat henüz giriş bölgesine
    gelmemişse aktif sinyal olarak
    ekranda kalmaya devam eder.
    */

    return true;
  }


  /*
  ========================================================
  GİRİŞ YAPILDIKTAN SONRA
  ========================================================
  */

  if (
    signal.direction === 'LONG'
  ) {

    /*
    STOP önce kontrol edilir.
    */
    if (
      price <= signal.stop
    ) {

      signal.stopHit =
        true;

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      addPerformance(
        signal,
        'STOP',
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price >= signal.tp1
    ) {

      signal.tp1Hit =
        true;

      addPerformance(
        signal,
        'TP1',
        price
      );

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price >= signal.tp2
    ) {

      signal.tp2Hit =
        true;

      addPerformance(
        signal,
        'TP2',
        price
      );

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price >= signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      addPerformance(
        signal,
        'TP3',
        price
      );

      return false;
    }

  } else {

    /*
    SHORT
    */

    if (
      price >= signal.stop
    ) {

      signal.stopHit =
        true;

      signal.status =
        'STOP';

      signal.exitAt =
        Date.now();

      addPerformance(
        signal,
        'STOP',
        price
      );

      return false;
    }


    if (
      !signal.tp1Hit &&
      price <= signal.tp1
    ) {

      signal.tp1Hit =
        true;

      addPerformance(
        signal,
        'TP1',
        price
      );

      log(
        'TP1 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp2Hit &&
      price <= signal.tp2
    ) {

      signal.tp2Hit =
        true;

      addPerformance(
        signal,
        'TP2',
        price
      );

      log(
        'TP2 | ' +
        signal.symbol
      );
    }


    if (
      !signal.tp3Hit &&
      price <= signal.tp3
    ) {

      signal.tp3Hit =
        true;

      signal.status =
        'TP3';

      signal.exitAt =
        Date.now();

      addPerformance(
        signal,
        'TP3',
        price
      );

      return false;
    }
  }


  return true;
}


/*
=========================================================
UPDATE LIVE PRICES
=========================================================
*/

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


    if (Array.isArray(tickers)) {

      tickers.forEach(
        ticker => {

          const price =
            Number(
              ticker.lastPr
            );


          if (
            Number.isFinite(price)
          ) {

            prices.set(
              ticker.symbol,
              price
            );
          }
        }
      );
    }


    for (
      const [
        id,
        signal
      ]
      of activeSignals
    ) {

      const price =
        prices.get(
          signal.symbol
        );


      if (
        !Number.isFinite(price)
      ) {

        continue;
      }


      const keep =
        updateActiveSignal(
          signal,
          price
        );


      if (!keep) {

        activeSignals.delete(
          id
        );
      }
    }


  } catch (error) {

    log(
      'Canlı fiyat güncelleme hatası: ' +
      error.message
    );
  }
}


/*
=========================================================
REGISTER NEW SIGNAL
=========================================================
*/

function registerSignal(
  signal
) {

  /*
  Aynı sembol + yön aktifse
  yeni kopya oluşturma.
  */

  for (
    const existing
    of activeSignals.values()
  ) {

    if (
      existing.symbol === signal.symbol &&
      existing.direction === signal.direction
    ) {

      return;
    }
  }


  /*
  Çok yakın zamanda aynı sinyal
  kapandıysa tekrar oluşturma.
  */

  const key =
    signal.symbol +
    '_' +
    signal.direction;


  const old =
    activeSignals.get(key);


  if (old) {
    return;
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
    ' | Güç: ' +
    signal.score
  );
}


/*
=========================================================
RADAR
=========================================================
*/

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


    /*
    Önce en yüksek hacimli
    500 coin hızlı radar havuzu.
    */

    const fastCandidates =
      market.slice(
        0,
        Math.min(
          CFG.FAST_RADAR,
          market.length
        )
      );


    /*
    Derin analiz için ilk 120.
    */

    const candidates =
      fastCandidates.slice(
        0,
        Math.min(
          CFG.ANALYZE_LIMIT,
          fastCandidates.length
        )
      );


    log(
      'RADAR başladı | Universe=' +
      market.length +
      ' | FastRadar=' +
      fastCandidates.length +
      ' | DeepAnalysis=' +
      candidates.length
    );


    const foundSignals = [];


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


      rows.forEach(
        result => {

          if (
            result &&
            result.type === 'SIGNAL'
          ) {

            foundSignals.push(
              result.data
            );
          }
        }
      );


      await sleep(
        CFG.DELAY
      );
    }


    /*
    En güçlü sinyaller.
    */

    foundSignals.sort(
      (a, b) =>
        b.score -
        a.score
    );


    /*
    Yeni sinyalleri aktif havuza ekle.
    */

    foundSignals
      .slice(
        0,
        CFG.MAX_SIGNALS
      )
      .forEach(
        registerSignal
      );


    /*
    Eski aktif sinyallerin fiyatını
    radar sonucu bağımsız takip et.
    */

    await updateLiveSignals();


    /*
    Aktif sinyalleri tekrar sırala.
    */

    const active =
      Array.from(
        activeSignals.values()
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        CFG.MAX_SIGNALS
      );


    const performance =
      performanceStats();


    resultCache = {

      success:
        true,

      system:
        'Sonny AI Signal Scanner V6.3',

      timestamp:
        new Date().toISOString(),

      market:
        marketDirection(),

      stats: {

        market:
          market.length,

        fastRadar:
          fastCandidates.length,

        analyzed:
          candidates.length,

        signals:
          active.length,

        performance:
          performance.resolved
      },


      signals:
        active,


      /*
      PREPARING KESİNLİKLE YOK.
      */

      preparing:
        [],


      /*
      MISSED KESİNLİKLE YOK.
      */

      missed:
        [],


      performance,


      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME',

      refresh:
        '60 SECONDS',

      scanSeconds:
        n(
          (
            Date.now() -
            started
          ) / 1000,
          1
        )
    };


    lastScan =
      resultCache.timestamp;


    log(
      'RADAR tamamlandı | Universe=' +
      market.length +
      ' | FastRadar=' +
      fastCandidates.length +
      ' | OHLCV=' +
      candidates.length +
      ' | SIGNAL=' +
      active.length +
      ' | PERFORMANCE=' +
      performance.resolved
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


/*
=========================================================
HTML
=========================================================
*/

const HTML = `<!doctype html>

<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Sonny AI Signal Scanner V6.3</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#080b12;
  color:#f5f7fb;
  font-family:Arial,sans-serif;
}

.wrap{
  width:min(1200px,94%);
  margin:25px auto 50px;
}

.head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:18px;
}

.title{
  font-size:27px;
  font-weight:900;
}

.sub,
.muted{
  color:#7d8799;
}

.online{
  padding:9px 14px;
  border-radius:20px;
  background:#0d2118;
  color:#43e58b;
  border:1px solid #174d31;
  font-weight:800;
}

.market,
.stat,
.panel{
  background:#111722;
  border:1px solid #202b3b;
  border-radius:15px;
  padding:18px;
  margin-bottom:15px;
}

.marketLabel,
.label{
  color:#748095;
  font-size:11px;
  font-weight:800;
}

.marketDir{
  font-size:28px;
  font-weight:900;
  margin-top:5px;
}

.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}

.stat{
  margin:0;
}

.value{
  font-size:21px;
  font-weight:900;
  margin-top:7px;
}

.panel h2{
  margin:0 0 6px;
  font-size:19px;
}

.signal{
  background:#0c121d;
  border:1px solid #26354a;
  border-radius:13px;
  padding:16px;
  margin-top:12px;
}

.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.coin{
  font-size:20px;
  font-weight:900;
}

.long{
  color:#45e58d;
}

.short{
  color:#ff647a;
}

.score{
  background:#1c2635;
  padding:6px 9px;
  border-radius:7px;
  font-weight:900;
}

.plan{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:8px;
  margin-top:14px;
}

.box{
  background:#151d2a;
  border-radius:8px;
  padding:9px;
}

.box b{
  display:block;
  color:#68758a;
  font-size:10px;
  margin-bottom:4px;
}

.reason{
  margin-top:12px;
  background:#121a27;
  padding:10px;
  border-radius:8px;
  color:#a8b3c5;
  font-size:12px;
}

.tv{
  display:inline-block;
  margin-top:11px;
  padding:8px 12px;
  background:#e9edf4;
  color:#0b1018;
  border-radius:8px;
  text-decoration:none;
  font-size:12px;
  font-weight:900;
}

.performance{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px;
  margin-top:15px;
}

.perfBox{
  background:#151d2a;
  border-radius:9px;
  padding:12px;
}

.perfBox span{
  display:block;
  color:#68758a;
  font-size:10px;
  font-weight:800;
  margin-bottom:6px;
}

.perfBox strong{
  font-size:19px;
}

.status{
  margin-top:10px;
  color:#7e8b9e;
  font-size:12px;
}

.empty{
  margin-top:18px;
  padding:18px;
  background:#0c121d;
  border-radius:10px;
  color:#718096;
}

@media(max-width:800px){

  .stats{
    grid-template-columns:repeat(2,1fr);
  }

  .plan{
    grid-template-columns:repeat(2,1fr);
  }

  .performance{
    grid-template-columns:repeat(2,1fr);
  }

  .head{
    display:block;
  }

  .online{
    display:inline-block;
    margin-top:10px;
  }
}

</style>

</head>

<body>

<div class="wrap">

<div class="head">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V6.3
</div>

<div class="sub">
4H Kırılım · 2H Onay · Retest · 15M RSI · 5M RSI · Hacim
</div>

</div>

<div class="online">
● SÜREKLİ AKTİF
</div>

</div>


<div class="market">

<div class="marketLabel">
GENEL PİYASA DURUMU
</div>

<div
  id="md"
  class="marketDir"
>
VERİ BEKLENİYOR
</div>

<div
  id="mr"
  class="muted"
>
Piyasa hesaplanıyor...
</div>

</div>


<div class="stats">

<div class="stat">

<div class="label">
PİYASA
</div>

<div
  id="mc"
  class="value"
>
-
</div>

</div>


<div class="stat">

<div class="label">
ANALİZ
</div>

<div
  id="an"
  class="value"
>
-
</div>

</div>


<div class="stat">

<div class="label">
AKTİF SİNYAL
</div>

<div
  id="sc"
  class="value"
>
0
</div>

</div>


<div class="stat">

<div class="label">
SON TARAMA
</div>

<div
  id="ls"
  class="value"
>
-
</div>

</div>

</div>


<div class="panel">

<h2>
🚨 AKTİF SİNYALLER
</h2>

<div class="muted">
Yalnızca gerçek giriş bölgesinde bulunan sinyaller gösterilir.
Giriş fırsatı sona erdiğinde sinyal otomatik olarak ekrandan kaldırılır.
</div>

<div id="signals">

<div class="empty">
Tarama yapılıyor...
</div>

</div>

</div>


<div class="panel">

<h2>
📊 GERÇEK PERFORMANS · SON 50
</h2>

<div class="muted">
Yalnızca gerçekten girişe dönüşen işlemler hesaplanır.
Kaçan sinyaller performansa dahil edilmez.
</div>


<div class="performance">

<div class="perfBox">

<span>
TP1 BAŞARI
</span>

<strong id="tp1">
0%
</strong>

</div>


<div class="perfBox">

<span>
STOP
</span>

<strong id="stop">
0%
</strong>

</div>


<div class="perfBox">

<span>
TOPLAM R
</span>

<strong id="r">
0R
</strong>

</div>


<div class="perfBox">

<span>
ÇÖZÜLEN
</span>

<strong id="resolved">
0
</strong>

</div>

</div>


<div
  id="history"
  style="margin-top:15px"
>
</div>

</div>


<div class="panel">

<h2>
🧠 SONNY KARAR SİSTEMİ
</h2>

<div class="muted">

1. 4H destek / direnç seviyesi bulunur.<br><br>

2. Son kapanmış mumlarda gerçek kırılım aranır.<br><br>

3. 2H aynı yönde kırılım veya yapı onayı kontrol edilir.<br><br>

4. Kırılan seviye retest edilir.<br><br>

5. 15M RSI giriş zamanını kontrol eder.<br><br>

6. 5M RSI kısa vadeli momentumu destekler.<br><br>

7. Hacim ve Bollinger genişliği kalite puanına katkı sağlar.<br><br>

8. Sinyal oluştuktan sonra fiyat canlı takip edilir.<br><br>

9. Giriş bölgesinden çıkan fırsat ekrandan kaldırılır.<br><br>

10. Gerçek giriş sonrası TP1 / TP2 / TP3 / STOP takip edilir.

</div>

</div>


<div
  id="status"
  class="status"
>
Sistem başlatılıyor...
</div>

</div>


<script>

function price(v){

  v=Number(v);

  if(
    !Number.isFinite(v)
  ){
    return "-";
  }

  if(v>=100){
    return v.toFixed(2);
  }

  if(v>=1){
    return v.toFixed(4);
  }

  if(v>=0.01){
    return v.toFixed(6);
  }

  return v.toFixed(8);
}


function tv(symbol){

  const url =
    "https://www.tradingview.com/symbols/" +
    encodeURIComponent(symbol) +
    "/?exchange=BITGET";

  window.open(
    url,
    "_blank"
  );
}


function render(d){

  if(
    d.market
  ){

    const md =
      document.getElementById("md");


    md.textContent =
      d.market.label;


    md.className =
      "marketDir " +
      (
        d.market.direction === "LONG"
          ? "long"
          : d.market.direction === "SHORT"
            ? "short"
            : ""
      );


    document.getElementById("mr")
      .textContent =
      d.market.reason;
  }


  if(
    d.stats
  ){

    document.getElementById("mc")
      .textContent =
      d.stats.market;


    document.getElementById("an")
      .textContent =
      d.stats.analyzed;


    document.getElementById("sc")
      .textContent =
      d.stats.signals;
  }


  if(
    d.timestamp
  ){

    document.getElementById("ls")
      .textContent =
      new Date(
        d.timestamp
      ).toLocaleTimeString(
        "tr-TR"
      );
  }


  const box =
    document.getElementById(
      "signals"
    );


  if(
    !d.signals ||
    !d.signals.length
  ){

    box.innerHTML =
      '<div class="empty">' +
      'Şu anda aktif giriş sinyali yok. ' +
      'Sistem piyasayı tarıyor.' +
      '</div>';

  } else {

    box.innerHTML =
      d.signals
        .map(
          function(x){

            const directionClass =
              x.direction === "LONG"
                ? "long"
                : "short";


            return (

              '<div class="signal">' +

              '<div class="top">' +

              '<div class="coin ' +
              directionClass +
              '">' +

              x.symbol +
              ' · ' +
              x.direction +

              '</div>' +

              '<div class="score">' +
              'GÜÇ ' +
              x.score +
              '/100' +
              '</div>' +

              '</div>' +


              '<div class="muted" style="margin-top:7px">' +

              'Canlı fiyat: <b>' +
              price(x.currentPrice || x.price) +
              '</b> · ' +

              '15M RSI: <b>' +
              x.rsi +
              '</b> · ' +

              '5M RSI: <b>' +
              (
                x.rsi5 !== undefined
                  ? x.rsi5
                  : "-"
              ) +
              '</b> · ' +

              'Hacim: <b>' +
              (
                x.volumeRatio !== undefined
                  ? x.volumeRatio + "x"
                  : "-"
              ) +
              '</b>' +

              '</div>' +


              '<div class="plan">' +

              '<div class="box">' +
              '<b>GİRİŞ</b>' +
              price(x.entryLow) +
              ' - ' +
              price(x.entryHigh) +
              '</div>' +

              '<div class="box">' +
              '<b>STOP</b>' +
              price(x.stop) +
              '</div>' +

              '<div class="box">' +
              '<b>TP1</b>' +
              price(x.tp1) +
              '</div>' +

              '<div class="box">' +
              '<b>TP2</b>' +
              price(x.tp2) +
              '</div>' +

              '<div class="box">' +
              '<b>TP3</b>' +
              price(x.tp3) +
              '</div>' +

              '</div>' +


              '<div class="reason">' +

              '<b>Neden?</b> ' +
              x.reason +

              '<br><br>' +

              '<span>' +
              'Durum: ' +
              (
                x.enteredAt
                  ? "GİRİŞ AKTİF"
                  : "GİRİŞ BEKLENİYOR"
              ) +
              '</span>' +

              '</div>' +


              '<a ' +
              'class="tv" ' +
              'target="_blank" ' +
              'href="' +
              x.tradingView +
              '">' +

              '📊 TRADINGVIEW AÇ' +

              '</a>' +

              '</div>'
            );
          }
        )
        .join("");
  }


  /*
  PERFORMANCE
  */

  if(
    d.performance
  ){

    document.getElementById("tp1")
      .textContent =
      d.performance.tp1Rate +
      "%";


    document.getElementById("stop")
      .textContent =
      d.performance.stopRate +
      "%";


    document.getElementById("r")
      .textContent =
      d.performance.totalR +
      "R";


    document.getElementById("resolved")
      .textContent =
      d.performance.resolved;


    const history =
      document.getElementById(
        "history"
      );


    if(
      !d.performance.history ||
      !d.performance.history.length
    ){

      history.innerHTML =
        '<div class="empty">' +
        'Henüz gerçekleşmiş işlem yok.' +
        '</div>';

    } else {

      history.innerHTML =
        d.performance.history
          .map(
            function(x){

              return (

                '<div style="' +
                'padding:10px 0;' +
                'border-bottom:1px solid #202b3b;' +
                'font-size:12px">' +

                '<b>' +
                x.symbol +
                '</b> · ' +

                x.direction +
                ' · ' +

                '<b>' +
                x.result +
                '</b> · ' +

                'R: ' +
                x.r +

                '</div>'
              );
            }
          )
          .join("");
    }
  }
}


async function load(){

  try {

    document.getElementById(
      "status"
    ).textContent =
      "Yeni piyasa verileri kontrol ediliyor...";


    const response =
      await fetch(
        "/api/result?_=" +
        Date.now(),
        {
          cache:
            "no-store"
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


      document.getElementById(
        "status"
      ).textContent =
        "Sistem aktif · canlı fiyatlar güncelleniyor.";

    } else {

      document.getElementById(
        "status"
      ).textContent =
        "İlk tarama yapılıyor...";

    }


  } catch(error){

    document.getElementById(
      "status"
    ).textContent =
      "Bağlantı hatası: " +
      error.message;
  }
}


load();


setInterval(
  load,
  10000
);

</script>

</body>

</html>`;


/*
=========================================================
ROUTES
=========================================================
*/

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


/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  '/health',
  (req, res) => {

    res.json({

      success:
        true,

      status:
        'healthy',

      system:
        'Sonny AI Signal Scanner V6.3'
    });
  }
);


/*
=========================================================
STATUS
=========================================================
*/

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

      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + RSI',

      refresh:
        '60 SECONDS',

      lastScan,

      market:
        market.length,

      activeSignals:
        activeSignals.size,

      performance:
        performanceHistory.length,

      error:
        lastError
    });
  }
);


/*
=========================================================
MANUAL SCAN
=========================================================
*/

app.get(
  '/api/scan',
  async (req, res) => {

    res.json(
      await runRadar()
    );
  }
);


/*
=========================================================
RESULT
=========================================================
*/

app.get(
  '/api/result',
  async (req, res) => {

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );


    /*
    İlk tarama.
    */

    if (
      !resultCache &&
      !scanning
    ) {

      runRadar()
        .catch(
          error =>
            log(
              'İlk tarama hatası: ' +
              error.message
            )
        );
    }


    /*
    Henüz sonuç yok.
    */

    if (
      !resultCache
    ) {

      return res.json({

        success:
          true,

        scanning:
          true,

        result:
          null
      });
    }


    /*
    Her sayfa isteğinde
    aktif sinyallerin fiyatlarını
    güncelle.
    */

    try {

      await updateLiveSignals();


      if (resultCache) {

        resultCache.signals =
          Array.from(
            activeSignals.values()
          )
          .sort(
            (a, b) =>
              b.score -
              a.score
          )
          .slice(
            0,
            CFG.MAX_SIGNALS
          );


        resultCache.stats.signals =
          resultCache.signals.length;


        resultCache.performance =
          performanceStats();
      }


    } catch(error){

      log(
        'Canlı sonuç güncelleme hatası: ' +
        error.message
      );
    }


    res.json({

      success:
        true,

      scanning,

      result:
        resultCache
    });
  }
);


/*
=========================================================
404
=========================================================
*/

app.use(
  (req, res) => {

    res.status(404).json({

      success:
        false,

      error:
        'Endpoint not found'
    });
  }
);


/*
=========================================================
SERVER
=========================================================
*/

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    log(
      'Sonny AI Signal Scanner V6.3 started'
    );


    log(
      'Data source: BITGET'
    );


    log(
      'Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME'
    );


    log(
      'Universe limit: ' +
      CFG.MARKET_LIMIT
    );


    log(
      'Fast radar: ' +
      CFG.FAST_RADAR
    );


    log(
      'Deep analysis: ' +
      CFG.ANALYZE_LIMIT
    );


    log(
      'Refresh: Every 60 seconds'
    );


    log(
      'Server listening on port ' +
      PORT
    );


    log(
      'Signal history: ' +
      performanceHistory.length +
      ' kayıt'
    );


    /*
    İlk tarama.
    */

    setTimeout(
      () => {

        runRadar();

      },
      3000
    );


    /*
    Her dakika yeni tarama.
    */

    setInterval(
      () => {

        runRadar();

      },
      CFG.REFRESH_MS
    );

  }
);
