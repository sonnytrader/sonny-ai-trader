const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE = 'https://api.bitget.com';
const PRODUCT = 'usdt-futures';
const HISTORY_FILE = path.join(__dirname, 'signal_history.json');

const CFG = {
  REFRESH_MS: 60000,

  // Bitget'teki uygun perpetual coinlerin tamamını keşfet.
  MARKET_LIMIT: 500,

  // Her dakika detaylı OHLCV analizi yapılacak üst grup.
  ANALYZE_LIMIT: 120,

  MIN_VOLUME: 1000000,

  LOOKBACK_4H: 30,
  LOOKBACK_2H: 30,

  FOUR_H_LIMIT: 100,
  TWO_H_LIMIT: 100,
  M15_LIMIT: 150,
  M5_LIMIT: 120,

  RETEST_PERCENT: 0.80,

  RSI_PERIOD: 14,

  LONG_RSI_MIN: 48,
  LONG_RSI_MAX: 68,

  SHORT_RSI_MIN: 32,
  SHORT_RSI_MAX: 52,

  MIN_SIGNAL_SCORE: 75,

  MAX_SIGNALS: 8,
  MAX_PREPARING: 5,

  MAX_HISTORY: 50,

  BATCH: 8,
  DELAY: 100
};

let market = [];
let resultCache = null;
let scanning = false;
let lastScan = null;
let lastError = null;

let history = loadHistory();

// Radar tekrar sinyal üretmese bile burada takip edilir.
const tracked = new Map();


/* =========================================================
   GENEL
========================================================= */

function log(x) {
  console.log(
    '[' +
    new Date().toISOString() +
    '] ' +
    x
  );
}

function sleep(ms) {
  return new Promise(
    r => setTimeout(r, ms)
  );
}

function n(v, d = 6) {
  return Number.isFinite(v)
    ? Number(v.toFixed(d))
    : 0;
}

function pct(v, base) {
  return base
    ? (v / base) * 100
    : 0;
}


/* =========================================================
   PERFORMANS GEÇMİŞİ
========================================================= */

function loadHistory() {

  try {

    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          HISTORY_FILE,
          'utf8'
        )
      );

    return Array.isArray(data)
      ? data.slice(-CFG.MAX_HISTORY)
      : [];

  } catch (e) {

    log(
      'History yükleme hatası: ' +
      e.message
    );

    return [];
  }
}


function saveHistory() {

  try {

    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(
        history.slice(-CFG.MAX_HISTORY),
        null,
        2
      )
    );

  } catch (e) {

    log(
      'History kayıt hatası: ' +
      e.message
    );
  }
}


function addHistory(item) {

  history.push(item);

  history =
    history.slice(
      -CFG.MAX_HISTORY
    );

  saveHistory();
}


/* =========================================================
   BITGET API
========================================================= */

async function api(
  apiPath,
  params = {}
) {

  const url =
    new URL(
      BASE + apiPath
    );

  Object.entries(params).forEach(
    ([k, v]) => {

      if (
        v !== undefined &&
        v !== null &&
        v !== ''
      ) {

        url.searchParams.set(
          k,
          String(v)
        );
      }

    }
  );

  const r =
    await fetch(url);

  const text =
    await r.text();

  if (!r.ok) {

    throw new Error(
      'Bitget HTTP ' +
      r.status +
      ' - ' +
      text.slice(0, 200)
    );
  }

  const j =
    JSON.parse(text);

  if (
    j.code !== '00000'
  ) {

    throw new Error(
      'Bitget ' +
      j.code +
      ' - ' +
      (
        j.msg ||
        'Unknown error'
      )
    );
  }

  return j.data;
}


/* =========================================================
   CANDLE PARSER
========================================================= */

function candles(data) {

  if (
    !Array.isArray(data)
  ) {

    return [];
  }

  return data

    .map(x => ({

      time: +x[0],

      open: +x[1],

      high: +x[2],

      low: +x[3],

      close: +x[4],

      volume: +x[5]

    }))

    .filter(
      x =>
        Number.isFinite(
          x.close
        )
    )

    .sort(
      (a, b) =>
        a.time -
        b.time
    );
}


/* =========================================================
   RSI
========================================================= */

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

    if (
      change >= 0
    ) {

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
        avgGain *
        (period - 1) +
        Math.max(change, 0)
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        Math.max(-change, 0)
      ) /
      period;
  }

  if (
    avgLoss === 0
  ) {

    return 100;
  }

  return (
    100 -
    100 /
    (
      1 +
      avgGain /
      avgLoss
    )
  );
}


/* =========================================================
   BOLLINGER WIDTH
   V6.1'DE GERÇEKTEN KULLANILIYOR
========================================================= */

function bollingerWidth(
  values,
  period = 20,
  mult = 2
) {

  if (
    values.length < period
  ) {

    return null;
  }

  const a =
    values.slice(
      -period
    );

  const mean =
    a.reduce(
      (s, x) =>
        s + x,
      0
    ) /
    period;

  const variance =
    a.reduce(
      (s, x) =>
        s +
        Math.pow(
          x - mean,
          2
        ),
      0
    ) /
    period;

  const sd =
    Math.sqrt(
      variance
    );

  if (!mean) {
    return null;
  }

  return (
    (
      mult *
      sd *
      2
    ) /
    mean
  ) *
  100;
}


/* =========================================================
   MARKET DISCOVERY
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
          productType:
            PRODUCT
        }
      ),

      api(
        '/api/v2/mix/market/tickers',
        {
          productType:
            PRODUCT
        }
      )

    ]);

  const valid =
    new Set(

      (contracts || [])

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

    (tickers || [])

      .filter(
        t =>
          valid.has(
            t.symbol
          )
      )

      .map(
        t => {

          let ch =
            +t.change24h ||
            0;

          if (
            Math.abs(ch) <= 1
          ) {

            ch *= 100;
          }

          return {

            symbol:
              t.symbol,

            price:
              +t.lastPr,

            volume24h:
              +t.quoteVolume ||
              0,

            change24h:
              ch
          };

        }
      )

      .filter(
        x =>
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
    'Discovery tamamlandı. ' +
    market.length +
    ' uygun coin bulundu.'
  );
}


/* =========================================================
   CANDLES
========================================================= */

async function getCandles(
  symbol,
  tf,
  limit
) {

  return candles(

    await api(
      '/api/v2/mix/market/candles',
      {

        symbol,

        productType:
          PRODUCT,

        granularity:
          tf,

        limit

      }
    )

  );
}


/* =========================================================
   4H / 2H BREAKOUT
========================================================= */

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

  const closed =
    c.slice(0, -1);

  const recent =
    Math.min(
      8,
      closed.length -
      lookback
    );

  let longBreak =
    false;

  let shortBreak =
    false;

  let longLevel =
    null;

  let shortLevel =
    null;

  for (
    let i =
      closed.length -
      recent;

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
          x =>
            x.high
        )
      );

    const support =
      Math.min(
        ...history.map(
          x =>
            x.low
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

      longBreak =
        true;

      longLevel =
        resistance;
    }

    if (
      current.close <
        support &&

      previous.close >=
        support
    ) {

      shortBreak =
        true;

      shortLevel =
        support;
    }
  }

  const last =
    closed.slice(
      -lookback
    );

  return {

    current:
      closed.at(-1),

    resistance:
      longLevel ||
      Math.max(
        ...last.map(
          x =>
            x.high
        )
      ),

    support:
      shortLevel ||
      Math.min(
        ...last.map(
          x =>
            x.low
        )
      ),

    longBreak,

    shortBreak,

    longLevel,

    shortLevel
  };
}


/* =========================================================
   RETEST
========================================================= */

function near(
  price,
  level
) {

  return (
    Math.abs(
      pct(
        price -
          level,
        level
      )
    ) <=
    CFG.RETEST_PERCENT
  );
}


/* =========================================================
   PUANLAMA
========================================================= */

function score({
  b4,
  b2,
  retest,
  rsiOk,
  rv,
  dir,
  volumeRatio,
  bbWidth,
  m5Rsi,
  marketDir
}) {

  let s = 0;

  if (b4) {
    s += 35;
  }

  if (b2) {

    s += 25;

  } else if (b4) {

    s += 10;
  }

  if (retest) {
    s += 20;
  }

  if (rsiOk) {
    s += 10;
  }

  if (
    dir === 'LONG' &&
    rv >= 52 &&
    rv <= 63
  ) {

    s += 5;
  }

  if (
    dir === 'SHORT' &&
    rv >= 37 &&
    rv <= 48
  ) {

    s += 5;
  }

  // Hacim artık gerçekten puana dahil.
  if (
    volumeRatio >= 1.15
  ) {

    s += 5;
  }

  // Bollinger squeeze bonusu.
  if (
    bbWidth !== null &&
    bbWidth < 8
  ) {

    s += 3;
  }

  // 5M RSI artık gerçekten puana dahil.
  if (
    dir === 'LONG' &&
    m5Rsi >= 48 &&
    m5Rsi <= 70
  ) {

    s += 3;
  }

  if (
    dir === 'SHORT' &&
    m5Rsi >= 30 &&
    m5Rsi <= 52
  ) {

    s += 3;
  }

  // Genel piyasa yönü ile aynıysa küçük bonus.
  if (
    marketDir === dir
  ) {

    s += 4;
  }

  return Math.min(
    100,
    s
  );
}


/* =========================================================
   İŞLEM PLANI
========================================================= */

function plan(
  m,
  dir,
  level,
  rv,
  sc,
  reason,
  volumeRatio,
  bbWidth
) {

  let entryLow;
  let entryHigh;

  if (
    dir === 'LONG'
  ) {

    entryLow =
      level *
      0.998;

    entryHigh =
      level *
      1.004;

  } else {

    // SHORT için artık düşük/yüksek doğru sırada.
    entryLow =
      level *
      0.996;

    entryHigh =
      level *
      1.002;
  }

  const stop =
    dir === 'LONG'
      ? level * 0.982
      : level * 1.018;

  const risk =
    Math.abs(
      level -
      stop
    );

  const tp1 =
    dir === 'LONG'
      ? level +
        risk * 1.5
      : level -
        risk * 1.5;

  const tp2 =
    dir === 'LONG'
      ? level +
        risk * 2
      : level -
        risk * 2;

  const tp3 =
    dir === 'LONG'
      ? level +
        risk * 3
      : level -
        risk * 3;

  return {

    id:
      m.symbol +
      '-' +
      dir +
      '-' +
      Math.round(
        level * 1e8
      ),

    symbol:
      m.symbol,

    direction:
      dir,

    strategy:
      '4H Kırılım + 2H Onay + Retest + 15M RSI + 5M RSI + Hacim',

    score:
      sc,

    price:
      n(
        m.price,
        8
      ),

    entryLow:
      n(
        entryLow,
        8
      ),

    entryHigh:
      n(
        entryHigh,
        8
      ),

    stop:
      n(
        stop,
        8
      ),

    tp1:
      n(
        tp1,
        8
      ),

    tp2:
      n(
        tp2,
        8
      ),

    tp3:
      n(
        tp3,
        8
      ),

    rsi:
      n(
        rv,
        1
      ),

    level:
      n(
        level,
        8
      ),

    volumeRatio:
      n(
        volumeRatio,
        2
      ),

    bbWidth:
      n(
        bbWidth,
        2
      ),

    change24h:
      n(
        m.change24h,
        2
      ),

    reason,

    // TradingView sembol sayfası.
    tradingView:
      'https://www.tradingview.com/symbols/' +
      encodeURIComponent(
        m.symbol
      ) +
      '/?exchange=BITGET',

    createdAt:
      new Date().toISOString()
  };
}


/* =========================================================
   GERÇEK SİNYAL
========================================================= */

function makeSignal(
  m,
  h4,
  h2,
  m15,
  m5,
  marketDir
) {

  const rv =
    rsi(
      m15
        .slice(0, -1)
        .map(
          x =>
            x.close
        ),
      CFG.RSI_PERIOD
    );

  const m5Rsi =
    rsi(
      m5
        .slice(0, -1)
        .map(
          x =>
            x.close
        ),
      CFG.RSI_PERIOD
    );

  if (
    rv === null ||
    m5Rsi === null
  ) {

    return null;
  }

  const price =
    m.price;

  const h2Price =
    h2.current.close;

  const closes15 =
    m15
      .slice(0, -1)
      .map(
        x =>
          x.close
      );

  // Artık gerçekten hesaplanıyor.
  const bbWidth =
    bollingerWidth(
      closes15
    );

  const volBase =
    m15
      .slice(-21, -1)
      .reduce(
        (s, x) =>
          s + x.volume,
        0
      ) / 20;

  const volumeRatio =
    volBase > 0
      ? m15.at(-1).volume /
        volBase
      : 0;


  /* LONG */

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
        h4.resistance *
        0.997;

    const h2ok =
      h2.longBreak ||
      h2Price >=
        h2.resistance *
        0.997;

    const rsiOk =
      rv >=
        CFG.LONG_RSI_MIN &&
      rv <=
        CFG.LONG_RSI_MAX;

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
        score({

          b4:
            h4.longBreak,

          b2:
            h2.longBreak,

          retest,

          rsiOk,

          rv,

          dir:
            'LONG',

          volumeRatio,

          bbWidth,

          m5Rsi,

          marketDir

        });

      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        return plan(

          m,

          'LONG',

          level,

          rv,

          sc,

          '4H kırılımı + 2H onayı + retest + 15M RSI LONG giriş bölgesi.',

          volumeRatio,

          bbWidth

        );
      }
    }
  }


  /* SHORT */

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
        h4.support *
        1.003;

    const h2ok =
      h2.shortBreak ||
      h2Price <=
        h2.support *
        1.003;

    const rsiOk =
      rv >=
        CFG.SHORT_RSI_MIN &&
      rv <=
        CFG.SHORT_RSI_MAX;

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
        score({

          b4:
            h4.shortBreak,

          b2:
            h2.shortBreak,

          retest,

          rsiOk,

          rv,

          dir:
            'SHORT',

          volumeRatio,

          bbWidth,

          m5Rsi,

          marketDir

        });

      if (
        sc >=
        CFG.MIN_SIGNAL_SCORE
      ) {

        return plan(

          m,

          'SHORT',

          level,

          rv,

          sc,

          '4H kırılımı + 2H onayı + retest + 15M RSI SHORT giriş bölgesi.',

          volumeRatio,

          bbWidth

        );
      }
    }
  }

  return null;
}


/* =========================================================
   HAZIRLANAN FIRSATLAR
========================================================= */

function preparing(
  m,
  h4,
  h2,
  m15
) {

  const rv =
    rsi(
      m15
        .slice(0, -1)
        .map(
          x =>
            x.close
        ),
      CFG.RSI_PERIOD
    );

  if (
    rv === null
  ) {

    return null;
  }

  const price =
    m.price;

  const longDistance =
    pct(
      h4.resistance -
        price,
      price
    );

  const shortDistance =
    pct(
      price -
        h4.support,
      price
    );


  if (
    longDistance >= 0 &&
    longDistance <= 1 &&

    pct(
      h2.resistance -
        price,
      price
    ) <= 1.5 &&

    rv >= 45 &&
    rv <= 70
  ) {

    return {

      symbol:
        m.symbol,

      direction:
        'LONG',

      price:
        n(
          price,
          8
        ),

      trigger:
        n(
          h4.resistance,
          8
        ),

      distance:
        n(
          longDistance,
          3
        ),

      rsi:
        n(
          rv,
          1
        ),

      tradingView:
        'https://www.tradingview.com/symbols/' +
        encodeURIComponent(
          m.symbol
        ) +
        '/?exchange=BITGET'

    };
  }


  if (
    shortDistance >= 0 &&
    shortDistance <= 1 &&

    pct(
      price -
        h2.support,
      price
    ) <= 1.5 &&

    rv >= 30 &&
    rv <= 55
  ) {

    return {

      symbol:
        m.symbol,

      direction:
        'SHORT',

      price:
        n(
          price,
          8
        ),

      trigger:
        n(
          h4.support,
          8
        ),

      distance:
        n(
          shortDistance,
          3
        ),

      rsi:
        n(
          rv,
          1
        ),

      tradingView:
        'https://www.tradingview.com/symbols/' +
        encodeURIComponent(
          m.symbol
        ) +
        '/?exchange=BITGET'

    };
  }

  return null;
}


/* =========================================================
   COIN ANALİZİ
========================================================= */

async function analyze(
  m,
  marketDir
) {

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

    if (
      !h4 ||
      !h2 ||
      c15.length < 50 ||
      c5.length < 30
    ) {

      return null;
    }

    const signal =
      makeSignal(
        m,
        h4,
        h2,
        c15,
        c5,
        marketDir
      );

    if (
      signal
    ) {

      return {

        type:
          'SIGNAL',

        data:
          signal

      };
    }

    const p =
      preparing(
        m,
        h4,
        h2,
        c15
      );

    if (
      p
    ) {

      return {

        type:
          'PREPARING',

        data:
          p

      };
    }

    return null;

  } catch (e) {

    log(
      'Analiz hatası ' +
      m.symbol +
      ': ' +
      e.message
    );

    return null;
  }
}


/* =========================================================
   GENEL PİYASA
========================================================= */

function marketDirection() {

  const btc =
    market.find(
      x =>
        x.symbol ===
        'BTCUSDT'
    );

  const eth =
    market.find(
      x =>
        x.symbol ===
        'ETHUSDT'
    );

  const list =
    [
      btc,
      eth
    ].filter(Boolean);

  if (
    !list.length
  ) {

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

  if (
    up > down
  ) {

    return {

      direction:
        'LONG',

      label:
        'PİYASA YUKARI',

      reason:
        'BTC / ETH yükseliş ağırlıklı.'

    };
  }

  if (
    down > up
  ) {

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


/* =========================================================
   CANLI FİYATLAR
========================================================= */

async function livePrices() {

  const tickers =
    await api(
      '/api/v2/mix/market/tickers',
      {
        productType:
          PRODUCT
      }
    );

  return new Map(

    (
      Array.isArray(tickers)
        ? tickers
        : []
    ).map(
      x => [
        x.symbol,
        +x.lastPr
      ]
    )

  );
}


/* =========================================================
   SİNYAL TAKİP MOTORU
========================================================= */

function registerSignals(
  signals
) {

  for (
    const s of signals
  ) {

    if (
      !tracked.has(
        s.id
      )
    ) {

      tracked.set(
        s.id,
        {

          ...s,

          status:
            'ACTIVE',

          lastUpdate:
            Date.now()

        }
      );
    }
  }
}


/*
LONG:

Fiyat TP1'e ulaşırsa TP1.
STOP'a ulaşırsa STOP.
Giriş üstünü geçerse KAÇTI.

SHORT:

Fiyat TP1'e ulaşırsa TP1.
STOP'a ulaşırsa STOP.
Giriş altını geçerse KAÇTI.
*/

function refreshTrackedPrices(
  prices
) {

  for (
    const [
      id,
      t
    ]
    of tracked
  ) {

    const p =
      prices.get(
        t.symbol
      );

    if (
      !Number.isFinite(p)
    ) {

      continue;
    }

    t.price =
      p;

    const long =
      t.direction ===
      'LONG';

    const hitStop =
      long
        ? p <= t.stop
        : p >= t.stop;

    const hitTp1 =
      long
        ? p >= t.tp1
        : p <= t.tp1;

    const missed =
      long
        ? p > t.entryHigh
        : p < t.entryLow;


    /*
    Önce STOP kontrolü.
    */

    if (
      hitStop
    ) {

      addHistory({

        ...t,

        status:
          'STOP',

        resolvedAt:
          new Date().toISOString(),

        exitPrice:
          p,

        r:
          -1

      });

      tracked.delete(
        id
      );

      continue;
    }


    /*
    TP1.
    */

    if (
      hitTp1
    ) {

      addHistory({

        ...t,

        status:
          'TP1',

        resolvedAt:
          new Date().toISOString(),

        exitPrice:
          p,

        r:
          1.5

      });

      tracked.delete(
        id
      );

      continue;
    }


    /*
    Giriş fırsatı kaçtı.
    */

    if (
      missed
    ) {

      addHistory({

        ...t,

        status:
          'MISSED',

        resolvedAt:
          new Date().toISOString(),

        exitPrice:
          p,

        r:
          0

      });

      tracked.delete(
        id
      );

      continue;
    }

    t.lastUpdate =
      Date.now();
  }
}


/* =========================================================
   PERFORMANS
========================================================= */

function performance() {

  const resolved =
    history.filter(
      x =>
        x.status ===
          'TP1' ||
        x.status ===
          'STOP'
    );

  const tp =
    resolved.filter(
      x =>
        x.status ===
        'TP1'
    ).length;

  const stop =
    resolved.filter(
      x =>
        x.status ===
        'STOP'
    ).length;

  const missed =
    history.filter(
      x =>
        x.status ===
        'MISSED'
    ).length;

  const totalR =
    resolved.reduce(
      (s, x) =>
        s +
        (+x.r || 0),
      0
    );

  return {

    sample:
      history.slice(
        -CFG.MAX_HISTORY
      ),

    tp1Rate:
      resolved.length
        ? n(
            tp /
            resolved.length *
            100,
            1
          )
        : 0,

    stopRate:
      resolved.length
        ? n(
            stop /
            resolved.length *
            100,
            1
          )
        : 0,

    totalR:
      n(
        totalR,
        2
      ),

    resolved:
      resolved.length,

    missed
  };
}


/* =========================================================
   ANA RADAR
========================================================= */

async function runRadar() {

  if (
    scanning
  ) {

    return resultCache;
  }

  scanning =
    true;

  lastError =
    null;

  const started =
    Date.now();

  try {

    await discover();

    const md =
      marketDirection();

    /*
    Önce yüksek hacimli üst grup.
    */

    const candidates =
      market.slice(
        0,
        CFG.ANALYZE_LIMIT
      );

    const signals = [];
    const prep = [];


    for (
      let i = 0;
      i < candidates.length;
      i += CFG.BATCH
    ) {

      const batch =
        candidates.slice(
          i,
          i +
          CFG.BATCH
        );

      const rows =
        await Promise.all(
          batch.map(
            m =>
              analyze(
                m,
                md.direction
              )
          )
        );

      rows.forEach(
        r => {

          if (!r) {
            return;
          }

          if (
            r.type ===
            'SIGNAL'
          ) {

            signals.push(
              r.data
            );

          } else if (
            r.type ===
            'PREPARING'
          ) {

            prep.push(
              r.data
            );
          }
        }
      );

      await sleep(
        CFG.DELAY
      );
    }


    signals.sort(
      (a, b) =>
        b.score -
        a.score
    );

    prep.sort(
      (a, b) =>
        a.distance -
        b.distance
    );


    /*
    Yeni sinyalleri takip sistemine ekle.
    */

    registerSignals(
      signals
    );


    /*
    Canlı fiyatları al.
    */

    const prices =
      await livePrices();


    /*
    Eski sinyaller de canlı takip edilir.
    */

    refreshTrackedPrices(
      prices
    );


    /*
    Aktif sinyaller.
    */

    const active =
      [
        ...tracked.values()
      ]

      .sort(
        (a, b) =>
          b.score -
          a.score
      )

      .slice(
        0,
        CFG.MAX_SIGNALS
      );


    active.forEach(
      x => {

        const p =
          prices.get(
            x.symbol
          );

        if (
          Number.isFinite(p)
        ) {

          x.price =
            p;
        }

      }
    );


    resultCache = {

      success:
        true,

      system:
        'Sonny AI Signal Scanner V6.1',

      timestamp:
        new Date().toISOString(),

      market:
        md,

      stats: {

        market:
          market.length,

        analyzed:
          candidates.length,

        signals:
          active.length,

        preparing:
          Math.min(
            prep.length,
            CFG.MAX_PREPARING
          ),

        seconds:
          n(
            (
              Date.now() -
              started
            ) / 1000,
            1
          )
      },

      signals:
        active,

      preparing:
        prep.slice(
          0,
          CFG.MAX_PREPARING
        ),

      missed:
        history
          .filter(
            x =>
              x.status ===
              'MISSED'
          )
          .slice(
            -10
          )
          .reverse(),

      performance:
        performance(),

      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME + BB WIDTH',

      refresh:
        '60 SECONDS'
    };


    lastScan =
      resultCache.timestamp;


    log(
      'RADAR tamamlandı | ' +
      'Universe=' +
      market.length +
      ' | OHLCV=' +
      candidates.length +
      ' | SIGNAL=' +
      active.length +
      ' | MISSED=' +
      resultCache.performance.missed +
      ' | TP1%=' +
      resultCache.performance.tp1Rate
    );


    return resultCache;

  } catch (e) {

    lastError =
      e.message;

    log(
      'RADAR ERROR: ' +
      e.message
    );

    return {

      success:
        false,

      error:
        e.message
    };

  } finally {

    scanning =
      false;
  }
}


/* =========================================================
   WEB ARAYÜZÜ
========================================================= */

const HTML = `<!doctype html>
<html lang="tr">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Sonny AI Signal Scanner V6.1
</title>

<style>

*{
box-sizing:border-box
}

body{
margin:0;
background:#080b12;
color:#f5f7fb;
font-family:Arial,sans-serif
}

.wrap{
width:min(1200px,94%);
margin:25px auto 50px
}

.head{
display:flex;
justify-content:space-between;
align-items:center;
margin-bottom:18px
}

.title{
font-size:27px;
font-weight:900
}

.sub,.muted{
color:#7d8799
}

.online{
padding:9px 14px;
border-radius:20px;
background:#0d2118;
color:#43e58b;
border:1px solid #174d31;
font-weight:800
}

.market,
.stat,
.panel{
background:#111722;
border:1px solid #202b3b;
border-radius:15px;
padding:18px;
margin-bottom:15px
}

.marketLabel,
.label{
color:#748095;
font-size:11px;
font-weight:800
}

.marketDir{
font-size:28px;
font-weight:900;
margin-top:5px
}

.stats{
display:grid;
grid-template-columns:repeat(4,1fr);
gap:12px
}

.stat{
margin:0
}

.value{
font-size:21px;
font-weight:900;
margin-top:7px
}

.panel h2{
margin:0 0 6px;
font-size:19px
}

.signal{
background:#0c121d;
border:1px solid #26354a;
border-radius:13px;
padding:16px;
margin-top:12px
}

.top{
display:flex;
justify-content:space-between;
align-items:center
}

.coin{
font-size:20px;
font-weight:900
}

.long{
color:#45e58d
}

.short{
color:#ff647a
}

.score{
background:#1c2635;
padding:6px 9px;
border-radius:7px;
font-weight:900
}

.plan{
display:grid;
grid-template-columns:repeat(5,1fr);
gap:8px;
margin-top:14px
}

.box{
background:#151d2a;
border-radius:8px;
padding:9px
}

.box b{
display:block;
color:#68758a;
font-size:10px;
margin-bottom:4px
}

.reason{
margin-top:12px;
background:#121a27;
padding:10px;
border-radius:8px;
color:#a8b3c5;
font-size:12px
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
font-weight:900
}

.prep{
display:flex;
justify-content:space-between;
padding:12px;
border-bottom:1px solid #202a39
}

.prep:last-child{
border:0
}

.trigger{
text-align:right
}

.yellow{
color:#e8c55d
}

.table{
width:100%;
border-collapse:collapse;
font-size:12px
}

.table th,
.table td{
padding:9px;
border-bottom:1px solid #202a39;
text-align:left
}

.green{
color:#45e58d
}

.red{
color:#ff647a
}

.status{
margin-top:10px;
color:#7e8b9e;
font-size:12px
}

@media(max-width:800px){

.stats{
grid-template-columns:repeat(2,1fr)
}

.plan{
grid-template-columns:repeat(2,1fr)
}

.head{
display:block
}

.online{
display:inline-block;
margin-top:10px
}

}

</style>

</head>

<body>

<div class="wrap">

<div class="head">

<div>

<div class="title">
🚀 Sonny AI Signal Scanner V6.1
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
Giriş bölgesindeki sinyaller burada kalır.
Fırsat kaçarsa otomatik olarak KAÇAN bölümüne geçer.
</div>

<div id="signals">

<div
class="muted"
style="margin-top:18px"
>
Tarama yapılıyor...
</div>

</div>

</div>


<div class="panel">

<h2>
🟡 HAZIRLANAN FIRSATLAR
</h2>

<div class="muted">
En yakın 5 kırılım adayı.
Şartlar tamamlanınca aktif sinyale dönüşür.
</div>

<div id="prep">

<div
class="muted"
style="margin-top:18px"
>
Henüz fırsat yok.
</div>

</div>

</div>


<div class="panel">

<h2>
⚪ KAÇAN SİNYALLER
</h2>

<div class="muted">
Giriş bölgesini geçerek fırsatı kaçan son sinyaller.
</div>

<div id="missed">

<div
class="muted"
style="margin-top:18px"
>
Henüz kaçan sinyal yok.
</div>

</div>

</div>


<div class="panel">

<h2>
📊 GERÇEK PERFORMANS · SON 50
</h2>

<div class="stats">

<div class="stat">

<div class="label">
TP1 BAŞARI
</div>

<div
id="tp"
class="value"
>
0%
</div>

</div>


<div class="stat">

<div class="label">
STOP
</div>

<div
id="st"
class="value"
>
0%
</div>

</div>


<div class="stat">

<div class="label">
TOPLAM R
</div>

<div
id="rr"
class="value"
>
0R
</div>

</div>


<div class="stat">

<div class="label">
ÇÖZÜLEN / KAÇAN
</div>

<div
id="rs"
class="value"
>
0 / 0
</div>

</div>

</div>

<div
id="hist"
style="margin-top:15px"
>
</div>

</div>


<div class="panel">

<h2>
🧠 SONNY KARAR SİSTEMİ
</h2>

<div class="muted">

1. 4H destek/direnç bulunur.

2. 4H kapanış kırılımı aranır.

3. 2H onay aranır.

4. Kırılan seviye retest edilir.

5. 15M RSI giriş zamanını kontrol eder.

6. 5M RSI kısa vadeli momentumu kontrol eder.

7. Hacim ve Bollinger genişliği kalite puanına katkı verir.

8. Fiyat canlı takip edilir.

9. Giriş fırsatı kaçarsa sinyal aktif bölümden çıkar.

10. TP1 veya STOP gerçekleşirse performansa kaydedilir.

</div>

</div>


<div class="panel">

<div
id="status"
class="status"
>
Sistem başlatılıyor...
</div>

</div>

</div>


<script>

function price(v){

v=Number(v);

if(!Number.isFinite(v))
return '-';

if(v>=100)
return v.toFixed(2);

if(v>=1)
return v.toFixed(4);

if(v>=.01)
return v.toFixed(6);

return v.toFixed(8);

}


function esc(v){

return String(
v ?? ''
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
}[c] || c)
);

}


function render(d){

if(d.market){

const md =
document.getElementById(
'md'
);

md.textContent =
d.market.label;

md.className =
'marketDir ' +
(
d.market.direction ===
'LONG'
? 'long'
:
d.market.direction ===
'SHORT'
? 'short'
:
''
);

document.getElementById(
'mr'
).textContent =
d.market.reason;

}


if(d.stats){

document.getElementById(
'mc'
).textContent =
d.stats.market;

document.getElementById(
'an'
).textContent =
d.stats.analyzed;

document.getElementById(
'sc'
).textContent =
d.stats.signals;

}


if(d.timestamp){

document.getElementById(
'ls'
).textContent =
new Date(
d.timestamp
).toLocaleTimeString(
'tr-TR'
);

}


const s =
document.getElementById(
'signals'
);


if(
d.signals &&
d.signals.length
){

s.innerHTML =
d.signals
.map(
x =>

'<div class="signal">' +

'<div class="top">' +

'<div class="coin ' +
(
x.direction ===
'LONG'
? 'long'
: 'short'
) +
'">' +

esc(x.symbol) +
' · ' +
esc(x.direction) +

'</div>' +

'<div class="score">' +
'GÜÇ ' +
esc(x.score) +
'/100' +
'</div>' +

'</div>' +

'<div class="muted" style="margin-top:7px">' +

'Canlı fiyat: <b>' +
price(x.price) +
'</b> · ' +

'15M RSI: <b>' +
esc(x.rsi) +
'</b> · ' +

'Hacim: <b>' +
esc(x.volumeRatio) +
'x' +
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
esc(x.reason) +
'</div>' +

'<a class="tv" target="_blank" rel="noopener" href="' +
esc(x.tradingView) +
'">' +
'📊 TRADINGVIEW AÇ' +
'</a>' +

'</div>'

)
.join('');

} else {

s.innerHTML =
'<div class="muted" style="margin-top:18px">' +
'Şu anda aktif sinyal yok. Sistem yeni fırsatları arıyor.' +
'</div>';

}


const p =
document.getElementById(
'prep'
);


if(
d.preparing &&
d.preparing.length
){

p.innerHTML =
d.preparing
.map(
x =>

'<div class="prep">' +

'<div>' +

'<b class="' +
(
x.direction ===
'LONG'
? 'long'
: 'short'
) +
'">' +

esc(x.symbol) +
' · ' +
esc(x.direction) +

'</b>' +

'<div class="muted" style="margin-top:4px">' +

'Anlık: ' +
price(x.price) +

' · RSI: ' +
esc(x.rsi) +

'</div>' +

'</div>' +

'<div class="trigger">' +

'<b>Tetik: ' +
price(x.trigger) +
'</b>' +

'<div class="yellow">' +
esc(x.distance) +
'% uzakta' +
'</div>' +

'<a class="tv" style="margin-top:6px" target="_blank" rel="noopener" href="' +
esc(x.tradingView) +
'">' +

'Grafik' +

'</a>' +

'</div>' +

'</div>'

)
.join('');

} else {

p.innerHTML =
'<div class="muted" style="margin-top:18px">' +
'Şu anda hazırlanan güçlü fırsat yok.' +
'</div>';

}


const m =
document.getElementById(
'missed'
);


if(
d.missed &&
d.missed.length
){

m.innerHTML =
d.missed
.map(
x =>

'<div class="prep">' +

'<div>' +

'<b>' +
esc(x.symbol) +
' · ' +
esc(x.direction) +
'</b>' +

'<div class="muted">' +

'Giriş: ' +
price(x.entryLow) +
' - ' +
price(x.entryHigh) +

'</div>' +

'</div>' +

'<div class="trigger">' +

'<b class="yellow">' +
'KAÇTI' +
'</b>' +

'<div class="muted">' +

'Çıkış: ' +
price(x.exitPrice) +

'</div>' +

'</div>' +

'</div>'

)
.join('');

} else {

m.innerHTML =
'<div class="muted" style="margin-top:18px">' +
'Henüz kaçan sinyal yok.' +
'</div>';

}


if(
d.performance
){

document.getElementById(
'tp'
).textContent =
d.performance.tp1Rate +
'%';

document.getElementById(
'st'
).textContent =
d.performance.stopRate +
'%';

document.getElementById(
'rr'
).textContent =
d.performance.totalR +
'R';

document.getElementById(
'rs'
).textContent =
d.performance.resolved +
' / ' +
d.performance.missed;


const h =
d.performance.sample ||
[];


if(
h.length
){

document.getElementById(
'hist'
).innerHTML =

'<table class="table">' +

'<thead>' +

'<tr>' +

'<th>Coin</th>' +
'<th>Yön</th>' +
'<th>Sonuç</th>' +
'<th>Giriş</th>' +
'<th>Çıkış</th>' +
'<th>R</th>' +

'</tr>' +

'</thead>' +

'<tbody>' +

h
.slice()
.reverse()
.map(
x =>

'<tr>' +

'<td>' +
esc(x.symbol) +
'</td>' +

'<td>' +
esc(x.direction) +
'</td>' +

'<td class="' +

(
x.status ===
'TP1'
? 'green'
:
x.status ===
'STOP'
? 'red'
:
'yellow'
) +

'">' +

esc(x.status) +

'</td>' +

'<td>' +
price(x.price) +
'</td>' +

'<td>' +
price(x.exitPrice) +
'</td>' +

'<td>' +
esc(x.r) +
'</td>' +

'</tr>'

)
.join('') +

'</tbody>' +

'</table>';

} else {

document.getElementById(
'hist'
).innerHTML =

'<div class="muted">' +
'Henüz çözülen sinyal yok.' +
'</div>';

}

}

}


async function load(){

try{

document.getElementById(
'status'
).textContent =
'Yeni piyasa verileri kontrol ediliyor...';


const r =
await fetch(
'/api/result?_=' +
Date.now(),
{
cache:
'no-store'
}
);


const d =
await r.json();


if(
d.result
){

render(
d.result
);

document.getElementById(
'status'
).textContent =
'Sistem aktif · her dakika yeni tarama · fiyatlar canlı güncelleniyor.';

} else {

document.getElementById(
'status'
).textContent =
'İlk tarama yapılıyor...';

}

} catch(e){

document.getElementById(
'status'
).textContent =
'Bağlantı hatası: ' +
e.message;

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
        'Sonny AI Signal Scanner V6.1'

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

      strategy:
        '4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME + BB WIDTH',

      refresh:
        '60 SECONDS',

      lastScan,

      market:
        market.length,

      error:
        lastError

    });

  }
);


app.get(
  '/api/scan',
  async (req, res) => {

    res.json(
      await runRadar()
    );

  }
);


app.get(
  '/api/result',
  async (req, res) => {

    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );


    if (
      !resultCache &&
      !scanning
    ) {

      runRadar().catch(
        e =>
          log(
            'İlk tarama hatası: ' +
            e.message
          )
      );

    }


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
    Sayfa yenilenmeden de canlı fiyat.
    */

    try {

      const prices =
        await livePrices();

      refreshTrackedPrices(
        prices
      );

    } catch (e) {

      log(
        'Canlı fiyat hatası: ' +
        e.message
      );
    }


    resultCache.signals =
      [
        ...tracked.values()
      ]

      .sort(
        (a, b) =>
          b.score -
          a.score
      )

      .slice(
        0,
        CFG.MAX_SIGNALS
      );


    resultCache.performance =
      performance();


    resultCache.missed =
      history

        .filter(
          x =>
            x.status ===
            'MISSED'
        )

        .slice(
          -10
        )

        .reverse();


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

    res.status(
      404
    ).json({

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
      'Sonny AI Signal Scanner V6.1 started'
    );

    log(
      'Data source: BITGET'
    );

    log(
      'Strategy: 4H BREAKOUT + 2H CONFIRMATION + RETEST + 15M RSI + 5M RSI + VOLUME + BB WIDTH'
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
      history.length +
      ' kayıt'
    );


    /*
    İlk tarama otomatik.
    */

    setTimeout(
      () => {

        runRadar().catch(
          e =>
            log(
              'İlk radar hatası: ' +
              e.message
            )
        );

      },
      3000
    );


    /*
    Her dakika otomatik radar.
    */

    setInterval(
      () => {

        runRadar().catch(
          e =>
            log(
              'Radar hatası: ' +
              e.message
            )
        );

      },
      CFG.REFRESH_MS
    );

  }
);
